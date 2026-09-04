/**
 * cloth-mesh-helpers.ts — pure geometry helpers shared by the cloth subsystem (Scene3DCloth) and the mesh-restore
 * path in Scene3DManager. Extracted from scene3d-manager.ts (§5.1) so both callers import one copy instead of the
 * helpers being private module-locals of the god-object. No GPU, no scene-graph — pure `config/positions → geometry`.
 */

import type { DrapeProxy } from './cloth-simulator';
import type { ClothGridConfig, ClothPhysicsConfig } from '../../scene-graph/shapes/cloth-mesh-3d';
import type { ClothGeometryResult } from './cloth-geometry-builder';
import { type MeshGeometry, FLOATS_PER_VERT } from './mesh-generators';
import { solidifyCloth } from './cloth-solidifier';

/**
 * Compute how much to lift the cloth in Y before a drape simulation so it
 * starts above the proxy and can fall onto it.
 */
export function drapeStartY(
    proxy: DrapeProxy,
    flatPositions: Float32Array,
    config: ClothGridConfig,
    gravity: number,
): number {
    const clothHalfH = config.rows * config.cellSize * 0.5;
    if (proxy.type === 'sphere') {
        const cy = proxy.center?.[1] ?? 0;
        return cy + proxy.radius + clothHalfH + 0.1;
    }
    if (proxy.type === 'box') {
        return proxy.max[1] + clothHalfH + 0.1;
    }
    if (proxy.type === 'ground') {
        const groundY = proxy.y ?? 0;
        return groundY + clothHalfH + Math.sqrt(2 * gravity * 0.5);  // ~1s of fall height
    }
    return 0;
}

/**
 * Resolve the final MeshGeometry for a cloth node.
 * Uses solidifyCloth when thickness > 0, otherwise plain position+normal update.
 * Falls back to the flat geometry if positions is null/wrong length.
 */
export function resolveClothGeometry(
    result:    ClothGeometryResult,
    positions: Float32Array | null | undefined,
    physics:   ClothPhysicsConfig,
): MeshGeometry {
    const pos = (positions && positions.length === result.vertexCount * 3)
        ? positions
        : result.flatPositions;
    if (physics.thickness > 0) {
        return solidifyCloth(result, pos, physics.thickness, physics.solidifyRounded);
    }
    if (pos !== result.flatPositions) {
        return applySimulatedPositions(result, pos);
    }
    return result.geometry;
}

/**
 * Overwrite vertex positions in a cloth geometry result with post-simulation
 * values and recompute per-vertex normals from the new triangle faces.
 *
 * Returns a new MeshGeometry (does not mutate `result`).
 */
export function applySimulatedPositions(
    result: ClothGeometryResult,
    positions: Float32Array,
): MeshGeometry {
    const src = result.geometry.vertices;
    const verts = new Float32Array(src.length);
    verts.set(src);

    const vc = result.vertexCount;

    // Overwrite positions
    for (let vi = 0; vi < vc; vi++) {
        verts[vi * FLOATS_PER_VERT    ] = positions[vi * 3    ];
        verts[vi * FLOATS_PER_VERT + 1] = positions[vi * 3 + 1];
        verts[vi * FLOATS_PER_VERT + 2] = positions[vi * 3 + 2];
    }

    // Recompute per-vertex normals (accumulate face normals, then normalize)
    const normals = new Float32Array(vc * 3);
    const indices = result.geometry.indices;
    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        const ax = positions[i0*3], ay = positions[i0*3+1], az = positions[i0*3+2];
        const bx = positions[i1*3], by = positions[i1*3+1], bz = positions[i1*3+2];
        const cx = positions[i2*3], cy = positions[i2*3+1], cz = positions[i2*3+2];
        const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
        const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
        const nx = e1y*e2z - e1z*e2y;
        const ny = e1z*e2x - e1x*e2z;
        const nz = e1x*e2y - e1y*e2x;
        for (const vi of [i0, i1, i2]) {
            normals[vi*3]   += nx;
            normals[vi*3+1] += ny;
            normals[vi*3+2] += nz;
        }
    }
    for (let vi = 0; vi < vc; vi++) {
        const nx = normals[vi*3], ny = normals[vi*3+1], nz = normals[vi*3+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
        verts[vi * FLOATS_PER_VERT + 3] = nx / len;
        verts[vi * FLOATS_PER_VERT + 4] = ny / len;
        verts[vi * FLOATS_PER_VERT + 5] = nz / len;
    }

    return { vertices: verts, indices: result.geometry.indices, format: '12float' };
}
