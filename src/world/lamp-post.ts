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

/** Emit ONE lamp post into `acc`. @param base foot centre (world units) · @param dir facing (for the arm/banners)
 *  · @param worldPerMetre scale bridge · @param bannerColor per-post banner tint (city can vary it). */
export function emitLampPost(acc: LampPostAccum, base: V3, dir: V2, params: LampPostParams, worldPerMetre: number, opts: { reachM?: number } = {}): void {
    const s = worldPerMetre;
    const H = params.heightM * s;
    const cx = base[0], cy = base[1], cz = base[2];
    const f: V3 = [dir[0], 0, dir[1]];               // arm reaches this way
    const r: V3 = [-dir[1], 0, dir[0]];              // banner cross-axis (the two banners sit ±r)

    // Pole — a wider plinth + a slim tapered shaft (galvanised).
    acc.metal.prism([cx, cy, cz], 0.12 * s, 0.12 * s, 0.14 * s, 8);              // plinth
    acc.metal.prism([cx, cy + 0.14 * s, cz], 0.05 * s, 0.045 * s, H - 0.14 * s, 8);  // shaft (slight taper)

    // CANTILEVER STREET-LIGHT variant (opts.reachM): a long arm reaching `reachM` metres over the road with a
    // downlight housing at the end — the functional intersection/arterial light. No acorn head, no banners.
    if (opts.reachM && opts.reachM > 0) {
        const reach = opts.reachM * s, ty = cy + H;
        const ax = cx + f[0] * reach, az = cz + f[2] * reach;
        acc.metal.beam([cx, ty, cz], [ax, ty - 0.06 * s, az], 0.035 * s);              // gently down-sloping arm
        acc.metal.prism([ax, ty - 0.15 * s, az], 0.14 * s, 0.14 * s, 0.09 * s, 6);     // downlight housing HANGING under the arm (base ty-0.15 → top ty-0.06)
        acc.glow.blob([ax, ty - 0.15 * s, az], 0.11 * s, 0.035 * s, 0.11 * s, 0);      // emissive pane FLUSH at the housing base (was 0.08 m below → floating)
        return;
    }

    // Lamp head — a housing box + an emissive glow just under it.
    const top = cy + H;
    if (params.style === 'modern') {
        // Sleek downlight: a short arm + a flat housing over an emissive underside.
        const ax = cx + f[0] * 0.30 * s, az = cz + f[2] * 0.30 * s;
        acc.metal.beam([cx, top, cz], [ax, top, az], 0.03 * s);                 // arm
        acc.metal.prism([ax, top - 0.04 * s, az], 0.10 * s, 0.10 * s, 0.06 * s, 6);   // housing
        acc.glow.blob([ax, top - 0.09 * s, az], 0.08 * s, 0.03 * s, 0.08 * s, 0);     // emissive pane
    } else {
        // Classic acorn: a tapered cap over a glowing globe.
        acc.glow.blob([cx, top + 0.10 * s, cz], 0.12 * s, 0.16 * s, 0.12 * s, 0);     // globe
        acc.metal.cone([cx, top + 0.24 * s, cz], 0.15 * s, 0.14 * s, 8);              // cap (finial)
    }

    // Banners — a cross-arm near the top with two fabric panels hanging from its ends (windSway).
    if (params.banners) {
        const armY = cy + H * 0.66;
        const armLen = 0.34 * s;
        // Cross-arm (metal) spanning ±r from the pole.
        acc.metal.beam([cx - r[0] * armLen, armY, cz - r[2] * armLen], [cx + r[0] * armLen, armY, cz + r[2] * armLen], 0.02 * s);
        const bw = 0.16 * s, bh = 0.7 * s;                                       // banner half-width / height
        for (const side of [-1, 1]) {
            const hx = cx + r[0] * side * armLen, hz = cz + r[2] * side * armLen;   // hang point
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
