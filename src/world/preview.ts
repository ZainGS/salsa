// ── World generation — Phase 1 preview geometry (the city GROUND) ──────────────────────────────────
// Turns a WorldGraph into the stack of flat ground layers every other composer stands on: the asphalt sheet,
// the raised pavements with their kerbs + gutters, block courtyards, the zone-tinted lots, the plaza.
//
// ★ All of it goes through the lattice-exact tessellator (ground-mesh.ts): every piece lies in one terrain
// triangle and one terrace-level region, with its level + kerb lift BAKED in, and drapes on the smooth field
// only. So road, paint, pavement and lots stay exactly coplanar on hills (no floating or sunken pavement, no
// road poking through — S8), a terrace step is a clean edge with no asphalt wedge at the wall foot (S7), and
// nothing on the high side of a step overhangs the retaining wall (S6: lots/courtyards start at the lot line,
// `streetBandHalf`, the same line the wall stands on).
//
// 2D→world: a layout point [x, y] becomes world (x, layerY, y) — the map lies flat on the ground plane.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { WorldGraph, Zone, V2, LayoutPreviewLayer } from './types';
import { cityMetresPerUnit } from './types';
import { triangulate, centroid as centroidOf } from './util';
import { cityPalette } from './palette';
import { groundTess, emitGround } from './ground-mesh';
import { gridLotRegion, inShotengaiCells } from './street-layout';
import { buildKerbs } from './kerbs';

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

/**
 * Triangulate flat polygons into one ground mesh at height `y` (corners only — no subdivision, no drape rules).
 * Kept for the few callers that want a plain flat decal; city GROUND goes through `emitGround` instead.
 * `yOf` gives a per-polygon height override.
 */
