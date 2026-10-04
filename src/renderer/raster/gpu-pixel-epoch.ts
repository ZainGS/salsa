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
let epoch = 0;

/** The current edit count. */
export function gpuPixelEpoch(): number { return epoch; }

/** Record one edit to GPU-only pixels. */
export function bumpGpuPixelEpoch(): void { epoch++; }
