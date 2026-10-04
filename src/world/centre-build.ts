// Shared CENTRE-CITY build — the full-regen pipeline (`generateCityLayout` + every group builder + the drape
// pass) as ONE pure function, so the tile Worker can run it off the main thread (audit §1.2). Mirrors
// WorldManager._startAsyncFull's queue (its `_buildGroup` switch + `_addStaged` drape env) — KEEP IN LOCKSTEP.
//
// The builders MUTATE the graph (lot.builtH / doors / variety claims / landmark tags) and the main thread needs
// that mutated graph afterwards (traffic, text signs, picking, bounds, selective regen) — so this returns BOTH
// the layer-groups AND the graph; WorldManager adopts the (structured-cloned) graph on swap. The graph is plain
// data (objects / arrays / numbers / strings only — verified against types.ts + every builder), so it survives
// postMessage's structured clone intact. Pure (no DOM / WebGPU) → worker-safe.

import {
    generateCityLayout,
    buildLayoutPreview, buildWater, buildTerraces, buildRoadPaint, buildApron, buildVoidGrid, buildBorderGlow,
    buildBiome, buildStreets, buildLandmarks, buildShotengai, buildTrafficLights, buildRoadSigns, buildSignage, buildAwnings,
    buildFurniture, buildRailway, buildSkyway, buildSky, buildPedestrians, buildLocalLine,
    makeElevation, makeHeightField, makeDomainWarpInto, tiledWorldExtent,
} from './index';
import type { LayoutParams, WorldGraph, LayoutPreviewLayer } from './types';
import type { TileLayerGroup } from './tile-build';
import { drapeLayerGroups } from './drape';
import { attachRunBoxes } from '../game/collision-cells';
import { FULL_BUILD_ORDER, LAYOUT_GROUPS } from './build-order';
import { chunkCityLayers, CHUNK_SKIP_GROUPS, type ChunkOptions } from './chunking';
import { cityContactShadowOptions, groupWithContactShadows } from './contact-shadows';
import { precomputeTraffic, wantsTraffic, type TrafficPrecompute } from './traffic-precompute';

/** Worker-cloneable inputs that live on WorldManager, not in params (mirrors what `_buildGroup` reads off `this`). */
export interface CentreBuildOptions {
    /** Step 3 (default true): per-256-triangle run boxes for the Play collision cells (collision-cells.ts). */
    runBoxes?: boolean;
    /** `!_trafficOn` — buildRailway shows the parked train only when the moving sim is off. */
    parkedTrain: boolean;
    /** Enabled district ids (the active-region editor), or null = whole city. Rebuilt into the same
     *  `(r) => set.has(r)` predicate `_regionFilter()` produces, so the RNG streams match the main path. */
    activeRegions: number[] | null;
    /** SPATIAL CHUNKING (Round 5 — culling): split the big merged layers into per-cell layers HERE, in the worker,
     *  after the drape (final positions) — WorldManager._chunked then passes the already-chunked layers through.
     *  null/absent = no chunking (the toggle off). */
    chunk?: ChunkOptions | null;
    /** CONTACT SHADOWS (P3.2): build each group's blobs HERE over the whole group (opacity = the city's ground-contact
     *  strength) and mark them done, so the main-thread reassembly (which splits groups into jobs) never re-clusters
     *  per slice. Absent/null = the main thread adds them (legacy behaviour). */
    contact?: { opacity: number } | null;
    /** TRAFFIC PRECOMPUTE (performance-plan P5.W4): also compute the mover specs + the routing net on the finished
     *  graph (traffic-precompute.ts) — only honoured where the city gets live traffic (wantsTraffic). The main thread
     *  then only creates the mover meshes. Absent/false = it computes them itself after the swap. */
    traffic?: boolean;
}

export interface CentreBuildResult {
    groups: TileLayerGroup[]; graph: WorldGraph;
    /** Tiled worlds only: the centre's border/bounds BEFORE the widen — the main thread rebuilds the drape env
     *  (`makeElevation`, whose pavement index reads the border) from these, matching the sync build. */
    centreFrame?: { border: WorldGraph['border']; bounds: WorldGraph['bounds'] };
    /** The traffic precompute (opts.traffic on a city that gets traffic). */
    traffic?: TrafficPrecompute;
}

