// ─────────────────────────────────────────────────────────────────────────────
// The `runner` PRIMITIVE (foliage-quality.md §3.4, phase P3) — GROWTH OVER A SURFACE.
// The generative atom behind ivy, vines and creepers: a woody stem that crawls across a host, clings to
// it, branches, hangs off its edges, and carries leaves along its length.
//
// ★ TWO PATH SOURCES, ONE GROWTH/GEOMETRY MODEL. This is the whole design:
//     (a) AREA  ("ivy wall")  — seeds placed over a host region; runners GROW procedurally
//                               (crawl → cling → branch → hang past an edge).
//     (b) PATH  ("ivy path")  — the caller hands in an explicit list of 3D points (the Ribbon-style
//                               authoring the host already has); that polyline IS a runner centreline,
//                               smoothed through `polySpine`, with optional free side-branches.
//   Both then run the SAME downstream: sweep the stem tube, distribute leaves, orient/droop them, LOD.
//   There is deliberately NOT a second system for the authored case.
//
// ★ DENSITY IS THE CONTINUUM between the two ivy looks: low `leafDensity`/`coverage` = visible woody
//   runners crawling over bare wall (a sparse, graphic climber); high = a leaf CARPET where the stems are
//   completely hidden. One codepath, one set of params — the reference images differ only by numbers.
//
// ★ REUSE, not a third sweep: the stem is `emitTube` from ./stalk.ts (a runner IS structurally a stalk —
//   a swept stem with elements distributed along it, leaves instead of florets) over `polySpine` +
//   `sweepFrames` from ./curve-frame.ts; every LEAF is `emitBlade` with the `palmate` width profile (a
//   leaf is a blade with a leaf silhouette); the coverage frontier rides `fbm2` from ./ground-masks.ts,
//   the same noise the ground material and the P5 scatter already share.
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { polySpine, sweepFrames, sweepParams, rotAxis, cfCross, cfDot, cfNorm, cfLen, type V3, type CurveFrame } from './curve-frame';
import { emitBlade, type BladeShape } from './blade';
import { emitTube } from './stalk';
import { fbm2 } from './ground-masks';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(v, 0, 1);
const smoothstep = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / ((b - a) || 1e-12)); return t * t * (3 - 2 * t); };
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Leaf-count multiplier per LOD band (§2.5) — the runner analogue of `BLADE_LOD_SCALE`. */
export const RUNNER_LOD_SCALE = [1, 0.55, 0.32];
/** Hard cap on runners (seeds + branches) in ONE plant — truncation is LOGGED, never silent (§7). */
export const MAX_RUNNERS = 64;
/** Hard cap on leaves in ONE plant. */
export const MAX_RUNNER_LEAVES = 1400;

// ── The HOST SURFACE ─────────────────────────────────────────────────────────────────────────────
// v1 is a wall PLANE/quad done properly (an origin + right/up axes + width/height + an outward normal),
// not the old "everything sits at z≈0" assumption.
//
// ★ EXTENSION POINT: `RunnerHost` is only three methods, none of which knows it is a plane. An arbitrary
// MESH host (project/raycast onto the nearest triangle, reusing the hair-collision machinery) is a second
// implementation of this interface — `growRunners` needs no change at all. Not built here (§9 open q).

/** Where a point lands on the host: the surface point, its outward normal, and the region-local uv. */
export interface HostHit { p: V3; n: V3; u: number; v: number; inside: boolean }

export interface RunnerHost {
    /** CLING: project an off-surface point back onto the host. `inside` = it landed within the region. */
    project(p: V3): HostHit;
    /** The surface point at a region uv (0..1) — used to place seeds. */
    at(u: number, v: number): HostHit;
    /** Region size in metres [width, height] — sets step/seed scales. */
    size: [number, number];
}

export interface WallHostSpec {
    /** The region's (u=0, v=0) corner. Default origin. */
    origin?: V3;
    /** Unit +u direction (region width). Default +X. */
    right?: V3;
    /** Unit +v direction (region height). Default +Y — orthogonalised against `right`. */
    up?: V3;
    /** Outward normal. Default `right × up` (with the defaults: +Z — the wall face convention). */
    normal?: V3;
    width: number;
    height: number;
}

