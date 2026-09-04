/**
 * FlyController — WASD flythrough for the EDITOR free3D camera (docs/specs/free-camera-and-scene-targets.md).
 *
 * Distinct from Play mode's CharacterController: this flies the EDIT camera (no gravity/ground). W/S fly along the
 * look direction, A/D strafe, E/Space up, Q down, Shift = boost. You AIM by orbit-dragging (the orbit controller
 * still owns rotation); this just TRANSLATES. Both the camera position and its target move by the same vector so
 * the look direction is preserved. The step math is a pure, unit-tested function; the class wires input + a loop
 * that runs ONLY while a move key is held (no idle rAF in the editor).
 */

import type { Vec3 } from './character-controller';
import { GameLoop } from './game-loop';
import { KeyboardInput } from './keyboard-input';

export interface FlyInput { forward: number; right: number; up: number; }

/**
 * One fly step. Moves `pos` and `tgt` together by (lookForward·forward + horizontalRight·right + worldUp·up)·speed·dt.
 * forward = the full look direction (so W flies toward where you look, including pitch); right = horizontal only
 * (independent of pitch); up = world +Y. Returns fresh vectors (does not mutate the inputs).
 */
export function flyMove(pos: Vec3, tgt: Vec3, input: FlyInput, speed: number, dt: number): { pos: Vec3; tgt: Vec3 } {
  let fx = tgt[0] - pos[0], fy = tgt[1] - pos[1], fz = tgt[2] - pos[2];
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  // right = normalize(cross(forward, worldUp(0,1,0))) = normalize(-fz, 0, fx) — horizontal, pitch-independent
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const mx = fx * input.forward + rx * input.right;
  const my = fy * input.forward + input.up;
  const mz = fz * input.forward + rz * input.right;
  const d = speed * dt;
  return {
    pos: [pos[0] + mx * d, pos[1] + my * d, pos[2] + mz * d],
    tgt: [tgt[0] + mx * d, tgt[1] + my * d, tgt[2] + mz * d],
  };
}

/** The camera the FlyController drives (Scene3DManager adapts its Camera3D + orbit sync to this). */
export interface FlyCameraAdapter {
  getPose(): { pos: Vec3; tgt: Vec3 };
  setPose(pos: Vec3, tgt: Vec3): void;      // should also re-sync the orbit controller + request a render
}

export interface FlyOptions { speed?: number; boostMultiplier?: number; step?: number; }

export class FlyController {
  private readonly cam: FlyCameraAdapter;
  private readonly kb = new KeyboardInput();
  private readonly loop: GameLoop;
  private readonly speed: number;
  private readonly boost: number;
  private _enabled = false;

  constructor(cam: FlyCameraAdapter, opts: FlyOptions = {}) {
    this.cam = cam;
    this.speed = opts.speed ?? 6;
    this.boost = opts.boostMultiplier ?? 3.5;
    this.loop = new GameLoop({ step: opts.step ?? 1 / 60 });
    this.kb.onChange = () => this._pump();
  }

  get isEnabled(): boolean { return this._enabled; }

  /** Turn fly on (free3D edit mode). Attaches keys; the loop starts on the first move key. */
  enable(target?: EventTarget): void {
    if (this._enabled) return;
    this._enabled = true;
    this.kb.attach(target);
  }

  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;
    this.loop.stop();
    this.kb.detach();
  }

  /** Start the loop when a move key goes down (and we're enabled); the loop self-stops when keys release. */
  private _pump(): void {
    if (this._enabled && this.kb.anyMoveHeld() && !this.loop.isRunning) {
      this.loop.start((dt) => this._tick(dt));
    }
  }

  private _tick(dt: number): void {
    if (!this.kb.anyMoveHeld()) { this.loop.stop(); return; }   // idle → stop (no wasted frames)
    const input = this.kb.readFly();
    const spd = this.speed * (this.kb.isHeld('ShiftLeft') || this.kb.isHeld('ShiftRight') ? this.boost : 1);
    const { pos, tgt } = this.cam.getPose();
    const moved = flyMove(pos, tgt, input, spd, dt);
    this.cam.setPose(moved.pos, moved.tgt);
  }
}
