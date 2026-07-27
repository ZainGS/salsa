// ─────────────────────────────────────────────────────────────────────────────
// The VESSEL PLANTING recipe (foliage-quality.md §4 "vessel types", phase P4v) — the ARRANGEMENT
// that turns a pot / planter / window box from "vessel + one green ball" into a small COMPOSITION of
// identifiable plants.
//
// Why it exists: `planter` · `potted` · `window-box` were the last three types on the old
// construction — each was a correct vessel (a `potShape` frustum or an `obox`) topped by ONE
// `foliageClump` blob plus `foliageBloom` sphere specks. The vessels were never the problem. The
// PLANTING was: a real arrangement is a taller FOCAL plant, MID filler, and EDGE plants TRAILING over
// the rim — three readable silhouettes, not one sphere.
//
// ★ THIS MODULE ADDS NO GEOMETRY CODE. Every plant here is a composition of primitives that already
// exist, which is the whole claim of the recipes-over-primitives architecture (§4):
//   · `shrub`    — `emitBranch` (§3.5) + `emitCanopy` (§3.6): a multi-stem fan with tip leaf masses,
//   · `flower`   — `emitStalk` (§3.3) carrying `emitWhorl` florets (§3.2): stem, leaves, real petals,
//   · `grass`    — `bladeTuft` (§3.1) with the `strap` width profile: strappy/grassy foliage,
//   · `trailing` — ★ `buildRunners` (§3.4) over hand-built centrelines that leave the rim and FALL.
//     A spilling plant IS a runner with a downward growth bias; the runner primitive's clinging/free
//     split, age-scaled leaves, droop, LOD and caps all come along for free.
//
// The layout rule (one rule, three vessels): FOCAL (or a row of focals for a long box) toward the
// BACK, MID filler between them, EDGE/TRAILING plants at the rim on the outward side. Every plant
// gets scale / yaw / lean jitter, every root sits ON the soil plane inside the vessel footprint, and
// the soil disc/slab hides the inside of the vessel.
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { cfNorm, type V3 } from './curve-frame';
import { bladeTuft, type BladeTuftSpec } from './blade';
import { emitStalk, resolveStalk } from './stalk';
import { buildRunners, resolveRunner, type RunnerAccum, type RunnerPath } from './runner';
import {
    emitBranch, emitCanopy, leafBudget, resolveBranch,
    DEFAULT_CANOPY, DEFAULT_LEAF, type CanopySpec, type LeafGeom,
} from './branch';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Plant-count multiplier per LOD band (§2.5) — the arrangement analogue of `BLADE_LOD_SCALE`. */
export const PLANTING_LOD_SCALE = [1, 0.6, 0.35];
/** Hard cap on plants in ONE vessel — truncation is LOGGED, never silent (§7). */
export const MAX_PLANTS_PER_VESSEL = 10;
/** Hard cap on leaves/blades/florets across a whole vessel arrangement — likewise logged. Raised from 900 in
 *  the quality pass: a FULL planter (5 uprights with real leaf mass + a spill that actually spills) needs the
 *  headroom, and the cap was silently starving the trailing plants that plant last. */
export const MAX_VESSEL_LEAVES = 1400;

/** The four recipe atoms an arrangement plants. Each is a composition of EXISTING primitives. */
export type PlantKind = 'shrub' | 'flower' | 'grass' | 'trailing';
export const PLANT_KINDS: PlantKind[] = ['shrub', 'flower', 'grass', 'trailing'];

/** The vessel's top surface — everything the arrangement needs to know about the pot/box it fills. */
export interface VesselTop {
    /** Centre of the SOIL plane (plant-local metres). Roots sit here, below the rim. */
    centre: V3;
    /** Half-extents of the plantable area (always inside the rim). */
    halfX: number;
    halfZ: number;
    /** Round (a pot → a soil disc) vs rectangular (a box → a soil slab). */
    round: boolean;
}

