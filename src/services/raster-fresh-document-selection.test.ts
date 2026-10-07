/**
 * Fresh-document paint layer (2026-10-07): a new document's stack is [Vector, Background] (addVectorLayer unshifts, so
 * `getLayers()[0]` is the VECTOR entry). Frogmarks' layer service auto-selected `layers[0]` for painting: every brush
 * stroke then painted the renderer's orphan fallback texture (invisible), pushed its undo onto a layer without pixels
 * ("reading 'pushSnapshot'") and Ctrl+Z threw ("reading 'undo'").
 *
 * Now: a vector / ephemera layer or a folder can never be the selected (paint) layer, a stroke with a pixel-less layer
 * selected (the 3D scene) does not start, and a fresh document's stroke → undo → redo runs on Background's history.
 *
 * Runs the REAL RasterLayerManager / RasterTextureManager on a mock GPU device (texture objects carry identity; no pixels).
 */
import { describe, it, expect, vi } from 'vitest';

import { webcrypto } from 'node:crypto';
const g = globalThis as Record<string, unknown>;
g.self ??= globalThis;
g.crypto ??= webcrypto;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

import { RasterLayerManager } from './raster-layer-manager';
import { RasterDrawingService } from './raster-drawing-service';
import ShapeManager from './shape-manager';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const permissive: any = new Proxy(function () { /* callable */ }, {
  get: (_t, p) => (p === 'then' ? undefined : permissive),
  apply: () => permissive,
});

