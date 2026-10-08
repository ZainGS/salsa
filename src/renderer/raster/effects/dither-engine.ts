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
 *   GPU (ordered):  Bayer, Halftone (14 screen shapes, see HALFTONE_SHAPES), Blue Noise, Noise
 *   WASM (diffusion): Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Sierra, Sierra Lite
 */

import { applyErrorDiffusion, isWasmReady, type ErrorDiffusionAlgorithm } from '../../../wasm/wasm-bindings';

// ─── Types ──────────────────────────────────────────────────────

/** Dithering algorithm — ordered (GPU) or error diffusion (WASM). */
// Shared WGSL: duotone / invert / strength color mapping — was copy-pasted into all 4 dither shaders
// (audit B4). Every dither shader binds the same params layout (params[4]=mode/invert/tintOp,
// params[5]=fg, params[6]=bg), so the helper interpolates verbatim.
const WGSL_APPLY_COLOR_MAPPING = /* wgsl */ `
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
`;

// Shared WGSL: edge/boundary effects (2026-09-15). `edgeFactor` estimates distance to the layer's
// CONTENT edge (alpha boundary) as a 0→1 factor over `radius` px: a 25-tap disc average of src
// alpha reads ~0.5 at a straight boundary and →1 deep inside; remapped so 0 ≈ at the edge. Every
// dither shader binds srcTex at @binding(0) and the same params layout (params[7] = edgeWidth /
// edgeFade / edgeShrink / edgeDensity), so the helpers interpolate verbatim — same pattern as
// WGSL_APPLY_COLOR_MAPPING above.
const WGSL_EDGE_HELPERS = /* wgsl */ `
      // Per-cell hash for density dropout (PCG-style; named edge* to avoid colliding with the
      // noise shader's own rand helpers).
      fn edgeHashU(input: u32) -> u32 {
        var state = input * 747796405u + 2891336453u;
        let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
        return (word >> 22u) ^ word;
      }
      fn edgeCellRand(cell: vec2<i32>, seed: u32) -> f32 {
        let h = edgeHashU(u32(cell.x + 32768) + edgeHashU(u32(cell.y + 32768) + edgeHashU(seed)));
        return f32(h) / 4294967295.0;
      }

      // 0 at the content (alpha) boundary → 1 at >= radius px inside. 25 taps: centre + 3 rings.
      // Coverage counts alpha PRESENCE (a >= 0.004, the same cutoff the dither early-out uses),
      // not alpha VALUE — a half-opacity wash must read as solid interior, not as "near an edge".
      fn edgeFactor(coords: vec2<i32>, radius: f32) -> f32 {
        let dim = vec2<i32>(textureDimensions(srcTex));
        var cov = 1.0;   // the centre pixel passed the caller's alpha early-out
        var count = 1.0;
        for (var ring = 0u; ring < 3u; ring = ring + 1u) {
          let r = radius * (f32(ring + 1u) / 3.0);
          for (var k = 0u; k < 8u; k = k + 1u) {
            // 8 taps per ring, staggered a half-step per ring so taps don't line up radially.
            let ang = (f32(k) + f32(ring) * 0.5) * 0.7853981634;
            let o = vec2<f32>(cos(ang), sin(ang)) * r;
            let p = clamp(coords + vec2<i32>(o + sign(o) * 0.5), vec2<i32>(0), dim - vec2<i32>(1));
            cov = cov + select(0.0, 1.0, textureLoad(srcTex, p, 0).a >= 0.004);
            count = count + 1.0;
          }
        }
        cov = cov / count;
        return clamp((cov - 0.5) * 2.0, 0.0, 1.0);
      }

      // 0 at the CANVAS border → 1 at >= radius px inside it. Pure arithmetic — no taps.
      fn edgeFactorCanvas(coords: vec2<i32>, radius: f32) -> f32 {
        let dim = vec2<i32>(textureDimensions(srcTex));
        let dist = f32(min(min(coords.x, coords.y), min(dim.x - 1 - coords.x, dim.y - 1 - coords.y)));
        return clamp(dist / radius, 0.0, 1.0);
      }

      // Mode-dispatched edge factor. params[3].x = mode (0 content, 1 canvas, 2 both).
      fn edgeRaw(coords: vec2<i32>, radius: f32) -> f32 {
        let mode = params[3].x;
        if (mode < 0.5) {          // content: the painted alpha boundary (nearest no-paint gap)
          return edgeFactor(coords, radius);
        } else if (mode < 1.5) {   // canvas: the texture border only (skips the 24 taps entirely)
          return edgeFactorCanvas(coords, radius);
        }
        return min(edgeFactor(coords, radius), edgeFactorCanvas(coords, radius));   // nearest wins
      }

      // Edge factor at an arbitrary point (a pattern CELL CENTRE, possibly out of bounds) — used by
      // the density dropout so a whole dot lives or dies from ONE evaluation (no half-cut dots).
      fn edgeAt(coords: vec2<i32>, radius: f32) -> f32 {
        let dim = vec2<i32>(textureDimensions(srcTex));
        return edgeRaw(clamp(coords, vec2<i32>(0), dim - vec2<i32>(1)), radius);
      }

      // Shared per-pixel edge state: x = strength multiplier (fade), y = shrink NEARNESS
      // (0 deep inside → |shrink| at the boundary), z = the raw edge factor.
      // params[7] = (width, fade, shrink SIGNED -1..1, density).
      fn edgeState(coords: vec2<i32>) -> vec3<f32> {
        let ep = params[7];
        if (ep.x < 0.5 || (ep.y + abs(ep.z) + ep.w) < 0.001) { return vec3<f32>(1.0, 0.0, 1.0); }
        let e = edgeRaw(coords, ep.x);
        return vec3<f32>(mix(1.0, e, ep.y), (1.0 - e) * abs(ep.z), e);
      }

      // Shrink landing point (rev 4, 2026-09-16 — direction-aware): POSITIVE shrink always
      // removes the DOT phase — duotoneBias > 0.5 means the round dots are the BG phase, so the
      // bias must ramp toward 1 (all FG) for them to shrink; <= 0.5 ramps toward 0 as before.
      // NEGATIVE shrink targets the opposite extreme: dots GROW into a solid rim (the outline
      // effect). Bias exactly 0.5 keeps the classic toward-0 behavior.
      fn shrinkTargetBias(duotoneBias: f32) -> f32 {
        let tS = select(0.0, 1.0, duotoneBias > 0.5);
        return select(tS, 1.0 - tS, params[7].z < 0.0);
      }
      // Quantize-mode landing value: positive → paper-white, negative → ink-black.
      fn shrinkTargetValue() -> f32 {
        return select(1.0, 0.0, params[7].z < 0.0);
      }
`;

