/**
 * BRUSH-5 (docs/specs/mobile-parity.md §3): the INCREMENTAL layer composite — a persistent composited result,
 * re-composited only when a layer changed and only over its dirty rect — must be pixel-identical to the full
 * composite after every step, do nothing at all when nothing changed, and do bounded work per stroke frame.
 *
 * Everything runs the REAL code on the CPU mirror (cpu-gpu-mirror.ts, with CPU ports of the compositor shaders):
 * RasterCompositor (legacy composite() as the reference, compositeIncremental() under test), RasterPaintEngine /
 * BrushStampPipeline for strokes and the predicted tail, RasterSnapshotManager for undo / redo, and the dirty-rect
 * log (raster-composite-dirty.ts) that the writers report to.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import { RasterCompositor, LayerBlendMode, type CompositorLayerInfo } from './raster-compositor';
import { RasterPaintEngine, createDefaultPresets } from './raster-paint-engine';
import { RasterSnapshotManager } from './raster-snapshot-manager';
import { CanvasGrainManager, type CanvasGrainType } from '../canvas-grain';
import { bumpGpuPixelEpoch } from '../gpu-pixel-epoch';
import {
  markRasterCompositeDirty, markRasterCompositeDirtyXYWH, onRasterCompositeDirty, RasterDirtyCursor, rasterDirtyStats,
} from './raster-composite-dirty';
import type { BrushPreset } from '../brushes/brush-preset';
import type { PointerInput } from '../brushes/brush-engine';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Layer {
  tex: CpuTexture; snap: RasterSnapshotManager;
  visible: boolean; opacity: number; blendMode: LayerBlendMode; clipped: boolean;
}

/** A document: layers, the paint engine, the paper grain, and two compositors — the incremental one under test
 *  (its output persists) and a reference that composites everything from scratch into a fresh texture. */
async function makeWorld(seed: number, W: number, H: number, layerCount: number) {
  const r = rng(seed);
  const gpu = createCpuDevice();
  const device = gpu.device;
  const grain = new CanvasGrainManager(device);
  const inc = new RasterCompositor(device);
  const ref = new RasterCompositor(device);
  inc.setGrainManager(grain);
  ref.setGrainManager(grain);
  const engine = new RasterPaintEngine(device, () => {});
  const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
  engine.registerPreset({ ...soft, id: 'test_multiply', blending: { ...soft.blending, mode: 'multiply' } } as BrushPreset);
  engine.registerPreset({ ...soft, id: 'test_small', minSize: 2, maxSize: 14 } as BrushPreset);

  const newLayer = async (fill: boolean): Promise<Layer> => {
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    if (fill) {
      // blobs of colour with soft and hard alpha, and plenty of fully transparent texels
      const n = 3 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const cx = r() * W, cy = r() * H, rad = 6 + r() * Math.min(W, H) * 0.4;
        const col = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
        const hard = r() < 0.4, amax = 0.3 + r() * 0.7;
        for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(H, cy + rad); y++) {
          for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(W, cx + rad); x++) {
            const d = Math.hypot(x - cx, y - cy) / rad;
            if (d > 1) continue;
            const o = (y * W + x) * 4;
            tex.data[o] = col[0]; tex.data[o + 1] = col[1]; tex.data[o + 2] = col[2];
            tex.data[o + 3] = Math.round(255 * amax * (hard ? 1 : 1 - d));
          }
        }
      }
    }
    const snap = new RasterSnapshotManager(device, 6);
    await snap.initialize(asGpu(tex));
    return { tex, snap, visible: true, opacity: 1, blendMode: LayerBlendMode.Normal, clipped: false };
  };
  const layers: Layer[] = [];
  for (let i = 0; i < layerCount; i++) layers.push(await newLayer(true));

  const world = {
    r, gpu, device, grain, inc, ref, engine, layers, newLayer, W, H,
    out: gpu.mkTex(W, H, 'rgba8unorm'),
    kinds: { skip: 0, rect: 0, full: 0 } as Record<string, number>,
    steps: 0,
    list(): CompositorLayerInfo[] {
      return layers.map(l => ({
        texture: asGpu(l.tex), blendMode: l.blendMode, opacity: l.opacity, clipped: l.clipped, visible: l.visible,
      }));
    },
    /** One frame: the incremental composite, then compare with a from-scratch composite. Returns what it did. */
    frame(label: string): string {
      const kind = inc.compositeIncremental(world.list(), asGpu(world.out), 'main');
      const fresh = gpu.mkTex(W, H, 'rgba8unorm');
      ref.composite(world.list(), asGpu(fresh));
      world.kinds[kind]++;
      world.steps++;
      if (!same(world.out.data, fresh.data)) {
        let n = 0, first = -1;
        for (let i = 0; i < fresh.data.length; i += 4) {
          if (world.out.data[i] !== fresh.data[i] || world.out.data[i + 1] !== fresh.data[i + 1] ||
              world.out.data[i + 2] !== fresh.data[i + 2] || world.out.data[i + 3] !== fresh.data[i + 3]) {
            if (first < 0) first = i >> 2;
            n++;
          }
        }
        throw new Error(`stale composite after "${label}" (step ${world.steps}, ${kind}): ${n} texels differ, first at ` +
          `(${first % W}, ${Math.floor(first / W)})`);
      }
      return kind;
    },
  };
  return world;
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const GRAINS: CanvasGrainType[] = ['none', 'cold-press', 'canvas-linen', 'rough'];
const BLENDS = [
  LayerBlendMode.Normal, LayerBlendMode.Multiply, LayerBlendMode.Screen, LayerBlendMode.Overlay, LayerBlendMode.SoftLight,
  LayerBlendMode.HardLight, LayerBlendMode.ColorDodge, LayerBlendMode.ColorBurn, LayerBlendMode.Darken,
  LayerBlendMode.Lighten, LayerBlendMode.Add, LayerBlendMode.Difference,
];

