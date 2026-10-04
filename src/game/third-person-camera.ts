/**
 * ThirdPersonCamera — the Play-mode follow camera (R6.2, docs/ui/play-mode.md §Third-person camera).
 *
 * An orbit rig around a smoothed PIVOT (≈ shoulder height above the feet):
 *  - ORBIT is crisp: the eye sits `distance` behind the pivot along the look direction (yaw + pitch straight from the
 *    controller, never smoothed — the mouse / right stick must feel 1:1).
 *  - FOLLOW lags: the pivot trails the character with frame-rate-independent exponential smoothing, horizontally
 *    (cameraFollowRate) and — softer — vertically (cameraVerticalFollowRate), so steps, jumps and stairs don't jolt the
 *    view. The lag is capped (maxLag × distance) so a fast run never loses the character.
 *  - JUMPS (Round 8): while airborne the vertical follow holds near the take-off height (it follows only
 *    `airFollow` of a rise), so a jump reads as the character leaving the frame's ground line instead of the whole view
 *    bobbing; a drop BELOW the take-off height is followed fully (never lose the character off a ledge).
 *  - LOOK-AHEAD: the pivot leads the character by `cameraLookAhead` seconds of planar velocity (itself smoothed), so the
 *    view opens up in the direction of travel.
 *  - COLLISION: a sphere cast approximated by a 5-ray bundle (centre + 4 offsets of `cameraCollisionRadius` around the
 *    view axis) from the pivot toward the eye; the centre ray always counts, the edge rays when two of them agree (a
 *    thin pole / sign one edge ray grazes is ignored). A hit pulls the camera in IMMEDIATELY (never shows the inside
 *    of a wall); when the obstruction clears it eases back out at `cameraRecoverRate` (no pop).
 *
 * Pure math over an injected ray caster (the same RayCaster as collision-math), so it's unit-tested headless.
 */

import type { RayCaster } from './collision-math';
import { clampCameraDistance, expSmooth } from './collision-math';
import type { CharacterConfig, Vec3 } from './character-controller';

export type ThirdPersonCameraConfig = Pick<CharacterConfig,
  'thirdPersonDistance' | 'cameraCollision' | 'cameraCollisionPadding' | 'cameraCollisionRadius' | 'cameraMinDistance' |
  'cameraFollowRate' | 'cameraVerticalFollowRate' | 'cameraLookAhead' | 'cameraRecoverRate' | 'cameraShoulderOffset'>;

export interface ThirdPersonCameraInput {
  /** The un-smoothed pivot this frame (feet + eyeHeight + thirdPersonHeight). */
  pivot: Vec3;
  /** Planar velocity of the character (world units/s) — drives look-ahead. */
  velX: number;
  velZ: number;
  /** Look yaw / pitch (radians, controller convention: forward = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch)). */
  yaw: number;
  pitch: number;
  /** Round 8: the character is in the air (jump / fall). Omitted = grounded (the R6.2 behaviour). */
  airborne?: boolean;
}

/** Standing height (metres) of the reference human the metre camera defaults (DEFAULT_CHARACTER) are tuned for. */
export const REFERENCE_AVATAR_HEIGHT_M = 1.7;

export type AvatarCameraFraming = Pick<CharacterConfig,
  'thirdPersonHeight' | 'thirdPersonDistance' | 'cameraMinDistance' | 'cameraCollisionRadius' | 'cameraCollisionPadding'> & { cameraShoulderOffset: number };

/** Avatar framing ratios (visual-polish #7a, 2026-10-03): a chest-height pivot and a closer follow distance, both × the
 *  avatar height (they were 0.8·H and 2.6·H ≈ 4.4 m, which with the old 72° FOV framed the player at ~1/6 of the frame). */
export const AVATAR_PIVOT_RATIO = 0.76;
export const AVATAR_DISTANCE_RATIO = 1.8;

/**
 * Third-person framing for a bound avatar of measured world height `H` (any size, any scene scale), so the camera
 * frames THIS body: a chest pivot (AVATAR_PIVOT_RATIO·H), a follow distance of AVATAR_DISTANCE_RATIO·H, and the
 * collision min distance / ray-bundle radius / wall padding / shoulder offset scaled from the metre defaults by H / 1.7 m
 * — a 25 m giant gets a proportionally sized rig (the 0.5 m min distance became 0.03 units in a 15 m/unit city: a wall
 * pull-in parked the camera inside its head), a 10 cm doll a proportionally small one. A 1.7-unit avatar outside a city
 * gets exactly the metre defaults. `eyeHeight` is the controller's (the pivot is feet + eyeHeight + thirdPersonHeight).
 */
