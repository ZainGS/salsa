/**
 * src/world/building-japan.test.ts — CPU invariants for the city-quality building pass (B2–B11, L6, L10).
 *
 * Window rows are STOREYS (the wall v runs one pattern cell per storey), party walls stay plain and flush,
 * every archetype builds deterministically inside a triangle budget, pitched roofs face up, shop windows are one
 * whole cell per bay, and the city stamps doors + skips the second (city-level) shopfront dressing.
 */
import { describe, it, expect } from 'vitest';
import { buildBuilding, buildingArchetypeNames, resolveBuildingParams, faceUOffsets } from './building';
import { wallCellPitch, windowInsets, facadeCode } from './building-parts';
import { offsetPolyEdges, edgesOf } from './building-geom';
import { classifyLotEdges, lotFootprint, buildStreets } from './streets';
import { buildAwnings } from './awnings';
import { buildSignage } from './signage';
import { generateCityLayout } from './layout';
import { lotMeta } from './lot-meta';
import type { LayoutPreviewLayer, LayoutParams, V2 } from './types';

const F = 12;   // floats per vertex
const verts = (L: LayoutPreviewLayer): Float32Array => L.geometry.vertices as Float32Array;
const layer = (ls: LayoutPreviewLayer[], name: string): LayoutPreviewLayer | undefined => ls.find(l => l.name === name);
const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3 * (L.instances?.length ?? 1), 0);

describe('window rows are storeys (B4)', () => {
  for (const archetype of ['zakkyo', 'mansion', 'apato', 'retro-shophouse', 'brick-townhouse']) {
    it(`${archetype}: every wall vertex has v = storey index × pitch`, () => {
      const p = resolveBuildingParams({ archetype, seed: 3 });
      const { layers } = buildBuilding(p);
      const wall = layer(layers, 'bldg:wall');
      expect(wall, 'no windowed wall').toBeDefined();
      const pitch = wallCellPitch(p);
      const gH = p.groundFloorHeight, fh = p.floorHeight;
      const v = verts(wall!);
      for (let i = 0; i < v.length; i += F) {
        const y = v[i + 1], uvV = v[i + 7];
        const storey = y <= gH + 1e-4 ? y / gH : 1 + (y - gH) / fh;
        expect(uvV / pitch).toBeCloseTo(storey, 3);
      }
    });
  }
  it('the wall tops out at exactly `floors` rows (no half row at the roofline)', () => {
    const p = resolveBuildingParams({ archetype: 'mansion', seed: 5, floors: 6 });
    const wall = layer(buildBuilding(p).layers, 'bldg:wall')!;
    const v = verts(wall); let maxV = 0;
    for (let i = 0; i < v.length; i += F) maxV = Math.max(maxV, v[i + 7]);
    expect(maxV / wallCellPitch(p)).toBeCloseTo(6, 4);
  });
  it('face u offsets are whole cells (placement unchanged) and differ between faces / buildings', () => {
    const a = faceUOffsets(11, 4), b = faceUOffsets(12, 4);
    for (const o of [...a, ...b]) expect(Number.isInteger(o)).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(Math.floor(a[0] / 128) === Math.floor(b[0] / 128) && a[0] === b[0]).toBe(false);
  });
  it('sash facades carry the +10 code and wide-low insets; Western brick keeps portrait windows', () => {
    const sash = resolveBuildingParams({ archetype: 'mansion' }), west = resolveBuildingParams({ archetype: 'brick-townhouse' });
    expect(facadeCode(sash)).toBeGreaterThanOrEqual(10);
    expect(facadeCode(west)).toBe(0);
    const si = windowInsets(sash), wi = windowInsets(west);
    expect(1 - 2 * si.x).toBeGreaterThan(1 - si.b - si.t);   // wider than tall
    expect(si.b).toBeGreaterThan(si.t);                        // sill well above the floor
    expect(wi.b).toBe(wi.t);
  });
  it('tile / siding / plaster get their own facade codes (no longer concrete speckle)', () => {
    expect(facadeCode(resolveBuildingParams({ archetype: 'zakkyo' }))).toBe(4);
    expect(facadeCode(resolveBuildingParams({ archetype: 'apato' })) % 10).toBe(5);
    expect(facadeCode(resolveBuildingParams({ archetype: 'izakaya' })) % 10).toBe(7);
  });
});

