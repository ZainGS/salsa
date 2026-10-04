// ── World generation — CITY FOLIAGE (real trees, instanced) ─────────────────────────────────────
// Replaces the blob trees `biome.ts` used to accumulate (a prism trunk + two cones, or a trunk + three
// squashed spheres) with the actual foliage generator — the `branch` primitive, recursive limbs, leaf
// masses at the twig TIPS, and the shared S1/S2 wind + translucency layer.
//
// ★ WHY VARIANTS + INSTANCING, not one mesh per tree. `buildFoliage` emits ~2 000 triangles for a
// small-tree; a city can place several hundred. Building each one individually would be both slow to
// generate and a draw call each. Instead we build a small pool of canonical trees ONCE, then place them
// as GPU instances with per-instance yaw and scale — so the cost is (pool size) of geometry and one
// instanced draw per layer, while every copy still looks hand-made because it is a different generated
// tree at a different angle and size.
//
// ★ WHY A SCALE CONVERSION. The foliage generator authors in REAL METRES; the city is a diorama where
// one world unit is CITY_FLOOR_M / (0.2 * scale) metres — 15 m at the default radius. Rather than rescale
// the geometry (which would also have to rescale `windHeight`, the wind grading denominator), the trees
// are placed at an instance SCALE of 1/metresPerUnit. Local space stays in metres, so the wind and
// base-AO ramps keep working untouched.

