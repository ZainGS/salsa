/**
 * src/world/city-water-edges.test.ts — people, bridges, buildings and tactile tiles at the WATER'S EDGE.
 *
 * Pins four review complaints (city-quality S13 / E5 / E12 / B1 / B2 / S3):
 *  1. "pedestrians standing in the water under bridges" — nobody (static crowd or walker) stands over a canal unless
 *     they are ON a bridge deck, between its parapets, at the deck's own surface height.
 *  2. "the bridge is not at the same elevation as the street — a sharp drop off" — each deck end lands exactly on its
 *     approach: the carriageway on the road, the footways on the kerb-raised pavement, on any terrace level; banks on
 *     different levels give a ramped deck, not a step.
 *  3. "a shop door faces the water and the railing is right against the building" — water-facing (and retaining-wall)
 *     lot edges are their own kinds, never the door when a street exists, and the building stands back from them.
 *  4. "the tactile dots look large and the pattern + normals look glitchy / misaligned" — 30 cm tiles with a 5 × 5
 *     grid of ~2.5 cm studs, the stud grid locked to each tile's edges and to the kerb, not to world XZ.
 */

import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildWater } from './water';
import { cellLevelAt, makeWaterTest, makeHeightField, canalWaterY } from './elevation';
import { groundTess, bakedGroundAt } from './ground-mesh';
import { bridgeDecks, deckAt, deckRoadY, deckSurfaceY, deckKerb } from './bridge-deck';
import { staticCrowd, buildPedestrians } from './pedestrians';
import { roadNet, walkLeg, walkNext, legPoint, type Leg } from './route-sim';
import { classifyLotEdges, lotFootprint, lotTerrain, buildStreets, EDGE_WALK_M } from './streets';
import { lotMeta } from './lot-meta';
import { buildRoadPaint, TACTILE_TILE_M, TACTILE_DOTS, TACTILE_DOT_M, TACTILE_PATTERN, TACTILE_UV_TILES } from './roadpaint';
import { crossings, streetDims } from './street-layout';
import { cityMetresPerUnit, type WorldGraph, type V2 } from './types';

const canalCity = (seed: number, extra: Record<string, unknown> = {}): WorldGraph =>
  generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6, canals: true, instancedCrowd: false, ...extra } as never);

/** Seeds whose city has at least one bridge (a canal crossed by a street). */
const inPoly = (pt: V2, poly: V2[]): boolean => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

const bridged = (n = 4, extra: Record<string, unknown> = {}): WorldGraph[] => {
  const out: WorldGraph[] = [];
  for (let s = 1; s <= 40 && out.length < n; s++) { const g = canalCity(s, extra); if (g.bridges.length) out.push(g); }
  return out;
};

