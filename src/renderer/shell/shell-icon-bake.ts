/**
 * shell-icon-bake.ts — the Shell's icon bakes, memoised for the life of the page.
 *
 * A system-app icon / the hero logo is: image → (themed rim baked around every alpha edge) → Billboard3D cutout
 * geometry + a 256² atlas thumbnail. That is tens of milliseconds of Canvas-2D + tracing per icon, and it used to run
 * on EVERY Shell mount (each return from an editor) although nothing about it depends on the mount: the result is a
 * pure function of (image source, outline colour, rim width, geometry config). So it is baked once per key and kept:
 * a later mount applies the cached geometry + bitmap synchronously (icons are there on the first frame, no decode).
 *
 * The bake itself yields to the event loop between its steps, and the host (ShellUIManager) only starts a bake once
 * the Shell has been up for a moment and no mode transition is running.
 *
 * Pixels are unchanged: the atlas thumbnail goes through the same PNG round trip + high-quality 256² resize as
 * before (`canvas.toBlob` instead of a synchronous `toDataURL` + fetch; the image source's own bytes for uncut icons).
 */
import { generateBillboard3DGeometry, type Billboard3DConfig, type Billboard3DGeometry } from '../3d/billboard-3d';
import { drawPlaceholderIcon, type IconKind } from './shell-icons';
import { THUMB_CELL_PX } from './shell-thumbnails';

type Rgba4 = [number, number, number, number];

export interface IconBake {
  /** Cutout mesh (shared, read-only: every mount uploads its own GPU buffers from it). */
  geo: Billboard3DGeometry;
  /** The atlas thumbnail, already decoded + resized to the atlas cell. Null when it could not be made (then `atlasUrl`). */
  bitmap: ImageBitmap | null;
  /** Content key for the atlas (`requestThumbnailBitmap`). */
  bitmapKey: string;
  /** Fallback atlas source (a URL / data URL) when `bitmap` is null. */
  atlasUrl: string;
}

/** Format an [r,g,b,a] (0..1) color as a CSS rgba() string. */
export function rgbaCss(c: readonly [number, number, number, number]): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
}

/** Let the browser run a frame / input before the next chunk of work. */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  return new Promise((r) => setTimeout(r, 0));
}

/** Load an image element from a URL or data URL (for logo injection). */
function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Bake a colored outline into an icon canvas (in place): stamp the icon's
 *  silhouette in the outline color around two rings of offsets — a cheap
 *  circular dilation — then draw the icon back on top. The color survives only
 *  in the `rimPx` band just outside every alpha edge: the outer silhouette AND
 *  the rims of interior holes, whose centers stay transparent. Lets cutout icons
 *  (gear) show see-through holes with a printed, themed rim. Yields between
 *  rings (the same draws in the same order, spread over several tasks). */
async function bakeRim(canvas: HTMLCanvasElement, rimPx: number, color: Rgba4): Promise<void> {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  // Snapshot the icon, and build a flat outline-colored version of its silhouette.
  const icon = document.createElement('canvas'); icon.width = w; icon.height = h;
  icon.getContext('2d')!.drawImage(canvas, 0, 0);
  const tint = document.createElement('canvas'); tint.width = w; tint.height = h;
  const tc = tint.getContext('2d')!;
  tc.drawImage(icon, 0, 0);
  tc.globalCompositeOperation = 'source-in';
  tc.fillStyle = rgbaCss(color);
  tc.fillRect(0, 0, w, h);
  // Dilate by stamping the tinted silhouette across the whole disc (every radius
  // up to rimPx, ~1px angular spacing), then draw the icon on top. A sparse ring
  // set leaves wedge gaps at sharp convex features (the pencil tip) where the
  // discrete directions fan apart; filling the disc closes them.
  ctx.clearRect(0, 0, w, h);
  for (let r = rimPx; r >= 1; r--) {
    const steps = Math.max(8, Math.ceil(2 * Math.PI * r));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ctx.drawImage(tint, Math.cos(a) * r, Math.sin(a) * r);
    }
    await yieldToMain();
  }
  ctx.drawImage(icon, 0, 0);
}

/** A blob → the atlas-cell bitmap (the resize the thumbnail atlas applies to a data URL). Null if unsupported. */
async function cellBitmap(blob: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(blob, { resizeWidth: THUMB_CELL_PX, resizeHeight: THUMB_CELL_PX, resizeQuality: 'high' });
  } catch { return null; }
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try { canvas.toBlob((b) => resolve(b), 'image/png'); } catch { resolve(null); }
  });
}

