/**
 * locomotion — pure walk/idle/run/jump/fall animation selection for Play mode (docs/specs/play-mode.md).
 *
 * The CharacterController reports a LocomotionState each step; `pickLocomotionClip` maps it to a clip NAME, and
 * `LocomotionClipDriver` emits a name only when it CHANGES (so the host re-triggers playback on transitions, not
 * every frame). Kept pure + deterministic so it's unit-testable — the actual clip playback (rig/skeleton) is wired
 * by the host / Scene3DManager via the emitted name.
 */

export interface LocomotionState {
  planarSpeed: number;   // world units / second (horizontal)
  moving: boolean;       // planarSpeed above a tiny epsilon
  grounded: boolean;
  airborne: boolean;
  rising: boolean;       // vertical velocity > 0 (the ascending part of a jump)
  // ── Round 8 extras (optional: a host-fed state without them animates as before) ──
  sneaking?: boolean;    // the sneak gait is active (Ctrl / C)
  airPhase?: number;     // 0 = take-off (rising at jumpSpeed) → 0.5 apex → 1 falling at jumpSpeed or faster
  landImpact?: number;   // impact speed / jumpSpeed on the tick of landing (0 otherwise)
  airTime?: number;      // seconds airborne
  jumped?: boolean;      // this airborne phase started with a jump (not a walk off a ledge)
  jumpWindup?: number;   // item 13: 0→1 progress of a ground jump's crouch before take-off (0 = not winding up)
  jumpHeld?: boolean;    // jump variety: the jump button is still held (a released button = a TAP → the hop variant)
}

/** Clip names the avatar provides. Only `idle` + `walk` are required; the rest fall back sensibly when absent. */
export interface LocomotionClips {
  idle: string;
  walk: string;
  run?: string;
  jump?: string;   // airborne + rising (the engine animator samples it by air phase when the state has one)
  fall?: string;   // airborne + descending (the engine animator: a long fall)
  sneak?: string;  // Round 8, engine animator only: the sneak gait (blended in by the crouch mix)
  crouch?: string; // Round 8, engine animator only: the sneak idle
  land?: string;   // Round 8, engine animator only: an ADDITIVE landing squash, played on touch-down
  /** Jump VARIETY (engine animator only): two or more jump clips; each jump picks one at random (seeded, never the
   *  same one twice running, weighted by standing / walking / running and tap / hold). Fewer than two = `jump` only. */
  jumps?: string[];
  /** Engine animator only: a slow-walk gait blended in BELOW the walk speed (shorter steps, less arm swing), so a
   *  start, a stop or a half-tilted stick doesn't play the full walk in slow motion. */
  stroll?: string;
  /** Engine animator only (2026-10-04): a JOG gait between the walk and the run (walk → jog → run by speed), so a
   *  middling speed plays a light jog instead of a half-walk / half-run mix, and a slow top speed stays a jog. */
  jog?: string;
  /** IDLE VARIETY (engine animator only, 2026-10-04): one-shot standing idles (look around, stretch, check the wrist,
   *  weight shift, adjust glasses …) played now and then over `idle` while the character stands still — seeded, never
   *  the same one twice running, cancelled at once by any movement. Empty / absent = the base idle only. */
  idles?: string[];
}

export interface LocomotionClipConfig {
  /** planarSpeed at/above which the `run` clip is chosen (if provided). Default 2.2 u/s. */
  runThreshold: number;
}

export const DEFAULT_LOCOMOTION_CONFIG: LocomotionClipConfig = { runThreshold: 2.2 };

/**
 * Choose the clip name for a locomotion state. Priority: airborne (jump/fall) → run → walk → idle. Missing optional
 * clips degrade gracefully (no run → walk; no jump/fall → the other, else keep the grounded choice so a jump on a
 * jumpless rig doesn't blank out).
 */
export function pickLocomotionClip(
  s: LocomotionState,
  clips: LocomotionClips,
  cfg: LocomotionClipConfig = DEFAULT_LOCOMOTION_CONFIG,
): string {
  if (s.airborne) {
    if (s.rising) return clips.jump ?? clips.fall ?? groundedClip(s, clips, cfg);
    return clips.fall ?? clips.jump ?? groundedClip(s, clips, cfg);
  }
  return groundedClip(s, clips, cfg);
}

