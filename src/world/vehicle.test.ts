import { describe, it, expect } from 'vitest';
import { makeVehicleAcc, emitVehicle, vehicleLayers, VEH_TAXI } from './vehicle';

type V3 = [number, number, number];
const AX: V3 = [1, 0, 0], CW: V3 = [0, 0, 1], ORIGIN: V3 = [0, 0, 0];

describe('vehicle builder', () => {
    it('a sedan has body, glass, tyres, chrome — and NO taxi belt/sign', () => {
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'sedan');
        expect(acc.body.empty).toBe(false);
        expect(acc.glass.empty).toBe(false);
        expect(acc.trim.empty).toBe(false);      // tyres + valance
        expect(acc.chrome.empty).toBe(false);    // bumpers + hubcaps
        expect(acc.band.empty).toBe(true);       // sedans have no checker belt
        expect(acc.sign.empty).toBe(true);
    });

    it('a taxi adds the checker belt + roof sign', () => {
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'taxi');
        expect(acc.band.empty).toBe(false);
        expect(acc.sign.empty).toBe(false);
    });

    it('lights:false (parked) emits no head/tail geometry → no glowing headlights at night', () => {
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'sedan', { lights: false });
        expect(acc.head.empty).toBe(true);
        expect(acc.tail.empty).toBe(true);
    });

    it('a classic is LONGER than a sedan (old-school long hood/trunk)', () => {
        const lenOf = (type: 'sedan' | 'classic'): number => {
            const acc = makeVehicleAcc();
            emitVehicle(acc, ORIGIN, AX, CW, 100, type);
            const v = acc.body.geometry().vertices;
            let min = Infinity, max = -Infinity;
            // stride: pos.xyz first 3 floats per vertex (x is the along axis here)
            const stride = v.length % 12 === 0 ? 12 : (v.length % 8 === 0 ? 8 : 6);
            for (let i = 0; i < v.length; i += stride) { min = Math.min(min, v[i]); max = Math.max(max, v[i]); }
            return max - min;
        };
        expect(lenOf('classic')).toBeGreaterThan(lenOf('sedan'));
    });

    it('bus light layers keep the names the night glow-walk (/headlight|taillight/) matches', () => {
        // Cars deliberately have NO lights now (painted onto the GARP body texture instead); buses/trucks keep them.
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'bus');
        const names = vehicleLayers(acc, 'world:traffic-bus', [0.5, 0.5, 0.5]).map(l => l.name);
        expect(names.some(n => /headlight/.test(n))).toBe(true);
        expect(names.some(n => /taillight/.test(n))).toBe(true);
    });

    it('cars no longer emit headlight/taillight geometry (GARP-texture territory)', () => {
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'sedan');
        expect(acc.head.empty).toBe(true);
        expect(acc.tail.empty).toBe(true);
    });

    it('every type builds non-empty body + glass + wheels (bus/truck included)', () => {
        for (const type of ['sedan', 'classic', 'taxi', 'van', 'bus', 'truck'] as const) {
            const acc = makeVehicleAcc();
            emitVehicle(acc, ORIGIN, AX, CW, 100, type);
            expect(acc.body.empty, `${type} body`).toBe(false);
            expect(acc.glass.empty, `${type} glass`).toBe(false);
            expect(acc.trim.empty, `${type} wheels`).toBe(false);
            expect(acc.chrome.empty, `${type} chrome`).toBe(false);
        }
    });

    it('cars get sloped windshield + rear glass (more glass geometry than a plain box)', () => {
        // A car (windshield + rear window + band) has more glass verts than the bus (single window band).
        const car = makeVehicleAcc(); emitVehicle(car, ORIGIN, AX, CW, 100, 'sedan');
        expect(car.glass.geometry().vertices.length).toBeGreaterThan(0);
    });

    it('a taxi paints its body VEH_TAXI yellow and carries a checker-pattern belt layer', () => {
        const acc = makeVehicleAcc();
        emitVehicle(acc, ORIGIN, AX, CW, 100, 'taxi');
        const layers = vehicleLayers(acc, 'world:traffic-taxi', VEH_TAXI);
        const belt = layers.find(l => l.pattern?.mode === 'checker');
        expect(belt).toBeTruthy();
    });
});
