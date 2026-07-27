/**
 * src/world/canal-bridge.test.ts — "the water fills the trench, and the deck reaches the bank".
 *
 * ★ THE BUG THIS PINS. A canal is one grid cell wide, but nothing that MATTERS is one cell wide.
 * `cellLevelAt` takes the minimum across a street band (`streetBandHalf`) so a terrace step can never rise
 * mid-carriageway — and at a canal edge that band resolves to the canal's own level, which means the
 * excavated trench (the hole cut in the road base, and the embankment wall that retains it) runs
 * `streetBandHalf` OUTSIDE the cell on every side. The water quad and the bridge deck were both still
 * built at raw cell width, so each bank had a bare strip ~20.6% of the span wide that you could see
 * straight through, and every bridge landed its abutments over open water.
 *
 * The lesson is that a cell index is not a distance. These tests therefore assert the RELATIONSHIP —
 * water covers everywhere the level says is water; the deck spans from land to land — instead of pinning
 * the constants, so they keep holding if streetBandHalf, the grid resolution or the street widths change.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildWater } from './water';
import { cellLevelAt, streetBandHalf } from './elevation';
import type { WorldGraph, V2 } from './types';

const canalCity = (seed: number): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6, canals: true } as never);

/** Seeds that actually produce a canal — a test over a city with no water proves nothing. */
const withCanals = (): WorldGraph[] => {
  const out: WorldGraph[] = [];
  for (let s = 1; s <= 14 && out.length < 4; s++) {
    const g = canalCity(s);
    if (g.levels?.some((col) => col.some((v) => v < 0))) out.push(g);
  }
  return out;
};

const inPoly = (pt: V2, poly: V2[]): boolean => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

/** The canal surface, recovered from the emitted layer's triangles as world-space polygons. */
const waterTris = (g: WorldGraph): V2[][] => {
  const L = buildWater(g).find((x) => x.name === 'world:canal');
  if (!L) return [];
  const v = L.geometry.vertices, idx = L.geometry.indices, out: V2[][] = [];
  for (let i = 0; i < idx.length; i += 3) {
    out.push([0, 1, 2].map((k) => [v[idx[i + k] * 12], v[idx[i + k] * 12 + 2]] as V2));
  }
  return out;
};

describe('the canal water covers the whole excavated trench', () => {
  it('finds cities with canals to test', () => {
    expect(withCanals().length).toBeGreaterThan(0);
  });

  it('every point the level system calls WATER has water drawn on it', () => {
    // This is the gap, stated directly: the road base is cut away wherever cellLevelAt < 0, so anywhere
    // that predicate is true and no water triangle covers it is a hole through the world.
    for (const g of withCanals()) {
      const R = g.radius;
      const uncovered: string[] = [];
      const tris = waterTris(g);
      expect(tris.length, 'no canal geometry emitted').toBeGreaterThan(0);
      for (let x = -R + 0.11; x < R; x += 0.19) {
        for (let z = -R + 0.13; z < R; z += 0.19) {
          if (cellLevelAt(g, x, z) >= 0) continue;
          if (!tris.some((t) => inPoly([x, z], t))) uncovered.push(`(${x.toFixed(2)}, ${z.toFixed(2)})`);
        }
      }
      expect(uncovered.slice(0, 6), `seed ${g.params.seed}: ${uncovered.length} trench points have no water`).toEqual([]);
    }
  });

  it('does not flood the LAND — the fix widens the canal, it does not drown the city', () => {
    // Guard against the lazy inverse: emitting one huge quad over the whole city would also pass above.
    // Water is allowed out to the trench edge (streetBandHalf past the cell), so probe well beyond that.
    for (const g of withCanals()) {
      const R = g.radius, slack = streetBandHalf(g.params) * 1.6;
      const tris = waterTris(g);
      let flooded = 0, dry = 0;
      for (let x = -R + 0.11; x < R; x += 0.19) {
        for (let z = -R + 0.13; z < R; z += 0.19) {
          // Only judge points comfortably clear of any water cell.
          if (cellLevelAt(g, x + slack, z) < 0 || cellLevelAt(g, x - slack, z) < 0) continue;
          if (cellLevelAt(g, x, z + slack) < 0 || cellLevelAt(g, x, z - slack) < 0) continue;
          if (cellLevelAt(g, x, z) < 0) continue;
          dry++;
          if (tris.some((t) => inPoly([x, z], t))) flooded++;
        }
      }
      expect(dry, 'no dry land sampled').toBeGreaterThan(50);
      expect(flooded, `seed ${g.params.seed}: water is drawn over ${flooded} dry-land points`).toBe(0);
    }
  });
});

describe('every bridge reaches dry land at both ends', () => {
  it('the deck spans past the water at BOTH abutments', () => {
    // The deck used to run cell edge to cell edge, i.e. exactly the water's old width — so once the trench
    // dilated, both abutments hung over open water. Walk the deck's long axis outward from the centre and
    // require that each end has actually made it onto ground the level system calls land.
    let checked = 0;
    for (const g of withCanals()) {
      for (const deck of g.bridges) {
        const xs = deck.map((p) => p[0]), zs = deck.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...zs) - Math.min(...zs);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        // The span is the LONG axis; the short axis is the carriageway width.
        const along: V2 = w >= h ? [1, 0] : [0, 1];
        const half = Math.max(w, h) / 2;
        // Probe a hair PAST the abutment, not exactly on it: a correct deck ends flush with the trench
        // edge, and cellLevelAt's band test is a strict `<`, so the boundary point itself is a coin flip.
        // 0.02 units is ~30 cm — far too small to mask the 0.374-unit (5.6 m) shortfall this test is for.
        const eps = 0.02;
        for (const sgn of [1, -1]) {
          const ex = cx + along[0] * (half + eps) * sgn, ez = cz + along[1] * (half + eps) * sgn;
          expect(cellLevelAt(g, ex, ez), `seed ${g.params.seed}: bridge end (${ex.toFixed(2)}, ${ez.toFixed(2)}) is over water`)
            .toBeGreaterThanOrEqual(0);
          checked++;
        }
      }
    }
    expect(checked, 'no bridges were exercised').toBeGreaterThan(0);
  });

  it('the span is the LONG axis — a deck must never build rotated 90°', () => {
    // addArchBridge picks its span direction with Math.max on the quad's two edge lengths, so a deck whose
    // carriageway is wider than its span would arch ALONG the road instead of across the canal. Widening
    // the span made that far less likely; this asserts it stays impossible rather than merely unlikely.
    for (const g of withCanals()) {
      for (const deck of g.bridges) {
        const xs = deck.map((p) => p[0]), zs = deck.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...zs) - Math.min(...zs);
        const span = Math.max(w, h), width = Math.min(w, h);
        expect(span, `seed ${g.params.seed}: deck ${span.toFixed(3)} x ${width.toFixed(3)} is not longer than it is wide`)
          .toBeGreaterThan(width * 1.15);
      }
    }
  });
});
