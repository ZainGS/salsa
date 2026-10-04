/**
 * src/world/lod-accum.test.ts — P9 far twins of the heavy street props (performance-plan P9).
 *
 * The full accumulator of a TwinAccum3D must be bit-identical to a plain Accum3D fed the same calls (the near twin
 * IS the pre-P9 geometry); the far twin must be much cheaper and stay inside the full one's box; the city builders
 * emit each heavy family as a near / far pair (same name, same material) and nothing else changes.
 */

import { describe, it, expect } from 'vitest';
import { Accum3D } from './meshbuild';
import { TwinAccum3D, LoAccum3D, loSpecFor, withFarTwin, PROP_TWIN_M } from './lod-accum';
import { generateCityLayout } from './layout';
import { buildFurniture } from './furniture';
import { buildTrafficLights } from './signals';
import { buildPedestrians, PED_NEAR_M, PED_XFAR_M } from './pedestrians';
import { cityMetresPerUnit, type LayoutPreviewLayer } from './types';
import { emitPerson, personLook, type PersonSink, type PedColor } from './mannequin';

type V3 = [number, number, number];
const tris = (L: LayoutPreviewLayer): number => L.geometry.indices.length / 3;
const same = (a: ArrayBufferView, b: ArrayBufferView): boolean =>
    a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

/** A representative mix of primitive calls (a pole-like prop). */
function emitProp(a: Accum3D, s = 1): void {
    a.lathe([0, 0, 0], [0, 1, 0], [[0.18 * s, 0], [0.18 * s, 0.06 * s], [0.165 * s, 0.1 * s], [0.13 * s, 8 * s], [0.115 * s, 8.06 * s], [0, 8.1 * s]], 8, { caps: [false, false] });
    for (let i = 0; i < 6; i++) a.beam([0, (3 + i * 0.7) * s, 0], [0.2 * s, (3 + i * 0.7) * s, 0], 0.018 * s, 3);
    a.bevelBox([0, 7.7 * s, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.6 * s, 0.07 * s, 0.06 * s, 0.018 * s);
    a.obox([0, 5 * s, 0.2 * s], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.09 * s, 0.045 * s, 0.09 * s);
    a.sweep([[0, 6, 0], [0.3, 6.3, 0], [0.6, 6.4, 0], [0.9, 6.45, 0], [1.2, 6.5, 0]].map(p => p.map(v => v * s) as V3), 0.04 * s, 6);
    const v0 = a.vertex([0, 1, 0], [0, 0, 1]), v1 = a.vertex([1 * s, 1, 0], [0, 0, 1]), v2 = a.vertex([0, 2 * s, 0], [0, 0, 1]);
    a.triangle(v0, v1, v2);
}

describe('TwinAccum3D', () => {
    it('builds the full geometry bit-identically to a plain Accum3D (the near twin is the pre-P9 geometry)', () => {
        const plain = new Accum3D(), twin = new TwinAccum3D(loSpecFor(45, 1));
        emitProp(plain); emitProp(twin);
        const a = plain.geometry(), b = twin.geometry();
        expect(b.vertices).toEqual(a.vertices);
        expect(b.indices).toEqual(a.indices);
    });
    it('the far twin is much cheaper, forwards raw triangles once, and stays inside the full box', () => {
        const twin = new TwinAccum3D(loSpecFor(45, 1));
        emitProp(twin);
        expect(twin.lo.triCount).toBeGreaterThan(0);
        expect(twin.lo.triCount).toBeLessThan(twin.triCount * 0.5);
        const box = (v: Float32Array): number[] => {
            const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (let i = 0; i < v.length; i += 12) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], v[i + k]); b[k + 3] = Math.max(b[k + 3], v[i + k]); }
            return b;
        };
        const F = box(twin.geometry().vertices), L = box(twin.lo.geometry().vertices);
        for (let k = 0; k < 3; k++) { expect(L[k]).toBeGreaterThanOrEqual(F[k] - 1e-6); expect(L[k + 3]).toBeLessThanOrEqual(F[k + 3] + 1e-6); }
    });
    it('a bevelBox (implemented with obox) reaches the far twin exactly once', () => {
        const twin = new TwinAccum3D(loSpecFor(45, 1));
        twin.bevelBox([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, 1, 1, 0);   // b = 0 → the obox fallback
        expect(twin.lo.triCount).toBe(12);
    });
    it('drops parts under about a pixel at the swap distance and keeps the rest', () => {
        const lo = new LoAccum3D(loSpecFor(45, 1));
        lo.beam([0, 0, 0], [0, 1, 0], 0.01, 4);                                      // a 2 cm rod: gone
        expect(lo.triCount).toBe(0);
        lo.obox([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, 1, 0.002);             // a thin PLATE seen face-on: kept
        expect(lo.triCount).toBe(12);
    });
});

describe('withFarTwin', () => {
    it('returns the layer unchanged without a far twin, and a near / far pair (same name and material) with one', () => {
        const L: LayoutPreviewLayer = { name: 'world:util-pole', color: [1, 1, 1], y: 0, geometry: new Accum3D().geometry() };
        expect(withFarTwin(L, new Accum3D(), 'k', 45, 1)).toEqual([L]);
        const t = new TwinAccum3D(loSpecFor(45, 1)); emitProp(t);
        const [n, f] = withFarTwin({ ...L, geometry: t.geometry() }, t, 'k', 45, 0.5);
        expect(n.nearTwin).toEqual({ key: 'k', role: 'near', dist: 22.5, gridTris: tris(n), uvFromNear: true });
        expect(f.nearTwin).toEqual({ key: 'k', role: 'far', dist: 22.5, gridTris: tris(n), uvFromNear: true });   // the pair chunks on the near layer's grid
        expect(f.name).toBe(n.name); expect(f.color).toEqual(n.color);
        expect(tris(f)).toBeLessThan(tris(n) * 0.5);
    });
});

