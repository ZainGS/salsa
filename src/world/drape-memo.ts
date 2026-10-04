// ── P20 lighter tiles: MEMOISED DRAPE (performance-plan §P20) ───────────────────────────────────────────────────────
// The tile drape evaluates the height field (+ its gradient) and the domain warp once per VERTEX, and most vertices of
// flat-shaded city geometry repeat an (x, z) another vertex of the same layer already has: a box's 24 vertices sit on
// 8 corners, a wall quad's top and bottom share their x, z, a prism's rings stack. These two functions are
// applyHeightField / applyDomainWarp (elevation.ts / warp.ts) with the per-(x, z) results cached in an exact hash
// table keyed by the f32 BITS of x and z (read straight from the vertex buffer — no rounding, so a hit returns the very
// value the direct call would compute). Same output, bit for bit (drape-memo.test.ts). The table is per LAYER (one
// scratch table, sized to the layer, reset by a generation stamp — no clearing, no growth).

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { HeightFn } from './elevation';

/** An exact (x, z) → k-numbers cache keyed by the two f32 bit patterns (open addressing). `reset(n)` readies it for up
 *  to `n` distinct keys (load ≤ 1/2) and forgets everything in O(1) (a generation stamp). */
export class XZMemo {
    private keys = new Int32Array(0);
    private gen = new Int32Array(0);
    private vals = new Float64Array(0);
    private g = 0;
    private mask = 0;
    hits = 0; misses = 0;
    constructor(readonly k: number) {}
    reset(n: number): void {
        let cap = 64;
        while (cap < n * 2) cap *= 2;
        if (cap > this.gen.length) { this.keys = new Int32Array(cap * 2); this.gen = new Int32Array(cap); this.vals = new Float64Array(cap * this.k); this.g = 0; }
        this.mask = Math.min(cap, this.gen.length) - 1;
        if (++this.g > 0x7ffffff0) { this.gen.fill(0); this.g = 1; }
    }
    /** The slot of (xb, zb): found (≥ 0), or −1 − the free slot to claim. */
    find(xb: number, zb: number): number {
        const mask = this.mask, gen = this.gen, keys = this.keys, g = this.g;
        let h = (Math.imul(xb, 0x9e3779b1) ^ Math.imul(zb ^ (zb >>> 15), 0x85ebca77)) >>> 0;
        h = (h ^ (h >>> 13)) & mask;
        for (;;) {
            if (gen[h] !== g) return -1 - h;
            if (keys[h * 2] === xb && keys[h * 2 + 1] === zb) return h;
            h = (h + 1) & mask;
        }
    }
    /** Claim the free slot `-1 - f` for (xb, zb); returns the slot. */
    claim(f: number, xb: number, zb: number): number {
        const s = -1 - f;
        this.gen[s] = this.g; this.keys[s * 2] = xb; this.keys[s * 2 + 1] = zb;
        return s;
    }
    value(s: number, j: number): number { return this.vals[s * this.k + j]; }
    set(s: number, j: number, v: number): void { this.vals[s * this.k + j] = v; }
}

/** applyHeightField (elevation.ts) with the height + gradient of every distinct (x, z) of the layer computed once
 *  (`memo`: k = 3 — height, gradient x / z, NaN until a vertex needs it). Identical output. */
export function applyHeightFieldMemo(geo: MeshGeometry, fn: HeightFn | ((x: number, z: number) => number), memo: XZMemo): void {
    const v = geo.vertices, bits = new Int32Array(v.buffer, v.byteOffset, v.length);
    memo.reset(v.length / 12);
    const grad = (fn as HeightFn).grad;
    const g: [number, number] = [0, 0], e = 0.01;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], z = v[i + 2], xb = bits[i], zb = bits[i + 2];
        let s = memo.find(xb, zb), h: number;
        if (s >= 0) { h = memo.value(s, 0); memo.hits++; }
        else { h = fn(x, z); s = memo.claim(s, xb, zb); memo.set(s, 0, h); memo.set(s, 1, NaN); memo.misses++; }
        v[i + 1] += h;
        const ny = v[i + 4];
        if (ny > -1e-4 && ny < 1e-4) continue;   // vertical faces: the shear leaves them unchanged
        let g0 = memo.value(s, 1), g1: number;
        if (g0 === g0) g1 = memo.value(s, 2);   // cached (not NaN)
        else {
            if (grad) grad(x, z, g);
            else {
                const xp = (fn(x + e, z) - h) / e, xm = (h - fn(x - e, z)) / e;
                const zp = (fn(x, z + e) - h) / e, zm = (h - fn(x, z - e)) / e;
                g[0] = Math.abs(xp) < Math.abs(xm) ? xp : xm;
                g[1] = Math.abs(zp) < Math.abs(zm) ? zp : zm;
            }
            g0 = g[0]; g1 = g[1]; memo.set(s, 1, g0); memo.set(s, 2, g1);
        }
        if (g0 === 0 && g1 === 0) continue;
        const nx = v[i + 3] - g0 * ny, nz = v[i + 5] - g1 * ny;
        const L = Math.hypot(nx, ny, nz) || 1;
        v[i + 3] = nx / L; v[i + 4] = ny / L; v[i + 5] = nz / L;
    }
}

