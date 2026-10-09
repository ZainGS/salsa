/**
 * Timeline PLAYBACK through the raster compositor (perf E2 / E5 / E9, 2026-10-09):
 *  - BRUSH-5 incremental compositing (now ON by default) must stay pixel-identical to a from-scratch composite through
 *    playback-style sequences: cel swaps every N frames, holds, BLANK cels (no texture: the layer drops out of the
 *    list), static layers, per-layer dithered static + ANIMATED layers (per-cel dither cache), paper grain, opacity /
 *    blend changes, and a stroke on the shown cel between loops;
 *  - renders between cel swaps do no GPU work at all; a swap is one composite; every composite is ONE submit (E9);
 *  - a dithered animated layer re-dithers each cel once, then plays from its per-cel cache.
 *
 * Runs the real compositor + dither engine on the CPU mirror (cpu-gpu-mirror.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import { RasterCompositor, LayerBlendMode, type CompositorLayerInfo } from './raster-compositor';
import { CanvasGrainManager } from '../canvas-grain';
import { defaultDitherConfig, type DitherConfig } from '../effects/dither-engine';
import { markRasterCompositeDirty } from './raster-composite-dirty';

beforeAll(() => installGpuGlobals());

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function fillRandom(t: CpuTexture, r: () => number): void {
  const n = 3 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const cx = r() * t.width, cy = r() * t.height, rad = 4 + r() * Math.min(t.width, t.height) * 0.4;
    const col = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    const amax = 0.3 + r() * 0.7;
    for (let y = Math.max(0, Math.floor(cy - rad)); y < Math.min(t.height, cy + rad); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x < Math.min(t.width, cx + rad); x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d > 1) continue;
        const o = (y * t.width + x) * 4;
        t.data[o] = col[0]; t.data[o + 1] = col[1]; t.data[o + 2] = col[2]; t.data[o + 3] = Math.round(255 * amax * (1 - d * 0.5));
      }
    }
  }
}

function cfgOf(patch: Partial<DitherConfig>): DitherConfig {
  return { ...defaultDitherConfig(), enabled: true, algorithm: 'bayer', ...patch };
}

interface Doc {
  gpu: ReturnType<typeof createCpuDevice>;
  W: number; H: number;
  inc: RasterCompositor;
  ref: () => RasterCompositor;
  grain: CanvasGrainManager;
  out: CpuTexture;
  /** id → static texture */
  statics: Array<{ id: string; tex: CpuTexture; dither?: DitherConfig; opacity: number; blend: LayerBlendMode }>;
  /** animated layer: one entry per timeline frame (null = blank) */
  anims: Array<{ id: string; frames: Array<CpuTexture | null>; dither?: DitherConfig; opacity: number; blend: LayerBlendMode }>;
}

function makeDoc(seed: number, W: number, H: number): Doc {
  const r = rng(seed);
  const gpu = createCpuDevice();
  const grain = new CanvasGrainManager(gpu.device);
  grain.setGrain({ type: 'cold-press', scale: 1.2, strength: 0.5 });
  const inc = new RasterCompositor(gpu.device);
  inc.setGrainManager(grain);
  const mk = () => { const t = gpu.mkTex(W, H, 'rgba8unorm'); fillRandom(t, r); return t; };
  // cels held 1–4 frames; some holds are blank
  const celFrames = (n: number, blankEvery: number): Array<CpuTexture | null> => {
    const frames: Array<CpuTexture | null> = [];
    let k = 0;
    while (frames.length < n) {
      const hold = 1 + Math.floor(r() * 4);
      const tex = blankEvery > 0 && k % blankEvery === blankEvery - 1 ? null : mk();
      for (let i = 0; i < hold && frames.length < n; i++) frames.push(tex);
      k++;
    }
    return frames;
  };
  return {
    gpu, W, H, inc, grain,
    ref: () => { const c = new RasterCompositor(gpu.device); c.setGrainManager(grain); return c; },
    out: gpu.mkTex(W, H, 'rgba8unorm'),
    statics: [
      { id: 'bg', tex: mk(), opacity: 1, blend: LayerBlendMode.Normal },
      { id: 'dith', tex: mk(), dither: cfgOf({ bayerLevel: 1, edgeWidth: 3, edgeFade: 0.4 }), opacity: 0.85, blend: LayerBlendMode.Normal },
      { id: 'top', tex: mk(), opacity: 0.6, blend: LayerBlendMode.Multiply },
    ],
    anims: [
      { id: 'A', frames: celFrames(24, 4), opacity: 1, blend: LayerBlendMode.Normal },
      { id: 'D', frames: celFrames(24, 0), dither: cfgOf({ bayerLevel: 2, colorMode: 'duotone' }), opacity: 1, blend: LayerBlendMode.Screen },
    ],
  };
}

