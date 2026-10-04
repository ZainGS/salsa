import { describe, it, expect } from 'vitest';
import { generateCityLayout } from '../../world';
import type { LayoutParams, WorldGraph } from '../../world';
import { buildSelectedGroups, buildCentreGroups } from '../../world/centre-build';
import { buildTileLayerGroups, type TileLayerGroup } from '../../world/tile-build';
import { WorldManager } from '../managers/world-manager';
import { isContactDone } from '../../world/contact-shadows';
import { WorkerJobService } from './worker-job-service';
import { WORLD_JOB, WORLD_JOB_HANDLERS, applyGraphPatch, type SelectiveResult } from './world-jobs';
import { registerWorldLane } from './world-lane';
import type { JobApi } from './worker-job-runtime';

// performance-plan P3.2 DETERMINISM: a selective / tile / centre regen run as a WORKER job (structured-clone in,
// transfer-copies out) or on the service's main-thread FALLBACK must be byte-identical to the direct main-thread
// build. And the selective builders must only READ the graph (the worker builds on a clone that is never adopted).

const P: Partial<LayoutParams> = { seed: 5, radius: 6 };

/** Every layer's name + bytes, in order — the full output fingerprint. */
function fingerprint(groups: TileLayerGroup[]): string[] {
    const out: string[] = [];
    for (const g of groups) for (const L of g.layers) {
        const v = L.geometry.vertices, ix = L.geometry.indices;
        let h = 2166136261;
        const u = new Uint32Array(v.buffer, v.byteOffset, v.length);
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
        if (ix) for (let i = 0; i < ix.length; i++) h = Math.imul(h ^ ix[i], 16777619);
        const inst = (L as { instances?: unknown[] }).instances;
        out.push(`${g.name}/${L.name}/${v.length}/${ix?.length ?? 0}/${h >>> 0}/${inst ? JSON.stringify(inst) : ''}`);
    }
    return out;
}

const workerApi = (): JobApi & { list: Transferable[] } => {
    const list: Transferable[] = [];
    return { shared: {}, fallback: false, progress: () => {}, transfer: (...b) => { list.push(...b); }, list };
};

// The selective tiers (WorldManager.PARAM_TIER) — group + a param change that re-runs it.
const SELECTIVE: Array<[string, Partial<LayoutParams>]> = [
    ['World Pedestrians', { weather: 'rain' } as Partial<LayoutParams>],
    ['World Pedestrians', { pedestrians: false } as Partial<LayoutParams>],
    ['World Furniture', { parkedCars: false } as Partial<LayoutParams>],
    ['World Signage', { signage: false } as Partial<LayoutParams>],
    ['World Awnings', {}],
    ['World Signals', { trafficLights: false } as Partial<LayoutParams>],
    ['World Streets', { roofStyle: 'flat' } as unknown as Partial<LayoutParams>],
    ['World Streets', { cornerStyle: 'square' } as unknown as Partial<LayoutParams>],
    ['World Biome', { streetTrees: false } as Partial<LayoutParams>],
    ['World Layout', { sidewalks: false } as Partial<LayoutParams>],
    ['World Road Paint', { roadPaint: false } as Partial<LayoutParams>],
    ['World Terraces', {}],
    ['World Void Grid', {}],
    ['World Border Glow', {}],
    ['World Apron', {}],
    ['World Shotengai', {}],
];

