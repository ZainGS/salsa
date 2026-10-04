/**
 * CollisionSnapshot — the Play collision broadphase, kept up to date INCREMENTALLY (engine-roadmap step 3b;
 * performance-plan.md §P13 "Step 3b").
 *
 * The broadphase is the static mesh set (the scene minus the Player and a few excluded families) plus an XZ grid over
 * their footprints (spatial-grid.ts). A streamed tiled world adds and removes tiles and crowd cells during Play, so it
 * was rebuilt from scratch on every structure change: ~2 ms over ~11.5 k meshes (bounds, string-keyed cell inserts, a
 * Set) in the tiled p95 frames. `sync(all)` instead walks the current mesh list once and only touches what changed:
 * meshes that attached (inserted into their cells), detached (taken out) or whose XZ footprint changed (moved).
 *
 * SAME ANSWERS AS A FULL REBUILD. For a given cell size a query returns exactly the list `SpatialGridXZ.build` over the
 * same members would (oversized members first, then cell by cell in (cx, cz) order, each cell in member order, no
 * duplicates), mapped to meshes. Member order is the order of `all` (the scene walk), which is what the old index
 * order was; every slot carries its position as a key, cells are kept sorted by it, and a sync where the survivors'
 * relative order changed (a reparent / reorder) falls back to a full rebuild. The cell size is picked like
 * SpatialGridXZ.build does (the mean footprint) at a full rebuild and kept while the mean stays within
 * `CELL_DRIFT` × of it; past that the next sync rebuilds.
 *
 * Pure + injected (no scene types), unit-tested against SpatialGridXZ (collision-snapshot.test.ts).
 */

import type { XZBounds } from './spatial-grid';

export interface CollisionSnapshotDeps<T> {
    /** Is `m` collision geometry (in the snapshot)? Evaluated for every mesh on every sync. */
    include(m: T): boolean;
    /** World XZ footprint of `m` into `out` = [minX, minZ, maxX, maxZ]. */
    bounds(m: T, out: Float64Array): void;
    /** Optional change stamp: while `version(m)`, `source(m)` and `epoch()` are unchanged, `bounds(m)` is known to be
     *  unchanged and a sync skips reading it (a mesh's matrix version + geometry object + the global geometry epoch). */
    version?(m: T): number;
    source?(m: T): unknown;
    epoch?(): number;
    /** Optional per-member geometry stamp (P16): compared with version / source. With it the caller can hold `epoch`
     *  still while unrelated meshes get geometry (a streamed tile), so the survivors keep their trusted footprints. */
    geomVersion?(m: T): number;
}

/** What one sync did. `rebuilt` = it fell back to a full rebuild (first sync, order change, cell-size drift). */
export interface SnapshotDelta<T> {
    rebuilt: boolean;
    added: T[];
    removed: T[];
    moved: T[];
    /** XZ cell ranges touched by the change ([x0, z0, x1, z1] per entry; oversized changes set `oversized`). */
    touched: number[];
    oversized: boolean;
}

export class CollisionSnapshot<T> {
    /** Rebuild when the mean footprint drifts more than this factor from the cell size. */
    static CELL_DRIFT = 2;
    cellSize = 1;
    private readonly _cap: number;
    // Slots (index = slot id): mesh, order key, last-seen sync, footprint, oversized flag. Free slots are reused.
    private _mesh: (T | null)[] = [];
    private _key: Float64Array = new Float64Array(0);
    private _seen: Int32Array = new Int32Array(0);
    private _b: Float64Array = new Float64Array(0);
    private _over: Uint8Array = new Uint8Array(0);
    private _ver: Float64Array = new Float64Array(0);
    private _gv: Float64Array = new Float64Array(0);
    private _src: unknown[] = [];
    private _epoch = NaN;
    private readonly _free: number[] = [];
    private readonly _slotOf = new Map<T, number>();
    /** The members (same set as the old snapshot array). */
    readonly members = new Set<T>();
    private readonly _cells = new Map<string, number[]>();
    private readonly _oversized: number[] = [];
    private _stamp: Int32Array = new Int32Array(0);
    private _qgen = 0;
    private _gen = 0;
    private _footSum = 0;      // sum of the finite member footprints
    private _footBad = 0;      // members whose footprint is not finite (NaN / infinite bounds)
    private readonly _tmp = new Float64Array(4);
    /** Diagnostics: syncs, full rebuilds, members added / removed / moved over all syncs, last sync ms. */
    readonly stats = { syncs: 0, rebuilds: 0, added: 0, removed: 0, moved: 0, lastMs: 0, lastRebuilt: false };

