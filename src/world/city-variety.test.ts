import { describe, it, expect } from 'vitest';
import { facadeFor, districtSwatch, DISTRICT_SWATCHES, FACADE_SWATCHES, roofFor, applyRoofVariety, ROOF_FLAT, ROOF_PITCHED, ROOF_TURF } from './palette';
import type { FacadeMaterial } from './palette';
import { DEFAULT_LAYOUT_PARAMS } from './types';
import { CITY_CLEAN_LOOK, CITY_SCENE_PRESETS, GRAPHIC_LOOK } from './scene-presets';
import { cityStyle } from './styles';

// visual-polish #11 (district palette + roof variety) and the #16 / #3b defaults.
const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const sat = (c: number[]): number => { const mx = Math.max(...c), mn = Math.min(...c); return mx > 0 ? (mx - mn) / mx : 0; };
const MATS = Object.keys(DISTRICT_SWATCHES) as FacadeMaterial[];

describe('district palette', () => {
    it('spans a real value range per material (dark < mid < light bands), still low-saturation', () => {
        for (const m of MATS) {
            const g = DISTRICT_SWATCHES[m];
            expect(g.length).toBe(3);
            for (let hue = 0; hue < 3; hue++) expect(lum(g[0][hue])).toBeLessThan(lum(g[1][hue])), expect(lum(g[1][hue])).toBeLessThan(lum(g[2][hue]));
            for (const row of g) for (const c of row) expect(sat(c)).toBeLessThan(0.62);
        }
        // the B4 swatches it replaces: a much narrower luminance range
        const all = (s: number[][]): number => Math.max(...s.map(lum)) - Math.min(...s.map(lum));
        expect(all(MATS.flatMap(m => DISTRICT_SWATCHES[m].flat()))).toBeGreaterThan(all(MATS.flatMap(m => FACADE_SWATCHES[m])) + 0.2);
    });
    it('facadeFor keeps the B4 pick without `wide` and picks from the grid with it (deterministic)', () => {
        const a = facadeFor('zakkyo', 'downtown', 0.3, 0.6, 2), b = facadeFor('zakkyo', 'downtown', 0.3, 0.6, 2, { h3: 0.9 });
        expect(a!.material).toBe(b!.material);
        expect(FACADE_SWATCHES[a!.material]).toContainEqual(a!.color);
        expect(DISTRICT_SWATCHES[b!.material].flat()).toContainEqual(b!.color);
        expect(facadeFor('zakkyo', 'downtown', 0.3, 0.6, 2, { h3: 0.9 })).toEqual(b);
        expect(facadeFor('konbini', 'downtown', 0.3, 0.6, 2, { h3: 0.9 })).toBeNull();   // identity archetypes keep theirs
    });
    it('the value band follows the district weights; the region lean picks the hue family', () => {
        const band = (d: string, h3: number): number => DISTRICT_SWATCHES.tile.findIndex(r => r.some(c => c === districtSwatch('tile', d, 0, h3, 2)));
        expect(band('residential', 0.05)).toBe(0); expect(band('residential', 0.9)).toBe(2);
        let light = 0, dark = 0;
        for (let i = 0; i < 100; i++) { const b = band('residential', (i + 0.5) / 100); if (b === 2) light++; if (b === 0) dark++; }
        expect(light).toBeGreaterThan(dark * 2);   // residential: pale with some dark brick
        expect(districtSwatch('plaster', 'market', 0, 0.5, 0)).toBe(DISTRICT_SWATCHES.plaster[1][0]);   // cool region → cool family
        expect(districtSwatch('plaster', 'market', 0, 0.5, 5)).toBe(DISTRICT_SWATCHES.plaster[1][2]);   // warm region → warm family
    });
});

describe('roof variety', () => {
    it('flat roofs draw from the flat finishes, pitched from the tile / sheet list (deterministic)', () => {
        const flat = new Set<string>(), pit = new Set<string>();
        for (let i = 0; i < 200; i++) { flat.add(roofFor(false, 'market', i / 200).join()); pit.add(roofFor(true, 'market', i / 200).join()); }
        expect(flat.size).toBe(ROOF_FLAT.length);
        expect(pit.size).toBe(ROOF_PITCHED.length);
        expect(roofFor(false, 'nowhere', 0.42)).toEqual(roofFor(false, 'mixed', 0.42));
    });
    it('applyRoofVariety recolours flat / pitched roofs, turns some flat mid-rises into turf gardens, leaves the sawtooth', () => {
        const b = { roofStyle: 'parapet', roofColor: [0.4, 0.4, 0.4] as [number, number, number], roofGarden: false };
        applyRoofVariety(b, 'residential', 4, 0.3, 0.01);
        expect(b.roofGarden).toBe(true); expect(b.roofColor).toEqual(ROOF_TURF);
        const tall = { roofStyle: 'flat', roofColor: [0.4, 0.4, 0.4] as [number, number, number], roofGarden: false };
        applyRoofVariety(tall, 'residential', 20, 0.3, 0.01);
        expect(tall.roofGarden).toBe(false); expect(tall.roofColor).toEqual(roofFor(false, 'residential', 0.3));
        const saw = { roofStyle: 'sawtooth', roofColor: [0.4, 0.4, 0.4] as [number, number, number], roofGarden: false };
        applyRoofVariety(saw, 'market', 2, 0.3, 0.01);
        expect(saw.roofColor).toEqual([0.4, 0.4, 0.4]);
        const hip = { roofStyle: 'hip', roofColor: [0.4, 0.4, 0.4] as [number, number, number], roofGarden: false };
        applyRoofVariety(hip, 'market', 2, 0.99, 0.01);
        expect(hip.roofGarden).toBe(false); expect(ROOF_PITCHED.map(r => r.c)).toContainEqual(hip.roofColor);
    });
});

describe('defaults (visual-polish #11 / #16 / #3b)', () => {
    it('new cities: district palette + roof variety on, crowd 1.4, traffic 1.3', () => {
        expect(DEFAULT_LAYOUT_PARAMS.districtPalette).toBe(true);
        expect(DEFAULT_LAYOUT_PARAMS.roofVariety).toBe(true);
        expect(DEFAULT_LAYOUT_PARAMS.pedestrianDensity).toBe(1.4);
        expect(DEFAULT_LAYOUT_PARAMS.trafficDensity).toBe(1.3);
    });
    it('every scene preset carries the variety look fields; the Graphic + Phantom Night ink drop thin creases', () => {
        expect(CITY_CLEAN_LOOK.districtPalette).toBe(true);
        for (const pr of CITY_SCENE_PRESETS) { expect(pr.look.districtPalette, pr.name).toBe(true); expect(pr.look.roofVariety, pr.name).toBe(true); }
        expect(GRAPHIC_LOOK.outlines?.creaseFade?.thinPx).toBe(3);
        expect(cityStyle('persona5')?.look?.outlines?.creaseFade?.thinPx).toBe(3);
    });
});
