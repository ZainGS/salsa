// ── World generation — cheap FAR TWINS of heavy props, built in the same pass (performance-plan P9) ──────────────
// The near/far twin mechanism (LayoutPreviewLayer.nearTwin → Mesh3D.lodTwinRole) swaps a chunk's detailed layer for
// a cheap one once the camera is past the twin distance. The static crowd and the chipped stone edges bake their two
// versions by hand. Street props (utility poles, signal housings, lamp posts, roof plant, car trim) are built from
// a few dozen Accum3D primitive calls each, so their far version can be derived from the SAME calls:
//
//   · LoAccum3D is an Accum3D whose primitives emit a cheaper shape: fewer ring sides (by the part's size in pixels
//     at the swap distance), simplified lathe profiles and sweep paths, chamfered boxes as plain boxes, and parts
//     smaller than about a pixel at the swap distance (bolts, braces, clamps, thin rods) left out.
//   · TwinAccum3D is an Accum3D that forwards every primitive call to a LoAccum3D as well. A builder only swaps
//     `new Accum3D()` for `new TwinAccum3D(spec)`; its output is unchanged and `.lo` holds the far twin.
//
// Nothing is random here and the full accumulator's output is bit-identical to a plain Accum3D's, so the near twin
// is exactly the pre-P9 geometry.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { Accum3D, oboxPartFwd, beamPartFwd, type WallsWinOpts } from './meshbuild';
import type { V2, LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

/** What the far twin may drop or simplify, in WORLD units. */
export interface LoSpec {
    /** World units per pixel at the swap distance. */
    px: number;
    /** About one pixel at the swap distance: a part whose cross-section (both thin axes) is under this is left out. */
    thin: number;
    /** A part whose largest extent is under this is left out. */
    size: number;
    /** Ring sides never exceed this. */
    maxSides: number;
}

/** The LoSpec for a swap distance of `distM` metres at `unitsPerMetre` (a 900 px tall view with a 50° lens shows
 *  about distM / 965 metres per pixel there; the far twin drops what is thinner than ~1.2 px). */
export function loSpecFor(distM: number, unitsPerMetre: number): LoSpec {
    const px = (distM / 965) * unitsPerMetre;
    return { px, thin: px * 1.2, size: px * 2.5, maxSides: 6 };
}

/** Ring sides for a round part of diameter `d`: the fewest whose polygon stays within ~1 px of the circle at the
 *  swap distance (r·(1 − cos(π/n)) ≤ 1 px), 3 at least, `maxSides` at most, never more than the full shape's `n`. */
function sidesFor(n: number, d: number, s: LoSpec): number {
    const D = d / s.px;
    const need = D <= 2 ? 3 : Math.ceil(Math.PI / Math.acos(1 - 2 / D));
    return Math.max(3, Math.min(n, s.maxSides, need));
}

/** Douglas-Peucker over a lathe profile ([radius, height] pairs), keeping both ends. */
function simplifyProfile(p: [number, number][], tol: number): [number, number][] {
    if (p.length <= 2) return p;
    const keep = new Uint8Array(p.length); keep[0] = 1; keep[p.length - 1] = 1;
    const rec = (a: number, b: number): void => {
        const [ax, ay] = p[a], [bx, by] = p[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
        let best = -1, bd = tol;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs((p[i][0] - ax) * dy - (p[i][1] - ay) * dx) / L;
            if (d > bd) { bd = d; best = i; }
        }
        if (best >= 0) { keep[best] = 1; rec(a, best); rec(best, b); }
    };
    rec(0, p.length - 1);
    return p.filter((_, i) => keep[i]);
}

/** The far-twin accumulator: every primitive emits its cheap version (or nothing). */
export class LoAccum3D extends Accum3D {
    constructor(readonly spec: LoSpec) { super(); }

    /** True when a part with these three extents is too small to keep: the largest is under `size`, or the two
     *  largest are both under `thin` (a rod / wire seen side-on). */
    private tiny(a: number, b: number, c: number): boolean {
        const s = this.spec;
        const hi = Math.max(a, b, c), lo = Math.min(a, b, c), mid = a + b + c - hi - lo;
        return hi < s.size || mid < s.thin;
    }

    override prism(c: V3, rx: number, rz: number, h: number, sides = 4, rot = 0): void {
        if (this.tiny(2 * rx, 2 * rz, h)) return;
        super.prism(c, rx, rz, h, sidesFor(sides, 2 * Math.max(rx, rz), this.spec), rot);
    }
    override beam(a: V3, b: V3, r: number, sides = 4): void {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (this.tiny(2 * r, 2 * r, L)) return;
        super.beam(a, b, r, sidesFor(sides, 2 * r, this.spec));
    }
    override cone(c: V3, r: number, h: number, sides = 6, rot = 0): void {
        if (this.tiny(2 * r, 2 * r, h)) return;
        super.cone(c, r, h, sidesFor(sides, 2 * r, this.spec), rot);
    }
    override blob(c: V3, rx: number, ry: number, rz: number, jitter = 0, seed = 0): void {
        if (this.tiny(2 * rx, 2 * ry, 2 * rz)) return;
        super.blob(c, rx, ry, rz, jitter, seed);
    }
    override ellipsoid(c: V3, ax: V3, ay: V3, az: V3, rx: number, ryTop: number, ryBot: number, rz: number, segs = 10, rings = 6): void {
        if (this.tiny(2 * rx, ryTop + ryBot, 2 * rz)) return;
        super.ellipsoid(c, ax, ay, az, rx, ryTop, ryBot, rz, sidesFor(segs, 2 * Math.max(rx, rz), this.spec), Math.max(2, Math.ceil(rings / 2)));
    }
    override obox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number): void {
        if (this.tiny(2 * hx, 2 * hy, 2 * hz)) return;
        super.obox(c, ax, ay, az, hx, hy, hz);
    }
    /** A chamfered box reads as a plain box from afar (12 tris instead of 44). */
    override bevelBox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, _b: number): void {
        this.obox(c, ax, ay, az, hx, hy, hz);
    }
    override disc(c: V3, dir: V3, r: number, segs = 12): void {
        if (2 * r < this.spec.size) return;
        super.disc(c, dir, r, sidesFor(segs, 2 * r, this.spec));
    }
    override hood(c: V3, axis: V3, up: V3, front: V3, r: number, halfW: number, segs = 6): void {
        if (this.tiny(r, r, 2 * halfW)) return;
        super.hood(c, axis, up, front, r, halfW, Math.max(2, Math.round(segs / 3)));
    }
    override lathe(c: V3, axis: V3, profile: [number, number][], sides = 8, opts: { smooth?: boolean; caps?: [boolean, boolean]; rot?: number } = {}): void {
        if (profile.length < 2) return;
        let rMax = 0, h0 = Infinity, h1 = -Infinity;
        for (const [r, h] of profile) { if (r > rMax) rMax = r; if (h < h0) h0 = h; if (h > h1) h1 = h; }
        if (this.tiny(2 * rMax, 2 * rMax, h1 - h0)) return;
        // Profile detail under ~half a pixel (collars, bevels, drip lips) folds into the straight run.
        const prof = simplifyProfile(profile, this.spec.thin * 0.5);
        super.lathe(c, axis, prof, sidesFor(sides, 2 * rMax, this.spec), opts);
    }
    override sweep(path: V3[], radius: number | number[], sides = 6, caps: [boolean, boolean] = [false, true]): void {
        const n = path.length; if (n < 2) return;
        const rAt = (i: number): number => typeof radius === 'number' ? radius : radius[Math.min(i, radius.length - 1)];
        let rMax = 0, L = 0;
        for (let i = 0; i < n; i++) { rMax = Math.max(rMax, rAt(i)); if (i) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]); }
        if (this.tiny(2 * rMax, 2 * rMax, L)) return;
        // Every other path point (both ends kept): a curved arm keeps its arc at half the rings.
        const idx: number[] = [];
        for (let i = 0; i < n; i += 2) idx.push(i);
        if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
        const p2 = idx.map(i => path[i]), r2 = typeof radius === 'number' ? radius : idx.map(i => rAt(i));
        super.sweep(p2, r2, sidesFor(sides, 2 * rMax, this.spec), caps);
    }
}

