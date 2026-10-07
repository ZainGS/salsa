/**
 * P16 streaming hitches (performance-plan.md §P16): the sliced / deferred paths against the one-shot paths, end to end
 * on the REAL Renderer3D over a recording device (writeBuffer / copyBufferToBuffer move bytes into modelled buffers,
 * the main pass records its draws). Checked every frame:
 *  - every drawn instance slot holds THAT object's current data (no stale / orphan slot is ever drawn: the hold rule);
 *  - once the sliced work has caught up, the frame draws exactly what the one-shot path draws;
 *  - deferred eviction ends in the same pool / slot state as the eager one, and a re-attach mid-queue is exact.
 * No wall-clock assertions.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import { STREAM_HITCH, STREAM_HITCH_LIMITS, streamHitchStats } from './stream-hitch';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const FPI = 60;   // floats per instance slot (renderer-3d.ts MESH_INSTANCE_STRIDE / 4)

type Draw = { slot: number; indexCount: number; firstIndex: number };

function recordingDevice() {
  const mem = new Map<object, Uint8Array>();
  const writes: number[] = [];
  const handler: ProxyHandler<() => unknown> = {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'size') return 1 << 30;
      if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
      return stub;
    },
    apply() { return stub; },
  };
  const stub: unknown = new Proxy(function () { /* stub */ }, handler);
  const encoder = new Proxy({}, { get: (_t, k) => {
    if (k === 'copyBufferToBuffer') return (src: object, so: number, dst: object, dof: number, n: number) => { const a = mem.get(src), b = mem.get(dst); if (a && b) b.set(a.subarray(so, so + n), dof); };
    if (k === 'clearBuffer') return (b: object) => { mem.get(b)?.fill(0); };
    if (k === 'finish') return () => stub;
    return stub;
  } });
  const queue = new Proxy({}, { get: (_t, k) => {
    if (k === 'writeBuffer') return (buf: object, off: number, data: ArrayBuffer | ArrayBufferView, dataOff = 0, size?: number) => {
      const isAB = data instanceof ArrayBuffer;
      const bpe = isAB ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
      const src = isAB ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const o = dataOff * bpe, n = size !== undefined ? size * bpe : src.byteLength - o;
      const m = mem.get(buf); if (m) m.set(src.subarray(o, o + n), off);
      writes.push(n);
    };
    if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
    return stub;
  } });
  const device = new Proxy({}, { get: (_t, k) => {
    if (k === 'queue') return queue;
    if (k === 'features') return { has: () => false };
    if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
    if (k === 'createBuffer') return (d: { size: number }) => { const b = { size: d.size, destroy() { /* */ }, label: '', mapAsync: () => new Promise(() => { /* */ }) }; mem.set(b, new Uint8Array(d.size)); return b; };
    if (k === 'createCommandEncoder') return () => encoder;
    if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
    return stub;
  } });
  return { device: device as unknown as GPUDevice, mem, writes };
}
function recordingPass() {
  const draws: Draw[] = [];
  const pass = new Proxy({}, { get: (_t, k) => {
    if (k === 'drawIndexed') return (indexCount: number, instanceCount: number, firstIndex: number, _bv: number, firstInstance: number) => { for (let i = 0; i < instanceCount; i++) draws.push({ slot: firstInstance + i, indexCount, firstIndex }); };
    return () => { /* state */ };
  } });
  return { pass: pass as unknown as GPURenderPassEncoder, draws };
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});
const saved = { ...STREAM_HITCH }, savedL = { ...STREAM_HITCH_LIMITS };
afterEach(() => { Object.assign(STREAM_HITCH, saved); Object.assign(STREAM_HITCH_LIMITS, savedL); });

function rng(seed: number): () => number { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }

