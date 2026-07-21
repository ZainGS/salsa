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
    buildBiome, buildStreets, buildLandmarks, buildShotengai, buildTrafficLights, buildSignage, buildAwnings,
    buildFurniture, buildRailway, buildSkyway, buildSky, buildPedestrians,
    makeElevation, makeHeightField, makeDomainWarpInto,
} from './index';
import type { LayoutParams, WorldGraph, LayoutPreviewLayer } from './types';
import type { TileLayerGroup } from './tile-build';
import { drapeLayerGroups } from './drape';

/** Worker-cloneable inputs that live on WorldManager, not in params (mirrors what `_buildGroup` reads off `this`). */
export interface CentreBuildOptions {
    /** `!_trafficOn` — buildRailway shows the parked train only when the moving sim is off. */
    parkedTrain: boolean;
    /** Enabled district ids (the active-region editor), or null = whole city. Rebuilt into the same
     *  `(r) => set.has(r)` predicate `_regionFilter()` produces, so the RNG streams match the main path. */
    activeRegions: number[] | null;
}

export interface CentreBuildResult { groups: TileLayerGroup[]; graph: WorldGraph }

/** The centre's full-regen group order — EXACTLY WorldManager._startAsyncFull's queue
 *  (the layout groups, then BUILD_ORDER). Unlike neighbour tiles the centre DOES build the sky. */
const CENTRE_BUILD_ORDER = [
    'World Layout', 'World Water', 'World Terraces', 'World Road Paint', 'World Apron', 'World Void Grid',
    'World Border Glow',
    'World Biome', 'World Streets', 'World Landmarks', 'World Shotengai', 'World Signals',
    'World Signage', 'World Awnings', 'World Furniture', 'World Railway', 'World Skyway',
    'World Sky', 'World Pedestrians',
] as const;

/** Mirrors WorldManager._buildGroup (region filter + parked-train flag passed in instead of read off `this`). */
function buildGroupFor(name: string, g: WorldGraph, f: ((r: number) => boolean) | null, parkedTrain: boolean): LayoutPreviewLayer[] {
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
        case 'World Signage': return buildSignage(g, f);
        case 'World Awnings': return buildAwnings(g, f);
        case 'World Furniture': return buildFurniture(g, f);
        case 'World Railway': return buildRailway(g, parkedTrain);
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
export function buildCentreGroups(params: Partial<LayoutParams>, opts: CentreBuildOptions): CentreBuildResult {
    const graph = generateCityLayout(params);
    const set = opts.activeRegions ? new Set(opts.activeRegions) : null;
    const f = set ? (r: number): boolean => set.has(r) : null;
    const out: TileLayerGroup[] = [];
    for (const name of CENTRE_BUILD_ORDER) {
        const layers = buildGroupFor(name, graph, f, opts.parkedTrain);
        if (layers && layers.length) out.push({ name, layers });
    }
    drapeLayerGroups(out, makeElevation(graph), makeHeightField(graph.params), makeDomainWarpInto(graph.params));
    return { groups: out, graph };
}
