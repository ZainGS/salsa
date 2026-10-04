// ─────────────────────────────────────────────────────────────────────────────
// The `branch` PRIMITIVE (foliage-quality.md §3.5, phase P4) — RECURSIVE LIMBS, plus the two
// terminal recipes that turn limbs into a plant: `emitCanopy` (leaf masses AT THE TIPS, §3.6) and
// `emitHedgeShell` (the clipped-box SHELL — a manicured hedge is a surface, not a row of spheres).
//
// Why it replaces the old constructions: a tree reads as a tree because of BRANCHING with leaf mass
// at the outer twigs, not because of one ball on a stick. The four woody types were
//   · small-tree  — `trunk.beam()` + ONE `foliageClump` sphere      → a lollipop,
//   · bush        — one flattened `foliageClump`                    → a lumpy ball,
//   · shrub       — a short beam + one clump                        → a lumpy ball on a peg,
//   · hedge       — a ROW OF SPHERES (one `mound` per segment)      → exactly not a clipped hedge.
//
// ★ REUSE, not reinvention. Every limb is swept with `emitTube` **exported from stalk.ts** (a branch
// IS a tapered tube — there is one tube sweep in the codebase and this is it) over a `bezierSpine`
// carried by `sweepFrames` parallel transport (curve-frame.ts, the same module hair cards, grass
// blades, stems and ivy runners ride). Every leaf is `emitBlade` (blade.ts) with the P2 `axis`/`out`/
// `pitch` generalisation, so a canopy leaf, a petal and a grass blade are the same 40-line sweep.
// The canopy's non-spherical envelope uses `fbm2` from ground-masks.ts — the same noise the ground
// material and the P5 scatter already share.
//
// The knobs that make a woody plant read as itself:
//   · `levels` / `splitCount`    — how deep and how bushy the recursion goes,
//   · `lengthDecay`/`radiusDecay`— children are shorter AND thinner than their parent (monotonic),
//   · `gnarl` / `wander`         — ★ branches are NOT straight and their children are not on a ring,
//   · `upBias`                   — limbs curve back toward the light, which is most of the silhouette,
//   · `stems`                    — 1 = a trunk (tree), 4–6 = a multi-stem fan from the base (a bush).
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { bezierSpine, sweepFrames, sweepParams, cfCross, cfDot, cfNorm, perpFrame, type V3 } from './curve-frame';
import { emitTube } from './stalk';
import { emitBlade, type BladeShape } from './blade';
import { fbm2 } from './ground-masks';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Split-count multiplier per LOD band (§2.5) — the branch analogue of `BLADE_LOD_SCALE`. */
export const BRANCH_LOD_SCALE = [1, 0.62, 0.38];
/** Leaf/blob-count multiplier per LOD band for the canopy + hedge shell. */
export const LEAF_LOD_SCALE = [1, 0.55, 0.3];
/** Hard cap on limbs in ONE plant — truncation is LOGGED, never silent (§7). */
export const MAX_LIMBS_PER_PLANT = 320;
/** Hard cap on leaves (or leaf blobs) in ONE plant — likewise logged. */
export const MAX_LEAVES_PER_PLANT = 1200;

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 — the recursive limb skeleton
// ─────────────────────────────────────────────────────────────────────────────

export interface BranchSpec {
    /** Recursion depth: 0 = a bare trunk · 1 = trunk + limbs · 3 = trunk → limbs → branches → twigs. */
    levels: number;
    /** Children thrown by each non-terminal limb. */
    splitCount: number;
    /** ± integer jitter on `splitCount` (0 = every node splits identically). */
    splitCountVar: number;
    /** Radians a child leaves its parent's tangent by. */
    splitAngle: number;
    /** ± fraction on `splitAngle`. */
    splitAngleVar: number;
    /** Child length = parent length × this. < 1 (monotonic decay). */
    lengthDecay: number;
    /** Child base radius = the parent's radius at the attachment × this. < 1. */
    radiusDecay: number;
    /** Trunk length (m). */
    length: number;
    /** ± fraction applied to every limb's length (0 = perfectly regular, for tests). */
    lengthVar: number;
    /** Trunk base radius (m). */
    startRadius: number;
    /** A limb's own tip radius as a FRACTION of its base radius (the taper of one limb). */
    tipTaper: number;
    /** ★ Sideways bend of a limb's OWN spine, 0..1 — branches are not straight. */
    gnarl: number;
    /** Azimuthal jitter of a child's direction, 0..1 (1 = fully random around the parent). */
    wander: number;
    /** ★ Limbs curve back toward +Y along their length (phototropism), 0..1. */
    upBias: number;
    /** Lean of the trunk away from vertical, 0..1. */
    lean: number;
    /** FRACTION along the parent where the LOWEST child attaches (1 = all children at the very tip). */
    attachStart: number;
    /** Spine subdivisions per limb. */
    segments: number;
    /** Tube sides (3–6; a branch is seen from metres away). */
    sides: number;
    /** ★ Independent limbs fanned from the BASE: 1 = a single trunk (tree), 4–6 = a multi-stem bush. */
    stems: number;
    /** Radians the base stems splay from vertical (`stems` > 1 only). */
    stemAngle: number;
    /** Radius (m) the base stems fan over. */
    stemSpread: number;
    /** Seed — when given, the primitive builds its OWN rng and ignores the caller's (deterministic per seed). */
    seed?: number;
    /** 0 near · 1 mid · 2 far — thins `splitCount` (§2.5). */
    lodLevel?: number;
    maxLimbs?: number;
}

export const DEFAULT_BRANCH: BranchSpec = {
    levels: 2, splitCount: 3, splitCountVar: 0, splitAngle: 0.62, splitAngleVar: 0.3,
    lengthDecay: 0.66, radiusDecay: 0.62, length: 1, lengthVar: 0.18, startRadius: 0.05, tipTaper: 0.55,
    gnarl: 0.35, wander: 0.35, upBias: 0.3, lean: 0.06, attachStart: 0.5,
    segments: 4, sides: 4, stems: 1, stemAngle: 0.34, stemSpread: 0.08,
};

export function resolveBranch(partial: Partial<BranchSpec> = {}): BranchSpec {
    return { ...DEFAULT_BRANCH, ...partial };
}

/** One terminal twig END — exactly where a leaf mass belongs (§3.5 "leaf clumps at the tips"). */
export interface BranchTip {
    /** World position of the twig's end. */
    p: V3;
    /** Unit growth direction there (the twig's tangent at its end). */
    dir: V3;
    /** Recursion depth of the limb that produced it (0 = the trunk itself). */
    depth: number;
    /** The twig's end radius — cluster size can scale with it. */
    radius: number;
    /** The twig's length. */
    length: number;
}

export interface BranchResult {
    /** Limbs actually swept (trunk included). */
    limbs: number;
    /** Terminal tips, in emission order. */
    tips: BranchTip[];
    /** Max world Y touched by the woody skeleton. */
    height: number;
    /** Max horizontal distance from the plant's base. */
    radius: number;
    /** Deepest level reached. */
    depth: number;
    /** Every swept limb's spine (bezier control points), in emission order — what {@link emitSprigCrown}
     *  grows its twig sprays along. Cheap (one small record per limb, capped by `maxLimbs`). */
    spines: BranchSpine[];
}

/** One swept limb, kept so a crown can hang leaves ALONG the wood rather than beside it. */
export interface BranchSpine {
    /** Quadratic bezier: base, control, end (the limb's own spine, gnarl + upBias included). */
    a: V3; c: V3; e: V3;
    depth: number;
    length: number;
    /** Base / tip radius of the tube. */
    r0: number; r1: number;
    /** True when this limb ended the recursion (it is one of `tips`). */
    terminal: boolean;
}

export interface BranchPlacement { base: V3; axis?: V3; ref?: V3 }

interface LimbBudget { left: number; warned: boolean }

