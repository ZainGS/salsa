/**
 * Step 3 sliced uploads (performance-plan §P13 "Step 3"): the geometry pool writes at most UPLOAD_FRAME_BUDGET bytes
 * a frame (render-time appends + warm calls together), nearest-in-view geometry first, and a geometry bigger than the
 * budget in slices — and every geometry ends up in the pool byte for byte, drawable only once all of it is in.
 *
 * Runs the REAL Renderer3D pool code on a recording GPU device that models buffer contents (writeBuffer and
 * copyBufferToBuffer are applied to byte arrays), so offsets / slices / pool growth are checked end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { STREAM_HITCH, STREAM_HITCH_LIMITS } from './stream-hitch';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A device whose buffers are byte arrays: writeBuffer / copyBufferToBuffer really move bytes. Everything else stubs. */
function recordingDevice() {
    const mem = new Map<object, Uint8Array>();
    const writes: Array<{ buf: object; bytes: number }> = [];
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
            const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const n = size ?? (src.byteLength - dataOff);
            const m = mem.get(buf); if (m) m.set(src.subarray(dataOff, dataOff + n), off);
            writes.push({ buf, bytes: n });
        };
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
        return stub;
    } });
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => { const b = { size: d.size, destroy() { /* */ }, label: '' }; mem.set(b, new Uint8Array(d.size)); return b; };
        if (k === 'createCommandEncoder') return () => encoder;
        if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
        return stub;
    } });
    return { device: device as unknown as GPUDevice, mem, writes };
}

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function setup() {
    const { Renderer3D } = await import('./renderer-3d');
    const { Camera3D } = await import('./camera-3d');
    const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
    const dev = recordingDevice();
    const cam = new Camera3D();
    const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
    const mk = (verts: number, x: number, seed: number) => {
        const v = new Float32Array(verts * 12), ix = new Uint32Array(verts - (verts % 3));
        for (let i = 0; i < v.length; i++) v[i] = ((i * 2654435761 + seed * 97) % 1000) / 100 + (i % 12 === 0 ? x : 0);
        for (let i = 0; i < ix.length; i++) ix[i] = i;
        const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: v, indices: ix, format: '12float' } });
        m.name = `m${seed}`;
        return m;
    };
    return { r, dev, mk, Renderer3D, cam };
}

