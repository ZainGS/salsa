/**
 * BRUSH-4 stroke prediction (docs/specs/mobile-parity.md §3): the predicted (provisional) tail is drawn for one
 * frame and taken back byte-exactly. These tests run the REAL RasterPaintEngine / BrushStampPipeline on the CPU
 * mirror (cpu-gpu-mirror.ts) and check, for wet, eraser, blend-mode, lock-transparency, end-effect and
 * stroke-texture brushes:
 *  - while shown, the tail is on the texture (it really draws);
 *  - after the clear (the next frame) the texture equals the no-prediction run's texture byte for byte, frame by
 *    frame — the real stroke never builds on a predicted texel (no ghosting);
 *  - the committed layer AND the undo patch at stroke end are identical with prediction on vs off;
 *  - the provisional pass is bounded (no full-canvas work);
 *  - smudge / per-dab-bleed presets don't predict (and are untouched).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import type { BrushPreset } from './brush-preset';
import type { PointerInput } from './brush-engine';
import type { BrushStampPipeline as BSP } from './brush-stamp-pipeline';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

const EW = 360, EH = 240;
const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function fillCanvas(t: CpuTexture) {
  const r = rng(91);
  for (let i = 0; i < t.data.length; i += 4) {
    if (r() < 0.45) continue;
    t.data[i] = 30 + Math.floor(r() * 200); t.data[i + 1] = 120; t.data[i + 2] = 210; t.data[i + 3] = Math.floor(60 + r() * 195);
  }
}

/** A curving stroke: real samples every 8 ms (125 Hz), 3 per frame. */
const real = (i: number): PointerInput => ({
  x: 90 + i * 7, y: 120 + Math.sin(i / 3) * 30, pressure: 0.8 + 0.2 * Math.sin(i / 5), timestamp: 1000 + i * 8,
});
/** The predictor's guess after real sample `i`: k samples ahead, slightly off the true path (an overshoot). */
const predictedAfter = (i: number): PointerInput[] => [1, 2, 3].map(k => {
  const p = real(i + k);
  return { ...p, x: p.x + k * 1.5, y: p.y - k * 2 };
});

type Setup = { preset?: BrushPreset; erase?: number; lock?: boolean };

