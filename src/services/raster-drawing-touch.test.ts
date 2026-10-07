/**
 * TOUCH-5 (docs/specs/mobile-parity.md §3, docs/ui/touch-controls.md): a pinch / two-finger pan never leaves paint on
 * a 2D raster layer. Bug (2026-10-06, Android tablet): the first finger's stroke began at once, kept painting while
 * the two-finger pinch zoomed (its moves were still the stroke pointer's), and was COMMITTED (undo entry, autosave) on
 * lift. Now RasterDrawingService follows the 7.3b P1 UV-paint rule:
 *  - a finger stroke's first dab waits 1 frame / 8 CSS px, so a second finger in that window paints nothing at all;
 *  - a second finger after that takes the stroke back byte-exactly (RasterPaintEngine.cancelStroke) with no undo
 *    patch, no snapshot and no onStrokeEnd (the host's autosave / upload-dirty hook);
 *  - `!isPrimary` fingers and fingers of a blocked gesture never start a stroke; pen / mouse are unchanged.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { RasterDrawingService } from './raster-drawing-service';
import { TouchGestureTracker } from '../renderer/util/touch-gesture-tracker';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../renderer/raster/cpu-gpu-mirror';
import { rasterContentSeq, rasterContentStats, rasterTextureWrittenAt } from '../renderer/raster/raster-content-version';
import type { BrushPreset } from '../renderer/raster/brushes/brush-preset';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

type Handler = (e: any) => unknown;
const CSS_W = 160, CSS_H = 100, EW = 320, EH = 200;   // 2 texels per CSS px

function setup(opts: { engine?: any } = {}) {
  const listeners = new Map<string, Handler[]>();
  const captured = new Set<number>();
  const canvas = {
    width: CSS_W, height: CSS_H,
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  };
  let interactive = 0;
  const interactionService = {
    canvas, clearSelectedNodes: () => {},
    beginInteractive: () => { interactive++; }, endInteractive: () => { interactive--; },
    toWorldCoordsFromCanvas: (x: number, y: number) => ({ x: x / (CSS_W / 2) - 1, y: 1 - y / (CSS_H / 2) }),
  };
  const calls = { begin: [] as any[], points: [] as any[][], end: 0, cancel: 0 };
  const engine = opts.engine ?? {
    setBrushColor: () => {}, setLockTransparency: () => {}, setAspectCorrection: () => {}, setSelectionMask: () => {},
    setEraseMode: () => {},
    beginStroke: (p: any) => { calls.begin.push(p); },
    addStrokePoints: (pts: any[]) => { calls.points.push(pts); },
    endStroke: async () => { calls.end++; return null; },
    cancelStroke: () => { calls.cancel++; return true; },
  };
  const layerTexMgr = { pushStrokePatch: vi.fn(async () => {}) };
  const layerMgr = { getSelectedLayerId: () => 'L1', getSelectedLayerManager: () => layerTexMgr, pushSnapshotForLayer: vi.fn(() => true) };
  const preRender: Array<() => boolean> = [];
  const renderer: any = {
    rasterPaintEngine: engine,
    getRasterTextureSize: () => ({ w: EW, h: EH }),
    getIllustrationMode: () => false, getIllustrationBounds: () => null,
    syncActiveLayerTexture: () => {}, scheduleRender: () => {},
    rasterLayerManager: layerMgr,
    addPreRenderCallback: (cb: () => boolean) => { if (!preRender.includes(cb)) preRender.push(cb); },
    removePreRenderCallback: (cb: () => boolean) => { const i = preRender.indexOf(cb); if (i >= 0) preRender.splice(i, 1); },
  };
  const svc = new RasterDrawingService(interactionService as any, renderer, {} as any);
  svc.enable();
  const ended: any[] = [], cancelled: any[] = [];
  svc.onStrokeEnd.subscribe(v => ended.push(v));
  svc.onStrokeCancel.subscribe(v => cancelled.push(v));
  const fire = async (type: string, e: any) => {
    for (const h of listeners.get(type) ?? []) {
      await h({ button: 0, buttons: 1, pressure: 0.6, tiltX: 0, tiltY: 0, pointerId: 1, pointerType: 'touch', isPrimary: true, ...e });
    }
  };
  /** One rendered frame (the renderer's pre-render callbacks). */
  const frame = () => { for (const cb of [...preRender]) cb(); };
  return { svc, fire, frame, calls, ended, cancelled, captured, preRender, layerTexMgr, layerMgr, get interactive() { return interactive; } };
}