/** P22 fusedDrape: applyHeightFieldMemo + applyDomainWarpMemo + the drape's bounds scan in ONE pass over the layer, on
 *  one table (k = 5: height, gradient x / z, warp x / z). Both memo passes key on the PRE-drape (x, z) (the height pass
 *  never moves x or z), and each value is computed by the same call on the same inputs, so the bytes are the same.
 *  `fn` null = no height pass (a baked tier), `warpInto` null = no warp. `bounds` (6 numbers) receives the final
 *  min / max of x, y, z. */
export function applyDrapeFused(geo: MeshGeometry, fn: HeightFn | ((x: number, z: number) => number) | null,
    warpInto: ((x: number, z: number, out: [number, number]) => void) | null, memo: XZMemo, bounds: Float64Array): void {
    const v = geo.vertices, bits = new Int32Array(v.buffer, v.byteOffset, v.length);
    memo.reset(v.length / 12);
    const grad = fn ? (fn as HeightFn).grad : undefined;
    const g: [number, number] = [0, 0], o: [number, number] = [0, 0], e = 0.01;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], z = v[i + 2], xb = bits[i], zb = bits[i + 2];
        let s = memo.find(xb, zb), h = 0, dx = 0, dz = 0;
        if (s >= 0) { h = memo.value(s, 0); dx = memo.value(s, 3); dz = memo.value(s, 4); memo.hits++; }
        else {
            s = memo.claim(s, xb, zb);
            if (fn) { h = fn(x, z); memo.set(s, 0, h); memo.set(s, 1, NaN); }
            if (warpInto) { warpInto(x, z, o); dx = o[0]; dz = o[1]; memo.set(s, 3, dx); memo.set(s, 4, dz); }
            memo.misses++;
        }
        if (fn) {
            v[i + 1] += h;
            const ny = v[i + 4];
            if (!(ny > -1e-4 && ny < 1e-4)) {   // vertical faces: the shear leaves them unchanged
                let g0 = memo.value(s, 1), g1: number;
                if (g0 === g0) g1 = memo.value(s, 2);
                else {
                    if (grad) grad(x, z, g);
                    else {
                        const xp = (fn(x + e, z) - h) / e, xm = (h - fn(x - e, z)) / e;
                        const zp = (fn(x, z + e) - h) / e, zm = (h - fn(x, z - e)) / e;
                        g[0] = Math.abs(xp) < Math.abs(xm) ? xp : xm;
                        g[1] = Math.abs(zp) < Math.abs(zm) ? zp : zm;
                    }
                    g0 = g[0]; g1 = g[1]; memo.set(s, 1, g0); memo.set(s, 2, g1);
                }
                if (g0 !== 0 || g1 !== 0) {
                    const nx = v[i + 3] - g0 * ny, nz = v[i + 5] - g1 * ny;
                    const L = Math.hypot(nx, ny, nz) || 1;
                    v[i + 3] = nx / L; v[i + 4] = ny / L; v[i + 5] = nz / L;
                }
            }
        }
        if (warpInto) { v[i] += dx; v[i + 2] += dz; }
        const px = v[i], py = v[i + 1], pz = v[i + 2];   // the stored (f32) values, as the separate scan reads them
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    }
    bounds[0] = x0; bounds[1] = y0; bounds[2] = z0; bounds[3] = x1; bounds[4] = y1; bounds[5] = z1;
}

/** applyDomainWarp (warp.ts) with the displacement of every distinct (x, z) of the layer computed once (k = 2). */
export function applyDomainWarpMemo(geo: MeshGeometry, warpInto: (x: number, z: number, out: [number, number]) => void, memo: XZMemo): void {
    const v = geo.vertices, bits = new Int32Array(v.buffer, v.byteOffset, v.length);
    memo.reset(v.length / 12);
    const o: [number, number] = [0, 0];
    for (let i = 0; i < v.length; i += 12) {
        const xb = bits[i], zb = bits[i + 2];
        let s = memo.find(xb, zb), dx: number, dz: number;
        if (s >= 0) { dx = memo.value(s, 0); dz = memo.value(s, 1); memo.hits++; }
        else { warpInto(v[i], v[i + 2], o); dx = o[0]; dz = o[1]; s = memo.claim(s, xb, zb); memo.set(s, 0, dx); memo.set(s, 1, dz); memo.misses++; }
        v[i] += dx; v[i + 2] += dz;
    }
}
