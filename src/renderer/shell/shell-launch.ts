/**
 * The Shell's cart LAUNCH timeline (docs/specs/frogcart-cd-art-and-launch.md, Part A) — pure, deterministic, no DOM /
 * GPU. A tap on an installed cart's CD plays:
 *
 *   0–90 ms     press dip (scale ×0.94 and back)
 *   0–~850 ms   flick to the front: yaw eases out (easeOutQuart) to the next "facing the user" angle about one turn
 *               ahead, the tilt rises −26° → −6°, the disc grows ×1.35 in its tile
 *   520–1120 ms spin-up about the disc's own axis: ω = ωmax·(t/600)², to 4 rev/s (+ rotational blur as it gets fast)
 *   250–1000 ms dim 0 → 0.88 under the disc (+ the top-right DOM cluster fades with it)
 *   F → F+400   the final fade to the Player's black, F = max(1000, the moment the cart bytes were read + validated) —
 *               the disc keeps spinning while it loads (the flow times out after 10 s)
 *
 * Error / cancel → spinDownPose (550 ms: the spin decays, the disc settles back, the dim lifts). A tap during the
 * launch skips ahead (a short fade as soon as the cart is ready). Reduced motion: no disc motion at all — a 240 ms fade
 * once the cart is ready.
 *
 * Both the renderer (which draws the poses) and the launch flow (which resolves when the screen is black) compute
 * from these functions, so their clocks agree.
 */

