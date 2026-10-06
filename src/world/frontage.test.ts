/**
 * src/world/frontage.test.ts — persona-polish D1 (eye-level frontage dressing) + E1 (painted sky cards).
 * Pins: the plan reserves the new frontage kinds in the FRONTAGE band (never inside a lot, never overlapping), the
 * emitted layers are cheap + instanced (a handful of draws), carry ONE material family each, sit on the LOD tiers,
 * the toggle removes them, and the painted clouds are soft transparent cards excluded from framing.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildStreets } from './streets';
import { streetPlan } from './street-slots';
import { buildFrontage, noboriGeometry } from './frontage';
import { buildSky } from './sky';
import { computeTraffic } from './traffic';
import type { LayoutParams, LayoutPreviewLayer } from './types';

const P = { seed: 3, radius: 10, pattern: 'grid', border: 'square' } as unknown as Partial<LayoutParams>;
const tris = (L: LayoutPreviewLayer): number => L.geometry.indices.length / 3 * (L.instances?.length ?? 1);

describe('frontage dressing (D1)', () => {
  const graph = generateCityLayout(P);
  buildStreets(graph);                                   // stamps lot.door + lot meta (noren reads it)
  const plan = streetPlan(graph);

  it('reserves nobori runs + wall bikes in the frontage band, outside every lot, densest on commercial frontage', () => {
    const nob = plan.of('nobori'), bikes = plan.of('bikewall');
    expect(nob.length).toBeGreaterThan(20);
    expect(bikes.length).toBeGreaterThan(5);
    for (const sl of [...nob, ...bikes]) {
      expect(sl.band).toBe('front');
      expect(plan.inBuilding(sl.x, sl.z), sl.kind).toBe(false);
    }
    const com = nob.filter(sl => sl.zone === 'commercial').length;
    expect(com / nob.length).toBeGreaterThan(0.7);
  });

  it('emits a few instanced, single-family layers on the LOD tiers', () => {
    const layers = buildFrontage(graph);
    const names = layers.map(L => L.name);
    expect(names).toContain('world:frontage-nobori-flag');
    expect(names.some(n => n.startsWith('world:noren-door-'))).toBe(true);
    expect(names.some(n => n.startsWith('world:bicycle-lean-'))).toBe(true);
    expect(layers.length).toBeLessThan(32);
    const PROPS = /world:frontage-|world:bicycle/, DETAIL = /noren/;
    for (const L of layers) {
      expect(PROPS.test(L.name) || DETAIL.test(L.name), L.name).toBe(true);
      const fams = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade', 'wind'].filter(f => (L as unknown as Record<string, unknown>)[f] != null);
      expect(fams.length, `${L.name}: ${fams.join('+')}`).toBeLessThanOrEqual(1);
    }
    // One instanced layer per flag colour (an ArrayGroup shares one material — no per-copy tint).
    const flags = layers.filter(L => L.name === 'world:frontage-nobori-flag');
    expect(new Set(flags.map(L => L.color.join(','))).size).toBeGreaterThanOrEqual(4);
    for (const L of flags) expect(L.arrayGroup).toBe(true);
    const nFlags = flags.reduce((n, L) => n + L.instances!.length, 0);
    expect(layers.find(L => L.name === 'world:frontage-nobori-pole')!.instances!.length).toBe(nFlags);
    const total = layers.reduce((n, L) => n + tris(L), 0);
    const g = noboriGeometry(), per = [g.flag, g.text, g.pole, g.base].reduce((n, x) => n + x.indices.length / 3, 0);
    expect(per).toBeLessThan(230);   // 2026-10-04: +~16 tris — glyph blocks split at the cloth's strip seams (no clipping)
    // eslint-disable-next-line no-console
    console.log(`[D1] nobori slots ${plan.of('nobori').length} (flags ${nFlags}, ${per} tris each) · wall-bike slots ${plan.of('bikewall').length} · potted ${plan.of('potted').length} · layers ${layers.length} · ${Math.round(total)} tris`);
    expect(total).toBeLessThan(250_000);
  });

  it('is deterministic and switches off with frontageDressing:false', () => {
    const a = buildFrontage(graph).map(L => `${L.name}:${tris(L)}`);
    expect(buildFrontage(graph).map(L => `${L.name}:${tris(L)}`)).toEqual(a);
    const off = generateCityLayout({ ...P, frontageDressing: false });
    expect(buildFrontage(off)).toEqual([]);
  });
});

describe('painted sky (E1)', () => {
  const graph = generateCityLayout(P);
  it('horizon banks are soft transparent cards (body + sunlit rim), excluded from framing', () => {
    const sky = buildSky(graph).filter(L => /sky-clouds/.test(L.name));
    expect(sky.map(L => L.name).sort()).toEqual(['world:sky-clouds', 'world:sky-clouds-rim']);
    for (const L of sky) { expect(L.radialFade).toBe(true); expect(L.opacity!).toBeLessThan(1); expect(L.excludeFromFrame).toBe(true); }
  });
  it('clear + painted = a few big clouds instead of hundreds of puffs; weather decks unchanged', () => {
    const clouds = (over: Partial<LayoutParams>) => computeTraffic(generateCityLayout({ ...P, ...over })).filter(m => m.kind === 'cloud' && !m.faceRoute);
    const legacy = clouds({ cloudDensity: 0.4 }), painted = clouds({ cloudDensity: 0.4, paintedClouds: true });
    expect(legacy.length).toBeGreaterThan(100);
    expect(painted.length).toBeGreaterThanOrEqual(3);
    expect(painted.length).toBeLessThan(12);
    for (const m of painted) for (const L of m.layers) { expect(L.excludeFromFrame).toBe(true); expect(L.radialFade).toBe(true); }
    const rain = clouds({ weather: 'rain', paintedClouds: true });
    expect(rain.length).toBeGreaterThan(50);                    // the storm deck still closes over a rainy street
    expect(rain.every(m => m.layers.every(L => !L.radialFade))).toBe(true);
  });
});
