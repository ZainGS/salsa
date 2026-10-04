/**
 * SpriteOutlinePass — draws persistent outlines for textured SPRITES in their own plane
 * (docs/specs/sprite-alpha-outlines.md): 'image' = around the picture's shape (from its distance field,
 * SpriteSDFCache), 'card' = a SOLID card (the see-through part of the quad filled) with the rings around the square.
 *
 * Deliberately separate from MeshHighlightPass: the hull outline's pipelines, param pools and stencil steps are not
 * touched. This pass uses no stencil at all — one grown quad per sprite. Depth: like the regular persistent outline
 * (depth-tested + depth-writing so the later skinned pass is occluded by it), or depth-ignoring for `merge` styles.
 * A small depth bias toward the camera keeps the band (coplanar with the sprite) from z-fighting its own sprite.
 */

import { GPUPipelineCache, type PipelineHandle } from '../core/gpu-pipeline-cache';
import type { HighlightStyle } from './mesh-highlight-pass';
import { SPRITE_OUTLINE_SHADER } from './shaders/sprite-outline-shaders';
import { SPRITE_OUTLINE_MAX_LAYERS, spriteLayerOuterWidths, type SpriteSDFTexture } from './sprite-outline';

/** 5 header vec4s (quad, field, screen, mode, uvt) + 8 layers × 4 vec4s. */
const HEADER_FLOATS = 20;
const SPRITE_PARAMS_FLOATS = HEADER_FLOATS + SPRITE_OUTLINE_MAX_LAYERS * 16;

interface SpriteOutlineDrawBase {
  instanceIdx: number;
  /** Sprite width / height (model units). */
  width: number; height: number;
  /** The layers (outlineLayers: inner → outer, CUMULATIVE widths). */
  layers: HighlightStyle[];
  onTop: boolean;
}
/** Around the picture's shape — reads its distance field. */
export interface SpriteImageOutlineDraw extends SpriteOutlineDrawBase { mode: 'image'; field: SpriteSDFTexture }
/** Solid card — reads the sprite's own image (for its alpha) through the sprite's UV transform. */
export interface SpriteCardOutlineDraw extends SpriteOutlineDrawBase { mode: 'card'; texture: GPUTexture; uvTransform: [number, number, number, number] }
export type SpriteOutlineDraw = SpriteImageOutlineDraw | SpriteCardOutlineDraw;

/** What packSpriteOutlineParams needs (the draw minus its GPU objects). Pure — tested. */
export type SpriteOutlinePackInput =
  | (Omit<SpriteImageOutlineDraw, 'instanceIdx' | 'onTop' | 'field'> & { field: SpriteSDFTexture['info'] })
  | Omit<SpriteCardOutlineDraw, 'instanceIdx' | 'onTop' | 'texture'>;

/** Pack one sprite outline's uniform (pure — tested). */
export function packSpriteOutlineParams(d: SpriteOutlinePackInput, resX: number, resY: number, time: number): Float32Array {
  const a = new Float32Array(SPRITE_PARAMS_FLOATS);
  let outer: number[], grow: number, upt = 0;
  const maxWobble = (n: number) => Math.min(1, Math.max(0, ...d.layers.slice(0, n).map((l) => l.wobble ?? 0)));
  if (d.mode === 'image') {
    const f = d.field;
    // Model units per field texel (the image spans width × height units over imageW × imageH texels; averaged for a
    // sprite stretched off its image's aspect).
    upt = 0.5 * (d.width / f.imageW + d.height / f.imageH);
    const maxUnits = 0.98 * f.pad * upt;             // the field's padding in model units (distances saturate past it)
    outer = spriteLayerOuterWidths(d.layers.map((l) => l.width), maxUnits);
    // Grow the quad to the widest ring, with room for line boil to push it out (wobble ≤ 1 → up to 2×), within the pad.
    grow = Math.min(f.pad * upt, Math.max(0, ...outer) * (1 + maxWobble(outer.length)));
    a.set([f.imageW, f.imageH, f.pad, f.maxDist], 4);
    a.set([0, 0, 0, 0, 1, 1, 0, 0], 12);
  } else {
    // Card: distances are analytic (to the quad's rectangle) — no field, no padding limit.
    outer = spriteLayerOuterWidths(d.layers.map((l) => l.width), Infinity);
    grow = Math.max(0, ...outer) * (1 + maxWobble(outer.length));
    a.set([1, 0, 0, 0], 12);
    a.set(d.uvTransform, 16);
  }
  a.set([d.width / 2, d.height / 2, grow, upt], 0);
  a.set([resX, resY, time, outer.length], 8);
  for (let i = 0; i < outer.length; i++) {
    const s = d.layers[i], o = HEADER_FLOATS + i * 16, c = s.color, pc = s.patternColor;
    a.set([c[0], c[1], c[2], c[3], pc[0], pc[1], pc[2], s.glow, outer[i], s.patternMode, s.freq, s.speed,
           s.wobble ?? 0, s.wobbleFreq ?? 10, s.boilFps ?? 10, 0], o);
  }
  return a;
}

