/**
 * skirt-swing.ts — SKIRT HEM SWING (clothing fit round 2, 2026-10-04): secondary motion of a skirt's hem, driven by the
 * pelvis's velocity, on top of the leg-follow steer (skirt-steer.ts).
 *
 * A spring-damped LAG vector lives in the pelvis's horizontal plane: it chases "minus the pelvis velocity" (air drag:
 * a running skirt trails behind; a stop swings it forward past centre and back), with a spring so it overshoots and
 * settles like cloth. A second spring, FLARE, chases the vertical speed and the turn rate (a jump or a landing opens the
 * hem like an umbrella; a quick turn fans it). Both are applied as a bind-space vertex offset, scaled by height² down
 * the skirt (0 at the waist, 1 at the hem) and by the skirt's length:
 *     offset = r̂ · (max(0, r̂·lag) + flare) · h²   (+ a small lift: a swinging hem rises on its arc)
 * r̂ = the vertex's outward horizontal direction from the pelvis axis. The offset is OUTWARD ONLY — the trailing panel
 * flares away from the legs, the leading panel is left exactly where the steer put it — so the swing can never push
 * cloth into a leg (skirt-swing.test / skirt-leg-follow keep the long dress inside its 25 mm gate).
 * Bounded: |lag| ≤ MAX_LAG and flare ≤ MAX_FLARE (× the skirt length factor), whatever the input.
 */

/** Per-vertex data for the skirt verts below the waist. Built from the garment's REST vertices. */
export interface HemSwingData {
    vert: Uint32Array;
    /** Outward horizontal unit direction (x, z) per entry. */
    dir: Float32Array;
    /** Height weight h² (0 waist … 1 hem). */
    h2: Float32Array;
    /** The garment's rest vertices (12 floats per vertex) — the swing writes rest + offset into the live array. */
    rest: Float32Array;
    /** Hem amplitude scale (m): grows with the skirt's length. */
    amp: number;
    /** Index of the hips joint (velocity source). */
    hips: number;
}

export const MAX_LAG = 1, MAX_FLARE = 0.6;
/** Amplitude per metre of skirt length (waist → hem), and its cap (m). */
const AMP_PER_M = 0.11, AMP_MAX = 0.085;
/** Lift as a fraction of the outward offset. */
const LIFT = 0.35;

/** Build the swing data. `waist` = [x, y, z] of the pelvis axis at the waistband; `hemY` = the hem's height. */
export function buildHemSwing(verts: Float32Array, waist: readonly number[], hemY: number, hips: number): HemSwingData | null {
    const n = (verts.length / 12) | 0, span = waist[1] - hemY;
    if (!(span > 0.02)) return null;
    const vs: number[] = [], ds: number[] = [], hs: number[] = [];
    for (let i = 0; i < n; i++) {
        const x = verts[i * 12] - waist[0], y = verts[i * 12 + 1], z = verts[i * 12 + 2] - waist[2];
        const t = (waist[1] - y) / span;
        if (t <= 0.02) continue;
        const r = Math.hypot(x, z); if (r < 1e-5) continue;
        const h = Math.min(1, t);
        vs.push(i); ds.push(x / r, z / r); hs.push(h * h);
    }
    if (!vs.length) return null;
    return { vert: new Uint32Array(vs), dir: new Float32Array(ds), h2: new Float32Array(hs), rest: new Float32Array(verts),
        amp: Math.min(AMP_MAX, AMP_PER_M * span), hips };
}

