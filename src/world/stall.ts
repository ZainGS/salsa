// ── World generation — PRODUCE / MARKET STALL generator ──────────────────────────────────────────────
// A street fruit/grocery stall: a table on legs, a slanted produce display of colourful mounds, and an optional
// striped awning overhead. Extends the shotengai market vibe to any street. Creator template (metres). GARP-ready:
// the awning is one clean sloped quad-set for a printed skin.

import type { LayoutPreviewLayer, InstanceXform, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type AwningColor = 'red' | 'green' | 'blue' | 'yellow' | 'orange';

export const AWNING_COLORS: Record<AwningColor, RGB> = {
    red: [0.62, 0.16, 0.16], green: [0.16, 0.42, 0.26], blue: [0.16, 0.30, 0.52], yellow: [0.80, 0.66, 0.20], orange: [0.78, 0.42, 0.16],
};
export const AWNING_COLOR_NAMES: AwningColor[] = ['red', 'green', 'blue', 'yellow', 'orange'];
const STALL_WOOD: RGB = [0.46, 0.32, 0.20];
const PRODUCE: RGB = [0.82, 0.52, 0.20];   // warm produce base; a dots pattern mixes a second fruit colour in

export interface StallParams {
    widthM: number;       // stall width (m)
    awning: boolean;      // striped awning overhead
    awningColor: AwningColor;
    produce: boolean;     // the sloped display of produce mounds
    seed: number;
}

export const DEFAULT_STALL_PARAMS: StallParams = {
    widthM: 1.8, awning: true, awningColor: 'red', produce: true, seed: 1,
};

export function resolveStallParams(p: Partial<StallParams> = {}): StallParams {
    return {
        ...DEFAULT_STALL_PARAMS, ...p,
        widthM: Math.max(0.8, p.widthM ?? DEFAULT_STALL_PARAMS.widthM),
        awning: p.awning ?? DEFAULT_STALL_PARAMS.awning,
        awningColor: AWNING_COLOR_NAMES.includes(p.awningColor as AwningColor) ? (p.awningColor as AwningColor) : DEFAULT_STALL_PARAMS.awningColor,
        produce: p.produce ?? DEFAULT_STALL_PARAMS.produce,
    };
}

export interface StallMeta { height: number; footprint: [number, number][]; }

function h(seed: number, i: number): number { const x = Math.sin((seed * 91.7 + i * 47.3) * 0.031) * 43758.5453; return x - Math.floor(x); }

/** Emit a stall. Width runs ALONG `aW` (parallel to the shopfront/road); the customer side + awning face +`cW`
 *  (point cW toward the road). For a standalone build pass aW=[1,0,0], cW=[0,0,1]. @param worldPerMetre scale. */
export function emitStall(wood: Accum3D, awn: Accum3D, prod: Accum3D, base: V3, aW: V3, cW: V3, params: StallParams, worldPerMetre: number, opts: { posts?: boolean } = {}): void {
    const s = worldPerMetre;
    const hw = params.widthM * s * 0.5, hd = 0.32 * s, tableY = 0.8 * s;
    const up: V3 = [0, 1, 0], legR = 0.03 * s;
    // Local (along, up, depth) → world. depth = toward the customer/road (+cW); the stall body sits BEHIND base.
    const at = (al: number, y: number, dp: number): V3 =>
        [base[0] + aW[0] * al + cW[0] * dp, base[1] + y, base[2] + aW[2] * al + cW[2] * dp];

    // Four legs + a table top. `base` is the customer-facing FRONT edge; the table spans depth [0, -2hd] behind it.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) wood.obox(at(sx * (hw - legR), tableY / 2, -hd + sz * (hd - legR)), aW, up, cW, legR, tableY / 2, legR);
    wood.obox(at(0, tableY, -hd), aW, up, cW, hw, 0.02 * s, hd);

    // Sloped produce display board — high at the BACK (−cW), tilting DOWN toward the customer (+cW).
    if (params.produce) {
        const backY = tableY + 0.16 * s;
        wood.quad4(at(-hw, backY, -hd * 2), at(hw, backY, -hd * 2), at(hw, tableY, -hd * 0.4), at(-hw, tableY, -hd * 0.4));
        const cols = Math.max(3, Math.round(params.widthM * 3));
        for (let i = 0; i < cols; i++) {
            const fx = -hw + (i + 0.5) * (2 * hw / cols);
            for (let r = 0; r < 2; r++) {
                const t = r / 1.4;
                const py = tableY + 0.04 * s + t * 0.12 * s, dp = -hd * 0.6 - t * hd * 0.8;
                const rad = (0.05 + 0.02 * h(params.seed, i * 3 + r)) * s;
                prod.blob(at(fx, py + rad, dp), rad, rad * 0.8, rad, 0.2, params.seed + i + r);
            }
        }
    }

    // Two back POSTS (wood) that hold the awning. Baked even when the CANOPY is instanced (opts.posts) so the
    // GARP-skinned instanced canopy has visible supports instead of floating.
    const postTop = 1.9 * s;
    if (params.awning || opts.posts) {
        for (const sx of [-1, 1]) wood.obox(at(sx * (hw - legR), postTop / 2, -hd * 1.6), aW, up, cW, legR * 0.8, postTop / 2, legR * 0.8);
    }
    // The striped canopy itself (baked path only — the city instances it via stallAwningCanonicalGeometry).
    if (params.awning) {
        const back = postTop + 0.05 * s, front = postTop - 0.12 * s;
        awn.quad4(at(-hw * 1.08, back, -hd * 1.6), at(hw * 1.08, back, -hd * 1.6), at(hw * 1.08, front, hd * 0.9), at(-hw * 1.08, front, hd * 0.9));
        awn.obox(at(0, front - 0.06 * s, hd * 0.9), aW, up, cW, hw * 1.08, 0.06 * s, 0.004 * s);   // valance
    }
}

/** Stall layers: wood frame + a striped awning + a dotted-produce mound layer. */
export function stallLayers(wood: Accum3D, awn: Accum3D, prod: Accum3D, awningColor: AwningColor): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    if (!wood.empty) out.push({ name: 'world:stall', color: STALL_WOOD, y: 0, geometry: wood.geometry() });
    if (!awn.empty)  out.push({ name: 'world:stall-awning', color: AWNING_COLORS[awningColor], y: 0, geometry: awn.geometry(),
        pattern: { color: [0.96, 0.94, 0.90], mode: 'stripes', freq: 10, scale: 1 } });
    if (!prod.empty) out.push({ name: 'world:stall-produce', color: PRODUCE, y: 0, geometry: prod.geometry(),
        pattern: { color: [0.72, 0.22, 0.18], mode: 'dots', freq: 5, scale: 1 } });
    return out;
}

