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

/** Texels, max-exclusive (the same shape as raster-composite-dirty's DirtyTexelRect). */
export interface ContentTexelRect { x0: number; y0: number; x1: number; y1: number }

/**
 * The texels each write touched, for consumers that keep a DERIVED copy of a texture and want to redo only the
 * changed part (the per-layer dither cache, layer-dither-cache.ts). One entry per note, newest last, bounded: a
 * consumer that fell behind the oldest kept entry redoes everything. `targets` null = not attributed (every
 * texture); `rect` null = unknown (the whole texture); 'reported' = the texels were already reported by an earlier
 * note (bumpGpuPixelEpoch('none'): a brush stroke's undo patch, whose dabs the brush pipeline reported).
 */
interface ContentLogEntry { seq: number; targets: readonly object[] | null; rect: ContentTexelRect | null | 'reported' }
const CONTENT_LOG_MAX = 1024;
const contentLog: ContentLogEntry[] = [];
let contentLogFloor = 0;   // entries with seq <= this were dropped

/**
 * Record a write to GPU-only pixels: `target` = the texture(s) written; omitted / null / empty = unknown (all).
 * `rect`: the texels written (max-exclusive); omitted / null = unknown (the whole texture, always safe); 'reported' =
 * the texels were reported by an earlier note (only the version moves). Only the per-texture dirty-rect query
 * (rasterTextureDirtySince) reads it — the versions are the same either way.
 */
export function noteRasterContentWrite(
  target?: object | ReadonlyArray<object | null | undefined> | null,
  rect?: ContentTexelRect | null | 'reported',
): void {
  seq++;
  rasterContentStats.notes++;
  let targets: object[] | null = null;
  if (target && Array.isArray(target)) {
    for (const t of target) if (t) { writtenAt.set(t, seq); (targets ??= []).push(t); }
  } else if (target) {
    writtenAt.set(target as object, seq);
    targets = [target as object];
  }
  let r: ContentTexelRect | null | 'reported' = rect ?? null;
  if (r && r !== 'reported') {
    const ok = Number.isFinite(r.x0) && Number.isFinite(r.y0) && Number.isFinite(r.x1) && Number.isFinite(r.y1);
    r = !ok ? null : (r.x1 > r.x0 && r.y1 > r.y0) ? { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 } : 'reported';   // empty = nothing written
  }
  contentLog.push({ seq, targets, rect: r });
  if (contentLog.length > CONTENT_LOG_MAX) {
    const drop = contentLog.length - (CONTENT_LOG_MAX >> 1);
    contentLogFloor = contentLog[drop - 1].seq;
    contentLog.splice(0, drop);
  }
  if (targets) return;
  unattributedAt = seq;
  rasterContentStats.unattributed++;
}

/**
 * The texels of `tex` written by every note AFTER `sinceSeq` (a rasterContentSeq() value the caller captured when
 * its copy was last brought up to date): null = none (no write, or only 'reported' ones), 'full' = unknown (a write
 * with no rect, or the log no longer reaches back that far), else the union rect — integer texels, rounded outward,
 * NOT clipped to the texture. Unattributed writes count for every texture.
 */
export function rasterTextureDirtySince(tex: object, sinceSeq: number): ContentTexelRect | 'full' | null {
  if (rasterTextureWrittenAt(tex) <= sinceSeq) return null;
  if (sinceSeq < contentLogFloor) return 'full';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = contentLog.length - 1; i >= 0; i--) {
    const e = contentLog[i];
    if (e.seq <= sinceSeq) break;
    if (e.targets && !e.targets.includes(tex)) continue;
    const r = e.rect;
    if (r === 'reported') continue;
    if (!r) return 'full';
    if (r.x0 < x0) x0 = r.x0;
    if (r.y0 < y0) y0 = r.y0;
    if (r.x1 > x1) x1 = r.x1;
    if (r.y1 > y1) y1 = r.y1;
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
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
