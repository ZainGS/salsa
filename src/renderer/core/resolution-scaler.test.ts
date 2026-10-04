import { describe, it, expect } from 'vitest';
import { ResolutionScaler, sanitizeResolutionScale, DEFAULT_RESOLUTION_SCALE, RES_SCALE_STEP, motionDropAllowed } from './resolution-scaler';

// A fragment-bound GPU: `fixed` ms that do not scale + `k` ms at full resolution that scale with the pixel count.
const gpu = (fixed: number, k: number) => (s: number) => fixed + k * s * s;

/** Run the controller for `secs` at 60 frames a second against a cost model; returns the scale trace (per frame). */
function run(rs: ResolutionScaler, cost: (s: number) => number, secs: number, t0 = 0): { t: number; trace: number[] } {
  const trace: number[] = [];
  let t = t0;
  for (let i = 0; i < secs * 60; i++) { t += 1000 / 60; rs.sample(cost(rs.scale()), t); trace.push(rs.scale()); }
  return { t, trace };
}

describe('resolution scaling settings', () => {
  it('defaults to off, 0.75 fixed, 16 ms, 0.6 min, 1 max; camera-motion drop auto at 0.78', () => {
    expect(DEFAULT_RESOLUTION_SCALE).toEqual({ mode: 'off', scale: 0.75, targetMs: 16, minScale: 0.6, maxScale: 1, motion: 'auto', motionScale: 0.78 });
    expect(new ResolutionScaler().scale()).toBe(1);
  });

  it('sanitizes: clamps ranges, keeps the base on bad input, maxScale >= minScale', () => {
    const s = sanitizeResolutionScale({ mode: 'bogus' as never, scale: 9, targetMs: -1, minScale: 0.1, maxScale: NaN, motion: 'x' as never, motionScale: 0 });
    expect(s).toEqual({ mode: 'off', scale: 1, targetMs: 4, minScale: 0.25, maxScale: 1, motion: 'auto', motionScale: 0.25 });
    // a stored pre-step-2 setting (no motion fields) gets the defaults
    expect(sanitizeResolutionScale({ mode: 'fixed', scale: 0.5 })).toMatchObject({ mode: 'fixed', scale: 0.5, motion: 'auto', motionScale: 0.78 });
    expect(sanitizeResolutionScale({ minScale: 0.8, maxScale: 0.5 }).maxScale).toBe(0.8);
    expect(sanitizeResolutionScale(null)).toEqual(DEFAULT_RESOLUTION_SCALE);
  });

  it('fixed mode renders at the set scale and ignores samples', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'fixed', scale: 0.7 });
    expect(rs.scale()).toBe(0.7);
    run(rs, () => 50, 3);
    expect(rs.scale()).toBe(0.7);
    rs.set({ mode: 'off' });
    expect(rs.scale()).toBe(1);
  });
});

describe('camera-motion resolution drop (step 2 C)', () => {
  const S = (motion: 'auto' | 'always' | 'editor' | 'off') => sanitizeResolutionScale({ motion });
  it('always / editor / off', () => {
    expect(motionDropAllowed(S('always'), true, null, 'estimate')).toBe(true);
    expect(motionDropAllowed(S('editor'), false, null, 'estimate')).toBe(true);
    expect(motionDropAllowed(S('editor'), true, 30, 'timestamp')).toBe(false);
    expect(motionDropAllowed(S('off'), false, 30, 'timestamp')).toBe(false);
  });
  it('auto: editor moves always; Play only while the GPU frame is over budget (timestamps), with hysteresis', () => {
    const s = S('auto');   // targetMs 16
    expect(motionDropAllowed(s, false, null, 'estimate')).toBe(true);
    expect(motionDropAllowed(s, true, null, 'timestamp')).toBe(false);     // no measurement yet
    expect(motionDropAllowed(s, true, 12, 'timestamp')).toBe(false);       // under budget: Play stays native
    expect(motionDropAllowed(s, true, 20, 'estimate')).toBe(false);        // CPU estimate can't tell a CPU-bound frame
    expect(motionDropAllowed(s, true, 20, 'timestamp')).toBe(true);        // over budget: drop
    // engaged at 0.78: 9 ms there ≈ 14.8 ms native > 0.85·16 → keep; 7 ms ≈ 11.5 ms native → release
    expect(motionDropAllowed(s, true, 9, 'timestamp', 0.78)).toBe(true);
    expect(motionDropAllowed(s, true, 7, 'timestamp', 0.78)).toBe(false);
  });
  it('changing only the motion fields keeps the mode and the auto controller state', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto', targetMs: 16, minScale: 0.5, maxScale: 1 });
    run(rs, gpu(2, 30), 4);
    const before = rs.scale();
    expect(before).toBeLessThan(1);
    rs.set({ motion: 'editor', motionScale: 0.6 });
    expect(rs.scale()).toBe(before);
    expect(rs.settings).toMatchObject({ mode: 'auto', motion: 'editor', motionScale: 0.6 });
  });
});

