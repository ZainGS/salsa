// A small pool of Web Workers that PNG/WebP/AVIF-encode raster layer pixels off the main thread during
// autosave (audit 2026-07-19 §2.1 — the per-layer encode was a multi-hundred-ms main-thread stall every
// 30s / 5s-after-stroke). Round-robin dispatch, same pattern as streaming/tile-worker-pool. If Workers or
// OffscreenCanvas are unavailable (headless / SSR / construction failure) the pool is empty and
// `available` is false — DocumentPersistence then falls back to the synchronous-contract main-thread
// `encodePixels`, so a save is never lost.
//
// The worker is INLINED (`?worker&inline`) so its code is embedded as a blob in Salsa's dist, needing no
// asset resolution by the consuming bundler (Frogmarks/webpack).

import type { PixelFormat } from './pixel-codec';
import PixelEncodeWorker from './pixel-encode-worker?worker&inline';

const MIME: Record<Exclude<PixelFormat, 'raw'>, string> = {
    png:  'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
};

interface Pending { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void; worker: Worker }

export class PixelEncodePool {
    private readonly _workers: Worker[] = [];
    private _next = 0;
    private _seq = 0;
    private readonly _pending = new Map<number, Pending>();

    constructor(size = 2) {
        // OffscreenCanvas check: the worker needs it to encode; if the main thread lacks it, workers will too.
        if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
        try {
            for (let i = 0; i < Math.max(1, size); i++) {
                const w = new PixelEncodeWorker();
                w.onmessage = (e: MessageEvent) => this._onMessage(e);
                w.onerror = () => this._onWorkerError(w);
                this._workers.push(w);
            }
        } catch {
            this.dispose();   // construction failed → empty pool → caller uses main-thread encodePixels
        }
    }

    /** True when at least one worker is live — callers must check this and take the sync path otherwise. */
    get available(): boolean { return this._workers.length > 0; }

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
        if (!this._workers.length) return Promise.reject(new Error('pixel encode pool empty'));
        const w = this._workers[this._next++ % this._workers.length];
        const id = ++this._seq;
        return new Promise<ArrayBuffer>((resolve, reject) => {
            this._pending.set(id, { resolve, reject, worker: w });
            w.postMessage({ id, rgba, width, height, mime: MIME[format] });
        });
    }

    private _onMessage(e: MessageEvent): void {
        const { id, encoded, error } = e.data as { id: number; encoded?: ArrayBuffer; error?: string };
        const p = this._pending.get(id);
        if (!p) return;
        this._pending.delete(id);
        if (error !== undefined || !encoded) p.reject(new Error(error ?? 'pixel encode worker: empty result'));
        else p.resolve(encoded);
    }

    /** A worker crashed — REMOVE it (round-robin must never pick it again: postMessage to a dead worker
     *  silently drops, stranding its request's promise forever) and reject its in-flight requests. If the
     *  pool empties, `available` flips false and callers fall back to the main-thread encode. */
    private _onWorkerError(w: Worker): void {
        const i = this._workers.indexOf(w);
        if (i >= 0) this._workers.splice(i, 1);
        try { w.terminate(); } catch { /* already dead */ }
        for (const [id, p] of [...this._pending]) {
            if (p.worker !== w) continue;
            this._pending.delete(id);
            p.reject(new Error('pixel encode worker error'));
        }
    }

    dispose(): void {
        for (const w of this._workers) w.terminate();
        this._workers.length = 0;
        for (const [, p] of this._pending) p.reject(new Error('pixel encode pool disposed'));
        this._pending.clear();
    }
}
