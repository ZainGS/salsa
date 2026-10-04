/**
 * FXAA — post-process anti-aliasing for the 3D image (persona-polish-plan A1).
 *
 * WHY NOT MSAA: the 3D meshes draw into the SAME main render pass as the 2D content (webgpu-renderer render():
 * lastFrameTex + the interaction depth buffer). A multisampled target would need every 2D and 3D pipeline rebuilt at
 * sampleCount 4 (dozens of pipeline variants), a multisampled depth buffer, and a resolve before every pass that
 * READS depth or colour afterwards (SSR scene grab, outline Sobel, post-bg-keep, post overlays, the planar mirror).
 * A single fullscreen pass on the finished frame fixes the visible problem (stair-stepped wires, poles and roof
 * lines) at a fraction of that risk and cost.
 *
 * The shader is a port of the FXAA 3.11 "quality" edge walk: local-contrast early out, horizontal/vertical edge
 * pick, an end-of-edge search along the edge, and a sub-pixel blend for single-pixel features (wires). It runs
 * FIRST in the post chain (before bloom / grade / film) so film grain is never smeared and bloom sees clean edges.
 * Every fetch is textureSampleLevel, so the branches never break WGSL uniformity rules.
 */
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { PP_FULLSCREEN_VS } from './shaders/post-process-shaders';

export type AntiAliasingMode = 'off' | 'fxaa';
export type AntiAliasingQuality = 'low' | 'medium' | 'high';
export interface AntiAliasingSettings {
  /** 'fxaa' = post FXAA on the finished 3D frame; 'off' = none (the original look). */
  mode: AntiAliasingMode;
  /** Edge-search length + contrast threshold: low (5 steps, threshold 1/4), medium (8, 1/6), high (12, 1/8). */
  quality: AntiAliasingQuality;
}
export const DEFAULT_ANTI_ALIASING: AntiAliasingSettings = { mode: 'fxaa', quality: 'medium' };

/** Clean a host / saved value into valid settings (unknown values fall back to the defaults). */
export function sanitizeAntiAliasing(s: Partial<AntiAliasingSettings> | null | undefined): AntiAliasingSettings {
  const mode: AntiAliasingMode = s?.mode === 'off' || s?.mode === 'fxaa' ? s.mode : DEFAULT_ANTI_ALIASING.mode;
  const quality: AntiAliasingQuality = s?.quality === 'low' || s?.quality === 'medium' || s?.quality === 'high' ? s.quality : DEFAULT_ANTI_ALIASING.quality;
  return { mode, quality };
}

/** The FXAA uniform (vec4 + vec4): texel size, search steps, sub-pixel amount, contrast thresholds. Pure (tested). */
export function packFxaaParams(out: Float32Array, w: number, h: number, quality: AntiAliasingQuality): Float32Array {
  const q = quality === 'low' ? { steps: 5, thr: 0.25, thrMin: 0.0833, sub: 0.5 }
    : quality === 'high' ? { steps: 12, thr: 0.125, thrMin: 0.0312, sub: 0.75 }
    : { steps: 8, thr: 0.166, thrMin: 0.0625, sub: 0.75 };
  out[0] = 1 / Math.max(1, w); out[1] = 1 / Math.max(1, h); out[2] = q.steps; out[3] = q.sub;
  out[4] = q.thr; out[5] = q.thrMin; out[6] = 0; out[7] = 0;
  return out;
}

