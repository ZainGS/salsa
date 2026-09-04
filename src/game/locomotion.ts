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
}

/** Clip names the avatar provides. Only `idle` + `walk` are required; the rest fall back sensibly when absent. */
export interface LocomotionClips {
  idle: string;
  walk: string;
  run?: string;
  jump?: string;   // airborne + rising
  fall?: string;   // airborne + descending
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