// The centre's full-regen group order — EXACTLY WorldManager._startAsyncFull's queue (the layout groups, then the
// dressing sequence). Now the canonical FULL_BUILD_ORDER (build-order.ts). Unlike neighbour tiles the centre DOES
// build the sky (buildSky returns geometry for 'World Sky' below).

/** THE group-builder switch — WorldManager._buildGroup delegates here (region filter + parked-train flag passed in
 *  instead of read off `this`), so the main-thread, centre-worker and selective-worker builds share one source. */
export function buildGroupFor(name: string, g: WorldGraph, f: ((r: number) => boolean) | null, parkedTrain: boolean): LayoutPreviewLayer[] {
    switch (name) {
        case 'World Layout': return buildLayoutPreview(g);
        case 'World Water': return buildWater(g);
        case 'World Terraces': return buildTerraces(g);
        case 'World Road Paint': return buildRoadPaint(g);
        case 'World Apron': return buildApron(g);
        case 'World Void Grid': return buildVoidGrid(g);
        case 'World Border Glow': return buildBorderGlow(g);
        case 'World Biome': return buildBiome(g, f);
        case 'World Streets': return buildStreets(g, f);
        case 'World Landmarks': return buildLandmarks(g, f);
        case 'World Shotengai': return buildShotengai(g, f);
        case 'World Signals': return buildTrafficLights(g, f);
        case 'World Road Signs': return buildRoadSigns(g, f).layers;   // regulatory poles + warning GARP (plates come from _addTextSigns)
        case 'World Signage': return buildSignage(g, f);
        case 'World Awnings': return buildAwnings(g, f);
        case 'World Furniture': return buildFurniture(g, f);
        case 'World Railway': return [...buildRailway(g, parkedTrain), ...buildLocalLine(g, parkedTrain)];   // (+ the at-grade local line, R3.2)
        case 'World Skyway': return buildSkyway(g);
        case 'World Sky': return buildSky(g);
        case 'World Pedestrians': return buildPedestrians(g, f);
        default: return [];
    }
}

/** Build the CENTRE city's flat layer-groups + its (builder-mutated) graph. Deterministic (seed-derived), pure,
 *  worker-safe. Layers come back PRE-DRAPED with the centre's env — the graph's OWN elevation WITH terraces
 *  (makeElevation), the smooth field for bridges/canals, and the centre-relative domain warp (tx=tz=0, no
 *  offset) — exactly the `_addStaged` env the main-thread staging path uses, so visuals are identical. */
export function buildCentreGroups(params: Partial<LayoutParams>, opts: CentreBuildOptions, progress?: (p: number) => void): CentreBuildResult {
    // TILED worlds (performance-plan P5.W2): the centre tile is a grid/square city (terraces + shotengai off) whose
    // border is WIDENED to the whole tiled extent after the four map groups — exactly WorldManager.generateLayout's
    // tiled branch: the drape env (elevation incl. the pavement index) is taken from the UN-widened graph, the
    // apron / void grid / border glow + every dressing builder see the widened one. A 'flat' tile detail stops after
    // the extent groups (the centre stays a flat map like its neighbours).
    const tiled = params.worldMode === 'tiled';
    const graph = tiled
        ? generateCityLayout({ ...params, pattern: 'grid', border: 'square', terraces: false, shotengai: false })
        : generateCityLayout(params);
    const env = tiled ? { h: makeElevation(graph), border: graph.border, bounds: graph.bounds } : null;   // BEFORE the widen
    const flatOnly = tiled && graph.params.tileDetail === 'flat';
    const set = opts.activeRegions ? new Set(opts.activeRegions) : null;
    const f = set ? (r: number): boolean => set.has(r) : null;
    const out: TileLayerGroup[] = [];
    const order = flatOnly ? LAYOUT_GROUPS : FULL_BUILD_ORDER;
    for (let i = 0; i < order.length; i++) {
        const name = order[i];
        if (tiled && name === 'World Apron') widenToTiledExtent(graph);   // the first extent group
        const layers = buildGroupFor(name, graph, f, opts.parkedTrain);
        if (layers && layers.length) out.push({ name, layers });
        progress?.(0.9 * (i + 1) / order.length);
    }
    drapeLayerGroups(out, env ? env.h : makeElevation(graph), makeHeightField(graph.params), makeDomainWarpInto(graph.params));
    progress?.(0.95);
    if (opts.contact) { const co = cityContactShadowOptions(graph.params.radius ?? 10, opts.contact.opacity); for (const grp of out) grp.layers = groupWithContactShadows(grp.layers, co); }
    if (opts.chunk) for (const grp of out) if (!CHUNK_SKIP_GROUPS.test(grp.name)) grp.layers = chunkCityLayers(grp.layers, opts.chunk);
    if (opts.runBoxes !== false) attachRunBoxes(out);   // step 3: collision-cell run boxes (after drape + chunking)
    if (opts.traffic && !tiled && wantsTraffic(graph.params)) {
        const traffic = precomputeTraffic(graph);   // the graph is FINAL here (every builder ran; planes read lot.builtH)
        progress?.(0.99);
        return { groups: out, graph, traffic };
    }
    return env ? { groups: out, graph, centreFrame: { border: env.border, bounds: env.bounds } } : { groups: out, graph };
}