export interface PlantingSpec {
    /** `single` = one specimen (a pot) · `group` = focal + filler + trailer · `row` = N along the length. */
    layout: 'single' | 'group' | 'row';
    /** 0..1 fullness — plant count and per-plant leaf/blade density. */
    density: number;
    /** Focal plant height (m) above the soil. Fillers scale down from it. */
    height: number;
    /** ★ Real `whorl` flower heads on the flowering plants (the `bloom` param, §5). */
    bloom: boolean;
    /** How far a trailing plant hangs BELOW the soil plane (m). **0 = no trailing plants at all.** */
    spill: number;
    /** Outward XZ direction the spill favours — a window box spills over its FRONT (+Z). */
    spillDir: [number, number];
    /** Azimuth spread (rad) of one trailing plant's strands. `TAU` = it spills all the way round a pot. */
    spillSpread: number;
    /** `true` (render `card`) ⇒ real swept leaves in the shrub canopy; `false` ⇒ low-poly blobs. */
    card: boolean;
    /** Explicit plant-count override (before the LOD scale + the cap). */
    plants?: number;
    /** Force the focal recipe instead of picking one per seed. */
    focal?: PlantKind;
    /** 0 near · 1 mid · 2 far — thins the plant count AND every primitive underneath (§2.5). */
    lodLevel?: number;
    maxPlants?: number;
    maxLeaves?: number;
}

/** Where the arrangement's geometry lands. Split so each part can carry its own colour + wind. */
export interface PlantingAccum {
    /** Woody limbs of a planted shrub (trunk colour). */
    woody: Accum3D;
    /** Mature foliage / lighter new-growth tips. */
    leaf: Accum3D;
    tip: Accum3D;
    /** Flower heads — petals and the disc/eye (§3.2). */
    petal: Accum3D;
    centre: Accum3D;
    /** A trailing plant's woody runner, while it is still over the vessel. */
    stem: Accum3D;
    /** ★ The FREE / HANGING half of the trailing plants — the WIND split (see `buildFoliage`). */
    stemFree: Accum3D;
    leafFree: Accum3D;
    tipFree: Accum3D;
    /** The soil surface (so you never see through the rim into an empty vessel). */
    soil: Accum3D;
}

/** One planted specimen, in emission order — enough for a caller (or a test) to verify the layout. */
export interface PlacedPlant {
    kind: PlantKind;
    /** Root position (plant-local metres). */
    x: number;
    z: number;
    /** Size multiplier vs the focal height. */
    scale: number;
    /** Measured top (world Y). */
    top: number;
    /** Measured horizontal reach from its own root. */
    reach: number;
    /** Leaves / blades / florets this plant emitted. */
    leaves: number;
    trailing: boolean;
}

export interface PlantingResult {
    plants: PlacedPlant[];
    /** Total leaves / blades / florets across the arrangement. */
    leaves: number;
    /** Measured top of the whole arrangement (world Y). */
    height: number;
    /** Measured horizontal reach from the vessel centre. */
    radius: number;
    /** Measured half-extents along X / Z (a spill is directional, so a box footprint needs both). */
    extentX: number;
    extentZ: number;
    /** ★ Lowest world Y touched — negative when a trailing plant spills below the vessel. */
    low: number;
    /** True when a cap truncated the arrangement (also logged). */
    truncated: boolean;
}

interface Slot { kind: PlantKind; x: number; z: number; scale: number; lean: number; yaw: number }
interface PlantOut { top: number; reach: number; leaves: number; low: number }

// ── The SOIL surface ─────────────────────────────────────────────────────────────────────────────
/**
 * A soil disc (round vessels) or slab (rectangular ones) just below the rim. Without it you look
 * straight through the opening into an empty pot — the single cheapest fix in this whole module.
 */
