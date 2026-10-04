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
import { addZonelessListener, removeZonelessListener } from '../util/zoneless-listeners';

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
  /** When true, orbit only activates on Alt+left-drag. Plain left-drag is ignored. */
  altOrbitOnly?: boolean;
  /** Unity-style editor "flythrough" scheme (free3D + Scene ONLY): LMB is left for selection, RMB-hold = FREE-LOOK
   *  (the camera pivots in place, not around a point) + the host enables WASD fly while held, MMB = pan, Alt+LMB =
   *  orbit, wheel = dolly. When false the classic scheme applies (LMB orbit, MMB/RMB pan) — every other mode. */
  freeLookNav?: boolean;
}

/** Result of one wheel-dolly step: the new orbit radius + how far to PUSH the orbit target forward along the view
 *  (dolly-through). See {@link wheelDollyStep}. */
export interface WheelDollyResult { radius: number; push: number }

/**
 * One wheel-dolly step (T7.1). Classic mode (`dollyThrough` false) = the old behaviour: radius × (1 ± zoomSpeed),
 * clamped to [minRadius, maxRadius] — multiplicative, so each step toward the target covers LESS distance and the
 * zoom asymptotically "slows down" as you approach the pivot (fine for inspecting one object).
 * DOLLY-THROUGH (free 3D / City): the camera advance per step is `max(radius, floor) × zoomSpeed` — multiplicative
 * while far (fast across big distances), CONSTANT once within `floor` of the pivot, where the pivot itself is pushed
 * forward (`push`) so the camera keeps flying at the same rate instead of stalling. The camera never slows down and
 * there's no near limit; the far limit is `maxRadius` (set huge for an effectively unbounded free view).
 */
export function wheelDollyStep(radius: number, delta: 1 | -1, zoomSpeed: number, minRadius: number, maxRadius: number,
    dollyThrough: boolean, floor: number): WheelDollyResult {
    if (delta > 0 || !dollyThrough) {
        const r = radius * (1 + delta * zoomSpeed);
        return { radius: Math.max(minRadius, Math.min(maxRadius, r)), push: 0 };
    }
    const f = Math.max(minRadius, floor);
    const advance = Math.max(radius, f) * zoomSpeed;          // camera travel this step (never shrinks below f × speed)
    const newR = Math.max(f, radius - advance);               // shrink the orbit radius down to the floor…
    const push = advance - (radius - newR);                   // …and carry the rest by moving the pivot forward
    return { radius: Math.min(maxRadius, newR), push: Math.max(0, push) };
}

/** Convert one wheel event into whole dolly steps (+ = out, − = in), accumulating small deltas on `st._wheelAcc`.
 *  deltaMode 1 = lines (×33 px), 2 = pages (×400 px). |delta| < 0.5 px is ignored entirely (jitter / a pure
 *  horizontal scroll), and the accumulator resets when the direction flips. One mouse notch (~100 px) = 1 step; a
 *  single event is capped at 3 steps so a flick doesn't teleport the camera. */