export type DitherAlgorithm =
  // GPU compute (ordered, real-time)
  | 'bayer'
  | HalftoneAlgorithm   // 'halftone_dot' | 'halftone_line' | ... one value per HALFTONE_SHAPES entry
  | 'blue_noise'
  | 'noise'
  // Rust/WASM (error diffusion, async)
  | 'floyd_steinberg'
  | 'atkinson'
  | 'jarvis_judice_ninke'
  | 'stucki'
  | 'sierra'
  | 'sierra_lite';

/** Halftone screen shapes, in SHADER INDEX order (params[0].y) — append only: the index is the
 *  shader's switch case, and dot / line / diamond (0..2) are the original three that saved documents
 *  use. rings / spiral are GLOBAL patterns (centred on the texture), the rest are per-cell. */
export const HALFTONE_SHAPES = [
  'dot', 'line', 'diamond',
  'square', 'cross', 'ellipse', 'wavy', 'crosshatch', 'rings', 'spiral', 'hexagon', 'star', 'heart', 'triangle',
] as const;

/** Shape of a halftone screen cell. */
export type HalftoneShape = typeof HALFTONE_SHAPES[number];

/** The dither algorithm value for each halftone shape ('halftone_' + shape — the stored form). */
export type HalftoneAlgorithm = `halftone_${HalftoneShape}`;

/** True for every 'halftone_*' algorithm (including a shape this build does not know — it renders as Dot). */
export function isHalftoneAlgorithm(algorithm: string): algorithm is HalftoneAlgorithm {
  return typeof algorithm === 'string' && algorithm.startsWith('halftone_');
}

