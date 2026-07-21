// A pool of Web Workers that generate tile geometry off the main thread (spec Phase 4). Round-robin dispatch; each
// request resolves with the tile's flat layer-groups (geometry transferred zero-copy from the worker). If Workers
// are unavailable (headless / SSR / construction failure) the pool is empty and `available` is false — callers
// (CityStreamSource) then fall back to the synchronous main-thread build, so nothing breaks.
//
// The worker is INLINED (`?worker&inline`) so its code — including the bundled `src/world` — is embedded as a blob
// in Salsa's dist, needing no asset resolution by the consuming bundler (Frogmarks/webpack).

import type { LayoutParams, WorldGraph } from '../../world';
import type { TileLayerGroup } from '../../world/tile-build';
import type { CentreBuildOptions, CentreBuildResult } from '../../world/centre-build';
import TileWorker from './tile-worker?worker&inline';

/** A worker reply: tile builds carry `groups` only; centre builds also return the builder-mutated `graph`. */
interface WorkerResult { groups: TileLayerGroup[]; graph?: WorldGraph }

interface Pending { resolve: (r: WorkerResult) => void; reject: (e: unknown) => void; worker: Worker }

export class TileWorkerPool {
    private readonly _workers: Worker[] = [];
    private _next = 0;
    private _seq = 0;
    private readonly _pending = new Map<number, Pending>();
    // Params are BROADCAST once per change (identity compare), not structured-cloned per tile request — a reconcile
    // dispatching a dozen builds in one frame used to clone the full LayoutParams a dozen times on the main thread.
    private _lastParams: LayoutParams | null = null;

    constructor(size?: number) {
        if (typeof Worker === 'undefined') return;   // headless → empty pool → caller uses the main-thread build
        const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        const n = Math.max(1, Math.min(size ?? cores - 1, 8));
        try {
            for (let i = 0; i < n; i++) {
                const w = new TileWorker();
                w.onmessage = (e: MessageEvent) => this._onMessage(e);
                w.onerror = () => this._onWorkerError(w);
                this._workers.push(w);
            }
        } catch {
            this.dispose();   // construction failed → empty pool → fallback
        }
    }

    /** True when at least one worker is live — callers must check this and take the sync path otherwise. */
    get available(): boolean { return this._workers.length > 0; }

    /** Live worker count — the streaming source caps concurrent dispatches to this. */
    get size(): number { return this._workers.length; }

    /** Generate one FULL tile's flat layer-groups in a worker. Rejects if the assigned worker errors. */
    build(params: LayoutParams, tx: number, tz: number): Promise<TileLayerGroup[]> {
        if (!this._workers.length) return Promise.reject(new Error('tile pool empty'));
        if (params !== this._lastParams) {
            this._lastParams = params;
            for (const w of this._workers) w.postMessage({ params });   // clone once per worker per params CHANGE
        }
        const w = this._workers[this._next++ % this._workers.length];
        const id = ++this._seq;
        return new Promise<TileLayerGroup[]>((resolve, reject) => {
            this._pending.set(id, { resolve: r => resolve(r.groups), reject, worker: w });
            w.postMessage({ id, tx, tz });   // params already cached worker-side (FIFO per worker guarantees order)
        });
    }

    /** Generate the CENTRE city's full regen in a worker (audit §1.2): every layer-group PRE-DRAPED + the
     *  builder-MUTATED WorldGraph (the caller adopts it — traffic/text-signs/picking read the mutated fields).
     *  Params ride in the request (a Partial, unlike the tiles' broadcast full params — one clone per regen). */
    buildCentre(params: Partial<LayoutParams>, opts: CentreBuildOptions): Promise<CentreBuildResult> {
        if (!this._workers.length) return Promise.reject(new Error('tile pool empty'));
        const w = this._workers[this._next++ % this._workers.length];
        const id = ++this._seq;
        return new Promise<CentreBuildResult>((resolve, reject) => {
            this._pending.set(id, {
                resolve: r => r.graph ? resolve({ groups: r.groups, graph: r.graph }) : reject(new Error('centre build: no graph')),
                reject, worker: w,
            });
            w.postMessage({ id, centre: true, params, parkedTrain: opts.parkedTrain, activeRegions: opts.activeRegions });
        });
    }

    private _onMessage(e: MessageEvent): void {
        const { id, groups, graph, error } = e.data as { id: number; groups?: TileLayerGroup[]; graph?: WorldGraph; error?: string };
        const p = this._pending.get(id);
        if (!p) return;
        this._pending.delete(id);
        if (error !== undefined || !groups) p.reject(new Error(error ?? 'tile worker: empty result'));
        else p.resolve({ groups, graph });
    }

    /** A worker crashed — REMOVE it (round-robin must never pick it again: postMessage to a dead worker silently
     *  drops, which would strand its requests in the StreamManager's `_inflight` forever) and reject its in-flight
     *  requests. If the pool empties, `available` flips false and callers fall back to the sync build path. */
    private _onWorkerError(w: Worker): void {
        const i = this._workers.indexOf(w);
        if (i >= 0) this._workers.splice(i, 1);
        try { w.terminate(); } catch { /* already dead */ }
        if (!this._workers.length) this._lastParams = null;   // a future pool refill must re-broadcast params
        for (const [id, p] of [...this._pending]) {
            if (p.worker !== w) continue;
            this._pending.delete(id);
            p.reject(new Error('tile worker error'));
        }
    }

    dispose(): void {
        for (const w of this._workers) w.terminate();
        this._workers.length = 0;
        this._lastParams = null;
        for (const [, p] of this._pending) p.reject(new Error('tile pool disposed'));
        this._pending.clear();
    }
}
