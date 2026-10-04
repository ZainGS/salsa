// Shared tile geometry build — the SINGLE source of truth used by BOTH the main-thread fallback (`_buildTile`) and
// the tile Worker (src/services/streaming/tile-worker.ts), so the two can never drift. It produces the FLAT
// LayoutPreviewLayer groups for one neighbour tile (pre-drape); the main thread's `_addTracked` then drapes onto the
// terrain, makes the Mesh3D + material, and uploads to the GPU. This file is pure (no DOM / WebGPU) → worker-safe.
//
// Mirrors WorldManager._buildTile's full branch + BUILD_ORDER + _buildGroupFor. Keep them in lockstep.

import {
    generateCityLayout, tileParams, tileSeed, offsetGraphGeometry,
    buildLayoutPreview, buildWater, buildRoadPaint, buildBiome, buildStreets, buildLandmarks,
    buildShotengai, buildTrafficLights, buildRoadSigns, buildSignage, buildAwnings, buildFurniture, buildRailway, buildLocalLine,
    buildSkyway, buildPedestrians,
} from './index';
import type { LayoutParams, WorldGraph, LayoutPreviewLayer } from './types';
import { drapeTileLayers } from './drape';
import { attachRunBoxes } from '../game/collision-cells';
import { DRESSING_ORDER } from './build-order';
import { cityContactShadowOptions, groupWithContactShadows } from './contact-shadows';
import { buildTileMassing } from './tile-massing';
import { buildTileHlod, type HlodLevel } from './tile-hlod';
import { setPartRecording } from './meshbuild';
import { withTileSpeed, type TileSpeedSwitches } from './tile-speed';
import { snapshotPropParts, instancePropParts, stripPropParts, type PropInstancingOptions, type PropInstancingStats } from './prop-instancing';

/** One named mesh-group's worth of flat layers for a tile (reassembled into a MeshGroup3D on the main thread). */
export interface TileLayerGroup { name: string; layers: LayoutPreviewLayer[] }

/** Tile build switches (performance-plan P10). Plain data → rides in the worker job payload, so every A/B switch
 *  works identically on the worker and main-thread paths. Absent fields = the P10 defaults. */
export interface TileBuildOptions {
    /** P10.A1 TILE FRAME (default true): landmarks offset with the graph, and the railway / station / parked-train /
     *  metro / skyway placed at the tile (params.tileOrigin) and warped with the WORLD warp (params.warpSeed). false =
     *  the legacy build, whose railway + landmarks all landed ON TOP OF THE CENTRE CITY (8 extra viaducts in a 3×3). */
    tileFrame?: boolean;
    /** P10.A2 (default true): re-salt the legacy tile seed's mirrored collisions ((1,1) ≡ (−1,−1), (1,−1) ≡ (−1,1)). */
    seedDedup?: boolean;
    /** P10.B2: build each group's contact blobs HERE over the WHOLE group (opacity = the city's ground contact) and
     *  mark them done. null / absent = legacy: the main thread built them per reassembly JOB, which split a person's
     *  colour parts and near / mid / far crowd tiers into separate, overlapping blobs (and cost ~25 ms a tile). */
    contact?: { opacity: number } | null;
    /** P10.B3 (default true): build the kerb-lift elevation lazily (flat-map proxies never need it). */
    lazyElevation?: boolean;
    /** P10.C1: a non-full tile is the MASSING tier (flat map + one box per building lot) instead of the flat map. */
    massing?: boolean;
    /** P17 HLOD: a non-full tile is the merged HLOD tier instead ('mid' = per-tile building shells in colour buckets +
     *  merged ground; 'far' = a 2-draw silhouette). Built from the FULL layout (districts + landmarks), so the heights
     *  match the full tile. Wins over `massing`. */
    hlod?: HlodLevel | null;
    /** Step 3 (default true): FULL tiles carry per-256-triangle run boxes for the Play collision cells (collision-cells.ts
     *  attachRunBoxes), computed here in the worker. */
    runBoxes?: boolean;
    /** Step 3b: the world worker packs every layer's instance list into typed arrays (packed-instances.ts) for the
     *  trip to the main thread (read by the tile JOB, not the builder; the main-thread build ignores it). */
    packInstances?: boolean;
    /** P20 (default true): FULL tiles turn repeated street props (poles, signal heads, lamp posts, parked-car trim,
     *  vending machines, benches, bollards, cabinets, post boxes) into canonical geometry + instance transforms
     *  (world/prop-instancing.ts), exact to ~1 mm against the baked build. false = the baked props. */
    propInstancing?: boolean;
    /** P20 (default true): the drape evaluates the height field / gradient / warp once per distinct vertex (x, z)
     *  (drape-memo.ts — identical output; flat-shaded geometry repeats each corner on ~3 vertices). */
    drapeMemo?: boolean;
    /** P20: tolerance / threshold overrides for the instancing pass (tests, A/B). */
    propInstancingOpts?: Partial<PropInstancingOptions>;
    /** P20: filled with the instancing pass's counts when given (diagnostics). */
    propStats?: PropInstancingStats;
    /** P20 (default true; read by the tile JOB, not the builder): with P19 messageParts, a big group is posted as several
     *  parts of ≤ 48 layers / ≤ 6 MB (world-jobs splitLayers) and merged back main-side. false = one part per group. */
    splitParts?: boolean;
    /** P22 diagnostics: when given, filled with this build's milliseconds per phase (layout, each group's builder,
     *  parts, drape, contact, instancing, run boxes). Read by the bench / the worker timeline; never changes output. */
    timings?: Record<string, number>;
    /** P22 (tile-speed.ts): overrides of the build speed-up switches for this build (absent = the module defaults, all
     *  on). Output-neutral: every switch produces the same bytes. */
    speed?: Partial<TileSpeedSwitches>;
    /** P22 splitTile: build only this HALF of a full tile's groups (TILE_HALF_OF; the layout is generated in both). The
     *  two halves together are the whole tile, group for group the same bytes (tile-build.test.ts) — so one tile can
     *  build on two workers at once. Absent = every group. */
    half?: 0 | 1;
}

