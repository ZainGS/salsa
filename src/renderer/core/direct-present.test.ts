/**
 * Perf audit C1 + C2: no full-screen copy to the canvas when nothing needs one.
 *   C1 — a frame that needs nothing from lastFrameTex (no snapshot / thumbnail hold, no grab reader, no post / FXAA,
 *        no capture) renders STRAIGHT into the canvas texture.
 *   C2 — when post / FXAA runs, its LAST pass renders straight into the canvas texture (no output texture + copy).
 *   A grab reader turning on after direct frames gets one unpresented PRIMING frame (lastFrameTex had no recent frame
 *   to refresh the grab from). snapshotToBlob still reads the frame rendered under its hold.
 * Drives the REAL WebGPURenderer.render() / snapshotToBlob() on a minimal host with a mocked device that records
 * every render pass (label > colour target), texture copy and canvas-texture acquisition, and stamps each target with
 * the frame that cleared it (so a read-back can be checked).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';

const gg = globalThis as Record<string, unknown>;
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
gg.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
gg.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
gg.GPUMapMode ??= { READ: 1, WRITE: 2 };
const U = gg.GPUTextureUsage as Record<string, number>;

type Tex = { id: string; width: number; height: number; format: string; usage: number; content: number; destroyed: boolean; destroy(): void; createView(): { tex: Tex } };
type Frame = { passes: string[]; copies: string[]; acquired: number; log: string[]; scheduled: number };

let Cls: { prototype: object; directPresent: boolean };
beforeAll(async () => { Cls = (await import('./webgpu-renderer')).WebGPURenderer as unknown as typeof Cls; });
afterEach(() => { Cls.directPresent = true; });

function makeHost(opts: { scene3D?: boolean; meshes?: number; fxaa?: boolean; post?: boolean; canvasFormat?: string; canvasUsage?: number } = {}) {
  let texN = 0, frameNo = 0;
  const frame: Frame = { passes: [], copies: [], acquired: 0, log: [], scheduled: 0 };
  const name = (t: Tex) => (t === host.lastFrameTex ? 'lastFrame' : t === host.sceneColorGrabTex ? 'grab' : t.id);
  const createTexture = (d: { size: number[]; label?: string; format: string; usage?: number }): Tex => ({
    id: d.label ?? `tex${texN++}`, width: d.size[0], height: d.size[1], format: d.format, usage: d.usage ?? 0, content: 0, destroyed: false,
    destroy() { this.destroyed = true; }, createView() { return { tex: this }; },
  });
  const backTex = createTexture({ size: [64, 32], label: 'backTex', format: opts.canvasFormat ?? 'bgra8unorm',
    usage: opts.canvasUsage ?? (U.RENDER_ATTACHMENT | U.COPY_DST) });
  const fxaaOut = createTexture({ size: [64, 32], label: 'FXAAOut', format: 'bgra8unorm' });
  const ppOut = createTexture({ size: [64, 32], label: 'PPPing', format: 'bgra8unorm' });
  type PassDesc = { label?: string; colorAttachments: { view: { tex: Tex }; loadOp?: string }[] };
  const encoder = (label?: string) => ({
    label,
    beginRenderPass: (desc: PassDesc) => {
      const a = desc.colorAttachments[0], l = desc.label ?? 'MainPass';
      if (a.loadOp === 'clear') a.view.tex.content = frameNo;   // stamp the target with the frame that cleared it
      frame.passes.push(`${l}>${name(a.view.tex)}`);
      return new Proxy({}, { get: (_t, k) => (k === 'end' ? () => frame.log.push(`end:${l}`) : () => undefined) });
    },
    copyTextureToTexture: (s: { texture: Tex }, t: { texture: Tex }) => { t.texture.content = s.texture.content; frame.copies.push(`${name(s.texture)}->${name(t.texture)}`); },
    copyTextureToBuffer: (s: { texture: Tex }, t: { buffer: { content: number } }) => { t.buffer.content = s.texture.content; frame.copies.push(`${name(s.texture)}->buffer`); },
    finish: () => ({}),
  });
  const device = {
    createTexture, createCommandEncoder: (d?: { label?: string }) => encoder(d?.label),
    createBuffer: (d: { size: number }) => {
      const b = { size: d.size, content: 0, mapAsync: async () => undefined, getMappedRange: () => new Uint8Array(d.size).fill(b.content).buffer, unmap() { /* */ }, destroy() { /* */ } };
      return b;
    },
    queue: { submit: () => { frame.log.push('submit'); }, writeBuffer: () => undefined, onSubmittedWorkDone: async () => undefined },
  };
  // The 3D renderer's post chain, reduced to its contract with the host (the real chain: post-to-canvas.test.ts).
  const r3d = {
    ssrEnabled: false, glassRefraction: false, particleBloomPending: false, lodViewHeight: 0, drew: false,
    fxaa: opts.fxaa ?? false, post: opts.post ?? false, restores: 0,
    setSceneColorGrabTexture() { /* */ },
    focusBgCoversCanvas: () => false, getLoResSize: () => null, loResIsDynamic: () => false, drawArmatureBg: () => undefined, meshEditHidesContent: () => false,
    hasPostOverlays: () => false, noteCullCpuMs: () => undefined,
    restoreFocusBgAfterPost(_e: unknown, raw: Tex, view: { tex: Tex }) { this.restores++; frame.log.push(`restore:${name(raw)}>${name(view.tex)}`); },
    postProcessMayRun(_w: number, _h: number, may3D: boolean) { return (this.fxaa && may3D) || this.post; },
    skipPostProcess() { const d = this.drew; this.drew = false; return (this.fxaa && d) || this.post; },
    _chain(enc: ReturnType<typeof encoder>, view: { tex: Tex } | null): Tex | 'target' | null {
      const fx = this.fxaa && this.drew; this.drew = false;
      if (!fx && !this.post) return null;
      if (fx) enc.beginRenderPass({ label: 'FXAAPass', colorAttachments: [{ view: !this.post && view ? view : fxaaOut.createView(), loadOp: 'clear' }] });
      if (this.post) enc.beginRenderPass({ label: 'PPGradeVigPass', colorAttachments: [{ view: view ?? ppOut.createView(), loadOp: 'clear' }] });
      return view ? 'target' : this.post ? ppOut : fxaaOut;
    },
    runPostProcess(enc: ReturnType<typeof encoder>) { return this._chain(enc, null); },
    runPostProcessTo(enc: ReturnType<typeof encoder>, _s: unknown, _w: number, _h: number, view: { tex: Tex }) { return this._chain(enc, view); },
  };
  const meshes = Array.from({ length: opts.meshes ?? 0 }, () => ({ visible: true }));
  const host: Record<string, any> = Object.assign(Object.create(Cls.prototype), {
    device, context: { getCurrentTexture: () => { frame.acquired++; return backTex; } }, canvas: { width: 64, height: 32 }, swapChainFormat: 'bgra8unorm',
    _deviceLost: false, preRenderCallbacks: [() => { frameNo++; return false; }], _contextAlpha: 'premultiplied', _captureMode: null, renderMode: 'vector',
    backgroundColor: new Float32Array(4), canvasBackgroundColor: new Float32Array(4),
    interactionService: { depthTextureView: {}, boxSelectPreview: null, rectDrawCallback: null },
    renderList: [], _visibleNodesScratch: [], _aboveRasterScratch: [], _hiddenVectorLayerIds: new Set(),
    webGPURenderStrategy: { beginFrame: () => undefined, uploadDrawCommands: () => undefined, uploadDrawCounts: () => undefined, getTexturedCount: () => 0 },
    stagingBuffer: { beginStagingPass: () => undefined },
    pipelineManager: { getStagingLinePipeline: () => ({}), getStagingHighlightPipeline: () => ({}) },
    postRasterCompositeCallbacks: [], _realShotWaiters: [], cacheService: { getSdfAtlas: () => ({ version: 0 }) }, cachedAtlasVersion: 0,
    _scene3dVisible: opts.scene3D ?? true, _renderer3D: r3d, _uiScrimProvider: null as null | (() => unknown),
    // C1 state (field initialisers do not run on Object.create)
    _rlSplit: true, _flatShapesDirty: false, _rl3DMeshes: meshes, _fullResHold: 0, _forceOffscreenNext: false, _swapchainCopySrc: false,
    _submittedDirect: false, _submittedScaled: false, _frameScaled: false, frameSubmittedResolvers: [], _postFrameCallbacks: [],
    _resScaler: { scale: () => 1 }, _taaSettings: { mode: 'off' },
    // stubs for everything render() calls that is not under test
    getArtboardScissor: () => null, renderArtboardPattern: () => undefined,
    handleAtlasCompactIfNeeded: () => undefined, handleAtlasChangeIfNeeded: () => undefined, rebuildRenderListIfNeeded: () => undefined,
    getRenderer3D: () => r3d, _applyResolutionScale: () => undefined,
    draw3DMeshes: (_p: unknown, _n: unknown, _w: number, _h: number, defer: boolean) => { if (host._rl3DMeshes.some((m: { visible: boolean }) => m.visible) || host.drawsAnyway) r3d.drew = true; if (defer) host._overlays3DPending = true; },
    draw3DParticles: () => undefined, draw3DGp: () => undefined,
    renderUIScrim: () => frame.log.push(`scrim:${host._uiScrimFrame ? 'on' : 'off'}`), drawVectorShapes: () => undefined, renderStagingShapes: () => undefined,
    driveLiveTextHtml: () => undefined, drawLiveTextNodes: () => undefined,
    _drawOverlaySet: () => { host._overlays3DPending = false; },
    prepareUIWorldBlur: () => frame.log.push('uiBlur'),
    _temporalSettle: () => undefined,
    scheduleRender: () => { frame.scheduled++; if (host.autoRender) setTimeout(() => void host.render(), 0); },
  });
  const render = async () => {
    frame.passes = []; frame.copies = []; frame.acquired = 0; frame.log = []; frame.scheduled = 0;
    await (host.render as () => Promise<void>)();
    return { ...frame, passes: [...frame.passes], copies: [...frame.copies], log: [...frame.log] };
  };
  return { host, r3d, render, backTex, frame, frameNo: () => frameNo };
}

