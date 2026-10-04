// ── World generation — LATTICE-EXACT ground tessellation ─────────────────────────────────────────
// Every ground surface in the city (road, pavement, lots, plaza, canal water) and every overlay laid on one
// (road paint, tactile paving, kerb-top strips, gutters) is split here into pieces that each lie inside ONE
// triangle of the terrain lattice and ONE region of constant terrace level / kerb state. Two consequences:
//
//   · The smooth terrain is linear inside each lattice triangle (elevation.makeHeightField), so the per-vertex
//     drape puts every piece EXACTLY on the field — no chord across the curve. A pavement and the road under it,
//     or paint and the asphalt, are coplanar to float precision, so their tiny stacking offsets are real (S2, S8).
//   · Terrace levels, ramps and the kerb are baked per piece, split exactly on their boundaries, so there is no
//     sloped wedge where a level changes (the old 4×-refined road grid carried a level PER VERTEX, which smeared
//     every step into a ~0.1-unit asphalt ramp at the wall foot — S7).
//
// Layers built with `emitGround` bake levels + kerb into Y and must drape on the SMOOTH field only
// (`drape: 'smooth'`); the drape pass then adds the terrain and shears the normals (applyHeightField).
// Pure, deterministic, worker-safe.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import type { WorldGraph, V2, Ramp } from './types';
import {
    makeHeightField, cellLevelAt, terraceStep, streetBandHalf, computeRamps, rampAt, rampLevelOf, rampProfileSlope, RAMP_KNOTS,
} from './elevation';
import { pavementIndex, streetDims, dropLift, type PavementIndex, type StreetDims, type DropZone } from './street-layout';
import { clipConvex, triangulate, signedArea } from './util';

type GraphLike = Pick<WorldGraph, 'params' | 'radius' | 'levels' | 'blocks' | 'border' | 'intersections' | 'shotengai' | 'plaza' | 'roads'> & { ramps?: Ramp[] };

export interface GroundTess {
    /** Lattice origin + cell (the terrain's linear triangles); diagonals only matter when `sloped`. */
    o: number; d: number; sloped: boolean;
    step: number; D: StreetDims; pave: PavementIndex; ramps: Ramp[]; terraced: boolean;
    graph: GraphLike;
    /** Split a polygon (convex or not) into lattice-exact, constant-state pieces. */
    split(poly: V2[], use?: SplitUse): V2[][];
    /** Parameters t ∈ (0,1) where segment a→b crosses a split line (sorted) — for walls / kerbs / strips that
     *  must bend exactly where the ground under them does. */
    cuts(a: V2, b: V2): number[];
}

const cache = new WeakMap<object, { key: string; tess: GroundTess }>();

/** Build (or reuse) the tessellator for a graph. Cached — preview, road paint, water and terraces all use it. */
export function groundTess(graph: GraphLike): GroundTess {
    const p = graph.params;
    const key = `${p.seed}|${p.terrainSeed}|${p.radius}|${p.elevation}|${p.streetWidth}|${p.arterialWidth}|${p.sidewalks}|${p.terraces}|${graph.ramps?.length ?? -1}`;
    const hit = cache.get(graph.blocks);
    if (hit && hit.key === key) return hit.tess;
    const tess = buildTess(graph);
    cache.set(graph.blocks, { key, tess });
    return tess;
}

function sortedUnique(v: number[]): number[] {
    v.sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of v) if (!out.length || x - out[out.length - 1] > 1e-7) out.push(x);
    return out;
}

/** Values of `sorted` strictly inside (lo, hi) (binary search). */
function within(sorted: number[], lo: number, hi: number, out: number[]): void {
    let a = 0, b = sorted.length;
    while (a < b) { const m = (a + b) >> 1; if (sorted[m] <= lo) a = m + 1; else b = m; }
    for (let i = a; i < sorted.length && sorted[i] < hi; i++) out.push(sorted[i]);
}

