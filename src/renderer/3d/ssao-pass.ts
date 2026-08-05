/**
 * SSAOPass — owns the SSAO G-buffer + AO/blur/debug fullscreen passes.
 *
 * The GEOMETRY prepass (writing world position into `worldPosTarget`) is driven by Renderer3D using
 * `pipeline.ssaoPrepassPipeline` (it needs the shared mesh vertex layout + scene bind group). This
 * class owns everything downstream: the AO estimate, the depth-aware blur, and the debug blit.
 *
 * Textures:
 *   worldPos   rgba32float  (world position per pixel; .w = 1 surface / 0 background) — unfilterable
 *   prepass Z  depth24plus  (so the prepass keeps the nearest surface)
 *   aoRaw      r8unorm      (AO estimate)
 *   aoBlur     r8unorm      (blurred AO — the buffer sampled by lighting / debug)
 *
 * Everything is gated by Renderer3D: when SSAO is off, none of these allocate and no pass runs.
 * Spec: docs/specs/ssao.md.
 */

import { SSAO_AO_SHADER, SSAO_BLUR_SHADER, SSAO_DEBUG_SHADER } from './shaders/ssao-shaders';

export interface SSAOConfig {
  enabled: boolean;
  /** Sample radius in WORLD units (default 0.6 — a couple of city detail-widths). */
  radius: number;
  /** Occlusion strength multiplier (0..2, default 1.0). */
  intensity: number;
  /** World-space depth bias to avoid self-occlusion acne (default 0.02). */
  bias: number;
  /** Contrast curve on the AO term (default 1.5 — punches up creases). */
  power: number;
  /** PERF: render the AO prepass + AO + blur at this fraction of canvas res (0.5 = half-res = ~4x cheaper; the AO
   *  is low-frequency so the linear upsample in the mesh shader is nearly invisible). 1.0 = full res. Default 0.5. */
  resolutionScale: number;
  /** PERF: hemisphere sample count per pixel (quality ↔ cost; the blur hides fewer-sample noise). Default 8. */
  samples: number;
}

export const DEFAULT_SSAO_CONFIG: SSAOConfig = {
  enabled: false, radius: 0.6, intensity: 1.0, bias: 0.02, power: 1.5, resolutionScale: 0.5, samples: 8,
};

export class SSAOPass {
  private device: GPUDevice;
  private swapFormat: GPUTextureFormat;

  private _worldPosTex: GPUTexture | null = null;
  private _prepassDepthTex: GPUTexture | null = null;
  private _aoRawTex: GPUTexture | null = null;
  private _aoBlurTex: GPUTexture | null = null;
  private _w = 0;
  private _h = 0;

  private readonly _aoParamsBuf: GPUBuffer;   // 112 bytes (28 floats)
  private readonly _blurParamsBuf: GPUBuffer; // 16 bytes
  private readonly _aoScratch = new Float32Array(28);
  private readonly _blurScratch = new Float32Array(4);

  private readonly _sampler: GPUSampler;      // non-filtering (rgba32float is unfilterable)

  private readonly _aoBGL: GPUBindGroupLayout;
  private readonly _blurBGL: GPUBindGroupLayout;
  private readonly _debugBGL: GPUBindGroupLayout;
  private readonly _aoPipeline: GPURenderPipeline;
  private readonly _blurPipeline: GPURenderPipeline;
  private readonly _debugPipeline: GPURenderPipeline;

  // Bind groups (rebuilt on resize, since the texture views change)
  private _aoBG: GPUBindGroup | null = null;
  private _blurBG: GPUBindGroup | null = null;
  private _debugBG: GPUBindGroup | null = null;

  public config: SSAOConfig = { ...DEFAULT_SSAO_CONFIG };

