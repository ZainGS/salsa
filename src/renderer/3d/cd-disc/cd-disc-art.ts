/**
 * src/renderer/3d/cd-disc/cd-disc-art.ts
 *
 * Fitting an image onto a CD print surface, shared by the CD Kit (setCDPieceArt3D: every printed piece) and the
 * .frogcart disc art (the export dialog): COVER the surface (no stretching — the kit used to stretch uploads), then
 * zoom and pan inside the slack. Zoom < 1 (down to CD_DISC_ART_MIN_ZOOM) shrinks the image inside the surface: the
 * crop rect grows past the image and the uncovered part stays transparent (the foil shows around it on a cart disc). The same crop drives the export and the live 3D preview (as a texture UV rect),
 * so what the preview shows is what gets written.
 *
 *   fit       { zoom MIN..MAX, panX, panY } — pan -1..1 = from one edge of the slack to the other (0 = centred)
 *   crop      cdDiscArtCropRect(srcW, srcH, fit, aspect) → the source rect in px; cdDiscArtUVRect → the same, 0..1
 *   guides    cdDiscArtGuides(sizePx) → the outer cut, the hole and the clear hub ring (art inside it is not printed)
 *   render    renderCDDiscArt(source, fit, opts) → a Blob of the cropped art (browser: canvas)
 *
 * Pure apart from renderCDDiscArt / loadCDDiscArtSource (unit-tested).
 */

import { CD_DISC_ART_INNER_RATIO, SHELL_CD_HOLE_RATIO } from './cd-disc-geometry';

export interface CDDiscArtFit {
  /** 1 = the image just covers the surface; larger = zoomed in; below 1 = the image smaller than the surface. */
  zoom: number;
  /** -1..1: where the crop sits inside the slack (0 = centred; -1 = the left / top edge of the image). */
  panX: number;
  panY: number;
}

export const CD_DISC_ART_FIT_DEFAULT: Readonly<CDDiscArtFit> = Object.freeze({ zoom: 1, panX: 0, panY: 0 });
export const CD_DISC_ART_MAX_ZOOM = 8;
/** Smallest zoom: the image at half the cover size (transparent around it). */
export const CD_DISC_ART_MIN_ZOOM = 0.5;
/** The .frogcart disc art edge (px). */
export const CD_DISC_ART_SIZE = 512;
/** Largest disc art a .frogcart may carry (bytes). */
export const CD_DISC_ART_MAX_BYTES = 2 * 1024 * 1024;

export interface CDDiscArtCrop { sx: number; sy: number; sw: number; sh: number }

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** A valid fit (zoom MIN..MAX, pan -1..1; NaN / missing → the defaults). */
export function clampCDDiscArtFit(fit?: Partial<CDDiscArtFit> | null): CDDiscArtFit {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    zoom: clamp(n(fit?.zoom, 1), CD_DISC_ART_MIN_ZOOM, CD_DISC_ART_MAX_ZOOM),
    panX: clamp(n(fit?.panX, 0), -1, 1),
    panY: clamp(n(fit?.panY, 0), -1, 1),
  };
}

/**
 * The source rect (px) shown on a surface of `aspect` (width / height; 1 = the disc): the largest rect of that
 * aspect inside the image (cover), shrunk by the zoom, placed by the pan inside the leftover slack.
 */
