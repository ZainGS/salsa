// ── World generation — the Terrain Apron (Phase B of world-borders) ─────────────────────────────────────
// Nature PAST the city border: a grass/field ground ring (draped on the same terrain height field, so it rolls
// with the hills) + clustered forest patches, lone field trees and scattered rocks, filling the annulus from the
// border out to `apronRadius`. Blends the urban edge into open country instead of ending at a hard line. When the
// void grid is also on, the opaque nature ground covers the grid in this ring and the grid shows only past it →
// a city → nature → cyberspace gradient. Whole-city (not region-filtered); DRAPES on terrain but is excluded from
// the camera auto-frame (it extends well past the city). See docs/specs/world-borders.md.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { makeRng, pointInPolygon, hash2 } from './util';
import { Accum3D } from './meshbuild';
import { addTree, addRock } from './biome';
import { polysToGeometry } from './preview';

const FOLIAGE_COLOR: [number, number, number] = [0.28, 0.50, 0.26];  // forest leaf green
const TRUNK_COLOR:   [number, number, number] = [0.36, 0.26, 0.17];
const ROCK_COLOR:    [number, number, number] = [0.55, 0.55, 0.58];

export function buildApron(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!p.terrainApron) return [];
    const R = p.radius, gy = p.groundY, scale = R / 10;
    const apronR = R * (p.apronRadius ?? 2.5);
    const density = p.natureDensity ?? 0.6;
    const border = graph.border;
    const inCity = (x: number, z: number): boolean => pointInPolygon([x, z], border);

    // ── Nature ground ring — small cells (dense verts so the drape onto terrain stays smooth), kept to the
    //    annulus OUTSIDE the border and within apronR. To kill the repetitive-texture look, each cell is binned
    //    by TWO-SCALE value noise into one of several grass/earth SHADES (meadow / dry / dark / dirt), so the
    //    ground reads as varied country instead of one flat tiled green. Each shade is its own merged layer. ──
    const SHADES: [number, number, number][] = [
        [0.44, 0.56, 0.31],   // meadow green
        [0.50, 0.58, 0.34],   // pale dry grass
        [0.34, 0.47, 0.26],   // deep forest-floor green
        [0.52, 0.47, 0.30],   // dirt / dry earth
        [0.40, 0.54, 0.29],   // mid green
    ];
    const cell = R * 0.11, hc = cell * 0.5;
    const shadeQuads: V2[][][] = SHADES.map(() => []);
    const big = R * 0.55, small = R * 0.16;   // two noise scales → large patches broken by finer mottle
    const n = Math.ceil(apronR / cell);
    for (let ix = -n; ix <= n; ix++) {
        for (let iz = -n; iz <= n; iz++) {
            const cx = ix * cell, cz = iz * cell;
            const r = Math.hypot(cx, cz);
            if (r > apronR || r < R * 0.6) continue;        // ring only (skip the far corners + the city interior)
            if (inCity(cx, cz)) continue;                    // the city map owns everything inside the border
            const nb = hash2(Math.floor(cx / big), Math.floor(cz / big), (p.seed ^ 0x1f83) >>> 0);
            const ns = hash2(Math.floor(cx / small), Math.floor(cz / small), (p.seed ^ 0x77c5) >>> 0);
            const si = Math.min(SHADES.length - 1, Math.floor((nb * 0.7 + ns * 0.3) * SHADES.length));
            shadeQuads[si].push([[cx - hc, cz - hc], [cx + hc, cz - hc], [cx + hc, cz + hc], [cx - hc, cz + hc]]);
        }
    }

    // ── Scatter: forest CLUMPS (low-freq hash patches) with dense trees, sparse LONE trees in the open fields,
    //    and a few rocks. Deterministic; fades out near the far edge so the country dissolves, not cuts off. ──
    const foliage = new Accum3D(), trunk = new Accum3D(), rock = new Accum3D();
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
                const tr = makeRng((p.seed ^ (ix * 131 + iz * 17) ^ 0xa1) >>> 0);
                addTree(foliage, trunk, [x, gy, z], tr, scale * (inForest ? 1.0 : 0.85));
            } else if (hash2(ix * 5 + 1, iz * 11 + 2, (p.seed ^ 0x3d5c) >>> 0) < 0.02 * edgeFade) {
                addRock(rock, [x, gy, z], makeRng((p.seed ^ (ix * 91 + iz * 7)) >>> 0), scale);
            }
        }
    }

    const layers: LayoutPreviewLayer[] = [];
    // One layer per grass/earth shade; a subtle, per-shade-varied speckle adds micro-texture without an obvious tile.
    for (let si = 0; si < SHADES.length; si++) {
        const q = shadeQuads[si];
        if (!q.length) continue;
        const c = SHADES[si];
        layers.push({ name: `world:apron-ground-${si}`, color: c, y: gy, geometry: polysToGeometry(q, gy),
            pattern: { color: [c[0] * 0.72, c[1] * 0.78, c[2] * 0.68], freq: 22 + si * 9, scale: 0.45, angle: si * 0.7, mode: 'dots' }, excludeFromFrame: true });
    }
    // Foliage/trunks/rocks carry an 'apron-' name token so _addStaged does NOT bake their elevation — they LIFT
    // uniformly onto the terrain like the city's trees (base + canopy share x,z).
    if (!trunk.empty)   layers.push({ name: 'world:apron-trunks', color: TRUNK_COLOR, y: gy, geometry: trunk.geometry(), excludeFromFrame: true });
    if (!foliage.empty) layers.push({ name: 'world:apron-foliage', color: FOLIAGE_COLOR, y: gy, geometry: foliage.geometry(), pattern: { color: [0.20, 0.40, 0.19], freq: 7, scale: 0.55, mode: 'dots' }, excludeFromFrame: true });
    if (!rock.empty)    layers.push({ name: 'world:apron-rocks', color: ROCK_COLOR, y: gy, geometry: rock.geometry(), excludeFromFrame: true });
    return layers;
}
