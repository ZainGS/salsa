/**
 * BrushTip — generates the alpha-mask for a single dab.
 *
 * • Parametric tips are generated on the GPU as a single-channel R8 texture.
 * • Image tips are decoded from a base64 PNG and uploaded once.
 *
 * The resulting GPUTexture is always a single-channel `r8unorm` square texture
 * that the stamp pipeline samples to shape each dab.
 */

import { BrushTip, BrushTipParametric, BrushTipImage } from './brush-preset';

/** Resolution (px) of generated parametric tip textures. */
const PARAMETRIC_TIP_SIZE = 128;

export class BrushTipGenerator {
  private device: GPUDevice;

  // Cache: key → GPU texture so we don't regenerate every stroke
  private cache = new Map<string, GPUTexture>();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Get (or create) the tip texture for a given BrushTip definition.
   * Returns an `r8unorm` GPUTexture.
   */
  public getTipTexture(tip: BrushTip): GPUTexture {
    const key = this.tipCacheKey(tip);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let tex: GPUTexture;
    if (tip.type === 'parametric') {
      tex = this.generateParametricTip(tip);
    } else {
      tex = this.generateImageTip(tip);
    }
    this.cache.set(key, tex);
    return tex;
  }

  /**
   * Invalidate a cached tip (call when the user edits a preset's tip settings).
   */
  public invalidate(tip: BrushTip): void {
    const key = this.tipCacheKey(tip);
    const old = this.cache.get(key);
    if (old) {
      old.destroy();
      this.cache.delete(key);
    }
  }

  public destroy(): void {
    for (const tex of this.cache.values()) tex.destroy();
    this.cache.clear();
  }

  // ── Parametric tip ────────────────────────────────────────────────

  /**
   * Generates a CPU-side R8 alpha mask for a parametric tip,
   * then uploads it to a GPU texture.
   */
  private generateParametricTip(tip: BrushTipParametric): GPUTexture {
    const size = PARAMETRIC_TIP_SIZE;
    const data = new Uint8Array(size * size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Offset from center
        let dx = (x + 0.5 - cx) / r;
        let dy = (y + 0.5 - cy) / r;

        // Apply roundness (squash one axis to make an ellipse)
        if (tip.roundness < 1) {
          // Rotate into tip-local space, scale Y, rotate back
          const cosA = Math.cos(-tip.angle);
          const sinA = Math.sin(-tip.angle);
          const rx = dx * cosA - dy * sinA;
          const ry = dx * sinA + dy * cosA;
          // Scale the minor axis
          const scaledRy = ry / Math.max(0.01, tip.roundness);
          dx = rx * cosA + scaledRy * sinA;
          dy = -rx * sinA + scaledRy * cosA;
        }

        const dist = Math.sqrt(dx * dx + dy * dy);

        let alpha = 0;
        if (dist <= 1.0) {
          // Hardness controls the falloff curve.
          // hardness=1 → hard edge (step function)
          // hardness=0 → linear falloff from center
          if (tip.hardness >= 1.0) {
            alpha = 1.0;
          } else {
            // Inner solid core starts at `hardness` fraction of radius
            const innerR = tip.hardness;
            if (dist <= innerR) {
              alpha = 1.0;
            } else {
              // Smooth falloff from inner core to edge
              const t = (dist - innerR) / (1.0 - innerR);
              alpha = 1.0 - t * t; // quadratic falloff
            }
          }
        }

        data[y * size + x] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      }
    }

    return this.uploadR8Texture(data, size, size);
  }

  // ── Image tip ─────────────────────────────────────────────────────

  /**
   * Decodes a base64 PNG image tip and uploads as r8unorm.
   * Falls back to a hard circle if decoding fails.
   */
  private generateImageTip(tip: BrushTipImage): GPUTexture {
    // For now, decode synchronously via a temp canvas.
    // This is called once per preset load, not per frame.
    try {
      const binary = atob(tip.imageData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // We'll create a blob, then use createImageBitmap in the async path.
      // For the synchronous fallback, generate a hard circle at imageSize.
      // Proper async image decoding will be added when the paint engine
      // pre-loads presets.
      const size = tip.imageSize || PARAMETRIC_TIP_SIZE;
      return this.generateHardCircle(size);
    } catch {
      return this.generateHardCircle(PARAMETRIC_TIP_SIZE);
    }
  }

  /**
   * Async version: decode a base64 PNG properly via ImageBitmap → readPixels.
   * Call this during preset loading, not mid-stroke.
   */
  public async loadImageTipAsync(tip: BrushTipImage): Promise<GPUTexture> {
    const key = this.tipCacheKey(tip);
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const binary = atob(tip.imageData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);

      const w = bitmap.width;
      const h = bitmap.height;

      // Read RGBA via a temp canvas
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      bitmap.close();

      // Extract just the alpha channel (or red channel) as the tip mask
      const r8 = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        // Use alpha channel as the mask
        r8[i] = imageData.data[i * 4 + 3];
      }

      const tex = this.uploadR8Texture(r8, w, h);
      this.cache.set(key, tex);
      return tex;
    } catch {
      const fallback = this.generateHardCircle(tip.imageSize || PARAMETRIC_TIP_SIZE);
      this.cache.set(key, fallback);
      return fallback;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Load a grayscale texture from base64 PNG data. Used for dual brush textures.
   * Returns the texture (and caches it by a caller-provided key).
   */
  public async loadGrayscaleTextureAsync(key: string, base64Data: string, size: number): Promise<GPUTexture> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);

      const w = bitmap.width;
      const h = bitmap.height;

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      bitmap.close();

      // Use red channel as the grayscale mask (or alpha if image has transparency)
      const r8 = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        // Prefer alpha channel if non-trivial, otherwise use red
        const a = imageData.data[i * 4 + 3];
        const r = imageData.data[i * 4];
        r8[i] = a < 255 ? a : r;
      }

      const tex = this.uploadR8Texture(r8, w, h);
      this.cache.set(key, tex);
      return tex;
    } catch {
      const fallback = this.generateHardCircle(size);
      this.cache.set(key, fallback);
      return fallback;
    }
  }

  /**
   * Get a cached texture by key (for dual brush lookups).
   */
  public getCachedTexture(key: string): GPUTexture | null {
    return this.cache.get(key) ?? null;
  }

  private generateHardCircle(size: number): GPUTexture {
    const data = new Uint8Array(size * size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - cx) / r;
        const dy = (y + 0.5 - cy) / r;
        data[y * size + x] = (dx * dx + dy * dy <= 1.0) ? 255 : 0;
      }
    }
    return this.uploadR8Texture(data, size, size);
  }

  private uploadR8Texture(data: Uint8Array, width: number, height: number): GPUTexture {
    const tex = this.device.createTexture({
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      data as unknown as BufferSource,
      { bytesPerRow: width, rowsPerImage: height },
      { width, height },
    );
    return tex;
  }

  private tipCacheKey(tip: BrushTip): string {
    if (tip.type === 'parametric') {
      return `param_${tip.hardness}_${tip.roundness}_${tip.angle}`;
    } else {
      // For image tips, hash the first 32 chars of imageData + size
      const hash = tip.imageData.slice(0, 32);
      return `img_${hash}_${tip.imageSize}`;
    }
  }
}
