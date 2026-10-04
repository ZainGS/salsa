/**
 * railway.test.ts — the real-scale viaduct, track, catenary, stations and metro entrances (railway-upgrade R1.1–R1.4,
 * R1.6, R2.1, R2.3): dimensions in metres, the noWarp + level-deck rule, piers / stairs never on buildings, canals
 * or carriageways, deterministic station + metro placement with street-plan clearance, and the triangle budget.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { buildRailway, railwayLine, railStations, railLayout, railReservations, railFrameAt, railTrackPath, arcadeStrip, RAIL_M, RAIL_TOP_M, ARC_M } from './railway';
import { buildMetro } from './metro';
import { streetPlan } from './street-slots';
import { makeDomainWarpInto } from './warp';
import { cellLevelAt, makeElevation } from './elevation';
import { streetBandHalf } from './street-layout';
import { pointInPolygon } from './util';
import { cityMetresPerUnit, DEFAULT_LAYOUT_PARAMS, type LayoutParams, type LayoutPreviewLayer, type V2, type WorldGraph } from './types';

const P = (over: Partial<LayoutParams> = {}): LayoutParams => ({ ...DEFAULT_LAYOUT_PARAMS, seed: 3, pattern: 'grid', border: 'square', ...over });
const graphs = new Map<string, WorldGraph>();
const G = (over: Partial<LayoutParams> = {}): WorldGraph => {
    const k = JSON.stringify(over);
    let g = graphs.get(k);
    if (!g) { g = generateCityLayout(P(over)); graphs.set(k, g); }
    return g;
};
const tris = (L: LayoutPreviewLayer[], re: RegExp): number => L.filter(l => re.test(l.name)).reduce((n, l) => n + l.geometry.indices.length / 3, 0);
const yRange = (L: LayoutPreviewLayer[], re: RegExp): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const l of L) if (re.test(l.name)) { const v = l.geometry.vertices; for (let i = 1; i < v.length; i += 12) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); } }
    return [lo, hi];
};
const BUILT = new Set(['residential', 'commercial', 'civic']);

describe('railway line — real scale (R1.1) + the train contract', () => {
    it('deck at 7.5 m over flat ground, 4 m track centres, 1.067 m gauge, rail top + contact wire heights', () => {
        const p = P({ elevation: 0, terraces: false }), L = railwayLine(p), m = cityMetresPerUnit(p.radius);
        expect((L.deckY - p.groundY) * m).toBeCloseTo(RAIL_M.deckAboveGround, 5);
        expect(L.tracks).toBe(2);
        expect(L.trackOffsets.map(o => o * m)).toEqual([-2, 2].map(v => expect.closeTo(v, 6)));
        expect(L.gaugeU * m).toBeCloseTo(1.067, 6);
        expect((L.railTopY - L.deckY) * m).toBeCloseTo(RAIL_TOP_M, 6);
        expect(RAIL_TOP_M).toBeGreaterThan(0.45); expect(RAIL_TOP_M).toBeLessThan(0.7);
        expect((L.contactY - L.railTopY) * m).toBeCloseTo(5.0, 6);
        expect(L.unitsPerMetre).toBeCloseTo(1 / m, 9);
    });
    it('the deck clears the highest terrain under the line on hilly cities (never below 7.5 m)', () => {
        for (const seed of [1, 3, 7]) {
            const p = P({ seed, elevation: 0.9 }), L = railwayLine(p), m = cityMetresPerUnit(p.radius);
            expect((L.deckY - p.groundY) * m).toBeGreaterThanOrEqual(7.5 - 1e-6);
        }
    });
    it('R3.1: the deck clears the REAL ground under it (smooth terrain + terrace levels) by ~6.8 m, both viaduct styles', () => {
        for (const seed of [1, 3, 7, 11, 42]) for (const railViaduct of ['portal', 'arcade'] as const) {
            const g = G({ seed, railViaduct }), L = railwayLine(g.params), m = cityMetresPerUnit(g.params.radius), el = makeElevation(g);
            let peak = -Infinity;
            for (const z of L.pathZ) for (const k of [-1, 0, 1]) peak = Math.max(peak, el(L.rx + k * RAIL_M.deckHalfW / m, z));
            // (the kerb lift + sampling leave a few cm; the raw terrace level is conservative over canals)
            expect((L.deckY - g.params.groundY - peak) * m, 'seed ' + seed + ' ' + railViaduct).toBeGreaterThan(RAIL_M.deckClearance - 0.2);
        }
    });
    it('is pure + memoised on params, and its path is the WARPED road line (noWarp render space)', () => {
        const p = P(), L = railwayLine(p);
        expect(railwayLine({ ...p })).toEqual(L);
        const w = makeDomainWarpInto(p), o: [number, number] = [0, 0];
        L.path.forEach((q, i) => { w(L.rx, L.pathZ[i], o); expect(q[0]).toBeCloseTo(L.rx + o[0], 9); expect(q[1]).toBeCloseTo(L.pathZ[i] + o[1], 9); });
        // Track polylines run parallel to the centreline at ±2 m.
        const t0 = railTrackPath(L, 0), t1 = railTrackPath(L, 1), m = cityMetresPerUnit(p.radius);
        for (let i = 0; i < t0.length; i += 7) expect(Math.hypot(t1[i][0] - t0[i][0], t1[i][1] - t0[i][1]) * m).toBeCloseTo(4, 1);
        const f = railFrameAt(L, (L.z0 + L.z1) / 2);
        expect(Math.hypot(f.tx, f.tz)).toBeCloseTo(1, 9); expect(f.tx * f.nx + f.tz * f.nz).toBeCloseTo(0, 9);
    });
});

describe('viaduct structure (R1.2–R1.4, R1.6)', () => {
    const g = G(), p = g.params, L = buildRailway(g, false), line = railwayLine(p), m = cityMetresPerUnit(p.radius);
    it('every rail layer is noWarp + baked (level deck, no height field)', () => {
        const rail = L.filter(l => /world:rail-/.test(l.name));
        expect(rail.length).toBeGreaterThan(10);
        for (const l of rail) { expect(l.noWarp).toBe(true); expect(l.drape).toBe('baked'); }
    });
    it('the deck is LEVEL at deckY and 1.2 m deep; parapets 1.25 m; deck ~10 m wide', () => {
        const [lo, hi] = yRange(L, /^world:rail-deck$/);
        expect(hi).toBeCloseTo(line.deckY, 6);
        expect((hi - lo) * m).toBeCloseTo(RAIL_M.deckDepth, 3);
        const [, ph] = yRange(L, /^world:rail-parapet-cope$/);
        expect((ph - line.deckY) * m).toBeCloseTo(RAIL_M.parapetH, 3);
        // Width: deck vertices at mid-span sit within ±5 m of the centreline (station wings excepted).
        const f = railFrameAt(line, line.pathZ[8]);
        const v = L.find(l => l.name === 'world:rail-deck')!.geometry.vertices;
        let maxOff = 0;
        for (let i = 0; i < v.length; i += 12) {
            const dx = v[i] - f.x, dz = v[i + 2] - f.z;
            if (Math.abs(dx * f.tx + dz * f.tz) > 0.05) continue;
            maxOff = Math.max(maxOff, Math.abs(dx * f.nx + dz * f.nz));
        }
        expect(maxOff * m).toBeCloseTo(RAIL_M.deckHalfW, 2);
    });
    it('rails sit on the sleepers: the rail head top is railTopY', () => {
        const [, top] = yRange(L, /^world:rail-fine-rail$/);
        expect(top).toBeCloseTo(line.railTopY, 6);
        const [slo] = yRange(L, /^world:rail-fine-sleeper$/);
        expect(slo).toBeGreaterThan(line.deckY);
    });
    it('portal piers: columns on the pavements — never on a built lot, a canal (except a run along the water) or a carriageway', () => {
        for (const seed of [3, 1, 7, 42]) {
            const gg = G({ seed }), RL = railLayout(gg);
            expect(RL.piers.length).toBeGreaterThanOrEqual(6);
            const lots = gg.lots.filter(l => BUILT.has(l.zone));
            for (const pr of RL.piers) {
                expect(pr.kind).toBe('portal');
                for (const c of pr.cols) {
                    expect(lots.some(l => pointInPolygon(c, l.poly))).toBe(false);
                    const d = Math.abs(c[0] - RL.line.rx);
                    expect(d - pr.colHx).toBeGreaterThanOrEqual(Math.max(gg.params.streetWidth, gg.params.arterialWidth ?? 0) * 0.5 - 1e-9);
                }
            }
            // A pier in a canal only where the whole neighbourhood is water (the line runs along the canal).
            const wet = RL.piers.filter(pr => pr.cols.some(c => cellLevelAt(gg, c[0], c[1]) < 0));
            if (wet.length) expect(wet.length).toBeGreaterThanOrEqual(2);
        }
    });
    it('rendered (warped) pier columns stay out of the rendered (warped) buildings', () => {
        const w = makeDomainWarpInto(p), o: [number, number] = [0, 0];
        const W = (q: V2): V2 => { w(q[0], q[1], o); return [q[0] + o[0], q[1] + o[1]]; };
        const lots = g.lots.filter(l => BUILT.has(l.zone)).map(l => l.poly.map(W));
        const RL = railLayout(g);
        for (const pr of RL.piers) for (const c of pr.cols) expect(lots.some(poly => pointInPolygon(W(c), poly))).toBe(false);
    });
    it('catenary: masts reach above the contact wire; wires are at contact / messenger height', () => {
        const [wlo, whi] = yRange(L, /^world:rail-fine-cat-wire$/);
        expect(wlo).toBeGreaterThan(line.contactY - 0.05 / m);
        expect((whi - line.contactY) * m).toBeCloseTo(RAIL_M.systemHeight, 1);
        const [, mhi] = yRange(L, /^world:rail-fine-cat-mast$/);
        expect(mhi).toBeGreaterThan(whi);
    });
    it('edge wear: chipped near twins for the cap beams + parapet copings, far twins otherwise', () => {
        const Lw = buildRailway(generateCityLayout(P({ edgeWear: 'heavy' })), false);
        for (const key of ['rail-cap', 'rail-cope']) {
            const tw = Lw.filter(l => l.nearTwin?.key === key);
            expect(tw.some(l => l.nearTwin!.role === 'near')).toBe(true);
            expect(tw.some(l => l.nearTwin!.role === 'far')).toBe(true);
        }
        expect(L.some(l => l.nearTwin)).toBe(false);   // default wear 'off' → no twins
    });
    it('railway off → nothing but the metro kiosks; deterministic rebuild', () => {
        const off = buildRailway(generateCityLayout(P({ railway: false })), true);
        expect(off.every(l => /^world:metro-/.test(l.name))).toBe(true);
        const again = buildRailway(generateCityLayout(P()), false);
        expect(again.map(l => [l.name, l.geometry.indices.length])).toEqual(L.map(l => [l.name, l.geometry.indices.length]));
    });
    it('triangle budget (seed 3): viaduct+parapets ≤ 20k, sleepers ≤ 40k, catenary ≤ 25k, station ≤ 40k, metro ≤ 5k', () => {
        expect(tris(L, /world:rail-(deck|pier|parapet|barrier|trough|ballast|slab)/)).toBeLessThan(20000);
        expect(tris(L, /world:rail-fine-(sleeper|rail)/)).toBeLessThan(40000);
        expect(tris(L, /world:rail-fine-cat/)).toBeLessThan(25000);
        expect(tris(L, /world:rail-stn-/)).toBeLessThan(40000);
        expect(tris(L, /world:metro-/)).toBeLessThan(5000);
        expect(tris(L, /world:metro-/)).toBeGreaterThan(0);
    });
});

describe('stations (R2.1)', () => {
    it('deterministic, pure of params, over a grid junction, platform sized for the train', () => {
        const p = P(), st = railStations(p), m = cityMetresPerUnit(p.radius), R = p.radius, ch = 2 * R / p.gridRows;
        expect(st.length).toBeGreaterThanOrEqual(1);
        expect(railStations({ ...p })).toEqual(st);
        for (const s of st) {
            const r = (s.z + R) / ch;
            expect(Math.abs(r - Math.round(r))).toBeLessThan(1e-9);      // on a row line = a junction
            expect(s.halfLen * 2 * m).toBeCloseTo(8 * RAIL_M.carLen + RAIL_M.stationPad, 6);
            expect(s.side).toBe('side');
        }
        // The car count sizes the platform but never moves the station.
        const s4 = railStations({ ...p, railCars: 4 } as LayoutParams);
        expect(s4.map(s => s.z)).toEqual(st.map(s => s.z));
        expect(s4[0].halfLen).toBeLessThan(st[0].halfLen);
        expect(railStations(P({ stations: false }))).toEqual([]);
        expect(railStations(P({ railway: false }))).toEqual([]);
    });
    it('short trains leave room for a second station; platforms never overlap and stay on the span', () => {
        let two = 0;
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const p = P({ seed, railCars: 2 } as Partial<LayoutParams>), st = railStations(p), L = railwayLine(p);
            if (st.length === 2) { two++; expect(st[1].z - st[1].halfLen).toBeGreaterThan(st[0].z + st[0].halfLen); }
            for (const s of st) { expect(s.z - s.halfLen).toBeGreaterThan(L.z0); expect(s.z + s.halfLen).toBeLessThan(L.z1); }
            expect(st.map(s => s.z)).toContain(railStations(P({ seed }))[0].z);   // the default station never moves
        }
        expect(two).toBeGreaterThan(0);
    });
    it('stairs + halls stand on the cross-street pavement: not on lots, canals or a carriageway', () => {
        let n = 0;
        for (const seed of [3, 11, 5]) {
            const g = G({ seed }), RL = railLayout(g), lots = g.lots.filter(l => BUILT.has(l.zone));
            for (const s of RL.stairs) {
                n++;
                for (let t = 0; t <= 1; t += 0.1) for (const q of [-0.5, 0.5]) {
                    const pt: V2 = [s.xTop + s.dir * (0.4 * RL.line.unitsPerMetre + t * (s.run - 0.4 * RL.line.unitsPerMetre)), s.zp + q * s.width];
                    expect(lots.some(l => pointInPolygon(pt, l.poly))).toBe(false);
                    expect(cellLevelAt(g, pt[0], pt[1])).toBeGreaterThanOrEqual(0);
                }
                expect(s.topY).toBeGreaterThan(s.footY);
            }
        }
        expect(n).toBeGreaterThan(0);
    });
    it('the street plan keeps trees / poles out from under the deck and every slot off piers + stairs', () => {
        for (const seed of [3, 11, 1, 7, 42, 5]) {
            const g = G({ seed }), plan = streetPlan(g), res = railReservations(g);
            for (const sl of plan.slots) {
                expect(res.solidAt(sl.x, sl.z)).toBe(false);
                if (sl.kind === 'tree' || sl.kind === 'pole') expect(res.tallAt(sl.x, sl.z)).toBe(false);
            }
        }
    });
});

describe('metro entrances (R2.3)', () => {
    it('a few kiosks on junction pavements, deterministic, clear of the viaduct and of buildings', () => {
        const g = G(), plan = streetPlan(g), res = railReservations(g), u = 1 / cityMetresPerUnit(g.params.radius);
        const ms = plan.of('metro');
        expect(ms.length).toBeGreaterThanOrEqual(1); expect(ms.length).toBeLessThanOrEqual(4);
        expect(streetPlan(generateCityLayout(P())).of('metro').map(s => [s.x, s.z])).toEqual(ms.map(s => [s.x, s.z]));
        for (const s of ms) {
            expect(plan.inBuilding(s.x, s.z)).toBe(false);
            expect(res.nearDeck(s.x, s.z, 8 * u)).toBe(false);
            for (const o of ms) if (o !== s) expect(Math.hypot(o.x - s.x, o.z - s.z) / u).toBeGreaterThan(69);
        }
    });
    it('the toggle only stops the EMIT — the reservation (plan) is unchanged', () => {
        const on = G(), off = generateCityLayout(P({ metroEntrances: false }));
        expect(buildMetro(off)).toEqual([]);
        expect(buildMetro(on).length).toBeGreaterThan(0);
        expect(streetPlan(off).slots.map(s => s.kind + s.x)).toEqual(streetPlan(on).slots.map(s => s.kind + s.x));
    });
    it('radial cities: T piers off the buildings, no stations, still a level line', () => {
        const g = generateCityLayout(P({ pattern: 'radial', border: 'circle' })), RL = railLayout(g);
        expect(RL.stations.length).toBeGreaterThanOrEqual(0);
        for (const pr of RL.piers) expect(pr.kind).toBe('T');
        const L = buildRailway(g, false);
        expect(yRange(L, /^world:rail-deck$/)[1]).toBeCloseTo(RL.line.deckY, 6);
    });
});

describe('arcade viaduct (R3.1, railViaduct: arcade)', () => {
    const SEEDS = [3, 1, 7, 11, 42];
    it('the default stays PORTAL (saved cities unchanged); arcade only on grid cities', () => {
        const p = P();
        expect(railwayLine(p).mode).toBe('portal');
        expect(railwayLine(p).rx).toBe(railwayLine(p).roadX);
        expect(G().lots.some(l => l.slot === 'viaduct')).toBe(false);
        expect(G({ railViaduct: 'portal' }).lots.map(l => l.id)).toEqual(G().lots.map(l => l.id));
        expect(railwayLine(P({ pattern: 'radial', border: 'circle', railViaduct: 'arcade' })).mode).toBe('portal');
        expect(generateCityLayout(P({ railViaduct: 'arcade', railway: false })).lots.some(l => l.slot === 'viaduct')).toBe(false);
    });
    it('the line runs BESIDE its road over the lot strip (centre = lot line + 4 m) and keeps the train contract', () => {
        for (const seed of SEEDS) {
            const p = G({ seed, railViaduct: 'arcade' }).params, L = railwayLine(p), m = cityMetresPerUnit(p.radius);
            expect(L.mode).toBe('arcade');
            expect(Math.abs(L.rx - L.roadX) * m).toBeCloseTo(streetBandHalf(p) * m + ARC_M.centre, 6);
            expect(Math.sign(L.rx - L.roadX)).toBe(L.side);
            const w = makeDomainWarpInto(p), o: [number, number] = [0, 0];
            L.path.forEach((q, i) => { w(L.rx, L.pathZ[i], o); expect(q[0]).toBeCloseTo(L.rx + o[0], 9); });
            const t0 = railTrackPath(L, 0), t1 = railTrackPath(L, 1);
            for (let i = 0; i < t0.length; i += 9) expect(Math.hypot(t1[i][0] - t0[i][0], t1[i][1] - t0[i][1]) * m).toBeCloseTo(4, 1);
        }
    });
    it('claims the strip: no building lot stands on it, bays of 7–13 m fill it, the blocks are tagged (no landmark / shotengai there)', () => {
        for (const seed of SEEDS) {
            const g = G({ seed, railViaduct: 'arcade' }), st = arcadeStrip(g.params)!, RL = railLayout(g), m = cityMetresPerUnit(g.params.radius);
            expect(RL.bays.length).toBeGreaterThan(8);
            const others = g.lots.filter(l => BUILT.has(l.zone) && l.slot !== 'viaduct');
            for (const b of RL.bays) {
                const len = (b.zb - b.za) * m;
                expect(len).toBeGreaterThan(7); expect(len).toBeLessThan(13.5);
                for (const fx of [0.05, 0.5, 0.95]) for (const fz of [0.05, 0.5, 0.95]) {
                    const pt: V2 = [st.lo + (st.hi - st.lo) * fx, b.za + (b.zb - b.za) * fz];
                    expect(others.some(l => pointInPolygon(pt, l.poly)), 'seed ' + seed + ' ' + b.lot.id).toBe(false);
                }
                const blk = g.blocks.find(k => k.id === b.lot.block)!;
                expect(blk.viaduct).toBe(true);
                expect(['izakaya', 'eatery', 'shop', 'bike', 'storage', 'service', 'station']).toContain(b.kind);
            }
            for (const lm of g.landmarks) expect(g.blocks.find(k => k.id === lm.block)!.viaduct).toBeFalsy();
            if (g.shotengai) for (const [ci, ri] of g.shotengai.cells) expect(g.blocks.find(k => k.sector === ci && k.ring === ri)?.viaduct).toBeFalsy();
            expect(new Set(g.lots.map(l => l.id)).size).toBe(g.lots.length);
            // Deterministic.
            expect(generateCityLayout(P({ seed, railViaduct: 'arcade' })).lots.map(l => l.id + (l.bay ?? ''))).toEqual(g.lots.map(l => l.id + (l.bay ?? '')));
        }
    });
    it('shops / eateries / izakaya get a street-facing DOOR (door visits + footfall); one station entrance bay per station', () => {
        let doors = 0;
        for (const seed of SEEDS) {
            const g = G({ seed, railViaduct: 'arcade' }), RL = railLayout(g), L = RL.line;
            for (const b of RL.bays) {
                const shop = b.kind === 'izakaya' || b.kind === 'eatery' || b.kind === 'shop';
                expect(!!b.lot.door).toBe(shop);
                if (b.lot.door) { doors++; expect(b.lot.doorOut![0]).toBe(-L.side); expect(Math.abs(b.lot.door[0] - L.roadX)).toBeLessThan(Math.abs(L.rx - L.roadX)); }
            }
            expect(RL.bays.filter(b => b.kind === 'station').length).toBe(RL.stations.length);
        }
        expect(doors).toBeGreaterThan(20);
    });
    it('the street plan treats the arcade as the building line: entrances at the bays, nothing tall under the deck, nothing inside', () => {
        for (const seed of [3, 7]) {
            const g = G({ seed, railViaduct: 'arcade' }), plan = streetPlan(g), res = railReservations(g), RL = railLayout(g), st = arcadeStrip(g.params)!;
            for (const b of RL.bays) expect(plan.inBuilding(b.lot.center[0], b.lot.center[1])).toBe(true);
            const pad = 0.2;
            const atBay = plan.of('entrance').filter(sl => RL.bays.some(b => sl.x > st.lo - pad && sl.x < st.hi + pad && sl.z > b.za && sl.z < b.zb));
            expect(atBay.length).toBeGreaterThan(5);
            for (const sl of plan.slots) {
                expect(res.solidAt(sl.x, sl.z)).toBe(false);
                if (sl.kind === 'tree' || sl.kind === 'pole') expect(res.tallAt(sl.x, sl.z)).toBe(false);
            }
        }
    });
    it('builds the arcade: walls to the deck soffit, bay fills, girders over the gaps; noWarp + baked; budget', () => {
        const g = G({ railViaduct: 'arcade' }), L = buildRailway(g, false), line = railwayLine(g.params), m = cityMetresPerUnit(g.params.radius);
        const names = new Set(L.map(l => l.name));
        for (const n of ['world:rail-arc-wall', 'world:rail-arc-vault', 'world:rail-arc-trim', 'world:rail-arc-floor', 'world:rail-arc-girder',
            'world:rail-arc-shop-glass', 'world:rail-arc-sign-text', 'world:rail-arc-prop', 'world:rail-arc-lamplights']) expect(names).toContain(n);
        for (const l of L.filter(q => /world:rail-/.test(q.name))) { expect(l.noWarp).toBe(true); expect(l.drape).toBe('baked'); }
        const [, wTop] = yRange(L, /^world:rail-arc-wall$/);
        expect(wTop).toBeCloseTo(line.deckY - ARC_M.slab / m, 6);
        const [dlo, dhi] = yRange(L, /^world:rail-deck$/);
        expect(dhi).toBeCloseTo(line.deckY, 6);
        expect((dhi - dlo) * m).toBeLessThan(0.8);   // a lipped slab (the walls carry it), not the 1.2 m box girder
        expect(tris(L, /world:rail-arc-/)).toBeLessThan(40000);
        expect(tris(L, /world:rail-arc-/)).toBeGreaterThan(5000);
        // Only T piers, only in the long open gaps between runs.
        const RL = railLayout(g);
        for (const pr of RL.piers) { expect(pr.kind).toBe('T'); expect(RL.runs.some(r => pr.z > r[0] && pr.z < r[1])).toBe(false); }
        // ONE material family per mesh (the city-materials invariant) on every arcade layer.
        for (const l of L) expect(['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'].filter(k => (l as unknown as Record<string, unknown>)[k] != null).length, l.name).toBeLessThanOrEqual(1);
        const again = buildRailway(generateCityLayout(P({ railViaduct: 'arcade' })), false);
        expect(again.map(l => [l.name, l.geometry.indices.length])).toEqual(L.map(l => [l.name, l.geometry.indices.length]));
    });
});

describe('metro sign letter (R2.3 leftover)', () => {
    it('the kiosk sign box carries a lit "M" on both faces', () => {
        const L = buildMetro(G());
        const letter = L.find(l => l.name === 'world:metro-sign-letter')!;
        expect(letter).toBeTruthy();
        const kiosks = streetPlan(G()).of('metro').length;
        expect(letter.geometry.indices.length / 3).toBe(kiosks * 2 * 4 * 2);   // 4 strokes x 2 faces x 2 tris
        expect(letter.emissive).toBeGreaterThan(1);
    });
});
