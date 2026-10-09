/**
 * The composition list RasterLayerManager hands the renderer (perf E8 / E5, 2026-10-09): the SAME array and entry
 * objects are refilled on every notification (they were rebuilt with filter + map on every timeline frame change), the
 * content is always current (a frame change swaps the animated layer's texture in place), and each entry says whether
 * its layer is animated (the renderer's per-cel dither cache). getTextureForComposition() still returns fresh copies.
 *
 * Runs the real RasterLayerManager on the CPU mirror device.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createCpuDevice, installGpuGlobals } from '../renderer/raster/cpu-gpu-mirror';
import { RasterLayerManager, type RasterCompositionItem } from './raster-layer-manager';

beforeAll(() => installGpuGlobals());

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };

describe('composition list for the renderer', () => {
  it('is one reused array of reused entries, always current, with the animated flag', async () => {
    const gpu = createCpuDevice();
    const lists: RasterCompositionItem[][] = [];
    const rlm = new RasterLayerManager(gpu.device, 16, 12, (list) => lists.push(list));
    const { id } = rlm.addLayer('Anim');
    await flush();
    rlm.setAnimationEnabled(true);
    expect(rlm.setLayerAnimated(id, true)).toBe(true);
    rlm.addCelAtFrame(id, 5);
    rlm.getTimeline().setCurrentFrame(2);
    await flush();
    const first = lists[lists.length - 1];
    const entry = first.find(e => e.id === id)!;
    expect(entry.animated).toBe(true);
    expect(first.find(e => e.id !== id)?.animated).toBe(false);
    const texAt2 = entry.texture;
    rlm.getTimeline().setCurrentFrame(5);   // another cel (blank: no texture)
    await flush();
    const now = lists[lists.length - 1];
    expect(now).toBe(first);                                // the same array…
    expect(now.find(e => e.id === id)).toBe(entry);         // …and the same entry object, refilled
    expect(entry.texture).not.toBe(texAt2);
    rlm.getTimeline().setCurrentFrame(2);
    await flush();
    expect(entry.texture).toBe(texAt2);
    // the public getter is a snapshot
    const snap = rlm.getTextureForComposition();
    expect(snap).not.toBe(first);
    expect(snap.find(e => e.id === id)?.animated).toBe(true);
    rlm.setLayerAnimated(id, false);
    await flush();
    expect(lists[lists.length - 1].find(e => e.id === id)?.animated).toBe(false);
  });
});