    constructor(private readonly deps: CollisionSnapshotDeps<T>, oversizedCellCap = 256) {
        this._cap = oversizedCellCap;
    }

    get size(): number { return this.members.size; }

    /** Members in order (key order) — the array a full rebuild would index. */
    orderedMembers(): T[] {
        const out: { m: T; k: number }[] = [];
        for (let s = 0; s < this._mesh.length; s++) { const m = this._mesh[s]; if (m !== null) out.push({ m, k: this._key[s] }); }
        out.sort((a, b) => a.k - b.k);
        return out.map(e => e.m);
    }

    /** Full rebuild over `all` (the scene's mesh list, in walk order). `cellSize` forces a cell size (tests); default
     *  = the mean footprint, as SpatialGridXZ.build. */
    rebuild(all: readonly T[], cellSize?: number): SnapshotDelta<T> {
        const t0 = now();
        this._mesh = []; this._free.length = 0; this._slotOf.clear(); this.members.clear();
        this._cells.clear(); this._oversized.length = 0; this._footSum = 0; this._footBad = 0;
        const gen = ++this._gen;
        const tmp = this._tmp;
        let n = 0;
        for (let i = 0; i < all.length; i++) {
            const m = all[i];
            if (this._slotOf.has(m) || !this.deps.include(m)) continue;   // a mesh reached twice counts once
            const s = this._alloc();
            this._mesh[s] = m; this._slotOf.set(m, s); this.members.add(m);
            this._key[s] = n++; this._seen[s] = gen;
            this.deps.bounds(m, tmp);
            this._setBounds(s, tmp);
            this._stamp1(s, m);
        }
        this._epoch = this.deps.epoch ? this.deps.epoch() : NaN;
        this.cellSize = cellSize! > 0 ? cellSize! : this._autoCell();
        for (let s = 0; s < this._mesh.length; s++) this._insert(s);   // slots were allocated in key order
        const st = this.stats; st.syncs++; st.rebuilds++; st.lastRebuilt = true; st.lastMs = now() - t0;
        return { rebuilt: true, added: [], removed: [], moved: [], touched: [], oversized: true };
    }

