/**
 * GPUPipelineCache — non-blocking render/compute pipeline creation (docs/specs/performance-plan.md P2,
 * docs/ui/performance.md).
 *
 * WHY: a synchronous `createRenderPipeline` / `createComputePipeline` makes the GPU process compile the shader
 * inline — every command queued behind it (the frame's submit + present) waits, so the page freezes for the whole
 * compile (seconds on a real GPU for the ~2000-line mesh uber-shader, 14–40 s headless). Pipelines can't be built in
 * a Worker (the device lives on the main thread), but `createRenderPipelineAsync` / `createComputePipelineAsync`
 * compile on the driver's background threads without stalling the command stream.
 *
 * MODEL — one cache per GPUDevice (`GPUPipelineCache.for(device)`); every pipeline is a HANDLE registered once
 * (cheap: no compile) and resolved on use:
 *
 *   const h = GPUPipelineCache.for(device).render(descriptorOrFactory, 'MyPass');
 *   ...per frame:  const p = h.get(); if (!p) return;   // pending → SKIP the draw/pass this frame
 *
 * `get()` policy:
 *   - compiled                        → the pipeline
 *   - INSIDE a live frame (beginFrame/endFrame, set by WebGPURenderer.render) and not compiled
 *                                      → starts an async compile at top priority and returns null. The caller skips
 *                                        the draw; when the compile lands the cache fires `onPipelineReady` (the
 *                                        renderer schedules another frame).
 *   - OUTSIDE a live frame (one-shot captures, exports, thumbnails, unit tests) → compiles SYNCHRONOUSLY, exactly as
 *                                        before, so a capture never reads back a half-drawn image. Never the hot path.
 *   - no async API on the device (old browsers, mocks) → synchronous fallback.
 *
 * Results that land MID-frame (render() awaits raster work) are published only when the frame ends, so a frame
 * sees one consistent ready-set (a pre-pass and its composite can't disagree).
 *
 * WARM-UP (P2.2): `h.warm(priority)` queues an async compile. The queue drains in priority order with a small
 * concurrency cap, paced by requestIdleCallback, so warm-up never floods the driver's compile threads ahead of a
 * pipeline a draw is actually waiting for (on-demand requests bypass the queue and the cap).
 *
 * STATUS (P2.3): `status()` → { pending, total, compiled, failed, waitingDraws, ready } and `onStatus(listener)`
 * (coalesced to one notification per microtask) — surfaced to hosts as ShapeManager.getPipelineWarmup3D /
 * onPipelineWarmup3D.
 */

import { gpuCrumbBegin, gpuCrumbEnd } from './gpu-diagnostics';

export type GPUPipelineKind = 'render' | 'compute';

/** Warm-up priority: lower drains first. NOW is used by on-demand (draw-blocking) requests. */
export const PIPELINE_PRIORITY = {
  NOW: 0,
  /** Needed by the loaded document / an enabled feature (e.g. its pass was just constructed). */
  DOCUMENT: 1,
  /** The common set every 3D scene is likely to hit soon. */
  COMMON: 2,
  /** Editing tools, debug views, rarely-used variants. */
  RARE: 3,
} as const;
export type PipelinePriority = number;

export interface PipelineWarmupStatus {
  /** Pipelines queued or compiling right now. */
  pending: number;
  /** Every pipeline that has been requested or queued so far (compiled + pending + failed). */
  total: number;
  compiled: number;
  failed: number;
  /** Pending pipelines that a live frame already asked for (their draws are being skipped). >0 = content missing. */
  waitingDraws: number;
  /** pending === 0. */
  ready: boolean;
}

type AnyPipeline = GPURenderPipeline | GPUComputePipeline;
type DescOf<P> = P extends GPURenderPipeline ? GPURenderPipelineDescriptor : GPUComputePipelineDescriptor;
type State = 'idle' | 'queued' | 'compiling' | 'ready' | 'failed';

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One lazily-compiled pipeline. Create via GPUPipelineCache.render / .compute (never directly). */
export class PipelineHandle<P extends AnyPipeline = AnyPipeline> {
  /** @internal */ _state: State = 'idle';
  /** @internal */ _pipeline: P | null = null;
  /** @internal */ _priority = Infinity;
  /** @internal */ _waited = false;
  /** @internal */ _counted = false;
  /** @internal failed compile attempts + when the last one failed (bounded retry — D-R4) */ _failures = 0;
  /** @internal */ _failedAt = 0;
  private _desc: DescOf<P> | null = null;
  private _waiters: Array<(p: P | null) => void> = [];

