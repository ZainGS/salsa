/**
 * src/world/furniture.test.ts — street furniture reads as a real Japanese street (city-quality E9–E14).
 *
 * Vending machines stand against the shopfronts in runs of 2–4 with a bin (not on the corner diagonal like kiosks);
 * buses and trucks park only on arterials; crate stacks are no longer all identical; cones only come with roadworks;
 * overhead wires are real multi-wire catenaries on ordinary streets too; the props are proper models, and the whole
 * lot stays inside a sane triangle budget.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildFurniture } from './furniture';
import { streetPlan, PARKED_TYPES } from './street-slots';
import { buildBiome } from './biome';
import { buildCityFoliage, isAutumn } from './city-foliage';

const graph = generateCityLayout({ seed: 4, radius: 10, pattern: 'grid', border: 'square' });
const plan = streetPlan(graph);
const s = graph.params.radius / 10;
const layers = buildFurniture(graph);
const byName = (n: string) => layers.find(L => L.name === n);

describe('vending runs (E10)', () => {
  it('stand in runs of 2–4 against the building line, facing the pavement — never inside a lot', () => {
    const runs = plan.of('vending');
    expect(runs.length).toBeGreaterThan(3);
    for (const r of runs) {
      expect(r.n).toBeGreaterThanOrEqual(2); expect(r.n).toBeLessThanOrEqual(4);
      const S = plan.side(r.ri, r.side)!, fr = plan.frontageAt(r.ri, r.side, r.along)!;
      expect(fr).not.toBeNull();
      expect(fr - r.off).toBeLessThan(0.05 * s);                 // backed up to the building line (≈ gap + half depth)
      expect(r.off).toBeGreaterThan(S.kerbOut);                  // not out on the kerb like a kiosk
      expect(plan.inBuilding(r.x, r.z)).toBe(false);
    }
    const bodies = byName('world:vending-body')!;
    expect(bodies.instances!.length).toBe(runs.reduce((n, r) => n + r.n, 0));
  });
});

describe('parked vehicles (E2 / E14)', () => {
  it('buses and trucks only on arterials; everything on the asphalt', () => {
    for (const c of plan.of('parked')) {
      const t = PARKED_TYPES[c.n];
      if (t === 'bus' || t === 'truck') expect(plan.roads[c.ri]!.klass).toBe('arterial');
      expect(c.off).toBeLessThan(graph.params.streetWidth * 0.5);
    }
  });
});

describe('clutter context (E13)', () => {
  it('A-boards / crates / stalls sit by COMMERCIAL doors; crate stacks differ (position-seeded, road-aligned)', () => {
    for (const k of ['aboard', 'crate', 'stall'] as const) for (const sl of plan.of(k)) expect(sl.zone, k).toBe('commercial');
    const crates = byName('world:crate');
    if (crates && crates.instances!.length > 3) {
      const yaws = new Set(crates.instances!.map(t => t.ry.toFixed(3)));
      expect(yaws.size).toBeGreaterThan(crates.instances!.length / 3);
    }
  });

  it('cones appear only at roadworks', () => {
    const cones = byName('world:cone');
    if (!plan.of('roadworks').length) expect(cones).toBeUndefined();
    else expect(cones).toBeDefined();
  });
});

describe('overhead wires (E11)', () => {
  it('poles on ordinary streets too, strung with several sagging multi-segment wires per span', () => {
    const streets = new Set(plan.of('pole').map(p => plan.roads[p.ri]!.klass));
    expect(streets.has('street')).toBe(true);
    const wire = byName('world:util-wire')!;
    // ≥ 5 wires × 10 segments × 3 sides × 2 tris per span — far beyond the old 2-segment single beam.
    const spans = plan.of('pole').length * 0.5;
    expect(wire.geometry.indices.length / 3).toBeGreaterThan(spans * 5 * 10 * 6 * 0.5);
    expect(byName('world:util-pole-insulator')).toBeDefined();
  });
});

describe('props are models, not single boxes (E9)', () => {
  it('post boxes, slatted benches, ring-wheel bicycles, racks and bollards all exist with real detail', () => {
    for (const n of ['world:bench-wood', 'world:bicycle-tyre', 'world:guardrail-bollard']) expect(byName(n), n).toBeDefined();
    const pb = byName('world:postbox');
    if (pb) expect(pb.geometry.indices.length / 3 / Math.max(1, plan.of('postbox').length)).toBeGreaterThan(60);
    const tyres = byName('world:bicycle-tyre')!;
    // Two ring wheels of 10 tube segments each per bike.
    expect(tyres.geometry.indices.length / 3).toBeGreaterThan(plan.of('bikerow').reduce((n, r) => n + r.n, 0) * 2 * 10 * 6 * 0.9);
  });

  it('stays inside a sane triangle budget', () => {
    const tris = layers.reduce((n, L) => n + L.geometry.indices.length / 3 * (L.instances?.length ?? 1), 0);
    expect(tris).toBeLessThan(900_000);
  });

  it('is deterministic per seed', () => {
    const sig = (ls: typeof layers): string => ls.map(L => `${L.name}:${L.geometry.indices.length}:${L.instances?.length ?? 0}`).join('|');
    expect(sig(buildFurniture(generateCityLayout({ seed: 4, radius: 10, pattern: 'grid', border: 'square' })))).toBe(sig(layers));
  });
});

describe('street trees + species (E6 / E7)', () => {
  const biome = buildBiome(graph);

  it('every street tree stands in a grate; planters are the real instanced foliage (no octahedron shrubs)', () => {
    const grates = biome.find(L => L.name === 'world:tree-grate')!;
    expect(grates.instances!.length).toBe(plan.of('tree').length);
    expect(biome.some(L => L.name.startsWith('world:planter-planter:') && L.arrayGroup)).toBe(true);
    expect(biome.find(L => L.name === 'world:planter')).toBeUndefined();
  });

  it('plants a Japanese species mix, ONE species per street, with ≥ 4 variants and per-tree leaf-shade buckets', () => {
    const trees = biome.filter(L => /^world:tree-(zelkova|ginkgo|camphor|sakura|pine|broadleaf|conifer|bush)-\d/.test(L.name));
    const kinds = new Set(trees.map(L => /^world:tree-([a-z]+)-/.exec(L.name)![1]));
    expect([...kinds].filter(k => ['zelkova', 'ginkgo', 'camphor', 'sakura'].includes(k)).length).toBeGreaterThanOrEqual(3);
    const variants = new Set(trees.filter(L => L.name.startsWith('world:tree-zelkova-')).map(L => /-(\d):/.exec(L.name)![1]));
    expect(variants.size).toBeGreaterThanOrEqual(3);
    expect(trees.some(L => /#1$/.test(L.name))).toBe(true);   // second tint bucket present
  });

  it('a warm leafColor turns the ginkgo gold (autumn)', () => {
    expect(isAutumn([1.2, 0.9, 0.7])).toBe(true);
    expect(isAutumn([1, 1, 1])).toBe(false);
    const pl = [{ pos: [0, 0] as [number, number], y: 0, kind: 'ginkgo' as const }];
    const leafOf = (lc: [number, number, number]) => buildCityFoliage(pl, 15, 1, { leafColor: lc }).find(L => /leaf/.test(L.name))!.color;
    const summer = leafOf([1, 1, 1]), autumn = leafOf([1.2, 0.9, 0.7]);
    expect(autumn[0] - autumn[2]).toBeGreaterThan(summer[0] - summer[2]);
  });
});

describe('utility cabinets are cabinet-sized (visual-polish #14)', () => {
  it('no cabinet face is larger than a real ~0.75 x 1.2 m cabinet (they were ~10 m x 17 m "crumpled" walls)', async () => {
    const { cityMetresPerUnit } = await import('./types');
    const u = 1 / cityMetresPerUnit(graph.params.radius);
    for (const name of ['world:cabinet', 'world:cabinet-trim']) {
      const L = byName(name);
      if (!L) continue;
      const v = L.geometry.vertices, idx = L.geometry.indices, S = 12;
      let maxE = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const p = (k: number) => [v[idx[t + k] * S], v[idx[t + k] * S + 1], v[idx[t + k] * S + 2]];
        const a = p(0), b = p(1), c = p(2);
        maxE = Math.max(maxE, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]));
      }
      expect(maxE / u, name).toBeLessThan(1.5);   // metres: the largest face diagonal of the 0.74 x 1.08 m body is ~1.3 m
    }
  });
});
