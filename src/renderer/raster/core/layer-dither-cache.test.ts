/**
 * Per-layer dither cache (layer-dither-cache.ts, 2026-10-08): a dithered layer is re-dithered only when its pixels /
 * config / texture change, and — for ordered algorithms — only over the reported dirty rect grown by the edge-effect
 * reach, with a result IDENTICAL to a full re-dither. Error diffusion is deferred (stroke end / debounce, one pass in
 * flight, stale results dropped). Bake writes the dithered look into the layer as one undo entry.
 *
 * Runs the real compositor + dither engine + cache on the CPU mirror (cpu-gpu-mirror.ts — the Bayer dither shader
 * has a CPU port there); the same identity is checked on real D3D12 through the Dawn-node harness for every ordered
 * algorithm (see the report of this change).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

vi.mock('../../../wasm/wasm-bindings', () => ({
  isWasmReady: () => true,
  // a stand-in "error diffusion": a deterministic per-pixel threshold (the cache only cares that it is a pass)
  applyErrorDiffusion: (_alg: string, px: Uint8Array) => {
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] >= 128 ? 255 : 0;
  },
}));

import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import { RasterCompositor, LayerBlendMode, type CompositorLayerInfo } from './raster-compositor';
import { DitherEngine, defaultDitherConfig, ditherEdgeJfaCone, type DitherConfig } from '../effects/dither-engine';
import { markRasterCompositeDirty } from './raster-composite-dirty';
import { noteRasterStrokeBegin, noteRasterStrokeEnd } from '../raster-stroke-activity';
import { RasterLayerManager } from '../../../services/raster-layer-manager';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const diffCount = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Paint a random patch (colours, soft / hard alpha, transparent holes) over `r` and report it like a writer does. */
function paint(gpu: ReturnType<typeof createCpuDevice>, tex: CpuTexture, r: { x0: number; y0: number; x1: number; y1: number }, rnd: () => number, report: 'rect' | 'full' | 'unattributed' = 'rect'): void {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const px = new Uint8Array(w * h * 4);
  const col = [rnd() * 255, rnd() * 255, rnd() * 255];
  const hole = rnd() < 0.5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const d = Math.hypot(x - w / 2, y - h / 2) / Math.max(1, Math.min(w, h) / 2);
    const a = hole && d < 0.4 ? 0 : (rnd() < 0.08 ? 0 : 255 * Math.max(0, Math.min(1, 1.2 - d * 0.6)));
    px[o] = col[0]; px[o + 1] = col[1] * (0.5 + 0.5 * (x / w)); px[o + 2] = col[2]; px[o + 3] = a;
  }
  gpu.device.queue.writeTexture({ texture: asGpu(tex), origin: { x: r.x0, y: r.y0 } } as GPUTexelCopyTextureInfo, px, { bytesPerRow: w * 4 }, [w, h]);
  if (report === 'rect') markRasterCompositeDirty(r, asGpu(tex));
  else if (report === 'full') markRasterCompositeDirty(null, asGpu(tex));
  else markRasterCompositeDirty(r);   // a host report with no target (every texture)
}

function randRect(rnd: () => number, W: number, H: number) {
  const w = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 4 : W / 3)), h = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 4 : H / 3));
  const x0 = Math.floor(rnd() * (W - w + 1)), y0 = Math.floor(rnd() * (H - h + 1));
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

function cfgOf(patch: Partial<DitherConfig>): DitherConfig {
  return { ...defaultDitherConfig(), enabled: true, algorithm: 'bayer', ...patch };
}

function layerOf(tex: CpuTexture, cfg?: DitherConfig, key?: string): CompositorLayerInfo {
  return { texture: asGpu(tex), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true, ditherConfig: cfg, cacheKey: key };
}

/** A full dither of `tex` from scratch (a fresh engine, no cache) — what the old composite did every frame. */
function fullDither(gpu: ReturnType<typeof createCpuDevice>, tex: CpuTexture, cfg: DitherConfig): Uint8Array {
  const out = gpu.mkTex(tex.width, tex.height, 'rgba8unorm');
  new DitherEngine(gpu.device).applyRegion(asGpu(tex), asGpu(out), cfg, null);
  return out.data;
}

const CONFIGS: Array<[string, Partial<DitherConfig>]> = [
  ['plain Bayer 8x8', { bayerLevel: 2 }],
  ['content edge fade + shrink', { bayerLevel: 2, edgeWidth: 6, edgeFade: 0.5, edgeShrink: 0.6 }],
  ['density dropout (4x4 tiles, scale 1.5)', { bayerLevel: 1, patternScale: 1.5, edgeWidth: 5, edgeDensity: 0.7, edgeSeed: 7 }],
  ['big tiles, duotone, both, negative shrink', {
    bayerLevel: 3, patternScale: 2, edgeWidth: 9, edgeDensity: 0.8, edgeShrink: -0.4, edgeMode: 'both', colorMode: 'duotone',
    foregroundColor: [0.1, 0.2, 0.6, 1], backgroundColor: [1, 0.9, 0.7, 0.8], duotoneBias: 0.6,
  }],
  ['canvas edge + density, per channel, invert', { bayerLevel: 2, edgeWidth: 12, edgeDensity: 0.5, edgeFade: 0.3, edgeMode: 'canvas', perChannel: true, invertPattern: true, colorLevels: 4 }],
];

