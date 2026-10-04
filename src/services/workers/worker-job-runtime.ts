// WORKER-SIDE half of the WorkerJobService (docs/specs/performance-plan.md P3.1). A worker script calls
// `serveJobs({ kind: handler, … })` once; the service then posts typed jobs to it and receives results, errors and
// progress. The SAME handler functions are registered main-side as the time-sliced FALLBACK (no Worker — vitest /
// headless / construction failure), so worker and fallback output can never drift (determinism by construction).
//
// Protocol (structured clone):
//   main → worker   { t: 'job', id, kind, payload }        run one job
//                   { t: 'shared', key, value }            sticky lane state (e.g. the tile builds' LayoutParams) —
//                                                          sent once per change, read by handlers via api.shared
//   worker → main   { t: 'done', id, result }  (+ transfer list from api.transfer)
//                   { t: 'error', id, error }
//                   { t: 'progress', id, p }               0..1, forwarded to the job's onProgress + service events
//
// Pure: no DOM / WebGPU. Imported by worker scripts AND by main-side job-kind modules (the JobApi type).

/** What a job handler can use besides its payload. */
export interface JobApi {
    /** Sticky lane state set by `WorkerJobService.broadcast` (worker: a structured clone; fallback: the original). */
    readonly shared: Record<string, unknown>;
    /** Report progress 0..1 (throttled main-side to one event per animation frame per job). */
    progress(p: number): void;
    /** Mark buffers of the RESULT to transfer (zero-copy) instead of clone. No-op in the main-thread fallback. */
    transfer(...list: Transferable[]): void;
    /** True when running in the main-thread fallback (handlers may skip worker-only copies). */
    readonly fallback: boolean;
    /** P19 (worker only; absent in the fallback): post one PART of the result now, with the buffers marked by
     *  api.transfer since the last part. Each part is its own message, so the main thread deserialises a big result
     *  in pieces (one task each) instead of one 10-15 ms task. A handler that posts parts returns `jobParts(n)`; the
     *  job's promise then resolves with the array of parts. */
    part?(value: unknown): void;
}

/** The result a handler returns after posting `n` parts (api.part): the service resolves the job with the parts. */
export interface JobPartsResult { __jobParts: number }
export function jobParts(n: number): JobPartsResult { return { __jobParts: n }; }
export function isJobParts(v: unknown): v is JobPartsResult {
    return !!v && typeof v === 'object' && typeof (v as { __jobParts?: unknown }).__jobParts === 'number';
}

/** A job handler: same function in the worker and in the main-thread fallback. */
export type JobHandler<I = unknown, O = unknown> = (payload: I, api: JobApi) => O | Promise<O>;

export type JobMessage =
    | { t: 'job'; id: number; kind: string; payload: unknown }
    | { t: 'shared'; key: string; value: unknown };

export type JobReply =
    | { t: 'done'; id: number; result: unknown }
    | { t: 'error'; id: number; error: string }
    | { t: 'progress'; id: number; p: number }
    | { t: 'part'; id: number; part: unknown };

/** Install the job loop in the current worker. Call once at the worker module's top level. */
export function serveJobs(handlers: Record<string, JobHandler<any, any>>): void {
    // This module runs in a Worker, but the main tsconfig types `self` as the DOM `Window`. Cast to just the two
    // members we use — avoids pulling the webworker lib (which would clash with DOM in the shared compile).
    const ctx = self as unknown as {
        onmessage: ((e: MessageEvent<JobMessage>) => void) | null;
        postMessage: (message: unknown, transfer: Transferable[]) => void;
    };
    const shared: Record<string, unknown> = {};
    ctx.onmessage = async (e): Promise<void> => {
        const m = e.data;
        if (m.t === 'shared') { shared[m.key] = m.value; return; }
        if (m.t !== 'job') return;
        const { id, kind, payload } = m;
        const h = handlers[kind];
        if (!h) { ctx.postMessage({ t: 'error', id, error: `worker: unknown job kind '${kind}'` } satisfies JobReply, []); return; }
        const transfer: Transferable[] = [];
        const api: JobApi = {
            shared, fallback: false,
            progress: (p) => ctx.postMessage({ t: 'progress', id, p } satisfies JobReply, []),
            transfer: (...list) => { for (const b of list) if (b && !transfer.includes(b)) transfer.push(b); },
            part: (value) => ctx.postMessage({ t: 'part', id, part: value } satisfies JobReply, transfer.splice(0)),
        };
        try {
            const result = await h(payload, api);
            ctx.postMessage({ t: 'done', id, result } satisfies JobReply, transfer);
        } catch (err) {
            ctx.postMessage({ t: 'error', id, error: String((err as Error)?.stack ?? err) } satisfies JobReply, []);
        }
    };
}
