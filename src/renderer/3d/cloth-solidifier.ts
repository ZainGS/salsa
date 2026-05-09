/**
 * ClothSolidifier — extrudes a cloth mesh into a closed shell.
 *
 * Produces:
 *  - Outer surface  (original face, normals pointing outward)
 *  - Inner surface  (offset by thickness along −normal, winding reversed)
 *  - Wall strip     connecting outer and inner at every boundary edge
 *
 * When rounded=true each wall strip becomes a half-cylinder arc (arcSegments
 * facets), giving a fabric-hem silhouette.
 *
 * Safe range: thickness < ~3% of min(clothWidth, clothHeight).
 * Larger values can cause inner-surface self-intersection near high-curvature
 * areas (e.g. corners of a draped cloth).
 */

import { FLOATS_PER_VERT } from './mesh-generators';
import type { MeshGeometry } from './mesh-generators';
import type { ClothGeometryResult } from './cloth-geometry-builder';

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * @param result      Cloth geometry result from buildClothGeometry.
 * @param positions   [x, y, z] per vertex — flatPositions or post-simulation.
 * @param thickness   Shell extrusion depth in world units. Must be > 0.
 * @param rounded     Replace flat wall quads with a half-cylinder arc profile.
 * @param arcSegments Facet count for the arc in rounded mode (default 4).
 */
