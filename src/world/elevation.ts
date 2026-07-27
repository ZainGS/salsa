// ── World generation — elevation ────────────────────────────────────────────────────────────────
// A gentle, deterministic terrain height field. Applied as a POST-transform over every layer's geometry
// (`applyHeightField`): flat map polygons DRAPE over the terrain (per-vertex), and rigid props (buildings,
// trees, poles) lift with their base — because a wall's base+top share the same (x,z), they rise together.
// Kept LOW-FREQUENCY so within one small building footprint the height barely changes (negligible warp);
// the whole city gets rolling hills / a raised side instead. Steeper terrain + per-building flat bases would
// be the follow-up. The deliberate canal lower-level + retaining walls + stairs also build on this later.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutParams } from './types';
import { valueNoise2D } from './util';

/** Terrain height DELTA (± around 0), a pure function of world (x,z). `elevation` param scales the amplitude. */
export function makeHeightField(params: LayoutParams): (x: number, z: number) => number {
    const amp = (params.elevation ?? 0) * params.radius * 0.05;   // subtle rolling (was 0.18 = too dramatic)
    if (amp < 1e-4) return () => 0;
    const seed = (params.seed ^ 0xe1e7a7) >>> 0;
    const f0 = 1 / (params.radius * 0.7);
    return (x, z) => {
        const h = 0.72 * valueNoise2D(x * f0, z * f0, seed) + 0.28 * valueNoise2D(x * f0 * 2.3, z * f0 * 2.3, seed + 7);
        return (h - 0.5) * 2 * amp;
    };
}

/** Add the terrain delta to every vertex's Y in-place. */
export function applyHeightField(geo: MeshGeometry, fn: (x: number, z: number) => number): void {
    const v = geo.vertices;
    for (let i = 0; i < v.length; i += 12) v[i + 1] += fn(v[i], v[i + 2]);
}

/**
 * Half-width of the band a level change must NOT cut through: the carriageway PLUS the pavement.
 *
 * ★ This is the rule "a terrace step never divides a street". Blocks are the grid cell inset by
 * streetWidth/2 (that inset gap is the road), and lots are inset a further `alley/2` inside the block
 * (that ring is the pavement). So the first place a step can legitimately happen is the LOT LINE — the
 * building frontage. Keeping road + pavement at the lower level is what makes a staircase read as
 * "steps from the pavement up to buildings on a raised section" instead of a flight dumped in a road.
 *
 * `alley` is `streetWidth * 0.62` in layout.ts, so the pavement ring is `streetWidth * 0.31`.
 */
export function streetBandHalf(params: LayoutParams): number {
    return Math.max(params.streetWidth, params.arterialWidth ?? 0) * 0.5 + params.streetWidth * 0.31;
}

/** The world height of one discrete terrace level. */
export function terraceStep(params: LayoutParams): number { return 0.16 * (params.radius / 10); }

/** The discrete terrace level at a world point (grid cell lookup; 0 for radial / no-terraces).
 *
 *  ★ A LEVEL CHANGE MUST NEVER CUT A ROAD — OR A PAVEMENT. Streets are the gaps BETWEEN lots, i.e. they
 *  straddle the grid cell boundaries, so a raw per-cell lookup steps the ground up along the middle of a
 *  carriageway and `terraces.ts` then builds a retaining wall + staircase straight across the road. Inside
 *  the street band (road + pavement, see `streetBandHalf`) we take the MIN of the cells sharing it: road and
 *  pavement stay flat and continuous at the lower level, and the step moves back to the LOT LINE, so stairs
 *  climb from the pavement up to the buildings on the raised section. */
export function cellLevelAt(graph: WorldGraphLite, x: number, z: number): number {
    const levels = graph.levels; if (!levels) return 0;
    const R = graph.radius, cols = graph.params.gridCols, rows = graph.params.gridRows;
    const cw = 2 * R / cols, ch = 2 * R / rows;
    const ci = Math.floor((x + R) / cw), ri = Math.floor((z + R) / ch);
    if (ci < 0 || ci >= cols || ri < 0 || ri >= rows) return 0;
    const at = (c: number, r: number): number =>
        (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : (levels[c]?.[r] ?? 0);
    let lv = at(ci, ri);
    const half = streetBandHalf(graph.params);   // carriageway + pavement — see the note there
    const fx = (x + R) - ci * cw, fz = (z + R) - ri * ch;      // position within the cell
    if (fx < half)      lv = Math.min(lv, at(ci - 1, ri));
    if (fx > cw - half) lv = Math.min(lv, at(ci + 1, ri));
    if (fz < half)      lv = Math.min(lv, at(ci, ri - 1));
    if (fz > ch - half) lv = Math.min(lv, at(ci, ri + 1));
    return lv;
}

/** Full elevation = gentle smooth terrain + discrete terrace step. Every layer post-transforms with this. */
export function makeElevation(graph: WorldGraphLite): (x: number, z: number) => number {
    const smooth = makeHeightField(graph.params);
    if (!graph.levels || !(graph.params.terraces ?? true)) return smooth;
    const step = terraceStep(graph.params);
    return (x, z) => smooth(x, z) + cellLevelAt(graph, x, z) * step;
}

/** The bits of WorldGraph these helpers need (avoids importing the whole type here). */
interface WorldGraphLite { params: LayoutParams; radius: number; levels: number[][] | null; }
