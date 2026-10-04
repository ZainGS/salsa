/**
 * Collision cells — lazy, per-cell merged BVHs for Play-mode collision rays (engine-roadmap step 3, performance-plan
 * §P13 "Step 3").
 *
 * Before: every collision ray tested a candidate list of meshes, each with its OWN BVH, built lazily on first contact
 * on the main thread. A streamed tile's layers are tile-wide meshes (one per layer, up to ~0.2 s of BVH build each),
 * so walking into a tile meant seconds of BVH builds (budgeted at 4 ms a frame, with partial answers meanwhile), and
 * every ray paid a slab test per candidate plus one BVH walk per surviving mesh (1.3-2.3 ms a frame).
 *
 * Now the static world around the player is cut into square CELLS on the XZ plane. A cell's WINDOW is its core square
 * plus a margin (>= the longest Play ray: the third-person camera reach). Its triangles are every triangle of every
 * STATIC collision mesh (identity model matrix, uploaded, not skinned, not a mover) whose XZ box overlaps the window —
 * one triangle soup, gathered in time slices on the main thread (per-mesh RUN boxes of 256 triangles skip the parts
 * of tile-wide meshes far away), and turned into ONE flat BVH in a worker (collision-jobs.ts). A ray whose whole XZ
 * footprint lies inside a ready cell's window walks that one BVH; everything the cell does not cover (movers, moved
 * or non-identity meshes, meshes that arrived after the cell was gathered) still goes through the old per-mesh path.
 *
 * SAME RESULTS. For an identity matrix the old path's local ray is the world ray rounded to f32 (gl-matrix vec4 math)
 * and its triangle test reads the same f32 vertex values; the cell BVH runs the same Moller-Trumbore test on copies of
 * those values with that same ray, so every triangle gets the same t. The per-mesh choice (min t), the cross-mesh
 * choice (min world distance, ties to the earlier candidate) and the final distance / normal (MeshPicker.hitFromLocalT,
 * the tail of intersectMesh) are reproduced; near-ties within f32 rounding of each other are resolved exactly as the
 * old code would. The one residual difference: two triangles of ONE mesh hit at exactly the same t (a ray through a
 * shared edge) — the old per-mesh BVH kept whichever its traversal reached first, the cell keeps the lower triangle
 * index. The live check (scripts/rays) counts any difference.
 *
 * Pure (no scene / WebGPU imports): the manager gets its scene access injected, so it is unit-tested headless.
 */

export const CELL_RUN_TRIS = 256;
const EPSILON = 1e-7;
const LEAF_MAX = 8;

// ── Run boxes: per-256-triangle XZ (+Y) boxes of a mesh, so a cell gather touches only the nearby part of a big mesh ──

/** [minX, minY, minZ, maxX, maxY, maxZ] per run of `runTris` triangles in index order. */
export function triRunBoxes(v: Float32Array, ix: Uint32Array, runTris = CELL_RUN_TRIS, stride = 12): Float32Array {
    const tris = (ix.length / 3) | 0, runs = Math.ceil(tris / runTris);
    const out = new Float32Array(runs * 6);
    for (let r = 0; r < runs; r++) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        const end = Math.min(tris, (r + 1) * runTris) * 3;
        for (let k = r * runTris * 3; k < end; k++) {
            const o = ix[k] * stride, x = v[o], y = v[o + 1], z = v[o + 2];
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        out.set([x0, y0, z0, x1, y1, z1], r * 6);
    }
    return out;
}

/** Attach `geometry.runBoxes` (triRunBoxes) to every indexed layer geometry that lacks them — run in the tile / centre
 *  WORKER after the drape and chunking (final positions), so a Play collision cell gathers a tile-wide layer without a
 *  main-thread pass over it. Shared geometry is visited once. */
export function attachRunBoxes(groups: { layers: { geometry: { vertices: Float32Array; indices?: Uint32Array; runBoxes?: Float32Array } }[] }[]): void {
    for (const grp of groups) for (const L of grp.layers) {
        const g = L.geometry;
        if (g.runBoxes || !g.indices || g.indices.length < 3 || g.vertices.length < 36) continue;
        g.runBoxes = triRunBoxes(g.vertices, g.indices);
    }
}

