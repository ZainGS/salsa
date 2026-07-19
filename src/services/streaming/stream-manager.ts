// Spatial Streaming — the content-agnostic engine.  See docs/specs/spatial-streaming.md.
//
// THESIS: load only what the focus needs, at the detail the view warrants; unload the rest. This module is the
// GENERIC half — it knows nothing about cities. It owns a live cache of "chunks" keyed by an opaque string, an
// async build queue (time-sliced so a newcomer never freezes a frame), and the reconcile diff that turns a desired
// target set into build/dispose calls. WHAT a chunk is, and WHICH chunks the focus needs, live in a StreamSource
// (the city is the first one; products / sims / material-structure are future ones — the spec's Phase 5).
//
// Phase 0 (this file's first use): the CityStreamSource returns the current fixed grid around the origin, so the
// output is identical to the old hand-rolled `_tiles`/`_tileQueue` machinery — just behind this general seam.

/** Opaque chunk identity. Positional sources encode coords ("tx,tz"); a depth-axis source could encode a scale band. */
export type StreamKey = string;

/** Where the viewer is looking — world position + a scale/zoom for the depth axis (unused until Phase 2+). */
export interface Focus { x: number; z: number; scale: number }

/** View budget: the radii that gate load / detail / unload, and a hard ceiling on resident chunks. */
export interface StreamBudget { loadRadius: number; detailRadius: number; unloadRadius: number; maxLiveChunks: number }

/** Detail a chunk should build at, given its distance/scale from the focus. Drives per-chunk LOD (Phase 3). */
export type DetailTier = 'full' | 'reduced' | 'proxy';

/** Hysteretic tile snap (Phase 2 focus follow): stay on `current` until `pos` (a position in TILE units) moves more
 *  than 0.5 + `margin` of a tile past the current tile's centre, then snap to the nearest tile. The deadband stops a
 *  focus hovering a tile boundary from thrashing the streamed window. Sub-tile motion within the band is a no-op. */
export function hysteresisTile(pos: number, current: number, margin = 0.15): number {
    return Math.abs(pos - current) > 0.5 + margin ? Math.round(pos) : current;
}

/** One kind of streamable content. The manager calls these; nothing here is city-specific.
 *  `H` is the source's own handle for a realised chunk (the city uses its MeshGroup array). */
export interface StreamSource<H = unknown> {
    /** The chunks the focus needs, NEAREST-FIRST (the manager builds them in this order). Cheap + pure — called
     *  once per reconcile. Phase 0 ignores focus/budget and returns a fixed grid; later phases use them. */
    targetChunks(focus: Focus, budget: StreamBudget): StreamKey[];
    /** OPTIONAL fast COARSE build shown immediately, before the full `build`. Return null to skip straight to full
     *  (e.g. a chunk whose full build is already cheap). When present, the manager runs a PREVIEW pass over the whole
     *  window first (so everything appears as a cheap stand-in almost at once), then upgrades each chunk via `build`,
     *  disposing the preview handle on the swap. This is the "proxy-first / instant-load" path. */
    buildPreview?(key: StreamKey): H | null;
    /** OPTIONAL per-key preview eligibility. Keys this returns false for skip the preview pass entirely and go
     *  straight to the full queue — saving a wasted queue hop + null `buildPreview` call for keys (e.g. proxy tiles)
     *  whose full build IS the cheap build. Default (absent): every key is preview-eligible. */
    canPreviewKey?(key: StreamKey): boolean;
    /** OPTIONAL stable chunk identity ACROSS detail tiers (e.g. "tx,tz" for both "tx,tz" and "tx,tz|p"). When
     *  present, a reconcile that re-keys a chunk to a different tier (proxy↔full flip) HOLDS the old tier's handle
     *  on screen until the replacement's first build lands, then swap-disposes — no one-frame hole at the detail
     *  boundary. Without it, the old key is disposed immediately (the chunk blinks out until the new build). */
    chunkId?(key: StreamKey): string;
    /** OPTIONAL cap on concurrently IN-FLIGHT async builds. Without it, async `build` calls (which dispatch and
     *  return instantly) drain the whole full queue into the worker pool in one frame — while panning, workers then
     *  burn throughput on tiles that left the window before their build starts. Cap ≈ the worker pool size so the
     *  queue stays on the manager (nearest-first, re-prioritised each reconcile) instead of FIFO inside the pool. */
    readonly maxConcurrentBuilds?: number;
    /** Realise one chunk at full detail. May be SYNCHRONOUS (returns the handle) or ASYNCHRONOUS (returns a
     *  Promise — e.g. offloading generation to a Worker pool). The manager tracks in-flight async builds and
     *  discards a result whose chunk left the window before it resolved. Keep a synchronous call short. */
    build(key: StreamKey): H | Promise<H>;
    /** Free one chunk — remove its geometry from the scene and drop any caches it owns. */
    dispose(key: StreamKey, handle: H): void;
    /** Called after each async build slice (e.g. request a render). Optional. */
    onProgress?(): void;
    /** Called once the build queue drains (e.g. recache bounds / reframe). NOT called on the headless path
     *  (matching the legacy tile pump, which returned without it). Optional. */
    onDrained?(): void;
    /** ms to spend building per frame before yielding. Default 10 (the legacy slice). */
    readonly sliceMs?: number;
}