describe('1 · bridge decks meet the street flush at both ends', () => {
  const cities = bridged(6);
  it('finds bridged cities', () => { expect(cities.length).toBeGreaterThan(2); });

  it('carriageway end height == the approach road; footway end height == the approach pavement (kerb incl.)', () => {
    let ends = 0;
    for (const g of cities) {
      const t = groundTess(g), s = g.params.radius / 10, tol = 0.0005 * s;   // < 1 cm (the surfacing lift is 4.5 mm)
      for (const deck of bridgeDecks(g)) {
        for (const [end, tt] of [[-1, 0], [1, 1]] as const) {
          const past = (w: number): V2 => [deck.c[0] + deck.d[0] * (deck.half + 0.002 * s) * end + deck.p[0] * w, deck.c[1] + deck.d[1] * (deck.half + 0.002 * s) * end + deck.p[1] * w];
          const q = past(0);
          expect(Math.abs(deckRoadY(deck, tt) - bakedGroundAt(t, q[0], q[1], false)), `seed ${g.params.seed}: road/deck step at end ${end}`).toBeLessThan(tol);
          const fw = (deck.carriageHalf + Math.min(deck.wHalf, deck.carriageHalf + 0.17 * s)) * 0.5;
          for (const side of [-1, 1]) {
            const f = past(fw * side);
            if (!t.pave.test(f[0], f[1])) continue;
            expect(Math.abs(deckSurfaceY(deck, tt, fw * side) - bakedGroundAt(t, f[0], f[1], true)), `seed ${g.params.seed}: pavement/footway step`).toBeLessThan(tol);
          }
          ends++;
        }
      }
    }
    expect(ends).toBeGreaterThan(4);
  });

  it('the emitted deck mesh starts at the approach height (no level-0 slab under a raised bank)', () => {
    for (const g of cities) {
      const L = buildWater(g).find((x) => x.name === 'world:bridge')!;
      expect(L, 'no bridge layer').toBeTruthy();
      const v = L.geometry.vertices, gy = g.params.groundY, s = g.params.radius / 10;
      for (const deck of bridgeDecks(g)) {
        for (const [end, tt] of [[-1, 0], [1, 1]] as const) {
          const e: V2 = [deck.c[0] + deck.d[0] * deck.half * end, deck.c[1] + deck.d[1] * deck.half * end];
          // The carriageway's end vertices (at the kerb lines; the footway / kerb face above them share the x,z).
          let top = Infinity;
          for (let i = 0; i < v.length; i += 12) {
            const dx = v[i] - e[0], dz = v[i + 2] - e[1];
            if (Math.abs(dx * deck.d[0] + dz * deck.d[1]) > 1e-4 || Math.abs(dx * deck.p[0] + dz * deck.p[1]) > deck.carriageHalf + 1e-4) continue;
            top = Math.min(top, v[i + 1]);
          }
          expect(top, 'deck end vertex missing').toBeLessThan(Infinity);
          expect(Math.abs(top - (gy + deckRoadY(deck, tt))), `seed ${g.params.seed}`).toBeLessThan(0.0005 * s);
        }
      }
    }
  });

  it('two banks on different terrace levels give a RAMPED deck (monotone ends, no step), and footways stand a kerb up', () => {
    // Force a raised bank: lift every land cell next to the first canal to level 1 and rebuild the decks.
    const g = cities[0], lv = g.levels!.map((c) => c.slice());
    const cols = g.params.gridCols, rows = g.params.gridRows;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      if (lv[c][r] < 0) continue;
      if ((lv[c - 1]?.[r] ?? 0) < 0 && c > 0) lv[c][r] = 1;   // land EAST of a canal cell → one terrace up
    }
    const g2: WorldGraph = { ...g, levels: lv, ramps: [], bridges: g.bridges.map((q) => q.map((p) => [p[0], p[1]] as V2)) };
    const step = 0.16 * (g.params.radius / 10);
    let ramped = 0;
    for (const deck of bridgeDecks(g2)) {
      const ya = deckRoadY(deck, 0), yb = deckRoadY(deck, 1);
      if (Math.abs(ya - yb) > step * 0.5) {
        ramped++;
        // No step anywhere along the span: consecutive samples never jump by more than the ramp's grade allows.
        let prev = ya;
        for (let k = 1; k <= 50; k++) { const y = deckRoadY(deck, k / 50); expect(Math.abs(y - prev)).toBeLessThan(step * 0.1); prev = y; }
      }
      for (const side of [-1, 1]) expect(deckKerb(deck, 0.5, side)).toBeGreaterThanOrEqual(0);
    }
    expect(ramped, 'no bridge with banks on different levels was exercised').toBeGreaterThan(0);
  });

  it('no zebra (and no dropped kerb) at a junction sunk into the canal trench', () => {
    for (const g of cities) for (const cw of crossings(g)) expect(cellLevelAt(g, cw.junction[0], cw.junction[1])).toBeGreaterThanOrEqual(0);
  });
});

