/**
 * vehicle.ts — the shared VEHICLE builder used by both PARKED cars (furniture.ts) and MOVING traffic (traffic.ts).
 * One recipe, so an upgrade here improves the whole city at once.
 *
 * ★ Round 4 (polish-round-3.md §Round 4): the cars are now LOFTED bodies — the "GT / Persona 5 street car" read —
 * instead of stacked boxes. docs/specs/car-creator.md §"The geometry engine — a LOFTED body":
 *  - a SIDE PROFILE of stations along the length (hood → cowl → raked windshield → roof → backlight → deck), each a
 *    closed CROSS-SECTION ring (underbody → rocker tuck → shoulder crease → belt → side glass → drip rail → crowned
 *    roof), stitched ring-to-ring with AUTO-SMOOTH normals (neighbour faces within ~42° blend, sharper edges crease)
 *    → rounded panels that still keep a crisp shoulder / belt line,
 *  - WHEEL ARCHES cut into the section (the rocker + underbody rise over each axle on a circle) with the tyre tucked
 *    inside; LATHED tyres (rounded shoulder) + SILVER multi-spoke alloys (or chrome hubcaps on the classics),
 *  - a distinct GREENHOUSE: dark tinted glass bands, thin body-colour A/C pillars + drip rail, a blacked-out B pillar,
 *  - FLUSH headlights / taillights (fascia quads), grille, rub strips, plates, door seams + handles, side mirrors,
 *  - body STYLES: 90s 4-door `sedan` (primary, Accord/Civic), `hatch`, `kei` (tall wagon), `van` (kei one-box),
 *    `classic` (80s square Crown/Cedric, chrome bumpers), `taxi` (the classic + andon roof sign + checker belt);
 *    `bus` / `truck` keep their roles, rebuilt from bevelled boxes on the same wheels.
 *
 * All geometry is authored at `base`, nose ALONG +aW (the road-along axis), width along cW, in METRES × (s/15)
 * (the city convention: X·s = 15·X m). Deterministic (no randomness at all); every style is ~1.3–2.1k tris.
 *
 * ★ Night-glow name gotcha: only the MOVING cars carry the `world:veh-headlight` / `world:veh-taillight` layers
 *   (the world-manager GLOW walk matches /headlight|taillight/ and cranks them after dark). PARKED cars pass
 *   `lights:false` → the same lenses go to the unlit `lensHead` / `lensTail` accumulators instead, whose layer names
 *   must NEVER contain "headlight"/"taillight" (a street of parked cars must not blaze at night).
 */

