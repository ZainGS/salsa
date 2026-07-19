// ─────────────────────────────────────────────────────────────────────────────
// Procedural Foliage Generator (spec: docs/specs/foliage-generator.md) — item 1.
//
// Pure: FoliageParams in → { layers, meta } out. A sibling sub-object generator to the
// building/character/hair systems, reused in TWO contexts (building-attached greenery +
// freestanding landscaping — see the spec's "two kinds" model). Authored in real metres
// like the building generator (same metres→units display scale applies).
//
// v1 = CHUNKY low-poly foliage (Accum3D.blob clusters — matches the building/hair chunky
// lean, cheap, no textures). `render:'card'` (alpha-card leaves, the ER/anime lean) needs
// the alpha-cutout leaf material wired for foliage → a follow-up; it falls back to chunky.
// Reuses building-geom (mulberry rng) + Accum3D. Type library covers ground/wall/window
// foliage; the footprint in `meta` drives the placement-overlap test (item 4 grid tool).
// ─────────────────────────────────────────────────────────────────────────────

import { Accum3D } from './meshbuild';
import { mulberry } from './building-geom';
import type { V2, LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

export type FoliageType =
    | 'bush' | 'shrub' | 'hedge' | 'grass-tuft' | 'flower-bed'      // ground
    | 'planter' | 'potted' | 'small-tree'                          // vessel / tree
    | 'vine' | 'ivy' | 'window-box';                               // wall / window
export type FoliageRender = 'chunky' | 'card';
export type VesselMaterial = 'terracotta' | 'ceramic' | 'metal' | 'wood' | 'stone';

export interface FoliageParams {
    type: FoliageType;
    seed: number;
    size: number;        // overall scale (m): height for bush/shrub/tree/grass/vine · box height for planter
    width: number;       // run length (hedge/window-box/vine) or spread (flower-bed)
    density: number;     // leaf/branch fullness (0..1)
    render: FoliageRender;
    celShade: boolean;   // toon/Ghibli look — cel-banded lighting + rim back-light on the leaves
    bloom: boolean;      // flowers/berries speck
    potMaterial: VesselMaterial;
    foliageColor: [number, number, number];
    tipColor: [number, number, number];      // lighter new-growth tips (a hint of gradient)
    bloomColor: [number, number, number];
    potColor: [number, number, number];
    trunkColor: [number, number, number];
}

export interface FoliageMeta { footprint: V2[]; height: number; type: FoliageType; }

export const DEFAULT_FOLIAGE_PARAMS: FoliageParams = {
    type: 'bush', seed: 1, size: 1.2, width: 1.0, density: 0.6, render: 'chunky', celShade: false, bloom: false, potMaterial: 'terracotta',
    foliageColor: [0.28, 0.46, 0.2], tipColor: [0.44, 0.62, 0.3], bloomColor: [0.92, 0.42, 0.5],
    potColor: [0.55, 0.32, 0.22], trunkColor: [0.34, 0.24, 0.16],
};

export function resolveFoliageParams(partial: Partial<FoliageParams> = {}): FoliageParams {
    return { ...DEFAULT_FOLIAGE_PARAMS, ...partial };
}

interface FA { leaf: Accum3D; tip: Accum3D; bloom: Accum3D; vessel: Accum3D; trunk: Accum3D; }

const box = (hx: number, hz: number): V2[] => [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
const TAU = Math.PI * 2;

/** Emit a randomly-oriented LEAF-CARD quad (unit UVs) centred at (cx,cy,cz), ~hw×hh — the shader cuts it to a leaf
 *  silhouette (alpha-test) so `card` mode reads as real leaves, not solid discs/quads. */
function leafCardQuad(acc: Accum3D, cx: number, cy: number, cz: number, hw: number, hh: number, rnd: () => number): void {
    const nt = rnd() * TAU, nc = 2 * rnd() - 1, ns = Math.sqrt(Math.max(0, 1 - nc * nc));
    const nx = ns * Math.cos(nt), ny = nc, nz = ns * Math.sin(nt);                    // random normal
    const ay = Math.abs(ny) < 0.9 ? 1 : 0, ax = ay === 1 ? 0 : 1;                     // a reference up axis
    let rx = -nz * ay, ry = nz * ax, rz = nx * ay - ny * ax;                          // right = normal × ref
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * nz - rz * ny, uy = rz * nx - rx * nz, uz = rx * ny - ry * nx;     // up = right × normal
    const P = (sr: number, su: number): V3 => [cx + rx * hw * sr + ux * hh * su, cy + ry * hw * sr + uy * hh * su, cz + rz * hw * sr + uz * hh * su];
    acc.quadUV(P(-1, -1), P(1, -1), P(1, 1), P(-1, 1));
}

/** Fill a (flattened) sphere of `radius` at (cx,cy,cz) with MANY small overlapping leaf pieces → a dense organic
 *  mound (not a few big diamonds). `density` 0..1 scales the count. `card` uses flat leaf DISCS (random orientation)
 *  instead of chunky octahedron blobs. `tipFrac` go to the lighter `tip` accumulator. Exported so the building
 *  generator's greenery pass ([[building-generator]] foliage item 2) reuses the exact leaf look. */
export function foliageClump(leaf: Accum3D, tip: Accum3D, cx: number, cy: number, cz: number, radius: number, density: number, rnd: () => number, opts: { flatten?: number; tipFrac?: number; card?: boolean } = {}): void {
    const flatten = opts.flatten ?? 0.82, tipFrac = opts.tipFrac ?? 0.3, card = opts.card ?? false;
    if (card) {
        // LAYERED leaf-CLUSTER cards packed through the (flattened) volume — few, big, overlapping. Each card is a
        // sprig of leaves (the shader cuts it), so a handful of layered cards reads as a full leafy mass. Cheap (2 tris/card).
        const n = Math.max(4, Math.round(6 + density * 13 + radius * 2));
        for (let i = 0; i < n; i++) {
            const rr = radius * Math.cbrt(rnd());
            const th = rnd() * TAU, cph = 2 * rnd() - 1, sph = Math.sqrt(Math.max(0, 1 - cph * cph));
            const bx = cx + rr * sph * Math.cos(th), by = cy + rr * cph * flatten, bz = cz + rr * sph * Math.sin(th);
            const cs = radius * (0.5 + rnd() * 0.28);                          // BIG cluster card (~half the mound)
            leafCardQuad(rnd() < tipFrac ? tip : leaf, bx, by, bz, cs, cs * 1.15, rnd);
        }
        return;
    }
    const n = Math.max(6, Math.round(14 + density * 40 + radius * 3));
    for (let i = 0; i < n; i++) {                                             // chunky: many small blobs (low-poly)
        const rr = radius * Math.cbrt(rnd());
        const th = rnd() * TAU, cph = 2 * rnd() - 1, sph = Math.sqrt(Math.max(0, 1 - cph * cph));
        const bx = cx + rr * sph * Math.cos(th), by = cy + rr * cph * flatten, bz = cz + rr * sph * Math.sin(th);
        const br = radius * (0.16 + rnd() * 0.15);
        (rnd() < tipFrac ? tip : leaf).blob([bx, by, bz], br, br * 0.95, br, 0.55, (rnd() * 1e4) | 0);
    }
}

/** Scatter `n` small bloom (flower/berry) blobs around (cx,cy,cz). */
export function foliageBloom(bloom: Accum3D, rnd: () => number, cx: number, cy: number, cz: number, spread: number, n = 8): void {
    for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, rad = Math.sqrt(rnd()) * spread, r = 0.05 + rnd() * 0.04;
        bloom.blob([cx + Math.cos(a) * rad, cy + (rnd() - 0.5) * spread * 0.5, cz + Math.sin(a) * rad], r, r, r, 0.2, (rnd() * 1e4) | 0);
    }
}

/** A tapered pot (octagonal frustum, wider at the top) + bottom + rim. */
function potShape(vessel: Accum3D, rTop: number, rBot: number, h: number): void {
    const ring = (r: number): V2[] => { const o: V2[] = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + Math.PI / 8; o.push([Math.cos(a) * r, Math.sin(a) * r]); } return o; };
    const b = ring(rBot), t = ring(rTop);
    vessel.frustum(b, t, 0, h); vessel.cap(b, 0.01, -1);
    const rim = Math.min(0.08, h * 0.18); vessel.walls(t, h - rim, rim);
}

