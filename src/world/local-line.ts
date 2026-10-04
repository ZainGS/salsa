// ── World generation — the AT-GRADE LOCAL LINE: the pure LAYOUT half (railway-upgrade R3.2 / R3.3) ──────────────────
// An optional second railway at street level — a Tokyu Setagaya / Enoden style single-track private line through the
// blocks: its own fenced ballast corridor between the back-to-back lot strips, LEVEL CROSSINGS (fumikiri) where it
// meets a cross street, a small station at each end, and (when there is room) one gentle reverse curve that carries it
// from one block row to the next. Param `localLine` (default false → saved cities are unchanged), `localLineCars` 2–4.
//
// Everything is decided DETERMINISTICALLY inside the grid layout composer (layout.ts gridLayout), in three steps,
// because the line changes the layout itself:
//   1. planLocalLine   — BEFORE the terrace fix-ups: pick the row / run / curve / stations, and FLATTEN the terrace
//                        level of every cell the corridor touches (+ the cells round every junction node whose road it
//                        merges away), so the S9 passes re-add any road a level step now needs and the line is level.
//   2. applyLocalLineRoads — AFTER those passes, before the roads are emitted: merge the cells a station platform or the
//                        curve spans (remove the road segments between them — a platform never has a road through it,
//                        and the curve never crosses a row street diagonally: those junctions become pass-throughs).
//   3. carveLocalLineLots — after the lots: every lot over the corridor is split into the parts either side of it
//                        (conservative half-planes, ≥ 3 m deep, with a street edge) or dropped; blocks are tagged.
//   4. finishLocalLine — after the roads + intersections: the level crossings (road index, direction, skew).
//
// The line is layout space (x ascending) and WARPS with the city like the streets it crosses (the static layers are
// warped by the drape pass; the moving train follows the warped centreline — local-line-build.ts). It is a FUNCTION
// z(x): straight at a row's mid-line, with the optional S-curve z = zA + (zB−zA)·(1−cos πt)/2 over [xs, xs+L].
// It never crosses the elevated line's road (it ends in a buffer-stop terminus beside it — the interchange) and it
// keeps clear of the viaduct ARCADE strip. Radial cities have no local line.

import type { LayoutParams, V2, Lot, Block, WorldGraph } from './types';
import { cityMetresPerUnit } from './types';
import { hash2, polyArea, centroid, bounds, pointInPolygon } from './util';
import { streetBandHalf, streetDims } from './street-layout';
import { railwayLine, arcadeStrip } from './rail-layout';

/** Real dimensions (metres) of the local line. */
export const LOCAL_M = {
    carLen: 16, bodyLen: 15.6, width: 2.7,     // a short 16 m two-/three-car set (the EMU car scaled 0.8 × 0.93)
    gauge: 1.067,
    sleeperL: 2.0, sleeperW: 0.2, sleeperH: 0.14, sleeperPitch: 0.65,
    hw: 2.4,                                   // corridor half-width (fence line ≈ 2.25 m off the track centre)
    fence: 2.25, fenceH: 1.2,
    railTopAbovePave: 0.315,                   // sleeper on a thin ballast layer over the block paving + pad + rail
    ballastTop: 0.04,
    platEdge: 1.5, platW: 2.6, platAboveRail: 1.0, platBack: 4.55,
    bufferGap: 2.5,                            // buffer-stop end of the track from the next road's lot line
    contactAboveRail: 5.0,                     // same pantograph reach as the main line (the EMU pantograph)
    crossCore: 1.35,                           // crossing board half-width across the track
    ramp: 2.2,                                 // board ramp length along the road
    barrier: 3.0,                              // barrier arm pivot line from the track (along the road, / |sin skew|)
    stopLine: 1.2,                             // car stop line beyond the barrier
    walkWait: 0.5,                             // walkers wait this far outside the barrier
} as const;

export const LOCAL_CARS_DEFAULT = 2, LOCAL_CARS_MIN = 2, LOCAL_CARS_MAX = 4;

