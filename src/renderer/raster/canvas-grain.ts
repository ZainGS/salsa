/**
 * CanvasGrainManager — procedural paper/canvas grain texture generation.
 *
 * Generates tileable grayscale grain textures that modulate brush alpha,
 * creating the effect of paint catching on paper peaks and skipping valleys —
 * the "True Grit Texture Supply" look.
 *
 * Built-in grain types:
 *  • cold-press   — bumpy watercolor paper (medium frequency, organic)
 *  • hot-press    — smooth paper with subtle surface variation
 *  • canvas-linen — woven fabric cross-hatch pattern
 *  • rough        — very toothy paper with deep valleys
 *  • watercolor   — organic blobs with domain warping
 *  • newsprint    — regular halftone-like dot grid
 *
 * The grain texture is a single-channel r8unorm GPUTexture that tiles seamlessly.
 * Values: 1.0 = paper peak (paint sticks fully), 0.0 = deep valley (paint skips).
 *
 * Usage:
 *   In the brush stamp shader, the grain value at the canvas texel position
 *   modulates the dab's alpha: `tipAlpha *= mix(1.0, grainVal, strength)`
 */

export type CanvasGrainType =
  | 'none'
  | 'cold-press'
  | 'hot-press'
  | 'canvas-linen'
  | 'rough'
  | 'watercolor'
  | 'newsprint';

export interface CanvasGrainSettings {
  type: CanvasGrainType;
  /** Scale of the grain pattern. 1.0 = native, <1 = zoomed in (larger grain), >1 = zoomed out. */
  scale: number;
  /** How strongly the grain affects brush strokes. 0 = no effect, 1 = full modulation. */
  strength: number;
}

/** Resolution of generated grain textures (tiles seamlessly at any canvas size). */
const GRAIN_TEX_SIZE = 256;

export class CanvasGrainManager {
  private device: GPUDevice;
  private cache = new Map<CanvasGrainType, GPUTexture>();
  private settings: CanvasGrainSettings = { type: 'none', scale: 1.0, strength: 0.5 };

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Set the active canvas grain. Generates the texture lazily on first use. */
  public setGrain(settings: CanvasGrainSettings): void {
    this.settings = { ...settings };
    if (settings.type !== 'none') {
      this.getOrGenerate(settings.type);
    }
  }

  public getSettings(): CanvasGrainSettings {
    return { ...this.settings };
  }

  /** Get the active grain GPUTexture, or null if grain is disabled. */
  public getGrainTexture(): GPUTexture | null {
    if (this.settings.type === 'none') return null;
    return this.getOrGenerate(this.settings.type);
  }

  /**
   * Get inverse-scale factors for the shader UV computation.
   * `grainUV = texelCoord * invScale` → repeat sampler handles tiling.
   */
  public getGrainInvScale(): [number, number] {
    const s = GRAIN_TEX_SIZE * Math.max(0.01, this.settings.scale);
    return [1.0 / s, 1.0 / s];
  }

  public getGrainStrength(): number {
    return this.settings.strength;
  }

  /** Get the list of available built-in grain types (for UI). */
  public static getAvailableTypes(): CanvasGrainType[] {
    return ['none', 'cold-press', 'hot-press', 'canvas-linen', 'rough', 'watercolor', 'newsprint'];
  }

  public destroy(): void {
    for (const tex of this.cache.values()) tex.destroy();
    this.cache.clear();
  }

  // ── Texture cache ─────────────────────────────────────────────────

  private getOrGenerate(type: CanvasGrainType): GPUTexture {
    const cached = this.cache.get(type);
    if (cached) return cached;

    const size = GRAIN_TEX_SIZE;
    let data: Uint8Array;

    switch (type) {
      case 'cold-press':   data = this.genColdPress(size); break;
      case 'hot-press':    data = this.genHotPress(size); break;
      case 'canvas-linen': data = this.genCanvasLinen(size); break;
      case 'rough':        data = this.genRough(size); break;
      case 'watercolor':   data = this.genWatercolor(size); break;
      case 'newsprint':    data = this.genNewsprint(size); break;
      default:             data = new Uint8Array(size * size).fill(255);
    }

    const tex = this.uploadR8(data, size);
    this.cache.set(type, tex);
    return tex;
  }