/** A realised chunk: its source handle + whether it's the FULL build yet (false = a preview stand-in awaiting upgrade). */
interface LiveChunk<H> { handle: H; full: boolean }

/** The generic streaming loop: a live cache + a two-phase async build queue (preview → full) + the reconcile diff,
 *  driven by a StreamSource. Sources without `buildPreview` collapse to a single full-build pass (unchanged). */
export class StreamManager<H = unknown> {
    private readonly _live = new Map<StreamKey, LiveChunk<H>>();
    private _previewQueue: StreamKey[] = [];   // fast coarse builds (drained first → the window fills instantly)
    private _fullQueue: StreamKey[] = [];      // full-detail upgrades (drained after previews)
    private readonly _inflight = new Set<StreamKey>();   // async full builds dispatched, awaiting resolve
    private _wanted = new Set<StreamKey>();     // the current target set — an async result for a key not here is discarded
    // Tier-flip hold (chunkId sources): newKey → the OLD tier's still-visible handle, disposed when newKey's first
    // build lands. Keeps a tile from blinking out for the frames between "reconcile re-keyed it" and "rebuilt".
    private readonly _replacing = new Map<StreamKey, { key: StreamKey; handle: H }>();
    private _alt = false;   // preview/full alternation cursor (neither pass may starve the other during a long pan)
    private _raf = 0;

    constructor(private readonly source: StreamSource<H>) {}

    /** Ask the source which chunks this focus/budget needs, then reconcile to that target. The normal entry point. */
    sync(focus: Focus, budget: StreamBudget): void {
        this.reconcile(this.source.targetChunks(focus, budget));
    }

    /** Diff `target` (nearest-first) against the live set: dispose chunks that fell out of range, then REBUILD the
     *  preview + full queues from the target (preserving nearest-first order) — a chunk not yet live needs a preview
     *  (or a full build if the source has no preview); a chunk live-but-not-full still needs its upgrade. */
    reconcile(target: readonly StreamKey[]): void {
        const want = new Set(target);
        this._wanted = want;
        // Tier-flip detection (chunkId sources): a live key that fell out of the target whose CHUNK re-appears
        // under a different key (proxy↔full flip) is HELD, not disposed — the old geometry stays visible until the
        // replacement's first build lands (_completeReplace). Everything else is disposed immediately.
        let idToNew: Map<string, StreamKey> | null = null;
        if (this.source.chunkId) {
            idToNew = new Map();
            for (const k of target) if (!this._live.has(k)) idToNew.set(this.source.chunkId(k), k);
        }
        for (const [key, chunk] of [...this._live]) {
            if (want.has(key)) continue;
            const nk = idToNew?.get(this.source.chunkId!(key));
            if (nk !== undefined && !this._replacing.has(nk)) {
                this._live.delete(key);
                this._replacing.set(nk, { key, handle: chunk.handle });
                continue;
            }
            this.source.dispose(key, chunk.handle);
            this._live.delete(key);
        }
        // Held handles whose replacement key left the target are orphans — dispose them now.
        for (const [nk, r] of [...this._replacing]) {
            if (!want.has(nk)) { this.source.dispose(r.key, r.handle); this._replacing.delete(nk); }
        }
        const canPreview = !!this.source.buildPreview;
        this._previewQueue = [];
        this._fullQueue = [];
        for (const key of target) {
            if (this._inflight.has(key)) continue;               // an async full build is already in progress
            const e = this._live.get(key);
            if (e) { if (!e.full) this._fullQueue.push(key); }   // preview shown → still needs the full upgrade
            else if (canPreview && (this.source.canPreviewKey?.(key) ?? true)) this._previewQueue.push(key);
            else this._fullQueue.push(key);                      // preview-ineligible or unsupported → straight to full
        }
        this._pump();
    }

    /** Build a few chunks per frame (previews first → the window fills fast; then full upgrades). Headless (no rAF)
     *  builds everything synchronously and, matching the legacy pump, does NOT fire onProgress/onDrained. */
    private _pump(): void {
        if (typeof requestAnimationFrame === 'undefined') {
            while (this._buildOne()) { /* drain */ }
            return;
        }
        if (this._raf) return;   // already pumping
        const slice = this.source.sliceMs ?? 10;
        const step = (): void => {
            const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
            do {
                if (!this._buildOne()) break;
            } while (this._pendingCount() && (typeof performance === 'undefined' || performance.now() - t0 < slice));
            this.source.onProgress?.();
            if (this._pendingCount()) { this._raf = requestAnimationFrame(step); return; }
            this._raf = 0;
            this.source.onDrained?.();
        };
        this._raf = requestAnimationFrame(step);
    }

