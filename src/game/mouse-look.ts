/**
 * MouseLook — pointer-lock mouse-look for Play mode (docs/specs/play-mode.md).
 *
 * Accumulates raw pointer movement while the pointer is locked and hands it back as per-tick yaw/pitch radian deltas
 * via consume() (which zeroes the accumulator). Mirrors KeyboardInput's shape: attach/detach wire real DOM listeners;
 * feed() drives it from tests. The controller applies these as input.lookYaw / input.lookPitch.
 *
 * Pointer-lock capture itself needs a user gesture, so attach() locks on the first click of the target element (the
 * standard pattern) and only samples movement while document.pointerLockElement is that element — so mouse motion
 * outside a lock (or after Escape releases it) never turns the character.
 */

export class MouseLook {
  /** Radians of turn per pixel of pointer movement. */
  sensitivity: number;
  /** Invert vertical look (mouse up → look down) when true. */
  invertY: boolean;

  private _yaw = 0;    // accumulated, consumed each tick
  private _pitch = 0;
  private _el: Element | null = null;

  constructor(opts: { sensitivity?: number; invertY?: boolean } = {}) {
    this.sensitivity = opts.sensitivity ?? 0.0025;
    this.invertY = opts.invertY ?? false;
  }

  private readonly _onMove = (e: Event): void => {
    // Only sample while OUR element holds the pointer lock.
    const doc = typeof document !== 'undefined' ? document : null;
    if (this._el && doc && doc.pointerLockElement !== this._el) return;
    const me = e as MouseEvent;
    this.feed(me.movementX || 0, me.movementY || 0);
  };
  private readonly _onClick = (): void => {
    const el = this._el as (Element & { requestPointerLock?: () => void }) | null;
    if (el?.requestPointerLock && typeof document !== 'undefined' && document.pointerLockElement !== el) {
      try { el.requestPointerLock(); } catch { /* no-op if unsupported / not allowed */ }
    }
  };

  /** Attach to a DOM element (usually the canvas). No-op in a headless env. Clicking the element grabs the lock. */
  attach(el?: Element | null): void {
    this.detach();
    if (!el || !el.addEventListener || typeof document === 'undefined') return;
    this._el = el;
    el.addEventListener('click', this._onClick);
    document.addEventListener('mousemove', this._onMove);
  }
  detach(): void {
    const el = this._el;
    if (el?.removeEventListener) el.removeEventListener('click', this._onClick);
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousemove', this._onMove);
      try { if (document.pointerLockElement === el && document.exitPointerLock) document.exitPointerLock(); } catch { /* no-op */ }
    }
    this._el = null;
    this._yaw = 0; this._pitch = 0;
  }

  /** Feed raw pointer movement (pixels). movementX right = turn right; movementY down = look down (unless inverted). */
  feed(dx: number, dy: number): void {
    this._yaw += dx * this.sensitivity;
    this._pitch += (this.invertY ? dy : -dy) * this.sensitivity;
  }

  /** Return the accumulated yaw/pitch deltas since the last call and reset the accumulator. */
  consume(): { yaw: number; pitch: number } {
    const out = { yaw: this._yaw, pitch: this._pitch };
    this._yaw = 0; this._pitch = 0;
    return out;
  }
}
