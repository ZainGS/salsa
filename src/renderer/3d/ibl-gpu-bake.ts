/**
 * GPU sky-lighting bake (docs/specs/performance-plan.md P4.1). Replaces the per-bake CPU work in the time-of-day
 * sky-lighting path — the 64x32 equirect + SH9 projection (~3 ms incl. the webp cache encode), the prefiltered
 * specular cube (~38 ms), and the one-off 128x128 BRDF LUT (~850 ms on first use) — with three compute dispatches.
 *
 * The CPU functions (procedural-sky.ts, ibl-specular-bake.ts, renderer-3d _computeSHCoeffs) stay the REFERENCE and
 * the FALLBACK (no WebGPU compute, pipeline still compiling, or a GPU error). The WGSL in shaders/ibl-bake-shaders.ts
 * mirrors that math line for line; results agree to ~1 LSB (verified in the headless browser, see the plan).
 *
 * Nothing is read back: SH9 is copied straight into the IBL uniform buffer (floats 0-35) and the cube / LUT bytes are
 * copied into their textures. All work is queue-ordered, so a bake submitted before the next frame is visible in it.
 *
 * Pipelines come from the P2 GPUPipelineCache (async compile, warmed at DOCUMENT priority when the renderer starts;
 * bumped to NOW if a bake is requested before they land). `ready` flips when all three resolve and the renderer
 * replays the latest pending bake.
 */
import { IBL_BAKE_SHADER } from './shaders/ibl-bake-shaders';
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
import type { ProceduralSkyParams } from './procedural-sky';

/** Equirect resolution the CPU SH reference integrates (bakeSkyEquirect defaults). */
export const IBL_SH_EQ_W = 64;
export const IBL_SH_EQ_H = 32;

/** Texels per padded buffer row: copyBufferToTexture needs bytesPerRow % 256 == 0 (64 RGBA8 texels). */
export function iblRowStrideTexels(baseSize: number): number { return Math.max(64, Math.ceil(baseSize / 64) * 64); }
/** u32 offset of the (mip, face) slab inside the cube staging buffer. */
export function iblSlabOffset(mip: number, face: number, baseSize: number): number {
  return (mip * 6 + face) * iblRowStrideTexels(baseSize) * baseSize;
}

/** Pack the bake uniforms (layout = BakeParams in the WGSL). */
export function packIBLBakeParams(
  sky: ProceduralSkyParams, sunDir: readonly [number, number, number],
  baseSize: number, mipCount: number, samples: number, lutSize = 128, lutSamples = 256,
): Float32Array {
  const p = new Float32Array(28);
  p.set([sky.zenith[0], sky.zenith[1], sky.zenith[2], sky.gradientBias], 0);
  p.set([sky.horizon[0], sky.horizon[1], sky.horizon[2], sky.intensity], 4);
  p.set([sky.ground[0], sky.ground[1], sky.ground[2], sky.sunHalo], 8);
  p.set([sky.sunColor[0], sky.sunColor[1], sky.sunColor[2], sky.sunSizeDeg], 12);
  p.set([sunDir[0], sunDir[1], sunDir[2], 0], 16);
  p.set([baseSize, mipCount, samples, iblRowStrideTexels(baseSize)], 20);
  p.set([IBL_SH_EQ_W, IBL_SH_EQ_H, lutSize, lutSamples], 24);
  return p;
}

export class IBLGpuBaker {
  /** True once all three compute pipelines have compiled. */
  ready = false;
  /** True if pipeline creation failed — callers stay on the CPU path for good. */
  failed = false;
  readonly whenReady: Promise<boolean>;

  private _sh: GPUComputePipeline | null = null;
  private _pre: GPUComputePipeline | null = null;
  private _lut: GPUComputePipeline | null = null;
  private _params: GPUBuffer;
  private _shBuf: GPUBuffer;
  private _cubeBuf: GPUBuffer | null = null;
  private _cubeBufBase = 0;
  private _lutBuf: GPUBuffer | null = null;

  /** Whether this device can run the GPU bake at all (compute + async pipeline creation). */
  static supported(device: GPUDevice | null | undefined): boolean {
    return !!device && typeof (device as { createComputePipelineAsync?: unknown }).createComputePipelineAsync === 'function'
      && typeof (device as { createComputePipeline?: unknown }).createComputePipeline === 'function'
      && typeof GPUBufferUsage !== 'undefined';
  }

  constructor(private readonly device: GPUDevice) {
    this._params = device.createBuffer({ size: 28 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'IBLBakeParams' });
    this._shBuf = device.createBuffer({ size: 9 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'IBLBakeSH' });
    let module: GPUShaderModule | null = null;
    const cache = GPUPipelineCache.for(device);
    const mk = (entryPoint: string) => cache.compute(() => ({
      layout: 'auto', compute: { module: module ??= device.createShaderModule({ code: IBL_BAKE_SHADER, label: 'IBLBakeShader' }), entryPoint },
      label: `IBLBake.${entryPoint}`,
    }), `IBLBake.${entryPoint}`, `ibl-bake:${entryPoint}`);
    this._handles = [mk('csSH9'), mk('csPrefilter'), mk('csBrdfLut')];
    this.whenReady = Promise.all(this._handles.map((h) => h.warm(PIPELINE_PRIORITY.DOCUMENT))).then(([a, b, c]) => {
      if (!a || !b || !c) { this.failed = true; console.warn('[IBLGpuBaker] compute pipeline creation failed - CPU bake fallback'); return false; }
      this._sh = a; this._pre = b; this._lut = c; this.ready = true; return true;
    }).catch((e) => { this.failed = true; console.warn('[IBLGpuBaker] compute pipeline creation failed - CPU bake fallback', e); return false; });
  }

