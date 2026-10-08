import { markRasterCompositeDirty } from './core/raster-composite-dirty';
import { RasterCanvas } from './raster-canvas';
import { RasterSnapshotManager, RasterRectPatch } from './core/raster-snapshot-manager';
import { LegacyBrushStamp } from './brushes/legacy-brush-stamp';
import { rasterContentSeq, rasterTextureWrittenAt } from './raster-content-version';

/** One texture's undo history + the read-back seed still in flight (await it before using the history). */
type TextureHistory = { mgr: RasterSnapshotManager; ready: Promise<void> | null };

/**
 * RasterTextureManager — one GPU texture + upload/readback/export around it.
 *
 * Audit B1 (2026-09-11): this class used to carry its OWN copies of the undo-snapshot stack and the
 * single-dab compute brush. The snapshot logic now DELEGATES to RasterSnapshotManager (the extracted
 * single source of truth the paint engine also uses), and the legacy brush lives in LegacyBrushStamp
 * (fallback-only — the live painting path is RasterPaintEngine/BrushStampPipeline).
 *
 * Perf audit A3 (2026-10-09) — ANIMATION CELS: an animated layer shows a cel texture that is not this manager's
 * texture (cel 1 of a layer animated in-session IS it). The owner points the history at the displayed texture with
 * {@link setHistoryTarget}; pushSnapshot / undo / redo / historyMark then act on THAT texture's own history (one per
 * cel texture, kept in a WeakMap — dropped with the cel). Strokes on cel 2+ used to snapshot and "undo" the base
 * texture. pushStrokePatch routes by the texture the stroke painted.
 */
export class RasterTextureManager {
  private device: GPUDevice;
  private texture?: GPUTexture;
  private width = 0;
  private height = 0;
  // Reusable staging GPU buffer (for padded uploads)
  private stagingBuffer?: GPUBuffer;
  private stagingSize = 0;
  // Reusable CPU-side staging array to avoid per-upload allocation
  private cpuStaging?: Uint8Array;
  // Undo/redo snapshot stack (delegated; lazily created so texture-only users pay nothing)
  private snapshotMgr?: RasterSnapshotManager;
  // Legacy fallback brush (lazily created; see LegacyBrushStamp header)
  private legacyBrush?: LegacyBrushStamp;
  /** A3: the texture undo acts on when it is not `texture` (an animation cel); null = `texture`. */
  private historyTex: GPUTexture | null = null;
  /** A3: per-cel-texture histories (not `texture`'s, which is `snapshotMgr`). */
  private celHistories = new WeakMap<GPUTexture, TextureHistory>();
  /** B3: `texture` provably still blank since its blank seed — `seq` = the content-version seq at the seed. */
  private blankSince: { tex: GPUTexture; seq: number } | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensureSnapshotMgr(): RasterSnapshotManager {
    return this.snapshotMgr ??= new RasterSnapshotManager(this.device);
  }

  /** LEGACY fallback brush dab (see LegacyBrushStamp). cx,cy in texel coords; color 0..1 RGBA. */
  public dispatchBrushToTexture(
    tex: GPUTexture,
    _srcView: GPUTextureView | undefined,
    cx: number,
    cy: number,
    radius: number,
    colorArr: [number, number, number, number],
    mode: 'paint' | 'erase' | 'clear' = 'paint',
    eraseHard?: boolean,
    canvasWidth?: number,
    canvasHeight?: number
  ) {
    (this.legacyBrush ??= new LegacyBrushStamp(this.device))
      .dispatch(tex, this.width, this.height, cx, cy, radius, colorArr, mode, eraseHard, canvasWidth, canvasHeight);
  }

  /** Device-lost recovery (docs/ui/device-recovery.md): forget every GPU object (they died with the device). The next
   *  ensureTexture() allocates a BLANK texture on the new device (no copy from the dead one). */
  resetForNewDevice(): void {
    this.texture = undefined; this.width = 0; this.height = 0;
    this.stagingBuffer = undefined; this.stagingSize = 0;
    this.snapshotMgr?.destroy();   // (C3: out of the undo budget; its staging buffer died with the device)
    this.snapshotMgr = undefined; this.legacyBrush = undefined;
    this._paneReadBuf = undefined; this._paneReadBufSize = 0; this._paneReadBusy = false;
    this.historyTex = null; this.celHistories = new WeakMap(); this.blankSince = null;
  }

