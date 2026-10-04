/**
 * collision-cells.test.ts — engine-roadmap step 3: a ray answered through a collision cell (merged flat BVH + the
 * per-mesh path for what the cell does not cover) must return EXACTLY what the per-mesh path (MeshPicker.raycastWorld)
 * returns over the same candidate list: same distance, same normal, for ground / wall / camera-like rays, with
 * coplanar duplicates, near-coplanar layers, movers, non-identity meshes, hidden and late-arriving meshes.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { vec3 } from 'gl-matrix';
import { MeshPicker } from '../renderer/3d/mesh-picker';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import type { InteractionService } from '../services/interaction-service';
import { CollisionCellManager, buildFlatBVH, cellRaycast, newCellRayScratch, triRunBoxes, type CellRayPicker, type CellSoup } from './collision-cells';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Triangles in WORLD coordinates around (cx, cz): a mix of floor tiles, walls and clutter. */
function worldGeom(r: () => number, n: number, cx: number, cz: number, spread: number) {
    const v = new Float32Array(n * 3 * 12), ix = new Uint32Array(n * 3);
    for (let t = 0; t < n; t++) {
        const kind = r();
        const x = cx + (r() - 0.5) * spread, z = cz + (r() - 0.5) * spread, y = kind < 0.4 ? 0 : r() * 3;
        const s = 0.2 + r() * 1.5;
        let P: number[][];
        if (kind < 0.4) P = [[x, y, z], [x + s, y, z], [x, y, z + s]];                       // floor (y = 0: coplanar with others)
        else if (kind < 0.7) P = [[x, y, z], [x + s, y, z], [x, y + s, z]];                  // wall facing z
        else P = [[x, y, z], [x + (r() - 0.5) * s, y + r() * s, z + (r() - 0.5) * s], [x + (r() - 0.5) * s, y + r() * s, z + (r() - 0.5) * s]];
        for (let k = 0; k < 3; k++) { const o = (t * 3 + k) * 12; v[o] = P[k][0]; v[o + 1] = P[k][1]; v[o + 2] = P[k][2]; ix[t * 3 + k] = t * 3 + k; }
    }
    return { vertices: v, indices: ix, format: '12float' as const };
}
function meshOf(geom: ReturnType<typeof worldGeom>, x = 0, y = 0, z = 0): Mesh3D {
    const m = new Mesh3D(isvc, x, y, z, { primitive: 'custom', geometry: geom });
    m.pickable = false; m.gpuDirty = false;
    return m;
}

function sceneOf(seed: number): Mesh3D[] {
    const r = rng(seed), out: Mesh3D[] = [];
    // tile-wide layers (identity, world-baked) + local clutter + a ground slab
    out.push(meshOf(worldGeom(r, 3000, 0, 0, 40)));
    for (let i = 0; i < 40; i++) out.push(meshOf(worldGeom(r, 20 + Math.floor(r() * 200), (r() - 0.5) * 36, (r() - 0.5) * 36, 4 + r() * 8)));
    // a coplanar duplicate of one layer (equal distances: the earlier list entry must win) + a layer 1e-5 below it
    const dup = out[3].geometry;
    const flip = dup.indices.slice(); for (let i = 0; i < flip.length; i += 3) { const t = flip[i + 1]; flip[i + 1] = flip[i + 2]; flip[i + 2] = t; }   // same triangles, opposite normals
    out.splice(9, 0, meshOf({ vertices: dup.vertices.slice(), indices: flip, format: '12float' }));
    const up = dup.vertices.slice(); for (let i = 1; i < up.length; i += 12) up[i] -= 1e-5;
    out.splice(15, 0, meshOf({ vertices: up, indices: dup.indices.slice(), format: '12float' }));
    // non-identity meshes (residual: the per-mesh path) + a mover
    for (let i = 0; i < 8; i++) { const m = meshOf(worldGeom(r, 40, 0, 0, 3), (r() - 0.5) * 30, 0, (r() - 0.5) * 30); if (i % 2) m.setRotation3D(0, r() * 3, 0); m.gpuDirty = false; out.push(m); }
    const mover = meshOf(worldGeom(r, 30, 0, 0, 2), 1, 0, 1); mover.cheapBounds = true; mover.gpuDirty = false; out.push(mover);
    return out;
}

const isIdentity = (m: Mesh3D): boolean => { const a = m.localMatrix as unknown as Float32Array; for (let i = 0; i < 16; i++) if (a[i] !== (i % 5 === 0 ? 1 : 0)) return false; return true; };
const staticGeometry = (m: Mesh3D) => (m.gpuDirty || m.cheapBounds || !isIdentity(m) || !m.geometry?.indices?.length) ? null
    : { vertices: m.geometry.vertices, indices: m.geometry.indices, key: m.geometry as object, ver: m.localMatrixVersion };
