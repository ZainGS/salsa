/**
 * BloomPass — screen-space bloom for particle emitters.
 *
 * Draw order (all submitted before the main render pass encoder):
 *   1. captureParticles() — renders particles into rgba16float bloom source
 *   2. runBlur()          — separable 9-tap Gaussian H then V
 *
 * Then inside the main render pass:
 *   3. drawComposite()    — fullscreen additive blend of the blurred result
 *
 * The host (Renderer3D) calls captureParticles+runBlur via a separate
 * GPUCommandEncoder that is queue.submit()'d before the main pass encoder,
 * so the GPU sees the blurred texture when the composite quad is drawn.
 */

import { BLOOM_CAPTURE_FS, BLOOM_FULLSCREEN_VS, BLOOM_BLUR_FS, BLOOM_COMPOSITE_FS } from './shaders/bloom-shaders';
import { PARTICLE_VERTEX_SHADER } from './shaders/particle-shaders';
import type { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';

export class BloomPass {
  private device: GPUDevice;
  private swapChainFormat: GPUTextureFormat;

  // ── Offscreen textures ─────────────────────────────────────────────────
  private _w = 0;
  private _h = 0;

  /** rgba16float — bloom capture destination and final blur output. */
  sourceTexture:  GPUTexture | null = null;
  /** rgba16float — intermediate ping-pong target for the separable blur. */
  pingTexture:    GPUTexture | null = null;

  // ── Pipelines ──────────────────────────────────────────────────────────
  private _capturePipeline:   GPURenderPipeline | null = null;
  private _hBlurPipeline:     GPURenderPipeline | null = null;
  private _vBlurPipeline:     GPURenderPipeline | null = null;
  private _compositePipeline: GPURenderPipeline | null = null;

  // ── Bind group layouts ─────────────────────────────────────────────────
  // Capture reuses the caller-provided particle BGL0/BGL1 layouts.
  private _blurBGL:      GPUBindGroupLayout | null = null;
  private _compositeBGL: GPUBindGroupLayout | null = null;

  // ── Uniform buffers ────────────────────────────────────────────────────
  private _hStepBuf:    GPUBuffer | null = null;  // vec2f(1/w, 0)
  private _vStepBuf:    GPUBuffer | null = null;  // vec2f(0, 1/h)
  private _paramsBuf:   GPUBuffer | null = null;  // vec2f(threshold, intensity)

  // ── Bind group cache ───────────────────────────────────────────────────
  private _hBlurBG:      GPUBindGroup | null = null;
  private _vBlurBG:      GPUBindGroup | null = null;
  private _compositeBG:  GPUBindGroup | null = null;
  private _compositeTex: GPUTexture  | null = null; // tracks sourceTexture for BG invalidation

  // ── Config ─────────────────────────────────────────────────────────────
  threshold = 0.5;
  intensity = 1.2;

  constructor(device: GPUDevice, swapChainFormat: GPUTextureFormat) {
    this.device = device;
    this.swapChainFormat = swapChainFormat;
    this._initPipelines();
    this._paramsBuf = device.createBuffer({
      size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'BloomParams',
    });
    this._hStepBuf = device.createBuffer({
      size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'BloomHStep',
    });
    this._vStepBuf = device.createBuffer({
      size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'BloomVStep',
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  ensureTextures(w: number, h: number): void {
    if (this._w === w && this._h === h) return;
    this.sourceTexture?.destroy();
    this.pingTexture?.destroy();
    this.sourceTexture = this.device.createTexture({
      size: [w, h], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'BloomSource',
    });
    this.pingTexture = this.device.createTexture({
      size: [w, h], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'BloomPing',
    });
    this._w = w;
    this._h = h;
    this._hBlurBG = null;
    this._vBlurBG = null;
    this._compositeBG = null;
    // Upload step uniforms
    this.device.queue.writeBuffer(this._hStepBuf!, 0, new Float32Array([1 / w, 0]));
    this.device.queue.writeBuffer(this._vStepBuf!, 0, new Float32Array([0, 1 / h]));
  }

  /**
   * Submit bloom capture + blur as a separate command encoder (before main pass).
   * Caller must have already filled particleInstBuf and particleSceneUniBuf.
   */
  captureAndBlur(
    particleInstBuf:      GPUBuffer,
    particleSceneUniBuf:  GPUBuffer,
    particleBGL0:         GPUBindGroupLayout,
    particleBGL1:         GPUBindGroupLayout,
    capturePipeline:      GPURenderPipeline,
    active:               ParticleEmitter3D[],
    firstInstances:       number[],
    nearestSampler:       GPUSampler,
    atlasTexture:         GPUTexture,
  ): void {
    if (!this.sourceTexture || !this.pingTexture) return;

    const device = this.device;
    const encoder = device.createCommandEncoder({ label: 'BloomCapture' });

    // ── 1. Capture particles into sourceTexture ──────────────────────
    const bg0 = device.createBindGroup({
      layout: particleBGL0,
      entries: [
        { binding: 0, resource: { buffer: particleInstBuf } },
        { binding: 1, resource: { buffer: particleSceneUniBuf } },
      ],
    });
    const bg1 = device.createBindGroup({
      layout: particleBGL1,
      entries: [
        { binding: 0, resource: atlasTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: nearestSampler },
      ],
    });

    const capturePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.sourceTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    capturePass.setPipeline(capturePipeline);
    capturePass.setBindGroup(0, bg0);
    capturePass.setBindGroup(1, bg1);
    for (let i = 0; i < active.length; i++) {
      capturePass.draw(6, active[i].activeCount, 0, firstInstances[i]);
    }
    capturePass.end();

    // ── 2. H-blur: source → ping ──────────────────────────────────────
    this._runBlurPass(encoder, this.sourceTexture, this.pingTexture, this._hStepBuf!, nearestSampler);

    // ── 3. V-blur: ping → source ──────────────────────────────────────
    this._runBlurPass(encoder, this.pingTexture, this.sourceTexture, this._vStepBuf!, nearestSampler);

    device.queue.submit([encoder.finish()]);
  }

  /** Draw the blurred bloom additively in the currently open main render pass. */
  drawComposite(pass: GPURenderPassEncoder, nearestSampler: GPUSampler): void {
    if (!this._compositePipeline || !this.sourceTexture) return;

    // Update params uniform
    this.device.queue.writeBuffer(this._paramsBuf!, 0, new Float32Array([this.threshold, this.intensity]));

    // Invalidate bind group when source texture has changed (resize)
    if (this._compositeBG && this._compositeTex !== this.sourceTexture) {
      this._compositeBG = null;
    }
    if (!this._compositeBG) {
      this._compositeTex = this.sourceTexture;
      this._compositeBG = this.device.createBindGroup({
        layout: this._compositeBGL!,
        entries: [
          { binding: 0, resource: this.sourceTexture.createView() },
          { binding: 1, resource: nearestSampler },
          { binding: 2, resource: { buffer: this._paramsBuf! } },
        ],
      });
    }

    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compositeBG);
    pass.draw(3);
  }

  destroy(): void {
    this.sourceTexture?.destroy();
    this.pingTexture?.destroy();
    this._hStepBuf?.destroy();
    this._vStepBuf?.destroy();
    this._paramsBuf?.destroy();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private _runBlurPass(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dst: GPUTexture,
    stepBuf: GPUBuffer,
    sampler: GPUSampler,
  ): void {
    const bg = this.device.createBindGroup({
      layout: this._blurBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: stepBuf } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dst.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this._hBlurPipeline!);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private _initPipelines(): void {
    const device = this.device;

    // Shared BGL for blur passes: texture2d + sampler + step uniform
    this._blurBGL = device.createBindGroupLayout({
      label: 'BloomBlurBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler:  { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer:   { type: 'uniform' } },
      ],
    });

    this._compositeBGL = device.createBindGroupLayout({
      label: 'BloomCompositeBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler:  { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer:   { type: 'uniform' } },
      ],
    });

    const blurLayout = device.createPipelineLayout({ bindGroupLayouts: [this._blurBGL] });
    const compositeLayout = device.createPipelineLayout({ bindGroupLayouts: [this._compositeBGL] });

    const fullscreenVS = device.createShaderModule({ code: BLOOM_FULLSCREEN_VS, label: 'BloomFullscreenVS' });
    const blurFS       = device.createShaderModule({ code: BLOOM_BLUR_FS,       label: 'BloomBlurFS' });
    const compositeFS  = device.createShaderModule({ code: BLOOM_COMPOSITE_FS,  label: 'BloomCompositeFS' });

    const blurPrimitive: GPUPrimitiveState = { topology: 'triangle-list' };
    const blurTarget: GPUColorTargetState  = { format: 'rgba16float' };

    this._hBlurPipeline = device.createRenderPipeline({
      layout: blurLayout,
      vertex:   { module: fullscreenVS, entryPoint: 'vs_fullscreen' },
      fragment: { module: blurFS, entryPoint: 'fs_blur', targets: [blurTarget] },
      primitive: blurPrimitive,
      label: 'BloomHBlur',
    });

    // V-blur uses the same pipeline as H-blur (step direction comes from the uniform)
    this._vBlurPipeline = this._hBlurPipeline;

    this._compositePipeline = device.createRenderPipeline({
      layout: compositeLayout,
      vertex:   { module: fullscreenVS, entryPoint: 'vs_fullscreen' },
      fragment: {
        module:  compositeFS,
        entryPoint: 'fs_composite',
        targets: [{
          format: this.swapChainFormat,
          blend: {
            // Additive: src + dst (bloom adds on top of the scene)
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: blurPrimitive,
      label: 'BloomComposite',
    });
  }
}

/**
 * Build the bloom particle capture pipeline.
 * Separate from BloomPass constructor because it needs the caller's BGL0/BGL1.
 */
export function createBloomCapturePipeline(
  device: GPUDevice,
  particleBGL0: GPUBindGroupLayout,
  particleBGL1: GPUBindGroupLayout,
): GPURenderPipeline {
  const captureFS = device.createShaderModule({ code: BLOOM_CAPTURE_FS, label: 'BloomCaptureFS' });
  const vertexVS  = device.createShaderModule({ code: PARTICLE_VERTEX_SHADER, label: 'BloomCaptureVS' });

  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [particleBGL0, particleBGL1] }),
    vertex: { module: vertexVS, entryPoint: 'vs_particle' },
    fragment: {
      module: captureFS,
      entryPoint: 'fs_bloom_capture',
      targets: [{
        format: 'rgba16float',
        blend: {
          // Additive: accumulate contributions from all emitters
          color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    label: 'BloomCapturePipeline',
  });
}
