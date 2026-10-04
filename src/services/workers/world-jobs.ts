// The 'world' LANE's job kinds (performance-plan P3.1/P3.2): city tile builds, the centre full regen and the
// SELECTIVE group regens (pedestrians / weather / furniture / signage / …). The SAME handlers run inside the tile
// Worker (tile-worker.ts → serveJobs) and as the WorkerJobService's main-thread fallback, so the two paths cannot
// drift. Pure `src/world` only (no DOM / WebGPU) → worker-safe.
//
// GPU-READY RESULTS (P3.3): every group comes back PRE-DRAPED (final render-space positions), CHUNKED, with
// per-geometry bounds precomputed, as MESH3D-stride Float32Array vertices + Uint32Array indices — the main thread
// only wraps them in Mesh3D and uploads (time-sliced by WorldManager's reassembly queue).

import { buildTileLayerGroups, type TileLayerGroup, type TileBuildOptions } from '../../world/tile-build';
import { buildCentreGroups, buildSelectedGroups, type CentreBuildOptions, type CentreBuildResult, type SelectiveBuildRequest } from '../../world/centre-build';
import type { LayoutParams, WorldGraph, LayoutPreviewLayer } from '../../world';
import type { TrafficPrecompute } from '../../world/traffic-precompute';
import { jobParts, type JobApi, type JobHandler } from './worker-job-runtime';
import { packLayerInstances } from '../../world/packed-instances';
import { buildSkylineRing } from '../../world/skyline-ring';
import { makeHeightField } from '../../world/elevation';
import { tileParams } from '../../world/tiled';

export const WORLD_LANE = 'world';
export const WORLD_JOB = {
    /** One FULL neighbour tile (uses the lane's sticky `params`). */
    tile: 'world.tile',
    /** The centre city's full regen (+ the builder-mutated graph). */
    centre: 'world.centre',
    /** Selective regen: rebuild named groups on an existing graph. */
    groups: 'world.groups',
    /** P19: the skyline impostor ring past the HLOD skyline (skyline-ring.ts). */
    ring: 'world.ring',
} as const;

/** `params`: the tile's own params snapshot (D-W2); absent = the legacy lane-shared 'params'. */
export interface TileJob { tx: number; tz: number; params?: LayoutParams; opts?: TileBuildOptions; /** false = the cheap flat / massing tile (P10.D5); absent = full */ full?: boolean;
    /** P19: post the result one group per message (postGroupParts); the pool resolves the GeoRefs. */ parts?: boolean }
export interface CentreJob extends CentreBuildOptions { params: Partial<LayoutParams> }
/** P19: the skyline ring band around `centre` (tile coords), past `inner` tiles, `depth` tiles deep. */
export interface RingJob { params: LayoutParams; centre: [number, number]; inner: number; depth: number; perTile?: number }

/** COPY each geometry into FRESH buffers, then transfer the copies. We must NOT transfer the builders' geometry
 *  directly: instanced detail (balconies / greenery clumps) is MODULE-CACHED and reused across builds, so
 *  transferring (which DETACHES) would corrupt the cache and break every later build in this worker — and a
 *  buffer shared by two layers would be transferred twice (DataCloneError). Fresh copies are unique + cache-safe;
 *  the memcpy runs on the worker thread. ONE copy per SOURCE geometry: layers sharing a geometry object (a
 *  canonical instanced mesh split into per-cell layers by the chunk step) keep sharing it — structured clone
 *  preserves the shared reference. The main-thread fallback skips all this (same thread → nothing to transfer). */