describe('city builders emit the heavy props as near / far pairs', () => {
    const graph = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square' });
    const graphOff = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', propTwins: false });
    const u = 1 / cityMetresPerUnit(10);
    const pairs = (layers: LayoutPreviewLayer[], name: string) => ({
        near: layers.filter(L => L.name === name && L.nearTwin?.role === 'near'),
        far: layers.filter(L => L.name === name && L.nearTwin?.role === 'far'),
        plain: layers.filter(L => L.name === name && !L.nearTwin),
    });
    const sum = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + tris(L), 0);
    const furn = buildFurniture(graph), furnOff = buildFurniture(graphOff);
    const sig = buildTrafficLights(graph), sigOff = buildTrafficLights(graphOff);
    const cases: [string, LayoutPreviewLayer[], LayoutPreviewLayer[], number][] = [
        ['world:util-pole', furn, furnOff, PROP_TWIN_M.pole], ['world:car-trim', furn, furnOff, PROP_TWIN_M.carTrim],
        ['world:car-chrome', furn, furnOff, PROP_TWIN_M.carTrim], ['world:signal-housing', sig, sigOff, PROP_TWIN_M.signal],
    ];
    for (const [name, on, off, distM] of cases) {
        it(`${name}: the near twin is the propTwins:false layer, the far twin is far cheaper`, () => {
            const P = pairs(on, name), O = pairs(off, name);
            expect(P.near.length).toBe(1); expect(P.far.length).toBe(1); expect(P.plain.length).toBe(0);
            expect(O.plain.length).toBe(1); expect(O.near.length + O.far.length).toBe(0);
            expect(same(P.near[0].geometry.vertices, O.plain[0].geometry.vertices)).toBe(true);
            expect(same(P.near[0].geometry.indices, O.plain[0].geometry.indices)).toBe(true);
            expect(P.near[0].nearTwin!.dist).toBeCloseTo(distM * u, 9);
            const ratio = sum(P.far) / sum(P.near);
            console.log(`[P9] ${name}: full ${sum(P.near)} far ${sum(P.far)} (${(ratio * 100).toFixed(0)} %)`);
            expect(ratio).toBeLessThan(0.6);
        });
    }
    it('every other furniture / signal layer is untouched by the twins', () => {
        const strip = (ls: LayoutPreviewLayer[]) => ls.filter(L => !L.nearTwin).map(L => `${L.name}:${tris(L)}`).sort();
        expect(strip(furn)).toEqual(strip(furnOff).filter(k => !/^world:(util-pole|util-pole-insulator|car-trim|car-chrome):/.test(k)));
        expect(strip(sig)).toEqual(strip(sigOff).filter(k => !/^world:signal-housing:/.test(k)));
    });
});

describe('the static crowd has a third, cheapest tier', () => {
    it('lod 2 people are far cheaper than the lod 1 (mid) ones', () => {
        const count = (lod: 0 | 1 | 2): number => {
            const acc = new Accum3D();
            const sink: PersonSink = { top: () => acc, skin: () => acc, hair: () => acc, leg: () => acc, shoes: () => acc, skirt: () => acc, bag: () => acc, umbrella: () => acc, collar: () => acc, extra: (_c: PedColor) => acc, mark: () => {} };
            let n = 0;
            for (let a = 0; a < 12; a++) { emitPerson(sink, { o: [0, 0, 0], f: [1, 0], u: 1 }, personLook(a, 1000 + a), { lod }); n = acc.triCount; }
            return n / 12;
        };
        const [hi, lo, xlo] = [count(0), count(1), count(2)];
        console.log(`[P9] tris per person: high ${hi.toFixed(0)} · far ${lo.toFixed(0)} · xfar ${xlo.toFixed(0)}`);
        expect(xlo).toBeLessThan(lo * 0.6);
    });
    it('the crowd layers come as near / mid / xfar tiers sharing one key; propTwins:false keeps near / far', () => {
        const g = generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', instancedCrowd: false });
        const layers = buildPedestrians(g);
        const roles = new Set(layers.map(L => L.nearTwin?.role));
        expect([...roles].sort()).toEqual(['mid', 'near', 'xfar']);
        const u = 1 / cityMetresPerUnit(10);
        for (const L of layers) {
            expect(L.nearTwin!.dist).toBeCloseTo(PED_NEAR_M * u, 9);
            expect(L.nearTwin!.dist2).toBeCloseTo(PED_XFAR_M * u, 9);
        }
        const off = buildPedestrians(generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', propTwins: false, instancedCrowd: false }));
        expect([...new Set(off.map(L => L.nearTwin?.role))].sort()).toEqual(['far', 'near']);
        const near = (ls: LayoutPreviewLayer[]) => ls.filter(L => L.nearTwin?.role === 'near').map(L => tris(L));
        expect(near(layers)).toEqual(near(off));
    }, 30000);   // two full crowd builds: ~2 s alone, past the 5 s default under full-suite load
});
