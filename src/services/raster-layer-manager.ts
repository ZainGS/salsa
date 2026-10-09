import { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import { RasterCanvas } from '../renderer/raster/raster-canvas';
import { LayerBlendMode } from '../renderer/raster/core/raster-compositor';
import { DitherConfig } from '../renderer/raster/effects/dither-engine';
import { AnimationTimeline, OnionSkinConfig, type FrameLinkAnimation, type AnimationCel } from '../animation';
import { EventEmitter } from '../renderer/util/event-emitter';
import { bumpGpuPixelEpoch } from '../renderer/raster/gpu-pixel-epoch';
import { rasterTextureVersion, rasterContentSeq, rasterTextureWrittenAt } from '../renderer/raster/raster-content-version';

function makeId() { return 'r_' + Math.random().toString(36).slice(2,9); }

/** All bytes zero (a fully transparent, never-drawn cel's pixels). */
function isAllZeroBytes(buf: ArrayBuffer): boolean {
  const n4 = buf.byteLength >>> 2;
  const words = new Uint32Array(buf, 0, n4);
  for (let i = 0; i < n4; i++) if (words[i] !== 0) return false;
  const tail = new Uint8Array(buf, n4 << 2);
  for (let i = 0; i < tail.length; i++) if (tail[i] !== 0) return false;
  return true;
}

/** Tightly packed RGBA8 → an image Blob (the same encode RasterTextureManager.exportToBlob does). */
async function encodeRgbaToBlob(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number, type: 'image/webp' | 'image/png'): Promise<Blob> {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = (canvas as any).getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D context unavailable');
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  if ('convertToBlob' in canvas) return await (canvas as OffscreenCanvas).convertToBlob({ type });
  return await new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type));
}

/** Discriminator for layer stack entry types. */
export type LayerEntryType = 'layer' | 'folder' | '3d-scene' | 'reference' | 'ephemera' | 'vector';

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
  /** SYSTEM layer marker — set when a subsystem (e.g. 'packaging' for the Dieline layer) owns this
   *  layer as an internal paint surface. The host's Layers panel should FILTER these out, and they
   *  are created composite-hidden (visible=false) so they never draw on the artboard — consumers
   *  (e.g. packaging panels) sample the layer's GPUTexture directly, not the composite. Persisted. */
  systemOwner?: string;
  /** Package layer-stack marker — the id of the PACKAGE this layer belongs to (paired with
   *  `systemOwner:'packaging'`). Package layers are ordinary doc raster/vector layers, hidden from
   *  the host Layers panel like the dieline; the package composites its tagged layers (in stack
   *  order) onto the box. Persisted. */
  packageOwnerId?: string;
};

/** One layer of the composition list handed to the renderer (bottom → top). `animated`: the layer has cels (the
 *  renderer's per-layer dither cache then keeps one entry per cel texture). */
export interface RasterCompositionItem {
  id: string; texture?: GPUTexture; visible?: boolean; blendMode?: LayerBlendMode; opacity?: number; clipped?: boolean;
  ditherConfig?: DitherConfig; frameLinkAnimation?: FrameLinkAnimation; animated?: boolean;
}

export class RasterLayerManager {
  private device: GPUDevice;
  private layers: RasterLayer[] = [];
  private width: number = 0;
  private height: number = 0;
  private selectedLayerId: string | null = null;
  // Microtask-debounce flag: prevents N addLayerWithId calls from firing N composition
  // callbacks. All calls within the same sync tick collapse into one deferred notification.
  private _compositionFlushPending = false;
  /** Bake Dither undo entries: the undo-history token of a bake's AFTER snapshot → the dither config the bake
   *  consumed. Undoing that entry turns the dither back on (with the pre-bake pixels); redoing it turns it off. */
  private _ditherBakeEntries = new WeakMap<object, DitherConfig>();
  // optional callback to notify renderer of composition list changes
  private compositionCallback?: (list: Array<RasterCompositionItem>) => void;
  // optional callback to notify renderer of split (BG/FG) composition list changes
  private compositionSplitCallback?: (
    background: Array<RasterCompositionItem>,
    foreground: Array<RasterCompositionItem>,
  ) => void;
  // optional callback when selected layer changes (so renderer can update paint target)
  private selectionCallback?: (layerTexture: GPUTexture | null, layerManager: RasterTextureManager | null) => void;

  /**
   * Fires whenever the layer LIST structure/metadata changes (add / remove / reorder / rename /
   * visibility / blend / opacity), coalesced to one emit per microtask. The host Layers panel
   * subscribes to this to re-read getLayers()/getVectorLayers() and refresh — vector layers carry
   * no GPU texture, so the renderer's compositionCallback is not a reliable "the list changed"
   * signal for them (adding one composites nothing, so the panel would otherwise not refresh until
   * an unrelated interaction triggers change detection). Host must run its refresh inside its zone.
   */
  public readonly onLayerStructureChanged = new EventEmitter<void>();

  // ── Animation ───────────────────────────────────────────────────
  private timeline: AnimationTimeline;
  private animationEnabled = false;
  /** D1 (lazy cel textures): textures made for a BLANK cel only because the selected layer shows it (the paint
   *  target), with the content-version seq at creation. Given back while nothing has written them. */
  private _provisionalCels = new Map<GPUTexture, { layerId: string; celId: string; seq: number }>();
  /** D1: one provably blank canvas-size texture kept from a given-back cel, reused by the next blank cel shown (no
   *  allocation churn while scrubbing / exporting over blank cels). */
  private _spareCel: { tex: GPUTexture; seq: number } | null = null;

  constructor(device: GPUDevice, width = 1024, height = 768, compositionCallback?: (list: Array<RasterCompositionItem>) => void, selectionCallback?: (layerTexture: GPUTexture | null, layerManager: RasterTextureManager | null) => void) {
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
      } else if (event.type === 'playback-state-changed') {
        // D1: playback started → a blank cel's provisional texture is given back; stopped on a blank cel → it gets one
        // (the paint target). A3: playback stopped on a cel — seed its undo history now (skipped while playing).
        if (this.animationEnabled) this.onFrameChanged();
        else if (!this.timeline.isPlaying()) this.syncHistoryTargets();
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
    this.releaseProvisionalCels();   // D1: still-blank provisional cel textures are at the old size (remade below)
    if (this._spareCel && (this._spareCel.tex.width !== w || this._spareCel.tex.height !== h)) this.dropSpareCel();
    // resize all existing layer textures
    for (const layer of this.layers) {
      if (!layer.manager) continue; // skip 3D dividers and folders (no texture)
      const before = layer.manager.getTexture?.();
      layer.texture = layer.manager.ensureTexture(w, h);
      // reallocated: a history that is only the blank seed re-seeds at the new size (a new document is created at
      // the window size, then sized — its first undo used to restore the window-size seed)
      if (before && layer.texture !== before) {
        void layer.manager.reseedPristineHistory?.();
        // an animated layer's cel showing the layer's own texture follows it (it pointed at the destroyed old one)
        this.timeline.replaceBaseTexture(layer.id, before, layer.texture);
      }
    }
    if (this.animationEnabled) { this.syncLazyCels(); this.applyFrameTextures(); }   // animated layers show their cels
    this.syncHistoryTargets();   // A3: undo follows the textures the layers now show
    this.notifyCompositionChanged();
    // A size change recreates each layer's GPUTexture (ensureTexture allocates a
    // new one). The compositor was just updated above, but the paint/selection
    // engines still hold the OLD texture — re-fire the selection callback so they
    // re-point at the selected layer's NEW texture. Without this the brush paints
    // onto an orphaned texture that's no longer composited (invisible strokes).
    if (this.selectedLayerId) {
      const sel = this.layers.find(x => x.id === this.selectedLayerId);
      if (sel) this.selectionCallback?.(sel.texture ?? null, sel.manager);
    }
  }

