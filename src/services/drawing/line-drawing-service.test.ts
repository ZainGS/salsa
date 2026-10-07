/**
 * Arrow / line tool (UI review 2026-10-07 §2b, §3 #12): press-drag-release draws the line in one gesture; a click
 * (no drag) still starts click-click; Escape / a second finger cancel; the line takes the host's colour and is one
 * 2D undo step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LineDrawingService } from './line-drawing-service';

type Handler = (e: any) => unknown;

function setup() {
    const canvasL = new Map<string, Handler[]>();
    const winL = new Map<string, Handler[]>();
    const add = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, [...(m.get(t) ?? []), h]); };
    const rm = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, (m.get(t) ?? []).filter(x => x !== h)); };
    vi.stubGlobal('window', { addEventListener: add(winL), removeEventListener: rm(winL) });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });

    const canvas = { addEventListener: add(canvasL), removeEventListener: rm(canvasL) };
    const children: any[] = [];
    const root = {
        addChild: (n: any) => { children.push(n); },
        removeChild: (n: any) => { const i = children.indexOf(n); if (i >= 0) children.splice(i, 1); },
    };
    const vectorUndo = {
        begin: vi.fn((_root: unknown, _seeds: unknown) => ({ token: true })),
        commit: vi.fn((_token: unknown, _description: string, _extra?: unknown) => true),
    };
    const interactionService: any = {
        canvas,
        toWorldCoords: (e: any) => ({ x: e.clientX / 100, y: -e.clientY / 100 }),
        updateWorldMatrix: () => {}, beginInteractive: vi.fn(), endInteractive: vi.fn(), requestRender: () => {},
        clearSelectedNodes: () => {},
        onSceneGraphChanged: { emit: () => {} },
        vectorUndo,
    };
    const shapeFactory: any = {
        createLine: (x1: number, y1: number, x2: number, y2: number, color: any, width: number) => ({
            id: 'line' + children.length, x1, y1, x2, y2, strokeColor: color, strokeWidth: width,
            isStaging: false, arrowStart: 'none', arrowEnd: 'none',
            updateEndPoint(x: number, y: number) { this.x2 = x; this.y2 = y; },
        }),
    };
    const svc = new LineDrawingService(interactionService, { root } as any, {} as any, shapeFactory);
    svc.enable();
    const fire = (where: 'canvas' | 'window', type: string, e: any) => {
        const m = where === 'canvas' ? canvasL : winL;
        for (const h of m.get(type) ?? []) h({ button: 0, pointerId: 1, pointerType: 'mouse', preventDefault() {}, ...e });
    };
    const down = (x: number, y: number, extra: any = {}) => fire('canvas', 'pointerdown', { clientX: x, clientY: y, ...extra });
    const move = (x: number, y: number, extra: any = {}) => fire('canvas', 'pointermove', { clientX: x, clientY: y, ...extra });
    const up = (x: number, y: number, extra: any = {}) => fire('window', 'pointerup', { clientX: x, clientY: y, ...extra });
    return { svc, children, vectorUndo, down, move, up, fire };
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('LineDrawingService press-drag-release', () => {
    it('a drag draws the line from the press to the release in one gesture', () => {
        const t = setup();
        t.down(100, 100);
        expect(t.svc.isDrawing).toBe(true);
        t.move(200, 150);
        t.move(300, 200);
        t.up(300, 200);
        expect(t.svc.isDrawing).toBe(false);
        expect(t.children).toHaveLength(1);
        const line = t.children[0];
        expect(line.isStaging).toBe(false);
        expect([line.x1, line.y1, line.x2, line.y2]).toEqual([1, -1, 3, -2]);
        expect(t.vectorUndo.commit).toHaveBeenCalledTimes(1);
        expect(t.vectorUndo.commit.mock.calls[0][1]).toBe('Draw line');
    });

    it('a release past the drag distance finishes even without a move event in between', () => {
        const t = setup();
        t.down(100, 100);
        t.up(140, 100);
        expect(t.svc.isDrawing).toBe(false);
        expect(t.children[0].x2).toBeCloseTo(1.4);
    });

    it('click-click still works: a click starts, the line follows the pointer, the next click finishes', () => {
        const t = setup();
        t.down(100, 100);
        t.up(102, 101);                       // a click (under the drag distance)
        expect(t.svc.isDrawing).toBe(true);
        t.move(250, 100, { pointerId: 1 });
        expect(t.children[0].x2).toBeCloseTo(2.5);
        t.down(260, 100);                     // second click
        expect(t.svc.isDrawing).toBe(false);
        expect(t.children[0].x2).toBeCloseTo(2.6);
        t.up(260, 100);                       // its release changes nothing
        expect(t.children).toHaveLength(1);
        expect(t.vectorUndo.commit).toHaveBeenCalledTimes(1);
    });

    it('a finger needs more travel before its release counts as a drag', () => {
        const t = setup();
        t.down(100, 100, { pointerType: 'touch' });
        t.up(108, 100, { pointerType: 'touch' });
        expect(t.svc.isDrawing).toBe(true);   // 8 px < 10 px: a tap, click-click continues
    });

    it('a second finger mid-drag drops the half-made line (a pinch, not an arrow)', () => {
        const t = setup();
        t.down(100, 100, { pointerType: 'touch' });
        t.move(160, 100, { pointerType: 'touch' });
        t.down(300, 300, { pointerType: 'touch', pointerId: 2 });
        expect(t.svc.isDrawing).toBe(false);
        expect(t.children).toHaveLength(0);
        t.up(160, 100, { pointerType: 'touch' });
        expect(t.children).toHaveLength(0);
        expect(t.vectorUndo.commit).not.toHaveBeenCalled();
    });

    it('Escape cancels a line in progress', () => {
        const t = setup();
        t.down(100, 100);
        t.move(200, 100);
        t.fire('window', 'keydown', { key: 'Escape' });
        expect(t.children).toHaveLength(0);
        t.up(200, 100);
        expect(t.children).toHaveLength(0);
    });

    it('new lines take the stroke colour the host sets (they were always grey)', () => {
        const t = setup();
        t.svc.setStrokeColor({ r: 1, g: 0, b: 0, a: 1 });
        t.down(100, 100);
        t.up(200, 100);
        expect(t.children[0].strokeColor).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    });

    it('a disabled tool ignores presses', () => {
        const t = setup();
        t.svc.disable();
        t.down(100, 100);
        t.up(200, 100);
        expect(t.children).toHaveLength(0);
    });
});
