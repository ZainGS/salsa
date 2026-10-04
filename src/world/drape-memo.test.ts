// performance-plan §P20 — the memoised drape is the plain drape, bit for bit.
import { describe, it, expect } from 'vitest';
import { buildTileLayerGroups } from './tile-build';
import { generateCityLayout } from './layout';
import { XZMemo, applyHeightFieldMemo, applyDomainWarpMemo } from './drape-memo';
import { applyHeightField, type HeightFn } from './elevation';
import { applyDomainWarp } from './warp';

const P = generateCityLayout({ seed: 3, pattern: 'grid', border: 'square', radius: 10, gridCols: 11, gridRows: 11, worldMode: 'tiled', tileRadius: 1, tileDetail: 'full' }).params;

describe('P20 drapeMemo', () => {
    it('XZMemo: exact keys; reset forgets everything (a bigger and a smaller layer after it)', () => {
        const m = new XZMemo(2);
        const f = new Float32Array(1), b = new Int32Array(f.buffer);
        const key = (x: number) => { f[0] = x; return b[0]; };
        for (const n of [5000, 300, 9000]) {
            m.reset(n);
            expect(m.find(key(0.37), key(-1))).toBeLessThan(0);   // forgotten
            for (let i = 0; i < n; i++) { const s = m.claim(m.find(key(i * 0.37), key(-i)), key(i * 0.37), key(-i)); m.set(s, 0, i); m.set(s, 1, -i); }
            for (let i = 0; i < n; i++) { const s = m.find(key(i * 0.37), key(-i)); expect(s).toBeGreaterThanOrEqual(0); expect(m.value(s, 0)).toBe(i); expect(m.value(s, 1)).toBe(-i); }
            expect(m.find(key(0.5), key(123))).toBeLessThan(0);
        }
    });
    it('the memoised height field + warp equal the direct ones on shared corners, gradients included', () => {
        const n = 3000, v = new Float32Array(n * 12);
        for (let i = 0; i < n; i++) { const c = i % 700; v.set([c * 0.013 - 3, 0.1, (c * 7 % 31) * 0.05, i % 3 === 0 ? 0 : 0.6, i % 3 === 0 ? 0 : 0.8, 0, 0, 0, 1, 0, 0, 1], i * 12); }
        const fn = ((x: number, z: number) => Math.sin(x * 1.3) * 0.2 + Math.cos(z * 0.7) * 0.1) as HeightFn;
        fn.grad = (x, z, o) => { o[0] = Math.cos(x * 1.3) * 0.26; o[1] = -Math.sin(z * 0.7) * 0.07; };
        const warp = (x: number, z: number, o: [number, number]) => { o[0] = Math.sin(z) * 0.01; o[1] = Math.cos(x) * 0.02; };
        for (const g of [fn, ((x: number, z: number) => fn(x, z)) as HeightFn]) {   // with and without an analytic gradient
            const a = { vertices: v.slice(), indices: new Uint32Array(0) }, b = { vertices: v.slice(), indices: new Uint32Array(0) };
            applyHeightField(a, g); applyDomainWarp(a, warp);
            const mh = new XZMemo(3), mw = new XZMemo(2);
            applyHeightFieldMemo(b, g, mh); applyDomainWarpMemo(b, warp, mw);
            expect(Array.from(b.vertices)).toEqual(Array.from(a.vertices));
            expect(mh.hits).toBeGreaterThan(mh.misses);   // most vertices repeat a corner
        }
    });
    it('a whole full tile drapes to the same bytes', () => {
        const opts = { contact: { opacity: 0.55 }, propInstancing: false };
        const a = buildTileLayerGroups(P, 1, 0, true, { ...opts, drapeMemo: false });
        const b = buildTileLayerGroups(P, 1, 0, true, { ...opts, drapeMemo: true });
        expect(b.length).toBe(a.length);
        let n = 0;
        a.forEach((g, gi) => g.layers.forEach((L, li) => {
            const M = b[gi].layers[li];
            expect(M.name).toBe(L.name);
            expect(Buffer.from(M.geometry.vertices.buffer, M.geometry.vertices.byteOffset, M.geometry.vertices.byteLength).equals(Buffer.from(L.geometry.vertices.buffer, L.geometry.vertices.byteOffset, L.geometry.vertices.byteLength)), L.name).toBe(true);
            n++;
        }));
        expect(n).toBeGreaterThan(500);
    }, 240_000);
});
