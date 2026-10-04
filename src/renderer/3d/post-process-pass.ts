/**
 * PostProcessPass — scene post-processing stack for the 3D renderer.
 *
 * Plugs in between passEncoder.end() and the final copyTextureToTexture:
 *   1. Bloom    — bright-pixel extract → Gaussian blur → additive composite
 *   2. Color grade — brightness / contrast / saturation / tint
 *   3. Vignette — radial darkening at edges
 *   4. Film     — grain, colour fringing (chromatic aberration), halation (film-look-and-toon-shadows.md Phase 1)
 *
 * Passes 2 and 3 run as a single combined shader to avoid an extra full-screen
 * render per effect. When all effects are disabled, run() returns null and the
 * caller copies lastFrameTex directly (no overhead).
 *
 * Source texture:  bgra8unorm (lastFrameTex, requires TEXTURE_BINDING usage)
 * Bloom textures:  rgba16float (intermediate, for HDR bloom accumulation)
 * Output textures: bgra8unorm (ping-pong pair, caller copies result to swapchain)
 */

import { PP_BLOOM_DOWN_FS, PP_BLOOM_UP_FS } from './shaders/post-process-shaders';
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
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
  /** WIDE glow (city-quality P6): 0 = the original single-blur halo; > 0 adds a 5-level mip-chain glow of that
   *  strength (≈ 0.5–1.2) — the soft wide bloom neon + street lamps need. */
  wide?: number;
  /** CHROMA GATE 0..1 (persona-polish A6): how strongly near-neutral pixels (white paint, pale paving) are kept OUT
   *  of the bloom — lights are saturated, paint is not. 0 / absent = the original luminance-only bloom. */
  chromaGate?: number;
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
  /** SPLIT-TONE (city-quality P7): the hue the SHADOWS / HIGHLIGHTS take. Luminance-normalised when packed, so they
   *  shift colour, not brightness. Absent / [1,1,1] = off (the original grade, exactly). */
  shadowTint?: [number, number, number];
  highlightTint?: [number, number, number];
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

/** The FILM look (docs/specs/film-look-and-toon-shadows.md §A): animated grain, radial colour fringing, and halation
 *  (a warm tint on the bloom, so glowing screens bleed like film). Off by default. */
export interface FilmConfig {
  enabled: boolean;
  /** Grain strength 0..0.3 (default 0.06). Luminance-weighted: strongest in the mid-tones, blacks/whites stay clean. */
  grain: number;
  /** Grain cell size in px (default 1.5; 1 = per-pixel, 2–3 = chunky 16 mm). */
  grainSize: number;
  /** Colour fringing 0..0.01 (default 0.0025): an RGB split that grows toward the frame edges (none at the centre). */
  aberration: number;
  /** Halation 0..1 (default 0.35): how much the BLOOM is tinted by `halationTint`. Needs bloom enabled. */
  halation: number;
  /** Halation tint (default warm orange-red). */
  halationTint: [number, number, number];
}

export interface PostProcessConfig {
  bloom: BloomConfig;
  colorGrade: ColorGradeConfig;
  vignette: VignetteConfig;
  film: FilmConfig;
}

export const DEFAULT_POST_PROCESS_CONFIG: PostProcessConfig = {
  bloom:      { enabled: false, threshold: 0.8, intensity: 1.0 },
  colorGrade: { enabled: false, brightness: 0.0, contrast: 0.0, saturation: 0.0, tint: [1, 1, 1] },
  vignette:   { enabled: false, intensity: 0.5, radius: 0.75, softness: 0.45 },
  film:       { enabled: false, grain: 0.06, grainSize: 1.5, aberration: 0.0025, halation: 0.35, halationTint: [1.0, 0.45, 0.3] },
};

/** A fresh deep copy of the defaults (the config arrays must never be shared between passes / saves). */
export function defaultPostProcessConfig(): PostProcessConfig {
  const d = DEFAULT_POST_PROCESS_CONFIG;
  return {
    bloom: { ...d.bloom },
    colorGrade: { ...d.colorGrade, tint: [...d.colorGrade.tint] as [number, number, number] },
    vignette: { ...d.vignette },
    film: { ...d.film, halationTint: [...d.film.halationTint] as [number, number, number] },
  };
}

