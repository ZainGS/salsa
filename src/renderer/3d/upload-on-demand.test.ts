/**
 * On-demand rendering + budgeted uploads (the P16 write ledger, step-3 slicing, P20): a mesh added to an otherwise idle
 * scene must finish uploading even when the host only renders when asked. The renderer asks through `onDeferredWork`
 * while geometry or instance work is pending; this drives frames ONLY through that callback (plus the add's own one
 * request) and checks the new mesh ends resident, not gpuDirty, and drawn. On the REAL Renderer3D over a recording
 * device; no wall-clock assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

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
        if (k === 'copyBufferToBuffer') return (src: object, so: number, dst: object, dof: number, n: number) => { const a = mem.get(src), b = mem.get(dst); if (a && b) b.set(a.slice(so, so + n), dof); };
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
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
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

describe('budgeted uploads under on-demand rendering', () => {
    it('a mesh added to an idle scene finishes uploading through onDeferredWork alone (big + small, plus a compaction)', async () => {
        const { Renderer3D } = await import('./renderer-3d');
        const { Camera3D } = await import('./camera-3d');
        const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
        const cam = new Camera3D(); cam.setPosition(0, 10, -30); cam.setTarget(0, 0, 0);
        const dev = recordingDevice();
        const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
        const mk = (verts: number, seed: number) => {
            const v = new Float32Array(verts * 12), ix = new Uint32Array(verts - (verts % 3));
            for (let i = 0; i < v.length; i++) v[i] = ((i * 2654435761 + seed * 97) % 1000) / 500 - 1;
            for (let i = 0; i < ix.length; i++) ix[i] = i;
            const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: v, indices: ix, format: '12float' } });
            m.name = 'm' + seed;
            return m;
        };
        let scheduled = 0;
        r.onDeferredWork = () => { scheduled++; };
        const pass = new Proxy({}, { get: () => () => { /* */ } }) as unknown as GPURenderPassEncoder;
        const frame = (list: unknown[]) => r.drawMeshes(pass, list, 1300, 850);
        // a busy scene: enough geometry that one frame's write budget cannot place it all
        const scene = Array.from({ length: 40 }, (_, i) => mk(60000, i));   // 40 × 2.9 MB
        frame(scene);
        for (let f = 0; f < 400 && scene.some(m => !r._geomAllocs.has(m.id)); f++) frame(scene);
        expect(scene.every(m => r._geomAllocs.has(m.id))).toBe(true);
        for (const extra of [mk(90000, 900), mk(300, 901)]) {     // a ~4 MB (sliced) and a tiny "character" mesh
            const list = [...scene, extra];
            scheduled = 0;
            frame(list);                                           // the add's own render request
            let frames = 1;
            // on-demand: render again ONLY while the renderer asked for it
            while (scheduled > 0 && frames < 400) { scheduled = 0; frame(list); frames++; }
            expect(r._geomAllocs.has(extra.id), extra.name).toBe(true);
            expect(extra.gpuDirty, extra.name).toBe(false);
            scene.push(extra);
        }
        // and through a GPU compaction (dead space from removed meshes; one fresh mesh in the same frame)
        const gone = scene.splice(0, 20);
        r.evictMeshCaches(gone.map(m => m.id));
        const late = mk(70000, 950);
        const list = [...scene, late];
        r._forceCompact = true;
        scheduled = 0;
        frame(list);
        let frames = 1;
        while (scheduled > 0 && frames < 400) { scheduled = 0; frame(list); frames++; }
        expect(r._geomAllocs.has(late.id)).toBe(true);
        expect(late.gpuDirty).toBe(false);
        expect(list.every(m => r._geomAllocs.has(m.id))).toBe(true);
    });
});
