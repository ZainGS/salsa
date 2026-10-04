// WorkerJobService — the ONE shared Web Worker orchestrator (docs/specs/performance-plan.md P3.1).
//
//  · LANES — a lane is one worker SCRIPT (e.g. 'world' = the city/tile builder bundle, 'pixel' = the PNG encoder,
//    'character' = the procedural character generators). Workers spawn lazily per lane up to the lane's cap; the
//    total across lanes is capped by navigator.hardwareConcurrency (minus the main thread, ≤ 8) — every lane is
//    still guaranteed one worker.
//  · JOB KINDS — typed, registered by modules: `registerKind({ kind, lane, handler })`. The SAME `handler` runs in
//    the worker (the lane's script calls `serveJobs` with it) and in the main-thread FALLBACK, so output is identical
//    by construction. The fallback structured-clones the payload first (exactly what postMessage does), so a handler
//    sees the same independent copy on both paths.
//  · PRIORITIES — 'interactive' (the user is waiting on it: a slider, a click) > 'visible' (on screen soon: streamed
//    tiles, a document-load city) > 'background' (prefetch, encodes). Jobs queue in the SERVICE (not inside a
//    worker's FIFO) and dispatch to an idle worker highest-priority-first, FIFO within a priority — so a pan or a
//    slider never waits behind a queue of background work.
//  · CANCELLATION — `handle.cancel()`, or a `key`: a new job with the same key supersedes (cancels) any older
//    queued / running one (stale regens). Queued jobs are dropped before dispatch; a running job's result is
//    discarded on arrival (its promise rejects with a JobCancelledError). `terminateOnCancel` kinds instead kill the
//    worker so the next job starts at once (the lane respawns it and replays the sticky shared state).
//  · TRANSFERABLES — `transfer` on run() moves input buffers to the worker; handlers mark result buffers with
//    api.transfer (zero-copy back).
//  · PROGRESS — per-job onProgress (worker api.progress) + a service-wide `onProgress` event for a host loading
//    overlay: { queued, running, done, total, active, jobs: [{ kind, label, p, priority }] }.
//  · FALLBACK — no Worker (vitest / headless / SSR / spawn failure / every worker of the lane crashed): jobs run on
//    the main thread, ONE per macrotask (time-sliced: the event loop — and a frame — gets a turn between jobs),
//    still in priority order, still cancellable while queued.

import { isJobParts, type JobApi, type JobHandler, type JobMessage, type JobReply } from './worker-job-runtime';

export type JobPriority = 'interactive' | 'visible' | 'background';
const PRIO_RANK: Record<JobPriority, number> = { interactive: 0, visible: 1, background: 2 };

export interface LaneSpec {
    lane: string;
    /** Construct one worker of this lane (e.g. `() => new TileWorker()` from a `?worker&inline` import). */
    create: () => Worker;
    /** Max workers for this lane (default: the hardware cap). */
    maxWorkers?: number;
    /** Extra environment check (e.g. OffscreenCanvas for the pixel encoder). False → the lane is fallback-only. */
    supported?: () => boolean;
    /** Concurrent jobs per worker (default 1). >1 for async handlers that mostly await (encoders). */
    concurrency?: number;
}

export interface JobKindSpec<I = unknown, O = unknown> {
    kind: string;
    lane: string;
    /** Runs in the worker (via the lane script's serveJobs) AND as the main-thread fallback. Omit to make the kind
     *  worker-only (run() then rejects with WorkerUnavailableError when the lane has no live worker). */
    handler?: JobHandler<I, O>;
    /** Fallback: skip the payload structuredClone (the handler never mutates its payload). Default false. */
    noCloneFallback?: boolean;
    /** Kill the worker when a RUNNING job of this kind is cancelled (long jobs; frees the worker immediately). */
    terminateOnCancel?: boolean;
}

