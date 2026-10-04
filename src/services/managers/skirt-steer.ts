/**
 * Skirt STEERING — the pose-driven half of the skirt/dress leg-follow (polish-round-3 R6.3; see clothing-generator
 * applySkirtLegWeights for the static half).
 *
 * Why it exists: a skirt skinned to the thighs by fixed weights follows each leg, but the CENTRE lines (front and back)
 * sit between the legs and must blend both thighs ~50/50. In a stride the two thighs rotate in opposite directions and
 * a 50/50 blend stays put — so the forward thigh's inner half pokes through the centre front (and the trailing thigh
 * through the centre back). No fixed weight can fix that: the right answer depends on WHICH leg is forward. Physically,
 * the front panel drapes over the forward thigh and the back panel over the trailing one.
 *
 * So each frame the front/back panels' left/right split is STEERED by one scalar: the difference in forward pitch of
 * the two thighs (relative to the pelvis, read from the skeleton's skin matrices). Pure CPU on a few hundred skirt verts,
 * no new joints, no shader change, nothing persisted (the steer data is rebuilt with the garment). At a symmetric pose
 * (rest, idle, sit, squat, side splits) the signal is 0 and the weights are exactly the static ones.
 */

/** Per-vertex data for the skirt verts that follow the legs (f > 0). Built at garment generation. */
export interface SkirtSteer {
    /** Garment vertex index per entry. */
    vert: Uint32Array;
    /** Leg-follow factor (0 = keep the base weights … 1 = fully leg-driven). */
    f: Float32Array;
    /** Lower-leg (knee) share of the leg part — only where f == 1 (so ≤ 4 influences). */
    kn: Float32Array;
    /** Static left-thigh share of the leg part (1 = left). */
    wl: Float32Array;
    /** Steer gain: +1 on the front centre … 0 at the sides … −1 on the back centre. */
    gain: Float32Array;
    /** The base (non-leg) weights faded by (1 − f): two slots, normalized to sum 1. */
    b0j: Uint8Array; b0w: Float32Array; b1j: Uint8Array; b1w: Float32Array;
    /** Joint indices: hips (signal reference), thighs, lower legs. */
    hips: number; uL: number; uR: number; lL: number; lR: number;
}

/** Pitch difference (radians) at which the steer saturates. */
export const STEER_SATURATE = (25 * Math.PI) / 180;

/** Forward pitch (radians, + = forward/+Z) of a thigh relative to the pelvis, from bind-relative skin matrices:
 *  R = rot(S_hips)^-1 · rot(S_thigh) applied to the bind-space bone direction (0, −1, 0). */
function thighPitch(skin: ArrayLike<number>, hips: number, thigh: number): number {
    const h = hips * 16, t = thigh * 16;
    // d = R_t · (0,−1,0) = −(column 1 of S_thigh's 3×3). Then into the hips frame: R_h^T · d (R_h ≈ orthonormal; any
    // uniform scale cancels in atan2).
    const dx = -skin[t + 4], dy = -skin[t + 5], dz = -skin[t + 6];
    const ly = skin[h + 4] * dx + skin[h + 5] * dy + skin[h + 6] * dz;    // · hips Y axis
    const lz = skin[h + 8] * dx + skin[h + 9] * dy + skin[h + 10] * dz;   // · hips Z axis
    return Math.atan2(lz, -ly);
}

const ease = (d: number): number => {
    if (!Number.isFinite(d)) return 0;
    const t = Math.min(1, Math.abs(d) / STEER_SATURATE);
    return Math.sign(d) * t * t * (3 - 2 * t);
};

/** The steer signal in [−1, 1]: + when the LEFT thigh is further forward than the right (pitch relative to the
 *  pelvis). Smoothstepped so it eases through the crossing (thighs aligned → 0) and saturates by STEER_SATURATE.
 *  (Tried: a second signal from the lower legs for the hem's knee share — a running leg swings forward with its calf
 *  folded back. Steering the knee part by it separately tore the hem between the legs; blending it into the vert's
 *  one signal by its knee share fixed the long-dress run residual but clipped/tore more in a high-knee pose. Not kept.) */