/** A flat wall quad host (v1). See the extension-point note above for arbitrary meshes. */
export function wallHost(spec: WallHostSpec): RunnerHost {
    const W = Math.max(1e-3, spec.width), H = Math.max(1e-3, spec.height);
    const right = cfNorm(spec.right ?? [1, 0, 0]);
    let up = cfNorm(spec.up ?? [0, 1, 0]);
    const d = cfDot(up, right);
    const ortho: V3 = [up[0] - right[0] * d, up[1] - right[1] * d, up[2] - right[2] * d];
    up = cfLen(ortho) > 1e-6 ? cfNorm(ortho) : cfNorm(cfCross(right, [0, 0, 1]));
    const n = cfNorm(spec.normal ?? cfCross(right, up));
    const o: V3 = spec.origin ? [spec.origin[0], spec.origin[1], spec.origin[2]] : [0, 0, 0];
    const at = (u: number, v: number): HostHit => ({
        p: [o[0] + right[0] * u * W + up[0] * v * H, o[1] + right[1] * u * W + up[1] * v * H, o[2] + right[2] * u * W + up[2] * v * H],
        n, u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    });
    return {
        size: [W, H], at,
        project: (p: V3): HostHit => {
            const dp = sub(p, o);
            return at(cfDot(dp, right) / W, cfDot(dp, up) / H);
        },
    };
}

/** World +Y projected into the host's tangent plane — the "up the wall" direction, for ANY host. */
export function tangentUp(n: V3): V3 {
    const d = n[1];
    const t: V3 = [-n[0] * d, 1 - n[1] * d, -n[2] * d];
    return cfLen(t) > 1e-4 ? cfNorm(t) : cfNorm(cfCross(n, [1, 0, 0]));
}

// ── The COVERAGE FRONTIER (§8 P3) ────────────────────────────────────────────────────────────────
/**
 * Ivy must never end in a straight line. A dense CORE that fades toward the region's sides and (hardest)
 * its top, broken up by `fbm2` — so runners die out unevenly and the mass FINGERS OUT into individual
 * strands at the frontier. Returns 0..1; runners stop below `frontier`, and leaves thin out with it.
 */
export function coverageAt(u: number, v: number, coverage: number, seed = 0): number {
    const cov = clamp01(coverage);
    const side = smoothstep(0, 0.22, Math.min(u, 1 - u));       // fade at the left/right edges
    const top = 1 - smoothstep(0.45, 1.02, v);                  // thins toward the top — ivy climbs INTO nothing
    const n = fbm2(u * 3.3 + seed * 1.37 + 11.4, v * 3.3 + seed * 0.71 + 5.2);
    return clamp01(cov * (0.3 + 0.7 * side) * (0.3 + 0.7 * top) + (n - 0.5) * 0.75 * cov);
}

// ── Spec ─────────────────────────────────────────────────────────────────────────────────────────

export type Phyllotaxy = 'alternate' | 'opposite' | 'spiral';

export interface RunnerSpec {
    // ── growth (AREA mode) ──
    /** Seed runners placed across the host region. */
    runnerCount: number;
    /** Centreline length budget per runner (m). */
    maxLength: number;
    /** Crawl step (m) — also the centreline's control-point spacing. */
    stepSize: number;
    /** Probability per step of throwing a side branch. */
    branchChance: number;
    /** Angle (radians) a branch leaves the parent direction by. */
    branchAngle: number;
    /** Branch length budget, × the parent's remaining budget. */
    branchDecay: number;
    /** Recursion depth for branches (1 = branches, no sub-branches). */
    branchDepth: number;
    /** −1 = trail DOWN · 0 = crawl ALONG · +1 = climb UP the host. */
    growthBias: number;
    /** Random walk per step (× step). */
    wander: number;
    /** 0..1 — how much of the region the plant covers (§ the frontier mask). */
    coverage: number;
    /** Coverage below which a runner stops growing (the frontier). */
    frontier: number;
    /** Fraction of the region height the seed row sits at (0 = the bottom edge). */
    seedRow: number;
    // ── clinging + hanging ──
    /** Offset off the host surface (m) — leaf/stem thickness, so nothing z-fights the wall. */
    clingOffset: number;
    /** How hard a FREE span (past an edge) falls per step, 0..1 — the hang. */
    hangGravity: number;
    /** Random drift off the wall while hanging. */
    hangDrift: number;
    // ── the stem ──
    thickness: number;
    sides: number;
    // ── leaves ──
    /** Spacing along the runner (m). */
    leafSpacing: number;
    /** 0..1 — probability a node actually carries a leaf (the sparse↔carpet continuum). */
    leafDensity: number;
    leafSize: number;
    leafSizeVar: number;
    /** ★ Leaf size at the growing TIP, × `leafSize` — new leaves are SMALL. */
    tipScale: number;
    /** Distance from the tip (m) over which a leaf grows to full size. */
    ageSpan: number;
    /** Distance from the tip (m) whose leaves count as NEW GROWTH (the lighter tip accumulator). */
    newGrowth: number;
    /** Gravity droop of a leaf, 0..1. */
    droop: number;
    /** How far a leaf lifts off the host surface, 0..1. */
    leafLift: number;
    phyllotaxy: Phyllotaxy;
    leafShape: BladeShape;
    leafCurve: number;
    leafFold: number;
    leafTwist: number;
    leafSegments: number;
    /** 0 near · 1 mid · 2 far — thins leaves and stem stations (§2.5). */
    lodLevel?: number;
    maxRunners?: number;
    maxLeaves?: number;
}

