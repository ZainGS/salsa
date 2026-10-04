// ── World generation — the EMU commuter train (railway-upgrade R1.5 + R2.2) ─────────────────────────
// ONE real-scale electric-multiple-unit car definition shared by the MOVING consist (traffic.ts → the WorldTraffic
// ticker) and the static PARKED train (buildParkedTrain, called by railway.ts when the live sim is off). All sizes are
// real METRES converted through the city's metres-per-unit, so the car is a true ~20 m × 2.9 m × 3.9 m commuter car
// whatever the diorama radius.
//
// A car = a profile EXTRUSION (flat sides with a tucked sill, a rounded roofline) + thin OVERLAYS proud of the side
// (window panes, door leaves + their windows, the livery bands) — so the side carries its detail without cutting
// the body, and a car stays ~1–2k triangles. Cab cars add a raked, tapered nose with a black mask, windscreen,
// destination sign, headlights + tail lights and a skirt; every car has bogies with wheels, underfloor boxes and
// roof AC units; some mid cars carry a raised single-arm pantograph.
//
// Materials, one family per mesh (city-materials.test.ts): glossy car-paint `reflect` for the livery layers,
// satin trim for the dark parts, painted `metal` for roof plant, and the facade INTERIOR-ROOM shader for the side
// glass (`pattern.mode 'windows'`, facade code 2 = open-plan glazing, cool fluorescent lit colour) — the same
// parallax interior + sky reflection the buildings use, lit at night by the glow walk.
//
// The RUN (R2.2): stepTrainRun drives a consist along its track with smooth acceleration, a cruise, a braking
// curve that stops the consist CENTRED on each station, a dwell (doors slide open), and a terminus reversal.
// Pure + deterministic; the ticker owns the state.

import type { LayoutPreviewLayer, LayoutParams } from './types';
import { cityMetresPerUnit, metalScaleFor } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';

type V3 = [number, number, number];

// ── Real dimensions (metres) ──────────────────────────────────────────────────────────────────────
/** Coupler-to-coupler car length (the consist spacing) and the body length. */
export const EMU_CAR_M = 20.0, EMU_BODY_M = 19.5;
/** Body width over the sides and roof height above the rail top (the AC units / pantograph sit above). */
export const EMU_WIDTH_M = 2.9, EMU_ROOF_M = 3.68, EMU_HEIGHT_M = 3.95;
/** Default consist length + the allowed range (param `railCars`). */
export const RAIL_CARS_DEFAULT = 8, RAIL_CARS_MIN = 2, RAIL_CARS_MAX = 10;
/** Door-leaf slide distance when the doors open (metres). */
export const EMU_DOOR_SLIDE_M = 0.64;
/** Door centres along the car (4 door sets per side). */
const DOORS = [-7.2, -2.4, 2.4, 7.2];
const HALF_BODY = EMU_BODY_M / 2;
const YB = 1.05;              // body bottom (sill) above the rail top
const ZS = EMU_WIDTH_M / 2;   // side plane

/** Half body PROFILE (z ≥ 0, from the sill up round the roof to the centre line) — [z, y] in metres. Segments
 *  0–1 are the LOWER body (a second livery colour on two-tone cars), 2–3 the upper side, the rest the ROOF (grey,
 *  smooth-shaded for the rounded roofline). */
const PROFILE: [number, number][] = [
    [1.39, YB], [1.45, 1.34], [1.45, 1.95], [1.45, 2.96], [1.40, 3.20],
    [1.29, 3.38], [1.04, 3.52], [0.70, 3.62], [0.35, 3.67], [0, EMU_ROOF_M],
];
const ROOF_FROM = 4;          // PROFILE index where the roof starts

// ── Liveries (generic, real-world-inspired, NO logos) ─────────────────────────────────────────────
export type RailLivery = 'green' | 'silver' | 'cream';
export const RAIL_LIVERIES: RailLivery[] = ['green', 'silver', 'cream'];
export interface LiverySpec {
    name: RailLivery;
    body: V3;          // upper body / door leaves
    lower: V3 | null;  // lower body (two-tone) — null = same as body
    band: V3;          // livery band colour
    bands: [number, number][];   // band y ranges (metres above rail top)
    roof: V3;
    paint: { strength: number; roughness: number };   // stainless = brighter + a touch rougher than enamel
}
const SILVER: V3 = [0.70, 0.72, 0.74];
const SILVER_BANDS: V3[] = [[0.13, 0.36, 0.74], [0.78, 0.16, 0.20], [0.92, 0.50, 0.10], [0.20, 0.62, 0.78]];
/** The livery for a params set: `railLivery` or a seeded pick ('auto' / unset). Deterministic. */
export function railLivery(p: { seed: number; railLivery?: string }): LiverySpec {
    const want = p.railLivery;
    const name: RailLivery = (RAIL_LIVERIES as string[]).includes(want ?? '') ? want as RailLivery : RAIL_LIVERIES[Math.min(2, (hash2(p.seed, 17, 0x7a11) * 3) | 0)];
    const steel = { strength: 0.55, roughness: 0.30 };
    if (name === 'green') return { name, body: SILVER, lower: null, band: [0.12, 0.56, 0.26], bands: [[2.90, 3.02], [1.66, 1.82]], roof: [0.46, 0.47, 0.49], paint: steel };
    if (name === 'silver') return { name, body: SILVER, lower: null, band: SILVER_BANDS[Math.min(SILVER_BANDS.length - 1, (hash2(p.seed, 19, 0x5b3d) * SILVER_BANDS.length) | 0)], bands: [[1.60, 1.86], [2.93, 2.98]], roof: [0.44, 0.45, 0.47], paint: steel };
    const orange: V3 = [0.86, 0.40, 0.12];
    return { name, body: [0.90, 0.85, 0.70], lower: orange, band: orange, bands: [[2.97, 3.06]], roof: [0.40, 0.40, 0.42], paint: { strength: 0.40, roughness: 0.24 } };
}