export interface LocalStationPlan {
    /** Layout x range of the platform (x0 < x1) and the consist-centre stop x. */
    x0: number; x1: number; xc: number;
    /** Platform side of the track (+1 = +z of the track, −1 = −z). */
    side: 1 | -1;
    /** Which terminus (0 = the low-x end, 1 = the high-x end). */
    end: 0 | 1;
}
export interface LocalCrossingPlan {
    id: number;
    /** Where the track centreline crosses the road centreline (layout). */
    x: number; z: number;
    /** Road index + unit road direction (road.a → road.b), track unit tangent, carriageway / street-band half widths. */
    ri: number; d: V2; t: V2; roadHalf: number; band: number;
}
export interface LocalLinePlan {
    row: number; row2: number;
    zA: number; zB: number;
    x0: number; x1: number;
    curve: { xs: number; L: number } | null;
    stations: LocalStationPlan[];
    crossings: LocalCrossingPlan[];
    /** Cells the corridor touches [ci, ri] (the blocks are tagged `localLine`). */
    cells: [number, number][];
    /** Road segments merged away: vertical [c, ri] (station platforms) and horizontal [ci, r] (the curve). */
    removedV: [number, number][]; removedH: [number, number][];
    cars: number;
    /** World units per metre. */
    u: number;
    /** Corridor half-width (units) off the platform side. */
    hw: number;
}

/** Consist length for a params set (`localLineCars`, 2..4, default 2). */
export function localLineCars(p: { localLineCars?: number }): number {
    return Math.max(LOCAL_CARS_MIN, Math.min(LOCAL_CARS_MAX, Math.round(p.localLineCars ?? LOCAL_CARS_DEFAULT)));
}

// ── Pure geometry of a plan ────────────────────────────────────────────────────────────────────────────────────────
const ease = (t: number): number => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t)))) / 2;

/** Corridor centreline z at layout x. */
export function localZAt(pl: Pick<LocalLinePlan, 'zA' | 'zB' | 'curve'>, x: number): number {
    if (!pl.curve) return pl.zA;
    return pl.zA + (pl.zB - pl.zA) * ease((x - pl.curve.xs) / pl.curve.L);
}
/** dz/dx of the centreline. */
export function localSlopeAt(pl: Pick<LocalLinePlan, 'zA' | 'zB' | 'curve'>, x: number): number {
    if (!pl.curve) return 0;
    const t = (x - pl.curve.xs) / pl.curve.L;
    if (t <= 0 || t >= 1) return 0;
    return (pl.zB - pl.zA) * Math.PI / (2 * pl.curve.L) * Math.sin(Math.PI * t);
}
/** Unit track tangent (layout, +x-ish) at x. */
export function localTangentAt(pl: Pick<LocalLinePlan, 'zA' | 'zB' | 'curve'>, x: number): V2 {
    const k = localSlopeAt(pl, x), l = Math.hypot(1, k);
    return [1 / l, k / l];
}
/** Corridor half-width on one side (+1 = +z) at x: the plain fenced corridor, wider on a station platform's side. */
export function localHalfWidth(pl: LocalLinePlan, x: number, side: 1 | -1): number {
    for (const st of pl.stations) if (st.side === side && x >= st.x0 - 0.5 * pl.u && x <= st.x1 + 0.5 * pl.u) return LOCAL_M.platBack * pl.u + 0.2 * pl.u;
    return pl.hw;
}
/** Is layout point (x, z) inside the corridor band (pad = extra margin, units)? */
export function inLocalCorridor(pl: LocalLinePlan, x: number, z: number, pad = 0): boolean {
    if (x < pl.x0 - pad || x > pl.x1 + pad) return false;
    const dz = z - localZAt(pl, x);
    const k = Math.hypot(1, localSlopeAt(pl, x));   // band widths are measured across the track, not along z
    return dz >= 0 ? dz <= (localHalfWidth(pl, x, 1) + pad) * k : -dz <= (localHalfWidth(pl, x, -1) + pad) * k;
}

