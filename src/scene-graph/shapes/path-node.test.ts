import { describe, it, expect } from 'vitest';
import { PathNode, type PathAnchor } from './path-node';
import type { InteractionService } from '../../services/interaction-service';

// Base Node.toJSON touches the browser `self.crypto.randomUUID` — polyfill for the Node test env.
const g = globalThis as unknown as { self?: { crypto?: { randomUUID?: () => string } } };
g.self ??= g as never;
let uuidN = 0;
(g.self.crypto ??= {} as never).randomUUID ??= () => `test-uuid-${uuidN++}`;

const isvc = { getViewportCenter: () => [0, 0] } as unknown as InteractionService;
const FILL = { r: 1, g: 1, b: 1, a: 1 };
const STROKE = { r: 0, g: 0, b: 0, a: 1 };

const corner = (x: number, y: number): PathAnchor => ({ x, y, kind: 'corner' });
const smooth = (x: number, y: number, ox: number, oy: number): PathAnchor =>
    ({ x, y, out: { x: ox, y: oy }, in: { x: -ox, y: -oy }, kind: 'smooth' });

const mkPath = (anchors: PathAnchor[], closed = true, strokeWidth = 0.01) => {
    const p = new PathNode(anchors, closed, FILL, STROKE, strokeWidth, isvc);
    p.finalizeInitialization();
    return p;
};

describe('PathNode — tessellation', () => {
    it('a corner-only closed path flattens to exactly its anchor ring', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 3)]);
        expect(p.flattenedPoints()).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]);
    });

    it('a smooth anchor curves BOTH adjacent segments (more points than anchors)', () => {
        const p = mkPath([corner(0, 0), smooth(4, 0, 0, 2), corner(4, 4)]);
        const flat = p.flattenedPoints();
        expect(flat.length).toBeGreaterThan(6);
        // Endpoints of the curved run still hit the anchors exactly.
        expect(flat[0]).toEqual({ x: 0, y: 0 });
        expect(flat.some((q) => Math.hypot(q.x - 4, q.y - 0) < 1e-9)).toBe(true);
    });

    it('caches by anchorsVersion and retessellates after setAnchors', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 3)]);
        const a = p.flattenedPoints();
        expect(p.flattenedPoints()).toBe(a);                       // same object = cached
        p.setAnchors([corner(0, 0), corner(9, 0), corner(9, 5)]);
        const b = p.flattenedPoints();
        expect(b).not.toBe(a);
        expect(b[1]).toEqual({ x: 9, y: 0 });
    });
});

describe('PathNode — render geometry', () => {
    it('closed: raw flattened verts + ear-clip triangle indices (4-byte aligned)', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 3), corner(0, 3)]);
        const verts = p.getGeometryVertices();
        const idx = p.getGeometryIndices()!;
        expect(verts.length).toBe(8);                              // 4 points × 2
        expect(idx.length % 2).toBe(0);                            // Uint16 pairs → 4-byte aligned
        expect(idx.length).toBeGreaterThanOrEqual(6);              // 2 triangles
    });

    it('open: stroke quad-strip (8 floats + 6 indices per segment)', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(8, 0)], false, 0.2);
        const verts = p.getGeometryVertices();
        const idx = p.getGeometryIndices()!;
        expect(verts.length).toBe(16);                             // 2 segments × 8
        expect(idx.slice(0, 6)).toEqual(new Uint16Array([0, 1, 2, 1, 2, 3]));
        // Quad expanded by half the stroke width around the horizontal line.
        expect(Math.abs(verts[1])).toBeCloseTo(0.1, 5);
    });
});

describe('PathNode — hit-testing + bounds', () => {
    it('closed: containsPoint is even-odd on the flattened ring', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 4), corner(0, 4)]);
        expect(p.containsPoint(2, 2)).toBe(true);
        expect(p.containsPoint(5, 2)).toBe(false);
    });

    it('open: containsPoint hits near the stroke, misses far away', () => {
        const p = mkPath([corner(0, 0), corner(4, 0)], false, 0.2);
        expect(p.containsPoint(2, 0.05)).toBe(true);
        expect(p.containsPoint(2, 1)).toBe(false);
    });

    it('the world bbox covers a curve belly that extends past its anchors', () => {
        // Semi-circle-ish bulge upward between (0,0) and (4,0): the belly's y > 0 must be inside the box.
        const p = mkPath([smooth(0, 0, 0, 2), smooth(4, 0, 0, -2)], true);
        const world = p.getWorldSpaceBoundingBoxPolygon(true);
        const maxY = Math.max(...world.map((q) => q[1]));
        expect(maxY).toBeGreaterThan(1);                           // curve rises well above the anchor line
    });
});

