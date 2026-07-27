// ─────────────────────────────────────────────────────────────────────────────
// The `blade` PRIMITIVE (foliage-quality.md §3.1, phase P1) — a curved, tapered, TWISTED, FOLDED
// strip swept along a bezier spine. The generative atom behind grass, reeds, iris and palm fronds.
//
// Why it replaces the old cones: a cone has no curve, no taper-to-a-point and — fatally — a single
// smooth normal field, so it never catches light. A real blade is
//   · CURVED   — a bezier spine that stands vertical at the base and arcs over (the droop),
//   · TAPERED  — width narrows monotonically to a point at the tip,
//   · TWISTED  — the cross-section rotates along the spine, so the surface normal rotates with it,
//   · FOLDED   — a V cross-section (ridge + two half-planes splayed by ±foldAngle about the tangent),
//     which is what actually produces the shimmer: the two halves never share a normal.
//
// Curve machinery is REUSED, not reinvented: `bezierSpine` + `sweepFrames` (parallel transport) in
// ./curve-frame.ts are the same functions hair-generator.ts sweeps its hair cards with.
//
// ★ P2 (§3.2) GENERALISED this one sweep rather than adding a second: a PETAL is a short, wide blade.
// The additions are all optional and default to the P1 grass behaviour —
//   · `shape`      — the width profile / tip silhouette: blade · rounded · pointed · notched · strap,
//   · `notch`      — retracts the tip ridge between two lobes (the heart-shaped petal end),
//   · `pitch`      — opening angle from the growth axis: bud → flat → reflexed (the bloom-state knob),
//   · `axis`/`out` — an arbitrary growth frame, so a floret can sit on a tilted stem frame,
//   · `faceFlip`   — presents the UPPER surface to the light (petals) instead of the outer one.
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { bezierSpine, sweepFrames, sweepParams, rotAxis, perpFrame, cfCross, cfDot, cfNorm, type V3 } from './curve-frame';

/**
 * The WIDTH PROFILE / tip silhouette of a swept strip (§3.2 `shape`). `blade` is the grass profile the
 * primitive was born with (monotonic taper to a point, driven by `taper`); the other four are PETAL
 * silhouettes — a petal is just a short, wide blade with a belly and a different tip, which is why P2
 * GENERALISED this function instead of writing a second sweep.
 */
export type BladeShape = 'blade' | 'rounded' | 'pointed' | 'notched' | 'strap' | 'palmate';

/**
 * Half-width multiplier (0..1) at spine param `t`. `taper` only applies to the `blade` profile — the
 * petal profiles carry their own silhouette (narrow claw → broad belly → their own tip).
 */
export function bladeWidthProfile(shape: BladeShape, t: number, taper: number): number {
    switch (shape) {
        case 'rounded': return Math.sin(Math.PI * (0.28 + 0.62 * t));   // blunt, rounded end (daisy ray)
        case 'pointed': return Math.sin(Math.PI * (0.22 + 0.78 * t));   // → exactly 0 at the tip (a point)
        case 'notched': return Math.sin(Math.PI * (0.30 + 0.60 * t));   // wide end; the ridge is retracted below
        case 'strap':   return 1 - 0.22 * t * t * t;                    // near-constant band (lavender bract)
        // IVY / palmate LEAF (P3 §3.4): a narrow petiole attachment, BROAD SHOULDERS low down (where a real
        // ivy leaf throws its two side lobes) and a long taper to a point. A 3-column strip cannot cut the
        // lobes themselves, but the shoulder bulge + the pointed tip is what reads as "ivy" in silhouette.
        case 'palmate': return 0.76 * Math.sin(Math.PI * (0.44 + 0.52 * t)) * (1 + 0.35 * Math.exp(-Math.pow((t - 0.26) / 0.16, 2)));
        default:        return 1 - taper * Math.pow(t, 0.85);           // 'blade' — the P1 grass taper
    }
}

