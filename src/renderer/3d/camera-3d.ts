/**
 * Camera3D — Perspective and orthographic camera for 3D rendering.
 *
 * Produces a viewProjection mat4 that can be fed to the renderer as the
 * "world matrix" uniform. When in orthographic mode with default settings,
 * it produces output compatible with the existing 2D pipeline.
 *
 * Fully self-contained — no dependencies on the 2D renderer.
 */

import { mat4, vec3 } from 'gl-matrix';

export type CameraMode = 'perspective' | 'orthographic';

export interface Camera3DConfig {
  position?: [number, number, number];
  target?: [number, number, number];
  up?: [number, number, number];
  fov?: number;           // vertical FOV in radians (perspective only)
  near?: number;
  far?: number;
  orthoSize?: number;     // half-height in world units (orthographic only)
  mode?: CameraMode;
  /** Scale the PERSPECTIVE near plane with camera→target distance (near = dist·0.02, clamped 0.02–0.5).
   *  Perspective depth precision is spent ∝ 1/near — a fixed tiny near (0.01) makes far surfaces z-fight;
   *  an orbit camera never has anything closer than a fraction of its orbit distance, so track it.
   *  Ortho is untouched (linear depth — uniform precision regardless of near). See docs/specs/depth-precision.md. */
  autoNear?: boolean;
  /** Scale the PERSPECTIVE far plane to always enclose the scene: far = distance(camera,target) + sceneRadius·2.
   *  Fixes big-world clipping (a fixed far clips the diagonal sightline at grazing angles) and makes dolly/orbit
   *  never cull the world (the far plane tracks the camera). Set `sceneRadius` from the scene's bounding radius. */
  autoFar?: boolean;
  sceneRadius?: number;
}

export class Camera3D {
  private _position: vec3;
  private _target: vec3;
  private _up: vec3;
  private _fov: number;
  private _near: number;
  private _far: number;
  private _aspect: number = 1;
  private _orthoSize: number;
  private _orthoOffsetX = 0;
  private _orthoOffsetY = 0;
  private _mode: CameraMode;
  private _autoNear: boolean;
  private _autoFar: boolean;
  private _sceneRadius: number;

  // Cached matrices — recomputed on demand
  private _viewDirty = true;
  private _projDirty = true;
  private _viewMatrix: mat4 = mat4.create();
  private _projMatrix: mat4 = mat4.create();
  private _vpMatrix: mat4 = mat4.create();
  private _vpDirty = true;

  constructor(config: Camera3DConfig = {}) {
    this._position = vec3.fromValues(...(config.position ?? [0, 0, 3]));
    this._target = vec3.fromValues(...(config.target ?? [0, 0, 0]));
    this._up = vec3.fromValues(...(config.up ?? [0, 1, 0]));
    this._fov = config.fov ?? (Math.PI / 4);        // 45°
    this._near = config.near ?? 0.01;
    this._far = config.far ?? 100;
    this._orthoSize = config.orthoSize ?? 1;
    this._mode = config.mode ?? 'perspective';
    this._autoNear = config.autoNear ?? false;
    this._autoFar = config.autoFar ?? false;
    this._sceneRadius = config.sceneRadius ?? 0;
  }

  // ── Getters / Setters ──────────────────────────────────────────

  get position(): vec3 { return this._position; }
  set position(v: vec3) { vec3.copy(this._position, v); this.markViewDirty(); }

  get target(): vec3 { return this._target; }
  set target(v: vec3) { vec3.copy(this._target, v); this.markViewDirty(); }

  get up(): vec3 { return this._up; }
  set up(v: vec3) { vec3.copy(this._up, v); this.markViewDirty(); }

  get fov(): number { return this._fov; }
  set fov(v: number) { this._fov = v; this.markProjDirty(); }

  get near(): number { return this._near; }
  set near(v: number) { this._near = v; this.markProjDirty(); }

  get far(): number { return this._far; }
  set far(v: number) { this._far = v; this.markProjDirty(); }

  get autoFar(): boolean { return this._autoFar; }
  set autoFar(v: boolean) { this._autoFar = v; this.markProjDirty(); }

  get sceneRadius(): number { return this._sceneRadius; }
  set sceneRadius(v: number) { this._sceneRadius = v; if (this._autoFar) this.markProjDirty(); }

  /** The far plane actually used this frame (tracks camera distance + scene radius when autoFar is on). */
  get effectiveFar(): number {
    return this._autoFar && this._mode === 'perspective'
      ? vec3.distance(this._position, this._target) + this._sceneRadius * 2 + 1
      : this._far;
  }

  get aspect(): number { return this._aspect; }
  set aspect(v: number) { this._aspect = v; this.markProjDirty(); }

  get orthoSize(): number { return this._orthoSize; }
  set orthoSize(v: number) { this._orthoSize = v; this.markProjDirty(); }

