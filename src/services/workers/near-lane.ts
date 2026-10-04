// Registers the 'near' lane (near-field jobs: collision cells + crowd cells) on the shared WorkerJobService, and the
// async helpers their callers await. Idempotent. Inlined like the other lanes (`?worker&inline`), so Salsa's dist
// needs no worker asset resolution. Headless (vitest / no Worker) the same handler runs on the main thread in a later
// macrotask — identical output.

import { getWorkerJobService, type WorkerJobService } from './worker-job-service';
import { NEAR_LANE, NEAR_JOB, NEAR_JOB_HANDLERS } from './near-jobs';
import type { CellSoup, FlatBVH } from '../../game/collision-cells';
import type { CrowdCellJob, CrowdCellResult } from '../../world/crowd-instanced';
import NearWorker from './near-worker?worker&inline';

export function registerNearLane(svc: WorkerJobService = getWorkerJobService()): WorkerJobService {
    // Two workers: a collision cell (20-100 ms) and a crowd cell can build side by side. Every lane is guaranteed one
    // worker by the service, so the world lane's tile builds never starve it.
    svc.registerLane({ lane: NEAR_LANE, create: () => new NearWorker(), maxWorkers: 2 });
    for (const kind of Object.keys(NEAR_JOB_HANDLERS)) {
        if (!svc.hasKind(kind)) svc.registerKind({ kind, lane: NEAR_LANE, handler: NEAR_JOB_HANDLERS[kind], noCloneFallback: true });
    }
    return svc;
}

/** Build one collision cell's flat BVH off the main thread (the soup's buffers are transferred to the worker). */
export function buildCellBvhAsync(soup: CellSoup): Promise<FlatBVH> {
    return registerNearLane().run<CellSoup, FlatBVH>(NEAR_JOB.cellBvh, soup, {
        // background: a host progress pill (Frogmarks) never shows it
        priority: 'background', label: 'Collision cell', transfer: [soup.tris.buffer, soup.ids.buffer],
    }).promise;
}

/** Whether the near lane has (or can spawn) a real worker — callers keep their main-thread path otherwise. */
export function nearWorkerAvailable(): boolean { return registerNearLane().workerAvailable(NEAR_LANE); }

/** Build one instanced-crowd cell off the main thread (the rows' buffer is transferred). Worker only: rejects with
 *  WorkerUnavailableError instead of running a 5-20 ms build in a main-thread fallback task. */
export function buildCrowdCellAsync(job: CrowdCellJob): { promise: Promise<CrowdCellResult>; cancel(): void } {
    const h = registerNearLane().run<CrowdCellJob, CrowdCellResult>(NEAR_JOB.crowdCell, job, {
        priority: 'background', label: 'Crowd cell', transfer: [job.recs.buffer], mode: 'worker',
    });
    return { promise: h.promise, cancel: () => h.cancel() };
}
