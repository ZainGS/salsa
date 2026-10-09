import { describe, it, expect } from 'vitest';
import {
  LAUNCH, LAUNCH_TILT0, frontYawTarget, launchPose, launchSpinRate, launchSpinAngle, launchFadeWindow, launchBlackAtMs,
  spinDownPose, spinDownDurationMs, returnRevealAlpha, prefersReducedMotion, easeOutCubic, smoothstep01, type LaunchClock,
} from './shell-launch';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clock = (o: Partial<LaunchClock> = {}): LaunchClock => ({ yaw0: 0.7, readyAtMs: 120, ...o });

describe('frontYawTarget', () => {
  it('is a front-facing angle between half a turn and one and a half turns ahead, for any start yaw', () => {
    for (let y = -20; y <= 40; y += 0.37) {
      const t = frontYawTarget(y);
      const k = t / TAU;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      expect(t - y).toBeGreaterThanOrEqual(Math.PI - 1e-9);
      expect(t - y).toBeLessThan(3 * Math.PI + 1e-9);
    }
  });

  it('a disc already facing the user still makes one full turn; turns and the front angle are honoured', () => {
    expect(frontYawTarget(0)).toBeCloseTo(TAU);
    expect(frontYawTarget(TAU * 3)).toBeCloseTo(TAU * 4);
    expect(frontYawTarget(0, 2)).toBeCloseTo(2 * TAU);
    const f = 0.5;
    const t = frontYawTarget(1, 1, f);
    expect(((t - f) / TAU) % 1).toBeCloseTo(0);
  });
});

describe('launchPose — the curve', () => {
  it('starts exactly at the idle pose (no jump on the tap)', () => {
    const p = launchPose(0, clock());
    expect(p).toMatchObject({ yaw: 0.7, scale: 1, spin: 0, spinRate: 0, blur: 0, dim: 0, fade: 0, chromeOpacity: 1, black: false });
    expect(p.tilt).toBeCloseTo(LAUNCH_TILT0);
  });

  it('press dip: smaller during the first 90 ms (deepest ×0.94 mid-way, growth included)', () => {
    const mid = launchPose(LAUNCH.pressMs / 2, clock());
    const grow = 1 + (LAUNCH.growScale - 1) * easeOutCubic(LAUNCH.pressMs / 2 / LAUNCH.flickMs);
    expect(mid.scale).toBeCloseTo(grow * LAUNCH.pressScale, 6);
    expect(launchPose(LAUNCH.pressMs, clock()).scale).toBeGreaterThan(1);
  });

  it('flick: yaw eases out monotonically to the front by 500 ms, tilt −26° → −6°, grown ×1.35, then holds', () => {
    const c = clock({ yaw0: 2.1 });
    const target = frontYawTarget(2.1);
    let prev = -Infinity;
    for (let t = 0; t <= LAUNCH.flickMs; t += 10) {
      const y = launchPose(t, c).yaw;
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = y;
    }
    // eases OUT: more than half the turn in the first quarter of the time
    expect((launchPose(125, c).yaw - 2.1) / (target - 2.1)).toBeGreaterThan(0.5);
    for (const t of [LAUNCH.flickMs, 800, 3000]) {
      const p = launchPose(t, c);
      expect(p.yaw).toBeCloseTo(target);
      expect(p.tilt).toBeCloseTo(LAUNCH.tiltEndDeg * DEG);
      expect(p.scale).toBeCloseTo(LAUNCH.growScale);
    }
  });

  it('spin-up: none before 520 ms, ω = ωmax(t/600)² to 4 rev/s, monotonic, angle = its integral', () => {
    expect(launchSpinRate(LAUNCH.spinStartMs)).toBe(0);
    expect(launchSpinRate(LAUNCH.spinStartMs + 300)).toBeCloseTo(LAUNCH.spinMaxRevPerSec * 0.25);
    expect(launchSpinRate(LAUNCH.spinStartMs + LAUNCH.spinRampMs)).toBeCloseTo(LAUNCH.spinMaxRevPerSec);
    expect(launchSpinRate(5000)).toBe(LAUNCH.spinMaxRevPerSec);
    let prevW = 0, prevA = 0;
    for (let t = 0; t <= 2500; t += 5) {
      const w = launchSpinRate(t), a = launchSpinAngle(t);
      expect(w).toBeGreaterThanOrEqual(prevW - 1e-12);
      expect(a).toBeGreaterThanOrEqual(prevA - 1e-12);
      prevW = w; prevA = a;
    }
    // numeric integral of the rate matches the closed form (also past the ramp)
    for (const end of [800, LAUNCH.spinStartMs + LAUNCH.spinRampMs, 1800]) {
      let sum = 0;
      const dt = 0.05;
      for (let t = 0; t < end; t += dt) sum += launchSpinRate(t + dt / 2) * (dt / 1000) * TAU;
      expect(launchSpinAngle(end)).toBeCloseTo(sum, 2);
    }
    // blur follows: none slow, full at full speed
    expect(launchPose(600, clock()).blur).toBe(0);
    expect(launchPose(2000, clock({ readyAtMs: null })).blur).toBeCloseTo(1);
  });

  it('dim 0 → 0.88 between 250 and 1000 ms; the HTML chrome fades with it', () => {
    expect(launchPose(LAUNCH.dimStartMs, clock()).dim).toBe(0);
    const half = launchPose((LAUNCH.dimStartMs + LAUNCH.dimEndMs) / 2, clock());
    expect(half.dim).toBeCloseTo(LAUNCH.dimMax / 2);
    expect(half.chromeOpacity).toBeCloseTo(0.5);
    expect(launchPose(LAUNCH.dimEndMs, clock()).dim).toBeCloseTo(LAUNCH.dimMax);
    expect(launchPose(LAUNCH.dimEndMs, clock()).chromeOpacity).toBeCloseTo(0);
  });
});

