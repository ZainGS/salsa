// ── World generation — traffic signals ──────────────────────────────────────────────────────────
// Japanese-style HORIZONTAL 3-lamp traffic lights at junctions: a pole + a cantilever arm over the road, a
// blue street-name sign, a rectangular light housing, three round lamps (red/yellow/green) on the front, and a
// half-cylinder VISOR hood over each lamp. Built from graph.intersections; one assembly per junction, oriented
// to the primary road. Merged per colour (dark housing / blue sign / red / yellow / green).

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { metalScaleFor } from './types';
import { METAL_PAINTED } from './palette';
import { Accum3D } from './meshbuild';
import { regionAt } from './layout';
import { cellLevelAt } from './elevation';
import { inShotengai } from './shotengai';
import { signQuad, type TextSignSpec } from './signtext';
import { hash2, pointInPolygon } from './util';

type V3 = [number, number, number];

const DARK: [number, number, number] = [0.12, 0.12, 0.14];   // pole / arm / housing / visors
const SIGN: [number, number, number] = [0.16, 0.34, 0.63];   // Japanese blue street-name plate
const RED: [number, number, number] = [0.90, 0.16, 0.13];
const YEL: [number, number, number] = [0.96, 0.80, 0.16];
const GRN: [number, number, number] = [0.22, 0.76, 0.46];

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

export function buildTrafficLights(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params; if (!p.trafficLights) return [];
    const gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;   // half = real asphalt gap → the curb corner
    const border = graph.border;
    const overWater = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) < 0 || (border.length >= 3 && !pointInPolygon([x, z], border));   // canal OR past the diorama border (open sea)

    const dark = new Accum3D(), red = new Accum3D(), yel = new Accum3D(), grn = new Accum3D();
    const heads = [red, yel, grn];

    for (const it of graph.intersections) {
        if (keep && !keep(regionAt(graph, it.pos[0], it.pos[1]) ?? -1)) continue;
        if (overWater(it.pos[0], it.pos[1])) continue;   // no signals for a junction node in the canal
        if (inShotengai(graph, it.pos[0], it.pos[1])) continue;   // the pedestrian street has no traffic signals
        if (it.type === 'tee') {
            const stem = teeStem(it.arms);
            // guard the actual stop-sign foot (offset onto the curb) — skip if that lands in a canal
            if (overWater(it.pos[0] + stem[0] * (half + 0.05 * s) - stem[1] * (half + 0.02 * s), it.pos[1] + stem[1] * (half + 0.05 * s) + stem[0] * (half + 0.02 * s))) continue;
            addStopSign(dark, red, it.pos, stem, half, gy, s); continue;
        }
        if (it.type !== 'cross') continue;   // full 3-lamp signals only at 4-way crosses; corners get nothing
        const d = nrm2(it.arms[0]);
        const dW: V3 = [d[0], 0, d[1]];             // road direction
        const pW: V3 = [-d[1], 0, d[0]];            // cross axis (lamps line up along this)
        const up: V3 = [0, 1, 0];
        const front: V3 = [-d[0], 0, -d[1]];        // housing faces oncoming traffic

        // Pole sits on the CURB CORNER (half along each axis), NOT roadW*0.5 (which shoved it into the canal/buildings).
        const poleH = 0.34 * s, r = 0.008 * s, cOff = half + 0.03 * s, armLen = half * 1.7 + 0.05 * s;
        const foot: V3 = [it.pos[0] + (pW[0] - dW[0]) * cOff, gy, it.pos[1] + (pW[2] - dW[2]) * cOff];
        if (overWater(foot[0], foot[2])) continue;   // corner pole in the canal → skip this signal
        const top: V3 = [foot[0], gy + poleH, foot[2]];
        const armEnd: V3 = [top[0] - pW[0] * armLen, top[1] - 0.01 * s, top[2] - pW[2] * armLen];
        dark.prism(foot, r, r, poleH, 6);           // pole
        dark.beam(top, armEnd, r * 0.7, 4);         // cantilever arm

        // Light housing at the arm end.
        const hz = 0.012 * s, hy = 0.016 * s, hw = 0.045 * s;   // housing ~1.35 m wide × 0.48 m tall (was a 2.25 m billboard)
        const hc: V3 = [armEnd[0] - up[0] * 0.02 * s, armEnd[1] - 0.02 * s, armEnd[2]];
        dark.obox(hc, pW, up, dW, hw, hy, hz);

        // Three lamps + visors on the front face, spaced along pW.
        const lampR = 0.011 * s;   // ~0.33 m lens (was 0.6 m)
        for (let i = 0; i < 3; i++) {
            const u = (i - 1) * 0.028 * s;   // ~0.42 m lamp pitch, fits inside the smaller housing
            const lc: V3 = [hc[0] + pW[0] * u - dW[0] * (hz + 0.003 * s), hc[1], hc[2] + pW[2] * u - dW[2] * (hz + 0.003 * s)];
            heads[i].disc(lc, front, lampR, 12);
            dark.hood([lc[0] + up[0] * lampR * 0.7, lc[1] + lampR * 0.7, lc[2]], pW, up, front, lampR * 1.25, lampR * 1.05, 5);
        }

        // (The blue street-name plate is now a real TEXTURED text sign — see computeSignalTextSigns below, which
        //  the WorldManager rasterizes the street name onto. Its placement mirrors sc here exactly.)
    }

    const out: LayoutPreviewLayer[] = [];
    const glow = p.nightMode ? 1.1 : 0.55;   // the coloured lamps glow (brighter at night)
    const push = (a: Accum3D, name: string, color: [number, number, number], emissive?: number) => { if (!a.empty) out.push({ name, color, y: gy, geometry: a.geometry(), emissive }); };
    // A traffic-light column and its hoods are painted metal — the one prop a pedestrian stands right
    // next to, so a flat matte silhouette here is very visible. Keeps its own DARK tone as the tint.
    if (!dark.empty) {
        out.push({ name: 'world:signal-housing', color: DARK, y: gy, geometry: dark.geometry(),
            metal: { ...METAL_PAINTED, tint: DARK, scale: metalScaleFor(p.radius) } });
    }
    push(red, 'world:signal-red', RED, glow);
    push(yel, 'world:signal-yellow', YEL, glow);
    push(grn, 'world:signal-green', GRN, glow);
    return out;
}