/** Uniform samples of the centreline (x ascending, every `stepM` metres of x): layout points. */
export function localPathSamples(pl: LocalLinePlan, stepM = 1.5): { pts: V2[]; dx: number } {
    const n = Math.max(2, Math.ceil((pl.x1 - pl.x0) / (stepM * pl.u)));
    const dx = (pl.x1 - pl.x0) / n, pts: V2[] = [];
    for (let i = 0; i <= n; i++) { const x = pl.x0 + dx * i; pts.push([x, localZAt(pl, x)]); }
    return { pts, dx };
}

// ── 1) Planning (inside gridLayout) ────────────────────────────────────────────────────────────────────────────────
export interface LocalGridCtx {
    params: LayoutParams; R: number; cols: number; rows: number; cw: number; ch: number;
    hSeg: boolean[][]; vSeg: boolean[][]; levels: number[][]; canal: Set<string>; removed: number[][];
    cellInside(ci: number, ri: number): boolean;
}

/** Choose the line and flatten its cells (mutates ctx.levels). Null when off / not a grid / no room. */
export function planLocalLine(ctx: LocalGridCtx): LocalLinePlan | null {
    const p = ctx.params;
    if (!p.localLine || p.pattern !== 'grid') return null;
    const { R, cols, rows, cw, ch } = ctx;
    if (cols < 5 || rows < 4) return null;
    const u = 1 / cityMetresPerUnit(R), band = streetBandHalf(p);
    const cars = localLineCars(p), P = (cars * LOCAL_M.carLen + 3) * u;   // platform length
    const x0c = (c: number): number => -R + c * cw, zmid = (r: number): number => -R + (r + 0.5) * ch;
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    const valid = (c: number, r: number): boolean => c >= 0 && c < cols && r >= 0 && r < rows && ctx.cellInside(c, r) && !ctx.canal.has(c + ',' + r);

    // The elevated line's road (+ the arcade strip beside it) is a wall the local line ends against.
    let avoid: [number, number] | null = null;
    if ((p.railway ?? true)) {
        const line = railwayLine(p) as ReturnType<typeof railwayLine> & { roadX?: number };
        const rxRoad = line.roadX ?? line.rx;
        avoid = [rxRoad - band, rxRoad + band];
        const st = arcadeStrip(p);
        if (st) avoid = [Math.min(avoid[0], st.lo), Math.max(avoid[1], st.hi)];
    }
    const gap = LOCAL_M.bufferGap * u;

    type Cand = { plan: LocalLinePlan; score: number; flat: Set<string> };
    let best: Cand | null = null;
    for (let r = 1; r < rows - 1; r++) {
        // Runs of valid cells in this row, then split by the viaduct wall. Each piece ends in a buffer stop before the
        // road (or the wall) beyond its end cells.
        const runs: [number, number][] = [];
        let a = -1;
        for (let c = 0; c <= cols; c++) {
            if (c < cols && valid(c, r)) { if (a < 0) a = c; continue; }
            if (a >= 0) runs.push([a, c - 1]);
            a = -1;
        }
        const pieces: [number, number][] = [];   // [xLo, xHi]
        for (const [lo, hi] of runs) {
            const xa = x0c(lo) + band + gap, xb = x0c(hi + 1) - band - gap;
            if (!avoid || x0c(hi + 1) <= avoid[0] || x0c(lo) >= avoid[1]) { pieces.push([xa, xb]); continue; }
            if (avoid[0] - gap > xa) pieces.push([xa, Math.min(xb, avoid[0] - gap)]);
            if (avoid[1] + gap < xb) pieces.push([Math.max(xa, avoid[1] + gap), xb]);
        }
        for (const [xLo, xHi] of pieces) {
            const cLo = Math.floor((xLo + R) / cw), cHi = Math.floor((xHi + R) / cw);
            if (xHi - xLo < P + 30 * u) continue;
            const nearWall = (x: number): boolean => !!avoid && Math.abs(x - (x < avoid[0] ? avoid[0] : avoid[1])) < 8 * u;
            const hs = H(r, cLo * 31 + cHi, 0x10ca1);
            // Candidate configurations, best first: two termini stations + a curve, one station + curve, two stations, one.
            const cfgs: { twoSt: boolean; curve: boolean }[] = [
                { twoSt: true, curve: true }, { twoSt: false, curve: true }, { twoSt: true, curve: false }, { twoSt: false, curve: false },
            ];
            for (const cfg of cfgs) {
                const plan = tryConfig(ctx, r, xLo, xHi, P, cfg, hs, nearWall, u, band, cars);
                if (!plan) continue;
                const len = plan.plan.x1 - plan.plan.x0;
                const score = (cfg.twoSt ? 2000 : 0) + (cfg.curve ? 3000 : 0) + len / u + hs * 10 - Math.abs(r - rows / 2) * 3;
                if (!best || score > best.score) best = { plan: plan.plan, score, flat: plan.flat };
                break;
            }
        }
    }
    if (!best) return null;
    for (const k of best.flat) { const [c, r] = k.split(',').map(Number); if (ctx.levels[c]) ctx.levels[c][r] = 0; }
    return best.plan;

    function tryConfig(C: LocalGridCtx, r: number, xLo: number, xHi: number, Pl: number, cfg: { twoSt: boolean; curve: boolean },
        hs: number, nearWall: (x: number) => boolean, uu: number, bandH: number, nCars: number): { plan: LocalLinePlan; flat: Set<string> } | null {
        // Stations at the termini: the wall end (the interchange) first when there is only one.
        const ends: (0 | 1)[] = cfg.twoSt ? [0, 1] : [nearWall(xLo) ? 0 : nearWall(xHi) ? 1 : (hs < 0.5 ? 0 : 1)];
        const stations: LocalStationPlan[] = [];
        for (const e of ends) {
            const side: 1 | -1 = H(r * 7 + e, Math.round(xLo * 100), 0x57a7) < 0.5 ? 1 : -1;
            const half = nCars * LOCAL_M.carLen * uu / 2;
            if (e === 0) stations.push({ x0: xLo + 0.3 * uu, x1: xLo + Pl, xc: xLo + 1.0 * uu + half, side, end: 0 });
            else stations.push({ x0: xHi - Pl, x1: xHi - 0.3 * uu, xc: xHi - 1.0 * uu - half, side, end: 1 });
        }
        const stLo = stations.find(s => s.end === 0), stHi = stations.find(s => s.end === 1);
        const freeA = (stLo ? stLo.x1 : xLo) + 3 * uu, freeB = (stHi ? stHi.x0 : xHi) - 3 * uu;
        if (freeB - freeA < 8 * uu) return null;
        let curve: { xs: number; L: number } | null = null, r2 = r;
        if (cfg.curve) {
            const L = Math.min(3 * C.cw, freeB - freeA);
            if (L < 2.3 * C.cw) return null;
            const pref: (1 | -1)[] = hs < 0.5 ? [1, -1] : [-1, 1];
            let ok = false;
            for (const dr of pref) {
                const rr = r + dr;
                if (rr < 1 || rr > C.rows - 2) continue;
                curve = { xs: freeA + (freeB - freeA - L) * 0.5, L }; r2 = rr; ok = true; break;
            }
            if (!ok) return null;
        }
        const zA = zmid(r), zB = zmid(r2);
        const plan: LocalLinePlan = {
            row: r, row2: r2, zA, zB, x0: xLo, x1: xHi, curve, stations, crossings: [], cells: [], removedV: [], removedH: [],
            cars: nCars, u: uu, hw: LOCAL_M.hw * uu,
        };
        // Walk the corridor: cells touched, merges needed, crossing roads near junction nodes.
        const flat = new Set<string>(), cells = new Set<string>();
        const needH = new Set<string>(), needV = new Set<string>();
        const bLine = Math.max(r, r2);   // the row boundary index the curve crosses (y0(bLine))
        const yB = -C.R + bLine * C.ch;
        const lotHalf = C.ch / 2 - bandH;                // lot region half-depth in a plain row
        const steps = Math.ceil((xHi - xLo) / (0.5 * uu));
        for (let i = 0; i <= steps; i++) {
            const x = xLo + (xHi - xLo) * i / steps, zc = localZAt(plan, x);
            const c = Math.floor((x + C.R) / C.cw);
            const hwU = localHalfWidth(plan, x, 1) * Math.hypot(1, localSlopeAt(plan, x)), hwD = localHalfWidth(plan, x, -1) * Math.hypot(1, localSlopeAt(plan, x));
            for (const z of [zc - hwD, zc, zc + hwU]) {
                const rr = Math.floor((z + C.R) / C.ch);
                if (!valid(c, rr)) return null;
                cells.add(c + ',' + rr);
            }
            // Leaving a row's lot region toward the curve's boundary → the two cells must be merged there.
            if (curve && (zc + hwU > yB - bandH - 0.3 * uu && zc - hwD < yB + bandH + 0.3 * uu)) needH.add(c + ',' + bLine);
            // Plain row: the band must stay inside the lot region (else the row is too shallow for the line).
            if (!curve || x < curve.xs || x > curve.xs + curve.L) {
                const rr = Math.floor((zc + C.R) / C.ch), mid = zmid(rr);
                if (zc + hwU > mid + lotHalf - 2.5 * uu || zc - hwD < mid - lotHalf + 2.5 * uu) return null;
            }
        }
        // Stations: every vertical road whose street band overlaps a platform (+ margin) is merged away.
        for (const st of stations) {
            for (let c = 1; c < C.cols; c++) {
                const xr = x0c(c);
                if (xr + bandH > st.x0 - 1.5 * uu && xr - bandH < st.x1 + 1.5 * uu) {
                    const rr = Math.floor((localZAt(plan, xr) + C.R) / C.ch);
                    needV.add(c + ',' + rr);
                }
            }
        }
        // Crossings on the curve near a boundary node: make that node a pass-through (merge both sides).
        if (curve) {
            const D = streetDims(C.params), clear = D.cwStart + D.cwDepth + (LOCAL_M.barrier + LOCAL_M.stopLine + 0.5) * uu;
            for (let c = 1; c < C.cols; c++) {
                const xr = x0c(c);
                if (xr < curve.xs || xr > curve.xs + curve.L) continue;
                const zc = localZAt(plan, xr);
                if (Math.abs(zc - yB) < clear) { needH.add((c - 1) + ',' + bLine); needH.add(c + ',' + bLine); }
            }
        }
        // Merges must not hit a crossing we rely on, and each merged cell keeps ≥ 1 road.
        const rem = C.removed.map(col => col.slice());
        for (const k of needV) {
            const [c, rr] = k.split(',').map(Number);
            if (!C.vSeg[c]?.[rr]) continue;
            rem[c - 1][rr]++; rem[c][rr]++;
        }
        for (const k of needH) {
            const [c, b] = k.split(',').map(Number);
            if (c < 0 || c >= C.cols || !C.hSeg[c]?.[b]) continue;
            rem[c][b - 1]++; rem[c][b]++;
        }
        for (const k of [...needV, ...needH]) {
            const [c, rr] = k.split(',').map(Number);
            for (const [ci, ri] of [[c - 1, rr], [c, rr], [c, rr - 1]]) if (rem[ci]?.[ri] !== undefined && rem[ci][ri] > 3) return null;
        }
        // Flatten: the touched cells + the 4 cells round both end nodes of every merged segment.
        for (const k of cells) flat.add(k);
        const node = (c: number, rr: number): boolean => {
            for (const [ci, ri] of [[c - 1, rr - 1], [c, rr - 1], [c - 1, rr], [c, rr]]) {
                if (ci < 0 || ci >= C.cols || ri < 0 || ri >= C.rows) continue;
                if (C.canal.has(ci + ',' + ri)) return false;
                flat.add(ci + ',' + ri);
            }
            return true;
        };
        for (const k of needV) { const [c, rr] = k.split(',').map(Number); if (!node(c, rr) || !node(c, rr + 1)) return null; }
        for (const k of needH) { const [c, b] = k.split(',').map(Number); if (!node(c, b) || !node(c + 1, b)) return null; }
        plan.cells = [...cells].map(k => k.split(',').map(Number) as [number, number]).sort((a2, b2) => a2[0] - b2[0] || a2[1] - b2[1]);
        plan.removedV = [...needV].map(k => k.split(',').map(Number) as [number, number]).sort((a2, b2) => a2[0] - b2[0] || a2[1] - b2[1]);
        plan.removedH = [...needH].map(k => k.split(',').map(Number) as [number, number]).filter(([c]) => c >= 0 && c < C.cols).sort((a2, b2) => a2[0] - b2[0] || a2[1] - b2[1]);
        return { plan, flat };
    }
}

