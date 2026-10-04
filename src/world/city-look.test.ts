import { describe, it, expect } from 'vitest';
import { computeDayNight, phaseWeights, skyByWeights, DEFAULT_SKY, SHADOW_TINTS } from './day-night';
import { cityPalette } from './palette';
import { cityStyle, CITY_STYLES } from './styles';
import { packGradeVigParams, defaultPostProcessConfig } from '../renderer/3d/post-process-pass';

// city-quality upgrade (docs/specs/city-quality-upgrade.md): L1 / L3 / L8 / P1-P3 / P7.

describe('sun-driven phase weights (L8)', () => {
    it('sum to 1 and follow the sun: noon → noon, midnight → night, sunset → dusk, sunrise → dawn', () => {
        for (const t of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) {
            const L = computeDayNight(t), w = L.weights;
            expect(w.night + w.noon + w.dawn + w.dusk).toBeCloseTo(1, 9);
        }
        expect(computeDayNight(0.5).weights.noon).toBeGreaterThan(0.95);
        expect(computeDayNight(0).weights.night).toBeGreaterThan(0.95);
        const sunset = computeDayNight(0.75).weights, sunrise = computeDayNight(0.25).weights;
        expect(sunset.dusk).toBeGreaterThan(sunset.dawn);
        expect(sunrise.dawn).toBeGreaterThan(sunrise.dusk);
    });
    it('★ at t = 0.92 the sky is night, not a dusk-orange band against a navy fog', () => {
        const L = computeDayNight(0.92);
        expect(L.weights.night).toBeGreaterThan(0.9);
        // horizon ≈ the night key, and the fog leans into it (no visible band)
        for (let i = 0; i < 3; i++) expect(Math.abs(L.sky.bottom[i] - DEFAULT_SKY.night.bottom[i])).toBeLessThan(0.05);
        for (let i = 0; i < 3; i++) expect(Math.abs(L.fogColor[i] - L.sky.bottom[i])).toBeLessThan(0.06);
    });
    it('skyByWeights of a single phase is that key', () => {
        expect(skyByWeights({ night: 0, noon: 1, dawn: 0, dusk: 0 }, DEFAULT_SKY)).toEqual(DEFAULT_SKY.noon);
        expect(phaseWeights(0.5, 1, 0).noon).toBe(1);
    });
});

describe('coloured shadows (L3)', () => {
    it('night shadows lean indigo, noon blue, dusk violet', () => {
        const night = computeDayNight(0).shadowTint, noon = computeDayNight(0.5).shadowTint;
        expect(night[2]).toBeGreaterThan(night[0]);
        expect(noon[2]).toBeGreaterThan(noon[0]);
        expect(SHADOW_TINTS.dusk[0]).toBeGreaterThan(SHADOW_TINTS.dusk[1]);   // violet: red over green
    });
});

describe('night ambient (L1)', () => {
    it('night keeps an indigo fill (the city no longer self-lights), day is brighter', () => {
        const n = computeDayNight(0), d = computeDayNight(0.5);
        expect(n.ambientColor[2]).toBeGreaterThan(n.ambientColor[0]);
        expect(n.ambientIntensity).toBeGreaterThan(0.3);
        expect(d.ambientIntensity).toBeGreaterThan(n.ambientIntensity);
    });
});

describe('palettes + packs (P1-P3)', () => {
    it("'auto' never picks the new palettes (existing auto cities keep their colours)", () => {
        for (let seed = 0; seed < 200; seed++) expect(['phantom', 'inaba']).not.toContain(cityPalette(seed).name);
        expect(cityPalette(1, 'phantom').neon?.length).toBeGreaterThan(2);
        expect(cityPalette(1, 'inaba').windowLit?.length).toBeGreaterThan(0);
    });
    it('the Persona packs carry a full look', () => {
        const p5 = cityStyle('persona5')!, p4 = cityStyle('persona4')!;
        expect(p5.params.palette).toBe('phantom');
        expect(p5.look?.cityStyle?.renderStyle).toBe('cel-hd');
        expect(p5.look?.outlines).toBeTruthy();
        expect(p5.look?.grade?.night?.shadowTint).toBeTruthy();
        expect(p4.params.palette).toBe('inaba');
        expect(p4.timeOfDay).toBeCloseTo(0.72);
        expect(p5.look?.heightFog).toBeGreaterThan(0);   // P9: the Persona packs haze their streets
        expect(p4.look?.heightFog).toBeGreaterThan(0);
        expect(new Set(CITY_STYLES.map((s) => s.name)).size).toBe(CITY_STYLES.length);   // unique names
    });
});

describe('split-tone grade packing (P7)', () => {
    it('absent tints pack as 1,1,1 (the original grade); tints are luminance-normalised (hue only)', () => {
        const c = defaultPostProcessConfig();
        const a = packGradeVigParams(new Float32Array(24), c, 0);
        expect([a[16], a[17], a[18], a[20], a[21], a[22]]).toEqual([1, 1, 1, 1, 1, 1]);
        c.colorGrade.shadowTint = [0.5, 0.4, 1.0];
        const b = packGradeVigParams(new Float32Array(24), c, 0);
        const lum = 0.2126 * b[16] + 0.7152 * b[17] + 0.0722 * b[18];
        expect(lum).toBeCloseTo(1, 5);
        expect(b[18]).toBeGreaterThan(b[16]);
        // a 16-float buffer (old callers) is still written safely
        expect(() => packGradeVigParams(new Float32Array(16), c, 0)).not.toThrow();
    });
});
