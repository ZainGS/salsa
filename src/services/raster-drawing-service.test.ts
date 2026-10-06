/**
 * BRUSH-3 / BRUSH-4 / BRUSH-6 (docs/specs/mobile-parity.md §3): a raster stroke is locked to ONE pointer (captured),
 * ends on pointercancel / lostpointercapture / a buttons-released move, never leaks its interactive lease,
 * feeds every coalesced sample (with its own timestamp) to the engine as one batch per frame, and pushes ONE
 * undo snapshot (the engine's rect patch → the selected layer's stack).
 */
import { describe, it, expect, vi } from 'vitest';
import { RasterDrawingService } from './raster-drawing-service';

type Handler = (e: any) => unknown;

function setup(opts: { layerStack?: boolean; preRender?: boolean } = {}) {
  const listeners = new Map<string, Handler[]>();
  const captured = new Set<number>();
  const canvas = {
    width: 100, height: 100, clientWidth: 100, clientHeight: 100,
    addEventListener: (t: string, h: Handler) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { listeners.set(t, (listeners.get(t) ?? []).filter(x => x !== h)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  };
  let interactive = 0;
  const interactionService = {
    canvas,
    beginInteractive: () => { interactive++; },
    endInteractive: () => { interactive--; },
    clearSelectedNodes: () => { /* */ },
    toWorldCoordsFromCanvas: (x: number, y: number) => ({ x: x / 50 - 1, y: 1 - y / 50 }),
    toWorldCoords: () => { throw new Error('per-event getBoundingClientRect path should not be used'); },
  };
  const calls = { begin: [] as any[], points: [] as any[][], end: [] as any[], endOpts: [] as any[], erase: [] as Array<number | null>, preset: [] as string[] };
  const patch = { texture: {}, w: 100, h: 100, x: 1, y: 1, rw: 2, rh: 2, before: new Uint8Array(16), after: new Uint8Array(16) };
  const engine = {
    setBrushColor: () => {}, setLockTransparency: () => {}, setAspectCorrection: () => {}, setSelectionMask: () => {},
    setEraseMode: (m: number | null) => { calls.erase.push(m); },
    setActivePreset: (id: string) => { if (id === 'missing') return false; calls.preset.push(id); return true; },
    beginStroke: (p: any) => { calls.begin.push(p); },
    addStrokePoints: (pts: any[]) => { calls.points.push(pts); },
    endStroke: async (p: any, o: any) => { calls.end.push(p); calls.endOpts.push(o); return patch; },
  };
  const preRender: Array<() => boolean> = [];
  const layerTexMgr = { pushStrokePatch: vi.fn(async () => {}) };
  const layerMgr = {
    getSelectedLayerId: () => 'L1',
    getSelectedLayerManager: () => layerTexMgr,
    pushSnapshotForLayer: vi.fn(() => true),
  };
  const renderer: any = {
    rasterPaintEngine: engine,
    getRasterTextureSize: () => ({ w: 200, h: 200 }),
    getIllustrationMode: () => false,
    getIllustrationBounds: () => null,
    syncActiveLayerTexture: () => {},
    scheduleRender: () => {},
    rasterLayerManager: opts.layerStack === false ? undefined : layerMgr,
  };
  if (opts.preRender !== false) {
    renderer.addPreRenderCallback = (cb: () => boolean) => { if (!preRender.includes(cb)) preRender.push(cb); };
    renderer.removePreRenderCallback = (cb: () => boolean) => { const i = preRender.indexOf(cb); if (i >= 0) preRender.splice(i, 1); };
  }
  const svc = new RasterDrawingService(interactionService as any, renderer, {} as any);
  svc.enable();
  const fire = async (type: string, e: any) => { for (const h of listeners.get(type) ?? []) await h({ button: 0, buttons: 1, pressure: 0.5, tiltX: 0, tiltY: 0, ...e }); };
  const frame = () => { for (const cb of [...preRender]) cb(); };
  return { svc, fire, frame, calls, captured, preRender, layerMgr, layerTexMgr, get interactive() { return interactive; } };
}

describe('BRUSH-3 stroke pointer lock', () => {
  it('locks to the first pointer: a second finger / palm neither restarts, feeds nor ends the stroke', async () => {
    const t = setup();
    await t.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 100 });
    expect(t.captured.has(1)).toBe(true);
    expect(t.interactive).toBe(1);
    await t.fire('pointerdown', { pointerId: 2, clientX: 80, clientY: 80, timeStamp: 101 });   // palm
    expect(t.calls.begin.length).toBe(1);
    expect(t.interactive).toBe(1);                                                           // no 2nd lease
    await t.fire('pointermove', { pointerId: 2, clientX: 90, clientY: 90, timeStamp: 102 });
    await t.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 20, timeStamp: 116 });
    t.frame();
    expect(t.calls.points.flat().length).toBe(1);
    expect(t.calls.points[0][0].x).toBeCloseTo(40);                                          // 20 css px → 40 texels
    await t.fire('pointerup', { pointerId: 2, buttons: 0, timeStamp: 120 });
    expect(t.calls.end.length).toBe(0);
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 130 });
    expect(t.calls.end.length).toBe(1);
    expect(t.interactive).toBe(0);
    expect(t.captured.has(1)).toBe(false);
    expect(t.preRender.length).toBe(0);
    // the release fires lostpointercapture after pointerup — must be a no-op
    await t.fire('lostpointercapture', { pointerId: 1, buttons: 0 });
    expect(t.calls.end.length).toBe(1);
    expect(t.interactive).toBe(0);
  });

  it('pointercancel and lostpointercapture end the stroke (no stuck isDrawing / lease)', async () => {
    for (const type of ['pointercancel', 'lostpointercapture']) {
      const t = setup();
      await t.fire('pointerdown', { pointerId: 7, clientX: 10, clientY: 10, timeStamp: 10 });
      await t.fire(type, { pointerId: 7, buttons: 0, timeStamp: 20 });
      expect(t.calls.end.length).toBe(1);
      expect(t.interactive).toBe(0);
      // next stroke starts normally
      await t.fire('pointerdown', { pointerId: 8, clientX: 10, clientY: 10, timeStamp: 30 });
      expect(t.calls.begin.length).toBe(2);
      expect(t.interactive).toBe(1);
    }
  });

  it('a move with no button held ends the stroke (missed pointerup)', async () => {
    const t = setup();
    await t.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 10 });
    await t.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 50, buttons: 0, timeStamp: 20 });
    expect(t.calls.end.length).toBe(1);
    expect(t.calls.points.flat().length).toBe(0);
    expect(t.interactive).toBe(0);
  });
});

