/**
 * P22 packedVertices (performance-plan §P22, vertex-pack.ts): the packed pool format is lossless and every packed
 * byte lands where its allocation says.
 *   · encode / decode: 12-float → 8-float → 12-float is exact (bit for bit, −0 included); a non-constant tangent refuses;
 *     32 → 16-bit indices exact, padded to an even count, ≥ 65,536 refuses;
 *   · the twin vertex state: the 48-byte layout → slot 0 at stride 32 + the tangent at arrayStride 0;
 *   · the REAL Renderer3D pool on a recording device (buffers are byte arrays): packable geometry is stored packed
 *     (whole writes, slices, the GPU compaction, the full rebuild, a switch flip), mixed with 48-byte geometry in one
 *     pool (every span a multiple of 96 bytes, so both strides address it), and decodes back to the CPU arrays;
 *   · draws: a packed allocation draws with the twin pipeline, the tangent buffer in slot 1 and uint16 indices, an
 *     unpacked one with the base pipeline and uint32 — in any order on one pass.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import { packVertices, unpackVertices, packIndices, packedVertexBuffers, poolViewOf, alignVtx, POOL_VTX_ALIGN, noteTwinSource, packedTwin } from './vertex-pack';
import { P22_RENDER } from './tile-landing';
import { STREAM_HITCH } from './stream-hitch';
const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** 12-float vertices with the constant tangent (1, 0, 0, 1) and varied position / normal / uv values. */
function cityVerts(n: number, seed: number): Float32Array {
    const v = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
        const o = i * 12;
        for (let k = 0; k < 8; k++) v[o + k] = (((i * 2654435761 + k * 40503 + seed * 97) >>> 0) % 100000) / 977 - 50;
        v[o + 8] = 1; v[o + 9] = 0; v[o + 10] = 0; v[o + 11] = 1;
    }
    return v;
}

describe('P22 packed vertices: encode / decode', () => {
    it('12 → 8 → 12 floats is exact (bit for bit, −0 and tiny values included)', () => {
        const v = cityVerts(5000, 3);
        v[0] = -0; v[13] = 1e-38; v[26] = -3.4e38; v[30] = 0.1;
        const p = packVertices(v)!;
        expect(p.length).toBe(5000 * 8);
        const back = unpackVertices(p);
        expect(Buffer.from(back.buffer).equals(Buffer.from(v.buffer))).toBe(true);
        expect(Object.is(back[0], -0)).toBe(true);
    });
    it('a non-constant tangent is refused (the geometry stays in the 48-byte format)', () => {
        const v = cityVerts(100, 4);
        v[57 * 12 + 9] = 0.25;
        expect(packVertices(v)).toBeNull();
    });
    it('32 → 16-bit indices: exact, an even count (0-padded), ≥ 65,536 refused', () => {
        const ix = Uint32Array.from({ length: 30001 }, (_, i) => (i * 7919) % 65536);
        const p = packIndices(ix)!;
        expect(p.length).toBe(30002);
        for (let i = 0; i < ix.length; i++) expect(p[i]).toBe(ix[i]);
        expect(p[30001]).toBe(0);
        expect(packIndices(Uint32Array.of(0, 1, 65536))).toBeNull();
    });
    it('the twin vertex state: slot 0 at stride 32, the tangent from slot 1 at arrayStride 0', () => {
        const full: GPUVertexBufferLayout = { arrayStride: 48, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x4' }] };
        const t = packedVertexBuffers([full])!;
        expect(t).toHaveLength(2);
        expect(t[0].arrayStride).toBe(32);
        expect([...t[0].attributes].map((a) => [a.shaderLocation, a.offset])).toEqual([[0, 0], [1, 12], [2, 24]]);
        expect(t[1]).toEqual({ arrayStride: 0, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] });
        // position-only (shadow / highlight): one buffer
        expect(packedVertexBuffers([{ arrayStride: 48, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }])).toEqual([{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }]);
        // not the pool layout: no twin
        expect(packedVertexBuffers([full, { arrayStride: 16, attributes: [] }])).toBeNull();
        expect(packedVertexBuffers([{ arrayStride: 72, attributes: [] }])).toBeNull();
        expect(packedVertexBuffers([{ ...full, stepMode: 'instance' }])).toBeNull();
        expect(packedVertexBuffers(undefined)).toBeNull();
    });
    it('pool views: mode off = the geometry itself unpadded; mode on = 96-byte spans, packed when packable', () => {
        const g = { vertices: cityVerts(301, 5), indices: Uint32Array.from({ length: 903 }, (_, i) => i % 301), format: '12float' as const };
        const off = poolViewOf(g, false);
        expect(off.pk).toBe(false); expect(off.vtxBytes).toBe(301 * 48); expect(off.idxBytes).toBe(903 * 4);
        const pad = poolViewOf(g, true);   // not marked packable
        expect(pad.pk).toBe(false); expect(pad.vtxBytes).toBe(alignVtx(301 * 48)); expect(pad.vtxBytes % POOL_VTX_ALIGN).toBe(0);
        (g as { packable?: boolean }).packable = true;
        const pk = poolViewOf(g, true);
        expect(pk.pk).toBe(true);
        expect(pk.vb.byteLength).toBe(301 * 32); expect(pk.vtxBytes % POOL_VTX_ALIGN).toBe(0);
        expect(pk.ib.byteLength).toBe(904 * 2); expect(pk.idxBytes % 4).toBe(0);
        expect(poolViewOf(g, true)).toBe(pk);   // cached while uploading
        expect(poolViewOf(g, true, false).pk).toBe(false);   // the twins not ready yet: unpacked (padded)
    });
});

