/**
 * DeviceRecoveryCoordinator — the CONTENT half of GPU device-lost recovery (docs/ui/device-recovery.md).
 *
 * WebGPURenderer detects the loss, stops rendering and gets a new device; this coordinator (installed as its recovery
 * handler by ShapeManager) makes the document come back:
 *
 *   1. leave Play (Stop restores the editor state, the same rule as saves + exports);
 *   2. SNAPSHOT the document from CPU-side data: the normal save gather, with every GPU read-back (raster layers, cels,
 *      UV-paint / face textures) taken from the READ-BACK SHADOW instead (the dead device can't be read);
 *   3. `install()` — the renderer's half: new adapter + device, the device handle re-pointed, every GPU owner rebuilt
 *      (fresh Renderer3D, the 2D stack in place, raster engines, manager caches);
 *   4. RESTORE the snapshot through the normal document restore (every mesh, texture, atlas, city tile and character
 *      re-uploads / regenerates from CPU data on the new device);
 *   5. put back the runtime view state the document doesn't carry (camera pose, City mode, traffic, UI mode).
 *
 * The read-back SHADOW is the newest copy of the GPU-only data. It is SEEDED blank at start-up and from every document
 * restore (the restored pixels are exactly the payload's), and refreshed by every save gather (autosave, export) and by
 * a periodic read-back. Each copy records the GPU-pixel EDIT COUNT (gpu-pixel-epoch.ts) it matches: when the count has
 * not moved at the loss, the shadow is exact and nothing is reported; otherwise the edits after it are the one thing a
 * loss can cost, and the recovery lists them in `unrecovered`.
 */

import type { GpuOnlyDocumentData } from './document-state-coordinator';
import type { DocumentSavePayload } from './document-persistence';

export interface DeviceRecoveryHost {
  /** Stop Play / UI preview if running (their Stop paths restore the editor state). */
  leaveTransientModes(): void;
  /** The normal save gather; `gpuOnly` replaces every GPU read-back. */
  gather(gpuOnly: GpuOnlyDocumentData | null): Promise<DocumentSavePayload>;
  /** Read back the GPU-only data now (device healthy). */
  readBackGpuOnly(): Promise<GpuOnlyDocumentData>;
  /** True when the document has GPU-only data worth shadowing (raster layers / painted textures). */
  hasGpuOnlyContent(): boolean;
  /** The GPU-only pixel edit count (gpuPixelEpoch()). */
  gpuPixelEpoch(): number;
  /** The normal document restore. */
  restore(payload: DocumentSavePayload): Promise<void>;
  /** Drop manager-held GPU objects that survive a document load; returns what can't come back. Runs after the device
   *  is replaced and before the restore. */
  resetManagersForNewDevice(): string[];
  /** Runtime state the document doesn't carry (camera pose …): captured before, applied after the restore. */
  captureRuntime(): unknown;
  applyRuntime(state: unknown): void | Promise<void>;
  /** Called after the restore: content that existed before the loss and survived the restore (not document
   *  content) must drop its GPU objects. */
  resetSurvivors(before: Set<object>): void;
  /** Objects present before the restore (to find survivors). */
  listContent(): Set<object>;
  /** False while the device is lost / recovering. */
  deviceHealthy(): boolean;
}

export interface DeviceRecoveryOptions {
  /** Periodic shadow refresh (ms). 0 = only saves refresh it. Default 60 s. */
  shadowIntervalMs?: number;
}

/** A shadow holding no pixels (blank layers come back blank without one). */
export function blankGpuOnlyData(editEpoch: number, layerIds: string[] = [], at = Date.now()): GpuOnlyDocumentData {
  return { layers: [], cels: [], meshTextures: {}, meshTexturesComplete: true, layerIds, celIds: [], meshTextureKeys: [], at, editEpoch };
}

/**
 * The shadow a document restore leaves behind: the payload's own pixels are exactly what is on the GPU now. Null when
 * the payload can't vouch for the GPU (a layer / cel stored at another size is resized on load, so its bytes are not
 * what the texture holds).
 */
export function gpuOnlyFromRestorePayload(payload: DocumentSavePayload, editEpoch: number, canvas: { w: number; h: number } | null,
  layerIds: string[], celIds: string[], at = Date.now()): GpuOnlyDocumentData | null {
  const layers = payload.layers ?? [];
  const cels = payload.cels ?? [];
  if (canvas && (layers.length || cels.length)) {
    const bytes = canvas.w * canvas.h * 4;
    if (layers.some((l) => l.pixelData.byteLength !== bytes) || cels.some((c) => c.pixelData.byteLength !== bytes)) return null;
  }
  const meshTextures = { ...(payload.meshTextures ?? {}) };
  return {
    layers: layers.map((l) => ({ id: l.id, pixelData: l.pixelData })),
    cels: cels.map((c) => ({ celId: c.celId, pixelData: c.pixelData })),
    meshTextures, meshTexturesComplete: payload.meshTexturesComplete !== false,
    layerIds: layerIds.slice(), celIds: celIds.slice(), meshTextureKeys: Object.keys(meshTextures), at, editEpoch,
  };
}

export class DeviceRecoveryCoordinator {
  private _shadow: GpuOnlyDocumentData | null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _refreshing = false;
  private _intervalMs: number;

