// ── World generation — A-BOARD (sandwich board) generator ───────────────────────────────────────────
// The folding sidewalk sign outside shops. Promotes the baked `addSandwichBoard` (awnings.ts) to a reusable,
// tunable Creator asset. Two leaning panels (both faces visible) on a dark frame; the panel carries a stripe/
// grid pattern standing in for chalk/print, GARP-ready for a real printed skin. Creator template (metres).

import type { LayoutPreviewLayer, InstanceXform, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type ABoardFace = 'chalk' | 'menu' | 'blank';

/** Face → panel colour + secondary (line/text) colour for the pattern. */
export const ABOARD_FACES: Record<ABoardFace, { base: RGB; line: RGB; mode: 'grid' | 'stripes' | 'dots' }> = {
    chalk: { base: [0.10, 0.11, 0.12], line: [0.80, 0.82, 0.80], mode: 'grid' },     // blackboard + chalk lines
    menu:  { base: [0.94, 0.90, 0.80], line: [0.30, 0.22, 0.14], mode: 'stripes' },  // cream menu board
    blank: { base: [0.86, 0.86, 0.88], line: [0.86, 0.86, 0.88], mode: 'grid' },
};
export const ABOARD_FACE_NAMES: ABoardFace[] = ['chalk', 'menu', 'blank'];

export interface ABoardParams {
    face: ABoardFace;
    widthM: number;    // panel width (m)
    heightM: number;   // panel height (m)
    seed: number;
}

export const DEFAULT_ABOARD_PARAMS: ABoardParams = {
    face: 'chalk', widthM: 0.6, heightM: 0.9, seed: 1,
};

export function resolveABoardParams(p: Partial<ABoardParams> = {}): ABoardParams {
    return {
        ...DEFAULT_ABOARD_PARAMS, ...p,
        face: ABOARD_FACE_NAMES.includes(p.face as ABoardFace) ? (p.face as ABoardFace) : DEFAULT_ABOARD_PARAMS.face,
        widthM: Math.max(0.3, p.widthM ?? DEFAULT_ABOARD_PARAMS.widthM),
        heightM: Math.max(0.4, p.heightM ?? DEFAULT_ABOARD_PARAMS.heightM),
    };
}

export interface ABoardMeta { height: number; footprint: [number, number][]; }

/** Emit ONE A-board into `panel` (both leaning faces) + `frame` (dark edge posts). Faces span the width along +X,
 *  the A leans front-to-back along ±Z. @param worldPerMetre scale bridge. */
export function emitABoard(panel: Accum3D, frame: Accum3D, base: V3, params: ABoardParams, worldPerMetre: number): void {
    const s = worldPerMetre;
    const hw = params.widthM * s * 0.5, h = params.heightM * s, lean = h * 0.22;
    const cx = base[0], cy = base[1], cz = base[2];
    const top = cy + h;
    for (const side of [-1, 1]) {
        // Leaning panel quad: top edge at the apex, bottom edge splayed out by `lean` on side ±Z.
        panel.quad4(
            [cx - hw, top, cz], [cx + hw, top, cz],
            [cx + hw, cy, cz + lean * side], [cx - hw, cy, cz + lean * side],
        );
    }
    // Dark side frame posts (the A's legs) + an apex bar.
    const up: V3 = [0, 1, 0], ax: V3 = [1, 0, 0], az: V3 = [0, 0, 1];
    for (const sx of [-1, 1]) frame.obox([cx + sx * hw, cy + h / 2, cz], ax, up, az, hw * 0.06, h / 2, lean * 0.6);
    frame.obox([cx, top, cz], ax, up, az, hw, h * 0.03, hw * 0.05);
}

/** The A-board as a patterned panel (chalk/menu look) + a dark frame. */
export function aboardLayers(panel: Accum3D, frame: Accum3D, face: ABoardFace): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const f = ABOARD_FACES[face];
    if (!panel.empty) out.push({ name: 'world:aboard', color: f.base, y: 0, geometry: panel.geometry(), singleSided: false,
        pattern: face === 'blank' ? undefined : { color: f.line, mode: f.mode, freq: 6, scale: 1 } });
    if (!frame.empty) out.push({ name: 'world:aboard-frame', color: [0.16, 0.13, 0.10], y: 0, geometry: frame.geometry() });
    return out;
}

/** Standalone: build ONE A-board at the origin, authored 1:1 in METRES (the Creator entry). */
export function buildABoard(params: Partial<ABoardParams> = {}): { layers: LayoutPreviewLayer[]; meta: ABoardMeta } {
    const p = resolveABoardParams(params);
    const panel = new Accum3D(), frame = new Accum3D();
    emitABoard(panel, frame, [0, 0, 0], p, 1);
    const rw = p.widthM * 0.55, rd = p.heightM * 0.25;
    return { layers: aboardLayers(panel, frame, p.face), meta: { height: p.heightM, footprint: [[-rw, -rd], [rw, -rd], [rw, rd], [-rw, rd]] } };
}

// ── GARP: skinnable A-board face (a printed menu / ad on both leaning panels) ────────────────────────
export const ABOARD_CANON_W = 0.6, ABOARD_CANON_H = 0.9;   // canonical panel size (m)
export const ABOARD_SKIN_NAMES = ['menu', 'sale', 'coffee'];
export function aboardSkinKey(name: string): string { return `aboard/${name}/face`; }
export function aboardGarpPool(): GarpPool {
    return {
        id: 'salsa/aboard', name: 'A-boards', version: 1, size: [512, 512], slots: ['face'],
        defaults: { face: aboardSkinKey('menu') },
        skins: ABOARD_SKIN_NAMES.map((n) => ({ name: n, slots: { face: aboardSkinKey(n) } })),
    };
}
/** ONE canonical A-frame (two leaning panels, each UV 0..1) so a skin reads on both faces. Foot at y=0. */
export function aboardCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const hw = ABOARD_CANON_W * 0.5 * worldPerMetre, h = ABOARD_CANON_H * worldPerMetre, lean = h * 0.22;
    const c00: V2 = [0, 0], c10: V2 = [1, 0], c11: V2 = [1, 1], c01: V2 = [0, 1];
    for (const side of [-1, 1]) {
        a.quadUV4([-hw, h, 0], [hw, h, 0], [hw, 0, lean * side], [-hw, 0, lean * side], c00, c10, c11, c01);
    }
    return a.geometry();
}
/** One instance transform for an A-board at `base` (foot centre), facing `dir` (V2, the sign side). */
export function aboardInstanceTransform(base: [number, number, number], dir: V2, widthM: number): InstanceXform {
    return { x: base[0], y: base[1], z: base[2], ry: Math.atan2(dir[0], dir[1]), s: Math.max(0.3, widthM) / ABOARD_CANON_W };
}
