/**
 * RESOLUTION SCALING (docs/ui/performance.md §Resolution scaling). The 3D scene can render at a fraction of the canvas
 * size and be upscaled (a sharpened bicubic filter); the 2D layers, gizmos, selection UI and text stay at full size.
 *
 *  - `off`: native resolution (the default; nothing changes).
 *  - `fixed`: always `scale`.
 *  - `auto`: a controller keeps the GPU frame time under `targetMs` by moving the scale between `minScale` and
 *    `maxScale`.
 *
 * The controller is pure (time and samples come in as arguments), so it is unit-tested without a GPU.
 *
 * How auto decides:
 *  - It judges the MEDIAN of the frames since the last change (robust to the one-off spikes a resize or a pipeline
 *    compile causes) and keeps an EMA for display. Samples arrive only while frames render; after an idle gap both
 *    restart.
 *  - It changes the scale at most every `minIntervalMs`, and only after `minSamples` frames at the current scale, so
 *    each step is judged on frames that actually used it.
 *  - Going DOWN: as soon as the average is over the target. The new scale assumes the cost follows the pixel count
 *    (scale squared) and aims for 90 % of the target. Steps are capped and snapped to a 0.05 grid. Each change
 *    re-allocates the size-dependent pass textures, so a coarse grid matters.
 *  - Going UP: one 0.05 step, only after the average has had headroom for `upHoldMs`, and only if the predicted cost
 *    at the bigger scale stays under 90 % of the target. Together with the 90 % goal going down, this leaves a dead
 *    band between the two thresholds, so the scale settles instead of oscillating.
 */

export type ResolutionScaleMode = 'off' | 'fixed' | 'auto';

/**
 * CAMERA-MOTION RESOLUTION (engine-roadmap step 2 item C; docs/ui/performance.md §Resolution scaling): while the camera
 * moves in a tiled / streamed world, the world drops the 3D render scale to `motionScale` (0.78 by default) and
 * restores it 400 ms after the camera stops — fill rate is the dominant zoomed-out GPU cost and the drop is invisible
 * mid-pan. In Play the camera follows the player and never stops, so the drop used to stay on for the whole session.
 *   - 'auto' (default): editor camera moves (orbit / pan / zoom) drop as before; in Play only while the measured GPU
 *     frame is over the budget (`targetMs`; GPU timestamps only — the CPU estimate can't tell a CPU-bound frame).
 *   - 'always': every camera move, Play included (the old behaviour).
 *   - 'editor': editor camera moves only, never in Play.
 *   - 'off': never.
 * Independent of `mode`: the lower of the two scales applies, and setting one never changes the other.
 */
export type MotionResolutionMode = 'auto' | 'always' | 'editor' | 'off';

export interface ResolutionScaleSettings {
  mode: ResolutionScaleMode;
  /** The fixed-mode scale (0.25..1). */
  scale: number;
  /** Auto mode: the GPU frame-time budget in milliseconds (16.0 = 60 fps). */
  targetMs: number;
  /** Auto mode: the lowest scale it may choose (0.25..1). */
  minScale: number;
  /** Auto mode: the highest scale it may choose (minScale..1). */
  maxScale: number;
  /** Camera-motion drop: when it applies (see MotionResolutionMode). */
  motion: MotionResolutionMode;
  /** Camera-motion drop: the scale while the camera moves (0.25..1). */
  motionScale: number;
}

/** What getResolutionScale3D reports. */
export interface ResolutionScaleState extends ResolutionScaleSettings {
  /** The scale the 3D scene renders at right now (1 = native). */
  current: number;
  /** Smoothed GPU frame time (ms) while timing runs (auto mode or a stats lease), else null. */
  gpuMs: number | null;
  /** Where gpuMs comes from: 'timestamp' (exact GPU timestamps) or 'estimate' (CPU start to GPU done). */
  timing: 'timestamp' | 'estimate';
}

export const DEFAULT_RESOLUTION_SCALE: Readonly<ResolutionScaleSettings> = Object.freeze({
  mode: 'off', scale: 0.75, targetMs: 16.0, minScale: 0.6, maxScale: 1, motion: 'auto', motionScale: 0.78,
});

/**
 * Camera-motion drop decision (pure). `engagedScale` < 1 = the drop is on now (judging whether to keep it: in Play
 * under 'auto' it stays while the frame predicted at native size, gpuMs / scale², is over 85 % of the budget — the
 * hysteresis that stops it flapping on and off at the threshold).
 */
export function motionDropAllowed(s: ResolutionScaleSettings, playing: boolean, gpuMs: number | null,
    timing: 'timestamp' | 'estimate', engagedScale = 1): boolean {
  switch (s.motion) {
    case 'off': return false;
    case 'always': return true;
    case 'editor': return !playing;
    default: {
      if (!playing) return true;
      if (timing !== 'timestamp' || gpuMs == null || !(gpuMs > 0)) return false;
      if (engagedScale < 1) return gpuMs / (engagedScale * engagedScale) > s.targetMs * 0.85;
      return gpuMs > s.targetMs;
    }
  }
}

/** Snap grid of auto-mode scales. */
export const RES_SCALE_STEP = 0.05;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);

