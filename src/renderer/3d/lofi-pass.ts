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

import { GPUPipelineCache, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { PP_FULLSCREEN_VS } from './shaders/post-process-shaders';

export const LOFI_BLIT_FS = /* wgsl */`
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

// RESOLUTION SCALING upscale (docs/ui/performance.md): Catmull-Rom bicubic from 5 bilinear taps (the 4 corner taps of
// the 9-tap form dropped; their weights are tiny), then clamped to the min/max of the 4 nearest source texels so the
// sharpening never rings (no dark or bright halos along edges). Sharper than a plain bilinear stretch, ~9 fetches.
export const LOFI_SHARP_FS = /* wgsl */`
@group(0) @binding(0) var loResTex:  texture_2d<f32>;
@group(0) @binding(1) var loResSamp: sampler;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(loResTex));
  let inv = 1.0 / size;
  let sp = in.uv * size;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (tp1 - 1.0) * inv;
  let t3 = (tp1 + 2.0) * inv;
  let t12 = (tp1 + w2 / w12) * inv;
  var c = textureSampleLevel(loResTex, loResSamp, vec2f(t12.x, t0.y), 0.0) * (w12.x * w0.y);
  c += textureSampleLevel(loResTex, loResSamp, vec2f(t0.x, t12.y), 0.0) * (w0.x * w12.y);
  c += textureSampleLevel(loResTex, loResSamp, t12, 0.0) * (w12.x * w12.y);
  c += textureSampleLevel(loResTex, loResSamp, vec2f(t3.x, t12.y), 0.0) * (w3.x * w12.y);
  c += textureSampleLevel(loResTex, loResSamp, vec2f(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  c = c / wsum;
  let maxI = vec2i(size) - vec2i(1);
  let b = vec2i(tp1 - 0.5);
  let a00 = textureLoad(loResTex, clamp(b, vec2i(0), maxI), 0);
  let a10 = textureLoad(loResTex, clamp(b + vec2i(1, 0), vec2i(0), maxI), 0);
  let a01 = textureLoad(loResTex, clamp(b + vec2i(0, 1), vec2i(0), maxI), 0);
  let a11 = textureLoad(loResTex, clamp(b + vec2i(1, 1), vec2i(0), maxI), 0);
  let lo = min(min(a00, a10), min(a01, a11));
  let hi = max(max(a00, a10), max(a01, a11));
  return clamp(c, lo, hi);
}
`;

// RESOLUTION SCALING depth upsample: copies the lo-res scene depth into the full-size main depth buffer (nearest),
// so the overlay pass (grid, gizmos, mesh-edit handles), the focus-background restore and the post overlays
// depth-test against the scene exactly as on the native path. Writes depth only (the colour target is masked off).
export const LOFI_DEPTH_FS = /* wgsl */`
@group(0) @binding(0) var loDepth: texture_depth_2d;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@fragment fn fs_main(in: VsOut) -> @builtin(frag_depth) f32 {
  let size = vec2f(textureDimensions(loDepth));
  let p = vec2i(clamp(in.uv * size, vec2f(0.0), size - vec2f(1.0)));
  return textureLoad(loDepth, p, 0);
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
  private readonly _blitPipeline: PipelineHandle<GPURenderPipeline>;   // P2: non-blocking cache handle
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

    this._blitPipeline = GPUPipelineCache.for(device).render({
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

    // Resolution scaling: the sharpened upscale (same layout + blend as the blit) and the depth upsample.
    const sharpFs = device.createShaderModule({ code: LOFI_SHARP_FS, label: 'LoFiSharpFS' });
    this._sharpPipeline = GPUPipelineCache.for(device).render({
      label: 'LoFiSharpBlit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._blitBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: sharpFs,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
      primitive: { topology: 'triangle-list' },
    });
    this._depthBGL = device.createBindGroupLayout({
      label: 'LoFiDepthBGL',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d' } }],
    });
    const depthFs = device.createShaderModule({ code: LOFI_DEPTH_FS, label: 'LoFiDepthFS' });
    this._depthPipeline = GPUPipelineCache.for(device).render({
      label: 'LoFiDepthUpsample',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._depthBGL] }),
      vertex:   { module: vs, entryPoint: 'vs_main' },
      fragment: { module: depthFs, entryPoint: 'fs_main', targets: [{ format, writeMask: 0 }] },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'always' },
      primitive: { topology: 'triangle-list' },
    });
  }

  // Resolution-scaling pipelines (see LOFI_SHARP_FS / LOFI_DEPTH_FS).
  private readonly _sharpPipeline: PipelineHandle<GPURenderPipeline>;
  private readonly _depthBGL: GPUBindGroupLayout;
  private readonly _depthPipeline: PipelineHandle<GPURenderPipeline>;
  private _depthBG: GPUBindGroup | null = null;
  private _depthBGSrc: GPUTexture | null = null;
  /** Upscale with the sharpened bicubic filter instead of the plain sampler (resolution scaling). Needs linearFilter. */
  sharpen = false;

  /** Copy the lo-res depth into the active pass's depth attachment (full size, nearest). False when the pipeline is
   *  still compiling or nothing was rendered yet; the caller then keeps the overlays inline (the old lo-res path). */
  blitDepthToRenderPass(pass: GPURenderPassEncoder): boolean {
    const p = this._depthPipeline.get();
    if (!p || !this._depthTex) return false;
    if (this._depthBGSrc !== this._depthTex) {
      this._depthBG = this.device.createBindGroup({
        label: 'LoFiDepthBG',
        layout: this._depthBGL,
        entries: [{ binding: 0, resource: this._depthTex.createView({ aspect: 'depth-only' }) }],
      });
      this._depthBGSrc = this._depthTex;
    }
    pass.setPipeline(p);
    pass.setBindGroup(0, this._depthBG!);
    pass.draw(3);
    return true;
  }
  /** True once the depth upsample can run (the renderer then defers the overlays to the full-size overlay pass). */
  depthBlitReady(): boolean { return !!this._depthPipeline.get(); }

  get width():  number { return this._w; }
  get height(): number { return this._h; }
  /** The lo-res targets (temporal AA reads them after the scene pass; null before the first pass). */
  get colorTexture(): GPUTexture | null { return this._colorTex; }
  get depthTexture(): GPUTexture | null { return this._depthTex; }
  get depthView(): GPUTextureView | null { return this._depthView; }

  /** Recreate lo-res textures if the requested size differs from the current size. */
  private _ensureSize(w: number, h: number): void {
    if (this._w === w && this._h === h && this._colorTex) return;

    this._colorTex?.destroy();
    this._depthTex?.destroy();
    this._blitBG = null;
    this._blitBGSrc = null;
    this._depthBG = null;
    this._depthBGSrc = null;

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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,   // + the resolution-scaling depth upsample
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
  /** P2: true once the blit pipeline compiled — the renderer only takes the lo-res path when it can blit back. */
  ready(): boolean { return !!this._blitPipeline.get(); }

  blitToRenderPass(pass: GPURenderPassEncoder): void {
    const blit = this._blitPipeline.get();
    if (!this._colorTex || !blit) return;

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

    const sharp = this.sharpen && this.linearFilter ? this._sharpPipeline.get() : null;
    pass.setPipeline(sharp ?? blit);
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
    this._depthBG    = null;
    this._depthBGSrc = null;
  }
}
