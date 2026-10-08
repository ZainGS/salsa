/**
 * Which raster textures have a brush stroke in progress (BrushStampPipeline.beginStroke → endStroke / abortStroke).
 *
 * Consumers that redo expensive work when a layer's pixels change — the per-layer error-diffusion dither
 * (layer-dither-cache.ts) — wait for the stroke to end instead of redoing it on every stroke frame, and are told
 * when it does. Session-wide (one per page), like the dirty-rect log.
 */

const active = new Map<object, number>();   // texture → open strokes on it
const endListeners = new Set<(tex: object) => void>();

/** A stroke started painting into `tex`. */
export function noteRasterStrokeBegin(tex: object): void {
  active.set(tex, (active.get(tex) ?? 0) + 1);
}

/** The stroke painting into `tex` ended (or was abandoned). Unmatched ends are ignored. */
export function noteRasterStrokeEnd(tex: object): void {
  const n = active.get(tex);
  if (n === undefined) return;
  if (n > 1) { active.set(tex, n - 1); return; }
  active.delete(tex);
  for (const l of endListeners) {
    try { l(tex); } catch (e) { console.warn('raster stroke-end listener failed', e); }
  }
}

/** Is a stroke painting into `tex` right now (any texture when omitted)? */
export function isRasterStrokeActive(tex?: object): boolean {
  return tex === undefined ? active.size > 0 : active.has(tex);
}

/** Subscribe to stroke ends. Returns the unsubscribe. */
export function onRasterStrokeEnd(cb: (tex: object) => void): () => void {
  endListeners.add(cb);
  return () => { endListeners.delete(cb); };
}