describe('launchPose — fade gating', () => {
  it('a cart that is ready at once fades from minFadeStartMs (1600) to black at 2000 ms', () => {
    const c = clock({ readyAtMs: 40 });
    const F = LAUNCH.minFadeStartMs, B = F + LAUNCH.fadeMs;
    expect(F).toBe(1600);
    expect(B).toBe(2000);
    expect(launchFadeWindow(c)).toEqual({ startMs: F, durationMs: LAUNCH.fadeMs });
    expect(launchPose(F - 1, c).fade).toBe(0);
    expect(launchPose(F + LAUNCH.fadeMs / 2, c).fade).toBeCloseTo(0.5);
    expect(launchPose(B - 1, c).black).toBe(false);
    expect(launchPose(B, c)).toMatchObject({ fade: 1, black: true });
    expect(launchBlackAtMs(c)).toBe(B);
    // the disc is at full speed for a while before the fade starts
    expect(launchPose(F - 1, c).spinRate).toBe(LAUNCH.spinMaxRevPerSec);
  });

  it('while loading the disc keeps spinning, never fades and never goes black', () => {
    const c = clock({ readyAtMs: null });
    expect(launchFadeWindow(c)).toBeNull();
    expect(launchBlackAtMs(c)).toBeNull();
    for (const t of [1200, 2000, 9000]) {
      const p = launchPose(t, c);
      expect(p.fade).toBe(0);
      expect(p.black).toBe(false);
      expect(p.spinRate).toBe(LAUNCH.spinMaxRevPerSec);
    }
  });

  it('a slow cart fades from the moment it is ready (F = max(minFadeStartMs, ready))', () => {
    const c = clock({ readyAtMs: 3200 });
    expect(launchFadeWindow(c)).toEqual({ startMs: 3200, durationMs: LAUNCH.fadeMs });
    expect(launchPose(3199, c).fade).toBe(0);
    expect(launchPose(3600, c).black).toBe(true);
  });

  it('the fade never jumps: continuous across the moment the cart becomes ready', () => {
    for (const ready of [10, 900, LAUNCH.minFadeStartMs, 2500]) {
      const before = launchPose(ready - 0.001, clock({ readyAtMs: null }));
      const after = launchPose(ready, clock({ readyAtMs: ready }));
      expect(Math.abs(after.fade - before.fade)).toBeLessThan(1e-6);
    }
  });
});

describe('skip (a tap during the launch)', () => {
  it('fades at once (short fade) when the cart is ready', () => {
    const c = clock({ readyAtMs: 80, skippedAtMs: 400 });
    expect(launchFadeWindow(c)).toEqual({ startMs: 400, durationMs: LAUNCH.skipFadeMs });
    expect(launchBlackAtMs(c)).toBe(600);
    expect(launchPose(399, c).fade).toBe(0);
  });

  it('a skip while loading fades as soon as the cart is ready', () => {
    expect(launchFadeWindow(clock({ readyAtMs: 700, skippedAtMs: 300 }))).toEqual({ startMs: 700, durationMs: LAUNCH.skipFadeMs });
  });

  it('a tap after the fade already started changes nothing', () => {
    const c = clock({ readyAtMs: 50 });
    expect(launchFadeWindow({ ...c, skippedAtMs: LAUNCH.minFadeStartMs + 100 })).toEqual(launchFadeWindow(c));
  });
});