  ensureTexture(w: number, h: number) {
    if (this.texture && this.width === w && this.height === h) return this.texture;

    const oldTex = this.texture;
    const copyW  = oldTex ? Math.min(this.width, w) : 0;
    const copyH  = oldTex ? Math.min(this.height, h) : 0;
    // B3: a blank texture copied into a new one is still blank (the copy is not a reported write)
    const stillBlank = !!oldTex && this.isProvablyBlank();

    this.width = w; this.height = h;
    this.texture = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.RENDER_ATTACHMENT |
             GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.COPY_SRC,
    });

    // Preserve existing pixel data (e.g. when document size changes).
    // Copies as much as fits into the new texture; any new area stays transparent.
    if (oldTex && copyW > 0 && copyH > 0) {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: oldTex },
        { texture: this.texture },
        { width: copyW, height: copyH },
      );
      this.device.queue.submit([enc.finish()]);
    }
    // DEFER the destroy to after the GPU drains: `oldTex` may still be referenced by a PREVIOUS frame's
    // in-flight command buffer (the compositor bind group). Destroying it inline throws "Destroyed texture
    // used in a submit" — seen when a rapid resize (e.g. a setDocumentSize thrash) reallocates the doc
    // texture mid-frame. onSubmittedWorkDone resolves once all prior submits (incl. the copy above) complete.
    if (oldTex) this.device.queue.onSubmittedWorkDone().then(() => oldTex.destroy()).catch(() => { /* device lost */ });
    this.blankSince = stillBlank ? { tex: this.texture, seq: rasterContentSeq() } : null;

    return this.texture;
  }

  /** B3: `texture` is still exactly its blank seed — no write of any kind (attributed to it or unattributed) was
   *  reported since. A writer that reports nothing at all is the one hole (the autosave verify read catches those). */
  private isProvablyBlank(): boolean {
    const b = this.blankSince;
    return !!b && b.tex === this.texture && rasterTextureWrittenAt(b.tex) <= b.seq;
  }

  /** D1: `tex` is this manager's texture and provably still blank (see isProvablyBlank) — e.g. cel 1 of a fresh layer
   *  made animated: splitting its hold needs no copy. */
  public isTextureProvablyBlank(tex: GPUTexture | null | undefined): boolean {
    return !!tex && tex === this.texture && this.isProvablyBlank();
  }

  // Initialize with a blank snapshot - call this after creating the texture
  public async initializeWithBlankSnapshot(): Promise<void> {
    if (!this.texture) return;
    
    // Clear texture to transparent
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    markRasterCompositeDirty(null, this.texture);   // BRUSH-5: the texture was cleared (autosave: this texture)

    // Seed the blank state as the initial snapshot so the first stroke is undoable. B3: a BLANK seed — no read-back,
    // no full RAM copy (was 64 MB + ~60–150 ms per new layer at 4096²).
    this.ensureSnapshotMgr().initializeBlank(this.width, this.height);
    this.blankSince = { tex: this.texture, seq: rasterContentSeq() };
  }

  /**
   * A2 (perf audit 2026-10-09): `pixels` (tightly packed RGBA8 of `tex`'s size) were just uploaded into `tex` — this
   * manager's texture or an animation cel's. A history that is still only its seed (or none) is re-seeded from those
   * bytes, BORROWED (no read-back, no copy; the caller must not change them). A document load used to read the seed
   * back BEFORE uploading, so fill / filter / clear then Ctrl+Z restored a blank layer. A history with real entries is
   * left alone. False = not seeded (size mismatch / not pristine).
   */
  public seedHistoryFromPixels(tex: GPUTexture, pixels: ArrayBuffer | Uint8Array): boolean {
    const w = tex.width, h = tex.height;
    const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    if (!w || !h || bytes.length !== w * h * 4) return false;
    if (tex === this.texture) {
      if (this.snapshotMgr && !this.snapshotMgr.isPristine()) return false;
      // a NEW stack: a read-back re-seed still in flight (reseedPristineHistory) lands in the dropped one
      const mgr = new RasterSnapshotManager(this.device);
      mgr.initializeFromPixels(w, h, bytes);
      this.snapshotMgr?.destroy();
      this.snapshotMgr = mgr;
      this.blankSince = null;
      return true;
    }
    const prev = this.celHistories.get(tex);
    if (prev && !prev.ready && !prev.mgr.isPristine()) return false;
    const mgr = new RasterSnapshotManager(this.device);
    mgr.initializeFromPixels(w, h, bytes);
    prev?.mgr.destroy();   // (C3: stops counting in the undo budget; a read-back seed still in flight lands in it)
    this.celHistories.set(tex, { mgr, ready: null });
    return true;
  }

  /** A3 / B3: `tex` (an animation cel's texture, not this manager's) is freshly created and blank — seed its history
   *  as BLANK (no read-back). */
  public seedBlankHistory(tex: GPUTexture): void {
    if (tex === this.texture) {
      const mgr = new RasterSnapshotManager(this.device);   // (a read-back seed in flight lands in the dropped one)
      mgr.initializeBlank(tex.width, tex.height);
      this.snapshotMgr?.destroy();
      this.snapshotMgr = mgr;
      this.blankSince = { tex, seq: rasterContentSeq() };
      return;
    }
    const mgr = new RasterSnapshotManager(this.device);
    mgr.initializeBlank(tex.width, tex.height);
    this.celHistories.get(tex)?.mgr.destroy();   // (C3: the replaced history stops counting in the undo budget)
    this.celHistories.set(tex, { mgr, ready: null });
  }

  /** D1: forget `tex`'s history (an animation cel texture made blank again — its texture is freed / reused as a spare).
   *  Never this manager's own texture. */
  public dropHistory(tex: GPUTexture): void {
    if (tex === this.texture) return;
    this.celHistories.get(tex)?.mgr.destroy();
    this.celHistories.delete(tex);
    if (this.historyTex === tex) this.historyTex = null;
  }

  /** D1: `tex` (a cel's) has no history beyond its seed — nothing was pushed (no undo / redo state to keep). */
  public isHistoryPristine(tex: GPUTexture): boolean {
    if (tex === this.texture) return !this.snapshotMgr || this.snapshotMgr.isPristine();
    const h = this.celHistories.get(tex);
    return !h || (!h.ready && h.mgr.isPristine());
  }

  /**
   * A3: the texture undo / redo / pushSnapshot / historyMark act on — the animation cel the layer shows (null or this
   * manager's texture = its own history). `seed` (the selected layer, playback stopped): a cel with no history yet
   * gets one seeded NOW by a read-back (its current pixels), so the first edit on it is undoable; cels made blank /
   * loaded from bytes were seeded already at no cost.
   */
  public setHistoryTarget(tex: GPUTexture | null, opts?: { seed?: boolean }): void {
    this.historyTex = tex && tex !== this.texture ? tex : null;
    const t = this.historyTex;
    if (t && opts?.seed && !this.celHistories.has(t)) {
      const mgr = new RasterSnapshotManager(this.device);
      const entry: TextureHistory = { mgr, ready: null };
      // initialize() submits its read-back synchronously, so it reads the pixels as they are now (before any edit)
      entry.ready = mgr.initialize(t).catch(() => { /* device lost */ }).finally(() => { entry.ready = null; });
      this.celHistories.set(t, entry);
    }
  }

  /** The texture undo currently acts on (A3): the targeted cel, else this manager's texture. */
  public getHistoryTexture(): GPUTexture | null {
    return this.historyTex ?? this.texture ?? null;
  }

  /** Diagnostics / tests: the undo stats of `tex`'s history (default: the current target); null = none. */
  public getHistoryStats(tex?: GPUTexture | null): ReturnType<RasterSnapshotManager['getStats']> | null {
    const t = tex ?? this.getHistoryTexture();
    if (!t) return null;
    if (t === this.texture) return this.snapshotMgr?.getStats() ?? null;
    return this.celHistories.get(t)?.mgr.getStats() ?? null;
  }

  /** The history for `tex` (this manager's or a cel's), created empty when `create`; awaits a seed in flight. */
  private async historyFor(tex: GPUTexture, create: boolean): Promise<RasterSnapshotManager | null> {
    if (tex === this.texture) return create ? this.ensureSnapshotMgr() : (this.snapshotMgr ?? null);
    let h = this.celHistories.get(tex);
    if (!h) {
      if (!create) return null;
      h = { mgr: new RasterSnapshotManager(this.device), ready: null };
      this.celHistories.set(tex, h);
    }
    if (h.ready) await h.ready;
    return this.celHistories.get(tex)?.mgr ?? null;
  }

  /**
   * After a size change (the owner calls it when ensureTexture reallocated): a history that is still only its
   * blank seed — nothing drawn yet, e.g. a new document sized right after its layers were made at the window size —
   * is re-seeded from the texture at the NEW size. Undoing the first stroke used to restore the old-size seed,
   * reallocating the layer to the window size, and the next stroke painted a destroyed texture. A history with real
   * entries is kept (undo across a resize stays possible). A seed still in flight lands in the discarded stack.
   */
  public async reseedPristineHistory(): Promise<boolean> {
    const mgr = this.snapshotMgr;
    if (!mgr || !this.texture || this.width === 0 || this.height === 0) return false;
    if (!mgr.isPristine()) return false;
    // B3: a blank seed on a texture nothing has written stays a BLANK seed at the new size (no read-back)
    if (mgr.seedKind() === 'blank' && this.isProvablyBlank()) {
      mgr.initializeBlank(this.width, this.height);
      return true;
    }
    mgr.destroy();
    this.snapshotMgr = new RasterSnapshotManager(this.device);
    await this.snapshotMgr.initialize(this.texture);
    return true;
  }

  // Expose current texture size
  public getTextureSize(): { w: number, h: number } {
    return { w: this.width, h: this.height };
  }

  /** The current backing GPU texture (null until ensureTexture runs). */
  public getTexture(): GPUTexture | null {
    return this.texture ?? null;
  }

  /** Capture the current texture onto the undo stack (dedup + 40ms coalescing — see RasterSnapshotManager). */
  public async pushSnapshot(opts?: { noCoalesce?: boolean }): Promise<void> {
    if (!this.texture || this.width === 0 || this.height === 0) return;
    const cel = this.historyTex;
    if (cel) { await (await this.historyFor(cel, true))?.pushSnapshot(cel, undefined, opts); return; }   // A3
    this.blankSince = null;
    await this.ensureSnapshotMgr().pushSnapshot(this.texture, undefined, opts);
  }

  /** The undo history's current / redo entry tokens (see RasterSnapshotManager.historyMark) — of the targeted cel's
   *  history when one is targeted (A3); null before any push. */
  public historyMark(): { top: object | null; next: object | null } | null {
    const cel = this.historyTex;
    if (cel) return this.celHistories.get(cel)?.mgr.historyMark() ?? null;
    return this.snapshotMgr ? this.snapshotMgr.historyMark() : null;
  }

  /** BRUSH-6: push a brush stroke's rect undo patch (see RasterSnapshotManager.pushPatch). `texture` is the
   *  texture the stroke painted: this manager's, or (A3) the targeted / a known cel's — its own history gets the
   *  patch. Any other texture falls back to a full pushSnapshot of the current target. */
  public async pushStrokePatch(texture: GPUTexture, patch: RasterRectPatch): Promise<void> {
    if (!this.texture || this.width === 0 || this.height === 0) return;
    if (texture !== this.texture) {
      if (texture !== this.historyTex && !this.celHistories.has(texture)) return this.pushSnapshot();
      await (await this.historyFor(texture, true))?.pushPatch(texture, patch);
      return;
    }
    this.blankSince = null;
    await this.ensureSnapshotMgr().pushPatch(this.texture, patch);
  }

  public async undo(): Promise<boolean> {
    if (!this.texture) return false;
    const cel = this.historyTex;
    if (cel) { const m = await this.historyFor(cel, false); return m ? m.undo(cel) : false; }   // A3 (no resize hook)
    if (!this.snapshotMgr) return false;
    this.blankSince = null;
    // resize hook: a snapshot may predate a document resize — reallocate to its dimensions first
    // (the old inline restore called ensureTexture(w, h) the same way).
    return this.snapshotMgr.undo(this.texture, (w, h) => this.ensureTexture(w, h));
  }

  public async redo(): Promise<boolean> {
    if (!this.texture) return false;
    const cel = this.historyTex;
    if (cel) { const m = await this.historyFor(cel, false); return m ? m.redo(cel) : false; }   // A3
    if (!this.snapshotMgr) return false;
    this.blankSince = null;
    return this.snapshotMgr.redo(this.texture, (w, h) => this.ensureTexture(w, h));
  }

  /**
   * Read the current GPU texture back into a tightly-packed RGBA buffer.
   * Shared by exportToBlob() (persistence) and readToCanvas() (live UV-pane
   * display). Returns null when there is no texture to read.
   */
  private async _readbackRGBA() {
    if (!this.texture) return null;
    const w = this.width, h = this.height;
    if (w === 0 || h === 0) return null;

    const padded = Math.ceil((w * 4) / 256) * 256;
    const readBuf = this.device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: readBuf, bytesPerRow: padded, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);

    const src = new Uint8Array(readBuf.getMappedRange());
    const rgba = new Uint8ClampedArray(w * h * 4);
    let dst = 0;
    for (let y = 0; y < h; y++) {
      const row = y * padded;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        // Source texture is rgba8unorm; copy directly.
        rgba[dst++] = src[i + 0];
        rgba[dst++] = src[i + 1];
        rgba[dst++] = src[i + 2];
        rgba[dst++] = src[i + 3];
      }
    }
    readBuf.unmap();
    readBuf.destroy();
    return { rgba, w, h };
  }

  // Export current texture as an image Blob (PNG/WebP). Useful for persistence.
  public async exportToBlob(type: 'image/png' | 'image/webp' = 'image/webp'): Promise<Blob> {
    const back = await this._readbackRGBA();
    if (!back) return new Blob();
    const { rgba, w, h } = back;

    const fullCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });

    const ctx = (fullCanvas as any).getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2D context unavailable');
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);

    if ('convertToBlob' in fullCanvas) {
      return await (fullCanvas as OffscreenCanvas).convertToBlob({ type });
    }
    return await new Promise<Blob>(res => (fullCanvas as HTMLCanvasElement).toBlob(b => res(b!), type));
  }

  /**
   * Blit the current texture into a provided 2D canvas (resized to match).
   * Lets the UV paint controller show live paint as the UV-editor background
   * each (throttled) frame without an async createImageBitmap round-trip.
   */
  public async readToCanvas(target: HTMLCanvasElement | OffscreenCanvas, rect?: { x: number; y: number; w: number; h: number } | null): Promise<void> {
    // S3 (mobile-parity 7.3b): the live UV-pane preview runs this several times a second while painting. It reuses
    // ONE MAP_READ buffer and ONE full-size ImageData, reads back only `rect` when given (the stroke's region — the
    // rest of `target` already shows the texture), and copies the rows with one `set` when the padded row pitch
    // equals the tight one (row-wise sets otherwise) instead of a per-pixel JS loop.
    const tex = this.texture;
    const w = this.width, h = this.height;
    if (!tex || w === 0 || h === 0) return;
    const resized = target.width !== w || target.height !== h;
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    // A resized canvas was cleared → the whole texture. Otherwise clamp the rect (null / empty = the whole texture).
    let x = 0, y = 0, rw = w, rh = h;
    if (rect && !resized) {
      x = Math.max(0, Math.floor(rect.x)); y = Math.max(0, Math.floor(rect.y));
      rw = Math.min(w, Math.ceil(rect.x + rect.w)) - x; rh = Math.min(h, Math.ceil(rect.y + rect.h)) - y;
      if (rw <= 0 || rh <= 0) return;
    }
    const row = rw * 4;
    const padded = Math.ceil(row / 256) * 256;
    const bytes = padded * rh;
    // One reusable buffer (sized for the whole texture); a second read while it's mapped gets a temporary one.
    const fullBytes = Math.ceil((w * 4) / 256) * 256 * h;
    let buf: GPUBuffer;
    const reuse = !this._paneReadBusy;
    if (reuse) {
      if (!this._paneReadBuf || this._paneReadBufSize < fullBytes) {
        this._paneReadBuf?.destroy();
        this._paneReadBuf = this.device.createBuffer({ size: fullBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        this._paneReadBufSize = fullBytes;
      }
      buf = this._paneReadBuf;
      this._paneReadBusy = true;
    } else {
      buf = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex, origin: { x, y } },
        { buffer: buf, bytesPerRow: padded, rowsPerImage: rh },
        { width: rw, height: rh, depthOrArrayLayers: 1 },
      );
      this.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ, 0, bytes);
      const src = new Uint8Array(buf.getMappedRange(0, bytes));
      let img = this._paneImage;
      if (!img || img.width !== w || img.height !== h) img = this._paneImage = new ImageData(w, h);
      const dst = img.data;
      const fullRow = w * 4;
      if (x === 0 && rw === w && padded === row) {
        dst.set(src.subarray(0, row * rh), y * fullRow);
      } else {
        for (let r = 0; r < rh; r++) dst.set(src.subarray(r * padded, r * padded + row), (y + r) * fullRow + x * 4);
      }
      buf.unmap();
      const ctx = (target as any).getContext('2d') as CanvasRenderingContext2D | null;
      if (ctx) ctx.putImageData(img, 0, 0, x, y, rw, rh);
    } finally {
      if (reuse) this._paneReadBusy = false;
      else buf.destroy();
    }
  }
  /** readToCanvas's reusable MAP_READ buffer + full-size ImageData (see S3 above). */
  private _paneReadBuf?: GPUBuffer;
  private _paneReadBufSize = 0;
  private _paneReadBusy = false;
  private _paneImage: ImageData | null = null;

  private ensureStagingBuffer(minSize: number) {
    if (this.stagingBuffer && this.stagingSize >= minSize) return;
    this.stagingBuffer?.destroy();
    this.stagingSize = Math.max(minSize, 256);
    this.stagingBuffer = this.device.createBuffer({ size: this.stagingSize, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  // Upload either full buffer or dirty rect from RasterCanvas
  uploadRasterCanvas(raster: RasterCanvas) {
    const w = raster.width, h = raster.height;
    const tex = this.ensureTexture(w, h);
    const srcBuf = raster.getBuffer();

    // If the canvas has a dirty rect, upload only that region (padded rows to 256 bytes).
    let dirty = raster.consumeDirtyRect();
    if (!dirty) {
      // No dirty rect: treat as full-canvas upload (useful for imports where dirty isn't set)
      dirty = { x: 0, y: 0, w: w, h: h } as any;
    }
    // Narrow type for TS (we have ensured dirty is set above)
    const nd = dirty!;

    const bytesPerPixel = 4;

    // Upload the dirty rect with 256-byte-aligned rows (required for copyBufferToTexture compatibility)
  const rectW = nd.w, rectH = nd.h;
    const unpaddedRow = rectW * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;

    const totalBytes = paddedRow * rectH;
    this.ensureStagingBuffer(totalBytes);

    // Fill the reusable cpu staging buffer
    if (!this.cpuStaging || this.cpuStaging.length < totalBytes) this.cpuStaging = new Uint8Array(totalBytes);
    const tmp = this.cpuStaging;
    for (let row = 0; row < rectH; row++) {
  const srcRowStart = ((nd.y + row) * w + nd.x) * bytesPerPixel;
      const srcSlice = srcBuf.subarray(srcRowStart, srcRowStart + unpaddedRow);
      tmp.set(srcSlice, row * paddedRow);
    }

    // Use chunked writes to avoid large single-buffer limits
    const MAX_CHUNK = 4 * 1024 * 1024; // 4MB
    let off = 0;
    while (off < totalBytes) {
      const chunk = Math.min(MAX_CHUNK, totalBytes - off);
      this.device.queue.writeBuffer(this.stagingBuffer!, off, tmp as any, off, chunk);
      off += chunk;
    }

    // copy staging buffer -> texture with padded row pitch using a short command encoder
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: this.stagingBuffer!, bytesPerRow: paddedRow },
  { texture: tex, mipLevel: 0, origin: { x: nd.x, y: nd.y, z: 0 } },
      { width: rectW, height: rectH, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([enc.finish()]);
    markRasterCompositeDirty({ x0: nd.x, y0: nd.y, x1: nd.x + rectW, y1: nd.y + rectH }, tex);   // BRUSH-5

    return tex;
  }

  destroy() {
    this.texture?.destroy();
    this.texture = undefined;
    this.stagingBuffer?.destroy();
    this.stagingBuffer = undefined;
    if (!this._paneReadBusy) this._paneReadBuf?.destroy();   // (a read in flight unmaps it; the device frees it later)
    this._paneReadBuf = undefined; this._paneReadBufSize = 0; this._paneImage = null;
    this.snapshotMgr?.destroy();
    this.snapshotMgr = undefined;
    this.historyTex = null; this.celHistories = new WeakMap(); this.blankSince = null;
  }
}