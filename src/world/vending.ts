// ── World generation — VENDING MACHINE generator ────────────────────────────────────────────────
// A Japanese street jihanki (docs/specs/vending-machine-redesign.md): a painted cabinet, a framed product window of
// SHELVES of 3D cans behind glass (each shelf with a lit price strip + one glowing button per can, a light strip under
// the shelf above), a control strip (coin / bill slots, return lever, LED display), a recessed pickup bay with a
// flap, and a dark plinth. The user reskins it through GARP: the `body` (logos / art, UV-painted on the shell's
// six-face unwrap), the `products` backdrop behind the cans, and the `labels` sheet — their can designs, packed by
// the services layer into one 4×2 grid texture that every can samples one cell of.
//
// ★ ONE MATERIAL FAMILY PER SUB-LAYER. `pattern`, `metal`, `glass`(flag), `neon`, `ground`, `foliageShade`
// share the four pattern instance floats — a mesh is exactly one of them (glass is a plain flag bit and
// composes freely). So the split is not cosmetic: it is what lets metal, glow and glass coexist on one
// object. See src/world/city-materials.test.ts for the invariant this must not break.
//
// ★ MERGE-EMIT for everything that looks the same on every machine (frame, shelves, strips, buttons, glass, bay…),
// INSTANCED for the three skinned parts (body shell, backdrop, cans) — a merged mesh has ONE textureIndex, so a
// per-machine skin needs an instance. ★ Every instanced part's ORIGIN is the machine's FOOT (its offset is baked into
// the geometry): GARP picks a skin by the instance position, so parts placed at different points could wear
// different skins — the old products panel sat ~30 cm in front of the body and could mismatch it.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import type { GarpPool } from './garp';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

type V3 = [number, number, number];

/** A machine brand = a body colour (the metal cabinet tint) + a lit-window tone. */
export interface VendingBrand { name: string; body: [number, number, number]; glow: [number, number, number]; }

export const VENDING_BRANDS: VendingBrand[] = [
    { name: 'red',  body: [0.80, 0.16, 0.16], glow: [1.00, 0.86, 0.72] },
    { name: 'blue', body: [0.14, 0.40, 0.74], glow: [0.80, 0.92, 1.00] },
    { name: 'cyan', body: [0.90, 0.90, 0.86], glow: [0.86, 1.00, 0.98] },
];

/** Untextured can colours for the standalone creator build (the city's cans are GARP-textured from the label sheet). */
const PRODUCT_TONES: [number, number, number][] = [
    [0.86, 0.24, 0.20], [0.20, 0.52, 0.82], [0.94, 0.78, 0.24], [0.32, 0.68, 0.40],
];
const PRODUCT_BUCKETS = 4;

const TRIM: [number, number, number] = [0.14, 0.14, 0.16];     // dark metal: frame, shelves, plinth, panel
const CHROME: [number, number, number] = [0.72, 0.73, 0.76];   // coin / bill slots, lever, bay frame + flap
const HOLE: [number, number, number] = [0.03, 0.03, 0.035];    // the pickup bay's dark opening
const STRIP: [number, number, number] = [0.93, 0.93, 0.90];    // the price strip under each shelf
const BUTTON: [number, number, number] = [0.55, 1.00, 0.62];   // the per-can LED buttons + the display

export type VendingStock = 'cans' | 'image';

/** A vending machine's authored params. Dimensions are REAL METRES; the caller supplies a world-units-per-metre
 *  factor at emit time, so the same params size correctly in the diorama city and 1:1 in a creator mode. */
export interface VendingParams {
    brand: number;        // index into VENDING_BRANDS (the cabinet colour + window tone)
    heightM: number;      // real cabinet height / width / depth, metres
    widthM: number;
    depthM: number;
    /** Shelves of stock behind the glass (1..5). */
    shelves: number;
    /** Cans per shelf (2..12). */
    cansPerShelf: number;
    /** 'cans' = 3D cans (labels sheet) in front of the backdrop · 'image' = the backdrop image alone (flat display). */
    stock: VendingStock;
    glow: number;         // emissive multiplier for the lit window (1 = default)
    seed: number;         // can-arrangement + jitter stream
}

export const DEFAULT_VENDING_PARAMS: VendingParams = {
    brand: 0, heightM: 1.8, widthM: 0.84, depthM: 0.6,
    shelves: 3, cansPerShelf: 8, stock: 'cans', glow: 1, seed: 1,
};

/** Fill defaults + clamp to sane ranges (old saves / sparse host input load safely). Saves from before the
 *  2026-09-29 redesign carry `productCols` / `productRows` (the old box grid) — they're dropped here. */