// Fixed material colours.
const GLASS: V3 = [0.10, 0.13, 0.16];      // side glass (the interior shader draws the room + reflection on it)
const CAB_GLASS: V3 = [0.05, 0.065, 0.085];
const DARK: V3 = [0.07, 0.07, 0.08];       // bogies / wheels / gangways / mask / underframe
const EQUIP: V3 = [0.62, 0.63, 0.65];      // roof AC units
const CABIN: V3 = [0.50, 0.51, 0.48];      // the interior seen through an OPEN doorway (lit after dark by the glow walk)
const HEAD: V3 = [1.0, 0.96, 0.84];
const TAIL: V3 = [0.95, 0.12, 0.10];
const SIGN: V3 = [1.0, 0.74, 0.30];        // amber LED destination sign

/** The car's accumulators (one per material layer). */
interface CarAcc {
    body: Accum3D; lower: Accum3D; band: Accum3D; roof: Accum3D; equip: Accum3D; dark: Accum3D;
    win: Accum3D; cabGlass: Accum3D; cabin: Accum3D;
    doorA: Accum3D; doorB: Accum3D; winDoorA: Accum3D; winDoorB: Accum3D;
    head: Accum3D; tail: Accum3D; sign: Accum3D;
}
const newAcc = (): CarAcc => ({
    body: new Accum3D(), lower: new Accum3D(), band: new Accum3D(), roof: new Accum3D(), equip: new Accum3D(), dark: new Accum3D(),
    win: new Accum3D(), cabGlass: new Accum3D(), cabin: new Accum3D(),
    doorA: new Accum3D(), doorB: new Accum3D(), winDoorA: new Accum3D(), winDoorB: new Accum3D(),
    head: new Accum3D(), tail: new Accum3D(), sign: new Accum3D(),
});

/** Car placement frame: origin (rail top, car centre), horizontal unit forward `ax` and `az` (= ax × up, the car's
 *  right-hand side), world units per metre `u`. */
interface Frame { o: V3; ax: V3; az: V3; u: number }
const UP: V3 = [0, 1, 0];
const P = (F: Frame, x: number, y: number, z: number): V3 => [
    F.o[0] + (F.ax[0] * x + F.az[0] * z) * F.u, F.o[1] + y * F.u, F.o[2] + (F.ax[2] * x + F.az[2] * z) * F.u];
const N = (F: Frame, nx: number, ny: number, nz: number): V3 => {
    const v: V3 = [F.ax[0] * nx + F.az[0] * nz, ny, F.ax[2] * nx + F.az[2] * nz], l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];

/** A quad from 4 points with one normal (wound to agree with it) and explicit uv corners. */
function quadN(a: Accum3D, p: V3[], n: V3, uv: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]): void {
    const e1: V3 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2: V3 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const v = p.map((q, i) => a.vertex(q, n, uv[i][0], uv[i][1]));
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] >= 0) { a.triangle(v[0], v[1], v[2]); a.triangle(v[0], v[2], v[3]); }
    else { a.triangle(v[0], v[2], v[1]); a.triangle(v[0], v[3], v[2]); }
}
/** A side overlay (window pane / band / doorway) on side `sg` (+1 = +az) at lateral `z`, x0..x1 × y0..y1. `cell` =
 *  the pane's u offset (one window cell per pane for the interior shader); plain overlays use world-metre uv. */
function sideQuad(a: Accum3D, F: Frame, sg: number, z: number, x0: number, x1: number, y0: number, y1: number, cell = -1): void {
    const pts = [P(F, x0, y0, sg * z), P(F, x1, y0, sg * z), P(F, x1, y1, sg * z), P(F, x0, y1, sg * z)];
    const uv: [number, number][] = cell >= 0
        ? (sg > 0 ? [[cell, 0], [cell + 1, 0], [cell + 1, 1], [cell, 1]] : [[cell + 1, 0], [cell, 0], [cell, 1], [cell + 1, 1]])
        : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    quadN(a, pts, N(F, 0, 0, sg), uv);
}
/** An end overlay facing ±x at car-x `x` (sx = +1 faces forward), z0..z1 × y0..y1. */
function endQuad(a: Accum3D, F: Frame, sx: number, x: number, z0: number, z1: number, y0: number, y1: number): void {
    quadN(a, [P(F, x, y0, z0), P(F, x, y0, z1), P(F, x, y1, z1), P(F, x, y1, z0)], N(F, sx, 0, 0));
}
const box = (a: Accum3D, F: Frame, x: number, y: number, z: number, hx: number, hy: number, hz: number): void =>
    a.obox(P(F, x, y, z), F.ax, UP, F.az, hx * F.u, hy * F.u, hz * F.u);
const bevel = (a: Accum3D, F: Frame, x: number, y: number, z: number, hx: number, hy: number, hz: number, b: number): void =>
    a.bevelBox(P(F, x, y, z), F.ax, UP, F.az, hx * F.u, hy * F.u, hz * F.u, b * F.u);