export const FXAA_FS = /* wgsl */`
@group(0) @binding(0) var src:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct FxaaParams { a: vec4f, b: vec4f };   // a = (1/w, 1/h, search steps, sub-pixel) · b = (threshold, threshold min, 0, 0)
@group(0) @binding(2) var<uniform> P: FxaaParams;

fn fx_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
fn fx_l(uv: vec2f) -> f32 { return fx_luma(textureSampleLevel(src, samp, uv, 0.0).rgb); }
fn fx_step(i: i32) -> f32 {
  // Search step growth (FXAA 3.11 quality ladder): 1 texel for the first steps, then 1.5, 2 ... 4, 8.
  if (i < 5) { return 1.0; }
  if (i == 5) { return 1.5; }
  if (i < 10) { return 2.0; }
  if (i == 10) { return 4.0; }
  return 8.0;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let rc = P.a.xy;
  let cM = textureSampleLevel(src, samp, uv, 0.0);
  let lM = fx_luma(cM.rgb);
  let lN = fx_l(uv + vec2f(0.0, -rc.y));
  let lS = fx_l(uv + vec2f(0.0, rc.y));
  let lE = fx_l(uv + vec2f(rc.x, 0.0));
  let lW = fx_l(uv + vec2f(-rc.x, 0.0));
  let lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  let lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  let range = lMax - lMin;
  if (range < max(P.b.y, lMax * P.b.x)) { return cM; }

  let lNW = fx_l(uv + vec2f(-rc.x, -rc.y));
  let lNE = fx_l(uv + vec2f(rc.x, -rc.y));
  let lSW = fx_l(uv + vec2f(-rc.x, rc.y));
  let lSE = fx_l(uv + vec2f(rc.x, rc.y));
  let lNS = lN + lS;
  let lWE = lW + lE;
  let lWC = lNW + lSW;
  let lEC = lNE + lSE;
  let lNC = lNW + lNE;
  let lSC = lSW + lSE;
  let edgeH = abs(-2.0 * lW + lWC) + abs(-2.0 * lM + lNS) * 2.0 + abs(-2.0 * lE + lEC);
  let edgeV = abs(-2.0 * lN + lNC) + abs(-2.0 * lM + lWE) * 2.0 + abs(-2.0 * lS + lSC);
  let horz = edgeH >= edgeV;

  let l1 = select(lW, lN, horz);
  let l2 = select(lE, lS, horz);
  let g1 = l1 - lM;
  let g2 = l2 - lM;
  let steep1 = abs(g1) >= abs(g2);
  let gScaled = 0.25 * max(abs(g1), abs(g2));
  var stepLen = select(rc.x, rc.y, horz);
  var lAvg = 0.5 * (l2 + lM);
  if (steep1) { stepLen = -stepLen; lAvg = 0.5 * (l1 + lM); }

  var cur = uv;
  if (horz) { cur.y += stepLen * 0.5; } else { cur.x += stepLen * 0.5; }
  let off = select(vec2f(0.0, rc.y), vec2f(rc.x, 0.0), horz);
  var uv1 = cur - off;
  var uv2 = cur + off;
  var e1 = fx_l(uv1) - lAvg;
  var e2 = fx_l(uv2) - lAvg;
  var r1 = abs(e1) >= gScaled;
  var r2 = abs(e2) >= gScaled;
  if (!r1) { uv1 -= off; }
  if (!r2) { uv2 += off; }
  let steps = i32(P.a.z);
  for (var i = 2; i < steps; i++) {
    if (r1 && r2) { break; }
    if (!r1) { e1 = fx_l(uv1) - lAvg; }
    if (!r2) { e2 = fx_l(uv2) - lAvg; }
    r1 = abs(e1) >= gScaled;
    r2 = abs(e2) >= gScaled;
    if (!r1) { uv1 -= off * fx_step(i); }
    if (!r2) { uv2 += off * fx_step(i); }
  }

  let d1 = select(uv.y - uv1.y, uv.x - uv1.x, horz);
  let d2 = select(uv2.y - uv.y, uv2.x - uv.x, horz);
  let dir1 = d1 < d2;
  let dMin = min(d1, d2);
  let thick = max(d1 + d2, 1e-6);
  let pixOff = -dMin / thick + 0.5;
  let centreSmaller = lM < lAvg;
  let goodVar = (select(e2, e1, dir1) < 0.0) != centreSmaller;
  var fin = select(0.0, pixOff, goodVar);

  // Sub-pixel blend: single-pixel features (overhead wires, thin poles) get smoothed instead of crawling.
  let lFull = (1.0 / 12.0) * (2.0 * (lNS + lWE) + lWC + lEC);
  let s1 = clamp(abs(lFull - lM) / range, 0.0, 1.0);
  let s2 = (-2.0 * s1 + 3.0) * s1 * s1;
  fin = max(fin, s2 * s2 * P.a.w);

  var fuv = uv;
  if (horz) { fuv.y += fin * stepLen; } else { fuv.x += fin * stepLen; }
  let outC = textureSampleLevel(src, samp, fuv, 0.0);
  return vec4f(outC.rgb, cM.a);
}
`;

/** One fullscreen FXAA pass: `src` → an owned output texture (same format), returned for the rest of the chain. */
export class FxaaPass {
  private readonly _pipeline: PipelineHandle<GPURenderPipeline>;   // P2: non-blocking cache handle
  private readonly _bgl: GPUBindGroupLayout;
  private readonly _sampler: GPUSampler;
  private readonly _buf: GPUBuffer;
  private readonly _params = new Float32Array(8);
  private _out: GPUTexture | null = null;
  private _bg: GPUBindGroup | null = null;
  private _bgSrc: GPUTexture | null = null;
  private _key = '';

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat) {
    this._bgl = device.createBindGroupLayout({ label: 'FXAABGL', entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this._buf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'FXAAParams' });
    this._pipeline = GPUPipelineCache.for(device).render({
      label: 'FXAA',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
      vertex: { module: device.createShaderModule({ code: PP_FULLSCREEN_VS, label: 'FXAAVS' }), entryPoint: 'vs_main' },
      fragment: { module: device.createShaderModule({ code: FXAA_FS, label: 'FXAAFS' }), entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    void this._pipeline.warm(PIPELINE_PRIORITY.DOCUMENT);
  }

  /** Returns the anti-aliased output — or `src` UNCHANGED while the FXAA pipeline is still compiling (P2). */
  run(encoder: GPUCommandEncoder, src: GPUTexture, w: number, h: number, quality: AntiAliasingQuality): GPUTexture {
    const pipeline = this._pipeline.get();
    if (!pipeline) return src;
    if (!this._out || this._out.width !== w || this._out.height !== h) {
      this._out?.destroy();
      this._out = this.device.createTexture({ size: [w, h], format: this.format, label: 'FXAAOut',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this._key = '';
    }
    const key = `${w}x${h}:${quality}`;
    if (key !== this._key) { this.device.queue.writeBuffer(this._buf, 0, packFxaaParams(this._params, w, h, quality)); this._key = key; }
    if (!this._bg || this._bgSrc !== src) {
      this._bg = this.device.createBindGroup({ layout: this._bgl, entries: [
        { binding: 0, resource: src.createView() }, { binding: 1, resource: this._sampler }, { binding: 2, resource: { buffer: this._buf } },
      ] });
      this._bgSrc = src;
    }
    const pass = encoder.beginRenderPass({ label: 'FXAAPass', colorAttachments: [{ view: this._out.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this._bg);
    pass.draw(3);
    pass.end();
    return this._out;
  }

  destroy(): void { this._out?.destroy(); this._out = null; this._buf.destroy(); }
}