// ── the real pool on a recording device ─────────────────────────────────────────────────────────────────────────────

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
            const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const n = size ?? (src.byteLength - dataOff);
            expect(off % 4).toBe(0); expect(n % 4).toBe(0);   // WebGPU: 4-byte aligned writes
            const m = mem.get(buf); if (m) m.set(src.subarray(dataOff, dataOff + n), off);
        };
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
        return stub;
    } });
    let twins = 0;
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        // a twin compiles at once (a distinct object per twin)
        if (k === 'createRenderPipelineAsync') return (d: GPURenderPipelineDescriptor) => Promise.resolve({ twin: ++twins, label: d.label, buffers: d.vertex.buffers });
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => { const b = { size: d.size, destroy() { /* */ }, label: '' }; mem.set(b, new Uint8Array(d.size)); return b; };
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

async function setup() {
    const { Renderer3D } = await import('./renderer-3d');
    const { Camera3D } = await import('./camera-3d');
    const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
    const dev = recordingDevice();
    const r = new Renderer3D(dev.device, new Camera3D()) as unknown as Record<string, any>;
    r._pkGate = 2;   // the twin pipelines are "compiled": packable geometry is stored packed from the first placement
    let seq = 0;
    const mk = (verts: number, packable: boolean, tangentOff = false) => {
        const v = cityVerts(verts, ++seq);
        if (tangentOff) v[8] = 0.5;
        const ix = Uint32Array.from({ length: verts - (verts % 3) }, (_, i) => (i * 31) % verts);
        const geo = { vertices: v, indices: ix, format: '12float' as const, ...(packable ? { packable: true } : {}) };
        const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: geo });
        m.name = `m${seq}`;
        return m;
    };
    /** Every mesh's geometry decodes from the modelled pool at its allocation. */
    const check = (meshes: { id: string; geometry: { vertices: Float32Array; indices: Uint32Array } }[]) => {
        const vb = dev.mem.get(r._geomVB)!, ib = dev.mem.get(r._geomIB)!;
        let packed = 0;
        for (const m of meshes) {
            const a = r._geomAllocs.get(m.id), g = m.geometry;
            expect(a, 'allocated').toBeDefined();
            const n = g.vertices.length / 12;
            if (a.pk) {
                packed++;
                const vo = a.baseVertex * 32, io = a.firstIndex * 2;
                expect(vo % POOL_VTX_ALIGN === 0 || vo % 32 === 0).toBe(true);
                const pv = new Float32Array(vb.slice(vo, vo + n * 32).buffer);
                expect(Buffer.from(unpackVertices(pv).buffer).equals(Buffer.from(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength))).toBe(true);
                const pi = new Uint16Array(ib.slice(io, io + g.indices.length * 2).buffer);
                for (let i = 0; i < g.indices.length; i++) if (pi[i] !== g.indices[i]) throw new Error(`index ${i}`);
            } else {
                const vo = a.baseVertex * 48, io = a.firstIndex * 4;
                expect(Buffer.from(vb.subarray(vo, vo + g.vertices.byteLength)).equals(Buffer.from(g.vertices.buffer, g.vertices.byteOffset, g.vertices.byteLength))).toBe(true);
                expect(Buffer.from(ib.subarray(io, io + g.indices.byteLength)).equals(Buffer.from(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength))).toBe(true);
            }
            if (r._pkMode) expect(a.vtxBytes % POOL_VTX_ALIGN).toBe(0);
        }
        return packed;
    };
    return { r, dev, mk, check, Renderer3D };
}

