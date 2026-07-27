// ─────────────────────────────────────────────────────────────────────────────
// The `whorl` PRIMITIVE (foliage-quality.md §3.2, phase P2) — radial elements around an axis.
// The generative atom behind FLOWERS (daisy ray florets, rapeseed/lavender florets), succulents,
// fern crowns and palm tops.
//
// ★ REUSE, not a second sweep: every petal is `emitBlade` with a petal width profile (`shape`), a
// small `twist`, and a `pitch` — the opening angle from the flower's axis. `pitch` IS the bloom-state
// knob: 0 = a closed bud (petals hug the axis), ≈π/2 = flat open, >π/2 = reflexed. Petals `faceFlip`
// so their UPPER (adaxial) surface carries the normal — that is the face the S2 translucency lights.
//
// A real flower is not one flat ring, so a whorl stacks `rows` of `count` petals, rotated between
// rows by `rowOffset` (0.5 = perfectly interleaved) and progressively smaller / more upright inward.
// The disc ("eye") is emitted into its OWN accumulator so it can carry `centerColor`.
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { emitBlade, bladeReach, type BladeShape, type BladeParams } from './blade';
import { perpFrame, cfCross, cfDot, cfNorm, type V3 } from './curve-frame';

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Petal silhouettes (§3.2 `shape`) — the `blade` grass profile is deliberately not one of them. */
export type PetalShape = Exclude<BladeShape, 'blade'>;

/** Petal-count multiplier per LOD band, mirroring `BLADE_LOD_SCALE` (§2.5). */
export const WHORL_LOD_SCALE = [1, 0.6, 0.38];
/** Hard cap on petals in ONE whorl — truncation is LOGGED, never silent (§7). */
export const MAX_PETALS_PER_WHORL = 48;

export interface WhorlSpec {
    /** Petals / leaflets per row. */
    count: number;
    /** Stacked whorls (rows ≥ 2 is what stops a flower reading as a paper cut-out). */
    rows: number;
    /** Rotation between rows, as a fraction of the angular step. 0.5 = perfectly interleaved. */
    rowOffset: number;
    /** Petal length / base width (metres). */
    elementLength: number;
    elementWidth: number;
    /** ± fraction of per-petal length jitter. */
    lengthVar: number;
    /** Petal silhouette: rounded · pointed · notched · strap. */
    shape: PetalShape;
    /** `notched` only: depth of the tip notch, 0..1. */
    notch: number;
    /** ★ THE BLOOM-STATE KNOB — opening angle from the axis (radians). 0 = bud · ~1.4 = flat · >π/2 = reflexed. */
    pitch: number;
    /** ± radians of per-petal pitch jitter (a real flower is never symmetric). */
    pitchVar: number;
    /** Pitch DELTA applied per row inward — negative keeps the inner rows more upright. */
    rowPitch: number;
    /** Length multiplier per row inward. */
    rowScale: number;
    /** Axial lift per row inward, × elementLength. */
    rowLift: number;
    /** Petal arc (droop), 0..1. */
    curve: number;
    /** Twist along the petal — much lower than a grass blade; a petal is a broad, flat-ish surface. */
    twist: number;
    /** V cross-section half-angle — a small value CUPS the petal. */
    fold: number;
    /** Spine subdivisions per petal (2–4 is plenty; a whorl multiplies this by `count × rows`). */
    segments: number;
    /** Disc / eye radius (0 = no centre emitted). */
    centerRadius: number;
    /** Dome height of the disc, × centerRadius. */
    centerDome: number;
    /** Disc fan segments. */
    centerSides: number;
    /** 0 near · 1 mid · 2 far — scales the petal count (§2.5). */
    lodLevel?: number;
    maxPetals?: number;
}

export const DEFAULT_WHORL: WhorlSpec = {
    count: 14, rows: 1, rowOffset: 0.5, elementLength: 0.05, elementWidth: 0.016, lengthVar: 0.14,
    shape: 'rounded', notch: 0, pitch: 1.2, pitchVar: 0.14, rowPitch: -0.28, rowScale: 0.8, rowLift: 0.12,
    curve: 0.25, twist: 0.22, fold: 0.22, segments: 3,
    centerRadius: 0.012, centerDome: 0.5, centerSides: 7,
};

export function resolveWhorl(partial: Partial<WhorlSpec> = {}): WhorlSpec {
    return { ...DEFAULT_WHORL, ...partial };
}

/** Where a whorl sits: its origin, the axis it opens around, an optional 0° reference direction (⊥ axis). */
export interface WhorlPlacement {
    base: V3;
    axis?: V3;
    ref?: V3;
    /** Uniform size multiplier (the stalk shrinks florets toward the tip with this). */
    scale?: number;
    /** Extra azimuth (radians) so neighbouring florets don't line up. */
    yaw?: number;
}

export interface WhorlResult {
    /** Petals actually emitted (all rows, after the LOD scale + the cap). */
    petals: number;
    /** Reach from the whorl origin, perpendicular to the axis (the footprint radius). */
    radius: number;
    /** Highest world Y touched by a petal tip (the wind-grading denominator feeds off this). */
    top: number;
}