describe('C1: straight into the canvas texture when nothing needs lastFrameTex', () => {
  it('a plain 2D frame: one pass INTO the canvas texture, no copy at all', async () => {
    const { host, render } = makeHost({ scene3D: false, fxaa: true });
    for (let i = 0; i < 3; i++) {
      const f = await render();
      expect(f.passes).toEqual(['MainPass>backTex']);
      expect(f.copies).toEqual([]);
      expect(f.acquired).toBe(1);
      expect(f.scheduled).toBe(0);
    }
    expect(host._submittedDirect).toBe(true);
    expect(host._lastFrameLive).toBe(false);   // lastFrameTex was not written
  });

  it('a 3D frame without post: FXAA off, or FXAA on with no mesh to draw → direct', async () => {
    for (const o of [{ meshes: 3, fxaa: false }, { meshes: 0, fxaa: true }]) {
      const { render } = makeHost(o);
      const f = await render();
      expect(f.passes).toEqual(['MainPass>backTex']);
      expect(f.copies).toEqual([]);
    }
  });

  it('a hidden mesh does not count; a structure change about to be re-walked does (conservative)', async () => {
    const { host, render } = makeHost({ meshes: 1, fxaa: true });
    host._rl3DMeshes[0].visible = false;
    expect((await render()).passes).toEqual(['MainPass>backTex']);
    host._flatShapesDirty = true;
    expect((await render()).passes[0]).toBe('MainPass>lastFrame');
  });

  it('the canvas texture cannot take the frame (another format / no RENDER_ATTACHMENT): the copy path, as before', async () => {
    for (const o of [{ canvasFormat: 'rgba8unorm' }, { canvasUsage: U.COPY_DST }]) {
      const { render } = makeHost({ scene3D: false, ...o });
      const f = await render();
      expect(f.passes).toEqual(['MainPass>lastFrame']);
      expect(f.copies).toEqual(['lastFrame->backTex']);
    }
  });

  it('render debug noDirectPresent (the on-device kill switch) forces the old path; off again → direct', async () => {
    const { setRenderDebug, RENDER_DEBUG_FLAGS } = await import('../3d/render-debug');
    expect(RENDER_DEBUG_FLAGS.some((f) => f.key === 'noDirectPresent')).toBe(true);   // listed → in the Frogmarks menu
    const { render } = makeHost({ meshes: 2, fxaa: true });
    try {
      setRenderDebug({ noDirectPresent: true });
      const f = await render();
      expect(f.passes).toEqual(['MainPass>lastFrame', 'FXAAPass>FXAAOut']);
      expect(f.copies).toEqual(['FXAAOut->backTex']);
      const { render: render2D } = makeHost({ scene3D: false });
      const p = await render2D();
      expect(p.passes).toEqual(['MainPass>lastFrame']);
      expect(p.copies).toEqual(['lastFrame->backTex']);
    } finally { setRenderDebug({ reset: true }); }
    expect((await render()).passes).toEqual(['MainPass>lastFrame', 'FXAAPass>backTex']);
  });

  it('kill switch: directPresent = false is the original path (every frame into lastFrameTex + copy)', async () => {
    Cls.directPresent = false;
    const { render } = makeHost({ meshes: 2, fxaa: true });
    const f = await render();
    expect(f.passes).toEqual(['MainPass>lastFrame', 'FXAAPass>FXAAOut']);
    expect(f.copies).toEqual(['FXAAOut->backTex']);
  });
});

