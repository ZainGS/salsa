/**
 * UI audit 2026-10-09:
 *  - error-diffusion Strength was dead (the WASM result was written out as it is): it now blends with the original,
 *    for every caller (the per-layer dither cache, its Bake, the global dither);
 *  - Duotone Tint was the same factor as Strength (strength × tint): Strength is now how much of the dot PATTERN
 *    shows (0 = the flat two-colour tone the pattern averages to), Tint how strongly the colours replace the artwork.
 * Runs the real engine / cache / compositor on the CPU mirror (cpu-gpu-mirror.ts ports the Bayer shader).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

vi.mock('../../../wasm/wasm-bindings', () => ({
  isWasmReady: () => true,
  // a stand-in "error diffusion": a deterministic per-pixel threshold (alpha untouched)
  applyErrorDiffusion: (_alg: string, px: Uint8Array) => {
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] >= 128 ? 255 : 0;
  },
}));

import { createCpuDevice, installGpuGlobals, type CpuTexture } from '../cpu-gpu-mirror';
import { DitherEngine, defaultDitherConfig, ditherConfigActive, blendDitherStrength, type DitherConfig } from './dither-engine';
import { LayerDitherCache } from '../core/layer-dither-cache';
import { RasterCompositor, LayerBlendMode, type CompositorLayerInfo } from '../core/raster-compositor';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const cfgOf = (patch: Partial<DitherConfig>): DitherConfig => ({ ...defaultDitherConfig(), enabled: true, ...patch });

/** A 16×8 opaque gradient (R ramps in x, G in y, B constant). */
function gradient(gpu: ReturnType<typeof createCpuDevice>): CpuTexture {
  const t = gpu.mkTex(16, 8, 'rgba8unorm');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const o = (y * 16 + x) * 4;
    t.data[o] = x * 16 + 8; t.data[o + 1] = y * 32 + 16; t.data[o + 2] = 100; t.data[o + 3] = 255;
  }
  return t;
}
const threshold = (src: Uint8Array): Uint8Array => {
  const o = src.slice();
  for (let i = 0; i < o.length; i += 4) for (let c = 0; c < 3; c++) o[i + c] = o[i + c] >= 128 ? 255 : 0;
  return o;
};

describe('ditherConfigActive', () => {
  it('Strength > 0, or Duotone (ordered algorithms) with a visible Tint', () => {
    expect(ditherConfigActive(cfgOf({ strength: 0.5 }))).toBe(true);
    expect(ditherConfigActive(cfgOf({ strength: 0 }))).toBe(false);
    expect(ditherConfigActive(cfgOf({ enabled: false }))).toBe(false);
    expect(ditherConfigActive(null)).toBe(false);
    expect(ditherConfigActive(cfgOf({ strength: 0, colorMode: 'duotone', tintOpacity: 0.6 }))).toBe(true);   // flat tone
    expect(ditherConfigActive(cfgOf({ strength: 0, colorMode: 'duotone', tintOpacity: 0 }))).toBe(false);
    // error diffusion ignores the color mode: only Strength counts
    expect(ditherConfigActive(cfgOf({ algorithm: 'floyd_steinberg', strength: 0, colorMode: 'duotone', tintOpacity: 1 }))).toBe(false);
  });
});

describe('Error-diffusion Strength', () => {
  it('blendDitherStrength: orig + (out − orig) × s, rounded; s ≥ 1 leaves the result', () => {
    const orig = new Uint8Array([100, 200, 0, 255]);
    const out = new Uint8Array([255, 0, 255, 255]);
    const a = out.slice(); blendDitherStrength(a, orig, 0.5);
    expect(Array.from(a)).toEqual([178, 100, 128, 255]);
    const b = out.slice(); blendDitherStrength(b, orig, 1);
    expect(Array.from(b)).toEqual(Array.from(out));
    const c = out.slice(); blendDitherStrength(c, orig, 0);
    expect(Array.from(c)).toEqual(Array.from(orig));
  });

  it('errorDiffuse returns the blend at Strength < 1 and the raw WASM pass at 1', async () => {
    for (const algorithm of ['floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite'] as const) {
      const gpu = createCpuDevice();
      const src = gradient(gpu);
      const eng = new DitherEngine(gpu.device);
      const full = await eng.errorDiffuse(asGpu(src), cfgOf({ algorithm, strength: 1 }));
      expect(Array.from(full!), algorithm).toEqual(Array.from(threshold(src.data)));
      const half = await eng.errorDiffuse(asGpu(src), cfgOf({ algorithm, strength: 0.25 }));
      const want = threshold(src.data); blendDitherStrength(want, src.data, 0.25);
      expect(Array.from(half!), algorithm).toEqual(Array.from(want));
    }
  });

  it('the per-layer cache serves (and Bake writes) the Strength blend', async () => {
    vi.useFakeTimers();
    const gpu = createCpuDevice();
    const src = gradient(gpu);
    const cfg = cfgOf({ algorithm: 'floyd_steinberg', strength: 0.5 });
    const want = threshold(src.data); blendDitherStrength(want, src.data, 0.5);
    const cache = new LayerDitherCache(gpu.device, new DitherEngine(gpu.device), () => {});
    const layer: CompositorLayerInfo = { texture: asGpu(src), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true, ditherConfig: cfg, cacheKey: 'L' };
    cache.resolve(layer);
    await vi.runAllTimersAsync();
    const r = cache.resolve(layer);
    expect(Array.from((r.texture as unknown as CpuTexture).data)).toEqual(Array.from(want));
    const dst = gpu.mkTex(16, 8, 'rgba8unorm');
    expect(await cache.bakeInto(layer, asGpu(dst))).toBe(true);
    expect(Array.from(dst.data)).toEqual(Array.from(want));
  });

  it('the global error-diffusion dither composites the Strength blend', async () => {
    const gpu = createCpuDevice();
    const src = gradient(gpu);
    const comp = new RasterCompositor(gpu.device);
    comp.setDitherConfig(cfgOf({ algorithm: 'atkinson', strength: 0.75 }));
    const out = gpu.mkTex(16, 8, 'rgba8unorm');
    await comp.compositeAsync([{ texture: asGpu(src), blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true }], asGpu(out));
    const want = threshold(src.data); blendDitherStrength(want, src.data, 0.75);
    expect(Array.from(out.data)).toEqual(Array.from(want));
  });
});