/** Every launch timing (ms) / amount, in one place. */
export const LAUNCH = {
  pressMs: 90,
  /** A very subtle dip (the instant dim is the tap's feedback now). */
  /** No press dip (2026-10-09: it felt odd); 1 = off. The instant dim is the tap feedback. */
  pressScale: 1,
  /** A 1.5-turn flick takes this long; every flick starts at the same angular velocity (flickOmega0) and eases out. */
  flickMs: 1200,
  /** The flick's starting angular velocity (rad/ms): easeOutQuart over Δ in T has ω0 = 4Δ/T → 1.5 turns in flickMs.
   *  (2026-10-09: was easeOutCubic in 550 ms — it stopped too abruptly; quart + longer = a long gentle settle.) */
  flickOmega0: (4 * 1.5 * 2 * Math.PI) / 1200,
  /** The flick turns at least this many turns (and less than one more) to the front. */
  flickTurns: 1,
  /** The flick (2026-10-09): CRUISE at this speed (fast quick turns), then SETTLE — ease out (quart, from that
   *  speed to rest) over flickSettleMs. Every flick: the same speed + the same settle; only the cruise varies (to land
   *  on the front). With flickTurns 1 the turn is 1–2 turns. */
  flickCruiseRevPerSec: 4,   // (2026-10-09: fewer, slower turns — 1–2 turns — at about the same timing)
  flickSettleMs: 667,
  /** The settle eases out PAST the front by this much (2026-10-09), then snaps back to face the viewer. */
  flickOvershootDeg: 15,
  /** The snap back is a RUBBER BAND (2026-10-09): an underdamped spring released from the stretched overshoot — it
   *  pulls back with growing speed, swings a few degrees past the front the other way and settles. This long. */
  flickSnapMs: 300,
  /** The spring: damping ratio (lower = bouncier) and natural period. */
  flickSnapZeta: 0.45,
  flickSnapPeriodMs: 187,
  /** The pull-back starts at this fraction of the settle — the overshoot is almost at rest (stretched). */
  flickSnapAt: 0.93,
  /** The disc flies from its viewer / tile to the canvas centre over this long (easeOutQuart: it moves at once and
   *  settles into the centre — an ease-in start looked like a hesitation). */
  /** (unused since 2026-10-09: the flight now lasts exactly as long as the flick — flickDurationMs — so the disc
   *  arrives and faces the user in ONE gesture.) */
  travelMs: 850,
  tiltStartDeg: -26,
  tiltEndDeg: -6,
  /** The flight grows the disc to about this (the renderer clamps it to what fits the canvas). */
  growScale: 1.6,
  /** The spin-up starts this long after the flick ends… */
  spinBeatMs: 20,
  /** The spin-up starts at this fraction of the flick (it overlaps the flick's settle: no frame where the disc is
   *  completely still between the turn and the spin). */
  spinOverlapFrac: 0.97,
  /** The flight to the centre lasts this fraction of the flick: the disc arrives a little BEFORE it finishes facing
   *  the user (2026-10-09). */
  travelFrac: 0.6,
  /** …and reaches full speed at about this (ramp at least spinMinRampMs). */
  spinFullAtMs: 1200,
  spinMinRampMs: 300,
  /** The spin-up ramp (2026-10-09: a fixed ramp; the spin no longer has to fit before a fixed fade). */
  spinRampMs: 500,
  /** Full-speed spin shown before the fade starts. */
  spinHoldMs: 400,
  spinMaxRevPerSec: 4,
  dimStartMs: 0,
  dimEndMs: 300,
  dimMax: 0.7,
  /** The final fade never starts before this, even when the cart was ready at once. */
  minFadeStartMs: 1600,
  fadeMs: 400,
  /** A tap during the launch: the fade starts then (or when the cart is ready) and is this short. */
  skipFadeMs: 200,
  /** Taps this soon after the launching tap don't skip (the 2nd click of a double-click). */
  skipGuardMs: 350,
  /** Reading + validating the cart took longer than this → 'timeout'. */
  timeoutMs: 10_000,
  spinDownMs: 550,
  /** The RETURN from the Player: the disc winds down from full spin at the centre back home this long (easeOut). */
  returnSpinDownMs: 900,
  /** Reduced motion: the whole launch is one fade this long (and the spin-down a fade back this long). */
  reducedFadeMs: 240,
  /** The Shell coming back from the Player fades in from black this long (reduced motion: reducedFadeMs). */
  returnFadeMs: 400,
  /** The Player's background: the launch fades to it and the Shell comes back from it. */
  fadeColor: '#0a0a0a',
} as const;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Where the disc is and how the screen looks at one moment of a launch. Angles in radians. */
export interface LaunchPose {
  /** Yaw of the disc (about the vertical axis; idle whirl angle; a multiple of 2π = facing the user). */
  yaw: number;
  /** Tilt (about the horizontal axis). */
  tilt: number;
  /** Scale of the disc (×1 = idle; grows with the flight to ≈ growScale). */
  scale: number;
  /** The flight from the viewer / tile to the canvas centre, 0..1 (easeOutCubic; back to 0 in a spin-down). */
  travel: number;
  /** Angle about the disc's OWN axis (the "real CD" spin). */
  spin: number;
  /** Spin rate, revolutions per second. */
  spinRate: number;
  /** Rotational blur amount 0..1. */
  blur: number;
  /** Dim scrim under the disc, 0..dimMax. */
  dim: number;
  /** The final fade to black over everything, 0..1. */
  fade: number;
  /** Opacity of the Shell's HTML chrome (the top-right cluster), 1 → 0. */
  chromeOpacity: number;
  /** The screen is fully black (fade complete). */
  black: boolean;
}

/** What a launch's timeline depends on (all times in ms since the launching tap). */
export interface LaunchClock {
  /** The disc's yaw at the tap (its idle whirl angle). */
  yaw0: number;
  /** The disc's tilt at the tap (default −26°). */
  tilt0?: number;
  /** When the cart bytes were read + validated; null = still loading. */
  readyAtMs: number | null;
  /** When a tap skipped ahead; null / omitted = not skipped. */
  skippedAtMs?: number | null;
  reducedMotion?: boolean;
}

export const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const easeOutCubic = (x: number): number => { const u = 1 - clamp01(x); return 1 - u * u * u; };
/** A longer, gentler tail than cubic (the flick + the hover turn settle with it). */
export const easeOutQuart = (x: number): number => { const u = 1 - clamp01(x); return 1 - u * u * u * u; };
export const smoothstep01 = (x: number): number => { const u = clamp01(x); return u * u * (3 - 2 * u); };
export const easeInOutCubic = (x: number): number => { const u = clamp01(x); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };

