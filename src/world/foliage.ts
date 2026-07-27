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
import { bladeTuft, type BladeTuftSpec } from './blade';
import { type PetalShape, type WhorlSpec } from './whorl';
import { emitStalk, resolveStalk, type StalkAccum, type StalkSpec } from './stalk';
import { buildRunners, resolveRunner, wallHost, type Phyllotaxy, type RunnerAccum, type RunnerSource, type RunnerSpec } from './runner';
import { emitConifer, resolveConifer } from './conifer';
import {
    emitBranch, emitCanopy, emitHedgeShell, leafBudget, resolveBranch,
    DEFAULT_CANOPY, DEFAULT_HEDGE_SHELL, DEFAULT_LEAF, MAX_LEAVES_PER_PLANT,
    type BranchSpec, type CanopySpec, type HedgeShellSpec, type LeafGeom,
} from './branch';
import {
    plantingArrangement, MAX_PLANTS_PER_VESSEL, MAX_VESSEL_LEAVES,
    type PlantingAccum, type PlantingSpec, type PlantKind, type VesselTop,
} from './planting';
import type { V2, LayoutPreviewLayer } from './types';

type V3 = [number, number, number];

export type FoliageType =
    | 'bush' | 'shrub' | 'hedge' | 'grass-tuft' | 'tall-grass' | 'flower-bed'   // ground
    | 'daisy' | 'rapeseed' | 'lavender'                            // FLOWERS (whorl + stalk, P2)
    | 'planter' | 'potted' | 'small-tree' | 'conifer'               // vessel / tree
    | 'vine' | 'ivy' | 'window-box';                               // wall / window
export type FoliageRender = 'chunky' | 'card';
export type VesselMaterial = 'terracotta' | 'ceramic' | 'metal' | 'wood' | 'stone';

export interface FoliageParams {
    type: FoliageType;
    seed: number;
    // ── CONIFER (the whorl-tiered evergreen archetype — see conifer.ts). All OPTIONAL; omitting one uses
    // the archetype's own recipe, the same rule as every other archetype section.
    /** Widest whorl radius as a fraction of height. A spruce ≈ 0.2 · a columnar cypress ≈ 0.08. */
    coniferSpread?: number;
    /** Whorls up the leader. More = a denser, more layered crown. */
    coniferTiers?: number;
    /** How far the LOWEST branches angle down (radians). 0 = flat spokes; ~0.5 = a drooping spruce. */
    coniferDroop?: number;
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
    // ── BLADE archetypes only (`grass-tuft` / `tall-grass`, foliage-quality.md §3.1). Each is a 0..1
    //    knob where **0.5 = the archetype's own default**, 0 = none, 1 = double. Keeping them relative
    //    means one slider set drives both a lawn tuft and a floppy meadow clump sensibly. ──
    bladeCurve: number;   // droop arc of each blade (0 = upright spikes, 1 = flopped right over)
    bladeTwist: number;   // rotation along the spine — the light-catch shimmer
    bladeFold: number;    // V cross-section depth (a real blade is folded, not flat)
    /** Distance LOD for the blade archetypes: 0 near/full · 1 mid · 2 far (fewer blades). */
    bladeLod: number;
    // ── FLOWER archetypes only (`daisy` / `rapeseed` / `lavender` / `flower-bed`, §3.2 + §3.3). All
    //    OPTIONAL: leaving one out uses that archetype's own recipe value, which is what makes rapeseed
    //    read as rapeseed out of the box. Set one and it overrides for every stalk in the plant. ──
    /** Petal colour. Default = the archetype's signature (daisy white · rapeseed yellow · lavender violet). */
    petalColor?: [number, number, number];
    /** Disc / eye colour (§3.2 `centerColor`). */
    centerColor?: [number, number, number];
    /** Petals per whorl row (§3.2 `count`). */
    petalCount?: number;
    /** Stacked whorl rows (§3.2 `rows`) — 2 stops a flower reading as a paper cut-out. */
    petalRows?: number;
    /** ★ Bloom state, 0..1 → 0 = a closed bud · ~0.55 = flat open · 1 = fully reflexed (§3.2 `pitch`). */
    petalPitch?: number;
    /** Petal silhouette (§3.2 `shape`). */
    petalShape?: PetalShape;
    /** ★ FRACTION 0..1 up the stem where florets begin (§3.3). */
    bloomStart?: number;
    /** FRACTION 0..1 where they stop (1 = to the very tip). */
    bloomEnd?: number;
    /** Florets per METRE of the bloom band. */
    bloomDensity?: number;
    /** ★ 0 = every floret the same size · 1 = the apex shrinks to a bud (how rapeseed actually looks). */
    bloomScaleCurve?: number;
    /** Recursive side stalks (rapeseed / lavender). */
    branches?: number;
    /** Distance LOD for the flower archetypes: 0 near/full · 1 mid · 2 far (fewer florets AND petals). */
    flowerLod?: number;
    // ── RUNNER / CLIMBER archetypes only (`ivy` / `vine`, §3.4 + P3). ★ TWO PATH SOURCES, ONE MODEL:
    //    `area` auto-seeds runners over a host region and GROWS them (crawl · cling · branch · hang);
    //    `path` takes an explicit 3D point list (the Ribbon-style authoring) as the runner centreline.
    //    Everything downstream — stem sweep, leaf distribution, droop, LOD — is the SAME codepath, which
    //    is why these are params on one type rather than two types. All OPTIONAL: omitted = the
    //    archetype's own recipe value. ──
    /** ★ Which path source feeds the growth model. Default `'area'`. */
    ivyMode?: 'area' | 'path';
    /** `path` mode: the authored centreline, in metres, in the plant's local space. */
    ivyPath?: [number, number, number][];
    /** `path` mode: the outward direction leaves face (default `[0,0,1]`, the wall-face convention). */
    ivyPathNormal?: [number, number, number];
    /** ★ AREA WIDTH (m) — defaults to `width`. The host region the runners crawl over. */
    areaWidth?: number;
    /** ★ AREA HEIGHT (m) — defaults to `size`. */
    areaHeight?: number;
    /** ★ LEAF DENSITY 0..1 — THE continuum knob: low = visible woody runners on bare wall, high = a leaf carpet. */
    leafDensity?: number;
    /** How much of the region is covered — drives the frontier mask (sparse, fingered edges). */
    coverage?: number;
    /** Seed runners over the region (before branching). */
    runnerCount?: number;
    /** Centreline length budget per runner (m). */
    runnerLength?: number;
    /** Crawl step (m). */
    runnerStep?: number;
    /** Probability per step of a side branch (in `path` mode: side branches per path segment). */
    branchChance?: number;
    /** −1 = trail DOWN · 0 = crawl ALONG · +1 = climb UP the host. */
    growthBias?: number;
    /** Random walk per step. */
    wander?: number;
    /** Leaf spacing along a runner (m). */
    leafSpacing?: number;
    leafSize?: number;
    leafSizeVar?: number;
    /** Gravity droop of each leaf, 0..1. */
    leafDroop?: number;
    /** Leaf arrangement along the runner. */
    phyllotaxy?: Phyllotaxy;
    /** Woody runner colour (climbers show their stems where the leaves are sparse). */
    stemColor?: [number, number, number];
    /** Distance LOD for the climber archetypes: 0 near/full · 1 mid · 2 far (fewer leaves). */
    runnerLod?: number;
    // ── WOODY / BRANCH archetypes only (`bush` · `shrub` · `hedge` · `small-tree`, §3.5 + P4). All
    //    OPTIONAL: omitted = that archetype's own recipe value (a `small-tree` looks like a tree with no
    //    panel work). These replace the old "one blob on a stick" construction with real recursive limbs
    //    carrying leaf masses AT THE TIPS. `hedge` ignores the limb knobs — it is a clipped SHELL. ──
    /** ★ Recursion depth: 0 = a bare trunk · 1 = trunk + limbs · 3 = trunk → limbs → branches → twigs. */
    branchLevels?: number;
    /** Children thrown by each limb (2–4). Total limbs ≈ `stemCount × Σ splitCount^level`. */
    branchSplit?: number;
    /** Radians a child leaves its parent by (≈0.5–0.9). */
    branchSplitAngle?: number;
    /** ★ 0..1 sideways bend of each limb's own spine — branches are not straight. */
    branchGnarl?: number;
    /** 0..1 how hard limbs curve back toward the light (most of a tree's silhouette). */
    branchUpBias?: number;
    /** ★ Stems fanning from the BASE: 1 = a single trunk (tree/shrub), 4–7 = a multi-stem bush. */
    stemCount?: number;
    /** Leaf-mass radius at each twig tip (m). */
    clusterSize?: number;
    /** ★ 0..1 how far each leaf mass deviates from a SPHERE — the anti-lollipop knob. */
    canopyIrregular?: number;
    /** ★ 0..1 probability a tip is left BARE — the see-through gaps into a shadowed interior. */
    leafGaps?: number;
    /** `hedge` only: shoots that have escaped the clipped plane. */
    hedgeSprigs?: number;
    /** `hedge` only: corner rounding of the clipped box (m). */
    hedgeRound?: number;
    /** Distance LOD for the woody archetypes: 0 near/full · 1 mid · 2 far (fewer limbs AND leaves). */
    branchLod?: number;
    // ── VESSEL archetypes only (`potted` · `planter` · `window-box`, §4 vessel types, phase P4v). These
    //    are ARRANGEMENTS: a vessel + soil + a small composition of identifiable plants (focal · filler ·
    //    trailing), not a vessel + one green ball. All OPTIONAL — omitted = the vessel's own recipe. ──
    /** ★ How many plants the arrangement places (before the LOD scale + the 10-plant cap). */
    plantCount?: number;
    /** ★ 0..1 — how far the TRAILING plants spill below the rim. `0` = no trailing plants at all;
     *  it is the signature of a window box, so it defaults high there. */
    spill?: number;
    /** Soil colour (the disc/slab that stops you seeing into an empty vessel). */
    soilColor?: [number, number, number];
    /** Distance LOD for the vessel archetypes: 0 near/full · 1 mid · 2 far (fewer plants AND leaves). */
    plantLod?: number;
}