describe('Layer dither cache: ordered dirty-rect re-dither is identical to a full re-dither', () => {
  for (const [name, patch] of CONFIGS) {
    it(name, () => {
      const gpu = createCpuDevice();
      const W = 72, H = 56;
      const rnd = rng(name.length * 977 + 13);
      const tex = gpu.mkTex(W, H, 'rgba8unorm');
      const other = gpu.mkTex(W, H, 'rgba8unorm');
      paint(gpu, tex, { x0: 4, y0: 4, x1: W - 6, y1: H - 3 }, rnd);
      const cfg = cfgOf(patch);
      const comp = new RasterCompositor(gpu.device);
      const out = gpu.mkTex(W, H, 'rgba8unorm');
      const layers = [layerOf(tex, cfg, 'L1')];
      comp.composite(layers, asGpu(out));
      expect(same(out.data, fullDither(gpu, tex, cfg))).toBe(true);
      const st = comp.ditherCacheStats;
      for (let step = 0; step < 40; step++) {
        const k = rnd();
        if (k < 0.75) paint(gpu, tex, randRect(rnd, W, H), rnd);
        else if (k < 0.82) paint(gpu, tex, randRect(rnd, W, H), rnd, 'unattributed');
        else if (k < 0.87) paint(gpu, tex, randRect(rnd, W, H), rnd, 'full');
        else paint(gpu, other, randRect(rnd, W, H), rnd);   // another texture: nothing to redo here
        comp.composite(layers, asGpu(out));
        const ref = fullDither(gpu, tex, cfg);
        expect(diffCount(out.data, ref), `step ${step}`).toBe(0);
      }
      expect(st.rectRedithers).toBeGreaterThan(20);
      expect(st.hits).toBeGreaterThan(0);
    });
  }

  it('the reach matters: without growing the rect, edge / density configs diverge (the test can see it)', () => {
    const gpu = createCpuDevice();
    const W = 72, H = 56;
    const rnd = rng(4242);
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    paint(gpu, tex, { x0: 4, y0: 4, x1: W - 6, y1: H - 3 }, rnd);
    const cfg = cfgOf(CONFIGS[3][1]);
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const layers = [layerOf(tex, cfg, 'L1')];
    comp.composite(layers, asGpu(out));
    vi.spyOn(DitherEngine, 'rectReach').mockReturnValue(0);
    let diverged = false;
    for (let step = 0; step < 30 && !diverged; step++) {
      paint(gpu, tex, randRect(rnd, W, H), rnd);
      comp.composite(layers, asGpu(out));
      if (diffCount(out.data, fullDither(gpu, tex, cfg)) > 0) diverged = true;
    }
    expect(diverged).toBe(true);
  });

  it('reach: 0 without edge effects / canvas mode; covers taps and cell centres otherwise', () => {
    expect(DitherEngine.rectReach(cfgOf({}), 512)).toBe(0);
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20 }), 512)).toBe(0);                 // no amount: no taps
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 0, edgeDensity: 1 }), 512)).toBe(0);  // width 0 = off
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20, edgeFade: 1, edgeMode: 'canvas' }), 512)).toBe(0);
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20, edgeFade: 1 }), 512)).toBe(ditherEdgeJfaCone(20));   // 24
    const ht = DitherEngine.rectReach(cfgOf({ algorithm: 'halftone_dot', halftoneFrequency: 32, edgeWidth: 10, edgeDensity: 0.5 }), 512);
    expect(ht).toBeGreaterThanOrEqual(ditherEdgeJfaCone(10) + 16 * 0.71);   // the flood cone + about one 16-px cell
  });
});

/** A SOLID patch over `r` (one colour, full alpha) or, 1 time in 3, an erased ellipse in it — no specks, so the
 *  distance to the paint boundary gets large (paint() above leaves 8% transparent specks: every distance is tiny). */
function paintSolid(gpu: ReturnType<typeof createCpuDevice>, tex: CpuTexture, r: { x0: number; y0: number; x1: number; y1: number }, rnd: () => number): void {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const erase = rnd() < 0.34;
  const px = new Uint8Array(w * h * 4);
  const cur = (x: number, y: number, c: number) => tex.data[((r.y0 + y) * tex.width + r.x0 + x) * 4 + c];
  const col = [rnd() * 255, rnd() * 255, rnd() * 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const inside = ((x + 0.5 - w / 2) / (w / 2)) ** 2 + ((y + 0.5 - h / 2) / (h / 2)) ** 2 <= 1;
    if (erase) { for (let c = 0; c < 4; c++) px[o + c] = inside ? 0 : cur(x, y, c); continue; }
    px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
  }
  gpu.device.queue.writeTexture({ texture: asGpu(tex), origin: { x: r.x0, y: r.y0 } } as GPUTexelCopyTextureInfo, px, { bytesPerRow: w * 4 }, [w, h]);
  markRasterCompositeDirty(r, asGpu(tex));
}

