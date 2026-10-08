/**
 * Perf audit C4 + C5 — the document save's cached JSON parts and GLB-referenced imported meshes.
 *
 * C4: the gather serializes inside JSON-part collections (scene-graph/core/json-parts.ts) — the vertex / index arrays
 *     and base64 skinning / blend-shape sections are reused while their bytes are unchanged. The OUTPUT must be byte-
 *     identical to the plain serialization, across any sequence of edits (in-place writes that bump no version
 *     included), and an edit to 1 mesh of 50 re-serializes only that mesh's parts.
 * C5: an imported mesh whose geometry is still the GLB's is saved as a reference (no inline geometry in scene3d.json or
 *     scene.json) and rebuilt from the GLB on load — same geometry / transform / material / group; an edited one stays
 *     inline; an old save with inline geometry loads as before.
 *
 * Runs the REAL DocumentStateCoordinator gather + restore over a real SceneGraph + Scene3DManager (GPU-free: no device,
 * so no textures); only the facade hooks are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DocumentStateCoordinator } from './document-state-coordinator';
import { buildDocumentMeshState, buildDocumentSceneJSON, type DocumentMeshStateOptions, type DocumentSceneJSONOptions } from './document-mesh-json';
import { Scene3DManager } from '../managers/scene3d-manager';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { generateBox, generateSphere } from '../../renderer/3d/mesh-generators';
import { recreateNode, type Shape2DRestoreDeps } from '../shape-serializer';
import { JsonPartCache, JsonPartCollector, contentHash, jsonNumberArray, round6Replacer, serializeWithParts } from '../../scene-graph/core/json-parts';
import type { DocumentSavePayload } from './document-persistence';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

/** Unlisted members are no-op functions. */
function stub<T extends object>(over: Record<string, unknown>): T {
    return new Proxy(over, {
        get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : (k === 'then' ? undefined : () => undefined)),
    }) as unknown as T;
}

