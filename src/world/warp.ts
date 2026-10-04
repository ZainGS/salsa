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
import { valueNoise2D, hash2 } from './util';
import { TILE_SPEED } from './tile-speed';

/** ALLOCATION-FREE horizontal displacement field — writes (dx, dz) into `out[0]`, `out[1]`. Prefer this in
 *  hot loops (the per-frame traffic tick calls the warp once per mover; the array-returning variant below
 *  allocated a fresh tuple every call → thousands of throwaway arrays/sec → GC hitches). */
export function makeDomainWarpInto(params: LayoutParams): (x: number, z: number, out: [number, number] | Float32Array) => void {
    const amp = (params.warp ?? 0) * params.radius * 0.085;
    if (amp < 1e-4) return (_x, _z, out) => { out[0] = 0; out[1] = 0; };
    // `warpSeed` (tiled worlds, P10.A1): a neighbour tile is generated with its OWN seed but drapes with the WORLD's
    // warp — builders that warp a path themselves (the railway line, the local line) must use the world seed too.
    const ws = params.warpSeed ?? params.seed;
    const s1 = (ws ^ 0x77a4b1) >>> 0, s2 = (ws ^ 0x14c9e3) >>> 0;
    const f0 = 1 / (params.radius * 0.55);
    if (TILE_SPEED.fusedWarp) {
        // P22 fusedWarp: each octave's two noises (seeds s1 / s2) share x·f, z·f, the floors and the fade terms, and the
        // lattice-corner hashes are kept in a dense 64 × 64-corner window per octave (the warp's lattice is ~R/2 wide,
        // so one window covers a whole tile; a corner outside it is hashed directly). The per-seed arithmetic is
        // valueNoise2D's, in its order, on the same hash2 values, so the result is the same double.
        const s1b = s1 + 5, s2b = s2 + 9;
        const W = 64;
        const mkOct = (sa: number, sb: number) => ({ sa, sb, x0: 0, z0: 0, set: false, h: new Float64Array(W * W * 2).fill(NaN) });
        const o1 = mkOct(s1, s2), o2 = mkOct(s1b, s2b);
        type Oct = ReturnType<typeof mkOct>;
        // corner (xi, zi)'s two hashes → hv[0], hv[1]
        const hv = new Float64Array(2);
        const corner = (O: Oct, xi: number, zi: number): void => {
            if (!O.set) { O.x0 = xi - (W >> 1); O.z0 = zi - (W >> 1); O.set = true; }
            const cx = xi - O.x0, cz = zi - O.z0;
            if (cx < 0 || cz < 0 || cx >= W || cz >= W) { hv[0] = hash2(xi, zi, O.sa); hv[1] = hash2(xi, zi, O.sb); return; }
            const k = (cz * W + cx) * 2, h = O.h;
            let a = h[k];
            if (a !== a) { h[k] = a = hash2(xi, zi, O.sa); h[k + 1] = hash2(xi, zi, O.sb); }
            hv[0] = a; hv[1] = h[k + 1];
        };
        const pair = (x: number, z: number, O: Oct, o: Float64Array): void => {
            const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
            const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
            corner(O, xi, zi); const a0 = hv[0], a1 = hv[1];
            corner(O, xi + 1, zi); const b0 = hv[0], b1 = hv[1];
            corner(O, xi, zi + 1); const c0 = hv[0], c1 = hv[1];
            corner(O, xi + 1, zi + 1); const d0 = hv[0], d1 = hv[1];
            let top = a0 + (b0 - a0) * u, bot = c0 + (d0 - c0) * u;
            o[0] = top + (bot - top) * v;
            top = a1 + (b1 - a1) * u; bot = c1 + (d1 - c1) * u;
            o[1] = top + (bot - top) * v;
        };
        const p0 = new Float64Array(2), p1 = new Float64Array(2);
        return (x, z, out) => {
            pair(x * f0, z * f0, o1, p0);
            pair(x * f0 * 2.1, z * f0 * 2.1, o2, p1);
            const nx = 0.72 * p0[0] + 0.28 * p1[0];
            const nz = 0.72 * p0[1] + 0.28 * p1[1];
            out[0] = (nx - 0.5) * 2 * amp;
            out[1] = (nz - 0.5) * 2 * amp;
        };
    }
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
