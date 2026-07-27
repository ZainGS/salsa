/**
 * src/world/city-ground.test.ts — the CITY ↔ procedural-ground wiring.
 *
 * Until this pass the 13-surface material library reached nothing the world generator produced: roads,
 * pavements and parks were flat colours with a `pattern` motif over them. These pin the wiring so it can't
 * silently regress to that — a layer quietly losing its `ground` field would look like "the city got a bit
 * flatter", which is exactly the kind of change nobody notices in a diff.
 */

import { describe, it, expect } from 'vitest';
import { buildLayoutPreview } from './preview';
import { generateCityLayout } from './layout';
import { GROUND_SURFACES, resolveGroundRecipe } from './ground-surfaces';
import type { LayoutPreviewLayer } from './types';

// A radial layout with a generous central plaza, so the plaza layer is actually emitted — the default
// params can zone it away, and a test that silently skips its most important case is worse than no test.
const build = (): LayoutPreviewLayer[] =>
  buildLayoutPreview(generateCityLayout({ seed: 7, radius: 120, sidewalks: true, pattern: 'radial', plazaRadius: 0.16 }));

const byName = (layers: LayoutPreviewLayer[], name: string): LayoutPreviewLayer | undefined =>
  layers.find((l) => l.name === name);

describe('city ground — every walkable/drivable surface is a real material', () => {
  const layers = build();

  it('emits the ground layers this wiring depends on', () => {
    for (const n of ['world:roads', 'world:sidewalks', 'world:plaza']) {
      expect(byName(layers, n), `missing ${n}`).toBeDefined();
    }
  });

  it('maps each ground layer to the surface that matches what it IS', () => {
    const expected: Record<string, string> = {
      'world:roads': 'asphalt',
      'world:sidewalks': 'concrete',
      'world:courtyard': 'cobble',
      'world:plaza': 'ashlar',
      'world:park': 'grass',
    };
    for (const [name, surface] of Object.entries(expected)) {
      const L = byName(layers, name);
      if (!L) continue;                                   // courtyard/park depend on the seed's zoning
      expect(L.ground?.surface, name).toBe(surface);
    }
  });

  it('never sets both `ground` and `pattern` — they ride the same instance slots', () => {
    for (const L of layers) {
      if (L.ground) expect(L.pattern, `${L.name} has both`).toBeUndefined();
    }
  });

  it('only uses surfaces that exist in the library', () => {
    for (const L of layers) {
      if (!L.ground) continue;
      expect(Object.keys(GROUND_SURFACES), L.name).toContain(L.ground.surface);
    }
  });

  it('keeps the palette in charge of colour, so styles/seasons still drive the city', () => {
    // The material supplies detail; the zone colour supplies identity. A ground layer that dropped its
    // tint would snap to the library's own colour and flatten the map's zone readability.
    for (const L of layers) {
      if (!L.ground) continue;
      expect(L.ground.tint, `${L.name} lost its palette tint`).toBeDefined();
      expect(L.ground.tint).toEqual(L.color);
    }
  });

  it('resolves every city surface to a shader-ready recipe', () => {
    for (const L of layers) {
      if (!L.ground) continue;
      const r = resolveGroundRecipe(L.ground.surface, { tileMm: L.ground.tileMm, tint: L.ground.tint });
      expect(r.mode, L.name).toBeGreaterThanOrEqual(0);
      expect(r.mode, L.name).toBeLessThanOrEqual(8);
      expect(Number.isFinite(r.groutM), L.name).toBe(true);
      expect(r.tile.every((v) => Number.isFinite(v)), L.name).toBe(true);
    }
  });

  it('sizes pavement slabs for a footway, not a road pour', () => {
    // The library default is a 3 m slab (a road pour). At walking scale a pavement needs ~1.2 m or the
    // joints vanish and it reads as poured tarmac.
    const sw = byName(layers, 'world:sidewalks');
    expect(sw?.ground?.tileMm).toBeLessThanOrEqual(1500);
    expect(resolveGroundRecipe('concrete', { tileMm: sw?.ground?.tileMm }).tile[0]).toBeLessThanOrEqual(1.5);
  });
});
