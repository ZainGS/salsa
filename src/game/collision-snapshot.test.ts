import { describe, it, expect } from 'vitest';
import { CollisionSnapshot } from './collision-snapshot';
import { SpatialGridXZ, type XZBounds } from './spatial-grid';

/** A fake mesh: an XZ box (may be NaN / huge), an include flag. */
type M = { id: number; b: [number, number, number, number]; inc: boolean; v?: number };

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// `v`: the change stamp (a move bumps it, like a matrix version); the snapshot skips re-reading an unstamped survivor
const deps = {
    include: (m: M) => m.inc,
    bounds: (m: M, out: Float64Array) => { out[0] = m.b[0]; out[1] = m.b[1]; out[2] = m.b[2]; out[3] = m.b[3]; },
    version: (m: M) => m.v ?? 0, source: () => null, epoch: () => 0,
};

function randomBox(r: () => number, nan = true): [number, number, number, number] {
    const k = r();
    if (k < 0.01) return nan ? [NaN, NaN, NaN, NaN] : [0, 0, 1, 1];                               // no bounds yet
    if (k < 0.03) return [-500 + r() * 10, -500 + r() * 10, 400 + r() * 100, 400 + r() * 100];   // oversized (ground)
    const x = (r() - 0.5) * 200, z = (r() - 0.5) * 200;
    const w = k < 0.2 ? r() * 30 : r() * 4, d = k < 0.2 ? r() * 30 : r() * 4;
    return [x, z, x + w, z + d];
}

/** The old code: SpatialGridXZ over the included meshes in scene order (index = position), cell size forced. */
function legacy(all: M[], cellSize: number): { grid: SpatialGridXZ; list: M[] } {
    const list = all.filter(m => m.inc);
    const grid = new SpatialGridXZ(cellSize);
    list.forEach((m, i) => grid.insert(i, { minX: m.b[0], minZ: m.b[1], maxX: m.b[2], maxZ: m.b[3] }));
    return { grid, list };
}

function expectSameQueries(snap: CollisionSnapshot<M>, all: M[], r: () => number, n = 60): void {
    const { grid, list } = legacy(all, snap.cellSize);
    const idx: number[] = [], out: M[] = [];
    for (let i = 0; i < n; i++) {
        const x = (r() - 0.5) * 240, z = (r() - 0.5) * 240, w = r() < 0.3 ? 0 : r() * 25, d = r() < 0.3 ? 0 : r() * 25;
        const q: XZBounds = { minX: x, minZ: z, maxX: x + w, maxZ: z + d };
        grid.query(q, idx);
        snap.query(q, out);
        expect(out.map(m => m.id)).toEqual(idx.map(j => list[j].id));
        grid.queryPoint(x, z, idx);
        snap.queryPoint(x, z, out);
        expect(out.map(m => m.id)).toEqual(idx.map(j => list[j].id));
    }
    expect(snap.size).toBe(list.length);
    expect([...snap.members].map(m => m.id).sort((a, b) => a - b)).toEqual(list.map(m => m.id).sort((a, b) => a - b));
    expect(snap.orderedMembers().map(m => m.id)).toEqual(list.map(m => m.id));
}

