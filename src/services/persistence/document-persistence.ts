/**
 * DocumentPersistence — OPFS-backed auto-save / document storage.
 *
 * Serializes the full Salsa document state:
 *  • Scene graph (vector shapes) — JSON
 *  • Raster layers (pixel data) — compressed image files (PNG by default)
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
 *         {layerId}.png       — compressed layer pixel data (format per manifest.pixelFormat)
 *         {layerId}.bin       — legacy: raw RGBA (v2 saves)
 *       cels/
 *         {celId}.png         — compressed cel pixel data
 *         {celId}.bin         — legacy: raw RGBA (v2 saves)
 *
 * Auto-save fires on a configurable timer (default: 30s) and also after
 * every stroke ends (debounced). The entire save is atomic — a new temp
 * directory is written, then the old one is replaced.
 *
 * This module has ZERO coupling to UI frameworks. Frogmarks wires it
 * through ShapeManager.
 */

import { PixelFormat, pixelFormatExtension, encodePixels, decodePixels } from './pixel-codec';
import { PixelEncodePool } from './pixel-encode-pool';

export interface DocumentManifest {
  version: 2 | 3;
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
  /** Visible 2D canvas grid (per-illustration). Absent on older saves = grid off/defaults. */
  canvasGrid?: { visible: boolean; color: [number, number, number]; opacity: number; cells: number };
  /** Base64-encoded PNG thumbnail captured at save time. */
  thumbnail?: string;
  /** Pixel encoding format used for layer/cel .bin files. Absent on v2 saves = 'raw'. */
  pixelFormat?: PixelFormat;
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
  /** SYSTEM layer marker (e.g. 'packaging' for the Dieline layer) — the host Layers panel filters
   *  these out; created composite-hidden. Absent on user layers / older saves. */
  systemOwner?: string;
  /** Package layer-stack marker — the id of the package whose stack this layer belongs to (paired
   *  with `systemOwner:'packaging'`). Absent on user layers / older saves. */
  packageOwnerId?: string;
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
  /** Image format for layer pixel data. 'png' = recommended default. 'raw' = uncompressed (debug). */
  pixelFormat: PixelFormat;
}

export interface DocumentInfo {
  docId: string;
  name: string;
  savedAt: string;
  canvasWidth: number;
  canvasHeight: number;
  layerCount: number;
  /** Base64 thumbnail from the manifest, if present. Lets galleries / the
   *  shell dashboard render art without loading full documents. */
  thumbnail?: string;
}

