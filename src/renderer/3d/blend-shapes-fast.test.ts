/**
 * Fast blend shapes (Character v2 Phase 1.5, docs/specs/blend-shapes.md "Fast path").
 *   · CPU: Mesh3D.applyBlendWeights (incremental, sparse supports) equals the full evaluateBlendShapes within ε over
 *     long random weight sequences (rebases included), restores the base exactly when every weight is back at 0, and
 *     the full evaluation itself is unchanged from the original dense loop (bit for bit);
 *   · skinned part on the REAL Renderer3D over a recording device: a weight change writes only the dirty vertex range
 *     into the EXISTING vertex buffer — no createBuffer, no index upload — and the GPU bytes equal a fresh full build;
 *     all weights 0 gives the same bytes as the same part without blend shapes; the old path stays selectable;
 *   · static mesh: the dirty range is patched into its pool allocation (no gpuDirty → no pool rebuild);
 *   · picker: a morph re-derives the BVH lazily (picks hit the morphed surface);
 *   · glTF export writes the BASE vertices + targets + weights (the evaluated morph was double-applied on re-import).
 * No wall-clock assertions.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import type { ManagerContext } from '../../services/managers/manager-context';
import { webcrypto } from 'node:crypto';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    const flags = new Proxy({}, { get: () => 1 });
    for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

/** A recording device: buffers are byte arrays; createBuffer / writeBuffer calls are logged. */
function recordingDevice() {
    const mem = new Map<object, Uint8Array>();
    const writes: { buf: object; off: number; n: number }[] = [];
    let creates = 0;
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
            writes.push({ buf, off, n });
        };
        if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
        return stub;
    } });
    const device = new Proxy({}, { get: (_t, k) => {
        if (k === 'queue') return queue;
        if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
        if (k === 'createBuffer') return (d: { size: number }) => { creates++; const b = { size: d.size, destroy() { /* */ }, label: '' }; mem.set(b, new Uint8Array(d.size)); return b; };
        if (k === 'createCommandEncoder') return () => encoder;
        if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
        return stub;
    } });
    return { device: device as unknown as GPUDevice, mem, writes, creates: () => creates };
}

/** A deterministic grid-ish surface: nv vertices (12 floats each). */
function surfaceVerts(nv: number): Float32Array {
    const v = new Float32Array(nv * 12);
    for (let i = 0; i < nv; i++) {
        const o = i * 12, x = (i % 71) / 70, y = Math.floor(i / 71) / 70;
        v[o] = x - 0.5; v[o + 1] = y; v[o + 2] = Math.sin(x * 3) * 0.1;
        v[o + 5] = 1; v[o + 6] = x; v[o + 7] = y; v[o + 8] = 1; v[o + 11] = 1;
    }
    return v;
}
function surfaceIndices(nv: number): Uint32Array {
    const n = Math.floor((nv - 2) / 3) * 3, ix = new Uint32Array(n);
    for (let i = 0; i < n; i++) ix[i] = (i * 7) % nv;
    return ix;
}
/** A sparse shape: deltas on a contiguous-ish region [lo, lo + span) (every 1st..3rd vertex), zero elsewhere. */
function sparseShape(nv: number, seed: number, lo: number, span: number): Float32Array {
    const d = new Float32Array(nv * 6);
    let s = seed * 2654435761 >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
    for (let v = lo; v < Math.min(nv, lo + span); v++) {
        if ((v + seed) % 3 === 2) continue;
        for (let k = 0; k < 6; k++) d[v * 6 + k] = rnd() * (k < 3 ? 0.05 : 0.2);
    }
    return d;
}

/** The ORIGINAL dense evaluateBlendShapes loop, verbatim (the reference). */
function denseReference(base: Float32Array, shapes: { deltaVertices: Float32Array }[], w: Float32Array): Float32Array {
    const out = base.slice(), nv = base.length / 12;
    for (let si = 0; si < shapes.length; si++) {
        const ww = w[si] ?? 0;
        if (Math.abs(ww) < 1e-7) continue;
        const d = shapes[si].deltaVertices;
        for (let vi = 0; vi < nv; vi++) for (let k = 0; k < 6; k++) out[vi * 12 + k] += ww * d[vi * 6 + k];
    }
    return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
    let m = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
    return m;
}