describe('C2: the last post / FXAA pass writes the canvas texture', () => {
  it('3D + FXAA (the default AA): main pass into lastFrameTex, FXAA into the canvas, no copy', async () => {
    const { host, render } = makeHost({ meshes: 2, fxaa: true });
    const f = await render();
    expect(f.passes).toEqual(['MainPass>lastFrame', 'FXAAPass>backTex']);
    expect(f.copies).toEqual([]);
    expect(host._lastFrameLive).toBe(true);    // the raw frame is in lastFrameTex (thumbnails / the grab refresh)
    expect(host._submittedDirect).toBe(false);
  });

  it('FXAA + the post chain: FXAA into its texture, the final post pass into the canvas, no copy', async () => {
    const { render } = makeHost({ meshes: 2, fxaa: true, post: true });
    const f = await render();
    expect(f.passes).toEqual(['MainPass>lastFrame', 'FXAAPass>FXAAOut', 'PPGradeVigPass>backTex']);
    expect(f.copies).toEqual([]);
  });

  it('post on a 2D frame (the grade applies without 3D): offscreen + post into the canvas', async () => {
    const { render } = makeHost({ scene3D: false, post: true });
    const f = await render();
    expect(f.passes).toEqual(['MainPass>lastFrame', 'PPGradeVigPass>backTex']);
    expect(f.copies).toEqual([]);
  });

  it('a focus background is restored from the RAW lastFrameTex onto the canvas after a post-in-canvas frame', async () => {
    const { r3d, render, frame } = makeHost({ meshes: 1, post: true });
    await render();
    expect(r3d.restores).toBe(1);
    expect(frame.log).toContain('restore:lastFrame>backTex');
  });

  it('a mispredicted frame (3D drew though no visible mesh was listed): no post this frame, one offscreen re-render', async () => {
    const { host, render } = makeHost({ meshes: 0, fxaa: true });
    host.drawsAnyway = true;
    const miss = await render();
    expect(miss.passes).toEqual(['MainPass>backTex']);
    expect(miss.scheduled).toBe(1);
    const fix = await render();
    expect(fix.passes).toEqual(['MainPass>lastFrame', 'FXAAPass>backTex']);
    expect(fix.scheduled).toBe(0);
  });

  it('a real screenshot of a canvas without COPY_SRC: offscreen, the post output kept in its texture and copied', async () => {
    const { host, render } = makeHost({ scene3D: false, post: true });
    host._realShotWaiters = [{ resolve: () => undefined, reject: () => undefined }];
    host._encodeRealShot = (_e: unknown, _b: unknown, src: Tex) => { host.shotSrc = src.id; return null; };
    const f = await render();
    expect(f.passes).toEqual(['MainPass>lastFrame', 'PPGradeVigPass>PPPing']);
    expect(f.copies).toEqual(['PPPing->backTex']);
    expect(host.shotSrc).toBe('PPPing');
    host._realShotWaiters = [{ resolve: () => undefined, reject: () => undefined }];
    host.post = false; host._renderer3D.post = false;
    expect((await render()).passes).toEqual(['MainPass>lastFrame']);   // even with no post: lastFrameTex is read instead
  });
});

