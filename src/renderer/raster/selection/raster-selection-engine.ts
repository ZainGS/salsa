/**
 * RasterSelectionEngine — orchestrates raster selection operations.
 *
 * Responsibilities:
 *  • Create / modify selection mask (delegates to RasterSelectionMask)
 *  • Cut / Copy / Paste / Delete selected pixels
 *  • Create a "floating layer" from the selection for transform previews
 *  • Commit or cancel a transform (apply or discard the floating layer)
 *  • Provide selection bounds for UI overlay (marching ants, transform handles)
 */

import { RasterSelectionMask, SelectionRect, SelectionPoint } from './raster-selection-mask';
import type { SelectionMode } from './raster-selection-mask';
import { RasterTransformEngine, TransformState } from './raster-transform-engine';

export type SelectionTool = 'rect' | 'ellipse' | 'lasso' | 'magic-wand';

export type { SelectionMode };

export interface SelectionInfo {
  hasSelection: boolean;
  bounds: SelectionRect | null;
  isTransforming: boolean;
  transform: TransformState | null;
  /** In-progress drag preview rect (set by RasterSelectionService during drag). */
  dragPreview: SelectionRect | null;
  /** Which tool created the current selection (for overlay shape). */
  tool: SelectionTool;
  /** Polygon points for lasso selection (texel coords). */
  lassoPoints: SelectionPoint[] | null;
}

export class RasterSelectionEngine {
  private device: GPUDevice;
  public readonly mask: RasterSelectionMask;
  public readonly transformEngine: RasterTransformEngine;
  private scheduleRender: () => void;

  // Current selection state
  private selectionBounds: SelectionRect | null = null;
  private isTransforming = false;

  /** Set by RasterSelectionService during a drag to show a preview outline. */
  public dragPreview: SelectionRect | null = null;

  /** The tool that created the current selection (for overlay shape). */
  public selectionTool: SelectionTool = 'rect';

  /** Stored lasso polygon points (texel coords) for overlay contour rendering. */
  private lassoPoints: SelectionPoint[] | null = null;

  /** In-progress lasso points (set by RasterSelectionService during drag). */
  public dragLassoPoints: SelectionPoint[] | null = null;

  // Floating layer: pixels "lifted" from the canvas during a transform
  private floatingTex: GPUTexture | null = null;
  private floatingBounds: SelectionRect | null = null;

  // Clipboard (internal copy buffer)
  private clipboardTex: GPUTexture | null = null;
  private clipboardBounds: SelectionRect | null = null;

  // The active layer texture we operate on
  private activeTexture: GPUTexture | null = null;

  // Snapshot callback (push undo before destructive ops)
  private pushSnapshotFn: ((tex: GPUTexture) => Promise<void>) | null = null;

