// ── World generation — the AT-GRADE LOCAL LINE: geometry, the track contract and the consist (railway-upgrade R3.2/R3.3) ─
// Builds the static layers for the line local-line.ts planned (a single ballasted track with I-profile rails on
// concrete sleepers, fenced both sides, a simple single-track catenary, two small terminus stations with a side
// platform, shelter, name board and a stair down at the buffer end, and a LEVEL CROSSING at every road it meets), plus
// the pure contract the traffic sim needs: the warped track polyline with a rail-top height per point, the crossings'
// arc zones, the barrier arm pivots and the short local consist (the EMU car scaled to 16 m × 2.7 m, one pantograph).
//
// SPACES. The static layers are LAYOUT space with their height baked (drape 'baked') and are WARPED with the city by
// the drape pass — the track lies on the ground and must bend with the streets it crosses. The moving (and parked)
// train rides the warped centreline sampled at the same points (noWarp movers), so the wheels stay on the rails.
// Heights: the rail top is the smooth terrain + the kerb (the block paving the corridor runs over) + 0.315 m. At a
// crossing the road is RAISED to the rail top by the crossing boards (a board table with short ramps) — the same
// surface the cars and walkers ride (crossingSurfaceY, used by the traffic ticker's ground sampler).
//
// Layer names (every one `world:local-*`, tiered on purpose — world-manager DETAIL / PROPS / STRUCTURE):
//   · world:local-fine-*      sleepers, rails, fence, catenary        DETAIL (near only)
//   · world:local-prop*       station bench / sign posts / buffers    PROPS
//   · world:local-xing-*      crossing masts, machines, crossbucks, arms  PROPS (NOT the lamps)
//   · world:local-xing-lamp-<i><a|b>  the alternating red lamps — untiered, phase-switched by the ticker (materialDirty)
//   · world:local-stn-sign-lit / -lamplights  lit — untiered
//   · world:local-train*      the parked consist (hidden while the moving one runs) — untiered like world:rail-train
//   · everything else         bed, boards, paint, platform, shelter    STRUCTURE

import type { WorldGraph, LayoutPreviewLayer, LayoutParams, V2 } from './types';
import { cityMetresPerUnit, metalScaleFor } from './types';
import { Accum3D, catenary } from './meshbuild';
import { makeHeightField } from './elevation';
import { makeDomainWarpInto } from './warp';
import { streetDims } from './street-layout';
import { METAL_PAINTED } from './palette';
import {
    LOCAL_M, localZAt, localTangentAt, localHalfWidth, localPathSamples, crossingFrame, crossingSin,
    type LocalLinePlan, type LocalCrossingPlan,
} from './local-line';
import {
    emuCarLayersEx, railLivery, trainRunPlan, trainRunStart, carPoseAt, EMU_WIDTH_M, EMU_BOGIE_HALF_M, EMU_DOOR_SLIDE_M,
    type EmuVariant, type TrainRunPlan, type TrainRunState, type RailLivery,
} from './train';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

type V3 = [number, number, number];
type RGB = [number, number, number];

const BALLAST: RGB = [0.42, 0.40, 0.37];
const SLEEPER: RGB = [0.52, 0.51, 0.48];
const RAIL: RGB = [0.50, 0.50, 0.52];
const STEEL: RGB = [0.40, 0.40, 0.42];
const FENCE: RGB = [0.36, 0.42, 0.38];        // green-grey painted pipe fence
const MAST: RGB = [0.46, 0.48, 0.47];
const WIRE: RGB = [0.20, 0.18, 0.16];
const BOARD: RGB = [0.30, 0.30, 0.31];        // concrete crossing boards (rubber-jointed)
const ROAD: RGB = [0.17, 0.18, 0.20];         // the asphalt ramps up to them (preview.ts ZONE_COLOR.road)
const PAINT: RGB = [0.88, 0.88, 0.85];
const YELLOW: RGB = [0.92, 0.72, 0.08];
const BLACK: RGB = [0.06, 0.06, 0.07];
const LAMP_ON: RGB = [1.0, 0.12, 0.08];
const LAMP_OFF: RGB = [0.12, 0.03, 0.02];
const PLATFORM: RGB = [0.62, 0.61, 0.58];
const EDGE_WHITE: RGB = [0.90, 0.90, 0.86];
const TACTILE: RGB = [0.86, 0.68, 0.10];
const SHELTER: RGB = [0.70, 0.71, 0.72];
const CONCRETE: RGB = [0.60, 0.59, 0.56];
const PROP: RGB = [0.34, 0.36, 0.38];
const SIGN: RGB = [0.95, 0.96, 0.94];
const LAMP: RGB = [1.0, 0.98, 0.92];
const BUFFER_RED: RGB = [0.78, 0.12, 0.10];

/** The lamp ON / OFF colours (the ticker switches the diffuse; the glow walk derives the emissive from it). */
export const LOCAL_LAMP_ON = LAMP_ON, LOCAL_LAMP_OFF = LAMP_OFF;
/** Layer-name grammar of the phase-switched crossing lamps. */
export const LOCAL_LAMP_RE = /^world:local-xing-lamp-(\d+)([ab])$/;

// ── The track contract ─────────────────────────────────────────────────────────────────────────────────────────────
export interface LocalTrack {
    plan: LocalLinePlan;
    /** Layout samples (uniform in x) + their spacing. */
    pts: V2[]; dx: number;
    /** Rail-top height (world Y) per sample. */
    y: number[];
    /** Warped (render-space) samples + cumulative arc (the train's path). */
    wpts: [number, number][]; cum: number[]; len: number;
    /** Each crossing: its arc on the track and the half-length of its zone along the track (the street band). */
    xings: { q: LocalCrossingPlan; arc: number; zoneHalf: number }[];
    /** Consist-centre stop arcs at the two termini (stations) — the run's lo / hi when the stations are there. */
    unitsPerMetre: number;
    /** Rail top at a layout point (smooth terrain + kerb + the track stack). */
    railTopAt(x: number, z: number): number;
    /** Arc (warped) at a layout x. */
    arcAtX(x: number): number;
}

const trackCache = new WeakMap<object, LocalTrack | null>();

/** The local line's track for a graph (memoised; null when the graph has no local line). */
export function localTrack(graph: WorldGraph): LocalTrack | null {
    const pl = graph.localLine;
    if (!pl) return null;
    const hit = trackCache.get(pl);
    if (hit !== undefined) return hit;
    const p = graph.params, u = pl.u, gy = p.groundY;
    const hf = makeHeightField(p), D = streetDims(p);
    const railTopAt = (x: number, z: number): number => gy + hf(x, z) + D.kerbH + LOCAL_M.railTopAbovePave * u;
    const { pts, dx } = localPathSamples(pl, 1.5);
    const warp = makeDomainWarpInto(p), w: [number, number] = [0, 0];
    const wpts: [number, number][] = pts.map(q => { warp(q[0], q[1], w); return [q[0] + w[0], q[1] + w[1]]; });
    const cum = [0];
    for (let i = 1; i < wpts.length; i++) cum.push(cum[i - 1] + Math.hypot(wpts[i][0] - wpts[i - 1][0], wpts[i][1] - wpts[i - 1][1]));
    const y = pts.map(q => railTopAt(q[0], q[1]));
    const arcAtX = (x: number): number => {
        const f = Math.max(0, Math.min(pts.length - 1, (x - pl.x0) / dx)), i = Math.min(pts.length - 2, Math.floor(f));
        return cum[i] + (cum[i + 1] - cum[i]) * (f - i);
    };
    const xings = pl.crossings.map(q => ({ q, arc: arcAtX(q.x), zoneHalf: q.band / crossingSin(q) }));
    const T: LocalTrack = { plan: pl, pts, dx, y, wpts, cum, len: cum[cum.length - 1], xings, unitsPerMetre: u, railTopAt, arcAtX };
    trackCache.set(pl, T);
    return T;
}

