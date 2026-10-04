// ── World generation — elevation ────────────────────────────────────────────────────────────────
// A gentle, deterministic terrain height field. Applied as a POST-transform over every layer's geometry
// (`applyHeightField`): flat map polygons DRAPE over the terrain (per-vertex), and rigid props (buildings,
// trees, poles) lift with their base — because a wall's base+top share the same (x,z), they rise together.
// Kept LOW-FREQUENCY so within one small building footprint the height barely changes (negligible warp);
// the whole city gets rolling hills / a raised side instead. On top of it: the discrete TERRACE levels (grid
// cities), road RAMPS between them, and the KERB — the pavement standing 15 cm above the carriageway.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutParams, Ramp, V2, Block, Intersection, Shotengai, RoadSegment } from './types';
import { valueNoise2D, pointInPolygon, bounds } from './util';
import { pavementIndex, streetBandHalf } from './street-layout';
import { TILE_SPEED } from './tile-speed';

export type { Ramp } from './types';

/** A terrain height function, plus optional metadata the ground tessellator and the drape use.
 *  · `grad`    — a SMOOTH gradient (writes dh/dx, dh/dz). Normals come from this rather than from finite
 *                differences of the function itself, which would crease at every lattice line and explode
 *                at a terrace step.
 *  · `lattice` — the function is exactly LINEAR inside each triangle of this lattice (cell `d`, origin `o`,
 *                diagonal from (i+1, j) to (i, j+1)). Ground split along those lines drapes with ZERO chord
 *                error, so a road, its paint and the pavement beside it stay exactly coplanar. */
export type HeightFn = ((x: number, z: number) => number) & {
    grad?: (x: number, z: number, out: [number, number]) => void;
    lattice?: { o: number; d: number };
};

/** Terrain height DELTA (± around 0), a pure function of world (x,z). `elevation` param scales the amplitude.
 *
 *  ★ PIECEWISE-LINEAR on a fixed triangle lattice (not bilinear). The exact signal is two value-noise octaves;
 *  it is sampled at lattice nodes and interpolated linearly per triangle. That makes the terrain something a
 *  mesh can represent EXACTLY: any ground polygon split along the lattice lines + diagonals (ground-mesh.ts)
 *  lies on the field at every point, not only at its vertices. Before, every big flat polygon (a pavement, a
 *  lot) drew a chord across the curved field, so pavements floated or sank by centimetres to decimetres on hills
 *  and the road poked through (city-quality S8).
 *
 *  The lattice is anchored at −1.3R with a fixed cell, and extends forever (nodes outside the precomputed core
 *  are evaluated on demand + memoised), so neighbour tiles and the apron sample the same continuous field.
 *
 *  `centre` (P10.B3, streamed flat / massing tiles): move the precomputed core onto that point, snapped to WHOLE
 *  lattice cells — the same nodes, the same triangles, the same heights (to float rounding); a far tile then reads
 *  its core array instead of the memo map for every vertex. Normals inside the core come from the node gradients
 *  (outside it from a one-cell central difference), so only use it where that difference does not matter. */
