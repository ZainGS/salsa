/**
 * src/renderer/3d/cull-clusters.test.ts — P9 hierarchical cull clusters (performance-plan P9).
 *
 * The clusters only ever reject what the per-mesh tests would have rejected: a cluster's box contains every member's
 * box, and a cluster that fails the camera frustum (and the light box, or the shadow-reach test) has no member that
 * passes it. The object-argument frustum helpers return exactly what the six-number ones do.
 */

import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { buildCullClusters, clusterVerdict, HC_PASS, HC_OUT, HC_NOREACH, type ClusterMember, type ClusterBox } from './cull-clusters';
import { FrustumCuller, shadowReachesView, shadowReachesViewBox } from './frustum-culler';
import { twinDraws } from './distance-lod';

type M = ClusterMember & { box: ClusterBox; ok: boolean; ver: number };
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function scene(n: number, seed = 1): M[] {
    const r = rng(seed), out: M[] = [];
    for (let i = 0; i < n; i++) {
        const x = (r() - 0.5) * 200, z = (r() - 0.5) * 200, w = r() < 0.05 ? 40 + r() * 160 : 0.2 + r() * 4, h = r() * 10;
        out.push({ box: { minX: x, minY: 0, minZ: z, maxX: x + w, maxY: h, maxZ: z + w * (0.3 + r()) }, ok: r() > 0.05, ver: 1, _hcC: null, _hcVer: -1, _hcB: -1 });
    }
    return out;
}
function culler(eye: [number, number, number], at: [number, number, number], fovDeg = 50): FrustumCuller {
    const vp = mat4.multiply(mat4.create(), mat4.perspectiveZO(mat4.create(), (fovDeg * Math.PI) / 180, 1.5, 0.1, 400), mat4.lookAt(mat4.create(), eye, at, [0, 1, 0]));
    return new FrustumCuller().setFromViewProjection(vp as unknown as Float32Array);
}
const arr = (b: ClusterBox): Float64Array => Float64Array.of(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);

describe('buildCullClusters', () => {
    it('clusters every eligible mesh (wide ones in coarser levels) and each cluster box contains its members', () => {
        const ms = scene(3000), owner = {};
        const n = buildCullClusters(owner, ms, (m) => m.box, (m) => m.ok, (m) => m.ver);
        expect(n).toBe(ms.filter((m) => m.ok).length);
        for (const m of ms) {
            if (!m.ok) { expect(m._hcC).toBeNull(); continue; }
            const B = m._hcC!.box, b = m.box;
            expect(B[0] <= b.minX && B[1] <= b.minY && B[2] <= b.minZ && B[3] >= b.maxX && B[4] >= b.maxY && B[5] >= b.maxZ).toBe(true);
            expect(m._hcVer).toBe(1);
        }
        const sizes = new Map<unknown, number>(); for (const m of ms) if (m._hcC) sizes.set(m._hcC, (sizes.get(m._hcC) ?? 0) + 1);
        expect(sizes.size).toBeGreaterThan(20);   // a real hierarchy, not one box
        expect(new Set(ms.map((m) => m._hcB)).size).toBe(1);
    });
    it('a small scene is left unclustered', () => {
        const ms = scene(20);
        expect(buildCullClusters({}, ms, (m) => m.box, () => true, () => 0)).toBe(0);
        expect(ms.every((m) => m._hcC === null)).toBe(true);
    });
});

describe('clusterVerdict is conservative', () => {
    const ms = scene(4000, 7);
    buildCullClusters({}, ms, (m) => m.box, () => true, () => 0);
    const light: [number, number, number] = [0.3, -0.8, -0.5];
    const L = Math.hypot(...light), ld = light.map((v) => v / L);
    for (const [eye, at] of [[[0, 1.6, 0], [0, 1.6, 50]], [[20, 40, -30], [0, 0, 60]], [[-80, 2, 80], [-40, 2, 0]]] as [[number, number, number], [number, number, number]][]) {
        it(`from ${eye.join(',')}: no member of a rejected cluster passes its per-mesh tests`, () => {
            const view = culler(eye, at), lightBox = culler([0, 120, 0], [0, 0, 0], 120);
            const t = { inView: (b: Float64Array) => view.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]), shadows: true,
                inLight: (b: Float64Array) => lightBox.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]),
                reaches: (b: Float64Array) => shadowReachesView(view, ld, 0, b[0], b[1], b[2], b[3], b[4], b[5]) };
            let rejected = 0;
            for (const m of ms) {
                const v = clusterVerdict(m._hcC!, t);
                if (v === HC_PASS) continue;
                rejected++;
                const b = arr(m.box);
                expect(t.inView(b)).toBe(false);
                if (v === HC_OUT) expect(t.inLight(b)).toBe(false);
                if (v === HC_NOREACH) expect(t.reaches(b)).toBe(false);
            }
            expect(rejected).toBeGreaterThan(0);
            // no shadows this frame: off-view clusters are simply OUT
            expect(ms.some((m) => clusterVerdict(m._hcC!, { ...t, shadows: false }) === HC_OUT)).toBe(true);
        });
    }
});

describe('object-argument frustum helpers', () => {
    it('testBox / shadowReachesViewBox agree with testAABB / shadowReachesView', () => {
        const r = rng(3), view = culler([5, 3, -10], [0, 0, 20]), d = [0.2, -0.9, 0.3];
        for (let i = 0; i < 2000; i++) {
            const x = (r() - 0.5) * 120, y = r() * 10, z = (r() - 0.5) * 120, w = r() * 8;
            const b = { minX: x, minY: y, minZ: z, maxX: x + w, maxY: y + w, maxZ: z + w * 2 };
            expect(view.testBox(b)).toBe(view.testAABB(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ));
            expect(shadowReachesViewBox(view, d, -1, b)).toBe(shadowReachesView(view, d, -1, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ));
        }
    });
});

describe('twinDraws (near / far / mid / xfar)', () => {
    it('exactly one role of a family draws for every reachable state pair', () => {
        // two-tier: roles 1 + 2; three-tier: roles 1 + 3 + 4 (near1 implies near2: d1 < 0.9 × d2)
        for (const n1 of [false, true]) {
            expect([1, 2].filter((r) => twinDraws(r, n1, true)).length).toBe(1);
            for (const n2 of [false, true]) {
                if (n1 && !n2) continue;
                expect([1, 3, 4].filter((r) => twinDraws(r, n1, n2)).length).toBe(1);
            }
        }
        expect(twinDraws(0, false, false)).toBe(true);
    });
});