  constructor(
    private readonly _cache: GPUPipelineCache,
    readonly kind: GPUPipelineKind,
    private readonly _descSrc: DescOf<P> | (() => DescOf<P>),
    readonly label: string,
  ) {}

  /** The descriptor (factories are evaluated once, on first need). */
  descriptor(): DescOf<P> {
    return this._desc ??= (typeof this._descSrc === 'function' ? (this._descSrc as () => DescOf<P>)() : this._descSrc);
  }

  /** True once compiled (and published). */
  get ready(): boolean { return this._pipeline !== null; }
  /** True while queued or compiling. */
  get pending(): boolean { return this._state === 'queued' || this._state === 'compiling'; }
  get failed(): boolean { return this._state === 'failed'; }

  /** The pipeline, or null while it compiles (inside a live frame). See the module doc for the full policy. */
  get(): P | null {
    if (this._pipeline) return this._pipeline;
    return this._cache._resolve(this as unknown as PipelineHandle) as P | null;
  }

  /** Always returns a pipeline — compiles synchronously when needed. For one-shot offline work only (bakes,
   *  exports) that cannot skip; NEVER call from per-frame code. Null only if compilation failed. */
  getBlocking(): P | null {
    if (this._pipeline) return this._pipeline;
    return this._cache._compileSync(this as unknown as PipelineHandle) as P | null;
  }

  /** Queue a background (async) compile at `priority`; resolves with the pipeline (null on failure). */
  warm(priority: PipelinePriority = PIPELINE_PRIORITY.COMMON): Promise<P | null> {
    if (this._pipeline) return Promise.resolve(this._pipeline);
    if (!this._cache.asyncEnabled && !this._cache.legacyAsyncWarm) {
      // No async API: a background warm would just block, so stay lazy (compiled on first use). A NOW request
      // (an async caller that needs it immediately) compiles synchronously.
      return Promise.resolve(priority <= PIPELINE_PRIORITY.NOW ? this.getBlocking() : null);
    }
    const p = this.whenReady();
    this._cache._enqueue(this as unknown as PipelineHandle, priority);
    return p;
  }

  /** Resolves when compiled (or failed → null). Does not itself start a compile. */
  whenReady(): Promise<P | null> {
    if (this._pipeline) return Promise.resolve(this._pipeline);
    if (this._state === 'failed') return Promise.resolve(null);
    return new Promise((res) => this._waiters.push(res));
  }

  /** @internal */
  _settle(p: P | null): void {
    const w = this._waiters; this._waiters = [];
    for (const f of w) { try { f(p); } catch { /* listener errors are not ours */ } }
  }
}

export type PipelineStatusListener = (s: PipelineWarmupStatus) => void;

export class GPUPipelineCache {
  private static _byDevice = new WeakMap<GPUDevice, GPUPipelineCache>();

  /** The cache for `device` (created on first call). */
  static for(device: GPUDevice): GPUPipelineCache {
    let c = GPUPipelineCache._byDevice.get(device);
    if (!c) {
      c = new GPUPipelineCache(device); GPUPipelineCache._byDevice.set(device, c);
      const carried = GPUPipelineCache._carried.get(device);
      if (carried) { GPUPipelineCache._carried.delete(device); for (const l of carried) c._statusListeners.add(l); }
    }
    return c;
  }
  /** Device-lost recovery (docs/ui/device-recovery.md): drop the cache for `device` (a stable device HANDLE that now
   *  points at a new GPUDevice) so the next for() compiles every pipeline on the new device. Status listeners (host
   *  toasts) move to the new cache. */
  static forget(device: GPUDevice): void {
    const old = GPUPipelineCache._byDevice.get(device);
    if (!old) return;
    GPUPipelineCache._byDevice.delete(device);
    if (old._statusListeners.size) GPUPipelineCache._carried.set(device, [...old._statusListeners]);
    old._queue.length = 0;
  }
  private static _carried = new WeakMap<GPUDevice, PipelineStatusListener[]>();
  /** The cache for `device` if one exists (never creates). */
  static peek(device: GPUDevice | null | undefined): GPUPipelineCache | null {
    return device ? GPUPipelineCache._byDevice.get(device) ?? null : null;
  }