/** A brush stroke on `layer`: every frame's dabs, optionally with a predicted tail shown and taken back, then the
 *  undo patch pushed on the layer's stack. A composite + compare after EVERY write. */
async function stroke(w: World, layer: Layer, opts: { preset: string; erase?: number | null; predict: boolean; frames: number }) {
  const { r, engine, W, H } = w;
  expect(engine.setActivePreset(opts.preset)).toBe(true);
  engine.setEraseMode(opts.erase ?? null);
  engine.setBrushColor(r(), r(), r(), 0.3 + r() * 0.7);
  engine.setActiveTexture(asGpu(layer.tex));
  let x = r() * W, y = r() * H, t = 1000;
  let vx = (r() - 0.5) * 24, vy = (r() - 0.5) * 24;
  const next = (): PointerInput => {
    vx += (r() - 0.5) * 10; vy += (r() - 0.5) * 10;
    x += vx; y += vy; t += 8;            // (may leave the canvas: off-canvas dabs)
    return { x, y, pressure: 0.3 + r() * 0.7, timestamp: t };
  };
  engine.beginStroke({ x, y, pressure: 0.8, timestamp: t }, { pointerType: 'touch' });
  w.frame('stroke begin');
  for (let f = 0; f < opts.frames; f++) {
    engine.addStrokePoints([next(), next(), next()]);
    w.frame('stroke frame');
    if (opts.predict) {
      const tail = [1, 2, 3].map(k => ({ x: x + vx * k * 0.9, y: y + vy * k * 0.9, pressure: 0.7, timestamp: t + k * 8 }));
      engine.drawProvisionalStroke(tail);
      w.frame('predicted tail shown');
      engine.clearProvisionalStroke();
      w.frame('predicted tail taken back');
    }
  }
  const patch = await engine.endStroke(next(), { pushSnapshot: false });
  w.frame('stroke end');
  if (patch) await layer.snap.pushPatch(asGpu(layer.tex), patch);
  else await layer.snap.pushSnapshot(asGpu(layer.tex));
  w.frame('undo patch pushed');
}