import { Accum3D } from './meshbuild';
import { loOf, fullOnly } from './lod-accum';
import type { LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

export type VehicleType = 'sedan' | 'hatch' | 'kei' | 'van' | 'classic' | 'taxi' | 'bus' | 'truck';
/** Every vehicle type (tests + debug showroom iterate this). */
export const VEHICLE_TYPES: readonly VehicleType[] = ['sedan', 'hatch', 'kei', 'van', 'classic', 'taxi', 'bus', 'truck'];

/** Accumulator bundle. `body` is swapped per paint colour by the caller; the rest are shared. */
export interface VehicleAcc {
    body:     Accum3D;   // painted panels (per-colour in the parked merge; fresh per-archetype in traffic)
    glass:    Accum3D;   // tinted glass (windshield / side / backlight)
    trim:     Accum3D;   // tyres, underbody, wheel wells, B-pillar blackout, grille, rub strips, seams (near-black)
    chrome:   Accum3D;   // silver alloys / hubcaps, chrome bumpers + grille (classic), plates (bright metal)
    head:     Accum3D;   // headlights — EMISSIVE (moving traffic only)
    tail:     Accum3D;   // taillights — EMISSIVE (moving traffic only)
    lensHead: Accum3D;   // headlight lenses, UNLIT (parked: lights:false)
    lensTail: Accum3D;   // taillight lenses, UNLIT red (parked: lights:false)
    band:     Accum3D;   // taxi checkerboard belt (checker pattern layer)
    sign:     Accum3D;   // taxi roof sign (emissive)
}

export function makeVehicleAcc(body?: Accum3D): VehicleAcc {
    return {
        body: body ?? new Accum3D(),
        glass: new Accum3D(), trim: new Accum3D(), chrome: new Accum3D(),
        head: new Accum3D(), tail: new Accum3D(), lensHead: new Accum3D(), lensTail: new Accum3D(),
        band: new Accum3D(), sign: new Accum3D(),
    };
}

/** Total triangles in a bundle (budget tests + the Round-4 report). */
export function vehicleTriCount(acc: VehicleAcc): number {
    return (Object.values(acc) as Accum3D[]).reduce((n, a) => n + a.triCount, 0);
}

// Shared material colours (the layers below reference these).
export const VEH_GLASS: V3  = [0.055, 0.07, 0.095];   // dark smoked tint (the P5 street-car read: you can't see in)
export const VEH_TYRE: V3   = [0.05, 0.05, 0.055];
export const VEH_CHROME: V3 = [0.80, 0.82, 0.86];
export const VEH_HEAD: V3   = [1.0, 0.95, 0.80];
export const VEH_TAIL: V3   = [0.90, 0.14, 0.10];
export const VEH_LENS_HEAD: V3 = [0.86, 0.88, 0.90];  // clear lens by day (unlit)
export const VEH_LENS_TAIL: V3 = [0.62, 0.07, 0.07];  // red lens by day (unlit)
export const VEH_TAXI: V3   = [0.96, 0.78, 0.12];     // cab yellow
export const VEH_TAXI_SIGN: V3 = [1.0, 0.85, 0.30];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Body STYLES (metres). x = along (+ = nose), y = up from the ground, z = across (half-widths).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface CarShape {
    hl: number; hw: number;                          // half length / half width
    wheelR: number; tyreW: number; axF: number; axR: number; archR: number;
    floorY: number; sillY: number; shoulderY: number; beltY: number; beltRearY: number;
    noseEdgeY: number; tailEdgeY: number; bumperF: number; bumperR: number;   // hood/deck edge at the ends; bumper bottoms
    xWs: number; xH: number; xC: number; xBl: number;                         // windshield base, header, roof rear, backlight base
    roofY: number; roofCrown: number; drip: number; hoodCrown: number; deckCrown: number;
    gwB: number; gwT: number;                                                 // greenhouse half-width at the belt / glass top
    pillars: { x: number; w: number }[];                                      // blacked-out B (and quarter) pillars
    cSolid: boolean;                                                          // backlight zone side = body (thick C pillar)
    noseRound: number; noseK: number; tailRound: number; tailK: number;       // plan-view corner rounding
    rim: 'alloy' | 'hubcap'; spokes: number;
    chromeBumpers: boolean; moulding: boolean;
    lamp: { hH: number; hIn: number; tH: number; tIn: number };              // lamp heights + inner z fraction
    doors?: { seams: number[]; handles: number[] };                           // explicit shut-lines (cab-over van)
}

const SHAPES: Record<'sedan' | 'hatch' | 'kei' | 'van' | 'classic', CarShape> = {
    // 90s Japanese 4-door (Accord CD / Civic EG-sedan): long low hood, 30° windshield, crowned roof, notch trunk.
    sedan: {
        hl: 2.30, hw: 0.86, wheelR: 0.31, tyreW: 0.19, axF: 1.36, axR: -1.36, archR: 0.37,
        floorY: 0.19, sillY: 0.33, shoulderY: 0.75, beltY: 0.90, beltRearY: 0.94,
        noseEdgeY: 0.77, tailEdgeY: 0.90, bumperF: 0.27, bumperR: 0.30,
        xWs: 0.80, xH: -0.08, xC: -0.96, xBl: -1.50,
        roofY: 1.38, roofCrown: 0.05, drip: 0.04, hoodCrown: 0.035, deckCrown: 0.03,
        gwB: 0.80, gwT: 0.63,
        pillars: [{ x: -0.42, w: 0.09 }], cSolid: true,
        noseRound: 0.36, noseK: 0.13, tailRound: 0.26, tailK: 0.08,
        rim: 'alloy', spokes: 7, chromeBumpers: false, moulding: true,
        lamp: { hH: 0.12, hIn: 0.40, tH: 0.14, tIn: 0.30 },
    },
    // 90s 3/5-door hatch (Civic EG hatch): shorter, roof runs back to a steep hatch.
    hatch: {
        hl: 2.02, hw: 0.84, wheelR: 0.30, tyreW: 0.18, axF: 1.24, axR: -1.30, archR: 0.36,
        floorY: 0.18, sillY: 0.32, shoulderY: 0.72, beltY: 0.87, beltRearY: 0.93,
        noseEdgeY: 0.72, tailEdgeY: 0.90, bumperF: 0.27, bumperR: 0.30,
        xWs: 0.62, xH: -0.20, xC: -1.50, xBl: -1.92,
        roofY: 1.34, roofCrown: 0.045, drip: 0.04, hoodCrown: 0.03, deckCrown: 0.02,
        gwB: 0.78, gwT: 0.62,
        pillars: [{ x: -0.52, w: 0.08 }], cSolid: true,
        noseRound: 0.34, noseK: 0.14, tailRound: 0.20, tailK: 0.07,
        rim: 'alloy', spokes: 6, chromeBumpers: false, moulding: true,
        lamp: { hH: 0.11, hIn: 0.42, tH: 0.16, tIn: 0.46 },
    },
    // Kei tall wagon (Wagon R / Life): 3.4 m × 1.4 m, tall roof, long raked windshield, near-vertical hatch.
    kei: {
        hl: 1.70, hw: 0.70, wheelR: 0.27, tyreW: 0.15, axF: 1.02, axR: -1.16, archR: 0.32,
        floorY: 0.17, sillY: 0.30, shoulderY: 0.66, beltY: 0.93, beltRearY: 0.97,
        noseEdgeY: 0.72, tailEdgeY: 0.92, bumperF: 0.26, bumperR: 0.28,
        xWs: 0.98, xH: 0.30, xC: -1.50, xBl: -1.64,
        roofY: 1.64, roofCrown: 0.03, drip: 0.035, hoodCrown: 0.03, deckCrown: 0.02,
        gwB: 0.64, gwT: 0.56,
        pillars: [{ x: -0.22, w: 0.08 }, { x: -1.10, w: 0.07 }], cSolid: false,
        noseRound: 0.30, noseK: 0.14, tailRound: 0.14, tailK: 0.06,
        rim: 'alloy', spokes: 5, chromeBumpers: false, moulding: false,
        lamp: { hH: 0.12, hIn: 0.44, tH: 0.22, tIn: 0.70 },
    },
    // Kei ONE-BOX van (Every / Acty): cab-over, stubby nose, tall flat roof.
    van: {
        hl: 1.70, hw: 0.70, wheelR: 0.26, tyreW: 0.15, axF: 1.16, axR: -1.00, archR: 0.31,
        floorY: 0.20, sillY: 0.33, shoulderY: 0.64, beltY: 1.00, beltRearY: 1.02,
        noseEdgeY: 0.86, tailEdgeY: 1.00, bumperF: 0.28, bumperR: 0.30,
        xWs: 1.54, xH: 1.18, xC: -1.62, xBl: -1.68,
        roofY: 1.86, roofCrown: 0.03, drip: 0.035, hoodCrown: 0.03, deckCrown: 0.01,
        gwB: 0.66, gwT: 0.60,
        pillars: [{ x: 0.62, w: 0.08 }, { x: -0.52, w: 0.10 }], cSolid: false,
        noseRound: 0.18, noseK: 0.10, tailRound: 0.10, tailK: 0.04,
        rim: 'hubcap', spokes: 0, chromeBumpers: false, moulding: false,
        lamp: { hH: 0.14, hIn: 0.46, tH: 0.24, tIn: 0.74 },
        doors: { seams: [1.44, 0.58, -0.48, -1.56], handles: [0.71, -0.36] },   // cab door · sliding door · tailgate edge
    },
    // 80s square sedan (Crown / Cedric — and the Crown-Comfort TAXI): flat hood, upright glasshouse, chrome bumpers.
    classic: {
        hl: 2.40, hw: 0.85, wheelR: 0.30, tyreW: 0.18, axF: 1.36, axR: -1.38, archR: 0.36,
        floorY: 0.20, sillY: 0.34, shoulderY: 0.72, beltY: 0.87, beltRearY: 0.89,
        noseEdgeY: 0.76, tailEdgeY: 0.86, bumperF: 0.30, bumperR: 0.31,
        xWs: 0.78, xH: 0.02, xC: -0.98, xBl: -1.40,
        roofY: 1.43, roofCrown: 0.025, drip: 0.035, hoodCrown: 0.015, deckCrown: 0.015,
        gwB: 0.78, gwT: 0.70,
        pillars: [{ x: -0.46, w: 0.10 }], cSolid: true,
        noseRound: 0.12, noseK: 0.04, tailRound: 0.10, tailK: 0.04,
        rim: 'hubcap', spokes: 0, chromeBumpers: true, moulding: false,
        lamp: { hH: 0.13, hIn: 0.44, tH: 0.15, tIn: 0.34 },
    },
};

const shapeOf = (type: VehicleType): CarShape => SHAPES[type === 'taxi' ? 'classic' : (type as keyof typeof SHAPES)] ?? SHAPES.sedan;

/** Half-length of a vehicle type in city units (traffic spacing / stop lines). */
export function vehicleHalfLength(type: VehicleType, s: number): number {
    const m = s / 15;
    if (type === 'bus') return 4.8 * m;
    if (type === 'truck') return 3.45 * m;
    return shapeOf(type).hl * m;
}

// ── small math ──────────────────────────────────────────────────────────────────────────────────────────────
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ── side profile + cross-section (all in metres, local frame) ──────────────────────────────────────────────
/** Plan-view half-width at x (rounded nose / tail corners). */
function halfWidthAt(S: CarShape, x: number): number {
    let k = 1;
    const nx = x - (S.hl - S.noseRound);
    if (nx > 0) { const u = Math.min(1, nx / S.noseRound); k = 1 - S.noseK * (1 - Math.sqrt(1 - u * u)); }
    const tx = -S.hl + S.tailRound - x;
    if (tx > 0) { const u = Math.min(1, tx / S.tailRound); k = 1 - S.tailK * (1 - Math.sqrt(1 - u * u)); }
    return S.hw * k;
}

/** Belt line: hood edge (nose → cowl) · window sill (cowl → backlight base, a gentle wedge rise) · deck edge. */
function beltAt(S: CarShape, x: number): number {
    if (x >= S.xWs) { const u = clamp01((x - S.xWs) / (S.hl - S.xWs)); return S.noseEdgeY + (S.beltY - S.noseEdgeY) * (1 - Math.pow(u, 2.4)); }
    if (x >= S.xBl) return lerp(S.beltY, S.beltRearY, (S.xWs - x) / (S.xWs - S.xBl));
    const u = clamp01((S.xBl - x) / (S.xBl + S.hl));
    return S.tailEdgeY + (S.beltRearY - S.tailEdgeY) * (1 - Math.pow(u, 2.2));
}

/** Centre-line top: hood crown → (convex) windshield → roof arc → (convex) backlight → deck crown. */
function topAt(S: CarShape, x: number): number {
    if (x >= S.xWs) return beltAt(S, x) + S.hoodCrown;
    if (x >= S.xH) {
        const t = (S.xWs - x) / (S.xWs - S.xH), b = S.beltY + S.hoodCrown;
        return b + (S.roofY - b) * clamp01(t + 0.08 * Math.sin(Math.PI * t));
    }
    if (x >= S.xC) return S.roofY + 0.012 * Math.sin(Math.PI * (x - S.xC) / (S.xH - S.xC));
    if (x >= S.xBl) {
        const t = (S.xC - x) / (S.xC - S.xBl), b = S.beltRearY + S.deckCrown;
        return S.roofY + (b - S.roofY) * clamp01(t - 0.1 * Math.sin(Math.PI * t));
    }
    return beltAt(S, x) + S.deckCrown;
}

/** Greenhouse factor: 0 on the hood/deck, ramps up the windshield / down the backlight, 1 under the roof. */
function cabinAt(S: CarShape, x: number): number {
    if (x >= S.xWs || x <= S.xBl) return 0;
    if (x >= S.xH) return (S.xWs - x) / (S.xWs - S.xH);
    if (x >= S.xC) return 1;
    return (x - S.xBl) / (S.xC - S.xBl);
}

function floorAt(S: CarShape, x: number): number {
    if (x > S.axF) return lerp(S.floorY, S.bumperF, Math.pow(clamp01((x - S.axF) / (S.hl - S.axF)), 1.5));
    if (x < S.axR) return lerp(S.floorY, S.bumperR, Math.pow(clamp01((S.axR - x) / (S.axR + S.hl)), 1.5));
    return S.floorY;
}

/** Wheel-arch height at x (−∞ away from an axle): a circle centred just above the axle. */
function archAt(S: CarShape, x: number): number {
    let a = -Infinity;
    for (const ax of [S.axF, S.axR]) {
        const d = x - ax;
        if (Math.abs(d) < S.archR) a = Math.max(a, S.wheelR + 0.02 + Math.sqrt(S.archR * S.archR - d * d));
    }
    return a;
}

/** HALF cross-section at x: 9 points [z, y] from the underbody centre round the right side to the roof centre.
 *  p0 floor-centre · p1 floor edge / wheel-well roof · p2 rocker · p3 SHOULDER crease (widest) · p4 belt edge ·
 *  p5 window sill (hood surface off-cabin) · p6 glass top · p7 drip rail · p8 roof / hood crown. */
function sectionAt(S: CarShape, x: number): [number, number][] {
    const hx = halfWidthAt(S, x), fl = floorAt(S, x), A = archAt(S, x), belt = beltAt(S, x), top = topAt(S, x), f = cabinAt(S, x);
    const crown = x > 0 ? S.hoodCrown : S.deckCrown;
    const sill = Math.max(S.sillY, fl + 0.1);
    const y1 = Math.max(fl, A), y2 = Math.max(sill, A);
    const y3 = Math.max(y2 + 0.025, Math.min(S.shoulderY, belt - 0.07));
    const y4 = Math.max(y3 + 0.01, belt - 0.012);
    return [
        [0, fl],
        [hx * 0.62, y1],
        [hx * 0.975, y2],
        [hx, y3],
        [hx * 0.965, y4],
        [lerp(hx * 0.84, S.gwB, f), Math.max(y4 + 0.004, belt + (1 - f) * crown * 0.25 + f * 0.006)],
        [lerp(hx * 0.62, S.gwT, f), top - lerp(crown * 0.384, S.roofCrown + S.drip, f)],
        [lerp(hx * 0.56, S.gwT * 0.92, f), top - lerp(crown * 0.31, S.roofCrown, f)],
        [0, top],
    ];
}

/** Side-surface z at height y (between the rocker and the belt) — to seat strips / handles ON the panel. */
function sideZ(sec: [number, number][], y: number): number {
    for (let k = 2; k < 4; k++) {
        const [z0, y0] = sec[k], [z1, y1] = sec[k + 1];
        if (y >= y0 && y <= y1) return lerp(z0, z1, y1 - y0 > 1e-6 ? (y - y0) / (y1 - y0) : 0);
    }
    return y < sec[2][1] ? sec[2][0] : sec[4][0];
}

/** Station x positions (nose→tail sorted descending): key profile breaks + dense arcs over each wheel arch. */
function stationsOf(S: CarShape): number[] {
    const xs: number[] = [S.hl - 0.05, -S.hl + 0.05, S.xWs, S.xH, S.xC, S.xBl, (S.xWs + S.xH) / 2, (S.xC + S.xBl) / 2];
    for (const f of [1, 0.66, 0.33]) { xs.push(S.hl - S.noseRound * f); xs.push(-S.hl + S.tailRound * f); }
    for (const p of S.pillars) xs.push(p.x - p.w / 2, p.x + p.w / 2);
    for (const ax of [S.axF, S.axR]) {
        for (let k = 0; k <= 6; k++) xs.push(ax + S.archR * Math.cos(Math.PI * k / 6));
        xs.push(ax + S.archR + 0.04, ax - S.archR - 0.04);
    }
    const lim = S.hl - 0.05;
    const sorted = xs.filter(x => x <= lim + 1e-9 && x >= -lim - 1e-9).sort((a, b) => b - a);
    const out: number[] = [];
    for (const x of sorted) if (!out.length || out[out.length - 1] - x > 0.02) out.push(x);
    // Fill long gaps so the roof arc / hood curve stay smooth.
    const filled: number[] = [];
    for (let i = 0; i < out.length; i++) {
        filled.push(out[i]);
        if (i + 1 < out.length) {
            const gap = out[i] - out[i + 1], n = Math.floor(gap / 0.34);
            for (let k = 1; k <= n; k++) filled.push(out[i] - gap * k / (n + 1));
        }
    }
    return filled;
}

// ── the emitter frame ──────────────────────────────────────────────────────────────────────────────────────
interface Frame { base: V3; aW: V3; cW: V3; m: number }
const P = (F: Frame, x: number, y: number, z: number): V3 =>
    [F.base[0] + (F.aW[0] * x + F.cW[0] * z) * F.m, F.base[1] + y * F.m, F.base[2] + (F.aW[2] * x + F.cW[2] * z) * F.m];
const D = (F: Frame, n: V3): V3 => nrm([F.aW[0] * n[0] + F.cW[0] * n[2], n[1], F.aW[2] * n[0] + F.cW[2] * n[2]]);

/** A flat quad in LOCAL metres (a→b→c→d, CCW about the intended outward normal). */
function lquad(acc: Accum3D, F: Frame, a: V3, b: V3, c: V3, d: V3): void {
    acc.quad4(P(F, a[0], a[1], a[2]), P(F, b[0], b[1], b[2]), P(F, c[0], c[1], c[2]), P(F, d[0], d[1], d[2]));
}
/** An upright rectangle on a plane x = const (fascia): z0..z1, y0..y1, facing +x (sgn 1) or −x (sgn −1). */
function fasciaRect(acc: Accum3D, F: Frame, x: number, sgn: 1 | -1, z0: number, z1: number, y0: number, y1: number): void {
    if (sgn > 0) lquad(acc, F, [x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1]);
    else lquad(acc, F, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]);
}