export interface FoliageMeta { footprint: V2[]; height: number; type: FoliageType; }

export const DEFAULT_FOLIAGE_PARAMS: FoliageParams = {
    type: 'bush', seed: 1, size: 1.2, width: 1.0, density: 0.6, render: 'chunky', celShade: false, bloom: false, potMaterial: 'terracotta',
    foliageColor: [0.28, 0.46, 0.2], tipColor: [0.44, 0.62, 0.3], bloomColor: [0.92, 0.42, 0.5],
    potColor: [0.55, 0.32, 0.22], trunkColor: [0.34, 0.24, 0.16],
    bladeCurve: 0.5, bladeTwist: 0.5, bladeFold: 0.5, bladeLod: 0,
};

export function resolveFoliageParams(partial: Partial<FoliageParams> = {}): FoliageParams {
    return { ...DEFAULT_FOLIAGE_PARAMS, ...partial };
}

interface FA {
    leaf: Accum3D; tip: Accum3D; bloom: Accum3D; vessel: Accum3D; trunk: Accum3D; center: Accum3D;
    // ── RUNNER channels (P3): the woody climbing stem, plus the FREE / HANGING half of every channel.
    //    The free split exists for the WIND (see the emission block at the end of buildFoliage): attached
    //    ivy barely moves where it clings and moves most at its unattached tips.
    stem: Accum3D; stemFree: Accum3D; leafFree: Accum3D; tipFree: Accum3D;
    /** VESSEL channel (P4v): the soil surface under a planted pot / planter / window box. */
    soil: Accum3D;
}

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

/** The BLADE archetype recipes (foliage-quality.md §4). `grass-tuft` = a dense lawn/meadow clump of
 *  30–60 short upright blades; `tall-grass` = the NTE meadow read — taller, floppier, WIDER blades and
 *  FEWER of them per clump. The three `blade*` params are relative knobs (0.5 = this archetype's default). */
function bladeTuftSpec(p: FoliageParams, s: number, dens: number): BladeTuftSpec {
    const tall = p.type === 'tall-grass';
    const k = (v: number): number => Math.max(0, (Number.isFinite(v) ? v : 0.5)) / 0.5;   // 0.5 → ×1
    return {
        blades: Math.round(tall ? 14 + dens * 14 : 30 + dens * 30),   // §4: grass 30–60 · tall-grass fewer
        radius: s * (tall ? 0.2 : 0.3),
        length: s * (tall ? 0.95 : 0.78),
        lengthVar: tall ? 0.3 : 0.35,
        width: s * (tall ? 0.05 : 0.028),                              // tall grass = wider, floppier straps
        taper: tall ? 0.86 : 0.94,
        curve: (tall ? 0.62 : 0.3) * k(p.bladeCurve),
        curveVar: 0.45,
        segments: tall ? 6 : 5,
        twist: (tall ? 1.25 : 0.85) * k(p.bladeTwist),
        twistVar: 0.5,
        foldAngle: (tall ? 0.38 : 0.5) * k(p.bladeFold),
        lean: tall ? 0.5 : 0.32,
        leanVar: 0.35,
        tipStart: 0.6,                                                 // upper 40% takes the lighter tip colour
        lodLevel: p.bladeLod,
    };
}

// ── The FLOWER archetype recipes (foliage-quality.md §4, phase P2) ───────────────────────────────
// Composition, not new code paths: each is a `stalk` (§3.3) whose florets are small `whorl`s (§3.2).
// The whole species read comes out of four numbers — bloomStart, bloomDensity, bloomScaleCurve and
// branches — which is exactly the claim the spec makes.
export type FlowerType = 'daisy' | 'rapeseed' | 'lavender' | 'flower-bed';
interface FlowerRecipe {
    petal: [number, number, number];
    center: [number, number, number];
    /** `s` = plant size (m), `d` = density 0..1. */
    spec: (s: number, d: number) => Partial<StalkSpec>;
}

const FLOWER_RECIPES: Record<FlowerType, FlowerRecipe> = {
    // Short stalk, ONE terminal head (bloomStart ≈0.95), 13–21 white rays around a yellow disc.
    'daisy': {
        petal: [0.96, 0.95, 0.92], center: [0.98, 0.82, 0.18],
        spec: (s, d) => ({
            height: s * 0.88, thickness: s * 0.012, curve: 0.3, segments: 5, sides: 4,
            bloomStart: 0.95, bloomEnd: 1, bloomDensity: 12, bloomScaleCurve: 0, pedicel: 0.08,
            terminalCluster: false, branches: 0,
            leaves: 3 + Math.round(d * 3), leafStart: 0.03, leafEnd: 0.3,
            leafLength: s * 0.2, leafWidth: s * 0.055, leafShape: 'pointed',
            floret: {
                count: 13 + Math.round(d * 8), rows: 2, rowOffset: 0.5, elementLength: s * 0.15, elementWidth: s * 0.028,
                lengthVar: 0.1, shape: 'rounded', pitch: 1.35, pitchVar: 0.15, rowPitch: -0.3, rowScale: 0.86, rowLift: 0.05,
                curve: 0.28, twist: 0.16, fold: 0.18, segments: 3, centerRadius: s * 0.042, centerDome: 0.6, centerSides: 8,
            },
        }),
    },
    // ★ The user's example. Branching raceme: florets from 0.55 up, SHRINKING to buds at each apex,
    // with a dense terminal cluster — that scale curve is the whole "this is rapeseed" signal.
    'rapeseed': {
        petal: [0.98, 0.85, 0.16], center: [0.85, 0.66, 0.1],
        spec: (s, d) => ({
            height: s * 0.95, thickness: s * 0.018, curve: 0.2, segments: 6, sides: 4,
            bloomStart: 0.55, bloomEnd: 1, bloomDensity: 26, bloomScaleCurve: 0.72, pedicel: 1.1,
            terminalCluster: true, terminalCount: 5,
            branches: 3 + Math.round(d * 2), branchAngle: 0.55, branchStart: 0.28, branchDecay: 0.52,
            leaves: 3 + Math.round(d * 3), leafStart: 0.06, leafEnd: 0.5,
            leafLength: s * 0.2, leafWidth: s * 0.07, leafShape: 'pointed',
            floret: {
                count: 4, rows: 1, rowOffset: 0.5, elementLength: s * 0.034, elementWidth: s * 0.022,
                lengthVar: 0.14, shape: 'rounded', pitch: 1.15, pitchVar: 0.22, rowPitch: 0, rowScale: 1, rowLift: 0,
                curve: 0.2, twist: 0.1, fold: 0.2, segments: 2, centerRadius: s * 0.007, centerDome: 0.7, centerSides: 5,
            },
        }),
    },
    // Dense, NARROW spike: no branches, tiny 5-petal florets from 0.6 up, mild shrink to the tip.
    'lavender': {
        petal: [0.55, 0.38, 0.78], center: [0.4, 0.28, 0.6],
        spec: (s, d) => ({
            height: s * 0.92, thickness: s * 0.01, curve: 0.28, segments: 6, sides: 3,
            bloomStart: 0.6, bloomEnd: 1, bloomDensity: 62, bloomScaleCurve: 0.5, pedicel: 0.3,
            terminalCluster: true, terminalCount: 4, branches: 0,
            leaves: 4 + Math.round(d * 4), leafStart: 0.04, leafEnd: 0.42,
            leafLength: s * 0.16, leafWidth: s * 0.022, leafShape: 'strap',
            floret: {
                count: 5, rows: 1, rowOffset: 0.5, elementLength: s * 0.022, elementWidth: s * 0.012,
                lengthVar: 0.18, shape: 'pointed', pitch: 0.85, pitchVar: 0.25, rowPitch: 0, rowScale: 1, rowLift: 0,
                curve: 0.3, twist: 0.12, fold: 0.25, segments: 2, centerRadius: s * 0.005, centerDome: 0.7, centerSides: 4,
            },
        }),
    },
    // The PATCH: many short daisy-like stalks over the spread (each stalk is placed by buildFoliage).
    'flower-bed': {
        petal: [0.92, 0.42, 0.5], center: [0.98, 0.82, 0.18],
        spec: (s, d) => ({
            height: s * 0.5, thickness: s * 0.009, curve: 0.4, segments: 4, sides: 3,
            bloomStart: 0.93, bloomEnd: 1, bloomDensity: 12, bloomScaleCurve: 0, pedicel: 0.08,
            terminalCluster: false, branches: 0,
            leaves: 2 + Math.round(d * 2), leafStart: 0.05, leafEnd: 0.35,
            leafLength: s * 0.13, leafWidth: s * 0.04, leafShape: 'pointed',
            floret: {
                count: 7 + Math.round(d * 5), rows: 1, rowOffset: 0.5, elementLength: s * 0.075, elementWidth: s * 0.026,
                lengthVar: 0.2, shape: 'rounded', pitch: 1.25, pitchVar: 0.22, rowPitch: 0, rowScale: 1, rowLift: 0,
                curve: 0.3, twist: 0.15, fold: 0.2, segments: 3, centerRadius: s * 0.02, centerDome: 0.6, centerSides: 6,
            },
        }),
    },
};

