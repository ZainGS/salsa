/**
 * gpu-diagnostics.test.ts: the runtime half of the mobile-parity capability layer (CRASH-3 / CRASH-9 / CRASH-10):
 *  - breadcrumbs (coalesced repeats, open operations), uncaptured-error records;
 *  - the persisted crash-loop guard: 2 losses within 60 s → safe mode (stored + session), lastLoss written;
 *  - tier inputs from the environment (?salsaSafe=1 / =0, salsa.gpu.tier);
 *  - the caps APPLICATION (WebGPURenderer.applyGpuCaps → Renderer3D.caps / TextEffectEngine / GPUPipelineCache) and
 *    the setCanvasSize DPR cap + skip-when-unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  gpuCrumb, gpuCrumbBegin, gpuCrumbEnd, getGpuCrumbs, getOpenGpuOps, recordGpuError, getGpuErrors, recordGpuDeviceLoss,
  readLastGpuLoss, readGpuTierInputs, detectGpuTierNow, isGpuSafeModeStored, setGpuSafeModeStored, setGpuDiagnosticsStore,
  resetGpuDiagnosticsForTests, GPU_KEYS, type KeyValueStore,
} from './gpu-diagnostics';
import { capsForTier, DESKTOP_CAPS, MOBILE_CAPS, SAFE_CAPS } from './gpu-capabilities';
import { WebGPURenderer } from './webgpu-renderer';
import { Renderer3D } from '../3d/renderer-3d';
import { TextEffectEngine } from '../raster/effects/text-effect-engine';
import { GPUPipelineCache } from './gpu-pipeline-cache';

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } };
}

let store: ReturnType<typeof memStore>;
beforeEach(() => { store = memStore(); setGpuDiagnosticsStore(store); resetGpuDiagnosticsForTests(); });
afterEach(() => { setGpuDiagnosticsStore(undefined); resetGpuDiagnosticsForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('breadcrumbs', () => {
  it('coalesces repeats and tracks open operations', () => {
    gpuCrumb('livetext capture'); gpuCrumb('livetext capture'); gpuCrumb('livetext capture');
    const t = gpuCrumbBegin('compile "Mesh"');
    expect(getOpenGpuOps()).toEqual(['compile "Mesh"']);
    const c = getGpuCrumbs();
    expect(c[0]).toMatchObject({ what: 'livetext capture', n: 3 });
    expect(c[1].what).toBe('compile "Mesh" start');
    gpuCrumbEnd(t);
    expect(getOpenGpuOps()).toEqual([]);
    expect(getGpuCrumbs().at(-1)!.what).toBe('compile "Mesh" end');
    const f = gpuCrumbBegin('x'); gpuCrumbEnd(f, false);
    expect(getGpuCrumbs().at(-1)!.what).toBe('x FAILED');
  });
  it('the ring is bounded', () => {
    for (let i = 0; i < 200; i++) gpuCrumb(`c${i}`);
    const c = getGpuCrumbs();
    expect(c.length).toBe(40);
    expect(c.at(-1)!.what).toBe('c199');
  });
  it('uncaptured errors: first sighting reported once, repeats counted', () => {
    expect(recordGpuError('GPUValidationError', 'bad bind group')).toBe(true);
    expect(recordGpuError('GPUValidationError', 'bad bind group')).toBe(false);
    expect(recordGpuError('GPUOutOfMemoryError', 'oom')).toBe(true);
    const e = getGpuErrors();
    expect(e.map((x) => [x.kind, x.n ?? 1])).toEqual([['GPUValidationError', 2], ['GPUOutOfMemoryError', 1]]);
  });
});

describe('device loss + crash-loop guard', () => {
  const ctx = { adapter: { vendor: 'qualcomm', architecture: 'adreno-7xx', device: '', description: '' }, tier: 'mobile' as const, caps: capsForTier('mobile') };

  it('writes salsa.gpu.lastLoss with the open operations + breadcrumbs', () => {
    gpuCrumb('tier mobile (start-up)');
    gpuCrumbBegin('gpu-driven first dispatch');
    const rec = recordGpuDeviceLoss('unknown', 'GPU process crashed', ctx);
    expect(rec.open).toEqual(['gpu-driven first dispatch']);
    expect(rec.safeModeTripped).toBe(false);
    const stored = readLastGpuLoss()!;
    expect(stored.reason).toBe('unknown');
    expect(stored.message).toBe('GPU process crashed');
    expect(stored.adapter!.architecture).toBe('adreno-7xx');
    expect(stored.caps).toEqual(capsForTier('mobile'));
    expect(stored.breadcrumbs.map((c) => c.what)).toContain('gpu-driven first dispatch start');
    expect(isGpuSafeModeStored()).toBe(false);
  });

  it('2 losses within 60 s → safe mode (stored + this session); the tier becomes safe', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    recordGpuDeviceLoss('unknown', 'a', ctx);
    vi.setSystemTime(1_030_000);
    const rec = recordGpuDeviceLoss('unknown', 'b', ctx);
    expect(rec.safeModeTripped).toBe(true);
    expect(store.data.has(GPU_KEYS.safeMode)).toBe(true);
    expect(isGpuSafeModeStored()).toBe(true);
    expect(detectGpuTierNow(ctx.adapter).tier).toBe('safe');
  });

  it('the loss history persists across page loads (a reload between losses still counts)', () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000);
    recordGpuDeviceLoss('unknown', 'a', ctx);
    resetGpuDiagnosticsForTests();   // "reload": session state gone, storage kept
    vi.setSystemTime(2_050_000);
    expect(recordGpuDeviceLoss('unknown', 'b', ctx).safeModeTripped).toBe(true);
  });

  it('losses 60 s+ apart never trip', () => {
    vi.useFakeTimers(); vi.setSystemTime(3_000_000);
    recordGpuDeviceLoss('unknown', 'a', ctx);
    vi.setSystemTime(3_061_000);
    expect(recordGpuDeviceLoss('unknown', 'b', ctx).safeModeTripped).toBe(false);
    expect(isGpuSafeModeStored()).toBe(false);
  });

  it('works (session-only) when storage throws', () => {
    setGpuDiagnosticsStore({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    vi.useFakeTimers(); vi.setSystemTime(4_000_000);
    expect(() => recordGpuDeviceLoss('unknown', 'a', ctx)).not.toThrow();
    expect(readLastGpuLoss()).toBeNull();
  });

  it('setGpuSafeModeStored(false) clears the flag and the loss history', () => {
    setGpuSafeModeStored(true);
    expect(isGpuSafeModeStored()).toBe(true);
    setGpuSafeModeStored(false);
    expect(isGpuSafeModeStored()).toBe(false);
    expect(store.data.has(GPU_KEYS.lossTimes)).toBe(false);
  });
});

describe('environment → tier inputs', () => {
  it('reads salsa.gpu.tier, ?salsaSafe=1 forces safe, ?salsaSafe=0 clears the stored flag', () => {
    vi.stubGlobal('location', { search: '?salsaSafe=1' });
    expect(detectGpuTierNow(null).tier).toBe('safe');
    vi.stubGlobal('location', { search: '' });
    store.setItem(GPU_KEYS.tier, 'mobile');
    expect(readGpuTierInputs(null).tierOverride).toBe('mobile');
    expect(detectGpuTierNow(null).tier).toBe('mobile');
    store.setItem(GPU_KEYS.safeMode, '{"at":1}');
    expect(detectGpuTierNow(null).tier).toBe('safe');
    vi.stubGlobal('location', { search: '?salsaSafe=0' });
    expect(detectGpuTierNow(null).tier).toBe('mobile');
    expect(store.data.has(GPU_KEYS.safeMode)).toBe(false);
  });
  it('an Android UA from navigator → mobile', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X910) Chrome/141', maxTouchPoints: 10, userAgentData: { mobile: false } });
    expect(detectGpuTierNow({ vendor: '', architecture: '', device: '', description: '' }).tier).toBe('mobile');
  });
});

// ── caps application (WebGPURenderer.applyGpuCaps / setCanvasSize via a fake `this`, no GPU) ──────────────────────

describe('caps application', () => {
  const proto = WebGPURenderer.prototype as unknown as {
    applyGpuCaps(this: unknown, c: typeof DESKTOP_CAPS, live?: boolean): void;
    setCanvasSize(this: unknown, d: unknown, force?: boolean): void;
  };
  const restore = () => proto.applyGpuCaps.call({ _indirectFirstInstance: true }, { ...DESKTOP_CAPS }, false);
  afterEach(restore);

  it('mobile caps switch GPU-driven / HTML-in-canvas / warm concurrency off; desktop restores the defaults', () => {
    const fake: Record<string, unknown> = { _indirectFirstInstance: true };
    proto.applyGpuCaps.call(fake, { ...MOBILE_CAPS }, false);
    expect(Renderer3D.caps).toMatchObject({ gpuDriven: false, shadows: true, ssao: true, ssr: true, taa: true, animatedFocusBg: false });
    expect(Renderer3D.gpuDrivenActive).toBe(false);
    expect(Renderer3D.gpuDriven).toBe(true);           // the switch / preference itself is untouched
    expect(TextEffectEngine.htmlInCanvasAllowed).toBe(false);
    expect(TextEffectEngine.htmlInCanvasMode()).toBe('none');
    expect(GPUPipelineCache.defaultMaxConcurrentWarm).toBe(1);
    proto.applyGpuCaps.call(fake, { ...SAFE_CAPS }, false);
    expect(Renderer3D.caps).toMatchObject({ shadows: false, ssao: false, ssr: false, taa: false, shaderSplitMaxKeys: 40 });   // (shader split key cap: mobile / safe 40)
    proto.applyGpuCaps.call(fake, { ...DESKTOP_CAPS }, false);
    expect(Renderer3D.caps).toEqual({ gpuDriven: true, shadows: true, ssao: true, ssr: true, taa: true, animatedFocusBg: true, shaderSplitMaxKeys: 96 });
    expect(Renderer3D.gpuDrivenActive).toBe(true);
    expect(TextEffectEngine.htmlInCanvasAllowed).toBe(true);
    expect(GPUPipelineCache.defaultMaxConcurrentWarm).toBe(2);
  });

  it('no indirect-first-instance caps GPU-driven off even on desktop', () => {
    const fake: Record<string, unknown> = { _indirectFirstInstance: false };
    proto.applyGpuCaps.call(fake, { ...DESKTOP_CAPS }, false);
    expect(Renderer3D.caps.gpuDriven).toBe(false);
    expect((fake._gpuCaps as typeof DESKTOP_CAPS).gpuDriven).toBe(false);
  });

  it('live: the current renderer re-applies its caps and the canvas re-sizes', () => {
    let applied = 0, sized = 0;
    const fake: Record<string, unknown> = {
      _indirectFirstInstance: true, _renderer3D: { applyDeviceCaps: () => { applied++; } }, _canvasSizedFor: {}, device: {},
      getDevice() { return {}; }, setCanvasSize() { sized++; },
    };
    proto.applyGpuCaps.call(fake, { ...MOBILE_CAPS });
    expect(applied).toBe(1);
    expect(sized).toBe(1);
  });

  it('setCanvasSize: mobile DPR cap; skips a no-op resize; desktop unchanged', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800 });
    let work = 0;
    const canvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width: 1280, height: 800 }) };
    const fake: Record<string, unknown> = {
      canvas, _gpuCaps: { ...MOBILE_CAPS }, _canvasSizedFor: null,
      interactionService: { updateWorldMatrix() { work++; }, setDepthTextureView() {}, viewportBounds: { markDirty() {} } },
      bgDirty: { res: false }, ensureLastFrameTex() {}, scheduleRender() {},
    };
    proto.setCanvasSize.call(fake, {});
    expect([canvas.width, canvas.height]).toEqual([1920, 1200]);   // DPR 2 → 1.5 (2.3 MP, under 2.5 MP)
    expect(work).toBe(1);
    proto.setCanvasSize.call(fake, {});                             // the second source (window resize): nothing changed
    expect(work).toBe(1);
    proto.setCanvasSize.call(fake, {}, true);                       // forced (new canvas / context)
    expect(work).toBe(2);
    fake._gpuCaps = { ...DESKTOP_CAPS };
    proto.setCanvasSize.call(fake, {});
    expect([canvas.width, canvas.height]).toEqual([2560, 1600]);   // desktop: the full DPR, as before
    expect(work).toBe(3);
  });

  it('setCanvasSize is a no-op while suspended (the Shell owns the canvas, UI-16); resumeRendering re-syncs', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800 });
    let work = 0, scheduled = 0;
    const canvas = { width: 1920, height: 1200, getBoundingClientRect: () => ({ width: 1280, height: 800 }) };
    const fake: Record<string, unknown> = {
      canvas, _gpuCaps: { ...DESKTOP_CAPS }, _canvasSizedFor: null, _suspended: true, device: {},
      interactionService: { updateWorldMatrix() { work++; }, setDepthTextureView() {}, viewportBounds: { markDirty() {} } },
      bgDirty: { res: false }, ensureLastFrameTex() {}, scheduleRender() { scheduled++; },
      context: { configure() {} }, swapChainFormat: 'bgra8unorm',
      getDevice() { return {}; },
      setCanvasSize(d: unknown, force?: boolean) { proto.setCanvasSize.call(fake, d, force); },
    };
    proto.setCanvasSize.call(fake, {});
    proto.setCanvasSize.call(fake, {}, true);                       // even forced: the Shell's sizing stands
    expect([canvas.width, canvas.height]).toEqual([1920, 1200]);
    expect(work).toBe(0);
    (WebGPURenderer.prototype as unknown as { resumeRendering(this: unknown): void }).resumeRendering.call(fake);
    expect(fake._suspended).toBe(false);
    expect([canvas.width, canvas.height]).toEqual([2560, 1600]);   // caught up on the change made while suspended
    expect(work).toBe(1);
    expect(scheduled).toBeGreaterThan(0);
  });
});
