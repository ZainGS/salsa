import { describe, it, expect } from 'vitest';
import { computeArtboardFit, ARTBOARD_FIT_FILL } from './artboard-fit';

/** Screen rect (CSS px) of the artboard for a fit result, using the InteractionService mapping. */
function artboardRect(fit: { zoom: number; panX: number; panY: number }, cw: number, ch: number, dpr: number, docW: number, docH: number) {
  const h = fit.zoom * ch, w = h * (docW / docH);
  const cx = cw / 2 + fit.panX / 2 / dpr, cy = ch / 2 + fit.panY / 2 / dpr;
  return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2, w, h };
}

describe('computeArtboardFit (Fit respects the host panels)', () => {
  it('without insets: the old 0.85 fit, centred, when the artboard is the limiting height', () => {
    const f = computeArtboardFit({ cssWidth: 1400, cssHeight: 900, pxWidth: 1400, pxHeight: 900, docWidth: 1080, docHeight: 1440 });
    expect(f.zoom).toBeCloseTo(ARTBOARD_FIT_FILL);
    expect(f.panX).toBe(0);
    expect(f.panY).toBe(0);
  });

  it('a wide artboard on a narrow canvas is limited by the width (it used to overflow sideways)', () => {
    const f = computeArtboardFit({ cssWidth: 820, cssHeight: 1180, pxWidth: 820, pxHeight: 1180, docWidth: 1920, docHeight: 1080 });
    const r = artboardRect(f, 820, 1180, 1, 1920, 1080);
    expect(r.w).toBeCloseTo(820 * ARTBOARD_FIT_FILL);
    expect(r.left).toBeGreaterThan(0);
    expect(r.right).toBeLessThan(820);
  });

  it('with insets the artboard sits inside the visible area, centred in it (tablet portrait, sub-panel open)', () => {
    const insets = { left: 320, right: 0, top: 40, bottom: 204 };
    for (const dpr of [1, 2]) {
      const f = computeArtboardFit({ cssWidth: 820, cssHeight: 1180, pxWidth: 820 * dpr, pxHeight: 1180 * dpr, docWidth: 1080, docHeight: 1440, insets });
      const r = artboardRect(f, 820, 1180, dpr, 1080, 1440);
      expect(r.left).toBeGreaterThanOrEqual(320);
      expect(r.right).toBeLessThanOrEqual(820);
      expect(r.top).toBeGreaterThanOrEqual(40);
      expect(r.bottom).toBeLessThanOrEqual(1180 - 204);
      expect((r.left + r.right) / 2).toBeCloseTo(320 + 250);
      expect((r.top + r.bottom) / 2).toBeCloseTo(40 + (1180 - 244) / 2);
      expect(r.w).toBeCloseTo(500 * ARTBOARD_FIT_FILL);   // width-limited: 500 px visible
    }
  });

  it('insets that leave (almost) nothing visible are ignored on that axis', () => {
    const f = computeArtboardFit({ cssWidth: 400, cssHeight: 800, pxWidth: 400, pxHeight: 800, docWidth: 100, docHeight: 100, insets: { left: 300, right: 90 } });
    expect(f.panX).toBe(0);
  });

  it('degenerate sizes fall back to the old fit', () => {
    expect(computeArtboardFit({ cssWidth: 0, cssHeight: 0, pxWidth: 0, pxHeight: 0, docWidth: 10, docHeight: 10 }))
      .toEqual({ zoom: ARTBOARD_FIT_FILL, panX: 0, panY: 0 });
  });
});
