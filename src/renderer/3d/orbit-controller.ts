/**
 * OrbitController — Mouse/touch orbit camera controller.
 *
 * Orbits around a target point with spherical coordinates.
 * Supports:
 *  - Left-drag: orbit (azimuth + elevation)
 *  - Scroll wheel: dolly (zoom via radius)
 *  - Right-drag / middle-drag: pan (shifts both position and target)
 *
 * Designed to be attached to a canvas and driven by pointer events.
 * Fully self-contained — no dependencies on the 2D renderer.
 */

import { vec3 } from 'gl-matrix';
import { Camera3D } from './camera-3d';

export interface OrbitControllerConfig {
  /** Initial orbit radius (distance from target). */
  radius?: number;
  /** Initial azimuth angle in radians (horizontal rotation). */
  azimuth?: number;
  /** Initial elevation angle in radians (vertical rotation). */
  elevation?: number;
  /** Minimum elevation to prevent flipping through poles. */
  minElevation?: number;
  /** Maximum elevation to prevent flipping through poles. */
  maxElevation?: number;
  /** Minimum orbit radius (closest zoom). */
  minRadius?: number;
  /** Maximum orbit radius (farthest zoom). */
  maxRadius?: number;
  /** Orbit sensitivity (radians per pixel of drag). */
  orbitSpeed?: number;
  /** Pan sensitivity (world units per pixel of drag). */
  panSpeed?: number;
  /** Zoom sensitivity (radius multiplier per scroll step). */
  zoomSpeed?: number;
  /** Enable damping (smooth deceleration). */
  enableDamping?: boolean;
  /** Damping factor (0–1, lower = more damping). */
  dampingFactor?: number;
}

export class OrbitController {
  readonly camera: Camera3D;

  radius: number;
  azimuth: number;
  elevation: number;

  minElevation: number;
  maxElevation: number;
  minRadius: number;
  maxRadius: number;

  orbitSpeed: number;
  panSpeed: number;
  zoomSpeed: number;

  enableDamping: boolean;
  dampingFactor: number;

  enabled = true;

  // Internal state
  private _isDragging = false;
  private _isMiddleDrag = false;
  private _lastX = 0;
  private _lastY = 0;

  // Damping velocities
  private _azimuthVel = 0;
  private _elevationVel = 0;

  // Bound handlers (for cleanup)
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp: (e: PointerEvent) => void;
  private _onWheel: (e: WheelEvent) => void;
  private _canvas: HTMLCanvasElement | null = null;

  constructor(camera: Camera3D, config: OrbitControllerConfig = {}) {
    this.camera = camera;

    this.radius = config.radius ?? 3;
    this.azimuth = config.azimuth ?? 0;
    this.elevation = config.elevation ?? 0.4;

    this.minElevation = config.minElevation ?? -Math.PI / 2 + 0.05;
    this.maxElevation = config.maxElevation ?? Math.PI / 2 - 0.05;
    this.minRadius = config.minRadius ?? 0.1;
    this.maxRadius = config.maxRadius ?? 50;

    this.orbitSpeed = config.orbitSpeed ?? 0.005;
    this.panSpeed = config.panSpeed ?? 0.002;
    this.zoomSpeed = config.zoomSpeed ?? 0.1;

    this.enableDamping = config.enableDamping ?? true;
    this.dampingFactor = config.dampingFactor ?? 0.08;

    // Bind handlers
    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp = this.handlePointerUp.bind(this);
    this._onWheel = this.handleWheel.bind(this);

    // Apply initial orbit position
    this.applySpherical();
  }

  // ── Canvas attachment ──────────────────────────────────────────

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this._canvas = canvas;
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  detach(): void {
    if (!this._canvas) return;
    this._canvas.removeEventListener('pointerdown', this._onPointerDown);
    this._canvas.removeEventListener('pointermove', this._onPointerMove);
    this._canvas.removeEventListener('pointerup', this._onPointerUp);
    this._canvas.removeEventListener('pointerleave', this._onPointerUp);
    this._canvas.removeEventListener('wheel', this._onWheel);
    this._canvas = null;
  }

  // ── Input handlers ─────────────────────────────────────────────

