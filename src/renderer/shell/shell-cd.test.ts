/**
 * shell-cd: the FrogCart CD's pose + uniforms (shared by the Shell tiles / hero and the export preview), and the
 * export preview's lifecycle (createCartDiscPreview) on a fake GPU device.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mat4 } from 'gl-matrix';
import { cdIdlePose, cdPoseModel, writeCDUniforms, CD_FACE_MODE, CD_SHADER, SHELL_3D_UNIFORM_SIZE, CD_TILE_SCALE, CD_BLUR_INDEX } from './shell-cd';
import { LAUNCH_PREVIEW_SPIN_MS } from './shell-launch-pose';
import { LAUNCH } from './shell-launch';
import { createCartDiscPreview } from './cart-disc-preview';
import { CartridgeViewer } from './shell-cartridge';
import { cartDiscPattern } from '../3d/cd-disc/cart-disc-pattern';
import { cdDiscArtUVRect } from '../3d/cd-disc/cd-disc-art';

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['GPUTextureUsage', 'GPUBufferUsage', 'GPUShaderStage']) saved[k] = g[k];
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16, COPY_SRC: 1 };
  g.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8, VERTEX: 32, INDEX: 16 };
  g.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
});
afterAll(() => { for (const k of Object.keys(saved)) g[k] = saved[k]; });

describe('CD pose', () => {
  it('cdIdlePose + cdPoseModel = the tile CD matrix drawCD always built (whirl, -26 deg tilt, bob, x1.75)', () => {
    for (const [t, slot] of [[0, 0], [3.3, 2], [10.25, 5]] as const) {
      const phase = slot * 1.7;
      const old = mat4.create();
      mat4.translate(old, old, [0, Math.sin(t * 1.1 + phase) * 0.06, 0]);
      mat4.rotateX(old, old, -26 * Math.PI / 180);
      mat4.rotateY(old, old, t * 0.55 + phase);
      mat4.scale(old, old, [1.75, 1.75, 1.75]);
      const m = cdPoseModel(mat4.create(), cdIdlePose(t, phase));
      for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(old[i], 6);
    }
    expect(cdIdlePose(0).scale).toBe(CD_TILE_SCALE);
  });

  it('roll spins the disc about its own axis (the launch hook): the axis direction does not change', () => {
    const base = { x: 0, y: 0, tilt: -0.4, spin: 0.7, roll: 0, scale: 1 };
    const a = cdPoseModel(mat4.create(), base), b = cdPoseModel(mat4.create(), { ...base, roll: 1.3 });
    for (let i = 8; i < 11; i++) expect(b[i]).toBeCloseTo(a[i], 6);   // column 2 = the disc normal
    expect(b[0]).not.toBeCloseTo(a[0], 3);
  });
});

describe('CD uniforms', () => {
  const mvp = mat4.create(), model = mat4.create();
  it('art face: mode 1 + the texture rect; pattern words zero', () => {
    const u = new Float32Array(SHELL_3D_UNIFORM_SIZE / 4).fill(7);
    writeCDUniforms(u, mvp, model, { art: { u0: 0.25, v0: 0.5, u1: 0.5, v1: 0.75 }, pattern: { seed: 3 } });
    expect(u[43]).toBe(CD_FACE_MODE.art);
    expect([u[44], u[45], u[46], u[47]]).toEqual([0.25, 0.5, 0.5, 0.75]);
    expect(u[32]).toBe(0); expect(u[48]).toBe(0);
  });
  it('pattern face: mode 2 + the seeded words; null face: the bare disc', () => {
    const u = new Float32Array(SHELL_3D_UNIFORM_SIZE / 4);
    writeCDUniforms(u, mvp, model, { art: null, pattern: { seed: 9 } });
    expect(u[43]).toBe(CD_FACE_MODE.pattern);
    expect(u[39]).toBe(cartDiscPattern(9).cells);
    writeCDUniforms(u, mvp, model, null);
    expect(u[43]).toBe(CD_FACE_MODE.holo);
    expect(u[39]).toBe(0);
    expect([u[44], u[45], u[46], u[47]]).toEqual([0, 0, 1, 1]);
  });
  it('the shader: shared surface + print, textureSample and the pattern evaluated in uniform control flow', () => {
    expect(CD_SHADER.includes('`')).toBe(false);
    expect(CD_SHADER).toMatch(/cd_disc_surface\(n, L, viewDir, r, uu\)/);
    const fs = CD_SHADER.slice(CD_SHADER.indexOf('fn fs('));
    expect(fs.indexOf('textureSample(')).toBeLessThan(fs.indexOf('if (in.isFront'));
    expect(fs.indexOf('cart_disc_pattern(')).toBeLessThan(fs.indexOf('if (in.isFront'));
  });
});

/** A fake device that records what it made / destroyed. */
function fakeGpu() {
  const made: { kind: string; destroyed: boolean; label?: string }[] = [];
  const res = (kind: string, extra: Record<string, unknown> = {}) => {
    const r = { kind, destroyed: false, ...extra, destroy() { r.destroyed = true; } } as { kind: string; destroyed: boolean; destroy(): void; [k: string]: unknown };
    made.push(r); return r;
  };
  const writes: number[] = [];
  const uploads: Float32Array[] = [];
  let submits = 0;
  const device = {
    createBindGroupLayout: () => res('bgl'), createPipelineLayout: () => res('layout'), createSampler: () => res('sampler'),
    createShaderModule: () => res('module'), createRenderPipeline: () => res('pipeline'),
    createBuffer: (d: { label?: string }) => res('buffer', { label: d.label }),
    createTexture: (d: { label?: string }) => res('texture', { label: d.label, createView: () => ({}) }),
    createBindGroup: () => res('bindGroup'),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {} }),
      finish: () => ({}),
    }),
    queue: { writeBuffer: (_b: unknown, _o: number, d: Float32Array) => { writes.push(d.length); uploads.push(Float32Array.from(d)); }, writeTexture() {}, submit() { submits++; }, copyExternalImageToTexture() {} },
  } as unknown as GPUDevice;
  const ctxState = { configured: 0, unconfigured: 0 };
  const canvas = {
    width: 64, height: 64,
    getContext: () => ({ configure() { ctxState.configured++; }, unconfigure() { ctxState.unconfigured++; }, getCurrentTexture: () => ({ createView: () => ({}) }) }),
  } as unknown as HTMLCanvasElement;
  return { device, canvas, made, ctxState, writes, uploads, get submits() { return submits; } };
}