describe('Layer dither cache: wide content-edge bands (jump-flood distance) stay exact under dirty-rect re-dithers', () => {
  const WIDE: Array<[string, Partial<DitherConfig>]> = [
    ['width 1 shrink', { bayerLevel: 1, edgeWidth: 1, edgeShrink: 0.9 }],
    ['width 2.5 fade, quantize per channel', { bayerLevel: 2, edgeWidth: 2.5, edgeFade: 0.8, perChannel: true, colorLevels: 3 }],
    ['width 17 density + shrink', { bayerLevel: 2, edgeWidth: 17, edgeDensity: 0.8, edgeShrink: 0.5, edgeSeed: 3 }],
    ['width 64 fade + density, both', { bayerLevel: 1, edgeWidth: 64, edgeFade: 0.6, edgeDensity: 0.6, edgeMode: 'both' }],
    ['width 300 (past the layer) negative shrink, duotone', {
      bayerLevel: 3, edgeWidth: 300, edgeShrink: -0.7, colorMode: 'duotone', duotoneBias: 0.4,
      foregroundColor: [0.2, 0.1, 0.5, 1], backgroundColor: [1, 1, 0.8, 1],
    }],
  ];
  for (const [name, patch] of WIDE) {
    it(name, () => {
      const gpu = createCpuDevice();
      const W = 150, H = 104;
      const rnd = rng(name.length * 131 + 7);
      const tex = gpu.mkTex(W, H, 'rgba8unorm');
      paintSolid(gpu, tex, { x0: 6, y0: 5, x1: W - 9, y1: H - 4 }, () => 0.9);   // one big solid blob first
      const cfg = cfgOf(patch);
      const comp = new RasterCompositor(gpu.device);
      const out = gpu.mkTex(W, H, 'rgba8unorm');
      const layers = [layerOf(tex, cfg, 'L1')];
      comp.composite(layers, asGpu(out));
      expect(same(out.data, fullDither(gpu, tex, cfg))).toBe(true);
      for (let step = 0; step < 14; step++) {
        const k = rnd();
        // dabs (mostly small: what a stroke reports), erasing included (paint() leaves holes)
        const r = k < 0.8 ? (() => { const x = Math.floor(rnd() * (W - 12)), y = Math.floor(rnd() * (H - 12)); return { x0: x, y0: y, x1: x + 3 + Math.floor(rnd() * 9), y1: y + 3 + Math.floor(rnd() * 9) }; })() : randRect(rnd, W, H);
        if (rnd() < 0.7) paintSolid(gpu, tex, r, rnd); else paint(gpu, tex, r, rnd);
        comp.composite(layers, asGpu(out));
        expect(diffCount(out.data, fullDither(gpu, tex, cfg)), `step ${step}`).toBe(0);
      }
      expect(comp.ditherCacheStats.rectRedithers).toBeGreaterThan(0);
    });
  }

  it('the flood reach matters: half the reach and a wide band diverges (the test can see it)', () => {
    const gpu = createCpuDevice();
    const W = 150, H = 104;
    const rnd = rng(606);
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    paintSolid(gpu, tex, { x0: 6, y0: 5, x1: W - 9, y1: H - 4 }, () => 0.9);
    const cfg = cfgOf({ bayerLevel: 2, edgeWidth: 30, edgeFade: 1 });
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const layers = [layerOf(tex, cfg, 'L1')];
    comp.composite(layers, asGpu(out));
    const real = DitherEngine.rectReach;
    // halve the CACHE's grow only (the engine's flood domain keeps the real reach): the re-dithered rect misses
    // pixels whose band reaches the change
    let inCache = true;
    vi.spyOn(DitherEngine, 'rectReach').mockImplementation((c, w) => {
      const v = real.call(DitherEngine, c, w);
      return inCache ? Math.ceil(v / 2) : v;
    });
    const origApply = DitherEngine.prototype.applyRegion;
    vi.spyOn(DitherEngine.prototype, 'applyRegion').mockImplementation(function (this: DitherEngine, ...a) {
      inCache = false;
      try { return origApply.apply(this, a); } finally { inCache = true; }
    });
    let diverged = false;
    for (let step = 0; step < 30 && !diverged; step++) {
      const x = 20 + Math.floor(rnd() * (W - 40)), y = 20 + Math.floor(rnd() * (H - 40));
      paintSolid(gpu, tex, { x0: x, y0: y, x1: x + 6, y1: y + 6 }, () => 0.1);   // a small erased dab
      comp.composite(layers, asGpu(out));
      if (diffCount(out.data, fullDither(gpu, tex, cfg)) > 0) diverged = true;
    }
    expect(diverged).toBe(true);
  });
});

