/**
 * RasterTransformEngine — handles move/scale/rotate of selected raster pixels.
 *
 * Maintains a TransformState (translate, scale, rotation) that's updated during
 * drag operations. When committed, stamps the floating texture back onto the
 * active layer at the transformed position using a GPU compute shader.
 */

import type { SelectionRect } from './raster-selection-mask';

export interface TransformState {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotation: number; // radians
}

export class RasterTransformEngine {
  private device: GPUDevice;
  private state: TransformState = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  private isActive = false;
  private originalBounds: SelectionRect | null = null;

  // Stamp pipeline (lazy-built)
  private stampPipeline: GPUComputePipeline | null = null;
  private stampBGL: GPUBindGroupLayout | null = null;

  // Alpha-blend move pipeline (lazy-built)
  private blendPipeline: GPUComputePipeline | null = null;
  private blendBGL: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /** Begin a transform session. */
  public begin(bounds: SelectionRect): void {
    this.isActive = true;
    this.originalBounds = { ...bounds };
    this.state = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  }

  /** Update the transform from a drag delta or handle interaction. */
  public update(
    dx: number, dy: number,
    scaleX?: number, scaleY?: number,
    rotation?: number,
  ): void {
    if (!this.isActive) return;
    this.state.translateX = dx;
    this.state.translateY = dy;
    if (scaleX !== undefined) this.state.scaleX = scaleX;
    if (scaleY !== undefined) this.state.scaleY = scaleY;
    if (rotation !== undefined) this.state.rotation = rotation;
  }

  /** End the transform session (state preserved until next begin). */
  public end(): void {
    this.isActive = false;
    this.originalBounds = null;
  }

  public getState(): TransformState {
    return { ...this.state };
  }

  public getIsActive(): boolean {
    return this.isActive;
  }

  /** Get the transformed bounding rect (for UI handles). */
  public getTransformedBounds(): SelectionRect | null {
    if (!this.originalBounds) return null;
    const b = this.originalBounds;
    return {
      x: Math.round(b.x + this.state.translateX),
      y: Math.round(b.y + this.state.translateY),
      w: Math.round(b.w * this.state.scaleX),
      h: Math.round(b.h * this.state.scaleY),
    };
  }

  // ── Apply transform ───────────────────────────────────────────────

  /**
   * Stamp `floatingTex` onto `dstTex` using the given transform state.
   *
   * For simple translate (no scale/rotation), uses copyTextureToTexture.
   * For scale/rotation, uses a compute shader with bilinear sampling.
   */
  public applyToTexture(
    floatingTex: GPUTexture,
    dstTex: GPUTexture,
    floatingBounds: SelectionRect,
    state: TransformState,
  ): void {
    const isSimpleMove = 
      Math.abs(state.scaleX - 1) < 0.001 &&
      Math.abs(state.scaleY - 1) < 0.001 &&
      Math.abs(state.rotation) < 0.001;

    if (isSimpleMove) {
      this.applySimpleMove(floatingTex, dstTex, floatingBounds, state);
    } else {
      this.applyFullTransform(floatingTex, dstTex, floatingBounds, state);
    }
  }

  public destroy(): void {
    // No persistent resources to clean up currently
  }

  // ── Simple move (no scale/rotation) ───────────────────────────────

