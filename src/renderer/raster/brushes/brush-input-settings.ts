/**
 * Per-machine raster brush INPUT settings (docs/specs/mobile-parity.md §3, BRUSH-4 follow-ups; docs/ui/touch-controls.md):
 *
 *  • Touch smoothing cap: a FINGER stroke (`pointerType === 'touch'`) caps the brush's stabilizer at a light level,
 *    LIGHT_TOUCH_LAG_MS of effective lag. Stylus ('pen') and mouse always use the brush's own setting. The cap
 *    only lowers: a brush already lighter than it keeps its value.
 *      'light'  (default) → cap at LIGHT_TOUCH_LAG_MS
 *      'off'               → no smoothing at all for a finger
 *      'normal'            → no cap (the brush value)
 *  • Stroke prediction (getPredictedEvents → a provisional tail drawn for one frame, never committed): on by
 *    default; it only ever applies to touch and pen strokes.
 *
 * Both are viewport preferences (localStorage), never document data.
 */

import type { BrushStabilization } from './brush-preset';
import { REF_FRAME_MS } from './brush-stabilizer';

export type TouchSmoothing = 'off' | 'light' | 'normal';

/**
 * The 'light' touch cap: ONE 60 Hz frame (≈16.7 ms) of mean lag at constant finger speed. That is exactly the
 * moving-average stabilizer at level 2 (the lightest level a default preset ships), about 43 % of Hard Pen's
 * level 4 (≈39 ms), and well under a frame of display latency — enough averaging (2–3 touch samples) to calm
 * finger-contact jitter without the line visibly trailing the fingertip.
 */
export const LIGHT_TOUCH_LAG_MS = REF_FRAME_MS;

const KEY_SMOOTHING = 'salsa.brush.touchSmoothing';
const KEY_PREDICTION = 'salsa.brush.strokePrediction';

let _smoothing: TouchSmoothing = 'light';
// OFF by default (2026-10-07): on a real GPU the provisional tail's restore wiped the committed stroke (only the tip
// showed). Opt-in via setStrokePrediction(true) until that is fixed and verified on a device.
let _prediction = false;
let _loaded = false;

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function ensureLoaded(): void {
  if (_loaded) return;
  _loaded = true;
  const ls = storage();
  if (!ls) return;
  try {
    const s = ls.getItem(KEY_SMOOTHING);
    if (s === 'off' || s === 'light' || s === 'normal') _smoothing = s;
    const p = ls.getItem(KEY_PREDICTION);
    if (p === '0' || p === '1') _prediction = p === '1';
  } catch { /* blocked storage: defaults */ }
}

function persist(key: string, value: string): void {
  try { storage()?.setItem(key, value); } catch { /* blocked / full storage: in-memory only */ }
}

/** The finger smoothing mode (default 'light'). */
export function getTouchSmoothing(): TouchSmoothing { ensureLoaded(); return _smoothing; }

/** Set the finger smoothing mode (persisted per machine). Unknown values are ignored. */
export function setTouchSmoothing(mode: TouchSmoothing): void {
  if (mode !== 'off' && mode !== 'light' && mode !== 'normal') return;
  ensureLoaded();
  _smoothing = mode;
  persist(KEY_SMOOTHING, mode);
}

/** Whether touch / pen strokes draw a predicted provisional tail (default true). */
export function getStrokePrediction(): boolean { ensureLoaded(); return _prediction; }

/** Turn stroke prediction on / off (persisted per machine). */
export function setStrokePrediction(on: boolean): void {
  ensureLoaded();
  _prediction = !!on;
  persist(KEY_PREDICTION, _prediction ? '1' : '0');
}

/** Tests: forget the in-memory values so the next read reloads from storage (or the defaults). */
export function reloadBrushInputSettings(): void {
  _loaded = false;
  _smoothing = 'light';
  _prediction = false;
}

/** Prediction applies to these pointer types only (mouse never predicts: desktop stays byte-identical). */
export function predictionAppliesTo(pointerType: string | undefined): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

/**
 * The mean lag (ms, at a constant speed and 60 Hz input) of a stabilizer config, or null when it isn't a TIME lag
 * (pull-string's lag is a distance). Matches BrushStabilizer:
 *  • moving-average: N = round(2·level) frames, linear weights → mean age (N − 1) / 3 frames;
 *  • predictive: per-frame alpha = 1 / (1 + 1.5·level) → mean lag (1 − α) / α = 1.5·level frames;
 *  • catmull-rom: evaluated at t = clamp(0.9 − 0.05·level, 0.4, 0.9) between the 2nd- and 3rd-newest samples
 *    → (2 − t) samples.
 */
export function stabilizationLagMs(cfg: BrushStabilization): number | null {
  const level = Math.max(0, Math.min(10, cfg.level));
  if (cfg.method === 'none' || level === 0) return 0;
  switch (cfg.method) {
    case 'moving-average': return Math.max(0, (Math.max(1, Math.round(level * 2)) - 1) / 3) * REF_FRAME_MS;
    case 'predictive': return 1.5 * level * REF_FRAME_MS;
    case 'catmull-rom': return (2 - Math.max(0.4, Math.min(0.9, 0.9 - level * 0.05))) * REF_FRAME_MS;
    default: return null;
  }
}

/**
 * `cfg` with its level lowered so its lag is at most `maxLagMs` (the same object when it already is, or when the
 * lag isn't time-based — pull-string). Never raises a level.
 */
export function capStabilizationLag(cfg: BrushStabilization, maxLagMs: number): BrushStabilization {
  const lag = stabilizationLagMs(cfg);
  if (lag === null || lag <= maxLagMs + 1e-9) return cfg;
  const frames = Math.max(0, maxLagMs) / REF_FRAME_MS;
  let level: number;
  switch (cfg.method) {
    // largest N with (N − 1) / 3 ≤ frames → level N / 2 (N = 1 is a 1-sample window: no smoothing)
    case 'moving-average': level = Math.floor(3 * frames + 1 + 1e-9) / 2; break;
    case 'predictive': level = frames / 1.5; break;
    // its lag can't drop below ~1.1 samples except by turning it off: the lightest level (1) unless the cap is 0
    case 'catmull-rom': level = frames > 0 ? 1 : 0; break;
    default: return cfg;
  }
  level = Math.min(cfg.level, level);
  if (level === cfg.level) return cfg;
  return { ...cfg, level };
}

/**
 * The stabilization a stroke from `pointerType` uses. Only a finger is capped ('touch'); pen, mouse and unknown
 * pointers get `cfg` itself (same object), so their strokes are unchanged.
 */
export function stabilizationForPointer(
  cfg: BrushStabilization, pointerType: string | undefined, mode: TouchSmoothing = getTouchSmoothing(),
): BrushStabilization {
  if (pointerType !== 'touch' || mode === 'normal') return cfg;
  if (mode === 'off') return (cfg.method === 'none' || cfg.level === 0) ? cfg : { ...cfg, level: 0 };
  return capStabilizationLag(cfg, LIGHT_TOUCH_LAG_MS);
}
