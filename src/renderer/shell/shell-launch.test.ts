import { describe, it, expect } from 'vitest';
import {
  LAUNCH, LAUNCH_TILT0, frontYawTarget, launchPose, launchSpinRate, launchSpinAngle, launchFadeWindow, launchBlackAtMs,
  spinDownPose, spinDownDurationMs, returnRevealAlpha, prefersReducedMotion, easeOutCubic, smoothstep01, type LaunchClock,
  flickDurationMs, launchSpinWindow,
} from './shell-launch';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clock = (o: Partial<LaunchClock> = {}): LaunchClock => ({ yaw0: 0.7, readyAtMs: 120, ...o });

describe('frontYawTarget — an even flourish', () => {
  it('the flick always turns at least 1 and less than 2 full turns (whirl direction), ending front-facing', () => {
    for (let y = -20; y <= 40; y += 0.37) {
      const t = frontYawTarget(y);
      const k = t / TAU;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      expect(t - y).toBeGreaterThanOrEqual(TAU - 1e-9);
      expect(t - y).toBeLessThan(2 * TAU + 1e-9);
    }
  });

  it('a disc already facing the user makes exactly one turn; turns and the front angle are honoured', () => {
    expect(frontYawTarget(0)).toBeCloseTo(TAU);
    expect(frontYawTarget(TAU * 3)).toBeCloseTo(TAU * 4);
    expect(frontYawTarget(0, 2)).toBeCloseTo(2 * TAU);
    const f = 0.5;
    const t = frontYawTarget(1, 1, f);
    expect(((t - f) / TAU) % 1).toBeCloseTo(0);
  });
});

describe('launchPose — the flick (constant start velocity, easeOutCubic)', () => {
  const yawRate = (c: LaunchClock, t: number) => (launchPose(t + 0.01, c).yaw - launchPose(t, c).yaw) / 0.01;

  it('every flick starts at the same angular velocity ω0, whatever the start yaw', () => {
    for (const yaw0 of [0, 0.7, 2.1, 4.4, 6.2, 31.4]) {
      expect(yawRate(clock({ yaw0 }), 0)).toBeCloseTo(LAUNCH.flickOmega0, 3);
    }
  });

  it('its duration is T = 3Δ/ω0 (1.5 turns ≈ 550 ms, 1–2 turns ≈ 370–730 ms) and it stops front-facing', () => {
    expect(flickDurationMs(0)).toBeCloseTo((3 * TAU) / LAUNCH.flickOmega0);
    expect(flickDurationMs(TAU - Math.PI)).toBeCloseTo(550, 0);   // 1.5 turns
    for (let y = 0; y < TAU; y += 0.31) {
      const T = flickDurationMs(y);
      expect(T).toBeGreaterThanOrEqual(366);
      expect(T).toBeLessThan(734);
      const c = clock({ yaw0: y });
      expect(launchPose(T, c).yaw).toBeCloseTo(frontYawTarget(y));
      expect(Math.abs(yawRate(c, T - 0.02))).toBeLessThan(1e-3);   // ~0 at the end
      // monotonic
      let prev = -Infinity;
      for (let t = 0; t <= T; t += 15) { const v = launchPose(t, c).yaw; expect(v).toBeGreaterThanOrEqual(prev - 1e-12); prev = v; }
    }
  });

  it('the spin-up starts a beat after the flick ends, and is at full speed by ~1.2 s', () => {
    for (const yaw0 of [0, 1.3, 3.9, 6.0]) {
      const sw = launchSpinWindow(yaw0);
      expect(sw.startMs).toBeCloseTo(flickDurationMs(yaw0) + LAUNCH.spinBeatMs);
      const c = clock({ yaw0, readyAtMs: null });
      expect(launchPose(sw.startMs - 1, c).spinRate).toBe(0);
      expect(launchPose(sw.startMs + 50, c).spinRate).toBeGreaterThan(0);
      expect(launchPose(Math.max(LAUNCH.spinFullAtMs, sw.startMs + LAUNCH.spinMinRampMs), c).spinRate).toBeCloseTo(LAUNCH.spinMaxRevPerSec);
    }
  });
});

describe('launchPose — the curve', () => {
  it('starts exactly at the idle pose (no jump on the tap)', () => {
    const p = launchPose(0, clock());
    expect(p).toMatchObject({ yaw: 0.7, scale: 1, travel: 0, spin: 0, spinRate: 0, blur: 0, dim: 0, fade: 0, chromeOpacity: 1, black: false });
    expect(p.tilt).toBeCloseTo(LAUNCH_TILT0);
  });

  it('the flight (travel) eases in-out over 550 ms: tilt −26° → −6°, grown ×1.6, then holds', () => {
    const c = clock({ yaw0: 2.1 });
    expect(launchPose(LAUNCH.travelMs / 2, c).travel).toBeCloseTo(0.5);
    expect(launchPose(LAUNCH.travelMs / 4, c).travel).toBeLessThan(0.25);   // eases in
    for (const t of [LAUNCH.travelMs, 900, 3000]) {
      const p = launchPose(t, c);
      expect(p.travel).toBe(1);
      expect(p.tilt).toBeCloseTo(LAUNCH.tiltEndDeg * DEG);
      expect(p.scale).toBeCloseTo(LAUNCH.growScale);
    }
    // the press is only very subtle now
    expect(LAUNCH.pressScale).toBeGreaterThanOrEqual(0.97);
  });

  it('spin rate: ω = ωmax(s/ramp)², monotonic, angle = its integral', () => {
    const sw = launchSpinWindow(0.7);
    let prevW = 0, prevA = 0;
    for (let t = 0; t <= 2500; t += 5) {
      const w = launchSpinRate(t, sw.startMs, sw.rampMs), a = launchSpinAngle(t, sw.startMs, sw.rampMs);
      expect(w).toBeGreaterThanOrEqual(prevW - 1e-12);
      expect(a).toBeGreaterThanOrEqual(prevA - 1e-12);
      prevW = w; prevA = a;
    }
    for (const end of [900, sw.startMs + sw.rampMs, 1800]) {
      let sum = 0;
      const dt = 0.05;
      for (let t = 0; t < end; t += dt) sum += launchSpinRate(t + dt / 2, sw.startMs, sw.rampMs) * (dt / 1000) * TAU;
      expect(launchSpinAngle(end, sw.startMs, sw.rampMs)).toBeCloseTo(sum, 2);
    }
    expect(launchPose(2000, clock({ readyAtMs: null })).blur).toBeCloseTo(1);
  });

  it('the dim starts at the tap: 0 → 0.88 over 300 ms; the HTML chrome fades with it', () => {
    expect(launchPose(0, clock()).dim).toBe(0);
    const half = launchPose(LAUNCH.dimEndMs / 2, clock());
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