describe('Layer dither cache: work per composite', () => {
  it('5 dithered layers: painting another layer re-dithers nothing; painting a dithered one re-dithers its rect only', () => {
    const gpu = createCpuDevice();
    const W = 256, H = 192;
    const rnd = rng(99);
    const texes = Array.from({ length: 6 }, () => gpu.mkTex(W, H, 'rgba8unorm'));
    for (const t of texes) paint(gpu, t, { x0: 10, y0: 10, x1: W - 10, y1: H - 10 }, rnd);
    const cfg = cfgOf({ bayerLevel: 2, edgeWidth: 4, edgeFade: 0.4 });
    const layers = texes.map((t, i) => layerOf(t, i < 5 ? { ...cfg } : undefined, 'L' + i));
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const es = comp.ditherEngineStats;
    comp.composite(layers, asGpu(out));
    expect(es.dispatches).toBe(5);                    // first composite: each dithered layer once, whole
    expect(es.dispatchTexels).toBe(5 * W * H);

    // 10 strokes of 6 dabs on the UNDITHERED layer, one composite per dab
    const d0 = es.dispatches, c0 = es.copies;
    let composites = 0;
    for (let s = 0; s < 10; s++) {
      let x = 20 + rnd() * (W - 60), y = 20 + rnd() * (H - 60);
      for (let d = 0; d < 6; d++) {
        x += 4; y += 2;
        paint(gpu, texes[5], { x0: Math.floor(x), y0: Math.floor(y), x1: Math.floor(x) + 12, y1: Math.floor(y) + 12 }, rnd);
        comp.composite(layers, asGpu(out));
        composites++;
      }
    }
    const perCompositeOther = (es.dispatches - d0) / composites;
    expect(es.dispatches - d0).toBe(0);
    expect(es.copies - c0).toBe(0);

    // the same strokes on a DITHERED layer: one dispatch per composite over the dab rect grown by the reach
    const d1 = es.dispatches, t1 = es.dispatchTexels;
    composites = 0;
    for (let s = 0; s < 10; s++) {
      let x = 20 + rnd() * (W - 60), y = 20 + rnd() * (H - 60);
      for (let d = 0; d < 6; d++) {
        x += 4; y += 2;
        paint(gpu, texes[2], { x0: Math.floor(x), y0: Math.floor(y), x1: Math.floor(x) + 12, y1: Math.floor(y) + 12 }, rnd);
        comp.composite(layers, asGpu(out));
        composites++;
      }
    }
    const dispatches = es.dispatches - d1, texels = es.dispatchTexels - t1;
    expect(dispatches).toBe(composites);
    const reach = DitherEngine.rectReach(cfg, W);
    expect(texels).toBeLessThanOrEqual(composites * (12 + 2 * reach) ** 2);
    // eslint-disable-next-line no-console
    console.log(`[dither bench] ${W}x${H}, 5 dithered + 1 plain layer. Before (shared scratch): every composite = 5 full dither dispatches ` +
      `(${5 * W * H} texels) + 10 full copies. After: painting the plain layer = ${perCompositeOther} dispatches / composite; ` +
      `painting a dithered layer = ${dispatches / composites} dispatch / composite, ${Math.round(texels / composites)} texels ` +
      `(${(100 * texels / composites / (W * H)).toFixed(1)}% of one layer, reach ${reach} px).`);
  });

  it('a config change re-dithers that layer whole; turning the dither off frees its cache', () => {
    const gpu = createCpuDevice();
    const tex = gpu.mkTex(40, 30, 'rgba8unorm');
    paint(gpu, tex, { x0: 2, y0: 2, x1: 38, y1: 28 }, rng(5));
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(40, 30, 'rgba8unorm');
    const cfg = cfgOf({});
    comp.composite([layerOf(tex, cfg, 'A')], asGpu(out));
    comp.composite([layerOf(tex, cfg, 'A')], asGpu(out));
    expect(comp.ditherCacheStats.fullRedithers).toBe(1);
    const cfg2 = { ...cfg, edgeSeed: 3 };   // any field, even one with no visible effect here
    comp.composite([layerOf(tex, cfg2, 'A')], asGpu(out));
    expect(comp.ditherCacheStats.fullRedithers).toBe(2);
    expect(comp.ditherCacheSize).toBe(1);
    comp.composite([layerOf(tex, { ...cfg2, enabled: false }, 'A')], asGpu(out));
    expect(comp.ditherCacheSize).toBe(0);
    expect(same(out.data, tex.data)).toBe(true);
    comp.composite([layerOf(tex, cfg2, 'A')], asGpu(out));
    comp.retainLayerDitherCaches(new Set(['B']));   // layer A was deleted
    expect(comp.ditherCacheSize).toBe(0);
  });

  it('a new layer texture (resize / cel / document load) rebuilds the cache whole', () => {
    const gpu = createCpuDevice();
    const a = gpu.mkTex(40, 30, 'rgba8unorm'), b = gpu.mkTex(40, 30, 'rgba8unorm');
    const r = rng(8);
    paint(gpu, a, { x0: 0, y0: 0, x1: 40, y1: 30 }, r);
    paint(gpu, b, { x0: 0, y0: 0, x1: 40, y1: 30 }, r);
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(40, 30, 'rgba8unorm');
    const cfg = cfgOf({ edgeWidth: 3, edgeShrink: 0.5 });
    comp.composite([layerOf(a, cfg, 'L')], asGpu(out));
    comp.composite([layerOf(b, cfg, 'L')], asGpu(out));
    expect(same(out.data, fullDither(gpu, b, cfg))).toBe(true);
    expect(comp.ditherCacheStats.fullRedithers).toBe(2);
  });

  it('incremental composite (BRUSH-5) with dithered layers: rect composites, identical to the full one', () => {
    const gpu = createCpuDevice();
    const W = 80, H = 64;
    const rnd = rng(31);
    const texes = [gpu.mkTex(W, H, 'rgba8unorm'), gpu.mkTex(W, H, 'rgba8unorm'), gpu.mkTex(W, H, 'rgba8unorm')];
    for (const t of texes) paint(gpu, t, { x0: 3, y0: 3, x1: W - 3, y1: H - 3 }, rnd);
    const cfgA = cfgOf({ bayerLevel: 1, edgeWidth: 4, edgeDensity: 0.6 });
    const cfgB = cfgOf({ bayerLevel: 2, colorMode: 'duotone' });
    const mk = () => [layerOf(texes[0]), { ...layerOf(texes[1], cfgA, 'A'), opacity: 0.7 }, { ...layerOf(texes[2], cfgB, 'B'), blendMode: LayerBlendMode.Multiply }];
    const inc = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const results: string[] = [];
    for (let step = 0; step < 25; step++) {
      const t = texes[Math.floor(rnd() * 3)];
      paint(gpu, t, randRect(rnd, W, H), rnd);
      results.push(inc.compositeIncremental(mk(), asGpu(out), 'main'));
      const ref = new RasterCompositor(gpu.device);
      const refOut = gpu.mkTex(W, H, 'rgba8unorm');
      ref.composite(mk(), asGpu(refOut));
      expect(diffCount(out.data, refOut.data), `step ${step}`).toBe(0);
    }
    expect(results.filter(r => r === 'rect').length).toBeGreaterThan(15);
    expect(inc.compositeIncremental(mk(), asGpu(out), 'main')).toBe('skip');
  });
});