/** Fold the (optional) host overrides onto an archetype recipe — undefined always means "keep the recipe". */
function flowerStalkSpec(type: FlowerType, p: FoliageParams, s: number, d: number): StalkSpec {
    const base = FLOWER_RECIPES[type].spec(s, d);
    const floret: Partial<WhorlSpec> = { ...(base.floret ?? {}) };
    if (p.petalCount !== undefined) floret.count = Math.max(3, Math.round(p.petalCount));
    if (p.petalRows !== undefined) floret.rows = Math.max(1, Math.round(p.petalRows));
    if (p.petalPitch !== undefined) floret.pitch = Math.max(0, p.petalPitch) * 2.4;   // 0 = bud · 1 = reflexed
    if (p.petalShape !== undefined) floret.shape = p.petalShape;
    return resolveStalk({
        ...base, floret,
        ...(p.bloomStart !== undefined ? { bloomStart: p.bloomStart } : {}),
        ...(p.bloomEnd !== undefined ? { bloomEnd: p.bloomEnd } : {}),
        ...(p.bloomDensity !== undefined ? { bloomDensity: p.bloomDensity } : {}),
        ...(p.bloomScaleCurve !== undefined ? { bloomScaleCurve: p.bloomScaleCurve } : {}),
        ...(p.branches !== undefined ? { branches: Math.max(0, Math.round(p.branches)) } : {}),
        lodLevel: p.flowerLod ?? 0,
    });
}

// ── The CLIMBER archetype recipes (foliage-quality.md §4 "ivy wall", phase P3) ───────────────────
// `ivy` = a dense wall cover: many short, strongly climbing runners with small close-packed leaves.
// `vine` = fewer, longer, wandering runners with bigger, sparser, droopier leaves — the same primitive,
// different numbers (that is the whole point of a recipe-over-primitives architecture).
export type RunnerType = 'ivy' | 'vine';
interface RunnerRecipe {
    /** Pale woody runner colour — visible ivy stems are grey-brown, not bark-dark. */
    stem: [number, number, number];
    /** `s` = area height (m), `w` = area width (m), `d` = density 0..1. */
    spec: (s: number, w: number, d: number) => Partial<RunnerSpec>;
}

const RUNNER_RECIPES: Record<RunnerType, RunnerRecipe> = {
    'ivy': {
        stem: [0.46, 0.4, 0.32],
        spec: (s, w, d) => ({
            // maxLength is tuned so a typical runner spends MOST of its life clinging and only the last
            // stretch hangs over the top — an ivy wall with a fringe, not a curtain (see §8 P3).
            runnerCount: Math.round(4 + d * 8 + w * 1.2), maxLength: s * 1.0 + w * 0.25, stepSize: 0.085,
            branchChance: 0.055, branchAngle: 0.75, branchDecay: 0.55, branchDepth: 1,
            growthBias: 0.85, wander: 0.55, coverage: 0.4 + d * 0.55, frontier: 0.12,
            clingOffset: 0.02, hangGravity: 0.35, hangDrift: 0.25, thickness: 0.007, sides: 3,
            leafSpacing: 0.07, leafDensity: 0.35 + d * 0.6, leafSize: 0.075, leafSizeVar: 0.28,
            tipScale: 0.3, ageSpan: 0.45, newGrowth: 0.28, droop: 0.4, leafLift: 0.2,
            phyllotaxy: 'alternate', leafShape: 'palmate', leafCurve: 0.35, leafFold: 0.14, leafTwist: 0.25,
        }),
    },
    'vine': {
        stem: [0.4, 0.34, 0.25],
        spec: (s, w, d) => ({
            runnerCount: Math.round(3 + d * 4 + w * 0.8), maxLength: s * 1.35 + w * 0.35, stepSize: 0.1,
            branchChance: 0.03, branchAngle: 0.6, branchDecay: 0.6, branchDepth: 1,
            growthBias: 0.55, wander: 0.8, coverage: 0.32 + d * 0.5, frontier: 0.14,
            clingOffset: 0.025, hangGravity: 0.45, hangDrift: 0.3, thickness: 0.009, sides: 3,
            leafSpacing: 0.115, leafDensity: 0.3 + d * 0.55, leafSize: 0.09, leafSizeVar: 0.3,
            tipScale: 0.28, ageSpan: 0.5, newGrowth: 0.35, droop: 0.6, leafLift: 0.28,
            phyllotaxy: 'alternate', leafShape: 'pointed', leafCurve: 0.45, leafFold: 0.12, leafTwist: 0.3,
        }),
    },
};

/** Fold the (optional) host overrides onto a climber recipe — undefined always means "keep the recipe". */
function runnerSpecFor(type: RunnerType, p: FoliageParams, s: number, w: number, d: number): RunnerSpec {
    const base = RUNNER_RECIPES[type].spec(s, w, d);
    return resolveRunner({
        ...base,
        ...(p.runnerCount !== undefined ? { runnerCount: Math.max(1, Math.round(p.runnerCount)) } : {}),
        ...(p.runnerLength !== undefined ? { maxLength: Math.max(0.05, p.runnerLength) } : {}),
        ...(p.runnerStep !== undefined ? { stepSize: Math.max(0.01, p.runnerStep) } : {}),
        ...(p.branchChance !== undefined ? { branchChance: Math.max(0, p.branchChance) } : {}),
        ...(p.growthBias !== undefined ? { growthBias: p.growthBias } : {}),
        ...(p.wander !== undefined ? { wander: Math.max(0, p.wander) } : {}),
        ...(p.coverage !== undefined ? { coverage: p.coverage } : {}),
        ...(p.leafDensity !== undefined ? { leafDensity: p.leafDensity } : {}),
        ...(p.leafSpacing !== undefined ? { leafSpacing: Math.max(0.005, p.leafSpacing) } : {}),
        ...(p.leafSize !== undefined ? { leafSize: Math.max(0.002, p.leafSize) } : {}),
        ...(p.leafSizeVar !== undefined ? { leafSizeVar: Math.max(0, p.leafSizeVar) } : {}),
        ...(p.leafDroop !== undefined ? { droop: Math.max(0, p.leafDroop) } : {}),
        ...(p.phyllotaxy !== undefined ? { phyllotaxy: p.phyllotaxy } : {}),
        lodLevel: p.runnerLod ?? 0,
    });
}