  constructor(private readonly host: DeviceRecoveryHost, opts: DeviceRecoveryOptions = {}) {
    this._intervalMs = opts.shadowIntervalMs ?? 60_000;
    // Start-up: nothing painted yet → a blank shadow is exact until the first edit.
    this._shadow = blankGpuOnlyData(host.gpuPixelEpoch());
    this._startTimer();
  }

  /** The newest GPU read-back (null = none that can be trusted). */
  get shadow(): GpuOnlyDocumentData | null { return this._shadow; }

  /** True when the shadow matches the GPU exactly (no GPU-only edit since it was taken). */
  get shadowCurrent(): boolean {
    const s = this._shadow;
    return !!s && s.editEpoch !== undefined && s.editEpoch === this.host.gpuPixelEpoch();
  }

  /** Every successful read-back (save gathers included) lands here; an older capture never replaces a newer one. */
  noteGpuOnly(data: GpuOnlyDocumentData): void {
    if (!this._shadow || data.at >= this._shadow.at) this._shadow = data;
  }

  /** Replace the shadow unconditionally (a document restore: the payload IS the GPU content now; null = unknown). */
  seedShadow(data: GpuOnlyDocumentData | null): void { this._shadow = data; }

  /** Change the periodic refresh (0 = off). */
  setShadowInterval(ms: number): void {
    this._intervalMs = Math.max(0, ms | 0);
    this._startTimer();
  }

  /** Refresh the shadow now (if the device is healthy). Resolves false when skipped. */
  async refreshShadow(): Promise<boolean> {
    if (this._refreshing || !this.host.deviceHealthy()) return false;
    this._refreshing = true;
    try {
      const data = await this.host.readBackGpuOnly();   // noteGpuOnly is called through the gather hook too
      if (!this.host.deviceHealthy()) return false;      // lost mid-read: the data may be partial
      this.noteGpuOnly(data);
      return true;
    } catch { return false; }
    finally { this._refreshing = false; }
  }

  /** One timer tick (exposed for tests): read back only when GPU-only pixels changed since the shadow. */
  tick(): void {
    if (!this.host.deviceHealthy() || !this.host.hasGpuOnlyContent()) return;
    if (this.shadowCurrent) return;   // nothing painted since → nothing to read
    void this.refreshShadow();
  }

  dispose(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  private _startTimer(): void {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (!this._intervalMs || typeof setInterval === 'undefined') return;
    this._timer = setInterval(() => this.tick(), this._intervalMs);
  }

  /** The renderer's recovery handler. Throws only when the device can't be replaced (install failed). */
  async recover(install: () => Promise<void>): Promise<string[]> {
    const unrecovered: string[] = [];
    try { this.host.leaveTransientModes(); } catch (e) { console.warn('[Salsa][gpu] leaving Play before recovery failed', e); }
    const runtime = (() => { try { return this.host.captureRuntime(); } catch { return null; } })();
    const before = this.host.listContent();

    // The GPU-only data: the shadow if there is one, else nothing (a document with GPU-only content but no shadow loses
    // those pixels — reported below).
    const shadow = this._shadow;
    const exact = this.shadowCurrent;
    const hadGpuOnly = this.host.hasGpuOnlyContent();
    const gpuOnly: GpuOnlyDocumentData = shadow ?? blankGpuOnlyData(this.host.gpuPixelEpoch());
    let payload: DocumentSavePayload | null = null;
    try { payload = await this.host.gather(gpuOnly); }
    catch (e) { unrecovered.push(`the document snapshot failed (${e instanceof Error ? e.message : String(e)}); reload the last save`); }
    if (hadGpuOnly && !exact) {
      if (!shadow) unrecovered.push('raster layer / painted texture pixels (no read-back was taken before the loss)');
      else unrecovered.push(...describeShadowGaps(shadow, payload));
    }

    await install();   // throws → the renderer reports 'failed'

    try { unrecovered.push(...this.host.resetManagersForNewDevice()); }
    catch (e) { unrecovered.push(`manager reset: ${e instanceof Error ? e.message : String(e)}`); }

    if (payload) {
      try { await this.host.restore(payload); }
      catch (e) { unrecovered.push(`document restore: ${e instanceof Error ? e.message : String(e)}`); }
    }
    try { this.host.resetSurvivors(before); } catch (e) { console.warn('[Salsa][gpu] survivor reset failed', e); }
    try { if (runtime) await this.host.applyRuntime(runtime); } catch (e) { console.warn('[Salsa][gpu] runtime re-apply failed', e); }
    return unrecovered;
  }
}

/** What the shadow can't vouch for (called only when GPU-only pixels changed after it): layers / cels / painted
 *  textures that appeared after it, and its age. */
export function describeShadowGaps(shadow: GpuOnlyDocumentData, payload: DocumentSavePayload | null, now = Date.now()): string[] {
  const out: string[] = [];
  const ageS = Math.max(0, Math.round((now - shadow.at) / 1000));
  const known = new Set(shadow.layerIds);
  const layers = payload?.manifest.layers ?? [];
  const newRaster = layers.filter((l) => (l.type ?? 'layer') === 'layer' && !known.has(l.id)).map((l) => l.name || l.id);
  if (newRaster.length) out.push(`raster layer(s) created after the last read-back come back blank: ${newRaster.join(', ')}`);
  out.push(`raster / painted-texture edits made in the ${ageS}s before the loss (after the last read-back) are lost`);
  return out;
}
