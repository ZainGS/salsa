import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { RasterCanvas } from '../renderer/raster/raster-canvas';
import { LayerBlendMode } from '../renderer/raster/core/raster-compositor';
import { DitherConfig } from '../renderer/raster/effects/dither-engine';
import { AnimationTimeline, OnionSkinConfig, type FrameLinkAnimation } from '../animation';

function makeId() { return 'r_' + Math.random().toString(36).slice(2,9); }

/** Discriminator for layer stack entry types. */
export type LayerEntryType = 'layer' | 'folder' | '3d-scene' | 'reference';

function blendModeToCompositeOp(mode: LayerBlendMode): GlobalCompositeOperation {
  switch (mode) {
    case LayerBlendMode.Multiply:   return 'multiply';
    case LayerBlendMode.Screen:     return 'screen';
    case LayerBlendMode.Overlay:    return 'overlay';
    case LayerBlendMode.SoftLight:  return 'soft-light';
    case LayerBlendMode.HardLight:  return 'hard-light';
    case LayerBlendMode.ColorDodge: return 'color-dodge';
    case LayerBlendMode.ColorBurn:  return 'color-burn';
    case LayerBlendMode.Darken:     return 'darken';
    case LayerBlendMode.Lighten:    return 'lighten';
    case LayerBlendMode.Difference: return 'difference';
    case LayerBlendMode.Add:        return 'lighter';
    default:                        return 'source-over';
  }
}

/** A paintable raster layer (the original type, now with optional hierarchy fields). */
export type RasterLayer = {
  id: string;
  name: string;
  /** Entry type. Defaults to 'layer' for backward compat. */
  type?: LayerEntryType;
  /** Parent folder ID, or null/undefined for root-level entries. */
  parentId?: string | null;
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
  /** For 'folder' entries: whether the folder is collapsed in the UI. */
  collapsed?: boolean;
};

export class RasterLayerManager {
  private device: GPUDevice;
  private layers: RasterLayer[] = [];
  private width: number = 0;
  private height: number = 0;
  private selectedLayerId: string | null = null;
  // Microtask-debounce flag: prevents N addLayerWithId calls from firing N composition
  // callbacks. All calls within the same sync tick collapse into one deferred notification.
  private _compositionFlushPending = false;
  // optional callback to notify renderer of composition list changes
  private compositionCallback?: (list: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>) => void;
  // optional callback to notify renderer of split (BG/FG) composition list changes
  private compositionSplitCallback?: (
    background: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>,
    foreground: Array<{ id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>,
  ) => void;
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
    const prevW = this.width, prevH = this.height;
    if (prevW !== w || prevH !== h) {
      console.warn(`[RasterLayerManager] setSize ${prevW}x${prevH} → ${w}x${h}, layers=${this.layers.length}`, new Error('setSize stack').stack);
    }
    this.width = w; this.height = h;
    // resize all existing layer textures
    for (const layer of this.layers) {
      if (!layer.manager) continue; // skip 3D dividers and folders (no texture)
      layer.manager.ensureTexture(w, h);
      layer.texture = layer.manager.ensureTexture(w, h);
    }
  this.notifyCompositionChanged();
  }

