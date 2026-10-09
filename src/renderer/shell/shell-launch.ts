/**
 * The Shell's cart LAUNCH timeline (docs/specs/frogcart-cd-art-and-launch.md, Part A) — pure, deterministic, no DOM /
 * GPU. A tap on an installed cart's CD plays:
 *
 *   0–90 ms     press dip (scale ×0.94 and back)
 *   0–500 ms    flick to the front: yaw eases out (easeOutCubic) to the next "facing the user" angle about one turn
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
  pressScale: 0.94,
  flickMs: 500,
  /** About this many turns to the front (frontYawTarget picks the nearest front angle 0.5–1.5 turns ahead). */
  flickTurns: 1,
  tiltStartDeg: -26,
  tiltEndDeg: -6,
  growScale: 1.35,
  spinStartMs: 520,
  spinRampMs: 600,
  spinMaxRevPerSec: 4,
  dimStartMs: 250,
  dimEndMs: 1000,
  dimMax: 0.88,
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
  /** Scale of the disc in its tile (×1 = idle). */
  scale: number;
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
export const smoothstep01 = (x: number): number => { const u = clamp01(x); return u * u * (3 - 2 * u); };

/** The default idle tilt of a Shell CD, radians. */
export const LAUNCH_TILT0 = LAUNCH.tiltStartDeg * DEG;

/**
 * The yaw the flick ends at: the front-facing angle (`front` + k·2π) about `turns` turns ahead of `yaw0` — at least
 * (turns − ½) and less than (turns + ½) turns ahead, in the whirl's (positive) direction. So the flick is always a
 * real turn, never a twitch of a few degrees or a near-standstill.
 */
export function frontYawTarget(yaw0: number, turns: number = LAUNCH.flickTurns, front = 0): number {
  const k = Math.ceil((yaw0 - front + (turns - 0.5) * TAU) / TAU);
  return front + k * TAU;
}

/** Spin rate (rev/s) at `t` ms after the tap (0 before the spin-up; ωmax·(s/ramp)² during it; ωmax after). */
export function launchSpinRate(t: number): number {
  const s = t - LAUNCH.spinStartMs;
  if (s <= 0) return 0;
  const u = Math.min(1, s / LAUNCH.spinRampMs);
  return LAUNCH.spinMaxRevPerSec * u * u;
}

/** Spin angle (radians) at `t` — the exact integral of launchSpinRate. */
export function launchSpinAngle(t: number): number {
  const s = t - LAUNCH.spinStartMs;
  if (s <= 0) return 0;
  const R = LAUNCH.spinRampMs, w = LAUNCH.spinMaxRevPerSec;
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
  const unskipped = Math.max(LAUNCH.minFadeStartMs, ready);
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
    return { yaw: c.yaw0, tilt: tilt0, scale: 1, spin: 0, spinRate: 0, blur: 0, dim: 0, fade, chromeOpacity: 1 - fade, black };
  }
  const flick = easeOutCubic(t / LAUNCH.flickMs);
  const yaw = c.yaw0 + (frontYawTarget(c.yaw0) - c.yaw0) * flick;
  const tilt = tilt0 + (LAUNCH.tiltEndDeg * DEG - tilt0) * flick;
  const press = launchPressScale(t);
  const scale = (1 + (LAUNCH.growScale - 1) * flick) * press;
  const spinRate = launchSpinRate(t);
  const dim = LAUNCH.dimMax * smoothstep01((t - LAUNCH.dimStartMs) / (LAUNCH.dimEndMs - LAUNCH.dimStartMs));
  const chromeOpacity = 1 - Math.max(dim / LAUNCH.dimMax, fade);
  return { yaw, tilt, scale, spin: launchSpinAngle(t), spinRate, blur: launchBlur(spinRate), dim, fade, chromeOpacity, black };
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
export function spinDownPose(t: number, from: LaunchPose, opts: { tilt0?: number; reducedMotion?: boolean } = {}): { pose: LaunchPose; done: boolean } {
  const T = spinDownDurationMs(opts.reducedMotion);
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