describe('PathNode — persistence shape', () => {
    it('toJSON carries anchors (with handles) + closed, and type "Path"', () => {
        const p = mkPath([corner(0, 0), smooth(4, 0, 1, 1)], true);
        const j = p.toJSON() as { type: string; closed: boolean; anchors: PathAnchor[] };
        expect(j.type).toBe('Path');
        expect(j.closed).toBe(true);
        expect(j.anchors).toHaveLength(2);
        expect(j.anchors[1].out).toEqual({ x: 1, y: 1 });
        expect(j.anchors[1].in).toEqual({ x: -1, y: -1 });
        // Round-trip through plain JSON → a reconstructed node tessellates identically.
        const r = mkPath(JSON.parse(JSON.stringify(j.anchors)), j.closed);
        expect(r.flattenedPoints()).toEqual(p.flattenedPoints());
    });
});

describe('PathNode — node-editor mutations', () => {
    it('moveAnchor relocates the point, bumps the version, and retessellates', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 4)]);
        const v0 = p.anchorsVersion;
        p.moveAnchor(1, 6, 1);
        expect(p.anchors[1]).toMatchObject({ x: 6, y: 1 });
        expect(p.anchorsVersion).toBe(v0 + 1);
        expect(p.flattenedPoints()[1]).toEqual({ x: 6, y: 1 });
    });

    it('setHandle mirrors on smooth anchors and breaks to cusp when unmirrored', () => {
        const p = mkPath([corner(0, 0), smooth(4, 0, 1, 1), corner(4, 4)]);
        p.setHandle(1, 'out', { x: 2, y: 0 }, true);
        expect(p.anchors[1].in).toEqual({ x: -2, y: 0 });     // mirrored
        expect(p.anchors[1].kind).toBe('smooth');
        p.setHandle(1, 'out', { x: 0, y: 3 }, false);         // Alt-drag
        expect(p.anchors[1].in).toEqual({ x: -2, y: 0 });     // untouched
        expect(p.anchors[1].kind).toBe('cusp');
    });

    it('insertAnchorOnSegment splits a CURVED segment without changing the curve', () => {
        const p = mkPath([smooth(0, 0, 2, 2), smooth(8, 0, 2, -2), corner(4, -6)]);
        const before = p.flattenedPoints().map((q) => ({ ...q }));
        const idx = p.insertAnchorOnSegment(0, 0.4);
        expect(idx).toBe(1);
        expect(p.anchors.length).toBe(4);
        const after = p.flattenedPoints();
        // Every pre-split sample still lies (within tolerance) on the post-split outline.
        const segDist = (q: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
            const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
            const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / L2));
            return Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t));
        };
        for (const q of before) {
            let best = Infinity;
            for (let s = 0; s < after.length; s++) best = Math.min(best, segDist(q, after[s], after[(s + 1) % after.length]));
            expect(best).toBeLessThan(0.02);
        }
    });

    it('inserting on a STRAIGHT segment adds a corner anchor on the line', () => {
        const p = mkPath([corner(0, 0), corner(8, 0), corner(4, 6)]);
        const idx = p.insertAnchorOnSegment(0, 0.5);
        expect(p.anchors[idx]).toMatchObject({ x: 4, y: 0, kind: 'corner' });
        expect(p.anchors[idx].in ?? null).toBeNull();
    });

    it('removeAnchor heals and refuses below the minimum', () => {
        const p = mkPath([corner(0, 0), corner(4, 0), corner(4, 4), corner(0, 4)]);
        expect(p.removeAnchor(2)).toBe(true);
        expect(p.anchors.length).toBe(3);
        expect(p.removeAnchor(0)).toBe(false);                // closed minimum = 3
    });
});