/** One blade's shape (§3.1). Lengths are in the same units as the caller (metres for foliage). */
export interface BladeParams {
    /** Blade height along the spine (before curve shortens the vertical reach). */
    length: number;
    /** Base width of the strip. */
    width: number;
    /** Base→tip taper, 0..1. 1 = narrows to a point. Only used by the `blade` shape. */
    taper: number;
    /** Droop arc, 0 = upright, 1 = flopping right over. */
    curve: number;
    /** Spine subdivisions (3..7 — more = smoother arc, more verts). */
    segments: number;
    /** Total rotation (radians) of the cross-section from base to tip — the light-catch shimmer. */
    twist: number;
    /** V cross-section half-angle (radians). 0 = a flat card; ~0.5 = a properly folded blade. */
    foldAngle: number;
    /** Outward lean of the tip away from the clump centre, 0..1 (× length). */
    lean: number;
    // ── P2 (§3.2) generalisations: everything below defaults to the P1 grass behaviour ──────────────
    /** Width profile / tip silhouette. Default `'blade'` (the P1 taper). */
    shape?: BladeShape;
    /** `'notched'` only: how far the tip RIDGE is pulled back between the two lobes (0..1 × 0.12·length). */
    notch?: number;
    /**
     * Opening angle (radians) between the GROWTH AXIS and the strip's own start direction — the whorl's
     * bloom-state knob. `0` = the element grows straight along the axis (a closed bud / the P1 blade),
     * `≈π/2` = flat, `>π/2` = reflexed (petals folded back down).
     */
    pitch?: number;
    /** The growth axis the strip stands on. Default `[0,1,0]` (a ground-planted blade). */
    axis?: V3;
    /** The opening direction (⊥ axis). Default = the horizontal `dirX/dirZ` passed to {@link emitBlade}. */
    out?: V3;
    /** Flip the face (normals + winding). Petals use it so the LIT face is the upper (adaxial) surface. */
    faceFlip?: boolean;
}

/**
 * The spine END offset of a blade, decomposed along its growth axis and its opening direction — so a
 * caller (the `whorl` / `stalk`) can work out reach/footprint WITHOUT duplicating the spine construction.
 * {@link emitBlade} builds its own end point from exactly this.
 */
export function bladeReach(p: BladeParams): { up: number; out: number } {
    const L = Math.max(1e-4, p.length);
    const curve = clamp(p.curve, 0, 1.4), lean = clamp(p.lean, 0, 1.2);
    return { up: L * (0.98 - curve * 0.55), out: L * (lean * 0.35 + curve * 0.75) };
}

/** Where the blade hands over from the `leaf` accumulator to the lighter `tip` one (0..1 along the
 *  spine). ≥1 (or a null tip accumulator) keeps the whole blade in `leaf`. */
export const DEFAULT_TIP_START = 0.6;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface Row { L: V3; C: V3; R: V3; nL: V3; nC: V3; nR: V3; v: number }

/**
 * Sweep ONE blade into `lower` (and, above `tipStart`, into `upper` — the lighter new-growth colour).
 * `base` is the blade's root; `dirX`/`dirZ` a unit horizontal direction it leans out along.
 * Returns the blade's tip height (world Y), so a clump can report its real height for wind grading.
 */
