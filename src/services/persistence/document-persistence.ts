/**
 * DocumentPersistence — OPFS-backed auto-save / document storage.
 *
 * Serializes the full Salsa document state:
 *  • Scene graph (vector shapes) — JSON
 *  • Raster layers (pixel data) — binary PNG/WebP blobs
 *  • Raster layer metadata (name, visibility, blend mode, opacity, etc.)
 *  • Animation timeline state (frames, cels, onion skin config)
 *  • Brush presets — JSON
 *
 * Storage layout in OPFS:
 *   /salsa-documents/
 *     {docId}/
 *       manifest.json         — document metadata + layer order + animation state
 *       scene.json            — scene graph (vector shapes)
 *       brushes.json          — brush presets
 *       layers/
 *         {layerId}.bin       — raw RGBA pixel data for each layer
 *         {layerId}.meta.json — per-layer metadata
 *       cels/
 *         {celId}.bin         — raw RGBA pixel data for each animation cel
 *
 * Auto-save fires on a configurable timer (default: 30s) and also after
 * every stroke ends (debounced). The entire save is atomic — a new temp
 * directory is written, then the old one is replaced.
 *
 * This module has ZERO coupling to UI frameworks. Frogmarks wires it
 * through ShapeManager.
 */

export interface DocumentManifest {
  version: 2;
  docId: string;
  name: string;
  createdAt: string;
  savedAt: string;
  canvasWidth: number;
  canvasHeight: number;
  /**
   * Explicit document pixel size set via setDocumentSize().
   * null / absent = infinite-canvas mode.
   * canvasWidth/canvasHeight record the ACTUAL layer texture dimensions at save time
   * and may differ from documentSize if the canvas was resized between setDocumentSize
   * and save (causing layers to be temporarily downscaled).
   */
  documentSize?: { w: number; h: number } | null;
  layers: LayerManifestEntry[];
  animation: AnimationManifestState | null;
  /** Global dither configuration (applies to the compositor output). */
  globalDitherConfig?: any;
  /** Base64-encoded PNG thumbnail captured at save time. */
  thumbnail?: string;
}

export interface LayerManifestEntry {
  id: string;
  name: string;
  /** Layer entry type: 'layer' (default), 'folder', or '3d-scene' (divider). */
  type?: string;
  parentId?: string | null;
  collapsed?: boolean;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  clipped: boolean;
  lockTransparency: boolean;
  /** If animated, list of cel ids. If static, empty array. */
  celIds: string[];
  animationType: 'static' | 'animated';
  /** Per-layer dither configuration, if set. */
  ditherConfig?: any;
  /** Per-layer frame link animation configuration, if set. */
  frameLinkAnimation?: any;
}

export interface AnimationManifestState {
  fps: number;
  frameCount: number;
  loopMode: string;
  playRangeStart: number;
  playRangeEnd: number;
  onionSkin: {
    enabled: boolean;
    framesBefore: number;
    framesAfter: number;
    opacity: number;
    tintBefore: [number, number, number];
    tintAfter: [number, number, number];
  };
  /** Per-layer cel metadata keyed by layer id. */
  cels: Record<string, Array<{
    celId: string;
    startFrame: number;
    duration: number;
    celType: 'key' | 'inbetween';
  }>>;
}

export interface AutoSaveConfig {
  /** Auto-save interval in milliseconds. 0 = disabled. Default: 30000 (30s). */
  intervalMs: number;
  /** Debounce time after stroke end before saving. Default: 5000 (5s). */
  strokeDebounceMs: number;
  /** Image format for layer pixel data. 'raw' = uncompressed RGBA (fast), 'webp' = compressed (small). */
  pixelFormat: 'raw' | 'webp';
}

export interface DocumentInfo {
  docId: string;
  name: string;
  savedAt: string;
  canvasWidth: number;
  canvasHeight: number;
  layerCount: number;
}

const DEFAULT_CONFIG: AutoSaveConfig = {
  intervalMs: 30_000,
  strokeDebounceMs: 5_000,
  pixelFormat: 'raw',
};