export function makeHeightField(params: LayoutParams, centre?: readonly [number, number]): HeightFn {
    const amp = (params.elevation ?? 0) * params.radius * 0.05;   // subtle rolling (was 0.18 = too dramatic)
    if (amp < 1e-4) {
        const f = (() => 0) as HeightFn;
        f.grad = (_x, _z, out) => { out[0] = 0; out[1] = 0; };
        return f;
    }
    const seed = ((params.terrainSeed ?? params.seed) ^ 0xe1e7a7) >>> 0;
    const f0 = 1 / (params.radius * 0.7);
    const exact = (x: number, z: number): number => {
        const h = 0.72 * valueNoise2D(x * f0, z * f0, seed) + 0.28 * valueNoise2D(x * f0 * 2.3, z * f0 * 2.3, seed + 7);
        return (h - 0.5) * 2 * amp;
    };
    // Core lattice over the city (cell ≈ 0.054·R — the ~0.3·R minor octave is sampled ~5×, so the linear
    // interpolant is visually faithful). The node values are exact; only BETWEEN nodes is it linear.
    const half = params.radius * 1.3, N = 48, d = (2 * half) / N, S = N + 1;
    const ox = -half + (centre ? Math.round(centre[0] / d) * d : 0), oz = -half + (centre ? Math.round(centre[1] / d) * d : 0);
    const o = -half;   // the published lattice anchor (fn.lattice): the core moved by whole cells, so the lines are the same
    const grid = new Float32Array(S * S);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) grid[j * S + i] = exact(ox + i * d, oz + j * d);
    // Out-of-core nodes (every streamed tile's vertices: the core sits on the centre city) are evaluated on demand and
    // kept. P22 nodeBlocks: in 32 × 32-node BLOCKS of doubles (NaN = not yet evaluated) behind a one-entry block
    // cache, instead of one Map entry per node — the same exact(…) values, so the same heights bit for bit, at a
    // fraction of the lookup cost (the Map was the drape's top self time). Bounded like the old map (~256 k nodes).
    const memo = new Map<number, number>();
    const blocks = new Map<number, Float64Array>();
    let lastKey = NaN, lastBlk: Float64Array | null = null;
    const node = (i: number, j: number): number => {
        if (i >= 0 && j >= 0 && i <= N && j <= N) return grid[j * S + i];
        if (TILE_SPEED.nodeBlocks) {
            const bi = i >> 5, bj = j >> 5, key = (bi + 0x8000) * 0x10000 + (bj + 0x8000);
            let blk = key === lastKey ? lastBlk : blocks.get(key);
            if (!blk) {
                if (blocks.size >= 250) blocks.clear();   // bounded: a long streaming session must not grow without limit
                blk = new Float64Array(1024).fill(NaN);
                blocks.set(key, blk);
            }
            lastKey = key; lastBlk = blk;
            const k = ((j & 31) << 5) | (i & 31);
            let v = blk[k];
            if (v !== v) blk[k] = v = exact(ox + i * d, oz + j * d);
            return v;
        }
        const key = (i + 0x8000) * 0x10000 + (j + 0x8000);
        let v = memo.get(key);
        if (v === undefined) {
            if (memo.size > 250000) memo.clear();   // bounded: a long streaming session must not grow without limit
            v = exact(ox + i * d, oz + j * d);
            memo.set(key, v);
        }
        return v;
    };
    const fn = ((x: number, z: number): number => {
        const gx = (x - ox) / d, gz = (z - oz) / d;
        const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
        if (fx + fz <= 1) {
            const h00 = node(i, j);
            return h00 + (node(i + 1, j) - h00) * fx + (node(i, j + 1) - h00) * fz;
        }
        const h11 = node(i + 1, j + 1);
        return h11 + (node(i, j + 1) - h11) * (1 - fx) + (node(i + 1, j) - h11) * (1 - fz);
    }) as HeightFn;
    // Smooth gradient for NORMALS: central differences at the lattice NODES, bilinearly interpolated — continuous
    // across triangle edges, so the hills shade round instead of faceted (S11), and as cheap as one height lookup
    // (it runs for every upward-facing draped vertex). Outside the core: a one-cell central difference.
    const gxN = new Float32Array(S * S), gzN = new Float32Array(S * S);
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(N, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(N, j + 1);
        gxN[j * S + i] = (grid[j * S + i1] - grid[j * S + i0]) / ((i1 - i0) * d);
        gzN[j * S + i] = (grid[j1 * S + i] - grid[j0 * S + i]) / ((j1 - j0) * d);
    }
    fn.grad = (x, z, out) => {
        const gx = (x - ox) / d, gz = (z - oz) / d;
        const i = Math.floor(gx), j = Math.floor(gz);
        if (i < 0 || j < 0 || i >= N || j >= N) {
            out[0] = (fn(x + d, z) - fn(x - d, z)) / (2 * d);
            out[1] = (fn(x, z + d) - fn(x, z - d)) / (2 * d);
            return;
        }
        const fx = gx - i, fz = gz - j, k = j * S + i;
        const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
        out[0] = gxN[k] * w00 + gxN[k + 1] * w10 + gxN[k + S] * w01 + gxN[k + S + 1] * w11;
        out[1] = gzN[k] * w00 + gzN[k + 1] * w10 + gzN[k + S] * w01 + gzN[k + S + 1] * w11;
    };
    fn.lattice = { o, d };
    return fn;
}

