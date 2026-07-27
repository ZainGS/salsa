/**
 * src/world/city-materials.test.ts — the ONE-FAMILY-PER-MESH invariant, checked across a whole city.
 *
 * ★ WHY THIS EXISTS. `pattern`, `boardShade`, `ground`, `windSway`+`foliageShade`, `water`, `neon` and
 * `metal` all repurpose the SAME four instance floats (patternColor 48-51 / patternParams 52-55 — see the
 * MUTUALLY EXCLUSIVE notes throughout material-3d.ts). A mesh is exactly one of them. Setting two does not
 * layer two effects and does not error anywhere: the renderer writes whichever branch it reaches first and
 * the other is silently gone. There is no type-level guard, no runtime warning, and nothing on screen to
 * tell you which one you lost — the mesh just quietly renders as the wrong material.
 *
 * That is not hypothetical. A name-based classifier in `buildStreets` handed `metal` to every layer
 * matching /equip/ and /trim/, and those layers already carried a `grid` pattern — the panel seams on
 * rooftop plant and the glazing bars on window trim. 366k triangles of authored detail were being deleted,
 * through a green test suite and a clean build. This test would have caught it the moment it was written.
 */

import { describe, it, expect } from 'vitest';
import { buildCentreGroups } from './centre-build';
import type { LayoutPreviewLayer, LayoutParams } from './types';

const PARAMS = { seed: 3, radius: 10, pattern: 'grid', border: 'square' } as unknown as LayoutParams;

const cityLayers = (over: Partial<LayoutParams> = {}): LayoutPreviewLayer[] => {
  const res = buildCentreGroups({ ...PARAMS, ...over } as LayoutParams,
    { parkedTrain: false, activeRegions: null } as never) as unknown as
    { groups: Array<{ layers: LayoutPreviewLayer[] }> };
  return res.groups.flatMap((g) => g.layers);
};

/** Every layer field that rides the shared pattern instance slots. */
const SLOT_FAMILIES = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'] as const;

const familiesOn = (L: LayoutPreviewLayer): string[] =>
  SLOT_FAMILIES.filter((f) => (L as unknown as Record<string, unknown>)[f] != null);

describe('one material family per mesh — they all share the same four instance floats', () => {
  it('no city layer claims two slot-consuming families at once', () => {
    const clashes = cityLayers()
      .map((L) => ({ name: L.name, fams: familiesOn(L), tris: L.geometry.indices.length / 3 * (L.instances?.length ?? 1) }))
      .filter((r) => r.fams.length > 1);

    // Report the triangle cost too — it is the difference between a rounding error and 366k triangles of
    // pattern quietly replaced by a streak map.
    const lost = clashes.reduce((n, c) => n + c.tris, 0);
    expect(clashes.map((c) => `${c.name} claims [${c.fams.join(' + ')}] over ${Math.round(c.tris)} tris`),
      `${Math.round(lost)} triangles are rendering as the wrong material`).toEqual([]);
  });

  it('holds with detailed buildings OFF too — the classifier sees a different layer set', () => {
    // Flipping detailedBuildings changes which layers exist at all, so the invariant has to be checked on
    // both sides of that switch. The bug above only appeared once detail layers were in the set.
    const clashes = cityLayers({ detailedBuildings: false } as Partial<LayoutParams>)
      .filter((L) => familiesOn(L).length > 1)
      .map((L) => `${L.name} claims [${familiesOn(L).join(' + ')}]`);
    expect(clashes).toEqual([]);
  });

  it('the authored `grid` pattern on roof equipment and window trim SURVIVES', () => {
    // The specific detail the classifier ate. If a future rule reintroduces the clash these go empty
    // rather than merely flipping family, so assert they are still patterned and still present.
    const patterned = cityLayers().filter((L) => L.pattern && /equip|trim/.test(L.name));
    expect(patterned.length, 'roof-equip / trim lost their pattern').toBeGreaterThan(0);
    for (const L of patterned) expect(L.metal, `${L.name} took metal over its pattern`).toBeUndefined();
  });
});

describe('material coverage — a flat-shaded city is the thing being fixed', () => {
  it('leaves under 5% of the city on pure flat colour', () => {
    // Was 9.0% before the sweep; the remainder is awning fabric, road paint and small park props, which
    // are legitimately flat. This is a ratchet: it should keep falling, never climb back.
    const layers = cityLayers();
    let total = 0, flat = 0;
    for (const L of layers) {
      const t = L.geometry.indices.length / 3 * (L.instances?.length ?? 1);
      total += t;
      const shaded = familiesOn(L).length > 0 || L.glass || L.wind || L.leafCard || (L.emissive ?? 0) > 0;
      if (!shaded) flat += t;
    }
    expect(total).toBeGreaterThan(1e6);
    expect(flat / total, `${(flat / total * 100).toFixed(1)}% of the city is flat colour`).toBeLessThan(0.05);
  });
});
