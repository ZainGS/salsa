/**
 * BRUSH-4 follow-ups in RasterDrawingService (docs/specs/mobile-parity.md §3, docs/ui/touch-controls.md §5):
 *  - stroke prediction: getPredictedEvents → a provisional tail drawn in the frame's pre-render drain and taken back
 *    by the renderer's post-composite hook; touch / pen only, setting-gated, filtered (≤ 25 ms ahead, plausible
 *    distance), nothing without the API; end to end on the CPU mirror the committed layer and the undo patch are
 *    identical with prediction on vs off;
 *  - the finger smoothing cap reaches the engine via beginStroke's pointerType.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { RasterDrawingService, PREDICT_MAX_MS } from './raster-drawing-service';
import { setStrokePrediction, setTouchSmoothing, reloadBrushInputSettings } from '../renderer/raster/brushes/brush-input-settings';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../renderer/raster/cpu-gpu-mirror';

beforeAll(() => installGpuGlobals());
// Prediction is OFF by default (opt-in until verified on a real GPU): these tests exercise the feature, so turn it on.
beforeEach(() => { reloadBrushInputSettings(); setStrokePrediction(true); });
afterEach(() => { reloadBrushInputSettings(); vi.restoreAllMocks(); });

type Handler = (e: any) => unknown;
const CSS_W = 180, CSS_H = 120, EW = 360, EH = 240;   // 2 texels per CSS px

function setup(opts: { engine?: any; postHook?: boolean } = {}) {
  const listeners = new Map<string, Handler[]>();
  const canvas = {
    width: CSS_W, height: CSS_H,
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H }),
    setPointerCapture: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {},
  };
  const interactionService = {
    canvas, beginInteractive: () => {}, endInteractive: () => {}, clearSelectedNodes: () => {},
    toWorldCoordsFromCanvas: (x: number, y: number) => ({ x: x / (CSS_W / 2) - 1, y: 1 - y / (CSS_H / 2) }),
  };
  const calls = { begin: [] as any[], beginOpts: [] as any[], points: [] as any[][], drawn: [] as any[][], cleared: 0 };
  const engine = opts.engine ?? {
    setBrushColor: () => {}, setLockTransparency: () => {}, setAspectCorrection: () => {}, setSelectionMask: () => {},
    setEraseMode: () => {},
    beginStroke: (p: any, o: any) => { calls.begin.push(p); calls.beginOpts.push(o); },
    addStrokePoints: (pts: any[]) => { calls.points.push(pts); },
    drawProvisionalStroke: (pts: any[]) => { calls.drawn.push(pts); return true; },
    clearProvisionalStroke: () => { calls.cleared++; return true; },
    endStroke: async () => null,
  };
  const patches: any[] = [];
  const layerTexMgr = { pushStrokePatch: async (_t: unknown, p: any) => { patches.push(p); } };
  const preRender: Array<() => boolean> = [];
  const post: Array<() => void> = [];
  const renderer: any = {
    rasterPaintEngine: engine,
    getRasterTextureSize: () => ({ w: EW, h: EH }),
    getIllustrationMode: () => false, getIllustrationBounds: () => null,
    syncActiveLayerTexture: () => {}, scheduleRender: () => {},
    rasterLayerManager: { getSelectedLayerId: () => 'L1', getSelectedLayerManager: () => layerTexMgr, pushSnapshotForLayer: () => true },
    addPreRenderCallback: (cb: () => boolean) => { if (!preRender.includes(cb)) preRender.push(cb); },
    removePreRenderCallback: (cb: () => boolean) => { const i = preRender.indexOf(cb); if (i >= 0) preRender.splice(i, 1); },
  };
  if (opts.postHook !== false) {
    renderer.addPostRasterCompositeCallback = (cb: () => void) => { if (!post.includes(cb)) post.push(cb); };
    renderer.removePostRasterCompositeCallback = (cb: () => void) => { const i = post.indexOf(cb); if (i >= 0) post.splice(i, 1); };
  }
  const svc = new RasterDrawingService(interactionService as any, renderer, {} as any);
  svc.enable();
  const fire = async (type: string, e: any) => {
    for (const h of listeners.get(type) ?? []) await h({ button: 0, buttons: 1, pressure: 0.5, tiltX: 0, tiltY: 0, pointerId: 1, ...e });
  };
  /** One rendered frame: pre-render callbacks, `composite` (what the screen shows), then the post-composite hooks. */
  const frame = (composite?: () => void) => { for (const cb of [...preRender]) cb(); composite?.(); for (const cb of [...post]) cb(); };
  return { svc, fire, frame, calls, patches, preRender, post };
}

