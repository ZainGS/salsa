/**
 * AnimationExporter — handles exporting animation frames to various formats.
 *
 * Supports:
 *   - Sprite sheet (all frames in a grid, single PNG)
 *   - Individual frame PNGs
 *   - Frame data as ImageData arrays (for GIF/MP4 encoding by the host app)
 */

export interface SpriteSheetOptions {
  /** Max columns in the sprite sheet grid. 0 = auto (sqrt of frame count). */
  columns?: number;
  /** Padding between frames in pixels. */
  padding?: number;
}

export interface FrameExportData {
  frame: number;
  width: number;
  height: number;
  /** RGBA pixel data (Uint8Array, tightly packed). */
  pixels: Uint8Array;
}

export class AnimationExporter {
  private device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Read back a GPU texture to CPU pixels.
   * Returns a Uint8Array of RGBA pixels (w × h × 4 bytes).
   */
  public async readTexturePixels(texture: GPUTexture): Promise<Uint8Array> {
    const w = texture.width;
    const h = texture.height;
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256; // align to 256
    const bufSize = bytesPerRow * h;

    const buf = this.device.createBuffer({
      size: bufSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: buf, bytesPerRow, rowsPerImage: h },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);

    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());

    // Strip row padding
    const pixels = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = mapped.subarray(row * bytesPerRow, row * bytesPerRow + w * 4);
      pixels.set(src, row * w * 4);
    }

    buf.unmap();
    buf.destroy();
    return pixels;
  }

  /**
   * Export a single frame's texture to a Blob (PNG or WebP).
   */
  public async frameToBlob(
    texture: GPUTexture,
    type: 'image/png' | 'image/webp' = 'image/png',
  ): Promise<Blob> {
    const w = texture.width;
    const h = texture.height;
    const pixels = await this.readTexturePixels(texture);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), w, h);
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type });
  }

  /**
   * Generate a sprite sheet from an array of frame textures.
   * Returns a single Blob containing all frames in a grid.
   */
  public async toSpriteSheet(
    textures: GPUTexture[],
    options: SpriteSheetOptions = {},
  ): Promise<{ blob: Blob; columns: number; rows: number; frameWidth: number; frameHeight: number }> {
    if (textures.length === 0) throw new Error('No frames to export');

    const fw = textures[0].width;
    const fh = textures[0].height;
    const pad = options.padding ?? 0;
    const cols = options.columns ?? Math.ceil(Math.sqrt(textures.length));
    const rows = Math.ceil(textures.length / cols);

    const sheetW = cols * fw + (cols - 1) * pad;
    const sheetH = rows * fh + (rows - 1) * pad;

    const canvas = new OffscreenCanvas(sheetW, sheetH);
    const ctx = canvas.getContext('2d')!;

    for (let i = 0; i < textures.length; i++) {
      const pixels = await this.readTexturePixels(textures[i]);
      const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), fw, fh);
      const col = i % cols;
      const row = Math.floor(i / cols);
      ctx.putImageData(imageData, col * (fw + pad), row * (fh + pad));
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, columns: cols, rows, frameWidth: fw, frameHeight: fh };
  }

  /**
   * Export all frames as individual FrameExportData objects.
   * Useful for feeding into a GIF or MP4 encoder.
   */
  public async toFrameDataArray(
    textures: GPUTexture[],
  ): Promise<FrameExportData[]> {
    const result: FrameExportData[] = [];
    for (let i = 0; i < textures.length; i++) {
      const tex = textures[i];
      const pixels = await this.readTexturePixels(tex);
      result.push({
        frame: i + 1,
        width: tex.width,
        height: tex.height,
        pixels,
      });
    }
    return result;
  }
}