const xz = (m: Mesh3D): [number, number, number, number] => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of m.obbCorners ?? []) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); b = Math.min(b, p[2]); d = Math.max(d, p[2]); } return [a, b, c, d]; };

async function readyManager(meshes: Mesh3D[], core: number, margin: number, px: number, pz: number, sliced = false) {
    let clock = 0;
    const mgr = new CollisionCellManager<Mesh3D>({
        region: () => meshes, staticGeometry, xzBox: xz,
        same: (m, key, ver) => m.geometry === key && m.localMatrixVersion === ver && !m.gpuDirty,
        build: (soup: CellSoup) => Promise.resolve(buildFlatBVH(soup)), now: () => (sliced ? clock++ : 0),
    }, { core, margin, gatherMs: sliced ? 3 : Infinity });
    for (let i = 0; i < (sliced ? 4000 : 4); i++) { mgr.update(px, pz); await Promise.resolve(); await Promise.resolve(); if (sliced && mgr.stats.ready === 9) break; }
    return mgr;
}

function compare(mgr: CollisionCellManager<Mesh3D>, pk: MeshPicker, list: Mesh3D[], rays: Array<[[number, number, number], [number, number, number], number]>, live = (m: Mesh3D) => m.visible) {
    const sc = newCellRayScratch(), counters = { cell: 0, residual: 0, fallback: 0 };
    let served = 0, diffs = 0, hits = 0;
    for (const [o, d, md] of rays) {
        const h = pk.raycastWorld(o as unknown as vec3, d as unknown as vec3, list, true, md);
        const want = h && h.distance <= md ? { distance: h.distance, normal: h.faceNormal } : null;
        const cell = mgr.cellForRay(o, d, md);
        if (!cell) continue;
        served++;
        const got = cellRaycast(cell.cur!, o, d, md, list, pk as unknown as CellRayPicker<Mesh3D>, false, live, (m) => staticGeometry(m) !== null, () => mgr.markStale(cell), sc, counters);
        if (want) hits++;
        const same = (!want && !got) || (!!want && !!got && want.distance === got.distance && want.normal[0] === got.normal[0] && want.normal[1] === got.normal[1] && want.normal[2] === got.normal[2]);
        if (!same) diffs++;
    }
    return { served, diffs, hits, cellRays: counters.cell, residualPerRay: counters.residual / Math.max(1, counters.cell) };
}

function rays(seed: number, n: number, cx: number, cz: number, half: number, reach: number) {
    const r = rng(seed), out: Array<[[number, number, number], [number, number, number], number]> = [];
    for (let i = 0; i < n; i++) {
        const o: [number, number, number] = [cx + (r() - 0.5) * 2 * half, 0.05 + r() * 3, cz + (r() - 0.5) * 2 * half];
        const kind = i % 4;
        if (kind === 0) out.push([[o[0], 6, o[2]], [0, -1, 0], Infinity]);                        // ground search (unbounded, vertical)
        else if (kind === 1) out.push([[o[0], o[1] + 0.3, o[2]], [0, 1, 0], 0.4 + r()]);           // headroom
        else if (kind === 2) { const a = r() * 6.283; out.push([o, [Math.cos(a), 0, Math.sin(a)], 0.05 + r() * 0.5]); }   // wall ray
        else { const a = r() * 6.283, p = -r() * 0.8; out.push([o, [Math.cos(a) * Math.cos(p), Math.sin(p), Math.sin(a) * Math.cos(p)], r() * reach]); }   // camera ray
    }
    // grid-aligned origins (shared edges / exact vertex hits)
    for (let i = 0; i < 40; i++) out.push([[Math.round(cx) + (i % 5) * 0.5, 6, Math.round(cz) + Math.floor(i / 5) * 0.5], [0, -1, 0], Infinity]);
    return out;
}

