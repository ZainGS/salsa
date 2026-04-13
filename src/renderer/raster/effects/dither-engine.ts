/**
 * DitherEngine — GPU compute + WASM post-process that applies dithering effects
 * to a raster texture. Supports ordered dithering (Bayer, halftone, blue noise)
 * via GPU compute shaders and error diffusion (Floyd-Steinberg, Atkinson, etc.)
 * via Rust/WASM. Designed as a non-destructive effect in the compositor pipeline.
 *
 * Architecture:
 *   Ordered dithering: reads the input texture, applies a chosen threshold map
 *   per-pixel, writes result. Fully GPU-parallelized — no pixel dependencies.
 *
 *   Error diffusion: reads GPU texture → CPU buffer → calls Rust/WASM function
 *   (sequential scanline processing) → writes result back to GPU texture.
 *   Async operation — requires `await applyAsync()` instead of `apply()`.
 *
 * Supported algorithms:
 *   GPU (ordered):  Bayer, Halftone (dot/line/diamond), Blue Noise, Noise
 *   WASM (diffusion): Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Sierra, Sierra Lite
 */

import { applyErrorDiffusion, isWasmReady, type ErrorDiffusionAlgorithm } from '../../../wasm/wasm-bindings';

// ─── Types ──────────────────────────────────────────────────────

/** Dithering algorithm — ordered (GPU) or error diffusion (WASM). */
export type DitherAlgorithm =
  // GPU compute (ordered, real-time)
  | 'bayer'
  | 'halftone_dot'
  | 'halftone_line'
  | 'halftone_diamond'
  | 'blue_noise'
  | 'noise'
  // Rust/WASM (error diffusion, async)
  | 'floyd_steinberg'
  | 'atkinson'
  | 'jarvis_judice_ninke'
  | 'stucki'
  | 'sierra'
  | 'sierra_lite';

/** Shape of a halftone screen cell. */
export type HalftoneShape = 'dot' | 'line' | 'diamond';

/** How the dither pattern maps to colors. */
export type DitherColorMode =
  | 'quantize'   // Classic: quantize the existing pixel colors to N levels (default)
  | 'duotone';   // Map to explicit foreground/background colors

/** Full dither configuration. */
export interface DitherConfig {
  enabled: boolean;
  algorithm: DitherAlgorithm;

  /** Number of output colors per channel (2 = 1-bit, 4 = 2-bit, 256 = no-op). Default: 2. */
  colorLevels: number;

  /** Bayer matrix level (0 = 2×2, 1 = 4×4, 2 = 8×8, 3 = 16×16, 4 = 32×32). Default: 2. */
  bayerLevel: number;

  /** Halftone screen angle in degrees. Default: 45. */
  halftoneAngle: number;

  /** Halftone screen frequency (cells per texture width). Default: 40. */
  halftoneFrequency: number;

  /** Strength/blend: 0 = original, 1 = fully dithered. Default: 1.0. */
  strength: number;

  /** Pattern scale multiplier (1 = 1:1, 2 = 2× larger pattern). Default: 1.0. */
  patternScale: number;

  /** Apply per-channel (color dithering) vs. luminance-only (mono dithering). Default: false (mono). */
  perChannel: boolean;

  // ── Color Controls ──

  /** Color mapping mode. 'quantize' = reduce existing colors, 'duotone' = map to two explicit colors. Default: 'quantize'. */
  colorMode: DitherColorMode;

  /** Foreground (lit/bright area) color in RGBA 0-1. Used in 'duotone' mode. Default: black [0,0,0,1]. */
  foregroundColor: [number, number, number, number];

  /** Background (dark/shadow area) color in RGBA 0-1. Used in 'duotone' mode. Default: white [1,1,1,1]. */
  backgroundColor: [number, number, number, number];

  /** Swap foreground/background mapping (invert which areas get which color). Default: false.
   *  In quantize mode this inverts the dithered output. In duotone mode, prefer `duotoneBias` instead. */
  invertPattern: boolean;

