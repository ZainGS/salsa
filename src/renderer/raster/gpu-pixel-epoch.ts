/**
 * A session-wide count of edits to pixels that live ONLY on the GPU: raster layers, animation cels, UV-paint / decal
 * textures and hand-painted face textures (docs/ui/device-recovery.md).
 *
 * The device-lost recovery keeps a read-back SHADOW of those pixels. It records this count when the shadow is taken
 * (or seeded from a document restore); if the count is unchanged at the loss, the shadow is exact and nothing was
 * lost. Bumped by every RasterSnapshotManager push (each undoable raster edit pushes one, so every paint engine, the
 * selection / move / text tools and UV paint are covered), by undo / redo, and by direct pixel uploads.
 *
 * Over-counting is safe (the recovery only reports pixels "as of the last read-back" when they may not be);
 * under-counting is not, so any new path that writes GPU-only pixels without an undo snapshot must call
 * `bumpGpuPixelEpoch()`.
 */
import { markRasterCompositeDirty, type DirtyTexelRect } from './core/raster-composite-dirty';
import { noteRasterContentWrite } from './raster-content-version';

let epoch = 0;

/** The current edit count. */
export function gpuPixelEpoch(): number { return epoch; }

/**
 * Record one edit to GPU-only pixels.
 *
 * BRUSH-5: the edit is also reported to the incremental raster-layer composite (raster-composite-dirty.ts), so every
 * path that already had to call this is covered there too. `dirty`: the texels written (max-exclusive), 'full'
 * (the default — the whole canvas, always safe) or 'none' (the writer reported its own rects, e.g. a brush stroke's
 * undo patch, whose pixels the brush pipeline reported dab by dab).
 *
 * `target`: the texture(s) written, when certain — the incremental autosave then re-reads only those
 * (raster-content-version.ts). Omitted = every texture counts as changed (always safe).
 */
export function bumpGpuPixelEpoch(dirty: DirtyTexelRect | 'full' | 'none' = 'full', target?: object | ReadonlyArray<object | null | undefined> | null): void {
  epoch++;
  if (dirty !== 'none') markRasterCompositeDirty(dirty === 'full' ? null : dirty, target);
  else noteRasterContentWrite(target);
}