/** A document: real scene graph + 3D manager, the real coordinator, stubbed facade hooks. */
function makeDoc() {
    const sg = new SceneGraph();
    const cam = new Camera3D();
    const r3 = stub({ getCamera: () => cam });
    const wr = stub({ getRenderer3D: () => r3, getCanvas: () => null, getDevice: () => null });
    let ver = 0;
    const isvc = stub({ maxGlobalZIndex: 0 });
    const ctx = stub({
        webgpuRenderer: wr, sceneGraph: sg, interactionService: isvc,
        sceneStructureVersion: () => ++ver,     // every read is "changed": no stale getAllMeshes between edits
        emitSceneGraphChanged: () => {}, scheduleRender: () => {},
    });
    const s3 = new Scene3DManager(ctx as never);
    const sceneCalls: DocumentSceneJSONOptions[] = [];
    // The renderer-backed global look (lights, fog …) needs a live Renderer3D: not this test's subject.
    const over: Record<string, unknown> = { getGlobalScene3DSettings: () => ({}), restoreGlobalScene3DSettings: () => {} };
    const s3facade = new Proxy(s3, {
        get: (t, k) => {
            if (typeof k === 'string' && k in over) return over[k];
            const v = (t as unknown as Record<string | symbol, unknown>)[k];
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
    });
    const sm = stub({
        scene3d: s3facade,
        sceneGraph: sg,
        ui: { listUILayers: () => [], restore: () => {} },
        interactionService: { onSceneGraphChanged: { emit: () => {} } },
        getSceneGraphJSONForDocument: (o?: DocumentSceneJSONOptions) => { sceneCalls.push(o ?? {}); return buildDocumentSceneJSON(sg, s3, o); },
        setSceneGraphJSON: async (json: string) => {
            const deps = { interactionService: isvc } as unknown as Shape2DRestoreDeps;
            for (const c of JSON.parse(json).root?.children ?? []) { const n = recreateNode(c, deps); if (n) sg.root.addChild(n); }
        },
        restoreProceduralFromSave3D: () => ({}),
    });
    const priv = stub({
        getSceneGraph: () => sg,
        getWebgpuRenderer: () => stub({ getDevice: () => null, getCanvasGridVisible: () => false, getCanvasGridColor: () => [0.5, 0.5, 0.5], getCanvasGridOpacity: () => 0.3, getCanvasGridCells: () => 8 }),
        getRasterLayerManager: () => undefined,
        uvPaintTextures: new Map(),
        pendingProcTextures: new Map(),
        ephemera: null,
        garp: { hasContent: () => false },
        buildMeshState: (m: Mesh3D, doc?: DocumentMeshStateOptions) => buildDocumentMeshState(s3, m, doc),
        getDocIdentity: () => ({ id: 'doc', name: 'Doc' }),
        getDocumentSizePx: () => null,
        getPixelFormat: () => 'png',
    });
    const coord = new DocumentStateCoordinator(sm as never, priv as never);
    coord.pixelVerifyIntervalMs = 0;
    return { sg, s3, coord, isvc, sceneCalls };
}

/** Gather, with the save-time fields that legitimately differ between two gathers (timestamps) blanked. */
async function gather(coord: DocumentStateCoordinator, opts: { reusePixels?: boolean; force?: boolean } = {}): Promise<DocumentSavePayload> {
    return coord.gather(!!opts.force, { reusePixels: opts.reusePixels ?? true });
}

// ── A tiny GLB (two meshes in two nodes, or one skinned mesh) ──────────────────────────────────────────────────────

const F32 = 5126, U16 = 5123, U8 = 5121;

class GlbBuilder {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any = { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
    private bin: number[] = [];
    data(arr: ArrayBufferView, componentType: number, type: string, count: number, extra: Record<string, unknown> = {}): number {
        while (this.bin.length % 4) this.bin.push(0);
        const byteOffset = this.bin.length;
        for (const b of new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)) this.bin.push(b);
        this.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: arr.byteLength });
        this.json.accessors.push({ bufferView: this.json.bufferViews.length - 1, componentType, type, count, ...extra });
        return this.json.accessors.length - 1;
    }
    build(): ArrayBuffer {
        while (this.bin.length % 4) this.bin.push(0);
        this.json.buffers[0].byteLength = this.bin.length;
        let jsonBytes = new TextEncoder().encode(JSON.stringify(this.json));
        const pad = (4 - (jsonBytes.length % 4)) % 4;
        if (pad) { const p = new Uint8Array(jsonBytes.length + pad).fill(0x20); p.set(jsonBytes); jsonBytes = p; }
        const total = 12 + 8 + jsonBytes.length + 8 + this.bin.length;
        const out = new ArrayBuffer(total);
        const dv = new DataView(out), u8 = new Uint8Array(out);
        dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
        dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4E4F534A, true);
        u8.set(jsonBytes, 20);
        const binOff = 20 + jsonBytes.length;
        dv.setUint32(binOff, this.bin.length, true); dv.setUint32(binOff + 4, 0x004E4942, true);
        u8.set(this.bin, binOff + 8);
        return out;
    }
}

/** A grid of (n+1)² vertices — enough floats that the inline JSON is clearly measurable. */
function gridPrim(b: GlbBuilder, n: number, z: number): Record<string, unknown> {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        pos.push(i / n + Math.sin(j) * 0.01234567, j / n, z + Math.cos(i) * 0.0123); nrm.push(0, 0, 1); uv.push(i / n, j / n);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
    const cnt = (n + 1) * (n + 1);
    return {
        attributes: {
            POSITION: b.data(new Float32Array(pos), F32, 'VEC3', cnt, { min: [0, 0, z - 0.02], max: [1.02, 1, z + 0.02] }),
            NORMAL: b.data(new Float32Array(nrm), F32, 'VEC3', cnt),
            TEXCOORD_0: b.data(new Float32Array(uv), F32, 'VEC2', cnt),
        },
        indices: b.data(new Uint16Array(idx), U16, 'SCALAR', idx.length),
    };
}

function twoMeshGlb(n = 8): ArrayBuffer {
    const b = new GlbBuilder();
    b.json.meshes = [{ name: 'Front', primitives: [gridPrim(b, n, 0)] }, { name: 'Back', primitives: [gridPrim(b, n, -1)] }];
    b.json.nodes = [{ name: 'Front', mesh: 0, translation: [0, 0, 0] }, { name: 'Back', mesh: 1, translation: [0.5, 0, 0], rotation: [0, 0.3826834, 0, 0.9238795] }];
    b.json.scenes = [{ nodes: [0, 1] }];
    b.json.scene = 0;
    return b.build();
}

