/**
 * Perf audit C2: the LAST pass of the post chain (FXAA, bloom composite or grade / vignette / film) renders straight
 * into the canvas texture view instead of its own output texture + a full-screen copy. Runs the REAL FxaaPass,
 * PostProcessPass and Renderer3D chain logic (_postChain / runPostProcessTo / postProcessMayRun / skipPostProcess) on a
 * mocked device that records every render pass's label and colour target.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';

const gg = globalThis as Record<string, unknown>;
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
gg.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
gg.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
gg.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

type Tex = { label: string; width: number; height: number; format: string; createView(): { tex: Tex }; destroy(): void };
type View = { tex: Tex };

/** A device with synchronous pipeline creation (no *Async API → the pipeline cache compiles on first get()). */
function mockDevice() {
  const passes: string[] = [];
  const tex = (label: string, w = 8, h = 4, format = 'bgra8unorm'): Tex => {
    const t: Tex = { label, width: w, height: h, format, createView: () => ({ tex: t }), destroy() { /* */ } };
    return t;
  };
  const obj = () => ({});
  const device = {
    createTexture: (d: { size: number[]; label?: string; format: string }) => tex(d.label ?? 'tex', d.size[0], d.size[1], d.format),
    createBuffer: (d: { size: number; label?: string }) => ({ size: d.size, label: d.label, destroy() { /* */ } }),
    createBindGroupLayout: obj, createBindGroup: obj, createSampler: obj, createPipelineLayout: obj, createShaderModule: obj,
    createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
    queue: { writeBuffer: () => undefined, submit: () => undefined },
  };
  const encoder = {
    beginRenderPass: (d: { label?: string; colorAttachments: { view: View }[] }) => {
      passes.push(`${d.label}>${d.colorAttachments[0].view.tex.label}`);
      return { setPipeline: () => undefined, setBindGroup: () => undefined, draw: () => undefined, end: () => undefined };
    },
  };
  return { device: device as unknown as GPUDevice, encoder: encoder as unknown as GPUCommandEncoder, passes, tex };
}

let Renderer3DProto: object;
let PostProcessPassCls: new (d: GPUDevice, f: GPUTextureFormat) => { config: { bloom: { enabled: boolean }; colorGrade: { enabled: boolean }; vignette: { enabled: boolean }; film: { enabled: boolean } } };
beforeAll(async () => {
  Renderer3DProto = (await import('./renderer-3d')).Renderer3D.prototype;
  PostProcessPassCls = (await import('./post-process-pass')).PostProcessPass as unknown as typeof PostProcessPassCls;
});

/** The chain fields of a Renderer3D (no full constructor: only what _postChain and its gates read). */
function chainHost(opts: { fxaa: boolean; bloom?: boolean; grade?: boolean; film?: boolean; loRes?: 'static' | 'dynamic' | null }) {
  const m = mockDevice();
  const pp = new PostProcessPassCls(m.device, 'bgra8unorm');
  pp.config.bloom.enabled = !!opts.bloom;
  pp.config.colorGrade.enabled = !!opts.grade;
  pp.config.film.enabled = !!opts.film;
  const r = Object.assign(Object.create(Renderer3DProto), {
    device: m.device, _swapChainFormat: 'bgra8unorm', _drew3DThisFrame: false, _taaOn: false, _taa: null, _taaBypassFxaa: false,
    _aa: { mode: opts.fxaa ? 'fxaa' : 'off', quality: 'medium' }, _fxaaPass: null, _postProcessPass: pp,
    _worldTimeAccMs: 0, _worldTimeLast: 0, _worldSpeed: 1,
    getLoResSize: () => (opts.loRes ? [4, 2] : null), loResIsDynamic: () => opts.loRes === 'dynamic',
  }) as Record<string, any>;
  const src = m.tex('lastFrame');
  const canvas = m.tex('canvas');
  return { r, m, src, canvasView: canvas.createView() as unknown as GPUTextureView, srcTex: src as unknown as GPUTexture };
}