export class SpriteOutlinePass {
  private readonly _bgl: GPUBindGroupLayout;
  private readonly _pipe: PipelineHandle<GPURenderPipeline>;        // P2: non-blocking cache handles
  private readonly _pipeOnTop: PipelineHandle<GPURenderPipeline>;
  /** The distance field: clamped (past the field's edge the shader adds the straight distance itself). */
  private readonly _fieldSampler: GPUSampler;
  /** The sprite's own image (card mode): repeat, so a tiled sprite's alpha reads the way the sprite draws it. */
  private readonly _imageSampler: GPUSampler;
  private readonly _bufs: GPUBuffer[] = [];
  /** Bind group per pool slot, rebuilt only when that slot's texture view changes. */
  private readonly _bgs: { view: GPUTextureView; bg: GPUBindGroup }[] = [];
  /** A stable plain-2D view per sprite image (card mode) — so the bind group isn't rebuilt every frame. */
  private readonly _imageViews = new WeakMap<GPUTexture, GPUTextureView>();

  constructor(private readonly device: GPUDevice, meshBGL: GPUBindGroupLayout, format: GPUTextureFormat) {
    this._bgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [meshBGL, this._bgl] });
    const module = device.createShaderModule({ code: SPRITE_OUTLINE_SHADER });
    const mk = (depthCompare: GPUCompareFunction, depthWriteEnabled: boolean) => GPUPipelineCache.for(device).render({
      label: `SpriteOutline-${depthCompare}`,
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },   // a sprite can be seen from behind
      depthStencil: {
        format: 'depth24plus-stencil8', depthWriteEnabled, depthCompare,
        depthBias: -4, depthBiasSlopeScale: -1,                      // pull toward the camera: no z-fight with the sprite
        // stencil untouched (compare always / keep) — the hull outlines' stencil steps never see this pass
      },
    });
    this._pipe = mk('less-equal', true);
    this._pipeOnTop = mk('always', false);
    this._fieldSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this._imageSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  }

  private _imageView(tex: GPUTexture): GPUTextureView {
    let v = this._imageViews.get(tex);
    if (!v) { v = tex.createView({ dimension: '2d' }); this._imageViews.set(tex, v); }
    return v;
  }

  /** Write every draw's params (call while recording, before submit) and draw them. */
  draw(pass: GPURenderPassEncoder, meshBindGroup: GPUBindGroup, draws: SpriteOutlineDraw[], resX: number, resY: number, time: number): void {
    const d = this.device;
    for (let i = 0; i < draws.length; i++) {
      const dr = draws[i];
      if (!this._bufs[i]) this._bufs[i] = d.createBuffer({ size: SPRITE_PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const packIn: SpriteOutlinePackInput = dr.mode === 'image' ? { ...dr, field: dr.field.info } : dr;
      d.queue.writeBuffer(this._bufs[i], 0, packSpriteOutlineParams(packIn, resX, resY, time));
      const view = dr.mode === 'image' ? dr.field.view : this._imageView(dr.texture);
      let slot = this._bgs[i];
      if (!slot || slot.view !== view) {
        slot = this._bgs[i] = { view, bg: d.createBindGroup({ layout: this._bgl, entries: [
          { binding: 0, resource: { buffer: this._bufs[i] } },
          { binding: 1, resource: view },
          { binding: 2, resource: dr.mode === 'image' ? this._fieldSampler : this._imageSampler },
        ] }) };
      }
      const sp = (dr.onTop ? this._pipeOnTop : this._pipe).get();
      if (!sp) continue;   // P2: still compiling → this outline appears a frame later
      pass.setPipeline(sp);
      pass.setBindGroup(0, meshBindGroup);
      pass.setBindGroup(1, slot.bg);
      pass.draw(6, 1, 0, dr.instanceIdx);
    }
  }

  destroy(): void { for (const b of this._bufs) b.destroy(); this._bufs.length = 0; this._bgs.length = 0; }
}