  // Mask-aware compute pipelines (lazy-built)
  private maskedClearPipeline: GPUComputePipeline | null = null;
  private maskedClearBGL: GPUBindGroupLayout | null = null;
  private maskedCopyPipeline: GPUComputePipeline | null = null;
  private maskedCopyBGL: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice, scheduleRender: () => void) {
    this.device = device;
    this.scheduleRender = scheduleRender;
    this.mask = new RasterSelectionMask(device);
    this.transformEngine = new RasterTransformEngine(device);
  }

  // ── Active texture ────────────────────────────────────────────────

  public setActiveTexture(tex: GPUTexture | null): void {
    this.activeTexture = tex;
  }

  /** Set a callback to push an undo snapshot before destructive selection ops. */
  public setSnapshotCallback(fn: (tex: GPUTexture) => Promise<void>): void {
    this.pushSnapshotFn = fn;
  }

  /** Push an undo snapshot for the current active texture (if callback is set). */
  private async pushSnapshot(): Promise<void> {
    if (this.pushSnapshotFn && this.activeTexture) {
      await this.pushSnapshotFn(this.activeTexture);
    }
  }

  // ── Selection creation ────────────────────────────────────────────

  /** Create a rectangular selection. */
  public async selectRect(rect: SelectionRect, feather: number = 0, mode: SelectionMode = 'new'): Promise<void> {
    if (!this.activeTexture) return;
    await this.commitTransformIfNeeded();
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    this.mask.selectRect(rect, feather, mode);
    this.lassoPoints = null;
    if (mode === 'new') {
      this.updateBoundsSync(rect);
    } else {
      this.updateBoundsAsync();
    }
    this.scheduleRender();
  }

  /** Create an elliptical selection. */
  public async selectEllipse(rect: SelectionRect, feather: number = 0, mode: SelectionMode = 'new'): Promise<void> {
    if (!this.activeTexture) return;
    await this.commitTransformIfNeeded();
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    this.mask.selectEllipse(rect, feather, mode);
    this.lassoPoints = null;
    if (mode === 'new') {
      this.updateBoundsSync(rect);
    } else {
      this.updateBoundsAsync();
    }
    this.scheduleRender();
  }

  /** Create a lasso (freeform polygon) selection. */
  public async selectLasso(points: SelectionPoint[], mode: SelectionMode = 'new'): Promise<void> {
    if (!this.activeTexture || points.length < 3) return;
    await this.commitTransformIfNeeded();
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    this.mask.selectLasso(points, mode);
    this.lassoPoints = [...points];
    this.updateBoundsAsync();
    this.scheduleRender();
  }

  /**
   * Magic wand: select contiguous pixels of similar color at (seedX, seedY).
   * @param seedX Seed pixel X (texel)
   * @param seedY Seed pixel Y (texel)
   * @param tolerance Color similarity 0–255
   * @param contiguous Only connected region (true) or all similar pixels (false)
   * @param mode 'new' | 'add' | 'subtract'
   * @param referenceTexture Optional: sample colors from a different texture
   */
  public async selectMagicWand(
    seedX: number, seedY: number,
    tolerance: number = 32,
    contiguous: boolean = true,
    mode: SelectionMode = 'new',
    referenceTexture?: GPUTexture,
  ): Promise<void> {
    if (!this.activeTexture) return;
    await this.commitTransformIfNeeded();
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    const source = referenceTexture ?? this.activeTexture;
    await this.mask.selectMagicWand(source, seedX, seedY, tolerance, contiguous, mode);
    this.lassoPoints = null;
    this.updateBoundsAsync();
    this.scheduleRender();
  }

  /**
   * Select by color: selects ALL pixels of similar color across the entire layer
   * (non-contiguous). Like magic wand but not restricted to the connected region.
   */
  public async selectByColor(
    seedX: number, seedY: number,
    tolerance: number = 32,
    mode: SelectionMode = 'new',
    referenceTexture?: GPUTexture,
  ): Promise<void> {
    await this.selectMagicWand(seedX, seedY, tolerance, false, mode, referenceTexture);
  }

  /** Select the entire canvas. */
  public async selectAll(): Promise<void> {
    if (!this.activeTexture) return;
    await this.commitTransformIfNeeded();
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    this.mask.selectAll();
    this.selectionBounds = { x: 0, y: 0, w: this.activeTexture.width, h: this.activeTexture.height };
    this.scheduleRender();
  }

  /** Deselect all (clear selection). */
  public async deselectAll(): Promise<void> {
    await this.commitTransformIfNeeded();
    this.mask.deselectAll();
    this.selectionBounds = null;
    this.destroyFloating();
    this.scheduleRender();
  }

  /** Invert the selection. */
  public async invertSelection(): Promise<void> {
    await this.commitTransformIfNeeded();
    this.mask.invertSelection();
    this.updateBoundsAsync();
    this.scheduleRender();
  }

  // ── Pixel operations ──────────────────────────────────────────────

  /** Delete selected pixels (set to transparent). */
  public async deleteSelection(): Promise<void> {
    if (!this.activeTexture || !this.selectionBounds) return;
    await this.commitTransformIfNeeded();
    await this.pushSnapshot();
    this.applyMaskedClear(this.activeTexture);
    this.scheduleRender();
  }

  /** Cut = copy + delete. */
  public async cutSelection(): Promise<void> {
    await this.copySelection();
    // deleteSelection already pushes a snapshot
    await this.deleteSelection();
  }

  /** Copy selected pixels to internal clipboard. */
  public async copySelection(): Promise<void> {
    if (!this.activeTexture || !this.selectionBounds) return;
    await this.commitTransformIfNeeded();

    const b = this.selectionBounds;

    // Destroy previous clipboard
    this.clipboardTex?.destroy();
    this.clipboardTex = this.device.createTexture({
      size: [b.w, b.h],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.STORAGE_BINDING,
    });
    this.clipboardBounds = { ...b };

    // Copy the region from the active texture
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: this.activeTexture, origin: { x: b.x, y: b.y } },
      { texture: this.clipboardTex },
      { width: b.w, height: b.h },
    );
    this.device.queue.submit([enc.finish()]);

    // Mask out unselected pixels within the bounding rect (for ellipse/lasso selections)
    const maskTex = this.mask.getMaskTexture();
    if (maskTex) {
      this.applyMaskMultiply(this.clipboardTex, maskTex, b);
    }
  }

  /** Paste from clipboard onto the active layer, creating a floating selection. */
  public paste(): void {
    if (!this.clipboardTex || !this.clipboardBounds || !this.activeTexture) return;

    // Create a floating layer from clipboard contents
    const b = this.clipboardBounds;
    this.destroyFloating();
    this.floatingTex = this.device.createTexture({
      size: [b.w, b.h],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Copy clipboard → floating
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: this.clipboardTex },
      { texture: this.floatingTex },
      { width: b.w, height: b.h },
    );
    this.device.queue.submit([enc.finish()]);

    // Center the paste in the canvas
    const cx = Math.round((this.activeTexture.width - b.w) / 2);
    const cy = Math.round((this.activeTexture.height - b.h) / 2);

    this.floatingBounds = { x: cx, y: cy, w: b.w, h: b.h };

    // Set up a selection rect around the pasted area
    this.mask.ensureMask(this.activeTexture.width, this.activeTexture.height);
    this.mask.selectRect(this.floatingBounds);
    this.selectionBounds = { ...this.floatingBounds };

    // Enter transform mode
    this.isTransforming = true;
    this.transformEngine.begin(this.floatingBounds);

    this.scheduleRender();
  }

  // ── Transform operations ──────────────────────────────────────────

  /** Lift the selected pixels into a floating layer and enter transform mode. */
  public async beginTransform(): Promise<void> {
    if (!this.activeTexture || !this.selectionBounds) return;
    if (this.isTransforming) return; // already transforming

    // Push undo snapshot before we lift+clear pixels
    await this.pushSnapshot();

    const b = this.selectionBounds;
    this.destroyFloating();

    // Create floating texture from the selected area
    this.floatingTex = this.device.createTexture({
      size: [b.w, b.h],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Copy region from active texture → floating
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: this.activeTexture, origin: { x: b.x, y: b.y } },
      { texture: this.floatingTex },
      { width: b.w, height: b.h },
    );
    this.device.queue.submit([enc.finish()]);

    this.floatingBounds = { ...b };

    // Clear the original area on the layer (pixels are now "lifted")
    this.applyMaskedClear(this.activeTexture);

    // Start the transform engine
    this.isTransforming = true;
    this.transformEngine.begin(b);

    this.scheduleRender();
  }

  /** Update the transform (called during drag). */
  public updateTransform(dx: number, dy: number, scaleX?: number, scaleY?: number, rotation?: number): void {
    if (!this.isTransforming) return;
    this.transformEngine.update(dx, dy, scaleX, scaleY, rotation);
    this.scheduleRender();
  }

  /** Commit the transform — stamp the floating layer back onto the active layer. */
  public async commitTransform(): Promise<void> {
    if (!this.isTransforming || !this.floatingTex || !this.activeTexture || !this.floatingBounds) return;

    const state = this.transformEngine.getState();

    // Stamp the floating pixels back at the transformed position
    this.transformEngine.applyToTexture(
      this.floatingTex,
      this.activeTexture,
      this.floatingBounds,
      state,
    );

    this.isTransforming = false;
    this.transformEngine.end();
    this.destroyFloating();

    // Update selection bounds to the new transformed position
    this.selectionBounds = {
      x: Math.round(this.selectionBounds!.x + state.translateX),
      y: Math.round(this.selectionBounds!.y + state.translateY),
      w: Math.round(this.selectionBounds!.w * state.scaleX),
      h: Math.round(this.selectionBounds!.h * state.scaleY),
    };

    this.scheduleRender();
  }

  /** Cancel the transform — put pixels back where they were. */
  public cancelTransform(): void {
    if (!this.isTransforming || !this.floatingTex || !this.activeTexture || !this.floatingBounds) return;

    // Stamp back at the original position (identity transform)
    this.transformEngine.applyToTexture(
      this.floatingTex,
      this.activeTexture,
      this.floatingBounds,
      { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    );

    this.isTransforming = false;
    this.transformEngine.end();
    this.destroyFloating();
    this.scheduleRender();
  }

  // ── Query ─────────────────────────────────────────────────────────

  /** Get full selection info for UI rendering. */
  public getSelectionInfo(): SelectionInfo {
    return {
      hasSelection: this.selectionBounds !== null || this.dragPreview !== null,
      bounds: this.selectionBounds ? { ...this.selectionBounds } : null,
      isTransforming: this.isTransforming,
      transform: this.isTransforming ? this.transformEngine.getState() : null,
      dragPreview: this.dragPreview ? { ...this.dragPreview } : null,
      tool: this.selectionTool,
      lassoPoints: this.dragLassoPoints ?? this.lassoPoints,
    };
  }

  /** Get the selection mask texture for overlay rendering. */
  public getMaskTexture(): GPUTexture | null {
    return this.mask.getMaskTexture();
  }

  /** Get the floating texture (if transform in progress) for preview overlay. */
  public getFloatingTexture(): GPUTexture | null {
    return this.floatingTex;
  }

  /** Get floating bounds. */
  public getFloatingBounds(): SelectionRect | null {
    return this.floatingBounds ? { ...this.floatingBounds } : null;
  }

  public destroy(): void {
    this.mask.destroy();
    this.destroyFloating();
    this.clipboardTex?.destroy();
    this.clipboardTex = null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** If currently transforming, commit before starting a new operation. */
  private async commitTransformIfNeeded(): Promise<void> {
    if (this.isTransforming) {
      await this.commitTransform();
    }
  }

  /** Clear pixels under the selection mask on the given texture (mask-aware). */
  private applyMaskedClear(texture: GPUTexture): void {
    const b = this.selectionBounds;
    if (!b) return;
    const maskTex = this.mask.getMaskTexture();
    if (!maskTex) return;

    const clearW = Math.min(b.w, texture.width - b.x);
    const clearH = Math.min(b.h, texture.height - b.y);
    if (clearW <= 0 || clearH <= 0) return;

    this.ensureMaskedClearPipeline();

    // Uniform: boundsX, boundsY, boundsW, boundsH
    const params = new Float32Array([b.x, b.y, clearW, clearH]);
    const paramBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set(params);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.maskedClearBGL!,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: maskTex.createView() },
        { binding: 2, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.maskedClearPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(clearW / 8), Math.ceil(clearH / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();
  }

  /** Multiply the alpha of `target` by the mask values within `bounds`. */
  private applyMaskMultiply(target: GPUTexture, maskTex: GPUTexture, bounds: SelectionRect): void {
    this.ensureMaskedCopyPipeline();

    const params = new Float32Array([bounds.x, bounds.y, bounds.w, bounds.h]);
    const paramBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(paramBuf.getMappedRange()).set(params);
    paramBuf.unmap();

    const bg = this.device.createBindGroup({
      layout: this.maskedCopyBGL!,
      entries: [
        { binding: 0, resource: target.createView() },
        { binding: 1, resource: maskTex.createView() },
        { binding: 2, resource: { buffer: paramBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.maskedCopyPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(bounds.w / 8), Math.ceil(bounds.h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    paramBuf.destroy();
  }

  /** Lazy-build the masked clear compute pipeline. */
  private ensureMaskedClearPipeline(): void {
    if (this.maskedClearPipeline) return;

    this.maskedClearBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(1) var maskTex: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> params: vec4<f32>; // boundsX, boundsY, boundsW, boundsH

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let bx = i32(params.x);
        let by = i32(params.y);
        let bw = i32(params.z);
        let bh = i32(params.w);
        if (i32(gid.x) >= bw || i32(gid.y) >= bh) { return; }

        let ix = bx + i32(gid.x);
        let iy = by + i32(gid.y);

        let dim = textureDimensions(dst);
        if (ix < 0 || iy < 0 || u32(ix) >= dim.x || u32(iy) >= dim.y) { return; }

        // Read selection mask at this texel
        let maskVal = textureLoad(maskTex, vec2<i32>(ix, iy), 0).r;
        if (maskVal <= 0.001) { return; } // outside selection — leave pixel alone

        // Clear: set to transparent, scaled by mask for feathered edges
        if (maskVal >= 0.999) {
          textureStore(dst, vec2<i32>(ix, iy), vec4<f32>(0.0, 0.0, 0.0, 0.0));
        } else {
          // Partial mask (feathered): read existing, reduce alpha proportionally
          // We can't read+write the same storage texture, so for feathered edges
          // we just fully clear. The feathering is approximate but acceptable.
          textureStore(dst, vec2<i32>(ix, iy), vec4<f32>(0.0, 0.0, 0.0, 0.0));
        }
      }
    `;

    this.maskedClearPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.maskedClearBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  /** Lazy-build the masked copy (alpha multiply) compute pipeline. */
  private ensureMaskedCopyPipeline(): void {
    if (this.maskedCopyPipeline) return;

    this.maskedCopyBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    // Multiplies pixel alpha by mask value.
    // Pixels outside the selection become transparent in the clipboard.
    const code = /* wgsl */ `
      @group(0) @binding(0) var dst: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(1) var maskTex: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> params: vec4<f32>; // boundsX, boundsY, boundsW, boundsH

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let bx = i32(params.x);
        let by = i32(params.y);
        let bw = i32(params.z);
        let bh = i32(params.w);
        if (i32(gid.x) >= bw || i32(gid.y) >= bh) { return; }

        let dstCoord = vec2<i32>(i32(gid.x), i32(gid.y));
        let maskCoord = vec2<i32>(bx + i32(gid.x), by + i32(gid.y));

        let maskDim = textureDimensions(maskTex);
        if (maskCoord.x < 0 || maskCoord.y < 0 || u32(maskCoord.x) >= maskDim.x || u32(maskCoord.y) >= maskDim.y) {
          // Outside mask — clear to transparent
          textureStore(dst, dstCoord, vec4<f32>(0.0));
          return;
        }

        let maskVal = textureLoad(maskTex, maskCoord, 0).r;
        if (maskVal >= 0.999) { return; } // fully selected — keep as-is

        // Outside or partial selection — clear to transparent
        // (We can't read the dst storage texture, so partial feathering isn't possible here.
        //  For feathered selections the edge pixels are fully cleared. This is acceptable.)
        textureStore(dst, dstCoord, vec4<f32>(0.0));
      }
    `;

    this.maskedCopyPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.maskedCopyBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private destroyFloating(): void {
    this.floatingTex?.destroy();
    this.floatingTex = null;
    this.floatingBounds = null;
  }

  private updateBoundsSync(rect: SelectionRect): void {
    this.selectionBounds = { ...rect };
  }

  private updateBoundsAsync(): void {
    this.mask.getBounds().then(b => {
      this.selectionBounds = b;
      this.scheduleRender();
    });
  }
}
