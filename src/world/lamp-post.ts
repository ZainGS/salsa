// ── World generation — LAMP POST generator ──────────────────────────────────────────────────────
// A street lamp on the vending/bike-rack/bollard template, and the first prop to exercise TWO reuses at once:
// an EMISSIVE lamp head (glows at night, like the vending window) and hanging FABRIC BANNERS that reuse the
// foliage WIND system (windSway) to catch the breeze. The banner is a natural GARP/decal slot later (its art is
// the variety) — the pole never is. Authored in real METRES; the caller supplies a world-units-per-metre factor.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { METAL_POLE } from './palette';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type LampStyle = 'modern' | 'classic';
export const LAMP_STYLES: LampStyle[] = ['modern', 'classic'];

const POLE: RGB = [0.20, 0.21, 0.23];     // dark galvanised pole
const HOUSING: RGB = [0.14, 0.14, 0.16];  // lamp housing
const GLOW: RGB = [1.0, 0.93, 0.78];      // warm sodium lamp

export interface LampPostParams {
    style: LampStyle;
    heightM: number;                 // pole height (metres)
    banners: boolean;                // hang two fabric banners from a cross-arm
    bannerColor: [number, number, number];
    seed: number;
}

export const DEFAULT_LAMP_POST_PARAMS: LampPostParams = {
    style: 'classic', heightM: 4, banners: true, bannerColor: [0.72, 0.16, 0.18], seed: 1,
};

export function resolveLampPostParams(p: Partial<LampPostParams> = {}): LampPostParams {
    return {
        ...DEFAULT_LAMP_POST_PARAMS, ...p,
        style: LAMP_STYLES.includes(p.style as LampStyle) ? (p.style as LampStyle) : DEFAULT_LAMP_POST_PARAMS.style,
        heightM: Math.max(2, Math.min(8, p.heightM ?? DEFAULT_LAMP_POST_PARAMS.heightM)),
        banners: p.banners ?? DEFAULT_LAMP_POST_PARAMS.banners,
    };
}

export interface LampPostMeta { height: number; footprint: [number, number][]; }

/** Caller-owned accumulator bundle: metal (pole/housing), glow (emissive lamp), banner (windSway fabric). */
export interface LampPostAccum { metal: Accum3D; glow: Accum3D; banner: Accum3D; }
export function newLampPostAccum(): LampPostAccum { return { metal: new Accum3D(), glow: new Accum3D(), banner: new Accum3D() }; }

// ── Head geometry (metres) — shared by emitLampPost + lampHeadOffset so light pools / point lights find the
// glowing glass without re-deriving the arm. T3.1 (polish round 3): swept arms + bell / cobra / lantern heads.
const SWAN_R = 0.45;        // modern swan-neck: quarter-arc radius
const SWAN_EXT = 0.18;      // straight run past the arc to the bell hanger
const ARM_DROP = 0.08;      // modern: the arm runs this far under the nominal pole height
const BELL_H = 0.22;        // modern: bell height (its rim = the glass rim)
const DAVIT_R = 0.7;        // cantilever (junction) arm: quarter-arc radius
const DAVIT_DROP = 0.2;     // the arc apex sits this far under the nominal pole height
const DAVIT_RISE = 0.08;    // the straight run rises this much toward the head
const COBRA_LEN = 0.72;     // cobra head length along the arm
const LENS_DROP = 0.11;     // cobra: the bowl rim sits this far under the head's centreline

/** Where the lamp's glowing glass sits relative to the post foot, in METRES: `reachM` along the facing dir, and the
 *  TOP of the glowing glass `glassYM` (the rim of a hanging bowl). Light pools (streets.ts) key off it; the junction point lights (world-manager,
 *  0.34·s ≈ 5.1 m at the default radius) sit at the cantilever glass height. */
export function lampHeadOffset(params: LampPostParams, opts: { reachM?: number } = {}): { reachM: number; glassYM: number } {
    const H = params.heightM;
    if (opts.reachM && opts.reachM > 0) return { reachM: opts.reachM, glassYM: H - DAVIT_DROP + DAVIT_RISE - LENS_DROP };
    if (params.style === 'modern') return { reachM: SWAN_R + SWAN_EXT, glassYM: H - ARM_DROP - 0.08 - BELL_H + 0.02 };
    return { reachM: 0, glassYM: H + 0.43 };
}

const mS = (prof: [number, number][], s: number): [number, number][] => prof.map(([r, h]) => [r * s, h * s]);

/** The bevelled post every style shares: a chamfered plinth, a bell-flared base with a COLLAR ring, then a tapered
 *  shaft up to `topM`. One lathe (8 sides, crisp per-segment normals) — 136 tris. */