/**
 * Check if OPFS is available in this browser.
 */
export function isOPFSAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage;
}

export class DocumentPersistence {
  private config: AutoSaveConfig;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private strokeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSaving = false;
  private savePending = false;

  // Callbacks (set by ShapeManager)
  private getDocumentState: (() => Promise<DocumentSavePayload>) | null = null;
  private onSaveStart: (() => void) | null = null;
  private onSaveComplete: ((success: boolean) => void) | null = null;

  constructor(config?: Partial<AutoSaveConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Configuration ─────────────────────────────────────────────────

  public setConfig(config: Partial<AutoSaveConfig>): void {
    this.config = { ...this.config, ...config };
    // Restart timer if running
    if (this.autoSaveTimer !== null) {
      this.stopAutoSave();
      this.startAutoSave();
    }
  }

  public getConfig(): AutoSaveConfig {
    return { ...this.config };
  }

  /**
   * Set the callback that gathers the full document state.
   * ShapeManager provides this.
   */
  public setStateProvider(fn: () => Promise<DocumentSavePayload>): void {
    this.getDocumentState = fn;
  }

  /** Set callbacks for save lifecycle (for UI indicators). */
  public setSaveCallbacks(
    onStart?: () => void,
    onComplete?: (success: boolean) => void,
  ): void {
    this.onSaveStart = onStart ?? null;
    this.onSaveComplete = onComplete ?? null;
  }

  // ── Auto-save lifecycle ───────────────────────────────────────────

  public startAutoSave(): void {
    if (this.config.intervalMs <= 0) return;
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(() => {
      this.triggerSave();
    }, this.config.intervalMs);
  }

  public stopAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Called by the brush engine when a stroke ends.
   * Triggers a debounced save after strokeDebounceMs.
   */
  public notifyStrokeEnd(): void {
    if (this.config.strokeDebounceMs <= 0) return;
    if (this.strokeDebounceTimer !== null) {
      clearTimeout(this.strokeDebounceTimer);
    }
    this.strokeDebounceTimer = setTimeout(() => {
      this.triggerSave();
      this.strokeDebounceTimer = null;
    }, this.config.strokeDebounceMs);
  }

  /** Trigger a save now (debounced if one is already in progress). */
  public async triggerSave(): Promise<boolean> {
    if (this.isSaving) {
      this.savePending = true;
      return false;
    }
    return this.executeSave();
  }

  /** Force an immediate save (bypasses debounce). */
  public async saveNow(): Promise<boolean> {
    return this.executeSave();
  }

  private async executeSave(): Promise<boolean> {
    if (!this.getDocumentState || !isOPFSAvailable()) return false;

    this.isSaving = true;
    this.onSaveStart?.();

    try {
      const payload = await this.getDocumentState();
      await this.writeToOPFS(payload);
      payload._onWriteComplete?.();
      this.onSaveComplete?.(true);
      return true;
    } catch (e) {
      console.error('[DocumentPersistence] Save failed:', e);
      this.onSaveComplete?.(false);
      return false;
    } finally {
      this.isSaving = false;
      if (this.savePending) {
        this.savePending = false;
        // Queue another save
        setTimeout(() => this.executeSave(), 100);
      }
    }
  }

  // ── OPFS read/write ───────────────────────────────────────────────

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('salsa-documents', { create: true });
  }

  private async getDocDir(docId: string, create = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.getRoot();
    return root.getDirectoryHandle(docId, { create });
  }

