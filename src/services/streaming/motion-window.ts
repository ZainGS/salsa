// The SPEED-AWARE streaming window (performance-plan P19, 2026-10-03). Pure, so it is unit-tested (motion-window.test.ts).
//
// The P10.D window is the (2r+1)² full tiles around the tile under the eye (the player in Play). A full tile is a 2-4 s
// worker build plus seconds of time-sliced reassembly, so at fast fly speeds (about 1 tile/s) every full tile the window
// asked for was cancelled before it landed: the worker time was wasted, each cancel recycled a worker, and the cheap HLOD
// skyline starved behind them. This module turns the focus point's motion into three things:
//   1. a smoothed VELOCITY (tiles/s) of the focus point (FocusMotion.update);
//   2. a PREDICTED focus point (the focus plus velocity × look-ahead, capped at `maxLeadTiles`): the window centres on
//      it, so the tiles ahead are asked for (and built) before the camera / player reaches them, and the trailing tiles
//      leave the target (and are cancelled) earlier;
//   3. a hysteretic FAST state: at or above `fastTiles` the window starts no new full builds (tiles not already full
//      show the stand-in tier: HLOD mid, or the flat / massing tier), until the speed has stayed under `slowTiles` for
//      `settleMs`. Option 'landing' instead keeps ONE full tile, at the predicted landing point;
//   4. a hysteretic CAPPED state between the adaptive keep-up speed (keepUpTiles: the speed at which a new window row
//      still lands before the focus reaches it, from the measured full-tile latency) and `fastTiles`: a Play run. The
//      full window is capped to a CORRIDOR (corridorTiles): the tile under the focus plus the tiles along its path,
//      reaching as far ahead as a build takes to land. Fewer, earlier builds, so the tiles the focus reaches are full.

/** P19 settings (WorldManager.setStreamMotion). */
export interface MotionWindowOptions {
    /** Prediction look-ahead (s): the window centres on where the focus will be this far ahead. */
    lookAheadS: number;
    /** Cap of the prediction lead (tiles). ≤ 1 keeps the tile under the eye inside a 3×3 window. */
    maxLeadTiles: number;
    /** Speed (tiles/s) at or above which the window starts no new full builds. */
    fastTiles: number;
    /** The fast state ends once the speed has stayed under this (tiles/s) for `settleMs`. */
    slowTiles: number;
    settleMs: number;
    /** Velocity smoothing time constant (ms). */
    tauMs: number;
    /** What the window shows while fast: 'hlod' = the stand-in tier for every tile not already full; 'landing' = the
     *  same, plus ONE full tile at the predicted landing point (the focus + velocity × `landingS`); 'off' = full tiles
     *  at every speed (the pre-P19 window, prediction still on). */
    fast: 'hlod' | 'landing' | 'off';
    /** Landing look-ahead (s) for fast 'landing' (≈ a full tile's build latency). */
    landingS: number;
    /** ADAPTIVE threshold: the CAPPED state starts at the speed the full window can still keep up with — a newly
     *  asked-for row of tiles must land (the measured full-tile latency, dispatch → reassembled) before the focus
     *  reaches it (keepUpTiles). A slow machine / a busy main thread (Play) lowers it; it never rises above `fastTiles`.
     *  Off = no capped state (the full window up to `fastTiles`). */
    adaptive: boolean;
    /** The CAPPED window (speed between the keep-up speed and `fastTiles`, e.g. a Play run): at most this many full
     *  tiles — the tile under the focus and the tiles along its path out to where a build dispatched now lands in
     *  time (corridorTiles). The rest of the window shows its stand-in. */
    capTiles: number;
    /** The corridor's reach cap (tiles ahead of the focus). */
    capAheadTiles: number;
}

export const MOTION_DEFAULTS: Readonly<MotionWindowOptions> = {
    lookAheadS: 3, maxLeadTiles: 1, fastTiles: 0.75, slowTiles: 0.4, settleMs: 150, tauMs: 250, fast: 'hlod', landingS: 3, adaptive: true,
    capTiles: 4, capAheadTiles: 4,
};