export const DEFAULT_RUNNER: RunnerSpec = {
    runnerCount: 8, maxLength: 3, stepSize: 0.09, branchChance: 0.05, branchAngle: 0.7, branchDecay: 0.55, branchDepth: 1,
    growthBias: 0.8, wander: 0.5, coverage: 0.75, frontier: 0.12, seedRow: 0.02,
    clingOffset: 0.02, hangGravity: 0.35, hangDrift: 0.25,
    thickness: 0.008, sides: 3,
    leafSpacing: 0.07, leafDensity: 0.8, leafSize: 0.075, leafSizeVar: 0.25, tipScale: 0.3, ageSpan: 0.45, newGrowth: 0.3,
    droop: 0.4, leafLift: 0.2, phyllotaxy: 'alternate', leafShape: 'palmate',
    leafCurve: 0.35, leafFold: 0.14, leafTwist: 0.25, leafSegments: 3,
};

export function resolveRunner(partial: Partial<RunnerSpec> = {}): RunnerSpec {
    return { ...DEFAULT_RUNNER, ...partial };
}

// ── Accumulators ─────────────────────────────────────────────────────────────────────────────────
/**
 * Six channels, because ivy needs TWO independent splits:
 *   · stem / leaf / tip — the woody runner reads PALE against dark mature leaves in sparse ivy, and the
 *     new growth at the tips is yellow-green (clearly visible in the reference shots),
 *   · CLINGING / FREE  — ★ the wind split (§8 P3). Everything on a free/hanging span goes to the `*Free`
 *     channel so the host can give it a completely different sway from the clinging geometry.
 * The `*Free` channels are optional; leave them null and free geometry falls back to the clinging one.
 */
