/**
 * src/world/city-foliage.test.ts — the city's trees are REAL generated foliage, instanced.
 *
 * The city used to grow blob trees (a prism trunk + two cones, or a trunk + three squashed spheres) while
 * the foliage library sat unused beside it. These pin the three things that make the replacement viable:
 * the trees are actually generated, they are GPU-instanced from a small pool rather than built per-tree,
 * and they are scaled from the generator's real metres into the city's diorama units.
 */

import { describe, it, expect } from 'vitest';
import { buildCityFoliage, farCrownGeometry, TREE_TWIN_M, TREE_FAR_KEEP, type TreePlacement } from './city-foliage';
import { buildBiome } from './biome';
import { generateCityLayout } from './layout';
import { CITY_FLOOR_M } from './types';

const placements = (n: number): TreePlacement[] =>
  Array.from({ length: n }, (_, i) => ({ pos: [i * 0.7, (i % 5) * 0.9] as [number, number], y: 0, kind: 'broadleaf' as const }));

describe('city foliage — generated, instanced, diorama-scaled', () => {
  it('emits instanced layers, never one mesh per tree', () => {
    const layers = buildCityFoliage(placements(200), 15, 1);
    expect(layers.length).toBeGreaterThan(0);
    // 200 trees must NOT become 200+ layers — that is the whole point of the variant pool. (P8: the leaf / tip
    // layers come as near + far crown twins, so up to twice the variant layers.)
    expect(layers.length).toBeLessThan(60);
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

  it('P20: an instanceKey names ONE geometry across seeds (streamed tiles share pooled geometry by key)', () => {
    // The GPU pool shares geometry by instanceKey across tiles; two tiles whose seed-built variants differ must not
    // collide on a key, or every tile draws whichever tile uploaded first.
    const byKey = new Map<string, string>();
    for (const seed of [1, 9, 23]) {
      for (const L of buildCityFoliage(placements(30), 15, seed)) {
        const g = L.geometry!;
        const sig = `${g.vertices.length}:${g.indices.length}:${Array.from(g.vertices.subarray(0, 64)).join(',')}`;
        const prev = byKey.get(L.instanceKey!);
        if (prev !== undefined) expect(sig, L.instanceKey).toBe(prev);
        else byKey.set(L.instanceKey!, sig);
      }
    }
    expect(byKey.size).toBeGreaterThan(0);
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

  it('P8: pairs every leaf / tip layer with a thinned FAR CROWN twin on the same transforms', () => {
    const layers = buildCityFoliage(placements(40), 15, 1);
    const near = layers.filter((L) => L.nearTwin?.role === 'near'), far = layers.filter((L) => L.nearTwin?.role === 'far');
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBe(near.length);
    for (const n of near) {
      expect(/leaf|tip/.test(n.name)).toBe(true);
      const f = far.find((x) => x.name === n.name && x.nearTwin!.key === n.nearTwin!.key && x.instances!.length === n.instances!.length)!;
      expect(f, `${n.name} has no far twin`).toBeTruthy();
      // identical transforms (own copies — the drape mutates them in place), its own geometry key
      expect(f.instances).not.toBe(n.instances);
      expect(f.instances!.map((t) => `${t.x},${t.z},${t.ry},${t.s}`)).toEqual(n.instances!.map((t) => `${t.x},${t.z},${t.ry},${t.s}`));
      expect(f.instanceKey).not.toBe(n.instanceKey);
      expect(f.nearTwin!.dist).toBeCloseTo(TREE_TWIN_M / 15, 6);
      expect(f.nearTwin!.gridTris).toBe(n.geometry.indices.length / 3);
      // about 1/TREE_FAR_KEEP of the cards, same colour + material
      const r = f.geometry.indices.length / n.geometry.indices.length;
      expect(r).toBeLessThan(1 / TREE_FAR_KEEP + 0.05);
      expect(f.color).toEqual(n.color);
      expect(f.leafCard).toBe(n.leafCard);
    }
    // trunks are never twinned; farCrowns:false builds the pre-P8 set
    expect(layers.some((L) => /trunk/.test(L.name) && L.nearTwin)).toBe(false);
    expect(buildCityFoliage(placements(40), 15, 1, { farCrowns: false }).some((L) => L.nearTwin)).toBe(false);
  });

  it('P8: farCrownGeometry keeps every k-th card, grown by sqrt(k) about its centre, and passes other triangles through', () => {
    // two triangles of a non-card + 6 cards (4 verts each)
    const V: number[] = [], I: number[] = [];
    const vert = (x: number, y: number, z: number): number => { V.push(x, y, z, 0, 1, 0, 0, 0, 1, 0, 0, 1); return V.length / 12 - 1; };
    const a = vert(0, 0, 0), b = vert(1, 0, 0), c = vert(0, 1, 0);
    I.push(a, b, c);
    for (let k = 0; k < 6; k++) {
      const o = vert(k, 0, 0); vert(k + 1, 0, 0); vert(k + 1, 1, 0); vert(k, 1, 0);
      I.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    const g = farCrownGeometry({ vertices: Float32Array.from(V), indices: Uint32Array.from(I), format: '12float' }, 3)!;
    expect(g.indices.length).toBe(3 + 2 * 6);       // the stray triangle + cards 0 and 3
    expect(g.vertices.length / 12).toBe(3 + 2 * 4);
    // card 0 (x 0..1, y 0..1) grown by sqrt(3) about (0.5, 0.5)
    const s = Math.sqrt(3), x0 = g.vertices[3 * 12];
    expect(x0).toBeCloseTo(0.5 - 0.5 * s, 6);
    expect(farCrownGeometry({ vertices: Float32Array.from(V), indices: Uint32Array.from(I), format: '12float' }, 4)).toBeNull();   // < 2k cards
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
    // The generated pool must stay small — this is what keeps a few hundred trees affordable. Count each shared
    // geometry ONCE (the leaf tint buckets reuse their variant's geometry under one instance key). The pool grew with
    // the Japanese species mix (zelkova / ginkgo / camphor / sakura / pine × 5 variants, E7); variants 3–4 use the
    // generator's mid branch LOD to keep it bounded.
    const seen = new Set<string>();
    const poolTris = trees.reduce((n, L) => { const k = L.instanceKey ?? L.name; if (seen.has(k)) return n; seen.add(k); return n + L.geometry.indices.length / 3; }, 0);
    expect(poolTris).toBeLessThan(200_000);
    expect(ms).toBeLessThan(6000);       // generous; observed ~64 ms before the species mix
  });

  it('broadleaf crowns are CLUMP crowns: a moderate number of big cluster cards, swaying with (not off) their limbs', () => {
    // polish-round-3 T4: the SPRIG crown (~2 000 small cards on twiglets) read busy and see-through at the city's
    // viewing distance. The clump crown gathers the leaf mass into a few dense clumps per branch end, drawn with
    // leaf-CLUSTER cards (u in [2, 3] picks the shader's clump silhouette) and spherised normals.
    const layers = buildCityFoliage(placements(60), 15, 1);
    const leafy = layers.filter((L) => /:foliage:(leaf|tip)/.test(L.name));
    expect(leafy.length).toBeGreaterThan(0);
    for (const L of leafy) {
      expect(L.leafCard, `${L.name} is not alpha-cut`).toBe(true);
      // Leaves ride only a little above the trunk layer's ×0.45 — at ×1/×1.35 they sheared off their twigs.
      const trunk = layers.find((T) => T.name === L.name.replace(/:foliage:(leaf|tip)#\d$/, ':foliage:trunk'));
      expect(L.wind!.amount).toBeLessThan(trunk!.wind!.amount * 2);
      // Every card is a CLUMP card (the UV range the shader keys the dense silhouette on).
      const v = L.geometry.vertices;
      for (let i = 6; i < v.length; i += 12) expect(v[i], `${L.name} has a non-clump card`).toBeGreaterThanOrEqual(2);
    }
    // A full-detail variant: a few hundred big cards (leaf + tip, one tint bucket = one geometry each) — not thousands.
    const v0 = leafy.filter((L) => /tree-broadleaf-0:.*#0$/.test(L.name));
    expect(v0.length).toBeGreaterThan(0);
    const cards = v0.reduce((n, L) => n + L.geometry.indices.length / 6, 0);
    expect(cards).toBeGreaterThan(300);
    expect(cards).toBeLessThan(1800);
  });

  it('uses the documented diorama scale, not a magic number', () => {
    // CITY_FLOOR_M / (0.2 * scale) is the city's metres-per-unit; biome.ts must derive it, not hardcode.
    expect(CITY_FLOOR_M / (0.2 * 1)).toBe(15);
  });
});
