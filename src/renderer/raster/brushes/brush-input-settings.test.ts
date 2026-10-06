/**
 * Touch smoothing cap + per-machine brush input settings (brush-input-settings.ts, mobile-parity.md §3 BRUSH-4):
 * a FINGER stroke caps the stabilizer at ~16.7 ms of lag ('light'), 'off' disables it, 'normal' keeps the brush's
 * value; pen / mouse are never touched; a brush lighter than the cap keeps its value. Both settings persist.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  stabilizationForPointer, capStabilizationLag, stabilizationLagMs, LIGHT_TOUCH_LAG_MS,
  getTouchSmoothing, setTouchSmoothing, getStrokePrediction, setStrokePrediction, reloadBrushInputSettings,
  predictionAppliesTo,
} from './brush-input-settings';
import { BrushStabilizer, REF_FRAME_MS } from './brush-stabilizer';
import type { BrushStabilization } from './brush-preset';
import { createCpuDevice, installGpuGlobals } from '../cpu-gpu-mirror';

beforeAll(() => installGpuGlobals());

const g = globalThis as { localStorage?: unknown };
const prevLS = g.localStorage;
function fakeStorage() {
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  return store;
}
afterEach(() => { g.localStorage = prevLS; reloadBrushInputSettings(); });

const MA = (level: number): BrushStabilization => ({ method: 'moving-average', level });
const PR = (level: number): BrushStabilization => ({ method: 'predictive', level });

/** Measured lag (ms) of a stabilizer config: feed a constant-speed 60 Hz line, compare output to input. */
function measuredLagMs(cfg: BrushStabilization): number {
  const s = new BrushStabilizer(cfg);
  let out = { x: 0 };
  const v = 1;   // texels per ms
  for (let i = 0; i < 400; i++) out = s.push({ x: i * REF_FRAME_MS * v, y: 0, pressure: 1, timestamp: i * REF_FRAME_MS });
  return (399 * REF_FRAME_MS * v - out.x) / v;
}