async function mods() {
    const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
    const { SkinnedMesh3D } = await import('../../scene-graph/shapes/skinned-mesh-3d');
    const { Skeleton3D } = await import('../../scene-graph/shapes/skeleton-3d');
    const { Scene3DBlendShapes } = await import('../../services/managers/scene3d-blend-shapes');
    const { Renderer3D } = await import('./renderer-3d');
    const { Camera3D } = await import('./camera-3d');
    return { Mesh3D, SkinnedMesh3D, Skeleton3D, Scene3DBlendShapes, Renderer3D, Camera3D };
}

const NV = 5000, NS = 30;

async function makeCharacterPart(withShapes = true) {
    const { SkinnedMesh3D, Skeleton3D } = await mods();
    const mesh = new SkinnedMesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: surfaceVerts(NV), indices: surfaceIndices(NV), format: '12float' } });
    mesh.transformViaSkeleton = true;
    mesh.jointIndices = new Uint8Array(NV * 4);
    mesh.jointWeights = new Float32Array(NV * 4);
    for (let i = 0; i < NV; i++) { mesh.jointIndices[i * 4] = i % 2; mesh.jointWeights[i * 4] = 0.75; mesh.jointIndices[i * 4 + 1] = 1 - (i % 2); mesh.jointWeights[i * 4 + 1] = 0.25; }
    mesh.skinDirty = true;
    const skel = new Skeleton3D({ name: 'char', joints: [], clips: [] });
    skel.addJoint(-1, [0, 0, 0], 'root');
    skel.addJoint(0, [0, 1, 0], 'spine');
    skel.computeInverseBindMatrices();
    skel.computeWorldMatrices();
    mesh.skeleton = skel; mesh.skeletonId = skel.id;
    if (withShapes) {
        mesh.baseVertices = new Float32Array(mesh.geometry.vertices);
        for (let s = 0; s < NS; s++) mesh.blendShapes.push({ name: `s${s}`, deltaVertices: sparseShape(NV, s + 1, (s * 157) % NV, 400 + (s % 5) * 300) });
        mesh.blendWeights = new Float32Array(NS);
    }
    return mesh;
}

afterEach(async () => {
    const { Mesh3D, Renderer3D } = await mods();
    Mesh3D.blendFastPath = true; Renderer3D.skinnedInPlaceUploads = true;
    Mesh3D.blendWeightMin = 0; Mesh3D.blendWeightMax = 1;
});

