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
 * every stroke ends (debounced). The manifest is written LAST (the commit record).
 *
 * INCREMENTAL (2026-10-06): each instance remembers what it last wrote (or loaded) file by file — JSON text, binary
 * bytes, and an opaque CONTENT KEY per layer / cel PNG (payload.pixelContentKeys) — and an automatic save writes only
 * the files that differ. When nothing differs it writes nothing at all (an idle timed save costs the gather only, no
 * GPU read-back: DocumentStateCoordinator serves unchanged pixels from its cache). The record is trusted only while
 * the on-disk manifest still carries the savedAt it was taken with (another tab or instance writing the document →
 * full write), is committed only after a write completes, and is dropped on any failure. Explicit saves (saveNow)
 * ignore it and write everything.
 *
 * This module has ZERO coupling to UI frameworks. Frogmarks wires it
 * through ShapeManager.
 */

import { DOCUMENT_SCHEMA_VERSION, isNewerThanThisBuild, schemaVersionOf } from './schema-version';
import { PixelFormat, pixelFormatExtension, encodePixels, decodePixels } from './pixel-codec';
import { PixelEncodePool } from './pixel-encode-pool';

export interface DocumentManifest {
  version: 2 | 3;
  /** Document SCHEMA version (schema-version.ts). Absent = v1 (saved before versioning). NOT the same as `version`,
   *  which only selects the pixel format. A build refuses to save over a doc with a higher schemaVersion. */
  schemaVersion?: number;
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

/**
 * Run `fn` holding an exclusive per-document Web Lock, so two tabs (or two DocumentPersistence instances) saving the
 * same document can't interleave their writes file by file (audit 2026-09-28 P9). Falls back to running unlocked where
 * the Locks API is unavailable (older browsers, tests). Last writer still wins — this prevents a MIXED document.
 */
export async function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined);
  if (!locks?.request) return fn();
  return locks.request(`salsa-doc:${docId}`, { mode: 'exclusive' }, () => fn()) as Promise<T>;
}

export class DocumentPersistence {
  private config: AutoSaveConfig;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private strokeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The queued trailing save (runSave's "one more" after a save that had a change arrive mid-write). */
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private isSaving = false;
  private savePending = false;
  /** >0 while a document is being restored (see suspend()). Blocks EVERY save — automatic AND explicit — because a
   *  half-restored scene must never be written (it would land in whichever doc id is current, corrupting it). */
  private suspendDepth = 0;
  /** Non-null = saving is blocked until cleared (e.g. a document restore threw, so the on-screen state is partial;
   *  autosaving it would overwrite the good copy on disk). Cleared by setSaveBlocked(null). */
  private saveBlockedReason: string | null = null;
  /** The save currently writing (if any) — suspend() waits on it so a load never interleaves with a write. */
  private inFlight: Promise<boolean> | null = null;
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
  private getDocumentState: ((opts?: { explicit?: boolean }) => Promise<DocumentSavePayload>) | null = null;
  /** What this instance last wrote / loaded, file by file (see the header: INCREMENTAL). Null = unknown → write all. */
  private written: WriteRecord | null = null;
  /** Diagnostics / tests: saves that wrote, saves that found nothing to write, and files written / left as they were. */
  public readonly writeStats = { writes: 0, unchanged: 0, filesWritten: 0, filesSkipped: 0 };
  /** The files the last write wrote (paths relative to the document folder). */
  public lastWrittenFiles: string[] = [];
  private onSaveStart: (() => void) | null = null;
  private onSaveComplete: ((success: boolean) => void) | null = null;
  /** When set and it returns true, all AUTOMATIC saves skip — e.g. Play mode is active, where the scene is
   *  mid-animation (walked-to positions, mid-stride pose, follow-cam) and persisting a transient frame would
   *  reload the doc in that frame (a fallen avatar underground, etc.). Gates every internal path — the auto-save
   *  timer, the stroke-debounce, and the trailing "one more" save — via triggerSave(). Only an EXPLICIT
   *  saveNow() bypasses it (a deliberate user/host save). */
  private busyPredicate: (() => boolean) | null = null;
  public setBusyPredicate(fn: (() => boolean) | null): void { this.busyPredicate = fn; }
  /** A counter that moves whenever a busy period STARTS (e.g. the GPU device-loss count). A save whose gather spanned
   *  a whole busy period (the device was lost AND recovered while it read back pixels, so later layers may have been
   *  read from the new device's still-blank textures) is not written; it is deferred like a busy one. */
  private busyEpoch: (() => number) | null = null;
  public setBusyEpochProvider(fn: (() => number) | null): void { this.busyEpoch = fn; }
  /** Called when an explicit save (saveNow) has to wait for the editor to go idle — for a host notice. */
  private onDeferred: (() => void) | null = null;
  public setDeferredCallback(fn: (() => void) | null): void { this.onDeferred = fn; }
  /** When set and it returns true, the automatic TIMED saves (interval, stroke debounce, trailing) WAIT instead of
   *  running — e.g. raster timeline playback, where a save's read-back + PNG encode is a visible hitch. Unlike the busy
   *  predicate nothing is dropped: one save runs as soon as it clears (or after MAX_SOFT_DEFER_MS, so a timeline left
   *  playing can't hold unsaved work forever). Tab-hide / pagehide flushes and explicit saveNow() don't wait. */
  private deferPredicate: (() => boolean) | null = null;
  public setDeferPredicate(fn: (() => boolean) | null): void { this.deferPredicate = fn; }
  private static readonly MAX_SOFT_DEFER_MS = 120_000;
  private softDeferTimer: ReturnType<typeof setInterval> | null = null;
  private softDeferSince = 0;

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
   * ShapeManager provides this. `opts.explicit` = a saveNow() (the provider may then read every pixel fresh); an
   * automatic save passes false (the provider may serve unchanged pixels from a cache, with content keys).
   */
  public setStateProvider(fn: (opts?: { explicit?: boolean }) => Promise<DocumentSavePayload>): void {
    this.getDocumentState = fn;
  }

  /** Take over another instance's write record (a host re-enabling autosave builds a new instance — the record is
   *  re-validated against the disk on every save, so carrying it over is always safe). */
  public inheritWriteRecord(from: DocumentPersistence | null | undefined): void {
    if (!this.written && from?.written) this.written = from.written;
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
    this.attachFlushListeners();
    this.autoSaveTimer = setInterval(() => {
      if (this.busyPredicate?.()) return;   // e.g. Play mode active — don't persist a transient animation frame
      this.triggerDeferrableSave();
    }, this.config.intervalMs);
  }

  /** An automatic timed save: runs now, or — while the defer predicate holds — once it clears (see setDeferPredicate).
   *  Calls made while one is waiting share it. */
  private triggerDeferrableSave(): void {
    if (this.softDeferTimer !== null) return;   // one already waiting covers this request
    if (!this.deferPredicate?.()) { void this.triggerSave(); return; }
    this.softDeferSince = Date.now();
    this.softDeferTimer = setInterval(() => {
      if (this.deferPredicate?.() && Date.now() - this.softDeferSince < DocumentPersistence.MAX_SOFT_DEFER_MS) return;
      this.clearSoftDefer();
      void this.triggerSave();
    }, DocumentPersistence.DEFER_POLL_MS);
  }

  private clearSoftDefer(): void {
    if (this.softDeferTimer !== null) { clearInterval(this.softDeferTimer); this.softDeferTimer = null; }
  }

  public stopAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.detachFlushListeners();
  }

