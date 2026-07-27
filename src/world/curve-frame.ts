// ─────────────────────────────────────────────────────────────────────────────
// Shared CURVE + FRAME machinery (foliage-quality.md §3.1).
//
// The parallel-transport frame + bezier-spine sweep were originally written and debugged for HAIR
// CARDS (`hair-generator.ts` buildTail / buildTailCards): a frame carried down a curve by minimal
// rotation, so a swept ribbon can never spin or flip along its length (recomputing perpFrame() per
// segment does, and asymmetrically between mirrored tails — that bug is fixed here, once).
//
// It lives in src/world/ because the foliage `blade` primitive needs it and src/world/ must NOT
// import from src/services/managers/ (layering). hair-generator.ts imports `perpFrame` / `rotAxis`
// from HERE, so there is ONE implementation shared by hair and foliage — not a copy.
//
// Pure math: no Accum3D, no renderer, no scene-graph deps.
// ─────────────────────────────────────────────────────────────────────────────

export type V3 = [number, number, number];

export const cfAdd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const cfSub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cfScl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const cfCross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const cfDot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cfLen = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const cfNorm = (a: V3): V3 => { const l = cfLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** An arbitrary orthonormal pair perpendicular to `axis` (u, v, axis form a right-handed triple:
 *  u × v = axis, axis × u = v). Only used to SEED a sweep — carry it with {@link sweepFrames}
 *  afterwards; recomputing it per segment is what makes a ribbon spin/flip. */
export function perpFrame(axis: V3): { u: V3; v: V3 } {
    const a = cfNorm(axis);
    const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = cfNorm(cfCross(up, a));
    return { u, v: cfCross(a, u) };
}

/** Rodrigues rotation of `vec` about unit `axis` by an angle given as its cos/sin. */
export function rotAxis(vec: V3, axis: V3, c: number, s: number): V3 {
    const d = cfDot(axis, vec), cr = cfCross(axis, vec);
    return [
        vec[0] * c + cr[0] * s + axis[0] * d * (1 - c),
        vec[1] * c + cr[1] * s + axis[1] * d * (1 - c),
        vec[2] * c + cr[2] * s + axis[2] * d * (1 - c),
    ];
}

/** A parametric spine: position + unit tangent at t ∈ [0,1]. */
export interface Spine { at(t: number): V3; tangent(t: number): V3 }

/** Quadratic (A, C, E) or — when `C2` is given — CUBIC (A, C, C2, E) bezier spine. Same construction
 *  as the hair tails, so a grass blade and a hair card bend by the same math. */
export function bezierSpine(A: V3, C: V3, E: V3, C2?: V3): Spine {
    if (C2) {
        return {
            at: (t: number): V3 => { const it = 1 - t; return [
                it * it * it * A[0] + 3 * it * it * t * C[0] + 3 * it * t * t * C2[0] + t * t * t * E[0],
                it * it * it * A[1] + 3 * it * it * t * C[1] + 3 * it * t * t * C2[1] + t * t * t * E[1],
                it * it * it * A[2] + 3 * it * it * t * C[2] + 3 * it * t * t * C2[2] + t * t * t * E[2]]; },
            tangent: (t: number): V3 => { const it = 1 - t; return cfNorm([
                3 * it * it * (C[0] - A[0]) + 6 * it * t * (C2[0] - C[0]) + 3 * t * t * (E[0] - C2[0]),
                3 * it * it * (C[1] - A[1]) + 6 * it * t * (C2[1] - C[1]) + 3 * t * t * (E[1] - C2[1]),
                3 * it * it * (C[2] - A[2]) + 6 * it * t * (C2[2] - C[2]) + 3 * t * t * (E[2] - C2[2])]); },
        };
    }
    return {
        at: (t: number): V3 => { const it = 1 - t; return [
            it * it * A[0] + 2 * it * t * C[0] + t * t * E[0],
            it * it * A[1] + 2 * it * t * C[1] + t * t * E[1],
            it * it * A[2] + 2 * it * t * C[2] + t * t * E[2]]; },
        tangent: (t: number): V3 => { const it = 1 - t; return cfNorm([
            2 * it * (C[0] - A[0]) + 2 * t * (E[0] - C[0]),
            2 * it * (C[1] - A[1]) + 2 * t * (E[1] - C[1]),
            2 * it * (C[2] - A[2]) + 2 * t * (E[2] - C[2])]); },
    };
}

/**
 * A smooth spine THROUGH an explicit POLYLINE — the third path source (after the quadratic/cubic bezier):
 * a runner centreline, either grown step-by-step over a surface or handed in by the user as an authored
 * point list (foliage-quality.md §3.4, phase P3). Catmull-Rom / cardinal interpolation, so the curve
 * passes EXACTLY through every input point (an authored path must follow the points the user placed),
 * with **chord-length parameterisation** so `t` tracks arclength closely — which is what lets leaves be
 * distributed at a real `leafSpacing` in metres by stepping `t`.
 *
 * `tension` 0.5 = Catmull-Rom (the default), 0 = no overshoot at all. End tangents are reflected, so the
 * first/last segments don't flatten. Degenerate inputs (0/1/2 points) fall back to a point / a line.
 */
export function polySpine(points: readonly V3[], tension = 0.5): Spine & { knots: number[]; length: number } {
    // Drop consecutive duplicates — a zero-length segment has no tangent.
    const P: V3[] = [];
    for (const q of points) {
        const last = P[P.length - 1];
        if (!last || Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) > 1e-7) P.push([q[0], q[1], q[2]]);
    }
    if (P.length === 0) P.push([0, 0, 0]);
    if (P.length === 1) {
        const p = P[0];
        return { at: () => [p[0], p[1], p[2]], tangent: () => [0, 1, 0], knots: [0], length: 0 };
    }
    const seg: number[] = [];
    let total = 0;
    for (let i = 0; i + 1 < P.length; i++) { const d = cfLen(cfSub(P[i + 1], P[i])); seg.push(d); total += d; }
    const knots = [0];
    for (let i = 0; i < seg.length; i++) knots.push(knots[i] + seg[i] / total);
    knots[knots.length - 1] = 1;
    const ctrl = (i: number): V3 => {
        if (i < 0) return [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1], 2 * P[0][2] - P[1][2]];
        if (i >= P.length) { const n = P.length; return [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1], 2 * P[n - 1][2] - P[n - 2][2]]; }
        return P[i];
    };
    const locate = (t: number): { i: number; s: number } => {
        const tt = t < 0 ? 0 : t > 1 ? 1 : t;
        let i = 0;
        while (i < seg.length - 1 && tt > knots[i + 1]) i++;
        const span = knots[i + 1] - knots[i];
        return { i, s: span > 1e-9 ? (tt - knots[i]) / span : 0 };
    };
    const tau = tension;
    return {
        knots, length: total,
        at: (t: number): V3 => {
            const { i, s } = locate(t);
            const p0 = ctrl(i - 1), p1 = ctrl(i), p2 = ctrl(i + 1), p3 = ctrl(i + 2);
            const s2 = s * s, s3 = s2 * s;
            const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
            const out: V3 = [0, 0, 0];
            for (let k = 0; k < 3; k++) {
                const m1 = tau * (p2[k] - p0[k]), m2 = tau * (p3[k] - p1[k]);
                out[k] = h00 * p1[k] + h10 * m1 + h01 * p2[k] + h11 * m2;
            }
            return out;
        },
        tangent: (t: number): V3 => {
            const { i, s } = locate(t);
            const p0 = ctrl(i - 1), p1 = ctrl(i), p2 = ctrl(i + 1), p3 = ctrl(i + 2);
            const s2 = s * s;
            const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
            const out: V3 = [0, 0, 0];
            for (let k = 0; k < 3; k++) {
                const m1 = tau * (p2[k] - p0[k]), m2 = tau * (p3[k] - p1[k]);
                out[k] = d00 * p1[k] + d10 * m1 + d01 * p2[k] + d11 * m2;
            }
            return cfLen(out) > 1e-9 ? cfNorm(out) : cfNorm(cfSub(p2, p1));
        },
    };
}