  /** The per-machine default of maxConcurrentWarm for new caches (gpu-capabilities.ts warmConcurrency: 2 desktop,
   *  1 mobile; WebGPURenderer.applyGpuCaps sets it at start-up and on every recovery). */
  static defaultMaxConcurrentWarm = 2;
  /** Max concurrent WARM (queued) compiles. On-demand requests are not capped. */
  maxConcurrentWarm = GPUPipelineCache.defaultMaxConcurrentWarm;
  /** Log every on-demand / sync compile with its timing. */
  verbose = false;

  private _frameDepth = 0;
  private _queue: PipelineHandle[] = [];
  private _inflightWarm = 0;
  private _drainScheduled = false;
  private _deferredPublish: Array<[PipelineHandle, AnyPipeline]> = [];
  private _byKey = new Map<string, PipelineHandle>();
  private _statusListeners = new Set<PipelineStatusListener>();
  private _readyListeners = new Set<(h: PipelineHandle) => void>();
  private _notifyScheduled = false;
  private _counts = { total: 0, compiled: 0, failed: 0 };
  private _stats = { asyncCompiles: 0, syncCompiles: 0, syncMs: 0, skippedRequests: 0 };

  private constructor(readonly device: GPUDevice) {}

  // ── Registration ────────────────────────────────────────────────

  /** Register a render pipeline (no compile). With `key`, an existing handle for that key is returned instead
   *  (dedupe across instances — e.g. two passes sharing an identical pipeline). */
  render(desc: GPURenderPipelineDescriptor | (() => GPURenderPipelineDescriptor), label?: string, key?: string): PipelineHandle<GPURenderPipeline> {
    return this._register('render', desc, label, key) as PipelineHandle<GPURenderPipeline>;
  }
  /** Register a compute pipeline (no compile). See render(). */
  compute(desc: GPUComputePipelineDescriptor | (() => GPUComputePipelineDescriptor), label?: string, key?: string): PipelineHandle<GPUComputePipeline> {
    return this._register('compute', desc, label, key) as PipelineHandle<GPUComputePipeline>;
  }

  private _register(kind: GPUPipelineKind, desc: unknown, label?: string, key?: string): PipelineHandle {
    if (key) { const ex = this._byKey.get(key); if (ex) return ex; }
    const lbl = label ?? (typeof desc === 'object' && desc ? (desc as { label?: string }).label : undefined) ?? key ?? kind;
    const h = new PipelineHandle(this, kind, desc as never, lbl);
    if (key) this._byKey.set(key, h);
    return h;
  }

  // ── Live-frame scope ───────────────────────────────────────────

  /** Enter a live frame: pending pipelines return null (skip) instead of compiling synchronously. Nests. */
  beginFrame(): void { this._frameDepth++; }
  /** Leave a live frame. Publishes compiles that landed mid-frame once the outermost frame ends. */
  endFrame(): void {
    if (this._frameDepth > 0) this._frameDepth--;
    if (this._frameDepth === 0 && this._deferredPublish.length) {
      const list = this._deferredPublish; this._deferredPublish = [];
      for (const [h, p] of list) this._publish(h, p);
    }
  }
  /** True inside beginFrame/endFrame. */
  get inFrame(): boolean { return this._frameDepth > 0; }
  /** Run `fn` as a live frame (try/finally). */
  frame<T>(fn: () => T): T { this.beginFrame(); try { return fn(); } finally { this.endFrame(); } }

  /** A/B "before" mode (globalThis.__salsaPipelineMode = 'sync'): blocking on-demand compiles + the old uncapped
   *  async warm of everything at once — the pre-P2 behaviour, kept only for measurement. */
  get legacyAsyncWarm(): boolean {
    return (globalThis as { __salsaPipelineMode?: string }).__salsaPipelineMode === 'sync'
      && typeof (this.device as unknown as { createRenderPipelineAsync?: unknown }).createRenderPipelineAsync === 'function';
  }

  /** True when the device has the async creation APIs and the legacy A/B switch is off. */
  get asyncEnabled(): boolean {
    const g = globalThis as { __salsaPipelineMode?: string };
    if (g.__salsaPipelineMode === 'sync') return false;   // A/B measurement switch: the pre-P2 blocking behaviour
    const d = this.device as unknown as { createRenderPipelineAsync?: unknown };
    return typeof d.createRenderPipelineAsync === 'function';
  }

  // ── Status / events ────────────────────────────────────────────

