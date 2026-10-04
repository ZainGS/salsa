/**
 * GPU device status, device acquisition and the "WebGPU unavailable" / "couldn't recover" overlays
 * (docs/ui/device-recovery.md).
 *
 * The renderer (WebGPURenderer) owns the device; this module holds the pieces that don't need the renderer:
 *  - `GpuDeviceStatusTracker` — the status machine + listeners the host subscribes to (sm.onDeviceStatusChange);
 *  - `requestSalsaDevice()` — ONE adapter/device request used at start-up and for every recovery attempt (same
 *    features + limits, so a recovered device behaves like the first one);
 *  - `describeWebGPUUnavailable()` / `showWebGPUOverlay()` — the friendly overlay shown instead of a black canvas;
 *  - `rebuildInPlace()` — re-run an owner's constructor and move the fresh state into the EXISTING instance, for
 *    infrastructure owners whose identity other objects hold (the 2D CacheService / PipelineManager stack).
 */

export type GpuDeviceStatus = 'initializing' | 'ok' | 'lost' | 'recovering' | 'failed' | 'unavailable';

export interface GpuDeviceStatusInfo {
  status: GpuDeviceStatus;
  /** The browser's loss reason ('destroyed' | 'unknown'), or why WebGPU is unavailable / recovery failed. */
  reason: string | null;
  /** The browser's loss message (or the error message). */
  message: string | null;
  /** How many times the device was lost this session. */
  lostCount: number;
  /** How many of those losses were recovered. */
  recoveredCount: number;
  lastLostAt: number | null;
  lastRecoveredAt: number | null;
  /** Wall time of the last recovery (lost → ok), ms. */
  lastRecoveryMs: number | null;
  /** Adapter description (best effort; browsers may hide it). */
  gpuName: string | null;
  /** What the last recovery could NOT bring back (e.g. raster strokes painted after the last read-back). */
  unrecovered: string[];
}

export type GpuDeviceStatusListener = (info: GpuDeviceStatusInfo) => void;

export class GpuDeviceStatusTracker {
  private _info: GpuDeviceStatusInfo = {
    status: 'initializing', reason: null, message: null, lostCount: 0, recoveredCount: 0,
    lastLostAt: null, lastRecoveredAt: null, lastRecoveryMs: null, gpuName: null, unrecovered: [],
  };
  private readonly _listeners = new Set<GpuDeviceStatusListener>();

  get info(): GpuDeviceStatusInfo { return { ...this._info, unrecovered: this._info.unrecovered.slice() }; }
  get status(): GpuDeviceStatus { return this._info.status; }

  /** Subscribe; returns the unsubscribe function. The listener is NOT called with the current state. */
  subscribe(fn: GpuDeviceStatusListener): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  set(patch: Partial<GpuDeviceStatusInfo> & { status: GpuDeviceStatus }): void {
    const now = Date.now();
    const prev = this._info.status;
    const next: GpuDeviceStatusInfo = { ...this._info, ...patch };
    if (patch.status === 'lost' && prev !== 'lost') { next.lostCount = this._info.lostCount + 1; next.lastLostAt = now; }
    if (patch.status === 'ok' && (prev === 'recovering' || prev === 'lost')) {
      next.recoveredCount = this._info.recoveredCount + 1;
      next.lastRecoveredAt = now;
      next.lastRecoveryMs = this._info.lastLostAt != null ? now - this._info.lastLostAt : null;
    }
    this._info = next;
    const snap = this.info;
    for (const fn of [...this._listeners]) { try { fn(snap); } catch (e) { console.warn('[Salsa][gpu] status listener threw', e); } }
  }
}

/** Thrown by the renderer's start-up when no WebGPU device can be had. `reason` picks the overlay text. */
export class WebGPUUnavailableError extends Error {
  constructor(public readonly reason: 'no-webgpu' | 'no-adapter' | 'device-failed', message: string) {
    super(message);
    this.name = 'WebGPUUnavailableError';
  }
}

export interface SalsaDevice { adapter: GPUAdapter; device: GPUDevice; gpuName: string | null }

