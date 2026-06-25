/**
 * RasterMoveService — "Grab" tool that translates the active raster layer's pixels
 * by clicking and dragging anywhere on the canvas.
 *
 * On pointerDown: takes an undo snapshot, clones the texture to a staging copy.
 * On pointerMove: clears the layer texture, copies the staging texture at the new offset.
 * On pointerUp: finalizes the move.
 */

import { InteractionService } from './interaction-service';
import { WebGPURenderer } from '../renderer/core/webgpu-renderer';

export class RasterMoveService {
  private interactionService: InteractionService;
  private renderer: WebGPURenderer;

  public isEnabled = false;

  // Drag state
  private isDragging = false;
  private dragStartTexel: { x: number; y: number } | null = null;

  // Staging: a copy of the layer texture taken at pointerDown
  private stagingTexture: GPUTexture | null = null;
  private texW = 0;
  private texH = 0;

  // GPU resources for the clear+stamp compute
  private blitPipeline: GPUComputePipeline | null = null;
  private blitBGL: GPUBindGroupLayout | null = null;

  // Bound listeners
  private downBound = (e: PointerEvent) => this.onPointerDown(e);
  private moveBound = (e: PointerEvent) => this.onPointerMove(e);
  private upBound = (e: PointerEvent) => this.onPointerUp(e);

  constructor(interactionService: InteractionService, renderer: WebGPURenderer) {
    this.interactionService = interactionService;
    this.renderer = renderer;
    this.attachListeners();
  }

  public enable() { this.isEnabled = true; }
  public disable() {
    if (this.isDragging) this.finishDrag();
    this.isEnabled = false;
  }

  public destroy(): void {
    const canvas = this.interactionService.canvas;
    canvas.removeEventListener('pointerdown', this.downBound);
    canvas.removeEventListener('pointermove', this.moveBound);
    canvas.removeEventListener('pointerup', this.upBound);
    this.destroyStaging();
  }

  // ── Pointer handlers ──────────────────────────────────────────────

  private onPointerDown(ev: PointerEvent): void {
    if (!this.isEnabled || ev.button !== 0) return;

    const device = this.getDevice();
    const activeTex = this.getActiveTexture();
    if (!device || !activeTex) return;

    const texel = this.toTexelCoords(ev);
    this.dragStartTexel = texel;
    this.isDragging = true;
    this.texW = activeTex.width;
    this.texH = activeTex.height;

    // Push undo snapshot
    const paintEngine = this.renderer.rasterPaintEngine;
    if (paintEngine?.getActiveTexture()) {
      paintEngine.snapshotManager.pushSnapshot(activeTex).catch(() => {});
    }
    // Also push to the layer manager's per-layer undo stack (rasterUndo reads from there)
    const layerMgr = (this.renderer as any).rasterLayerManager;
    const selectedId = layerMgr?.getSelectedLayerId?.();
    if (selectedId && layerMgr) {
      layerMgr.pushSnapshotForLayer(selectedId);
    }

    // Clone current layer into staging texture
    this.destroyStaging();
    this.stagingTexture = device.createTexture({
      size: [this.texW, this.texH],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: activeTex },
      { texture: this.stagingTexture },
      { width: this.texW, height: this.texH },
    );
    device.queue.submit([enc.finish()]);
  }

  private onPointerMove(ev: PointerEvent): void {
    if (!this.isEnabled || !this.isDragging || !this.dragStartTexel || !this.stagingTexture) return;

    const device = this.getDevice();
    const activeTex = this.getActiveTexture();
    if (!device || !activeTex) return;

    const texel = this.toTexelCoords(ev);
    const dx = Math.round(texel.x - this.dragStartTexel.x);
    const dy = Math.round(texel.y - this.dragStartTexel.y);

    this.applyOffset(device, activeTex, dx, dy);
    this.renderer.scheduleRender();
  }

  private onPointerUp(_ev: PointerEvent): void {
    if (!this.isEnabled || !this.isDragging) return;
    this.finishDrag();
  }

  private finishDrag(): void {
    this.isDragging = false;
    this.dragStartTexel = null;
    this.destroyStaging();
    this.renderer.scheduleRender();
  }

  // ── GPU offset via compute ────────────────────────────────────────