/** A pointermove whose coalesced samples are `xs` (CSS px, 8 ms apart from t0) and predicted samples `pred`. */
function move(t0: number, xs: number[], y: number, pred?: Array<{ x: number; y: number; dt: number }>, pointerType = 'touch') {
  const samples = xs.map((x, i) => ({ clientX: x, clientY: y, pressure: 0.8, tiltX: 0, tiltY: 0, timeStamp: t0 + i * 8, pointerId: 1, pointerType }));
  const last = samples[samples.length - 1];
  const ev: any = { ...last, pointerType, getCoalescedEvents: () => samples };
  if (pred) ev.getPredictedEvents = () => pred.map(p => ({ clientX: p.x, clientY: p.y, pressure: 0.8, tiltX: 0, tiltY: 0, timeStamp: last.timeStamp + p.dt, pointerType }));
  return ev;
}

describe('stroke prediction (service)', () => {
  it('touch: the frame draws the filtered prediction once, and the post-composite hook clears it', async () => {
    const t = setup();
    await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: 'touch' });
    expect(t.post.length).toBe(0);                                      // TOUCH-5: a finger's first dab waits…
    // speed: 30 px in 24 ms (1.25 px/ms) → allowed at dt 8: 2·1.25·8 + 4 = 24 px
    await t.fire('pointermove', move(1008, [20, 30, 40], 50, [{ x: 48, y: 50, dt: 8 }, { x: 56, y: 50, dt: 16 }]));
    expect(t.post.length).toBe(1);                                      // …until it moves 8 px (or a frame passes)
    t.frame();
    expect(t.calls.points.length).toBe(1);
    expect(t.calls.drawn.length).toBe(1);
    expect(t.calls.drawn[0].map((p: any) => p.x)).toEqual([96, 112]);   // CSS → texels (×2)
    expect(t.calls.drawn[0].every((p: any) => p.timestamp > 1024)).toBe(true);
    const clearedAfterFrame = t.calls.cleared;
    expect(clearedAfterFrame).toBeGreaterThanOrEqual(1);                // the post-composite hook ran
    // next frame without a new move: no tail is drawn again (it was used once)
    t.frame();
    expect(t.calls.drawn.length).toBe(1);
    await t.fire('pointerup', { buttons: 0, timeStamp: 1100 });
    expect(t.post.length).toBe(0);
    expect(t.preRender.length).toBe(0);
  });

  it('drops predictions too far ahead in time or implausibly far away (and everything after them)', async () => {
    const t = setup();
    await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: 'pen' });
    await t.fire('pointermove', move(1008, [20, 30, 40], 50, [
      { x: 46, y: 50, dt: 8 }, { x: 52, y: 50, dt: PREDICT_MAX_MS + 1 }, { x: 54, y: 50, dt: 30 },
    ], 'pen'));
    t.frame();
    expect(t.calls.drawn[0].length).toBe(1);
    await t.fire('pointermove', move(1040, [41, 42, 43], 50, [{ x: 43, y: 90, dt: 8 }], 'pen'));   // a 40 px jump at ~0.1 px/ms
    t.frame();
    expect(t.calls.drawn.length).toBe(1);                              // nothing plausible → no tail
    await t.fire('pointermove', move(1072, [44, 45, 46], 50, [{ x: 46, y: 50, dt: 0 }], 'pen'));   // not in the future
    t.frame();
    expect(t.calls.drawn.length).toBe(1);
    await t.fire('pointerup', { buttons: 0, timeStamp: 1100 });
  });

  it('no prediction when getPredictedEvents is missing', async () => {
    const t = setup();
    await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: 'touch' });
    await t.fire('pointermove', move(1008, [20, 30, 40], 50));
    t.frame();
    expect(t.calls.points.length).toBe(1);
    expect(t.calls.drawn.length).toBe(0);
    await t.fire('pointerup', { buttons: 0, timeStamp: 1100 });
  });

  it('never for the mouse, with the setting off, or without the renderer post-composite hook', async () => {
    const runs: Array<[ReturnType<typeof setup>, string]> = [];
    runs.push([setup(), 'mouse']);
    setStrokePrediction(false);
    runs.push([setup(), 'touch']);
    for (const [t, pt] of runs) {
      await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: pt });
      await t.fire('pointermove', move(1008, [20, 30, 40], 50, [{ x: 48, y: 50, dt: 8 }], pt));
      t.frame();
      expect(t.calls.drawn.length).toBe(0);
      expect(t.post.length).toBe(0);
      expect(t.calls.cleared).toBe(0);                                 // mouse: no provisional calls at all mid-stroke
      await t.fire('pointerup', { buttons: 0, timeStamp: 1100 });
    }
    setStrokePrediction(true);
    const t = setup({ postHook: false });
    await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: 'touch' });
    await t.fire('pointermove', move(1008, [20, 30, 40], 50, [{ x: 48, y: 50, dt: 8 }]));
    t.frame();
    expect(t.calls.drawn.length).toBe(0);
  });

  it('passes the pointer type to the engine (the touch smoothing cap is applied there)', async () => {
    for (const pt of ['touch', 'pen', 'mouse']) {
      const t = setup();
      await t.fire('pointerdown', { clientX: 10, clientY: 50, timeStamp: 1000, pointerType: pt });
      t.frame();   // (TOUCH-5: a finger's first dab lands with the next frame)
      expect(t.calls.beginOpts[0]).toEqual({ pointerType: pt });
      await t.fire('pointerup', { buttons: 0, timeStamp: 1100 });
    }
  });
});

