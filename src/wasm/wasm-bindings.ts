/**
 * WASM Bindings — TypeScript glue for calling Rust/WASM error diffusion functions.
 *
 * Usage:
 *   1. Call `initWasm()` once at app startup (async, loads the .wasm binary).
 *   2. Call `applyErrorDiffusion(algorithm, pixels, width, height, levels)` to dither a buffer.
 *
 * The Uint8Array pixels buffer is mutated in-place — no copies, no allocations.
 */

import init, {
  floyd_steinberg,
  atkinson,
  jarvis_judice_ninke,
  stucki,
  sierra,
  sierra_lite,
} from '../../wasm/pkg/wasm';

/** Error diffusion algorithm names (must match the Rust exports). */
export type ErrorDiffusionAlgorithm =
  | 'floyd_steinberg'
  | 'atkinson'
  | 'jarvis_judice_ninke'
  | 'stucki'
  | 'sierra'
  | 'sierra_lite';

let _wasmReady = false;
let _wasmInitPromise: Promise<void> | null = null;

/**
 * Initialize the WASM module. Call once at app startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Returns immediately if already initialized.
 */
export async function initWasm(): Promise<void> {
  if (_wasmReady) return;
  if (_wasmInitPromise) return _wasmInitPromise;

  _wasmInitPromise = init().then(() => {
    _wasmReady = true;
    console.log('[WASM] Error diffusion module initialized');
  });
  return _wasmInitPromise;
}

/** Check if the WASM module has been initialized. */
export function isWasmReady(): boolean {
  return _wasmReady;
}

/**
 * Apply an error diffusion dithering algorithm to a pixel buffer in-place.
 *
 * @param algorithm — which diffusion kernel to use
 * @param pixels   — flat RGBA Uint8Array (length = width × height × 4)
 * @param width    — image width in pixels
 * @param height   — image height in pixels
 * @param levels   — output color levels per channel (2 = 1-bit, 4 = 2-bit, etc.)
 *
 * @throws if WASM has not been initialized (call `initWasm()` first)
 */
export function applyErrorDiffusion(
  algorithm: ErrorDiffusionAlgorithm,
  pixels: Uint8Array,
  width: number,
  height: number,
  levels: number,
): void {
  if (!_wasmReady) {
    throw new Error('[WASM] Not initialized — call initWasm() before using error diffusion');
  }

  switch (algorithm) {
    case 'floyd_steinberg':
      floyd_steinberg(pixels, width, height, levels);
      break;
    case 'atkinson':
      atkinson(pixels, width, height, levels);
      break;
    case 'jarvis_judice_ninke':
      jarvis_judice_ninke(pixels, width, height, levels);
      break;
    case 'stucki':
      stucki(pixels, width, height, levels);
      break;
    case 'sierra':
      sierra(pixels, width, height, levels);
      break;
    case 'sierra_lite':
      sierra_lite(pixels, width, height, levels);
      break;
  }
}
