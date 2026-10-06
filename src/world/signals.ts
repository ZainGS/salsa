// ── World generation — traffic signals ──────────────────────────────────────────────────────────
// Japanese-style HORIZONTAL 3-lamp traffic lights at junctions: a pole + a cantilever arm over the road, a
// blue street-name sign, a rectangular light housing, three round lamps (red/yellow/green) on the front, and a
// half-cylinder VISOR hood over each lamp. Built from graph.intersections; one assembly per junction, oriented
// to the primary road. Merged per colour (dark housing / blue sign / red / yellow / green).

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { metalScaleFor, cityMetresPerUnit } from './types';
import { METAL_PAINTED } from './palette';
import { Accum3D, partOf } from './meshbuild';
import { twinAccum, withFarTwin, PROP_TWIN_M } from './lod-accum';
import { regionAt } from './layout';
import { cellLevelAt, makeElevation } from './elevation';
import { makeDomainWarpInto } from './warp';
import { inShotengai } from './shotengai';
import { signQuad, type TextSignSpec } from './signtext';
import { hash2, pointInPolygon } from './util';

type V3 = [number, number, number];

const DARK: [number, number, number] = [0.12, 0.12, 0.14];   // pole / arm / housing / visors
const SIGN: [number, number, number] = [0.16, 0.34, 0.63];   // Japanese blue street-name plate
const RED: [number, number, number] = [0.90, 0.16, 0.13];

// ── The PHASE CLOCK (E3) ────────────────────────────────────────────────────────────────────────
// Each signalled junction runs a two-axis cycle: axis A (parallel to the junction's arms[0]) green → yellow → all-red,
// then axis B the same. Junctions are hashed into SIGNAL_BUCKETS phase-offset groups so the city doesn't flip in
// unison; the lamps of one (bucket, axis, colour) are merged into ONE layer, so a phase change re-dresses a handful
// of meshes, not every lamp. The ticker (world-traffic) and the cars / walkers read the SAME pure clock.
export interface SignalTiming { green: number; yellow: number; allRed: number }
export const DEFAULT_SIGNAL_TIMING: SignalTiming = { green: 11, yellow: 2.5, allRed: 1.5 };
export const SIGNAL_BUCKETS = 4;
export type SignalLamp = 'green' | 'yellow' | 'red';
/** Lit / unlit lens colours per lamp. An unlit lens is a dark tint of the lit one (so the glow walk, which sets
 *  emissive = diffuse × factor, keeps it dim at any time of day). */
export const SIGNAL_ON: Record<SignalLamp, [number, number, number]> = { red: [0.90, 0.16, 0.13], yellow: [0.96, 0.80, 0.16], green: [0.22, 0.76, 0.46] };
export const SIGNAL_OFF: Record<SignalLamp, [number, number, number]> = { red: [0.20, 0.06, 0.05], yellow: [0.22, 0.18, 0.06], green: [0.05, 0.17, 0.11] };
/** Layer-name grammar of the phase-switched lamps: `world:signal-<lamp>-<bucket><a|b>` (glow regex `signal-red|…`). */
export const SIGNAL_LAMP_RE = /^world:signal-(red|yellow|green)-(\d)([ab])$/;

export function signalCycle(t: SignalTiming = DEFAULT_SIGNAL_TIMING): number { return 2 * (t.green + t.yellow + t.allRed); }

/** Phase bucket of a junction (position hash → stable across regens of the same seed). */
export function signalBucket(pos: V2, seed: number): number {
    return Math.floor(hash2(Math.round(pos[0] * 1000), Math.round(pos[1] * 1000), (seed ^ 0x516a) >>> 0) * SIGNAL_BUCKETS) % SIGNAL_BUCKETS;
}

/** Lamp state of one axis (0 = parallel to arms[0]) at sim time `time`, plus seconds until that state ends. */
export function signalState(time: number, bucket: number, axis: 0 | 1, timing: SignalTiming = DEFAULT_SIGNAL_TIMING): { lamp: SignalLamp; remaining: number } {
    const C = signalCycle(timing), g = timing.green, y = timing.yellow, half = C / 2;
    let tc = (time + bucket * C / SIGNAL_BUCKETS) % C; if (tc < 0) tc += C;
    if (axis === 1) { tc -= half; if (tc < 0) tc += C; }
    if (tc < g) return { lamp: 'green', remaining: g - tc };
    if (tc < g + y) return { lamp: 'yellow', remaining: g + y - tc };
    return { lamp: 'red', remaining: C - tc };
}

