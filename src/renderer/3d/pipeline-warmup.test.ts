import { describe, it, expect } from 'vitest';

// WebGPU bitflag globals aren't defined in the Node test env — Pipeline3D.createLayouts references them.
const _g = globalThis as Record<string, unknown>;
_g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
_g.GPUBufferUsage  ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
_g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

import { Pipeline3D } from './pipeline-3d';
import { GPUPipelineCache } from '../core/gpu-pipeline-cache';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { meshFsAllKey, meshFsBaseKey } from './shaders/mesh-fs-key';

// docs/specs/pipeline-warmup.md — verifies the deferred-pipeline warm logic WITHOUT a real GPU: a minimal fake
// device counts sync vs async pipeline compiles. (The actual shader compilation + no-freeze is browser-verified.)
// The contract under test: the constructor compiles nothing; every pipeline compiles lazily — either off-thread via
// warmAllAsync, or sync on demand. Since shader-split phase 4 (2026-10-08) the registered set holds only the pipelines
// that do not shade meshes; the mesh pipelines are the split's generated (axis x key) pipelines.

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

/** The registered (non-mesh-shading) pipelines: shadow pass, skinned shadow, SSAO prepass, SSR peel, SSR resolve /
 *  heal / feather, weight paint lit / unlit. */
const REGISTERED = 9;
/** The split's boot warm: U / T BASE on the opaque + opaqueNoCull axes. */
const BASE_WARM = 4;

describe('Pipeline3D granular warm-up', () => {
  it('the constructor compiles NOTHING — every pipeline is registered lazily', () => {
    const { dev, calls } = fakeDevice();
    new Pipeline3D(dev);
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(0);
  });

  it('reading ONE getter compiles exactly ONE pipeline (granular — not the whole group)', () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.shadowPassPipeline;       // a scene pays for just what it draws
    expect(calls.sync).toBe(1);
    void p.ssaoPrepassPipeline;      // a different pipeline → one more
    expect(calls.sync).toBe(2);
    void p.shadowPassPipeline;       // re-read the first → cached, no compile
    expect(calls.sync).toBe(2);
  });

  it('warmAllAsync compiles the registered pipelines + the BASE mesh pipelines OFF the main thread, none synchronously', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await p.warmAllAsync();
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(REGISTERED + BASE_WARM);
    const split = p.meshFs.stats();
    expect(split.ready).toBe(BASE_WARM);
    expect(split.list.map((e) => e.axis).sort()).toEqual(['opaque', 'opaque', 'opaqueNoCull', 'opaqueNoCull']);
    expect(split.list.every((e) => e.bytes < 40_000)).toBe(true);   // BASE is ~32-34 KB of WGSL (the old uber-shader: ~120 KB)
    // the only mesh fragment modules the boot creates are the two BASE keys (one module per key, shared by both axes)
    const base = [false, true].map((tex) => generateMeshFs(meshFsBaseKey(tex, false, false, false)));
    for (const b of base) expect(calls.modules.filter((c) => c === b).length).toBe(1);
    const all = [false, true].map((tex) => generateMeshFs(meshFsAllKey(tex, false)));
    expect(calls.modules.some((c) => all.includes(c))).toBe(false);   // never *-ALL at boot
  });

  it('warmAllAsync is idempotent + concurrent-safe — no double compile', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await Promise.all([p.warmAllAsync(), p.warmAllAsync(), p.warmAllAsync()]);
    await GPUPipelineCache.for(dev).whenIdle();
    const after = calls.async;
    await p.warmAllAsync();
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.async).toBe(REGISTERED + BASE_WARM);
    expect(calls.async).toBe(after);
  });

  it('pipelines a getter already compiled are skipped by the warm (no recompile)', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.shadowPassPipeline;          // 1 sync
    void p.skinnedShadowPipeline;       // 1 sync
    expect(calls.sync).toBe(2);
    await p.warmAllAsync();
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.async).toBe(REGISTERED - 2 + BASE_WARM);   // warm compiles only the ones the getters didn't
  });

  it('P2: inside a LIVE frame a getter never blocks — null + one async compile, then the pipeline', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    const cache = GPUPipelineCache.for(dev);
    cache.frame(() => expect(p.skinnedShadowPipeline).toBeNull());
    expect(calls.sync).toBe(0);
    expect(calls.async).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    cache.frame(() => expect(p.skinnedShadowPipeline).toBeTruthy());
    expect(calls.sync).toBe(0);
  });

  it('P2.2: warmPipelines queues the named getters (unknown names ignored)', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    expect(p.handleOf('shadowPassPipeline')).toBeTruthy();
    expect(p.handleOf('skinnedWeightPaintPipeline')).toBeTruthy();
    expect(p.handleOf('noSuchPipeline')).toBeNull();
    p.warmPipelines(['shadowPassPipeline', 'skinnedShadowPipeline', 'noSuchPipeline']);
    await GPUPipelineCache.for(dev).whenIdle();
    expect(calls.async).toBe(2);
  });
});

describe('shader split phase 4: the generated pipelines are the only mesh pipelines (shader-split.md §14)', () => {
  it('no uber-shader pipeline is registered any more', () => {
    const { dev } = fakeDevice();
    const p = new Pipeline3D(dev);
    for (const n of ['opaqueTexturedPipeline', 'opaqueUntexturedPlainShadowPipeline', 'transparentTexturedNoCullPipeline', 'skinnedOpaqueTexturedPlainPipeline',
      'skinnedFaceMultiplyPipeline', 'opaqueVertexColorPipeline', 'postOverlayTexturedPipeline', 'overlayTexturedPipeline']) expect(p.handleOf(n), n).toBeNull();
  });

  it('a mesh key compiles on demand through the split registry (one module per key, shared by its axes)', () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    const k = { ...meshFsBaseKey(true, false, false, false), styles: 1 };
    p.meshFs.entry('opaque', k).h.getBlocking();
    p.meshFs.entry('opaqueNoCull', k).h.getBlocking();
    expect(calls.sync + calls.async).toBe(2);
    expect(calls.modules.filter((c) => c === generateMeshFs(k)).length).toBe(1);
  });

  it('safe / mobile tiers: the split is not tier-gated (it is the only path); the tiers only set its key cap', async () => {
    const { capsForTier } = await import('../core/gpu-capabilities');
    for (const t of ['desktop', 'mobile', 'safe'] as const) {
      const c = capsForTier(t) as unknown as Record<string, unknown>;
      expect(Object.keys(c).some((k) => /split|variant/i.test(k) && k !== 'shaderSplitMaxKeys'), t).toBe(false);
      expect(c.shaderSplitMaxKeys, t).toBe(t === 'desktop' ? 96 : 40);
    }
  });
});