function buildTess(graph: GraphLike): GroundTess {
    const p = graph.params, R = graph.radius;
    const hf = makeHeightField(p);
    const lat = hf.lattice;
    // Flat terrain has no lattice: still subdivide on the same grid (the domain warp bends ground per vertex,
    // so a sheet needs interior vertices to follow a curving street), just without the diagonals.
    const o = lat ? lat.o : -R * 1.3, d = lat ? lat.d : (2.6 * R) / 48, sloped = !!lat;
    const terraced = !!graph.levels && (p.terraces ?? true);
    const ramps = terraced ? (graph.ramps ?? computeRamps(graph)) : [];
    const pave = pavementIndex(graph);
    const D = streetDims(p), step = terraceStep(p);

    // Level-change lines are LOCAL too: the terrace level can only change on a cell's edges ± the street band, and
    // only around a cell whose level differs from a neighbour. Each such cell contributes a zone (the cell grown by
    // the band) cut on those six lines per axis. (As global lines they sliced the whole city for a handful of steps.)
    const XS: number[] = [], ZS: number[] = [];
    const zones: Zone[] = [];
    if (terraced && p.pattern === 'grid' && graph.levels) {
        const cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows, band = streetBandHalf(p);
        const lv = (c: number, r: number): number => (c < 0 || c >= cols || r < 0 || r >= rows) ? 0 : (graph.levels![c]?.[r] ?? 0);
        for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
            const L = lv(ci, ri);
            let differs = false;
            for (let dc = -1; dc <= 1 && !differs; dc++) for (let dr = -1; dr <= 1; dr++) if (lv(ci + dc, ri + dr) !== L) { differs = true; break; }
            if (!differs) continue;
            const xa = -R + ci * cw, xb = xa + cw, za = -R + ri * ch, zb = za + ch;
            zones.push({ kind: 'level', x0: xa - band, x1: xb + band, z0: za - band, z1: zb + band,
                xs: [xa - band, xa, xa + band, xb - band, xb, xb + band], zs: [za - band, za, za + band, zb - band, zb, zb + band] });
        }
    }
    // LOCAL split zones: a ramp corridor (its edges + grade knots) or a dropped-kerb zone. Their lines only cut
    // pieces that overlap the zone — as global lines, ~800 dropped kerbs would slice the whole city into slivers.
    for (const rp of ramps) {
        const foot = -rp.len * 0.5, knots: number[] = [];
        for (let k = 0; k <= RAMP_KNOTS; k++) knots.push(foot + (rp.len * k) / RAMP_KNOTS);
        if (rp.ax !== 0) {
            const kx = knots.map(u => rp.x + rp.ax * u);
            zones.push({ kind: 'ramp', x0: Math.min(...kx), x1: Math.max(...kx), z0: rp.z - rp.halfWidth, z1: rp.z + rp.halfWidth, xs: sortedUnique(kx), zs: [rp.z - rp.halfWidth, rp.z + rp.halfWidth] });
        } else {
            const kz = knots.map(u => rp.z + rp.az * u);
            zones.push({ kind: 'ramp', x0: rp.x - rp.halfWidth, x1: rp.x + rp.halfWidth, z0: Math.min(...kz), z1: Math.max(...kz), xs: [rp.x - rp.halfWidth, rp.x + rp.halfWidth], zs: sortedUnique(kz) });
        }
    }
    for (const dz of pave.drops) zones.push({ kind: 'drop', x0: dz.x0, x1: dz.x1, z0: dz.z0, z1: dz.z1, xs: [dz.x0, dz.x1], zs: [dz.z0, dz.z1] });
    const zoneGrid = bucketZones(zones);

    const linesIn = (extra: number[], lo: number, hi: number): number[] => {
        const out: number[] = [lo];
        for (let k = Math.floor((lo - o) / d) + 1; o + k * d < hi; k++) out.push(o + k * d);
        within(extra, lo, hi, out);
        out.push(hi);
        return sortedUnique(out);
    };

    const split = (poly: V2[], use: SplitUse = { levels: true, kerb: true }): V2[][] => {
        if (poly.length < 3) return [];
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const q of poly) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < z0) z0 = q[1]; if (q[1] > z1) z1 = q[1]; }
        const gx = linesIn(XS, x0, x1), gz = linesIn(ZS, z0, z1);
        const convex = isConvex(poly), ccw = signedArea(poly) >= 0;
        const out: V2[][] = [];
        const lx: number[] = [], lz: number[] = [];
        for (let a = 0; a + 1 < gx.length; a++) {
            const ax0 = gx[a], ax1 = gx[a + 1];
            if (ax1 - ax0 < 1e-9) continue;
            for (let b = 0; b + 1 < gz.length; b++) {
                const bz0 = gz[b], bz1 = gz[b + 1];
                if (bz1 - bz0 < 1e-9) continue;
                const rect: V2[] = [[ax0, bz0], [ax1, bz0], [ax1, bz1], [ax0, bz1]];
                let piece: V2[];
                if (convex && rect.every(q => insideConvex(q, poly, ccw))) piece = rect;
                else {
                    piece = clipConvex(poly, rect);
                    if (piece.length < 3 || Math.abs(signedArea(piece)) < 1e-12) continue;
                }
                // The lines of every LOCAL zone overlapping this rect cut it (a zone's line may run on past the zone
                // to the rect's edge — at most one lattice cell of extra split, never a wrong one).
                lx.length = 0; lz.length = 0;
                for (const zn of zoneGrid(ax0, bz0, ax1, bz1)) {
                    if (zn.kind === 'drop' ? !use.kerb : !use.levels) continue;
                    if (zn.x1 <= ax0 + 1e-9 || zn.x0 >= ax1 - 1e-9 || zn.z1 <= bz0 + 1e-9 || zn.z0 >= bz1 - 1e-9) continue;
                    for (const x of zn.xs) if (x > ax0 + 1e-9 && x < ax1 - 1e-9) lx.push(x);
                    for (const z of zn.zs) if (z > bz0 + 1e-9 && z < bz1 - 1e-9) lz.push(z);
                }
                let parts = [piece];
                if (lx.length || lz.length) {
                    for (const x of sortedUnique(lx)) parts = parts.flatMap(q => splitAxis(q, 0, x));
                    for (const z of sortedUnique(lz)) parts = parts.flatMap(q => splitAxis(q, 1, z));
                }
                // Lattice diagonal of the cell holding this rect: x + z = 2o + d(i + j + 1).
                const i = Math.floor(((ax0 + ax1) * 0.5 - o) / d), j = Math.floor(((bz0 + bz1) * 0.5 - o) / d);
                const c = 2 * o + d * (i + j + 1);
                for (const q of parts) {
                    let lo = Infinity, hi = -Infinity;
                    for (const v of q) { const sgn = v[0] + v[1]; if (sgn < lo) lo = sgn; if (sgn > hi) hi = sgn; }
                    const halves = !sloped || lo >= c - 1e-9 || hi <= c + 1e-9 ? [q] : [halfPlane(q, c, -1), halfPlane(q, c, 1)];
                    for (const h of halves) if (h.length >= 3 && Math.abs(signedArea(h)) > 1e-12) out.push(h);
                }
            }
        }
        return out;
    };

    const cuts = (a: V2, b: V2): number[] => {
        const t: number[] = [];
        const add = (lines: (lo: number, hi: number) => number[], a0: number, b0: number): void => {
            const lo = Math.min(a0, b0), hi = Math.max(a0, b0);
            if (hi - lo < 1e-9) return;
            for (const v of lines(lo, hi)) { const tt = (v - a0) / (b0 - a0); if (tt > 1e-6 && tt < 1 - 1e-6) t.push(tt); }
        };
        add((lo, hi) => linesIn(XS, lo, hi), a[0], b[0]);
        add((lo, hi) => linesIn(ZS, lo, hi), a[1], b[1]);
        if (sloped) add((lo, hi) => { const out: number[] = []; for (let k = Math.floor((lo - 2 * o) / d) + 1; 2 * o + k * d < hi; k++) out.push(2 * o + k * d); return out; }, a[0] + a[1], b[0] + b[1]);
        // Local zone lines, only where the crossing point lies inside that zone.
        const bx0 = Math.min(a[0], b[0]), bx1 = Math.max(a[0], b[0]), bz0 = Math.min(a[1], b[1]), bz1 = Math.max(a[1], b[1]);
        for (const zn of zoneGrid(bx0, bz0, bx1, bz1)) {
            if (Math.abs(b[0] - a[0]) > 1e-12) for (const x of zn.xs) {
                const tt = (x - a[0]) / (b[0] - a[0]), zz = a[1] + (b[1] - a[1]) * tt;
                if (tt > 1e-6 && tt < 1 - 1e-6 && zz >= zn.z0 - 1e-9 && zz <= zn.z1 + 1e-9) t.push(tt);
            }
            if (Math.abs(b[1] - a[1]) > 1e-12) for (const z of zn.zs) {
                const tt = (z - a[1]) / (b[1] - a[1]), xx = a[0] + (b[0] - a[0]) * tt;
                if (tt > 1e-6 && tt < 1 - 1e-6 && xx >= zn.x0 - 1e-9 && xx <= zn.x1 + 1e-9) t.push(tt);
            }
        }
        return sortedUnique(t);
    };

    return { o, d, sloped, step, D, pave, ramps, terraced, graph, split, cuts };
}

