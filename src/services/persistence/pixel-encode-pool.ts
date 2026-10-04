// The pixel-encode Worker pool — now a thin FAÇADE over the shared WorkerJobService's 'pixel' lane (performance-plan
// P3.1). PNG/WebP/AVIF-encodes raster layer pixels off the main thread during autosave (audit 2026-07-19 §2.1 — the
// per-layer encode was a multi-hundred-ms main-thread stall every 30s / 5s-after-stroke). Same contract as before:
// if Workers or OffscreenCanvas are unavailable (headless / SSR / construction failure) `available` is false and
// DocumentPersistence falls back to the synchronous-contract main-thread `encodePixels`, so a save is never lost.
// Encodes run at 'background' priority — they never delay an interactive / visible job on a shared core.
//
// The worker is INLINED (`?worker&inline`) so its code is embedded as a blob in Salsa's dist, needing no asset
// resolution by the consuming bundler (Frogmarks/webpack).

import type { PixelFormat } from './pixel-codec';
import PixelEncodeWorker from './pixel-encode-worker?worker&inline';
import { getWorkerJobService, type WorkerJobService } from '../workers/worker-job-service';
import { PIXEL_LANE, PIXEL_JOB, type PixelEncodeJob } from './pixel-encode-pool-kinds';

const MIME: Record<Exclude<PixelFormat, 'raw'>, string> = {
    png:  'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
};

export class PixelEncodePool {
    private readonly _svc: WorkerJobService;
    private _disposed = false;

    constructor(size = 2, svc: WorkerJobService = getWorkerJobService()) {
        this._svc = svc;
        // OffscreenCanvas check: the worker needs it to encode; if the main thread lacks it, workers will too.
        svc.registerLane({ lane: PIXEL_LANE, create: () => new PixelEncodeWorker(), maxWorkers: Math.max(1, size), concurrency: 2,
            supported: () => typeof OffscreenCanvas !== 'undefined' });
        if (!svc.hasKind(PIXEL_JOB.encode)) svc.registerKind({ kind: PIXEL_JOB.encode, lane: PIXEL_LANE });   // worker-only
        if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
        svc.ensureWorkers(PIXEL_LANE, Math.max(1, size));
    }

    /** True when at least one worker is live — callers must check this and take the sync path otherwise. */
    get available(): boolean { return !this._disposed && this._svc.liveWorkers(PIXEL_LANE) > 0; }

    /**
     * Encode raw RGBA bytes to `format` in a worker. Rejects if the assigned worker errors — the caller
     * falls back to the main-thread encoder.
     *
     * The input buffer is CLONED to the worker (no transfer list), NOT transferred: a worker crash
     * mid-encode must leave the caller's pixel buffer intact so the fallback encode can still run —
     * transferring would detach it and lose the save. The clone is a plain memcpy (~ms), tiny next to
     * the encode it moves off-thread; the encoded result IS transferred back (zero-copy).
     */
    encode(rgba: ArrayBuffer, width: number, height: number, format: PixelFormat): Promise<ArrayBuffer> {
        if (format === 'raw') return Promise.resolve(rgba);
        if (!this.available) return Promise.reject(new Error('pixel encode pool empty'));
        return this._svc.run<PixelEncodeJob, ArrayBuffer>(PIXEL_JOB.encode, { rgba, width, height, mime: MIME[format] },
            { priority: 'background', mode: 'worker', label: 'Saving' }).promise;
    }

    dispose(): void {
        this._disposed = true;
        this._svc.disposeLane(PIXEL_LANE);
    }
}
