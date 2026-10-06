/**
 * BRUSH-6 (docs/specs/mobile-parity.md §3): brush strokes go on the undo stack as RECT before/after patches (no
 * full-canvas readback, no clone of the previous frame). Undo/redo must round-trip exactly — through rect and
 * full entries mixed, through trimming of the oldest entries, and from a real stroke run through the bounded
 * stamp pipeline. Runs on the CPU mirror device.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import type { RasterSnapshotManager as RSM, RasterRectPatch } from './raster-snapshot-manager';

beforeAll(() => installGpuGlobals());

const W = 40, H = 30;
const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Paint a random rect of random bytes into `t`, returning the patch (before/after) it made. */
function paintRect(t: CpuTexture, r: () => number): RasterRectPatch {
  const rw = 1 + Math.floor(r() * 12), rh = 1 + Math.floor(r() * 10);
  const x = Math.floor(r() * (W - rw)), y = Math.floor(r() * (H - rh));
  const before = new Uint8Array(rw * rh * 4), after = new Uint8Array(rw * rh * 4);
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw * 4; xx++) {
    const o = ((y + yy) * W + x) * 4 + xx;
    before[yy * rw * 4 + xx] = t.data[o];
    t.data[o] = Math.floor(r() * 256);
    after[yy * rw * 4 + xx] = t.data[o];
  }
  return { w: W, h: H, x, y, rw, rh, before, after };
}

/** Let the 40 ms snapshot coalescing window pass (full pushes are coalesced; rect patches never are). */
const pastCoalesce = (m: RSM) => { (m as unknown as { lastSnapshotMs: number }).lastSnapshotMs = 0; };