/** The renderer's list for timeline frame `f` (layers without a texture — a blank cel — left out). */
function listAt(doc: Doc, f: number): CompositorLayerInfo[] {
  const L: CompositorLayerInfo[] = [];
  const s = doc.statics, a = doc.anims;
  const stat = (x: Doc['statics'][number]) => L.push({ texture: asGpu(x.tex), blendMode: x.blend, opacity: x.opacity, clipped: false, visible: true, ditherConfig: x.dither, cacheKey: x.id });
  const anim = (x: Doc['anims'][number]) => {
    const t = x.frames[(f - 1) % x.frames.length];
    if (t) L.push({ texture: asGpu(t), blendMode: x.blend, opacity: x.opacity, clipped: false, visible: true, ditherConfig: x.dither, cacheKey: x.id, cacheCels: true });
  };
  stat(s[0]); anim(a[0]); stat(s[1]); anim(a[1]); stat(s[2]);
  return L;
}

function sameAsFresh(doc: Doc, f: number, label: string): void {
  const fresh = doc.gpu.mkTex(doc.W, doc.H, 'rgba8unorm');
  const ref = doc.ref();
  ref.currentFrame = f;
  ref.composite(listAt(doc, f), asGpu(fresh));
  const a = doc.out.data, b = fresh.data;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  if (n > 0) throw new Error(`stale playback composite at frame ${f} (${label}): ${n} bytes differ`);
}

describe('playback through the incremental composite == full composite', () => {
  for (const seed of [3, 17, 42]) {
    it(`cel swaps, holds, blank cels, static + dithered layers, grain (seed ${seed})`, () => {
      const doc = makeDoc(seed, 72, 54);
      const r = rng(seed * 31 + 7);
      const kinds = { skip: 0, rect: 0, full: 0 } as Record<string, number>;
      let f = 1;
      for (let loop = 0; loop < 3; loop++) {
        for (let i = 0; i < 24; i++, f++) {
          // several renders per timeline frame (a 60 Hz display, 3D motion, a 30-fps timeline...)
          const renders = 1 + Math.floor(r() * 3);
          for (let k = 0; k < renders; k++) {
            doc.inc.currentFrame = f;
            const list = listAt(doc, f);
            const kind = doc.inc.compositeIncremental(list, asGpu(doc.out), 'main');
            kinds[kind]++;
            sameAsFresh(doc, f, `loop ${loop} frame ${i} render ${k}`);
            if (k > 0) expect(kind).toBe('skip');   // nothing changed since the previous render
          }
        }
        // between loops: a stroke-like write on the cel shown now, a metadata change, a grain change
        const last = f - 1;   // the frame rendered last
        const shown = doc.anims[0].frames[(last - 1) % 24];
        if (shown) {
          const x0 = Math.floor(r() * (doc.W - 10)), y0 = Math.floor(r() * (doc.H - 8));
          for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 10; x++) shown.data.set([200, 30, 90, 255], (y * doc.W + x) * 4);
          markRasterCompositeDirty({ x0, y0, x1: x0 + 10, y1: y0 + 8 }, asGpu(shown));
          doc.inc.currentFrame = last;
          expect(doc.inc.compositeIncremental(listAt(doc, last), asGpu(doc.out), 'main')).toBe('rect');
          sameAsFresh(doc, last, 'stroke on the shown cel');
        }
        doc.statics[2].opacity = loop === 0 ? 0.4 : 0.9;
        if (loop === 1) doc.grain.setGrain({ type: 'rough', scale: 0.8, strength: 0.7 });
      }
      expect(kinds.skip).toBeGreaterThan(30);
      expect(kinds.full).toBeGreaterThan(10);
    }, 60000);
  }

  it('renders between cel swaps do no GPU work; a swap is one submit (E9); a dithered animated layer dithers each cel once', () => {
    const doc = makeDoc(9, 96, 64);
    const D = doc.anims[1];
    // 6 dithered cels held 4 frames each (within the per-layer cel cap of 8)
    const six = Array.from({ length: 6 }, (_, i) => { const t = doc.gpu.mkTex(96, 64, 'rgba8unorm'); fillRandom(t, rng(1000 + i)); return t; });
    D.frames = Array.from({ length: 24 }, (_, i) => six[Math.floor(i / 4)]);
    const distinctCels = new Set(D.frames.filter(Boolean)).size;
    const st = doc.inc.ditherCacheStats;
    let f = 1;
    // loop 1: every cel is new to the cache
    for (let i = 0; i < 24; i++, f++) { doc.inc.currentFrame = f; doc.inc.compositeIncremental(listAt(doc, f), asGpu(doc.out), 'main'); }
    const redithersLoop1 = st.fullRedithers;
    expect(redithersLoop1).toBeGreaterThanOrEqual(distinctCels);   // (+ the static dithered layer once)
    // loops 2–3: all from the per-cel cache (5 distinct cels ≤ maxCelsPerLayer)
    const s0 = { ...doc.inc.stats }, c0 = { ...doc.gpu.counters };
    let composites = 0, renders = 0, idleWork = 0;
    for (let loop = 0; loop < 2; loop++) {
      for (let i = 0; i < 24; i++, f++) {
        for (let k = 0; k < 3; k++) {
          const before = doc.gpu.counters.submits;
          doc.inc.currentFrame = f;
          const kind = doc.inc.compositeIncremental(listAt(doc, f), asGpu(doc.out), 'main');
          renders++;
          if (kind !== 'skip') composites++;
          if (k > 0 && doc.gpu.counters.submits !== before) idleWork++;
        }
      }
    }
    expect(st.fullRedithers).toBe(redithersLoop1);
    expect(st.rectRedithers).toBe(0);
    expect(idleWork).toBe(0);
    expect(doc.inc.stats.submits - s0.submits).toBe(composites);          // one submit per composite
    expect(doc.gpu.counters.submits - c0.submits).toBe(composites);       // and nothing else submitted anything
    // eslint-disable-next-line no-console
    console.log(`[playback composite] ${renders} renders over 2 loops: ${composites} composites (cel swaps), ` +
      `${renders - composites} skips, ${doc.inc.stats.submits - s0.submits} submits, 0 re-dithers ` +
      `(loop 1: ${redithersLoop1} full re-dithers for ${distinctCels} dithered cels + 1 static).`);
  });
});