function groundedClip(s: LocomotionState, clips: LocomotionClips, cfg: LocomotionClipConfig): string {
  if (!s.moving) return clips.idle;
  if (clips.run && s.planarSpeed >= cfg.runThreshold) return clips.run;
  return clips.walk;
}

/**
 * Tracks the current clip and returns the new name ONLY when it changes (else null). Feed it each step; call the
 * host's play-clip handler whenever it returns non-null. `reset()` clears the memory (e.g. on Play enter/exit) so the
 * next update always re-emits.
 */
export class LocomotionClipDriver {
  private _current: string | null = null;

  update(s: LocomotionState, clips: LocomotionClips, cfg: LocomotionClipConfig = DEFAULT_LOCOMOTION_CONFIG): string | null {
    const next = pickLocomotionClip(s, clips, cfg);
    if (next === this._current) return null;
    this._current = next;
    return next;
  }

  get current(): string | null { return this._current; }
  reset(): void { this._current = null; }
}

// ── 1D blend tree (continuous grounded locomotion) ──────────────────────────────────────────────
//
// The discrete driver above SWITCHES idle→walk→run at thresholds. A 1D blend tree instead MIXES the two
// clips bracketing the current planarSpeed continuously (idle↔walk↔run), so acceleration reads as a smooth
// gait change rather than a snap. Grounded-only: airborne stays on the discrete jump/fall pick. Pure math
// here (bracket + factor + stop layout); the actual pose sampling/blending is wired by Scene3DManager over
// the NLA sample/blend/write primitives. See animation-library-and-triggers.md §8.

/** Speeds (planarSpeed, world units/sec) at which `walk` / `run` become fully weighted in the blend. */
export interface LocomotionBlendConfig {
  walkSpeed: number;   // planarSpeed at which `walk` is 100% (below this it mixes with idle)
  runSpeed: number;    // planarSpeed at which `run` is 100% (between walkSpeed and this it mixes walk↔run)
}

export const DEFAULT_LOCOMOTION_BLEND: LocomotionBlendConfig = { walkSpeed: 1.2, runSpeed: 3.2 };

/** One node of a 1D blend: a clip fully weighted at `speed`. Stops are kept sorted ascending by speed. */
export interface BlendStop { speed: number; clip: string; }

/** The result of resolving a speed against a 1D blend: mix pose = lerp(sample(a), sample(b), t). a===b when
 *  the speed sits on/beyond an endpoint (single-clip, no blend). */
export interface Blend1DResult { a: string; b: string; t: number; }

/**
 * Resolve `speed` against ascending `stops` into the two bracketing clips + a 0..1 blend factor. Clamps: at or
 * below the first stop returns that clip alone; at or above the last returns that clip alone; otherwise mixes the
 * pair the speed falls between. Empty stops → empty result.
 */
export function resolveBlend1D(stops: BlendStop[], speed: number): Blend1DResult {
  if (stops.length === 0) return { a: '', b: '', t: 0 };
  if (stops.length === 1 || speed <= stops[0].speed) return { a: stops[0].clip, b: stops[0].clip, t: 0 };
  const last = stops[stops.length - 1];
  if (speed >= last.speed) return { a: last.clip, b: last.clip, t: 0 };
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i], hi = stops[i + 1];
    if (speed >= lo.speed && speed <= hi.speed) {
      const span = hi.speed - lo.speed;
      const t = span > 1e-6 ? (speed - lo.speed) / span : 0;
      return { a: lo.clip, b: hi.clip, t };
    }
  }
  return { a: last.clip, b: last.clip, t: 0 };
}

/**
 * Lay out the blend stops for a locomotion clip set: idle@0, walk@walkSpeed, and (if a run clip exists) run@runSpeed.
 * runSpeed is nudged above walkSpeed if the config inverts them, so the stops stay strictly ascending.
 */
export function locomotionBlendStops(clips: LocomotionClips, cfg: LocomotionBlendConfig = DEFAULT_LOCOMOTION_BLEND): BlendStop[] {
  const stops: BlendStop[] = [{ speed: 0, clip: clips.idle }, { speed: Math.max(cfg.walkSpeed, 0.01), clip: clips.walk }];
  if (clips.run) stops.push({ speed: Math.max(cfg.runSpeed, cfg.walkSpeed + 0.01), clip: clips.run });
  return stops;
}