/** Add the terrain delta to every vertex's Y in-place, and SHEAR the normals to match (S11).
 *
 *  The drape is the map (x, y, z) → (x, y + h(x,z), z). Normals transform by the inverse-transpose of its
 *  Jacobian, which works out to n' ∝ (nx − hx·ny, ny, nz − hz·ny): a flat ground normal (0,1,0) tilts to the
 *  hill's true normal, a vertical wall normal (ny = 0) is untouched, and anything in between composes
 *  correctly. Without this every draped hill kept its +Y normal and was lit dead flat. The gradient comes from
 *  `fn.grad` when present (smooth, ignores terrace steps); a plain function falls back to a one-sided finite
 *  difference that picks the gentler side, so a vertex near a step never gets a sideways normal. */
export function applyHeightField(geo: MeshGeometry, fn: HeightFn | ((x: number, z: number) => number)): void {
    const v = geo.vertices;
    const grad = (fn as HeightFn).grad;
    const g: [number, number] = [0, 0], e = 0.01;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], z = v[i + 2], h = fn(x, z);
        v[i + 1] += h;
        const ny = v[i + 4];
        if (ny > -1e-4 && ny < 1e-4) continue;   // vertical faces: the shear leaves them unchanged
        if (grad) grad(x, z, g);
        else {
            const xp = (fn(x + e, z) - h) / e, xm = (h - fn(x - e, z)) / e;
            const zp = (fn(x, z + e) - h) / e, zm = (h - fn(x, z - e)) / e;
            g[0] = Math.abs(xp) < Math.abs(xm) ? xp : xm;
            g[1] = Math.abs(zp) < Math.abs(zm) ? zp : zm;
        }
        if (g[0] === 0 && g[1] === 0) continue;
        const nx = v[i + 3] - g[0] * ny, nz = v[i + 5] - g[1] * ny;
        const L = Math.hypot(nx, ny, nz) || 1;
        v[i + 3] = nx / L; v[i + 4] = ny / L; v[i + 5] = nz / L;
    }
}

// streetBandHalf — the carriageway + pavement half-width, the ONE street-edge constant (lot line = wall line =
// courtyard edge). Lives in street-layout.ts (which elevation imports) and is re-exported here for its callers.
export { streetBandHalf } from './street-layout';

/** The RAW discrete terrace level of every grid cell, from params alone (grid cities; all 0 with terraces off):
 *  a smooth-noise threshold → a few CONTIGUOUS raised patches (level 1 / 2). `gridLayout` builds its `levels` from
 *  this and then sinks the canal cells to −1; the railway reads it directly (it is params-pure) to keep its deck
 *  clear of raised terraces (railway-upgrade R3.1). Cells whose centre is outside the border stay 0. */
export function rawTerraceLevels(params: LayoutParams, border: V2[]): number[][] {
    const R = params.radius;
    const cols = Math.max(2, params.gridCols | 0), rows = Math.max(2, params.gridRows | 0);
    const cw = (2 * R) / cols, ch = (2 * R) / rows;
    const on = params.terraces ?? true;
    const tseed = (params.seed ^ 0x7e44ace) >>> 0;
    const levels: number[][] = [];
    for (let ci = 0; ci < cols; ci++) {
        levels[ci] = [];
        for (let ri = 0; ri < rows; ri++) {
            const inside = pointInPolygon([-R + ci * cw + cw * 0.5, -R + ri * ch + ch * 0.5], border);
            const nz = on && inside ? valueNoise2D(ci * 0.34, ri * 0.34, tseed) : 0;
            levels[ci][ri] = nz > 0.78 ? (nz > 0.92 ? 2 : 1) : 0;
        }
    }
    return levels;
}

/** The world height of one discrete terrace level. */
export function terraceStep(params: LayoutParams): number { return 0.16 * (params.radius / 10); }

/** Canal water surface Y (flat, pre-drape): 0.6 of a terrace step below the street — a real cut canal with a
 *  visible embankment above the waterline, not water lying on the trench floor. */
export function canalWaterY(params: LayoutParams): number { return params.groundY - 0.6 * terraceStep(params); }

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
    // ★ The JUNCTION box (both bands at once) takes the min of all FOUR cells, diagonal included. Without the
    // diagonal each quadrant of the box took the min of only three, so a junction with one low corner cell
    // stepped mid-box — a cliff inside the crossing that no wall or ramp could ever cover. Now the box is one
    // level (the lowest), and a road rising away from it gets its ramp from the mouth (computeRamps).
    if (fx < half && fz < half)                 lv = Math.min(lv, at(ci - 1, ri - 1));
    if (fx < half && fz > ch - half)            lv = Math.min(lv, at(ci - 1, ri + 1));
    if (fx > cw - half && fz < half)            lv = Math.min(lv, at(ci + 1, ri - 1));
    if (fx > cw - half && fz > ch - half)       lv = Math.min(lv, at(ci + 1, ri + 1));
    return lv;
}