// ── the LOFT (rings → auto-smoothed quads, each routed to a material accumulator) ────────────────────────────
function loft(F: Frame, rings: V3[][], pick: (interval: number, band: number) => Accum3D | null, smoothCos = Math.cos(42 * Math.PI / 180)): void {
    const nI = rings.length - 1, nK = rings[0].length;
    const fN: (V3 | null)[][] = [];
    for (let i = 0; i < nI; i++) {
        const row: (V3 | null)[] = [];
        for (let k = 0; k < nK; k++) {
            const k1 = (k + 1) % nK;
            const a = rings[i][k], b = rings[i + 1][k], c = rings[i + 1][k1], d = rings[i][k1];
            const n = cross(sub(d, b), sub(c, a));   // stations run nose→tail (−x): this order faces OUTWARD
            row.push(len(n) < 1e-9 ? null : nrm(n));
        }
        fN.push(row);
    }
    const vN = (i: number, k: number, own: V3): V3 => {   // grid vertex (ring i, point k) normal seen from face `own`
        let s: V3 = [0, 0, 0];
        for (const ii of [i - 1, i]) {
            if (ii < 0 || ii >= nI) continue;
            for (const kk of [(k - 1 + nK) % nK, k]) {
                const n = fN[ii][kk];
                if (n && dot(n, own) >= smoothCos) s = [s[0] + n[0], s[1] + n[1], s[2] + n[2]];
            }
        }
        return len(s) < 1e-9 ? own : nrm(s);
    };
    for (let i = 0; i < nI; i++) {
        for (let k = 0; k < nK; k++) {
            const own = fN[i][k]; if (!own) continue;
            const acc = pick(i, k); if (!acc) continue;
            const k1 = (k + 1) % nK;
            const corners: [number, number][] = [[i, k], [i + 1, k], [i + 1, k1], [i, k1]];
            const ids = corners.map(([ii, kk]) => {
                const p = rings[ii][kk];
                return acc.vertex(P(F, p[0], p[1], p[2]), D(F, vN(ii, kk, own)), p[0] * F.m, p[1] * F.m);
            });
            acc.triangle(ids[0], ids[2], ids[1]); acc.triangle(ids[0], ids[3], ids[2]);
        }
    }
}