export function avatarCameraFraming(
  H: number, eyeHeight: number,
  d: Pick<CharacterConfig, 'cameraMinDistance' | 'cameraCollisionRadius' | 'cameraCollisionPadding' | 'cameraShoulderOffset'>,
): AvatarCameraFraming {
  const k = H / REFERENCE_AVATAR_HEIGHT_M;
  const cameraMinDistance = d.cameraMinDistance * k;
  return {
    thirdPersonHeight: H * AVATAR_PIVOT_RATIO - eyeHeight,
    thirdPersonDistance: Math.max(cameraMinDistance, H * AVATAR_DISTANCE_RATIO),
    cameraMinDistance,
    cameraCollisionRadius: d.cameraCollisionRadius * k,
    cameraCollisionPadding: d.cameraCollisionPadding * k,
    cameraShoulderOffset: (d.cameraShoulderOffset ?? 0) * k,
  };
}

/** Lag cap: the smoothed pivot never trails the real one by more than this fraction of the follow distance. */
const MAX_LAG = 0.35;
/** Look-ahead lead cap (fraction of the follow distance). */
const MAX_LEAD = 0.3;
/** Fraction of a jump's rise above the take-off height the camera follows (Round 8). */
const AIR_FOLLOW = 0.35;

export class ThirdPersonCamera {
  private _pivot: Vec3 | null = null;
  private _leadX = 0;
  private _leadZ = 0;
  private _dist = -1;
  /** Current (wall-limited, recovering) shoulder offset; −1 before the first update. */
  private _sh = -1;
  /** Pivot height at the last grounded frame (the jump's take-off level), or null before the first frame. */
  private _groundY: number | null = null;
  /** The last computed eye / target (for tests and the host). */
  eye: Vec3 = [0, 0, 0];
  target: Vec3 = [0, 0, 0];

  /** Forget all smoothing state — the next update snaps (Play enter, avatar swap, teleport). */
  reset(): void { this._pivot = null; this._leadX = 0; this._leadZ = 0; this._dist = -1; this._sh = -1; this._groundY = null; }

  /** Current (collision-limited, recovering) camera distance; −1 before the first update. */
  get distance(): number { return this._dist; }

