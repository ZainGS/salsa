/**
 * Perf audit 2026-10-09 (docs/reviews/perf-audit-verified-2026-10-09.md), on the REAL RasterLayerManager +
 * AnimationTimeline + RasterTextureManager over the CPU mirror device (textures hold real bytes):
 *  A1 — splitting a hold gives the rest of the hold its OWN texture (it used to share the original's: painting one
 *       frame changed the other, deleting either destroyed both, static-again destroyed it too).
 *  A2 — a loaded layer's undo seed is the loaded pixels (it was read back BEFORE the upload → undo restored blank).
 *  B3 — a new blank layer / the Background's resize reseed costs no read-back and holds no full RAM copy.
 *  A3 — undo on cel 2+ acts on that cel (it snapshotted / restored the layer's base texture), also after a reload
 *       (which used to destroy the base texture the layer's history kept using).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createCpuDevice, installGpuGlobals, type CpuTexture } from '../renderer/raster/cpu-gpu-mirror';
import { rasterSnapshotStats } from '../renderer/raster/core/raster-snapshot-manager';
import type { RasterRectPatch } from '../renderer/raster/core/raster-snapshot-manager';
import { markRasterCompositeDirty } from '../renderer/raster/core/raster-composite-dirty';

const g = globalThis as Record<string, unknown>;
g.self ??= globalThis;
g.crypto ??= webcrypto;

let RLM: typeof import('./raster-layer-manager').RasterLayerManager;
beforeAll(async () => {
  installGpuGlobals();
  RLM = (await import('./raster-layer-manager')).RasterLayerManager;
});

const W = 8, H = 6;
const cpu = (t: GPUTexture | null | undefined) => t as unknown as CpuTexture;
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function pattern(seed: number, w = W, h = H): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < a.length; i++) a[i] = (i * 7 + seed * 31 + 1) & 255;
  return a;
}

/** A brush stroke: write a rect of `value` into `tex` and report it like the brush pipeline (dabs) does. */
function stroke(tex: GPUTexture, value: number, x = 1, y = 1, rw = 3, rh = 2): RasterRectPatch & { texture: GPUTexture } {
  const t = cpu(tex);
  const before = new Uint8Array(rw * rh * 4), after = new Uint8Array(rw * rh * 4);
  for (let r = 0; r < rh; r++) for (let c = 0; c < rw * 4; c++) {
    const o = ((y + r) * t.width + x) * 4 + c;
    before[r * rw * 4 + c] = t.data[o];
    t.data[o] = value;
    after[r * rw * 4 + c] = value;
  }
  markRasterCompositeDirty({ x0: x, y0: y, x1: x + rw, y1: y + rh }, tex);
  return { w: t.width, h: t.height, x, y, rw, rh, before, after, texture: tex };
}

/** A fill: overwrite the whole texture, then the tool pushes a full snapshot on the layer. */
function fill(tex: GPUTexture, value: number): void {
  cpu(tex).data.fill(value);
  markRasterCompositeDirty(null, tex);
}

function animatedDoc() {
  const gpu = createCpuDevice();
  const rlm = new RLM(gpu.device, W, H);
  const id = rlm.getLayers()[0].id;
  rlm.selectLayer(id);
  rlm.setAnimationEnabled(true);   // 24 frames
  const mgr = rlm.getSelectedLayerManager()!;
  const base = mgr.getTexture()!;
  cpu(base).data.set(pattern(1));
  markRasterCompositeDirty(null, base);
  rlm.setLayerAnimated(id, true);   // cel 1 = the layer's own texture, held for all 24 frames
  return { gpu, rlm, id, mgr, base, tl: rlm.getTimeline() };
}