type GeoCopies = Map<object, LayoutPreviewLayer['geometry']>;
export function transferGroups(groups: TileLayerGroup[], api: JobApi, copies: GeoCopies = new Map()): void {
    if (api.fallback) return;
    for (const grp of groups) transferLayers(grp.layers, api, copies);
}
function transferLayers(layers: LayoutPreviewLayer[], api: JobApi, copies: GeoCopies): void {
    for (const L of layers) {
        const g = L.geometry;
        let c = copies.get(g);
        if (!c) {
            const vertices = g.vertices.slice();
            const indices = g.indices ? g.indices.slice() : g.indices;
            c = { ...g, vertices, indices };
            copies.set(g, c);
            api.transfer(vertices.buffer);
            if (indices) api.transfer(indices.buffer);
        }
        L.geometry = c;
        if (L.propXf) api.transfer(L.propXf.buffer);   // P20: a prop layer's copies (one typed array, its own)
    }
}
/** The traffic precompute's mover geometry (P5.W4), copied + transferred like the groups' (one copy per SOURCE
 *  geometry: every mover of an archetype keeps SHARING its geometry object → one upload, instanced draws). The
 *  layer arrays are shared too (archetype cache) — each is visited once. */
export function transferTraffic(tp: TrafficPrecompute, api: JobApi, copies: GeoCopies = new Map()): void {
    if (api.fallback) return;
    const seen = new Set<LayoutPreviewLayer[]>();
    const visit = (layers: LayoutPreviewLayer[] | undefined): void => {
        if (!layers || seen.has(layers)) return;
        seen.add(layers);
        transferLayers(layers, api, copies);
    };
    for (const sp of tp.specs) { visit(sp.layers); if (sp.cars?.variants) for (const v of sp.cars.variants) visit(v); }
}

const tileJob: JobHandler<TileJob, TileLayerGroup[]> = ({ tx, tz, params: own, opts, full, parts }, api) => {
    const params = own ?? (api.shared.params as LayoutParams | undefined);
    if (!params) throw new Error('tile worker: no params');   // protocol violation guard
    const groups = buildTileLayerGroups(params, tx, tz, full !== false, opts ?? {});
    // P19 (parts): one message per GROUP, so the main thread deserialises a tile in pieces (a full tile's one message
    // was a 6-15 ms task: ~1,000 layers / ~6,000 objects). Its own transfer list rides each part.
    if (parts && api.part && !api.fallback) {
        const n = postGroupParts(groups, api, !!opts?.packInstances, opts?.splitParts === false ? null : PART_SPLIT);
        return jobParts(n) as unknown as TileLayerGroup[];   // P20: the PART count (a split group is several parts)
    }
    transferGroups(groups, api);
    // Step 3b: instance lists as typed arrays (the main thread's message task no longer rebuilds ~8 k objects a tile)
    if (opts?.packInstances && !api.fallback) for (const g of groups) for (const L of g.layers) { const b = packLayerInstances(L); if (b) api.transfer(...b); }
    return groups;
};

/** P19: a geometry another PART already carries (structured clone keeps shared references only within one message):
 *  the layer holds this reference instead and resolveGeoRefs puts the shared object back main-side. */
export interface GeoRef { __geoRef: [number, number] }
/** Post `groups` one per part (api.part): each group's geometry copied + transferred with it (one copy per source
 *  geometry, as transferGroups), a geometry already sent with an earlier part replaced by a GeoRef. */