describe('reduced motion', () => {
  it('no disc motion and no dim — one 240 ms fade once the cart is ready', () => {
    const c = clock({ reducedMotion: true, readyAtMs: 60 });
    for (const t of [0, 100, 250, 1000]) {
      const p = launchPose(t, c);
      expect(p).toMatchObject({ yaw: 0.7, scale: 1, spin: 0, spinRate: 0, blur: 0, dim: 0 });
      expect(p.tilt).toBeCloseTo(LAUNCH_TILT0);
    }
    expect(launchFadeWindow(c)).toEqual({ startMs: 60, durationMs: LAUNCH.reducedFadeMs });
    expect(launchPose(60 + LAUNCH.reducedFadeMs / 2, c).fade).toBeCloseTo(0.5);
    expect(launchPose(60 + LAUNCH.reducedFadeMs / 2, c).chromeOpacity).toBeCloseTo(0.5);
    expect(launchBlackAtMs(c)).toBe(60 + LAUNCH.reducedFadeMs);
  });

  it('is read from prefers-reduced-motion (false when it cannot be asked)', () => {
    expect(prefersReducedMotion({ matchMedia: (q) => ({ matches: q.includes('reduce') }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => { throw new Error('x'); } })).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });
});

describe('spinDownPose (error / cancel)', () => {
  const from = launchPose(1500, clock({ readyAtMs: null }));   // full speed, grown, dimmed

  it('decays the spin to a stop over 550 ms (monotonic rate, still advancing angle), settles back and lifts the dim', () => {
    expect(spinDownDurationMs()).toBe(LAUNCH.spinDownMs);
    const start = spinDownPose(0, from).pose;
    expect(start.spinRate).toBeCloseTo(from.spinRate);
    expect(start.spin).toBeCloseTo(from.spin);
    expect(start.scale).toBeCloseTo(from.scale);
    expect(start.dim).toBeCloseTo(from.dim);
    let prevW = Infinity, prevA = -Infinity;
    for (let t = 0; t <= LAUNCH.spinDownMs; t += 10) {
      const { pose } = spinDownPose(t, from);
      expect(pose.spinRate).toBeLessThanOrEqual(prevW + 1e-12);
      expect(pose.spin).toBeGreaterThanOrEqual(prevA - 1e-12);
      prevW = pose.spinRate; prevA = pose.spin;
    }
    const end = spinDownPose(LAUNCH.spinDownMs, from);
    expect(end.done).toBe(true);
    expect(end.pose).toMatchObject({ spinRate: 0, scale: 1, dim: 0, fade: 0, chromeOpacity: 1, black: false, yaw: from.yaw });
    expect(end.pose.tilt).toBeCloseTo(LAUNCH_TILT0);
    expect(spinDownPose(LAUNCH.spinDownMs - 1, from).done).toBe(false);
  });

  it('a started fade lifts too; reduced motion settles in 240 ms', () => {
    const fading = launchPose(LAUNCH.minFadeStartMs + 200, clock({ readyAtMs: 10 }));
    expect(fading.fade).toBeGreaterThan(0);
    expect(spinDownPose(LAUNCH.spinDownMs, fading).pose.fade).toBe(0);
    expect(spinDownDurationMs(true)).toBe(LAUNCH.reducedFadeMs);
    expect(spinDownPose(LAUNCH.reducedFadeMs, fading, { reducedMotion: true }).done).toBe(true);
  });
});

describe('return from the Player', () => {
  it('fades the black cover 1 → 0 (shorter with reduced motion)', () => {
    expect(returnRevealAlpha(0)).toBe(1);
    expect(returnRevealAlpha(LAUNCH.returnFadeMs / 2)).toBeCloseTo(0.5);
    expect(returnRevealAlpha(LAUNCH.returnFadeMs)).toBe(0);
    expect(returnRevealAlpha(LAUNCH.reducedFadeMs, true)).toBe(0);
  });

  it('the fade colour is the Player\'s black', () => {
    expect(LAUNCH.fadeColor).toBe('#0a0a0a');
  });

  it('easing helpers are clamped', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(smoothstep01(0.5)).toBe(0.5);
  });
});
