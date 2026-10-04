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

import { PipelineSet, type PipelineHandle } from '../core/gpu-pipeline-cache';
import {
  OUTLINE_DEPTH_NORMAL_SHADER,
  OUTLINE_SOBEL_SHADER,
  OUTLINE_COMPOSITE_SHADER,
} from './shaders/outline-shaders';
import { MESH3D_VERTEX_STRIDE } from './pipeline-3d';
import { noteTwinSource, packedTwin } from './vertex-pack';

/** 16-byte aligned struct — see OutlineParams in outline-shaders.ts (color, width + pad, invViewProj, fogCut). */
const PARAMS_BUFFER_SIZE = 144;   // + camEye (the depth fade, visual-polish #8) + extra (foliage mode / crease fade, #3)

/** visual-polish #3 options of the ink (absent fields = the original pass). `foliage`: how leaf-card / foliage-shade
 *  pixels ink ('full' = like everything else, 'silhouette' = only where foliage meets non-foliage or the sky, 'off' =
 *  never). `creaseFade`: crease (normal-edge) ink fades from full at `near` to `minAlpha` at `far` world units from
 *  the camera; silhouettes are untouched. */
export interface OutlineExtras {
  foliage?: 'full' | 'silhouette' | 'off';
  /** `thinPx` (visual-polish #3b, absent / < 2 = off): past `near`, crease ink needs BOTH faces of the crease to be at
   *  least this many pixels thick along the edge normal (an occlusion edge — a big depth step — always qualifies), so a
   *  sub-pixel face (a ledge underside at 30–40 m, rasterised in some pixels and not others) stops inking dashes. */
  creaseFade?: { near: number; far: number; minAlpha?: number; thinPx?: number } | null;
}
/** The foliage mode as the Sobel shader's code (extra.x). */
export function outlineFoliageCode(m: OutlineExtras['foliage']): number { return m === 'silhouette' ? 1 : m === 'off' ? 2 : 0; }

export class OutlinePass {
  private device: GPUDevice;

  // ── Config ────────────────────────────────────────────────────────
  /** Outline colour (r, g, b, a). Default: opaque black. */
  public color: [number, number, number, number] = [0, 0, 0, 1];
  /** Outline half-width in physical pixels. Default: 2. */
  public threshold = 2;
  /** FOG HORIZON cut (Silhouette outlines off): no outline on pixels at or past `edge` from `eye`, given the pre-pass
   *  view-projection's inverse. null = off (outlines everywhere, the original). Set by Renderer3D each frame. */
  public fogCut: { eye: ArrayLike<number>; edge: number; invViewProj: ArrayLike<number> } | null = null;
  /** DEPTH FADE (visual-polish #8, the "Graphic" look): the ink thins from `threshold` px to 1 px and fades to
   *  `minAlpha` x its alpha between `near` and `far` world units from the camera, so far poles / window grids stop
   *  breaking into dashes. null = off (the original constant-width ink). */
  public depthFade: { near: number; far: number; minAlpha: number } | null = null;
  /** World-from-clip of the pre-pass camera + the camera eye, for the depth fade (set by Renderer3D each frame while
   *  depthFade is on). */
  public fadeView: { eye: ArrayLike<number>; invViewProj: ArrayLike<number> } | null = null;
  /** visual-polish #3: the foliage mode (0 full / 1 silhouette / 2 off) and the crease fade (world units; null = off). */
  public foliageMode = 0;
  public creaseFade: { near: number; far: number; minAlpha: number; thinPx: number } | null = null;
  /** Set both #3 options at once (every enableOutlines call does: absent = back to the original ink). */
  setExtras(x?: OutlineExtras | null): void {
    this.foliageMode = outlineFoliageCode(x?.foliage);
    const cf = x?.creaseFade;
    const tp = cf && typeof cf.thinPx === 'number' && Number.isFinite(cf.thinPx) && cf.thinPx >= 2 ? Math.min(4, Math.round(cf.thinPx)) : 0;
    this.creaseFade = cf && Number.isFinite(cf.near) && Number.isFinite(cf.far) && cf.far > cf.near
      ? { near: Math.max(0, cf.near), far: cf.far, minAlpha: Math.max(0, Math.min(1, cf.minAlpha ?? 0)), thinPx: tp } : null;
  }
  /** The renderer must supply fadeView (camera eye + world-from-clip) this frame: the depth fade or the crease fade is on. */
  get needsFadeView(): boolean { return !!this.depthFade || !!this.creaseFade; }

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
  // P2: every pipeline is a non-blocking cache handle (docs/specs/performance-plan.md); ready() gates the pass.
  private readonly _pipes: PipelineSet;
  private readonly _depthNormalH: PipelineHandle<GPURenderPipeline>;
  /** The depth+normal pre-pass pipeline — null while it compiles (gate the whole pass on ready()). */
  get depthNormalPipeline(): GPURenderPipeline | null {
    const p = this._depthNormalH.get();
    if (p) noteTwinSource(p, this._depthNormalH.descriptor());   // P22: it draws pooled geometry (packed twin, vertex-pack.ts)
    return p;
  }
  /** P22: start compiling the depth+normal pipeline's packed twin. */
  requestPackedTwins(): void { const p = this.depthNormalPipeline; if (p) packedTwin(this.device, p); }