/** The capped corridor reaches speed × latency × this (+ CORRIDOR_PAD_TILES) ahead: a tile dispatched as it enters the
 *  corridor lands with a quarter of its latency to spare. */
export const CORRIDOR_LATENCY_MARGIN = 1.25;
export const CORRIDOR_PAD_TILES = 0.75;

/** The full-tile latency (s) assumed before any full tile has landed. */
export const DEFAULT_FULL_LATENCY_S = 3;

/** The fastest focus speed (tiles/s) the window keeps up with: a row of tiles is asked for when the predicted focus
 *  crosses into a new tile (WINDOW_MARGIN past its border), and its near edge is then `radius` - 0.12 + `lead` tiles
 *  ahead of the focus; it must land (`latencyS`) before the focus gets there. */
export function keepUpTiles(latencyS: number, leadTiles: number, radius: number): number {
    return Math.max(0.05, Math.max(0, radius | 0) - 0.12 + Math.max(0, leadTiles)) / Math.max(0.5, latencyS);
}

/** One update moving more than this (tiles) is a TELEPORT (a camera jump, a respawn): the estimator restarts. */
export const MOTION_TELEPORT_TILES = 2;
/** A gap longer than this (ms) between updates restarts the estimator (a stalled / hidden page). */
export const MOTION_GAP_MS = 1000;
/** One update faster than this (tiles/s) is a camera JUMP too (a frame-selection cut of a tile or so): no fly or run
 *  moves that fast, and counting it as motion would put the window in its fast state for a second. */
export const MOTION_TELEPORT_SPEED = 25;

/** Clamp a patch onto `cur` (unknown / non-finite fields ignored). */
export function sanitizeMotion(cur: MotionWindowOptions, patch: Partial<MotionWindowOptions> | null | undefined): MotionWindowOptions {
    const o = { ...cur };
    if (!patch) return o;
    const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    o.lookAheadS = num(patch.lookAheadS, 0, 6, o.lookAheadS);
    o.maxLeadTiles = num(patch.maxLeadTiles, 0, 3, o.maxLeadTiles);
    o.fastTiles = num(patch.fastTiles, 0.05, 20, o.fastTiles);
    o.slowTiles = Math.min(o.fastTiles, num(patch.slowTiles, 0, 20, o.slowTiles));
    o.settleMs = num(patch.settleMs, 0, 5000, o.settleMs);
    o.tauMs = num(patch.tauMs, 1, 2000, o.tauMs);
    o.landingS = num(patch.landingS, 0, 10, o.landingS);
    o.capTiles = Math.round(num(patch.capTiles, 1, 9, o.capTiles));
    o.capAheadTiles = num(patch.capAheadTiles, 0, 8, o.capAheadTiles);
    if (patch.fast === 'hlod' || patch.fast === 'landing' || patch.fast === 'off') o.fast = patch.fast;
    if (typeof patch.adaptive === 'boolean') o.adaptive = patch.adaptive;
    return o;
}

/** The focus point's motion: an exponentially smoothed velocity (tiles/s) and the hysteretic fast state. Positions are
 *  city-local world XZ; `span` = one tile (2 × the city radius). Time is in ms (the caller's clock: no wall-clock use
 *  inside, so tests pass explicit times). */
export class FocusMotion {
    vx = 0;
    vz = 0;
    /** 'slow' = the full window; 'capped' = the corridor of full tiles (speed between `capAt` and `fastTiles`);
     *  'fast' = no new full builds (≥ `fastTiles`). Each is entered at its threshold and left after `settleMs` under
     *  its lower band (fast: `slowTiles`; capped: `capAt` × slowTiles / fastTiles). */
    state: MotionState = 'slow';
    /** The adaptive limit (tiles/s, keepUpTiles; Infinity = none): the capped state starts at it. Set by the caller
     *  from its measured latency. */
    keepUp = Infinity;
    private _x = 0;
    private _z = 0;
    private _t = NaN;
    private _below = NaN;   // when the speed last dropped under slowTiles while fast (NaN = not under)
    constructor(public opts: MotionWindowOptions = { ...MOTION_DEFAULTS }) {}