// ── memo ──
const _pending = new Map<string, Map<string, Promise<IconBake>>>();   // source → variant → bake (in flight or done)
const _done = new Map<string, Map<string, IconBake>>();               // source → variant → finished bake
let _seq = 0;

/** The memo key of an image-icon variant (everything but the source). Exported for the tests. */
export function iconVariantKey(outline: readonly number[], rimPx: number, cfg: Partial<Billboard3DConfig>): string {
  return `${outline.join(',')}|${rimPx}|${JSON.stringify(cfg, Object.keys(cfg).sort())}`;
}

function memo(source: string, variant: string, make: () => Promise<IconBake>): Promise<IconBake> {
  let m = _pending.get(source);
  if (!m) { m = new Map(); _pending.set(source, m); }
  let p = m.get(variant);
  if (!p) {
    p = make().then((bake) => {
      let d = _done.get(source);
      if (!d) { d = new Map(); _done.set(source, d); }
      d.set(variant, bake);
      return bake;
    });
    m.set(variant, p);
    p.catch(() => { m!.delete(variant); });   // a failed bake may be retried
  }
  return p;
}

/** A finished image-icon bake for this key, or null (not baked yet / still baking). Synchronous. */
export function peekImageIcon(src: string, outline: Rgba4, rimPx: number, cfg: Partial<Billboard3DConfig> = {}): IconBake | null {
  return _done.get(src)?.get(iconVariantKey(outline, rimPx, cfg)) ?? null;
}

/**
 * Bake an image icon (URL or data URL; transparent background): Billboard3D cutout + atlas thumbnail. `outline` is
 * the themed cut-edge / rim colour. Cutout mode (rimPx > 0) bakes a themed outline around every alpha edge — the
 * outer silhouette AND interior holes — so the holes can render as true see-through gaps with a printed rim; the bake
 * also pre-dilates the mask, so geometry needs no borderPx and triangulates the smoothed shape. Memoised per key.
 */
export function bakeImageIcon(src: string, outline: Rgba4, rimPx: number, cfg: Partial<Billboard3DConfig> = {}): Promise<IconBake> {
  return memo(src, iconVariantKey(outline, rimPx, cfg), async () => {
    const img = await loadImageEl(src);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('icon image has no size');
    await yieldToMain();
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const cutout = rimPx > 0;
    if (cutout) await bakeRim(canvas, rimPx, outline);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    await yieldToMain();
    const geo = generateBillboard3DGeometry(rgba, w, h, {
      borderPx: cutout ? 0 : 6, depth: 0.05, sideColor: outline, cutoutHoles: cutout, ...cfg,
    });
    await yieldToMain();
    // Atlas thumbnail: the baked canvas as PNG (cutout) or the source image's own bytes — what the atlas decoded
    // from the data URL / URL before — resized to the atlas cell here, once.
    let bitmap: ImageBitmap | null = null;
    let atlasUrl = src;
    try {
      const blob = cutout ? await canvasPngBlob(canvas) : await (await fetch(src)).blob();
      if (blob) bitmap = await cellBitmap(blob);
    } catch { /* fall through to the data-URL path */ }
    if (!bitmap && cutout) atlasUrl = canvas.toDataURL();
    return { geo, bitmap, bitmapKey: `shell-icon-bake:${++_seq}`, atlasUrl };
  });
}

const PLACEHOLDER_SRC = '\u0000placeholder';
export function peekPlaceholderIcon(kind: IconKind): IconBake | null {
  return _done.get(PLACEHOLDER_SRC)?.get(kind) ?? null;
}
/** Bake a procedural placeholder icon (shell-icons.ts): white-edged cutout + atlas thumbnail. Memoised per kind. */
export function bakePlaceholderIcon(kind: IconKind): Promise<IconBake> {
  return memo(PLACEHOLDER_SRC, kind, async () => {
    const icon = drawPlaceholderIcon(kind);
    await yieldToMain();
    const geo = generateBillboard3DGeometry(icon.rgba, icon.w, icon.h, {
      borderPx: 6, depth: 0.05, sideColor: [1, 1, 1, 1],
    });
    await yieldToMain();
    let bitmap: ImageBitmap | null = null;
    try { bitmap = await cellBitmap(await (await fetch(icon.dataUrl)).blob()); } catch { /* data-URL path */ }
    return { geo, bitmap, bitmapKey: `shell-icon-bake:${++_seq}`, atlasUrl: icon.dataUrl };
  });
}
