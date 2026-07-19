// ── World generation — terraces (discrete elevation) ────────────────────────────────────────────
// Where two adjacent grid cells sit at different terrace levels, the ground steps up. This draws the RETAINING
// WALL along that boundary (draped over the smooth terrain) and, on ~half of those edges, a STAIRCASE with
// railings climbing from the lower street up onto the higher terrace — the Yanaka-Ginza / Playfair-Steps look.
// The raise of the ground + buildings themselves is done by the elevation post-transform (`makeElevation`).

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { terraceStep } from './elevation';
import { hash2, pointInPolygon } from './util';

type V3 = [number, number, number];
const WALL: [number, number, number] = [0.52, 0.50, 0.47];   // concrete retaining wall
const STEP: [number, number, number] = [0.62, 0.60, 0.56];   // stone steps
const RAIL: [number, number, number] = [0.28, 0.28, 0.31];   // metal railing

export function buildTerraces(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!graph.levels || p.pattern !== 'grid' || !(p.terraces ?? true)) return [];
    const R = graph.radius, cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
    const step = terraceStep(p), gy = p.groundY, s = R / 10;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;
    // Walls/stairs are built FLAT (level baked into loY/hiY only); the smooth terrain drape is applied by the
    // WorldManager height post-transform (the smooth-only field, like bridges) so their base meets the canal water.
    const lvl = (ci: number, ri: number): number => (ci < 0 || ci >= cols || ri < 0 || ri >= rows) ? 0 : (graph.levels![ci]?.[ri] ?? 0);
    const wall = new Accum3D(), stair = new Accum3D(), rail = new Accum3D();

    const inBorder = (a: V2, b: V2): boolean => pointInPolygon([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5], graph.border);
    for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
        const L = lvl(ci, ri);
        // RIGHT edge (shared with ci+1) — vertical line at x0(ci+1)
        const NR = lvl(ci + 1, ri);
        if (NR !== L) {
            const ex = x0(ci + 1), a: V2 = [ex, y0(ri)], b: V2 = [ex, y0(ri + 1)];
            if (!inBorder(a, b)) { /* rim edge outside a circular border — no floating walls in the void */ } else {
                // Stairs ONLY between two walkable terraces — a canal (level < 0) has no landing at the bottom, so a
                // flight down would just plunge into the water: give canals a bare embankment wall instead.
                const hasStairs = Math.min(L, NR) >= 0 && hash2(ci, ri, 0x57a1) < 0.5;
                retaining(wall, rail, a, b, gy + Math.min(L, NR) * step, gy + Math.max(L, NR) * step, s, hasStairs);
                if (hasStairs) stairs(stair, rail, a, b, L > NR ? [-1, 0] : [1, 0], gy + Math.min(L, NR) * step, gy + Math.max(L, NR) * step, s);
            }
        }
        // TOP edge (shared with ri+1) — horizontal line at y0(ri+1)
        const NT = lvl(ci, ri + 1);
        if (NT !== L) {
            const ez = y0(ri + 1), a: V2 = [x0(ci), ez], b: V2 = [x0(ci + 1), ez];
            if (inBorder(a, b)) {
                const hasStairs = Math.min(L, NT) >= 0 && hash2(ci, ri, 0x9b2f) < 0.5;
                retaining(wall, rail, a, b, gy + Math.min(L, NT) * step, gy + Math.max(L, NT) * step, s, hasStairs);
                if (hasStairs) stairs(stair, rail, a, b, L > NT ? [0, -1] : [0, 1], gy + Math.min(L, NT) * step, gy + Math.max(L, NT) * step, s);
            }
        }
    }

    const layers: LayoutPreviewLayer[] = [];
    if (!wall.empty) layers.push({ name: 'world:retaining', color: WALL, y: gy, geometry: wall.geometry(), pattern: { color: [0.44, 0.42, 0.40], freq: 18, scale: 0.09, mode: 'grid' } });   // masonry courses (quad4 UVs)
    if (!stair.empty) layers.push({ name: 'world:stairs', color: STEP, y: gy, geometry: stair.geometry() });
    if (!rail.empty) layers.push({ name: 'world:stair-rail', color: RAIL, y: gy, geometry: rail.geometry() });
    return layers;
}