// ── The cell soup + its flat BVH (built in the worker; the same function is the main-thread fallback) ──

/** A cell's triangle soup: 9 floats per triangle (the source f32 vertex values) + (member index, triangle index). */
export interface CellSoup { tris: Float32Array; ids: Uint32Array }

/** A flat BVH over a cell soup. Node i: bounds[6i..6i+5]; data[2i] = left child (right = left + 1) or, for a leaf,
 *  -(first triangle + 1); data[2i + 1] = the leaf's triangle count (0 for an internal node). Triangles are reordered
 *  so each leaf's are contiguous (tris / ids). */
export interface FlatBVH { bounds: Float32Array; data: Int32Array; tris: Float32Array; ids: Uint32Array; nodes: number }

/** Build the flat BVH (median split on the longest axis by centroid, like MeshBVH; 8 triangles a leaf). */
export function buildFlatBVH(soup: CellSoup): FlatBVH {
    const n = (soup.tris.length / 9) | 0;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
    const T = soup.tris;
    for (let i = 0; i < n; i++) {
        const o = i * 9;
        cx[i] = (T[o] + T[o + 3] + T[o + 6]) / 3; cy[i] = (T[o + 1] + T[o + 4] + T[o + 7]) / 3; cz[i] = (T[o + 2] + T[o + 5] + T[o + 8]) / 3;
    }
    const cap = Math.max(1, 2 * Math.ceil(n / LEAF_MAX) + 1);
    let bounds = new Float32Array(cap * 6), data = new Int32Array(cap * 2);
    let count = 0;
    const alloc = (): number => {
        if (count >= data.length / 2) {
            const nb = new Float32Array(bounds.length * 2); nb.set(bounds); bounds = nb;
            const nd = new Int32Array(data.length * 2); nd.set(data); data = nd;
        }
        return count++;
    };
    const fill = (node: number, start: number, end: number): number => {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = start; i < end; i++) {
            const o = order[i] * 9;
            for (let k = 0; k < 9; k += 3) {
                const x = T[o + k], y = T[o + k + 1], z = T[o + k + 2];
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
                if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
        }
        const b = node * 6;
        bounds[b] = x0; bounds[b + 1] = y0; bounds[b + 2] = z0; bounds[b + 3] = x1; bounds[b + 4] = y1; bounds[b + 5] = z1;
        const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
        return ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    };
    if (n > 0) {
        // Explicit stack: [node, start, end].
        const root = alloc();
        const stack: number[] = [root, 0, n];
        while (stack.length) {
            const end = stack.pop()!, start = stack.pop()!, node = stack.pop()!;
            const axis = fill(node, start, end);
            if (end - start <= LEAF_MAX) { data[node * 2] = -(start + 1); data[node * 2 + 1] = end - start; continue; }
            const C = axis === 0 ? cx : axis === 1 ? cy : cz;
            const mid = (start + end) >> 1;
            selectNth(order, C, start, end - 1, mid);
            const l = alloc(), r = alloc();   // consecutive: right = left + 1
            data[node * 2] = l; data[node * 2 + 1] = 0;
            void r;
            stack.push(r, mid, end, l, start, mid);
        }
    }
    const tris = new Float32Array(n * 9), ids = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const s = order[i];
        tris.set(T.subarray(s * 9, s * 9 + 9), i * 9);
        ids[i * 2] = soup.ids[s * 2]; ids[i * 2 + 1] = soup.ids[s * 2 + 1];
    }
    return { bounds: bounds.slice(0, count * 6), data: data.slice(0, count * 2), tris, ids, nodes: count };
}

