/**
 * ArmaturePointerGesture — the armature overlay's pointer state machine (mobile-parity TOUCH-9), DOM-free so it is
 * unit tested. Scene3DArmature feeds it the canvas pointer events and supplies the armature work as handlers (pick a
 * joint / gizmo axis / IK handle, start / move / end / cancel the drag, place a bone, hover).
 *
 *  - MOUSE / PEN: as before — the press PICKS what is under it (pick-on-down; it used to read the mousemove hover
 *    index, which a finger never sets) and the drag starts at once. Bone placement acts on the press.
 *    Hover (no button) is coalesced to ONE pick per animation frame.
 *  - TOUCH: the press picks at once (fatter hit radii — the host's `pick(…, touch)`), but the drag only STARTS after
 *    ~1 frame or {@link TOUCH_START_PX} of movement, from the press point. A second finger landing before that leaves
 *    nothing behind. Bone placement acts on a TAP (release within {@link TAP_SLOP_PX}). A finger has no hover.
 *  - A SECOND finger CANCELS a live drag (the host restores the pose exactly — no undo entry) and nothing else starts
 *    until every finger has lifted ('blocked'); the fingers belong to the orbit controller's pinch / two-finger orbit.
 *    Finger presses are never stopped (the orbit controller must see every finger) — the host claims them instead.
 *  - pointercancel cancels (restores); lostpointercapture / a move with no button held end the drag — it can never
 *    stay stuck.
 */

/** A client rect (the canvas' getBoundingClientRect). */
export type ArmClientRect = { left: number; top: number; width: number; height: number };

/** What the gesture needs from its canvas. */
export interface ArmGestureIO {
  measure(): ArmClientRect;
  capture(pointerId: number): void;
  release(pointerId: number): void;
  /** requestAnimationFrame / cancelAnimationFrame (the touch first-move delay + the hover coalescing). */
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}

/** The armature work, supplied by the host. Coordinates are CLIENT (CSS) px + the rect read at the press. */
export interface ArmGestureHandlers<T> {
  /** What a press here would grab (null = a miss: the press is let through). `touch` = a finger. */
  pick(clientX: number, clientY: number, rect: ArmClientRect, touch: boolean): T | null;
  /** True for a target that acts once (bone placement) instead of dragging. */
  isTap(t: T): boolean;
  /** A tap target fires: at the press for the mouse, at the release for a finger (only when it moved ≤ the slop). */
  tap(t: T, clientX: number, clientY: number, rect: ArmClientRect): void;
  /** A finger is moving with a pending tap target (bone placement: the tail preview follows it). */
  pendingMove?(t: T, clientX: number, clientY: number, rect: ArmClientRect): void;
  /** Start the drag (select the joint, snapshot what cancel restores). False = nothing to drag. */
  begin(t: T, clientX: number, clientY: number, rect: ArmClientRect): boolean;
  move(clientX: number, clientY: number, rect: ArmClientRect): void;
  /** The drag finished normally (commit). */
  end(): void;
  /** The drag was taken back (2nd finger / pointercancel): restore the pose and the selection exactly. */
  cancel(): void;
  /** Mouse / pen hover (no drag), at most once per frame. */
  hover?(clientX: number, clientY: number, rect: ArmClientRect): void;
  /** Mark a finger press as owned by the armature without stopping it (pointer-claims). */
  claim?(e: object): void;
}

/** The PointerEvent fields the gesture reads (a real PointerEvent satisfies it). */
export type ArmGesturePointer = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'buttons'
  | 'altKey' | 'clientX' | 'clientY' | 'preventDefault'>;

export type ArmGestureState = 'idle' | 'pending' | 'dragging' | 'blocked';

export class ArmaturePointerGesture<T> {
  /** Finger movement (CSS px) that starts a touch drag before its first frame. */
  static readonly TOUCH_START_PX = 8;
  /** A finger that moved further than this (CSS px) is not a tap (bone placement). */
  static readonly TAP_SLOP_PX = 8;

  private mode: ArmGestureState = 'idle';
  private readonly touches = new Set<number>();
  private owner: number | null = null;
  private rect: ArmClientRect | null = null;
  private frame = 0;
  private pend: { t: T; x: number; y: number; tap: boolean; moved: boolean } | null = null;
  private hoverFrame = 0;
  private hoverAt: { x: number; y: number } | null = null;

  constructor(private readonly io: ArmGestureIO, private readonly h: ArmGestureHandlers<T>) {}

  /** Diagnostics / tests. */
  get state(): ArmGestureState { return this.mode; }
  get touchCount(): number { return this.touches.size; }
  /** True while a drag (or a finger press about to become one) owns a pointer. */
  get busy(): boolean { return this.mode === 'pending' || this.mode === 'dragging'; }

  /** pointerdown. Returns true when the armature took the press (the host stops a MOUSE press's mousedown). */
  down(e: ArmGesturePointer): boolean {
    const touch = e.pointerType === 'touch';
    if (touch) {
      // The primary finger starts a new contact sequence: any ids still tracked are stale (a missed up).
      if (e.isPrimary && (this.mode === 'idle' || this.mode === 'blocked')) { this.touches.clear(); this.mode = 'idle'; }
      this.touches.add(e.pointerId);
      if (this.touches.size >= 2) { this.abortForGesture(); return false; }   // pinch / two-finger orbit
    }
    if (this.mode !== 'idle') return false;
    if (e.isPrimary === false || e.button !== 0 || e.altKey) return false;   // Alt+left orbits; middle / right pan
    const rect = this.io.measure();
    const t = this.h.pick(e.clientX, e.clientY, rect, touch);
    if (t == null) return false;
    this.cancelHover();
    this.rect = rect;
    const tap = this.h.isTap(t);
    if (!touch) {
      if (tap) { this.h.tap(t, e.clientX, e.clientY, rect); this.rect = null; return true; }
      if (!this.h.begin(t, e.clientX, e.clientY, rect)) { this.rect = null; return false; }
      this.owner = e.pointerId;
      this.mode = 'dragging';
      this.io.capture(e.pointerId);
      return true;
    }
    this.h.claim?.(e);
    this.owner = e.pointerId;
    this.mode = 'pending';
    this.pend = { t, x: e.clientX, y: e.clientY, tap, moved: false };
    this.io.capture(e.pointerId);
    if (!tap) this.frame = this.io.requestFrame(() => { this.frame = 0; this.commitPending(); });
    return true;
  }

