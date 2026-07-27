/**
 * src/renderer/water-material.test.ts — the WATER material (Material3D bit 21, `waterShade`).
 *
 * Water used to be the `waves` pattern motif: a colour scrolled across the ALBEDO. That can never shimmer,
 * because shimmer is specular — it needs the surface NORMAL to move, and a pattern motif never touches it.
 * The replacement builds a real ripple normal, so these pin the encoding, the slot exclusivity, and the
 * shader contract that makes it light-driven rather than painted.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_MATERIAL, encodeMaterialFlags, type Material3D } from '../renderer/3d/material-3d';
import { MESH3D_FRAGMENT_SHADER, MESH3D_FRAGMENT_SHADER_UNTEXTURED } from '../renderer/3d/shaders/mesh3d-shaders';

const WATER_BIT = 2097152;   // bit 21 — must match the WGSL decode

describe('water material — waterShade (bit 21)', () => {
  it('encodes as bit 21 and collides with nothing else', () => {
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, waterShade: true }) & WATER_BIT).toBe(WATER_BIT);
    expect(encodeMaterialFlags(DEFAULT_MATERIAL) & WATER_BIT).toBe(0);
    // Every other pattern-slot consumer must leave bit 21 clear — they all share the same instance floats.
    const others: Material3D = {
      ...DEFAULT_MATERIAL, patternMode: 'waves', texOverBase: true, boardShade: true,
      radialFade: true, groundShade: true, windSway: true, foliageShade: true, leafCard: true,
    };
    expect(encodeMaterialFlags(others) & WATER_BIT).toBe(0);
    expect(encodeMaterialFlags({ ...others, waterShade: true }))
      .toBe(encodeMaterialFlags(others) | WATER_BIT);
  });

  it('round-trips its params through JSON (params-only persistence)', () => {
    const mat: Material3D = {
      ...DEFAULT_MATERIAL, waterShade: true,
      waterDeep: [0.045, 0.17, 0.26], waterShallow: [0.30, 0.58, 0.62],
      waterWaveScale: 10.7, waterWaveSpeed: 0.85, waterChoppy: 0.45, waterGlitter: 1.15,
    };
    const round = JSON.parse(JSON.stringify(mat)) as Material3D;
    expect(round.waterShade).toBe(true);
    expect(round.waterDeep).toEqual([0.045, 0.17, 0.26]);
    expect(round.waterWaveScale).toBe(10.7);
    expect(encodeMaterialFlags(round) & WATER_BIT).toBe(WATER_BIT);
  });
});

describe('water WGSL — it must be LIGHT-driven, not a painted animation', () => {
  for (const [name, src] of [['textured', MESH3D_FRAGMENT_SHADER], ['untextured', MESH3D_FRAGMENT_SHADER_UNTEXTURED]] as const) {
    it(`${name}: perturbs the NORMAL — the whole reason the old motif could not shimmer`, () => {
      expect(src).toContain('fn wt_waves(');
      expect(src).toContain('fn waterSurface(');
      // The shading branch must assign N. If it only set the albedo we are back to painted bands.
      const branch = src.slice(src.indexOf('let waterShade ='), src.indexOf('let waterShade =') + 900);
      expect(branch).toMatch(/N = wS\.N/);
    });

    it(`${name}: reflects the SCENE SKY, so water follows the day/night cycle`, () => {
      // fogColor is keyed to time of day by the grade/cycle, which is why it is the reflection tint.
      expect(src).toMatch(/waterSurface\(worldPos, N, V, L, scene\.fogColor\.rgb/);
    });

    it(`${name}: adds glitter AFTER lighting, not into the albedo`, () => {
      // A specular scintillation multiplied by the diffuse response would vanish in shadow and read wrong.
      expect(src).toContain('lit = lit + scene.lightColor.rgb * waterGlint;');
    });

    it(`${name}: decodes bit 21`, () => {
      expect(src).toContain('(flags & 2097152u) != 0u');
    });
  }
});