export function wheelSteps(st: { _wheelAcc: number }, deltaY: number, deltaMode = 0): number {
  const px = deltaY * (deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1);
  if (!Number.isFinite(px) || Math.abs(px) < 0.5) return 0;
  if (st._wheelAcc !== 0 && Math.sign(st._wheelAcc) !== Math.sign(px)) st._wheelAcc = 0;
  st._wheelAcc += px;
  const NOTCH = 100;
  let n = Math.trunc(st._wheelAcc / NOTCH);
  // A discrete mouse notch (|px| ≥ ~50 in one event) always gives at least one step, like before.
  if (n === 0 && Math.abs(px) >= 50) n = Math.sign(px);
  n = Math.max(-3, Math.min(3, n));
  st._wheelAcc -= n * NOTCH;
  if (Math.sign(st._wheelAcc) !== Math.sign(px)) st._wheelAcc = 0;   // an overshooting notch doesn't bank a reverse step
  return n;
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
  /** T7.1 DOLLY-THROUGH wheel (free 3D / City): constant-rate zoom that pushes the pivot forward instead of
   *  stalling at it (see {@link wheelDollyStep}). Off = the classic multiplicative, pivot-clamped dolly. */
  dollyThrough = false;
  /** Radius below which a dolly-through step stops shrinking the orbit and pushes the pivot instead. The host sets
   *  it from the framed content (Scene3DManager: 10% of the content radius); 0 = auto (5% of the camera's
   *  `sceneRadius`; ≥ minRadius). */
  dollyFloor = 0;
  altOrbitOnly: boolean;
  /** Unity-style flythrough scheme (free3D + Scene). See OrbitControllerConfig.freeLookNav. */
  freeLookNav: boolean;
  /** Fired when an RMB free-look drag starts / ends (freeLookNav only) — the host uses these to enable WASD fly
   *  ONLY while RMB is held (Unity flythrough), so WASD never flies the camera while typing in a field. */
  onLookStart?: () => void;
  onLookEnd?: () => void;
  /** True while an RMB free-look drag is in progress. */
  get isLookDragging(): boolean { return this._isLookDrag; }
  private _isLookDrag = false;
  private _onContextMenu?: (e: Event) => void;

  /** Called after any INSTANT (non-damped) camera change — wheel dolly, non-damped orbit, pan. The controller is
   *  self-contained (no renderer dependency), so on an on-demand renderer these changes would apply to the camera
   *  but never draw until something else schedules a frame (a stray mouse-move). The host wires this to
   *  scheduleRender. Damped orbit doesn't need it — its per-frame momentum callback already keeps frames flowing. */
  onChange?: () => void;

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
    this.altOrbitOnly = config.altOrbitOnly ?? false;
    this.freeLookNav = config.freeLookNav ?? false;

    // Bind handlers
    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp = this.handlePointerUp.bind(this);
    this._onWheel = this.handleWheel.bind(this);

    // If explicit spherical angles were given, snap to them.
    // Otherwise derive radius/azimuth/elevation from the camera's current position
    // so construction never moves the camera to a default position.
    if (config.radius !== undefined || config.azimuth !== undefined || config.elevation !== undefined) {
      this.applySpherical();
    } else {
      this.syncFromCamera();
    }
  }

  // ── Canvas attachment ──────────────────────────────────────────

  /** The canvas this controller's input listeners are currently bound to (null if detached). Lets the host
   *  self-heal a stale/missing binding — e.g. enableOrbitControls ran on load before the canvas was ready. */
  get attachedCanvas(): HTMLCanvasElement | null { return this._canvas; }

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this._canvas = canvas;
    // Zoneless: orbit drag/zoom must not wake Angular CD on every pointer/wheel event (see zoneless-listeners).
    addZonelessListener(canvas, 'pointerdown', this._onPointerDown);
    addZonelessListener(canvas, 'pointermove', this._onPointerMove);
    addZonelessListener(canvas, 'pointerup', this._onPointerUp);
    addZonelessListener(canvas, 'pointerleave', this._onPointerUp);
    addZonelessListener(canvas, 'wheel', this._onWheel, { passive: false });
    // freeLookNav uses RMB for free-look — swallow the browser context menu so it doesn't pop on right-drag.
    if (this.freeLookNav) {
      this._onContextMenu = (e: Event) => e.preventDefault();
      canvas.addEventListener('contextmenu', this._onContextMenu);
    }
  }

  detach(): void {
    if (!this._canvas) return;
    removeZonelessListener(this._canvas, 'pointerdown', this._onPointerDown);
    removeZonelessListener(this._canvas, 'pointermove', this._onPointerMove);
    removeZonelessListener(this._canvas, 'pointerup', this._onPointerUp);
    removeZonelessListener(this._canvas, 'pointerleave', this._onPointerUp);
    removeZonelessListener(this._canvas, 'wheel', this._onWheel);
    if (this._onContextMenu) { this._canvas.removeEventListener('contextmenu', this._onContextMenu); this._onContextMenu = undefined; }
    this._canvas = null;
  }

  // ── Input handlers ─────────────────────────────────────────────

  private handlePointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    if (this.freeLookNav) {
      // Unity flythrough scheme: LMB = select (no nav), Alt+LMB = orbit, MMB = pan, RMB = free-look (+ WASD via host).
      if (e.button === 0) {
        if (!e.altKey) return;                        // plain LMB → leave it for selection
        this._isDragging = true; this._isMiddleDrag = false; this._isLookDrag = false;   // Alt+LMB orbit
      } else if (e.button === 1) {
        this._isDragging = true; this._isMiddleDrag = true;  this._isLookDrag = false;   // MMB pan
      } else if (e.button === 2) {
        this._isDragging = true; this._isMiddleDrag = false; this._isLookDrag = true;    // RMB free-look
        e.preventDefault();
        this.onLookStart?.();                         // host: enable WASD fly while RMB is held
      } else {
        return;
      }
      this._lastX = e.clientX; this._lastY = e.clientY;
      return;
    }
    // Classic scheme (every other mode): LMB orbit (Alt-gated in altOrbitOnly), MMB/RMB pan.
    if (e.button === 0) {
      if (this.altOrbitOnly && !e.altKey) return;
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

    if (this._isLookDrag) {
      this.lookAround(dx, dy);
    } else if (this._isMiddleDrag) {
      this.pan(dx, dy);
    } else {
      this.orbit(dx, dy);
    }
  }

  private handlePointerUp(_e: PointerEvent): void {
    if (this._isLookDrag) { this._isLookDrag = false; this.onLookEnd?.(); }   // RMB released → host stops WASD fly
    this._isDragging = false;
  }

  /** FREE-LOOK: rotate the camera's look direction IN PLACE (yaw around world-up, pitch around its right axis) —
   *  the position stays put, the target swings. Re-syncs the orbit spherical state so a later Alt+LMB orbit is
   *  consistent. freeLookNav only. */
  private lookAround(dx: number, dy: number): void {
    const cam = this.camera;
    const px = cam.position[0], py = cam.position[1], pz = cam.position[2];
    let fx = cam.target[0] - px, fy = cam.target[1] - py, fz = cam.target[2] - pz;
    const dist = Math.hypot(fx, fy, fz) || 1;
    fx /= dist; fy /= dist; fz /= dist;
    let yaw = Math.atan2(fx, fz);
    let pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    yaw   -= dx * this.orbitSpeed;
    pitch -= dy * this.orbitSpeed;
    const maxPitch = Math.PI / 2 - 0.02;
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
    const cp = Math.cos(pitch);
    const nfx = Math.sin(yaw) * cp, nfy = Math.sin(pitch), nfz = Math.cos(yaw) * cp;
    cam.setTarget(px + nfx * dist, py + nfy * dist, pz + nfz * dist);
    this.syncFromCamera();   // keep radius/azimuth/elevation consistent (position is preserved by this round-trip)
    this.onChange?.();
  }

  private handleWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    // Under an ORTHOGRAPHIC projection a wheel dolly is INVISIBLE (the visible zoom is orthoSize, driven by the
    // app's own canvas zoom) — moving the camera in/out only makes the fog plane, frustum culling, and the
    // detail-LOD distance wander off what's on screen. So NEVER dolly in ortho (any modifier); let the wheel fall
    // through to the app zoom. (This was previously Alt-gated, which just moved the harmful invisible dolly onto
    // Alt+scroll.) In PERSPECTIVE the dolly is real, so keep it — with the altOrbitOnly Alt-gate for Edit-Mesh/City.
    if (this.camera.mode === 'orthographic') return;
    if (this.altOrbitOnly && !e.altKey) return;
    e.preventDefault();
    // ★ Only a real VERTICAL scroll dollies. The old `deltaY > 0 ? 1 : -1` turned every deltaY === 0 event —
    //   horizontal tilt / trackpad sideways jitter / inertial tails, which some devices stream continuously while
    //   the cursor is over the canvas — into a zoom-IN step; with the endless dolly-through (T7.1) that flew the
    //   free-3D camera forward forever. Small trackpad deltas ACCUMULATE into whole steps (one mouse notch ≈ 100).
    const steps = wheelSteps(this, e.deltaY, e.deltaMode);
    for (let i = 0; i < Math.abs(steps); i++) this.dolly(steps > 0 ? 1 : -1);
  }
  /** Accumulated sub-step wheel delta (trackpads send many small deltas); see {@link wheelSteps}. */
  _wheelAcc = 0;

  /** One wheel-dolly step (+1 = out, −1 = in) — the wheel handler's body, public so hosts/tests can drive it. */
  dolly(delta: 1 | -1): void {
    const floor = this.dollyFloor > 0 ? this.dollyFloor : Math.max(this.minRadius, (this.camera.sceneRadius || 10) * 0.05);
    const r = wheelDollyStep(this.radius, delta, this.zoomSpeed, this.minRadius, this.maxRadius, this.dollyThrough, floor);
    if (r.push > 0) {
      // Dolly-through: move the pivot forward along the view ray (the camera follows at the new radius).
      const t = this.camera.target, p = this.camera.position;
      let fx = t[0] - p[0], fy = t[1] - p[1], fz = t[2] - p[2];
      const len = Math.hypot(fx, fy, fz) || 1;
      fx /= len; fy /= len; fz /= len;
      this.camera.setTarget(t[0] + fx * r.push, t[1] + fy * r.push, t[2] + fz * r.push);
    }
    this.radius = r.radius;
    this.applySpherical();
    this.onChange?.();   // wheel dolly has no momentum → must request a frame or the zoom won't draw until a mouse-move
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
      this.onChange?.();
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
    this.onChange?.();
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
