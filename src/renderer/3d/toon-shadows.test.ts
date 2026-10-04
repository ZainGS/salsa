import { describe, it, expect } from 'vitest';
import {
  encodeMaterialFlags, resolveToonShadows, resolveRimLight, DEFAULT_TOON_SHADOWS, DEFAULT_RIM_LIGHT, type Material3D,
} from './material-3d';

const mat = (over: Partial<Material3D> = {}): Material3D => ({ renderStyle: 'cel', ...over } as Material3D);

describe('toon shadows + rim light (film-look-and-toon-shadows.md §B/§C)', () => {
  it('toonShadow = material flag bit 30; off leaves the flags exactly as before', () => {
    const off = encodeMaterialFlags(mat());
    const on = encodeMaterialFlags(mat({ toonShadow: true }));
    expect(on - off).toBe(1073741824);
    expect((on >>> 30) & 1).toBe(1);
    expect((off >>> 30) & 1).toBe(0);
  });

  it('defaults: rim strength 0 (= the original built-in rim), a lavender 2-band toon look', () => {
    expect(DEFAULT_RIM_LIGHT.strength).toBe(0);
    expect(DEFAULT_TOON_SHADOWS.bands).toBe(2);
    expect(DEFAULT_TOON_SHADOWS.shadowTint[2]).toBeGreaterThan(DEFAULT_TOON_SHADOWS.shadowTint[0]);   // cool tint
  });

  it('resolveToonShadows merges + clamps (bands 1–4 integer, colours 0..1)', () => {
    const r = resolveToonShadows(DEFAULT_TOON_SHADOWS, { bands: 9.4, softness: -1, shadowValue: 2, shadowTint: [2, -1, 0.5], saturation: 0.5 });
    expect(r).toEqual({ bands: 4, softness: 0, shadowValue: 1, shadowTint: [1, 0, 0.5], saturation: 0.5 });
    expect(resolveToonShadows(DEFAULT_TOON_SHADOWS, {})).toEqual(DEFAULT_TOON_SHADOWS);
  });

  it('resolveRimLight merges + clamps', () => {
    const r = resolveRimLight(DEFAULT_RIM_LIGHT, { strength: 5, width: 0, hardness: 3, color: [1, 1, 1] });
    expect(r).toEqual({ strength: 2, width: 0.02, hardness: 1, color: [1, 1, 1] });
  });
});
