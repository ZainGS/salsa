/**
 * GpDrawGesture — the Grease Pencil draw / erase pointer state machine (DOM-free, so it is unit tested).
 *
 * Mirrors the surface-paint rules (SurfacePaintGesture, mobile-parity 7.3b P1) for a world-space pencil:
 *  - MOUSE / PEN: a plain left press (pen tip) starts the stroke at once and is CONSUMED (stopImmediatePropagation),
 *    so the camera, selection and 2D tools never see it. Alt+left (orbit), middle and right (pan / look) pass through.
 *    The pen's ERASER end (button 5) erases, whatever the panel's tool is. Pen pressure drives the width; mouse and
 *    finger draw at full width (a mouse reports 0.5 while pressed, which halved every mouse stroke).
 *  - TOUCH: never consumed — the camera (OrbitController / the 2D pinch) must see every finger to pinch and pan — but
 *    CLAIMED (pointer-claims), so the camera's one-finger orbit / look and the 2D one-finger tools stand down. A SECOND
 *    finger takes the stroke back (handlers.cancel) and nothing draws until every finger has lifted ('blocked').
 *  - pointercancel / lostpointercapture / a move with no button held end the stroke — it can never stay stuck.
 *  - Coalesced samples (high-rate pens) are all used, at most {@link MAX_SAMPLES} per event.
 */

/** One input sample, in client (CSS) pixels. */
export interface GpGestureSample {
  clientX: number;
  clientY: number;
  /** 0..1 — the pen's pressure; 1 for mouse / touch. */
  pressure: number;
  pointerType: string;
}

export interface GpDrawGestureHandlers {
  /** A press: start a stroke (or an erase when `erase`). Return false to decline — the press then passes on untouched. */
  begin(s: GpGestureSample, erase: boolean): boolean;
  move(s: GpGestureSample): void;
  /** The stroke ended normally (lift, cancelled pointer, lost capture): keep it. */
  end(): void;
  /** Take the stroke back as if never drawn (a second finger turned it into a pinch). */
  cancel(): void;
}

export interface GpGestureIO {
  capture(pointerId: number): void;
  release(pointerId: number): void;
  /** Mark a touch press as the tool's (pointer-claims): not stopped, but no other tool acts on it. */
  claim(e: object): void;
}

/** The PointerEvent fields the gesture reads (a real PointerEvent satisfies it). */
export type GpGesturePointer = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'buttons' | 'altKey'
  | 'clientX' | 'clientY' | 'pressure' | 'stopImmediatePropagation' | 'preventDefault'>
  & { getCoalescedEvents?: () => GpGesturePointer[] };

/** PointerEvent.button of a pen's eraser end, and its PointerEvent.buttons bit. */
const PEN_ERASER_BUTTON = 5;
const PEN_ERASER_BIT = 32;

export class GpDrawGesture {
  /** Coalesced samples used per pointermove (evenly picked, the newest always kept). */
  static readonly MAX_SAMPLES = 8;
  /** The lightest pen pressure a sample keeps (a pen touching down often reports ~0 for its first sample). */
  static readonly MIN_PEN_PRESSURE = 0.1;

  private mode: 'idle' | 'drawing' | 'blocked' = 'idle';
  private readonly touches = new Set<number>();
  private strokeId: number | null = null;
  private strokeTouch = false;

  constructor(private readonly io: GpGestureIO, private readonly handlers: () => GpDrawGestureHandlers | undefined) {}

  /** Diagnostics / tests. */
  get state(): 'idle' | 'drawing' | 'blocked' { return this.mode; }
  get touchCount(): number { return this.touches.size; }

