/**
 * src/world/street-props.test.ts — polish round 3, T3: street props with real geometry.
 *
 * Pins the new meshbuild helpers (lathe / sweep / bevelBox), the lamp posts (swept arms + bell / cobra / lantern
 * heads), the traffic signals (visored housings, backplates, domed lenses, pedestrian heads) and the poles + sign
 * plates. Every family must stay finite, deterministic and inside a per-prop triangle budget, and the contracts other
 * systems key off (signal layer grammar, lamp head height vs the junction point lights) must hold.
 */

import { describe, it, expect } from 'vitest';
import { Accum3D } from './meshbuild';
import { buildLampPost, emitLampPost, newLampPostAccum, resolveLampPostParams, lampHeadOffset } from './lamp-post';
import { buildTrafficLights, signalledJunctions, SIGNAL_LAMP_RE } from './signals';
import { buildFurniture } from './furniture';
import { buildStreets } from './streets';
import { buildRoadSigns } from './road-sign';
import { streetPlan } from './street-slots';
import { generateCityLayout } from './layout';
import { cityMetresPerUnit } from './types';
import type { LayoutPreviewLayer, WorldGraph } from './types';

const F = 12;   // floats per vertex
const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, l) => n + l.geometry.indices.length / 3, 0);
const allFinite = (ls: LayoutPreviewLayer[]): boolean => ls.every((l) => Array.from(l.geometry.vertices).every(Number.isFinite));
const city = (): WorldGraph => generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', trafficLights: true, streetLights: true } as never);

describe('meshbuild helpers', () => {
    it('lathe: sides·2 tris per profile segment (+ cap fans), unit normals', () => {
        const a = new Accum3D();
        a.lathe([0, 0, 0], [0, 1, 0], [[1, 0], [1, 1], [0.5, 1.5]], 8, { caps: [true, false] });
        expect(a.triCount).toBe(8 * 2 * 2 + 8);
        const v = a.geometry().vertices;
        for (let i = 0; i < v.length; i += F) expect(Math.hypot(v[i + 3], v[i + 4], v[i + 5])).toBeCloseTo(1, 4);
    });

    it('lathe: side normals point OUTWARD (away from the axis) for a bottom-to-top profile', () => {
        const a = new Accum3D();
        a.lathe([0, 0, 0], [0, 1, 0], [[1, 0], [1, 2]], 6, { caps: [false, false] });
        const v = a.geometry().vertices;
        for (let i = 0; i < v.length; i += F) expect(v[i] * v[i + 3] + v[i + 2] * v[i + 5]).toBeGreaterThan(0);
    });

    it('sweep follows a curved path without collapsing (ring radius preserved)', () => {
        const a = new Accum3D(), path: [number, number, number][] = [];
        for (let k = 0; k <= 6; k++) { const t = (k / 6) * Math.PI / 2; path.push([1 - Math.cos(t), Math.sin(t), 0]); }
        a.sweep(path, 0.1, 6, [false, false]);
        expect(a.triCount).toBe(6 * 2 * 6);
        const v = a.geometry().vertices;
        for (let i = 0; i < v.length; i += F) {
            const k = Math.round(v[i + 7] * 6), c = path[k];
            expect(Math.hypot(v[i] - c[0], v[i + 1] - c[1], v[i + 2] - c[2])).toBeCloseTo(0.1, 4);
        }
    });

    it('bevelBox: 44 tris, stays inside its box, every face normal points outward', () => {
        const a = new Accum3D();
        a.bevelBox([1, 2, 3], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.5, 0.3, 0.2, 0.05);
        expect(a.triCount).toBe(44);
        const g = a.geometry(), v = g.vertices;
        for (let i = 0; i < v.length; i += F) {
            expect(Math.abs(v[i] - 1)).toBeLessThanOrEqual(0.5 + 1e-6);
            expect(Math.abs(v[i + 1] - 2)).toBeLessThanOrEqual(0.3 + 1e-6);
            expect(Math.abs(v[i + 2] - 3)).toBeLessThanOrEqual(0.2 + 1e-6);
            expect((v[i] - 1) * v[i + 3] + (v[i + 1] - 2) * v[i + 4] + (v[i + 2] - 3) * v[i + 5]).toBeGreaterThan(0);
        }
        // winding agrees with the normal (so single-sided rendering would show the outside)
        const ix = g.indices;
        for (let t = 0; t < ix.length; t += 3) {
            const p = (k: number): number[] => [v[ix[t + k] * F], v[ix[t + k] * F + 1], v[ix[t + k] * F + 2]];
            const [p0, p1, p2] = [p(0), p(1), p(2)];
            const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const o = ix[t] * F;
            expect(n[0] * v[o + 3] + n[1] * v[o + 4] + n[2] * v[o + 5]).toBeGreaterThan(0);
        }
    });
});

