/**
 * PostProcessPass — scene post-processing stack for the 3D renderer.
 *
 * Plugs in between passEncoder.end() and the final copyTextureToTexture:
 *   1. Bloom    — bright-pixel extract → Gaussian blur → additive composite
 *   2. Color grade — brightness / contrast / saturation / tint
 *   3. Vignette — radial darkening at edges
 *
 * Passes 2 and 3 run as a single combined shader to avoid an extra full-screen
 * render per effect. When all effects are disabled, run() returns null and the
 * caller copies lastFrameTex directly (no overhead).
 *
 * Source texture:  bgra8unorm (lastFrameTex, requires TEXTURE_BINDING usage)
 * Bloom textures:  rgba16float (intermediate, for HDR bloom accumulation)
 * Output textures: bgra8unorm (ping-pong pair, caller copies result to swapchain)
 */

import {
  PP_FULLSCREEN_VS,
  PP_BLOOM_EXTRACT_FS,
  PP_BLUR_FS,
  PP_BLOOM_COMPOSITE_FS,
  PP_GRADE_VIG_FS,
} from './shaders/post-process-shaders';

// ── Public config types ────────────────────────────────────────────────────────

export interface BloomConfig {
  enabled: boolean;
  /** Luminance threshold for bright-pixel extraction (0–1, default 0.8). */
  threshold: number;
  /** Bloom intensity multiplier (default 1.0). */
  intensity: number;
}

export interface ColorGradeConfig {
  enabled: boolean;
  /** Additive brightness offset, –1 to +1 (default 0). */
  brightness: number;
  /** Contrast multiplier modifier, –1 to +1 (default 0). */
  contrast: number;
  /** Saturation modifier, –1 to +1 (default 0). */
  saturation: number;
  /** Per-channel RGB tint multiplier (default [1,1,1]). */
  tint: [number, number, number];
}

export interface VignetteConfig {
  enabled: boolean;
  /** Vignette darkening strength, 0–1 (default 0.5). */
  intensity: number;
  /** Normalized radius at which vignette starts, 0–1 (default 0.75). */
  radius: number;
  /** Edge softness, 0–1 (default 0.45). */
  softness: number;
}

export interface PostProcessConfig {
  bloom: BloomConfig;
  colorGrade: ColorGradeConfig;
  vignette: VignetteConfig;
}

export const DEFAULT_POST_PROCESS_CONFIG: PostProcessConfig = {
  bloom:      { enabled: false, threshold: 0.8, intensity: 1.0 },
  colorGrade: { enabled: false, brightness: 0.0, contrast: 0.0, saturation: 0.0, tint: [1, 1, 1] },
  vignette:   { enabled: false, intensity: 0.5, radius: 0.75, softness: 0.45 },
};

// ── PostProcessPass ────────────────────────────────────────────────────────────

export class PostProcessPass {
  private device: GPUDevice;
  private swapFormat: GPUTextureFormat;

  // ── Ping-pong output textures (bgra8unorm) ────────────────────────────────
  private _pingTex: GPUTexture | null = null;
  private _pongTex: GPUTexture | null = null;

  // ── Bloom intermediate textures (rgba16float) ─────────────────────────────
  private _bloomExtractTex: GPUTexture | null = null;
  private _bloomBlurTex:    GPUTexture | null = null;

  private _texW = 0;
  private _texH = 0;

  // ── Pipelines ─────────────────────────────────────────────────────────────
  private _bloomExtractPipeline:   GPURenderPipeline;
  private _bloomCompositePipeline: GPURenderPipeline;
  private _blurPipeline:           GPURenderPipeline;
  private _gradeVigPipeline:       GPURenderPipeline;
  private readonly _sampler:       GPUSampler;   // reused linear sampler (was created every frame in run())

  // ── Bind group layouts ────────────────────────────────────────────────────
  private _extractBGL:   GPUBindGroupLayout;
  private _blurBGL:      GPUBindGroupLayout;
  private _compositeBGL: GPUBindGroupLayout;
  private _gradeVigBGL:  GPUBindGroupLayout;

  // ── Uniform buffers ───────────────────────────────────────────────────────
  /** vec4f (.x=threshold, .y=intensity) — shared by extract and composite. */
  private _bloomParamsBuf: GPUBuffer;
  /** vec2f step direction — written before each blur pass. */
  private _hStepBuf: GPUBuffer;
  private _vStepBuf: GPUBuffer;
  /** GradeVigParams struct (48 bytes). */
  private _gradeVigBuf: GPUBuffer;

