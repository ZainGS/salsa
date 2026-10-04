// ── World generation — road paint (lane lines + crosswalks) ─────────────────────────────────────
// Procedural road markings as flat WHITE quads laid on the asphalt (no texture system needed — same merged-
// geometry approach as everything else). Centre dashed lane lines + solid edge lines along every road, zebra
// CROSSWALKS on every junction arm, stop bars + arrows at 4-way approaches, and yellow TACTILE paving on the
// pavement at both ends of each crossing (where the kerb drops).
//
// ★ Real Japanese proportions (S1): zebra bars 45 cm wide in a ~3.5 m deep crossing (the old 0.75 m "crossing"
// read as a row of dots), a narrow 15 cm centre line dashed 5 m on / 5 m off, 5 m arrows, the stop line set back
// behind the zebra. ★ Paint lies ON the road (S2): every strip is split on the ground lattice and baked with the
// road's own levels/ramps (ground-mesh.ts), so it is exactly coplanar with the asphalt and the lift is ~1 cm
// instead of the 18 cm float that cut across every hill.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { cityMetresPerUnit } from './types';
import { groundTess, emitGround } from './ground-mesh';
import { crossings, inShotengaiCells } from './street-layout';
import { ZONE_COLOR } from './preview';

const PAINT_COLOR: [number, number, number] = [0.90, 0.90, 0.86];   // slightly warm white (the as-built flat paint)
/** TYRE-WEAR lanes (persona-polish B1): one polished band per lane, stacked over the asphalt at this lift.
 *  It carries the road's OWN asphalt recipe + tint + world uv, so as built it shades exactly like the road under
 *  it (invisible); only the clean surface look darkens it a touch (world-manager _applySurfaceLook). */
export const ROAD_WEAR_LIFTS = 1;
/** The polished band's width (metres): ONE band per lane, over both wheel paths. Per-wheel-track strips (and a nested
 *  core) cost ~14-28k triangles at radius 10 for a barely visible gain (street-ground triangle budget). */
const WEAR_W_M = 1.8;
const TACTILE_COLOR: [number, number, number] = [0.93, 0.78, 0.16];  // yellow tactile paving (at crossings)
/** TACTILE PAVING (点字ブロック, the "warning" dot block at a crossing — S3): square tiles of this size (m), each
 *  a TACTILE_DOTS × TACTILE_DOTS grid of raised studs TACTILE_DOT_M across, laid in a row along the kerb. */
export const TACTILE_TILE_M = 0.30;
export const TACTILE_DOTS = 5;
export const TACTILE_DOT_M = 0.025;
/** Joint between two tactile tiles (m) — the pavement shows through it, which is what draws the tile grid. */
export const TACTILE_JOINT_M = 0.006;
/** The 'dots' pattern for the tactile layer. Its UVs are laid in each strip's own frame (tactileUv): one uv unit
 *  = TACTILE_UV_TILES tiles, so freq = dots per uv unit puts one stud per (tile / TACTILE_DOTS) cell, cell edges
 *  on the tile edges; scale = the stud's diameter as a fraction of that cell. */
export const TACTILE_UV_TILES = 2;
export const TACTILE_PATTERN = { color: [0.97, 0.84, 0.24] as [number, number, number], freq: TACTILE_DOTS * TACTILE_UV_TILES, scale: TACTILE_DOT_M / (TACTILE_TILE_M / TACTILE_DOTS), mode: 'dots' as const };

/** Paint stacking lift above the road surface, as a multiple of the ground overlay lift (streetDims.lift):
 *  the gutter is +1, paint +2. The surfaces are exactly coplanar, so this is purely depth separation. */
export const ROAD_PAINT_LIFTS = 2;

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const nrm = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
const perp = (d: V2): V2 => [-d[1], d[0]];