export function emitSoil(soil: Accum3D, top: VesselTop): void {
    if (top.round) {
        soil.disc(top.centre, [0, 1, 0], Math.max(top.halfX, top.halfZ) * 1.12, 10);
    } else {
        const h = Math.max(0.004, Math.min(top.halfX, top.halfZ) * 0.05);
        soil.obox([top.centre[0], top.centre[1] - h, top.centre[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1],
            top.halfX * 1.1, h, top.halfZ * 1.1);
    }
}

// ── The LAYOUT rule ──────────────────────────────────────────────────────────────────────────────

/** Which recipe the FOCAL slot may take. `trailing` only competes for a lone specimen in a pot. */
function focalPool(spec: PlantingSpec): PlantKind[] {
    const pool: PlantKind[] = ['shrub', 'grass'];
    if (spec.bloom) pool.push('flower');
    if (spec.layout === 'single' && spec.spill > 1e-4) pool.push('trailing');
    return pool;
}

/** The FOCAL recipe for a seed. ★ §5: `bloom` now drives REAL `whorl` heads instead of `foliageBloom`
 *  sphere specks — and someone who switches it on wants a *flowering* plant, so it mostly wins. */
function pickFocal(spec: PlantingSpec, rnd: () => number): PlantKind {
    const roll = rnd();
    if (spec.bloom && roll < 0.65) return 'flower';
    const pool = focalPool(spec);
    return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))];
}

/**
 * ★ THE LAYOUT RULE (one rule, three vessels):
 *   · a taller FOCAL plant (or a ROW of them along a long box) set toward the BACK,
 *   · MID filler between / around it, smaller and shorter,
 *   · EDGE plants at the rim on the OUTWARD side, trailing over it.
 * Every root is clamped inside the vessel footprint; scale, yaw and lean all jitter per plant.
 */