async function mk(maxSnapshots = 10) {
  const { RasterSnapshotManager } = await import('./raster-snapshot-manager');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(W, H, 'rgba8unorm');
  const mgr = new RasterSnapshotManager(gpu.device, maxSnapshots);
  await mgr.initialize(asGpu(tex));
  return { gpu, tex, mgr };
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('BRUSH-6 rect undo patches', () => {
  it('strokes push rect entries (no full frame) and undo/redo round-trip every state', async () => {
    const { tex, mgr } = await mk();
    const r = rng(1);
    const states = [tex.data.slice()];
    for (let i = 0; i < 5; i++) {
      await mgr.pushPatch(asGpu(tex), paintRect(tex, r));
      states.push(tex.data.slice());
    }
    const st = mgr.getStats();
    expect(st.kinds).toEqual(['full', 'rect', 'rect', 'rect', 'rect', 'rect']);
    expect(st.bytes).toBeLessThan(W * H * 4 * 2);   // one full frame + small patches (was 6 full frames)

    for (let i = 4; i >= 0; i--) {
      expect(await mgr.undo(asGpu(tex))).toBe(true);
      expect(same(tex.data, states[i])).toBe(true);
    }
    expect(await mgr.undo(asGpu(tex))).toBe(false);   // at the oldest
    for (let i = 1; i <= 5; i++) {
      expect(await mgr.redo(asGpu(tex))).toBe(true);
      expect(same(tex.data, states[i])).toBe(true);
    }
    expect(await mgr.redo(asGpu(tex))).toBe(false);
  });

  it('mixed full + rect entries round-trip (undo from a full entry onto a rect entry rebuilds the state)', async () => {
    const { tex, mgr } = await mk();
    const r = rng(2);
    const states = [tex.data.slice()];
    await mgr.pushPatch(asGpu(tex), paintRect(tex, r)); states.push(tex.data.slice());
    await mgr.pushPatch(asGpu(tex), paintRect(tex, r)); states.push(tex.data.slice());
    // a "fill": whole-canvas change → full push
    for (let i = 0; i < tex.data.length; i++) tex.data[i] = (tex.data[i] + 77) & 255;
    pastCoalesce(mgr);
    await mgr.pushSnapshot(asGpu(tex)); states.push(tex.data.slice());
    await mgr.pushPatch(asGpu(tex), paintRect(tex, r)); states.push(tex.data.slice());
    expect(mgr.getStats().kinds).toEqual(['full', 'rect', 'rect', 'full', 'rect']);

    for (let i = states.length - 2; i >= 0; i--) {
      await mgr.undo(asGpu(tex));
      expect(same(tex.data, states[i])).toBe(true);
    }
    for (let i = 1; i < states.length; i++) {
      await mgr.redo(asGpu(tex));
      expect(same(tex.data, states[i])).toBe(true);
    }
  });

  it('a new stroke after undo truncates redo; trimming folds the oldest rect into a full base', async () => {
    const { tex, mgr } = await mk(4);
    const r = rng(3);
    const states = [tex.data.slice()];
    for (let i = 0; i < 9; i++) { await mgr.pushPatch(asGpu(tex), paintRect(tex, r)); states.push(tex.data.slice()); }
    // capped at 4 entries, entry 0 still full
    expect(mgr.getStats().kinds).toEqual(['full', 'rect', 'rect', 'rect']);
    // undo to the oldest kept state (= state 6)
    for (let i = 8; i >= 6; i--) { await mgr.undo(asGpu(tex)); expect(same(tex.data, states[i])).toBe(true); }
    expect(await mgr.undo(asGpu(tex))).toBe(false);
    // branch: a new stroke drops the redo tail
    await mgr.pushPatch(asGpu(tex), paintRect(tex, r));
    const branched = tex.data.slice();
    expect(await mgr.redo(asGpu(tex))).toBe(false);
    await mgr.undo(asGpu(tex));
    expect(same(tex.data, states[6])).toBe(true);
    await mgr.redo(asGpu(tex));
    expect(same(tex.data, branched)).toBe(true);
  });

  it('a no-op patch pushes nothing; a patch on an empty stack falls back to a full push', async () => {
    const { RasterSnapshotManager } = await import('./raster-snapshot-manager');
    const { tex, mgr } = await mk();
    const p = paintRect(tex, rng(4));
    await mgr.pushPatch(asGpu(tex), { ...p, after: p.before });
    expect(mgr.getStats().kinds).toEqual(['full']);

    const gpu2 = createCpuDevice();
    const t2 = gpu2.mkTex(W, H, 'rgba8unorm');
    const fresh = new RasterSnapshotManager(gpu2.device);
    await fresh.pushPatch(asGpu(t2), paintRect(t2, rng(5)));
    expect(fresh.getStats().kinds).toEqual(['full']);
  });

  it('the legacy dirtyRect push builds a rect entry from the stack state (no full clone) and round-trips', async () => {
    const { tex, mgr } = await mk();
    const r = rng(6);
    const s0 = tex.data.slice();
    const p = paintRect(tex, r);
    pastCoalesce(mgr);
    await mgr.pushSnapshot(asGpu(tex), { x: p.x - 2, y: p.y - 1, w: p.rw + 4, h: p.rh + 2 });
    const s1 = tex.data.slice();
    expect(mgr.getStats().kinds).toEqual(['full', 'rect']);
    await mgr.undo(asGpu(tex)); expect(same(tex.data, s0)).toBe(true);
    await mgr.redo(asGpu(tex)); expect(same(tex.data, s1)).toBe(true);
  });
});

describe('BRUSH-6 stroke → patch → undo (real stamp pipeline)', () => {
  it('a bounded stroke captured with readStrokeRect undoes and redoes exactly', async () => {
    const { BrushStampPipeline } = await import('../brushes/brush-stamp-pipeline');
    const { RasterSnapshotManager } = await import('./raster-snapshot-manager');
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    const r = rng(7);
    for (let i = 0; i < tex.data.length; i++) tex.data[i] = r() < 0.5 ? 0 : Math.floor(r() * 256);
    const tip = gpu.mkTex(8, 8, 'r8unorm'); tip.data.fill(200);
    const mgr = new RasterSnapshotManager(gpu.device);
    await mgr.initialize(asGpu(tex));
    const pipe = new BrushStampPipeline(gpu.device);

    const states = [tex.data.slice()];
    for (let s = 0; s < 3; s++) {
      pipe.beginStroke(asGpu(tex));
      pipe.beginBatch();
      for (let i = 0; i < 12; i++) {
        pipe.stampWithPingPong(asGpu(tex), {
          cx: 5 + s * 10 + i, cy: 8 + i * 0.7, radius: 2 + (i % 3), color: [r(), r(), r(), 0.8], rotation: 0,
          mode: s === 1 ? 1 : 0, aspect: [1, 1], tipTexture: asGpu(tip),
        });
      }
      pipe.endBatch();
      pipe.endStroke();
      const rect = pipe.takeStrokeTouchedRect()!;
      const p = (await pipe.readStrokeRect(asGpu(tex), rect))!;
      await mgr.pushPatch(asGpu(tex), { w: W, h: H, x: p.x, y: p.y, rw: p.w, rh: p.h, before: p.before, after: p.after });
      states.push(tex.data.slice());
    }
    expect(mgr.getStats().kinds).toEqual(['full', 'rect', 'rect', 'rect']);
    for (let i = 2; i >= 0; i--) { await mgr.undo(asGpu(tex)); expect(same(tex.data, states[i])).toBe(true); }
    for (let i = 1; i <= 3; i++) { await mgr.redo(asGpu(tex)); expect(same(tex.data, states[i])).toBe(true); }
  });
});

describe('BRUSH-6 RasterPaintEngine end to end', () => {
  it('a frame batch is one submit; endStroke returns the rect patch and engine undo/redo round-trips', async () => {
    const { RasterPaintEngine } = await import('./raster-paint-engine');
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(160, 120, 'rgba8unorm');
    const engine = new RasterPaintEngine(gpu.device, () => {});
    engine.setActivePreset('default_hard_pen');
    engine.setBrushColor(0.2, 0.4, 0.9, 1);
    engine.setActiveTexture(asGpu(tex));
    await engine.initializeSnapshots();
    const s0 = tex.data.slice();

    const pt = (i: number) => ({ x: 8 + i * 2, y: 10 + i, pressure: 0.8, timestamp: 1000 + i * 4 });
    engine.beginStroke(pt(0));
    const sub0 = gpu.counters.submits;
    engine.addStrokePoints([1, 2, 3, 4, 5, 6, 7, 8].map(pt));
    expect(gpu.counters.submits - sub0).toBe(1);          // 8 points, many dabs → ONE submit
    const patch = await engine.endStroke(pt(9));
    expect(patch).not.toBeNull();
    expect(patch!.rw * patch!.rh).toBeLessThan(160 * 120 / 4); // a rect, not the canvas
    const s1 = tex.data.slice();
    expect(same(s1, s0)).toBe(false);
    expect(engine.snapshotManager.getStats().kinds).toEqual(['full', 'rect']);

    expect(await engine.undo()).toBe(true);
    expect(same(tex.data, s0)).toBe(true);
    expect(await engine.redo()).toBe(true);
    expect(same(tex.data, s1)).toBe(true);
  });

  it('pushSnapshot:false leaves the engine stack alone (the caller pushes the patch to the layer stack)', async () => {
    const { RasterPaintEngine } = await import('./raster-paint-engine');
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(32, 32, 'rgba8unorm');
    const engine = new RasterPaintEngine(gpu.device, () => {});
    engine.setActiveTexture(asGpu(tex));
    await engine.initializeSnapshots();
    engine.beginStroke({ x: 10, y: 10, pressure: 1, timestamp: 1 });
    engine.addStrokePoints([{ x: 20, y: 12, pressure: 1, timestamp: 17 }]);
    const patch = await engine.endStroke({ x: 20, y: 12, pressure: 1, timestamp: 20 }, { pushSnapshot: false });
    expect(patch?.texture).toBe(tex);
    expect(engine.snapshotManager.getStats().kinds).toEqual(['full']);
  });
});
