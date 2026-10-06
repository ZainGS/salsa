/**
 * shell-bake.ts — the pure maths behind the Shell's static bakes + the mode cross-fade (no GPU, unit-tested).
 *
 *  - Panel bake: the bottom panel card (riso circles + placeholder patterns) is a STATIC function of the grid, the
 *    theme colours, the occupied-cell mask and the canvas size. ShellRenderer bakes it once into a texture and blits
 *    it 1:1; `panelBakeKey` is the cache key (the REAL inputs, not "the model changed": hover rebuilds the model on
 *    every pointer move) and `panelBakeRect` the device-px rect that can hold a non-transparent pixel.
 *  - Backdrop sticker: `backdropStickerRect` bounds the blob + squiggles so the full-screen draw is scissored to it.
 *  - Mode cross-fade: `modeFadeT` / `scrimAlphaForFade` are the dip-to-background curve (unchanged).
 */
import type { GridParams, RenderTile, ShellRenderModel } from './shell-layout';

/** An integer device-px rect. */
export interface BakeRect { x: number; y: number; w: number; h: number; }

/** Bitmask of grid cells (tile index = row * cols + col) that hold a 3D tile (icon cutout / CD / coin): the panel
 *  shader drops the placeholder pattern there and caps the riso density. Only the first 32 cells are tracked. */
export function panelOccupiedMask(tiles: readonly Pick<RenderTile, 'discIcon' | 'cd' | 'billboardKey'>[]): number {
  let occupied = 0;
  for (let i = 0; i < tiles.length && i < 32; i++) {
    const t = tiles[i];
    if (t.discIcon || t.cd || t.billboardKey) occupied |= (1 << i);
  }
  return occupied >>> 0;
}

/** Everything the panel shader reads, as one string: two models with the same key bake to the same pixels. */
export function panelBakeKey(
  m: Pick<ShellRenderModel, 'grid' | 'panelColor' | 'insetColor' | 'ink' | 'accentA' | 'accentB' | 'panelBorder' | 'rainbow' | 'dark' | 'tiles'>,
  canvasW: number, canvasH: number,
): string {
  const g = m.grid;
  return [
    canvasW, canvasH,
    g.left, g.top, g.colPitch, g.rowPitch, g.tileSize, g.corner, g.columns, g.rows, g.cardCorner,
    g.cardX, g.cardY, g.cardW, g.cardH, g.regionTop, g.regionHeight,
    m.panelColor.join(','), m.insetColor.join(','), m.ink.join(','), m.accentA.join(','), m.accentB.join(','), m.panelBorder.join(','),
    m.rainbow ? 1 : 0, m.dark ? 1 : 0, panelOccupiedMask(m.tiles),
  ].join('|');
}

/**
 * The device-px rect the panel can touch: the card expanded by its 1.5 px anti-aliased edge (+0.5 px slack),
 * intersected with the pixels the panel quad covers (pixel CENTRES inside x ∈ [0, W), y ∈ [regionTop,
 * regionTop + regionHeight), the rasteriser's top-left rule). Null when nothing is covered.
 */
export function panelBakeRect(g: Pick<GridParams, 'cardX' | 'cardY' | 'cardW' | 'cardH' | 'regionTop' | 'regionHeight'>, canvasW: number, canvasH: number): BakeRect | null {
  if (!(g.cardW > 0) || !(g.cardH > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const PAD = 2;   // cardMask = 1 - smoothstep(-1.5, 1.5, d) is 0 from d = 1.5 px outward
  // rows / columns whose centre (i + 0.5) lies in [lo, hi)
  const lo = (v: number) => Math.ceil(v - 0.5);
  const x0 = Math.max(0, lo(0), Math.floor(g.cardX - PAD));
  const x1 = Math.min(canvasW, lo(canvasW), Math.ceil(g.cardX + g.cardW + PAD));
  const y0 = Math.max(0, lo(g.regionTop), Math.floor(g.cardY - PAD));
  const y1 = Math.min(canvasH, lo(g.regionTop + g.regionHeight), Math.ceil(g.cardY + g.cardH + PAD));
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Sticker-space bounds (q = (px - centre) / S) of every pixel the backdrop shader can cover: the four blob circles
 *  grown by the smooth-union bulge (k/4 per union: 0.0875 + 0.0875 + 0.075) and the 0.03 edge, which also contain
 *  the three squiggle ribbons. See shell-bake.test.ts (CPU mirror of BACKDROP_SHADER). */
export const BACKDROP_Q_BOUNDS = { x0: -1.40, x1: 1.44, y0: -1.10, y1: 1.23 } as const;

/** The device-px scissor rect of the riso sticker backdrop (blob + squiggles) for a W×H canvas, or null when it is
 *  off-canvas. Matches BACKDROP_SHADER: vh = 0.40 H, centre (W/2, 0.55 vh), S = max(0.40 vh, 1). */
export function backdropStickerRect(canvasW: number, canvasH: number): BakeRect | null {
  if (!(canvasW > 0) || !(canvasH > 0)) return null;
  const vh = canvasH * 0.40;
  const cx = canvasW * 0.5, cy = vh * 0.55;
  const S = Math.max(vh * 0.40, 1);
  const b = BACKDROP_Q_BOUNDS;
  const x0 = Math.max(0, Math.floor(cx + b.x0 * S)), x1 = Math.min(canvasW, Math.ceil(cx + b.x1 * S));
  const y0 = Math.max(0, Math.floor(cy + b.y0 * S)), y1 = Math.min(canvasH, Math.ceil(cy + b.y1 * S));
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ── Mode cross-fade (home ↔ illustrations grid) ───────────────────────────

/** Dip-to-background duration (ms). */
export const MODE_FADE_MS = 380;

/** Fade progress 0→1 at `nowMs` for a fade started at `startMs` (linear, clamped at 1). */
export function modeFadeT(nowMs: number, startMs: number, durationMs: number = MODE_FADE_MS): number {
  return Math.min(1, (nowMs - startMs) / durationMs);
}

/** Scrim opacity for a fade progress: 0 at both ends, 1 at the midpoint (where the home ↔ grid swap happens). */
export function scrimAlphaForFade(fade: number): number {
  return 1 - Math.abs(2 * fade - 1);
}
