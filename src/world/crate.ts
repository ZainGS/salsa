// ── World generation — CRATE STACK generator ────────────────────────────────────────────────────────
// A stack of shipping/produce crates for street + shopfront clutter. Creator template (metres). Crates already
// existed baked into rear alley clutter (streets.ts); this promotes them to a reusable, tunable, GARP-ready
// asset — a pool can wrap printed crate labels/skins over the box faces.

import type { LayoutPreviewLayer, InstanceXform, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];
type RGB = [number, number, number];

export type CrateFinish = 'wood' | 'red' | 'blue' | 'green' | 'grey';

export const CRATE_FINISHES: Record<CrateFinish, RGB> = {
    wood: [0.52, 0.37, 0.22], red: [0.55, 0.20, 0.18], blue: [0.20, 0.32, 0.50], green: [0.22, 0.42, 0.26], grey: [0.44, 0.44, 0.46],
};
export const CRATE_FINISH_NAMES: CrateFinish[] = ['wood', 'red', 'blue', 'green', 'grey'];

export interface CrateParams {
    count: number;      // how many crates in the stack (1–6)
    sizeM: number;      // crate edge length (m)
    finish: CrateFinish;
    slats: boolean;     // slatted-plank look (a checker/grid line pattern) vs plain box
    seed: number;
}

export const DEFAULT_CRATE_PARAMS: CrateParams = {
    count: 3, sizeM: 0.5, finish: 'wood', slats: true, seed: 1,
};

export function resolveCrateParams(p: Partial<CrateParams> = {}): CrateParams {
    return {
        ...DEFAULT_CRATE_PARAMS, ...p,
        count: Math.max(1, Math.min(6, Math.round(p.count ?? DEFAULT_CRATE_PARAMS.count))),
        sizeM: Math.max(0.2, p.sizeM ?? DEFAULT_CRATE_PARAMS.sizeM),   // floor == schema min
        finish: CRATE_FINISH_NAMES.includes(p.finish as CrateFinish) ? (p.finish as CrateFinish) : DEFAULT_CRATE_PARAMS.finish,
        slats: p.slats ?? DEFAULT_CRATE_PARAMS.slats,
    };
}

export interface CrateMeta { height: number; footprint: [number, number][]; }

// Deterministic hash → [0,1) so stacks don't all look identical (jittered offset/yaw per crate).
function h(seed: number, i: number): number { const x = Math.sin((seed * 127.1 + i * 311.7) * 0.017) * 43758.5453; return x - Math.floor(x); }

/** Emit a stack of crates into `acc`. @param base foot centre · @param worldPerMetre scale bridge. */
export function emitCrate(acc: Accum3D, base: V3, params: CrateParams, worldPerMetre: number): void {
    const s = worldPerMetre;
    const e = params.sizeM * s * 0.5;    // crate half-edge
    const up: V3 = [0, 1, 0];
    let y = base[1];
    for (let i = 0; i < params.count; i++) {
        const jx = (h(params.seed, i) - 0.5) * e * 0.5;
        const jz = (h(params.seed, i + 40) - 0.5) * e * 0.5;
        const yaw = (h(params.seed, i + 80) - 0.5) * 0.5;   // slight rotation per crate
        const ca = Math.cos(yaw), sa = Math.sin(yaw);
        const ax: V3 = [ca, 0, sa], az: V3 = [-sa, 0, ca];
        acc.obox([base[0] + jx, y + e, base[2] + jz], ax, up, az, e, e, e);
        y += e * 2 * 0.98;   // next crate rests on this one (tiny overlap so gaps don't show)
    }
}

/** The crate stack as one layer. `slats` adds a grid line pattern (the plank gaps). */
export function crateLayers(acc: Accum3D, tint: RGB, slats: boolean): LayoutPreviewLayer[] {
    if (acc.empty) return [];
    const layer: LayoutPreviewLayer = { name: 'world:crate', color: tint, y: 0, geometry: acc.geometry() };
    if (slats) layer.pattern = { color: [tint[0] * 0.55, tint[1] * 0.55, tint[2] * 0.55], mode: 'grid', freq: 5, scale: 1 };
    return [layer];
}