describe('createCartDiscPreview (lifecycle)', () => {
  it('draws on its own canvas, updates on pattern / fit / pose, and frees everything on dispose', async () => {
    const f = fakeGpu();
    const p = createCartDiscPreview(f.device, f.canvas, { pattern: { seed: 4 }, autoStart: false, format: 'rgba8unorm' });
    expect(f.ctxState.configured).toBe(1);
    expect(p.running).toBe(false);
    p.renderFrame(1);
    expect(p.frames).toBe(1);
    expect(f.submits).toBe(1);
    p.setPattern(99, 'dots');   // not running → redraws at once
    p.setFit({ zoom: 2 });
    expect(p.frames).toBe(3);
    p.setPose({ x: 0, y: 0, tilt: 0, spin: 0, roll: 1, scale: 1.75 });
    p.renderFrame();
    expect(p.frames).toBe(4);
    expect(p.hasArt).toBe(false);
    expect(await p.setArt(null)).toBe(true);     // back to the pattern: redraws
    expect(p.frames).toBe(5);
    p.dispose();
    expect(p.disposed).toBe(true);
    expect(f.ctxState.unconfigured).toBe(1);
    const own = f.made.filter(m => m.kind === 'buffer' || (m.kind === 'texture'));
    expect(own.length).toBeGreaterThan(0);
    for (const m of own) expect(m.destroyed, m.label ?? m.kind).toBe(true);
    p.renderFrame();
    expect(p.frames).toBe(5);                      // nothing after dispose
    expect(await p.setArt(new Blob([]))).toBe(false);
    expect(() => p.dispose()).not.toThrow();       // twice is fine
  });

  it('start / stop drive a requestAnimationFrame loop; dispose cancels it', () => {
    const f = fakeGpu();
    const cbs: (() => void)[] = [];
    const prevRaf = g.requestAnimationFrame, prevCaf = g.cancelAnimationFrame;
    let cancelled = 0;
    g.requestAnimationFrame = (cb: () => void) => { cbs.push(cb); return cbs.length; };
    g.cancelAnimationFrame = () => { cancelled++; };
    try {
      const p = createCartDiscPreview(f.device, f.canvas, { format: 'rgba8unorm' });   // autoStart
      expect(p.running).toBe(true);
      cbs.shift()!();
      cbs.shift()!();
      expect(p.frames).toBe(2);
      p.dispose();
      expect(p.running).toBe(false);
      expect(cancelled).toBe(1);
      for (const cb of cbs.splice(0)) cb();          // a stale frame after dispose draws nothing
      expect(p.frames).toBe(2);
    } finally { g.requestAnimationFrame = prevRaf; g.cancelAnimationFrame = prevCaf; }
  });

  it('playLaunchPreview: the flick + spin-up (with blur), then back to idle — and stops on its own', () => {
    const f = fakeGpu();
    const p = createCartDiscPreview(f.device, f.canvas, { pattern: { seed: 4 }, autoStart: false, format: 'rgba8unorm' });
    expect(p.launchPreviewActive).toBe(false);
    p.playLaunchPreview({ reducedMotion: false });
    expect(p.launchPreviewActive).toBe(true);
    const last = () => f.uploads[f.uploads.length - 1];
    p.renderFrame(1.3);                                   // full spin
    expect(last()[CD_BLUR_INDEX]).toBeGreaterThan(0);
    p.renderFrame((LAUNCH_PREVIEW_SPIN_MS + 100) / 1000); // spinning down
    expect(p.launchPreviewActive).toBe(true);
    p.renderFrame((LAUNCH_PREVIEW_SPIN_MS + LAUNCH.spinDownMs + 50) / 1000);
    expect(p.launchPreviewActive).toBe(false);            // back at idle: the override is gone
    // the idle frame it lands on is the plain idle pose
    const t = 4;
    p.renderFrame(t);
    const m = cdPoseModel(mat4.create(), cdIdlePose(t, 0));
    for (let i = 0; i < 16; i++) expect(last()[16 + i]).toBeCloseTo(m[i], 5);
    expect(last()[CD_BLUR_INDEX]).toBe(0);
    p.playLaunchPreview();
    p.stopLaunchPreview();
    expect(p.launchPreviewActive).toBe(false);
    p.dispose();
  });

  it('the shader smears the print only for a blur arc (uniform branch, fixed taps)', () => {
    const u = new Float32Array(SHELL_3D_UNIFORM_SIZE / 4);
    writeCDUniforms(u, mat4.create(), mat4.create(), { art: null, pattern: { seed: 2 } }, 0.3);
    expect(u[CD_BLUR_INDEX]).toBeCloseTo(0.3);
    writeCDUniforms(u, mat4.create(), mat4.create(), { art: { u0: 0, v0: 0, u1: 1, v1: 1 }, pattern: null }, 0.2);
    expect(u[CD_BLUR_INDEX]).toBeCloseTo(0.2);
    writeCDUniforms(u, mat4.create(), mat4.create(), null);
    expect(u[CD_BLUR_INDEX]).toBe(0);
    expect(CD_SHADER).toContain('let blurArc = u.patC.w;');
    expect(CD_SHADER).toContain('for (var i = 0; i < 7; i = i + 1)');
    // the blur branch reads a uniform → textureSample / derivatives inside stay in uniform control flow
    expect(CD_SHADER.indexOf('if (blurArc > 0.0005)')).toBeLessThan(CD_SHADER.indexOf('if (in.isFront'));
  });

  it('the art crop the preview samples is the export crop (cdDiscArtUVRect)', () => {
    expect(cdDiscArtUVRect(800, 400, { zoom: 2, panX: 1 })).toEqual({ u0: 0.75, v0: 0.25, u1: 1, v1: 0.75 });
  });
});

