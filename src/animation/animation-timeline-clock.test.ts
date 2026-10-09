/**
 * Playback clock (perf E1): frames come from the rAF timestamp with a half-vsync tolerance, so matched rates advance
 * exactly on schedule under timestamp jitter (no repeated / skipped frames), and loop / ping-pong / none, pause /
 * resume and fps changes keep working.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnimationTimeline } from './animation-timeline';

let pending: ((t: number) => void) | null = null;

beforeEach(() => {
  pending = null;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { pending = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { pending = null; });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `seconds` of vsyncs at `hz` with ±jitterFrac·period uniform timestamp jitter; returns the frame shown after each
 *  vsync (index = vsync number). */
function simulate(tl: AnimationTimeline, hz: number, seconds: number, jitterFrac: number, seed = 1,
  onVsync?: (i: number) => void): number[] {
  const period = 1000 / hz;
  const r = rng(seed);
  const shown: number[] = [];
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    const t = 1000 + i * period + (r() * 2 - 1) * jitterFrac * period;
    const cb = pending;
    pending = null;
    if (cb) cb(t);
    shown.push(tl.getCurrentFrame());
    onVsync?.(i);
  }
  return shown;
}

/** Hold lengths (vsyncs per shown frame) between the first and last frame change, from a looping 1..N timeline. */
function holds(shown: number[]): number[] {
  const out: number[] = [];
  let last = -1;
  let run = 0;
  for (const f of shown) {
    if (f !== last) {
      if (last !== -1) out.push(run);
      last = f;
      run = 1;
    } else run++;
  }
  return out.slice(1);   // drop the first (anchor) hold
}

/** Forward steps between consecutive vsyncs on a looping 1..N timeline (0 = repeat, 1 = advance, 2+ = skip). */
function steps(shown: number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < shown.length; i++) out.push((shown[i] - shown[i - 1] + n) % n);
  return out;
}

function makePlaying(fps: number, frames = 1000): AnimationTimeline {
  const tl = new AnimationTimeline(fps, frames);
  tl.setLoopMode('loop');
  tl.play();
  return tl;
}

describe('playback clock — matched rates under jitter', () => {
  const cases: Array<{ hz: number; fps: number; hold: number }> = [
    { hz: 60, fps: 60, hold: 1 },
    { hz: 60, fps: 30, hold: 2 },
    { hz: 60, fps: 12, hold: 5 },
    { hz: 120, fps: 60, hold: 2 },
    { hz: 120, fps: 30, hold: 4 },
    { hz: 120, fps: 24, hold: 5 },
    { hz: 120, fps: 12, hold: 10 },
    { hz: 59.94, fps: 30, hold: 2 },
    { hz: 59.94, fps: 12, hold: 5 },
  ];
  for (const { hz, fps, hold } of cases) {
    // rAF timestamps are vsync-aligned (sub-ms jitter in practice); ±2–20 % of a vsync is tested. The anchor and the
    // current timestamp together may be off by up to half a vsync at matched rates.
    for (const jitter of [0.02, 0.1, 0.2]) {
      it(`${fps} fps on ${hz} Hz (±${Math.round(jitter * 100)} % jitter): every frame held exactly ${hold} vsync(s)`, () => {
        const tl = makePlaying(fps);
        const secs = 10;
        const shown = simulate(tl, hz, secs, jitter, Math.round(hz * 100 + fps + jitter * 1000));
        const h = holds(shown);
        expect(h.length).toBeGreaterThan(fps * (secs - 1));
        expect(new Set(h)).toEqual(new Set([hold]));
        expect(Math.max(...steps(shown, 1000))).toBe(1);
      });
    }
  }

  it('60 fps on 60 Hz advances exactly once per vsync (no repeats, no skips)', () => {
    const tl = makePlaying(60, 2000);
    const shown = simulate(tl, 60, 20, 0.2, 7);
    const s = steps(shown, 2000).slice(1);   // the anchor vsync shows frame 1 twice by design
    expect(s.every(x => x === 1)).toBe(true);
  });

  it('24 fps on 60 Hz alternates 2 / 3 vsync holds and keeps time', () => {
    const tl = makePlaying(24);
    const shown = simulate(tl, 60, 10, 0.1, 3);
    const h = holds(shown);
    expect(new Set(h)).toEqual(new Set([2, 3]));
    const advanced = steps(shown, 1000).reduce((a, b) => a + b, 0);
    expect(Math.abs(advanced - 240)).toBeLessThanOrEqual(1);
  });

  it('24 fps on 59.94 Hz: holds of 2 / 3 vsyncs only, keeps time', () => {
    const tl = makePlaying(24);
    const shown = simulate(tl, 59.94, 10, 0.05, 5);
    expect(new Set(holds(shown))).toEqual(new Set([2, 3]));
    const advanced = steps(shown, 1000).reduce((a, b) => a + b, 0);
    expect(Math.abs(advanced - 240)).toBeLessThanOrEqual(1);
  });

  for (const hz of [59.94, 60.05]) {
    it(`60 fps on ${hz} Hz locks to the display: one advance per vsync for a whole minute`, () => {
      const tl = makePlaying(60, 100000);
      const shown = simulate(tl, hz, 60, 0.1, 9);
      const s = steps(shown, 100000).slice(1);
      expect(s.every(x => x === 1)).toBe(true);
    });
  }

  it('30 fps on 59.94 Hz holds every frame exactly 2 vsyncs for a whole minute', () => {
    const tl = makePlaying(30, 100000);
    expect(new Set(holds(simulate(tl, 59.94, 60, 0.1, 13)))).toEqual(new Set([2]));
  });

  it('an unmatched rate (59 fps on 60 Hz) keeps real time', () => {
    const tl = makePlaying(59, 100000);
    const shown = simulate(tl, 60, 30, 0.1, 21);
    const advanced = steps(shown, 100000).reduce((a, b) => a + b, 0);
    expect(Math.abs(advanced - 59 * (shown.length - 2) / 60)).toBeLessThanOrEqual(1);
  });

  it('a refresh-rate switch mid-play (60 -> 120 Hz) re-converges and keeps 30 fps', () => {
    const tl = makePlaying(30, 100000);
    simulate(tl, 60, 5, 0.05, 1);
    const f0 = tl.getCurrentFrame();
    // continue on a 120 Hz grid from where the 60 Hz one ended
    const period = 1000 / 120;
    const r = rng(77);
    const t0 = 1000 + 5 * 1000 + 1000 / 60;
    const shown: number[] = [];
    for (let i = 0; i < 120 * 10; i++) {
      const cb = pending; pending = null;
      if (cb) cb(t0 + i * period + (r() * 2 - 1) * 0.05 * period);
      shown.push(tl.getCurrentFrame());
    }
    expect(Math.abs(tl.getCurrentFrame() - f0 - 300)).toBeLessThanOrEqual(2);
    expect(new Set(holds(shown.slice(120 * 3)))).toEqual(new Set([4]));
    expect(Math.abs(tl.getDisplayHzEstimate() - 120)).toBeLessThan(0.5);
  });

  it('estimates the display rate from the rAF deltas', () => {
    const tl = makePlaying(24);
    simulate(tl, 120, 2, 0.2, 11);
    expect(Math.abs(tl.getDisplayHzEstimate() - 120)).toBeLessThan(3);
  });
});