const finger = (id: number, x: number, y: number, t: number, extra: any = {}) =>
  ({ pointerId: id, clientX: x, clientY: y, timeStamp: t, isPrimary: id === 1, ...extra });

describe('TouchGestureTracker', () => {
  it('mouse / pen always start; a 2nd finger is a gesture; blocked until every finger lifts', () => {
    const g = new TouchGestureTracker();
    expect(g.down({ pointerType: 'mouse', pointerId: 1 })).toBe('start');
    expect(g.down({ pointerType: 'pen', pointerId: 2 })).toBe('start');
    expect(g.down({ pointerType: 'touch', pointerId: 3, isPrimary: true })).toBe('start');
    expect(g.down({ pointerType: 'touch', pointerId: 4, isPrimary: false })).toBe('gesture');
    expect(g.down({ pointerType: 'touch', pointerId: 5, isPrimary: false })).toBe('gesture');
    g.up({ pointerType: 'touch', pointerId: 4 });
    g.up({ pointerType: 'touch', pointerId: 5 });
    expect(g.blocked).toBe(true);                                         // finger 3 still down
    expect(g.down({ pointerType: 'touch', pointerId: 6, isPrimary: false })).toBe('gesture');
    g.up({ pointerType: 'touch', pointerId: 6 });
    g.up({ pointerType: 'touch', pointerId: 3 });
    expect(g.blocked).toBe(false);
    expect(g.down({ pointerType: 'touch', pointerId: 7, isPrimary: true })).toBe('start');
  });

  it('a !isPrimary finger never starts; a new primary clears ids left by a missed pointerup', () => {
    const g = new TouchGestureTracker();
    expect(g.down({ pointerType: 'touch', pointerId: 1, isPrimary: false })).toBe('ignore');
    g.up({ pointerType: 'touch', pointerId: 1 });
    expect(g.down({ pointerType: 'touch', pointerId: 2, isPrimary: true })).toBe('start');
    // the up of finger 2 was lost; the next contact is primary again → not a "second finger"
    expect(g.down({ pointerType: 'touch', pointerId: 3, isPrimary: true })).toBe('start');
    expect(g.count).toBe(1);
  });
});