describe('T3.1 lamp posts', () => {
    it('every style is finite, deterministic and inside the per-lamp budget', () => {
        for (const style of ['modern', 'classic'] as const) for (const banners of [false, true]) {
            const a = buildLampPost({ style, banners, heightM: 5 }).layers, b = buildLampPost({ style, banners, heightM: 5 }).layers;
            expect(allFinite(a)).toBe(true);
            expect(a.map((l) => Array.from(l.geometry.vertices))).toEqual(b.map((l) => Array.from(l.geometry.vertices)));
            expect(tris(a), `${style}${banners ? '+banners' : ''}`).toBeLessThanOrEqual(420);
            expect(tris(a)).toBeGreaterThan(150);   // real geometry now, not a prism + blob
        }
    });

    it('the cantilever (junction) light stays inside the budget', () => {
        const acc = newLampPostAccum();
        emitLampPost(acc, [0, 0, 0], [0, 1], resolveLampPostParams({ style: 'modern', heightM: 5.5, banners: false }), 1, { reachM: 2.4 });
        const n = acc.metal.triCount + acc.glow.triCount + acc.banner.triCount;
        expect(n).toBeLessThanOrEqual(420);
    });

    it('lampHeadOffset matches where the glowing glass actually is (pools / point lights key off it)', () => {
        const cases: [ReturnType<typeof resolveLampPostParams>, { reachM?: number }][] = [
            [resolveLampPostParams({ style: 'modern', heightM: 5, banners: false }), {}],
            [resolveLampPostParams({ style: 'modern', heightM: 5.5, banners: false }), { reachM: 2.4 }],
            [resolveLampPostParams({ style: 'classic', heightM: 4, banners: false }), {}],
        ];
        for (const [lp, o] of cases) {
            const acc = newLampPostAccum();
            emitLampPost(acc, [0, 0, 0], [0, 1], lp, 1, o);   // facing +Z, metres
            const v = acc.glow.geometry().vertices;
            let sz = 0, maxY = -Infinity, n = 0;
            for (let i = 0; i < v.length; i += F) { sz += v[i + 2]; maxY = Math.max(maxY, v[i + 1]); n++; }
            const h = lampHeadOffset(lp, o);
            expect(Math.abs(sz / n - h.reachM), `${lp.style} reach`).toBeLessThan(0.05);
            expect(Math.abs(maxY - h.glassYM), `${lp.style} glass`).toBeLessThan(0.02);
        }
    });

    it('junction lamp glass sits at the height world-manager puts the junction POINT LIGHTS (0.34·s)', () => {
        const R = 10, s = R / 10, mpu = cityMetresPerUnit(R);
        const glass = lampHeadOffset(resolveLampPostParams({ style: 'modern', heightM: 5.5, banners: false }), { reachM: 2.4 }).glassYM;
        expect(Math.abs(glass - 0.34 * s * mpu)).toBeLessThan(0.35);
    });

    it('city lamp layers keep the names the LOD / glow regexes match (lightpoles / lamplights)', () => {
        const names = buildStreets(city()).map((l) => l.name);
        expect(names).toEqual(expect.arrayContaining(['world:lightpoles', 'world:lamplights', 'world:lamp-pool']));
    });
});

describe('T3.2 traffic signals', () => {
    const g = city();
    const layers = buildTrafficLights(g);

    it('keeps the phase-switch layer grammar (world-traffic switches by name)', () => {
        expect(layers.length).toBeGreaterThan(0);
        for (const l of layers) {
            const ok = l.name === 'world:signal-housing' || l.name === 'world:signal-red-stop' || SIGNAL_LAMP_RE.test(l.name);
            expect(ok, l.name).toBe(true);
        }
        expect(layers.some((l) => SIGNAL_LAMP_RE.test(l.name))).toBe(true);
    });

    it('is finite + deterministic', () => {
        expect(allFinite(layers)).toBe(true);
        const again = buildTrafficLights(g);
        expect(again.map((l) => [l.name, l.geometry.vertices.length])).toEqual(layers.map((l) => [l.name, l.geometry.vertices.length]));
    });

    it('stays inside the per-head budget (4 heads + 4 pedestrian heads per signalled cross)', () => {
        const heads = signalledJunctions(g).length * 4;
        expect(heads).toBeGreaterThan(0);
        const signalTris = tris(layers.filter((l) => l.name !== 'world:signal-red-stop' && l.nearTwin?.role !== 'far'));   // P9: the near twin is the full head
        expect(signalTris / heads).toBeLessThanOrEqual(520);
    });

    it('pedestrian figures ride the OTHER axis lamps: every bucket has both a and b green layers', () => {
        const greens = layers.filter((l) => /^world:signal-green-\d[ab]$/.test(l.name)).map((l) => l.name);
        const buckets = new Set(greens.map((n) => n.slice(-2, -1)));
        for (const b of buckets) {
            expect(greens).toContain(`world:signal-green-${b}a`);
            expect(greens).toContain(`world:signal-green-${b}b`);
        }
    });
});

describe('T3.3 utility poles + road signs', () => {
    const g = city();

    it('utility poles are finite, deterministic and inside the per-pole budget', () => {
        const a = (buildFurniture(g) as LayoutPreviewLayer[]).filter((l) => /^world:util-pole/.test(l.name));
        const b = (buildFurniture(g) as LayoutPreviewLayer[]).filter((l) => /^world:util-pole/.test(l.name));
        expect(a.length).toBeGreaterThan(0);
        expect(allFinite(a)).toBe(true);
        expect(a.map((l) => l.geometry.vertices.length)).toEqual(b.map((l) => l.geometry.vertices.length));
        const poles = streetPlan(g).of('pole').length;
        expect(poles).toBeGreaterThan(0);
        expect(tris(a.filter((l) => l.nearTwin?.role !== 'far')) / poles).toBeLessThanOrEqual(340);   // P9: the near twin is the full pole
    });

    it('road signs are finite + inside budget, and never stand on a signalled cross (its corners are all taken)', () => {
        const { layers, textSigns } = buildRoadSigns(g);
        expect(allFinite(layers)).toBe(true);
        const pole = layers.find((l) => l.name === 'world:roadsign-pole');
        const signs = textSigns.length + (layers.find((l) => l.name === 'world:warning')?.instances?.length ?? 0);
        if (pole && signs) expect(tris([pole]) / signs).toBeLessThanOrEqual(260);
        const s = g.params.radius / 10;
        for (const sp of textSigns) {
            const v = sp.layer.geometry.vertices;
            for (const j of signalledJunctions(g)) expect(Math.hypot(v[0] - j.pos[0], v[2] - j.pos[1])).toBeGreaterThan(0.2 * s);
        }
    });
});
