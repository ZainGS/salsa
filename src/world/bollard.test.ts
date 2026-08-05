/**
 * src/world/bollard.test.ts — the bollard generator (3rd prop; a `select` that drives both shape and tint).
 */

import { describe, it, expect } from 'vitest';
import { buildBollard, resolveBollardParams, DEFAULT_BOLLARD_PARAMS, BOLLARD_FINISHES, BOLLARD_CAPS, BOLLARD_FINISH_NAMES } from './bollard';
import type { LayoutPreviewLayer } from './types';

const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3, 0);
const SLOT_FAMILIES = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'] as const;
const familiesOn = (L: LayoutPreviewLayer): string[] =>
  SLOT_FAMILIES.filter((f) => (L as unknown as Record<string, unknown>)[f] != null);

describe('bollard generator', () => {
  it('is one painted-METAL layer, tinted by its finish', () => {
    const { layers } = buildBollard({ finish: 'red' });
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe('world:bollard');
    expect(familiesOn(layers[0]).length).toBe(1);
    expect(layers[0].color).toEqual(BOLLARD_FINISHES.red);
    expect(layers[0].metal!.tint).toEqual(BOLLARD_FINISHES.red);
  });

  it('the cap style changes the geometry', () => {
    const counts = BOLLARD_CAPS.map((cap) => tris(buildBollard({ cap }).layers));
    // The three caps build different triangle counts (dome vs ball-with-collar vs banded ring).
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('resolveBollardParams fills defaults, validates enums, clamps dimensions', () => {
    expect(resolveBollardParams()).toEqual(DEFAULT_BOLLARD_PARAMS);
    expect(resolveBollardParams({ cap: 'bogus' as never }).cap).toBe(DEFAULT_BOLLARD_PARAMS.cap);
    expect(resolveBollardParams({ finish: 'bogus' as never }).finish).toBe(DEFAULT_BOLLARD_PARAMS.finish);
    expect(resolveBollardParams({ heightM: 0.01 }).heightM).toBe(0.3);
    expect(resolveBollardParams({ radiusM: 0 }).radiusM).toBe(0.04);
  });

  it('every finish maps to a real tint and builds', () => {
    for (const finish of BOLLARD_FINISH_NAMES) {
      const { layers } = buildBollard({ finish });
      expect(layers[0].color).toEqual(BOLLARD_FINISHES[finish]);
      expect(tris(layers)).toBeGreaterThan(0);
    }
  });

  it('meta reports height + footprint, is metres-authored, and stays affordable', () => {
    const { layers, meta } = buildBollard({ heightM: 1.0 });
    expect(meta.height).toBe(1.0);
    let maxY = -Infinity, minY = Infinity;
    const v = layers[0].geometry.vertices;
    for (let i = 1; i < v.length; i += 12) { maxY = Math.max(maxY, v[i]); minY = Math.min(minY, v[i]); }
    expect(maxY).toBeGreaterThan(1.0 * 0.9);   // reaches ~heightM (cap may add a little)
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(tris(layers)).toBeLessThan(300);
  });

  it('is deterministic per params', () => {
    expect(tris(buildBollard({ cap: 'ball', seed: 4 }).layers)).toBe(tris(buildBollard({ cap: 'ball', seed: 4 }).layers));
  });
});