/** A local split zone: an axis-aligned box whose interior is cut by its own x / z lines (edges included). */
/** Which local zones a layer must split on: level/ramp changes (`levels`) and dropped kerbs (`kerb`). */
export interface SplitUse { levels: boolean; kerb: boolean }

interface Zone { kind: 'level' | 'ramp' | 'drop'; x0: number; x1: number; z0: number; z1: number; xs: number[]; zs: number[] }

/** Coarse bucket index over zones → the zones whose box overlaps a query box. */
function bucketZones(zones: Zone[]): (x0: number, z0: number, x1: number, z1: number) => Zone[] {
    if (!zones.length) return () => [];
    let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
    for (const z of zones) { gx0 = Math.min(gx0, z.x0); gz0 = Math.min(gz0, z.z0); gx1 = Math.max(gx1, z.x1); gz1 = Math.max(gz1, z.z1); }
    const N = 48, cx = Math.max((gx1 - gx0) / N, 1e-6), cz = Math.max((gz1 - gz0) / N, 1e-6);
    const b: number[][] = Array.from({ length: N * N }, () => []);
    const ci = (x: number): number => Math.max(0, Math.min(N - 1, Math.floor((x - gx0) / cx)));
    const cj = (z: number): number => Math.max(0, Math.min(N - 1, Math.floor((z - gz0) / cz)));
    zones.forEach((z, k) => { for (let i = ci(z.x0); i <= ci(z.x1); i++) for (let j = cj(z.z0); j <= cj(z.z1); j++) b[j * N + i].push(k); });
    return (x0, z0, x1, z1) => {
        if (x1 < gx0 || x0 > gx1 || z1 < gz0 || z0 > gz1) return [];
        const out: Zone[] = [];   // may repeat a zone across buckets — callers de-duplicate the LINES, which is all that matters
        for (let i = ci(x0); i <= ci(x1); i++) for (let j = cj(z0); j <= cj(z1); j++) for (const k of b[j * N + i]) out.push(zones[k]);
        return out;
    };
}