describe('post chain: the last pass renders into the canvas view (C2)', () => {
  it('FXAA only (the default): FXAA draws straight into the canvas, no FXAAOut', () => {
    const { r, m, srcTex, canvasView } = chainHost({ fxaa: true });
    r._drew3DThisFrame = true;
    expect(r.runPostProcessTo(m.encoder, srcTex, 8, 4, canvasView)).toBe('target');
    expect(m.passes).toEqual(['FXAAPass>canvas']);
    expect(r._drew3DThisFrame).toBe(false);   // consumed, as runPostProcess
  });

  it('FXAA + grade: FXAA into FXAAOut, the grade pass into the canvas', () => {
    const { r, m, srcTex, canvasView } = chainHost({ fxaa: true, grade: true });
    r._drew3DThisFrame = true;
    expect(r.runPostProcessTo(m.encoder, srcTex, 8, 4, canvasView)).toBe('target');
    expect(m.passes).toEqual(['FXAAPass>FXAAOut', 'PPGradeVigPass>canvas']);
  });

  it('bloom + film: extract / blurs / composite into the ping texture, the grade + film pass into the canvas', () => {
    const { r, m, srcTex, canvasView } = chainHost({ fxaa: false, bloom: true, film: true });
    expect(r.runPostProcessTo(m.encoder, srcTex, 8, 4, canvasView)).toBe('target');
    expect(m.passes).toEqual(['PPBloomExtractPass>PPBloomExtract', 'PPBlurPass>PPBloomBlur', 'PPBlurPass>PPBloomExtract',
      'PPBloomCompositePass>PPPing', 'PPGradeVigPass>canvas']);
  });

  it('bloom only: the composite is the last pass → into the canvas', () => {
    const { r, m, srcTex, canvasView } = chainHost({ fxaa: true, bloom: true });   // FXAA on but no 3D drawn this frame
    expect(r.runPostProcessTo(m.encoder, srcTex, 8, 4, canvasView)).toBe('target');
    expect(m.passes.at(-1)).toBe('PPBloomCompositePass>canvas');
    expect(m.passes.some((p) => p.startsWith('FXAA'))).toBe(false);
  });

  it('nothing on (or the PS1 lo-res look, which skips FXAA): null, nothing drawn — the caller copies lastFrameTex', () => {
    const off = chainHost({ fxaa: false });
    off.r._drew3DThisFrame = true;
    expect(off.r.runPostProcessTo(off.m.encoder, off.srcTex, 8, 4, off.canvasView)).toBeNull();
    const ps1 = chainHost({ fxaa: true, loRes: 'static' });
    ps1.r._drew3DThisFrame = true;
    expect(ps1.r.runPostProcessTo(ps1.m.encoder, ps1.srcTex, 8, 4, ps1.canvasView)).toBeNull();
    expect([...off.m.passes, ...ps1.m.passes]).toEqual([]);
  });

  it('runPostProcess (no target) keeps the old shape: the output texture, the same passes into owned textures', () => {
    const { r, m, srcTex } = chainHost({ fxaa: true, grade: true });
    r._drew3DThisFrame = true;
    const out = r.runPostProcess(m.encoder, srcTex, 8, 4) as Tex;
    expect(out.label).toBe('PPPing');
    expect(m.passes).toEqual(['FXAAPass>FXAAOut', 'PPGradeVigPass>PPPing']);
  });

  it('postProcessMayRun (asked before the frame) is a superset of what runs; skipPostProcess reports a misprediction', () => {
    const fx = chainHost({ fxaa: true });
    expect(fx.r.postProcessMayRun(8, 4, false)).toBe(false);   // no 3D can be drawn → FXAA cannot run
    expect(fx.r.postProcessMayRun(8, 4, true)).toBe(true);
    expect(fx.r.skipPostProcess(8, 4)).toBe(false);            // nothing drew 3D → nothing would have run
    fx.r._drew3DThisFrame = true;
    expect(fx.r.skipPostProcess(8, 4)).toBe(true);             // 3D drew after all → the caller re-renders offscreen
    expect(fx.r._drew3DThisFrame).toBe(false);
    const ps1 = chainHost({ fxaa: true, loRes: 'static' });
    expect(ps1.r.postProcessMayRun(8, 4, true)).toBe(false);   // the PS1 look keeps its chunky pixels
    expect(chainHost({ fxaa: true, loRes: 'dynamic' }).r.postProcessMayRun(8, 4, true)).toBe(true);
    expect(chainHost({ fxaa: false, grade: true }).r.postProcessMayRun(8, 4, false)).toBe(true);   // grade applies to 2D too
    expect(fx.m.passes).toEqual([]);
  });
});
