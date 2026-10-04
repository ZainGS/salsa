import { describe, it, expect } from 'vitest';
import { Accum3D, chipExtrude, edgeChipSpec } from './meshbuild';
import { generateCityLayout, buildLayoutPreview, buildTerraces } from './index';
import { chunkCityLayers, chunkMinCell } from './chunking';
import type { LayoutPreviewLayer } from './types';

type V3 = [number, number, number];
const box = (acc: Accum3D): number[] => {
    const v = acc.geometry().vertices, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 12) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], v[i + k]); b[k + 3] = Math.max(b[k + 3], v[i + k]); }
    return b;
};

describe('E2 chipExtrude', () => {
    const o: V3 = [0.3, 0.1, -0.2], along: V3 = [1, 0, 0], ua: V3 = [0, 0, 1], va: V3 = [0, 1, 0];
    const prof: [number, number][] = [[0.3, 0], [0, 0], [0, -0.18]];   // a step: tread → nosing → riser
    const spec = edgeChipSpec('heavy', 1, 7)!;

    it('clean = two flat faces (4 tris); chipped adds geometry but only REMOVES material', () => {
        const clean = new Accum3D();
        chipExtrude(clean, o, along, ua, va, 1.1, prof, { chip: [false, true, false] });
        expect(clean.triCount).toBe(4);
        const main = new Accum3D(), wear = new Accum3D();
        chipExtrude(main, o, along, ua, va, 1.1, prof, { chip: [false, true, false], spec, wear });
        expect(main.triCount + wear.triCount).toBeGreaterThan(8);
        expect(wear.triCount).toBeGreaterThan(0);
        const cb = box(clean);
        for (const acc of [main, wear]) {
            const v = acc.geometry().vertices;
            for (let i = 0; i < v.length; i += 12) {
                for (let k = 0; k < 3; k++) {
                    expect(v[i + k]).toBeGreaterThanOrEqual(cb[k] - 1e-6);
                    expect(v[i + k]).toBeLessThanOrEqual(cb[k + 3] + 1e-6);
                }
                // inside the solid quadrant: z (ua) >= o.z, y <= o.y (tread top) — never proud of the clean faces
                expect(v[i + 2]).toBeGreaterThanOrEqual(o[2] - 1e-6);
                expect(v[i + 1]).toBeLessThanOrEqual(o[1] + 1e-6);
                expect(Number.isFinite(v[i + 3]) && Number.isFinite(v[i + 4]) && Number.isFinite(v[i + 5])).toBe(true);
            }
        }
    });

    it('is deterministic (the worker and the main thread build the identical piece)', () => {
        const a = new Accum3D(), b = new Accum3D();
        chipExtrude(a, o, along, ua, va, 2.5, prof, { chip: [false, true, false], spec });
        chipExtrude(b, o, along, ua, va, 2.5, prof, { chip: [false, true, false], spec });
        expect(Array.from(a.geometry().vertices)).toEqual(Array.from(b.geometry().vertices));
    });

    it('a closed bar with caps stays watertight-ish (every chipped vertex inside the clean box)', () => {
        const clean = new Accum3D(), chipped = new Accum3D();
        const bar: [number, number][] = [[-0.3, -0.08], [0.03, -0.08], [0.03, 0.08], [-0.3, 0.08]];
        chipExtrude(clean, o, along, ua, va, 3, bar, { closed: true });
        chipExtrude(chipped, o, along, ua, va, 3, bar, { closed: true, chip: [false, false, true, true], spec });
        expect(clean.triCount).toBe(8 + 4 + 4);   // 4 sides + 2 fan caps over the 4-point ring (+ centre)
        const cb = box(clean), kb = box(chipped);
        for (let k = 0; k < 3; k++) { expect(kb[k]).toBeGreaterThanOrEqual(cb[k] - 1e-6); expect(kb[k + 3]).toBeLessThanOrEqual(cb[k + 3] + 1e-6); }
    });

    it('edgeChipSpec: off / undefined = null; heavy chips more often and deeper than subtle', () => {
        expect(edgeChipSpec('off', 1)).toBeNull();
        expect(edgeChipSpec(undefined, 1)).toBeNull();
        const s = edgeChipSpec('subtle', 1)!, h = edgeChipSpec('heavy', 1)!;
        expect(h.every).toBeLessThan(s.every);
        expect(h.biteDepth).toBeGreaterThan(s.biteDepth);
    });
});

describe('E2 city edge wear (near/far twins)', () => {
    const city = (edgeWear: 'off' | 'subtle' | 'heavy') => generateCityLayout({ seed: 3, radius: 10, pattern: 'grid', border: 'square', terraces: true, elevation: 0.6, edgeWear });
    const memo = new Map<string, LayoutPreviewLayer[]>();
    const layers = (w: 'off' | 'subtle' | 'heavy'): LayoutPreviewLayer[] => {
        let r = memo.get(w);
        if (!r) { const g = city(w); r = [...buildTerraces(g), ...buildLayoutPreview(g)]; memo.set(w, r); }
        return r;
    };

    it("'off' builds no twins (saved cities unchanged)", () => {
        expect(layers('off').some((L) => L.nearTwin)).toBe(false);
    }, 60_000);

    it('with wear on, every far twin is the wear-off layer bit-for-bit, and each key has a near twin', () => {
        const off = layers('off'), on = layers('subtle');
        const fars = on.filter((L) => L.nearTwin?.role === 'far');
        expect(fars.map((L) => L.nearTwin!.key).sort()).toEqual(['kerb', 'terr-cap', 'terr-step']);
        for (const f of fars) {
            const o = off.find((L) => L.name === f.name)!;
            expect(o, f.name).toBeDefined();
            expect(Array.from(f.geometry.vertices)).toEqual(Array.from(o.geometry.vertices));
            expect(on.some((L) => L.nearTwin?.role === 'near' && L.nearTwin.key === f.nearTwin!.key)).toBe(true);
        }
        // the layers without a twin are untouched
        for (const L of on.filter((x) => !x.nearTwin)) {
            const o = off.find((x) => x.name === L.name && !x.nearTwin);
            expect(o, L.name).toBeDefined();
        }
    }, 60_000);

    it('chunking puts every layer of a twin key on ONE grid', () => {
        const out = chunkCityLayers(layers('heavy'), { minCell: chunkMinCell(10) });
        const grids = new Map<string, Set<string>>();
        for (const L of out) if (L.nearTwin) {
            const key = L.nearTwin.key, dims = (L.chunk ?? '').split('/')[1] ?? '';
            if (!grids.has(key)) grids.set(key, new Set());
            grids.get(key)!.add(dims);
        }
        for (const [k, dims] of grids) expect(dims.size, k).toBe(1);
        // "near" = the chunks around the camera: the kerb family is split into several cells
        expect([...grids.get('kerb')!][0]).not.toBe('1x1');
    }, 60_000);
});