  public getLayers() { return this.layers.map(l => ({ id: l.id, name: l.name, type: l.type ?? 'layer' as LayerEntryType, parentId: l.parentId ?? null, visible: l.visible, locked: l.locked, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, lockTransparency: l.lockTransparency, collapsed: l.collapsed })); }

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
      parentId?: string | null;
      collapsed?: boolean;
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
      parentId: opts.parentId ?? undefined,
      collapsed: opts.collapsed,
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
      if (l.manager) l.manager.destroy();
      if ((l.type ?? 'layer') === 'layer') this.timeline.unregisterLayer(l.id);
    }
    this.layers = [];
    this.selectedLayerId = null;
    this.notifyCompositionChanged();
  }

  public deleteLayer(id: string) {
    const idx = this.layers.findIndex(l => l.id === id);
    if (idx < 0) return false;
    const [removed] = this.layers.splice(idx, 1);
    if (removed.type === 'folder') {
      // Promote children to the folder's parent
      const folderParent = removed.parentId ?? null;
      for (const l of this.layers) {
        if (l.parentId === id) l.parentId = folderParent;
      }
    } else if (removed.type === '3d-scene') {
      // nothing extra to clean up
    } else {
      removed.manager.destroy();
      this.timeline.unregisterLayer(id);
    }
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

  // ── Layer Folders ─────────────────────────────────────────────────

  /**
   * Create a folder (organizational group) in the layer stack.
   * Folders have no texture — they are purely for UI grouping.
   */
  public addFolder(name = 'Group'): { id: string; name: string; type: LayerEntryType } {
    const id = makeId();
    // Create a lightweight entry — no GPU texture, no RasterTextureManager
    const folder: RasterLayer = {
      id, name, type: 'folder', visible: true, locked: false,
      blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false,
      lockTransparency: false,
      manager: undefined as any,   // folders have no texture manager
      collapsed: false,
    };
    this.layers.push(folder);
    this.notifyCompositionChanged();
    return { id, name, type: 'folder' };
  }

  /** Set whether a folder is collapsed in the UI. */
  public setFolderCollapsed(folderId: string, collapsed: boolean): void {
    const f = this.layers.find(l => l.id === folderId && (l.type === 'folder'));
    if (f) f.collapsed = collapsed;
  }

  /** Move a layer into (or out of) a folder. Pass null to move to root. */
  public setLayerParent(layerId: string, parentId: string | null): void {
    const l = this.layers.find(x => x.id === layerId);
    if (!l) return;
    // Prevent circular references: can't parent a folder to its own descendant
    if (parentId && l.type === 'folder') {
      let check = parentId;
      while (check) {
        if (check === layerId) return; // circular
        const parent = this.layers.find(x => x.id === check);
        check = parent?.parentId ?? null as any;
      }
    }
    l.parentId = parentId;
    this.notifyCompositionChanged();
  }

  /** Delete a folder. Children are reparented to the folder's parent (promoted). */
  public deleteFolder(folderId: string): boolean {
    const folder = this.layers.find(l => l.id === folderId && l.type === 'folder');
    if (!folder) return false;
    const folderParent = folder.parentId ?? null;
    // Promote children
    for (const l of this.layers) {
      if (l.parentId === folderId) l.parentId = folderParent;
    }
    const idx = this.layers.indexOf(folder);
    if (idx >= 0) this.layers.splice(idx, 1);
    this.notifyCompositionChanged();
    return true;
  }

  // ── 3D Divider ────────────────────────────────────────────────────

  /**
   * Insert a 3D scene divider into the layer stack.
   * Raster layers below the divider composite as background (behind 3D meshes).
   * Raster layers above the divider composite as foreground (on top of 3D meshes).
   * Only one divider is allowed; subsequent calls move the existing one.
   */
  public add3DDivider(name = '3D Scene'): string {
    // Remove any existing 3D divider
    const existing = this.layers.findIndex(l => l.type === '3d-scene');
    if (existing >= 0) this.layers.splice(existing, 1);

    const id = makeId();
    const divider: RasterLayer = {
      id, name, type: '3d-scene', visible: true, locked: true,
      blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false,
      lockTransparency: false,
      manager: undefined as any,   // dividers have no texture
    };
    // Insert in the middle of the stack by default
    const mid = Math.ceil(this.layers.length / 2);
    this.layers.splice(mid, 0, divider);
    this.notifyCompositionChanged();
    return id;
  }

  /** Restore a 3D divider with a specific saved ID (used by OPFS restore). */
  public add3DDividerWithId(id: string, name: string): void {
    const divider: RasterLayer = {
      id, name, type: '3d-scene', visible: true, locked: true,
      blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false,
      lockTransparency: false,
      manager: undefined as any,
    };
    this.layers.push(divider);
    this.notifyCompositionChanged();
  }

  /** Remove the 3D divider. All layers become background (original behavior). */
  public remove3DDivider(): boolean {
    const idx = this.layers.findIndex(l => l.type === '3d-scene');
    if (idx < 0) return false;
    this.layers.splice(idx, 1);
    this.notifyCompositionChanged();
    return true;
  }

  /** Get the 3D divider entry, if it exists. */
  public get3DDivider(): { id: string; name: string } | null {
    const d = this.layers.find(l => l.type === '3d-scene');
    return d ? { id: d.id, name: d.name } : null;
  }

  // ── Composition (split at 3D divider) ─────────────────────────────

  public getTextureForComposition() {
    // return ordered array of textures (bg -> top) for the renderer to composite
    // Include paintable layers and reference image overlays; skip folders and dividers
    return this.layers
      .filter(l => (l.type ?? 'layer') === 'layer' || l.type === 'reference')
      .map(l => ({ id: l.id, texture: l.texture, visible: l.visible, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, ditherConfig: l.ditherConfig, frameLinkAnimation: l.frameLinkAnimation }));
  }

  /**
   * Split the composition list at the 3D divider.
   * Returns { background, foreground } where:
   *  - background = layers below the divider (drawn before 3D)
   *  - foreground = layers above the divider (drawn after 3D)
   * If no divider exists, all layers go to background (original behavior).
   */
  public getTextureForCompositionSplit(): {
    background: Array<{ id: string; texture?: GPUTexture; visible: boolean; blendMode: LayerBlendMode; opacity: number; clipped: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>;
    foreground: Array<{ id: string; texture?: GPUTexture; visible: boolean; blendMode: LayerBlendMode; opacity: number; clipped: boolean; ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation }>;
  } {
    const dividerIdx = this.layers.findIndex(l => l.type === '3d-scene');
    if (dividerIdx < 0) {
      return { background: this.getTextureForComposition(), foreground: [] };
    }
    const mapLayer = (l: RasterLayer) => ({
      id: l.id, texture: l.texture, visible: l.visible, blendMode: l.blendMode,
      opacity: l.opacity, clipped: l.clipped, ditherConfig: l.ditherConfig,
      frameLinkAnimation: l.frameLinkAnimation,
    });
    const isDrawable = (l: RasterLayer) => (l.type ?? 'layer') === 'layer' || l.type === 'reference';
    const background = this.layers.slice(0, dividerIdx).filter(isDrawable).map(mapLayer);
    const foreground = this.layers.slice(dividerIdx + 1).filter(isDrawable).map(mapLayer);
    return { background, foreground };
  }

  /** Check whether a 3D scene exists in the stack. */
  public has3DDivider(): boolean {
    return this.layers.some(l => l.type === '3d-scene');
  }

  // Aliases using '3DScene' naming
  public add3DScene(name = '3D Scene'): string { return this.add3DDivider(name); }
  public remove3DScene(): boolean { return this.remove3DDivider(); }
  public get3DScene() { return this.get3DDivider(); }
  public has3DScene(): boolean { return this.has3DDivider(); }

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
  public async createLayerFromRasterCanvas(name: string, rasterCanvas: RasterCanvas, fixedId?: string) {
    const id = fixedId ?? makeId();
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
      if (!l.manager) {
        // Special layers (e.g. 3D scene dividers) have no pixel texture — skip.
        out.push({ id: l.id, name: l.name, visible: l.visible, blob: undefined, width: 0, height: 0 });
        continue;
      }
      try {
        const blob = await l.manager.exportToBlob(type);
        out.push({ id: l.id, name: l.name, visible: l.visible, blob, width: l.manager.getTextureSize().w, height: l.manager.getTextureSize().h });
      } catch (e) {
        console.warn('exportLayersAsBlobs failed for layer', l.id, e);
        out.push({ id: l.id, name: l.name, visible: l.visible, blob: undefined, width: 0, height: 0 });
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
    if (this._compositionFlushPending) return;
    this._compositionFlushPending = true;
    queueMicrotask(() => {
      this._compositionFlushPending = false;
      if (this.has3DDivider() && this.compositionSplitCallback) {
        const { background, foreground } = this.getTextureForCompositionSplit();
        this.compositionSplitCallback(background, foreground);
        return;
      }
      if (!this.compositionCallback) return;
      this.compositionCallback(this.getTextureForComposition());
    });
  }

  /** Register a callback for split (BG/FG) composition changes. */
  public setCompositionSplitCallback(cb: typeof this.compositionSplitCallback): void {
    this.compositionSplitCallback = cb;
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
    id: string; name: string; type: LayerEntryType; parentId: string | null;
    visible: boolean; locked: boolean;
    opacity: number; blendMode: string; clipped: boolean; lockTransparency: boolean;
    animationType: 'static' | 'animated';
    celIds: string[];
    collapsed?: boolean;
    ditherConfig?: DitherConfig;
    frameLinkAnimation?: FrameLinkAnimation;
  }> {
    return this.layers.map(l => ({
      id: l.id,
      name: l.name,
      type: (l.type ?? 'layer') as LayerEntryType,
      parentId: l.parentId ?? null,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity ?? 1,
      blendMode: (l as any).blendMode ?? 'normal',
      clipped: (l as any).clipped ?? false,
      lockTransparency: (l as any).lockTransparency ?? false,
      animationType: ((l.type ?? 'layer') === 'layer' && this.timeline.isLayerAnimated(l.id)) ? 'animated' as const : 'static' as const,
      celIds: ((l.type ?? 'layer') === 'layer') ? this.timeline.getCels(l.id).map(c => c.id) : [],
      collapsed: l.collapsed,
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
    const expectedBytes = w * h * 4;
    if (pixels.byteLength !== expectedBytes) {
      console.warn(`[RasterLayerManager] uploadPixelsToLayer size mismatch: layer="${layer.name}" texture=${w}x${h} (${expectedBytes}B) but pixels=${pixels.byteLength}B`);
    }
    this.device.queue.writeTexture(
      { texture: layer.texture },
      pixels,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
    return true;
  }

  // ── M1: Layer duplicate & merge ───────────────────────────────────

  /**
   * Duplicate a paintable layer. The copy is inserted directly above the source
   * and becomes the active selection. Returns the new layer id, or null on failure.
   */
  public async duplicateLayer(layerId: string): Promise<string | null> {
    const srcIdx = this.layers.findIndex(l => l.id === layerId);
    if (srcIdx < 0) return null;
    const src = this.layers[srcIdx];
    if ((src.type ?? 'layer') !== 'layer') return null;

    const newId = makeId();
    const manager = new RasterTextureManager(this.device);
    const newTex = manager.ensureTexture(this.width, this.height);

    if (src.texture) {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: src.texture },
        { texture: newTex },
        { width: this.width, height: this.height },
      );
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    }

    await manager.pushSnapshot?.();

    const newLayer: RasterLayer = {
      id: newId,
      name: src.name + ' copy',
      visible: src.visible,
      locked: src.locked,
      blendMode: src.blendMode,
      opacity: src.opacity,
      clipped: src.clipped,
      lockTransparency: src.lockTransparency,
      parentId: src.parentId,
      texture: newTex,
      manager,
      ditherConfig: src.ditherConfig ? { ...src.ditherConfig } : undefined,
      frameLinkAnimation: src.frameLinkAnimation ? { ...src.frameLinkAnimation } : undefined,
    };

    // Insert just above the source layer
    this.layers.splice(srcIdx + 1, 0, newLayer);
    this.timeline.registerLayer(newId);
    this.notifyCompositionChanged();
    this.selectLayer(newId);
    return newId;
  }

  /**
   * Merge a layer down into the nearest paintable layer below it.
   * Composites using the upper layer's blend mode and opacity via Canvas 2D.
   * Returns the surviving lower layer id, or null on failure.
   */
  public async mergeLayerDown(layerId: string): Promise<string | null> {
    const upperIdx = this.layers.findIndex(l => l.id === layerId);
    if (upperIdx < 0) return null;
    const upper = this.layers[upperIdx];
    if ((upper.type ?? 'layer') !== 'layer') return null;

    // Find nearest paintable layer below
    let lowerIdx = upperIdx - 1;
    while (lowerIdx >= 0 && (this.layers[lowerIdx].type ?? 'layer') !== 'layer') lowerIdx--;
    if (lowerIdx < 0) return null;
    const lower = this.layers[lowerIdx];

    if (!upper.texture || !lower.texture) return null;

    const w = this.width, h = this.height;

    const [upperBlob, lowerBlob] = await Promise.all([
      upper.manager.exportToBlob('image/png'),
      lower.manager.exportToBlob('image/png'),
    ]);
    const [upperBitmap, lowerBitmap] = await Promise.all([
      createImageBitmap(upperBlob),
      createImageBitmap(lowerBlob),
    ]);

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;

    ctx.globalAlpha = lower.opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(lowerBitmap, 0, 0, w, h);

    ctx.globalAlpha = upper.opacity;
    ctx.globalCompositeOperation = blendModeToCompositeOp(upper.blendMode);
    ctx.drawImage(upperBitmap, 0, 0, w, h);

    upperBitmap.close();
    lowerBitmap.close();

    const mergedBitmap = await createImageBitmap(canvas as OffscreenCanvas);
    this.device.queue.copyExternalImageToTexture(
      { source: mergedBitmap, flipY: false },
      { texture: lower.texture },
      { width: w, height: h },
    );
    await this.device.queue.onSubmittedWorkDone();
    mergedBitmap.close();

    await lower.manager.pushSnapshot?.();

    this.layers.splice(upperIdx, 1);
    upper.manager.destroy();
    this.timeline.unregisterLayer(layerId);

    this.notifyCompositionChanged();
    this.selectLayer(lower.id);
    return lower.id;
  }

  // ── M2: Canvas / artboard resize ──────────────────────────────────

  /**
   * Resize all layer textures to a new document size, preserving existing pixel
   * content at the specified anchor position.
   *
   * anchor = 'top-left'  → existing content stays at (0, 0); fast GPU copy
   * anchor = 'center'    → existing content is centred in the new canvas
   */
  public async resizeCanvas(
    newW: number,
    newH: number,
    anchor: 'center' | 'top-left' = 'top-left',
  ): Promise<void> {
    const oldW = this.width;
    const oldH = this.height;

    const offsetX = anchor === 'center' ? Math.round((newW - oldW) / 2) : 0;
    const offsetY = anchor === 'center' ? Math.round((newH - oldH) / 2) : 0;

    if (offsetX === 0 && offsetY === 0) {
      // top-left anchor: existing ensureTexture preserves content correctly
      this.setSize(newW, newH);
      return;
    }

    // Center anchor: export each layer's pixels, resize, then redraw at the offset
    const snapshots: Array<{ layer: RasterLayer; blob: Blob } | null> = [];
    for (const layer of this.layers) {
      if (!layer.manager || !layer.texture) { snapshots.push(null); continue; }
      const blob = await layer.manager.exportToBlob('image/png');
      snapshots.push({ layer, blob });
    }

    // Resize all textures (creates new blank textures at new size)
    this.setSize(newW, newH);

    // Redraw old content at the centred offset
    for (const snap of snapshots) {
      if (!snap || !snap.layer.texture) continue;
      const bitmap = await createImageBitmap(snap.blob);

      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(newW, newH)
        : Object.assign(document.createElement('canvas'), { width: newW, height: newH });
      const ctx = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.clearRect(0, 0, newW, newH);
      ctx.drawImage(bitmap, offsetX, offsetY);
      bitmap.close();

      const placed = await createImageBitmap(canvas as OffscreenCanvas);
      this.device.queue.copyExternalImageToTexture(
        { source: placed, flipY: false },
        { texture: snap.layer.texture },
        { width: newW, height: newH },
      );
      placed.close();
      await this.device.queue.onSubmittedWorkDone();
      await snap.layer.manager.pushSnapshot?.();
    }

    this.notifyCompositionChanged();
  }

  // ── M3: Reference image layer ─────────────────────────────────────

  /**
   * Add a non-paintable reference image overlay to the layer stack.
   * The image is fitted (letterboxed) to the current document size.
   * The layer is always locked and defaults to 50% opacity.
   * Returns the new layer id.
   */
  public async addReferenceImageLayer(
    name: string,
    imageBitmap: ImageBitmap,
  ): Promise<string> {
    const id = makeId();
    const w = this.width, h = this.height;

    const manager = new RasterTextureManager(this.device);
    const tex = manager.ensureTexture(w, h);

    // Letterbox-fit the image into the document dimensions
    const scale = Math.min(w / imageBitmap.width, h / imageBitmap.height);
    const dw = imageBitmap.width * scale;
    const dh = imageBitmap.height * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(imageBitmap, dx, dy, dw, dh);

    const fitted = await createImageBitmap(canvas as OffscreenCanvas);
    this.device.queue.copyExternalImageToTexture(
      { source: fitted, flipY: false },
      { texture: tex },
      { width: w, height: h },
    );
    await this.device.queue.onSubmittedWorkDone();
    fitted.close();
    await manager.pushSnapshot?.();

    const layer: RasterLayer = {
      id, name, type: 'reference',
      visible: true, locked: true,
      blendMode: LayerBlendMode.Normal, opacity: 0.5,
      clipped: false, lockTransparency: false,
      texture: tex, manager,
    };

    this.layers.push(layer);
    this.notifyCompositionChanged();
    return id;
  }
}
