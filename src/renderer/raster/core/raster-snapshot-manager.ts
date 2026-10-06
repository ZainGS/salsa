/**
 * RasterSnapshotManager — per-texture undo/redo snapshot stack.
 *
 * Extracted from RasterTextureManager. Manages GPU readback, comparison,
 * coalescing, and restore for a single raster texture.
 *
 * BRUSH-6 (docs/specs/mobile-parity.md §3): the stack holds two kinds of entry —
 *  • FULL: the whole texture (fills, filters, clears, resizes, the seed).
 *  • RECT: a brush stroke's BEFORE/AFTER pixels of the region it wrote. A stroke no longer clones the previous
 *    full frame (was `prev.data.slice()` — 10 full copies per stack, ~700 MB at A4) or reads back the whole
 *    canvas. Undoing a rect entry writes its BEFORE pixels back; redoing writes its AFTER pixels.
 * Entry 0 is always FULL: trimming the oldest entry folds the next rect entry into it. A full state is only
 * rebuilt (nearest full + later rect AFTERs) when undo lands on a rect entry from a full one, or to dedup a full
 * push against a rect top.
 */

import { bumpGpuPixelEpoch } from '../gpu-pixel-epoch';

/** A rect undo patch: `before`/`after` are tightly packed RGBA rows of the rect (rw*rh*4 bytes) on a w×h texture. */
export interface RasterRectPatch {
  /** Texture size the patch belongs to. */
  w: number; h: number;
  /** The rect, in texels. */
  x: number; y: number; rw: number; rh: number;
  before: Uint8Array;
  after: Uint8Array;
}

