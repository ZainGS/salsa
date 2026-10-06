/**
 * shell-backing.ts — the Shell canvas backing store (mobile-parity UI-16).
 *
 * The Shell sizes its canvas with the SAME rule as the editor (`WebGPURenderer.setCanvasSize` →
 * `computeCanvasBacking` under the device caps): mobile DPR ≤ 1.5 and ≤ ~2.5 MP, desktop uncapped. Two owners of one
 * canvas computing different sizes made their ResizeObservers fight; one rule means they always agree.
 *
 * Everything in the Shell is laid out in canvas DEVICE px, so CSS ↔ device conversions must use the ACTUAL backing
 * ratio (`canvas.width / CSS width`), not `window.devicePixelRatio` — the two differ once the cap applies.
 */
import { computeCanvasBacking, type GpuCaps } from '../core/gpu-capabilities';
import { canvasPixelRatio } from '../util/canvas-pixel-ratio';

/** The canvas fields the backing helpers read / write (a real canvas, or a test fake). */
export interface ShellBackingCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  getBoundingClientRect?(): { width: number; height: number };
}

/** The CSS box the backing store is sized for: the fractional layout rect (what the editor reads), else clientW/H. */
function cssBox(c: ShellBackingCanvas): { w: number; h: number } {
  const r = c.getBoundingClientRect?.();
  return { w: (r && r.width) || c.clientWidth, h: (r && r.height) || c.clientHeight };
}

/**
 * Size the canvas backing store to its CSS box × DPR under `caps` (the editor's rule). Skipped while the canvas is
 * not laid out (CSS width 0). Assigns width / height only when they change (an assignment clears the canvas).
 * Returns true when it resized.
 */
export function syncShellCanvasBacking(c: ShellBackingCanvas, dpr: number, caps: Pick<GpuCaps, 'maxDpr' | 'maxCanvasPixels'>): boolean {
  const { w: cssW, h: cssH } = cssBox(c);
  if (!(cssW > 0)) return false;
  const b = computeCanvasBacking(cssW, cssH, dpr, caps);
  const w = Math.max(1, b.width), h = Math.max(1, b.height);
  if (c.width === w && c.height === h) return false;
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return true;
}

/** Device px per CSS px of the canvas as actually backed (`canvas.width / CSS width`); `fallbackDpr` before layout.
 *  The ONE shared rule with the editor: delegates to `canvasPixelRatio` (renderer/util/canvas-pixel-ratio.ts). */
export function shellBackingRatio(c: ShellBackingCanvas, fallbackDpr = 1): number {
  return canvasPixelRatio(c, fallbackDpr);
}
