/**
 * RasterCompositor — GPU compute shader that flattens multiple raster layers
 * into a single output texture, respecting per-layer blend modes, opacity,
 * and clipping masks.
 *
 * Architecture:
 *   For each layer (back-to-front), dispatch a compute pass that reads the
 *   layer texture + the accumulated result so far, blends them according to
 *   the layer's blend mode and opacity, and writes the result back.
 *
 * Supports:
 *   12 blend modes (Normal, Multiply, Screen, Overlay, Soft Light, Hard Light,
 *   Color Dodge, Color Burn, Darken, Lighten, Add/Glow, Difference)
 *   Per-layer opacity (0-1)
 *   Clipping masks (clip to alpha of layer below)
 *   Visibility toggle (skip invisible layers)
 *   Global canvas grain overlay (paper texture applied to final output)
 */

import { CanvasGrainManager } from '../canvas-grain';
import { DitherEngine, DitherConfig, defaultDitherConfig } from '../effects/dither-engine';
import type { FrameLinkAnimation } from '../../../animation';
import { OnionSkinRenderer, type OnionFrame } from '../../../animation/onion-skin-renderer';

/** Blend mode enum — matches the uniform values in the shader. */
export enum LayerBlendMode {
  Normal     = 0,
  Multiply   = 1,
  Screen     = 2,
  Overlay    = 3,
  SoftLight  = 4,
  HardLight  = 5,
  ColorDodge = 6,
  ColorBurn  = 7,
  Darken     = 8,
  Lighten    = 9,
  Add        = 10,
  Difference = 11,
}

/** Per-layer metadata passed to the compositor. */
export interface CompositorLayerInfo {
  texture: GPUTexture;
  blendMode: LayerBlendMode;
  opacity: number;       // 0-1
  clipped: boolean;      // true → clip to alpha of layer below
  visible: boolean;
  /** Optional per-layer dither config. When set and enabled, the layer is dithered before compositing. */
  ditherConfig?: DitherConfig;
  /** Optional per-layer procedural displacement animation. */
  frameLinkAnimation?: FrameLinkAnimation;
}

export class RasterCompositor {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // Uniform buffer for per-layer params:
  //   vec4[0] = [blendMode, opacity, clipped, pad]
  //   vec4[1] = [dispType, dispAmplitude, dispFrequency, dispSpeed]
  //   vec4[2] = [dispDirection, dispPhase, currentFrame, dispFlags]
  //   vec4[3] = [rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity]
  //   vec4[4] = [noisePersistence, shakeSeed, texW, texH]
  private paramsBuf: GPUBuffer;
  // Pre-allocated typed array (avoids GC per-frame): 5 vec4 = 20 floats
  private paramsData = new Float32Array(20);

  /** Current animation frame (1-indexed). Set before each composite call. */
  public currentFrame: number = 1;

  // Persistent ping texture for accumulated result readback
  private pingTex: GPUTexture | null = null;
  private pingTexW = 0;
  private pingTexH = 0;

  // Base-layer opacity compute pass (lazy-built)
  private _baseOpacityPipeline: GPUComputePipeline | null = null;
  private _baseOpacityBGL: GPUBindGroupLayout | null = null;
  private _baseOpacityBuf: GPUBuffer | null = null;

  // Global canvas grain overlay
  private _grainManager: CanvasGrainManager | null = null;
  private _grainOverlayPipeline: GPUComputePipeline | null = null;
  private _grainOverlayBGL: GPUBindGroupLayout | null = null;
  private _grainOverlayParamBuf: GPUBuffer | null = null;
  private _grainOverlaySampler: GPUSampler | null = null;
  private _grainOverlayPingTex: GPUTexture | null = null;
  private _grainOverlayPingW = 0;
  private _grainOverlayPingH = 0;

  // Non-destructive dithering post-process
  private _ditherEngine: DitherEngine;
  private _ditherConfig: DitherConfig = defaultDitherConfig();

  // Scratch texture for per-layer dithering (non-destructive: layer texture is never modified)
  private _ditherScratchTex: GPUTexture | null = null;
  private _ditherScratchW = 0;
  private _ditherScratchH = 0;

