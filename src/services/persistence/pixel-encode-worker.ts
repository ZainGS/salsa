// Runs in a Web Worker — the WorkerJobService's 'pixel' lane (spawned via PixelEncodePool). Encodes one raster
// layer's raw RGBA pixels to PNG/WebP/AVIF via OffscreenCanvas.convertToBlob OFF the main thread — the per-layer
// PNG encode was the dominant main-thread cost of every autosave (audit 2026-07-19 §2.1). OffscreenCanvas +
// ImageData are both worker-exposed, so this is the same codec as pixel-codec.ts, just relocated. The encoded
// bytes are TRANSFERRED back (zero-copy); the input buffer is a structured-clone copy (see pool notes).

import { serveJobs } from '../workers/worker-job-runtime';
import { PIXEL_JOB, type PixelEncodeJob } from './pixel-encode-pool-kinds';

serveJobs({
    [PIXEL_JOB.encode]: async ({ rgba, width, height, mime }: PixelEncodeJob, api) => {
        const canvas = new OffscreenCanvas(width, height);
        const c2d = canvas.getContext('2d')!;
        c2d.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: mime });
        const encoded = await blob.arrayBuffer();
        api.transfer(encoded);
        return encoded;
        // A failed encode (e.g. an unsupported mime in this browser's worker context) throws → the job rejects → the
        // pool's caller falls back to the main-thread encoder, so the save still completes.
    },
});