/** Every junction that carries 3-lamp signals (same filter as buildTrafficLights), with its phase bucket + axis. */
export interface SignalJunction { pos: V2; axis0: V2; bucket: number }
export function signalledJunctions(graph: WorldGraph): SignalJunction[] {
    const p = graph.params; if (!p.trafficLights) return [];
    const border = graph.border;
    const overWater = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) < 0 || (border.length >= 3 && !pointInPolygon([x, z], border));
    const out: SignalJunction[] = [];
    for (const it of graph.intersections) {
        if (it.type !== 'cross' || overWater(it.pos[0], it.pos[1]) || inShotengai(graph, it.pos[0], it.pos[1])) continue;
        out.push({ pos: it.pos, axis0: nrm2(it.arms[0]), bucket: signalBucket(it.pos, p.seed) });
    }
    return out;
}

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

export function buildTrafficLights(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params; if (!p.trafficLights) return [];
    const gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;   // half = real asphalt gap → the curb corner
    const border = graph.border;
    const overWater = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) < 0 || (border.length >= 3 && !pointInPolygon([x, z], border));   // canal OR past the diorama border (open sea)
    // RIGID SIGNALS: every head / STOP sign bakes ONE elevation AND one domain-warp offset, both sampled at its pole
    // foot, and its layers are drape 'baked' + noWarp. The per-vertex 'full' drape lifted each vertex by the kerb under
    // IT — a STOP plate straddles the kerb line (side = half + 0.02 s, r 0.032 s), so the rim / face / back plate came
    // out lopsided (the 8 rim radii spread by ~60 % of the radius) and a mast arm kinked where it crossed the kerb; the
    // per-vertex warp then sheared what was left by ~5 %. Same warp as the drape env (centre: graph.params; a framed
    // tile: its params carry the world warpSeed). computeSignalTextSigns places the plates with the same rigid frame.
    const lift = makeElevation(graph), rigid = rigidFrame(graph);

    // P9: the housings / poles / visors also build a cheap FAR TWIN (lod-accum.ts); the lamp lenses stay as they are.
    const um = 1 / cityMetresPerUnit(p.radius);
    const dark = twinAccum(PROP_TWIN_M.signal, um, p.propTwins), stopRed = new Accum3D(), stopRim = new Accum3D();
    // One accumulator per (lamp, bucket, axis) — the phase clock toggles each as a unit.
    const lamps = new Map<string, Accum3D>();
    const lampAcc = (lamp: SignalLamp, bucket: number, axis: 0 | 1): Accum3D => {
        const k = `${lamp}-${bucket}${axis ? 'b' : 'a'}`;
        let a = lamps.get(k); if (!a) { a = new Accum3D(); lamps.set(k, a); } return a;
    };
    const LAMPS: SignalLamp[] = ['green', 'yellow', 'red'];

    for (const it of graph.intersections) {
        if (keep && !keep(regionAt(graph, it.pos[0], it.pos[1]) ?? -1)) continue;
        if (overWater(it.pos[0], it.pos[1])) continue;   // no signals for a junction node in the canal
        if (inShotengai(graph, it.pos[0], it.pos[1])) continue;   // the pedestrian street has no traffic signals
        if (it.type === 'tee') {
            const stem = teeStem(it.arms);
            // guard the actual stop-sign foot (offset onto the curb) — skip if that lands in a canal
            const sf = stopFoot(it.pos, stem, half, s);
            if (overWater(sf[0], sf[1])) continue;
            const sy = gy + lift(sf[0], sf[1]);   // the whole sign at its foot's elevation (rigid)
            const wp = rigid(it.pos, sf);         // … and shifted by the warp at its foot (rigid)
            partOf([dark, stopRed, stopRim], [wp[0], sy, wp[1]], stem, () => addStopSign(dark, stopRed, stopRim, wp, stem, half, sy, s)); continue;   // P20: one prop part
        }
        if (it.type !== 'cross') continue;   // full 3-lamp signals only at 4-way crosses; corners get nothing
        const a0 = nrm2(it.arms[0]), bucket = signalBucket(it.pos, p.seed);
        // ONE HEAD PER APPROACH (was one for the whole junction, facing one way): for every arm, traffic arriving along
        // it travels `d` = −arm; its head stands on the near-side LEFT corner (left-hand traffic) with the mast arm
        // reaching over its lane, lamps facing the oncoming driver. The first approach (d = arms[0]) is exactly the old
        // single head, so computeSignalTextSigns' street-name plate still lines up with it.
        const approaches: V2[] = [a0, ...it.arms.map(a => nrm2([-a[0], -a[1]])).filter(d => Math.abs(d[0] - a0[0]) + Math.abs(d[1] - a0[1]) > 1e-3)];
        for (const d of approaches) {
            const axis: 0 | 1 = Math.abs(d[0] * a0[0] + d[1] * a0[1]) > 0.7 ? 0 : 1;
            const dW: V3 = [d[0], 0, d[1]];             // travel direction of the traffic this head controls
            const pW: V3 = [-d[1], 0, d[0]];            // cross axis (lamps line up along this)
            const up: V3 = [0, 1, 0];
            const front: V3 = [-d[0], 0, -d[1]];        // housing faces oncoming traffic

            // Pole sits on the CURB CORNER (half along each axis), NOT roadW*0.5 (which shoved it into the canal/buildings).
            const poleH = 0.34 * s, r = 0.008 * s, cOff = half + 0.03 * s, armLen = half * 1.7 + 0.05 * s;
            const foot: V3 = [it.pos[0] + (pW[0] - dW[0]) * cOff, gy, it.pos[1] + (pW[2] - dW[2]) * cOff];
            if (overWater(foot[0], foot[2])) continue;   // corner pole in the canal → skip this head
            foot[1] = gy + lift(foot[0], foot[2]);       // rigid head: one elevation + one warp offset at the pole foot (see `lift`)
            const fw = rigid(foot[0], foot[2]); foot[0] = fw[0]; foot[2] = fw[1];
            const top: V3 = [foot[0], foot[1] + poleH, foot[2]];
            const armEnd: V3 = [top[0] - pW[0] * armLen, top[1] - 0.01 * s, top[2] - pW[2] * armLen];
            // P20: the head's pieces are prop parts — one per piece, because the full-tier drape lifts what stands on the
            // pavement by the kerb and not what hangs over the road (so the pole, the arm, the brace and the housing each
            // move rigidly, but not together). Bookkeeping only: the emitted geometry is unchanged.
            const seg = (): void => { dark.endPart(); dark.beginPart(foot, d); };
            dark.beginPart(foot, d);
            signPost(dark, foot, poleH, r);             // bevelled pole: base collar, taper, domed cap
            seg();
            // MAST ARM (T3.2): a tapered tube from a bolted flange plate on the pole, propped by a diagonal tie rod.
            const armV: V3 = [armEnd[0] - top[0], armEnd[1] - top[1], armEnd[2] - top[2]];
            const armL = Math.hypot(armV[0], armV[1], armV[2]);
            dark.lathe(top, armV, [[r * 0.8, 0], [r * 0.55, armL]], 8, { caps: [false, true] });
            seg();
            dark.obox([top[0] - pW[0] * r * 0.85, top[1], top[2] - pW[2] * r * 0.85], pW, up, dW, 0.0022 * s, 0.011 * s, 0.0085 * s);
            seg();
            const braceAt = 0.32 * armLen;
            dark.beam([foot[0] - pW[0] * r * 0.8, top[1] - 0.05 * s, foot[2] - pW[2] * r * 0.8],
                [top[0] - pW[0] * braceAt, top[1] - 0.01 * s * (braceAt / armLen), top[2] - pW[2] * braceAt], r * 0.28, 4);
            seg();

            // Light housing at the arm end: a bevelled body on a slightly larger BACKPLATE, hung by two clamps.
            const hz = 0.012 * s, hy = 0.016 * s, hw = 0.045 * s;   // housing ~1.35 m wide × 0.48 m tall
            const hc: V3 = [armEnd[0], armEnd[1] - 0.02 * s, armEnd[2]];
            dark.bevelBox(hc, pW, up, dW, hw, hy, hz, 0.004 * s);
            dark.obox([hc[0] + dW[0] * (hz + 0.001 * s), hc[1], hc[2] + dW[2] * (hz + 0.001 * s)], pW, up, dW, hw + 0.007 * s, hy + 0.007 * s, 0.001 * s);
            for (const k of [-0.6, 0.6]) {
                dark.obox([hc[0] + pW[0] * hw * k, armEnd[1] - 0.003 * s, hc[2] + pW[2] * hw * k], pW, up, dW, 0.0025 * s, 0.0075 * s, 0.006 * s);
            }

            // Three ROUNDED lamps (shallow domed lenses) under tunnel VISORS on the front face, spaced along pW. Each
            // lamp goes to its (lamp, bucket, axis) layer, baked in its t = 0 state.
            const lampR = 0.011 * s;   // ~0.33 m lens
            for (let i = 0; i < 3; i++) {
                const u = (i - 1) * 0.028 * s;   // ~0.42 m lamp pitch, fits inside the housing
                const lc: V3 = [hc[0] + pW[0] * u - dW[0] * (hz + 0.0003 * s), hc[1], hc[2] + pW[2] * u - dW[2] * (hz + 0.0003 * s)];
                lampAcc(LAMPS[i], bucket, axis).lathe(lc, front, [[lampR, 0], [0, lampR * 0.3]], 12, { smooth: true, caps: [false, false] });
                visor(dark, lc, front, pW, lampR * 1.12, lampR * 1.5, 7);
            }
            seg();

            // PEDESTRIAN HEAD on the same pole, facing ACROSS this approach's crosswalk (walkers there move along pW,
            // i.e. the OTHER axis): the walking figure is lit with that axis' green and the standing figure with its
            // red, so the stock phase clock (world-traffic) switches them with no new layer grammar.
            addPedHead(dark, lampAcc('green', bucket, axis ? 0 : 1), lampAcc('red', bucket, axis ? 0 : 1), foot, pW, r, s);
            dark.endPart();
        }
        // (The blue street-name plate is a real TEXTURED text sign — see computeSignalTextSigns below.)
    }

    const out: LayoutPreviewLayer[] = [];
    const glow = p.nightMode ? 1.1 : 0.55;   // the coloured lamps glow (brighter at night)
    // A traffic-light column and its hoods are painted metal — the one prop a pedestrian stands right
    // next to, so a flat matte silhouette here is very visible. Keeps its own DARK tone as the tint.
    if (!dark.empty) {
        out.push(...withFarTwin({ name: 'world:signal-housing', color: DARK, y: gy, geometry: dark.geometry(), drape: 'baked', noWarp: true,
            metal: { ...METAL_PAINTED, tint: DARK, scale: metalScaleFor(p.radius) } }, dark, 'signal', PROP_TWIN_M.signal, um));
    }
    // Lamps baked in their t = 0 state (the static city shows a believable mix; the live ticker takes over).
    for (const [k, a] of lamps) {
        if (a.empty) continue;
        const m = /^(red|yellow|green)-(\d)([ab])$/.exec(k)!;
        const lamp = m[1] as SignalLamp, st = signalState(0, Number(m[2]), m[3] === 'b' ? 1 : 0);
        out.push({ name: `world:signal-${k}`, color: st.lamp === lamp ? SIGNAL_ON[lamp] : SIGNAL_OFF[lamp], y: gy, geometry: a.geometry(), emissive: glow, drape: 'baked', noWarp: true });
    }
    // The STOP octagons keep their layer name (the street-props grammar test) but are NOT lamps: a painted, retro-
    // reflective plate lit by the scene (WorldManager.GLOW's 'signal-red-stop' row comes BEFORE the lamp row — the
    // lamp row's 0.55 day self-light made the plate read flat and unlit). Same low emissive here for headless builds.
    if (!stopRed.empty) out.push({ name: 'world:signal-red-stop', color: RED, y: gy, geometry: stopRed.geometry(), emissive: STOP_PLATE_GLOW, drape: 'baked', noWarp: true });
    if (!stopRim.empty) out.push({ name: 'world:signal-stop-rim', color: STOP_RIM, y: gy, geometry: stopRim.geometry(), emissive: STOP_PLATE_GLOW, drape: 'baked', noWarp: true });
    return out;
}

