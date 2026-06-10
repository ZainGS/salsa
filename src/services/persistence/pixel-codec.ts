/**
 * pixel-codec.ts — Encode/decode raster layer pixel data for OPFS storage.
 *
 * Raw RGBA in memory, compressed at rest. Lossless formats only for working files.
 * All encode/decode is async and uses native browser APIs (OffscreenCanvas + createImageBitmap).
 */

export type PixelFormat = 'raw' | 'png' | 'webp' | 'avif';

const MIME: Record<PixelFormat, string | null> = {
    'raw':  null,
    'png':  'image/png',
    'webp': 'image/webp',
    'avif': 'image/avif',
};

const EXT: Record<PixelFormat, string> = {
    'raw':  'bin',
    'png':  'png',
    'webp': 'webp',
    'avif': 'avif',
};

/** Returns the file extension for a layer file stored in this format. */
export function pixelFormatExtension(format: PixelFormat): string {
    return EXT[format];
}

/**
 * Encode raw RGBA bytes to the target format.
 * Returns the original ArrayBuffer unchanged for 'raw'.
 */
export async function encodePixels(
    rgba: ArrayBuffer,
    width: number,
    height: number,
    format: PixelFormat,
): Promise<ArrayBuffer> {
    if (format === 'raw') return rgba;
    const mime = MIME[format]!;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: mime });
    return blob.arrayBuffer();
}

/**
 * Decode any supported image format back to raw RGBA bytes.
 * For 'raw', returns the buffer unchanged (width/height will be 0 — caller
 * must supply dimensions from the manifest for raw data).
 */
export async function decodePixels(
    data: ArrayBuffer,
    format: PixelFormat,
): Promise<{ rgba: ArrayBuffer; width: number; height: number }> {
    if (format === 'raw') {
        return { rgba: data, width: 0, height: 0 };
    }
    const blob = new Blob([data], { type: MIME[format]! });
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;   // read before close()
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, width, height);
    return { rgba: imageData.data.buffer as ArrayBuffer, width, height };
}

/**
 * Check whether a format can be encoded by this browser.
 * PNG and raw are always supported. WebP and AVIF depend on the browser.
 * Used to filter the Advanced Settings options shown to the user.
 */
export async function isFormatSupported(format: PixelFormat): Promise<boolean> {
    if (format === 'raw' || format === 'png') return true;
    try {
        const canvas = new OffscreenCanvas(1, 1);
        const blob = await canvas.convertToBlob({ type: MIME[format]! });
        return blob.size > 0;
    } catch {
        return false;
    }
}