function layoutSlots(top: VesselTop, spec: PlantingSpec, rnd: () => number): Slot[] {
    const dens = clamp01(spec.density);
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, PLANTING_LOD_SCALE.length - 1);
    const k = PLANTING_LOD_SCALE[lod];
    const sd = cfNorm([spec.spillDir[0], 0, spec.spillDir[1]]);
    const trail = spec.spill > 1e-4;
    const hx = Math.max(1e-3, top.halfX), hz = Math.max(1e-3, top.halfZ);

    // ★ PLANT COUNT (quality pass): the first version planted 2–4 uprights in a box and 2–3 in a group, so
    // even at density 1 a vessel read as a few sticks with soil showing between them. A real planter is FULL:
    // `density` now genuinely runs "sparse → lush" on the COUNT as well as on each plant's own leaf mass.
    let uprights: number, trailers: number;
    if (spec.layout === 'single') { uprights = 1; trailers = 0; }
    else if (spec.layout === 'row') {
        uprights = clamp(Math.round(2 + dens * 1.6 + (hx * 2) / 0.5), 3, 5);
        trailers = trail ? clamp(Math.round(1 + dens + (hx * 2) / 0.7), 2, 4) : 0;
    } else {
        uprights = clamp(Math.round(2.2 + dens * 1.8), 3, 4);
        trailers = trail ? 1 : 0;
    }
    if (spec.plants !== undefined) {                              // explicit count → keep the mix ratio
        const want = Math.max(1, Math.round(spec.plants));
        const share = trailers / Math.max(1, uprights + trailers);
        trailers = Math.min(want - 1, Math.round(want * share));
        uprights = want - trailers;
    }
    uprights = Math.max(1, Math.round(uprights * k));
    trailers = Math.round(trailers * k);

    const cap = Math.max(1, Math.round(spec.maxPlants ?? MAX_PLANTS_PER_VESSEL));
    if (uprights + trailers > cap) {
        console.warn(`[planting] plant count capped ${uprights + trailers} → ${cap} (foliage-quality.md §7 — density loss is never silent)`);
        trailers = Math.min(trailers, Math.max(0, cap - 1));
        uprights = Math.max(1, cap - trailers);
    }

    const focal = spec.focal ?? pickFocal(spec, rnd);
    const fillers: PlantKind[] = spec.bloom ? ['flower', 'grass'] : ['grass', 'shrub'];
    const slots: Slot[] = [];
    const jit = (a: number): number => (rnd() * 2 - 1) * a;

    for (let i = 0; i < uprights; i++) {
        const kind: PlantKind = i === 0 ? focal : fillers[(i - 1) % fillers.length];
        // Fillers used to bottom out at 0.52 of the focal — small enough to read as seedlings next to it.
        // 0.62–0.88 still keeps every filler strictly under the focal (which is ≥ 0.9) but gives real mass.
        const scale = i === 0 ? 1 + jit(0.1) : 0.62 + rnd() * 0.26;
        let x: number, z: number;
        if (spec.layout === 'row') {
            // A ROW along the box's length, alternating a touch forward/back so it is not a ruler line.
            const u = uprights === 1 ? 0.5 : (i + 0.5) / uprights;
            x = (u * 2 - 1) * hx * 0.82 + jit(hx * 0.08);
            z = -sd[2] * hz * 0.34 + (i % 2 ? hz * 0.16 : -hz * 0.06) + jit(hz * 0.1);
        } else if (spec.layout === 'single') {
            x = jit(hx * 0.1); z = jit(hz * 0.1);
        } else if (i === 0) {
            x = -sd[0] * hx * 0.26 + jit(hx * 0.12); z = -sd[2] * hz * 0.26 + jit(hz * 0.12);
        } else {
            // Push the ring OUT toward the rim (was 0.42–0.72 of the half-extent, which clustered everything
            // into the middle and left a bare ring of soil showing all round the inside of the vessel).
            const a = i * GOLDEN_ANGLE + rnd() * 0.5, r = 0.5 + rnd() * 0.38;
            x = Math.cos(a) * hx * r; z = Math.sin(a) * hz * r;
        }
        slots.push({
            kind, scale,
            x: clamp(x, -hx * 0.9, hx * 0.9), z: clamp(z, -hz * 0.9, hz * 0.9),
            lean: jit(0.16), yaw: rnd() * TAU,
        });
    }
    // EDGE / TRAILING plants: at the rim, on the OUTWARD side — the spill is the read (§4 window box).
    for (let i = 0; i < trailers; i++) {
        const u = trailers === 1 ? 0.5 : (i + 0.5) / trailers;
        const along = spec.layout === 'row' ? (u * 2 - 1) * hx * 0.72 : (rnd() < 0.5 ? -1 : 1) * hx * 0.55;
        slots.push({
            kind: 'trailing', scale: 0.55 + rnd() * 0.22,
            x: clamp(along - sd[0] * hx * 0.12, -hx * 0.9, hx * 0.9),
            z: clamp(sd[2] * hz * 0.72 + (sd[2] === 0 ? (rnd() - 0.5) * hz : 0), -hz * 0.9, hz * 0.9),
            lean: 0, yaw: rnd() * TAU,
        });
    }
    return slots;
}

// ── The four recipe atoms (all COMPOSITION — no new geometry code) ───────────────────────────────

function vesselLeaf(size: number, shape: LeafGeom['shape']): LeafGeom {
    // ★ Was 0.13 × 0.08 of the plant's size — noticeably smaller than the freestanding `bush` leaf (0.09 × 0.056
    // of a plant 2–3× the height), which is a large part of why a potted specimen read as a twig.
    return {
        ...DEFAULT_LEAF, length: size * 0.17, lengthVar: 0.32, width: size * 0.105, shape,
        curve: 0.45, fold: 0.2, twist: 0.35, segments: 3, pitch: 1.0, pitchVar: 0.55,
    };
}