  status(): PipelineWarmupStatus {
    const { total, compiled, failed } = this._counts;
    const pending = Math.max(0, total - compiled - failed);
    let waitingDraws = 0;
    if (pending) for (const h of this._pendingSet) if (h._waited) waitingDraws++;
    return { pending, total, compiled, failed, waitingDraws, ready: pending === 0 };
  }
  /** Diagnostics: compile counters since page load. */
  stats(): { asyncCompiles: number; syncCompiles: number; syncMs: number; skippedRequests: number } { return { ...this._stats }; }

  /** Subscribe to status changes (coalesced per microtask). Returns an unsubscribe function. */
  onStatus(listener: PipelineStatusListener): () => void {
    this._statusListeners.add(listener);
    return () => { this._statusListeners.delete(listener); };
  }
  /** Fires whenever a pipeline that a live frame skipped becomes ready — schedule a redraw here. */
  onPipelineReady(listener: (h: PipelineHandle) => void): () => void {
    this._readyListeners.add(listener);
    return () => { this._readyListeners.delete(listener); };
  }
  /** Resolves when nothing is queued or compiling. */
  whenIdle(): Promise<void> {
    if (this.status().ready) return Promise.resolve();
    return new Promise((res) => {
      const off = this.onStatus((s) => { if (s.ready) { off(); res(); } });
    });
  }