describe('Layer dither cache: error diffusion is deferred', () => {
  function edWorld() {
    vi.useFakeTimers();
    const gpu = createCpuDevice();
    const W = 32, H = 24;
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    paint(gpu, tex, { x0: 0, y0: 0, x1: W, y1: H }, rng(77));
    const comp = new RasterCompositor(gpu.device);
    const renders = { n: 0 };
    comp.requestRender = () => { renders.n++; };
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const cfg = cfgOf({ algorithm: 'floyd_steinberg' });
    const layers = [layerOf(tex, cfg, 'E')];
    const edRef = () => { const d = tex.data.slice(); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = d[i + c] >= 128 ? 255 : 0; return d; };
    return { gpu, W, H, tex, comp, renders, out, layers, edRef, stats: comp.ditherCacheStats };
  }

  it('no pass per composite: raw until the debounce, then ONE pass and a render request', async () => {
    const w = edWorld();
    expect(RasterCompositor.needsAsyncComposite(w.layers, w.comp.getDitherConfig())).toBe(false);   // sync path now
    w.comp.composite(w.layers, asGpu(w.out));
    expect(same(w.out.data, w.tex.data)).toBe(true);   // shown undithered until the pass lands
    for (let i = 0; i < 5; i++) w.comp.composite(w.layers, asGpu(w.out));
    expect(w.stats.errorDiffusionPasses).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(w.stats.errorDiffusionPasses).toBe(1);
    expect(w.stats.errorDiffusionLanded).toBe(1);
    expect(w.renders.n).toBe(1);
    w.comp.composite(w.layers, asGpu(w.out));
    expect(same(w.out.data, w.edRef())).toBe(true);
    for (let i = 0; i < 5; i++) w.comp.composite(w.layers, asGpu(w.out));
    await vi.advanceTimersByTimeAsync(500);
    expect(w.stats.errorDiffusionPasses).toBe(1);   // nothing changed: nothing more to do
  });

  it('during a stroke: the changed texels show raw over the previous result; one pass at stroke end', async () => {
    const w = edWorld();
    w.comp.composite(w.layers, asGpu(w.out));
    await vi.advanceTimersByTimeAsync(200);
    w.comp.composite(w.layers, asGpu(w.out));
    const before = w.out.data.slice();
    noteRasterStrokeBegin(asGpu(w.tex));
    const rnd = rng(3);
    const rect = { x0: 4, y0: 4, x1: 12, y1: 10 };
    for (let i = 0; i < 8; i++) {
      paint(w.gpu, w.tex, rect, rnd);
      w.comp.composite(w.layers, asGpu(w.out));
      await vi.advanceTimersByTimeAsync(300);   // even a long pause mid-stroke runs no pass
    }
    expect(w.stats.errorDiffusionPasses).toBe(1);
    // inside the rect: raw layer pixels; outside: the previous error-diffusion result
    for (let y = 0; y < w.H; y++) for (let x = 0; x < w.W; x++) {
      const o = (y * w.W + x) * 4;
      const inside = x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
      const want = inside ? w.tex.data : before;
      expect(Array.from(w.out.data.subarray(o, o + 4))).toEqual(Array.from(want.subarray(o, o + 4)));
    }
    noteRasterStrokeEnd(asGpu(w.tex));
    await vi.advanceTimersByTimeAsync(5);
    expect(w.stats.errorDiffusionPasses).toBe(2);
    w.comp.composite(w.layers, asGpu(w.out));
    expect(same(w.out.data, w.edRef())).toBe(true);
  });

  it('a result whose source changed while it ran is dropped and redone; never two passes in flight', async () => {
    const w = edWorld();
    let inFlight = 0, maxInFlight = 0;
    const real = DitherEngine.prototype.errorDiffuse;
    vi.spyOn(DitherEngine.prototype, 'errorDiffuse').mockImplementation(async function (this: DitherEngine, src, cfg) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 50));
      try { return await real.call(this, src, cfg); } finally { inFlight--; }
    });
    // a second ED layer competing for the single pass slot
    const tex2 = w.gpu.mkTex(w.W, w.H, 'rgba8unorm');
    paint(w.gpu, tex2, { x0: 0, y0: 0, x1: w.W, y1: w.H }, rng(12));
    const layers = [...w.layers, layerOf(tex2, cfgOf({ algorithm: 'atkinson' }), 'E2')];
    w.comp.composite(layers, asGpu(w.out));
    await vi.advanceTimersByTimeAsync(160);          // both debounces fired: one runs, one queued
    paint(w.gpu, w.tex, { x0: 1, y0: 1, x1: 5, y1: 5 }, rng(1));   // the running pass is now stale
    w.comp.composite(layers, asGpu(w.out));
    await vi.advanceTimersByTimeAsync(2000);
    expect(maxInFlight).toBe(1);
    expect(w.stats.errorDiffusionDropped).toBeGreaterThanOrEqual(1);
    w.comp.composite(layers, asGpu(w.out));
    const ref = w.edRef();
    // layer 1 (bottom) shows its CURRENT error diffusion (the composite's base copy)… checked through a lone composite
    const solo = w.gpu.mkTex(w.W, w.H, 'rgba8unorm');
    w.comp.composite(w.layers, asGpu(solo));
    expect(same(solo.data, ref)).toBe(true);
  });
});

