/**
 * 'character' worker lane (performance-plan P3.2d): the worker handlers produce BYTE-IDENTICAL geometry to the
 * main-thread generators, and a character built from worker-PRIMED parts (createProceduralCharacter3D) is identical
 * to one dressed by the plain synchronous setters.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CHARACTER_JOB, CHARACTER_JOB_HANDLERS } from './character-jobs';
import { registerCharacterLane } from './character-lane';
import { WorkerJobService } from './worker-job-service';
import type { JobApi } from './worker-job-runtime';
import { generateBodyResult, NEW_BODY_SEAM_BLEND } from '../managers/body-generator';
import { generateCharacterParts, type CharacterParts, type CharacterPartsSpec } from '../managers/character-parts';
import { randomCharacterParams } from '../managers/character-randomizer';
import { Scene3DManager } from '../managers/scene3d-manager';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { Node } from '../../scene-graph/shapes/base/node';
import type { ClothingParams } from '../managers/clothing-generator';

const g = globalThis as Record<string, unknown> & { self?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
/** Universal no-op stand-in (fake GPUDevice / canvas) so the GPU-touching overlay paths run in node. */
const U: any = new Proxy(function () { /* no-op */ }, {
    get: (_t, k) => (k === 'then' || k === Symbol.iterator ? undefined : k === Symbol.toPrimitive ? () => 0 : U),
    apply: () => U, construct: () => U,
});
for (const k of ['GPUTextureUsage', 'GPUBufferUsage', 'OffscreenCanvas', 'document', 'createImageBitmap', 'ImageData']) g[k] ??= U;

function makeManager(): Scene3DManager {
    const perm = <T extends object>(t: T): T => new Proxy(t, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) });
    const cam = new Camera3D();
    const r3 = perm({ getCamera: () => cam });
    const wr = perm({ getRenderer3D: () => r3, getCanvas: () => null, getDevice: () => U });
    const root = new Node();
    let ver = 0;
    const findNodeById = (id: string) => { let f: unknown = null; root.forEachDeep((n: Node & { id?: string }) => { if (n.id === id) f = n; }); return f; };
    const ctx = perm({ webgpuRenderer: wr, sceneGraph: { root, findNodeById }, sceneStructureVersion: () => ver, emitSceneGraphChanged: () => { ver++; }, scheduleRender: () => {} });
    return new Scene3DManager(ctx as never);
}

/** A worker-side JobApi that records transfers (then the result is structured-cloned like postMessage). */
function workerApi(): JobApi & { transferred: Transferable[] } {
    const transferred: Transferable[] = [];
    return { shared: {}, fallback: false, progress: () => {}, transfer: (...b) => { transferred.push(...b); }, transferred };
}