describe('A1 — splitting a hold: one texture per cel', () => {
  it('the rest of the hold gets its own copy; painting it leaves the original alone', () => {
    const { rlm, id, base, tl } = animatedDoc();
    const newId = rlm.addCelAtFrame(id, 5)!;
    const cels = tl.getCels(id);
    expect(cels.map(c => [c.startFrame, c.duration])).toEqual([[1, 4], [5, 1], [6, 19]]);
    const [c1, c5, rest] = cels;
    expect(c1.texture).toBe(base);
    expect(c5.id).toBe(newId);
    expect(rest.texture).not.toBe(base);
    expect(rest.texture).not.toBe(c5.texture);
    expect(same(cpu(rest.texture).data, pattern(1))).toBe(true);   // the held drawing, copied
    expect(cpu(c5.texture).data.every(v => v === 0)).toBe(true);   // the new cel is blank

    tl.setCurrentFrame(6);
    stroke(rlm.getLayerTexture(id)!, 200);
    expect(rlm.getLayerTexture(id)).toBe(rest.texture);
    expect(same(cpu(base).data, pattern(1))).toBe(true);           // frame 1 unchanged
  });

  it('deleting the leftover cel keeps the original (and its texture) intact', () => {
    const { rlm, id, base, tl } = animatedDoc();
    rlm.addCelAtFrame(id, 5);
    const rest = tl.getCels(id)[2];
    expect(rlm.deleteCel(id, rest.id)).toBe(true);
    expect(cpu(rest.texture).destroyed).toBe(true);
    expect(cpu(base).destroyed).toBe(false);
    expect(same(cpu(base).data, pattern(1))).toBe(true);
    tl.setCurrentFrame(1);
    expect(rlm.getLayerTexture(id)).toBe(base);
  });

  it('deleting cel 1 never destroys the layer\'s own texture (its undo / resize / export use it)', () => {
    const { rlm, id, base, tl } = animatedDoc();
    rlm.addCelAtFrame(id, 5);
    expect(rlm.deleteCel(id, tl.getCels(id)[0].id)).toBe(true);
    expect(cpu(base).destroyed).toBe(false);
  });

  it('static again: the first cel\'s drawing stays, in the layer\'s own (live) texture; the other cels are freed', () => {
    const { rlm, id, base, tl } = animatedDoc();
    rlm.addCelAtFrame(id, 5);
    const [, c5, rest] = tl.getCels(id);
    tl.setCurrentFrame(6);   // the layer shows the leftover cel when it goes static
    expect(rlm.setLayerAnimated(id, false)).toBe(true);
    expect(rlm.getLayerTexture(id)).toBe(base);
    expect(cpu(base).destroyed).toBe(false);
    expect(same(cpu(base).data, pattern(1))).toBe(true);
    expect(cpu(c5.texture).destroyed).toBe(true);
    expect(cpu(rest.texture).destroyed).toBe(true);
  });

  it('every destroy is safe when cels DO share a texture (defensive: no destroy while another cel shows it)', () => {
    const { rlm, id, tl, gpu } = animatedDoc();
    const shared = gpu.device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 0 } as GPUTextureDescriptor);
    tl.addCelWithId(id, 'a', 30, 1, 'key', shared);
    tl.addCelWithId(id, 'b', 31, 1, 'key', shared);
    rlm.deleteCel(id, 'a');
    expect(cpu(shared).destroyed).toBe(false);
    rlm.deleteCel(id, 'b');
    expect(cpu(shared).destroyed).toBe(true);
  });
});

describe('A2 — a loaded layer\'s undo seed is its loaded pixels', () => {
  it('load pixels → fill → undo brings the loaded pixels back (not blank), with no read-back', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    rlm.clearAllLayers();
    const reads0 = rasterSnapshotStats.readbacks;
    rlm.addLayerWithId('L1', 'Loaded');
    const loaded = pattern(7);
    expect(rlm.uploadPixelsToLayer('L1', loaded.slice().buffer)).toBe(true);
    await flush();
    expect(rasterSnapshotStats.readbacks).toBe(reads0);   // seeded from the bytes in hand

    rlm.selectLayer('L1');
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture('L1')!;
    fill(tex, 99);
    await mgr.pushSnapshot();
    expect(await rlm.undoForLayer('L1')).toBe(true);
    expect(same(cpu(tex).data, loaded)).toBe(true);
  });

  it('trimming folds into a borrowed seed without writing the caller\'s bytes', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    rlm.clearAllLayers();
    rlm.addLayerWithId('L1', 'Loaded');
    const bytes = pattern(3);
    const keep = bytes.slice();
    rlm.uploadPixelsToLayer('L1', bytes.buffer);
    rlm.selectLayer('L1');
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture('L1')!;
    for (let i = 0; i < 14; i++) await mgr.pushStrokePatch(tex, stroke(tex, 10 + i, i % 5, i % 4, 2, 2));
    expect(same(bytes, keep)).toBe(true);
  });
});

