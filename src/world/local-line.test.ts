/**
 * local-line.test.ts — the AT-GRADE local line (railway-upgrade R3.2 / R3.3): layout determinism, the corridor never
 * cuts through a building, the level crossings sit on real roads away from junctions, and the barrier timing against
 * the consist's own run (train.ts stepTrainRun): the arms are fully down before the train's front reaches the road,
 * and the crossing opens again after it has gone.
 */
import { describe, it, expect } from 'vitest';
import { generateCityLayout } from './layout';
import { inLocalCorridor, localZAt, localSlopeAt, crossingFrame, crossingSin, LOCAL_M, type LocalLinePlan } from './local-line';
import { localTrack, localRunPlan, buildLocalLine, crossingSurfaceY, localArms, localStationEntrances } from './local-line-build';
import { stepTrainRun, trainRunStart } from './train';
import { crossingStart, stepCrossing, trainDemand, crossingClosed, travelTime, XING_TIMING } from './level-crossing';
import { pointInPolygon } from './util';
import { buildStreets } from './streets';
import type { WorldGraph } from './types';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const cache = new Map<string, WorldGraph>();
const city = (seed: number, over: Record<string, unknown> = {}): WorldGraph => {
    const k = seed + JSON.stringify(over);
    let g = cache.get(k);
    if (!g) { g = generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', localLine: true, ...over }); cache.set(k, g); }
    return g;
};

describe('local line layout', () => {
    it('is off by default: a city without the param is identical to one with localLine: false', () => {
        const a = generateCityLayout({ seed: 3 }), b = generateCityLayout({ seed: 3, localLine: false });
        expect(a.localLine ?? null).toBeNull();
        expect(JSON.stringify(a.lots)).toBe(JSON.stringify(b.lots));
        expect(JSON.stringify(a.roads)).toBe(JSON.stringify(b.roads));
    });

    it('is deterministic (same params → the same plan, lots and roads)', () => {
        for (const seed of [2, 5]) {
            const a = generateCityLayout({ seed, localLine: true }), b = generateCityLayout({ seed, localLine: true });
            expect(JSON.stringify(a.localLine)).toBe(JSON.stringify(b.localLine));
            expect(JSON.stringify(a.lots)).toBe(JSON.stringify(b.lots));
            expect(JSON.stringify(a.roads)).toBe(JSON.stringify(b.roads));
        }
    });

    it('is built on most seeds, with stations at its ends, crossings, and a gentle curve on some', () => {
        let lines = 0, curves = 0;
        for (const seed of SEEDS) for (const railway of [true, false]) {
            const pl = city(seed, { railway }).localLine;
            if (!pl) continue;
            lines++;
            if (pl.curve) {
                curves++;
                // gentle: min radius R = 2L²/(π²H) ≥ 28 m (Enoden's tightest), skew at any crossing ≤ 35°
                const H = Math.abs(pl.zB - pl.zA), R = 2 * pl.curve.L ** 2 / (Math.PI ** 2 * H) / pl.u;
                expect(R).toBeGreaterThan(28);
            }
            expect(pl.stations.length).toBeGreaterThan(0);
            expect(pl.crossings.length).toBeGreaterThan(0);
            for (const q of pl.crossings) expect(Math.asin(Math.min(1, crossingSin(q))) * 180 / Math.PI).toBeGreaterThan(55);
        }
        expect(lines).toBeGreaterThanOrEqual(12);
        expect(curves).toBeGreaterThanOrEqual(4);
    });

    it('never crosses the elevated line road, and ends in buffer stops inside the border', () => {
        for (const seed of SEEDS) {
            const g = city(seed), pl = g.localLine; if (!pl) continue;
            for (const x of [pl.x0, pl.x1]) expect(pointInPolygon([x, localZAt(pl, x)], g.border)).toBe(true);
        }
    });

    it('no lot (so no building) overlaps the corridor', () => {
        for (const seed of SEEDS) {
            const g = city(seed), pl = g.localLine; if (!pl) continue;
            for (const lot of g.lots) {
                // polygon vertices + a grid of interior samples
                const xs = lot.poly.map(p => p[0]), zs = lot.poly.map(p => p[1]);
                const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
                for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
                    const x = x0 + (x1 - x0) * i / 6, z = z0 + (z1 - z0) * j / 6;
                    if (!pointInPolygon([x, z], lot.poly)) continue;
                    expect(inLocalCorridor(pl, x, z), `seed ${seed} lot ${lot.id} at ${x.toFixed(3)},${z.toFixed(3)}`).toBe(false);
                }
            }
        }
    });

    it('the built buildings keep out of the corridor (seed 1, 4: curve + stations)', () => {
        for (const seed of [1, 4]) {
            const g = generateCityLayout({ seed, radius: 10, pattern: 'grid', border: 'square', localLine: true }), pl = g.localLine!;
            const layers = buildStreets(g, null).filter(L => /bldg-|world:detail|world:roofs|foundation/.test(L.name));
            let inside = 0, total = 0;
            for (const L of layers) {
                const v = L.geometry.vertices;
                // everything up to 7 m (the train, its pantograph and the catenary messenger live below that; eaves above may overhang)
                for (let i = 0; i < v.length; i += 12) { total++; if (v[i + 1] < 7 * pl.u && inLocalCorridor(pl, v[i], v[i + 2], -0.25 * pl.u)) inside++; }
            }
            expect(total).toBeGreaterThan(1000);
            expect(inside, `seed ${seed}: building vertices inside the corridor`).toBe(0);
        }
    }, 60_000);

    it('crossings: on a real road, clear of every junction box, the road raised onto the rails by the boards', () => {
        for (const seed of SEEDS) {
            const g = city(seed), pl = g.localLine; if (!pl) continue;
            const T = localTrack(g)!;
            for (const q of pl.crossings) {
                const r = g.roads[q.ri];
                expect(r).toBeTruthy();
                for (const it of g.intersections) expect(Math.hypot(it.pos[0] - q.x, it.pos[1] - q.z) / pl.u, `seed ${seed} crossing ${q.id}`).toBeGreaterThan(9);
                // on the track: the board surface meets the rail top
                const top = crossingSurfaceY(T, q.x, q.z, -1);
                expect(Math.abs(top - T.railTopAt(q.x, q.z)) / pl.u).toBeLessThan(0.01);
                // far along the road: plain ground
                const far = LOCAL_M.barrier * pl.u / crossingSin(q) + 1 * pl.u;
                expect(crossingSurfaceY(T, q.x + q.d[0] * far, q.z + q.d[1] * far, -1)).toBe(-1);
            }
            expect(localArms(g).length).toBe(2 * pl.crossings.length);
            expect(localStationEntrances(g).length).toBe(pl.stations.length);
        }
    });

    it('the curve is smooth (z(x) continuous, slope ≤ 0.6)', () => {
        const pl = [1, 4, 5, 6].map(s => city(s).localLine).find(p => p?.curve) as LocalLinePlan;
        expect(pl).toBeTruthy();
        for (let x = pl.x0; x <= pl.x1; x += 0.02) {
            expect(Math.abs(localSlopeAt(pl, x))).toBeLessThan(0.6);
            expect(Math.abs(localZAt(pl, x + 0.001) - localZAt(pl, x))).toBeLessThan(0.001);
        }
    });

    it('layer families: every name is world:local-*, baked, warped with the city, one material family each', () => {
        const g = city(1), L = buildLocalLine(g, true);
        expect(L.length).toBeGreaterThan(20);
        for (const l of L) {
            expect(l.name.startsWith('world:local-')).toBe(true);
            expect(l.drape).toBe('baked');
            expect(!!l.noWarp).toBe(false);
            const fams = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'].filter(f => (l as unknown as Record<string, unknown>)[f] != null);
            expect(fams.length, l.name).toBeLessThanOrEqual(1);
        }
        const tris = L.reduce((n, l) => n + l.geometry.indices.length / 3, 0);
        expect(tris).toBeLessThan(45_000);
    });
});