describe('CollisionSnapshot (step 3b)', () => {
    it('a rebuild answers every query exactly as SpatialGridXZ.build (auto cell size)', () => {
        const r = rng(7);
        const all: M[] = Array.from({ length: 800 }, (_, id) => ({ id, b: randomBox(r), inc: r() > 0.1 }));
        const snap = new CollisionSnapshot<M>(deps);
        snap.rebuild(all);
        const list = all.filter(m => m.inc);
        const auto = SpatialGridXZ.build(list.map(m => ({ minX: m.b[0], minZ: m.b[1], maxX: m.b[2], maxZ: m.b[3] })));
        expect(snap.cellSize).toBe(auto.cellSize);
        expectSameQueries(snap, all, r);
    });

    it('incremental syncs through adds, removes, moves and include flips = a full rebuild', () => {
        const r = rng(42);
        let next = 0;
        let all: M[] = Array.from({ length: 600 }, () => ({ id: next++, b: randomBox(r), inc: r() > 0.1 }));
        const snap = new CollisionSnapshot<M>(deps);
        snap.rebuild(all);
        let incremental = 0;
        for (let step = 0; step < 80; step++) {
            // a tile attaches: a block of meshes appended (or inserted mid-list: a crowd cell under an existing group)
            if (r() < 0.6) {
                const add = Array.from({ length: 1 + Math.floor(r() * 120) }, () => ({ id: next++, b: randomBox(r), inc: r() > 0.1 }));
                const at = r() < 0.5 ? all.length : Math.floor(r() * all.length);
                all = [...all.slice(0, at), ...add, ...all.slice(at)];
            }
            // a tile detaches: a contiguous run removed; plus a few scattered removals (crowd cells evicted)
            if (r() < 0.5 && all.length > 50) { const at = Math.floor(r() * (all.length - 40)); all.splice(at, Math.floor(r() * 40)); }
            for (let k = 0; k < 3; k++) if (all.length) all.splice(Math.floor(r() * all.length), 1);
            // moves (a mover / edited mesh) and include flips (the Player binding changed)
            for (let k = 0; k < 5; k++) if (all.length) { const m = all[Math.floor(r() * all.length)]; m.b = randomBox(r); m.v = (m.v ?? 0) + 1; }
            if (r() < 0.2 && all.length) { const m = all[Math.floor(r() * all.length)]; m.inc = !m.inc; }
            const d = snap.sync(all);
            if (!d.rebuilt) incremental++;
            expectSameQueries(snap, all, r, 25);
        }
        expect(incremental).toBeGreaterThan(40);   // the incremental path is the one exercised
        expect(snap.stats.added).toBeGreaterThan(0);
        expect(snap.stats.removed).toBeGreaterThan(0);
        expect(snap.stats.moved).toBeGreaterThan(0);
    });

    it('a sync reports what it touched; touches() says whether a cached region list is stale', () => {
        const all: M[] = [];
        for (let i = 0; i < 100; i++) all.push({ id: i, b: [i % 10 * 5, Math.floor(i / 10) * 5, i % 10 * 5 + 2, Math.floor(i / 10) * 5 + 2], inc: true });
        const snap = new CollisionSnapshot<M>(deps);
        snap.rebuild(all);
        const added: M = { id: 1000, b: [40, 40, 42, 42], inc: true };
        const d = snap.sync([...all, added]);
        expect(d.rebuilt).toBe(false);
        expect(d.added).toEqual([added]);
        expect(snap.touches(d, 39, 39, 44, 44)).toBe(true);
        expect(snap.touches(d, 0, 0, 3, 3)).toBe(false);
        const d2 = snap.sync(all);
        expect(d2.removed).toEqual([added]);
        expect(snap.touches(d2, 41, 41, 41, 41)).toBe(true);
    });

    it('falls back to a full rebuild on a reorder, a cell-size drift, and counts a mesh reached twice once', () => {
        const r = rng(3);
        const all: M[] = Array.from({ length: 200 }, (_, id) => ({ id, b: randomBox(r, false), inc: true }));
        const snap = new CollisionSnapshot<M>(deps);
        snap.rebuild(all);
        const swapped = [...all]; [swapped[10], swapped[150]] = [swapped[150], swapped[10]];
        expect(snap.sync(swapped).rebuilt).toBe(true);
        expectSameQueries(snap, swapped, r);
        // 10× bigger footprints → the mean is far from the cell size → rebuilt at the new mean
        const big: M[] = swapped.map(m => ({ id: m.id, b: [m.b[0] * 10, m.b[1] * 10, m.b[2] * 10 + 50, m.b[3] * 10 + 50] as [number, number, number, number], inc: true }));
        expect(snap.sync(big).rebuilt).toBe(true);
        expectSameQueries(snap, big, r);
        const dup = [...big, big[5], big[6]];
        const d = snap.sync(dup);
        expect(d.rebuilt).toBe(false);
        expect(snap.size).toBe(big.length);
        expectSameQueries(snap, big, r);
    });

    it('re-reads a survivor only when its stamp moved (or the epoch did); without stamps always', () => {
        const all: M[] = [{ id: 0, b: [0, 0, 1, 1], inc: true, v: 0 }, { id: 1, b: [5, 5, 6, 6], inc: true, v: 0 }];
        let epoch = 0;
        const reads: number[] = [];
        const d = { ...deps, epoch: () => epoch, bounds: (m: M, out: Float64Array) => { reads.push(m.id); deps.bounds(m, out); } };
        const snap = new CollisionSnapshot<M>(d);
        snap.rebuild(all);
        reads.length = 0;
        all[0].b = [20, 20, 21, 21];                 // moved, stamp not bumped: not read (the stamp is the contract)
        snap.sync(all);
        expect(reads).toEqual([]);
        all[0].v = 1;                                // stamp bumped → read, re-celled
        expect(snap.sync(all).moved).toEqual([all[0]]);
        expect(reads).toEqual([0]);
        reads.length = 0; epoch++;                   // a geometry epoch change → every survivor read
        snap.sync(all);
        expect(reads).toEqual([0, 1]);
        const plain = new CollisionSnapshot<M>({ include: deps.include, bounds: d.bounds });
        plain.rebuild(all); reads.length = 0;
        plain.sync(all);
        expect(reads).toEqual([0, 1]);
    });
});