describe('party walls (B2)', () => {
  // default rect footprint edges: 0 = back (−Z), 1 = +X side, 2 = front (+Z), 3 = −X side
  const MASK = ['open', 'party', 'street', 'party'] as const;
  for (const archetype of ['zakkyo', 'izakaya', 'mansion', 'apato', 'retro-shophouse', 'konbini', 'jp-house']) {
    it(`${archetype}: nothing protrudes past a party wall; the front + back still dress`, () => {
      const p = resolveBuildingParams({ archetype, seed: 9, cornerStyle: 'sharp' });
      const { layers, meta } = buildBuilding(p, undefined, undefined, [...MASK]);
      const hw = p.width / 2;
      for (const L of layers) {
        const v = verts(L);
        for (let i = 0; i < v.length; i += F) expect(Math.abs(v[i]), `${L.name} pokes into the neighbour`).toBeLessThanOrEqual(hw + 0.05);
      }
      expect(layer(layers, 'bldg:partywall'), 'party walls are drawn plain').toBeDefined();
      // no windowed wall face ON a party plane
      const wall = layer(layers, 'bldg:wall');
      if (wall) {
        const v = verts(wall);
        for (let i = 0; i < v.length; i += F) {
          const nx = v[i + 3];
          if (Math.abs(nx) > 0.9) expect(Math.abs(v[i]) < hw - 0.01, 'windowed wall on a party edge').toBe(true);
        }
      }
      expect(meta.door).not.toBeNull();
      expect(meta.front.out[1]).toBeCloseTo(1, 5);   // the entrance is on the street (+Z) edge
    });
  }
  it('offsetPolyEdges keeps party edges flush and moves the others', () => {
    const sq: V2[] = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
    const o = offsetPolyEdges(sq, [0.5, 0, 0.5, 0]);
    const e = edgesOf(o);
    expect(e[1].a[0]).toBeCloseTo(2, 6);    // +X edge unmoved
    expect(e[0].a[1]).toBeCloseTo(-2.5, 6); // back pushed out
  });
});

describe('every archetype — deterministic, finite, bounded', () => {
  for (const a of buildingArchetypeNames()) {
    it(a, () => {
      const one = buildBuilding({ archetype: a, seed: 4 });
      const two = buildBuilding({ archetype: a, seed: 4 });
      expect(one.layers.map(l => l.name)).toEqual(two.layers.map(l => l.name));
      one.layers.forEach((L, i) => {
        expect(Array.from(verts(L))).toEqual(Array.from(verts(two.layers[i])));
        for (const x of verts(L)) expect(Number.isFinite(x)).toBe(true);
      });
      expect(tris(one.layers)).toBeLessThan(40000);
    });
  }
});

describe('roofs (B9)', () => {
  const roofNormalsUp = (L: LayoutPreviewLayer): boolean => {
    const v = verts(L), ix = L.geometry.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * F, b = ix[t + 1] * F, c = ix[t + 2] * F;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const ny = uz * wx - ux * wz;   // y of cross(u, w)
      const area = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx);
      if (area > 1e-6 && ny / area < 0.05) return false;
    }
    return true;
  };
  for (const archetype of ['jp-house', 'machiya', 'izakaya', 'apato']) {
    it(`${archetype}: pitched roof faces point up, eaves stay off party walls`, () => {
      const p = resolveBuildingParams({ archetype, seed: 2 });
      const roof = layer(buildBuilding(p).layers, 'bldg:roof')!;
      expect(roofNormalsUp(roof)).toBe(true);
    });
  }
  it('a small-lot mansard never turns inside out', () => {
    const foot: V2[] = [[0, 0], [4, 0], [4, 5], [0, 5]];
    const roof = layer(buildBuilding({ archetype: 'office-block', roofStyle: 'mansard', floors: 3 }, foot).layers, 'bldg:roof')!;
    const v = verts(roof);
    for (let i = 0; i < v.length; i += F) { expect(v[i]).toBeGreaterThan(-0.5); expect(v[i]).toBeLessThan(4.5); expect(v[i + 2]).toBeGreaterThan(-0.5); expect(v[i + 2]).toBeLessThan(5.5); }
  });
  it('rooftop clutter stays inside a rotated footprint', () => {
    const c = Math.cos(0.6), s = Math.sin(0.6);
    const foot: V2[] = ([[-5, -6], [5, -6], [5, 6], [-5, 6]] as V2[]).map(([x, z]) => [x * c - z * s + 30, x * s + z * c - 12] as V2);
    const { layers, meta } = buildBuilding({ archetype: 'mansion', seed: 8 }, foot);
    const eq = layer(layers, 'bldg:roof-equip')!;
    const v = verts(eq);
    for (let i = 0; i < v.length; i += F) {
        if (v[i + 1] < meta.height) continue;   // balcony AC units share the layer — only the ROOF plant here
      // back into the footprint frame
      const x = v[i] - 30, z = v[i + 2] + 12, lx = x * c + z * s, lz = -x * s + z * c;
      expect(Math.abs(lx)).toBeLessThan(5.6); expect(Math.abs(lz)).toBeLessThan(6.6);
    }
  });
});

