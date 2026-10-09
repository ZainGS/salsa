/**
 * The FrogCart disc-art helpers in ONE object, for a host's export UI (ShapeManager.cartDisc): the fitting maths, the
 * guides, the art render and the pattern seeds. The same functions main.ts exports, reachable from the ShapeManager
 * instance the host already holds.
 */

import {
  cdDiscArtCropRect, cdDiscArtUVRect, cdDiscArtPanBy, cdDiscArtZoomTo, cdDiscArtGuides, clampCDDiscArtFit, renderCDDiscArt, cdDiscArtDrawRects,
  CD_DISC_ART_FIT_DEFAULT, CD_DISC_ART_MAX_ZOOM, CD_DISC_ART_MIN_ZOOM, CD_DISC_ART_SIZE, CD_DISC_ART_MAX_BYTES,
} from './cd-disc-art';
import { cartDiscPattern, cartDiscSeedFromId, randomCartDiscSeed, CART_DISC_PALETTES, CART_DISC_FAMILIES } from './cart-disc-pattern';
import { CD_DISC_ART_INNER_RATIO, SHELL_CD_HOLE_RATIO } from './cd-disc-geometry';

export const CART_DISC_TOOLS = Object.freeze({
  cropRect: cdDiscArtCropRect,
  uvRect: cdDiscArtUVRect,
  panBy: cdDiscArtPanBy,
  zoomTo: cdDiscArtZoomTo,
  guides: cdDiscArtGuides,
  /** drawImage rects for a crop that may reach past the image (zoomed out). */
  drawRects: cdDiscArtDrawRects,
  clampFit: clampCDDiscArtFit,
  /** The disc art Blob a .frogcart carries (512 px square WebP by default). */
  renderArt: renderCDDiscArt,
  pattern: cartDiscPattern,
  seedFromId: cartDiscSeedFromId,
  randomSeed: randomCartDiscSeed,
  palettes: CART_DISC_PALETTES,
  families: CART_DISC_FAMILIES,
  FIT_DEFAULT: CD_DISC_ART_FIT_DEFAULT,
  MAX_ZOOM: CD_DISC_ART_MAX_ZOOM,
  MIN_ZOOM: CD_DISC_ART_MIN_ZOOM,
  ART_SIZE: CD_DISC_ART_SIZE,
  MAX_BYTES: CD_DISC_ART_MAX_BYTES,
  HOLE_RATIO: SHELL_CD_HOLE_RATIO,
  ART_INNER_RATIO: CD_DISC_ART_INNER_RATIO,
});

export type CartDiscTools = typeof CART_DISC_TOOLS;