  // Onion skin rendering
  private _onionRenderer: OnionSkinRenderer;
  // Ping texture for onion skin read-back (can't read+write same storage texture)
  private _onionPingTex: GPUTexture | null = null;
  private _onionPingW = 0;
  private _onionPingH = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    this.paramsBuf = device.createBuffer({
      size: 80, // 20 floats = 5 vec4: blend params + displacement params
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._ditherEngine = new DitherEngine(device);
    this._onionRenderer = new OnionSkinRenderer(device);

    this.buildPipeline();
  }

  // ── Dither configuration ─────────────────────────────────────────

  /** Set the complete dither configuration. */
  public setDitherConfig(config: DitherConfig): void {
    this._ditherConfig = { ...config };
  }

  /** Get the current dither configuration (copy). */
  public getDitherConfig(): DitherConfig {
    return { ...this._ditherConfig };
  }

  /** Enable or disable dithering. */
  public setDitherEnabled(enabled: boolean): void {
    this._ditherConfig.enabled = enabled;
  }

  /**
   * Set the global canvas grain manager. When set, the grain texture is applied
   * as a final overlay on the composited output — like real paper showing through paint.
   */
  public setGrainManager(manager: CanvasGrainManager | null): void {
    this._grainManager = manager;
  }

  // ── Onion skin overlay ──────────────────────────────────────────

  /**
   * Overlay onion skin ghost frames onto the composited output.
   * Call this AFTER composite() but BEFORE applyGrainOverlay().
   *
   * `onionFrames` is an ordered array of ghost frames (e.g. previous frames in red,
   * next frames in blue), each with a texture, opacity, and tint.
   * The output texture is modified in-place.
   */
  public applyOnionSkin(
    outputTexture: GPUTexture,
    onionFrames: OnionFrame[],
  ): void {
    if (onionFrames.length === 0) return;
    const w = outputTexture.width;
    const h = outputTexture.height;

    // Ensure ping texture for read-back
    if (!this._onionPingTex || this._onionPingW !== w || this._onionPingH !== h) {
      this._onionPingTex?.destroy();
      this._onionPingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._onionPingW = w;
      this._onionPingH = h;
    }

    for (const frame of onionFrames) {
      if (!frame.texture || frame.opacity <= 0) continue;

      // Copy current output → ping (read source)
      const cpEnc = this.device.createCommandEncoder();
      cpEnc.copyTextureToTexture(
        { texture: outputTexture },
        { texture: this._onionPingTex! },
        { width: w, height: h },
      );
      this.device.queue.submit([cpEnc.finish()]);

      // Composite the onion frame onto outputTexture
      this._onionRenderer.composite(
        this._onionPingTex!,
        outputTexture,
        frame.texture,
        frame.opacity,
        frame.tint,
      );
    }
  }

  // ── Displacement uniform writer ──

  /** Encode displacement animation params into the pre-allocated paramsData array at index 4..19. */
  private writeDisplacementParams(layer: CompositorLayerInfo, w: number, h: number): void {
    const pd = this.paramsData;
    const anim = layer.frameLinkAnimation;
    if (!anim || !anim.enabled) {
      // Type 0 = none, amplitude 0 → computeDisplacement returns (0,0)
      pd[4] = 0; pd[5] = 0; pd[6] = 0; pd[7] = 0;
      pd[8] = 0; pd[9] = 0; pd[10] = this.currentFrame; pd[11] = 0;
      pd[12] = 0; pd[13] = 0; pd[14] = 0; pd[15] = 0;
      pd[16] = 0; pd[17] = 0; pd[18] = w; pd[19] = h;
      return;
    }

    const typeMap: Record<string, number> = {
      'wave': 1, 'shake': 2, 'ripple': 3, 'noise': 4, 'turbulence': 5,
    };
    const dirRad = (anim.direction ?? 0) * Math.PI / 180;
    const flags = (anim.displaceX !== false ? 1 : 0) | (anim.displaceY ? 2 : 0);

    // vec4[1]: dispType, amplitude, frequency, speed
    pd[4]  = typeMap[anim.type] ?? 0;
    pd[5]  = anim.amplitude ?? 0;
    pd[6]  = anim.frequency ?? 3;
    pd[7]  = anim.speed ?? 0.15;
    // vec4[2]: direction(rad), phase, currentFrame, flags
    pd[8]  = dirRad;
    pd[9]  = anim.phase ?? 0;
    pd[10] = this.currentFrame;
    pd[11] = flags;
    // vec4[3]: rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity
    pd[12] = anim.rippleCenterX ?? 0.5;
    pd[13] = anim.rippleCenterY ?? 0.5;
    pd[14] = anim.noiseOctaves ?? 2;
    pd[15] = anim.noiseLacunarity ?? 2.0;
    // vec4[4]: noisePersistence, shakeSeed, texW, texH
    pd[16] = anim.noisePersistence ?? 0.5;
    pd[17] = anim.shakeSeed ?? 0;
    pd[18] = w;
    pd[19] = h;
  }

  /**
   * Composite all layers (back-to-front) into `outputTexture`.
   * `outputTexture` must be rgba8unorm with STORAGE_BINDING + TEXTURE_BINDING + COPY_DST usage.
   *
   * The first visible layer is copied directly; subsequent layers are blended on top.
   * After all layers are composited, a global canvas grain overlay is applied (if enabled).
   */
  public composite(layers: CompositorLayerInfo[], outputTexture: GPUTexture): void {
    const w = outputTexture.width;
    const h = outputTexture.height;
    if (w === 0 || h === 0) return;

    const visibleLayers = layers.filter(l => l.visible && l.texture);
    if (visibleLayers.length === 0) {
      this.clearTexture(outputTexture);
      // Still apply grain — the blank canvas IS the paper
      this.applyGrainOverlay(outputTexture, w, h);
      return;
    }

    // Copy first visible layer → output (no blending needed for the base)
    const first = visibleLayers[0];
    const firstTex = this.maybeDitherLayer(first, w, h);
    const copyEnc = this.device.createCommandEncoder();
    copyEnc.copyTextureToTexture(
      { texture: firstTex },
      { texture: outputTexture },
      { width: Math.min(firstTex.width, w), height: Math.min(firstTex.height, h) },
    );
    this.device.queue.submit([copyEnc.finish()]);

    if (first.opacity < 1.0) {
      this.applyBaseOpacity(outputTexture, first.opacity, w, h);
    }

    if (visibleLayers.length <= 1) {
      // Single layer — still apply global dither + paper grain overlay
      this._ditherEngine.apply(outputTexture, this._ditherConfig);
      this.applyGrainOverlay(outputTexture, w, h);
      return;
    }

    // Ensure persistent ping texture matches output dimensions
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.pingTexW = w;
      this.pingTexH = h;
    }

    for (let i = 1; i < visibleLayers.length; i++) {
      const layer = visibleLayers[i];
      const layerTex = this.maybeDitherLayer(layer, w, h);

      // Copy current accumulated output → ping (for reading)
      const cpEnc = this.device.createCommandEncoder();
      cpEnc.copyTextureToTexture(
        { texture: outputTexture },
        { texture: this.pingTex! },
        { width: w, height: h },
      );
      this.device.queue.submit([cpEnc.finish()]);

      const clippedVal = layer.clipped ? 1.0 : 0.0;

      // Write per-layer uniforms (pre-allocated array: blend params + displacement)
      const pd = this.paramsData;
      pd[0] = layer.blendMode; pd[1] = layer.opacity; pd[2] = clippedVal; pd[3] = 0;
      this.writeDisplacementParams(layer, w, h);
      this.device.queue.writeBuffer(this.paramsBuf, 0, pd);

      const layerW = Math.min(layerTex.width, w);
      const layerH = Math.min(layerTex.height, h);

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: this.pingTex!.createView() },
          { binding: 1, resource: layerTex.createView() },
          { binding: 2, resource: outputTexture.createView() },
          { binding: 3, resource: { buffer: this.paramsBuf } },
        ],
      });

      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      const wgSize = 8;
      pass.dispatchWorkgroups(Math.ceil(layerW / wgSize), Math.ceil(layerH / wgSize));
      pass.end();
      this.device.queue.submit([enc.finish()]);
    }

    // ── Global non-destructive dither post-process ──
    this._ditherEngine.apply(outputTexture, this._ditherConfig);

    // ── Global canvas grain overlay pass ──
    this.applyGrainOverlay(outputTexture, w, h);
  }

  /**
   * Async variant of composite() that supports error diffusion dithering
   * (both per-layer and global). Falls back to sync GPU paths when possible.
   *
   * Call this instead of composite() when any layer or the global config
   * uses an error diffusion algorithm (floyd_steinberg, atkinson, etc.).
   */
  public async compositeAsync(layers: CompositorLayerInfo[], outputTexture: GPUTexture): Promise<void> {
    const w = outputTexture.width;
    const h = outputTexture.height;
    if (w === 0 || h === 0) return;

    const visibleLayers = layers.filter(l => l.visible && l.texture);
    if (visibleLayers.length === 0) {
      this.clearTexture(outputTexture);
      this.applyGrainOverlay(outputTexture, w, h);
      return;
    }

    // Copy first visible layer → output
    const first = visibleLayers[0];
    const firstTex = await this.maybeDitherLayerAsync(first, w, h);
    const copyEnc = this.device.createCommandEncoder();
    copyEnc.copyTextureToTexture(
      { texture: firstTex },
      { texture: outputTexture },
      { width: Math.min(firstTex.width, w), height: Math.min(firstTex.height, h) },
    );
    this.device.queue.submit([copyEnc.finish()]);

    if (first.opacity < 1.0) {
      this.applyBaseOpacity(outputTexture, first.opacity, w, h);
    }

    if (visibleLayers.length <= 1) {
      await this._ditherEngine.applyAsync(outputTexture, this._ditherConfig);
      this.applyGrainOverlay(outputTexture, w, h);
      return;
    }

    // Ensure persistent ping texture
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.pingTexW = w;
      this.pingTexH = h;
    }

    for (let i = 1; i < visibleLayers.length; i++) {
      const layer = visibleLayers[i];
      const layerTex = await this.maybeDitherLayerAsync(layer, w, h);

      const cpEnc = this.device.createCommandEncoder();
      cpEnc.copyTextureToTexture(
        { texture: outputTexture },
        { texture: this.pingTex! },
        { width: w, height: h },
      );
      this.device.queue.submit([cpEnc.finish()]);

      const clippedVal = layer.clipped ? 1.0 : 0.0;
      const pd = this.paramsData;
      pd[0] = layer.blendMode; pd[1] = layer.opacity; pd[2] = clippedVal; pd[3] = 0;
      this.writeDisplacementParams(layer, w, h);
      this.device.queue.writeBuffer(this.paramsBuf, 0, pd);

      const layerW = Math.min(layerTex.width, w);
      const layerH = Math.min(layerTex.height, h);

      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: this.pingTex!.createView() },
          { binding: 1, resource: layerTex.createView() },
          { binding: 2, resource: outputTexture.createView() },
          { binding: 3, resource: { buffer: this.paramsBuf } },
        ],
      });

      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      const wgSize = 8;
      pass.dispatchWorkgroups(Math.ceil(layerW / wgSize), Math.ceil(layerH / wgSize));
      pass.end();
      this.device.queue.submit([enc.finish()]);
    }

    // ── Global non-destructive dither post-process (async) ──
    await this._ditherEngine.applyAsync(outputTexture, this._ditherConfig);

    // ── Global canvas grain overlay pass ──
    this.applyGrainOverlay(outputTexture, w, h);
  }

  public destroy(): void {
    this.paramsBuf.destroy();
    this.pingTex?.destroy();
    this.pingTex = null;
    this._ditherEngine.destroy();
    this._ditherScratchTex?.destroy();
    this._ditherScratchTex = null;
    this._grainOverlayPingTex?.destroy();
    this._grainOverlayPingTex = null;
    this._grainOverlayParamBuf?.destroy();
  }

  // ── Per-layer dither helper ─────────────────────────────────────

  /**
   * If the layer has a per-layer dither config that is enabled, copy the layer
   * texture to a scratch texture, apply dither to it, and return the scratch.
   * Otherwise, return the layer's original texture unchanged (zero-cost path).
   *
   * Supports both GPU ordered dithering (sync) and WASM error diffusion (async).
   */
  private async maybeDitherLayerAsync(layer: CompositorLayerInfo, w: number, h: number): Promise<GPUTexture> {
    const cfg = layer.ditherConfig;
    if (!cfg || !cfg.enabled || cfg.strength <= 0.001) {
      return layer.texture;
    }

    // Ensure scratch texture matches dimensions
    if (!this._ditherScratchTex || this._ditherScratchW !== w || this._ditherScratchH !== h) {
      this._ditherScratchTex?.destroy();
      this._ditherScratchTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
      });
      this._ditherScratchW = w;
      this._ditherScratchH = h;
    }

    // Copy layer texture → scratch (non-destructive: never touches original)
    const cpEnc = this.device.createCommandEncoder();
    const copyW = Math.min(layer.texture.width, w);
    const copyH = Math.min(layer.texture.height, h);
    cpEnc.copyTextureToTexture(
      { texture: layer.texture },
      { texture: this._ditherScratchTex },
      { width: copyW, height: copyH },
    );

    if (!DitherEngine.isErrorDiffusion(cfg.algorithm)) {
      // PERF (audit 5.7): ordered dithering records its copy+dispatch into our
      // encoder — one submit for the whole per-layer dither instead of three.
      this._ditherEngine.apply(this._ditherScratchTex, cfg, cpEnc);
      this.device.queue.submit([cpEnc.finish()]);
    } else {
      // Error diffusion does a GPU→CPU readback + WASM round-trip; it needs the
      // scratch copy submitted first, then runs its own (unavoidable) flow.
      this.device.queue.submit([cpEnc.finish()]);
      await this._ditherEngine.applyAsync(this._ditherScratchTex, cfg);
    }

    return this._ditherScratchTex;
  }

  /**
   * Sync per-layer dither helper (GPU ordered only, skips error diffusion).
   * Used by the sync composite() path.
   */
  private maybeDitherLayer(layer: CompositorLayerInfo, w: number, h: number): GPUTexture {
    const cfg = layer.ditherConfig;
    if (!cfg || !cfg.enabled || cfg.strength <= 0.001) {
      return layer.texture;
    }

    // Error diffusion requires async — skip in sync path
    if (DitherEngine.isErrorDiffusion(cfg.algorithm)) {
      return layer.texture;
    }

    // Ensure scratch texture matches dimensions
    if (!this._ditherScratchTex || this._ditherScratchW !== w || this._ditherScratchH !== h) {
      this._ditherScratchTex?.destroy();
      this._ditherScratchTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
      });
      this._ditherScratchW = w;
      this._ditherScratchH = h;
    }

    // Copy layer texture → scratch (non-destructive: never touches original)
    // PERF (audit 5.7): share one encoder with the dither engine's copy+dispatch
    // — one submit per dithered layer instead of three standalone submits.
    const cpEnc = this.device.createCommandEncoder();
    const copyW = Math.min(layer.texture.width, w);
    const copyH = Math.min(layer.texture.height, h);
    cpEnc.copyTextureToTexture(
      { texture: layer.texture },
      { texture: this._ditherScratchTex },
      { width: copyW, height: copyH },
    );

    // Apply per-layer dither to the scratch copy (records into cpEnc)
    this._ditherEngine.apply(this._ditherScratchTex, cfg, cpEnc);
    this.device.queue.submit([cpEnc.finish()]);

    return this._ditherScratchTex;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private clearTexture(tex: GPUTexture): void {
    // Write transparent black to the entire texture via buffer copy
    const w = tex.width;
    const h = tex.height;
    const paddedRowBytes = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({
      size: paddedRowBytes * h,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).fill(0);
    buf.unmap();

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    buf.destroy();
  }

  /**
   * Apply opacity to the base layer in-place by scaling alpha.
   * Uses a compute pass that reads the texture and writes back with scaled alpha.
   */
  private applyBaseOpacity(tex: GPUTexture, opacity: number, w: number, h: number): void {
    if (opacity >= 0.999) return;

    // Need a temp copy to read from (can't read+write same texture)
    const tmpTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: tex }, { texture: tmpTex }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    // Simple compute pass to scale alpha
    if (!this._baseOpacityPipeline) {
      const code = /* wgsl */ `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
        @group(0) @binding(2) var<uniform> opacity: f32;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let dim = textureDimensions(dst);
          if (gid.x >= dim.x || gid.y >= dim.y) { return; }
          let coords = vec2<i32>(i32(gid.x), i32(gid.y));
          let c = textureLoad(src, coords, 0);
          textureStore(dst, coords, vec4<f32>(c.rgb, c.a * opacity));
        }
      `;
      this._baseOpacityBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this._baseOpacityPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._baseOpacityBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
    }

    // Write opacity uniform
    if (!this._baseOpacityBuf) {
      this._baseOpacityBuf = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this._baseOpacityBuf, 0, new Float32Array([opacity]));

    const bg = this.device.createBindGroup({
      layout: this._baseOpacityBGL!,
      entries: [
        { binding: 0, resource: tmpTex.createView() },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: { buffer: this._baseOpacityBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this._baseOpacityPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    tmpTex.destroy();
  }

  // ── Global grain overlay ────────────────────────────────────────────

  /**
   * Apply global canvas grain as a post-process on any raster texture.
   * Makes the entire canvas look like textured paper:
   *  - Unpainted areas show as white paper with grain texture (peaks/valleys)
   *  - Painted areas show paint modulated by grain (paint catches on peaks)
   * Call this after compositing, or directly on a single-layer texture.
   */
  public applyGrainOverlay(tex: GPUTexture, w: number, h: number): void {
    if (!this._grainManager) return;
    const grainTex = this._grainManager.getGrainTexture();
    if (!grainTex) return;
    const strength = this._grainManager.getGrainStrength();
    if (strength <= 0.001) return;
    const invScale = this._grainManager.getGrainInvScale();

    this.ensureGrainOverlayPipeline();

    // Write grain params: invScaleX, invScaleY, strength, pad
    if (!this._grainOverlayParamBuf) {
      this._grainOverlayParamBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(
      this._grainOverlayParamBuf,
      0,
      new Float32Array([invScale[0], invScale[1], strength, 0]),
    );

    // Ensure ping texture for read-back
    if (!this._grainOverlayPingTex || this._grainOverlayPingW !== w || this._grainOverlayPingH !== h) {
      this._grainOverlayPingTex?.destroy();
      this._grainOverlayPingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._grainOverlayPingW = w;
      this._grainOverlayPingH = h;
    }

    // Copy current composited output → ping
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: tex }, { texture: this._grainOverlayPingTex! }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    const bg = this.device.createBindGroup({
      layout: this._grainOverlayBGL!,
      entries: [
        { binding: 0, resource: this._grainOverlayPingTex!.createView() },
        { binding: 1, resource: grainTex.createView() },
        { binding: 2, resource: this._grainOverlaySampler! },
        { binding: 3, resource: { buffer: this._grainOverlayParamBuf } },
        { binding: 4, resource: tex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this._grainOverlayPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private ensureGrainOverlayPipeline(): void {
    if (this._grainOverlayPipeline) return;

    this._grainOverlaySampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;       // composited paint input
      @group(0) @binding(1) var grainTex: texture_2d<f32>;     // r8unorm tiling grain
      @group(0) @binding(2) var grainSamp: sampler;            // repeat sampler
      @group(0) @binding(3) var<uniform> grainParams: vec4<f32>; // invScaleX, invScaleY, strength, pad
      @group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);

        // Sample grain texture at canvas-space position (tiling)
        let grainUV = vec2<f32>(f32(gid.x), f32(gid.y)) * grainParams.xy;
        let grainVal = textureSampleLevel(grainTex, grainSamp, grainUV, 0.0).r;
        let strength = grainParams.z;
        let modulation = mix(1.0, grainVal, strength);

        // The canvas IS paper. The grain texture is the paper surface.
        // Paper base: white modulated by grain (peaks = bright, valleys = darker)
        let paperRGB = vec3<f32>(1.0) * modulation;

        // Composite paint over the paper surface.
        // Paint color is also modulated by grain (paint catches on peaks, skips valleys).
        let paintRGB = src.rgb * modulation;
        let paintA   = src.a;

        // Alpha-over: paint on top of opaque paper
        let outRGB = paintRGB * paintA + paperRGB * (1.0 - paintA);

        // Output is always fully opaque — this IS the paper
        textureStore(output, coords, vec4<f32>(outRGB, 1.0));
      }
    `;

    this._grainOverlayBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    this._grainOverlayPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._grainOverlayBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── Pipeline construction ─────────────────────────────────────────

  private buildPipeline(): void {
    const code = /* wgsl */ `
      @group(0) @binding(0) var accum: texture_2d<f32>;       // accumulated result (read)
      @group(0) @binding(1) var layerTex: texture_2d<f32>;    // current layer (read)
      @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>; // output (write)
      // params[0] = [blendMode, opacity, clipped, pad]
      // params[1] = [dispType, amplitude, frequency, speed]
      // params[2] = [direction, phase, currentFrame, flags(displaceX|displaceY)]
      // params[3] = [rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity]
      // params[4] = [noisePersistence, shakeSeed, texW, texH]
      @group(0) @binding(3) var<uniform> params: array<vec4<f32>, 5>;

      // ── Blend mode functions ──
      // All operate on premultiplied-alpha-free RGB. Alpha is handled separately.

      fn blendNormal(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return src; }

      fn blendMultiply(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return dst * src; }

      fn blendScreen(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return 1.0 - (1.0 - dst) * (1.0 - src);
      }

      fn blendOverlay(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        // Per channel: if dst < 0.5 → 2*dst*src, else 1 - 2*(1-dst)*(1-src)
        let low = 2.0 * dst * src;
        let high = 1.0 - 2.0 * (1.0 - dst) * (1.0 - src);
        return select(high, low, dst < vec3<f32>(0.5));
      }

      fn blendSoftLight(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        // W3C formula
        let d = select(sqrt(dst), ((16.0 * dst - 12.0) * dst + 4.0) * dst, dst <= vec3<f32>(0.25));
        return select(dst + (2.0 * src - 1.0) * (d - dst), dst - (1.0 - 2.0 * src) * dst * (1.0 - dst), src <= vec3<f32>(0.5));
      }

      fn blendHardLight(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return blendOverlay(src, dst); // hardlight = overlay with swapped args
      }

      fn blendColorDodge(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return select(min(vec3<f32>(1.0), dst / max(1.0 - src, vec3<f32>(0.001))), vec3<f32>(0.0), dst <= vec3<f32>(0.0));
      }

      fn blendColorBurn(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return select(1.0 - min(vec3<f32>(1.0), (1.0 - dst) / max(src, vec3<f32>(0.001))), vec3<f32>(1.0), dst >= vec3<f32>(1.0));
      }

      fn blendDarken(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return min(dst, src); }
      fn blendLighten(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return max(dst, src); }

      fn blendAdd(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return min(dst + src, vec3<f32>(1.0)); }

      fn blendDifference(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return abs(dst - src); }

      fn applyBlend(mode: i32, dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        switch (mode) {
          case 0:  { return blendNormal(dst, src); }
          case 1:  { return blendMultiply(dst, src); }
          case 2:  { return blendScreen(dst, src); }
          case 3:  { return blendOverlay(dst, src); }
          case 4:  { return blendSoftLight(dst, src); }
          case 5:  { return blendHardLight(dst, src); }
          case 6:  { return blendColorDodge(dst, src); }
          case 7:  { return blendColorBurn(dst, src); }
          case 8:  { return blendDarken(dst, src); }
          case 9:  { return blendLighten(dst, src); }
          case 10: { return blendAdd(dst, src); }
          case 11: { return blendDifference(dst, src); }
          default: { return blendNormal(dst, src); }
        }
      }

      // ── Displacement helpers ──

      // PCG hash for shake/noise
      fn pcgHash(v: u32) -> u32 {
        var s = v * 747796405u + 2891336453u;
        let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
        return (w >> 22u) ^ w;
      }

      fn hash2Dfloat(x: u32, y: u32) -> f32 {
        return f32(pcgHash(x + pcgHash(y))) / 4294967295.0;
      }

      // Simple gradient noise for organic displacement
      fn gradientNoise(px: f32, py: f32) -> f32 {
        let ix = i32(floor(px));
        let iy = i32(floor(py));
        let fx = fract(px);
        let fy = fract(py);
        // Smoothstep interpolation weights
        let ux = fx * fx * (3.0 - 2.0 * fx);
        let uy = fy * fy * (3.0 - 2.0 * fy);
        // Four corner hashes
        let a = hash2Dfloat(u32(ix),     u32(iy));
        let b = hash2Dfloat(u32(ix + 1), u32(iy));
        let c = hash2Dfloat(u32(ix),     u32(iy + 1));
        let d = hash2Dfloat(u32(ix + 1), u32(iy + 1));
        return mix(mix(a, b, ux), mix(c, d, ux), uy) * 2.0 - 1.0; // range: -1..1
      }

      // Compute texel displacement for a given pixel position
      fn computeDisplacement(px: f32, py: f32) -> vec2<f32> {
        let dispType  = i32(params[1].x);  // 0=none, 1=wave, 2=shake, 3=ripple, 4=noise, 5=turbulence
        let amplitude = params[1].y;
        let freq      = params[1].z;
        let speed     = params[1].w;
        let dir       = params[2].x;       // radians
        let phase     = params[2].y;
        let frame     = params[2].z;
        let flags     = u32(params[2].w);  // bit0 = displaceX, bit1 = displaceY
        let texW      = params[4].z;
        let texH      = params[4].w;

        if (dispType == 0 || amplitude < 0.001) {
          return vec2<f32>(0.0, 0.0);
        }

        let doX = (flags & 1u) != 0u;
        let doY = (flags & 2u) != 0u;

        // Normalized position
        let nx = px / texW;
        let ny = py / texH;

        // Direction vector
        let cs = cos(dir);
        let sn = sin(dir);

        var dx = 0.0;
        var dy = 0.0;

        switch (dispType) {
          // Wave: sinusoidal displacement along a direction
          case 1: {
            // Project pixel onto wave direction's perpendicular axis
            let proj = nx * (-sn) + ny * cs;
            let wave = sin(proj * freq * 6.283185 + frame * speed + phase);
            dx = select(0.0, wave * amplitude, doX);
            dy = select(0.0, wave * amplitude, doY);
            // Rotate displacement into wave direction
            let rdx = dx * cs - dy * sn;
            let rdy = dx * sn + dy * cs;
            dx = rdx;
            dy = rdy;
          }
          // Shake: whole-layer jitter per frame
          case 2: {
            let seed = u32(params[4].y);
            let fIdx = u32(frame) + seed;
            let jx = (hash2Dfloat(fIdx, 0u) * 2.0 - 1.0) * amplitude;
            let jy = (hash2Dfloat(fIdx, 1u) * 2.0 - 1.0) * amplitude;
            dx = select(0.0, jx, doX);
            dy = select(0.0, jy, doY);
          }
          // Ripple: radial waves from a center point
          case 3: {
            let cx = params[3].x;
            let cy = params[3].y;
            let dist = length(vec2<f32>(nx - cx, ny - cy));
            let wave = sin(dist * freq * 6.283185 - frame * speed + phase);
            // Radial direction from center
            let radDir = normalize(vec2<f32>(nx - cx, ny - cy) + vec2<f32>(0.0001));
            let d = wave * amplitude;
            dx = select(0.0, radDir.x * d, doX);
            dy = select(0.0, radDir.y * d, doY);
          }
          // Noise: simplex-like organic displacement
          case 4: {
            let nScale = freq;
            let nX = gradientNoise(nx * nScale + frame * speed, ny * nScale + phase);
            let nY = gradientNoise(nx * nScale + phase + 100.0, ny * nScale + frame * speed + 100.0);
            dx = select(0.0, nX * amplitude, doX);
            dy = select(0.0, nY * amplitude, doY);
          }
          // Turbulence: multi-octave layered noise
          case 5: {
            let octaves  = i32(params[3].z);
            let lacunarity  = params[3].w;
            let persistence = params[4].x;
            var tFreq = freq;
            var tAmp  = 1.0;
            var sumX  = 0.0;
            var sumY  = 0.0;
            var maxAmp = 0.0;
            for (var oi = 0; oi < 4; oi = oi + 1) {
              if (oi >= octaves) { break; }
              sumX = sumX + gradientNoise(nx * tFreq + frame * speed, ny * tFreq + phase) * tAmp;
              sumY = sumY + gradientNoise(nx * tFreq + phase + 50.0, ny * tFreq + frame * speed + 50.0) * tAmp;
              maxAmp = maxAmp + tAmp;
              tFreq = tFreq * lacunarity;
              tAmp = tAmp * persistence;
            }
            sumX = sumX / max(maxAmp, 0.001);
            sumY = sumY / max(maxAmp, 0.001);
            dx = select(0.0, sumX * amplitude, doX);
            dy = select(0.0, sumY * amplitude, doY);
          }
          default: {}
        }

        return vec2<f32>(dx, dy);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);

        let blendMode = i32(params[0].x);
        let opacity   = params[0].y;
        let clipped   = params[0].z > 0.5;

        let coords = vec2<i32>(ix, iy);
        let dst = textureLoad(accum, coords, 0);     // accumulated below

        // Compute displaced sample coordinates for this layer
        let disp = computeDisplacement(f32(ix), f32(iy));
        let sx = clamp(ix + i32(round(disp.x)), 0, i32(dim.x) - 1);
        let sy = clamp(iy + i32(round(disp.y)), 0, i32(dim.y) - 1);
        let src = textureLoad(layerTex, vec2<i32>(sx, sy), 0);

        // Layer opacity scales the source alpha
        var srcA = src.a * opacity;

        // Clipping mask: multiply source alpha by the accumulated alpha below
        if (clipped) {
          srcA = srcA * dst.a;
        }

        if (srcA <= 0.001) {
          // Nothing to blend — keep accumulated as-is
          textureStore(output, coords, dst);
          return;
        }

        // Apply blend mode to RGB (straight alpha, not premultiplied)
        let blendedRGB = applyBlend(blendMode, dst.rgb, src.rgb);

        // Standard alpha compositing: src over dst
        let outA = srcA + dst.a * (1.0 - srcA);
        var outRGB = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRGB = (blendedRGB * srcA + dst.rgb * dst.a * (1.0 - srcA)) / outA;
        }

        textureStore(output, coords, vec4<f32>(outRGB, outA));
      }
    `;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 80 } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }
}
