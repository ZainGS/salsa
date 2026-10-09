/**
 * Frame Link 2D "Loop" (UI audit 2026-10-09: Free / Loop to Fit was stored but never read). Free = the phase advances
 * at Speed forever; Loop to Fit = the animation repeats exactly over the timeline play range, so playback loops
 * without a jump. The compositor runs on the CPU mirror (cpu-gpu-mirror.ts ports the displacement shader).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createCpuDevice, installGpuGlobals, frameLinkDisplacement, type CpuTexture } from '../cpu-gpu-mirror';
import { RasterCompositor, LayerBlendMode, frameLinkTiming, type CompositorLayerInfo } from './raster-compositor';
import type { FrameLinkAnimation } from '../../../animation';

beforeAll(() => installGpuGlobals());

const TAU = Math.PI * 2;
const anim = (over: Partial<FrameLinkAnimation>): FrameLinkAnimation => ({
  enabled: true, type: 'wave', amplitude: 6, frequency: 3, speed: 0.15, direction: 0, phase: 0, loopMode: 'free',
  rippleCenterX: 0.5, rippleCenterY: 0.5, noiseOctaves: 2, noiseLacunarity: 2, noisePersistence: 0.5, shakeSeed: 0,
  displaceX: true, displaceY: true, ...over,
} as FrameLinkAnimation);

/** The params block writeDisplacementParams uploads, for one timing. */
function params(a: FrameLinkAnimation, frame: number, speed: number, blendLoop: number, w = 64, h = 48): Float32Array {
  const ids: Record<string, number> = { wave: 1, shake: 2, ripple: 3, noise: 4, turbulence: 5 };
  const p = new Float32Array(20);
  p[3] = blendLoop; p[4] = ids[a.type]; p[5] = a.amplitude; p[6] = a.frequency; p[7] = speed;
  p[8] = a.direction * Math.PI / 180; p[9] = a.phase; p[10] = frame; p[11] = 3;
  p[12] = a.rippleCenterX; p[13] = a.rippleCenterY; p[14] = a.noiseOctaves; p[15] = a.noiseLacunarity;
  p[16] = a.noisePersistence; p[17] = a.shakeSeed; p[18] = w; p[19] = h;
  return p;
}

describe('frameLinkTiming', () => {
  it('Free (and Loop to Fit without a timeline) leave frame and speed alone', () => {
    expect(frameLinkTiming(anim({}), 37, { start: 1, end: 24 })).toEqual({ frame: 37, speed: 0.15, blendLoop: 0 });
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit' }), 37, null)).toEqual({ frame: 37, speed: 0.15, blendLoop: 0 });
  });

  it('Wave / Ripple: a whole number of cycles per play range (at least one, sign kept); frames wrap into the range', () => {
    const fit = anim({ loopMode: 'loop-to-fit' });
    const t = frameLinkTiming(fit, 5, { start: 1, end: 24 });
    expect(t.speed).toBeCloseTo(TAU / 24, 9);            // 0.15 × 24 = 3.6 rad ≈ 0.57 cycles → 1 cycle
    expect(t.frame).toBe(5);
    expect(frameLinkTiming(fit, 25, { start: 1, end: 24 }).frame).toBe(1);
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', speed: 1 }), 1, { start: 1, end: 24 }).speed).toBeCloseTo(4 * TAU / 24, 9);
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', speed: -0.05, type: 'ripple' }), 1, { start: 1, end: 24 }).speed).toBeCloseTo(-TAU / 24, 9);
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', speed: 0 }), 3, { start: 1, end: 24 }).speed).toBe(0);
    // a play range that does not start at 1
    const r = frameLinkTiming(fit, 3, { start: 10, end: 19 });
    expect(r.frame).toBe(13);                              // (3 − 10) mod 10 = 3 → frame 13
    expect(r.speed).toBeCloseTo(TAU / 10, 9);
  });

  it('Shake repeats its jitter sequence; Noise / Turbulence cross-fade over the loop', () => {
    const range = { start: 1, end: 8 };
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', type: 'shake' }), 9, range)).toEqual({ frame: 1, speed: 0.15, blendLoop: 0 });
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', type: 'noise' }), 3, range)).toEqual({ frame: 2, speed: 0.15, blendLoop: 8 });
    expect(frameLinkTiming(anim({ loopMode: 'loop-to-fit', type: 'turbulence' }), 9, range)).toEqual({ frame: 0, speed: 0.15, blendLoop: 8 });
  });
});

