/**
 * src/world/terrace-roads.test.ts — "a terrace step must never cut a road".
 *
 * The city's streets are the gaps BETWEEN lots, so they straddle the grid cell boundaries. `cellLevelAt`
 * used to do a raw per-cell lookup, which stepped the ground up along the middle of a carriageway — and
 * `terraces.ts` then built a retaining wall with a staircase straight across the road. Stairs belong at a
 * kerb, climbing from the pavement onto a raised block; they never belong in a carriageway.
 */

import { describe, it, expect } from 'vitest';
import { cellLevelAt, terraceStep, streetBandHalf } from './elevation';
import { buildTerraces, STAIR } from './terraces';
import { cityMetresPerUnit } from './types';
import { generateCityLayout } from './layout';
import type { WorldGraph } from './types';

const grid = (seed: number): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6 });

/** Every (cell boundary, level pair) where the two sides disagree — the places a step can happen. */
const boundaries = (g: WorldGraph): Array<{ x: number; z: number; axis: 'x' | 'z' }> => {
  const out: Array<{ x: number; z: number; axis: 'x' | 'z' }> = [];
  const R = g.radius, cols = g.params.gridCols, rows = g.params.gridRows;
  const cw = 2 * R / cols, ch = 2 * R / rows;
  const lv = g.levels;
  if (!lv) return out;
  for (let ci = 0; ci < cols - 1; ci++) {
    for (let ri = 0; ri < rows - 1; ri++) {
      const here = lv[ci]?.[ri] ?? 0;
      if ((lv[ci + 1]?.[ri] ?? 0) !== here) out.push({ x: -R + (ci + 1) * cw, z: -R + (ri + 0.5) * ch, axis: 'x' });
      if ((lv[ci]?.[ri + 1] ?? 0) !== here) out.push({ x: -R + (ci + 0.5) * cw, z: -R + (ri + 1) * ch, axis: 'z' });
    }
  }
  return out;
};

describe('terrace steps never cut a carriageway', () => {
  it('produces level boundaries to test (otherwise the test proves nothing)', () => {
    const found = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => boundaries(grid(s)).length).reduce((a, b) => a + b, 0);
    expect(found).toBeGreaterThan(0);
  });

  it('keeps the ground level CONSTANT right across every street band', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = grid(seed);
      const half = Math.max(g.params.streetWidth, g.params.arterialWidth ?? 0) * 0.5;
      for (const b of boundaries(g)) {
        // Sample across the road, from one kerb to the other. Every sample must agree: a difference here
        // is a step in the middle of the carriageway.
        const samples: number[] = [];
        for (let t = -0.92; t <= 0.92; t += 0.23) {
          const off = t * half;
          samples.push(b.axis === 'x' ? cellLevelAt(g, b.x + off, b.z) : cellLevelAt(g, b.x, b.z + off));
        }
        const flat = samples.every((v) => v === samples[0]);
        expect(flat, `seed ${seed}: street at (${b.x.toFixed(2)}, ${b.z.toFixed(2)}) steps mid-carriageway: ${samples.join(',')}`).toBe(true);
      }
    }
  });

  it('still steps SOMEWHERE — the fix flattens roads, it does not flatten the city', () => {
    // Guard against the lazy "fix": clamping every level to 0 would also pass the test above.
    let stepped = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = grid(seed);
      const R = g.radius;
      const seen = new Set<number>();
      for (let x = -R + 0.5; x < R; x += 0.7) for (let z = -R + 0.5; z < R; z += 0.7) seen.add(cellLevelAt(g, x, z));
      if (seen.size > 1) stepped++;
    }
    expect(stepped).toBeGreaterThan(0);
    expect(terraceStep({ ...grid(1).params })).toBeGreaterThan(0);
  });

  it('takes the LOWER level in the street band, so a road never floats above its neighbours', () => {
    for (const seed of [1, 2, 3]) {
      const g = grid(seed);
      const half = Math.max(g.params.streetWidth, g.params.arterialWidth ?? 0) * 0.5;
      for (const b of boundaries(g)) {
        const mid = b.axis === 'x' ? cellLevelAt(g, b.x, b.z) : cellLevelAt(g, b.x, b.z);
        const lo = b.axis === 'x' ? cellLevelAt(g, b.x - half * 2.2, b.z) : cellLevelAt(g, b.x, b.z - half * 2.2);
        const hi = b.axis === 'x' ? cellLevelAt(g, b.x + half * 2.2, b.z) : cellLevelAt(g, b.x, b.z + half * 2.2);
        expect(mid, `seed ${seed}: street sits above a neighbouring block`).toBeLessThanOrEqual(Math.max(lo, hi));
      }
    }
  });
});

describe('the staircase lands on the pavement, not the road and not under the terrace', () => {
  it('a flight fits ACROSS the pavement ring it stands on', () => {
    // A real ~13-riser flight is ~3.7 m long — far longer than the ~2.6 m pavement is wide — so it runs
    // ALONG the wall (a Japanese hillside stair) and only its WIDTH (+ side wall) has to fit across the
    // pavement, leaving room to walk past. Inset into the terrace, the raised block's ground would cover it;
    // wider than the pavement, it would stand in the carriageway.
    for (const seed of [1, 3, 7]) {
      const g = grid(seed);
      const mpu = cityMetresPerUnit(g.radius);
      const carriagewayHalf = g.params.streetWidth * 0.5;
      const pavement = streetBandHalf(g.params) - carriagewayHalf;
      const width = (STAIR.widthM + 0.12) / mpu;              // flight + stringer wall
      expect(width, `seed ${seed}: stair ${width.toFixed(4)} is wider than a ${pavement.toFixed(4)} pavement`)
        .toBeLessThanOrEqual(pavement * 0.6);
      // And a real riser: ~18 cm, so a one-level step takes a dozen-plus treads (not three giant ones).
      const n = Math.round(terraceStep(g.params) / (STAIR.riseM / mpu));
      expect(n).toBeGreaterThanOrEqual(10);
    }
  });

  it('climbs exactly one terrace step', () => {
    const g = grid(3);
    const L = buildTerraces(g).find((x) => x.name === 'world:stairs');
    expect(L).toBeDefined();
    const v = L!.geometry.vertices;
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < v.length; i += 12) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    // One step of rise, within a tread's thickness.
    expect(hi - lo).toBeGreaterThan(terraceStep(g.params) * 0.8);
    expect(hi - lo).toBeLessThan(terraceStep(g.params) * 1.3);
  });
});