export function resolveVendingParams(p: Partial<VendingParams> = {}): VendingParams {
    const d = DEFAULT_VENDING_PARAMS;
    const { productCols: _c, productRows: _r, ...rest } = p as Partial<VendingParams> & { productCols?: number; productRows?: number };
    void _c; void _r;
    return {
        ...d, ...rest,
        brand: ((Math.round(p.brand ?? 0) % VENDING_BRANDS.length) + VENDING_BRANDS.length) % VENDING_BRANDS.length,
        heightM: Math.max(0.6, p.heightM ?? d.heightM),
        widthM: Math.max(0.4, p.widthM ?? d.widthM),
        depthM: Math.max(0.3, p.depthM ?? d.depthM),
        shelves: Math.max(1, Math.min(5, Math.round(p.shelves ?? d.shelves))),
        cansPerShelf: Math.max(2, Math.min(12, Math.round(p.cansPerShelf ?? d.cansPerShelf))),
        stock: p.stock === 'image' ? 'image' : 'cans',
        glow: Math.max(0, p.glow ?? d.glow),
    };
}

/** Generator metadata (the shape ProceduralObjectManager wants): real height + ground footprint, metres. */
export interface VendingMeta { height: number; footprint: [number, number][]; }

// ── Front layout (metres, relative to the FOOT; z measured from the cabinet's front plane) ─────────────────────────
// One pure function feeds both the merged emit (world-oriented) and the instanced canonical geometries (local), so
// the cans always land exactly on the shelves the merged furniture draws.

export interface VendingLayout {
    hw: number; hh: number; hd: number;                 // cabinet half-extents
    win: { x: number; y0: number; y1: number };          // product window: half-width, bottom, top
    rowH: number; stripH: number;                        // one shelf row's height; the price strip's height
    can: { r: number; h: number; slotW: number };        // can radius / height, the per-can slot width
    z: { glow: number; backdrop: number; can: number; strip: number; glass: number; frame: number };
}

export function vendingLayout(p: VendingParams): VendingLayout {
    const H = p.heightM, W = p.widthM, hd = p.depthM * 0.5;
    const win = { x: W * 0.44, y0: H * 0.53, y1: H * 0.95 };
    const rowH = (win.y1 - win.y0) / p.shelves;
    const stripH = Math.min(0.03, rowH * 0.14);
    const slotW = (2 * win.x) / p.cansPerShelf;
    const r = Math.min(0.033, slotW * 0.42);
    const h = Math.min(0.123, (rowH - stripH) * 0.72, r * 4.2);
    return {
        hw: W * 0.5, hh: H * 0.5, hd, win, rowH, stripH, can: { r, h, slotW },
        // Front-to-back order: glow backing → backdrop → cans → price strip → glass; the frame protrudes to the glass.
        z: { glow: 0.004, backdrop: 0.008, can: 0.012 + r, strip: 0.014 + 2 * r, glass: 0.02 + 2 * r, frame: 0.024 + 2 * r },
    };
}

// ── The label sheet (GARP `labels` slot) ─────────────────────────────────────────────────────────────────────────
// One 512² texture = a 4×2 grid of can-front cells (128×256 px each, 1:2). Each cell: a silver RIM band at the top
// (the can's neck + top sample it) over the LABEL. Cells are PADDED so bilinear filtering never bleeds a neighbour's
// art in. Pure layout — the services packer draws into exactly these rects.

export const VENDING_LABEL_GRID: [number, number] = [4, 2];   // columns, rows
export const VENDING_LABEL_CELLS = VENDING_LABEL_GRID[0] * VENDING_LABEL_GRID[1];
/** Padding per cell side, as a fraction of the sheet (4 px of 512). */
export const VENDING_LABEL_PAD = 4 / 512;
/** The rim band's share of a cell's (padded) height. */
export const VENDING_LABEL_RIM = 0.07;

/** A cell's rects in sheet UV (0..1, y-down like an image): the whole padded `cell`, its `rim` band, its `label`. */
export function vendingLabelCell(i: number): { cell: [number, number, number, number]; rim: [number, number, number, number]; label: [number, number, number, number] } {
    const [cols, rows] = VENDING_LABEL_GRID;
    const k = ((Math.floor(i) % VENDING_LABEL_CELLS) + VENDING_LABEL_CELLS) % VENDING_LABEL_CELLS;
    const cx = k % cols, cy = Math.floor(k / cols);
    const u0 = cx / cols + VENDING_LABEL_PAD, u1 = (cx + 1) / cols - VENDING_LABEL_PAD;
    const v0 = cy / rows + VENDING_LABEL_PAD, v1 = (cy + 1) / rows - VENDING_LABEL_PAD;
    const vr = v0 + (v1 - v0) * VENDING_LABEL_RIM;
    return { cell: [u0, v0, u1, v1], rim: [u0, v0, u1, vr], label: [u0, vr, u1, v1] };
}

