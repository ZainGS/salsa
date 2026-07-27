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
import { buildFoliage } from './foliage';
import { hash2 } from './util';

/** One tree to place. `kind` picks the archetype; `scale` is a per-tree size multiplier (0.8 = smaller). */
export interface TreePlacement {
    pos: V2;
    y: number;
    kind: TreeKind;
    /** Size multiplier on top of the variant's own height. */
    scale?: number;
}

export type TreeKind = 'broadleaf' | 'conifer' | 'sakura' | 'bush';

const TRUNK: [number, number, number] = [0.36, 0.26, 0.17];
const LEAF: [number, number, number] = [0.30, 0.55, 0.28];
const SAKURA: [number, number, number] = [0.95, 0.76, 0.84];

/** Variants per kind. Enough that a park does not read as one tree stamped repeatedly; small enough that
 *  generation stays cheap (each is a full `buildFoliage` call). */
const VARIANTS_PER_KIND = 3;

/** The generator params for each kind. Heights are METRES — real trees, not diorama units. */
function variantParams(kind: TreeKind, v: number, seed: number): Record<string, unknown> {
    const common = { render: 'card' as const, celShade: true, seed: (seed ^ (v * 0x9e37 + 0x1234)) >>> 0 };
    switch (kind) {
        case 'conifer':
            // A REAL conifer now (conifer.ts): one unbroken leader, whorled tiers that angle down and
            // shrink toward the apex, needle sprays along each branch. Variant 2 is narrower and steeper —
            // a cypress next to the two spruces.
            return { ...common, type: 'conifer', size: 6.5 + v * 1.4, density: 0.85,
                coniferSpread: v === 2 ? 0.11 : 0.19 + v * 0.02,
                coniferDroop: v === 2 ? 0.18 : 0.40 + v * 0.06,
                foliageColor: [0.20, 0.42, 0.24], tipColor: [0.32, 0.56, 0.31], trunkColor: [0.30, 0.22, 0.16] };
        case 'sakura':
            return { ...common, type: 'small-tree', size: 4.5 + v * 0.7, density: 0.8,
                branchLevels: 3, branchGnarl: 0.55, canopyIrregular: 0.6, leafGaps: 0.22,
                foliageColor: SAKURA, tipColor: [0.99, 0.88, 0.92], trunkColor: [0.30, 0.22, 0.18] };
        case 'bush':
            return { ...common, type: 'bush', size: 1.1 + v * 0.35, density: 0.8,
                foliageColor: [0.26, 0.47, 0.25], tipColor: [0.42, 0.63, 0.32] };
        default:
            return { ...common, type: 'small-tree', size: 5.5 + v * 1.1, density: 0.8,
                branchLevels: 3, branchGnarl: 0.45, canopyIrregular: 0.55, leafGaps: 0.18,
                foliageColor: LEAF, tipColor: [0.46, 0.69, 0.34], trunkColor: TRUNK };
    }
}

/**
 * Build the city's trees as instanced layers.
 *
 * @param placements  every tree to place, in world units
 * @param metersPerUnit  the diorama scale (15 at the default radius) — see the header note
 * @param seed  city seed; variant generation is deterministic from it
 */
export function buildCityFoliage(placements: TreePlacement[], metersPerUnit: number, seed: number): LayoutPreviewLayer[] {
    if (!placements.length) return [];
    const unit = 1 / Math.max(metersPerUnit, 1e-6);      // metres → world units
    const out: LayoutPreviewLayer[] = [];

    // Group placements by (kind, variant). The variant is hashed from the position so a tree keeps its
    // identity across regenerations of the same seed — and so neighbours differ.
    const buckets = new Map<string, TreePlacement[]>();
    for (const p of placements) {
        const v = Math.floor(hash2(p.pos[0] * 13.7, p.pos[1] * 7.31, seed) * VARIANTS_PER_KIND) % VARIANTS_PER_KIND;
        const key = `${p.kind}:${v}`;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(p);
    }

    for (const [key, group] of buckets) {
        const [kind, vs] = key.split(':');
        const v = Number(vs);
        let built;
        try {
            built = buildFoliage(variantParams(kind as TreeKind, v, seed) as never);
        } catch {
            continue;   // a variant that fails to generate must not take the whole city down with it
        }
        const transforms = group.map((p) => ({
            x: p.pos[0], y: p.y, z: p.pos[1],
            ry: hash2(p.pos[1] * 3.1, p.pos[0] * 9.7, seed ^ 0x5bd1) * Math.PI * 2,
            // Per-tree size jitter ±18% on top of the diorama conversion — the cheapest way to stop a
            // pool of 3 variants reading as 3 stamps.
            s: unit * (p.scale ?? 1) * (0.82 + hash2(p.pos[0] * 5.9, p.pos[1] * 2.3, seed ^ 0x77ab) * 0.36),
        }));
        for (const L of built.layers) {
            if (!L.geometry || !L.geometry.indices?.length) continue;
            out.push({
                ...L,
                name: `world:tree-${kind}-${v}:${L.name}`,
                y: 0,
                // ★ EACH LAYER GETS ITS OWN COPY of the transforms. The drape pass lifts and warps instance
                // transforms IN PLACE (`t.y += heightFn(...)`, `t.x += warp`), so sharing one array across a
                // variant's trunk/leaf/tip layers applied the terrain THREE TIMES to the same objects —
                // sinking every tree to ~3x the terrain depth (measured: instances at y −0.73 against a
                // height field bounded at −0.28) and tripling the horizontal warp, which also walked them
                // off their spot and into buildings. One array per layer; they must not alias.
                instances: transforms.map((t) => ({ ...t })),
                arrayGroup: true,                 // ONE instanced draw for every copy of this variant layer
                castShadow: true,                 // a 6 m tree must cast one; instanced draws opt in (Mesh3D)
                instanceKey: `tree:${kind}:${v}:${L.name}`,
            });
        }
    }
    return out;
}
