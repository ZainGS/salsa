import { describe, it, expect } from 'vitest';
import { MeshBVH } from './mesh-bvh';
import { FLOATS_PER_VERT } from './mesh-generators';

// performance-plan P10.D: the BVH build precomputes triangle centroids (it recomputed them in the sort comparator).
// The tree must still return exactly the brute-force nearest hit, and a city-tile-sized layer must build fast.

function soup(nTri: number, seed: number): { v: Float32Array; ix: Uint32Array } {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const v = new Float32Array(nTri * 3 * FLOATS_PER_VERT), ix = new Uint32Array(nTri * 3);
    for (let t = 0; t < nTri; t++) {
        const cx = rnd() * 100, cy = rnd() * 10, cz = rnd() * 100;
        for (let k = 0; k < 3; k++) {
            const o = (t * 3 + k) * FLOATS_PER_VERT;
            v[o] = cx + rnd() - 0.5; v[o + 1] = cy + rnd() - 0.5; v[o + 2] = cz + rnd() - 0.5;
            ix[t * 3 + k] = t * 3 + k;
        }
    }
    return { v, ix };
}
function brute(v: Float32Array, ix: Uint32Array, o: number[], d: number[]): number {
    let best = Infinity;
    const S = FLOATS_PER_VERT;
    for (let t = 0; t < ix.length / 3; t++) {
        const a = ix[t * 3] * S, b = ix[t * 3 + 1] * S, c = ix[t * 3 + 2] * S;
        const e1 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]], e2 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
        const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
        if (Math.abs(det) < 1e-7) continue;
        const f = 1 / det, sx = o[0] - v[a], sy = o[1] - v[a + 1], sz = o[2] - v[a + 2];
        const u = f * (sx * h[0] + sy * h[1] + sz * h[2]); if (u < 0 || u > 1) continue;
        const q = [sy * e1[2] - sz * e1[1], sz * e1[0] - sx * e1[2], sx * e1[1] - sy * e1[0]];
        const w = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]); if (w < 0 || u + w > 1) continue;
        const tt = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
        if (tt > 1e-7 && tt < best) best = tt;
    }
    return best;
}

describe('MeshBVH build (precomputed centroids)', () => {
    it('returns the brute-force nearest hit for random rays', () => {
        const { v, ix } = soup(20000, 7);
        const bvh = MeshBVH.build(v, ix);
        let hits = 0;
        for (let r = 0; r < 300; r++) {
            const o = [(r * 37) % 100, 30, (r * 53) % 100], d = [0.05 * Math.sin(r), -1, 0.05 * Math.cos(r)];
            const n = Math.hypot(d[0], d[1], d[2]); d[0] /= n; d[1] /= n; d[2] /= n;
            const h = bvh.intersect(o[0], o[1], o[2], d[0], d[1], d[2]);
            const b = brute(v, ix, o, d);
            if (b === Infinity) expect(h).toBeNull();
            else { expect(h).not.toBeNull(); expect(h!.t).toBeCloseTo(b, 4); hits++; }
        }
        expect(hits).toBeGreaterThan(30);
    });
    it('builds a tile-layer-sized mesh (180 k triangles) quickly', () => {
        const { v, ix } = soup(180_000, 3);
        const t0 = performance.now();
        MeshBVH.build(v, ix);
        expect(performance.now() - t0).toBeLessThan(1500);   // generous for CI; ~0.4 s+ before in the browser
    });
});