describe('Duotone: Strength (pattern) and Tint (colour replacement) are distinct', () => {
  const FG: [number, number, number, number] = [1, 0, 0, 1];      // red dots
  const BG: [number, number, number, number] = [0, 0, 1, 1];      // blue paper
  function run(patch: Partial<DitherConfig>): { src: Uint8Array; out: Uint8Array } {
    const gpu = createCpuDevice();
    const src = gradient(gpu);
    const out = gpu.mkTex(16, 8, 'rgba8unorm');
    const cfg = cfgOf({ algorithm: 'bayer', bayerLevel: 1, colorMode: 'duotone', foregroundColor: FG, backgroundColor: BG, duotoneBias: 0.5, ...patch });
    new DitherEngine(gpu.device).applyRegion(asGpu(src), asGpu(out), cfg, null);
    return { src: src.data, out: out.data };
  }
  const px = (d: Uint8Array, i: number) => Array.from(d.subarray(i * 4, i * 4 + 4));

  it('Strength 1, Tint 1: crisp FG / BG dots (as before)', () => {
    const { out } = run({ strength: 1, tintOpacity: 1 });
    const seen = new Set<string>();
    for (let i = 0; i < 128; i++) seen.add(px(out, i).join(','));
    expect([...seen].sort()).toEqual(['0,0,255,255', '255,0,0,255']);
  });

  it('Strength 0, Tint 1: the flat two-colour tone at the Bias coverage (no pattern, the artwork fully replaced)', () => {
    const { out } = run({ strength: 0, tintOpacity: 1, duotoneBias: 0.25 });
    for (let i = 0; i < 128; i++) expect(px(out, i)).toEqual([64, 0, 191, 255]);   // mix(BG, FG, 0.25)
  });

  it('Strength 1, Tint 0.5: the dots, half over the original artwork; Tint 0: the original', () => {
    const { src, out } = run({ strength: 1, tintOpacity: 0.5 });
    const full = run({ strength: 1, tintOpacity: 1 }).out;
    for (let i = 0; i < 128; i++) {
      for (let c = 0; c < 3; c++) expect(Math.abs(out[i * 4 + c] - (src[i * 4 + c] + full[i * 4 + c]) / 2)).toBeLessThanOrEqual(1);
    }
    const none = run({ strength: 1, tintOpacity: 0 });
    expect(Array.from(none.out)).toEqual(Array.from(none.src));
  });

  it('Strength 0.5 at Tint 1 no longer shows the original through (it used to be strength × tint)', () => {
    const { out } = run({ strength: 0.5, tintOpacity: 1 });
    for (let i = 0; i < 128; i++) {
      const p = px(out, i);
      expect(p[1], 'no green from the artwork').toBe(0);
      expect(p[0] + p[2]).toBeGreaterThanOrEqual(254);   // a mix of the two colours only
    }
  });

  it('a Strength-0 duotone layer is a live dither for the cache (the flat tone is not skipped)', () => {
    const gpu = createCpuDevice();
    const src = gradient(gpu);
    const cfg = cfgOf({ algorithm: 'bayer', colorMode: 'duotone', strength: 0, tintOpacity: 1, foregroundColor: FG, backgroundColor: BG });
    const cache = new LayerDitherCache(gpu.device, new DitherEngine(gpu.device), () => {});
    const r = cache.resolve({ texture: asGpu(src), ditherConfig: cfg, cacheKey: 'L' });
    expect(r.texture).not.toBe(asGpu(src));
    expect(px((r.texture as unknown as CpuTexture).data, 0)).toEqual([128, 0, 128, 255]);
  });
});
