import { describe, it, expect } from 'vitest';
import { buildTileLayerGroups, type TileLayerGroup } from './tile-build';
import { generateCityLayout } from './layout';
import { buildTileHlod, bucketColours, hlodLayerBytes, HLOD_BYTES, MID_WALL_BUCKETS, MID_ROOF_BUCKETS } from './tile-hlod';
import { tileParams, tileSeed, offsetGraphGeometry } from './tiled';
import type { LayoutParams, LayoutPreviewLayer } from './types';

// performance-plan P17 — the HLOD tiers of a streamed tile (mid: merged shells in colour buckets; far: a 2-draw
// silhouette), built by the same buildTileLayerGroups the world worker runs.
const P: LayoutParams = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;
const R = P.radius;
const layers = (g: TileLayerGroup[]): LayoutPreviewLayer[] => g.flatMap(x => x.layers);
const box = (L: LayoutPreviewLayer): [number, number, number, number, number, number] => {
    const v = L.geometry.vertices;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < v.length; i += 12) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]); z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]); }
    return [x0, y0, z0, x1, y1, z1];
};
const TILES: Array<[number, number]> = [[2, 1], [-3, 2], [1, -4], [0, 3]];

describe('P17 HLOD tiers', () => {
    const mid = TILES.map(([tx, tz]) => buildTileLayerGroups(P, tx, tz, false, { hlod: 'mid' }));
    const far = TILES.map(([tx, tz]) => buildTileLayerGroups(P, tx, tz, false, { hlod: 'far' }));

    it('is deterministic per seed: two builds of a tile are identical, byte for byte', () => {
        for (const level of ['mid', 'far'] as const) {
            const a = layers(buildTileLayerGroups(P, 2, 1, false, { hlod: level })), b = layers(buildTileLayerGroups(P, 2, 1, false, { hlod: level }));
            expect(a.map(L => L.name)).toEqual(b.map(L => L.name));
            a.forEach((L, i) => {
                expect(L.color).toEqual(b[i].color);
                expect(Array.from(L.geometry.vertices)).toEqual(Array.from(b[i].geometry.vertices));
                expect(Array.from(L.geometry.indices)).toEqual(Array.from(b[i].geometry.indices));
            });
        }
        // a different world seed is a different tile
        const P2 = { ...P, seed: 4 };
        const c = layers(buildTileLayerGroups(P2, 2, 1, false, { hlod: 'mid' }));
        expect(c.map(L => L.geometry.vertices.length)).not.toEqual(layers(mid[0]).map(L => L.geometry.vertices.length));
    }, 60_000);

    it('stays within its byte targets (mid ≤ 5 MB, far ≤ 1 MB) and its draw counts', () => {
        for (const g of mid) {
            const ls = layers(g);
            expect(hlodLayerBytes(ls)).toBeLessThanOrEqual(HLOD_BYTES.mid);
            expect(ls.filter(L => L.name.startsWith('world:bldg-hlod-')).length).toBeLessThanOrEqual(MID_WALL_BUCKETS);
            expect(ls.filter(L => L.name.startsWith('world:roofs-hlod-')).length).toBeLessThanOrEqual(MID_ROOF_BUCKETS);
            expect(ls.length).toBeLessThanOrEqual(MID_WALL_BUCKETS + MID_ROOF_BUCKETS + 4);   // + roads / paving / park / water
        }
        for (const g of far) {
            const ls = layers(g);
            expect(hlodLayerBytes(ls)).toBeLessThanOrEqual(HLOD_BYTES.far);
            expect(ls.map(L => L.name)).toEqual(['world:hlod-ground', 'world:bldg-hlod-far', 'world:roofs-hlod-far']);
        }
    }, 60_000);

    it('every layer is a plain world-baked mesh on its own tile (no instances, no vertex colours: GPU-driven records)', () => {
        TILES.forEach(([tx, tz], i) => {
            for (const L of [...layers(mid[i]), ...layers(far[i])]) {
                expect(L.instances?.length ?? 0).toBe(0);
                expect(L.geometry.vertexColors).toBeUndefined();
                const [x0, , z0, x1, , z1] = box(L);
                expect(x0).toBeGreaterThan(tx * 2 * R - R * 1.15); expect(x1).toBeLessThan(tx * 2 * R + R * 1.15);
                expect(z0).toBeGreaterThan(tz * 2 * R - R * 1.15); expect(z1).toBeLessThan(tz * 2 * R + R * 1.15);
            }
        });
    }, 60_000);

    it('mid and far stand at the same heights (same buildings), close to the full tile skyline', () => {
        const top = (ls: LayoutPreviewLayer[], re: RegExp): number => Math.max(...ls.filter(L => re.test(L.name)).map(L => box(L)[4]));
        const full = layers(buildTileLayerGroups(P, 2, 1, true, {}));
        const tm = top(layers(mid[0]), /bldg-hlod|roofs-hlod/), tf = top(layers(far[0]), /hlod-far/), tFull = top(full, /world:detail-(wall|roof|parapet)|world:roofs|world:lm-/);
        expect(Math.abs(tm - tf)).toBeLessThan(1e-4);
        expect(tm).toBeGreaterThan(tFull * 0.6);
        expect(tm).toBeLessThan(tFull * 1.4);
    }, 120_000);

    it('mid carries colour variety (several facade buckets) and roof variety (pitched roofs, parapets)', () => {
        const ls = layers(mid[0]);
        const walls = ls.filter(L => L.name.startsWith('world:bldg-hlod-'));
        expect(walls.length).toBeGreaterThanOrEqual(3);
        expect(walls.every(L => L.pattern?.mode === 'windows')).toBe(true);
        const tris = (L: LayoutPreviewLayer): number => L.geometry.indices.length / 3;
        // the massing tier is one box per lot (walls + a flat cap); mid adds pitched roofs / parapet lips / crowns
        const massing = layers(buildTileLayerGroups(P, 2, 1, false, { massing: true })).filter(L => L.name === 'world:roofs');
        const midRoofTris = ls.filter(L => L.name.startsWith('world:roofs-hlod-')).reduce((a, L) => a + tris(L), 0);
        expect(midRoofTris).toBeGreaterThan(massing.reduce((a, L) => a + tris(L), 0));
    }, 60_000);

    it('buildTileHlod on a hand-offset graph equals the tile build path (pre-drape it is the same builder)', () => {
        const tp = tileParams(P, tileSeed(P.seed, 2, 1, true));
        tp.warpSeed = P.warpSeed ?? P.seed;
        const g = generateCityLayout(tp);
        offsetGraphGeometry(g, 2 * 2 * R, 1 * 2 * R, true);
        g.params.tileOrigin = [2 * 2 * R, 1 * 2 * R];
        const a = buildTileHlod(g, 'far'), b = buildTileHlod(g, 'far');
        expect(a.map(L => L.geometry.vertices.length)).toEqual(b.map(L => L.geometry.vertices.length));
        expect(a.map(L => L.name)).toEqual(['world:hlod-ground', 'world:bldg-hlod-far', 'world:roofs-hlod-far']);
    });
});

describe('bucketColours (deterministic colour quantisation)', () => {
    it('caps the bucket count, joins near colours, keeps far ones apart, and is order-stable', () => {
        const cols: [number, number, number][] = [[0.8, 0.8, 0.8], [0.81, 0.8, 0.79], [0.2, 0.3, 0.6], [0.5, 0.2, 0.2], [0.79, 0.81, 0.8], [0.21, 0.29, 0.61]];
        const w = [3, 1, 2, 1, 1, 1];
        const a = bucketColours(cols, w, 4);
        expect(a.centres.length).toBe(3);   // grey / blue / red
        expect(a.of[0]).toBe(a.of[1]); expect(a.of[0]).toBe(a.of[4]); expect(a.of[2]).toBe(a.of[5]);
        expect(a.of[3]).not.toBe(a.of[0]);
        expect(bucketColours(cols, w, 2).centres.length).toBe(2);
        expect(bucketColours(cols, w, 4)).toEqual(a);
    });
});
