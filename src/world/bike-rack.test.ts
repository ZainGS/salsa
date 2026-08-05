/**
 * src/world/bike-rack.test.ts — the bike-rack generator (2nd prop on the vending template; minimal manager).
 *
 * A deliberately simple prop: one galvanised-metal layer, four knobs. It exists partly to prove the creator
 * pattern scales down as cleanly as it scales up — so the test pins the same contract vending's does (one
 * material family, params drive geometry, deterministic, budget) at this smaller size.
 */

import { describe, it, expect } from 'vitest';
import { buildBikeRack, resolveBikeRackParams, DEFAULT_BIKE_RACK_PARAMS } from './bike-rack';
import type { LayoutPreviewLayer } from './types';

const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3, 0);
const SLOT_FAMILIES = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'] as const;
const familiesOn = (L: LayoutPreviewLayer): string[] =>
  SLOT_FAMILIES.filter((f) => (L as unknown as Record<string, unknown>)[f] != null);

describe('bike rack generator', () => {
  it('is one galvanised-METAL layer (not flat colour), and only one', () => {
    const { layers } = buildBikeRack();
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe('world:bike-rack');
    expect(layers[0].metal, 'rack is flat, not metal').toBeTruthy();
    expect(familiesOn(layers[0]).length).toBe(1);   // exactly one material family
  });

  it('the hoop count drives the geometry', () => {
    expect(tris(buildBikeRack({ hoops: 5 }).layers)).toBeGreaterThan(tris(buildBikeRack({ hoops: 2 }).layers));
  });

  it('a single hoop does not divide by zero (centres it)', () => {
    for (const v of buildBikeRack({ hoops: 1 }).layers[0].geometry.vertices) expect(Number.isFinite(v)).toBe(true);
  });

  it('resolveBikeRackParams fills defaults + clamps the hoop count', () => {
    expect(resolveBikeRackParams()).toEqual(DEFAULT_BIKE_RACK_PARAMS);
    expect(resolveBikeRackParams({ hoops: 99 }).hoops).toBe(8);
    expect(resolveBikeRackParams({ hoops: 0 }).hoops).toBe(1);
    expect(resolveBikeRackParams({ lengthM: 0 }).lengthM).toBe(0.3);
  });

  it('meta reports height + a run-sized footprint (metres)', () => {
    const { meta } = buildBikeRack({ lengthM: 2.4, widthM: 0.8, heightM: 0.9 });
    expect(meta.height).toBe(0.9);
    expect(Math.max(...meta.footprint.map((p) => Math.abs(p[0])))).toBeCloseTo(1.2, 6);   // length/2
    expect(Math.max(...meta.footprint.map((p) => Math.abs(p[1])))).toBeCloseTo(0.4, 6);   // width/2
  });

  it('is authored in metres (tallest extent ≈ heightM) and stays affordable', () => {
    let maxY = -Infinity, minY = Infinity;
    const layers = buildBikeRack({ heightM: 0.8 }).layers;
    for (const v0 of layers) { const v = v0.geometry.vertices; for (let i = 1; i < v.length; i += 12) { maxY = Math.max(maxY, v[i]); minY = Math.min(minY, v[i]); } }
    expect(maxY - minY).toBeGreaterThan(0.8 * 0.9);
    expect(maxY - minY).toBeLessThan(0.8 * 1.1);
    expect(tris(buildBikeRack().layers)).toBeLessThan(400);
  });

  it('is deterministic per params', () => {
    expect(tris(buildBikeRack({ hoops: 4, seed: 7 }).layers)).toBe(tris(buildBikeRack({ hoops: 4, seed: 7 }).layers));
  });
});