/** A rectangle centered on segment a→b, `halfW` to each side (perpendicular). */
function segQuad(a: V2, b: V2, halfW: number): V2[] {
    const d = nrm(sub(b, a)), p = perp(d);
    return [
        [a[0] + p[0] * halfW, a[1] + p[1] * halfW], [b[0] + p[0] * halfW, b[1] + p[1] * halfW],
        [b[0] - p[0] * halfW, b[1] - p[1] * halfW], [a[0] - p[0] * halfW, a[1] - p[1] * halfW],
    ];
}

/** A box centered at `c`, half-extents `hd` along `d` and `hp` along `perp(d)`. */
function orientedBox(c: V2, d: V2, hd: number, hp: number): V2[] {
    const p = perp(d);
    return [
        [c[0] + d[0] * hd + p[0] * hp, c[1] + d[1] * hd + p[1] * hp],
        [c[0] - d[0] * hd + p[0] * hp, c[1] - d[1] * hd + p[1] * hp],
        [c[0] - d[0] * hd - p[0] * hp, c[1] - d[1] * hd - p[1] * hp],
        [c[0] + d[0] * hd - p[0] * hp, c[1] + d[1] * hd - p[1] * hp],
    ];
}

export function buildRoadPaint(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY;
    if (!p.roadPaint) return [];
    const t = groundTess(graph), D = t.D;
    const m = 1 / cityMetresPerUnit(p.radius);          // one real metre in world units
    const quads: V2[][] = [];
    const lineHW = 0.075 * m;                           // 15 cm lines (centre + edge)
    const dash = 5 * m, gap = 5 * m;
    const half = D.half;                                // the kerb line (blocks are inset by streetWidth/2)

    // Lane markings along each road (skip alleys).
    for (const road of graph.roads) {
        if (road.klass === 'alley') continue;
        const a = road.a, b = road.b, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-4) continue;
        const d = nrm(sub(b, a)), pp = perp(d);
        // Keep lines out of the junction box AND the zebra: stop them at the crossing's far edge.
        const trim = len > 2 * (D.cwStart + D.cwDepth) + dash ? D.cwStart + D.cwDepth : len > 3 * half ? half : 0;
        // centre: DASHED on straight roads (arterials/streets); rings are many short segments → keep them solid.
        if (road.klass === 'arterial' || road.klass === 'street') {
            for (let tt = trim; tt < len - trim; tt += dash + gap) {
                const t2 = Math.min(len - trim, tt + dash);
                if (t2 - tt < 1e-3) break;
                quads.push(segQuad([a[0] + d[0] * tt, a[1] + d[1] * tt], [a[0] + d[0] * t2, a[1] + d[1] * t2], lineHW));
            }
        } else {
            quads.push(segQuad(a, b, lineHW * 0.8));    // ring centre line (short segment)
        }
        // Solid EDGE lines — just inside the gutter (not on it), trimmed back to the crossing so they turn
        // the corner at the junction instead of running through it.
        const edgeOff = half - D.gutterW - 0.2 * m - lineHW;
        if (edgeOff > lineHW * 2 && len > 2 * trim + 1e-3) for (const sd of [1, -1]) {
            const ca: V2 = [a[0] + d[0] * trim + pp[0] * edgeOff * sd, a[1] + d[1] * trim + pp[1] * edgeOff * sd];
            const cb: V2 = [b[0] - d[0] * trim + pp[0] * edgeOff * sd, b[1] - d[1] * trim + pp[1] * edgeOff * sd];
            quads.push(segQuad(ca, cb, lineHW));
        }
    }

    // Zebra crosswalks — one per junction arm (street-layout.crossings, shared with the dropped kerbs). Bars run
    // ALONG the traffic direction, 45 cm wide with 45 cm gaps, across the carriageway between the gutters.
    const barW = 0.45 * m, span = 2 * (half - D.gutterW - 0.1 * m);
    for (const cw of crossings(graph)) {
        const nBars = Math.max(3, Math.floor(span / (barW * 2)));
        const pitch = span / nBars;
        for (let i = 0; i < nBars; i++) {
            const u = -span / 2 + (i + 0.5) * pitch;
            quads.push(orientedBox([cw.c[0] + cw.p[0] * u, cw.c[1] + cw.p[1] * u], cw.d, cw.hd, barW * 0.5));
        }
    }

    // STOP LINE across the approach lane, 2 m behind the zebra, + a 5 m forward ARROW behind it (4-way only).
    // YELLOW TACTILE paving on the pavement at both ends of every crossing (behind the dropped kerb): a row of real
    // 30 cm warning tiles two deep along the kerb, each its own quad with a 6 mm joint, and the stud pattern laid in
    // the STRIP's frame (tile edges on dot-cell edges) rather than world XZ — it was one 0.6 m slab with the world
    // uv, which made 27 cm "dots" at an arbitrary phase against the kerb.
    const yellow: V2[][] = [];
    const yellowUv: { o: V2; u: V2; v: V2 }[] = [];
    const lane = half * 0.5;
    const T = TACTILE_TILE_M * m, J = TACTILE_JOINT_M * m;
    for (const cw of crossings(graph)) {
        const nAlong = Math.max(2, Math.round((cw.hd * 1.6) / T));
        for (const sd of [1, -1]) {
            const inward: V2 = [cw.p[0] * sd, cw.p[1] * sd];
            const off0 = half + D.kerbW;                               // the strip starts just behind the kerb stone
            const mid: V2 = [cw.c[0] + inward[0] * (off0 + T), cw.c[1] + inward[1] * (off0 + T)];
            if (!t.pave.test(mid[0], mid[1])) continue;
            const frame = tactileFrame(mid, cw.d, inward, nAlong * T, 2 * T);
            for (let i = 0; i < nAlong; i++) for (let j = 0; j < 2; j++) {
                const a = (i - (nAlong - 1) / 2) * T, w = off0 + (j + 0.5) * T;
                const c: V2 = [cw.c[0] + cw.d[0] * a + inward[0] * w, cw.c[1] + cw.d[1] * a + inward[1] * w];
                yellow.push(orientedBox(c, cw.d, (T - J) * 0.5, (T - J) * 0.5));
                yellowUv.push(frame);
            }
        }
    }
    for (const it of graph.intersections) {
        if (it.type !== 'cross') continue;
        for (const arm of it.arms) {
            const d = nrm(arm), pp = perp(d);
            const back = D.cwStart + D.cwDepth + 2 * m + 0.2 * m;
            const bc: V2 = [it.pos[0] + d[0] * back + pp[0] * lane, it.pos[1] + d[1] * back + pp[1] * lane];
            quads.push(orientedBox(bc, d, 0.2 * m, lane * 0.9));                                     // 40 cm stop line (approach lane)
            arrow(quads, [bc[0] + d[0] * 5.5 * m, bc[1] + d[1] * 5.5 * m], d, m);                    // 5 m arrow behind it
        }
    }

    // No paint over a SUNKEN CANAL (the road base is cut away there — emitGround drops sunk pieces by itself) and
    // NONE on the pedestrian shotengai (its paving owns those cells).
    const skip = (x: number, z: number): boolean => inShotengaiCells(graph, x, z);
    const out: LayoutPreviewLayer[] = [];
    const y = gy + D.lift * ROAD_PAINT_LIFTS;
    // ★ B2: every stripe gets a stripe-frame uv (u along it, v packing its width + the distance from one long edge —
    // see stripeFrame), so the roadPaint surface can wear the edges without splitting the mesh. As built the look
    // shows flat paint (world-manager turns the ground shading on only for the clean surface look), i.e. identical
    // to the old flat quads.
    if (quads.length) {
        const mpu = cityMetresPerUnit(p.radius);
        const frames = quads.map((q) => stripeFrame(q, mpu));
        out.push({ name: 'world:roadpaint', color: PAINT_COLOR, y, drape: 'smooth',
            geometry: emitGround(t, quads, { y, skip, uv: (i, x, z, o) => paintUv(frames[i], x, z, o) }),
            ground: { surface: 'roadPaint', tint: PAINT_COLOR, metersPerUnit: mpu, weather: 'new' } });
    }
    // B1 tyre-wear lanes (not on the far flat-map tiles, where they are invisible anyway).
    if (graph.regions.length) out.push(...buildRoadWear(graph, skip));
    // Tactile blocks ride the (dropped) pavement: kerb lift on, one overlay lift above the slabs.
    const ty = gy + D.lift * 2;
    if (yellow.length) out.push({ name: 'world:tactile', color: TACTILE_COLOR, y: ty, drape: 'smooth',
        geometry: emitGround(t, yellow, { y: ty, kerb: true, skip, uv: (i, x, z, o) => tactileUv(yellowUv[i], T, x, z, o) }),
        pattern: { ...TACTILE_PATTERN, color: [...TACTILE_PATTERN.color] as [number, number, number] } });   // the raised warning studs
    return out;
}