  private _handles: PipelineHandle<GPUComputePipeline>[];
  /** A bake is waiting on the compiles: move them to the front of the warm queue. */
  hurry(): void { if (!this.ready) for (const h of this._handles) void h.warm(PIPELINE_PRIORITY.NOW); }

  private _ensureCubeBuf(baseSize: number): GPUBuffer {
    if (this._cubeBuf && this._cubeBufBase === baseSize) return this._cubeBuf;
    this._cubeBuf?.destroy();
    const mips = Math.floor(Math.log2(Math.max(1, baseSize))) + 1;
    this._cubeBuf = this.device.createBuffer({ size: mips * 6 * iblRowStrideTexels(baseSize) * baseSize * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'IBLBakeCube' });
    this._cubeBufBase = baseSize;
    return this._cubeBuf;
  }

  /**
   * Encode one sky bake. `shDst` (when given) receives the 9 packed SH vec4s at byte offset 0 (the IBL uniform
   * buffer). `cube` (when given) is the rgba8unorm-srgb cube texture with `mipCount` mips of `baseSize`. `lut` (when
   * given) is a `lutSize`-square rgba8unorm texture — pass it only on the first bake. Submits immediately.
   */
  bake(opts: {
    sky: ProceduralSkyParams; sunDir: readonly [number, number, number];
    shDst?: GPUBuffer | null;
    cube?: { tex: GPUTexture; baseSize: number; mipCount: number; samples: number } | null;
    lut?: { tex: GPUTexture; size: number; samples: number } | null;
  }): void {
    if (!this.ready || !this._sh || !this._pre || !this._lut) throw new Error('IBLGpuBaker not ready');
    const dev = this.device;
    const base = opts.cube?.baseSize ?? 32, mips = opts.cube?.mipCount ?? 6, samples = opts.cube?.samples ?? 48;
    dev.queue.writeBuffer(this._params, 0, packIBLBakeParams(opts.sky, opts.sunDir, base, mips, samples, opts.lut?.size ?? 128, opts.lut?.samples ?? 256));
    const enc = dev.createCommandEncoder({ label: 'IBLBake' });
    const pass = enc.beginComputePass({ label: 'IBLBake' });
    if (opts.shDst) {
      pass.setPipeline(this._sh);
      pass.setBindGroup(0, dev.createBindGroup({ layout: this._sh.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._params } }, { binding: 1, resource: { buffer: this._shBuf } }] }));
      pass.dispatchWorkgroups(1);
    }
    let cubeBuf: GPUBuffer | null = null;
    if (opts.cube) {
      cubeBuf = this._ensureCubeBuf(base);
      pass.setPipeline(this._pre);
      pass.setBindGroup(0, dev.createBindGroup({ layout: this._pre.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._params } }, { binding: 2, resource: { buffer: cubeBuf } }] }));
      pass.dispatchWorkgroups(Math.ceil(base / 8), Math.ceil(base / 8), mips * 6);
    }
    if (opts.lut) {
      const n = opts.lut.size;
      if (!this._lutBuf || this._lutBuf.size !== n * n * 4) {
        this._lutBuf?.destroy();
        this._lutBuf = dev.createBuffer({ size: n * n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'IBLBakeLUT' });
      }
      pass.setPipeline(this._lut);
      pass.setBindGroup(0, dev.createBindGroup({ layout: this._lut.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._params } }, { binding: 3, resource: { buffer: this._lutBuf } }] }));
      pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 1);
    }
    pass.end();
    if (opts.shDst) enc.copyBufferToBuffer(this._shBuf, 0, opts.shDst, 0, 9 * 16);
    if (opts.cube && cubeBuf) {
      const stride = iblRowStrideTexels(base) * 4;
      for (let mip = 0; mip < mips; mip++) {
        const size = Math.max(1, base >> mip);
        for (let face = 0; face < 6; face++) {
          enc.copyBufferToTexture(
            { buffer: cubeBuf, offset: iblSlabOffset(mip, face, base) * 4, bytesPerRow: stride, rowsPerImage: size },
            { texture: opts.cube.tex, mipLevel: mip, origin: [0, 0, face] }, [size, size, 1]);
        }
      }
    }
    if (opts.lut && this._lutBuf) {
      const n = opts.lut.size;
      enc.copyBufferToTexture({ buffer: this._lutBuf, bytesPerRow: n * 4, rowsPerImage: n }, { texture: opts.lut.tex }, [n, n, 1]);
    }
    dev.queue.submit([enc.finish()]);
  }

  /** Debug/verification: read back the last SH9 result (9 x [r,g,b,0]). Used by the headless CPU-vs-GPU check. */
  async readSH(): Promise<Float32Array> {
    const rb = this.device.createBuffer({ size: 144, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this._shBuf, 0, rb, 0, 144);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }

  /** Debug/verification: read back the packed cube staging buffer (u32 RGBA8 per texel, padded rows). */
  async readCube(): Promise<Uint32Array | null> {
    if (!this._cubeBuf) return null;
    const size = this._cubeBuf.size;
    const rb = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this._cubeBuf, 0, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }

  /** Debug/verification: read back the BRDF LUT staging buffer. */
  async readLUT(): Promise<Uint32Array | null> {
    if (!this._lutBuf) return null;
    const size = this._lutBuf.size;
    const rb = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this._lutBuf, 0, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    return out;
  }

  destroy(): void {
    this._params.destroy(); this._shBuf.destroy(); this._cubeBuf?.destroy(); this._lutBuf?.destroy();
    this._cubeBuf = null; this._lutBuf = null;
  }
}