/** A BEVELLED sign / signal post (T3): chamfered base collar, a tapered shaft and a domed cap, as one 8-sided lathe
 *  (~150 tris). `r` = the nominal shaft radius; `h` = the shaft height (the cap rises ~1.2·r above it). Shared with
 *  road-sign.ts so every pole in the kerb family has the same profile. */
export function signPost(acc: Accum3D, foot: V3, h: number, r: number, sides = 8): void {
    const k = r / 0.008;   // the profile is authored for r = 0.008 (× s) and scales with it
    const prof: [number, number][] = [
        [0.0125 * k, 0], [0.0125 * k, 0.003 * k], [0.0105 * k, 0.005 * k],   // chamfered foot collar
        [0.0088 * k, 0.013 * k],                                            // collar → shaft
        [0.0072 * k, h],                                                     // tapered shaft
        [0.0078 * k, h + 0.005 * k],                                         // top band
        [0.004 * k, h + 0.009 * k], [0, h + 0.0105 * k],                    // domed cap
    ];
    acc.lathe(foot, [0, 1, 0], prof, sides, { caps: [false, false] });
}

/** A TUNNEL VISOR around a round lamp: a cylinder segment about `front` wrapping the top ~250° of the lens, deeper at
 *  the top than at the sides (the bottom is open so the lamp shows from below-ish viewpoints). `side` = the lateral
 *  axis. 2·segs tris. */