/** Request the adapter + device with the engine's features and limits. Throws WebGPUUnavailableError. */
export async function requestSalsaDevice(gpu: GPU | undefined = (globalThis.navigator as Navigator | undefined)?.gpu): Promise<SalsaDevice> {
  if (!gpu) throw new WebGPUUnavailableError('no-webgpu', 'WebGPU is not supported on this browser.');
  let adapter: GPUAdapter | null = null;
  try { adapter = await gpu.requestAdapter(); } catch { adapter = null; }
  if (!adapter) throw new WebGPUUnavailableError('no-adapter', 'Failed to request WebGPU adapter (No available adapters).');
  let gpuName: string | null = null;
  try {
    const a = adapter as unknown as { info?: { description?: string; vendor?: string; architecture?: string }; requestAdapterInfo?: () => Promise<{ description?: string; vendor?: string; architecture?: string }> };
    const info = a.info ?? (typeof a.requestAdapterInfo === 'function' ? await a.requestAdapterInfo() : null);
    if (info) gpuName = [info.description, info.vendor, info.architecture].filter(Boolean).join(' ') || null;
  } catch { /* adapter info optional */ }
  // Raise the buffer-size ceilings to whatever THIS adapter supports (default is a low 256 MB): a tiled world blows
  // past 256 MB. timestamp-query = exact GPU frame times (GpuFrameTimer); chromium-experimental-multi-draw-indirect =
  // the opportunistic GPU-driven main pass (Renderer3D.setGpuDriven).
  const lim = adapter.limits;
  const f = (name: string) => adapter!.features.has(name as GPUFeatureName) ? [name as GPUFeatureName] : [];
  try {
    const device = await adapter.requestDevice({
      requiredFeatures: ['indirect-first-instance' as GPUFeatureName, ...f('timestamp-query'), ...f('chromium-experimental-multi-draw-indirect')],
      requiredLimits: { maxBufferSize: lim.maxBufferSize, maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize },
    });
    return { adapter, device, gpuName };
  } catch (e) {
    throw new WebGPUUnavailableError('device-failed', `Failed to create the WebGPU device: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Retry `requestSalsaDevice` with a backoff (a GPU process restart can take a moment to bring adapters back). */
export async function requestSalsaDeviceWithRetry(delaysMs: number[] = [0, 250, 1000, 3000], gpu?: GPU): Promise<SalsaDevice> {
  let last: unknown = null;
  for (const d of delaysMs) {
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    try { return await requestSalsaDevice(gpu); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface OverlayText { title: string; lead: string; steps: string[]; action: string }

/** The user-facing text for each failure. Plain language; the steps are what fixes it in practice. */
export function describeWebGPUUnavailable(reason: 'no-webgpu' | 'no-adapter' | 'device-failed' | 'recovery-failed', detail?: string | null): OverlayText {
  const common = [
    'Open chrome://gpu (or edge://gpu) and check that "WebGPU" says "Hardware accelerated".',
    'Turn on "Use graphics acceleration when available" in chrome://settings/system, then relaunch the browser.',
    'Update your graphics driver (NVIDIA / AMD / Intel), then restart the browser.',
  ];
  if (reason === 'recovery-failed') {
    return {
      title: 'The graphics device stopped and could not be restarted',
      lead: 'Your work up to the last save is safe. Reload the page to continue.' + (detail ? ` (${detail})` : ''),
      steps: ['Reload the page.', 'If this keeps happening, close other GPU-heavy tabs or apps.', ...common.slice(2)],
      action: 'Reload',
    };
  }
  if (reason === 'no-webgpu') {
    return {
      title: 'This browser does not support WebGPU',
      lead: 'Salsa draws with WebGPU. Use a current Chrome or Edge (version 113 or later) on Windows, macOS or ChromeOS.',
      steps: ['Update the browser, or open this page in Chrome or Edge.', ...common],
      action: 'Reload',
    };
  }
  return {
    title: 'No graphics adapter is available',
    lead: 'WebGPU is supported but the browser could not get a graphics adapter ("No available adapters").' + (detail ? ` (${detail})` : ''),
    steps: [
      ...common,
      'Chrome Canary / Dev builds sometimes ship with WebGPU blocked for your GPU: try stable Chrome, or enable chrome://flags/#enable-unsafe-webgpu (advanced).',
      'On a laptop, make sure the browser is allowed to use the dedicated GPU.',
    ],
    action: 'Reload',
  };
}

/** Show a full-canvas overlay with the text above (idempotent per canvas; returns the element). The page decides what
 *  "action" does — the default reloads. Never throws (no DOM in tests / workers). */
export function showWebGPUOverlay(canvas: HTMLCanvasElement | null | undefined, text: OverlayText, onAction?: () => void): HTMLElement | null {
  try {
    if (typeof document === 'undefined') return null;
    const host = canvas?.parentElement ?? document.body;
    let el = host.querySelector(':scope > .salsa-gpu-overlay') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'salsa-gpu-overlay';
      el.setAttribute('role', 'alert');
      host.appendChild(el);
    }
    const r = canvas?.getBoundingClientRect();
    const inCanvasHost = !!canvas && host === canvas.parentElement;
    Object.assign(el.style, {
      position: inCanvasHost ? 'absolute' : 'fixed', zIndex: '2147483000', display: 'flex', alignItems: 'center', justifyContent: 'center',
      left: inCanvasHost ? `${canvas!.offsetLeft}px` : '0', top: inCanvasHost ? `${canvas!.offsetTop}px` : '0',
      width: inCanvasHost && r && r.width ? `${r.width}px` : '100%', height: inCanvasHost && r && r.height ? `${r.height}px` : '100%',
      background: 'rgba(16,18,24,0.94)', color: '#e8eaf0', font: '14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif',
      boxSizing: 'border-box', padding: '16px',
    } as Partial<CSSStyleDeclaration>);
    if (inCanvasHost && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    el.replaceChildren();
    const card = document.createElement('div');
    Object.assign(card.style, { maxWidth: '560px', width: '100%' } as Partial<CSSStyleDeclaration>);
    const h = document.createElement('h2');
    h.textContent = text.title;
    Object.assign(h.style, { margin: '0 0 8px', fontSize: '20px', fontWeight: '600' } as Partial<CSSStyleDeclaration>);
    const p = document.createElement('p');
    p.textContent = text.lead;
    Object.assign(p.style, { margin: '0 0 12px', opacity: '0.85' } as Partial<CSSStyleDeclaration>);
    const ol = document.createElement('ol');
    Object.assign(ol.style, { margin: '0 0 16px', paddingLeft: '20px' } as Partial<CSSStyleDeclaration>);
    for (const s of text.steps) { const li = document.createElement('li'); li.textContent = s; li.style.margin = '4px 0'; ol.appendChild(li); }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text.action;
    Object.assign(btn.style, { padding: '8px 16px', borderRadius: '6px', border: '0', background: '#4c7dff', color: '#fff', font: 'inherit', cursor: 'pointer' } as Partial<CSSStyleDeclaration>);
    btn.addEventListener('click', () => { if (onAction) onAction(); else location.reload(); });
    card.append(h, p, ol, btn);
    el.appendChild(card);
    return el;
  } catch { return null; }
}

/** Remove the overlay shown by showWebGPUOverlay (if any). */
export function hideWebGPUOverlay(canvas: HTMLCanvasElement | null | undefined): void {
  try {
    if (typeof document === 'undefined') return;
    const host = canvas?.parentElement ?? document.body;
    host.querySelector(':scope > .salsa-gpu-overlay')?.remove();
  } catch { /* no DOM */ }
}

/**
 * Re-run an owner's constructor and move the fresh state into the EXISTING instance (`target`), so every object that
 * holds `target` keeps a valid reference. All own properties are replaced by the fresh instance's; properties the fresh
 * instance doesn't have are deleted. `keepIdentity` names sub-objects that other objects hold too (an atlas a drawing
 * service captured): those are rebuilt in place recursively instead of being swapped for the fresh object.
 *
 * Only for classes whose constructor registers no listeners / callbacks bound to the new instance (the fresh object
 * would otherwise live on as a ghost). The 2D render stack qualifies (checked 2026-10-03).
 */
export function rebuildInPlace<T extends object>(target: T, fresh: T, keepIdentity: ReadonlyArray<keyof T & string> = []): T {
  if (target === fresh) return target;
  const t = target as Record<string, unknown>, f = fresh as Record<string, unknown>;
  const keep = new Set<string>(keepIdentity);
  for (const k of Object.getOwnPropertyNames(t)) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) delete t[k];
  }
  for (const k of Object.getOwnPropertyNames(f)) {
    const fv = f[k], tv = t[k];
    if (keep.has(k) && tv && fv && typeof tv === 'object' && typeof fv === 'object' && Object.getPrototypeOf(tv) === Object.getPrototypeOf(fv)) {
      rebuildInPlace(tv as object, fv as object);
      continue;
    }
    const d = Object.getOwnPropertyDescriptor(f, k)!;
    Object.defineProperty(t, k, d);
  }
  return target;
}

/** True for any WebGPU object (buffer, texture, view, sampler, bind group, layout, pipeline, shader, query set, bundle). */
export function isGpuObject(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const n of GPU_CLASSES) {
    const C = g[n] as (abstract new (...a: never[]) => unknown) | undefined;
    if (typeof C === 'function' && v instanceof C) return true;
  }
  return false;
}
const GPU_CLASSES = ['GPUBuffer', 'GPUTexture', 'GPUTextureView', 'GPUSampler', 'GPUBindGroup', 'GPUBindGroupLayout', 'GPUPipelineLayout',
  'GPURenderPipeline', 'GPUComputePipeline', 'GPUShaderModule', 'GPUQuerySet', 'GPURenderBundle', 'GPUExternalTexture'];

/**
 * Drop every own field of `owner` that holds a GPU object made on the old device (field → null, array of GPU objects →
 * emptied, Map with GPU values → cleared). For owners whose GPU resources are all LAZY (`if (!this.x) this.x = ...`):
 * the next use re-creates them on the new device. Returns the swept field names (diagnostics). `skip` = fields the
 * caller rebuilds itself.
 */
export function sweepGpuFields(owner: object, skip: ReadonlyArray<string> = []): string[] {
  const o = owner as Record<string, unknown>;
  const skipSet = new Set(skip);
  const swept: string[] = [];
  for (const k of Object.getOwnPropertyNames(o)) {
    if (skipSet.has(k)) continue;
    const v = o[k];
    if (isGpuObject(v)) { o[k] = null; swept.push(k); continue; }
    if (Array.isArray(v) && v.length && v.some(isGpuObject)) { v.length = 0; swept.push(k); continue; }
    if (v instanceof Map && v.size) {
      let hit = false;
      for (const x of v.values()) { if (isGpuObject(x)) { hit = true; break; } }
      if (hit) { v.clear(); swept.push(k); }
    }
  }
  return swept;
}