/** The default idle tilt of a Shell CD, radians. */
export const LAUNCH_TILT0 = LAUNCH.tiltStartDeg * DEG;

/**
 * The yaw the flick ends at: the front-facing angle (`front` + k·2π) at least `turns` turns and less than turns + 1
 * ahead of `yaw0`, in the whirl's (positive) direction — so every flick is a full flourish (1 to 2 turns), never a
 * twitch.
 */
export function frontYawTarget(yaw0: number, turns: number = LAUNCH.flickTurns, front = 0): number {
  return front + TAU * Math.ceil((yaw0 + turns * TAU - front) / TAU);
}

/** The flick's duration for a start yaw: T = 4Δ/ω0 (constant starting angular velocity, easeOutQuart to a stop). */
export function flickDurationMs(yaw0: number): number {
  const d = frontYawTarget(yaw0) - yaw0 + LAUNCH.flickOvershootDeg * DEG;   // the settle ends PAST the front
  const v = (LAUNCH.flickCruiseRevPerSec * TAU) / 1000;           // rad/ms
  const cruise = Math.max(0, (d - (v * LAUNCH.flickSettleMs) / 4) / v);
  return cruise + LAUNCH.flickSettleMs * LAUNCH.flickSnapAt + LAUNCH.flickSnapMs;
}



/** The flick's turn (radians from yaw0) at t ms: cruise at the fast speed, then a quart ease-out to rest exactly on
 *  the front (the speed is continuous where the settle starts). */
export function flickAngle(t: number, yaw0: number): number {
  if (t <= 0) return 0;
  const d = frontYawTarget(yaw0) - yaw0;
  const v = (LAUNCH.flickCruiseRevPerSec * TAU) / 1000;
  const T = flickDurationMs(yaw0);
  const ts = T - LAUNCH.flickSnapMs;                                   // the snap starts here …
  const tc = ts - LAUNCH.flickSettleMs * LAUNCH.flickSnapAt;           // … the cruise ended here
  const settle = (tt: number): number => {                             // the settle (eases toward `over` past the front)
    const u = (tt - tc) / LAUNCH.flickSettleMs;
    return v * tc + ((v * LAUNCH.flickSettleMs) / 4) * (1 - Math.pow(1 - u, 4));
  };
  if (t >= T) return d;
  if (t < tc) return v * t;
  if (t < ts) return settle(t);
  // the rubber band: an underdamped spring about the front, released from the stretched overshoot (+ its tiny drift)
  const x0 = settle(ts) - d;                                                          // the stretch (rad)
  const u0 = v * Math.pow(1 - LAUNCH.flickSnapAt, 3);                                 // the drift (rad/ms)
  const w = (2 * Math.PI) / LAUNCH.flickSnapPeriodMs, z = LAUNCH.flickSnapZeta;
  const wd = w * Math.sqrt(1 - z * z);
  const s = t - ts;
  const B = (u0 + z * w * x0) / wd;
  return d + Math.exp(-z * w * s) * (x0 * Math.cos(wd * s) + B * Math.sin(wd * s));
}

/** When the spin-up starts (the flick's end + a beat) and how long it ramps to full speed. */
export function launchSpinWindow(yaw0: number): { startMs: number; rampMs: number } {
  // the spin starts once the disc has both finished its flick AND reached the centre (+ a short beat)
  const startMs = flickDurationMs(yaw0) * LAUNCH.spinOverlapFrac;   // overlaps the flick's settle (2026-10-09)
  return { startMs, rampMs: LAUNCH.spinRampMs };
}

/** Spin rate (rev/s) at `t` ms after the tap (0 before the spin-up; ωmax·(s/ramp)² during it; ωmax after). */
export function launchSpinRate(t: number, startMs: number, rampMs: number): number {
  const s = t - startMs;
  if (s <= 0) return 0;
  const u = Math.min(1, s / rampMs);
  return LAUNCH.spinMaxRevPerSec * u * u;
}