/** Flat fan cap over a ring lying in the plane x = const, facing +x / −x. */
function capRing(acc: Accum3D, F: Frame, ring: V3[], sgn: 1 | -1): void {
    let cy = 0, cz = 0;
    for (const p of ring) { cy += p[1]; cz += p[2]; }
    cy /= ring.length; cz /= ring.length;
    const x = ring[0][0], n = D(F, [sgn, 0, 0]);
    const c = acc.vertex(P(F, x, cy, cz), n, 0.5, 0.5);
    const ids = ring.map(p => acc.vertex(P(F, p[0], p[1], p[2]), n, p[2] * F.m, p[1] * F.m));
    for (let k = 0; k < ids.length; k++) {
        const k1 = (k + 1) % ids.length;
        // Ring order runs +z side upward → over the top → down −z: for a +x cap that is CW seen from +x → flip.
        if (sgn > 0) acc.triangle(c, ids[k1], ids[k]); else acc.triangle(c, ids[k], ids[k1]);
    }
}

// ── WHEELS ─────────────────────────────────────────────────────────────────────────────────────────────────
/** One wheel: a LATHED tyre (rounded shoulders) + the rim face (silver multi-spoke alloy or a chrome hubcap).
 *  `x`, `zc` = hub centre (local metres), `side` = ±1 (outward = side·cW). */
