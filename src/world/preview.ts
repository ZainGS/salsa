// ── World generation — Phase 1 preview geometry ────────────────────────────────────────────────
// Turns a WorldGraph into a stack of FLAT, single-colour map layers (a top-down city map, like the Lumiose
// reference). Later phases replace this with real 3D buildings/foliage — this is the Phase-1 deliverable you
// can actually look at. Roads are the CREAM BASE showing through the gaps between the inset lots.
//
// 2D→world: a layout point [x, y] becomes world (x, layerY, y) — the map lies flat on the ground plane.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { WorldGraph, Zone, V2, LayoutPreviewLayer } from './types';
import { cityMetresPerUnit } from './types';
import { triangulate, clipConvex, bounds, centroid as centroidOf } from './util';
import { cellLevelAt, terraceStep } from './elevation';
import { cityPalette } from './palette';

/** Fill a CONVEX polygon with a grid of clipped cells → dense interior vertices, so the elevation post-transform can
 *  DRAPE it over the terrain. (A single big polygon like the whole-city road base only has perimeter vertices, so it
 *  would stay a flat sheet and buildings would poke under it.) */
function fillGrid(poly: V2[], step: number, skip?: (cx: number, cz: number) => boolean, refine?: (x0: number, z0: number, x1: number, z1: number) => boolean): V2[][] {
    const bb = bounds(poly), out: V2[][] = [];
    const emit = (x0: number, z0: number, x1: number, z1: number): void => {
        if (skip && skip((x0 + x1) * 0.5, (z0 + z1) * 0.5)) return;   // leave a HOLE (e.g. over a sunken canal → water shows)
        const cell = clipConvex([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], poly);
        if (cell.length >= 3) out.push(cell);
    };
    // With refinement, OFFSET the grid half a step: terrace boundaries lie on multiples of the step (grid cell
    // size is an exact multiple), so an aligned fill grid would never "straddle" one — the offset makes every
    // boundary bisect a cell, so the subdivision actually fires and the step-ramp narrows to a quarter step.
    const off = refine ? step * 0.5 : 0;
    for (let x = bb.min[0] - off; x < bb.max[0] - 1e-6; x += step) {
        for (let z = bb.min[1] - off; z < bb.max[1] - 1e-6; z += step) {
            const x1 = Math.min(x + step, bb.max[0]), z1 = Math.min(z + step, bb.max[1]);
            if (refine && refine(x, z, x1, z1)) {
                // Cell straddles a TERRACE boundary → 4× subdivision so the drape's step-ramp collapses to a
                // narrow band hidden behind the retaining wall (instead of a wide visible slope).
                const n = 4;
                for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
                    emit(x + (x1 - x) * i / n, z + (z1 - z) * j / n, x + (x1 - x) * (i + 1) / n, z + (z1 - z) * (j + 1) / n);
                }
            } else emit(x, z, x1, z1);
        }
    }
    return out;
}

/** Zone → flat map colour (0..1 RGB). Roads read as ASPHALT; sidewalks as light concrete; blocks keep zone tints. */
export const ZONE_COLOR: Record<Zone | 'road' | 'sidewalk', [number, number, number]> = {
    road:        [0.17, 0.18, 0.20],      // asphalt (the base — DARK: grounds the map + makes buildings/paint pop)
    sidewalk:    [0.70, 0.68, 0.63],      // light concrete sidewalk band around blocks
    residential: [0.855, 0.773, 0.643],   // #dac5a4 warm tan
    commercial:  [0.859, 0.612, 0.529],   // #db9c87 salmon
    civic:       [0.761, 0.486, 0.420],   // #c27c6b deeper terracotta
    park:        [0.663, 0.773, 0.545],   // #a9c58b sage green
    water:       [0.561, 0.722, 0.816],   // #8fb8d0 canal blue
    plaza:       [0.914, 0.871, 0.788],   // #e9deca light stone
};

/** Tiny per-layer Y offsets (world units) so near-coplanar layers don't z-fight; higher = drawn on top.
 *  (Road paint sits above these at ROAD_PAINT_Y ≈ 0.012 — it only lands on roads, so it never hides a lot.) */
const Y_OFFSET: Record<string, number> = {
    road: 0.0, sidewalk: 0.004, water: 0.007, park: 0.008, residential: 0.008, commercial: 0.008, civic: 0.009, plaza: 0.016,
};

/** Triangulate a set of 2D polygons into one flat MeshGeometry lying at world height `y` (normal +Y). */
/**
 * Triangulate flat polygons into one ground mesh at height `y`.
 *
 * `yOf` gives a PER-POLYGON height override, and exists for the terrace step. The step is a
 * DISCONTINUITY, and a block polygon has only its corners — nothing in the interior to break at — so a
 * per-vertex step makes the quad linearly RAMP from one level to the other. That is what "assets stretch
 * between the higher half and the lower half" was. Baking one level per polygon keeps each block flat at
 * its own height; such a layer must then drape on the SMOOTH field only (LayoutPreviewLayer.drape).
 */