/** Extrude the body profile from x0 to x1; the x1 ring is scaled (sz across, sy up from the sill) for a tapered nose. */
function extrude(A: CarAcc, F: Frame, lv: LiverySpec, x0: number, x1: number, sz1 = 1, sy1 = 1): void {
    const n = PROFILE.length;
    const segN: [number, number][] = [];
    for (let i = 0; i < n - 1; i++) {
        const dz = PROFILE[i + 1][0] - PROFILE[i][0], dy = PROFILE[i + 1][1] - PROFILE[i][1], l = Math.hypot(dz, dy) || 1;
        segN.push([dy / l, -dz / l]);
    }
    // Vertex normals: smooth round the roof arc (a rounded roofline), flat on the sides, straight up at the crown.
    const nAt = (i: number, end: 0 | 1): [number, number] => {
        const k = i + end;
        if (k === n - 1) return [0, 1];
        if (k > ROOF_FROM) { const a = segN[k - 1], b = segN[k], z = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(z, y) || 1; return [z / l, y / l]; }
        return segN[i];
    };
    for (const sg of [1, -1]) for (let i = 0; i < n - 1; i++) {
        const acc = i >= ROOF_FROM ? A.roof : i < 2 && lv.lower ? A.lower : A.body;
        const [za, ya] = PROFILE[i], [zb, yb] = PROFILE[i + 1];
        const q0 = [P(F, x0, ya, sg * za), P(F, x0, yb, sg * zb)];
        const q1 = [P(F, x1, YB + (ya - YB) * sy1, sg * za * sz1), P(F, x1, YB + (yb - YB) * sy1, sg * zb * sz1)];
        const na = nAt(i, 0), nb = nAt(i, 1);
        const NA = N(F, 0, na[1], sg * na[0]), NB = N(F, 0, nb[1], sg * nb[0]);
        const v = [acc.vertex(q0[0], NA, x0, ya), acc.vertex(q1[0], NA, x1, ya), acc.vertex(q1[1], NB, x1, yb), acc.vertex(q0[1], NB, x0, yb)];
        // wind outward
        const e1 = [q1[0][0] - q0[0][0], q1[0][1] - q0[0][1], q1[0][2] - q0[0][2]], e2 = [q0[1][0] - q0[0][0], q0[1][1] - q0[0][1], q0[1][2] - q0[0][2]];
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (fn[0] * NA[0] + fn[1] * NA[1] + fn[2] * NA[2] >= 0) { acc.triangle(v[0], v[1], v[2]); acc.triangle(v[0], v[2], v[3]); }
        else { acc.triangle(v[0], v[2], v[1]); acc.triangle(v[0], v[3], v[2]); }
    }
    // Underside (the floor pan, seen from the street).
    quadN(A.dark, [P(F, x0, YB, -PROFILE[0][0]), P(F, x1, YB, -PROFILE[0][0] * sz1), P(F, x1, YB, PROFILE[0][0] * sz1), P(F, x0, YB, PROFILE[0][0])], N(F, 0, -1, 0));
}
/** Close the body at car-x `x` (sx = facing) with the (scaled) profile polygon — a fan from its centre. */
function endCap(a: Accum3D, F: Frame, x: number, sx: number, sz = 1, sy = 1): void {
    const ring: V3[] = [];
    for (let i = 0; i < PROFILE.length; i++) ring.push(P(F, x, YB + (PROFILE[i][1] - YB) * sy, PROFILE[i][0] * sz));
    for (let i = PROFILE.length - 2; i >= 0; i--) ring.push(P(F, x, YB + (PROFILE[i][1] - YB) * sy, -PROFILE[i][0] * sz));
    const nn = N(F, sx, 0, 0), c = a.vertex(P(F, x, YB + (2.3 - YB) * sy, 0), nn, 0.5, 0.5);
    const vs = ring.map(q => a.vertex(q, nn, 0, 0));
    for (let i = 0; i < vs.length; i++) {
        const j = (i + 1) % vs.length;
        const p0 = ring[i], p1 = ring[j], pc = P(F, x, YB + (2.3 - YB) * sy, 0);
        const e1 = [p0[0] - pc[0], p0[1] - pc[1], p0[2] - pc[2]], e2 = [p1[0] - pc[0], p1[1] - pc[1], p1[2] - pc[2]];
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (fn[0] * nn[0] + fn[1] * nn[1] + fn[2] * nn[2] >= 0) a.triangle(c, vs[i], vs[j]); else a.triangle(c, vs[j], vs[i]);
    }
}

/** A car variant: a CAB car (driving cab at +x) or a trailer / motor MID car (gangways both ends), `panto` = a raised
 *  single-arm pantograph on the roof. */
export type EmuVariant = 'cab' | 'mid' | 'panto';

/** Emit one EMU car into the accumulators (see the file header for the construction). `cell0` offsets the window
 *  cells so each car's rooms hash differently. */