  /** Drop every automatic save that has not started yet: the stroke debounce, the queued trailing save and a save
   *  deferred until Play ends (its promise resolves false). A save already writing finishes. For a host leaving the
   *  document (after saving it) — a pending one would otherwise fire later against whatever is on screen then. */
  public cancelPendingSaves(): void {
    if (this.strokeDebounceTimer !== null) { clearTimeout(this.strokeDebounceTimer); this.strokeDebounceTimer = null; }
    this.savePending = false;
    if (this.trailingTimer !== null) { clearTimeout(this.trailingTimer); this.trailingTimer = null; }
    this.clearSoftDefer();
    this.cancelDeferred();
  }

  // ── Flush on tab hide / close (audit 2026-09-28 P9) ───────────────
  // 3D + vector edits otherwise reach disk only via the interval — up to intervalMs (30s) of work was lost when the
  // tab closed. `visibilitychange → hidden` fires first when a tab is switched away OR closed and leaves time for an
  // async OPFS write; `pagehide` is the last-chance backup (best-effort — the browser may not wait for it). Both go
  // through triggerSave, so they respect the busy predicate / load guard / save block like any autosave.
  private flushListener: (() => void) | null = null;
  private attachFlushListeners(): void {
    if (this.flushListener || typeof document === 'undefined' || typeof window === 'undefined') return;
    const onHide = (): void => { if (document.visibilityState === 'hidden') void this.triggerSave(); };
    const onPageHide = (): void => { void this.triggerSave(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    this.flushListener = () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }
  private detachFlushListeners(): void {
    this.flushListener?.();
    this.flushListener = null;
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
      this.triggerDeferrableSave();
      this.strokeDebounceTimer = null;
    }, this.config.strokeDebounceMs);
  }

  /** Trigger a save now (debounced if one is already in progress). Automatic path — skipped while the busy
   *  predicate holds (e.g. Play mode) so a transient animation frame can't leak to disk; the timer resumes and
   *  persists the restored state once play exits. Explicit saves go through saveNow(), which is NOT gated. */
  public async triggerSave(): Promise<boolean> {
    if (this.busyPredicate?.()) return false;   // Play mode etc. — don't persist a transient frame (stroke/trailing/timer)
    if (this.isSaving) {
      this.savePending = true;
      return false;
    }
    return this.executeSave();
  }

