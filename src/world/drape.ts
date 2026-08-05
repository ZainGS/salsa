// PRE-DRAPE for STREAMED TILES — the exact height-tier + domain-warp rules from WorldManager._addStaged, run
// INSIDE buildTileLayerGroups (i.e. in the tile Worker) so the per-vertex noise (~6 vnoise / 24 hash2 calls per
// vertex, over TWO passes) never touches the main thread. Reassembly on the main thread then only wraps meshes
// and uploads. Pure (no DOM / WebGPU) → worker-safe. KEEP IN LOCKSTEP with _addStaged (the centre city's
// main-thread drape path) — the tier rules must stay identical or tiles and centre diverge visually.

import { makeHeightField, applyHeightField } from './elevation';
import { makeDomainWarpInto, applyDomainWarp } from './warp';
import { tileParams, tileSeed } from './tiled';
import type { LayoutParams, LayoutPreviewLayer } from './types';

// BAKED — anchor elevation baked at build time; the height pass must not lift them again (see _addStaged).
const BAKED = /rail-|util-pole|util-wire|bldg-|world:detail|world:roofs|roof-detail|roof-equip|roof-mark|balcony|screen-|world:sign-|world:roadsign-|world:warning|awning-|shopfront|noren|textsign-|lm-|foundation|world:sky-|laundry|construction|world:parking|alley-clutter/;
// Void grid keeps its lines geometrically pure (no domain warp).
const NOWARP = /void-grid/;
// SMOOTH — layers whose discrete terrace level is already in their geometry (bridges at street level over sunken
// canals, terrace walls/stairs with loY/hiY per edge, the canal floor). They drape on the SMOOTH field only.
// (For tiles smoothFn === heightFn — tiles build with terraces:false, so smooth == full.)
const SMOOTH = /bridge|retaining|stair|canal/;

/** The shared drape pass — the exact height-tier + warp rules from `_addStaged`, applied in place, plus the
 *  per-geometry bounds precompute. Used by BOTH neighbour tiles (`drapeTileLayers`) and the centre city's
 *  worker build (`buildCentreGroups`). KEEP the tier rules in lockstep with WorldManager._addStaged. */
export function drapeLayerGroups(groups: { name: string; layers: LayoutPreviewLayer[] }[],
    heightFn: (x: number, z: number) => number, smoothFn: (x: number, z: number) => number,
    warpInto: (x: number, z: number, out: [number, number]) => void): void {
    const ws: [number, number] = [0, 0];
    for (const grp of groups) {
        for (const L of grp.layers) {
            // ★ ANY instanced layer carries ONE canonical geometry (at/near the origin) plus a per-copy
            // transform list. Height-fielding or warping that canonical samples the wrong place and moves
            // every copy identically — balconies float into the street, and an instanced TREE lands at the
            // origin's height with its canopy sheared. Lift/warp the TRANSFORMS instead. That is also the
            // only tear-free way to put a WIDE rigid prop across a terrace step: one anchor sample, whole
            // prop moves together. Order matches the geometry path (height at unwarped coords, then warp).
            const inst = (L as { instances?: { x: number; y: number; z: number }[] }).instances;
            const tier = L.drape ?? (BAKED.test(L.name) ? 'baked' : SMOOTH.test(L.name) ? 'smooth' : 'full');
            if (inst?.length) {
                if (tier !== 'baked') { const f = tier === 'smooth' ? smoothFn : heightFn; for (const t of inst) t.y += f(t.x, t.z); }
                if (!NOWARP.test(L.name)) for (const t of inst) { warpInto(t.x, t.z, ws); t.x += ws[0]; t.z += ws[1]; }
                continue;
            }
            if (tier !== 'baked') applyHeightField(L.geometry, tier === 'smooth' ? smoothFn : heightFn);
            if (!NOWARP.test(L.name)) applyDomainWarp(L.geometry, warpInto);
        }
        // PRECOMPUTE per-geometry bounds (post-drape) — Mesh3D.calculateBoundingBox reads them and skips its own
        // O(verts) scan. Field measured 15-19ms single reassembly jobs AFTER the drape moved off-thread: the
        // remaining cost was exactly these constructor scans (hundreds of meshes, instanced ones re-scanning the
        // same shared canonical geometry each). Runs here = in the Worker for async builds; survives the
        // structured-clone copy (plain field, spread-carried by tile-worker's transfer copy).
        for (const L of grp.layers) {
            const g = L.geometry as { vertices: Float32Array; bounds?: Float32Array };
            if (g.bounds) continue;   // canonical geometry shared across layers — computed once
            const v = g.vertices;
            let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (let i = 0; i < v.length; i += 12) {   // MESH3D vertex stride: 12 floats, position first
                if (v[i] < x0) x0 = v[i]; if (v[i] > x1) x1 = v[i];
                if (v[i + 1] < y0) y0 = v[i + 1]; if (v[i + 1] > y1) y1 = v[i + 1];
                if (v[i + 2] < z0) z0 = v[i + 2]; if (v[i + 2] > z1) z1 = v[i + 2];
            }
            if (v.length >= 12) g.bounds = Float32Array.of(x0, y0, z0, x1, y1, z1);
        }
    }
}

/** Drape one tile's layer-groups in place: the tile's OWN terrain (sampled tile-locally — the same field its
 *  baked building anchors used), then the WORLD's domain warp at world coords (matching what the main thread
 *  applied historically, so visuals don't shift). Instanced detail warps its instance transforms only.
 *  Tiles build with terraces:false, so smooth == full — one height field for both tiers. */
export function drapeTileLayers(groups: { name: string; layers: LayoutPreviewLayer[] }[], params: LayoutParams, tx: number, tz: number): void {
    const ox = tx * 2 * params.radius, oz = tz * 2 * params.radius;
    const hf = makeHeightField(tileParams(params, tileSeed(params.seed, tx, tz)) as LayoutParams);
    const heightFn = (x: number, z: number): number => hf(x - ox, z - oz);
    drapeLayerGroups(groups, heightFn, heightFn, makeDomainWarpInto(params));
}