let texSeq = 0;
function makeMockDevice(): GPUDevice {
  const device = {
    createTexture: (desc: { size: number[] }) => ({
      label: `mock-tex-${texSeq++}`,
      width: desc.size[0], height: desc.size[1],
      destroy() { /* noop */ },
      createView: () => ({}),
    }),
    createBuffer: (desc: { size: number }) => ({
      size: desc.size,
      mapAsync: async () => undefined,
      getMappedRange: () => new ArrayBuffer(desc.size),
      unmap() { /* noop */ },
      destroy() { /* noop */ },
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => permissive,
      beginComputePass: () => permissive,
      copyTextureToTexture() { /* noop */ },
      copyTextureToBuffer() { /* noop */ },
      copyBufferToTexture() { /* noop */ },
      copyBufferToBuffer() { /* noop */ },
      clearBuffer() { /* noop */ },
      finish: () => ({}),
    }),
    createBindGroupLayout: () => permissive,
    createPipelineLayout: () => permissive,
    createShaderModule: () => permissive,
    createComputePipeline: () => permissive,
    createRenderPipeline: () => permissive,
    createSampler: () => permissive,
    createBindGroup: () => permissive,
    queue: {
      submit() { /* noop */ },
      writeTexture() { /* noop */ },
      writeBuffer() { /* noop */ },
      copyExternalImageToTexture() { /* noop */ },
      onSubmittedWorkDone: async () => undefined,
    },
  };
  return device as unknown as GPUDevice;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A new document: the default stack ([Vector, Background], Background selected). */
async function freshDocument() {
  const rlm = new RasterLayerManager(makeMockDevice(), 8, 8);
  rlm.resetToDefaultLayers();
  await settle();
  const layers = rlm.getLayers();
  const bg = layers.find((l) => l.name === 'Background')!.id;
  const vec = layers.find((l) => l.type === 'vector')!.id;
  return { rlm, bg, vec };
}

/** A RasterDrawingService on a mock canvas / paint engine whose renderer carries the REAL layer manager. */
function drawingOn(rlm: RasterLayerManager) {
  const listeners = new Map<string, Array<(e: unknown) => unknown>>();
  const canvas = {
    width: 100, height: 100, clientWidth: 100, clientHeight: 100,
    addEventListener: (t: string, h: (e: unknown) => unknown) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    removeEventListener: () => { /* */ },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: () => { /* */ }, hasPointerCapture: () => false, releasePointerCapture: () => { /* */ },
  };
  const interactionService = {
    canvas, beginInteractive: () => { /* */ }, endInteractive: () => { /* */ }, clearSelectedNodes: () => { /* */ },
    toWorldCoordsFromCanvas: (x: number, y: number) => ({ x, y }),
  };
  const begin = vi.fn();
  const engine = {
    setBrushColor: () => { /* */ }, setLockTransparency: () => { /* */ }, setAspectCorrection: () => { /* */ },
    setSelectionMask: () => { /* */ }, setEraseMode: () => { /* */ },
    beginStroke: begin, addStrokePoints: () => { /* */ },
    // the rect BEFORE / AFTER patch of a 2×2 dab on the texture the stroke painted (the selected layer's)
    endStroke: async () => ({ texture: rlm.getSelectedLayerTexture(), w: 8, h: 8, x: 1, y: 1, rw: 2, rh: 2, before: new Uint8Array(16), after: new Uint8Array(16).fill(255) }),
  };
  const renderer = {
    rasterPaintEngine: engine, rasterLayerManager: rlm,
    getRasterTextureSize: () => ({ w: 8, h: 8 }), getIllustrationMode: () => false, getIllustrationBounds: () => null,
    syncActiveLayerTexture: () => { /* */ }, scheduleRender: () => { /* */ },
  };
  const svc = new RasterDrawingService(interactionService as never, renderer as never, {} as never);
  svc.enable();
  const fire = async (type: string, e: Record<string, unknown>) => {
    for (const h of listeners.get(type) ?? []) await h({ button: 0, buttons: 1, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'mouse', ...e });
  };
  const stroke = async (id: number) => {
    await fire('pointerdown', { pointerId: id, clientX: 10, clientY: 10, timeStamp: id * 10 });
    await fire('pointerup', { pointerId: id, buttons: 0, timeStamp: id * 10 + 5 });
  };
  return { stroke, begin };
}

/** ShapeManager's raster undo / redo against a bare `this` carrying the layer manager. */
function smOn(rlm: RasterLayerManager) {
  const self = { rasterLayerManager: rlm, scheduleRender: vi.fn(), webgpuRenderer: { rasterUndo: vi.fn(async () => true), rasterRedo: vi.fn(async () => true) } };
  return {
    undo: () => ShapeManager.prototype.rasterUndo.call(self as never),
    redo: () => ShapeManager.prototype.rasterRedo.call(self as never),
    self,
  };
}

describe('a fresh document selects a PIXEL layer for painting', () => {
  it('the default stack is [Vector, Background] and Background is the selected paint layer', async () => {
    const { rlm, bg, vec } = await freshDocument();
    expect(rlm.getLayers()[0].id).toBe(vec);              // the trap: layers[0] is the vector entry
    expect(rlm.getSelectedLayerId()).toBe(bg);
    expect(rlm.hasRasterHistory(bg)).toBe(true);
    expect(rlm.getSelectedLayerManager()).toBeTruthy();
    expect(rlm.getSelectedLayerTexture()).toBeTruthy();
  });

  it('selecting the vector layer, an ephemera layer or a folder is refused: false, the paint layer stays, no paint retarget', async () => {
    const { rlm, bg, vec } = await freshDocument();
    const eph = rlm.addEphemeraLayer('Stickers');
    const folder = rlm.addFolder('Group').id;
    const onSelect = vi.fn();
    rlm.setSelectionCallback(onSelect);
    for (const id of [vec, eph, folder]) {
      expect(rlm.selectLayer(id)).toBe(false);
      expect(rlm.getSelectedLayerId()).toBe(bg);
    }
    expect(onSelect).not.toHaveBeenCalled();
    // real layers and the 3D scene (a loaded city document selects it) stay selectable
    const ink = rlm.addLayer('Ink').id;
    expect(rlm.selectLayer(ink)).toBe(true);
    expect(rlm.getSelectedLayerId()).toBe(ink);
    const scene = rlm.add3DDivider('3D Scene');
    expect(rlm.selectLayer(scene)).toBe(true);
    expect(rlm.selectLayer('missing')).toBe(false);
  });

  it('stroke → undo → redo → stroke on a fresh document runs on Background\'s history, never throws', async () => {
    const { rlm, bg, vec } = await freshDocument();
    rlm.selectLayer(vec);                                     // what the host's layers[0] auto-select asked for
    expect(rlm.getSelectedLayerId()).toBe(bg);
    const d = drawingOn(rlm);
    const sm = smOn(rlm);
    const before = rlm.getLayerHistoryMark(bg);

    await d.stroke(1);
    expect(d.begin).toHaveBeenCalledTimes(1);
    const afterStroke = rlm.getLayerHistoryMark(bg);
    expect(afterStroke?.top).not.toBe(before?.top);           // the stroke recorded an undo entry on Background

    await expect(sm.undo()).resolves.toBe(true);
    expect(rlm.getLayerHistoryMark(bg)?.top).toBe(before?.top);
    await expect(sm.redo()).resolves.toBe(true);
    expect(rlm.getLayerHistoryMark(bg)?.top).toBe(afterStroke?.top);

    await expect(sm.undo()).resolves.toBe(true);
    await d.stroke(2);                                        // draw again after an undo
    expect(d.begin).toHaveBeenCalledTimes(2);
    expect(rlm.getLayerHistoryMark(bg)?.top).not.toBe(before?.top);
    // the renderer-level fallback (no layer manager) was never used
    expect(sm.self.webgpuRenderer.rasterUndo).not.toHaveBeenCalled();
  });

  it('a new document made at the window size and THEN sized: undoing the first stroke keeps the document size', async () => {
    // Frogmarks: the layer manager is created at the canvas size (13×7 here), then setDocumentSize(8, 8). The blank
    // seed stayed 13×7, so Ctrl+Z of the first stroke reallocated Background to 13×7 and the next stroke was lost.
    const rlm = new RasterLayerManager(makeMockDevice(), 13, 7);
    rlm.resetToDefaultLayers();
    rlm.setSize(8, 8);
    await settle();
    const bg = rlm.getLayers().find((l) => l.name === 'Background')!.id;
    const mgr = rlm.getSelectedLayerManager()!;
    const d = drawingOn(rlm);
    const sm = smOn(rlm);
    await d.stroke(1);
    const tex = rlm.getLayerTexture(bg);
    await expect(sm.undo()).resolves.toBe(true);
    expect(mgr.getTextureSize()).toEqual({ w: 8, h: 8 });
    expect(rlm.getLayerTexture(bg)).toBe(tex);                // not reallocated
    await expect(sm.undo()).resolves.toBe(false);             // the (8×8) seed is the oldest state
    await expect(sm.redo()).resolves.toBe(true);
    expect(mgr.getTextureSize()).toEqual({ w: 8, h: 8 });
  });

  it('undo across a REAL resize adopts the reallocated texture (the layer used to keep the destroyed one)', async () => {
    const { rlm, bg } = await freshDocument();
    const d = drawingOn(rlm);
    const sm = smOn(rlm);
    await d.stroke(1);                                        // a real 8×8 entry: the history is kept on resize
    rlm.setSize(16, 16);
    await settle();
    const onSelect = vi.fn();
    rlm.setSelectionCallback(onSelect);
    const mgr = rlm.getSelectedLayerManager()!;
    await expect(sm.undo()).resolves.toBe(true);              // the 8×8 entry: the manager reallocates to 8×8
    expect(mgr.getTextureSize()).toEqual({ w: 8, h: 8 });
    expect(rlm.getLayerTexture(bg)).toBe(mgr.getTexture());
    expect(onSelect).toHaveBeenCalledWith(mgr.getTexture(), mgr);
  });

  it('a flood fill / fill-selection writes the selected PAINT layer and records one undo step on it (it recorded none)', async () => {
    const { rlm, bg, vec } = await freshDocument();
    rlm.selectLayer(vec);                                     // refused: Background stays the target
    const fill = vi.fn(async (_tex: unknown, _opts?: unknown) => true);
    const self = {
      rasterLayerManager: rlm, scheduleRender: vi.fn(), floodFillEngine: { fill },
      webgpuRenderer: { getDevice: () => ({}) }, rasterSelectionService: undefined,
    };
    const push = vi.spyOn(rlm.getSelectedLayerManager()!, 'pushSnapshot');
    await expect(ShapeManager.prototype.floodFill.call(self as never, 2, 2, '#ff0000')).resolves.toBe(true);
    expect(fill.mock.calls[0][0]).toBe(rlm.getLayerTexture(bg));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ noCoalesce: true });  // a quick second fill is its own step too
    await expect(ShapeManager.prototype.fillSelection.call(self as never, '#00ff00')).resolves.toBe(true);
    expect(fill.mock.calls[1][0]).toBe(rlm.getLayerTexture(bg));
    expect(push).toHaveBeenCalledTimes(2);
    fill.mockResolvedValueOnce(false);                        // nothing filled: no undo step
    await ShapeManager.prototype.floodFill.call(self as never, 2, 2, '#ff0000');
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('with the 3D scene selected a brush stroke does not start (it used to paint an orphan texture with no undo)', async () => {
    const { rlm } = await freshDocument();
    const scene = rlm.add3DDivider('3D Scene');
    rlm.selectLayer(scene);
    const d = drawingOn(rlm);
    await d.stroke(1);
    expect(d.begin).not.toHaveBeenCalled();
    await expect(smOn(rlm).undo()).resolves.toBe(false);      // and Ctrl+Z is a quiet no-op
  });
});