/** A retaining wall along edge a→b (flat, from `loY` up to `hiY`) + a railing along its top edge. Built FLAT and
 *  tessellated; the WorldManager smooth-only post-transform drapes it onto the rolling terrain. When a STAIRCASE
 *  sits on this edge, the wall + rail leave a real GAP for it (the flight isn't buried in the wall any more). */
function retaining(wall: Accum3D, rail: Accum3D, a: V2, b: V2, loY: number, hiY: number, s: number, stairGap = false): void {
    const eLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const gh = Math.min(0.45, (0.085 * s + 0.02 * s) / eLen);          // gap half-width in edge-t (stair width + margin)
    const spans: [number, number][] = stairGap ? [[0, 0.5 - gh], [0.5 + gh, 1]] : [[0, 1]];
    const at = (t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const r = 0.006 * s;
    for (const [t0, t1] of spans) {
        const N = 3;
        let prev = at(t0);
        for (let i = 1; i <= N; i++) {
            const cur = at(t0 + (t1 - t0) * i / N);
            wall.quad4([prev[0], loY, prev[1]], [cur[0], loY, cur[1]], [cur[0], hiY, cur[1]], [prev[0], hiY, prev[1]]);
            prev = cur;
        }
        // Railing along this span's top edge (the staircase brings its own railings through the gap).
        const p0 = at(t0), p1 = at(t1);
        rail.beam([p0[0], hiY + 0.045 * s, p0[1]], [p1[0], hiY + 0.045 * s, p1[1]], r, 4);
        rail.prism([p0[0], hiY, p0[1]], r, r, 0.05 * s, 4);
        rail.prism([p1[0], hiY, p1[1]], r, r, 0.05 * s, 4);
    }
}

/** A staircase (steps + two sloped railings) climbing from the low street onto the higher terrace, at the edge
 *  midpoint. Built FLAT (loY→hiY); the smooth-only post-transform drapes it like the wall. */
function stairs(stair: Accum3D, rail: Accum3D, a: V2, b: V2, ascent: V2, loY: number, hiY: number, s: number): void {
    const mid: V2 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5], eLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const eDir: V2 = [(b[0] - a[0]) / eLen, (b[1] - a[1]) / eLen], drop = hiY - loY;
    if (drop < 1e-3) return;
    const nSteps = Math.max(2, Math.round(drop / (0.05 * s))), rise = drop / nSteps, run = 0.038 * s, width = 0.085 * s;   // narrower, finer flight
    const eW: V3 = [eDir[0], 0, eDir[1]], aW: V3 = [ascent[0], 0, ascent[1]], up: V3 = [0, 1, 0];
    const half = nSteps * run * 0.5;   // centre the flight ON the boundary → bottom on the low street, top on the terrace
    for (let i = 0; i < nSteps; i++) {
        const off = (i + 0.5) * run - half;
        stair.obox([mid[0] + ascent[0] * off, loY + (i + 0.5) * rise, mid[1] + ascent[1] * off], eW, up, aW, width, rise * 0.55, run * 0.55);
    }
    for (const side of [1, -1]) {
        const bx = mid[0] + eDir[0] * width * side, bz = mid[1] + eDir[1] * width * side;
        const lox = bx - ascent[0] * half, loz = bz - ascent[1] * half, hix = bx + ascent[0] * half, hiz = bz + ascent[1] * half;
        rail.beam([lox, loY + 0.05 * s, loz], [hix, hiY + 0.05 * s, hiz], 0.006 * s, 4);
        rail.prism([lox, loY, loz], 0.006 * s, 0.006 * s, 0.06 * s, 4);
        rail.prism([hix, hiY, hiz], 0.006 * s, 0.006 * s, 0.06 * s, 4);
    }
}
