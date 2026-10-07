/**
 * gpu-capabilities.test.ts: the mobile-parity capability layer (CRASH-8 / CRASH-3 / TIER-1 / CRASH-4):
 *  - tier detection from fake adapter infos / UAs / pointers / deviceMemory and the overrides;
 *  - the caps per tier ('desktop' = today's defaults) and the device-feature fold (no indirect-first-instance);
 *  - the crash-loop guard (2 losses within 60 s);
 *  - the canvas DPR / max-pixel cap maths and the texture-extent clamp.
 */
import { describe, it, expect } from 'vitest';
import {
  detectGpuTier, capsForTier, resolveGpuCaps, noteDeviceLoss, computeCanvasBacking, clampTextureExtent,
  DESKTOP_CAPS, MOBILE_CAPS, SAFE_CAPS, type GpuTierInputs,
} from './gpu-capabilities';
import { requestSalsaDevice } from './gpu-device-recovery';

const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const desktopNvidia: GpuTierInputs = { vendor: 'nvidia', architecture: 'ampere', userAgent: WIN_CHROME, uaMobile: false, coarsePointer: false, anyFinePointer: true, deviceMemory: 8 };

describe('detectGpuTier', () => {
  it('desktop GPUs + desktop UA → desktop', () => {
    expect(detectGpuTier(desktopNvidia).tier).toBe('desktop');
    expect(detectGpuTier({ ...desktopNvidia, vendor: 'intel', architecture: 'gen-12lp' }).tier).toBe('desktop');
    expect(detectGpuTier({ ...desktopNvidia, vendor: 'amd', architecture: 'rdna-3' }).tier).toBe('desktop');
    expect(detectGpuTier({ vendor: 'apple', architecture: 'metal-3', userAgent: MAC, maxTouchPoints: 0, anyFinePointer: true }).tier).toBe('desktop');
  });

  it('a desktop touch laptop (coarse primary pointer but a fine pointer too) stays desktop', () => {
    expect(detectGpuTier({ ...desktopNvidia, coarsePointer: true, anyFinePointer: true }).tier).toBe('desktop');
  });

  it('mobile GPU vendors / architectures → mobile (hidden UA)', () => {
    for (const [vendor, architecture] of [['qualcomm', 'adreno-7xx'], ['arm', 'valhall'], ['arm', 'bifrost'], ['img-tec', 'powervr'],
      ['samsung', 'xclipse'], ['mediatek', ''], ['', 'mali-g78']] as const) {
      const r = detectGpuTier({ vendor, architecture, userAgent: '', anyFinePointer: true });
      expect(r.tier, `${vendor}/${architecture}`).toBe('mobile');
    }
  });

  it('"arm" only matches as a word (not e.g. inside another vendor name)', () => {
    expect(detectGpuTier({ vendor: 'swarmgpu', userAgent: WIN_CHROME, anyFinePointer: true }).tier).toBe('desktop');
  });

  it('Android UA (tablets report userAgentData.mobile = false) → mobile', () => {
    const r = detectGpuTier({ vendor: '', userAgent: ANDROID_TABLET, uaMobile: false, coarsePointer: true, anyFinePointer: false });
    expect(r.tier).toBe('mobile');
    expect(r.reasons).toContain('Android UA');
  });

  it('userAgentData.mobile, iPadOS (Mac UA + touch), touch-only and ≤ 2 GB → mobile', () => {
    expect(detectGpuTier({ uaMobile: true, userAgent: '' }).tier).toBe('mobile');
    expect(detectGpuTier({ vendor: 'apple', userAgent: MAC, maxTouchPoints: 5 }).tier).toBe('mobile');
    expect(detectGpuTier({ userAgent: '', coarsePointer: true, anyFinePointer: false }).tier).toBe('mobile');
    expect(detectGpuTier({ ...desktopNvidia, deviceMemory: 2 }).tier).toBe('mobile');
    expect(detectGpuTier({ ...desktopNvidia, deviceMemory: 4 }).tier).toBe('desktop');
  });

  it('overrides: ?salsaSafe=1 > session / stored safe mode > salsa.gpu.tier > detection', () => {
    expect(detectGpuTier({ ...desktopNvidia, tierOverride: 'mobile' }).tier).toBe('mobile');
    expect(detectGpuTier({ vendor: 'qualcomm', userAgent: ANDROID_TABLET, tierOverride: 'desktop' }).tier).toBe('desktop');
    expect(detectGpuTier({ ...desktopNvidia, tierOverride: ' SAFE ' }).tier).toBe('safe');
    expect(detectGpuTier({ ...desktopNvidia, tierOverride: 'bogus' }).tier).toBe('desktop');
    expect(detectGpuTier({ ...desktopNvidia, tierOverride: 'desktop', safeModeStored: true }).tier).toBe('safe');
    expect(detectGpuTier({ ...desktopNvidia, tierOverride: 'desktop', safeSession: true }).tier).toBe('safe');
    expect(detectGpuTier({ ...desktopNvidia, safeQuery: true }).reasons).toEqual(['?salsaSafe=1']);
  });
});