  /** Resolves when every pipeline a live frame SKIPPED (status().waitingDraws) has compiled or failed. Captures that
   *  went through a live frame (waitForFrameSettled → snapshot*) await this and re-render, so the read-back image is
   *  never missing the draws that were still compiling (bug-hunt 2026-10-01). */
  whenWaitedSettled(): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const h of this._pendingSet) if (h._waited) waits.push(h.whenReady());
    return waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  }

  // ── Internals (used by PipelineHandle) ─────────────────────────

  private _pendingSet = new Set<PipelineHandle>();

  private _count(h: PipelineHandle): void {
    if (h._counted) return;
    h._counted = true; this._counts.total++;
  }

  /** Bounded RETRY of a failed pipeline (bug-hunt 2026-10-01 D-R4): failures used to be terminal, so one transient
   *  failure (e.g. a compile rejected under memory pressure) disabled that draw — and, through all-or-nothing ready()
   *  gates, whole passes — for the session. A failed handle becomes requestable again after an exponential backoff
   *  (1 s, 2 s), at most MAX_ATTEMPTS compiles in total; a deterministic (shader) error stays failed after that. */
  static readonly MAX_ATTEMPTS = 3;
  private _retryIfDue(h: PipelineHandle): void {
    if (h._state !== 'failed' || h._failures >= GPUPipelineCache.MAX_ATTEMPTS) return;
    if (nowMs() - h._failedAt < 1000 * 2 ** (h._failures - 1)) return;
    h._state = 'idle';
    this._counts.failed--;   // (total stays counted once) — back to pending until the retry settles
    this._pendingSet.add(h);
    this._scheduleNotify();
  }

  /** @internal get() on an un-compiled handle. */
  _resolve(h: PipelineHandle): AnyPipeline | null {
    this._retryIfDue(h);
    if (h._state === 'failed') return null;
    if (!this.asyncEnabled) return this._compileSync(h);
    if (this._frameDepth === 0) {
      // Outside a live frame (capture / export / test): block, as before. A landed-but-unpublished result wins.
      const def = this._deferredPublish.find((e) => e[0] === h);
      if (def) { this._publish(h, def[1]); return def[1]; }
      return this._compileSync(h);
    }
    if (!h._waited) { h._waited = true; this._scheduleNotify(); }
    this._stats.skippedRequests++;
    if (h._state === 'idle' || h._state === 'queued') this._startAsync(h, PIPELINE_PRIORITY.NOW);
    return null;
  }

  /** @internal */
  _compileSync(h: PipelineHandle): AnyPipeline | null {
    if (h._pipeline) return h._pipeline;
    this._retryIfDue(h);
    if (h._state === 'failed') return null;
    const t0 = nowMs();
    let p: AnyPipeline;
    const crumb = gpuCrumbBegin(`sync compile "${h.label}"`);   // CRASH-10: a compile open at a device loss = the suspect
    try {
      const d = h.descriptor();
      p = h.kind === 'render'
        ? this.device.createRenderPipeline(d as GPURenderPipelineDescriptor)
        : this.device.createComputePipeline(d as GPUComputePipelineDescriptor);
    } catch (err) { gpuCrumbEnd(crumb, false); this._fail(h, err); return null; }
    gpuCrumbEnd(crumb);
    const ms = nowMs() - t0;
    this._stats.syncCompiles++; this._stats.syncMs += ms;
    if (this._frameDepth > 0 || this.verbose || typeof (this.device as unknown as { createRenderPipelineAsync?: unknown }).createRenderPipelineAsync === 'function') console.log(`[Salsa][pipe-cache] sync-compiled "${h.label}" ${this._frameDepth > 0 ? 'IN a live frame (blocking)' : 'outside a live frame'} (+${Math.round(ms)}ms)`);
    this._count(h);
    this._publish(h, p);
    return p;
  }

  /** @internal */
  _enqueue(h: PipelineHandle, priority: PipelinePriority): void {
    this._retryIfDue(h);
    if (h._pipeline || h._state === 'failed' || h._state === 'compiling') return;
    if (!this.asyncEnabled) {
      if (this.legacyAsyncWarm) this._startAsync(h, priority, /*legacy*/ true);   // A/B "before": the old fire-everything-at-once warm
      return;
    }
    if (priority <= PIPELINE_PRIORITY.NOW) { this._startAsync(h, priority); return; }   // never wait behind the warm cap
    this._count(h);
    if (h._state === 'queued') { if (priority < h._priority) { h._priority = priority; this._sortQueue(); } return; }
    h._state = 'queued'; h._priority = priority;
    this._pendingSet.add(h);
    this._queue.push(h);
    this._sortQueue();
    this._scheduleDrain();
    this._scheduleNotify();
  }

  private _sortQueue(): void { this._queue.sort((a, b) => a._priority - b._priority); }

  private _scheduleDrain(): void {
    if (this._drainScheduled) return;
    this._drainScheduled = true;
    const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
    const run = () => { this._drainScheduled = false; this._drain(); };
    if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(run, { timeout: 60 });
    else setTimeout(run, 0);
  }

  private _drain(): void {
    while (this._inflightWarm < this.maxConcurrentWarm && this._queue.length) {
      const h = this._queue.shift()!;
      if (h._state !== 'queued') continue;
      this._startAsync(h, h._priority);
    }
  }

  private _startAsync(h: PipelineHandle, priority: PipelinePriority, legacy = false): void {
    if (h._state === 'compiling' || h._pipeline || h._state === 'failed') return;
    if (h._state === 'queued') { const i = this._queue.indexOf(h); if (i >= 0) this._queue.splice(i, 1); }
    const warm = priority > PIPELINE_PRIORITY.NOW && !legacy;
    h._state = 'compiling'; h._priority = priority;
    this._count(h);
    this._pendingSet.add(h);
    if (warm) this._inflightWarm++;
    this._stats.asyncCompiles++;
    const t0 = nowMs();
    let promise: Promise<AnyPipeline>;
    const crumb = gpuCrumbBegin(`compile "${h.label}"`);   // CRASH-10: a compile open at a device loss = the suspect
    try {
      const d = h.descriptor();
      promise = h.kind === 'render'
        ? this.device.createRenderPipelineAsync(d as GPURenderPipelineDescriptor)
        : this.device.createComputePipelineAsync(d as GPUComputePipelineDescriptor);
    } catch (err) {
      if (warm) this._inflightWarm--;
      gpuCrumbEnd(crumb, false);
      this._fail(h, err);
      return;
    }
    promise.then(
      (p) => {
        gpuCrumbEnd(crumb);
        if (warm) this._inflightWarm--;
        if (this.verbose || priority === PIPELINE_PRIORITY.NOW) {
          console.log(`[Salsa][pipe-cache] async-compiled "${h.label}" (p${priority}, ${Math.round(nowMs() - t0)}ms)`);
        }
        if (h._pipeline) { this._scheduleDrain(); return; }   // a sync compile (capture) won the race — discard
        if (this._frameDepth > 0) this._deferredPublish.push([h, p]);
        else this._publish(h, p);
        this._scheduleDrain();
      },
      (err) => {
        gpuCrumbEnd(crumb, false);
        if (warm) this._inflightWarm--;
        this._fail(h, err);
        this._scheduleDrain();
      },
    );
  }

  private _publish(h: PipelineHandle, p: AnyPipeline): void {
    if (h._pipeline) return;
    h._pipeline = p;
    this._pendingSet.delete(h);
    h._state = 'ready';
    this._counts.compiled++;
    h._settle(p);
    if (h._waited) for (const l of this._readyListeners) { try { l(h); } catch { /* ignore */ } }
    this._scheduleNotify();
  }

  private _fail(h: PipelineHandle, err: unknown): void {
    if (h._state === 'failed') return;
    this._count(h);
    this._pendingSet.delete(h);
    h._state = 'failed';
    h._failures++; h._failedAt = nowMs();
    this._counts.failed++;
    console.error(`[Salsa][pipe-cache] pipeline "${h.label}" failed to compile — its draws are skipped`, err);
    h._settle(null);
    this._scheduleNotify();
    // The retry only starts from a get() — i.e. a frame. An idle on-demand loop renders no frame by itself, so a draw
    // waiting on this pipeline would stay missing until unrelated input. When the backoff expires, wake the ready
    // listeners (the renderer schedules a frame) so that frame's get() retries (performance-plan §P15, 2026-10-04).
    if (h._waited && h._failures < GPUPipelineCache.MAX_ATTEMPTS && this._readyListeners.size) {
      const delay = 1000 * 2 ** (h._failures - 1) + 1;
      setTimeout(() => {
        if (h._state !== 'failed') return;
        for (const l of this._readyListeners) { try { l(h); } catch { /* ignore */ } }
      }, delay);
    }
  }

  private _scheduleNotify(): void {
    if (this._notifyScheduled || this._statusListeners.size === 0) return;
    this._notifyScheduled = true;
    queueMicrotask(() => {
      this._notifyScheduled = false;
      const s = this.status();
      for (const l of this._statusListeners) { try { l(s); } catch { /* ignore */ } }
    });
  }
}