describe('BRUSH-4 coalesced samples', () => {
  it('feeds every coalesced sample with its own timestamp, as ONE batch per frame', async () => {
    const t = setup();
    await t.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 1000 });
    const samples = [1, 2, 3, 4].map(i => ({ pointerId: 1, clientX: i * 5, clientY: i * 2, pressure: 0.1 * i, tiltX: 0, tiltY: 0, timeStamp: 1000 + i * 4 }));
    await t.fire('pointermove', { pointerId: 1, clientX: 20, clientY: 8, timeStamp: 1016, getCoalescedEvents: () => samples });
    expect(t.calls.points.length).toBe(0);           // queued until the frame
    t.frame();
    expect(t.calls.points.length).toBe(1);
    expect(t.calls.points[0].map((p: any) => p.timestamp)).toEqual([1004, 1008, 1012, 1016]);
    expect(t.calls.points[0].map((p: any) => p.pressure)).toEqual([0.1, 0.2, 0.30000000000000004, 0.4]);
    // pointerup drains anything still queued before ending
    await t.fire('pointermove', { pointerId: 1, clientX: 30, clientY: 9, timeStamp: 1032 });
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 1040 });
    expect(t.calls.points.length).toBe(2);
    expect(t.calls.end[0].timestamp).toBe(1040);
  });

  it('without a pre-render hook the samples are stamped immediately', async () => {
    const t = setup({ preRender: false });
    await t.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 1 });
    await t.fire('pointermove', { pointerId: 1, clientX: 10, clientY: 0, timeStamp: 17 });
    expect(t.calls.points.length).toBe(1);
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 20 });
  });
});

describe('BRUSH-6 one snapshot per stroke', () => {
  it('the engine skips its own snapshot and the rect patch goes to the selected layer stack', async () => {
    const t = setup();
    await t.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 1 });
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 2 });
    expect(t.calls.endOpts[0]).toEqual({ pushSnapshot: false });
    expect(t.layerTexMgr.pushStrokePatch).toHaveBeenCalledTimes(1);
    expect(t.layerMgr.pushSnapshotForLayer).not.toHaveBeenCalled();
  });

  it('with no layer manager the engine keeps its own snapshot', async () => {
    const t = setup({ layerStack: false });
    await t.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, timeStamp: 1 });
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 2 });
    expect(t.calls.endOpts[0]).toEqual({ pushSnapshot: true });
  });
});

describe('brush switch leaves erase mode', () => {
  it('picking a brush after the eraser tool resets erase mode (service AND engine override)', () => {
    const t = setup();
    t.svc.setEraserMode('erase');
    expect(t.svc.getEraseMode()).toBe(1);
    expect(t.calls.erase.at(-1)).toBe(1);
    expect(t.svc.selectBrushPreset('default_hard_pen')).toBe(true);
    expect(t.calls.preset).toEqual(['default_hard_pen']);
    expect(t.svc.getEraseMode()).toBeNull();
    expect(t.calls.erase.at(-1)).toBeNull();
  });

  it('also leaves the clear and hard erase modes', () => {
    for (const setMode of [(s: RasterDrawingService) => s.setEraserMode('clear'),
                           (s: RasterDrawingService) => { s.setEraserHard(true); s.setEraserMode('erase'); }]) {
      const t = setup();
      setMode(t.svc);
      expect(t.svc.getEraseMode()).not.toBeNull();
      t.svc.selectBrushPreset('default_round_soft');
      expect(t.svc.getEraseMode()).toBeNull();
      expect(t.calls.erase.at(-1)).toBeNull();
    }
  });

  it('an unknown preset changes nothing (the eraser stays on)', () => {
    const t = setup();
    t.svc.setEraserMode('clear');
    expect(t.svc.selectBrushPreset('missing')).toBe(false);
    expect(t.svc.getEraseMode()).toBe(2);
  });

  it('every stroke re-applies the tool mode, so a stale engine erase override cannot survive', async () => {
    const t = setup();
    t.svc.setEraserMode('erase');
    t.svc.selectBrushPreset('default_hard_pen');
    t.calls.erase.length = 0;
    await t.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 1 });
    expect(t.calls.erase).toEqual([null]);                 // painting stroke: override cleared
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 2 });
    t.svc.setEraserMode('clear');
    t.calls.erase.length = 0;
    await t.fire('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 3 });
    expect(t.calls.erase).toEqual([2]);                    // eraser stroke: clear re-applied
    await t.fire('pointerup', { pointerId: 1, buttons: 0, timeStamp: 4 });
  });
});
