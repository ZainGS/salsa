/**
 * ground-uv-scale.ts — WORLD UNITS PER UV for a procedural-ground mesh, computed ONCE on the CPU (2026-09-29).
 *
 * The ground tilers work in metric coordinates, p = uv × (world units per uv). The shader used to derive that scale
 * PER PIXEL from screen-space derivatives (gr_uvMetres: dpdx/dpdy of world position and uv). Up close, neighbouring
 * pixels differ by ~1e-4 units while the values themselves are ~1–100 (the city's ground uv is worldXZ × 0.5), so a
 * 32-bit float's ~7 digits leave those differences mostly ROUNDING NOISE (1–10 %). Multiplied by the absolute uv, that
 * moved p by centimetres from one pixel to the next, so the millimetre grout line landed randomly: the "grout looks
 * like noise and shimmers, worse when zoomed in" bug. The scale of an affine uv mapping is a per-mesh CONSTANT, so it
 * is computed here from the geometry + model matrix and handed to the shader (see Renderer3D._writeGroundUvScale).
 */

import type { MeshGeometry } from './mesh-generators';

/** How many triangles to sample (evenly strided) — exact for planes / city ground, a good average otherwise. */
const MAX_SAMPLES = 64;

/**
 * World units per uv unit along u and v: the uv-AREA-weighted mean of |M·∂P/∂u| and |M·∂P/∂v| over (up to 64)
 * triangles. `model` = the 4×4 column-major model matrix (only its 3×3 part matters). Returns null when no triangle
 * has a usable uv mapping (degenerate uv) — the caller then keeps the shader's per-pixel estimate. Pure.
 */
export function groundUvWorldScale(geo: Pick<MeshGeometry, 'vertices' | 'indices'>, model: ArrayLike<number>): [number, number] | null {
    const v = geo.vertices, ix = geo.indices;
    const stride = 12;   // pos3 · nrm3 · uv2 · tan4
    const tris = Math.floor(ix.length / 3);
    if (tris === 0) return null;
    const step = Math.max(1, Math.floor(tris / MAX_SAMPLES));
    const M = (x: number, y: number, z: number): [number, number, number] => [
        model[0] * x + model[4] * y + model[8] * z,
        model[1] * x + model[5] * y + model[9] * z,
        model[2] * x + model[6] * y + model[10] * z,
    ];
    let su = 0, sv = 0, sw = 0;
    for (let t = 0; t < tris; t += step) {
        const a = ix[t * 3] * stride, b = ix[t * 3 + 1] * stride, c = ix[t * 3 + 2] * stride;
        const e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
        const e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
        const du1 = v[b + 6] - v[a + 6], dv1 = v[b + 7] - v[a + 7];
        const du2 = v[c + 6] - v[a + 6], dv2 = v[c + 7] - v[a + 7];
        const det = du1 * dv2 - du2 * dv1;
        if (!(Math.abs(det) > 1e-12)) continue;
        const inv = 1 / det;
        const tu = M((e1x * dv2 - e2x * dv1) * inv, (e1y * dv2 - e2y * dv1) * inv, (e1z * dv2 - e2z * dv1) * inv);
        const tv = M((e2x * du1 - e1x * du2) * inv, (e2y * du1 - e1y * du2) * inv, (e2z * du1 - e1z * du2) * inv);
        const w = Math.abs(det);
        su += Math.hypot(tu[0], tu[1], tu[2]) * w;
        sv += Math.hypot(tv[0], tv[1], tv[2]) * w;
        sw += w;
    }
    if (!(sw > 0)) return null;
    const u = su / sw, vv = sv / sw;
    return Number.isFinite(u) && Number.isFinite(vv) && u > 0 && vv > 0 ? [u, vv] : null;
}

/** The uvTransform.z value that tells the shader "uvTransform.xy is the CPU-computed ground scale". Far outside any
 *  real texture offset; only ever written on UNTEXTURED ground meshes (whose uvTransform nothing else reads). */
export const GROUND_UV_SCALE_MARKER = -12345;
