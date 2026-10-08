/**
 * OrbitController — Mouse/touch orbit camera controller.
 *
 * Orbits around a target point with spherical coordinates.
 * Supports:
 *  - Left-drag: orbit (azimuth + elevation)
 *  - Scroll wheel: dolly (zoom via radius)
 *  - Right-drag / middle-drag: pan (shifts both position and target)
 *  - TOUCH (TOUCH-3, docs/ui/touch-controls.md): fingers are tracked by pointerId (pointerType 'touch' only — the
 *    mouse / pen path is unchanged). Per scheme: classic = 1 finger orbit, 2 fingers pan + pinch dolly;
 *    freeLookNav = 1 finger free-look, 2 fingers pan + pinch dolly-through; altOrbitOnly = 1 finger left to the
 *    tool, 2 fingers orbit + pinch zoom, 3 fingers pan. `touchNavLock` makes 1 finger orbit in every scheme (and 2
 *    fingers pan + pinch). Double-tap → `onDoubleTap` (the host frames the tapped mesh / everything).
 *
 * Designed to be attached to a canvas and driven by pointer events.
 * Fully self-contained — no dependencies on the 2D renderer.
 */

import { vec3 } from 'gl-matrix';
import { Camera3D } from './camera-3d';
import { addZonelessListener, removeZonelessListener } from '../util/zoneless-listeners';
import { isPointerEventClaimed } from '../util/pointer-claims';

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

  // ── Touch (TOUCH-3) ──
  /** "Navigate" lock: when true ONE finger orbits in every scheme (including altOrbitOnly tool modes, where one finger
   *  normally belongs to the tool) and two fingers pan + pinch. Set by the host's Navigate toggle
   *  (sm.setTouchNavigate3D). Mouse input is unaffected. */
  touchNavLock = false;
  /** Fired on a touch DOUBLE-TAP (client coords of the 2nd tap). The host frames the tapped mesh, or everything. */
  onDoubleTap?: (clientX: number, clientY: number) => void;
  /** ORTHOGRAPHIC pinch: a dolly is invisible in ortho, so the host applies the zoom (`ratio` > 1 = fingers apart =
   *  zoom IN) through its own zoom path (decoupled `_meshEditZoom`, or the 2D illustration zoom). Absent = no zoom. */
  onTouchZoom?: (ratio: number, clientX: number, clientY: number) => void;
  /** Optional pan override (CSS-pixel deltas of the finger midpoint): return true when the host applied the pan
   *  itself (an ortho view whose target is pinned to the 2D illustration view), false to let the orbit pan run. */
  onTouchPan?: (dx: number, dy: number) => boolean;
  // ── Edit-view navigation (Edit Mesh / UV editor / Armature; round-3 tablet feedback 2026-10-08) ──
  /** Live host check: an edit view owns this controller. Then a PEN or ONE-FINGER drag that no tool claimed (pointer-
   *  claims: the tool marks the presses it takes — a drag on the selection, a gizmo handle, a paint stroke) ORBITS once
   *  it moves past {@link TOOL_DRAG_SLOP_PX} (a tap stays the tool's); two fingers PAN + pinch zoom (three still pan).
   *  The mouse is unchanged (Alt+left orbit, middle / right pan, wheel). */
  isEditNav?: () => boolean;
  /** Live host check: the host's Pan (hand) tool is on in the edit view — any one-pointer drag (mouse left, pen, one
   *  finger) PANS from the press (the tools ignore the press). */
  isPanTool?: () => boolean;
  /** Pen / finger movement (CSS px) that turns an unclaimed edit-view press into a camera orbit. */
  static TOOL_DRAG_SLOP_PX = 8;
  /** Edit navigation is on (see {@link isEditNav}). */
  get editNavActive(): boolean { return !this.freeLookNav && !!this.isEditNav?.(); }
  private get _panToolOn(): boolean { return this.editNavActive && !!this.isPanTool?.(); }
  /** An edit-view pen / finger press that orbits once it moves past the slop, unless a tool claimed its event. */
  private _navCand: { id: number; x: number; y: number; ev: object; touch: boolean } | null = null;
  /** The pointer of a pen nav drag this controller captured (released on its up). */
  private _navCaptured: number | null = null;

  /** Movement (CSS px) under which a touch still counts as a TAP (double-tap detection). */
  static TAP_SLOP_PX = 10;
  /** Max gap between the two taps of a double-tap (ms) and their max distance (CSS px). */
  static DOUBLE_TAP_MS = 350;
  static DOUBLE_TAP_PX = 40;
  /** True while a multi-finger touch gesture (pan / pinch / two-finger orbit) is running. */
  get isTouchGesturing(): boolean { return this._touchGesture === 'two' || this._touchGesture === 'three'; }
  /** Number of touch pointers currently down on the canvas (tracked even while disabled). */
  get activeTouchCount(): number { return this._touches.size; }
  private _touches = new Map<number, { x: number; y: number }>();
  private _touchGesture: 'none' | 'one' | 'two' | 'three' = 'none';
  private _touchOne: 'orbit' | 'look' | 'pan' | null = null;
  private _touchMidX = 0;
  private _touchMidY = 0;
  private _touchDist = 0;
  private _tap: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
  private _lastTap: { x: number; y: number; t: number } | null = null;
  private _prevTouchAction: string | null = null;

  // Internal state
  private _isDragging = false;
  private _isMiddleDrag = false;
  private _lastX = 0;
  private _lastY = 0;
  /** The pointer that started the current mouse / pen drag — moves from any OTHER pointer are ignored (they used to
   *  share _lastX/_lastY, so a second pointer made the camera jump by the distance between them). */
  private _dragPointerId: number | null = null;

  // Damping velocities
  private _azimuthVel = 0;
  private _elevationVel = 0;

  // Bound handlers (for cleanup)
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp: (e: PointerEvent) => void;
  private _onWheel: (e: WheelEvent) => void;
  private _onPointerCancel: (e: PointerEvent) => void;
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
    this._onPointerCancel = this.handlePointerCancel.bind(this);

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
    // A cancelled pointer (the browser took over the touch, a palm-reject, a system gesture) must end the gesture.
    addZonelessListener(canvas, 'pointercancel', this._onPointerCancel);
    // Touch: the canvas consumes every finger gesture itself (no browser pan / pinch-zoom / pointercancel).
    if (canvas.style) { this._prevTouchAction = canvas.style.touchAction ?? ''; canvas.style.touchAction = 'none'; }
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
    removeZonelessListener(this._canvas, 'pointercancel', this._onPointerCancel);
    if (this._prevTouchAction !== null && this._canvas.style) { this._canvas.style.touchAction = this._prevTouchAction; this._prevTouchAction = null; }
    this._touches.clear(); this._touchGesture = 'none'; this._tap = null;
    this._navCand = null; this._navCaptured = null;
    if (this._onContextMenu) { this._canvas.removeEventListener('contextmenu', this._onContextMenu); this._onContextMenu = undefined; }
    this._canvas = null;
  }

  // ── Input handlers ─────────────────────────────────────────────

  private handlePointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this._touchDown(e); return; }   // fingers: own per-pointer path (TOUCH-3)
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
      this._dragPointerId = e.pointerId ?? null;
      return;
    }
    // Edit views: the Pan tool pans with any left drag; a pen press orbits once it drags past the slop unclaimed.
    if (e.button === 0 && !e.altKey && this.editNavActive) {
      if (this._panToolOn) {
        this._isDragging = true; this._isMiddleDrag = true;
        this._lastX = e.clientX; this._lastY = e.clientY;
        this._dragPointerId = e.pointerId ?? null;
        return;
      }
      if (e.pointerType === 'pen') {
        this._navCand = { id: e.pointerId ?? 0, x: e.clientX, y: e.clientY, ev: e, touch: false };
        return;
      }
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
    if (this._isDragging) this._dragPointerId = e.pointerId ?? null;
  }

  private handlePointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this._touchMove(e); return; }
    const c = this._navCand;
    if (c && !c.touch && (e.pointerId ?? 0) === c.id) {
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) <= OrbitController.TOOL_DRAG_SLOP_PX) return;
      this._navCand = null;
      if (!this.enabled || isPointerEventClaimed(c.ev)) return;   // a tool took the press (it drags)
      // the drag is the camera's: orbit from the PRESS point (the movement so far applies at once)
      this._isDragging = true; this._isMiddleDrag = false;
      this._lastX = c.x; this._lastY = c.y;
      this._dragPointerId = c.id;
      try { this._canvas?.setPointerCapture?.(c.id); this._navCaptured = c.id; } catch { /* pointer already gone */ }
    }
    if (!this.enabled || !this._isDragging) return;
    // Only the pointer that started the drag moves the camera (a second pointer used to share _lastX → a jump).
    if (this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
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

  private handlePointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this._touchUp(e, false); return; }
    if (this._navCand && !this._navCand.touch && (e.pointerId ?? 0) === this._navCand.id) {
      // (a pointerleave of a captured nav drag is not its end)
      if (e.type !== 'pointerleave') this._navCand = null;
      return;
    }
    if (e.type === 'pointerleave' && this._navCaptured !== null && e.pointerId === this._navCaptured) return;
    // A different pointer lifting (e.g. a pen while the mouse drags) doesn't end the drag it didn't start.
    if (this._isDragging && this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
    if (this._navCaptured !== null) {
      try { this._canvas?.releasePointerCapture?.(this._navCaptured); } catch { /* not captured */ }
      this._navCaptured = null;
    }
    if (this._isLookDrag) { this._isLookDrag = false; this.onLookEnd?.(); }   // RMB released → host stops WASD fly
    this._isDragging = false;
    this._dragPointerId = null;
  }

  private handlePointerCancel(e: PointerEvent): void {
    if (e.pointerType === 'touch') { this._touchUp(e, true); return; }
    this.handlePointerUp(e);
  }

  // ── Touch gestures (TOUCH-3) ───────────────────────────────────

  /** One-finger action for the current scheme: classic → orbit, freeLookNav → free-look, altOrbitOnly → none (the
   *  finger belongs to the tool). touchNavLock → orbit everywhere. */
  private _oneFingerAction(): 'orbit' | 'look' | null {
    if (this.touchNavLock) return 'orbit';
    if (this.freeLookNav) return 'look';
    if (this.altOrbitOnly) return null;
    return 'orbit';
  }

  /** Centroid of the active touches (+ the spread between the first two, for the pinch). */
  private _touchCentroid(): { x: number; y: number; dist: number } {
    let x = 0, y = 0, n = 0;
    let a: { x: number; y: number } | null = null, b: { x: number; y: number } | null = null;
    for (const p of this._touches.values()) {
      x += p.x; y += p.y; n++;
      if (!a) a = p; else if (!b) b = p;
    }
    if (n === 0) return { x: 0, y: 0, dist: 0 };
    return { x: x / n, y: y / n, dist: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
  }

  /** (Re)start a multi-finger gesture from the current finger positions — no jump when a finger joins / leaves. */
  private _beginMultiTouch(): void {
    const c = this._touchCentroid();
    this._touchMidX = c.x; this._touchMidY = c.y; this._touchDist = c.dist;
    this._touchGesture = this._touches.size >= 3 ? 'three' : 'two';
    this._touchOne = null;
  }

  private _touchDown(e: PointerEvent): void {
    const id = e.pointerId ?? 0;
    // Tracked even while disabled (a gizmo drag owns the first finger) so a later finger still sees the true count.
    this._touches.set(id, { x: e.clientX, y: e.clientY });
    try { this._canvas?.setPointerCapture?.(id); } catch { /* pointer already gone */ }
    const n = this._touches.size;
    if (n === 1) {
      this._tap = { id, x: e.clientX, y: e.clientY, t: this._now(), moved: false };
      this._navCand = null;
      if (!this.enabled) { this._touchGesture = 'none'; return; }
      if (this.editNavActive && !this.touchNavLock) {
        // Edit views: the Pan tool pans at once; otherwise the finger is the tool's until it drags past the slop
        // unclaimed — then it orbits (_touchMove).
        if (this._panToolOn) { this._touchOne = 'pan'; this._touchGesture = 'one'; return; }
        this._touchOne = null; this._touchGesture = 'none';
        this._navCand = { id, x: e.clientX, y: e.clientY, ev: e, touch: true };
        return;
      }
      this._touchOne = this._oneFingerAction();
      this._touchGesture = this._touchOne ? 'one' : 'none';
      return;
    }
    this._navCand = null;
    this._tap = null;                                     // a 2nd finger: not a tap
    if (!this.enabled) { this._touchGesture = 'none'; return; }
    this._beginMultiTouch();
  }

  private _touchMove(e: PointerEvent): void {
    const id = e.pointerId ?? 0;
    const p = this._touches.get(id);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this._tap && this._tap.id === id && !this._tap.moved
        && Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y) > OrbitController.TAP_SLOP_PX) this._tap.moved = true;
    const nc = this._navCand;
    if (nc && nc.touch && nc.id === id && this._touchGesture === 'none') {
      if (Math.hypot(e.clientX - nc.x, e.clientY - nc.y) <= OrbitController.TOOL_DRAG_SLOP_PX) return;
      this._navCand = null;
      if (!this.enabled || isPointerEventClaimed(nc.ev)) return;   // a tool took the press (it drags)
      this._touchOne = 'orbit'; this._touchGesture = 'one';
      this.orbit(e.clientX - nc.x, e.clientY - nc.y);               // from the PRESS point
      return;
    }
    if (!this.enabled) return;
    if (this._touchGesture === 'one') {
      if (this._touchOne === 'look') this.lookAround(dx, dy);
      else if (this._touchOne === 'orbit') this.orbit(dx, dy);
      else if (this._touchOne === 'pan') this._touchPan(dx, dy);
      return;
    }
    if (this._touchGesture !== 'two' && this._touchGesture !== 'three') return;
    const c = this._touchCentroid();
    const mdx = c.x - this._touchMidX, mdy = c.y - this._touchMidY;
    const prevDist = this._touchDist;
    this._touchMidX = c.x; this._touchMidY = c.y; this._touchDist = c.dist;
    if (this._touchGesture === 'three') { this._touchPan(mdx, mdy); return; }
    // altOrbitOnly (tool modes): two fingers ORBIT (one finger is the tool's); otherwise two fingers PAN. Edit views
    // orbit with one finger off the selection, so there two fingers PAN.
    if (this.altOrbitOnly && !this.touchNavLock && !this.editNavActive) { if (mdx !== 0 || mdy !== 0) this.orbit(mdx, mdy); }
    else this._touchPan(mdx, mdy);
    if (prevDist > 0 && c.dist > 0) this.pinch(c.dist / prevDist, c.x, c.y);
  }

  private _touchUp(e: PointerEvent, cancelled: boolean): void {
    const id = e.pointerId ?? 0;
    if (!this._touches.has(id)) return;                   // pointerleave after pointerup, or never tracked
    this._touches.delete(id);
    if (this._navCand?.id === id) this._navCand = null;
    try { this._canvas?.releasePointerCapture?.(id); } catch { /* not captured */ }
    const tap = this._tap;
    if (tap && tap.id === id) {
      this._tap = null;
      const now = this._now();
      if (!cancelled && !tap.moved && this._touches.size === 0 && this.enabled) {
        const last = this._lastTap;
        if (last && now - last.t <= OrbitController.DOUBLE_TAP_MS
            && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= OrbitController.DOUBLE_TAP_PX) {
          this._lastTap = null;
          this.onDoubleTap?.(e.clientX, e.clientY);
        } else {
          this._lastTap = { x: e.clientX, y: e.clientY, t: now };
        }
      }
    }
    const n = this._touches.size;
    if (n === 0) { this._touchGesture = 'none'; this._touchOne = null; return; }
    // A finger left a 3-finger pan → continue as two fingers; after a multi-finger gesture the LAST finger does
    // nothing until it lifts (no surprise orbit when you end a pinch one finger at a time).
    if (n >= 2 && this.enabled && (this._touchGesture === 'two' || this._touchGesture === 'three')) this._beginMultiTouch();
    else { this._touchGesture = 'none'; this._touchOne = null; }
  }

  private _touchPan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.onTouchPan?.(dx, dy)) return;                 // host applied it (ortho view pinned to the 2D pan)
    this.pan(dx, dy);
  }

  /** One PINCH step: `ratio` = new finger spread / previous (> 1 = apart = zoom IN), around client (cx, cy).
   *  Perspective: a continuous dolly — dolly-through when `dollyThrough` (wheelDollyStep with the pinch as the step
   *  size), else the classic clamped radius / ratio. Orthographic: handed to the host (`onTouchZoom`). Public so
   *  hosts / tests can drive it. */
  pinch(ratio: number, cx = 0, cy = 0): void {
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-4) return;
    if (this.camera.mode === 'orthographic') { this.onTouchZoom?.(ratio, cx, cy); return; }
    // radius / ratio ≙ one wheel step of size (1 − 1/ratio) inward, or (1/ratio − 1) outward.
    if (ratio > 1) this._dollyStep(-1, 1 - 1 / ratio);
    else this._dollyStep(1, 1 / ratio - 1);
  }

  private _now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

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
  dolly(delta: 1 | -1): void { this._dollyStep(delta, this.zoomSpeed); }

  /** {@link dolly} with an explicit step size (the wheel uses zoomSpeed; a pinch its own continuous step). */
  private _dollyStep(delta: 1 | -1, speed: number): void {
    const floor = this.dollyFloor > 0 ? this.dollyFloor : Math.max(this.minRadius, (this.camera.sceneRadius || 10) * 0.05);
    const r = wheelDollyStep(this.radius, delta, speed, this.minRadius, this.maxRadius, this.dollyThrough, floor);
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
