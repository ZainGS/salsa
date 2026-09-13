/**
 * src/scene-graph/core/even-odd-fill.ts
 *
 * EVEN-ODD fill triangulation for a (possibly self-intersecting) closed ring — docs/specs/vector-paths.md P3.
 * Ear-clipping assumes a simple polygon; a self-crossing outline (pentagram, figure-eight, accidental crossings
 * in a freeform draw) triangulates wrong. This module fills by the even-odd rule instead — the same rule
 * PathNode.containsPoint already uses, so rendered pixels finally match hit-testing (a pentagram gets its
 * classic hollow center).
 *
 * Algorithm: trapezoidal (band) decomposition.
 *   1. Collect every vertex y AND every pairwise edge-intersection y as band boundaries (the intersection ys
 *      matter: within a band no two edges may cross, or sorted-span pairing would emit bowtie quads).
 *   2. For each horizontal band, every non-horizontal edge either fully spans it or misses it. Sort the
 *      spanning edges by x at the band's midline and pair them up [0,1], [2,3], … — even-odd parity.
 *   3. Each pair emits one trapezoid (two triangles). Adjacent bands evaluate edge x at the SAME shared y with
 *      the same interpolation, so band seams are exact — no cracks.
 *
 * Pure CPU, O(E² + bands·E log E) on the flattened ring (E ≈ a few hundred), cached upstream on anchorsVersion.
 * Output is a plain triangle soup (Float32Array xy verts + Uint16Array indices), a drop-in for the ear-clip
 * geometry — zero renderer changes.
 */

import type { Pt } from "./bezier";

/** Uint16 index space, minus headroom — beyond this the caller should fall back to ear-clipping. */
const MAX_VERTS = 60000;

export function evenOddFillGeometry(ring: Pt[]): { verts: Float32Array; indices: Uint16Array } | null {
    const n = ring.length;
    if (n < 3) return null;

    // Edges as flat coords; horizontal edges never span a band's midline and are skipped naturally.
    const ax: number[] = [], ay: number[] = [], bx: number[] = [], by: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        ax.push(a.x); ay.push(a.y); bx.push(b.x); by.push(b.y);
    }

    // Band boundaries: vertex ys + edge-edge intersection ys.
    const ys: number[] = [];
    for (let i = 0; i < n; i++) ys.push(ay[i]);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const y = segIntersectY(ax[i], ay[i], bx[i], by[i], ax[j], ay[j], bx[j], by[j]);
            if (y !== null) ys.push(y);
        }
    }
    ys.sort((p, q) => p - q);

    const xAt = (e: number, y: number) => ax[e] + ((y - ay[e]) * (bx[e] - ax[e])) / (by[e] - ay[e]);

    const verts: number[] = [];
    const indices: number[] = [];
    const spanning: number[] = [];

    for (let bnd = 0; bnd + 1 < ys.length; bnd++) {
        const y0 = ys[bnd], y1 = ys[bnd + 1];
        if (y1 - y0 <= 1e-12) continue;                        // duplicate/degenerate boundary
        const midY = (y0 + y1) / 2;

        spanning.length = 0;
        for (let e = 0; e < n; e++) {
            const lo = Math.min(ay[e], by[e]), hi = Math.max(ay[e], by[e]);
            if (lo < midY && hi > midY) spanning.push(e);      // strict: horizontals + touching-only excluded
        }
        if (spanning.length < 2) continue;
        spanning.sort((p, q) => xAt(p, midY) - xAt(q, midY));

        // Even-odd: fill between pairs [0,1], [2,3], … (a closed ring gives an even count; a stray odd
        // tail from numeric degeneracy is dropped).
        for (let s = 0; s + 1 < spanning.length; s += 2) {
            const L = spanning[s], R = spanning[s + 1];
            const xL0 = xAt(L, y0), xR0 = xAt(R, y0);
            const xL1 = xAt(L, y1), xR1 = xAt(R, y1);
            if (Math.abs(xR0 - xL0) <= 1e-12 && Math.abs(xR1 - xL1) <= 1e-12) continue;  // zero-width sliver
            const base = verts.length / 2;
            if (base + 4 > MAX_VERTS) return null;             // pathological — let the caller ear-clip
            verts.push(xL0, y0, xR0, y0, xL1, y1, xR1, y1);
            indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
    }

    if (indices.length === 0) return null;
    // WebGPU index buffers must be 4-byte aligned; 6 indices per trapezoid keeps this even already,
    // but guard anyway for future edits.
    if (indices.length % 2 === 1) indices.push(0);
    return { verts: new Float32Array(verts), indices: new Uint16Array(indices) };
}

/** y of the proper intersection of segments (a1→b1) and (a2→b2), or null (parallel, disjoint, or touching
 *  only at endpoints — endpoint ys are already band boundaries). */
function segIntersectY(
    a1x: number, a1y: number, b1x: number, b1y: number,
    a2x: number, a2y: number, b2x: number, b2y: number,
): number | null {
    const d1x = b1x - a1x, d1y = b1y - a1y;
    const d2x = b2x - a2x, d2y = b2y - a2y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;                    // parallel / collinear
    const t = ((a2x - a1x) * d2y - (a2y - a1y) * d2x) / den;
    const u = ((a2x - a1x) * d1y - (a2y - a1y) * d1x) / den;
    const eps = 1e-9;
    if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
    return a1y + t * d1y;
}
