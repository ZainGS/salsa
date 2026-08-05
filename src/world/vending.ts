// ── World generation — VENDING MACHINE generator ────────────────────────────────────────────────
// The first prop rebuilt from a single box (12 tris of flat colour) into a real generator with per-material
// SUB-LAYERS — the pattern docs/specs/city-props-garp.md sets for every prop worth detailing. A jido-hanbaiki
// is the most characteristic object on a Japanese street, and its whole read comes from the LIT product
// window behind glass: a cabinet is metal, the window is a glowing backing, the goods are matte boxes, and a
// glass pane sits over the lot. Each of those is its own sub-layer so it picks up the correct material family
// automatically — and so the fascia/products become natural GARP texture slots later (none are textured yet).
//
// ★ ONE MATERIAL FAMILY PER SUB-LAYER. `pattern`, `metal`, `glass`(flag), `neon`, `ground`, `foliageShade`
// share the four pattern instance floats — a mesh is exactly one of them (glass is a plain flag bit and
// composes freely). So the split is not cosmetic: it is what lets metal, glow and glass coexist on one
// object. See src/world/city-materials.test.ts for the invariant this must not break.
//
// ★ MERGE-EMIT, not one mesh per machine. Like addCar/addBench in furniture.ts, a machine is emitted INTO
// caller-owned accumulators, so hundreds of machines cost a handful of draw calls (one per brand + the
// shared trim/glass/glow/product layers), not one draw each.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import type { GarpPool } from './garp';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

type V3 = [number, number, number];

/** A machine brand = a body colour (the metal cabinet tint) + a lit-window tone. Three like the old
 *  red/blue/white trio, so the city reads the same but with structure. */
export interface VendingBrand { name: string; body: [number, number, number]; glow: [number, number, number]; }

export const VENDING_BRANDS: VendingBrand[] = [
    { name: 'red',  body: [0.80, 0.16, 0.16], glow: [1.00, 0.86, 0.72] },
    { name: 'blue', body: [0.14, 0.40, 0.74], glow: [0.80, 0.92, 1.00] },
    { name: 'cyan', body: [0.90, 0.90, 0.86], glow: [0.86, 1.00, 0.98] },
];

/** The goods behind the glass, in a couple of shared colour buckets so a wall of machines has varied stock
 *  without a layer per can. Matte — they sit behind glass and read by silhouette + colour, not shading. */
const PRODUCT_TONES: [number, number, number][] = [
    [0.86, 0.24, 0.20], [0.20, 0.52, 0.82], [0.94, 0.78, 0.24], [0.32, 0.68, 0.40],
];
const PRODUCT_BUCKETS = 2;

const TRIM: [number, number, number] = [0.14, 0.14, 0.16];   // dark coin mech / dispensing tray

/** A vending machine's authored params. Dimensions are REAL METRES (a machine is a real-world object); the
 *  caller supplies a world-units-per-metre factor at emit time, so the same params size correctly whether
 *  placed in the diorama city or previewed 1:1 in a creator mode. This is the shape a Vending Creator mode
 *  (docs/specs/creator-modes.md §5) binds sliders to, and the future GARP skin will extend. */
export interface VendingParams {
    brand: number;        // index into VENDING_BRANDS (the cabinet colour + window tone)
    heightM: number;      // real cabinet height / width / depth, metres
    widthM: number;
    depthM: number;
    productCols: number;  // the product grid behind the glass (1..4 each)
    productRows: number;
    glow: number;         // emissive multiplier for the lit window (1 = default)
    seed: number;         // product-colour + jitter stream
}

export const DEFAULT_VENDING_PARAMS: VendingParams = {
    // Defaults match a standard jido-hanbaiki, and reproduce the city's prior machine size to the millimetre
    // (old hardcoded half-extents 0.028/0.060/0.020 · s → 0.84 × 1.8 × 0.6 m at the diorama scale).
    brand: 0, heightM: 1.8, widthM: 0.84, depthM: 0.6, productCols: 2, productRows: 2, glow: 1, seed: 1,
};

