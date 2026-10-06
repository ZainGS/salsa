/**
 * raster-touch-pinch.test.ts: TOUCH-5 / TOUCH-7 / TOUCH-8 in the 2D canvas input (RasterInteractionController) with a
 * real InteractionService over a fake canvas (no GPU). Synthetic touch vs mouse pointer events:
 *  - two-finger PINCH zooms around the finger midpoint and two-finger drag PANS (finger-locked at a 2× backing store;
 *    canvas-pixel-ratio.test.ts covers a CAPPED backing ≠ devicePixelRatio);
 *  - a 2nd finger CANCELS (reverts) the 1-finger drag, without an undo entry;
 *  - the 2D pinch stands down while a 3D orbit controller owns touch;
 *  - the false double-click (two fingers within 300 ms) is gone; the mouse rule is unchanged;
 *  - 2D handle thresholds grow under a finger (capped for small shapes).
 */
import { describe, it, expect } from 'vitest';
import { RasterInteractionController, isDoubleClickPress } from './raster-interaction-controller';
import { InteractionService } from '../../services/interaction-service';
import { Node } from '../../scene-graph/shapes/base/node';
import { touchThreshold } from '../util/handles';
import type { WebGPURenderer } from './webgpu-renderer';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number }>;

function fakeCanvas(): HTMLCanvasElement {
    // A 2× backing store: 800×600 CSS, 1600×1200 backing (the ratio the maths use is canvas.width / CSS width).
    return {
        width: 1600, height: 1200, clientWidth: 800, clientHeight: 600, style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    } as unknown as HTMLCanvasElement;
}
function ev(init: Init): PointerEvent {
    return { pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0, offsetX: init.clientX ?? 0, offsetY: init.clientY ?? 0,
        shiftKey: false, preventDefault() {}, ...init } as unknown as PointerEvent;
}

function setup() {
    const canvas = fakeCanvas();
    const is = new InteractionService(canvas);
    const root = new Node();
    let renders = 0;
    const r = {
        canvas, interactionService: is, mode: { kind: 'idle' }, illustrationMode: false, illustrationBounds: undefined,
        bgDirty: { matrix: false }, renderListDirty: false, backgroundPatternFixed: false, sceneGraph: { root },
        scheduleRender: () => { renders++; },
        canvasPxToWorld: (x: number, y: number) => { const w = is.toWorldCoordsFromCanvas(x, y); return [w.x, w.y]; },
        getRandomCursor: () => 'default',
    };
    const ctrl = new RasterInteractionController(r as unknown as WebGPURenderer);
    return { ctrl, r, is, root, renders: () => renders };
}

/** World point under a client (CSS) point — what must stay under the fingers. */
const worldAt = (is: InteractionService, x: number, y: number) => is.toWorldCoordsFromCanvas(x, y);