describe('Phase 1.5 fast blend shapes: CPU evaluation', () => {
    it('the full evaluateBlendShapes is bit-identical to the original dense loop', async () => {
        const mesh = await makeCharacterPart();
        for (let s = 0; s < NS; s++) mesh.blendWeights[s] = ((s * 37) % 11) / 10 - 0.05;
        mesh.evaluateBlendShapes();
        const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
        expect(Buffer.from(mesh.geometry.vertices.buffer).equals(Buffer.from(ref.buffer))).toBe(true);
        expect(mesh.gpuDirty).toBe(true);   // (the CPU-consumer contract is unchanged)
    });

    it('incremental applyBlendWeights equals the full evaluation within 1e-5 over 500 random edits (rebases included)', async () => {
        const { Mesh3D } = await mods();
        const mesh = await makeCharacterPart();
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
        let worst = 0;
        for (let step = 0; step < 500; step++) {
            const k = 1 + Math.floor(rnd() * 3);   // 1–3 sliders move per edit
            for (let j = 0; j < k; j++) mesh.blendWeights[Math.floor(rnd() * NS)] = rnd();
            const r = mesh.applyBlendWeights();
            expect(r).not.toBeNull();
            if (step % 25 === 0 || step === 499) {
                const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
                worst = Math.max(worst, maxAbsDiff(mesh.geometry.vertices, ref));
            }
        }
        expect(worst).toBeLessThan(1e-5);
        expect(Mesh3D.BLEND_REBASE_EVERY).toBeGreaterThan(0);
        // every weight back to 0 → the base, EXACTLY
        mesh.blendWeights.fill(0);
        mesh.applyBlendWeights();
        expect(Buffer.from(mesh.geometry.vertices.buffer).equals(Buffer.from(mesh.baseVertices!.buffer))).toBe(true);
    });

    it('one slider move dirties only that shape’s support range, logged under the bumped blendVersion', async () => {
        const mesh = await makeCharacterPart();
        mesh.applyBlendWeights();                      // first call: a full evaluation (no state yet)
        const v0 = mesh.blendVersion;
        mesh.blendWeights[3] = 0.5;
        const r = mesh.applyBlendWeights()!;
        const d = mesh.blendShapes[3].deltaVertices;
        let lo = NV, hi = 0;
        for (let v = 0; v < NV; v++) for (let k = 0; k < 6; k++) if (d[v * 6 + k] !== 0) { lo = Math.min(lo, v); hi = Math.max(hi, v + 1); }
        expect(r).toEqual([lo, hi]);
        expect(hi - lo).toBeLessThan(NV / 2);
        expect(mesh.blendVersion).toBe(v0 + 1);
        const out = new Int32Array(2);
        expect(mesh.blendRangeSince(v0, out)).toBe(true);
        expect([out[0], out[1]]).toEqual([lo, hi]);
        expect(mesh.blendRangeSince(v0 - 20, out)).toBe(false);   // too old → the caller sends everything
        expect(mesh.applyBlendWeights()).toBeNull();               // nothing changed → nothing to do
    });

    it('a replaced shape list / base re-anchors with a full evaluation', async () => {
        const mesh = await makeCharacterPart();
        mesh.blendWeights[0] = 1; mesh.applyBlendWeights();
        mesh.blendShapes = mesh.blendShapes.slice(1);       // remove shape 0 (the API reindexes weights too)
        mesh.blendWeights = mesh.blendWeights.slice(1);
        expect(mesh.applyBlendWeights()).toEqual([0, NV]);
        const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
        expect(maxAbsDiff(mesh.geometry.vertices, ref)).toBe(0);
    });

    it('the weight clamp is [0, 1] by default and widenable (backward compatible)', async () => {
        const { Mesh3D, Scene3DBlendShapes } = await mods();
        const mesh = await makeCharacterPart();
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh });
        sub.setWeight(mesh.id, 0, 1.7); expect(mesh.blendWeights[0]).toBe(1);
        sub.setWeight(mesh.id, 0, -0.4); expect(mesh.blendWeights[0]).toBe(0);
        Mesh3D.blendWeightMin = -1; Mesh3D.blendWeightMax = 2;
        sub.setWeight(mesh.id, 0, 1.7); expect(mesh.blendWeights[0]).toBeCloseTo(1.7);
        sub.setWeight(mesh.id, 0, -0.4); expect(mesh.blendWeights[0]).toBeCloseTo(-0.4);
        const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
        expect(maxAbsDiff(mesh.geometry.vertices, ref)).toBeLessThan(1e-6);
    });
});