// ── ROAD RAMPS — slope a carriageway between terrace levels so cars climb instead of falling off the cliff ──
//
// A road runs ALONG a cell boundary; inside the street band `cellLevelAt` pins it to the MIN of the two adjacent
// cells. That min still STEPS along the road wherever BOTH cells on one side of a junction rise a level. The step
// always lands at the junction MOUTH on the higher side: the junction box itself is in two street bands at once,
// so it takes the min of all four cells = the low level. `computeRamps` replaces each step with a sloped corridor
// that STARTS at that mouth (low end at the junction) and climbs mid-block, the full band wide (road + both
// pavements). The ramp is applied ONLY in the elevation (drape + car/prop height), never in `cellLevelAt`.
//
// (It used to be centred ON the junction: the corridor then crossed the junction box and the crossing road —
// a hump across the cross street, a wedge where the ramp met the flat box, and a diagonal seam where the
// junction's two ramps overlapped and the first one in the list won. S10.)

/** Knots of the ramp's grade profile. The grade eases in/out (smoothstep) so there is no crease at the foot or
 *  the brow, but it is PIECEWISE LINEAR between these knots so the ground tessellator can split at them and keep
 *  road, paint and pavement exactly coplanar on the slope. */
export const RAMP_KNOTS = 8;

const smoothstep = (u: number): number => u * u * (3 - 2 * u);

/** The ramp's fractional rise (0 at the foot → 1 at the brow) at normalised position u ∈ [0,1]. */
export function rampProfile(u: number): number {
    const c = u <= 0 ? 0 : u >= 1 ? 1 : u;
    const k = Math.min(RAMP_KNOTS - 1, Math.floor(c * RAMP_KNOTS)), t = c * RAMP_KNOTS - k;
    const s0 = smoothstep(k / RAMP_KNOTS), s1 = smoothstep((k + 1) / RAMP_KNOTS);
    return s0 + (s1 - s0) * t;
}

/** Slope of the profile (d rise / d u) at u — for the ramp's surface normal. */
export function rampProfileSlope(u: number): number {
    const c = u <= 0 ? 0 : u >= 1 ? 1 : u;
    const k = Math.min(RAMP_KNOTS - 1, Math.floor(c * RAMP_KNOTS));
    return (smoothstep((k + 1) / RAMP_KNOTS) - smoothstep(k / RAMP_KNOTS)) * RAMP_KNOTS;
}

