import { GPUPipelineCache, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { rdColorLoad, rdDepthLoad } from './render-debug';
/**
 * PostBgKeepPass — keeps a FOCUS-MODE background (armature / mesh-edit: wavy / solid / gradient) out of the scene's
 * post-processing.
 *
 * Post-processing (bloom / colour grade / vignette / film) runs over the whole finished frame, so the editing
 * workspace's background got graded too — a light pattern could wash out to solid white. After the post-processed
 * image is copied to the screen, this pass puts back the UNPROCESSED pixels wherever no 3D surface was drawn: a
 * full-screen triangle at the far plane with depth test 'equal' against the frame's depth buffer passes exactly where
 * the depth is still the cleared 1.0. The character (and every other depth-writing surface) keeps its post look.
 *
 * Only used while a focus background is up — the regular scene (and its sky / scene background) is untouched.
 */

export const POST_BG_KEEP_SHADER = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[vi], 1.0, 1.0);   // z = 1 = the far plane = the depth buffer's clear value
}

@fragment fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(src, vec2<i32>(fc.xy), 0);   // the same pixel, before post-processing
}
`;

export class PostBgKeepPass {
  private readonly _pipe: PipelineHandle<GPURenderPipeline>;   // P2: non-blocking cache handle
  private _bg: { tex: GPUTexture; bg: GPUBindGroup } | null = null;

  constructor(private readonly device: GPUDevice, format: GPUTextureFormat) {
    const module = device.createShaderModule({ code: POST_BG_KEEP_SHADER });
    this._pipe = GPUPipelineCache.for(device).render({
      label: 'PostBgKeep',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'equal' },
    });
  }

  /** Restore `rawSrc` (the pre-post frame) onto `target` wherever `depthView` is still at the far plane. */
  run(encoder: GPUCommandEncoder, rawSrc: GPUTexture, target: GPUTextureView, depthView: GPUTextureView): void {
    const pipe = this._pipe.get();
    if (!pipe) return;   // P2: still compiling → the focus bg is post-processed for a frame (cosmetic)
    if (this._bg?.tex !== rawSrc) {
      this._bg = { tex: rawSrc, bg: this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: rawSrc.createView() },
      ] }) };
    }
    const pass = encoder.beginRenderPass({
      label: 'PostBgKeep',
      colorAttachments: [{ view: target, loadOp: rdColorLoad(), storeOp: 'store' }],   // ('load'; render debug may clear)
      depthStencilAttachment: {
        view: depthView, depthClearValue: 1.0, depthLoadOp: rdDepthLoad(), depthStoreOp: 'store', stencilLoadOp: rdDepthLoad(), stencilStoreOp: 'store',
      },
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this._bg.bg);
    pass.draw(3);
    pass.end();
  }
}
