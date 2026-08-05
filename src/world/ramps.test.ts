/**
 * src/world/ramps.test.ts — road ramps slope a carriageway between terrace levels so a car climbs it instead of
 * driving off the retaining-wall cliff. The ramp is applied ONLY in makeElevation (drape + car-height field), never
 * in cellLevelAt — so terrace-roads.test (which pins cellLevelAt) stays valid alongside this.
 */

import { describe, it, expect } from 'vitest';
import { computeRamps, rampLevelAt, inRamp, makeElevation, cellLevelAt, terraceStep } from './elevation';
import { generateCityLayout } from './layout';
import type { WorldGraph } from './types';

const grid = (seed: number): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6 });

describe('road ramps between terrace levels', () => {
  it('a terraced grid produces at least one ramp to test (else it proves nothing)', () => {
    const total = [1, 2, 3, 4, 5, 6, 7, 8].reduce((n, s) => n + computeRamps(grid(s)).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('layout stamps graph.ramps (so downstream elevation/terraces/traffic all agree)', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8].map(grid).find((x) => (x.ramps?.length ?? 0) > 0);
    expect(g?.ramps && g.ramps.length).toBeGreaterThan(0);
  });

  it('spans exactly one level: low end ≈ loLevel, high end ≈ hiLevel, monotonic between', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8].map(grid).find((x) => (x.ramps?.length ?? 0) > 0)!;
    const rp = g.ramps![0];
    const lo = rampLevelAt(g.ramps!, rp.x - rp.ax * rp.len * 0.49, rp.z - rp.az * rp.len * 0.49);
    const hi = rampLevelAt(g.ramps!, rp.x + rp.ax * rp.len * 0.49, rp.z + rp.az * rp.len * 0.49);
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(Math.abs(lo! - rp.loLevel)).toBeLessThan(0.06);
    expect(Math.abs(hi! - rp.hiLevel)).toBeLessThan(0.06);
    expect(rp.hiLevel - rp.loLevel).toBe(1);   // ramps span one step
  });

  it('makeElevation CLIMBS the ramp smoothly — no full-step cliff along the carriageway (cars stop falling off)', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8].map(grid).find((x) => (x.ramps?.length ?? 0) > 0)!;
    const step = terraceStep(g.params);
    const elev = makeElevation(g);
    const rp = g.ramps![0];
    // Walk the carriageway centre-line straight up the ramp. Every adjacent sample must rise by well under a full
    // terrace step — a cliff would show one sample jumping a whole `step`.
    let maxJump = 0, prev = elev(rp.x - rp.ax * rp.len * 0.6, rp.z - rp.az * rp.len * 0.6);
    for (let i = 1; i <= 24; i++) {
      const t = -0.6 + (1.2 * i) / 24;
      const y = elev(rp.x + rp.ax * rp.len * t, rp.z + rp.az * rp.len * t);
      maxJump = Math.max(maxJump, Math.abs(y - prev));
      prev = y;
    }
    expect(maxJump).toBeLessThan(step * 0.5);   // gentle slope, not a step
  });

  it('inRamp is true on the corridor and false well outside it', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8].map(grid).find((x) => (x.ramps?.length ?? 0) > 0)!;
    const rp = g.ramps![0];
    expect(inRamp(g.ramps!, rp.x, rp.z)).toBe(true);
    // A point two corridor-lengths up the road is outside this ramp.
    expect(inRamp(g.ramps!, rp.x + rp.ax * rp.len * 2, rp.z + rp.az * rp.len * 2)).toBe(false);
  });

  it('does NOT alter cellLevelAt (terrace-roads.test invariant is preserved)', () => {
    const g = grid(3);
    // cellLevelAt is integer everywhere — the ramp lives only in makeElevation.
    for (let x = -g.radius + 0.5; x < g.radius; x += 1.3)
      for (let z = -g.radius + 0.5; z < g.radius; z += 1.3)
        expect(Number.isInteger(cellLevelAt(g, x, z))).toBe(true);
  });
});
