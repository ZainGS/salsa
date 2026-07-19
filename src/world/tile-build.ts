// Shared tile geometry build — the SINGLE source of truth used by BOTH the main-thread fallback (`_buildTile`) and
// the tile Worker (src/services/streaming/tile-worker.ts), so the two can never drift. It produces the FLAT
// LayoutPreviewLayer groups for one neighbour tile (pre-drape); the main thread's `_addTracked` then drapes onto the
// terrain, makes the Mesh3D + material, and uploads to the GPU. This file is pure (no DOM / WebGPU) → worker-safe.
//
// Mirrors WorldManager._buildTile's full branch + BUILD_ORDER + _buildGroupFor. Keep them in lockstep.

import {
    generateCityLayout, tileParams, tileSeed, offsetGraphGeometry,
    buildLayoutPreview, buildWater, buildRoadPaint, buildBiome, buildStreets, buildLandmarks,
    buildShotengai, buildTrafficLights, buildSignage, buildAwnings, buildFurniture, buildRailway,
    buildSkyway, buildPedestrians,
} from './index';
import type { LayoutParams, WorldGraph, LayoutPreviewLayer } from './types';
import { drapeTileLayers } from './drape';

/** One named mesh-group's worth of flat layers for a tile (reassembled into a MeshGroup3D on the main thread). */
export interface TileLayerGroup { name: string; layers: LayoutPreviewLayer[] }

// The per-tile group order (unfiltered — neighbour tiles build the whole city). 'World Sky' yields nothing (one
// shared sky for the world, not per tile). Mirrors WorldManager.BUILD_ORDER.
const TILE_BUILD_ORDER = [
    'World Biome', 'World Streets', 'World Landmarks', 'World Shotengai', 'World Signals',
    'World Signage', 'World Awnings', 'World Furniture', 'World Railway', 'World Skyway',
    'World Sky', 'World Pedestrians',
] as const;

/** Mirrors WorldManager._buildGroupFor with keep=null (tiles build unfiltered; parked train; no per-tile sky). */
function buildGroupFor(name: string, g: WorldGraph): LayoutPreviewLayer[] {
    switch (name) {
        case 'World Biome': return buildBiome(g, null);
        case 'World Streets': return buildStreets(g, null);
        case 'World Landmarks': return buildLandmarks(g, null);
        case 'World Shotengai': return buildShotengai(g, null);
        case 'World Signals': return buildTrafficLights(g, null);
        case 'World Signage': return buildSignage(g, null);
        case 'World Awnings': return buildAwnings(g, null);
        case 'World Furniture': return buildFurniture(g, null);
        case 'World Railway': return buildRailway(g, true);   // parked train (neighbours have no moving sim)
        case 'World Skyway': return buildSkyway(g);
        case 'World Sky': return [];                          // one shared sky for the world (the centre's), not per tile
        case 'World Pedestrians': return buildPedestrians(g, null);
        default: return [];
    }
}

/** Build one neighbour tile's flat layer-groups — a full 3D city (`full`) or just the cheap flat map. Deterministic
 *  (seed-derived), pure, worker-safe. The centre tile (0,0) is never built here — it's the full editable city. */
export function buildTileLayerGroups(params: LayoutParams, tx: number, tz: number, full: boolean): TileLayerGroup[] {
    const g = generateCityLayout(tileParams(params, tileSeed(params.seed, tx, tz)), { layoutOnly: !full });
    offsetGraphGeometry(g, tx * 2 * params.radius, tz * 2 * params.radius);
    const tag = `World Tile ${tx}_${tz}`;
    const out: TileLayerGroup[] = [];
    const push = (name: string, layers: LayoutPreviewLayer[]): void => { if (layers && layers.length) out.push({ name, layers }); };
    push(`${tag} Layout`, buildLayoutPreview(g));
    if (full) {
        push(`${tag} Water`, buildWater(g));
        push(`${tag} Road Paint`, buildRoadPaint(g));
        for (const name of TILE_BUILD_ORDER) push(`${tag} ${name}`, buildGroupFor(name, g));
    }
    // PRE-DRAPE here (i.e. in the Worker for async builds): the per-vertex height+warp noise was the dominant
    // main-thread cost of tile reassembly. Layers arrive world-ready; _addStaged skips its drape for tiles.
    drapeTileLayers(out, params, tx, tz);
    return out;
}
