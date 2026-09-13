/**
 * RasterSnapshotManager — per-texture undo/redo snapshot stack.
 *
 * Extracted from RasterTextureManager. Manages GPU readback, comparison,
 * coalescing, and restore for a single raster texture.
 */

export class RasterSnapshotManager {
  private device: GPUDevice;
  private snapshots: Array<{ w: number; h: number; data: Uint8Array }> = [];
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

  // ── Push ──────────────────────────────────────────────────────────

  /**
   * Capture the current state of `texture` and push it onto the undo stack.
   * Deduplicates and coalesces rapid calls.
   */
  public async pushSnapshot(texture: GPUTexture): Promise<void> {
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

    // Dedup: skip if identical to the current snapshot. E5: compare 8 bytes per step via Float64 views
    // (~8× fewer iterations than the old per-byte loop — the FULL scan runs exactly when the stroke was a
    // no-op, i.e. the dedup-hit case the audit flagged); a real change still early-exits at the first
    // differing word. NaN caveat doesn't apply: equal BIT patterns compare equal unless both are NaN
    // encodings, and any 8 pixel bytes forming a NaN double would differ bitwise in the changed case
    // anyway — but to stay exact we fall back to byte compare for the (rare) word where !== fires.
    if (this.snapIndex >= 0 && this.snapshots.length > 0) {
      const current = this.snapshots[this.snapIndex];
      if (current && current.w === w && current.h === h && current.data.length === out.length) {
        if (RasterSnapshotManager._buffersEqual(current.data, out)) {
          if (this.debug) console.log('RasterSnapshotManager: skipped identical');
          return;
        }
      }
    }

    // Truncate redo history
    if (this.snapIndex + 1 < this.snapshots.length) {
      this.snapshots.length = this.snapIndex + 1;
    }

    this.snapshots.push({ w, h, data: out });

    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    this.snapIndex = this.snapshots.length - 1;
    if (this.debug) console.log('RasterSnapshotManager: pushed, idx=', this.snapIndex, 'len=', this.snapshots.length);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────

  /** `resize` (optional): called with the snapshot's dimensions before restoring, returning the texture
   *  to restore into — lets an owner that reallocates on size change (RasterTextureManager.ensureTexture)
   *  restore a snapshot taken at a different document size. Without it, `texture` is used as-is. */
  public async undo(texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): Promise<boolean> {
    if (this.snapshots.length === 0) return false;
    if (this.snapIndex === -1) {
      this.snapIndex = this.snapshots.length - 1;
    } else if (this.snapIndex > 0) {
      this.snapIndex--;
    } else {
      return false; // already at oldest
    }
    const snap = this.snapshots[this.snapIndex];
    await this.restore(resize ? resize(snap.w, snap.h) : texture, snap);
    return true;
  }

  public async redo(texture: GPUTexture, resize?: (w: number, h: number) => GPUTexture): Promise<boolean> {
    if (this.snapIndex === -1) {
      if (this.snapshots.length === 0) return false;
      this.snapIndex = 0;
    } else {
      if (this.snapIndex + 1 >= this.snapshots.length) return false;
      this.snapIndex++;
    }
    const snap = this.snapshots[this.snapIndex];
    await this.restore(resize ? resize(snap.w, snap.h) : texture, snap);
    return true;
  }

  /** Seed with a blank texture so the first stroke is undoable. */
  public async initialize(texture: GPUTexture): Promise<void> {
    await this.pushSnapshot(texture);
    if (this.snapshots.length > 0) this.snapIndex = 0;
  }

  // ── Restore ───────────────────────────────────────────────────────

  private async restore(texture: GPUTexture, snap: { w: number; h: number; data: Uint8Array }): Promise<void> {
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