// ── GARP pool (docs/specs/city-props-garp.md §2) ──────────────────────────────────────────────────
// Three coordinated slots per skin: `body` (the cabinet shell, per-face unwrap), `products` (the backdrop behind the
// cans — or the whole display in `stock:'image'`), `labels` (the packed can-label sheet). The unit of choice is the
// whole SKIN, so a machine can never wear one brand's body over another's cans.
export const VENDING_SLOTS = ['body', 'products', 'labels'] as const;

/** The stable texture KEY for a brand's slot — the string a skin references and the GarpManager maps to a layer. */
export function vendingSkinKey(brand: string, slot: string): string { return `vending/${brand}/${slot}`; }

/** The BODY shell's UV UNWRAP — a rectangle per face in 0..1 texture space (a PUBLIC contract; bump
 *  {@link vendingGarpPool}'s `version` if it changes, since user skins are painted against it). Front-DOMINANT:
 *  the FRONT takes the left ~half at full resolution; the other five faces pack into the right half. Regions have
 *  small gaps so bilinear filtering never bleeds one face's paint onto its neighbour. */
export const VENDING_BODY_UV_REGIONS: { label: string; rect: [number, number, number, number] }[] = [
    { label: 'front',  rect: [0.00, 0.00, 0.49, 1.00] },
    { label: 'back',   rect: [0.51, 0.00, 0.74, 0.32] },
    { label: 'top',    rect: [0.76, 0.00, 1.00, 0.32] },
    { label: 'left',   rect: [0.51, 0.34, 0.74, 0.66] },
    { label: 'right',  rect: [0.76, 0.34, 1.00, 0.66] },
    { label: 'bottom', rect: [0.51, 0.68, 0.74, 1.00] },
];

/** The CANONICAL machine-BODY shell geometry — the opaque cabinet box at the LOCAL origin (front = +Z), sized in
 *  WORLD UNITS, centred on the cabinet (its transform puts the centre over the foot — same x,z as the foot, so it
 *  picks the same skin). Its six faces map to {@link VENDING_BODY_UV_REGIONS}. Normals point OUTWARD. */
export function vendingShellGeometry(params: Partial<VendingParams>, worldPerMetre: number): MeshGeometry {
    const p = resolveVendingParams(params);
    const hx = p.widthM * 0.5 * worldPerMetre, hy = p.heightM * 0.5 * worldPerMetre, hz = p.depthM * 0.5 * worldPerMetre;
    const a = new Accum3D();
    const rectOf = (label: string): [number, number, number, number] => VENDING_BODY_UV_REGIONS.find((r) => r.label === label)!.rect;
    // Map a face quad (corners a=TR,b=TL,c=BL,d=BR as seen from OUTSIDE the face) to its UV rect [u0,v0,u1,v1]:
    // u runs viewer-left → right, v top → bottom (image convention, like sprites). ★ Before 2026-09-29 this mapped
    // a(TR)→u0, which MIRRORED every face (an imported logo read backwards); regions are unchanged, only the u sense.
    const face = (p0: V3, p1: V3, p2: V3, p3: V3, label: string): void => {
        const [u0, v0, u1, v1] = rectOf(label);
        a.quadUV4(p0, p1, p2, p3, [u1, v0], [u0, v0], [u0, v1], [u1, v1]);
    };
    face([hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz], [hx, -hy, hz], 'front');       // +Z
    face([-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz], 'back');    // -Z
    face([-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz], 'left');    // -X
    face([hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz], [hx, -hy, -hz], 'right');       // +X
    face([hx, hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], 'top');         // +Y
    face([hx, -hy, hz], [-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], 'bottom');  // -Y
    return a.geometry();
}

/** The per-machine BODY INSTANCE transform: the cabinet centre over the foot, yawed so +Z faces `dir`. */
export function vendingShellTransform(base: V3, dir: V2, params: Partial<VendingParams>, worldPerMetre: number): { x: number; y: number; z: number; ry: number } {
    const p = resolveVendingParams(params);
    const hy = p.heightM * 0.5 * worldPerMetre;
    return { x: base[0], y: base[1] + hy, z: base[2], ry: Math.atan2(dir[0], dir[1]) };
}

/** The FOOT transform shared by every other per-machine instanced part (backdrop, cans): origin = the machine's foot,
 *  yawed so local +Z faces `dir`. Same (x,z) as the body → the same GARP skin. */
