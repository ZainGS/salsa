// The tile Worker pool — now a thin FAÇADE over the shared WorkerJobService's 'world' lane (performance-plan P3.1).
// Same API + contract as before: `available` is false when no worker is live (headless / SSR / construction failure /
// every worker crashed) and callers (CityStreamSource, WorldManager) then take their synchronous main-thread build.
// What the service adds: jobs queue SERVICE-side and dispatch to an IDLE worker by priority (a document-load or
// slider regen never waits behind a FIFO of streamed tiles), supersede-by-key cancellation, and progress events.

import type { LayoutParams } from '../../world';
import { mergeTileHalves, type TileLayerGroup, type TileBuildOptions } from '../../world/tile-build';
import type { CentreBuildOptions, CentreBuildResult, SelectiveBuildRequest } from '../../world/centre-build';
import { getWorkerJobService, type JobPriority, type WorkerJobService } from '../workers/worker-job-service';
import { WORLD_LANE, WORLD_JOB, resolveGeoRefs, type CentreJob, type TileJob, type SelectiveResult, type RingJob } from '../workers/world-jobs';
import { registerWorldLane } from '../workers/world-lane';

export class TileWorkerPool {
    private readonly _svc: WorkerJobService;
    private _disposed = false;

    constructor(size?: number, svc: WorkerJobService = getWorkerJobService()) {
        this._svc = registerWorldLane(svc);
        if (typeof Worker === 'undefined') return;   // headless → no workers → caller uses the main-thread build
        const n = Math.max(1, Math.min(size ?? this._svc.hardwareCap, 8));
        this._svc.ensureWorkers(WORLD_LANE, n);   // eager, like the old pool (StreamManager sizes its dispatch to `size`)
    }

    /** True when at least one worker is live — callers must check this and take the sync path otherwise. */
    get available(): boolean { return !this._disposed && this._svc.liveWorkers(WORLD_LANE) > 0; }

    /** Live worker count — the streaming source caps concurrent dispatches to this. */
    get size(): number { return this._disposed ? 0 : this._svc.liveWorkers(WORLD_LANE); }

    /** Generate one FULL tile's flat layer-groups in a worker. Rejects if the assigned worker errors. The job carries a
     *  SNAPSHOT of its own params (bug-hunt 2026-10-01 D-W2): they used to be broadcast as sticky lane state (identity
     *  compare), so a queued lite/full tile ran with whichever params were broadcast LAST, and an in-place params edit
     *  (the selective path mutates graph.params) never re-broadcast. LayoutParams is small next to a tile build.
     *  `full` = false: the CHEAP tile (flat map / massing, P10.D5). `terminateOnCancel` (P10.D6): a cancel of this job
     *  while it runs kills + respawns its worker (a stale full build would otherwise hold the worker for 2-4 s). */
    build(params: LayoutParams, tx: number, tz: number, priority: JobPriority = 'visible', opts?: TileBuildOptions, key?: string, full = true, terminateOnCancel = false, parts = false, split = false): Promise<TileLayerGroup[]> {
        if (!this.available) return Promise.reject(new Error('tile pool empty'));
        // P22 splitTile: a FULL tile builds as two worker jobs (TileBuildOptions.half 0 / 1: the groups that read World
        // Streets' lot stamps, and the rest), merged back in the whole build's group order (the same groups, same bytes)
        if (split && full && opts?.half === undefined && this._svc.liveWorkers(WORLD_LANE) > 1) {
            const half = (h: 0 | 1): Promise<TileLayerGroup[]> => this.build(params, tx, tz, priority, { ...(opts ?? {}), half: h }, key !== undefined ? key + '#' + h : undefined, true, terminateOnCancel, parts);
            return Promise.all([half(0), half(1)]).then(([a, b]) => mergeTileHalves(a, b));
        }
        // `key` (P10.B5): the stream key — lets cancelTile() drop a tile that left the window while queued / running.
        // `parts` (P19): the result comes back one group per message (deserialised in pieces); its shared geometry is
        // re-linked here (resolveGeoRefs).
        const pr = this._svc.run<TileJob, TileLayerGroup[]>(WORLD_JOB.tile, { tx, tz, params: { ...params }, ...(opts ? { opts } : {}), ...(full ? {} : { full: false }), ...(parts ? { parts: true } : {}) },
            { priority, mode: 'worker', label: full ? 'City tile' : 'City tile (flat)', ...(key !== undefined ? { key: 'world.tile:' + key } : {}), ...(terminateOnCancel ? { terminateOnCancel: true } : {}) }).promise;
        return parts ? pr.then(resolveGeoRefs) : pr;
    }