/** The shader shape index of a halftone algorithm: dot 0, line 1, diamond 2, then HALFTONE_SHAPES order.
 *  An unknown 'halftone_*' value (a newer document) falls back to 0 (Dot); a non-halftone algorithm is -1. */
export function halftoneShapeIndex(algorithm: string): number {
  if (!isHalftoneAlgorithm(algorithm)) return -1;
  const i = (HALFTONE_SHAPES as readonly string[]).indexOf(algorithm.slice('halftone_'.length));
  return i < 0 ? 0 : i;
}

/** Every dither algorithm this engine supports, in UI order (GPU ordered first, then WASM error diffusion).
 *  Hosts can feature-detect a halftone shape by looking its algorithm value up here. */
export const DITHER_ALGORITHMS: readonly DitherAlgorithm[] = [
  'bayer', ...HALFTONE_SHAPES.map((s): HalftoneAlgorithm => `halftone_${s}`), 'blue_noise', 'noise',
  'floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite',
];

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

  // ── Edge/Boundary Effects (2026-09-15) ──
  // The "edge" is the CONTENT boundary — where the layer's painted alpha ends (a stroke's outline,
  // a filled shape's rim). A cheap alpha-coverage disc sample gives a smooth 0→1 distance factor
  // over `edgeWidth` px; the three amounts below shape how the pattern behaves inside that band.
  // Ordered (GPU) algorithms only — error-diffusion (WASM) ignores these.

  /** Width in px of the edge band the effects ramp across. 0 = edge effects off. Default: 0. */
  edgeWidth: number;

  /** 0–1: fade the dither back to the original toward the edge (pattern dissolves out). Default: 0. */
  edgeFade: number;

  /** -1..1: pattern DOT SIZE ramp toward the edge. Positive = dots shrink until they vanish at
   *  the boundary — direction-aware, so it shrinks whichever color currently forms the dots
   *  (duotoneBias > 0.5 = BG-phase dots ramp toward all-FG; otherwise toward all-BG as classic).
   *  NEGATIVE = dots GROW into a solid rim (the outline effect). Quantize mode: positive pulls
   *  toward paper-white, negative toward ink-black. Default: 0. */
  edgeShrink: number;

  /** 0–1: decrease pattern density toward the edge — whole cells/dots drop out stochastically.
   *  A dropped cell is ERASED (fully transparent), independent of the FG/BG colors — the layer
   *  dissolves to nothing in halftone-cell chunks. Neither the original artwork (that's
   *  `edgeFade`) nor the paper color (that's `edgeShrink`) shows in a dropped cell, and swapping
   *  FG/BG never turns dropped cells solid. All-or-nothing per cell. For noise/blue-noise this
   *  folds into coverage (no discrete cells). Default: 0. */
  edgeDensity: number;

  /** Integer seed for the density dropout arrangement — re-roll to get a different set of dropped
   *  dots (deterministic per seed: a static illustration never shimmers). Default: 0. */
  edgeSeed: number;

  /** Which boundary the effects ramp toward. 'content' (default) = the painted alpha boundary —
   *  stroke outlines, blob rims, erased holes (the nearest no-paint gap). 'canvas' = the texture's
   *  own border (analytic distance, cheapest). 'both' = nearest of the two. */
  edgeMode: 'content' | 'canvas' | 'both';
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
    edgeWidth: 0,
    edgeFade: 0,
    edgeShrink: 0,
    edgeDensity: 0,
    edgeSeed: 0,
    edgeMode: 'content',
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

  // PERF (audit 5.6): persistent MAP_READ readback buffer for the error-diffusion
  // path — recreated only when the required size changes instead of allocated and
  // destroyed on every composite. The busy flag guards against overlapping
  // applyAsync calls (a buffer cannot be mapped twice concurrently); if that
  // ever happens we fall back to a throwaway buffer for the overlapping call.
  private _readBuf: GPUBuffer | null = null;
  private _readBufSize = 0;
  private _readBufBusy = false;

  // Frame counter for noise animation
  private frameCounter = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramsBuf = device.createBuffer({
      size: 128,  // 32 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Numeric edge-mode for the shaders (params[3].x): 0 content, 1 canvas, 2 both.
   *  Defensive default 'content' — configs saved before 2026-09-15 lack the field. */
  private static edgeModeIndex(cfg: DitherConfig): number {
    return cfg.edgeMode === 'canvas' ? 1 : cfg.edgeMode === 'both' ? 2 : 0;
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
   *
   * PERF (audit 5.7): when `sharedEncoder` is provided, the input copy and the
   * compute dispatch are recorded into it and NO submit happens here — the
   * caller owns the submit (the compositor batches its per-layer copy with the
   * dither work into one submit). Without it, both commands still share one
   * internally-owned encoder/submit (was 2 standalone submits per call).
   * Note: the uniform writeBuffer calls below are queue-ordered ahead of any
   * later submit, so deferring the submit is safe — but because paramsBuf is
   * shared, callers must submit the encoder before the next apply() call.
   */
  public apply(texture: GPUTexture, config: DitherConfig, sharedEncoder?: GPUCommandEncoder): void {
    if (!config.enabled || config.strength <= 0.001) return;
    // Error diffusion requires async — skip silently in sync path
    if (DitherEngine.isErrorDiffusion(config.algorithm)) return;

    const w = texture.width;
    const h = texture.height;
    if (w === 0 || h === 0) return;

    // Ensure ping texture
    this.ensurePing(w, h);

    const enc = sharedEncoder ?? this.device.createCommandEncoder();

    // Copy input → ping (for reading)
    enc.copyTextureToTexture({ texture }, { texture: this.pingTex! }, { width: w, height: h });

    switch (config.algorithm) {
      case 'bayer':
        this.applyBayer(texture, w, h, config, enc);
        break;
      case 'blue_noise':
        this.applyBlueNoise(texture, w, h, config, enc);
        break;
      case 'noise':
        this.applyNoise(texture, w, h, config, enc);
        break;
      default:
        // Every 'halftone_*' shape (an unknown one from a newer document renders as Dot).
        if (isHalftoneAlgorithm(config.algorithm)) this.applyHalftone(texture, w, h, config, enc);
        break;
    }

    if (!sharedEncoder) this.device.queue.submit([enc.finish()]);

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

    // PERF (audit 5.6): reuse the persistent MAP_READ buffer across frames;
    // recreate only when the required size changes. Fall back to a throwaway
    // buffer if a previous applyAsync is still mid-map (overlapping calls).
    let readBuf: GPUBuffer;
    let ownsReadBuf = false;
    if (!this._readBufBusy) {
      if (!this._readBuf || this._readBufSize !== totalBytes) {
        this._readBuf?.destroy();
        this._readBuf = this.device.createBuffer({
          size: totalBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this._readBufSize = totalBytes;
      }
      readBuf = this._readBuf;
      this._readBufBusy = true;
    } else {
      readBuf = this.device.createBuffer({
        size: totalBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      ownsReadBuf = true;
    }

    const pixels = new Uint8Array(unpaddedRow * h);
    try {
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
      for (let row = 0; row < h; row++) {
        pixels.set(
          mapped.subarray(row * paddedRow, row * paddedRow + unpaddedRow),
          row * unpaddedRow,
        );
      }
      readBuf.unmap();
    } finally {
      // Release/clean up even if mapAsync rejects (e.g. device loss)
      if (ownsReadBuf) readBuf.destroy();
      else this._readBufBusy = false;
    }

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
    // 12..15 = params[7]: edge effects (defensive ?? — configs saved before 2026-09-15 lack them)
    data[12] = cfg.edgeWidth ?? 0;
    data[13] = cfg.edgeFade ?? 0;
    data[14] = cfg.edgeShrink ?? 0;
    data[15] = cfg.edgeDensity ?? 0;
    this.device.queue.writeBuffer(this.paramsBuf, 64, data); // offset 64 = after first 16 floats
  }

  public destroy(): void {
    this.paramsBuf.destroy();
    this.pingTex?.destroy();
    this.blueNoiseTexture?.destroy();
    this._readBuf?.destroy();
    this.pingTex = null;
    this.blueNoiseTexture = null;
    this._readBuf = null;
    this._readBufSize = 0;
  }

  // ─── Bayer Ordered Dithering ────────────────────────────────────

  private applyBayer(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder): void {
    this.ensureBayerPipeline();

    // params: [colorLevels, bayerLevel, strength, patternScale, perChannel, 0, 0, 0]
    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.bayerLevel;
    params[2] = cfg.strength;
    params[3] = cfg.patternScale;
    params[4] = cfg.perChannel ? 1.0 : 0.0;
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
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

    this.dispatch(this.bayerPipeline!, bg, w, h, enc);
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

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
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

        // Edge effects: es.x = fade strength multiplier, es.y = coverage shrink, es.z = edge factor.
        let es = edgeState(coords);
        let effStrength = strength * es.x;
        // Density: drop whole Bayer TILES near the edge. ALL-OR-NOTHING per tile (edge factor
        // evaluated once at the tile centre), and a dropped tile renders the PAPER state (BG in
        // duotone / white in quantize) — the dot is REMOVED, leaving the pattern sparser. (Rev 2,
        // 2026-09-15: the first cut zeroed strength, which revealed the ORIGINAL artwork — that is
        // edgeFade's job, not density's.) params[3].y = the dropout seed.
        var cellDropped = false;
        let edgeDensity = params[7].w;
        if (edgeDensity > 0.001) {
          let cellSize = i32(1u << (bayerLevel + 1u));
          let cell = vec2<i32>(i32(sx) / cellSize, i32(sy) / cellSize);
          let centerPx = (vec2<f32>(cell) + 0.5) * f32(cellSize) * patternScale;
          let eCell = edgeAt(vec2<i32>(centerPx), params[7].x);
          if (edgeCellRand(cell, u32(params[3].y)) > 1.0 - edgeDensity * (1.0 - eCell)) { cellDropped = true; }
        }

        // A density-dropped tile is ERASED — fully transparent, independent of the FG/BG colors.
        // (Rev 3, 2026-09-15: rev 2 forced the BG state, which turned SOLID after a color swap —
        // "removing a dot" must dissolve to nothing, whichever color plays paper.)
        if (cellDropped) {
          textureStore(output, coords, vec4<f32>(0.0));
          return;
        }

        // In duotone mode, use the configurable bias (params[4].w) so the
        // pattern is purely spatial — independent of the brush/stroke color.
        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          // Shrink: ramp the bias toward the direction-aware landing extreme near the edge —
          // positive shrink makes the dots (whichever phase they are) shrink away.
          let ditheredLum = quantize(mix(duotoneBias, shrinkTargetBias(duotoneBias), es.y) + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          // Shrink (quantize mode): pull values toward paper-white (or ink-black when negative).
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, es.y) + bias, colorLevels),
            quantize(mix(src.g, tq, es.y) + bias, colorLevels),
            quantize(mix(src.b, tq, es.y) + bias, colorLevels),
          );
        } else {
          // Mono: quantize luminance and output as grayscale.
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), es.y);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, effStrength);
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

  private applyHalftone(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder): void {
    this.ensureHalftonePipeline();

    const shapeIdx = Math.max(0, halftoneShapeIndex(cfg.algorithm));
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
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
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

    this.dispatch(this.halftonePipeline!, bg, w, h, enc);
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

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
      const HT_TAU: f32 = 6.28318531;
      const HT_SQRT3: f32 = 1.7320508;

      // Pixel coords to the ROTATED screen space (one unit = one cell). ONE scale for both axes: pixels are square,
      // so square cells (round dots) need the same scale on x and y - the old "aspect" factor (texW / texH) on y
      // stretched every cell on a non-square texture (oval dots on a portrait / landscape page).
      fn halftoneRot(px: f32, py: f32, angle: f32, freq: f32, texW: f32) -> vec2<f32> {
        let scale = freq / texW;
        let nx = px * scale;
        let ny = py * scale;
        let cs = cos(angle);
        let sn = sin(angle);
        return vec2<f32>(nx * cs - ny * sn, nx * sn + ny * cs);
      }

      // Honeycomb: offset from the NEAREST hexagon centre (centres at (i, j*sqrt3) and (i + 0.5, (j + 0.5)*sqrt3),
      // neighbours one unit apart). Two offset rectangular grids, keep the closer centre.
      fn htHexOffset(p: vec2<f32>) -> vec2<f32> {
        let r = vec2<f32>(1.0, HT_SQRT3);
        let h = r * 0.5;
        let a = p - r * floor(p / r) - h;
        let q = p - h;
        let b = q - r * floor(q / r) - h;
        return select(b, a, dot(a, a) < dot(b, b));
      }

      // Shape GAUGES: the scale at which p sits on the shape outline (0 at the shape origin, 1 on the unit outline).
      // Level sets are scaled copies of the shape, so the ink grows as the same shape. p.y points UP.
      // 5-point star, tip radius 1, inner radius 0.5: |p| over the outline radius in that direction.
      fn htStarGauge(p: vec2<f32>) -> f32 {
        let a0 = atan2(p.x, p.y);                                        // 0 = straight up (a tip)
        let a = abs(a0 - (HT_TAU / 5.0) * round(a0 / (HT_TAU / 5.0)));   // 0..36 degrees from the nearest tip
        let rs = 0.5 * 0.58778525;                                       // inner radius * sin 36
        let rc = 0.5 * 0.80901699 - 1.0;                                 // inner radius * cos 36 - tip radius
        return length(p) * (cos(a) * rs - sin(a) * rc) / rs;
      }
      // Disc of radius |c| centred at c (the origin is on its rim): p is inside k*disc for k >= |p|^2 / (2 p.c).
      fn htDiscGauge(p: vec2<f32>, c: vec2<f32>) -> f32 {
        let pc = dot(p, c);
        return select(1.0e4, dot(p, p) / max(2.0 * pc, 1.0e-6), pc > 1.0e-6);
      }
      // Classic heart: a 45-degree square of side 1 plus two discs on its upper edges (union = min of gauges).
      fn htHeartGauge(p: vec2<f32>) -> f32 {
        let gSq = (abs(p.x) + abs(p.y)) / 0.70710678;
        let c = vec2<f32>(0.35355339, 0.35355339);
        return min(gSq, min(htDiscGauge(p, c), htDiscGauge(p, vec2<f32>(-c.x, c.y))));
      }
      // Upward equilateral triangle, inradius 1, centroid at the origin.
      fn htTriangleGauge(p: vec2<f32>) -> f32 {
        return max(-p.y, max(0.8660254 * p.x + 0.5 * p.y, -0.8660254 * p.x + 0.5 * p.y));
      }
      // Figurative shapes do not tile, so the last tones fill in with a square growing from the cell centre
      // (starts at 0.6, reaches the cell edge at 1) - the cell still goes solid smoothly instead of all at once.
      fn htFillTail(t: f32, cx: f32, cy: f32) -> f32 {
        return min(t, 0.6 + 0.4 * max(abs(cx), abs(cy)) * 2.0);
      }

      // Generate a halftone threshold for a rotated cell grid.
      // Returns 0..1 threshold value. ctr = the texture centre in pre-patternScale pixels (the rings / spiral origin).
      fn halftoneThreshold(px: f32, py: f32, angle: f32, freq: f32, shape: i32, texW: f32, texH: f32, ctr: vec2<f32>) -> f32 {
        let r = halftoneRot(px, py, angle, freq, texW);
        let rx = r.x;
        let ry = r.y;

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
          // Square (Chebyshev)
          case 3: {
            threshold = max(abs(cx), abs(cy)) * 2.0;
          }
          // Cross: a plus whose arms reach the cell edges at 0.5, then thicken into a grid
          case 4: {
            let ax = abs(cx);
            let ay = abs(cy);
            threshold = max(min(ax, ay) * 2.0, max(ax, ay));
          }
          // Ellipse (chain dot): y weighted 1.5x, so dots touch along x first and join into chains in the midtones
          case 5: {
            threshold = length(vec2<f32>(cx, cy * 1.5)) / 0.9013878;
          }
          // Wavy lines: the line screen with a sine offset along the line (period 3 cells, amplitude 0.3 cell)
          case 6: {
            let wy = ry + 0.3 * sin(rx * (HT_TAU / 3.0));
            threshold = abs(fract(wy) - 0.5) * 2.0;
          }
          // Crosshatch: one line direction for the light tones, the perpendicular set joins from 0.45 on
          case 7: {
            threshold = min(abs(cy) * 2.0, 0.45 + 0.55 * abs(cx) * 2.0);
          }
          // Concentric rings (GLOBAL): distance from the texture centre, one ring per cell width
          case 8: {
            let d = length(vec2<f32>(px, py) - ctr) * (freq / texW);
            threshold = abs(fract(d) - 0.5) * 2.0;
          }
          // Spiral (GLOBAL): one Archimedean arm around the texture centre, arm spacing one cell width,
          // the screen angle rotates it
          case 9: {
            let v = vec2<f32>(px, py) - ctr;
            let d = length(v) * (freq / texW);
            let a = atan2(v.y, v.x) - angle;
            threshold = abs(fract(d - a / HT_TAU) - 0.5) * 2.0;
          }
          // Hexagon: honeycomb cells, hex distance to the nearest centre (1 on the shared edges)
          case 10: {
            let o = abs(htHexOffset(r));
            threshold = max(o.x, dot(o, vec2<f32>(0.5, 0.8660254))) * 2.0;
          }
          // Star: 5 points, tips touch the cell edge at 0.625
          case 11: {
            threshold = htFillTail(htStarGauge(vec2<f32>(cx, -cy)) * 1.25, cx, cy);
          }
          // Heart: full cell width at about 0.85 (origin a little below the cell centre so the heart sits centred)
          case 12: {
            threshold = htFillTail(htHeartGauge(vec2<f32>(cx, -cy) * 1.45 + vec2<f32>(0.0, 0.0732)), cx, cy);
          }
          // Triangle: full cell width at about 0.85 (centroid 0.12 below the cell centre)
          case 13: {
            threshold = htFillTail(htTriangleGauge(vec2<f32>(cx, 0.12 - cy)) / 0.34, cx, cy);
          }
          // Diamond (2, and the fallback)
          default: {
            threshold = (abs(cx) + abs(cy));
          }
        }

        return clamp(threshold, 0.0, 1.0);
      }

      // The screen-cell INDEX a pixel falls in (same rotate math as halftoneThreshold) - the unit
      // the edge-density dropout removes, so dots vanish as whole dots. Hexagon uses its honeycomb
      // cell (id = centre * (2, 2 / sqrt3)); every other shape, the global rings / spiral included,
      // drops square cells of the rotated grid (as the line screen does: whole line segments).
      fn halftoneCell(px: f32, py: f32, angle: f32, freq: f32, texW: f32, texH: f32, shape: i32) -> vec2<i32> {
        let r = halftoneRot(px, py, angle, freq, texW);
        if (shape == 10) {
          let c = r - htHexOffset(r);
          return vec2<i32>(i32(round(c.x * 2.0)), i32(round(c.y * (2.0 / HT_SQRT3))));
        }
        return vec2<i32>(i32(floor(r.x)), i32(floor(r.y)));
      }

      // Inverse of halftoneCell: the cell CENTRE back in pre-patternScale pixel coords - the one
      // point the density dropout evaluates the edge factor at (all-or-nothing per dot).
      fn halftoneCellCenterPx(cell: vec2<i32>, angle: f32, freq: f32, texW: f32, texH: f32, shape: i32) -> vec2<f32> {
        var c = vec2<f32>(f32(cell.x) + 0.5, f32(cell.y) + 0.5);
        if (shape == 10) { c = vec2<f32>(f32(cell.x) * 0.5, f32(cell.y) * (HT_SQRT3 * 0.5)); }
        let cs = cos(angle);
        let sn = sin(angle);
        let nx = c.x * cs + c.y * sn;      // inverse rotation = transpose
        let ny = -c.x * sn + c.y * cs;
        let scale = freq / texW;
        return vec2<f32>(nx / scale, ny / scale);   // same scale on both axes (square cells)
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

        let ctr = vec2<f32>(texW, texH) * (0.5 / patternScale);   // texture centre, pre-patternScale (rings / spiral)
        let threshold = halftoneThreshold(px, py, angle, freq, shape, texW, texH, ctr);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // Edge effects: es.x = fade strength multiplier, es.y = coverage shrink, es.z = edge factor.
        let es = edgeState(coords);
        let effStrength = strength * es.x;
        // Density: drop whole screen CELLS near the edge — ALL-OR-NOTHING per dot (edge factor
        // evaluated once at the cell centre), and a dropped cell renders the PAPER state so the
        // pattern gets SPARSER (rev 2, 2026-09-15 — strength-0 dropout wrongly revealed the
        // original artwork; that's edgeFade's job). params[3].y = the dropout seed.
        var cellDropped = false;
        let edgeDensity = params[7].w;
        if (edgeDensity > 0.001) {
          let cell = halftoneCell(px, py, angle, freq, texW, texH, shape);
          let centerPx = halftoneCellCenterPx(cell, angle, freq, texW, texH, shape) * patternScale;
          let eCell = edgeAt(vec2<i32>(centerPx), params[7].x);
          if (edgeCellRand(cell, u32(params[3].y)) > 1.0 - edgeDensity * (1.0 - eCell)) { cellDropped = true; }
        }

        // A density-dropped cell is ERASED — fully transparent, independent of the FG/BG colors
        // (rev 3, 2026-09-15 — the rev-2 force-to-BG turned solid after a Swap).
        if (cellDropped) {
          textureStore(output, coords, vec4<f32>(0.0));
          return;
        }

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          // Shrink: ramp the bias toward the direction-aware landing extreme — positive shrink
          // always makes the DOTS smaller until they vanish (rev 4: with bias > 0.5 the dots are
          // the BG phase, so the ramp goes toward all-FG; the old toward-0 rule GREW them).
          let ditheredLum = quantize(mix(duotoneBias, shrinkTargetBias(duotoneBias), es.y) + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, es.y) + bias, colorLevels),
            quantize(mix(src.g, tq, es.y) + bias, colorLevels),
            quantize(mix(src.b, tq, es.y) + bias, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), es.y);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, effStrength);
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

  private applyNoise(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder): void {
    this.ensureNoisePipeline();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = this.frameCounter; // seed
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
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

    this.dispatch(this.noisePipeline!, bg, w, h, enc);
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

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
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

        // Edge effects. Stochastic pattern: "density" IS coverage here, so it folds into shrink.
        let es = edgeState(coords);
        let effStrength = strength * es.x;
        // Stochastic pattern: density IS coverage, so its nearness folds into shrink's
        // (multiplicative survival — matches the old two-factor multiply for positive shrink).
        let nTot = 1.0 - (1.0 - es.y) * (1.0 - (1.0 - es.z) * params[7].w);

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(mix(duotoneBias, shrinkTargetBias(duotoneBias), nTot) + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, nTot) + bias, colorLevels),
            quantize(mix(src.g, tq, nTot) + (rand01(gid.x + 1000u, gid.y, seed) - 0.5) * spread, colorLevels),
            quantize(mix(src.b, tq, nTot) + (rand01(gid.x, gid.y + 1000u, seed) - 0.5) * spread, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), nTot);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, effStrength);
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

  private applyBlueNoise(outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder): void {
    this.ensureBlueNoisePipeline();
    this.ensureBlueNoiseTexture();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = cfg.patternScale;
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
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

    this.dispatch(this.blueNoisePipeline!, bg, w, h, enc);
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

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
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

        // Edge effects. Stochastic pattern: "density" IS coverage here, so it folds into shrink.
        let es = edgeState(coords);
        let effStrength = strength * es.x;
        // Stochastic pattern: density IS coverage — folds into shrink's nearness.
        let nTot = 1.0 - (1.0 - es.y) * (1.0 - (1.0 - es.z) * params[7].w);

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        if (isDuotone) {
          let ditheredLum = quantize(mix(duotoneBias, shrinkTargetBias(duotoneBias), nTot) + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, nTot) + bias, colorLevels),
            quantize(mix(src.g, tq, nTot) + bias, colorLevels),
            quantize(mix(src.b, tq, nTot) + bias, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), nTot);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, effStrength);
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

  // PERF (audit 5.7): records into the encoder owned by apply() (or the
  // caller's shared encoder) instead of creating + submitting its own —
  // the copy and dispatch now ride a single submit.
  private dispatch(pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, w: number, h: number, enc: GPUCommandEncoder): void {
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
  }
}