describe('collision cells (step 3)', () => {
    it('run boxes bound every run', () => {
        const g = worldGeom(rng(1), 700, 0, 0, 30);
        const rb = triRunBoxes(g.vertices, g.indices, 256);
        expect(rb.length).toBe(Math.ceil(700 / 256) * 6);
        for (let t = 0; t < 700; t++) {
            const r = Math.floor(t / 256) * 6;
            for (let k = 0; k < 3; k++) { const o = g.indices[t * 3 + k] * 12; expect(g.vertices[o]).toBeGreaterThanOrEqual(rb[r]); expect(g.vertices[o]).toBeLessThanOrEqual(rb[r + 3]); }
        }
    });

    it('the flat BVH keeps every triangle once', () => {
        const g = worldGeom(rng(2), 500, 0, 0, 20);
        const soup: CellSoup = { tris: new Float32Array(500 * 9), ids: new Uint32Array(1000) };
        for (let t = 0; t < 500; t++) { for (let k = 0; k < 3; k++) { const o = g.indices[t * 3 + k] * 12; soup.tris.set([g.vertices[o], g.vertices[o + 1], g.vertices[o + 2]], t * 9 + k * 3); } soup.ids[t * 2] = 0; soup.ids[t * 2 + 1] = t; }
        const b = buildFlatBVH(soup);
        expect(b.tris.length).toBe(500 * 9);
        expect([...new Set(Array.from({ length: 500 }, (_, i) => b.ids[i * 2 + 1]))].length).toBe(500);
    });

    it('cell answers equal the per-mesh path over thousands of rays (several seeds)', async () => {
        let total = 0, totalHits = 0;
        for (const seed of [11, 12, 13]) {
            const meshes = sceneOf(seed);
            const pk = new MeshPicker();
            const mgr = await readyManager(meshes, 12, 6, 0, 0);
            const res = compare(mgr, pk, meshes, rays(seed * 7, 1500, 0, 0, 18, 5));
            expect(res.diffs).toBe(0);
            expect(mgr.stats.soupTrisMax).toBeGreaterThan(2000);   // the cells really hold the static triangles
            expect(res.cellRays).toBe(res.served);
            expect(res.residualPerRay).toBeLessThan(12);            // only the movers / non-identity meshes go per-mesh
            total += res.served; totalHits += res.hits;
        }
        expect(total).toBeGreaterThan(1500);
        expect(totalHits).toBeGreaterThan(500);
    });

    it('hidden members, late static meshes, moved members and edits keep the answers equal', async () => {
        const meshes = sceneOf(21);
        const pk = new MeshPicker();
        const mgr = await readyManager(meshes, 12, 6, 0, 0);
        // hide a few covered meshes (per ray: the per-mesh path skips them)
        for (let i = 2; i < 12; i += 3) meshes[i].visible = false;
        // a static mesh that arrived after the gather → residual through the per-mesh path, and the cell goes stale
        const late = meshOf(worldGeom(rng(5), 300, 0, 0, 12)); meshes.splice(4, 0, late);
        let res = compare(mgr, pk, meshes, rays(99, 1200, 0, 0, 10, 5));
        expect(res.diffs).toBe(0);
        expect(res.served).toBeGreaterThan(500);
        expect(mgr.stats.stale).toBeGreaterThan(0);
        // a covered member moves: the next update stops the cell answering until it is gathered again
        meshes[1].setPosition3D(0.5, 0, 0); meshes[1].gpuDirty = false;
        mgr.update(0, 0);
        expect(mgr.cellForRay([1, 1, 1], [0, -1, 0], Infinity)).toBeNull();   // validated on its first ray of the tick
        expect(mgr.stats.invalidated).toBeGreaterThan(0);
        for (let i = 0; i < 4; i++) { mgr.update(0, 0); await Promise.resolve(); await Promise.resolve(); }
        res = compare(mgr, pk, meshes, rays(100, 800, 0, 0, 10, 5));
        expect(res.diffs).toBe(0);
    });

    it('a gather sliced into many tiny budgets gives the same cells', async () => {
        const meshes = sceneOf(41);
        const pk = new MeshPicker();
        const mgr = await readyManager(meshes, 12, 6, 0, 0, true);
        expect(mgr.stats.ready).toBe(9);
        const res = compare(mgr, pk, meshes, rays(41, 1000, 0, 0, 18, 5));
        expect(res.diffs).toBe(0);
        expect(res.served).toBeGreaterThan(500);
    });

    it('rays leaving the window, unbounded slanted rays and unready cells are not served', async () => {
        const meshes = sceneOf(31);
        const mgr = await readyManager(meshes, 12, 6, 0, 0);
        expect(mgr.cellForRay([1, 1, 1], [1, 0, 0], 30)).toBeNull();          // leaves the window
        expect(mgr.cellForRay([1, 1, 1], [1, -1, 0], Infinity)).toBeNull();  // unbounded, not vertical
        expect(mgr.cellForRay([500, 1, 1], [0, -1, 0], Infinity)).toBeNull(); // no cell there
        expect(mgr.cellForRay([1, 1, 1], [0, -1, 0], Infinity)).not.toBeNull();
    });
});