/** A small SHRUB: `branch` multi-stem fan (§3.5) + `canopy` tip masses (§3.6). */
function plantShrub(acc: PlantingAccum, base: V3, axis: V3, size: number, dens: number, card: boolean, lod: number, left: number, rnd: () => number): PlantOut {
    // The LIMB skeleton stays cheap (3 tube sides, one split level) — that part was never the problem. What
    // was: the canopy ran at 0.42 × density in card mode against the freestanding `bush`'s full `density`, on
    // 2–4 stems against the bush's 4–7, over a radius of 0.19 × size. A pot at density 1 emitted ~250 tris
    // where a same-size bush emitted ~2900 — literally a tenth of the leaf mass. Stems, canopy radius and
    // canopy density now match the bush recipe; only the tube tessellation stays lean.
    const branch = resolveBranch({
        levels: 1, splitCount: 2, splitCountVar: 1, splitAngle: 0.6, splitAngleVar: 0.35,
        lengthDecay: 0.58, radiusDecay: 0.62, length: size * 0.5, lengthVar: 0.26,
        startRadius: size * 0.024, tipTaper: 0.55, gnarl: 0.5, wander: 0.42, upBias: 0.62,
        lean: 0.05, attachStart: 0.45, segments: 3, sides: 3,
        stems: 3 + Math.round(dens * 3), stemAngle: 0.44, stemSpread: size * 0.11, lodLevel: lod,
    });
    const bres = emitBranch(acc.woody, branch, { base, axis }, rnd);
    const canopy: CanopySpec = {
        ...DEFAULT_CANOPY, radius: size * 0.26, density: 0.35 + dens * 0.65, irregular: 0.62, flatten: 0.85,
        tipFrac: 0.32, gapChance: 0.14, innerGap: 0.38, innerScale: 0.6, sizeVar: 0.4, tipPush: 0.3,
        mode: card ? 'blade' : 'chunky', leaf: vesselLeaf(size, 'palmate'), lodLevel: lod,
    };
    const cres = emitCanopy(acc.leaf, acc.tip, bres.tips, canopy, rnd, base, leafBudget(Math.max(1, left)));
    return { top: Math.max(bres.height, cres.height), reach: Math.max(bres.radius, cres.radius), leaves: cres.leaves, low: base[1] };
}

/** A FLOWERING plant: a `stalk` (§3.3) whose head is a real `whorl` (§3.2) — ★ what `bloom` now drives. */
function plantFlower(acc: PlantingAccum, base: V3, axis: V3, size: number, dens: number, lod: number, left: number, rnd: () => number): PlantOut {
    // ★ `branches` is the fix for "a bare stalk with almost no leaves": the first version emitted ONE naked
    // spine (branches 0) carrying 2–4 leaves and a single 6–10-petal head. A flowering pot plant is a small
    // BUSH of stems — side branches each terminate in their own head, and the foliage leaves come with them.
    const stalk = resolveStalk({
        height: size * 0.82, thickness: size * 0.014, curve: 0.32, segments: 4, sides: 3,
        bloomStart: 0.8, bloomEnd: 1, bloomDensity: 10, bloomScaleCurve: 0.15, pedicel: 0.12,
        terminalCluster: false, branches: 1 + Math.round(dens * 1.2),
        leaves: 4 + Math.round(dens * 4), leafStart: 0.05, leafEnd: 0.5,
        leafLength: size * 0.27, leafWidth: size * 0.09, leafShape: 'pointed',
        floret: {
            count: 9 + Math.round(dens * 6), rows: 2, rowOffset: 0.5,
            elementLength: size * 0.13, elementWidth: size * 0.04, lengthVar: 0.16,
            shape: 'rounded', pitch: 1.3, pitchVar: 0.2, rowPitch: -0.28, rowScale: 0.85, rowLift: 0.06,
            curve: 0.28, twist: 0.16, fold: 0.2, segments: 2,
            centerRadius: size * 0.032, centerDome: 0.6, centerSides: 6,
        },
        lodLevel: lod, maxFlorets: Math.max(1, Math.min(24, left)),
    });
    const r = emitStalk({ stem: acc.leaf, leaf: acc.leaf, petal: acc.petal, centre: acc.centre }, stalk, { base, axis }, rnd);
    return { top: r.height, reach: Math.max(r.radius, size * 0.18), leaves: r.leaves + r.florets.length, low: base[1] };
}

