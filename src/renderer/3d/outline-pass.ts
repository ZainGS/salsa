/**
 * OutlinePass — Screen-space ink outline effect.
 *
 * Renders a silhouette outline around all 3D meshes by:
 *  1. A depth+normal pre-pass — depth32float + rgba8unorm(packed world normals).
 *     Renderer3D drives this using its existing mesh buffers and bind groups.
 *  2. An edge detection pass — detects BOTH silhouette boundaries (depth→FAR) and
 *     hard creases (normal dot < threshold) → rgba8unorm edge mask.
 *  3. A composite fullscreen quad — blends edge mask into the main render pass.
 *
 * The combined depth+normal pipeline is exposed as `depthNormalPipeline` so
 * Renderer3D can drive it with the same mesh buffers used for the main pass.
 */

import {
  OUTLINE_DEPTH_NORMAL_SHADER,
  OUTLINE_SOBEL_SHADER,
  OUTLINE_COMPOSITE_SHADER,
} from './shaders/outline-shaders';
import { MESH3D_VERTEX_STRIDE } from './pipeline-3d';

/** 32-byte aligned struct — see OutlineParams in outline-shaders.ts */
const PARAMS_BUFFER_SIZE = 32;

export class OutlinePass {
  private device: GPUDevice;

  // ── Config ────────────────────────────────────────────────────────
  /** Outline colour (r, g, b, a). Default: opaque black. */
  public color: [number, number, number, number] = [0, 0, 0, 1];
  /** Outline half-width in physical pixels. Default: 2. */
  public threshold = 2;

  // ── Offscreen textures ────────────────────────────────────────────
  private _depthTex:   GPUTexture | null = null;
  private _normalTex:  GPUTexture | null = null;
  private _edgeTex:    GPUTexture | null = null;
  private _depthView:  GPUTextureView | null = null;
  private _normalView: GPUTextureView | null = null;
  private _edgeView:   GPUTextureView | null = null;
  private _texW = 0;
  private _texH = 0;

  // ── Pipelines ─────────────────────────────────────────────────────
  /**
   * Combined depth+normal pre-pass pipeline.
   * Renderer3D drives this directly using the same vertex/index buffers as the main pass.
   * Vertex attributes: location(0) = position (offset 0), location(1) = normal (offset 12).
   */
  public readonly depthNormalPipeline: GPURenderPipeline;

  private readonly _sobelPipeline:     GPURenderPipeline;
  private readonly _compositePipeline: GPURenderPipeline;

  // ── Bind group layouts ────────────────────────────────────────────
  private readonly _sobelBGL:     GPUBindGroupLayout;
  private readonly _compositeBGL: GPUBindGroupLayout;

  // ── Per-frame bind groups (rebuilt when texture size changes) ─────
  private _sobelBG:     GPUBindGroup | null = null;
  private _compositeBG: GPUBindGroup | null = null;

  // ── Params uniform ────────────────────────────────────────────────
  private readonly _paramsBuffer: GPUBuffer;

