// The 'atlas' lane's job kinds (performance-plan P3.2e): GARP / adverts / vending-label SHEET COMPOSITION off the
// main thread. One kind, `atlas.compose`: decode the sources (data URLs → fetch + createImageBitmap, or transferred
// ImageBitmaps), paint a pure {@link SheetPlan} (atlas-sheet-ops.ts) on an OffscreenCanvas, and return the sheet as
// a GPU-ready ImageBitmap (transferred, zero-copy) and/or an encoded data URL (the persisted / registry form).
//
// The SAME handler is the main-thread fallback (WorkerJobService 'auto'); it needs OffscreenCanvas + createImageBitmap,
// so without them it THROWS and the caller keeps its legacy <canvas> path (same ops → same layout).
// No DOM: only worker-exposed globals (OffscreenCanvas, createImageBitmap, fetch, FileReader[Sync]).

import type { JobHandler } from './worker-job-runtime';
import { paintSheetOps, type SheetPlan } from './atlas-sheet-ops';

export const ATLAS_LANE = 'atlas';
export const ATLAS_JOB = { compose: 'atlas.compose' } as const;

/** One compose request. `sources[i]` is a data URL / blob URL string or an ImageBitmap (transfer it). */
export interface AtlasComposeJob {
    plan: SheetPlan;
    sources: (string | ImageBitmap)[];
    /** Encode the sheet to a data URL (e.g. `{ mime: 'image/png' }`); omit for bitmap-only. */
    encode?: { mime: string; quality?: number } | null;
    /** Return the sheet as an ImageBitmap (for the GPU upload). */
    bitmap?: boolean;
}
export interface AtlasComposeResult {
    dataUrl: string | null;
    bitmap: ImageBitmap | null;
    /** Decoded size of each source ([0,0] when it failed to decode). */
    srcSizes: [number, number][];
}

async function decode(src: string | ImageBitmap): Promise<ImageBitmap | null> {
    if (typeof src !== 'string') return src;
    if (!src) return null;
    try { return await createImageBitmap(await (await fetch(src)).blob()); } catch { return null; }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    const FRS = (globalThis as { FileReaderSync?: new () => { readAsDataURL(b: Blob): string } }).FileReaderSync;
    if (FRS) return new FRS().readAsDataURL(blob);   // worker: sync, native base64
    return new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

export const composeSheetHandler: JobHandler<AtlasComposeJob, AtlasComposeResult> = async ({ plan, sources, encode, bitmap }, api) => {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('atlas.compose: no OffscreenCanvas');
    const images = await Promise.all(sources.map(decode));
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('atlas.compose: no 2d context');
    paintSheetOps(ctx, plan.ops, images);
    const srcSizes = images.map((im): [number, number] => (im ? [im.width, im.height] : [0, 0]));
    for (const im of images) im?.close?.();
    let dataUrl: string | null = null;
    if (encode) dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type: encode.mime, ...(encode.quality != null ? { quality: encode.quality } : {}) }));
    let bmp: ImageBitmap | null = null;
    if (bitmap) { bmp = canvas.transferToImageBitmap(); api.transfer(bmp); }
    return { dataUrl, bitmap: bmp, srcSizes };
};

export const ATLAS_JOB_HANDLERS: Record<string, JobHandler<any, any>> = { [ATLAS_JOB.compose]: composeSheetHandler };