/** One random document operation, with a composite + compare after it. */
async function randomOp(w: World): Promise<string> {
  const { r, layers, W, H, device } = w;
  const pick = () => layers[Math.floor(r() * layers.length)];
  const op = Math.floor(r() * 20);
  switch (op) {
    case 0: case 1: case 2: {
      const presets = ['default_round_soft', 'default_hard_pen', 'test_small', 'test_multiply', 'default_monoweight_liner'];
      await stroke(w, pick(), { preset: presets[Math.floor(r() * presets.length)], predict: r() < 0.6, frames: 1 + Math.floor(r() * 3) });
      return 'stroke';
    }
    case 3: {
      const erasePreset = r() < 0.5;
      await stroke(w, pick(), { preset: erasePreset ? 'default_eraser' : 'test_small', erase: erasePreset ? null : 1 + Math.floor(r() * 3), predict: r() < 0.6, frames: 1 + Math.floor(r() * 2) });
      return 'eraser';
    }
    case 4: {   // fill tool: writes anywhere, reports the whole canvas
      const l = pick();
      const fw = 1 + Math.floor(r() * W), fh = 1 + Math.floor(r() * H), fx = Math.floor(r() * (W - fw + 1)), fy = Math.floor(r() * (H - fh + 1));
      const px = new Uint8Array(fw * fh * 4);
      const c = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
      for (let i = 0; i < px.length; i += 4) px.set(c, i);
      device.queue.writeTexture({ texture: asGpu(l.tex), origin: { x: fx, y: fy } }, px, { bytesPerRow: fw * 4 }, { width: fw, height: fh });
      markRasterCompositeDirty();
      w.frame('fill');
      await l.snap.pushSnapshot(asGpu(l.tex));
      w.frame('fill snapshot');
      return 'fill';
    }
    case 5: {   // paste / patch upload: a rect write reported as that rect
      const l = pick();
      const fw = 1 + Math.floor(r() * 40), fh = 1 + Math.floor(r() * 40), fx = Math.floor(r() * (W - fw + 1)), fy = Math.floor(r() * (H - fh + 1));
      const px = new Uint8Array(fw * fh * 4);
      for (let i = 0; i < px.length; i++) px[i] = Math.floor(r() * 256);
      device.queue.writeTexture({ texture: asGpu(l.tex), origin: { x: fx, y: fy } }, px, { bytesPerRow: fw * 4 }, { width: fw, height: fh });
      markRasterCompositeDirtyXYWH(fx, fy, fw, fh);
      w.frame('rect upload');
      return 'paste';
    }
    case 6: {   // a tool that only pushes its undo snapshot (the safety net): transform commit, text stamp, ...
      const l = pick();
      const px = new Uint8Array(W * 4);
      for (let i = 0; i < px.length; i++) px[i] = Math.floor(r() * 256);
      device.queue.writeTexture({ texture: asGpu(l.tex), origin: { x: 0, y: Math.floor(r() * H) } }, px, { bytesPerRow: W * 4 }, { width: W, height: 1 });
      await l.snap.pushSnapshot(asGpu(l.tex));
      w.frame('tool snapshot');
      return 'tool';
    }
    case 7: {   // a direct upload that bumps the GPU pixel epoch (document restore, merge down, image import, ...)
      const l = pick();
      for (let i = 0; i < l.tex.data.length; i += 4) {
        if (r() < 0.5) { l.tex.data[i + 3] = 0; continue; }
        l.tex.data[i] = Math.floor(r() * 256); l.tex.data[i + 1] = Math.floor(r() * 256); l.tex.data[i + 2] = 90; l.tex.data[i + 3] = Math.floor(r() * 256);
      }
      bumpGpuPixelEpoch();
      w.frame('upload');
      return 'upload';
    }
    case 8: case 9: { const l = pick(); await l.snap.undo(asGpu(l.tex)); w.frame('undo'); return 'undo'; }
    case 10: { const l = pick(); await l.snap.redo(asGpu(l.tex)); w.frame('redo'); return 'redo'; }
    case 11: { const l = pick(); l.visible = !l.visible; w.frame('visibility'); return 'visibility'; }
    case 12: {
      const i = Math.floor(r() * layers.length), j = Math.floor(r() * layers.length);
      [layers[i], layers[j]] = [layers[j], layers[i]];
      w.frame('reorder');
      return 'reorder';
    }
    case 13: {   // opacity — the BASE layer below 1 half of the time
      const l = r() < 0.5 ? (layers.find(x => x.visible) ?? pick()) : pick();
      l.opacity = r() < 0.3 ? 1 : Math.round(r() * 100) / 100;
      w.frame('opacity');
      return 'opacity';
    }
    case 14: { pick().blendMode = BLENDS[Math.floor(r() * BLENDS.length)]; w.frame('blend mode'); return 'blend'; }
    case 15: { const l = pick(); l.clipped = !l.clipped; w.frame('clipping'); return 'clip'; }
    case 16: {
      w.grain.setGrain({ type: GRAINS[Math.floor(r() * GRAINS.length)], scale: 0.5 + r() * 2, strength: r() < 0.2 ? 0 : r() });
      w.frame('paper grain');
      return 'grain';
    }
    case 17: {
      if (layers.length > 1 && r() < 0.5) { layers.splice(Math.floor(r() * layers.length), 1); w.frame('layer removed'); return 'remove'; }
      layers.splice(Math.floor(r() * (layers.length + 1)), 0, await w.newLayer(r() < 0.7));
      w.frame('layer added');
      return 'add';
    }
    case 18: {   // document resize / device recovery: a new output texture
      w.out = w.gpu.mkTex(W, H, 'rgba8unorm');
      w.frame('new output texture');
      return 'output';
    }
    default: { w.frame('idle'); return 'idle'; }
  }
}

