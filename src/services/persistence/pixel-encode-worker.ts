// Runs in a Web Worker (spawned by PixelEncodePool). Encodes one raster layer's raw RGBA pixels to
// PNG/WebP/AVIF via OffscreenCanvas.convertToBlob OFF the main thread — the per-layer PNG encode was
// the dominant main-thread cost of every autosave (audit 2026-07-19 §2.1). OffscreenCanvas + ImageData
// are both worker-exposed, so this is the same codec as pixel-codec.ts, just relocated. The encoded
// bytes are TRANSFERRED back (zero-copy); the input buffer is a structured-clone copy (see pool notes).

/** One encode request. `mime` is pre-resolved by the pool ('raw' never reaches the worker). */
type EncodeRequest = { id: number; rgba: ArrayBuffer; width: number; height: number; mime: string };

// This module runs in a Worker, but the main tsconfig types `self` as the DOM `Window`. Cast to just the
// two members we use — avoids pulling the webworker lib (which would clash with DOM in the shared compile).
const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
    postMessage: (message: unknown, transfer: Transferable[]) => void;
};

ctx.onmessage = async (e): Promise<void> => {
    const { id, rgba, width, height, mime } = e.data;
    try {
        const canvas = new OffscreenCanvas(width, height);
        const c2d = canvas.getContext('2d')!;
        c2d.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await canvas.convertToBlob({ type: mime });
        const encoded = await blob.arrayBuffer();
        ctx.postMessage({ id, encoded }, [encoded]);
    } catch (err) {
        // Encode failed (e.g. unsupported mime in this browser's worker context) — report; the pool's
        // caller falls back to the main-thread encoder, so the save still completes.
        ctx.postMessage({ id, error: String(err) }, []);
    }
};