export interface RunOptions {
    priority?: JobPriority;
    /** Supersede key: a newer job with the same key cancels this one (queued or running). */
    key?: string;
    /** Input buffers to TRANSFER to the worker (detached main-side). Ignored by the fallback. */
    transfer?: Transferable[];
    /** Human label for a host overlay ("Building city…"). */
    label?: string;
    onProgress?: (p: number) => void;
    /** 'worker' = never use the main-thread fallback (reject with WorkerUnavailableError instead). */
    mode?: 'auto' | 'worker';
    /** Per-job override of the kind's `terminateOnCancel` (performance-plan P10.D6: a streamed FULL tile that left the
     *  window kills its worker at once instead of finishing a stale 2-4 s build; cheap tiles of the same kind do not). */
    terminateOnCancel?: boolean;
}

export interface JobHandle<O> {
    readonly id: number;
    readonly promise: Promise<O>;
    /** Cancel (queued → dropped; running → result discarded). Idempotent. */
    cancel(): void;
}

export interface WorkerJobProgress {
    queued: number;
    running: number;
    /** Completed (ok or failed) since the service last went idle — with `total` gives a loading fraction. */
    done: number;
    total: number;
    /** True while any job is queued or running. */
    active: boolean;
    jobs: Array<{ id: number; kind: string; label?: string; priority: JobPriority; p: number; running: boolean }>;
}

export interface WorkerJobStats {
    workers: Record<string, number>;
    hardwareCap: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    fallbackRuns: number;
    byKind: Record<string, { runs: number; worker: number; fallback: number; totalMs: number; maxMs: number }>;
}

export class JobCancelledError extends Error { constructor(kind: string) { super(`job '${kind}' cancelled`); this.name = 'JobCancelledError'; } }
export class WorkerUnavailableError extends Error { constructor(lane: string) { super(`no worker for lane '${lane}'`); this.name = 'WorkerUnavailableError'; } }

interface Job {
    id: number; kind: string; spec: JobKindSpec<any, any>; payload: unknown; opts: RunOptions;
    prio: number; seq: number; p: number; t0: number;
    state: 'queued' | 'running' | 'done' | 'cancelled';
    worker: LaneWorker | null;   // null while queued / when running on the fallback
    resolve: (v: any) => void; reject: (e: unknown) => void;
    /** P19: the parts of a result posted in parts (api.part), until its 'done'. */
    parts?: unknown[];
}

interface LaneWorker { w: Worker; lane: string; busy: number; dead: boolean }

interface Lane { spec: LaneSpec; workers: LaneWorker[]; shared: Map<string, unknown>; failed: boolean; crashes: number }

const hasWorker = (): boolean => typeof Worker !== 'undefined';

export class WorkerJobService {
    /** P19 A/B: a worker killed by a terminateOnCancel cancel is replaced at once (false = lazily, on a queued job). */
    static respawnRecycled = true;
    private readonly _lanes = new Map<string, Lane>();
    private readonly _kinds = new Map<string, JobKindSpec<any, any>>();
    private readonly _queue: Job[] = [];
    private readonly _running = new Map<number, Job>();
    private readonly _byKey = new Map<string, Job>();
    private _seq = 0;
    private _fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    private _fallbackRunning = false;
    private readonly _listeners = new Set<(p: WorkerJobProgress) => void>();
    private _emitQueued = false;
    private _epochDone = 0;
    private _epochTotal = 0;
    private readonly _stats = { completed: 0, failed: 0, cancelled: 0, fallbackRuns: 0 };
    private readonly _byKind: WorkerJobStats['byKind'] = {};
    /** The hardware cap: total workers across lanes (cores − 1 for the main thread, 1…8). */
    readonly hardwareCap: number;

    constructor(opts: { hardwareCap?: number } = {}) {
        const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        this.hardwareCap = Math.max(1, Math.min(opts.hardwareCap ?? cores - 1, 8));
    }

    // ── registration ────────────────────────────────────────────────────────────────────────────────
    registerLane(spec: LaneSpec): void {
        const prev = this._lanes.get(spec.lane);
        if (prev) { prev.spec = spec; return; }   // idempotent (a module re-registering keeps the live workers)
        this._lanes.set(spec.lane, { spec, workers: [], shared: new Map(), failed: false, crashes: 0 });
    }
    registerKind<I, O>(spec: JobKindSpec<I, O>): void { this._kinds.set(spec.kind, spec as JobKindSpec<any, any>); }
    hasKind(kind: string): boolean { return this._kinds.has(kind); }