/** The UV frame of one tactile strip centred at `c` (extent `lenD` along `d`, `lenP` along `p`): axes chosen from
 *  ±d / ±p so u runs as close to world +X and v to world +Z as possible — the pattern's relief normal is built on
 *  the world X/Z tangents (mesh3d PATTERN RELIEF), so this keeps each stud's bevel lit from the right side — and
 *  the origin on a strip corner, so every tile edge falls on a whole number of stud cells. */
export function tactileFrame(c: V2, d: V2, p: V2, lenD: number, lenP: number): { o: V2; u: V2; v: V2 } {
    const cand: { ax: V2; len: number }[] = [
        { ax: d, len: lenD }, { ax: [-d[0], -d[1]], len: lenD }, { ax: p, len: lenP }, { ax: [-p[0], -p[1]], len: lenP },
    ];
    const U = cand.reduce((b, q) => (q.ax[0] > b.ax[0] ? q : b));
    const perpC = cand.filter(q => Math.abs(q.ax[0] * U.ax[0] + q.ax[1] * U.ax[1]) < 0.5);
    const V = perpC.reduce((b, q) => (q.ax[1] > b.ax[1] ? q : b));
    return { o: [c[0] - U.ax[0] * U.len * 0.5 - V.ax[0] * V.len * 0.5, c[1] - U.ax[1] * U.len * 0.5 - V.ax[1] * V.len * 0.5], u: U.ax, v: V.ax };
}