    get speed(): number { return Math.hypot(this.vx, this.vz); }
    /** The speed (tiles/s) the fast state starts at. */
    get fastAt(): number { return this.opts.fastTiles; }
    /** The speed (tiles/s) the capped state starts at: the adaptive keep-up speed, ≤ `fastTiles` (= `fastTiles`, no
     *  capped band, when it keeps up all the way or `adaptive` is off). */
    get capAt(): number { return Math.min(this.opts.fastTiles, this.opts.adaptive ? this.keepUp : Infinity); }

    /** Forget the motion (a regen / a teleport / follow off). */
    reset(): void { this.vx = 0; this.vz = 0; this.state = 'slow'; this._t = NaN; this._below = NaN; }

    /** Feed the focus point at time `t` (ms). Returns true when the fast state changed. */
    update(x: number, z: number, t: number, span: number): boolean {
        const prev = this.state;
        if (!(span > 0) || !isFinite(x) || !isFinite(z) || !isFinite(t)) return false;
        if (isNaN(this._t)) { this._x = x; this._z = z; this._t = t; return false; }
        const dt = t - this._t;
        if (dt <= 0) return false;
        const dx = (x - this._x) / span, dz = (z - this._z) / span;
        this._x = x; this._z = z; this._t = t;
        const step = Math.hypot(dx, dz);
        if (dt > MOTION_GAP_MS || step > MOTION_TELEPORT_TILES || step * 1000 / dt > MOTION_TELEPORT_SPEED) {
            // a jump is not motion: restart the estimate (the state settles on its own rules from here)
            this.vx = 0; this.vz = 0;
        } else {
            const a = 1 - Math.exp(-dt / this.opts.tauMs);
            this.vx += a * (dx * 1000 / dt - this.vx);
            this.vz += a * (dz * 1000 / dt - this.vz);
        }
        const s = this.speed, o = this.opts;
        const fastAt = o.fastTiles, capAt = this.capAt, ratio = o.fastTiles > 0 ? o.slowTiles / o.fastTiles : 0.5;
        const capLeave = Math.min(o.slowTiles, capAt * ratio);
        const lvl = (st: MotionState): number => (st === 'fast' ? 2 : st === 'capped' ? 1 : 0);
        const want = s >= fastAt ? 2 : s >= capAt ? 1 : 0, cur = lvl(this.state);
        if (want >= cur) { if (want > cur) this.state = MOTION_STATES[want]; this._below = NaN; }
        else {
            // under the current state's threshold: held while inside its band, left after settleMs under it
            const leaveAt = cur === 2 ? o.slowTiles : capLeave;
            if (s >= leaveAt) this._below = NaN;
            else if (isNaN(this._below)) this._below = t;
            if (!isNaN(this._below) && t - this._below >= o.settleMs) {
                this.state = cur === 2 && capAt < fastAt && s >= capLeave ? 'capped' : 'slow';
                this._below = NaN;
            }
        }
        return this.state !== prev;
    }

    /** The prediction lead (tiles): velocity × `lookAheadS`, capped at `maxLeadTiles`. */
    lead(): [number, number] {
        const o = this.opts;
        let lx = this.vx * o.lookAheadS, lz = this.vz * o.lookAheadS;
        const l = Math.hypot(lx, lz);
        if (l > o.maxLeadTiles) { const k = o.maxLeadTiles / l; lx *= k; lz *= k; }
        return [lx, lz];
    }