/** The spring state of one skirt. */
export class HemSwing {
    lx = 0; lz = 0; vx = 0; vz = 0; flare = 0; vf = 0;
    private _px = 0; private _py = 0; private _pz = 0; private _yaw = 0; private _init = false;
    constructor(public freq = 1.9, public damping = 0.32, public gain = 1) {}
    reset(): void { this.lx = this.lz = this.vx = this.vz = this.flare = this.vf = 0; this._init = false; }
    /** Settled at rest (nothing left to draw). */
    get settled(): boolean { return Math.abs(this.lx) + Math.abs(this.lz) + this.flare < 2e-3 && Math.abs(this.vx) + Math.abs(this.vz) + Math.abs(this.vf) < 2e-2; }
    /**
     * Advance by dt. (px, py, pz) = the pelvis's WORLD position; (xx, xz) / (zx, zz) = the horizontal world directions of the
     * pelvis's local +X and +Z axes (hipsSwingFrame reads all of it from the hips skin matrix). Velocity → lag in the pelvis
     * frame (bind space: +X left, +Z front).
     */
    update(px: number, py: number, pz: number, xx: number, xz: number, zx: number, zz: number, dt: number): void {
        const yaw = Math.atan2(zx, zz);
        if (!this._init || !(dt > 0) || dt > 0.25) { this._px = px; this._py = py; this._pz = pz; this._yaw = yaw; this._init = true; return; }
        const vwx = (px - this._px) / dt, vwy = (py - this._py) / dt, vwz = (pz - this._pz) / dt;
        let dyaw = yaw - this._yaw; if (dyaw > Math.PI) dyaw -= 2 * Math.PI; else if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        const turn = dyaw / dt;
        this._px = px; this._py = py; this._pz = pz; this._yaw = yaw;
        // World velocity into the pelvis frame (horizontal axes only — the hem hangs under gravity).
        const lxn = Math.hypot(xx, xz) || 1, lzn = Math.hypot(zx, zz) || 1;
        const vlx = (vwx * xx + vwz * xz) / lxn, vlz = (vwx * zx + vwz * zz) / lzn;
        // Targets: trail opposite the velocity (saturating ~ at a sprint), flare with vertical speed and turn rate.
        const sat = (v: number, ref: number) => Math.tanh(v / ref);
        const tx = -sat(vlx, 4) * MAX_LAG * this.gain, tz = -sat(vlz, 4) * MAX_LAG * this.gain;
        const tf = Math.min(MAX_FLARE, (Math.abs(sat(vwy, 3)) * 0.8 + Math.abs(sat(turn, 6)) * 0.5) * MAX_FLARE) * this.gain;
        const w = 2 * Math.PI * this.freq, z = this.damping, H = 1 / 240;
        for (let left = dt; left > 1e-9; left -= H) {
            const h = Math.min(H, left);
            this.vx += (w * w * (tx - this.lx) - 2 * z * w * this.vx) * h; this.lx += this.vx * h;
            this.vz += (w * w * (tz - this.lz) - 2 * z * w * this.vz) * h; this.lz += this.vz * h;
            this.vf += (w * w * (tf - this.flare) - 2 * z * w * this.vf) * h; this.flare += this.vf * h;
        }
        // Bounded, whatever the input (a teleport is caught by the dt guard; this caps the overshoot).
        const l = Math.hypot(this.lx, this.lz);
        if (l > MAX_LAG * 1.2) { this.lx *= (MAX_LAG * 1.2) / l; this.lz *= (MAX_LAG * 1.2) / l; }
        this.flare = Math.max(0, Math.min(MAX_FLARE * 1.2, this.flare));
    }
}

/**
 * Write rest + swing offset for the swing verts into `out` (the mesh's live 12-float vertex array). `lx`, `lz` = lag in
 * the pelvis frame (bind space: +X left, +Z front), `flare` ≥ 0. Returns the largest offset written (m).
 */
export function applyHemSwing(d: HemSwingData, lx: number, lz: number, flare: number, out: Float32Array): number {
    let worst = 0;
    for (let e = 0; e < d.vert.length; e++) {
        const v = d.vert[e] * 12, rx = d.dir[e * 2], rz = d.dir[e * 2 + 1];
        const k = d.amp * d.h2[e] * (Math.max(0, rx * lx + rz * lz) + Math.max(0, flare));
        out[v] = d.rest[v] + rx * k;
        out[v + 1] = d.rest[v + 1] + LIFT * k;
        out[v + 2] = d.rest[v + 2] + rz * k;
        if (k > worst) worst = k;
    }
    return worst;
}

/** The pelvis's world position + horizontal axes from the hips SKIN matrix (16 floats at o, column-major) and the hips'
 *  bind position: world = S · bind. */
export function hipsSwingFrame(skin: ArrayLike<number>, o: number, bind: readonly number[]): [number, number, number, number, number, number, number] {
    const bx = bind[0], by = bind[1], bz = bind[2];
    return [skin[o] * bx + skin[o + 4] * by + skin[o + 8] * bz + skin[o + 12], skin[o + 1] * bx + skin[o + 5] * by + skin[o + 9] * bz + skin[o + 13],
        skin[o + 2] * bx + skin[o + 6] * by + skin[o + 10] * bz + skin[o + 14], skin[o], skin[o + 2], skin[o + 8], skin[o + 10]];
}

/** Restore the rest positions of the swing verts. */
export function resetHemSwing(d: HemSwingData, out: Float32Array): void {
    for (let e = 0; e < d.vert.length; e++) { const v = d.vert[e] * 12; out[v] = d.rest[v]; out[v + 1] = d.rest[v + 1]; out[v + 2] = d.rest[v + 2]; }
}