  /**
   * Clear the destination texture and stamp the staging texture at (dx, dy) offset.
   * Uses a compute shader that reads staging at (gid - offset) and writes to dst.
   */
  private applyOffset(device: GPUDevice, dst: GPUTexture, dx: number, dy: number): void {
    this.ensureBlitPipeline(device);

    const params = new Int32Array([dx, dy, this.texW, this.texH]);
    const paramBuf = device.createBuffer({
      size: params.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Int32Array(paramBuf.getMappedRange()).set(params);
    paramBuf.unmap();

    const bg = device.createBindGroup({
      layout: this.blitBGL!,
      entries: [
        { binding: 0, resource: this.stagingTexture!.createView() },
        { binding: 1, resource: dst.createView() },
        { binding: 2, resource: { buffer: paramBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(
      Math.ceil(this.texW / 8),
      Math.ceil(this.texH / 8),
    );
    pass.end();
    device.queue.submit([enc.finish()]);
    paramBuf.destroy();
  }

  private ensureBlitPipeline(device: GPUDevice): void {
    if (this.blitPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var src: texture_2d<f32>;
      @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: vec4i; // dx, dy, texW, texH

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let w = params.z;
        let h = params.w;
        let ix = i32(gid.x);
        let iy = i32(gid.y);
        if (ix >= w || iy >= h) { return; }

        let sx = ix - params.x;
        let sy = iy - params.y;

        if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
          let c = textureLoad(src, vec2i(sx, sy), 0);
          textureStore(dst, vec2i(ix, iy), c);
        } else {
          textureStore(dst, vec2i(ix, iy), vec4f(0.0));
        }
      }
    `;

    const module = device.createShaderModule({ code });
    this.blitBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' } },
      ],
    });
    this.blitPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBGL] }),
      compute: { module, entryPoint: 'main' },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private destroyStaging(): void {
    this.stagingTexture?.destroy();
    this.stagingTexture = null;
  }

  private getDevice(): GPUDevice | null {
    return this.renderer.getDevice?.() ?? null;
  }

  private getActiveTexture(): GPUTexture | null {
    return this.renderer.rasterPaintEngine?.getActiveTexture?.() ?? null;
  }

  private toTexelCoords(ev: PointerEvent): { x: number; y: number } {
    const world = this.interactionService.toWorldCoords(ev);

    const texSize = this.renderer.getRasterTextureSize?.() ?? {
      w: this.interactionService.canvas.width,
      h: this.interactionService.canvas.height,
    };
    const texW = texSize.w || 1;
    const texH = texSize.h || 1;

    let worldQuadW = 2.0;
    let worldQuadH = 2.0;
    if (this.renderer.getIllustrationMode()) {
      const ib = this.renderer.getIllustrationBounds();
      if (ib && ib.width > 0 && ib.height > 0) {
        worldQuadW = ib.width;
        worldQuadH = ib.height;
      }
    }

    const hw = worldQuadW * 0.5;
    const hh = worldQuadH * 0.5;
    const u = (world.x + hw) / worldQuadW;
    const v = (hh - world.y) / worldQuadH;

    let tx = Math.floor(u * texW);
    let ty = Math.floor(v * texH);
    tx = Math.max(0, Math.min(texW - 1, tx));
    ty = Math.max(0, Math.min(texH - 1, ty));

    return { x: tx, y: ty };
  }

  private eventListenersAttached = false;

  private attachListeners(): void {
    if (this.eventListenersAttached) return;
    const canvas = this.interactionService.canvas;
    canvas.addEventListener('pointerdown', this.downBound);
    canvas.addEventListener('pointermove', this.moveBound);
    canvas.addEventListener('pointerup', this.upBound);
    this.eventListenersAttached = true;
  }

  /** Re-bind pointer listeners to the (possibly new) canvas after a renderer
   *  reinitialize (e.g. Shell → illustration swaps the canvas). */
  public reinitializeEventListeners(): void {
    const canvas = this.interactionService.canvas;
    canvas.removeEventListener('pointerdown', this.downBound);
    canvas.removeEventListener('pointermove', this.moveBound);
    canvas.removeEventListener('pointerup', this.upBound);
    this.eventListenersAttached = false;
    this.attachListeners();
  }
}