/** Merge a patch onto `base`, clamping every field to its legal range. Unknown / bad values keep the base value. */
export function sanitizeResolutionScale(patch: Partial<ResolutionScaleSettings> | null | undefined,
    base: ResolutionScaleSettings = DEFAULT_RESOLUTION_SCALE): ResolutionScaleSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<ResolutionScaleSettings>;
  const mode: ResolutionScaleMode = p.mode === 'off' || p.mode === 'fixed' || p.mode === 'auto' ? p.mode : base.mode;
  const scale = clamp(num(p.scale, base.scale), 0.25, 1);
  const targetMs = clamp(num(p.targetMs, base.targetMs), 4, 100);
  const minScale = clamp(num(p.minScale, base.minScale), 0.25, 1);
  const maxScale = clamp(num(p.maxScale, base.maxScale), minScale, 1);
  const motion: MotionResolutionMode = p.motion === 'auto' || p.motion === 'always' || p.motion === 'editor' || p.motion === 'off' ? p.motion : (base.motion ?? 'auto');
  const motionScale = clamp(num(p.motionScale, base.motionScale ?? 0.78), 0.25, 1);
  return { mode, scale, targetMs, minScale, maxScale, motion, motionScale };
}

export class ResolutionScaler {
  /** EMA weight of a new sample. */
  static ALPHA = 0.2;
  /** Minimum time between two scale changes (ms). */
  static minIntervalMs = 500;
  /** Frames needed at the current scale before it may change. */
  static minSamples = 8;
  /** How long the average must show headroom before a step up (ms). */
  static upHoldMs = 1000;
  /** A gap with no samples longer than this restarts the average (ms). */
  static idleResetMs = 500;
  /** Largest single step down. */
  static maxStepDown = 0.2;

  private _s: ResolutionScaleSettings = { ...DEFAULT_RESOLUTION_SCALE };
  private _current = 1;
  private _ema = 0;
  private _n = 0;              // samples since the last change / restart
  private _lastSampleAt = -Infinity;
  private _lastChangeAt = -Infinity;
  private _headroomSince = -1;
  private readonly _win: number[] = [];   // samples since the last change (newest last, capped)
  /** Median window size. */
  static window = 15;

  get settings(): ResolutionScaleSettings { return { ...this._s }; }
  /** Smoothed GPU ms (0 before any sample). */
  get averageMs(): number { return this._ema; }

  /** The scale the scene should render at (1 when off). */
  scale(): number {
    if (this._s.mode === 'off') return 1;
    if (this._s.mode === 'fixed') return this._s.scale;
    return this._current;
  }

  /** Apply a settings patch. Switching into auto starts from the current auto scale clamped into the new range. */
  set(patch: Partial<ResolutionScaleSettings>): ResolutionScaleSettings {
    const prevMode = this._s.mode;
    this._s = sanitizeResolutionScale(patch, this._s);
    // A patch of camera-motion fields only leaves the auto controller (its scale and averages) untouched.
    const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
    if (keys.length && keys.every(k => k === 'motion' || k === 'motionScale')) return this.settings;
    if (this._s.mode === 'auto') {
      if (prevMode !== 'auto') this._current = this._s.maxScale;
      this._current = clamp(this._current, this._s.minScale, this._s.maxScale);
    } else {
      this._current = this.scale();
    }
    this._n = 0; this._headroomSince = -1; this._lastChangeAt = -Infinity; this._win.length = 0;
    return this.settings;
  }

  /** Feed one frame's GPU time. Returns true when the auto scale changed (the caller re-renders). */
  sample(gpuMs: number, nowMs: number): boolean {
    if (!(gpuMs > 0) || !isFinite(gpuMs)) return false;
    if (nowMs - this._lastSampleAt > ResolutionScaler.idleResetMs || this._n === 0 && this._ema === 0) {
      this._ema = gpuMs; this._n = 0; this._headroomSince = -1; this._win.length = 0;
    } else {
      this._ema += (gpuMs - this._ema) * ResolutionScaler.ALPHA;
    }
    this._lastSampleAt = nowMs;
    this._n++;
    this._win.push(gpuMs);
    if (this._win.length > ResolutionScaler.window) this._win.shift();
    if (this._s.mode !== 'auto') return false;
    if (this._n < ResolutionScaler.minSamples || nowMs - this._lastChangeAt < ResolutionScaler.minIntervalMs) return false;
    const { targetMs, minScale, maxScale } = this._s;
    const s = this._current;
    const sorted = [...this._win].sort((a, b) => a - b);
    const ema = sorted[sorted.length >> 1];   // the median of the frames at this scale
    let next = s;
    if (ema > targetMs) {
      this._headroomSince = -1;
      const ideal = s * Math.sqrt((targetMs * 0.9) / ema);
      const stepped = Math.max(ideal, s - ResolutionScaler.maxStepDown);
      next = Math.floor(stepped / RES_SCALE_STEP + 1e-6) * RES_SCALE_STEP;
      if (next >= s) next = s - RES_SCALE_STEP;
      next = clamp(next, minScale, maxScale);
    } else {
      const up = clamp(Math.round((s + RES_SCALE_STEP) / RES_SCALE_STEP) * RES_SCALE_STEP, minScale, maxScale);
      const predicted = ema * (up / s) * (up / s);
      if (up > s && predicted < targetMs * 0.9) {
        if (this._headroomSince < 0) this._headroomSince = nowMs;
        if (nowMs - this._headroomSince >= ResolutionScaler.upHoldMs) next = up;
      } else this._headroomSince = -1;
    }
    if (Math.abs(next - s) < 1e-6) return false;
    // The next judgement uses only frames at the new scale (minSamples of them).
    this._ema *= (next / s) * (next / s);
    this._current = +next.toFixed(4);
    this._n = 0; this._lastChangeAt = nowMs; this._headroomSince = -1; this._win.length = 0;
    return true;
  }
}