describe('incremental layer composite == full composite, after every step', () => {
  for (const seed of [11, 23, 37, 58, 91, 144]) {
    it(`random operations (seed ${seed})`, async () => {
      const w = await makeWorld(seed, 112, 80, 3);
      w.frame('first');
      const seen = new Set<string>();
      for (let i = 0; i < 70; i++) {
        seen.add(await randomOp(w));
        if (w.r() < 0.35) expect(w.frame('idle frame')).toBe('skip');   // nothing changed since the last frame
      }
      // the incremental paths really ran (not everything fell back to a full composite)
      expect(w.kinds.rect).toBeGreaterThan(20);
      expect(w.kinds.skip).toBeGreaterThan(10);
      expect(w.kinds.full).toBeGreaterThan(5);
      expect(seen.size).toBeGreaterThan(12);
    }, 60000);
  }

  it('every blend mode × opacity × clipping, with paper grain and a translucent base, over stroke rects', async () => {
    const w = await makeWorld(5, 96, 72, 3);
    w.grain.setGrain({ type: 'cold-press', scale: 1.3, strength: 0.7 });
    w.layers[0].opacity = 0.6;
    w.frame('first');
    for (const mode of BLENDS) {
      for (const [opacity, clipped] of [[1, false], [0.45, false], [0.8, true]] as Array<[number, boolean]>) {
        w.layers[1].blendMode = mode; w.layers[1].opacity = opacity; w.layers[1].clipped = clipped;
        w.layers[2].blendMode = BLENDS[(mode + 5) % BLENDS.length];
        expect(w.frame('metadata')).toBe('full');
        const before = w.kinds.rect;
        await stroke(w, w.layers[1 + (mode % 2)], { preset: 'test_small', predict: true, frames: 2 });
        expect(w.kinds.rect).toBeGreaterThan(before);
      }
    }
  }, 60000);

  it('no visible layers, a single layer, and the paper showing through an empty canvas', async () => {
    const w = await makeWorld(8, 64, 48, 2);
    w.grain.setGrain({ type: 'rough', scale: 1, strength: 0.8 });
    w.layers[0].visible = false; w.layers[1].visible = false;
    expect(w.frame('nothing visible')).toBe('full');
    expect(w.frame('idle')).toBe('skip');
    markRasterCompositeDirty({ x0: 10, y0: 10, x1: 30, y1: 20 });
    expect(w.frame('dirty under no layers')).toBe('rect');
    w.layers[1].visible = true; w.layers[1].opacity = 0.5;
    expect(w.frame('single translucent layer')).toBe('full');
    await stroke(w, w.layers[1], { preset: 'default_round_soft', predict: true, frames: 2 });
    w.grain.setGrain({ type: 'none', scale: 1, strength: 0 });
    expect(w.frame('grain off')).toBe('full');
    await stroke(w, w.layers[1], { preset: 'default_hard_pen', predict: false, frames: 2 });
  });

  it('a dirty rect off the canvas, or a degenerate one, composites nothing; a NaN rect composites everything', async () => {
    const w = await makeWorld(3, 64, 48, 2);
    w.frame('first');
    markRasterCompositeDirty({ x0: 200, y0: 5, x1: 260, y1: 9 });
    expect(w.frame('off canvas (right)')).toBe('skip');
    markRasterCompositeDirty({ x0: -50, y0: -50, x1: -1, y1: -1 });
    expect(w.frame('off canvas (top-left)')).toBe('skip');
    markRasterCompositeDirty({ x0: 5, y0: 5, x1: 5, y1: 9 });
    expect(w.frame('empty rect')).toBe('skip');
    markRasterCompositeDirty({ x0: NaN, y0: 0, x1: 4, y1: 4 });
    expect(w.frame('NaN rect')).toBe('full');
    markRasterCompositeDirty({ x0: 60.2, y0: 44.7, x1: 900, y1: 900 });   // fractional + clipped
    expect(w.frame('fractional rect')).toBe('rect');
  });

  it('an invalidated output (composited some other way) is fully re-composited next time', async () => {
    const w = await makeWorld(4, 64, 48, 3);
    w.frame('first');
    expect(w.frame('idle')).toBe('skip');
    // something else drew into the output (the onion skin; the async composite; the legacy path while switched off)
    w.out.data.fill(200);
    w.inc.invalidateIncremental('main');
    expect(w.frame('after invalidate')).toBe('full');
    expect(w.frame('idle')).toBe('skip');
    w.out.data.fill(90);
    w.inc.invalidateIncremental();
    expect(w.frame('after invalidate-all')).toBe('full');
  });

  it('a displacement animation (frame-linked) always takes the full legacy composite — never the incremental one', async () => {
    const w = await makeWorld(6, 64, 48, 2);
    const list = () => w.list().map((l, i) => i === 1
      ? { ...l, frameLinkAnimation: { enabled: true, type: 'wave', amplitude: 0, frequency: 3, speed: 0.1 } as never }
      : l);
    const fresh = () => w.gpu.mkTex(64, 48, 'rgba8unorm');
    for (let i = 0; i < 3; i++) {
      expect(w.inc.compositeIncremental(list(), asGpu(w.out), 'main')).toBe('full');   // even with nothing dirty
      const f = fresh();
      w.ref.composite(list(), asGpu(f));
      expect(same(w.out.data, f.data)).toBe(true);
    }
    expect(w.frame('animation gone')).toBe('full');
    expect(w.frame('idle')).toBe('skip');
  });

  it('the main and the foreground composite each see every write (one log, a cursor per output)', async () => {
    const w = await makeWorld(12, 64, 48, 4);
    const fgOut = w.gpu.mkTex(64, 48, 'rgba8unorm');
    const fgList = () => w.list().slice(2);
    const both = (label: string) => {
      const kind = w.frame(label);
      const fgKind = w.inc.compositeIncremental(fgList(), asGpu(fgOut), 'fg');
      const f = w.gpu.mkTex(64, 48, 'rgba8unorm');
      w.ref.composite(fgList(), asGpu(f));
      expect(same(fgOut.data, f.data)).toBe(true);
      return [kind, fgKind];
    };
    expect(both('first')).toEqual(['full', 'full']);
    expect(both('idle')).toEqual(['skip', 'skip']);
    w.engine.setActivePreset('test_small');
    w.engine.setActiveTexture(asGpu(w.layers[3].tex));
    w.engine.beginStroke({ x: 20, y: 20, pressure: 0.8, timestamp: 1000 });
    w.engine.addStrokePoints([{ x: 30, y: 26, pressure: 0.8, timestamp: 1008 }, { x: 40, y: 30, pressure: 0.8, timestamp: 1016 }]);
    expect(both('stroke frame')).toEqual(['rect', 'rect']);
    await w.engine.endStroke({ x: 44, y: 31, pressure: 0.8, timestamp: 1024 }, { pushSnapshot: false });
    both('stroke end');
    // the foreground is not composited for a while (hidden): it catches up on its own
    markRasterCompositeDirty({ x0: 2, y0: 2, x1: 9, y1: 9 });
    w.layers[2].tex.data.fill(128, 0, 64 * 12 * 4);
    markRasterCompositeDirty({ x0: 0, y0: 0, x1: 64, y1: 12 });
    expect(w.frame('main only')).toBe('rect');
    expect(w.frame('main idle')).toBe('skip');
    expect(both('fg catches up')).toEqual(['skip', 'rect']);
  });
});