/** Fill defaults + clamp to sane ranges (old saves / sparse host input load safely). */
export function resolveVendingParams(p: Partial<VendingParams> = {}): VendingParams {
    return {
        ...DEFAULT_VENDING_PARAMS, ...p,
        brand: ((Math.round(p.brand ?? 0) % VENDING_BRANDS.length) + VENDING_BRANDS.length) % VENDING_BRANDS.length,
        heightM: Math.max(0.6, p.heightM ?? DEFAULT_VENDING_PARAMS.heightM),
        widthM: Math.max(0.4, p.widthM ?? DEFAULT_VENDING_PARAMS.widthM),
        depthM: Math.max(0.3, p.depthM ?? DEFAULT_VENDING_PARAMS.depthM),
        productCols: Math.max(1, Math.min(4, Math.round(p.productCols ?? DEFAULT_VENDING_PARAMS.productCols))),
        productRows: Math.max(1, Math.min(4, Math.round(p.productRows ?? DEFAULT_VENDING_PARAMS.productRows))),
        glow: Math.max(0, p.glow ?? DEFAULT_VENDING_PARAMS.glow),
    };
}

/** Generator metadata (the shape ProceduralObjectManager wants): real height + ground footprint, metres. */
export interface VendingMeta { height: number; footprint: [number, number][]; }

// ── GARP pool (docs/specs/city-props-garp.md §2) ──────────────────────────────────────────────────
// A vending machine is the canonical GARP consumer: two coordinated texture SLOTS — the `body` (the opaque
// cabinet shell — the instanced, textured GARP surface, unwrap in vendingShellGeometry) and the `products` (the
// goods behind the glass, its own emissive/glass material family). The unit of choice is the whole SKIN, so a
// machine can never wear a Pocari body over Coffee products. Each brand is one skin; the city picks a skin per
// machine by position hash. This module owns only the pool STRUCTURE (slots + skin names + opaque texture KEYS);
// resolving a key to an actual image (ephemera/upload) is a services concern (GarpManager + shape-manager),
// exactly like the rest of GARP keeps world/ free of textures.
export const VENDING_SLOTS = ['body', 'products'] as const;

/** The stable texture KEY for a brand's slot — the string a skin references and the GarpManager maps to a layer. */
export function vendingSkinKey(brand: string, slot: string): string { return `vending/${brand}/${slot}`; }

/** The BODY shell's UV UNWRAP — a rectangle per face in 0..1 texture space (a PUBLIC contract; bump
 *  {@link vendingGarpPool}'s `version` if it changes, since user skins are painted against it). Front-DOMINANT:
 *  the FRONT takes the left ~half at full resolution (it's the detail-critical brand face); the other five faces
 *  pack into the right half as a 2-column grid. Regions have small gaps so bilinear filtering never bleeds one
 *  face's paint onto its neighbour. The host draws these as labelled overlays on the `body` authoring canvas so a
 *  user knows which patch of the square lands on which face (see {@link garpSlotRegions3D} in ShapeManager). */
export const VENDING_BODY_UV_REGIONS: { label: string; rect: [number, number, number, number] }[] = [
    { label: 'front',  rect: [0.00, 0.00, 0.49, 1.00] },
    { label: 'back',   rect: [0.51, 0.00, 0.74, 0.32] },
    { label: 'top',    rect: [0.76, 0.00, 1.00, 0.32] },
    { label: 'left',   rect: [0.51, 0.34, 0.74, 0.66] },
    { label: 'right',  rect: [0.76, 0.34, 1.00, 0.66] },
    { label: 'bottom', rect: [0.51, 0.68, 0.74, 1.00] },
];

/** The CANONICAL machine-BODY shell geometry — the opaque cabinet box at the LOCAL origin (front = +Z), sized in
 *  WORLD UNITS. Built ONCE and GPU-instanced across every city machine (one geometry + N transforms); each copy
 *  wears a different skin via a per-instance textureIndex, replacing the merged brand-coloured cabinet. Its six
 *  faces map to {@link VENDING_BODY_UV_REGIONS} — a full per-face unwrap, so sides/top are individually paintable.
 *  All normals point OUTWARD (verified by winding) so lighting is correct. */