describe('Phase 1.5 fast blend shapes: skinned part GPU buffers', () => {
    async function setup() {
        const m = await mods();
        const dev = recordingDevice();
        const r = new m.Renderer3D(dev.device, new m.Camera3D()) as unknown as Record<string, any>;
        return { ...m, dev, r };
    }
    const vbBytes = (r: Record<string, any>, dev: ReturnType<typeof recordingDevice>, id: string) => dev.mem.get(r._skinnedVBs.get(id))!;

    it('a weight change writes only the dirty range into the existing VB: no createBuffer, no index upload, bytes = a fresh full build', async () => {
        const { r, dev, Scene3DBlendShapes } = await setup();
        const mesh = await makeCharacterPart();
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh });
        const cStart = dev.creates();
        r._ensureSkinnedVBIB(mesh);
        expect(dev.creates() - cStart).toBe(2);   // VB + IB, once
        const vb = r._skinnedVBs.get(mesh.id), ib = r._skinnedIBs.get(mesh.id);

        for (let step = 0; step < 12; step++) {
            const before = dev.creates(), w0 = dev.writes.length;
            sub.setWeight(mesh.id, (step * 7) % NS, ((step * 3) % 10) / 9);
            expect(mesh.skinDirty).toBe(false);          // the blend path no longer forces a skin rebuild
            r._ensureSkinnedVBIB(mesh);
            expect(dev.creates()).toBe(before);          // ★ no buffer re-creation
            const ws = dev.writes.slice(w0);
            expect(ws.every((w) => w.buf === vb)).toBe(true);   // ★ the IB is never re-sent
            expect(ws.length).toBeLessThanOrEqual(1);
            if (ws.length && step > 0) expect(ws[0].n).toBeLessThan(NV * 72);   // a range, not the whole buffer (the first change is a full evaluation: no incremental state yet)
        }
        expect(r._skinnedVBs.get(mesh.id)).toBe(vb);
        expect(r._skinnedIBs.get(mesh.id)).toBe(ib);

        // the GPU bytes equal what a full (old-path) build of the current geometry produces
        const dev2 = recordingDevice();
        const { Renderer3D, Camera3D } = await mods();
        const r2 = new Renderer3D(dev2.device, new Camera3D()) as unknown as Record<string, any>;
        mesh.skinDirty = true;
        r2._ensureSkinnedVBIB(mesh);
        expect(Buffer.from(vbBytes(r, dev, mesh.id)).equals(Buffer.from(vbBytes(r2, dev2, mesh.id)))).toBe(true);
        // and the morphed CPU vertices are the reference evaluation
        const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
        expect(maxAbsDiff(mesh.geometry.vertices, ref)).toBeLessThan(1e-6);
    });

    it('several weight changes between frames are uploaded as one union range', async () => {
        const { r, dev, Scene3DBlendShapes } = await setup();
        const mesh = await makeCharacterPart();
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh });
        r._ensureSkinnedVBIB(mesh);
        sub.setWeight(mesh.id, 2, 0.3); sub.setWeight(mesh.id, 9, 0.8); sub.setWeight(mesh.id, 2, 0.6);
        const w0 = dev.writes.length;
        r._ensureSkinnedVBIB(mesh);
        expect(dev.writes.length - w0).toBe(1);
        const dev2 = recordingDevice();
        const { Renderer3D, Camera3D } = await mods();
        const r2 = new Renderer3D(dev2.device, new Camera3D()) as unknown as Record<string, any>;
        mesh.skinDirty = true; r2._ensureSkinnedVBIB(mesh);
        expect(Buffer.from(vbBytes(r, dev, mesh.id)).equals(Buffer.from(vbBytes(r2, dev2, mesh.id)))).toBe(true);
    });

    it('all weights 0: the VB is byte-identical to the same part WITHOUT blend shapes', async () => {
        const { r, dev, Renderer3D, Camera3D, Scene3DBlendShapes } = await setup();
        const withBS = await makeCharacterPart(true);
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => withBS });
        r._ensureSkinnedVBIB(withBS);
        sub.setWeight(withBS.id, 4, 1); r._ensureSkinnedVBIB(withBS);
        sub.setWeight(withBS.id, 4, 0); r._ensureSkinnedVBIB(withBS);   // back to rest
        const plain = await makeCharacterPart(false);
        const dev2 = recordingDevice();
        const r2 = new Renderer3D(dev2.device, new Camera3D()) as unknown as Record<string, any>;
        r2._ensureSkinnedVBIB(plain);
        expect(Buffer.from(vbBytes(r, dev, withBS.id)).equals(Buffer.from(vbBytes(r2, dev2, plain.id)))).toBe(true);
    });

    it('a skinDirty rebuild of the same size re-writes the existing buffers (no createBuffer)', async () => {
        const { r, dev } = await setup();
        const mesh = await makeCharacterPart();
        r._ensureSkinnedVBIB(mesh);
        const c0 = dev.creates();
        mesh.skinDirty = true;   // e.g. a hem-swing frame / weight paint
        r._ensureSkinnedVBIB(mesh);
        expect(dev.creates()).toBe(c0);
        expect(mesh.skinDirty).toBe(false);
    });

    it('old path stays selectable: blendFastPath / skinnedInPlaceUploads off → skinDirty + re-created buffers, same bytes', async () => {
        const { r, dev, Mesh3D, Renderer3D, Scene3DBlendShapes } = await setup();
        const mesh = await makeCharacterPart();
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh });
        r._ensureSkinnedVBIB(mesh);
        Mesh3D.blendFastPath = false; Renderer3D.skinnedInPlaceUploads = false;
        const c0 = dev.creates();
        sub.setWeight(mesh.id, 1, 0.9);
        expect(mesh.skinDirty).toBe(true);
        r._ensureSkinnedVBIB(mesh);
        expect(dev.creates()).toBe(c0 + 2);
        const ref = denseReference(mesh.baseVertices!, mesh.blendShapes, mesh.blendWeights);
        expect(maxAbsDiff(mesh.geometry.vertices, ref)).toBe(0);
    });
});