export function skirtSteerSignal(skin: ArrayLike<number>, st: Pick<SkirtSteer, 'hips' | 'uL' | 'uR'>): number {
    if ((Math.max(st.hips, st.uL, st.uR) + 1) * 16 > skin.length) return 0;
    return ease(thighPitch(skin, st.hips, st.uL) - thighPitch(skin, st.hips, st.uR));
}

/**
 * Skirt FOLLOW-THROUGH (visual-polish item 13). The steer signal follows the thighs instantly, so in a run the panels
 * moved as rigid boards locked to the legs. Cloth lags: this tracks the signal with a slightly UNDER-damped
 * spring (≈ 4 Hz, ζ 0.55), so the panels swing a beat (~2 frames) behind the legs and overshoot a little at each reversal before
 * it settles. Applied by the engine while Play runs (an editor pose snaps exactly as before). Output clamped to [−1, 1]
 * (the steer's range). Frame-rate independent (fixed 1/240 s substeps); a long gap (> 0.25 s) or reset() snaps.
 * Tried 2.6 Hz / ζ 0.45 (a visible lag): the forward thigh then pushed through the still-lagging front panel in the run
 * (gait-preview poke-through up, browser frames showed the knee). A real hem swing needs skirt SPRING CHAINS (joints the
 * hem can lag on) — not built; skirts have no spring bones today.
 */
export class SkirtFollow {
    private _x = 0;
    private _v = 0;
    private _init = false;
    constructor(public freq = 4, public damping = 0.55) {}
    reset(): void { this._init = false; this._x = 0; this._v = 0; }
    get value(): number { return Math.max(-1, Math.min(1, this._x)); }
    /** Settled on `target` (nothing left to animate). */
    settled(target: number): boolean { return this._init && Math.abs(this._x - target) < 2e-3 && Math.abs(this._v) < 2e-2; }
    update(target: number, dt: number): number {
        if (!Number.isFinite(target)) target = 0;
        if (!this._init || !(dt > 0) || dt > 0.25) { this._x = target; this._v = 0; this._init = true; return this.value; }
        const w = 2 * Math.PI * this.freq, z = this.damping, H = 1 / 240;
        for (let left = dt; left > 1e-9; left -= H) {
            const h = Math.min(H, left);
            this._v += (w * w * (target - this._x) - 2 * z * w * this._v) * h;
            this._x += this._v * h;
        }
        // Keep the state inside a little past the range so an overshoot reads, but never runs away.
        if (this._x > 1.25) { this._x = 1.25; this._v = Math.min(0, this._v); } else if (this._x < -1.25) { this._x = -1.25; this._v = Math.max(0, this._v); }
        return this.value;
    }
}

/** Write the steered weights for the signals into the garment's 4-slot joint arrays (s = 0 → the static weights). */
export function steerSkirtWeights(st: SkirtSteer, s: number, ji: Uint8Array, jw: Float32Array): void {
    const steer = (w0: number, sg: number) => (sg > 0 ? w0 + (1 - w0) * sg : w0 + w0 * sg);
    for (let e = 0; e < st.vert.length; e++) {
        const o = st.vert[e] * 4, f = st.f[e], kn = st.kn[e], g = st.gain[e], w0 = st.wl[e];
        const wl = steer(w0, s * g);
        if (kn > 0) {
            ji[o] = st.uL; jw[o] = wl * (1 - kn);
            ji[o + 1] = st.uR; jw[o + 1] = (1 - wl) * (1 - kn);
            ji[o + 2] = st.lL; jw[o + 2] = wl * kn;
            ji[o + 3] = st.lR; jw[o + 3] = (1 - wl) * kn;
        } else {
            ji[o] = st.b0j[e]; jw[o] = (1 - f) * st.b0w[e];
            ji[o + 1] = st.b1j[e]; jw[o + 1] = (1 - f) * st.b1w[e];
            ji[o + 2] = st.uL; jw[o + 2] = f * wl;
            ji[o + 3] = st.uR; jw[o + 3] = f * (1 - wl);
        }
    }
}
