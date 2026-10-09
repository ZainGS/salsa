/**
 * shell-cart-art.ts — What an installed FrogCart's Shell disc prints: read from the .frogcart at install (and once, at
 * idle, for carts installed before disc art existed — ShellUIManager's backfill), stored on its ShellSlot.
 *
 *   readCartArt(bytes)            the disc art (manifest.cdArt → its entry; else an explicit manifest.thumbnail data
 *                                 URL) + the pattern seed (manifest.cdPattern; else a hash of the cart's sceneId).
 *                                 Only the manifest + the art entry are inflated (never scene.salsa). Never throws.
 *   cartArtToThumbDataUrl(blob)   the art as a 256 px square data URL (WebP, else PNG) for slot.thumbnailDataUrl —
 *                                 the Shell thumbnail atlas cell the disc samples (browser only).
 *   slotDiscPattern(slot)         the pattern a slot's disc prints (its stored seed, else a hash of its id).
 *
 * A cart with no chosen image prints its seeded pattern: the nested scene thumbnail (an artboard snapshot) is NOT used
 * as disc art (the user's 2026-10-09 call: the pattern is the default).
 */

import { unzipSync, strFromU8 } from 'fflate';
import { frogcartCdArtBlob, type FrogcartManifest } from '../persistence/frogcart';
import { cartDiscSeedFromId, normalizeCartDiscPatternRef, type CartDiscPatternRef } from '../../renderer/3d/cd-disc/cart-disc-pattern';
import { CD_DISC_ART_MAX_BYTES, cdDiscArtCropRect } from '../../renderer/3d/cd-disc/cd-disc-art';
import type { ShellSlot } from '../persistence/shell-storage';

/** The atlas cell edge the disc art is stored at (THUMB_CELL_PX). */
export const CART_ART_THUMB_PX = 256;

export interface CartArtRead {
  /** The disc art, or null (the disc prints its pattern). */
  art: Blob | null;
  /** The pattern seed (always set: the manifest's, else derived from the sceneId, else null when unreadable). */
  pattern: CartDiscPatternRef | null;
  /** The manifest's sceneId, when present. */
  sceneId?: string;
}

/** Decode a `data:<mime>;base64,` URL to a Blob (null for anything else / over the size cap). */
function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m || m[2].length * 0.75 > CD_DISC_ART_MAX_BYTES) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes as unknown as BlobPart], { type: m[1].toLowerCase() });
  } catch { return null; }
}

/** Read a cart's disc art + pattern seed from its bytes. Never throws (a broken cart → { art: null, pattern: null }). */
export function readCartArt(bytes: Uint8Array): CartArtRead {
  let manifest: Partial<FrogcartManifest> | null = null;
  let entries: Record<string, Uint8Array> = {};
  try {
    const mf = unzipSync(bytes, { filter: f => f.name === 'manifest.json' })['manifest.json'];
    if (mf) {
      const parsed: unknown = JSON.parse(strFromU8(mf));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Partial<FrogcartManifest>;
    }
    const file = manifest?.cdArt && typeof manifest.cdArt === 'object' ? manifest.cdArt.file : undefined;
    if (typeof file === 'string' && file) {
      // Inflate the art entry only (skip anything over the cap by its directory size).
      entries = unzipSync(bytes, { filter: f => f.name === file && f.originalSize <= CD_DISC_ART_MAX_BYTES });
    }
  } catch { return { art: null, pattern: null }; }
  if (!manifest) return { art: null, pattern: null };
  const sceneId = typeof manifest.sceneId === 'string' && manifest.sceneId ? manifest.sceneId : undefined;
  let art = frogcartCdArtBlob(manifest, entries);
  if (!art && typeof manifest.thumbnail === 'string') art = dataUrlToBlob(manifest.thumbnail);
  const pattern = normalizeCartDiscPatternRef(manifest.cdPattern) ?? (sceneId ? { seed: cartDiscSeedFromId(sceneId) } : null);
  return { art, pattern, sceneId };
}

/** The pattern a slot's disc prints: its stored seed, else a stable hash of its id. */
export function slotDiscPattern(slot: Pick<ShellSlot, 'id'> & { cdPattern?: unknown }): CartDiscPatternRef {
  return normalizeCartDiscPatternRef(slot.cdPattern) ?? { seed: cartDiscSeedFromId(slot.id) };
}

/** The art as a CART_ART_THUMB_PX square data URL (centre cover-crop; WebP, else PNG) — browser only. Null when it
 *  cannot be decoded. */
export async function cartArtToThumbDataUrl(art: Blob, size = CART_ART_THUMB_PX): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(art);
    try {
      const c = cdDiscArtCropRect(bmp.width, bmp.height);
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, size, size);
      const blob = 'convertToBlob' in canvas
        ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality: 0.9 })
        : await new Promise<Blob | null>(res => (canvas as HTMLCanvasElement).toBlob(res, 'image/webp', 0.9));
      if (!blob) return null;
      return await new Promise<string | null>((res) => {
        const r = new FileReader();
        r.onload = () => res(typeof r.result === 'string' ? r.result : null);
        r.onerror = () => res(null);
        r.readAsDataURL(blob);
      });
    } finally { bmp.close?.(); }
  } catch { return null; }
}
