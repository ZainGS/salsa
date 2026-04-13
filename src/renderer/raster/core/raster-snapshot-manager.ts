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

  constructor(device: GPUDevice, maxSnapshots = 50) {
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

    // Dedup: skip if identical to the current snapshot
    if (this.snapIndex >= 0 && this.snapshots.length > 0) {
      const current = this.snapshots[this.snapIndex];
      if (current && current.w === w && current.h === h && current.data.length === out.length) {
        let same = true;
        for (let i = 0; i < out.length; i++) {
          if (current.data[i] !== out[i]) { same = false; break; }
        }
        if (same) {
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

  public async undo(texture: GPUTexture): Promise<boolean> {
    if (this.snapshots.length === 0) return false;
    if (this.snapIndex === -1) {
      this.snapIndex = this.snapshots.length - 1;
    } else if (this.snapIndex > 0) {
      this.snapIndex--;
    } else {
      return false; // already at oldest
    }
    await this.restore(texture, this.snapshots[this.snapIndex]);
    return true;
  }

  public async redo(texture: GPUTexture): Promise<boolean> {
    if (this.snapIndex === -1) {
      if (this.snapshots.length === 0) return false;
      this.snapIndex = 0;
    } else {
      if (this.snapIndex + 1 >= this.snapshots.length) return false;
      this.snapIndex++;
    }
    await this.restore(texture, this.snapshots[this.snapIndex]);
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
