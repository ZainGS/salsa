/**
 * cart-disc-preview.ts — A LIVE 3D preview of a FrogCart's Shell disc in its own canvas (the .frogcart export
 * dialog's "Disc art" field): the SAME CD pipeline + mesh + idle motion as the Shell home (shell-cd.ts), so what the
 * user sees while choosing a pattern / image / crop is exactly the disc the Shell will show.
 *
 *   const p = sm.createCartDiscPreview(canvas, { pattern: { seed } });
 *   p.setPattern(seed2);  await p.setArt(blob);  p.setFit({ zoom: 1.4, panX: 0.2, panY: 0 });  p.setArt(null);
 *   p.dispose();          // on close
 *
 * It renders on the editor's GPU device (pipelines come from the shared Shell cache — no recompile when the Shell has
 * run) into its OWN canvas context with its own small buffers, and runs its own requestAnimationFrame loop only while
 * it exists (skipping frames while the page is hidden or the canvas is detached). It never touches the editor's
 * canvas or render loop. The art is uploaded whole; the crop is applied as a texture rect (cdDiscArtUVRect), so pan /
 * zoom cost nothing. `setPose` is the hook for an animation that takes the disc over (the cart launch preview);
 * null = the idle whirl.
 */

import { mat4 } from 'gl-matrix';
import { unwrapDevice } from '../core/gpu-device-handle';
import {
  SHELL_DEPTH_FORMAT, SHELL_3D_UNIFORM_SIZE, shellCartLayouts, shellCDPipeline, uploadShellCDMesh, cdIdlePose,
  cdPoseModel, shellProject, writeCDUniforms, type CDFace, type CDPose,
} from './shell-cd';
import { cdDiscArtUVRect, clampCDDiscArtFit, type CDDiscArtFit } from '../3d/cd-disc/cd-disc-art';
import { normalizeCartDiscPatternRef, type CartDiscFamily, type CartDiscPatternRef } from '../3d/cd-disc/cart-disc-pattern';
import { launchPreviewPose, LAUNCH_BLUR_ARC, type LaunchPreviewState } from './shell-launch-pose';
import { prefersReducedMotion } from './shell-launch';

export interface CartDiscPreviewOptions {
  /** The pattern printed while there is no art (null = a bare holographic disc). */
  pattern?: CartDiscPatternRef | null;
  /** Initial art (decoded asynchronously; see setArt). */
  art?: Blob | ImageBitmap | null;
  fit?: Partial<CDDiscArtFit> | null;
  /** Backing pixels per CSS px (default devicePixelRatio, capped at 2). */
  pixelRatio?: number;
  /** Clear colour (premultiplied rgba 0..1). Default fully transparent: the page shows around the disc. */
  background?: [number, number, number, number];
  /** Start the rAF loop at once (default true). */
  autoStart?: boolean;
  /** The canvas's colour format (default navigator.gpu.getPreferredCanvasFormat()). */
  format?: GPUTextureFormat;
}

export interface CartDiscPreview {
  /** Print this image (decoded + uploaded; resolves false when it cannot be decoded — the previous face stays).
   *  null = back to the pattern. */
  setArt(art: Blob | ImageBitmap | null): Promise<boolean>;
  /** The pattern seed (+ optional pinned family) printed when there is no art. */
  setPattern(seed: number, family?: CartDiscFamily): void;
  /** The art's crop (zoom ≥ 1, pan -1..1). */
  setFit(fit: Partial<CDDiscArtFit> | null): void;
  /** Override the idle motion with a pose (the launch-preview hook); null = idle. */
  setPose(pose: CDPose | null): void;
  /** Play the Shell's cart-launch motion once on the disc — the flick to the front, the spin-up (with its blur), then
   *  the spin-down back to the idle whirl (no dim / fade: just the disc). Restarts when called again; starts the loop.
   *  reducedMotion (default prefers-reduced-motion): no spin, a short settle. */
  playLaunchPreview(opts?: { reducedMotion?: boolean }): void;
  /** Stop a launch preview (back to idle at once). */
  stopLaunchPreview(): void;
  /** A launch preview is playing. */
  readonly launchPreviewActive: boolean;
  /** Draw one frame now (at `timeSec`, default the preview's clock). */
  renderFrame(timeSec?: number): void;
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** True once the art has been decoded (setArt resolved true) and not cleared. */
  readonly hasArt: boolean;
  /** Frames drawn so far (diagnostics / tests). */
  readonly frames: number;
  /** Stop the loop and free the GPU objects. Safe to call twice. */
  dispose(): void;
  readonly disposed: boolean;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Longest edge the preview keeps of an uploaded image (the crop is a UV rect, so this is only sharpness). */
const ART_MAX_PX = 2048;

/** Create a preview on `device` (the editor's — a handle is fine) drawing into `canvas`. */
export function createCartDiscPreview(device: GPUDevice, canvas: AnyCanvas, opts: CartDiscPreviewOptions = {}): CartDiscPreview {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  const format: GPUTextureFormat = opts.format ?? gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) throw new Error('createCartDiscPreview: no WebGPU context on the canvas');
  ctx.configure({ device: unwrapDevice(device), format, alphaMode: 'premultiplied' });

