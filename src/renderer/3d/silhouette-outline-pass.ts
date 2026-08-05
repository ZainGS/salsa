/**
 * SilhouetteOutlinePass — a thick, uniform, animated SCREEN-SPACE outline around a mesh's current projected
 * silhouette (any angle, boxy or smooth), replacing the expand-along-normals hover ring which tore on hard-edged
 * buildings. Two steps: (1) rasterize the target into an r8 MASK (no depth → the full silhouette); (2) a fullscreen
 * COMPOSITE disc-scans the mask and draws a `thickness`-px band filled with the animated pattern, blended over the
 * scene (depthCompare 'always' → on top). Spec: docs/specs/hover-outline.md. Only runs while something is hovered.
 */

import { OUTLINE_MASK_SHADER, OUTLINE_COMPOSITE_SHADER } from './shaders/silhouette-outline-shaders';
import { MESH3D_VERTEX_STRIDE } from './pipeline-3d';
import type { HighlightMeshEntry, HighlightStyle } from './mesh-highlight-pass';

export class SilhouetteOutlinePass {
  private device: GPUDevice;
  private _maskTex: GPUTexture | null = null;
  private _maskView: GPUTextureView | null = null;
  private _w = 0;
  private _h = 0;

  private readonly _maskPipeline: GPURenderPipeline;
  private readonly _compositePipeline: GPURenderPipeline;
  private readonly _compBGL: GPUBindGroupLayout;
  private readonly _paramsBuf: GPUBuffer;      // 64 bytes
  private readonly _scratch = new Float32Array(16);
  private readonly _sampler: GPUSampler;
  private _compBG: GPUBindGroup | null = null;  // rebuilt on resize (mask view changes)

  constructor(device: GPUDevice, meshBGL: GPUBindGroupLayout, swapChainFormat: GPUTextureFormat) {
    this.device = device;
    this._paramsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'OutlineParams' });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // MASK pipeline — position-only, no depth, both faces, writes 1.0 to r8.
    const maskMod = device.createShaderModule({ code: OUTLINE_MASK_SHADER, label: 'OutlineMask' });
    this._maskPipeline = device.createRenderPipeline({
      label: 'OutlineMaskPipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [meshBGL] }),
      vertex: { module: maskMod, entryPoint: 'vs', buffers: [{ arrayStride: MESH3D_VERTEX_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: maskMod, entryPoint: 'fs', targets: [{ format: 'r8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    // COMPOSITE pipeline — fullscreen, blends the band over the main pass (depthCompare 'always' → on top).
    this._compBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ]});
    const compMod = device.createShaderModule({ code: OUTLINE_COMPOSITE_SHADER, label: 'OutlineComposite' });
    this._compositePipeline = device.createRenderPipeline({
      label: 'OutlineCompositePipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._compBGL] }),
      vertex: { module: compMod, entryPoint: 'vs' },
      fragment: { module: compMod, entryPoint: 'fs', targets: [{
        format: swapChainFormat,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  private _ensure(w: number, h: number): void {
    if (this._w === w && this._h === h && this._maskTex) return;
    this._maskTex?.destroy();
    this._w = w; this._h = h;
    this._maskTex = this.device.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'OutlineMask' });
    this._maskView = this._maskTex.createView();
    this._compBG = null;
  }

  /** Rasterize the hovered geometry into the mask (own render pass, no depth → the full projected silhouette). */
  renderMask(encoder: GPUCommandEncoder, meshBindGroup: GPUBindGroup, entries: HighlightMeshEntry[], w: number, h: number): void {
    this._ensure(w, h);
    const pass = encoder.beginRenderPass({ label: 'OutlineMaskPass', colorAttachments: [{ view: this._maskView!, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
    pass.setPipeline(this._maskPipeline);
    pass.setBindGroup(0, meshBindGroup);
    for (const e of entries) {
      pass.setVertexBuffer(0, e.vertex);
      pass.setIndexBuffer(e.index, 'uint32');
      pass.drawIndexed(e.indexCount, 1, e.firstIndex, e.baseVertex, e.instanceIdx);
    }
    pass.end();
  }

  /** Update the band style + per-frame data. `thicknessPx` = band width in pixels. */
  writeParams(style: HighlightStyle, thicknessPx: number, time: number): void {
    const s = this._scratch, c = style.color, pc = style.patternColor;
    s[0] = c[0]; s[1] = c[1]; s[2] = c[2]; s[3] = c[3];
    s[4] = pc[0]; s[5] = pc[1]; s[6] = pc[2]; s[7] = style.glow;
    s[8] = thicknessPx; s[9] = style.patternMode; s[10] = style.freq; s[11] = style.speed;
    s[12] = this._w; s[13] = this._h; s[14] = time; s[15] = 0;
    this.device.queue.writeBuffer(this._paramsBuf, 0, s);
  }

  /** Draw the band into an OPEN scene render pass (blends on top). Call after renderMask + writeParams. */
  composite(pass: GPURenderPassEncoder): void {
    if (!this._maskView) return;
    if (!this._compBG) {
      this._compBG = this.device.createBindGroup({ layout: this._compBGL, entries: [
        { binding: 0, resource: { buffer: this._paramsBuf } },
        { binding: 1, resource: this._maskView },
        { binding: 2, resource: this._sampler },
      ]});
    }
    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compBG);
    pass.draw(3);
  }

  destroy(): void {
    this._maskTex?.destroy();
    this._paramsBuf.destroy();
  }
}
