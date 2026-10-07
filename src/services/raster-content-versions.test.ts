/**
 * mobile-parity §7.3c (2026-10-07):
 *  1. `sm.getRasterContentVersions()` — per-layer / per-cel content versions a host compares against what it last
 *     uploaded (Frogmarks' cloud upload used to learn about brush strokes only, so a fill / undo / paste / transform /
 *     text stamp / … on an uploaded layer never went up). Fed by the same write reports the incremental autosave uses.
 *  2. Ctrl+Z in a city document threw "Cannot read properties of undefined (reading 'undo')": the selected layer was
 *     the 3D divider, which has no texture manager. Raster undo / redo / snapshot on a layer without pixels is now a
 *     no-op returning false.
 *
 * Runs the REAL RasterLayerManager on a mock GPU device (texture objects carry identity; no pixels).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { webcrypto } from 'node:crypto';
const g = globalThis as Record<string, unknown>;
g.self ??= globalThis;
g.crypto ??= webcrypto;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

import { RasterLayerManager } from './raster-layer-manager';
import ShapeManager from './shape-manager';
import { RasterManager } from './managers/raster-manager';
import { markRasterCompositeDirty } from '../renderer/raster/core/raster-composite-dirty';
import { bumpGpuPixelEpoch } from '../renderer/raster/gpu-pixel-epoch';
import { rasterTextureVersion } from '../renderer/raster/raster-content-version';

afterEach(() => { vi.restoreAllMocks(); });

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

/** A document like a city one: Background paint layer, a vector layer and a 3D divider (selected, as on load). */
function cityLikeStack() {
  const rlm = new RasterLayerManager(makeMockDevice(), 8, 8);
  const bg = rlm.getLayers()[0].id;
  const ink = rlm.addLayer('Ink').id;
  const vec = rlm.addVectorLayer('Vector');
  const divider = rlm.add3DDivider('3D Scene');
  return { rlm, bg, ink, vec, divider };
}

describe('RasterLayerManager.getContentVersions (host cloud-upload dirtiness)', () => {
  it('lists paint layers only, and is stable while nothing is written', () => {
    const { rlm, bg, ink, vec, divider } = cityLikeStack();
    const a = rlm.getContentVersions();
    expect(Object.keys(a.layers).sort()).toEqual([bg, ink].sort());
    expect(a.layers[vec]).toBeUndefined();
    expect(a.layers[divider]).toBeUndefined();
    expect(rlm.getContentVersions()).toEqual(a);
  });

  it('an attributed write (fill / undo / paste / transform / text stamp — every writer reports its texture) changes only that layer', () => {
    const { rlm, bg, ink } = cityLikeStack();
    const before = rlm.getContentVersions();
    markRasterCompositeDirty({ x0: 0, y0: 0, x1: 4, y1: 4 }, rlm.getLayerTexture(ink)!);
    const after = rlm.getContentVersions();
    expect(after.layers[ink]).not.toBe(before.layers[ink]);
    expect(after.layers[bg]).toBe(before.layers[bg]);
    // bumpGpuPixelEpoch (direct uploads: load, import, merge, duplicate) reports the same way
    bumpGpuPixelEpoch('full', rlm.getLayerTexture(bg)!);
    const third = rlm.getContentVersions();
    expect(third.layers[bg]).not.toBe(after.layers[bg]);
    expect(third.layers[ink]).toBe(after.layers[ink]);
  });

  it('a write with no known target changes EVERY version (fail safe)', () => {
    const { rlm, bg, ink } = cityLikeStack();
    const before = rlm.getContentVersions();
    markRasterCompositeDirty();
    const after = rlm.getContentVersions();
    expect(after.layers[bg]).not.toBe(before.layers[bg]);
    expect(after.layers[ink]).not.toBe(before.layers[ink]);
  });

  it('a new texture (canvas resize, device recovery) changes the version without any write report', () => {
    const { rlm, bg } = cityLikeStack();
    const before = rlm.getContentVersions();
    rlm.setSize(16, 16);
    expect(rlm.getContentVersions().layers[bg]).not.toBe(before.layers[bg]);
  });

  it('versions each cel by its own texture; a write to one cel leaves the others', () => {
    const { rlm, ink } = cityLikeStack();
    rlm.setAnimationEnabled(true);
    rlm.setLayerAnimated(ink, true);
    const c2 = rlm.addCelAtFrame(ink, 2);
    expect(c2).toBeTruthy();
    const v = rlm.getContentVersions();
    const celIds = Object.keys(v.cels);
    expect(celIds.length).toBeGreaterThanOrEqual(2);
    const cel2Tex = rlm.getTimeline().getCels(ink).find((c) => c.id === c2)!.texture!;
    markRasterCompositeDirty(null, cel2Tex);
    const w = rlm.getContentVersions();
    expect(w.cels[c2!]).not.toBe(v.cels[c2!]);
    for (const id of celIds) if (id !== c2) expect(w.cels[id]).toBe(v.cels[id]);
  });

  it("an animated layer's own entry does not change with the displayed frame (playback is not an edit)", () => {
    const { rlm, ink } = cityLikeStack();
    rlm.setAnimationEnabled(true);
    rlm.setLayerAnimated(ink, true);
    rlm.addCelAtFrame(ink, 2);
    rlm.getTimeline().setCurrentFrame(1);
    const a = rlm.getContentVersions();
    const shown1 = rlm.getLayerTexture(ink);
    rlm.getTimeline().setCurrentFrame(2);
    const b = rlm.getContentVersions();
    expect(rlm.getLayerTexture(ink)).not.toBe(shown1);   // the frame switch did swap the layer's texture
    expect(b.layers[ink]).toBe(a.layers[ink]);
    expect(b.cels).toEqual(a.cels);
  });

  it("ShapeManager.getRasterContentVersions forwards the manager's versions plus the global write count", () => {
    const { rlm, ink } = cityLikeStack();
    const sm = { rasterLayerManager: rlm };
    const read = () => ShapeManager.prototype.getRasterContentVersions.call(sm as never);
    const a = read();
    expect(a.layers).toEqual(rlm.getContentVersions().layers);
    markRasterCompositeDirty(null, rlm.getLayerTexture(ink)!);
    const b = read();
    expect(b.seq).toBeGreaterThan(a.seq);
    // no layer manager (a renderer that is not up yet): empty, never throws
    expect(ShapeManager.prototype.getRasterContentVersions.call({} as never).layers).toEqual({});
  });

  it('rasterTextureVersion: none for no texture, a fresh object is a different version', () => {
    expect(rasterTextureVersion(null)).toBe('none');
    const t1 = {}, t2 = {};
    expect(rasterTextureVersion(t1)).not.toBe(rasterTextureVersion(t2));
    expect(rasterTextureVersion(t1)).toBe(rasterTextureVersion(t1));
  });

  it('exportLayerToBlob / exportCelToBlob: null (no throw) for layers / cels without pixels or unknown ids', async () => {
    const { rlm, vec, divider } = cityLikeStack();
    expect(await rlm.exportLayerToBlob(vec)).toBeNull();
    expect(await rlm.exportLayerToBlob(divider)).toBeNull();
    expect(await rlm.exportLayerToBlob('nope')).toBeNull();
    expect(await rlm.exportCelToBlob('nope')).toBeNull();
  });
});