describe('CollisionSnapshot P16 per-member geometry version', () => {
    it('new members do not make survivors re-read; a geometry change on one member does; answers = a rebuild', () => {
        const r = rng(21);
        type G = M & { gv: number };
        const all: G[] = Array.from({ length: 600 }, (_, id) => ({ id, b: randomBox(r, false), inc: true, gv: 0 }));
        let reads = 0, globalEpoch = 0;
        const mk = (perMesh: boolean) => new CollisionSnapshot<G>({
            include: (m) => m.inc,
            bounds: (m, out) => { reads++; out[0] = m.b[0]; out[1] = m.b[1]; out[2] = m.b[2]; out[3] = m.b[3]; },
            version: (m) => m.v ?? 0, source: () => null,
            geomVersion: (m) => m.gv,
            epoch: () => perMesh ? 0 : globalEpoch,   // the old rule: any new geometry anywhere bumps the epoch
        });
        for (const perMesh of [false, true]) {
            const snap = mk(perMesh);
            snap.rebuild(all);
            const cs = snap.cellSize;
            // a streamed tile lands: 100 new meshes (each one bumped the global epoch when it got geometry)
            const added: G[] = Array.from({ length: 100 }, (_, k) => ({ id: 1000 + k, b: randomBox(r, false), inc: true, gv: 1 }));
            globalEpoch += added.length;
            reads = 0;
            const cur = [...all, ...added];
            snap.sync(cur);
            if (perMesh) expect(reads).toBe(added.length);          // only the new members were read
            else expect(reads).toBe(cur.length);                    // every member re-read
            // one survivor's geometry is replaced in place (same object, new version): it alone is re-read
            const ed = all[17]; ed.b = [ed.b[0] + 5, ed.b[1], ed.b[2] + 5, ed.b[3]]; ed.gv++; globalEpoch++;
            reads = 0;
            const d = snap.sync(cur);
            if (perMesh) { expect(reads).toBe(1); expect(d.moved).toEqual([ed]); }
            const ref = new CollisionSnapshot<G>(deps as unknown as ConstructorParameters<typeof CollisionSnapshot<G>>[0]);
            ref.rebuild(cur, cs);
            const out1: G[] = [], out2: G[] = [];
            for (let i = 0; i < 80; i++) {
                const x = (r() - 0.5) * 240, z = (r() - 0.5) * 240, q = { minX: x, minZ: z, maxX: x + r() * 20, maxZ: z + r() * 20 };
                expect(snap.query(q, out1).map((m) => m.id)).toEqual(ref.query(q, out2).map((m) => m.id));
            }
            ed.b = [ed.b[0] - 5, ed.b[1], ed.b[2] - 5, ed.b[3]];
        }
    });
});