  private applySimpleMove(
    src: GPUTexture, dst: GPUTexture,
    bounds: SelectionRect, state: TransformState,
  ): void {
    const destX = Math.round(bounds.x + state.translateX);
    const destY = Math.round(bounds.y + state.translateY);

    // Clip to destination bounds
    const srcOffX = Math.max(0, -destX);
    const srcOffY = Math.max(0, -destY);
    const dstOffX = Math.max(0, destX);
    const dstOffY = Math.max(0, destY);
    const copyW = Math.min(bounds.w - srcOffX, dst.width - dstOffX);
    const copyH = Math.min(bounds.h - srcOffY, dst.height - dstOffY);
    if (copyW <= 0 || copyH <= 0) return;

    this.ensureBlendPipeline();

    // Copy destination overlap region into a temp texture so we can read it
    const tempTex = this.device.createTexture({
      size: [copyW, copyH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture(
      { texture: dst, origin: { x: dstOffX, y: dstOffY } },
      { texture: tempTex },
      { width: copyW, height: copyH },
    );
    this.device.queue.submit([cpEnc.finish()]);

    // Uniforms: srcOffX, srcOffY, dstOffX, dstOffY, copyW, copyH, pad, pad
    const params = new Float32Array([srcOffX, srcOffY, dstOffX, dstOffY, copyW, copyH, 0, 0]);
    const paramBuf = this.device.createBuffer({
      size: params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set(params);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.blendBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: tempTex.createView() },
        { binding: 2, resource: dst.createView() },
        { binding: 3, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.blendPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(copyW / 8), Math.ceil(copyH / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();
    tempTex.destroy();
  }

  // ── Full transform (scale + rotation) ─────────────────────────────

  private applyFullTransform(
    src: GPUTexture, dst: GPUTexture,
    bounds: SelectionRect, state: TransformState,
  ): void {
    this.ensureStampPipeline();

    // Compute the output region we need to write
    const outW = Math.round(bounds.w * state.scaleX);
    const outH = Math.round(bounds.h * state.scaleY);
    const outX = Math.round(bounds.x + state.translateX);
    const outY = Math.round(bounds.y + state.translateY);

    // Clamp to destination texture
    const minX = Math.max(0, outX);
    const minY = Math.max(0, outY);
    const maxX = Math.min(dst.width, outX + outW);
    const maxY = Math.min(dst.height, outY + outH);
    const dispW = maxX - minX;
    const dispH = maxY - minY;
    if (dispW <= 0 || dispH <= 0) return;

    // Uniform: outX, outY, outW, outH, srcW, srcH, scaleX, scaleY, rotation, boundsX, boundsY, pad
    const params = new Float32Array([
      outX, outY, outW, outH,
      bounds.w, bounds.h,
      state.scaleX, state.scaleY,
      state.rotation,
      bounds.x + bounds.w / 2, // rotation center X
      bounds.y + bounds.h / 2, // rotation center Y
      0,
    ]);

    const paramBuf = this.device.createBuffer({
      size: params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set(params);
    paramBuf.unmap();

    // Copy destination into a temp texture for alpha-blend reading
    const tempTex = this.device.createTexture({
      size: [dst.width, dst.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture(
      { texture: dst },
      { texture: tempTex },
      { width: dst.width, height: dst.height },
    );
    this.device.queue.submit([cpEnc.finish()]);

    const sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const bg = this.device.createBindGroup({
      layout: this.stampBGL!,
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: dst.createView() },
        { binding: 3, resource: { buffer: paramBuf } },
        { binding: 4, resource: tempTex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.stampPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(dispW / 8), Math.ceil(dispH / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();
    tempTex.destroy();
  }

  private ensureStampPipeline(): void {
    if (this.stampPipeline) return;

    this.stampBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var srcSamp: sampler;
      @group(0) @binding(2) var dstTex: texture_storage_2d<rgba8unorm, write>;
      // params: outX, outY, outW, outH, srcW, srcH, scaleX, scaleY, rotation, pivotX, pivotY, pad
      @group(0) @binding(3) var<uniform> params: array<f32, 12>;
      @group(0) @binding(4) var dstOldTex: texture_2d<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let outX = i32(params[0]);
        let outY = i32(params[1]);
        let outW = params[2];
        let outH = params[3];
        let rotation = params[8];

        let ix = outX + i32(gid.x);
        let iy = outY + i32(gid.y);

        let dim = textureDimensions(dstTex);
        if (ix < 0 || iy < 0 || u32(ix) >= dim.x || u32(iy) >= dim.y) { return; }
        if (f32(gid.x) >= outW || f32(gid.y) >= outH) { return; }

        // Map destination pixel back to source UV
        let relX = (f32(gid.x) + 0.5) / outW;
        let relY = (f32(gid.y) + 0.5) / outH;

        // Apply inverse rotation around center
        let cosR = cos(-rotation);
        let sinR = sin(-rotation);
        let cx = relX - 0.5;
        let cy = relY - 0.5;
        let rx = cx * cosR - cy * sinR + 0.5;
        let ry = cx * sinR + cy * cosR + 0.5;

        // Out of bounds check
        if (rx < 0.0 || rx > 1.0 || ry < 0.0 || ry > 1.0) { return; }

        // Sample source with bilinear filtering
        let srcColor = textureSampleLevel(srcTex, srcSamp, vec2<f32>(rx, ry), 0.0);
        if (srcColor.a <= 0.001) { return; }

        // Alpha-over composite with existing destination pixels
        let oldDst = textureLoad(dstOldTex, vec2<i32>(ix, iy), 0);
        let outA = srcColor.a + oldDst.a * (1.0 - srcColor.a);
        var outRGB = srcColor.rgb;
        if (outA > 0.001) {
          outRGB = (srcColor.rgb * srcColor.a + oldDst.rgb * oldDst.a * (1.0 - srcColor.a)) / outA;
        }
        textureStore(dstTex, vec2<i32>(ix, iy), vec4<f32>(outRGB, outA));
      }
    `;

    this.stampPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.stampBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  /** Lazy-build the alpha-blend move pipeline (for simple translate). */
  private ensureBlendPipeline(): void {
    if (this.blendPipeline) return;

    this.blendBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var dstOldTex: texture_2d<f32>;
      @group(0) @binding(2) var dstTex: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var<uniform> params: array<f32, 8>; // srcOffX, srcOffY, dstOffX, dstOffY, copyW, copyH, pad, pad

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let copyW = i32(params[4]);
        let copyH = i32(params[5]);
        if (i32(gid.x) >= copyW || i32(gid.y) >= copyH) { return; }

        let srcCoord = vec2<i32>(i32(params[0]) + i32(gid.x), i32(params[1]) + i32(gid.y));
        let dstCoord = vec2<i32>(i32(params[2]) + i32(gid.x), i32(params[3]) + i32(gid.y));

        let src = textureLoad(srcTex, srcCoord, 0);
        let dst = textureLoad(dstOldTex, vec2<i32>(i32(gid.x), i32(gid.y)), 0);

        // Alpha-over composite
        let outA = src.a + dst.a * (1.0 - src.a);
        var outRGB = src.rgb;
        if (outA > 0.001) {
          outRGB = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA;
        }
        textureStore(dstTex, dstCoord, vec4<f32>(outRGB, outA));
      }
    `;

    this.blendPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.blendBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }
}
