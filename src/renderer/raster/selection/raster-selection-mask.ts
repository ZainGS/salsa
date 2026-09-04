/**
 * RasterSelectionMask — a GPU-backed selection mask for raster content.
 *
 * The mask is an r32float texture the same size as the raster canvas.
 * - 255 = fully selected
 * - 0   = not selected
 * - 1-254 = partially selected (feathered edges)
 *
 * Provides GPU compute shaders to generate the mask from:
 *  • Rectangle
 *  • Ellipse
 *  • Lasso (polygon)
 *  • Select-all
 *
 * Also provides CPU readback for operations that need pixel-level mask data.
 */

import { scanlineFill } from '../scanline-fill';

export interface SelectionRect {
  x: number; y: number; w: number; h: number;
}

export interface SelectionPoint {
  x: number; y: number;
}

export type SelectionMode = 'new' | 'add' | 'subtract';

export class RasterSelectionMask {
  private device: GPUDevice;
  private maskTex: GPUTexture | null = null;
  private width = 0;
  private height = 0;

  // GPU pipelines (lazy-built)
  private rectPipeline: GPUComputePipeline | null = null;
  private ellipsePipeline: GPUComputePipeline | null = null;
  private lassoPipeline: GPUComputePipeline | null = null;
  private clearPipeline: GPUComputePipeline | null = null;
  private invertPipeline: GPUComputePipeline | null = null;
  private mergePipeline: GPUComputePipeline | null = null;
  private mergeBGL: GPUBindGroupLayout | null = null;
  private magicWandPipeline: GPUComputePipeline | null = null;
  private magicWandBGL: GPUBindGroupLayout | null = null;

  // Shared bind group layout
  private maskBGL: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // ── Texture management ────────────────────────────────────────────

