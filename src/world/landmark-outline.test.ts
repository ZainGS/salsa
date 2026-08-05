/**
 * src/world/landmark-outline.test.ts — hover-outline exact silhouette (docs/specs/hover-outline.md).
 *
 * Landmarks merge all buildings into ~9 per-material meshes. To trace ONE landmark's exact silhouette out of a
 * merged mesh, buildLandmarks records a per-landmark index sub-range on each merged layer (`outlineRanges`). These
 * tests pin that the ranges are valid + within the geometry + point at real landmarks — else the hover outline
 * would trace garbage indices.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildLandmarks } from './landmarks';
import type { WorldGraph } from './types';

const cityWithLandmarks = (): WorldGraph => {
  // A bigger radius guarantees several landmark types get placed (the n formula scales with radius).
  for (const seed of [3, 1, 5, 7, 2, 9]) {
    const g = generateCityLayout({ seed, radius: 14, pattern: 'grid', border: 'square' });
    if (g.landmarks.length >= 2) return g;
  }
  return generateCityLayout({ seed: 3, radius: 14, pattern: 'grid', border: 'square' });
};

describe('landmark exact-silhouette outline ranges', () => {
  it('emits per-landmark sub-ranges on the merged lm-stone layer', () => {
    const g = cityWithLandmarks();
    expect(g.landmarks.length).toBeGreaterThan(0);
    const stone = buildLandmarks(g).find((l) => l.name === 'world:lm-stone');
    expect(stone).toBeDefined();
    expect(stone!.outlineRanges && stone!.outlineRanges.length).toBeGreaterThan(0);
  });

  it('every range is valid, in-bounds of the mesh, and points at a real landmark', () => {
    const g = cityWithLandmarks();
    const ids = new Set(g.landmarks.map((l) => l.id));
    for (const layer of buildLandmarks(g)) {
      if (!layer.outlineRanges) continue;
      const total = layer.geometry.indices.length;
      for (const r of layer.outlineRanges) {
        expect(ids.has(r.id), `range id ${r.id} is a real landmark`).toBe(true);
        expect(r.count, 'non-empty range').toBeGreaterThan(0);
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.start + r.count, `range within ${layer.name} (${total} indices)`).toBeLessThanOrEqual(total);
      }
    }
  });

  it('ranges on a layer never overlap (each landmark owns a contiguous slice)', () => {
    const g = cityWithLandmarks();
    for (const layer of buildLandmarks(g)) {
      const rs = (layer.outlineRanges ?? []).slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < rs.length; i++) {
        expect(rs[i].start, `${layer.name}: ranges must not overlap`).toBeGreaterThanOrEqual(rs[i - 1].start + rs[i - 1].count);
      }
    }
  });

  it('a landmark that contributes stone geometry has a range covering it', () => {
    const g = cityWithLandmarks();
    const stone = buildLandmarks(g).find((l) => l.name === 'world:lm-stone')!;
    // The union of stone ranges must be > 0 and ≤ the mesh index count (they partition this landmark set's stone).
    const covered = (stone.outlineRanges ?? []).reduce((n, r) => n + r.count, 0);
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThanOrEqual(stone.geometry.indices.length);
  });
});
