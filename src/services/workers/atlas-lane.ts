// Registers the 'atlas' lane (OffscreenCanvas sheet composer, atlas-worker.ts) + its job kind on the shared
// WorkerJobService, and exposes `composeAtlasSheet` (performance-plan P3.2e). Idempotent.
//
// The kind is registered WITH its handler, so with no Worker the same compose runs on the main thread (time-sliced,
// still async-encoded via OffscreenCanvas.convertToBlob). Without OffscreenCanvas the handler throws → the promise
// rejects → callers keep their legacy <canvas> path (same pure ops). The worker is INLINED (`?worker&inline`) so the
// consuming bundler (Frogmarks/webpack) needs no asset resolution.

import { getWorkerJobService, type WorkerJobService, type JobPriority } from './worker-job-service';
import { ATLAS_LANE, ATLAS_JOB, ATLAS_JOB_HANDLERS, type AtlasComposeJob, type AtlasComposeResult } from './atlas-jobs';
import AtlasWorker from './atlas-worker?worker&inline';

export function registerAtlasLane(svc: WorkerJobService = getWorkerJobService()): WorkerJobService {
    svc.registerLane({ lane: ATLAS_LANE, create: () => new AtlasWorker(), maxWorkers: 2, concurrency: 2,
        supported: () => typeof OffscreenCanvas !== 'undefined' });
    for (const kind of Object.keys(ATLAS_JOB_HANDLERS)) {
        if (!svc.hasKind(kind)) svc.registerKind({ kind, lane: ATLAS_LANE, handler: ATLAS_JOB_HANDLERS[kind] });
    }
    return svc;
}

/** True when sheet composition can run at all (worker or main-thread OffscreenCanvas fallback). */
export const atlasComposeSupported = (): boolean => typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';

/** Compose one sheet (off-thread when a worker is available). ImageBitmap sources are TRANSFERRED unless transfer:false (detached here — a
 *  caller that needs a fallback re-decodes from its source URL).
 *  Rejects when unsupported / the job fails — callers fall back to their main-thread canvas path. */
export function composeAtlasSheet(job: AtlasComposeJob, opts: { priority?: JobPriority; key?: string; label?: string; transfer?: boolean } = {}): Promise<AtlasComposeResult> {
    if (!atlasComposeSupported()) return Promise.reject(new Error('atlas compose unsupported'));
    const svc = registerAtlasLane();
    const transfer = opts.transfer === false ? [] : job.sources.filter((s): s is ImageBitmap => typeof s !== 'string');
    return svc.run<AtlasComposeJob, AtlasComposeResult>(ATLAS_JOB.compose, job,
        { priority: opts.priority ?? 'visible', transfer, label: opts.label ?? 'Packing images', ...(opts.key ? { key: opts.key } : {}) }).promise;
}
