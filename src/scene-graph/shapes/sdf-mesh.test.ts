import { describe, it, expect } from 'vitest';
// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both before importing nodes.
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { generateSdfMesh, evalField, type SdfBlob, type V3 } from './sdf-mesh';
import { Mesh3D } from './mesh-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import type { InteractionService } from '../../services/interaction-service';

const positions = (g: { vertices: Float32Array }): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < g.vertices.length; i += 8) out.push([g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]]);
    return out;
};
const normalsOf = (g: { vertices: Float32Array }): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < g.vertices.length; i += 8) out.push([g.vertices[i + 3], g.vertices[i + 4], g.vertices[i + 5]]);
    return out;
};
const uvsOf = (g: { vertices: Float32Array }): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < g.vertices.length; i += 8) out.push([g.vertices[i + 6], g.vertices[i + 7]]);
    return out;
};

describe('sdf-mesh (metaballs)', () => {
    it('evalField: a sphere is 0 on its surface, negative inside, positive outside', () => {
        const s: SdfBlob[] = [{ shape: 'sphere', a: [0, 0, 0], radius: 1 }];
        expect(evalField(s, [0, 0, 0])).toBeLessThan(0);       // centre inside
        expect(Math.abs(evalField(s, [1, 0, 0]))).toBeLessThan(1e-6);   // on surface
        expect(evalField(s, [2, 0, 0])).toBeGreaterThan(0);    // outside
    });

    it('a single sphere polygonizes to a shell of vertices near radius from the centre', () => {
        const g = generateSdfMesh([{ shape: 'sphere', a: [0, 0, 0], radius: 1 }], 32);
        expect(g.indices.length).toBeGreaterThan(0);
        const rs = positions(g).map(p => Math.hypot(p[0], p[1], p[2]));
        const avg = rs.reduce((s, r) => s + r, 0) / rs.length;
        expect(Math.abs(avg - 1)).toBeLessThan(0.1);           // ~unit sphere
        for (const r of rs) expect(Math.abs(r - 1)).toBeLessThan(0.2);   // no stray verts
    });

    it('two overlapping spheres with blend FUSE (a bridge of vertices spans the gap between them)', () => {
        const blobs: SdfBlob[] = [
            { shape: 'sphere', a: [-0.6, 0, 0], radius: 0.6, blend: 0.4 },
            { shape: 'sphere', a: [0.6, 0, 0], radius: 0.6, blend: 0.4 },
        ];
        const g = generateSdfMesh(blobs, 40);
        // the neck: there should be surface vertices near the midplane x≈0 (which a hard union would leave pinched/empty)
        const nearMid = positions(g).filter(p => Math.abs(p[0]) < 0.15);
        expect(nearMid.length).toBeGreaterThan(0);
        // and the neck radius should be > 0 (fused, not two separate balls touching at a point)
        const neckR = Math.max(...nearMid.map(p => Math.hypot(p[1], p[2])));
        expect(neckR).toBeGreaterThan(0.1);
    });

    it('a capsule makes an elongated body', () => {
        const g = generateSdfMesh([{ shape: 'capsule', a: [0, 0, -1], b: [0, 0, 1], radius: 0.3 }], 32);
        const ps = positions(g);
        expect(ps.length).toBeGreaterThan(0);
        const zSpan = Math.max(...ps.map(p => p[2])) - Math.min(...ps.map(p => p[2]));
        const xSpan = Math.max(...ps.map(p => p[0])) - Math.min(...ps.map(p => p[0]));
        expect(zSpan).toBeGreaterThan(xSpan);                  // longer along Z than across
    });

    it('emits real spherical UVs (not all-zero) so the surface is paintable across its whole area', () => {
        const g = generateSdfMesh([{ shape: 'sphere', a: [0, 0, 0], radius: 1 }], 24);
        const uvs = uvsOf(g);
        expect(uvs.length).toBeGreaterThan(0);
        for (const [u, v] of uvs) { expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
        // A single texel (all-zero UVs) is the bug we're guarding: the mapping must SPREAD across UV space.
        const uSpan = Math.max(...uvs.map(p => p[0])) - Math.min(...uvs.map(p => p[0]));
        const vSpan = Math.max(...uvs.map(p => p[1])) - Math.min(...uvs.map(p => p[1]));
        expect(uSpan).toBeGreaterThan(0.5);
        expect(vSpan).toBeGreaterThan(0.5);
    });

    it('unwraps MULTIPLE blobs into SEPARATE packed atlas islands (not one overlapping projection)', () => {
        // Two spheres far apart → two charts → their UVs must land in DIFFERENT halves of the atlas, and the
        // seam between them duplicates boundary verts (so the mesh has more verts than a single-projection emit).
        const blobs: SdfBlob[] = [
            { shape: 'sphere', a: [-1, 0, 0], radius: 0.6, blend: 0.2 },
            { shape: 'sphere', a: [1, 0, 0], radius: 0.6, blend: 0.2 },
        ];
        const g = generateSdfMesh(blobs, 32);
        const uvs = uvsOf(g);
        // 2 charts → packer uses a 2-col grid → one island in u<0.5, the other in u>0.5.
        const leftIsland = uvs.filter(([u]) => u < 0.5).length;
        const rightIsland = uvs.filter(([u]) => u >= 0.5).length;
        expect(leftIsland).toBeGreaterThan(0);
        expect(rightIsland).toBeGreaterThan(0);
        // Every UV stays inside the atlas.
        for (const [u, v] of uvs) { expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    });

    it('seam-cuts cyclic charts so almost no triangle smears across its island (the wrap-seam overlap fix)', () => {
        // A cylindrical/lat-long projection wraps at u=±π; triangles straddling that seam would smear clear
        // across the island. The seam-cut duplicates seam verts (+2π) so they stay local. On a multi-part blob
        // set (4-col atlas → 0.25-wide islands) the seam smear was ~4% of triangles pre-fix; post-fix ≪1%.
        // (A few axis-tip pinch triangles at cylinder caps remain — a separate, unavoidable cap distortion.)
        const quadruped: SdfBlob[] = [
            { shape: 'capsule', a: [0, 0.6, -0.6], b: [0, 0.6, 0.6], radius: 0.28, blend: 0.15 },   // torso
            { shape: 'capsule', a: [-0.2, 0.55, 0.4], b: [-0.2, 0, 0.4], radius: 0.09, blend: 0.15 }, // leg
            { shape: 'capsule', a: [0.2, 0.55, 0.4], b: [0.2, 0, 0.4], radius: 0.09, blend: 0.15 },  // leg
            { shape: 'capsule', a: [-0.2, 0.55, -0.4], b: [-0.2, 0, -0.4], radius: 0.09, blend: 0.15 },
            { shape: 'sphere', a: [0, 0.75, 0.85], radius: 0.24, blend: 0.15 },                       // head
        ];
        const g = generateSdfMesh(quadruped, 40);
        const V = g.vertices, I = g.indices, nt = I.length / 3;
        let stretched = 0;
        for (let t = 0; t < nt; t++) {
            const us = [0, 1, 2].map(k => V[I[t * 3 + k] * 8 + 6]);
            const vs = [0, 1, 2].map(k => V[I[t * 3 + k] * 8 + 7]);
            if (Math.max(...us) - Math.min(...us) > 0.2 || Math.max(...vs) - Math.min(...vs) > 0.2) stretched++;
        }
        expect(stretched / nt).toBeLessThan(0.01);   // ≪1% (was ~4% before the seam-cut)
    });

    it('AREA-WEIGHTS the atlas: a big part gets a proportionally bigger island than a tiny one', () => {
        // A big sphere (r 0.6) fused to a small one (r 0.22) → ~7.4× surface-area ratio. The packer should give
        // the big part a much bigger UV island (even texel density), not an equal grid slot.
        const g = generateSdfMesh([
            { shape: 'sphere', a: [-0.7, 0, 0], radius: 0.6, blend: 0.12 },
            { shape: 'sphere', a: [0.7, 0, 0], radius: 0.22, blend: 0.12 },
        ], 44);
        const V = g.vertices, nv = V.length / 8;
        const bb = (test: (x: number) => boolean) => {
            let x0 = 9, y0 = 9, x1 = -9, y1 = -9;
            for (let i = 0; i < nv; i++) {
                if (!test(V[i * 8])) continue;
                const u = V[i * 8 + 6], v = V[i * 8 + 7];
                x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
            }
            return (x1 - x0) * (y1 - y0);
        };
        const big = bb(x => x < 0), small = bb(x => x >= 0);   // cluster by 3D x
        expect(big).toBeGreaterThan(small * 3);                // big island ≫ small (was 1:1 with the old grid)
    });

    it('DECIMATE param yields far fewer triangles, still valid + UVs re-unwrapped in [0,1]', () => {
        const blobs: SdfBlob[] = [
            { shape: 'capsule', a: [-0.5, 0.4, 0], b: [0.5, 0.4, 0], radius: 0.25, blend: 0.15 },
            { shape: 'sphere', a: [0.6, 0.5, 0], radius: 0.28, blend: 0.15 },
        ];
        const full = generateSdfMesh(blobs, 40);
        const lean = generateSdfMesh(blobs, 40, 0.3);
        expect(lean.indices.length).toBeLessThan(full.indices.length * 0.5);   // ~30% + a little
        expect(lean.indices.length).toBeGreaterThan(0);
        const uvs = uvsOf(lean);
        for (const [u, v] of uvs) { expect(u).toBeGreaterThanOrEqual(-0.001); expect(u).toBeLessThanOrEqual(1.001); expect(v).toBeGreaterThanOrEqual(-0.001); expect(v).toBeLessThanOrEqual(1.001); }
    });

    it('all normals are unit length; empty blob list → empty; deterministic', () => {
        const g = generateSdfMesh([{ shape: 'sphere', a: [0, 0, 0], radius: 1 }], 24);
        for (const [nx, ny, nz] of normalsOf(g)) expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(1e-3);
        expect(generateSdfMesh([], 24).vertices.length).toBe(0);
        const a = generateSdfMesh([{ shape: 'sphere', a: [0, 0, 0], radius: 1 }], 24);
        const b = generateSdfMesh([{ shape: 'sphere', a: [0, 0, 0], radius: 1 }], 24);
        expect([...a.vertices]).toEqual([...b.vertices]);
    });
});

describe('metaball PRIMITIVE integration — the 8-float→12-float trap', () => {
    // generateSdfMesh returns 8-float; every OTHER generator returns 12-float. The 'metaball' build case
    // must expand it, or the renderer reads it at 12-float stride and every triangle explodes into radial
    // spikes. Guard the built Mesh3D geometry, not the kernel (the kernel was always fine).
    const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

    it('SAVE/RELOAD round-trip: metaball persists its blobs+resolution (params-only) and regenerates on rebuild', () => {
        const blobs = [
            { shape: 'sphere' as const, a: [-0.2, 0, 0] as [number, number, number], radius: 0.3, blend: 0.3 },
            { shape: 'capsule' as const, a: [0.2, 0, 0] as [number, number, number], b: [0.5, 0, 0] as [number, number, number], radius: 0.15, blend: 0.3 },
        ];
        const original = new Mesh3D(isvc, 0, 0, 0, { primitive: 'metaball', blobs, resolution: 20 });
        const json = original.toJSON();
        // Persisted params-only: the blobs + resolution survive, and NO baked geometry is embedded (regenerated on load).
        expect(json.primitive).toBe('metaball');
        expect(json.config.blobs).toHaveLength(2);
        expect(json.config.resolution).toBe(20);
        expect(json.config.geometry).toBeUndefined();
        // Reconstruct exactly as the restore path does (full config) → geometry regenerates (was DROPPED before the fix).
        const restored = new Mesh3D(isvc, 0, 0, 0, { ...json.config, primitive: json.primitive });
        expect(restored.geometry.vertices.length).toBeGreaterThan(0);
        expect(restored.geometry.format).toBe('12float');
    });

    it('a metaball Mesh3D produces renderer-ready 12-float geometry (not raw 8-float)', () => {
        const m = new Mesh3D(isvc, 0, 0, 0, {
            primitive: 'metaball',
            blobs: [
                { shape: 'sphere', a: [-0.2, 0, 0], radius: 0.3, blend: 0.3 },
                { shape: 'sphere', a: [0.2, 0, 0], radius: 0.3, blend: 0.3 },
            ],
            resolution: 24,
        });
        const geom = m.geometry;
        expect(geom.vertices.length).toBeGreaterThan(0);
        // The renderer strides by FLOATS_PER_VERT (12). 8-float data is NOT a multiple of 12 → misread.
        expect(geom.vertices.length % FLOATS_PER_VERT).toBe(0);
        expect(geom.format).toBe('12float');
    });
});
