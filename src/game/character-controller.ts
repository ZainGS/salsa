/**
 * CharacterController — a first/third-person mover for Play mode (docs/specs/play-mode.md, docs/specs/free-camera-and-scene-targets.md L3).
 *
 * Pure kinematic integration (no physics engine): planar WASD-style movement relative to the current yaw, gravity +
 * jump, and mouse-look (yaw + pitch). Collision against the real scene is injected as two optional callbacks so the
 * controller stays deterministic + unit-testable — the scene/camera wiring (and the raycast samplers that back those
 * callbacks) lives in Scene3DManager's Play mode; this file is just the math.
 *
 *  - groundSampler(x, z)      → world height of the ground under (x,z), or null for "no ground here" (fall to cfg.groundY).
 *  - moveResolver(fx,fz,tx,tz,r) → the resolved (x,z) for a horizontal move from (fx,fz) to (tx,tz) for a body of
 *                                 radius r; lets a wall block the into-wall component. Absent = move freely.
 */

import type { LocomotionState } from './locomotion';

export type Vec3 = [number, number, number];

export type CameraMode = 'first' | 'third';

export interface CharacterConfig {
  moveSpeed: number;     // world units / second (planar)
  turnSpeed: number;     // radians / second (yaw from keyboard look input)
  jumpSpeed: number;     // initial upward velocity on jump (units/s)
  gravity: number;       // downward accel (units/s²)
  groundY: number;       // fallback flat ground height when no groundSampler hit (feet rest here)
  eyeHeight: number;     // camera/head offset above the feet position
  radius: number;        // body radius (for horizontal collision)
  stepHeight: number;    // max ground rise the character steps up onto instead of being blocked (curbs/stairs)
  cameraMode: CameraMode;        // first- or third-person framing
  thirdPersonDistance: number;   // camera distance behind the head in third-person
  thirdPersonHeight: number;     // extra height of the orbit pivot above the head in third-person
  cameraCollision: boolean;      // third-person: pull the camera in when a wall is between it and the character
  cameraCollisionPadding: number;// gap kept between the camera and a hit wall
  cameraMinDistance: number;     // third-person: never let the camera get closer than this (avoid clipping the body)
  cameraFollowRate: number;      // third-person camera follow smoothing (1/s; higher = snappier; ≤0 = instant)
  pitchMin: number;      // look-pitch clamp (radians); down
  pitchMax: number;      // look-pitch clamp (radians); up
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  moveSpeed: 3.5, turnSpeed: 2.4, jumpSpeed: 4.5, gravity: 12, groundY: 0, eyeHeight: 1.6,
  radius: 0.35, stepHeight: 0.4, cameraMode: 'first', thirdPersonDistance: 4, thirdPersonHeight: 0.4,
  cameraCollision: true, cameraCollisionPadding: 0.25, cameraMinDistance: 0.5, cameraFollowRate: 14,
  pitchMin: -1.4, pitchMax: 1.4,   // ~±80°
};

/**
 * Per-tick intent (from the host's input layer). forward/right ∈ [-1,1]; `look` = keyboard yaw-rate intent ∈ [-1,1]
 * (scaled by turnSpeed·dt). `lookYaw`/`lookPitch` are DIRECT radian deltas for mouse-look (applied as-is), so a host
 * can drive turning by keyboard (`look`), by mouse (`lookYaw`/`lookPitch`), or both.
 */
export interface CharacterInput {
  forward: number;
  right: number;
  look: number;
  jump: boolean;
  lookYaw?: number;
  lookPitch?: number;
  interact?: boolean;   // "use" key held — the Play loop edge-detects it (fires once per press), not the controller
}
export const NO_INPUT: CharacterInput = { forward: 0, right: 0, look: 0, jump: false };

export class CharacterController {
  cfg: CharacterConfig;
  pos: Vec3;          // FEET position
  vel: Vec3;          // velocity (only .y is integrated as gravity here; planar is direct move)
  yaw: number;        // facing angle (radians), 0 = +Z forward
  pitch: number;      // look pitch (radians), + = up
  grounded: boolean;
  lastPlanarSpeed = 0;   // actual planar distance moved last step / dt (world units/s) — drives walk/run animation

  /** Injected collision (optional; see file header). Set by the host after construction. */
  groundSampler: ((x: number, z: number) => number | null) | null = null;
  moveResolver: ((fromX: number, fromZ: number, toX: number, toZ: number, radius: number) => [number, number]) | null = null;

  constructor(cfg: Partial<CharacterConfig> = {}, start: Vec3 = [0, 0, 0]) {
    this.cfg = { ...DEFAULT_CHARACTER, ...cfg };
    this.pos = [start[0], Math.max(start[1], this.cfg.groundY), start[2]];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = this.pos[1] <= this.cfg.groundY + 1e-4;
  }