/** An oriented fan disc — the flower's eye. Cheap (`sides` triangles) and correctly oriented on a tilted head. */
function emitDisc(acc: Accum3D, o: V3, axis: V3, ref: V3, bino: V3, radius: number, dome: number, sides: number): void {
    const n = Math.max(3, Math.round(sides));
    const apex: V3 = [o[0] + axis[0] * dome, o[1] + axis[1] * dome, o[2] + axis[2] * dome];
    const c = acc.vertex(apex, axis, 0.5, 0.5);
    const ring: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const d: V3 = [ref[0] * ca + bino[0] * sa, ref[1] * ca + bino[1] * sa, ref[2] * ca + bino[2] * sa];
        const p: V3 = [o[0] + d[0] * radius, o[1] + d[1] * radius, o[2] + d[2] * radius];
        // Normal leans out from the dome axis → the eye reads as a slightly domed button, not a flat disc.
        const nn = cfNorm([axis[0] * 1.4 + d[0] * 0.6, axis[1] * 1.4 + d[1] * 0.6, axis[2] * 1.4 + d[2] * 0.6]);
        ring.push(acc.vertex(p, nn, 0.5 + 0.5 * ca, 0.5 + 0.5 * sa));
    }
    for (let i = 0; i < n; i++) acc.triangle(c, ring[i], ring[(i + 1) % n]);
}

/**
 * Emit one whorl: `rows × count` petals radiating around `at.axis`, plus (optionally) the centre disc.
 * `petals` and `centre` are separate accumulators so the eye can carry its own colour (§3.2
 * `centerColor`); pass `centre === null` to skip the eye entirely.
 */
export function emitWhorl(petals: Accum3D, centre: Accum3D | null, spec: WhorlSpec, at: WhorlPlacement, rnd: () => number): WhorlResult {
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
    const s = Math.max(1e-4, at.scale ?? 1);
    const yaw = at.yaw ?? 0;

    const rows = Math.max(1, Math.round(spec.rows));
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, WHORL_LOD_SCALE.length - 1);
    const perRow = Math.max(3, Math.round(Math.max(1, spec.count) * WHORL_LOD_SCALE[lod]));
    const cap = Math.max(3, Math.round(spec.maxPetals ?? MAX_PETALS_PER_WHORL));
    let want = perRow * rows;
    let n = perRow;
    if (want > cap) {
        n = Math.max(1, Math.floor(cap / rows));
        console.warn(`[whorl] petal count capped ${want} → ${n * rows} (foliage-quality.md §7 — density loss is never silent)`);
        want = n * rows;
    }

    const R0 = Math.max(0, spec.centerRadius) * s;
    let radius = R0, top = at.base[1];
    let emitted = 0;
    for (let r = 0; r < rows; r++) {
        const rowS = s * Math.pow(Math.max(0.05, spec.rowScale), r);
        const lift = spec.rowLift * spec.elementLength * s * r;
        const org: V3 = [at.base[0] + axis[0] * lift, at.base[1] + axis[1] * lift, at.base[2] + axis[2] * lift];
        const pitchR = spec.pitch + spec.rowPitch * r;
        for (let i = 0; i < n; i++) {
            const a = yaw + ((i + r * spec.rowOffset) / n) * TAU;
            const ca = Math.cos(a), sa = Math.sin(a);
            const dir: V3 = [ref[0] * ca + bino[0] * sa, ref[1] * ca + bino[1] * sa, ref[2] * ca + bino[2] * sa];
            const attach = R0 * 0.88;
            const bse: V3 = [org[0] + dir[0] * attach, org[1] + dir[1] * attach, org[2] + dir[2] * attach];
            const pitch = clamp(pitchR + (rnd() * 2 - 1) * spec.pitchVar, -0.2, 2.7);
            const len = Math.max(1e-4, spec.elementLength * rowS * (1 + (rnd() * 2 - 1) * spec.lengthVar));
            const bp: BladeParams = {
                length: len, width: Math.max(1e-5, spec.elementWidth * rowS), taper: 0,
                curve: spec.curve, segments: spec.segments, twist: spec.twist * (rnd() < 0.5 ? -1 : 1),
                foldAngle: spec.fold, lean: 0,
                shape: spec.shape, notch: spec.notch, pitch, axis, out: dir, faceFlip: true,
            };
            emitBlade(petals, null, 1, bse, dir[0], dir[2], bp);
            emitted++;
            // Reach = the spine end resolved through the SAME decomposition emitBlade uses (bladeReach),
            // so the footprint/height can never drift away from the geometry.
            const reach = bladeReach(bp);
            const cp = Math.cos(pitch), sp = Math.sin(pitch);
            const ax = reach.up * cp - reach.out * sp;      // along the flower axis
            const rad = reach.up * sp + reach.out * cp;     // out along `dir`
            const tip: V3 = [org[0] + axis[0] * ax + dir[0] * (attach + rad), org[1] + axis[1] * ax + dir[1] * (attach + rad), org[2] + axis[2] * ax + dir[2] * (attach + rad)];
            if (tip[1] > top) top = tip[1];
            const d = cfDot([tip[0] - at.base[0], tip[1] - at.base[1], tip[2] - at.base[2]], axis);
            const rr = Math.hypot(tip[0] - at.base[0] - axis[0] * d, tip[1] - at.base[1] - axis[1] * d, tip[2] - at.base[2] - axis[2] * d);
            if (rr > radius) radius = rr;
        }
    }
    if (centre && R0 > 1e-5) emitDisc(centre, at.base, axis, ref, bino, R0, R0 * spec.centerDome, spec.centerSides);
    return { petals: emitted, radius, top };
}
