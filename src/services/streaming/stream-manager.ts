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
    /** OPTIONAL (P10.D6): keys in a second concurrency class — CHEAP builds with their own in-flight cap
     *  (`maxConcurrentCheap`, default = maxConcurrentBuilds). A full queue at its cap then never starves them (the
     *  city's flat tiles used to wait seconds behind 2-4 s full builds while flying), and vice versa. Absent = one class. */
    isCheapKey?(key: StreamKey): boolean;
    readonly maxConcurrentCheap?: number;
    /** OPTIONAL (P17): the FULL class's in-flight cap given how many cheap keys wait in the queue. A source whose cheap
     *  tier must keep up with a fast camera (the city's HLOD skyline) lends it full-build slots while the backlog
     *  lasts. Absent = maxConcurrentBuilds. */
    fullCapFor?(cheapQueued: number): number;
    /** OPTIONAL (P20): does the in-flight async build of `key` still hold its build slot? A source whose builds have a
     *  worker phase and then a main-thread reassembly phase (the city) frees the slot for the next build when the
     *  worker part is done. Absent = every in-flight key holds a slot until it resolves. */
    holdsWorker?(key: StreamKey): boolean;
    /** Realise one chunk at full detail. May be SYNCHRONOUS (returns the handle) or ASYNCHRONOUS (returns a
     *  Promise — e.g. offloading generation to a Worker pool). The manager tracks in-flight async builds and
     *  discards a result whose chunk left the window before it resolved. Keep a synchronous call short. */
    build(key: StreamKey): H | Promise<H>;
    /** Free one chunk — remove its geometry from the scene and drop any caches it owns. `preview` = the handle is the
     *  PREVIEW stand-in, not the key's own build (P10: the city used to cache a dropped flat preview as the FULL tile,
     *  so a tile that left the window before its upgrade landed came back flat for good). */
    dispose(key: StreamKey, handle: H, preview?: boolean): void;
    /** OPTIONAL (performance-plan P10.B5): cancel the in-flight async build of a chunk that LEFT the target. Return
     *  true when it was cancelled — the manager then frees its in-flight slot at once (the build's late result, if any,
     *  is discarded by its dispatch token) instead of holding the slot for the seconds a stale build still runs. */
    cancel?(key: StreamKey): boolean;
    /** OPTIONAL (performance-plan P17): a tier swap of a chunk landed — `next` (the new key's first build) replaces the
     *  held old-tier `prev`. Return true to take over `prev`'s disposal (the source dissolves the swap and calls its own
     *  dispose once done); false / absent = `prev` is disposed now (the old behaviour). */
    crossFade?(prevKey: StreamKey, prev: H, prevPreview: boolean, nextKey: StreamKey, next: H): boolean;
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
    /** P10.D7 A/B: a chunk whose old-tier handle is held by a tier flip skips its preview (see reconcile). */
    static heldAsPreview = true;
    /** P17 A/B: a tier swap may be dissolved by the source (StreamSource.crossFade). false = the swap disposes at once. */
    static crossFade = true;
    private readonly _live = new Map<StreamKey, LiveChunk<H>>();
    private _previewQueue: StreamKey[] = [];   // fast coarse builds (drained first → the window fills instantly)
    private _fullQueue: StreamKey[] = [];      // full-detail upgrades (drained after previews)
    // async full builds dispatched, awaiting resolve: key → dispatch TOKEN (bug-hunt 2026-10-01 D-W4 — a result from an
    // older dispatch of the same key, e.g. one that outlived clear(), must not clear the newer entry or go live)
    private readonly _inflight = new Map<StreamKey, number>();
    private _inflightToken = 0;
    private _wanted = new Set<StreamKey>();     // the current target set — an async result for a key not here is discarded
    // Tier-flip hold (chunkId sources): newKey → the OLD tier's still-visible handle, disposed when newKey's first
    // build lands. Keeps a tile from blinking out for the frames between "reconcile re-keyed it" and "rebuilt".
    private readonly _replacing = new Map<StreamKey, { key: StreamKey; handle: H; preview: boolean }>();
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
                this._replacing.set(nk, { key, handle: chunk.handle, preview: !chunk.full });
                continue;
            }
            this.source.dispose(key, chunk.handle, !chunk.full);
            this._live.delete(key);
        }
        // Held handles whose replacement key left the target are orphans — dispose them now.
        for (const [nk, r] of [...this._replacing]) {
            if (!want.has(nk)) { this.source.dispose(r.key, r.handle, r.preview); this._replacing.delete(nk); }
        }
        // P10.B5: async builds of chunks that left the target — cancel them and free their slots (the cap would
        // otherwise hold the freshly-wanted chunks back behind seconds of stale work after every pan).
        if (this.source.cancel) for (const key of [...this._inflight.keys()]) {
            if (!want.has(key) && this.source.cancel(key)) this._inflight.delete(key);
        }
        const canPreview = !!this.source.buildPreview;
        this._previewQueue = [];
        this._fullQueue = [];
        for (const key of target) {
            if (this._inflight.has(key)) continue;               // an async full build is already in progress
            const e = this._live.get(key);
            if (e) { if (!e.full) this._fullQueue.push(key); }   // preview shown → still needs the full upgrade
            // P10.D7: a tier flip already HOLDS the chunk's old-tier geometry on screen (e.g. the flat tile a moving
            // window just promoted to full) — that IS the stand-in, so building a preview of it again is pure waste.
            else if (canPreview && !(StreamManager.heldAsPreview && this._replacing.has(key)) && (this.source.canPreviewKey?.(key) ?? true)) this._previewQueue.push(key);
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
        const fi = this._nextDispatchable();
        const fullOk = fi >= 0;
        const prevOk = this._previewQueue.length > 0;
        if (prevOk && fullOk) {
            this._alt = !this._alt;
            if (this._alt) this._buildPreview(this._previewQueue.shift()!);
            else this._buildFull(this._fullQueue.splice(fi, 1)[0]);
            return true;
        }
        if (prevOk) { this._buildPreview(this._previewQueue.shift()!); return true; }
        if (fullOk) { this._buildFull(this._fullQueue.splice(fi, 1)[0]); return true; }
        return false;   // nothing buildable (empty, or fulls capped) — the rAF loop idles until inflight resolves
    }

    /** Index of the first full-queue key whose concurrency class has a free in-flight slot (nearest-first order is
     *  kept within each class), or -1. One class (no `isCheapKey`) = the head, while in-flight < the cap. */
    private _nextDispatchable(): number {
        const q = this._fullQueue;
        if (!q.length) return -1;
        const cap = this.source.maxConcurrentBuilds ?? Infinity;
        const isCheap = this.source.isCheapKey, holds = this.source.holdsWorker;
        // P20: an in-flight key whose source says it no longer holds its slot (worker done, reassembling) is not counted
        let busy = this._inflight.size;
        if (holds) { busy = 0; for (const k of this._inflight.keys()) if (holds.call(this.source, k)) busy++; }
        if (!isCheap) return busy < cap ? 0 : -1;
        let cheapIn = 0;
        for (const k of this._inflight.keys()) if (isCheap.call(this.source, k) && (!holds || holds.call(this.source, k))) cheapIn++;
        let fullCap = cap;
        if (this.source.fullCapFor) { let cq = 0; for (const k of q) if (isCheap.call(this.source, k)) cq++; fullCap = this.source.fullCapFor(cq); }
        const fullFree = busy - cheapIn < fullCap, cheapFree = cheapIn < (this.source.maxConcurrentCheap ?? cap);
        if (!fullFree && !cheapFree) return -1;
        for (let i = 0; i < q.length; i++) if (isCheap.call(this.source, q[i]) ? cheapFree : fullFree) return i;
        return -1;
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
            const token = ++this._inflightToken;
            this._inflight.set(key, token);
            (r as Promise<H>).then(h => this._onFullDone(key, h, token), () => {
                if (this._inflight.get(key) === token) this._inflight.delete(key);   // an older dispatch never frees a newer one
                this._repumpIfIdle();
            });
        } else {
            // SYNC (unchanged path — headless / no-worker / non-city sources).
            if (prev && !prev.full) this.source.dispose(key, prev.handle, true);
            this._live.set(key, { handle: r as H, full: true });
            this._completeReplace(key);
        }
    }

    /** An async full build resolved. Discard it if the chunk left the window while building; else swap out the
     *  preview and mark it full. The pump's rAF loop stays alive while `_inflight` is non-empty, so it renders the
     *  new geometry on its next tick and fires onDrained once everything settles. */
    private _onFullDone(key: StreamKey, h: H, token: number): void {
        if (this._inflight.get(key) !== token) { this.source.dispose(key, h); this._repumpIfIdle(); return; }   // stale generation (D-W4)
        this._inflight.delete(key);
        if (!this._wanted.has(key)) { this.source.dispose(key, h); this._repumpIfIdle(); return; }   // left the window mid-build → discard
        const prev = this._live.get(key);
        if (prev && !prev.full) this.source.dispose(key, prev.handle, true);
        this._live.set(key, { handle: h, full: true });
        this._completeReplace(key);
        this.source.onProgress?.();
        this._repumpIfIdle();
    }

    /** A tier-flip replacement's first build just landed — dispose the held old-tier handle (the swap). */
    private _completeReplace(key: StreamKey): void {
        const r = this._replacing.get(key);
        if (!r) return;
        this._replacing.delete(key);
        const next = this._live.get(key);
        if (StreamManager.crossFade && next && this.source.crossFade?.(r.key, r.handle, r.preview, key, next.handle)) return;   // P17: the source disposes it after the fade
        this.source.dispose(r.key, r.handle, r.preview);
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
        for (const [, r] of this._replacing) this.source.dispose(r.key, r.handle, r.preview);
        this._replacing.clear();
        for (const [key, chunk] of this._live) this.source.dispose(key, chunk.handle, !chunk.full);
        this._live.clear();
    }

    has(key: StreamKey): boolean { return this._live.has(key); }
    /** True when `key` is live at its FULL build (not a preview stand-in). P19: a fast window keeps such tiles. */
    isFull(key: StreamKey): boolean { return this._live.get(key)?.full === true; }
    /** P19: true while `key`'s async build is in flight. */
    isInflight(key: StreamKey): boolean { return this._inflight.has(key); }
    /** P19: the chunk ids with something on screen — a live key (any tier, previews too) or a held old tier. Empty
     *  for a source without chunkId. */
    shownChunks(): Set<string> {
        const s = new Set<string>(), id = this.source.chunkId;
        if (!id) return s;
        for (const k of this._live.keys()) s.add(id.call(this.source, k));
        for (const r of this._replacing.values()) s.add(id.call(this.source, r.key));
        return s;
    }
    /** The live chunks as [key, isFullBuild] (false = a preview stand-in still awaiting its upgrade). Diagnostics. */
    liveEntries(): Array<[StreamKey, boolean]> { return [...this._live].map(([k, c]): [StreamKey, boolean] => [k, c.full]); }
    get liveCount(): number { return this._live.size; }
    get pending(): number { return this._pendingCount(); }
    /** Builds queued on the MAIN thread (previews + fulls awaiting a slot) — excludes async in-flight work, which
     *  costs the main thread nothing. Hosts use this to shrink their own per-frame budgets while the pump is busy. */
    get queued(): number { return this._previewQueue.length + this._fullQueue.length; }
    /** True while an async build is in flight (the legacy `_tileRaf` truthiness). */
    get building(): boolean { return this._raf !== 0; }
}
