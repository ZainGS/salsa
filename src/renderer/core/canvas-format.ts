/**
 * The WebGPU canvas (swap-chain) format, and the CPU side of reading it back (mobile-parity CRASH-6).
 *
 * The canvas used to be configured with a hard-coded 'bgra8unorm'. Android prefers 'rgba8unorm', so a BGRA canvas
 * cost the compositor an extra conversion / copy every frame. The renderer now configures
 * navigator.gpu.getPreferredCanvasFormat() and threads that ONE format through every pipeline and texture that targets
 * the canvas or lastFrameTex (the 2D PipelineManager, Renderer3D and its passes, the Shell, the UI kit). Desktop Chrome
 * on Windows prefers 'bgra8unorm', so desktop behaviour is unchanged.
 *
 * Read-backs of those textures go through readbackToRgba, which swaps B and R only when the format is BGRA.
 *
 * Override (per machine, for an A/B on the device): localStorage 'salsa.gpu.canvasFormat' = 'bgra8unorm' |
 * 'rgba8unorm' ('auto' or unset = the browser's preference). Read once, when the renderer first configures the canvas.
 */

/** The two formats getPreferredCanvasFormat() can return (WebGPU spec). */
export type CanvasColorFormat = 'bgra8unorm' | 'rgba8unorm';

export const CANVAS_FORMAT_OVERRIDE_KEY = 'salsa.gpu.canvasFormat';
/** The format used when nothing better is known (no navigator.gpu, a mock, an unexpected answer). */
export const FALLBACK_CANVAS_FORMAT: CanvasColorFormat = 'bgra8unorm';

const isCanvasColorFormat = (f: unknown): f is CanvasColorFormat => f === 'bgra8unorm' || f === 'rgba8unorm';

/** The localStorage override, or null (unset / 'auto' / unreadable / not a canvas format). */
export function readCanvasFormatOverride(): CanvasColorFormat | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(CANVAS_FORMAT_OVERRIDE_KEY) : null;
    return isCanvasColorFormat(v) ? v : null;
  } catch { return null; }
}

/**
 * The canvas format to configure: the override when set, else the browser's preferred format, else 'bgra8unorm'.
 * Only the two canvas formats are accepted (anything else falls back), so every pipeline built for the canvas is
 * one of two known variants.
 */
export function pickCanvasFormat(
  gpu: { getPreferredCanvasFormat?: () => GPUTextureFormat } | null | undefined =
    (typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: GPU }).gpu : undefined),
  override: CanvasColorFormat | null = readCanvasFormatOverride(),
): CanvasColorFormat {
  if (override) return override;
  let pref: unknown = null;
  try { pref = gpu?.getPreferredCanvasFormat?.() ?? null; } catch { pref = null; }
  return isCanvasColorFormat(pref) ? pref : FALLBACK_CANVAS_FORMAT;
}

/** True when the format stores its bytes B, G, R, A (the read-back must swap B and R to get RGBA). */
export function isBgraFormat(format: GPUTextureFormat | string): boolean {
  return String(format).startsWith('bgra');
}

/**
 * Convert a mapped copyTextureToBuffer read-back of a 4-byte colour texture to tightly packed RGBA:
 * strips the 256-byte row padding (`bytesPerRow`), swaps B and R only when `format` is BGRA, and, with
 * `unpremultiply`, turns premultiplied alpha into straight alpha (alpha 0 -> all zero; alpha 255 untouched).
 */
export function readbackToRgba(
  src: Uint8Array, width: number, height: number, bytesPerRow: number, format: GPUTextureFormat | string,
  opts: { unpremultiply?: boolean; out?: Uint8ClampedArray<ArrayBuffer> } = {},
): Uint8ClampedArray<ArrayBuffer> {
  const out = opts.out ?? new Uint8ClampedArray(width * height * 4);
  const bgra = isBgraFormat(format);
  const r = bgra ? 2 : 0, b = bgra ? 0 : 2;
  let d = 0;
  if (!opts.unpremultiply) {
    for (let y = 0; y < height; y++) {
      const row = y * bytesPerRow;
      for (let x = 0; x < width; x++, d += 4) {
        const i = row + x * 4;
        out[d] = src[i + r]; out[d + 1] = src[i + 1]; out[d + 2] = src[i + b]; out[d + 3] = src[i + 3];
      }
    }
    return out;
  }
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x++, d += 4) {
      const i = row + x * 4;
      const a = src[i + 3];
      if (a === 0) { out[d] = 0; out[d + 1] = 0; out[d + 2] = 0; out[d + 3] = 0; continue; }
      const inv = a >= 255 ? 1 : 255 / a;
      out[d] = src[i + r] * inv; out[d + 1] = src[i + 1] * inv; out[d + 2] = src[i + b] * inv; out[d + 3] = a;
    }
  }
  return out;
}
