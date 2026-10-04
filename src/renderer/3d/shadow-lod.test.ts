import { describe, it, expect } from 'vitest';
import { shadowTexel, shadowLodThreshold, shadowLodScreenThreshold, tooSmallForShadowMap } from './shadow-lod';

// P8 shadow LOD (docs/specs/performance-plan.md P8).
describe('shadow LOD', () => {
  it('a map texel is its box width over its size', () => {
    expect(shadowTexel(8, 2048)).toBeCloseTo(16 / 2048);
    expect(shadowTexel(8, 0)).toBe(0);
  });
  it('skips only casters with a feature size below the threshold; off / 0 keeps everything', () => {
    const thr = shadowLodThreshold(true, 1, shadowTexel(48, 2048));   // a sky-band far map: ~0.047 units
    expect(tooSmallForShadowMap(0.4 / 15, thr)).toBe(true);           // a 0.4 m class at 15 m / unit
    expect(tooSmallForShadowMap(0, thr)).toBe(false);                 // no feature size = always casts
    expect(tooSmallForShadowMap(1, thr)).toBe(false);
    expect(tooSmallForShadowMap(0.4 / 15, shadowLodThreshold(false, 1, 1))).toBe(false);
    expect(tooSmallForShadowMap(0.4 / 15, shadowLodThreshold(true, 0, 1))).toBe(false);
    // the street-level far map (8-unit box, ~0.12 m texels) keeps every class of 0.12 m and up
    const street = shadowLodThreshold(true, 1, shadowTexel(8, 2048));
    for (const m of [0.12, 0.3, 0.4]) expect(tooSmallForShadowMap(m / 15, street)).toBe(false);
  });
  it('the screen guard: nothing is skipped below the city roofs; from 300 m up a 0.4 m class is under 2 px', () => {
    const pxAng = 2 * Math.tan(25 * Math.PI / 180) / 850;          // 50° lens, 850 px tall
    expect(shadowLodScreenThreshold(2, 0, pxAng)).toBe(0);           // street / rooftop: bias 0
    const sky = shadowLodScreenThreshold(2, 270 / 15, pxAng);        // ~270 m above the roofs, in 15 m units
    expect(tooSmallForShadowMap(0.4 / 15, sky)).toBe(true);
    expect(tooSmallForShadowMap(0.8 / 15, sky)).toBe(false);         // the crowd (long shadows) keeps casting
    const thr = Math.min(sky, shadowLodThreshold(true, 1, shadowTexel(48, 2048)));
    expect(tooSmallForShadowMap(0.4 / 15, thr)).toBe(true);
  });
});