export function postGroupParts(groups: TileLayerGroup[], api: JobApi, packInstances: boolean, split: PartSplit | null = PART_SPLIT): number {
    const copies: GeoCopies = new Map();
    const sentIn = new Map<object, [number, number]>();   // source geometry → [part, layer] of its first layer
    let pi = 0;
    for (const grp of groups) {
        // P20 splitParts: a big group (World Streets / Furniture: ~300 layers, 40-50 MB) goes as several parts of at
        // most `split.layers` layers / `split.bytes` bytes, each its own message; the main side merges them back
        // (resolveGeoRefs) into the one group. A single layer is never split.
        const chunks = split ? splitLayers(grp.layers, split) : [grp.layers];
        chunks.forEach((layers, ci) => {
            const local = new Set<object>();
            layers.forEach((L, li) => {
                const src = L.geometry;
                const prev = sentIn.get(src);
                if (prev && !local.has(src)) {
                    (L as unknown as { geometry: unknown }).geometry = { __geoRef: prev } satisfies GeoRef;
                    if (L.propXf) api.transfer(L.propXf.buffer);   // P20 (transferLayers does it otherwise)
                } else {
                    if (!prev) sentIn.set(src, [pi, li]);
                    local.add(src);
                    transferLayers([L], api, copies);
                }
                if (packInstances) { const b = packLayerInstances(L); if (b) api.transfer(...b); }
            });
            api.part!(ci === 0 ? { name: grp.name, layers } : { name: grp.name, layers, cont: true } satisfies TileLayerGroup & { cont?: boolean });
            pi++;
        });
    }
    return pi;
}
/** P20: how postGroupParts cuts a group (null = one part per group, the P19 behaviour). */
export interface PartSplit { layers: number; bytes: number }
/** P20 splitParts (WorldManager.P20.splitParts → TileJob.split): ≤ 48 layers / ≤ 6 MB of geometry a message. */
export const PART_SPLIT: PartSplit = { layers: 48, bytes: 6 << 20 };
/** Cut `layers` into runs of at most `s.layers` layers and `s.bytes` geometry bytes (each geometry counted once). */
export function splitLayers(layers: LayoutPreviewLayer[], s: PartSplit): LayoutPreviewLayer[][] {
    const out: LayoutPreviewLayer[][] = [];
    let cur: LayoutPreviewLayer[] = [], bytes = 0;
    const seen = new Set<object>();
    for (const L of layers) {
        const g = L.geometry, b = g && !seen.has(g) ? g.vertices.byteLength + (g.indices?.byteLength ?? 0) : 0;
        if (g) seen.add(g);
        if (cur.length && (cur.length >= s.layers || bytes + b > s.bytes)) { out.push(cur); cur = []; bytes = 0; }
        cur.push(L); bytes += b;
    }
    if (cur.length || !out.length) out.push(cur);
    return out;
}
/** Main side of postGroupParts: put the shared geometry objects back and merge a split group's parts back into one
 *  group (in order). Returns the groups. */
export function resolveGeoRefs(groups: TileLayerGroup[]): TileLayerGroup[] {
    for (const grp of groups) for (const L of grp.layers) {
        const r = (L.geometry as unknown as Partial<GeoRef>).__geoRef;
        if (r) L.geometry = groups[r[0]].layers[r[1]].geometry;
    }
    if (!groups.some(g => (g as { cont?: boolean }).cont)) return groups;
    const out: TileLayerGroup[] = [];
    for (const g of groups) {
        const prev = out[out.length - 1];
        if ((g as { cont?: boolean }).cont && prev && prev.name === g.name) { for (const L of g.layers) prev.layers.push(L); continue; }
        out.push({ name: g.name, layers: [...g.layers] });
    }
    return out;
}

const centreJob: JobHandler<CentreJob, CentreBuildResult> = (req, api) => {
    const res = buildCentreGroups(req.params, { parkedTrain: req.parkedTrain, activeRegions: req.activeRegions, chunk: req.chunk ?? null, contact: req.contact ?? null, traffic: !!req.traffic, runBoxes: req.runBoxes }, p => api.progress(p));
    const copies: GeoCopies = new Map();
    transferGroups(res.groups, api, copies);
    if (res.traffic) transferTraffic(res.traffic, api, copies);
    return res;
};

/** One mutation a selective builder made to the graph: top-level key `k` replaced (`i` absent), or element `i` of the
 *  array `graph[k]` replaced. Applied main-side IN PLACE (element objects keep their identity) by applyGraphPatch. */
export interface GraphPatchEntry { k: string; i?: number; v: unknown }
export interface SelectiveResult { groups: TileLayerGroup[]; patch: GraphPatchEntry[] }