/** Spin angle (radians) at `t` — the exact integral of launchSpinRate. */
export function launchSpinAngle(t: number, startMs: number, rampMs: number): number {
  const s = t - startMs;
  if (s <= 0) return 0;
  const R = rampMs, w = LAUNCH.spinMaxRevPerSec;
  const revs = s <= R
    ? (w * s * s * s) / (3 * R * R) / 1000
    : ((w * R) / 3 + w * (s - R)) / 1000;
  return revs * TAU;
}

/** Blur follows the spin rate: none until ~30 % of ωmax, full at ωmax. */
export function launchBlur(spinRate: number): number {
  return smoothstep01((spinRate / LAUNCH.spinMaxRevPerSec - 0.3) / 0.7);
}

/** When the final fade starts (ms since the tap) and how long it runs; null while the cart is still loading. */
export function launchFadeWindow(c: LaunchClock): { startMs: number; durationMs: number } | null {
  if (c.readyAtMs == null) return null;
  const ready = Math.max(0, c.readyAtMs);
  if (c.reducedMotion) return { startMs: ready, durationMs: LAUNCH.reducedFadeMs };
  // the fade waits for the spin to reach full speed and run a moment (it may end past 2 s now — 2026-10-09)
  const sw = launchSpinWindow(c.yaw0);
  const unskipped = Math.max(LAUNCH.minFadeStartMs, sw.startMs + sw.rampMs + LAUNCH.spinHoldMs, ready);
  const skip = c.skippedAtMs;
  // A skip only counts before the fade would have started anyway (a tap in the middle of the fade changes nothing).
  if (skip != null && skip < unskipped) return { startMs: Math.max(skip, ready), durationMs: LAUNCH.skipFadeMs };
  return { startMs: unskipped, durationMs: LAUNCH.fadeMs };
}

/** When the screen is fully black (ms since the tap); null while the cart is still loading. */
export function launchBlackAtMs(c: LaunchClock): number | null {
  const w = launchFadeWindow(c);
  return w ? w.startMs + w.durationMs : null;
}

/** The press dip at `t` ms after the tap: ×1 → ×0.94 (mid-way) → ×1 over the first 90 ms, else 1. */
export function launchPressScale(t: number): number {
  return t > 0 && t < LAUNCH.pressMs ? 1 - (1 - LAUNCH.pressScale) * Math.sin((Math.PI * t) / LAUNCH.pressMs) : 1;
}

/** The launch pose `t` ms after the tap. */
export function launchPose(t: number, c: LaunchClock): LaunchPose {
  const tilt0 = c.tilt0 ?? LAUNCH_TILT0;
  const w = launchFadeWindow(c);
  const fade = w ? smoothstep01((t - w.startMs) / w.durationMs) : 0;
  const black = !!w && t >= w.startMs + w.durationMs;
  if (c.reducedMotion) {
    return { yaw: c.yaw0, tilt: tilt0, scale: 1, travel: 0, spin: 0, spinRate: 0, blur: 0, dim: 0, fade, chromeOpacity: 1 - fade, black };
  }
  const flickT = flickDurationMs(c.yaw0);
  const yaw = c.yaw0 + flickAngle(t, c.yaw0);   // cruise fast, then a long settle to the front
  const travel = easeOutQuart(t / (flickDurationMs(c.yaw0) * LAUNCH.travelFrac));   // arrives just before the turn ends
  const tilt = tilt0 + (LAUNCH.tiltEndDeg * DEG - tilt0) * travel;
  const press = launchPressScale(t);
  const scale = (1 + (LAUNCH.growScale - 1) * travel) * press;
  const sw = launchSpinWindow(c.yaw0);
  const spinRate = launchSpinRate(t, sw.startMs, sw.rampMs);
  const dim = LAUNCH.dimMax * smoothstep01((t - LAUNCH.dimStartMs) / (LAUNCH.dimEndMs - LAUNCH.dimStartMs));
  const chromeOpacity = 1 - Math.max(dim / LAUNCH.dimMax, fade);
  return { yaw, tilt, scale, travel, spin: launchSpinAngle(t, sw.startMs, sw.rampMs), spinRate, blur: launchBlur(spinRate), dim, fade, chromeOpacity, black };
}