    /** Bring the snapshot up to `all` (the scene's current mesh list, in walk order): insert attached meshes, take out
     *  detached ones, re-cell moved ones. Same result as rebuild(all, this.cellSize). */
    sync(all: readonly T[]): SnapshotDelta<T> {
        if (!this._mesh.length && !this.members.size) return this.rebuild(all);
        const t0 = now();
        const gen = ++this._gen;
        const tmp = this._tmp;
        const added: number[] = [], moved: number[] = [];
        const dv = this.deps.version, ds = this.deps.source, dg = this.deps.geomVersion, ep = this.deps.epoch ? this.deps.epoch() : NaN;
        const trust = !!(dv && ds) && ep === this._epoch;   // stamps valid since the last sync
        this._epoch = ep;
        let pos = 0, lastOld = -Infinity;
        for (let i = 0; i < all.length; i++) {
            const m = all[i];
            const s = this._slotOf.get(m);
            if (s !== undefined && this._seen[s] === gen) continue;   // reached twice
            if (!this.deps.include(m)) continue;
            if (s === undefined) {
                const ns = this._alloc();
                this._mesh[ns] = m; this._slotOf.set(m, ns); this.members.add(m);
                this._key[ns] = pos++; this._seen[ns] = gen; this._over[ns] = 0;
                this._stamp1(ns, m);
                this.deps.bounds(m, tmp);
                this._b[ns * 4] = tmp[0]; this._b[ns * 4 + 1] = tmp[1]; this._b[ns * 4 + 2] = tmp[2]; this._b[ns * 4 + 3] = tmp[3];
                added.push(ns);
                continue;
            }
            const k = this._key[s];
            if (k <= lastOld) return this.rebuild(all);   // survivors reordered → the cell lists' order is gone
            lastOld = k;
            this._key[s] = pos++; this._seen[s] = gen;
            if (trust && this._ver[s] === dv!(m) && this._src[s] === ds!(m) && (!dg || this._gv[s] === dg(m))) continue;   // unchanged since its last read
            this._stamp1(s, m);
            this.deps.bounds(m, tmp);
            const o = s * 4, B = this._b;
            if (!sameNum(B[o], tmp[0]) || !sameNum(B[o + 1], tmp[1]) || !sameNum(B[o + 2], tmp[2]) || !sameNum(B[o + 3], tmp[3])) moved.push(s, tmp[0], tmp[1], tmp[2], tmp[3]);
        }
        const removed: T[] = [], touched: number[] = [];
        let over = false;
        // Detached (not reached this sync): out of their cells, slot freed. Moved: out of the old cells.
        for (let s = 0; s < this._mesh.length; s++) {
            const m = this._mesh[s];
            if (m === null || this._seen[s] === gen) continue;
            over = this._touch(s, touched) || over;
            this._remove(s);
            this._unsetBounds(s);
            this._mesh[s] = null; this._src[s] = undefined; this._slotOf.delete(m); this.members.delete(m); this._free.push(s);
            removed.push(m);
        }
        const movedT: T[] = [];
        for (let i = 0; i < moved.length; i += 5) {
            const s = moved[i];
            over = this._touch(s, touched) || over;
            this._remove(s);
            this._unsetBounds(s);
            tmp[0] = moved[i + 1]; tmp[1] = moved[i + 2]; tmp[2] = moved[i + 3]; tmp[3] = moved[i + 4];
            this._setBounds(s, tmp);
            this._insert(s);
            over = this._touch(s, touched) || over;
            movedT.push(this._mesh[s]!);
        }
        const addedT: T[] = [];
        for (const s of added) {
            tmp[0] = this._b[s * 4]; tmp[1] = this._b[s * 4 + 1]; tmp[2] = this._b[s * 4 + 2]; tmp[3] = this._b[s * 4 + 3];
            this._setBounds(s, tmp);
            this._insert(s);
            over = this._touch(s, touched) || over;
            addedT.push(this._mesh[s]!);
        }
        // The cell size follows the mean footprint like a full rebuild's, within CELL_DRIFT.
        if (this.members.size) {
            const want = this._autoCell(), d = CollisionSnapshot.CELL_DRIFT;
            if (!(want <= this.cellSize * d && want * d >= this.cellSize)) return this.rebuild(all);
        }
        const st = this.stats;
        st.syncs++; st.added += addedT.length; st.removed += removed.length; st.moved += movedT.length; st.lastRebuilt = false; st.lastMs = now() - t0;
        return { rebuilt: false, added: addedT, removed, moved: movedT, touched, oversized: over };
    }

    /** Fill `out` with the members whose cells overlap the region (+ all oversized), in full-rebuild order. */
    query(b: XZBounds, out: T[]): T[] { return this._query(b.minX, b.minZ, b.maxX, b.maxZ, out); }
    queryPoint(x: number, z: number, out: T[]): T[] { return this._query(x, z, x, z, out); }