  private handlePointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    // Left button = orbit, middle/right = pan
    if (e.button === 0) {
      this._isDragging = true;
      this._isMiddleDrag = false;
    } else if (e.button === 1 || e.button === 2) {
      this._isDragging = true;
      this._isMiddleDrag = true;
    }
    this._lastX = e.clientX;
    this._lastY = e.clientY;
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.enabled || !this._isDragging) return;
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;

    if (this._isMiddleDrag) {
      this.pan(dx, dy);
    } else {
      this.orbit(dx, dy);
    }
  }

  private handlePointerUp(_e: PointerEvent): void {
    this._isDragging = false;
  }

  private handleWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    this.radius *= (1 + delta * this.zoomSpeed);
    this.radius = Math.max(this.minRadius, Math.min(this.maxRadius, this.radius));
    this.applySpherical();
  }

  // ── Orbit / Pan ────────────────────────────────────────────────

  private orbit(dx: number, dy: number): void {
    if (this.enableDamping) {
      this._azimuthVel -= dx * this.orbitSpeed;
      this._elevationVel += dy * this.orbitSpeed;
    } else {
      this.azimuth -= dx * this.orbitSpeed;
      this.elevation += dy * this.orbitSpeed;
      this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, this.elevation));
      this.applySpherical();
    }
  }

  private pan(dx: number, dy: number): void {
    // Compute camera-local right and up vectors
    const forward = vec3.create();
    vec3.sub(forward, this.camera.target, this.camera.position);
    vec3.normalize(forward, forward);

    const right = vec3.create();
    vec3.cross(right, forward, this.camera.up);
    vec3.normalize(right, right);

    const up = vec3.create();
    vec3.cross(up, right, forward);

    const panScale = this.panSpeed * this.radius; // pan gets faster when zoomed out
    const offset = vec3.create();
    vec3.scaleAndAdd(offset, offset, right, -dx * panScale);
    vec3.scaleAndAdd(offset, offset, up, dy * panScale);

    vec3.add(this.camera.target as vec3, this.camera.target, offset);
    this.applySpherical();
  }

  // ── Update (call once per frame) ──────────────────────────────

  /** Apply damping and update camera position. Call once per frame. Returns true if still animating. */
  update(): boolean {
    if (!this.enableDamping) return false;

    if (Math.abs(this._azimuthVel) > 0.00001 || Math.abs(this._elevationVel) > 0.00001) {
      this.azimuth += this._azimuthVel;
      this.elevation += this._elevationVel;
      this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, this.elevation));

      this._azimuthVel *= (1 - this.dampingFactor);
      this._elevationVel *= (1 - this.dampingFactor);

      this.applySpherical();
      return true;
    }
    return false;
  }

  // ── Spherical → Cartesian ─────────────────────────────────────

  /** Recompute camera position from spherical coords around target. */
  applySpherical(): void {
    const target = this.camera.target;
    const cosEl = Math.cos(this.elevation);
    this.camera.setPosition(
      target[0] + this.radius * cosEl * Math.sin(this.azimuth),
      target[1] + this.radius * Math.sin(this.elevation),
      target[2] + this.radius * cosEl * Math.cos(this.azimuth),
    );
  }

  /** Zero damping velocities without changing the camera position. */
  stopDamping(): void {
    this._azimuthVel   = 0;
    this._elevationVel = 0;
  }

  /** Set azimuth + elevation directly and apply — used by the view gizmo for snapping. */
  setSpherical(azimuth: number, elevation: number): void {
    this.azimuth   = azimuth;
    this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, elevation));
    this._azimuthVel   = 0;
    this._elevationVel = 0;
    this.applySpherical();
  }

  // ── Serialization ──────────────────────────────────────────────

  /**
   * Recompute spherical coords from the camera's current position/target.
   * Call this after externally moving the camera (e.g. frameMesh) so that
   * subsequent orbit/zoom operations start from the new position rather than
   * snapping back to the old spherical state.
   */
  syncFromCamera(): void {
    const dx = this.camera.position[0] - this.camera.target[0];
    const dy = this.camera.position[1] - this.camera.target[1];
    const dz = this.camera.position[2] - this.camera.target[2];
    this.radius    = Math.max(this.minRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    this.elevation = Math.asin(Math.max(-1, Math.min(1, dy / this.radius)));
    this.azimuth   = Math.atan2(dx, dz);
    this._azimuthVel   = 0;
    this._elevationVel = 0;
  }

  toJSON() {
    return {
      radius: this.radius,
      azimuth: this.azimuth,
      elevation: this.elevation,
    };
  }
}