function postLathe(acc: Accum3D, c: V3, s: number, topM: number, rTopM: number): void {
    const prof: [number, number][] = [
        [0.17, 0], [0.17, 0.05], [0.14, 0.08],            // chamfered plinth
        [0.105, 0.14], [0.088, 0.36],                     // flared base
        [0.096, 0.38], [0.096, 0.44], [0.066, 0.47],      // collar ring
        [rTopM, topM],                                    // the tapered shaft
    ];
    acc.lathe(c, [0, 1, 0], mS(prof, s), 8, { caps: [false, true] });
}

/** A quarter-arc SWEPT arm path: rises from just inside the shaft top, curves over by `R`, then runs straight to
 *  (`endA`, `endY`). Metres, in the post's (along-f, up) plane. */
function arcArm(at: (a: number, y: number) => V3, shaftTop: number, R: number, endA: number, endY: number): V3[] {
    const path: V3[] = [at(0, shaftTop - 0.05)];
    for (let k = 0; k <= 6; k++) {
        const t = (k / 6) * Math.PI * 0.5;
        path.push(at(R * (1 - Math.cos(t)), shaftTop + R * Math.sin(t)));
    }
    path.push(at(endA, endY));
    return path;
}

/** Emit ONE lamp post into `acc`. @param base foot centre (world units) · @param dir facing (for the arm/banners)
 *  · @param worldPerMetre scale bridge · @param bannerColor per-post banner tint (city can vary it). */
export function emitLampPost(acc: LampPostAccum, base: V3, dir: V2, params: LampPostParams, worldPerMetre: number, opts: { reachM?: number } = {}): void {
    const s = worldPerMetre;
    const H = params.heightM;                         // metres
    const cx = base[0], cy = base[1], cz = base[2];
    const f: V3 = [dir[0], 0, dir[1]];               // arm reaches this way
    const r: V3 = [-dir[1], 0, dir[0]];              // banner cross-axis (the two banners sit ±r)
    // A point `a` metres along f and `y` metres up from the foot.
    const at = (a: number, y: number): V3 => [cx + f[0] * a * s, cy + y * s, cz + f[2] * a * s];
    const taper = (path: V3[], r0: number, r1: number): number[] => path.map((_, i) => (r0 + (r1 - r0) * i / (path.length - 1)) * s);

    // CANTILEVER STREET-LIGHT variant (opts.reachM): a DAVIT arm — the post rises, curves over in a quarter arc
    // and runs out `reachM` metres over the road, gently rising, to a COBRA head with a glowing bowl underneath.
    if (opts.reachM && opts.reachM > 0) {
        const reach = opts.reachM, apex = H - DAVIT_DROP, shaftTop = apex - DAVIT_R;
        const headStart = reach - COBRA_LEN * 0.5, yH = apex + DAVIT_RISE;
        postLathe(acc.metal, [cx, cy, cz], s, shaftTop, 0.05);
        acc.metal.nextPart();   // P20: the post, the arm and the head are separate prop parts (the kerb lift splits them)
        const path = arcArm(at, shaftTop, DAVIT_R, headStart + 0.06, yH);
        acc.metal.sweep(path, taper(path, 0.05, 0.032), 6, [false, true]);
        acc.metal.nextPart();
        // Cobra head: a smooth pod along the arm.
        acc.metal.lathe(at(headStart, yH), f, mS([[0.035, 0], [0.11, 0.08], [0.15, 0.26], [0.145, 0.46], [0.09, 0.64], [0, COBRA_LEN]], s), 10, { smooth: true, caps: [true, false] });
        // Glowing bowl under the pod (rim inside the pod shell, bulging ~1 cm below it).
        acc.glow.lathe(at(reach, yH - LENS_DROP), [0, -1, 0], mS([[0.10, 0], [0.085, 0.03], [0, 0.05]], s), 10, { smooth: true, caps: [false, false] });
        return;
    }

    if (params.style === 'modern') {
        // SWAN NECK: the shaft curves over in a quarter arc and runs out to a hanging BELL over a glass bowl.
        const armY = H - ARM_DROP, shaftTop = armY - SWAN_R, reach = SWAN_R + SWAN_EXT;
        postLathe(acc.metal, [cx, cy, cz], s, shaftTop, 0.045);
        acc.metal.nextPart();   // P20: post / arm / bell are separate prop parts (the kerb lift splits them)
        const path = arcArm(at, shaftTop, SWAN_R, reach + 0.03, armY - 0.02);
        acc.metal.sweep(path, taper(path, 0.045, 0.03), 6, [false, true]);
        acc.metal.nextPart();
        // Hanger collar + bell (smooth shade) + the glowing bowl under it.
        const bellBot = armY - 0.08 - BELL_H;
        acc.metal.lathe(at(reach, armY - 0.1), [0, 1, 0], mS([[0.028, 0], [0.028, 0.09]], s), 6, { caps: [false, false] });
        acc.metal.lathe(at(reach, bellBot), [0, 1, 0], mS([[0.20, 0], [0.19, 0.03], [0.14, 0.09], [0.07, 0.16], [0.03, BELL_H]], s), 10, { smooth: true, caps: [false, true] });
        acc.glow.lathe(at(reach, bellBot + 0.02), [0, -1, 0], mS([[0.185, 0], [0.15, 0.04], [0, 0.07]], s), 10, { smooth: true, caps: [false, false] });
    } else {
        // CLASSIC LANTERN: the post tops out in a capital; a faceted hexagonal glass lantern sits on it under a
        // flared roof with a finial.
        postLathe(acc.metal, [cx, cy, cz], s, H, 0.05);
        acc.metal.lathe(at(0, H), [0, 1, 0], mS([[0.05, 0], [0.09, 0.05], [0.11, 0.08], [0.1, 0.1]], s), 6, { caps: [false, true] });
        acc.glow.lathe(at(0, H + 0.1), [0, 1, 0], mS([[0.09, 0], [0.14, 0.30], [0.12, 0.33]], s), 6, { caps: [false, false] });
        acc.metal.lathe(at(0, H + 0.43), [0, 1, 0], mS([[0.18, 0], [0.17, 0.035], [0.07, 0.14], [0.025, 0.19], [0.04, 0.22], [0, 0.28]], s), 6, { caps: [true, false] });
    }

    // Banners — a cross-arm near the top with two fabric panels hanging from its ends (windSway).
    if (params.banners) {
        acc.metal.nextPart();   // P20: the banner cross-arm is its own prop part
        const armY = cy + H * 0.66 * s;
        const armLen = 0.34 * s;
        // Cross-arm (metal) spanning ±r from the pole, with ball finials on the ends.
        acc.metal.beam([cx - r[0] * armLen, armY, cz - r[2] * armLen], [cx + r[0] * armLen, armY, cz + r[2] * armLen], 0.02 * s, 6);
        const bw = 0.16 * s, bh = 0.7 * s;                                       // banner half-width / height
        for (const side of [-1, 1]) {
            const hx = cx + r[0] * side * armLen, hz = cz + r[2] * side * armLen;   // hang point
            acc.metal.blob([hx + r[0] * side * 0.02 * s, armY, hz + r[2] * side * 0.02 * s], 0.03 * s, 0.03 * s, 0.03 * s);
            // A vertical fabric quad facing `f`, from armY down bh, ±bw across `r`. Double-sided by default.
            const tl: V3 = [hx - r[0] * bw, armY, hz - r[2] * bw];
            const tr: V3 = [hx + r[0] * bw, armY, hz + r[2] * bw];
            const br: V3 = [hx + r[0] * bw, armY - bh, hz + r[2] * bw];
            const bl: V3 = [hx - r[0] * bw, armY - bh, hz - r[2] * bw];
            acc.banner.quad4(tl, tr, br, bl);
        }
    }
}