/** Board-table surface at a layout point, or −Infinity off every crossing. The crossing's road is raised to the rail
 *  top over the track (± crossCore across the track) and ramps back to the road / pavement over LOCAL_M.ramp. */
export function crossingHumpY(T: LocalTrack, x: number, z: number, base: number): number {
    const u = T.unitsPerMetre, F = _fr;
    let best = -Infinity;
    for (const X of T.xings) {
        const q = X.q;
        if (Math.abs(x - q.x) > q.band + 6 * u || Math.abs(z - q.z) > q.band + 6 * u) continue;
        crossingFrame(q, x, z, F);
        if (Math.abs(F.w) > q.band) continue;
        const core = LOCAL_M.crossCore * u / crossingSin(q), ramp = LOCAL_M.ramp * u, au = Math.abs(F.u);
        if (au > core + ramp) continue;
        const top = T.railTopAt(x - q.d[0] * F.u, z - q.d[1] * F.u) - 0.005 * u;
        const y = au <= core ? top : top + (base - top) * ((au - core) / ramp);
        if (y > best) best = y;
    }
    return best;
}
const _fr = { u: 0, w: 0 };

/** The surface a car / walker stands on at a layout point: the ground `base`, or the crossing boards over it. */
export function crossingSurfaceY(T: LocalTrack | null, x: number, z: number, base: number): number {
    if (!T) return base;
    const h = crossingHumpY(T, x, z, base);
    return h > base ? h : base;
}

/** One barrier arm: pivot (layout x/z, world y), the unit direction the lowered arm points (layout), its length, and
 *  the crossing + approach side it belongs to. */
export interface LocalArm { xing: number; side: 1 | -1; x: number; y: number; z: number; dir: V2; len: number }

/** The barrier arms (2 per crossing, one per approach on its left kerb, diagonal like a narrow-road fumikiri). */
export function localArms(graph: WorldGraph): LocalArm[] {
    const T = localTrack(graph);
    if (!T) return [];
    const u = T.unitsPerMetre, out: LocalArm[] = [];
    const elev = groundFn(graph);
    for (const X of T.xings) {
        const q = X.q, sA = crossingSin(q), R: V2 = [-q.d[1], q.d[0]];
        for (const sg of [-1, 1] as const) {
            const uB = sg * LOCAL_M.barrier * u / sA, wB = sg * (q.band - 0.45 * u);
            const x = q.x + q.d[0] * uB + R[0] * wB, z = q.z + q.d[1] * uB + R[1] * wB;
            out.push({ xing: q.id, side: sg, x, z, y: elev(x, z) + 0.9 * u, dir: [-sg * R[0], -sg * R[1]], len: q.band - 0.3 * u });
        }
    }
    return out;
}

/** Ground at a layout point for the props (the pavement they stand on, or the boards). */
function groundFn(graph: WorldGraph): (x: number, z: number) => number {
    const p = graph.params, hf = makeHeightField(p), D = streetDims(p);
    // Crossing props stand on the PAVEMENT (kerb-raised) — the corridor's own ground is the block paving too.
    return (x, z) => p.groundY + hf(x, z) + D.kerbH;
}

/** Walker destinations at the local stations: the foot of each platform stair (layout point + the way out). */
export function localStationEntrances(graph: WorldGraph): { x: number; z: number; ox: number; oz: number }[] {
    const T = localTrack(graph);
    if (!T) return [];
    const u = T.unitsPerMetre, out: { x: number; z: number; ox: number; oz: number }[] = [];
    for (const st of T.plan.stations) {
        const g = stairGeom(T, st);
        out.push({ x: g.footX, z: g.footZ, ox: g.outX, oz: 0 });
    }
    void u;
    return out;
}

/** Stair at a terminus platform's buffer end: descending away from the platform along the track. */
function stairGeom(T: LocalTrack, st: LocalLinePlan['stations'][number]): { x0: number; x1: number; lat0: number; lat1: number; rise: number; run: number; footX: number; footZ: number; outX: number; topY: number; zc: number } {
    const u = T.unitsPerMetre, pl = T.plan;
    const xEnd = st.end === 0 ? st.x0 : st.x1, out = st.end === 0 ? -1 : 1;
    const zc = localZAt(pl, xEnd);
    const topY = T.railTopAt(xEnd, zc) + LOCAL_M.platAboveRail * u;
    const pave = topY - (LOCAL_M.railTopAbovePave + LOCAL_M.platAboveRail) * u;
    const rise = topY - pave, run = rise / Math.tan(34 * Math.PI / 180);
    const lat0 = LOCAL_M.platEdge + 0.25, lat1 = LOCAL_M.platEdge + LOCAL_M.platW;
    const x0 = Math.min(xEnd, xEnd + out * run), x1 = Math.max(xEnd, xEnd + out * run);
    const footX = xEnd + out * (run + 0.5 * u), footZ = zc + st.side * (lat0 + lat1) / 2 * u;
    return { x0, x1, lat0, lat1, rise, run, footX, footZ, outX: out, topY, zc };
}

// ── Geometry helpers ───────────────────────────────────────────────────────────────────────────────────────────────
/** A cross-section frame along the track: layout point, base Y, unit lateral normal (+z side of +x travel). */
interface Fr { x: number; z: number; y: number; nx: number; nz: number }

/** Sweep a closed/open (lateral, height) profile along frames; flat per-face normals pointing away from the profile's
 *  centre. UV u = arc along the sweep (world units), v = profile distance. */