export function cdDiscArtCropRect(srcW: number, srcH: number, fit?: Partial<CDDiscArtFit> | null, aspect = 1): CDDiscArtCrop {
  const f = clampCDDiscArtFit(fit);
  const w = Math.max(1, srcW), h = Math.max(1, srcH), a = aspect > 0 ? aspect : 1;
  let bw: number, bh: number;
  if (w / h > a) { bh = h; bw = h * a; } else { bw = w; bh = w / a; }
  const sw = bw / f.zoom, sh = bh / f.zoom;
  const cx = w / 2 + f.panX * (w - sw) / 2, cy = h / 2 + f.panY * (h - sh) / 2;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** The crop as a 0..1 texture rect (u0, v0 top-left .. u1, v1) — the live preview samples the source with it. */
export function cdDiscArtUVRect(srcW: number, srcH: number, fit?: Partial<CDDiscArtFit> | null, aspect = 1): { u0: number; v0: number; u1: number; v1: number } {
  const c = cdDiscArtCropRect(srcW, srcH, fit, aspect);
  const w = Math.max(1, srcW), h = Math.max(1, srcH);
  return { u0: c.sx / w, v0: c.sy / h, u1: (c.sx + c.sw) / w, v1: (c.sy + c.sh) / h };
}

/**
 * Drag to pan: the pointer moved (dx, dy) as a fraction of the preview's width / height (right / down = +). The image
 * follows the pointer, so the crop moves the other way. An axis with no slack (the image exactly covers it) stays 0.
 */
export function cdDiscArtPanBy(fit: Partial<CDDiscArtFit> | null | undefined, srcW: number, srcH: number, dx: number, dy: number, aspect = 1): CDDiscArtFit {
  const f = clampCDDiscArtFit(fit);
  const c = cdDiscArtCropRect(srcW, srcH, f, aspect);
  const slackX = Math.max(1, srcW) - c.sw, slackY = Math.max(1, srcH) - c.sh;
  // (zoomed out the slack is negative: the same maths moves the smaller image with the pointer)
  const panX = Math.abs(slackX) > 1e-6 ? f.panX - (dx * c.sw) / (slackX / 2) : 0;
  const panY = Math.abs(slackY) > 1e-6 ? f.panY - (dy * c.sh) / (slackY / 2) : 0;
  return clampCDDiscArtFit({ zoom: f.zoom, panX, panY });
}

/** Set the zoom, keeping the crop centre where it is (as far as the new slack allows). */
export function cdDiscArtZoomTo(fit: Partial<CDDiscArtFit> | null | undefined, srcW: number, srcH: number, zoom: number, aspect = 1): CDDiscArtFit {
  const f = clampCDDiscArtFit(fit);
  const c = cdDiscArtCropRect(srcW, srcH, f, aspect);
  const centre = { x: c.sx + c.sw / 2, y: c.sy + c.sh / 2 };
  const z = clampCDDiscArtFit({ zoom }).zoom;
  const n = cdDiscArtCropRect(srcW, srcH, { zoom: z }, aspect);
  const slackX = Math.max(1, srcW) - n.sw, slackY = Math.max(1, srcH) - n.sh;
  const panX = Math.abs(slackX) > 1e-6 ? (centre.x - Math.max(1, srcW) / 2) / (slackX / 2) : 0;
  const panY = Math.abs(slackY) > 1e-6 ? (centre.y - Math.max(1, srcH) / 2) / (slackY / 2) : 0;
  return clampCDDiscArtFit({ zoom: z, panX, panY });
}

/**
 * drawImage rects for a crop that may reach past the image (zoom < 1): the source rect clipped to the image and the
 * matching part of the W × H destination. Null when nothing of the image is inside the crop.
 */
export function cdDiscArtDrawRects(srcW: number, srcH: number, c: CDDiscArtCrop, W: number, H: number):
  { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null {
  const x0 = Math.max(0, c.sx), y0 = Math.max(0, c.sy);
  const x1 = Math.min(srcW, c.sx + c.sw), y1 = Math.min(srcH, c.sy + c.sh);
  if (!(x1 > x0 && y1 > y0 && c.sw > 0 && c.sh > 0)) return null;
  const kx = W / c.sw, ky = H / c.sh;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0, dx: (x0 - c.sx) * kx, dy: (y0 - c.sy) * ky, dw: (x1 - x0) * kx, dh: (y1 - y0) * ky };
}

/** The round preview's guides, in px for a `sizePx` square: the outer cut, the hole, the clear hub ring. */
export function cdDiscArtGuides(sizePx: number, holeRatio: number = SHELL_CD_HOLE_RATIO): { cx: number; cy: number; outerR: number; holeR: number; safeR: number } {
  const c = sizePx / 2;
  return { cx: c, cy: c, outerR: c, holeR: c * holeRatio, safeR: c * CD_DISC_ART_INNER_RATIO };
}

/** Anything renderCDDiscArt can draw. */
export type CDDiscArtSource = Blob | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;

/** Decode a source to something drawImage takes, with its pixel size. Blobs are decoded (createImageBitmap). */
export async function loadCDDiscArtSource(source: CDDiscArtSource): Promise<{ image: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bmp = await createImageBitmap(source);
    return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
  }
  const s = source as ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;
  const width = (s as HTMLImageElement).naturalWidth || s.width;
  const height = (s as HTMLImageElement).naturalHeight || s.height;
  return { image: s as CanvasImageSource, width, height, close: () => {} };
}

export interface RenderCDDiscArtOptions {
  /** Output width (px); height = width / aspect. Default CD_DISC_ART_SIZE (512). */
  size?: number;
  /** Instead of `size`: keep the crop's own resolution (its source width), capped at this (the CD Kit's print art). */
  maxSize?: number;
  /** Surface aspect (width / height). Default 1 (the disc). */
  aspect?: number;
  /** Output type: 'image/webp' (default; keeps alpha) or 'image/png'. A browser without WebP encode gives PNG. */
  mime?: 'image/webp' | 'image/png';
  quality?: number;
}

/** Crop + scale `source` by `fit` onto a size × size / aspect canvas and encode it. Transparent pixels stay
 *  transparent (on a Shell cart disc they show the rainbow foil). Browser only. */
export async function renderCDDiscArt(source: CDDiscArtSource, fit?: Partial<CDDiscArtFit> | null, opts: RenderCDDiscArtOptions = {}): Promise<Blob> {
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const src = await loadCDDiscArtSource(source);
  try {
    const c = cdDiscArtCropRect(src.width, src.height, fit, aspect);
    const W = Math.max(1, Math.round(opts.maxSize ? Math.min(opts.maxSize, c.sw) : (opts.size ?? CD_DISC_ART_SIZE)));
    const H = Math.max(1, Math.round(W / aspect));
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('renderCDDiscArt: no 2D context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const d = cdDiscArtDrawRects(src.width, src.height, c, W, H);   // (zoomed out: the image is smaller than the canvas)
    if (d) ctx.drawImage(src.image, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
    const type = opts.mime ?? 'image/webp';
    if ('convertToBlob' in canvas) return await (canvas as OffscreenCanvas).convertToBlob({ type, quality: opts.quality ?? 0.92 });
    return await new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob(b => (b ? res(b) : rej(new Error('renderCDDiscArt: encode failed'))), type, opts.quality ?? 0.92));
  } finally {
    src.close();
  }
}