/** Convenience: register a render pipeline on `device`'s cache. */
export function renderPipelineHandle(device: GPUDevice, desc: GPURenderPipelineDescriptor | (() => GPURenderPipelineDescriptor), label?: string, key?: string): PipelineHandle<GPURenderPipeline> {
  return GPUPipelineCache.for(device).render(desc, label, key);
}
/** Convenience: register a compute pipeline on `device`'s cache. */
export function computePipelineHandle(device: GPUDevice, desc: GPUComputePipelineDescriptor | (() => GPUComputePipelineDescriptor), label?: string, key?: string): PipelineHandle<GPUComputePipeline> {
  return GPUPipelineCache.for(device).compute(desc, label, key);
}

/**
 * A pass's group of pipelines — the usual way a render pass class adopts the cache:
 *
 *   private readonly _pipes = new PipelineSet(device, PIPELINE_PRIORITY.DOCUMENT);   // warms as soon as added
 *   private readonly _blur = this._pipes.render({...}, 'MyBlur');
 *   run(): if (!this._pipes.ready()) return;   // whole pass skipped (as if the feature were off) until all compile
 *          pass.setPipeline(this._blur.get()!);
 *
 * `ready()` is stable within a live frame (results landing mid-frame publish when it ends), so a pass gated by it
 * at both its record and composite points can't half-run.
 */
export class PipelineSet {
  readonly handles: PipelineHandle[] = [];
  private readonly _cache: GPUPipelineCache;
  constructor(device: GPUDevice, private readonly _warmPriority: PipelinePriority | null = PIPELINE_PRIORITY.DOCUMENT) {
    this._cache = GPUPipelineCache.for(device);
  }
  render(desc: GPURenderPipelineDescriptor | (() => GPURenderPipelineDescriptor), label?: string, key?: string): PipelineHandle<GPURenderPipeline> {
    const h = this._cache.render(desc, label, key);
    this.handles.push(h as unknown as PipelineHandle);
    if (this._warmPriority !== null) void h.warm(this._warmPriority);
    return h;
  }
  compute(desc: GPUComputePipelineDescriptor | (() => GPUComputePipelineDescriptor), label?: string, key?: string): PipelineHandle<GPUComputePipeline> {
    const h = this._cache.compute(desc, label, key);
    this.handles.push(h as unknown as PipelineHandle);
    if (this._warmPriority !== null) void h.warm(this._warmPriority);
    return h;
  }
  /** True when every pipeline is compiled. Requests (non-blocking, in a live frame) any that aren't. */
  ready(): boolean {
    let ok = true;
    for (const h of this.handles) if (!h.get()) ok = false;
    return ok;
  }
  /** Resolves when every pipeline has settled. */
  whenReady(): Promise<void> { return Promise.all(this.handles.map((h) => h.whenReady())).then(() => undefined); }
}