/** How long a spin-down (error / cancel) runs. */
export function spinDownDurationMs(reducedMotion = false): number {
  return reducedMotion ? LAUNCH.reducedFadeMs : LAUNCH.spinDownMs;
}

/**
 * The pose `t` ms into a spin-down that started from `from` (the launch pose when the error / cancel came): the spin
 * decays to a stop (ω = ω0·(1−u)², angle its integral), the disc settles back to its idle size and tilt, the dim and
 * any started fade lift. `done` once it has settled (then the idle animation takes over again).
 */
export function spinDownPose(t: number, from: LaunchPose, opts: { tilt0?: number; reducedMotion?: boolean; durationMs?: number } = {}): { pose: LaunchPose; done: boolean } {
  const T = opts.durationMs ?? spinDownDurationMs(opts.reducedMotion);
  const u = clamp01(t / T);
  const e = easeOutCubic(u);
  const tilt0 = opts.tilt0 ?? LAUNCH_TILT0;
  const w0 = from.spinRate;
  const left = 1 - u;
  const spinRate = w0 * left * left;
  const spin = from.spin + ((w0 * T) / 3 / 1000) * (1 - left * left * left) * TAU;
  const dim = from.dim * (1 - e);
  const fade = from.fade * (1 - e);
  return {
    pose: {
      yaw: from.yaw,
      tilt: from.tilt + (tilt0 - from.tilt) * e,
      scale: from.scale + (1 - from.scale) * e,
      travel: from.travel * (1 - e),
      spin,
      spinRate,
      blur: launchBlur(spinRate),
      dim,
      fade,
      chromeOpacity: 1 - Math.max(dim / LAUNCH.dimMax, fade),
      black: false,
    },
    done: u >= 1,
  };
}

/** The black cover's opacity `t` ms into the Shell's return from the Player (1 → 0). */
export function returnRevealAlpha(t: number, reducedMotion = false): number {
  return 1 - smoothstep01(t / (reducedMotion ? LAUNCH.reducedFadeMs : LAUNCH.returnFadeMs));
}

// ── The presenter contract (what draws a launch: ShellRenderer — the tapped disc posed in a grown viewport) ──

/** What beginLaunch gets. Times are performance.now() ms. */
export interface ShellLaunchBeginOptions {
  slotId: string;
  startMs: number;
  reducedMotion: boolean;
  /** CSS colour the launch fades to (the Player's black). */
  fadeColor: string;
  /** Call once when the screen is fully black (the fade finished). */
  onBlack: () => void;
  /** Call when a cancelled / failed launch has settled back to the idle Shell. */
  onSettled: () => void;
  /** Called every animation frame with the pose (the host side mirrors chromeOpacity on its HTML chrome). */
  onFrame?: (pose: LaunchPose) => void;
}

/** Whatever draws the launch (ShellRenderer: the disc pose, the dim under it, the final fade, the loop stopping at black). */
export interface ShellLaunchPresenter {
  beginLaunch(opts: ShellLaunchBeginOptions): void;
  /** The cart bytes were read + validated at `nowMs`: the final fade may start (shell-launch.ts launchFadeWindow). */
  markLaunchReady(nowMs: number): void;
  /** A tap during the launch at `nowMs`. */
  skipLaunch(nowMs: number): void;
  /** Error / Esc at `nowMs`: spin down back to the idle Shell (or, after black, fade back in); onSettled when done. */
  cancelLaunch(nowMs: number): void;
  /** True from beginLaunch until a spin-down settled — including while black (the host is opening the Player). */
  readonly launchActive: boolean;
}

/** The viewer prefers reduced motion (prefers-reduced-motion: reduce). False when it can't be asked. */
export function prefersReducedMotion(win: { matchMedia?: (q: string) => { matches: boolean } } | undefined =
  typeof window !== 'undefined' ? window : undefined): boolean {
  try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
