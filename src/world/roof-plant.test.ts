// visual-polish #11 tail — the CLUSTERED roof plant (LayoutParams.roofEquipment / BuildingParams.roofPlant).
// Structural checks only (no wall-clock assertions).
import { describe, it, expect } from 'vitest';
import { buildBuilding, buildingArchetypeNames, resolveBuildingParams } from './building';
import { ROOF_TANK_COLORS } from './building-parts';
import { buildTileLayerGroups, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { tileGeometryBytes, PROP_INSTANCING_DEFAULTS, PROP_XF_STRIDE, propXfAt } from './prop-instancing';
import { hlodLayerBytes, HLOD_BYTES } from './tile-hlod';
import { DEFAULT_LAYOUT_PARAMS, type LayoutParams, type LayoutPreviewLayer } from './types';
import { CITY_SCENE_PRESETS } from './scene-presets';

const F = 12;
const tris = (ls: LayoutPreviewLayer[], re: RegExp): number => ls.filter(L => re.test(L.name)).reduce((s, L) => s + L.geometry.indices.length / 3, 0);
const sig = (ls: LayoutPreviewLayer[]): string => ls.map(L => `${L.name}|${L.color.join()}|${L.geometry.vertices.length}|${Array.from(L.geometry.vertices.slice(0, 24)).join()}`).join('\n');
const FLAT = buildingArchetypeNames().filter(a => { const p = resolveBuildingParams({ archetype: a }); return (p.roofStyle === 'flat' || p.roofStyle === 'parapet') && p.roofClutter; });

describe('clustered roof plant · one building', () => {
    it('defaults: new cities + every preset cluster; the building default (Creator / old saves) stays classic', () => {
        expect(DEFAULT_LAYOUT_PARAMS.roofEquipment).toBe('clustered');
        for (const pr of CITY_SCENE_PRESETS) expect(pr.look.roofEquipment, pr.name).toBe('clustered');
        expect(resolveBuildingParams({}).roofPlant ?? 'classic').toBe('classic');
    });
    it('classic is unchanged: no field = explicit classic, byte for byte', () => {
        for (const a of FLAT.slice(0, 6)) for (const seed of [1, 7]) {
            expect(sig(buildBuilding({ archetype: a, seed, roofPlant: 'classic' }).layers)).toBe(sig(buildBuilding({ archetype: a, seed }).layers));
        }
    });
    it('is deterministic and draws fewer, larger pieces: one tank layer in a fixed colour, less grey plant', () => {
        expect(FLAT.length).toBeGreaterThan(3);
        let fewer = 0, tanks = 0;
        for (const a of FLAT) for (const seed of [1, 2, 3, 4]) {
            const cl = buildBuilding({ archetype: a, seed, roofPlant: 'clustered' }).layers;
            expect(sig(buildBuilding({ archetype: a, seed, roofPlant: 'clustered' }).layers)).toBe(sig(cl));
            const old = buildBuilding({ archetype: a, seed }).layers;
            if (tris(cl, /^bldg:roof-equip$/) < tris(old, /^bldg:roof-equip$/)) fewer++;
            const tk = cl.filter(L => L.name === 'bldg:roof-equip-tank');
            expect(tk.length).toBeLessThanOrEqual(1);
            for (const L of tk) { tanks++; expect(ROOF_TANK_COLORS.map(c => c.join())).toContain(L.color.join()); }
            expect(cl.some(L => L.name === 'bldg:roof-equip-tank') && old.some(L => L.name === 'bldg:roof-equip-tank')).toBe(false);   // classic never makes the coloured layers
        }
        expect(tanks).toBeGreaterThan(FLAT.length);       // most clustered roofs carry their one tank
        expect(fewer).toBeGreaterThan(FLAT.length * 2);   // and less scattered grey plant than the classic roof
    });
});

// The tile checks: byte budget + P20 instancing equivalence on the clustered plant.
const P: LayoutParams = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;
const OPTS = { contact: { opacity: 0.55 } };

function triangles(L: LayoutPreviewLayer): Float64Array[] {
    const v = L.geometry.vertices, ix = L.geometry.indices, out: Float64Array[] = [];
    const xfs: (ReturnType<typeof propXfAt> | null)[] = L.propXf ? Array.from({ length: L.propXf.length / PROP_XF_STRIDE }, (_, i) => propXfAt(L.propXf!, i)) : [null];
    for (const t of xfs) for (let k = 0; k < ix.length; k += 3) {
        const tri = new Float64Array(18);
        for (let c = 0; c < 3; c++) {
            const a = ix[k + c] * F;
            let px = v[a], py = v[a + 1], pz = v[a + 2], nx = v[a + 3], ny = v[a + 4], nz = v[a + 5];
            if (t) {
                const m = t.m, q = t.nm, X = px, Y = py, Z = pz;
                px = m[0] * X + m[3] * Y + m[6] * Z + t.t[0]; py = m[1] * X + m[4] * Y + m[7] * Z + t.t[1]; pz = m[2] * X + m[5] * Y + m[8] * Z + t.t[2];
                const a2 = q[0] * nx + q[3] * ny + q[6] * nz, b2 = q[1] * nx + q[4] * ny + q[7] * nz, c2 = q[2] * nx + q[5] * ny + q[8] * nz, l = Math.hypot(a2, b2, c2) || 1;
                nx = a2 / l; ny = b2 / l; nz = c2 / l;
            }
            tri.set([px, py, pz, nx, ny, nz], c * 6);
        }
        out.push(tri);
    }
    return out;
}
const roofLayers = (gs: TileLayerGroup[]): LayoutPreviewLayer[] => gs.flatMap(g => g.layers).filter(L => /roof-equip/.test(L.name));

describe('clustered roof plant · a full tile', () => {
    const classic = buildTileLayerGroups({ ...P, roofEquipment: 'classic' }, 1, 0, true, { ...OPTS, propInstancing: true });
    const clustered = buildTileLayerGroups({ ...P, roofEquipment: 'clustered' }, 1, 0, true, { ...OPTS, propInstancing: true });

    it('byte budget: the clustered tile is no heavier than the classic one; its roof plant is lighter', () => {
        expect(tileGeometryBytes(clustered)).toBeLessThanOrEqual(tileGeometryBytes(classic));
        const rb = (ls: LayoutPreviewLayer[]): number => ls.reduce((s, L) => s + L.geometry.vertices.byteLength + L.geometry.indices.byteLength, 0);
        expect(rb(roofLayers(clustered))).toBeLessThan(rb(roofLayers(classic)));
        expect(roofLayers(clustered).some(L => /roof-equip-tank/.test(L.name))).toBe(true);
        expect(roofLayers(classic).some(L => /roof-equip-(tank|solar|pad)/.test(L.name))).toBe(false);
    }, 240_000);

    it('instanced roof-plant copies reproduce the baked ones, triangle for triangle', () => {
        const baked = buildTileLayerGroups({ ...P, roofEquipment: 'clustered' }, 1, 0, true, { ...OPTS, propInstancing: false });
        const byName = (gs: TileLayerGroup[]) => {
            const m = new Map<string, LayoutPreviewLayer[]>();
            for (const g of gs) for (const L of g.layers) if (/roof-equip/.test(L.name)) { const k = g.name + '|' + L.name + '|' + (L.nearTwin?.role ?? ''); (m.get(k) ?? m.set(k, []).get(k)!).push(L); }
            return m;
        };
        const A = byName(baked), B = byName(clustered);
        const tol = PROP_INSTANCING_DEFAULTS.tolPos * 1.01, tolN = PROP_INSTANCING_DEFAULTS.tolNrm * 1.01, cell = 1e-3;
        let inst = 0, checked = 0;
        for (const [k, ls] of B) {
            if (!ls.some(L => L.propInst)) continue;
            inst++;
            const want = A.get(k)!.flatMap(triangles), got = ls.flatMap(triangles);
            expect(got.length, k).toBe(want.length);
            const key = (x: number, y: number, z: number) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
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
                used.add(hit!); checked++;
            }
        }
        expect(inst).toBeGreaterThan(0);
        expect(checked).toBeGreaterThan(1000);
    }, 240_000);

    it('HLOD mid tier: clustered roofs add a stair box per flat roof (a few more roof triangles), within the byte budget', () => {
        const mid = (re: 'classic' | 'clustered') => buildTileLayerGroups({ ...P, roofEquipment: re }, 2, 1, false, { hlod: 'mid' }).flatMap(g => g.layers);
        const a = mid('classic'), b = mid('clustered');
        const t = (ls: LayoutPreviewLayer[]): number => ls.reduce((s, L) => s + L.geometry.indices.length / 3, 0);
        expect(t(b)).toBeGreaterThan(t(a));
        expect(t(b)).toBeLessThan(t(a) * 1.5);
        expect(hlodLayerBytes(b)).toBeLessThanOrEqual(HLOD_BYTES.mid);
        expect(mid('clustered').map(L => L.geometry.vertices.length)).toEqual(b.map(L => L.geometry.vertices.length));   // deterministic
    }, 120_000);

    it('is deterministic', () => {
        const again = buildTileLayerGroups({ ...P, roofEquipment: 'clustered' }, 1, 0, true, { ...OPTS, propInstancing: true });
        const s = (gs: TileLayerGroup[]) => roofLayers(gs).map(L => `${L.name}|${L.color.join()}|${L.instanceKey ?? ''}|${L.propXf ? Array.from(L.propXf).join() : ''}|${L.geometry.vertices.length}`).join('\n');
        expect(s(again)).toBe(s(clustered));
    }, 240_000);
});