describe('world jobs — determinism (worker == fallback == direct)', () => {
    // One built city (the centre build mutates its graph — that is the graph a selective regen sees).
    const base: WorldGraph = buildCentreGroups(P, { parkedTrain: true, activeRegions: null, chunk: null }).graph;

    it.each(SELECTIVE)('selective %s %j: worker/fallback bytes == direct; graph patch == the in-place mutation', async (name, change) => {
        const graph = structuredClone(base);
        Object.assign(graph.params, change);
        const before = JSON.stringify(graph);
        const req = { graph, names: [name], parkedTrain: true, activeRegions: null, chunk: { minCell: 1 } };
        // DIRECT main-thread build, in place (what the sync selective path does to the live graph)
        const inPlace = structuredClone(graph);
        const direct = fingerprint(buildSelectedGroups({ ...req, graph: inPlace }));
        // WORKER path: structured-clone in (postMessage), transfer copies out
        const api = workerApi();
        const viaWorker = await WORLD_JOB_HANDLERS[WORLD_JOB.groups](structuredClone(req), api) as SelectiveResult;
        expect(fingerprint(structuredClone(viaWorker.groups))).toEqual(direct);
        expect(JSON.stringify(graph)).toBe(before);   // the caller's graph is never touched by the job
        // the returned patch reproduces the in-place mutation exactly (most builders: no patch at all)
        const patched = structuredClone(graph);
        applyGraphPatch(patched, structuredClone(viaWorker.patch));
        expect(JSON.stringify(patched)).toBe(JSON.stringify(inPlace));
        if (name !== 'World Streets') expect(viaWorker.patch).toEqual([]);
        // FALLBACK path: the service on the main thread (no Worker in vitest)
        const svc = registerWorldLane(new WorkerJobService());
        const viaFallback = await svc.run<typeof req, SelectiveResult>(WORLD_JOB.groups, req).promise;
        expect(fingerprint(viaFallback.groups)).toEqual(direct);
        expect(JSON.stringify(viaFallback.patch)).toBe(JSON.stringify(viaWorker.patch));
        expect(svc.stats().fallbackRuns).toBe(1);
    }, 60000);
    it("'World Streets' with a corner-style change DOES mutate lots → non-empty patch", async () => {
        const graph = structuredClone(base);
        (graph.params as unknown as Record<string, unknown>).cornerStyle = 'square';
        const r = await WORLD_JOB_HANDLERS[WORLD_JOB.groups]({ graph, names: ['World Streets'], parkedTrain: true, activeRegions: null, chunk: null }, workerApi()) as SelectiveResult;
        expect(r.patch.length).toBeGreaterThan(0);
        expect(r.patch.every(e => e.k === 'lots' && typeof e.i === 'number')).toBe(true);
    }, 60000);

    it('tile + centre jobs == direct builds', async () => {
        const params = generateCityLayout(P).params;
        const api = workerApi();
        (api.shared as Record<string, unknown>).params = structuredClone(params);
        const tile = await WORLD_JOB_HANDLERS[WORLD_JOB.tile]({ tx: 1, tz: 0 }, api) as TileLayerGroup[];
        expect(fingerprint(tile)).toEqual(fingerprint(buildTileLayerGroups(params, 1, 0, true)));
        const opts = { parkedTrain: true, activeRegions: null, chunk: { minCell: 1 }, contact: { opacity: 0.55 } };
        const c = await WORLD_JOB_HANDLERS[WORLD_JOB.centre](structuredClone({ params: P, ...opts }), workerApi()) as { groups: TileLayerGroup[]; graph: WorldGraph };
        const d = buildCentreGroups(P, opts);
        expect(d.groups.every(g => isContactDone(g.layers))).toBe(true);   // blobs built over WHOLE groups in the worker
        expect(fingerprint(c.groups)).toEqual(fingerprint(d.groups));
        expect(JSON.stringify(c.graph)).toBe(JSON.stringify(d.graph));
    }, 60000);
});