// ── End to end on the CPU mirror: the real RasterPaintEngine behind the service ──

function fillCanvas(t: CpuTexture) {
  let s = 12345;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < t.data.length; i += 4) {
    if (r() < 0.5) continue;
    t.data[i] = 200; t.data[i + 1] = 60 + Math.floor(r() * 150); t.data[i + 2] = 40; t.data[i + 3] = Math.floor(90 + r() * 165);
  }
}

async function e2eStroke(presetId: string, predict: boolean, pointerType = 'touch') {
  vi.spyOn(Math, 'random').mockReturnValue(0.42);
  reloadBrushInputSettings();
  setStrokePrediction(predict);
  setTouchSmoothing('light');
  const { RasterPaintEngine } = await import('../renderer/raster/core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(EW, EH, 'rgba8unorm');
  fillCanvas(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  expect(engine.setActivePreset(presetId)).toBe(true);
  engine.setActiveTexture(tex as unknown as GPUTexture);
  await engine.initializeSnapshots();
  const t = setup({ engine });
  t.svc.setBrushColor({ r: 0.1, g: 0.2, b: 0.9, a: 1 });
  const shown: Uint8Array[] = [];
  const settled: Uint8Array[] = [];
  await t.fire('pointerdown', { clientX: 30, clientY: 60, timeStamp: 1000, pointerType, pressure: 0.8 });
  for (let f = 0; f < 6; f++) {
    const x0 = 30 + f * 15;
    const y = 60 + (f % 3) * 4;
    // the predictor overshoots a little (the real path then turns): the tail must leave no trace
    await t.fire('pointermove', move(1008 + f * 24, [x0 + 5, x0 + 10, x0 + 15], y,
      [{ x: x0 + 20, y: y + 3, dt: 8 }, { x: x0 + 25, y: y + 6, dt: 16 }], pointerType));
    t.frame(() => shown.push(tex.data.slice()));
    settled.push(tex.data.slice());
  }
  await t.fire('pointerup', { buttons: 0, timeStamp: 1200, pointerType });
  return { tex, shown, settled, final: tex.data.slice(), patch: t.patches[0] };
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('stroke prediction end to end (CPU mirror)', () => {
  for (const id of ['default_hard_pen', 'default_round_soft', 'default_eraser', 'default_monoweight_liner']) {
    it(`${id}: the layer and the undo patch are identical with prediction on vs off; the tail lasts one frame`, async () => {
      const off = await e2eStroke(id, false);
      const on = await e2eStroke(id, true);
      expect(on.shown.some((s, f) => !same(s, off.shown[f]))).toBe(true);    // the tail was on screen
      for (let f = 0; f < on.settled.length; f++) expect(same(on.settled[f], off.settled[f])).toBe(true);   // gone after the frame
      expect(same(on.final, off.final)).toBe(true);
      expect(on.patch && off.patch).toBeTruthy();
      expect([on.patch.x, on.patch.y, on.patch.rw, on.patch.rh]).toEqual([off.patch.x, off.patch.y, off.patch.rw, off.patch.rh]);
      expect(same(on.patch.before, off.patch.before)).toBe(true);
      expect(same(on.patch.after, off.patch.after)).toBe(true);
    });
  }

  it('a mouse stroke with predicted events present is byte-identical to one with prediction off', async () => {
    const off = await e2eStroke('default_hard_pen', false, 'mouse');
    const on = await e2eStroke('default_hard_pen', true, 'mouse');
    for (let f = 0; f < on.shown.length; f++) expect(same(on.shown[f], off.shown[f])).toBe(true);   // never drawn
    expect(same(on.final, off.final)).toBe(true);
  });
});