  get orthoOffsetX(): number { return this._orthoOffsetX; }
  set orthoOffsetX(v: number) { this._orthoOffsetX = v; this.markProjDirty(); }

  get orthoOffsetY(): number { return this._orthoOffsetY; }
  set orthoOffsetY(v: number) { this._orthoOffsetY = v; this.markProjDirty(); }

  get mode(): CameraMode { return this._mode; }
  set mode(v: CameraMode) { this._mode = v; this.markProjDirty(); }

  get autoNear(): boolean { return this._autoNear; }
  set autoNear(v: boolean) { this._autoNear = v; this.markProjDirty(); }

  // ── Convenience setters ────────────────────────────────────────

  setPosition(x: number, y: number, z: number): void {
    vec3.set(this._position, x, y, z);
    this.markViewDirty();
  }

  setTarget(x: number, y: number, z: number): void {
    vec3.set(this._target, x, y, z);
    this.markViewDirty();
  }

  lookAt(eyeX: number, eyeY: number, eyeZ: number,
         tgtX: number, tgtY: number, tgtZ: number): void {
    vec3.set(this._position, eyeX, eyeY, eyeZ);
    vec3.set(this._target, tgtX, tgtY, tgtZ);
    this.markViewDirty();
  }

  // ── Matrix computation ─────────────────────────────────────────

  getViewMatrix(): mat4 {
    if (this._viewDirty) {
      mat4.lookAt(this._viewMatrix, this._position, this._target, this._up);
      this._viewDirty = false;
      this._vpDirty = true;
    }
    return this._viewMatrix;
  }

  getProjectionMatrix(): mat4 {
    if (this._projDirty) {
      if (this._mode === 'perspective') {
        // Depth precision is spent ∝ 1/near (hyperbolic 1/z buffer) — with autoNear the near plane tracks
        // the orbit distance (2% of it, clamped), giving ~40× finer far-field depth at typical framing
        // without clipping close-ups. Ortho ignores this (linear depth). docs/specs/depth-precision.md.
        // autoFar (if on) tracks the scene so a big world never clips at grazing angles / when dollying.
        const far = this.effectiveFar;
        const near = this._autoNear
          ? Math.min(Math.max(vec3.distance(this._position, this._target) * 0.02, 0.02), Math.min(0.5, far * 0.5))
          : this._near;
        // perspectiveZO maps depth to [0,1] (WebGPU NDC convention).
        // mat4.perspective maps to [-1,1] (OpenGL) which also works for perspective
        // because the depth warp bunches values near z_ndc=1, but ZO is more correct.
        (mat4 as any).perspectiveZO?.(this._projMatrix, this._fov, this._aspect, near, far)
          ?? mat4.perspective(this._projMatrix, this._fov, this._aspect, near, far);
      } else {
        const hh = this._orthoSize;
        const hw = hh * this._aspect;
        const ox = this._orthoOffsetX;
        const oy = this._orthoOffsetY;
        // orthoZO maps depth to [0,1] (WebGPU NDC convention).
        // mat4.ortho maps to [-1,1]: a mesh 100 units in front gives z_ndc≈-0.8 → clipped by WebGPU.
        // ox/oy shift the frustum in camera space without moving target, enabling armature pan.
        (mat4 as any).orthoZO?.(this._projMatrix, -hw + ox, hw + ox, -hh + oy, hh + oy, this._near, this._far)
          ?? mat4.ortho(this._projMatrix, -hw + ox, hw + ox, -hh + oy, hh + oy, this._near, this._far);
      }
      this._projDirty = false;
      this._vpDirty = true;
    }
    return this._projMatrix;
  }

  getViewProjectionMatrix(): mat4 {
    // Force recompute of view/projection if dirty
    this.getViewMatrix();
    this.getProjectionMatrix();
    if (this._vpDirty) {
      mat4.mul(this._vpMatrix, this._projMatrix, this._viewMatrix);
      this._vpDirty = false;
    }
    return this._vpMatrix;
  }

  // ── Dirty flags ────────────────────────────────────────────────

  private markViewDirty(): void {
    this._viewDirty = true;
    this._vpDirty = true;
    // autoNear/autoFar derive the near/far plane from camera→target distance — a moved camera changes the projection.
    if (this._autoNear || this._autoFar) this._projDirty = true;
  }

  private markProjDirty(): void {
    this._projDirty = true;
    this._vpDirty = true;
  }

  // ── Serialization ──────────────────────────────────────────────

  toJSON() {
    return {
      position: [this._position[0], this._position[1], this._position[2]],
      target: [this._target[0], this._target[1], this._target[2]],
      up: [this._up[0], this._up[1], this._up[2]],
      fov: this._fov,
      near: this._near,
      far: this._far,
      orthoSize: this._orthoSize,
      mode: this._mode,
    };
  }
}
