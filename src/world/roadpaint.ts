// ── World generation — road paint (lane lines + crosswalks) ─────────────────────────────────────
// Procedural road markings as flat WHITE quads laid on the asphalt (no texture system needed — same merged-
// geometry approach as everything else). Center dashed lane lines + solid side lines along every road, and
// zebra CROSSWALKS at each intersection (from graph.intersections). One white layer.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { polysToGeometry } from './preview';
import { cellLevelAt } from './elevation';
import { inShotengai } from './shotengai';

const PAINT_COLOR: [number, number, number] = [0.90, 0.90, 0.86];   // slightly warm white
const TACTILE_COLOR: [number, number, number] = [0.93, 0.78, 0.16];  // yellow tactile paving (at crossings)
export const ROAD_PAINT_Y = 0.012;                                  // above sidewalk/lots (paint sits only on roads)

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
    const p = graph.params, gy = p.groundY, s = p.radius / 10;
    if (!p.roadPaint) return [];
    const quads: V2[][] = [];
    const laneHW = 0.011 * s, sideHW = 0.009 * s;
    const dash = 0.13 * s, gap = 0.11 * s;
    const half = p.streetWidth * 0.5;   // the REAL asphalt half-gap (blocks inset by this, both patterns) = the curb line

    // Lane markings along each road (skip alleys).
    for (const road of graph.roads) {
        if (road.klass === 'alley') continue;
        const a = road.a, b = road.b, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-4) continue;
        const d = nrm(sub(b, a)), pp = perp(d);
        // center: DASHED on straight roads (arterials/streets); rings are many short segments → keep them solid-ish.
        if (road.klass === 'arterial' || road.klass === 'street') {
            const cTrim = len > 3 * half ? half : 0;   // break the centre dashes at intersections too (stop at the block corners)
            for (let t = cTrim; t < len - cTrim; t += dash + gap) {
                const t2 = Math.min(len - cTrim, t + dash);
                if (t2 - t < 1e-3) break;
                quads.push(segQuad([a[0] + d[0] * t, a[1] + d[1] * t], [a[0] + d[0] * t2, a[1] + d[1] * t2], laneHW));
            }
        } else {
            quads.push(segQuad(a, b, laneHW * 0.8));   // ring centre line (short segment)
        }
        // Solid CURB side lines — offset to the REAL asphalt edge (blocks inset by streetWidth*0.5, NOT the inflated
        // road.width), and TRIMMED back from each end to the block corner, so they border the blocks and turn a hard
        // 90° instead of crossing straight through the intersection. (Short ring arcs aren't trimmed → ring stays whole.)
        const curbOff = half - sideHW;                    // line band sits just inside the asphalt at the curb
        const trim = len > 3 * half ? half : 0;           // pull endpoints back to the block corner (skip short segments)
        if (curbOff > sideHW && len > 2 * trim + 1e-3) for (const sd of [1, -1]) {
            const ca: V2 = [a[0] + d[0] * trim + pp[0] * curbOff * sd, a[1] + d[1] * trim + pp[1] * curbOff * sd];
            const cb: V2 = [b[0] - d[0] * trim + pp[0] * curbOff * sd, b[1] - d[1] * trim + pp[1] * curbOff * sd];
            quads.push(segQuad(ca, cb, sideHW));
        }
    }

    // Zebra crosswalks at intersections — sized to the REAL street width (2*half = streetWidth), NOT the inflated
    // road.width. Thin stripes (running along the traffic direction) arrayed across the road, just past the junction
    // mouth on each approach. Thinner + narrower span than before → more stripes fit and they stay on the asphalt.
    const cwDepth = 0.05 * s, barW = 0.028 * s, span = p.streetWidth * 0.82;
    for (const it of graph.intersections) {
        for (const arm of it.arms) {                       // one crosswalk per road ARM (so a T gets 3, a corner 2)
            const d = nrm(arm), pp = perp(d);
            const back = half + cwDepth * 0.7;             // just outside the central junction square, on the approach
            const c: V2 = [it.pos[0] + d[0] * back, it.pos[1] + d[1] * back];
            const nBars = Math.max(3, Math.floor(span / (barW * 2)));
            for (let i = 0; i < nBars; i++) {
                const u = -span / 2 + ((i + 0.5) * span) / nBars;
                quads.push(orientedBox([c[0] + pp[0] * u, c[1] + pp[1] * u], d, cwDepth * 0.5, barW * 0.5));
            }
        }
    }

    // Lane markings at 4-way approaches: a STOP BAR across the near lane + a forward TURN ARROW. Plus YELLOW
    // TACTILE paving strips at every crossing's curb (the blind-guidance strips — a separate coloured layer).
    const yellow: V2[][] = [];
    const lane = p.streetWidth * 0.24;
    for (const it of graph.intersections) {
        for (const arm of it.arms) {
            const d = nrm(arm), pp = perp(d);
            yellow.push(orientedBox([it.pos[0] + d[0] * half, it.pos[1] + d[1] * half], d, 0.014 * s, p.streetWidth * 0.4));   // tactile at the curb
        }
        if (it.type !== 'cross') continue;
        for (const arm of it.arms) {
            const d = nrm(arm), pp = perp(d), back = half + cwDepth * 1.4;
            const bc: V2 = [it.pos[0] + d[0] * back + pp[0] * lane, it.pos[1] + d[1] * back + pp[1] * lane];
            quads.push(orientedBox(bc, d, 0.012 * s, lane * 0.9));                                 // stop bar (near lane)
            arrow(quads, [bc[0] + d[0] * 0.16 * s, bc[1] + d[1] * 0.16 * s], d, s);                // forward turn arrow
        }
    }

    // Drop any paint that would land over a SUNKEN CANAL cell — the road base is cut away there (preview.fillGrid), so
    // the paint would otherwise sink with the canal and float on the water. Bridges span the canals without lane paint.
    const onLand = (q: V2[]): boolean => {
        let cx = 0, cz = 0; for (const v of q) { cx += v[0]; cz += v[1]; }
        const px = cx / q.length, pz = cz / q.length;
        // no paint over canals (road base is cut away) and NONE on the pedestrian shotengai (its paving owns those cells)
        return cellLevelAt(graph, px, pz) >= 0 && !inShotengai(graph, px, pz);
    };
    const kept = quads.filter(onLand), keptY = yellow.filter(onLand);
    const y = gy + ROAD_PAINT_Y;
    const out: LayoutPreviewLayer[] = [];
    if (kept.length) out.push({ name: 'world:roadpaint', color: PAINT_COLOR, y, geometry: polysToGeometry(kept, y) });
    if (keptY.length) out.push({ name: 'world:tactile', color: TACTILE_COLOR, y, geometry: polysToGeometry(keptY, y) });
    return out;
}

/** A simple forward road arrow at `c` pointing along `d`: a stem + a two-bar chevron head. */
function arrow(quads: V2[][], c: V2, d: V2, s: number): void {
    const pp = perp(d), tip: V2 = [c[0] + d[0] * 0.05 * s, c[1] + d[1] * 0.05 * s];
    quads.push(orientedBox(c, d, 0.05 * s, 0.006 * s));   // stem
    for (const sd of [1, -1]) {
        const dir = nrm([-d[0] + pp[0] * sd, -d[1] + pp[1] * sd]);
        quads.push(segQuad(tip, [tip[0] + dir[0] * 0.028 * s, tip[1] + dir[1] * 0.028 * s], 0.006 * s));
    }
}