/** An Accum3D that ALSO builds its far twin: every primitive goes to the full accumulator (unchanged output) and,
 *  in its cheap form, to `lo`. Raw vertex()/triangle() geometry is copied to `lo` as is (index-mapped). */
export class TwinAccum3D extends Accum3D {
    readonly lo: LoAccum3D;
    /** Re-entrancy depth: a primitive implemented with another (bevelBox → obox) forwards only once. */
    private _d = 0;
    private _vmap: number[] = [];
    constructor(spec: LoSpec) { super(); this.lo = new LoAccum3D(spec); }

    /** P20: a prop part brackets BOTH twins (the far twin's part k is the near twin's part k, possibly empty). */
    override beginPart(o: [number, number, number], fwd: V2 = [0, 1]): void { super.beginPart(o, fwd); this.lo.beginPart(o, fwd); }
    override endPart(): void { super.endPart(); this.lo.endPart(); }
    /** Stop / resume forwarding to `lo` (see fullOnly). */
    pauseLo(): void { this._d++; }
    resumeLo(): void { this._d--; }

    private _both(full: () => void, lo: () => void): void {
        if (this._d === 0) lo();
        this._d++;
        try { full(); } finally { this._d--; }
    }

    override vertex(p: V3, n: V3, u = 0, v = 0): number {
        const i = super.vertex(p, n, u, v);
        if (this._d === 0) this._vmap[i] = this.lo.vertex(p, n, u, v);
        return i;
    }
    override triangle(a: number, b: number, c: number): void {
        super.triangle(a, b, c);
        if (this._d === 0) { const m = this._vmap; if (m[a] !== undefined && m[b] !== undefined && m[c] !== undefined) this.lo.triangle(m[a], m[b], m[c]); }
    }
    override prism(c: V3, rx: number, rz: number, h: number, sides = 4, rot = 0): void { this._autoTwin(c, [0, 1], () => this._both(() => super.prism(c, rx, rz, h, sides, rot), () => this.lo.prism(c, rx, rz, h, sides, rot))); }
    override beam(a: V3, b: V3, r: number, sides = 4): void { this._autoTwin(a, beamPartFwd(a, b), () => this._both(() => super.beam(a, b, r, sides), () => this.lo.beam(a, b, r, sides))); }
    /** P20 auto parts on a twin: the part opens on BOTH accumulators before either emits (the far twin's part k is the
     *  near twin's part k, empty when the far twin drops the primitive). */
    private _autoTwin(o: V3, fwd: V2, fn: () => void): void {
        if (this._autoOpen(o, fwd)) { try { fn(); } finally { this.endPart(); } return; }
        fn();
    }
    override cone(c: V3, r: number, h: number, sides = 6, rot = 0): void { this._both(() => super.cone(c, r, h, sides, rot), () => this.lo.cone(c, r, h, sides, rot)); }
    override blob(c: V3, rx: number, ry: number, rz: number, jitter = 0, seed = 0): void { this._both(() => super.blob(c, rx, ry, rz, jitter, seed), () => this.lo.blob(c, rx, ry, rz, jitter, seed)); }
    override ellipsoid(c: V3, ax: V3, ay: V3, az: V3, rx: number, ryTop: number, ryBot: number, rz: number, segs = 10, rings = 6): void {
        this._both(() => super.ellipsoid(c, ax, ay, az, rx, ryTop, ryBot, rz, segs, rings), () => this.lo.ellipsoid(c, ax, ay, az, rx, ryTop, ryBot, rz, segs, rings));
    }
    override walls(poly: V2[], baseY: number, height: number, skip?: boolean[]): void { this._both(() => super.walls(poly, baseY, height, skip), () => this.lo.walls(poly, baseY, height, skip)); }
    override wallsWin(poly: V2[], baseY: number, height: number, cellW: number, cellH: number, opts?: WallsWinOpts): void {
        this._both(() => super.wallsWin(poly, baseY, height, cellW, cellH, opts), () => this.lo.wallsWin(poly, baseY, height, cellW, cellH, opts));
    }
    override pyramid(poly: V2[], baseY: number, height: number): void { this._both(() => super.pyramid(poly, baseY, height), () => this.lo.pyramid(poly, baseY, height)); }
    override frustum(bottom: V2[], top: V2[], yB: number, yT: number): void { this._both(() => super.frustum(bottom, top, yB, yT), () => this.lo.frustum(bottom, top, yB, yT)); }
    override cap(poly: V2[], y: number, ny = 1): void { this._both(() => super.cap(poly, y, ny), () => this.lo.cap(poly, y, ny)); }
    override obox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number): void { this._autoTwin(c, oboxPartFwd(ay, az), () => this._both(() => super.obox(c, ax, ay, az, hx, hy, hz), () => this.lo.obox(c, ax, ay, az, hx, hy, hz))); }
    override disc(c: V3, dir: V3, r: number, segs = 12): void { this._both(() => super.disc(c, dir, r, segs), () => this.lo.disc(c, dir, r, segs)); }
    override hood(c: V3, axis: V3, up: V3, front: V3, r: number, halfW: number, segs = 6): void { this._both(() => super.hood(c, axis, up, front, r, halfW, segs), () => this.lo.hood(c, axis, up, front, r, halfW, segs)); }
    override quad4(a: V3, b: V3, c: V3, d: V3): void { this._both(() => super.quad4(a, b, c, d), () => this.lo.quad4(a, b, c, d)); }
    override quad4u(a: V3, b: V3, c: V3, d: V3, u0: number, u1: number): void { this._both(() => super.quad4u(a, b, c, d, u0, u1), () => this.lo.quad4u(a, b, c, d, u0, u1)); }
    override quadUV4(a: V3, b: V3, c: V3, d: V3, ua: V2, ub: V2, uc: V2, ud: V2): void { this._both(() => super.quadUV4(a, b, c, d, ua, ub, uc, ud), () => this.lo.quadUV4(a, b, c, d, ua, ub, uc, ud)); }
    override quadUV(a: V3, b: V3, c: V3, d: V3): void { this._both(() => super.quadUV(a, b, c, d), () => this.lo.quadUV(a, b, c, d)); }
    override lathe(c: V3, axis: V3, profile: [number, number][], sides = 8, opts: { smooth?: boolean; caps?: [boolean, boolean]; rot?: number } = {}): void {
        this._both(() => super.lathe(c, axis, profile, sides, opts), () => this.lo.lathe(c, axis, profile, sides, opts));
    }
    override sweep(path: V3[], radius: number | number[], sides = 6, caps: [boolean, boolean] = [false, true]): void {
        this._both(() => super.sweep(path, radius, sides, caps), () => this.lo.sweep(path, radius, sides, caps));
    }
    override bevelBox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, b: number): void {
        this._both(() => super.bevelBox(c, ax, ay, az, hx, hy, hz, b), () => this.lo.bevelBox(c, ax, ay, az, hx, hy, hz, b));
    }
}