/** Split a convex piece by an axis-aligned line (axis 0: x = v, axis 1: z = v) into ≤ 2 pieces. */
function splitAxis(poly: V2[], axis: 0 | 1, v: number): V2[][] {
    let lo = false, hi = false;
    for (const q of poly) { if (q[axis] < v - 1e-9) lo = true; else if (q[axis] > v + 1e-9) hi = true; }
    if (!(lo && hi)) return [poly];
    const keep = (sign: number): V2[] => {
        const out: V2[] = [];
        for (let i = 0; i < poly.length; i++) {
            const cur = poly[i], prev = poly[(i - 1 + poly.length) % poly.length];
            const fc = sign * (cur[axis] - v), fp = sign * (prev[axis] - v);
            if (fc <= 0) {
                if (fp > 0) { const t = fp / (fp - fc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
                out.push(cur);
            } else if (fp <= 0) { const t = fp / (fp - fc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
        }
        return out;
    };
    return [keep(1), keep(-1)].filter(q => q.length >= 3);
}

/** Drop repeated and collinear vertices of a (convex) piece — clipping leaves both, and fanning over them
 *  emits zero-area slivers. */
function cleanPiece(poly: V2[]): V2[] {
    let pts = poly.filter((q, i) => { const r = poly[(i + 1) % poly.length]; return Math.abs(q[0] - r[0]) > 1e-9 || Math.abs(q[1] - r[1]) > 1e-9; });
    let changed = true;
    while (changed && pts.length > 3) {
        changed = false;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
            if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12) { pts = pts.filter((_, k) => k !== i); changed = true; break; }
        }
    }
    return pts;
}

function isConvex(poly: V2[]): boolean {
    let sign = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < 1e-14) continue;
        const s = cr > 0 ? 1 : -1;
        if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
}

function insideConvex(q: V2, poly: V2[], ccw: boolean): boolean {
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const cr = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        if (ccw ? cr < -1e-12 : cr > 1e-12) return false;
    }
    return true;
}

