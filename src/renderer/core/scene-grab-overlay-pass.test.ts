/**
 * Perf audit 2026-10-09 B1 + B2: the scene-colour grab copy and the separate OverlayPass only run while something
 * samples the grab (SSR, glass refraction, the UI modal world blur). Otherwise the overlays draw at the END of the main
 * pass (same order) and no grab is copied — or even allocated. Drives the REAL WebGPURenderer.render() on a minimal
 * host with a mocked device that records render passes, texture copies and submits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';

const gg = globalThis as Record<string, unknown>;
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
gg.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
gg.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };

type Tex = { id: string; width: number; height: number; destroyed: boolean; destroy(): void; createView(): object; format: string };
type Frame = { passes: string[]; copies: string[]; submits: number; log: string[] };

let WebGPURendererCls: { prototype: object };
beforeAll(async () => { WebGPURendererCls = (await import('./webgpu-renderer')).WebGPURenderer as unknown as { prototype: object }; });

/** A no-op GPURenderPassEncoder that logs its label on end(). */
function fakePass(label: string, frame: Frame): object {
  return new Proxy({}, { get: (_t, k) => (k === 'label' ? label : k === 'end' ? () => frame.log.push(`end:${label}`) : () => undefined) });
}

function makeHost(opts: { scene3D: boolean }) {
  let texN = 0;
  const frame: Frame = { passes: [], copies: [], submits: 0, log: [] };
  const name = (t: Tex) => (t === host.lastFrameTex ? 'lastFrame' : t === host.sceneColorGrabTex ? 'grab' : t.id);
  const createTexture = (d: { size: number[]; label?: string; format: string }): Tex => ({
    id: d.label ?? `tex${texN++}`, width: d.size[0], height: d.size[1], destroyed: false, format: d.format,
    destroy() { this.destroyed = true; }, createView() { return { tex: this }; },
  });
  const backTex = createTexture({ size: [64, 32], label: 'backTex', format: 'bgra8unorm' });
  const device = {
    createTexture,
    createCommandEncoder: (d?: { label?: string }) => ({
      label: d?.label,
      beginRenderPass: (desc: { label?: string }) => { const l = desc.label ?? 'MainPass'; frame.passes.push(l); return fakePass(l, frame); },
      copyTextureToTexture: (s: { texture: Tex }, t: { texture: Tex }) => { const c = `${name(s.texture)}->${name(t.texture)}`; frame.copies.push(c); frame.log.push(`copy:${c}${d?.label ? `@${d.label}` : ''}`); },
      finish: () => ({}),
    }),
    queue: { submit: () => { frame.submits++; frame.log.push('submit'); }, writeBuffer: () => undefined },
  };
  const r3d = {
    ssrEnabled: false, glassRefraction: false, particleBloomPending: false, lodViewHeight: 0, grabSet: [] as unknown[],
    setSceneColorGrabTexture(t: unknown) { this.grabSet.push(t); },
    focusBgCoversCanvas: () => false, getLoResSize: () => null, drawArmatureBg: () => undefined, meshEditHidesContent: () => false,
    runPostProcess: () => null, hasPostOverlays: () => false, noteCullCpuMs: () => undefined,
  };
  let scheduled = 0;
  const host: Record<string, any> = Object.assign(Object.create(WebGPURendererCls.prototype), {
    device, context: { getCurrentTexture: () => backTex }, canvas: { width: 64, height: 32 }, swapChainFormat: 'bgra8unorm',
    _deviceLost: false, preRenderCallbacks: [], _contextAlpha: 'premultiplied', _captureMode: null, renderMode: 'vector',
    backgroundColor: new Float32Array(4), canvasBackgroundColor: new Float32Array(4),
    interactionService: { depthTextureView: {}, boxSelectPreview: null, rectDrawCallback: null },
    renderList: [], _visibleNodesScratch: [], _aboveRasterScratch: [], _hiddenVectorLayerIds: new Set(),
    webGPURenderStrategy: { beginFrame: () => undefined, uploadDrawCommands: () => undefined, uploadDrawCounts: () => undefined, getTexturedCount: () => 0 },
    stagingBuffer: { beginStagingPass: () => undefined },
    pipelineManager: { getStagingLinePipeline: () => ({}), getStagingHighlightPipeline: () => ({}) },
    postRasterCompositeCallbacks: [], _realShotWaiters: [], cacheService: { getSdfAtlas: () => ({ version: 0 }) }, cachedAtlasVersion: 0,
    _scene3dVisible: opts.scene3D, _renderer3D: r3d, _uiScrimProvider: null as null | (() => unknown),
    // stubs for everything render() calls that is not under test
    getArtboardScissor: () => null, renderArtboardPattern: () => frame.log.push('artboard'),
    handleAtlasCompactIfNeeded: () => undefined, handleAtlasChangeIfNeeded: () => undefined, rebuildRenderListIfNeeded: () => undefined,
    getRenderer3D: () => r3d, _applyResolutionScale: () => undefined,
    draw3DMeshes: (_p: unknown, _n: unknown, _w: number, _h: number, defer: boolean) => { frame.log.push('meshes'); if (defer) host._overlays3DPending = true; },
    draw3DParticles: () => frame.log.push('particles'), draw3DGp: () => frame.log.push('gp'),
    renderUIScrim: () => frame.log.push('scrim'), drawVectorShapes: () => frame.log.push('vector'), renderStagingShapes: () => undefined,
    driveLiveTextHtml: () => undefined, drawLiveTextNodes: () => frame.log.push('liveText'),
    _drawOverlaySet: (pass: { label: string }) => { frame.log.push(`overlays@${pass.label}${host._overlays3DPending ? '+3D' : ''}`); host._overlays3DPending = false; },
    prepareUIWorldBlur: () => frame.log.push('uiBlur'),
    notifyFrameSubmitted: () => undefined, _temporalSettle: () => undefined,
    scheduleRender: () => { scheduled++; },
  });
  const render = async () => {
    frame.passes = []; frame.copies = []; frame.submits = 0; frame.log = [];
    const before = scheduled;
    await (host.render as () => Promise<void>)();
    return { ...frame, passes: [...frame.passes], copies: [...frame.copies], log: [...frame.log], scheduled: scheduled - before };
  };
  return { host, r3d, render };
}