  /** Force an immediate save (bypasses the debounce — but NOT suspend()/setSaveBlocked()). While the busy predicate
   *  holds (Play / UI preview / Player mode) the save is DEFERRED until it clears and then runs once, so it persists
   *  the restored EDITOR state instead of the in-game frame (bug-hunt 2026-10-01 D-P2). Deferring was chosen over
   *  serializing the pre-Play state while playing: the in-game state is spread over transforms, visibility, loco
   *  poses, script hides, the camera and UI vars, and rebuilding the editor view of all of it would duplicate every
   *  Stop restore path (any one missed silently persists corruption). Stop already restores all of it, so saving
   *  right after Stop reuses that one tested path. Calls made during one busy period share the same deferred save. */
  public async saveNow(): Promise<boolean> {
    if (this.busyPredicate?.()) {
      if (!this.deferred) { try { this.onDeferred?.(); } catch { /* host callback */ } }
      return this.deferUntilIdle(true);
    }
    return this.executeSave(true);
  }

  /** Poll interval for a deferred explicit save (see saveNow). */
  private static readonly DEFER_POLL_MS = 250;
  private deferred: { promise: Promise<boolean>; resolve: (ok: boolean) => void; timer: ReturnType<typeof setInterval>; explicit: boolean } | null = null;

  /** One shared save that runs as soon as the busy predicate clears (D-P2). Explicit if any request sharing it was. */
  private deferUntilIdle(explicit = false): Promise<boolean> {
    if (this.deferred) { this.deferred.explicit ||= explicit; return this.deferred.promise; }
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    const timer = setInterval(() => {
      if (this.busyPredicate?.()) return;
      const d = this.deferred;
      if (!d) return;
      clearInterval(d.timer);
      this.deferred = null;   // BEFORE the save — a new busy period during it gets its own deferral
      this.executeSave(d.explicit).then(d.resolve, () => d.resolve(false));
    }, DocumentPersistence.DEFER_POLL_MS);
    this.deferred = { promise, resolve, timer, explicit };
    return promise;
  }

  private cancelDeferred(): void {
    const d = this.deferred;
    if (!d) return;
    clearInterval(d.timer);
    this.deferred = null;
    d.resolve(false);
  }

  // ── Load guard ────────────────────────────────────────────────────

  /**
   * Block all saves while a document is being restored. Cancels any pending debounced / trailing save and resolves
   * once a save that was already writing has finished — so the restore never interleaves with a write. Nestable;
   * pair every call with resume(). (audit 2026-09-28 P1: an autosave firing mid-load wrote the half-built new doc
   * into the OLD doc's directory.)
   */
  public async suspend(): Promise<void> {
    this.suspendDepth++;
    if (this.strokeDebounceTimer !== null) { clearTimeout(this.strokeDebounceTimer); this.strokeDebounceTimer = null; }
    this.savePending = false;
    const running = this.inFlight;
    if (running) { try { await running; } catch { /* the save already reported its own failure */ } }
  }

  /** Undo one suspend(). */
  public resume(): void {
    this.suspendDepth = Math.max(0, this.suspendDepth - 1);
  }

  public get isSuspended(): boolean { return this.suspendDepth > 0; }

  /** Block (reason) or unblock (null) all saves — used when a restore failed and the scene is partial. */
  public setSaveBlocked(reason: string | null): void { this.saveBlockedReason = reason; }
  public get saveBlocked(): string | null { return this.saveBlockedReason; }

  private async executeSave(explicit = false): Promise<boolean> {
    // Serialize: an explicit saveNow() used to bypass isSaving and write the same files CONCURRENTLY with a running
    // autosave (audit P9). Wait for the one in flight, then save (re-checking the gates below after the wait).
    while (this.inFlight) { try { await this.inFlight; } catch { /* it reported its own failure */ } }
    if (this.suspendDepth > 0) return false;   // mid-restore: never persist a half-built scene
    if (this.saveBlockedReason) {
      console.warn('[DocumentPersistence] Save skipped — saving is blocked:', this.saveBlockedReason);
      return false;
    }
    let busyAfterGather = false;
    const run = this.runSave(() => { busyAfterGather = true; }, explicit);
    this.inFlight = run;
    let ok: boolean;
    try { ok = await run; }
    finally { if (this.inFlight === run) this.inFlight = null; }
    // Play (etc.) started while the state was being gathered (the gather awaits pixel export before reading the 3D
    // scene) → nothing was written; save again once it ends (D-P2). Outside inFlight, so no self-wait.
    return busyAfterGather ? this.deferUntilIdle(explicit) : ok;
  }