/** Every place a grid road's (min-in-band) level steps → a ramp corridor from the junction mouth up the road. */
export function computeRamps(graph: WorldGraphLite): Ramp[] {
    const levels = graph.levels;
    if (!levels || graph.params.pattern !== 'grid' || !(graph.params.terraces ?? true)) return [];
    const p = graph.params, R = graph.radius, cols = p.gridCols, rows = p.gridRows;
    const cw = 2 * R / cols, ch = 2 * R / rows;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;
    const lv = (c: number, r: number): number => (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : (levels[c]?.[r] ?? 0);
    const band = streetBandHalf(p);
    // Which road segments actually exist (a removed segment has no carriageway to ramp). Without the road list
    // (a hand-built graph), assume the full grid.
    const has = new Set<string>();
    const roads = graph.roads;
    if (roads) for (const rd of roads) {
        const mx = (rd.a[0] + rd.b[0]) * 0.5, mz = (rd.a[1] + rd.b[1]) * 0.5;
        if (Math.abs(rd.a[0] - rd.b[0]) < 1e-6) has.add(`v${Math.round((mx + R) / cw)},${Math.floor((mz + R) / ch)}`);
        else if (Math.abs(rd.a[1] - rd.b[1]) < 1e-6) has.add(`h${Math.floor((mx + R) / cw)},${Math.round((mz + R) / ch)}`);
    }
    const segExists = (key: string): boolean => !roads || has.has(key);
    // Gentle grade, but never longer than the block face the ramp runs along.
    const want = Math.max(band * 2.4, R / 10);
    type Req = { seg: string; x: number; z: number; ax: number; az: number; lo: number; hi: number; avail: number };
    const reqs: Req[] = [];
    // Vertical roads (column boundary c) meeting junction row r: south segment (r-1) vs north segment (r).
    for (let c = 1; c < cols; c++) for (let r = 1; r < rows; r++) {
        const mA = Math.min(lv(c - 1, r - 1), lv(c, r - 1)), mB = Math.min(lv(c - 1, r), lv(c, r));
        if (mA === mB || mA < 0 || mB < 0) continue;
        const north = mB > mA, seg = north ? `v${c},${r}` : `v${c},${r - 1}`;
        if (!segExists(seg)) continue;
        reqs.push({ seg, x: x0(c), z: y0(r) + (north ? band : -band), ax: 0, az: north ? 1 : -1, lo: Math.min(mA, mB), hi: Math.max(mA, mB), avail: ch - 2 * band });
    }
    // Horizontal roads (row boundary r) meeting junction column c: west segment (c-1) vs east segment (c).
    for (let r = 1; r < rows; r++) for (let c = 1; c < cols; c++) {
        const mA = Math.min(lv(c - 1, r - 1), lv(c - 1, r)), mB = Math.min(lv(c, r - 1), lv(c, r));
        if (mA === mB || mA < 0 || mB < 0) continue;
        const east = mB > mA, seg = east ? `h${c},${r}` : `h${c - 1},${r}`;
        if (!segExists(seg)) continue;
        reqs.push({ seg, x: x0(c) + (east ? band : -band), z: y0(r), ax: east ? 1 : -1, az: 0, lo: Math.min(mA, mB), hi: Math.max(mA, mB), avail: cw - 2 * band });
    }
    // A segment higher than BOTH its junctions gets a ramp from each end — split its length between them.
    const perSeg = new Map<string, number>();
    for (const q of reqs) perSeg.set(q.seg, (perSeg.get(q.seg) ?? 0) + 1);
    const ramps: Ramp[] = [];
    for (const q of reqs) {
        const share = (perSeg.get(q.seg) ?? 1) > 1 ? 0.48 : 0.96;
        const len = Math.max(1e-3, Math.min(want, q.avail * share));
        // x,z = the corridor CENTRE (the foot is half a length back toward the junction).
        ramps.push({ x: q.x + q.ax * len * 0.5, z: q.z + q.az * len * 0.5, ax: q.ax, az: q.az, loLevel: q.lo, hiLevel: q.hi, len, halfWidth: band });
    }
    return ramps.slice(0, 96);
}

/** The ramp corridor containing (x,z), or null. */
export function rampAt(ramps: Ramp[] | null | undefined, x: number, z: number): Ramp | null {
    if (!ramps) return null;
    for (const rp of ramps) {
        const dx = x - rp.x, dz = z - rp.z;
        const along = dx * rp.ax + dz * rp.az;
        if (along < -rp.len * 0.5 || along > rp.len * 0.5) continue;
        if (Math.abs(dx * -rp.az + dz * rp.ax) > rp.halfWidth) continue;
        return rp;
    }
    return null;
}

/** The continuous level of ramp `rp` at (x,z) (clamped to its ends — callers decide containment). */
export function rampLevelOf(rp: Ramp, x: number, z: number): number {
    const along = (x - rp.x) * rp.ax + (z - rp.z) * rp.az;
    return rp.loLevel + (rp.hiLevel - rp.loLevel) * rampProfile(along / rp.len + 0.5);
}

/** The CONTINUOUS terrace level at a point if it lies inside a ramp corridor (loLevel..hiLevel, eased along the
 *  ramp), else null. Used by the elevation (drape + heights) and — via `inRamp` — by terraces + traffic. */
export function rampLevelAt(ramps: Ramp[] | null | undefined, x: number, z: number): number | null {
    const rp = rampAt(ramps, x, z);
    return rp ? rampLevelOf(rp, x, z) : null;
}

/** Whether a point sits in any ramp corridor (traffic: a run may cross the step here; terraces: no wall). */
export function inRamp(ramps: Ramp[] | null | undefined, x: number, z: number): boolean {
    return rampAt(ramps, x, z) !== null;
}

/** Everything ABOVE the smooth terrain at (x,z), in world units: the terrace level (or ramp) × step, plus the
 *  kerb lift on a raised pavement. The discrete half of `makeElevation`; retaining walls build from it. */
export function makeGroundLevel(graph: WorldGraphLite): (x: number, z: number) => number {
    const terr = !!graph.levels && (graph.params.terraces ?? true);
    const step = terraceStep(graph.params);
    const ramps = terr ? (graph.ramps ?? computeRamps(graph)) : [];
    const pave = graph.blocks && graph.border && graph.intersections
        ? pavementIndex({ params: graph.params, blocks: graph.blocks, border: graph.border, intersections: graph.intersections, shotengai: graph.shotengai ?? null, plaza: graph.plaza ?? null, levels: graph.levels })
        : null;
    const hasPave = !!pave && pave.polys.length > 0;
    if (!terr && !hasPave) return () => 0;
    return (x, z) => {
        const L = terr ? (rampLevelAt(ramps, x, z) ?? cellLevelAt(graph, x, z)) : 0;
        // A pavement sunk into a canal trench (level < 0) is excavated with it — no kerb down there.
        return L * step + (hasPave && L >= 0 ? pave!.lift(x, z) : 0);
    };
}

/** Full elevation = gentle smooth terrain + terrace step (ramps continuous) + kerb lift on pavements. Every
 *  full-tier layer drapes with this and cars / pedestrians / props sample it, so a pedestrian on the pavement
 *  stands on the pavement, not 15 cm inside it. Carries the smooth field's `grad` (normals) and `lattice`. */
export function makeElevation(graph: WorldGraphLite): HeightFn {
    const smooth = makeHeightField(graph.params);
    const level = makeGroundLevel(graph);
    const fn = ((x: number, z: number): number => smooth(x, z) + level(x, z)) as HeightFn;
    fn.grad = smooth.grad;
    fn.lattice = smooth.lattice;
    return fn;
}

/** The bits of WorldGraph these helpers need (avoids importing the whole type here). The block/border/crossing
 *  fields are optional so hand-built graphs still work — without them there is simply no kerb lift. */
export interface WorldGraphLite {
    params: LayoutParams; radius: number; levels: number[][] | null; ramps?: Ramp[];
    roads?: RoadSegment[]; blocks?: Block[]; border?: V2[]; intersections?: Intersection[];
    shotengai?: Shotengai | null; plaza?: V2[] | null;
}
interface WaterGraphLite extends WorldGraphLite { ponds: V2[][]; lots: { zone: string; poly: V2[] }[]; }

/** Build a reusable test: TRUE when (x,z) lies over ANY water body — a sunk canal cell (level < 0), a park POND, or
 *  a water-zoned LOT. Precomputes pond/lot AABBs so the common case (a point far from any water) is a cheap box
 *  reject. Use it to keep things OFF the water (pedestrians) and to place things that BELONG on it (ducks). Note:
 *  canals are excluded by cellLevelAt < 0, which resolves over the whole dilated street band (matches the water quad). */
export function makeWaterTest(graph: WaterGraphLite): (x: number, z: number) => boolean {
    const pondBB = graph.ponds.filter(p => p.length >= 3).map(poly => ({ poly, b: bounds(poly) }));
    // ★ SINGLE SOURCE with buildWater: water-zoned LOTS only count as water when the graph has NO canal cells
    // (mirrors buildWater's `!canalCells.length` gate, i.e. no cell at level < 0). Otherwise a graph carrying
    // both canals and a water lot would make that lot a no-walk hole here with no water disc drawn under it.
    // Canals (cellLevelAt < 0) + ponds are always water.
    const hasCanals = !!graph.levels && graph.levels.some(col => !!col && col.some(v => v < 0));
    const lotBB = hasCanals ? [] : graph.lots.filter(l => l.zone === 'water' && l.poly.length >= 3).map(l => ({ poly: l.poly, b: bounds(l.poly) }));
    return (x: number, z: number): boolean => {
        if (cellLevelAt(graph, x, z) < 0) return true;
        const pt: V2 = [x, z];
        for (const { poly, b } of pondBB) { if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue; if (pointInPolygon(pt, poly)) return true; }
        for (const { poly, b } of lotBB) { if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue; if (pointInPolygon(pt, poly)) return true; }
        return false;
    };
}
