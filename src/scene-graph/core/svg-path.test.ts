import { describe, it, expect } from 'vitest';
import { parseSVGPath, arcToCubics } from './svg-path';
import { cubicPoint, type Pt } from './bezier';

describe('parseSVGPath — basics', () => {
    it('M/L/Z triangle → one closed subpath of corner anchors', () => {
        const [s] = parseSVGPath('M 0 0 L 10 0 L 10 8 Z');
        expect(s.closed).toBe(true);
        expect(s.anchors).toEqual([
            { x: 0, y: 0, in: undefined, out: undefined, kind: 'corner' },
            { x: 10, y: 0, in: undefined, out: undefined, kind: 'corner' },
            { x: 10, y: 8, in: undefined, out: undefined, kind: 'corner' },
        ]);
    });

    it('implicit lineto after moveto; relative commands; H/V', () => {
        const [s] = parseSVGPath('m 1 1 2 0 h 3 v 4 l -2 1');
        expect(s.closed).toBe(false);
        expect(s.anchors.map((a) => [a.x, a.y])).toEqual([[1, 1], [3, 1], [6, 1], [6, 5], [4, 6]]);
    });

    it('multiple subpaths split into separate results', () => {
        const subs = parseSVGPath('M0 0 L1 0 L1 1 Z M5 5 L6 5');
        expect(subs).toHaveLength(2);
        expect(subs[0].closed).toBe(true);
        expect(subs[1].closed).toBe(false);
        expect(subs[1].anchors[0]).toMatchObject({ x: 5, y: 5 });
    });

    it('scientific notation and packed negative numbers', () => {
        const [s] = parseSVGPath('M1e1 0L1.5-2.5');
        expect(s.anchors.map((a) => [a.x, a.y])).toEqual([[10, 0], [1.5, -2.5]]);
    });
});

describe('parseSVGPath — curves', () => {
    it('C controls become out/in handle OFFSETS on the segment anchors', () => {
        const [s] = parseSVGPath('M 0 0 C 1 2, 3 2, 4 0');
        expect(s.anchors[0].out).toEqual({ x: 1, y: 2 });
        expect(s.anchors[1].in).toEqual({ x: -1, y: 2 });   // c2 (3,2) − anchor (4,0)
        expect(s.anchors[0].kind).toBe('cusp');             // out only — no mirror to compare
    });

    it('S reflects the previous cubic control → smooth join at the shared anchor', () => {
        const [s] = parseSVGPath('M 0 0 C 1 2, 3 2, 4 0 S 7 -2, 8 0');
        const joint = s.anchors[1];
        // in = (3,2)−(4,0) = (−1,2); reflected out = (5,−2)−(4,0) = (1,−2) = exact mirror.
        expect(joint.in).toEqual({ x: -1, y: 2 });
        expect(joint.out).toEqual({ x: 1, y: -2 });
        expect(joint.kind).toBe('smooth');
    });

    it('Q elevates to a cubic tracing the IDENTICAL curve', () => {
        const [s] = parseSVGPath('M 0 0 Q 2 4, 4 0');
        const a = s.anchors[0], b = s.anchors[1];
        const p0: Pt = { x: a.x, y: a.y };
        const c1: Pt = { x: a.x + a.out!.x, y: a.y + a.out!.y };
        const c2: Pt = { x: b.x + b.in!.x, y: b.y + b.in!.y };
        const p3: Pt = { x: b.x, y: b.y };
        for (let i = 0; i <= 10; i++) {
            const t = i / 10;
            const q = {   // quadratic direct evaluation
                x: (1 - t) ** 2 * 0 + 2 * (1 - t) * t * 2 + t * t * 4,
                y: (1 - t) ** 2 * 0 + 2 * (1 - t) * t * 4 + t * t * 0,
            };
            const c = cubicPoint(p0, c1, c2, p3, t);
            expect(c.x).toBeCloseTo(q.x, 9);
            expect(c.y).toBeCloseTo(q.y, 9);
        }
    });

    it('a two-arc circle closes into a 2-anchor ring with handles (Z merges the terminal point)', () => {
        // Circle r=5 centered (5,0): standard two-A form.
        const [s] = parseSVGPath('M 0 0 A 5 5 0 1 1 10 0 A 5 5 0 1 1 0 0 Z');
        expect(s.closed).toBe(true);
        // Half-circle arcs split into 90° slices → intermediate anchors + the two endpoints, terminal merged.
        expect(s.anchors.length).toBeGreaterThanOrEqual(2);
        expect(s.anchors[0].in).toBeTruthy();               // merged terminal handle landed on the first anchor
        expect(s.anchors[0].out).toBeTruthy();
        // Every anchor sits on the circle.
        for (const a of s.anchors) {
            expect(Math.hypot(a.x - 5, a.y - 0)).toBeCloseTo(5, 6);
        }
    });
});

describe('arcToCubics — accuracy', () => {
    it('quarter-circle arc stays within 1e-3·r of the true circle', () => {
        // Unit circle centered (0,1): from (0,0) to (1,1), sweep=1.
        const segs = arcToCubics({ x: 0, y: 0 }, { x: 1, y: 1 }, 1, 1, 0, 0, 1);
        expect(segs).toHaveLength(1);
        let p0: Pt = { x: 0, y: 0 };
        for (const [c1, c2, p3] of segs) {
            for (let i = 0; i <= 20; i++) {
                const q = cubicPoint(p0, c1, c2, p3, i / 20);
                expect(Math.hypot(q.x - 0, q.y - 1)).toBeCloseTo(1, 3);
            }
            p0 = p3;
        }
    });

    it('compressed arc flags parse ("a1 1 0 011 0" style)', () => {
        const [s] = parseSVGPath('M0 0a1 1 0 011 1');
        const last = s.anchors[s.anchors.length - 1];
        expect(last.x).toBeCloseTo(1, 9);
        expect(last.y).toBeCloseTo(1, 9);
    });

    it('zero radius degrades to a straight segment (spec rule)', () => {
        const [[c1, c2, e]] = arcToCubics({ x: 0, y: 0 }, { x: 3, y: 0 }, 0, 5, 0, 0, 1);
        expect(e).toEqual({ x: 3, y: 0 });
        expect(c1.y).toBe(0);
        expect(c2.y).toBe(0);
    });
});

describe('parseSVGPath — edge cases', () => {
    it('drawing after Z continues from the subpath start (implicit new subpath)', () => {
        const subs = parseSVGPath('M0 0 L4 0 L4 4 Z L0 4');
        expect(subs).toHaveLength(2);
        expect(subs[1].anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [0, 4]]);
    });

    it('degenerate inputs: lone moveto yields nothing; garbage throws', () => {
        expect(parseSVGPath('M 3 3')).toEqual([]);
        expect(() => parseSVGPath('L 1 1')).toThrow();      // no leading moveto
        expect(() => parseSVGPath('M 0 0 X 1 1')).toThrow();
    });
});