export interface RunnerAccum {
    stem: Accum3D;
    leaf: Accum3D;
    tip?: Accum3D | null;
    stemFree?: Accum3D | null;
    leafFree?: Accum3D | null;
    tipFree?: Accum3D | null;
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────────

/** One grown or authored centreline. `hang[i]` = that point is past a host edge (free / falling). */
export interface RunnerPath {
    pts: V3[];
    /** Outward host normal carried at each point (the last clung normal, on free spans). */
    nrm: V3[];
    hang: boolean[];
    /** Coverage-mask value at each point (1 in path mode). */
    cov: number[];
    /** Centreline length (m). */
    length: number;
    /** 0 = a seed runner, 1+ = a branch. */
    depth: number;
}

export interface RunnerLeaf {
    /** Attachment point. */
    p: V3;
    /** Spine param on its runner. */
    t: number;
    /** Arclength from the runner's base (m) — leaf spacing is verifiable from this. */
    dist: number;
    /** Distance to the growing TIP (m) — the age axis. */
    toTip: number;
    size: number;
    /** On a free/hanging span. */
    hanging: boolean;
    /** New growth (went to the lighter tip accumulator). */
    young: boolean;
    runner: number;
}

export interface RunnerResult {
    runners: number;
    leaves: number;
    /** Leaves on free/hanging spans (the ones the wind actually moves). */
    hangingLeaves: number;
    paths: RunnerPath[];
    leafList: RunnerLeaf[];
    /** Max world Y touched by a stem station or a leaf tip. */
    height: number;
    /** Total centreline metres grown. */
    length: number;
    /** True when a cap truncated the plant (also logged). */
    truncated: boolean;
}

// ── (a) AREA growth ──────────────────────────────────────────────────────────────────────────────

interface Seed { p: V3; dir: V3; n: V3; budget: number; depth: number; free: boolean }

/**
 * Grow runners over a host from seeds along the region's `seedRow`. Each step: bias + wander, then CLING
 * (project the stepped point back onto the host, offset by leaf thickness); past an edge the runner HANGS
 * (gravity takes over and it droops off — the detail that sells ivy on a wall); `branchChance` throws side
 * runners; the coverage mask kills growth at the frontier.
 */
export function growRunners(host: RunnerHost, spec: RunnerSpec, rnd: () => number, seedOffset = 0): RunnerPath[] {
    const cap = Math.max(1, Math.round(spec.maxRunners ?? MAX_RUNNERS));
    const nSeed = Math.max(1, Math.round(spec.runnerCount));
    const mask = (u: number, v: number): number => coverageAt(u, v, spec.coverage, seedOffset);
    const queue: Seed[] = [];
    for (let i = 0; i < nSeed; i++) {
        const u = clamp01((i + 0.5) / nSeed + (rnd() - 0.5) * (0.9 / nSeed));
        const v = clamp01(spec.seedRow + rnd() * 0.06);
        const hit = host.at(u, v);
        const tUp = tangentUp(hit.n);
        const horiz = cfNorm(cfCross(tUp, hit.n));
        const raw: V3 = [
            tUp[0] * spec.growthBias + horiz[0] * (rnd() * 2 - 1) * 0.8,
            tUp[1] * spec.growthBias + horiz[1] * (rnd() * 2 - 1) * 0.8,
            tUp[2] * spec.growthBias + horiz[2] * (rnd() * 2 - 1) * 0.8,
        ];
        queue.push({ p: add(hit.p, hit.n, spec.clingOffset), dir: cfLen(raw) > 1e-5 ? cfNorm(raw) : horiz, n: hit.n, budget: spec.maxLength, depth: 0, free: false });
    }

    const paths: RunnerPath[] = [];
    let warned = false;
    for (let q = 0; q < queue.length; q++) {
        if (paths.length >= cap) {
            if (!warned) { warned = true; console.warn(`[runner] runner count capped at ${cap} — extra runners dropped (foliage-quality.md §7 — density loss is never silent)`); }
            break;
        }
        const children: Seed[] = [];
        const path = growOne(host, queue[q], spec, rnd, mask, children);
        if (path.pts.length > 1) paths.push(path);
        for (const c of children) queue.push(c);
    }
    return paths;
}

function growOne(host: RunnerHost | null, seed: Seed, spec: RunnerSpec, rnd: () => number, mask: ((u: number, v: number) => number) | null, children: Seed[]): RunnerPath {
    const step = Math.max(0.004, spec.stepSize);
    const path: RunnerPath = { pts: [seed.p], nrm: [seed.n], hang: [seed.free], cov: [1], length: 0, depth: seed.depth };
    let p = seed.p, dir = seed.dir, n = seed.n, free = seed.free;
    const steps = Math.min(2000, Math.max(1, Math.ceil(seed.budget / step)));
    for (let i = 0; i < steps; i++) {
        let cov = 1;
        if (!free && host) {
            // CRAWL: bias (up / along / down the host) + a wander term, kept in the tangent plane.
            const tUp = tangentUp(n);
            const side = cfNorm(cfCross(n, dir));
            const w = (rnd() * 2 - 1) * spec.wander;
            let d: V3 = [dir[0] + tUp[0] * spec.growthBias * 0.6 + side[0] * w, dir[1] + tUp[1] * spec.growthBias * 0.6 + side[1] * w, dir[2] + tUp[2] * spec.growthBias * 0.6 + side[2] * w];
            const dn = cfDot(d, n);
            d = [d[0] - n[0] * dn, d[1] - n[1] * dn, d[2] - n[2] * dn];
            dir = cfLen(d) > 1e-6 ? cfNorm(d) : dir;
            const hit = host.project(add(p, dir, step));
            if (hit.inside) {
                // CLING: the stepped point goes back ONTO the surface, offset by the leaf thickness.
                p = add(hit.p, hit.n, spec.clingOffset);
                n = hit.n;
                cov = mask ? mask(hit.u, hit.v) : 1;
                path.pts.push(p); path.nrm.push(n); path.hang.push(false); path.cov.push(cov);
                path.length += step;
                if (rnd() < spec.branchChance && seed.depth < spec.branchDepth) {
                    const a = spec.branchAngle * (rnd() < 0.5 ? -1 : 1);
                    const bd = cfNorm(rotAxis(dir, n, Math.cos(a), Math.sin(a)));
                    const left = (steps - i - 1) * step * spec.branchDecay;
                    if (left > step * 2) children.push({ p, dir: bd, n, budget: left, depth: seed.depth + 1, free: false });
                }
                // FRONTIER: growth dies out where the coverage mask does → fingers, never a straight edge.
                if (cov < spec.frontier) break;
                continue;
            }
            free = true;   // past an edge — fall through into the hanging branch on this same step
        }
        // HANG: gravity takes over, with a little drift away from the wall.
        const g = clamp01(spec.hangGravity);
        const j = (rnd() - 0.5) * spec.hangDrift;
        const d: V3 = [dir[0] * (1 - g) + n[0] * j, dir[1] * (1 - g) - g, dir[2] * (1 - g) + n[2] * j];
        dir = cfLen(d) > 1e-6 ? cfNorm(d) : [0, -1, 0];
        p = add(p, dir, step);
        path.pts.push(p); path.nrm.push(n); path.hang.push(true); path.cov.push(1);
        path.length += step;
        if (rnd() < spec.branchChance * 0.5 && seed.depth < spec.branchDepth) {
            const a = spec.branchAngle * (rnd() < 0.5 ? -1 : 1);
            const bd = cfNorm(rotAxis(dir, n, Math.cos(a), Math.sin(a)));
            const left = (steps - i - 1) * step * spec.branchDecay;
            if (left > step * 2) children.push({ p, dir: bd, n, budget: left, depth: seed.depth + 1, free: true });
        }
    }
    return path;
}

// ── (b) PATH source ──────────────────────────────────────────────────────────────────────────────

/**
 * Turn an AUTHORED point list into a runner centreline — path source (b). The polyline IS the centreline
 * (it is smoothed by `polySpine` at emit time, which passes exactly through every supplied point); the
 * outward direction is `normal`, re-projected per point so leaves face away from whatever the path is
 * drawn on. Optionally seeds free side-branches that droop away under gravity.
 */
export function pathRunners(points: readonly V3[], spec: RunnerSpec, rnd: () => number, normal: V3 = [0, 0, 1]): RunnerPath[] {
    const pts: V3[] = [];
    for (const q of points) {
        const last = pts[pts.length - 1];
        if (!last || cfLen(sub(q, last)) > 1e-6) pts.push([q[0], q[1], q[2]]);
    }
    if (pts.length < 2) return [];
    const n0 = cfLen(normal) > 1e-6 ? cfNorm(normal) : [0, 0, 1] as V3;
    let length = 0;
    for (let i = 0; i + 1 < pts.length; i++) length += cfLen(sub(pts[i + 1], pts[i]));
    const main: RunnerPath = { pts, nrm: pts.map(() => n0), hang: pts.map(() => false), cov: pts.map(() => 1), length, depth: 0 };
    const out: RunnerPath[] = [main];

    // Side branches: they leave the authored path and are FREE from the first step (nothing to cling to),
    // so they hang under gravity exactly like an over-the-edge span does.
    const nb = Math.round(clamp(spec.branchChance, 0, 1) * (pts.length - 1));
    const cap = Math.max(1, Math.round(spec.maxRunners ?? MAX_RUNNERS));
    for (let b = 0; b < nb && out.length < cap; b++) {
        const i = Math.max(1, Math.min(pts.length - 2, Math.floor(((b + 0.5) / Math.max(1, nb)) * (pts.length - 1))));
        const tan = cfNorm(sub(pts[i + 1], pts[i - 1]));
        const side = cfNorm(cfCross(n0, tan));
        const a = spec.branchAngle * (rnd() < 0.5 ? -1 : 1);
        const dir = cfNorm(rotAxis(side, n0, Math.cos(a), Math.sin(a)));
        const child = growOne(null, { p: pts[i], dir, n: n0, budget: spec.maxLength * spec.branchDecay, depth: 1, free: true }, spec, rnd, null, []);
        if (child.pts.length > 1) out.push(child);
    }
    return out;
}

// ── The SHARED downstream: sweep the stem, distribute the leaves ─────────────────────────────────

/** Where a runner's geometry comes from — the ONLY place the two authoring flavours differ. */
export type RunnerSource =
    | { mode: 'area'; host: RunnerHost; seedOffset?: number }
    | { mode: 'path'; points: readonly V3[]; normal?: V3 }
    | { mode: 'paths'; paths: RunnerPath[] };

/**
 * Build a whole climber: resolve the path source, then — identically for both — sweep each runner's woody
 * stem and distribute leaves along it. Returns everything a caller (or a test) needs to verify the growth.
 */
export function buildRunners(acc: RunnerAccum, source: RunnerSource, spec: RunnerSpec, rnd: () => number): RunnerResult {
    const paths = source.mode === 'area' ? growRunners(source.host, spec, rnd, source.seedOffset ?? 0)
        : source.mode === 'path' ? pathRunners(source.points, spec, rnd, source.normal)
            : source.paths;
    const out: RunnerResult = { runners: 0, leaves: 0, hangingLeaves: 0, paths, leafList: [], height: 0, length: 0, truncated: false };
    const budget = { left: Math.max(1, Math.round(spec.maxLeaves ?? MAX_RUNNER_LEAVES)), warned: false };
    for (let i = 0; i < paths.length; i++) {
        if (paths[i].pts.length < 2) continue;
        emitRunner(acc, paths[i], spec, rnd, out, i, budget);
        out.runners++;
        out.length += paths[i].length;
    }
    out.truncated = budget.warned;
    return out;
}

interface LeafBudget { left: number; warned: boolean }

/** Pick the accumulator for a piece of geometry: mature/new × clinging/free (with null fallbacks). */
function pick(acc: RunnerAccum, kind: 'stem' | 'leaf' | 'tip', free: boolean): Accum3D {
    if (kind === 'stem') return (free ? acc.stemFree : null) ?? acc.stem;
    if (kind === 'tip') return (free ? (acc.tipFree ?? acc.leafFree) : null) ?? acc.tip ?? acc.leaf;
    return (free ? acc.leafFree : null) ?? acc.leaf;
}

/** ONE runner → a swept stem tube + leaves. Shared by both path sources (this is the point of the design). */
export function emitRunner(acc: RunnerAccum, path: RunnerPath, spec: RunnerSpec, rnd: () => number, out: RunnerResult, index: number, budget: LeafBudget): void {
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, RUNNER_LOD_SCALE.length - 1);
    const lodK = RUNNER_LOD_SCALE[lod];
    const spine = polySpine(path.pts);
    const total = Math.max(1e-4, spine.length);
    const last = path.pts.length - 1;