  const { bgl, thumbBGL, sampler } = shellCartLayouts(device);
  const pipeline = shellCDPipeline(device, format);
  const mesh = uploadShellCDMesh(device);
  const ubuf = device.createBuffer({ size: SHELL_3D_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'CartDiscPreview.u' });
  const uBind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const blank = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'CartDiscPreview.blank' });
  device.queue.writeTexture({ texture: blank }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1]);
  const texBind = (view: GPUTextureView) => device.createBindGroup({ layout: thumbBGL, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] });

  let artTex: GPUTexture | null = null;
  let artSize: [number, number] = [1, 1];
  let tBind = texBind(blank.createView());
  let depth: GPUTexture | null = null;
  let depthSize: [number, number] = [0, 0];
  let pattern: CartDiscPatternRef | null = normalizeCartDiscPatternRef(opts.pattern ?? null);
  let fit: CDDiscArtFit = clampCDDiscArtFit(opts.fit);
  let pose: CDPose | null = null;
  let launch: LaunchPreviewState | null = null;
  const launchCD: CDPose = { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 };
  let disposed = false;
  let running = false;
  let raf = 0;
  let frames = 0;
  let artGen = 0;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const clear = opts.background ?? [0, 0, 0, 0];
  const u = new Float32Array(SHELL_3D_UNIFORM_SIZE / 4);
  const model = mat4.create(), mvp = mat4.create();
  const idle: CDPose = { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 };
  const face: CDFace = { art: null, pattern: null };

  const now = () => ((typeof performance !== 'undefined' ? performance.now() : 0) - t0) / 1000;

  /** Match the backing store to the canvas's CSS size (HTML canvas only). */
  const syncSize = (): void => {
    const c = canvas as HTMLCanvasElement;
    if (typeof c.clientWidth !== 'number' || !c.clientWidth) return;
    const dpr = Math.min(2, opts.pixelRatio ?? ((globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1));
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  };

  const renderFrame = (timeSec?: number): void => {
    if (disposed) return;
    syncSize();
    const w = canvas.width, h = canvas.height;
    if (w <= 0 || h <= 0) return;
    if (!depth || depthSize[0] !== w || depthSize[1] !== h) {
      depth?.destroy();
      depth = device.createTexture({ size: [w, h], format: SHELL_DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'CartDiscPreview.depth' });
      depthSize = [w, h];
    }
    const t = timeSec ?? now();
    let drawPose: CDPose = pose ?? cdIdlePose(t, 0, idle);
    let blur = 0;
    if (!pose && launch) {
      const lp = launchPreviewPose(launch, t * 1000, drawPose, launchCD);
      if (lp) { drawPose = launchCD; blur = lp.blur * LAUNCH_BLUR_ARC; } else launch = null;   // back at idle
    }
    cdPoseModel(model, drawPose);
    shellProject(mvp, model, w / h);
    face.art = artTex ? cdDiscArtUVRect(artSize[0], artSize[1], fit) : null;
    face.pattern = pattern;
    writeCDUniforms(u, mvp, model, face, blur);
    device.queue.writeBuffer(ubuf, 0, u);
    let view: GPUTextureView;
    try { view = ctx.getCurrentTexture().createView(); } catch { return; }   // (a canvas mid-resize / lost context)
    const enc = device.createCommandEncoder({ label: 'CartDiscPreview' });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] } }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, uBind);
    pass.setBindGroup(1, tBind);
    pass.setVertexBuffer(0, mesh.vbuf);
    pass.setIndexBuffer(mesh.ibuf, mesh.format);
    pass.drawIndexed(mesh.count);
    pass.end();
    device.queue.submit([enc.finish()]);
    frames++;
  };

  const raf_ = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  const caf_ = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
  const tick = (): void => {
    raf = 0;
    if (!running || disposed) return;
    const doc = (globalThis as { document?: Document }).document;
    const hidden = !!doc?.hidden || (canvas as HTMLCanvasElement).isConnected === false;
    if (!hidden) renderFrame();
    raf = raf_ ? raf_(tick) : 0;
  };

  const releaseArt = (): void => { artTex?.destroy(); artTex = null; artSize = [1, 1]; tBind = texBind(blank.createView()); };

  const api: CartDiscPreview = {
    async setArt(art) {
      const gen = ++artGen;
      if (disposed) return false;
      if (!art) { releaseArt(); if (!running) renderFrame(); return true; }
      let bmp: ImageBitmap;
      let owned = false;
      try {
        if (typeof ImageBitmap !== 'undefined' && art instanceof ImageBitmap) bmp = art;
        else {
          const probe = await createImageBitmap(art as Blob);
          const long = Math.max(probe.width, probe.height);
          if (long > ART_MAX_PX) {
            const k = ART_MAX_PX / long;
            bmp = await createImageBitmap(probe, { resizeWidth: Math.max(1, Math.round(probe.width * k)), resizeHeight: Math.max(1, Math.round(probe.height * k)), resizeQuality: 'high' });
            probe.close?.();
          } else bmp = probe;
          owned = true;
        }
      } catch { return false; }
      try {
        if (disposed || gen !== artGen) return false;   // superseded / closed while decoding
        const tex = device.createTexture({
          size: [bmp.width, bmp.height], format: 'rgba8unorm', label: 'CartDiscPreview.art',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
        artTex?.destroy();
        artTex = tex;
        artSize = [bmp.width, bmp.height];
        tBind = texBind(tex.createView());
        if (!running) renderFrame();
        return true;
      } catch { return false; }
      finally { if (owned) bmp.close?.(); }
    },
    setPattern(seed, family) {
      pattern = normalizeCartDiscPatternRef({ seed, family });
      if (!running) renderFrame();
    },
    setFit(f) { fit = clampCDDiscArtFit(f); if (!running) renderFrame(); },
    setPose(p) { pose = p; },
    playLaunchPreview(o) {
      if (disposed) return;
      const t = now();
      const i = cdIdlePose(t, 0, idle);
      launch = { startMs: t * 1000, yaw0: i.spin, y0: i.y, tilt0: i.tilt, reducedMotion: o?.reducedMotion ?? prefersReducedMotion(), from: null };
      api.start();
    },
    stopLaunchPreview() { launch = null; if (!running) renderFrame(); },
    get launchPreviewActive() { return launch !== null; },
    renderFrame,
    start() {
      if (disposed || running) return;
      running = true;
      if (raf_) raf = raf_(tick); else renderFrame();
    },
    stop() { running = false; if (raf && caf_) caf_(raf); raf = 0; },
    get running() { return running; },
    get hasArt() { return !!artTex; },
    get frames() { return frames; },
    dispose() {
      if (disposed) return;
      api.stop();
      disposed = true;
      artGen++;
      artTex?.destroy(); artTex = null;
      blank.destroy();
      depth?.destroy(); depth = null;
      ubuf.destroy();
      mesh.vbuf.destroy(); mesh.ibuf.destroy();
      try { ctx.unconfigure(); } catch { /* already gone */ }
    },
    get disposed() { return disposed; },
  };

  if (opts.art) void api.setArt(opts.art);
  if (opts.autoStart ?? true) api.start();
  return api;
}