  /** Advance one fixed step. */
  update(dt: number, input: CharacterInput = NO_INPUT): void {
    const c = this.cfg;
    // Turn: keyboard rate-turn + direct mouse-look deltas.
    this.yaw += input.look * c.turnSpeed * dt + (input.lookYaw ?? 0);
    this.pitch += (input.lookPitch ?? 0);
    if (this.pitch < c.pitchMin) this.pitch = c.pitchMin;
    if (this.pitch > c.pitchMax) this.pitch = c.pitchMax;

    // Planar move relative to yaw. forward = +Z rotated by yaw; right = +X rotated by yaw.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const fwdX = sin, fwdZ = cos;        // yaw 0 → forward +Z
    const rgtX = cos, rgtZ = -sin;
    let mx = fwdX * input.forward + rgtX * input.right;
    let mz = fwdZ * input.forward + rgtZ * input.right;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1e-6) { mx /= mlen; mz /= mlen; }   // normalize so diagonals aren't faster
    const prevX = this.pos[0], prevZ = this.pos[2];
    const wantX = prevX + mx * c.moveSpeed * dt;
    const wantZ = prevZ + mz * c.moveSpeed * dt;
    // Horizontal collision (optional): a wall can cancel the into-wall component of the move.
    if (this.moveResolver && (wantX !== this.pos[0] || wantZ !== this.pos[2])) {
      const [rx, rz] = this.moveResolver(this.pos[0], this.pos[2], wantX, wantZ, c.radius);
      this.pos[0] = rx; this.pos[2] = rz;
    } else {
      this.pos[0] = wantX; this.pos[2] = wantZ;
    }
    // Actual planar speed (post-collision) — a wall/idle drops it to ~0, driving idle vs walk/run.
    this.lastPlanarSpeed = dt > 0 ? Math.hypot(this.pos[0] - prevX, this.pos[2] - prevZ) / dt : 0;

    // The ground height under the (possibly new) x,z — the sampled scene surface, else the flat fallback.
    const ground = this.groundSampler?.(this.pos[0], this.pos[2]);
    const groundY = (ground === null || ground === undefined) ? c.groundY : ground;

    // Jump + gravity.
    if (input.jump && this.grounded) { this.vel[1] = c.jumpSpeed; this.grounded = false; }
    this.vel[1] -= c.gravity * dt;
    this.pos[1] += this.vel[1] * dt;

    // Ground collision.
    if (this.pos[1] <= groundY) { this.pos[1] = groundY; this.vel[1] = 0; this.grounded = true; }
    else { this.grounded = false; }
  }

  /** Unit forward direction including pitch (points where the camera looks). */
  forwardDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

  /** The head/eye position (feet + eyeHeight). */
  eyePosition(): Vec3 { return [this.pos[0], this.pos[1] + this.cfg.eyeHeight, this.pos[2]]; }

  /** A point 1 unit ahead of the eye along the look direction — the first-person camera look-at target. Includes
   *  pitch, so at pitch 0 this is level (backward-compatible with the pre-mouse-look behaviour). */
  lookTarget(): Vec3 {
    const eye = this.eyePosition();
    const f = this.forwardDir();
    return [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
  }

  /** The actual camera eye for the configured cameraMode. Third-person pulls back behind the head along the look
   *  direction (so pitch orbits the camera vertically around the character). */
  cameraEye(): Vec3 {
    if (this.cfg.cameraMode !== 'third') return this.eyePosition();
    const pivot = this.orbitPivot();
    const f = this.forwardDir();
    const d = this.cfg.thirdPersonDistance;
    return [pivot[0] - f[0] * d, pivot[1] - f[1] * d, pivot[2] - f[2] * d];
  }

  /** The camera look-at target for the configured cameraMode. */
  cameraTarget(): Vec3 {
    if (this.cfg.cameraMode !== 'third') return this.lookTarget();
    return this.orbitPivot();
  }

  /** Third-person orbit pivot: the head raised by thirdPersonHeight. The camera orbits and looks at this point. */
  orbitPivot(): Vec3 {
    return [this.pos[0], this.pos[1] + this.cfg.eyeHeight + this.cfg.thirdPersonHeight, this.pos[2]];
  }

  /** The current locomotion state — feeds walk/idle/run/jump/fall animation selection (see game/locomotion.ts). */
  locomotion(): LocomotionState {
    return {
      planarSpeed: this.lastPlanarSpeed,
      moving: this.lastPlanarSpeed > 1e-3,
      grounded: this.grounded,
      airborne: !this.grounded,
      rising: this.vel[1] > 1e-3,     // moving up = the ascending part of a jump
    };
  }
}
