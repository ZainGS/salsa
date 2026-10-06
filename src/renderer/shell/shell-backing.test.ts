/**
 * shell-backing.test.ts — the Shell canvas backing store follows the editor's DPR / pixel cap (mobile-parity UI-16),
 * and CSS ↔ device conversions use the ACTUAL backing ratio.
 */
import { describe, it, expect } from 'vitest';
import { syncShellCanvasBacking, shellBackingRatio, type ShellBackingCanvas } from './shell-backing';
import { computeCanvasBacking, DESKTOP_CAPS, MOBILE_CAPS, SAFE_CAPS } from '../core/gpu-capabilities';

function fakeCanvas(cssW: number, cssH: number, rect?: { width: number; height: number }): ShellBackingCanvas & { writes: number } {
  let w = 0, h = 0;
  const c = {
    writes: 0,
    clientWidth: Math.round(cssW), clientHeight: Math.round(cssH),
    get width() { return w; }, set width(v: number) { w = v; c.writes++; },
    get height() { return h; }, set height(v: number) { h = v; c.writes++; },
    getBoundingClientRect: () => rect ?? { width: cssW, height: cssH },
  };
  return c;
}

describe('syncShellCanvasBacking (UI-16)', () => {
  it('desktop caps: the full DPR, exactly as before (CSS × DPR)', () => {
    for (const [w, h, d] of [[1280, 800, 1], [1280, 800, 2], [1920, 1080, 3], [390, 844, 3]] as const) {
      const c = fakeCanvas(w, h);
      expect(syncShellCanvasBacking(c, d, DESKTOP_CAPS)).toBe(true);
      expect([c.width, c.height]).toEqual([w * d, h * d]);
      expect(shellBackingRatio(c)).toBe(d);
    }
  });

  it('mobile caps: DPR ≤ 1.5 and ≤ 2.5 MP (a tablet at DPR 2 → 1.5)', () => {
    const c = fakeCanvas(1280, 800);
    syncShellCanvasBacking(c, 2, MOBILE_CAPS);
    expect([c.width, c.height]).toEqual([1920, 1200]);
    expect(shellBackingRatio(c, 2)).toBe(1.5);          // NOT window.devicePixelRatio
    const big = fakeCanvas(1600, 1000);
    syncShellCanvasBacking(big, 2, MOBILE_CAPS);
    expect(big.width * big.height).toBeLessThanOrEqual(MOBILE_CAPS.maxCanvasPixels);
    expect(shellBackingRatio(big, 2)).toBeLessThan(1.5);
  });

  it('agrees with the editor rule (computeCanvasBacking on the layout rect) — no ping-pong', () => {
    const rect = { width: 1023.4, height: 711.6 };
    for (const caps of [DESKTOP_CAPS, MOBILE_CAPS, SAFE_CAPS]) {
      for (const d of [1, 1.25, 2, 2.75]) {
        const c = fakeCanvas(rect.width, rect.height, rect);
        syncShellCanvasBacking(c, d, caps);
        const e = computeCanvasBacking(rect.width, rect.height, d, caps);
        expect([c.width, c.height]).toEqual([e.width, e.height]);
      }
    }
  });

  it('no write when nothing changed (an assignment clears the canvas); skipped before layout', () => {
    const c = fakeCanvas(800, 600);
    syncShellCanvasBacking(c, 2, MOBILE_CAPS);
    const n = c.writes;
    expect(syncShellCanvasBacking(c, 2, MOBILE_CAPS)).toBe(false);
    expect(c.writes).toBe(n);
    const hidden = fakeCanvas(0, 0, { width: 0, height: 0 });
    expect(syncShellCanvasBacking(hidden, 2, DESKTOP_CAPS)).toBe(false);
    expect(hidden.writes).toBe(0);
    expect(shellBackingRatio(hidden, 2)).toBe(2);       // fallback before layout
  });
});