describe('no work when idle, bounded work per stroke frame', () => {
  it('idle frames: zero submits, copies and dispatches', async () => {
    const w = await makeWorld(21, 96, 72, 3);
    w.grain.setGrain({ type: 'cold-press', scale: 1, strength: 0.6 });
    w.layers[0].opacity = 0.7;
    w.frame('first');
    const s0 = { ...w.inc.stats };
    for (let i = 0; i < 20; i++) expect(w.inc.compositeIncremental(w.list(), asGpu(w.out), 'main')).toBe('skip');
    expect(w.inc.stats.submits).toBe(s0.submits);
    expect(w.inc.stats.copies).toBe(s0.copies);
    expect(w.inc.stats.dispatches).toBe(s0.dispatches);
    expect(w.inc.stats.bytes).toBe(s0.bytes);
    expect(w.inc.stats.skip).toBe(s0.skip + 20);
    // the full composite, for comparison, does all of it again every frame
    const r0 = { ...w.ref.stats };
    w.ref.composite(w.list(), asGpu(w.gpu.mkTex(96, 72, 'rgba8unorm')));
    expect(w.ref.stats.bytes - r0.bytes).toBeGreaterThan(96 * 72 * 4 * 10);
  });

  it('a stroke frame composites only the dab rect: every pass is bounded by it', async () => {
    const W = 512, H = 384;
    const w = await makeWorld(31, W, H, 3);
    w.grain.setGrain({ type: 'cold-press', scale: 1, strength: 0.6 });
    w.layers[0].opacity = 0.8;
    w.frame('first');
    w.engine.setActivePreset('test_small');
    w.engine.setBrushColor(0.9, 0.2, 0.1, 1);
    w.engine.setActiveTexture(asGpu(w.layers[2].tex));
    const cursor = new RasterDirtyCursor();
    w.engine.beginStroke({ x: 200, y: 200, pressure: 0.8, timestamp: 1000 }, { pointerType: 'touch' });
    w.frame('stroke begin');
    cursor.take();
    const fullBytes = (() => { const b = w.ref.stats.bytes; w.ref.composite(w.list(), asGpu(w.gpu.mkTex(W, H, 'rgba8unorm'))); return w.ref.stats.bytes - b; })();
    let worst = 0;
    for (let f = 0; f < 5; f++) {
      const s0 = { ...w.inc.stats };
      w.engine.addStrokePoints([1, 2, 3].map(k => ({ x: 200 + (f * 3 + k) * 6, y: 200 + Math.sin((f * 3 + k) / 2) * 10, pressure: 0.8, timestamp: 1000 + (f * 3 + k) * 8 })));
      const rect = cursor.take() as { x0: number; y0: number; x1: number; y1: number };
      expect(rect && typeof rect === 'object').toBe(true);
      const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
      expect(area).toBeLessThan(W * H * 0.03);                         // a few dabs of a 14 px brush
      expect(w.frame('stroke frame')).toBe('rect');
      const d = w.inc.stats;
      // base copy + base opacity + 2 blend steps + grain: 5 copies and 4 dispatches of exactly the rect
      expect(d.copies - s0.copies).toBe(5);
      expect(d.dispatches - s0.dispatches).toBe(4);
      expect(d.copyTexels - s0.copyTexels).toBe(5 * area);
      expect(d.dispatchTexels - s0.dispatchTexels).toBe(4 * area);
      expect(d.submits - s0.submits).toBe(5);
      worst = Math.max(worst, d.bytes - s0.bytes);
    }
    expect(worst).toBeLessThan(fullBytes * 0.03);
    await w.engine.endStroke({ x: 300, y: 200, pressure: 0.8, timestamp: 1200 }, { pushSnapshot: false });
    w.frame('stroke end');
    expect(w.frame('idle')).toBe('skip');
  }, 60000);
});

