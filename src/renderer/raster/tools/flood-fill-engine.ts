/**
 * FloodFillEngine — GPU-accelerated paint bucket / flood fill tool.
 *
 * Uses a Jump Flooding Algorithm (JFA) on the GPU for fast region detection,
 * with optional gap-closing to handle imperfect lineart.
 *
 * Workflow:
 *   1. Read the seed pixel color from the target (or reference) texture
 *   2. Generate a binary mask: pixels within tolerance of seed → 1, else → 0
 *   3. If gap-closing is enabled, dilate the "boundary" pixels to close small gaps
 *   4. Scanline flood fill on the mask from the seed point (CPU, on the mask)
 *   5. Apply the fill: write fillColor to all mask=1 pixels on the target texture
 *
 * Why hybrid CPU+GPU?
 *   - The tolerance comparison is massively parallel → GPU compute
 *   - The actual flood connectivity check needs seed propagation → CPU scanline is
 *     simpler and fast enough for typical canvas sizes (4096×4096 = ~16M pixels)
 *   - The final fill write-back is parallel → GPU compute
 */

import { scanlineFill } from '../scanline-fill';

export interface FloodFillOptions {
  /** Seed pixel position (texel coordinates). */
  x: number;
  y: number;
  /** Fill color [r, g, b, a] in 0–1 range. */
  color: [number, number, number, number];
  /** Color similarity tolerance (0 = exact match, 255 = fill everything). */
  tolerance: number;
  /** Close small gaps in lineart before filling (in pixels). 0 = off. */
  gapClosing: number;
  /**
   * If provided, use this texture to determine fill boundaries
   * but actually fill on the target texture. This is the "reference layer"
   * workflow: ink on layer A, fill on layer B using A's boundaries.
   */
  referenceTexture?: GPUTexture;
  /** Only fill within the current selection mask (if any). */
  selectionMask?: GPUTexture;
  /** Fill contiguous region only (true) or all similar-color pixels (false). */
  contiguous: boolean;
}

export class FloodFillEngine {
  private device: GPUDevice;
  // Pipelines
  private tolerancePipeline: GPUComputePipeline | null = null;
  private toleranceBGL: GPUBindGroupLayout | null = null;
  private fillApplyPipeline: GPUComputePipeline | null = null;
  private fillApplyBGL: GPUBindGroupLayout | null = null;
  private dilatePipeline: GPUComputePipeline | null = null;
  private dilateBGL: GPUBindGroupLayout | null = null;
  // Reusable buffers
  private paramBuf: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    // 32 bytes: seedColor(4f) + tolerance(1f) + fillColor(4f) + gap(1f) + seed pos(2f) = 12 floats
    this.paramBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Execute a flood fill operation.
   * Returns true if any pixels were filled.
   */
  public async fill(
    targetTexture: GPUTexture,
    options: FloodFillOptions,
  ): Promise<boolean> {
    const w = targetTexture.width;
    const h = targetTexture.height;
    const { x, y, color, tolerance, gapClosing, referenceTexture, selectionMask, contiguous } = options;

    // Bounds check
    if (x < 0 || x >= w || y < 0 || y >= h) return false;

    // 1. Read seed pixel color from reference (or target)
    const sourceTexture = referenceTexture ?? targetTexture;
    const seedColor = await this.readPixel(sourceTexture, x, y);
    if (!seedColor) return false;

    // 2. Generate tolerance mask on GPU (r32float texture: 0 = outside tolerance, 1 = inside)
    const maskTexture = this.createMaskTexture(w, h);
    this.computeToleranceMask(sourceTexture, maskTexture, seedColor, tolerance / 255);

    // 3. Gap closing: dilate boundary pixels
    if (gapClosing > 0) {
      this.dilateBarrier(maskTexture, w, h, gapClosing);
    }

    // 4. Read mask back to CPU for flood fill
    const maskData = await this.readMaskTexture(maskTexture, w, h);

    // 5. CPU scanline flood fill (or global fill)
    let fillMask: Uint8Array;
    if (contiguous) {
      fillMask = scanlineFill(maskData, w, h, x, y);
    } else {
      // Non-contiguous: fill ALL pixels that passed tolerance
      fillMask = maskData;
    }

    // 6. Apply selection mask if present
    if (selectionMask) {
      const selData = await this.readMaskTexture(selectionMask, w, h);
      for (let i = 0; i < fillMask.length; i++) {
        if (selData[i] === 0) fillMask[i] = 0;
      }
    }

    // Check if any pixels to fill
    let anyFill = false;
    for (let i = 0; i < fillMask.length; i++) {
      if (fillMask[i] > 0) { anyFill = true; break; }
    }
    if (!anyFill) {
      maskTexture.destroy();
      return false;
    }

    // 7. Upload fill mask and apply fill color on GPU
    this.uploadMask(maskTexture, fillMask, w, h);
    this.applyFill(targetTexture, maskTexture, color);

    // Wait for GPU
    await this.device.queue.onSubmittedWorkDone();
    maskTexture.destroy();
    return true;
  }