function emitCar(A: CarAcc, F: Frame, lv: LiverySpec, variant: EmuVariant, cell0: number, lamps: 'both' | 'head' | 'tail' = 'both', pantoOnCab = false): void {
    const cab = variant === 'cab';
    const panto = variant === 'panto' || (cab && pantoOnCab);   // (the local line's short sets carry one on a cab car)
    const H = HALF_BODY, noseX = cab ? H - 0.5 : H;
    const NZ = 0.955, NY = 0.975;   // nose taper (across / height)
    extrude(A, F, lv, -H, noseX);
    if (cab) { extrude(A, F, lv, noseX, H, NZ, NY); endCap(A.body, F, H, 1, NZ, NY); } else endCap(A.body, F, H, 1);
    endCap(A.body, F, -H, -1);

    // Gangways (flexible bellows between cars) at the non-cab ends.
    const gang = (x: number): void => box(A.dark, F, x, 2.15, 0, 0.14, 1.02, 0.56);
    gang(-H - 0.1); if (!cab) gang(H + 0.1);

    // ── Sides: doors, windows, bands ──
    const zo = ZS + 0.02;                // overlay planes proud of the side (depth-safe at city distance)
    const WY0 = 2.02, WY1 = 2.86;        // window band
    const cabX = cab ? H - 1.3 : H;      // cab car: the driver's cab takes the last 1.3 m
    // Window panes between the doors (pillars = the body showing between panes), end panes past the end doors.
    const panes: [number, number][] = [];
    for (let k = 0; k < DOORS.length - 1; k++) {
        const a0 = DOORS[k] + 0.86, a1 = DOORS[k + 1] - 0.86, mid = (a0 + a1) / 2;
        panes.push([a0, mid - 0.1], [mid + 0.1, a1]);
    }
    panes.push([-H + 0.38, DOORS[0] - 0.86]);
    if (!cab) panes.push([DOORS[3] + 0.86, H - 0.38]);
    else panes.push([DOORS[3] + 0.86, cabX - 0.25]);
    let cell = cell0;
    for (const sg of [1, -1]) {
        for (const [x0, x1] of panes) if (x1 - x0 > 0.2) sideQuad(A.win, F, sg, zo, x0, x1, WY0, WY1, cell++);
        if (cab) sideQuad(A.cabGlass, F, sg, zo, cabX + 0.1, H - 0.6, 2.06, 2.86);   // cab side window
        // Livery bands: continuous panels between the door openings.
        const segs: [number, number][] = [[-H + 0.05, DOORS[0] - 0.74]];
        for (let k = 0; k < DOORS.length - 1; k++) segs.push([DOORS[k] + 0.74, DOORS[k + 1] - 0.74]);
        segs.push([DOORS[3] + 0.74, (cab ? noseX : H) - 0.05]);
        for (const [y0, y1] of lv.bands) for (const [x0, x1] of segs) sideQuad(A.band, F, sg, zo, x0, x1, y0, y1);
        // Doors: the (lit) doorway behind two bi-parting leaves, each leaf with its window. A leaves slide −x, B +x.
        for (const dc of DOORS) {
            sideQuad(A.cabin, F, sg, ZS + 0.01, dc - 0.68, dc + 0.68, 1.12, 3.0);
            for (const [acc, wacc, sx] of [[A.doorA, A.winDoorA, -1], [A.doorB, A.winDoorB, 1]] as const) {
                const lc = dc + sx * 0.345;
                box(acc, F, lc, 2.06, sg * (ZS + 0.05), 0.335, 0.93, 0.015);
                sideQuad(wacc, F, sg, ZS + 0.07, lc - 0.2, lc + 0.2, 1.98, 2.88, cell++);
            }
        }
    }

    // ── Cab face ──
    if (cab) {
        const fx = H + 0.004, fz = ZS * NZ;
        endQuad(A.dark, F, 1, fx, -fz * 0.93, fz * 0.93, 1.86, 3.30);            // the black mask round the windscreen
        endQuad(A.cabGlass, F, 1, fx + 0.004, -1.16, -0.04, 2.02, 2.96);        // split windscreen
        endQuad(A.cabGlass, F, 1, fx + 0.004, 0.04, 1.16, 2.02, 2.96);
        endQuad(A.sign, F, 1, fx + 0.006, -0.56, 0.56, 3.03, 3.2);              // destination sign
        endQuad(A.dark, F, 1, fx, -fz * 0.9, fz * 0.9, 1.48, 1.76);              // lamp housing strip
        for (const sz of [1, -1]) {
            // Unlit lamps (a parked train) go to the dark trim so only the lit pair glows.
            bevel(lamps === 'tail' ? A.dark : A.head, F, fx + 0.01, 1.62, sz * 1.0, 0.02, 0.085, 0.17, 0.015);
            bevel(lamps === 'head' ? A.dark : A.tail, F, fx + 0.01, 1.62, sz * 0.64, 0.02, 0.06, 0.1, 0.012);
        }
        box(A.dark, F, H - 0.05, 0.82, 0, 0.16, 0.2, 1.12);                      // skirt / snowplough
        box(A.dark, F, H + 0.12, 0.92, 0, 0.18, 0.08, 0.1);                       // coupler
    }

    // ── Underframe: underfloor equipment boxes + two bogies ──
    for (const [x, hx] of [[-3.6, 1.5], [0.4, 1.8], [4.0, 1.0]] as const) box(A.dark, F, x, 0.82, 0, hx, 0.22, 1.0);
    for (const bx of [-7.0, 7.0]) {
        for (const sz of [1, -1]) box(A.dark, F, bx, 0.52, sz * 0.84, 1.3, 0.13, 0.07);            // side frames
        box(A.dark, F, bx, 0.74, 0, 0.26, 0.1, 0.9);                                              // bolster
        for (const wx of [-1.05, 1.05]) {
            for (const sz of [1, -1]) A.dark.lathe(P(F, bx + wx, 0.43, sz * 0.51), N(F, 0, 0, sz), [[0.43 * F.u, 0], [0.43 * F.u, 0.13 * F.u]], 10);
            A.dark.beam(P(F, bx + wx, 0.43, -0.52), P(F, bx + wx, 0.43, 0.52), 0.08 * F.u, 4);        // axle
        }
    }

    // ── Roof: AC units (+ a pantograph) ──
    const ac = panto ? [-4.6] : cab ? [-4.6, 3.2] : [-4.6, 4.6];
    for (const x of ac) bevel(A.equip, F, x, EMU_ROOF_M + 0.12, 0, 1.25, 0.14, 0.92, 0.06);
    if (panto) {
        const px = cab ? 2.6 : 4.4, top = EMU_PANTO_M;
        for (const sz of [1, -1]) A.dark.beam(P(F, px - 0.8, 3.76, sz * 0.5), P(F, px + 0.8, 3.76, sz * 0.5), 0.05 * F.u, 4);   // base frame
        for (const sz of [1, -1]) A.dark.beam(P(F, px - 0.7, 3.8, sz * 0.32), P(F, px + 0.45, 4.35, sz * 0.05), 0.035 * F.u, 4); // lower arm
        A.dark.beam(P(F, px + 0.45, 4.35, 0), P(F, px - 0.25, top - 0.04, 0), 0.03 * F.u, 4);                                    // upper arm
        A.dark.beam(P(F, px - 0.25, top, -0.82), P(F, px - 0.25, top, 0.82), 0.03 * F.u, 4);                                      // collector head
        for (const sz of [1, -1]) A.dark.beam(P(F, px - 0.25, top, sz * 0.82), P(F, px - 0.25, top - 0.12, sz * 1.0), 0.02 * F.u, 3); // horns
    }
}
/** Raised pantograph head height above the rail top (the catenary contact wire height). */
export const EMU_PANTO_M = 5.0;