function emitWheel(acc: VehicleAcc, F: Frame, x: number, zc: number, side: 1 | -1, R: number, tw: number, rim: 'alloy' | 'hubcap' | 'truck', spokes: number): void {
    // P20: a wheel is its own prop part (a parked car's frame bends with the full-tier drape over its length; one wheel
    // stays rigid within a millimetre). No-op outside a part (traffic, the creators). Bookkeeping only.
    // Its frame: the wheel centre, +Z along the car (front / rear wheels of a type share one canonical).
    const wc = P(F, x, R, zc), fwd: [number, number] = [F.aW[0], F.aW[2]], car = fwd;
    acc.trim.nextPart(wc, fwd); acc.chrome.nextPart(wc, fwd);
    try { emitWheelBody(acc, F, x, zc, side, R, tw, rim, spokes); } finally { acc.trim.nextPart(F.base, car); acc.chrome.nextPart(F.base, car); }
}
function emitWheelBody(acc: VehicleAcc, F: Frame, x: number, zc: number, side: 1 | -1, R: number, tw: number, rim: 'alloy' | 'hubcap' | 'truck', spokes: number): void {
    const m = F.m, axis = D(F, [0, 0, side]);
    const c = P(F, x, R, zc);
    const h = tw / 2;
    // Tyre profile [radius, along-axis] from the inner sidewall round the tread to the outer sidewall (outward = +h).
    acc.trim.lathe(c, axis, [[R * 0.66 * m, -h * m], [R * m, -h * 0.55 * m], [R * m, h * 0.55 * m], [R * 0.94 * m, h * m], [R * 0.70 * m, h * m]],
        12, { caps: [false, false], smooth: true });
    const at = (r: number, a: number, hh: number): V3 => P(F, x + Math.cos(a) * r, R + Math.sin(a) * r, zc + side * hh);
    const face = (dst: Accum3D, pts: V3[]): void => {   // a flat polygon on the wheel face, outward normal
        const ids = pts.map(p => dst.vertex(p, axis, 0.5, 0.5));
        for (let k = 1; k + 1 < ids.length; k++) {
            const n = cross(sub(pts[k], pts[0]), sub(pts[k + 1], pts[0]));
            if (dot(n, axis) >= 0) dst.triangle(ids[0], ids[k], ids[k + 1]); else dst.triangle(ids[0], ids[k + 1], ids[k]);
        }
    };
    const ring = (dst: Accum3D, r0: number, r1: number, hh: number, segs: number): void => {
        for (let k = 0; k < segs; k++) {
            const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2;
            face(dst, [at(r0, a0, hh), at(r1, a0, hh), at(r1, a1, hh), at(r0, a1, hh)]);
        }
    };
    const disc = (dst: Accum3D, r: number, hh: number, segs: number): void => {
        const pts: V3[] = [];
        for (let k = 0; k < segs; k++) pts.push(at(r, (k / segs) * Math.PI * 2, hh));
        face(dst, pts);
    };
    const inset = h - 0.035;
    // P9: with far twins (lod-accum.ts) the rim face goes to the full accumulators only, and the far twins get one
    // flat disc each (the barrel and the bright rim) instead of the lip ring, spokes and caps.
    const loTrim = loOf(acc.trim), loChrome = loOf(acc.chrome);
    if (loTrim) disc(loTrim, R * 0.70, inset, 6);
    if (loChrome) disc(loChrome, R * (rim === 'truck' ? 0.52 : 0.6), h - 0.014, 6);
    fullOnly([acc.trim, acc.chrome], () => {
    disc(acc.trim, R * 0.70, inset, 12);                                 // dark barrel behind the spokes (the "holes")
    if (rim === 'alloy') {
        ring(acc.chrome, R * 0.58, R * 0.70, h - 0.012, 12);             // polished outer lip
        const n = Math.max(3, spokes);
        for (let k = 0; k < n; k++) {                                    // tapered spokes, hub → lip
            const a = (k / n) * Math.PI * 2, w0 = 0.09 * R, w1 = 0.16 * R;
            const ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
            const r0 = R * 0.16, r1 = R * 0.60, hh = h - 0.02;
            const q = (r: number, w: number): V3 => P(F, x + ca * r + px * w, R + sa * r + py * w, zc + side * hh);
            face(acc.chrome, [q(r0, -w0 / 2), q(r1, -w1 / 2), q(r1, w1 / 2), q(r0, w0 / 2)]);
        }
        disc(acc.chrome, R * 0.19, h - 0.016, 8);                         // centre cap
    } else if (rim === 'hubcap') {
        disc(acc.chrome, R * 0.60, h - 0.014, 12);                        // full chrome hubcap
        disc(acc.trim, R * 0.14, h - 0.010, 6);                           // dark centre boss
    } else {                                                              // truck/bus: painted steel wheel + hub
        disc(acc.chrome, R * 0.52, h - 0.02, 10);
        disc(acc.trim, R * 0.20, h - 0.012, 6);
    }
    });
}