    /** The predicted landing point's lead (tiles): velocity × `landingS` (fast 'landing'), capped at 6 tiles. */
    landingLead(): [number, number] {
        let lx = this.vx * this.opts.landingS, lz = this.vz * this.opts.landingS;
        const l = Math.hypot(lx, lz);
        if (l > 6) { lx *= 6 / l; lz *= 6 / l; }
        return [lx, lz];
    }

    /** True while the estimate can still change the window (fast, or a lead of more than 1/16 tile): callers keep
     *  their frame loop alive until it has settled. A walk's tiny lead does not keep frames coming. */
    get settling(): boolean { return this.state !== 'slow' || Math.hypot(...this.lead()) > 1 / 16; }
}

export type MotionState = 'slow' | 'capped' | 'fast';
const MOTION_STATES: readonly MotionState[] = ['slow', 'capped', 'fast'];

/** The CAPPED window's full tiles: `own` (the tile under the focus) first, then the tiles the focus's path crosses,
 *  in order, out to speed × `latencyS` × CORRIDOR_LATENCY_MARGIN + CORRIDOR_PAD_TILES ahead (≤ `maxAhead`) — a tile
 *  entering the corridor is that far ahead, so its build lands before the focus gets there — at most `cap` tiles.
 *  `fu`, `fv` = the focus (tile units), `vx`, `vz` = its velocity (tiles/s). Still = just `own`. */
export function corridorTiles(own: readonly [number, number], fu: number, fv: number, vx: number, vz: number, latencyS: number, cap: number, maxAhead: number): Array<[number, number]> {
    const out: Array<[number, number]> = [[own[0], own[1]]];
    const n = Math.max(1, cap | 0), s = Math.hypot(vx, vz);
    if (n <= 1 || !(s > 0) || !isFinite(fu) || !isFinite(fv)) return out;
    const reach = Math.min(Math.max(0, maxAhead), s * Math.max(0, latencyS) * CORRIDOR_LATENCY_MARGIN + CORRIDOR_PAD_TILES);
    const ux = vx / s, uz = vz / s;
    for (let d = 0; d <= reach + 1e-9 && out.length < n; d += 0.125) {
        const tx = Math.round(fu + ux * d), tz = Math.round(fv + uz * d);
        if (!out.some(t => t[0] === tx && t[1] === tz)) out.push([tx, tz]);
    }
    return out;
}

/** The window tiles of a predicted window: the (2r+1)² square around `centre` (the predicted focus tile) plus the tile
 *  under the focus itself (`own`, when the lead moved the centre off it — so a 1×1 window never drops the tile you are
 *  in), ordered by distance to the PREDICTED point (`pu`, `pv`: tile units), nearest first — the tiles ahead build first. */
export function predictedWindowTiles(centre: readonly [number, number], own: readonly [number, number], radius: number, pu: number, pv: number): Array<[number, number]> {
    const r = Math.max(0, Math.min(3, radius | 0));
    const out: Array<[number, number, number]> = [];
    const d2 = (tx: number, tz: number): number => (tx - pu) * (tx - pu) + (tz - pv) * (tz - pv);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const tx = centre[0] + dx, tz = centre[1] + dz; out.push([tx, tz, d2(tx, tz)]); }
    if (Math.max(Math.abs(own[0] - centre[0]), Math.abs(own[1] - centre[1])) > r) out.push([own[0], own[1], d2(own[0], own[1])]);
    out.sort((a, b) => a[2] - b[2]);
    return out.map(t => [t[0], t[1]]);
}

/** What one window tile builds while the window is fast: 'full' (keep / build the full tile) or 'stand' (the stand-in
 *  tier). A tile that is ALREADY full stays full (no churn, nothing to build); with fast 'landing' the landing tile
 *  builds full too. Slow → always 'full'. */
export function fastWindowTier(fast: boolean, mode: MotionWindowOptions['fast'], alreadyFull: boolean, isLanding: boolean): 'full' | 'stand' {
    if (!fast || mode === 'off' || alreadyFull) return 'full';
    return mode === 'landing' && isLanding ? 'full' : 'stand';
}