  private async runSave(onBusy: () => void, explicit = false): Promise<boolean> {
    if (!this.getDocumentState || !isOPFSAvailable()) return false;

    this.isSaving = true;
    // "Saving…" is reported when the first file is about to be written (an automatic save that finds nothing changed
    // writes nothing and reports nothing). An explicit save reports it up front, as before.
    let started = false;
    const start = (): void => { if (!started) { started = true; this.onSaveStart?.(); } };
    if (explicit) start();

    try {
      const epoch0 = this.busyEpoch?.();
      const payload = await this.getDocumentState({ explicit });
      if (this.busyPredicate?.()) { onBusy(); return false; }   // in-game frame — never write it (D-P2)
      if (this.busyEpoch && this.busyEpoch() !== epoch0) { onBusy(); return false; }   // a busy period came and went mid-gather
      // No document id = no document open yet (ShapeManager.startBlankDocument without an id): nowhere to write. It
      // must never fall through to some other document's directory.
      if (!payload.manifest.docId) {
        console.warn('[DocumentPersistence] Save skipped — no document id is set yet');
        this.onSaveComplete?.(false);
        return false;
      }
      const result = await withDocLock(payload.manifest.docId, () => this.writeToOPFS(payload, { explicit, onFirstWrite: start }));
      payload._onWriteComplete?.();   // also when nothing needed writing: the disk already holds this state
      if (started || result === 'written') this.onSaveComplete?.(true);
      return true;
    } catch (e) {
      console.error('[DocumentPersistence] Save failed:', e);
      this.written = null;   // what is on disk is unknown now: the next save writes everything
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
        this.trailingTimer = setTimeout(() => { this.trailingTimer = null; this.triggerDeferrableSave(); }, 100);
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

  private async writeToOPFS(payload: DocumentSavePayload, opts: { explicit?: boolean; onFirstWrite?: () => void } = {}): Promise<'written' | 'unchanged'> {
    const dir = await this.getDocDir(payload.manifest.docId, true);

    // Refuse to overwrite a document a NEWER build wrote (audit P10) — e.g. another tab on an updated build saved it
    // after this tab opened it. This build doesn't know the newer fields, so writing would silently drop them.
    const onDisk = await this.readJSON<{ schemaVersion?: number; savedAt?: string }>(dir, 'manifest.json');
    if (isNewerThanThisBuild(onDisk)) {
      const reason = `this document was saved by a newer version of Salsa (schema v${schemaVersionOf(onDisk)}; this build ` +
        `is v${DOCUMENT_SCHEMA_VERSION}) — saving is disabled so its newer data isn't overwritten`;
      this.setSaveBlocked(reason);
      throw new Error(reason);
    }

    // ── Plan: which files differ from what this instance last wrote / loaded (INCREMENTAL — see the header) ──
    // The record is trusted only for the same document, an automatic save, and an on-disk manifest that still has
    // the savedAt it was taken with. Anything else → `prev` null → every file is written, as before.
    const docId = payload.manifest.docId;
    const r = this.written;
    const prev = (!opts.explicit && r && r.docId === docId && !!onDisk && onDisk.savedAt === r.savedAt) ? r : null;
    const next = prev ? cloneWriteRecord(prev) : emptyWriteRecord(docId);
    next.savedAt = payload.manifest.savedAt;

    const fmt = this.config.pixelFormat;
    const ext = pixelFormatExtension(fmt);
    const w = payload.manifest.canvasWidth;
    const h = payload.manifest.canvasHeight;

    // JSON files (gzipped by writeText; textures3d.json raw via writeJSON). null = delete (garp / ui only).
    const textFiles: Array<{ name: string; text: string | null; raw?: boolean }> = [];
    if (payload.sceneGraphJSON) textFiles.push({ name: 'scene.json', text: payload.sceneGraphJSON });
    if (payload.brushPresetsJSON) textFiles.push({ name: 'brushes.json', text: payload.brushPresetsJSON });
    if (payload.scene3dJSON) textFiles.push({ name: 'scene3d.json', text: payload.scene3dJSON });
    if (payload.textureLibrary) textFiles.push({ name: 'textures3d.json', text: JSON.stringify(payload.textureLibrary), raw: true });
    // GARP pools + UI state machines (audit 2026-09-28 P3): both were gathered into the payload but never written,
    // so authored skin pools and UI layers vanished on reload. The gather sends null when there are NONE — so null
    // must DELETE the file, or a doc whose last UI layer / pool was removed would resurrect it on the next load.
    textFiles.push({ name: 'garp.json', text: payload.garpJSON ? JSON.stringify(payload.garpJSON) : null });
    textFiles.push({ name: 'ui.json', text: payload.uiLayersJSON || null });
    if (payload.ephemeraJSON) textFiles.push({ name: 'ephemera.json', text: payload.ephemeraJSON });
    const textNeeds = (f: { name: string; text: string | null }): boolean =>
      f.text === null ? (!prev || !prev.absent.has(f.name)) : (!prev || prev.texts.get(f.name) !== f.text);

    // Layer / cel pixels: written unless the content key matches the one this file was written (or loaded) with.
    const keys = payload.pixelContentKeys;
    const pixelNeeds = (path: string, key: string | undefined): boolean => !key || !prev || prev.keys.get(path) !== key;
    const layerJobs = payload.layers.filter((l) => pixelNeeds(`layers/${l.id}.${ext}`, keys?.layers?.[l.id]));
    const celJobs = (payload.cels ?? []).filter((c) => pixelNeeds(`cels/${c.celId}.${ext}`, keys?.cels?.[c.celId]));
    // A raster layer the manifest lists with no pixels is BLANK now: its old file must go, or a reload before the next
    // prune resurrects what was cleared. Removed AFTER the manifest (an interrupted save keeps the previous state).
    const withPixels = new Set(payload.layers.map((l) => l.id));
    const blankRemovals = payload.manifest.layers
      .filter((l) => (l.type ?? 'layer') === 'layer' && !withPixels.has(l.id))
      .map((l) => `${l.id}.${ext}`)
      .filter((name) => !prev || prev.pixelFiles.has(`layers/${name}`));

    // Binary sidecars: written unless byte-identical to what this file holds.
    const binFiles: Array<{ dir: string; name: string; buf: ArrayBuffer }> = [];
    for (const [k, buf] of Object.entries(payload.models3d ?? {})) binFiles.push({ dir: 'models3d', name: `${k}.glb`, buf });
    for (const [k, buf] of Object.entries(payload.meshTextures ?? {})) binFiles.push({ dir: 'meshTextures', name: `${k}.png`, buf });
    for (const [k, buf] of Object.entries(payload.bakedParts ?? {})) binFiles.push({ dir: 'bakedParts', name: `${k}.glb`, buf });
    const binNeeds = (b: { dir: string; name: string; buf: ArrayBuffer }): boolean => !prev || !sameBuffer(prev.bins.get(`${b.dir}/${b.name}`), b.buf);

    const manifestNorm = normalizedManifest(payload.manifest);
    const anyChange = !prev
      || prev.manifest !== manifestNorm
      || textFiles.some(textNeeds)
      || layerJobs.length > 0 || celJobs.length > 0 || blankRemovals.length > 0
      || binFiles.some(binNeeds);
    const total = textFiles.length + payload.layers.length + (payload.cels?.length ?? 0) + binFiles.length + 1;
    if (!anyChange) {
      this.writeStats.unchanged++;
      this.writeStats.filesSkipped += total;
      this.lastWrittenFiles = [];
      return 'unchanged';   // the disk already holds exactly this document: write nothing (and don't prune)
    }

    // ── Write ──
    opts.onFirstWrite?.();
    this.written = null;   // mid-write the disk matches neither record; committed again only once the manifest lands
    const wrote: string[] = [];
    const writeTextFile = async (f: { name: string; text: string | null; raw?: boolean }): Promise<void> => {
      if (!textNeeds(f)) return;
      if (f.text === null) {
        await this.removeFile(dir, f.name);
        next.texts.delete(f.name); next.absent.add(f.name);
      } else {
        if (f.raw) await this.writeRawText(dir, f.name, f.text);
        else await this.writeText(dir, f.name, f.text);
        next.texts.set(f.name, f.text); next.absent.delete(f.name);
      }
      wrote.push(f.name);
    };
    const textByName = (n: string) => textFiles.find((f) => f.name === n);

    // (The manifest is written LAST — see the end of this method.)
    for (const n of ['scene.json', 'brushes.json']) { const f = textByName(n); if (f) await writeTextFile(f); }

    // Write layer pixel data. The PNG encode runs in the worker pool (off the main thread — audit §2.1);
    // layers+cels encode concurrently across the pool, then the OPFS writes stay sequential as before.
    const layersDir = await dir.getDirectoryHandle('layers', { create: true });
    const encodedLayers = await Promise.all(layerJobs.map(async (layer) => ({
      id: layer.id, encoded: await this.encodeForSave(layer.pixelData, w, h, fmt),
    })));
    for (const { id, encoded } of encodedLayers) {
      await this.writeBinary(layersDir, `${id}.${ext}`, encoded);
      const path = `layers/${id}.${ext}`;
      const key = keys?.layers?.[id];
      if (key) next.keys.set(path, key); else next.keys.delete(path);
      next.pixelFiles.add(path);
      wrote.push(path);
    }

    // Write animation cel pixel data
    if (payload.cels && payload.cels.length > 0) {
      const celsDir = await dir.getDirectoryHandle('cels', { create: true });
      const encodedCels = await Promise.all(celJobs.map(async (cel) => ({
        celId: cel.celId, encoded: await this.encodeForSave(cel.pixelData, w, h, fmt),
      })));
      for (const { celId, encoded } of encodedCels) {
        await this.writeBinary(celsDir, `${celId}.${ext}`, encoded);
        const path = `cels/${celId}.${ext}`;
        const key = keys?.cels?.[celId];
        if (key) next.keys.set(path, key); else next.keys.delete(path);
        next.pixelFiles.add(path);
        wrote.push(path);
      }
    }

    // Write 3D scene state
    { const f = textByName('scene3d.json'); if (f) await writeTextFile(f); }

    // Write 3D model buffers (GLB bytes per imported mesh), UV-painted mesh textures (PNG, keyed by mesh ID) and
    // baked kitbash parts (generated garments/hair, GLB keyed by part id) — each only when its bytes changed.
    for (const sub of ['models3d', 'meshTextures', 'bakedParts']) {
      const files = binFiles.filter((b) => b.dir === sub);
      if (!files.length) continue;
      const subDir = await dir.getDirectoryHandle(sub, { create: true });
      for (const b of files) {
        if (!binNeeds(b)) continue;
        await this.writeBinary(subDir, b.name, b.buf);
        next.bins.set(`${sub}/${b.name}`, b.buf);
        wrote.push(`${sub}/${b.name}`);
      }
    }

    // Write texture library snapshot (base64 data URLs for material textures)
    { const f = textByName('textures3d.json'); if (f) await writeTextFile(f); }

    // GARP pools + UI state machines (see above: null deletes the file).
    for (const n of ['garp.json', 'ui.json']) { const f = textByName(n); if (f) await writeTextFile(f); }

    // Write ephemera placements + sheets
    { const f = textByName('ephemera.json'); if (f) await writeTextFile(f); }

    // ★ Manifest LAST = the commit record (audit 2026-09-28 P9). It used to be written FIRST, so a save interrupted
    // mid-way (tab killed, crash) left a manifest describing layers/files that were never written. Now everything
    // it references is on disk before it is. (Not a full atomic swap — OPFS can't rename directories — but an
    // interrupted save leaves the PREVIOUS manifest in charge, whose layer files still exist because pruning runs
    // after this.) A brand-new doc interrupted before this line simply has no manifest → treated as unsaved.
    // Always written when anything else was: its savedAt is what validates this instance's write record.
    await this.writeJSON(dir, 'manifest.json', payload.manifest);
    next.manifest = manifestNorm;
    wrote.push('manifest.json');

    // Blank layers' old files (see above).
    for (const name of blankRemovals) {
      await this.removeFile(layersDir, name);
      next.pixelFiles.delete(`layers/${name}`); next.keys.delete(`layers/${name}`);
    }

    // Prune ORPHANED files — deleted layers/cels/textures leave their files on disk (writes never remove them),
    // so a doc directory balloons over an editing session (draw on N layers, delete them → N stale PNGs remain).
    // Delete anything in each managed subdir that isn't referenced by the CURRENT payload. (The payload always holds
    // EVERY non-blank layer and every cel — unchanged ones included, with their cached pixels — so an unchanged file
    // is never pruned. A now-blank layer's file was removed just above.)
    // Throttled: a full OPFS listing × 5 dirs on EVERY save is wasted work when nothing was deleted, and the
    // deletion paths live in managers this module can't see — so prune on the first save and then every Nth.
    // Orphans are only ever cleaned up *late*, never missed (worst case: stale files linger a few saves).
    if (this.saveCount % DocumentPersistence.PRUNE_EVERY_N_SAVES === 0) {
      const forget = (sub: string, names: string[]): void => {
        for (const n of names) { const p = `${sub}/${n}`; next.keys.delete(p); next.pixelFiles.delete(p); next.bins.delete(p); }
      };
      forget('layers', await this.pruneDir(dir, 'layers',       new Set(payload.layers.map(l => `${l.id}.${ext}`))));
      forget('cels',   await this.pruneDir(dir, 'cels',         new Set((payload.cels ?? []).map(c => `${c.celId}.${ext}`))));
      // Only prune models3d when this save gathered the whole store — otherwise the (empty) map would read as
      // "keep nothing" and wipe every GLB on the first save after a load that made no 3D edit.
      if (payload.models3dComplete) {
        forget('models3d', await this.pruneDir(dir, 'models3d',     new Set(Object.keys(payload.models3d ?? {}).map(k => `${k}.glb`))));
      }
      if (payload.meshTexturesComplete !== false) {
        forget('meshTextures', await this.pruneDir(dir, 'meshTextures', new Set(Object.keys(payload.meshTextures ?? {}).map(k => `${k}.png`))));
      }
      forget('bakedParts', await this.pruneDir(dir, 'bakedParts',   new Set(Object.keys(payload.bakedParts ?? {}).map(k => `${k}.glb`))));
    }
    this.saveCount++;
    this.written = next;
    this.writeStats.writes++;
    this.writeStats.filesWritten += wrote.length;
    this.writeStats.filesSkipped += Math.max(0, total - wrote.length);
    this.lastWrittenFiles = wrote;
    return 'written';
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

      // Layer / cel files read under their own name (not the legacy .bin fallback) — seeds the write record below.
      const loadedPixelFiles: Array<{ kind: 'layer' | 'cel'; id: string; file: string }> = [];

      // Read all layer pixel files in parallel — same pattern as Frogmarks' Azure download fix.
      // Sequential awaits here were the dominant cost in loadDocument() (e.g. ~341ms for 9 layers).
      const layers: LayerPixelData[] = [];
      if (layersDir) {
        const results = await Promise.all(
          manifest.layers.map(async (entry) => {
            try {
              // Try format-specific extension first, fall back to .bin for legacy v2 saves.
              const own = await this.readBinary(layersDir, `${entry.id}.${ext}`);
              const raw = own ?? await this.readBinary(layersDir, `${entry.id}.bin`);
              if (!raw) return null;
              const { rgba } = await decodePixels(raw, fmt);
              return { id: entry.id, pixelData: rgba, file: own ? `layers/${entry.id}.${ext}` : null };
            } catch {
              return null; // Layer file missing — will be a blank layer
            }
          }),
        );
        for (const r of results) { if (r) { layers.push({ id: r.id, pixelData: r.pixelData }); if (r.file) loadedPixelFiles.push({ kind: 'layer', id: r.id, file: r.file }); } }
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
                const own = await this.readBinary(celsDir, `${celMeta.celId}.${ext}`);
                const raw = own ?? await this.readBinary(celsDir, `${celMeta.celId}.bin`);
                if (!raw) return null;
                const { rgba } = await decodePixels(raw, fmt);
                return { celId: celMeta.celId, pixelData: rgba, file: own ? `cels/${celMeta.celId}.${ext}` : null };
              } catch {
                return null; // Cel file missing
              }
            }),
          );
          for (const r of celResults) { if (r) { cels.push({ celId: r.celId, pixelData: r.pixelData }); if (r.file) loadedPixelFiles.push({ kind: 'cel', id: r.celId, file: r.file }); } }
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

