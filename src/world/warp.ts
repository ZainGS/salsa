// ── World generation — DOMAIN WARP ───────────────────────────────────────────────────────────────
// A low-frequency horizontal noise warp (x,z) → (x+wx, z+wz) applied to EVERY vertex as the final post-
// transform (after the elevation lift). Roads gently curve, blocks vary in shape, streets stop being ruler-
// straight — the whole city passes through one smooth function so everything stays mutually consistent, and
// buildings stay near-rigid because the warp is near-constant across a single footprint (the same property
// that makes the elevation drape work). `warp` = 0 → untouched grid · 1 → organic old-town.
//
// IMPORTANT: all LAYOUT-SPACE logic (cellLevelAt, regionAt, routes, canal checks) stays in unwarped
// coordinates — warp is a render-space effect. Movers compute in layout space and warp the final position;
// picking goes the other way via the approximate inverse.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutParams } from './types';
import { valueNoise2D } from './util';

/** ALLOCATION-FREE horizontal displacement field — writes (dx, dz) into `out[0]`, `out[1]`. Prefer this in
 *  hot loops (the per-frame traffic tick calls the warp once per mover; the array-returning variant below
 *  allocated a fresh tuple every call → thousands of throwaway arrays/sec → GC hitches). */
export function makeDomainWarpInto(params: LayoutParams): (x: number, z: number, out: [number, number] | Float32Array) => void {
    const amp = (params.warp ?? 0) * params.radius * 0.085;
    if (amp < 1e-4) return (_x, _z, out) => { out[0] = 0; out[1] = 0; };
    const s1 = (params.seed ^ 0x77a4b1) >>> 0, s2 = (params.seed ^ 0x14c9e3) >>> 0;
    const f0 = 1 / (params.radius * 0.55);
    return (x, z, out) => {
        const nx = 0.72 * valueNoise2D(x * f0, z * f0, s1) + 0.28 * valueNoise2D(x * f0 * 2.1, z * f0 * 2.1, s1 + 5);
        const nz = 0.72 * valueNoise2D(x * f0, z * f0, s2) + 0.28 * valueNoise2D(x * f0 * 2.1, z * f0 * 2.1, s2 + 9);
        out[0] = (nx - 0.5) * 2 * amp;
        out[1] = (nz - 0.5) * 2 * amp;
    };
}

/** Horizontal displacement field (dx, dz) for a params set — the array-returning convenience wrapper over
 *  {@link makeDomainWarpInto}. Fine for cold paths; use the into-variant in per-frame loops. */
export function makeDomainWarp(params: LayoutParams): (x: number, z: number) => [number, number] {
    const into = makeDomainWarpInto(params);
    return (x, z) => { const o: [number, number] = [0, 0]; into(x, z, o); return o; };
}

/** Apply the warp to every vertex's (x, z) in-place — call AFTER the elevation lift (heights sample layout
 *  coords). Takes the ALLOCATION-FREE into-variant + a single reused scratch (was one array per vertex). */
export function applyDomainWarp(geo: MeshGeometry, warpInto: (x: number, z: number, out: [number, number]) => void): void {
    const v = geo.vertices;
    const o: [number, number] = [0, 0];
    for (let i = 0; i < v.length; i += 12) {
        warpInto(v[i], v[i + 2], o);
        v[i] += o[0]; v[i + 2] += o[1];
    }
}
