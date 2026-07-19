/**
 * LoFiPass — Low-resolution render buffer for PS1/3DS-style aesthetics.
 *
 * Manages an offscreen color+depth texture at a reduced resolution (e.g. 320×240).
 * All 3D passes target this small texture; a final fullscreen blit upscales it to
 * the main render target using nearest-neighbor magnification, producing the
 * characteristic pixelated look of PS1/3DS games. Outline staggering on diagonal
 * edges is an emergent consequence of this — no special outline logic needed.
 *
 * Usage (per frame):
 *   1. beginRenderPass(encoder, w, h, clearColor)  → GPURenderPassEncoder
 *      Draw all 3D content into the returned pass at lo-res dimensions.
 *   2. pass.end()
 *   3. blitToRenderPass(mainPass)
 *      Draws the lo-res result as a fullscreen quad into the main pass.
 */

import { PP_FULLSCREEN_VS } from './shaders/post-process-shaders';

const LOFI_BLIT_FS = /* wgsl */`
@group(0) @binding(0) var loResTex:  texture_2d<f32>;
@group(0) @binding(1) var loResSamp: sampler;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(loResTex, loResSamp, in.uv);
}
`;

export class LoFiPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Lo-res render textures (recreated when size changes)
  private _colorTex:  GPUTexture | null = null;
  private _depthTex:  GPUTexture | null = null;
  private _colorView: GPUTextureView | null = null;
  private _depthView: GPUTextureView | null = null;
  private _w = 0;
  private _h = 0;

  // Nearest-neighbor blit pipeline
  private readonly _blitBGL: GPUBindGroupLayout;
  private readonly _blitPipeline: GPURenderPipeline;
  private readonly _nearestSampler: GPUSampler;
  private readonly _linearSampler: GPUSampler;

  /** Upscale filter: false = nearest (the PS1 chunky-pixel look), true = linear (dynamic-resolution mode — the
   *  lo-res buffer is a perf trick there, not an aesthetic, so the upscale must be smooth/invisible). */
  linearFilter = false;

  // Per-frame bind group (rebuilt when texture identity or filter changes)
  private _blitBG: GPUBindGroup | null = null;
  private _blitBGSrc: GPUTexture | null = null;
  private _blitBGLinear = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;

    this._nearestSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
    this._linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this._blitBGL = device.createBindGroupLayout({
      label: 'LoFiBlitBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const vs = device.createShaderModule({ code: PP_FULLSCREEN_VS, label: 'LoFiBlitVS' });
    const fs = device.createShaderModule({ code: LOFI_BLIT_FS,     label: 'LoFiBlitFS' });

    this._blitPipeline = device.createRenderPipeline({
      label: 'LoFiBlit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._blitBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: fs,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      // The MAIN pass this blits into carries a depth24plus-stencil8 attachment — a pipeline used inside it MUST
      // declare a matching depthStencil state (WebGPU attachment-compatibility) even though the fullscreen quad
      // neither tests nor writes depth. Without this the blit was invalid in the editor's main pass (the PS1
      // lo-res path had the same latent bug; dynamic resolution surfaced it).
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
      primitive: { topology: 'triangle-list' },
    });
  }

  get width():  number { return this._w; }
  get height(): number { return this._h; }

  /** Recreate lo-res textures if the requested size differs from the current size. */
  private _ensureSize(w: number, h: number): void {
    if (this._w === w && this._h === h && this._colorTex) return;

    this._colorTex?.destroy();
    this._depthTex?.destroy();
    this._blitBG = null;
    this._blitBGSrc = null;

    this._colorTex = this.device.createTexture({
      label: 'LoFiColor',
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._depthTex = this.device.createTexture({
      label: 'LoFiDepth',
      size: [w, h],
      format: 'depth24plus-stencil8',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._colorView = this._colorTex.createView();
    this._depthView = this._depthTex.createView();
    this._w = w;
    this._h = h;
  }

  /**
   * Begin a render pass targeting the lo-res texture.
   * Call pass.end() when all 3D draws are complete, then call blitToRenderPass().
   */
  beginRenderPass(
    encoder: GPUCommandEncoder,
    w: number,
    h: number,
    clearColor: GPUColor = { r: 0, g: 0, b: 0, a: 0 },
  ): GPURenderPassEncoder {
    this._ensureSize(w, h);
    return encoder.beginRenderPass({
      colorAttachments: [{
        view:       this._colorView!,
        clearValue: clearColor,
        loadOp:     'clear',
        storeOp:    'store',
      }],
      depthStencilAttachment: {
        view:             this._depthView!,
        depthClearValue:  1.0,
        depthLoadOp:      'clear',
        depthStoreOp:     'store',
        stencilClearValue: 0,
        stencilLoadOp:    'clear',
        stencilStoreOp:   'store',
      },
    });
  }

  /**
   * Draw the lo-res result into the currently-active render pass as a fullscreen quad.
   * Uses nearest-neighbor magnification — this is what creates the pixelated PS1 look.
   * Must be called while a render pass is active.
   */
  blitToRenderPass(pass: GPURenderPassEncoder): void {
    if (!this._colorTex) return;

    if (this._blitBGSrc !== this._colorTex || this._blitBGLinear !== this.linearFilter) {
      this._blitBG = this.device.createBindGroup({
        label:  'LoFiBlitBG',
        layout: this._blitBGL,
        entries: [
          { binding: 0, resource: this._colorView! },
          { binding: 1, resource: this.linearFilter ? this._linearSampler : this._nearestSampler },
        ],
      });
      this._blitBGSrc = this._colorTex;
      this._blitBGLinear = this.linearFilter;
    }

    pass.setPipeline(this._blitPipeline);
    pass.setBindGroup(0, this._blitBG!);
    pass.draw(3);
  }

  destroy(): void {
    this._colorTex?.destroy();
    this._depthTex?.destroy();
    this._colorTex  = null;
    this._depthTex  = null;
    this._colorView = null;
    this._depthView = null;
    this._blitBG    = null;
    this._blitBGSrc = null;
  }
}
