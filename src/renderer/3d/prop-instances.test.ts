/**
 * P20 instanced props (performance-plan.md §P20): an ArrayGroup whose copies carry InstanceOverride.affine (+ normal3)
 * over a never-drawn phantom source. On the REAL Renderer3D over a recording device: every copy's slot holds its own
 * model 3×3 + translation and its own normal matrix, the phantom source is never drawn, every copy is.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const FPI = 60;

function recordingDevice() {
    const mem = new Map<object, Uint8Array>();
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
    const encoder = new Proxy({}, { get: (_t, k) => {
        if (k === 'copyBufferToBuffer') return (src: object, so: number, dst: object, dof: number, n: number) => { const a = mem.get(src), b = mem.get(dst); if (a && b) b.set(a.subarray(so, so + n), dof); };
        if (k === 'finish') return () => stub;
        return stub;
    } });
    const queue = new Proxy({}, { get: (_t, k) => {
        if (k === 'writeBuffer') return (buf: object, off: number, data: ArrayBuffer | ArrayBufferView, dataOff = 0, size?: number) => {
            const isAB = data instanceof ArrayBuffer;
            const bpe = isAB ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
            const src = isAB ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const o = dataOff * bpe, n = size !== undefined ? size * bpe : src.byteLength - o;
            const m = mem.get(buf); if (m) m.set(src.subarray(o, o + n), off);
        };
        return stub;
    } });
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (k === 'features') return { has: () => false };
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => { const b = { size: d.size, destroy() { /* */ }, label: '', mapAsync: () => new Promise(() => { /* */ }) }; mem.set(b, new Uint8Array(d.size)); return b; };
        if (k === 'createCommandEncoder') return () => encoder;
        if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
        return stub;
    } });
    return { device: device as unknown as GPUDevice, mem };
}
beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

describe('P20 affine array copies', () => {
    for (const mode of ['overrides', 'instanceXf'] as const) it(`each copy slot holds its own 3×3, translation and normal matrix; the phantom source is not drawn (${mode})`, async () => {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
        const { ArrayGroup3D } = await import('../../scene-graph/shapes/array-group-3d');
        const dev = recordingDevice();
        const cam = new Camera3D(); cam.setPosition(0, 20, -40); cam.setTarget(0, 0, 10);
        const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
        const v: number[] = [], ix = [0, 1, 2, 0, 2, 3];
        for (const p of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]) v.push(p[0], p[1], p[2], 0, 0, 1, 0, 0, 1, 0, 0, 1);
        const src = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' } });
        src.name = 'world:util-pole'; src.setGeometryKeyOverride('wld:p20:test'); src.arraySourceOnly = true; src.castsInstancedShadow = true;
        const N = 7, offsets: [number, number, number][] = [], ovs = new Map<number, { affine: number[]; normal3?: number[] }>();
        for (let i = 0; i < N; i++) {
            const a = i * 0.7, c = Math.cos(a), s = Math.sin(a), gx = 0.01 * i, gz = -0.02 * i;
            offsets.push([i * 2 - 6, 0.1 * i, 5 + i]);
            // yaw (column-major) then a height shear: m = S·R
            const m = [c, gx * c - gz * s, -s, 0, 1, 0, s, gx * s + gz * c, c];
            ovs.set(i, i % 2 || mode === 'instanceXf' ? { affine: m, normal3: [c, 0, -s, 0, 1, 0, s, 0, c] } : { affine: m });
        }
        const g = new ArrayGroup3D(isvc, src.id, { mode: 'explicit', offsets });
        if (mode === 'overrides') g.instanceOverrides = ovs as never;
        else {   // the typed form the city uses: 21 floats a copy (t · model 3×3 · normal 3×3)
            const xf = new Float32Array(N * 21);
            for (let i = 0; i < N; i++) { xf.set(offsets[i], i * 21); xf.set(ovs.get(i)!.affine, i * 21 + 3); xf.set(ovs.get(i)!.normal3!, i * 21 + 12); }
            g.instanceXf = xf;
        }
        r.setArrayGroups([g]);
        const draws: number[] = [];
        const pass = new Proxy({}, { get: (_t, k) => k === 'drawIndexed' ? (_ic: number, inst: number, _fi: number, _bv: number, first: number) => { for (let i = 0; i < inst; i++) draws.push(first + i); } : () => { /* */ } }) as unknown as GPURenderPassEncoder;
        for (let f = 0; f < 3; f++) { draws.length = 0; r.drawMeshes(pass, [src], 1300, 850); }
        const data = new Float32Array(dev.mem.get(r.instanceStorageBuffer)!.buffer);
        const first = r._arrayGroupFirstSlot.get(g.id) as number;
        const srcSlot = r._meshInstanceSlots.get(src.id);
        expect(first).toBeDefined();
        expect(draws.includes(srcSlot)).toBe(false);   // the phantom source never draws
        for (let i = 0; i < N; i++) {
            expect(draws.includes(first + i)).toBe(true);
            const o = (first + i) * FPI, m = ovs.get(i)!.affine;
            for (const [k, j] of [[0, 0], [1, 1], [2, 2], [4, 3], [5, 4], [6, 5], [8, 6], [9, 7], [10, 8]]) expect(data[o + k]).toBeCloseTo(m[j], 5);
            expect(data[o + 12]).toBeCloseTo(offsets[i][0], 5); expect(data[o + 13]).toBeCloseTo(offsets[i][1], 5); expect(data[o + 14]).toBeCloseTo(offsets[i][2], 5);
            // normal matrix: the given normal3, else the inverse-transpose of the model 3×3 (which maps the face normal
            // (0, 0, 1) to the sheared surface's normal: orthogonal to the copy's transformed edges)
            const nm = [data[o + 16], data[o + 17], data[o + 18], data[o + 20], data[o + 21], data[o + 22], data[o + 24], data[o + 25], data[o + 26]];
            const n3 = ovs.get(i)!.normal3;
            if (n3) for (let j = 0; j < 9; j++) expect(nm[j]).toBeCloseTo(n3[j], 5);
            else {
                const n = [nm[6], nm[7], nm[8]];   // M⁻ᵀ·(0,0,1)
                const ex = [m[0], m[1], m[2]], ey = [m[3], m[4], m[5]];   // the copy's transformed local X / Y edges
                expect(Math.abs(n[0] * ex[0] + n[1] * ex[1] + n[2] * ex[2])).toBeLessThan(1e-5);
                expect(Math.abs(n[0] * ey[0] + n[1] * ey[1] + n[2] * ey[2])).toBeLessThan(1e-5);
            }
        }
    });
});