    /** Spawn up to `n` workers of a lane NOW (eager — e.g. the tile pool's fixed size). Returns the live count. */
    ensureWorkers(lane: string, n: number): number {
        const L = this._lanes.get(lane);
        if (!L) return 0;
        while (this._live(L).length < Math.min(n, this._laneCap(L)) && this._spawn(L)) { /* spawn */ }
        return this._live(L).length;
    }

    /** True when the lane has (or can spawn) a live worker. */
    workerAvailable(lane: string): boolean {
        const L = this._lanes.get(lane);
        if (!L || !this._laneSupported(L)) return false;
        if (this._live(L).length) return true;
        return !L.failed;   // never failed → a spawn will be attempted on the first job
    }
    /** Live worker count of a lane. */
    liveWorkers(lane: string): number { const L = this._lanes.get(lane); return L ? this._live(L).length : 0; }

    /** Sticky lane state: posted to every live worker now and replayed to each newly-spawned one; the fallback
     *  reads the original. Skipped when `value` is identical to the last broadcast (identity compare — callers
     *  pass the same object to avoid re-cloning, as the tile pool's params broadcast always did). */
    broadcast(lane: string, key: string, value: unknown): void {
        const L = this._lanes.get(lane);
        if (!L) return;
        if (L.shared.has(key) && L.shared.get(key) === value) return;
        L.shared.set(key, value);
        for (const lw of this._live(L)) this._post(lw, { t: 'shared', key, value });
    }

    // ── running ─────────────────────────────────────────────────────────────────────────────────────
    run<I, O>(kind: string, payload: I, opts: RunOptions = {}): JobHandle<O> {
        const spec = this._kinds.get(kind);
        const id = ++this._seq;
        let resolve!: (v: O) => void, reject!: (e: unknown) => void;
        const promise = new Promise<O>((res, rej) => { resolve = res; reject = rej; });
        if (!spec) { reject(new Error(`unknown job kind '${kind}'`)); return { id, promise, cancel: () => {} }; }
        const job: Job = { id, kind, spec, payload, opts, prio: PRIO_RANK[opts.priority ?? 'visible'], seq: id, p: 0, t0: 0,
            state: 'queued', worker: null, resolve, reject };
        if (opts.key) { const old = this._byKey.get(opts.key); if (old) this._cancel(old); this._byKey.set(opts.key, job); }
        this._queue.push(job);
        this._epochTotal++;
        this._pump();
        this._emit();
        return { id, promise, cancel: () => this._cancel(job) };
    }

    /** Cancel the queued/running job with exactly this supersede key (no-op when none). */
    cancelByKey(key: string): void { const j = this._byKey.get(key); if (j) this._cancel(j); }

    /** Cancel every queued/running job whose key starts with `prefix` (e.g. all of a city's selective regens). */
    cancelByKeyPrefix(prefix: string): void {
        for (const [k, j] of [...this._byKey]) if (k.startsWith(prefix)) this._cancel(j);
    }

    // ── events / stats ──────────────────────────────────────────────────────────────────────────────
    /** Subscribe to aggregate progress (fires on enqueue / start / progress / finish, coalesced per microtask). */
    onProgress(cb: (p: WorkerJobProgress) => void): () => void { this._listeners.add(cb); return () => { this._listeners.delete(cb); }; }

    progress(): WorkerJobProgress {
        const jobs: WorkerJobProgress['jobs'] = [];
        for (const j of this._running.values()) if (j.state === 'running') jobs.push({ id: j.id, kind: j.kind, label: j.opts.label, priority: j.opts.priority ?? 'visible', p: j.p, running: true });
        for (const j of this._queue) jobs.push({ id: j.id, kind: j.kind, label: j.opts.label, priority: j.opts.priority ?? 'visible', p: 0, running: false });
        const active = jobs.length > 0;
        return { queued: this._queue.length, running: jobs.filter(x => x.running).length, done: this._epochDone, total: this._epochTotal, active, jobs };
    }

    stats(): WorkerJobStats {
        const workers: Record<string, number> = {};
        for (const [name, L] of this._lanes) workers[name] = this._live(L).length;
        return { workers, hardwareCap: this.hardwareCap, queued: this._queue.length, running: this._running.size, ...this._stats,
            byKind: JSON.parse(JSON.stringify(this._byKind)) };
    }