export function solidifyCloth(
    result:      ClothGeometryResult,
    positions:   Float32Array,
    thickness:   number,
    rounded      = false,
    arcSegments  = 4,
): MeshGeometry {
    const { vertexCount, geometry } = result;
    const origIndices = geometry.indices;
    const origVerts   = geometry.vertices;   // 12 floats / vertex

    // ── 1. Smooth per-vertex normals from actual positions ────────────────────
    const normals = _computeVertexNormals(positions, origIndices, vertexCount);

    // ── 2. Outer + inner vertex buffers (V verts each) ────────────────────────
    const outerBuf = new Float32Array(vertexCount * FLOATS_PER_VERT);
    const innerBuf = new Float32Array(vertexCount * FLOATS_PER_VERT);

    for (let vi = 0; vi < vertexCount; vi++) {
        const pi = vi * 3;
        const fi = vi * FLOATS_PER_VERT;
        const px = positions[pi],   py = positions[pi + 1], pz = positions[pi + 2];
        const nx = normals[pi],     ny = normals[pi + 1],   nz = normals[pi + 2];
        const u  = origVerts[fi + 6], v = origVerts[fi + 7];

        // Outer surface — normals facing outward
        outerBuf[fi]     = px;              outerBuf[fi + 1]  = py;              outerBuf[fi + 2]  = pz;
        outerBuf[fi + 3] = nx;              outerBuf[fi + 4]  = ny;              outerBuf[fi + 5]  = nz;
        outerBuf[fi + 6] = u;               outerBuf[fi + 7]  = v;
        outerBuf[fi + 8] = 1;               outerBuf[fi + 9]  = 0;               outerBuf[fi + 10] = 0;
        outerBuf[fi + 11] = 1;

        // Inner surface — offset inward, normal and tangent flipped
        innerBuf[fi]     = px - nx * thickness;
        innerBuf[fi + 1] = py - ny * thickness;
        innerBuf[fi + 2] = pz - nz * thickness;
        innerBuf[fi + 3] = -nx;             innerBuf[fi + 4]  = -ny;             innerBuf[fi + 5]  = -nz;
        innerBuf[fi + 6] = u;               innerBuf[fi + 7]  = v;
        innerBuf[fi + 8] = -1;              innerBuf[fi + 9]  = 0;               innerBuf[fi + 10] = 0;
        innerBuf[fi + 11] = 1;
    }

    // ── 3. Outer + inner index buffers ────────────────────────────────────────
    const outerIdx = new Uint32Array(origIndices);

    // Inner: same topology with reversed winding  [a,b,c] → [a+V, c+V, b+V]
    const innerIdx = new Uint32Array(origIndices.length);
    for (let t = 0; t < origIndices.length; t += 3) {
        innerIdx[t]     = origIndices[t]     + vertexCount;
        innerIdx[t + 1] = origIndices[t + 2] + vertexCount;
        innerIdx[t + 2] = origIndices[t + 1] + vertexCount;
    }

    // ── 4. Boundary edges (in CCW triangle winding order) ─────────────────────
    const boundary = _findBoundaryEdges(origIndices);

    // ── 5. Wall geometry ──────────────────────────────────────────────────────
    const wallVerts:  number[] = [];
    const wallIdxBuf: number[] = [];
    const wallVertBase = vertexCount * 2;   // first wall vertex index in final buffer

    for (const [a, b] of boundary) {
        const pa = _v3(positions, a), pb = _v3(positions, b);
        const na = _v3(normals,   a), nb = _v3(normals,   b);
        const edge = _norm(_sub(pb, pa));

        // Outward wall normal: cross(surface_normal, edge_tangent)
        // For a CCW mesh, this points away from the mesh interior.
        const wallNa = _norm(_cross(na, edge));
        const wallNb = _norm(_cross(nb, edge));

        if (!rounded) {
            // ── Flat wall — one quad (4 verts, 2 tris) per boundary edge ─────
            const base = wallVertBase + wallVerts.length / FLOATS_PER_VERT;

            _pushV(wallVerts, pa,                          wallNa, 0, 0);   // outer A
            _pushV(wallVerts, _sub(pa, _scale(na, thickness)), wallNa, 0, 1);   // inner A
            _pushV(wallVerts, pb,                          wallNb, 1, 0);   // outer B
            _pushV(wallVerts, _sub(pb, _scale(nb, thickness)), wallNb, 1, 1);   // inner B

            // Winding: viewed from exterior, outerA→innerA→innerB is CCW.
            // Verified: cross(innerA−outerA, outerB−outerA) points toward exterior. ✓
            wallIdxBuf.push(base,     base + 1, base + 3);
            wallIdxBuf.push(base,     base + 3, base + 2);

        } else {
            // ── Rounded wall — half-cylinder arc per boundary edge ────────────
            // Arc spans θ=0 (outer surface) → θ=π (inner surface).
            // At θ=π/2 the profile protrudes by r=thickness/2 beyond the boundary.
            const r  = thickness * 0.5;
            const ca = _sub(pa, _scale(na, r));   // arc centre at vertex a
            const cb = _sub(pb, _scale(nb, r));   // arc centre at vertex b

            const profileBase = wallVertBase + wallVerts.length / FLOATS_PER_VERT;

            for (let i = 0; i <= arcSegments; i++) {
                const theta  = Math.PI * i / arcSegments;
                const ct = Math.cos(theta), st = Math.sin(theta);
                const vFrac  = i / arcSegments;

                // Profile at endpoint a
                const pAi = _add(_add(ca, _scale(na, ct * r)), _scale(wallNa, st * r));
                const nAi = _norm(_add(_scale(na, ct), _scale(wallNa, st)));
                _pushV(wallVerts, pAi, nAi, 0, vFrac);

                // Profile at endpoint b
                const pBi = _add(_add(cb, _scale(nb, ct * r)), _scale(wallNb, st * r));
                const nBi = _norm(_add(_scale(nb, ct), _scale(wallNb, st)));
                _pushV(wallVerts, pBi, nBi, 1, vFrac);
            }

            // Each pair of consecutive profile rings → one quad
            for (let i = 0; i < arcSegments; i++) {
                const pAi  = profileBase + i * 2;
                const pBi  = profileBase + i * 2 + 1;
                const pAi1 = profileBase + (i + 1) * 2;
                const pBi1 = profileBase + (i + 1) * 2 + 1;

                // Same winding formula as flat wall (derived above):
                wallIdxBuf.push(pAi, pAi1, pBi1);
                wallIdxBuf.push(pAi, pBi1, pBi);
            }
        }
    }

    // ── 6. Assemble final geometry ────────────────────────────────────────────
    const wallF32    = new Float32Array(wallVerts);
    const totalVerts = vertexCount * 2 + wallF32.length / FLOATS_PER_VERT;
    const allVerts   = new Float32Array(totalVerts * FLOATS_PER_VERT);
    allVerts.set(outerBuf, 0);
    allVerts.set(innerBuf, vertexCount * FLOATS_PER_VERT);
    allVerts.set(wallF32,  vertexCount * 2 * FLOATS_PER_VERT);

    const totalIdx  = outerIdx.length + innerIdx.length + wallIdxBuf.length;
    const allIdx    = new Uint32Array(totalIdx);
    allIdx.set(outerIdx, 0);
    allIdx.set(innerIdx, outerIdx.length);
    allIdx.set(wallIdxBuf, outerIdx.length + innerIdx.length);

    return { vertices: allVerts, indices: allIdx, format: '12float' };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Area-weighted smooth per-vertex normals from a positions + index buffer. */
function _computeVertexNormals(
    positions:   Float32Array,
    indices:     Uint32Array,
    vertexCount: number,
): Float32Array {
    const out = new Float32Array(vertexCount * 3);

    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        const ax = positions[i0 * 3],     ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
        const bx = positions[i1 * 3],     by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
        const cx = positions[i2 * 3],     cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        // Cross product magnitude = 2 × area — no per-tri normalisation needed
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;

        out[i0 * 3]     += nx;  out[i0 * 3 + 1] += ny;  out[i0 * 3 + 2] += nz;
        out[i1 * 3]     += nx;  out[i1 * 3 + 1] += ny;  out[i1 * 3 + 2] += nz;
        out[i2 * 3]     += nx;  out[i2 * 3 + 1] += ny;  out[i2 * 3 + 2] += nz;
    }

    for (let vi = 0; vi < vertexCount; vi++) {
        const i   = vi * 3;
        const len = Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1] + out[i + 2] * out[i + 2]);
        if (len > 1e-10) {
            out[i] /= len;  out[i + 1] /= len;  out[i + 2] /= len;
        } else {
            out[i + 1] = 1;   // degenerate — default +Y
        }
    }
    return out;
}