import type { LayoutPreviewLayer, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { buildFoliage } from './foliage';
import type { ClumpCrownSpec } from './branch';
import { hash2 } from './util';

/** Content key of a variant layer's geometry (FNV-1a over the vertex + index bits). The variant is generated from the
 *  tile's seed, so `tree:kind:v:layer` alone named DIFFERENT meshes in different streamed tiles — the GPU pool shares
 *  geometry by instanceKey, so every tile drew whichever tile's tree uploaded first (order-dependent shapes). Identical
 *  variants still share one pooled copy. */
function geoKey(g: MeshGeometry): string {
    let h = 0x811c9dc5 >>> 0;
    const mix = (a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => {
        const u = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
        h = Math.imul(h ^ u.length, 0x01000193) >>> 0;
    };
    mix(g.vertices as Float32Array); mix(g.indices as Uint32Array);
    return h.toString(36);
}

/** One tree to place. `kind` picks the archetype; `scale` is a per-tree size multiplier (0.8 = smaller). */
export interface TreePlacement {
    pos: V2;
    y: number;
    kind: TreeKind;
    /** Size multiplier on top of the variant's own height. */
    scale?: number;
}

/** City species. The Japanese street mix (E7): ZELKOVA (keyaki — the vase-shaped avenue tree), GINKGO (the yellow
 *  autumn avenues), CAMPHOR (kusunoki — dark, dense, round), SAKURA (parks + some streets), PINE (black pine by the
 *  shrines), plus the generic broadleaf / conifer / bush the parks and gardens use. */
export type TreeKind = 'broadleaf' | 'conifer' | 'sakura' | 'bush' | 'zelkova' | 'ginkgo' | 'camphor' | 'pine';

const TRUNK: [number, number, number] = [0.36, 0.26, 0.17];
const LEAF: [number, number, number] = [0.30, 0.55, 0.28];
const SAKURA: [number, number, number] = [0.95, 0.76, 0.84];

/** Variants per kind. Enough that an avenue does not read as one tree stamped repeatedly; small enough that
 *  generation stays cheap (each is a full `buildFoliage` call). Variants ≥ FULL_DETAIL_VARIANTS use the generator's
 *  mid branch LOD (~¼ the triangles) so the pool stays affordable. */
const VARIANTS_PER_KIND = 5;
const FULL_DETAIL_VARIANTS = 3;

/** Leaf-lightness TINT BUCKETS per variant. Instanced ArrayGroups share one material (a per-instance `tint` is not
 *  honoured there), so per-tree shade variety is done by splitting each variant's LEAF layers into buckets with a
 *  slightly different colour over the SAME geometry — 2 buckets ≈ per-instance variation at +2 draws per variant. */
const TINT_BUCKETS = 2;
const BUCKET_SPREAD = 0.07;   // ± lightness between the buckets

/** How much a `leafColorVar` of 1.0 is allowed to move a variant's leaf lightness (± this, as a uniform rgb
 *  multiply). Kept small on purpose: the user wants SUBTLE variety, not rainbow trees. */
const MAX_LEAF_JITTER = 0.18;

type Rgb = [number, number, number];

/** Multiply an rgb triple channel-wise by a tint, clamping to [0,1]. */
function tint(c: unknown, k: Rgb): Rgb {
    const [r, g, b] = c as Rgb;
    return [Math.min(1, Math.max(0, r * k[0])), Math.min(1, Math.max(0, g * k[1])), Math.min(1, Math.max(0, b * k[2]))];
}

/** A warm `leafColor` tint (red over green) reads as AUTUMN: ginkgo goes gold, zelkova rust, sakura red. Simple
 *  on purpose — the season is the user's leafColor, not a new parameter. */
export function isAutumn(leafColor: Rgb): boolean { return leafColor[0] > leafColor[1] * 1.12; }

/** Per-species CLUMP-CROWN shape (branch.ts `ClumpCrownSpec`; metres). The SILHOUETTE comes from the branch
 *  skeleton (split angle / up-bias below); these set how the leaf mass gathers on it — clump size, how flat the
 *  pads are, and how much fill sits along the limbs rather than only at the twig ends. Omitted keys = defaults. */
const CLUMP: Record<'zelkova' | 'ginkgo' | 'camphor' | 'sakura' | 'broadleaf' | 'bush', Partial<ClumpCrownSpec>> = {
    // Keyaki VASE: clumps at the ends of the steep rising limbs — a broad crown, a little airy between clumps.
    zelkova: { clumpRadius: 0.8, cardsPerClump: 12, flatten: 0.8, alongLimb: 2, parentClumps: 1, skyFacing: 0.2 },
    // Ginkgo CONE: leaves bunch on short spur shoots ALL ALONG the limbs → smaller, taller clumps, more fill.
    ginkgo: { clumpRadius: 0.62, cardsPerClump: 10, flatten: 1.1, alongLimb: 2, parentClumps: 3, innerGap: 0.2 },
    // Kusunoki: a dense evergreen DOME — bigger clumps, more cards, filled interior.
    camphor: { clumpRadius: 0.95, cardsPerClump: 14, flatten: 0.9, alongLimb: 2, parentClumps: 2, innerGap: 0.12 },
    // Sakura: a SPREADING frame carrying flat, layered, sky-facing pads.
    sakura: { clumpRadius: 0.85, cardsPerClump: 12, flatten: 0.6, alongLimb: 2, parentClumps: 1, skyFacing: 0.45 },
    broadleaf: {},
    bush: { clumpRadius: 0.32, cardsPerClump: 10, alongLimb: 0, innerGap: 0.1 },
};

/** The generator params for each kind. Heights are METRES — real trees, not diorama units.
 *  `leafColor` tints all leaf colour; `jitter` is a per-variant lightness multiplier (a uniform rgb scale,
 *  so it lightens/darkens without shifting hue — safe on sakura pink as well as green). */
function variantParams(kind: TreeKind, v: number, seed: number, leafColor: Rgb, jitter: number): Record<string, unknown> {
    // ★ `leafStyle: 'clump'` — the broadleaves grow a CLUMP CROWN (branch.ts §3.6c, polish-round-3 T4): a few dense
    // leaf-cluster cards per clump at the branch ends, normals spherised toward clump + crown, so each crown shades
    // as one soft volume (the P5X street-tree read). It replaced the SPRIG crown (§3.6b, ~2 000 small cards on
    // twiglets), which was attached and right up close but read busy and see-through at the city's viewing
    // distance — at ~1/3 the triangles. `CLUMP` above is the per-species clump shape.
    const common = { render: 'card' as const, celShade: true, leafStyle: 'clump' as const, seed: (seed ^ (v * 0x9e37 + 0x1234)) >>> 0, ...(v >= FULL_DETAIL_VARIANTS ? { branchLod: 1 } : {}) };
    const autumn = isAutumn(leafColor);
    // In autumn the species colour itself changes (below) — don't ALSO multiply by the warm tint (double-warm).
    const leafK: Rgb = autumn ? [jitter, jitter, jitter] : [leafColor[0] * jitter, leafColor[1] * jitter, leafColor[2] * jitter];
    const P = (p: Record<string, unknown>): Record<string, unknown> => {
        if (p.foliageColor) p.foliageColor = tint(p.foliageColor, leafK);
        if (p.tipColor) p.tipColor = tint(p.tipColor, leafK);
        return p;
    };
    const vv = v % 3;
    switch (kind) {
        case 'conifer':
            // A REAL conifer (conifer.ts): one unbroken leader, whorled tiers that angle down and shrink toward the
            // apex. Variant 2 is narrower and steeper — a cypress next to the spruces.
            return P({ ...common, type: 'conifer', size: 6.5 + vv * 1.4, density: 0.85,
                coniferSpread: vv === 2 ? 0.11 : 0.19 + vv * 0.02,
                coniferDroop: vv === 2 ? 0.18 : 0.40 + vv * 0.06,
                foliageColor: [0.20, 0.42, 0.24], tipColor: [0.32, 0.56, 0.31], trunkColor: [0.30, 0.22, 0.16] });
        case 'pine':
            // Japanese BLACK PINE: wide, flat, sparse tiers on a leaning trunk — the shrine / garden pine.
            return P({ ...common, type: 'conifer', size: 5 + v * 0.5, density: 0.6, coniferSpread: 0.26 + vv * 0.03,
                coniferDroop: 0.06 + vv * 0.04, coniferTiers: 5,
                foliageColor: [0.15, 0.29, 0.17], tipColor: [0.24, 0.40, 0.22], trunkColor: [0.28, 0.20, 0.15] });
        case 'sakura':
            return P({ ...common, type: 'small-tree', size: 4.5 + v * 0.5, density: 0.8, clump: CLUMP.sakura,
                branchLevels: 3, branchSplitAngle: 0.72, branchUpBias: 0.3, branchGnarl: 0.55, canopyIrregular: 0.6, leafGaps: 0.22,
                foliageColor: autumn ? [0.74, 0.34, 0.18] : SAKURA, tipColor: autumn ? [0.86, 0.5, 0.2] : [0.99, 0.88, 0.92], trunkColor: [0.30, 0.22, 0.18] });
        case 'zelkova':
            // KEYAKI: a VASE — limbs rising steeply from a short trunk into a broad, fine-leaved crown.
            return P({ ...common, type: 'small-tree', size: 7.2 + v * 0.55, density: 0.8, clump: CLUMP.zelkova,
                branchLevels: 3, branchSplitAngle: 0.55, branchUpBias: 0.85, branchGnarl: 0.3, canopyIrregular: 0.5, leafGaps: 0.16,
                foliageColor: autumn ? [0.66, 0.38, 0.16] : [0.27, 0.49, 0.23], tipColor: autumn ? [0.8, 0.52, 0.2] : [0.42, 0.64, 0.30], trunkColor: [0.40, 0.34, 0.28] });
        case 'ginkgo':
            // GINKGO: upright, narrow-conical when young; fan leaves pale green, GOLD in autumn.
            return P({ ...common, type: 'small-tree', size: 7.5 + v * 0.5, density: 0.78, clump: CLUMP.ginkgo,
                branchLevels: 3, branchSplitAngle: 0.36, branchUpBias: 0.7, branchGnarl: 0.2, canopyIrregular: 0.35, leafGaps: 0.2,
                foliageColor: autumn ? [0.92, 0.76, 0.16] : [0.42, 0.60, 0.24], tipColor: autumn ? [0.98, 0.86, 0.3] : [0.56, 0.72, 0.32], trunkColor: [0.34, 0.28, 0.22] });
        case 'camphor':
            // KUSUNOKI: evergreen, dense, dark and glossy — a big round dome.
            return P({ ...common, type: 'small-tree', size: 6.5 + v * 0.6, density: 0.95, clump: CLUMP.camphor,
                branchLevels: 3, branchSplitAngle: 0.62, branchGnarl: 0.4, canopyIrregular: 0.4, leafGaps: 0.08,
                foliageColor: [0.17, 0.36, 0.17], tipColor: [0.30, 0.50, 0.24], trunkColor: [0.32, 0.25, 0.19] });
        case 'bush':
            return P({ ...common, type: 'bush', size: 1.1 + vv * 0.35, density: 0.8, clump: CLUMP.bush,
                foliageColor: [0.26, 0.47, 0.25], tipColor: [0.42, 0.63, 0.32] });
        default:
            return P({ ...common, type: 'small-tree', size: 5.5 + v * 0.8, density: 0.8, clump: CLUMP.broadleaf,
                branchLevels: 3, branchGnarl: 0.45, canopyIrregular: 0.55, leafGaps: 0.18,
                foliageColor: autumn ? [0.62, 0.44, 0.18] : LEAF, tipColor: autumn ? [0.76, 0.56, 0.22] : [0.46, 0.69, 0.34], trunkColor: TRUNK });
    }
}

/** P8 FAR CROWNS (performance-plan.md P8): past this distance (metres, at the 45° reference lens; the renderer
 *  scales it by the lens like every twin distance) a tree's leaf / tip cards swap to the thinned far crown. */
export const TREE_TWIN_M = 160;
/** The far crown keeps one card in this many (cards are emitted clump by clump along a golden spiral, so every
 *  k-th card stays spread over each clump). */
export const TREE_FAR_KEEP = 3;

/**
 * The FAR CROWN of a leaf / tip card layer: keep every `keep`-th card (a card = 4 consecutive vertices drawn as
 * the triangles a,a+1,a+2 / a,a+2,a+3 — how branch.ts emits them) and grow each kept card about its own centre by
 * √keep, so the crown keeps its coverage, outline and colour (same positions, normals and uvs) at 1/keep the cards.
 * Anything that is not a card passes through unchanged. Null when there are fewer than 2·keep cards (nothing to gain).
 */
export function farCrownGeometry(g: MeshGeometry, keep: number): MeshGeometry | null {
    const I = g.indices, V = g.vertices, F = 12;
    if (!I || !V || keep < 2 || g.format === '8float' || V.length % F !== 0) return null;
    const isCard = (t: number): boolean => {
        const a = I[t];
        return t + 5 < I.length && I[t + 1] === a + 1 && I[t + 2] === a + 2 && I[t + 3] === a && I[t + 4] === a + 2 && I[t + 5] === a + 3;
    };
    let cards = 0;
    for (let t = 0; t < I.length;) { if (isCard(t)) { cards++; t += 6; } else t += 3; }
    if (cards < 2 * keep) return null;
    const remap = new Int32Array(V.length / F).fill(-1);
    const outV: number[] = [], outI: number[] = [];
    const take = (vi: number): number => {
        if (remap[vi] < 0) { remap[vi] = outV.length / F; for (let k = 0; k < F; k++) outV.push(V[vi * F + k]); }
        return remap[vi];
    };
    const grow = Math.sqrt(keep);
    let ci = 0;
    for (let t = 0; t < I.length;) {
        if (!isCard(t)) { outI.push(take(I[t]), take(I[t + 1]), take(I[t + 2])); t += 3; continue; }
        const a = I[t];
        t += 6;
        if (ci++ % keep !== 0) continue;
        let cx = 0, cy = 0, cz = 0;
        for (let q = 0; q < 4; q++) { cx += V[(a + q) * F]; cy += V[(a + q) * F + 1]; cz += V[(a + q) * F + 2]; }
        cx /= 4; cy /= 4; cz /= 4;
        const base = outV.length / F;
        for (let q = 0; q < 4; q++) {
            const o = (a + q) * F;
            outV.push(cx + (V[o] - cx) * grow, cy + (V[o + 1] - cy) * grow, cz + (V[o + 2] - cz) * grow);
            for (let k = 3; k < F; k++) outV.push(V[o + k]);
        }
        outI.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { vertices: Float32Array.from(outV), indices: Uint32Array.from(outI), format: g.format };   // (no stale `bounds`)
}

/** The union of two 12-float geometries' local boxes as [minX, minY, minZ, maxX, maxY, maxZ]. */
function unionBounds(a: MeshGeometry, b: MeshGeometry): number[] {
    const o = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const g of [a, b]) {
        const V = g.vertices;
        for (let i = 0; i + 2 < V.length; i += 12) {
            for (let k = 0; k < 3; k++) { const v = V[i + k]; if (v < o[k]) o[k] = v; if (v > o[k + 3]) o[k + 3] = v; }
        }
    }
    return o;
}

/**
 * Build the city's trees as instanced layers.
 *
 * @param placements  every tree to place, in world units
 * @param metersPerUnit  the diorama scale (15 at the default radius) — see the header note
 * @param seed  city seed; variant generation is deterministic from it
 */
export function buildCityFoliage(
    placements: TreePlacement[],
    metersPerUnit: number,
    seed: number,
    opts?: { leafColor?: [number, number, number]; leafColorVar?: number; farCrowns?: boolean },
): LayoutPreviewLayer[] {
    if (!placements.length) return [];
    const unit = 1 / Math.max(metersPerUnit, 1e-6);      // metres → world units
    const out: LayoutPreviewLayer[] = [];

    const leafColor: Rgb = opts?.leafColor ?? [1, 1, 1];
    // Clamp the user's 0..1 variation, then scale it into a gentle ±MAX_LEAF_JITTER lightness band — even a
    // maxed-out slider stays subtle rather than garish.
    const effVar = Math.min(1, Math.max(0, opts?.leafColorVar ?? 0.08)) * MAX_LEAF_JITTER;

    // Group placements by (kind, variant). The variant is hashed from the position so a tree keeps its
    // identity across regenerations of the same seed — and so neighbours differ.
    const buckets = new Map<string, TreePlacement[]>();
    for (const p of placements) {
        const v = Math.floor(hash2(Math.round(p.pos[0] * 1370), Math.round(p.pos[1] * 731), seed) * VARIANTS_PER_KIND) % VARIANTS_PER_KIND;
        const key = `${p.kind}:${v}`;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(p);
    }

    for (const [key, group] of buckets) {
        const [kind, vs] = key.split(':');
        const v = Number(vs);
        // Per-variant lightness jitter: a uniform rgb multiply of (1 + (hash−0.5)·2·effVar), symmetric about 1 →
        // lightens/darkens without shifting hue (safe on sakura pink too).
        const jitter = 1 + (hash2(kind.length * 27 + v * 53, v * 81 + 17, seed ^ 0x2c9d) - 0.5) * 2 * effVar;
        let built;
        try {
            built = buildFoliage(variantParams(kind as TreeKind, v, seed, leafColor, jitter) as never);
        } catch {
            continue;   // a variant that fails to generate must not take the whole city down with it
        }
        const transforms = group.map((p) => ({
            x: p.pos[0], y: p.y, z: p.pos[1],
            ry: hash2(Math.round(p.pos[1] * 3100), Math.round(p.pos[0] * 9700), seed ^ 0x5bd1) * Math.PI * 2,
            // Per-tree size jitter ±18% on top of the diorama conversion — the cheapest way to stop a
            // pool of variants reading as stamps.
            s: unit * (p.scale ?? 1) * (0.82 + hash2(Math.round(p.pos[0] * 5900), Math.round(p.pos[1] * 2300), seed ^ 0x77ab) * 0.36),
            // Tint bucket (per instance, position-hashed).
            b: hash2(Math.round(p.pos[0] * 4100), Math.round(p.pos[1] * 6700), seed ^ 0x71e7) < 0.5 ? 0 : 1,
        }));
        const twinDist = TREE_TWIN_M * unit;
        for (const L of built.layers) {
            if (!L.geometry || !L.geometry.indices?.length) continue;
            const leafy = /leaf|tip/.test(L.name);
            // P8 FAR CROWN: the leaf / tip cards thinned to every TREE_FAR_KEEP-th card, each grown to keep the
            // crown's coverage (farCrownGeometry). Null when the layer has no cards (or the twins are off).
            const far = leafy && opts?.farCrowns !== false ? farCrownGeometry(L.geometry, TREE_FAR_KEEP) : null;
            // Both crowns carry ONE local box (the union): instance 0 of a group is a plain mesh whose twin swap is
            // decided on its box, so the near and far copies must have the identical one (Renderer3D.useGeometryBounds).
            if (far) { const u = unionBounds(L.geometry, far); (L.geometry as { bounds?: number[] }).bounds = u; (far as { bounds?: number[] }).bounds = u; }
            const nearTris = Math.floor(L.geometry.indices.length / 3);
            for (let b = 0; b < (leafy ? TINT_BUCKETS : 1); b++) {
                const mine = leafy ? transforms.filter(t => t.b === b) : transforms;
                if (!mine.length) continue;
                const k = leafy ? 1 + (b - (TINT_BUCKETS - 1) / 2) * 2 * BUCKET_SPREAD : 1;
                const layer: LayoutPreviewLayer = {
                    ...L,
                    name: `world:tree-${kind}-${v}:${L.name}${leafy ? '#' + b : ''}`,
                    color: leafy ? tint(L.color, [k, k, k]) : L.color,
                    y: 0,
                    // ★ EACH LAYER GETS ITS OWN COPY of the transforms. The drape pass lifts and warps instance
                    // transforms IN PLACE (`t.y += heightFn(...)`, `t.x += warp`), so sharing one array across a
                    // variant's trunk/leaf/tip layers applied the terrain THREE TIMES to the same objects —
                    // sinking every tree to ~3x the terrain depth (measured: instances at y −0.73 against a
                    // height field bounded at −0.28) and tripling the horizontal warp, which also walked them
                    // off their spot and into buildings. One array per layer; they must not alias.
                    instances: mine.map((t) => ({ x: t.x, y: t.y, z: t.z, ry: t.ry, s: t.s })),
                    arrayGroup: true,                 // ONE instanced draw for every copy of this variant layer
                    castShadow: true,                 // a 6 m tree must cast one; instanced draws opt in (Mesh3D)
                    instanceKey: `tree:${kind}:${v}:${L.name}:${geoKey(L.geometry)}`,   // the tint buckets share ONE geometry (content-keyed: P20)
                };
                if (!far) { out.push(layer); continue; }
                // NEAR twin = the layer unchanged; FAR twin = the same transforms (own copy) with the thinned crown.
                // Same name + material, so every name-keyed rule (tiers, wind, shadows) holds for both.
                const tw = { key: `tree:${kind}:${v}`, dist: twinDist, uvFromNear: true, gridTris: nearTris };
                out.push({ ...layer, nearTwin: { ...tw, role: 'near' } });
                out.push({ ...layer, geometry: far, instances: mine.map((t) => ({ x: t.x, y: t.y, z: t.z, ry: t.ry, s: t.s })),
                    instanceKey: `tree:${kind}:${v}:${L.name}:far:${geoKey(far)}`, nearTwin: { ...tw, role: 'far' } });
            }
        }
    }
    return out;
}
