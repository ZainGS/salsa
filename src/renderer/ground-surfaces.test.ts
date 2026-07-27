/**
 * src/renderer/ground-surfaces.test.ts — the procedural-ground SURFACE LIBRARY (procedural-ground.md §11,
 * P6). GROUND_SURFACES is the single source of truth the host's picker, `applyGroundMaterial3D` and the
 * WGSL `groundSurface` dispatch all read; these pin the invariants that keep those three in step.
 */

import { describe, it, expect } from 'vitest';
import { GROUND_SURFACES, type GroundSurfaceSpec } from '../services/shape-manager';

const entries = Object.entries(GROUND_SURFACES) as Array<[string, GroundSurfaceSpec]>;

describe('ground surface library — GROUND_SURFACES', () => {
  it('covers the materials a world actually needs, and keeps the P1–P4 names', () => {
    const names = Object.keys(GROUND_SURFACES);
    // P1–P4 names must survive: existing scenes/saves carry these.
    for (const legacy of ['ashlar', 'radialMedallion', 'borderStrip', 'grass']) {
      expect(names).toContain(legacy);
    }
    for (const added of ['brick', 'granite', 'slate', 'sandstone', 'asphalt', 'concrete', 'dirt', 'cobble', 'plank']) {
      expect(names).toContain(added);
    }
  });

  it('uses only groundModes the WGSL dispatch implements (0..8), with no gaps', () => {
    const modes = [...new Set(entries.map(([, s]) => s.mode))].sort((a, b) => a - b);
    expect(modes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [, s] of entries) expect(Number.isInteger(s.mode)).toBe(true);
  });

  it('keeps the legacy surfaces pinned to their original modes (saves store the NUMBER, not the name)', () => {
    expect(GROUND_SURFACES.ashlar.mode).toBe(0);
    expect(GROUND_SURFACES.radialMedallion.mode).toBe(1);
    expect(GROUND_SURFACES.borderStrip.mode).toBe(2);
    expect(GROUND_SURFACES.grass.mode).toBe(3);
  });

  it('reuses the ashlar tiler for the stone LOOKS instead of spending a mode on each', () => {
    // The whole point: brick/granite/slate/sandstone are recipes, not geometry — zero extra shader code.
    for (const look of ['brick', 'granite', 'slate', 'sandstone'] as const) {
      expect(GROUND_SURFACES[look].mode).toBe(0);
    }
    // ...and they are genuinely DIFFERENT recipes, not copies of ashlar.
    const ashlar = GROUND_SURFACES.ashlar;
    for (const look of ['brick', 'granite', 'slate', 'sandstone'] as const) {
      const s = GROUND_SURFACES[look];
      expect([s.tileMm, s.aspect, s.tint.join(), s.jitter, s.rough].join('|'))
        .not.toBe([ashlar.tileMm, ashlar.aspect, ashlar.tint.join(), ashlar.jitter, ashlar.rough].join('|'));
    }
  });

  it('gives every surface a physically sane recipe', () => {
    const ORGANIC = [3, 4, 6];   // grass / asphalt / dirt — no cells, so no tile or grout
    for (const [name, s] of entries) {
      expect(s.rough, name).toBeGreaterThan(0);
      expect(s.rough, name).toBeLessThanOrEqual(1);
      expect(s.jitter, name).toBeGreaterThanOrEqual(0);
      expect(s.tint, name).toHaveLength(3);
      for (const c of s.tint) { expect(c, name).toBeGreaterThanOrEqual(0); expect(c, name).toBeLessThanOrEqual(1); }
      if (ORGANIC.includes(s.mode)) {
        expect(s.tileMm, name).toBe(0);
        expect(s.groutMm, name).toBe(0);
      } else {
        expect(s.tileMm, name).toBeGreaterThan(0);
        expect(s.groutMm, name).toBeGreaterThan(0);
        // Grout must be a small fraction of the tile, or the seam eats the stone.
        expect(s.groutMm / s.tileMm, name).toBeLessThan(0.2);
        expect(s.aspect, name).toBeGreaterThan(0);
      }
    }
  });

  it('brick is brick-shaped and asphalt is dark — the two easiest recipes to get wrong', () => {
    // A UK/US standard brick face is 215 × 65 mm; the aspect is what stops it reading as a paver.
    expect(GROUND_SURFACES.brick.tileMm).toBe(215);
    expect(GROUND_SURFACES.brick.aspect).toBeCloseTo(215 / 65, 5);
    expect(GROUND_SURFACES.brick.tint[0]).toBeGreaterThan(GROUND_SURFACES.brick.tint[2]);  // red clay
    // Asphalt is near-black and rough; a mid-grey rough surface is concrete, not asphalt.
    const a = GROUND_SURFACES.asphalt;
    expect(Math.max(...a.tint)).toBeLessThan(0.3);
    expect(a.rough).toBeGreaterThan(0.7);
    expect(Math.max(...GROUND_SURFACES.concrete.tint)).toBeGreaterThan(0.5);
  });
});
