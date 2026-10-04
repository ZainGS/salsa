import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { assignDrawDistances, cityDrawDistance, cityDrawDistanceBias, cityShadowFeatureSize, cityTwinDistance, distanceTierKind } from './view-cull';
import { PROP_TWIN_M } from '../../world/lod-accum';

// polish-round-3 R6.1: the per-chunk DISTANCE LOD tier membership — the same names the zoom tiers use.

const F = 10;
const tiers = WorldManager.cityDistanceTiers(F);
const fine = F * WorldManager.DIST_LOD_FINE;

describe('city distance-LOD tiers (R6.1)', () => {
  it('puts fine detail, roof objects, props and flat-map layers in their tiers', () => {
    expect(cityDrawDistance('world:detail-juliet', tiers)).toBeCloseTo(fine);
    expect(cityDrawDistance('world:traffic-walker-skin', tiers)).toBeCloseTo(fine);
    expect(cityDrawDistance('world:ped-shirt', tiers)).toBeCloseTo(fine);
    expect(cityDrawDistance('world:detail-sign-text', tiers)).toBeCloseTo(fine);   // lettering: claimed before STRUCTURE
    expect(cityDrawDistance('world:roof-equip', tiers)).toBeCloseTo(fine * 1.25);
    expect(cityDrawDistance('world:tree-camphor-0:foliage:leaf', tiers)).toBeCloseTo(F * 1.2);
    expect(cityDrawDistance('world:car-chrome', tiers)).toBeCloseTo(F * 1.2);
    expect(cityDrawDistance('world:sidewalks', tiers)).toBeCloseTo(F * 1.4);
  });

  it('P7: sub-metre clutter takes the fine distance and NO aerial bias; facade detail and trees keep the bias', () => {
    for (const n of ['world:signal-housing', 'world:util-pole-insulator', 'world:car-trim', 'world:tactile', 'world:guardrail-bollard', 'world:tree-grate'])
      expect(cityDrawDistance(n, tiers)).toBeCloseTo(fine);
    expect(cityDrawDistance('world:vending-stock-2', tiers)).toBeCloseTo(fine * WorldManager.DIST_LOD_CANS);
    expect(cityDrawDistance('world:contact-shadow', tiers)).toBeCloseTo(F * 1.2);
    for (const n of ['world:ped-skin', 'world:traffic-walker-top', 'world:util-wire', 'world:rail-fine-sleepers', 'world:signal-housing', 'world:vending-stock-0'])
      expect(cityDrawDistanceBias(n, tiers)).toBe(WorldManager.DIST_LOD_TINY_BIAS);
    for (const n of ['world:detail-windowtrim', 'world:detail-juliet', 'world:detail-sign-text', 'world:textsign-shop3', 'world:tree-camphor-0:foliage:leaf', 'world:car-white', 'world:sidewalks', 'world:roof-equip'])
      expect(cityDrawDistanceBias(n, tiers)).toBe(1);
    const leaf = { name: 'world:ped-skin', drawDistance: 0, drawDistanceBias: 1 };
    assignDrawDistances([leaf], tiers);
    expect(leaf.drawDistanceBias).toBe(WorldManager.DIST_LOD_TINY_BIAS);
    assignDrawDistances([leaf], []);
    expect(leaf.drawDistanceBias).toBe(1);
  });

  it('P8: the sub-metre classes carry a shadow feature size (world units); everything else casts in every map', () => {
    const upm = 1 / 15, T = WorldManager.cityDistanceTiers(F, upm), sf = WorldManager.SHADOW_FEATURE_M;
    expect(cityShadowFeatureSize('world:vending-stock-1', T)).toBeCloseTo(sf.cans * upm);
    for (const n of ['world:ped-skin', 'world:traffic-walker-top']) expect(cityShadowFeatureSize(n, T)).toBeCloseTo(sf.crowd * upm);
    for (const n of ['world:util-wire', 'world:detail-railing-steel']) expect(cityShadowFeatureSize(n, T)).toBeCloseTo(sf.tiny * upm);
    for (const n of ['world:signal-housing', 'world:util-pole-insulator', 'world:car-trim', 'world:bench']) expect(cityShadowFeatureSize(n, T)).toBeCloseTo(sf.small * upm);
    for (const n of ['world:util-pole', 'world:lightpoles']) expect(cityShadowFeatureSize(n, T)).toBeCloseTo(sf.thin * upm);
    for (const n of ['world:tree-camphor-0:foliage:leaf', 'world:car-white', 'world:roof-equip', 'world:buildings', 'world:detail-juliet'])
      expect(cityShadowFeatureSize(n, T)).toBe(0);
    expect(cityShadowFeatureSize('world:ped-skin', tiers)).toBe(0);   // no scale given → no shadow LOD
    const m = { name: 'world:signal-housing', drawDistance: 0, drawDistanceBias: 1, shadowFeatureSize: 0 };
    assignDrawDistances([m], T);
    expect(m.shadowFeatureSize).toBeCloseTo(sf.small * upm);
    assignDrawDistances([m], []);
    expect(m.shadowFeatureSize).toBe(0);
  });

  it('never distance-hides structure, massing or the lit layers', () => {
    for (const n of ['world:rail-viaduct', 'world:bridge-stone', 'world:lm-glass', 'world:roads', 'world:buildings',
      'world:roofs', 'world:lamplights', 'world:rail-train', 'world:ground']) expect(cityDrawDistance(n, tiers)).toBe(0);
  });

  it('stamps a matched group\'s whole subtree and clears everything outside a tier', () => {
    const leaf = (name: string) => ({ name, drawDistance: 99 });
    const trees = { name: 'world:tree-zelkova-0', children: [leaf('trunk'), leaf('leaf')] };
    const roads = leaf('world:roads');
    const nested = { name: 'City', children: [{ name: 'Layer', children: [leaf('world:detail-door#3')] }] };
    const n = assignDrawDistances([trees, roads, nested], tiers);
    expect(n).toBe(3);
    expect(trees.children.map((c) => c.drawDistance)).toEqual([F * 1.2, F * 1.2]);
    expect(roads.drawDistance).toBe(0);
    expect((nested.children[0].children[0] as { drawDistance: number }).drawDistance).toBeCloseTo(fine);
    // disabled (no tiers) → everything back to 0
    assignDrawDistances([trees, roads, nested], []);
    expect(trees.children[0].drawDistance).toBe(0);
  });

  it('P9: the prop twin swap distances are registered as twin tiers (metres × units per metre), separate from the draw tiers', () => {
    const u = 1 / 15, T = WorldManager.cityDistanceTiers(F, u);
    for (const [n, m] of [['world:util-pole', PROP_TWIN_M.pole], ['world:util-pole-insulator', PROP_TWIN_M.pole], ['world:signal-housing', PROP_TWIN_M.signal],
      ['world:lightpoles', PROP_TWIN_M.lamp], ['world:detail-roof-equip#2_3', PROP_TWIN_M.roofEquip], ['world:car-trim', PROP_TWIN_M.carTrim],
      ['world:veh-chrome', PROP_TWIN_M.carTrim]] as [string, number][]) {
      expect(cityTwinDistance(n, T, 'twin')).toBeCloseTo(m * u, 9);
      expect(cityDrawDistance(n, T)).toBe(cityDrawDistance(n, tiers));   // the draw distance is unchanged by the twin tier
    }
    expect(T.filter((t) => distanceTierKind(t) === 'twin').length).toBeGreaterThanOrEqual(5);
    // the traffic cars' trim + chrome take the small-props distance (no aerial bias)
    expect(cityDrawDistance('world:veh-trim', T)).toBeCloseTo(fine);
    expect(cityDrawDistanceBias('world:veh-chrome', T)).toBe(WorldManager.DIST_LOD_TINY_BIAS);
    // the stamp: twin meshes take their swap distance from the tier, other meshes are untouched
    const near = { name: 'world:util-pole', drawDistance: 0, lodTwinRole: 1, lodTwinDist: 123 };
    const plain = { name: 'world:util-pole', drawDistance: 0, lodTwinDist: 7 };
    assignDrawDistances([near, plain], T);
    expect(near.lodTwinDist).toBeCloseTo(PROP_TWIN_M.pole * u, 9);
    expect(plain.lodTwinDist).toBe(7);
    expect(near.drawDistance).toBeCloseTo(F * 1.2);
  });
});
