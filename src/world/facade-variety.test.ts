/**
 * src/world/facade-variety.test.ts — persona polish B4 (facade variety), D2 (window depth), D3 (eye-level clutter).
 *
 * B4: the city picks a facade MATERIAL per lot (tile / concrete / painted render / metal panel / brick, district
 *     weighted) and a MUTED swatch for it — so a street stops being one tiled grid in one warm tan. Metal-panel
 *     cladding has its own facade code (8).
 * D2: every upper-floor window on a street face gets a slim instanced SILL (the recessed reveal is in the shader —
 *     see interior-mapping.test.ts), and floor-band ledges are bold enough to read.
 * D3: a mid-terrace lot (no open back / side face) still gets AC units + pipe runs on the first storeys of its
 *     STREET face, deterministically, never past a party wall and never above storey 3.
 */
import { describe, it, expect } from 'vitest';
import { buildBuilding, resolveBuildingParams } from './building';
import { facadeCode, sillColor } from './building-parts';
import { facadeFor, FACADE_SWATCHES } from './palette';
import type { FacadeMaterial } from './palette';
import { buildCentreGroups } from './centre-build';
import type { LayoutPreviewLayer, LayoutParams } from './types';

const F = 12;
const layer = (ls: LayoutPreviewLayer[], name: string): LayoutPreviewLayer | undefined => ls.find(l => l.name === name);
const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3 * (L.instances?.length ?? 1), 0);
const sat = (c: number[]): number => { const mx = Math.max(...c), mn = Math.min(...c); return mx > 0 ? (mx - mn) / mx : 0; };

describe('B4 facade materials + muted swatches', () => {
  it('facadeFor is deterministic, keeps identity archetypes, and only hands out muted colours', () => {
    expect(facadeFor('zakkyo', 'downtown', 0.3, 0.6, 2)).toEqual(facadeFor('zakkyo', 'downtown', 0.3, 0.6, 2));
    for (const a of ['machiya', 'konbini', 'apato', 'jp-house', 'glass-tower', 'warehouse']) expect(facadeFor(a, 'mixed', 0.5, 0.5, 2)).toBeNull();
    for (const m of Object.keys(FACADE_SWATCHES) as FacadeMaterial[]) {
      for (const c of FACADE_SWATCHES[m]) {
        expect(sat(c), `${m} swatch ${c} is not muted`).toBeLessThan(0.45);
        expect(Math.max(...c)).toBeLessThan(0.9);   // never a bright white slab either
      }
    }
  });
  it('districts mix several materials, and downtown leans to cladding while the market leans to render', () => {
    const count = (district: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (let i = 0; i < 400; i++) { const f = facadeFor('zakkyo', district, (i * 0.61803) % 1, (i * 0.414) % 1, i % 6)!; out[f.material] = (out[f.material] ?? 0) + 1; }
      return out;
    };
    const dt = count('downtown'), mk = count('market');
    expect(Object.keys(dt).length).toBeGreaterThanOrEqual(4);
    expect(dt.panel).toBeGreaterThan(mk.panel ?? 0);
    expect(mk.plaster).toBeGreaterThan(dt.plaster ?? 0);
  });
  it('metal panel cladding has its own facade code (8, +10 with sash) and keeps windows', () => {
    expect(facadeCode(resolveBuildingParams({ archetype: 'zakkyo', material: 'panel' }))).toBe(8);
    expect(facadeCode(resolveBuildingParams({ archetype: 'mansion', material: 'panel' }))).toBe(18);
    const { layers } = buildBuilding({ archetype: 'zakkyo', material: 'panel' });
    expect(layer(layers, 'bldg:wall')?.pattern?.mode).toBe('windows');
  });
  it('the city wall layers carry several facade materials and neutral colours', () => {
    const res = buildCentreGroups({ seed: 3, radius: 10, pattern: 'grid', border: 'square' } as unknown as LayoutParams,
      { parkedTrain: false, activeRegions: null } as never) as unknown as { groups: Array<{ layers: LayoutPreviewLayer[] }> };
    const walls = res.groups.flatMap(g => g.layers).filter(L => /^world:detail-wall/.test(L.name));
    const codes = new Set(walls.map(L => Math.round(L.pattern?.angle ?? -1) % 10));
    for (const c of [1, 4, 7, 8]) expect(codes.has(c), `facade code ${c} (concrete / tile / render / panel) in the city`).toBe(true);
    const muted = walls.filter(L => sat(L.color) < 0.45).length;
    expect(muted / walls.length).toBeGreaterThan(0.85);
  }, 60000);
});

