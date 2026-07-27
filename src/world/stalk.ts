// ─────────────────────────────────────────────────────────────────────────────
// The `stalk` PRIMITIVE (foliage-quality.md §3.3, phase P2) — an AXIS with elements distributed
// ALONG it. This is the primitive that answers "flowers up a stem": rapeseed, lavender, foxglove,
// wheat, and (as the degenerate one-terminal-floret case) a daisy.
//
// ★ REUSE: the stem is a tube swept along a `bezierSpine` with `sweepFrames` (parallel transport) —
// the same curve-frame module hair cards and grass blades ride; the stem LEAVES are `emitBlade`
// (pointed/strap profile); the FLORETS are `emitWhorl` instances placed on the sweep's own frames,
// so a floret's axis is the stem tangent tilted outward — nothing hand-rolls a frame.
//
// The knobs that make a species read as itself:
//   · `bloomStart` / `bloomEnd`  — FRACTIONS 0..1 up the stem where florets begin / stop. Daisy 0.95→1
//     (terminal only), rapeseed 0.55→1, lavender 0.6→1.
//   · `bloomScaleCurve`          — ★ florets SHRINK toward the tip: open flowers below, buds at the
//     apex. This single curve is what makes rapeseed read as rapeseed.
//   · `terminalCluster`          — a denser cap of tiny buds at the very apex.
//   · `branches`                 — each branch is a RECURSIVE stalk (rapeseed / lavender branch).
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { bezierSpine, sweepFrames, sweepParams, cfCross, cfDot, cfNorm, perpFrame, type V3, type CurveFrame } from './curve-frame';
import { emitBlade } from './blade';
import { emitWhorl, resolveWhorl, WHORL_LOD_SCALE, type WhorlSpec, type PetalShape } from './whorl';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Floret-count multiplier per LOD band (§2.5) — the stalk analogue of `BLADE_LOD_SCALE`. */
export const STALK_LOD_SCALE = [1, 0.55, 0.32];
/** Hard cap on florets in ONE stalk (branches included) — truncation is LOGGED, never silent (§7). */
export const MAX_FLORETS_PER_STALK = 160;

/** Where a stalk's geometry lands. Split so the stem/leaves, petals and eyes can carry their own colours. */
export interface StalkAccum {
    stem: Accum3D;
    leaf: Accum3D;
    petal: Accum3D;
    centre: Accum3D | null;
}

export interface StalkSpec {
    // ── the stem ──
    height: number;
    thickness: number;
    /** Arc of the stem, 0 = ramrod straight, 1 = a pronounced lean. */
    curve: number;
    /** Spine subdivisions. */
    segments: number;
    /** Tube sides (3–5; a stem is seen from metres away). */
    sides: number;
    // ── where the florets live ──
    /** FRACTION 0..1 up the stem where florets begin. */
    bloomStart: number;
    /** FRACTION 0..1 where they stop (1 = right to the tip). */
    bloomEnd: number;
    /** Florets per METRE of the bloom band. */
    bloomDensity: number;
    /** Discrete node spacing (m) — when > 0 it overrides `bloomDensity`. */
    nodeSpacing: number;
    /** ★ 0 = every floret the same size · 1 = the apex floret shrinks to nothing (buds at the top). */
    bloomScaleCurve: number;
    /** Pedicel (floret stalklet) length, × the floret's own size. */
    pedicel: number;
    /** A denser cap of tiny buds at the apex. */
    terminalCluster: boolean;
    /** How many buds the terminal cluster packs. */
    terminalCount: number;
    // ── branches (each one a recursive stalk) ──
    branches: number;
    /** Radians the branch leaves the parent tangent by. */
    branchAngle: number;
    /** FRACTION up the parent stem the lowest branch starts at. */
    branchStart: number;
    /** Branch height / leaf count relative to the parent. */
    branchDecay: number;
    // ── foliage leaves on the lower stem ──
    leaves: number;
    leafStart: number;
    leafEnd: number;
    leafLength: number;
    leafWidth: number;
    leafShape: PetalShape;
    /** The floret recipe (a small `whorl`). */
    floret: Partial<WhorlSpec>;
    /** 0 near · 1 mid · 2 far — thins florets AND petals (§2.5). */
    lodLevel?: number;
    maxFlorets?: number;
}

