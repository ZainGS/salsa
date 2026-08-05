// ── World generation — TRASH BIN generator ──────────────────────────────────────────────────────────
// A public litter bin for street clutter. Follows the vending/bollard Creator template: authored in real
// METRES, standalone `buildTrashBin()` for the Creator panel + `emitTrashBin()` for city scatter. GARP-ready:
// the body is one clean box/cylinder, so a pool can wrap a branded skin over it later (like vending).

import type { LayoutPreviewLayer, InstanceXform } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';
import { METAL_PAINTED } from './palette';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type BinShape = 'round' | 'square';
export type BinFinish = 'green' | 'steel' | 'black' | 'blue' | 'red';

/** Finish → body tint (metal-painted tint replaces the diffuse, so this IS the body colour). */
export const BIN_FINISHES: Record<BinFinish, RGB> = {
    green: [0.13, 0.30, 0.18], steel: [0.52, 0.54, 0.57], black: [0.09, 0.09, 0.10],
    blue: [0.13, 0.24, 0.40], red: [0.46, 0.12, 0.12],
};
export const BIN_SHAPES: BinShape[] = ['round', 'square'];
export const BIN_FINISH_NAMES: BinFinish[] = ['green', 'steel', 'black', 'blue', 'red'];

export interface TrashBinParams {
    shape: BinShape;
    finish: BinFinish;
    heightM: number;   // body height (m)
    radiusM: number;   // body radius / half-width (m)
    lid: boolean;      // domed lid with a drop slot
    seed: number;
}

export const DEFAULT_TRASH_BIN_PARAMS: TrashBinParams = {
    shape: 'round', finish: 'green', heightM: 0.95, radiusM: 0.22, lid: true, seed: 1,
};

export function resolveTrashBinParams(p: Partial<TrashBinParams> = {}): TrashBinParams {
    return {
        ...DEFAULT_TRASH_BIN_PARAMS, ...p,
        shape: BIN_SHAPES.includes(p.shape as BinShape) ? (p.shape as BinShape) : DEFAULT_TRASH_BIN_PARAMS.shape,
        finish: BIN_FINISH_NAMES.includes(p.finish as BinFinish) ? (p.finish as BinFinish) : DEFAULT_TRASH_BIN_PARAMS.finish,
        heightM: Math.max(0.4, p.heightM ?? DEFAULT_TRASH_BIN_PARAMS.heightM),   // floor == schema min
        radiusM: Math.max(0.1, p.radiusM ?? DEFAULT_TRASH_BIN_PARAMS.radiusM),
        lid: p.lid ?? DEFAULT_TRASH_BIN_PARAMS.lid,
    };
}

export interface TrashBinMeta { height: number; footprint: [number, number][]; }

/** Emit ONE bin into `acc` (body) + `dark` (rim/lid/slot). @param base foot centre · @param worldPerMetre scale bridge. */
export function emitTrashBin(acc: Accum3D, dark: Accum3D, base: V3, params: TrashBinParams, worldPerMetre: number): void {
    const s = worldPerMetre;
    const h = params.heightM * s, r = params.radiusM * s;
    const cx = base[0], cy = base[1], cz = base[2];
    const up: V3 = [0, 1, 0], ax: V3 = [1, 0, 0], az: V3 = [0, 0, 1];

    if (params.shape === 'round') {
        acc.prism([cx, cy, cz], r, r, h, 12);                                    // barrel
        dark.prism([cx, cy + h * 0.06, cz], r * 1.03, r * 1.03, h * 0.05, 12);   // lower band
        dark.prism([cx, cy + h, cz], r * 1.05, r * 1.05, h * 0.05, 12);          // top rim
        if (params.lid) {
            acc.blob([cx, cy + h + h * 0.04, cz], r * 1.02, r * 0.4, r * 1.02, 0);     // domed lid
            dark.obox([cx, cy + h + h * 0.06, cz], ax, up, az, r * 0.5, h * 0.03, r * 0.14);   // drop slot
        }
    } else {
        acc.obox([cx, cy + h / 2, cz], ax, up, az, r, h / 2, r);                  // box body
        dark.obox([cx, cy + h, cz], ax, up, az, r * 1.05, h * 0.04, r * 1.05);    // top rim
        if (params.lid) {
            acc.obox([cx, cy + h + h * 0.03, cz], ax, up, az, r * 1.02, h * 0.03, r * 1.02);   // flat lid
            dark.obox([cx, cy + h + h * 0.05, cz], ax, up, az, r * 0.5, h * 0.02, r * 0.16);   // slot
        }
    }
}

/** The bin as a painted-metal body + a dark rim/lid layer. */
export function trashBinLayers(acc: Accum3D, dark: Accum3D, tint: RGB, metalScale: number): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    if (!acc.empty)  out.push({ name: 'world:trash-bin', color: tint, y: 0, geometry: acc.geometry(), metal: { ...METAL_PAINTED, tint, scale: metalScale } });
    if (!dark.empty) out.push({ name: 'world:trash-bin-dark', color: [0.10, 0.10, 0.11], y: 0, geometry: dark.geometry() });
    return out;
}

/** Standalone: build ONE bin at the origin, authored 1:1 in METRES, as layers + meta (the Creator entry). */
export function buildTrashBin(params: Partial<TrashBinParams> = {}): { layers: LayoutPreviewLayer[]; meta: TrashBinMeta } {
    const p = resolveTrashBinParams(params);
    const acc = new Accum3D(), dark = new Accum3D();
    emitTrashBin(acc, dark, [0, 0, 0], p, 1);        // 1 world unit = 1 m
    const rr = p.radiusM * 1.15;
    return { layers: trashBinLayers(acc, dark, BIN_FINISHES[p.finish], 3), meta: { height: p.heightM, footprint: [[-rr, -rr], [rr, -rr], [rr, rr], [-rr, rr]] } };
}

// ── GARP: skinnable bin body (docs/specs/city-props-garp.md) — instanced round barrel, skin wraps it ─────
export const BIN_CANON_M = 1.0;                        // canonical body height (m); instances scale uniformly
export const BIN_SKIN_NAMES = ['municipal', 'recycle', 'brand'];
export function binSkinKey(name: string): string { return `bin/${name}/body`; }
export function binGarpPool(): GarpPool {
    return {
        id: 'salsa/bin', name: 'Trash bins', version: 1, size: [512, 512], slots: ['body'],
        defaults: { body: binSkinKey('municipal') },
        skins: BIN_SKIN_NAMES.map((n) => ({ name: n, slots: { body: binSkinKey(n) } })),
    };
}
/** ONE canonical bin barrel centred at the origin — a 14-gon cylinder whose wrap-UV lets a skin band the body. */
export function binCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const r = 0.22 * worldPerMetre, h = BIN_CANON_M * worldPerMetre;
    a.prism([0, -h / 2, 0], r, r, h, 14);              // bottom at -h/2, top at +h/2 → centred
    return a.geometry();
}
/** One instance transform for a bin at `base` (foot centre); uniform scale from the canonical height. */
export function binInstanceTransform(base: [number, number, number], heightM: number, worldPerMetre: number): InstanceXform {
    const s = Math.max(0.4, heightM) / BIN_CANON_M;
    return { x: base[0], y: base[1] + BIN_CANON_M * worldPerMetre * s * 0.5, z: base[2], ry: 0, s };
}