/** The far twin of an accumulator made by twinAccum (null for a plain Accum3D). */
export function loOf(acc: Accum3D): Accum3D | null {
    return acc instanceof TwinAccum3D ? acc.lo : null;
}

/** Emit `fn` into the FULL accumulators only (no far-twin forwarding) — for detail a builder replaces with its own
 *  cheap version in `loOf(acc)` (wheel spokes and hubs built from raw faces). */
export function fullOnly(accs: Accum3D[], fn: () => void): void {
    const tw = accs.filter((a): a is TwinAccum3D => a instanceof TwinAccum3D);
    for (const a of tw) a.pauseLo();
    try { fn(); } finally { for (const a of tw) a.resumeLo(); }
}

/** The near/far twin swap distances (metres) of the P9 prop families. Mirrored into WorldManager.cityDistanceTiers,
 *  which re-stamps them at runtime (Mesh3D.lodTwinDist). */
export const PROP_TWIN_M = { pole: 45, signal: 45, lamp: 45, roofEquip: 60, carTrim: 35 } as const;


/** A TwinAccum3D for a swap distance of `distM` metres — or a plain Accum3D when the twins are off (the world param
 *  `propTwins: false`, the pre-P9 build for A/B; it travels with the params into the build workers). */
export function twinAccum(distM: number, unitsPerMetre: number, on: boolean | undefined): Accum3D {
    return on !== false ? new TwinAccum3D(loSpecFor(distM, unitsPerMetre)) : new Accum3D();
}