/** Everything a consist needs: layer name prefix (`world:traffic-train` moving, `world:rail-train` parked). */
function carLayers(A: CarAcc, prefix: string, lv: LiverySpec, p: { radius: number; nightMode?: boolean }, key: string | null): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const paint = { reflect: lv.paint } as Partial<LayoutPreviewLayer>;
    const lit = p.nightMode ? 1 : 0;
    // scale > 0.9 on facade code 2 = TRANSIT glazing (mesh3d windowsPattern): every pane lit after dark, no per-band gating.
    const winPat = (): LayoutPreviewLayer['pattern'] => ({ color: [0.94, 0.97, 1.0], freq: 1, scale: 1, mode: 'windows', angle: 2, spacing: lit });
    const push = (a: Accum3D, suffix: string, color: V3, extra: Partial<LayoutPreviewLayer>): void => {
        if (a.empty) return;
        const name = prefix + suffix;
        out.push({ name, color, y: 0, geometry: a.geometry(), noWarp: true, ...(key ? { instanceKey: `${key}:${name}` } : {}), ...extra });
    };
    push(A.body, '', lv.body, paint);
    push(A.lower, '-lower', lv.lower ?? lv.body, paint);
    push(A.band, '-band', lv.band, paint);
    push(A.doorA, '-doorA', lv.body, paint);
    push(A.doorB, '-doorB', lv.body, paint);
    push(A.roof, '-roof', lv.roof, { reflect: { strength: 0.12, roughness: 0.55 } });
    push(A.equip, '-equip', EQUIP, { metal: { roughness: 0.45, scale: metalScaleFor(p.radius), grime: 0.35 } });
    push(A.dark, '-dark', DARK, { reflect: { strength: 0.04, roughness: 0.62 } });
    // ★ '-win' names keep the GLOW table's 'rail-train-win' / 'train-win' rows; the side glass is the interior shader.
    push(A.win, '-win', GLASS, { glass: true, pattern: winPat(), emissive: 0.12 });
    push(A.winDoorA, '-win-doorA', GLASS, { glass: true, pattern: winPat(), emissive: 0.12 });
    push(A.winDoorB, '-win-doorB', GLASS, { glass: true, pattern: winPat(), emissive: 0.12 });
    push(A.cabGlass, '-glass', CAB_GLASS, { glass: true });
    push(A.cabin, '-lit', CABIN, { emissive: 0.6 });
    // "headlight" / "taillight" in the names → the glow walk's night-light row.
    push(A.head, '-headlight', HEAD, { emissive: 1.0 });
    push(A.tail, '-taillight', TAIL, { emissive: 0.9 });
    push(A.sign, '-sign', SIGN, { emissive: 1.0 });
    return out;
}

/** One car variant built at the ORIGIN along +x (rail top baked at `railTopY`) — the moving consist's geometry. */
export function emuCarLayers(p: LayoutParams | (Pick<LayoutParams, 'seed' | 'radius'> & Partial<LayoutParams>), variant: EmuVariant, railTopY: number, prefix = 'world:traffic-train'): LayoutPreviewLayer[] {
    const u = 1 / cityMetresPerUnit(p.radius), lv = railLivery(p);
    const A = newAcc();
    emitCar(A, { o: [0, railTopY, 0], ax: [1, 0, 0], az: [0, 0, 1], u }, lv, variant, variant === 'cab' ? 0 : variant === 'mid' ? 40 : 80);
    return carLayers(A, prefix, lv, p, `emu:${lv.name}:${lv.band.join(',')}:${variant}:${p.radius}:${railTopY.toFixed(5)}:${p.nightMode ? 1 : 0}`);
}

/** A car variant with options (railway-upgrade R3.2 — the local line): a pantograph on a CAB car, a livery override.
 *  Built at the origin along +x like emuCarLayers; the caller re-keys `instanceKey` if it reshapes the geometry. */
export function emuCarLayersEx(p: Pick<LayoutParams, 'seed' | 'radius'> & Partial<LayoutParams>, variant: EmuVariant, railTopY: number, prefix: string,
    opts: { pantoOnCab?: boolean; livery?: RailLivery } = {}): LayoutPreviewLayer[] {
    const q = opts.livery ? { ...p, railLivery: opts.livery } : p;
    const u = 1 / cityMetresPerUnit(q.radius), lv = railLivery(q);
    const A = newAcc();
    emitCar(A, { o: [0, railTopY, 0], ax: [1, 0, 0], az: [0, 0, 1], u }, lv, variant, variant === 'cab' ? (opts.pantoOnCab ? 120 : 0) : variant === 'mid' ? 40 : 80, 'both', !!opts.pantoOnCab);
    return carLayers(A, prefix, lv, q, null);
}

/** Triangles of one car variant (budget tests + the report). */
export function emuCarTris(p: Pick<LayoutParams, 'seed' | 'radius'> & Partial<LayoutParams>, variant: EmuVariant): number {
    return emuCarLayers(p, variant, 0).reduce((n, L) => n + L.geometry.indices.length / 3, 0);
}

/** The consist's car list: variant per car + whether it is FLIPPED (built +x forward, the −x end cab car turned 180°
 *  so both cabs face outward). Pantographs on every 3rd mid car. */
export function consistPlan(n: number): { variant: EmuVariant; flip: boolean }[] {
    const out: { variant: EmuVariant; flip: boolean }[] = [];
    for (let i = 0; i < n; i++) {
        if (i === 0) out.push({ variant: 'cab', flip: true });
        else if (i === n - 1) out.push({ variant: 'cab', flip: false });
        else out.push({ variant: i % 3 === 1 ? 'panto' : 'mid', flip: i > n / 2 });
    }
    return out;
}

// ── Track contract (rail-layout.ts via railway.ts) ────────────────────────────────────────────────
/** One track: its render-space centre polyline (noWarp — the viaduct is built along the WARPED road line), the
 *  cumulative arc lengths, and the layout z of each point (station z's are layout z). */
export interface RailTrack { offset: number; path: [number, number][]; cum: number[]; pathZ: number[]; len: number }
export interface RailTrackInfo {
    rx: number; z0: number; z1: number;
    railTopY: number;
    /** Tracks sorted by lateral offset (ascending). */
    tracks: RailTrack[];
    stations: RailStationIn[];
}
/** What railway.ts's `railwayLine(p)` returns (rail-layout.ts RailLine; the real-scale fields optional so an old
 *  straight single-track line still works). */
export type RailLineIn = { rx: number; z0: number; z1: number; deckY: number } & Partial<{
    tracks: number; trackOffsets: number[]; railTopY: number; gaugeU: number; contactY: number; path: [number, number][]; pathZ: number[] }>;
export type RailStationIn = { z: number; halfLen: number; side?: unknown };
/** Normalise the line + stations from railway.ts (`railwayLine(p)`, `railStations(p)`). Each track follows the line's
 *  render-space centreline offset along its MITRED normal (the same maths as rail-layout.ts railTrackPath, so the
 *  wheels sit on the rails through the gentle warp curves). NOTE: train.ts never imports railway.ts (railway.ts
 *  imports buildParkedTrain from here; the callers pass the line in, so there is no module cycle). */
