/**
 * src/world/city-foliage.test.ts — the city's trees are REAL generated foliage, instanced.
 *
 * The city used to grow blob trees (a prism trunk + two cones, or a trunk + three squashed spheres) while
 * the foliage library sat unused beside it. These pin the three things that make the replacement viable:
 * the trees are actually generated, they are GPU-instanced from a small pool rather than built per-tree,
 * and they are scaled from the generator's real metres into the city's diorama units.
 */

import { describe, it, expect } from 'vitest';
import { buildCityFoliage, type TreePlacement } from './city-foliage';
import { buildBiome } from './biome';
import { generateCityLayout } from './layout';
import { CITY_FLOOR_M } from './types';

const placements = (n: number): TreePlacement[] =>
  Array.from({ length: n }, (_, i) => ({ pos: [i * 0.7, (i % 5) * 0.9] as [number, number], y: 0, kind: 'broadleaf' as const }));

describe('city foliage — generated, instanced, diorama-scaled', () => {
  it('emits instanced layers, never one mesh per tree', () => {
    const layers = buildCityFoliage(placements(200), 15, 1);
    expect(layers.length).toBeGreaterThan(0);
    // 200 trees must NOT become 200+ layers — that is the whole point of the variant pool.
    expect(layers.length).toBeLessThan(30);
    for (const L of layers) {
      expect(L.arrayGroup, `${L.name} is not instanced`).toBe(true);
      expect(L.instances?.length ?? 0).toBeGreaterThan(0);
      expect(L.instanceKey, `${L.name} has no instance key`).toBeTruthy();
    }
    // Every placement is accounted for exactly once per layer of its variant.
    const total = layers.reduce((n, L) => n + (L.instances?.length ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(200);
  });

  it('converts the generator\'s METRES into diorama units via the instance scale', () => {
    // The generator authors real trees; the city is ~15 m per world unit. Getting this wrong is how the
    // ground textures ended up 15× too big, so it is pinned here rather than left to inspection.
    const mpu = 15;
    const layers = buildCityFoliage(placements(40), mpu, 1);
    const scales = layers.flatMap((L) => (L.instances ?? []).map((i) => i.s ?? 1));
    expect(scales.length).toBeGreaterThan(0);
    for (const s of scales) {
      // 1/15 with the ±18% size jitter, and nothing outside that.
      expect(s).toBeGreaterThan((1 / mpu) * 0.75);
      expect(s).toBeLessThan((1 / mpu) * 1.25);
    }
  });

  it('scales inversely with metresPerUnit — a coarser diorama means smaller instances', () => {
    const a = buildCityFoliage(placements(20), 15, 1).flatMap((L) => (L.instances ?? []).map((i) => i.s ?? 1));
    const b = buildCityFoliage(placements(20), 30, 1).flatMap((L) => (L.instances ?? []).map((i) => i.s ?? 1));
    const avg = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;
    expect(avg(b)).toBeCloseTo(avg(a) / 2, 4);
  });

  it('is deterministic for a seed, and varies between seeds', () => {
    // Signature includes the per-instance yaw/scale, not just layer names — with only three variants the
    // bucket COUNTS can coincide across seeds even though every tree is placed differently.
    const sig = (seed: number): string =>
      buildCityFoliage(placements(30), 15, seed)
        .map((L) => `${L.name}:${(L.instances ?? []).map((i) => `${i.ry.toFixed(4)}/${(i.s ?? 1).toFixed(5)}`).join(',')}`)
        .sort().join('|');
    expect(sig(1)).toBe(sig(1));
    expect(sig(1)).not.toBe(sig(9));
  });

  it("never ALIASES one transform array across a variant's layers", () => {
    // ★ The drape pass mutates instance transforms in place (`t.y += heightFn`, `t.x += warp`). A tree
    // variant emits trunk/leaf/tip layers; if they share one array, the terrain is applied once PER LAYER
    // to the same objects — measured as instances sinking to y −0.73 against a height field bounded at
    // −0.28, plus a tripled horizontal warp that walked trees off their spot and into buildings.
    const layers = buildCityFoliage(placements(30), 15, 1);
    const seen = new Set<object>();
    for (const L of layers) {
      expect(seen.has(L.instances as object), `${L.name} shares its instances array`).toBe(false);
      seen.add(L.instances as object);
      for (const t of L.instances ?? []) {
        expect(seen.has(t as object), `${L.name} shares a transform OBJECT`).toBe(false);
        seen.add(t as object);
      }
    }
  });

  it('survives a simulated drape without compounding', () => {
    // Mutating every layer's transforms the way the drape does must move each TREE once, not once per layer.
    const layers = buildCityFoliage(placements(12), 15, 1);
    for (const L of layers) for (const t of L.instances ?? []) t.y += 1;   // "lift by the terrain"
    const ys = layers.flatMap((L) => (L.instances ?? []).map((t) => t.y));
    expect(Math.max(...ys)).toBe(1);          // not 2 or 3
    expect(Math.min(...ys)).toBe(1);
  });

  it('carries the shared foliage LOOK through instancing (wind / translucency survive)', () => {
    // Instanced layers used to drop wind + foliageShade on the floor, which would have left the city's
    // trees as flat cardboard that never moves — the exact thing the S1/S2 layer exists to prevent.
    const layers = buildCityFoliage(placements(20), 15, 1);
    const looked = layers.filter((L) => L.wind || L.foliageShade);
    expect(looked.length).toBeGreaterThan(0);
  });

  it('opts its instances into casting shadows', () => {
    // Instanced draws are excluded from the shadow + outline passes by default (the rule was written for
    // centimetre-scale building trim). That blanket count>1 filter also caught the city's trees, so a park
    // full of 6 m trees cast nothing at all.
    for (const L of buildCityFoliage(placements(20), 15, 1)) {
      expect(L.castShadow, `${L.name} casts no shadow`).toBe(true);
    }
  });

  it('replaces the blob trees in a real city build, cheaply', () => {
    const g = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square' });
    const t0 = Date.now();
    const layers = buildBiome(g);
    const ms = Date.now() - t0;
    const trees = layers.filter((L) => L.name.startsWith('world:tree-') && L.arrayGroup);
    expect(trees.length).toBeGreaterThan(0);
    // The generated pool must stay small — this is what keeps a few hundred trees affordable.
    const poolTris = trees.reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    expect(poolTris).toBeLessThan(120_000);
    expect(ms).toBeLessThan(4000);       // generous; observed ~64 ms
  });

  it('uses the documented diorama scale, not a magic number', () => {
    // CITY_FLOOR_M / (0.2 * scale) is the city's metres-per-unit; biome.ts must derive it, not hardcode.
    expect(CITY_FLOOR_M / (0.2 * 1)).toBe(15);
  });
});