    /** Terminate every worker of a lane and reject its running AND queued jobs (callers take their own fallback,
     *  exactly like the old per-pool dispose). Used by setStreamWorkers(false) and teardown. A later job respawns. */
    disposeLane(lane: string): void {
        const L = this._lanes.get(lane);
        if (!L) return;
        for (const j of [...this._queue]) {
            if (j.spec.lane !== lane) continue;
            this._queue.splice(this._queue.indexOf(j), 1);
            j.state = 'done';
            if (j.opts.key && this._byKey.get(j.opts.key) === j) this._byKey.delete(j.opts.key);
            this._stats.failed++;
            j.reject(new Error(`lane '${lane}' disposed`));
            this._bumpDone();
        }
        for (const lw of [...L.workers]) this._killWorker(L, lw, new Error(`lane '${lane}' disposed`));
        L.shared.clear();
        L.failed = false;
    }
    dispose(): void {
        for (const name of this._lanes.keys()) this.disposeLane(name);
        for (const j of [...this._queue]) this._cancel(j);
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────────
    private _live(L: Lane): LaneWorker[] { return L.workers.filter(w => !w.dead); }
    private _laneSupported(L: Lane): boolean {
        if (!hasWorker()) return false;
        try { return L.spec.supported ? L.spec.supported() : true; } catch { return false; }
    }
    private _totalLive(): number { let n = 0; for (const L of this._lanes.values()) n += this._live(L).length; return n; }
    private _laneCap(L: Lane): number { return Math.max(1, Math.min(L.spec.maxWorkers ?? this.hardwareCap, this.hardwareCap)); }

    private _spawn(L: Lane): LaneWorker | null {
        if (!this._laneSupported(L)) return null;
        const live = this._live(L).length;
        if (live >= this._laneCap(L)) return null;
        if (live > 0 && this._totalLive() >= this.hardwareCap) return null;   // global cap (each lane still gets one)
        // A lane that keeps crashing stops respawning (its jobs go to the fallback once empty). Mark it failed when it
        // is EMPTY: disposeLane resets `failed` but not `crashes`, and the fallback only takes `failed` lanes — without
        // this every later job sat queued forever (promise never settled; isUpdatingCity stuck). Bug-hunt 2026-10-01.
        if (L.crashes >= 3) { if (!live) L.failed = true; return null; }
        let w: Worker;
        try { w = L.spec.create(); } catch { L.failed = true; return null; }
        const lw: LaneWorker = { w, lane: L.spec.lane, busy: 0, dead: false };
        w.onmessage = (e: MessageEvent<JobReply>) => this._onReply(lw, e.data);
        w.onerror = (ev: Event) => { (ev as ErrorEvent)?.preventDefault?.(); this._killWorker(L, lw, new Error(`${L.spec.lane} worker error`), true); };
        L.workers.push(lw);
        for (const [key, value] of L.shared) this._post(lw, { t: 'shared', key, value });   // replay sticky state
        return lw;
    }

    private _post(lw: LaneWorker, m: JobMessage, transfer: Transferable[] = []): boolean {
        try { lw.w.postMessage(m, transfer); return true; } catch { return false; }
    }

    /** A worker crashed / was killed: remove it (dispatch must never pick it again — postMessage to a dead worker
     *  silently drops, which would strand its jobs forever) and reject its in-flight jobs. A lane that has no live
     *  worker left after a crash is marked failed → its future jobs take the fallback. */
    private _killWorker(L: Lane, lw: LaneWorker, err: Error, crash = false): void {
        if (lw.dead) return;
        lw.dead = true;
        try { lw.w.terminate(); } catch { /* already dead */ }
        const i = L.workers.indexOf(lw);
        if (i >= 0) L.workers.splice(i, 1);
        if (crash) L.crashes++;
        if (crash && !this._live(L).length) L.failed = true;   // a CRASH that empties the lane → fallback from now on
        for (const j of [...this._running.values()]) {
            if (j.worker !== lw) continue;
            if (j.state === 'cancelled') { this._running.delete(j.id); continue; }
            this._finish(j, false, err);
        }
        this._pump();
    }

    private _cancel(j: Job): void {
        if (j.state === 'done' || j.state === 'cancelled') return;
        const wasRunning = j.state === 'running';
        j.state = 'cancelled';
        this._stats.cancelled++;
        if (j.opts.key && this._byKey.get(j.opts.key) === j) this._byKey.delete(j.opts.key);
        const qi = this._queue.indexOf(j);
        if (qi >= 0) this._queue.splice(qi, 1);
        j.reject(new JobCancelledError(j.kind));
        if (wasRunning && j.worker && (j.opts.terminateOnCancel ?? j.spec.terminateOnCancel)) {
            const L = this._lanes.get(j.spec.lane);
            if (L) {
                this._running.delete(j.id);
                this._killWorker(L, j.worker, new Error(`${j.kind} cancelled (worker recycled)`));
                // P19: RE-spawn the recycled worker now. Lazily (only when a job queued service-side) was not enough: the
                // tile stream sizes its dispatch to the LIVE count, so each recycle shrank it for good — a Play run
                // drained the world lane 8 → 0 and the stream fell back to a 3.4 s main-thread full-tile build.
                if (WorkerJobService.respawnRecycled) { this._spawn(L); this._pump(); }
            }
        }
        this._bumpDone();
        this._emit();
    }

    private _onReply(lw: LaneWorker, m: JobReply): void {
        const j = this._running.get(m.id);
        if (!j || j.worker !== lw) return;
        if (m.t === 'progress') {
            if (j.state !== 'running') return;
            j.p = Math.max(0, Math.min(1, m.p));
            try { j.opts.onProgress?.(j.p); } catch { /* listener error */ }
            this._emit();
            return;
        }
        if (m.t === 'part') {   // P19: one piece of a result posted in parts (api.part); kept until 'done'
            if (j.state === 'running') (j.parts ??= []).push(m.part);
            return;
        }
        this._running.delete(j.id);
        lw.busy = Math.max(0, lw.busy - 1);
        if (j.state === 'cancelled') { this._pump(); return; }   // superseded while running — discard
        if (m.t === 'done') {
            // P19: a result posted in parts resolves with the parts (in order: one worker's messages arrive in order)
            if (isJobParts(m.result)) {
                const parts = j.parts ?? [];
                j.parts = undefined;
                if (parts.length === m.result.__jobParts) this._finish(j, true, parts, 'worker');
                else this._finish(j, false, new Error(`${j.kind}: ${parts.length} of ${m.result.__jobParts} parts arrived`));
            } else this._finish(j, true, m.result, 'worker');
        }
        else this._finish(j, false, new Error(m.error));
        this._pump();
    }

    private _finish(j: Job, ok: boolean, value: unknown, path: 'worker' | 'fallback' = 'worker'): void {
        if (j.state === 'cancelled' || j.state === 'done') return;
        j.state = 'done';
        this._running.delete(j.id);
        if (j.opts.key && this._byKey.get(j.opts.key) === j) this._byKey.delete(j.opts.key);
        const ms = j.t0 ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) - j.t0 : 0;
        const k = (this._byKind[j.kind] ??= { runs: 0, worker: 0, fallback: 0, totalMs: 0, maxMs: 0 });
        if (ok) {
            this._stats.completed++;
            k.runs++; k[path]++; k.totalMs += ms; if (ms > k.maxMs) k.maxMs = ms;
            j.p = 1;
            j.resolve(value);
        } else {
            this._stats.failed++;
            j.reject(value);
        }
        this._bumpDone();
        this._emit();
    }