// ── The WOODY archetype recipes (foliage-quality.md §4 "bush / hedge", §3.5, phase P4) ──────────────
// Composition, not new code paths: `bush` · `shrub` · `small-tree` are all ONE `branch` skeleton +
// ONE `canopy` of tip clusters, differing only in numbers (stems vs trunk, how many levels, how big
// the masses are). `hedge` is the odd one out on purpose — a manicured hedge is a clipped SHELL, not
// a plant with a silhouette, so it uses `emitHedgeShell` and has no visible limb structure at all.
export type WoodyType = 'bush' | 'shrub' | 'hedge' | 'small-tree';

/** The leaf a woody type carries. `card` render ⇒ REAL swept `emitBlade` leaves; `chunky` ⇒ blobs. */
function woodyLeaf(s: number, k: number, shape: LeafGeom['shape']): LeafGeom {
    return { ...DEFAULT_LEAF, length: s * k, lengthVar: 0.34, width: s * k * 0.62, shape, curve: 0.45, fold: 0.2, twist: 0.35, segments: 3, pitch: 1.0, pitchVar: 0.55 };
}

interface WoodyRecipe { branch: Partial<BranchSpec>; canopy: Partial<CanopySpec> }

/** `s` = plant size (m), `d` = density 0..1. */
const WOODY_RECIPES: Record<'bush' | 'shrub' | 'small-tree', (s: number, d: number) => WoodyRecipe> = {
    // ★ MULTI-STEM FAN. A real bush has several stems leaving the base and a leaf mass with an
    // IRREGULAR outline, denser at the top/outside, with gaps you see through to a shadowed interior.
    'bush': (s, d) => ({
        branch: {
            levels: 1, splitCount: 2, splitCountVar: 1, splitAngle: 0.6, splitAngleVar: 0.35,
            lengthDecay: 0.58, radiusDecay: 0.62, length: s * 0.47, lengthVar: 0.28,
            startRadius: s * 0.022, tipTaper: 0.55, gnarl: 0.5, wander: 0.4, upBias: 0.6,
            lean: 0, attachStart: 0.45, segments: 4, sides: 4,
            stems: Math.round(4 + d * 3), stemAngle: 0.44, stemSpread: s * 0.1,
        },
        canopy: { radius: s * 0.21, irregular: 0.62, flatten: 0.82, gapChance: 0.14, innerGap: 0.4, innerScale: 0.55, sizeVar: 0.4, tipPush: 0.3 },
    }),
    // Bush-like, but with a VISIBLE SHORT WOODY BASE → limbs → clusters (that base is the whole
    // difference between a shrub and a bush, and the old version expressed it as a bare beam).
    'shrub': (s, d) => ({
        branch: {
            levels: 2, splitCount: 3, splitCountVar: 1, splitAngle: 0.6, splitAngleVar: 0.35,
            lengthDecay: 0.62, radiusDecay: 0.6, length: s * 0.34, lengthVar: 0.24,
            startRadius: s * 0.03, tipTaper: 0.5, gnarl: 0.42, wander: 0.42, upBias: 0.52,
            lean: 0.05, attachStart: 0.55, segments: 4, sides: 4, stems: 1,
        },
        canopy: { radius: s * (0.2 + d * 0.04), irregular: 0.58, flatten: 0.85, gapChance: 0.12, innerGap: 0.35, innerScale: 0.6, sizeVar: 0.38, tipPush: 0.3 },
    }),
    // ★ THE HEADLINE FIX. A tree reads as a tree because of RECURSIVE BRANCHING with leaf masses at
    // the TIPS of the outer twigs — not one central ball on a stick. Tapered, gnarled, leaning trunk →
    // 3–5 main limbs → 2 more levels of sub-branching → clusters only at the terminal twigs.
    'small-tree': (s, d) => ({
        branch: {
            levels: 3, splitCount: 3, splitCountVar: 1, splitAngle: 0.46, splitAngleVar: 0.4,
            lengthDecay: 0.62, radiusDecay: 0.58, length: s * 0.5, lengthVar: 0.26,
            startRadius: s * 0.038, tipTaper: 0.6, gnarl: 0.45, wander: 0.42, upBias: 0.6,
            lean: 0.09, attachStart: 0.42, segments: 5, sides: 5, stems: 1,
        },
        canopy: { radius: s * (0.15 + d * 0.05), irregular: 0.6, flatten: 0.9, gapChance: 0.13, innerGap: 0.42, innerScale: 0.55, sizeVar: 0.42, tipPush: 0.35 },
    }),
};

/** Fold the (optional) host overrides onto a woody recipe — undefined always means "keep the recipe". */
function woodySpecFor(type: 'bush' | 'shrub' | 'small-tree', p: FoliageParams, s: number, d: number, card: boolean): { branch: BranchSpec; canopy: CanopySpec } {
    const rec = WOODY_RECIPES[type](s, d);
    const lod = Math.max(0, Math.round(p.branchLod ?? 0));
    const branch = resolveBranch({
        ...rec.branch,
        ...(p.branchLevels !== undefined ? { levels: Math.max(0, Math.round(p.branchLevels)) } : {}),
        ...(p.branchSplit !== undefined ? { splitCount: Math.max(1, Math.round(p.branchSplit)) } : {}),
        ...(p.branchSplitAngle !== undefined ? { splitAngle: Math.max(0.02, p.branchSplitAngle) } : {}),
        ...(p.branchGnarl !== undefined ? { gnarl: Math.max(0, p.branchGnarl) } : {}),
        ...(p.branchUpBias !== undefined ? { upBias: Math.max(0, p.branchUpBias) } : {}),
        ...(p.stemCount !== undefined ? { stems: Math.max(1, Math.round(p.stemCount)) } : {}),
        lodLevel: lod,
    });
    const canopy: CanopySpec = {
        ...DEFAULT_CANOPY, ...rec.canopy,
        density: d, tipFrac: 0.32, mode: card ? 'blade' : 'chunky',
        leaf: woodyLeaf(s, type === 'small-tree' ? 0.075 : 0.09, type === 'small-tree' ? 'pointed' : 'palmate'),
        ...(p.clusterSize !== undefined ? { radius: Math.max(0.01, p.clusterSize) } : {}),
        ...(p.canopyIrregular !== undefined ? { irregular: Math.max(0, p.canopyIrregular) } : {}),
        ...(p.leafGaps !== undefined ? { gapChance: Math.max(0, p.leafGaps) } : {}),
        lodLevel: lod,
    };
    return { branch, canopy };
}

/** The hedge's clipped-box shell (§4 P4). `w` = RUN LENGTH along X. */
function hedgeShellSpec(p: FoliageParams, s: number, w: number, d: number, card: boolean): HedgeShellSpec {
    const H = Math.min(1.2, s * 0.85), D = Math.min(0.6, s * 0.5) * 2;
    return {
        ...DEFAULT_HEDGE_SHELL,
        width: w, height: H, depth: D,
        round: p.hedgeRound !== undefined ? Math.max(0, p.hedgeRound) : Math.min(0.14, H * 0.16),
        // Blade mode needs many elements to read as a leafy SURFACE (they are 2-segment, 8-tri leaves);
        // chunky mode covers the shell with a few big low-poly clumps. Chunky is ~25–35 % CHEAPER than
        // the old solid row of mounds because a shell costs AREA, not volume.
        leafDensity: card ? 40 + d * 34 : 10 + d * 7,
        irregular: 0.018 + d * 0.02,
        sprigs: p.hedgeSprigs !== undefined ? Math.max(0, Math.round(p.hedgeSprigs)) : Math.round(3 + w * 1.6 + d * 3),
        sprigLength: Math.min(0.26, H * 0.22),
        tipFrac: 0.26, mode: card ? 'blade' : 'chunky',
        // 2-segment leaves: a clipped hedge leaf is 10 cm across and lies flat — nobody sees its arc.
        leaf: { ...woodyLeaf(s, card ? 0.09 : 0.14, 'rounded'), segments: 2, curve: 0.3 },
        core: true,
        lodLevel: Math.max(0, Math.round(p.branchLod ?? 0)),
    };
}

// ── The VESSEL archetype recipes (foliage-quality.md §4 "vessel types", phase P4v) ──────────────────
// ★ The vessel SHAPES were never the problem — a `potShape` frustum and an `obox` are exactly right, and
// they are kept verbatim. What was wrong was the PLANTING: all three types were "vessel + ONE
// `foliageClump` blob + `foliageBloom` sphere specks", i.e. a green ball in a pot. They are now
// ARRANGEMENTS (planting.ts): soil + a focal plant + filler + trailing plants, each composed from the
// P1–P4 primitives. `foliageBloom` is KEPT — building-parts.ts still uses it for berry specks.
export type VesselType = 'planter' | 'potted' | 'window-box';

