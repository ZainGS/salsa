import { describe, it, expect } from 'vitest';
import { recreate2DShape, type Shape2DRestoreDeps } from './shape-serializer';

// recreate2DShape is pure dispatch over the drawing services — its job is to route each serialized `type` to the
// right factory call with the right args, wire the few post-create tweaks (arrow props, scribble registration…), and
// return null for anything that ISN'T a 2D leaf. A mock deps bag pins exactly that (the atlas/engine/DOM-backed cases
// — Pattern/Stamp/SDFText/LiveText — are browser-verified). Factory methods return mutable stand-ins so the post-create
// property writes in each case body run as they do in production.
function makeDeps() {
    const scribbles: unknown[] = [];
    const rec = (type: string) => (...args: unknown[]) => ({ type, args } as Record<string, unknown>);
    const deps = {
        shapeFactory: {
            createRectangle: rec('Rectangle'),
            createCircle: rec('Circle'),
            createTriangle: rec('Triangle'),
            createInvertedTriangle: rec('InvertedTriangle'),
            createDiamond: rec('Diamond'),
            createLine: (...args: unknown[]) => ({ type: 'Line', args, updateEndPoint() { (this as Record<string, unknown>).ended = true; } } as Record<string, unknown>),
            createScribble: (...args: unknown[]) => ({ type: 'Scribble', args } as Record<string, unknown>),
            createHighlight: (...args: unknown[]) => ({ type: 'Highlight', args } as Record<string, unknown>),
            createPolygon: rec('Polygon'),
            createStickyNote: (...args: unknown[]) => ({ type: 'Sticky', args, fixedWidth: false, setWidth(w: number) { (this as Record<string, unknown>).w = w; } } as Record<string, unknown>),
            createSpeechBalloon: rec('Speech'),
            createPanelLayout: rec('Panel'),
        },
        eraserService: { scribbles },
    } as unknown as Shape2DRestoreDeps;
    return { deps, scribbles };
}

describe('recreate2DShape', () => {
    it('routes Rectangle with the saved geometry + colors', () => {
        const { deps } = makeDeps();
        const n = recreate2DShape({ type: 'Rectangle', x: 1, y: 2, width: 3, height: 4, fillColor: 'f', strokeColor: 's', strokeWidth: 5 }, deps) as unknown as Record<string, unknown>;
        expect(n.type).toBe('Rectangle');
        expect(n.args).toEqual([1, 2, 3, 4, 'f', 's', 5]);
    });

    it('Circle falls back to width when radius is absent', () => {
        const { deps } = makeDeps();
        const withR = recreate2DShape({ type: 'Circle', x: 0, y: 0, radius: 9, width: 3 }, deps) as unknown as Record<string, unknown>;
        expect((withR.args as unknown[])[2]).toBe(9);
        const noR = recreate2DShape({ type: 'Circle', x: 0, y: 0, width: 3 }, deps) as unknown as Record<string, unknown>;
        expect((noR.args as unknown[])[2]).toBe(3);
    });

    it('Line nudges a degenerate endpoint and applies arrow props', () => {
        const { deps } = makeDeps();
        const n = recreate2DShape({ type: 'Line', x1: 5, y1: 5, x2: 5, y2: 5, arrowEnd: 'triangle', arrowSize: 12 }, deps) as unknown as Record<string, unknown>;
        expect(n.ended).toBe(true);          // degenerate (x1==x2 && y1==y2) → updateEndPoint ran
        expect(n.arrowEnd).toBe('triangle');
        expect(n.arrowSize).toBe(12);
    });

    it('Scribble registers with the eraser service and clears staging flags', () => {
        const { deps, scribbles } = makeDeps();
        const n = recreate2DShape({ type: 'Scribble', x: 0, y: 0, points: [{ x: 1, y: 1 }] }, deps) as unknown as Record<string, unknown>;
        expect(n.points).toEqual([{ x: 1, y: 1 }]);
        expect(n.wasCommitted).toBe(false);
        expect(n.isStaging).toBe(false);
        expect(scribbles).toContain(n);
    });

    it('Sticky Note applies fixedWidth + targetWidth', () => {
        const { deps } = makeDeps();
        const n = recreate2DShape({ type: 'Sticky Note', x: 0, y: 0, targetWidth: 7 }, deps) as unknown as Record<string, unknown>;
        expect(n.fixedWidth).toBe(true);
        expect(n.w).toBe(7);
    });

    it('returns null for Group, 3D, and unknown types (caller handles them)', () => {
        const { deps } = makeDeps();
        expect(recreate2DShape({ type: 'Group' }, deps)).toBeNull();
        expect(recreate2DShape({ type: '3DMesh' }, deps)).toBeNull();
        expect(recreate2DShape({ type: '3DMeshGroup' }, deps)).toBeNull();
        expect(recreate2DShape({ type: 'WhoKnows' }, deps)).toBeNull();
    });
});
