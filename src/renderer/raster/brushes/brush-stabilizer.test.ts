/**
 * BRUSH-4 (docs/specs/mobile-parity.md §3): the moving-average and predictive stabilizers are TIME-based. At exactly
 * 60 Hz they must reproduce the old SAMPLE-based output; at other event rates the lag in milliseconds must stay put
 * (it used to double at 30 fps and halve with 120 Hz coalesced events).
 */
import { describe, it, expect } from 'vitest';
import { BrushStabilizer, REF_FRAME_MS, StabilizedPoint } from './brush-stabilizer';

/** The pre-BRUSH-4 moving average: last level×2 samples, weights 1..N. */
function oldMovingAverage(level: number, pts: StabilizedPoint[]): Array<{ x: number; y: number; p: number }> {
  const N = Math.max(1, Math.round(level * 2));
  const buf: StabilizedPoint[] = [];
  return pts.map(raw => {
    buf.push(raw); if (buf.length > N) buf.shift();
    let tw = 0, sx = 0, sy = 0, sp = 0;
    buf.forEach((q, i) => { const w = i + 1; sx += q.x * w; sy += q.y * w; sp += q.pressure * w; tw += w; });
    return { x: sx / tw, y: sy / tw, p: sp / tw };
  });
}

/** The pre-BRUSH-4 predictive smoother: per-sample alpha. */
function oldPredictive(level: number, pts: StabilizedPoint[]): Array<{ x: number; y: number }> {
  const a = 1 / (1 + level * 1.5);
  let sx = 0, sy = 0, init = false;
  return pts.map(raw => {
    if (!init) { sx = raw.x; sy = raw.y; init = true; return { x: sx, y: sy }; }
    sx += (raw.x - sx) * a; sy += (raw.y - sy) * a;
    return { x: sx, y: sy };
  });
}

/** A wiggly path sampled at `hz` for `ms`, starting at t0 (performance.now-like). */
function path(hz: number, ms: number, t0 = 123456.789): StabilizedPoint[] {
  const out: StabilizedPoint[] = [];
  const n = Math.round(ms * hz / 1000);
  for (let i = 0; i <= n; i++) {
    const t = i * 1000 / hz;
    out.push({ x: t * 0.5 + 10 * Math.sin(t / 40), y: 5 * Math.cos(t / 25), pressure: 0.5 + 0.4 * Math.sin(t / 70), timestamp: t0 + t });
  }
  return out;
}

describe('BRUSH-4 time-based stabilizer', () => {
  it('moving-average at 60 Hz matches the old sample-based window', () => {
    for (const level of [1, 3, 4, 5, 10]) {
      const pts = path(60, 1000);
      const s = new BrushStabilizer({ method: 'moving-average', level });
      const got = pts.map(p => s.push(p));
      const want = oldMovingAverage(level, pts);
      got.forEach((g, i) => {
        expect(g.x).toBeCloseTo(want[i].x, 6);
        expect(g.y).toBeCloseTo(want[i].y, 6);
        expect(g.pressure).toBeCloseTo(want[i].p, 6);
      });
    }
  });

  it('predictive at 60 Hz matches the old per-sample smoothing', () => {
    for (const level of [2, 4, 6]) {
      const pts = path(60, 1000);
      const s = new BrushStabilizer({ method: 'predictive', level });
      const got = pts.map(p => s.push(p));
      const want = oldPredictive(level, pts);
      got.forEach((g, i) => { expect(g.x).toBeCloseTo(want[i].x, 6); expect(g.y).toBeCloseTo(want[i].y, 6); });
    }
  });

  it('the lag in milliseconds is about the same at 30, 60 and 240 Hz (it was ~2x at 30 Hz)', () => {
    const speed = 0.5;   // texels / ms, straight line → lag = speed × the smoother's mean delay
    const line = (hz: number) => {
      const out: StabilizedPoint[] = [];
      for (let i = 0; i <= Math.round(1.5 * hz); i++) { const t = i * 1000 / hz; out.push({ x: t * speed, y: 0, pressure: 1, timestamp: 5000 + t }); }
      return out;
    };
    const lag = (pts: StabilizedPoint[], outs: number[]) => pts[pts.length - 1].x - outs[outs.length - 1];
    for (const method of ['moving-average', 'predictive'] as const) {
      const run = (hz: number) => { const s = new BrushStabilizer({ method, level: 5 }); const pts = line(hz); return lag(pts, pts.map(p => s.push(p).x)); };
      const l60 = run(60), l30 = run(30), l240 = run(240);
      expect(l60).toBeGreaterThan(5);
      expect(Math.abs(l30 - l60)).toBeLessThan(0.35 * l60);
      expect(Math.abs(l240 - l60)).toBeLessThan(0.35 * l60);
      // the old sample-based smoothers lag about twice as far at 30 Hz
      const pts30 = line(30);
      const old30 = method === 'moving-average' ? oldMovingAverage(5, pts30).map(o => o.x) : oldPredictive(5, pts30).map(o => o.x);
      expect(lag(pts30, old30)).toBeGreaterThan(1.7 * l60);
    }
  });

  it('a clock that does not advance still bounds the window', () => {
    const s = new BrushStabilizer({ method: 'moving-average', level: 2 });
    let last = 0;
    for (let i = 0; i < 100; i++) last = s.push({ x: i, y: 0, pressure: 1, timestamp: 5 }).x;
    expect(last).toBeGreaterThan(99 - 4 * 2 * 2);   // at most 4× the 60 Hz sample window averaged
    expect(REF_FRAME_MS).toBeCloseTo(16.667, 2);
  });
});