    // ── STEM: the stalk's tube sweep over the smoothed centreline, split into CLINGING / FREE spans so
    //    each half can carry its own colour and (★) its own wind response.
    // A runner stem is a thin twig seen from metres away — it needs far fewer tube rings than the
    // centreline has steps (the leaves ride the SPINE, not the tube, so nothing detaches).
    const stations = Math.max(2, Math.round(Math.min(96, last) * (lod === 0 ? 0.7 : lodK * 0.7)));
    const frames = sweepFrames(spine, sweepParams(stations));
    const hangAt = (t: number): boolean => path.hang[clamp(Math.round(t * last), 0, last)];
    const r0 = Math.max(1e-4, spec.thickness), r1 = r0 * 0.4;
    const sides = Math.max(3, Math.round(spec.sides * (lod === 2 ? 0.7 : 1)));
    let runStart = 0;
    for (let i = 1; i <= frames.length; i++) {
        const endOfRun = i === frames.length || hangAt(frames[i].t) !== hangAt(frames[runStart].t);
        if (!endOfRun) continue;
        const span: CurveFrame[] = frames.slice(runStart, Math.min(i + 1, frames.length));   // overlap 1 → no gap
        if (span.length > 1) emitTube(pick(acc, 'stem', hangAt(frames[runStart].t)), span, r0, r1, sides);
        runStart = i;
    }
    for (const f of frames) if (f.p[1] > out.height) out.height = f.p[1];