// ── CARS (the lofted body) ─────────────────────────────────────────────────────────────────────────────────
function emitCar(acc: VehicleAcc, F: Frame, type: VehicleType, lights: boolean): void {
    const S = shapeOf(type);
    const xs = stationsOf(S);
    // Rings: 16 points — p0, p1..p7 (+z), p8, p7..p1 (−z). The last ring at each end is the previous one pulled
    // in toward its centre (a small edge ROLL onto the fascia) and pushed out to ±hl.
    const ringOf = (x: number): V3[] => {
        const sec = sectionAt(S, x), r: V3[] = [];
        for (let k = 0; k <= 8; k++) r.push([x, sec[k][1], sec[k][0]]);
        for (let k = 7; k >= 1; k--) r.push([x, sec[k][1], -sec[k][0]]);
        return r;
    };
    const roll = (ring: V3[], x: number): V3[] => {
        let cy = 0; for (const p of ring) cy += p[1]; cy /= ring.length;
        return ring.map(p => [x, cy + (p[1] - cy) * 0.93, p[2] * 0.95] as V3);
    };
    const inner = xs.map(ringOf);
    const noseRing = roll(inner[0], S.hl), tailRing = roll(inner[inner.length - 1], -S.hl);
    const rings = [noseRing, ...inner, tailRing];
    const stX = rings.map(r => r[0][0]);

    // Material per (interval, band). Half-band hb = k (right side, k < 8) or 15 − k (left).
    const pillarAt = (x: number): boolean => S.pillars.some(p => Math.abs(x - p.x) < p.w / 2 + 1e-6);
    loft(F, rings, (i, k) => {
        const hb = k < 8 ? k : 15 - k, xm = (stX[i] + stX[i + 1]) / 2;
        if (hb === 0) return archAt(S, xm) > -Infinity ? acc.trim : null;   // flat floor is never seen — only the wheel-well roofs
        if (hb === 1) return acc.trim;                                      // rocker tuck + wheel-well roof over the tyre
        if (hb <= 4) return acc.body;                                       // the painted flanks
        const zone = xm > S.xWs ? 'hood' : xm > S.xH ? 'ws' : xm > S.xC ? 'cab' : xm > S.xBl ? 'bl' : 'deck';
        if (zone === 'hood' || zone === 'deck') return acc.body;
        if (hb === 5) {                                                     // side glass band
            if (zone === 'cab') return pillarAt(xm) ? acc.trim : acc.glass;
            if (zone === 'bl') return S.cSolid ? acc.body : acc.glass;
            return acc.glass;                                               // ws: the glass runs up the A pillar
        }
        if (hb === 6) return acc.body;                                      // A/C pillars + drip rail
        return zone === 'cab' ? acc.body : acc.glass;                       // hb 7: roof · windshield · backlight
    });
    capRing(acc.body, F, noseRing, 1);
    capRing(acc.body, F, tailRing, -1);

    // ── Fascia details on the nose / tail caps ──────────────────────────────────────────────────────────
    const fz = (ring: V3[]): number => ring[3][2];                                // shoulder half-width on the cap
    const fyTop = (ring: V3[]): number => ring[4][1];                             // belt-edge height on the cap
    const fyBot = (ring: V3[]): number => ring[2][1];
    const eps = 0.004;
    {   // FRONT: flush headlights, grille, rub strip / chrome bumper, lower intake
        const zc = fz(noseRing), yT = fyTop(noseRing) - 0.02, yB = fyBot(noseRing), x = S.hl + eps;
        const headAcc = lights ? acc.head : acc.lensHead;
        for (const sg of [-1, 1]) fasciaRect(headAcc, F, x, 1, sg > 0 ? zc * S.lamp.hIn : -zc * 0.90, sg > 0 ? zc * 0.90 : -zc * S.lamp.hIn, yT - S.lamp.hH, yT);
        const grille = S.chromeBumpers ? acc.chrome : acc.trim;
        fasciaRect(grille, F, x, 1, -zc * (S.lamp.hIn - 0.05), zc * (S.lamp.hIn - 0.05), yT - S.lamp.hH + 0.01, yT - 0.01);
        const yb = lerp(yB, yT - S.lamp.hH, 0.42);
        if (S.chromeBumpers) acc.chrome.bevelBox(P(F, S.hl + 0.03, yb, 0), F.aW, [0, 1, 0], F.cW, 0.05 * F.m, 0.055 * F.m, (zc + 0.02) * F.m, 0.02 * F.m);
        else fasciaRect(acc.trim, F, x, 1, -zc * 0.96, zc * 0.96, yb - 0.025, yb + 0.025);
        fasciaRect(acc.trim, F, x, 1, -zc * 0.5, zc * 0.5, yB + 0.03, Math.min(yb - 0.04, yB + 0.10));   // lower intake
    }
    {   // REAR: flush taillights, garnish, plate, rub strip / chrome bumper
        const zc = fz(tailRing), yT = fyTop(tailRing) - 0.02, yB = fyBot(tailRing), x = -S.hl - eps;
        const tailAcc = lights ? acc.tail : acc.lensTail;
        const tIn = S.lamp.tIn;
        for (const sg of [-1, 1]) fasciaRect(tailAcc, F, x, -1, sg > 0 ? zc * tIn : -zc * 0.93, sg > 0 ? zc * 0.93 : -zc * tIn, yT - S.lamp.tH, yT);
        if (tIn > 0.2) fasciaRect(acc.trim, F, x, -1, -zc * tIn, zc * tIn, yT - S.lamp.tH + 0.02, yT - 0.01);   // garnish between the lamps
        const yb = lerp(yB, yT - S.lamp.tH, 0.35);
        if (S.chromeBumpers) acc.chrome.bevelBox(P(F, -S.hl - 0.03, yb, 0), F.aW, [0, 1, 0], F.cW, 0.05 * F.m, 0.055 * F.m, (zc + 0.02) * F.m, 0.02 * F.m);
        else fasciaRect(acc.trim, F, x, -1, -zc * 0.96, zc * 0.96, yb - 0.025, yb + 0.025);
        const p0 = yb + 0.05, p1 = Math.min(p0 + 0.165, yT - S.lamp.tH - 0.01);
        if (p1 - p0 > 0.06) fasciaRect(acc.chrome, F, x - 0.002, -1, -0.17, 0.17, p0, p1);                   // number plate
    }

    // ── Side details (both sides): door seams, handles, body-side moulding / taxi belt, mirrors ─────────
    const doorF = Math.min(S.xWs + 0.04, S.axF - S.archR - 0.06);
    const doorB = S.pillars.length ? S.pillars[0].x : (S.xH + S.xC) / 2;
    const doorR = Math.max(S.axR + S.archR + 0.06, S.xBl + 0.02);
    const twoRows = doorR < doorB - 0.35;                                           // room for a rear door
    const seams = S.doors?.seams ?? (twoRows ? [doorF, doorB, doorR] : [doorF, doorB]);
    for (const side of [1, -1] as const) {
        // Door shut-lines — thin dark strips seated on the flank, rocker → belt.
        for (const sx of seams) {
            const sec = sectionAt(S, sx), dx = 0.006;
            for (let k = 2; k < 4; k++) {
                const [z0, y0] = sec[k], [z1, y1] = sec[k + 1];
                const a: V3 = [sx - dx, y0, side * (z0 + 0.003)], b: V3 = [sx + dx, y0, side * (z0 + 0.003)];
                const c: V3 = [sx + dx, y1, side * (z1 + 0.003)], d: V3 = [sx - dx, y1, side * (z1 + 0.003)];
                if (side > 0) lquad(acc.trim, F, a, b, c, d); else lquad(acc.trim, F, b, a, d, c);
            }
        }
        // Door handles near each door's trailing edge, just above the shoulder crease.
        const handles = S.doors?.handles ?? (twoRows ? [doorB + 0.13, doorR + 0.13] : [doorB + 0.13]);
        for (const hx of handles) {
            const sec = sectionAt(S, hx), y = sec[3][1] + 0.035, z = sideZ(sec, y) + 0.008;
            (S.chromeBumpers ? acc.chrome : acc.trim).obox(P(F, hx, y, side * z), F.aW, [0, 1, 0], F.cW, 0.06 * F.m, 0.012 * F.m, 0.008 * F.m);
        }
        // Body-side moulding (dark rub strip) — or the taxi's checker belt — along the doors, between the arches.
        const stripAcc = type === 'taxi' ? acc.band : S.moulding ? acc.trim : null;
        if (stripAcc) {
            const x0 = S.axF - S.archR - 0.03, x1 = S.axR + S.archR + 0.03;
            const pts = [x0, ...xs.filter(x => x < x0 && x > x1), x1];
            const yLo = type === 'taxi' ? S.shoulderY - 0.10 : lerp(S.sillY, S.shoulderY, 0.42) - 0.022;
            const yHi = type === 'taxi' ? S.shoulderY - 0.015 : yLo + 0.044;
            let u = 0;
            for (let j = 0; j + 1 < pts.length; j++) {
                const xa = pts[j], xb = pts[j + 1], sa = sectionAt(S, xa), sb = sectionAt(S, xb);
                const za0 = sideZ(sa, yLo) + 0.004, za1 = sideZ(sa, yHi) + 0.004, zb0 = sideZ(sb, yLo) + 0.004, zb1 = sideZ(sb, yHi) + 0.004;
                const du = (xa - xb) * F.m;
                const A = P(F, xa, yLo, side * za0), B = P(F, xb, yLo, side * zb0), C = P(F, xb, yHi, side * zb1), Dd = P(F, xa, yHi, side * za1);
                // quad4u normal = (b−a)×(d−a): nose→tail along −x, so the +z side needs the reversed order.
                if (side > 0) stripAcc.quad4u(B, A, Dd, C, u + du, u); else stripAcc.quad4u(A, B, C, Dd, u, u + du);
                u += du;
            }
        }
        // Door mirrors at the A-pillar base.
        // Seated against the glass just above the sill (a floating box off the belt read as a stray cube).
        const mx = S.xWs - 0.14, msec = sectionAt(S, mx), mz = msec[5][0] + 0.075, my = msec[5][1] + 0.07;
        acc.body.bevelBox(P(F, mx, my, side * mz), F.aW, [0, 1, 0], F.cW, 0.05 * F.m, 0.045 * F.m, 0.08 * F.m, 0.018 * F.m);
        acc.trim.obox(P(F, mx - 0.052, my, side * mz), F.aW, [0, 1, 0], F.cW, 0.003 * F.m, 0.036 * F.m, 0.066 * F.m);   // mirror glass (dark)
    }

    // ── Wheels (tucked into the arches) ─────────────────────────────────────────────────────────────────
    for (const ax of [S.axF, S.axR]) for (const side of [1, -1] as const) {
        const zc = halfWidthAt(S, ax) * 0.975 - S.tyreW / 2 - 0.015;
        emitWheel(acc, F, ax, side * zc, side, S.wheelR, S.tyreW, S.rim, S.spokes);
    }

    // ── Taxi: the andon roof sign (the shell-shaped JP cab lamp) ─────────────────────────────────────────
    if (type === 'taxi') {
        const sx = (S.xH + S.xC) / 2 + 0.12, ry = topAt(S, sx);
        acc.trim.obox(P(F, sx, ry + 0.012, 0), F.aW, [0, 1, 0], F.cW, 0.09 * F.m, 0.012 * F.m, 0.16 * F.m);
        acc.sign.bevelBox(P(F, sx, ry + 0.085, 0), F.aW, [0, 1, 0], F.cW, 0.07 * F.m, 0.06 * F.m, 0.20 * F.m, 0.035 * F.m);
    }
}