export function railTrackInfo(p: { radius: number }, L: RailLineIn, stations: RailStationIn[] = []): RailTrackInfo {
    const s = p.radius / 10;
    const offsets = (L.trackOffsets && L.trackOffsets.length ? L.trackOffsets.slice() : [0]).sort((a, b) => a - b);
    const railTopY = typeof L.railTopY === 'number' ? L.railTopY : L.deckY + 0.02 * s;
    const centre: [number, number][] = L.path && L.path.length >= 2 ? L.path : [[L.rx, L.z0], [L.rx, L.z1]];
    const pz = L.pathZ && L.pathZ.length === centre.length ? L.pathZ : centre.map((_, i) => L.z0 + (L.z1 - L.z0) * i / (centre.length - 1));
    const n = centre.length - 1;
    const segN = (k: number): [number, number] => { const a = centre[k], b = centre[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; };
    const normals = centre.map((_, i) => {
        const na = segN(Math.max(0, Math.min(n - 1, i - 1))), nb = segN(Math.max(0, Math.min(n - 1, i)));
        let mx = na[0] + nb[0], mz = na[1] + nb[1]; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
        const c = Math.max(0.5, mx * nb[0] + mz * nb[1]);
        return [mx / c, mz / c] as [number, number];
    });
    const tracks = offsets.map(off => {
        const path = centre.map((q, i) => [q[0] + normals[i][0] * off, q[1] + normals[i][1] * off] as [number, number]);
        const cum = [0];
        for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
        return { offset: off, path, cum, pathZ: pz, len: Math.max(1e-6, cum[cum.length - 1]) };
    });
    return { rx: L.rx, z0: L.z0, z1: L.z1, railTopY, tracks, stations: stations.slice().sort((a, b) => a.z - b.z) };
}
/** Arc length along a track at LAYOUT z (station positions to stop positions). */
export function trackArcAtZ(t: RailTrack, z: number): number {
    const { pathZ, cum } = t, n = pathZ.length - 1;
    if (z <= pathZ[0]) return 0;
    if (z >= pathZ[n]) return cum[n];
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pathZ[m] <= z) lo = m; else hi = m; }
    const f = (z - pathZ[lo]) / ((pathZ[hi] - pathZ[lo]) || 1);
    return cum[lo] + (cum[hi] - cum[lo]) * f;
}
/** Point on a polyline at arc length `d` (clamped) into out[0], out[1]. Binary search, allocation-free. */
export function pathPointAt(path: ArrayLike<[number, number]>, cum: ArrayLike<number>, d: number, out: [number, number]): void {
    const n = cum.length - 1;
    const dd = Math.max(0, Math.min(cum[n], d));
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= dd) lo = m; else hi = m; }
    const seg = (cum[hi] - cum[lo]) || 1, f = (dd - cum[lo]) / seg, a = path[lo], b = path[hi];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f;
}
/** Real bogie-centre half-spacing (m): a car body is the CHORD between its two bogies on the track. */
export const EMU_BOGIE_HALF_M = 7.0;
const _pa: [number, number] = [0, 0], _pb: [number, number] = [0, 0];
/** A car's pose on a track at arc `d` (its centre): the midpoint + heading of the chord between its bogies (at
 *  arc d -/+ hb), so on a curve the body hangs between its bogies like a real car. `yaw` maps +x-built geometry onto
 *  the chord (rotateY sends +x to (cos, -sin)). Allocation-free (writes `out`). */
export function carPoseAt(path: ArrayLike<[number, number]>, cum: ArrayLike<number>, d: number, hb: number, out: { x: number; z: number; yaw: number }): void {
    pathPointAt(path, cum, d - hb, _pa); pathPointAt(path, cum, d + hb, _pb);
    out.x = (_pa[0] + _pb[0]) / 2; out.z = (_pa[1] + _pb[1]) / 2;
    out.yaw = Math.atan2(-(_pb[1] - _pa[1]), _pb[0] - _pa[0]);
}

/** Cars that fit the line (param `railCars`, 2..10, default 8; fewer on a short line so the consist has room to run). */
export function railCarCount(p: { railCars?: number; radius: number }, lineLen: number): number {
    const want = Math.round(Math.max(RAIL_CARS_MIN, Math.min(RAIL_CARS_MAX, p.railCars ?? RAIL_CARS_DEFAULT)));
    const carU = EMU_CAR_M / cityMetresPerUnit(p.radius);
    const fit = Math.floor((lineLen * 0.8) / carU);
    return Math.max(1, Math.min(want, fit));
}

// ── The run (R2.2) ───────────────────────────────────────────────────────────────────────────────
/** A consist's run along its track: arc positions of the consist CENTRE (world units from the track start). */
export interface TrainRunPlan {
    lo: number; hi: number;     // centre travel limits (the termini)
    stops: number[];            // station stops (sorted, inside (lo, hi))
    cruise: number;             // world units / s
    accel: number; decel: number;   // world units / s²
    dwell: number; termDwell: number;   // seconds
    doorTime: number;           // seconds for the doors to slide
}
export interface TrainRunState { s: number; v: number; dir: 1 | -1; dwell: number; dwellTotal: number; door: number }

/** Build the run plan for a track of length `len` (world units) with station centres `stopsAt` (arc positions),
 *  a consist of half-length `half`. Dwell ~24 s (30 s at a terminus) × `railDwellScale`. */
export function trainRunPlan(p: { radius: number; railDwellScale?: number }, len: number, half: number, stopsAt: number[]): TrainRunPlan {
    const u = 1 / cityMetresPerUnit(p.radius);
    const lo = Math.min(len / 2, half + 1.0 * u), hi = Math.max(len / 2, len - half - 1.0 * u);
    const k = Math.max(0, p.railDwellScale ?? 1), margin = 3 * u;
    const stops = stopsAt.filter(x => x > lo + margin && x < hi - margin).sort((a, b) => a - b);
    return { lo, hi, stops, cruise: 12 * u, accel: 0.8 * u, decel: 1.0 * u, dwell: 24 * k, termDwell: 30 * k, doorTime: 2.2 };
}