export function vendingShellGeometry(params: Partial<VendingParams>, worldPerMetre: number): MeshGeometry {
    const p = resolveVendingParams(params);
    const hx = p.widthM * 0.5 * worldPerMetre, hy = p.heightM * 0.5 * worldPerMetre, hz = p.depthM * 0.5 * worldPerMetre;
    const a = new Accum3D();
    const rectOf = (label: string): [number, number, number, number] => VENDING_BODY_UV_REGIONS.find((r) => r.label === label)!.rect;
    // Map a face quad (corners a=TR,b=TL,c=BL,d=BR in the face's own frame) to its UV rect [u0,v0,u1,v1]:
    // a→(u0,v0) b→(u1,v0) c→(u1,v1) d→(u0,v1) — the same convention the front used.
    const face = (p0: V3, p1: V3, p2: V3, p3: V3, label: string): void => {
        const [u0, v0, u1, v1] = rectOf(label);
        a.quadUV4(p0, p1, p2, p3, [u0, v0], [u1, v0], [u1, v1], [u0, v1]);
    };
    face([hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz], [hx, -hy, hz], 'front');       // +Z
    face([-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz], 'back');    // -Z
    face([-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz], 'left');    // -X
    face([hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz], [hx, -hy, -hz], 'right');       // +X
    face([hx, hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], 'top');         // +Y
    face([hx, -hy, hz], [-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], 'bottom');  // -Y
    return a.geometry();
}

/** The per-machine BODY INSTANCE transform: places the canonical {@link vendingShellGeometry} box at the machine's
 *  cabinet centre and yaws it to face `dir` — exactly where emitVending's cabinet used to sit, so the merged window
 *  furniture (glow / products / glass) still lands in front. `base` = foot centre (world units). */
export function vendingShellTransform(base: V3, dir: V2, params: Partial<VendingParams>, worldPerMetre: number): { x: number; y: number; z: number; ry: number } {
    const p = resolveVendingParams(params);
    const hy = p.heightM * 0.5 * worldPerMetre;
    return {
        x: base[0], y: base[1] + hy, z: base[2],   // cabinet centre = foot + half-height
        ry: Math.atan2(dir[0], dir[1]),             // yaw the +Z front to face `dir`
    };
}

/** The CANONICAL products-display panel geometry — a flat front-facing quad (0..1 UV) sized to the machine's window,
 *  at the LOCAL origin (front = +Z). The GARP `products` slot: a printed drink-display image behind the glass (variety
 *  lives in the image, not in geometry — readable at the iso city distance where individual bottles wouldn't be). */
