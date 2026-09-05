import { describe, it, expect } from 'vitest';

// WebGPU bitflag globals aren't defined in the Node test env — Pipeline3D.createLayouts references them.
const _g = globalThis as Record<string, unknown>;
_g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
_g.GPUBufferUsage  ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
_g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

import { Pipeline3D } from './pipeline-3d';

// docs/specs/pipeline-warmup.md — verifies the deferred-pipeline warm logic WITHOUT a real GPU: a minimal fake
// device counts sync vs async pipeline compiles. (The actual shader compilation + no-freeze is browser-verified.)
// The contract under test: the constructor compiles only the CORE pipelines; the deferred groups (plain ×10,
// SSAO ×1, weight-paint ×2 = 13) compile lazily — either off-thread via warmDeferredAsync, or sync on demand.

function fakeDevice() {
  const calls = { sync: 0, async: 0 };
  const dev = {
    createShaderModule:        () => ({}),
    createBindGroupLayout:     () => ({}),
    createPipelineLayout:      () => ({}),
    createSampler:             () => ({}),
    createRenderPipeline:      () => { calls.sync++;  return { id: `s${calls.sync}` }; },
    createRenderPipelineAsync: () => { calls.async++; return Promise.resolve({ id: `a${calls.async}` }); },
  };
  return { dev: dev as unknown as GPUDevice, calls };
}

const TOTAL = 32;   // every render pipeline: 18 core (+2 transparent doubleSided) + 10 plain + SSAO 1 + SSR peel 1 + weight-paint 2

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
    void p.opaqueUntexturedPipeline;       // a 4-primitive scene pays for just what it draws
    expect(calls.sync).toBe(1);
    void p.opaqueUntexturedPlainPipeline;  // a different pipeline → one more
    expect(calls.sync).toBe(2);
    void p.opaqueUntexturedPipeline;       // re-read the first → cached, no compile
    expect(calls.sync).toBe(2);
  });

  it('warmAllAsync compiles EVERY pipeline OFF the main thread, none synchronously', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL);
    expect(calls.sync).toBe(0);
  });

  it('warmAllAsync is idempotent + concurrent-safe — no double compile', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    await Promise.all([p.warmAllAsync(), p.warmAllAsync(), p.warmAllAsync()]);
    const after = calls.async;
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL);
    expect(calls.async).toBe(after);
  });

  it('pipelines a getter already compiled are skipped by the warm (no recompile)', async () => {
    const { dev, calls } = fakeDevice();
    const p = new Pipeline3D(dev);
    void p.opaqueTexturedPipeline;          // 1 sync
    void p.opaqueTexturedPlainPipeline;     // 1 sync
    expect(calls.sync).toBe(2);
    await p.warmAllAsync();
    expect(calls.async).toBe(TOTAL - 2);    // warm compiles only the 27 the getters didn't
  });
});
