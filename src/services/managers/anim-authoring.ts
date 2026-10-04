/**
 * anim-authoring.ts — author the default clips with basic animation principles instead of linear key-to-key motion
 * (pose & animation audit 2026-09-28, round 2: "the animations are kinda stiff").
 *
 * The clip player interpolates keyframes LINEARLY (constant speed, dead stops) — fine for data, robotic for motion. So
 * the default clips are written as a few KEY POSES with an easing per move, then BAKED to dense keyframes (every
 * `step` frames) whose linear playback reproduces the curve. Baking (rather than adding easing to the player) keeps
 * user-authored clips playing exactly as before and keeps exports plain linear keyframes.
 *
 * Principles available:
 *   • slow-in / slow-out ('inOut'), snappy starts ('out'), wind-ups ('in');
 *   • OVERSHOOT + settle ('outBack') — a move passes its target a little and settles, the single biggest "alive" cue;
 *   • FOLLOW-THROUGH / overlap ({@link lag}) — children (forearm, hand, head) trail their parent by a few frames.
 */

export type Q = [number, number, number, number];
export type Ease = 'linear' | 'inOut' | 'in' | 'out' | 'outBack' | 'hold';
/** A key pose at frame `f`; `ease` shapes the move FROM the previous key TO this one. */
export interface MoveKey { f: number; q: Q; ease?: Ease }

const easeFn: Record<Ease, (t: number) => number> = {
    linear: (t) => t,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    in: (t) => t * t * t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    // ~8% overshoot, then settle (easeOutBack, c1 = 1.2)
    outBack: (t) => { const c1 = 1.2, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    hold: () => 0,
};

/** Quaternion slerp that EXTRAPOLATES for t outside 0..1 (so an overshoot passes the target along the same arc). */
function slerpX(a: Q, b: Q, t: number): Q {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (d > 0.9995) {
        const o: Q = [a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t];
        const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1; return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
    }
    const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    const o: Q = [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
    const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
}

/** Evaluate eased key poses at frame `f`. */
export function evalMove(keys: MoveKey[], f: number): Q {
    if (f <= keys[0].f) return keys[0].q;
    for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (f <= b.f) {
            const t = b.f > a.f ? (f - a.f) / (b.f - a.f) : 1;
            return slerpX(a.q, b.q, easeFn[b.ease ?? 'inOut'](t));
        }
    }
    return keys[keys.length - 1].q;
}

/** Bake eased key poses to dense linear keyframes (every `step` frames + every authored key frame). */
export function bake(keys: MoveKey[], end: number, step = 2): { f: number; q: Q }[] {
    const frames = new Set<number>([0, end]);
    for (let f = 0; f <= end; f += step) frames.add(f);
    for (const k of keys) if (k.f >= 0 && k.f <= end) frames.add(k.f);
    return [...frames].sort((a, b) => a - b).map((f) => ({ f, q: evalMove(keys, f) }));
}

/** FOLLOW-THROUGH: the same key poses, `frames` later (a child trailing its parent). Interior keys only — the first
 *  (rest) and last (rest) keys stay put so the clip still starts and ends where it should. */
export function lag(keys: MoveKey[], frames: number): MoveKey[] {
    const last = keys[keys.length - 1].f;
    return keys.map((k, i) => (i === 0 || i === keys.length - 1 ? k : { ...k, f: Math.min(last - 1, k.f + frames) }));
}

/** Rotation composition a*b (b first) — for authoring deltas on top of a base pose. */
export const qmulQ = (a: Q, b: Q): Q => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