describe('Loop to Fit is seamless (displacement shader, CPU port)', () => {
  const pts = [[3, 4], [17, 30], [40, 11], [63, 47]];

  it('Wave / Ripple: the frame after the end (unwrapped) displaces exactly like the start', () => {
    for (const type of ['wave', 'ripple'] as const) {
      const a = anim({ type, loopMode: 'loop-to-fit', speed: 0.37, direction: 30 });
      const range = { start: 1, end: 20 };
      const t0 = frameLinkTiming(a, 1, range);
      for (const [x, y] of pts) {
        const d0 = frameLinkDisplacement(params(a, t0.frame, t0.speed, 0), x, y);
        const dL = frameLinkDisplacement(params(a, t0.frame + 20, t0.speed, 0), x, y);   // one loop on, no wrap
        expect(dL[0]).toBeCloseTo(d0[0], 3);
        expect(dL[1]).toBeCloseTo(d0[1], 3);
        // Free at the raw speed does NOT line up (0.37 × 20 is not a whole number of cycles)
        const f0 = frameLinkDisplacement(params(a, 1, 0.37, 0), x, y), fL = frameLinkDisplacement(params(a, 21, 0.37, 0), x, y);
        if (Math.abs(f0[0]) > 0.5) expect(Math.abs(fL[0] - f0[0])).toBeGreaterThan(1e-3);
      }
    }
  });

  it('Noise / Turbulence: the cross-fade ends where it started (t = L equals t = 0) and still moves in between', () => {
    for (const type of ['noise', 'turbulence'] as const) {
      const a = anim({ type, loopMode: 'loop-to-fit', speed: 0.4 });
      let moved = false;
      for (const [x, y] of pts) {
        const d0 = frameLinkDisplacement(params(a, 0, 0.4, 8), x, y);
        const dL = frameLinkDisplacement(params(a, 8, 0.4, 8), x, y);
        expect(dL[0]).toBeCloseTo(d0[0], 5);
        expect(dL[1]).toBeCloseTo(d0[1], 5);
        const d4 = frameLinkDisplacement(params(a, 4, 0.4, 8), x, y);
        if (Math.abs(d4[0] - d0[0]) > 0.05 || Math.abs(d4[1] - d0[1]) > 0.05) moved = true;
      }
      expect(moved, type).toBe(true);
    }
  });
});