export function emitBlade(
    lower: Accum3D, upper: Accum3D | null, tipStart: number,
    base: V3, dirX: number, dirZ: number, p: BladeParams,
): number {
    const L = Math.max(1e-4, p.length);
    const curve = clamp(p.curve, 0, 1.4);
    const lean = clamp(p.lean, 0, 1.2);
    const segs = Math.max(2, Math.round(clamp(p.segments, 2, 12)));
    const taper = clamp(p.taper, 0, 1);
    const fold = clamp(p.foldAngle, 0, 1.35);
    const dl = Math.hypot(dirX, dirZ) || 1;
    const ox = dirX / dl, oz = dirZ / dl;
    const shape = p.shape ?? 'blade';

    // ── ORIENTATION (P2 §3.2). The P1 blade grew straight up (+Y) and arced along a horizontal
    // direction. Generalised to an arbitrary growth `axis` + opening direction `out`, then ROTATED by
    // `pitch` about their common binormal — which is exactly the "bud → flat → reflexed" petal knob.
    // With the defaults (axis +Y, out = the horizontal dir, pitch 0) this reduces term-for-term to P1.
    const axis: V3 = p.axis ? cfNorm(p.axis) : [0, 1, 0];
    let outV: V3;
    if (p.out || p.axis) {
        const raw: V3 = p.out ? [p.out[0], p.out[1], p.out[2]] : [ox, 0, oz];
        const d = cfDot(raw, axis);
        const perp: V3 = [raw[0] - axis[0] * d, raw[1] - axis[1] * d, raw[2] - axis[2] * d];
        outV = Math.hypot(perp[0], perp[1], perp[2]) > 1e-6 ? cfNorm(perp) : perpFrame(axis).u;
    } else {
        outV = [ox, 0, oz];
    }
    const pitch = p.pitch ?? 0;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const up3: V3 = [axis[0] * cp + outV[0] * sp, axis[1] * cp + outV[1] * sp, axis[2] * cp + outV[2] * sp];
    const ot3: V3 = [outV[0] * cp - axis[0] * sp, outV[1] * cp - axis[1] * sp, outV[2] * cp - axis[2] * sp];

    // Spine: starts along the (pitched) growth axis — the base stays planted, which is what the wind
    // grading assumes — and arcs over toward `ot3`.
    const A: V3 = [base[0], base[1], base[2]];
    const reach = bladeReach(p);
    const cUp = L * 0.62, cOut = L * lean * 0.15;
    const eUp = reach.up, eOut = reach.out;
    const C: V3 = [A[0] + up3[0] * cUp + ot3[0] * cOut, A[1] + up3[1] * cUp + ot3[1] * cOut, A[2] + up3[2] * cUp + ot3[2] * cOut];
    const E: V3 = [A[0] + up3[0] * eUp + ot3[0] * eOut, A[1] + up3[1] * eUp + ot3[1] * eOut, A[2] + up3[2] * eUp + ot3[2] * eOut];

    const spine = bezierSpine(A, C, E);
    const ts = sweepParams(segs, tipStart);
    const frames = sweepFrames(spine, ts);

    // Seed roll: the strip's WIDTH axis is the binormal of the (axis, out) plane, so the flat of the
    // blade faces outward from the clump (and the fold ridge points away from the centre). `faceFlip`
    // rotates it by π — normals AND winding — so a petal presents its UPPER surface to the light.
    let w0 = cfCross(axis, outV);
    if (Math.hypot(w0[0], w0[1], w0[2]) < 1e-5) w0 = frames[0].u; else w0 = cfNorm(w0);
    const roll0 = Math.atan2(cfDot(w0, frames[0].v), cfDot(w0, frames[0].u)) + (p.faceFlip ? Math.PI : 0);

    const cosF = Math.cos(fold), sinF = Math.sin(fold);
    const halfW = 0.5 * Math.max(1e-5, p.width);
    const rows: Row[] = [];
    let tipY = base[1];
    for (const f of frames) {
        const ang = roll0 + p.twist * f.t;
        const w = rotAxis(f.u, f.tan, Math.cos(ang), Math.sin(ang));   // width axis (u rolled about the tangent)
        const n = cfNorm(cfCross(w, f.tan));                           // face normal of the UNFOLDED strip
        // Width profile: `blade` = monotonic taper to (near) a point — t^0.85 keeps the blade wide low
        // down then narrows fast; the petal shapes put the belly low and end blunt / pointed / notched.
        const hw = Math.max(1e-5, halfW * bladeWidthProfile(shape, f.t, taper));
        const e = hw * cosF, d = hw * sinF;                            // edge inset + ridge lift of the V
        const P = f.p;
        rows.push({
            L: [P[0] - w[0] * e, P[1] - w[1] * e, P[2] - w[2] * e],
            C: [P[0] + n[0] * d, P[1] + n[1] * d, P[2] + n[2] * d],
            R: [P[0] + w[0] * e, P[1] + w[1] * e, P[2] + w[2] * e],
            // The two halves of the V splay ±foldAngle about the tangent → they NEVER share a normal,
            // and the twist rotates both along the length. That is the whole light-catch trick.
            nL: cfNorm([n[0] * cosF - w[0] * sinF, n[1] * cosF - w[1] * sinF, n[2] * cosF - w[2] * sinF]),
            nC: n,
            nR: cfNorm([n[0] * cosF + w[0] * sinF, n[1] * cosF + w[1] * sinF, n[2] * cosF + w[2] * sinF]),
            v: f.t,
        });
        if (P[1] > tipY) tipY = P[1];
    }

    // NOTCHED tip: retract the fold ridge of the last row back down the spine, leaving the two lobes
    // proud — the heart-shaped petal end (a 3-column strip can express it no other way).
    const notch = clamp(p.notch ?? 0, 0, 1);
    if (shape === 'notched' && notch > 1e-4 && rows.length > 1) {
        const last = rows[rows.length - 1], tan = frames[frames.length - 1].tan, back = notch * L * 0.12;
        last.C = [last.C[0] - tan[0] * back, last.C[1] - tan[1] * back, last.C[2] - tan[2] * back];
    }

    // Split point: rows [0..k] carry the mature leaf colour, [k..end] the lighter tip. The boundary row
    // is emitted into BOTH strips so there is no seam.
    let k = rows.length - 1;
    if (upper && tipStart > 1e-4 && tipStart < 1 - 1e-4) {
        k = 0;
        for (let i = 0; i < rows.length; i++) if (Math.abs(rows[i].v - tipStart) < 1e-6) { k = i; break; }
    }
    emitStrip(lower, rows, 0, k);
    if (upper && k < rows.length - 1) emitStrip(upper, rows, k, rows.length - 1);
    return tipY;
}

/** Stitch rows [i0..i1] into a two-panel (V) strip. uv.u = 0 / 0.5 / 1 across the width, uv.v = base→tip. */
function emitStrip(acc: Accum3D, rows: Row[], i0: number, i1: number): void {
    if (i1 <= i0) return;
    let pl = -1, pc = -1, pr = -1;
    for (let i = i0; i <= i1; i++) {
        const r = rows[i];
        const l = acc.vertex(r.L, r.nL, 0, r.v);
        const c = acc.vertex(r.C, r.nC, 0.5, r.v);
        const rt = acc.vertex(r.R, r.nR, 1, r.v);
        if (i > i0) {
            acc.triangle(pl, l, c); acc.triangle(pl, c, pc);          // left half-plane
            acc.triangle(pc, c, rt); acc.triangle(pc, rt, pr);        // right half-plane
        }
        pl = l; pc = c; pr = rt;
    }
}