export function vendingFootTransform(base: V3, dir: V2): { x: number; y: number; z: number; ry: number } {
    return { x: base[0], y: base[1], z: base[2], ry: Math.atan2(dir[0], dir[1]) };
}

/** The BACKDROP panel (GARP `products`) — a front-facing 0..1-UV quad filling the window's back wall, in the LOCAL
 *  FOOT frame (origin = foot, front = +Z; the window height + front offset are baked in). */
export function vendingProductsGeometry(params: Partial<VendingParams>, worldPerMetre: number): MeshGeometry {
    const p = resolveVendingParams(params), L = vendingLayout(p), s = worldPerMetre;
    const x = L.win.x * s, y0 = L.win.y0 * s, y1 = L.win.y1 * s, z = (L.hd + L.z.backdrop) * s;
    const a = new Accum3D();
    // Local +X is the viewer's RIGHT (seen from the front of a +Z-facing machine) → u 1 there, like a sprite. Normal = +Z.
    a.quadUV4([x, y1, z], [-x, y1, z], [-x, y0, z], [x, y0, z], [1, 0], [0, 0], [0, 1], [1, 1]);
    return a.geometry();
}

/** @deprecated alias of {@link vendingFootTransform} (the backdrop's offset now lives in its geometry). */
export function vendingProductsTransform(base: V3, dir: V2, _params?: Partial<VendingParams>, _worldPerMetre?: number): { x: number; y: number; z: number; ry: number } {
    return vendingFootTransform(base, dir);
}

// ── Cans ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which label-sheet cell the can at (shelf, slot) shows in arrangement `variant`. Pure + deterministic. */
export function vendingCanCell(shelf: number, slot: number, variant: number, seed: number): number {
    return Math.floor(hash2(shelf * 131 + variant * 977, slot * 71 + variant * 353, (seed ^ 0x5eedca) | 0) * VENDING_LABEL_CELLS) % VENDING_LABEL_CELLS;
}

const CAN_SIDES = 8;

/** Emit ONE can standing at `foot` (world units) in the frame (right `r`, `up`, front `f`), radius `rad`, height `h`,
 *  its label from sheet cell `cell`. 8 smooth sides + a tapered neck + a top cap = 40 triangles. The front half of the
 *  side shows the label across the cell (viewer-left → u0); the back half mirrors it. Neck + top sample the rim band. */