describe('RasterCompositor Frame Link loop (end to end on the CPU mirror)', () => {
  function world() {
    const gpu = createCpuDevice();
    const W = 48, H = 32;
    const base = gpu.mkTex(W, H, 'rgba8unorm');
    const top = gpu.mkTex(W, H, 'rgba8unorm');
    base.data.fill(255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {   // a pattern that shows every texel of displacement
      const o = (y * W + x) * 4;
      top.data[o] = (x * 37 + y * 11) & 255; top.data[o + 1] = (x * 5 + y * 23) & 255; top.data[o + 2] = (x ^ y) * 9 & 255;
      top.data[o + 3] = 255;
    }
    const comp = new RasterCompositor(gpu.device);
    const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
    const frameAt = (a: FrameLinkAnimation, frame: number): Uint8Array => {
      const layers: CompositorLayerInfo[] = [
        { texture: asGpu(base), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true },
        { texture: asGpu(top), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true, frameLinkAnimation: a },
      ];
      const out = gpu.mkTex(W, H, 'rgba8unorm');
      comp.currentFrame = frame;
      comp.composite(layers, asGpu(out));
      return out.data.slice();
    };
    return { comp, frameAt };
  }
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

  it('every type: the frame after the play range shows the first frame again (Loop to Fit), but not in Free', () => {
    for (const type of ['wave', 'shake', 'ripple', 'noise', 'turbulence'] as const) {
      const w = world();
      w.comp.frameLoopRange = { start: 1, end: 8 };
      const fit = anim({ type, loopMode: 'loop-to-fit', speed: 0.5, amplitude: 5 });
      const f1 = w.frameAt(fit, 1);
      expect(same(w.frameAt(fit, 9), f1), type + ' loop').toBe(true);
      expect(same(w.frameAt(fit, 4), f1), type + ' animates').toBe(false);
      const free = anim({ type, speed: 0.5, amplitude: 5 });
      expect(same(w.frameAt(free, 9), w.frameAt(free, 1)), type + ' free').toBe(false);
    }
  });

  it('a play-range change re-composites a Loop to Fit layer (it is part of the composite signature)', () => {
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(16, 16, 'rgba8unorm');
    const top = gpu.mkTex(16, 16, 'rgba8unorm');
    tex.data.fill(255);
    for (let i = 0; i < top.data.length; i++) top.data[i] = (i * 29) & 255;
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(16, 16, 'rgba8unorm') as unknown as GPUTexture;
    const a = anim({ type: 'wave', loopMode: 'loop-to-fit' });
    const layers: CompositorLayerInfo[] = [
      { texture: tex as unknown as GPUTexture, blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true },
      { texture: top as unknown as GPUTexture, blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true, frameLinkAnimation: a },
    ];
    comp.currentFrame = 3;
    comp.frameLoopRange = { start: 1, end: 12 };
    expect(comp.compositeIncremental(layers, out, 'main')).toBe('full');
    expect(comp.compositeIncremental(layers, out, 'main')).toBe('skip');
    comp.frameLoopRange = { start: 1, end: 30 };
    expect(comp.compositeIncremental(layers, out, 'main')).toBe('full');
  });
});

describe('Frame Link on the BOTTOM visible layer (the base used to be copied straight in, skipping the displacement)', () => {
  function setup() {
    const gpu = createCpuDevice();
    const W = 40, H = 24;
    const pattern = gpu.mkTex(W, H, 'rgba8unorm');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      pattern.data[o] = (x * 41 + y * 7) & 255; pattern.data[o + 1] = (x * 3 + y * 29) & 255; pattern.data[o + 2] = (x ^ (y * 5)) & 255;
      pattern.data[o + 3] = x % 7 === 0 ? 0 : 200;   // some transparent columns: the displacement moves them too
    }
    const empty = gpu.mkTex(W, H, 'rgba8unorm');   // fully transparent
    const comp = new RasterCompositor(gpu.device);
    const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
    const L = (t: CpuTexture, extra: Partial<CompositorLayerInfo> = {}): CompositorLayerInfo =>
      ({ texture: asGpu(t), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true, ...extra });
    const run = (layers: CompositorLayerInfo[], how: 'sync' | 'inc' | 'async' = 'sync') => {
      const out = gpu.mkTex(W, H, 'rgba8unorm');
      const before = { ...comp.stats };
      if (how === 'sync') comp.composite(layers, asGpu(out));
      else if (how === 'inc') comp.compositeIncremental(layers, asGpu(out), 'k' + Math.random());
      return { out, dispatches: comp.stats.dispatches - before.dispatches, copies: comp.stats.copies - before.copies, asyncOut: async () => { await comp.compositeAsync(layers, asGpu(out)); return out; } };
    };
    return { gpu, pattern, empty, comp, L, run, asGpu };
  }

  for (const type of ['wave', 'shake', 'ripple', 'noise', 'turbulence'] as const) {
    it(`${type}: a displaced bottom layer moves its pixels — exactly as the same layer over an empty layer below`, async () => {
      const t = setup();
      t.comp.currentFrame = 3;
      const a = anim({ type, amplitude: 4, speed: 0.6 });
      const alone = t.run([t.L(t.pattern, { frameLinkAnimation: a, opacity: 0.8 })]).out;
      const overEmpty = t.run([t.L(t.empty), t.L(t.pattern, { frameLinkAnimation: a, opacity: 0.8 })]).out;
      expect(Buffer.from(alone.data).equals(Buffer.from(overEmpty.data)), type).toBe(true);
      const still = t.run([t.L(t.pattern, { opacity: 0.8 })]).out;
      expect(Buffer.from(alone.data).equals(Buffer.from(still.data)), type + ' moved').toBe(false);
      // the incremental and async paths agree with composite()
      expect(Buffer.from(t.run([t.L(t.pattern, { frameLinkAnimation: a, opacity: 0.8 })], 'inc').out.data).equals(Buffer.from(alone.data)), 'inc').toBe(true);
      const asyncOut = await t.run([t.L(t.pattern, { frameLinkAnimation: a, opacity: 0.8 })], 'async').asyncOut();
      expect(Buffer.from(asyncOut.data).equals(Buffer.from(alone.data)), 'async').toBe(true);
    });
  }

  it('a bottom layer without a displacement (or Frame Link off / amplitude 0) still takes the plain copy — no blend dispatch', () => {
    const t = setup();
    for (const extra of [{}, { frameLinkAnimation: anim({ enabled: false }) }, { frameLinkAnimation: anim({ amplitude: 0 }) }] as Partial<CompositorLayerInfo>[]) {
      const r = t.run([t.L(t.pattern, extra)]);
      expect(r.dispatches).toBe(0);
      expect(r.copies).toBe(1);
      expect(Buffer.from(r.out.data).equals(Buffer.from(t.pattern.data))).toBe(true);
    }
    const d = t.run([t.L(t.pattern, { frameLinkAnimation: anim({ amplitude: 3 }) })]);
    expect(d.dispatches).toBe(1);   // the blend step
    expect(RasterCompositor.baseNeedsBlendStep({ frameLinkAnimation: anim({ amplitude: 3 }) })).toBe(true);
    expect(RasterCompositor.baseNeedsBlendStep({})).toBe(false);
  });

  it('blend mode / clipping on a displaced bottom layer stay meaningless (as with the copy): Normal, unclipped', () => {
    const t = setup();
    const a = anim({ type: 'wave', amplitude: 4 });
    const normal = t.run([t.L(t.pattern, { frameLinkAnimation: a })]).out;
    const odd = t.run([t.L(t.pattern, { frameLinkAnimation: a, blendMode: LayerBlendMode.Multiply, clipped: true })]).out;
    expect(Buffer.from(odd.data).equals(Buffer.from(normal.data))).toBe(true);
  });

  it('incremental: frame changes re-composite a displaced bottom layer, idle renders skip', () => {
    const t = setup();
    const out = t.gpu.mkTex(40, 24, 'rgba8unorm');
    const layers = [t.L(t.pattern, { frameLinkAnimation: anim({ type: 'wave', amplitude: 4 }) })];
    t.comp.currentFrame = 1;
    expect(t.comp.compositeIncremental(layers, t.asGpu(out), 'main')).toBe('full');
    expect(t.comp.compositeIncremental(layers, t.asGpu(out), 'main')).toBe('skip');
    const f1 = out.data.slice();
    t.comp.currentFrame = 2;
    expect(t.comp.compositeIncremental(layers, t.asGpu(out), 'main')).toBe('full');
    expect(Buffer.from(out.data).equals(Buffer.from(f1))).toBe(false);
  });
});