  // ── Bind group cache ──────────────────────────────────────────────────────
  // Keyed on source texture identity so bind groups survive frame-to-frame
  // without recreation unless a resize happens.
  private _extractBG:     GPUBindGroup | null = null;
  private _extractBGSrc:  GPUTexture   | null = null;

  private _compositeBG:     GPUBindGroup | null = null;
  private _compositeBGSrc:  GPUTexture   | null = null;
  private _compositeBGBloom: GPUTexture  | null = null;

  private _gradeVigBG:     GPUBindGroup | null = null;
  private _gradeVigBGSrc:  GPUTexture   | null = null;

  // PERF (audit 5.9): blur bind groups were the only uncached peers — rebuilt on
  // every invocation. Keyed by step buffer (H vs V, both persistent) with the
  // source texture tracked for invalidation; cleared wholesale on resize.
  private readonly _blurBGCache = new Map<GPUBuffer, { src: GPUTexture; bg: GPUBindGroup }>();

  // ── Config ────────────────────────────────────────────────────────────────
  public config: PostProcessConfig;

  constructor(device: GPUDevice, swapFormat: GPUTextureFormat) {
    this.device = device;
    this.swapFormat = swapFormat;
    this.config = {
      bloom:      { ...DEFAULT_POST_PROCESS_CONFIG.bloom },
      colorGrade: { ...DEFAULT_POST_PROCESS_CONFIG.colorGrade, tint: [...DEFAULT_POST_PROCESS_CONFIG.colorGrade.tint] as [number,number,number] },
      vignette:   { ...DEFAULT_POST_PROCESS_CONFIG.vignette },
    };

    // Uniform buffers
    this._bloomParamsBuf = device.createBuffer({ size: 16,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPBloomParams' });
    this._hStepBuf       = device.createBuffer({ size: 8,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPHStep' });
    this._vStepBuf       = device.createBuffer({ size: 8,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPVStep' });
    this._gradeVigBuf    = device.createBuffer({ size: 48,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPGradeVig' });

    // Bind group layouts
    const tex2d   = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } });
    const samp    = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
    const uniform = (b: number): GPUBindGroupLayoutEntry => ({ binding: b, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } });

    this._extractBGL = device.createBindGroupLayout({
      label: 'PPExtractBGL',
      entries: [tex2d(0), samp(1), uniform(2)],
    });
    this._blurBGL = device.createBindGroupLayout({
      label: 'PPBlurBGL',
      entries: [tex2d(0), samp(1), uniform(2)],
    });
    this._compositeBGL = device.createBindGroupLayout({
      label: 'PPCompositeBGL',
      entries: [tex2d(0), tex2d(1), samp(2), uniform(3)],
    });
    this._gradeVigBGL = device.createBindGroupLayout({
      label: 'PPGradeVigBGL',
      entries: [tex2d(0), samp(1), uniform(2)],
    });

    // Pipelines
    const vs = device.createShaderModule({ code: PP_FULLSCREEN_VS, label: 'PPFullscreenVS' });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const prim: GPUPrimitiveState = { topology: 'triangle-list' };

    // Bloom extract: outputs rgba16float
    this._bloomExtractPipeline = device.createRenderPipeline({
      label: 'PPBloomExtract',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._extractBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: PP_BLOOM_EXTRACT_FS, label: 'PPBloomExtractFS' }),
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: prim,
    });

    // Blur: rgba16float → rgba16float (H and V share same pipeline; step direction in uniform)
    this._blurPipeline = device.createRenderPipeline({
      label: 'PPBlur',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._blurBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: PP_BLUR_FS, label: 'PPBlurFS' }),
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: prim,
    });

    // Bloom composite: outputs to swapchain format
    this._bloomCompositePipeline = device.createRenderPipeline({
      label: 'PPBloomComposite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._compositeBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: PP_BLOOM_COMPOSITE_FS, label: 'PPBloomCompositeFS' }),
        entryPoint: 'fs_main',
        targets: [{ format: swapFormat }],
      },
      primitive: prim,
    });