/**
 * Generate a foliage instance (local space: base at y=0, centred at origin; the manager positions/orients it).
 * Chunky = overlapping blobs; card = leaf discs. Vine/ivy build on the +Z face (the manager orients to a wall).
 */
export function buildFoliage(partial: Partial<FoliageParams> = {}): { layers: LayoutPreviewLayer[]; meta: FoliageMeta } {
    const p = resolveFoliageParams(partial);
    const rnd = mulberry((p.seed | 0) * 0x9e3779b1);
    const A: FA = { leaf: new Accum3D(), tip: new Accum3D(), bloom: new Accum3D(), vessel: new Accum3D(), trunk: new Accum3D() };
    const meta: FoliageMeta = { footprint: box(0.5, 0.5), height: p.size, type: p.type };
    const dens = Math.max(0, Math.min(1, p.density));
    const s = Math.max(0.2, p.size), w = Math.max(0.3, p.width);
    const card = p.render === 'card';
    const mound = (cx: number, cy: number, cz: number, radius: number, flatten = 0.82, tipFrac = 0.3): void =>
        foliageClump(A.leaf, A.tip, cx, cy, cz, radius, dens, rnd, { flatten, tipFrac, card });
    const blooms = (cx: number, cy: number, cz: number, spread: number, n = 8): void => { if (p.bloom) foliageBloom(A.bloom, rnd, cx, cy, cz, spread, n); };

    switch (p.type) {
        case 'bush': {
            const R = s * 0.5, cy = R * 0.66;
            mound(0, cy, 0, R, 0.8); blooms(0, cy + R * 0.4, 0, R * 0.7, 10);
            meta.height = cy + R * 0.8; meta.footprint = box(R * 0.95, R * 0.95); break;
        }
        case 'shrub': {
            A.trunk.beam([0, 0, 0], [0, s * 0.24, 0], s * 0.03, 4);
            const R = s * 0.4, cy = s * 0.24 + R * 0.45;
            mound(0, cy, 0, R, 0.85); blooms(0, cy + R * 0.4, 0, R * 0.7, 8);
            meta.height = cy + R * 0.85; meta.footprint = box(R, R); break;
        }
        case 'hedge': {
            const R = Math.min(0.6, s * 0.5);
            if (card) {   // fill a rectangular PRISM with layered leaf-cluster cards (the classic hedge technique)
                const hy = R, hz = R * 0.85, n = Math.max(12, Math.round(w * 8 + dens * w * 7));
                for (let i = 0; i < n; i++) {
                    const bx = (rnd() - 0.5) * w, by = R * 0.85 + (rnd() - 0.5) * hy * 1.3, bz = (rnd() - 0.5) * hz * 2;
                    const cs = R * (0.55 + rnd() * 0.3);
                    leafCardQuad(rnd() < 0.28 ? A.tip : A.leaf, bx, by, bz, cs, cs * 1.1, rnd);
                }
            } else {
                const nC = Math.max(2, Math.ceil(w / (R * 0.95)));
                for (let k = 0; k <= nC; k++) mound(-w / 2 + w * (k / nC), R * 0.7, 0, R, 0.95, 0.2);
            }
            meta.height = R * 1.7; meta.footprint = box(w / 2, R); break;
        }
        case 'grass-tuft': {
            const n = Math.round(8 + dens * 16);
            for (let i = 0; i < n; i++) { const a = rnd() * TAU, rad = rnd() * s * 0.3; (rnd() < 0.3 ? A.tip : A.leaf).cone([Math.cos(a) * rad, 0, Math.sin(a) * rad], s * 0.045, s * (0.5 + rnd() * 0.6), 3, rnd() * TAU); }
            meta.height = s; meta.footprint = box(s * 0.4, s * 0.4); break;
        }
        case 'flower-bed': {
            const R = Math.max(w, s) * 0.42;
            mound(0, R * 0.32, 0, R, 0.42, 0.15); blooms(0, R * 0.5, 0, R * 0.9, Math.round(10 + w * 4));
            meta.height = R * 0.6; meta.footprint = box(w / 2, s / 2); break;
        }
        case 'planter': {
            const pw = Math.max(0.28, s * 0.3), ph = s * 0.2;
            A.vessel.obox([0, ph * 0.5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], pw, ph * 0.5, pw * 0.72);   // rectangular planter box
            const R = pw * 1.05, cy = ph + R * 0.4;
            mound(0, cy, 0, R, 0.8); blooms(0, cy + R * 0.4, 0, R * 0.8, 8);
            meta.height = cy + R * 0.85; meta.footprint = box(pw * 1.05, pw * 0.8); break;
        }
        case 'potted': {
            const rTop = s * 0.24, rBot = s * 0.16, ph = s * 0.32;
            potShape(A.vessel, rTop, rBot, ph);
            const R = rTop * 1.35, cy = ph + R * 0.3;
            mound(0, cy, 0, R, 0.85); blooms(0, cy + R * 0.4, 0, R * 0.8, 8);
            meta.height = cy + R * 0.85; meta.footprint = box(rTop * 1.35, rTop * 1.35); break;
        }
        case 'small-tree': {
            A.trunk.beam([0, 0, 0], [0, s * 0.5, 0], s * 0.035, 5);
            const R = s * 0.34, cy = s * 0.5 + R * 0.5;
            mound(0, cy, 0, R, 0.9); blooms(0, cy + R * 0.4, 0, R * 0.8, 6);
            meta.height = cy + R * 0.9; meta.footprint = box(R, R); break;
        }
        case 'vine': case 'ivy': {   // leaves climbing a +Z wall face (z≈0 plane)
            const n = Math.round(18 + dens * 44 + w * s * 3);
            for (let i = 0; i < n; i++) {
                const y = rnd() * s, x = (rnd() - 0.5) * w, r = 0.08 + rnd() * 0.08;
                const acc = rnd() < 0.3 ? A.tip : A.leaf;
                if (card) leafCardQuad(acc, x, y, 0.06 + rnd() * 0.05, r * 1.2, r * 1.7, rnd);
                else acc.blob([x, y, 0.05], r, r * 0.9, r * 0.55, 0.4, (rnd() * 1e4) | 0);
            }
            blooms(0, s * 0.6, 0.07, w * 0.4, Math.round(w * 2));
            meta.height = s; meta.footprint = box(w / 2, 0.15); break;
        }
        case 'window-box': {
            const bh = 0.22, bd = 0.28;
            A.vessel.obox([0, bh * 0.5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], w / 2, bh * 0.5, bd * 0.5);
            const n = Math.round(w * 12 + dens * 14);
            for (let i = 0; i < n; i++) {
                const x = (rnd() - 0.5) * w, y = bh + 0.06 - rnd() * 0.3, z = bd * (0.2 + rnd() * 0.3), r = 0.07 + rnd() * 0.05;
                const acc = rnd() < 0.3 ? A.tip : A.leaf;
                if (card) leafCardQuad(acc, x, y, z, r * 1.2, r * 1.7, rnd);
                else acc.blob([x, y, z], r, r, r * 0.85, 0.4, (rnd() * 1e4) | 0);
            }
            blooms(0, bh + 0.08, bd * 0.35, w * 0.45, Math.round(6 + w * 4));
            meta.height = bh + 0.35; meta.footprint = box(w / 2, bd * 0.5); break;
        }
    }

    const E = 0.14;   // low unlit lift, matching buildings (true colours, not glow)
    const leafFlag = card && p.type !== 'grass-tuft';   // grass uses cones, not leaf cards
    const cel: LayoutPreviewLayer['renderStyle'] = p.celShade ? 'cel' : undefined;   // toon/Ghibli foliage
    const out: LayoutPreviewLayer[] = [];
    if (!A.trunk.empty) out.push({ name: 'foliage:trunk', color: p.trunkColor, y: 0, geometry: A.trunk.geometry(), emissive: E * 0.7, renderStyle: cel });
    if (!A.vessel.empty) out.push({ name: 'foliage:vessel', color: p.potColor, y: 0, geometry: A.vessel.geometry(), emissive: E * 0.8 });
    if (!A.leaf.empty) out.push({ name: 'foliage:leaf', color: p.foliageColor, y: 0, geometry: A.leaf.geometry(), emissive: E, leafCard: leafFlag, renderStyle: cel, rim: p.celShade });
    if (!A.tip.empty) out.push({ name: 'foliage:tip', color: p.tipColor, y: 0, geometry: A.tip.geometry(), emissive: E * 1.1, leafCard: leafFlag, renderStyle: cel, rim: p.celShade });
    if (!A.bloom.empty) out.push({ name: 'foliage:bloom', color: p.bloomColor, y: 0, geometry: A.bloom.geometry(), emissive: 0.3 });
    return { layers: out, meta };
}

export const FOLIAGE_TYPES: FoliageType[] = ['bush', 'shrub', 'hedge', 'grass-tuft', 'flower-bed', 'planter', 'potted', 'small-tree', 'vine', 'ivy', 'window-box'];
export function foliageTypeNames(): FoliageType[] { return FOLIAGE_TYPES; }
