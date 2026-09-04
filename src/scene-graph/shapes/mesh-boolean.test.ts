import { describe, it, expect } from 'vitest';
import { booleanMesh, type Tri, type V3 } from './mesh-boolean';

/** An axis-aligned box [cx±hx, cy±hy, cz±hz] as 12 triangles (CCW outward). */
function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Tri[] {
    const c: V3[] = [];
    for (let i = 0; i < 8; i++) c.push([cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz)]);
    // faces as vertex-index quads (outward CCW), each split into 2 tris
    const quads: [number, number, number, number][] = [
        [0, 2, 3, 1],   // -z? just need a closed manifold; winding consistency matters less for volume checks
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
    ];
    const tris: Tri[] = [];
    for (const [a, b, d, e] of quads) { tris.push({ a: c[a], b: c[b], c: c[d] }); tris.push({ a: c[a], b: c[d], c: c[e] }); }
    return tris;
}

const bounds = (r: { positions: V3[] }) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [x, y, z] of r.positions) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return { x0, y0, z0, x1, y1, z1 };
};

describe('booleanMesh (CSG)', () => {
    it('union of two overlapping boxes spans the combined extent', () => {
        const r = booleanMesh(box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 1, 1, 1), 'union');
        expect(r.positions.length).toBeGreaterThan(0);
        const b = bounds(r);
        expect(b.x0).toBeCloseTo(-1, 4);   // spans from A's left…
        expect(b.x1).toBeCloseTo(2, 4);    // …to B's right
    });

    it('subtract removes the overlap (A minus B is narrower on the B side)', () => {
        // B covers x∈[0,2]; A is x∈[-1,1]. A − B should keep only x∈[-1,0].
        const r = booleanMesh(box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 1, 1, 1), 'subtract');
        expect(r.positions.length).toBeGreaterThan(0);
        const b = bounds(r);
        expect(b.x0).toBeCloseTo(-1, 4);
        expect(b.x1).toBeLessThan(0.001);   // nothing remains past the cut plane at x=0
    });

    it('intersect keeps only the overlap region', () => {
        const r = booleanMesh(box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 1, 1, 1), 'intersect');
        expect(r.positions.length).toBeGreaterThan(0);
        const b = bounds(r);
        expect(b.x0).toBeCloseTo(0, 4);   // the overlap is x∈[0,1]
        expect(b.x1).toBeCloseTo(1, 4);
    });

    it('disjoint boxes: intersect is empty, union keeps both', () => {
        const inter = booleanMesh(box(0, 0, 0, 1, 1, 1), box(5, 0, 0, 1, 1, 1), 'intersect');
        expect(inter.positions.length).toBe(0);
        const uni = booleanMesh(box(0, 0, 0, 1, 1, 1), box(5, 0, 0, 1, 1, 1), 'union');
        expect(uni.positions.length).toBeGreaterThan(0);
    });

    it('emits 3 positions + 3 normals per triangle (well-formed output)', () => {
        const r = booleanMesh(box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 1, 1, 1), 'union');
        expect(r.positions.length).toBe(r.normals.length);
        expect(r.positions.length % 3).toBe(0);
        for (const [nx, ny, nz] of r.normals) expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(1e-4);
    });
});