describe('B3 — blank seeds: no read-back, no full RAM copy', () => {
  it('a new document\'s layers and the Background\'s resize reseed read nothing back and hold no bytes', async () => {
    const gpu = createCpuDevice();
    const reads0 = rasterSnapshotStats.readbacks;
    const rlm = new RLM(gpu.device, W, H);   // seeds 'Background'
    const ink = rlm.addLayer('Ink').id;
    rlm.setSize(W * 2, H * 2);                // window size → document size
    await flush();
    expect(rasterSnapshotStats.readbacks).toBe(reads0);
    for (const id of [rlm.getLayers()[0].id, ink]) {
      rlm.selectLayer(id);
      const st = rlm.getSelectedLayerManager()!.getHistoryStats()!;
      expect(st.kinds).toEqual(['full']);
      expect(st.bytes).toBe(0);
    }
  });

  it('undo onto the blank seed still clears the layer (at the resized size)', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    rlm.setSize(W * 2, H * 2);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture(id)!;
    expect(tex.width).toBe(W * 2);
    await mgr.pushStrokePatch(tex, stroke(tex, 77));
    fill(tex, 5);
    await mgr.pushSnapshot({ noCoalesce: true });   // (right after a stroke: past the 40 ms coalescing)
    expect(await rlm.undoForLayer(id)).toBe(true);
    expect(await rlm.undoForLayer(id)).toBe(true);
    expect(rlm.getLayerTexture(id)!.width).toBe(W * 2);
    expect(cpu(rlm.getLayerTexture(id)).data.every(v => v === 0)).toBe(true);
    expect(await rlm.undoForLayer(id)).toBe(false);   // at the seed
    expect(await rlm.redoForLayer(id)).toBe(true);
    expect(cpu(rlm.getLayerTexture(id)).data.some(v => v === 77)).toBe(true);
  });

  it('a written layer is NOT assumed blank on resize (re-seeds by reading back)', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    const id = rlm.getLayers()[0].id;
    const tex = rlm.getLayerTexture(id)!;
    cpu(tex).data.set(pattern(2));
    markRasterCompositeDirty(null, tex);
    const reads0 = rasterSnapshotStats.readbacks;
    rlm.setSize(W * 2, H * 2);
    await flush();
    expect(rasterSnapshotStats.readbacks).toBe(reads0 + 1);
    rlm.selectLayer(id);
    expect(rlm.getSelectedLayerManager()!.getHistoryStats()!.bytes).toBe(W * 2 * H * 2 * 4);
  });

  it('trimming folds the oldest rect into a blank seed correctly', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture(id)!;
    const states: Uint8Array[] = [];
    for (let i = 0; i < 13; i++) {
      await mgr.pushStrokePatch(tex, stroke(tex, 20 + i, i % 6, i % 5, 2, 1));
      states.push(cpu(tex).data.slice());
    }
    const st = mgr.getHistoryStats()!;
    expect(st.kinds.length).toBe(10);
    expect(st.kinds[0]).toBe('full');
    for (let k = 0; k < 9; k++) expect(await rlm.undoForLayer(id)).toBe(true);
    expect(same(cpu(tex).data, states[3])).toBe(true);   // the oldest kept state (folded from blank + 4 strokes)
  });
});

