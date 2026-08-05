// ── World generation — elevation ────────────────────────────────────────────────────────────────
// A gentle, deterministic terrain height field. Applied as a POST-transform over every layer's geometry
// (`applyHeightField`): flat map polygons DRAPE over the terrain (per-vertex), and rigid props (buildings,
// trees, poles) lift with their base — because a wall's base+top share the same (x,z), they rise together.
// Kept LOW-FREQUENCY so within one small building footprint the height barely changes (negligible warp);
// the whole city gets rolling hills / a raised side instead. Steeper terrain + per-building flat bases would
// be the follow-up. The deliberate canal lower-level + retaining walls + stairs also build on this later.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutParams, Ramp, V2 } from './types';
import { valueNoise2D, pointInPolygon, bounds } from './util';

export type { Ramp } from './types';

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

// ── ROAD RAMPS — slope a carriageway between terrace levels so cars climb instead of falling off the cliff ──
//
// A road runs ALONG a cell boundary; inside the street band `cellLevelAt` pins it to the MIN of the two adjacent
// cells (the test-enforced "a step never cuts a road"). But that min still STEPS along the road wherever BOTH
// adjacent cells rise a level — a hard vertical step in the carriageway with a retaining wall across it, which a
// car drives straight off. `computeRamps` finds every such step and replaces it with a sloped corridor; the ramp
// is applied ONLY inside `makeElevation` (the drape + car-height field), NOT in `cellLevelAt`, so the terrace
// test — and the discrete terraced look everywhere else — is untouched.

/** Every place a grid road's (min-in-band) level steps → a ramp corridor centred on that step. */
export function computeRamps(graph: WorldGraphLite): Ramp[] {
    const levels = graph.levels;
    if (!levels || graph.params.pattern !== 'grid' || !(graph.params.terraces ?? true)) return [];
    const p = graph.params, R = graph.radius, cols = p.gridCols, rows = p.gridRows;
    const cw = 2 * R / cols, ch = 2 * R / rows;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;
    const lv = (c: number, r: number): number => (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : (levels[c]?.[r] ?? 0);
    const halfWidth = streetBandHalf(p);
    // Ramp length: gentle grade, but never longer than a cell (so neighbouring ramps don't overlap into a mush).
    const len = Math.min(Math.min(cw, ch) * 0.9, Math.max(halfWidth * 2.4, R / 10));
    const ramps: Ramp[] = [];
    // Vertical roads (column boundary c) stepping between rows r-1 → r. Level along the road = min of the two
    // columns it separates; canal cells (level < 0) never ramp (they have bridges).
    for (let c = 1; c < cols; c++) for (let r = 1; r < rows; r++) {
        const mA = Math.min(lv(c - 1, r - 1), lv(c, r - 1)), mB = Math.min(lv(c - 1, r), lv(c, r));
        if (mA === mB || mA < 0 || mB < 0) continue;
        ramps.push({ x: x0(c), z: y0(r), ax: 0, az: mB > mA ? 1 : -1, loLevel: Math.min(mA, mB), hiLevel: Math.max(mA, mB), len, halfWidth });
    }
    // Horizontal roads (row boundary r) stepping between columns c-1 → c.
    for (let r = 1; r < rows; r++) for (let c = 1; c < cols; c++) {
        const mA = Math.min(lv(c - 1, r - 1), lv(c - 1, r)), mB = Math.min(lv(c, r - 1), lv(c, r));
        if (mA === mB || mA < 0 || mB < 0) continue;
        ramps.push({ x: x0(c), z: y0(r), ax: mB > mA ? 1 : -1, az: 0, loLevel: Math.min(mA, mB), hiLevel: Math.max(mA, mB), len, halfWidth });
    }
    return ramps.slice(0, 96);
}

/** The CONTINUOUS terrace level at a point if it lies inside a ramp corridor (loLevel..hiLevel, linear along the
 *  ramp), else null. Used by makeElevation (blend the drape) and — via `inRamp` — by terraces + traffic. */
export function rampLevelAt(ramps: Ramp[] | null | undefined, x: number, z: number): number | null {
    if (!ramps) return null;
    for (const rp of ramps) {
        const dx = x - rp.x, dz = z - rp.z;
        const along = dx * rp.ax + dz * rp.az;                 // signed distance up the ramp
        if (along < -rp.len * 0.5 || along > rp.len * 0.5) continue;
        const across = Math.abs(dx * -rp.az + dz * rp.ax);     // distance across the corridor
        if (across > rp.halfWidth) continue;
        const u = along / rp.len + 0.5;                        // 0 at the low end, 1 at the high end
        return rp.loLevel + (rp.hiLevel - rp.loLevel) * u;
    }
    return null;
}

/** Whether a point sits in any ramp corridor (traffic: a run may cross the step here; terraces: gap the wall). */
export function inRamp(ramps: Ramp[] | null | undefined, x: number, z: number): boolean {
    return rampLevelAt(ramps, x, z) !== null;
}

/** Full elevation = gentle smooth terrain + terrace step. Roads inside a ramp corridor slope CONTINUOUSLY between
 *  levels (so cars climb, not fall); everywhere else it's the discrete terrace level. Every layer drapes with this
 *  and the car-height field samples it, so the road surface AND the car follow the ramp for free. */
export function makeElevation(graph: WorldGraphLite): (x: number, z: number) => number {
    const smooth = makeHeightField(graph.params);
    if (!graph.levels || !(graph.params.terraces ?? true)) return smooth;
    const step = terraceStep(graph.params);
    const ramps = graph.ramps ?? computeRamps(graph);
    if (!ramps.length) return (x, z) => smooth(x, z) + cellLevelAt(graph, x, z) * step;
    return (x, z) => smooth(x, z) + (rampLevelAt(ramps, x, z) ?? cellLevelAt(graph, x, z)) * step;
}

/** The bits of WorldGraph these helpers need (avoids importing the whole type here). */
interface WorldGraphLite { params: LayoutParams; radius: number; levels: number[][] | null; ramps?: Ramp[]; }
interface WaterGraphLite extends WorldGraphLite { ponds: V2[][]; lots: { zone: string; poly: V2[] }[]; }

/** Build a reusable test: TRUE when (x,z) lies over ANY water body — a sunk canal cell (level < 0), a park POND, or
 *  a water-zoned LOT. Precomputes pond/lot AABBs so the common case (a point far from any water) is a cheap box
 *  reject. Use it to keep things OFF the water (pedestrians) and to place things that BELONG on it (ducks). Note:
 *  canals are excluded by cellLevelAt < 0, which resolves over the whole dilated street band (matches the water quad). */
export function makeWaterTest(graph: WaterGraphLite): (x: number, z: number) => boolean {
    const pondBB = graph.ponds.filter(p => p.length >= 3).map(poly => ({ poly, b: bounds(poly) }));
    const lotBB = graph.lots.filter(l => l.zone === 'water' && l.poly.length >= 3).map(l => ({ poly: l.poly, b: bounds(l.poly) }));
    return (x: number, z: number): boolean => {
        if (cellLevelAt(graph, x, z) < 0) return true;
        const pt: V2 = [x, z];
        for (const { poly, b } of pondBB) { if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue; if (pointInPolygon(pt, poly)) return true; }
        for (const { poly, b } of lotBB) { if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue; if (pointInPolygon(pt, poly)) return true; }
        return false;
    };
}