/** One sampled station along a swept curve: the point, its unit tangent, and the transported frame. */
export interface CurveFrame { t: number; p: V3; tan: V3; u: V3; v: V3 }

/**
 * Sample a spine at the given (ascending) params, carrying ONE frame down the curve by the minimal
 * rotation between consecutive tangents — PARALLEL TRANSPORT. `ts` may be non-uniform (the blade
 * inserts an extra station at its leaf/tip colour split).
 */
export function sweepFrames(spine: Spine, ts: readonly number[]): CurveFrame[] {
    const out: CurveFrame[] = [];
    if (!ts.length) return out;
    let prevT = spine.tangent(ts[0]);
    const seed = perpFrame(prevT);
    let u = seed.u, v = seed.v;
    for (let i = 0; i < ts.length; i++) {
        const t = ts[i], T = spine.tangent(t);
        if (i > 0) {
            const axis = cfCross(prevT, T), s = cfLen(axis), c = cfDot(prevT, T);
            if (s > 1e-6) {
                const ax: V3 = [axis[0] / s, axis[1] / s, axis[2] / s];
                u = rotAxis(u, ax, c, s); v = rotAxis(v, ax, c, s);
            }
            prevT = T;
        }
        out.push({ t, p: spine.at(t), tan: T, u, v });
    }
    return out;
}

/** Uniform `segs` subdivisions (segs+1 stations), with `extra` params merged in (deduped, sorted). */
export function sweepParams(segs: number, ...extra: number[]): number[] {
    const n = Math.max(1, Math.round(segs));
    const ts: number[] = [];
    for (let i = 0; i <= n; i++) ts.push(i / n);
    for (const e of extra) {
        if (!(e > 1e-4 && e < 1 - 1e-4)) continue;
        if (ts.some(t => Math.abs(t - e) < 1e-6)) continue;
        ts.push(e);
    }
    ts.sort((a, b) => a - b);
    return ts;
}