/** Route the planting channels onto the foliage accumulators. */
function plantAcc(A: FA): PlantingAccum {
    return {
        woody: A.trunk, leaf: A.leaf, tip: A.tip, petal: A.bloom, centre: A.center,
        stem: A.stem, stemFree: A.stemFree, leafFree: A.leafFree, tipFree: A.tipFree, soil: A.soil,
    };
}

/** Fold the (optional) host overrides onto a vessel's arrangement recipe. */
function vesselPlanting(
    p: FoliageParams, layout: PlantingSpec['layout'], height: number, dens: number, card: boolean,
    spill: number, spillDir: [number, number], spillSpread: number, focal?: PlantKind,
): PlantingSpec {
    return {
        layout, density: dens, height, bloom: p.bloom, card, spill, spillDir, spillSpread,
        ...(focal !== undefined ? { focal } : {}),
        ...(p.plantCount !== undefined ? { plants: Math.max(1, Math.round(p.plantCount)) } : {}),
        lodLevel: Math.max(0, Math.round(p.plantLod ?? 0)),
        maxPlants: MAX_PLANTS_PER_VESSEL, maxLeaves: MAX_VESSEL_LEAVES,
    };
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
    const A: FA = {
        leaf: new Accum3D(), tip: new Accum3D(), bloom: new Accum3D(), vessel: new Accum3D(), trunk: new Accum3D(), center: new Accum3D(),
        stem: new Accum3D(), stemFree: new Accum3D(), leafFree: new Accum3D(), tipFree: new Accum3D(),
        soil: new Accum3D(),
    };
    const meta: FoliageMeta = { footprint: box(0.5, 0.5), height: p.size, type: p.type };
    const dens = Math.max(0, Math.min(1, p.density));
    const s = Math.max(0.2, p.size), w = Math.max(0.3, p.width);
    const card = p.render === 'card';
    const spillK = Math.max(0, Math.min(1, p.spill ?? 0.5));   // vessel types: how far the trailing plants hang
    /** Hang depth (m) for a vessel's trailing plants. ★ `spill: 0` means NO trailing plants at all. */
    const spillOf = (base: number, span: number): number => (spillK <= 0 ? 0 : base + spillK * span);
    let spillLow = 0;                                          // lowest Y the hanging (free) geometry reaches
    // `foliageBloom` berry/blossom SPECKS survive only on the woody + hedge + climber types. The three
    // VESSEL types dropped them in P4v: their `bloom` now drives real `whorl` flower heads on the
    // planted stalks instead (§5). `foliageClump` / `foliageBloom` themselves stay exported —
    // building-parts.ts still builds its attached greenery out of both.
    const blooms = (cx: number, cy: number, cz: number, spread: number, n = 8): void => { if (p.bloom) foliageBloom(A.bloom, rnd, cx, cy, cz, spread, n); };

    switch (p.type) {
        case 'conifer': {
            // ★ The one archetype the `branch` primitive genuinely cannot reach. `branch` grows a
            // broadleaf — a gnarled trunk that dissolves into up-curving limbs with leaf masses at the
            // twig tips. A conifer keeps ONE unbroken leader to the apex and carries its branches in
            // WHORLS that angle down and shrink toward the top. Narrowing a small-tree gets you a thin
            // broadleaf, not an evergreen, which is what the city's stand-in was. See conifer.ts.
            const H = Math.max(0.4, s);
            const cres = emitConifer(A.trunk, A.leaf, A.tip, [0, 0, 0], resolveConifer({
                height: H,
                spread: p.coniferSpread ?? 0.2,
                tiers: p.coniferTiers ?? Math.max(4, Math.round(4 + H * 0.5)),
                perTier: Math.max(3, Math.round(5 + dens * 4)),
                needleDensity: dens,
                droop: p.coniferDroop ?? 0.42,
                trunkRadius: H * 0.012,
                sides: card ? 4 : 3,
            }), rnd);
            meta.height = cres.height;
            meta.footprint = box(cres.radius, cres.radius);
            blooms(0, cres.height * 0.6, 0, cres.radius * 0.6, 5);
            break;
        }
        case 'bush': case 'shrub': case 'small-tree': {
            // REBUILT in P4 on the `branch` primitive (foliage-quality.md §3.5). These were the last
            // three types on the old construction — `bush` was ONE flattened `foliageClump` sphere,
            // `shrub` a beam + one clump, and `small-tree` a beam + one blob (a lollipop). Now: a real
            // recursive limb skeleton, and the leaf masses live AT THE TIPS of the outer twigs, with an
            // irregular envelope + gaps. Same type names, so existing scenes and saves upgrade on reload.
            const rec = woodySpecFor(p.type, p, s, dens, card);
            const bres = emitBranch(A.trunk, rec.branch, { base: [0, 0, 0] }, rnd);
            const cres = emitCanopy(A.leaf, A.tip, bres.tips, rec.canopy, rnd, [0, 0, 0], leafBudget(MAX_LEAVES_PER_PLANT));
            meta.height = Math.max(0.05, Math.max(bres.height, cres.height));
            const rad = Math.max(0.05, Math.max(bres.radius, cres.radius));
            meta.footprint = box(rad, rad);
            blooms(0, meta.height * 0.78, 0, rad * 0.72, p.type === 'small-tree' ? 8 : 10);
            break;
        }
        case 'hedge': {
            // REBUILT in P4 as a CLIPPED SHELL (foliage-quality.md §3.5 / P4). It used to be a ROW OF
            // SPHERES (one `mound` per segment) — exactly the wrong read for something manicured. A
            // hedge is a flat-cut boxy silhouette with a dense leafy SURFACE, so the leaves live on the
            // SHELL of a rounded box (top + 4 sides), the interior is one cheap dark core box, and a few
            // sprigs escape the clipped plane. Cost scales with AREA, not volume — that is the perf win.
            const spec = hedgeShellSpec(p, s, w, dens, card);
            const hres = emitHedgeShell(A.leaf, A.tip, spec, rnd, leafBudget(MAX_LEAVES_PER_PLANT));
            meta.height = Math.max(0.05, hres.height);
            meta.footprint = box(Math.max(w / 2, hres.halfX), hres.halfZ);
            blooms(0, spec.height * 0.9, 0, w * 0.4, Math.round(4 + w * 3));
            break;
        }
        case 'grass-tuft': case 'tall-grass': {
            // Real BLADES (foliage-quality.md §3.1/§4) — a radial clump of curved, tapered, twisted,
            // FOLDED strips. The cone path this replaced had no curve, no point and one flat normal field.
            const spec = bladeTuftSpec(p, s, dens);
            const r = bladeTuft(A.leaf, A.tip, spec, rnd);
            meta.height = Math.max(0.05, r.height);
            meta.footprint = box(spec.radius * 1.6, spec.radius * 1.6); break;
        }
        case 'daisy': case 'rapeseed': case 'lavender': {
            // ONE stalk (foliage-quality.md §3.3): stem + lower leaves → leaf, florets → bloom + center.
            const acc: StalkAccum = { stem: A.leaf, leaf: A.leaf, petal: A.bloom, centre: A.center };
            const r = emitStalk(acc, flowerStalkSpec(p.type, p, s, dens), { base: [0, 0, 0] }, rnd);
            meta.height = Math.max(0.05, r.height);
            meta.footprint = box(Math.max(0.05, r.radius * 1.1), Math.max(0.05, r.radius * 1.1)); break;
        }
        case 'flower-bed': {
            // REBUILT in P2: a patch of REAL stalks + whorls (it used to be `foliageBloom` spheres over a
            // flattened leaf mound — no petals, no stem, no floret structure). Same type name, so every
            // existing scene/save upgrades on reload.
            const R = Math.max(w, s) * 0.45;
            const n = Math.max(3, Math.round(4 + dens * 8 + w * 2));
            const spec = flowerStalkSpec('flower-bed', p, s, dens);
            const acc: StalkAccum = { stem: A.leaf, leaf: A.leaf, petal: A.bloom, centre: A.center };
            let top = 0, reach = 0;
            for (let i = 0; i < n; i++) {
                const a = i * Math.PI * (3 - Math.sqrt(5)) + rnd() * 0.6;
                const rr = R * Math.sqrt((i + 0.5) / n) * (0.6 + rnd() * 0.5);
                const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
                const lean = 0.18 + rnd() * 0.22;                       // stalks splay out from the patch
                const axis: V3 = [Math.cos(a) * lean, 1, Math.sin(a) * lean];
                const r = emitStalk(acc, { ...spec, height: spec.height * (0.72 + rnd() * 0.56) }, { base: [bx, 0, bz], axis }, rnd);
                top = Math.max(top, r.height);
                reach = Math.max(reach, Math.hypot(bx, bz) + r.radius);
            }
            meta.height = Math.max(0.05, top);
            meta.footprint = box(Math.max(w / 2, reach), Math.max(s / 2, reach)); break;
        }
        case 'planter': {
            // REBUILT in P4v as an ARRANGEMENT (foliage-quality.md §4 vessel types). The BOX is unchanged;
            // what changed is what grows out of it — a GROUP: a focal plant set toward the back, one or two
            // fillers, and a trailing plant spilling over a front corner. Same type name, so existing
            // scenes and saves upgrade on reload.
            const pw = Math.max(0.28, s * 0.3), ph = s * 0.2;
            A.vessel.obox([0, ph * 0.5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], pw, ph * 0.5, pw * 0.72);   // rectangular planter box
            const top: VesselTop = { centre: [0, ph - Math.min(0.03, ph * 0.14), 0], halfX: pw * 0.84, halfZ: pw * 0.72 * 0.8, round: false };
            const spill = spillOf(ph + s * 0.08, s * 0.34);
            const r = plantingArrangement(plantAcc(A), top, vesselPlanting(p, 'group', s * 0.6, dens, card, spill, [0, 1], 1.5), rnd);
            meta.height = Math.max(ph, r.height);
            meta.footprint = box(Math.max(pw, r.extentX), Math.max(pw * 0.72, r.extentZ));
            spillLow = r.low; break;
        }
        case 'potted': {
            // REBUILT in P4v: a pot + an identifiable specimen (a small shrub · a flowering stalk · a strappy
            // blade clump — picked per seed), on real soil. It used to be a pot with a green sphere on it.
            // ★ QUALITY PASS: `single` planted EXACTLY ONE small plant dead centre, so `density` moved nothing
            // and a wide ring of bare soil showed round the inside of the rim — a twig in a bucket next to a
            // same-size `bush`. A pot now gets the GROUP rule: a focal specimen, fillers pushed out toward the
            // rim, and a trailing plant spilling radially over the edge.
            const rTop = s * 0.24, rBot = s * 0.16, ph = s * 0.32;
            potShape(A.vessel, rTop, rBot, ph);
            const rim = Math.min(0.08, ph * 0.18);
            const top: VesselTop = { centre: [0, ph - rim * 0.7, 0], halfX: rTop * 0.82, halfZ: rTop * 0.82, round: true };
            const spill = spillOf(s * 0.16, s * 0.46);
            // spillSpread = TAU: a potted trailing plant spills all the way round its pot, not toward one face.
            const r = plantingArrangement(plantAcc(A), top, vesselPlanting(p, 'group', s * 0.62, dens, card, spill, [0, 1], TAU), rnd);
            meta.height = Math.max(ph, r.height);
            const rad = Math.max(rTop * 1.2, r.radius);
            meta.footprint = box(rad, rad);
            spillLow = r.low; break;
        }
        case 'vine': case 'ivy': {
            // REBUILT in P3 on the `runner` primitive (foliage-quality.md §3.4). It used to be random
            // blobs/quads sprayed over a flat z≈0 plane — no growth, no runners, nothing following or
            // clinging to the surface. Same type names, so existing scenes and saves upgrade on reload.
            const aw = Math.max(0.2, p.areaWidth ?? w), ah = Math.max(0.2, p.areaHeight ?? s);
            const spec = runnerSpecFor(p.type, p, ah, aw, dens);
            const acc: RunnerAccum = { stem: A.stem, leaf: A.leaf, tip: A.tip, stemFree: A.stemFree, leafFree: A.leafFree, tipFree: A.tipFree };
            // ★ The two path sources, feeding ONE growth/geometry model (see runner.ts).
            const source: RunnerSource = p.ivyMode === 'path' && p.ivyPath && p.ivyPath.length > 1
                ? { mode: 'path', points: p.ivyPath, normal: p.ivyPathNormal ?? [0, 0, 1] }
                // Host surface v1: the +Z wall face, spanning x ∈ [−aw/2, aw/2] and y ∈ [0, ah].
                : { mode: 'area', host: wallHost({ origin: [-aw / 2, 0, 0], right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], width: aw, height: ah }), seedOffset: p.seed | 0 };
            const r = buildRunners(acc, source, spec, rnd);
            blooms(0, ah * 0.6, 0.07, aw * 0.4, Math.round(aw * 2));
            meta.height = Math.max(0.05, r.height);
            meta.footprint = box(Math.max(0.1, aw / 2), Math.max(0.08, spec.leafSize + spec.clingOffset)); break;
        }
        case 'window-box': {
            // ★ REBUILT in P4v — and this is the type the arrangement model exists for. A window box READS
            // as a window box because of TRAILING plants spilling over its FRONT edge and hanging down past
            // the box, with upright flowering plants standing behind them. It used to be a box with a cloud
            // of random blobs floating around it. The BOX itself is unchanged; `width` is still the run
            // length, and the spill is pinned to the OUTWARD (+Z / front) face.
            const bh = 0.22, bd = 0.28;
            A.vessel.obox([0, bh * 0.5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], w / 2, bh * 0.5, bd * 0.5);
            const top: VesselTop = { centre: [0, bh - 0.025, 0], halfX: (w / 2) * 0.9, halfZ: (bd / 2) * 0.78, round: false };
            const spill = spillOf(bh + 0.1, 0.62);      // ★ always clears the BOTTOM of the box (y = 0)
            const r = plantingArrangement(plantAcc(A), top, vesselPlanting(p, 'row', 0.4 + dens * 0.22, dens, card, spill, [0, 1], 1.25), rnd);
            meta.height = Math.max(bh, r.height);
            meta.footprint = box(Math.max(w / 2, r.extentX), Math.max(bd * 0.5, r.extentZ));
            spillLow = r.low; break;
        }
    }

    const E = 0.14;   // low unlit lift, matching buildings (true colours, not glow)
    const blade = BLADE_TYPES.has(p.type);
    const flower = FLOWER_TYPES.has(p.type);
    const runner = RUNNER_TYPES.has(p.type);
    const woody = BRANCH_TYPES.has(p.type);
    // A woody type's LIMBS are always real swept tubes, but its LEAVES are only real swept blades in
    // `card` (quality) mode — in `chunky` mode they are still low-poly blobs, which must keep the old
    // blob-era shading. So `real` is render-dependent for exactly these four types.
    const woodyReal = woody && card;
    // A VESSEL type (P4v) is an arrangement of the P1–P4 primitives, so its foliage is real swept
    // geometry in both render modes (`chunky` only swaps the shrub canopy's leaves for blobs).
    const vessel = VESSEL_TYPES.has(p.type);
    // ★ A CONIFER's needles are real swept blades in BOTH render modes, like the blade/flower archetypes.
    // It was in none of the archetype sets, so `real` came out false and `leafFlag` true — which put
    // `leafCard` (the alpha-cut leaf silhouette) on real needle geometry and CARVED THE NEEDLES AWAY.
    // That is why the city's conifers rendered as bare sticks. It also cost them the higher translucency.
    const conifer = p.type === 'conifer';
    const real = blade || flower || runner || vessel || woodyReal || conifer;   // REAL swept geometry
    const leafFlag = card && !real;    // alpha-cutting real geometry would eat the blade / petal itself
    const petalCol = p.petalColor ?? (flower ? FLOWER_RECIPES[p.type as FlowerType].petal : p.bloomColor);
    const centerCol = p.centerColor ?? (flower ? FLOWER_RECIPES[p.type as FlowerType].center : [0.98, 0.82, 0.18] as [number, number, number]);
    const cel: LayoutPreviewLayer['renderStyle'] = p.celShade ? 'cel' : undefined;   // toon/Ghibli foliage
    // ── SHARED look (foliage-quality.md §2, S1 wind + S2 translucency/AO/ground blend) ───────────────
    // Every type gets it, per-type tuned: leaf/tip/bloom sway fully and transmit light (the anime backlit
    // cue); trunks/vessels sway a hair and never transmit (wood/ceramic is opaque).
    const [stiff, amt] = FOLIAGE_WIND[p.type];
    const H = Math.max(0.05, meta.height);
    const wind = (k: number): NonNullable<LayoutPreviewLayer['wind']> => ({ height: H, stiffness: stiff, amount: amt * k });
    // Blades are the THINNEST geometry in the library → the strongest transmission (the NTE backlit-meadow
    // read) and the strongest ground bleed (they grow straight out of the soil).
    const gb = GROUND_PLANTED.has(p.type) ? (real ? 0.45 : 0.35) : 0;   // vessel-borne / wall plants never touch the soil
    const shade = (c: [number, number, number], t: number, tint = transmitTint): NonNullable<LayoutPreviewLayer['foliageShade']> =>
        ({ translucency: t, translucencyColor: tint(c), groundBlend: gb, groundTint: FOLIAGE_GROUND_TINT, baseAO: real ? 0.45 : 0.35 });
    const out: LayoutPreviewLayer[] = [];
    // ★ A TRUNK BARELY MOVES while its outer foliage does (P4). The S1 height ramp already gives the
    // canopy most of its travel because the clusters sit at the top of the plant; the per-layer split
    // does the rest — woody limbs ×0.1 (a branch is wood, it flexes, it does not wave), leaf ×1, and
    // the new-growth TIP layer ×1.35 so the outer twig masses are the floppiest thing on the tree.
    if (!A.trunk.empty) out.push({ name: 'foliage:trunk', color: p.trunkColor, y: 0, geometry: A.trunk.geometry(), emissive: E * 0.7, renderStyle: cel, wind: wind(woody ? 0.45 : 0.15) });
    // ★ 0.45, not 0.1. The leaf masses sit at the TIPS of the twigs, and swayed at amount x1 while the
    // twigs carrying them swayed at x0.1 — so in a breeze the foliage sheared off the ends of its own
    // branches. That never showed on the old blob trees (no visible limbs); it is glaring on a carded
    // tree. The base still stays planted: the height GRADE (exponent ~2.2) does that, not the amount.
    if (!A.vessel.empty) out.push({ name: 'foliage:vessel', color: p.potColor, y: 0, geometry: A.vessel.geometry(), emissive: E * 0.8, wind: wind(0.04) });
    // The SOIL surface (P4v): dark, opaque, and as still as the vessel it sits in — without it you look
    // straight through the rim into an empty pot.
    if (!A.soil.empty) out.push({ name: 'foliage:soil', color: p.soilColor ?? VESSEL_SOIL_COLOR, y: 0, geometry: A.soil.geometry(), emissive: E * 0.5, wind: wind(0.04) });
    // ★ ATTACHMENT-GRADED WIND for the climbers (§8 P3). The S1 sway grades by `localY / windHeight` —
    // right for a PLANTED stem, wrong for ivy, which is glued to a wall at every height and only moves
    // where it is UNATTACHED. Two halves, no shader change:
    //   1. the ivy/vine rows of FOLIAGE_WIND carry a deliberately LOW stiffness, which flattens the height
    //      grade to nearly uniform (height is not this plant's axis of freedom), and
    //   2. the geometry is split CLINGING vs FREE at generation time (runner.ts routes every span past the
    //      last cling point into the `*Free` accumulators), and the free layers get ~20× the sway `amount`.
    // Clinging leaves therefore barely twitch while the hanging tips swing — without the per-vertex
    // attachment attribute a shader change would have cost.
    const clung = runner ? 0.06 : 1;      // per-layer sway scale for ATTACHED geometry
    const leafT = blade ? 0.75 : runner ? 0.8 : (woodyReal || vessel || conifer) ? 0.72 : 0.55;
    const tipT = blade ? 0.88 : runner ? 0.9 : (woodyReal || vessel || conifer) ? 0.86 : 0.7;
    const tipSway = woody && p.type !== 'hedge' ? 1.35 : 1.15;   // floppy outer twig masses (P4)
    if (!A.leaf.empty) out.push({ name: 'foliage:leaf', color: p.foliageColor, y: 0, geometry: A.leaf.geometry(), emissive: E, leafCard: leafFlag, renderStyle: cel, rim: p.celShade, wind: wind(clung), foliageShade: shade(p.tipColor, leafT) });
    if (!A.tip.empty) out.push({ name: 'foliage:tip', color: p.tipColor, y: 0, geometry: A.tip.geometry(), emissive: E * 1.1, leafCard: leafFlag, renderStyle: cel, rim: p.celShade, wind: wind(tipSway * clung), foliageShade: shade(p.tipColor, tipT) });
    // ── RUNNER layers (P3): the woody climbing stem — pale and clearly visible wherever the leaves are
    //    sparse — plus the FREE / HANGING half of each channel, which is where all the motion lives.
    const stemCol = p.stemColor ?? (runner ? RUNNER_RECIPES[p.type as RunnerType].stem : p.trunkColor);
    // ★ THE HANGING-SPILL WIND FIX (P4v) — the vessel analogue of the P3 climber problem, and it needs
    // the opposite correction. S1 grades sway by `pow(clamp(localY / windHeight, 0, 1), stiffness)`, so
    // geometry BELOW the plant's origin gets grade 0 and cannot move at all. A window box's spill hangs
    // *under* the box (that is the whole look) — so it would be the one part of the plant that is dead
    // still, which is exactly backwards: it is free-hanging and should move MOST.
    // The fix keeps the S1 contract and touches no shader:
    //   1. the free geometry is emitted in a LIFTED frame (every vertex pushed up by `lift`) and the
    //      layer carries ONE instance transform that puts it straight back — the world position is
    //      identical, but the shader now sees positive local Y, and
    //   2. that layer gets a tiny `windHeight`, so the height ramp SATURATES at 1 over the whole spill →
    //      a uniform, full-amplitude sway (the same "flatten the ramp" insight ivy used, for the same
    //      reason: height is not this geometry's axis of freedom), with the amount raised on top.
    const lift = spillLow < -1e-4 ? -spillLow + 0.15 : 0;
    const freeGeo = (a: Accum3D): LayoutPreviewLayer['geometry'] => lift > 0 ? liftGeometryY(a.geometry(), lift) : a.geometry();
    const freeAt = lift > 0 ? [{ x: 0, y: -lift, z: 0, ry: 0 }] : undefined;
    const freeWind = (k: number): NonNullable<LayoutPreviewLayer['wind']> =>
        lift > 0 ? { height: SPILL_WIND_HEIGHT, stiffness: stiff, amount: amt * k } : wind(k);
    // Free-hanging vessel foliage swings harder than a clinging ivy runner does — nothing holds it.
    const [kStem, kLeaf, kTip] = vessel ? [1.0, 1.35, 1.6] : [0.95, 1.05, 1.25];
    if (!A.stem.empty) out.push({ name: 'foliage:stem', color: stemCol, y: 0, geometry: A.stem.geometry(), emissive: E * 0.8, renderStyle: cel, wind: wind(0.05), foliageShade: shade(stemCol, 0.12) });
    if (!A.stemFree.empty) out.push({ name: 'foliage:stem-free', color: stemCol, y: 0, geometry: freeGeo(A.stemFree), instances: freeAt, emissive: E * 0.8, renderStyle: cel, wind: freeWind(kStem), foliageShade: shade(stemCol, 0.12) });
    if (!A.leafFree.empty) out.push({ name: 'foliage:leaf-free', color: p.foliageColor, y: 0, geometry: freeGeo(A.leafFree), instances: freeAt, emissive: E, renderStyle: cel, rim: p.celShade, wind: freeWind(kLeaf), foliageShade: shade(p.tipColor, leafT) });
    if (!A.tipFree.empty) out.push({ name: 'foliage:tip-free', color: p.tipColor, y: 0, geometry: freeGeo(A.tipFree), instances: freeAt, emissive: E * 1.1, renderStyle: cel, rim: p.celShade, wind: freeWind(kTip), foliageShade: shade(p.tipColor, tipT) });
    // PETALS are the thinnest geometry in the whole library — translucency is highest here, and this is
    // where the backlit glow sells hardest (§2.2). Their tint brightens the petal hue instead of pushing
    // it green (a backlit violet lavender must stay violet).
    if (!A.bloom.empty) out.push({ name: 'foliage:bloom', color: petalCol, y: 0, geometry: A.bloom.geometry(), emissive: flower ? 0.22 : 0.3, wind: wind(flower ? 1.2 : 1), foliageShade: shade(petalCol, flower ? 0.9 : 0.5, flower ? petalTint : transmitTint) });
    if (!A.center.empty) out.push({ name: 'foliage:center', color: centerCol, y: 0, geometry: A.center.geometry(), emissive: 0.2, wind: wind(1.2), foliageShade: shade(centerCol, 0.3, petalTint) });
    return { layers: out, meta };
}