type FullSnap = { kind: 'full'; w: number; h: number; data: Uint8Array };
type RectSnap = { kind: 'rect' } & RasterRectPatch;
type Snap = FullSnap | RectSnap;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class RasterSnapshotManager {
  private device: GPUDevice;
  private snapshots: Snap[] = [];
  private snapIndex = -1;
  private maxSnapshots: number;

  private lastSnapshotMs = 0;
  private readonly COALESCE_MS = 40;

  // Reusable CPU-side staging array
  private cpuStaging?: Uint8Array;
  private stagingBuffer?: GPUBuffer;
  private stagingSize = 0;

  private debug = false;

  constructor(device: GPUDevice, maxSnapshots = 10) {
    this.device = device;
    this.maxSnapshots = maxSnapshots;
  }

  /** Diagnostics / tests: entry kinds, the current index, and the bytes the stack holds. */
  public getStats(): { kinds: Array<'full' | 'rect'>; index: number; bytes: number } {
    let bytes = 0;
    for (const s of this.snapshots) bytes += s.kind === 'full' ? s.data.length : s.before.length + s.after.length;
    return { kinds: this.snapshots.map(s => s.kind), index: this.snapIndex, bytes };
  }

  // ── Push ──────────────────────────────────────────────────────────

  /**
   * Capture the current state of `texture` and push it onto the undo stack.
   * Deduplicates and coalesces rapid calls.
   *
   * `dirtyRect` (E5 tail): the caller-known touched region of the change being snapshotted. When the current
   * state matches this texture's size, only the rect is read back and pushed as a RECT entry whose BEFORE is
   * taken from the stack's current state — so everything outside the rect must BY INVARIANT equal that state.
   * Prefer {@link pushPatch} (BEFORE read from the GPU, no invariant). Omit it (fills, filters, clears,
   * resizes) for the full-canvas readback.
   */
  public async pushSnapshot(texture: GPUTexture, dirtyRect?: { x: number; y: number; w: number; h: number }): Promise<void> {
    bumpGpuPixelEpoch();   // every push follows an edit, coalesced or not (device-lost shadow accuracy)
    return this._push(texture, dirtyRect);
  }

  /**
   * BRUSH-6: push a brush stroke as a RECT entry. `patch.before` is the real pre-stroke pixels (the stroke-start
   * GPU snapshot), `patch.after` the post-stroke pixels — so undo is exact inside the rect whatever happened
   * elsewhere. Never coalesced (dropping a rect entry would lose the stroke from the chain). Falls back to a
   * full push when the stack has no state of this size to sit on.
   */
  public async pushPatch(texture: GPUTexture, patch: RasterRectPatch): Promise<void> {
    bumpGpuPixelEpoch();
    const w = texture.width, h = texture.height;
    const top = this.snapIndex >= 0 ? this.snapshots[this.snapIndex] : undefined;
    const fits = patch.w === w && patch.h === h && patch.rw > 0 && patch.rh > 0
      && patch.x >= 0 && patch.y >= 0 && patch.x + patch.rw <= w && patch.y + patch.rh <= h
      && patch.before.length === patch.rw * patch.rh * 4 && patch.after.length === patch.before.length;
    if (!top || top.w !== w || top.h !== h || !fits) {
      this.lastSnapshotMs = 0;   // the fallback must not be coalesced away
      return this._push(texture);
    }
    if (bytesEqual(patch.before, patch.after)) {
      if (this.debug) console.log('RasterSnapshotManager: skipped identical (patch)');
      return;
    }
    this.lastSnapshotMs = Date.now();
    this.append({ kind: 'rect', w, h, x: patch.x, y: patch.y, rw: patch.rw, rh: patch.rh,
                  before: patch.before, after: patch.after });
  }

  private async _push(texture: GPUTexture, dirtyRect?: { x: number; y: number; w: number; h: number }): Promise<void> {
    const now = Date.now();
    if (now - this.lastSnapshotMs < this.COALESCE_MS) {
      if (this.debug) console.log('RasterSnapshotManager: coalesced');
      return;
    }
    this.lastSnapshotMs = now;

    const w = texture.width;
    const h = texture.height;
    if (w === 0 || h === 0) return;

    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;

    // ── Dirty-rect fast path: read back only the touched region; BEFORE comes from the current state ──
    const prev = this.snapIndex >= 0 ? this.snapshots[this.snapIndex] : undefined;
    if (dirtyRect && prev && prev.w === w && prev.h === h) {
      const rx = Math.max(0, Math.floor(dirtyRect.x));
      const ry = Math.max(0, Math.floor(dirtyRect.y));
      const rw = Math.min(w - rx, Math.ceil(dirtyRect.w + (dirtyRect.x - rx)));
      const rh = Math.min(h - ry, Math.ceil(dirtyRect.h + (dirtyRect.y - ry)));
      if (rw <= 0 || rh <= 0) return;                        // stroke landed entirely off-canvas → no change
      if (rw * rh < w * h * 0.7) {                           // near-full rect → the plain full path is cheaper
        const rectRow = rw * bytesPerPixel;
        const rectPadded = Math.ceil(rectRow / 256) * 256;
        const rBuf = this.device.createBuffer({ size: rectPadded * rh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const rEnc = this.device.createCommandEncoder();
        rEnc.copyTextureToBuffer(
          { texture, origin: { x: rx, y: ry } },
          { buffer: rBuf, bytesPerRow: rectPadded },
          { width: rw, height: rh, depthOrArrayLayers: 1 },
        );
        this.device.queue.submit([rEnc.finish()]);
        await rBuf.mapAsync(GPUMapMode.READ);
        const rMapped = new Uint8Array(rBuf.getMappedRange());
        const after = new Uint8Array(rectRow * rh);
        for (let row = 0; row < rh; row++) after.set(rMapped.subarray(row * rectPadded, row * rectPadded + rectRow), row * rectRow);
        rBuf.unmap(); rBuf.destroy();
        const before = this.readStateRegion(this.snapIndex, rx, ry, rw, rh);
        // Dedup inside the rect (outside is identical by construction) — a no-op stroke pushes nothing.
        if (bytesEqual(before, after)) {
          if (this.debug) console.log('RasterSnapshotManager: skipped identical (rect)');
          return;
        }
        this.append({ kind: 'rect', w, h, x: rx, y: ry, rw, rh, before, after });
        if (this.debug) console.log('RasterSnapshotManager: pushed (rect', rx, ry, rw, rh, '), idx=', this.snapIndex);
        return;
      }
    }

    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const total = paddedRow * h;

    const readBuf = this.device.createBuffer({
      size: total,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: readBuf, bytesPerRow: paddedRow },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readBuf.getMappedRange());

    // Tightly pack rows (remove padding)
    const out = new Uint8Array(unpaddedRow * h);
    for (let row = 0; row < h; row++) {
      out.set(mapped.subarray(row * paddedRow, row * paddedRow + unpaddedRow), row * unpaddedRow);
    }

    readBuf.unmap();
    readBuf.destroy();

    // Dedup: skip if identical to the current state. E5: compare 8 bytes per step via Float64 views
    // (~8× fewer iterations than the old per-byte loop — the FULL scan runs exactly when the stroke was a
    // no-op, i.e. the dedup-hit case the audit flagged); a real change still early-exits at the first
    // differing word. NaN caveat doesn't apply: equal BIT patterns compare equal unless both are NaN
    // encodings, and any 8 pixel bytes forming a NaN double would differ bitwise in the changed case
    // anyway — but to stay exact we fall back to byte compare for the (rare) word where !== fires.
    if (this.snapIndex >= 0 && this.snapshots.length > 0) {
      const current = this.snapshots[this.snapIndex];
      if (current && current.w === w && current.h === h) {
        const curData = this.stateData(this.snapIndex);
        if (curData.length === out.length && RasterSnapshotManager._buffersEqual(curData, out)) {
          if (this.debug) console.log('RasterSnapshotManager: skipped identical');
          return;
        }
      }
    }

    this.append({ kind: 'full', w, h, data: out });
    if (this.debug) console.log('RasterSnapshotManager: pushed, idx=', this.snapIndex, 'len=', this.snapshots.length);
  }

  /** Truncate redo history, append, trim to maxSnapshots (keeping entry 0 FULL), point at the new top. */
  private append(entry: Snap): void {
    if (this.snapIndex + 1 < this.snapshots.length) {
      this.snapshots.length = this.snapIndex + 1;
    }
    this.snapshots.push(entry);
    while (this.snapshots.length > this.maxSnapshots) {
      const oldest = this.snapshots[0];
      const next = this.snapshots[1];
      if (next && next.kind === 'rect' && oldest.kind === 'full' && oldest.w === next.w && oldest.h === next.h) {
        // Fold the rect into the dropped full frame (in place — it is being discarded) so entry 0 stays full.
        RasterSnapshotManager.applyRegion(oldest.data, oldest.w, next.x, next.y, next.rw, next.rh, next.after);
        this.snapshots[1] = { kind: 'full', w: oldest.w, h: oldest.h, data: oldest.data };
      }
      this.snapshots.shift();
    }
    this.snapIndex = this.snapshots.length - 1;
  }

  // ── State reconstruction ──────────────────────────────────────────

  /** The full pixels of state `i` (shared for a FULL entry; rebuilt — nearest full ≤ i plus the rect AFTERs up
   *  to i — for a RECT entry). Treat the result as read-only. */
  private stateData(i: number): Uint8Array {
    const s = this.snapshots[i];
    if (s.kind === 'full') return s.data;
    let j = i;
    while (j >= 0 && this.snapshots[j].kind !== 'full') j--;
    if (j < 0) throw new Error('RasterSnapshotManager: no full base for a rect entry');
    const base = this.snapshots[j] as FullSnap;
    const data = base.data.slice();
    for (let k = j + 1; k <= i; k++) {
      const r = this.snapshots[k] as RectSnap;
      RasterSnapshotManager.applyRegion(data, base.w, r.x, r.y, r.rw, r.rh, r.after);
    }
    return data;
  }

  /** Region (tightly packed) of state `i`, built without materialising the whole frame. */
  private readStateRegion(i: number, x: number, y: number, rw: number, rh: number): Uint8Array {
    let j = i;
    while (j >= 0 && this.snapshots[j].kind !== 'full') j--;
    if (j < 0) throw new Error('RasterSnapshotManager: no full base for a rect entry');
    const base = this.snapshots[j] as FullSnap;
    const W = base.w, row = rw * 4;
    const out = new Uint8Array(row * rh);
    for (let r = 0; r < rh; r++) {
      const off = ((y + r) * W + x) * 4;
      out.set(base.data.subarray(off, off + row), r * row);
    }
    for (let k = j + 1; k <= i; k++) {
      const p = this.snapshots[k] as RectSnap;
      // Intersect p with the requested region and copy p.after's overlap in.
      const ix0 = Math.max(x, p.x), iy0 = Math.max(y, p.y);
      const ix1 = Math.min(x + rw, p.x + p.rw), iy1 = Math.min(y + rh, p.y + p.rh);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const n = (ix1 - ix0) * 4;
      for (let yy = iy0; yy < iy1; yy++) {
        const src = ((yy - p.y) * p.rw + (ix0 - p.x)) * 4;
        out.set(p.after.subarray(src, src + n), ((yy - y) * rw + (ix0 - x)) * 4);
      }
    }
    return out;
  }

  /** Write a tightly packed rect into a full frame of width `w`. */
  private static applyRegion(data: Uint8Array, w: number, x: number, y: number, rw: number, rh: number, src: Uint8Array): void {
    const row = rw * 4;
    for (let r = 0; r < rh; r++) data.set(src.subarray(r * row, r * row + row), ((y + r) * w + x) * 4);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────

  /** `resize` (optional): called with the snapshot's dimensions before restoring, returning the texture
   *  to restore into — lets an owner that reallocates on size change (RasterTextureManager.ensureTexture)
   *  restore a snapshot taken at a different document size. Without it, `texture` is used as-is. */
  public async undo(texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): Promise<boolean> {
    if (this.snapshots.length === 0) return false;
    if (this.snapIndex === -1) {
      this.snapIndex = this.snapshots.length - 1;
      await this.restoreState(this.snapIndex, texture, resize);
      return true;
    }
    if (this.snapIndex === 0) return false; // already at oldest
    const leaving = this.snapshots[this.snapIndex];
    this.snapIndex--;
    if (leaving.kind === 'rect') this.writeRect(leaving, leaving.before, texture, resize);
    else await this.restoreState(this.snapIndex, texture, resize);
    return true;
  }

  public async redo(texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): Promise<boolean> {
    if (this.snapIndex === -1) {
      if (this.snapshots.length === 0) return false;
      this.snapIndex = 0;
      await this.restoreState(0, texture, resize);
      return true;
    }
    if (this.snapIndex + 1 >= this.snapshots.length) return false;
    this.snapIndex++;
    const entering = this.snapshots[this.snapIndex];
    if (entering.kind === 'rect') this.writeRect(entering, entering.after, texture, resize);
    else await this.restoreState(this.snapIndex, texture, resize);
    return true;
  }

  /** Seed with a blank texture so the first stroke is undoable. */
  public async initialize(texture: GPUTexture): Promise<void> {
    await this._push(texture);   // seeding the stack is not an edit (no epoch bump)
    if (this.snapshots.length > 0) this.snapIndex = 0;
  }

  // ── Restore ───────────────────────────────────────────────────────

  private async restoreState(i: number, texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): Promise<void> {
    const s = this.snapshots[i];
    await this.restore(resize ? resize(s.w, s.h) : texture, { w: s.w, h: s.h, data: this.stateData(i) });
  }

  /** Write one rect entry's BEFORE (undo) or AFTER (redo) pixels back. */
  private writeRect(s: RectSnap, bytes: Uint8Array, texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): void {
    bumpGpuPixelEpoch();   // undo / redo rewrite the pixels
    const target = resize ? resize(s.w, s.h) : texture;
    this.device.queue.writeTexture(
      { texture: target, mipLevel: 0, origin: { x: s.x, y: s.y, z: 0 } },
      bytes as unknown as ArrayBuffer,
      { offset: 0, bytesPerRow: s.rw * 4, rowsPerImage: s.rh },
      { width: s.rw, height: s.rh, depthOrArrayLayers: 1 },
    );
  }

  private async restore(texture: GPUTexture, snap: { w: number; h: number; data: Uint8Array }): Promise<void> {
    bumpGpuPixelEpoch();   // undo / redo rewrite the pixels
    const w = snap.w;
    const h = snap.h;
    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const total = paddedRow * h;

    this.ensureStagingBuffer(total);
    if (!this.cpuStaging || this.cpuStaging.length < total) this.cpuStaging = new Uint8Array(total);

    const tmp = this.cpuStaging;
    for (let row = 0; row < h; row++) {
      tmp.set(snap.data.subarray(row * unpaddedRow, row * unpaddedRow + unpaddedRow), row * paddedRow);
    }

    const MAX_CHUNK = 4 * 1024 * 1024;
    let offset = 0;
    while (offset < total) {
      const chunk = Math.min(MAX_CHUNK, total - offset);
      this.device.queue.writeBuffer(this.stagingBuffer!, offset, tmp as unknown as ArrayBuffer, offset, chunk);
      offset += chunk;
    }

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: this.stagingBuffer!, bytesPerRow: paddedRow },
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([enc.finish()]);
  }

  /** Exact equality of two equal-length byte buffers, compared 8 bytes at a time (Float64 bit patterns;
   *  a `!==` word falls back to byte checks so NaN-encoded words can never cause a false "different"). */
  private static _buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
    const n = a.length;
    const words = n >>> 3;
    if (words > 0 && a.byteOffset % 8 === 0 && b.byteOffset % 8 === 0) {
      const fa = new Float64Array(a.buffer, a.byteOffset, words);
      const fb = new Float64Array(b.buffer, b.byteOffset, words);
      for (let i = 0; i < words; i++) {
        if (fa[i] !== fb[i]) {
          // Could be a real difference OR two different-or-same NaN bit patterns — settle by bytes.
          const o = i << 3;
          for (let j = o; j < o + 8; j++) if (a[j] !== b[j]) return false;
        }
      }
      for (let i = words << 3; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private ensureStagingBuffer(minSize: number): void {
    if (this.stagingBuffer && this.stagingSize >= minSize) return;
    this.stagingBuffer?.destroy();
    this.stagingSize = Math.max(minSize, 256);
    this.stagingBuffer = this.device.createBuffer({
      size: this.stagingSize,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  public destroy(): void {
    this.stagingBuffer?.destroy();
    this.snapshots.length = 0;
  }
}
