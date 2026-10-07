import { describe, it, expect, vi, afterEach } from 'vitest';

// WebGPU bitflag globals aren't defined in the Node test env — Pipeline3D.createLayouts references them.
const _g = globalThis as Record<string, unknown>;
_g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
_g.GPUBufferUsage  ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
_g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

import { Pipeline3D } from './pipeline-3d';
import { GPUPipelineCache } from '../core/gpu-pipeline-cache';
import { SHADER_SPLIT, SHADER_SPLIT_DEFAULT, shaderSplitActive, type ShaderSplitMode } from './mesh-fs-pipelines';
import { setRenderDebug } from './render-debug';
import * as mesh3d from './shaders/mesh3d-shaders';
import * as skinning from './shaders/skinning-shaders';

// docs/specs/pipeline-warmup.md — verifies the deferred-pipeline warm logic WITHOUT a real GPU: a minimal fake
// device counts sync vs async pipeline compiles. (The actual shader compilation + no-freeze is browser-verified.)
// The contract under test: the constructor compiles only the CORE pipelines; the deferred groups (plain ×10,
// SSAO ×1, weight-paint ×2 = 13) compile lazily — either off-thread via warmDeferredAsync, or sync on demand.

function fakeDevice() {
  const calls = { sync: 0, async: 0, modules: [] as string[] };
  const dev = {
    createShaderModule:        (d: { code: string }) => { calls.modules.push(d.code); return {}; },
    createBindGroupLayout:     () => ({}),
    createPipelineLayout:      () => ({}),
    createSampler:             () => ({}),
    createRenderPipeline:      () => { calls.sync++;  return { id: `s${calls.sync}` }; },
    createRenderPipelineAsync: () => { calls.async++; return Promise.resolve({ id: `a${calls.async}` }); },
  };
  return { dev: dev as unknown as GPUDevice, calls };
}

const TOTAL = 37;   // every render pipeline: 18 core (+2 transparent doubleSided) + 10 plain + SSAO 1 + SSR peel 1 + SSR resolve/heal/feather 3 + weight-paint 2 + skinned shadow 1 (E1 tail c) + face-kit multiply 1
/** SHADER SPLIT: the uber-shader pipelines the split replaces (Pipeline3D._splitReplaced: opaque / no-cull x textured
 *  x full / plain x shadow 16, transparent 4, skinned 4, vertex colour, post-overlay, face-kit multiply, overlay card). */
const UBER = 28;
/** The split's boot warm: U / T BASE on the opaque + opaqueNoCull axes. */
const BASE_WARM = 4;

/** Run `fn` with the split mode `mode` (session only: no localStorage in node), then restore. */
async function withSplit<T>(mode: ShaderSplitMode, fn: () => Promise<T> | T): Promise<T> {
  const prev = SHADER_SPLIT.mode;
  SHADER_SPLIT.mode = mode;
  try { return await fn(); } finally { SHADER_SPLIT.mode = prev; }
}

/** The uber mesh fragment shader sources (every exported MESH3D_FRAGMENT_SHADER* / SKINNED_MESH3D_FRAGMENT_SHADER*
 *  except the weight-paint one, which is its own small shader). */
const UBER_SOURCES = new Set<string>([
  ...Object.entries(mesh3d).filter(([k, v]) => typeof v === 'string' && k.startsWith('MESH3D_FRAGMENT_SHADER')).map(([, v]) => v as string),
  ...Object.entries(skinning).filter(([k, v]) => typeof v === 'string' && k.startsWith('SKINNED_MESH3D_FRAGMENT_SHADER') && !k.includes('WEIGHT_PAINT')).map(([, v]) => v as string),
]);

describe('Pipeline3D granular warm-up (the shader split rolled back: today\'s uber pipelines)', () => {
  it('the constructor compiles NOTHING — every pipeline is registered lazily', () => {
    const { dev, calls } = fakeDevice();
    new Pipeline3D(dev);
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(0);
  });

  it('reading ONE getter compiles exactly ONE pipeline (granular — not the whole group)', () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.opaqueUntexturedPipeline;       // a 4-primitive scene pays for just what it draws
    expect(calls.sync).toBe(1);
    void p.opaqueUntexturedPlainPipeline;  // a different pipeline → one more
    expect(calls.sync).toBe(2);
    void p.opaqueUntexturedPipeline;       // re-read the first → cached, no compile
    expect(calls.sync).toBe(2);
  });

  it('warmAllAsync compiles EVERY pipeline OFF the main thread, none synchronously', () => withSplit('off', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL);
    expect(calls.sync).toBe(0);
    expect(p.uberPipelinesCompiled).toBe(UBER);
    expect(p.uberFragmentModules).toBe(12);   // the 12 uber FS modules, each created once (shared by its pipelines)
  }));

  it('warmAllAsync is idempotent + concurrent-safe — no double compile', () => withSplit('off', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await Promise.all([p.warmAllAsync(), p.warmAllAsync(), p.warmAllAsync()]);
    const after = calls.async;
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL);
    expect(calls.async).toBe(after);
  }));

  it('pipelines a getter already compiled are skipped by the warm (no recompile)', () => withSplit('off', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.opaqueTexturedPipeline;          // 1 sync
    void p.opaqueTexturedPlainPipeline;     // 1 sync
    expect(calls.sync).toBe(2);
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL - 2);    // warm compiles only the 35 the getters didn't
  }));

  it('P2: inside a LIVE frame a getter never blocks — null + one async compile, then the pipeline', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    const cache = GPUPipelineCache.for(dev);
    cache.frame(() => expect(p.skinnedOpaqueTexturedPlainPipeline).toBeNull());
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    cache.frame(() => expect(p.skinnedOpaqueTexturedPlainPipeline).toBeTruthy());
    expect(calls.sync).toBe(0);
  });

  it('P2.2: warmPipelines queues the named getters (unknown names ignored)', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    expect(p.handleOf('shadowPassPipeline')).toBeTruthy();
    expect(p.handleOf('opaqueTexturedNoCullPlainShadowPipeline')).toBeTruthy();
    expect(p.handleOf('noSuchPipeline')).toBeNull();
    p.warmPipelines(['shadowPassPipeline', 'opaqueUntexturedPlainPipeline', 'noSuchPipeline']);
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.async).toBe(2);
  });
});