// ── Shared look tables (foliage-quality.md §2) ───────────────────────────────────────────────────
/** Per-type [wind stiffness (bend exponent), base wind amount]. Grass is floppy (low exponent, full
 *  amount); a clipped hedge barely moves (high exponent, small amount); a tree trunk is stiffest. */
export const FOLIAGE_WIND: Record<FoliageType, [number, number]> = {
    // WOODY (P4): the plant is a stiff skeleton with floppy foliage on the outside, so the stiffness
    // stays high-ish (the base does not bend) while the AMOUNT comes up — a bush visibly breathes now
    // that it has an irregular outline to breathe with. A clipped HEDGE is the stiffest thing in the
    // library (a manicured box barely registers wind at all); a small tree is mid-LOW at the trunk with
    // its floppiness delivered by the ×1.35 tip layer, not by a low exponent.
    'bush': [2.0, 0.6], 'shrub': [2.1, 0.56], 'hedge': [3.0, 0.24], 'grass-tuft': [1.2, 1.0],
    'tall-grass': [1.0, 1.1],   // the floppiest thing in the library — long straps, bends from very low down
    // FLOWERS (P2): a single thin stalk carrying a heavy head is floppy — but a TALL spike (lavender,
    // rapeseed) is woodier at the base than a little daisy, so it bends a touch higher up.
    'flower-bed': [1.3, 0.9], 'daisy': [1.3, 0.95], 'rapeseed': [1.5, 0.9], 'lavender': [1.55, 0.85],
    // VESSELS (P4v): the pot/box is furniture and barely registers wind (×0.04 on its own layer), but what
    // GROWS out of it is a real arrangement of soft plants, so the row itself is mid — and the hanging
    // spill takes its motion from the `-free` layers below, not from this exponent.
    'planter': [1.9, 0.5], 'potted': [2.0, 0.45], 'small-tree': [2.2, 0.6],
    // A conifer's leader is stiff, but the whorled branch TIPS are the floppiest part of the crown —
    // so it sits near a small-tree on the exponent with a higher amount out at the needles.
    'conifer': [2.3, 0.9],
    // ★ CLIMBERS (P3) read this table DIFFERENTLY. Every other row grades sway by height because the plant
    // is planted at its base; ivy is attached at EVERY height, so a low stiffness here deliberately
    // FLATTENS the height grade to ~uniform, and the real grading is done by the clinging/free geometry
    // split in `buildFoliage` (attached leaves ×0.06, hanging tips ×1.05). See §8 P3.
    // ★ A window box is mostly SOFT trailing + bedding plants, so it is floppier than a planter (whose
    // focal is often a small shrub) — and its spill layers ride the saturated `SPILL_WIND_HEIGHT` ramp.
    'vine': [0.55, 1.0], 'ivy': [0.5, 0.9], 'window-box': [1.4, 0.85],
};
/** Archetypes built as a vessel + a PLANTING ARRANGEMENT (planting.ts, §4 vessel types, P4v) — a pot /
 *  box (kept verbatim), a soil surface, and a small composition of plants made from the P1–P4
 *  primitives. Real swept geometry in BOTH render modes, so like the other four sets they are never
 *  alpha-cut; `groundBlend` stays 0 because a vessel plant never touches the soil of the world. */