    private _bumpDone(): void {
        this._epochDone++;
        if (!this._queue.length && !this._running.size) { this._epochDone = 0; this._epochTotal = 0; }
    }

    /** Dispatch queued jobs: each to an idle worker of its lane (spawning lazily), or to the fallback. */
    private _pump(): void {
        if (!this._queue.length) return;
        // highest priority first, FIFO within a priority (stable sort by (prio, seq))
        this._queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
        let needFallback = false;
        for (let i = 0; i < this._queue.length; i++) {
            const j = this._queue[i];
            const L = this._lanes.get(j.spec.lane);
            const useWorker = !!L && this._laneSupported(L) && !(L.failed && !this._live(L).length);
            if (!useWorker) {
                if (j.opts.mode === 'worker' || !j.spec.handler) {
                    this._queue.splice(i--, 1);
                    j.state = 'done';
                    this._stats.failed++;
                    j.reject(new WorkerUnavailableError(j.spec.lane));
                    this._bumpDone();
                    continue;
                }
                needFallback = true;
                continue;
            }
            const conc = Math.max(1, L!.spec.concurrency ?? 1);
            let lw: LaneWorker | null = this._live(L!).filter(w => w.busy < conc).sort((a, b) => a.busy - b.busy)[0] ?? null;
            if (!lw) lw = this._spawn(L!);
            if (!lw) {
                // No live worker and the spawn failed (lane now marked failed) → the fallback takes it next slice.
                if (!this._live(L!).length && j.spec.handler) needFallback = true;
                continue;   // lane saturated — stays queued (priority order preserved for the next free worker)
            }
            this._queue.splice(i--, 1);
            j.state = 'running'; j.worker = lw; j.t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
            lw.busy++;
            this._running.set(j.id, j);
            if (!this._post(lw, { t: 'job', id: j.id, kind: j.kind, payload: j.payload }, j.opts.transfer ?? [])) {
                this._running.delete(j.id); lw.busy--;
                this._finish(j, false, new Error(`${j.kind}: postMessage failed (uncloneable payload?)`));
            }
        }
        if (needFallback) this._scheduleFallback();
        this._emit();
    }

