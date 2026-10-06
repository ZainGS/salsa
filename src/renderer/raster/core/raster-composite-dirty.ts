/**
 * BRUSH-5 (docs/specs/mobile-parity.md §3): the dirty-rect log for the INCREMENTAL raster composite.
 *
 * The renderer keeps the composited layer stack in a persistent texture (RasterCompositor.compositeIncremental) and
 * re-composites only what changed. A layer's METADATA (texture identity / order / visibility / opacity / blend /
 * clip / grain / size) is compared by the compositor itself (its per-target signature), so callers never report it.
 * What it cannot see is a change to a layer's PIXELS through the same texture: every code path that writes pixels
 * into a raster layer or cel texture reports the texels it wrote here, in document texels (layer textures are
 * canvas-sized), max-exclusive. No rect = the whole canvas ("not sure" is always allowed — it costs one full
 * composite).
 *
 * Wired writers: BrushStampPipeline (every dab / composite / provisional tail and its restore, at submit), the
 * snapshot manager (undo / redo rect patches; full restores; every pushSnapshot as a safety net), and
 * bumpGpuPixelEpoch() (every direct pixel upload already has to call it) — see the BRUSH-5 row for the full list.
 *
 * The log is global (one per page) with a cursor per consumer, so a write is seen by every compositor target (main,
 * foreground, a second renderer) whenever each next composites. Over-reporting is harmless; a write that is never
 * reported leaves stale pixels on screen until the next full composite.
 */

/** Texels, max-exclusive. */
export interface DirtyTexelRect { x0: number; y0: number; x1: number; y1: number }

const LOG_MAX = 512;
let seq = 0;                  // seq of the newest entry
let floorSeq = 0;             // entries with seq <= floorSeq were dropped (a cursor behind it gets 'full')
const log: Array<{ seq: number; rect: DirtyTexelRect | null }> = [];   // rect null = whole canvas
const listeners = new Set<() => void>();

/** Diagnostics / tests. */
export const rasterDirtyStats = { marks: 0, fullMarks: 0 };

/**
 * Report a write to raster layer pixels. `rect` in texels, max-exclusive (fractional edges are rounded outward when
 * consumed); omitted / null = the whole canvas. An empty rect is ignored. Also asks every listener (the renderer's
 * scheduleRender) for a frame, so a write reported after the frame that would have shown it is never left stale.
 */
export function markRasterCompositeDirty(rect?: DirtyTexelRect | null): void {
  if (rect) {
    if (!(rect.x1 > rect.x0 && rect.y1 > rect.y0)) {
      // NaN or empty: a NaN rect is "unknown", an empty one is "nothing"
      if (!(Number.isNaN(rect.x0) || Number.isNaN(rect.y0) || Number.isNaN(rect.x1) || Number.isNaN(rect.y1))) return;
      rect = null;
    }
  }
  seq++;
  log.push({ seq, rect: rect ? { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 } : null });
  rasterDirtyStats.marks++;
  if (!rect) rasterDirtyStats.fullMarks++;
  if (log.length > LOG_MAX) {
    const drop = log.length - (LOG_MAX >> 1);
    floorSeq = log[drop - 1].seq;
    log.splice(0, drop);
  }
  for (const l of listeners) {
    try { l(); } catch (e) { console.warn('raster dirty listener failed', e); }
  }
}

/** Report a write of `w×h` texels at (x, y). */
export function markRasterCompositeDirtyXYWH(x: number, y: number, w: number, h: number): void {
  markRasterCompositeDirty({ x0: x, y0: y, x1: x + w, y1: y + h });
}

/** Subscribe to dirty reports (the renderer schedules a frame). Returns the unsubscribe. */
export function onRasterCompositeDirty(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The current log position (tests). */
export function rasterDirtySeq(): number { return seq; }

/** One consumer's position in the log. */
export class RasterDirtyCursor {
  private at = seq;

  /** Everything reported since the last take (or since creation): null = nothing, 'full' = the whole canvas,
   *  else the union rect (texels, max-exclusive, integer — rounded outward). Advances the cursor. */
  public take(): DirtyTexelRect | 'full' | null {
    const from = this.at;
    this.at = seq;
    if (from >= seq) return null;
    if (from < floorSeq) return 'full';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.seq <= from) break;
      const r = e.rect;
      if (!r) return 'full';
      if (r.x0 < x0) x0 = r.x0;
      if (r.y0 < y0) y0 = r.y0;
      if (r.x1 > x1) x1 = r.x1;
      if (r.y1 > y1) y1 = r.y1;
    }
    if (!(x1 > x0 && y1 > y0)) return null;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return 'full';
    return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
  }

  /** Drop everything reported so far (the consumer just did a full composite). */
  public skipToNow(): void { this.at = seq; }
}