function visor(acc: Accum3D, c: V3, front: V3, side: V3, r: number, depth: number, segs: number): void {
    const up: V3 = [0, 1, 0];
    const a0 = -0.2 * Math.PI, a1 = 1.2 * Math.PI;
    const near: number[] = [], far: number[] = [];
    for (let i = 0; i <= segs; i++) {
        const a = a0 + (a1 - a0) * (i / segs), ca = Math.cos(a), sa = Math.sin(a);
        const n: V3 = [side[0] * ca + up[0] * sa, side[1] * ca + up[1] * sa, side[2] * ca + up[2] * sa];
        const dd = depth * (0.45 + 0.55 * Math.max(0, sa));   // the hood reaches furthest over the top
        const p0: V3 = [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r];
        near.push(acc.vertex(p0, n, i / segs, 0));
        far.push(acc.vertex([p0[0] + front[0] * dd, p0[1] + front[1] * dd, p0[2] + front[2] * dd], n, i / segs, 1));
    }
    for (let i = 0; i < segs; i++) { acc.triangle(near[i], far[i], far[i + 1]); acc.triangle(near[i], far[i + 1], near[i + 1]); }
}

/** A pedestrian signal head on a pole at `foot`, facing `-pW` (across the crosswalk): a bevelled two-window housing
 *  on two pole clamps, a small hood over each window, and the lit FIGURES — a standing man (top, red layer) and a
 *  walking man (bottom, green layer). ~140 tris. */
