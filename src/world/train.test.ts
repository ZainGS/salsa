/**
 * train.test.ts — the EMU commuter train (railway-upgrade R1.5) and its station-stop run (R2.2).
 */
import { describe, it, expect } from 'vitest';
import {
    emuCarLayers, emuCarTris, railLivery, railConsists, buildParkedTrain, consistPlan, railCarCount,
    trainRunPlan, trainRunStart, stepTrainRun, railTrackInfo, EMU_CAR_M, EMU_PANTO_M, RAIL_LIVERIES, type EmuVariant,
} from './train';
import { railwayLine } from './railway';
import { cityMetresPerUnit, DEFAULT_LAYOUT_PARAMS, type LayoutParams, type LayoutPreviewLayer } from './types';

const P = (over: Partial<LayoutParams> = {}): LayoutParams => ({ ...DEFAULT_LAYOUT_PARAMS, seed: 3, radius: 10, ...over });

/** AABB of a layer set in METRES (x along the car, y above the rail top, z across). */
function boundsM(layers: LayoutPreviewLayer[], radius: number, filter: (n: string) => boolean = () => true) {
    const m = cityMetresPerUnit(radius);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const L of layers) {
        if (!filter(L.name)) continue;
        const v = L.geometry.vertices;
        for (let i = 0; i < v.length; i += 12) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k] * m); hi[k] = Math.max(hi[k], v[i + k] * m); }
    }
    return { len: hi[0] - lo[0], h: hi[1] - lo[1], w: hi[2] - lo[2], lo, hi };
}

describe('EMU car — real dimensions', () => {
    for (const radius of [10, 22]) {
        it(`a mid car is a ~20 m × 2.9 m × 3.9 m commuter car (radius ${radius})`, () => {
            const L = emuCarLayers(P({ radius }), 'mid', 0);
            const body = boundsM(L, radius, n => /train(-lower|-roof)?$/.test(n));
            expect(body.len).toBeGreaterThan(19.3); expect(body.len).toBeLessThan(19.7);
            expect(body.w).toBeGreaterThan(2.85); expect(body.w).toBeLessThan(2.95);
            expect(body.hi[1]).toBeCloseTo(3.68, 1);
            const all = boundsM(L, radius);
            expect(all.lo[1]).toBeGreaterThanOrEqual(-1e-6);              // wheels sit ON the rail top
            expect(all.hi[1]).toBeGreaterThan(3.85); expect(all.hi[1]).toBeLessThan(4.0);   // AC units on the roof
            expect(all.len).toBeLessThanOrEqual(EMU_CAR_M + 0.01);         // gangways fit inside the 20 m car pitch
            expect(all.w).toBeLessThan(3.1);                               // door leaves stay within a 3.1 m envelope
        });
    }
    it('the pantograph reaches the contact-wire height; cab cars have a nose, lamps and a windscreen', () => {
        const pan = boundsM(emuCarLayers(P(), 'panto', 0), 10);
        expect(pan.hi[1]).toBeCloseTo(EMU_PANTO_M, 1);
        const cab = emuCarLayers(P(), 'cab', 0).map(l => l.name);
        for (const n of ['-headlight', '-taillight', '-glass', '-sign']) expect(cab.some(c => c.endsWith(n)), n).toBe(true);
        expect(emuCarLayers(P(), 'mid', 0).some(l => /light$/.test(l.name))).toBe(false);
    });
    it('4 door sets per side: 8 leaves per slide direction, each with a window', () => {
        const L = emuCarLayers(P(), 'mid', 0);
        for (const n of ['-doorA', '-doorB']) {
            const leaves = L.find(l => l.name === 'world:traffic-train' + n)!;
            expect(leaves.geometry.indices.length / 3).toBe(8 * 12);   // 8 oriented boxes
            const win = L.find(l => l.name === 'world:traffic-train-win' + n)!;
            expect(win.geometry.indices.length / 3).toBe(8 * 2);
        }
    });
    it('stays inside the triangle budget (≤ 3k per car) — tri counts', () => {
        const tris: Record<string, number> = {};
        for (const v of ['cab', 'mid', 'panto'] as EmuVariant[]) { tris[v] = emuCarTris(P(), v); expect(tris[v], v).toBeLessThanOrEqual(3000); expect(tris[v]).toBeGreaterThan(600); }
        // eslint-disable-next-line no-console
        console.log('[emu] tris per car', tris);
    });
    it('one material family per mesh; side glass rides the interior shader', () => {
        const FAM = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'];
        for (const v of ['cab', 'mid', 'panto'] as EmuVariant[]) for (const L of emuCarLayers(P(), v, 0)) {
            const f = FAM.filter(k => (L as unknown as Record<string, unknown>)[k] != null);
            expect(f.length, `${L.name} ${f.join('+')}`).toBeLessThanOrEqual(1);
            expect(L.noWarp).toBe(true);
        }
        const win = emuCarLayers(P(), 'mid', 0).find(l => l.name === 'world:traffic-train-win')!;
        expect(win.pattern?.mode).toBe('windows'); expect(win.glass).toBe(true);
        expect(emuCarLayers(P(), 'mid', 0).find(l => l.name === 'world:traffic-train')!.reflect).toBeTruthy();
    });
});

