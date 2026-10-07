/**
 * mobile-parity 7.3b — two stroke-model additions for UV paint, run through the REAL RasterPaintEngine on the CPU
 * mirror device (cpu-gpu-mirror.ts):
 *  - P1 cancelStroke(): a second finger turns a stroke into a pinch → the texture goes back to its stroke-start bytes
 *    EXACTLY (GPU work only: clear accum + base ⊕ empty-accum composite over the touched rect) and no undo entry is made;
 *  - S7 liftStroke(): a seam jump lifts the brush inside the SAME stroke. For islands that don't overlap, the result is
 *    byte-identical to the old end-stroke + restart (same dabs, same per-run stabilizer / spacing reset) — but it is
 *    one stroke: one undo step, no end / restart readbacks.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import type { PointerInput } from './brush-engine';

beforeAll(() => installGpuGlobals());

const W = 320, H = 200;
const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function fill(t: CpuTexture) {
  let s = 12345;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < t.data.length; i += 4) {
    if (r() < 0.5) continue;
    t.data[i] = 30; t.data[i + 1] = 150; t.data[i + 2] = 210; t.data[i + 3] = Math.floor(60 + r() * 195);
  }
}

async function makeEngine(presetId: string, erase?: number) {
  const { RasterPaintEngine } = await import('../core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(W, H, 'rgba8unorm');
  fill(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  expect(engine.setActivePreset(presetId)).toBe(true);
  if (erase !== undefined) engine.setEraseMode(erase);
  engine.setBrushColor(0.9, 0.2, 0.1, 1);
  engine.setActiveTexture(asGpu(tex));
  await engine.initializeSnapshots();
  return { engine, tex };
}

const ptA = (i: number): PointerInput => ({ x: 40 + i * 6, y: 50 + Math.sin(i / 2) * 8, pressure: 0.8, timestamp: 1000 + i * 16 });
const ptB = (i: number): PointerInput => ({ x: 200 + i * 6, y: 140 + Math.cos(i / 2) * 8, pressure: 0.6, timestamp: 2000 + i * 16 });
const runEndOf = (p: PointerInput): PointerInput => ({ ...p, pressure: 1 });   // what the UV controller ends a run with

describe('P1 RasterPaintEngine.cancelStroke', () => {
  for (const [id, erase] of [['default_round_soft', undefined], ['default_watercolor_wash', undefined], ['default_round_soft', 1]] as const) {
    it(`${id}${erase ? ' (erase)' : ''}: the texture is back to its stroke-start bytes and no undo entry is made`, async () => {
      const { engine, tex } = await makeEngine(id, erase);
      const s0 = tex.data.slice();
      const stats0 = JSON.stringify(engine.snapshotManager.getStats());
      engine.beginStroke(ptA(0));
      for (let f = 0; f < 4; f++) engine.addStrokePoints([1, 2, 3].map(k => ptA(f * 3 + k)));
      expect(same(tex.data, s0)).toBe(false);          // it painted
      expect(engine.cancelStroke()).toBe(true);
      expect(same(tex.data, s0)).toBe(true);           // …and every texel came back
      expect(JSON.stringify(engine.snapshotManager.getStats())).toBe(stats0);
      // the engine is ready for the next stroke (an opaque preset — the watercolor's jittered low flow can round away)
      engine.setActivePreset('default_round_soft');
      engine.setEraseMode(null);
      engine.beginStroke(ptB(0));
      for (let f = 0; f < 4; f++) engine.addStrokePoints([1, 2, 3].map(k => ptB(f * 3 + k)));
      await engine.endStroke(ptB(13));
      expect(same(tex.data, s0)).toBe(false);
    });
  }

  it('cancelling a stroke that painted nothing reports false and changes nothing', async () => {
    const { engine, tex } = await makeEngine('default_round_soft');
    const s0 = tex.data.slice();
    expect(engine.cancelStroke()).toBe(false);         // no stroke at all
    expect(same(tex.data, s0)).toBe(true);
  });
});

describe('S7 RasterPaintEngine.liftStroke', () => {
  async function paintTwoIslands(presetId: string, mode: 'lift' | 'restart') {
    const { engine, tex } = await makeEngine(presetId);
    const stats0 = engine.snapshotManager.getStats().kinds.length;
    engine.beginStroke(ptA(0));
    engine.addStrokePoints([1, 2, 3, 4, 5].map(ptA));
    if (mode === 'lift') {
      expect(engine.liftStroke(runEndOf(ptA(5)), ptB(0))).toBe(true);
    } else {
      await engine.endStroke(runEndOf(ptA(5)));
      engine.beginStroke(ptB(0));
    }
    engine.addStrokePoints([1, 2, 3, 4, 5].map(ptB));
    await engine.endStroke(runEndOf(ptB(5)));
    return { tex, entries: engine.snapshotManager.getStats().kinds.length - stats0, engine };
  }

  for (const id of ['default_round_soft', 'default_hard_pen']) {
    it(`${id}: byte-identical to end + restart for separate islands, as ONE undo step`, async () => {
      const lift = await paintTwoIslands(id, 'lift');
      const restart = await paintTwoIslands(id, 'restart');
      expect(same(lift.tex.data, restart.tex.data)).toBe(true);
      expect(restart.entries).toBe(2);
      expect(lift.entries).toBe(1);
      // nothing was drawn across the gap between the islands (the old straight-line streak)
      const gapX = 150, gapY = 95;
      const { tex: t0 } = await makeEngine(id);
      const i = (gapY * W + gapX) * 4;
      expect([...lift.tex.data.subarray(i, i + 4)]).toEqual([...t0.data.subarray(i, i + 4)]);
      // one undo takes the whole drag back
      expect(await lift.engine.undo()).toBe(true);
      expect(same(lift.tex.data, t0.data)).toBe(true);
    });
  }

  it('a stroke-texture preset cannot lift (its strip would bridge the gap) → false, stroke untouched', async () => {
    const { createDefaultPresets } = await import('../core/raster-paint-engine');
    const { engine, tex } = await makeEngine('default_round_soft');
    const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
    engine.registerPreset({ ...soft, id: 'test_strip', strokeTexture: { enabled: true, textureData: '', textureSize: 64, texelsPerUnit: 0.05, edgeSoftness: 0.4 } });
    engine.setActivePreset('test_strip');
    engine.beginStroke(ptA(0));
    engine.addStrokePoints([ptA(1), ptA(2)]);
    const mid = tex.data.slice();
    expect(engine.liftStroke(runEndOf(ptA(2)), ptB(0))).toBe(false);
    expect(same(tex.data, mid)).toBe(true);
    await engine.endStroke(ptA(3));
  });

  it('no live stroke → false', async () => {
    const { engine } = await makeEngine('default_round_soft');
    expect(engine.liftStroke(ptA(0), ptB(0))).toBe(false);
  });

  it('peekStrokeDirtyRect covers the stroke so far without consuming it', async () => {
    const { engine } = await makeEngine('default_round_soft');
    expect(engine.peekStrokeDirtyRect()).toBeNull();
    engine.beginStroke(ptA(0));
    engine.addStrokePoints([1, 2, 3].map(ptA));
    const r1 = engine.peekStrokeDirtyRect()!;
    expect(r1.x).toBeLessThanOrEqual(ptA(0).x);
    expect(r1.x + r1.w).toBeGreaterThanOrEqual(ptA(3).x);
    expect(engine.peekStrokeDirtyRect()).toEqual(r1);   // not consumed
    const patch = await engine.endStroke(ptA(4));
    expect(patch).not.toBeNull();                         // the undo patch still got its rect
  });
});