    /** Did a delta touch the XZ region's cells (or an oversized member)? A cached region list over it is stale. */
    touches(d: SnapshotDelta<T>, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
        if (d.rebuilt || d.oversized) return true;
        const cs = this.cellSize;
        const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs), z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
        const t = d.touched;
        for (let i = 0; i < t.length; i += 4) if (t[i] <= x1 && t[i + 2] >= x0 && t[i + 1] <= z1 && t[i + 3] >= z0) return true;
        return false;
    }

    // ── internals ──
    private _query(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): T[] {
        out.length = 0;
        const nSlots = this._mesh.length;
        if (this._stamp.length < nSlots) this._stamp = new Int32Array(Math.max(nSlots, this._stamp.length * 2));
        const gen = ++this._qgen, stamp = this._stamp, mesh = this._mesh;
        for (const s of this._oversized) { if (stamp[s] !== gen) { stamp[s] = gen; out.push(mesh[s]!); } }
        const cs = this.cellSize;
        const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
        const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const arr = this._cells.get(cx + ',' + cz);
                if (arr) for (const s of arr) { if (stamp[s] !== gen) { stamp[s] = gen; out.push(mesh[s]!); } }
            }
        }
        return out;
    }

    private _stamp1(s: number, m: T): void {
        if (this.deps.version) this._ver[s] = this.deps.version(m);
        if (this.deps.geomVersion) this._gv[s] = this.deps.geomVersion(m);
        if (this.deps.source) this._src[s] = this.deps.source(m);
    }

    private _alloc(): number {
        const s = this._free.length ? this._free.pop()! : this._mesh.length;
        if (s === this._mesh.length) this._mesh.push(null);
        if (s >= this._key.length) {
            const n = Math.max(64, this._key.length * 2);
            const k = new Float64Array(n); k.set(this._key); this._key = k;
            const g = new Int32Array(n); g.set(this._seen); this._seen = g;
            const b = new Float64Array(n * 4); b.set(this._b); this._b = b;
            const o = new Uint8Array(n); o.set(this._over); this._over = o;
            const v = new Float64Array(n); v.set(this._ver); this._ver = v;
            const gv = new Float64Array(n); gv.set(this._gv); this._gv = gv;
        }
        return s;
    }

    private _setBounds(s: number, b: Float64Array): void {
        const o = s * 4;
        this._b[o] = b[0]; this._b[o + 1] = b[1]; this._b[o + 2] = b[2]; this._b[o + 3] = b[3];
        const f = ((b[2] - b[0]) + (b[3] - b[1])) * 0.5;
        if (Number.isFinite(f)) this._footSum += f; else this._footBad++;
    }
    private _unsetBounds(s: number): void {
        const o = s * 4, B = this._b;
        const f = ((B[o + 2] - B[o]) + (B[o + 3] - B[o + 1])) * 0.5;
        if (Number.isFinite(f)) this._footSum -= f; else this._footBad--;
    }
    /** The cell size SpatialGridXZ.build picks for the members: max(mean footprint, 1e-3), 1 when that is not > 1e-6
     *  (with a non-finite footprint the mean is NaN / infinite: re-summed over the members in order, as build does). */
    private _autoCell(): number {
        const n = this.members.size;
        if (!n) return 1;
        let sum = this._footSum;
        if (this._footBad) {
            sum = 0;
            for (const m of this.orderedMembers()) {
                const o = this._slotOf.get(m)! * 4, B = this._b;
                sum += ((B[o + 2] - B[o]) + (B[o + 3] - B[o + 1])) * 0.5;
            }
        }
        const cs = Math.max(sum / n, 1e-3);
        return cs > 1e-6 ? cs : 1;
    }

    /** Cell range of slot `s` (SpatialGridXZ.insert's arithmetic). */
    private _range(s: number): [number, number, number, number] {
        const o = s * 4, B = this._b, cs = this.cellSize;
        return [Math.floor(B[o] / cs), Math.floor(B[o + 1] / cs), Math.floor(B[o + 2] / cs), Math.floor(B[o + 3] / cs)];
    }

    private _insert(s: number): void {
        const [x0, z0, x1, z1] = this._range(s);
        const span = (x1 - x0 + 1) * (z1 - z0 + 1);
        if (span > this._cap) { this._over[s] = 1; sortedInsert(this._oversized, s, this._key); return; }
        this._over[s] = 0;
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = cx + ',' + cz;
                const arr = this._cells.get(k);
                if (arr) sortedInsert(arr, s, this._key); else this._cells.set(k, [s]);
            }
        }
    }

    private _remove(s: number): void {
        if (this._over[s]) { const i = this._oversized.indexOf(s); if (i >= 0) this._oversized.splice(i, 1); return; }
        const [x0, z0, x1, z1] = this._range(s);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = cx + ',' + cz;
                const arr = this._cells.get(k);
                if (!arr) continue;
                const i = arr.indexOf(s);
                if (i >= 0) arr.splice(i, 1);
                if (!arr.length) this._cells.delete(k);
            }
        }
    }

    /** Record slot `s`'s current cell range in `touched`; true when it is oversized. */
    private _touch(s: number, touched: number[]): boolean {
        if (this._over[s]) return true;
        const [x0, z0, x1, z1] = this._range(s);
        touched.push(x0, z0, x1, z1);
        return false;
    }
}

function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
/** Equal as footprints (NaN equals NaN: a mesh without bounds stays where it is). */
function sameNum(a: number, b: number): boolean { return a === b || (a !== a && b !== b); }
/** Insert slot `s` into `arr` (sorted by key) at its key position. */
function sortedInsert(arr: number[], s: number, key: Float64Array): void {
    const k = key[s];
    let lo = 0, hi = arr.length;
    if (hi && key[arr[hi - 1]] < k) { arr.push(s); return; }
    while (lo < hi) { const mid = (lo + hi) >> 1; if (key[arr[mid]] < k) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, s);
}