  down(e: GpGesturePointer): void {
    const touch = e.pointerType === 'touch';
    if (touch) {
      // The primary finger starts a new contact sequence: ids still tracked are stale (a missed up).
      if (e.isPrimary && (this.mode === 'idle' || this.mode === 'blocked')) { this.touches.clear(); this.mode = 'idle'; }
      this.touches.add(e.pointerId);
      if (this.touches.size >= 2) { this.abortForGesture(); return; }   // pinch / pan — never consumed
    }
    if (this.mode !== 'idle') return;          // blocked (fingers still down) or a stroke already owns a pointer
    if (e.isPrimary === false) return;
    const h = this.handlers();
    if (!h || e.altKey) return;                // Alt = orbit
    const eraserTip = e.pointerType === 'pen' && (e.button === PEN_ERASER_BUTTON || (e.buttons & PEN_ERASER_BIT) !== 0);
    if (e.button !== 0 && !eraserTip) return;  // middle / right = the camera's
    if (!h.begin(GpDrawGesture.sample(e), eraserTip)) return;
    this.mode = 'drawing';
    this.strokeId = e.pointerId;
    this.strokeTouch = touch;
    e.preventDefault();
    this.io.capture(e.pointerId);
    if (touch) this.io.claim(e);               // the camera still tracks the finger (pinch), no tool acts on it
    else e.stopImmediatePropagation();
  }

  move(e: GpGesturePointer): void {
    if (this.mode !== 'drawing' || e.pointerId !== this.strokeId) return;
    if (this.touches.size >= 2) return;
    if (!this.strokeTouch) e.stopImmediatePropagation();
    if (typeof e.buttons === 'number' && (e.buttons & (1 | PEN_ERASER_BIT)) === 0) { this.up(e); return; }   // the up was missed
    const h = this.handlers();
    if (!h) return;
    for (const s of this.samplesOf(e)) h.move(GpDrawGesture.sample(s));
  }

  up(e: GpGesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (this.mode !== 'drawing' || e.pointerId !== this.strokeId) return;
    if (!this.strokeTouch) e.stopImmediatePropagation();
    this.finish();
    this.handlers()?.end();
  }

  /** pointercancel: the pointer is gone. The stroke ends and is kept (what was drawn so far). */
  cancel(e: GpGesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (this.mode !== 'drawing' || e.pointerId !== this.strokeId) return;
    this.finish();
    this.handlers()?.end();
  }

  /** lostpointercapture: the stroke's pointer no longer reports to the canvas — end the stroke (after a normal up it
   *  is already over: no-op). Touch tracking is left alone (the finger may still be down). */
  lostCapture(e: Pick<PointerEvent, 'pointerId'>): void {
    if (this.mode !== 'drawing' || e.pointerId !== this.strokeId) return;
    this.strokeId = null;                      // capture is already gone — nothing to release
    this.mode = 'idle';
    this.handlers()?.end();
  }

  /** Session exit: a live stroke ends normally, everything resets. */
  reset(): void {
    if (this.mode === 'drawing') { this.finish(); this.handlers()?.end(); }
    this.mode = 'idle';
    this.touches.clear();
    this.strokeId = null;
  }

  /** A second finger: the stroke becomes a gesture — taken back, nothing draws until every finger lifts. */
  private abortForGesture(): void {
    if (this.mode === 'drawing') {
      this.release();
      this.handlers()?.cancel();
    }
    this.mode = 'blocked';
    this.strokeId = null;
  }

  private finish(): void {
    this.release();
    this.mode = 'idle';
  }

  private release(): void {
    if (this.strokeId !== null) this.io.release(this.strokeId);
    this.strokeId = null;
  }

  /** The event's coalesced samples, at most MAX_SAMPLES of them — evenly picked, the newest always kept. */
  private samplesOf(e: GpGesturePointer): GpGesturePointer[] {
    let list: GpGesturePointer[] | null = null;
    try { list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null; } catch { list = null; }
    if (!list || list.length === 0) return [e];
    const n = list.length, max = GpDrawGesture.MAX_SAMPLES;
    if (n <= max) return list;
    const out: GpGesturePointer[] = [];
    for (let k = 1; k <= max; k++) out.push(list[Math.round((k * n) / max) - 1]);
    return out;
  }

  /** A pointer sample: pen pressure (clamped to MIN_PEN_PRESSURE..1), full pressure for mouse / touch. */
  static sample(e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure' | 'pointerType'>): GpGestureSample {
    const pen = e.pointerType === 'pen';
    const p = typeof e.pressure === 'number' && Number.isFinite(e.pressure) ? e.pressure : 1;
    return {
      clientX: e.clientX,
      clientY: e.clientY,
      pressure: pen ? Math.min(1, Math.max(GpDrawGesture.MIN_PEN_PRESSURE, p)) : 1,
      pointerType: e.pointerType,
    };
  }
}