  /** How strongly the duotone colors replace the original (0 = original, 1 = full duotone). Default: 1.0. */
  tintOpacity: number;

  /** Duotone coverage bias (0–1). Controls the balance between FG and BG dot coverage.
   *  0.0 = all BG (no dots), 0.5 = balanced 50/50, 1.0 = all FG (solid).
   *  Moving from 0.5 toward 0 or 1 has the same effect as the old invert toggle
   *  but with continuous control over dot density. Default: 0.5. */
  duotoneBias: number;
}

/** Default config for a newly created dither effect. */
export function defaultDitherConfig(): DitherConfig {
  return {
    enabled: false,
    algorithm: 'bayer',
    colorLevels: 2,
    bayerLevel: 2,
    halftoneAngle: 45,
    halftoneFrequency: 40,
    strength: 1.0,
    patternScale: 1.0,
    perChannel: false,
    colorMode: 'quantize',
    foregroundColor: [0, 0, 0, 1],
    backgroundColor: [1, 1, 1, 1],
    invertPattern: false,
    tintOpacity: 1.0,
    duotoneBias: 0.5,
  };
}

// ─── Engine ─────────────────────────────────────────────────────

export class DitherEngine {
  private device: GPUDevice;

  // Bayer pipeline
  private bayerPipeline: GPUComputePipeline | null = null;
  private bayerBGL: GPUBindGroupLayout | null = null;

  // Halftone pipeline
  private halftonePipeline: GPUComputePipeline | null = null;
  private halftoneBGL: GPUBindGroupLayout | null = null;

  // Noise pipeline
  private noisePipeline: GPUComputePipeline | null = null;
  private noiseBGL: GPUBindGroupLayout | null = null;

  // Blue noise pipeline + pre-baked threshold texture
  private blueNoisePipeline: GPUComputePipeline | null = null;
  private blueNoiseBGL: GPUBindGroupLayout | null = null;
  private blueNoiseTexture: GPUTexture | null = null;
  private blueNoiseSampler: GPUSampler | null = null;

  // Shared ping texture for read-back
  private pingTex: GPUTexture | null = null;
  private pingW = 0;
  private pingH = 0;

  // Shared params buffer (32 floats = 128 bytes, enough for all algorithms + color controls)
  private paramsBuf: GPUBuffer;

