/**
 * src/world/sim-lod.test.ts — the simulation-LOD band rule, its hysteresis, the update schedule and the switch
 * (performance-plan §P13).
 */
import { describe, it, expect } from 'vitest';
import {
  SimLod, simBand, simDue, simInterval, newSimSlot, sanitizeSimLod, simLodDiff, defaultSimLod,
  SIM_NEAR, SIM_MID, SIM_FAR, SIM_OFFSCREEN, SIM_FROZEN, type SimBand,
} from './sim-lod';

const S = defaultSimLod();   // near 40 m, mid 120 m, 10 / 2 / 2 Hz, fog freeze, 10 % hysteresis

describe('sim LOD bands', () => {
  it('near / mid / far by distance, off-screen and fog override, exempt always near', () => {
    expect(simBand(S, 10, true, false, SIM_NEAR)).toBe(SIM_NEAR);
    expect(simBand(S, 60, true, false, SIM_MID)).toBe(SIM_MID);
    expect(simBand(S, 300, true, false, SIM_FAR)).toBe(SIM_FAR);
    expect(simBand(S, 10, false, false, SIM_NEAR)).toBe(SIM_OFFSCREEN);
    expect(simBand(S, 10, true, true, SIM_NEAR)).toBe(SIM_FROZEN);
    // never throttled: the player / the selection / an edited or scripted object
    for (const [d, v, f] of [[500, true, false], [10, false, false], [900, false, true]] as const) expect(simBand(S, d, v, f, SIM_FAR, true)).toBe(SIM_NEAR);
  });

  it('hysteresis: leaving a band outward needs 10 % past its edge; coming in switches at the edge', () => {
    let b: SimBand = SIM_NEAR;
    b = simBand(S, 42, true, false, b); expect(b).toBe(SIM_NEAR);    // 40 m edge, 44 m out
    b = simBand(S, 44.5, true, false, b); expect(b).toBe(SIM_MID);
    b = simBand(S, 42, true, false, b); expect(b).toBe(SIM_MID);     // back inside 44 but not under 40: stays mid
    b = simBand(S, 39.9, true, false, b); expect(b).toBe(SIM_NEAR);
    b = simBand(S, 130, true, false, SIM_MID); expect(b).toBe(SIM_MID);   // 120 m edge, 132 m out
    b = simBand(S, 133, true, false, b); expect(b).toBe(SIM_FAR);
    b = simBand(S, 125, true, false, b); expect(b).toBe(SIM_FAR);
    b = simBand(S, 119, true, false, b); expect(b).toBe(SIM_MID);
    // a camera jitter on an edge never flips the band every frame
    let flips = 0, prev: SimBand = SIM_NEAR;
    for (let k = 0; k < 200; k++) { const nb = simBand(S, 41 + Math.sin(k) * 1.5, true, false, prev); if (nb !== prev) flips++; prev = nb; }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('rates of 0 freeze a band; the switch off = every frame', () => {
    const s0 = sanitizeSimLod({ farHz: 0, offscreenHz: 0 }, S);
    expect(simBand(s0, 300, true, false, SIM_FAR)).toBe(SIM_FROZEN);
    expect(simBand(s0, 5, false, false, SIM_NEAR)).toBe(SIM_FROZEN);
    const off = sanitizeSimLod({ enabled: false }, S);
    expect(simBand(off, 900, false, true, SIM_FROZEN)).toBe(SIM_NEAR);
    const slot = newSimSlot();
    for (let f = 0; f < 120; f++) expect(simDue(off, slot, SIM_NEAR, f / 60)).toBe(true);
  });
});

describe('sim LOD schedule', () => {
  it('near every frame, mid ~10 Hz, far / off-screen ~2 Hz, frozen never', () => {
    const count = (band: SimBand, secs = 10): number => {
      const slot = newSimSlot(); let n = 0;
      for (let f = 0; f < secs * 60; f++) if (simDue(S, slot, band, f / 60, 0.3)) n++;
      return n;
    };
    expect(count(SIM_NEAR)).toBe(600);
    expect(Math.abs(count(SIM_MID) - 100)).toBeLessThanOrEqual(3);
    expect(Math.abs(count(SIM_FAR) - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(count(SIM_OFFSCREEN) - 20)).toBeLessThanOrEqual(2);
    expect(count(SIM_FROZEN)).toBe(0);
    expect(simInterval(S, SIM_MID)).toBeCloseTo(0.1);
  });

  it('a move to a faster band updates at once (no stale frame); staggered phases spread one band', () => {
    const slot = newSimSlot();
    simDue(S, slot, SIM_FAR, 0);                    // first sight: due
    expect(simDue(S, slot, SIM_FAR, 0.1)).toBe(false);
    expect(simDue(S, slot, SIM_NEAR, 0.11)).toBe(true);   // walked into the near band → this frame
    const firsts: number[] = [];
    for (let i = 0; i < 40; i++) {
      const sl = newSimSlot(); simDue(S, sl, SIM_FAR, 0, (i * 0.618) % 1);
      for (let f = 1; f < 120; f++) if (simDue(S, sl, SIM_FAR, f / 60, (i * 0.618) % 1)) { firsts.push(f); break; }
    }
    expect(new Set(firsts).size).toBeGreaterThan(8);   // not all on the same frame
  });

  it('a long frame never queues several updates', () => {
    const slot = newSimSlot();
    simDue(S, slot, SIM_MID, 0);
    expect(simDue(S, slot, SIM_MID, 2)).toBe(true);
    expect(simDue(S, slot, SIM_MID, 2 + 1 / 60)).toBe(false);
  });
});

describe('SimLod state', () => {
  it('fog test from the fog eye with a radius; counters per system; settings diff is opt-in', () => {
    const L = new SimLod();
    L.view.fogEye = [0, 0, 0]; L.view.fogEdge = 100;
    expect(L.inFog(150, 0, 0)).toBe(true);
    expect(L.inFog(150, 0, 0, 60)).toBe(false);
    L.view.fogEdge = Infinity;
    expect(L.inFog(1e6, 0, 0)).toBe(false);
    const c = L.counter('walkers'); c.begin();
    const slot = newSimSlot();
    L.view.cam = [0, 0, 0]; L.view.vp = null; L.view.mpu = 1;
    L.step(c, slot, 0, 0, 10, 0, 0, 0);
    L.step(c, newSimSlot(), 0, 0, 500, 0, 0, 0);
    const st = L.stats();
    expect(st.systems.walkers.near).toBe(1); expect(st.systems.walkers.far).toBe(1); expect(st.total.updates).toBe(2);
    expect(simLodDiff(defaultSimLod())).toBeNull();
    expect(simLodDiff(sanitizeSimLod({ midHz: 5 }))).toEqual({ midHz: 5 });
    expect(sanitizeSimLod({ nearM: 200, midM: 50 }).midM).toBe(200);   // mid never inside near
  });

  it('anti-stutter: a moving thing on screen updates before it moves stutterPx pixels; a standing one at the band rate', () => {
    const L = new SimLod();
    L.view.cam = [0, 0, 0]; L.view.vp = null; L.view.mpu = 1; L.view.pxPerUnit = 600;   // 600 px per unit at 1 unit
    const run = (speed: number, dist: number): number => {
      const c = L.counter('x'), slot = newSimSlot(); let n = 0;
      for (let f = 0; f < 600; f++) if (L.step(c, slot, f / 60, 0, dist, 0, 0, 0, false, false, false, speed)) n++;
      return n / 10;   // updates per second
    };
    // a car (8 m/s) at 150 m: 32 px/s → ≥ 21 Hz for 1.5 px; standing: the far band's 2 Hz
    expect(run(8, 150)).toBeGreaterThan(20);
    expect(run(0, 150)).toBeLessThanOrEqual(2.1);
    // a walker (1.4 m/s) at 80 m (mid band): 10.5 px/s → 10 Hz already suffices for ~1 px
    expect(run(1.4, 80)).toBeLessThanOrEqual(10.6);
    L.configure({ stutterPx: 0 });
    expect(run(8, 150)).toBeLessThanOrEqual(2.1);
  });

  it('metres per unit scales the band distances (a city: 15 m per unit)', () => {
    const L = new SimLod();
    L.view.cam = [0, 0, 0]; L.view.vp = null; L.view.mpu = 15;
    expect(L.bandAt(2, 0, 0, 0, SIM_NEAR)).toBe(SIM_NEAR);    // 30 m
    expect(L.bandAt(4, 0, 0, 0, SIM_NEAR)).toBe(SIM_MID);     // 60 m
    expect(L.bandAt(40, 0, 0, 0, SIM_NEAR, false, true)).toBe(SIM_NEAR);   // big on screen: no distance bands
  });
});
