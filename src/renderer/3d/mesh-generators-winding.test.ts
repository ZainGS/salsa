import { describe, it, expect } from 'vitest';
import { generateBox, generateSphere, generatePlane, generateCylinder, generateTorus, type MeshGeometry } from './mesh-generators';

/**
 * WINDING CONSISTENCY: for every triangle, the geometric face normal implied by the INDEX ORDER (cross of edges,
 * frontFace 'ccw' convention) must agree with the averaged VERTEX normals. Disagreement = the mesh is wound
 * inside-out relative to its shading normals — invisible under cullMode 'none', but the main opaque pipelines cull
 * 'back' (and the shadow pass culls 'front' for Peter-Pan compensation), so an inverted primitive renders its far
 * side's interior: floors show THROUGH it at intersections, reflections inherit the hole, and its cast shadow
 * comes from the wrong faces (the orbiting-shadow weirdness). Caught live on generateSphere 2026-09-04.
 */
function windingAgreement(geo: MeshGeometry): number {
    const stride = geo.format === '12float' ? 12 : 8;   // pos3 + normal3 + uv2 (+ tangent4)
    const v = geo.vertices;
    let good = 0, total = 0;
    for (let i = 0; i < geo.indices.length; i += 3) {
        const i0 = geo.indices[i], i1 = geo.indices[i + 1], i2 = geo.indices[i + 2];
        const px = (k: number) => v[k * stride], py = (k: number) => v[k * stride + 1], pz = (k: number) => v[k * stride + 2];
        const e1 = [px(i1) - px(i0), py(i1) - py(i0), pz(i1) - pz(i0)];
        const e2 = [px(i2) - px(i0), py(i2) - py(i0), pz(i2) - pz(i0)];
        const fx = e1[1] * e2[2] - e1[2] * e2[1];
        const fy = e1[2] * e2[0] - e1[0] * e2[2];
        const fz = e1[0] * e2[1] - e1[1] * e2[0];
        if (Math.hypot(fx, fy, fz) < 1e-12) continue;   // degenerate (pole rows)
        const nx = v[i0 * stride + 3] + v[i1 * stride + 3] + v[i2 * stride + 3];
        const ny = v[i0 * stride + 4] + v[i1 * stride + 4] + v[i2 * stride + 4];
        const nz = v[i0 * stride + 5] + v[i1 * stride + 5] + v[i2 * stride + 5];
        total++;
        if (fx * nx + fy * ny + fz * nz > 0) good++;
    }
    return total > 0 ? good / total : 1;
}

describe('primitive generators wind triangles to match their vertex normals', () => {
    const cases: Array<[string, MeshGeometry]> = [
        ['box', generateBox(1, 1, 1)],
        ['sphere', generateSphere(0.5, 16, 12)],
        ['plane', generatePlane(1, 1, 2, 2)],
        ['cylinder', generateCylinder(0.5, 0.5, 1, 16)],
        ['torus', generateTorus(0.5, 0.2, 16, 12)],
    ];
    for (const [name, geo] of cases) {
        it(`${name} is wound outward`, () => {
            expect(windingAgreement(geo)).toBeGreaterThan(0.99);
        });
    }
});
