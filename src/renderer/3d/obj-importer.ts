/**
 * OBJ importer — parses Wavefront .obj text into MeshGeometry.
 *
 * Handles:
 *   v / vn / vt / f  (core geometry)
 *   Quads and N-gons (fan-triangulated)
 *   Missing normals  (recomputed as smooth vertex normals)
 *   Missing UVs      (zeroed; tangents still computed correctly)
 *   Negative indices (relative, per spec)
 *   Multiple objects / groups (merged into one mesh)
 *   Comments (#)     (skipped)
 *
 * Ignored: mtllib, usemtl, s, l — apply materials via Material3D after import.
 *
 * UV convention: OBJ stores V=0 at bottom-left; WebGPU stores V=0 at top-left.
 * V is flipped automatically so textures appear correctly without any extra work.
 *
 * Output: MeshGeometry with format '12float' (pos+normal+uv+tangent per vertex).
 * Ready to pass directly to createCustomMesh() or mesh.setGeometry().
 */

import { MeshGeometry, computeTangents } from './mesh-generators';

// ── Public entry point ─────────────────────────────────────────────────────

export function parseOBJ(text: string): MeshGeometry {
    const pos: [number, number, number][] = [];
    const nrm: [number, number, number][] = [];
    const uvs: [number, number][] = [];

    // key = "posIdx/uvIdx/nrmIdx" (all 0-based, -1 = absent)
    const vertexCache = new Map<string, number>();
    const verts8: number[] = [];   // 8 floats/vert: px py pz  nx ny nz  u v
    const idxList: number[] = [];
    let hasNormals = false;

    for (let raw of text.split('\n')) {
        raw = raw.trim();
        if (!raw || raw.charCodeAt(0) === 35 /* # */) continue;

        const sp = raw.indexOf(' ');
        const cmd = sp === -1 ? raw : raw.slice(0, sp);
        const rest = sp === -1 ? '' : raw.slice(sp + 1).trimStart();

        if (cmd === 'v') {
            const p = rest.split(/\s+/);
            pos.push([+p[0], +p[1], +p[2]]);
        } else if (cmd === 'vn') {
            const p = rest.split(/\s+/);
            nrm.push([+p[0], +p[1], +p[2]]);
            hasNormals = true;
        } else if (cmd === 'vt') {
            const p = rest.split(/\s+/);
            // Flip V: OBJ V=0 is bottom-left, WebGPU V=0 is top-left
            uvs.push([+p[0], 1.0 - +(p[1] ?? 0)]);
        } else if (cmd === 'f') {
            const tokens = rest.split(/\s+/).filter(Boolean);
            const fverts = tokens.map(t => parseFaceToken(t, pos.length, nrm.length, uvs.length));

            // Fan-triangulate: (0,1,2), (0,2,3), (0,3,4), …
            for (let i = 1; i < fverts.length - 1; i++) {
                for (const fv of [fverts[0], fverts[i], fverts[i + 1]]) {
                    const key = `${fv.v}/${fv.vt}/${fv.vn}`;
                    if (!vertexCache.has(key)) {
                        vertexCache.set(key, verts8.length / 8);
                        const p = pos[fv.v] ?? [0, 0, 0];
                        const n = fv.vn >= 0 ? (nrm[fv.vn] ?? [0, 1, 0]) : [0, 1, 0];
                        const uv = fv.vt >= 0 ? (uvs[fv.vt] ?? [0, 0]) : [0, 0];
                        verts8.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]);
                    }
                    idxList.push(vertexCache.get(key)!);
                }
            }
        }
    }

    if (verts8.length === 0 || idxList.length === 0) {
        // Return a degenerate 1-triangle mesh rather than crashing
        return computeTangents({
            vertices: new Float32Array([0,0,0, 0,1,0, 0,0, 1,0,0, 0,1,0, 0,0, 0,0,1, 0,1,0, 0,0]),
            indices: new Uint32Array([0, 1, 2]),
            format: '8float',
        });
    }

    const geom8: MeshGeometry = {
        vertices: new Float32Array(verts8),
        indices: new Uint32Array(idxList),
        format: '8float',
    };

    // Recompute smooth vertex normals when file has none
    if (!hasNormals) recomputeNormals(geom8.vertices, geom8.indices);

    return computeTangents(geom8);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Parse one face token: "v", "v/vt", "v//vn", "v/vt/vn". Returns 0-based indices; -1 = absent. */
function parseFaceToken(
    s: string,
    posCount: number,
    nrmCount: number,
    uvCount: number,
): { v: number; vt: number; vn: number } {
    const parts = s.split('/');

    const rawV  = parseInt(parts[0], 10);
    const rawVt = parts.length > 1 && parts[1] !== '' ? parseInt(parts[1], 10) : NaN;
    const rawVn = parts.length > 2 && parts[2] !== '' ? parseInt(parts[2], 10) : NaN;

    // OBJ is 1-based; negative = relative from end
    const v  = isNaN(rawV)  ? 0                             : rawV  < 0 ? posCount + rawV  : rawV  - 1;
    const vt = isNaN(rawVt) ? -1                            : rawVt < 0 ? uvCount  + rawVt : rawVt - 1;
    const vn = isNaN(rawVn) ? -1                            : rawVn < 0 ? nrmCount + rawVn : rawVn - 1;

    return { v, vt, vn };
}

/** Recompute smooth vertex normals in-place on an 8-float vertex array. */
function recomputeNormals(verts: Float32Array, indices: Uint32Array): void {
    const S = 8;
    const nv = verts.length / S;

    // Accumulate face normals into each vertex
    for (let i = 3; i < verts.length; i += S) { verts[i] = 0; verts[i + 1] = 0; verts[i + 2] = 0; }

    for (let i = 0; i < indices.length; i += 3) {
        const b0 = indices[i]     * S;
        const b1 = indices[i + 1] * S;
        const b2 = indices[i + 2] * S;

        const ax = verts[b1]     - verts[b0],     ay = verts[b1 + 1] - verts[b0 + 1], az = verts[b1 + 2] - verts[b0 + 2];
        const bx = verts[b2]     - verts[b0],     by = verts[b2 + 1] - verts[b0 + 1], bz = verts[b2 + 2] - verts[b0 + 2];
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;

        for (const b of [b0, b1, b2]) {
            verts[b + 3] += nx;
            verts[b + 4] += ny;
            verts[b + 5] += nz;
        }
    }

    // Normalize
    for (let vi = 0; vi < nv; vi++) {
        const o = vi * S + 3;
        const nx = verts[o], ny = verts[o + 1], nz = verts[o + 2];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        verts[o] = nx / len; verts[o + 1] = ny / len; verts[o + 2] = nz / len;
    }
}
