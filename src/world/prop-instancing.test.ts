// performance-plan §P20 — lighter tiles: instanced props. Structural checks only (no wall-clock assertions).
import { describe, it, expect } from 'vitest';
import { buildTileLayerGroups, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { Accum3D, setPartRecording, partOf, PART_STRIDE } from './meshbuild';
import { TwinAccum3D, loSpecFor } from './lod-accum';
import { newPropInstancingStats, tileGeometryBytes, PROP_INSTANCING_DEFAULTS, PROP_XF_STRIDE, propXfAt } from './prop-instancing';
import type { LayoutParams, LayoutPreviewLayer } from './types';

const P: LayoutParams = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;
const OPTS = { contact: { opacity: 0.55 } };
const F = 12;

/** Every triangle of a layer as world positions + normals (instanced layers expanded through their copies). */
function triangles(L: LayoutPreviewLayer): Float64Array[] {
    const v = L.geometry.vertices, ix = L.geometry.indices, out: Float64Array[] = [];
    const xfs: (ReturnType<typeof propXfAt> | null)[] = L.propXf ? Array.from({ length: L.propXf.length / PROP_XF_STRIDE }, (_, i) => propXfAt(L.propXf!, i)) : [null];
    for (const t of xfs) {
        for (let k = 0; k < ix.length; k += 3) {
            const tri = new Float64Array(18);
            for (let c = 0; c < 3; c++) {
                const a = ix[k + c] * F;
                let px = v[a], py = v[a + 1], pz = v[a + 2], nx = v[a + 3], ny = v[a + 4], nz = v[a + 5];
                if (t) {
                    const m = t.m, q = t.nm;
                    const X = px, Y = py, Z = pz;
                    px = m[0] * X + m[3] * Y + m[6] * Z + t.t[0]; py = m[1] * X + m[4] * Y + m[7] * Z + t.t[1]; pz = m[2] * X + m[5] * Y + m[8] * Z + t.t[2];
                    const a2 = q[0] * nx + q[3] * ny + q[6] * nz, b2 = q[1] * nx + q[4] * ny + q[7] * nz, c2 = q[2] * nx + q[5] * ny + q[8] * nz, l = Math.hypot(a2, b2, c2) || 1;
                    nx = a2 / l; ny = b2 / l; nz = c2 / l;
                }
                tri.set([px, py, pz, nx, ny, nz], c * 6);
            }
            out.push(tri);
        }
    }
    return out;
}

describe('P20 Accum3D part recording', () => {
    it('is off outside a tile build and never changes the emitted geometry', () => {
        const build = (rec: boolean): ReturnType<Accum3D['geometry']> => {
            const was = setPartRecording(rec);
            try {
                const a = new TwinAccum3D(loSpecFor(45, 1 / 15));
                for (let i = 0; i < 5; i++) partOf([a], [i * 3.1, 0.2, -i * 1.7], [Math.cos(i), Math.sin(i)], () => { a.prism([i * 3.1, 0.2, -i * 1.7], 0.1, 0.1, 1, 8); a.obox([i * 3.1, 1.2, -i * 1.7], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.2, 0.1, 0.3); });
                return a.geometry();
            } finally { setPartRecording(was); }
        };
        const off = build(false), on = build(true);
        expect(Array.from(on.vertices)).toEqual(Array.from(off.vertices));
        expect(Array.from(on.indices)).toEqual(Array.from(off.indices));
        expect((off as { parts?: unknown }).parts).toBeUndefined();
        const parts = (on as { parts?: Float64Array }).parts!;
        expect(parts.length).toBe(5 * PART_STRIDE);
        for (let k = 0; k < parts.length; k += PART_STRIDE) { expect(parts[k + 1]).toBeGreaterThan(parts[k]); expect(parts[k + 3]).toBeGreaterThan(parts[k + 2]); }
    });
});

describe('P20 instanced props in a full tile', () => {
    const off = buildTileLayerGroups(P, 1, 0, true, { ...OPTS, propInstancing: false });
    const stats = newPropInstancingStats();
    const on = buildTileLayerGroups(P, 1, 0, true, { ...OPTS, propInstancing: true, propStats: stats });

    it('per-tile byte budget: the instanced tile is far lighter than the baked one', () => {
        const b0 = tileGeometryBytes(off), b1 = tileGeometryBytes(on);
        expect(b0).toBeGreaterThan(100 * 1048576);   // the baked full tile (~140 MB)
        expect(b1).toBeLessThan(b0 - 30 * 1048576);  // ≥ 30 MB lighter
        expect(b1).toBeLessThan(115 * 1048576);      // the P20 budget for this tile (see performance-plan §P20)
        expect(stats.instances).toBeGreaterThan(2000);
        expect(stats.variants).toBeLessThan(400);
    }, 120_000);

    it('instanced copies reproduce the baked positions + normals, triangle for triangle', () => {
        const tol = PROP_INSTANCING_DEFAULTS.tolPos * 1.01, tolN = PROP_INSTANCING_DEFAULTS.tolNrm * 1.01;
        const byName = (gs: TileLayerGroup[]) => {
            const m = new Map<string, LayoutPreviewLayer[]>();
            for (const g of gs) for (const L of g.layers) { const k = g.name + '|' + L.name + '|' + (L.nearTwin?.role ?? ''); (m.get(k) ?? m.set(k, []).get(k)!).push(L); }
            return m;
        };
        const A = byName(off), B = byName(on);
        let checked = 0;
        for (const [k, ls] of B) {
            if (!ls.some(L => L.propInst)) continue;
            const base = A.get(k);
            expect(base, k).toBeDefined();
            const want = base!.flatMap(triangles), got = ls.flatMap(triangles);
            expect(got.length, k).toBe(want.length);
            // match every instanced / leftover triangle to a baked one (hash on the rounded first-vertex position)
            const cell = 1e-3, key = (x: number, y: number, z: number) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
            const grid = new Map<string, Float64Array[]>();
            for (const t of want) { const kk = key(t[0], t[1], t[2]); (grid.get(kk) ?? grid.set(kk, []).get(kk)!).push(t); }
            const used = new Set<Float64Array>();
            for (const t of got) {
                let hit: Float64Array | null = null;
                const cx = Math.round(t[0] / cell), cy = Math.round(t[1] / cell), cz = Math.round(t[2] / cell);
                search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                    for (const w of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
                        if (used.has(w)) continue;
                        let ok = true;
                        for (let c = 0; c < 3 && ok; c++) for (let j = 0; j < 3; j++) if (Math.abs(w[c * 6 + j] - t[c * 6 + j]) > tol || Math.abs(w[c * 6 + 3 + j] - t[c * 6 + 3 + j]) > tolN) { ok = false; break; }
                        if (ok) { hit = w; break search; }
                    }
                }
                expect(hit, `${k}: an instanced triangle has no baked twin`).not.toBeNull();
                used.add(hit!);
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(50000);
    }, 240_000);

    it('copies keep the layer look and become phantom-source array layers; no part bookkeeping survives', () => {
        let inst = 0;
        for (const g of on) for (const L of g.layers) {
            expect((L.geometry as { parts?: unknown }).parts).toBeUndefined();
            expect((L.geometry as { partLocal?: unknown }).partLocal).toBeUndefined();
            if (!L.propInst) continue;
            inst++;
            expect(L.arrayGroup).toBe(true);
            expect(L.instanceKey?.startsWith('p20:')).toBe(true);
            expect(L.instances).toBeUndefined();   // no per-copy objects: one typed array
            expect(L.propXf!.length % PROP_XF_STRIDE).toBe(0);
            expect(L.propXf!.length).toBeGreaterThanOrEqual(PROP_XF_STRIDE * PROP_INSTANCING_DEFAULTS.minCopies);
        }
        expect(inst).toBeGreaterThan(20);
        for (const g of off) for (const L of g.layers) { expect(L.propInst).toBeFalsy(); expect((L.geometry as { parts?: unknown }).parts).toBeUndefined(); }
    });

    it('variants are content-keyed: two tiles share the canonical bytes of the same prop', () => {
        const other = buildTileLayerGroups(P, -1, 1, true, { ...OPTS, propInstancing: true });
        const keysOf = (gs: TileLayerGroup[]) => new Map(gs.flatMap(g => g.layers).filter(L => L.propInst).map(L => [L.instanceKey!, L.geometry] as const));
        const a = keysOf(on), b = keysOf(other);
        let shared = 0;
        for (const [k, g] of a) {
            const h = b.get(k); if (!h) continue;
            shared++;
            expect(Array.from(h.vertices)).toEqual(Array.from(g.vertices));
            expect(Array.from(h.indices)).toEqual(Array.from(g.indices));
        }
        expect(shared).toBeGreaterThan(10);
    }, 120_000);

    it('is deterministic', () => {
        const again = buildTileLayerGroups(P, 1, 0, true, { ...OPTS, propInstancing: true });
        const sig = (gs: TileLayerGroup[]) => gs.flatMap(g => g.layers.map(L => `${g.name}|${L.name}|${L.instanceKey ?? ''}|${L.instances?.length ?? 0}|${L.propXf ? Array.from(L.propXf).join() : ''}|${L.geometry.vertices.length}`)).join('\n');
        expect(sig(again)).toBe(sig(on));
    }, 120_000);
});