const DEFAULT_CONFIG: AutoSaveConfig = {
  intervalMs: 30_000,
  strokeDebounceMs: 5_000,
  pixelFormat: 'png',
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
  /** Saves completed since construction — used to throttle orphan pruning (see writeToOPFS). */
  private saveCount = 0;
  /** Orphan-prune cadence: prune on the first save, then every Nth (listing 5 OPFS dirs per save is wasted
   *  work when nothing was deleted; the deletion paths live outside this module, so throttle instead). */
  private static readonly PRUNE_EVERY_N_SAVES = 8;
  /** Worker pool that PNG-encodes layer/cel pixels OFF the main thread (audit §2.1 — the per-layer encode
   *  was the dominant autosave stall). Lazily created on first save; null after a failed construction so
   *  we don't retry per save. Falls back to main-thread encodePixels when unavailable. */
  private encodePool: PixelEncodePool | null = null;
  private encodePoolTried = false;

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
        // Queue ONE trailing save, routed through triggerSave() so it re-checks isSaving —
        // calling executeSave() directly could run concurrently with a save started in the
        // 100ms gap, and rapid mutation would chain save-after-save instead of collapsing
        // into a single trailing save.
        setTimeout(() => this.triggerSave(), 100);
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

    // Write layer pixel data. The PNG encode runs in the worker pool (off the main thread — audit §2.1);
    // layers+cels encode concurrently across the pool, then the OPFS writes stay sequential as before.
    const fmt = this.config.pixelFormat;
    const ext = pixelFormatExtension(fmt);
    const w = payload.manifest.canvasWidth;
    const h = payload.manifest.canvasHeight;
    const layersDir = await dir.getDirectoryHandle('layers', { create: true });
    const encodedLayers = await Promise.all(payload.layers.map(async (layer) => ({
      id: layer.id, encoded: await this.encodeForSave(layer.pixelData, w, h, fmt),
    })));
    for (const { id, encoded } of encodedLayers) {
      await this.writeBinary(layersDir, `${id}.${ext}`, encoded);
    }

    // Write animation cel pixel data
    if (payload.cels && payload.cels.length > 0) {
      const celsDir = await dir.getDirectoryHandle('cels', { create: true });
      const encodedCels = await Promise.all(payload.cels.map(async (cel) => ({
        celId: cel.celId, encoded: await this.encodeForSave(cel.pixelData, w, h, fmt),
      })));
      for (const { celId, encoded } of encodedCels) {
        await this.writeBinary(celsDir, `${celId}.${ext}`, encoded);
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

    // Write UV-painted mesh textures (PNG) keyed by mesh ID.
    if (payload.meshTextures && Object.keys(payload.meshTextures).length > 0) {
      const meshTexDir = await dir.getDirectoryHandle('meshTextures', { create: true });
      for (const [meshId, buffer] of Object.entries(payload.meshTextures)) {
        await this.writeBinary(meshTexDir, `${meshId}.png`, buffer);
      }
    }

    // Write baked kitbash parts (generated garments/hair) as GLB keyed by part id.
    if (payload.bakedParts && Object.keys(payload.bakedParts).length > 0) {
      const bakedDir = await dir.getDirectoryHandle('bakedParts', { create: true });
      for (const [partId, buffer] of Object.entries(payload.bakedParts)) {
        await this.writeBinary(bakedDir, `${partId}.glb`, buffer);
      }
    }

    // Write texture library snapshot (base64 data URLs for material textures)
    if (payload.textureLibrary) {
      await this.writeJSON(dir, 'textures3d.json', payload.textureLibrary);
    }

    // Write ephemera placements + sheets
    if (payload.ephemeraJSON) {
      await this.writeText(dir, 'ephemera.json', payload.ephemeraJSON);
    }

    // Prune ORPHANED files — deleted layers/cels/textures leave their files on disk (writes never remove them),
    // so a doc directory balloons over an editing session (draw on N layers, delete them → N stale PNGs remain).
    // Delete anything in each managed subdir that isn't referenced by the CURRENT payload. (A now-blank layer is
    // also skipped by exportLayerPixels, so its stale file is pruned here too — recreated blank on load.)
    // Throttled: a full OPFS listing × 5 dirs on EVERY save is wasted work when nothing was deleted, and the
    // deletion paths live in managers this module can't see — so prune on the first save and then every Nth.
    // Orphans are only ever cleaned up *late*, never missed (worst case: stale files linger a few saves).
    if (this.saveCount % DocumentPersistence.PRUNE_EVERY_N_SAVES === 0) {
      await this.pruneDir(dir, 'layers',       new Set(payload.layers.map(l => `${l.id}.${ext}`)));
      await this.pruneDir(dir, 'cels',         new Set((payload.cels ?? []).map(c => `${c.celId}.${ext}`)));
      await this.pruneDir(dir, 'models3d',     new Set(Object.keys(payload.models3d ?? {}).map(k => `${k}.glb`)));
      await this.pruneDir(dir, 'meshTextures', new Set(Object.keys(payload.meshTextures ?? {}).map(k => `${k}.png`)));
      await this.pruneDir(dir, 'bakedParts',   new Set(Object.keys(payload.bakedParts ?? {}).map(k => `${k}.glb`)));
    }
    this.saveCount++;
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

      // Determine pixel format from manifest — v2 saves have no pixelFormat field, treat as 'raw'.
      const fmt: PixelFormat = (manifest.version >= 3 && manifest.pixelFormat)
        ? manifest.pixelFormat
        : 'raw';
      const ext = pixelFormatExtension(fmt);

      // Read all layer pixel files in parallel — same pattern as Frogmarks' Azure download fix.
      // Sequential awaits here were the dominant cost in loadDocument() (e.g. ~341ms for 9 layers).
      const layers: LayerPixelData[] = [];
      if (layersDir) {
        const results = await Promise.all(
          manifest.layers.map(async (entry) => {
            try {
              // Try format-specific extension first, fall back to .bin for legacy v2 saves.
              const raw = await this.readBinary(layersDir, `${entry.id}.${ext}`)
                ?? await this.readBinary(layersDir, `${entry.id}.bin`);
              if (!raw) return null;
              const { rgba } = await decodePixels(raw, fmt);
              return { id: entry.id, pixelData: rgba };
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
                const raw = await this.readBinary(celsDir, `${celMeta.celId}.${ext}`)
                  ?? await this.readBinary(celsDir, `${celMeta.celId}.bin`);
                if (!raw) return null;
                const { rgba } = await decodePixels(raw, fmt);
                return { celId: celMeta.celId, pixelData: rgba };
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

      // Read 3D model buffers / UV-painted mesh textures / baked kitbash parts — all three
      // directories in parallel, and all files within each in parallel (same pattern as the
      // layers/cels reads above; sequential awaits here serialized potentially large GLB reads).
      const [models3d, meshTextures, bakedParts] = await Promise.all([
        this.readDirBuffers(dir, 'models3d', '.glb'),
        this.readDirBuffers(dir, 'meshTextures', '.png'),
        this.readDirBuffers(dir, 'bakedParts', '.glb'),
      ]);

      // Read texture library snapshot
      const textureLibrary = await this.readJSON<{ entries: any[] }>(dir, 'textures3d.json');

      // Read ephemera placements + sheets
      const ephemeraJSON = await this.readText(dir, 'ephemera.json');

      return { manifest, sceneGraphJSON, brushPresetsJSON, layers, cels, scene3dJSON, models3d, meshTextures, bakedParts, textureLibrary, ephemeraJSON };
    } catch (e) {
      // A brand-new document that was never saved has no OPFS directory yet —
      // getDocDir() throws NotFoundError. That's an expected "nothing to load",
      // not a failure, so don't surface it as a console error.
      if (e instanceof DOMException && e.name === 'NotFoundError') return null;
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
              thumbnail: manifest.thumbnail,
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

  /**
   * Rename a saved document by rewriting `name` in its manifest. Returns
   * false if the document doesn't exist or has no manifest.
   */
  public async renameDocument(docId: string, name: string): Promise<boolean> {
    if (!isOPFSAvailable()) return false;
    try {
      const dir = await this.getDocDir(docId, false);
      const manifest = await this.readJSON<DocumentManifest>(dir, 'manifest.json');
      if (!manifest) return false;
      manifest.name = name;
      await this.writeJSON(dir, 'manifest.json', manifest);
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
    this.encodePool?.dispose();
    this.encodePool = null;
    this.encodePoolTried = false;
  }

  /**
   * Encode layer/cel pixels for a save — via the worker pool when available (off the main thread),
   * falling back to the main-thread `encodePixels` when Workers/OffscreenCanvas are unavailable
   * (headless) or a worker fails mid-encode (the pool clones rather than transfers the input buffer,
   * so the fallback always still has the pixels — a worker failure can never lose a save).
   */
  private async encodeForSave(rgba: ArrayBuffer, w: number, h: number, fmt: PixelFormat): Promise<ArrayBuffer> {
    if (fmt === 'raw') return rgba;
    if (!this.encodePoolTried) {
      this.encodePoolTried = true;
      const pool = new PixelEncodePool();
      if (pool.available) this.encodePool = pool;
      else pool.dispose();   // headless / no OffscreenCanvas — stay on the sync path for this instance
    }
    if (this.encodePool?.available) {
      try {
        return await this.encodePool.encode(rgba, w, h, fmt);
      } catch { /* worker error — fall through to the main-thread encoder */ }
    }
    return encodePixels(rgba, w, h, fmt);
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
    // gzip the JSON blobs (scene / scene3d / brushes / ephemera) — highly compressible plain text (skeleton
    // matrices + rigs as number arrays). readText auto-detects the gzip magic bytes, so LEGACY raw-text saves
    // still load; and if gzip is unavailable we fall back to raw text (still readable — no magic → treated as text).
    let data: ArrayBuffer | string = text;
    try { data = await this.gzipText(text); } catch { data = text; }
    await writable.write(data);
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
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // gzip magic (0x1f 0x8b) → decompress; otherwise legacy raw UTF-8 text (JSON never starts with these bytes).
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return await this.gunzipToText(buf);
      return new TextDecoder().decode(buf);
    } catch {
      return null;
    }
  }

  /** Read every `*{ext}` file in `parent/dirName` → Record keyed by basename (ext stripped).
   *  Collects the handles first, then reads all files via Promise.all — sequential awaits per
   *  file were the dominant cost for large GLB/PNG sidecars. Returns {} if the subdir is
   *  absent (older save). */
  private async readDirBuffers(
    parent: FileSystemDirectoryHandle,
    dirName: string,
    ext: string,
  ): Promise<Record<string, ArrayBuffer>> {
    const out: Record<string, ArrayBuffer> = {};
    try {
      const dir = await parent.getDirectoryHandle(dirName);
      const fileEntries: Array<[string, FileSystemFileHandle]> = [];
      for await (const [name, handle] of (dir as any).entries()) {
        if ((handle as FileSystemFileHandle).kind === 'file' && name.endsWith(ext)) {
          fileEntries.push([name, handle as FileSystemFileHandle]);
        }
      }
      await Promise.all(fileEntries.map(async ([name, handle]) => {
        const file = await handle.getFile();
        out[name.slice(0, -ext.length)] = await file.arrayBuffer();
      }));
    } catch { /* no such directory — older save, skip */ }
    return out;
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

  /** gzip a UTF-8 string → bytes (native CompressionStream) — compresses the JSON blobs at rest. */
  private async gzipText(text: string): Promise<ArrayBuffer> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  /** gunzip bytes → UTF-8 string (native DecompressionStream). */
  private async gunzipToText(buf: ArrayBuffer): Promise<string> {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  /** Delete files in `parent/dirName` whose name isn't in `keep` — prunes ORPHANS left by deleted layers /
   *  textures / cels (writes never remove old files, so the doc directory grows over an editing session). No-op
   *  if the subdir is absent. */
  private async pruneDir(parent: FileSystemDirectoryHandle, dirName: string, keep: Set<string>): Promise<void> {
    let dir: FileSystemDirectoryHandle;
    try { dir = await parent.getDirectoryHandle(dirName); } catch { return; }   // subdir doesn't exist yet
    const stale: string[] = [];
    try { for await (const name of (dir as any).keys()) if (!keep.has(name)) stale.push(name); } catch { return; }
    for (const name of stale) { try { await dir.removeEntry(name); } catch { /* best-effort */ } }
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
  /** UV-painted diffuse textures keyed by mesh ID (PNG bytes) — from the UV paint tool. */
  meshTextures?: Record<string, ArrayBuffer>;
  /** Baked kitbash parts (generated garments/hair) → GLB bytes keyed by part id. Metadata to
   *  re-register them rides in scene3dJSON (`bakedPartMetas`). */
  bakedParts?: Record<string, ArrayBuffer>;
  /** TextureLibrary snapshot including base64 data URLs — needed to restore GPU textures. */
  textureLibrary?: { entries: any[] } | null;
  /** Serialised ephemera placements + sheets — needed to restore vector layer overlay content. */
  ephemeraJSON?: string | null;
  /** GARP pools + skin texture sources (docs/ui/garp.md) — user-authored asset-pool variants. Sources are
   *  DecalSources (ephemera params / image dataUrls); atlas layers are session-local and NOT serialized. */
  garpJSON?: { pools: unknown[]; textures: Record<string, unknown> } | null;
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