  private async writeToOPFS(payload: DocumentSavePayload): Promise<void> {
    const dir = await this.getDocDir(payload.manifest.docId, true);

    // Write manifest
    await this.writeJSON(dir, 'manifest.json', payload.manifest);

    // Write scene graph
    if (payload.sceneGraphJSON) {
      await this.writeText(dir, 'scene.json', payload.sceneGraphJSON);
    }

    // Write brush presets
    if (payload.brushPresetsJSON) {
      await this.writeText(dir, 'brushes.json', payload.brushPresetsJSON);
    }

    // Write layer pixel data
    const layersDir = await dir.getDirectoryHandle('layers', { create: true });
    for (const layer of payload.layers) {
      await this.writeBinary(layersDir, `${layer.id}.bin`, layer.pixelData);
    }

    // Write animation cel pixel data
    if (payload.cels && payload.cels.length > 0) {
      const celsDir = await dir.getDirectoryHandle('cels', { create: true });
      for (const cel of payload.cels) {
        await this.writeBinary(celsDir, `${cel.celId}.bin`, cel.pixelData);
      }
    }

    // Write 3D scene state
    if (payload.scene3dJSON) {
      await this.writeText(dir, 'scene3d.json', payload.scene3dJSON);
    }

    // Write 3D model buffers (GLB bytes per imported mesh)
    if (payload.models3d && Object.keys(payload.models3d).length > 0) {
      const models3dDir = await dir.getDirectoryHandle('models3d', { create: true });
      for (const [meshId, buffer] of Object.entries(payload.models3d)) {
        await this.writeBinary(models3dDir, `${meshId}.glb`, buffer);
      }
    }

    // Write texture library snapshot (base64 data URLs for material textures)
    if (payload.textureLibrary) {
      await this.writeJSON(dir, 'textures3d.json', payload.textureLibrary);
    }
  }

  /**
   * Load a document from OPFS. Returns a payload that ShapeManager
   * can use to restore the full document state.
   */
  public async loadDocument(docId: string): Promise<DocumentSavePayload | null> {
    if (!isOPFSAvailable()) return null;

    try {
      const dir = await this.getDocDir(docId);

      // Read manifest
      const manifest = await this.readJSON<DocumentManifest>(dir, 'manifest.json');
      if (!manifest) return null;

      // Read scene
      const sceneGraphJSON = await this.readText(dir, 'scene.json');

      // Read brush presets
      const brushPresetsJSON = await this.readText(dir, 'brushes.json');

      // Read layer pixels
      let layersDir: FileSystemDirectoryHandle;
      try {
        layersDir = await dir.getDirectoryHandle('layers');
      } catch {
        layersDir = null as any;
      }

      // Read all layer pixel files in parallel — same pattern as Frogmarks' Azure download fix.
      // Sequential awaits here were the dominant cost in loadDocument() (e.g. ~341ms for 9 layers).
      const layers: LayerPixelData[] = [];
      if (layersDir) {
        const results = await Promise.all(
          manifest.layers.map(async (entry) => {
            try {
              const pixels = await this.readBinary(layersDir, `${entry.id}.bin`);
              return pixels ? { id: entry.id, pixelData: pixels } : null;
            } catch {
              return null; // Layer file missing — will be a blank layer
            }
          }),
        );
        for (const r of results) { if (r) layers.push(r); }
      }

      // Read animation cels
      const cels: CelPixelData[] = [];
      if (manifest.animation) {
        let celsDir: FileSystemDirectoryHandle;
        try {
          celsDir = await dir.getDirectoryHandle('cels');
        } catch {
          celsDir = null as any;
        }

        if (celsDir) {
          // Flatten all cel metadata across all layers, then read all files in parallel.
          const allCelMetas = Object.values(manifest.animation.cels).flat();
          const celResults = await Promise.all(
            allCelMetas.map(async (celMeta) => {
              try {
                const pixels = await this.readBinary(celsDir, `${celMeta.celId}.bin`);
                return pixels ? { celId: celMeta.celId, pixelData: pixels } : null;
              } catch {
                return null; // Cel file missing
              }
            }),
          );
          for (const r of celResults) { if (r) cels.push(r); }
        }
      }

      // Read 3D scene state
      const scene3dJSON = await this.readText(dir, 'scene3d.json');

      // Read 3D model buffers
      const models3d: Record<string, ArrayBuffer> = {};
      try {
        const models3dDir = await dir.getDirectoryHandle('models3d');
        for await (const [name, handle] of (models3dDir as any).entries()) {
          if ((handle as FileSystemFileHandle).kind === 'file' && name.endsWith('.glb')) {
            const file = await (handle as FileSystemFileHandle).getFile();
            models3d[name.replace('.glb', '')] = await file.arrayBuffer();
          }
        }
      } catch { /* no models3d directory — older save, skip */ }

      // Read texture library snapshot
      const textureLibrary = await this.readJSON<{ entries: any[] }>(dir, 'textures3d.json');

      return { manifest, sceneGraphJSON, brushPresetsJSON, layers, cels, scene3dJSON, models3d, textureLibrary };
    } catch (e) {
      console.error('[DocumentPersistence] Load failed:', e);
      return null;
    }
  }