describe('CartridgeViewer.cdViewerIdlePose', () => {
  it('is exactly the transform the viewer always drew for a CD (whirl + appear spin, -24 deg, bob, x1.2 pop-in)', () => {
    for (const swayOnly of [false, true]) {
      const v = Object.assign(Object.create(CartridgeViewer.prototype), { appearKey: '#cd', appearStart: 3 }) as InstanceType<typeof CartridgeViewer>;
      for (const t of [3, 3.1, 3.4, 9.75]) {
        const spec = { kind: 'cd', bodyColor: [0, 0, 0, 1], labelColor: [0, 0, 0, 1], swayOnly, scale: 1.1 } as never;
        const age = t - 3, gt = Math.min(age / 0.3, 1), c1 = 1.70158, c3 = c1 + 1;
        const grow = 1 + c3 * Math.pow(gt - 1, 3) + c1 * Math.pow(gt - 1, 2);
        const spin = swayOnly ? Math.sin(t * 0.5) * 0.5236 : (t % 12) / 12 * Math.PI * 2 + 1.3 * Math.PI * 2 * (1 - Math.exp(-age / 0.4));
        const old = mat4.create();
        mat4.translate(old, old, [0, Math.sin(t * Math.PI) * 0.12, 0]);
        mat4.rotateX(old, old, -24 * Math.PI / 180);
        mat4.rotateY(old, old, spin);
        const s = 1.2 * grow * 1.1;
        mat4.scale(old, old, [s, s, s]);
        const m = cdPoseModel(mat4.create(), v.cdViewerIdlePose(spec, t, { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 }));
        for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(old[i], 6);
      }
    }
  });

  it('a spec the viewer is not showing yet counts as just appeared (the launch starts from its pop-in)', () => {
    const v = Object.assign(Object.create(CartridgeViewer.prototype), { appearKey: '__hero__', appearStart: 0 }) as InstanceType<typeof CartridgeViewer>;
    const p = v.cdViewerIdlePose({ kind: 'cd', bodyColor: [0, 0, 0, 1], labelColor: [0, 0, 0, 1] } as never, 50, { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 });
    expect(p.scale).toBeCloseTo(0);
  });
});