/** STRAPPY / grassy foliage: a `bladeTuft` (§3.1) on the `strap` width profile. */
function plantGrass(acc: PlantingAccum, base: V3, size: number, dens: number, lod: number, left: number, rnd: () => number): PlantOut {
    // ★ 7–16 blades made a potted grass a quarter of the freestanding `grass-tuft` (30–60) at the same size —
    // a handful of straps, not a plant. 15–36 over a wider radius and the full tuft length reads as foliage.
    const spec: BladeTuftSpec = {
        blades: Math.max(1, Math.min(Math.round(15 + dens * 21), Math.max(1, left))),
        radius: size * 0.2, length: size * 0.78, lengthVar: 0.3, width: size * 0.055, taper: 0.45,
        curve: 0.6, curveVar: 0.4, segments: 3, twist: 1.0, twistVar: 0.5, foldAngle: 0.35,
        lean: 0.55, leanVar: 0.35, tipStart: 0.6, shape: 'strap', base, lodLevel: lod,
    };
    const r = bladeTuft(acc.leaf, acc.tip, spec, rnd);
    // Reach = the clump radius + how far a leaning blade swings out. The old flat `size * 0.32` was already an
    // under-estimate and became a wrong one once the blades got longer — and the arrangement's `extentX/Z` (the
    // FOOTPRINT the host places the plant by) is built from it, so a lie here puts leaves outside the footprint.
    return { top: r.height, reach: spec.radius + spec.length * (spec.lean + spec.leanVar) * 0.55, leaves: r.blades, low: base[1] };
}

/**
 * ★ A TRAILING / SPILLING plant — a `runner` (§3.4) with a DOWNWARD growth bias.
 *
 * The runner primitive already models everything a spill needs (a swept woody stem, leaves spaced in
 * metres of arclength and scaled by age, droop, the clinging↔FREE split, LOD, caps); the only thing it
 * cannot do here is *grow* the centreline, because there is no host surface to crawl on — a strand
 * leaves the rim and immediately falls. So the centrelines are built analytically (arc outward, then
 * accelerate downward) and fed through the `paths` source, which runs the identical downstream.
 *
 * ★ The first ~22 % of each strand is marked NOT hanging: that is the anchored bit on the soil / over
 * the rim, and it stays in the clinging accumulators. Everything past it goes to the `*Free` channels,
 * which is what lets `buildFoliage` give the hanging half its own (much larger) wind response.
 */