function addPedHead(dark: Accum3D, walk: Accum3D, stand: Accum3D, foot: V3, pW: V3, r: number, s: number): void {
    const up: V3 = [0, 1, 0];
    const n: V3 = [-pW[0], 0, -pW[2]];               // the face normal (toward the far kerb)
    const R: V3 = [n[2], 0, -n[0]];                  // the face's lateral axis
    const hw = 0.012 * s, hy = 0.021 * s, hz = 0.008 * s;   // ~0.36 m wide × 0.63 m tall
    const off = r * 1.05 + hz + 0.002 * s, yc = foot[1] + 0.19 * s;
    const c: V3 = [foot[0] + n[0] * off, yc, foot[2] + n[2] * off];
    dark.bevelBox(c, R, up, n, hw, hy, hz, 0.0025 * s);
    for (const dy of [-0.6, 0.6]) {   // pole clamps: a strap from the pole to the housing back
        dark.obox([foot[0] + n[0] * (r + 0.001 * s), yc + hy * dy, foot[2] + n[2] * (r + 0.001 * s)], R, up, n, 0.003 * s, 0.0025 * s, 0.003 * s);
    }
    const win = hy * 0.46;                           // each window's half-size
    for (const [wy, acc, walking] of [[hy * 0.5, stand, false], [-hy * 0.5, walk, true]] as [number, Accum3D, boolean][]) {
        const wc: V3 = [c[0] + n[0] * (hz + 0.0004 * s), yc + wy, c[2] + n[2] * (hz + 0.0004 * s)];
        dark.hood([wc[0], wc[1] + win * 0.9, wc[2]], R, up, n, 0.006 * s, hw * 0.88, 4);
        pedFigure(acc, wc, R, up, n, win, walking);
    }
}