async function makeEngine(presetId: string, s: Setup) {
  const { RasterPaintEngine } = await import('../core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(EW, EH, 'rgba8unorm');
  fillCanvas(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  if (s.preset) engine.registerPreset(s.preset);
  expect(engine.setActivePreset(presetId)).toBe(true);
  if (s.erase !== undefined) engine.setEraseMode(s.erase);
  if (s.lock) engine.setLockTransparency(true);
  engine.setBrushColor(0.9, 0.25, 0.1, 1);
  engine.setActiveTexture(asGpu(tex));
  await engine.initializeSnapshots();
  const pipe = (engine.brushEngine as unknown as { stampPipeline: BSP }).stampPipeline;
  return { gpu, tex, engine, pipe };
}

const FRAMES = 6;

/**
 * One stroke, FRAMES frames of 3 real samples. `predict`: after each frame's real points, draw the provisional tail
 * (and, unless `autoClear`, take it back explicitly — the post-composite hook; with `autoClear` the next frame's
 * real points must clear it on their own). Returns the texture after every frame (as the NEXT frame / a reader
 * sees it), what was shown with the tail, the final layer and the undo patch.
 */
async function runStroke(presetId: string, s: Setup, predict: boolean, autoClear = false) {
  vi.spyOn(Math, 'random').mockReturnValue(0.37);   // jitter / scatter brushes: same values however many calls
  const { tex, engine, pipe } = await makeEngine(presetId, s);
  const s0 = tex.data.slice();
  const settled: Uint8Array[] = [];
  const shown: Uint8Array[] = [];
  const drawn: boolean[] = [];
  const bounded: number[] = [];
  engine.beginStroke(real(0), { pointerType: 'touch' });
  for (let f = 0; f < FRAMES; f++) {
    engine.addStrokePoints([1, 2, 3].map(k => real(f * 3 + k)));
    if (predict) {
      const c0 = pipe.stats.compositedTexels, v0 = pipe.provisionalStats.savedTexels;
      drawn.push(engine.drawProvisionalStroke(predictedAfter(f * 3 + 3)));
      bounded.push(Math.max(pipe.stats.compositedTexels - c0, pipe.provisionalStats.savedTexels - v0));
      shown.push(tex.data.slice());
      if (!autoClear) engine.clearProvisionalStroke();
    }
    if (!autoClear || !predict) settled.push(tex.data.slice());
  }
  const patch = await engine.endStroke(real(FRAMES * 3 + 1));
  return { s0, s1: tex.data.slice(), settled, shown, drawn, bounded, patch, pipe, engine };
}

function expectSamePatch(a: Awaited<ReturnType<typeof runStroke>>['patch'], b: Awaited<ReturnType<typeof runStroke>>['patch']) {
  expect(!!a).toBe(!!b);
  if (!a || !b) return;
  expect([a.x, a.y, a.rw, a.rh]).toEqual([b.x, b.y, b.rw, b.rh]);
  expect(same(a.before, b.before)).toBe(true);
  expect(same(a.after, b.after)).toBe(true);
}

async function customPresets() {
  const { createDefaultPresets } = await import('../core/raster-paint-engine');
  const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
  return {
    multiply: { ...soft, id: 'test_multiply', blending: { ...soft.blending, mode: 'multiply' } } as BrushPreset,
    strip: {
      ...soft, id: 'test_strip',
      strokeTexture: { enabled: true, textureData: '', textureSize: 64, texelsPerUnit: 0.05, edgeSoftness: 0.4 },
    } as BrushPreset,
    smudge: { ...soft, id: 'test_smudge', smudge: { enabled: true, strength: 0.6 } } as BrushPreset,
    bleedPerDab: { ...soft, id: 'test_bleed_dab', bleed: { enabled: true, radius: 2, strength: 0.5, perDab: true } } as BrushPreset,
  };
}

describe('stroke prediction never reaches the committed layer', () => {
  // visible = the tail changes bytes while shown (false: watercolor's dabs are a few /255 of alpha and mostly land
  // under the stroke already painted — only exactness is checked). Lock transparency is tested on the direct path:
  // on a WET stroke the stamp shader clamps to the stroke accum's alpha (0 ahead of the stroke), so a normal brush
  // with lock on paints nothing at all — pre-existing, see the BRUSH-4 row in mobile-parity.md.
  const cases: Array<[string, string, () => Promise<Setup>, boolean?]> = [
    ['wet paint (round soft)', 'default_round_soft', async () => ({})],
    ['moving-average stabilizer (hard pen)', 'default_hard_pen', async () => ({})],
    ['predictive stabilizer (mono-weight liner)', 'default_monoweight_liner', async () => ({})],
    ['scatter / jitter (stippling)', 'default_stippling', async () => ({})],
    ['eraser preset (direct path)', 'default_eraser', async () => ({})],
    ['erase override on a paint brush', 'default_round_soft', async () => ({ erase: 1 })],
    ['blend mode multiply (direct path)', 'test_multiply', async () => ({ preset: (await customPresets()).multiply })],
    ['lock transparency (multiply, direct path)', 'test_multiply', async () => ({ preset: (await customPresets()).multiply, lock: true })],
    ['wet edges at stroke end (watercolor)', 'default_watercolor_wash', async () => ({}), false],
    ['stroke-texture strip at stroke end', 'test_strip', async () => ({ preset: (await customPresets()).strip })],
  ];
  for (const [name, id, setup, visible = true] of cases) {
    it(`${name}: the tail shows, is cleared next frame, and the layer + undo patch are identical`, async () => {
      const s = await setup();
      const off = await runStroke(id, s, false);
      const on = await runStroke(id, s, true);
      expect(on.drawn.every(Boolean)).toBe(true);
      // the tail really drew something (at least on most frames — a tail over already-painted texels can be a no-op)
      if (visible) expect(on.shown.filter((t, f) => !same(t, off.settled[f])).length).toBeGreaterThan(FRAMES / 2);
      // after each clear the texture is exactly the no-prediction state (no ghosting, frame by frame)
      for (let f = 0; f < FRAMES; f++) expect(same(on.settled[f], off.settled[f])).toBe(true);
      expect(same(on.s1, off.s1)).toBe(true);
      expect(same(on.s1, on.s0)).toBe(false);   // the stroke itself did paint
      expectSamePatch(on.patch, off.patch);
      // bounded: each provisional pass saves + composites only the tail's footprint, never the canvas
      for (const n of on.bounded) expect(n).toBeLessThan(EW * EH);
      expect(on.pipe.hasProvisional).toBe(false);
    });
  }

  it('without an explicit clear, the next real points take the tail back first (same layer + patch)', async () => {
    const off = await runStroke('default_round_soft', {}, false);
    const on = await runStroke('default_round_soft', {}, true, true);
    expect(on.drawn.every(Boolean)).toBe(true);
    expect(same(on.s1, off.s1)).toBe(true);
    expectSamePatch(on.patch, off.patch);
  });

  it('a reader mid-stroke (readStrokeRect / samplePixel) never sees the tail', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.37);
    const ref = await makeEngine('default_round_soft', {});
    ref.engine.beginStroke(real(0));
    ref.engine.addStrokePoints([1, 2, 3].map(real));
    const want = ref.tex.data.slice();

    const t = await makeEngine('default_round_soft', {});
    t.engine.beginStroke(real(0));
    t.engine.addStrokePoints([1, 2, 3].map(real));
    expect(t.engine.drawProvisionalStroke(predictedAfter(3))).toBe(true);
    expect(same(t.tex.data, want)).toBe(false);
    const px = predictedAfter(3)[2];
    await t.pipe.samplePixel(asGpu(t.tex), px.x, px.y);   // a real reader settles the tail first
    expect(t.pipe.hasProvisional).toBe(false);
    expect(same(t.tex.data, want)).toBe(true);
  });

  it('smudge and per-dab bleed presets do not predict (and stay identical)', async () => {
    const c = await customPresets();
    for (const [id, preset] of [['test_smudge', c.smudge], ['test_bleed_dab', c.bleedPerDab]] as const) {
      const off = await runStroke(id, { preset }, false);
      const on = await runStroke(id, { preset }, true);
      expect(on.drawn.some(Boolean)).toBe(false);
      expect(on.pipe.provisionalStats.draws).toBe(0);
      expect(same(on.s1, off.s1)).toBe(true);
    }
  });

  it('nothing to draw outside a stroke / for an empty tail', async () => {
    const t = await makeEngine('default_round_soft', {});
    expect(t.engine.drawProvisionalStroke(predictedAfter(0))).toBe(false);   // no stroke
    t.engine.beginStroke(real(0));
    expect(t.engine.drawProvisionalStroke([])).toBe(false);
    expect(t.engine.clearProvisionalStroke()).toBe(false);
  });
});