export function polysToGeometry(polys: V2[][], y: number, yOf?: (poly: V2[], i: number) => number): MeshGeometry {
    // First pass: count.
    let vCount = 0, iCount = 0;
    const trisPer: number[][] = [];
    for (const poly of polys) {
        const tris = poly.length >= 3 ? triangulate(poly) : [];
        trisPer.push(tris);
        if (tris.length) { vCount += poly.length; iCount += tris.length; }
    }
    const vertices = new Float32Array(vCount * FLOATS_PER_VERT);
    const indices = new Uint32Array(iCount);
    let vo = 0, io = 0, base = 0;
    for (let p = 0; p < polys.length; p++) {
        const poly = polys[p], tris = trisPer[p];
        if (!tris.length) continue;
        const py = yOf ? yOf(poly, p) : y;
        for (const pt of poly) {
            vertices[vo++] = pt[0]; vertices[vo++] = py; vertices[vo++] = pt[1];   // pos (x, y, z=layoutY)
            vertices[vo++] = 0; vertices[vo++] = 1; vertices[vo++] = 0;           // normal +Y
            vertices[vo++] = pt[0] * 0.5; vertices[vo++] = pt[1] * 0.5;           // uv
            vertices[vo++] = 1; vertices[vo++] = 0; vertices[vo++] = 0; vertices[vo++] = 1;   // tangent
        }
        for (const idx of tris) indices[io++] = base + idx;
        base += poly.length;
    }
    return { vertices, indices, format: '12float' };
}

