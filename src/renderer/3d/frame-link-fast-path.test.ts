/**
 * E4 (docs/reviews/playback-perf-2026-10-09.md), end to end on the REAL Renderer3D over a recording device: meshes
 * animated by the timeline (Frame Link / transform tracks) now mark only their TRANSFORMS dirty. Per animated frame:
 * no full instance repack, no slot-generation bump, no draw re-rank, and the static shadow cache is not re-rendered —
 * the movers drop into its dynamic layer by themselves (matrix version) — while every drawn slot still holds its
 * mesh's CURRENT matrix. The old invalidation (markInstancesDirty) is run alongside for the before / after counts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const FPI = 60;   // floats per instance slot (renderer-3d.ts MESH_INSTANCE_STRIDE / 4)

function recordingDevice() {
  const mem = new Map<object, Uint8Array>();
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
    // textures report their size (the static shadow cache checks its texture against the map size)
    if (k === 'createTexture') return (d: { size: number[] | { width: number; height: number } }) => {
      const [w, h] = Array.isArray(d.size) ? d.size : [d.size.width, d.size.height];
      return new Proxy({}, { get: (_t, kk) => (kk === 'width' ? w : kk === 'height' ? h : kk === 'then' ? undefined : stub) });
    };
    if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
    return stub;
  } });
  return { device: device as unknown as GPUDevice, mem };
}
const pass = new Proxy({}, { get: () => () => undefined }) as unknown as GPURenderPassEncoder;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function run(transformsOnly: boolean) {
  const { Renderer3D } = await import('./renderer-3d');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const dev = recordingDevice();
  const cam = new Camera3D();
  cam.setPosition(0, 12, -20); cam.setTarget(0, 0, 0);
  const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
  r.enableShadows(1024, 30);
  r.setDirectionalLight(-0.4, -0.8, -0.3, 1, 1, 1, 1);
  const box = (x: number, z: number, name: string) => {
    const s = 1, v: number[] = [], ix = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4];
    for (const p of [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]) v.push(p[0], p[1], p[2], 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const m = new Mesh3D(isvc, x, 0, z, { primitive: 'custom', geometry: { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' } });
    m.name = name; m.setGeometryKeyOverride('k-' + name);
    return m;
  };
  const meshes = [] as InstanceType<typeof Mesh3D>[];
  for (let i = 0; i < 24; i++) meshes.push(box((i % 6) * 3 - 8, Math.floor(i / 6) * 3 - 4, 'static' + i));
  const movers = [box(-2, 6, 'bounce'), box(1, 6, 'sway'), box(4, 6, 'spin')];
  meshes.push(...movers);
  // settle: the static shadow set passes its probation and caches
  for (let f = 0; f < 260; f++) r.drawMeshes(pass, meshes, 1300, 850);   // (90-frame probation + the 120-frame join)
  const p0 = r.getPerfCounters(), gen0 = r._r3Gen, ranks0 = r._drawOrder.stats.updates, sc0 = { ...r.getShadowCacheStats() };
  let staleFrames = 0, slotChecks = 0;
  for (let f = 1; f <= 60; f++) {
    const a = (f / 24) * Math.PI * 2;
    movers[0].setTransform3D(-2, Math.sin(a) * 0.5, 6, 0, 0, 0, 1, 1, 1);
    movers[1].setTransform3D(1, 0, 6, 0, 0, Math.sin(a) * 0.3, 1, 1, 1);
    movers[2].setTransform3D(4, 0, 6, 0, f * 0.1, 0, 1, 1, 1);
    if (transformsOnly) r.markTransformsDirty(); else r.markInstancesDirty();
    r.drawMeshes(pass, meshes, 1300, 850);
    if (r._shadowMapStale) staleFrames++;
    const data = new Float32Array(dev.mem.get(r.instanceStorageBuffer)!.buffer);
    for (const m of meshes) {   // every slot holds its mesh's CURRENT matrix
      const o = r._meshInstanceSlots.get(m.id) * FPI, lm = m.localMatrix as unknown as Float32Array;
      for (let k = 0; k < 16; k++) expect(data[o + k]).toBeCloseTo(lm[k], 5);
      slotChecks++;
    }
  }
  const p1 = r.getPerfCounters(), sc1 = r.getShadowCacheStats();
  return {
    fullRepacks: p1.fullRepacks - p0.fullRepacks, fastPaths: p1.fastPaths - p0.fastPaths, genBumps: r._r3Gen - gen0,
    reRanks: r._drawOrder.stats.updates - ranks0, staleFrames, slotChecks,
    staticRenders: sc1.staticRenders - sc0.staticRenders, sSig: sc1.staticSig - sc0.staticSig, sStale: sc1.staticStale - sc0.staticStale, sCold: sc1.staticCold - sc0.staticCold, cached: sc1.cached, staticCasters: sc1.staticCasters, dynCasters: sc1.dynCasters, dynPasses: sc1.dynPasses - sc0.dynPasses, directRenders: sc1.directRenders - sc0.directRenders,
  };
}

describe('E4: timeline transform animation takes the transforms fast path', () => {
  it('60 animated frames: no repack / generation bump / re-rank / static shadow re-render; matrices current', async () => {
    const before = await run(false), after = await run(true);
    // the old invalidation (measured: 60 repacks, 1680 slot-generation bumps, 60 re-ranks, 60 static re-renders of all
    // 27 casters): a full repack + generation bump + re-rank + a stale static shadow layer every frame
    expect(before.fullRepacks).toBe(60);
    expect(before.staleFrames + before.staticRenders + before.directRenders).toBeGreaterThanOrEqual(60);
    // now
    expect(after.fullRepacks).toBe(0);
    expect(after.fastPaths).toBe(60);
    expect(after.genBumps).toBe(0);
    expect(after.reRanks).toBe(0);
    expect(after.staleFrames).toBe(0);
    expect(after.directRenders).toBe(0);
    expect(after.staticRenders).toBe(1);                  // once, when the three movers leave the static set (signature)
    expect(after.staticCasters).toBe(24);
    expect(after.dynCasters).toBe(3);                      // the movers: the per-frame dynamic layer only
    expect(after.dynPasses).toBeGreaterThan(0);            // they cast from the dynamic layer
    expect(after.slotChecks).toBe(before.slotChecks);
  });
});