export const VESSEL_TYPES = new Set<FoliageType>(['planter', 'potted', 'window-box']);
/** Default soil colour under a planted vessel (dark, damp potting compost). */
export const VESSEL_SOIL_COLOR: [number, number, number] = [0.19, 0.15, 0.11];
/**
 * ★ The `windHeight` a LIFTED hanging-spill layer carries (metres). Small on purpose: the S1 grade
 * `clamp(localY / windHeight, 0, 1)` then saturates at 1 across the whole spill, giving it a uniform
 * full-amplitude sway instead of the height ramp's "the lower you hang, the less you move" — which is
 * exactly wrong for free-hanging geometry. See the emission block in {@link buildFoliage}.
 */
export const SPILL_WIND_HEIGHT = 0.12;

/**
 * Translate a geometry along +Y, in place (the buffers come back from `Accum3D.geometry()` as fresh
 * copies, so this can never disturb another layer). Pairs with a `-dy` instance transform: the mesh
 * lands in exactly the same world place, but the wind/AO ramps see positive LOCAL Y.
 */
export function liftGeometryY(g: LayoutPreviewLayer['geometry'], dy: number): LayoutPreviewLayer['geometry'] {
    const v = g.vertices;
    for (let i = 1; i < v.length; i += 12) v[i] += dy;   // 12-float stride: pos3 · nrm3 · uv2 · tangent4
    return g;
}
/** Archetypes built from the `blade` primitive (§3.1) — real swept strip geometry, so they never take the
 *  alpha-cut leaf-card silhouette, and they get the strongest translucency + ground blend. */