describe('writers report what they wrote (raster-composite-dirty)', () => {
  const diffBox = (a: Uint8Array, b: Uint8Array, W: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      const x = (i >> 2) % W, y = Math.floor((i >> 2) / W);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  };
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const covers = (r: Box | 'full' | null, d: Box | null) =>
    d === null || r === 'full' || (r !== null && r.x0 <= d.x0 && r.y0 <= d.y0 && r.x1 >= d.x1 && r.y1 >= d.y1);

  it('the brush pipeline: every texel a stroke frame, the predicted tail or its take-back changes is inside the reported rect', async () => {
    for (const [preset, erase] of [['default_round_soft', null], ['default_hard_pen', null], ['test_multiply', null], ['default_eraser', null], ['test_small', 3]] as Array<[string, number | null]>) {
      const w = await makeWorld(77, 160, 120, 1);
      const tex = w.layers[0].tex;
      const cursor = new RasterDirtyCursor();
      let prev = tex.data.slice();
      const step = (label: string, expectWrite: boolean) => {
        const d = diffBox(prev, tex.data, 160);
        const r = cursor.take();
        if (!covers(r, d)) throw new Error(`${preset} ${label}: wrote ${JSON.stringify(d)} but reported ${JSON.stringify(r)}`);
        if (expectWrite) expect(d).not.toBeNull();
        if (r && r !== 'full') expect((r.x1 - r.x0) * (r.y1 - r.y0)).toBeLessThan(160 * 120 * 0.6);   // a rect, never "everything"
        prev = tex.data.slice();
      };
      expect(w.engine.setActivePreset(preset)).toBe(true);
      w.engine.setEraseMode(erase);
      w.engine.setBrushColor(0.1, 0.5, 0.9, 1);
      w.engine.setActiveTexture(asGpu(tex));
      const pt = (i: number): PointerInput => ({ x: 30 + i * 6, y: 60 + Math.sin(i / 2) * 20, pressure: 0.9, timestamp: 1000 + i * 8 });
      w.engine.beginStroke(pt(0), { pointerType: 'touch' });
      step('begin', false);
      for (let f = 0; f < 4; f++) {
        w.engine.addStrokePoints([1, 2, 3].map(k => pt(f * 3 + k)));
        step('frame', false);
        expect(w.engine.drawProvisionalStroke([1, 2].map(k => { const p = pt(f * 3 + 3 + k); return { ...p, y: p.y - 6 * k }; }))).toBe(true);
        step('tail', false);
        expect(w.engine.clearProvisionalStroke()).toBe(true);
        step('take-back', false);
      }
      await w.engine.endStroke(pt(14), { pushSnapshot: false });
      step('end', false);
      expect(same(tex.data, w.layers[0].tex.data)).toBe(true);
    }
  });

  it('undo / redo of a stroke report its rect; a full restore and a snapshot push report the canvas; a patch push reports nothing', async () => {
    const w = await makeWorld(9, 128, 96, 1);
    const l = w.layers[0];
    w.engine.setActivePreset('test_small');
    w.engine.setActiveTexture(asGpu(l.tex));
    w.engine.beginStroke({ x: 40, y: 40, pressure: 0.8, timestamp: 1000 });
    w.engine.addStrokePoints([{ x: 52, y: 44, pressure: 0.8, timestamp: 1008 }, { x: 64, y: 50, pressure: 0.8, timestamp: 1016 }]);
    const patch = (await w.engine.endStroke({ x: 66, y: 51, pressure: 0.8, timestamp: 1024 }, { pushSnapshot: false }))!;
    const cursor = new RasterDirtyCursor();
    await l.snap.pushPatch(asGpu(l.tex), patch);
    expect(cursor.take()).toBeNull();                                   // the pipeline reported the stroke already
    const rect = { x0: patch.x, y0: patch.y, x1: patch.x + patch.rw, y1: patch.y + patch.rh };
    expect(await l.snap.undo(asGpu(l.tex))).toBe(true);
    expect(cursor.take()).toEqual(rect);
    expect(await l.snap.redo(asGpu(l.tex))).toBe(true);
    expect(cursor.take()).toEqual(rect);
    l.tex.data.fill(40);
    await new Promise(res => setTimeout(res, 60));                       // (past the snapshot coalescing window)
    await l.snap.pushSnapshot(asGpu(l.tex));
    expect(cursor.take()).toBe('full');
    expect(await l.snap.undo(asGpu(l.tex))).toBe(true);                  // leaving a FULL entry: whole-texture restore
    expect(cursor.take()).toBe('full');
    await l.snap.pushSnapshot(asGpu(l.tex), { x: 3, y: 4, w: 10, h: 6 });
    expect(cursor.take()).toEqual({ x0: 3, y0: 4, x1: 13, y1: 10 });
    bumpGpuPixelEpoch();
    expect(cursor.take()).toBe('full');
    bumpGpuPixelEpoch('none');
    expect(cursor.take()).toBeNull();
    bumpGpuPixelEpoch({ x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(cursor.take()).toEqual({ x0: 1, y0: 2, x1: 3, y1: 4 });
  });

  it('the log: union of rects, a cursor per consumer, overflow → everything, a listener per report', () => {
    const a = new RasterDirtyCursor(), b = new RasterDirtyCursor();
    expect(a.take()).toBeNull();
    const calls: number[] = [];
    const off = onRasterCompositeDirty(() => calls.push(1));
    const marks0 = rasterDirtyStats.marks;
    markRasterCompositeDirty({ x0: 10, y0: 20, x1: 30, y1: 40 });
    markRasterCompositeDirty({ x0: 25.5, y0: 5.2, x1: 50.1, y1: 22 });
    markRasterCompositeDirty({ x0: 7, y0: 7, x1: 7, y1: 9 });           // empty: ignored
    expect(rasterDirtyStats.marks - marks0).toBe(2);
    expect(calls.length).toBe(2);
    expect(a.take()).toEqual({ x0: 10, y0: 5, x1: 51, y1: 40 });        // rounded outward
    expect(a.take()).toBeNull();
    markRasterCompositeDirty({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(a.take()).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(b.take()).toEqual({ x0: 0, y0: 0, x1: 51, y1: 40 });         // b saw all three
    markRasterCompositeDirty();
    markRasterCompositeDirty({ x0: 1, y0: 1, x1: 2, y1: 2 });
    expect(a.take()).toBe('full');
    for (let i = 0; i < 700; i++) markRasterCompositeDirty({ x0: i, y0: 0, x1: i + 1, y1: 1 });
    expect(a.take()).toBe('full');                                       // older reports were dropped: assume everything
    markRasterCompositeDirty({ x0: 4, y0: 4, x1: 6, y1: 6 });
    expect(a.take()).toEqual({ x0: 4, y0: 4, x1: 6, y1: 6 });
    b.skipToNow();
    expect(b.take()).toBeNull();
    off();
    const n = calls.length;
    markRasterCompositeDirty();
    expect(calls.length).toBe(n);
  });
});