// ── BUS + TRUCK (bevelled boxes on the shared wheels) ──────────────────────────────────────────────────────
function emitBus(acc: VehicleAcc, F: Frame, lights: boolean): void {
    const m = F.m, up: V3 = [0, 1, 0];
    const L = 4.8, W = 1.24, R = 0.46, bot = 0.42, top = 3.0, cy = (bot + top) / 2, hy = (top - bot) / 2;
    acc.body.bevelBox(P(F, 0, cy, 0), F.aW, up, F.cW, L * m, hy * m, W * m, 0.14 * m);
    acc.glass.bevelBox(P(F, -0.1, 2.18, 0), F.aW, up, F.cW, (L - 0.45) * m, 0.46 * m, (W + 0.012) * m, 0.05 * m);   // side window band
    acc.glass.bevelBox(P(F, L - 0.04, 1.85, 0), F.aW, up, F.cW, 0.06 * m, 0.80 * m, (W - 0.10) * m, 0.04 * m);        // tall windscreen
    acc.trim.bevelBox(P(F, 0, bot + 0.12, 0), F.aW, up, F.cW, (L - 0.02) * m, 0.14 * m, (W + 0.01) * m, 0.05 * m);   // dark skirt / rub rail
    acc.body.bevelBox(P(F, 0.2, top + 0.08, 0), F.aW, up, F.cW, 1.2 * m, 0.1 * m, 0.8 * m, 0.05 * m);                 // roof A/C pod
    for (const sx of [-1, 1] as const) acc.trim.bevelBox(P(F, sx * (L + 0.02), 0.62, 0), F.aW, up, F.cW, 0.06 * m, 0.14 * m, (W - 0.04) * m, 0.03 * m);   // bumpers
    acc.sign.obox(P(F, L + 0.005, 2.78, 0), F.aW, up, F.cW, 0.02 * m, 0.10 * m, 0.70 * m);                             // destination board (lit)
    const head = lights ? acc.head : acc.lensHead, tail = lights ? acc.tail : acc.lensTail;
    for (const sg of [-1, 1]) {
        fasciaRect(head, F, L + 0.008, 1, sg * 0.80 - 0.20, sg * 0.80 + 0.20, 0.82, 0.98);
        fasciaRect(tail, F, -L - 0.008, -1, sg * 0.95 - 0.12, sg * 0.95 + 0.12, 0.80, 1.30);
    }
    for (const ax of [3.0, -2.9]) for (const side of [1, -1] as const) emitWheel(acc, F, ax, side * (W - 0.18), side, R, 0.30, 'truck', 0);
}