/** Turn a filled bundle into named, material-tagged layers. `metalScale` = metal detail freq (cycles/world-unit);
 *  `night` brightens the lamp. Banners carry the WIND spec (a near-rigid sway — height is small so the whole panel
 *  catches the breeze rather than the base-planted gradient foliage uses). */
export function lampPostLayers(acc: LampPostAccum, bannerColor: RGB, metalScale: number, opts: { night: boolean }): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    if (!acc.metal.empty) out.push({ name: 'world:lamp-pole', color: POLE, y: 0, geometry: acc.metal.geometry(),
        metal: { ...METAL_POLE, tint: POLE, scale: metalScale } });
    if (!acc.glow.empty) out.push({ name: 'world:lamp-glow', color: GLOW, y: 0, geometry: acc.glow.geometry(),
        emissive: opts.night ? 1.6 : 0.7 });
    if (!acc.banner.empty) out.push({ name: 'world:lamp-banner', color: bannerColor, y: 0, geometry: acc.banner.geometry(),
        wind: { height: 0.6, stiffness: 1.0, amount: 0.5 } });   // reuse windSway — whole banner sways
    void HOUSING;   // reserved for a future two-tone housing
    return out;
}

/** Standalone: build ONE lamp post at the origin facing +Z, authored 1:1 in METRES, as layers + meta (the creator
 *  entry — the manager display-scales the group like the other props). */
export function buildLampPost(params: Partial<LampPostParams> = {}): { layers: LayoutPreviewLayer[]; meta: LampPostMeta } {
    const p = resolveLampPostParams(params);
    const acc = newLampPostAccum();
    emitLampPost(acc, [0, 0, 0], [0, 1], p, 1);      // 1 world unit = 1 m
    const layers = lampPostLayers(acc, p.bannerColor, 3, { night: false });
    const rr = 0.14;
    return { layers, meta: { height: p.heightM, footprint: [[-rr, -rr], [rr, -rr], [rr, rr], [-rr, rr]] } };
}