    /** P10.B5: cancel a streamed tile's queued / running build (its promise rejects with JobCancelledError). */
    cancelTile(key: string): void { this._svc.cancelByKey('world.tile:' + key); this._svc.cancelByKey('world.tile:' + key + '#0'); this._svc.cancelByKey('world.tile:' + key + '#1'); }

    /** Generate the CENTRE city's full regen in a worker (audit §1.2): every layer-group PRE-DRAPED + the
     *  builder-MUTATED WorldGraph (the caller adopts it — traffic/text-signs/picking read the mutated fields).
     *  Supersedes (cancels) any older centre build still queued / running. */
    buildCentre(params: Partial<LayoutParams>, opts: CentreBuildOptions, priority: JobPriority = 'interactive'): Promise<CentreBuildResult> {
        if (!this.available) return Promise.reject(new Error('tile pool empty'));
        const job: CentreJob = { params, parkedTrain: opts.parkedTrain, activeRegions: opts.activeRegions, chunk: opts.chunk ?? null, contact: opts.contact ?? null, traffic: !!opts.traffic };
        return this._svc.run<CentreJob, CentreBuildResult>(WORLD_JOB.centre, job, { priority, key: 'world.centre', mode: 'worker', label: 'Building city' }).promise
            .then(r => { if (!r || !r.graph) throw new Error('centre build: no graph'); return r; });
    }

    /** SELECTIVE regen (P3.2): rebuild `req.names` on a clone of the existing graph, pre-draped + chunked. `key`
     *  supersedes an older selective regen of the same groups. `mode: 'auto'` (default) = the service's time-sliced
     *  main-thread FALLBACK when no worker is live (same handler → same output); 'worker' = reject instead. */
    buildGroups(req: SelectiveBuildRequest, key: string, mode: 'auto' | 'worker' = 'auto', quiet = false): Promise<SelectiveResult> {
        if (mode === 'worker' && !this.available) return Promise.reject(new Error('tile pool empty'));
        // quiet (step 3, the backdrop following the window): background priority, so no host progress pill shows it
        return this._svc.run<SelectiveBuildRequest, SelectiveResult>(WORLD_JOB.groups, req, { priority: quiet ? 'background' : 'interactive', key: 'world.groups:' + key, mode, label: quiet ? 'World backdrop' : 'Updating city' }).promise;
    }

    /** P19: build the skyline impostor ring band in a worker (supersedes an older ring build still queued / running). */
    buildRing(job: RingJob): Promise<TileLayerGroup[]> {
        if (!this.available) return Promise.reject(new Error('tile pool empty'));
        return this._svc.run<RingJob, TileLayerGroup[]>(WORLD_JOB.ring, job, { priority: 'background', key: 'world.ring', mode: 'worker', label: 'World skyline' }).promise;
    }

    /** Cancel queued / running selective regens (a full regen supersedes them) — or only the one with `key`. */
    cancelSelective(key?: string): void {
        if (key === undefined) this._svc.cancelByKeyPrefix('world.groups:');
        else this._svc.cancelByKey('world.groups:' + key);
    }

    /** Cancel the queued / running CENTRE build (D-W3: clear / exit / document load). */
    cancelCentre(): void { this._svc.cancelByKey('world.centre'); }

    dispose(): void {
        this._disposed = true;
        this._svc.disposeLane(WORLD_LANE);
    }
}