  move(e: ArmGesturePointer): void {
    const touch = e.pointerType === 'touch';
    if (this.mode === 'blocked' || this.touches.size >= 2) return;
    if ((this.mode === 'pending' || this.mode === 'dragging') && e.pointerId === this.owner) {
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) { this.up(e); return; }   // the up was missed
      const rect = this.rect ?? this.io.measure();
      if (this.mode === 'pending') {
        const p = this.pend!;
        const far = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.tap) {
          if (far > ArmaturePointerGesture.TAP_SLOP_PX) p.moved = true;
          this.h.pendingMove?.(p.t, e.clientX, e.clientY, rect);
          return;
        }
        if (far < ArmaturePointerGesture.TOUCH_START_PX) return;
        this.commitPending();
        if ((this.mode as ArmGestureState) !== 'dragging') return;   // begin declined
      }
      this.h.move(e.clientX, e.clientY, rect);
      return;
    }
    if (this.mode !== 'idle' || touch || !this.h.hover) return;   // a finger has no hover (TOUCH-16)
    this.hoverAt = { x: e.clientX, y: e.clientY };
    if (this.hoverFrame) return;
    this.hoverFrame = this.io.requestFrame(() => {
      this.hoverFrame = 0;
      const at = this.hoverAt;
      this.hoverAt = null;
      if (!at || this.mode !== 'idle') return;
      this.h.hover?.(at.x, at.y, this.io.measure());
    });
  }

  up(e: ArmGesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (e.pointerId !== this.owner) return;
    if (this.mode === 'pending') {
      const p = this.pend!;
      if (p.tap) {
        const rect = this.rect ?? this.io.measure();
        this.dropPending();
        this.finish();
        if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= ArmaturePointerGesture.TAP_SLOP_PX) {
          this.h.tap(p.t, e.clientX, e.clientY, rect);
        }
        return;
      }
      this.commitPending();   // a quick tap on a joint still selects it (begin + end, like a click)
    }
    if (this.mode !== 'dragging') return;
    this.finish();
    this.h.end();
  }

  /** pointercancel: the pointer is gone — a live drag is CANCELLED (restored), a pending press does nothing. */
  cancel(e: ArmGesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (e.pointerId !== this.owner) return;
    if (this.mode === 'pending') { this.dropPending(); this.finish(); return; }
    if (this.mode !== 'dragging') return;
    this.finish();
    this.h.cancel();
  }

  /** lostpointercapture: the drag's pointer no longer reports to the canvas — end the drag (after a normal up it is
   *  already over: no-op). Touch tracking is left alone (the finger may still be down). */
  lostCapture(e: ArmGesturePointer): void {
    if (e.pointerId !== this.owner) return;
    if (this.mode === 'pending') { this.dropPending(); this.finish(); return; }
    if (this.mode !== 'dragging') return;
    this.finish();
    this.h.end();
  }

  /** Esc (the host's cancel): a live drag is CANCELLED (restored), a pending press is dropped. The pointer's later
   *  moves / up are ignored (no owner); touch tracking is left alone (the finger may still be down). */
  abort(): void {
    if (this.mode === 'dragging') { this.finish(); this.h.cancel(); return; }
    if (this.mode === 'pending') { this.dropPending(); this.finish(); }
  }

  /** The pointer left the canvas: drop a pending hover (the host clears its hover highlight). */
  leave(): void { this.cancelHover(); }

  /** Teardown: a live drag ends normally, a pending press is dropped, everything resets. */
  reset(): void {
    if (this.mode === 'dragging') { this.finish(); this.h.end(); }
    else { this.dropPending(); this.finish(); }
    this.cancelHover();
    this.mode = 'idle';
    this.touches.clear();
  }

  /** The finger press becomes a drag, from the PRESS point (the host picked the target there). */
  private commitPending(): void {
    if (this.mode !== 'pending' || !this.pend || this.pend.tap) return;
    const p = this.pend;
    this.dropPending();
    const rect = this.rect ?? this.io.measure();
    if (!this.h.begin(p.t, p.x, p.y, rect)) { this.finish(); return; }
    this.mode = 'dragging';
  }

  /** A second finger: the press / drag is taken back; nothing starts until every finger has lifted. */
  private abortForGesture(): void {
    const wasDragging = this.mode === 'dragging';
    this.dropPending();
    this.cancelHover();
    // Pointer capture is left as it is: the orbit controller captured the same fingers for its gesture.
    this.owner = null;
    this.rect = null;
    this.mode = 'blocked';
    if (wasDragging) this.h.cancel();
  }

  private dropPending(): void {
    if (this.frame) { this.io.cancelFrame(this.frame); this.frame = 0; }
    this.pend = null;
  }

  private cancelHover(): void {
    if (this.hoverFrame) { this.io.cancelFrame(this.hoverFrame); this.hoverFrame = 0; }
    this.hoverAt = null;
  }

  private finish(): void {
    if (this.owner !== null) this.io.release(this.owner);
    this.owner = null;
    this.mode = 'idle';
    this.rect = null;
  }
}
