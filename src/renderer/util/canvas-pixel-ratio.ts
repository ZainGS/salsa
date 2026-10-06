/**
 * canvas-pixel-ratio.ts — backing-store px per CSS px of a canvas AS ACTUALLY BACKED (mobile-parity TIER-1 / UI-16).
 *
 * The main canvas backing store is DPR-capped on mobile (`computeCanvasBacking`: DPR ≤ 1.5 and ≤ ~2.5 MP), so on a
 * DPR-2 tablet `canvas.width / CSS width` is 1.5, not `window.devicePixelRatio`. Every CSS-px ↔ canvas-px conversion
 * (pointer deltas → pan offset, pointer position → backing px for a pick, an HTML overlay over a device-px rect) must
 * use THIS ratio; `window.devicePixelRatio` is only a fallback before the canvas is laid out. On desktop (uncapped)
 * the two are equal, so desktop results are unchanged.
 *
 * ONE helper for the editor and the Shell (`shellBackingRatio` delegates here).
 */

/** The canvas fields the ratio reads (a real canvas, or a test fake). */
export interface PixelRatioCanvas {
  width: number;
  clientWidth?: number;
  getBoundingClientRect?(): { width: number };
}

/** `window.devicePixelRatio` (≥ 1 is NOT enforced: the caller's fallback rule decides), or 1 off-DOM. */
export function windowDevicePixelRatio(): number {
  const d = typeof window !== 'undefined' ? window.devicePixelRatio : undefined;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1;
}

/**
 * Backing px per CSS px of `c`: `canvas.width / CSS width`. The CSS width is `cssWidth` when given (pass the
 * pointer-event rect's `width` so client-coordinate deltas map exactly), else `clientWidth`, else the bounding rect.
 * Falls back to `fallbackDpr` (default: window.devicePixelRatio) while the canvas is not laid out / has no backing.
 */
export function canvasPixelRatio(c: PixelRatioCanvas | null | undefined, fallbackDpr?: number, cssWidth?: number): number {
  if (c) {
    let cssW = cssWidth != null && cssWidth > 0 ? cssWidth : (c.clientWidth ?? 0);
    if (!(cssW > 0)) {
      try { cssW = c.getBoundingClientRect?.().width ?? 0; } catch { cssW = 0; }
    }
    if (cssW > 0 && c.width > 0) {
      const k = c.width / cssW;
      if (Number.isFinite(k) && k > 0) return k;
    }
  }
  const f = fallbackDpr ?? windowDevicePixelRatio();
  return f > 0 && Number.isFinite(f) ? f : 1;
}