function plantTrailing(
    acc: PlantingAccum, base: V3, size: number, reach: number, drop: number,
    outDir: V3, spread: number, dens: number, lod: number, left: number, rnd: () => number,
): PlantOut {
    const k = PLANTING_LOD_SCALE[lod];
    // ★ 2–4 strands per trailer was a see-through fringe, not a SPILL. A window box has to look like the
    // plants are pouring over the front edge — that read is the whole reason the arrangement model exists.
    const strands = Math.max(2, Math.round((3.5 + dens * 3.5) * k));
    const paths: RunnerPath[] = [];
    const STEPS = 8;
    for (let s = 0; s < strands; s++) {
        const a = ((strands === 1 ? 0 : (s + 0.5) / strands - 0.5) * spread) + (rnd() - 0.5) * spread * 0.18;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = outDir[0] * ca - outDir[2] * sa, dz = outDir[2] * ca + outDir[0] * sa;   // yaw about +Y
        const len = drop * (0.72 + rnd() * 0.5), rch = reach * (0.72 + rnd() * 0.55);
        const pts: V3[] = [], nrm: V3[] = [], hang: boolean[] = [], cov: number[] = [];
        let total = 0;
        for (let i = 0; i <= STEPS; i++) {
            const t = i / STEPS;
            const arc = Math.pow(t, 0.7);                                   // out over the rim, fast at first
            const fall = Math.pow(Math.max(0, (t - 0.22) / 0.78), 1.7);     // then gravity takes over
            const rise = drop * 0.1 * Math.sin(Math.PI * Math.min(1, t * 2.6));
            const wob = (rnd() - 0.5) * size * 0.06 * t;
            const p: V3 = [
                base[0] + dx * rch * arc - dz * wob,
                base[1] + rise - len * fall,
                base[2] + dz * rch * arc + dx * wob,
            ];
            if (i > 0) total += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
            pts.push(p);
            nrm.push([dx, 0, dz]);
            hang.push(t > 0.22);
            cov.push(1);
        }
        paths.push({ pts, nrm, hang, cov, length: total, depth: 0 });
    }
    // ★ Leaf metrics are ABSOLUTE, not a fraction of `size`. A trailing plant's `size` is small (it is a
    // filler), but its leaves are still real 4–7 cm leaves spaced a leaf apart — deriving the spacing
    // from `size` gave a 2 cm pitch and ~40 leaves per strand, which is where the cost ran away.
    const leafSize = clamp(0.036 + size * 0.1, 0.034, 0.095);
    const spec = resolveRunner({
        thickness: size * 0.01, sides: 3,
        // Spacing 1.4 leaf-lengths apart at half density = gaps you can see the wall through. 1.1 apart and a
        // near-full density gives a clothed strand — still ABSOLUTE metres, so the cost never runs away.
        leafSpacing: leafSize * 1.1, leafDensity: 0.72 + dens * 0.28,
        leafSize, leafSizeVar: 0.3, tipScale: 0.35, ageSpan: 0.3, newGrowth: 0.16,
        droop: 0.55, leafLift: 0.18, phyllotaxy: 'alternate', leafShape: 'palmate',
        leafCurve: 0.4, leafFold: 0.15, leafTwist: 0.3, leafSegments: 2,
        lodLevel: lod, maxLeaves: Math.max(1, left),
    });
    const racc: RunnerAccum = {
        stem: acc.stem, leaf: acc.leaf, tip: acc.tip,
        stemFree: acc.stemFree, leafFree: acc.leafFree, tipFree: acc.tipFree,
    };
    const r = buildRunners(racc, { mode: 'paths', paths }, spec, rnd);
    let low = base[1], far = 0;
    for (const path of paths) for (const p of path.pts) {
        low = Math.min(low, p[1] - spec.leafSize);
        far = Math.max(far, Math.hypot(p[0] - base[0], p[2] - base[2]) + spec.leafSize);
    }
    return { top: Math.max(r.height, base[1]), reach: far, leaves: r.leaves, low };
}

// ── The arrangement ──────────────────────────────────────────────────────────────────────────────

/**
 * Plant a vessel: soil + a small composition of identifiable plants over its top surface.
 * Deterministic for a given `rnd` stream, and every root lands inside the vessel footprint.
 */