/** P22 splitTile: which half (two worker jobs) builds each group of a full tile. Only World Streets writes into the
 *  graph (each lot's builtH / door / buildingMeta / slot), and Signage, Awnings, Furniture and Pedestrians read it, so
 *  they build with Streets (half 0); the groups that never read it (the flat map, water, road paint, foliage, signals,
 *  road signs) are half 1 (~35-40 % of a tile). tile-build.test.ts checks every group's bytes against the whole build. */
export const TILE_HALF_OF: Readonly<Record<string, 0 | 1>> = {
    'World Streets': 0, 'World Landmarks': 0, 'World Shotengai': 0, 'World Signage': 0, 'World Awnings': 0,
    'World Furniture': 0, 'World Railway': 0, 'World Skyway': 0, 'World Sky': 0, 'World Pedestrians': 0,
    'Layout': 1, 'Water': 1, 'Road Paint': 1, 'World Biome': 1, 'World Signals': 1, 'World Road Signs': 1,
};
const inHalf = (half: 0 | 1 | undefined, name: string): boolean => half === undefined || (TILE_HALF_OF[name] ?? 0) === half;

/** The group order of a whole tile build ('Layout', 'Water', 'Road Paint', then TILE_BUILD_ORDER). */
const TILE_GROUP_ORDER: readonly string[] = ['Layout', 'Water', 'Road Paint', ...DRESSING_ORDER];
/** P22 splitTile: the two halves' groups (each in build order) merged back into the whole build's group order. */
export function mergeTileHalves(a: TileLayerGroup[], b: TileLayerGroup[]): TileLayerGroup[] {
    const rank = (name: string): number => {
        const m = /^World Tile -?\d+_-?\d+ (.*)$/.exec(name);
        const i = m ? TILE_GROUP_ORDER.indexOf(m[1]) : -1;
        return i < 0 ? TILE_GROUP_ORDER.length : i;
    };
    return [...a, ...b].map((g, i) => ({ g, i, r: rank(g.name) })).sort((x, y) => x.r - y.r || x.i - y.i).map(e => e.g);
}

// The per-tile group order (unfiltered — neighbour tiles build the whole city). Now the canonical DRESSING_ORDER
// (see build-order.ts) so it can never drift from the centre / WorldManager lists again.
export const TILE_BUILD_ORDER = DRESSING_ORDER;

/** Mirrors WorldManager._buildGroupFor with keep=null (tiles build unfiltered; parked train; no per-tile sky). */
function buildGroupFor(name: string, g: WorldGraph): LayoutPreviewLayer[] {
    switch (name) {
        case 'World Biome': return buildBiome(g, null);
        case 'World Streets': return buildStreets(g, null);
        case 'World Landmarks': return buildLandmarks(g, null);
        case 'World Shotengai': return buildShotengai(g, null);
        case 'World Signals': return buildTrafficLights(g, null);
        case 'World Road Signs': return buildRoadSigns(g, null).layers;   // regulatory poles + warning GARP (plates come from _addTextSigns)
        case 'World Signage': return buildSignage(g, null);
        case 'World Awnings': return buildAwnings(g, null);
        case 'World Furniture': return buildFurniture(g, null);
        case 'World Railway': return [...buildRailway(g, true), ...buildLocalLine(g, true)];   // parked trains (neighbours have no moving sim)
        case 'World Skyway': return buildSkyway(g);
        case 'World Sky': return [];                          // one shared sky for the world (the centre's), not per tile
        case 'World Pedestrians': return buildPedestrians(g, null);
        default: return [];
    }
}

/** Build one neighbour tile's flat layer-groups — a full 3D city (`full`) or just the cheap flat map. Deterministic
 *  (seed-derived), pure, worker-safe. The centre tile (0,0) is never built here — it's the full editable city. */