// ── 2) Road merges (after the terrace fix-ups) ─────────────────────────────────────────────────────────────────────
export function applyLocalLineRoads(pl: LocalLinePlan, ctx: LocalGridCtx): void {
    for (const [c, r] of pl.removedV) if (ctx.vSeg[c]?.[r]) { ctx.vSeg[c][r] = false; ctx.removed[c - 1][r]++; ctx.removed[c][r]++; }
    for (const [c, b] of pl.removedH) if (ctx.hSeg[c]?.[b]) { ctx.hSeg[c][b] = false; ctx.removed[c][b - 1]++; ctx.removed[c][b]++; }
}

// ── 3) Lot carving ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Keep the part of a convex polygon LEFT of a→b. */
function clipHalf(poly: V2[], a: V2, b: V2): V2[] {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const side = (q: V2): number => dx * (q[1] - a[1]) - dz * (q[0] - a[0]);
    const out: V2[] = [];
    for (let i = 0; i < poly.length; i++) {
        const P0 = poly[i], P1 = poly[(i + 1) % poly.length], s0 = side(P0), s1 = side(P1);
        if (s0 >= 0) out.push(P0);
        if ((s0 >= 0) !== (s1 >= 0)) { const t = s0 / (s0 - s1); out.push([P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t]); }
    }
    return out;
}