  // Frame counter for noise animation
  private frameCounter = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramsBuf = device.createBuffer({
      size: 128,  // 32 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Check if an algorithm requires WASM error diffusion (async) vs GPU compute (sync).
   */
  public static isErrorDiffusion(algorithm: DitherAlgorithm): boolean {
    return (
      algorithm === 'floyd_steinberg' ||
      algorithm === 'atkinson' ||
      algorithm === 'jarvis_judice_ninke' ||
      algorithm === 'stucki' ||
      algorithm === 'sierra' ||
      algorithm === 'sierra_lite'
    );
  }

  /**
   * Apply dithering to a texture in-place (synchronous — GPU ordered dithering only).
   * For error diffusion algorithms, this is a no-op. Use `applyAsync()` instead.
   */
  public apply(texture: GPUTexture, config: DitherConfig): void {
    if (!config.enabled || config.strength <= 0.001) return;
    // Error diffusion requires async — skip silently in sync path
    if (DitherEngine.isErrorDiffusion(config.algorithm)) return;

    const w = texture.width;
    const h = texture.height;
    if (w === 0 || h === 0) return;

    // Ensure ping texture
    this.ensurePing(w, h);

    // Copy input → ping (for reading)
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture }, { texture: this.pingTex! }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    switch (config.algorithm) {
      case 'bayer':
        this.applyBayer(texture, w, h, config);
        break;
      case 'halftone_dot':
      case 'halftone_line':
      case 'halftone_diamond':
        this.applyHalftone(texture, w, h, config);
        break;
      case 'blue_noise':
        this.applyBlueNoise(texture, w, h, config);
        break;
      case 'noise':
        this.applyNoise(texture, w, h, config);
        break;
    }

    this.frameCounter++;
  }

  /**
   * Apply dithering to a texture in-place (async — supports all algorithms).
   * For GPU ordered algorithms, delegates to `apply()` (fast, sync).
   * For error diffusion, reads the texture to CPU, runs WASM, writes back.
   */
  public async applyAsync(texture: GPUTexture, config: DitherConfig): Promise<void> {
    if (!config.enabled || config.strength <= 0.001) return;

    if (!DitherEngine.isErrorDiffusion(config.algorithm)) {
      // Ordered dithering — GPU sync path
      this.apply(texture, config);
      return;
    }

    // Error diffusion — WASM async path
    if (!isWasmReady()) {
      console.warn('[DitherEngine] WASM not initialized — skipping error diffusion');
      return;
    }

    const w = texture.width;
    const h = texture.height;
    if (w === 0 || h === 0) return;

    // 1. Read GPU texture → CPU buffer
    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const totalBytes = paddedRow * h;

    const readBuf = this.device.createBuffer({
      size: totalBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: readBuf, bytesPerRow: paddedRow },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readBuf.getMappedRange());

    // Tightly pack rows (remove GPU row padding)
    const pixels = new Uint8Array(unpaddedRow * h);
    for (let row = 0; row < h; row++) {
      pixels.set(
        mapped.subarray(row * paddedRow, row * paddedRow + unpaddedRow),
        row * unpaddedRow,
      );
    }
    readBuf.unmap();
    readBuf.destroy();

    // 2. Run WASM error diffusion in-place
    applyErrorDiffusion(
      config.algorithm as ErrorDiffusionAlgorithm,
      pixels,
      w,
      h,
      config.colorLevels,
    );

    // 3. Blend with original based on strength (if strength < 1)
    //    For strength = 1.0, skip the blend — the WASM output is the final result.
    //    (Color controls like duotone are not supported for error diffusion yet —
    //     the WASM path operates on raw pixel colors directly.)

    // 4. Write pixels back to GPU texture
    this.device.queue.writeTexture(
      { texture },
      pixels,
      { bytesPerRow: unpaddedRow },
      { width: w, height: h },
    );
  }

  /**
   * Write the color-control uniform slots (params[4..7]) that all shaders share.
   * Must be called after the algorithm-specific params are written into slots 0..3.
   */
  private writeColorUniforms(cfg: DitherConfig): void {
    const data = new Float32Array(16); // params[4..7] = 16 floats
    data[0]  = cfg.colorMode === 'duotone' ? 1.0 : 0.0;
    data[1]  = cfg.invertPattern ? 1.0 : 0.0;
    data[2]  = cfg.tintOpacity;
    data[3]  = cfg.duotoneBias ?? 0.5;
    data[4]  = cfg.foregroundColor[0];
    data[5]  = cfg.foregroundColor[1];
    data[6]  = cfg.foregroundColor[2];
    data[7]  = cfg.foregroundColor[3];
    data[8]  = cfg.backgroundColor[0];
    data[9]  = cfg.backgroundColor[1];
    data[10] = cfg.backgroundColor[2];
    data[11] = cfg.backgroundColor[3];
    // 12..15 = pad
    this.device.queue.writeBuffer(this.paramsBuf, 64, data); // offset 64 = after first 16 floats
  }

  public destroy(): void {
    this.paramsBuf.destroy();
    this.pingTex?.destroy();
    this.blueNoiseTexture?.destroy();
    this.pingTex = null;
    this.blueNoiseTexture = null;
  }

  // ─── Bayer Ordered Dithering ────────────────────────────────────

  private applyBayer(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig): void {
    this.ensureBayerPipeline();

    // params: [colorLevels, bayerLevel, strength, patternScale, perChannel, 0, 0, 0]
    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.bayerLevel;
    params[2] = cfg.strength;
    params[3] = cfg.patternScale;
    params[4] = cfg.perChannel ? 1.0 : 0.0;
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.bayerBGL!,
      entries: [
        { binding: 0, resource: this.pingTex!.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.dispatch(this.bayerPipeline!, bg, w, h);
  }

  private ensureBayerPipeline(): void {
    if (this.bayerPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 8>;

      // Bayer matrix computation (procedural, no lookup texture needed)
      // Computes the Bayer threshold for a given (x, y) at a given matrix level.
      fn bayerThreshold(x: u32, y: u32, level: u32) -> f32 {
        // Matrix size = 2^(level+1)
        let size = 1u << (level + 1u);
        var xm = x % size;
        var ym = y % size;
        var value = 0u;
        var s = size >> 1u;
        for (var i = 0u; i < level + 1u; i = i + 1u) {
          let bx = select(0u, 1u, xm >= s);
          let by = select(0u, 1u, ym >= s);
          // 2×2 base pattern index: [0,2; 3,1]
          let idx = (bx ^ by) | (by << 1u);
          // Map to Bayer order: 0→0, 1→2, 2→3, 3→1
          var mapped: u32;
          switch idx {
            case 0u: { mapped = 0u; }
            case 1u: { mapped = 2u; }
            case 2u: { mapped = 3u; }
            default:  { mapped = 1u; }
          }
          value = value * 4u + mapped;
          xm = xm % s;
          ym = ym % s;
          s = s >> 1u;
        }
        let total = size * size;
        return (f32(value) + 0.5) / f32(total);
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn applyColorMapping(original: vec3<f32>, dithered: vec3<f32>, srcAlpha: f32, strength: f32) -> vec4<f32> {
        let colorMode = params[4].x;
        let invertP = params[4].y > 0.5;
        let tintOp = params[4].z;
        let fg = params[5];
        let bg = params[6];
        var result = mix(original, dithered, strength);
        var outA = srcAlpha;
        if (colorMode > 0.5) {
          // Duotone: the dithered value encodes the spatial pattern (0 or 1 at 1-bit).
          // duotoneBias already controls coverage/inversion, so map directly to FG/BG.
          let t = dot(dithered, vec3<f32>(0.299, 0.587, 0.114));
          let duotone = mix(bg.rgb, fg.rgb, t);
          let duotoneA = mix(bg.a, fg.a, t);
          result = mix(original, duotone, strength * tintOp);
          outA = mix(srcAlpha, duotoneA, strength * tintOp);
        } else if (invertP) {
          let inverted = vec3<f32>(1.0) - dithered;
          result = mix(original, inverted, strength);
        }
        return vec4<f32>(result, outA);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let bayerLevel = u32(params[0].y);
        let strength = params[0].z;
        let patternScale = params[0].w;
        let perChannel = params[1].x > 0.5;

        let sx = u32(f32(gid.x) / patternScale);
        let sy = u32(f32(gid.y) / patternScale);

        let threshold = bayerThreshold(sx, sy, bayerLevel);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // In duotone mode, use the configurable bias (params[4].w) so the
        // pattern is purely spatial — independent of the brush/stroke color.
        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(duotoneBias + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          dithered = vec3<f32>(
            quantize(src.r + bias, colorLevels),
            quantize(src.g + bias, colorLevels),
            quantize(src.b + bias, colorLevels),
          );
        } else {
          // Mono: quantize luminance and output as grayscale.
          let lum = luminance(src.rgb);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength);
        textureStore(output, coords, col);
      }
    `;

    this.bayerBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.bayerPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bayerBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── Halftone Dithering ─────────────────────────────────────────

  private applyHalftone(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig): void {
    this.ensureHalftonePipeline();

    const shapeIdx = cfg.algorithm === 'halftone_dot' ? 0 :
                     cfg.algorithm === 'halftone_line' ? 1 : 2;
    const angleRad = (cfg.halftoneAngle * Math.PI) / 180;

    // params: [colorLevels, halftoneShape, strength, patternScale,
    //          angleRad, frequency, perChannel, 0,
    //          texW, texH, 0, 0]
    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = shapeIdx;
    params[2] = cfg.strength;
    params[3] = cfg.patternScale;
    params[4] = angleRad;
    params[5] = cfg.halftoneFrequency;
    params[6] = cfg.perChannel ? 1.0 : 0.0;
    params[8] = w;
    params[9] = h;
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.halftoneBGL!,
      entries: [
        { binding: 0, resource: this.pingTex!.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.dispatch(this.halftonePipeline!, bg, w, h);
  }

  private ensureHalftonePipeline(): void {
    if (this.halftonePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 8>;

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      fn applyColorMapping(original: vec3<f32>, dithered: vec3<f32>, srcAlpha: f32, strength: f32) -> vec4<f32> {
        let colorMode = params[4].x;
        let invertP = params[4].y > 0.5;
        let tintOp = params[4].z;
        let fg = params[5];
        let bg = params[6];
        var result = mix(original, dithered, strength);
        var outA = srcAlpha;
        if (colorMode > 0.5) {
          let t = dot(dithered, vec3<f32>(0.299, 0.587, 0.114));
          let duotone = mix(bg.rgb, fg.rgb, t);
          let duotoneA = mix(bg.a, fg.a, t);
          result = mix(original, duotone, strength * tintOp);
          outA = mix(srcAlpha, duotoneA, strength * tintOp);
        } else if (invertP) {
          let inverted = vec3<f32>(1.0) - dithered;
          result = mix(original, inverted, strength);
        }
        return vec4<f32>(result, outA);
      }

      // Generate a halftone threshold for a rotated cell grid.
      // Returns 0..1 threshold value.
      fn halftoneThreshold(px: f32, py: f32, angle: f32, freq: f32, shape: i32, texW: f32, texH: f32) -> f32 {
        // Normalize pixel coords to [0, freq] range
        let scale = freq / texW;
        let nx = px * scale;
        let ny = py * scale * (texW / texH); // correct aspect ratio

        // Rotate by screen angle
        let cs = cos(angle);
        let sn = sin(angle);
        let rx = nx * cs - ny * sn;
        let ry = nx * sn + ny * cs;

        // Position within cell (fractional part), centered at 0
        let cx = fract(rx) - 0.5;
        let cy = fract(ry) - 0.5;

        var threshold: f32;
        switch shape {
          // Dot (radial)
          case 0: {
            let dist = sqrt(cx * cx + cy * cy) * 1.4142; // normalize √2 → max ~1
            threshold = dist;
          }
          // Line (horizontal bands in rotated space)
          case 1: {
            threshold = abs(cy) * 2.0;
          }
          // Diamond
          default: {
            threshold = (abs(cx) + abs(cy));
          }
        }

        return clamp(threshold, 0.0, 1.0);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let shape = i32(params[0].y);
        let strength = params[0].z;
        let patternScale = params[0].w;
        let angle = params[1].x;
        let freq = params[1].y;
        let perChannel = params[1].z > 0.5;
        let texW = params[2].x;
        let texH = params[2].y;

        let px = f32(gid.x) / patternScale;
        let py = f32(gid.y) / patternScale;

        let threshold = halftoneThreshold(px, py, angle, freq, shape, texW, texH);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(duotoneBias + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          dithered = vec3<f32>(
            quantize(src.r + bias, colorLevels),
            quantize(src.g + bias, colorLevels),
            quantize(src.b + bias, colorLevels),
          );
        } else {
          let lum = luminance(src.rgb);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength);
        textureStore(output, coords, col);
      }
    `;

    this.halftoneBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.halftonePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.halftoneBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── White Noise Dithering ──────────────────────────────────────

  private applyNoise(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig): void {
    this.ensureNoisePipeline();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = this.frameCounter; // seed
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.noiseBGL!,
      entries: [
        { binding: 0, resource: this.pingTex!.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
      ],
    });

    this.dispatch(this.noisePipeline!, bg, w, h);
  }

  private ensureNoisePipeline(): void {
    if (this.noisePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 8>;

      // PCG hash for deterministic random from pixel coord + seed
      fn pcgHash(input: u32) -> u32 {
        var state = input * 747796405u + 2891336453u;
        let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
        return (word >> 22u) ^ word;
      }

      fn rand01(x: u32, y: u32, seed: u32) -> f32 {
        let h = pcgHash(x + pcgHash(y + pcgHash(seed)));
        return f32(h) / 4294967295.0;
      }

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      fn applyColorMapping(original: vec3<f32>, dithered: vec3<f32>, srcAlpha: f32, strength: f32) -> vec4<f32> {
        let colorMode = params[4].x;
        let invertP = params[4].y > 0.5;
        let tintOp = params[4].z;
        let fg = params[5];
        let bg = params[6];
        var result = mix(original, dithered, strength);
        var outA = srcAlpha;
        if (colorMode > 0.5) {
          let t = dot(dithered, vec3<f32>(0.299, 0.587, 0.114));
          let duotone = mix(bg.rgb, fg.rgb, t);
          let duotoneA = mix(bg.a, fg.a, t);
          result = mix(original, duotone, strength * tintOp);
          outA = mix(srcAlpha, duotoneA, strength * tintOp);
        } else if (invertP) {
          let inverted = vec3<f32>(1.0) - dithered;
          result = mix(original, inverted, strength);
        }
        return vec4<f32>(result, outA);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let strength = params[0].y;
        let perChannel = params[0].z > 0.5;
        let seed = u32(params[0].w);

        let threshold = rand01(gid.x, gid.y, seed);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(duotoneBias + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          dithered = vec3<f32>(
            quantize(src.r + bias, colorLevels),
            quantize(src.g + (rand01(gid.x + 1000u, gid.y, seed) - 0.5) * spread, colorLevels),
            quantize(src.b + (rand01(gid.x, gid.y + 1000u, seed) - 0.5) * spread, colorLevels),
          );
        } else {
          let lum = luminance(src.rgb);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength);
        textureStore(output, coords, col);
      }
    `;

    this.noiseBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.noisePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.noiseBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── Blue Noise Dithering ───────────────────────────────────────

  private applyBlueNoise(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig): void {
    this.ensureBlueNoisePipeline();
    this.ensureBlueNoiseTexture();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = cfg.patternScale;
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.blueNoiseBGL!,
      entries: [
        { binding: 0, resource: this.pingTex!.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 3, resource: this.blueNoiseTexture!.createView() },
        { binding: 4, resource: this.blueNoiseSampler! },
      ],
    });

    this.dispatch(this.blueNoisePipeline!, bg, w, h);
  }

  private ensureBlueNoisePipeline(): void {
    if (this.blueNoisePipeline) return;

    this.blueNoiseSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 8>;
      @group(0) @binding(3) var bnTex: texture_2d<f32>;
      @group(0) @binding(4) var bnSamp: sampler;

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      fn applyColorMapping(original: vec3<f32>, dithered: vec3<f32>, srcAlpha: f32, strength: f32) -> vec4<f32> {
        let colorMode = params[4].x;
        let invertP = params[4].y > 0.5;
        let tintOp = params[4].z;
        let fg = params[5];
        let bg = params[6];
        var result = mix(original, dithered, strength);
        var outA = srcAlpha;
        if (colorMode > 0.5) {
          let t = dot(dithered, vec3<f32>(0.299, 0.587, 0.114));
          let duotone = mix(bg.rgb, fg.rgb, t);
          let duotoneA = mix(bg.a, fg.a, t);
          result = mix(original, duotone, strength * tintOp);
          outA = mix(srcAlpha, duotoneA, strength * tintOp);
        } else if (invertP) {
          let inverted = vec3<f32>(1.0) - dithered;
          result = mix(original, inverted, strength);
        }
        return vec4<f32>(result, outA);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let strength = params[0].y;
        let perChannel = params[0].z > 0.5;
        let patternScale = params[0].w;

        let bnDim = textureDimensions(bnTex);
        let uv = vec2<f32>(f32(gid.x), f32(gid.y)) / (vec2<f32>(f32(bnDim.x), f32(bnDim.y)) * patternScale);
        let threshold = textureSampleLevel(bnTex, bnSamp, uv, 0.0).r;

        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(duotoneBias + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          dithered = vec3<f32>(
            quantize(src.r + bias, colorLevels),
            quantize(src.g + bias, colorLevels),
            quantize(src.b + bias, colorLevels),
          );
        } else {
          let lum = luminance(src.rgb);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength);
        textureStore(output, coords, col);
      }
    `;

    this.blueNoiseBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });

    this.blueNoisePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.blueNoiseBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  /**
   * Generate a 64×64 blue noise threshold texture on the CPU using
   * a void-and-cluster approximation, then upload to GPU.
   */
  private ensureBlueNoiseTexture(): void {
    if (this.blueNoiseTexture) return;

    const SIZE = 64;
    const total = SIZE * SIZE;

    // --- Void-and-cluster approximation ---
    // 1. Seed random initial pattern (10% white pixels)
    const pattern = new Uint8Array(total);
    const initialWhiteCount = Math.floor(total * 0.1);
    const indices = Array.from({ length: total }, (_, i) => i);
    // Fisher-Yates shuffle for random placement
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let i = 0; i < initialWhiteCount; i++) pattern[indices[i]] = 1;

    // 2. Gaussian energy function (toroidal wrapping)
    const sigma = 1.5;
    const kernelR = 4;
    const gauss = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));

    const computeEnergy = (buf: Uint8Array, x: number, y: number): number => {
      let e = 0;
      for (let dy = -kernelR; dy <= kernelR; dy++) {
        for (let dx = -kernelR; dx <= kernelR; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ((x + dx) % SIZE + SIZE) % SIZE;
          const ny = ((y + dy) % SIZE + SIZE) % SIZE;
          if (buf[ny * SIZE + nx]) e += gauss(dx, dy);
        }
      }
      return e;
    };

    // 3. Iterative swap: move tightest cluster pixel to largest void (30 iterations)
    for (let iter = 0; iter < 30; iter++) {
      let maxE = -1, maxIdx = 0;
      let minE = Infinity, minIdx = 0;

      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const idx = y * SIZE + x;
          const e = computeEnergy(pattern, x, y);
          if (pattern[idx] === 1 && e > maxE) { maxE = e; maxIdx = idx; }
          if (pattern[idx] === 0 && e < minE) { minE = e; minIdx = idx; }
        }
      }

      if (maxIdx === minIdx) break;
      pattern[maxIdx] = 0;
      pattern[minIdx] = 1;
    }

    // 4. Rank all pixels by energy to produce the threshold map
    const energies = new Float32Array(total);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        energies[y * SIZE + x] = computeEnergy(pattern, x, y) + (pattern[y * SIZE + x] ? 1000 : 0);
      }
    }

    // Sort indices by energy, assign rank as threshold
    const ranked = Array.from({ length: total }, (_, i) => i);
    ranked.sort((a, b) => energies[a] - energies[b]);
    const thresholds = new Float32Array(total);
    for (let r = 0; r < total; r++) {
      thresholds[ranked[r]] = (r + 0.5) / total;
    }

    // 5. Upload as r8unorm GPU texture
    const pixels = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      pixels[i] = Math.round(thresholds[i] * 255);
    }

    this.blueNoiseTexture = this.device.createTexture({
      size: [SIZE, SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture: this.blueNoiseTexture },
      pixels,
      { bytesPerRow: SIZE },
      { width: SIZE, height: SIZE },
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private ensurePing(w: number, h: number): void {
    if (this.pingTex && this.pingW === w && this.pingH === h) return;
    this.pingTex?.destroy();
    this.pingTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.pingW = w;
    this.pingH = h;
  }

  private dispatch(pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, w: number, h: number): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
