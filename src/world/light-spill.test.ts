import { describe, it, expect } from 'vitest';
import { spillColorFor, spillBucket, lightSpillSources, lightSpillLayers, buildLightSpill, SHOP_SPILL_COLOR, LIGHT_SPILL_LAYER, SPILL_OPACITY } from './light-spill';
import { setLotMeta, type CityLotMeta } from './lot-meta';
import { cityMetresPerUnit } from './types';
import type { Lot, WorldGraph } from './types';

// visual-polish #5: night light spill (shop + sign light on the pavement), built from the per-lot building meta.

const R = 10, MPU = cityMetresPerUnit(R), m = (v: number): number => v / MPU;

function lotWith(meta: Partial<CityLotMeta>): Lot {
    const lot = { id: 'l', poly: [], center: [0, 0], slot: 'building' } as unknown as Lot;
    setLotMeta(lot, {
        detailed: true, shopfront: false, door: null, doorOut: [0, 1], front: { a: [0, 0], b: [m(10), 0], out: [0, 1] },
        wireAnchors: [], signSlots: [], height: m(12), doorY: 0, ...meta,
    } as CityLotMeta);
    return lot;
}
const graphOf = (lots: Lot[]): Pick<WorldGraph, 'lots' | 'params'> => ({ lots, params: { radius: R, groundY: 0 } as WorldGraph['params'] });

describe('light spill colours', () => {
    it('signs light the pavement in their own hue at full value; white / grey / black boxes give a warm white', () => {
        const red = spillColorFor([0.5, 0.05, 0.05]);
        expect(red[0]).toBeCloseTo(1, 5);
        expect(red[0]).toBeGreaterThan(red[1] + 0.4);
        for (const g of [[1, 1, 1], [0.3, 0.3, 0.3], [0.02, 0.02, 0.03]]) {
            const w = spillColorFor(g);
            expect(w[0]).toBeGreaterThanOrEqual(w[1]);
            expect(w[1]).toBeGreaterThanOrEqual(w[2]);
            expect(spillBucket(w)).toBe(12);
        }
        expect(spillColorFor(null)).toHaveLength(3);
    });
    it('buckets by hue (12 bins) and never mixes warm and cool signs', () => {
        expect(spillBucket(spillColorFor([1, 0, 0]))).not.toBe(spillBucket(spillColorFor([0, 0.8, 1])));
        expect(spillBucket(spillColorFor([1, 0, 0]))).toBe(spillBucket(spillColorFor([0.9, 0.05, 0.08])));
    });
});

describe('light spill sources (lot meta)', () => {
    it('a lit shopfront gets one warm pool centred on its facade, ~3.6 m deep', () => {
        const s = lightSpillSources(graphOf([lotWith({ shopfront: true })]));
        expect(s).toHaveLength(1);
        expect(s[0].color).toBe(SHOP_SPILL_COLOR);
        expect(s[0].x).toBeCloseTo(m(5));
        expect(s[0].z).toBeCloseTo(0);
        expect(s[0].b).toBeCloseTo(m(3.6));
        expect(s[0].a).toBeGreaterThan(m(5));
    });
    it('low signs spill in their colour slot, high billboards are skipped, white boxes are dimmer', () => {
        const cols: [[number, number, number], [number, number, number], [number, number, number]] = [[1, 0.1, 0.1], [0.1, 0.4, 1], [1, 1, 1]];
        const s = lightSpillSources(graphOf([lotWith({
            signColors: cols,
            signSlots: [
                { pos: [m(2), m(3.5), 0], out: [0, 1], width: m(3), k: 1 },   // tenant sign, blue slot
                { pos: [m(2), m(30), 0], out: [0, 1], width: m(8) },         // a roof billboard: no ground light
                { pos: [m(6), m(3.5), 0], out: [0, 1], width: m(3), k: 2 },   // a white box
            ],
        })]));
        expect(s).toHaveLength(2);
        expect(s[0].color[2]).toBeGreaterThan(s[0].color[0]);   // blue
        expect(s[0].z).toBeCloseTo(m(0.9));                      // out in front of the facade
        expect(s[1].weight).toBeLessThan(s[0].weight);
    });
    it('lots without building meta (basic boxes, older graphs) add nothing', () => {
        const bare = { id: 'b', poly: [], center: [0, 0] } as unknown as Lot;
        expect(lightSpillSources(graphOf([bare]))).toEqual([]);
        expect(buildLightSpill(graphOf([]))).toEqual([]);
    });
});

describe('light spill layers', () => {
    it('one transparent radial-fade layer per colour bucket, draped like the pavement, a 4x4 grid per pool', () => {
        const g = graphOf([lotWith({ shopfront: true, signColors: [[1, 0, 0], [1, 0, 0], [0, 0, 1]], signSlots: [{ pos: [m(2), m(3), 0], out: [0, 1], width: m(3), k: 0 }, { pos: [m(4), m(3), 0], out: [0, 1], width: m(3), k: 2 }] })]);
        const layers = buildLightSpill(g);
        expect(layers.map((L) => L.name).sort()).toEqual([LIGHT_SPILL_LAYER, `${LIGHT_SPILL_LAYER}-s0`, `${LIGHT_SPILL_LAYER}-s8`].sort());
        for (const L of layers) {
            expect(L.radialFade).toBe(true);
            expect(L.drape).toBe('full');
            expect(L.excludeFromFrame).toBe(true);
            expect(L.opacity!).toBeLessThan(1);
            expect(L.geometry.vertices.length).toBe(25 * 12);
            expect(L.geometry.indices.length).toBe(16 * 6);
            for (let i = 1; i < L.geometry.vertices.length; i += 12) expect(L.geometry.vertices[i]).toBeCloseTo(0.03 / MPU);   // groundY + 3 cm
        }
        expect(layers.find((L) => L.name === LIGHT_SPILL_LAYER)!.opacity).toBeCloseTo(SPILL_OPACITY.shop);
    });
    it('dim sources (high signs) go to a separate, fainter layer', () => {
        const src = (weight: number) => ({ x: 0, z: 0, a: 1, b: 1, ax: [1, 0] as [number, number], color: [1, 0.2, 0.2] as [number, number, number], weight });
        const layers = lightSpillLayers([src(1), src(0.4)], 0);
        expect(layers).toHaveLength(2);
        const [hi, lo] = layers[0].name.endsWith('d') ? [layers[1], layers[0]] : [layers[0], layers[1]];
        expect(lo.opacity!).toBeLessThan(hi.opacity!);
        expect(lightSpillLayers([], 0)).toEqual([]);
    });
    it('UVs are unit radial (centre 0.5,0.5) so radialFade dissolves each pool to nothing at its rim', () => {
        const [L] = lightSpillLayers([{ x: 3, z: 4, a: 2, b: 1, ax: [0, 1], color: SHOP_SPILL_COLOR, weight: 1 }], 0);
        const v = L.geometry.vertices;
        const centre = 12 * 12;   // vertex (2,2) of the 5x5 grid
        expect(v[centre]).toBeCloseTo(3); expect(v[centre + 2]).toBeCloseTo(4);
        expect(v[centre + 6]).toBeCloseTo(0.5); expect(v[centre + 7]).toBeCloseTo(0.5);
        // the long axis follows ax (here +Z): the far corner sits 2 along Z, 1 across
        expect(Math.abs(v[24 * 12 + 2] - 4)).toBeCloseTo(2);
        expect(Math.abs(v[24 * 12] - 3)).toBeCloseTo(1);
    });
});