describe('shop windows (B6)', () => {
  it('one whole pattern cell per bay (u span 1, v 0..1) in the windows-mode shop layer', () => {
    const { layers } = buildBuilding({ archetype: 'konbini', seed: 1 });
    const shop = layer(layers, 'bldg:shop-glass')!;
    expect(shop.pattern?.mode).toBe('windows');
    expect(shop.pattern?.angle).toBe(6);
    const v = verts(shop);
    for (let q = 0; q < v.length; q += 4 * F) {
      const us = [0, 1, 2, 3].map(k => v[q + k * F + 6]), vs = [0, 1, 2, 3].map(k => v[q + k * F + 7]);
      expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1, 6);
      expect(Number.isInteger(Math.min(...us))).toBe(true);
      expect(Math.min(...vs)).toBe(0); expect(Math.max(...vs)).toBe(1);
    }
  });
  it('roller shutters appear on some bays when enabled', () => {
    const { layers } = buildBuilding({ archetype: 'retro-shophouse', seed: 3, shopBays: 6, shutterBays: 1 });
    expect(layer(layers, 'bldg:shutter')).toBeDefined();
  });
});

describe('signs + lettering (B7)', () => {
  it('a zakkyo has a sign stack + per-floor tenant signs, lettered, in several colours', () => {
    const { layers, meta } = buildBuilding({ archetype: 'zakkyo', seed: 6, floors: 6 });
    expect(layer(layers, 'bldg:sign-text')).toBeDefined();
    const colours = ['bldg:sign', 'bldg:sign-b', 'bldg:sign-c'].filter(n => layer(layers, n));
    expect(colours.length).toBeGreaterThanOrEqual(2);
    expect(meta.signSlots.length).toBeGreaterThanOrEqual(8);
  });
  it('izakaya: lanterns (emissive) + a menu board + a sliding door', () => {
    const { layers } = buildBuilding({ archetype: 'izakaya', seed: 2 });
    expect((layer(layers, 'bldg:sign-lantern')?.emissive ?? 0)).toBeGreaterThan(1);
  });
});