function emitTruck(acc: VehicleAcc, F: Frame, lights: boolean): void {
    const m = F.m, up: V3 = [0, 1, 0];
    const W = 1.12, R = 0.40;
    // Cab (paint) + a dark windscreen + side windows; an aluminium VAN BODY behind (the JP delivery truck).
    acc.body.bevelBox(P(F, 2.55, 1.40, 0), F.aW, up, F.cW, 0.85 * m, 0.95 * m, W * m, 0.16 * m);
    acc.glass.bevelBox(P(F, 3.05, 1.78, 0), F.aW, up, F.cW, 0.38 * m, 0.40 * m, (W + 0.012) * m, 0.06 * m);
    acc.chrome.bevelBox(P(F, -0.85, 1.70, 0), F.aW, up, F.cW, 2.55 * m, 1.18 * m, (W + 0.04) * m, 0.06 * m);        // cargo box
    acc.trim.bevelBox(P(F, 0, 0.62, 0), F.aW, up, F.cW, 3.35 * m, 0.14 * m, (W - 0.12) * m, 0.04 * m);                // chassis rails
    acc.trim.bevelBox(P(F, 3.42, 0.62, 0), F.aW, up, F.cW, 0.05 * m, 0.14 * m, (W - 0.02) * m, 0.03 * m);             // front bumper
    acc.trim.obox(P(F, 3.41, 1.12, 0), F.aW, up, F.cW, 0.01 * m, 0.14 * m, 0.46 * m);                                 // grille
    const head = lights ? acc.head : acc.lensHead, tail = lights ? acc.tail : acc.lensTail;
    for (const sg of [-1, 1]) {
        fasciaRect(head, F, 3.405, 1, sg * 0.80 - 0.18, sg * 0.80 + 0.18, 1.00, 1.16);
        fasciaRect(tail, F, -3.41, -1, sg * 0.98 - 0.10, sg * 0.98 + 0.10, 0.62, 0.82);
    }
    for (const ax of [2.55, -2.05]) for (const side of [1, -1] as const) emitWheel(acc, F, ax, side * (W - 0.16), side, R, 0.28, 'truck', 0);
}

/** Append one vehicle into `acc` at `base`, nose along +aW, width along cW. `lights` off for parked cars
 *  (their lenses go to the UNLIT lensHead / lensTail accumulators instead of the glowing head / tail ones). */
export function emitVehicle(acc: VehicleAcc, base: V3, aW: V3, cW: V3, s: number, type: VehicleType, opts: { lights?: boolean } = {}): void {
    const lights = opts.lights ?? true;
    const F: Frame = { base, aW, cW, m: s / 15 };
    if (type === 'bus') { emitBus(acc, F, lights); return; }
    if (type === 'truck') { emitTruck(acc, F, lights); return; }
    emitCar(acc, F, type, lights);
}

/** True when the accumulator produced geometry (skip empty layers so instancing/merges stay tight). */
function nonEmpty(a: Accum3D): boolean { return !a.empty; }

/** Layer name + material table shared by BOTH callers (traffic prefix `world:veh-`, parked prefix `world:car-`). */
export const VEH_LAYER_LOOK = {
    glass:    { color: VEH_GLASS, extra: { glass: true } as Partial<LayoutPreviewLayer> },
    trim:     { color: VEH_TYRE, extra: { reflect: { strength: 0.04, roughness: 0.62 } } as Partial<LayoutPreviewLayer> },   // satin rubber / black plastic
    lensHead: { color: VEH_LENS_HEAD, extra: { reflect: { strength: 0.3, roughness: 0.15 } } as Partial<LayoutPreviewLayer> },
    lensTail: { color: VEH_LENS_TAIL, extra: { reflect: { strength: 0.2, roughness: 0.2 } } as Partial<LayoutPreviewLayer> },
};
/** Car-paint clearcoat (car-creator.md §matcap): the GT sky sweep across the panels. */
export const VEH_PAINT: Partial<LayoutPreviewLayer> = { reflect: { strength: 0.42, roughness: 0.24 } };

/**
 * Turn a built bundle into render layers. `bodyName`/`bodyColor` cover the painted panels; the shared
 * material layers (glass/trim/chrome/lights) + the optional taxi belt/sign follow. Used by the traffic movers.
 */
export function vehicleLayers(acc: VehicleAcc, bodyName: string, bodyColor: V3): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const push = (a: Accum3D, name: string, color: V3, extra: Partial<LayoutPreviewLayer> = {}) => {
        if (nonEmpty(a)) out.push({ name, color, y: 0, geometry: a.geometry(), ...extra });
    };
    push(acc.body,     bodyName,               bodyColor, VEH_PAINT);
    push(acc.glass,    'world:veh-glass',      VEH_LAYER_LOOK.glass.color, VEH_LAYER_LOOK.glass.extra);
    push(acc.trim,     'world:veh-trim',       VEH_LAYER_LOOK.trim.color, VEH_LAYER_LOOK.trim.extra);
    push(acc.chrome,   'world:veh-chrome',     VEH_CHROME, { metal: { roughness: 0.22, scale: 40 } });
    // Names carry "headlight"/"taillight" so the night glow-walk (world-manager) boosts them at night.
    push(acc.head,     'world:veh-headlight',  VEH_HEAD,   { emissive: 0.5 });
    push(acc.tail,     'world:veh-taillight',  VEH_TAIL,   { emissive: 0.5 });
    // Unlit lenses (only when built with lights:false) — names must NOT match /headlight|taillight/.
    push(acc.lensHead, 'world:veh-lens-head',  VEH_LENS_HEAD, VEH_LAYER_LOOK.lensHead.extra);
    push(acc.lensTail, 'world:veh-lens-tail',  VEH_LENS_TAIL, VEH_LAYER_LOOK.lensTail.extra);
    // The checker belt: a near-black base with WHITE checker cells.
    push(acc.band,     'world:veh-band',       [0.08, 0.08, 0.09], { pattern: { color: [0.96, 0.96, 0.96], mode: 'checker', freq: 26, scale: 1 } });
    push(acc.sign,     'world:veh-sign',       VEH_TAXI_SIGN, { emissive: 0.6 });
    return out;
}