/** The far twin's geometry of an accumulator made by twinAccum (null for a plain Accum3D or an empty twin). */
export function loGeometry(acc: Accum3D): MeshGeometry | null {
    return acc instanceof TwinAccum3D && !acc.lo.empty ? acc.lo.geometry() : null;
}

/** Turn one built layer into its near/far twin pair when `acc` carries a far twin: the layer itself becomes the
 *  NEAR twin (unchanged geometry) and a copy with the cheap geometry the FAR twin, same name and material (so every
 *  name-keyed rule still holds). `uvFromNear`: ground-surface layers take their uv-scale sample from the near
 *  geometry, so the near look is exactly the pre-P9 one. Returns [layer] when there is no twin. */
export function withFarTwin(layer: LayoutPreviewLayer, acc: Accum3D, key: string, distM: number, unitsPerMetre: number): LayoutPreviewLayer[] {
    const lo = loGeometry(acc);
    if (!lo) return [layer];
    // gridTris: the pair chunks on the grid the plain (near) layer would have had (chunking.ts nearTwinGrids), so
    // culling granularity and draw calls stay the pre-twin ones — exactly one twin of a cell draws.
    const dist = distM * unitsPerMetre, gridTris = Math.floor(layer.geometry.indices.length / 3);
    return [
        { ...layer, nearTwin: { key, role: 'near', dist, gridTris, uvFromNear: true } },
        { ...layer, geometry: lo, nearTwin: { key, role: 'far', dist, gridTris, uvFromNear: true } },
    ];
}