describe('step 3 sliced geometry uploads', () => {
    // the step-3 budget (16 MB a frame, 4 MB a write); the P16 ledger is tested below
    const ledger = STREAM_HITCH.uploadLedger;
    beforeAll(() => { STREAM_HITCH.uploadLedger = false; });
    afterAll(() => { STREAM_HITCH.uploadLedger = ledger; });
    it('≤ the frame budget per frame, big geometry in slices, every byte lands where its allocation says', async () => {
        const { r, dev, mk, Renderer3D } = await setup();
        const R = Renderer3D as unknown as { slicedUploads: boolean; UPLOAD_FRAME_BUDGET: number };
        expect(R.slicedUploads).toBe(true);
        const budget = R.UPLOAD_FRAME_BUDGET;
        const seed = mk(300, 0, 1);
        expect(r._ensureGeomPool([seed])).toBe(true);   // first pool: a full rebuild
        // 3 big geometries (each > the budget), 40 small ones, at increasing distance
        const meshes = [seed];
        for (let i = 0; i < 3; i++) meshes.push(mk(Math.ceil((budget * 0.9) / 48), 100 + i * 50, 10 + i));   // 3 x ~14 MB: sliced, 4 MB a frame each
        for (let i = 0; i < 40; i++) meshes.push(mk(2000 + i * 37, i * 3, 100 + i));
        let frames = 0, maxFrame = 0;
        while (meshes.some((m) => !r._geomAllocs.has(m.id)) && frames < 200) {
            const before = dev.writes.length;
            // a warm call between frames shares the frame's budget
            r.warmGeometry(meshes.slice(10, 20), 8 << 20);
            r._ensureGeomPool(meshes);
            const bytes = dev.writes.slice(before).reduce((s, w) => s + w.bytes, 0);
            maxFrame = Math.max(maxFrame, bytes);
            // a mesh is drawable only once ALL of its geometry is in
            for (const m of meshes) if (r._geomAllocs.has(m.id)) expect(r._geomPartial.has(m.geometryKey)).toBe(false);
            frames++;
        }
        expect(frames).toBeLessThan(200);
        expect(maxFrame).toBeLessThanOrEqual(budget);
        expect(r.getGeomPoolStats().maxWriteMB).toBeLessThanOrEqual(4);   // no single write over UPLOAD_GEOM_SLICE
        expect(r.getGeomPoolStats().slicedGeoms).toBeGreaterThanOrEqual(3);
        // every geometry's bytes are in the modelled pool at its allocation
        const vb = dev.mem.get(r._geomVB)!, ib = dev.mem.get(r._geomIB)!;
        for (const m of meshes) {
            const a = r._geomAllocs.get(m.id);
            const g = m.geometry;
            const vbytes = new Uint8Array(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength);
            const ibytes = new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength);
            const vo = a.baseVertex * 48, io = a.firstIndex * 4;
            expect(Buffer.from(vb.subarray(vo, vo + vbytes.length)).equals(Buffer.from(vbytes))).toBe(true);
            expect(Buffer.from(ib.subarray(io, io + ibytes.length)).equals(Buffer.from(ibytes))).toBe(true);
        }
    });

    it('switch off = the old path (one writeBuffer per geometry, up to 16 MB a frame)', async () => {
        const { r, dev, mk, Renderer3D } = await setup();
        const R = Renderer3D as unknown as { slicedUploads: boolean; UPLOAD_FRAME_BUDGET: number };
        R.slicedUploads = false;
        try {
            const seed = mk(300, 0, 1);
            r._ensureGeomPool([seed]);
            const big = mk(Math.ceil((R.UPLOAD_FRAME_BUDGET * 2.6) / 48), 100, 2);
            const before = dev.writes.length;
            r._ensureGeomPool([seed, big]);
            expect(r._geomAllocs.has(big.id)).toBe(true);   // all in one frame
            const w = dev.writes.slice(before);
            expect(Math.max(...w.map((x) => x.bytes))).toBe(big.geometry.vertices.byteLength);
        } finally { R.slicedUploads = true; }
    });

    it('in-view, near geometry is uploaded before far / out-of-view geometry', async () => {
        const { r, mk, cam } = await setup();
        cam.setPosition(0, 2, 0); cam.setTarget(100, 0, 0);
        cam.aspect = 1.5;
        r._culler.setFromViewProjection(cam.getViewProjectionMatrix());
        const seed = mk(300, 0, 1);
        r._ensureGeomPool([seed]);
        const inView = Array.from({ length: 10 }, (_, i) => mk(32000, 20 + i * 4, 10 + i));   // ~1.5 MB each, ~15 MB in all
        const behind = mk(32000, -30, 4);   // nearer than most of them, but out of view
        r._ensureGeomPool([seed, behind, ...inView]);
        for (const m of inView) expect(r._geomAllocs.has(m.id)).toBe(true);
        expect(r._geomAllocs.has(behind.id)).toBe(false);
        r._ensureGeomPool([seed, behind, ...inView]);
        expect(r._geomAllocs.has(behind.id)).toBe(true);   // next frame
    });
});

