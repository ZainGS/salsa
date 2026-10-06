// ── World generation — the Terrain Apron (Phase B of world-borders) ─────────────────────────────────────
// Nature PAST the city border: a grass/field ground ring (draped on the same terrain height field, so it rolls
// with the hills) + clustered forest patches, lone field trees and scattered rocks, filling the annulus from the
// border out to `apronRadius`. Blends the urban edge into open country instead of ending at a hard line. When the
// void grid is also on, the opaque nature ground covers the grid in this ring and the grid shows only past it →
// a city → nature → cyberspace gradient. Whole-city (not region-filtered); DRAPES on terrain but is excluded from
// the camera auto-frame (it extends well past the city). See docs/specs/world-borders.md.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { cityMetresPerUnit } from './types';
import { makeRng, pointInPolygon, hash2, valueNoise2D } from './util';
import { rockCluster, rockLayers, type RockPlacement } from './rocks';
import { buildCityFoliage, type TreePlacement } from './city-foliage';
import { groundTess, emitGround } from './ground-mesh';

/** Grass / earth shades as a GRADIENT (deep forest floor → meadow → dry grass → dirt). Neighbouring cells take
 *  neighbouring shades (they're quantised from a SMOOTH noise), so the ground grades from one to the next in
 *  small steps instead of the old random checkerboard of five unrelated colours. */
const SHADES: [number, number, number][] = [
    [0.34, 0.47, 0.26],   // deep forest-floor green
    [0.38, 0.51, 0.28],
    [0.42, 0.55, 0.30],   // meadow green
    [0.47, 0.57, 0.32],
    [0.50, 0.56, 0.33],   // pale dry grass
    [0.52, 0.50, 0.31],   // dry earth
];