  public getLayers() { return this.layers.map(l => ({ id: l.id, name: l.name, type: l.type ?? 'layer' as LayerEntryType, parentId: l.parentId ?? null, visible: l.visible, locked: l.locked, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, lockTransparency: l.lockTransparency, collapsed: l.collapsed, systemOwner: l.systemOwner, packageOwnerId: l.packageOwnerId })); }

  /** Return the current GPUTexture for a raster layer, or null if not found. */
  public getLayerTexture(layerId: string): GPUTexture | null {
    return this.layers.find(l => l.id === layerId)?.texture ?? null;
  }

  public addLayer(name: string = 'Layer', opts: { visible?: boolean; systemOwner?: string; packageOwnerId?: string } = {}) {
    const id = makeId();
    const manager = new RasterTextureManager(this.device);
    manager.ensureTexture(this.width, this.height);
    void manager.initializeWithBlankSnapshot?.();
    const texture = manager.ensureTexture(this.width, this.height);
    const visible = opts.visible ?? true;
    const layer: RasterLayer = { id, name, visible, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false, texture, manager, systemOwner: opts.systemOwner, packageOwnerId: opts.packageOwnerId };
    this.layers.push(layer);
    this.timeline.registerLayer(id);
  this.notifyCompositionChanged();
  return { id, name, visible, locked: false, blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false, lockTransparency: false, systemOwner: opts.systemOwner, packageOwnerId: opts.packageOwnerId };
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
      systemOwner?: string;
      packageOwnerId?: string;
    } = {},
  ) {
    // Don't create a duplicate if a layer with this ID already exists
    if (this.layers.find(l => l.id === id)) return;
    const manager = new RasterTextureManager(this.device);
    manager.ensureTexture(this.width, this.height);
    void manager.initializeWithBlankSnapshot?.();
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
      systemOwner: opts.systemOwner,
      packageOwnerId: opts.packageOwnerId,
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
    this._provisionalCels.clear();   // (their textures went with the layers' cels)
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
    } else if (removed.type === '3d-scene' || removed.type === 'vector' || removed.type === 'ephemera') {
      // no GPU texture or timeline entry to clean up
    } else {
      removed.manager.destroy();
      this.timeline.unregisterLayer(id);
      for (const [tex, p] of this._provisionalCels) if (p.layerId === id) this._provisionalCels.delete(tex);
    }
  this.notifyCompositionChanged();
    return true;
  }

  /** Select the layer that paint / fill / import / raster undo act on. A vector / ephemera layer or a folder is never
   *  that layer: false, the selection stays. (A host auto-picking `getLayers()[0]` — the default 'Vector' entry of a new
   *  document — used to make every brush stroke paint an orphan texture with no undo entry.) The 3D scene stays
   *  selectable: a loaded city document selects it. */
  public selectLayer(id: string): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    if (l.type === 'vector' || l.type === 'ephemera' || l.type === 'folder') return false;
    this.selectedLayerId = id;
    // D1: the newly selected layer's blank cel gets its texture (the paint target); the previous one's is given back
    if (this.syncLazyCels()) { if (this.animationEnabled) this.applyFrameTextures(); this.notifyCompositionChanged(); }
    this.syncHistoryTarget(l);   // A3: an animated layer's undo acts on the cel it shows
    // Notify renderer so it can point the paint engine at this layer's texture
    this.selectionCallback?.(l.texture ?? null, l.manager);
    return true;
  }

  /**
   * A3 (perf audit 2026-10-09): point an animated layer's raster history at the cel it shows (its texture manager
   * keeps one history per cel texture; a static layer / cel 1 = the manager's own). The SELECTED layer, playback
   * stopped, also seeds a cel that has no history yet (a read-back — new / loaded cels were seeded for free).
   */
  private syncHistoryTarget(l: RasterLayer): void {
    if (!l.manager || (l.type ?? 'layer') !== 'layer') return;
    const animated = this.timeline.isLayerAnimated(l.id);
    const seed = l.id === this.selectedLayerId && !this.timeline.isPlaying();
    l.manager.setHistoryTarget?.(animated ? (l.texture ?? null) : null, { seed });
  }

  private syncHistoryTargets(): void {
    for (const l of this.layers) this.syncHistoryTarget(l);
  }

  /** A3: an animated layer showing a BLANK frame (no cel) has no pixels to undo / snapshot. */
  private showsNoCel(l: RasterLayer): boolean {
    return !l.texture && this.timeline.isLayerAnimated(l.id);
  }

  /** The default vector layer — the first `'vector'`-type entry (or null). Unassigned vector shapes are stamped
   *  onto / backfilled to this so every vector shape has a real layer home. */
  public getDefaultVectorLayerId(): string | null {
    return this.layers.find(l => l.type === 'vector')?.id ?? null;
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
    // Insert at the top of the stack (same as addLayer). All existing layers start below the
    // divider (behind 3D). Users can drag any layer above it to place it in front of 3D.
    this.layers.push(divider);
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
    // Include paintable layers and reference image overlays; skip folders and dividers.
    // PACKAGE-owned layers (packageOwnerId) are excluded STRUCTURALLY — they composite onto their
    // package's box, never onto the artboard — which frees their `visible` flag to mean
    // stack-visibility inside the package composite.
    return this.layers
      .filter(l => ((l.type ?? 'layer') === 'layer' || l.type === 'reference') && !l.packageOwnerId)
      .map(l => ({ id: l.id, texture: l.texture, visible: l.visible, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, ditherConfig: l.ditherConfig, frameLinkAnimation: l.frameLinkAnimation, animated: this.timeline.isLayerAnimated(l.id) }));
  }

  // E8 (perf 2026-10-09): the lists handed to the renderer's composition callbacks are REUSED (arrays + one object per
  // slot, refilled in place) — they were rebuilt with filter + map on every timeline frame change. Only the renderer
  // receives them; getTextureForComposition() / getTextureForCompositionSplit() still return fresh copies.
  private readonly _compOut = { main: [] as RasterCompositionItem[], bg: [] as RasterCompositionItem[], fg: [] as RasterCompositionItem[] };
  private readonly _compPool = { main: [] as RasterCompositionItem[], bg: [] as RasterCompositionItem[], fg: [] as RasterCompositionItem[] };

  /** The drawable layers of this.layers[from, to) into the reused list `which`. */
  private fillCompositionList(which: 'main' | 'bg' | 'fg', from: number, to: number): RasterCompositionItem[] {
    const out = this._compOut[which], pool = this._compPool[which];
    let n = 0;
    for (let i = from; i < to; i++) {
      const l = this.layers[i];
      if (!(((l.type ?? 'layer') === 'layer' || l.type === 'reference') && !l.packageOwnerId)) continue;
      let c = pool[n];
      if (!c) c = pool[n] = { id: l.id };
      c.id = l.id; c.texture = l.texture; c.visible = l.visible; c.blendMode = l.blendMode; c.opacity = l.opacity;
      c.clipped = l.clipped; c.ditherConfig = l.ditherConfig; c.frameLinkAnimation = l.frameLinkAnimation;
      c.animated = this.timeline.isLayerAnimated(l.id);
      out[n++] = c;
    }
    out.length = n;
    return out;
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
      frameLinkAnimation: l.frameLinkAnimation, animated: this.timeline.isLayerAnimated(l.id),
    });
    const isDrawable = (l: RasterLayer) => ((l.type ?? 'layer') === 'layer' || l.type === 'reference') && !l.packageOwnerId;
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

  // ── Vector layer (live vector + ephemera placement layer) ────────

  /** Insert a new vector layer at the top of the stack. Returns the new layer ID.
   *  `opts` supports the package layer-stack tags (a package vector layer is hidden from the host
   *  panel like the dieline, and composites into the box through its raster PROXY texture). */
  public addVectorLayer(name = 'Vector', opts: { visible?: boolean; systemOwner?: string; packageOwnerId?: string } = {}): string {
    const id = makeId();
    const entry: RasterLayer = {
      id, name, type: 'vector', visible: opts.visible ?? true, locked: false,
      blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false,
      lockTransparency: false,
      manager: undefined as any, // vector layers have no GPU texture
      systemOwner: opts.systemOwner,
      packageOwnerId: opts.packageOwnerId,
    };
    this.layers.unshift(entry);
    this.notifyCompositionChanged();
    return id;
  }

  /** Restore a vector layer with a specific saved ID (used by persistence restore). */
  public addVectorLayerWithId(id: string, name: string, opts: { visible?: boolean; systemOwner?: string; packageOwnerId?: string } = {}): void {
    if (this.layers.find(l => l.id === id)) return;
    const entry: RasterLayer = {
      id, name, type: 'vector', visible: opts.visible ?? true, locked: false,
      blendMode: LayerBlendMode.Normal, opacity: 1.0, clipped: false,
      lockTransparency: false,
      manager: undefined as any,
      systemOwner: opts.systemOwner,
      packageOwnerId: opts.packageOwnerId,
    };
    this.layers.push(entry);
    this.notifyCompositionChanged();
  }

  public removeVectorLayer(id: string): boolean {
    return this.takeVectorLayer(id) !== null;
  }

  /** Remove a vector layer and RETURN its entry + stack index, so an undo can put it back exactly
   *  ({@link reinsertVectorLayer}). Vector entries own no GPU texture, so holding one is free. */
  public takeVectorLayer(id: string): { index: number; entry: RasterLayer } | null {
    const idx = this.layers.findIndex(l => l.id === id && (l.type === 'vector' || l.type === 'ephemera'));
    if (idx < 0) return null;
    const [entry] = this.layers.splice(idx, 1);
    this.notifyCompositionChanged();
    return { index: idx, entry };
  }

  /** Put an entry taken by {@link takeVectorLayer} back at its old stack index (no-op if the id exists again). */
  public reinsertVectorLayer(snap: { index: number; entry: RasterLayer }): void {
    if (this.layers.some(l => l.id === snap.entry.id)) return;
    this.layers.splice(Math.min(Math.max(0, snap.index), this.layers.length), 0, snap.entry);
    this.notifyCompositionChanged();
  }

  public getVectorLayers(): Array<{ id: string; name: string; visible: boolean; systemOwner?: string; packageOwnerId?: string }> {
    return this.layers
      .filter(l => l.type === 'vector' || l.type === 'ephemera')
      // ★systemOwner / packageOwnerId ride along so the host Layers panel can FILTER package-owned
      // vector layers (systemOwner === 'packaging') exactly like it filters package raster layers —
      // without them a restored package vector layer leaks into the normal panel (it only appears in
      // the package's own layer list). See docs/ui/package-designer.md §0e.
      .map(l => ({ id: l.id, name: l.name, visible: l.visible, systemOwner: l.systemOwner, packageOwnerId: l.packageOwnerId }));
  }

  // ── Backwards-compat aliases (ephemera → vector) ──────────────────

  /** @deprecated Use addVectorLayer instead. */
  public addEphemeraLayer(name = 'Vector'): string { return this.addVectorLayer(name); }
  /** @deprecated Use addVectorLayerWithId instead. */
  public addEphemeraLayerWithId(id: string, name: string, opts: { visible?: boolean } = {}): void { this.addVectorLayerWithId(id, name, opts); }
  /** @deprecated Use removeVectorLayer instead. */
  public removeEphemeraLayer(id: string): boolean { return this.removeVectorLayer(id); }
  /** @deprecated Use getVectorLayers instead. */
  public getEphemeraLayers(): Array<{ id: string; name: string; visible: boolean }> { return this.getVectorLayers(); }

  /**
   * Stamp multiple SVG strings onto a target raster layer in a single draw call.
   * All placements are composited in one OffscreenCanvas pass with one undo snapshot.
   */
  public async compositeMultipleImagesOntoLayer(
    layerId: string,
    placements: Array<{ svg: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; blendMode?: GlobalCompositeOperation }>,
  ): Promise<boolean> {
    const l = this.layers.find(lx => lx.id === layerId);
    if (!l || !l.manager || !l.texture) return false;
    if (placements.length === 0) return true;

    const w = this.width, h = this.height;

    // The state BEFORE (a dedup no-op when it is already the current entry). Awaited + never coalesced, like the
    // AFTER push below: it used to be the only push (un-awaited), so the burned pixels were never an entry and Ctrl+Z
    // stepped back past the previous stroke as well (UI review 2026-10-07 §2b).
    await l.manager.pushSnapshot?.({ noCoalesce: true });

    const existingBlob = await l.manager.exportToBlob('image/png');
    const existingBitmap = await createImageBitmap(existingBlob);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(existingBitmap, 0, 0, w, h);
    existingBitmap.close();

    for (const p of placements) {
      const svgBlob = new Blob([p.svg], { type: 'image/svg+xml' });
      const bitmap = await createImageBitmap(svgBlob, { resizeWidth: p.width, resizeHeight: p.height });
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.globalCompositeOperation = p.blendMode ?? 'source-over';
      if (p.rotation !== 0) {
        ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.drawImage(bitmap, -p.width / 2, -p.height / 2, p.width, p.height);
      } else {
        ctx.drawImage(bitmap, p.x, p.y, p.width, p.height);
      }
      ctx.restore();
      bitmap.close();
    }

    const composited = await createImageBitmap(canvas);
    bumpGpuPixelEpoch('full', l.texture);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: this layer)
    this.device.queue.copyExternalImageToTexture(
      { source: composited, flipY: false },
      { texture: l.texture },
      { width: w, height: h },
    );
    await this.device.queue.onSubmittedWorkDone();
    composited.close();
    await l.manager.pushSnapshot?.({ noCoalesce: true });   // the burned state = ONE undo entry on this layer

    this.notifyCompositionChanged();
    return true;
  }

  /** The layer's raster undo-history entry tokens (RasterTextureManager.historyMark); null = no pixel history. */
  public getLayerHistoryMark(id: string): { top: object | null; next: object | null } | null {
    const l = this.layers.find(x => x.id === id);
    return l?.manager?.historyMark?.() ?? null;
  }

  // Find the internal layer by id
  public getLayerById(id: string) {
    return this.layers.find(l => l.id === id);
  }

  /** Mark a layer as SYSTEM-owned (see {@link RasterLayer.systemOwner}). Used when a subsystem
   *  ADOPTS a pre-existing layer (e.g. a legacy 'Dieline' layer on re-enter) so the host panel
   *  filter + persistence pick it up. Pass undefined to clear. */
  public setSystemOwner(id: string, owner: string | undefined): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.systemOwner = owner;
    return true;
  }

  /** Tag/untag a layer as belonging to a PACKAGE's layer stack (see {@link RasterLayer.packageOwnerId}). */
  public setPackageOwner(id: string, packageId: string | undefined): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.packageOwnerId = packageId;
    return true;
  }

  /** Rename a layer (any entry type). */
  public renameLayer(id: string, name: string): boolean {
    const l = this.layers.find(x => x.id === id);
    if (!l) return false;
    l.name = name;
    return true;
  }

  // Import a RasterCanvas into an existing layer by id
  public async importRasterCanvasToLayer(id: string, rasterCanvas: RasterCanvas) {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager) return false;   // no pixels to import into (folder / vector layer / 3D divider)
    // ensure manager texture matches raster size
    l.manager.ensureTexture(rasterCanvas.width, rasterCanvas.height);
    l.manager.uploadRasterCanvas(rasterCanvas as any);
    // wait for GPU work to finish before pushing snapshot
    await this.device.queue.onSubmittedWorkDone();
    // push snapshot so undo/redo reflects imported pixels
    void l.manager.pushSnapshot?.();
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
    void manager.pushSnapshot?.();
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
  // Per-layer history lives in the layer's texture manager. Folders, vector / ephemera layers and the 3D divider have
  // none (manager undefined): undo / redo / snapshot on them is a no-op returning false. A city document selects its
  // 3D divider on load, and Ctrl+Z used to throw "Cannot read properties of undefined (reading 'undo')" here.
  public pushSnapshotForLayer(id: string) {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager || this.showsNoCel(l)) return false;
    void l.manager.pushSnapshot?.();
    return true;
  }

  public async undoForLayer(id: string): Promise<boolean> {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager || this.showsNoCel(l)) return false;
    const before = l.manager.getTexture?.() ?? null;
    const top = l.manager.historyMark?.()?.top ?? null;
    const baked = top ? this._ditherBakeEntries.get(top) : undefined;   // undoing a Bake Dither
    const ok = !!(await l.manager.undo?.());
    if (ok && baked) l.ditherConfig = { ...baked };   // the pre-bake pixels come back with their live dither
    if (ok) { this.adoptReallocatedTexture(l, before); this.notifyCompositionChanged(); }
    return ok;
  }

  public async redoForLayer(id: string): Promise<boolean> {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager || this.showsNoCel(l)) return false;
    const before = l.manager.getTexture?.() ?? null;
    const ok = !!(await l.manager.redo?.());
    if (ok) {
      const top = l.manager.historyMark?.()?.top ?? null;
      const baked = top ? this._ditherBakeEntries.get(top) : undefined;   // redoing a Bake Dither
      if (baked) l.ditherConfig = { ...baked, enabled: false };
    }
    if (ok) { this.adoptReallocatedTexture(l, before); this.notifyCompositionChanged(); }
    return ok;
  }

  /**
   * BAKE DITHER: write the layer's current dithered look into its pixels for good and turn its dither off, as ONE
   * raster undo entry (a BEFORE snapshot, the write, an AFTER snapshot — like the other one-shot raster edits). Undo
   * restores the pre-bake pixels AND the dither config; redo bakes again. `bake(layer, dst)` writes the dithered
   * pixels into `dst` (the compositor's layer dither cache — RasterCompositor.bakeLayerDither). False (nothing
   * changed) when the layer has no pixels, no active dither, shows an animation cel, or the bake could not run.
   */
  public async bakeLayerDither(
    id: string,
    bake: (layer: { texture: GPUTexture; blendMode: LayerBlendMode; opacity: number; clipped: boolean; visible: boolean; ditherConfig: DitherConfig; cacheKey: string }, dst: GPUTexture) => Promise<boolean>,
  ): Promise<boolean> {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager || !l.texture) return false;
    const cfg = l.ditherConfig;
    if (!cfg || !cfg.enabled || !(cfg.strength > 0.001)) return false;
    if ((l.manager.getTexture?.() ?? null) !== l.texture) return false;   // an animation cel: not this history's texture
    await l.manager.pushSnapshot?.({ noCoalesce: true });   // BEFORE (a dedup no-op when it is already the current entry)
    const tex = l.texture;
    if (!tex || l.ditherConfig !== cfg) return false;        // the layer changed while the snapshot was read
    const ok = await bake({
      texture: tex, blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, visible: l.visible, ditherConfig: cfg, cacheKey: l.id,
    }, tex);
    if (!ok) return false;
    bumpGpuPixelEpoch('full', tex);   // GPU-only pixels changed (BRUSH-5 dirty + device-lost shadow; autosave: this layer)
    const markBefore = l.manager.historyMark?.()?.top ?? null;
    await l.manager.pushSnapshot?.({ noCoalesce: true });   // AFTER: the baked state = ONE undo entry on this layer
    const markAfter = l.manager.historyMark?.()?.top ?? null;
    if (markAfter && markAfter !== markBefore) this._ditherBakeEntries.set(markAfter, { ...cfg });
    l.ditherConfig = { ...cfg, enabled: false };
    this.notifyCompositionChanged();
    return true;
  }

  /** Undo / redo of an entry recorded at another size reallocates the manager's texture (its resize hook). The
   *  layer entry kept the old — now destroyed — texture: the compositor drew it ("Destroyed texture used in a
   *  submit") and the next stroke painted it (lost). Adopt the new one and re-point the paint engine. */
  private adoptReallocatedTexture(l: RasterLayer, before: GPUTexture | null): void {
    const now = l.manager?.getTexture?.() ?? null;
    if (!now || now === before || l.texture !== before) return;   // unchanged, or an animated layer showing a cel
    l.texture = now;
    if (this.selectedLayerId === l.id) this.selectionCallback?.(now, l.manager);
  }

  /** True when `id` is a layer with its own pixel history (a paint layer), i.e. raster undo / redo can act on it. */
  public hasRasterHistory(id: string): boolean {
    return !!this.layers.find(x => x.id === id)?.manager;
  }

  private notifyCompositionChanged() {
    if (this._compositionFlushPending) return;
    this._compositionFlushPending = true;
    queueMicrotask(() => {
      this._compositionFlushPending = false;
      // Structural/metadata change signal for the host Layers panel — fired regardless of whether
      // any raster texture actually re-composites, so vector-layer add/remove reaches the panel too.
      this.onLayerStructureChanged.emit();
      const dividerIdx = this.compositionSplitCallback ? this.layers.findIndex(l => l.type === '3d-scene') : -1;
      if (dividerIdx >= 0 && this.compositionSplitCallback) {
        this.compositionSplitCallback(
          this.fillCompositionList('bg', 0, dividerIdx),
          this.fillCompositionList('fg', dividerIdx + 1, this.layers.length),
        );
        return;
      }
      if (!this.compositionCallback) return;
      this.compositionCallback(this.fillCompositionList('main', 0, this.layers.length));
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
    // Turning animation off (the host hides the timeline) also pauses playback: the rAF clock used to keep
    // advancing frames — and re-rendering — with no timeline on screen to stop it from.
    if (!enabled) this.timeline.pause();
    this.animationEnabled = enabled;
    if (enabled && this.timeline.getFrameCount() < 2) {
      // Start with a reasonable frame count when animation is first enabled
      this.timeline.setFrameCount(24);
    }
  }

  public isAnimationEnabled(): boolean {
    return this.animationEnabled;
  }

  /** Document load / new document: animation mode off and the timeline back to a new timeline's state. A document
   *  without animation used to inherit the previous one's (and save it as its own). The load re-enables it when the
   *  document has animation. */
  public resetAnimationForDocumentLoad(): void {
    this.animationEnabled = false;
    this.timeline.resetForDocumentLoad();
  }

  /** The layer stack a new document starts with: one blank 'Background' raster layer (selected) and the default
   *  'Vector' layer, replacing every existing layer (and its pixels / cels / undo snapshots). */
  public resetToDefaultLayers(): void {
    this.clearAllLayers();
    const bg = this.addLayer('Background');
    this.addVectorLayer('Vector');
    this.selectLayer(bg.id);
  }

  /**
   * Convert a layer to animated (multi-frame) mode.
   * The layer's current texture becomes the first cel.
   */
  public setLayerAnimated(layerId: string, animated: boolean): boolean {
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer) return false;

    this.timeline.registerLayer(layerId);
    if (!animated && this.timeline.isLayerAnimated(layerId)) return this.makeLayerStatic(layer);
    this.timeline.setLayerAnimationType(
      layerId,
      animated ? 'animated' : 'static',
      animated ? layer.texture : undefined,
    );
    this.syncHistoryTarget(layer);
    return true;
  }

  /**
   * Animated → static (perf audit A1/A3): the FIRST cel's drawing becomes the static layer, in the layer's own
   * texture (its texture manager's — the one its undo history, resize and export use). The layer used to keep
   * showing whatever cel the current frame had — a texture the conversion then destroyed (or none on a blank frame).
   */
  private makeLayerStatic(layer: RasterLayer): boolean {
    this.releaseProvisionalCels();   // D1: a still-blank provisional cel counts as blank
    const base = layer.manager?.getTexture?.() ?? null;
    const first = this.timeline.getCels(layer.id)[0];
    const firstTex = first?.texture ?? null;
    const copied = !!(base && first && firstTex && firstTex !== base);
    const cleared = !!(base && first && !firstTex);   // D1: a BLANK first cel → the static layer is blank
    if (copied) {
      const w = Math.min(base!.width, firstTex!.width), h = Math.min(base!.height, firstTex!.height);
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: firstTex! }, { texture: base! }, { width: w, height: h });
      this.device.queue.submit([enc.finish()]);
      bumpGpuPixelEpoch('full', base!);   // GPU-only pixels changed (BRUSH-5 dirty, device-lost shadow, autosave)
    } else if (cleared) {
      const enc = this.device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: base!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] }).end();
      this.device.queue.submit([enc.finish()]);
      bumpGpuPixelEpoch('full', base!);
    }
    this.timeline.setLayerAnimationType(layer.id, 'static');   // destroys the other cels' textures
    if (copied || cleared) this.timeline.setCelTexture(layer.id, first!.id, base!);   // …and the first one's (now in `base`)
    if (base) layer.texture = base;
    layer.manager?.setHistoryTarget?.(null);
    if (copied || cleared) void layer.manager?.pushSnapshot?.();   // the static pixels = one undo entry on the layer's history
    if (this.selectedLayerId === layer.id) this.selectionCallback?.(layer.texture ?? null, layer.manager);
    this.notifyCompositionChanged();
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
    return this.addCelAtFrame(layerId, this.timeline.getCurrentFrame());
  }

  /**
   * Add a new blank cel at a specific frame for the specified layer. (A cel already starting there is returned as
   * is.) Splitting a hold gives the rest of the hold its own copy of the drawing (AnimationTimeline.addCel).
   */
  public addCelAtFrame(layerId: string, frame: number): string | null {
    this.releaseProvisionalCels();   // D1: splitting a hold whose drawing is still blank leaves the rest blank (no copy)
    const cel = this.timeline.addCel(
      layerId,
      frame,
      this.device,
      this.width,
      this.height,
      'key',
      (t) => this.isTextureBlank(layerId, t),   // D1: the rest of a still-blank hold stays blank (no copy)
    );
    if (cel) {
      // D1: a NEW cel is blank and owns no texture; shown on the selected layer it gets one (blank undo seed, B3/A3)
      this.onFrameChanged(); // update displayed texture
      return cel.id;
    }
    return null;
  }

  /** Delete a cel from an animated layer. */
  public deleteCel(layerId: string, celId: string): boolean {
    this.releaseProvisionalCels();   // (D1: a blank one's texture becomes the spare)
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
    this.syncLazyCels();          // D1: the selected layer's blank cel gets its texture (the paint target)
    this.applyFrameTextures();
    this.syncHistoryTargets();   // A3: undo follows the cels now shown

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

    // D1: the selected layer's blank cel gets its texture (the paint target); a provisional one left behind that
    // nothing wrote is given back (playing: none is made)
    this.syncLazyCels();
    this.applyFrameTextures();
    this.syncHistoryTargets();   // A3: undo follows the cels now shown (seeded only when not playing)

    // Update the selected layer's paint target if it's animated
    if (this.selectedLayerId) {
      const selected = this.layers.find(l => l.id === this.selectedLayerId);
      if (selected && this.timeline.isLayerAnimated(selected.id)) {
        this.selectionCallback?.(selected.texture ?? null, selected.manager);
      }
    }

    this.notifyCompositionChanged();
  }

  /** Animated layers show the cel of the current frame: its texture, or none (a blank frame / a BLANK cel — the
   *  compositor skips a layer without a texture). Static layers keep theirs. */
  private applyFrameTextures(): void {
    const frame = this.timeline.getCurrentFrame();
    for (const layer of this.layers) {
      const celTexture = this.timeline.getTextureAtFrame(layer.id, frame);
      if (celTexture === undefined) continue;   // static layer
      layer.texture = celTexture ?? undefined;
    }
  }

  // ── D1: lazy cel textures ─────────────────────────────────────────
  //
  // A blank cel owns no texture. Every pixel writer (brush, fill, paste, transform, text, filters, undo / redo) writes
  // the SELECTED layer's shown texture — the paint target handed out by selectionCallback — so the blank cel the
  // selected layer shows (playback stopped) gets a texture: PROVISIONAL, with a blank undo seed and the content-version
  // seq at creation. When the paint target moves on (frame change, another layer selected, playback, a cel operation,
  // a resize) a provisional texture nothing has written since (raster-content-version: no write reported to it, and
  // no unattributed one) and whose history holds only its seed is given back: the cel is blank again and the texture is
  // kept as the one spare. A written one simply becomes the cel's own. Other writes to a blank cel (a load / import
  // upload) make its texture directly. Readers (compositor, onion skin, export, autosave, versions) treat a blank cel —
  // or a provisional one still blank — as transparent / absent.

  /** A canvas-size blank texture for a cel: the spare when still provably blank, else a new one (WebGPU zero-fills). */
  private newBlankCelTexture(): GPUTexture {
    const spare = this._spareCel;
    this._spareCel = null;
    if (spare && spare.tex.width === this.width && spare.tex.height === this.height && rasterTextureWrittenAt(spare.tex) <= spare.seq) return spare.tex;
    if (spare) this.destroyLater(spare.tex);
    return this.device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC |
             GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Destroy once the GPU has drained (a previous frame's composite may still reference it). */
  private destroyLater(tex: GPUTexture): void {
    this.device.queue.onSubmittedWorkDone().then(() => tex.destroy()).catch(() => { /* device lost */ });
  }

  private dropSpareCel(): void {
    if (this._spareCel) this.destroyLater(this._spareCel.tex);
    this._spareCel = null;
  }

  /** Give a cel of `layer` its first texture (blank, with a blank undo seed). Provisional = made for the paint target. */
  private materializeCel(layer: RasterLayer, celId: string, provisional: boolean): GPUTexture | null {
    const tex = this.newBlankCelTexture();
    if (!this.timeline.setCelTexture(layer.id, celId, tex)) { this._spareCel = { tex, seq: rasterContentSeq() }; return null; }
    layer.manager?.seedBlankHistory?.(tex);
    if (provisional) this._provisionalCels.set(tex, { layerId: layer.id, celId, seq: rasterContentSeq() });
    return tex;
  }

  /** A provisional cel texture still exactly blank (nothing written, history only its seed). */
  private isProvisionalBlank(tex: GPUTexture | null | undefined): boolean {
    const p = tex ? this._provisionalCels.get(tex) : undefined;
    if (!p) return false;
    const layer = this.layers.find(l => l.id === p.layerId);
    return rasterTextureWrittenAt(tex!) <= p.seq && (layer?.manager?.isHistoryPristine?.(tex!) ?? true);
  }

  /** D1: `tex` (a cel's of `layerId`) is provably blank: a provisional one nothing wrote, or the layer's own texture
   *  untouched since its blank seed (cel 1 of a fresh layer made animated). */
  private isTextureBlank(layerId: string, tex: GPUTexture): boolean {
    if (this.isProvisionalBlank(tex)) return true;
    return !!this.layers.find(l => l.id === layerId)?.manager?.isTextureProvablyBlank?.(tex);
  }

  /** The texture holding a cel's pixels, or null when it is blank (no texture, or a provisional one still blank). */
  private celPixels(cel: AnimationCel): GPUTexture | null {
    return cel.texture && !this.isProvisionalBlank(cel.texture) ? cel.texture : null;
  }

  /** Give back every provisional cel texture nothing has written (except `keep`); written ones become their cels' own.
   *  True when a cel went blank again. */
  private releaseProvisionalCels(keep: GPUTexture | null = null): boolean {
    let changed = false;
    for (const [tex, p] of [...this._provisionalCels]) {
      if (tex === keep) continue;
      const blank = this.isProvisionalBlank(tex);
      this._provisionalCels.delete(tex);
      if (!blank) continue;   // drawn on: a real cel texture now
      const cel = this.timeline.getCels(p.layerId).find(c => c.id === p.celId);
      if (!cel || cel.texture !== tex) continue;   // deleted / re-pointed meanwhile (the timeline released it)
      if (this.timeline.takeCelTexture(p.layerId, p.celId) !== tex) continue;
      const layer = this.layers.find(l => l.id === p.layerId);
      layer?.manager?.dropHistory?.(tex);
      if (layer && layer.texture === tex) layer.texture = undefined;
      if (this._spareCel) this.destroyLater(tex);
      else this._spareCel = { tex, seq: p.seq };
      changed = true;
    }
    return changed;
  }

  /** The selected animated layer (playback stopped) gets a texture for the blank cel it shows; every other provisional
   *  texture still blank is given back. True when a cel's texture changed (re-apply the frame textures). */
  private syncLazyCels(): boolean {
    let target: { layer: RasterLayer; cel: AnimationCel } | null = null;
    const sel = this.selectedLayerId ? this.layers.find(l => l.id === this.selectedLayerId) : undefined;
    if (sel && (sel.type ?? 'layer') === 'layer' && sel.manager && this.animationEnabled && !this.timeline.isPlaying()
        && this.timeline.isLayerAnimated(sel.id)) {
      const cel = this.timeline.getCelAtFrame(sel.id, this.timeline.getCurrentFrame());
      if (cel) target = { layer: sel, cel };
    }
    let changed = this.releaseProvisionalCels(target?.cel.texture ?? null);
    if (target && !target.cel.texture && this.width > 0 && this.height > 0) {
      changed = !!this.materializeCel(target.layer, target.cel.id, true) || changed;
    }
    return changed;
  }

  /** D1 diagnostics / tests: cels with a texture vs blank, the provisional ones, the spare, and the GPU bytes the cel
   *  textures hold (a layer's own texture — cel 1 — not counted: the layer has it anyway). */
  public getCelMemoryStats(): { cels: number; withTexture: number; blank: number; provisional: number; spare: boolean; textureBytes: number } {
    let cels = 0, withTexture = 0, bytes = 0;
    const seen = new Set<GPUTexture>();
    for (const l of this.layers) {
      if ((l.type ?? 'layer') !== 'layer') continue;
      const own = l.manager?.getTexture?.() ?? null;
      for (const c of this.timeline.getCels(l.id)) {
        cels++;
        if (!c.texture) continue;
        withTexture++;
        if (c.texture !== own && !seen.has(c.texture)) { seen.add(c.texture); bytes += c.texture.width * c.texture.height * 4; }
      }
    }
    if (this._spareCel) bytes += this._spareCel.tex.width * this._spareCel.tex.height * 4;
    return { cels, withTexture, blank: cels - withTexture, provisional: this._provisionalCels.size, spare: !!this._spareCel, textureBytes: bytes };
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
    this.releaseProvisionalCels();   // D1: duplicating a still-blank cel makes a blank one (no copy)
    const cel = this.timeline.duplicateCel(layerId, celId, targetFrame, this.device, (t) => this.isTextureBlank(layerId, t));
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

  /** Cached MAP_READ staging buffer reused across the per-layer/per-cel save loops (audit §2.1 —
   *  a fresh GPUBuffer was created + destroyed per layer per autosave). Grown on demand; guarded by
   *  `_readbackBusy` so a rare concurrent readback takes a one-off buffer instead of racing the map. */
  private _readbackBuf: GPUBuffer | null = null;
  private _readbackBufSize = 0;
  private _readbackBusy = false;

  /**
   * Read raw RGBA pixel data from a GPU texture.
   * Returns an ArrayBuffer of width * height * 4 bytes (RGBA8).
   */
  public async readTexturePixels(texture: GPUTexture): Promise<ArrayBuffer> {
    const w = texture.width;
    const h = texture.height;
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const size = bytesPerRow * h;

    // Reuse the cached staging buffer when free; concurrent callers get a throwaway buffer.
    let buf: GPUBuffer;
    let oneOff = false;
    if (!this._readbackBusy) {
      if (!this._readbackBuf || this._readbackBufSize < size) {
        this._readbackBuf?.destroy();
        this._readbackBuf = this.device.createBuffer({
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this._readbackBufSize = size;
      }
      buf = this._readbackBuf;
      this._readbackBusy = true;
    } else {
      buf = this.device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      oneOff = true;
    }

    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture },
        { buffer: buf, bytesPerRow, rowsPerImage: h },
        { width: w, height: h },
      );
      this.device.queue.submit([enc.finish()]);
      // Map only the range this texture needs — the cached buffer may be larger (max size seen so far).
      await buf.mapAsync(GPUMapMode.READ, 0, size);
      const mapped = new Uint8Array(buf.getMappedRange(0, size));

      // Copy to a tightly packed buffer (remove row padding). This is a straight per-row memcpy
      // (~1–2ms for a 4K layer) — the expensive part of the save (PNG encode) runs in a worker.
      const result = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++) {
        result.set(
          mapped.subarray(row * bytesPerRow, row * bytesPerRow + w * 4),
          row * w * 4,
        );
      }
      buf.unmap();
      return result.buffer;
    } finally {
      if (oneOff) buf.destroy();
      else this._readbackBusy = false;
    }
  }

  /**
   * Export all layer pixel data as raw RGBA buffers.
   * Used by the persistence engine for fast binary saves.
   */
  /** Device-lost recovery (docs/ui/device-recovery.md): every layer texture died with the device. Re-create each BLANK
   *  on the new device so the layer stack stays valid; the document restore that follows re-uploads the pixels. */
  public recreateTexturesForNewDevice(): void {
    this._readbackBuf = null; this._readbackBufSize = 0;
    this._provisionalCels.clear(); this._spareCel = null;   // (D1: died with the device; the restore remakes the cels)
    for (const l of this.layers) {
      // (an animated layer showing a blank cel / frame has no texture now — D1 — but its manager's died too)
      if (!l.manager || (!l.texture && !this.timeline.isLayerAnimated(l.id))) continue;
      l.manager.resetForNewDevice();
      l.texture = l.manager.ensureTexture(this.width, this.height);
    }
    this.notifyCompositionChanged();
  }

  public async exportLayerPixels(): Promise<Array<{ id: string; pixelData: ArrayBuffer }>> {
    const out: Array<{ id: string; pixelData: ArrayBuffer }> = [];
    for (const l of this.layers) {
      if (!l.texture) continue;
      const pixels = await this.readTexturePixels(l.texture);
      // Skip fully-transparent layers — each costs a full-canvas RGBA→PNG but holds nothing. On load, a layer
      // whose pixel file is absent is recreated blank (its structure lives in manifest.layers), so this is lossless.
      let blank = true;
      const a = new Uint8Array(pixels);
      for (let i = 3; i < a.length; i += 4) { if (a[i] !== 0) { blank = false; break; } }
      if (blank) continue;
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
        const tex = this.celPixels(cel);   // D1: a blank cel has no pixels (absent = blank on load)
        if (!tex) continue;
        const pixels = await this.readTexturePixels(tex);
        out.push({ celId: cel.id, pixelData: pixels });
      }
    }
    return out;
  }

  /**
   * The textures exportLayerPixels / exportCelPixels read, in the same order and under the same rules (a layer
   * entry = its CURRENT texture — for an animated layer the displayed cel), without reading them. The incremental
   * autosave reads back only the ones that changed (DocumentStateCoordinator).
   */
  public getPixelSources(): { layers: Array<{ id: string; texture: GPUTexture }>; cels: Array<{ celId: string; texture: GPUTexture }> } {
    const layers: Array<{ id: string; texture: GPUTexture }> = [];
    const cels: Array<{ celId: string; texture: GPUTexture }> = [];
    for (const l of this.layers) if (l.texture) layers.push({ id: l.id, texture: l.texture });
    for (const layer of this.layers) {
      for (const cel of this.timeline.getCels(layer.id)) {
        const tex = this.celPixels(cel);   // D1: blank cels are not listed (absent = blank on load)
        if (tex) cels.push({ celId: cel.id, texture: tex });
      }
    }
    return { layers, cels };
  }

  /**
   * Content versions (raster-content-version.ts) of every PAINT layer and every cel, for a host that keeps its own copy
   * of the pixels (Frogmarks' cloud upload). A static layer's version covers both its current texture and its texture
   * manager's texture (the one exportLayerToBlob reads) when they differ. An ANIMATED layer's current texture is the
   * displayed cel (it changes with the frame), so its entry covers only the manager's texture; its pixels are versioned
   * per cel. Folders, vector / ephemera layers and 3D dividers have no pixels and are not listed. A cel without a
   * texture (blank) is `'none'`.
   */
  public getContentVersions(): { layers: Record<string, string>; cels: Record<string, string> } {
    const layers: Record<string, string> = {};
    const cels: Record<string, string> = {};
    for (const l of this.layers) {
      if ((l.type ?? 'layer') !== 'layer') continue;
      const managed = l.manager?.getTexture?.() ?? null;
      if (this.timeline.isLayerAnimated(l.id)) layers[l.id] = rasterTextureVersion(managed ?? l.texture);
      else {
        const own = rasterTextureVersion(l.texture);
        layers[l.id] = managed && managed !== l.texture ? own + '|' + rasterTextureVersion(managed) : own;
      }
      for (const cel of this.timeline.getCels(l.id)) cels[cel.id] = rasterTextureVersion(this.celPixels(cel));   // blank = 'none'
    }
    return { layers, cels };
  }

  /** One layer's pixels as an image Blob (what exportLayersAsBlobs gives for it, without reading every other layer).
   *  Null for an unknown id, a layer without pixels (folder / vector / 3D divider) or a failed read. */
  public async exportLayerToBlob(id: string, type: 'image/webp' | 'image/png' = 'image/webp'): Promise<Blob | null> {
    const l = this.layers.find(x => x.id === id);
    if (!l?.manager) return null;
    try {
      return await l.manager.exportToBlob(type);
    } catch (e) {
      console.warn('exportLayerToBlob failed for layer', id, e);
      return null;
    }
  }

  /** One animation cel's pixels as an image Blob (its own texture, not the displayed frame). Null for an unknown
   *  cel, a cel without a texture or a failed read / encode. */
  public async exportCelToBlob(celId: string, type: 'image/webp' | 'image/png' = 'image/webp'): Promise<Blob | null> {
    for (const l of this.layers) {
      if ((l.type ?? 'layer') !== 'layer') continue;
      const cel = this.timeline.getCels(l.id).find(c => c.id === celId);
      if (!cel) continue;
      const tex = this.celPixels(cel);   // D1: a blank cel has no pixels
      if (!tex) return null;
      try {
        const w = tex.width, h = tex.height;
        if (!w || !h) return null;
        const pixels = await this.readTexturePixels(tex);
        return await encodeRgbaToBlob(new Uint8ClampedArray(pixels), w, h, type);
      } catch (e) {
        console.warn('exportCelToBlob failed for cel', celId, e);
        return null;
      }
    }
    return null;
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
    systemOwner?: string;
    packageOwnerId?: string;
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
      systemOwner: l.systemOwner,
      packageOwnerId: l.packageOwnerId,
    }));
  }

  /**
   * Upload raw RGBA pixel data to a specific animation cel's texture.
   * Used by the persistence engine to restore cel pixel data.
   * The bytes also become the cel's undo seed, BORROWED (not copied) — don't modify `pixels` afterwards.
   */
  public uploadPixelsToCel(layerId: string, celId: string, pixels: ArrayBuffer): boolean {
    const cels = this.timeline.getCels(layerId);
    const cel = cels.find(c => c.id === celId);
    if (!cel) return false;
    const layer = this.layers.find(l => l.id === layerId);
    if (!cel.texture) {
      // D1: all-zero pixels on a blank cel → it stays blank (no texture); otherwise this write makes its texture
      if (pixels.byteLength === this.width * this.height * 4 && isAllZeroBytes(pixels)) return true;
      if (!layer || !this.materializeCel(layer, celId, false)) return false;
    }
    const tex = cel.texture!;
    this._provisionalCels.delete(tex);   // (written: the cel's own now)
    const w = tex.width;
    const h = tex.height;
    bumpGpuPixelEpoch('full', tex);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: this cel)
    this.device.queue.writeTexture(
      { texture: tex },
      pixels,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
    // A2/A3: the cel's undo history starts from exactly these bytes (no read-back)
    layer?.manager?.seedHistoryFromPixels?.(tex, pixels);
    if (layer && this.animationEnabled && layer.texture !== tex
        && this.timeline.getCelAtFrame(layerId, this.timeline.getCurrentFrame()) === cel) {
      layer.texture = tex;   // shown now (it was blank)
      this.syncHistoryTarget(layer);
      if (this.selectedLayerId === layerId) this.selectionCallback?.(tex, layer.manager);
      this.notifyCompositionChanged();
    }
    return true;
  }

  /**
   * Restore cels for an animated layer from saved metadata.
   * Clears existing cels (from setLayerAnimated default), creates cels with specific IDs/timing.
   * Returns the created cel IDs for pixel data upload.
   *
   * Perf audit A3: the earliest cel shows the layer's OWN texture (cleared), as cel 1 of a layer animated in-session
   * does — clearing the default cel used to DESTROY that texture while the layer's texture manager (its undo
   * history, resize, export) kept using it. Every cel starts blank with a blank undo seed; uploadPixelsToCel re-seeds
   * the ones that have pixels. D1: the other cels own no texture until their pixels are uploaded (or drawn).
   */
  public restoreLayerCels(
    layerId: string,
    celMetas: Array<{ celId: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }>,
  ): string[] {
    // First, clear the auto-created default cel from setLayerAnimated (the timeline never destroys the layer's texture)
    this.releaseProvisionalCels();
    const existingCels = this.timeline.getCels(layerId);
    for (const c of [...existingCels]) {
      this.timeline.deleteCel(layerId, c.id);
    }

    const layer = this.layers.find(l => l.id === layerId);
    const own = this.timeline.getLayerAnimationState(layerId)?.baseTexture ?? null;
    const base = own && own === layer?.manager?.getTexture?.() && own.width === this.width && own.height === this.height ? own : null;
    let first: (typeof celMetas)[number] | null = null;
    for (const m of celMetas) if (!first || m.startFrame < first.startFrame) first = m;

    // Create each cel with the saved ID and timing
    const created: string[] = [];
    for (const meta of celMetas) {
      let texture: GPUTexture | null = null;   // D1: blank (no texture) until pixels are uploaded / drawn
      if (base && meta === first) {
        texture = base;
        const enc = this.device.createCommandEncoder();
        enc.beginRenderPass({ colorAttachments: [{ view: base.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] }).end();
        this.device.queue.submit([enc.finish()]);
        bumpGpuPixelEpoch('full', base);   // (cleared: it held the layer-level pixels of the save)
      }
      const cel = this.timeline.addCelWithId(
        layerId, meta.celId, meta.startFrame, meta.duration, meta.celType, texture,
      );
      if (cel) {
        created.push(cel.id);
        if (texture) layer?.manager?.seedBlankHistory?.(texture);   // B3: blank until its pixels are uploaded
      }
    }
    return created;
  }

  /**
   * Perf audit A4: rebuild an animated layer's cels exactly — saved ids, start frames, hold durations, key / inbetween —
   * each with its own pixels (tightly packed RGBA8 at the canvas size; absent = blank). Marks the layer animated first,
   * replaces its cels, grows the timeline to hold them and shows the current frame. The `pixels` become the cels'
   * undo seeds (borrowed: don't modify them afterwards). For host imports (ShapeManager.restoreLayerCelsFromDataURLs).
   */
  public restoreCelsWithPixels(
    layerId: string,
    cels: Array<{ celId: string; startFrame: number; duration: number; celType: 'key' | 'inbetween'; pixels?: ArrayBuffer }>,
  ): string[] {
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer || (layer.type ?? 'layer') !== 'layer') return [];
    if (!this.timeline.isLayerAnimated(layerId)) this.setLayerAnimated(layerId, true);
    const metas = cels.map(c => ({
      celId: c.celId, startFrame: Math.max(1, Math.round(c.startFrame)), duration: Math.max(1, Math.round(c.duration || 1)),
      celType: c.celType,
    }));
    const ids = this.restoreLayerCels(layerId, metas);
    const expected = this.width * this.height * 4;
    for (const c of cels) {
      if (c.pixels && c.pixels.byteLength === expected && ids.includes(c.celId)) this.uploadPixelsToCel(layerId, c.celId, c.pixels);
    }
    let end = 0;
    for (const m of metas) end = Math.max(end, m.startFrame + m.duration - 1);
    if (end > this.timeline.getFrameCount()) this.timeline.setFrameCount(end);
    this.forceFrameSync();
    return ids;
  }

  /**
   * Upload raw RGBA pixel data to an existing layer's texture.
   * Used by the persistence engine to restore layer state.
   * The bytes also become the layer's undo seed when its history is still pristine, BORROWED (not copied) — don't
   * modify `pixels` afterwards.
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
    bumpGpuPixelEpoch('full', layer.texture);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: this layer)
    this.device.queue.writeTexture(
      { texture: layer.texture },
      pixels,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
    // A2 (perf audit 2026-10-09): the undo seed was read back when the layer was created — BEFORE these pixels — so
    // fill / filter / clear then Ctrl+Z on a loaded document restored a blank layer. Re-seed from the bytes in hand
    // (no read-back); a size mismatch re-seeds by reading the texture back (after this upload, in queue order).
    if (layer.manager && !layer.manager.seedHistoryFromPixels?.(layer.texture, pixels)) void layer.manager.reseedPristineHistory?.();
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
      bumpGpuPixelEpoch('full', newTex);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: the copy)
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
    bumpGpuPixelEpoch('full', lower.texture);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: the lower layer)
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

  // ── Ephemera stamp ────────────────────────────────────────────────

  /**
   * Draws an SVG string onto a layer at the given document coordinates.
   * The SVG is rendered at `stampW × stampH` pixels and composited with
   * the layer's existing content using source-over (normal blend).
   */
  public async compositeImageOntoLayer(
    layerId: string,
    svgString: string,
    x: number,
    y: number,
    stampW: number,
    stampH: number,
  ): Promise<boolean> {
    const l = this.layers.find(lx => lx.id === layerId);
    if (!l || !l.manager || !l.texture) return false;

    const w = this.width;
    const h = this.height;

    void l.manager.pushSnapshot?.();

    const existingBlob = await l.manager.exportToBlob('image/png');
    const existingBitmap = await createImageBitmap(existingBlob);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(existingBitmap, 0, 0, w, h);
    existingBitmap.close();

    // Render SVG via blob URL
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    try {
      const svgBitmap = await createImageBitmap(svgBlob, { resizeWidth: stampW, resizeHeight: stampH });
      ctx.drawImage(svgBitmap, x, y, stampW, stampH);
      svgBitmap.close();
    } finally {
      URL.revokeObjectURL(url);
    }

    const composited = await createImageBitmap(canvas);
    bumpGpuPixelEpoch('full', l.texture);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: this layer)
    this.device.queue.copyExternalImageToTexture(
      { source: composited, flipY: false },
      { texture: l.texture },
      { width: w, height: h },
    );
    await this.device.queue.onSubmittedWorkDone();
    composited.close();

    this.notifyCompositionChanged();
    return true;
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
      bumpGpuPixelEpoch('full', snap.layer.texture);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: this layer)
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
    bumpGpuPixelEpoch('full', tex);   // GPU-only pixels changed (device-lost shadow accuracy; autosave: the new layer)
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