function selectNth(tri: Uint32Array, C: Float64Array, lo: number, hi: number, k: number): void {
    while (hi > lo) {
        const m = (lo + hi) >> 1;
        const a = C[tri[lo]], b = C[tri[m]], c = C[tri[hi]];
        const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
        let i = lo, j = hi;
        while (i <= j) {
            while (C[tri[i]] < pivot) i++;
            while (C[tri[j]] > pivot) j--;
            if (i <= j) { const t = tri[i]; tri[i] = tri[j]; tri[j] = t; i++; j--; }
        }
        if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
}

/** Moller-Trumbore, both faces — the exact arithmetic of MeshBVH's leaf test (so the same inputs give the same t). */
export function mtTest(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
): number | null {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const a = e1x * hx + e1y * hy + e1z * hz;
    if (a > -EPSILON && a < EPSILON) return null;
    const f = 1 / a;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return null;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) return null;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    return t > EPSILON ? t : null;
}

/** Slab entry distance of the ray into node `i`'s box (MeshBVH.nodeEntryT's arithmetic), Infinity on a miss. */
function nodeEntry(B: Float32Array, i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const b = i * 6;
    let tMin = -Infinity, tMax = Infinity;
    if (Math.abs(dx) < EPSILON) { if (ox < B[b] || ox > B[b + 3]) return Infinity; }
    else { const inv = 1 / dx; let t1 = (B[b] - ox) * inv, t2 = (B[b + 3] - ox) * inv; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2); if (tMin > tMax) return Infinity; }
    if (Math.abs(dy) < EPSILON) { if (oy < B[b + 1] || oy > B[b + 4]) return Infinity; }
    else { const inv = 1 / dy; let t1 = (B[b + 1] - oy) * inv, t2 = (B[b + 4] - oy) * inv; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2); if (tMin > tMax) return Infinity; }
    if (Math.abs(dz) < EPSILON) { if (oz < B[b + 2] || oz > B[b + 5]) return Infinity; }
    else { const inv = 1 / dz; let t1 = (B[b + 2] - oz) * inv, t2 = (B[b + 5] - oz) * inv; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2); if (tMin > tMax) return Infinity; }
    return tMax >= 0 ? Math.max(0, tMin) : Infinity;
}

/** One triangle hit inside a cell: member index, triangle index (in the member's index buffer), local t. */
export interface CellTriHit { member: number; tri: number; t: number }

/**
 * Every (member, triangle, t) whose t is within `tieEps` of the nearest accepted hit, nearest first, plus `best`.
 * `accept(member)` filters live members (visible, attached, in the current collision snapshot). Iterative,
 * nearest-child-first, pruned at bestT + tieEps and at tCap. Writes into `out` (reused) and returns it.
 */
