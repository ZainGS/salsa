/**
 * P22 propCull (performance-plan §P22): an instanced prop group (P20) partly in the view draws only its runs of copies
 * whose box passes the frustum. Cull equivalence: every copy whose own box passes is inside a kept span (nothing that
 * could be on screen is dropped), spans are in instance order and disjoint, and a span only covers runs that pass or
 * short gaps (PROP_CULL_GAP) between them. A run is dropped only when its box — which holds every copy's box — fails
 * a plane, so its copies are clipped anyway: the same pixels (browser A/B: 0 px).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { selectRanges, type BoxTester } from './cull-ranges';
const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis; gg.crypto ??= webcrypto; (gg.self as { crypto?: unknown }).crypto ??= webcrypto;

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

function stubDevice(): GPUDevice {
    const handler: ProxyHandler<() => unknown> = {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
            if (k === Symbol.toPrimitive) return () => 0;
            if (k === 'size') return 1 << 30;
            if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
            return stub;
        },
        apply() { return stub; },
    };
    const stub: unknown = new Proxy(function () { /* stub */ }, handler);
    return stub as GPUDevice;
}

/** A tester for an axis-aligned region (the frustum stand-in): intersects / contains. */
const regionTester = (x0: number, z0: number, x1: number, z1: number): BoxTester => ({
    testAABB: (a, _b, c, d, _e, f) => d >= x0 && a <= x1 && f >= z0 && c <= z1,
    containsAABB: (a, _b, c, d, _e, f) => a >= x0 && d <= x1 && c >= z0 && f <= z1,
});

describe('P22 propCull: per-run culling of instanced prop groups', () => {
    it('every copy whose box passes is drawn; spans ordered, disjoint, only over passing runs or short gaps', async () => {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const r = new Renderer3D(stubDevice(), new Camera3D()) as unknown as Record<string, any>;
        const R = Renderer3D as unknown as { PROP_CULL_RUN: number; PROP_CULL_GAP: number };
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        // copies along "streets": consecutive copies are close (a builder's emission order), with jumps between streets
        const N = 403, offsets: [number, number, number][] = [];
        let x = 0, z = 0;
        for (let i = 0; i < N; i++) { if (i % 37 === 0) { x = rnd() * 400 - 200; z = rnd() * 400 - 200; } x += 3 + rnd() * 2; offsets.push([x, rnd() * 2, z]); }
        const mg = 1.5;
        const source = { id: 'src', localMatrixVersion: 1, parentChainMatrix: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) };
        r.getMeshWorldAABB3D = () => ({ minX: 0, minY: 0, minZ: 0, maxX: mg, maxY: mg * 0.5, maxZ: mg * 0.7 });
        const group = { id: 'g1', instanceXf: new Float32Array(N * 21), arrayParams: { mode: 'explicit', offsets } };
        const tab = r._propCullTable(group, source, N);
        expect(tab.inst).toBe(true);
        expect(tab.n).toBe(Math.ceil(N / R.PROP_CULL_RUN));
        expect(r._propCullTable(group, source, N)).toBe(tab);   // cached
        let totalKept = 0, totalVis = 0;
        for (let t = 0; t < 60; t++) {
            const cx = rnd() * 400 - 200, cz = rnd() * 400 - 200, w = 10 + rnd() * 150;
            const tester = regionTester(cx - w, cz - w, cx + w, cz + w);
            const sp: number[] = [];
            const kept = Math.round(selectRanges(tab, tester, sp, R.PROP_CULL_GAP) * 3);
            let prevEnd = -1, sum = 0;
            for (let s = 0; s < sp.length; s += 2) { expect(sp[s]).toBeGreaterThan(prevEnd - 1); prevEnd = sp[s] + sp[s + 1]; expect(prevEnd).toBeLessThanOrEqual(N); sum += sp[s + 1]; }
            expect(sum).toBe(kept);
            const inSpan = (i: number): boolean => { for (let s = 0; s < sp.length; s += 2) if (i >= sp[s] && i < sp[s] + sp[s + 1]) return true; return false; };
            for (let i = 0; i < N; i++) {
                const o = offsets[i];
                if (tester.testAABB(o[0] - mg, o[1] - mg, o[2] - mg, o[0] + mg, o[1] + mg, o[2] + mg)) { totalVis++; expect(inSpan(i), `copy ${i} (test ${t})`).toBe(true); }
            }
            // a span starts and ends on a run that passes
            for (let s = 0; s < sp.length; s += 2) {
                for (const i of [sp[s], sp[s] + sp[s + 1] - 1]) {
                    const q = Math.floor(i / R.PROP_CULL_RUN) * 6, b = tab.box;
                    expect(tester.testAABB(b[q], b[q + 1], b[q + 2], b[q + 3], b[q + 4], b[q + 5])).toBe(true);
                }
            }
            totalKept += kept;
        }
        expect(totalKept).toBeLessThan(60 * N * 0.6);   // it culls (the regions see a fraction of the copies)
        expect(totalKept).toBeGreaterThanOrEqual(totalVis);
    });
});