/** Initial state: dwelling at the first stop (or a terminus) so the doors are seen, heading `dir`. */
export function trainRunStart(plan: TrainRunPlan, dir: 1 | -1, phase: number): TrainRunState {
    // Candidate stops the train can DEPART from in `dir` (never the terminus it is heading into).
    const pts = dir > 0 ? [plan.lo, ...plan.stops] : [...plan.stops, plan.hi];
    const i = Math.min(pts.length - 1, Math.floor(phase * pts.length));
    const s = pts[i], d = dir;
    const total = s === plan.lo || s === plan.hi ? plan.termDwell : plan.dwell;
    const dwell = total * (0.35 + 0.5 * ((phase * 7.31) % 1));
    return { s, v: 0, dir: d, dwell, dwellTotal: total, door: dwell > plan.doorTime ? 1 : 0 };
}

/** Advance a run by `dt` seconds. Accelerate at `accel` to the cruise, follow the braking curve v = √(2·decel·d) into
 *  the next stop so the consist halts exactly there, dwell (doors open → close), reverse at the termini. */
export function stepTrainRun(st: TrainRunState, plan: TrainRunPlan, dt: number): void {
    let left = Math.max(0, dt);
    while (left > 1e-9) {
        const h = Math.min(left, 0.05); left -= h;
        if (st.dwell > 0) {
            st.dwell = Math.max(0, st.dwell - h);
            // Doors: open over doorTime after arrival, close over the last doorTime (+ a beat) before departure.
            const into = st.dwellTotal - st.dwell, out = st.dwell - 0.6;
            st.door = Math.max(0, Math.min(1, into / plan.doorTime, out / plan.doorTime));
            if (st.dwell === 0) {
                st.door = 0;
                if (st.s >= plan.hi - 1e-9) st.dir = -1; else if (st.s <= plan.lo + 1e-9) st.dir = 1;
            }
            continue;
        }
        // Next stop ahead in the travel direction (a station, else the terminus).
        let target = st.dir > 0 ? plan.hi : plan.lo, term = true;
        if (st.dir > 0) { for (const x of plan.stops) if (x > st.s + 1e-7) { target = x; term = false; break; } }
        else for (let i = plan.stops.length - 1; i >= 0; i--) if (plan.stops[i] < st.s - 1e-7) { target = plan.stops[i]; term = false; break; }
        const d = Math.abs(target - st.s);
        const vBrake = Math.sqrt(2 * plan.decel * d);
        const want = Math.min(plan.cruise, vBrake);
        st.v = want > st.v ? Math.min(want, st.v + plan.accel * h) : Math.max(want, st.v - plan.decel * 1.6 * h);
        const step = st.v * h;
        if (step >= d - 1e-9) {
            st.s = target; st.v = 0;
            st.dwellTotal = st.dwell = term ? plan.termDwell : plan.dwell;
            st.door = 0;
            if (st.dwell <= 0) { if (term) st.dir = st.dir > 0 ? -1 : 1; }
        } else st.s += step * st.dir;
    }
}

// ── The run as a function of the clock (sim LOD, performance-plan §P13) ──────────────────────────────
// stepTrainRun's rules in continuous time: from a stop, accelerate at `accel` until the cruise or the braking curve
// v = √(2·decel·d) (whichever is lower), follow it into the next stop, dwell, reverse at the termini. Each inter-stop
// run is a trapezoid (or triangle) speed profile, so the whole schedule is a periodic list of legs and the state at
// any time is a lookup: a frozen train costs nothing and reappears exactly on its schedule.

interface TrainTimelineLeg {
    t0: number;          // departure (seconds since the cycle origin)
    from: number; dir: 1 | -1; D: number;
    ta: number; tc: number; td: number; vp: number;
    tArr: number;        // arrival = t0 + ta + tc + td
    dwell: number;       // the dwell at the arrival stop
    term: boolean;       // the arrival stop is a terminus (the train reverses after the dwell)
}
export interface TrainRunTimeline {
    plan: TrainRunPlan;
    /** The partial dwell the run starts in (seconds), its total and the start stop + direction. */
    startDwell: number; startTotal: number; s0: number; dir0: 1 | -1;
    /** One full cycle of legs, departing from s0 in dir0 at time startDwell; `period` long. */
    legs: TrainTimelineLeg[]; period: number;
}

/** The periodic schedule of a run from its start state, or null when the plan has no room to run. */
export function trainRunTimeline(plan: TrainRunPlan, start: TrainRunState): TrainRunTimeline | null {
    if (!(plan.hi - plan.lo > 1e-6) || !(plan.accel > 0) || !(plan.decel > 0) || !(plan.cruise > 0)) return null;
    const legs: TrainTimelineLeg[] = [];
    let s = start.s, dir = start.dir, t = Math.max(0, start.dwell);
    // the dwell's end at a terminus reverses (stepTrainRun: at dwell 0, s ≥ hi → −1, s ≤ lo → +1)
    if (s >= plan.hi - 1e-9) dir = -1; else if (s <= plan.lo + 1e-9) dir = 1;
    const s0 = s, dir0 = dir, tStart = t;
    for (let guard = 0; guard < 4 * (plan.stops.length + 2) + 4; guard++) {
        let target = dir > 0 ? plan.hi : plan.lo, term = true;
        if (dir > 0) { for (const x of plan.stops) if (x > s + 1e-7) { target = x; term = false; break; } }
        else for (let i = plan.stops.length - 1; i >= 0; i--) if (plan.stops[i] < s - 1e-7) { target = plan.stops[i]; term = false; break; }
        const D = Math.abs(target - s), a = plan.accel, b = plan.decel, vc = plan.cruise;
        let ta: number, tc: number, td: number, vp: number;
        if (vc * vc / (2 * a) + vc * vc / (2 * b) <= D) { vp = vc; ta = vc / a; td = vc / b; tc = (D - vc * vc / (2 * a) - vc * vc / (2 * b)) / vc; }
        else { vp = Math.sqrt(2 * a * b * D / (a + b)); ta = vp / a; td = vp / b; tc = 0; }
        const tArr = t + ta + tc + td, dwell = term ? plan.termDwell : plan.dwell;
        legs.push({ t0: t, from: s, dir, D, ta, tc, td, vp, tArr, dwell: Math.max(0, dwell), term });
        s = target; t = tArr + Math.max(0, dwell);
        if (term) dir = dir > 0 ? -1 : 1;
        if (Math.abs(s - s0) < 1e-9 && dir === dir0) break;   // back where the cycle began
    }
    const period = t - tStart;
    if (!(period > 1e-6)) return null;
    return { plan, startDwell: tStart, startTotal: start.dwellTotal, s0, dir0, legs, period };
}