    /** Build ONE queued chunk. Both queues pending → ALTERNATE preview/full (a long pan refills the preview queue
     *  every reconcile; strict previews-first would defer every full upgrade until the pan stops). Full builds are
     *  additionally gated on the async in-flight cap — at the cap, the queue waits ON THE MANAGER (nearest-first,
     *  re-prioritised each reconcile) instead of flooding the worker pool with soon-stale FIFO work. */
    private _buildOne(): boolean {
        const cap = this.source.maxConcurrentBuilds ?? Infinity;
        const fullOk = this._fullQueue.length > 0 && this._inflight.size < cap;
        const prevOk = this._previewQueue.length > 0;
        if (prevOk && fullOk) {
            this._alt = !this._alt;
            if (this._alt) this._buildPreview(this._previewQueue.shift()!);
            else this._buildFull(this._fullQueue.shift()!);
            return true;
        }
        if (prevOk) { this._buildPreview(this._previewQueue.shift()!); return true; }
        if (fullOk) { this._buildFull(this._fullQueue.shift()!); return true; }
        return false;   // nothing buildable (empty, or fulls capped) — the rAF loop idles until inflight resolves
    }

    private _buildPreview(key: StreamKey): void {
        if (!this._live.has(key)) {
            // A throw leaves the chunk unbuilt — the next reconcile re-queues it (never kills the pump loop).
            try {
                const h = this.source.buildPreview!(key);
                if (h !== null && h !== undefined) { this._live.set(key, { handle: h, full: false }); this._completeReplace(key); }
            } catch { /* retried on the next reconcile */ }
        }
        this._fullQueue.push(key);   // upgrade to the full build next (even if the preview was skipped)
    }

    private _buildFull(key: StreamKey): void {
        const prev = this._live.get(key);
        if (prev && prev.full) return;               // already at full detail
        if (this._inflight.has(key)) return;         // async build already dispatched for this key
        let r: H | Promise<H>;
        try { r = this.source.build(key); } catch { return; }   // unbuildable now (e.g. params gone) → reconcile retries
        if (r && typeof (r as { then?: unknown }).then === 'function') {
            // ASYNC (e.g. worker-generated): track it; the preview stays shown until it resolves.
            this._inflight.add(key);
            (r as Promise<H>).then(h => this._onFullDone(key, h), () => { this._inflight.delete(key); this._repumpIfIdle(); });
        } else {
            // SYNC (unchanged path — headless / no-worker / non-city sources).
            if (prev && !prev.full) this.source.dispose(key, prev.handle);
            this._live.set(key, { handle: r as H, full: true });
            this._completeReplace(key);
        }
    }

    /** An async full build resolved. Discard it if the chunk left the window while building; else swap out the
     *  preview and mark it full. The pump's rAF loop stays alive while `_inflight` is non-empty, so it renders the
     *  new geometry on its next tick and fires onDrained once everything settles. */
    private _onFullDone(key: StreamKey, h: H): void {
        this._inflight.delete(key);
        if (!this._wanted.has(key)) { this.source.dispose(key, h); this._repumpIfIdle(); return; }   // left the window mid-build → discard
        const prev = this._live.get(key);
        if (prev && !prev.full) this.source.dispose(key, prev.handle);
        this._live.set(key, { handle: h, full: true });
        this._completeReplace(key);
        this.source.onProgress?.();
        this._repumpIfIdle();
    }

    /** A tier-flip replacement's first build just landed — dispose the held old-tier handle (the swap). */
    private _completeReplace(key: StreamKey): void {
        const r = this._replacing.get(key);
        if (r) { this._replacing.delete(key); this.source.dispose(r.key, r.handle); }
    }

    /** Kick the pump when work remains but no loop is running — the headless path has no rAF loop to resume the
     *  capped full queue when an in-flight build settles, and a browser pump may also have wound down. */
    private _repumpIfIdle(): void {
        if (this._pendingCount() && !this._raf) this._pump();
    }

    private _pendingCount(): number { return this._previewQueue.length + this._fullQueue.length + this._inflight.size; }

    /** Drop ALL live chunks + abort any in-flight pump (the legacy `_clearTiles`). */
    clear(): void {
        if (this._raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._raf);
        this._raf = 0;
        this._previewQueue = [];
        this._fullQueue = [];
        this._inflight.clear();     // pending async results still resolve → _onFullDone sees them un-wanted + disposes
        this._wanted.clear();
        for (const [, r] of this._replacing) this.source.dispose(r.key, r.handle);
        this._replacing.clear();
        for (const [key, chunk] of this._live) this.source.dispose(key, chunk.handle);
        this._live.clear();
    }

    has(key: StreamKey): boolean { return this._live.has(key); }
    get liveCount(): number { return this._live.size; }
    get pending(): number { return this._pendingCount(); }
    /** Builds queued on the MAIN thread (previews + fulls awaiting a slot) — excludes async in-flight work, which
     *  costs the main thread nothing. Hosts use this to shrink their own per-frame budgets while the pump is busy. */
    get queued(): number { return this._previewQueue.length + this._fullQueue.length; }
    /** True while an async build is in flight (the legacy `_tileRaf` truthiness). */
    get building(): boolean { return this._raf !== 0; }
}