// ── The `clump` recipe: a radial tuft of blades (§4 "grass tuft") ─────────────────────────────────

/** Blade-count multiplier per LOD band (§2.5): 0 = near/full, 1 = mid, 2 = far. */
export const BLADE_LOD_SCALE = [1, 0.55, 0.3];
/** Hard cap on blades in ONE tuft — a truncation is LOGGED, never silent (§7). */
export const MAX_BLADES_PER_TUFT = 96;

export interface BladeTuftSpec {
    blades: number;       // target blade count at lodLevel 0 (before the cap)
    radius: number;       // clump base radius
    length: number;       // nominal blade length
    lengthVar: number;    // ± fraction
    width: number;        // nominal base width
    taper: number;
    curve: number;
    curveVar: number;     // ± fraction
    segments: number;
    twist: number;
    twistVar: number;     // ± fraction
    foldAngle: number;
    lean: number;
    leanVar: number;      // ± fraction
    /** Spine param where the lighter tip colour takes over (≥1 = no split). */
    tipStart: number;
    /** Width profile of every blade in the clump. Omitted = the P1 grass taper (byte-identical). */
    shape?: BladeShape;
    /** Clump ROOT (default the origin) — so an arrangement can plant a tuft anywhere in a vessel (P4v). */
    base?: V3;
    /** 0 near · 1 mid · 2 far — scales the blade count for distance (§2.5). */
    lodLevel?: number;
    maxBlades?: number;
}

export interface BladeTuftResult { blades: number; height: number }

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * A radial CLUMP of blades around the origin (base at y = 0) — the grass-tuft recipe. Blades lean OUT
 * from the centre (outer ones lean and droop more, and are a touch shorter → a natural dome), each with
 * its own length / curve / twist / width jitter drawn from `rnd` (so the same seed rebuilds it exactly).
 *
 * `tip` receives the upper `tipStart..1` portion of every blade (the new-growth colour gradient); pass
 * null to keep everything in `leaf`.
 */
export function bladeTuft(leaf: Accum3D, tip: Accum3D | null, spec: BladeTuftSpec, rnd: () => number): BladeTuftResult {
    const lod = clamp(Math.round(spec.lodLevel ?? 0), 0, BLADE_LOD_SCALE.length - 1);
    const want = Math.max(1, Math.round(Math.max(0, spec.blades) * BLADE_LOD_SCALE[lod]));
    const cap = Math.max(1, Math.round(spec.maxBlades ?? MAX_BLADES_PER_TUFT));
    const n = Math.min(want, cap);
    if (want > cap) console.warn(`[blade] tuft blade count capped ${want} → ${cap} (foliage-quality.md §7 — density loss is never silent)`);

    const R = Math.max(1e-4, spec.radius);
    const O = spec.base ?? [0, 0, 0];
    let height = 0;
    for (let i = 0; i < n; i++) {
        // Golden-angle azimuth + jitter: an even radial fan with no visible spokes.
        const a = i * GOLDEN_ANGLE + (rnd() - 0.5) * 0.9;
        const rel = Math.sqrt((i + 0.5) / n) * (0.55 + rnd() * 0.55);   // 0 = centre, ~1 = rim
        const rr = R * Math.min(1, rel);
        const dx = Math.cos(a), dz = Math.sin(a);
        const len = spec.length * (1 + (rnd() * 2 - 1) * spec.lengthVar) * (1 - 0.25 * rel);
        const curve = Math.max(0, spec.curve * (1 + (rnd() * 2 - 1) * spec.curveVar) + rel * 0.15);
        const twist = spec.twist * (1 + (rnd() * 2 - 1) * spec.twistVar) * (rnd() < 0.5 ? -1 : 1);
        const lean = Math.max(0, spec.lean * (0.35 + rel) * (1 + (rnd() * 2 - 1) * spec.leanVar));
        const width = spec.width * (0.8 + rnd() * 0.4);
        const y = emitBlade(leaf, tip, spec.tipStart, [O[0] + dx * rr, O[1], O[2] + dz * rr], dx, dz, {
            length: Math.max(1e-3, len), width, taper: spec.taper, curve,
            segments: spec.segments, twist, foldAngle: spec.foldAngle, lean,
            ...(spec.shape ? { shape: spec.shape } : {}),
        });
        if (y > height) height = y;
    }
    return { blades: n, height };
}
