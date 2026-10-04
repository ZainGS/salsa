// Registers the 'character' lane (the character Worker script) + its job kinds on the shared WorkerJobService, and
// the async generation helpers the character call sites await. Idempotent.
//
// The worker is INLINED (`?worker&inline`) like the world lane, so Salsa's dist needs no worker asset resolution.
// Headless (vitest / no Worker) the same handlers run on the main thread in a later macrotask — identical output.

import { getWorkerJobService, type WorkerJobService, type JobPriority } from './worker-job-service';
import { CHARACTER_LANE, CHARACTER_JOB, CHARACTER_JOB_HANDLERS } from './character-jobs';
import type { BodyParams } from '../managers/body-generator';
import type { BodyGenResult, CharacterParts, CharacterPartsSpec } from '../managers/character-parts';
import CharacterWorker from './character-worker?worker&inline';

export function registerCharacterLane(svc: WorkerJobService = getWorkerJobService()): WorkerJobService {
    // One worker is plenty: a character is ~1 job; a burst (crowd spawn) queues by priority.
    svc.registerLane({ lane: CHARACTER_LANE, create: () => new CharacterWorker(), maxWorkers: 2 });
    for (const kind of Object.keys(CHARACTER_JOB_HANDLERS)) {
        if (!svc.hasKind(kind)) svc.registerKind({ kind, lane: CHARACTER_LANE, handler: CHARACTER_JOB_HANDLERS[kind] });
    }
    return svc;
}

/** generateBodyResult(params) off the main thread. */
export function generateBodyAsync(params: Partial<BodyParams>, priority: JobPriority = 'interactive'): Promise<BodyGenResult> {
    return registerCharacterLane().run<Partial<BodyParams>, BodyGenResult>(CHARACTER_JOB.body, params, { priority, label: 'Generating character' }).promise;
}

/** generateCharacterParts(spec) (body + garments + hair) off the main thread. */
export function generateCharacterPartsAsync(spec: CharacterPartsSpec, priority: JobPriority = 'interactive'): Promise<CharacterParts> {
    return registerCharacterLane().run<CharacterPartsSpec, CharacterParts>(CHARACTER_JOB.parts, spec, { priority, label: 'Generating character' }).promise;
}