describe('P22 packed vertices: the geometry pool', () => {
    it('packable geometry is stored packed next to 48-byte geometry; appends, slices, a GPU compaction, a full rebuild', async () => {
        const { r, mk, check } = await setup();
        expect(P22_RENDER.packedVertices).toBe(true);
        const seed = [mk(300, true), mk(301, false)];
        expect(r._ensureGeomPool(seed)).toBe(true);   // first pool: a full rebuild
        expect(check(seed)).toBe(1);
        // appends: small (whole writes) and big (> the 2 MB write slice: sliced), packable or not, a bad tangent
        const more = [mk(2000, true), mk(1999, false), mk(65536, true), mk(70000, true), mk(50000, false), mk(900, true, true)];
        const all = [...seed, ...more];
        for (let f = 0; f < 300 && all.some((m) => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(all);
        expect(check(all)).toBe(3);   // 300, 2000, 65536 packed; 70000 vertices (> 16 bits) and the bad tangent are not
        expect(r._geomAllocs.get(more[3].id).pk).toBe(false);
        expect(r._geomAllocs.get(more[5].id).pk).toBe(false);
        // evict some, compact on the GPU (moves keep each format), then fresh geometry appended after it
        r.evictMeshCaches([all[1].id, all[2].id, all[6].id]);
        const live = all.filter((_, i) => i !== 1 && i !== 2 && i !== 6);
        const fresh = [mk(4000, true), mk(3001, false)];
        expect(r._compactGeomPoolGpu([...live, ...fresh])).toBe(true);
        const after = [...live, ...fresh];
        for (let f = 0; f < 100 && after.some((m) => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(after);
        expect(check(after)).toBe(3);
        // a full rebuild
        expect(r._fullRebuildGeomPool(after)).toBe(true);
        expect(check(after)).toBe(3);
        expect(r.getGeomPoolStats().packedKeys).toBe(3);
    });
    it('a switch flip re-places the pool in the new format (off = every allocation 48 bytes, unpadded)', async () => {
        const { r, mk, check } = await setup();
        const ms = [mk(500, true), mk(501, false), mk(5000, true)];
        r._ensureGeomPool(ms);
        for (let f = 0; f < 20 && ms.some((m) => !r._geomAllocs.has(m.id)); f++) r._ensureGeomPool(ms);
        expect(check(ms)).toBe(2);
        P22_RENDER.packedVertices = false;
        try {
            r.repackGeometryPool();
            r._ensureGeomPool(ms);
            expect(r._pkMode).toBe(false);
            for (const m of ms) expect(r._geomAllocs.get(m.id).pk).toBe(false);
            expect(r._geomAllocs.get(ms[1].id).vtxBytes).toBe(501 * 48);   // the old pool, byte for byte
            check(ms);
        } finally { P22_RENDER.packedVertices = true; }
        r.repackGeometryPool();
        r._ensureGeomPool(ms);
        expect(check(ms)).toBe(2);
    });
    it('partial uploads of a packed allocation (moving contact blobs, live-crowd index edits) write the packed bytes', async () => {
        const { r, dev, mk } = await setup();
        const m = mk(600, true);
        r._ensureGeomPool([m]);
        const a = r._geomAllocs.get(m.id);
        expect(a.pk).toBe(true);
        const v = m.geometry.vertices as Float32Array, ix = m.geometry.indices as Uint32Array;
        for (let i = 100 * 12; i < 140 * 12; i++) if (i % 12 < 8) v[i] += 3.5;   // move vertices 100..139
        expect(r.patchMeshVertices(m, 100, 40)).toBe(true);
        for (let i = 33; i < 77; i++) ix[i] = (ix[i] + 5) % 600;                // edit indices 33..76 (odd start)
        expect(r.patchMeshIndices(m, 33, 44)).toBe(true);
        const vb = dev.mem.get(r._geomVB)!, ib = dev.mem.get(r._geomIB)!;
        const pv = new Float32Array(vb.slice(a.baseVertex * 32, a.baseVertex * 32 + 600 * 32).buffer);
        expect(Buffer.from(unpackVertices(pv).buffer).equals(Buffer.from(v.buffer))).toBe(true);
        const pi = new Uint16Array(ib.slice(a.firstIndex * 2, a.firstIndex * 2 + ix.length * 2).buffer);
        for (let i = 0; i < ix.length; i++) expect(pi[i]).toBe(ix[i]);
    });
    it('a vertex-coloured (Edit Mesh) mesh: the patch also reaches the standalone VB override it draws from', async () => {
        const { r, dev, mk } = await setup();
        for (const packable of [true, false]) {
            const m = mk(300, packable);
            m.vertexColors = new Float32Array(300 * 4).fill(1);
            r._ensureGeomPool([m]);
            r._uploadVCBuffers(m);                                                   // (what the frame does for a VC mesh)
            const ov = r._vertexBufferOverrides.get(m.id);
            expect(ov).toBeDefined();
            const v = m.geometry.vertices as Float32Array;
            for (let i = 40 * 12; i < 52 * 12; i++) if (i % 12 < 3) v[i] += 2.25;   // move vertices 40..51
            expect(r.patchMeshVertices(m, 40, 12)).toBe(true);
            const bytes = dev.mem.get(ov)!;
            expect(Buffer.from(bytes.subarray(0, v.byteLength)).equals(Buffer.from(v.buffer, v.byteOffset, v.byteLength))).toBe(true);
        }
    });
});

describe('P22 packed vertices: draws', () => {
    it('a packed allocation draws with the twin + slot-1 tangent + uint16; an unpacked one with the base + uint32', async () => {
        const { r, mk } = await setup();
        const a = mk(300, true), b = mk(301, false), c = mk(302, true);
        r._ensureGeomPool([a, b, c]);
        const base = { base: true } as unknown as GPURenderPipeline;
        noteTwinSource(base, { layout: 'auto', vertex: { module: {} as GPUShaderModule, entryPoint: 'vs_main', buffers: [{ arrayStride: 48, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 3, offset: 32, format: 'float32x4' }] }] } });
        expect(packedTwin(r.device, base)).toBeNull();   // compiling
        await new Promise((res) => setTimeout(res, 0));
        const twin = packedTwin(r.device, base)!;
        expect(twin).not.toBeNull();
        const calls: string[] = [];
        const pass = {
            setPipeline: (p: unknown) => calls.push(p === base ? 'pipe:base' : p === twin ? 'pipe:twin' : 'pipe:?'),
            setIndexBuffer: (_b: unknown, f: string) => calls.push('ib:' + f),
            setVertexBuffer: (s: number) => calls.push('vb' + s),
            drawIndexed: (_n: number, _i: number, fi: number, bv: number) => calls.push(`draw:${fi}/${bv}`),
        } as unknown as GPURenderPassEncoder;
        const ref = { vb: r._geomVB };
        r._setPipe(pass, base);
        r._drawMesh(pass, a, 0, ref); r._drawMesh(pass, c, 1, ref); r._drawMesh(pass, b, 2, ref); r._drawMesh(pass, a, 3, ref);
        const A = r._geomAllocs.get(a.id), B = r._geomAllocs.get(b.id), C = r._geomAllocs.get(c.id);
        expect(calls).toEqual(['pipe:base',
            'pipe:twin', 'vb1', 'ib:uint16', `draw:${A.firstIndex}/${A.baseVertex}`, `draw:${C.firstIndex}/${C.baseVertex}`,
            'pipe:base', 'ib:uint32', `draw:${B.firstIndex}/${B.baseVertex}`,
            'pipe:twin', 'ib:uint16', `draw:${A.firstIndex}/${A.baseVertex}`]);
        // the pool's index buffer rebound by other code: the next draw binds its format again
        calls.length = 0;
        r._pkLost(pass);
        r._drawMesh(pass, c, 4, ref);
        expect(calls).toEqual(['vb1', 'ib:uint16', `draw:${C.firstIndex}/${C.baseVertex}`]);
        expect(STREAM_HITCH.uploadLedger).toBe(true);
    });
});