function oneMeshGlb(n = 8): ArrayBuffer {
    const b = new GlbBuilder();
    b.json.meshes = [{ name: 'Solo', primitives: [gridPrim(b, n, 0)] }];
    b.json.nodes = [{ name: 'Solo', mesh: 0 }];
    b.json.scenes = [{ nodes: [0] }];
    b.json.scene = 0;
    return b.build();
}

function skinnedGlb(n = 6): ArrayBuffer {
    const b = new GlbBuilder();
    const prim = gridPrim(b, n, 0) as { attributes: Record<string, number> };
    const cnt = (n + 1) * (n + 1);
    const ji = new Uint8Array(cnt * 4), jw = new Float32Array(cnt * 4);
    for (let v = 0; v < cnt; v++) { ji[v * 4] = 0; ji[v * 4 + 1] = 1; jw[v * 4] = 0.75; jw[v * 4 + 1] = 0.25; }
    prim.attributes.JOINTS_0 = b.data(ji, U8, 'VEC4', cnt);
    prim.attributes.WEIGHTS_0 = b.data(jw, F32, 'VEC4', cnt);
    const ibm = new Float32Array(32);
    for (let k = 0; k < 2; k++) { ibm[k * 16] = 1; ibm[k * 16 + 5] = 1; ibm[k * 16 + 10] = 1; ibm[k * 16 + 15] = 1; ibm[k * 16 + 13] = -k; }
    const ibmAcc = b.data(ibm, F32, 'MAT4', 2);
    b.json.meshes = [{ name: 'Skin', primitives: [prim] }];
    b.json.nodes = [{ name: 'Skin', mesh: 0, skin: 0 }, { name: 'J0', children: [2] }, { name: 'J1', translation: [0, 1, 0] }];
    b.json.skins = [{ name: 'S', joints: [1, 2], inverseBindMatrices: ibmAcc }];
    b.json.scenes = [{ nodes: [0, 1] }];
    b.json.scene = 0;
    return b.build();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodesOf = (p: DocumentSavePayload): any[] => JSON.parse(p.scene3dJSON!).nodes;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sceneNode(p: DocumentSavePayload, id: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let found: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (n: any): void => { if (n?.id === id) found = n; for (const c of n?.children ?? []) walk(c); };
    walk(JSON.parse(p.sceneGraphJSON!).root);
    return found;
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── C4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('json-parts', () => {
    it('resolves placeholders to exactly the nested JSON (both modes), lazily', () => {
        const cache = new JsonPartCache();
        const a = new Float32Array([0.1, -2.123456789, 1e-9, 3, NaN, 1e12]);
        const b = new Uint32Array([1, 2, 3]);
        for (const mode of ['r6', 'raw'] as const) {
            const rep = mode === 'r6' ? round6Replacer : undefined;
            const plain = JSON.stringify({ x: { v: Array.from(a), i: Array.from(b) }, k: [Array.from(a)] }, rep);
            const c = new JsonPartCollector(cache, mode);
            const text = serializeWithParts(c, () => ({ x: { v: jsonNumberArray(a), i: jsonNumberArray(b) }, k: [jsonNumberArray(a)], dropped: jsonNumberArray(b) }),
                (o) => { delete (o as { dropped?: unknown }).dropped; return JSON.stringify(o, rep); });
            expect(text).toBe(plain);
        }
        // outside a collection: the plain arrays
        expect(jsonNumberArray(b)).toEqual([1, 2, 3]);
    });

    it('reuses a part while its bytes are unchanged and rebuilds it after an in-place write', () => {
        const cache = new JsonPartCache();
        const a = new Float32Array([1, 2, 3]);
        const run = () => serializeWithParts(new JsonPartCollector(cache, 'r6'), () => ({ a: jsonNumberArray(a) }), (o) => JSON.stringify(o, round6Replacer));
        expect(run()).toBe('{"a":[1,2,3]}');
        expect(cache.stats).toEqual({ built: 1, reused: 0 });
        expect(run()).toBe('{"a":[1,2,3]}');
        expect(cache.stats).toEqual({ built: 1, reused: 1 });
        a[1] = 5;   // no version anywhere
        expect(run()).toBe('{"a":[1,5,3]}');
        expect(cache.stats).toEqual({ built: 2, reused: 1 });
    });

    it('the content hash notices any single changed word, and paired sign flips in one lane', () => {
        const a = new Float32Array(4096).map((_, i) => Math.sin(i));
        const h0 = contentHash(a);
        for (const k of [0, 1, 2, 3, 2047, 4095]) { const was = a[k]; a[k] = Math.fround(was + 1e-6); expect(contentHash(a)).not.toBe(h0); a[k] = was; }
        expect(contentHash(a)).toBe(h0);
        a[0] = -a[0]; a[4] = -a[4];   // the same lane: a plain multiplicative hash would cancel these
        expect(contentHash(a)).not.toBe(h0);
        expect(contentHash(new Uint8Array([1, 2, 3, 4, 5]))).not.toBe(contentHash(new Uint8Array([1, 2, 3, 4, 6])));
    });

    it('a placeholder inside a nested string falls back to the plain serialization', () => {
        const cache = new JsonPartCache();
        const a = new Float32Array([1, 2]);
        const text = serializeWithParts(new JsonPartCollector(cache, 'raw'), () => ({ s: JSON.stringify({ a: jsonNumberArray(a) }) }), (o) => JSON.stringify(o));
        expect(text).toBe(JSON.stringify({ s: JSON.stringify({ a: [1, 2] }) }));
    });
});

describe('C4 — document gather with cached JSON parts', () => {
    /** Meshes of every kind that writes heavy parts: custom geometry, blend shapes, skinned, edit-mesh, primitive. */
    function populate(s3: Scene3DManager, sg: SceneGraph, n: number): Mesh3D[] {
        const meshes: Mesh3D[] = [];
        for (let i = 0; i < n; i++) {
            const m = s3.createCustomMesh(i, 0, -i, i % 2 ? generateSphere(0.5 + i * 0.01, 6, 4) : generateBox(1, 1 + i * 0.1, 1));
            m.name = `m${i}`;
            meshes.push(m);
        }
        const bs = s3.createCustomMesh(0, 3, 0, generateBox(2, 2, 2));
        bs.name = 'blend';
        s3.addBlendShape3D(bs.id, 'puff', new Float32Array(bs.geometry.vertices.length / 12 * 6).fill(0.01));
        s3.setBlendWeight3D(bs.id, 0, 0.5);
        meshes.push(bs);
        const sk = new SkinnedMesh3D(stub({ maxGlobalZIndex: 0 }), 0, 0, 5, { primitive: 'custom', geometry: generateBox(1, 2, 1) });
        const nv = sk.geometry.vertices.length / 12;
        sk.jointIndices = new Uint8Array(nv * 4).map((_, k) => k % 3);
        sk.jointWeights = new Float32Array(nv * 4).map((_, k) => (k % 4 === 0 ? 1 : 0));
        sk.name = 'skinned';
        sg.root.addChild(sk);
        meshes.push(sk);
        meshes.push(s3.createPolygonMesh(0, 0, 9, [[0, 0], [1, 0], [1, 1], [0, 1]], 1, 'poly'));   // Edit Mesh topology
        const grp = new MeshGroup3D(stub({ maxGlobalZIndex: 0 }));
        grp.name = 'G';
        sg.root.addChild(grp);
        const inGroup = s3.createCustomMesh(0, 0, 0, generateBox(0.3, 0.3, 0.3));
        inGroup.parent?.removeChild(inGroup);
        grp.addChild(inGroup);
        meshes.push(inGroup);
        return meshes;
    }

    /** Random edits: replace geometry, write vertices IN PLACE (no version bump), material, transform, blend weight,
     *  skin weights in place, add / remove meshes. */
    function edit(rng: () => number, s3: Scene3DManager, sg: SceneGraph, meshes: Mesh3D[]): void {
        const m = meshes[Math.floor(rng() * meshes.length)];
        switch (Math.floor(rng() * 8)) {
            case 0: m.setGeometry(generateBox(1 + rng(), 1, 1)); break;
            case 1: { const v = m.geometry.vertices; v[Math.floor(rng() * v.length)] += 0.25; break; }   // in place, unversioned
            case 2: m.setMaterial({ roughness: rng() }); break;
            case 3: m.setPosition3D(rng() * 10, rng(), rng()); m.rotationY = rng(); break;
            case 4: { const bs = meshes.find((x) => x.name === 'blend'); if (bs) s3.setBlendWeight3D(bs.id, 0, rng()); break; }
            case 5: { const sk = meshes.find((x) => x instanceof SkinnedMesh3D) as SkinnedMesh3D | undefined; if (sk) sk.jointWeights[Math.floor(rng() * sk.jointWeights.length)] = rng(); break; }
            case 6: { const nm = s3.createCustomMesh(rng(), 0, 0, generateBox(rng() + 0.5, 1, 1)); meshes.push(nm); break; }
            case 7: { if (meshes.length > 5 && m.name.startsWith('m')) { m.parent?.removeChild(m); meshes.splice(meshes.indexOf(m), 1); } break; }
        }
        void sg;
    }

    it('byte-identical to the plain serialization across a random sequence of edits (property test)', async () => {
        for (const seed of [1, 7, 42]) {
            const { s3, sg, coord } = makeDoc();
            const meshes = populate(s3, sg, 12);
            meshes.push(...await s3.importGltfBuffer(0, 0, 0, twoMeshGlb(4)));   // GLB references (C5) flip with the edits
            let st = seed;
            const rng = () => { st = (Math.imul(st, 1103515245) + 12345) >>> 0; return st / 4294967296; };
            for (let step = 0; step < 25; step++) {
                if (step > 0) for (let k = 1 + Math.floor(rng() * 3); k > 0; k--) edit(rng, s3, sg, meshes);
                coord.jsonPartCacheEnabled = true;
                const cached = await gather(coord, { reusePixels: true });
                coord.jsonPartCacheEnabled = false;
                const plain = await gather(coord, { reusePixels: true });
                expect(cached.scene3dJSON).toBe(plain.scene3dJSON);
                expect(cached.sceneGraphJSON).toBe(plain.sceneGraphJSON);
            }
            expect(coord.jsonPartStats.reused).toBeGreaterThan(0);
        }
    });

    it('1 changed mesh of 50 → only that mesh\'s parts are serialized again', async () => {
        const { s3, sg, coord } = makeDoc();
        const meshes: Mesh3D[] = [];
        for (let i = 0; i < 50; i++) meshes.push(s3.createCustomMesh(i, 0, 0, generateSphere(0.5, 12, 8)));
        void sg;
        const first = await gather(coord);
        const s0 = { ...coord.jsonPartStats };
        // first gather: 50 meshes × (vertices + indices) in scene3d.json (r6) and scene.json (raw)
        expect(s0).toEqual({ built: 200, reused: 0 });
        const idle = await gather(coord);
        expect(idle.scene3dJSON).toBe(first.scene3dJSON);
        expect(coord.jsonPartStats).toEqual({ built: 200, reused: 200 });   // nothing changed: nothing serialized
        meshes[17].geometry.vertices[3] += 1;                                // ONE mesh, in place
        await gather(coord);
        expect(coord.jsonPartStats).toEqual({ built: 202, reused: 398 });   // its vertex array, in both files
        meshes[3].setGeometry(generateBox(2, 2, 2));                         // ONE mesh, replaced
        await gather(coord);
        expect(coord.jsonPartStats).toEqual({ built: 206, reused: 594 });   // its vertices + indices, in both files
        // an explicit save (no reuse) serializes everything fresh — and refreshes the cache
        await coord.gather(false, { reusePixels: false });
        expect(coord.jsonPartStats.built).toBe(406);
    });
});

// ── C5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Save a document, then load it into a FRESH document through the real restore. */
async function saveAndLoad(src: ReturnType<typeof makeDoc>, force = true) {
    const payload = await src.coord.gather(force, { reusePixels: false });
    const dst = makeDoc();
    const report = await dst.coord.restore(payload);
    return { payload, dst, report };
}

describe('C5 — imported (GLB) meshes saved once', () => {
    it('an unchanged multi-mesh GLB import saves references only, and loads back identical (geometry / transform / material / group)', async () => {
        const doc = makeDoc();
        const glb = twoMeshGlb(24);
        const meshes = await doc.s3.importGltfBuffer(1, 2, 3, glb);
        expect(meshes).toHaveLength(2);
        meshes[1].setMaterial({ roughness: 0.25, metalness: 0.5 });
        meshes[0].setPosition3D(4, 5, 6);
        const group = meshes[0].parent as MeshGroup3D;
        expect(group).toBeInstanceOf(MeshGroup3D);

        const { payload, dst, report } = await saveAndLoad(doc);
        expect(report.issues).toEqual([]);
        // no inline geometry anywhere — references
        for (const n of nodesOf(payload)) {
            expect(n.config.geometry).toBeUndefined();
            expect(n.geometryRef).toBe('glb');
            expect(typeof n.glbMeshIndex).toBe('number');
        }
        for (const m of meshes) {
            const sn = sceneNode(payload, m.id);
            expect(sn.config.geometry).toBeUndefined();
            expect(sn.geometryRef).toBe('glb');
        }
        expect(Object.keys(payload.models3d ?? {}).sort()).toEqual(meshes.map((m) => m.id).sort());

        // loaded: same geometry bits, transform, material, group membership
        for (const m of meshes) {
            const r = dst.s3.getMesh(m.id)!;
            expect(r).toBeTruthy();
            expect(Array.from(r.geometry.vertices)).toEqual(Array.from(m.geometry.vertices));
            expect(Array.from(r.geometry.indices)).toEqual(Array.from(m.geometry.indices));
            const tr = (x: Mesh3D) => [x.x, x.y, x.z, x.rotationX, x.rotationY, x.rotation, x.scaleX, x.scaleY, x.scaleZ];
            tr(r).forEach((v, k) => expect(v).toBeCloseTo(tr(m)[k], 5));   // (scene3d.json rounds to 6 decimals, as always)
            expect(r.material.roughness).toBeCloseTo(m.material.roughness, 6);
            expect(r.material.metalness).toBeCloseTo(m.material.metalness, 6);
            expect(r.glbMeshIndex).toBe(m.glbMeshIndex);
            expect((r.parent as MeshGroup3D).id).toBe(group.id);
            expect(r.importedGeometryUnchanged).toBe(true);    // the next save writes the reference again
        }
        // save → load → save: the second save is the same document (still references)
        const again = await dst.coord.gather(true, { reusePixels: false });
        expect(nodesOf(again).every((n) => n.geometryRef === 'glb')).toBe(true);
    });

    it('size: the sample GLB no longer rides inline in scene3d.json + scene.json', async () => {
        const measure = async (refs: boolean) => {
            const doc = makeDoc();
            const meshes = await doc.s3.importGltfBuffer(0, 0, 0, oneMeshGlb(40));
            if (!refs) (meshes[0] as unknown as { _importGeomHash: null })._importGeomHash = null;   // = today's (pre-C5) save
            const p = await doc.coord.gather(true, { reusePixels: false });
            const gz = (t: string) => gzipSync(t).byteLength;   // the writer gzips both files
            return { s3d: p.scene3dJSON!.length, scene: p.sceneGraphJSON!.length, gz: gz(p.scene3dJSON!) + gz(p.sceneGraphJSON!), glb: (Object.values(p.models3d ?? {})[0] as ArrayBuffer).byteLength };
        };
        const before = await measure(false), after = await measure(true);
        // 41×41 vertices: the GLB is ~60 KB; inline it was ~2× that again as decimal text, per file
        expect(after.s3d).toBeLessThan(before.s3d / 20);
        expect(after.scene).toBeLessThan(before.scene / 20);
        if (process.env.C5_SIZES) process.stdout.write(`[C5 sample] GLB ${before.glb} B; scene3d.json ${before.s3d} → ${after.s3d} B; scene.json ${before.scene} → ${after.scene} B; both gzipped ${before.gz} → ${after.gz} B
`);
    });

    it('an EDITED imported mesh keeps its inline geometry (replaced, written in place, or Edit Mesh)', async () => {
        const doc = makeDoc();
        const [a, b] = await doc.s3.importGltfBuffer(0, 0, 0, twoMeshGlb(4));
        a.geometry.vertices[0] += 0.5;                     // in place, no version bump
        const p1 = await doc.coord.gather(true, { reusePixels: false });
        const na = nodesOf(p1).find((n) => n.id === a.id), nb = nodesOf(p1).find((n) => n.id === b.id);
        expect(na.geometryRef).toBeUndefined();
        expect(na.config.geometry.vertices.length).toBe(a.geometry.vertices.length);
        expect(sceneNode(p1, a.id).config.geometry.vertices.length).toBe(a.geometry.vertices.length);
        expect(nb.geometryRef).toBe('glb');
        a.geometry.vertices[0] -= 0.5;                     // put back exactly: the GLB's again
        expect(a.importedGeometryUnchanged).toBe(true);
        b.editMesh = EditMesh.fromGeometry(b.geometry);   // entered Edit Mesh (topology is saved with it)
        expect(b.importedGeometryUnchanged).toBe(false);
        b.editMesh = null;
        expect(b.importedGeometryUnchanged).toBe(true);
        b.setGeometry(generateBox(1, 1, 1));               // replaced
        expect(b.importedGeometryUnchanged).toBe(false);

        // the edited mesh round-trips with its edit (the old inline + GLB path)
        a.geometry.vertices[1] += 0.25;
        const { dst, report } = await saveAndLoad(doc);
        expect(report.issues).toEqual([]);
        const ra = dst.s3.getMesh(a.id)!;
        expect(ra.geometry.vertices[1]).toBeCloseTo(a.geometry.vertices[1], 5);
        expect(ra.importedGeometryUnchanged).toBe(false);
    });

    it('an OLD save (inline geometry + GLB, no geometryRef) loads as before', async () => {
        const doc = makeDoc();
        const meshes = await doc.s3.importGltfBuffer(0, 0, 0, twoMeshGlb(4));
        const payload = await doc.coord.gather(true, { reusePixels: false });
        // rewrite the save into the old format: inline geometry (as old builds wrote it) everywhere
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s3d = JSON.parse(payload.scene3dJSON!), scene = JSON.parse(payload.sceneGraphJSON!);
        for (const n of s3d.nodes) {
            const m = meshes.find((x) => x.id === n.id)!;
            delete n.geometryRef;
            n.config.geometry = { vertices: Array.from(m.geometry.vertices), indices: Array.from(m.geometry.indices) };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walk = (x: any): void => {
            const m = meshes.find((mm) => mm.id === x?.id);
            if (m) { delete x.geometryRef; x.config.geometry = { vertices: Array.from(m.geometry.vertices), indices: Array.from(m.geometry.indices) }; }
            for (const c of x?.children ?? []) walk(c);
        };
        walk(scene.root);
        const old = { ...payload, scene3dJSON: JSON.stringify(s3d, round6Replacer), sceneGraphJSON: JSON.stringify(scene) };
        const dst = makeDoc();
        const report = await dst.coord.restore(old);
        expect(report.issues).toEqual([]);
        for (const m of meshes) {
            const r = dst.s3.getMesh(m.id)!;
            const v = r.geometry.vertices;
            for (let k = 0; k < v.length; k++) expect(v[k]).toBeCloseTo(m.geometry.vertices[k], 5);
            expect((r.parent as MeshGroup3D).id).toBe((m.parent as MeshGroup3D).id);
        }
    });

    it('a reference whose GLB is missing fails the load LOUDLY (recorded, blocks saving) instead of dropping the mesh', async () => {
        const doc = makeDoc();
        await doc.s3.importGltfBuffer(0, 0, 0, oneMeshGlb(4));
        const payload = await doc.coord.gather(true, { reusePixels: false });
        const dst = makeDoc();
        const report = await dst.coord.restore({ ...payload, models3d: {} });
        expect(report.issues.length).toBeGreaterThan(0);
        expect(report.issues[0].blocksSave).toBe(true);
    });

    it('a skinned GLB import saves its geometry as a reference too (the skinned reload always rebuilt it from the GLB)', async () => {
        const doc = makeDoc();
        const { meshes, skeletons } = await doc.s3.importSkinnedGltfBuffer(0, 0, 0, skinnedGlb());
        expect(meshes).toHaveLength(1);
        expect(skeletons).toHaveLength(1);
        const sk = meshes[0] as SkinnedMesh3D;
        const { payload, dst, report } = await saveAndLoad(doc);
        expect(report.issues).toEqual([]);
        const n = nodesOf(payload).find((x) => x.id === sk.id);
        expect(n.type).toBe('SkinnedMesh3D');
        expect(n.config.geometry).toBeUndefined();
        expect(n.geometryRef).toBe('glb');
        expect(typeof n.jointWeightsB64).toBe('string');   // the skinning stays (it can be re-bound)
        const r = dst.s3.getMesh(sk.id) as SkinnedMesh3D;
        expect(r).toBeInstanceOf(SkinnedMesh3D);
        expect(Array.from(r.geometry.vertices)).toEqual(Array.from(sk.geometry.vertices));
        expect(Array.from(r.jointWeights)).toEqual(Array.from(sk.jointWeights));
        expect(r.skeletonId).toBe(sk.skeletonId);
        expect(r.importedGeometryUnchanged).toBe(true);
    });
});