export function buildApron(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!p.terrainApron) return [];
    const R = p.radius, gy = p.groundY;
    const apronR = R * (p.apronRadius ?? 2.5);
    const density = p.natureDensity ?? 0.6;
    const border = graph.border;
    const inCity = (x: number, z: number): boolean => pointInPolygon([x, z], border);
    const mpu = cityMetresPerUnit(R);

    // ── Nature ground ring (S15). Small cells with JITTERED shared corners (so no straight grid lines survive),
    //    each shaded from a two-octave smooth noise quantised into the gradient above → soft organic bands of
    //    colour, with the procedural TURF material on top hiding what edges remain. Split on the ground lattice
    //    like the city ground, so the trees (lifted by the same field at their base) stand exactly on it. ──
    const cell = R * 0.08, n = Math.ceil(apronR / cell);
    const sN = (p.seed ^ 0x1f83) >>> 0, sM = (p.seed ^ 0x77c5) >>> 0;
    const corner = (i: number, j: number): V2 => [
        i * cell + (hash2(i, j, sN) - 0.5) * cell * 0.45,
        j * cell + (hash2(i, j, sM) - 0.5) * cell * 0.45,
    ];
    const shadeQuads: V2[][][] = SHADES.map(() => []);
    for (let ix = -n; ix < n; ix++) {
        for (let iz = -n; iz < n; iz++) {
            const cx = (ix + 0.5) * cell, cz = (iz + 0.5) * cell;
            const r = Math.hypot(cx, cz);
            if (r > apronR || r < R * 0.6) continue;         // ring only (skip the far corners + the city interior)
            if (inCity(cx, cz)) continue;                     // the city map owns everything inside the border
            const v = 0.7 * valueNoise2D(cx / (R * 0.55), cz / (R * 0.55), sN) + 0.3 * valueNoise2D(cx / (R * 0.18), cz / (R * 0.18), sM);
            const si = Math.max(0, Math.min(SHADES.length - 1, Math.floor(((v - 0.2) / 0.6) * SHADES.length)));
            shadeQuads[si].push([corner(ix, iz), corner(ix + 1, iz), corner(ix + 1, iz + 1), corner(ix, iz + 1)]);
        }
    }

    // ── Scatter: forest CLUMPS (low-freq hash patches) with dense trees, sparse LONE trees in the open fields,
    //    and a few rocks. Deterministic; fades out near the far edge so the country dissolves, not cuts off. ──
    // ★ E8: the trees are the REAL instanced city trees (city-foliage.ts — branch-generated, carded, wind), not the
    //   legacy cones + octahedra, so the forest outside the border matches the trees inside it.
    const trees: TreePlacement[] = [];
    const rocks: RockPlacement[] = [];
    const clumpSize = R * 0.6, step = R * 0.1;
    const nT = Math.ceil(apronR / step);
    for (let ix = -nT; ix <= nT; ix++) {
        for (let iz = -nT; iz <= nT; iz++) {
            const jx = (hash2(ix, iz, (p.seed ^ 0x51a1) >>> 0) - 0.5) * step;
            const jz = (hash2(ix, iz, (p.seed ^ 0x2b7d) >>> 0) - 0.5) * step;
            const x = ix * step + jx, z = iz * step + jz;
            const r = Math.hypot(x, z);
            if (r > apronR || r < R * 0.55 || inCity(x, z)) continue;
            const edgeFade = 1 - Math.max(0, (r - apronR * 0.75) / (apronR * 0.25));   // thin out toward the rim
            const clump = hash2(Math.floor(x / clumpSize), Math.floor(z / clumpSize), (p.seed ^ 0x9f13) >>> 0);
            const local = hash2(ix * 7 + 3, iz * 13 + 5, (p.seed ^ 0x6c2e) >>> 0);
            const inForest = clump < 0.42 * (0.5 + density);
            const chance = (inForest ? 0.72 : 0.05 * density) * edgeFade;
            if (local < chance) {
                const k = hash2(ix * 3 + 1, iz * 5 + 7, (p.seed ^ 0xa1) >>> 0);
                // Forest = conifer-heavy woodland; open fields = broadleaf with the odd bush.
                const kind = inForest ? (k < 0.55 ? 'conifer' : 'broadleaf') : (k < 0.8 ? 'broadleaf' : 'bush');
                trees.push({ pos: [x, z], y: gy, kind, scale: inForest ? 1.05 : 0.9 });
            } else if (hash2(ix * 5 + 1, iz * 11 + 2, (p.seed ^ 0x3d5c) >>> 0) < 0.02 * edgeFade) {
                // A rock CLUSTER (rocks.ts), not a lone octahedron: one big field stone + a few small ones.
                rockCluster(rocks, x, z, gy, makeRng((p.seed ^ (ix * 91 + iz * 7)) >>> 0), 1 / mpu,
                    (qx, qz) => !inCity(qx, qz) && Math.hypot(qx, qz) < apronR, { bigMin: 0.9, bigMax: 2.4 });
            }
        }
    }

    const layers: LayoutPreviewLayer[] = [];
    const t = groundTess(graph);
    // One layer per shade, all on the TURF material (tinted) so the mow/clump noise runs continuously across.
    for (let si = 0; si < SHADES.length; si++) {
        const q = shadeQuads[si];
        if (!q.length) continue;
        const c = SHADES[si];
        layers.push({ name: `world:apron-ground-${si}`, color: c, y: gy, drape: 'smooth', geometry: emitGround(t, q, { y: gy, levels: false }),
            ground: { surface: 'grass', tint: c, metersPerUnit: mpu }, excludeFromFrame: true });
    }
    // Same variant pool + seed + leaf tint as the city's trees → the geometry cache ('wld:tree:…') is shared.
    for (const L of buildCityFoliage(trees, mpu, p.seed, { leafColor: p.leafColor, leafColorVar: p.leafColorVar })) {
        layers.push({ ...L, excludeFromFrame: true });
    }
    layers.push(...rockLayers(rocks, mpu, 'world:apron-rocks', { excludeFromFrame: true }));
    return layers;
}