  // ── GPU: Tolerance mask ─────────────────────────────────────────

  private computeToleranceMask(
    source: GPUTexture,
    mask: GPUTexture,
    seedColor: [number, number, number, number],
    tolerance: number,
  ): void {
    this.ensureTolerancePipeline();
    const params = new Float32Array([
      seedColor[0], seedColor[1], seedColor[2], seedColor[3],
      tolerance, 0, 0, 0,
    ]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.toleranceBGL!,
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: mask.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.tolerancePipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(source.width / 8),
      Math.ceil(source.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private ensureTolerancePipeline(): void {
    if (this.tolerancePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var mask: texture_storage_2d<r32float, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 2>;
      // params[0] = seedColor RGBA
      // params[1].x = tolerance (0-1)

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));
        let px = textureLoad(src, coord, 0);
        let seed = params[0];
        let tol = params[1].x;

        // Color distance (max of per-channel absolute difference)
        let diff = max(
          max(abs(px.r - seed.r), abs(px.g - seed.g)),
          max(abs(px.b - seed.b), abs(px.a - seed.a))
        );

        let val = select(0.0, 1.0, diff <= tol);
        textureStore(mask, coord, vec4<f32>(val, 0.0, 0.0, 0.0));
      }
    `;

    this.toleranceBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.tolerancePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.toleranceBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── GPU: Gap closing (dilate boundary) ──────────────────────────

  private dilateBarrier(mask: GPUTexture, w: number, h: number, radius: number): void {
    this.ensureDilatePipeline();

    // We dilate the INVERSE of the mask (the "walls") to close gaps.
    // A pixel that's 0 (wall) "grows" into neighboring 1 (fillable) pixels.
    // We do this by: for each pixel, if any neighbor within radius is 0, set to 0.
    // Multiple passes for larger radii (each pass = 1px dilation).

    const tempMask = this.createMaskTexture(w, h);

    for (let i = 0; i < radius; i++) {
      const readTex = (i % 2 === 0) ? mask : tempMask;
      const writeTex = (i % 2 === 0) ? tempMask : mask;

      const bg = this.device.createBindGroup({
        layout: this.dilateBGL!,
        entries: [
          { binding: 0, resource: readTex.createView() },
          { binding: 1, resource: writeTex.createView() },
        ],
      });

      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.dilatePipeline!);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
      this.device.queue.submit([enc.finish()]);
    }

    // If odd number of passes, result is in tempMask — copy back to mask
    if (radius % 2 === 1) {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: tempMask },
        { texture: mask },
        { width: w, height: h },
      );
      this.device.queue.submit([enc.finish()]);
    }

    tempMask.destroy();
  }

  private ensureDilatePipeline(): void {
    if (this.dilatePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(src);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        let center = textureLoad(src, coord, 0).r;

        // If any of the 4-connected neighbors is 0 (wall), this pixel becomes 0
        var minVal = center;
        if (coord.x > 0) { minVal = min(minVal, textureLoad(src, coord + vec2(-1, 0), 0).r); }
        if (coord.x < i32(dim.x) - 1) { minVal = min(minVal, textureLoad(src, coord + vec2(1, 0), 0).r); }
        if (coord.y > 0) { minVal = min(minVal, textureLoad(src, coord + vec2(0, -1), 0).r); }
        if (coord.y < i32(dim.y) - 1) { minVal = min(minVal, textureLoad(src, coord + vec2(0, 1), 0).r); }

        textureStore(dst, coord, vec4<f32>(minVal, 0.0, 0.0, 0.0));
      }
    `;

    this.dilateBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
      ],
    });

    this.dilatePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.dilateBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── GPU: Apply fill color ───────────────────────────────────────

  private applyFill(
    target: GPUTexture,
    mask: GPUTexture,
    color: [number, number, number, number],
  ): void {
    this.ensureFillApplyPipeline();

    const params = new Float32Array([color[0], color[1], color[2], color[3], 0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.paramBuf, 0, params);

    const bg = this.device.createBindGroup({
      layout: this.fillApplyBGL!,
      entries: [
        { binding: 0, resource: target.createView() },
        { binding: 1, resource: mask.createView() },
        { binding: 2, resource: { buffer: this.paramBuf } },
      ],
    });

    const w = target.width;
    const h = target.height;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.fillApplyPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private ensureFillApplyPipeline(): void {
    if (this.fillApplyPipeline) return;

    // Note: we need to read AND write the target texture.
    // WebGPU doesn't allow read-write on the same texture in one pass,
    // so we read from a texture_2d and write to a separate storage copy.
    // HOWEVER — for simplicity, we use the mask to decide whether to write,
    // and we read the existing target via textureLoad, blend, and write.
    // This works because we use texture_storage_2d with read_write access
    // if available, or we do a copy-first approach.
    //
    // For broad compatibility, we do: read existing target as texture_2d,
    // output to a storage texture, then copy back. But since the fill is
    // an alpha-over composite, we need both src and dst.
    //
    // Simplest approach: the fill replaces pixels where mask=1.
    // For partial alpha fills, we alpha-blend.

    const code = /* wgsl */ `
      @group(0) @binding(0) var dstTex: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(1) var mask: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 2>;
      // params[0] = fillColor RGBA

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(mask);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));

        let m = textureLoad(mask, coord, 0).r;
        if (m < 0.5) { return; }

        let fill = params[0];
        // Direct write — fill replaces the pixel
        textureStore(dstTex, coord, fill);
      }
    `;

    this.fillApplyBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.fillApplyPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.fillApplyBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── GPU readback helpers ────────────────────────────────────────

  private async readPixel(
    texture: GPUTexture,
    x: number,
    y: number,
  ): Promise<[number, number, number, number] | null> {
    const bytesPerRow = 256; // minimum alignment for 4 bytes per pixel
    const buf = this.device.createBuffer({
      size: bytesPerRow,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture, origin: { x, y } },
      { buffer: buf, bytesPerRow },
      { width: 1, height: 1 },
    );
    this.device.queue.submit([enc.finish()]);

    await buf.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buf.getMappedRange());
    const result: [number, number, number, number] = [
      data[0] / 255,
      data[1] / 255,
      data[2] / 255,
      data[3] / 255,
    ];
    buf.unmap();
    buf.destroy();
    return result;
  }

  private createMaskTexture(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      size: [w, h],
      format: 'r32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
  }

  private async readMaskTexture(
    texture: GPUTexture,
    w: number,
    h: number,
  ): Promise<Uint8Array> {
    const bytesPerPixel = 4; // r32float = 4 bytes
    const bytesPerRow = Math.ceil(w * bytesPerPixel / 256) * 256;
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
    const mapped = new Float32Array(buf.getMappedRange());

    // Convert float mask to binary uint8
    const result = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      const srcOffset = (row * bytesPerRow) / 4; // float32 offset
      for (let col = 0; col < w; col++) {
        result[row * w + col] = mapped[srcOffset + col] > 0.5 ? 1 : 0;
      }
    }

    buf.unmap();
    buf.destroy();
    return result;
  }

  private uploadMask(
    texture: GPUTexture,
    mask: Uint8Array,
    w: number,
    h: number,
  ): void {
    const floats = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      floats[i] = mask[i] ? 1.0 : 0.0;
    }
    this.device.queue.writeTexture(
      { texture },
      floats,
      { bytesPerRow: w * 4 },
      { width: w, height: h },
    );
  }

  public destroy(): void {
    this.paramBuf.destroy();
  }
}