  /** Ensure the mask texture matches the given dimensions. */
  public ensureMask(w: number, h: number): GPUTexture {
    if (this.maskTex && this.width === w && this.height === h) return this.maskTex;
    this.maskTex?.destroy();
    this.width = w;
    this.height = h;
    this.maskTex = this.device.createTexture({
      size: [w, h],
      format: 'r32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    return this.maskTex;
  }

  /** Get the current mask texture (may be null if no selection). */
  public getMaskTexture(): GPUTexture | null {
    return this.maskTex;
  }

  public getSize(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }

  /** Returns true if a selection mask exists with any selected pixels. */
  public hasSelection(): boolean {
    return this.maskTex !== null;
  }

  // ── Selection generators ──────────────────────────────────────────

  /** Fill the mask with a rectangle selection. Feather = px of soft edge. */
  public selectRect(rect: SelectionRect, feather: number = 0, mode: SelectionMode = 'new'): void {
    if (!this.maskTex) return;
    this.ensureRectPipeline();

    // For 'new' mode, write directly to the mask (original behavior).
    // For 'add'/'subtract', write to a temp texture, then merge.
    const target = (mode === 'new') ? this.maskTex : this.createTempMask();

    const paramBuf = this.device.createBuffer({
      size: 32, // x, y, w, h, feather, pad, pad, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set([
      rect.x, rect.y, rect.w, rect.h, feather, 0, 0, 0,
    ]);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.maskBGL!,
      entries: [
        { binding: 0, resource: target.createView() },
        { binding: 1, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.rectPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();

    if (mode !== 'new') {
      this.mergeIntoMask(target, mode);
      target.destroy();
    }
  }

  /** Fill the mask with an ellipse selection inside the given bounding rect. */
  public selectEllipse(rect: SelectionRect, feather: number = 0, mode: SelectionMode = 'new'): void {
    if (!this.maskTex) return;
    this.ensureEllipsePipeline();

    const target = (mode === 'new') ? this.maskTex : this.createTempMask();

    const paramBuf = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set([
      rect.x, rect.y, rect.w, rect.h, feather, 0, 0, 0,
    ]);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.maskBGL!,
      entries: [
        { binding: 0, resource: target.createView() },
        { binding: 1, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.ellipsePipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();

    if (mode !== 'new') {
      this.mergeIntoMask(target, mode);
      target.destroy();
    }
  }

  /** Fill the mask from a closed polygon (lasso). Points are in texel coords. */
  public selectLasso(points: SelectionPoint[], mode: SelectionMode = 'new'): void {
    if (!this.maskTex || points.length < 3) return;
    this.ensureLassoPipeline();

    const target = (mode === 'new') ? this.maskTex : this.createTempMask();

    // Upload polygon points to a storage buffer
    const floats = new Float32Array(points.length * 2 + 4); // +4 for count + padding
    floats[0] = points.length;
    floats[1] = 0; floats[2] = 0; floats[3] = 0;
    for (let i = 0; i < points.length; i++) {
      floats[4 + i * 2] = points[i].x;
      floats[4 + i * 2 + 1] = points[i].y;
    }

    const pointsBuf = this.device.createBuffer({
      size: floats.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(pointsBuf.getMappedRange()).set(floats);
    pointsBuf.unmap();

    const lassoBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    const bg = this.device.createBindGroup({
      layout: lassoBGL,
      entries: [
        { binding: 0, resource: target.createView() },
        { binding: 1, resource: { buffer: pointsBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.lassoPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    pointsBuf.destroy();

    if (mode !== 'new') {
      this.mergeIntoMask(target, mode);
      target.destroy();
    }
  }

  /**
   * Magic wand: select all contiguous pixels of similar color to the seed.
   * Uses the flood-fill tolerance mask approach from FloodFillEngine
   * but writes the result to the selection mask instead of painting.
   *
   * @param sourceTexture The raster layer texture to sample colors from
   * @param seedX Seed pixel X (texel coordinates)
   * @param seedY Seed pixel Y (texel coordinates)
   * @param tolerance Color similarity (0–255). 0 = exact match, higher = more lenient.
   * @param contiguous If true, only selects the connected region. If false, selects all similar-color pixels.
   * @param mode Selection mode (new/add/subtract)
   */
  public async selectMagicWand(
    sourceTexture: GPUTexture,
    seedX: number, seedY: number,
    tolerance: number = 32,
    contiguous: boolean = true,
    mode: SelectionMode = 'new',
  ): Promise<void> {
    if (!this.maskTex) return;
    this.ensureMagicWandPipeline();

    const target = (mode === 'new') ? this.maskTex : this.createTempMask();

    // 1. Read seed pixel color
    const seedColor = await this.readPixelColor(sourceTexture, seedX, seedY);
    if (!seedColor) return;

    // 2. GPU: generate tolerance mask into target
    const paramBuf = this.device.createBuffer({
      size: 32, // seedColor(4f) + tolerance(1f) + pad(3f)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set([
      seedColor[0], seedColor[1], seedColor[2], seedColor[3],
      tolerance / 255, 0, 0, 0,
    ]);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.magicWandBGL!,
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: target.createView() },
        { binding: 2, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.magicWandPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();

    // 3. If contiguous, do a CPU scanline flood fill to restrict to connected region
    if (contiguous) {
      const maskData = await this.readMaskToArray(target);
      const floodMask = scanlineFill(maskData, this.width, this.height, seedX, seedY);
      this.writeMaskFromArray(target, floodMask);
    }

    if (mode !== 'new') {
      this.mergeIntoMask(target, mode);
      target.destroy();
    }
  }

  /**
   * Select by color: like magic wand but always non-contiguous (selects ALL
   * pixels of the same color across the entire layer, regardless of connectivity).
   */
  public async selectByColor(
    sourceTexture: GPUTexture,
    seedX: number, seedY: number,
    tolerance: number = 32,
    mode: SelectionMode = 'new',
  ): Promise<void> {
    await this.selectMagicWand(sourceTexture, seedX, seedY, tolerance, false, mode);
  }

  // ── Magic wand helpers ────────────────────────────────────────────

  private async readPixelColor(
    texture: GPUTexture,
    x: number, y: number,
  ): Promise<[number, number, number, number] | null> {
    const bytesPerRow = 256; // minimum alignment
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
      data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255,
    ];
    buf.unmap();
    buf.destroy();
    return result;
  }

  private async readMaskToArray(tex: GPUTexture): Promise<Uint8Array> {
    const bytesPerPixel = 4;
    const bytesPerRow = Math.ceil(this.width * bytesPerPixel / 256) * 256;
    const buf = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex },
      { buffer: buf, bytesPerRow, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(buf.getMappedRange());
    const result = new Uint8Array(this.width * this.height);
    const floatsPerRow = bytesPerRow / 4;
    for (let row = 0; row < this.height; row++) {
      for (let col = 0; col < this.width; col++) {
        result[row * this.width + col] = mapped[row * floatsPerRow + col] > 0.5 ? 1 : 0;
      }
    }
    buf.unmap();
    buf.destroy();
    return result;
  }

  private writeMaskFromArray(tex: GPUTexture, mask: Uint8Array): void {
    const floats = new Float32Array(this.width * this.height);
    for (let i = 0; i < mask.length; i++) {
      floats[i] = mask[i] ? 1.0 : 0.0;
    }
    this.device.queue.writeTexture(
      { texture: tex },
      floats,
      { bytesPerRow: this.width * 4 },
      { width: this.width, height: this.height },
    );
  }


  /** Select the entire canvas. */
  public selectAll(): void {
    if (!this.maskTex) return;
    // Fill with 1.0f (fully selected) — r32float = 4 bytes per texel
    const bytesPerPixel = 4;
    const rowBytes = this.width * bytesPerPixel;
    const rowBytesPadded = Math.ceil(rowBytes / 256) * 256;
    const buf = this.device.createBuffer({
      size: rowBytesPadded * this.height,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const data = new Float32Array(buf.getMappedRange());
    const floatsPerRow = rowBytesPadded / 4;
    for (let y = 0; y < this.height; y++) {
      const offset = y * floatsPerRow;
      for (let x = 0; x < this.width; x++) {
        data[offset + x] = 1.0;
      }
    }
    buf.unmap();

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: rowBytesPadded },
      { texture: this.maskTex },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([enc.finish()]);
    buf.destroy();
  }

  /** Clear the entire mask (deselect all). */
  public deselectAll(): void {
    if (!this.maskTex) return;
    const bytesPerPixel = 4;
    const rowBytes = this.width * bytesPerPixel;
    const rowBytesPadded = Math.ceil(rowBytes / 256) * 256;
    const buf = this.device.createBuffer({
      size: rowBytesPadded * this.height,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Float32Array(buf.getMappedRange()).fill(0.0);
    buf.unmap();

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: rowBytesPadded },
      { texture: this.maskTex },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([enc.finish()]);
    buf.destroy();
  }

  /** Invert the selection mask. */
  public invertSelection(): void {
    if (!this.maskTex) return;
    this.ensureInvertPipeline();

    const bg = this.device.createBindGroup({
      layout: this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        ],
      }),
      entries: [
        { binding: 0, resource: this.maskTex.createView() },
        { binding: 1, resource: this.maskTex.createView() },
      ],
    });

    // Note: reading and writing the same texture in one pass requires a copy.
    // For simplicity, we'll do a CPU-side invert via readback. 
    // TODO: optimize with ping-pong if perf matters.
    // For now, use a temp texture approach:
    const tempTex = this.device.createTexture({
      size: [this.width, this.height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture(
      { texture: this.maskTex },
      { texture: tempTex },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([cpEnc.finish()]);

    const invertBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    const bg2 = this.device.createBindGroup({
      layout: invertBGL,
      entries: [
        { binding: 0, resource: this.maskTex.createView() },
        { binding: 1, resource: tempTex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.invertPipeline!);
    pass.setBindGroup(0, bg2);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    tempTex.destroy();
  }

  /** Get the bounding rect of selected pixels (for transform handles). */
  public async getBounds(): Promise<SelectionRect | null> {
    if (!this.maskTex) return null;
    // Read back mask to CPU — r32float = 4 bytes per texel
    const bytesPerPixel = 4;
    const rowBytes = this.width * bytesPerPixel;
    const rowBytesPadded = Math.ceil(rowBytes / 256) * 256;
    const readBuf = this.device.createBuffer({
      size: rowBytesPadded * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.maskTex },
      { buffer: readBuf, bytesPerRow: rowBytesPadded },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readBuf.getMappedRange());
    const floatsPerRow = rowBytesPadded / 4;

    let minX = this.width, minY = this.height, maxX = 0, maxY = 0;
    let found = false;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (data[y * floatsPerRow + x] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    readBuf.unmap();
    readBuf.destroy();

    if (!found) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  public destroy(): void {
    this.maskTex?.destroy();
    this.maskTex = null;
  }

  // ── Merge helpers (for add / subtract modes) ──────────────────────

  /** Create a temporary mask texture with the same dimensions (for staging). */
  private createTempMask(): GPUTexture {
    return this.device.createTexture({
      size: [this.width, this.height],
      format: 'r32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  /**
   * Merge a freshly-rendered temp mask into the main mask.
   *  - 'add':      result = max(existing, temp)   — union
   *  - 'subtract': result = existing * (1 - temp)  — difference
   *
   * Uses a temp-copy-of-mask → merge-compute → write-to-mask approach
   * to avoid read_write storage (broader compat).
   */
  private mergeIntoMask(tempTex: GPUTexture, mode: 'add' | 'subtract'): void {
    if (!this.maskTex) return;
    this.ensureMergePipeline();

    // 1) Copy current mask → snapshot (for reading)
    const snapshot = this.device.createTexture({
      size: [this.width, this.height],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture(
      { texture: this.maskTex },
      { texture: snapshot },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([cpEnc.finish()]);

    // 2) mode uniform: 0 = add (max), 1 = subtract (multiply by inverse)
    const modeBuf = this.device.createBuffer({
      size: 16, // vec4<f32> aligned
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(modeBuf.getMappedRange()).set([mode === 'add' ? 0 : 1, 0, 0, 0]);
    modeBuf.unmap();

    // 3) Dispatch merge: reads snapshot + temp, writes mask
    const bg = this.device.createBindGroup({
      layout: this.mergeBGL!,
      entries: [
        { binding: 0, resource: this.maskTex.createView() },   // write
        { binding: 1, resource: snapshot.createView() },        // read (old mask)
        { binding: 2, resource: tempTex.createView() },         // read (new shape)
        { binding: 3, resource: { buffer: modeBuf } },          // mode uniform
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.mergePipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);

    snapshot.destroy();
    modeBuf.destroy();
  }

  // ── Pipeline builders (lazy) ──────────────────────────────────────

  private ensureMergePipeline(): void {
    if (this.mergePipeline) return;
    this.mergeBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const code = /* wgsl */ `
      @group(0) @binding(0) var dst: texture_storage_2d<r32float, write>;
      @group(0) @binding(1) var oldMask: texture_2d<f32>;
      @group(0) @binding(2) var newShape: texture_2d<f32>;
      @group(0) @binding(3) var<uniform> params: vec4<f32>; // x = mode (0=add, 1=subtract)

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(dst);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coord = vec2<i32>(i32(gid.x), i32(gid.y));
        let existing = textureLoad(oldMask, coord, 0).r;
        let incoming = textureLoad(newShape, coord, 0).r;

        var result = 0.0;
        if (params.x < 0.5) {
          // Add (union): take the max
          result = max(existing, incoming);
        } else {
          // Subtract: clamp(existing - incoming, 0, 1)
          result = clamp(existing - incoming, 0.0, 1.0);
        }
        textureStore(dst, coord, vec4<f32>(result, 0.0, 0.0, 0.0));
      }
    `;
    this.mergePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.mergeBGL!] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private ensureMaskBGL(): void {
    if (this.maskBGL) return;
    this.maskBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
  }

  private ensureRectPipeline(): void {
    if (this.rectPipeline) return;
    this.ensureMaskBGL();
    const code = /* wgsl */ `
      @group(0) @binding(0) var mask: texture_storage_2d<r32float, write>;
      @group(0) @binding(1) var<uniform> params: array<f32, 8>; // x, y, w, h, feather, pad, pad, pad

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(mask);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);

        let rx = params[0]; let ry = params[1]; let rw = params[2]; let rh = params[3];
        let feather = params[4];
        let px = f32(ix); let py = f32(iy);

        // Distance from inside the rect (negative = inside)
        let dx = max(rx - px, px - (rx + rw));
        let dy = max(ry - py, py - (ry + rh));
        let d = max(dx, dy);

        var v = 0.0;
        if (d <= 0.0) {
          v = 1.0;
        } else if (feather > 0.0 && d < feather) {
          v = 1.0 - d / feather;
        }
        textureStore(mask, vec2<i32>(ix, iy), vec4<f32>(v, 0.0, 0.0, 0.0));
      }
    `;
    this.rectPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.maskBGL!] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private ensureEllipsePipeline(): void {
    if (this.ellipsePipeline) return;
    this.ensureMaskBGL();
    const code = /* wgsl */ `
      @group(0) @binding(0) var mask: texture_storage_2d<r32float, write>;
      @group(0) @binding(1) var<uniform> params: array<f32, 8>; // x, y, w, h, feather, pad, pad, pad

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(mask);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);

        let rx = params[0]; let ry = params[1]; let rw = params[2]; let rh = params[3];
        let feather = params[4];
        let cx = rx + rw * 0.5;
        let cy = ry + rh * 0.5;
        let radiusX = rw * 0.5;
        let radiusY = rh * 0.5;

        let nx = (f32(ix) - cx) / max(radiusX, 0.001);
        let ny = (f32(iy) - cy) / max(radiusY, 0.001);
        let d = sqrt(nx * nx + ny * ny); // 1.0 = on edge

        var v = 0.0;
        if (d <= 1.0) {
          v = 1.0;
        }
        if (feather > 0.0) {
          let featherNorm = feather / max(min(radiusX, radiusY), 0.001);
          if (d > 1.0 - featherNorm && d <= 1.0 + featherNorm) {
            v = 1.0 - smoothstep(1.0 - featherNorm, 1.0 + featherNorm, d);
          }
        }
        textureStore(mask, vec2<i32>(ix, iy), vec4<f32>(v, 0.0, 0.0, 0.0));
      }
    `;
    this.ellipsePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.maskBGL!] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private ensureLassoPipeline(): void {
    if (this.lassoPipeline) return;
    // Lasso uses a different BGL (storage buffer for polygon points)
    const lassoBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Winding-number point-in-polygon test
    const code = /* wgsl */ `
      @group(0) @binding(0) var mask: texture_storage_2d<r32float, write>;
      @group(0) @binding(1) var<storage, read> polyData: array<f32>;
      // polyData[0] = numPoints, polyData[4..] = x0,y0, x1,y1, ...

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(mask);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);

        let n = i32(polyData[0]);
        let px = f32(ix) + 0.5;
        let py = f32(iy) + 0.5;

        // Winding number (crossing number test)
        var crossings = 0;
        for (var i = 0; i < n; i = i + 1) {
          let j = (i + 1) % n;
          let ax = polyData[4 + i * 2];
          let ay = polyData[4 + i * 2 + 1];
          let bx = polyData[4 + j * 2];
          let by = polyData[4 + j * 2 + 1];

          if ((ay <= py && by > py) || (by <= py && ay > py)) {
            let t = (py - ay) / (by - ay);
            let hitX = ax + t * (bx - ax);
            if (px < hitX) {
              crossings = crossings + 1;
            }
          }
        }

        var v = 0.0;
        if (crossings % 2 == 1) { v = 1.0; }
        textureStore(mask, vec2<i32>(ix, iy), vec4<f32>(v, 0.0, 0.0, 0.0));
      }
    `;
    this.lassoPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [lassoBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private ensureInvertPipeline(): void {
    if (this.invertPipeline) return;
    const invertBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const code = /* wgsl */ `
      @group(0) @binding(0) var dst: texture_storage_2d<r32float, write>;
      @group(0) @binding(1) var src: texture_2d<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(dst);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);
        let v = textureLoad(src, vec2<i32>(ix, iy), 0).r;
        textureStore(dst, vec2<i32>(ix, iy), vec4<f32>(1.0 - v, 0.0, 0.0, 0.0));
      }
    `;
    this.invertPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [invertBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private ensureMagicWandPipeline(): void {
    if (this.magicWandPipeline) return;
    this.magicWandBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
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

        let diff = max(
          max(abs(px.r - seed.r), abs(px.g - seed.g)),
          max(abs(px.b - seed.b), abs(px.a - seed.a))
        );

        let val = select(0.0, 1.0, diff <= tol);
        textureStore(mask, coord, vec4<f32>(val, 0.0, 0.0, 0.0));
      }
    `;
    this.magicWandPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.magicWandBGL!] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }
}