export function buildTileLayerGroups(params: LayoutParams, tx: number, tz: number, full: boolean, opts: TileBuildOptions = {}): TileLayerGroup[] {
    return withTileSpeed(opts.speed, () => buildTile(params, tx, tz, full, opts));   // P22: the speed switches of this job
}
function buildTile(params: LayoutParams, tx: number, tz: number, full: boolean, opts: TileBuildOptions): TileLayerGroup[] {
    const T = opts.timings;
    let t0 = T ? performance.now() : 0;
    const lap = (k: string): void => { if (!T) return; const t = performance.now(); T[k] = (T[k] ?? 0) + t - t0; t0 = t; };
    const frame = opts.tileFrame !== false;
    const tp = tileParams(params, tileSeed(params.seed, tx, tz, opts.seedDedup !== false));
    if (frame) tp.warpSeed = params.warpSeed ?? params.seed;   // the WORLD's warp (drapeTileLayers warps with `params`)
    const hlod = !full && opts.hlod ? opts.hlod : null;
    const g = generateCityLayout(tp, { layoutOnly: !full && !hlod });
    const dx = tx * 2 * params.radius, dz = tz * 2 * params.radius;
    offsetGraphGeometry(g, dx, dz, frame);
    if (frame) g.params.tileOrigin = [dx, dz];   // AFTER generation: layout-time claims ran in the local frame, like the lots
    lap('layout');
    const tag = `World Tile ${tx}_${tz}`;
    const out: TileLayerGroup[] = [];
    const push = (name: string, layers: LayoutPreviewLayer[]): void => { if (layers && layers.length) out.push({ name, layers }); };
    // P20: the builders mark their repeated props (Accum3D.beginPart) only while a FULL tile with instancing builds.
    const inst = full && opts.propInstancing !== false;
    const wasRec = setPartRecording(inst);
    try {
        const half = full ? opts.half : undefined;
        if (hlod) push(`${tag} HLOD`, buildTileHlod(g, hlod));   // P17: its own merged ground (no flat-map group)
        else if (inHalf(half, 'Layout')) push(`${tag} Layout`, buildLayoutPreview(g));
        lap('g:Layout');
        if (full) {
            if (inHalf(half, 'Water')) push(`${tag} Water`, buildWater(g)); lap('g:Water');
            if (inHalf(half, 'Road Paint')) push(`${tag} Road Paint`, buildRoadPaint(g)); lap('g:Road Paint');
            for (const name of TILE_BUILD_ORDER) { if (inHalf(half, name)) push(`${tag} ${name}`, buildGroupFor(name, g)); lap('g:' + name.replace(/^World /, '')); }
        } else if (opts.massing) push(`${tag} Massing`, buildTileMassing(g));
    } finally { setPartRecording(wasRec); }
    lap('groups');
    const parts = inst ? snapshotPropParts(out) : null;   // P20: every marked prop in its own frame, BEFORE the drape
    lap('parts');
    // PRE-DRAPE here (i.e. in the Worker for async builds): the per-vertex height+warp noise was the dominant
    // main-thread cost of tile reassembly. Layers arrive world-ready; _addStaged skips its drape for tiles.
    drapeTileLayers(out, params, tx, tz, g, opts.lazyElevation !== false, !full && opts.lazyElevation !== false, opts.drapeMemo !== false);   // g is offset to world coords → its kerb lift matches its baked anchors
    lap('drape');
    // CONTACT BLOBS over each WHOLE group, after the drape (final positions) — see TileBuildOptions.contact.
    if (opts.contact && !hlod) { const co = cityContactShadowOptions(params.radius ?? 10, opts.contact.opacity); for (const grp of out) grp.layers = groupWithContactShadows(grp.layers, co); }
    lap('contact');
    // P20: instance the repeated props AFTER the drape + contact blobs (the blobs came from the baked props, so they
    // are the same), against the final draped positions.
    if (parts) instancePropParts(out, parts, opts.propInstancingOpts, opts.propStats);
    else stripPropParts(out);
    lap('instance');
    if (full && opts.runBoxes !== false) attachRunBoxes(out);   // step 3: collision-cell run boxes (final positions)
    lap('runBoxes');
    if (full) markPackable(out);   // P22: the renderer may store these packed (it checks the constant tangent itself)
    return out;
}

/** P22 packedVertices: mark a full tile's geometry PACKABLE (`MeshGeometry.packable`, read by the renderer's pool —
 *  vertex-pack.ts): indexed, at most 65,536 vertices (16-bit indices). The renderer verifies the constant tangent
 *  while it packs and keeps the 48-byte format otherwise. A plain field: it survives the worker's structured clone. */
export function markPackable(groups: readonly { layers: readonly LayoutPreviewLayer[] }[]): number {
    let n = 0;
    for (const grp of groups) for (const L of grp.layers) {
        const g = L.geometry as (LayoutPreviewLayer['geometry'] & { packable?: boolean }) | undefined;
        if (!g || g.packable !== undefined || !g.indices || !g.indices.length) continue;
        g.packable = g.vertices.length / 12 <= 65536;
        if (g.packable) n++;
    }
    return n;
}