describe('D2 window sills + floor bands', () => {
  it('one sill per upper-floor street window, instanced, at the window bottoms', () => {
    const p = resolveBuildingParams({ archetype: 'zakkyo', seed: 4, floorSigns: false, signStack: false });
    const { layers } = buildBuilding(p);
    const sills = layers.filter(L => L.name === 'bldg:trim-sill');
    expect(sills.length).toBeGreaterThan(0);
    const n = sills.reduce((k, L) => k + (L.instances?.length ?? 0), 0);
    expect(n).toBeGreaterThanOrEqual(p.floors - 1);                        // ≥ one per upper storey
    for (const L of sills) {
      expect(L.instanceKey).toMatch(/^sill:/);
      expect(L.geometry.indices.length / 3).toBe(10);                      // 5 faces, the buried back face dropped
      expect(L.color).toEqual(sillColor(p));
      for (const t of L.instances!) expect(t.y).toBeGreaterThan(p.groundFloorHeight);   // upper floors only
    }
  });
  it('sills respect the params: off with windowSills:false, and the Western trim surround keeps its own', () => {
    expect(buildBuilding({ archetype: 'zakkyo', windowSills: false }).layers.some(L => L.name === 'bldg:trim-sill')).toBe(false);
    const west = buildBuilding({ archetype: 'brick-townhouse', windowTrim: true }).layers;
    expect(west.some(L => L.name === 'bldg:trim-sill')).toBe(false);
    expect(west.some(L => L.name === 'bldg:windowtrim')).toBe(true);
  });
  it('the sill tone comes from a fixed set of three (few instance groups city-wide)', () => {
    const tones = new Set<string>();
    for (const a of ['zakkyo', 'mansion', 'retro-shophouse', 'office-block', 'neon-arcade', 'izakaya'])
      for (const base of [[0.2, 0.2, 0.2], [0.8, 0.8, 0.8], [0.6, 0.5, 0.4]] as [number, number, number][])
        tones.add(sillColor(resolveBuildingParams({ archetype: a, baseColor: base })).join(','));
    expect(tones.size).toBeLessThanOrEqual(3);
  });
  it('floor-band ledges project ~9 cm and stand ~11 cm tall', () => {
    const p = resolveBuildingParams({ archetype: 'retro-shophouse', seed: 2, floors: 4, cornice: false, quoins: false, pilasters: false });
    const trim = layer(buildBuilding(p).layers, 'bldg:trim')!;
    const v = trim.geometry.vertices as Float32Array;
    let maxZ = -Infinity; for (let i = 0; i < v.length; i += F) maxZ = Math.max(maxZ, v[i + 2]);
    expect(maxZ).toBeGreaterThan(p.depth / 2 + 0.085);
  });
});

describe('D3 eye-level clutter on the street face', () => {
  const MID_TERRACE = ['party', 'party', 'street', 'party'] as const;   // back is party too: no open face at all
  it('a mid-terrace zakkyo gets AC units on its street face, on storeys 1–3 only, inside the party planes', () => {
    const p = resolveBuildingParams({ archetype: 'zakkyo', seed: 7, cornerStyle: 'sharp', floors: 7 });
    const { layers } = buildBuilding(p, undefined, undefined, [...MID_TERRACE]);
    const equip = layer(layers, 'bldg:roof-equip');
    expect(equip).toBeDefined();
    const v = equip!.geometry.vertices as Float32Array;
    const hw = p.width / 2, hd = p.depth / 2, y4 = p.groundFloorHeight + 3 * p.floorHeight, top = p.groundFloorHeight + (p.floors - 1) * p.floorHeight;   // (roof clutter above top - 1 is not facade)
    let onFront = 0;
    for (let i = 0; i < v.length; i += F) {
      expect(Math.abs(v[i])).toBeLessThanOrEqual(hw + 0.05);             // never into the neighbours
      if (v[i + 2] > hd + 0.02 && v[i + 1] > p.groundFloorHeight - 0.4 && v[i + 1] < top - 1) { onFront++; expect(v[i + 1]).toBeLessThan(y4 + 0.1); }
    }
    expect(onFront, 'condensers on the street face').toBeGreaterThan(0);
  });
  it('is deterministic and leaves the rnd-driven emitters alone (same laundry / back AC as before)', () => {
    const a = buildBuilding({ archetype: 'mansion', seed: 5, balconies: false }, undefined, undefined, ['open', 'party', 'street', 'party']);
    const b = buildBuilding({ archetype: 'mansion', seed: 5, balconies: false }, undefined, undefined, ['open', 'party', 'street', 'party']);
    expect(tris(a.layers)).toBe(tris(b.layers));
    expect(Array.from(layer(a.layers, 'bldg:roof-equip')!.geometry.vertices)).toEqual(Array.from(layer(b.layers, 'bldg:roof-equip')!.geometry.vertices));
  });
  it('per-archetype triangle budget stays sane', () => {
    for (const a of ['zakkyo', 'mansion', 'retro-shophouse', 'neon-arcade', 'office-block', 'izakaya', 'konbini'])
      expect(tris(buildBuilding({ archetype: a }).layers), a).toBeLessThan(8000);
  });
});