/**
 * Returns boundary edges in triangle winding order.
 * An edge is a boundary edge iff it belongs to exactly one triangle.
 * Storing the direction from the first (and only) triangle preserves the CCW
 * winding needed for outward-facing wall normals.
 */
function _findBoundaryEdges(indices: Uint32Array): [number, number][] {
    const count = new Map<string, number>();
    const dir   = new Map<string, [number, number]>();

    for (let t = 0; t < indices.length; t += 3) {
        for (let i = 0; i < 3; i++) {
            const a = indices[t + i];
            const b = indices[t + ((i + 1) % 3)];
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            count.set(key, (count.get(key) ?? 0) + 1);
            if (!dir.has(key)) dir.set(key, [a, b]);
        }
    }

    const result: [number, number][] = [];
    for (const [key, cnt] of count) {
        if (cnt === 1) result.push(dir.get(key)!);
    }
    return result;
}

// ── Vec3 micro-helpers ────────────────────────────────────────────────────────

type V3 = [number, number, number];

/** Read a vec3 from a flat [x,y,z,...] array at vertex index vi. */
function _v3(arr: Float32Array, vi: number): V3 {
    const i = vi * 3;
    return [arr[i], arr[i + 1], arr[i + 2]];
}

function _sub(a: V3, b: V3): V3   { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _add(a: V3, b: V3): V3   { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function _scale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }

function _cross(a: V3, b: V3): V3 {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function _norm(a: V3): V3 {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    return len > 1e-10 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 1, 0];
}

/** Append one vertex (12 floats, tangent = +X w=1) to a growing number[]. */
function _pushV(buf: number[], pos: V3, normal: V3, u: number, v: number): void {
    buf.push(
        pos[0],    pos[1],    pos[2],
        normal[0], normal[1], normal[2],
        u, v,
        1, 0, 0, 1,
    );
}