export function intersectFlatBVH(
    bvh: FlatBVH, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tCap: number,
    tieEps: number, accept: (member: number) => boolean, out: CellTriHit[], stack: number[],
): CellTriHit[] {
    out.length = 0;
    if (bvh.nodes === 0) return out;
    const B = bvh.bounds, D = bvh.data, T = bvh.tris, I = bvh.ids;
    let best = Infinity;
    let sp = 0;
    const t0 = nodeEntry(B, 0, ox, oy, oz, dx, dy, dz);
    if (t0 === Infinity || t0 > tCap) return out;
    stack[sp++] = 0; stack[sp++] = t0;
    while (sp > 0) {
        const tIn = stack[--sp], node = stack[--sp];
        if (tIn > best + tieEps) continue;
        const d0 = D[node * 2];
        if (d0 < 0) {
            const first = -d0 - 1, cnt = D[node * 2 + 1];
            for (let i = first; i < first + cnt; i++) {
                const o = i * 9;
                const t = mtTest(ox, oy, oz, dx, dy, dz, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
                if (t === null || t > tCap || t > best + tieEps) continue;
                const member = I[i * 2];
                if (!accept(member)) continue;
                out.push({ member, tri: I[i * 2 + 1], t });
                if (t < best) best = t;
            }
            continue;
        }
        const l = d0, r = d0 + 1;
        let tl = nodeEntry(B, l, ox, oy, oz, dx, dy, dz), tr = nodeEntry(B, r, ox, oy, oz, dx, dy, dz);
        if (tl > tCap) tl = Infinity;
        if (tr > tCap) tr = Infinity;
        // push the farther first so the nearer pops first
        if (tl <= tr) { if (tr !== Infinity) { stack[sp++] = r; stack[sp++] = tr; } if (tl !== Infinity) { stack[sp++] = l; stack[sp++] = tl; } }
        else { if (tl !== Infinity) { stack[sp++] = l; stack[sp++] = tl; } if (tr !== Infinity) { stack[sp++] = r; stack[sp++] = tr; } }
    }
    if (out.length > 1) {
        let w = 0;
        for (let k = 0; k < out.length; k++) if (out[k].t <= best + tieEps) out[w++] = out[k];
        out.length = w;
        out.sort((a, b) => a.t - b.t || a.member - b.member || a.tri - b.tri);
    }
    return out;
}

// ── The cell manager ──

/** The scene access the manager needs (Scene3DManager supplies the real ones; tests a fake). */
export interface CollisionCellDeps<M> {
    /** Collision-snapshot meshes whose XZ box may overlap the region (a superset is fine). May be a scratch array. */
    region(minX: number, minZ: number, maxX: number, maxZ: number): readonly M[];
    /** The mesh's geometry if it is STATIC cell geometry right now (identity matrix, uploaded, not skinned / a mover),
     *  with a change key (the geometry object) and version (the matrix version); null = not static (stays residual). */
    staticGeometry(m: M): { vertices: Float32Array; indices: Uint32Array; key: object; ver: number; runBoxes?: unknown } | null;
    /** The mesh's world XZ box [minX, minZ, maxX, maxZ] (conservative), or null when unknown. */
    xzBox(m: M): readonly [number, number, number, number] | null;
    /** Is a gathered member still what was gathered (same geometry `key`, matrix version `ver`, still uploaded)? The
     *  per-tick validation — cheaper than staticGeometry. */
    same(m: M, key: object, ver: number): boolean;
    /** Build the flat BVH (a worker job; the fallback resolves later on the main thread). */
    build(soup: CellSoup): Promise<FlatBVH>;
    now(): number;
}

export interface CollisionCellOptions {
    /** Core size (world units). */
    core: number;
    /** Margin around the core (world units): at least the longest bounded Play ray. */
    margin: number;
    /** Main-thread gather budget per update (ms). Default 1.5. */
    gatherMs?: number;
    /** Cells requested around the player: Chebyshev radius (1 = the 3x3 block). */
    prefetch?: number;
    /** Cells farther than this (Chebyshev) are dropped. */
    evict?: number;
    /** A ready cell that saw residual static meshes is re-gathered after this many ms. Default 1000. */
    staleMs?: number;
}

/** A gathered + built cell. */
export interface CellBuild<M> { bvh: FlatBVH; members: M[]; keys: object[]; vers: number[]; covered: Set<M> }
interface CellGather<M> {
    cands: M[]; ci: number; members: M[]; keys: object[]; vers: number[]; covered: Set<M>; building: boolean;
    /** The soup so far: 9 floats + 2 ids per triangle, in growable typed buffers (no boxed-number arrays to convert). */
    T: Float32Array; I: Uint32Array; n: number;
    /** The member being gathered (resumed run by run). */
    cm: { v: Float32Array; ix: Uint32Array; rb: Float32Array; mi: number; r: number } | null;
}

export class CollisionCell<M> {
    /** What the cell answers from (null = not ready). */
    cur: CellBuild<M> | null = null;
    /** A gather / build in flight (replaces cur when it lands). */
    job: CellGather<M> | null = null;
    staleSince = -1;
    dead = false;
    /** The manager tick this cell's members were last validated on. */
    validTick = -1;
    constructor(readonly ix: number, readonly iz: number, readonly x0: number, readonly z0: number, readonly x1: number, readonly z1: number) {}
    /** Does the XZ box lie inside the window? */
    holds(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
        return minX >= this.x0 && maxX <= this.x1 && minZ >= this.z0 && maxZ <= this.z1;
    }
}

/** Diagnostics (getCollisionStats3D). */
export interface CollisionCellStats {
    cells: number; ready: number; pending: number; builds: number; buildsFailed: number; invalidated: number; stale: number;
    served: number; notReady: number; outside: number; unbounded: number;
    gatherMsMax: number; buildMsMax: number; soupTrisMax: number; soupTrisLast: number; bytes: number;
}

export class CollisionCellManager<M> {
    readonly cells = new Map<string, CollisionCell<M>>();
    readonly stats: CollisionCellStats = { cells: 0, ready: 0, pending: 0, builds: 0, buildsFailed: 0, invalidated: 0, stale: 0, served: 0, notReady: 0, outside: 0, unbounded: 0, gatherMsMax: 0, buildMsMax: 0, soupTrisMax: 0, soupTrisLast: 0, bytes: 0 };
    private readonly _runBoxes = new WeakMap<object, Float32Array>();
    private _tick = 0;

    constructor(private readonly deps: CollisionCellDeps<M>, readonly opts: CollisionCellOptions) {}

    private _key(ix: number, iz: number): string { return ix + ',' + iz; }
    cellIndex(x: number): number { return Math.floor(x / this.opts.core); }

    /** The ready cell that answers the ray origin + t * dir, t in [0, maxDist] (the origin's cell, when the ray's whole XZ
     *  footprint lies in its window), or null (the caller takes the old path). An unbounded ray is answered only when it
     *  is vertical (the ground ray). */
    cellForRay(origin: ArrayLike<number>, dir: ArrayLike<number>, maxDist: number): CollisionCell<M> | null {
        const ox = origin[0], oz = origin[2];
        let x0 = ox, x1 = ox, z0 = oz, z1 = oz;
        if (!Number.isFinite(maxDist)) {
            if (dir[0] !== 0 || dir[2] !== 0) { this.stats.unbounded++; return null; }
        } else {
            const dl = Math.hypot(dir[0], dir[1], dir[2]);
            const k = dl > 0 ? maxDist / dl : 0;
            const ex = ox + dir[0] * k, ez = oz + dir[2] * k;
            if (!Number.isFinite(ex + ez)) { this.stats.unbounded++; return null; }
            x0 = Math.min(ox, ex); x1 = Math.max(ox, ex); z0 = Math.min(oz, ez); z1 = Math.max(oz, ez);
        }
        if (!Number.isFinite(ox + oz)) { this.stats.unbounded++; return null; }
        const c = this.cells.get(this._key(this.cellIndex(ox), this.cellIndex(oz)));
        if (!c || !c.cur) { this.stats.notReady++; return null; }
        if (!c.holds(x0, z0, x1, z1)) { this.stats.outside++; return null; }
        if (c.validTick !== this._tick && !this._validate(c)) { this.stats.notReady++; return null; }
        this.stats.served++;
        return c;
    }

    /** Drop every cell (Play exit, a world swap). */
    clear(): void { for (const c of this.cells.values()) c.dead = true; this.cells.clear(); this._count(); }

    /** A ready cell met static meshes it does not cover (they arrived after its gather): re-gather it in the
     *  background after staleMs; it keeps answering meanwhile (the newcomers go through the old path). */
    markStale(c: CollisionCell<M>): void { if (c.staleSince < 0) { c.staleSince = this.deps.now(); this.stats.stale++; } }

    /** Per tick: drop far cells, validate the near ones, request the missing ones, advance the gathers by the budget. */
    update(px: number, pz: number): void {
        if (!Number.isFinite(px + pz)) return;
        const t0 = this.deps.now();
        const cix = this.cellIndex(px), ciz = this.cellIndex(pz);
        const ev = this.opts.evict ?? 2;
        for (const [k, c] of this.cells) if (Math.max(Math.abs(c.ix - cix), Math.abs(c.iz - ciz)) > ev) { c.dead = true; this.cells.delete(k); }
        this._tick++;   // cells re-validate on their first ray of this tick (only the cells rays actually use)
        const P = this.opts.prefetch ?? 1;
        const want: [number, number, number][] = [];
        for (let dz = -P; dz <= P; dz++) for (let dx = -P; dx <= P; dx++) want.push([cix + dx, ciz + dz, dx * dx + dz * dz]);
        want.sort((a, b) => a[2] - b[2]);
        const staleMs = this.opts.staleMs ?? 1000;
        const budget = this.opts.gatherMs ?? 1.5;
        let spent = false;
        for (const [ix, iz] of want) {
            const k = this._key(ix, iz);
            let c = this.cells.get(k);
            if (!c) {
                const { core, margin } = this.opts;
                c = new CollisionCell<M>(ix, iz, ix * core - margin, iz * core - margin, (ix + 1) * core + margin, (iz + 1) * core + margin);
                this.cells.set(k, c);
            }
            if (spent) continue;
            if (!c.job && (!c.cur || (c.staleSince >= 0 && t0 - c.staleSince > staleMs))) c.job = this._startGather(c);
            if (!c.job || c.job.building) continue;
            if (!this._advance(c, c.job, t0, budget)) spent = true;
        }
        const el = this.deps.now() - t0;
        if (el > this.stats.gatherMsMax) this.stats.gatherMsMax = el;
        this._count();
    }

    /** A member whose geometry / matrix changed (or that stopped being static) → the cell stops answering and is
     *  gathered again. Run once per tick per cell that a ray uses. */
    private _validate(c: CollisionCell<M>): boolean {
        const cur = c.cur!;
        for (let i = 0; i < cur.members.length; i++) {
            if (!this.deps.same(cur.members[i], cur.keys[i], cur.vers[i])) { c.cur = null; c.job = null; this.stats.invalidated++; return false; }
        }
        c.validTick = this._tick;
        return true;
    }

    private _startGather(c: CollisionCell<M>): CellGather<M> {
        const pad = (c.x1 - c.x0) * 1e-4;
        return { cands: this.deps.region(c.x0 - pad, c.z0 - pad, c.x1 + pad, c.z1 + pad).slice(), ci: 0, T: new Float32Array(9 * 4096), I: new Uint32Array(2 * 4096), n: 0, members: [], keys: [], vers: [], covered: new Set<M>(), building: false, cm: null };
    }

    private _runBoxesOf(key: object, v: Float32Array, ix: Uint32Array, pre: unknown): Float32Array {
        const runs = Math.ceil(((ix.length / 3) | 0) / CELL_RUN_TRIS);
        if (pre instanceof Float32Array && pre.length === runs * 6) return pre;
        let rb = this._runBoxes.get(key);
        if (!rb || rb.length !== runs * 6) { rb = triRunBoxes(v, ix); this._runBoxes.set(key, rb); }
        return rb;
    }

    /** Gather until done (→ the worker build) or out of budget (false). */
    private _advance(c: CollisionCell<M>, j: CellGather<M>, t0: number, budget: number): boolean {
        // conservative window: a triangle touching the edge within float slack is kept
        const pad = (c.x1 - c.x0) * 1e-4;
        const wx0 = c.x0 - pad, wz0 = c.z0 - pad, wx1 = c.x1 + pad, wz1 = c.z1 + pad;
        let T = j.T, I = j.I, n = j.n;
        for (;;) {
            // the current member, resumable run by run (a big mesh never holds the budget for its whole length)
            let cm = j.cm;
            if (!cm) {
                if (j.ci >= j.cands.length) break;
                const m = j.cands[j.ci++];
                const g = this.deps.staticGeometry(m);
                if (!g) continue;
                const mi = j.members.length;
                j.members.push(m); j.keys.push(g.key); j.vers.push(g.ver); j.covered.add(m);
                // A static mesh wholly outside the window has no triangle a served ray can reach: covered with none
                // (still a member, so a move / geometry swap invalidates the cell like any other member's).
                const box = this.deps.xzBox(m);
                if (box && (box[2] < wx0 || box[0] > wx1 || box[3] < wz0 || box[1] > wz1)) continue;
                cm = j.cm = { v: g.vertices, ix: g.indices, rb: this._runBoxesOf(g.key, g.vertices, g.indices, g.runBoxes), mi, r: 0 };
            }
            const { v, ix, rb, mi } = cm;
            const tris = (ix.length / 3) | 0, runs = rb.length / 6;
            while (cm.r < runs) {
                const r = cm.r++;
                const b = r * 6;
                if (rb[b + 3] < wx0 || rb[b] > wx1 || rb[b + 5] < wz0 || rb[b + 2] > wz1) continue;
                const end = Math.min(tris, (r + 1) * CELL_RUN_TRIS);
                for (let t = r * CELL_RUN_TRIS; t < end; t++) {
                    const a = ix[t * 3] * 12, bb = ix[t * 3 + 1] * 12, cc = ix[t * 3 + 2] * 12;
                    const ax = v[a], az = v[a + 2], bx = v[bb], bz = v[bb + 2], cx = v[cc], cz = v[cc + 2];
                    if (Math.max(ax, bx, cx) < wx0 || Math.min(ax, bx, cx) > wx1 || Math.max(az, bz, cz) < wz0 || Math.min(az, bz, cz) > wz1) continue;
                    if ((n + 1) * 9 > T.length) {   // grow ×2
                        const T2 = new Float32Array(T.length * 2); T2.set(T); T = j.T = T2;
                        const I2 = new Uint32Array(I.length * 2); I2.set(I); I = j.I = I2;
                    }
                    const o = n * 9;
                    T[o] = ax; T[o + 1] = v[a + 1]; T[o + 2] = az; T[o + 3] = bx; T[o + 4] = v[bb + 1]; T[o + 5] = bz; T[o + 6] = cx; T[o + 7] = v[cc + 1]; T[o + 8] = cz;
                    I[n * 2] = mi; I[n * 2 + 1] = t;
                    n++;
                }
                if ((r & 15) === 15 && this.deps.now() - t0 > budget) { j.n = n; return false; }
            }
            j.cm = null;
            if (this.deps.now() - t0 > budget) { j.n = n; return false; }
        }
        j.n = n;
        const soup: CellSoup = { tris: T.slice(0, n * 9), ids: I.slice(0, n * 2) };
        j.T = new Float32Array(0); j.I = new Uint32Array(0);
        const nTris = soup.ids.length / 2;
        this.stats.soupTrisLast = nTris;
        if (nTris > this.stats.soupTrisMax) this.stats.soupTrisMax = nTris;
        j.building = true;
        const bt0 = this.deps.now();
        this.deps.build(soup).then((bvh) => {
            if (c.dead || c.job !== j) return;
            c.job = null;
            const el = this.deps.now() - bt0;
            if (el > this.stats.buildMsMax) this.stats.buildMsMax = el;
            for (let i = 0; i < j.members.length; i++) {   // a member changed while the worker built → gather again
                if (!this.deps.same(j.members[i], j.keys[i], j.vers[i])) { this.stats.invalidated++; return; }
            }
            c.cur = { bvh, members: j.members, keys: j.keys, vers: j.vers, covered: j.covered };
            c.staleSince = -1;
            this.stats.builds++;
            this._count();
        }, () => { if (!c.dead && c.job === j) { c.job = null; this.stats.buildsFailed++; } });
        return true;
    }

    private _count(): void {
        const s = this.stats;
        s.cells = this.cells.size; s.ready = 0; s.pending = 0; s.bytes = 0;
        for (const c of this.cells.values()) {
            if (c.cur) { s.ready++; const b = c.cur.bvh; s.bytes += b.bounds.byteLength + b.data.byteLength + b.tris.byteLength + b.ids.byteLength; }
            if (c.job) s.pending++;
        }
    }
}

// ── One ray through a ready cell (shared by Scene3DManager and the tests) ──

/** The per-mesh ray path the cell defers to (MeshPicker implements it). */
export interface CellRayPicker<M> {
    identityLocalRay(origin: ArrayLike<number>, dir: ArrayLike<number>, out: Float64Array): Float64Array;
    hitFromLocalT(origin: never, dir: never, mesh: M, tri: number, t: number): { mesh: M; distance: number; faceNormal: [number, number, number] };
    raycastWorld(origin: never, dir: never, meshes: M[], includeNonPickable: boolean, maxDist: number, bvhBudget: boolean): { mesh: M; distance: number; faceNormal: [number, number, number] } | null;
}

/** Scratch for cellRaycast (reused across rays). */
export interface CellRayScratch { ray: Float64Array; hits: CellTriHit[]; stack: number[]; seen: Set<number> }
export const newCellRayScratch = (): CellRayScratch => ({ ray: new Float64Array(7), hits: [], stack: [], seen: new Set<number>() });

/** Counters cellRaycast bumps. */
export interface CellRayCounters { cell: number; residual: number; fallback: number }

/**
 * The nearest hit of origin + t * dir, t in [0, maxDist], over `list` — exactly what the per-mesh path returns over
 * `list` — using the cell's BVH for the meshes it covers and `picker.raycastWorld` for the rest:
 *  - cell triangles are tested with the identity-matrix local ray (MeshPicker.identityLocalRay) and the per-mesh tCap;
 *  - per mesh the nearest triangle wins; across meshes the nearest WORLD distance (MeshPicker.hitFromLocalT), a tie
 *    going to the earlier entry of `list` (the per-mesh path's rule); hits within f32 rounding of the nearest are all
 *    resolved that way;
 *  - `live(m)`: visible, attached, in the current collision snapshot (the per-mesh path only sees such meshes);
 *  - `isStatic(m)` flags static meshes the cell does not cover (they arrived after its gather) → `onStale`.
 * Returns undefined when a covered member is being edited (gpuDirty): the caller takes the per-mesh path.
 */
export function cellRaycast<M extends { gpuDirty: boolean; cheapBounds: boolean }>(
    cur: CellBuild<M>, origin: [number, number, number], dir: [number, number, number], maxDist: number, list: readonly M[],
    picker: CellRayPicker<M>, bvhBudget: boolean, live: (m: M) => boolean, isStatic: (m: M) => boolean, onStale: () => void,
    sc: CellRayScratch, counters: CellRayCounters,
): { distance: number; normal: [number, number, number] } | null | undefined {
    const lr = picker.identityLocalRay(origin, dir, sc.ray);
    const k = lr[6];
    const tCap = maxDist === Infinity || !(k > 0) ? Infinity : (maxDist / k) * (1 + 1e-5) + 1e-6;
    const eps = 1e-5 * Math.max(1, Math.abs(lr[0]), Math.abs(lr[1]), Math.abs(lr[2]));
    const hits = intersectFlatBVH(cur.bvh, lr[0], lr[1], lr[2], lr[3], lr[4], lr[5], tCap, eps, (mi) => live(cur.members[mi]), sc.hits, sc.stack);
    let best: { mesh: M; distance: number; faceNormal: [number, number, number] } | null = null;
    let bestIdx = -2;   // -2 = not looked up yet (only a tie needs the list position)
    const idxOf = (m: M): number => { const i = list.indexOf(m); return i < 0 ? Infinity : i; };
    const seen = sc.seen; seen.clear();
    for (const h of hits) {
        if (seen.has(h.member)) continue;   // per mesh: its nearest triangle (what the per-mesh BVH returns)
        seen.add(h.member);
        const m = cur.members[h.member];
        if (m.gpuDirty) { counters.fallback++; return undefined; }
        const r = picker.hitFromLocalT(origin as never, dir as never, m, h.tri, h.t);
        if (!best || r.distance < best.distance) { best = r; bestIdx = -2; }
        else if (r.distance === best.distance) {
            if (bestIdx === -2) bestIdx = idxOf(best.mesh);
            const ri = idxOf(m);
            if (ri < bestIdx) { best = r; bestIdx = ri; }
        }
    }
    // The rest of the list: movers, moved / non-identity meshes, and static meshes newer than the cell's gather.
    let residual: M[] | null = null;
    let stale = false;
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (cur.covered.has(m)) continue;
        (residual ??= []).push(m);
        if (!stale && !m.cheapBounds && isStatic(m)) stale = true;
    }
    if (stale) onStale();
    if (residual) {
        counters.residual += residual.length;
        const rr = picker.raycastWorld(origin as never, dir as never, residual, true, maxDist, bvhBudget);
        if (rr) {
            if (!best || rr.distance < best.distance) best = rr;
            else if (rr.distance === best.distance) {
                if (bestIdx === -2) bestIdx = idxOf(best.mesh);
                if (idxOf(rr.mesh) < bestIdx) best = rr;
            }
        }
    }
    counters.cell++;
    if (!best || best.distance > maxDist) return null;
    return { distance: best.distance, normal: best.faceNormal };
}