/** Tactile UV at (x,z) in its strip frame: 0.5 + tiles / TACTILE_UV_TILES (the pattern shader centres on uv 0.5,
 *  so the offset keeps the stud grid phase-locked to the strip corner). `T` = tile size in world units. */
export function tactileUv(f: { o: V2; u: V2; v: V2 }, T: number, x: number, z: number, out: [number, number]): void {
    const dx = x - f.o[0], dz = z - f.o[1];
    out[0] = 0.5 + (dx * f.u[0] + dz * f.u[1]) / (T * TACTILE_UV_TILES);
    out[1] = 0.5 + (dx * f.v[0] + dz * f.v[1]) / (T * TACTILE_UV_TILES);
}

/** A forward road arrow centred at `c` pointing along `d`: a 5 m stem + a two-bar chevron head (m = one metre). */
function arrow(quads: V2[][], c: V2, d: V2, m: number): void {
    const pp = perp(d), tip: V2 = [c[0] + d[0] * 2.5 * m, c[1] + d[1] * 2.5 * m];
    quads.push(orientedBox(c, d, 2.2 * m, 0.1 * m));   // stem
    for (const sd of [1, -1]) {
        const dir = nrm([-d[0] + pp[0] * sd * 0.8, -d[1] + pp[1] * sd * 0.8]);
        quads.push(segQuad(tip, [tip[0] + dir[0] * 1.3 * m, tip[1] + dir[1] * 1.3 * m], 0.1 * m));
    }
}