    /** Time-sliced main-thread fallback: ONE job per macrotask, highest priority first. */
    private _scheduleFallback(): void {
        if (this._fallbackTimer || this._fallbackRunning) return;
        this._fallbackTimer = setTimeout(() => { this._fallbackTimer = null; void this._runOneFallback(); }, 0);
    }

    private async _runOneFallback(): Promise<void> {
        this._queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
        const idx = this._queue.findIndex(j => {
            const L = this._lanes.get(j.spec.lane);
            return !!j.spec.handler && (!L || !this._laneSupported(L) || (L.failed && !this._live(L).length));
        });
        if (idx < 0) return;
        const j = this._queue.splice(idx, 1)[0];
        const L = this._lanes.get(j.spec.lane);
        j.state = 'running'; j.worker = null; j.t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._running.set(j.id, j);
        this._stats.fallbackRuns++;
        this._emit();
        const shared: Record<string, unknown> = {};
        if (L) for (const [k, v] of L.shared) shared[k] = v;
        const api: JobApi = {
            shared, fallback: true,
            progress: (p) => { if (j.state !== 'running') return; j.p = Math.max(0, Math.min(1, p)); try { j.opts.onProgress?.(j.p); } catch { /* */ } this._emit(); },
            transfer: () => { /* same thread — nothing to transfer */ },
        };
        this._fallbackRunning = true;
        try {
            const payload = !j.spec.noCloneFallback && typeof structuredClone === 'function' ? structuredClone(j.payload) : j.payload;
            const result = await j.spec.handler!(payload, api);
            this._running.delete(j.id);
            if (j.state === 'running') this._finish(j, true, result, 'fallback');
        } catch (err) {
            this._running.delete(j.id);
            if (j.state === 'running') this._finish(j, false, err);
        } finally {
            this._fallbackRunning = false;
        }
        if (this._queue.length) { this._pump(); this._scheduleFallback(); }
    }

    private _emit(): void {
        if (!this._listeners.size || this._emitQueued) return;
        this._emitQueued = true;
        queueMicrotask(() => {
            this._emitQueued = false;
            const p = this.progress();
            for (const cb of this._listeners) { try { cb(p); } catch { /* listener error */ } }
        });
    }
}

/** The process-wide service (one pool for the whole engine). Modules register their lanes/kinds on it lazily. */
let _shared: WorkerJobService | null = null;
export function getWorkerJobService(): WorkerJobService { return (_shared ??= new WorkerJobService()); }
/** TEST hook: replace / reset the singleton. */
export function _setWorkerJobServiceForTests(s: WorkerJobService | null): void { _shared?.dispose(); _shared = s; }
