// PRE-DRAPE for STREAMED TILES — the exact height-tier + domain-warp rules from WorldManager._addStaged, run
// INSIDE buildTileLayerGroups (i.e. in the tile Worker) so the per-vertex noise (~6 vnoise / 24 hash2 calls per
// vertex, over TWO passes) never touches the main thread. Reassembly on the main thread then only wraps meshes
// and uploads. Pure (no DOM / WebGPU) → worker-safe. KEEP IN LOCKSTEP with _addStaged (the centre city's
// main-thread drape path) — the tier rules must stay identical or tiles and centre diverge visually.

import { makeHeightField, makeElevation, applyHeightField, type HeightFn } from './elevation';
import { makeDomainWarpInto, applyDomainWarp } from './warp';
import { tileParams } from './tiled';
import type { LayoutParams, LayoutPreviewLayer, WorldGraph } from './types';
import { drapeCrowdRecords } from './crowd-instanced';
import { XZMemo, applyHeightFieldMemo, applyDomainWarpMemo, applyDrapeFused } from './drape-memo';
import { TILE_SPEED } from './tile-speed';

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
    heightFn: HeightFn | ((x: number, z: number) => number), smoothFn: HeightFn | ((x: number, z: number) => number),
    warpInto: (x: number, z: number, out: [number, number]) => void, memo = false): void {
    const ws: [number, number] = [0, 0];
    // P20 drapeMemo: the per-vertex height / gradient / warp of every distinct (x, z) once (drape-memo.ts; identical output)
    const mFull = memo ? new XZMemo(3) : null, mSmooth = memo && smoothFn !== heightFn ? new XZMemo(3) : mFull, mWarp = memo ? new XZMemo(2) : null;
    // P22 fusedDrape (tile-speed.ts): height + warp + bounds in one pass per layer (identical bytes); the bounds of a
    // geometry draped exactly once in the group are taken from that pass, the rest are scanned as before
    const fused = memo && TILE_SPEED.fusedDrape, mFused = fused ? new XZMemo(5) : null;
    const fb = new Float64Array(6);
    for (const grp of groups) {
        const fusedBounds = fused ? new Map<object, Float32Array | null>() : null;   // null = draped twice → scan
        for (const L of grp.layers) {
            // ★ ANY instanced layer carries ONE canonical geometry (at/near the origin) plus a per-copy
            // transform list. Height-fielding or warping that canonical samples the wrong place and moves
            // every copy identically — balconies float into the street, and an instanced TREE lands at the
            // origin's height with its canopy sheared. Lift/warp the TRANSFORMS instead. That is also the
            // only tear-free way to put a WIDE rigid prop across a terrace step: one anchor sample, whole
            // prop moves together. Order matches the geometry path (height at unwarped coords, then warp).
            const inst = (L as { instances?: { x: number; y: number; z: number }[] }).instances;
            const tier = L.drape ?? (BAKED.test(L.name) ? 'baked' : SMOOTH.test(L.name) ? 'smooth' : 'full');
            const noWarp = L.noWarp || NOWARP.test(L.name);
            // P12 instanced crowd: the person records get their rigid build → render offsets (sampled at the feet).
            if (L.crowdRecords) drapeCrowdRecords(L.crowdRecords, heightFn, smoothFn, noWarp ? null : warpInto);
            if (inst?.length) {
                if (tier !== 'baked') { const f = tier === 'smooth' ? smoothFn : heightFn; for (const t of inst) t.y += f(t.x, t.z); }
                if (!noWarp) for (const t of inst) { warpInto(t.x, t.z, ws); t.x += ws[0]; t.z += ws[1]; }
                continue;
            }
            if (mFused && (tier !== 'baked' || !noWarp)) {
                const g = L.geometry;
                applyDrapeFused(g, tier === 'baked' ? null : tier === 'smooth' ? smoothFn : heightFn, noWarp ? null : warpInto, mFused, fb);
                fusedBounds!.set(g, fusedBounds!.has(g) || g.vertices.length < 12 ? null : Float32Array.of(fb[0], fb[1], fb[2], fb[3], fb[4], fb[5]));
                continue;
            }
            if (tier !== 'baked') {
                const f = tier === 'smooth' ? smoothFn : heightFn, mm = tier === 'smooth' ? mSmooth : mFull;
                if (mm) applyHeightFieldMemo(L.geometry, f, mm); else applyHeightField(L.geometry, f);
            }
            if (!noWarp) { if (mWarp) applyDomainWarpMemo(L.geometry, warpInto, mWarp); else applyDomainWarp(L.geometry, warpInto); }
        }
        // PRECOMPUTE per-geometry bounds (post-drape) — Mesh3D.calculateBoundingBox reads them and skips its own
        // O(verts) scan. Field measured 15-19ms single reassembly jobs AFTER the drape moved off-thread: the
        // remaining cost was exactly these constructor scans (hundreds of meshes, instanced ones re-scanning the
        // same shared canonical geometry each). Runs here = in the Worker for async builds; survives the
        // structured-clone copy (plain field, spread-carried by tile-worker's transfer copy).
        for (const L of grp.layers) {
            const g = L.geometry as { vertices: Float32Array; bounds?: Float32Array };
            if (g.bounds) continue;   // canonical geometry shared across layers — computed once
            const fbx = fusedBounds?.get(g);
            if (fbx) { g.bounds = fbx; continue; }   // P22 fusedDrape: taken in the drape pass itself
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

/** Drape one tile's layer-groups in place on the ONE world height field (base terrain seed, WORLD coords — the
 *  same field the centre city and every other tile use, S12), then the world's domain warp. Instanced detail
 *  lifts/warps its transforms only. Tiles build with terraces:false, so the only non-smooth part of the full
 *  elevation is the kerb lift on pavements — pass the tile's `graph` (already offset to world coords) and
 *  full-tier props get it too, exactly like the anchors its builders baked with makeElevation(graph). */
export function drapeTileLayers(groups: { name: string; layers: LayoutPreviewLayer[] }[], params: LayoutParams, tx: number, tz: number, graph?: WorldGraph, lazyElevation = true, centred = false, memo = false): void {
    // `centred` (P10.B3, flat / massing tiles): the height field's precomputed core sits on THIS tile (see
    // makeHeightField) — a far tile's every vertex otherwise went through the out-of-core memo map.
    const smooth = makeHeightField(tileParams(params, params.seed) as LayoutParams, centred ? [tx * 2 * params.radius, tz * 2 * params.radius] : undefined);
    let heightFn: HeightFn = smooth;
    if (graph && lazyElevation) {
        // P10.B3 LAZY KERB LIFT: makeElevation(graph) builds the pavement index (~10-25 ms a tile) even when no layer
        // takes the full height tier — a flat-map proxy drapes only 'smooth' layers, so it never needs it. Built on the
        // first full-tier sample instead. Same field: its gradient IS the smooth field's (makeElevation copies it).
        let full: HeightFn | null = null;
        const lazy = ((x: number, z: number): number => (full ??= makeElevation(graph))(x, z)) as HeightFn;
        lazy.grad = smooth.grad;
        lazy.lattice = smooth.lattice;
        heightFn = lazy;
    } else if (graph) heightFn = makeElevation(graph);
    drapeLayerGroups(groups, heightFn, smooth, makeDomainWarpInto(params), memo);   // memo: P20 drapeMemo (identical output)
}
