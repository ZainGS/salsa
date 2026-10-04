/**
 * src/world/sky.test.ts — visual-polish #9: the SKY DOME look per time of day (skyDomeParams), its look-field
 * cleaning, the presets / packs that turn it on, the dome-cloud mover gate, and the tiled-world bank fix.
 */
import { describe, it, expect } from 'vitest';
import { skyDomeParams, cleanSkyDome, SKY_DOME_DEFAULTS, buildSky } from './sky';
import { computeDayNight } from './day-night';
import { CITY_SCENE_PRESETS, CITY_CLEAN_LOOK } from './scene-presets';
import { cityStyle } from './styles';
import { generateCityLayout } from './layout';
import { computeTraffic } from './traffic';
import { tiledWorldExtent } from './tiled';
import type { LayoutParams } from './types';

const P = { seed: 3, radius: 10, pattern: 'grid', border: 'square' } as unknown as Partial<LayoutParams>;
const at = (t: number, weather = 'clear', dome = {}) => skyDomeParams({
    t, L: computeDayNight(t, { weather, sunAzimuth: Math.PI * 0.25, sunWarmth: 1 }), sunAzimuth: Math.PI * 0.25, weather, dome,
    clouds: true, cloudDensity: 0.4, seed: 3,
});
const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('sky dome per time of day', () => {
    it('night: stars, a moon, the city glow; no sun', () => {
        const n = at(0.93);
        expect(n.stars).toBeGreaterThan(0.5);
        expect(n.moon).toBeGreaterThan(0.9);
        expect(n.glowAmount).toBeGreaterThan(0.3);
        expect(n.sunDisc).toBe(0);
        expect(n.sunDir[1]).toBeLessThan(0);                 // the true sun is under the horizon
        for (let i = 0; i < 3; i++) expect(n.cloudLightDir[i]).toBeCloseTo(n.moonDir[i], 6);   // moonlit clouds
        expect(n.moonDir[1]).toBeCloseTo(Math.sin(24 * Math.PI / 180), 6);
    });
    it('noon / golden: a sun disc, no stars / moon / glow; golden clouds are warm-lit with gold rims', () => {
        const noon = at(0.5), gold = at(0.7);
        for (const p of [noon, gold]) { expect(p.sunDisc).toBeGreaterThan(0.5); expect(p.stars).toBe(0); expect(p.moon).toBe(0); expect(p.glowAmount).toBe(0); }
        expect(gold.sunDir[1]).toBeGreaterThan(0.1);
        expect(gold.sunHalo).toBeGreaterThan(noon.sunHalo);
        expect(gold.cloudLit[0] - gold.cloudLit[2]).toBeGreaterThan(noon.cloudLit[0] - noon.cloudLit[2]);   // warmer lit tops
        expect(gold.cloudRim[0]).toBeGreaterThan(gold.cloudRim[2] + 0.2);                                  // a gold rim
        expect(gold.cloudRimAmount).toBeGreaterThan(noon.cloudRimAmount);
        expect(lum(gold.cloudShade)).toBeLessThan(lum(gold.cloudLit));                                     // two tones
    });
    it('dusk (sun just set): dark cloud silhouettes', () => {
        const dusk = at(0.77), gold = at(0.7);
        expect(dusk.sunDir[1]).toBeLessThan(0.05);
        expect(lum(dusk.cloudShade)).toBeLessThan(lum(gold.cloudShade));
    });
    it('weather decks hide the sun / moon / stars / painted clouds and spread the city glow', () => {
        for (const w of ['rain', 'snow', 'overcast']) {
            const p = at(0.93, w);
            expect([p.sunDisc, p.moon, p.stars, p.clouds]).toEqual([0, 0, 0, 0]);
            expect(p.glowHeight).toBeGreaterThan(at(0.93).glowHeight);
        }
    });
    it('the look knobs reach the uniforms', () => {
        const p = at(0.93, 'clear', { stars: 0, moon: 0.5, cityGlow: 0, cityGlowColor: [0, 1, 0] });
        expect(p.stars).toBe(0);
        expect(p.moon).toBeCloseTo(0.5, 6);
        expect(p.glowAmount).toBe(0);
        expect(p.glowColor).toEqual([0, 1, 0]);
        expect(skyDomeParams({ ...{ t: 0.5, L: computeDayNight(0.5), sunAzimuth: 0, weather: 'clear', dome: {}, cloudDensity: 0.4, seed: 1 }, clouds: false }).clouds).toBe(0);
    });
});

