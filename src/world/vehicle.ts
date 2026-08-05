/**
 * vehicle.ts — the shared low-poly VEHICLE builder used by both PARKED cars (furniture.ts) and MOVING
 * traffic (traffic.ts). One recipe, so an upgrade here improves the whole city at once.
 *
 * Upgrade over the old "body slab + cabin slab + 4 flat nubs":
 *  - a proper greenhouse (body → glass window band → thin roof cap) so windows read,
 *  - ROUND wheels that peek below the body, with chrome hubcaps,
 *  - chrome bumpers front + rear + a grille bar,
 *  - head/tail light detail (emissive; glow hard at night),
 *  - vehicle TYPES incl. old-school "long hood / long trunk" CLASSIC + the checker TAXI
 *    (yellow body + a checkerboard belt via the pattern shader + a glowing roof sign).
 *
 * All geometry is authored at `base`, nose ALONG +aW (the road-along axis), width along cW. Half-extents.
 */

import { Accum3D } from './meshbuild';
import type { LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

export type VehicleType = 'sedan' | 'classic' | 'taxi' | 'van' | 'bus' | 'truck';

/** Accumulator bundle. `body` is swapped per paint colour by the caller; the rest are shared. */
export interface VehicleAcc {
    body:   Accum3D;   // painted panels (per-colour in the parked merge; fresh per-archetype in traffic)
    glass:  Accum3D;   // window band + windshield (dark)
    trim:   Accum3D;   // tyres + lower valance (near-black)
    chrome: Accum3D;   // bumpers, grille, hubcaps (bright)
    head:   Accum3D;   // headlights (emissive)
    tail:   Accum3D;   // taillights (emissive)
    band:   Accum3D;   // taxi checkerboard belt (checker pattern layer)
    sign:   Accum3D;   // taxi roof sign (emissive)
}

export function makeVehicleAcc(body?: Accum3D): VehicleAcc {
    return {
        body:   body ?? new Accum3D(),
        glass:  new Accum3D(), trim: new Accum3D(), chrome: new Accum3D(),
        head:   new Accum3D(), tail: new Accum3D(), band: new Accum3D(), sign: new Accum3D(),
    };
}

// Shared material colours (the layers below reference these).
export const VEH_GLASS: V3  = [0.12, 0.16, 0.22];
export const VEH_TYRE: V3   = [0.06, 0.06, 0.07];
export const VEH_CHROME: V3 = [0.78, 0.80, 0.84];
export const VEH_HEAD: V3   = [1.0, 0.95, 0.80];
export const VEH_TAIL: V3   = [0.90, 0.14, 0.10];
export const VEH_TAXI: V3   = [0.96, 0.78, 0.12];   // classic cab yellow
export const VEH_TAXI_SIGN: V3 = [1.0, 0.85, 0.30];

interface Proportions { hl: number; hw: number; bodyH: number; roofH: number; cabinFrac: number; cabinBack: number; tumble: number; roof: boolean; wheelR: number; }

// Per-type silhouette (raw s-space; ×15 ≈ metres). Tuned for a LOW, long GT stance — the earlier cars were the
// right height but half-length (stubby + tall-topped). hl/hw = body HALF length/width. bodyH = body-side half-
// height, kept LOW so the car doesn't read as a brick. roofH = greenhouse height ABOVE the beltline (also low +
// raked below). tumble = cabin width ÷ body width (< 1 pulls the glasshouse in → the sleek tapered top).
function proportions(type: VehicleType, s: number): Proportions {
    switch (type) {
        // Old-school long-hood cruiser: long body, SHORT greenhouse pushed back, a touch taller cabin (the '60s look).
        case 'classic':
        case 'taxi': return { hl: 0.160 * s, hw: 0.060 * s, bodyH: 0.019 * s, roofH: 0.028 * s, cabinFrac: 0.32, cabinBack: 0.12, tumble: 0.80, roof: true, wheelR: 0.026 * s };
        case 'van':  return { hl: 0.150 * s, hw: 0.062 * s, bodyH: 0.032 * s, roofH: 0.050 * s, cabinFrac: 0.62, cabinBack: 0.04, tumble: 0.90, roof: true, wheelR: 0.025 * s };
        default:     return { hl: 0.150 * s, hw: 0.060 * s, bodyH: 0.017 * s, roofH: 0.024 * s, cabinFrac: 0.42, cabinBack: 0.10, tumble: 0.74, roof: true, wheelR: 0.025 * s };  // sedan
    }
}

/** Append one vehicle into `acc` at `base`, nose along +aW, width along cW. `lights` off for parked cars. */
export function emitVehicle(acc: VehicleAcc, base: V3, aW: V3, cW: V3, s: number, type: VehicleType, opts: { lights?: boolean } = {}): void {
    const lights = opts.lights ?? true;
    const up: V3 = [0, 1, 0];
    const tw = 0.011 * s;                                   // tyre half-width (across) — chunkier reads better
    const at = (a: number, y: number, c: number): V3 =>
        [base[0] + aW[0] * a + cW[0] * c, base[1] + y, base[2] + aW[2] * a + cW[2] * c];
    // A ROUND wheel — a 12-sided cylinder along the axle (`blob` is an octahedron → diamond wheels, so use `beam`),
    // with a chrome hubcap disc on the outer face. `a` = along, `sc` = cross side, `hw` = body half-width, `r` = radius.
    const nrmSide: V3 = [cW[0], cW[1], cW[2]];
    const wheel = (a: number, sc: number, hw: number, r: number): void => {
        const inner = at(a, r, sc * (hw - tw * 0.7)), outer = at(a, r, sc * (hw + tw * 0.9));
        const nOut: V3 = [nrmSide[0] * sc, nrmSide[1] * sc, nrmSide[2] * sc];
        acc.trim.beam(inner, outer, r, 14);                                                     // round tyre (cylinder tread)
        acc.trim.disc(outer, nOut, r, 14);                                                      // outer wheel FACE — caps the open tube (was a hollow ring)
        acc.chrome.disc([outer[0] + nOut[0] * 0.003 * s, outer[1] + nOut[1] * 0.003 * s, outer[2] + nOut[2] * 0.003 * s], nOut, r * 0.5, 12);   // hubcap
    };
    const front = (a: number, sc: number, y: number): void => { if (lights) acc.head.blob(at(a, y, sc), 0.006 * s, 0.005 * s, 0.006 * s, 0, 0); };
    const rear  = (a: number, sc: number, y: number): void => { if (lights) acc.tail.blob(at(a, y, sc), 0.005 * s, 0.004 * s, 0.005 * s, 0, 0); };

    // ── BUS: long body + a wrap-around window band + chrome + round wheels (~9.6 m × 2.5 m × 2.7 m) ────────
    if (type === 'bus') {
        const L = 0.32 * s, W = 0.083 * s, r = 0.026 * s;
        const bodyHalf = 0.075 * s, by = r * 1.05 + bodyHalf, top = by + bodyHalf;                 // roof ~2.7 m
        for (const sa of [-1, 1]) for (const sc of [-1, 1]) wheel(sa * L * 0.74, sc, W, r);
        acc.trim.obox(at(0, r * 0.9, 0), aW, up, cW, L * 0.98, r * 0.42, W * 0.98);                // skirt
        acc.body.obox(at(0, by, 0), aW, up, cW, L, bodyHalf, W);                                   // body
        acc.glass.obox(at(0, top - 0.03 * s, 0), aW, up, cW, L * 0.95, 0.02 * s, W * 1.02);        // window band
        acc.glass.obox(at(L * 0.965, top - 0.045 * s, 0), aW, up, cW, 0.006 * s, 0.03 * s, W * 0.9); // windscreen
        acc.body.obox(at(0, top + 0.004 * s, 0), aW, up, cW, L * 0.9, 0.004 * s, W * 0.92);        // roof cap
        for (const sa of [-1, 1]) acc.chrome.obox(at(sa * (L + 0.004 * s), r, 0), aW, up, cW, 0.006 * s, r * 0.5, W * 0.94);
        for (const sc of [-0.7, 0.7]) { front(L + 0.002 * s, sc * W, by - 0.02 * s); rear(-L - 0.001 * s, sc * W, by - 0.02 * s); }
        return;
    }

    // ── TRUCK: a dark cab up front + a coloured cargo box behind, on a chassis (~6.9 m × 2.25 m) ───────────
    if (type === 'truck') {
        const W = 0.075 * s, r = 0.024 * s;
        const cabHalf = 0.05 * s, cabY = r * 1.05 + cabHalf;                                        // cab ~2.1 m
        const boxHalf = 0.075 * s, boxY = r * 1.05 + boxHalf;                                       // cargo ~2.6 m
        for (const sc of [-1, 1]) { wheel(0.13 * s, sc, W, r); wheel(-0.11 * s, sc, W, r); }
        acc.trim.obox(at(0, r * 0.9, 0), aW, up, cW, 0.23 * s, r * 0.42, W * 0.98);                 // chassis
        acc.body.obox(at(-0.09 * s, boxY, 0), aW, up, cW, 0.13 * s, boxHalf, W);                    // cargo box (paint)
        acc.glass.obox(at(0.13 * s, cabY, 0), aW, up, cW, 0.055 * s, cabHalf, W * 0.98);            // cab (dark)
        acc.glass.obox(at(0.19 * s, cabY + 0.012 * s, 0), aW, up, cW, 0.006 * s, 0.02 * s, W * 0.86); // windscreen
        acc.chrome.obox(at(0.20 * s, r, 0), aW, up, cW, 0.006 * s, r * 0.5, W * 0.9);
        for (const sc of [-0.66, 0.66]) { front(0.195 * s, sc * W, cabY - 0.01 * s); rear(-0.22 * s, sc * W, boxY - 0.02 * s); }
        return;
    }

    // ── CARS (sedan / classic / taxi / van) — a LOW body with a set-back, tapered glasshouse (the GT profile) ─
    const P = proportions(type, s);
    const r = P.wheelR;
    for (const sa of [-1, 1]) for (const sc of [-1, 1]) wheel(sa * P.hl * 0.72, sc, P.hw, r);

    // Rocker / sill (dark) — a low bar between the wheels; inset so the wheels stand proud of it (not a full skirt).
    acc.trim.obox(at(0, r * 0.72, 0), aW, up, cW, P.hl * 0.7, r * 0.72, P.hw * 0.9);

    // BODY: raised so ~2/3 of each wheel shows below it — a low-slung stance only reads if the WHEELS read. Then
    // LOWER hood + trunk caps ahead/behind so the nose and deck slope BELOW the beltline (a wedge, not a brick).
    const bodyBot = r * 1.42;
    const bodyY = bodyBot + P.bodyH, bodyTop = bodyY + P.bodyH;                        // bodyTop = the beltline
    const coreHL = P.hl * 0.80;
    acc.body.obox(at(0, bodyY, 0), aW, up, cW, coreHL, P.bodyH, P.hw);                 // main tub
    const capHalfH = P.bodyH * 0.64, capCy = bodyBot + capHalfH;
    const capHL = (P.hl - coreHL) / 2, capCx = coreHL + capHL;
    acc.body.obox(at(capCx, capCy, 0), aW, up, cW, capHL, capHalfH, P.hw * 0.96);      // hood (front, lower)
    acc.body.obox(at(-capCx, capCy, 0), aW, up, cW, capHL, capHalfH, P.hw * 0.96);     // trunk (rear, lower)

    // GREENHOUSE: a SOLID, gap-free glasshouse built as a trapezoid extruded across the width. The old box + two
    // free-floating raked panels left OPEN triangular A/C-pillar gaps you could see straight through. Here the belt
    // (bottom) sits LONGER than the roof — the windshield + backlight lean OUT at the bottom = the rake — and the
    // roof is pulled in a touch narrower than the belt (tumblehome). Mesh is double-sided, so quad winding is free.
    const cabHL = P.hl * P.cabinFrac, cabA = -P.hl * P.cabinBack;
    const roofY = bodyTop + P.roofH;
    const rakeF = 0.18 * P.hl, rakeR = 0.15 * P.hl;
    const wB = P.hw * P.tumble, wR = wB * 0.9;                       // belt / roof half-widths (roof narrower = tumblehome)
    const fbx = cabA + cabHL + rakeF, frx = cabA + cabHL;           // FRONT: belt forward of the roof
    const kbx = cabA - cabHL - rakeR, krx = cabA - cabHL;           // BACK: belt aft of the roof
    const FBL = at(fbx, bodyTop, -wB), FBR = at(fbx, bodyTop, wB);
    const FRL = at(frx, roofY, -wR),   FRR = at(frx, roofY, wR);
    const KRL = at(krx, roofY, -wR),   KRR = at(krx, roofY, wR);
    const KBL = at(kbx, bodyTop, -wB), KBR = at(kbx, bodyTop, wB);
    acc.glass.quad4(FBL, FBR, FRR, FRL);   // windshield
    acc.glass.quad4(KBR, KBL, KRL, KRR);   // backlight
    acc.glass.quad4(FBL, FRL, KRL, KBL);   // left side glass
    acc.glass.quad4(FBR, KBR, KRR, FRR);   // right side glass
    acc.body.quad4(FRL, FRR, KRR, KRL);    // roof (body colour)
    acc.chrome.obox(at(cabA, bodyTop, 0), aW, up, cW, cabHL * 1.02, Math.max(0.0012 * s, P.roofH * 0.05), wB * 1.03);   // chrome window surround at the belt

    // Slim chrome bumpers — a THIN flat bar low on the nose/tail (not a chunky block) — plus a small DARK grille.
    for (const sa of [-1, 1]) acc.chrome.obox(at(sa * (P.hl + 0.002 * s), bodyBot + capHalfH * 0.3, 0), aW, up, cW, 0.006 * s, capHalfH * 0.22, P.hw * 0.78);
    acc.trim.obox(at(P.hl - 0.001 * s, capCy, 0), aW, up, cW, 0.004 * s, capHalfH * 0.45, P.hw * 0.48);   // dark grille intake

    // (Headlights / taillights removed — the user will paint them onto the GARP body texture. The head/tail
    //  accumulators + `front`/`rear` helpers remain for buses/trucks.)

    // Taxi identity: a checker STRIPE on the DOORS — a thin band proud of the body sides, centred mid-body so its
    // top/bottom hide INSIDE the body (the old version was a full-footprint slab that read as a giant floating
    // checker rectangle) — plus a glowing roof sign.
    if (type === 'taxi') {
        acc.band.obox(at(0, bodyY, 0), aW, up, cW, P.hl * 0.99, P.bodyH * 0.28, P.hw * 1.015);
        acc.sign.obox(at(cabA, roofY + 0.008 * s, 0), aW, up, cW, 0.012 * s, 0.006 * s, 0.015 * s);
    }
}

/** True when the accumulator produced geometry (skip empty layers so instancing/merges stay tight). */
function nonEmpty(a: Accum3D): boolean { return !a.empty; }

/**
 * Turn a built bundle into render layers. `bodyName`/`bodyColor` cover the painted panels; the shared
 * material layers (glass/trim/chrome/lights) + the optional taxi belt/sign follow. Used by BOTH callers.
 */
export function vehicleLayers(acc: VehicleAcc, bodyName: string, bodyColor: V3): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const push = (a: Accum3D, name: string, color: V3, extra: Partial<LayoutPreviewLayer> = {}) => {
        if (nonEmpty(a)) out.push({ name, color, y: 0, geometry: a.geometry(), ...extra });
    };
    push(acc.body,   bodyName,               bodyColor, { reflect: { strength: 0.4, roughness: 0.3 } });   // car-paint sheen (GT sky reflection sweep)
    push(acc.glass,  'world:veh-glass',      VEH_GLASS, { glass: true });
    push(acc.trim,   'world:veh-trim',       VEH_TYRE);
    push(acc.chrome, 'world:veh-chrome',     VEH_CHROME, { metal: { roughness: 0.28, scale: 40 } });
    // Names carry "headlight"/"taillight" so the night glow-walk (world-manager) boosts them at night.
    push(acc.head,   'world:veh-headlight',  VEH_HEAD,   { emissive: 0.5 });
    push(acc.tail,   'world:veh-taillight',  VEH_TAIL,   { emissive: 0.5 });
    // The checker belt: a near-black base with WHITE checker cells (the classic NYC cab stripe).
    push(acc.band,   'world:veh-band',       [0.08, 0.08, 0.09], { pattern: { color: [0.96, 0.96, 0.96], mode: 'checker', freq: 26, scale: 1 } });
    push(acc.sign,   'world:veh-sign',       VEH_TAXI_SIGN, { emissive: 0.6 });
    return out;
}
