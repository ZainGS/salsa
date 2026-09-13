import { describe, it, expect } from 'vitest';
import { cubicPoint, flattenCubic, sampleCubic, penEdgeControls, splitCubic, nearestTOnCubic, type Pt } from './bezier';

const P = (x: number, y: number): Pt => ({ x, y });

describe('cubicPoint', () => {
    it('hits the endpoints at t=0 and t=1', () => {
        const [p0, c1, c2, p3] = [P(0, 0), P(1, 2), P(3, 2), P(4, 0)];
        expect(cubicPoint(p0, c1, c2, p3, 0)).toEqual(p0);
        expect(cubicPoint(p0, c1, c2, p3, 1)).toEqual(p3);
    });
});

describe('flattenCubic — adaptive De Casteljau', () => {
    it('a degenerate (collinear-control) cubic flattens to a single segment', () => {
        const pts = flattenCubic(P(0, 0), P(1, 0), P(3, 0), P(4, 0), 0.01);
        expect(pts).toEqual([P(4, 0)]);   // excludes p0, includes p3
    });

    it('stays within the flatness tolerance of the true curve', () => {
        const [p0, c1, c2, p3] = [P(0, 0), P(0, 3), P(6, 3), P(6, 0)];
        const tol = 0.02;
        const pts = [p0, ...flattenCubic(p0, c1, c2, p3, tol)];
        // Every densely-sampled true-curve point must be within ~tol of the polyline.
        const segDist = (q: Pt, a: Pt, b: Pt) => {
            const vx = b.x - a.x, vy = b.y - a.y;
            const L2 = vx * vx + vy * vy || 1;
            const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / L2));
            return Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t));
        };
        for (let i = 0; i <= 200; i++) {
            const q = cubicPoint(p0, c1, c2, p3, i / 200);
            let best = Infinity;
            for (let s = 0; s + 1 < pts.length; s++) best = Math.min(best, segDist(q, pts[s], pts[s + 1]));
            expect(best).toBeLessThan(tol * 1.5);   // flatness bound ⇒ deviation ≲ tol
        }
        expect(pts.length).toBeGreaterThan(4);       // actually subdivided
    });

    it('tighter tolerance ⇒ more points; loop segments (p0≈p3) terminate', () => {
        const args = [P(0, 0), P(0, 3), P(6, 3), P(6, 0)] as const;
        expect(flattenCubic(...args, 0.005).length).toBeGreaterThan(flattenCubic(...args, 0.5).length);
        const loop = flattenCubic(P(0, 0), P(4, 4), P(-4, 4), P(0, 0), 0.01);
        expect(loop.length).toBeGreaterThan(2);      // degenerate chord handled, no hang
        expect(loop.length).toBeLessThan(1 << 17);   // depth-capped
    });
});

describe('sampleCubic + penEdgeControls', () => {
    it('sampleCubic returns n+1 points including both endpoints', () => {
        const pts = sampleCubic(P(0, 0), P(1, 1), P(2, 1), P(3, 0), 8);
        expect(pts.length).toBe(9);
        expect(pts[0]).toEqual(P(0, 0));
        expect(pts[8]).toEqual(P(3, 0));
    });

    it('penEdgeControls mirrors B.out into the in-handle and collapses null handles', () => {
        const { c1, c2, curved } = penEdgeControls(P(0, 0), P(1, 0), P(10, 0), P(2, 0));
        expect(c1).toEqual(P(1, 0));      // a + aOut
        expect(c2).toEqual(P(8, 0));      // b − bOut (mirror)
        expect(curved).toBe(true);
        const straight = penEdgeControls(P(0, 0), null, P(10, 0), null);
        expect(straight.c1).toEqual(P(0, 0));
        expect(straight.c2).toEqual(P(10, 0));
        expect(straight.curved).toBe(false);
    });
});

describe('splitCubic + nearestTOnCubic (node-editor insert)', () => {
    const [p0, c1, c2, p3] = [P(0, 0), P(1, 3), P(5, 3), P(6, 0)];

    it('splitting is EXACT: both halves reproduce the original curve', () => {
        const t0 = 0.37;
        const { left, right } = splitCubic(p0, c1, c2, p3, t0);
        for (let i = 0; i <= 20; i++) {
            const u = i / 20;
            const orig = cubicPoint(p0, c1, c2, p3, u);
            const half = u <= t0
                ? cubicPoint(left[0], left[1], left[2], left[3], u / t0)
                : cubicPoint(right[0], right[1], right[2], right[3], (u - t0) / (1 - t0));
            expect(half.x).toBeCloseTo(orig.x, 9);
            expect(half.y).toBeCloseTo(orig.y, 9);
        }
        expect(left[3]).toEqual(right[0]);   // shared midpoint
    });

    it('nearestTOnCubic finds the closest parameter', () => {
        const q = cubicPoint(p0, c1, c2, p3, 0.62);
        const { t, dist } = nearestTOnCubic(p0, c1, c2, p3, q);
        expect(t).toBeCloseTo(0.62, 3);
        expect(dist).toBeLessThan(1e-3);
    });
});
