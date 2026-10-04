import { describe, it, expect } from 'vitest';
import { packFxaaParams, sanitizeAntiAliasing, DEFAULT_ANTI_ALIASING, FXAA_FS } from './fxaa-pass';

describe('FXAA anti-aliasing (persona-polish A1)', () => {
    it('defaults ON (FXAA medium) and sanitizes unknown values back to the defaults', () => {
        expect(DEFAULT_ANTI_ALIASING).toEqual({ mode: 'fxaa', quality: 'medium' });
        expect(sanitizeAntiAliasing({ mode: 'msaa' as never, quality: 'ultra' as never })).toEqual(DEFAULT_ANTI_ALIASING);
        expect(sanitizeAntiAliasing({ mode: 'off' })).toEqual({ mode: 'off', quality: 'medium' });
        expect(sanitizeAntiAliasing(undefined)).toEqual(DEFAULT_ANTI_ALIASING);
    });
    it('packs texel size + a longer, more sensitive search as quality rises', () => {
        const lo = packFxaaParams(new Float32Array(8), 1000, 500, 'low');
        const hi = packFxaaParams(new Float32Array(8), 1000, 500, 'high');
        expect(lo[0]).toBeCloseTo(0.001); expect(lo[1]).toBeCloseTo(0.002);
        expect(hi[2]).toBeGreaterThan(lo[2]);      // search steps
        expect(hi[4]).toBeLessThan(lo[4]);         // contrast threshold
    });
    it('uses only level-sampled fetches (valid in the non-uniform edge-walk branches)', () => {
        expect(FXAA_FS).not.toMatch(/textureSample\(/);
        expect(FXAA_FS).toMatch(/textureSampleLevel\(/);
    });
});