describe('E9: one encoder per composite', () => {
  it('the same layer texture listed twice (its uniform buffer rewritten mid-batch) composites like two distinct textures', () => {
    const gpu = createCpuDevice();
    const W = 40, H = 30;
    const r = rng(5);
    const a = gpu.mkTex(W, H, 'rgba8unorm'), b = gpu.mkTex(W, H, 'rgba8unorm');
    fillRandom(a, r); fillRandom(b, r);
    const a2 = gpu.mkTex(W, H, 'rgba8unorm'); a2.data.set(a.data);
    const L = (t: CpuTexture, blendMode: LayerBlendMode, opacity: number): CompositorLayerInfo => ({ texture: asGpu(t), blendMode, opacity, clipped: false, visible: true });
    const dup = [L(a, LayerBlendMode.Normal, 1), L(b, LayerBlendMode.Multiply, 0.5), L(a, LayerBlendMode.Screen, 0.7), L(a, LayerBlendMode.Difference, 0.3)];
    const distinct = [L(a, LayerBlendMode.Normal, 1), L(b, LayerBlendMode.Multiply, 0.5), L(a2, LayerBlendMode.Screen, 0.7), L(gpu.mkTex(W, H, 'rgba8unorm'), LayerBlendMode.Normal, 1)];
    const a3 = distinct[3].texture as unknown as CpuTexture; a3.data.set(a.data);
    distinct[3] = L(a3, LayerBlendMode.Difference, 0.3);
    for (const incremental of [false, true]) {
      const o1 = gpu.mkTex(W, H, 'rgba8unorm'), o2 = gpu.mkTex(W, H, 'rgba8unorm');
      const c1 = new RasterCompositor(gpu.device), c2 = new RasterCompositor(gpu.device);
      if (incremental) { c1.compositeIncremental(dup, asGpu(o1), 'main'); c2.compositeIncremental(distinct, asGpu(o2), 'main'); }
      else { c1.composite(dup, asGpu(o1)); c2.composite(distinct, asGpu(o2)); }
      expect(Buffer.from(o1.data).equals(Buffer.from(o2.data))).toBe(true);
      expect(c1.stats.submits).toBeGreaterThan(c2.stats.submits);   // (the duplicate forced an early submit)
      expect(c2.stats.submits).toBe(1);
    }
  });
});