      // GARP pools + UI layers (P3). Absent in saves made before this fix → null → nothing restored (as before).
      const garpText = await this.readText(dir, 'garp.json');
      let garpJSON: DocumentSavePayload['garpJSON'] = null;
      if (garpText) {
        try { garpJSON = JSON.parse(garpText); }
        catch (e) { console.warn('[DocumentPersistence] garp.json is unreadable — GARP pools not loaded:', e); }
      }
      const uiLayersJSON = await this.readText(dir, 'ui.json');

      // Incremental autosave: what was just read IS what this document's files hold. Seed the write record with it,
      // and give each layer / cel read from its own file a content key (the restore caches the uploaded pixels under
      // that key), so the first automatic save after a load writes nothing that didn't change.
      const rec = emptyWriteRecord(docId);
      rec.savedAt = manifest.savedAt;
      rec.manifest = normalizedManifest(manifest);
      const texts: Array<[string, string | null]> = [
        ['scene.json', sceneGraphJSON], ['brushes.json', brushPresetsJSON], ['scene3d.json', scene3dJSON],
        ['ephemera.json', ephemeraJSON], ['garp.json', garpText], ['ui.json', uiLayersJSON],
        ['textures3d.json', textureLibrary ? JSON.stringify(textureLibrary) : null],
      ];
      for (const [name, text] of texts) { if (text !== null) rec.texts.set(name, text); else rec.absent.add(name); }
      const pixelContentKeys: NonNullable<DocumentSavePayload['pixelContentKeys']> = { layers: {}, cels: {} };
      for (const { kind, id, file } of loadedPixelFiles) {
        const key = `disk:${manifest.savedAt}:${file}`;
        (kind === 'layer' ? pixelContentKeys.layers : pixelContentKeys.cels)[id] = key;
        rec.keys.set(file, key);
        rec.pixelFiles.add(file);
      }
      for (const [sub, map, ext2] of [['models3d', models3d, '.glb'], ['meshTextures', meshTextures, '.png'], ['bakedParts', bakedParts, '.glb']] as const) {
        for (const [k, buf] of Object.entries(map)) rec.bins.set(`${sub}/${k}${ext2}`, buf);
      }
      this.written = rec;