/** Widen a tiled world's centre graph to the whole tiled extent (the apron / void grid / border glow wrap the full
 *  world) — the single definition shared by WorldManager.generateLayout and the worker centre build. */
export function widenToTiledExtent(graph: WorldGraph): void {
    const half = tiledWorldExtent(graph.params);
    graph.border = [[half, half], [-half, half], [-half, -half], [half, -half]];
    graph.bounds = { min: [-half, -half], max: [half, half] };
}

/** Inputs of a SELECTIVE regen (performance-plan P3.2): the EXISTING graph (cloned to the worker) + which groups to
 *  rebuild. Same options as the centre build. */
export interface SelectiveBuildRequest extends CentreBuildOptions {
    graph: WorldGraph; names: string[];
    /** Step 3 (the backdrop follows the tile window): move the built layers by (x, z) BEFORE the drape, so an
     *  origin-centred backdrop (apron / void grid / border glow) is rebuilt around another tile and draped there. */
    offset?: [number, number];
}

/** Translate layers in XZ (geometry positions, or the per-copy transforms of an instanced layer). */
export function translateLayers(groups: TileLayerGroup[], dx: number, dz: number): void {
    const seen = new Set<object>();
    for (const grp of groups) for (const L of grp.layers) {
        const inst = (L as { instances?: { x: number; z: number }[] }).instances;
        if (inst?.length) { for (const t of inst) { t.x += dx; t.z += dz; } continue; }
        const g = L.geometry;
        if (seen.has(g)) continue;
        seen.add(g);
        const v = g.vertices;
        for (let i = 0; i < v.length; i += 12) { v[i] += dx; v[i + 2] += dz; }
        delete (g as { bounds?: unknown }).bounds;
    }
}

/** Rebuild just `names` on an existing graph, PRE-DRAPED with the centre env (makeElevation / makeHeightField /
 *  makeDomainWarpInto of the graph — what WorldManager's `_heightFn/_smoothFn/_warpInto` are for a single city) and
 *  chunked like the centre build. Group order = `names` order; empty groups are omitted. The selective builders
 *  only READ the graph (guarded by world-jobs.test.ts), so the worker's clone needs no adoption main-side.
 *  Pure, deterministic, worker-safe. */
export function buildSelectedGroups(req: SelectiveBuildRequest): TileLayerGroup[] {
    const g = req.graph;
    const set = req.activeRegions ? new Set(req.activeRegions) : null;
    const f = set ? (r: number): boolean => set.has(r) : null;
    const out: TileLayerGroup[] = [];
    for (const name of req.names) {
        const layers = buildGroupFor(name, g, f, req.parkedTrain);
        if (layers && layers.length) out.push({ name, layers });
    }
    if (req.offset && (req.offset[0] || req.offset[1])) translateLayers(out, req.offset[0], req.offset[1]);   // step 3: before the drape
    drapeLayerGroups(out, makeElevation(g), makeHeightField(g.params), makeDomainWarpInto(g.params));
    if (req.contact) { const co = cityContactShadowOptions(g.params.radius ?? 10, req.contact.opacity); for (const grp of out) grp.layers = groupWithContactShadows(grp.layers, co); }
    if (req.chunk) for (const grp of out) if (!CHUNK_SKIP_GROUPS.test(grp.name)) grp.layers = chunkCityLayers(grp.layers, req.chunk);
    if (req.runBoxes !== false) attachRunBoxes(out);   // step 3: collision-cell run boxes
    return out;
}
