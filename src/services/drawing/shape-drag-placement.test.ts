/**
 * Shape tools drag-to-size (UI review 2026-10-07 §3 #12): press-drag-release sizes the ghost corner to corner
 * (Shift: square) and commits it; a click leaves the default-size placement to the host; a second finger cancels.
 */
import { describe, it, expect, vi } from 'vitest';
import { ShapeDragPlacement, dragSizeRect, type DragPlaceShape } from './shape-drag-placement';
import { sampleFramePixel } from './canvas-color-sample';

function ghost(width = 1, height = 1): DragPlaceShape & { dirty: number } {
    return {
        x: 0, y: 0, width, height, scaleX: 1, scaleY: 1, dirty: 0,
        updateLocalMatrix() {}, markDirty() { this.dirty++; },
    };
}

function setup(shape: DragPlaceShape | null = ghost()) {
    const commit = vi.fn();
    const canvas = {};
    const drag = new ShapeDragPlacement({
        preview: () => shape,
        accepts: (e) => e.target === canvas,
        toWorld: (e) => ({ x: e.clientX / 100, y: -e.clientY / 100 }),
        commit,
        render: () => {},
    });
    const ev = (x: number, y: number, extra: any = {}) =>
        ({ target: canvas, button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, shiftKey: false, ...extra }) as any;
    return { drag, shape: shape!, commit, ev, canvas };
}

describe('dragSizeRect', () => {
    it('spans the press corner to the pointer in any direction', () => {
        expect(dragSizeRect(0, 0, 2, 1)).toEqual({ cx: 1, cy: 0.5, w: 2, h: 1 });
        expect(dragSizeRect(0, 0, -2, -1)).toEqual({ cx: -1, cy: -0.5, w: 2, h: 1 });
    });
    it('Shift makes it square, still anchored at the press and growing toward the pointer', () => {
        expect(dragSizeRect(0, 0, 2, -1, true)).toEqual({ cx: 1, cy: -1, w: 2, h: 2 });
    });
});

describe('ShapeDragPlacement', () => {
    it('a drag sizes the ghost corner to corner and commits on release', () => {
        const t = setup();
        expect(t.drag.pointerDown(t.ev(100, 100))).toBe(true);
        t.drag.pointerMove(t.ev(200, 150));
        expect(t.drag.dragging).toBe(true);
        expect(t.shape.scaleX).toBeCloseTo(1);
        expect(t.shape.scaleY).toBeCloseTo(0.5);
        expect(t.drag.pointerUp(t.ev(400, 300))).toBe(true);
        expect(t.commit).toHaveBeenCalledTimes(1);
        // 1,-1 → 4,-3: 3 × 2 world units, centred between
        expect(t.shape.x).toBeCloseTo(2.5);
        expect(t.shape.y).toBeCloseTo(-2);
        expect(t.shape.scaleX).toBeCloseTo(3);
        expect(t.shape.scaleY).toBeCloseTo(2);
        expect(t.drag.active).toBe(false);
    });

    it('scales relative to the ghost base size (a polygon ghost has width 0 → base 1)', () => {
        const t = setup(ghost(0.5, 0.5));
        t.drag.pointerDown(t.ev(0, 0));
        t.drag.pointerUp(t.ev(100, 100));
        expect(t.shape.scaleX).toBeCloseTo(2);   // 1 world unit / 0.5 base
        const p = setup(ghost(0, 0));
        p.drag.pointerDown(p.ev(0, 0));
        p.drag.pointerUp(p.ev(100, 200));
        expect(p.shape.scaleX).toBeCloseTo(1);
        expect(p.shape.scaleY).toBeCloseTo(2);
    });

    it('Shift held while dragging keeps it square', () => {
        const t = setup();
        t.drag.pointerDown(t.ev(0, 0));
        t.drag.pointerUp(t.ev(300, 100, { shiftKey: true }));
        expect(t.shape.scaleX).toBeCloseTo(3);
        expect(t.shape.scaleY).toBeCloseTo(3);
    });

    it('a click (no drag) is left to the host: the ghost stays default size at the press, nothing commits', () => {
        const t = setup();
        t.drag.pointerDown(t.ev(150, 50));
        expect([t.shape.x, t.shape.y]).toEqual([1.5, -0.5]);   // the ghost jumps to the press (touch has no hover)
        expect(t.drag.pointerUp(t.ev(153, 52))).toBe(false);
        expect(t.commit).not.toHaveBeenCalled();
        expect(t.shape.scaleX).toBe(1);
    });

    it('a finger needs 10 px before it sizes', () => {
        const t = setup();
        t.drag.pointerDown(t.ev(0, 0, { pointerType: 'touch' }));
        t.drag.pointerMove(t.ev(8, 0, { pointerType: 'touch' }));
        expect(t.drag.dragging).toBe(false);
        t.drag.pointerMove(t.ev(12, 0, { pointerType: 'touch' }));
        expect(t.drag.dragging).toBe(true);
    });

    it('a second finger cancels: the ghost goes back to default size and the release commits nothing', () => {
        const t = setup();
        t.drag.pointerDown(t.ev(0, 0, { pointerType: 'touch' }));
        t.drag.pointerMove(t.ev(200, 200, { pointerType: 'touch' }));
        t.drag.pointerDown(t.ev(300, 300, { pointerType: 'touch', pointerId: 2 }));
        expect(t.shape.scaleX).toBe(1);
        expect(t.drag.active).toBe(false);
        expect(t.drag.pointerUp(t.ev(200, 200, { pointerType: 'touch' }))).toBe(false);
        expect(t.commit).not.toHaveBeenCalled();
    });

    it('ignores presses off the canvas, a right button, or with no shape tool active', () => {
        const t = setup();
        expect(t.drag.pointerDown(t.ev(0, 0, { target: {} }))).toBe(false);
        expect(t.drag.pointerDown(t.ev(0, 0, { button: 2 }))).toBe(false);
        const none = setup(null);
        expect(none.drag.pointerDown(none.ev(0, 0))).toBe(false);
    });
});

describe('sampleFramePixel (eyedropper)', () => {
    // 2 × 2 frame: red, green / blue, half-transparent white (premultiplied 128,128,128,128)
    const frame = {
        width: 2, height: 2,
        rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 128]),
    };
    it('maps the CSS point onto the (bigger or smaller) backing store', () => {
        expect(sampleFramePixel(frame, 10, 10, 100, 100)?.hex).toBe('#ff0000');
        expect(sampleFramePixel(frame, 60, 10, 100, 100)?.hex).toBe('#00ff00');
        expect(sampleFramePixel(frame, 10, 99, 100, 100)?.hex).toBe('#0000ff');
    });
    it('un-premultiplies alpha', () => {
        const c = sampleFramePixel(frame, 99, 99, 100, 100)!;
        expect(c.hex).toBe('#ffffff');
        expect(c.a).toBeCloseTo(0.5, 2);
    });
    it('is null off the canvas', () => {
        expect(sampleFramePixel(frame, -1, 5, 100, 100)).toBeNull();
        expect(sampleFramePixel(frame, 100, 5, 100, 100)).toBeNull();
    });
});