function sweep(acc: Accum3D, frs: Fr[], prof: [number, number][], closed: boolean): void {
    if (frs.length < 2 || prof.length < 2) return;
    const cl = prof.reduce((a, q) => a + q[0], 0) / prof.length, ch = prof.reduce((a, q) => a + q[1], 0) / prof.length;
    const P = (f: Fr, q: [number, number]): V3 => [f.x + f.nx * q[0], f.y + q[1], f.z + f.nz * q[0]];
    let arc = 0;
    const edges = closed ? prof.length : prof.length - 1;
    const vAt: number[] = [0];
    for (let k = 1; k <= prof.length; k++) { const a = prof[k - 1], b = prof[k % prof.length]; vAt.push(vAt[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    for (let i = 0; i + 1 < frs.length; i++) {
        const f0 = frs[i], f1 = frs[i + 1];
        const seg = Math.hypot(f1.x - f0.x, f1.z - f0.z, f1.y - f0.y);
        for (let k = 0; k < edges; k++) {
            const qa = prof[k], qb = prof[(k + 1) % prof.length];
            const a = P(f0, qa), b = P(f0, qb), c = P(f1, qb), d = P(f1, qa);
            const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: V3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
            let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const nl = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl];
            // outward: away from the profile centre at this frame
            const mid: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
            const cen = P(f0, [cl, ch]);
            if (n[0] * (mid[0] - cen[0]) + n[1] * (mid[1] - cen[1]) + n[2] * (mid[2] - cen[2]) < 0) n = [-n[0], -n[1], -n[2]];
            const va = acc.vertex(a, n, arc, vAt[k]), vb = acc.vertex(b, n, arc, vAt[k + 1]);
            const vc = acc.vertex(c, n, arc + seg, vAt[k + 1]), vd = acc.vertex(d, n, arc + seg, vAt[k]);
            acc.triangle(va, vb, vc); acc.triangle(va, vc, vd);
        }
        arc += seg;
    }
}

/** A flat horizontal ribbon between lateral offsets l0..l1 at height h over the frames (paint lines, edge strips). */
function ribbon(acc: Accum3D, frs: Fr[], l0: number, l1: number, h: number): void {
    const up: V3 = [0, 1, 0];
    let arc = 0;
    for (let i = 0; i + 1 < frs.length; i++) {
        const f0 = frs[i], f1 = frs[i + 1], seg = Math.hypot(f1.x - f0.x, f1.z - f0.z);
        const a = acc.vertex([f0.x + f0.nx * l0, f0.y + h, f0.z + f0.nz * l0], up, arc, 0);
        const b = acc.vertex([f0.x + f0.nx * l1, f0.y + h, f0.z + f0.nz * l1], up, arc, Math.abs(l1 - l0));
        const c = acc.vertex([f1.x + f1.nx * l1, f1.y + h, f1.z + f1.nz * l1], up, arc + seg, Math.abs(l1 - l0));
        const d = acc.vertex([f1.x + f1.nx * l0, f1.y + h, f1.z + f1.nz * l0], up, arc + seg, 0);
        acc.triangle(a, b, c); acc.triangle(a, c, d);
        arc += seg;
    }
}

/** A quad with the city ground's WORLD uv (x·½, z·½ — preview.ts), so a procedural ground surface continues seamlessly. */
function quadWorldUV(acc: Accum3D, v: V3[]): void {
    const e1: V3 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], e2: V3 = [v[3][0] - v[0][0], v[3][1] - v[0][1], v[3][2] - v[0][2]];
    let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    const ix = v.map(q => acc.vertex(q, n, q[0] * 0.5, q[2] * 0.5));
    acc.triangle(ix[0], ix[1], ix[2]); acc.triangle(ix[0], ix[2], ix[3]);
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// ── The static build ───────────────────────────────────────────────────────────────────────────────────────────────
/** All static local-line layers (empty when the graph has no local line). `parkedTrain` adds the consist parked at
 *  the first station (the moving sim hides it). */
export function buildLocalLine(graph: WorldGraph, parkedTrain = true): LayoutPreviewLayer[] {
    const T = localTrack(graph);
    if (!T) return [];
    const p = graph.params, pl = T.plan, u = pl.u, M = (m: number): number => m * u, gy = p.groundY;
    const hf = makeHeightField(p), D = streetDims(p);
    const paveAt = (x: number, z: number): number => gy + hf(x, z) + D.kerbH;
    const metalScale = metalScaleFor(p.radius);
    const A = (): Accum3D => new Accum3D();
    const ballast = A(), sleeper = A(), rail = A(), fence = A(), fenceMesh = A(), mast = A(), wire = A();
    const board = A(), rampAcc = A(), paint = A(), paintY = A();
    const xProp = A(), xStripe = A(), xArm = A(), xDark = A();
    const lamps: Map<string, Accum3D> = new Map();
    const platform = A(), edge = A(), tactile = A(), shelter = A(), stair = A(), prop = A(), signLit = A(), stnLamp = A(), buffer = A(), bufferSign = A();
    const F = { u: 0, w: 0 };

    // Frames along the layout samples.
    const frames: Fr[] = T.pts.map((q, i) => {
        const t = localTangentAt(pl, q[0]);
        return { x: q[0], z: q[1], y: T.y[i], nx: -t[1], nz: t[0] };
    });
    const frameAt = (x: number, y?: number): Fr => {
        const z = localZAt(pl, x), t = localTangentAt(pl, x);
        return { x, z, y: y ?? T.railTopAt(x, z), nx: -t[1], nz: t[0] };
    };
    // Is this track point inside a crossing's street band (boards, no bed / sleepers / fence)?
    const inRoad = (x: number, z: number, pad: number): boolean => {
        for (const X of T.xings) {
            const q = X.q;
            if (Math.abs(x - q.x) > q.band * 3 + pad) continue;
            crossingFrame(q, x, z, F);
            if (Math.abs(F.u) < 3 * q.band && Math.abs(F.w) < q.band + pad) return true;
        }
        return false;
    };
    const runs = (pad: number, lat = 0): Fr[][] => {
        const out: Fr[][] = [];
        let cur: Fr[] = [];
        for (const f of frames) {
            const lx = f.x + f.nx * lat, lz = f.z + f.nz * lat;
            if (inRoad(lx, lz, pad)) { if (cur.length >= 2) out.push(cur); cur = []; continue; }
            cur.push(f);
        }
        if (cur.length >= 2) out.push(cur);
        return out;
    };
    const railTopOff = LOCAL_M.railTopAbovePave;   // metres over the block paving
    const rel = (m: number): number => M(m - railTopOff);   // a height given over the PAVING, relative to the rail top

    // ── Track bed + sleepers ──
    for (const r of runs(M(0.15))) sweep(ballast, r, [[M(1.95), rel(0.004)], [M(1.45), rel(LOCAL_M.ballastTop + 0.06)], [-M(1.45), rel(LOCAL_M.ballastTop + 0.06)], [-M(1.95), rel(0.004)]], false);
    {
        const pitch = M(LOCAL_M.sleeperPitch);
        let acc = 0;
        for (let i = 0; i + 1 < frames.length; i++) {
            const f0 = frames[i], f1 = frames[i + 1], seg = Math.hypot(f1.x - f0.x, f1.z - f0.z);
            while (acc <= seg) {
                const t = acc / seg, x = f0.x + (f1.x - f0.x) * t, z = f0.z + (f1.z - f0.z) * t, y = f0.y + (f1.y - f0.y) * t;
                if (!inRoad(x, z, M(0.1)) && x > pl.x0 + M(0.3) && x < pl.x1 - M(0.3)) {
                    const tt = localTangentAt(pl, x), nx = -tt[1], nz = tt[0];
                    const sy = y - M(0.165 + 0.01) - M(LOCAL_M.sleeperH) / 2;
                    sleeper.obox([x, sy, z], [nx, 0, nz], [0, 1, 0], [tt[0], 0, tt[1]], M(LOCAL_M.sleeperL) / 2, M(LOCAL_M.sleeperH) / 2, M(LOCAL_M.sleeperW) / 2);
                }
                acc += pitch;
            }
            acc -= seg;
        }
    }
    // ── I-profile rails (continuous across the crossings, flush with the boards) ──
    {
        const rh = M(0.165), hh = M(0.0325);
        const g2 = M(LOCAL_M.gauge) / 2 + hh;
        const iProfile = (c: number): [number, number][] => [
            [c - M(0.065), -rh], [c + M(0.065), -rh], [c + M(0.065), -rh + M(0.012)], [c + M(0.008), -rh + M(0.03)], [c + M(0.008), -M(0.045)],
            [c + hh, -M(0.037)], [c + hh, 0], [c - hh, 0], [c - hh, -M(0.037)], [c - M(0.008), -M(0.045)],
            [c - M(0.008), -rh + M(0.03)], [c - M(0.065), -rh + M(0.012)],
        ];
        for (const sd of [1, -1]) sweep(rail, frames, iProfile(sd * g2), true);
        // Buffer stops at both ends: a steel frame + a red / white board.
        for (const [x, dir] of [[pl.x0, -1], [pl.x1, 1]] as const) {
            const f = frameAt(x), t = localTangentAt(pl, x), ax: V3 = [t[0], 0, t[1]], lat: V3 = [f.nx, 0, f.nz];
            for (const sd of [1, -1]) buffer.obox([f.x + f.nx * sd * M(0.75), f.y + M(0.45), f.z + f.nz * sd * M(0.75)], ax, [0, 1, 0], lat, M(0.08), M(0.55), M(0.08));
            buffer.obox([f.x - t[0] * dir * M(0.2), f.y + M(0.35), f.z - t[1] * dir * M(0.2)], norm([t[0] + 0.0, -0.5, t[1]]), [0, 1, 0], lat, M(0.5), M(0.06), M(0.08));
            bufferSign.obox([f.x + t[0] * dir * M(0.1), f.y + M(0.85), f.z + t[1] * dir * M(0.1)], ax, [0, 1, 0], lat, M(0.03), M(0.25), M(0.95));
        }
    }

    // ── Fences (both sides; the platform side of a station has the platform's back fence instead) ──
    {
        const fh = M(LOCAL_M.fenceH), postEvery = M(2.4);
        for (const sd of [1, -1] as const) {
            const latAt = (x: number): number => localHalfWidth(pl, x, sd) > pl.hw + 1e-9 ? sd * M(LOCAL_M.platBack + 0.05) : sd * M(LOCAL_M.fence);
            for (const r of runs(M(0.35), sd * M(LOCAL_M.fence))) {
                // Skip the stretch beyond the buffer stops' stairs (the station entrance side stays open at the end).
                const rr = r.filter(f => f.x > pl.x0 - M(0.2) && f.x < pl.x1 + M(0.2));
                if (rr.length < 2) continue;
                const base = rr.map(f => ({ ...f, y: paveAt(f.x + f.nx * latAt(f.x), f.z + f.nz * latAt(f.x)) }));
                // top + mid rails as thin boxes along the run, posts at a pitch, a see-through mesh panel between
                const lats = rr.map(f => latAt(f.x));
                const railProf = (h: number): [number, number][] => [[-M(0.025), h - M(0.025)], [M(0.025), h - M(0.025)], [M(0.025), h + M(0.025)], [-M(0.025), h + M(0.025)]];
                // Build per-frame offset frames (lateral baked into x/z so a width change at a platform end steps cleanly).
                const off = base.map((f, i) => ({ x: f.x + f.nx * lats[i], z: f.z + f.nz * lats[i], y: f.y, nx: f.nx, nz: f.nz }));
                sweep(fence, off, railProf(fh), true);
                sweep(fence, off, railProf(fh * 0.5), true);
                sweep(fenceMesh, off, [[0, M(0.08)], [0, fh - M(0.02)]], false);
                let acc = 0;
                for (let i = 0; i + 1 < off.length; i++) {
                    const f0 = off[i], f1 = off[i + 1], seg = Math.hypot(f1.x - f0.x, f1.z - f0.z);
                    while (acc <= seg) {
                        const t = acc / seg, x = f0.x + (f1.x - f0.x) * t, z = f0.z + (f1.z - f0.z) * t, y = f0.y + (f1.y - f0.y) * t;
                        fence.obox([x, y + fh / 2, z], [1, 0, 0], [0, 1, 0], [0, 0, 1], M(0.03), fh / 2, M(0.03));
                        acc += postEvery;
                    }
                    acc -= seg;
                }
            }
        }
    }

    // ── Catenary: a mast every ~30 m on one side, a bracket to the wire, messenger + contact wire with droppers ──
    {
        const mside: 1 | -1 = pl.stations.length && pl.stations[0].side === 1 ? -1 : 1;
        const supports: { x: number; z: number; y: number; wx: number; wz: number }[] = [];
        const span = M(30), n = Math.max(2, Math.round((pl.x1 - pl.x0) / span));
        for (let k = 0; k <= n; k++) {
            let x = pl.x0 + M(2) + (pl.x1 - pl.x0 - M(4)) * k / n;
            // slide off the crossing boards / road bands
            for (let tries = 0; tries < 12 && inRoad(x, localZAt(pl, x), M(1.2)); tries++) x += (k === n ? -1 : 1) * M(1.5);
            const f = frameAt(x);
            const lat = localHalfWidth(pl, x, mside) > pl.hw + 1e-9 ? mside * M(LOCAL_M.platBack - 0.2) : mside * M(LOCAL_M.fence - 0.35);
            const bx = f.x + f.nx * lat, bz = f.z + f.nz * lat, by = paveAt(bx, bz);
            const top = f.y + M(LOCAL_M.contactAboveRail + 1.5);
            mast.obox([bx, (by + top) / 2, bz], [f.nx, 0, f.nz], [0, 1, 0], [-f.nz, 0, f.nx], M(0.11), (top - by) / 2, M(0.11));
            const stag = (k % 2 ? 1 : -1) * M(0.2);
            const wx = f.x + f.nx * stag, wz = f.z + f.nz * stag, cy = f.y + M(LOCAL_M.contactAboveRail);
            // bracket (messenger support) + steady arm (contact wire)
            mast.beam([bx, cy + M(1.2), bz], [f.x - f.nx * mside * M(0.35), cy + M(1.2), f.z - f.nz * mside * M(0.35)], M(0.05), 4);
            mast.beam([bx, cy + M(0.25), bz], [wx, cy + M(0.02), wz], M(0.03), 4);
            supports.push({ x: f.x, z: f.z, y: cy, wx, wz });
        }
        const r = M(0.012);
        for (let i = 0; i + 1 < supports.length; i++) {
            const a = supports[i], b = supports[i + 1];
            wire.beam([a.wx, a.y, a.wz], [b.wx, b.y, b.wz], r, 3);                                    // contact wire (level)
            const ma: V3 = [a.x, a.y + M(1.1), a.z], mb: V3 = [b.x, b.y + M(1.1), b.z];
            catenary(wire, ma, mb, M(0.35), 8, r);                                                     // messenger
            for (let k = 1; k < 6; k++) {                                                             // droppers
                const t = k / 6, dip = 4 * M(0.35) * t * (1 - t);
                const mx = ma[0] + (mb[0] - ma[0]) * t, my = ma[1] + (mb[1] - ma[1]) * t - dip, mz = ma[2] + (mb[2] - ma[2]) * t;
                const cx = a.wx + (b.wx - a.wx) * t, cy2 = a.y + (b.y - a.y) * t, cz = a.wz + (b.wz - a.wz) * t;
                wire.beam([mx, my, mz], [cx, cy2, cz], r * 0.6, 3);
            }
        }
    }

    // ── Level crossings ──
    const elevBase = (x: number, z: number): number => {
        // the road / pavement the boards sit on: road level on the carriageway, kerb-raised on the pavement
        const q = nearestXing(T, x, z);
        if (q) { crossingFrame(q, x, z, F); if (Math.abs(F.w) <= q.roadHalf) return gy + hf(x, z); }
        return paveAt(x, z);
    };
    for (const X of T.xings) {
        const q = X.q, sA = crossingSin(q), R: V2 = [-q.d[1], q.d[0]];
        const core = M(LOCAL_M.crossCore) / sA, ramp = M(LOCAL_M.ramp);
        const P2 = (uu: number, ww: number): V2 => [q.x + q.d[0] * uu + R[0] * ww, q.z + q.d[1] * uu + R[1] * ww];
        const surf = (x: number, z: number, lift: number): number => { const b = elevBase(x, z); return Math.max(b, crossingHumpY(T, x, z, b)) + lift; };
        // Boards (rubber / concrete panels) over the track core, asphalt ramps up to them, across the whole street band.
        const nw = Math.max(4, Math.ceil(2 * q.band / M(0.8)));
        const us: number[] = [];
        for (let i = 0; i <= 3; i++) us.push(-(core + ramp) + ramp * i / 3);
        for (let i = 1; i <= 4; i++) us.push(-core + 2 * core * i / 4);
        for (let i = 1; i <= 3; i++) us.push(core + ramp * i / 3);
        for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j < nw; j++) {
            const w0 = -q.band + 2 * q.band * j / nw, w1 = -q.band + 2 * q.band * (j + 1) / nw;
            const c: V2[] = [P2(us[i], w0), P2(us[i + 1], w0), P2(us[i + 1], w1), P2(us[i], w1)];
            const inCore = Math.abs((us[i] + us[i + 1]) / 2) < core;
            const v: V3[] = c.map(pt => [pt[0], surf(pt[0], pt[1], M(inCore ? 0.004 : 0.003)), pt[1]] as V3);
            if (inCore) board.quad4(v[0], v[1], v[2], v[3]); else quadWorldUV(rampAcc, v);   // (the road's own uv = worldXZ·½ → the asphalt continues)
        }
        // Paint: stop bars on each approach lane, white edge lines through the crossing, a yellow centre line.
        const bar = (uc: number, w0: number, w1: number, acc: Accum3D, depth: number): void => {
            const c: V2[] = [P2(uc - depth / 2, w0), P2(uc + depth / 2, w0), P2(uc + depth / 2, w1), P2(uc - depth / 2, w1)];
            const v: V3[] = c.map(pt => [pt[0], surf(pt[0], pt[1], M(0.012)), pt[1]] as V3);
            acc.quad4(v[0], v[1], v[2], v[3]);
        };
        const uStop = M(LOCAL_M.barrier + LOCAL_M.stopLine) / sA;
        for (const sg of [-1, 1] as const) bar(sg * uStop, sg > 0 ? 0 : -q.roadHalf + M(0.2), sg > 0 ? q.roadHalf - M(0.2) : 0, paint, M(0.45));
        for (const ww of [-q.roadHalf + M(0.25), q.roadHalf - M(0.25)]) {
            for (let k = 0; k < 8; k++) { const a = -uStop + 2 * uStop * k / 8, b = -uStop + 2 * uStop * (k + 1) / 8; const c: V2[] = [P2(a, ww - M(0.07)), P2(b, ww - M(0.07)), P2(b, ww + M(0.07)), P2(a, ww + M(0.07))]; const v: V3[] = c.map(pt => [pt[0], surf(pt[0], pt[1], M(0.012)), pt[1]] as V3); paint.quad4(v[0], v[1], v[2], v[3]); }
        }
        for (let k = 0; k < 8; k++) { const a = -uStop + 2 * uStop * k / 8, b = -uStop + 2 * uStop * (k + 1) / 8; const c: V2[] = [P2(a, -M(0.06)), P2(b, -M(0.06)), P2(b, M(0.06)), P2(a, M(0.06))]; const v: V3[] = c.map(pt => [pt[0], surf(pt[0], pt[1], M(0.012)), pt[1]] as V3); paintY.quad4(v[0], v[1], v[2], v[3]); }

        // Equipment per approach (sg = the side of the track the approach comes from): the barrier machine on the
        // approach's left pavement edge, the warning mast just behind it, facing the oncoming traffic.
        for (const sg of [-1, 1] as const) {
            const face: V3 = [q.d[0] * sg, 0, q.d[1] * sg];                       // toward the approaching road user
            const across: V3 = [R[0], 0, R[1]];
            const uB = sg * M(LOCAL_M.barrier) / sA, wB = sg * (q.band - M(0.45));
            const [bx, bz] = P2(uB, wB), by = paveAt(bx, bz);
            // barrier machine (grey housing + yellow / black stripe sleeve)
            xProp.obox([bx, by + M(0.5), bz], face, [0, 1, 0], across, M(0.2), M(0.5), M(0.22));
            xStripe.obox([bx, by + M(0.72), bz], face, [0, 1, 0], across, M(0.21), M(0.18), M(0.23));
            // the RAISED arm (static; the live arms replace it while the traffic sim runs)
            const armLen = q.band - M(0.3);
            xArm.obox([bx, by + M(0.9) + armLen / 2, bz], face, [0, 1, 0], across, M(0.03), armLen / 2, M(0.04));
            // warning mast: pole, crossbuck at the top, two red lamps side by side with black backplates + visors
            const [mx, mz] = P2(sg * (M(LOCAL_M.barrier + 0.5) / sA), sg * (q.band - M(0.3))), my = paveAt(mx, mz);
            xProp.obox([mx, my + M(1.75), mz], [1, 0, 0], [0, 1, 0], [0, 0, 1], M(0.05), M(1.75), M(0.05));
            // crossbuck (X): two slim plates at ±40° in the plane facing the approach
            for (const ang of [0.7, -0.7]) {
                const ay: V3 = norm([across[0] * Math.sin(ang), Math.cos(ang), across[2] * Math.sin(ang)]);
                const ax: V3 = norm([across[0] * Math.cos(ang), -Math.sin(ang), across[2] * Math.cos(ang)]);
                xStripe.obox([mx + face[0] * M(0.07), my + M(3.05), mz + face[2] * M(0.07)], ax, ay, face, M(0.55), M(0.07), M(0.012));
            }
            // lamp backplate + lamps: the pair spans ACROSS the road; 'a' = the viewer's left
            xDark.obox([mx + face[0] * M(0.04), my + M(2.35), mz + face[2] * M(0.04)], across, [0, 1, 0], face, M(0.42), M(0.2), M(0.015));
            for (const [k, sd] of [['a', 1], ['b', -1]] as const) {
                const lx = mx + face[0] * M(0.07) + across[0] * sg * sd * M(0.24), lz = mz + face[2] * M(0.07) + across[2] * sg * sd * M(0.24);
                const key = `world:local-xing-lamp-${q.id}${k}`;
                let acc = lamps.get(key); if (!acc) { acc = A(); lamps.set(key, acc); }
                acc.disc([lx, my + M(2.35), lz], face, M(0.13), 12);
                xDark.obox([lx + face[0] * M(0.1), my + M(2.5), lz + face[2] * M(0.1)], face, [0, 1, 0], across, M(0.1), M(0.012), M(0.15));   // visor
            }
            // direction indicator box + the bell (a small dome) above the crossbuck
            xDark.obox([mx + face[0] * M(0.05), my + M(1.95), mz + face[2] * M(0.05)], across, [0, 1, 0], face, M(0.2), M(0.09), M(0.03));
            xProp.lathe([mx, my + M(3.5), mz], [0, 1, 0], [[M(0.09), 0], [M(0.08), M(0.08)], [0.001, M(0.12)]], 8);
        }
    }

    // ── Stations: side platform, edge line + tactile strip, shelter, bench, lit name board, lamps, stair at the end ──
    for (const st of pl.stations) {
        const sd = st.side, n = Math.max(2, Math.ceil((st.x1 - st.x0) / M(1.5)));
        const frs: Fr[] = [];
        for (let i = 0; i <= n; i++) frs.push(frameAt(st.x0 + (st.x1 - st.x0) * i / n));
        const e0 = sd * M(LOCAL_M.platEdge), e1 = sd * M(LOCAL_M.platEdge + LOCAL_M.platW);
        const top = M(LOCAL_M.platAboveRail), bot = rel(0.0);
        sweep(platform, frs, [[e0, bot], [e0, top], [e1, top], [e1, bot]], true);
        ribbon(edge, frs, e0 + sd * M(0.04), e0 + sd * M(0.14), top + M(0.004));
        ribbon(tactile, frs, e0 + sd * M(0.8), e0 + sd * M(1.1), top + M(0.004));
        // shelter over the middle half: posts at the back, a slightly sloped roof toward the track
        const xa = st.x0 + (st.x1 - st.x0) * 0.25, xb = st.x0 + (st.x1 - st.x0) * 0.75;
        const nPost = Math.max(2, Math.round((xb - xa) / M(3.2)) + 1);
        for (let k = 0; k < nPost; k++) {
            const f = frameAt(xa + (xb - xa) * k / (nPost - 1)), lat = e1 - sd * M(0.35);
            shelter.obox([f.x + f.nx * lat, f.y + top + M(1.3), f.z + f.nz * lat], [1, 0, 0], [0, 1, 0], [0, 0, 1], M(0.06), M(1.3), M(0.06));
        }
        const rf: Fr[] = [];
        for (let i = 0; i <= 6; i++) rf.push(frameAt(xa - M(0.4) + (xb - xa + M(0.8)) * i / 6));
        sweep(shelter, rf, [[e1 + sd * M(0.05), top + M(2.62)], [e0 + sd * M(0.55), top + M(2.48)], [e0 + sd * M(0.55), top + M(2.54)], [e1 + sd * M(0.05), top + M(2.7)]], true);
        ribbon(stnLamp, rf.slice(1, 6), e0 + sd * M(0.95), e0 + sd * M(1.25), top + M(2.47));
        // bench under the shelter, facing the track
        {
            const f = frameAt((xa + xb) / 2), lat = e1 - sd * M(0.7), t = localTangentAt(pl, f.x);
            prop.obox([f.x + f.nx * lat, f.y + top + M(0.42), f.z + f.nz * lat], [t[0], 0, t[1]], [0, 1, 0], [f.nx, 0, f.nz], M(0.9), M(0.03), M(0.2));
            prop.obox([f.x + f.nx * (lat + sd * M(0.2)), f.y + top + M(0.65), f.z + f.nz * (lat + sd * M(0.2))], [t[0], 0, t[1]], [0, 1, 0], [f.nx, 0, f.nz], M(0.9), M(0.2), M(0.02));
            for (const e of [-0.8, 0.8]) prop.obox([f.x + t[0] * M(e) + f.nx * lat, f.y + top + M(0.2), f.z + t[1] * M(e) + f.nz * lat], [t[0], 0, t[1]], [0, 1, 0], [f.nx, 0, f.nz], M(0.03), M(0.2), M(0.18));
        }
        // lit name board on two posts near the stair end, facing the track
        {
            const xs = st.end === 0 ? st.x0 + M(5) : st.x1 - M(5), f = frameAt(xs), lat = e1 - sd * M(0.3), t = localTangentAt(pl, xs);
            for (const e of [-0.9, 0.9]) prop.obox([f.x + t[0] * M(e) + f.nx * lat, f.y + top + M(1.1), f.z + t[1] * M(e) + f.nz * lat], [1, 0, 0], [0, 1, 0], [0, 0, 1], M(0.04), M(1.1), M(0.04));
            signLit.obox([f.x + f.nx * lat, f.y + top + M(2.0), f.z + f.nz * lat], [t[0], 0, t[1]], [0, 1, 0], [f.nx, 0, f.nz], M(1.05), M(0.22), M(0.04));
        }
        // stair down at the buffer end (steps descending away from the platform), + hand rails
        {
            const g = stairGeom(T, st), out = g.outX, xEnd = st.end === 0 ? st.x0 : st.x1;
            const nSteps = Math.max(4, Math.round(g.rise / M(0.17))), t = localTangentAt(pl, xEnd);
            const lat0 = sd * M(g.lat0), lat1 = sd * M(g.lat1), latC = (lat0 + lat1) / 2, hw = Math.abs(lat1 - lat0) / 2;
            const f = frameAt(xEnd);
            for (let k = 0; k < nSteps; k++) {
                const x0 = (k / nSteps) * g.run, x1 = ((k + 1) / nSteps) * g.run;
                const yTop = g.topY - g.rise * (k + 1) / nSteps + (g.rise / nSteps);
                const cx = f.x + t[0] * out * (x0 + x1) / 2 + f.nx * latC, cz = f.z + t[1] * out * (x0 + x1) / 2 + f.nz * latC;
                const yb = paveAt(cx, cz);
                stair.obox([cx, (yTop + yb) / 2, cz], [t[0], 0, t[1]], [0, 1, 0], [f.nx, 0, f.nz], (x1 - x0) / 2, Math.max(M(0.02), (yTop - yb) / 2), hw);
            }
            for (const l of [lat0, lat1]) prop.beam([f.x + f.nx * l, g.topY + M(0.9), f.z + f.nz * l], [f.x + t[0] * out * g.run + f.nx * l, g.topY - g.rise + M(0.9), f.z + t[1] * out * g.run + f.nz * l], M(0.025), 4);
        }
    }

    // ── Emit ──
    const L: LayoutPreviewLayer[] = [];
    const add = (name: string, color: RGB, acc: Accum3D | MeshGeometry, extra: Partial<LayoutPreviewLayer> = {}): void => {
        const geo = acc instanceof Accum3D ? (acc.empty ? null : acc.geometry()) : acc;
        if (geo && geo.indices.length) L.push({ name, color, y: gy, geometry: geo, drape: 'baked', ...extra });
    };
    const metal = (tint: RGB, extra: Partial<NonNullable<LayoutPreviewLayer['metal']>> = {}): Partial<LayoutPreviewLayer> => ({ metal: { ...METAL_PAINTED, tint, scale: metalScale, ...extra } });
    const stripes = (a: RGB, b: RGB, every: number, angle = 0.785): Partial<LayoutPreviewLayer> => ({ pattern: { color: b, freq: 1 / (every * u), scale: 0.5, mode: 'stripes', angle } });
    // STRUCTURE
    add('world:local-ballast', BALLAST, ballast, { pattern: { color: [0.30, 0.29, 0.27], freq: 1 / (0.07 * u), scale: 0.45, mode: 'dots' } });
    add('world:local-board', BOARD, board, { pattern: { color: [0.11, 0.11, 0.12], freq: 1 / (0.5 * u), scale: 0.06, mode: 'grid' } });
    add('world:local-ramp', ROAD, rampAcc, { ground: { surface: 'asphalt', tint: ROAD, metersPerUnit: cityMetresPerUnit(p.radius) } });
    add('world:local-paint', PAINT, paint, { emissive: 0.08 });
    add('world:local-paint-yellow', YELLOW, paintY, { emissive: 0.08 });
    add('world:local-platform', PLATFORM, platform, { pattern: { color: [0.52, 0.51, 0.49], freq: 1 / (0.6 * u), scale: 0.04, mode: 'grid' } });
    add('world:local-stn-edge', EDGE_WHITE, edge, { emissive: 0.08 });
    add('world:local-stn-tactile', TACTILE, tactile, { pattern: { color: [0.7, 0.54, 0.06], freq: 1 / (0.05 * u), scale: 0.4, mode: 'stripes' } });
    add('world:local-stn-shelter', SHELTER, shelter, metal(SHELTER, { streakAmount: 0.4 }));
    add('world:local-stn-stair', CONCRETE, stair, { pattern: { color: [0.5, 0.49, 0.47], freq: 1 / (0.3 * u), scale: 0.05, mode: 'grid' } });
    add('world:local-buffer', BUFFER_RED, buffer, metal(BUFFER_RED));
    add('world:local-buffer-sign', [0.92, 0.92, 0.9], bufferSign, stripes([0.92, 0.92, 0.9], BUFFER_RED, 0.25, 0));
    // FINE
    add('world:local-fine-sleeper', SLEEPER, sleeper, { pattern: { color: [0.44, 0.43, 0.41], freq: 1 / (0.5 * u), scale: 0.05, mode: 'grid' } });
    add('world:local-fine-rail', RAIL, rail, metal(STEEL, { roughness: 0.3, grime: 0.2 }));
    add('world:local-fine-fence', FENCE, fence, metal(FENCE, { streakAmount: 0.3 }));
    add('world:local-fine-fence-mesh', FENCE, fenceMesh, { pattern: { color: [0.62, 0.66, 0.62], freq: 1 / (0.09 * u), scale: 0.12, mode: 'diamonds' }, opacity: 0.55 });
    add('world:local-fine-cat-mast', MAST, mast, metal(MAST));
    add('world:local-fine-cat-wire', WIRE, wire, { reflect: { strength: 0.1, roughness: 0.5 } } as Partial<LayoutPreviewLayer>);
    // PROPS
    add('world:local-prop', PROP, prop, metal(PROP));
    add('world:local-xing-prop', [0.62, 0.63, 0.62], xProp, metal([0.62, 0.63, 0.62]));
    add('world:local-xing-prop-stripe', YELLOW, xStripe, stripes(YELLOW, BLACK, 0.12));
    add('world:local-xing-prop-dark', BLACK, xDark, { reflect: { strength: 0.1, roughness: 0.4 } } as Partial<LayoutPreviewLayer>);
    add('world:local-xing-arm', YELLOW, xArm, stripes(YELLOW, BLACK, 0.3));
    // LIT (untiered): the alternating lamps start OFF (the ticker lights them), the station sign + lamps
    for (const [name, acc] of [...lamps.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) add(name, LAMP_OFF, acc, { emissive: 0.9 });
    add('world:local-stn-sign-lit', SIGN, signLit, { emissive: p.nightMode ? 1.0 : 0.55 });
    add('world:local-stn-lamplights', LAMP, stnLamp, { emissive: p.nightMode ? 1.0 : 0.6 });
    if (parkedTrain) L.push(...parkedLocalTrain(graph, T));
    return L;
}
function nearestXing(T: LocalTrack, x: number, z: number): LocalCrossingPlan | null {
    let best: LocalCrossingPlan | null = null, bd = Infinity;
    for (const X of T.xings) { const d = Math.hypot(x - X.q.x, z - X.q.z); if (d < bd) { bd = d; best = X.q; } }
    return best && bd < best.band * 4 ? best : null;
}

// ── The consist ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Length / width scale from the 20 m × 2.9 m EMU car to the 16 m × 2.7 m local car. */
export const LOCAL_KX = LOCAL_M.carLen / 20, LOCAL_KZ = LOCAL_M.width / EMU_WIDTH_M;
/** Real bogie half-spacing and door slide of the local car (metres). */
export const LOCAL_BOGIE_HALF_M = EMU_BOGIE_HALF_M * LOCAL_KX, LOCAL_DOOR_SLIDE_M = EMU_DOOR_SLIDE_M * LOCAL_KX;

/** The local livery: cream / orange unless the main line already wears it (then the green-stripe stainless). */
export function localLivery(p: { seed: number; railLivery?: string }): RailLivery {
    return railLivery(p).name === 'cream' ? 'green' : 'cream';
}

/** Scale a car geometry from the EMU size to the local car (positions x/z, normals by the inverse). */
function scaleCar(geo: MeshGeometry): MeshGeometry {
    const v = geo.vertices.slice();
    for (let i = 0; i < v.length; i += 12) {
        v[i] *= LOCAL_KX; v[i + 2] *= LOCAL_KZ;
        let nx = v[i + 3] / LOCAL_KX, ny = v[i + 4], nz = v[i + 5] / LOCAL_KZ;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        v[i + 3] = nx; v[i + 4] = ny; v[i + 5] = nz;
    }
    return { vertices: v, indices: geo.indices, format: geo.format };
}

type LocalVariant = 'cabP' | 'cab' | 'mid';
/** One local car variant at the origin along +x, rail top at y = 0 (the ticker lifts it). */
export function localCarLayers(p: Pick<LayoutParams, 'seed' | 'radius'> & Partial<LayoutParams>, v: LocalVariant, prefix = 'world:traffic-train-local'): LayoutPreviewLayer[] {
    const liv = localLivery(p), base: EmuVariant = v === 'mid' ? 'mid' : 'cab';
    return emuCarLayersEx(p, base, 0, prefix, { pantoOnCab: v === 'cabP', livery: liv }).map(L => ({
        ...L, geometry: scaleCar(L.geometry), instanceKey: `local:${liv}:${v}:${p.radius}:${p.nightMode ? 1 : 0}:${L.name}`,
    }));
}

/** Car list: the −x cab carries the pantograph (flipped so both cabs face out), mids between. */
export function localConsistPlan(n: number): { v: LocalVariant; flip: boolean }[] {
    const out: { v: LocalVariant; flip: boolean }[] = [];
    for (let i = 0; i < n; i++) out.push(i === 0 ? { v: 'cabP', flip: true } : i === n - 1 ? { v: 'cab', flip: false } : { v: 'mid', flip: i > n / 2 });
    return out;
}

export interface LocalConsist {
    path: [number, number][]; cum: number[]; heights: number[];
    count: number; spacing: number;
    variants: LayoutPreviewLayer[][]; pick: number[]; flip: boolean[];
    plan: TrainRunPlan; start: TrainRunState;
    /** Bogie half-spacing + door slide in world units. */
    bogieHalf: number; doorSlide: number;
}

/** The run plan for the local consist: terminus to terminus (the stations ARE the termini), a slower cruise. */
export function localRunPlan(p: LayoutParams, T: LocalTrack): { plan: TrainRunPlan; half: number } {
    const u = T.unitsPerMetre, n = T.plan.cars, half = n * LOCAL_M.carLen * u / 2;
    const plan = trainRunPlan(p, T.len, half, []);
    plan.cruise = 9 * u; plan.accel = 0.7 * u; plan.decel = 0.9 * u;
    return { plan, half };
}

export function localConsist(graph: WorldGraph): LocalConsist | null {
    const T = localTrack(graph);
    if (!T) return null;
    const p = graph.params, u = T.unitsPerMetre, n = T.plan.cars;
    const { plan } = localRunPlan(p, T);
    const variantsOrder: LocalVariant[] = ['cabP', 'cab', 'mid'];
    const variants = variantsOrder.map(v => localCarLayers(p, v));
    const cp = localConsistPlan(n);
    const start = trainRunStart(plan, 1, ((p.seed >>> 5) % 89) / 89 * 0.9);
    return {
        path: T.wpts, cum: T.cum, heights: T.y, count: n, spacing: LOCAL_M.carLen * u,
        variants, pick: cp.map(c => variantsOrder.indexOf(c.v)), flip: cp.map(c => c.flip), plan, start,
        bogieHalf: LOCAL_BOGIE_HALF_M * u, doorSlide: LOCAL_DOOR_SLIDE_M * u,
    };
}

/** Height + pitch of a car whose centre is at arc `d` (bogies at d ∓ hb) on a track with per-point heights. */
export function carHeightAt(cum: ArrayLike<number>, heights: ArrayLike<number>, d: number, hb: number, out: { y: number; pitch: number }): void {
    const ya = heightAtArc(cum, heights, d - hb), yb = heightAtArc(cum, heights, d + hb);
    out.y = (ya + yb) / 2; out.pitch = Math.atan2(yb - ya, 2 * hb);
}
export function heightAtArc(cum: ArrayLike<number>, heights: ArrayLike<number>, d: number): number {
    const n = cum.length - 1, dd = Math.max(0, Math.min(cum[n], d));
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= dd) lo = m; else hi = m; }
    const f = (dd - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
    return heights[lo] + (heights[hi] - heights[lo]) * f;
}

/** The consist parked at the first station, merged per material (the moving sim hides `world:local-train*`). Built in
 *  LAYOUT space (like the rails it sits on) so the drape pass warps it with them. */
function parkedLocalTrain(graph: WorldGraph, T: LocalTrack): LayoutPreviewLayer[] {
    const p = graph.params, u = T.unitsPerMetre, n = T.plan.cars;
    const { plan } = localRunPlan(p, T);
    const st = T.plan.stations[0];
    const sC = st ? (st.end === 0 ? plan.lo : plan.hi) : (plan.lo + plan.hi) / 2;
    // layout-space path (the uniform samples) + its own arc
    const lp = T.pts.map(q => [q[0], q[1]] as [number, number]);
    const lc = [0]; for (let i = 1; i < lp.length; i++) lc.push(lc[i - 1] + Math.hypot(lp[i][0] - lp[i - 1][0], lp[i][1] - lp[i - 1][1]));
    const k = lc[lc.length - 1] / Math.max(1e-9, T.len);   // warped arc → layout arc
    const variantsOrder: LocalVariant[] = ['cabP', 'cab', 'mid'];
    const cars = variantsOrder.map(v => localCarLayers(p, v, 'world:local-train'));
    const cp = localConsistPlan(n), pose = { x: 0, z: 0, yaw: 0 }, hp = { y: 0, pitch: 0 }, hb = LOCAL_BOGIE_HALF_M * u;
    const merged = new Map<string, { L: LayoutPreviewLayer; parts: MeshGeometry[] }>();
    cp.forEach((c, i) => {
        const d = (sC + (i - (n - 1) / 2) * LOCAL_M.carLen * u) * k;
        carPoseAt(lp, lc, d, hb, pose);
        carHeightAt(lc, T.y, d, hb, hp);
        const yaw = c.flip ? pose.yaw + Math.PI : pose.yaw, pitch = c.flip ? -hp.pitch : hp.pitch;
        for (const L of cars[variantsOrder.indexOf(c.v)]) {
            // parked: only the lead headlights / the rear tail lights
            if (/headlight$/.test(L.name) && c.flip) continue;
            if (/taillight$/.test(L.name) && !c.flip) continue;
            const g = poseGeo(L.geometry, pose.x, hp.y, pose.z, yaw, pitch);
            const e = merged.get(L.name);
            if (e) e.parts.push(g); else merged.set(L.name, { L, parts: [g] });
        }
    });
    const out: LayoutPreviewLayer[] = [];
    for (const { L, parts } of merged.values()) {
        const nv = parts.reduce((a, g) => a + g.vertices.length, 0), ni = parts.reduce((a, g) => a + g.indices.length, 0);
        const v = new Float32Array(nv), ix = new Uint32Array(ni);
        let vo = 0, io = 0;
        for (const g of parts) { v.set(g.vertices, vo); for (let j = 0; j < g.indices.length; j++) ix[io + j] = g.indices[j] + vo / 12; vo += g.vertices.length; io += g.indices.length; }
        const { instanceKey: _k, ...rest } = L; void _k;
        out.push({ ...rest, geometry: { vertices: v, indices: ix, format: '12float' }, drape: 'baked', noWarp: false });
    }
    return out;
}

/** Rotate a +x-built geometry by pitch (about z) then yaw (about y, +x → (cos, −sin)), translate. */
function poseGeo(geo: MeshGeometry, x: number, y: number, z: number, yaw: number, pitch: number): MeshGeometry {
    const v = geo.vertices.slice(), cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const rot = (a: number, b: number, c: number, o: number): void => {
        const px = a * cp - b * sp, py = a * sp + b * cp, pz = c;             // Rz(pitch)
        v[o] = px * cy + pz * sy; v[o + 1] = py; v[o + 2] = -px * sy + pz * cy;   // Ry(yaw)
    };
    for (let i = 0; i < v.length; i += 12) {
        rot(v[i], v[i + 1], v[i + 2], i); v[i] += x; v[i + 1] += y; v[i + 2] += z;
        rot(v[i + 3], v[i + 4], v[i + 5], i + 3);
    }
    return { vertices: v, indices: geo.indices, format: geo.format };
}
