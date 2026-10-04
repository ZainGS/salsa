// Registers the 'world' lane (the tile Worker script) + its job kinds on the shared WorkerJobService. Idempotent.
//
// The worker is INLINED (`?worker&inline`) so its code — including the bundled `src/world` — is embedded as a blob
// in Salsa's dist, needing no asset resolution by the consuming bundler (Frogmarks/webpack).

import { getWorkerJobService, type WorkerJobService } from './worker-job-service';
import { WORLD_LANE, WORLD_JOB, WORLD_JOB_HANDLERS } from './world-jobs';
import TileWorker from '../streaming/tile-worker?worker&inline';

export function registerWorldLane(svc: WorkerJobService = getWorkerJobService()): WorkerJobService {
    svc.registerLane({ lane: WORLD_LANE, create: () => new TileWorker() });
    for (const kind of Object.keys(WORLD_JOB_HANDLERS)) {
        // bug-hunt 2026-10-01 D-W3: a cancelled CENTRE build (clear / exit / superseded) recycles its worker instead of
        // keeping it busy for seconds on a dead city; tiles + selectives are short and keep their warm caches.
        if (!svc.hasKind(kind)) svc.registerKind({ kind, lane: WORLD_LANE, handler: WORLD_JOB_HANDLERS[kind], terminateOnCancel: kind === WORLD_JOB.centre });
    }
    return svc;
}