export function vendingProductsGeometry(params: Partial<VendingParams>, worldPerMetre: number): MeshGeometry {
    const p = resolveVendingParams(params);
    const hw = p.widthM * 0.5 * worldPerMetre, hh = p.heightM * 0.5 * worldPerMetre;
    const winHR = hw * 0.70, winHD = hh * 0.50;   // slightly inside the glow backing → a thin lit border shows
    const a = new Accum3D();
    // Front (+Z), full 0..1 UV, upright — same corner convention as the body front face.
    a.quadUV4([winHR, winHD, 0], [-winHR, winHD, 0], [-winHR, -winHD, 0], [winHR, -winHD, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    return a.geometry();
}

/** The per-machine PRODUCTS panel INSTANCE transform: places {@link vendingProductsGeometry} in the machine's window
 *  (upper-middle front), between the lit backing and the glass, yawed to face `dir`. Matches emitVending's window. */
export function vendingProductsTransform(base: V3, dir: V2, params: Partial<VendingParams>, worldPerMetre: number): { x: number; y: number; z: number; ry: number } {
    const p = resolveVendingParams(params);
    const hh = p.heightM * 0.5 * worldPerMetre, hd = p.depthM * 0.5 * worldPerMetre;
    const winCy = hh * 0.14;                       // the window's upward shift (matches emitVending)
    return {
        x: base[0] + dir[0] * hd * 1.03,           // between the glow backing (1.004) and the glass (1.06)
        y: base[1] + hh + winCy,                   // cabinet centre (base+hh) + the window shift
        z: base[2] + dir[1] * hd * 1.03,
        ry: Math.atan2(dir[0], dir[1]),
    };
}

/** The vending GARP pool: one skin per brand, each supplying a `body` + `products` texture key. Pure structure —
 *  the caller registers the matching {@link vendingSkinKey} → DecalSource textures + builds the atlas.
 *  ★ `version` is a CONTRACT over the body UNWRAP (vendingShellGeometry): bump it if that layout changes, because
 *  user skins are painted against it. (v2 = the shell-body unwrap; v1 was the old flat fascia band.) */
export function vendingGarpPool(): GarpPool {
    return {
        id: 'salsa/vending', name: 'Vending machines', version: 2, size: [512, 512],
        slots: [...VENDING_SLOTS],
        // A user variant painted on the BODY alone (the UV-Paint→Skins bridge) omits `products` — this default
        // keeps such a skin valid (products isn't instanced in-city anyway).
        defaults: { products: vendingSkinKey('_default', 'products') },
        skins: VENDING_BRANDS.map((b) => ({
            name: b.name,
            slots: { body: vendingSkinKey(b.name, 'body'), products: vendingSkinKey(b.name, 'products') },
        })),
    };
}

/** Caller-owned accumulator bundle — one machine emits into it; a city fills it from many placements, then
 *  {@link vendingLayers} turns it into the named, material-tagged layers. */
export interface VendingAccum {
    body: Accum3D[];        // one per brand (metal tint is per-LAYER, so brands can't share a metal layer)
    trim: Accum3D;          // coin mech + tray (dark metal)
    glass: Accum3D;         // the window pane
    glow: Accum3D;          // the lit interior backing (emissive)
    prod: Accum3D[];        // product boxes, split into a few colour buckets
}

export function newVendingAccum(): VendingAccum {
    return {
        body: VENDING_BRANDS.map(() => new Accum3D()),
        trim: new Accum3D(),
        glass: new Accum3D(),
        glow: new Accum3D(),
        prod: Array.from({ length: PRODUCT_BUCKETS }, () => new Accum3D()),
    };
}

/**
 * Emit ONE vending machine into `acc`.
 * @param base   foot centre in WORLD UNITS (ground contact point)
 * @param dir    unit facing direction in the 2D plane — the display faces THIS way
 * @param params the machine's authored params (dimensions in METRES)
 * @param worldPerMetre  world units per real metre — the caller's scale bridge. The diorama city passes
 *               `1 / cityMetresPerUnit(radius)` (physically-correct size); a 1:1 creator preview passes 1.
 * @param seed   product-colour + jitter stream (city passes its seed; a creator passes params.seed)
 * @param skipCabinet  when true, DON'T emit the opaque cabinet box — the city instances it as a GARP-textured
 *               shell (vendingShellGeometry) instead, so it must not also be merge-emitted here. The window
 *               furniture (glow / products / glass / frame / tray) still emits, landing in front of the shell.
 * @param skipProducts when true, DON'T emit the merged product boxes — the city instances a GARP-textured products
 *               panel (vendingProductsGeometry) instead. The standalone creator keeps the 3D boxes (no texture).
 */
export function emitVending(acc: VendingAccum, base: V3, dir: V2, params: VendingParams, worldPerMetre: number, seed: number, skipCabinet = false, skipProducts = false): void {
    const bi = params.brand;
    const f: V3 = [dir[0], 0, dir[1]];               // front (display faces here)
    const up: V3 = [0, 1, 0];
    const r: V3 = [-dir[1], 0, dir[0]];              // right (cross axis)

    // Cabinet half-extents in world units = half the real metres × the scale bridge.
    const hw = params.widthM * 0.5 * worldPerMetre, hh = params.heightM * 0.5 * worldPerMetre, hd = params.depthM * 0.5 * worldPerMetre;
    const c: V3 = [base[0] + up[0] * hh, base[1] + up[1] * hh, base[2] + up[2] * hh];   // body centre

    // 1 · CABINET — the painted-metal shell (a full box; the window furniture layers over its front face,
    // each at a slightly greater front depth so occlusion is front-to-back and nothing z-fights). In the city
    // this is SKIPPED and instanced as a GARP-textured shell (vendingShellGeometry) so each machine can be skinned.
    if (!skipCabinet) acc.body[bi].obox(c, r, up, f, hw, hh, hd);

    // The product WINDOW occupies the upper-middle of the front; a tray/selection strip sits below it.
    const winHR = hw * 0.74, winHD = hh * 0.52, winCy = hh * 0.14;   // half-width, half-height, upward shift
    // A point on/near the front plane: centre + right*sr + up*(winCy + su) + front*depth.
    const P = (sr: number, su: number, depth: number): V3 => [
        c[0] + r[0] * sr + up[0] * (winCy + su) + f[0] * depth,
        c[1] + r[1] * sr + up[1] * (winCy + su) + f[1] * depth,
        c[2] + r[2] * sr + up[2] * (winCy + su) + f[2] * depth,
    ];
    // Front-facing quad (+f normal) at `depth`, spanning ±winHR × ±winHD, with unit-square UVs. Corner order
    // bottom-right → bottom-left → top-left → top-right yields an OUTWARD (+f) normal (r×up = -f here).
    const frontQuad = (into: Accum3D, depth: number, hR = winHR, hD = winHD): void =>
        into.quadUV(P(hR, -hD, depth), P(-hR, -hD, depth), P(-hR, hD, depth), P(hR, hD, depth));

    // 2 · LIT BACKING (emissive) — just off the front face; this is the glow the whole prop reads by.
    frontQuad(acc.glow, hd * 1.004);

    // 3 · PRODUCTS — a grid of matte boxes between the backing and the glass, colour-bucketed per slot. In the city
    // this is SKIPPED and instanced as a GARP-textured products PANEL (vendingProductsGeometry) so it can be skinned.
    const cols = params.productCols, rows = params.productRows, pw = winHR / cols * 0.72, ph = winHD / rows * 0.66, pd = hd * 0.16;
    if (!skipProducts) for (let gx = 0; gx < cols; gx++) for (let gy = 0; gy < rows; gy++) {
        // Guard the single-column/row case: `/(cols-1)` is a divide-by-zero at cols===1 → centre it.
        const sr = cols > 1 ? (gx / (cols - 1) * 2 - 1) * (winHR - pw) : 0;
        const su = rows > 1 ? (gy / (rows - 1) * 2 - 1) * (winHD - ph) : 0;
        const pc: V3 = [
            c[0] + r[0] * sr + up[0] * (winCy + su) + f[0] * (hd * 1.02 + pd),
            c[1] + r[1] * sr + up[1] * (winCy + su) + f[1] * (hd * 1.02 + pd),
            c[2] + r[2] * sr + up[2] * (winCy + su) + f[2] * (hd * 1.02 + pd),
        ];
        const bucket = Math.floor(hash2(pc[0] * 31.7 + gx, pc[2] * 17.3 + gy, seed ^ 0x1d3a) * PRODUCT_BUCKETS) % PRODUCT_BUCKETS;
        acc.prod[bucket].obox(pc, r, up, f, pw, ph, pd);
    }

    // 4 · GLASS — the pane over the window, in front of the goods.
    frontQuad(acc.glass, hd * 1.06);

    // 5 · WINDOW FRAME (dark metal) — four thin bars picture-framing the window on the front face. These give the
    // display real depth and hide the product/backing edges. Emitted into `trim` (NEUTRAL dark metal, NOT brand
    // tint) so the frame reads correctly over ANY body skin — the brand colour now comes from the shell texture.
    const fd = hd * 1.03, bar = hh * 0.05;
    const barBox = (sr: number, su: number, hR: number, hD: number): void =>
        acc.trim.obox([c[0] + r[0] * sr + up[0] * (winCy + su) + f[0] * fd,
                           c[1] + r[1] * sr + up[1] * (winCy + su) + f[1] * fd,
                           c[2] + r[2] * sr + up[2] * (winCy + su) + f[2] * fd], r, up, f, hR, hD, hh * 0.02);
    barBox(0,  winHD + bar, winHR + bar, bar);   // top brand strip
    barBox(0, -winHD - bar, winHR + bar, bar);   // bottom rail
    barBox(-winHR - bar, 0, bar, winHD);         // left post
    barBox( winHR + bar, 0, bar, winHD);         // right post

    // 6 · TRAY + COIN MECH (dark metal) — the dispensing slot and selection panel below the window.
    const trayCy = -hh * 0.62;
    acc.trim.obox([c[0] + f[0] * hd * 1.02 + up[0] * trayCy, c[1] + f[1] * hd * 1.02 + up[1] * trayCy, c[2] + f[2] * hd * 1.02 + up[2] * trayCy],
        r, up, f, hw * 0.62, hh * 0.10, hd * 0.14);   // dispensing tray
    acc.trim.obox([c[0] + r[0] * hw * 0.62 + f[0] * hd * 1.02 + up[0] * (winCy - winHD * 0.2),
                   c[1] + f[1] * hd * 1.02 + up[1] * (winCy - winHD * 0.2),
                   c[2] + r[2] * hw * 0.62 + f[2] * hd * 1.02 + up[2] * (winCy - winHD * 0.2)],
        r, up, f, hw * 0.16, hh * 0.16, hd * 0.12);   // coin mech / selection column on the right
}

/** Turn a filled bundle into the city's named layers, each tagged with its ONE material family.
 *  `metalScale` = the metal detail frequency (cycles per WORLD UNIT — city passes `metalScaleFor(radius)`,
 *  a 1:1 preview passes ~3); `glow` scales the lit-window emissive (1 = default). */
export function vendingLayers(acc: VendingAccum, metalScale: number, opts: { night: boolean; glow?: number }): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const gy = 0;
    const mScale = metalScale;
    const glow = opts.glow ?? 1;
    // Painted-metal cabinets, one layer per brand (metal tint replaces the diffuse, so brands can't merge).
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
    // The lit backing carries the emissive; a machine glows warmly, brighter at night, scaled by `glow`.
    if (!acc.glow.empty) out.push({ name: 'world:vending-glow', color: [1, 1, 1], y: gy, geometry: acc.glow.geometry(),
        emissive: (opts.night ? 1.5 : 0.85) * glow });
    acc.prod.forEach((a, i) => { if (!a.empty) out.push({ name: `world:vending-product-${i}`, color: PRODUCT_TONES[i % PRODUCT_TONES.length], y: gy, geometry: a.geometry() }); });
    // The pane over the goods catches the sky like every other glass surface.
    if (!acc.glass.empty) out.push({ name: 'world:vending-glass', color: [0.7, 0.82, 0.9], y: gy, geometry: acc.glass.geometry(), glass: true });
    return out;
}

/** Standalone: build ONE machine at the origin facing +Z, authored 1:1 in METRES (1 world unit = 1 m), as
 *  material-tagged layers + meta. This is the generator entry a Vending Creator MODE consumes: the manager
 *  display-scales the whole group (like Building/Foliage) via ProceduralObjectManager. Also the test entry. */
export function buildVendingMachine(params: Partial<VendingParams> = {}): { layers: LayoutPreviewLayer[]; meta: VendingMeta } {
    const p = resolveVendingParams(params);
    const acc = newVendingAccum();
    emitVending(acc, [0, 0, 0], [0, 1], p, 1, p.seed);          // 1 world unit = 1 m
    const layers = vendingLayers(acc, 3, { night: false, glow: p.glow });   // ~3 cycles/m metal detail at 1:1
    const hw = p.widthM * 0.5, hd = p.depthM * 0.5;
    return { layers, meta: { height: p.heightM, footprint: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] } };
}