  constructor(device: GPUDevice, swapFormat: GPUTextureFormat) {
    this.device = device;
    this.swapFormat = swapFormat;

    this._aoParamsBuf   = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'SSAOAOParams' });
    this._blurParamsBuf = device.createBuffer({ size: 16,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'SSAOBlurParams' });
    this._sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const uni   = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
    const texF  = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } });
    const texUF = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } });
    const samp  = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } });

    this._aoBGL    = device.createBindGroupLayout({ label: 'SSAOAOBGL',    entries: [uni(0), texUF(1), samp(2)] });
    this._blurBGL  = device.createBindGroupLayout({ label: 'SSAOBlurBGL',  entries: [uni(0), texF(1), texUF(2), samp(3)] });
    this._debugBGL = device.createBindGroupLayout({ label: 'SSAODebugBGL', entries: [texF(0), samp(1)] });

    const mk = (code: string, label: string, bgl: GPUBindGroupLayout, format: GPUTextureFormat): GPURenderPipeline => {
      const mod = device.createShaderModule({ code, label });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex:   { module: mod, entryPoint: 'vs_main' },
        fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    this._aoPipeline    = mk(SSAO_AO_SHADER,    'SSAOAO',    this._aoBGL,    'r8unorm');
    this._blurPipeline  = mk(SSAO_BLUR_SHADER,  'SSAOBlur',  this._blurBGL,  'r8unorm');

    // Debug pipeline draws the AO buffer straight INTO the main scene pass (last thing in drawMeshes), so it
    // must match that pass's colour (swap) + depth (depth24plus-stencil8) attachments. depthCompare 'always'
    // + no write → it overwrites the scene regardless of depth, purely for verification.
    const dbgMod = device.createShaderModule({ code: SSAO_DEBUG_SHADER, label: 'SSAODebug' });
    this._debugPipeline = device.createRenderPipeline({
      label: 'SSAODebugPipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._debugBGL] }),
      vertex:   { module: dbgMod, entryPoint: 'vs_main' },
      fragment: { module: dbgMod, entryPoint: 'fs_main', targets: [{ format: swapFormat }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  /** (Re)allocate the SSAO targets for a given CANVAS size. All four buffers (+ the geometry prepass they're filled
   *  by) run at `resolutionScale` × canvas → half-res quarters the fragment/bandwidth/blur cost. Guards on the SCALED
   *  size so it re-allocates on both a canvas resize AND a resolutionScale change. Cheap no-op when unchanged. */
  ensureTextures(w: number, h: number): void {
    const scale = this.config.resolutionScale > 0 ? this.config.resolutionScale : 0.5;
    const rw = Math.max(1, Math.round(w * scale)), rh = Math.max(1, Math.round(h * scale));
    if (this._w === rw && this._h === rh && this._worldPosTex) return;
    this._destroyTextures();
    this._w = rw; this._h = rh;
    const att = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this._worldPosTex     = this.device.createTexture({ size: [rw, rh], format: 'rgba32float',      usage: att, label: 'SSAOWorldPos' });
    this._prepassDepthTex = this.device.createTexture({ size: [rw, rh], format: 'depth24plus',      usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'SSAOPrepassDepth' });
    this._aoRawTex        = this.device.createTexture({ size: [rw, rh], format: 'r8unorm',          usage: att, label: 'SSAOAORaw' });
    this._aoBlurTex       = this.device.createTexture({ size: [rw, rh], format: 'r8unorm',          usage: att, label: 'SSAOAOBlur' });
    this._aoBG = null; this._blurBG = null; this._debugBG = null;
  }

  /** The prepass render target (world position) + its depth — Renderer3D renders geometry into these. */
  worldPosTargetView(): GPUTextureView { return this._worldPosTex!.createView(); }
  prepassDepthView(): GPUTextureView { return this._prepassDepthTex!.createView(); }
  /** The blurred AO buffer — sampled by the lighting pass (stage 2) and the debug blit. */
  aoBlurView(): GPUTextureView { return this._aoBlurTex!.createView(); }
  /** The blurred AO texture object (null until ensureTextures). For bind-group identity tracking. */
  aoBlurTexture(): GPUTexture | null { return this._aoBlurTex; }

  /** Upload the per-frame AO uniforms (world→clip matrix, camera pos + sample count, params, texel). Texel uses the
   *  SCALED buffer dims (this._w/_h) so the AO + blur sample the half-res targets correctly. */
  updateAOParams(viewProjection: Float32Array, camX: number, camY: number, camZ: number): void {
    const w = this._w, h = this._h;
    const s = this._aoScratch;
    s.set(viewProjection, 0);                                   // 0..15
    // cameraPos.xyz + .w = hemisphere SAMPLE COUNT (a free slot — kept the buffer size, no resize).
    s[16] = camX; s[17] = camY; s[18] = camZ; s[19] = Math.max(4, Math.min(64, Math.round(this.config.samples || 8)));
    s[20] = this.config.radius; s[21] = this.config.intensity; s[22] = this.config.bias; s[23] = this.config.power;
    s[24] = 1 / w; s[25] = 1 / h; s[26] = w; s[27] = h;         // texel (scaled buffer size)
    this.device.queue.writeBuffer(this._aoParamsBuf, 0, s);
    const b = this._blurScratch; b[0] = 1 / w; b[1] = 1 / h; b[2] = 0; b[3] = 0;
    this.device.queue.writeBuffer(this._blurParamsBuf, 0, b);
  }

  /** Run AO estimate + depth-aware blur. Call AFTER the geometry prepass has filled the world G-buffer. */
  runAO(encoder: GPUCommandEncoder): void {
    if (!this._aoBG) {
      this._aoBG = this.device.createBindGroup({ layout: this._aoBGL, entries: [
        { binding: 0, resource: { buffer: this._aoParamsBuf } },
        { binding: 1, resource: this._worldPosTex!.createView() },
        { binding: 2, resource: this._sampler },
      ]});
    }
    this._runFull(encoder, this._aoPipeline, this._aoBG, this._aoRawTex!.createView(), 'SSAOAOPass');

    if (!this._blurBG) {
      this._blurBG = this.device.createBindGroup({ layout: this._blurBGL, entries: [
        { binding: 0, resource: { buffer: this._blurParamsBuf } },
        { binding: 1, resource: this._aoRawTex!.createView() },
        { binding: 2, resource: this._worldPosTex!.createView() },
        { binding: 3, resource: this._sampler },
      ]});
    }
    this._runFull(encoder, this._blurPipeline, this._blurBG, this._aoBlurTex!.createView(), 'SSAOBlurPass');
  }

  /** Draw the AO buffer as greyscale INTO an active scene render pass — the verification view. */
  drawDebug(pass: GPURenderPassEncoder): void {
    if (!this._aoBlurTex) return;
    if (!this._debugBG) {
      this._debugBG = this.device.createBindGroup({ layout: this._debugBGL, entries: [
        { binding: 0, resource: this._aoBlurTex.createView() },
        { binding: 1, resource: this._sampler },
      ]});
    }
    pass.setPipeline(this._debugPipeline);
    pass.setBindGroup(0, this._debugBG);
    pass.draw(3);
  }

  private _runFull(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bg: GPUBindGroup, dst: GPUTextureView, label: string): void {
    const pass = encoder.beginRenderPass({ label, colorAttachments: [{ view: dst, loadOp: 'clear', clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private _destroyTextures(): void {
    this._worldPosTex?.destroy(); this._prepassDepthTex?.destroy();
    this._aoRawTex?.destroy(); this._aoBlurTex?.destroy();
    this._worldPosTex = null; this._prepassDepthTex = null; this._aoRawTex = null; this._aoBlurTex = null;
  }

  destroy(): void {
    this._destroyTextures();
    this._aoParamsBuf.destroy();
    this._blurParamsBuf.destroy();
  }
}