    // ── LEAVES along the runner ─────────────────────────────────────────────────────────────────────
    // Spacing is in METRES of arclength (polySpine is chord-length parameterised, so t ≈ s / length).
    // LOD thins by WIDENING the spacing, which keeps the distribution's character instead of clipping it.
    const spacing = Math.max(0.004, spec.leafSpacing / Math.max(0.05, lodK));
    const opposite = spec.phyllotaxy === 'opposite';
    let k = 0;
    for (let s = spacing * 0.5; s < total; s += spacing, k++) {
        const t = clamp01(s / total);
        const idx = clamp(Math.round(t * last), 0, last);
        const cov = path.cov[idx];
        // The frontier + the density knob, together: this is the sparse-runners ↔ leaf-carpet continuum.
        if (rnd() >= clamp01(spec.leafDensity) * (0.25 + 0.75 * cov)) continue;
        const hanging = path.hang[idx];
        const n = path.nrm[idx];
        const P = spine.at(t), tan = spine.tangent(t);
        const toTip = total - s;
        // ★ SIZE BY AGE — leaves shrink toward the growing tip (visible in every reference photo).
        const age = clamp01(toTip / Math.max(1e-4, spec.ageSpan));
        const base = add(P, n, spec.thickness * 0.8);
        const young = toTip < spec.newGrowth;
        const sides2 = opposite ? [1, -1] : [k % 2 === 0 ? 1 : -1];
        for (const sgn of sides2) {
            if (budget.left <= 0) {
                if (!budget.warned) { budget.warned = true; console.warn(`[runner] leaf budget hit (${spec.maxLeaves ?? MAX_RUNNER_LEAVES}) — extra leaves dropped (foliage-quality.md §7)`); }
                return;
            }
            budget.left--;
            const size = Math.max(1e-4, spec.leafSize * (spec.tipScale + (1 - spec.tipScale) * age) * (1 + (rnd() * 2 - 1) * spec.leafSizeVar));
            // ORIENTATION: the leaf grows sideways off the runner, IN the host's tangent plane (an ivy leaf
            // lies flat against its wall), lifted a little off the surface, drooping under gravity — and it
            // arcs toward `out` = the host normal, so the tip curls away from the wall.
            const tUp = tangentUp(n);
            let side = cfNorm(cfCross(n, tan));
            if (spec.phyllotaxy === 'spiral') { const a = k * GOLDEN_ANGLE; side = cfNorm(rotAxis(side, n, Math.cos(a), Math.sin(a))); }
            const droop = spec.droop * (hanging ? 1.5 : 1);
            const yaw = (rnd() * 2 - 1) * 0.35, tilt = (rnd() * 2 - 1) * 0.2;
            const axisRaw: V3 = [
                side[0] * sgn * (0.85 + yaw) + tan[0] * 0.22 - tUp[0] * droop * 0.9 + n[0] * (spec.leafLift + tilt * 0.3),
                side[1] * sgn * (0.85 + yaw) + tan[1] * 0.22 - tUp[1] * droop * 0.9 + n[1] * (spec.leafLift + tilt * 0.3),
                side[2] * sgn * (0.85 + yaw) + tan[2] * 0.22 - tUp[2] * droop * 0.9 + n[2] * (spec.leafLift + tilt * 0.3),
            ];
            const axis = cfLen(axisRaw) > 1e-6 ? cfNorm(axisRaw) : side;
            const y = emitBlade(pick(acc, young ? 'tip' : 'leaf', hanging), null, 1, base, axis[0], axis[2], {
                length: size, width: size * 0.95, taper: 0, curve: spec.leafCurve + tilt * 0.2,
                segments: Math.max(2, Math.round(spec.leafSegments)), twist: spec.leafTwist * (rnd() < 0.5 ? -1 : 1),
                foldAngle: spec.leafFold, lean: 0, shape: spec.leafShape, axis, out: n, pitch: 0,
            });
            if (y > out.height) out.height = y;
            out.leaves++;
            if (hanging) out.hangingLeaves++;
            out.leafList.push({ p: base, t, dist: s, toTip, size, hanging, young, runner: index });
        }
    }
}