describe('auto resolution scaling controller', () => {
  it('a GPU-bound frame drops the scale until the budget is met, then holds still (no oscillation)', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto' });   // target 16, min 0.6
    const cost = gpu(2, 19);    // 21 ms at native (the P6 2.5 K street number); 13.4 ms at 0.75
    const { t, trace } = run(rs, cost, 6);
    const s = rs.scale();
    expect(s).toBeLessThan(1);
    expect(cost(s)).toBeLessThanOrEqual(16);
    expect(s).toBeGreaterThanOrEqual(0.6);
    // settled: the last 3 seconds never change
    const tail = trace.slice(-180);
    expect(new Set(tail).size).toBe(1);
    // on the 0.05 grid
    expect(Math.abs(s / RES_SCALE_STEP - Math.round(s / RES_SCALE_STEP))).toBeLessThan(1e-6);
    // and 20 more seconds at the same load stay put
    run(rs, cost, 20, t);
    expect(rs.scale()).toBe(s);
  });

  it('steps back up once the load drops, and never past maxScale', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto', maxScale: 0.95 });
    let { t } = run(rs, gpu(2, 30), 6);
    const low = rs.scale();
    expect(low).toBeLessThan(0.8);
    t = run(rs, gpu(1, 6), 12, t).t;   // a light scene: plenty of headroom
    expect(rs.scale()).toBe(0.95);
  });

  it('respects minScale even when the budget cannot be met', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto', minScale: 0.7 });
    run(rs, gpu(30, 30), 8);   // 30 ms even at a tiny scale
    expect(rs.scale()).toBe(0.7);
  });

  it('a load right at the band edge does not ping-pong', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto' });
    const cost = gpu(0, 17);   // just over the target at native
    const { trace } = run(rs, cost, 30);
    let changes = 0;
    for (let i = 1; i < trace.length; i++) if (trace[i] !== trace[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(2);
  });

  it('waits for frames at the new scale before judging again, and restarts the average after an idle gap', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto' });
    let t = 0;
    for (let i = 0; i < ResolutionScaler.minSamples - 1; i++) { t += 16; rs.sample(40, t); }
    expect(rs.scale()).toBe(1);   // too few samples yet
    t += 16; rs.sample(40, t);
    expect(rs.scale()).toBeLessThan(1);
    const after = rs.scale();
    t += 16; rs.sample(40, t);
    expect(rs.scale()).toBe(after);   // minSamples + minIntervalMs before the next step
    t += 5000; rs.sample(8, t);       // a long idle gap: the average restarts from this frame
    expect(rs.averageMs).toBe(8);
  });

  it('a one-off spike (a resize, a pipeline compile) does not drop the scale', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto' });
    let t = 0;
    for (let i = 0; i < 120; i++) { t += 16; rs.sample(i === 30 || i === 70 ? 60 : 9, t); }
    expect(rs.scale()).toBe(1);
  });

  it('ignores bad samples', () => {
    const rs = new ResolutionScaler();
    rs.set({ mode: 'auto' });
    expect(rs.sample(NaN, 1)).toBe(false);
    expect(rs.sample(-3, 2)).toBe(false);
    expect(rs.averageMs).toBe(0);
  });
});