/** The run state `t` seconds after the run's start state, written into `out` (allocation-free). */
export function trainRunAt(tl: TrainRunTimeline, t: number, out: TrainRunState): TrainRunState {
    const plan = tl.plan;
    const door = (into: number, left: number): number => Math.max(0, Math.min(1, into / plan.doorTime, (left - 0.6) / plan.doorTime));
    if (t < tl.startDwell) {   // the initial (partial) dwell at the start stop
        const left = tl.startDwell - t, into = tl.startTotal - left;
        out.s = tl.s0; out.v = 0; out.dwell = left; out.dwellTotal = tl.startTotal; out.door = door(into, left);
        out.dir = tl.dir0;   // (a terminus start already faces the way it will leave; stepTrainRun flips it at dwell 0)
        return out;
    }
    let tau = (t - tl.startDwell) % tl.period; if (tau < 0) tau += tl.period;
    const T = tl.startDwell + tau;
    // the leg (binary search on t0)
    const L = tl.legs;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m].t0 <= T) lo = m; else hi = m - 1; }
    const g = L[lo];
    if (T < g.tArr) {
        const u = T - g.t0;
        let x: number, v: number;
        if (u < g.ta) { x = 0.5 * plan.accel * u * u; v = plan.accel * u; }
        else if (u < g.ta + g.tc) { x = 0.5 * g.vp * g.ta + g.vp * (u - g.ta); v = g.vp; }
        else { const r = Math.max(0, g.tArr - T); x = g.D - 0.5 * plan.decel * r * r; v = plan.decel * r; }
        out.s = g.from + g.dir * Math.min(g.D, Math.max(0, x)); out.v = v; out.dir = g.dir; out.dwell = 0; out.door = 0;
        out.dwellTotal = 0;
        return out;
    }
    // dwelling at the arrival stop
    const left = Math.max(0, g.tArr + g.dwell - T), into = g.dwell - left;
    out.s = g.from + g.dir * g.D; out.v = 0; out.dir = g.dir; out.dwell = left; out.dwellTotal = g.dwell;
    out.door = g.dwell > 0 ? door(into, left) : 0;
    return out;
}

// ── The consists for a params set (moving) ─────────────────────────────────────────────────────────
export interface RailConsist {
    path: [number, number][];                    // the track's render-space polyline (noWarp)
    count: number; spacing: number;
    variants: LayoutPreviewLayer[][];            // [cab, mid, panto] car layers
    pick: number[]; flip: boolean[];
    plan: TrainRunPlan; start: TrainRunState;
}
/** One consist per track (two tracks: opposite directions), each on its own run. Empty when the railway is off. */
export function railConsists(p: LayoutParams, T: RailTrackInfo): RailConsist[] {
    if (!(p.railway ?? true) || !T.tracks.length) return [];
    const u = 1 / cityMetresPerUnit(p.radius);
    const len = Math.min(...T.tracks.map(t => t.len));
    const n = railCarCount(p, len), spacing = EMU_CAR_M * u;
    const variantsOrder: EmuVariant[] = ['cab', 'mid', 'panto'];
    const variants = variantsOrder.map(v => emuCarLayers(p, v, T.railTopY));
    const cp = consistPlan(n);
    const pick = cp.map(c => variantsOrder.indexOf(c.variant)), flip = cp.map(c => c.flip);
    // Keep-left running: the +z-bound consist on the higher-offset track, the -z-bound one on the lower.
    return T.tracks.map((t, i) => {
        const plan = trainRunPlan(p, t.len, n * spacing / 2, T.stations.map(st => trackArcAtZ(t, st.z)));
        const dir: 1 | -1 = T.tracks.length > 1 ? (i === T.tracks.length - 1 ? 1 : -1) : 1;
        const phase = (((p.seed >>> 3) % 97) / 97 * 0.5 + i * 0.47) % 1;
        return { path: t.path, count: n, spacing, variants, pick, flip, plan, start: trainRunStart(plan, dir, phase) };
    });
}

// ── The PARKED train (static, the live sim off) ───────────────────────────────────────────────────
/** The static train for railway.ts buildRailway (when the traffic sim is not running): pass `railwayLine(p)` and
 *  `railStations(p)`. The same EMU cars merged into one mesh per material, parked on the first track (centred at
 *  the first station if there is one, else at a seeded spot), each car on the chord between its bogies. Layer names
 *  `world:rail-train*` (hidden by the traffic ticker while its moving consists run). */
export function buildParkedTrain(p: LayoutParams, line: RailLineIn, stations: RailStationIn[] = []): LayoutPreviewLayer[] {
    if (!(p.railway ?? true)) return [];
    const T = railTrackInfo(p, line, stations), u = 1 / cityMetresPerUnit(p.radius), lv = railLivery(p);
    const t = T.tracks[0];
    const n = railCarCount(p, t.len), spacing = EMU_CAR_M * u, half = n * spacing / 2;
    const plan = trainRunPlan(p, t.len, half, T.stations.map(st => trackArcAtZ(t, st.z)));
    const sC = plan.stops.length ? plan.stops[0] : plan.lo + ((p.seed >>> 7) % 1000) / 1000 * Math.max(0, plan.hi - plan.lo);
    const A = newAcc(), cp = consistPlan(n), pose = { x: 0, z: 0, yaw: 0 };
    cp.forEach((c, i) => {
        carPoseAt(t.path, t.cum, sC + (i - (n - 1) / 2) * spacing, EMU_BOGIE_HALF_M * u, pose);
        const yaw = c.flip ? pose.yaw + Math.PI : pose.yaw, cx = Math.cos(yaw), sx = -Math.sin(yaw);   // the car's +x in world
        // az = ax cross up = (-ax.z, 0, ax.x)
        emitCar(A, { o: [pose.x, T.railTopY, pose.z], ax: [cx, 0, sx], az: [-sx, 0, cx], u }, lv, c.variant, i * 40, c.flip ? 'tail' : 'head');
    });
    // The parked lead cab (+z end) shows its headlights, the rear cab its tail lights.
    return carLayers(A, 'world:rail-train', lv, p, null);
}
