import { describe, it, expect } from 'vitest';
import { packIBLBakeParams, iblRowStrideTexels, iblSlabOffset, IBLGpuBaker, IBL_SH_EQ_W, IBL_SH_EQ_H } from './ibl-gpu-bake';
import { IBL_BAKE_SHADER } from './shaders/ibl-bake-shaders';
import { DEFAULT_SKY } from './procedural-sky';
import { cubeMipCount } from './ibl-specular-bake';

// The GPU bake itself is verified against the CPU reference in the headless browser (performance-plan P4.1); these
// pin the CPU-side contract the WGSL depends on.
describe('IBL GPU bake — host-side layout', () => {
  it('packs BakeParams in the WGSL struct order', () => {
    const p = packIBLBakeParams(DEFAULT_SKY, [0.1, 0.8, 0.3], 32, 6, 48);
    expect(p.length).toBe(28);
    expect(Array.from(p.slice(0, 4))).toEqual([...DEFAULT_SKY.zenith, DEFAULT_SKY.gradientBias].map(Math.fround));
    expect(p[7]).toBe(DEFAULT_SKY.intensity);
    expect(p[11]).toBe(Math.fround(DEFAULT_SKY.sunHalo));
    expect(p[15]).toBe(DEFAULT_SKY.sunSizeDeg);
    expect(Array.from(p.slice(16, 19))).toEqual([0.1, 0.8, 0.3].map(Math.fround));
    expect(Array.from(p.slice(20, 24))).toEqual([32, 6, 48, 64]);
    expect(Array.from(p.slice(24, 28))).toEqual([IBL_SH_EQ_W, IBL_SH_EQ_H, 128, 256]);
  });

  it('cube staging rows are 256-byte aligned and (mip, face) slabs never overlap', () => {
    for (const base of [8, 32, 64, 128]) {
      const stride = iblRowStrideTexels(base);
      expect((stride * 4) % 256).toBe(0);
      expect(stride).toBeGreaterThanOrEqual(base);
      const mips = cubeMipCount(base);
      let prevEnd = 0;
      for (let mip = 0; mip < mips; mip++) {
        const size = Math.max(1, base >> mip);
        for (let face = 0; face < 6; face++) {
          const off = iblSlabOffset(mip, face, base);
          expect(off).toBeGreaterThanOrEqual(prevEnd);
          prevEnd = off + (size - 1) * stride + size;   // last texel written by csPrefilter
        }
      }
      expect(prevEnd).toBeLessThanOrEqual(mips * 6 * stride * base);
    }
  });

  it('declares the three entry points the baker compiles, with matching bindings', () => {
    for (const ep of ['csSH9', 'csPrefilter', 'csBrdfLut']) expect(IBL_BAKE_SHADER).toMatch(new RegExp(`fn ${ep}\\(`));
    expect(IBL_BAKE_SHADER).toMatch(/@binding\(1\) var<storage, read_write> shOut: array<vec4f, 9>/);
    expect(IBL_BAKE_SHADER).not.toMatch(/`/);
  });

  it('reports unsupported for devices without async compute pipelines (CPU fallback)', () => {
    expect(IBLGpuBaker.supported(null)).toBe(false);
    expect(IBLGpuBaker.supported({} as GPUDevice)).toBe(false);
  });
});