describe('2D two-finger pinch + pan (TOUCH-7)', () => {
    it('pinch zooms around the midpoint: the world point under it stays put', () => {
        const { ctrl, is } = setup();
        is.suppressBoxSelect = true;                  // one finger does nothing here: isolate the 2-finger gesture
        ctrl.handlePointerDown(ev({ pointerId: 1, clientX: 300, clientY: 300 }));
        ctrl.handlePointerDown(ev({ pointerId: 2, clientX: 500, clientY: 300 }));
        expect(ctrl.isPinching).toBe(true);
        const before = worldAt(is, 400, 300);
        const z0 = is.getZoomFactor();
        ctrl.handlePointerMove(ev({ pointerId: 1, clientX: 250, clientY: 300 }));
        ctrl.handlePointerMove(ev({ pointerId: 2, clientX: 550, clientY: 300 }));   // spread 200 → 300, midpoint fixed
        expect(is.getZoomFactor()).toBeCloseTo(z0 * 1.5, 6);
        const after = worldAt(is, 400, 300);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
    });

    it('two-finger drag pans finger-locked (DPR 2): the content follows the fingers exactly', () => {
        const { ctrl, is } = setup();
        is.suppressBoxSelect = true;
        ctrl.handlePointerDown(ev({ pointerId: 1, clientX: 300, clientY: 300 }));
        ctrl.handlePointerDown(ev({ pointerId: 2, clientX: 500, clientY: 300 }));
        const grabbed = worldAt(is, 300, 300);
        ctrl.handlePointerMove(ev({ pointerId: 1, clientX: 340, clientY: 320 }));
        ctrl.handlePointerMove(ev({ pointerId: 2, clientX: 540, clientY: 320 }));
        const now = worldAt(is, 340, 320);
        expect(now.x).toBeCloseTo(grabbed.x, 6);
        expect(now.y).toBeCloseTo(grabbed.y, 6);
        // Lifting: the pinch ends only when every finger is up; the leftover finger does nothing.
        ctrl.handlePointerUp(ev({ pointerId: 2, clientX: 540, clientY: 320 }));
        expect(ctrl.isPinching).toBe(true);
        const pan = { ...is.getPanOffset() };
        ctrl.handlePointerMove(ev({ pointerId: 1, clientX: 400, clientY: 400 }));
        expect(is.getPanOffset()).toEqual(pan);
        ctrl.handlePointerUp(ev({ pointerId: 1, clientX: 400, clientY: 400 }));
        expect(ctrl.isPinching).toBe(false);
    });

    it('stands down while a 3D orbit controller owns multi-finger touch', () => {
        const { ctrl, is } = setup();
        is.suppressBoxSelect = true;
        is.touchGestures3D = () => true;
        ctrl.handlePointerDown(ev({ pointerId: 1, clientX: 300, clientY: 300 }));
        ctrl.handlePointerDown(ev({ pointerId: 2, clientX: 500, clientY: 300 }));
        const z0 = is.getZoomFactor(), p0 = { ...is.getPanOffset() };
        ctrl.handlePointerMove(ev({ pointerId: 2, clientX: 700, clientY: 340 }));
        expect(is.getZoomFactor()).toBe(z0);
        expect(is.getPanOffset()).toEqual(p0);
    });

    it('a 2nd finger CANCELS the 1-finger drag: the node goes back, no undo entry', () => {
        const { ctrl, r, is, root } = setup();
        const n = new Node(); n.x = 0.1; n.y = 0.2; root.addChild(n);
        // As if pointerdown had started a move of `n` (the real hit-test path needs a full scene).
        is.suppressBoxSelect = true;
        ctrl.handlePointerDown(ev({ pointerId: 1, clientX: 10, clientY: 10 }));   // primary finger (box path suppressed below)
        r.mode = { kind: 'dragging' };
        (ctrl as unknown as { beginUndoCapture(s: Node[]): void }).beginUndoCapture([n]);
        n.x = 0.5; n.y = 0.6;                                                      // the finger dragged it
        ctrl.handlePointerDown(ev({ pointerId: 2, clientX: 200, clientY: 10 }));
        expect(n.x).toBeCloseTo(0.1, 9);
        expect(n.y).toBeCloseTo(0.2, 9);
        expect(r.mode.kind).toBe('idle');
        expect(is.vectorUndo.canUndo).toBe(false);
        expect(ctrl.isPinching).toBe(true);
    });

    it('the mouse path is untouched by the touch tracking (a mouse pan still works, pointer-locked)', () => {
        const { ctrl, r, is } = setup();
        is.isPanToolSelected = true;
        ctrl.handlePointerDown(ev({ pointerType: 'mouse', clientX: 100, clientY: 100 }));
        expect(r.mode.kind).toBe('panning');
        const p0 = { ...is.getPanOffset() };
        const grabbed = worldAt(is, 100, 100);
        ctrl.handlePointerMove(ev({ pointerType: 'mouse', clientX: 110, clientY: 100 }));
        // Pan units = backing px × 2: 10 CSS px × backing ratio 2 × 2. (The old bare "clientDelta × 2" = +20 moved the
        // content HALF the pointer at this 2× backing, the same bug as 2/3 of the finger on a DPR-capped tablet.)
        expect(is.getPanOffset().x).toBeCloseTo(p0.x + 40, 9);
        const now = worldAt(is, 110, 100);
        expect(now.x).toBeCloseTo(grabbed.x, 6);
        expect(now.y).toBeCloseTo(grabbed.y, 6);
        ctrl.handlePointerUp(ev({ pointerType: 'mouse', clientX: 110, clientY: 100 }));
        expect(r.mode.kind).toBe('idle');
    });
});

describe('double-click test (TOUCH-5)', () => {
    const p = (t: number, type: string, x = 0, y = 0) => ({ t, type, x, y });
    it('mouse: time only (unchanged)', () => {
        expect(isDoubleClickPress(p(1000, 'mouse'), p(1200, 'mouse', 500, 500))).toBe(true);
        expect(isDoubleClickPress(p(1000, 'mouse'), p(1400, 'mouse'))).toBe(false);
    });
    it('touch: two taps near the same spot count; two fingers far apart / mixed pointer types do not', () => {
        expect(isDoubleClickPress(p(1000, 'touch', 100, 100), p(1200, 'touch', 110, 105))).toBe(true);
        expect(isDoubleClickPress(p(1000, 'touch', 100, 100), p(1050, 'touch', 400, 100))).toBe(false);
        expect(isDoubleClickPress(p(1000, 'touch', 100, 100), p(1050, 'mouse', 100, 100))).toBe(false);
    });
});

describe('2D handle hit scale (TOUCH-8)', () => {
    it('doubles the threshold under a finger, never below the mouse value, capped at a third of the smaller side', () => {
        expect(touchThreshold(0.035, 1, { width: 1, height: 1 })).toBe(0.035);
        expect(touchThreshold(0.035, 2, { width: 1, height: 1 })).toBeCloseTo(0.07, 12);
        expect(touchThreshold(0.035, 2, { width: 0.15, height: 1 })).toBeCloseTo(0.05, 12);
        expect(touchThreshold(0.035, 2, { width: 0.03, height: 0.03 })).toBe(0.035);
    });
});
