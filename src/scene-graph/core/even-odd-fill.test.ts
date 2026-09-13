import { describe, it, expect } from 'vitest';
import { evenOddFillGeometry } from './even-odd-fill';
import type { Pt } from './bezier';

const P = (x: number, y: number): Pt => ({ x, y });

/** Total signed-area magnitude of the emitted triangles. */
function area(g: { verts: Float32Array; indices: Uint16Array }): number {
    let sum = 0;
    for (let i = 0; i + 2 < g.indices.length || i + 2 === g.indices.length; i += 3) {
        if (i + 2 >= g.indices.length) break;
        const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
        const ax = g.verts[a * 2], ay = g.verts[a * 2 + 1];
        const bx = g.verts[b * 2], by = g.verts[b * 2 + 1];
        const cx = g.verts[c * 2], cy = g.verts[c * 2 + 1];
        sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    return sum;
}

/** Is point q inside any emitted triangle? */
function covered(g: { verts: Float32Array; indices: Uint16Array }, q: Pt): boolean {
    for (let i = 0; i + 2 < g.indices.length; i += 3) {
        const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
        const ax = g.verts[a * 2], ay = g.verts[a * 2 + 1];
        const bx = g.verts[b * 2], by = g.verts[b * 2 + 1];
        const cx = g.verts[c * 2], cy = g.verts[c * 2 + 1];
        const s1 = (bx - ax) * (q.y - ay) - (by - ay) * (q.x - ax);
        const s2 = (cx - bx) * (q.y - by) - (cy - by) * (q.x - bx);
        const s3 = (ax - cx) * (q.y - cy) - (ay - cy) * (q.x - cx);
        const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
        const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
        if (!(hasNeg && hasPos)) return true;
    }
    return false;
}

/** Independent even-odd test: standard crossing-count ray cast on the ring. */
function ringEvenOdd(ring: Pt[], q: Pt): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Distance from q to the nearest ring edge (to skip boundary-hugging samples). */
function distToRing(ring: Pt[], q: Pt): number {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / L2));
        best = Math.min(best, Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t)));
    }
    return best;
}

describe('evenOddFillGeometry — simple rings', () => {
    it('a rectangle fills exactly (area, coverage in/out)', () => {
        const g = evenOddFillGeometry([P(0, 0), P(4, 0), P(4, 3), P(0, 3)])!;
        expect(g).toBeTruthy();
        expect(area(g)).toBeCloseTo(12, 9);
        expect(covered(g, P(2, 1.5))).toBe(true);
        expect(covered(g, P(5, 1.5))).toBe(false);
        expect(g.indices.length % 2).toBe(0);              // 4-byte aligned
    });

    it('a convex pentagon matches the shoelace area', () => {
        const ring: Pt[] = [];
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * 2 * Math.PI - Math.PI / 2;
            ring.push(P(Math.cos(a) * 2, Math.sin(a) * 2));
        }
        let shoelace = 0;
        for (let i = 0; i < 5; i++) {
            const p = ring[i], q = ring[(i + 1) % 5];
            shoelace += p.x * q.y - q.x * p.y;
        }
        const g = evenOddFillGeometry(ring)!;
        expect(area(g)).toBeCloseTo(Math.abs(shoelace) / 2, 6);
    });

    it('a CONCAVE ring leaves the notch empty (L-shape)', () => {
        const g = evenOddFillGeometry([P(0, 0), P(4, 0), P(4, 2), P(2, 2), P(2, 4), P(0, 4)])!;
        expect(area(g)).toBeCloseTo(12, 9);                // 4×4 minus the 2×2 notch
        expect(covered(g, P(3, 3))).toBe(false);           // inside the notch
        expect(covered(g, P(1, 3))).toBe(true);
    });
});

describe('evenOddFillGeometry — self-intersection (the whole point)', () => {
    it('bowtie: two lobes filled, the waist gap empty', () => {
        // (0,0)→(4,4)→(4,0)→(0,4): crosses itself at (2,2).
        const g = evenOddFillGeometry([P(0, 0), P(4, 4), P(4, 0), P(0, 4)])!;
        expect(area(g)).toBeCloseTo(8, 6);                 // two triangles of area 4
        expect(covered(g, P(0.5, 2))).toBe(true);          // left lobe
        expect(covered(g, P(3.5, 2))).toBe(true);          // right lobe
        expect(covered(g, P(2, 0.5))).toBe(false);         // below the crossing — outside both lobes
        expect(covered(g, P(2, 3.5))).toBe(false);
    });

    it('pentagram: the classic even-odd HOLLOW CENTER', () => {
        // 5-point star drawn by connecting every 2nd vertex of a pentagon — self-intersects 5 times.
        const ring: Pt[] = [];
        for (let i = 0; i < 5; i++) {
            const a = ((i * 2) % 5 / 5) * 2 * Math.PI - Math.PI / 2;
            ring.push(P(Math.cos(a) * 2, Math.sin(a) * 2));
        }
        const g = evenOddFillGeometry(ring)!;
        expect(covered(g, P(0, 0))).toBe(false);           // center pentagon is a HOLE
        // Each star point (near an outer vertex, pulled slightly inward) is filled.
        for (const v of ring) {
            expect(covered(g, P(v.x * 0.9, v.y * 0.9))).toBe(true);
        }
        // THE contract: triangle coverage ≡ the even-odd rule on the ring, everywhere. Sample a
        // deterministic pseudo-random cloud; skip points hugging an edge (boundary is ties either way).
        let checked = 0;
        let seed = 42;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < 500; i++) {
            const q = P(rnd() * 5 - 2.5, rnd() * 5 - 2.5);
            if (distToRing(ring, q) < 0.02) continue;
            expect(covered(g, q)).toBe(ringEvenOdd(ring, q));
            checked++;
        }
        expect(checked).toBeGreaterThan(400);
    });
});

describe('evenOddFillGeometry — degenerate input', () => {
    it('fewer than 3 points, or an all-collinear ring, yields null', () => {
        expect(evenOddFillGeometry([P(0, 0), P(1, 1)])).toBeNull();
        expect(evenOddFillGeometry([P(0, 0), P(2, 0), P(4, 0)])).toBeNull();
    });
});
