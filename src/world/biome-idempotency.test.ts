/**
 * src/world/biome-idempotency.test.ts — selective-regen idempotency for biome scatter (audit §2.2).
 *
 * buildBiome used to consume one composer-level RNG in filtered lot-visit order, so editing one active region
 * reshuffled park trees / rocks / garden trees everywhere else. Each lot's scatter is now drawn from a per-lot
 * POSITION-HASH stream, so a region-filtered rebuild is a strict SUBSET of the full build: every rock the filtered
 * pass emits is byte-identical to the one the full pass emitted for the same lot. This test pins that — it would
 * fail the moment biome slips back to a shared-stream (visit-order-dependent) scatter.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildBiome } from './biome';
import type { WorldGraph } from './types';

const graph: WorldGraph = generateCityLayout({ seed: 7, radius: 200, pattern: 'grid', elevation: 0 });

/** The merged 'world:rocks' layer's vertices as a set of stringified rows (stride-12 mesh vertices; position first). */
function rockRows(g: WorldGraph, keep?: ((r: number) => boolean) | null): Set<string> {
  const layer = buildBiome(g, keep).find((l) => l.name === 'world:rocks');
  const rows = new Set<string>();
  if (!layer) return rows;
  const v = layer.geometry.vertices;
  for (let i = 0; i < v.length; i += 12) rows.add(`${v[i]},${v[i + 1]},${v[i + 2]}`);
  return rows;
}

describe('biome scatter — selective-regen idempotency', () => {
  const regions = [...new Set(graph.blocks.map((b) => b.region ?? -1).filter((r) => r >= 0))];

  it('the fixture has parks and multiple regions (else the test proves nothing)', () => {
    expect(regions.length).toBeGreaterThan(1);
    expect(rockRows(graph, null).size).toBeGreaterThan(0);
  });

  it('is deterministic — a full build repeated is byte-identical', () => {
    expect([...rockRows(graph, null)]).toEqual([...rockRows(graph, null)]);
  });

  it('a region-filtered rebuild is a strict subset of the full build (no scatter reshuffles elsewhere)', () => {
    const full = rockRows(graph, null);
    // Keep only the first half of the regions — the classic active-region edit.
    const kept = new Set(regions.slice(0, Math.max(1, Math.floor(regions.length / 2))));
    const filtered = rockRows(graph, (r) => kept.has(r));
    expect(filtered.size).toBeGreaterThan(0);
    for (const row of filtered) expect(full.has(row)).toBe(true);
    // And the filtered set is a PROPER subset — filtering really did drop some regions' rocks.
    expect(filtered.size).toBeLessThan(full.size);
  });

  it('two DIFFERENT region filters agree on their shared region (order-independent scatter)', () => {
    if (regions.length < 3) return;
    const rShared = regions[0];
    const a = rockRows(graph, (r) => r === rShared || r === regions[1]);
    const b = rockRows(graph, (r) => r === rShared || r === regions[2]);
    // Every rock that both filters must contain (the shared region's) appears identically in both. Concretely:
    // the full build's rocks intersected with each filter — the shared-region rows are common to both sets.
    const full = rockRows(graph, (r) => r === rShared);
    for (const row of full) {
      expect(a.has(row)).toBe(true);
      expect(b.has(row)).toBe(true);
    }
  });
});
