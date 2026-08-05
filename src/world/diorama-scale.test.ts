/**
 * src/world/diorama-scale.test.ts — the diorama-scale conversion is now ONE function, used everywhere.
 *
 * Nine call sites across eight files each derived `CITY_FLOOR_M / (0.2 * (radius/10))` (metres per world
 * unit) or `3 ×` that (metal detail frequency) by hand. Two copies of one length silently disagreeing is
 * exactly the class of bug that opened a 5.6 m gap between the canal water and its trench wall. These pin
 * the extracted helpers against the literal arithmetic they replaced, so a refactor of the formula can
 * never leave a stale hand-rolled copy behind — and confirm the city's numbers did not move in the swap.
 */

import { describe, it, expect } from 'vitest';
import { cityMetresPerUnit, metalScaleFor, CITY_FLOOR_M } from './types';

describe('cityMetresPerUnit — the single diorama-scale source of truth', () => {
  it('equals the hand-derived formula every call site used', () => {
    for (const radius of [1, 6, 10, 10.5, 20, 37, 100]) {
      expect(cityMetresPerUnit(radius)).toBeCloseTo(CITY_FLOOR_M / (0.2 * (radius / 10)), 10);
    }
  });

  it('is 15 metres per unit at the reference radius of 10', () => {
    // The documented anchor: one world unit = 15 m at the default radius. If this moves, every ground
    // tile size and wave scale in the city moved with it.
    expect(cityMetresPerUnit(10)).toBeCloseTo(15, 10);
  });

  it('metalScaleFor is exactly 3× the metres-per-unit', () => {
    for (const radius of [1, 10, 20, 100]) {
      expect(metalScaleFor(radius)).toBeCloseTo(3 * cityMetresPerUnit(radius), 10);
    }
  });

  it('scales inversely with radius — a bigger city has fewer metres per unit', () => {
    expect(cityMetresPerUnit(20)).toBeCloseTo(cityMetresPerUnit(10) / 2, 10);
  });
});
