import { describe, it, expect } from 'vitest';
import { evaluateSkyColor, bakeSkyEquirect, normalizeSkyParams, DEFAULT_SKY, type ProceduralSkyParams } from './procedural-sky';

// A sun pointing straight up so the disk lands at the +Y pole (easy to target in the bake's top row).
const SUN_UP: [number, number, number] = [0, 1, 0];

describe('normalizeSkyParams', () => {
    it('fills a null blob with DEFAULT_SKY', () => {
        const s = normalizeSkyParams(null);
        expect(s.model).toBe(DEFAULT_SKY.model);
        expect(s.zenith).toEqual(DEFAULT_SKY.zenith);
        expect(s.sunSizeDeg).toBe(DEFAULT_SKY.sunSizeDeg);
    });
    it('keeps provided fields + defaults the rest', () => {
        const s = normalizeSkyParams({ intensity: 2, zenith: [1, 0, 0] });
        expect(s.intensity).toBe(2);
        expect(s.zenith).toEqual([1, 0, 0]);
        expect(s.horizon).toEqual(DEFAULT_SKY.horizon);   // defaulted
    });
    it('deep-copies arrays (no aliasing of the default)', () => {
        const s = normalizeSkyParams(null);
        s.zenith[0] = 99;
        expect(DEFAULT_SKY.zenith[0]).not.toBe(99);
    });
});

describe('evaluateSkyColor', () => {
    // A sun-less sky (halo/disk zero) so the gradient is isolated.
    const plain: ProceduralSkyParams = { ...DEFAULT_SKY, sunColor: [0, 0, 0], sunHalo: 0 };

    it('returns the zenith colour looking straight up (away from the sun)', () => {
        const away: [number, number, number] = [0, -1, 0];   // sun down → looking up is far from the sun
        const c = evaluateSkyColor([0, 1, 0], plain, away);
        expect(c[0]).toBeCloseTo(DEFAULT_SKY.zenith[0], 5);
        expect(c[2]).toBeCloseTo(DEFAULT_SKY.zenith[2], 5);
    });
    it('returns the ground colour looking straight down', () => {
        const c = evaluateSkyColor([0, -1, 0], plain, [0, 1, 0]);
        expect(c[0]).toBeCloseTo(DEFAULT_SKY.ground[0], 5);
    });
    it('returns the horizon colour at the horizon', () => {
        const c = evaluateSkyColor([1, 0, 0], plain, [0, 1, 0]);
        expect(c[1]).toBeCloseTo(DEFAULT_SKY.horizon[1], 5);
    });
    it('adds a bright disk toward the sun', () => {
        const toward = evaluateSkyColor([0, 1, 0], DEFAULT_SKY, SUN_UP);   // straight at the sun
        const side   = evaluateSkyColor([1, 0, 0], DEFAULT_SKY, SUN_UP);   // 90° off
        expect(toward[0]).toBeGreaterThan(side[0] + 1);   // disk contributes a large boost
    });
    it('scales with intensity', () => {
        const dim = evaluateSkyColor([1, 0, 0], { ...plain, intensity: 0.5 }, [0, 1, 0]);
        const full = evaluateSkyColor([1, 0, 0], { ...plain, intensity: 1.0 }, [0, 1, 0]);
        expect(dim[0]).toBeCloseTo(full[0] * 0.5, 5);
    });
});

describe('bakeSkyEquirect', () => {
    it('produces an RGBA image of the requested size with opaque alpha', () => {
        const img = bakeSkyEquirect(DEFAULT_SKY, [0, 1, 0], 16, 8);
        expect(img.width).toBe(16);
        expect(img.height).toBe(8);
        expect(img.data.length).toBe(16 * 8 * 4);
        expect(img.data[3]).toBe(255);
    });
    it('top row (zenith) differs from bottom row (ground)', () => {
        const img = bakeSkyEquirect({ ...DEFAULT_SKY, sunColor: [0, 0, 0], sunHalo: 0 }, [0, 1, 0], 8, 8);
        const top = img.data[2];                              // blue at top row (~zenith)
        const bottomIdx = (7 * 8 + 0) * 4 + 2;
        const bottom = img.data[bottomIdx];                  // blue at bottom row (~ground)
        expect(top).not.toBe(bottom);
        expect(top).toBeGreaterThan(bottom);                 // zenith blue > ground blue
    });
    it('the sun adds energy vs a sun-less sky', () => {
        const sumOf = (p: ProceduralSkyParams) => {
            const img = bakeSkyEquirect(p, [0, 1, 0], 32, 16);
            let s = 0;
            for (let i = 0; i < img.data.length; i += 4) s += img.data[i] + img.data[i + 1] + img.data[i + 2];
            return s;
        };
        const withSun = sumOf(DEFAULT_SKY);
        const noSun = sumOf({ ...DEFAULT_SKY, sunColor: [0, 0, 0], sunHalo: 0 });
        expect(withSun).toBeGreaterThan(noSun);   // the disk/halo add brightness toward the sun
    });
});