describe('Bake Dither', () => {
  it('writes the dithered look into the layer, turns the dither off, ONE undo entry (undo brings both back)', async () => {
    const gpu = createCpuDevice();
    const W = 48, H = 40;
    const rlm = new RasterLayerManager(gpu.device, W, H);
    const { id } = rlm.addLayer('Paint');
    await new Promise(r => setTimeout(r, 0));   // the blank seed snapshot
    const layer = rlm.getLayerById(id)!;
    const tex = layer.texture as unknown as CpuTexture;
    paint(gpu, tex, { x0: 2, y0: 2, x1: W - 2, y1: H - 2 }, rng(21));
    await layer.manager!.pushSnapshot();        // the painted state is the current undo entry
    const painted = tex.data.slice();
    const cfg = cfgOf({ bayerLevel: 1, edgeWidth: 4, edgeDensity: 0.5, edgeFade: 0.3 });
    rlm.setLayerDitherConfig(id, cfg);
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    comp.composite([layerOf(tex, rlm.getLayerDitherConfig(id), id)], asGpu(out));   // the cache exists (live view)
    const live = out.data.slice();
    expect(comp.ditherCacheSize).toBe(1);

    const ok = await rlm.bakeLayerDither(id, (l, dst) => comp.bakeLayerDither(l, dst));
    expect(ok).toBe(true);
    expect(same(tex.data, live)).toBe(true);                  // the pixels ARE the dithered look
    const pre = gpu.mkTex(W, H, 'rgba8unorm'); pre.data.set(painted);
    expect(same(tex.data, fullDither(gpu, pre, cfg))).toBe(true);
    expect(rlm.getLayerDitherConfig(id)?.enabled).toBe(false);
    expect(comp.ditherCacheSize).toBe(0);                     // freed
    comp.composite([layerOf(tex, rlm.getLayerDitherConfig(id), id)], asGpu(out));
    expect(same(out.data, live)).toBe(true);                  // the screen did not change

    expect(await rlm.undoForLayer(id)).toBe(true);            // ONE step back: the pre-bake pixels + the live dither
    expect(same(tex.data, painted)).toBe(true);
    expect(rlm.getLayerDitherConfig(id)?.enabled).toBe(true);
    expect(await rlm.redoForLayer(id)).toBe(true);
    expect(same(tex.data, live)).toBe(true);
    expect(rlm.getLayerDitherConfig(id)?.enabled).toBe(false);
    expect(await rlm.bakeLayerDither(id, (l, dst) => comp.bakeLayerDither(l, dst))).toBe(false);   // nothing to bake
  });
});

describe('Global dither: no needless re-dither', () => {
  it('ordered: an unchanged composite reuses the result (one copy, no dither pass); a layer write recomposites', () => {
    const gpu = createCpuDevice();
    const W = 64, H = 48;
    const rnd = rng(55);
    const a = gpu.mkTex(W, H, 'rgba8unorm'), b = gpu.mkTex(W, H, 'rgba8unorm');
    paint(gpu, a, { x0: 0, y0: 0, x1: W, y1: H }, rnd);
    paint(gpu, b, { x0: 8, y0: 8, x1: 40, y1: 30 }, rnd);
    const g = cfgOf({ bayerLevel: 1, edgeWidth: 3, edgeFade: 0.5 });
    const layers = () => [layerOf(a), { ...layerOf(b), opacity: 0.8 }];
    const comp = new RasterCompositor(gpu.device);
    comp.setDitherConfig(g);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const fresh = () => { const c = new RasterCompositor(gpu.device); c.setDitherConfig(g); const o = gpu.mkTex(W, H, 'rgba8unorm'); c.composite(layers(), asGpu(o)); return o.data; };
    comp.composite(layers(), asGpu(out));
    const es = comp.ditherEngineStats;
    expect(es.dispatches).toBe(1);
    for (let i = 0; i < 5; i++) {
      out.data.fill(7);   // whatever happened to the output since (an onion skin, ...) is replaced
      comp.composite(layers(), asGpu(out));
    }
    expect(es.dispatches).toBe(1);
    expect(same(out.data, fresh())).toBe(true);
    paint(gpu, b, { x0: 20, y0: 20, x1: 30, y1: 28 }, rnd);
    comp.composite(layers(), asGpu(out));
    expect(es.dispatches).toBe(2);
    expect(same(out.data, fresh())).toBe(true);
    comp.setDitherConfig({ ...g, bayerLevel: 2 });
    comp.composite(layers(), asGpu(out));
    expect(es.dispatches).toBe(3);
  });

  it('error diffusion: deferred while a stroke is in progress, one pass when it ends; unchanged composites reuse it', async () => {
    const gpu = createCpuDevice();
    const W = 32, H = 24;
    const tex = gpu.mkTex(W, H, 'rgba8unorm');
    paint(gpu, tex, { x0: 0, y0: 0, x1: W, y1: H }, rng(9));
    const comp = new RasterCompositor(gpu.device);
    let renders = 0;
    comp.requestRender = () => { renders++; };
    comp.setDitherConfig(cfgOf({ algorithm: 'floyd_steinberg' }));
    const layers = [layerOf(tex)];
    expect(RasterCompositor.needsAsyncComposite(layers, comp.getDitherConfig())).toBe(true);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const es = comp.ditherEngineStats;
    await comp.compositeAsync(layers, asGpu(out));
    await comp.compositeAsync(layers, asGpu(out));
    expect(es.errorDiffusionPasses).toBe(1);   // the second composite changed nothing
    noteRasterStrokeBegin(asGpu(tex));
    for (let i = 0; i < 4; i++) {
      paint(gpu, tex, { x0: 2 + i, y0: 2, x1: 10 + i, y1: 9 }, rng(i));
      await comp.compositeAsync(layers, asGpu(out));
    }
    expect(es.errorDiffusionPasses).toBe(1);
    expect(same(out.data, tex.data)).toBe(true);   // undithered while painting
    noteRasterStrokeEnd(asGpu(tex));
    expect(renders).toBe(1);                        // the frame that runs the deferred pass
    await comp.compositeAsync(layers, asGpu(out));
    expect(es.errorDiffusionPasses).toBe(2);
  });
});