describe('frames that need lastFrameTex', () => {
  it('a thumbnail / snapshot hold forces the offscreen path (+ the copy) for its frames only', async () => {
    const { host, render } = makeHost({ scene3D: false });
    expect((await render()).passes).toEqual(['MainPass>backTex']);
    host._fullResHold = 1;
    const held = await render();
    expect(held.passes).toEqual(['MainPass>lastFrame']);
    expect(held.copies).toEqual(['lastFrame->backTex']);
    host._fullResHold = 0;
    expect((await render()).passes).toEqual(['MainPass>backTex']);
  });

  it('snapshotToBlob returns the pixels of the frame rendered under its hold, not a stale lastFrameTex', async () => {
    const { host, render, frameNo } = makeHost({ scene3D: false });
    let blobData: Uint8ClampedArray | null = null;
    class FakeImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) { } }
    class FakeOffscreen {
      data: Uint8ClampedArray | null = null;
      constructor(public width: number, public height: number) { }
      getContext() { const c = this; return { putImageData(img: FakeImageData) { c.data = img.data; }, drawImage(src: FakeOffscreen) { c.data = src.data; } }; }
      async convertToBlob() { blobData = this.data; return new Blob([this.data as unknown as BlobPart]); }
    }
    const prev = { ImageData: gg.ImageData, OffscreenCanvas: gg.OffscreenCanvas };
    gg.ImageData = FakeImageData; gg.OffscreenCanvas = FakeOffscreen;
    try {
      await render(); await render();               // direct frames: lastFrameTex holds nothing of them
      expect(host.lastFrameTex.content).toBe(0);
      host.autoRender = true;                       // scheduleRender → a frame (as the live loop would)
      const blob = await host.snapshotToBlob(64) as Blob;
      expect(blob.size).toBeGreaterThan(0);
      const held = frameNo();
      expect(host.lastFrameTex.content).toBe(held); // the hold frame went into lastFrameTex...
      expect(blobData).not.toBeNull();
      expect([...blobData!.slice(0, 4)]).toEqual([held, held, held, held]);   // ...and the read-back is its pixels
      expect(host._fullResHold).toBe(0);            // the hold is released
    } finally {
      host.autoRender = false;
      gg.ImageData = prev.ImageData; gg.OffscreenCanvas = prev.OffscreenCanvas;
    }
  });

  it('a frame that started direct before the hold does not satisfy waitForFrameSettled', async () => {
    const { host } = makeHost({ scene3D: false });
    let n = 0;
    host.scheduleRender = () => { const k = ++n; setTimeout(() => {
      const hold = host._fullResHold;
      if (k === 1) host._fullResHold = 0;          // the first frame "started before the hold" (decided direct)...
      void (host.render as () => Promise<void>)();
      host._fullResHold = hold;                    // ...(the direct / offscreen choice is made synchronously at the start)
    }, 0); };
    host.nextRAF = async () => undefined;
    await host.waitForFrameSettled();
    expect(n).toBe(2);                             // the direct frame was skipped, the next (offscreen) one counted
    expect(host._submittedDirect).toBe(false);
  });

  it('a capture never acquires the canvas texture (no blank present) and renders into lastFrameTex', async () => {
    const { host, render } = makeHost({ scene3D: false });
    host._captureMode = { transparent: true, skip3D: true };
    const cap = await render();
    expect(cap.acquired).toBe(0);
    expect(cap.passes).toEqual(['MainPass>lastFrame']);
    expect(cap.copies).toEqual([]);
  });

  it('a grab reader turning on after direct frames: one unpresented PRIMING frame, then the presented one', async () => {
    const { host, r3d, render } = makeHost({ meshes: 1 });
    expect((await render()).passes).toEqual(['MainPass>backTex']);
    r3d.ssrEnabled = true;
    const prime = await render();
    expect(prime.acquired).toBe(0);                                   // not presented: the canvas keeps the last frame
    expect(prime.passes).toEqual(['MainPass>lastFrame', 'OverlayPass>lastFrame']);
    expect(prime.copies).toEqual(['lastFrame->grab']);                // scene-only grab, no stale refresh, no present
    expect(prime.scheduled).toBeGreaterThanOrEqual(1);                // its presented follow-up
    const shown = await render();
    expect(shown.acquired).toBe(1);
    expect(shown.copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);
    r3d.ssrEnabled = false;
    const off = await render();
    expect(off.passes).toEqual(['MainPass>backTex']);                 // reader off → direct again
    expect(off.copies).toEqual([]);
  });

  it('modal world blur turning on after direct frames: the priming frame draws no scrim / blur; the next one does', async () => {
    const { host, render } = makeHost({ scene3D: false });
    await render();
    host._uiScrimProvider = () => ({ color: [0, 0, 0, 0.4], blur: 1 });
    const prime = await render();
    expect(prime.acquired).toBe(0);
    expect(prime.log).not.toContain('uiBlur');
    expect(prime.log).toContain('scrim:off');
    expect(prime.copies).toEqual(['lastFrame->grab']);
    expect(prime.scheduled).toBe(1);
    const shown = await render();
    expect(shown.log[0]).toBe('uiBlur');
    expect(shown.log).toContain('scrim:on');
    expect(shown.copies).toEqual(['lastFrame->grab', 'lastFrame->backTex']);
  });

  it('a resize with a reader already on still presents every frame (no priming outside the rising edge)', async () => {
    const { host, r3d, render } = makeHost({ meshes: 1 });
    r3d.ssrEnabled = true;
    await render(); await render();
    for (const w of [70, 76, 82]) {
      host.canvas.width = w;                    // fresh lastFrameTex + grab each frame (a resize drag)
      const f = await render();
      expect(f.acquired).toBe(1);
      expect(f.copies.at(-1)).toBe('lastFrame->backTex');
    }
  });

  it('a reader turning on after an OFFSCREEN frame (FXAA) still refreshes the grab from it — no priming', async () => {
    const { r3d, render } = makeHost({ meshes: 1, fxaa: true });
    await render();                                                    // offscreen (FXAA): lastFrameTex is live
    r3d.ssrEnabled = true;
    const on = await render();
    expect(on.acquired).toBe(1);
    expect(on.copies).toEqual(['lastFrame->grab', 'lastFrame->grab']); // the refresh, then this frame's grab (FXAA presents)
    expect(on.passes).toEqual(['MainPass>lastFrame', 'OverlayPass>lastFrame', 'FXAAPass>backTex']);
  });
});