  private readonly _sobelPipeline:     PipelineHandle<GPURenderPipeline>;
  private readonly _compositePipeline: PipelineHandle<GPURenderPipeline>;

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
    this._pipes = new PipelineSet(device);

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

    this._depthNormalH = this._pipes.render({
      label: 'OutlineDepthNormal',
      layout: depthNormalLayout,
      vertex: {
        module: depthNormalModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: MESH3D_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
            { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv (leaf-card cut-out, visual-polish #3)
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
    }, undefined, 'outline.depthNormal');   // KEYED (bug-hunt 2026-10-01 D-R3): re-enabling outlines reuses the compiled pipeline

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
    this._sobelPipeline = this._pipes.render({
      label: 'OutlineSobel',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._sobelBGL] }),
      vertex:   { module: sobelModule, entryPoint: 'vs' },
      fragment: {
        module: sobelModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    }, undefined, 'outline.sobel');

    // ── Composite bind group layout ───────────────────────────────
    this._compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const compositeModule = device.createShaderModule({ code: OUTLINE_COMPOSITE_SHADER });
    this._compositePipeline = this._pipes.render({
      label: 'OutlineComposite',
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
      // The composite quad draws INSIDE the main scene pass, whose attachment state carries
      // depth24plus-stencil8 — a pipeline without a matching depthStencil block is rejected by
      // validation (pre-existing break found 2026-09-12; the whole frame's submit was discarded, so
      // enabling outlines blanked 3D rendering). Overlay semantics: never write, never test.
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
    }, undefined, 'outline.composite:' + swapChainFormat);
  }

  // ── Public accessors ───────────────────────────────────────────────

  /** P2: true once all three pipelines compiled. The renderer runs the pre-pass AND the composite only when ready,
   *  so the outline is simply absent (never stale) for the frames its shaders are compiling. */
  ready(): boolean { return this._pipes.ready(); }

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
  private readonly _paramsScratch = new Float32Array(PARAMS_BUFFER_SIZE / 4);   // reused (was a fresh array every frame)
  updateParams(): void {
    const data = this._paramsScratch;
    data[0] = this.color[0]; data[1] = this.color[1];
    data[2] = this.color[2]; data[3] = this.color[3];
    data[4] = this.threshold;
    const fc = this.fogCut;
    if (fc && fc.edge > 0) {
      data.set(fc.invViewProj, 8);
      data[24] = fc.eye[0]; data[25] = fc.eye[1]; data[26] = fc.eye[2]; data[27] = fc.edge;
    } else data[27] = 0;
    // Depth fade: (near, far, minAlpha) in the width slot's padding (far <= near = off); both cuts share one inverse VP.
    const df = this.depthFade, fv = this.fadeView;
    if (df && fv && df.far > df.near) {
      if (!(fc && fc.edge > 0)) data.set(fv.invViewProj, 8);
      data[5] = Math.max(0, df.near); data[6] = df.far; data[7] = Math.max(0, Math.min(1, df.minAlpha));
      data[28] = fv.eye[0]; data[29] = fv.eye[1]; data[30] = fv.eye[2];
    } else { data[5] = 0; data[6] = 0; data[7] = 1; }
    // visual-polish #3: extra = (foliage mode, crease-fade near, far, minAlpha); far <= near = no crease fade.
    const cf = this.creaseFade;
    if (cf && fv) {
      if (!(fc && fc.edge > 0) && !(df && df.far > df.near)) data.set(fv.invViewProj, 8);
      data[28] = fv.eye[0]; data[29] = fv.eye[1]; data[30] = fv.eye[2];
      data[33] = cf.near; data[34] = cf.far; data[35] = cf.minAlpha;
      data[31] = cf.thinPx;   // camEye.w: the thin-crease rule (visual-polish #3b; 0 = off)
    } else { data[33] = 0; data[34] = 0; data[35] = 1; data[31] = 0; }
    data[32] = this.foliageMode;
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
    const sobel = this._sobelPipeline.get();
    if (sobel) {
      sobelPass.setPipeline(sobel);
      sobelPass.setBindGroup(0, this._sobelBG);
      sobelPass.draw(3);
    }
    sobelPass.end();
  }

  /**
   * Draw the edge mask composite quad into the active main render pass.
   * Call this AFTER all mesh draw calls so outlines render on top.
   */
  drawComposite(pass: GPURenderPassEncoder): void {
    const composite = this._compositePipeline.get();
    if (!this._compositeBG || !composite) return;
    pass.setPipeline(composite);
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