describe('Per-cel dither cache (animated layers, perf E5)', () => {
  const celLayer = (tex: CpuTexture, cfg: DitherConfig, key = 'A'): CompositorLayerInfo => ({ ...layerOf(tex, cfg, key), cacheCels: true });

  function cels(gpu: ReturnType<typeof createCpuDevice>, n: number, W: number, H: number, seed: number): CpuTexture[] {
    const r = rng(seed);
    return Array.from({ length: n }, () => {
      const t = gpu.mkTex(W, H, 'rgba8unorm');
      paint(gpu, t, { x0: 1, y0: 1, x1: W - 1, y1: H - 1 }, r);
      return t;
    });
  }

  it('each cel is dithered once, then every swap reuses its cached result (identical to a fresh dither)', () => {
    const gpu = createCpuDevice();
    const W = 48, H = 36;
    const cs = cels(gpu, 5, W, H, 61);
    const cfg = cfgOf({ bayerLevel: 1, edgeWidth: 3, edgeFade: 0.5 });
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const st = comp.ditherCacheStats, es = comp.ditherEngineStats;
    for (let loop = 0; loop < 3; loop++) {
      for (const c of cs) {
        comp.composite([celLayer(c, cfg)], asGpu(out));
        expect(same(out.data, fullDither(gpu, c, cfg))).toBe(true);
      }
      if (loop === 0) expect(st.fullRedithers).toBe(5);
    }
    expect(st.fullRedithers).toBe(5);    // was 15: the layer-id cache re-dithered on every swap
    expect(es.dispatches).toBe(5);
    expect(comp.ditherCacheSize).toBe(5);
    // a write to one cel re-dithers only that cel (rect), the others stay cached
    paint(gpu, cs[2], { x0: 5, y0: 5, x1: 15, y1: 12 }, rng(2));
    for (const c of cs) {
      comp.composite([celLayer(c, cfg)], asGpu(out));
      expect(same(out.data, fullDither(gpu, c, cfg))).toBe(true);
    }
    expect(st.fullRedithers).toBe(5);
    expect(st.rectRedithers).toBe(1);
  });

  it('bounded LRU: at most 8 cels per layer and the byte budget over all; the shown cel is never evicted', () => {
    const gpu = createCpuDevice();
    const W = 32, H = 24, bytes = W * H * 4;
    const cs = cels(gpu, 12, W, H, 7);
    const cfg = cfgOf({});
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    for (const c of cs) comp.composite([celLayer(c, cfg)], asGpu(out));
    expect(comp.ditherCacheSize).toBe(8);
    expect(comp.ditherCacheStats.celEvictions).toBe(4);
    expect(comp.ditherCelCacheBytes).toBe(8 * bytes);
    // the most recent 8 are the ones kept: replaying them re-dithers nothing
    const before = comp.ditherCacheStats.fullRedithers;
    for (const c of cs.slice(4)) comp.composite([celLayer(c, cfg)], asGpu(out));
    expect(comp.ditherCacheStats.fullRedithers).toBe(before);
    // byte budget: two animated layers sharing 5 entries' worth
    comp.setDitherCelCacheLimits(8, 5 * bytes);
    const ds = cels(gpu, 4, W, H, 8);
    for (let i = 0; i < 4; i++) {
      comp.composite([celLayer(cs[i + 8], cfg, 'A'), celLayer(ds[i], cfg, 'B')], asGpu(out));
      expect(comp.ditherCelCacheBytes).toBeLessThanOrEqual(5 * bytes);
      const ref = gpu.mkTex(W, H, 'rgba8unorm');
      new RasterCompositor(gpu.device).composite([celLayer(cs[i + 8], cfg, 'A'), celLayer(ds[i], cfg, 'B')], asGpu(ref));
      expect(same(out.data, ref.data)).toBe(true);   // both shown cels were kept
    }
    // a budget smaller than what one composite shows keeps the shown entries (never drops shown pixels)
    comp.setDitherCelCacheLimits(8, bytes);
    comp.composite([celLayer(cs[0], cfg, 'A'), celLayer(ds[0], cfg, 'B')], asGpu(out));
    expect(comp.ditherCacheSize).toBeGreaterThanOrEqual(2);
    comp.retainLayerDitherCaches(new Set(['B']));   // layer A deleted: all its cel entries go
    comp.composite([celLayer(ds[1], cfg, 'B')], asGpu(out));
    expect(same(out.data, fullDither(gpu, ds[1], cfg))).toBe(true);
  });

  it('static ↔ animated: one entry per layer while static, per cel while animated', () => {
    const gpu = createCpuDevice();
    const W = 24, H = 16;
    const cs = cels(gpu, 3, W, H, 3);
    const cfg = cfgOf({});
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    for (const c of cs) comp.composite([layerOf(c, cfg, 'L')], asGpu(out));
    expect(comp.ditherCacheSize).toBe(1);   // static: a new texture replaces the entry
    for (const c of cs) comp.composite([celLayer(c, cfg, 'L')], asGpu(out));
    expect(comp.ditherCacheSize).toBe(3);
    comp.composite([layerOf(cs[0], cfg, 'L')], asGpu(out));
    expect(comp.ditherCacheSize).toBe(1);
    expect(same(out.data, fullDither(gpu, cs[0], cfg))).toBe(true);
  });

  it('error diffusion: no pass while the timeline plays; each cel computed once after it stops; reused while playing', async () => {
    vi.useFakeTimers();
    const gpu = createCpuDevice();
    const W = 24, H = 18;
    const cs = cels(gpu, 3, W, H, 44);
    const cfg = cfgOf({ algorithm: 'floyd_steinberg' });
    const comp = new RasterCompositor(gpu.device);
    let renders = 0;
    comp.requestRender = () => { renders++; };
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const st = comp.ditherCacheStats;
    const ed = (t: CpuTexture) => { const d = t.data.slice(); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = d[i + c] >= 128 ? 255 : 0; return d; };
    comp.playbackActive = true;
    for (let loop = 0; loop < 2; loop++) {
      for (const c of cs) {
        comp.compositeIncremental([celLayer(c, cfg)], asGpu(out), 'main');
        expect(same(out.data, c.data)).toBe(true);    // raw until a result exists
        await vi.advanceTimersByTimeAsync(400);       // a long hold: still no pass mid-playback
      }
    }
    expect(st.errorDiffusionPasses).toBe(0);
    expect(st.playbackDeferred).toBe(3);
    // playback stops on cel 0: every cel seen gets its pass (one at a time)
    comp.playbackActive = false;
    comp.compositeIncremental([celLayer(cs[0], cfg)], asGpu(out), 'main');
    await vi.advanceTimersByTimeAsync(1000);
    expect(st.errorDiffusionPasses).toBe(3);
    expect(st.errorDiffusionLanded).toBe(3);
    expect(renders).toBe(3);
    // the shown cel's result invalidated the output; the off-screen cels' results did not
    expect(comp.compositeIncremental([celLayer(cs[0], cfg)], asGpu(out), 'main')).toBe('full');
    expect(same(out.data, ed(cs[0]))).toBe(true);
    expect(comp.compositeIncremental([celLayer(cs[0], cfg)], asGpu(out), 'main')).toBe('skip');
    // playing again: every cel shows its cached result, no pass runs
    comp.playbackActive = true;
    for (let loop = 0; loop < 2; loop++) {
      for (const c of cs) {
        comp.compositeIncremental([celLayer(c, cfg)], asGpu(out), 'main');
        expect(same(out.data, ed(c))).toBe(true);
        await vi.advanceTimersByTimeAsync(300);
      }
    }
    expect(st.errorDiffusionPasses).toBe(3);
  });

  it('bake of an animated layer bakes and frees only the shown cel', async () => {
    const gpu = createCpuDevice();
    const W = 20, H = 14;
    const cs = cels(gpu, 3, W, H, 5);
    const cfg = cfgOf({});
    const comp = new RasterCompositor(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    for (const c of cs) comp.composite([celLayer(c, cfg)], asGpu(out));
    const want = fullDither(gpu, cs[1], cfg);
    expect(await comp.bakeLayerDither(celLayer(cs[1], cfg), asGpu(cs[1]))).toBe(true);
    expect(same(cs[1].data, want)).toBe(true);
    expect(comp.ditherCacheSize).toBe(2);
  });
});

describe('ditherConfigKey memo (perf E8)', () => {
  it('same object → same key without recomputing; in-place edits (fields, colour arrays) → a new key', async () => {
    const { ditherConfigKey } = await import('./layer-dither-cache');
    const cfg = cfgOf({ bayerLevel: 2 });
    const k1 = ditherConfigKey(cfg);
    expect(ditherConfigKey(cfg)).toBe(k1);
    expect(ditherConfigKey({ ...cfg })).toBe(k1);
    cfg.enabled = false;                       // setDitherEnabled mutates the global config in place
    const k2 = ditherConfigKey(cfg);
    expect(k2).not.toBe(k1);
    cfg.enabled = true;
    expect(ditherConfigKey(cfg)).toBe(k1);
    cfg.foregroundColor[1] = 0.25;             // an array element changed in place
    const k3 = ditherConfigKey(cfg);
    expect(k3).not.toBe(k1);
    (cfg as unknown as Record<string, unknown>).someNewField = 3;   // a field added later is covered
    expect(ditherConfigKey(cfg)).not.toBe(k3);
    const nan = cfgOf({ strength: NaN });
    expect(ditherConfigKey(nan)).toBe(ditherConfigKey(nan));
  });
});