/** Keep the part of `poly` with sign·(x + z − c) ≤ 0. */
function halfPlane(poly: V2[], c: number, sign: number): V2[] {
    const out: V2[] = [];
    const f = (q: V2): number => sign * (q[0] + q[1] - c);
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i], prev = poly[(i - 1 + poly.length) % poly.length];
        const fc = f(cur), fp = f(prev);
        if (fc <= 0) {
            if (fp > 0) { const t = fp / (fp - fc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
            out.push(cur);
        } else if (fp <= 0) { const t = fp / (fp - fc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
    }
    return out;
}

/** How a ground layer meets the level system. */
export interface EmitOpts {
    /** Base world Y (groundY + this layer's stacking offset). */
    y: number;
    /** Follow terrace levels + ramps (default true). */
    levels?: boolean;
    /** Add the pavement lift (kerb height, dropped at crossings) where the piece lies on a raised pavement. */
    kerb?: boolean;
    /** Drop pieces below street level (a canal trench) — the default for level-following layers. */
    keepSunk?: boolean;
    /** Extra per-piece skip on the piece centroid. */
    skip?: (cx: number, cz: number) => boolean;
    /** Ignore dropped kerbs (constant kerb lift): the far-away flat-map tiles, where the detail is invisible. */
    noDrops?: boolean;
    /** Per-polygon UV override (default uv = worldXZ·0.5): `poly` is the index into `polys`. For overlays whose
     *  pattern must line up with their OWN edges rather than the world axes (tactile paving tiles, S3). It must be
     *  affine in (x, z) — the split pieces then share one continuous mapping. */
    uv?: (poly: number, x: number, z: number, out: [number, number]) => void;
}

/** The baked (pre-terrain) height of the ground at (x,z) under the same rules `emitGround` uses — for props
 *  and strips built by hand (kerb faces, walls) that must meet a piece's edge exactly. */
export function bakedGroundAt(t: GroundTess, x: number, z: number, kerb: boolean): number {
    let L = 0;
    if (t.terraced) { const rp = rampAt(t.ramps, x, z); L = rp ? rampLevelOf(rp, x, z) : cellLevelAt(t.graph, x, z); }
    return L * t.step + (kerb && L >= 0 ? t.pave.lift(x, z) : 0);
}

/** Split + bake a set of ground polygons into ONE flat-shaded ground mesh (uv = worldXZ·0.5, like the rest of
 *  the city ground). Pieces are constant-level; ramp and dropped-kerb pieces bake their slope per vertex (and
 *  carry the slope's normal — the drape then shears it by the terrain gradient). */
export function emitGround(t: GroundTess, polys: V2[][], opts: EmitOpts): MeshGeometry {
    const vb = new GrowF32(4096), ib = new GrowU32(4096);
    const useLevels = opts.levels !== false && t.terraced;
    const uvo: [number, number] = [0, 0];
    for (let pi = 0; pi < polys.length; pi++) {
        const poly = polys[pi];
        const convex = isConvex(poly);
        for (const raw of t.split(poly, { levels: useLevels, kerb: !!opts.kerb && !opts.noDrops })) {
            const piece = cleanPiece(raw);
            if (piece.length < 3) continue;
            let cx = 0, cz = 0;
            for (const q of piece) { cx += q[0]; cz += q[1]; }
            cx /= piece.length; cz /= piece.length;
            if (opts.skip && opts.skip(cx, cz)) continue;
            let rp: Ramp | null = null, lvl = 0;
            if (useLevels) { rp = rampAt(t.ramps, cx, cz); if (!rp) lvl = cellLevelAt(t.graph, cx, cz); }
            if (!rp && lvl < 0 && !opts.keepSunk) continue;
            let kh = 0, dz: DropZone | null = null;
            if (opts.kerb && (rp || lvl >= 0) && t.pave.test(cx, cz)) { dz = opts.noDrops ? null : t.pave.dropAt(cx, cz); if (!dz) kh = t.D.kerbH; }
            const base = vb.n / FLOATS_PER_VERT;
            for (const q of piece) {
                const x = q[0], z = q[1];
                let y = opts.y + (rp ? rampLevelOf(rp, x, z) : lvl) * t.step + (dz ? dropLift(dz, t.D, x, z) : kh);
                let gx = 0, gz = 0;
                if (rp) {
                    const u = ((x - rp.x) * rp.ax + (z - rp.z) * rp.az) / rp.len + 0.5;
                    const sl = (rp.hiLevel - rp.loLevel) * t.step * rampProfileSlope(u) / rp.len;
                    gx += sl * rp.ax; gz += sl * rp.az;
                }
                if (dz) {
                    const depth = x * dz.inward[0] + z * dz.inward[1] - dz.edge;
                    if (depth > -1e-9 && depth < t.D.dropW + 1e-9) { const sl = t.D.kerbH * (1 - t.D.dropLip) / t.D.dropW; gx += sl * dz.inward[0]; gz += sl * dz.inward[1]; }
                }
                if (!Number.isFinite(y)) y = opts.y;
                const L = Math.hypot(gx, 1, gz);
                if (opts.uv) { opts.uv(pi, x, z, uvo); vb.vert(x, y, z, -gx / L, 1 / L, -gz / L, uvo[0], uvo[1]); }
                else vb.vert(x, y, z, -gx / L, 1 / L, -gz / L);
            }
            // Wind every triangle to face +Y. Mapping layout (x, y) → world (x, ·, z) flips handedness, so a
            // polygon that is CCW in the layout plane faces −Y when fanned as-is.
            if (convex || piece.length === 3) {
                const cw = signedArea(piece) < 0;
                for (let k = 1; k + 1 < piece.length; k++) {
                    if (cw) ib.tri(base, base + k, base + k + 1); else ib.tri(base, base + k + 1, base + k);
                }
            } else {
                const tris = triangulate(piece);   // always CCW in the layout plane
                for (let k = 0; k < tris.length; k += 3) ib.tri(base + tris[k], base + tris[k + 2], base + tris[k + 1]);
            }
        }
    }
    return { vertices: vb.a.slice(0, vb.n), indices: ib.a.slice(0, ib.n), format: '12float' };
}

/** Growable typed buffers for the emitter (12-float ground vertices: pos · normal · uv = xz/2 · tangent +X). */
class GrowF32 {
    a: Float32Array; n = 0;
    constructor(cap: number) { this.a = new Float32Array(cap); }
    vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = x * 0.5, v = z * 0.5): void {
        if (this.n + 12 > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
        const a = this.a; let o = this.n;
        a[o++] = x; a[o++] = y; a[o++] = z; a[o++] = nx; a[o++] = ny; a[o++] = nz;
        a[o++] = u; a[o++] = v; a[o++] = 1; a[o++] = 0; a[o++] = 0; a[o++] = 1;
        this.n = o;
    }
}
class GrowU32 {
    a: Uint32Array; n = 0;
    constructor(cap: number) { this.a = new Uint32Array(cap); }
    tri(i: number, j: number, k: number): void {
        if (this.n + 3 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
        this.a[this.n++] = i; this.a[this.n++] = j; this.a[this.n++] = k;
    }
}