describe('raster undo / redo with a layer that has no pixels selected (city document Ctrl+Z)', () => {
  it('RasterLayerManager: undo / redo / snapshot on the 3D divider, a vector layer or a folder return false, never throw', async () => {
    const { rlm, bg, vec, divider } = cityLikeStack();
    const folder = rlm.addFolder('Group').id;
    for (const id of [divider, vec, folder]) {
      await expect(rlm.undoForLayer(id)).resolves.toBe(false);
      await expect(rlm.redoForLayer(id)).resolves.toBe(false);
      expect(rlm.pushSnapshotForLayer(id)).toBe(false);
      expect(rlm.hasRasterHistory(id)).toBe(false);
    }
    expect(rlm.hasRasterHistory(bg)).toBe(true);
  });

  it('ShapeManager.rasterUndo / rasterRedo with the 3D divider selected: false, no throw, and no fallback to another layer', async () => {
    const { rlm, divider } = cityLikeStack();
    rlm.selectLayer(divider);
    const rendererUndo = vi.fn(async () => true);
    const sm = { rasterLayerManager: rlm, scheduleRender: vi.fn(), webgpuRenderer: { rasterUndo: rendererUndo, rasterRedo: rendererUndo } };
    await expect(ShapeManager.prototype.rasterUndo.call(sm as never)).resolves.toBe(false);
    await expect(ShapeManager.prototype.rasterRedo.call(sm as never)).resolves.toBe(false);
    expect(() => ShapeManager.prototype.rasterPushSnapshot.call(sm as never)).not.toThrow();
    expect(rendererUndo).not.toHaveBeenCalled();
  });

  it('RasterManager.undo / redo (the manager-context path) behave the same', async () => {
    const { rlm, divider } = cityLikeStack();
    rlm.selectLayer(divider);
    // layerMgr / renderer / ctx are getters on the class: a plain `this` with those fields stands in for the context
    const undo = (RasterManager.prototype as unknown as { undo(this: unknown): Promise<boolean> }).undo;
    const redo = (RasterManager.prototype as unknown as { redo(this: unknown): Promise<boolean> }).redo;
    const self = { layerMgr: rlm, renderer: null, ctx: { scheduleRender: vi.fn() } };
    await expect(undo.call(self)).resolves.toBe(false);
    await expect(redo.call(self)).resolves.toBe(false);
  });

  it('a paint layer still undoes through its own history', async () => {
    const { rlm, ink } = cityLikeStack();
    rlm.selectLayer(ink);
    const layer = (rlm as unknown as { layers: Array<{ id: string; manager: { undo: () => Promise<boolean> } }> }).layers.find((l) => l.id === ink)!;
    const spy = vi.spyOn(layer.manager, 'undo').mockResolvedValue(true);
    await expect(rlm.undoForLayer(ink)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