describe('shader split phase 3: ON by default (shader-split.md §13)', () => {
  afterEach(() => { setRenderDebug({ reset: true }); });

  it('the default is ON: no stored mode = auto = on; the stored modes and the render-debug rollback', async () => {
    expect(SHADER_SPLIT_DEFAULT).toBe(true);
    expect(SHADER_SPLIT.mode).toBe('auto');   // (node: no localStorage)
    expect(shaderSplitActive()).toBe(true);
    await withSplit('on', () => expect(shaderSplitActive()).toBe(true));   // a stored 'on' (the tablet opt-in) is still on
    await withSplit('off', () => expect(shaderSplitActive()).toBe(false));   // the rollback
    setRenderDebug({ noShaderSplit: true });   // render debug "Shader split OFF (rollback; reload)"
    expect(shaderSplitActive()).toBe(false);
    await withSplit('on', () => expect(shaderSplitActive()).toBe(false));   // the debug rollback wins over a stored 'on'
    setRenderDebug({ reset: true });
    expect(shaderSplitActive()).toBe(true);
  });

  it('the stored localStorage value is read at load: on = on, off = off, missing / junk = the default (on)', async () => {
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* the rollback start-up warning */ });
    try {
      for (const [stored, active] of [['on', true], ['off', false], [null, true], ['junk', true]] as const) {
        const store = new Map<string, string>();
        if (stored !== null) store.set('salsa.shaderSplit', stored);
        g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
        vi.resetModules();
        const m = await import('./mesh-fs-pipelines');
        expect(m.SHADER_SPLIT.mode, String(stored)).toBe(stored === 'on' || stored === 'off' ? stored : 'auto');
        expect(m.shaderSplitActive(), String(stored)).toBe(active);
        if (stored === 'off') expect(warn.mock.calls.some((c) => String(c[0]).includes('OFF (rollback)'))).toBe(true);
        // sm.setShaderSplit3D({ mode: 'off' }) stores the rollback; 'auto' removes it (= on again)
        m.setShaderSplitMode('off');
        expect(store.get('salsa.shaderSplit')).toBe('off');
        expect(m.shaderSplitActive()).toBe(false);
        m.setShaderSplitMode('auto');
        expect(store.has('salsa.shaderSplit')).toBe(false);
        expect(m.shaderSplitActive()).toBe(true);
      }
    } finally {
      g.localStorage = prev;
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it('boot warm with the default: the BASE pipelines, NONE of the uber pipelines, and no uber fragment module created', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    expect(p.uberFragmentModules).toBe(0);   // construction creates no uber module (they are lazy)
    expect(calls.modules.some((c) => UBER_SOURCES.has(c))).toBe(false);
    await p.warmAllAsync();
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(TOTAL - UBER + BASE_WARM);   // the 9 non-mesh pipelines + the 4 BASE pipelines
    expect(p.uberPipelinesCompiled).toBe(0);
    expect(p.uberFragmentModules).toBe(0);
    expect(calls.modules.some((c) => UBER_SOURCES.has(c))).toBe(false);   // the driver never sees the ~120 KB strings
    const split = p.meshFs.stats();
    expect(split.ready).toBe(BASE_WARM);
    expect(split.list.map((e) => e.axis).sort()).toEqual(['opaque', 'opaque', 'opaqueNoCull', 'opaqueNoCull']);
    expect(split.list.every((e) => e.bytes < 40_000)).toBe(true);   // BASE is ~32-34 KB of WGSL (the uber: ~120 KB)
  });

  it('an uber pipeline still compiles on demand (an uncovered mesh / the rollback): its module is created then, once', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.opaqueTexturedPlainPipeline;
    void p.opaqueTexturedNoCullPlainPipeline;   // the same PlainTex module
    expect(calls.sync).toBe(2);
    expect(p.uberFragmentModules).toBe(1);
    expect(calls.modules.filter((c) => c === mesh3d.MESH3D_FRAGMENT_SHADER_PLAIN).length).toBe(1);
    expect(p.handleOf('opaqueTexturedPlainPipeline')!.descriptor().fragment!.module).toBe(p.handleOf('opaqueTexturedNoCullPlainPipeline')!.descriptor().fragment!.module);
  });

  it('safe / mobile tiers: the split is not tier-gated (on everywhere); the tiers only set its key cap', async () => {
    const { capsForTier } = await import('../core/gpu-capabilities');
    for (const t of ['desktop', 'mobile', 'safe'] as const) {
      const c = capsForTier(t) as unknown as Record<string, unknown>;
      expect(Object.keys(c).some((k) => /split/i.test(k) && k !== 'shaderSplitMaxKeys'), t).toBe(false);
      expect(c.shaderSplitMaxKeys, t).toBe(t === 'desktop' ? 96 : 40);
    }
    expect(shaderSplitActive()).toBe(true);
  });
});
