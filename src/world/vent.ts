// ── World generation — GROUND VENT / GRATE generator ────────────────────────────────────────────────
// A pavement grate (subway breath) or a low utility vent box. Creator template (metres). Small, cheap street
// clutter that breaks up bare sidewalks. GARP-ready (the box face is one clean quad for a skin).

import type { LayoutPreviewLayer, InstanceXform, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';
import { METAL_PAINTED } from './palette';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type VentStyle = 'grate' | 'box';

export const VENT_STYLES: VentStyle[] = ['grate', 'box'];
const VENT_METAL: RGB = [0.34, 0.35, 0.37];

export interface VentParams {
    style: VentStyle;
    widthM: number;    // grate / box footprint width (m)
    bars: number;      // number of grate bars (grate) or louvers (box)
    seed: number;
}

export const DEFAULT_VENT_PARAMS: VentParams = {
    style: 'grate', widthM: 0.8, bars: 7, seed: 1,
};

export function resolveVentParams(p: Partial<VentParams> = {}): VentParams {
    return {
        ...DEFAULT_VENT_PARAMS, ...p,
        style: VENT_STYLES.includes(p.style as VentStyle) ? (p.style as VentStyle) : DEFAULT_VENT_PARAMS.style,
        widthM: Math.max(0.3, p.widthM ?? DEFAULT_VENT_PARAMS.widthM),
        bars: Math.max(3, Math.min(16, Math.round(p.bars ?? DEFAULT_VENT_PARAMS.bars))),
    };
}

export interface VentMeta { height: number; footprint: [number, number][]; }

/** Emit ONE vent into `acc` (metal) + `dark` (recessed well / shadow). @param worldPerMetre scale bridge. */
export function emitVent(acc: Accum3D, dark: Accum3D, base: V3, params: VentParams, worldPerMetre: number): void {
    const s = worldPerMetre;
    const w = params.widthM * s, hw = w / 2, hd = w * 0.35;   // rectangular footprint
    const cx = base[0], cy = base[1], cz = base[2];
    const up: V3 = [0, 1, 0], ax: V3 = [1, 0, 0], az: V3 = [0, 0, 1];

    if (params.style === 'grate') {
        dark.obox([cx, cy - w * 0.03, cz], ax, up, az, hw * 0.96, w * 0.03, hd * 0.96);   // recessed dark well
        acc.obox([cx, cy + w * 0.006, cz], ax, up, az, hw, w * 0.012, hd);                                 // frame lip (thin plate)
        const n = params.bars, span = hw * 1.86;
        for (let i = 0; i < n; i++) {
            const a = -span / 2 + (i + 0.5) * (span / n);
            acc.obox([cx + a, cy + w * 0.01, cz], ax, up, az, span / n * 0.32, w * 0.012, hd * 0.94);       // bars
        }
    } else {
        const h = w * 0.5;
        acc.obox([cx, cy + h / 2, cz], ax, up, az, hw, h / 2, hd);            // box
        acc.obox([cx, cy + h + w * 0.01, cz], ax, up, az, hw * 0.98, w * 0.02, hd * 0.98);   // top grille plate
        const n = params.bars;
        for (let i = 0; i < n; i++) {                                          // louver slats on the +Z face
            const ly = cy + h * (0.2 + 0.6 * (i / n));
            dark.obox([cx, ly, cz + hd + w * 0.004], ax, up, az, hw * 0.86, h * 0.02, w * 0.004);
        }
    }
}

/** The vent as a painted-metal body + a dark well/louver layer. */
export function ventLayers(acc: Accum3D, dark: Accum3D, metalScale: number): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    if (!acc.empty)  out.push({ name: 'world:vent', color: VENT_METAL, y: 0, geometry: acc.geometry(), metal: { ...METAL_PAINTED, tint: VENT_METAL, scale: metalScale } });
    if (!dark.empty) out.push({ name: 'world:vent-dark', color: [0.05, 0.05, 0.06], y: 0, geometry: dark.geometry() });
    return out;
}

/** Standalone: build ONE vent at the origin, authored 1:1 in METRES (the Creator entry). */
export function buildVent(params: Partial<VentParams> = {}): { layers: LayoutPreviewLayer[]; meta: VentMeta } {
    const p = resolveVentParams(params);
    const acc = new Accum3D(), dark = new Accum3D();
    emitVent(acc, dark, [0, 0, 0], p, 1);
    const rr = p.widthM * 0.55;
    return { layers: ventLayers(acc, dark, 3), meta: { height: p.style === 'box' ? p.widthM * 0.5 : 0.05, footprint: [[-rr, -rr], [rr, -rr], [rr, rr], [-rr, rr]] } };
}

// ── GARP: skinnable pavement grate — a flat instanced quad the skin (a drawn grate) maps onto ───────────
export const VENT_CANON_M = 1.0;                       // canonical grate width (m)
export const VENT_SKIN_NAMES = ['grate', 'drain', 'utility'];
export function ventSkinKey(name: string): string { return `vent/${name}/face`; }
export function ventGarpPool(): GarpPool {
    return {
        id: 'salsa/vent', name: 'Ground vents', version: 1, size: [512, 512], slots: ['face'],
        defaults: { face: ventSkinKey('grate') },
        skins: VENT_SKIN_NAMES.map((n) => ({ name: n, slots: { face: ventSkinKey(n) } })),
    };
}
/** ONE canonical flat grate quad on the ground (UV 0..1) — a skin (a drawn grate) reads on it. Lifted ~3 cm so
 *  the rigid flat quad clears the per-vertex-draped road on slopes instead of z-fighting it. */
export function ventCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const hw = VENT_CANON_M * 0.5 * worldPerMetre, hd = hw * 0.7, y = 0.03 * worldPerMetre;
    const c00: V2 = [0, 0], c10: V2 = [1, 0], c11: V2 = [1, 1], c01: V2 = [0, 1];
    a.quadUV4([-hw, y, -hd], [hw, y, -hd], [hw, y, hd], [-hw, y, hd], c00, c10, c11, c01);   // faces up
    return a.geometry();
}
/** One instance transform for a grate at `base` (flat on the ground), aligned to `dir` (the road, V2). */
export function ventInstanceTransform(base: [number, number, number], widthM: number, dir: V2 = [1, 0]): InstanceXform {
    return { x: base[0], y: base[1], z: base[2], ry: Math.atan2(dir[0], dir[1]), s: Math.max(0.3, widthM) / VENT_CANON_M };
}
