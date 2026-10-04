/**
 * src/world/street-ground.test.ts — the city-quality street-level pass (S1–S15, B1, E8, E14).
 *
 * No browser here, so these pin the GEOMETRY that makes the street read right: the ground is exactly
 * coplanar (paint and pavement neither float nor sink on a hill), levels change on clean edges, kerbs are
 * 15 cm and face the road, walls face their low side, stairs have real risers and stay on the pavement,
 * lots form a street wall, and it all stays deterministic and inside a triangle budget.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildLayoutPreview } from './preview';
import { buildRoadPaint } from './roadpaint';
import { buildTerraces } from './terraces';
import { buildWater } from './water';
import { buildApron } from './apron';
import {
  makeHeightField, makeElevation, applyHeightField, cellLevelAt, rampLevelAt, terraceStep, streetBandHalf, canalWaterY,
} from './elevation';
import { groundTess, bakedGroundAt } from './ground-mesh';
import { streetDims, crossings } from './street-layout';
import { tileParams, tileSeed } from './tiled';
import { cityMetresPerUnit, type WorldGraph, type LayoutPreviewLayer, type V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

const grid = (seed: number, over: Record<string, unknown> = {}): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6, ...over });

const terraced = (): WorldGraph[] => [1, 2, 3, 4, 5, 6, 7, 8].map((s) => grid(s)).filter((g) => g.levels?.some((c) => c.some((v) => v !== 0)));

const cloneGeo = (g: MeshGeometry): MeshGeometry => ({ ...g, vertices: g.vertices.slice(), indices: g.indices.slice() });
const byName = (layers: LayoutPreviewLayer[], n: string): LayoutPreviewLayer | undefined => layers.find((l) => l.name === n);
const tris = (L: LayoutPreviewLayer): number => L.geometry.indices.length / 3;

describe('lattice-exact ground (S2, S7, S8)', () => {
  const GROUND = /^world:(roads|sidewalks|courtyard|residential|commercial|civic|park|plaza|roadpaint|tactile|gutter|gutter-grate|canal|pond)$/;

  it('every ground triangle lies inside ONE terrain lattice triangle — so draping cannot bend it off the field', () => {
    for (const g of [grid(3), grid(5)]) {
      const hf = makeHeightField(g.params);
      const { o, d } = hf.lattice!;
      const layers = [...buildLayoutPreview(g), ...buildRoadPaint(g), ...buildWater(g)].filter((L) => GROUND.test(L.name));
      expect(layers.length).toBeGreaterThan(6);
      for (const L of layers) {
        const v = L.geometry.vertices, idx = L.geometry.indices;
        let bad = 0;
        for (let t = 0; t < idx.length; t += 3) {
          const px = [0, 1, 2].map((k) => v[idx[t + k] * 12]), pz = [0, 1, 2].map((k) => v[idx[t + k] * 12 + 2]);
          const cx = (px[0] + px[1] + px[2]) / 3, cz = (pz[0] + pz[1] + pz[2]) / 3;
          const i = Math.floor((cx - o) / d), j = Math.floor((cz - o) / d), upper = (cx - o) / d - i + (cz - o) / d - j > 1;
          for (let k = 0; k < 3; k++) {
            const fx = (px[k] - o) / d - i, fz = (pz[k] - o) / d - j, e = 1e-5;   // Float32 vertex positions
            if (fx < -e || fx > 1 + e || fz < -e || fz > 1 + e || (upper ? fx + fz < 1 - e : fx + fz > 1 + e)) { bad++; break; }
          }
        }
        expect(bad, `${L.name}: ${bad} triangles straddle a lattice edge`).toBe(0);
      }
    }
  });

  it('paint sits EXACTLY one lift above the asphalt everywhere after the drape — hills included', () => {
    const g = grid(4);
    const hf = makeHeightField(g.params), t = groundTess(g), D = streetDims(g.params);
    const paint = byName(buildRoadPaint(g), 'world:roadpaint')!;
    const geo = cloneGeo(paint.geometry);
    applyHeightField(geo, hf);
    const v = geo.vertices, idx = geo.indices;
    let worst = 0;
    for (let k = 0; k < idx.length; k += 3) {
      // A triangle is planar and inside one lattice triangle, so its centroid height is the vertex mean.
      let cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < 3; q++) { cx += v[idx[k + q] * 12]; cy += v[idx[k + q] * 12 + 1]; cz += v[idx[k + q] * 12 + 2]; }
      cx /= 3; cy /= 3; cz /= 3;
      const road = g.params.groundY + bakedGroundAt(t, cx, cz, false) + hf(cx, cz);
      worst = Math.max(worst, Math.abs(cy - road - D.lift * 2));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('the pavement stands one kerb height (15 cm) above the road, and follows the hill with it', () => {
    const g = grid(4), D = streetDims(g.params);
    expect(D.kerbH * cityMetresPerUnit(g.radius)).toBeCloseTo(0.15, 5);
    const t = groundTess(g);
    const sw = byName(buildLayoutPreview(g), 'world:sidewalks')!;
    const v = sw.geometry.vertices, idx = sw.geometry.indices;
    let checked = 0;
    for (let k = 0; k < idx.length; k += 3 * 5) {
      let cx = 0, cy = 0, cz = 0;
      for (let q = 0; q < 3; q++) { cx += v[idx[k + q] * 12]; cy += v[idx[k + q] * 12 + 1]; cz += v[idx[k + q] * 12 + 2]; }
      cx /= 3; cy /= 3; cz /= 3;
      if (t.pave.dropAt(cx, cz) || t.pave.lift(cx, cz) !== D.kerbH) continue;
      expect(cy - g.params.groundY - bakedGroundAt(t, cx, cz, false)).toBeCloseTo(D.kerbH, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('no asphalt WEDGE at a wall foot: outside ramps, every road triangle is level (one terrace level each)', () => {
    for (const g of terraced().slice(0, 4)) {
      const road = byName(buildLayoutPreview(g), 'world:roads')!;
      const v = road.geometry.vertices, idx = road.geometry.indices;
      let sloped = 0;
      for (let k = 0; k < idx.length; k += 3) {
        const ys = [0, 1, 2].map((q) => v[idx[k + q] * 12 + 1]);
        const cx = [0, 1, 2].reduce((a, q) => a + v[idx[k + q] * 12], 0) / 3, cz = [0, 1, 2].reduce((a, q) => a + v[idx[k + q] * 12 + 2], 0) / 3;
        if (rampLevelAt(g.ramps, cx, cz) !== null) continue;
        if (Math.max(...ys) - Math.min(...ys) > 1e-6) sloped++;
      }
      expect(sloped, `seed ${g.params.seed}`).toBe(0);
    }
  });

  it('is deterministic per seed', () => {
    const a = buildLayoutPreview(grid(6)), b = buildLayoutPreview(grid(6));
    expect(a.map((L) => L.name)).toEqual(b.map((L) => L.name));
    for (let i = 0; i < a.length; i++) expect(Array.from(a[i].geometry.vertices)).toEqual(Array.from(b[i].geometry.vertices));
  });

  it('stays inside a triangle budget (ground + paint + terraces + water, radius 10)', () => {
    for (const g of [grid(3), grid(5)]) {
      const all = [...buildLayoutPreview(g), ...buildRoadPaint(g), ...buildTerraces(g), ...buildWater(g)];
      const n = all.reduce((a, L) => a + tris(L), 0);
      expect(n, `seed ${g.params.seed}: ${n} tris`).toBeLessThan(180_000);
    }
  });
});

describe('kerbs + gutters (S3, S14)', () => {
  it('emits kerb and gutter layers with real materials', () => {
    const layers = buildLayoutPreview(grid(3));
    const kerb = byName(layers, 'world:sidewalks-kerb'), gutter = byName(layers, 'world:gutter');
    expect(kerb?.ground?.surface).toBe('granite');
    expect(gutter?.ground?.surface).toBe('concrete');
    expect(kerb!.geometry.indices.length).toBeGreaterThan(0);
  });

  it('kerb faces face the ROAD (outward normals point off the pavement)', () => {
    const g = grid(3), t = groundTess(g);
    const kerb = byName(buildLayoutPreview(g), 'world:sidewalks-kerb')!;
    const v = kerb.geometry.vertices;
    let faces = 0, wrong = 0;
    for (let i = 0; i < v.length; i += 12) {
      const ny = v[i + 4];
      if (Math.abs(ny) > 1e-3) continue;   // top strip
      const nx = v[i + 3], nz = v[i + 5], x = v[i], z = v[i + 2], e = 0.01;
      faces++;
      if (t.pave.test(x + nx * e, z + nz * e) && !t.pave.test(x - nx * e, z - nz * e)) wrong++;
    }
    expect(faces).toBeGreaterThan(100);
    expect(wrong).toBe(0);
  });

  it('the kerb DROPS behind every crossing (a lip of ~3 cm, not 15 cm)', () => {
    const g = grid(3), t = groundTess(g), D = streetDims(g.params);
    expect(t.pave.drops.length).toBeGreaterThan(20);
    for (const dz of t.pave.drops.slice(0, 40)) {
      // At the kerb line inside the zone the pavement is at the lip; dropW in, at full kerb height.
      const mx = (dz.x0 + dz.x1) / 2, mz = (dz.z0 + dz.z1) / 2;
      const depth = mx * dz.inward[0] + mz * dz.inward[1] - dz.edge;
      const kx = mx - dz.inward[0] * depth + dz.inward[0] * 1e-4, kz = mz - dz.inward[1] * depth + dz.inward[1] * 1e-4;
      expect(t.pave.lift(kx, kz)).toBeLessThan(D.kerbH * 0.3);
    }
  });
});

describe('radial cities get kerbs too', () => {
  it('builds finite kerbed ground; the plaza paving stops at the ring road kerb', () => {
    const g = generateCityLayout({ seed: 4, radius: 10, pattern: 'radial', plazaRadius: 0.16 });
    const layers = buildLayoutPreview(g);
    expect(byName(layers, 'world:sidewalks-kerb')).toBeDefined();
    for (const L of layers) for (const x of L.geometry.vertices) expect(Number.isFinite(x)).toBe(true);
    const t = groundTess(g), plazaR = g.radius * g.params.plazaRadius;
    // On the first ring road's centreline (the plaza octagon's rim) the road is NOT raised.
    for (let a = 0; a < Math.PI * 2; a += 0.7) expect(t.pave.lift(Math.cos(a) * plazaR * 0.97, Math.sin(a) * plazaR * 0.97)).toBe(0);
    expect(t.pave.lift(0, 0)).toBeGreaterThan(0);
  }, 20000);   // builds a whole radial city — slow under full-suite load
});

describe('road markings at Japanese scale (S1)', () => {
  it('zebras are ~3.5 m deep with ~45 cm bars; the stop line is set back behind them', () => {
    const g = grid(3), D = streetDims(g.params), mpu = cityMetresPerUnit(g.radius);
    expect(D.cwDepth * mpu).toBeGreaterThan(3);
    expect(D.cwDepth * mpu).toBeLessThan(4);
    const cw = crossings(g);
    expect(cw.length).toBeGreaterThan(20);
    // Crossing clear of the rounded corner.
    for (const c of cw) {
      const along = (c.c[0] - c.junction[0]) * c.d[0] + (c.c[1] - c.junction[1]) * c.d[1];
      expect(along - c.hd).toBeGreaterThanOrEqual(D.half + D.cornerR);
    }
  });
});

describe('retaining walls + stairs (S4, S5, S6, S9)', () => {
  it('every wall face points toward its LOW side (no walls lit from behind)', () => {
    let checked = 0;
    for (const g of terraced().slice(0, 4)) {
      const wall = byName(buildTerraces(g), 'world:retaining');
      if (!wall) continue;
      const v = wall.geometry.vertices;
      const lvl = (x: number, z: number): number => rampLevelAt(g.ramps, x, z) ?? cellLevelAt(g, x, z);
      for (let i = 0; i < v.length; i += 12) {
        const nx = v[i + 3], nz = v[i + 5];
        if (Math.hypot(nx, nz) < 0.9) continue;
        const x = v[i], z = v[i + 2], e = 0.02;
        const front = lvl(x + nx * e, z + nz * e), back = lvl(x - nx * e, z - nz * e);
        if (front === back) continue;   // an end cap / corner vertex
        expect(front, `seed ${g.params.seed} wall at (${x.toFixed(2)}, ${z.toFixed(2)}) faces its high side`).toBeLessThan(back);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('walls carry a coping, a fence and (on street walls) drains or a stain', () => {
    const names = new Set(terraced().slice(0, 4).flatMap((g) => buildTerraces(g).map((L) => L.name)));
    for (const n of ['world:retaining-cap', 'world:retaining-rail', 'world:retaining-fence']) expect(names.has(n), n).toBe(true);
    expect(names.has('world:retaining-drain') || names.has('world:retaining-stain')).toBe(true);
  });

  it('stairs have ~18 cm risers and stand entirely on the pavement (not the road, not under the terrace)', () => {
    let flights = 0;
    for (const g of terraced()) {
      const L = byName(buildTerraces(g), 'world:stairs');
      if (!L) continue;
      flights++;
      const t = groundTess(g), mpu = cityMetresPerUnit(g.radius), v = L.geometry.vertices;
      const tops = new Set<number>();
      for (let i = 0; i < v.length; i += 12) {
        if (v[i + 4] > 0.99) tops.add(Math.round(v[i + 1] * 1e5));
        expect(t.pave.test(v[i], v[i + 2]), `seed ${g.params.seed}: stair vertex off the pavement`).toBe(true);
      }
      // Distinct tread heights ≈ the step count; rise = one terrace step / count.
      const rise = terraceStep(g.params) / Math.round(terraceStep(g.params) / (0.18 / mpu));
      expect(rise * mpu).toBeGreaterThan(0.15);
      expect(rise * mpu).toBeLessThan(0.21);
      expect(tops.size).toBeGreaterThan(8);
    }
    expect(flights).toBeGreaterThan(0);
  });

  it('a lot never straddles a level change — nothing on a raised block overhangs its wall (S6)', () => {
    for (const g of terraced().slice(0, 5)) {
      for (const lot of g.lots) {
        const c = lot.center, L = cellLevelAt(g, c[0], c[1]);
        for (const q of lot.poly) {
          const x = q[0] + (c[0] - q[0]) * 1e-3, z = q[1] + (c[1] - q[1]) * 1e-3;
          expect(cellLevelAt(g, x, z), `seed ${g.params.seed} lot ${lot.id}`).toBe(L);
        }
      }
    }
  });

  it('a road is never removed between two cells of different level (S9)', () => {
    for (const g of terraced()) {
      const R = g.radius, cols = g.params.gridCols, rows = g.params.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
      const lv = g.levels!;
      const has = (ax: number, az: number, bx: number, bz: number): boolean =>
        g.roads.some((r) => Math.abs((r.a[0] + r.b[0]) / 2 - (ax + bx) / 2) < 1e-6 && Math.abs((r.a[1] + r.b[1]) / 2 - (az + bz) / 2) < 1e-6);
      for (let c = 1; c < cols; c++) for (let r = 0; r < rows; r++) {
        if (lv[c - 1][r] === lv[c][r]) continue;
        expect(has(-R + c * cw, -R + r * ch, -R + c * cw, -R + (r + 1) * ch), `seed ${g.params.seed} v${c},${r}`).toBe(true);
      }
      for (let c = 0; c < cols; c++) for (let r = 1; r < rows; r++) {
        if (lv[c][r - 1] === lv[c][r]) continue;
        expect(has(-R + c * cw, -R + r * ch, -R + (c + 1) * cw, -R + r * ch), `seed ${g.params.seed} h${c},${r}`).toBe(true);
      }
    }
  });
});

describe('normals follow the terrain (S11)', () => {
  it('a flat +Y vertex draped on a slope tilts to the slope normal; a wall normal is untouched', () => {
    const hf = Object.assign((x: number) => 0.5 * x, { grad: (_x: number, _z: number, o: [number, number]) => { o[0] = 0.5; o[1] = 0; } });
    const geo: MeshGeometry = {
      vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1,   1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 0]), format: '12float',
    };
    applyHeightField(geo, hf);
    const n = [geo.vertices[3], geo.vertices[4], geo.vertices[5]];
    expect(n[0]).toBeCloseTo(-0.5 / Math.hypot(0.5, 1), 5);
    expect(n[1]).toBeCloseTo(1 / Math.hypot(0.5, 1), 5);
    expect([geo.vertices[15], geo.vertices[16], geo.vertices[17]]).toEqual([1, 0, 0]);
    expect(geo.vertices[13]).toBeCloseTo(0.5, 6);
  });

  it('the terrain gradient is smooth (no facet jumps across lattice triangles)', () => {
    const hf = makeHeightField(grid(2).params);
    const o: [number, number] = [0, 0], p: [number, number] = [0, 0];
    let worst = 0;
    for (let x = -5; x < 5; x += 0.013) { hf.grad!(x, 1.37, o); hf.grad!(x + 0.013, 1.37, p); worst = Math.max(worst, Math.abs(o[0] - p[0]), Math.abs(o[1] - p[1])); }
    expect(worst).toBeLessThan(0.01);
  });
});

describe('one world height field for a tiled world (S12)', () => {
  it('neighbour tiles sample the base terrain in world coordinates — no cliff at the shared border', () => {
    const base = { ...grid(9).params, worldMode: 'tiled' as const, tileRadius: 1 };
    const centre = makeHeightField(base);
    const east = makeHeightField({ ...base, ...tileParams(base, tileSeed(base.seed, 1, 0)) } as typeof base);
    for (let z = -9; z <= 9; z += 1.7) {
      expect(east(base.radius, z)).toBeCloseTo(centre(base.radius, z), 9);
      expect(east(base.radius * 3, z)).toBeCloseTo(centre(base.radius * 3, z), 9);
    }
  });
});

describe('ramps start at the junction mouth (S10)', () => {
  it('the foot sits exactly at the crossing road\'s pavement edge, at the junction\'s level', () => {
    let n = 0;
    for (const g of terraced()) for (const rp of g.ramps ?? []) {
      const band = streetBandHalf(g.params);
      const fx = rp.x - rp.ax * rp.len * 0.5, fz = rp.z - rp.az * rp.len * 0.5;
      // Back along the axis by `band` = the junction centre, which is at the ramp's low level.
      const jx = fx - rp.ax * band, jz = fz - rp.az * band;
      expect(cellLevelAt(g, jx, jz)).toBe(rp.loLevel);
      expect(rampLevelAt(g.ramps, fx + rp.ax * 1e-4, fz + rp.az * 1e-4)).toBeCloseTo(rp.loLevel, 3);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it('walking ACROSS the crossing road at a ramp foot is flat (no hump across the cross street)', () => {
    for (const g of terraced()) {
      const elev = makeElevation(g), band = streetBandHalf(g.params), half = g.params.streetWidth * 0.5;
      for (const rp of g.ramps ?? []) {
        const fx = rp.x - rp.ax * rp.len * 0.5, fz = rp.z - rp.az * rp.len * 0.5;
        const jx = fx - rp.ax * band, jz = fz - rp.az * band;           // junction centre
        // Walk the crossing road's carriageway through the junction, perpendicular to the ramp.
        const px = -rp.az, pz = rp.ax, ys: number[] = [];
        for (let s = -band * 1.8; s <= band * 1.8; s += band * 0.2) ys.push(elev(jx + px * s, jz + pz * s) - makeHeightField(g.params)(jx + px * s, jz + pz * s));
        const road = ys.filter((_, i) => Math.abs(-band * 1.8 + i * band * 0.2) < half * 0.9);
        expect(Math.max(...road) - Math.min(...road), `seed ${g.params.seed}`).toBeLessThan(1e-6);
      }
    }
  });

  it('across the ramp, the carriageway is level and the pavement rides the ramp one kerb up', () => {
    for (const g of terraced()) {
      const elev = makeElevation(g), hf = makeHeightField(g.params), D = streetDims(g.params);
      for (const rp of g.ramps ?? []) {
        const px = -rp.az, pz = rp.ax;
        const road = [-0.8, -0.4, 0, 0.4, 0.8].map((k) => elev(rp.x + px * D.half * k, rp.z + pz * D.half * k) - hf(rp.x + px * D.half * k, rp.z + pz * D.half * k));
        expect(Math.max(...road) - Math.min(...road)).toBeLessThan(1e-6);
        const pave = elev(rp.x + px * (D.half + D.kerbW * 2), rp.z + pz * (D.half + D.kerbW * 2)) - hf(rp.x + px * (D.half + D.kerbW * 2), rp.z + pz * (D.half + D.kerbW * 2));
        const t = groundTess(g);
        if (t.pave.test(rp.x + px * (D.half + D.kerbW * 2), rp.z + pz * (D.half + D.kerbW * 2))) expect(pave - road[2]).toBeCloseTo(D.kerbH, 6);
      }
    }
  });
});

describe('water edges (S13)', () => {
  it('canal water sits 0.6 of a step below the street, not on the trench floor', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => grid(s)).find((x) => x.levels?.some((c) => c.some((v) => v < 0)))!;
    const L = byName(buildWater(g), 'world:canal')!;
    for (let i = 1; i < L.geometry.vertices.length; i += 12 * 11) expect(L.geometry.vertices[i]).toBeCloseTo(canalWaterY(g.params), 6);
    expect(canalWaterY(g.params)).toBeCloseTo(g.params.groundY - 0.6 * terraceStep(g.params), 9);
  });

  it('ponds sit in a stone edge: coping above the water, water above the lawn', () => {
    const g = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => grid(s)).find((x) => x.ponds.length > 0)!;
    const layers = buildWater(g);
    const pond = byName(layers, 'world:pond')!, edge = byName(layers, 'world:pond-edge')!;
    expect(edge).toBeDefined();
    const maxY = (L: LayoutPreviewLayer): number => { let m = -Infinity; for (let i = 1; i < L.geometry.vertices.length; i += 12) m = Math.max(m, L.geometry.vertices[i]); return m; };
    expect(maxY(edge)).toBeGreaterThan(maxY(pond));
  });
});

describe('a street wall of narrow frontages (B1)', () => {
  it('lots are convex quads with street frontages of a few metres and near-zero alleys', () => {
    for (const g of [grid(1), grid(4)]) {
      const mpu = cityMetresPerUnit(g.radius);
      const built = g.lots.filter((l) => l.zone !== 'park' && l.zone !== 'water' && !l.merged);
      expect(built.length).toBeGreaterThan(150);
      let widths = 0;
      for (const l of built) {
        expect(l.poly.length).toBeLessThanOrEqual(4);
        expect(l.streetEdges).toBeDefined();
        const xs = l.poly.map((q) => q[0]), zs = l.poly.map((q) => q[1]);
        const w = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * mpu;
        if (w < 13) widths++;
      }
      expect(widths / built.length).toBeGreaterThan(0.8);
      expect(g.lots.some((l) => l.merged)).toBe(true);
      // Most built lots front a street.
      expect(built.filter((l) => (l.streetEdges?.length ?? 0) > 0).length / built.length).toBeGreaterThan(0.85);
    }
  });

  it('lot ids and polygons are deterministic per seed', () => {
    const a = grid(7), b = grid(7);
    expect(a.lots.map((l) => l.id)).toEqual(b.lots.map((l) => l.id));
    expect(a.lots.map((l) => l.poly)).toEqual(b.lots.map((l) => l.poly));
  });

  it('lots start at the lot line (streetBandHalf), the same line the wall stands on (S6)', () => {
    for (const g of [grid(2), grid(5)]) {
      const R = g.radius, cw = 2 * R / g.params.gridCols, ch = 2 * R / g.params.gridRows, band = streetBandHalf(g.params);
      let edges = 0;
      for (const l of g.lots) for (const i of l.streetEdges ?? []) {
        const a = l.poly[i], b = l.poly[(i + 1) % l.poly.length];
        // A street edge is axis-aligned; its distance to the nearest cell boundary is exactly the band.
        const vertical = Math.abs(a[0] - b[0]) < 1e-9, c = vertical ? a[0] : a[1], size = vertical ? cw : ch;
        const f = ((c + R) % size + size) % size;
        expect(Math.min(f, size - f), `lot ${l.id}`).toBeCloseTo(band, 6);
        edges++;
      }
      expect(edges).toBeGreaterThan(300);
    }
  });
});

describe('street widths scale with the diorama (E14)', () => {
  it('radius 10 is unchanged; radius 20 doubles; explicit widths are respected', () => {
    expect(generateCityLayout({ seed: 1, radius: 10 }).params.streetWidth).toBeCloseTo(0.4, 9);
    const big = generateCityLayout({ seed: 1, radius: 20 }).params;
    expect(big.streetWidth).toBeCloseTo(0.8, 9);
    expect(big.arterialWidth).toBeCloseTo(1.0, 9);
    expect(generateCityLayout({ seed: 1, radius: 20, streetWidth: 0.5, arterialWidth: 0.6 }).params.streetWidth).toBeCloseTo(0.5, 9);
    // A live edit that changes only the radius (the editor merges the previous params) rescales.
    const again = generateCityLayout({ ...generateCityLayout({ seed: 1, radius: 10 }).params, radius: 30 }).params;
    expect(again.streetWidth).toBeCloseTo(1.2, 9);
  });
});

describe('apron nature (S15, E8)', () => {
  it('uses the real instanced trees and blended turf shades', () => {
    const g = generateCityLayout({ seed: 2, radius: 10, pattern: 'grid', border: 'square', terrainApron: true });
    const layers = buildApron(g);
    expect(layers.some((L) => L.name === 'world:apron-foliage')).toBe(false);
    const trees = layers.filter((L) => L.instances && /world:tree-/.test(L.name));
    expect(trees.length).toBeGreaterThan(0);
    expect(trees.every((L) => L.excludeFromFrame)).toBe(true);
    const shades = layers.filter((L) => /apron-ground/.test(L.name));
    expect(shades.length).toBeGreaterThanOrEqual(4);
    for (const L of shades) expect(L.ground?.surface).toBe('grass');
  });
});

void (null as unknown as V2);