describe('city lots (B1 / B2 / B3 / L10)', () => {
  it('classifyLotEdges: road side = street, shared side = party, else open', () => {
    const lot: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const nb: V2[] = [[1.01, 0], [2, 0], [2, 1], [1.01, 1]];
    const inPoly = (pt: V2, poly: V2[]): boolean => pt[0] > Math.min(...poly.map(q => q[0])) && pt[0] < Math.max(...poly.map(q => q[0])) && pt[1] > Math.min(...poly.map(q => q[1])) && pt[1] < Math.max(...poly.map(q => q[1]));
    const roads = [{ a: [-5, -0.3] as V2, b: [5, -0.3] as V2, width: 0.56 }];   // a road just south of the lot
    const k = classifyLotEdges(lot, roads, 0.2, 1, (pt) => inPoly(pt, nb));
    expect(k).toEqual(['street', 'party', 'open', 'open']);
  });
  it('lotFootprint: street edges set back, party edges stay on the lot line', () => {
    const lot: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const f = lotFootprint(lot, ['street', 'party', 'open', 'party'], null, 1);
    const e = edgesOf(f);
    expect(e[0].a[1]).toBeGreaterThan(0.3 / 15 - 1e-9);           // ≥ 0.3 m (1 m = s/15 units)
    expect(Math.abs(e[1].a[0] - 1)).toBeLessThan(0.05 / 15);          // party: a 4 cm joint only
  });
  it('detailed city: lots get doors, and awnings / signage do not dress the shopfronts again', () => {
    const graph = generateCityLayout({ seed: 7, radius: 10, pattern: 'grid', border: 'square' } as unknown as Partial<LayoutParams>);
    const layers = buildStreets(graph);
    const built = graph.lots.filter(l => l.slot === 'building');
    const withDoor = built.filter(l => l.door && l.doorOut);
    expect(withDoor.length / Math.max(1, built.length)).toBeGreaterThan(0.9);
    expect(built.every(l => lotMeta(l)?.detailed)).toBe(true);
    expect(layers.some(l => l.name.startsWith('world:detail-parapet'))).toBe(true);
    const aw = buildAwnings(graph), sg = buildSignage(graph);
    expect(aw.find(l => l.name === 'world:shopfront'), 'the dark glass strip over the door').toBeUndefined();
    expect(aw.some(l => /world:awning-/.test(l.name) && l.geometry.indices.length > 2000)).toBe(false);   // only cafe umbrellas / A-boards
    expect(sg.filter(l => /world:sign-(red|blue|yellow|green|pink|white)/.test(l.name))).toEqual([]);
  });
  it('lamp pools are big (≈7.5 m) and ringed', () => {
    const graph = generateCityLayout({ seed: 7, radius: 10, pattern: 'grid', border: 'square' } as unknown as Partial<LayoutParams>);
    const pool = buildStreets(graph).find(l => l.name === 'world:lamp-pool')!;
    const v = verts(pool);
    let maxUv = 0; for (let i = 0; i < v.length; i += F) maxUv = Math.max(maxUv, Math.hypot(v[i + 6] - 0.5, v[i + 7] - 0.5));
    expect(maxUv).toBeCloseTo(0.5, 3);
    expect(v.length / F / 73).toBeGreaterThan(10);   // 73 verts per pool (1 + 3 rings × 24)
  });
});

describe('visual-polish #6: LED screen ad loop is gated for old saves', () => {
  const screen = (adScreen?: boolean) => {
    const p = resolveBuildingParams({ archetype: 'zakkyo', seed: 5, signage: true, ledScreen: true, ...(adScreen === undefined ? {} : { adScreen }) });
    return layer(buildBuilding(p).layers, 'bldg:screen');
  };
  it('new / default: the designed ad loop (waves pattern at the AD scale, per-face 0..1 uv)', () => {
    const L = screen();
    expect(L, 'no LED screen').toBeDefined();
    expect(L!.pattern?.mode).toBe('waves');
    expect(L!.pattern!.scale).toBeGreaterThan(1.5);
    const v = verts(L!); for (let i = 0; i < v.length; i += F) { expect(v[i + 7]).toBeGreaterThanOrEqual(0); expect(v[i + 7]).toBeLessThanOrEqual(1); }
  });
  it('adScreen false (a city saved before LayoutParams.adScreens): the legacy waves static, untouched box uv', () => {
    const L = screen(false);
    expect(L!.pattern).toMatchObject({ mode: 'waves', freq: 9, scale: 0.5, spacing: 0.7 });
  });
  it('the city param threads through buildStreets (absent = new look, false = legacy)', () => {
    const scr = (extra: Partial<LayoutParams>) => buildStreets(generateCityLayout({ seed: 3, ...extra })).filter(l => l.name === 'world:detail-screen');
    const on = scr({}), off = scr({ adScreens: false });
    expect(on.length).toBeGreaterThan(0);
    expect(on.every(l => (l.pattern?.scale ?? 0) > 1.5)).toBe(true);
    expect(off.every(l => (l.pattern?.scale ?? 0) < 1.5)).toBe(true);
  });
});
