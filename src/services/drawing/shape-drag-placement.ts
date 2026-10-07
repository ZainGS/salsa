/**
 * Drag-to-size for the 2D shape tools (UI review 2026-10-07 §3 #12).
 *
 * The shape tools (rectangle / circle / triangle / polygon) keep a placement ghost under the pointer
 * (ShapeManager.setPreviewShape). A click still drops the ghost at its default size; a press-drag-release now
 * sizes it corner to corner (Shift: square / circle). The release commits the shape and puts a fresh ghost out for
 * the next one. The host's click handler confirms the ghost after every click — after a drag commit the
 * ShapeManager ignores that one confirm (the shape is already placed).
 *
 * Pointer input is listened on the window (the release may land off the canvas); presses are only taken when they
 * start on the canvas. A second finger (a pinch) drops the drag and puts the ghost back to its default size.
 */

/** The ghost shape the drag sizes (Rectangle / Circle / Triangle / Polygon — any Shape). */
export interface DragPlaceShape {
    x: number; y: number;
    width: number; height: number;
    scaleX: number; scaleY: number;
    updateLocalMatrix(): void;
    markDirty(): void;
}

export interface ShapeDragHost {
    /** The placement ghost, or null when no shape tool is active. */
    preview(): DragPlaceShape | null;
    /** The event started on the drawing canvas (and no other mode owns the input). */
    accepts(e: PointerEvent): boolean;
    toWorld(e: PointerEvent): { x: number; y: number };
    /** The drag finished: make the ghost a real shape and put a new ghost out. */
    commit(e: PointerEvent): void;
    render(): void;
}

export interface DragSizeRect { cx: number; cy: number; w: number; h: number }

/** The box from the press corner (x0, y0) to the pointer (x1, y1); `square` makes it w = h, still anchored at the
 *  press corner and growing toward the pointer. */
export function dragSizeRect(x0: number, y0: number, x1: number, y1: number, square = false): DragSizeRect {
    let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (square) { const s = Math.max(w, h); w = s; h = s; }
    const sx = x1 >= x0 ? 1 : -1, sy = y1 >= y0 ? 1 : -1;
    return { cx: x0 + sx * w / 2, cy: y0 + sy * h / 2, w, h };
}

export class ShapeDragPlacement {
    /** CSS px a press travels before it becomes a drag (shorter = a click: default-size placement). */
    static readonly DRAG_PX = 6;
    static readonly TOUCH_DRAG_PX = 10;
    /** Smallest size (world units) a drag makes — a degenerate 0-size shape can't be selected again. */
    static readonly MIN_SIZE = 0.01;

    private _press: {
        pointerId: number; clientX: number; clientY: number; slop: number;
        wx: number; wy: number;
        shape: DragPlaceShape; baseW: number; baseH: number; sx0: number; sy0: number;
    } | null = null;
    private _dragging = false;

    constructor(private readonly host: ShapeDragHost) {}

    /** A press is down for a placement (pending or dragging). */
    get active(): boolean { return this._press !== null; }
    /** The press has turned into a drag (the ghost is being sized). */
    get dragging(): boolean { return this._dragging; }

    pointerDown(e: PointerEvent): boolean {
        if (this._press) {
            // A second finger: a pinch, not a placement
            if (e.pointerId !== this._press.pointerId) this.cancel();
            return false;
        }
        if (e.pointerType === 'mouse' && e.button !== 0) return false;
        if (!this.host.accepts(e)) return false;
        const shape = this.host.preview();
        if (!shape) return false;
        const w = this.host.toWorld(e);
        // The ghost jumps to the press (a finger has no hover to bring it there first)
        shape.x = w.x; shape.y = w.y;
        shape.updateLocalMatrix(); shape.markDirty();
        this._press = {
            pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY,
            slop: e.pointerType === 'touch' ? ShapeDragPlacement.TOUCH_DRAG_PX : ShapeDragPlacement.DRAG_PX,
            wx: w.x, wy: w.y, shape,
            baseW: shape.width > 0 ? shape.width : 1, baseH: shape.height > 0 ? shape.height : 1,
            sx0: shape.scaleX ?? 1, sy0: shape.scaleY ?? 1,
        };
        this._dragging = false;
        this.host.render();
        return true;
    }

    pointerMove(e: PointerEvent): void {
        const p = this._press;
        if (!p || e.pointerId !== p.pointerId) return;
        if (!this._dragging) {
            if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) < p.slop) return;
            this._dragging = true;
        }
        this._apply(e);
    }

    /** Returns true when the release committed a drag-sized shape. */
    pointerUp(e: PointerEvent): boolean {
        const p = this._press;
        if (!p || e.pointerId !== p.pointerId) return false;
        const dragged = this._dragging || Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) >= p.slop;
        if (dragged) this._apply(e);
        this._press = null;
        this._dragging = false;
        if (!dragged) return false;   // a click: the host's click handler places it at its default size
        this.host.commit(e);
        return true;
    }

    /** Drop the press (a pinch, the tool left): the ghost goes back to its default size. */
    cancel(): void {
        const p = this._press;
        this._press = null;
        if (!p || !this._dragging) { this._dragging = false; return; }
        this._dragging = false;
        p.shape.scaleX = p.sx0; p.shape.scaleY = p.sy0;
        p.shape.x = p.wx; p.shape.y = p.wy;
        p.shape.updateLocalMatrix(); p.shape.markDirty();
        this.host.render();
    }

    private _apply(e: PointerEvent): void {
        const p = this._press!;
        const w = this.host.toWorld(e);
        const r = dragSizeRect(p.wx, p.wy, w.x, w.y, !!e.shiftKey);
        const min = ShapeDragPlacement.MIN_SIZE;
        p.shape.x = r.cx; p.shape.y = r.cy;
        p.shape.scaleX = Math.max(min, r.w) / p.baseW;
        p.shape.scaleY = Math.max(min, r.h) / p.baseH;
        p.shape.updateLocalMatrix(); p.shape.markDirty();
        this.host.render();
    }
}