/** Standalone: build ONE stall at the origin, authored 1:1 in METRES (the Creator entry). */
export function buildStall(params: Partial<StallParams> = {}): { layers: LayoutPreviewLayer[]; meta: StallMeta } {
    const p = resolveStallParams(params);
    const wood = new Accum3D(), awn = new Accum3D(), prod = new Accum3D();
    emitStall(wood, awn, prod, [0, 0, 0], [1, 0, 0], [0, 0, 1], p, 1);   // faces +Z
    const rw = p.widthM * 0.6, rd = 0.5;
    return { layers: stallLayers(wood, awn, prod, p.awningColor), meta: { height: p.awning ? 2.1 : 1.0, footprint: [[-rw, -rd], [rw, -rd], [rw, rd], [-rw, rd]] } };
}

// ── GARP: skinnable stall AWNING (a printed canopy). The stall's wood + produce stay baked; only the awning is
// instanced + skinned. Build the city stall with `awning:false` and add one awning instance per stall. ─────────
export const STALL_CANON_W = 1.8;                      // canonical stall width (m)
export const STALL_SKIN_NAMES = ['stripe-red', 'stripe-green', 'gingham'];
export function stallSkinKey(name: string): string { return `stall/${name}/awning`; }
export function stallGarpPool(): GarpPool {
    return {
        id: 'salsa/stall', name: 'Stall awnings', version: 1, size: [512, 512], slots: ['awning'],
        defaults: { awning: stallSkinKey('stripe-red') },
        skins: STALL_SKIN_NAMES.map((n) => ({ name: n, slots: { awning: stallSkinKey(n) } })),
    };
}
/** ONE canonical awning canopy (facing +Z, foot-relative, UV 0..1) — matches emitStall's awning, minus stripes. */
export function stallAwningCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const hw = STALL_CANON_W * 0.5 * worldPerMetre, hd = 0.32 * worldPerMetre, postTop = 1.9 * worldPerMetre;
    const back = postTop + 0.05 * worldPerMetre, front = postTop - 0.12 * worldPerMetre;
    a.quadUV4([-hw * 1.08, back, -hd * 1.6], [hw * 1.08, back, -hd * 1.6], [hw * 1.08, front, hd * 0.9], [-hw * 1.08, front, hd * 0.9], [0, 0], [1, 0], [1, 1], [0, 1]);
    return a.geometry();
}
/** One awning instance transform for a stall at `base` (foot), customer side facing `cW` (V2). */
export function stallAwningInstanceTransform(base: [number, number, number], cW: V2, widthM: number): InstanceXform {
    return { x: base[0], y: base[1], z: base[2], ry: Math.atan2(cW[0], cW[1]), s: Math.max(0.8, widthM) / STALL_CANON_W };
}