describe('A3 — undo on cels acts on the active cel', () => {
  it('stroke on cel 2 + undo → cel 2 reverts, cel 1 untouched', async () => {
    const { rlm, id, mgr, base, tl } = animatedDoc();
    rlm.addCelAtFrame(id, 2);
    tl.setCurrentFrame(2);
    const cel2 = rlm.getLayerTexture(id)!;
    expect(cel2).not.toBe(base);
    const reads0 = rasterSnapshotStats.readbacks;
    await mgr.pushStrokePatch(cel2, stroke(cel2, 150));
    expect(rasterSnapshotStats.readbacks).toBe(reads0);   // a new cel's blank seed + a rect patch: no read-back
    expect(await rlm.undoForLayer(id)).toBe(true);
    expect(cpu(cel2).data.every(v => v === 0)).toBe(true);
    expect(same(cpu(base).data, pattern(1))).toBe(true);
    expect(await rlm.redoForLayer(id)).toBe(true);
    expect(cpu(cel2).data.some(v => v === 150)).toBe(true);

    // back on cel 1: its own history (the layer's), untouched by cel 2's
    tl.setCurrentFrame(1);
    await mgr.pushStrokePatch(base, stroke(base, 60));
    expect(await rlm.undoForLayer(id)).toBe(true);
    expect(same(cpu(base).data, pattern(1))).toBe(true);
    expect(cpu(cel2).data.some(v => v === 150)).toBe(true);
  });

  it('a fill (full snapshot) on the leftover of a split hold undoes onto the copied drawing (lazy read-back seed)', async () => {
    const { rlm, id, mgr, base, tl } = animatedDoc();
    rlm.addCelAtFrame(id, 5);
    tl.setCurrentFrame(10);   // the leftover (6..24): seeded by reading it back now
    const rest = rlm.getLayerTexture(id)!;
    expect(rest).not.toBe(base);
    fill(rest, 33);
    await mgr.pushSnapshot();
    expect(await rlm.undoForLayer(id)).toBe(true);
    expect(same(cpu(rest).data, pattern(1))).toBe(true);
    expect(same(cpu(base).data, pattern(1))).toBe(true);
  });

  it('a blank frame has nothing to undo (the base texture is not touched)', async () => {
    const { rlm, id, mgr, base, tl } = animatedDoc();
    await mgr.pushStrokePatch(base, stroke(base, 61));
    tl.setCelDuration(id, tl.getCels(id)[0].id, 1);   // frames 2+ are blank
    tl.setCurrentFrame(3);
    expect(rlm.getLayerTexture(id)).toBeNull();
    expect(await rlm.undoForLayer(id)).toBe(false);
    expect(cpu(base).data.some(v => v === 61)).toBe(true);
  });

  it('after a reload: the base texture survives, and cel 2 undo reverts cel 2 to its loaded pixels', async () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    // the restore sequence of DocumentStateCoordinator.restore
    rlm.clearAllLayers();
    rlm.addLayerWithId('L', 'Anim');
    rlm.uploadPixelsToLayer('L', pattern(9).buffer);   // the layer-level pixels the save wrote (the shown cel)
    rlm.selectLayer('L');
    rlm.setAnimationEnabled(true);
    rlm.setLayerAnimated('L', true);
    rlm.restoreLayerCels('L', [
      { celId: 'c1', startFrame: 1, duration: 1, celType: 'key' },
      { celId: 'c2', startFrame: 2, duration: 3, celType: 'inbetween' },
    ]);
    const a = pattern(4), b = pattern(5);
    const reads0 = rasterSnapshotStats.readbacks;
    expect(rlm.uploadPixelsToCel('L', 'c1', a.buffer)).toBe(true);
    expect(rlm.uploadPixelsToCel('L', 'c2', b.buffer)).toBe(true);
    rlm.forceFrameSync();
    await flush();
    expect(rasterSnapshotStats.readbacks).toBe(reads0);

    const mgr = rlm.getSelectedLayerManager()!;
    const base = mgr.getTexture()!;
    expect(cpu(base).destroyed).toBe(false);
    const tl = rlm.getTimeline();
    const [c1, c2] = tl.getCels('L');
    expect(c1.texture).toBe(base);   // cel 1 shows the layer's own texture again
    expect(same(cpu(c1.texture).data, a)).toBe(true);

    tl.setCurrentFrame(3);
    expect(rlm.getLayerTexture('L')).toBe(c2.texture);
    await mgr.pushStrokePatch(c2.texture, stroke(c2.texture, 222));
    fill(c2.texture, 44);
    await mgr.pushSnapshot({ noCoalesce: true });
    expect(await rlm.undoForLayer('L')).toBe(true);
    expect(await rlm.undoForLayer('L')).toBe(true);
    expect(same(cpu(c2.texture).data, b)).toBe(true);
    expect(same(cpu(c1.texture).data, a)).toBe(true);
    expect(await rlm.undoForLayer('L')).toBe(false);

    // cel 1 after reload: fill → undo → its loaded pixels
    tl.setCurrentFrame(1);
    fill(base, 12);
    await mgr.pushSnapshot();
    expect(await rlm.undoForLayer('L')).toBe(true);
    expect(same(cpu(base).data, a)).toBe(true);
  });
});

describe('A4 — exact cel restore for host imports (restoreCelsWithPixels)', () => {
  it('ids, start frames, holds, types and each cel\'s own pixels come back; no texture shared; timeline grows', () => {
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    rlm.setAnimationEnabled(true);
    const a = pattern(11), c = pattern(12);
    const ids = rlm.restoreCelsWithPixels(id, [
      { celId: 'k1', startFrame: 1, duration: 3, celType: 'key', pixels: a.buffer },
      { celId: 'b2', startFrame: 4, duration: 1, celType: 'inbetween' },
      { celId: 'k3', startFrame: 20, duration: 10, celType: 'key', pixels: c.buffer },
    ]);
    expect(ids).toEqual(['k1', 'b2', 'k3']);
    expect(rlm.isLayerAnimated(id)).toBe(true);
    const cels = rlm.getTimeline().getCels(id);
    expect(cels.map(x => [x.id, x.startFrame, x.duration, x.celType])).toEqual([
      ['k1', 1, 3, 'key'], ['b2', 4, 1, 'inbetween'], ['k3', 20, 10, 'key'],
    ]);
    expect(new Set(cels.map(x => x.texture)).size).toBe(3);
    expect(same(cpu(cels[0].texture).data, a)).toBe(true);
    expect(cpu(cels[1].texture).data.every(v => v === 0)).toBe(true);
    expect(same(cpu(cels[2].texture).data, c)).toBe(true);
    expect(rlm.getTimeline().getFrameCount()).toBe(29);
    expect(rlm.getLayerTexture(id)).toBe(cels[0].texture);   // frame 1 shown
  });
});