// ── WorldManager level: the async (job) selective path lands the SAME layers as the sync path ──────────────
type Rec = { name: string; layers: TileLayerGroup['layers']; children: { visible: boolean }[] };
function recordingScene(log: Rec[]): unknown {
    const base: Record<string, unknown> = {
        getPostProcessing3D: () => ({}), findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        addFlatColorMeshGroup: (name: string, layers: TileLayerGroup['layers']) => {
            const g: Rec = { name, layers, children: layers.map(() => ({ visible: true })) };
            log.push(g);
            return g;
        },
        getAllMeshes: () => [],
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}

describe('WorldManager selective regen — worker path == sync path', () => {
    it.each([
        [{ weather: 'rain' }],
        [{ pedestrians: false }],
        [{ streetFurniture: false }],
        [{ cornerStyle: 'square' }],
    ] as Array<[Partial<LayoutParams>]>)('%j', async (change) => {
        const run = async (async: boolean): Promise<{ groups: string[]; fp: Record<string, string>; graph: unknown }> => {
            const log: Rec[] = [];
            const w = new WorldManager(recordingScene(log) as never);
            w.generateWorld({ ...P });
            (w as unknown as { _forceAsyncSelective: boolean })._forceAsyncSelective = async;
            const mark = log.length;
            w.updateCity(change);
            for (let i = 0; i < 400 && w.isUpdatingCity(); i++) await new Promise(r => setTimeout(r, 5));
            expect(w.isUpdatingCity()).toBe(false);
            const live = (w as unknown as { _groups: Rec[] })._groups;
            const added = log.slice(mark).filter(g => live.includes(g));
            return {
                // the time-sliced reassembly splits a big group into same-named SIBLING groups (like the centre
                // worker regen) — compare the set of names and the multiset of layers, not the group objects
                groups: [...new Set(live.map(g => g.name))].sort(),
                fp: content(added),
                graph: JSON.parse(JSON.stringify(w.graph)) as unknown,
            };
        };
        const sync = await run(false), viaJob = await run(true);
        expect(viaJob.groups).toEqual(sync.groups);
        const bad = Object.keys(sync.fp).filter(k => sync.fp[k] !== viaJob.fp[k]).map(k => `${k} sync=${sync.fp[k]} job=${viaJob.fp[k]}`);
        expect(bad).toEqual([]);
        expect(viaJob.graph).toEqual(sync.graph);
    }, 120000);
});

/** Layer CONTENT independent of how the reassembly partitioned it: per (group, layer, geometry bytes) the multiset of
 *  instance transforms (instanced layers are sliced across jobs) or the copy count; contact-shadow blob layers (built
 *  per reassembly job) by total vertex floats per group. */
function content(groups: Rec[]): Record<string, string> {
    const acc = new Map<string, string[]>();
    const blobs = new Map<string, number>();
    for (const g of groups) for (const L of g.layers) {
        if (/contact-shadow/.test(L.name)) { blobs.set(g.name, (blobs.get(g.name) ?? 0) + L.geometry.vertices.length); continue; }
        const [fp] = fingerprint([{ name: g.name, layers: [{ ...L, instances: undefined } as never] }]);
        const inst = (L as { instances?: unknown[] }).instances;
        const list = acc.get(fp) ?? [];
        if (inst) for (const t of inst) list.push(JSON.stringify(t)); else list.push('mesh');
        acc.set(fp, list);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of [...acc].sort((a, b) => a[0].localeCompare(b[0]))) out[k] = String(v.length) + ':' + v.sort().join(';').length;
    for (const [k, n] of blobs) out['blobs:' + k] = String(n);
    return out;
}

// bug-hunt 2026-10-01 D-W1: overlapping selective regens used to be keyed by their exact group-name set, so
// `lanterns` (Furniture + Shotengai) then `streetFurniture` (Furniture) BOTH ran and the older, larger one could land
// last — Furniture built from stale params. Now the newer request absorbs (and cancels) every intersecting one.
describe('WorldManager selective regen — overlapping requests', () => {
    it('a newer selective supersedes an intersecting older one and lands the final params', async () => {
        const run = async (async: boolean): Promise<{ fp: Record<string, string>; inflight: string[][] }> => {
            const log: Rec[] = [];
            const w = new WorldManager(recordingScene(log) as never);
            w.generateWorld({ ...P });
            (w as unknown as { _forceAsyncSelective: boolean })._forceAsyncSelective = async;
            const mark = log.length;
            // baseline: ONE sync update with both changes (two sync updates would leave 'World Sign Text' from the
            // first — the second touches no sign-support group — so the merged worker result is the correct one)
            if (async) { w.updateCity({ lanterns: false } as Partial<LayoutParams>); w.updateCity({ streetFurniture: false }); }
            else w.updateCity({ lanterns: false, streetFurniture: false } as Partial<LayoutParams>);
            const inflight = [...(w as unknown as { _selective: Map<string, { names: string[] }> })._selective.values()].map(s => [...s.names].sort());
            for (let i = 0; i < 400 && w.isUpdatingCity(); i++) await new Promise(r => setTimeout(r, 5));
            expect(w.isUpdatingCity()).toBe(false);
            const live = (w as unknown as { _groups: Rec[] })._groups;
            return { fp: content(log.slice(mark).filter(g => live.includes(g))), inflight };
        };
        const sync = await run(false), viaJob = await run(true);
        expect(viaJob.inflight).toEqual([['World Furniture', 'World Shotengai']]);   // ONE merged request
        const bad = [...new Set([...Object.keys(sync.fp), ...Object.keys(viaJob.fp)])].filter(k => sync.fp[k] !== viaJob.fp[k]).map(k => k.slice(0, 80) + ' sync=' + sync.fp[k] + ' job=' + viaJob.fp[k]);
        expect(bad).toEqual([]);
    }, 120000);
});