/** The pictogram figure (flat, just proud of the window) in a window of half-size `k` centred at `c`. */
function pedFigure(acc: Accum3D, c: V3, R: V3, up: V3, n: V3, k: number, walking: boolean): void {
    const P = (x: number, y: number): V3 => [c[0] + (R[0] * x + up[0] * y) * k, c[1] + (R[1] * x + up[1] * y) * k, c[2] + (R[2] * x + up[2] * y) * k];
    const q = (a: [number, number], b: [number, number], cc: [number, number], d: [number, number]): void => acc.quad4(P(a[0], a[1]), P(b[0], b[1]), P(cc[0], cc[1]), P(d[0], d[1]));
    if (!walking) {
        acc.disc(P(0, 0.62), n, 0.15 * k, 8);                                     // head
        q([-0.2, -0.1], [0.2, -0.1], [0.2, 0.44], [-0.2, 0.44]);                  // torso
        q([-0.3, -0.05], [-0.22, -0.05], [-0.22, 0.4], [-0.3, 0.4]);              // arms at the sides
        q([0.22, -0.05], [0.3, -0.05], [0.3, 0.4], [0.22, 0.4]);
        q([-0.18, -0.75], [-0.03, -0.75], [-0.03, -0.1], [-0.18, -0.1]);          // legs together
        q([0.03, -0.75], [0.18, -0.75], [0.18, -0.1], [0.03, -0.1]);
    } else {
        acc.disc(P(0.08, 0.62), n, 0.15 * k, 8);                                  // head
        q([-0.14, -0.1], [0.14, -0.1], [0.24, 0.44], [-0.04, 0.44]);              // leaning torso
        q([-0.46, -0.72], [-0.3, -0.75], [0.06, -0.1], [-0.1, -0.1]);             // trailing leg
        q([0.3, -0.75], [0.46, -0.72], [0.12, -0.1], [-0.04, -0.1]);              // striding leg
        q([0.36, -0.08], [0.44, -0.02], [0.22, 0.32], [0.14, 0.38]);              // swinging arms
        q([-0.32, 0.16], [-0.26, 0.1], [0.06, 0.42], [-0.02, 0.38]);
    }
}

/** The "stem" arm of a T-junction: the one road whose opposite direction is absent (it dead-ends at the through road). */
function teeStem(arms: V2[]): V2 {
    for (const a of arms) if (!arms.some(b => Math.abs(b[0] + a[0]) < 1e-6 && Math.abs(b[1] + a[1]) < 1e-6)) return a;
    return arms[0];
}

/** A red STOP octagon on a short pole at the stem approach of a T, facing the (must-stop) oncoming stem traffic.
 *  `half` = the real asphalt half-gap → the sign sits at the curb, not pushed out into the next cell. */
const STOP_POLE_H = 0.17;   // pole height (× s) — shared by addStopSign + computeSignalTextSigns so the plate + octagon line up
/** How far in front of the pole (along the stem, × s) the STOP lettering quad is centred (the octagon is at 0.0105). */
export const STOP_TEXT_AHEAD = 0.0135;
const STOP_RIM: [number, number, number] = [0.93, 0.92, 0.88];   // the white border round the red face
const STOP_PLATE_GLOW = 0.08;   // retro-reflective paint, not a light
/** The STOP octagon is FLAT-TOPPED: an 8-gon ring turned by π/8 (unturned, a vertex sat at the top and the side). */
const OCT_ROT = Math.PI / 8;
/** RIGID placement under the domain warp: `fn(p, at)` = p shifted by the warp displacement sampled at `at` (default p).
 *  The layers that use it are noWarp, so the prop lands exactly where the per-vertex warp puts its foot, unsheared. */
