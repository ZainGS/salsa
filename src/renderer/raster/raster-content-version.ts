/**
 * Per-texture CONTENT versions for the incremental autosave (docs/ui/document-persistence.md "Incremental autosave").
 *
 * A save used to read back EVERY raster layer, cel and painted mesh texture from the GPU and PNG-encode it, changed
 * or not. Now each read-back is cached with the write count it reflects, and a texture is read again only when a write
 * to it was reported after that. One global, monotonically increasing count; each write records the count against the
 * texture it wrote:
 *
 *   noteRasterContentWrite(tex)   — a write to `tex` (or to every texture in a list)
 *   noteRasterContentWrite()      — a write whose target is NOT known: EVERY texture counts as changed (fail safe)
 *
 * Nobody calls this directly in the common case: it is fed by the two conventions every pixel writer already follows
 * — `markRasterCompositeDirty(rect?, target?)` (BRUSH-5) and `bumpGpuPixelEpoch(dirty?, target?)` (device-lost
 * shadow) — and by the undo snapshot manager. A writer that passes no target marks everything changed, so a writer
 * that is never attributed costs a full read-back (the old behaviour), never a lost edit. Only an attributed write
 * lets the other layers stay cached, so attribute only when the written texture is certain.
 *
 * Note at or AFTER the write is submitted (a note before an `await` that precedes the submit could be overtaken by a
 * read-back that misses the write). Over-reporting is always safe; under-reporting loses the edit from autosave until
 * the next full read-back (explicit saves and the periodic verification read everything).
 */

let seq = 0;
/** The count of the newest write whose target was not known — every texture is at least this new. */
let unattributedAt = 0;
const writtenAt = new WeakMap<object, number>();

/** Diagnostics / tests. */
export const rasterContentStats = { notes: 0, unattributed: 0 };

/** Record a write to GPU-only pixels: `target` = the texture(s) written; omitted / null / empty = unknown (all). */
export function noteRasterContentWrite(target?: object | ReadonlyArray<object | null | undefined> | null): void {
  seq++;
  rasterContentStats.notes++;
  if (target && Array.isArray(target)) {
    let any = false;
    for (const t of target) if (t) { writtenAt.set(t, seq); any = true; }
    if (any) return;
  } else if (target) {
    writtenAt.set(target as object, seq);
    return;
  }
  unattributedAt = seq;
  rasterContentStats.unattributed++;
}

/** The current write count (capture it BEFORE a read-back is submitted; the read-back reflects at least this). */
export function rasterContentSeq(): number { return seq; }

/** The count of the newest write that may have changed `tex` (an unattributed write counts for every texture). */
export function rasterTextureWrittenAt(tex: object): number {
  const own = writtenAt.get(tex) ?? 0;
  return own > unattributedAt ? own : unattributedAt;
}

const textureUids = new WeakMap<object, number>();
let nextTextureUid = 0;

/** A stable number for a texture OBJECT. A new texture (a resize, a device recovery, a new cel) gets a new one. */
export function rasterTextureUid(tex: object): number {
  let id = textureUids.get(tex);
  if (id === undefined) { id = ++nextTextureUid; textureUids.set(tex, id); }
  return id;
}

/**
 * An opaque CONTENT VERSION of `tex` for a host's own copy of the pixels (Frogmarks' cloud upload, via
 * `sm.getRasterContentVersions()`). It changes when the texture object changes or when a write to it — or a write
 * with no known target — is reported. Two equal strings mean no reported write happened in between, so a copy taken
 * when the first was read is still current. No texture = `'none'`.
 *
 * Read the version BEFORE you read the pixels: a write that lands in between makes the next comparison differ, so the
 * copy is taken again (over-reporting is safe, under-reporting is not).
 */
export function rasterTextureVersion(tex: object | null | undefined): string {
  if (!tex) return 'none';
  return rasterTextureUid(tex) + ':' + rasterTextureWrittenAt(tex);
}