describe('cleanSkyDome', () => {
    it('keeps only valid fields (absent / junk = off)', () => {
        expect(cleanSkyDome(undefined)).toBeNull();
        expect(cleanSkyDome(null)).toBeNull();
        expect(cleanSkyDome(5)).toBeNull();
        expect(cleanSkyDome({})).toEqual({});
        expect(cleanSkyDome({ stars: 4, moon: -1, cityGlow: 'x', clouds: 'puffs', cityGlowColor: [1, 2], moonElevationDeg: 200, moonAzimuthDeg: -90 }))
            .toEqual({ stars: 1, moon: 0, moonElevationDeg: 80, moonAzimuthDeg: 270 });
        expect(cleanSkyDome({ clouds: 'cards', cityGlowColor: [1, 0.5, 0.2] })).toEqual({ clouds: 'cards', cityGlowColor: [1, 0.5, 0.2] });
        expect(Object.keys(SKY_DOME_DEFAULTS).sort()).toEqual(['cityGlow', 'cityGlowColor', 'clouds', 'moon', 'moonAzimuthDeg', 'moonElevationDeg', 'stars']);
    });
});

describe('who gets the dome', () => {
    it('every scene preset + the persona packs; style packs without a look stay legacy', () => {
        expect(CITY_CLEAN_LOOK.skyDome).toEqual({});
        for (const pr of CITY_SCENE_PRESETS) expect([pr.name, !!pr.look.skyDome]).toEqual([pr.name, true]);
        expect(cityStyle('persona5')!.look!.skyDome).toBeTruthy();
        expect(cityStyle('persona5')!.params.clouds).toBe(false);   // ...and the P5 pack keeps its clouds off
        expect(cityStyle('persona4')!.look!.skyDome).toBeTruthy();
        expect(cityStyle('tokyo')!.look?.skyDome).toBeUndefined();
    });
    it('domeClouds drops the painted cloud cards (no legacy puffs either); weather decks are unchanged', () => {
        const clouds = (over: Partial<LayoutParams>) => computeTraffic(generateCityLayout({ ...P, ...over })).filter(m => m.kind === 'cloud' && !m.faceRoute);
        const painted = clouds({ cloudDensity: 0.4, paintedClouds: true });
        const dome = clouds({ cloudDensity: 0.4, paintedClouds: true, domeClouds: true });
        expect(painted.length).toBeGreaterThanOrEqual(3);
        expect(dome.every(m => !m.layers.some(L => /traffic-cloud/.test(L.name)))).toBe(true);
        expect(clouds({ weather: 'rain', paintedClouds: true, domeClouds: true }).length).toBeGreaterThan(50);   // the storm deck stays
    });
});

describe('tiled-world horizon banks (the sliced-card fix)', () => {
    it('tiled banks sit inside ~1.9 x the tiled extent (inside the far plane); single cities keep 2.6-3.1 R', () => {
        const radial = (over: Partial<LayoutParams>) => {
            const g = generateCityLayout({ ...P, ...over });
            const L = buildSky(g).find(l => l.name === 'world:sky-clouds')!;
            const v = L.geometry.vertices, stride = 12;   // pos(3) normal(3) uv(2) tangent(4)
            let mx = 0, mn = 1e9;
            for (let i = 0; i < v.length; i += stride) { const d = Math.hypot(v[i], v[i + 2]); mx = Math.max(mx, d); mn = Math.min(mn, d); }
            return { mx, mn, g };
        };
        const single = radial({});
        expect(single.mn).toBeGreaterThan(10 * 2.4);
        const tiled = radial({ worldMode: 'tiled', tileRadius: 1 } as Partial<LayoutParams>);
        const E = tiledWorldExtent(tiled.g.params);
        expect(tiled.mx).toBeLessThan(E * 2.0);
        expect(tiled.mn).toBeGreaterThan(E * 1.5);
    });
});