export function polysToGeometry(polys: V2[][], y: number, yOf?: (poly: V2[], i: number) => number): MeshGeometry {
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

/** Build the city ground: road sheet, pavements + kerbs + gutters, courtyards, zone lots, plaza. Skips empty layers. */
export function buildLayoutPreview(graph: WorldGraph): LayoutPreviewLayer[] {
    const gy = graph.params.groundY;
    const layers: LayoutPreviewLayer[] = [];
    const PAL = cityPalette(graph.params.seed, graph.params.palette);   // harmonized city colours (seeded or forced)
    const t = groundTess(graph);
    const lift = t.D.lift;
    // ★ METRES PER WORLD UNIT. The city is a DIORAMA, not a 1:1 model: one world unit is 15 m at the default
    // radius. Every procedural-ground size is authored in real millimetres, so the shader needs this factor.
    const mpu = cityMetresPerUnit(graph.radius);
    const shotengai = (x: number, z: number): boolean => inShotengaiCells(graph, x, z);
    // A FLAT-MAP neighbour tile (generated layoutOnly — no districts) is only ever seen from far away: keep the
    // raised pavement but skip the kerb/gutter strips and dropped kerbs, which would multiply its triangles.
    const flatMap = graph.regions.length === 0;

    // 1) The ASPHALT sheet = the whole border. Pavements stand a kerb height above it, so it can simply run on
    // underneath them. Canal cells (level < 0) are cut out — the sunken water shows through the hole.
    // ★ Real ASPHALT (procedural-ground §11); `tint` from the palette so styles/seasons keep control of colour.
    layers.push({ name: 'world:roads', color: ZONE_COLOR.road, y: gy, drape: 'smooth',
        geometry: emitGround(t, [graph.border], { y: gy }),
        ground: { surface: 'asphalt', tint: ZONE_COLOR.road, metersPerUnit: mpu } });

    // 1b) PAVEMENTS = the kerbed block outlines (rounded junction corners), raised by the kerb height. Parks and
    // water blocks have no pavement (grass/water to the kerb line). The shotengai paving owns its own cells.
    if (graph.params.sidewalks) {
        const pavePolys = t.pave.polys.filter((_, k) => t.pave.block[k] !== null);
        // CONCRETE slabs at 1.2 m — pavement at walking scale (the library default 3 m is a road-slab pour).
        if (pavePolys.length) layers.push({ name: 'world:sidewalks', color: PAL.sidewalk, y: gy, drape: 'smooth',
            geometry: emitGround(t, pavePolys, { y: gy, kerb: true, skip: shotengai, noDrops: flatMap }),
            ground: { surface: 'concrete', tint: PAL.sidewalk, tileMm: 1200, metersPerUnit: mpu } });
        if (!flatMap) layers.push(...buildKerbs(t));
        // Block INTERIOR = courtyard/pathway paving (COBBLE — a different layout, not just a darker grey), showing
        // between the buildings. It starts at the LOT LINE (grid) — the line the retaining wall stands on — so on
        // a raised block it can no longer hang out over the wall and roof the stair's top treads (S6).
        const court: V2[][] = [];
        for (const b of graph.blocks) {
            if (b.zone === 'park' || b.zone === 'water' || b.poly.length < 3) continue;
            if (graph.params.pattern === 'grid') { const reg = gridLotRegion(graph.params, b); if (reg) court.push(reg.poly); }
            else { const c = centroidOf(b.poly); court.push(b.poly.map(pt => [pt[0] + (c[0] - pt[0]) * 0.14, pt[1] + (c[1] - pt[1]) * 0.14] as V2)); }
        }
        const cc: [number, number, number] = [PAL.sidewalk[0] * 0.9, PAL.sidewalk[1] * 0.9, PAL.sidewalk[2] * 0.88];
        if (court.length) layers.push({ name: 'world:courtyard', color: cc, y: gy, drape: 'smooth',
            geometry: emitGround(t, court, { y: gy + lift, kerb: true, noDrops: flatMap }),
            ground: { surface: 'cobble', tint: cc, metersPerUnit: mpu } });
    }

    // 2) One merged layer per zone (fewer meshes = cheaper; a whole park/water block reads coherently). Lots sit
    // on the pavement surface (two lifts up: over the courtyard); park lawns sit on the road-level ground.
    const order: Zone[] = ['park', 'residential', 'commercial', 'civic'];   // 'water' is drawn (recessed) by water.ts
    for (const zone of order) {
        const polys = graph.lots.filter(l => l.zone === zone).map(l => l.poly);
        if (!polys.length) continue;
        // ★ Parks get real TURF; the built lot zones get concrete — but keep their PALETTE colour as the tint.
        const col = zone === 'park' ? PAL.park : zone === 'residential' ? PAL.residential : zone === 'commercial' ? PAL.commercial : zone === 'civic' ? PAL.civic : ZONE_COLOR[zone];
        const grd = zone === 'park'
            ? { surface: 'grass' as const, tint: col, metersPerUnit: mpu }
            : { surface: 'concrete' as const, tint: col, tileMm: 2000, metersPerUnit: mpu };
        const y = gy + lift * (zone === 'park' ? 3 : 2);
        layers.push({ name: `world:${zone}`, color: col, y, drape: 'smooth', geometry: emitGround(t, polys, { y, kerb: true, noDrops: flatMap }), ground: grd });
    }

    // 3) Central plaza (radial) — a kerbed, raised square like the pavements.
    if (graph.plaza && graph.plaza.length >= 3) {
        const y = gy + lift;
        // The kerbed plaza outline from the pavement index (stops at the ring road's kerb); the raw octagon when
        // pavements are off.
        const k = t.pave.block.indexOf(null), plaza = k >= 0 ? t.pave.polys[k] : graph.plaza;
        // ASHLAR limestone — the flagship surface, on the one piece of ground the camera lingers on.
        layers.push({ name: 'world:plaza', color: ZONE_COLOR.plaza, y, drape: 'smooth', geometry: emitGround(t, [plaza], { y, kerb: true }), ground: { surface: 'ashlar', tint: ZONE_COLOR.plaza, metersPerUnit: mpu } });
    }
    return layers;
}