/** Mulberry32 — the same generator `building-geom` uses, inlined so `seed` works without a cross-import. */
function rngFor(seed: number): () => number {
    let a = (seed | 0) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A unit direction ⊥ `tan`, at azimuth `a` in the (ref, bino) plane. */
function radialDir(tan: V3, ref: V3, bino: V3, a: number): V3 {
    const ca = Math.cos(a), sa = Math.sin(a);
    const d: V3 = [ref[0] * ca + bino[0] * sa, ref[1] * ca + bino[1] * sa, ref[2] * ca + bino[2] * sa];
    const k = cfDot(d, tan);
    const perp: V3 = [d[0] - tan[0] * k, d[1] - tan[1] * k, d[2] - tan[2] * k];
    return Math.hypot(perp[0], perp[1], perp[2]) > 1e-6 ? cfNorm(perp) : perpFrame(tan).u;
}

/**
 * Sweep a recursive branch skeleton into `acc` (local metres; `at.base` is the root). Returns the TIP
 * frames so the caller can hang leaf masses exactly where foliage belongs — see {@link emitCanopy}.
 *
 * Deterministic: the same `spec.seed` (or the same `rnd` stream) rebuilds it vertex-for-vertex.
 */
export function emitBranch(acc: Accum3D, spec: BranchSpec, at: BranchPlacement, rnd: () => number): BranchResult {
    const R = spec.seed !== undefined ? rngFor(Math.imul(spec.seed | 0, 0x9e3779b1)) : rnd;
    const out: BranchResult = { limbs: 0, tips: [], height: at.base[1], radius: 0, depth: 0, spines: [] };
    const budget: LimbBudget = { left: Math.max(1, Math.round(spec.maxLimbs ?? MAX_LIMBS_PER_PLANT)), warned: false };
    const nStem = Math.max(1, Math.round(spec.stems));
    const axis0 = cfNorm(at.axis ?? [0, 1, 0]);
    const ref0 = at.ref ? cfNorm(at.ref) : perpFrame(axis0).u;

    if (nStem === 1) {
        // A single TRUNK, leaning a little off vertical (a real trunk is never plumb).
        const la = R() * TAU, ln = clamp01(spec.lean);
        const axis = cfNorm([axis0[0] + Math.cos(la) * ln, axis0[1], axis0[2] + Math.sin(la) * ln]);
        emitLimb(acc, spec, at.base, axis, radialDir(axis, ref0, cfNorm(cfCross(axis, ref0)), la), spec.length, spec.startRadius, 0, at.base, out, budget, R);
    } else {
        // ★ A MULTI-STEM FAN from the base — how a real bush is built: several stems leaving the crown
        // of the root, not one central stick. Each stem is a full recursive limb of its own.
        for (let k = 0; k < nStem; k++) {
            const a = k * GOLDEN_ANGLE + R() * spec.wander * 1.4;
            const rr = spec.stemSpread * Math.sqrt((k + 0.5) / nStem);
            const base: V3 = [at.base[0] + Math.cos(a) * rr, at.base[1], at.base[2] + Math.sin(a) * rr];
            const ang = spec.stemAngle * (0.55 + R() * 0.9);
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const axis = cfNorm([axis0[0] * ca + Math.cos(a) * sa, axis0[1] * ca, axis0[2] * ca + Math.sin(a) * sa]);
            const ref: V3 = [Math.cos(a), 0, Math.sin(a)];
            const len = spec.length * (1 + (R() * 2 - 1) * spec.lengthVar * 1.4);
            emitLimb(acc, spec, base, axis, radialDir(axis, ref, cfNorm(cfCross(axis, ref)), 0), len, spec.startRadius, 0, at.base, out, budget, R);
        }
    }
    return out;
}

function emitLimb(
    acc: Accum3D, spec: BranchSpec, base: V3, axis: V3, ref: V3,
    length: number, radius: number, depth: number, origin: V3,
    out: BranchResult, budget: LimbBudget, rnd: () => number,
): void {
    // ── The limb CAP (§7): checked BEFORE anything is emitted, so `limbs` can never exceed `maxLimbs`
    //    and the truncation is logged rather than silently swallowing a whole sub-tree.
    if (budget.left <= 0) {
        if (!budget.warned) {
            budget.warned = true;
            console.warn(`[branch] limb budget hit (${spec.maxLimbs ?? MAX_LIMBS_PER_PLANT}) — deeper limbs dropped (foliage-quality.md §7)`);
        }
        return;
    }
    budget.left--;
    const L = Math.max(1e-4, length * (1 + (rnd() * 2 - 1) * Math.max(0, spec.lengthVar)));
    const r0 = Math.max(1e-4, radius);
    const r1 = Math.max(1e-5, r0 * clamp(spec.tipTaper, 0.05, 1));
    const bino = cfNorm(cfCross(axis, ref));
    const gn = clamp01(spec.gnarl), up = clamp01(spec.upBias);

    // ── The limb's own SPINE. A straight beam is the tell of a procedural tree: the control point is
    // pushed sideways by `gnarl` and the end is pulled back toward +Y by `upBias` (phototropism).
    const g1 = (rnd() * 2 - 1) * gn * L * 0.3, g2 = (rnd() * 2 - 1) * gn * L * 0.22;
    const A: V3 = [base[0], base[1], base[2]];
    const C: V3 = [
        A[0] + axis[0] * L * 0.45 + ref[0] * g1 + bino[0] * g2,
        A[1] + axis[1] * L * 0.45 + ref[1] * g1 + bino[1] * g2,
        A[2] + axis[2] * L * 0.45 + ref[2] * g1 + bino[2] * g2,
    ];
    const gx = (rnd() * 2 - 1) * gn * L * 0.24, gz = (rnd() * 2 - 1) * gn * L * 0.24;
    const E: V3 = [
        A[0] + axis[0] * L + ref[0] * gx + bino[0] * gz,
        A[1] + axis[1] * L + up * L * 0.34 * (1 - Math.abs(axis[1])) + ref[1] * gx + bino[1] * gz,
        A[2] + axis[2] * L + ref[2] * gx + bino[2] * gz,
    ];
    const spine = bezierSpine(A, C, E);
    // Built-in depth LOD: a twig is 2 segments × 3 sides, a trunk is the full spec. Without this the
    // recursion's leaf level (which is most of the limbs) dominates the triangle budget for nothing.
    const segs = Math.max(2, Math.round(spec.segments) - depth);
    const frames = sweepFrames(spine, sweepParams(segs));
    emitTube(acc, frames, r0, r1, Math.max(3, Math.round(spec.sides) - depth));
    out.limbs++;
    if (depth > out.depth) out.depth = depth;
    for (const f of frames) {
        if (f.p[1] + r0 > out.height) out.height = f.p[1] + r0;
        out.radius = Math.max(out.radius, Math.hypot(f.p[0] - origin[0], f.p[2] - origin[2]) + r1);
    }

    const tan = spine.tangent(1);
    const terminal = depth >= Math.max(0, Math.round(spec.levels));
    out.spines.push({ a: A, c: C, e: E, depth, length: L, r0, r1, terminal });
    if (terminal) {
        out.tips.push({ p: [E[0], E[1], E[2]], dir: tan, depth, radius: r1, length: L });
        return;
    }

    // ── CHILDREN. They attach along the upper `attachStart..1` of the shaft (not all at the tip — a
    // real limb sheds branches along its length), at golden-angle azimuths with `wander` jitter.
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, BRANCH_LOD_SCALE.length - 1);
    let n = Math.round(spec.splitCount * BRANCH_LOD_SCALE[lod]);
    if (spec.splitCountVar > 0) n += Math.round((rnd() * 2 - 1) * spec.splitCountVar);
    n = Math.max(1, n);
    const aStart = clamp01(spec.attachStart);
    for (let i = 0; i < n; i++) {
        const t = clamp(aStart + ((i + 0.5) / n) * (1 - aStart), 0.05, 1);
        const p = spine.at(t), pt = spine.tangent(t);
        const a = (out.limbs * 2 + i) * GOLDEN_ANGLE + (rnd() - 0.5) * spec.wander * TAU;
        const dir = radialDir(pt, ref, bino, a);
        const ang = Math.max(0.05, spec.splitAngle * (1 + (rnd() * 2 - 1) * spec.splitAngleVar));
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const childAxis = cfNorm([pt[0] * ca + dir[0] * sa, pt[1] * ca + dir[1] * sa, pt[2] * ca + dir[2] * sa]);
        const rAt = r0 + (r1 - r0) * t;
        emitLimb(acc, spec, p, childAxis, dir, L * spec.lengthDecay, rAt * spec.radiusDecay, depth + 1, origin, out, budget, rnd);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6 — leafCard / clump: the LEAF MASSES that sit at the tips
// ─────────────────────────────────────────────────────────────────────────────

/** One leaf's geometry, shared by the canopy and the hedge shell. A leaf IS a `blade` (§3.2). */
export interface LeafGeom {
    length: number;
    /** ± fraction on `length`. */
    lengthVar: number;
    width: number;
    shape: BladeShape;
    curve: number;
    fold: number;
    twist: number;
    segments: number;
    /** Opening angle (rad) from the leaf's outward axis: 0 = points straight out, ~π/2 = lies flat. */
    pitch: number;
    pitchVar: number;
}

export const DEFAULT_LEAF: LeafGeom = {
    length: 0.09, lengthVar: 0.3, width: 0.05, shape: 'palmate',
    curve: 0.4, fold: 0.18, twist: 0.3, segments: 3, pitch: 1.0, pitchVar: 0.5,
};

/** Leaves / blobs are budgeted per PLANT so a dense tree cannot silently explode (§7). */
export interface LeafBudget { left: number; warned: boolean }
export function leafBudget(max = MAX_LEAVES_PER_PLANT): LeafBudget {
    return { left: Math.max(1, Math.round(max)), warned: false };
}

export interface LeafClusterSpec {
    /** Cluster envelope radius (m). */
    radius: number;
    /** 0..1 fullness → leaf / blob count. */
    density: number;
    /** ★ 0..1 how far the envelope deviates from a SPHERE — the anti-ball term. */
    irregular: number;
    /** Vertical squash of the envelope (1 = round, 0.7 = a flattened pad). */
    flatten: number;
    /** Fraction of leaves routed to the lighter new-growth `tip` accumulator. */
    tipFrac: number;
    /** `blade` = real swept leaves (the quality/`card` lean) · `chunky` = the low-poly blob mound. */
    mode: 'blade' | 'chunky';
    leaf: LeafGeom;
    /** 0 near · 1 mid · 2 far — thins the leaf count (§2.5). */
    lodLevel?: number;
}

export interface ClusterResult { leaves: number; top: number; reach: number }

/**
 * Fill ONE small irregular volume with leaves — the terminal of a branch. The envelope is a
 * `fbm2`-lobed, flattened blob rather than a sphere, and leaves are pushed toward its OUTER shell
 * (`0.42 + 0.58·cbrt(u)`), because a real leaf mass is a skin over shadowed air, not a solid ball.
 *
 * `key` seeds the envelope's noise, so each cluster on a plant has its own lobes (and the same key
 * always gives the same lobes — determinism).
 */
export function emitLeafCluster(
    leaf: Accum3D, tip: Accum3D | null, centre: V3, spec: LeafClusterSpec, rnd: () => number,
    key = 0, budget?: LeafBudget,
): ClusterResult {
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, LEAF_LOD_SCALE.length - 1);
    const R = Math.max(1e-4, spec.radius);
    const dens = clamp01(spec.density);
    const irr = clamp01(spec.irregular);
    const flat = clamp(spec.flatten, 0.2, 1.6);
    const want = spec.mode === 'chunky'
        ? Math.round((3 + dens * 6) * LEAF_LOD_SCALE[lod])
        : Math.round((6 + dens * 16) * LEAF_LOD_SCALE[lod]);
    const n = Math.max(1, want);
    const res: ClusterResult = { leaves: 0, top: centre[1], reach: 0 };
    for (let i = 0; i < n; i++) {
        if (budget) {
            if (budget.left <= 0) {
                if (!budget.warned) { budget.warned = true; console.warn(`[branch] leaf budget hit — extra leaves dropped (foliage-quality.md §7)`); }
                break;
            }
            budget.left--;
        }
        const th = rnd() * TAU, cph = 2 * rnd() - 1, sph = Math.sqrt(Math.max(0, 1 - cph * cph));
        const dir: V3 = [sph * Math.cos(th), cph, sph * Math.sin(th)];
        // ★ NON-SPHERICAL ENVELOPE: a smooth 2-octave lobe field over (azimuth, elevation).
        const lobe = fbm2(th * 1.7 + key * 3.7, cph * 2.1 + key * 2.3);
        const env = R * (1 - irr * 0.5 + irr * 1.05 * lobe);
        const rr = env * (0.42 + 0.58 * Math.cbrt(rnd()));      // outer-shell bias → a hollow, gappy mass
        const p: V3 = [centre[0] + dir[0] * rr, centre[1] + dir[1] * rr * flat, centre[2] + dir[2] * rr];
        const target = (tip && rnd() < spec.tipFrac) ? tip : leaf;
        if (spec.mode === 'chunky') {
            const br = R * (0.2 + rnd() * 0.16);
            target.blob(p, br, br * 0.95, br, 0.55, (rnd() * 1e4) | 0);
            // `blob`'s 0.55 jitter pushes a vertex up to 1.55× its radius — the bound must cover it, or
            // `meta.height` / `meta.footprint` end up smaller than the geometry they describe.
            res.top = Math.max(res.top, p[1] + br * 1.6);
            res.reach = Math.max(res.reach, Math.hypot(p[0] - centre[0], p[2] - centre[2]) + br * 1.6);
        } else {
            const g = spec.leaf;
            const out = perpAny(dir, rnd);
            const len = Math.max(1e-3, g.length * (1 + (rnd() * 2 - 1) * g.lengthVar));
            const y = emitBlade(target, null, 1, p, dir[0], dir[2], {
                length: len, width: g.width * (0.8 + rnd() * 0.45), taper: 0.3,
                curve: g.curve * (0.6 + rnd() * 0.8), segments: g.segments,
                twist: g.twist * (rnd() < 0.5 ? -1 : 1), foldAngle: g.fold, lean: 0,
                shape: g.shape, pitch: Math.max(0, g.pitch * (1 + (rnd() * 2 - 1) * g.pitchVar)),
                axis: dir, out,
            });
            res.top = Math.max(res.top, y + g.width);          // the strip is `width` across the spine
            res.reach = Math.max(res.reach, Math.hypot(p[0] - centre[0], p[2] - centre[2]) + len * 1.15);
        }
        res.leaves++;
    }
    return res;
}

/** Any unit vector ⊥ `d`, at a random roll. */
function perpAny(d: V3, rnd: () => number): V3 {
    const { u, v } = perpFrame(d);
    const a = rnd() * TAU, ca = Math.cos(a), sa = Math.sin(a);
    return cfNorm([u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa]);
}

export interface CanopySpec extends LeafClusterSpec {
    /** ★ Probability a tip is left BARE — the see-through gaps into a shadowed interior. */
    gapChance: number;
    /** ± fraction of per-cluster size variation (an even canopy reads as a ball). */
    sizeVar: number;
    /** Cluster radius multiplier for tips near the plant's own axis — thins the (unseen) interior. */
    innerScale: number;
    /** Extra gap probability applied to interior tips on top of `gapChance`. */
    innerGap: number;
    /** Push each cluster this far along its twig's direction (leaf mass sits BEYOND the tip). */
    tipPush: number;
}

export const DEFAULT_CANOPY: CanopySpec = {
    radius: 0.22, density: 0.6, irregular: 0.55, flatten: 0.88, tipFrac: 0.3, mode: 'chunky',
    leaf: DEFAULT_LEAF, gapChance: 0.12, sizeVar: 0.35, innerScale: 0.6, innerGap: 0.3, tipPush: 0.35,
};

export interface CanopyResult { clusters: number; leaves: number; height: number; radius: number }

/**
 * Hang a leaf mass on every branch TIP (§3.5 "leaf clumps at the tips"). This — not one central
 * sphere — is what gives a woody plant a silhouette: many small irregular masses at the outer twigs,
 * with interior tips thinned or skipped so you can see through to a shadowed core.
 */
export function emitCanopy(
    leaf: Accum3D, tip: Accum3D | null, tips: readonly BranchTip[], spec: CanopySpec,
    rnd: () => number, origin: V3 = [0, 0, 0], budget?: LeafBudget,
): CanopyResult {
    const res: CanopyResult = { clusters: 0, leaves: 0, height: origin[1], radius: 0 };
    if (!tips.length) return res;
    // How far out each tip sits, so "interior" can mean something.
    let maxR = 1e-4;
    for (const t of tips) maxR = Math.max(maxR, Math.hypot(t.p[0] - origin[0], t.p[2] - origin[2]));
    for (let i = 0; i < tips.length; i++) {
        const t = tips[i];
        const rel = clamp01(Math.hypot(t.p[0] - origin[0], t.p[2] - origin[2]) / maxR);
        const inner = 1 - rel;                                  // 1 = dead centre, 0 = the rim
        if (rnd() < spec.gapChance + spec.innerGap * inner * inner) continue;
        const push = t.length * spec.tipPush;
        const c: V3 = [t.p[0] + t.dir[0] * push, t.p[1] + t.dir[1] * push, t.p[2] + t.dir[2] * push];
        const scale = (1 + (rnd() * 2 - 1) * spec.sizeVar) * (spec.innerScale + (1 - spec.innerScale) * (0.35 + 0.65 * rel));
        const r = emitLeafCluster(leaf, tip, c, { ...spec, radius: spec.radius * Math.max(0.15, scale) }, rnd, i + 1, budget);
        res.clusters++;
        res.leaves += r.leaves;
        res.height = Math.max(res.height, r.top);
        res.radius = Math.max(res.radius, Math.hypot(c[0] - origin[0], c[2] - origin[2]) + r.reach);
    }
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6b — the SPRIG CROWN: many small alpha-cut leaf cards grown ON fine twigs
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ WHY. `emitCanopy` hangs a leaf CLUSTER VOLUME beyond each twig tip — right for a bush seen from a
// metre away, wrong for a street tree: at tree scale the volume is ~1.3 m across and its ~20 leaves (each
// ~0.5 m) scatter through it, so what you see is a bare skeleton with a few huge leaves floating in the
// air near it. A real crown is the opposite: thousands of SMALL leaves, every one on a twig, the twigs on
// the branches. So this grows the last branch level on into fine TWIGLETS (2-tri tapered ribbons — you read
// them as structure, not as tubes) and lines each twiglet with small leaf CARDS whose base sits ON it.
// A card is 2 triangles cut in the shader (`leafCard`, the 5-leaf `leafCluster` silhouette), so the
// same triangle budget that bought ~450 swept half-metre blades buys ~2 000 sprigs ≈ 10 000 leaves.
//
// The card normals are BENT toward the crown's outward direction (the standard foliage trick): lit as
// one volume, the crown reads as a mass with a lit top and a shaded underside instead of as noise.

/** Hard cap on sprig cards in ONE plant (2 tris each) — logged like every other budget (§7). */
export const MAX_SPRIG_CARDS_PER_PLANT = 4200;

export interface SprigCrownSpec {
    /** Leaf-card edge (m). The shader cuts it to a sprig of ~5 leaves, the longest ≈ 0.85× this. */
    cardSize: number;
    /** ± fraction on `cardSize`. */
    cardSizeVar: number;
    /** Fine twiglets along each TERMINAL limb's leafy span (its last one continues the tip). */
    twigsPerTip: number;
    /** Twiglets along each limb ONE level up — fills the crown between the tips. */
    twigsPerLimb: number;
    /** Twiglet length (m). */
    twigLength: number;
    /** Twiglet base radius (m) — clamped to the carrying limb's own radius there. */
    twigRadius: number;
    /** Leaf cards along each twiglet (+1 at its end). */
    cardsPerTwig: number;
    /** Cards directly on a carrying limb, per metre of its leafy span — the wood is leafed, not bare. */
    cardsPerMetre: number;
    /** 0..1 how hard twiglets lean AWAY from the plant axis — fills the crown out past the skeleton. */
    spread: number;
    /** −1..1: twiglets climb toward the light (+) or weep (−, sakura). */
    twigLift: number;
    /** 0..1 how much cards face the SKY (layered, flat-topped sprays) vs outward from the crown. */
    skyFacing: number;
    /** Probability a terminal limb is left BARE (see-through gaps into the crown). */
    gapChance: number;
    /** Extra bare probability for interior limbs (grows with nearness to the plant's axis). */
    innerGap: number;
    /** Fraction of cards routed to the lighter new-growth `tip` accumulator (biased to the twig ends). */
    tipFrac: number;
    /** 0 near · 1 mid · 2 far — fewer, proportionally LARGER cards (coverage is kept, detail drops). */
    lodLevel?: number;
}

export const DEFAULT_SPRIG_CROWN: SprigCrownSpec = {
    cardSize: 0.16, cardSizeVar: 0.3, twigsPerTip: 6, twigsPerLimb: 4, twigLength: 0.6, twigRadius: 0.009, spread: 0.55,
    cardsPerTwig: 8, cardsPerMetre: 10, twigLift: 0.25, skyFacing: 0.35, gapChance: 0.06, innerGap: 0.3, tipFrac: 0.32,
};

export interface SprigCrownResult { twigs: number; cards: number; height: number; radius: number }

/**
 * Grow a SPRIG CROWN on an emitted branch skeleton: twiglets into `wood`, leaf cards into `leaf` / `tip`.
 * Carriers are the terminal limbs plus the level above them (never the trunk). Deterministic in `rnd`.
 */
export function emitSprigCrown(
    wood: Accum3D, leaf: Accum3D, tip: Accum3D | null, branch: BranchResult, spec: SprigCrownSpec,
    rnd: () => number, origin: V3 = [0, 0, 0], budget?: LeafBudget,
): SprigCrownResult {
    const res: SprigCrownResult = { twigs: 0, cards: 0, height: origin[1], radius: 0 };
    const deepest = branch.depth;
    const carriers = branch.spines.filter((sp) => sp.terminal || (sp.depth > 0 && sp.depth >= deepest - 1));
    if (!carriers.length) return res;
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, LEAF_LOD_SCALE.length - 1);
    const kN = LEAF_LOD_SCALE[lod], kS = 1 / Math.sqrt(kN);     // fewer cards per twig → larger, same coverage
    // ★ The branch LOD already thinned the skeleton (splitCount × BRANCH_LOD_SCALE, so ~1/3 the tips at mid). A
    // LOD variant still stands beside full ones on the same avenue, so it must keep a FULL crown: each surviving
    // carrier grows proportionally more twiglets (≈ the lost tips back), and only the cards per twig thin out.
    const kT = lod > 0 ? 0.8 / (BRANCH_LOD_SCALE[lod] * BRANCH_LOD_SCALE[lod]) : 1;

    // Crown frame from the carriers' ends: centre + half-extents → the outward direction at any point.
    let cx = 0, cy = 0, cz = 0;
    for (const sp of carriers) { cx += sp.e[0]; cy += sp.e[1]; cz += sp.e[2]; }
    cx /= carriers.length; cy /= carriers.length; cz /= carriers.length;
    let rH = 1e-3, rV = 1e-3, maxR = 1e-4;
    for (const sp of carriers) {
        rH = Math.max(rH, Math.hypot(sp.e[0] - cx, sp.e[2] - cz));
        rV = Math.max(rV, Math.abs(sp.e[1] - cy));
        maxR = Math.max(maxR, Math.hypot(sp.e[0] - origin[0], sp.e[2] - origin[2]));
    }
    // A slight +Y lean: sky light is what a crown's normals should mostly catch.
    const outward = (p: V3): V3 => cfNorm([(p[0] - cx) / rH, (p[1] - cy) / rV + 0.3, (p[2] - cz) / rH]);
    const sky = clamp01(spec.skyFacing);
    const S0 = Math.max(1e-3, spec.cardSize) * kS;

    const bound = (p: V3): void => {
        if (p[1] > res.height) res.height = p[1];
        res.radius = Math.max(res.radius, Math.hypot(p[0] - origin[0], p[2] - origin[2]));
    };
    /** One sprig card whose STEM (uv ≈ 0.5, 0.12 — where the shader's five leaves meet) sits at `q`. */
    const card = (q: V3, u0: V3, toTip: boolean): boolean => {
        if (budget) {
            if (budget.left <= 0) {
                if (!budget.warned) { budget.warned = true; console.warn(`[branch] sprig card budget hit — extra leaves dropped (foliage-quality.md §7)`); }
                return false;
            }
            budget.left--;
        }
        const S = S0 * (1 + (rnd() * 2 - 1) * spec.cardSizeVar);
        const u = cfNorm(u0), o = outward(q);
        const j = 0.9;
        const f: V3 = [o[0] * (1 - sky) + (rnd() - 0.5) * j, o[1] * (1 - sky) + sky + (rnd() - 0.5) * j, o[2] * (1 - sky) + (rnd() - 0.5) * j];
        let w = cfCross(u, f);
        w = Math.hypot(w[0], w[1], w[2]) > 1e-4 ? cfNorm(w) : perpFrame(u).u;
        let n = cfCross(w, u);
        if (cfDot(n, o) < 0) n = [-n[0], -n[1], -n[2]];
        const hw = S * 0.5;
        const b: V3 = [q[0] - u[0] * S * 0.12, q[1] - u[1] * S * 0.12, q[2] - u[2] * S * 0.12];
        const P = (sw: number, su: number): V3 => [b[0] + w[0] * hw * sw + u[0] * S * su, b[1] + w[1] * hw * sw + u[1] * S * su, b[2] + w[2] * hw * sw + u[2] * S * su];
        const target = toTip && tip ? tip : leaf;
        const vx = (p: V3, uu: number, vv: number): number => {
            const ob = outward(p);
            bound(p);
            return target.vertex(p, cfNorm([n[0] * 0.45 + ob[0] * 0.55, n[1] * 0.45 + ob[1] * 0.55, n[2] * 0.45 + ob[2] * 0.55]), uu, vv);
        };
        const v0 = vx(P(-1, 0), 0, 0), v1 = vx(P(1, 0), 1, 0), v2 = vx(P(1, 1), 1, 1), v3 = vx(P(-1, 1), 0, 1);
        target.triangle(v0, v1, v2); target.triangle(v0, v2, v3);
        res.cards++;
        return true;
    };
    /** A leaf direction leaving an axis `tan` sideways at azimuth `a` (leaves splay off their twig). */
    const splay = (tan: V3, a: number, along: number): V3 => {
        const { u, v } = perpFrame(tan);
        const ca = Math.cos(a), sa = Math.sin(a);
        return cfNorm([
            tan[0] * along + (u[0] * ca + v[0] * sa) * 0.85 + (rnd() - 0.5) * 0.3,
            tan[1] * along + (u[1] * ca + v[1] * sa) * 0.85 + 0.2 + (rnd() - 0.5) * 0.3,
            tan[2] * along + (u[2] * ca + v[2] * sa) * 0.85 + (rnd() - 0.5) * 0.3,
        ]);
    };

    let leafIdx = 0;
    for (const sp of carriers) {
        if (sp.terminal) {
            const rel = clamp01(Math.hypot(sp.e[0] - origin[0], sp.e[2] - origin[2]) / maxR);
            const inner = 1 - rel;
            if (rnd() < spec.gapChance + spec.innerGap * inner * inner) continue;   // a bare twig: see-through gap
        }
        const spine = bezierSpine(sp.a, sp.c, sp.e);
        const tStart = sp.terminal ? 0.3 : 0.5;
        // ── Cards directly on the carrying limb's leafy span.
        const nL = Math.round(spec.cardsPerMetre * sp.length * (1 - tStart) * kN * Math.sqrt(kT));
        for (let i = 0; i < nL; i++) {
            const t = tStart + (1 - tStart) * (i + rnd()) / nL;
            if (!card(spine.at(t), splay(spine.tangent(t), (leafIdx++) * GOLDEN_ANGLE, 0.45), false)) return res;
        }
        // ── TWIGLETS along the span; on a terminal limb the last one continues the tip.
        const nT = Math.max(1, Math.round((sp.terminal ? spec.twigsPerTip : spec.twigsPerLimb) * kT));
        for (let j = 0; j < nT; j++) {
            const last = sp.terminal && j === nT - 1;
            const t = last ? 1 : tStart + (1 - tStart) * (j + 0.15 + rnd() * 0.7) / nT;
            const p = spine.at(t), tan = spine.tangent(t);
            const { u: pu, v: pv } = perpFrame(tan);
            const az = (res.twigs + j) * GOLDEN_ANGLE + rnd() * 1.2;
            const ca = Math.cos(az), sa = Math.sin(az), along = last ? 1.1 : 0.55;
            // ★ SPREAD: twiglets lean away from the plant's axis — that is what fills the crown OUT to a
            // silhouette instead of hugging the (narrow) branch skeleton.
            const hx = p[0] - origin[0], hz = p[2] - origin[2], hl = Math.hypot(hx, hz) || 1;
            const spr = spec.spread;
            const dir = cfNorm([
                tan[0] * along + (pu[0] * ca + pv[0] * sa) * 0.8 + (hx / hl) * spr,
                tan[1] * along + (pu[1] * ca + pv[1] * sa) * 0.8 + spec.twigLift * 0.45,
                tan[2] * along + (pu[2] * ca + pv[2] * sa) * 0.8 + (hz / hl) * spr,
            ]);
            const len = Math.max(0.02, spec.twigLength * (0.65 + rnd() * 0.7));
            const end: V3 = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
            const tw = bezierSpine(p, [(p[0] + end[0]) / 2, (p[1] + end[1]) / 2, (p[2] + end[2]) / 2], end);
            // ★ A twiglet is a tapered RIBBON (2 tris), not a tube (6): it is millimetres thick — sub-pixel at any
            // city camera — so its whole job is to be the visible line the leaves hang from. Faced toward the
            // crown's outside (where it is seen from); the material is double-sided.
            const rootR = Math.max(1e-4, Math.min(spec.twigRadius, (sp.r0 + (sp.r1 - sp.r0) * t) * 0.8));
            const o = outward(p);
            let bw = cfCross(dir, o);
            bw = Math.hypot(bw[0], bw[1], bw[2]) > 1e-4 ? cfNorm(bw) : perpFrame(dir).u;
            const rn = cfNorm(cfCross(bw, dir));
            const r1 = rootR * 0.35;
            const w0 = wood.vertex([p[0] - bw[0] * rootR, p[1] - bw[1] * rootR, p[2] - bw[2] * rootR], rn, 0, 0);
            const w1 = wood.vertex([p[0] + bw[0] * rootR, p[1] + bw[1] * rootR, p[2] + bw[2] * rootR], rn, 1, 0);
            const w2 = wood.vertex([end[0] + bw[0] * r1, end[1] + bw[1] * r1, end[2] + bw[2] * r1], rn, 1, 1);
            const w3 = wood.vertex([end[0] - bw[0] * r1, end[1] - bw[1] * r1, end[2] - bw[2] * r1], rn, 0, 1);
            wood.triangle(w0, w1, w2); wood.triangle(w0, w2, w3);
            res.twigs++;
            bound(end);
            const nC = Math.max(1, Math.round(spec.cardsPerTwig * kN));
            for (let i = 0; i < nC; i++) {
                const s = 0.2 + 0.8 * (i + 0.5) / nC;
                if (!card(tw.at(s), splay(tw.tangent(s), (leafIdx++) * GOLDEN_ANGLE, 0.55), rnd() < spec.tipFrac * (0.4 + s))) return res;
            }
            // The terminal sprig continues the twig itself — every twig ENDS in leaves.
            if (!card(end, splay(tw.tangent(1), rnd() * TAU, 2.2), rnd() < spec.tipFrac * 2)) return res;
        }
    }
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6c — the CLUMP CROWN: a few big leaf-CLUSTER cards per clump, SPHERISED normals
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ WHY (polish-round-3 T4). The sprig crown is right close up — every leaf on a twig — but at the city's
// normal viewing distance its ~2 000 small cards read as busy noise with sky showing through. The look the
// user is after (P5X Shibuya) is the painterly one: a crown is a handful of soft, dense CLUMPS at the branch
// ends, each a volume that shades with a clean light/dark split. So:
//   · clump CENTRES sit at the terminal twig ends (pushed a little past them), plus a few along the leafy
//     span of the terminal limbs and — per species — along the level above (the fill that makes a dense
//     camphor dome or a ginkgo's spur-shoot column);
//   · each clump is ~10–14 LARGE cards cut by the shader's dense CLUMP silhouette (`leafClump`, a rosette
//     of ~12 leaves around a solid core), marked by writing the card's u in [2, 3] instead of [0, 1]
//     (every material flag bit is taken; a UV range costs nothing and needs no instance slot);
//   · every vertex normal is BENT toward the clump's outward direction AND the crown's outward direction
//     (the standard foliage "spherised normals" trick), so the whole crown lights as one soft ball-of-balls
//     instead of as hundreds of randomly-facing planes.
// Clump radius auto-fits to the spacing of the centres (median nearest-neighbour), so a branch-LOD variant
// with a third of the tips grows proportionally bigger clumps and keeps the SAME coverage beside a full one.

/** Hard cap on clump cards in ONE plant (2 tris each) — logged like every other budget (§7). */
export const MAX_CLUMP_CARDS_PER_PLANT = 1800;

export interface ClumpCrownSpec {
    /** Target clump radius (m). The fitted radius (the crown's shell area shared between the clumps, so neighbours
     *  OVERLAP and merge into one crown rather than reading as separate balls) stays within ×0.8 … ×1.8 of this. */
    clumpRadius: number;
    /** ± fraction of per-clump size variation. */
    radiusVar: number;
    /** Cluster cards per clump (the LOD thins this a little; bigger clumps keep coverage). */
    cardsPerClump: number;
    /** Card edge as a multiple of the clump radius. */
    cardScale: number;
    /** Vertical squash of each clump (0.6 = flat layered pads — sakura; 1.15 = a taller column — ginkgo). */
    flatten: number;
    /** Extra clumps along each terminal limb's leafy span (fills between the tips). */
    alongLimb: number;
    /** Clumps along each limb one level up — the density knob (camphor / ginkgo spurs). */
    parentClumps: number;
    /** Push each tip clump past its twig end, as a fraction of its radius. */
    tipPush: number;
    /** Normal weight toward the CLUMP's outward direction. */
    clumpBend: number;
    /** Normal weight toward the CROWN's outward direction (the rest is the card's own facing). */
    crownBend: number;
    /** +Y lean of the bent normal (a crown mostly catches sky light). */
    skyLift: number;
    /** 0..1 cards lie flatter (sky-facing layered pads) instead of tangent to the clump. */
    skyFacing: number;
    /** Probability a terminal limb carries no clump (holes into the crown). */
    gapChance: number;
    /** Extra skip probability for interior clumps (grows with nearness to the plant's axis). */
    innerGap: number;
    /** Fraction of cards routed to the lighter `tip` accumulator (biased to each clump's TOP). */
    tipFrac: number;
    /** 0 near · 1 mid · 2 far. */
    lodLevel?: number;
}

export const DEFAULT_CLUMP_CROWN: ClumpCrownSpec = {
    clumpRadius: 0.75, radiusVar: 0.22, cardsPerClump: 12, cardScale: 1.05, flatten: 0.85, alongLimb: 2, parentClumps: 1,
    tipPush: 0.35, clumpBend: 0.4, crownBend: 0.5, skyLift: 0.25, skyFacing: 0.2, gapChance: 0.04, innerGap: 0.35, tipFrac: 0.3,
};

/** The CLUMP card marker: cluster cards carry u in [2, 3] (see the shader's `leafCardCoverage`). */
export const CLUMP_CARD_U0 = 2;

export interface ClumpCrownResult { clumps: number; cards: number; height: number; radius: number; clumpRadius: number }

/**
 * Grow a CLUMP CROWN on an emitted branch skeleton: cluster cards into `leaf` / `tip`. Clumps sit at the
 * terminal twig ends (+ along the leafy spans); normals are spherised toward clump + crown. Deterministic in `rnd`.
 */
export function emitClumpCrown(
    leaf: Accum3D, tip: Accum3D | null, branch: BranchResult, spec: ClumpCrownSpec,
    rnd: () => number, origin: V3 = [0, 0, 0], budget?: LeafBudget,
): ClumpCrownResult {
    const res: ClumpCrownResult = { clumps: 0, cards: 0, height: origin[1], radius: 0, clumpRadius: 0 };
    const deepest = branch.depth;
    const terminals = branch.spines.filter((sp) => sp.terminal && sp.depth > 0);
    const parents = spec.parentClumps > 0 ? branch.spines.filter((sp) => !sp.terminal && sp.depth > 0 && sp.depth >= deepest - 1) : [];
    if (!terminals.length) return res;
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, LEAF_LOD_SCALE.length - 1);

    // ── 1. Clump centres. `inner` (0 shell … 1 core) thins the unseen interior. ★ Measured in 3D against the
    // twig-end ellipsoid, NOT as distance from the plant's axis: the top-centre of a crown is on the axis but in
    // full view, and skipping it there left bare limb ends poking out of the crown's crest.
    let ex = 0, ey = 0, ez = 0;
    for (const sp of terminals) { ex += sp.e[0]; ey += sp.e[1]; ez += sp.e[2]; }
    ex /= terminals.length; ey /= terminals.length; ez /= terminals.length;
    let eH = 1e-3, eV = 1e-3;
    for (const sp of terminals) { eH = Math.max(eH, Math.hypot(sp.e[0] - ex, sp.e[2] - ez)); eV = Math.max(eV, Math.abs(sp.e[1] - ey)); }
    const centres: { c: V3; k: number }[] = [];
    const push = (c: V3, k: number, skipBias: number): void => {
        const rel = clamp01(Math.hypot((c[0] - ex) / eH, (c[1] - ey) / eV, (c[2] - ez) / eH));
        const inner = 1 - rel;
        if (rnd() < spec.gapChance * skipBias + spec.innerGap * inner * inner * skipBias) return;
        centres.push({ c, k: k * (0.8 + 0.2 * rel) });
    };
    const tipShift = spec.clumpRadius * spec.tipPush;
    // ★ A branch-LOD variant has ~BRANCH_LOD_SCALE² the tips but stands beside full ones on the same avenue, so
    // each surviving limb carries proportionally more fill clumps (the sprig crown's `kT` rule).
    const kFill = lod > 0 ? 0.6 / (BRANCH_LOD_SCALE[lod] * BRANCH_LOD_SCALE[lod]) : 1;
    for (const sp of terminals) {
        const spine = bezierSpine(sp.a, sp.c, sp.e);
        const d = spine.tangent(1);
        push([sp.e[0] + d[0] * tipShift, sp.e[1] + d[1] * tipShift, sp.e[2] + d[2] * tipShift], 1, 1);
        const nA = Math.round(spec.alongLimb * kFill);
        for (let j = 0; j < nA; j++) push(spine.at(0.45 + 0.4 * (j + 0.5) / nA + (rnd() - 0.5) * 0.1), 0.85, 1.3);
    }
    for (const sp of parents) {
        const spine = bezierSpine(sp.a, sp.c, sp.e);
        const nP = Math.round(spec.parentClumps * kFill);
        for (let j = 0; j < nP; j++) push(spine.at(0.55 + 0.4 * (j + 0.5) / nP), 0.8, 1.6);
    }
    if (!centres.length) return res;

    // ── 2. Crown frame (centre + half-extents) → the crown's outward direction at any point.
    let cx = 0, cy = 0, cz = 0;
    for (const { c } of centres) { cx += c[0]; cy += c[1]; cz += c[2]; }
    cx /= centres.length; cy /= centres.length; cz /= centres.length;
    let rH = 1e-3, rV = 1e-3;
    for (const { c } of centres) { rH = Math.max(rH, Math.hypot(c[0] - cx, c[2] - cz)); rV = Math.max(rV, Math.abs(c[1] - cy)); }

    // ── 3. Fit the clump radius to COVERAGE: the crown's shell area (an ellipsoid through the centres,
    // Knud Thomsen's approximation) shared between the clumps. A branch-LOD variant with fewer clumps on the
    // same-sized crown gets proportionally bigger ones, so it keeps the same coverage beside a full one.
    // (Nearest-neighbour spacing was tried first: the fill clumps along one limb sit close together, so it pinned
    // every crown to the lower clamp and the LOD variants went patchy.)
    const pp = 1.6, ah = Math.max(rH, 0.2), av = Math.max(rV, 0.2);
    const shell = 4 * Math.PI * Math.pow((Math.pow(ah * ah, pp) + 2 * Math.pow(ah * av, pp)) / 3, 1 / pp);
    const R0 = clamp(1.1 * Math.sqrt(shell / centres.length), spec.clumpRadius * 0.8, spec.clumpRadius * 1.8);
    res.clumpRadius = R0;
    rH += R0; rV += R0 * spec.flatten;
    const crownOut = (p: V3): V3 => cfNorm([(p[0] - cx) / rH, (p[1] - cy) / rV, (p[2] - cz) / rH]);

    const kC = Math.max(0, Math.min(1, spec.clumpBend)), kW = Math.max(0, Math.min(1 - kC, spec.crownBend)), kN = 1 - kC - kW;
    const sky = clamp01(spec.skyFacing);
    const flat = clamp(spec.flatten, 0.3, 1.6);
    // Bigger clumps at LOD already keep coverage; the per-clump card count only thins a touch.
    const nCards = Math.max(4, Math.round(spec.cardsPerClump * (lod === 0 ? 1 : lod === 1 ? 0.85 : 0.7)));

    const bound = (p: V3): void => {
        if (p[1] > res.height) res.height = p[1];
        res.radius = Math.max(res.radius, Math.hypot(p[0] - origin[0], p[2] - origin[2]));
    };

    // ── 4. Cards. Directions on a jittered golden spiral per clump — an EVEN shell (clean) rather than random
    // clusters of overlapping cards with holes between them (noisy).
    for (let ci = 0; ci < centres.length; ci++) {
        const { c, k } = centres[ci];
        const r = R0 * k * (1 + (rnd() * 2 - 1) * spec.radiusVar);
        const spin = rnd() * TAU;
        res.clumps++;
        for (let i = 0; i < nCards; i++) {
            if (budget) {
                if (budget.left <= 0) {
                    if (!budget.warned) { budget.warned = true; console.warn(`[branch] clump card budget hit — extra clumps dropped (foliage-quality.md §7)`); }
                    return res;
                }
                budget.left--;
            }
            const yy = 1 - 2 * (i + 0.5) / nCards;
            const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
            const th = spin + i * GOLDEN_ANGLE + (rnd() - 0.5) * 0.5;
            const d: V3 = cfNorm([rr * Math.cos(th), yy + (rnd() - 0.5) * 0.25, rr * Math.sin(th)]);
            const depth = r * (0.3 + 0.38 * rnd());
            const q: V3 = [c[0] + d[0] * depth, c[1] + d[1] * depth * flat, c[2] + d[2] * depth];
            // Card facing: tangent to the clump (faces along d), leaning to the sky by `skyFacing`, a little jitter.
            const f = cfNorm([d[0] * (1 - sky) + (rnd() - 0.5) * 0.35, d[1] * (1 - sky) + sky + (rnd() - 0.5) * 0.35, d[2] * (1 - sky) + (rnd() - 0.5) * 0.35]);
            const { u: fu, v: fv } = perpFrame(f);
            const roll = rnd() * TAU, cr = Math.cos(roll), sr = Math.sin(roll);
            const ax: V3 = [fu[0] * cr + fv[0] * sr, fu[1] * cr + fv[1] * sr, fu[2] * cr + fv[2] * sr];
            const ay: V3 = cfCross(f, ax);
            const hs = 0.5 * r * spec.cardScale * (0.85 + rnd() * 0.3);
            const top = (tip && rnd() < spec.tipFrac * (0.55 + 0.9 * Math.max(0, d[1]))) ? tip : leaf;
            const vx = (sx: number, sy: number, uu: number, vv: number): number => {
                const p: V3 = [q[0] + (ax[0] * sx + ay[0] * sy) * hs, q[1] + (ax[1] * sx + ay[1] * sy) * hs, q[2] + (ax[2] * sx + ay[2] * sy) * hs];
                bound(p);
                // ★ SPHERISED normal: clump-outward + crown-outward + a sliver of the card's own facing + sky.
                const oc = cfNorm([p[0] - c[0], (p[1] - c[1]) / flat, p[2] - c[2]]);
                const ow = crownOut(p);
                const fn = cfDot(f, oc) < 0 ? [-f[0], -f[1], -f[2]] : f;
                return top.vertex(p, cfNorm([
                    oc[0] * kC + ow[0] * kW + fn[0] * kN,
                    oc[1] * kC + ow[1] * kW + fn[1] * kN + spec.skyLift,
                    oc[2] * kC + ow[2] * kW + fn[2] * kN,
                ]), uu, vv);
            };
            const v0 = vx(-1, -1, CLUMP_CARD_U0, 0), v1 = vx(1, -1, CLUMP_CARD_U0 + 1, 0);
            const v2 = vx(1, 1, CLUMP_CARD_U0 + 1, 1), v3 = vx(-1, 1, CLUMP_CARD_U0, 1);
            top.triangle(v0, v1, v2); top.triangle(v0, v2, v3);
            res.cards++;
        }
    }
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// The CLIPPED-BOX SHELL — a manicured hedge (§4 "bush / hedge", P4)
// ─────────────────────────────────────────────────────────────────────────────

export interface HedgeShellSpec {
    /** Full extents in metres: `width` is the RUN LENGTH along X, `depth` the thickness along Z. */
    width: number;
    height: number;
    depth: number;
    /** Corner rounding radius (m) — a clipped hedge has soft arrises, not knife edges. */
    round: number;
    /** Leaves per m² of SHELL area. */
    leafDensity: number;
    /** ★ Surface irregularity (m) — the clipped plane is not a CAD plane. */
    irregular: number;
    /** ★ A few shoots that have escaped the clipped plane (they are the whole "alive" read). */
    sprigs: number;
    /** Escaped-shoot length (m). */
    sprigLength: number;
    tipFrac: number;
    mode: 'blade' | 'chunky';
    leaf: LeafGeom;
    /** A cheap solid inner box (12 tris) so the unseen interior reads dark instead of see-through. */
    core: boolean;
    lodLevel?: number;
}

export const DEFAULT_HEDGE_SHELL: HedgeShellSpec = {
    width: 1, height: 1, depth: 0.6, round: 0.12, leafDensity: 90, irregular: 0.03,
    sprigs: 5, sprigLength: 0.18, tipFrac: 0.25, mode: 'chunky', leaf: DEFAULT_LEAF, core: true,
};

export interface HedgeShellResult {
    leaves: number;
    sprigs: number;
    /** Measured top (the clipped plane plus whatever bulged or escaped past it). */
    height: number;
    /** Measured half-extents including the surface bulge — the caller's footprint. */
    halfX: number;
    halfZ: number;
    /** Shell area in m² — the thing the cost scales with (vs the old row of solid mounds). */
    area: number;
}

/**
 * A hedge is MANICURED: a flat-cut boxy silhouette with a dense leafy SURFACE. So the leaves live on
 * the SHELL of a rounded box — the top and the four sides, never the hidden interior — which is both
 * the correct look and the perf win (cost scales with AREA, not volume; the old construction filled a
 * whole row of solid spheres). `irregular` breaks the clipped plane, `sprigs` lets a few shoots escape
 * it, and an optional `core` box (12 tris) keeps the interior reading as shadow rather than as a hole.
 */
export function emitHedgeShell(
    leaf: Accum3D, tip: Accum3D | null, spec: HedgeShellSpec, rnd: () => number, budget?: LeafBudget,
): HedgeShellResult {
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, LEAF_LOD_SCALE.length - 1);
    const W = Math.max(0.05, spec.width), H = Math.max(0.05, spec.height), D = Math.max(0.05, spec.depth);
    const hx = W / 2, hy = H / 2, hz = D / 2;
    const cy = hy;                                                // base sits on y = 0
    const rd = clamp(spec.round, 0, Math.min(hx, hy, hz) * 0.9);
    const ix = Math.max(1e-4, hx - rd), iy = Math.max(1e-4, hy - rd), iz = Math.max(1e-4, hz - rd);
    // Only the FIVE visible faces (top + 4 sides). The bottom and the whole interior are never seen.
    const faces: { w: number; pick: (a: number, b: number) => V3 }[] = [
        { w: W * D, pick: (a, b) => [(a - 0.5) * W, hy, (b - 0.5) * D] },              // top
        { w: W * H, pick: (a, b) => [(a - 0.5) * W, (b - 0.5) * H, hz] },              // +Z
        { w: W * H, pick: (a, b) => [(a - 0.5) * W, (b - 0.5) * H, -hz] },             // −Z
        { w: D * H, pick: (a, b) => [hx, (b - 0.5) * H, (a - 0.5) * D] },              // +X
        { w: D * H, pick: (a, b) => [-hx, (b - 0.5) * H, (a - 0.5) * D] },             // −X
    ];
    const area = faces.reduce((s, f) => s + f.w, 0);
    const n = Math.max(4, Math.round(area * Math.max(1, spec.leafDensity) * LEAF_LOD_SCALE[lod]));
    const res: HedgeShellResult = { leaves: 0, sprigs: 0, height: H, halfX: hx, halfZ: hz, area };
    const bound = (p: V3, pad: number): void => {
        res.height = Math.max(res.height, p[1] + pad);
        res.halfX = Math.max(res.halfX, Math.abs(p[0]) + pad);
        res.halfZ = Math.max(res.halfZ, Math.abs(p[2]) + pad);
    };

    if (spec.core) {
        // The unseen interior, as ONE box: dark, cheap, and it stops a sparse shell reading as a shell.
        leaf.obox([0, cy, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], hx * 0.88, hy * 0.9, hz * 0.86);
    }

    for (let i = 0; i < n; i++) {
        if (budget) {
            if (budget.left <= 0) {
                if (!budget.warned) { budget.warned = true; console.warn(`[branch] hedge leaf budget hit — extra leaves dropped (foliage-quality.md §7)`); }
                break;
            }
            budget.left--;
        }
        // Pick a face by AREA, then a uniform point on it.
        let pickW = rnd() * area, f = faces[0];
        for (const face of faces) { if (pickW <= face.w) { f = face; break; } pickW -= face.w; }
        const raw = f.pick(rnd(), rnd());
        // Rounded-box projection: clamp into the inner box, then step back out by `round` — this gives
        // the surface point AND its normal in one shot (the standard rounded-box SDF construction).
        const q: V3 = [clamp(raw[0], -ix, ix), clamp(raw[1], -iy, iy), clamp(raw[2], -iz, iz)];
        let nrm: V3 = [raw[0] - q[0], raw[1] - q[1], raw[2] - q[2]];
        const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
        nrm = nl > 1e-6 ? [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl] : [0, 1, 0];
        // ★ The clipped plane is not a CAD plane — displace along the normal by a smooth noise field.
        const bump = (fbm2(raw[0] * 5.3 + 11.1, raw[1] * 5.3 + raw[2] * 2.7) - 0.5) * 2 * spec.irregular;
        const p: V3 = [q[0] + nrm[0] * (rd + bump), cy + q[1] + nrm[1] * (rd + bump), q[2] + nrm[2] * (rd + bump)];
        const target = (tip && rnd() < spec.tipFrac) ? tip : leaf;
        if (spec.mode === 'chunky') {
            const br = spec.leaf.length * (0.55 + rnd() * 0.42);
            target.blob(p, br, br * 0.95, br, 0.55, (rnd() * 1e4) | 0);
            bound(p, br * 1.6);
        } else {
            const g = spec.leaf;
            const len = Math.max(1e-3, g.length * (1 + (rnd() * 2 - 1) * g.lengthVar));
            const y = emitBlade(target, null, 1, p, nrm[0], nrm[2], {
                length: len, width: g.width * (0.8 + rnd() * 0.45), taper: 0.3,
                curve: g.curve * (0.5 + rnd() * 0.8), segments: g.segments,
                twist: g.twist * (rnd() < 0.5 ? -1 : 1), foldAngle: g.fold, lean: 0,
                shape: g.shape, axis: nrm, out: perpAny(nrm, rnd),
                // A clipped leaf lies close to the cut plane (pitch → π/2), never sticking straight out.
                pitch: Math.max(0.2, g.pitch * 1.25 * (1 + (rnd() * 2 - 1) * g.pitchVar * 0.6)),
            });
            bound([p[0], y, p[2]], len * 1.15);
        }
        res.leaves++;
    }

    // ★ ESCAPING SPRIGS — the few shoots that have grown past the last clipping. They go to the tip
    // (new-growth) accumulator, because that is exactly what they are.
    const nS = Math.max(0, Math.round(spec.sprigs * LEAF_LOD_SCALE[lod]));
    for (let i = 0; i < nS; i++) {
        const x = (rnd() - 0.5) * W * 0.94, z = (rnd() - 0.5) * D * 0.9;
        const a = rnd() * TAU;
        const dir: V3 = cfNorm([Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35]);
        const len = spec.sprigLength * (0.6 + rnd() * 0.8);
        const y = emitBlade(tip ?? leaf, null, 1, [x, H - rd * 0.4, z], dir[0], dir[2], {
            length: len, width: spec.leaf.width * 0.55, taper: 0.6, curve: 0.35 + rnd() * 0.4,
            segments: 4, twist: 0.5, foldAngle: 0.22, lean: 0.2, shape: 'pointed', axis: dir,
        });
        bound([x, y, z], len * 0.6);
        res.sprigs++;
    }
    return res;
}