export const BLADE_TYPES = new Set<FoliageType>(['grass-tuft', 'tall-grass']);
/** Archetypes built from the `whorl` + `stalk` primitives (§3.2/§3.3, P2) — swept petals, stems and leaf
 *  blades. Same precedent as {@link BLADE_TYPES}: never alpha-cut (it would eat real petal geometry), and
 *  petals carry the library's HIGHEST translucency (they are the thinnest geometry there is). */
export const FLOWER_TYPES = new Set<FoliageType>(['daisy', 'rapeseed', 'lavender', 'flower-bed']);
/** Archetypes built from the `runner` primitive (§3.4, P3) — a swept woody stem carrying real swept leaf
 *  blades over a host surface. Same precedent as {@link BLADE_TYPES} / {@link FLOWER_TYPES}: never
 *  alpha-cut, high leaf translucency (backlit ivy glows), stems almost none, and `groundBlend` 0 because a
 *  climber is attached to a WALL, not planted in soil. */
export const RUNNER_TYPES = new Set<FoliageType>(['ivy', 'vine']);
/** Archetypes built from the `branch` primitive (§3.5, P4) — a recursive limb skeleton (swept tapered
 *  tubes) carrying leaf masses at the TWIG TIPS, plus `hedge`, which is the clipped SHELL variant of the
 *  same module. Unlike the other three sets these are only "real geometry" for their LEAVES in
 *  `render:'card'` mode (`chunky` keeps the low-poly blob masses) — see `woodyReal` in `buildFoliage`. */
export const BRANCH_TYPES = new Set<FoliageType>(['bush', 'shrub', 'hedge', 'small-tree']);
/** Types that grow straight out of the ground → their base gets the ground-colour bleed (§2.3). Vessel
 *  plants (planter/potted/window-box) and wall climbers (vine/ivy) don't touch soil, so they get none. */
export const GROUND_PLANTED = new Set<FoliageType>(['bush', 'shrub', 'hedge', 'grass-tuft', 'tall-grass', 'flower-bed', 'daisy', 'rapeseed', 'lavender']);
/** The soil/shadow colour blended into a plant's base so cards stop reading as floating. */
export const FOLIAGE_GROUND_TINT: [number, number, number] = [0.28, 0.30, 0.18];
/** Transmission tint = a LIGHTER, more saturated version of the leaf colour (§2.2) — sunlight through a
 *  blade is yellow-green, never the diffuse colour. */
export function transmitTint(c: [number, number, number]): [number, number, number] {
    return [Math.min(1, c[0] * 1.15 + 0.16), Math.min(1, c[1] * 1.25 + 0.22), Math.min(1, c[2] * 0.9 + 0.05)];
}
/** Backlit tint for PETALS — brightens the petal hue uniformly instead of pushing it green like
 *  {@link transmitTint} does. Sun through a violet lavender floret is a brighter violet, not a yellow-green. */
export function petalTint(c: [number, number, number]): [number, number, number] {
    return [Math.min(1, c[0] * 1.25 + 0.1), Math.min(1, c[1] * 1.25 + 0.1), Math.min(1, c[2] * 1.25 + 0.1)];
}

export const FOLIAGE_TYPES: FoliageType[] = ['bush', 'shrub', 'hedge', 'grass-tuft', 'tall-grass', 'flower-bed', 'daisy', 'rapeseed', 'lavender', 'planter', 'potted', 'small-tree', 'vine', 'ivy', 'window-box'];
export function foliageTypeNames(): FoliageType[] { return FOLIAGE_TYPES; }