export function plantingArrangement(acc: PlantingAccum, top: VesselTop, spec: PlantingSpec, rnd: () => number): PlantingResult {
    emitSoil(acc.soil, top);
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, PLANTING_LOD_SCALE.length - 1);
    const dens = clamp01(spec.density);
    const card = spec.card;
    const H = Math.max(0.05, spec.height);
    const maxLeaves = Math.max(1, Math.round(spec.maxLeaves ?? MAX_VESSEL_LEAVES));
    const out: PlantingResult = {
        plants: [], leaves: 0, height: top.centre[1], radius: Math.max(top.halfX, top.halfZ),
        extentX: top.halfX, extentZ: top.halfZ, low: top.centre[1], truncated: false,
    };
    const sd = cfNorm([spec.spillDir[0], 0, spec.spillDir[1]]);
    const slots = layoutSlots(top, spec, rnd);
    // ★ RESERVE budget for the TRAILING plants. The uprights are planted first and, once they got their real
    // leaf mass, they ate the whole vessel budget — the spill (the entire reason a window box reads as a window
    // box) was then truncated to a few leaves. Trailers get a guaranteed share; uprights share what is left.
    const trailing = slots.reduce((n, s) => n + (s.kind === 'trailing' ? 1 : 0), 0);
    const reserve = trailing ? Math.min(Math.round(maxLeaves * 0.4), trailing * 90) : 0;

    for (const slot of slots) {
        if (out.leaves >= maxLeaves) {
            if (!out.truncated) {
                out.truncated = true;
                console.warn(`[planting] vessel leaf budget hit (${maxLeaves}) — remaining plants dropped (foliage-quality.md §7)`);
            }
            break;
        }
        const left = Math.max(1, (slot.kind === 'trailing' ? maxLeaves : maxLeaves - reserve) - out.leaves);
        // Roots sit a hair BELOW the soil plane so nothing floats above it.
        const base: V3 = [top.centre[0] + slot.x, top.centre[1] - 0.005, top.centre[2] + slot.z];
        const size = H * slot.scale;
        // Lean away from the vessel centre (a real plant reaches for the light past the rim).
        const lx = slot.x === 0 && slot.z === 0 ? Math.cos(slot.yaw) : slot.x;
        const lz = slot.x === 0 && slot.z === 0 ? Math.sin(slot.yaw) : slot.z;
        const ll = Math.hypot(lx, lz) || 1;
        const axis: V3 = cfNorm([(lx / ll) * slot.lean, 1, (lz / ll) * slot.lean]);
        let r: PlantOut;
        if (slot.kind === 'shrub') r = plantShrub(acc, base, axis, size, dens, card, lod, left, rnd);
        else if (slot.kind === 'flower') r = plantFlower(acc, base, axis, size, dens, lod, left, rnd);
        else if (slot.kind === 'grass') r = plantGrass(acc, base, size, dens, lod, left, rnd);
        else {
            // The strand's outward direction. A DIRECTIONAL spill (a window box / planter, spread < TAU)
            // always goes over the OUTWARD face — never over the near end, whatever the slot's azimuth.
            // A lone specimen in a pot (spread = TAU) spills radially, all the way round.
            const dir = spec.spillSpread >= TAU - 1e-6
                ? cfNorm([slot.x || Math.cos(slot.yaw), 0, slot.z || Math.sin(slot.yaw)])
                : sd;
            // ★ Reach is the extent along the SPILL AXIS, not the vessel's longest side: a window-box
            // strand arcs ~one box-depth out and then falls — it does not swing half the run length.
            const rch = Math.abs(dir[0]) * top.halfX + Math.abs(dir[2]) * top.halfZ + size * 0.28;
            r = plantTrailing(acc, base, size, rch, spec.spill, dir, spec.spillSpread, dens, lod, left, rnd);
        }
        out.plants.push({ kind: slot.kind, x: slot.x, z: slot.z, scale: slot.scale, top: r.top, reach: r.reach, leaves: r.leaves, trailing: slot.kind === 'trailing' });
        out.leaves += r.leaves;
        out.height = Math.max(out.height, r.top);
        out.low = Math.min(out.low, r.low);
        out.radius = Math.max(out.radius, Math.hypot(base[0] - top.centre[0], base[2] - top.centre[2]) + r.reach);
        out.extentX = Math.max(out.extentX, Math.abs(base[0] - top.centre[0]) + r.reach);
        out.extentZ = Math.max(out.extentZ, Math.abs(base[2] - top.centre[2]) + r.reach);
    }
    return out;
}