/**
 * Pack the grade + vignette + film uniform (64 bytes = 16 floats — layout mirrors GradeVigParams in
 * post-process-shaders.ts). Pure, so the layout is unit-testable.
 *
 * ENABLE FLAGS (9–11): with the film look OFF, grade AND vignette both apply whenever the pass runs (1, 1) — exactly
 * the original behaviour (it never had per-effect enables: a stored non-neutral vignette also applied when only grade
 * was on). With film ON, each effect honours its own `enabled`, so "film only" doesn't drag stored grade values in.
 */
export function packGradeVigParams(out: Float32Array, c: PostProcessConfig, timeSec: number): Float32Array {
  const { colorGrade: g, vignette: v, film: f } = c;
  // Split-tone tints, luminance-normalised (hue only) — [1,1,1] stays [1,1,1] (off).
  const norm = (t: [number, number, number] | undefined): [number, number, number] => {
    if (!t) return [1, 1, 1];
    const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
    return l > 1e-4 ? [t[0] / l, t[1] / l, t[2] / l] : [1, 1, 1];
  };
  const st = norm(g.shadowTint), ht = norm(g.highlightTint);
  if (out.length >= 24) {
    out[16] = st[0]; out[17] = st[1]; out[18] = st[2]; out[19] = 0;
    out[20] = ht[0]; out[21] = ht[1]; out[22] = ht[2]; out[23] = 0;
  }
  out[0] = g.brightness; out[1] = g.contrast; out[2] = g.saturation; out[3] = v.intensity;
  out[4] = g.tint[0]; out[5] = g.tint[1]; out[6] = g.tint[2]; out[7] = v.radius;
  out[8] = v.softness;
  out[9]  = f.enabled ? (g.enabled ? 1 : 0) : 1;   // grade on
  out[10] = f.enabled ? (v.enabled ? 1 : 0) : 1;   // vignette on
  out[11] = f.enabled ? 1 : 0;                     // film on
  out[12] = f.enabled ? Math.max(0, f.grain) : 0;
  out[13] = Math.max(0.5, f.grainSize);
  out[14] = f.enabled ? Math.max(0, f.aberration) : 0;
  out[15] = timeSec;
  return out;
}

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
  // P2: non-blocking cache handles (docs/specs/performance-plan.md). An effect whose pipelines are still compiling
  // is treated as OFF for that frame — run() returns null when nothing can run, so the caller presents the scene
  // unprocessed instead of blocking on a compile.
  private _bloomExtractPipeline:   PipelineHandle<GPURenderPipeline>;
  private _bloomCompositePipeline: PipelineHandle<GPURenderPipeline>;
  private _blurPipeline:           PipelineHandle<GPURenderPipeline>;
  private _gradeVigPipeline:       PipelineHandle<GPURenderPipeline>;
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
  /** GradeVigParams struct (64 bytes — grade + vignette + film). */
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

  // ── WIDE bloom chain (city-quality P6) — allocated lazily, only when bloom.wide > 0 ──
  private static readonly WIDE_LEVELS = 5;
  private _wideDownPipeline: PipelineHandle<GPURenderPipeline> | null = null;
  private _wideUpPipeline:   PipelineHandle<GPURenderPipeline> | null = null;
  private _wideTex: GPUTexture[] = [];
  private _wideDownBuf: GPUBuffer[] = [];
  private _wideUpBuf:   GPUBuffer[] = [];
  private _wideBG = new Map<string, { src: GPUTexture; bg: GPUBindGroup }>();
  private _wideFor = { w: 0, h: 0 };
  private _wideStrength = -1;

  // ── Config ────────────────────────────────────────────────────────────────
  public config: PostProcessConfig;

  constructor(device: GPUDevice, swapFormat: GPUTextureFormat) {
    this.device = device;
    this.swapFormat = swapFormat;
    this.config = defaultPostProcessConfig();

    // Uniform buffers
    this._bloomParamsBuf = device.createBuffer({ size: 32,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPBloomParams' });   // params vec4 + halation tint vec4
    this._hStepBuf       = device.createBuffer({ size: 8,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPHStep' });
    this._vStepBuf       = device.createBuffer({ size: 8,   usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPVStep' });
    this._gradeVigBuf    = device.createBuffer({ size: 96,  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'PPGradeVig' });   // 24 floats (+ split-tone)

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
    const cache = GPUPipelineCache.for(device);

    // Bloom extract: outputs rgba16float
    this._bloomExtractPipeline = cache.render({
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
    this._blurPipeline = cache.render({
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
    this._bloomCompositePipeline = cache.render({
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
    this._gradeVigPipeline = cache.render({
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
    for (const h of [this._bloomExtractPipeline, this._blurPipeline, this._bloomCompositePipeline, this._gradeVigPipeline]) void h.warm(PIPELINE_PRIORITY.DOCUMENT);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run all enabled post-process effects into a bgra8unorm output texture.
   * Returns the output texture if any effect ran, or null if everything is disabled.
   * The caller should copy the returned texture to the swapchain (instead of lastFrameTex).
   */
  run(encoder: GPUCommandEncoder, srcTex: GPUTexture, w: number, h: number, timeSec = 0): GPUTexture | null {
    // P2: an effect runs only once its pipelines have compiled (each get() also requests a pending compile).
    const bloomReady = !this.config.bloom.enabled ? false
      : [this._bloomExtractPipeline.get(), this._blurPipeline.get(), this._bloomCompositePipeline.get()].every(Boolean);
    const gradeReady = !!this._gradeVigPipeline.get();
    const bloomOn = this.config.bloom.enabled && bloomReady;
    const gradeOn = this.config.colorGrade.enabled && gradeReady;
    const vigOn   = this.config.vignette.enabled && gradeReady;
    const filmOn  = this.config.film.enabled && gradeReady;

    if (!bloomOn && !gradeOn && !vigOn && !filmOn) return null;

    this._ensureTextures(w, h, bloomOn);
    this._uploadUniforms(w, h, timeSec);

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

      // WIDE glow: mip chain down + additive up, landing on the blurred halo (composite reads it unchanged).
      if ((this.config.bloom.wide ?? 0) > 0) this._runWideBloom(encoder, sampler, w, h);

      // Composite scene + blurred bloom → output ping-pong tex
      const dst = pingIdx === 0 ? this._pingTex! : this._pongTex!;
      this._runBloomComposite(encoder, currentSrc, this._bloomExtractTex!, dst, sampler);
      currentSrc = dst;
      pingIdx++;
    }

    if (gradeOn || vigOn || filmOn) {   // film (grain / fringing) rides the grade+vignette pass
      const dst = pingIdx === 0 ? this._pingTex! : this._pongTex!;
      this._runGradeVig(encoder, currentSrc, dst, sampler);
      currentSrc = dst;
      pingIdx++;
    }

    return currentSrc;
  }

  /** The WIDE bloom mip chain (see PP_BLOOM_DOWN_FS / PP_BLOOM_UP_FS). */
  private _runWideBloom(encoder: GPUCommandEncoder, sampler: GPUSampler, w: number, h: number): void {
    const d = this.device, L = PostProcessPass.WIDE_LEVELS;
    if (!this._wideDownPipeline || !this._wideUpPipeline) {
      const vs = d.createShaderModule({ code: PP_FULLSCREEN_VS, label: 'PPWideVS' });
      const layout = d.createPipelineLayout({ bindGroupLayouts: [this._blurBGL] });   // tex + sampler + uniform — same shape
      const cache = GPUPipelineCache.for(d);
      this._wideDownPipeline = cache.render({ label: 'PPBloomDown', layout,
        vertex: { module: vs, entryPoint: 'vs_main' },
        fragment: { module: d.createShaderModule({ code: PP_BLOOM_DOWN_FS, label: 'PPBloomDownFS' }), entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' } });
      this._wideUpPipeline = cache.render({ label: 'PPBloomUp', layout,
        vertex: { module: vs, entryPoint: 'vs_main' },
        fragment: { module: d.createShaderModule({ code: PP_BLOOM_UP_FS, label: 'PPBloomUpFS' }), entryPoint: 'fs_main',
          targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }] },
        primitive: { topology: 'triangle-list' } });
    }
    const wideDown = this._wideDownPipeline.get(), wideUp = this._wideUpPipeline.get();
    if (!wideDown || !wideUp) return;   // P2: still compiling → plain (narrow) bloom this frame
    const strength = Math.max(0, this.config.bloom.wide ?? 0);
    if (this._wideFor.w !== w || this._wideFor.h !== h || this._wideTex.length !== L) {
      for (const t of this._wideTex) t.destroy();
      for (const b of [...this._wideDownBuf, ...this._wideUpBuf]) b.destroy();
      this._wideTex = []; this._wideDownBuf = []; this._wideUpBuf = []; this._wideBG.clear();
      let lw = w, lh = h;
      for (let i = 0; i < L; i++) {
        const sw = lw, sh = lh;                                  // source size for this level's DOWN
        lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
        this._wideTex.push(d.createTexture({ size: [lw, lh], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `PPWide${i}` }));
        const db = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `PPWideDown${i}` });
        d.queue.writeBuffer(db, 0, new Float32Array([1 / sw, 1 / sh, 1, 0]));
        this._wideDownBuf.push(db);
        this._wideUpBuf.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `PPWideUp${i}` }));
      }
      this._wideFor = { w, h };
      this._wideStrength = -1;
    }
    if (this._wideStrength !== strength) {
      // UP i reads level i (its texel) and writes level i-1 (or, for i = 0, the full-res halo at `strength`).
      for (let i = 0; i < L; i++) {
        const src = this._wideTex[i];
        this.device.queue.writeBuffer(this._wideUpBuf[i], 0, new Float32Array([1 / src.width, 1 / src.height, i === 0 ? strength : 0.9, 0]));
      }
      this._wideStrength = strength;
    }
    const bg = (key: string, src: GPUTexture, buf: GPUBuffer): GPUBindGroup => {
      const e = this._wideBG.get(key);
      if (e && e.src === src) return e.bg;
      const b = d.createBindGroup({ layout: this._blurBGL, entries: [
        { binding: 0, resource: src.createView() }, { binding: 1, resource: sampler }, { binding: 2, resource: { buffer: buf } },
      ] });
      this._wideBG.set(key, { src, bg: b });
      return b;
    };
    const draw = (pipe: GPURenderPipeline, dst: GPUTexture, group: GPUBindGroup, load: boolean): void => {
      const pass = encoder.beginRenderPass({ label: 'PPWidePass', colorAttachments: [{ view: dst.createView(), loadOp: load ? 'load' : 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
      pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    };
    // DOWN: halo → level 0 → … → level L-1
    for (let i = 0; i < L; i++) {
      const src = i === 0 ? this._bloomExtractTex! : this._wideTex[i - 1];
      draw(wideDown, this._wideTex[i], bg(`d${i}`, src, this._wideDownBuf[i]), false);
    }
    // UP (additive): level L-1 → … → level 0 → the halo
    for (let i = L - 1; i >= 0; i--) {
      const dst = i === 0 ? this._bloomExtractTex! : this._wideTex[i - 1];
      draw(wideUp, dst, bg(`u${i}`, this._wideTex[i], this._wideUpBuf[i]), true);
    }
  }

  destroy(): void {
    for (const t of this._wideTex) t.destroy();
    for (const b of [...this._wideDownBuf, ...this._wideUpBuf]) b.destroy();
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

  private readonly _bloomParams = new Float32Array(8);    // reused uniform scratch (was fresh arrays/frame)
  private readonly _gradeVigParams = new Float32Array(24);
  private _uploadUniforms(w: number, h: number, timeSec: number): void {
    void w; void h;

    // Bloom params: (threshold, intensity, halation, 0) + halation tint (r, g, b, 0). Halation 0 = the original bloom.
    const bp = this._bloomParams, f = this.config.film;
    bp[0] = this.config.bloom.threshold; bp[1] = this.config.bloom.intensity;
    bp[2] = f.enabled ? Math.max(0, Math.min(1, f.halation)) : 0; bp[3] = Math.max(0, Math.min(1, this.config.bloom.chromaGate ?? 0));
    bp[4] = f.halationTint[0]; bp[5] = f.halationTint[1]; bp[6] = f.halationTint[2]; bp[7] = 0;
    this.device.queue.writeBuffer(this._bloomParamsBuf, 0, bp);

    // Grade + vignette + film params (64 bytes = 16 floats) — see packGradeVigParams
    this.device.queue.writeBuffer(this._gradeVigBuf, 0, packGradeVigParams(this._gradeVigParams, this.config, timeSec));
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
    pass.setPipeline(this._bloomExtractPipeline.get()!);   // gated by run()
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
    pass.setPipeline(this._blurPipeline.get()!);   // gated by run()
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
    pass.setPipeline(this._bloomCompositePipeline.get()!);   // gated by run()
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
    pass.setPipeline(this._gradeVigPipeline.get()!);   // gated by run()
    pass.setBindGroup(0, this._gradeVigBG);
    pass.draw(3);
    pass.end();
  }
}
