import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { RasterCanvas } from '../renderer/raster/raster-canvas';
import { LayerBlendMode } from '../renderer/raster/core/raster-compositor';
import { DitherConfig } from '../renderer/raster/effects/dither-engine';
import { AnimationTimeline, OnionSkinConfig, type FrameLinkAnimation } from '../animation';

function makeId() { return 'r_' + Math.random().toString(36).slice(2,9); }

export type RasterLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  blendMode: LayerBlendMode;
  opacity: number;            // 0-1, per-layer opacity for compositing
  clipped: boolean;           // clip to alpha of the layer below
  lockTransparency: boolean;  // paint only where alpha > 0
  texture?: GPUTexture | undefined;
  manager: RasterTextureManager;
  /** Optional per-layer dither configuration. */
  ditherConfig?: DitherConfig;
  /** Optional per-layer procedural displacement animation. */
  frameLinkAnimation?: FrameLinkAnimation;
};

export class RasterLayerManager {
  private device: GPUDevice;
  private layers: RasterLayer[] = [];
  private width: number = 0;
  private height: number = 0;
  private selectedLayerId: string | null = null;
  // optional callback to notify renderer of composition list changes
  private compositionCallback?: (list: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>) => void;
  // optional callback when selected layer changes (so renderer can update paint target)
  private selectionCallback?: (layerTexture: GPUTexture | null, layerManager: RasterTextureManager | null) => void;

  // ── Animation ───────────────────────────────────────────────────
  private timeline: AnimationTimeline;
  private animationEnabled = false;

  constructor(device: GPUDevice, width = 1024, height = 768, compositionCallback?: (list: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>) => void, selectionCallback?: (layerTexture: GPUTexture | null, layerManager: RasterTextureManager | null) => void) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.compositionCallback = compositionCallback;
    this.selectionCallback = selectionCallback;

    // Initialize animation timeline (defaults to 1 frame = static illustration)
    this.timeline = new AnimationTimeline(12, 1);
    this.timeline.on((event) => {
      if (event.type === 'frame-changed') {
        this.onFrameChanged();
      }
    });

