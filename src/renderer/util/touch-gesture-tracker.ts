/**
 * Finger counting for the ONE-FINGER 2D tools (mobile-parity TOUCH-5; the 7.3b P1 SurfacePaintGesture rule, shared).
 *
 * A tool feeds its canvas pointer events here so it can tell a one-finger stroke / drag from a pinch or two-finger pan.
 * The renderer's RasterInteractionController turns two fingers into a 2D pinch-zoom + pan on its own; each tool only
 * has to stand down and put back whatever its first finger already did.
 *
 *  - Only `pointerType === 'touch'` is tracked: a mouse / pen pointerdown is always 'start' (unchanged behaviour).
 *  - A SECOND finger → 'gesture': the tool cancels what the first finger started (byte-exact take-back, no undo entry).
 *    From then on the gesture is BLOCKED: every finger gets 'ignore' until all of them have lifted.
 *  - A `!isPrimary` finger (a palm, an extra finger) never starts anything: 'ignore'.
 *  - The primary finger of a NEW contact sequence clears ids left over from a missed pointerup / pointercancel.
 *
 * DOM-free (only reads pointerType / pointerId / isPrimary), so it is unit tested and shared by the raster brush,
 * the raster selection / move tools and the vector scribble eraser.
 */

export type TouchDownVerdict = 'start' | 'gesture' | 'ignore';

type TouchFields = { pointerType?: string; pointerId?: number; isPrimary?: boolean };

export class TouchGestureTracker {
  /** Finger movement (CSS px) that commits a touch stroke before its first frame (same as SurfacePaintGesture). */
  static readonly TOUCH_START_PX = 8;

  private readonly ids = new Set<number>();
  private _blocked = false;

  /** Fingers currently down. */
  get count(): number { return this.ids.size; }
  /** True from a second finger until every finger has lifted: no finger may start anything. */
  get blocked(): boolean { return this._blocked; }

  /** pointerdown. 'start' = the tool may begin (mouse / pen always), 'gesture' = a 2nd+ finger landed (cancel what
   *  the first one started), 'ignore' = a finger that must not start anything. */
  down(e: TouchFields): TouchDownVerdict {
    if (e.pointerType !== 'touch') return 'start';
    if (e.isPrimary === true) { this.ids.clear(); this._blocked = false; }   // a new sequence: older ids are stale
    this.ids.add(e.pointerId ?? 0);
    if (this.ids.size >= 2) { this._blocked = true; return 'gesture'; }
    if (this._blocked || e.isPrimary === false) return 'ignore';
    return 'start';
  }

  /** pointerup / pointercancel (NOT lostpointercapture: that finger may still be down). */
  up(e: TouchFields): void {
    if (e.pointerType !== 'touch') return;
    this.ids.delete(e.pointerId ?? 0);
    if (this.ids.size === 0) this._blocked = false;
  }

  /** Forget every finger (tool reset). */
  reset(): void { this.ids.clear(); this._blocked = false; }
}
