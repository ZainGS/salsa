/**
 * E6 (docs/reviews/playback-perf-2026-10-09.md): FXAA covers only the screen box of what the frame drew in 3D (plus a
 * pad), so the 2D art around a few meshes keeps its exact pixels (dither patterns are no longer softened). Content the
 * box can't bound (skinned characters, particles, billboards, array instances, a mesh crossing the camera plane, very
 * many meshes, editor overlays, the 3D backdrop) falls back to the whole frame — the old behaviour.
 * Real Renderer3D.drawMeshes over a stub device + the real FxaaPass uniform.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import { packFxaaRect, packFxaaParams, FXAA_FS, FxaaPass } from './fxaa-pass';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function stubDevice() {
  const writes: { buf: unknown; data: Float32Array | null }[] = [];
  const handler: ProxyHandler<() => unknown> = {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'size') return 1 << 30;
      return stub;
    },
    apply() { return stub; },
  };
  const stub: unknown = new Proxy(function () { /* stub */ }, handler);
  const queue = new Proxy({}, { get: (_t, k) => {
    if (k === 'writeBuffer') return (buf: unknown, _o: number, data: ArrayBufferView) => { writes.push({ buf, data: data instanceof Float32Array ? data.slice() : null }); };
    return stub;
  } });
  const device = new Proxy({}, { get: (_t, k) => {
    if (k === 'queue') return queue;
    if (k === 'features') return { has: () => false };
    if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
    if (k === 'createBuffer') return (d: { size: number }) => ({ size: d.size, destroy() { /* */ }, label: '', mapAsync: () => new Promise(() => { /* */ }) });
    if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
    return stub;
  } });
  return { device: device as unknown as GPUDevice, writes };
}
const pass = new Proxy({}, { get: () => () => undefined }) as unknown as GPURenderPassEncoder;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function scene() {
  const { Renderer3D } = await import('./renderer-3d');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const dev = stubDevice();
  const cam = new Camera3D({ position: [0, 0, 10], target: [0, 0, 0] });
  const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
  const box = (x: number, y: number, z: number) => new Mesh3D(isvc, x, y, z, { primitive: 'box' } as never);
  return { r, cam, box, R3: Renderer3D as unknown as { AA_RECT_MAX_MESHES: number; AA_RECT_PAD_PX: number } };
}
const saved = { max: 256, pad: 16 };
afterEach(async () => { const { Renderer3D } = await import('./renderer-3d'); const R = Renderer3D as unknown as Record<string, number>; R.AA_RECT_MAX_MESHES = saved.max; R.AA_RECT_PAD_PX = saved.pad; });

describe('E6 FXAA region', () => {
  it('a small mesh in the middle: a padded box around its projection, not the frame; reset after reading', async () => {
    const { r, box } = await scene();
    const m = box(0, 0, 0);
    r.drawMeshes(pass, [m], 1000, 800);
    const rect = r._aaTakeRect(1000, 800) as number[] | null;
    expect(rect).not.toBeNull();
    const [x0, y0, x1, y1] = rect!;
    expect(x0).toBeGreaterThan(300); expect(x1).toBeLessThan(700);   // a 1-unit box at 10 units: ~a tenth of the width
    expect(y0).toBeGreaterThan(250); expect(y1).toBeLessThan(550);
    expect(x0).toBeLessThan(500); expect(x1).toBeGreaterThan(500);   // around the centre
    expect(r._aaTakeRect(1000, 800)).toBeNull();                      // consumed: the next frame starts empty (→ whole frame)
  });

  it('two meshes: the union; the grid / gizmo boxes grow it; an off-centre mesh moves it', async () => {
    const { r, box } = await scene();
    r.drawMeshes(pass, [box(-2, 0, 0), box(2, 1, 0)], 1000, 800);
    const [ax0, , ax1] = r._aaTakeRect(1000, 800) as number[];
    r.drawMeshes(pass, [box(-2, 0, 0)], 1000, 800);
    const [bx0, , bx1] = r._aaTakeRect(1000, 800) as number[];
    expect(ax0).toBeCloseTo(bx0, 0); expect(ax1).toBeGreaterThan(bx1 + 100);
  });

  it('falls back to the whole frame for what it cannot bound', async () => {
    const { r, box, R3 } = await scene();
    const cases: Array<() => void> = [
      () => { const m = box(0, 0, 0); m.billboard = true; r.drawMeshes(pass, [m], 1000, 800); },
      () => { const m = box(0, 0, 0); m.material.windSway = true; r.drawMeshes(pass, [m], 1000, 800); },
      () => { r.drawMeshes(pass, [box(0, 0, 0), box(0, 0, 12)], 1000, 800); },   // behind the camera plane
      () => { R3.AA_RECT_MAX_MESHES = 1; r.drawMeshes(pass, [box(0, 0, 0), box(1, 0, 0)], 1000, 800); R3.AA_RECT_MAX_MESHES = 256; },
      () => { r.drawMeshes(pass, [box(0, 0, 0)], 1000, 800); r.drawSkinnedMeshes(pass, [box(0, 0, 0)], 1000, 800); },
    ];
    for (const run of cases) { run(); expect(r._aaTakeRect(1000, 800)).toBeNull(); }
  });

  it('the FXAA pass gets the rect in its uniform (and the whole frame without one); outside it the shader copies', async () => {
    expect(Array.from(packFxaaRect(new Float32Array(12), 1000, 800, null).subarray(8))).toEqual([0, 0, 1000, 800]);
    expect(Array.from(packFxaaRect(new Float32Array(12), 1000, 800, [-5, 10, 2000, 300]).subarray(8))).toEqual([0, 10, 1000, 300]);
    expect(Array.from(packFxaaParams(new Float32Array(12), 1000, 800, 'medium').subarray(0, 2))).toEqual([Math.fround(0.001), Math.fround(1 / 800)]);
    // early-out to the centre sample outside the rect (the 2D art's exact pixels)
    expect(FXAA_FS).toMatch(/if \(fc\.x < P\.c\.x \|\| fc\.y < P\.c\.y \|\| fc\.x >= P\.c\.z \|\| fc\.y >= P\.c\.w\) \{ return cM; \}/);
    const dev = stubDevice();
    const fx = new FxaaPass(dev.device, 'bgra8unorm') as unknown as { _draw: (...a: unknown[]) => void };
    const enc = new Proxy({}, { get: () => () => new Proxy({}, { get: () => () => undefined }) }) as unknown as GPUCommandEncoder;
    const src = { createView: () => ({}) } as unknown as GPUTexture;
    fx._draw(enc, {}, src, 1000, 800, 'medium', {}, [100, 120, 300, 340]);
    fx._draw(enc, {}, src, 1000, 800, 'medium', {}, [100, 120, 300, 340]);   // unchanged → no re-upload
    fx._draw(enc, {}, src, 1000, 800, 'medium', {}, null);
    const ups = dev.writes.filter((w) => w.data && w.data.length === 12);
    expect(ups.length).toBe(2);
    expect(Array.from(ups[0].data!.subarray(8))).toEqual([100, 120, 300, 340]);
    expect(Array.from(ups[1].data!.subarray(8))).toEqual([0, 0, 1000, 800]);
  });
});
