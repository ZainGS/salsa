/**
 * src/packaging/packaging-pane.test.ts — headless verification of the dieline PANE mapping
 * (UVCanvasRenderer letterbox math + backing-store sizing) that the packaging unwrap pane rides on.
 * The 2D context is never used by the coordinate helpers, so a minimal fake canvas suffices.
 *
 * Key contracts:
 *  - uvToCanvas/canvasToUV round-trip exactly (the background is drawn at uv(0,0)→uv(1,1), so the
 *    host's guide overlay — driven by the same mapper — always lands on the drawn texture rect),
 *  - a SQUARE texture (texAspect 1, e.g. a 1080×1080 doc dieline) letterboxes to a SQUARE rect,
 *  - syncBackingStore sizes the backing store from CSS layout px × devicePixelRatio so CSS never
 *    stretches the rect non-square (the tall-narrow-rect regression).
 */

import { describe, it, expect } from 'vitest';
import { UVCanvasRenderer, UVEditorSession } from '../services/managers/uv-canvas-renderer';

function fakeCanvas(w: number, h: number, client?: { w: number; h: number }): HTMLCanvasElement {
  return {
    width: w, height: h,
    clientWidth: client?.w ?? 0, clientHeight: client?.h ?? 0,
    getContext: () => ({}),   // coordinate helpers never touch the ctx
  } as unknown as HTMLCanvasElement;
}

describe('dieline pane mapping (UVCanvasRenderer)', () => {
  it('uvToCanvas of the background-draw rect corners round-trips through canvasToUV', () => {
    const r = new UVCanvasRenderer(fakeCanvas(800, 600));
    const s = new UVEditorSession('m');
    for (const [u, v] of [[0, 0], [1, 1], [0, 1], [1, 0], [0.25, 0.7], [0.5, 0.5]] as const) {
      const [cx, cy] = r.uvToCanvas(u, v, s);
      const [u2, v2] = r.canvasToUV(cx, cy, s);
      expect(u2).toBeCloseTo(u, 10);
      expect(v2).toBeCloseTo(v, 10);
    }
  });

  it('round-trips under pan/zoom and a non-square texAspect (letterboxed dieline)', () => {
    const r = new UVCanvasRenderer(fakeCanvas(640, 480));
    const s = new UVEditorSession('m');
    s.panU = 0.3; s.panV = 0.8; s.zoom = 2.5; s.texAspect = 1.85;   // cruciform-ish dieline
    for (const [u, v] of [[0, 0], [1, 1], [0.1, 0.9], [0.66, 0.33]] as const) {
      const [cx, cy] = r.uvToCanvas(u, v, s);
      const [u2, v2] = r.canvasToUV(cx, cy, s);
      expect(u2).toBeCloseTo(u, 10);
      expect(v2).toBeCloseTo(v, 10);
    }
  });

  it('a SQUARE texture (texAspect 1 — the 1080×1080 doc dieline) letterboxes to a SQUARE rect', () => {
    const r = new UVCanvasRenderer(fakeCanvas(500, 900));   // non-square pane
    const s = new UVEditorSession('m');
    s.texAspect = 1;
    const [ox, oy] = r.uvToCanvas(0, 0, s);
    const [ex, ey] = r.uvToCanvas(1, 1, s);
    expect(ex - ox).toBeCloseTo(ey - oy, 10);               // square rect, regardless of pane shape
    expect(ex - ox).toBeCloseTo(500 * 0.85, 10);            // 85% of the shorter pane axis
  });

  it('a wide texture letterboxes wider-than-tall; a tall one taller-than-wide', () => {
    const r = new UVCanvasRenderer(fakeCanvas(600, 600));
    const s = new UVEditorSession('m');
    s.texAspect = 2;
    let [ox, oy] = r.uvToCanvas(0, 0, s);
    let [ex, ey] = r.uvToCanvas(1, 1, s);
    expect((ex - ox) / (ey - oy)).toBeCloseTo(2, 10);
    s.texAspect = 0.5;
    [ox, oy] = r.uvToCanvas(0, 0, s);
    [ex, ey] = r.uvToCanvas(1, 1, s);
    expect((ex - ox) / (ey - oy)).toBeCloseTo(0.5, 10);
  });

  it('syncBackingStore sizes the backing store from CSS layout px (× DPR) and is idempotent', () => {
    const c = fakeCanvas(300, 150, { w: 420, h: 420 });     // the default-backing CSS-stretch trap
    const r = new UVCanvasRenderer(c);
    expect(r.syncBackingStore()).toBe(true);                // resized (node: devicePixelRatio → 1)
    expect(c.width).toBe(420);
    expect(c.height).toBe(420);
    expect(r.syncBackingStore()).toBe(false);               // already in sync → no-op

    // With the store synced, the square-texture rect is square in BOTH backing and CSS px.
    const s = new UVEditorSession('m');
    const [ox, oy] = r.uvToCanvas(0, 0, s);
    const [ex, ey] = r.uvToCanvas(1, 1, s);
    expect(ex - ox).toBeCloseTo(ey - oy, 10);
  });

  it('syncBackingStore leaves an unlaid-out canvas (clientWidth 0) alone', () => {
    const c = fakeCanvas(512, 512);                         // host-managed store, no CSS layout info
    const r = new UVCanvasRenderer(c);
    expect(r.syncBackingStore()).toBe(false);
    expect(c.width).toBe(512);
    expect(c.height).toBe(512);
  });
});

