/**
 * CollisionHood — a cached "neighbourhood" candidate list for Play-mode collision rays (docs/specs/performance-plan.md P6).
 *
 * Play casts ~10 short rays a frame: the 5-ray third-person camera bundle, the knee / mid / head wall rays and the
 * headroom ray. The XZ broadphase grid (spatial-grid.ts) hands each one ~500 city meshes, because a chunked city layer's
 * box is a whole 20-30 m cell and the character stands inside dozens of them. Each candidate then costs a matrix
 * inverse + a BVH walk, ~4 ms a frame in a city.
 *
 * The hood keeps ONE box around the character and the list of meshes that actually have a triangle inside it
 * (`touches`, conservative). A ray whose whole segment lies inside the box can only hit one of those, so it is tested
 * against that short list instead — same nearest hit. The box is re-centred (and the list rebuilt) only when a ray
 * leaves it, which at walking speed is every couple of seconds. Unbounded rays (maxDist = Infinity, e.g. the ground
 * search) return null so the caller keeps its own list.
 *
 * Pure + injected, so it is unit-tested headless (collision-hood.test.ts).
 */

export type HoodBox = [number, number, number, number, number, number];   // minX, minY, minZ, maxX, maxY, maxZ

export interface CollisionHoodDeps<T> {
    /** Broadphase superset: every mesh that may overlap the XZ region (the grid query). May return a scratch array. */
    region(minX: number, minZ: number, maxX: number, maxZ: number): readonly T[];
    /** Conservative: may any triangle of `mesh` lie inside the world box? (true when unsure — never a false negative.) */
    touches(mesh: T, b: HoodBox): boolean;
    /** Meshes that move during Play (city traffic, walkers): always kept, their snapshot transform says nothing. */
    alwaysKeep?(mesh: T): boolean;
}

export interface CollisionHoodOptions {
    /** Box half-size as a multiple of the longest bounded ray seen so far (default 3: room to walk before a rebuild). */
    growth?: number;
    /** Segments longer than this are never served (they would need a huge box). Default Infinity. */
    maxSegment?: number;
}

export class CollisionHood<T> {
    private _box: HoodBox | null = null;
    private _list: T[] = [];
    private _maxSeg = 0;
    private readonly _growth: number;
    private readonly _maxSegment: number;
    /** Diagnostics: rebuilds so far, the last rebuild's list size / broadphase size / ms, rays served from the hood. */
    readonly stats = { rebuilds: 0, size: 0, regionSize: 0, lastMs: 0, served: 0, passed: 0 };

    constructor(private readonly deps: CollisionHoodDeps<T>, opts: CollisionHoodOptions = {}) {
        this._growth = Math.max(1.05, opts.growth ?? 3);
        this._maxSegment = opts.maxSegment ?? Infinity;
    }

    /** Forget the box (scene / broadphase changed). */
    reset(): void { this._box = null; this._list = []; }

    /** The current box (null before the first served ray). */
    get box(): Readonly<HoodBox> | null { return this._box; }

    /** The short candidate list for the ray origin + t * dir, t in [0, maxDist], or null when the segment is unbounded
     *  (the caller then uses its own broadphase list). `dir` is normalised here. */
    candidatesFor(origin: ArrayLike<number>, dir: ArrayLike<number>, maxDist: number): readonly T[] | null {
        if (!(maxDist >= 0) || !Number.isFinite(maxDist)) { this.stats.passed++; return null; }
        const dl = Math.hypot(dir[0], dir[1], dir[2]);
        const k = dl > 0 ? maxDist / dl : 0;
        const ex = origin[0] + dir[0] * k, ey = origin[1] + dir[1] * k, ez = origin[2] + dir[2] * k;
        const sx0 = Math.min(origin[0], ex), sx1 = Math.max(origin[0], ex);
        const sy0 = Math.min(origin[1], ey), sy1 = Math.max(origin[1], ey);
        const sz0 = Math.min(origin[2], ez), sz1 = Math.max(origin[2], ez);
        if (!Number.isFinite(sx0 + sx1 + sy0 + sy1 + sz0 + sz1)) { this.stats.passed++; return null; }
        if (maxDist > this._maxSegment) { this.stats.passed++; return null; }
        const b = this._box;
        if (b && sx0 >= b[0] && sy0 >= b[1] && sz0 >= b[2] && sx1 <= b[3] && sy1 <= b[4] && sz1 <= b[5]) { this.stats.served++; return this._list; }
        // Re-centre on this segment, sized for the longest ray seen (the camera bundle), and rebuild the list.
        if (maxDist > this._maxSeg) this._maxSeg = maxDist;
        const h = Math.max(this._maxSeg * this._growth, 1e-6);
        const cx = (sx0 + sx1) * 0.5, cy = (sy0 + sy1) * 0.5, cz = (sz0 + sz1) * 0.5;
        const hx = Math.max(h, (sx1 - sx0) * 0.5), hy = Math.max(h, (sy1 - sy0) * 0.5), hz = Math.max(h, (sz1 - sz0) * 0.5);
        const nb: HoodBox = [cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz];
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const cands = this.deps.region(nb[0], nb[2], nb[3], nb[5]);
        const keep = this.deps.alwaysKeep;
        const list: T[] = [];
        for (let i = 0; i < cands.length; i++) {
            const m = cands[i];
            if ((keep && keep(m)) || this.deps.touches(m, nb)) list.push(m);
        }
        this._box = nb;
        this._list = list;
        const st = this.stats;
        st.rebuilds++; st.size = list.length; st.regionSize = cands.length; st.served++;
        st.lastMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
        return list;
    }
}