describe('caps', () => {
  it('desktop caps are the engine defaults (no behaviour change)', () => {
    expect(capsForTier('desktop')).toEqual({ gpuDriven: true, shaderVariants: true, htmlInCanvas: true, maxDpr: Infinity, maxCanvasPixels: Infinity,
      warmConcurrency: 2, shadows: true, ssao: true, ssr: true, taa: true, animatedFocusBg: true });
  });
  it('mobile: CPU path, no variants, no HTML-in-canvas, DPR 1.5, ~2.5 MP, one compile at a time, still focus bg', () => {
    const c = capsForTier('mobile');
    expect(c).toMatchObject({ gpuDriven: false, shaderVariants: false, htmlInCanvas: false, maxDpr: 1.5, maxCanvasPixels: 2_500_000, warmConcurrency: 1, animatedFocusBg: false });
    expect(c.shadows && c.ssao && c.ssr && c.taa).toBe(true);
  });
  it('safe = mobile + shadows / SSAO / SSR / TAA off', () => {
    expect(capsForTier('safe')).toEqual({ ...MOBILE_CAPS, shadows: false, ssao: false, ssr: false, taa: false });
  });
  it('returns copies (the frozen presets are never mutated)', () => {
    const c = capsForTier('desktop'); c.gpuDriven = false;
    expect(DESKTOP_CAPS.gpuDriven).toBe(true);
    expect(Object.isFrozen(SAFE_CAPS)).toBe(true);
  });
  it('no indirect-first-instance → GPU-driven off on every tier', () => {
    expect(resolveGpuCaps('desktop', { indirectFirstInstance: false }).gpuDriven).toBe(false);
    expect(resolveGpuCaps('desktop', { indirectFirstInstance: true }).gpuDriven).toBe(true);
    expect(resolveGpuCaps('desktop').gpuDriven).toBe(true);
    expect(resolveGpuCaps('desktop', { indirectFirstInstance: false }).shaderVariants).toBe(true);   // only the GPU-driven path needs it
  });
});

describe('noteDeviceLoss (crash-loop guard)', () => {
  it('one loss does not trip; a second within 60 s does', () => {
    const a = noteDeviceLoss([], 1_000_000);
    expect(a.tripped).toBe(false);
    const b = noteDeviceLoss(a.history, 1_000_000 + 59_000);
    expect(b.tripped).toBe(true);
  });
  it('losses further apart than 60 s never trip', () => {
    let h: number[] = [];
    for (let i = 0; i < 5; i++) { const r = noteDeviceLoss(h, 1_000_000 + i * 61_000); expect(r.tripped).toBe(false); h = r.history; }
    expect(h.length).toBe(1);
  });
  it('drops garbage + future times from a persisted history, and bounds its length', () => {
    const r = noteDeviceLoss(['x', null, NaN, 5_000_000, 999_990], 1_000_000);
    expect(r.history).toEqual([999_990, 1_000_000]);
    expect(r.tripped).toBe(true);
    let h: number[] = [];
    for (let i = 0; i < 50; i++) h = noteDeviceLoss(h, 1_000_000 + i).history;
    expect(h.length).toBeLessThanOrEqual(8);
  });
  it('custom threshold', () => {
    expect(noteDeviceLoss([1, 2], 3, { windowMs: 60_000, threshold: 3 }).tripped).toBe(true);
    expect(noteDeviceLoss([2], 3, { windowMs: 60_000, threshold: 3 }).tripped).toBe(false);
  });
});

