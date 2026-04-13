/**
 * RasterTextStamp — GPU compute shader that stamps a text bitmap onto a raster layer texture.
 *
 * Workflow:
 *  1. Render text to an OffscreenCanvas (2D context) at high resolution.
 *  2. Upload the canvas pixels to a GPU texture.
 *  3. A compute shader alpha-composites the text texture onto the target raster layer
 *     at a specified position (texel-space).
 *
 * This is the raster equivalent of "flatten text" in Photoshop — once stamped,
 * the text becomes pixels on the layer and is no longer editable.
 */

export interface TextStampParams {
  /** Text string to render. */
  text: string;
  /** Font family (e.g. 'Arial', 'Georgia'). */
  font: string;
  /** Font size in pixels (canvas pixels, not texels). */
  fontSize: number;
  /** Text color as [r, g, b, a] in 0–1. */
  color: [number, number, number, number];
  /** Bold. */
  bold?: boolean;
  /** Italic. */
  italic?: boolean;
  /** Text alignment. */
  align?: 'left' | 'center' | 'right';
  /** Maximum width in texels for word-wrapping (0 or undefined = no wrap). */
  maxWidth?: number;
  /** Line height multiplier (default 1.2). */
  lineHeight?: number;
  /** Top-left X position in texel space on the target texture. */
  destX: number;
  /** Top-left Y position in texel space on the target texture. */
  destY: number;
}