describe('playback clock — modes and controls', () => {
  it('loop wraps to the range start', () => {
    const tl = new AnimationTimeline(60, 5);
    tl.setLoopMode('loop');
    tl.play();
    const shown = simulate(tl, 60, 0.2, 0.1);
    expect(shown.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 1, 2, 3]);
  });

  it('ping-pong bounces', () => {
    const tl = new AnimationTimeline(60, 4);
    tl.setLoopMode('ping-pong');
    tl.play();
    const shown = simulate(tl, 60, 0.2, 0.1);
    expect(shown.slice(0, 9)).toEqual([1, 2, 3, 4, 3, 2, 1, 2, 3]);
  });

  it("'none' stops on the last frame", () => {
    const tl = new AnimationTimeline(60, 4);
    tl.setLoopMode('none');
    tl.play();
    const shown = simulate(tl, 60, 0.2, 0.1);
    expect(shown.slice(0, 7)).toEqual([1, 2, 3, 4, 4, 4, 4]);
    expect(tl.isPlaying()).toBe(false);
  });

  it('pause / resume re-anchors (the frame after resume is held a full frame)', () => {
    const tl = makePlaying(30);
    simulate(tl, 60, 1, 0.1);
    tl.pause();
    const f = tl.getCurrentFrame();
    expect(simulate(tl, 60, 0.5, 0.1).every(x => x === f)).toBe(true);
    tl.play();
    const shown = simulate(tl, 60, 1, 0.1, 4);
    // anchor vsync + 2-vsync holds
    expect(shown[0]).toBe(f);
    expect(shown[1]).toBe(f);
    expect(shown[2]).toBe(f + 1);
    expect(new Set(holds(shown))).toEqual(new Set([2]));
  });

  it('an fps change mid-play takes effect without a jump', () => {
    const tl = makePlaying(12);
    let shown: number[] = [];
    shown = simulate(tl, 60, 4, 0.2, 2, i => { if (i === 120) tl.setFps(30); });
    const s = steps(shown, 1000);
    expect(Math.max(...s)).toBe(1);
    expect(new Set(holds(shown.slice(0, 120)))).toEqual(new Set([5]));
    expect(new Set(holds(shown.slice(130)))).toEqual(new Set([2]));
  });

  it('a scrub while playing continues from the scrubbed frame', () => {
    const tl = makePlaying(60);
    simulate(tl, 60, 0.5, 0.1, 1, i => { if (i === 10) tl.setCurrentFrame(500); });
    expect(tl.getCurrentFrame()).toBeGreaterThan(500);
    expect(tl.getCurrentFrame()).toBeLessThan(530);
  });

  it('a stall advances one frame instead of fast-forwarding', () => {
    const tl = makePlaying(60);
    simulate(tl, 60, 0.2, 0);
    const before = tl.getCurrentFrame();
    const cb = pending!;
    pending = null;
    cb(1000 + 5000);   // 5 s later
    expect(tl.getCurrentFrame()).toBe(before + 1);
  });

  it('several advances in one callback emit one frame-changed', () => {
    const tl = makePlaying(120);
    let events = 0;
    tl.on(e => { if (e.type === 'frame-changed') events++; });
    const shown = simulate(tl, 60, 1, 0.1);
    expect(events).toBeLessThanOrEqual(61);
    const advanced = steps(shown, 1000).reduce((a, b) => a + b, 0);
    expect(Math.abs(advanced - 118)).toBeLessThanOrEqual(2);
  });
});