describe('liveries', () => {
    it('are deterministic per seed, overridable, and three distinct looks', () => {
        expect(railLivery({ seed: 42 })).toEqual(railLivery({ seed: 42 }));
        const looks = RAIL_LIVERIES.map(n => railLivery({ seed: 1, railLivery: n }));
        expect(looks.map(l => l.name)).toEqual(['green', 'silver', 'cream']);
        expect(new Set(looks.map(l => l.band.join())).size).toBe(3);
        expect(railLivery({ seed: 1, railLivery: 'auto' }).name).toBe(railLivery({ seed: 1 }).name);
        const seen = new Set<string>(); for (let s = 0; s < 40; s++) seen.add(railLivery({ seed: s }).name);
        expect(seen.size).toBe(3);
        expect(railLivery({ seed: 1, railLivery: 'cream' }).lower).not.toBeNull();   // two-tone
    });
});

describe('consist', () => {
    it('defaults to 8 cars, 20 m apart, cab cars at both ends facing out', () => {
        const [c] = railConsists(P({ radius: 22 }), railTrackInfo(P({ radius: 22 }), railwayLine(P({ radius: 22 }))));
        expect(c.count).toBe(8);
        expect(c.spacing * cityMetresPerUnit(22)).toBeCloseTo(20, 5);
        const cp = consistPlan(8);
        expect(cp[0]).toEqual({ variant: 'cab', flip: true }); expect(cp[7]).toEqual({ variant: 'cab', flip: false });
        expect(cp.filter(x => x.variant === 'panto').length).toBeGreaterThan(0);
        expect(c.pick.length).toBe(8);
    });
    it('railCars is clamped to 2..10 and to what fits the line', () => {
        const len = 400 / cityMetresPerUnit(10);   // 400 m line
        expect(railCarCount({ radius: 10, railCars: 99 }, len)).toBe(10);
        expect(railCarCount({ radius: 10, railCars: 1 }, len)).toBe(2);
        expect(railCarCount({ radius: 10, railCars: 8 }, 100 / cityMetresPerUnit(10))).toBe(4);   // 100 m line → 4 cars
    });
    it('railway off → no consists and no parked train', () => {
        expect(railConsists(P({ railway: false }), railTrackInfo(P(), railwayLine(P())))).toEqual([]);
        expect(buildParkedTrain(P({ railway: false }), railwayLine(P()))).toEqual([]);
    });
    it('the parked train is the same EMU, named rail-train*, one lit lamp pair per end', () => {
        const L = buildParkedTrain(P(), railwayLine(P()));
        expect(L.length).toBeGreaterThan(8);
        for (const l of L) expect(l.name.startsWith('world:rail-train')).toBe(true);
        expect(L.some(l => l.name === 'world:rail-train-win')).toBe(true);
        const n = railCarCount(P(), 1e9);
        const head = L.find(l => l.name === 'world:rail-train-headlight')!, tail = L.find(l => l.name === 'world:rail-train-taillight')!;
        expect(head.geometry.indices.length).toBe(tail.geometry.indices.length * 1);   // 2 lamps each, one cab each
        expect(n).toBeGreaterThan(1);
    });
});