export class RasterTextStamp {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bgl: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Rasterize text to an OffscreenCanvas and return the pixel data + dimensions.
   * Can be used for preview rendering (e.g. overlay on top of the canvas).
   */
  public rasterizeText(params: TextStampParams): { canvas: OffscreenCanvas; width: number; height: number } {
    const lh = params.lineHeight ?? 1.2;
    const lineHeightPx = Math.ceil(params.fontSize * lh);

    // Wrap text into lines
    const lines = this.wrapText(params.text, params.font, params.fontSize, params.bold, params.italic, params.maxWidth);

    // Compute canvas dimensions
    const canvasWidth = Math.max(1, this.measureLinesWidth(lines, params.font, params.fontSize, params.bold, params.italic));
    const canvasHeight = Math.max(1, lines.length * lineHeightPx);

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Set font
    const fontStyle = `${params.italic ? 'italic ' : ''}${params.bold ? 'bold ' : ''}${params.fontSize}px ${params.font}`;
    ctx.font = fontStyle;
    ctx.textBaseline = 'top';

    // Set color
    const [r, g, b, a] = params.color;
    ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

    // Set alignment
    const align = params.align ?? 'left';
    ctx.textAlign = align;
    const xOffset = align === 'center' ? canvasWidth / 2 : align === 'right' ? canvasWidth : 0;

    // Draw each line
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], xOffset, i * lineHeightPx);
    }

    return { canvas, width: canvasWidth, height: canvasHeight };
  }

  /**
   * Stamp text onto a GPU raster texture at the given texel position.
   * This is a destructive operation — the text becomes pixels on the layer.
   */
  public stamp(target: GPUTexture, params: TextStampParams): void {
    const { canvas, width, height } = this.rasterizeText(params);
    if (width === 0 || height === 0) return;

    // Upload canvas to GPU texture
    const textTex = this.uploadCanvasToTexture(canvas, width, height);

    // Run compute shader to composite text onto target
    this.ensurePipeline();
    this.compositeTextOnTarget(target, textTex, params.destX, params.destY, width, height);

    textTex.destroy();
  }

  public destroy(): void {
    // Pipeline is lightweight, nothing to explicitly destroy
  }

  // ── Text wrapping ─────────────────────────────────────────────────

  private wrapText(text: string, font: string, fontSize: number, bold?: boolean, italic?: boolean, maxWidth?: number): string[] {
    if (!maxWidth || maxWidth <= 0) {
      return text.split('\n');
    }

    // Use an OffscreenCanvas just for measurement
    const measureCanvas = new OffscreenCanvas(1, 1);
    const ctx = measureCanvas.getContext('2d')!;
    ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${font}`;

    const rawLines = text.split('\n');
    const wrapped: string[] = [];

    for (const rawLine of rawLines) {
      const words = rawLine.split(/\s+/);
      let current = '';

      for (const word of words) {
        const testLine = current ? current + ' ' + word : word;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && current) {
          wrapped.push(current);
          current = word;
        } else {
          current = testLine;
        }
      }
      wrapped.push(current);
    }

    return wrapped;
  }

  private measureLinesWidth(lines: string[], font: string, fontSize: number, bold?: boolean, italic?: boolean): number {
    const measureCanvas = new OffscreenCanvas(1, 1);
    const ctx = measureCanvas.getContext('2d')!;
    ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${font}`;

    let maxW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxW) maxW = w;
    }
    return Math.ceil(maxW) + 2; // +2 for sub-pixel safety
  }

  // ── GPU upload ────────────────────────────────────────────────────

  private uploadCanvasToTexture(canvas: OffscreenCanvas, w: number, h: number): GPUTexture {
    const tex = this.device.createTexture({
      label: 'RasterTextStamp_src',
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Use copyExternalImageToTexture for efficiency
    const bitmap = canvas.transferToImageBitmap();
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex },
      { width: w, height: h },
    );
    bitmap.close();

    return tex;
  }

  // ── GPU pipeline ──────────────────────────────────────────────────

  private ensurePipeline(): void {
    if (this.pipeline) return;

    this.sampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var textTex: texture_2d<f32>;   // rasterized text
      @group(0) @binding(1) var textSamp: sampler;
      @group(0) @binding(2) var dstTex: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var targetRead: texture_2d<f32>; // read current layer
      // params: destX, destY, srcW, srcH
      @group(0) @binding(4) var<uniform> params: vec4<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let srcW = u32(params.z);
        let srcH = u32(params.w);
        if (gid.x >= srcW || gid.y >= srcH) { return; }

        let destX = u32(params.x);
        let destY = u32(params.y);
        let dstCoord = vec2<u32>(destX + gid.x, destY + gid.y);

        let dstDim = textureDimensions(dstTex);
        if (dstCoord.x >= dstDim.x || dstCoord.y >= dstDim.y) { return; }

        let srcCoord = vec2<i32>(i32(gid.x), i32(gid.y));
        let src = textureLoad(textTex, srcCoord, 0);
        let dst = textureLoad(targetRead, vec2<i32>(i32(dstCoord.x), i32(dstCoord.y)), 0);

        // Alpha-over compositing
        let srcA = src.a;
        if (srcA <= 0.001) {
          textureStore(dstTex, dstCoord, dst);
          return;
        }
        let outA = srcA + dst.a * (1.0 - srcA);
        var outRGB = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRGB = (src.rgb * srcA + dst.rgb * dst.a * (1.0 - srcA)) / outA;
        }
        textureStore(dstTex, dstCoord, vec4<f32>(outRGB, outA));
      }
    `;

    this.bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'non-filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  private compositeTextOnTarget(
    target: GPUTexture,
    textTex: GPUTexture,
    destX: number, destY: number,
    srcW: number, srcH: number
  ): void {
    // We need a copy of the target to read from (can't read+write same storage texture)
    const tw = target.width;
    const th = target.height;
    const readCopy = this.device.createTexture({
      size: [tw, th],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: target }, { texture: readCopy }, { width: tw, height: th });
    this.device.queue.submit([cpEnc.finish()]);

    // Params uniform
    const paramBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(paramBuf, 0, new Float32Array([destX, destY, srcW, srcH]));

    const bg = this.device.createBindGroup({
      layout: this.bgl!,
      entries: [
        { binding: 0, resource: textTex.createView() },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: target.createView() },
        { binding: 3, resource: readCopy.createView() },
        { binding: 4, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(srcW / 8), Math.ceil(srcH / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);

    readCopy.destroy();
    paramBuf.destroy();
  }
}