/** Split every lot over the corridor into the parts either side of it (or drop it). Mutates lots + blocks. */
export function carveLocalLineLots(pl: LocalLinePlan, lots: Lot[], blocks: Block[]): Lot[] {
    const u = pl.u, setback = 0.4 * u, minDepth = 3 * u;
    const edge = (x: number, side: 1 | -1): number => localZAt(pl, x) + side * localHalfWidth(pl, x, side) * Math.hypot(1, localSlopeAt(pl, x));
    const out: Lot[] = [];
    const touched = new Set<number>();
    const replaced = new Map<string, string[]>();
    for (const lot of lots) {
        if (lot.poly.length < 3) { out.push(lot); continue; }
        const b = bounds(lot.poly);
        if (b.max[0] <= pl.x0 - 0.5 * u || b.min[0] >= pl.x1 + 0.5 * u) { out.push(lot); continue; }
        const xa = Math.max(b.min[0], pl.x0 - 0.5 * u), xb = Math.min(b.max[0], pl.x1 + 0.5 * u);
        // Conservative cut lines over the lot's x-range: a chord of each band edge, pushed out past the curve's bulge.
        const N = 12;
        let hiMax = -Infinity, loMin = Infinity;
        for (let i = 0; i <= N; i++) { const x = xa + (xb - xa) * i / N; hiMax = Math.max(hiMax, edge(x, 1)); loMin = Math.min(loMin, edge(x, -1)); }
        if (b.min[1] >= hiMax + setback || b.max[1] <= loMin - setback) { out.push(lot); continue; }
        // AXIS-ALIGNED cut lines (the grid lots are rectangles and the building generator fits rectangles to them — a
        // sloped cut on the curve would leave a footprint corner over the track): z past the band edge's extreme over
        // the lot's x-range, + a setback. On the curve that costs some lot depth; a piece too shallow is dropped.
        const line = (side: 1 | -1): [V2, V2] => {
            const zc = side > 0 ? hiMax + setback : loMin - setback;
            return [[xa - 1, zc], [xb + 1, zc]];
        };
        touched.add(lot.block);
        const pieces: Lot[] = [];
        for (const side of [1, -1] as const) {
            const [A, B] = line(side);
            const rem = side > 0 ? clipHalf(lot.poly, A, B) : clipHalf(lot.poly, B, A);
            if (rem.length < 3) continue;
            const area = polyArea(rem);
            // depth off the cut line
            const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1;
            let depth = 0; for (const q of rem) depth = Math.max(depth, Math.abs(dx * (q[1] - A[1]) - dz * (q[0] - A[0])) / L);
            if (area < (3 * u) * (4 * u) || depth < minDepth) continue;
            const lines = (lot.streetEdges ?? []).map(i => [lot.poly[i], lot.poly[(i + 1) % lot.poly.length]] as [V2, V2]);
            const onLine = (a: V2, c: V2): boolean => lines.some(([q0, q1]) => {
                const ex = q1[0] - q0[0], ez = q1[1] - q0[1], EL = Math.hypot(ex, ez) || 1;
                const d = (q: V2): number => Math.abs((q[0] - q0[0]) * ez - (q[1] - q0[1]) * ex) / EL;
                return d(a) < 1e-5 && d(c) < 1e-5;
            });
            const streetEdges = rem.map((_, i) => i).filter(i => onLine(rem[i], rem[(i + 1) % rem.length]));
            if (lot.streetEdges && !streetEdges.length) continue;   // a piece with no street frontage can't host a building door
            pieces.push({ ...lot, id: lot.id + (side > 0 ? 'n' : 's'), poly: rem, center: centroid(rem), area, streetEdges: lot.streetEdges ? streetEdges : undefined });
        }
        replaced.set(lot.id, pieces.map(q => q.id));
        out.push(...pieces);
    }
    for (const bl of blocks) {
        if (!bl.lots.some(id => replaced.has(id))) continue;
        bl.lots = bl.lots.flatMap(id => replaced.get(id) ?? [id]);
    }
    for (const bl of blocks) if (touched.has(bl.id) || pl.cells.some(([c, r]) => c === bl.sector && r === bl.ring)) bl.localLine = true;
    return out;
}