/** Every typed array in a value, flattened to [path, bytes] — the byte-for-byte fingerprint. */
function typedArrays(v: unknown, path = '$', out: [string, string][] = []): [string, string][] {
    if (ArrayBuffer.isView(v)) { out.push([path, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')]); return out; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) typedArrays((v as Record<string, unknown>)[k], `${path}.${k}`, out);
    return out;
}
const fp = (v: unknown) => ({ arrays: typedArrays(v), json: JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? `<${x.constructor.name}:${(x as Uint8Array).length}>` : x)) });

const SEEDS = [7, 1234, 99001];
function specFor(seed: number): CharacterPartsSpec & { p: ReturnType<typeof randomCharacterParams>; garments: ClothingParams[] } {
    const p = randomCharacterParams(seed);
    const garments = [p.top, p.socks, p.shoes, p.bottom];
    return { p, body: { seamBlend: NEW_BODY_SEAM_BLEND, ...p.body }, garments, hair: p.hair };
}

describe('character lane handlers == direct generators (byte-for-byte)', () => {
    it.each(SEEDS)('body (seed %i): worker transfer path + service fallback == generateBodyResult', async (seed) => {
        const { body } = specFor(seed);
        const direct = fp(generateBodyResult(structuredClone(body)));
        const api = workerApi();
        const res = await CHARACTER_JOB_HANDLERS[CHARACTER_JOB.body](structuredClone(body), api);
        expect(api.transferred.length).toBeGreaterThan(4);                       // geometry + skin + skeleton buffers
        expect(new Set(api.transferred).size).toBe(api.transferred.length);      // each buffer once (DataCloneError otherwise)
        expect(fp(structuredClone(res, { transfer: api.transferred as Transferable[] }))).toEqual(direct);
        const svc = registerCharacterLane(new WorkerJobService());
        expect(fp(await svc.run(CHARACTER_JOB.body, body).promise)).toEqual(direct);
        expect(svc.stats().fallbackRuns).toBe(1);
    });

    it.each(SEEDS)('parts (seed %i): body + garments + hair == direct', async (seed) => {
        const { p: _p, ...spec } = specFor(seed);
        const direct = fp(generateCharacterParts(structuredClone(spec)));
        const api = workerApi();
        const res = await CHARACTER_JOB_HANDLERS[CHARACTER_JOB.parts](structuredClone(spec), api) as CharacterParts;
        expect(res.garments.map((x) => x.params.slot)).toEqual(['top', 'socks', 'shoes', 'bottom']);
        expect(res.hair).not.toBeNull();
        expect(fp(structuredClone(res, { transfer: api.transferred as Transferable[] }))).toEqual(direct);
        const svc = registerCharacterLane(new WorkerJobService());
        expect(fp(await svc.run(CHARACTER_JOB.parts, spec).promise)).toEqual(direct);
    }, 30000);
});

/** Geometry + skin of every overlay mesh of a character, keyed by name (ids differ between managers). */
function characterMeshes(m: Scene3DManager, bodyId: string) {
    const out: Record<string, unknown> = {};
    const body = m.getMesh(bodyId)!;
    for (const id of [bodyId, m.getHairMeshId(bodyId), ...(['top', 'bottom', 'shoes', 'socks'] as const).map((s) => m.getClothingMeshId(bodyId, s))]) {
        const mesh = m.getMesh(id!) as unknown as { name: string; geometry: { vertices: Float32Array; indices?: Uint32Array }; jointIndices: Uint8Array; jointWeights: Float32Array };
        expect(mesh).toBeTruthy();
        out[mesh === (body as unknown) ? 'body' : mesh.name] = fp({ v: mesh.geometry.vertices, i: mesh.geometry.indices, ji: mesh.jointIndices, jw: mesh.jointWeights });
    }
    return out;
}

describe('createProceduralCharacter3D (primed worker parts) == the synchronous setters', () => {
    it.each(SEEDS)('seed %i: identical body / garments / hair, and every primed part was consumed', async (seed) => {
        const { p, garments } = specFor(seed);
        // Reference: plain body + sync setters (garments, then hair) — nothing primed.
        const a = makeManager();
        const ra = await a.createProceduralBody3D(p.body, 0, 0, 0);
        const ca = (a as unknown as { _character: { setClothingParams(id: string, c: ClothingParams): void; setHairParams(id: string, h: unknown): void } })._character;
        for (const c of garments) ca.setClothingParams(ra.meshId, c);
        ca.setHairParams(ra.meshId, p.hair);
        // Primed: one worker job (fallback here), the setters wrap the precomputed results.
        const b = makeManager();
        const rb = await b.createProceduralCharacter3D({ body: p.body, garments, hair: p.hair }, 0, 0, 0);
        const cb = (b as unknown as { _character: typeof ca & { _primed: Map<string, { garments: Map<string, unknown>; hair: unknown }> } })._character;
        const primed = cb._primed.get(rb.meshId)!;
        expect(primed.garments.size).toBe(4);
        expect(primed.hair).toBeTruthy();
        for (const c of garments) cb.setClothingParams(rb.meshId, c);
        cb.setHairParams(rb.meshId, p.hair);
        expect(primed.garments.size).toBe(0);   // all consumed (sig matched)
        expect(primed.hair).toBeNull();
        b.clearPrimedCharacterParts3D(rb.meshId);
        expect(cb._primed.size).toBe(0);
        expect(characterMeshes(b, rb.meshId)).toEqual(characterMeshes(a, ra.meshId));
    }, 30000);

    it('a mismatched input (different hair params) ignores the primed part and generates synchronously', async () => {
        const { p, garments } = specFor(7);
        const b = makeManager();
        const rb = await b.createProceduralCharacter3D({ body: p.body, garments, hair: p.hair }, 0, 0, 0);
        const cb = (b as unknown as { _character: { setClothingParams(id: string, c: ClothingParams): void; setHairParams(id: string, h: unknown): void } })._character;
        for (const c of garments) cb.setClothingParams(rb.meshId, c);
        const other = { ...p.hair, lengthBack: p.hair.lengthBack + 0.1 };
        cb.setHairParams(rb.meshId, other);
        b.clearPrimedCharacterParts3D(rb.meshId);
        const a = makeManager();
        const ra = await a.createProceduralBody3D(p.body, 0, 0, 0);
        const ca = (a as unknown as { _character: typeof cb })._character;
        for (const c of garments) ca.setClothingParams(ra.meshId, c);
        ca.setHairParams(ra.meshId, other);
        expect(characterMeshes(b, rb.meshId)).toEqual(characterMeshes(a, ra.meshId));
    }, 30000);
});
