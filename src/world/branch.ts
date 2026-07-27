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
    const out: BranchResult = { limbs: 0, tips: [], height: at.base[1], radius: 0, depth: 0 };
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
    if (depth >= Math.max(0, Math.round(spec.levels))) {
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