  update(dt: number, inp: ThirdPersonCameraInput, cfg: ThirdPersonCameraConfig, cast?: RayCaster | null): { eye: Vec3; target: Vec3 } {
    const want = Math.max(cfg.cameraMinDistance, cfg.thirdPersonDistance);
    const first = this._pivot === null;
    dt = Math.max(0, Math.min(dt, 0.1));   // a hitch never flings the camera

    // Look-ahead lead (smoothed so a direction change swings the view, doesn't snap it).
    const leadCap = want * MAX_LEAD;
    let lx = inp.velX * cfg.cameraLookAhead, lz = inp.velZ * cfg.cameraLookAhead;
    const ll = Math.hypot(lx, lz);
    if (ll > leadCap) { lx *= leadCap / ll; lz *= leadCap / ll; }
    if (first) { this._leadX = lx; this._leadZ = lz; }
    else { this._leadX = expSmooth(this._leadX, lx, 4, dt); this._leadZ = expSmooth(this._leadZ, lz, 4, dt); }
    // Vertical goal: the pivot, except that a jump's rise above the take-off level is followed only partly.
    let gy = inp.pivot[1];
    if (!inp.airborne || this._groundY === null) this._groundY = inp.pivot[1];
    else if (gy > this._groundY) gy = this._groundY + (gy - this._groundY) * AIR_FOLLOW;
    const goal: Vec3 = [inp.pivot[0] + this._leadX, gy, inp.pivot[2] + this._leadZ];

    // Pivot follow (horizontal + softer vertical), with a max-lag leash.
    let p: Vec3;
    if (first || !this._pivot) p = [goal[0], goal[1], goal[2]];
    else {
      const q = this._pivot;
      p = [expSmooth(q[0], goal[0], cfg.cameraFollowRate, dt), expSmooth(q[1], goal[1], cfg.cameraVerticalFollowRate, dt), expSmooth(q[2], goal[2], cfg.cameraFollowRate, dt)];
      const lagCap = want * MAX_LAG;
      const ex = p[0] - goal[0], ey = p[1] - goal[1], ez = p[2] - goal[2];
      const lag = Math.hypot(ex, ey, ez);
      if (lag > lagCap) { const k = lagCap / lag; p = [goal[0] + ex * k, goal[1] + ey * k, goal[2] + ez * k]; }
    }
    this._pivot = p;

    // SHOULDER OFFSET (visual-polish #7a): slide the orbit centre to the view's screen-right (right-handed Y-up: forward ×
    // up = (−cos yaw, 0, sin yaw)) so the character sits left of centre. A wall beside the character pulls it in
    // immediately (a ray from the real pivot); it eases back out like the distance. 0 = the centred camera.
    const shWant = Math.max(0, cfg.cameraShoulderOffset ?? 0);
    if (shWant > 0 || this._sh > 0) {
      const sx = -Math.cos(inp.yaw), sz = Math.sin(inp.yaw);
      let shAllowed = shWant;
      if (shWant > 0 && cfg.cameraCollision && cast) {
        const h = cast([p[0], p[1], p[2]], [sx, 0, sz], shWant + cfg.cameraCollisionPadding);
        if (h) shAllowed = Math.max(0, Math.min(shWant, h.distance - cfg.cameraCollisionPadding));
      }
      if (this._sh < 0 || shAllowed <= this._sh) this._sh = shAllowed;
      else this._sh = Math.min(shAllowed, expSmooth(this._sh, shAllowed, cfg.cameraRecoverRate, dt));
      if (this._sh > 0) p = [p[0] + sx * this._sh, p[1], p[2] + sz * this._sh];
    }

    // Orbit direction (crisp) — the camera sits BEHIND the pivot along the look direction.
    const cp = Math.cos(inp.pitch);
    const fx = Math.sin(inp.yaw) * cp, fy = Math.sin(inp.pitch), fz = Math.cos(inp.yaw) * cp;
    const bx = -fx, by = -fy, bz = -fz;   // pivot → eye

    // Collision: the nearest obstruction of a 5-ray bundle toward the eye → the allowed distance.
    let allowed = want;
    if (cfg.cameraCollision && cast) {
      const r = Math.max(0, cfg.cameraCollisionRadius);
      // Two unit vectors perpendicular to the view axis: right = (cos yaw, 0, −sin yaw)·… (horizontal), up = back × right.
      const rx = Math.cos(inp.yaw), rz = -Math.sin(inp.yaw);
      const ux = by * rz - bz * 0, uy = bz * rx - bx * rz, uz = bx * 0 - by * rx;
      const offs: [number, number, number][] = [[0, 0, 0]];
      if (r > 0) offs.push([rx * r, 0, rz * r], [-rx * r, 0, -rz * r], [ux * r, uy * r, uz * r], [-ux * r, -uy * r, -uz * r]);
      // The centre ray always counts; the off-centre rays only when at least TWO agree (the 2nd-nearest of them), so a
      // thin prop that a single edge ray grazes (a signal housing, a lamp post, a sign) doesn't pop the camera in —
      // released games ignore those too — while a wall / corner (two or more rays) still pulls it in.
      let centre = Infinity;
      const side: number[] = [];
      for (let i = 0; i < offs.length; i++) {
        const o = offs[i];
        const h = cast([p[0] + o[0], p[1] + o[1], p[2] + o[2]], [bx, by, bz], want + cfg.cameraCollisionPadding);
        if (!h) continue;
        if (i === 0) centre = h.distance; else side.push(h.distance);
      }
      side.sort((a, b) => a - b);
      const hitDist = Math.min(centre, side.length >= 2 ? side[1] : Infinity);
      allowed = clampCameraDistance(want, hitDist, cfg.cameraCollisionPadding, cfg.cameraMinDistance);
    }
    // Pull in instantly; recover smoothly.
    if (this._dist < 0 || allowed <= this._dist) this._dist = allowed;
    else this._dist = Math.min(allowed, expSmooth(this._dist, allowed, cfg.cameraRecoverRate, dt));

    const d = this._dist;
    this.eye = [p[0] + bx * d, p[1] + by * d, p[2] + bz * d];
    this.target = p;
    return { eye: this.eye, target: this.target };
  }
}