// ── 4) Level crossings (after roads + intersections) ───────────────────────────────────────────────────────────────
export function finishLocalLine(pl: LocalLinePlan, graph: Pick<WorldGraph, 'roads' | 'params'>): void {
    const p = graph.params, band = streetBandHalf(p);
    const xs: LocalCrossingPlan[] = [];
    graph.roads.forEach((r, ri) => {
        if (r.klass === 'alley') return;
        const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        // The line is a function z(x): bisect along the road for the sign change of z − zc(x).
        const f = (t: number): number => { const x = r.a[0] + dx * t, z = r.a[1] + dz * t; return (x < pl.x0 || x > pl.x1) ? NaN : z - localZAt(pl, x); };
        const N = 24;
        let prevT = 0, prev = f(0);
        for (let i = 1; i <= N; i++) {
            const t = i / N, v = f(t);
            if (Number.isFinite(prev) && Number.isFinite(v) && (prev === 0 || prev * v < 0)) {
                let lo = prevT, hi = t, flo = prev;
                for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2, fm = f(m); if (!Number.isFinite(fm)) break; if (flo * fm <= 0) hi = m; else { lo = m; flo = fm; } }
                const tt = (lo + hi) / 2, x = r.a[0] + dx * tt, z = r.a[1] + dz * tt;
                if (!xs.some(q => Math.hypot(q.x - x, q.z - z) < 1e-4)) {
                    const cw = r.klass === 'arterial' ? (p.arterialWidth ?? p.streetWidth) : p.streetWidth;
                    xs.push({ id: 0, x, z, ri, d: [dx / len, dz / len], t: localTangentAt(pl, x), roadHalf: cw * 0.5, band });
                }
            }
            prevT = t; prev = v;
        }
    });
    xs.sort((a, b) => a.x - b.x);
    xs.forEach((q, i) => { q.id = i; });
    pl.crossings = xs;
}

