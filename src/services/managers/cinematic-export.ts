/**
 * Pure planning/validation helpers for cinematic video export (docs/specs/cinematic-cameras.md §7).
 *
 * The actual capture (seek each frame → render → read back pixels) is browser-gated and lives on Scene3DManager;
 * everything decidable without a GPU — which frames to render, how long the clip is, which container/codec to ask
 * MediaRecorder for — lives here so it's unit-testable and stays correct regardless of the render backend.
 */

export type CinematicExportFormat = 'png-sequence' | 'webm';

export interface CinematicExportOptions {
  /** Output frames per second (metadata for the encoder / clip duration). */
  fps: number;
  /** First timeline frame to render (inclusive; timeline frames are 1-indexed). */
  start: number;
  /** Last timeline frame to render (inclusive). */
  end: number;
  /** Output pixel width. */
  width: number;
  /** Output pixel height. */
  height: number;
  /** Timeline frames advanced per output frame (default 1). >1 fast-forwards; must be a positive integer. */
  frameStep?: number;
  /** How the host wants the result (default 'png-sequence'). */
  format?: CinematicExportFormat;
}

/**
 * The ordered list of timeline frames to render for these options. Inclusive of both ends; steps by frameStep.
 * Empty when the range is inverted (end < start).
 */
export function planCinematicFrames(start: number, end: number, frameStep = 1): number[] {
  const step = Math.max(1, Math.floor(frameStep));
  const out: number[] = [];
  for (let f = start; f <= end; f += step) out.push(f);
  return out;
}

/** Clip length in seconds for a given rendered-frame count at fps. */
export function estimateExportDuration(frameCount: number, fps: number): number {
  if (fps <= 0) return 0;
  return frameCount / fps;
}

/**
 * Pick the best WebM MIME/codec MediaRecorder supports on this browser, preferring VP9 → VP8 → generic. `isSupported`
 * is normally `MediaRecorder.isTypeSupported`. Returns null if none are available (host should fall back to the PNG
 * sequence). MP4 out of MediaRecorder is not portable, so we never request it here — the host muxes PNGs → MP4.
 */
export function pickWebMMime(isSupported: (mime: string) => boolean): { mimeType: string; ext: string } | null {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of candidates) {
    if (isSupported(m)) return { mimeType: m, ext: 'webm' };
  }
  return null;
}

/**
 * Largest centered sub-rectangle of a `srcW×srcH` frame that matches the output aspect `outW:outH`. Capturing this
 * rect (then scaling to outW×outH) yields a correctly-proportioned frame with NO distortion — the parts of the
 * canvas outside the output aspect are cropped away, rather than the whole frame being squashed to fit. Integer,
 * clamped ≥ 1, centered (off-by-one slack goes to the trailing edge). Returns {x,y,w,h} in source pixels.
 */
export function computeAspectCropRect(srcW: number, srcH: number, outW: number, outH: number): { x: number; y: number; w: number; h: number } {
  const sw = Math.max(1, Math.floor(srcW)), sh = Math.max(1, Math.floor(srcH));
  const srcAspect = sw / sh, outAspect = outW / outH;
  if (srcAspect > outAspect) {                     // source too wide → crop the sides
    const w = Math.max(1, Math.round(sh * outAspect));
    return { x: Math.floor((sw - w) / 2), y: 0, w: Math.min(w, sw), h: sh };
  }
  // source too tall (or equal) → crop top/bottom
  const h = Math.max(1, Math.round(sw / outAspect));
  return { x: 0, y: Math.floor((sh - h) / 2), w: sw, h: Math.min(h, sh) };
}

/** Validate export options up front; returns a human-readable error string, or null when they're usable. */
export function validateExportOptions(o: CinematicExportOptions): string | null {
  if (!Number.isFinite(o.start) || !Number.isFinite(o.end)) return 'start/end must be finite frame numbers';
  if (o.end < o.start) return 'end frame must be >= start frame';
  if (o.start < 1) return 'start frame must be >= 1 (timeline frames are 1-indexed)';
  if (!(o.fps > 0)) return 'fps must be > 0';
  if (!(o.width > 0) || !(o.height > 0)) return 'width and height must be > 0';
  if (o.frameStep !== undefined && (!(o.frameStep >= 1) || !Number.isInteger(o.frameStep))) return 'frameStep must be a positive integer';
  return null;
}