export const DEFAULT_STALK: StalkSpec = {
    height: 0.6, thickness: 0.006, curve: 0.22, segments: 5, sides: 4,
    bloomStart: 0.6, bloomEnd: 1, bloomDensity: 60, nodeSpacing: 0, bloomScaleCurve: 0.5,
    pedicel: 0.55, terminalCluster: false, terminalCount: 5,
    branches: 0, branchAngle: 0.5, branchStart: 0.4, branchDecay: 0.55,
    leaves: 4, leafStart: 0.05, leafEnd: 0.45, leafLength: 0.14, leafWidth: 0.035, leafShape: 'pointed',
    floret: {},
};

export function resolveStalk(partial: Partial<StalkSpec> = {}): StalkSpec {
    return { ...DEFAULT_STALK, ...partial, floret: { ...DEFAULT_STALK.floret, ...(partial.floret ?? {}) } };
}

/** One emitted floret — enough for a caller (or a test) to verify WHERE the bloom band actually landed. */
export interface StalkFloret {
    /** Spine fraction 0..1 on its own stalk. */
    t: number;
    /** World Y of the floret's attachment point. */
    y: number;
    /** Size multiplier after `bloomScaleCurve` (1 = a full basal flower). */
    scale: number;
    /** 0 = the main stalk, 1 = a branch. */
    depth: number;
    /** Part of the apex cluster. */
    terminal: boolean;
    petals: number;
}

export interface StalkResult {
    florets: StalkFloret[];
    /** Branches actually emitted (recursive stalks). */
    branches: number;
    leaves: number;
    petals: number;
    /** Measured height (max world Y touched by stem, leaves or petal tips). */
    height: number;
    /** Footprint radius from the stalk base. */
    radius: number;
    /** World Y of the MAIN stem at `bloomStart` / `bloomEnd` — the band the florets must live inside. */
    bloomY: [number, number];
}

export interface StalkPlacement { base: V3; axis?: V3; ref?: V3; scale?: number }

/**
 * Sweep a tapered tube along the frames — the stem. `r0`→`r1` is the base→tip radius, lerped by each
 * frame's GLOBAL param `f.t` (so a sub-range of frames still tapers consistently with the whole curve).
 * ★ Exported because the P3 `runner` primitive sweeps its woody stem with exactly this — a runner is
 * structurally a stalk (a swept stem tube with elements distributed along it), so there is ONE tube sweep.
 */
export function emitTube(acc: Accum3D, frames: readonly CurveFrame[], r0: number, r1: number, sides: number): void {
    const n = Math.max(3, Math.round(sides));
    let prev: number[] | null = null;
    for (const f of frames) {
        const r = r0 + (r1 - r0) * f.t;
        const ring: number[] = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU, ca = Math.cos(a), sa = Math.sin(a);
            const nn = cfNorm([f.u[0] * ca + f.v[0] * sa, f.u[1] * ca + f.v[1] * sa, f.u[2] * ca + f.v[2] * sa]);
            ring.push(acc.vertex([f.p[0] + nn[0] * r, f.p[1] + nn[1] * r, f.p[2] + nn[2] * r], nn, i / n, f.t));
        }
        if (prev) for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            acc.triangle(prev[i], ring[i], ring[j]);
            acc.triangle(prev[i], ring[j], prev[j]);
        }
        prev = ring;
    }
}

/**
 * Emit ONE stalk (and, recursively, its branches) into `acc`. Local units are metres; `at.base` is the
 * stem's root and `at.axis` the direction it grows (defaults to +Y — a ground-planted plant).
 */
export function emitStalk(acc: StalkAccum, spec: StalkSpec, at: StalkPlacement, rnd: () => number): StalkResult {
    const out: StalkResult = { florets: [], branches: 0, leaves: 0, petals: 0, height: at.base[1], radius: 0, bloomY: [at.base[1], at.base[1]] };
    emitStalkAt(acc, spec, at, rnd, 0, out, { left: Math.max(1, Math.round(spec.maxFlorets ?? MAX_FLORETS_PER_STALK)), warned: false });
    return out;
}

interface Budget { left: number; warned: boolean }