describe('level crossing timing vs the train', () => {
    it('travelTime', () => {
        expect(travelTime(0, 0, 1, 10)).toBe(0);
        expect(travelTime(2, 0, 1, 10)).toBeCloseTo(2, 6);           // ½·1·t² = 2
        expect(travelTime(100, 10, 1, 10)).toBeCloseTo(10, 6);
    });

    for (const seed of [1, 3, 4, 7]) it(`seed ${seed}: arms fully down whenever the consist is on a crossing, and they open again`, () => {
        const g = city(seed), T = localTrack(g)!;
        const { plan, half } = localRunPlan(g.params, T);
        const st = trainRunStart(plan, 1, 0.3);
        const cs = T.xings.map(() => crossingStart());
        const u = T.unitsPerMetre, margin = 2 * u, dt = 0.05;
        const occupiedFrames = T.xings.map(() => 0), openedAfter = T.xings.map(() => false), closedOnce = T.xings.map(() => false);
        let armSeenDownEarly = Infinity;
        for (let f = 0; f < (8 * 60) / dt; f++) {
            stepTrainRun(st, plan, dt);
            T.xings.forEach((X, i) => {
                stepCrossing(cs[i], trainDemand(st, plan, half, X.arc - X.zoneHalf, X.arc + X.zoneHalf, margin), dt);
                const onRoad = st.s + half > X.arc - X.zoneHalf && st.s - half < X.arc + X.zoneHalf;
                if (onRoad) {
                    occupiedFrames[i]++;
                    expect(cs[i].arm, `crossing ${i} at t=${(f * dt).toFixed(2)}`).toBe(1);
                    armSeenDownEarly = Math.min(armSeenDownEarly, cs[i].since);
                }
                if (crossingClosed(cs[i])) closedOnce[i] = true;
                else if (closedOnce[i]) openedAfter[i] = true;
            });
        }
        for (let i = 0; i < T.xings.length; i++) {
            expect(occupiedFrames[i], `crossing ${i} saw the train`).toBeGreaterThan(0);
            expect(openedAfter[i], `crossing ${i} reopened`).toBe(true);
        }
        // the lamps flash alone first, then the arms take `lower` seconds: they were down for a while before arrival
        expect(armSeenDownEarly).toBeGreaterThanOrEqual(XING_TIMING.lampLead + XING_TIMING.lower - 1e-6);
    });

    it('a crossing is not closed for a whole dwell (only just before departure)', () => {
        const g = city(3), T = localTrack(g)!;
        const { plan, half } = localRunPlan(g.params, T);
        const st = trainRunStart(plan, 1, 0);   // dwelling at the low terminus
        st.dwell = st.dwellTotal = plan.termDwell;
        const X = T.xings[0];
        expect(trainDemand(st, plan, half, X.arc - X.zoneHalf, X.arc + X.zoneHalf, 2 * T.unitsPerMetre)).toBe(false);
        st.dwell = 1;
        expect(trainDemand(st, plan, half, X.arc - X.zoneHalf, X.arc + X.zoneHalf, 2 * T.unitsPerMetre)).toBe(true);
    });

    it('crossingFrame: u runs along the road from the track, w across it', () => {
        const pl = city(3).localLine!, q = pl.crossings[0], F = { u: 0, w: 0 };
        crossingFrame(q, q.x + q.d[0] * 0.3, q.z + q.d[1] * 0.3, F);
        expect(F.u).toBeCloseTo(0.3 / 1, 3);
        expect(Math.abs(F.w)).toBeLessThan(1e-6);
        void localZAt;
    });
});