/** JSON fingerprints of the graph (per array element for arrays) — `params` excluded (the main thread owns it). */
function snapshotGraph(g: WorldGraph): Map<string, string | string[]> {
    const m = new Map<string, string | string[]>();
    for (const [k, v] of Object.entries(g)) {
        if (k === 'params') continue;
        m.set(k, Array.isArray(v) ? v.map(e => JSON.stringify(e) ?? 'undefined') : JSON.stringify(v) ?? 'undefined');
    }
    return m;
}
/** What the builders changed: most selective builders only READ the graph (patch = []); 'World Streets' re-derives
 *  lot.builtH / doors / buildingMeta from the roof/corner style (world-jobs.test.ts pins both). */
export function diffGraph(before: Map<string, string | string[]>, g: WorldGraph): GraphPatchEntry[] {
    const out: GraphPatchEntry[] = [];
    for (const [k, v] of Object.entries(g)) {
        if (k === 'params') continue;
        const b = before.get(k);
        if (Array.isArray(v) && Array.isArray(b) && b.length === v.length) {
            for (let i = 0; i < v.length; i++) if ((JSON.stringify(v[i]) ?? 'undefined') !== b[i]) out.push({ k, i, v: v[i] });
        } else {
            const now = Array.isArray(v) ? v.map(e => JSON.stringify(e) ?? 'undefined') : JSON.stringify(v) ?? 'undefined';
            if (JSON.stringify(now) !== JSON.stringify(b)) out.push({ k, v });
        }
    }
    return out;
}
/** Apply a selective build's graph patch to the LIVE graph (element objects mutated in place → references held by
 *  traffic / picking / text signs stay valid). */
export function applyGraphPatch(g: WorldGraph, patch: readonly GraphPatchEntry[]): void {
    const G = g as unknown as Record<string, unknown>;
    for (const e of patch) {
        if (e.i === undefined) { G[e.k] = e.v; continue; }
        const arr = G[e.k] as unknown[] | undefined;
        if (!Array.isArray(arr)) continue;
        const tgt = arr[e.i] as Record<string, unknown> | undefined, v = e.v as Record<string, unknown> | undefined;
        if (tgt && v && typeof tgt === 'object' && typeof v === 'object' && !Array.isArray(tgt) && !Array.isArray(v)) {
            for (const key of Object.keys(tgt)) if (!(key in v)) delete tgt[key];
            Object.assign(tgt, v);
        } else arr[e.i] = e.v;
    }
}

const groupsJob: JobHandler<SelectiveBuildRequest, SelectiveResult> = (req, api) => {
    const before = snapshotGraph(req.graph);
    const groups = buildSelectedGroups(req);
    const patch = diffGraph(before, req.graph);
    transferGroups(groups, api);
    return { groups, patch };
};

/** P19: the skyline impostor ring (one group, world space, pre-draped on the world's smooth field). */
export function buildRingGroups(j: RingJob): TileLayerGroup[] {
    const p = j.params;
    const hf = makeHeightField(tileParams(p, p.seed) as LayoutParams, [j.centre[0] * 2 * p.radius, j.centre[1] * 2 * p.radius]);
    const gy = p.groundY ?? 0;
    const layers = buildSkylineRing({ seed: p.seed, radius: p.radius, centre: j.centre, inner: j.inner, depth: j.depth, perTile: j.perTile,
        ground: (x, z) => gy + hf(x, z), groundY: gy, palette: p.palette, nightMode: p.nightMode });
    return layers.length ? [{ name: 'World Skyline Ring', layers }] : [];
}
const ringJob: JobHandler<RingJob, TileLayerGroup[]> = (j, api) => {
    const groups = buildRingGroups(j);
    transferGroups(groups, api);
    return groups;
};

/** Handlers keyed by kind — the tile worker serves these; the service registers them as fallbacks. */
export const WORLD_JOB_HANDLERS: Record<string, JobHandler<any, any>> = {
    [WORLD_JOB.tile]: tileJob,
    [WORLD_JOB.centre]: centreJob,
    [WORLD_JOB.groups]: groupsJob,
    [WORLD_JOB.ring]: ringJob,
};