  /**
   * List all saved documents.
   */
  public async listDocuments(): Promise<DocumentInfo[]> {
    if (!isOPFSAvailable()) return [];
    try {
      const root = await this.getRoot();
      const docs: DocumentInfo[] = [];
      for await (const [, handle] of (root as any).entries()) {
        if (handle.kind !== 'directory') continue;
        try {
          const manifest = await this.readJSON<DocumentManifest>(handle, 'manifest.json');
          if (manifest) {
            docs.push({
              docId: manifest.docId,
              name: manifest.name,
              savedAt: manifest.savedAt,
              canvasWidth: manifest.canvasWidth,
              canvasHeight: manifest.canvasHeight,
              layerCount: manifest.layers.length,
            });
          }
        } catch {
          // Corrupted doc directory — skip
        }
      }
      return docs.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } catch {
      return [];
    }
  }

  /**
   * Delete a saved document from OPFS.
   */
  public async deleteDocument(docId: string): Promise<boolean> {
    if (!isOPFSAvailable()) return false;
    try {
      const root = await this.getRoot();
      await root.removeEntry(docId, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  public destroy(): void {
    this.stopAutoSave();
    if (this.strokeDebounceTimer !== null) {
      clearTimeout(this.strokeDebounceTimer);
    }
  }

  // ── File helpers ──────────────────────────────────────────────────

  private async writeJSON(dir: FileSystemDirectoryHandle, name: string, data: any): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  }

  private async writeText(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
  }

  private async writeBinary(dir: FileSystemDirectoryHandle, name: string, data: ArrayBuffer): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  private async readJSON<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
    try {
      const file = await dir.getFileHandle(name);
      const blob = await file.getFile();
      const text = await blob.text();
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async readText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
    try {
      const file = await dir.getFileHandle(name);
      const blob = await file.getFile();
      return blob.text();
    } catch {
      return null;
    }
  }

  private async readBinary(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
    try {
      const file = await dir.getFileHandle(name);
      const blob = await file.getFile();
      return blob.arrayBuffer();
    } catch {
      return null;
    }
  }
}

// ── Payload types ─────────────────────────────────────────────────

export interface DocumentSavePayload {
  manifest: DocumentManifest;
  sceneGraphJSON: string | null;
  brushPresetsJSON: string | null;
  layers: LayerPixelData[];
  cels?: CelPixelData[];
  /** Serialised 3D mesh node states (JSON array of Mesh3D.toJSON() + glbMeshId). */
  scene3dJSON?: string | null;
  /** Raw GLB buffers keyed by mesh ID — only populated for GLTF-imported meshes. */
  models3d?: Record<string, ArrayBuffer>;
  /** TextureLibrary snapshot including base64 data URLs — needed to restore GPU textures. */
  textureLibrary?: { entries: any[] } | null;
  /**
   * Called by DocumentPersistence after writeToOPFS succeeds.
   * ShapeManager sets this to clearDirtyMeshState3D() when 3D state is included,
   * so dirty flags are cleared only after the data is confirmed on disk.
   */
  _onWriteComplete?: () => void;
}

export interface LayerPixelData {
  id: string;
  pixelData: ArrayBuffer;
}

export interface CelPixelData {
  celId: string;
  pixelData: ArrayBuffer;
}