/** Build the full flat map: a road base + one layer per zone (grouped) + the plaza. Skips empty layers. */
export function buildLayoutPreview(graph: WorldGraph): LayoutPreviewLayer[] {
    const gy = graph.params.groundY;
    const layers: LayoutPreviewLayer[] = [];
    const step = graph.radius / 22;   // tessellation cell for the big flat fills (so they drape over terrain)
    const PAL = cityPalette(graph.params.seed, graph.params.palette);   // harmonized city colours (seeded or forced)

    // 1) Road/asphalt base = the whole border, TESSELLATED so it follows the terrain (streets = the gaps on top).
    // Canal cells are CUT OUT (a hole) so the sunken water shows through instead of being buried under the pavement.
    // Cells crossing a TERRACE boundary refine 4× so the level step reads as a crisp edge at the retaining wall.
    const roadY = gy + Y_OFFSET.road;
    const overCanal = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0;
    const e = step * 0.05;
    const crossesLevel = graph.levels ? (x0: number, z0: number, x1: number, z1: number): boolean => {
        const l = cellLevelAt(graph, (x0 + x1) / 2, (z0 + z1) / 2);
        return cellLevelAt(graph, x0 + e, z0 + e) !== l || cellLevelAt(graph, x1 - e, z0 + e) !== l
            || cellLevelAt(graph, x0 + e, z1 - e) !== l || cellLevelAt(graph, x1 - e, z1 - e) !== l;
    } : undefined;
    // ★ METRES PER WORLD UNIT. The city is a DIORAMA, not a 1:1 model: streets.ts defines a building floor
    // as 0.2 * scale units with CITY_FLOOR_M = 3, so one world unit is 15 m at the default radius. Every
    // procedural-ground size is authored in real millimetres, so without this the shader (which can only
    // derive world UNITS per uv) makes every paver and every noise feature exactly this factor too large —
    // a 900 mm flag came out 13.5 m across, which is what "the asphalt/cobble look way too big" was.
    const mpu = cityMetresPerUnit(graph.radius);
    // ★ BAKE the terrace level PER POLYGON (sampled at its centroid) for the coarse ground layers, and drape
    // them on the smooth field only. A block quad has four corners and no interior vertices, so a per-vertex
    // discrete step cannot break inside it — it linearly ramps between the two levels instead, stretching the
    // block between the higher and lower half. One level per polygon keeps each block flat at its own height.
    // The ROAD layer keeps the per-vertex tier: it is a subdivided grid (with 4x refinement across a level
    // change), so it has the vertices to represent a step properly.
    // ★ Two rules, because a polygon's level has two different jobs.
    //  · 'centroid' — the level a PROP standing on this ground would get. Trees are lifted by
    //    `cellLevelAt` at their own position, so any ground a prop stands on MUST use the same rule or
    //    the prop floats a whole terrace step above its lawn. Used for lots, parks and the plaza.
    //  · 'min'      — the lowest level over the polygon's corners. The PAVEMENT ring has to stay down with
    //    the carriageway, and its block quad's corners sit in the street band, so min pins it there.
    // Corners are nudged 15% toward the centroid so a vertex sitting exactly on a band edge can't coin-flip.
    const tStep = terraceStep(graph.params);
    const polyY = (base: number, rule: 'centroid' | 'min') => (poly: V2[]): number => {
        let cx = 0, cz = 0;
        for (const pt of poly) { cx += pt[0]; cz += pt[1]; }
        const n = Math.max(poly.length, 1);
        cx /= n; cz /= n;
        if (rule === 'centroid') return base + cellLevelAt(graph, cx, cz) * tStep;
        let lo = Infinity;
        for (const pt of poly) lo = Math.min(lo, cellLevelAt(graph, pt[0] + (cx - pt[0]) * 0.15, pt[1] + (cz - pt[1]) * 0.15));
        return base + (Number.isFinite(lo) ? lo : cellLevelAt(graph, cx, cz)) * tStep;
    };

    // ★ Real ASPHALT (procedural-ground §11): two-scale aggregate, pale chips and a crack network, instead
    // of the old dots pattern. `tint` still comes from the palette so styles/seasons keep control of colour.
    layers.push({ name: 'world:roads', color: ZONE_COLOR.road, y: roadY, geometry: polysToGeometry(fillGrid(graph.border, step, overCanal, crossesLevel), roadY), ground: { surface: 'asphalt', tint: ZONE_COLOR.road, metersPerUnit: mpu } });

    // 1b) Sidewalks = the block cells (asphalt shows only in the gaps between them = the roads); lots inset on top → the
    // sidewalk reads as a band around each block. Skip for park/water blocks (those want grass/water to the curb).
    if (graph.params.sidewalks) {
        const swBlocks = graph.blocks.filter(b => b.zone !== 'park' && b.zone !== 'water' && b.poly.length >= 3);
        const sw = swBlocks.map(b => b.poly);
        // Paving-slab joints via the grid pattern (flat-map UV = worldPos*0.5 → a cell ≈ 2/freq world units ≈ 0.29).
        // CONCRETE slabs — a stack-bond grid with pores + trowel mottling. 1.2 m slabs read as pavement at
        // walking scale (the library default 3 m is a road-slab pour, too big for a footway).
        if (sw.length) layers.push({ name: 'world:sidewalks', color: PAL.sidewalk, y: gy + Y_OFFSET.sidewalk, geometry: polysToGeometry(sw, gy + Y_OFFSET.sidewalk, polyY(gy + Y_OFFSET.sidewalk, 'min')), drape: 'smooth', ground: { surface: 'concrete', tint: PAL.sidewalk, tileMm: 1200, metersPerUnit: mpu } });
        // Block INTERIOR = a distinct courtyard/pathway paving (finer, slightly darker) — the space between the
        // buildings of one block reads as walkways instead of one endless sidewalk slab.
        const cy = gy + Y_OFFSET.sidewalk + 0.002;
        const court = swBlocks.map(b => { const c = centroidOf(b.poly); return b.poly.map(pt => [pt[0] + (c[0] - pt[0]) * 0.14, pt[1] + (c[1] - pt[1]) * 0.14] as V2); });
        // COBBLE — irregular voronoi set stones. A pedestrian courtyard wants a different *layout* from the
        // footway, not just a darker grey, so the block interior reads as a distinct space.
        if (court.length) layers.push({ name: 'world:courtyard', color: [PAL.sidewalk[0] * 0.9, PAL.sidewalk[1] * 0.9, PAL.sidewalk[2] * 0.88], y: cy, geometry: polysToGeometry(court, cy, polyY(cy, 'min')), drape: 'smooth', ground: { surface: 'cobble', tint: [PAL.sidewalk[0] * 0.9, PAL.sidewalk[1] * 0.9, PAL.sidewalk[2] * 0.88], metersPerUnit: mpu } });
    }

    // 2) One merged layer per zone (fewer meshes = cheaper; a whole park/water block reads coherently).
    const order: Zone[] = ['park', 'residential', 'commercial', 'civic'];   // 'water' is drawn (recessed) by water.ts
    for (const zone of order) {
        const polys = graph.lots.filter(l => l.zone === zone).map(l => l.poly);
        if (!polys.length) continue;
        const y = gy + (Y_OFFSET[zone] ?? 0.01);
        // ★ Parks get real TURF (three scales: mow drift, clumps, per-clump blade striation) instead of a dot
        // mottle. The built lot zones get concrete — but keep their PALETTE colour as the tint, so the map's
        // zone readability (and any style/season palette) survives the material upgrade.
        const col = zone === 'park' ? PAL.park : zone === 'residential' ? PAL.residential : zone === 'commercial' ? PAL.commercial : zone === 'civic' ? PAL.civic : ZONE_COLOR[zone];
        const grd = zone === 'park'
            ? { surface: 'grass' as const, tint: col, metersPerUnit: mpu }
            : { surface: 'concrete' as const, tint: col, tileMm: 2000, metersPerUnit: mpu };
        layers.push({ name: `world:${zone}`, color: col, y, geometry: polysToGeometry(polys, y, polyY(y, 'centroid')), drape: 'smooth', ground: grd });
    }

    // 3) Central plaza on top.
    if (graph.plaza && graph.plaza.length >= 3) {
        const y = gy + Y_OFFSET.plaza;
        // ASHLAR limestone — the flagship surface, on the one piece of ground the camera lingers on.
        layers.push({ name: 'world:plaza', color: ZONE_COLOR.plaza, y, geometry: polysToGeometry(fillGrid(graph.plaza, step * 0.5), y, polyY(y, 'centroid')), drape: 'smooth', ground: { surface: 'ashlar', tint: ZONE_COLOR.plaza, metersPerUnit: mpu } });
    }
    return layers;
}