describe('P16 upload ledger (geometry side)', () => {
    it('≤ the ledger frame total, ≤ the write cap per write, every byte lands at its allocation', async () => {
        const { r, dev, mk } = await setup();
        STREAM_HITCH.uploadLedger = true;
        const L = STREAM_HITCH_LIMITS;
        const seed = mk(300, 0, 1);
        r._ensureGeomPool([seed]);
        const meshes = [seed];
        for (let i = 0; i < 3; i++) meshes.push(mk(Math.ceil((L.frameWriteBytes * 0.9) / 48), 100 + i * 50, 10 + i));
        for (let i = 0; i < 40; i++) meshes.push(mk(2000 + i * 37, i * 3, 100 + i));
        let frames = 0, maxFrame = 0, maxWrite = 0;
        while (meshes.some((m) => !r._geomAllocs.has(m.id)) && frames < 400) {
            const before = dev.writes.length;
            r._noteInstBytes(1 << 20);                 // this frame's instance writes come first
            r.warmGeometry(meshes.slice(10, 20), 8 << 20);
            r._ensureGeomPool(meshes);
            const w = dev.writes.slice(before);
            maxFrame = Math.max(maxFrame, w.reduce((s, x) => s + x.bytes, 0) + (1 << 20));
            for (const x of w) maxWrite = Math.max(maxWrite, x.bytes);
            for (const m of meshes) if (r._geomAllocs.has(m.id)) expect(r._geomPartial.has(m.geometryKey)).toBe(false);
            frames++;
        }
        expect(frames).toBeLessThan(400);
        expect(maxFrame).toBeLessThanOrEqual(L.frameWriteBytes);
        expect(maxWrite).toBeLessThanOrEqual(L.writeSliceBytes);
        const vb = dev.mem.get(r._geomVB)!, ib = dev.mem.get(r._geomIB)!;
        for (const m of meshes) {
            const a = r._geomAllocs.get(m.id), g = m.geometry;
            const vo = a.baseVertex * 48, io = a.firstIndex * 4;
            expect(Buffer.from(vb.subarray(vo, vo + g.vertices.byteLength)).equals(Buffer.from(new Uint8Array(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength)))).toBe(true);
            expect(Buffer.from(ib.subarray(io, io + g.indices.byteLength)).equals(Buffer.from(new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength)))).toBe(true);
        }
    });
    it('a GPU compaction moves the live geometry and leaves fresh geometry to the sliced append (no whole writes)', async () => {
        for (const ledger of [false, true]) {
            const { r, dev, mk } = await setup();
            STREAM_HITCH.uploadLedger = ledger;
            const live = Array.from({ length: 12 }, (_, i) => mk(i === 0 ? 400000 : 3000 + i * 50, i * 4, 200 + i));   // [0]: ~19 MB of capacity, freed below
            r._ensureGeomPool(live);
            for (let f = 0; f < 50 && live.some((m) => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(live);
            const gone = live.splice(0, 6);
            r.evictMeshCaches(gone.map((m) => m.id));          // dead space for the compaction to squeeze out
            const fresh = Array.from({ length: 5 }, (_, i) => mk(60000 + i * 999, 50 + i, 300 + i));   // ~2.9 MB each: over the write cap
            const before = dev.writes.length;
            expect(r._compactGeomPoolGpu([...live, ...fresh])).toBe(true);
            const big = dev.writes.slice(before).reduce((m, x) => Math.max(m, x.bytes), 0);
            if (ledger) {
                expect(big).toBe(0);                                     // nothing written in the compaction frame
                for (const m of fresh) expect(r._geomAllocs.has(m.id)).toBe(false);
                expect(r._geomAppendDeferred).toBe(true);                 // held out of the draw lists
            } else expect(big).toBe(fresh[4].geometry.vertices.byteLength);   // the old path: whole writes
            const all = [...live, ...fresh];
            for (let f = 0; f < 200 && all.some((m) => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(all);
            const vb = dev.mem.get(r._geomVB)!, ib = dev.mem.get(r._geomIB)!;
            for (const m of all) {
                const a = r._geomAllocs.get(m.id), g = m.geometry;
                expect(a).toBeDefined();
                const vo = a.baseVertex * 48, io = a.firstIndex * 4;
                expect(Buffer.from(vb.subarray(vo, vo + g.vertices.byteLength)).equals(Buffer.from(new Uint8Array(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength)))).toBe(true);
                expect(Buffer.from(ib.subarray(io, io + g.indices.byteLength)).equals(Buffer.from(new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength)))).toBe(true);
            }
        }
        STREAM_HITCH.uploadLedger = true;
    });
});