describe('touch smoothing cap', () => {
  it('the lag model matches the stabilizer (measured on a 60 Hz constant-speed line)', () => {
    for (const cfg of [MA(1), MA(2), MA(3), MA(4), MA(6), PR(0.5), PR(2), PR(4)]) {
      expect(measuredLagMs(cfg)).toBeCloseTo(stabilizationLagMs(cfg)!, 3);
    }
  });

  it("finger + 'light': caps to ≈16.7 ms (Hard Pen 4 → 2, Mono-Weight Liner 4 → 0.67)", () => {
    expect(LIGHT_TOUCH_LAG_MS).toBeCloseTo(16.667, 2);
    const hard = stabilizationForPointer(MA(4), 'touch', 'light');
    expect(hard).toEqual(MA(2));
    expect(measuredLagMs(hard)).toBeLessThanOrEqual(LIGHT_TOUCH_LAG_MS + 1e-6);
    const liner = stabilizationForPointer(PR(4), 'touch', 'light');
    expect(liner.method).toBe('predictive');
    expect(liner.level).toBeCloseTo(2 / 3, 6);
    expect(measuredLagMs(liner)).toBeCloseTo(LIGHT_TOUCH_LAG_MS, 3);
    // the cap is ~half of Hard Pen's touch lag today (39 ms)
    expect(stabilizationLagMs(MA(4))! / LIGHT_TOUCH_LAG_MS).toBeCloseTo(7 / 3, 6);
  });

  it('a brush lighter than the cap keeps its (lower) value — same object', () => {
    for (const cfg of [MA(1), MA(2), PR(0.5), { method: 'none', level: 0 } as BrushStabilization]) {
      expect(stabilizationForPointer(cfg, 'touch', 'light')).toBe(cfg);
    }
  });

  it('pen and mouse (and unknown pointers) always get the brush value untouched', () => {
    for (const cfg of [MA(4), PR(4), MA(10)]) {
      for (const pt of ['pen', 'mouse', undefined, '']) {
        for (const mode of ['off', 'light', 'normal'] as const) expect(stabilizationForPointer(cfg, pt, mode)).toBe(cfg);
      }
    }
  });

  it("'off' = no smoothing for a finger; 'normal' = no cap", () => {
    expect(stabilizationForPointer(MA(4), 'touch', 'off')).toEqual(MA(0));
    expect(stabilizationForPointer(PR(4), 'touch', 'off')).toEqual(PR(0));
    const cfg = MA(4);
    expect(stabilizationForPointer(cfg, 'touch', 'normal')).toBe(cfg);
  });

  it('catmull-rom caps to its lightest level; pull-string (a distance, not a lag) is left alone', () => {
    expect(capStabilizationLag({ method: 'catmull-rom', level: 6 }, LIGHT_TOUCH_LAG_MS)).toEqual({ method: 'catmull-rom', level: 1 });
    const ps: BrushStabilization = { method: 'pull-string', level: 5, pullStringLength: 30 };
    expect(stabilizationForPointer(ps, 'touch', 'light')).toBe(ps);
    expect(stabilizationForPointer(ps, 'touch', 'off').level).toBe(0);
  });

  it('BrushEngine.beginStroke applies it per stroke: finger capped, pen / mouse / no type = the preset', async () => {
    const { RasterPaintEngine } = await import('../core/raster-paint-engine');
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(64, 64, 'rgba8unorm');
    const engine = new RasterPaintEngine(gpu.device, () => {});
    expect(engine.setActivePreset('default_hard_pen')).toBe(true);   // moving-average 4
    engine.setActiveTexture(tex as unknown as GPUTexture);
    const stab = (engine.brushEngine as unknown as { stabilizer: BrushStabilizer }).stabilizer;
    const stroke = async (pointerType?: string) => {
      engine.beginStroke({ x: 10, y: 10, pressure: 1, timestamp: 0 }, pointerType === undefined ? undefined : { pointerType });
      const cfg = stab.getConfig();
      await engine.endStroke({ x: 12, y: 10, pressure: 1, timestamp: 16 });
      return cfg;
    };
    expect(await stroke('touch')).toEqual({ method: 'moving-average', level: 2 });
    expect(await stroke('pen')).toEqual({ method: 'moving-average', level: 4 });
    expect(await stroke('mouse')).toEqual({ method: 'moving-average', level: 4 });
    expect(await stroke()).toEqual({ method: 'moving-average', level: 4 });
    setTouchSmoothing('normal');
    expect(await stroke('touch')).toEqual({ method: 'moving-average', level: 4 });
    setTouchSmoothing('off');
    expect(await stroke('touch')).toEqual({ method: 'moving-average', level: 0 });
  });

  it('a mouse stroke is byte-identical with or without the touch machinery', async () => {
    const { RasterPaintEngine } = await import('../core/raster-paint-engine');
    const run = async (opts?: { pointerType?: string }, smoothing?: 'off' | 'light' | 'normal') => {
      if (smoothing) setTouchSmoothing(smoothing);
      const gpu = createCpuDevice();
      const tex = gpu.mkTex(96, 64, 'rgba8unorm');
      const engine = new RasterPaintEngine(gpu.device, () => {});
      engine.setActivePreset('default_hard_pen');
      engine.setActiveTexture(tex as unknown as GPUTexture);
      engine.beginStroke({ x: 10, y: 30, pressure: 0.8, timestamp: 0 }, opts);
      for (let f = 1; f <= 6; f++) engine.addStrokePoints([{ x: 10 + f * 12, y: 30 + (f % 2) * 9, pressure: 0.8, timestamp: f * 16 }]);
      await engine.endStroke({ x: 82, y: 30, pressure: 0.8, timestamp: 112 });
      return tex.data.slice();
    };
    const plain = await run();
    expect(Buffer.from(await run({ pointerType: 'mouse' }, 'off')).equals(Buffer.from(plain))).toBe(true);
    expect(Buffer.from(await run({ pointerType: 'pen' }, 'light')).equals(Buffer.from(plain))).toBe(true);
    expect(Buffer.from(await run({ pointerType: 'touch' }, 'light')).equals(Buffer.from(plain))).toBe(false);   // capped
  });
});

describe('settings persistence', () => {
  it("defaults: 'light' smoothing, prediction on (no storage)", () => {
    g.localStorage = undefined;
    reloadBrushInputSettings();
    expect(getTouchSmoothing()).toBe('light');
    expect(getStrokePrediction()).toBe(false);   // off by default until verified on a real GPU
  });

  it('persists to localStorage and reloads; junk values are ignored', () => {
    const store = fakeStorage();
    reloadBrushInputSettings();
    setTouchSmoothing('off');
    setStrokePrediction(false);
    expect(store.get('salsa.brush.touchSmoothing')).toBe('off');
    expect(store.get('salsa.brush.strokePrediction')).toBe('0');
    reloadBrushInputSettings();
    expect(getTouchSmoothing()).toBe('off');
    expect(getStrokePrediction()).toBe(false);
    setTouchSmoothing('bogus' as never);
    expect(getTouchSmoothing()).toBe('off');
    store.set('salsa.brush.touchSmoothing', 'heavy');
    reloadBrushInputSettings();
    expect(getTouchSmoothing()).toBe('light');
  });

  it('throwing storage falls back to in-memory values', () => {
    g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    reloadBrushInputSettings();
    expect(getTouchSmoothing()).toBe('light');
    setTouchSmoothing('normal');
    expect(getTouchSmoothing()).toBe('normal');
  });

  it('prediction applies to touch and pen only', () => {
    expect(predictionAppliesTo('touch')).toBe(true);
    expect(predictionAppliesTo('pen')).toBe(true);
    expect(predictionAppliesTo('mouse')).toBe(false);
    expect(predictionAppliesTo(undefined)).toBe(false);
  });
});