/** Standalone: build a crate stack at the origin, authored 1:1 in METRES, as layers + meta (the Creator entry). */
export function buildCrate(params: Partial<CrateParams> = {}): { layers: LayoutPreviewLayer[]; meta: CrateMeta } {
    const p = resolveCrateParams(params);
    const acc = new Accum3D();
    emitCrate(acc, [0, 0, 0], p, 1);
    const rr = p.sizeM * 0.75;
    return { layers: crateLayers(acc, CRATE_FINISHES[p.finish], p.slats), meta: { height: p.sizeM * p.count, footprint: [[-rr, -rr], [rr, -rr], [rr, rr], [-rr, rr]] } };
}

// ── GARP: skinnable crate labels (docs/specs/city-props-garp.md) ────────────────────────────────────
// Each crate in a city stack is ONE instance of a canonical box; a pool skin (a printed crate face) wraps every
// face via clean 0..1 UVs. Mirrors the vending pattern (vending.ts).
export const CRATE_CANON_M = 0.5;                       // canonical crate edge (m); instances scale from this
export const CRATE_SKIN_NAMES = ['plain', 'fruit', 'cargo'];
export function crateSkinKey(name: string): string { return `crate/${name}/label`; }

export function crateGarpPool(): GarpPool {
    return {
        id: 'salsa/crate', name: 'Crates', version: 1, size: [512, 512],
        slots: ['label'],
        defaults: { label: crateSkinKey('plain') },
        skins: CRATE_SKIN_NAMES.map((n) => ({ name: n, slots: { label: crateSkinKey(n) } })),
    };
}

/** ONE canonical crate box centred at the origin, every face UV-mapped 0..1 so a GARP skin wraps cleanly. */
export function crateCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const he = CRATE_CANON_M * 0.5 * worldPerMetre;
    const a = new Accum3D();
    const c00: V2 = [0, 0], c10: V2 = [1, 0], c11: V2 = [1, 1], c01: V2 = [0, 1];
    const face = (p0: V3, p1: V3, p2: V3, p3: V3): void => a.quadUV4(p0, p1, p2, p3, c00, c10, c11, c01);
    face([he, he, he], [-he, he, he], [-he, -he, he], [he, -he, he]);        // +Z
    face([-he, he, -he], [he, he, -he], [he, -he, -he], [-he, -he, -he]);    // -Z
    face([-he, he, he], [-he, he, -he], [-he, -he, -he], [-he, -he, he]);    // -X
    face([he, he, -he], [he, he, he], [he, -he, he], [he, -he, -he]);        // +X
    face([he, he, -he], [-he, he, -he], [-he, he, he], [he, he, he]);        // +Y
    face([he, -he, he], [-he, -he, he], [-he, -he, -he], [he, -he, -he]);    // -Y
    return a.geometry();
}

/** Per-crate instance transforms for a stack at `base` (foot centre) — one instance of the canonical box each. */
export function crateInstanceTransforms(base: V3, params: Partial<CrateParams>, worldPerMetre: number): InstanceXform[] {
    const p = resolveCrateParams(params);
    const e = p.sizeM * 0.5 * worldPerMetre;           // placed half-edge (world units)
    const s = p.sizeM / CRATE_CANON_M;                 // uniform scale from the canonical box
    const out: InstanceXform[] = [];
    let y = base[1];
    for (let i = 0; i < p.count; i++) {
        const jx = (h(p.seed, i) - 0.5) * e, jz = (h(p.seed, i + 40) - 0.5) * e, yaw = (h(p.seed, i + 80) - 0.5) * 0.5;
        out.push({ x: base[0] + jx, y: y + e, z: base[2] + jz, ry: yaw, s });
        y += e * 2 * 0.98;
    }
    return out;
}