  constructor(
    device: GPUDevice,
    meshBindGroupLayout: GPUBindGroupLayout,
    swapChainFormat: GPUTextureFormat,
  ) {
    this.device = device;

    this._paramsBuffer = device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // ── Depth+Normal pre-pass pipeline ───────────────────────────
    // Writes camera-view depth to depth attachment AND packed world normals
    // to an rgba8unorm color attachment in a single pass.
    const depthNormalModule = device.createShaderModule({ code: OUTLINE_DEPTH_NORMAL_SHADER });
    const depthNormalLayout = device.createPipelineLayout({
      bindGroupLayouts: [meshBindGroupLayout],
    });

    this.depthNormalPipeline = device.createRenderPipeline({
      layout: depthNormalLayout,
      vertex: {
        module: depthNormalModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
          ],
        }],
      },
      fragment: {
        module: depthNormalModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }], // packed world normals
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      // 'none': write depth/normals for both faces so back-viewed planes and
      // rotated cylinder caps contribute to the outline correctly.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    // ── Sobel bind group layout ───────────────────────────────────
    // binding 0: depth texture (silhouette detection)
    // binding 1: params uniform (color, width)
    // binding 2: normal texture (hard-crease detection)
    this._sobelBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const sobelModule = device.createShaderModule({ code: OUTLINE_SOBEL_SHADER });
    this._sobelPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._sobelBGL] }),
      vertex:   { module: sobelModule, entryPoint: 'vs' },
      fragment: {
        module: sobelModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // ── Composite bind group layout ───────────────────────────────
    this._compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const compositeModule = device.createShaderModule({ code: OUTLINE_COMPOSITE_SHADER });
    this._compositePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._compositeBGL] }),
      vertex:   { module: compositeModule, entryPoint: 'vs' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs',
        targets: [{
          format: swapChainFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ── Public accessors ───────────────────────────────────────────────

  get depthTexView(): GPUTextureView {
    if (!this._depthView) throw new Error('OutlinePass: call ensureTextures() first');
    return this._depthView;
  }

  get normalTexView(): GPUTextureView {
    if (!this._normalView) throw new Error('OutlinePass: call ensureTextures() first');
    return this._normalView;
  }

  // ── Texture lifecycle ──────────────────────────────────────────────

  ensureTextures(w: number, h: number): void {
    if (w === this._texW && h === this._texH) return;

    this._depthTex?.destroy();
    this._normalTex?.destroy();
    this._edgeTex?.destroy();

    this._depthTex = this.device.createTexture({
      size: [w, h, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._normalTex = this.device.createTexture({
      size: [w, h, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._edgeTex = this.device.createTexture({
      size: [w, h, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this._depthView  = this._depthTex.createView();
    this._normalView = this._normalTex.createView();
    this._edgeView   = this._edgeTex.createView();
    this._texW = w;
    this._texH = h;

    // Rebuild bind groups that reference the textures
    this._sobelBG = this.device.createBindGroup({
      layout: this._sobelBGL,
      entries: [
        { binding: 0, resource: this._depthView },
        { binding: 1, resource: { buffer: this._paramsBuffer } },
        { binding: 2, resource: this._normalView },
      ],
    });
    this._compositeBG = this.device.createBindGroup({
      layout: this._compositeBGL,
      entries: [
        { binding: 0, resource: this._edgeView! },
      ],
    });
  }

  // ── Per-frame calls ────────────────────────────────────────────────

  /** Upload colour + outline width to the params uniform buffer. */
  private readonly _paramsScratch = new Float32Array(8);   // reused (was a fresh array every frame)
  updateParams(): void {
    const data = this._paramsScratch;
    data[0] = this.color[0]; data[1] = this.color[1];
    data[2] = this.color[2]; data[3] = this.color[3];
    data[4] = this.threshold;
    this.device.queue.writeBuffer(this._paramsBuffer, 0, data);
  }

  /**
   * Run the edge detection pass inside the given command encoder.
   * Call AFTER the depth+normal pre-pass (which writes depthTex + normalTex) is ended.
   * Writes the edge mask into edgeTex.
   */
  runSobelPass(encoder: GPUCommandEncoder): void {
    if (!this._sobelBG || !this._edgeView) return;

    const sobelPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this._edgeView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    sobelPass.setPipeline(this._sobelPipeline);
    sobelPass.setBindGroup(0, this._sobelBG);
    sobelPass.draw(3);
    sobelPass.end();
  }

  /**
   * Draw the edge mask composite quad into the active main render pass.
   * Call this AFTER all mesh draw calls so outlines render on top.
   */
  drawComposite(pass: GPURenderPassEncoder): void {
    if (!this._compositeBG) return;
    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compositeBG);
    pass.draw(3);
  }

  destroy(): void {
    this._depthTex?.destroy();
    this._normalTex?.destroy();
    this._edgeTex?.destroy();
    this._depthTex  = null;
    this._normalTex = null;
    this._edgeTex   = null;
    this._depthView  = null;
    this._normalView = null;
    this._edgeView   = null;
  }
}