    // Seed a default base layer
    this.addLayer('Background');
    // Auto-select the first layer
    if (this.layers.length > 0) {
      this.selectedLayerId = this.layers[0].id;
    }
  }

  public setSize(w: number, h: number) {
    this.width = w; this.height = h;
    // resize all existing layer textures
    for (const layer of this.layers) {
      layer.manager.ensureTexture(w, h);
      layer.texture = layer.manager.ensureTexture(w, h);
    }
  this.notifyCompositionChanged();
  }

  public getLayers() { return this.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, lockTransparency: l.lockTransparency })); }

  public addLayer(name: string = 'Layer') {
    const id = makeId();
    const manager = new RasterTextureManager(this.device);
    manager.ensureTexture(this.width, this.height);
    manager.initializeWithBlankSnapshot?.();
    const texture = manager.ensureTexture(this.width, this.height);
    const layer: RasterLayer = { id, name, visible: true, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false, texture, manager };
    this.layers.push(layer);
    this.timeline.registerLayer(id);
  this.notifyCompositionChanged();
  return { id, name, visible: true, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false };
  }

  /**
   * Create a layer with a specific ID and metadata.
   * Used by the persistence engine to restore saved layers.
   */
  public addLayerWithId(
    id: string,
    name: string,
    opts: {
      visible?: boolean;
      locked?: boolean;
      blendMode?: LayerBlendMode;
      opacity?: number;
      clipped?: boolean;
      lockTransparency?: boolean;
      ditherConfig?: DitherConfig;
      frameLinkAnimation?: FrameLinkAnimation;
    } = {},
  ) {
    // Don't create a duplicate if a layer with this ID already exists
    if (this.layers.find(l => l.id === id)) return;
    const manager = new RasterTextureManager(this.device);
    manager.ensureTexture(this.width, this.height);
    manager.initializeWithBlankSnapshot?.();
    const texture = manager.ensureTexture(this.width, this.height);
    const layer: RasterLayer = {
      id,
      name,
      visible: opts.visible ?? true,
      locked: opts.locked ?? false,
      blendMode: opts.blendMode ?? LayerBlendMode.Normal,
      opacity: opts.opacity ?? 1.0,
      clipped: opts.clipped ?? false,
      lockTransparency: opts.lockTransparency ?? false,
      texture,
      manager,
      ditherConfig: opts.ditherConfig ? { ...opts.ditherConfig } : undefined,
      frameLinkAnimation: opts.frameLinkAnimation ? { ...opts.frameLinkAnimation } : undefined,
    };
    this.layers.push(layer);
    this.timeline.registerLayer(id);
    this.notifyCompositionChanged();
  }

  /**
   * Remove ALL layers. Used before restoring a full document.
   */
  public clearAllLayers(): void {
    for (const l of this.layers) {
      l.manager.destroy();
      this.timeline.unregisterLayer(l.id);
    }
    this.layers = [];
    this.selectedLayerId = null;
    this.notifyCompositionChanged();
  }

  public deleteLayer(id: string) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx < 0) return false;
    const [removed] = this.layers.splice(idx, 1);
    removed.manager.destroy();
    this.timeline.unregisterLayer(id);
  this.notifyCompositionChanged();
    return true;
  }

  public selectLayer(id: string): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    this.selectedLayerId = id;
    // Notify renderer so it can point the paint engine at this layer's texture
    this.selectionCallback?.(l.texture ?? null, l.manager);
    return true;
  }

  /** Get the currently selected layer's id. */
  public getSelectedLayerId(): string | null {
    return this.selectedLayerId;
  }

  /** Get the currently selected layer's GPU texture (for painting). */
  public getSelectedLayerTexture(): GPUTexture | null {
    if (!this.selectedLayerId) return null;
    const l = this.layers.find(x => x.id === this.selectedLayerId);
    return l?.texture ?? null;
  }

  /** Get the currently selected layer's RasterTextureManager (for legacy dispatchGpuBrush). */
  public getSelectedLayerManager(): RasterTextureManager | null {
    if (!this.selectedLayerId) return null;
    const l = this.layers.find(x => x.id === this.selectedLayerId);
    return l?.manager ?? null;
  }

  /** Set the selection callback (called when active layer changes). */
  public setSelectionCallback(cb: (layerTexture: GPUTexture | null, layerManager: RasterTextureManager | null) => void) {
    this.selectionCallback = cb;
  }

  public setVisibility(id: string, visible: boolean) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.visible = visible;
    this.notifyCompositionChanged();
    return true;
  }

  public setBlendMode(id: string, mode: LayerBlendMode) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.blendMode = mode;
    this.notifyCompositionChanged();
    return true;
  }

  public setOpacity(id: string, opacity: number) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.opacity = Math.max(0, Math.min(1, opacity));
    this.notifyCompositionChanged();
    return true;
  }

  public setClipping(id: string, clipped: boolean) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.clipped = clipped;
    this.notifyCompositionChanged();
    return true;
  }

  public setLockTransparency(id: string, locked: boolean) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.lockTransparency = locked;
    // No composition change needed — this only affects painting
    return true;
  }

  /** Set a per-layer dither configuration. Pass undefined/null to remove. */
  public setLayerDitherConfig(id: string, config: DitherConfig | undefined): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.ditherConfig = config ? { ...config } : undefined;
    this.notifyCompositionChanged();
    return true;
  }

  /** Get the current per-layer dither configuration (copy), or undefined if not set. */
  public getLayerDitherConfig(id: string): DitherConfig | undefined {
    const l = this.layers.find(x => x.id === id);
    return l?.ditherConfig ? { ...l.ditherConfig } : undefined;
  }

  /** Set or clear the per-layer frame link animation config. */
  public setLayerFrameLinkAnimation(id: string, config: FrameLinkAnimation | undefined): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.frameLinkAnimation = config ? { ...config } : undefined;
    this.notifyCompositionChanged();
    return true;
  }

  /** Get the current per-layer frame link animation config (copy), or undefined. */
  public getLayerFrameLinkAnimation(id: string): FrameLinkAnimation | undefined {
    const l = this.layers.find(x => x.id === id);
    return l?.frameLinkAnimation ? { ...l.frameLinkAnimation } : undefined;
  }

  public reorderLayers(orderedIds: string[]) {
    const reordered: RasterLayer[] = [];
    for (const id of orderedIds) {
      const l = this.layers.find(x => x.id === id);
      if (l) reordered.push(l);
    }
    // Append any layers not mentioned in the order (shouldn't happen, but safety)
    for (const l of this.layers) {
      if (!reordered.includes(l)) reordered.push(l);
    }
    this.layers = reordered;
    this.notifyCompositionChanged();
  }


  public getTextureForComposition() {
    // return ordered array of textures (bg -> top) for the renderer to composite
    return this.layers.map(l => ({ id: l.id, texture: l.texture, visible: l.visible, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, ditherConfig: l.ditherConfig, frameLinkAnimation: l.frameLinkAnimation }));
  }

  // Find the internal layer by id
  public getLayerById(id: string) {
    return this.layers.find(l => l.id === id);
  }

  // Import a RasterCanvas into an existing layer by id
  public async importRasterCanvasToLayer(id: string, rasterCanvas: RasterCanvas) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    // ensure manager texture matches raster size
    l.manager.ensureTexture(rasterCanvas.width, rasterCanvas.height);
    l.manager.uploadRasterCanvas(rasterCanvas as any);
    // wait for GPU work to finish before pushing snapshot
    await this.device.queue.onSubmittedWorkDone();
    // push snapshot so undo/redo reflects imported pixels
    l.manager.pushSnapshot?.();
    l.texture = l.manager.ensureTexture(rasterCanvas.width, rasterCanvas.height);
    // notify and select the layer
    this.notifyCompositionChanged();
    this.selectLayer(id);
    return true;
  }

  // Create a new layer and seed it from a RasterCanvas
  public async createLayerFromRasterCanvas(name: string, rasterCanvas: RasterCanvas) {
    const id = makeId();
    const manager = new RasterTextureManager(this.device);
    manager.ensureTexture(rasterCanvas.width, rasterCanvas.height);
    // upload pixel data
    manager.uploadRasterCanvas(rasterCanvas as any);
    // wait for the GPU to finish copying
    await this.device.queue.onSubmittedWorkDone();
    // seed snapshot history for the new manager
    manager.pushSnapshot?.();
    const texture = manager.ensureTexture(rasterCanvas.width, rasterCanvas.height);
    const layer: RasterLayer = { id, name, visible: true, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false, texture, manager };
    this.layers.push(layer);
    this.notifyCompositionChanged();
    this.selectLayer(id);
    return { id, name, visible: true, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false };
  }

  // Export all layers as blobs (ordered back-to-front). Returns array of { id, name, visible, blob, width, height }
  public async exportLayersAsBlobs(type: 'image/webp' | 'image/png' = 'image/webp') {
    const out: Array<{ id: string; name: string; visible: boolean; blob?: Blob; width: number; height: number }> = [];
    for (const l of this.layers) {
      try {
        const blob = await l.manager.exportToBlob(type);
        out.push({ id: l.id, name: l.name, visible: l.visible, blob, width: l.manager.getTextureSize().w, height: l.manager.getTextureSize().h });
      } catch (e) {
        console.warn('exportLayersAsBlobs failed for layer', l.id, e);
        out.push({ id: l.id, name: l.name, visible: l.visible, blob: undefined, width: l.manager.getTextureSize().w, height: l.manager.getTextureSize().h });
      }
    }
    return out;
  }

  // Export all layers as data URLs (Base64). Uses exportLayersAsBlobs internally.
  public async exportLayersAsDataURLs(type: 'image/webp' | 'image/png' = 'image/webp') {
    const blobs = await this.exportLayersAsBlobs(type);
    const results: Array<{ id: string; name: string; visible: boolean; dataUrl?: string; width: number; height: number }> = [];
    for (const b of blobs) {
      if (!b.blob) {
        results.push({ id: b.id, name: b.name, visible: b.visible, dataUrl: undefined, width: b.width, height: b.height });
        continue;
      }
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result as string);
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(b.blob!);
      });
      results.push({ id: b.id, name: b.name, visible: b.visible, dataUrl, width: b.width, height: b.height });
    }
    return results;
  }

  // Per-layer snapshot/undo helpers
  public pushSnapshotForLayer(id: string) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.manager.pushSnapshot?.();
    return true;
  }

  public async undoForLayer(id: string) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    const ok = await l.manager.undo?.();
    if (ok) this.notifyCompositionChanged();
    return ok;
  }

  public async redoForLayer(id: string) {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    const ok = await l.manager.redo?.();
    if (ok) this.notifyCompositionChanged();
    return ok;
  }

  private notifyCompositionChanged() {
    if (!this.compositionCallback) return;
    this.compositionCallback(this.getTextureForComposition());
  }

  // ── Animation API ─────────────────────────────────────────────────

  /** Get the animation timeline instance. */
  public getTimeline(): AnimationTimeline {
    return this.timeline;
  }

  /** Enable or disable animation mode. When enabled, layers can have per-frame cels. */
  public setAnimationEnabled(enabled: boolean): void {
    this.animationEnabled = enabled;
    if (enabled && this.timeline.getFrameCount() < 2) {
      // Start with a reasonable frame count when animation is first enabled
      this.timeline.setFrameCount(24);
    }
  }

  public isAnimationEnabled(): boolean {
    return this.animationEnabled;
  }

  /**
   * Convert a layer to animated (multi-frame) mode.
   * The layer's current texture becomes the first cel.
   */
  public setLayerAnimated(layerId: string, animated: boolean): boolean {
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer) return false;

    this.timeline.registerLayer(layerId);
    this.timeline.setLayerAnimationType(
      layerId,
      animated ? 'animated' : 'static',
      animated ? layer.texture : undefined,
    );
    return true;
  }

  /** Check if a layer is in animated mode. */
  public isLayerAnimated(layerId: string): boolean {
    return this.timeline.isLayerAnimated(layerId);
  }

  /**
   * Add a new blank cel at the current frame for the specified layer.
   * Returns the cel id, or null if the layer isn't animated.
   */
  public addCelAtCurrentFrame(layerId: string): string | null {
    const cel = this.timeline.addCel(
      layerId,
      this.timeline.getCurrentFrame(),
      this.device,
      this.width,
      this.height,
    );
    if (cel) {
      this.onFrameChanged(); // update displayed texture
      return cel.id;
    }
    return null;
  }

  /**
   * Add a new blank cel at a specific frame for the specified layer.
   */
  public addCelAtFrame(layerId: string, frame: number): string | null {
    const cel = this.timeline.addCel(
      layerId,
      frame,
      this.device,
      this.width,
      this.height,
    );
    if (cel) {
      this.onFrameChanged();
      return cel.id;
    }
    return null;
  }

  /** Delete a cel from an animated layer. */
  public deleteCel(layerId: string, celId: string): boolean {
    const result = this.timeline.deleteCel(layerId, celId);
    if (result) this.onFrameChanged();
    return result;
  }

  /**
   * Force texture swap for the current frame. Call after bulk operations
   * (e.g. document restore) that create animated layers and upload cels
   * without triggering frame-changed events.
   */
  public forceFrameSync(): void {
    if (!this.animationEnabled) return;
    const frame = this.timeline.getCurrentFrame();

    for (const layer of this.layers) {
      const celTexture = this.timeline.getTextureAtFrame(layer.id, frame);
      if (celTexture === undefined) continue; // static layer
      if (celTexture === null) {
        layer.texture = undefined;
      } else {
        layer.texture = celTexture;
      }
    }

    // Update selected layer paint target
    if (this.selectedLayerId) {
      const selected = this.layers.find(l => l.id === this.selectedLayerId);
      if (selected && this.timeline.isLayerAnimated(selected.id)) {
        this.selectionCallback?.(selected.texture ?? null, selected.manager);
      }
    }

    this.notifyCompositionChanged();
  }

  /**
   * Called when the current frame changes.
   * Swaps textures for animated layers so the compositor sees the correct cel.
   */
  private onFrameChanged(): void {
    if (!this.animationEnabled) return;

    const frame = this.timeline.getCurrentFrame();

    for (const layer of this.layers) {
      const celTexture = this.timeline.getTextureAtFrame(layer.id, frame);

      if (celTexture === undefined) {
        // Static layer — keep the existing texture (no change needed)
        continue;
      }

      if (celTexture === null) {
        // Blank frame — hide the layer for this frame by setting texture to undefined
        // (the compositor skips layers without textures)
        layer.texture = undefined;
      } else {
        // Animated frame — swap to the cel's texture
        layer.texture = celTexture;
      }
    }

    // Update the selected layer's paint target if it's animated
    if (this.selectedLayerId) {
      const selected = this.layers.find(l => l.id === this.selectedLayerId);
      if (selected && this.timeline.isLayerAnimated(selected.id)) {
        this.selectionCallback?.(selected.texture ?? null, selected.manager);
      }
    }

    this.notifyCompositionChanged();
  }

  /**
   * Get textures for all animated layers at a specific frame.
   * Used by the onion skin renderer and animation exporter.
   */
  public getLayerTexturesAtFrame(frame: number): Map<string, GPUTexture | null> {
    const result = new Map<string, GPUTexture | null>();
    for (const layer of this.layers) {
      const celTexture = this.timeline.getTextureAtFrame(layer.id, frame);
      if (celTexture === undefined) {
        // Static layer — use main texture
        result.set(layer.id, layer.texture ?? null);
      } else {
        result.set(layer.id, celTexture);
      }
    }
    return result;
  }

  /** Get onion skin configuration. */
  public getOnionSkinConfig(): OnionSkinConfig {
    return this.timeline.getOnionSkinConfig();
  }

  /** Update onion skin configuration. */
  public setOnionSkinConfig(config: Partial<OnionSkinConfig>): void {
    this.timeline.setOnionSkinConfig(config);
  }

  // ── Cel duplication / copy / move ─────────────────────────────────

  /**
   * Duplicate a cel to a target frame (copies pixel data).
   * Returns the new cel id, or null.
   */
  public duplicateCel(layerId: string, celId: string, targetFrame: number): string | null {
    const cel = this.timeline.duplicateCel(layerId, celId, targetFrame, this.device);
    if (cel) {
      this.onFrameChanged();
      return cel.id;
    }
    return null;
  }

  /**
   * Move a cel to a different frame (no pixel copy, just reposition).
   */
  public moveCel(layerId: string, celId: string, targetFrame: number): boolean {
    const result = this.timeline.moveCel(layerId, celId, targetFrame);
    if (result) this.onFrameChanged();
    return result;
  }

  /**
   * Swap two cels' positions.
   */
  public swapCels(layerId: string, celIdA: string, celIdB: string): boolean {
    const result = this.timeline.swapCels(layerId, celIdA, celIdB);
    if (result) this.onFrameChanged();
    return result;
  }

  /** Set the hold duration for a cel. */
  public setCelDuration(layerId: string, celId: string, duration: number): boolean {
    return this.timeline.setCelDuration(layerId, celId, duration);
  }

  /** Mark a cel as key or inbetween. */
  public setCelType(layerId: string, celId: string, type: 'key' | 'inbetween'): boolean {
    return this.timeline.setCelType(layerId, celId, type);
  }

  /** Get all cels for a layer (for timeline UI rendering). */
  public getCels(layerId: string): Array<{ id: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }> {
    return this.timeline.getCels(layerId).map(c => ({
      id: c.id,
      startFrame: c.startFrame,
      duration: c.duration,
      celType: c.celType,
    }));
  }

  /** Get the GPUDevice (needed by flood fill and other tools). */
  public getDevice(): GPUDevice {
    return this.device;
  }

  /** Get canvas dimensions. */
  public getCanvasSize(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }

  // ── Pixel readback (for persistence) ──────────────────────────────

  /**
   * Read raw RGBA pixel data from a GPU texture.
   * Returns an ArrayBuffer of width * height * 4 bytes (RGBA8).
   */
  public async readTexturePixels(texture: GPUTexture): Promise<ArrayBuffer> {
    const w = texture.width;
    const h = texture.height;
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: buf, bytesPerRow, rowsPerImage: h },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());

    // Copy to a tightly packed buffer (remove row padding)
    const result = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      result.set(
        mapped.subarray(row * bytesPerRow, row * bytesPerRow + w * 4),
        row * w * 4,
      );
    }
    buf.unmap();
    buf.destroy();
    return result.buffer;
  }

  /**
   * Export all layer pixel data as raw RGBA buffers.
   * Used by the persistence engine for fast binary saves.
   */
  public async exportLayerPixels(): Promise<Array<{ id: string; pixelData: ArrayBuffer }>> {
    const out: Array<{ id: string; pixelData: ArrayBuffer }> = [];
    for (const l of this.layers) {
      if (!l.texture) continue;
      const pixels = await this.readTexturePixels(l.texture);
      out.push({ id: l.id, pixelData: pixels });
    }
    return out;
  }

  /**
   * Export all animation cel pixel data as raw RGBA buffers.
   */
  public async exportCelPixels(): Promise<Array<{ celId: string; pixelData: ArrayBuffer }>> {
    const out: Array<{ celId: string; pixelData: ArrayBuffer }> = [];
    for (const layer of this.layers) {
      const cels = this.timeline.getCels(layer.id);
      for (const cel of cels) {
        if (!cel.texture) continue;
        const pixels = await this.readTexturePixels(cel.texture);
        out.push({ celId: cel.id, pixelData: pixels });
      }
    }
    return out;
  }

  /**
   * Get full layer metadata for persistence (everything except pixel data).
   */
  public getLayerMetadata(): Array<{
    id: string; name: string; visible: boolean; locked: boolean;
    opacity: number; blendMode: string; clipped: boolean; lockTransparency: boolean;
    animationType: 'static' | 'animated';
    celIds: string[];
    ditherConfig?: DitherConfig;
    frameLinkAnimation?: FrameLinkAnimation;
  }> {
    return this.layers.map(l => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity ?? 1,
      blendMode: (l as any).blendMode ?? 'normal',
      clipped: (l as any).clipped ?? false,
      lockTransparency: (l as any).lockTransparency ?? false,
      animationType: this.timeline.isLayerAnimated(l.id) ? 'animated' as const : 'static' as const,
      celIds: this.timeline.getCels(l.id).map(c => c.id),
      ditherConfig: l.ditherConfig ? { ...l.ditherConfig } : undefined,
      frameLinkAnimation: l.frameLinkAnimation ? { ...l.frameLinkAnimation } : undefined,
    }));
  }

  /**
   * Upload raw RGBA pixel data to a specific animation cel's texture.
   * Used by the persistence engine to restore cel pixel data.
   */
  public uploadPixelsToCel(layerId: string, celId: string, pixels: ArrayBuffer): boolean {
    const cels = this.timeline.getCels(layerId);
    const cel = cels.find(c => c.id === celId);
    if (!cel?.texture) return false;
    const w = cel.texture.width;
    const h = cel.texture.height;
    this.device.queue.writeTexture(
      { texture: cel.texture },
      pixels,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
    return true;
  }

  /**
   * Restore cels for an animated layer from saved metadata.
   * Clears existing cels (from setLayerAnimated default), creates cels with specific IDs/timing.
   * Returns the created cel IDs for pixel data upload.
   */
  public restoreLayerCels(
    layerId: string,
    celMetas: Array<{ celId: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }>,
  ): string[] {
    // First, clear the auto-created default cel from setLayerAnimated
    const existingCels = this.timeline.getCels(layerId);
    for (const c of existingCels) {
      this.timeline.deleteCel(layerId, c.id);
    }

    // Create each cel with the saved ID and timing
    const created: string[] = [];
    for (const meta of celMetas) {
      const texture = this.device.createTexture({
        size: [this.width, this.height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const cel = this.timeline.addCelWithId(
        layerId, meta.celId, meta.startFrame, meta.duration, meta.celType, texture,
      );
      if (cel) created.push(cel.id);
    }
    return created;
  }

  /**
   * Upload raw RGBA pixel data to an existing layer's texture.
   * Used by the persistence engine to restore layer state.
   */
  public uploadPixelsToLayer(layerId: string, pixels: ArrayBuffer): boolean {
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer?.texture) return false;
    const w = layer.texture.width;
    const h = layer.texture.height;
    this.device.queue.writeTexture(
      { texture: layer.texture },
      pixels,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
    return true;
  }
}