describe('dieline pane LAYOUT-resize sync (autoBackingStore ResizeObserver)', () => {
  /** Minimal ResizeObserver shim — records observe/disconnect and lets the test fire a layout pass. */
  class FakeRO {
    static instances: FakeRO[] = [];
    observed: unknown[] = [];
    disconnected = false;
    constructor(private readonly cb: () => void) { FakeRO.instances.push(this); }
    observe(el: unknown): void { this.observed.push(el); }
    disconnect(): void { this.disconnected = true; }
    fire(): void { this.cb(); }
  }

  function withRO<T>(fn: () => T): T {
    const prev = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = FakeRO;
    FakeRO.instances = [];
    try { return fn(); }
    finally { (globalThis as any).ResizeObserver = prev; }
  }

  it('enabling autoBackingStore installs ONE observer on the canvas; disabling (detach/dispose) disconnects it', () => {
    withRO(() => {
      const c = fakeCanvas(300, 150, { w: 400, h: 400 });
      const r = new UVCanvasRenderer(c);
      expect(FakeRO.instances.length).toBe(0);              // off by default — character pane untouched
      r.autoBackingStore = true;
      r.autoBackingStore = true;                            // idempotent — no second observer
      expect(FakeRO.instances.length).toBe(1);
      expect(FakeRO.instances[0].observed[0]).toBe(c);
      r.dispose();
      expect(FakeRO.instances[0].disconnected).toBe(true);
      expect(r.autoBackingStore).toBe(false);
    });
  });

  it('a layout resize re-syncs the backing store and fires onLayoutResize; a no-op layout pass stays silent', () => {
    withRO(() => {
      const c = fakeCanvas(300, 150, { w: 420, h: 420 });
      const r = new UVCanvasRenderer(c);
      r.autoBackingStore = true;
      let fired = 0;
      r.onLayoutResize = () => fired++;

      FakeRO.instances[0].fire();                           // mount: 300×150 backing vs 420×420 layout
      expect(c.width).toBe(420);
      expect(c.height).toBe(420);
      expect(fired).toBe(1);                                // mapping moved → host overlay must redraw

      FakeRO.instances[0].fire();                           // layout pass with NO size change
      expect(fired).toBe(1);                                // silent — no redundant redraw churn

      (c as any).clientWidth = 250; (c as any).clientHeight = 600;   // view-mode switch reflows the pane
      FakeRO.instances[0].fire();
      expect(c.width).toBe(250);
      expect(c.height).toBe(600);
      expect(fired).toBe(2);
    });
  });

  it('without a ResizeObserver global (older env), autoBackingStore still works via draw-time sync', () => {
    const c = fakeCanvas(300, 150, { w: 500, h: 500 });
    const r = new UVCanvasRenderer(c);
    r.autoBackingStore = true;                              // must not throw with no ResizeObserver
    expect(r.syncBackingStore()).toBe(true);                // the draw-time path still syncs
    expect(c.width).toBe(500);
    r.dispose();
  });
});