describe('station-stop run (R2.2)', () => {
    const u = 1 / cityMetresPerUnit(10), len = 600 * u, half = 80 * u;
    const plan = trainRunPlan({ radius: 10 }, len, half, [250 * u, 420 * u]);
    it('stops centred at every station and each terminus, dwells ~24 s / 30 s, doors open while stopped', () => {
        const st = trainRunStart(plan, 1, 0);   // at the lo terminus
        const stops: { s: number; dwell: number }[] = [];
        let prevV = 0, maxAcc = 0, maxDec = 0, inDwell = false, dwellStart = 0, maxDoor = 0, doorMoving = false, t = 0, minS = Infinity, maxS = -Infinity;
        const dt = 1 / 30;
        for (let f = 0; f < 30 * 600; f++) {
            stepTrainRun(st, plan, dt); t += dt;
            const a = (st.v - prevV) / dt; prevV = st.v;
            if (st.dwell <= 0 && st.v > 0) { maxAcc = Math.max(maxAcc, a); maxDec = Math.max(maxDec, -a); }
            minS = Math.min(minS, st.s); maxS = Math.max(maxS, st.s);
            if (st.dwell > 0 && !inDwell) { inDwell = true; dwellStart = t; stops.push({ s: st.s, dwell: 0 }); }
            if (inDwell) { maxDoor = Math.max(maxDoor, st.door); if (st.v !== 0) doorMoving = true; }
            if (st.dwell <= 0 && inDwell) { inDwell = false; stops[stops.length - 1].dwell = t - dwellStart; }
        }
        // the schedule: stations + termini, in order, both ways
        const at = (x: number) => stops.filter(q => Math.abs(q.s - x) < 1e-6);
        expect(at(plan.stops[0]).length).toBeGreaterThanOrEqual(2);
        expect(at(plan.stops[1]).length).toBeGreaterThanOrEqual(2);
        expect(at(plan.hi).length).toBeGreaterThanOrEqual(1);
        for (const q of stops.slice(1, -1)) {   // (the first is the partial starting dwell)
            const term = Math.abs(q.s - plan.hi) < 1e-6 || Math.abs(q.s - plan.lo) < 1e-6;
            expect(q.dwell).toBeGreaterThan(term ? 29 : 23); expect(q.dwell).toBeLessThan(term ? 31 : 25);
        }
        expect(maxDoor).toBe(1); expect(doorMoving).toBe(false);
        // smooth: acceleration and braking stay near their set rates (no snaps), within the track
        expect(maxAcc).toBeLessThanOrEqual(plan.accel * 1.001);
        expect(maxDec).toBeLessThanOrEqual(plan.decel * 1.7);
        expect(minS).toBeGreaterThanOrEqual(plan.lo - 1e-9); expect(maxS).toBeLessThanOrEqual(plan.hi + 1e-9);
    });
    it('railDwellScale scales the dwell', () => {
        const p2 = trainRunPlan({ radius: 10, railDwellScale: 0.5 }, len, half, [250 * u]);
        expect(p2.dwell).toBeCloseTo(12); expect(p2.termDwell).toBeCloseTo(15);
    });
    it('reverses at the termini', () => {
        const st = trainRunStart(plan, -1, 0.999);   // at hi
        expect(st.s).toBe(plan.hi); expect(st.dir).toBe(-1);
        for (let f = 0; f < 30 * 60; f++) stepTrainRun(st, plan, 1 / 30);
        expect(st.s).toBeLessThan(plan.hi);
    });
});