  // ── Grain generators ──────────────────────────────────────────────

  /**
   * Cold-pressed watercolor paper — organic bumpy texture with medium-frequency noise.
   * Think Arches or Fabriano cold-press sheets.
   */
  private genColdPress(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const period = 16;
    const octaves = 4;
    const seed = 42;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * period;
        const ny = (y / size) * period;
        const v = this.fbm(nx, ny, octaves, period, seed);
        // Remap to [0.25, 1.0] — even valleys let some paint through
        const mapped = 0.25 + v * 0.75;
        data[y * size + x] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
      }
    }
    return data;
  }

  /**
   * Hot-pressed paper — very smooth with minimal surface variation.
   * Think smooth Bristol board or hot-press illustration board.
   */
  private genHotPress(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const period = 32;
    const octaves = 2;
    const seed = 137;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * period;
        const ny = (y / size) * period;
        const v = this.fbm(nx, ny, octaves, period, seed);
        // Remap to [0.75, 1.0] — very subtle texture
        const mapped = 0.75 + v * 0.25;
        data[y * size + x] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
      }
    }
    return data;
  }

  /**
   * Canvas / Linen — woven fabric cross-hatch pattern.
   * Creates a distinctive weave texture with horizontal and vertical threads.
   */
  private genCanvasLinen(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const threadFreq = 20; // threads per texture tile
    const seed = 271;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        // Horizontal and vertical threads (sine waves)
        const threadX = (Math.sin(u * threadFreq * Math.PI * 2) + 1) * 0.5;
        const threadY = (Math.sin(v * threadFreq * Math.PI * 2) + 1) * 0.5;

        // Weave: alternating over-under pattern
        const cellX = Math.floor(u * threadFreq) % 2;
        const cellY = Math.floor(v * threadFreq) % 2;
        const weave = (cellX + cellY) % 2 === 0 ? threadX : threadY;

        // Add slight noise for irregularity
        const nx = (x / size) * 32;
        const ny = (y / size) * 32;
        const noise = this.fbm(nx, ny, 2, 32, seed) * 0.15;

        // Combine: weave pattern + noise, remap to [0.2, 1.0]
        const raw = weave * 0.6 + 0.25 + noise;
        const mapped = Math.max(0.2, Math.min(1.0, raw));
        data[y * size + x] = Math.round(mapped * 255);
      }
    }
    return data;
  }

  /**
   * Rough / toothy paper — strong coarse texture with deep valleys.
   * Like rough watercolor paper or heavy-tooth drawing paper.
   */
  private genRough(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const period = 8;
    const octaves = 5;
    const seed = 314;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * period;
        const ny = (y / size) * period;
        const v = this.fbm(nx, ny, octaves, period, seed);
        // Full range [0.05, 1.0] — deep valleys, sharp peaks
        const mapped = 0.05 + v * 0.95;
        data[y * size + x] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
      }
    }
    return data;
  }

  /**
   * Watercolor paper — organic irregular texture with domain warping.
   * Larger features than cold press, softer transitions.
   */
  private genWatercolor(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const period = 12;
    const octaves = 3;
    const seed = 577;
    const warpSeed = 691;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let nx = (x / size) * period;
        let ny = (y / size) * period;

        // Domain warping: offset coordinates by noise for organic look
        const warpX = this.fbm(nx + 5.2, ny + 1.3, 2, period, warpSeed) * 2.0;
        const warpY = this.fbm(nx + 9.7, ny + 6.8, 2, period, warpSeed + 50) * 2.0;
        nx += warpX;
        ny += warpY;

        const v = this.fbm(nx, ny, octaves, period, seed);
        // Remap to [0.2, 1.0]
        const mapped = 0.2 + v * 0.8;
        data[y * size + x] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
      }
    }
    return data;
  }

  /**
   * Newsprint / halftone — regular dot grid pattern.
   * Good for manga/comic style artwork.
   */
  private genNewsprint(size: number): Uint8Array {
    const data = new Uint8Array(size * size);
    const dotFreq = 24; // dots per tile
    const dotRadius = 0.32; // fraction of cell size
    const seed = 823;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * dotFreq;
        const v = (y / size) * dotFreq;

        // Distance from nearest dot center (grid cell center)
        const cellX = u - Math.floor(u) - 0.5;
        const cellY = v - Math.floor(v) - 0.5;
        const dist = Math.sqrt(cellX * cellX + cellY * cellY);

        // Dot: inside radius = 1.0 (peak), outside = falloff
        let dotVal: number;
        if (dist <= dotRadius) {
          dotVal = 1.0;
        } else if (dist <= dotRadius + 0.1) {
          dotVal = 1.0 - (dist - dotRadius) / 0.1;
        } else {
          dotVal = 0.0;
        }

        // Add slight noise variation
        const nx = (x / size) * 32;
        const ny = (y / size) * 32;
        const noise = this.valueNoise(nx, ny, 32, seed) * 0.1;

        // Remap: dots are peaks (1.0), gaps are valleys
        const mapped = Math.max(0.05, Math.min(1.0, dotVal + noise * 0.5 + 0.15));
        data[y * size + x] = Math.round(mapped * 255);
      }
    }
    return data;
  }

  // ── Noise functions (tileable) ────────────────────────────────────

  /**
   * Integer hash → [0, 1]. Uses Robert Jenkins' 32-bit hash.
   * All bitwise ops work on 32-bit in JS, so this is safe.
   */
  private hash(n: number): number {
    n = (n + 0x7ed55d16 + (n << 12)) | 0;
    n = (n ^ 0xc761c23c ^ (n >>> 19)) | 0;
    n = (n + 0x165667b1 + (n << 5)) | 0;
    n = (n + 0xd3a2646c ^ (n << 9)) | 0;
    n = (n + 0xfd7046c5 + (n << 3)) | 0;
    n = (n ^ 0xb55a4f09 ^ (n >>> 16)) | 0;
    return (n >>> 0) / 0xffffffff;
  }

  /** 2D integer coordinate hash → [0, 1]. */
  private hash2d(x: number, y: number, seed: number): number {
    return this.hash((Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) | 0);
  }

  /**
   * Tileable 2D value noise. The noise wraps at `period` in both X and Y,
   * ensuring seamless tiling when the texture repeats.
   */
  private valueNoise(x: number, y: number, period: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;

    // Smoothstep interpolation
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    // Wrap grid points for tileability
    const x0 = ((ix % period) + period) % period;
    const y0 = ((iy % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;

    // Corner values
    const n00 = this.hash2d(x0, y0, seed);
    const n10 = this.hash2d(x1, y0, seed);
    const n01 = this.hash2d(x0, y1, seed);
    const n11 = this.hash2d(x1, y1, seed);

    // Bilinear interpolation
    return n00 * (1 - sx) * (1 - sy) + n10 * sx * (1 - sy) + n01 * (1 - sx) * sy + n11 * sx * sy;
  }

  /**
   * Fractal Brownian Motion — sum of multiple octaves of value noise
   * at increasing frequencies and decreasing amplitudes.
   */
  private fbm(x: number, y: number, octaves: number, basePeriod: number, seed: number): number {
    let value = 0;
    let amplitude = 1.0;
    let totalAmp = 0;
    let freq = 1;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.valueNoise(x * freq, y * freq, basePeriod * freq, seed + i * 97);
      totalAmp += amplitude;
      amplitude *= 0.5;
      freq *= 2;
    }

    return value / totalAmp;
  }

  // ── GPU upload ────────────────────────────────────────────────────

  /** Upload an r8unorm texture from CPU data. */
  private uploadR8(data: Uint8Array, size: number): GPUTexture {
    const tex = this.device.createTexture({
      size: [size, size],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      data as unknown as BufferSource,
      { bytesPerRow: size, rowsPerImage: size },
      { width: size, height: size },
    );
    return tex;
  }
}