      return { manifest, sceneGraphJSON, brushPresetsJSON, layers, cels, scene3dJSON, models3d, meshTextures, bakedParts, textureLibrary, ephemeraJSON, garpJSON, uiLayersJSON, pixelContentKeys };
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
      if (this.written?.docId === docId) this.written = null;
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
      if (this.written?.docId === docId) this.written = null;   // the manifest on disk no longer matches the record
      await this.writeJSON(dir, 'manifest.json', manifest);
      return true;
    } catch {
      return false;
    }
  }

  public destroy(): void {
    this.stopAutoSave();
    this.cancelPendingSaves();
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
    await this.writeRawText(dir, name, JSON.stringify(data));
  }

  /** Write text as-is (not gzipped) — what writeJSON writes for already-serialized JSON. */
  private async writeRawText(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(text);
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

  /** Delete a file if it exists (no-op when it doesn't). */
  private async removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
    try { await dir.removeEntry(name); } catch { /* not present — nothing to delete */ }
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
   *  if the subdir is absent. Returns the names it deleted. */
  private async pruneDir(parent: FileSystemDirectoryHandle, dirName: string, keep: Set<string>): Promise<string[]> {
    let dir: FileSystemDirectoryHandle;
    try { dir = await parent.getDirectoryHandle(dirName); } catch { return []; }   // subdir doesn't exist yet
    const stale: string[] = [];
    try { for await (const name of (dir as any).keys()) if (!keep.has(name)) stale.push(name); } catch { return []; }
    const removed: string[] = [];
    for (const name of stale) { try { await dir.removeEntry(name); removed.push(name); } catch { /* best-effort */ } }
    return removed;
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
  /** True only when `models3d` holds the FULL live model store (gathered this save). When false/absent the map is
   *  partial or empty (no 3D mesh was dirty), so it must NOT be used as a prune keep-set — doing so deleted every GLB. */
  models3dComplete?: boolean;
  /** False when a mesh/face texture failed to EXPORT this save — the map is then partial, so meshTextures/ must not
   *  be pruned against it (that would delete the unexported texture's existing file). Absent = complete. */
  meshTexturesComplete?: boolean;
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
  /** UI System layers (docs/specs/ui-system.md) — the state machine + shape interactions per ui-layer. */
  uiLayersJSON?: string | null;
  /**
   * Incremental autosave (not persisted): an opaque CONTENT key per layer / cel in `layers` / `cels`. Equal keys mean
   * identical pixels, so the writer skips re-encoding a file it already wrote (or loaded) with that key. Set by
   * DocumentStateCoordinator for a read-back it made (cached pixels keep their key) and by loadDocument for pixels it
   * read from disk. Absent = always write. Anything that changes `layers` / `cels` pixel buffers in a payload (e.g. a
   * future schema migration) must drop it.
   */
  pixelContentKeys?: { layers: Record<string, string>; cels: Record<string, string> };
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

// ── Incremental write record (see the DocumentPersistence header: INCREMENTAL) ──

/** What one DocumentPersistence instance last wrote (or loaded) for a document, file by file. */
interface WriteRecord {
  docId: string;
  /** The savedAt of the manifest that record matches — the disk's manifest must still carry it. */
  savedAt: string;
  /** The manifest without savedAt / createdAt (null = unknown). */
  manifest: string | null;
  /** JSON files ('scene.json' …) → their exact text. */
  texts: Map<string, string>;
  /** JSON files known NOT to exist (garp.json / ui.json after a delete, or absent at load). */
  absent: Set<string>;
  /** Layer / cel files ('layers/<id>.png') → the content key they were written with. */
  keys: Map<string, string>;
  /** Layer / cel files known to exist (with or without a key). */
  pixelFiles: Set<string>;
  /** Binary sidecars ('models3d/<id>.glb' …) → the bytes written. */
  bins: Map<string, ArrayBuffer>;
}

function emptyWriteRecord(docId: string): WriteRecord {
  return { docId, savedAt: '', manifest: null, texts: new Map(), absent: new Set(), keys: new Map(), pixelFiles: new Set(), bins: new Map() };
}

function cloneWriteRecord(r: WriteRecord): WriteRecord {
  return { docId: r.docId, savedAt: r.savedAt, manifest: r.manifest, texts: new Map(r.texts), absent: new Set(r.absent),
    keys: new Map(r.keys), pixelFiles: new Set(r.pixelFiles), bins: new Map(r.bins) };
}

/** The manifest as compared between saves: savedAt / createdAt are stamped fresh by every gather. */
function normalizedManifest(m: DocumentManifest): string {
  return JSON.stringify({ ...m, savedAt: '', createdAt: '' });
}

/** Same bytes (identity first; a re-gathered copy of the same file compares by content). */
function sameBuffer(a: ArrayBuffer | undefined, b: ArrayBuffer): boolean {
  if (a === b) return true;
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