/** The "stem" arm of a T-junction: the one road whose opposite direction is absent (it dead-ends at the through road). */
function teeStem(arms: V2[]): V2 {
    for (const a of arms) if (!arms.some(b => Math.abs(b[0] + a[0]) < 1e-6 && Math.abs(b[1] + a[1]) < 1e-6)) return a;
    return arms[0];
}

/** A red STOP octagon on a short pole at the stem approach of a T, facing the (must-stop) oncoming stem traffic.
 *  `half` = the real asphalt half-gap → the sign sits at the curb, not pushed out into the next cell. */
const STOP_POLE_H = 0.17;   // pole height (× s) — shared by addStopSign + computeSignalTextSigns so the plate + octagon line up
function addStopSign(dark: Accum3D, red: Accum3D, pos: V2, stem: V2, half: number, gy: number, s: number): void {
    const d: V3 = [stem[0], 0, stem[1]], pW: V3 = [-stem[1], 0, stem[0]];
    const along = half + 0.05 * s, side = half + 0.02 * s, poleH = STOP_POLE_H * s, r = 0.007 * s;
    const foot: V3 = [pos[0] + d[0] * along + pW[0] * side, gy, pos[1] + d[2] * along + pW[2] * side];
    dark.prism(foot, r, r, poleH, 6);   // pole
    // Octagon CENTRED on the pole top (so the pole backs its lower half instead of the sign balancing on a point),
    // nudged just in front along the stem so its face doesn't z-fight the pole.
    const c: V3 = [foot[0] + d[0] * 0.006 * s, foot[1] + poleH, foot[2] + d[2] * 0.006 * s];
    red.disc(c, d, 0.032 * s, 8);   // an 8-gon reads as the STOP octagon (STOP text quad added in computeSignalTextSigns)
}

// ── Real TEXTURED lettering on the signals: the blue Japanese street-name plate on each cross-junction arm, and
// the STOP lettering on each T-junction sign. Placement MIRRORS buildTrafficLights/addStopSign exactly; the
// WorldManager rasterizes each label onto the plate (a headless build just shows the coloured plate). Kept as a
// separate pass so buildTrafficLights' signature (→ LayoutPreviewLayer[]) is unchanged. ────────────────────────
const AVE_NAMES = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH', '10TH', '11TH', '12TH'];
const ST_NAMES = ['OAK', 'ELM', 'MAPLE', 'CHERRY', 'PINE', 'CEDAR', 'BIRCH', 'WILLOW', 'ASPEN', 'HOLLY', 'LAUREL', 'ROWAN'];