describe('scene-colour grab + overlay pass only while a reader is on (B1 + B2)', () => {
  it('a pure 2D frame: one render pass, no grab copy (no grab texture at all), overlays last in the main pass', async () => {
    const { host, render } = makeHost({ scene3D: false });
    for (let i = 0; i < 3; i++) {
      const f = await render();
      expect(f.passes).toEqual(['MainPass']);
      expect(f.copies).toEqual(['lastFrame->backTex']);   // only the present copy
      expect(f.log.indexOf('overlays@MainPass')).toBeGreaterThan(f.log.indexOf('liveText'));
      expect(f.log.indexOf('overlays@MainPass')).toBeLessThan(f.log.indexOf('end:MainPass'));
      expect(f.scheduled).toBe(0);
    }
    expect(host.sceneColorGrabTex).toBeUndefined();
  });

  it('a 3D frame without SSR / glass / modal blur: no grab, no OverlayPass; the 3D overlays still draw after all content', async () => {
    const { host, render } = makeHost({ scene3D: true });
    const f = await render();
    expect(f.passes).toEqual(['MainPass']);
    expect(f.copies).toEqual(['lastFrame->backTex']);
    const ov = f.log.indexOf('overlays@MainPass+3D');
    expect(ov).toBeGreaterThan(f.log.indexOf('meshes'));
    expect(ov).toBeGreaterThan(f.log.indexOf('particles'));
    expect(ov).toBeGreaterThan(f.log.indexOf('gp'));
    expect(ov).toBeGreaterThan(f.log.indexOf('vector'));
    expect(ov).toBeGreaterThan(f.log.indexOf('liveText'));
    expect(host.sceneColorGrabTex).toBeUndefined();
  });

  it('SSR on: the grab is copied (scene only) and the overlays get their OverlayPass, as before', async () => {
    const { host, r3d, render } = makeHost({ scene3D: true });
    await render();                       // a live frame without readers (lastFrameTex now holds it)
    r3d.ssrEnabled = true;
    const on = await render();            // reader turns on
    // the stale grab is refreshed from the previous frame FIRST (own encoder + submit), then the frame as before
    expect(on.log.slice(0, 2)).toEqual(['copy:lastFrame->grab@SceneGrabRefresh', 'submit']);
    expect(on.passes).toEqual(['MainPass', 'OverlayPass']);
    expect(on.copies).toEqual(['lastFrame->grab', 'lastFrame->grab', 'lastFrame->backTex']);
    expect(on.log.indexOf('copy:lastFrame->grab', 2)).toBeLessThan(on.log.indexOf('overlays@OverlayPass+3D'));   // grab before overlays
    expect(on.log.indexOf('copy:lastFrame->grab', 2)).toBeGreaterThan(on.log.indexOf('end:MainPass'));
    expect(on.scheduled).toBeGreaterThanOrEqual(1);   // the follow-up frame (rising edge + SSR settle)
    expect(r3d.grabSet.at(-1)).toBe(host.sceneColorGrabTex);
    const steady = await render();
    expect(steady.passes).toEqual(['MainPass', 'OverlayPass']);
    expect(steady.copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);   // no refresh once fresh
    r3d.ssrEnabled = false;
    const off = await render();
    expect(off.passes).toEqual(['MainPass']);
    expect(off.copies).toEqual(['lastFrame->backTex']);
  });

  it('glass refraction turning on schedules exactly one follow-up frame; steady frames schedule none', async () => {
    const { r3d, render } = makeHost({ scene3D: true });
    expect((await render()).scheduled).toBe(0);
    r3d.glassRefraction = true;
    const on = await render();
    expect(on.scheduled).toBe(1);
    expect(on.passes).toEqual(['MainPass', 'OverlayPass']);
    expect((await render()).scheduled).toBe(0);
    expect((await render()).copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);
  });

  it('readers off in a hidden 3D scene: SSR on but the 3D layer hidden → no grab', async () => {
    const { r3d, render } = makeHost({ scene3D: false });
    r3d.ssrEnabled = true;
    const f = await render();
    expect(f.passes).toEqual(['MainPass']);
    expect(f.copies).toEqual(['lastFrame->backTex']);
  });

  it('modal world blur (2D frame): the grab is refreshed BEFORE the blur samples it, then kept up to date', async () => {
    const { host, render } = makeHost({ scene3D: false });
    await render();
    host._uiScrimProvider = () => ({ color: [0, 0, 0, 0.4], blur: 1 });
    const on = await render();
    expect(on.log.slice(0, 3)).toEqual(['copy:lastFrame->grab@SceneGrabRefresh', 'submit', 'uiBlur']);
    expect(on.passes).toEqual(['MainPass', 'OverlayPass']);
    expect(on.copies).toEqual(['lastFrame->grab', 'lastFrame->grab', 'lastFrame->backTex']);
    expect(on.scheduled).toBe(1);
    const steady = await render();
    expect(steady.log[0]).toBe('uiBlur');
    expect(steady.copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);
    host._uiScrimProvider = () => ({ color: [0, 0, 0, 0.4], blur: 0 });   // dim only: no reader
    expect((await render()).passes).toEqual(['MainPass']);
  });

  it('a capture frame never copies into the grab (overlays inline); the next live frame does not refresh from it', async () => {
    const { host, r3d, render } = makeHost({ scene3D: true });
    r3d.ssrEnabled = true;
    await render(); await render();
    host._captureMode = { transparent: true, skip3D: false };
    const cap = await render();
    expect(cap.passes).toEqual(['MainPass']);
    expect(cap.copies).toEqual([]);   // no grab, no present
    host._captureMode = null;
    const next = await render();
    expect(next.copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);   // no refresh from the capture image
  });

  it('a resize drops the grab; it comes back at the new size when a reader needs it', async () => {
    const { host, r3d, render } = makeHost({ scene3D: true });
    r3d.ssrEnabled = true;
    await render();
    const old = host.sceneColorGrabTex as Tex;
    host.canvas.width = 80;
    r3d.ssrEnabled = false;
    await render();
    expect(old.destroyed).toBe(true);
    expect(host.sceneColorGrabTex).toBeUndefined();
    expect(r3d.grabSet.at(-1)).toBeNull();
    r3d.ssrEnabled = true;
    const f = await render();
    expect((host.sceneColorGrabTex as Tex).width).toBe(80);
    expect(f.passes).toEqual(['MainPass', 'OverlayPass']);
  });
});
