/**
 * src/world/street-slots.test.ts — the shared pavement plan + the static crowd that stands on it.
 *
 * The review found parked cars 2/3 on the footway, trees / people / furniture on top of each other and nobody checking
 * whether a point was inside a shopfront. These pin the invariants that make the street read as real: parked cars on
 * the asphalt, one reservation shared by every family, nobody inside a car / trunk / machine / building, a crowd that
 * gathers where people gather, and all of it deterministic per seed.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { streetPlan, parkedOffset } from './street-slots';
import { staticCrowd, buildPedestrians, footfallField } from './pedestrians';

const graph = generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square', instancedCrowd: false });
const s = graph.params.radius / 10, half = graph.params.streetWidth * 0.5;

describe('street slots — the shared pavement plan', () => {
  const plan = streetPlan(graph);

  it('is memoized per graph and deterministic per seed', () => {
    expect(streetPlan(graph)).toBe(plan);
    const again = streetPlan(generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square' }));
    expect(again.slots.map(sl => `${sl.kind}:${sl.x.toFixed(4)},${sl.z.toFixed(4)}`)).toEqual(plan.slots.map(sl => `${sl.kind}:${sl.x.toFixed(4)},${sl.z.toFixed(4)}`));
  });

  it('plans every family (trees, poles, parked cars, vending, benches, clutter)', () => {
    for (const k of ['tree', 'pole', 'parked', 'vending', 'entrance'] as const) expect(plan.of(k).length, k).toBeGreaterThan(0);
  });

  it('parks cars ON THE ASPHALT — the whole body inside the kerb line', () => {
    for (const c of plan.of('parked')) {
      expect(c.off).toBeCloseTo(parkedOffset(half, s), 6);
      expect(c.off + 0.06 * s).toBeLessThanOrEqual(half + 1e-9);   // kerb-side flank inside the carriageway
      expect(c.band).toBe('road');
    }
  });

  it('never overlaps two reservations in one band', () => {
    const bySide = new Map<string, typeof plan.slots>();
    for (const sl of plan.slots) {
      if (sl.kind === 'entrance' || sl.kind === 'driveway') continue;   // these are keep-clear zones, not objects
      const k = `${sl.ri}|${sl.side}|${sl.band}`;
      (bySide.get(k) ?? bySide.set(k, []).get(k)!).push(sl);
    }
    for (const arr of bySide.values()) {
      arr.sort((a, b) => a.along - b.along);
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i].along - arr[i].half, `${arr[i - 1].kind} vs ${arr[i].kind}`).toBeGreaterThanOrEqual(arr[i - 1].along + arr[i - 1].half - 1e-9);
      }
    }
  });

  it('keeps kerb items in the kerb band and frontage items against the building line — never inside a lot', () => {
    for (const sl of plan.slots) {
      const S = plan.side(sl.ri, sl.side)!;
      if (sl.band === 'kerb') { expect(sl.off).toBeGreaterThanOrEqual(S.kerbIn - 1e-9); expect(sl.off).toBeLessThanOrEqual(S.kerbOut + 1e-9); }
      if (sl.kind === 'tree' || sl.kind === 'vending' || sl.kind === 'bench' || sl.kind === 'pole') expect(plan.inBuilding(sl.x, sl.z), sl.kind).toBe(false);
    }
  });

  it('street trees form REGULAR rows — paired across the road, at a fixed pitch', () => {
    const byRoad = new Map<number, number[]>();
    for (const t of plan.of('tree')) (byRoad.get(t.ri) ?? byRoad.set(t.ri, []).get(t.ri)!).push(t.along);
    let paired = 0, total = 0;
    for (const [ri, als] of byRoad) {
      const R = plan.roads[ri]!, pitch = (R.klass === 'arterial' ? 0.55 : 0.72) * s;
      const sorted = [...new Set(als.map(a => a.toFixed(5)))].map(Number).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        expect(Math.abs(gap / pitch - Math.round(gap / pitch))).toBeLessThan(1e-6);   // gaps are whole pitches (a dropped slot, never a jitter)
      }
      const ones = plan.of('tree').filter(t => t.ri === ri);
      for (const t of ones) { total++; if (ones.some(o => o !== t && o.side !== t.side && Math.abs(o.along - t.along) < 1e-9)) paired++; }
    }
    expect(paired / Math.max(1, total)).toBeGreaterThan(0.45);
  });
});

describe('static crowd', () => {
  const plan = streetPlan(graph);
  const people = staticCrowd(graph);

  it('populates the city, deterministically', () => {
    expect(people.length).toBeGreaterThan(150);
    expect(staticCrowd(graph).map(p => `${p.x},${p.z}`)).toEqual(people.map(p => `${p.x},${p.z}`));
  });

  it('nobody stands inside a building, a tree trunk, a parked car or a vending machine', () => {
    for (const pp of people) expect(plan.inBuilding(pp.x, pp.z)).toBe(false);
    const hit = (sl: (typeof plan.slots)[number], x: number, z: number, pad: number): boolean => {
      const R = plan.roads[sl.ri]!;
      const rx = x - sl.x, rz = z - sl.z;
      const al = Math.abs(rx * R.d[0] + rz * R.d[1]), lat = Math.abs(rx * R.pp[0] + rz * R.pp[1]);
      const hw = sl.kind === 'parked' ? 0.06 * s : sl.kind === 'vending' ? 0.02 * s : 0.012 * s;
      return al < sl.half * (sl.kind === 'tree' || sl.kind === 'pole' ? 0.4 : 0.9) + pad && lat < hw + pad;
    };
    // Spatial buckets (people × slots is ~2M pairs otherwise — slow under a loaded full-suite run).
    const G = 0.5 * s, key = (x: number, z: number): string => `${Math.floor(x / G)},${Math.floor(z / G)}`;
    const buckets = new Map<string, typeof people>();
    for (const pp of people) (buckets.get(key(pp.x, pp.z)) ?? buckets.set(key(pp.x, pp.z), []).get(key(pp.x, pp.z))!).push(pp);
    const bad: string[] = [];
    for (const sl of plan.slots) {
      if (sl.kind !== 'tree' && sl.kind !== 'parked' && sl.kind !== 'vending' && sl.kind !== 'pole') continue;
      const cx = Math.floor(sl.x / G), cz = Math.floor(sl.z / G);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const pp of buckets.get(`${cx + dx},${cz + dz}`) ?? []) if (hit(sl, pp.x, pp.z, 0.004 * s)) bad.push(`${pp.kind} inside a ${sl.kind}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('faces somewhere sensible (unit facing vectors) and gathers at benches / corners / groups', () => {
    for (const pp of people) expect(Math.hypot(pp.face[0], pp.face[1])).toBeCloseTo(1, 5);
    const kinds = new Set(people.map(p => p.kind));
    for (const k of ['stroll', 'group', 'crowd'] as const) expect(kinds.has(k), k).toBe(true);
  });

  it('is busier near the station / junctions than in the quiet back streets (footfall field)', () => {
    const f = footfallField(graph);
    const station = graph.landmarks.find(l => l.type === 'station');
    if (station) expect(f(station.entrance[0], station.entrance[1])).toBeGreaterThan(f(graph.border[0][0] * 0.95, graph.border[0][1] * 0.95));
    const night = footfallField({ ...graph, params: { ...graph.params, nightMode: true } });
    expect(night(0, 0)).toBeLessThan(f(0, 0));
  });

  it('builds mannequins within a sane triangle budget (NEAR twin ≈ 2.5k + MID ≈ 0.85k + XFAR ≈ 0.35k tris per person)', () => {
    const layers = buildPedestrians(graph);
    const tris = layers.reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    expect(layers.length).toBeGreaterThan(5);            // several palette colours — not one blob colour
    expect(layers.length).toBeLessThan(180);             // …but still a handful of draws (≤ one per palette colour, ground + bridge decks, × near / mid / xfar tier)
    expect(layers.every(L => L.nearTwin && /^crowd/.test(L.nearTwin.key))).toBe(true);
    expect(layers.filter(L => L.nearTwin!.role === 'mid').length).toBe(layers.filter(L => L.nearTwin!.role === 'near').length);
    expect(layers.filter(L => L.nearTwin!.role === 'xfar').length).toBe(layers.filter(L => L.nearTwin!.role === 'near').length);
    expect(tris / people.length).toBeLessThan(4600);     // P9: + the xfar tier (≈ 0.35k)
    expect(tris / people.length).toBeGreaterThan(2000);  // and a real body, not a prism + octahedron
  });

  it('umbrellas come out in the rain', () => {
    const rainy = generateCityLayout({ seed: 5, radius: 10, pattern: 'grid', border: 'square', weather: 'rain', instancedCrowd: false });
    const dry = buildPedestrians(graph).reduce((n, L) => n + L.geometry.indices.length, 0);
    const wet = buildPedestrians(rainy).reduce((n, L) => n + L.geometry.indices.length, 0);
    expect(wet).toBeGreaterThan(dry);
  }, 30000);   // two full crowd builds: past the 5 s default under full-suite load
});
