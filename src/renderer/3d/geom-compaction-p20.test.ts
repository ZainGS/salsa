/**
 * P20 cheapCompaction (performance-plan.md §P20): the GPU pool compaction's bookkeeping without rebuilding every
 * per-mesh map. On the REAL Renderer3D over a recording device (copyBufferToBuffer / writeBuffer move bytes):
 * the cheap and the full bookkeeping end in the same allocations, key refs and residency, every mesh's bytes are
 * where its allocation says, and every moved key gets a NEW alloc object (the GPU-driven scene keys on its identity).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import { P20_RENDER } from './lighter-tiles';

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
const saved = { ...P20_RENDER };
afterEach(() => { Object.assign(P20_RENDER, saved); });

async function scenario(cheap: boolean) {
    P20_RENDER.cheapCompaction = cheap;
    const { Renderer3D } = await import('./renderer-3d');
    const { Camera3D } = await import('./camera-3d');
    const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
    const dev = recordingDevice();
    const r = new Renderer3D(dev.device, new Camera3D()) as unknown as Record<string, any>;
    const geo = (verts: number, seed: number) => {
        const v = new Float32Array(verts * 12), ix = new Uint32Array(verts - (verts % 3));
        for (let i = 0; i < v.length; i++) v[i] = ((i * 2654435761 + seed * 97) % 1000) / 100;
        for (let i = 0; i < ix.length; i++) ix[i] = (i * 7) % (verts - (verts % 3));
        return { vertices: v, indices: ix, format: '12float' as const };
    };
    const mk = (verts: number, seed: number, key?: string, g = geo(verts, seed)) => {
        const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: g });
        m.name = `m${seed}`;
        if (key) m.setGeometryKeyOverride(key);
        return m;
    };
    const shared = geo(900, 7);
    const meshes = [
        ...Array.from({ length: 30 }, (_, i) => mk(500 + i * 41, i)),
        mk(0, 99, 'shared', shared), mk(0, 98, 'shared', shared), mk(0, 97, 'shared', shared),
    ];
    for (let f = 0; f < 50 && meshes.some(m => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(meshes);
    // dead space: evict a third; a mesh off this frame's list but mapped (kept resident: its key is live via a sharer)
    const gone = meshes.filter((_, i) => i % 3 === 0 && i < 30);
    r.evictMeshCaches(gone.map(m => m.id));
    const offList = meshes[31];
    const list = meshes.filter(m => !gone.includes(m) && m !== offList);
    // a new mesh sharing a live key, and a fresh one
    const sharer = mk(0, 96, 'shared', shared), freshM = mk(1234, 500);
    list.push(sharer, freshM);
    const before = new Map<string, unknown>([...r._geomKeyAllocs]);
    expect(r._compactGeomPoolGpu(list)).toBe(true);
    for (let f = 0; f < 60 && list.some(m => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(list);
    return { r, dev, list, offList, before };
}

describe('P20 cheapCompaction', () => {
    it('ends in the same allocations / refs / residency as the full bookkeeping, every byte in place', async () => {
        const full = await scenario(false), cheap = await scenario(true);
        const sig = (s: Awaited<ReturnType<typeof scenario>>) => s.list.map(m => { const a = s.r._geomAllocs.get(m.id); return `${m.name}:${a.baseVertex}:${a.firstIndex}:${a.indexCount}`; });
        expect(sig(cheap)).toEqual(sig(full));
        // ref counts per listed mesh's key (custom keys carry random mesh ids, so compare through the meshes)
        const refs = (s: Awaited<ReturnType<typeof scenario>>) => s.list.map(m => `${m.name}:${s.r._geomKeyRefs.get(m.geometryKey)}`);
        expect(refs(cheap)).toEqual(refs(full));
        expect(cheap.r._geomKeyRefs.get('shared')).toBe(3);   // 2 listed sharers + the new one; the off-list mesh released its ref
        // dead keys (the evicted meshes') are gone from both; the off-list mesh is unmapped in both
        expect(cheap.r._geomKeyAllocs.size).toBe(full.r._geomKeyAllocs.size);
        expect(cheap.r._geomAllocs.size).toBe(full.r._geomAllocs.size);
        for (const s of [full, cheap]) expect(s.r._geomAllocs.has(s.offList.id)).toBe(false);
        for (const s of [full, cheap]) {
            const vb = s.dev.mem.get(s.r._geomVB)!, ib = s.dev.mem.get(s.r._geomIB)!;
            for (const m of s.list) {
                const a = s.r._geomAllocs.get(m.id), g = m.geometry!;
                const vo = a.baseVertex * 48, io = a.firstIndex * 4;
                expect(Buffer.from(vb.subarray(vo, vo + g.vertices.byteLength)).equals(Buffer.from(new Uint8Array(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength)))).toBe(true);
                expect(Buffer.from(ib.subarray(io, io + g.indices.byteLength)).equals(Buffer.from(new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength)))).toBe(true);
            }
            // every moved key got a NEW alloc object (identity is what the GPU-driven records compare)
            for (const [k, a] of s.r._geomKeyAllocs) if (s.before.has(k)) expect(a).not.toBe(s.before.get(k));
        }
    });
});
