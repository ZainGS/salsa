import { describe, it, expect } from 'vitest';
import { makeVehicleAcc, emitVehicle, vehicleLayers, vehicleTriCount, vehicleHalfLength, VEHICLE_TYPES, VEH_TAXI, type VehicleType } from './vehicle';
import type { Accum3D } from './meshbuild';

type V3 = [number, number, number];
const AX: V3 = [1, 0, 0], CW: V3 = [0, 0, 1], ORIGIN: V3 = [0, 0, 0];
const CARS: VehicleType[] = ['sedan', 'hatch', 'kei', 'van', 'classic', 'taxi'];
const GLOW = /headlight|taillight|lamp-pool/;   // world-manager _applyGlow night-light rule

const build = (type: VehicleType, lights = true, base: V3 = ORIGIN, aW: V3 = AX, cW: V3 = CW) => {
    const acc = makeVehicleAcc();
    emitVehicle(acc, base, aW, cW, 100, type, { lights });
    return acc;
};
const extent = (a: Accum3D, axis: 0 | 1 | 2): [number, number] => {
    const v = a.geometry().vertices; let lo = Infinity, hi = -Infinity;
    for (let i = axis; i < v.length; i += 12) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    return [lo, hi];
};

describe('vehicle builder (Round 4 lofted bodies)', () => {
    it('a sedan has body, glass, tyres, chrome — and NO taxi belt/sign', () => {
        const acc = build('sedan');
        expect(acc.body.empty).toBe(false);
        expect(acc.glass.empty).toBe(false);
        expect(acc.trim.empty).toBe(false);
        expect(acc.chrome.empty).toBe(false);    // alloys + plate
        expect(acc.band.empty).toBe(true);
        expect(acc.sign.empty).toBe(true);
    });

    it('a taxi adds the checker belt + roof sign', () => {
        const acc = build('taxi');
        expect(acc.band.empty).toBe(false);
        expect(acc.sign.empty).toBe(false);
    });

    it('moving cars carry glowing head/tail lights; parked (lights:false) route them to UNLIT lens layers', () => {
        for (const type of VEHICLE_TYPES) {
            const lit = build(type, true), parked = build(type, false);
            expect(lit.head.empty, `${type} head`).toBe(false);
            expect(lit.tail.empty, `${type} tail`).toBe(false);
            expect(lit.lensHead.empty && lit.lensTail.empty, `${type} lit has no lenses`).toBe(true);
            expect(parked.head.empty && parked.tail.empty, `${type} parked emits no glowing lights`).toBe(true);
            expect(parked.lensHead.empty || parked.lensTail.empty, `${type} parked lenses`).toBe(false);
        }
    });

    it('glow layer names: lit lights match the night glow-walk, unlit lenses never do', () => {
        const lit = vehicleLayers(build('sedan', true), 'world:traffic-car', [0.5, 0.5, 0.5]).map(l => l.name);
        expect(lit).toContain('world:veh-headlight');
        expect(lit).toContain('world:veh-taillight');
        const parked = vehicleLayers(build('sedan', false), 'world:traffic-car', [0.5, 0.5, 0.5]).map(l => l.name);
        expect(parked.filter(n => GLOW.test(n))).toEqual([]);
        expect(parked).toContain('world:veh-lens-head');
        expect(parked).toContain('world:veh-lens-tail');
        const bus = vehicleLayers(build('bus'), 'world:traffic-bus', [0.5, 0.5, 0.5]).map(l => l.name);
        expect(bus.some(n => /headlight/.test(n)) && bus.some(n => /taillight/.test(n))).toBe(true);
    });

    it('every type builds finite geometry with valid indices (bus/truck included)', () => {
        for (const type of VEHICLE_TYPES) {
            const acc = build(type);
            for (const [k, a] of Object.entries(acc) as [string, Accum3D][]) {
                const g = a.geometry();
                for (const f of g.vertices) expect(Number.isFinite(f), `${type}.${k}`).toBe(true);
                const nV = g.vertices.length / 12;
                for (const ix of g.indices) expect(ix < nV, `${type}.${k} index`).toBe(true);
            }
            expect(acc.body.empty || acc.glass.empty || acc.trim.empty, `${type} core layers`).toBe(false);
        }
    });

    it('normals are unit length (the loft auto-smooth never emits a zero normal)', () => {
        for (const type of CARS) {
            const v = build(type).body.geometry().vertices;
            for (let i = 0; i < v.length; i += 12) expect(Math.abs(Math.hypot(v[i + 3], v[i + 4], v[i + 5]) - 1)).toBeLessThan(1e-3);
        }
    });

    it('is deterministic (identical output for identical input)', () => {
        for (const type of VEHICLE_TYPES) {
            const a = build(type).body.geometry(), b = build(type).body.geometry();
            expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
            expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
        }
    });

    it('budget: every car style stays ≤ 2.5k tris (parked + ~64 movers share/merge these)', () => {
        for (const type of VEHICLE_TYPES) {
            const n = vehicleTriCount(build(type));
            expect(n, type).toBeLessThanOrEqual(2500);
            expect(n, type).toBeGreaterThan(type === 'bus' || type === 'truck' ? 300 : 1000);   // not the old boxes
        }
    });

    it('proportions: real-metre lengths, the car fits its half-length + the 0.06·s parked half-width', () => {
        const s = 100, m = s / 15;
        for (const type of CARS) {
            const acc = build(type);
            const [x0, x1] = extent(acc.body, 0), [z0, z1] = extent(acc.body, 2);
            const hl = vehicleHalfLength(type, s);
            expect(x1, `${type} nose`).toBeLessThanOrEqual(hl + 0.1 * m);
            expect(-x0, `${type} tail`).toBeLessThanOrEqual(hl + 0.1 * m);
            expect(Math.max(-z0, z1), `${type} width`).toBeLessThanOrEqual(0.06 * s + 0.2 * m);   // + mirrors
        }
        expect(vehicleHalfLength('classic', s)).toBeGreaterThan(vehicleHalfLength('sedan', s));
        expect(vehicleHalfLength('kei', s)).toBeLessThan(vehicleHalfLength('hatch', s));
        // the kei van is TALL, the sedan is LOW
        expect(extent(build('van').body, 1)[1]).toBeGreaterThan(extent(build('sedan').body, 1)[1] * 1.25);
    });

    it('the greenhouse sits above the belt; glass spans windshield → backlight', () => {
        const acc = build('sedan'), m = 100 / 15;
        const [gy0, gy1] = extent(acc.glass, 1), [gx0, gx1] = extent(acc.glass, 0);
        expect(gy0).toBeGreaterThan(0.8 * m);
        expect(gy1).toBeGreaterThan(1.25 * m);
        expect(gx1 - gx0).toBeGreaterThan(2.0 * m);
    });

    it('orientation: the body follows aW/cW (a car built along +Z is the X-built car rotated)', () => {
        const a = build('sedan'), b = build('sedan', true, ORIGIN, [0, 0, 1], [-1, 0, 0]);
        const [ax0, ax1] = extent(a.body, 0), [bz0, bz1] = extent(b.body, 2);
        expect(bz1 - bz0).toBeCloseTo(ax1 - ax0, 4);
    });

    it('a taxi paints its body VEH_TAXI yellow and carries a checker-pattern belt layer', () => {
        const layers = vehicleLayers(build('taxi'), 'world:traffic-taxi', VEH_TAXI);
        expect(layers.find(l => l.pattern?.mode === 'checker')).toBeTruthy();
        expect(layers[0].color).toEqual(VEH_TAXI);
    });
});
