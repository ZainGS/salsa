import { describe, it, expect } from 'vitest';
import { simplifyMesh, simplifyGeometry } from './mesh-simplify';
import type { V3 } from './sdf-mesh';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

/** An icosphere by subdividing an octahedron `subdiv`× (verts pushed to the unit sphere) — a clean closed manifold. */
function icosphere(subdiv: number): { verts: V3[]; tris: [number, number, number][] } {
    let verts: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    let tris: [number, number, number][] = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    for (let s = 0; s < subdiv; s++) {
        const mid = new Map<string, number>(); const nt: [number, number, number][] = [];
        const getMid = (a: number, b: number): number => {
            const k = Math.min(a, b) + '_' + Math.max(a, b);
            const hit = mid.get(k); if (hit !== undefined) return hit;
            const m: V3 = [(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2];
            const l = Math.hypot(m[0], m[1], m[2]); const idx = verts.length; verts.push([m[0] / l, m[1] / l, m[2] / l]); mid.set(k, idx); return idx;
        };
        for (const [a, b, c] of tris) { const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a); nt.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]); }
        tris = nt;
    }
    return { verts, tris };
}

const inwardFaces = (positions: V3[], tris: [number, number, number][]): number => {
    // For a sphere centred at the origin, an outward face has its normal pointing away from the centroid.
    let inward = 0;
    for (const [a, b, c] of tris) {
        const p0 = positions[a], p1 = positions[b], p2 = positions[c];
        const e1: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2: V3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const cx = (p0[0] + p1[0] + p2[0]) / 3, cy = (p0[1] + p1[1] + p2[1]) / 3, cz = (p0[2] + p1[2] + p2[2]) / 3;
        if (n[0] * cx + n[1] * cy + n[2] * cz < 0) inward++;
    }
    return inward;
};

describe('mesh-simplify (QEM decimation)', () => {
    const { verts, tris } = icosphere(4);   // 2048 tris

    it('hits the target triangle ratio (±a little)', () => {
        for (const ratio of [0.5, 0.3, 0.1]) {
            const r = simplifyMesh(verts, tris, ratio);
            const got = r.tris.length / tris.length;
            expect(Math.abs(got - ratio)).toBeLessThan(0.06);
        }
    });

    it('PRESERVES the silhouette (verts stay on the unit sphere) and never flips a face', () => {
        const r = simplifyMesh(verts, tris, 0.15);
        for (const p of r.positions) {
            const l = Math.hypot(p[0], p[1], p[2]);
            expect(Number.isFinite(l)).toBe(true);
            expect(l).toBeGreaterThan(0.95);   // no vertex sucked inward
            expect(l).toBeLessThan(1.05);      // no vertex blown outward
        }
        expect(inwardFaces(r.positions, r.tris)).toBe(0);   // no inversions/spikes
    });

    it('drops no vertex that a surviving face references, and emits no degenerate faces', () => {
        const r = simplifyMesh(verts, tris, 0.25);
        for (const [a, b, c] of r.tris) {
            expect(a).toBeLessThan(r.positions.length); expect(b).toBeLessThan(r.positions.length); expect(c).toBeLessThan(r.positions.length);
            expect(a === b || b === c || a === c).toBe(false);
        }
    });

    it('is deterministic and a no-op at ratio ≥ 1', () => {
        const a = simplifyMesh(verts, tris, 0.3), b = simplifyMesh(verts, tris, 0.3);
        expect(a.tris.length).toBe(b.tris.length);
        expect(a.positions.length).toBe(b.positions.length);
        const noop = simplifyMesh(verts, tris, 1);
        expect(noop.tris.length).toBe(tris.length);
    });

    it('simplifyGeometry reduces a 12-float MeshGeometry and returns renderer-ready 12-float', () => {
        // Build a 12-float geometry (positions only matter) from the icosphere.
        const S = FLOATS_PER_VERT;
        const v = new Float32Array(verts.length * S);
        for (let i = 0; i < verts.length; i++) { v[i * S] = verts[i][0]; v[i * S + 1] = verts[i][1]; v[i * S + 2] = verts[i][2]; }
        const idx = new Uint32Array(tris.length * 3);
        let k = 0; for (const t of tris) { idx[k++] = t[0]; idx[k++] = t[1]; idx[k++] = t[2]; }
        const out = simplifyGeometry({ vertices: v, indices: idx, format: '12float' }, 0.3);
        expect(out.format).toBe('12float');
        expect(out.vertices.length % S).toBe(0);
        expect(out.indices.length).toBeLessThan(idx.length * 0.5);
        expect(out.indices.length).toBeGreaterThan(0);
    });
});