describe('computeCanvasBacking (TIER-1 DPR / max-pixel cap)', () => {
  it('desktop caps = the old floor(css × max(1, dpr)) exactly', () => {
    for (const [w, h, d] of [[1920, 1080, 1], [1280.5, 720.25, 1.25], [2560, 1440, 2], [800, 600, 0.5], [3000, 2000, 3]] as const) {
      const b = computeCanvasBacking(w, h, d, DESKTOP_CAPS);
      const dd = Math.max(1, d);
      expect(b).toEqual({ width: Math.floor(w * dd), height: Math.floor(h * dd), dpr: dd });
    }
  });
  it('mobile: DPR clamped to 1.5', () => {
    const b = computeCanvasBacking(1000, 600, 2.5, MOBILE_CAPS);   // 1.5 → 1500×900 = 1.35 MP (under the pixel cap)
    expect(b).toEqual({ width: 1500, height: 900, dpr: 1.5 });
  });
  it('mobile: lowered further so width × height ≤ 2.5 MP (aspect kept)', () => {
    const b = computeCanvasBacking(1280, 800, 2, MOBILE_CAPS);   // 1.5 → 1920×1200 = 2.3 MP: OK
    expect(b.dpr).toBe(1.5);
    const big = computeCanvasBacking(1600, 1000, 2, MOBILE_CAPS);   // 1.5 → 2400×1500 = 3.6 MP: too many
    expect(big.width * big.height).toBeLessThanOrEqual(2_500_000);
    expect(big.dpr).toBeLessThan(1.5);
    expect(big.width / big.height).toBeCloseTo(1.6, 2);
  });
  it('a DPR-1 screen is never upscaled; a degenerate box gives 0×0', () => {
    expect(computeCanvasBacking(800, 600, 1, MOBILE_CAPS)).toEqual({ width: 800, height: 600, dpr: 1 });
    expect(computeCanvasBacking(0, 0, 2, MOBILE_CAPS)).toMatchObject({ width: 0, height: 0 });
    expect(computeCanvasBacking(800, 600, NaN, DESKTOP_CAPS)).toEqual({ width: 800, height: 600, dpr: 1 });
  });
});

describe('clampTextureExtent', () => {
  it('fits inside the limit unchanged', () => {
    expect(clampTextureExtent(100.2, 50, 8192)).toEqual({ width: 101, height: 50, scale: 1 });
  });
  it('scales an over-size extent down, aspect kept, both sides ≤ max', () => {
    const r = clampTextureExtent(10000, 2500, 4096);
    expect(r.width).toBe(4096);
    expect(r.height).toBe(1024);
    expect(r.scale).toBeCloseTo(0.4096, 4);
    const t = clampTextureExtent(300, 9000, 8192);
    expect(t.height).toBeLessThanOrEqual(8192);
    expect(t.width).toBeLessThanOrEqual(300);
  });
  it('a bad limit means unlimited', () => {
    expect(clampTextureExtent(20000, 10, NaN).scale).toBe(1);
  });
});

describe('requestSalsaDevice (CRASH-1: indirect-first-instance is optional)', () => {
  function fakeGpu(features: string[], info = { vendor: 'qualcomm', architecture: 'adreno-7xx', description: '', device: '' }) {
    const requested: { features?: string[] } = {};
    const adapter = {
      info, features: new Set(features), limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 28 },
      requestDevice: async (d: { requiredFeatures: string[] }) => { requested.features = d.requiredFeatures; return { features: new Set(d.requiredFeatures) }; },
    };
    return { gpu: { requestAdapter: async () => adapter } as unknown as GPU, requested };
  }
  it('an adapter WITHOUT the feature still gets a device (and reports it missing)', async () => {
    const f = fakeGpu(['timestamp-query']);
    const got = await requestSalsaDevice(f.gpu);
    expect(f.requested.features).toEqual(['timestamp-query']);
    expect(got.indirectFirstInstance).toBe(false);
    expect(got.adapterInfo).toEqual({ vendor: 'qualcomm', architecture: 'adreno-7xx', description: '', device: '' });
    expect(resolveGpuCaps('desktop', { indirectFirstInstance: got.indirectFirstInstance }).gpuDriven).toBe(false);
  });
  it('an adapter WITH it requests it', async () => {
    const f = fakeGpu(['indirect-first-instance', 'chromium-experimental-multi-draw-indirect']);
    const got = await requestSalsaDevice(f.gpu);
    expect(f.requested.features).toEqual(['indirect-first-instance', 'chromium-experimental-multi-draw-indirect']);
    expect(got.indirectFirstInstance).toBe(true);
  });
});