    // Grade+vignette: outputs to swapchain format
    this._gradeVigPipeline = device.createRenderPipeline({
      label: 'PPGradeVig',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._gradeVigBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: PP_GRADE_VIG_FS, label: 'PPGradeVigFS' }),
        entryPoint: 'fs_main',
        targets: [{ format: swapFormat }],
      },
      primitive: prim,
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run all enabled post-process effects into a bgra8unorm output texture.
   * Returns the output texture if any effect ran, or null if everything is disabled.
   * The caller should copy the returned texture to the swapchain (instead of lastFrameTex).
   */
  run(encoder: GPUCommandEncoder, srcTex: GPUTexture, w: number, h: number): GPUTexture | null {
    const bloomOn = this.config.bloom.enabled;
    const gradeOn = this.config.colorGrade.enabled;
    const vigOn   = this.config.vignette.enabled;

    if (!bloomOn && !gradeOn && !vigOn) return null;

    this._ensureTextures(w, h, bloomOn);
    this._uploadUniforms(w, h);

    const sampler = this._sampler;   // reused (was device.createSampler every frame)

    let currentSrc: GPUTexture = srcTex;
    let pingIdx = 0;  // which output tex to write into next

    if (bloomOn) {
      // Extract bright pixels from scene → _bloomExtractTex
      this._runExtract(encoder, currentSrc, sampler);

      // H-blur: _bloomExtractTex → _bloomBlurTex
      this._runBlurPass(encoder, this._bloomExtractTex!, this._bloomBlurTex!, this._hStepBuf, sampler);

      // V-blur: _bloomBlurTex → _bloomExtractTex
      this._runBlurPass(encoder, this._bloomBlurTex!, this._bloomExtractTex!, this._vStepBuf, sampler);

      // Composite scene + blurred bloom → output ping-pong tex
      const dst = pingIdx === 0 ? this._pingTex! : this._pongTex!;
      this._runBloomComposite(encoder, currentSrc, this._bloomExtractTex!, dst, sampler);
      currentSrc = dst;
      pingIdx++;
    }

    if (gradeOn || vigOn) {
      const dst = pingIdx === 0 ? this._pingTex! : this._pongTex!;
      this._runGradeVig(encoder, currentSrc, dst, sampler);
      currentSrc = dst;
      pingIdx++;
    }

    return currentSrc;
  }

  destroy(): void {
    this._pingTex?.destroy();
    this._pongTex?.destroy();
    this._bloomExtractTex?.destroy();
    this._bloomBlurTex?.destroy();
    this._bloomParamsBuf.destroy();
    this._hStepBuf.destroy();
    this._vStepBuf.destroy();
    this._gradeVigBuf.destroy();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _ensureTextures(w: number, h: number, bloomOn: boolean): void {
    if (this._texW !== w || this._texH !== h) {
      this._pingTex?.destroy();
      this._pongTex?.destroy();
      this._bloomExtractTex?.destroy();
      this._bloomBlurTex?.destroy();
      // PERF (audit 5.5): the rgba16float pair is bloom-only; drop it on resize
      // and let the lazy block below recreate it only when bloom is enabled.
      this._bloomExtractTex = null;
      this._bloomBlurTex = null;

      const swapUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

      this._pingTex = this.device.createTexture({ size: [w, h], format: this.swapFormat, usage: swapUsage, label: 'PPPing' });
      this._pongTex = this.device.createTexture({ size: [w, h], format: this.swapFormat, usage: swapUsage, label: 'PPPong' });

      this._texW = w;
      this._texH = h;

      // Invalidate all bind group caches on resize
      this._extractBG    = null;
      this._compositeBG  = null;
      this._gradeVigBG   = null;
      this._extractBGSrc = null;
      this._compositeBGSrc = null;
      this._compositeBGBloom = null;
      this._gradeVigBGSrc = null;
      this._blurBGCache.clear();

      // Upload blur step uniforms
      this.device.queue.writeBuffer(this._hStepBuf, 0, new Float32Array([1 / w, 0]));
      this.device.queue.writeBuffer(this._vStepBuf, 0, new Float32Array([0, 1 / h]));
    }

    // PERF (audit 5.5): both full-res rgba16float bloom intermediates used to
    // allocate even on the vignette/grade-only path. Allocate lazily, first
    // frame bloom actually runs. The composite bind group keys on the bloom
    // texture identity (_compositeBGBloom), so a fresh texture here
    // auto-invalidates it; the blur cache keys on src identity likewise.
    if (bloomOn && (!this._bloomExtractTex || !this._bloomBlurTex)) {
      const hdrUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this._bloomExtractTex = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: hdrUsage, label: 'PPBloomExtract' });
      this._bloomBlurTex    = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: hdrUsage, label: 'PPBloomBlur' });
    }
  }

  private readonly _bloomParams = new Float32Array(4);    // reused uniform scratch (was fresh arrays/frame)
  private readonly _gradeVigParams = new Float32Array(12);
  private _uploadUniforms(w: number, h: number): void {
    void w; void h;

    // Bloom params: (threshold, intensity, 0, 0)
    const bp = this._bloomParams;
    bp[0] = this.config.bloom.threshold; bp[1] = this.config.bloom.intensity; bp[2] = 0; bp[3] = 0;
    this.device.queue.writeBuffer(this._bloomParamsBuf, 0, bp);

    // Grade+vignette params (48 bytes = 12 floats)
    const { colorGrade: g, vignette: v } = this.config;
    const gv = this._gradeVigParams;
    gv[0] = g.brightness; gv[1] = g.contrast; gv[2] = g.saturation; gv[3] = v.intensity;
    gv[4] = g.tint[0]; gv[5] = g.tint[1]; gv[6] = g.tint[2]; gv[7] = v.radius;
    gv[8] = v.softness; gv[9] = 0; gv[10] = 0; gv[11] = 0;
    this.device.queue.writeBuffer(this._gradeVigBuf, 0, gv);
  }

  private _runExtract(encoder: GPUCommandEncoder, srcTex: GPUTexture, sampler: GPUSampler): void {
    if (!this._extractBG || this._extractBGSrc !== srcTex) {
      this._extractBG = this.device.createBindGroup({
        layout: this._extractBGL,
        entries: [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: this._bloomParamsBuf } },
        ],
      });
      this._extractBGSrc = srcTex;
    }

    const pass = encoder.beginRenderPass({
      label: 'PPBloomExtractPass',
      colorAttachments: [{ view: this._bloomExtractTex!.createView(), loadOp: 'clear', clearValue: { r:0,g:0,b:0,a:0 }, storeOp: 'store' }],
    });
    pass.setPipeline(this._bloomExtractPipeline);
    pass.setBindGroup(0, this._extractBG);
    pass.draw(3);
    pass.end();
  }

  private _runBlurPass(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dst: GPUTexture,
    stepBuf: GPUBuffer,
    sampler: GPUSampler,
  ): void {
    // PERF (audit 5.9): cache per step buffer (H/V are distinct persistent
    // buffers, and each is always paired with the same src role), invalidated
    // when the source texture object changes (resize / lazy bloom realloc).
    // `sampler` is the pass's persistent linear sampler, so it can't go stale.
    let entry = this._blurBGCache.get(stepBuf);
    if (!entry || entry.src !== src) {
      entry = {
        src,
        bg: this.device.createBindGroup({
          layout: this._blurBGL,
          entries: [
            { binding: 0, resource: src.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: stepBuf } },
          ],
        }),
      };
      this._blurBGCache.set(stepBuf, entry);
    }
    const bg = entry.bg;
    const pass = encoder.beginRenderPass({
      label: 'PPBlurPass',
      colorAttachments: [{ view: dst.createView(), loadOp: 'clear', clearValue: { r:0,g:0,b:0,a:0 }, storeOp: 'store' }],
    });
    pass.setPipeline(this._blurPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private _runBloomComposite(
    encoder: GPUCommandEncoder,
    sceneTex: GPUTexture,
    bloomTex: GPUTexture,
    dst: GPUTexture,
    sampler: GPUSampler,
  ): void {
    if (!this._compositeBG || this._compositeBGSrc !== sceneTex || this._compositeBGBloom !== bloomTex) {
      this._compositeBG = this.device.createBindGroup({
        layout: this._compositeBGL,
        entries: [
          { binding: 0, resource: sceneTex.createView() },
          { binding: 1, resource: bloomTex.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: this._bloomParamsBuf } },
        ],
      });
      this._compositeBGSrc   = sceneTex;
      this._compositeBGBloom = bloomTex;
    }

    const pass = encoder.beginRenderPass({
      label: 'PPBloomCompositePass',
      colorAttachments: [{ view: dst.createView(), loadOp: 'clear', clearValue: { r:0,g:0,b:0,a:0 }, storeOp: 'store' }],
    });
    pass.setPipeline(this._bloomCompositePipeline);
    pass.setBindGroup(0, this._compositeBG);
    pass.draw(3);
    pass.end();
  }

  private _runGradeVig(
    encoder: GPUCommandEncoder,
    srcTex: GPUTexture,
    dst: GPUTexture,
    sampler: GPUSampler,
  ): void {
    if (!this._gradeVigBG || this._gradeVigBGSrc !== srcTex) {
      this._gradeVigBG = this.device.createBindGroup({
        layout: this._gradeVigBGL,
        entries: [
          { binding: 0, resource: srcTex.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: this._gradeVigBuf } },
        ],
      });
      this._gradeVigBGSrc = srcTex;
    }

    const pass = encoder.beginRenderPass({
      label: 'PPGradeVigPass',
      colorAttachments: [{ view: dst.createView(), loadOp: 'clear', clearValue: { r:0,g:0,b:0,a:0 }, storeOp: 'store' }],
    });
    pass.setPipeline(this._gradeVigPipeline);
    pass.setBindGroup(0, this._gradeVigBG);
    pass.draw(3);
    pass.end();
  }
}