/** Shift a plan by (dx, dz) — tiled worlds offset a tile's whole graph into world coordinates. */
export function offsetLocalLine(pl: LocalLinePlan, dx: number, dz: number): void {
    pl.x0 += dx; pl.x1 += dx; pl.zA += dz; pl.zB += dz;
    if (pl.curve) pl.curve.xs += dx;
    for (const st of pl.stations) { st.x0 += dx; st.x1 += dx; st.xc += dx; }
    for (const q of pl.crossings) { q.x += dx; q.z += dz; }
}

// ── Crossing frame helpers (shared by the builder, the traffic ticker and route checks) ───────────────────────────
/** A crossing's local frame for a layout point: `u` = distance ALONG THE ROAD from the track centreline (signed, +
 *  toward road.b), `w` = distance ACROSS the road from its centreline. */
export function crossingFrame(q: LocalCrossingPlan, x: number, z: number, out: { u: number; w: number }): void {
    const vx = x - q.x, vz = z - q.z;
    // point = C + t·T + u·d  →  u = cross(T, v) / cross(T, d)
    const cr = q.t[0] * q.d[1] - q.t[1] * q.d[0];
    const k = Math.abs(cr) < 0.2 ? (cr < 0 ? -0.2 : 0.2) : cr;
    out.u = (q.t[0] * vz - q.t[1] * vx) / k;
    out.w = vx * -q.d[1] + vz * q.d[0];
}
/** |sin| of the crossing angle (1 = square crossing). */
export function crossingSin(q: LocalCrossingPlan): number {
    return Math.max(0.2, Math.abs(q.t[0] * q.d[1] - q.t[1] * q.d[0]));
}