/** One stripe's uv frame: `o` = a corner on one LONG edge, `n` = unit inward normal of that edge, `d` = unit
 *  along-stripe axis, `vOff` = the packed width term. uv = (along, across) × 0.5 is a rotation of the city's
 *  worldXZ × 0.5 uv (so the per-mesh uv → metre scale is unchanged), and v also carries `vOff` = widthCm + 0.1 in RAW
 *  uv units (mesh3d gr_paintLocal decodes it from the raw uv, so the estimated metric scale cannot scramble it). */
export interface PaintFrame { o: V2; n: V2; d: V2; vOff: number }

/** The frame of a rectangular stripe quad (4 corners in order); `mpu` = metres per world unit. */
export function stripeFrame(q: V2[], mpu: number): PaintFrame {
    if (q.length !== 4) return { o: q[0], n: [0, 1], d: [1, 0], vOff: 0.1 };
    const l01 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), l12 = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    const long01 = l01 >= l12;
    const [a, b, e] = long01 ? [q[0], q[1], q[3]] : [q[1], q[2], q[0]];
    const d = nrm(sub(b, a));
    let n = perp(d);
    if ((e[0] - a[0]) * n[0] + (e[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]];   // point into the stripe
    const widthCm = Math.round(Math.min(l01, l12) * mpu * 100);   // across × 0.5 stays under 0.9 uv for any real stripe
    return { o: a, n, d, vOff: widthCm + 0.1 };
}

/** Stripe-frame uv at (x,z) — affine per stripe, so the lattice split pieces share one continuous mapping. */
export function paintUv(f: PaintFrame, x: number, z: number, out: [number, number]): void {
    out[0] = (x * f.d[0] + z * f.d[1]) * 0.5;
    out[1] = ((x - f.o[0]) * f.n[0] + (z - f.o[1]) * f.n[1]) * 0.5 + f.vOff;
}

/** TYRE-WEAR lanes (B1): per road direction, one faint band down the middle of its lane,
 *  trimmed out of the junction box like the lane lines. World uv + the road's asphalt recipe (see ROAD_WEAR_LIFTS). */
export function buildRoadWear(graph: WorldGraph, skip: (x: number, z: number) => boolean): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY;
    const t = groundTess(graph), D = t.D;
    const m = 1 / cityMetresPerUnit(p.radius);
    const half = D.half, lane = half * 0.5;
    const outer: V2[][] = [];
    if (lane + WEAR_W_M * 0.5 * m > half - D.gutterW) return [];   // lane too narrow for the band
    for (const road of graph.roads) {
        if (road.klass === 'alley') continue;
        const a = road.a, b = road.b, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-4) continue;
        const trim = len > 3 * half ? half : 0;
        if (len - 2 * trim < 1e-3) continue;
        const d = nrm(sub(b, a)), pp = perp(d);
        for (const sd of [1, -1]) {
            const off = lane * sd;
            const ca: V2 = [a[0] + d[0] * trim + pp[0] * off, a[1] + d[1] * trim + pp[1] * off];
            const cb: V2 = [b[0] - d[0] * trim + pp[0] * off, b[1] - d[1] * trim + pp[1] * off];
            outer.push(segQuad(ca, cb, WEAR_W_M * 0.5 * m));
        }
    }
    if (!outer.length) return [];
    const mpu = cityMetresPerUnit(p.radius);
    const ground = { surface: 'asphalt' as const, tint: ZONE_COLOR.road, metersPerUnit: mpu };
    const yo = gy + D.lift * ROAD_WEAR_LIFTS;
    return [
        { name: 'world:roads-wear', color: ZONE_COLOR.road, y: yo, drape: 'smooth', geometry: emitGround(t, outer, { y: yo, skip }), ground: { ...ground } },
    ];
}