function emitCan(a: Accum3D, foot: V3, r: V3, up: V3, f: V3, rad: number, h: number, cell: number): void {
    const { rim, label } = vendingLabelCell(cell);
    const rimU = (rim[0] + rim[2]) * 0.5, rimV = (rim[1] + rim[3]) * 0.5;
    const P = (phi: number, radius: number, y: number): V3 => {
        const c = Math.cos(phi) * radius, s = Math.sin(phi) * radius;
        return [foot[0] + r[0] * c + f[0] * s + up[0] * y, foot[1] + r[1] * c + f[1] * s + up[1] * y, foot[2] + r[2] * c + f[2] * s + up[2] * y];
    };
    const N = (phi: number): V3 => {
        const c = Math.cos(phi), s = Math.sin(phi);
        return [r[0] * c + f[0] * s, r[1] * c + f[1] * s, r[2] * c + f[2] * s];
    };
    // φ = 0 → viewer's right (r), π/2 → the front, π → viewer's left. Label u runs viewer-left (u0) → right (u1).
    const uAt = (phi: number): number => { const t = Math.abs(Math.PI - (((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))) / Math.PI; return label[0] + (label[2] - label[0]) * t; };
    const bodyTop = h * 0.88, neckR = rad * 0.8;
    const ring = (radius: number, y: number, uv: (phi: number) => [number, number], normal: (phi: number) => V3): number[] => {
        const out: number[] = [];
        for (let k = 0; k < CAN_SIDES; k++) { const phi = (k / CAN_SIDES) * Math.PI * 2, [u, v] = uv(phi); out.push(a.vertex(P(phi, radius, y), normal(phi), u, v)); }
        return out;
    };
    const bottom = ring(rad, 0, (phi) => [uAt(phi), label[3]], N);
    const top = ring(rad, bodyTop, (phi) => [uAt(phi), label[1]], N);
    const neckLo = ring(rad, bodyTop, () => [rimU, rimV], (phi) => { const n = N(phi); return [n[0] * 0.8 + up[0] * 0.6, n[1] * 0.8 + up[1] * 0.6, n[2] * 0.8 + up[2] * 0.6]; });
    const neckHi = ring(neckR, h, () => [rimU, rimV], (phi) => { const n = N(phi); return [n[0] * 0.8 + up[0] * 0.6, n[1] * 0.8 + up[1] * 0.6, n[2] * 0.8 + up[2] * 0.6]; });
    // Quads wound so the geometric normal matches the outward normal (checked, so any frame handedness is safe).
    const side = (lo: number[], hi: number[], outAt: (phi: number) => V3, radLo: number, radHi: number, yLo: number, yHi: number): void => {
        for (let k = 0; k < CAN_SIDES; k++) {
            const m = (k + 1) % CAN_SIDES;
            const p0 = P((k / CAN_SIDES) * Math.PI * 2, radLo, yLo), p1 = P((m / CAN_SIDES) * Math.PI * 2, radLo, yLo), p3 = P((k / CAN_SIDES) * Math.PI * 2, radHi, yHi);
            const e1: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2: V3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
            const gn: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const o = outAt(((k + 0.5) / CAN_SIDES) * Math.PI * 2);
            if (gn[0] * o[0] + gn[1] * o[1] + gn[2] * o[2] >= 0) { a.triangle(lo[k], lo[m], hi[m]); a.triangle(lo[k], hi[m], hi[k]); }
            else { a.triangle(lo[k], hi[m], lo[m]); a.triangle(lo[k], hi[k], hi[m]); }
        }
    };
    side(bottom, top, N, rad, rad, 0, bodyTop);
    side(neckLo, neckHi, N, rad, neckR, bodyTop, h);
    // Top cap: a fan over the neck's top ring, facing up.
    const centre = a.vertex(P(0, 0, h), up, rimU, rimV);
    const capRing = ring(neckR, h, () => [rimU, rimV], () => up);
    for (let k = 0; k < CAN_SIDES; k++) {
        const m = (k + 1) % CAN_SIDES, pk = P((k / CAN_SIDES) * Math.PI * 2, neckR, h), pm = P((m / CAN_SIDES) * Math.PI * 2, neckR, h), pc = P(0, 0, h);
        const e1: V3 = [pk[0] - pc[0], pk[1] - pc[1], pk[2] - pc[2]], e2: V3 = [pm[0] - pc[0], pm[1] - pc[1], pm[2] - pc[2]];
        const facing = (e1[1] * e2[2] - e1[2] * e2[1]) * up[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * up[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * up[2];   // (e1 × e2) · up
        if (facing >= 0) a.triangle(centre, capRing[k], capRing[m]); else a.triangle(centre, capRing[m], capRing[k]);
    }
}

/** Emit every can of a machine (shelves × cansPerShelf) into `pick(cell)`'s accumulator. Frame + scale as emitVending. */
function emitCans(pick: (cell: number) => Accum3D, base: V3, r: V3, up: V3, f: V3, p: VendingParams, L: VendingLayout, s: number, variant: number): void {
    for (let sh = 0; sh < p.shelves; sh++) {
        const y = L.win.y0 + sh * L.rowH + L.stripH;                // cans stand on the shelf, above its price strip
        for (let k = 0; k < p.cansPerShelf; k++) {
            const x = -L.win.x + (k + 0.5) * L.can.slotW;           // viewer-left → right along r
            const z = L.hd + L.z.can;
            const foot: V3 = [base[0] + (r[0] * x + up[0] * y + f[0] * z) * s, base[1] + (r[1] * x + up[1] * y + f[1] * z) * s, base[2] + (r[2] * x + up[2] * y + f[2] * z) * s];
            const cell = vendingCanCell(sh, k, variant, p.seed);
            emitCan(pick(cell), foot, r, up, f, L.can.r * s, L.can.h * s, cell);
        }
    }
}

/** How many can-arrangement variants the city builds (each machine instances one, by position hash). */
export const VENDING_STOCK_VARIANTS = 4;

/** The CANONICAL cans of one machine (all shelves), in the LOCAL FOOT frame, textured from the `labels` sheet.
 *  `variant` picks which cell each can shows (0..VENDING_STOCK_VARIANTS-1), so a street isn't one arrangement. */
export function vendingStockGeometry(params: Partial<VendingParams>, worldPerMetre: number, variant: number): MeshGeometry {
    const p = resolveVendingParams(params), L = vendingLayout(p), a = new Accum3D();
    // Local frame for a machine facing +Z: front f = +Z, viewer's right r = +X (emitVending's r for dir [0,1]).
    emitCans(() => a, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], p, L, worldPerMetre, variant);
    return a.geometry();
}

/** Which stock variant the machine at world (x,z) instances — a position hash on a fine integer grid (stable). */
export function vendingStockVariant(x: number, z: number, seed: number): number {
    return Math.floor(hash2(Math.round(x * 64), Math.round(z * 64), (seed ^ 0x57c0c) | 0) * VENDING_STOCK_VARIANTS) % VENDING_STOCK_VARIANTS;
}

// ── GARP pool ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The vending GARP pool: one skin per brand, each supplying `body` + `products` + `labels` keys. Pure structure —
 *  the caller registers the matching {@link vendingSkinKey} textures + builds the atlas.
 *  ★ `version` is a CONTRACT over the body UNWRAP (vendingShellGeometry): bump it if that layout changes. The
 *  `labels` slot was ADDED without a bump (the unwrap didn't change) — services upgrades an older registered pool
 *  by SLOT presence, keeping its skins (addSkin bumps version per skin, so version can't detect it). */
export function vendingGarpPool(): GarpPool {
    return {
        id: 'salsa/vending', name: 'Vending machines', version: 2, size: [512, 512],
        slots: [...VENDING_SLOTS],
        // A user variant that paints only the BODY omits the others — these defaults keep it valid.
        defaults: { products: vendingSkinKey('_default', 'products'), labels: vendingSkinKey('_default', 'labels') },
        skins: VENDING_BRANDS.map((b) => ({
            name: b.name,
            slots: { body: vendingSkinKey(b.name, 'body'), products: vendingSkinKey(b.name, 'products'), labels: vendingSkinKey(b.name, 'labels') },
        })),
    };
}

// ── Merge-emit ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Caller-owned accumulator bundle — one machine emits into it; a city fills it from many placements, then
 *  {@link vendingLayers} turns it into the named, material-tagged layers. */
export interface VendingAccum {
    body: Accum3D[];        // one per brand (metal tint is per-LAYER, so brands can't share a metal layer)
    trim: Accum3D;          // dark metal: window frame, shelves, control panel, plinth
    chrome: Accum3D;        // bright metal: coin / bill slots, return lever, pickup-bay frame + flap
    hole: Accum3D;          // the pickup bay's dark opening
    glass: Accum3D;         // the window pane
    glow: Accum3D;          // emissive: the lit backing + the light strip under each shelf
    strip: Accum3D;         // the price strip along each shelf's front
    buttons: Accum3D;       // emissive LEDs: one per can + the display
    prod: Accum3D[];        // standalone-only untextured cans, a few colour buckets
}

export function newVendingAccum(): VendingAccum {
    return {
        body: VENDING_BRANDS.map(() => new Accum3D()),
        trim: new Accum3D(), chrome: new Accum3D(), hole: new Accum3D(), glass: new Accum3D(), glow: new Accum3D(),
        strip: new Accum3D(), buttons: new Accum3D(),
        prod: Array.from({ length: PRODUCT_BUCKETS }, () => new Accum3D()),
    };
}

/**
 * Emit ONE vending machine into `acc`.
 * @param base   foot centre in WORLD UNITS (ground contact point)
 * @param dir    unit facing direction in the 2D plane — the display faces THIS way
 * @param params the machine's authored params (dimensions in METRES)
 * @param worldPerMetre  world units per real metre (city: 1 / cityMetresPerUnit; a 1:1 creator preview: 1)
 * @param seed   unused by the shape now (the can arrangement uses params.seed); kept for the call signature
 * @param skipCabinet  DON'T emit the cabinet box — the city instances it as the GARP-textured shell.
 * @param skipProducts DON'T emit the cans — the city instances GARP-textured stock (vendingStockGeometry) + backdrop.
 */
export function emitVending(acc: VendingAccum, base: V3, dir: V2, params: VendingParams, worldPerMetre: number, seed: number, skipCabinet = false, skipProducts = false): void {
    void seed;
    const p = params, L = vendingLayout(p), s = worldPerMetre;
    const f: V3 = [dir[0], 0, dir[1]];               // front (display faces here)
    const up: V3 = [0, 1, 0];
    // The VIEWER's right (someone in front, facing the machine): (−f) × up. r × up = f → a right-handed box basis.
    const r: V3 = [dir[1], 0, -dir[0]];
    // A point: x along r (viewer-right), y up from the foot, z out from the cabinet's FRONT plane — metres → world.
    const P = (x: number, y: number, z: number): V3 => {
        const zz = L.hd + z;
        return [base[0] + (r[0] * x + f[0] * zz) * s, base[1] + y * s, base[2] + (r[2] * x + f[2] * zz) * s];
    };
    // A box centred at (x, y, z) with half-extents (metres).
    const box = (into: Accum3D, x: number, y: number, z: number, hx: number, hy: number, hz: number): void =>
        into.obox(P(x, y, z), r, up, f, hx * s, hy * s, hz * s);
    // A front-facing quad at depth z spanning x0..x1 × y0..y1. Corner order BL → BR → TR → TL = an OUTWARD (+f)
    // normal (r × up = f), with u running viewer-left → right.
    const front = (into: Accum3D, x0: number, x1: number, y0: number, y1: number, z: number): void =>
        into.quadUV(P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z));

    // 1 · CABINET (the painted shell) — instanced + skinned in the city instead.
    if (!skipCabinet) acc.body[p.brand].obox([base[0], base[1] + L.hh * s, base[2]], r, up, f, L.hw * s, L.hh * s, L.hd * s);

    const W = p.widthM, H = p.heightM, { win } = L;

    // 2 · PRODUCT WINDOW — the lit backing, shelves, strips, buttons, glass, and a frame protruding to the glass.
    front(acc.glow, -win.x, win.x, win.y0, win.y1, L.z.glow);
    const bar = Math.min(0.03, W * 0.04), fz = L.z.frame * 0.5;
    box(acc.trim, 0, win.y1 + bar * 0.5, fz, win.x + bar, bar * 0.5, fz);          // top rail
    box(acc.trim, 0, win.y0 - bar * 0.5, fz, win.x + bar, bar * 0.5, fz);          // bottom rail
    box(acc.trim, -win.x - bar * 0.5, (win.y0 + win.y1) * 0.5, fz, bar * 0.5, (win.y1 - win.y0) * 0.5, fz);   // posts
    box(acc.trim,  win.x + bar * 0.5, (win.y0 + win.y1) * 0.5, fz, bar * 0.5, (win.y1 - win.y0) * 0.5, fz);
    for (let sh = 0; sh < p.shelves; sh++) {
        const y0 = win.y0 + sh * L.rowH;
        // Shelf plate (the cans stand on it) + the price strip on its front edge + one LED button per can.
        box(acc.trim, 0, y0 + L.stripH, (L.z.backdrop + L.z.strip) * 0.5, win.x, 0.004, (L.z.strip - L.z.backdrop) * 0.5);
        front(acc.strip, -win.x, win.x, y0, y0 + L.stripH, L.z.strip);
        for (let k = 0; k < p.cansPerShelf; k++) {
            const x = -win.x + (k + 0.5) * L.can.slotW, bw = Math.min(0.012, L.can.slotW * 0.16), bh = L.stripH * 0.22;
            front(acc.buttons, x - bw, x + bw, y0 + L.stripH * 0.5 - bh, y0 + L.stripH * 0.5 + bh, L.z.strip + 0.001);
        }
        // Light strip under the shelf above (or the window top): the bright line that lights each row of cans.
        const ly = win.y0 + (sh + 1) * L.rowH;
        front(acc.glow, -win.x, win.x, ly - 0.012, ly - 0.004, L.z.strip - 0.004);
    }
    front(acc.glass, -win.x, win.x, win.y0, win.y1, L.z.glass);

    // 3 · STOCK — standalone only (the city instances textured cans): untextured cans, colour-bucketed by label cell.
    if (!skipProducts && p.stock === 'cans') emitCans((cell) => acc.prod[cell % PRODUCT_BUCKETS], base, r, up, f, p, L, s, 0);

    // 4 · CONTROL STRIP (right, under the window): dark panel, coin + bill slots, return lever (chrome), LED display.
    const cx = W * 0.31, cy = H * 0.455;
    box(acc.trim, cx, cy, 0.006, W * 0.11, H * 0.045, 0.006);
    box(acc.chrome, cx + W * 0.06, cy + H * 0.018, 0.016, 0.014, 0.024, 0.006);     // coin slot
    box(acc.chrome, cx - W * 0.05, cy + H * 0.018, 0.016, 0.036, 0.010, 0.006);     // bill slot
    box(acc.chrome, cx + W * 0.06, cy - H * 0.022, 0.018, 0.010, 0.010, 0.010);     // return lever
    front(acc.buttons, cx - W * 0.09, cx - W * 0.01, cy - H * 0.030, cy - H * 0.014, 0.0125);   // LED display

    // 5 · PICKUP BAY — a dark recessed opening, a chrome frame, and a flap tilted in at the top.
    const bx = -W * 0.04, bhw = W * 0.26, by0 = H * 0.07, by1 = H * 0.19, fw = 0.012;
    front(acc.hole, bx - bhw, bx + bhw, by0, by1, 0.002);
    box(acc.chrome, bx, by1 + fw * 0.5, 0.012, bhw + fw, fw * 0.5, 0.012);
    box(acc.chrome, bx, by0 - fw * 0.5, 0.012, bhw + fw, fw * 0.5, 0.012);
    box(acc.chrome, bx - bhw - fw * 0.5, (by0 + by1) * 0.5, 0.012, fw * 0.5, (by1 - by0) * 0.5, 0.012);
    box(acc.chrome, bx + bhw + fw * 0.5, (by0 + by1) * 0.5, 0.012, fw * 0.5, (by1 - by0) * 0.5, 0.012);
    acc.chrome.quadUV(P(bx - bhw, by0 + (by1 - by0) * 0.25, 0.016), P(bx + bhw, by0 + (by1 - by0) * 0.25, 0.016),
                      P(bx + bhw, by1 - 0.004, 0.005), P(bx - bhw, by1 - 0.004, 0.005));   // the flap (outward, tilted)

    // 6 · PLINTH — a dark kick band along the foot.
    box(acc.trim, 0, H * 0.02, 0.0, L.hw * 0.99, H * 0.02, 0.004);
}

/** Turn a filled bundle into the city's named layers, each tagged with its ONE material family.
 *  `metalScale` = the metal detail frequency (cycles per WORLD UNIT — city passes `metalScaleFor(radius)`,
 *  a 1:1 preview passes ~3); `glow` scales the lit-window emissive (1 = default). */
export function vendingLayers(acc: VendingAccum, metalScale: number, opts: { night: boolean; glow?: number }): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const gy = 0, mScale = metalScale, glow = opts.glow ?? 1;
    VENDING_BRANDS.forEach((brand, i) => {
        if (acc.body[i].empty) return;
        out.push({
            name: `world:vending-${brand.name}`, color: brand.body, y: gy, geometry: acc.body[i].geometry(),
            metal: { tint: brand.body, streak: [brand.body[0] * 0.7, brand.body[1] * 0.7, brand.body[2] * 0.72],
                roughness: 0.40, streakAmount: 0.45, grime: 0.25, scale: mScale },
        });
    });
    if (!acc.trim.empty) out.push({ name: 'world:vending-trim', color: TRIM, y: gy, geometry: acc.trim.geometry(),
        metal: { tint: TRIM, streak: [0.08, 0.08, 0.09], roughness: 0.5, streakAmount: 0.3, grime: 0.4, scale: mScale } });
    if (!acc.chrome.empty) out.push({ name: 'world:vending-chrome', color: CHROME, y: gy, geometry: acc.chrome.geometry(),
        metal: { tint: CHROME, streak: [0.55, 0.56, 0.58], roughness: 0.25, streakAmount: 0.2, grime: 0.15, scale: mScale } });
    if (!acc.hole.empty) out.push({ name: 'world:vending-bay', color: HOLE, y: gy, geometry: acc.hole.geometry() });
    // The lit backing + shelf light strips carry the emissive; brighter at night, scaled by `glow`.
    if (!acc.glow.empty) out.push({ name: 'world:vending-glow', color: [1, 1, 1], y: gy, geometry: acc.glow.geometry(),
        emissive: (opts.night ? 1.5 : 0.85) * glow });
    if (!acc.strip.empty) out.push({ name: 'world:vending-strip', color: STRIP, y: gy, geometry: acc.strip.geometry(),
        emissive: (opts.night ? 0.5 : 0.2) * glow });
    if (!acc.buttons.empty) out.push({ name: 'world:vending-buttons', color: BUTTON, y: gy, geometry: acc.buttons.geometry(),
        emissive: (opts.night ? 1.6 : 1.0) * glow });
    acc.prod.forEach((a, i) => { if (!a.empty) out.push({ name: `world:vending-product-${i}`, color: PRODUCT_TONES[i % PRODUCT_TONES.length], y: gy, geometry: a.geometry() }); });
    // The pane over the goods catches the sky like every other glass surface.
    if (!acc.glass.empty) out.push({ name: 'world:vending-glass', color: [0.7, 0.82, 0.9], y: gy, geometry: acc.glass.geometry(), glass: true });
    return out;
}

/** Standalone: build ONE machine at the origin facing +Z, authored 1:1 in METRES (1 world unit = 1 m), as
 *  material-tagged layers + meta. The Vending Creator mode's generator entry (and the test entry). */
export function buildVendingMachine(params: Partial<VendingParams> = {}): { layers: LayoutPreviewLayer[]; meta: VendingMeta } {
    const p = resolveVendingParams(params);
    const acc = newVendingAccum();
    emitVending(acc, [0, 0, 0], [0, 1], p, 1, p.seed);          // 1 world unit = 1 m
    const layers = vendingLayers(acc, 3, { night: false, glow: p.glow });
    const hw = p.widthM * 0.5, hd = p.depthM * 0.5;
    return { layers, meta: { height: p.heightM, footprint: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] } };
}