describe('Phase 1.5 fast blend shapes: static mesh + picker + export', () => {
    it('a static mesh is patched in its pool allocation (no gpuDirty → no pool rebuild), bytes = the CPU geometry', async () => {
        const { Mesh3D, Renderer3D, Camera3D, Scene3DBlendShapes } = await mods();
        const dev = recordingDevice();
        const r = new Renderer3D(dev.device, new Camera3D()) as unknown as Record<string, any>;
        const nv = 1200;
        const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: surfaceVerts(nv), indices: surfaceIndices(nv), format: '12float' } });
        r._ensureGeomPool([mesh]);
        expect(mesh.gpuDirty).toBe(false);
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext,
            { getMesh: () => mesh, patchVertices: (m, s, c) => r.patchMeshVertices(m, s, c) });
        sub.add(mesh.id, 'a', sparseShape(nv, 1, 100, 300));
        sub.add(mesh.id, 'b', sparseShape(nv, 2, 700, 300));
        const c0 = dev.creates();
        sub.setWeight(mesh.id, 0, 0.8);
        sub.setWeight(mesh.id, 1, 0.4);
        expect(mesh.gpuDirty).toBe(false);
        r._ensureGeomPool([mesh]);
        expect(dev.creates()).toBe(c0);
        const a = r._geomAllocs.get(mesh.id);
        const vb = dev.mem.get(r._geomVB)!;
        const stride = a.pk ? 32 : 48;
        expect(stride).toBe(48);
        const got = new Float32Array(vb.slice(a.baseVertex * 48, a.baseVertex * 48 + nv * 48).buffer);
        expect(Buffer.from(got.buffer).equals(Buffer.from(mesh.geometry.vertices.buffer))).toBe(true);
    });

    it('the picker re-derives its BVH after a morph (lazily, on the next pick)', async () => {
        const { Mesh3D, Scene3DBlendShapes } = await mods();
        const { MeshPicker } = await import('./mesh-picker');
        const { vec3 } = await import('gl-matrix');
        // one triangle at z = 0; a shape pushes it to z = 1
        const v = new Float32Array(3 * 12);
        const P = [[-1, -1, 0], [1, -1, 0], [0, 1, 0]];
        for (let i = 0; i < 3; i++) { v[i * 12] = P[i][0]; v[i * 12 + 1] = P[i][1]; v[i * 12 + 2] = P[i][2]; v[i * 12 + 5] = 1; v[i * 12 + 8] = 1; v[i * 12 + 11] = 1; }
        const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: v, indices: new Uint32Array([0, 1, 2]), format: '12float' } });
        mesh.gpuDirty = false;
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh, patchVertices: () => true });
        const d = new Float32Array(3 * 6); d[2] = 1; d[8] = 1; d[14] = 1;
        sub.add(mesh.id, 'push', d);
        const picker = new MeshPicker();
        const o = vec3.fromValues(0, 0, 5), dir = vec3.fromValues(0, 0, -1);
        expect(picker.raycastWorld(o, dir, [mesh], true)!.distance).toBeCloseTo(5);   // builds the BVH
        sub.setWeight(mesh.id, 0, 1);
        expect(mesh.gpuDirty).toBe(false);
        expect(picker.raycastWorld(o, dir, [mesh], true)!.distance).toBeCloseTo(4);   // the morphed surface, not the stale BVH
    });

    it('glTF export writes the BASE vertices with the targets + weights (no double-applied morph on re-import)', async () => {
        const { Mesh3D, Scene3DBlendShapes } = await mods();
        const { exportSceneToGlb } = await import('./gltf-exporter');
        const nv = 300;
        const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: surfaceVerts(nv), indices: surfaceIndices(nv), format: '12float' } });
        const sub = new Scene3DBlendShapes({ scheduleRender() { /* */ } } as unknown as ManagerContext, { getMesh: () => mesh });
        sub.add(mesh.id, 'a', sparseShape(nv, 3, 0, nv));
        sub.setWeight(mesh.id, 0, 0.75);
        const base = mesh.baseVertices!;
        expect(maxAbsDiff(mesh.geometry.vertices, base)).toBeGreaterThan(1e-4);   // precondition: really morphed
        const res = exportSceneToGlb([mesh], []);
        const glb = new Uint8Array(await res.blob.arrayBuffer());
        const dv = new DataView(glb.buffer);
        const jsonLen = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
        const binOff = 20 + jsonLen + 8;
        const prim = json.meshes[0].primitives[0];
        const read = (accIdx: number) => {
            const acc = json.accessors[accIdx], bv = json.bufferViews[acc.bufferView];
            return new Float32Array(glb.slice(binOff + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0), binOff + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + acc.count * 12).buffer);
        };
        const pos = read(prim.attributes.POSITION);
        for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) expect(pos[i * 3 + k]).toBe(base[i * 12 + k]);
        expect(prim.targets).toHaveLength(1);
        expect(json.meshes[0].weights[0]).toBeCloseTo(0.75);
    });
});