describe('TOUCH-5 raster brush: finger strokes (service state machine)', () => {
  it('a tap (lifted before its first frame) paints a dot and ends normally', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    expect(t.calls.begin.length).toBe(0);                                 // waiting for the frame / 8 px
    expect(t.captured.has(1)).toBe(true);
    await t.fire('pointerup', finger(1, 20, 30, 140, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(1);
    expect(t.calls.begin[0].x).toBeCloseTo(40);
    expect(t.calls.end).toBe(1);
    expect(t.ended.length).toBe(1);
    expect(t.cancelled.length).toBe(0);
    expect(t.layerTexMgr.pushStrokePatch.mock.calls.length + t.layerMgr.pushSnapshotForLayer.mock.calls.length).toBe(1);
    expect(t.interactive).toBe(0);
    expect(t.preRender.length).toBe(0);
  });

  it('the first dab lands with the next frame, or as soon as the finger moves 8 px', async () => {
    const byFrame = setup();
    await byFrame.fire('pointerdown', finger(1, 20, 30, 100));
    byFrame.frame();
    expect(byFrame.calls.begin.length).toBe(1);
    const byMove = setup();
    await byMove.fire('pointerdown', finger(1, 20, 30, 100));
    await byMove.fire('pointermove', finger(1, 25, 30, 104));              // 5 px: still waiting
    expect(byMove.calls.begin.length).toBe(0);
    await byMove.fire('pointermove', finger(1, 29, 30, 108));              // 9 px: a stroke
    expect(byMove.calls.begin.length).toBe(1);
    expect(byMove.calls.begin[0].timestamp).toBe(100);                     // begins at the press, not later
    byMove.frame();
    const xs = byMove.calls.points.flat().map((p: any) => p.x);           // the samples since, in order
    expect(xs.length).toBe(2);
    expect(xs[0]).toBeCloseTo(50);
    expect(xs[1]).toBeCloseTo(58);
  });

  it('a one-finger drag paints and commits like before', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    for (let i = 1; i <= 5; i++) { await t.fire('pointermove', finger(1, 20 + i * 6, 30, 100 + i * 16)); t.frame(); }
    await t.fire('pointerup', finger(1, 50, 30, 200, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(1);
    expect(t.calls.points.flat().length).toBe(5);
    expect(t.calls.end).toBe(1);
    expect(t.calls.cancel).toBe(0);
    expect(t.ended.length).toBe(1);
  });

  it('a second finger inside the delay: nothing painted, nothing ended, no undo, no stroke-end event', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    await t.fire('pointerdown', finger(2, 90, 60, 104));
    expect(t.cancelled).toEqual([expect.objectContaining({ began: false })]);
    expect(t.interactive).toBe(0);
    expect(t.captured.size).toBe(0);
    expect(t.preRender.length).toBe(0);
    // the pinch: both fingers move, frames run, both lift
    for (let i = 1; i <= 4; i++) {
      await t.fire('pointermove', finger(1, 20 - i * 5, 30, 104 + i * 16));
      await t.fire('pointermove', finger(2, 90 + i * 5, 60, 104 + i * 16));
      t.frame();
    }
    await t.fire('pointerup', finger(2, 110, 60, 200, { buttons: 0 }));
    await t.fire('pointerup', finger(1, 0, 30, 210, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(0);
    expect(t.calls.points.length).toBe(0);
    expect(t.calls.end).toBe(0);
    expect(t.calls.cancel).toBe(0);                                       // no engine stroke to take back
    expect(t.ended.length).toBe(0);
    expect(t.layerTexMgr.pushStrokePatch).not.toHaveBeenCalled();
    expect(t.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();
  });

  it('a second finger after painting started: the stroke is cancelled (not ended); the rest of the pinch paints nothing', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    for (let i = 1; i <= 3; i++) { await t.fire('pointermove', finger(1, 20 + i * 6, 30, 100 + i * 16)); t.frame(); }
    expect(t.calls.begin.length).toBe(1);
    await t.fire('pointermove', finger(1, 45, 30, 160));                  // queued, not yet stamped…
    await t.fire('pointerdown', finger(2, 120, 70, 165));
    expect(t.calls.cancel).toBe(1);
    expect(t.calls.points.flat().length).toBe(3);                         // …and dropped, never stamped
    expect(t.cancelled).toEqual([expect.objectContaining({ began: true })]);
    expect(t.interactive).toBe(0);
    for (let i = 1; i <= 4; i++) {
      await t.fire('pointermove', finger(1, 45 - i * 5, 30, 165 + i * 16));
      await t.fire('pointermove', finger(2, 120 + i * 5, 70, 165 + i * 16));
      t.frame();
    }
    await t.fire('pointerup', finger(1, 25, 30, 260, { buttons: 0 }));    // the FIRST finger lifts first
    await t.fire('pointerup', finger(2, 140, 70, 270, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(1);
    expect(t.calls.points.flat().length).toBe(3);
    expect(t.calls.end).toBe(0);
    expect(t.ended.length).toBe(0);
    expect(t.layerTexMgr.pushStrokePatch).not.toHaveBeenCalled();
    expect(t.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();
    // the next one-finger stroke works normally
    await t.fire('pointerdown', finger(1, 30, 30, 400));
    t.frame();
    await t.fire('pointerup', finger(1, 30, 30, 420, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(2);
    expect(t.calls.end).toBe(1);
  });

  it('while a pinch is held, a finger that lifts and lands again never starts a stroke', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    await t.fire('pointerdown', finger(2, 90, 60, 104));
    await t.fire('pointerup', finger(1, 20, 30, 150, { buttons: 0 }));
    await t.fire('pointerdown', finger(3, 40, 40, 180, { isPrimary: false }));
    t.frame();
    await t.fire('pointermove', finger(3, 70, 40, 200));
    t.frame();
    expect(t.calls.begin.length).toBe(0);
  });

  it('a !isPrimary finger (palm / extra finger) never starts a stroke', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(5, 20, 30, 100, { isPrimary: false }));
    t.frame();
    await t.fire('pointermove', finger(5, 60, 30, 120));
    await t.fire('pointerup', finger(5, 60, 30, 140, { buttons: 0 }));
    expect(t.calls.begin.length).toBe(0);
    expect(t.interactive).toBe(0);
  });

  it('pointercancel / lostpointercapture: a waiting finger paints nothing; a live stroke ends (kept)', async () => {
    for (const type of ['pointercancel', 'lostpointercapture']) {
      const waiting = setup();
      await waiting.fire('pointerdown', finger(1, 20, 30, 100));
      await waiting.fire(type, finger(1, 20, 30, 110, { buttons: 0 }));
      waiting.frame();
      expect(waiting.calls.begin.length).toBe(0);
      expect(waiting.ended.length).toBe(0);
      expect(waiting.interactive).toBe(0);
      const live = setup();
      await live.fire('pointerdown', finger(1, 20, 30, 100));
      live.frame();
      await live.fire(type, finger(1, 20, 30, 140, { buttons: 0 }));
      expect(live.calls.end).toBe(1);
      expect(live.calls.cancel).toBe(0);
      expect(live.interactive).toBe(0);
    }
  });

  it('pen: begins at once (no delay) and a two-finger touch does not cancel it', async () => {
    const t = setup();
    const pen = (x: number, ts: number, extra: any = {}) => ({ pointerId: 9, pointerType: 'pen', isPrimary: true, clientX: x, clientY: 30, timeStamp: ts, ...extra });
    await t.fire('pointerdown', pen(20, 100));
    expect(t.calls.begin.length).toBe(1);
    await t.fire('pointerdown', finger(1, 80, 60, 110));
    await t.fire('pointerdown', finger(2, 120, 70, 112));
    expect(t.calls.cancel).toBe(0);
    await t.fire('pointermove', pen(30, 120));
    t.frame();
    await t.fire('pointerup', pen(30, 130, { buttons: 0 }));
    expect(t.calls.end).toBe(1);
    expect(t.ended.length).toBe(1);
  });

  it('a pen landing on a finger stroke (a resting palm) takes the finger stroke back and draws', async () => {
    const t = setup();
    await t.fire('pointerdown', finger(1, 20, 30, 100));
    t.frame();
    expect(t.calls.begin.length).toBe(1);
    await t.fire('pointerdown', { pointerId: 9, pointerType: 'pen', isPrimary: true, clientX: 60, clientY: 40, timeStamp: 120 });
    expect(t.calls.cancel).toBe(1);
    expect(t.calls.begin.length).toBe(2);
    expect(t.calls.begin[1].x).toBeCloseTo(120);
    await t.fire('pointerup', { pointerId: 9, pointerType: 'pen', clientX: 60, clientY: 40, timeStamp: 140, buttons: 0 });
    expect(t.calls.end).toBe(1);
    expect(t.interactive).toBe(0);
  });
});

// ── End to end on the CPU mirror: the real RasterPaintEngine behind the service ──

function fillCanvas(t: CpuTexture) {
  let s = 4242;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < t.data.length; i += 4) {
    if (r() < 0.5) continue;
    t.data[i] = 30; t.data[i + 1] = 150; t.data[i + 2] = 210; t.data[i + 3] = Math.floor(60 + r() * 195);
  }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function e2e(presetId: string, opts: { erase?: 'erase' | 'clear'; extra?: BrushPreset } = {}) {
  vi.spyOn(Math, 'random').mockReturnValue(0.37);
  const { RasterPaintEngine } = await import('../renderer/raster/core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(EW, EH, 'rgba8unorm');
  fillCanvas(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  if (opts.extra) engine.registerPreset(opts.extra);
  expect(engine.setActivePreset(presetId)).toBe(true);
  engine.setActiveTexture(tex as unknown as GPUTexture);
  await engine.initializeSnapshots();
  const t = setup({ engine });
  t.svc.setBrushColor({ r: 0.9, g: 0.2, b: 0.1, a: 1 });
  if (opts.erase) t.svc.setEraserMode(opts.erase);
  return { t, tex, engine };
}

async function smudgePreset(): Promise<BrushPreset> {
  const { createDefaultPresets } = await import('../renderer/raster/core/raster-paint-engine');
  const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
  return { ...soft, id: 'test_smudge', smudge: { enabled: true, strength: 0.6 } } as BrushPreset;
}

describe('TOUCH-5 end to end (CPU mirror)', () => {
  it('a tap paints a dot; a one-finger drag paints and leaves ONE undo patch', async () => {
    const { t, tex } = await e2e('default_hard_pen');
    const s0 = tex.data.slice();
    await t.fire('pointerdown', finger(1, 40, 50, 1000));
    await t.fire('pointerup', finger(1, 40, 50, 1030, { buttons: 0 }));
    expect(same(tex.data, s0)).toBe(false);
    expect(t.layerTexMgr.pushStrokePatch).toHaveBeenCalledTimes(1);
    const s1 = tex.data.slice();
    await t.fire('pointerdown', finger(1, 60, 40, 2000));
    for (let i = 1; i <= 5; i++) { await t.fire('pointermove', finger(1, 60 + i * 8, 40 + i * 2, 2000 + i * 16)); t.frame(); }
    await t.fire('pointerup', finger(1, 100, 50, 2100, { buttons: 0 }));
    expect(same(tex.data, s1)).toBe(false);
    expect(t.layerTexMgr.pushStrokePatch).toHaveBeenCalledTimes(2);
    expect(t.ended.length).toBe(2);
  });

  it('a second finger inside the delay leaves the layer untouched and writes nothing at all', async () => {
    const { t, tex, engine } = await e2e('default_round_soft');
    const s0 = tex.data.slice();
    const stats0 = JSON.stringify(engine.snapshotManager.getStats());
    const seq0 = rasterContentSeq();
    await t.fire('pointerdown', finger(1, 40, 50, 1000));
    await t.fire('pointerdown', finger(2, 120, 70, 1006));
    for (let i = 1; i <= 3; i++) {
      await t.fire('pointermove', finger(1, 40 - i * 6, 50, 1006 + i * 16));
      await t.fire('pointermove', finger(2, 120 + i * 6, 70, 1006 + i * 16));
      t.frame();
    }
    await t.fire('pointerup', finger(1, 22, 50, 1100, { buttons: 0 }));
    await t.fire('pointerup', finger(2, 138, 70, 1110, { buttons: 0 }));
    expect(same(tex.data, s0)).toBe(true);
    expect(rasterContentSeq()).toBe(seq0);                                // no pixel write was even reported
    expect(JSON.stringify(engine.snapshotManager.getStats())).toBe(stats0);
    expect(t.layerTexMgr.pushStrokePatch).not.toHaveBeenCalled();
    expect(t.ended.length).toBe(0);
  });

  const cases: Array<[string, string, { erase?: 'erase' | 'clear'; smudge?: boolean }]> = [
    ['brush (hard pen)', 'default_hard_pen', {}],
    ['brush (soft, wet accum)', 'default_round_soft', {}],
    ['brush (watercolor)', 'default_watercolor_wash', {}],
    ['eraser', 'default_round_soft', { erase: 'erase' }],
    ['eraser preset', 'default_eraser', {}],
    ['smudge', 'test_smudge', { smudge: true }],
  ];
  for (const [name, id, o] of cases) {
    it(`${name}: a second finger after painting started restores the layer byte-exactly — no undo entry, no stroke end`, async () => {
      const { t, tex, engine } = await e2e(id, { erase: o.erase, extra: o.smudge ? await smudgePreset() : undefined });
      const s0 = tex.data.slice();
      const stats0 = JSON.stringify(engine.snapshotManager.getStats());
      await t.fire('pointerdown', finger(1, 40, 50, 1000, { pressure: 1 }));
      for (let i = 1; i <= 8; i++) { await t.fire('pointermove', finger(1, 40 + i * 7, 50 + (i % 2) * 4, 1000 + i * 16, { pressure: 1 })); t.frame(); }
      expect(same(tex.data, s0)).toBe(false);                             // it painted (or erased)
      const unattributed0 = rasterContentStats.unattributed;
      await t.fire('pointerdown', finger(2, 140, 80, 1110));
      expect(same(tex.data, s0)).toBe(true);                              // every texel is back
      // the pinch continues and both fingers lift: still nothing
      for (let i = 1; i <= 3; i++) {
        await t.fire('pointermove', finger(1, 96 - i * 8, 50, 1110 + i * 16));
        await t.fire('pointermove', finger(2, 140 + i * 8, 80, 1110 + i * 16));
        t.frame();
      }
      await t.fire('pointerup', finger(1, 70, 50, 1200, { buttons: 0 }));
      await t.fire('pointerup', finger(2, 164, 80, 1210, { buttons: 0 }));
      expect(same(tex.data, s0)).toBe(true);
      expect(JSON.stringify(engine.snapshotManager.getStats())).toBe(stats0);   // no engine snapshot / patch
      expect(t.layerTexMgr.pushStrokePatch).not.toHaveBeenCalled();             // no layer undo patch…
      expect(t.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();           // …or snapshot
      expect(t.ended.length).toBe(0);                                           // the host's autosave / upload hook
      expect(t.cancelled.length).toBe(1);
      // the restore is attributed to the layer texture (a save re-reads only it — never every layer)
      expect(rasterContentStats.unattributed).toBe(unattributed0);
      expect(rasterTextureWrittenAt(tex)).toBe(rasterContentSeq());
    });
  }

  it('pen is unaffected: the same pen stroke paints the same bytes as before, two fingers or not', async () => {
    const run = async (withFingers: boolean) => {
      const { t, tex } = await e2e('default_hard_pen');
      const pen = (x: number, ts: number, extra: any = {}) => ({ pointerId: 9, pointerType: 'pen', isPrimary: true, clientX: x, clientY: 50, timeStamp: ts, ...extra });
      await t.fire('pointerdown', pen(30, 1000));
      if (withFingers) {
        await t.fire('pointerdown', finger(1, 100, 80, 1004));
        await t.fire('pointerdown', finger(2, 140, 90, 1006));
      }
      for (let i = 1; i <= 5; i++) { await t.fire('pointermove', pen(30 + i * 10, 1000 + i * 16)); t.frame(); }
      await t.fire('pointerup', pen(80, 1100, { buttons: 0 }));
      return { bytes: tex.data.slice(), patches: t.layerTexMgr.pushStrokePatch.mock.calls.length };
    };
    const plain = await run(false);
    const pinched = await run(true);
    expect(same(plain.bytes, pinched.bytes)).toBe(true);
    expect(plain.patches).toBe(1);
    expect(pinched.patches).toBe(1);
  });
});