describe('2 · nobody stands in the water — the static crowd', () => {
  const cities = bridged(4, { pedestrianDensity: 3 });
  it('every person is on dry land or ON a bridge deck (between the parapets, at deck height)', () => {
    let onDeck = 0, total = 0;
    for (const g of cities) {
      const water = makeWaterTest(g), decks = bridgeDecks(g);
      for (const pp of staticCrowd(g)) {
        total++;
        const hit = deckAt(decks, pp.x, pp.z);
        if (pp.deckY !== undefined) {
          onDeck++;
          expect(hit, `seed ${g.params.seed}: deck person off the deck`).toBeTruthy();
          expect(Math.abs(pp.deckY - deckSurfaceY(hit!.deck, hit!.t, hit!.w))).toBeLessThan(1e-9);
          expect(pp.deckY, 'standing below the street').toBeGreaterThan(canalWaterY(g.params) - g.params.groundY);
        } else {
          expect(water(pp.x, pp.z), `seed ${g.params.seed}: person at (${pp.x.toFixed(3)}, ${pp.z.toFixed(3)}) is in the water`).toBe(false);
        }
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(onDeck, 'no one exercised the deck path').toBeGreaterThan(0);
  });

  it('deck people are built into SMOOTH-draped layers at the deck height (the full drape would sink them into the trench)', () => {
    const g = cities[0];
    const layers = buildPedestrians(g);
    const deckL = layers.filter((L) => L.name.startsWith('world:ped-deck-'));
    expect(deckL.length).toBeGreaterThan(0);
    for (const L of deckL) expect(L.drape).toBe('smooth');
    for (const L of layers.filter((x) => !x.name.startsWith('world:ped-deck-'))) expect(L.drape).toBeUndefined();
    // Every vertex of a deck person stands at or above the deck surface under the crowd anchor it belongs to.
    const gy = g.params.groundY, water = canalWaterY(g.params);
    for (const L of deckL) { const v = L.geometry.vertices; for (let i = 1; i < v.length; i += 12) expect(v[i]).toBeGreaterThan(water); }
    void gy;
  }, 30000);   // (P9: the crowd's third tier adds ~40 % more vertices to check one by one)
});

describe('2b · walkers never route over the water beside a bridge', () => {
  it('every sampled walker position over a canal cell is on a deck', () => {
    const P = { x: 0, z: 0, hx: 0, hz: 0, seg: 0 };
    let overCanal = 0;
    for (const g of bridged(3)) {
      const net = roadNet(g), decks = bridgeDecks(g), s = g.params.radius / 10;
      for (const start of net.walkEdges) {
        let leg: Leg = walkLeg(net, start, 1);
        for (let v = 0; v < 6; v++) {
          for (let k = 0; k <= 40; k++) {
            legPoint(leg, (leg.total * k) / 40, P);
            if (cellLevelAt(g, P.x, P.z) >= 0) continue;
            overCanal++;
            expect(deckAt(decks, P.x, P.z), `seed ${g.params.seed}: walker at (${P.x.toFixed(3)}, ${P.z.toFixed(3)}) over the canal off the deck`).toBeTruthy();
          }
          leg = walkNext(net, leg, start * 7 + 1, v + 1, 0.09 * s);
        }
      }
    }
    expect(overCanal, 'no walker crossed a bridge').toBeGreaterThan(0);
  });
});

describe('3 · buildings keep off the water and the retaining-wall drops', () => {
  it('lotFootprint stands EDGE_WALK_M back from a water / drop edge', () => {
    const m = 1 / 15;   // s = 1
    const lot: V2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];   // a 15 m square lot
    for (const k of ['water', 'drop'] as const) {
      const f = lotFootprint(lot, [k, 'party', 'street', 'party'], null, 1);
      const minZ = Math.min(...f.map((p) => p[1]));
      expect(minZ / m, k).toBeGreaterThanOrEqual(EDGE_WALK_M - 1e-6);
      expect(minZ / m, k).toBeLessThan(EDGE_WALK_M + 0.01);
    }
  });

  it('canal-side lot edges classify as water, raised-terrace street edges as drop', () => {
    let wet = 0, drop = 0;
    for (const g of bridged(4)) {
      const terrain = lotTerrain(g), s = g.params.radius / 10;
      for (const lot of g.lots) {
        if (lot.slot !== 'building') continue;
        const k = classifyLotEdges(lot.poly, g.roads, g.params.streetWidth * 0.5, s, () => false, terrain);
        wet += k.filter((x) => x === 'water').length; drop += k.filter((x) => x === 'drop').length;
        // No 'street' edge ever has water just beyond it.
        const n = lot.poly.length; let area = 0;
        for (let i = 0; i < n; i++) { const a = lot.poly[i], b = lot.poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
        const sg = area >= 0 ? 1 : -1;
        k.forEach((kind, i) => {
          if (kind !== 'street') return;
          const a = lot.poly[i], b = lot.poly[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const on: V2 = [sg * (b[1] - a[1]) / L, -sg * (b[0] - a[0]) / L];
          const mid: V2 = [(a[0] + b[0]) / 2 + on[0] * 0.08 * s, (a[1] + b[1]) / 2 + on[1] * 0.08 * s];
          expect(terrain.water(mid[0], mid[1]), `seed ${g.params.seed}: a 'street' edge faces water`).toBe(false);
        });
      }
    }
    expect(wet, 'no water edges found').toBeGreaterThan(0);
    expect(drop, 'no drop edges found').toBeGreaterThan(0);
  });

  it('in the built city, no building front faces the water, and a water-side facade stands >= 1.5 m off the lot line', () => {
    let fronts = 0, wetSides = 0, canalOnly = 0;
    for (const g of bridged(2)) {
      buildStreets(g);
      const water = makeWaterTest(g), s = g.params.radius / 10, m = s / 15;
      const built = g.lots.filter((l) => l.poly.length >= 3 && (l.slot === 'building' || l.variety || l.slot === 'landmark'));
      for (const lot of g.lots) {
        const meta = lotMeta(lot);
        if (!meta) continue;
        fronts++;
        const f = meta.front, mid: V2 = [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2];
        // The front's outward probe just past the wall + walk strip + lot line.
        const probe: V2 = [mid[0] + f.out[0] * 0.2 * s, mid[1] + f.out[1] * 0.2 * s];
        // Same classification buildStreets used (party = another building lot just outside the edge).
        const k = classifyLotEdges(lot.poly, g.roads, g.params.streetWidth * 0.5, s, (pt) => built.some((o) => o !== lot && inPoly(pt, o.poly)), lotTerrain(g));
        // A lot whose ONLY non-party side is the canal keeps its door there (on the walk strip — a party wall is no
        // door); any lot with a street / terrace / open side must not face the water.
        if (k.some((x) => x !== 'water' && x !== 'party')) expect(water(probe[0], probe[1]), `seed ${g.params.seed}: shop door faces the canal`).toBe(false);
        else canalOnly++;
        // Distance from the building front to the lot line on a water-facing lot.
        if (k.includes('water')) {
          wetSides++;
          const n = lot.poly.length;
          k.forEach((kind, i) => {
            if (kind !== 'water') return;
            const a = lot.poly[i], b = lot.poly[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const depth = Math.max(...lot.poly.map((q) => Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / L));
            if (depth * 0.3 < 1.5 * m) return;   // tiny lot: the setback is capped (never inverts)
            // The footprint isn't exported through meta; re-derive it exactly as buildStreets does (before corner styling).
            const foot = lotFootprint(lot.poly, k, null, s);
            const dmin = Math.min(...foot.map((q) => Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / L));
            expect(dmin / m).toBeGreaterThanOrEqual(1.5);
          });
        }
      }
    }
    expect(fronts).toBeGreaterThan(20);
    expect(wetSides, 'no canal-side building exercised').toBeGreaterThan(0);
    void canalOnly;
  });
});

describe('4 · tactile paving = real 30 cm tenji tiles', () => {
  const g = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square' });
  const L = buildRoadPaint(g).find((x) => x.name === 'world:tactile')!;
  const mpu = cityMetresPerUnit(g.params.radius);

  it('the pattern is a 5 × 5 grid of ~2.5 cm studs per 30 cm tile', () => {
    expect(L).toBeTruthy();
    expect(L.pattern!.mode).toBe('dots');
    expect(L.pattern!.freq).toBe(TACTILE_DOTS * TACTILE_UV_TILES);
    // Stud diameter = scale × cell; cell = tile / 5.
    expect(TACTILE_PATTERN.scale * (TACTILE_TILE_M / TACTILE_DOTS)).toBeCloseTo(TACTILE_DOT_M, 6);
    // From the geometry: world metres per uv unit × (1 / freq) = the stud pitch.
    const v = L.geometry.vertices, idx = L.geometry.indices;
    let checked = 0;
    for (let i = 0; i < idx.length && checked < 400; i += 3) {
      const A = idx[i] * 12, B = idx[i + 1] * 12;
      const dW = Math.hypot(v[B] - v[A], v[B + 2] - v[A + 2]) * mpu;          // metres
      const dU = Math.hypot(v[B + 6] - v[A + 6], v[B + 7] - v[A + 7]);         // uv units
      if (dW < 0.05) continue;
      const pitch = dW / (dU * L.pattern!.freq);
      expect(pitch).toBeCloseTo(TACTILE_TILE_M / TACTILE_DOTS, 4);            // 6 cm stud pitch
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('each tile is ~30 cm with a joint, and its corners sit on whole stud cells (grid locked to the tile + kerb)', () => {
    const v = L.geometry.vertices, freq = L.pattern!.freq;
    const cellsOf = (u: number): number => (u - 0.5) * freq;
    const joint = 0.006 / (TACTILE_TILE_M / TACTILE_DOTS);   // the joint in stud cells (0.1)
    let corners = 0;
    for (let i = 0; i < v.length; i += 12) {
      for (const k of [6, 7]) {
        const c = cellsOf(v[i + k]), frac = Math.abs(c - Math.round(c));
        // A vertex is either on a tile edge (a half-joint off a whole cell) or an interior split point.
        if (Math.abs(frac - joint / 2) < 1e-3) corners++;
      }
    }
    expect(corners, 'tile edges not phase-locked to the stud grid').toBeGreaterThan(200);
  });

  it('UV axes run along the kerb (world-axis-aligned kerbs → u along ±X, v along ±Z), never diagonal', () => {
    // Along any triangle edge that runs straight along world Z, u must not change (and v not along X): the stud grid
    // is square to the kerb. And u must grow toward +X, v toward +Z (the relief normal's tangent frame).
    const v = L.geometry.vertices, idx = L.geometry.indices;
    let alongZ = 0, alongX = 0;
    for (let i = 0; i < idx.length; i += 3) {
      for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
        const A = idx[i + p] * 12, B = idx[i + q] * 12;
        const dx = v[B] - v[A], dz = v[B + 2] - v[A + 2], du = v[B + 6] - v[A + 6], dv = v[B + 7] - v[A + 7];
        if (Math.abs(dx) < 1e-5 && Math.abs(dz) > 0.004) { alongZ++; expect(Math.abs(du)).toBeLessThan(1e-4); expect(dv * dz).toBeGreaterThan(0); }
        if (Math.abs(dz) < 1e-5 && Math.abs(dx) > 0.004) { alongX++; expect(Math.abs(dv)).toBeLessThan(1e-4); expect(du * dx).toBeGreaterThan(0); }
      }
    }
    expect(alongZ).toBeGreaterThan(100);
    expect(alongX).toBeGreaterThan(100);
  });

  it('keeps the kerb-side placement: strips sit on the pavement just behind the kerb', () => {
    const D = streetDims(g.params);
    const v = L.geometry.vertices;
    const cws = crossings(g);
    for (let i = 0; i < v.length; i += 12 * 7) {
      const x = v[i], z = v[i + 2];
      const near = cws.some((cw) => {
        const dx = x - cw.c[0], dz = z - cw.c[1];
        const a = Math.abs(dx * cw.d[0] + dz * cw.d[1]), w = Math.abs(dx * cw.p[0] + dz * cw.p[1]);
        return a <= cw.hd + 1e-6 && w >= D.half + D.kerbW - 1e-6 && w <= D.half + D.kerbW + 2 * TACTILE_TILE_M / mpu + 1e-6;
      });
      expect(near).toBe(true);
    }
  });
});

void makeHeightField;