/** A small streamed "world": tiles of boxes + explicit array groups (each its own source), all in front of the camera. */
async function world(seed = 3) {
  const { Renderer3D } = await import('./renderer-3d');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const { ArrayGroup3D } = await import('../../scene-graph/shapes/array-group-3d');
  const dev = recordingDevice();
  const cam = new Camera3D();
  cam.setPosition(0, 30, -80); cam.setTarget(0, 0, 40);
  const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
  const R = rng(seed);
  type M = InstanceType<typeof Mesh3D>;
  type G = InstanceType<typeof ArrayGroup3D>;
  const box = (x: number, z: number, s: number, name: string, key?: string): M => {
    const v: number[] = [], ix = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4];
    for (const p of [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]) v.push(p[0], p[1], p[2], 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const m = new Mesh3D(isvc, x, 0, z, { primitive: 'custom', geometry: { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' } });
    m.name = name; m.setGeometryKeyOverride(key ?? 'k-' + name);
    return m;
  };
  const tile = (t: number) => {
    const meshes: M[] = [], groups: G[] = [];
    for (let i = 0; i < 30; i++) meshes.push(box(R() * 80 - 40, t * 10 + R() * 8, 0.5 + R() * 2, `t${t}m${i}`, i % 3 === 0 ? 'shared' + (i % 4) : undefined));
    for (let gi = 0; gi < 6; gi++) {
      const src = box(R() * 60 - 30, t * 10 + R() * 8, 0.4, `t${t}g${gi}`);
      const n = 40 + Math.floor(R() * 160);
      const g = new ArrayGroup3D(isvc, src.id, { mode: 'explicit', offsets: Array.from({ length: n }, (_, k) => [src.x + (k % 10) * 1.1, 0, src.z + Math.floor(k / 10) * 1.1] as [number, number, number]) });
      meshes.push(src); groups.push(g);
    }
    return { meshes, groups };
  };
  return { r, dev, cam, tile, Renderer3D };
}

/** Render one frame; check every drawn slot holds its owner's data; return the draws as owner-keyed strings. */
function frame(w: Awaited<ReturnType<typeof world>>, meshes: any[], groups: any[]): string[] {
  const { r, dev } = w;
  r.setArrayGroups(groups);
  const rp = recordingPass();
  r.drawMeshes(rp.pass, meshes, 1300, 850);
  const data = new Float32Array(dev.mem.get(r.instanceStorageBuffer)!.buffer);
  const bySlot = new Map<number, { what: string; x: number; y: number; z: number }>();
  for (const m of meshes) { const s = r._meshInstanceSlots.get(m.id); if (s !== undefined) bySlot.set(s, { what: m.name, x: m.localMatrix[12], y: m.localMatrix[13], z: m.localMatrix[14] }); }
  for (const g of groups) {
    const f = r._arrayGroupFirstSlot.get(g.id); if (f === undefined) continue;
    const src = meshes.find((m) => m.id === g.sourceId); if (!src) continue;
    g.arrayParams.offsets.forEach((o: number[], k: number) => bySlot.set(f + k, { what: `${src.name}#${k}`, x: o[0], y: o[1], z: o[2] }));
  }
  const out: string[] = [];
  for (const d of rp.draws) {
    const own = bySlot.get(d.slot);
    expect(own, `drawn slot ${d.slot} has no owner`).toBeDefined();
    const o = d.slot * FPI;
    // the slot's translation is its owner's: never another object's leftovers
    expect(Math.abs(data[o + 12] - own!.x) + Math.abs(data[o + 13] - own!.y) + Math.abs(data[o + 14] - own!.z)).toBeLessThan(1e-4);
    out.push(`${own!.what}:${d.indexCount}`);
  }
  return out.sort();
}

describe('P16 sliced array-group packs', () => {
  it('never draws an unpacked group, packs ≤ the budget a frame, and converges to the one-shot draws', async () => {
    const run = async (sliced: boolean) => {
      STREAM_HITCH.slicedGroupPacks = sliced;
      STREAM_HITCH_LIMITS.groupPackInstances = 600;
      const w = await world(5);
      const meshes: any[] = [], groups: any[] = [];
      const seqs: string[][] = [];
      const add = (t: number) => { const x = w.tile(t); meshes.push(...x.meshes); groups.push(...x.groups); };
      add(0);
      for (let f = 0; f < 30; f++) {
        if (f === 2 || f === 3) add(f);   // two tiles land on consecutive frames: ~2 × 600 group instances
        const before = w.r.getPerfCounters().groupPacks;
        seqs.push(frame(w, meshes, groups));
        const packed = w.r.getPerfCounters().groupPacks - before;
        if (sliced && f > 0) expect(packed).toBeLessThanOrEqual(6);   // a few groups a frame, never a whole tile's
      }
      return { seqs, stats: { ...streamHitchStats } };
    };
    const one = await run(false), sl = await run(true);
    expect(sl.stats.groupPacksDeferred).toBeGreaterThan(0);
    // converged: the last frames draw exactly the same objects as the one-shot path
    expect(sl.seqs[29]).toEqual(one.seqs[29]);
    expect(one.seqs[29].length).toBeGreaterThan(500);
    // while catching up the sliced path draws a SUBSET of the one-shot frame (things appear, nothing wrong is drawn)
    for (let f = 0; f < 30; f++) { const all = new Set(one.seqs[f]); for (const d of sl.seqs[f]) expect(all.has(d)).toBe(true); }
  });
});

describe('P16 deferred eviction', () => {
  it('a removed tile stops drawing at once; the drained state equals the eager eviction', async () => {
    const run = async (deferred: boolean) => {
      STREAM_HITCH.deferredEviction = deferred;
      STREAM_HITCH_LIMITS.evictBudgetMs = 0;   // the drain checks the clock every 64 meshes: one batch a frame
      const w = await world(9);
      let meshes: any[] = [], groups: any[] = [];
      const tiles = [0, 1, 2, 3].map((t) => w.tile(t));
      for (const t of tiles) { meshes.push(...t.meshes); groups.push(...t.groups); }
      for (let f = 0; f < 6; f++) frame(w, meshes, groups);
      const gone = [...tiles[1].meshes, ...tiles[2].meshes];
      const goneSet = new Set(gone);
      meshes = meshes.filter((m) => !goneSet.has(m)); groups = groups.filter((g) => !tiles[1].groups.includes(g) && !tiles[2].groups.includes(g));
      w.r.evictMeshCachesDeferred(gone);
      const after = frame(w, meshes, groups);
      for (const d of after) expect(d.startsWith('t1') || d.startsWith('t2')).toBe(false);   // gone at once
      // re-attach tile 2 while its eviction may still be queued (the LRU path): flush, then it draws exactly
      w.r.flushDeferredEviction(tiles[2].meshes);
      for (const m of tiles[2].meshes) m.gpuDirty = true;
      meshes.push(...tiles[2].meshes); groups.push(...tiles[2].groups);
      const pool0 = w.r.getPerfCounters().poolRebuilds;
      let last: string[] = [];
      for (let f = 0; f < 12; f++) last = frame(w, meshes, groups);
      expect(w.r.getPerfCounters().poolRebuilds).toBe(pool0);   // a re-attach never rebuilds the pool
      expect(w.r.pendingEvictions).toBe(0);
      return { last, slots: w.r._slotAlloc.freeSlots + w.r._slotAlloc.high * 0, live: w.r._geomAllocs.size, keys: [...w.r._geomKeyRefs.entries()].sort().join(';'), seen: streamHitchStats.evictDeferred };
    };
    const eager = await run(false), def = await run(true);
    expect(def.seen).toBeGreaterThan(0);
    expect(def.last).toEqual(eager.last);
    expect(def.live).toBe(eager.live);
    expect(def.keys).toBe(eager.keys);   // the same geometry refs: every released key released exactly once
  });
});

describe('P16 upload ledger', () => {
  it('instance bytes come off the frame budget first; geometry keeps its floor', async () => {
    STREAM_HITCH.uploadLedger = true;
    const w = await world(1);
    const r = w.r, L = STREAM_HITCH_LIMITS;
    r._upBytes = 0; r._upInst = 0;
    expect(r._geomBudgetLeft()).toBe(L.frameWriteBytes);
    r._noteInstBytes(3 << 20);
    expect(r._geomBudgetLeft()).toBe(L.frameWriteBytes - (3 << 20));
    r._noteInstBytes(64 << 20);
    expect(r._geomBudgetLeft()).toBe(L.geomFloorBytes);
    r._upBytes = L.geomFloorBytes;
    expect(r._geomBudgetLeft()).toBe(0);
    expect(r._geomSlice()).toBe(L.writeSliceBytes);
    STREAM_HITCH.uploadLedger = false;
    expect(r._geomSlice()).toBe((w.Renderer3D as unknown as { UPLOAD_GEOM_SLICE: number }).UPLOAD_GEOM_SLICE);
  });
});

/** Every LIVE record (placed meshes, placed array-group copies, parked group ranges) on the modelled GPU buffer equals
 *  the CPU mirror, all 60 floats. Returns the number of differing slots (+ the first few for the failure message). */
function staleRecords(w: Awaited<ReturnType<typeof world>>): { n: number; ex: string[] } {
  const r = w.r;
  const gpu = new Uint32Array(w.dev.mem.get(r.instanceStorageBuffer)!.buffer);
  const cpu = new Uint32Array(r._instanceDataBuf.buffer, r._instanceDataBuf.byteOffset, r._instanceDataBuf.length);
  const slots = new Map<number, string>();
  for (const [id, s] of r._meshInstanceSlots as Map<string, number>) slots.set(s, 'mesh ' + id.slice(0, 6));
  for (const [gid, f] of r._arrayGroupFirstSlot as Map<string, number>) { const n = r._arrayGroupSlotCount.get(gid) ?? 0; for (let k = 0; k < n; k++) slots.set(f + k, `group ${gid.slice(0, 6)}#${k}`); }
  for (const [a, b, o] of r._slotAlloc.ownedRanges() as Array<[number, number, string]>) if (r._parkedGroups.has(o)) for (let s = a; s < a + b; s++) slots.set(s, `parked ${o.slice(0, 6)}`);
  let n = 0; const ex: string[] = [];
  for (const [s, what] of slots) {
    for (let k = 0; k < FPI; k++) if (gpu[s * FPI + k] !== cpu[s * FPI + k]) { n++; if (ex.length < 6) ex.push(`${what} slot ${s} float ${k}`); break; }
  }
  return { n, ex };
}

const offsOf = (g: { arrayParams: unknown }): [number, number, number][] => (g.arrayParams as { offsets: [number, number, number][] }).offsets;

describe('array-group instance records reach the GPU whatever the group state (placed / parked / sliced)', () => {
  it('re-dress while the groups are PARKED, then a re-show that GROWS the instance buffer mid-placement: GPU == CPU', async () => {
    // The live bug (city look switch after far views): _tryIncrementalInstances captured the CPU mirror, then
    // _syncArrayGroupSlots grew the instance buffer (a NEW mirror array), _repackGroupsOf packed the groups into the
    // new one, and the touched-run upload (runs merge gaps of up to 256 slots, so they span group ranges) wrote the
    // OLD array's stale group records over them: ~6000 copies kept their previous material on the GPU.
    const w = await world(21);
    const tiles = [0, 1, 2, 3, 4, 5, 6, 7].map((t) => w.tile(t));
    const srcIds = new Set(tiles.flatMap((t) => t.groups.map((g) => g.sourceId)));
    const all = tiles.flatMap((t) => t.meshes), groups = tiles.flatMap((t) => t.groups);
    const plain = all.filter((m) => !srcIds.has(m.id));
    for (let f = 0; f < 3; f++) frame(w, all, groups);                       // everything placed (full repack)
    expect(staleRecords(w).n).toBe(0);
    for (let f = 0; f < 2; f++) frame(w, plain, groups);                     // the sources hide (LOD): their groups PARK
    expect(w.r._parkedGroups.size).toBe(groups.length);
    for (const m of all) if (srcIds.has(m.id)) { m.material.roughness = 0.123; m.material.metalness = 0.77; m.materialDirty = true; }   // the look switch
    // the sources come back with their detail re-dressed a bit larger (new group objects, +25% copies): the total still
    // fits the buffer (no grow at the frame start) but not the fragmented free space, so the grow happens INSIDE
    // _syncArrayGroupSlots, after the incremental path captured its CPU mirror
    const { ArrayGroup3D } = await import('../../scene-graph/shapes/array-group-3d');
    const groups2 = groups.map((g) => {
      const o = offsOf(g); const n = Math.ceil(o.length * 1.25);
      return new ArrayGroup3D(isvc, g.sourceId, { mode: 'explicit', offsets: Array.from({ length: n }, (_, k) => [o[0][0] + (k % 10) * 1.1, 0, o[0][2] + Math.floor(k / 10) * 1.1] as [number, number, number]) });
    });
    STREAM_HITCH_LIMITS.groupPackInstances = 1 << 20;   // every group placed this frame (the sliced packs are covered above)
    const cap0 = w.r.instanceCapacity, grows0 = w.r.getPerfCounters().instanceGrows, full0 = w.r.getPerfCounters().fullRepacks;
    expect(all.length + groups2.reduce((n, g) => n + offsOf(g).length, 0)).toBeLessThan(cap0);
    frame(w, all, groups2);
    expect(w.r.getPerfCounters().instanceGrows).toBeGreaterThan(grows0);    // the scenario: a grow inside the placement
    expect(w.r.getPerfCounters().fullRepacks).toBe(full0);                   // ...on the incremental path (no repack storm)
    let st = staleRecords(w);
    expect(st.n, st.ex.join(', ')).toBe(0);
    for (let f = 0; f < 6; f++) { frame(w, all, groups2); st = staleRecords(w); expect(st.n, `frame ${f}: ${st.ex.join(', ')}`).toBe(0); }
    // every copy carries its source's NEW material on the GPU
    const gpu = new Float32Array(w.dev.mem.get(w.r.instanceStorageBuffer)!.buffer);
    for (const g of groups2) {
      const f0 = w.r._arrayGroupFirstSlot.get(g.id); expect(f0).toBeDefined();
      for (let k = 0; k < offsOf(g).length; k++) { expect(gpu[(f0 + k) * FPI + 46]).toBeCloseTo(0.123, 5); expect(gpu[(f0 + k) * FPI + 47]).toBeCloseTo(0.77, 5); }
    }
  });

  it('re-placing a parked group (a reclaim) uploads its current CPU record', async () => {
    const w = await world(4);
    const t = w.tile(0);
    const srcIds = new Set(t.groups.map((g) => g.sourceId));
    const plain = t.meshes.filter((m) => !srcIds.has(m.id));
    for (let f = 0; f < 3; f++) frame(w, t.meshes, t.groups);
    for (let f = 0; f < 2; f++) frame(w, plain, t.groups);                   // park
    expect(w.r._parkedGroups.size).toBe(t.groups.length);
    // lose the GPU copy of the parked ranges (whatever overwrote them): the reclaim must not trust the GPU side
    const gpu = new Float32Array(w.dev.mem.get(w.r.instanceStorageBuffer)!.buffer);
    for (const [a, b, o] of w.r._slotAlloc.ownedRanges() as Array<[number, number, string]>) if (w.r._parkedGroups.has(o)) gpu.fill(-1, a * FPI, (a + b) * FPI);
    const rec0 = w.r.getPerfCounters().groupReclaims, packs0 = w.r.getPerfCounters().groupPacks;
    frame(w, t.meshes, t.groups);                                            // re-show, nothing changed: a reclaim
    expect(w.r.getPerfCounters().groupReclaims - rec0).toBe(t.groups.length);
    expect(w.r.getPerfCounters().groupPacks).toBe(packs0);                   // no re-pack: only the re-placed slots go up
    const st = staleRecords(w);
    expect(st.n, st.ex.join(', ')).toBe(0);
  });
});
