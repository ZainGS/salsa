// The 'character' LANE's job kinds (performance-plan P3.2d): procedural character generation off the main thread.
// The SAME handlers run inside the character Worker (character-worker.ts → serveJobs) and as the WorkerJobService's
// main-thread fallback, so the two paths cannot drift. Pure generators only (character-parts.ts → body / clothing /
// hair generators + body-fit) — no DOM / WebGPU / scene-graph → worker-safe.
//
// GPU-READY RESULTS: every mesh comes back as 12-float Float32Array vertices + Uint32Array indices (+ skin
// Uint8Array/Float32Array) — TRANSFERRED (zero-copy). All of it is freshly allocated per call (no module caches in
// these generators), so transferring the generator's own buffers is safe (unlike the world lane's instanced caches).

import { generateBodyResult, type BodyParams } from '../managers/body-generator';
import { generateCharacterParts, type BodyGenResult, type CharacterParts, type CharacterPartsSpec } from '../managers/character-parts';
import type { JobApi, JobHandler } from './worker-job-runtime';

export const CHARACTER_LANE = 'character';
export const CHARACTER_JOB = {
    /** generateBodyResult(params) — the body mesh + skin + skeleton arrays + fit surfaces. */
    body: 'character.body',
    /** Body + garments + hair (generateCharacterParts) — one round trip for a whole new character. */
    parts: 'character.parts',
} as const;

/** Mark every distinct ArrayBuffer reachable from `v` for transfer (typed arrays inside objects / arrays / Maps). */
export function transferAllBuffers(v: unknown, api: JobApi): void {
    if (api.fallback) return;
    const seen = new Set<unknown>();
    const bufs = new Set<ArrayBuffer>();
    const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object' || seen.has(x)) return;
        seen.add(x);
        if (ArrayBuffer.isView(x)) { if (x.buffer instanceof ArrayBuffer) bufs.add(x.buffer); return; }
        if (x instanceof ArrayBuffer) { bufs.add(x); return; }
        if (x instanceof Map) { for (const [k, e] of x) { walk(k); walk(e); } return; }
        if (Array.isArray(x)) { for (const e of x) walk(e); return; }
        for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k]);
    };
    walk(v);
    for (const b of bufs) api.transfer(b);
}

const bodyJob: JobHandler<Partial<BodyParams>, BodyGenResult> = (params, api) => {
    const r = generateBodyResult(params);
    transferAllBuffers(r, api);
    return r;
};

const partsJob: JobHandler<CharacterPartsSpec, CharacterParts> = (spec, api) => {
    const r = generateCharacterParts(spec);
    transferAllBuffers(r, api);
    return r;
};

/** Handlers keyed by kind — the character worker serves these; the service registers them as fallbacks. */
export const CHARACTER_JOB_HANDLERS: Record<string, JobHandler<any, any>> = {
    [CHARACTER_JOB.body]: bodyJob,
    [CHARACTER_JOB.parts]: partsJob,
};