/** The street name a signal plate shows: E–W roads are numbered AVEs (by row), N–S roads are tree STs (by
 *  column) — matching signtext's green blades. Non-grid cities get a hashed tree-name so the plate still reads. */
function signalStreetName(graph: WorldGraph, x: number, z: number, along: V2): string {
    const p = graph.params, R = p.radius;
    if (p.pattern === 'grid') {
        const cw = 2 * R / Math.max(2, p.gridCols), ch = 2 * R / Math.max(2, p.gridRows);
        if (Math.abs(along[0]) >= Math.abs(along[1])) { const row = Math.round((z + R) / ch); return AVE_NAMES[((row % AVE_NAMES.length) + AVE_NAMES.length) % AVE_NAMES.length] + ' AVE'; }
        const col = Math.round((x + R) / cw); return ST_NAMES[((col % ST_NAMES.length) + ST_NAMES.length) % ST_NAMES.length] + ' ST';
    }
    return ST_NAMES[(hash2(x * 3.7, z * 5.1, (p.seed ^ 0x51a2) >>> 0) * ST_NAMES.length) | 0] + ' ST';
}

export function computeSignalTextSigns(graph: WorldGraph, keep?: ((region: number) => boolean) | null): TextSignSpec[] {
    const p = graph.params; if (!p.trafficLights) return [];
    const gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;
    const border = graph.border;
    const overWater = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) < 0 || (border.length >= 3 && !pointInPolygon([x, z], border));   // canal OR past the diorama border (open sea)
    const out: TextSignSpec[] = [];
    let idx = 0;
    for (const it of graph.intersections) {
        if (keep && !keep(regionAt(graph, it.pos[0], it.pos[1]) ?? -1)) continue;
        if (overWater(it.pos[0], it.pos[1]) || inShotengai(graph, it.pos[0], it.pos[1])) continue;
        if (it.type === 'tee') {
            const stem = teeStem(it.arms);
            const along = half + 0.05 * s, side = half + 0.02 * s, poleH = STOP_POLE_H * s;
            const fx = it.pos[0] + stem[0] * along - stem[1] * side, fz = it.pos[1] + stem[1] * along + stem[0] * side;
            if (overWater(fx, fz)) continue;
            // Centred on the pole top like the octagon, nudged a hair further in front so the lettering sits ON the plate.
            const c: V3 = [fx + stem[0] * 0.009 * s, gy + poleH, fz + stem[1] * 0.009 * s];
            out.push({ label: 'STOP', square: true, layer: { name: 'world:signaltext-stop' + idx, color: RED, y: gy, emissive: 0.55, singleSided: true,
                geometry: signQuad(c, [-stem[1], stem[0]], [stem[0], stem[1]], 0.02 * s, 0.02 * s) } });
            idx++; continue;
        }
        if (it.type !== 'cross') continue;
        const d = nrm2(it.arms[0]);
        const poleH = 0.34 * s, cOff = half + 0.03 * s, armLen = half * 1.7 + 0.05 * s;
        const pW: V2 = [-d[1], d[0]];
        const fx = it.pos[0] + (pW[0] - d[0]) * cOff, fz = it.pos[1] + (pW[1] - d[1]) * cOff;
        if (overWater(fx, fz)) continue;
        // Centre the plate ON the mast arm (was +0.03·s ABOVE it → a 0.45 m gap that read as "floating"). The arm
        // beam now runs through the plate's middle so it reads as bolted to the cantilever.
        const c: V3 = [fx - pW[0] * armLen * 0.42, gy + poleH, fz - pW[1] * armLen * 0.42];
        out.push({ label: signalStreetName(graph, it.pos[0], it.pos[1], d), layer: { name: 'world:signaltext-name' + idx, color: SIGN, y: gy, emissive: 0.5, singleSided: true,
            geometry: signQuad(c, pW, d, 0.05 * s, 0.02 * s) } });
        idx++;
    }
    return out;
}