function rigidFrame(graph: WorldGraph): { (p: V2, at?: V2): V2; (x: number, z: number): V2 } {
    const warp = makeDomainWarpInto(graph.params), w: [number, number] = [0, 0];
    return ((a: V2 | number, b?: V2 | number): V2 => {
        const p: V2 = typeof a === 'number' ? [a, b as number] : a, at = typeof a === 'number' ? p : (b as V2 | undefined) ?? a;
        warp(at[0], at[1], w);
        return [p[0] + w[0], p[1] + w[1]];
    }) as { (p: V2, at?: V2): V2; (x: number, z: number): V2 };
}
/** XZ of a T-junction STOP sign's pole foot — ONE definition for addStopSign, its elevation sample and the lettering. */
function stopFoot(pos: V2, stem: V2, half: number, s: number): V2 {
    const along = half + 0.05 * s, side = half + 0.02 * s;
    return [pos[0] + stem[0] * along - stem[1] * side, pos[1] + stem[1] * along + stem[0] * side];
}
/** `gy` = the elevation baked at the foot (the layers are drape 'baked'). */
function addStopSign(dark: Accum3D, red: Accum3D, rim: Accum3D, pos: V2, stem: V2, half: number, gy: number, s: number): void {
    const d: V3 = [stem[0], 0, stem[1]], pW: V3 = [-stem[1], 0, stem[0]];
    const poleH = STOP_POLE_H * s, r = 0.007 * s;
    const f2 = stopFoot(pos, stem, half, s), foot: V3 = [f2[0], gy, f2[1]];
    signPost(dark, foot, poleH, r);   // bevelled pole (collar, taper, domed cap)
    // Octagon CENTRED on the pole top (so the pole backs its lower half instead of the sign balancing on a point),
    // nudged just in front along the stem so its face doesn't z-fight the pole.
    const c: V3 = [foot[0] + d[0] * 0.0105 * s, foot[1] + poleH, foot[2] + d[2] * 0.0105 * s];   // clear of the pole's top band
    // White border octagon + the red face just in front of it (the STOP text quad is added in computeSignalTextSigns).
    rim.disc(c, d, 0.032 * s, 8, OCT_ROT);
    red.disc([c[0] + d[0] * 0.0005 * s, c[1], c[2] + d[2] * 0.0005 * s], d, 0.0285 * s, 8, OCT_ROT);
    // T3.3: a slightly larger dark BACK PLATE (reads as the plate's rim from the front and its back from behind), a
    // vertical back rail, and two clamp straps round the pole.
    const back: V3 = [foot[0] + d[0] * 0.0087 * s, foot[1] + poleH, foot[2] + d[2] * 0.0087 * s];
    dark.lathe(back, d, [[0.0345 * s, -0.0007 * s], [0.0345 * s, 0.0008 * s]], 8, { caps: [true, true], rot: OCT_ROT });
    const up: V3 = [0, 1, 0];
    dark.obox([foot[0] + d[0] * 0.0075 * s, foot[1] + poleH, foot[2] + d[2] * 0.0075 * s], pW, up, d, 0.004 * s, 0.026 * s, 0.0008 * s);
    for (const dy of [-0.016, 0.016]) dark.obox([foot[0], foot[1] + poleH + dy * s, foot[2]], pW, up, d, r * 1.02, 0.0022 * s, r * 1.02);
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
    // The plates bake the SAME foot elevation + warp offset as their (rigid: drape 'baked', noWarp) signal / STOP sign —
    // see buildTrafficLights. Built lazily: a city without signals never pays for the pavement index.
    let liftFn: ((x: number, z: number) => number) | null = null;
    const lift = (x: number, z: number): number => (liftFn ??= makeElevation(graph))(x, z);
    const rigid = rigidFrame(graph);
    let idx = 0;
    for (const it of graph.intersections) {
        if (keep && !keep(regionAt(graph, it.pos[0], it.pos[1]) ?? -1)) continue;
        if (overWater(it.pos[0], it.pos[1]) || inShotengai(graph, it.pos[0], it.pos[1])) continue;
        if (it.type === 'tee') {
            const stem = teeStem(it.arms);
            const poleH = STOP_POLE_H * s;
            const [fx, fz] = stopFoot(it.pos, stem, half, s);
            if (overWater(fx, fz)) continue;
            const fy = gy + lift(fx, fz), [wx, wz] = rigid(fx, fz);
            // Centred on the pole top like the octagon, nudged a hair further in front so the lettering sits ON the plate.
            const c: V3 = [wx + stem[0] * STOP_TEXT_AHEAD * s, fy + poleH, wz + stem[1] * STOP_TEXT_AHEAD * s];
            out.push({ label: 'STOP', square: true, layer: { name: 'world:signaltext-stop' + idx, color: RED, y: gy, emissive: 0.55, singleSided: true, drape: 'baked', noWarp: true,
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
        const [wx, wz] = rigid(fx, fz);
        const c: V3 = [wx - pW[0] * armLen * 0.42, gy + lift(fx, fz) + poleH, wz - pW[1] * armLen * 0.42];
        out.push({ label: signalStreetName(graph, it.pos[0], it.pos[1], d), layer: { name: 'world:signaltext-name' + idx, color: SIGN, y: gy, emissive: 0.5, singleSided: true, drape: 'baked', noWarp: true,
            geometry: signQuad(c, pW, d, 0.05 * s, 0.02 * s) } });
        idx++;
    }
    return out;
}
