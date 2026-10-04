// Job-kind ids + payload type of the 'pixel' lane (shared by PixelEncodePool and pixel-encode-worker). Pure.
export const PIXEL_LANE = 'pixel';
export const PIXEL_JOB = { encode: 'pixel.encode' } as const;
/** One encode request. `mime` is pre-resolved by the pool ('raw' never reaches the worker). */
export interface PixelEncodeJob { rgba: ArrayBuffer; width: number; height: number; mime: string }