/** The graph's local line (null when off). */
export function localLineOf(graph: { localLine?: LocalLinePlan | null }): LocalLinePlan | null {
    return graph.localLine ?? null;
}

/** Nothing in the corridor test for other composers: a layout point inside the corridor (or on a crossing's boards). */
export function localLineBlocks(graph: { localLine?: LocalLinePlan | null; border?: V2[] }, x: number, z: number, pad = 0): boolean {
    const pl = graph.localLine;
    if (!pl) return false;
    if (graph.border && graph.border.length >= 3 && !pointInPolygon([x, z], graph.border)) return false;
    return inLocalCorridor(pl, x, z, pad);
}

/** Is a layout point on a level crossing's stretch of road (the boards, the barriers, the stop lines + `padM` metres)?
 *  Street props placed outside the shared street plan (the arterial lamp posts) keep off it. */
export function inCrossingZone(pl: LocalLinePlan | null | undefined, x: number, z: number, padM = 1): boolean {
    if (!pl) return false;
    const F = { u: 0, w: 0 };
    for (const q of pl.crossings) {
        if (Math.abs(x - q.x) > q.band * 6 || Math.abs(z - q.z) > q.band * 6) continue;
        crossingFrame(q, x, z, F);
        if (Math.abs(F.w) > q.band + 0.3 * pl.u) continue;
        if (Math.abs(F.u) <= (LOCAL_M.barrier + LOCAL_M.stopLine + padM) * pl.u / crossingSin(q)) return true;
    }
    return false;
}