function emitStalkAt(acc: StalkAccum, spec: StalkSpec, at: StalkPlacement, rnd: () => number, depth: number, out: StalkResult, budget: Budget): void {
    const s = Math.max(1e-4, at.scale ?? 1);
    const H = Math.max(1e-3, spec.height * s);
    const axis = cfNorm(at.axis ?? [0, 1, 0]);
    let ref: V3;
    if (at.ref) {
        const d = cfDot(at.ref, axis);
        const perp: V3 = [at.ref[0] - axis[0] * d, at.ref[1] - axis[1] * d, at.ref[2] - axis[2] * d];
        ref = Math.hypot(perp[0], perp[1], perp[2]) > 1e-6 ? cfNorm(perp) : perpFrame(axis).u;
    } else {
        ref = perpFrame(axis).u;
    }
    const bino = cfNorm(cfCross(axis, ref));
    const curve = clamp(spec.curve, 0, 1.4);

    // Stem spine: leaves the base along the axis (the wind grading assumes a planted base) and arcs
    // toward `ref`. Same construction as the blade's — one bezier, transported frames.
    const A: V3 = [at.base[0], at.base[1], at.base[2]];
    const cUp = H * 0.55, eUp = H * (1 - 0.14 * curve);
    const cOut = H * curve * 0.06, eOut = H * curve * 0.4;
    const C: V3 = [A[0] + axis[0] * cUp + ref[0] * cOut, A[1] + axis[1] * cUp + ref[1] * cOut, A[2] + axis[2] * cUp + ref[2] * cOut];
    const E: V3 = [A[0] + axis[0] * eUp + ref[0] * eOut, A[1] + axis[1] * eUp + ref[1] * eOut, A[2] + axis[2] * eUp + ref[2] * eOut];
    const spine = bezierSpine(A, C, E);
    const segs = Math.max(2, Math.round(spec.segments));
    const frames = sweepFrames(spine, sweepParams(segs));
    const th = Math.max(1e-4, spec.thickness * s);
    emitTube(acc.stem, frames, th, th * 0.45, spec.sides);
    for (const f of frames) {
        if (f.p[1] > out.height) out.height = f.p[1];
        const d = cfDot([f.p[0] - A[0], f.p[1] - A[1], f.p[2] - A[2]], axis);
        out.radius = Math.max(out.radius, Math.hypot(f.p[0] - A[0] - axis[0] * d, f.p[1] - A[1] - axis[1] * d, f.p[2] - A[2] - axis[2] * d));
    }

    const bs = clamp01(Math.min(spec.bloomStart, spec.bloomEnd));
    const be = clamp01(Math.max(spec.bloomStart, spec.bloomEnd));
    if (depth === 0) out.bloomY = [spine.at(bs)[1], spine.at(be)[1]];
    const span = be - bs;
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, STALK_LOD_SCALE.length - 1);

    // ── LEAVES on the lower stem (reused `blade` geometry — a leaf IS a blade) ───────────────────────
    const nLeaf = Math.max(0, Math.round(spec.leaves * (depth > 0 ? spec.branchDecay : 1)));
    for (let i = 0; i < nLeaf; i++) {
        const t = clamp01(spec.leafStart + ((i + 0.5) / Math.max(1, nLeaf)) * Math.max(0, spec.leafEnd - spec.leafStart));
        const f = frameAt(spine, t);
        const a = i * GOLDEN_ANGLE + rnd() * 0.5;
        const dir = radial(f.tan, ref, bino, a);
        const len = spec.leafLength * s * (0.75 + rnd() * 0.5);
        const y = emitBlade(acc.leaf, null, 1, f.p, dir[0], dir[2], {
            length: len, width: spec.leafWidth * s, taper: 0, curve: 0.45 + rnd() * 0.3,
            segments: 3, twist: 0.3, foldAngle: 0.22, lean: 0,
            shape: spec.leafShape, pitch: 0.85 + rnd() * 0.35, axis: f.tan, out: dir,
        });
        if (y > out.height) out.height = y;
        out.radius = Math.max(out.radius, len * 0.9);
        out.leaves++;
    }

    // ── FLORETS along the bloom band ────────────────────────────────────────────────────────────────
    const floret = resolveWhorl({ ...spec.floret, lodLevel: lod });
    const bandLen = span * H;
    let n = spec.nodeSpacing > 0 ? Math.round(bandLen / spec.nodeSpacing) : Math.round(spec.bloomDensity * bandLen);
    n = Math.max(1, Math.round(n * STALK_LOD_SCALE[lod]));
    const nodes: { t: number; u: number; terminal: boolean }[] = [];
    for (let i = 0; i < n; i++) {
        const u = n === 1 ? 1 : i / (n - 1);
        nodes.push({ t: bs + span * u, u, terminal: false });
    }
    if (spec.terminalCluster) {
        const tc = Math.max(1, Math.round(spec.terminalCount * STALK_LOD_SCALE[lod]));
        for (let i = 0; i < tc; i++) nodes.push({ t: be - span * 0.05 * rnd(), u: 1, terminal: true });
    }
    for (const node of nodes) {
        if (budget.left <= 0) {
            if (!budget.warned) { budget.warned = true; console.warn(`[stalk] floret budget hit (${spec.maxFlorets ?? MAX_FLORETS_PER_STALK}) — extra florets dropped (foliage-quality.md §7)`); }
            break;
        }
        budget.left--;
        // ★ SHRINK TOWARD THE TIP: open flowers low, buds at the apex.
        const sc = Math.max(0.06, 1 - clamp01(spec.bloomScaleCurve) * node.u) * (node.terminal ? 0.55 : 1) * (0.88 + rnd() * 0.24);
        const f = frameAt(spine, clamp01(node.t));
        const a = out.florets.length * GOLDEN_ANGLE + rnd() * 0.6;      // phyllotaxis, not a ring
        const dir = radial(f.tan, ref, bino, a);
        const size = floret.elementLength * s * sc;
        const ped = spec.pedicel * size;
        const org: V3 = [f.p[0] + dir[0] * ped * 0.85 + f.tan[0] * ped * 0.4, f.p[1] + dir[1] * ped * 0.85 + f.tan[1] * ped * 0.4, f.p[2] + dir[2] * ped * 0.85 + f.tan[2] * ped * 0.4];
        if (ped > 1e-4) acc.stem.beam(f.p, org, Math.max(1e-4, th * 0.35), 3);
        // The floret opens around an axis that leans OUT from the stem — never straight up the stem.
        const fAxis = cfNorm([f.tan[0] * 0.7 + dir[0] * 0.72, f.tan[1] * 0.7 + dir[1] * 0.72, f.tan[2] * 0.7 + dir[2] * 0.72]);
        const r = emitWhorl(acc.petal, acc.centre, floret, { base: org, axis: fAxis, ref: dir, scale: s * sc, yaw: a }, rnd);
        out.florets.push({ t: node.t, y: f.p[1], scale: sc, depth, terminal: node.terminal, petals: r.petals });
        out.petals += r.petals;
        if (r.top > out.height) out.height = r.top;
        const d = cfDot([org[0] - A[0], org[1] - A[1], org[2] - A[2]], axis);
        out.radius = Math.max(out.radius, Math.hypot(org[0] - A[0] - axis[0] * d, org[1] - A[1] - axis[1] * d, org[2] - A[2] - axis[2] * d) + r.radius);
    }

    // ── BRANCHES — each is a RECURSIVE stalk (rapeseed / lavender), one level deep ───────────────────
    if (depth === 0 && spec.branches > 0) {
        const nb = Math.round(spec.branches);
        for (let b = 0; b < nb; b++) {
            const t = clamp01(spec.branchStart + ((b + 0.5) / nb) * Math.max(0.05, bs - spec.branchStart) * 0.95);
            const f = frameAt(spine, t);
            const a = b * GOLDEN_ANGLE + rnd() * 0.7;
            const dir = radial(f.tan, ref, bino, a);
            const ang = spec.branchAngle * (0.75 + rnd() * 0.5);
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const bAxis = cfNorm([f.tan[0] * ca + dir[0] * sa, f.tan[1] * ca + dir[1] * sa, f.tan[2] * ca + dir[2] * sa]);
            const sub: StalkSpec = {
                ...spec, branches: 0, terminalCluster: spec.terminalCluster,
                height: spec.height * spec.branchDecay * (1 - t * 0.35),
                thickness: spec.thickness * 0.7, curve: spec.curve * 1.25,
                leaves: Math.max(0, Math.round(spec.leaves * 0.35)),
            };
            emitStalkAt(acc, sub, { base: f.p, axis: bAxis, ref: dir, scale: s }, rnd, depth + 1, out, budget);
            out.branches++;
        }
    }
}

/** A minimal frame at `t` — position + tangent (the ring frames are only needed for the tube). */
function frameAt(spine: { at(t: number): V3; tangent(t: number): V3 }, t: number): { p: V3; tan: V3 } {
    return { p: spine.at(t), tan: spine.tangent(t) };
}

/** A unit direction perpendicular to `tan`, at azimuth `a` in the (ref, bino) plane. */
function radial(tan: V3, ref: V3, bino: V3, a: number): V3 {
    const ca = Math.cos(a), sa = Math.sin(a);
    const d: V3 = [ref[0] * ca + bino[0] * sa, ref[1] * ca + bino[1] * sa, ref[2] * ca + bino[2] * sa];
    const k = cfDot(d, tan);
    const perp: V3 = [d[0] - tan[0] * k, d[1] - tan[1] * k, d[2] - tan[2] * k];
    return Math.hypot(perp[0], perp[1], perp[2]) > 1e-6 ? cfNorm(perp) : perpFrame(tan).u;
}

/** Petal-count LOD is shared with the whorl (re-exported so recipes can reason about one table). */
export { WHORL_LOD_SCALE };
