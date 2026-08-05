// ── World generation — BOLLARD generator ────────────────────────────────────────────────────────
// A short protective post (kerb / plaza / shopfront edge). Third prop on the vending template. Adds two
// things the earlier props didn't exercise: a CAP STYLE enum that changes the geometry, and a FINISH enum
// that recolours the single metal layer via its tint — a good schema stress-test for `select` fields that
// drive shape AND material. Authored in real METRES.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { METAL_PAINTED } from './palette';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type BollardCap = 'dome' | 'ball' | 'ring';
export type BollardFinish = 'black' | 'steel' | 'navy' | 'red';

/** Finish → the painted-metal tint (metal tint replaces the diffuse, so this IS the body colour). */
export const BOLLARD_FINISHES: Record<BollardFinish, RGB> = {
    black: [0.09, 0.09, 0.10], steel: [0.55, 0.57, 0.60], navy: [0.14, 0.20, 0.34], red: [0.55, 0.12, 0.12],
};
export const BOLLARD_CAPS: BollardCap[] = ['dome', 'ball', 'ring'];
export const BOLLARD_FINISH_NAMES: BollardFinish[] = ['black', 'steel', 'navy', 'red'];

export interface BollardParams {
    cap: BollardCap;
    finish: BollardFinish;
    heightM: number;    // post height above ground (metres)
    radiusM: number;    // post radius (metres)
    seed: number;
}

export const DEFAULT_BOLLARD_PARAMS: BollardParams = {
    cap: 'dome', finish: 'black', heightM: 0.9, radiusM: 0.11, seed: 1,
};

export function resolveBollardParams(p: Partial<BollardParams> = {}): BollardParams {
    return {
        ...DEFAULT_BOLLARD_PARAMS, ...p,
        cap: BOLLARD_CAPS.includes(p.cap as BollardCap) ? (p.cap as BollardCap) : DEFAULT_BOLLARD_PARAMS.cap,
        finish: BOLLARD_FINISH_NAMES.includes(p.finish as BollardFinish) ? (p.finish as BollardFinish) : DEFAULT_BOLLARD_PARAMS.finish,
        heightM: Math.max(0.3, p.heightM ?? DEFAULT_BOLLARD_PARAMS.heightM),
        radiusM: Math.max(0.04, p.radiusM ?? DEFAULT_BOLLARD_PARAMS.radiusM),
    };
}

export interface BollardMeta { height: number; footprint: [number, number][]; }

/** Emit ONE bollard into `acc`. @param base foot centre (world units) · @param worldPerMetre scale bridge. */
export function emitBollard(acc: Accum3D, base: V3, params: BollardParams, worldPerMetre: number): void {
    const s = worldPerMetre;
    const h = params.heightM * s, r = params.radiusM * s;
    const cx = base[0], cy = base[1], cz = base[2];

    // Column — a slightly tapered 10-gon post (wider at the base reads as cast iron).
    acc.prism([cx, cy, cz], r * 1.06, r * 1.06, h * 0.12, 10);          // base plinth
    acc.prism([cx, cy + h * 0.12, cz], r, r, h * 0.88, 10);            // shaft

    // Cap by style.
    const top = cy + h;
    if (params.cap === 'dome') {
        acc.blob([cx, top, cz], r, r * 0.85, r, 0);                    // rounded dome
    } else if (params.cap === 'ball') {
        acc.prism([cx, top - h * 0.02, cz], r * 1.02, r * 1.02, h * 0.03, 10);   // collar under the ball
        acc.blob([cx, top + r * 0.55, cz], r * 0.92, r * 0.92, r * 0.92, 0);     // sphere finial
    } else {
        // ring: a wider banded collar near the top + a flat cap.
        acc.prism([cx, top - h * 0.10, cz], r * 1.22, r * 1.22, h * 0.06, 10);   // band
        acc.prism([cx, top - h * 0.02, cz], r, r, h * 0.02, 10);                 // flat top
    }
}

/** The bollard as one painted-metal layer, tinted by its finish. */
export function bollardLayers(acc: Accum3D, tint: RGB, metalScale: number): LayoutPreviewLayer[] {
    if (acc.empty) return [];
    return [{ name: 'world:bollard', color: tint, y: 0, geometry: acc.geometry(),
        metal: { ...METAL_PAINTED, tint, scale: metalScale } }];
}

/** Standalone: build ONE bollard at the origin, authored 1:1 in METRES, as layers + meta (the creator entry). */
export function buildBollard(params: Partial<BollardParams> = {}): { layers: LayoutPreviewLayer[]; meta: BollardMeta } {
    const p = resolveBollardParams(params);
    const acc = new Accum3D();
    emitBollard(acc, [0, 0, 0], p, 1);               // 1 world unit = 1 m
    const layers = bollardLayers(acc, BOLLARD_FINISHES[p.finish], 3);
    const rr = p.radiusM * 1.25;
    return { layers, meta: { height: p.heightM, footprint: [[-rr, -rr], [rr, -rr], [rr, rr], [-rr, rr]] } };
}
