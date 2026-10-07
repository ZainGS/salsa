/**
 * RasterSelectionService — handles pointer events for raster selection tools.
 *
 * Listens to canvas pointer events and converts them into selection operations.
 * Supports rect, ellipse, and lasso tools. Also handles transform drag interactions.
 *
 * Similar to RasterDrawingService, but for selection instead of painting.
 */

import { InteractionService } from './interaction-service';
import { WebGPURenderer } from '../renderer/core/webgpu-renderer';
import { EventEmitter } from '../renderer/util/event-emitter';
import type { RasterSelectionEngine, SelectionTool, SelectionInfo, SelectionMode } from '../renderer/raster/selection/raster-selection-engine';
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';
import { TouchGestureTracker } from '../renderer/util/touch-gesture-tracker';

type ScaleHandle = 'topLeft' | 'top' | 'topRight' | 'left' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight';

export interface MagicWandOptions {
  tolerance: number;     // 0–255
  contiguous: boolean;   // true = connected region only
  referenceLayerTexture?: GPUTexture;  // sample colors from another layer
}

export class RasterSelectionService {
  private interactionService: InteractionService;
  private renderer: WebGPURenderer;

  public isEnabled = false;
  private activeTool: SelectionTool = 'rect';
  private selectionMode: SelectionMode = 'new';
  private feather: number = 0;

  // Magic wand options
  private magicWandOptions: MagicWandOptions = {
    tolerance: 32,
    contiguous: true,
  };

  // Drag state
  private isDragging = false;
  private isTransformDrag = false;
  private dragStartTexel: { x: number; y: number } | null = null;
  private dragCurrentTexel: { x: number; y: number } | null = null;

  // Accumulated transform offset from previous drags (so second grab doesn't jump)
  private transformBaseX = 0;
  private transformBaseY = 0;

  // Handle-based scaling/rotation state
  private activeHandle: ScaleHandle | 'rotate' | null = null;
  private handleDragInitialBounds: { x: number; y: number; w: number; h: number } | null = null;
  private handleDragInitialScale: { sx: number; sy: number } | null = null;
  private handleDragInitialTranslate: { tx: number; ty: number } | null = null;
  private handleDragInitialRotation: number = 0;

  // Lasso accumulator
  private lassoPoints: Array<{ x: number; y: number }> = [];

  // TOUCH-5 (docs/ui/touch-controls.md): one-finger arbitration — a pinch / two-finger pan never leaves a marquee, a
  // lasso, a deselect, a committed transform or a moved / scaled selection behind. Mouse and pen are unchanged.
  private readonly touches = new TouchGestureTracker();
  /** A finger press not acted on yet: a DRAG once it moves TOUCH_START_PX, the usual click when it lifts first,
   *  nothing at all when a second finger lands first. */
  private touchPress: { pointerId: number; pointerType: string; button: number; clientX: number; clientY: number } | null = null;
  /** The finger driving the drag (its moves only), and whether its pointerdown is still being handled. */
  private dragIsTouch = false;
  private dragPointerId: number | null = null;
  private touchDragStarting = false;
  /** The transform when a finger's transform drag started (a pinch puts it back). */
  private dragStartTransform: NonNullable<SelectionInfo['transform']> | null = null;

  // Bound listeners
  private downBound = (e: PointerEvent) => this.handleDown(e);
  private moveBound = (e: PointerEvent) => this.handleMove(e);
  private upBound = (e: PointerEvent) => this.handleUp(e);
  private cancelBound = (e: PointerEvent) => this.handlePointerCancel(e);

  // Events for UI
  public onSelectionChanged = new EventEmitter<SelectionInfo>();

  constructor(interactionService: InteractionService, renderer: WebGPURenderer) {
    this.interactionService = interactionService;
    this.renderer = renderer;
    this.attachListeners();
  }

  // ── Public config API ─────────────────────────────────────────────

  public enable() { this.isEnabled = true; }
  public disable() { this.isEnabled = false; }

  public setTool(tool: SelectionTool): void {
    this.activeTool = tool;
    // Also update the engine so SelectionInfo includes the active tool
    const engine = this.getEngine();
    if (engine) engine.selectionTool = tool;
  }

  public getTool(): SelectionTool {
    return this.activeTool;
  }

  public setFeather(px: number): void {
    this.feather = Math.max(0, px);
  }

  /** Set the selection mode: 'new' replaces, 'add' unions, 'subtract' removes from existing. */
  public setMode(mode: SelectionMode): void {
    this.selectionMode = mode;
  }

  public getMode(): SelectionMode {
    return this.selectionMode;
  }

  /** Configure magic wand options (tolerance, contiguous, reference texture). */
  public setMagicWandOptions(opts: Partial<MagicWandOptions>): void {
    if (opts.tolerance !== undefined) this.magicWandOptions.tolerance = opts.tolerance;
    if (opts.contiguous !== undefined) this.magicWandOptions.contiguous = opts.contiguous;
    if (opts.referenceLayerTexture !== undefined) this.magicWandOptions.referenceLayerTexture = opts.referenceLayerTexture;
  }

  public getMagicWandOptions(): MagicWandOptions {
    return { ...this.magicWandOptions };
  }

  /** The active selection's GPU mask texture (r8unorm, 1 = selected), or null when no engine/selection.
   *  Consumers (flood fill, filters) pass this as their selectionMask so edits respect the selection. */
  public getMaskTexture(): GPUTexture | null {
    return this.getEngine()?.getMaskTexture() ?? null;
  }

  // ── Convenience: selection operations ─────────────────────────────

  public async selectAll(): Promise<void> {
    await this.getEngine()?.selectAll();
    this.emitChanged();
  }

  public async deselectAll(): Promise<void> {
    await this.getEngine()?.deselectAll();
    this.emitChanged();
  }

  public async invertSelection(): Promise<void> {
    await this.getEngine()?.invertSelection();
    this.emitChanged();
  }

  public async deleteSelection(): Promise<void> {
    await this.getEngine()?.deleteSelection();
  }

  public async cut(): Promise<void> {
    await this.getEngine()?.cutSelection();
    this.emitChanged();
  }

  public async copy(): Promise<void> {
    await this.getEngine()?.copySelection();
  }

  public paste(): void {
    this.getEngine()?.paste();
    this.emitChanged();
  }

  public async beginTransform(): Promise<void> {
    await this.getEngine()?.beginTransform();
    this.emitChanged();
  }

  public async commitTransform(): Promise<void> {
    await this.getEngine()?.commitTransform();
    this.emitChanged();
  }

  public cancelTransform(): void {
    this.getEngine()?.cancelTransform();
    this.emitChanged();
  }

  public getSelectionInfo(): SelectionInfo {
    return this.getEngine()?.getSelectionInfo() ?? {
      hasSelection: false,
      bounds: null,
      isTransforming: false,
      transform: null,
      dragPreview: null,
      tool: this.activeTool,
      lassoPoints: null,
    };
  }

  public destroy(): void {
    const canvas = this.interactionService.canvas;
    removeZonelessListener(canvas, 'pointerdown', this.downBound);
    removeZonelessListener(canvas, 'pointermove', this.moveBound);
    removeZonelessListener(canvas, 'pointerup', this.upBound);
    removeZonelessListener(canvas, 'pointercancel', this.cancelBound);
  }

  // ── Touch arbitration (TOUCH-5) ───────────────────────────────────

  private async handleDown(ev: PointerEvent): Promise<void> {
    const verdict = this.touches.down(ev);
    if (verdict === 'gesture') { this.cancelTouchDrag(); return; }
    if (verdict === 'ignore') return;
    if (ev.pointerType !== 'touch') return this.onPointerDown(ev);
    if (!this.isEnabled || ev.button !== 0 || this.isDragging || this.touchPress) return;
    // Nothing happens yet: committing a transform / starting a marquee waits until the finger moves or lifts.
    this.touchPress = { pointerId: ev.pointerId, pointerType: ev.pointerType, button: ev.button, clientX: ev.clientX, clientY: ev.clientY };
  }

  private async handleMove(ev: PointerEvent): Promise<void> {
    if (ev.pointerType === 'touch') {
      if (this.touches.blocked || this.touchDragStarting) return;
      const p = this.touchPress;
      if (p) {
        if (ev.pointerId !== p.pointerId) return;
        if (Math.hypot(ev.clientX - p.clientX, ev.clientY - p.clientY) < TouchGestureTracker.TOUCH_START_PX) return;
        this.touchPress = null;
        await this.startTouchDrag(p);
      }
      if (this.dragIsTouch && ev.pointerId !== this.dragPointerId) return;
    } else if (this.dragIsTouch) return;
    this.onPointerMove(ev);
  }

  private async handleUp(ev: PointerEvent): Promise<void> {
    this.touches.up(ev);
    if (ev.pointerType === 'touch') {
      const p = this.touchPress;
      if (p && p.pointerId === ev.pointerId) {
        // A tap: the click it always was (deselect / magic wand / commit outside / enter transform).
        this.touchPress = null;
        await this.onPointerDown(p as unknown as PointerEvent);
        await this.onPointerUp(ev);
        return;
      }
      if (this.dragIsTouch && ev.pointerId !== this.dragPointerId) return;
    } else if (this.dragIsTouch) return;
    await this.onPointerUp(ev);
    if (!this.isDragging) { this.dragIsTouch = false; this.dragPointerId = null; this.dragStartTransform = null; }
  }

  /** pointercancel: a finger press / drag is dropped and put back (mouse / pen: no change — not handled, as before). */
  private handlePointerCancel(ev: PointerEvent): void {
    this.touches.up(ev);
    if (ev.pointerType !== 'touch') return;
    if (this.touchPress?.pointerId === ev.pointerId) this.touchPress = null;
    if (this.dragIsTouch && ev.pointerId === this.dragPointerId) this.cancelTouchDrag();
  }

  private async startTouchDrag(p: NonNullable<RasterSelectionService['touchPress']>): Promise<void> {
    this.dragIsTouch = true;
    this.dragPointerId = p.pointerId;
    this.touchDragStarting = true;
    try { await this.onPointerDown(p as unknown as PointerEvent); }
    finally { this.touchDragStarting = false; }
    const t = this.isTransformDrag ? this.getEngine()?.getSelectionInfo().transform : null;
    this.dragStartTransform = t ? { ...t } : null;
    if (!this.isDragging) { this.dragIsTouch = false; this.dragPointerId = null; return; }
    if (this.touches.blocked) this.cancelTouchDrag();   // a second finger landed while the press was handled
  }

  /** A second finger (or pointercancel) during a FINGER drag: drop the marquee / lasso, or put the transform back
   *  where the drag found it. No selection change, no deselect, no commit. A mouse / pen drag is left alone. */
  private cancelTouchDrag(): void {
    this.touchPress = null;
    if (!this.dragIsTouch) return;
    this.dragIsTouch = false;
    this.dragPointerId = null;
    if (!this.isDragging) return;
    const engine = this.getEngine();
    const s = this.dragStartTransform;
    if (this.isTransformDrag) {
      if (engine && s) engine.updateTransform(s.translateX, s.translateY, s.scaleX, s.scaleY, s.rotation);
    } else if (engine) {
      engine.dragPreview = null;
      engine.dragLassoPoints = null;
    }
    this.isDragging = false;
    this.isTransformDrag = false;
    this.activeHandle = null;
    this.handleDragInitialBounds = null;
    this.handleDragInitialScale = null;
    this.handleDragInitialTranslate = null;
    this.dragStartTexel = null;
    this.dragCurrentTexel = null;
    this.dragStartTransform = null;
    this.lassoPoints = [];
    this.renderer.scheduleRender();
    this.emitChanged();
  }

  // ── Pointer event handlers ────────────────────────────────────────

  /**
   * Hit-test the 8 scale handles + rotation zone above the selection.
   * Returns the handle name, 'rotate', or null if no handle was hit.
   * Handle hit radius is ~8 texels.
   */
  private hitTestHandle(
    texel: { x: number; y: number },
    bounds: { x: number; y: number; w: number; h: number },
    state: { translateX: number; translateY: number; scaleX: number; scaleY: number } | null,
  ): ScaleHandle | 'rotate' | null {
    const tx = state?.translateX ?? 0;
    const ty = state?.translateY ?? 0;
    const sx = state?.scaleX ?? 1;
    const sy = state?.scaleY ?? 1;
    const bx = bounds.x + tx;
    const by = bounds.y + ty;
    const bw = bounds.w * sx;
    const bh = bounds.h * sy;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;

    // Handle threshold in texels (match the 6-texel visual size + some padding)
    const ht = Math.max(8, Math.min(bw, bh) * 0.08);

    const handles: Array<{ name: ScaleHandle; hx: number; hy: number }> = [
      { name: 'topLeft',     hx: bx,        hy: by },
      { name: 'top',         hx: cx,        hy: by },
      { name: 'topRight',    hx: bx + bw,   hy: by },
      { name: 'left',        hx: bx,        hy: cy },
      { name: 'right',       hx: bx + bw,   hy: cy },
      { name: 'bottomLeft',  hx: bx,        hy: by + bh },
      { name: 'bottom',      hx: cx,        hy: by + bh },
      { name: 'bottomRight', hx: bx + bw,   hy: by + bh },
    ];

    for (const h of handles) {
      const dx = texel.x - h.hx;
      const dy = texel.y - h.hy;
      if (dx * dx + dy * dy <= ht * ht) return h.name;
    }

    // Rotation zone: above top-center
    const rotDx = texel.x - cx;
    const rotDy = texel.y - (by - ht * 2.5);
    if (rotDx * rotDx + rotDy * rotDy <= (ht * 1.5) * (ht * 1.5)) return 'rotate';

    return null;
  }

  private async onPointerDown(ev: PointerEvent): Promise<void> {
    if (!this.isEnabled || ev.button !== 0) return;
    const engine = this.getEngine();
    if (!engine) return;

    const texel = this.toTexelCoords(ev);
    this.dragStartTexel = texel;
    this.dragCurrentTexel = texel;

    const info = engine.getSelectionInfo();

    // ── Active transform: handle hit → scale/rotate, inside → translate, outside → commit
    if (info.isTransforming && info.bounds) {
      const b = info.bounds;
      const state = info.transform;

      // First check handles
      const handle = this.hitTestHandle(texel, b, state ?? null);
      if (handle) {
        this.isDragging = true;
        this.isTransformDrag = true;
        this.activeHandle = handle;
        this.handleDragInitialBounds = { ...b };
        this.handleDragInitialScale = { sx: state?.scaleX ?? 1, sy: state?.scaleY ?? 1 };
        this.handleDragInitialTranslate = { tx: state?.translateX ?? 0, ty: state?.translateY ?? 0 };
        this.handleDragInitialRotation = state?.rotation ?? 0;
        return;
      }

      // Then check inside bounds (translate drag)
      const bx = b.x + (state?.translateX ?? 0);
      const by = b.y + (state?.translateY ?? 0);
      const bw = b.w * (state?.scaleX ?? 1);
      const bh = b.h * (state?.scaleY ?? 1);
      if (texel.x >= bx && texel.x <= bx + bw && texel.y >= by && texel.y <= by + bh) {
        this.isDragging = true;
        this.isTransformDrag = true;
        this.activeHandle = null;
        // Remember current accumulated offset so we can add to it
        this.transformBaseX = state?.translateX ?? 0;
        this.transformBaseY = state?.translateY ?? 0;
        return;
      }

      // Click outside → commit transform
      await engine.commitTransform();
      this.emitChanged();
    }

    // ── Existing selection (not transforming): click inside → start transform
    if (info.hasSelection && info.bounds && !info.isTransforming) {
      const b = info.bounds;
      if (texel.x >= b.x && texel.x <= b.x + b.w && texel.y >= b.y && texel.y <= b.y + b.h) {
        await engine.beginTransform();
        this.isDragging = true;
        this.isTransformDrag = true;
        this.activeHandle = null;
        this.transformBaseX = 0;
        this.transformBaseY = 0;
        this.emitChanged();
        return;
      }
    }

    // ── Start new selection
    this.isDragging = true;
    this.isTransformDrag = false;
    this.activeHandle = null;

    if (this.activeTool === 'lasso') {
      this.lassoPoints = [texel];
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    if (!this.isEnabled || !this.isDragging || !this.dragStartTexel) return;
    const engine = this.getEngine();
    if (!engine) return;

    const texel = this.toTexelCoords(ev);
    this.dragCurrentTexel = texel;

    if (this.isTransformDrag) {
      const dxPx = texel.x - this.dragStartTexel.x;
      const dyPx = texel.y - this.dragStartTexel.y;

      if (this.activeHandle && this.handleDragInitialBounds && this.handleDragInitialScale && this.handleDragInitialTranslate) {
        const ib = this.handleDragInitialBounds;
        const is = this.handleDragInitialScale;
        const it = this.handleDragInitialTranslate;
        const origW = ib.w;
        const origH = ib.h;

        if (this.activeHandle === 'rotate') {
          // Rotation: angle between drag start and current relative to selection center
          const cx = ib.x + it.tx + (origW * is.sx) / 2;
          const cy = ib.y + it.ty + (origH * is.sy) / 2;
          const startAngle = Math.atan2(this.dragStartTexel.y - cy, this.dragStartTexel.x - cx);
          const curAngle = Math.atan2(texel.y - cy, texel.x - cx);
          const rotation = this.handleDragInitialRotation + (curAngle - startAngle);
          engine.updateTransform(it.tx, it.ty, is.sx, is.sy, rotation);
        } else {
          // Scale handles: compute new scaleX/scaleY + translate offset
          let newSx = is.sx;
          let newSy = is.sy;
          let newTx = it.tx;
          let newTy = it.ty;

          // Horizontal scaling
          if (this.activeHandle.includes('Right') || this.activeHandle === 'right') {
            newSx = Math.max(0.05, is.sx + dxPx / origW);
          } else if (this.activeHandle.includes('Left') || this.activeHandle === 'left') {
            newSx = Math.max(0.05, is.sx - dxPx / origW);
            newTx = it.tx + dxPx; // shift origin to keep right edge fixed
          }

          // Vertical scaling
          if (this.activeHandle.includes('bottom') || this.activeHandle === 'bottom') {
            newSy = Math.max(0.05, is.sy + dyPx / origH);
          } else if (this.activeHandle.includes('top') || this.activeHandle === 'top') {
            newSy = Math.max(0.05, is.sy - dyPx / origH);
            newTy = it.ty + dyPx; // shift origin to keep bottom edge fixed
          }

          engine.updateTransform(newTx, newTy, newSx, newSy);
        }
        return;
      }

      // Plain translate
      const dx = this.transformBaseX + dxPx;
      const dy = this.transformBaseY + dyPx;
      engine.updateTransform(dx, dy);
      return;
    }

    // For lasso, accumulate points
    if (this.activeTool === 'lasso') {
      this.lassoPoints.push(texel);
      // Update engine with in-progress lasso points for live preview
      engine.dragLassoPoints = this.lassoPoints.length >= 2 ? [...this.lassoPoints] : null;
      this.renderer.scheduleRender();
      return;
    }

    // For rect/ellipse, update the drag preview on the engine so the renderer draws it
    if (this.activeTool === 'rect' || this.activeTool === 'ellipse') {
      const s = this.dragStartTexel;
      const c = texel;
      const preview = {
        x: Math.min(s.x, c.x),
        y: Math.min(s.y, c.y),
        w: Math.abs(c.x - s.x),
        h: Math.abs(c.y - s.y),
      };
      if (preview.w > 1 && preview.h > 1) {
        engine.dragPreview = preview;
      }
    }
    this.renderer.scheduleRender();
  }

  private async onPointerUp(ev: PointerEvent): Promise<void> {
    if (!this.isEnabled || !this.isDragging) return;
    const engine = this.getEngine();
    if (!engine) return;

    const texel = this.toTexelCoords(ev);

    if (this.isTransformDrag) {
      if (!this.activeHandle) {
        // Finalize translate
        const dx = this.transformBaseX + (texel.x - this.dragStartTexel!.x);
        const dy = this.transformBaseY + (texel.y - this.dragStartTexel!.y);
        engine.updateTransform(dx, dy);
      }
      // For handle drags, the last onPointerMove already set the final state
      this.isDragging = false;
      this.isTransformDrag = false;
      this.activeHandle = null;
      this.handleDragInitialBounds = null;
      this.handleDragInitialScale = null;
      this.handleDragInitialTranslate = null;
      this.emitChanged();
      return;
    }

    // Finalize selection
    if (this.activeTool === 'magic-wand') {
      // Magic wand is click-based: single click selects the region
      const opts = this.magicWandOptions;
      await engine.selectMagicWand(
        texel.x, texel.y,
        opts.tolerance, opts.contiguous,
        this.selectionMode,
        opts.referenceLayerTexture,
      );
    } else if (this.activeTool === 'lasso') {
      if (this.lassoPoints.length >= 3) {
        await engine.selectLasso(this.lassoPoints, this.selectionMode);
      }
      this.lassoPoints = [];
      engine.dragLassoPoints = null;
    } else {
      // rect or ellipse
      const start = this.dragStartTexel!;
      const x = Math.min(start.x, texel.x);
      const y = Math.min(start.y, texel.y);
      const w = Math.abs(texel.x - start.x);
      const h = Math.abs(texel.y - start.y);

      if (w > 1 && h > 1) {
        if (this.activeTool === 'rect') {
          await engine.selectRect({ x, y, w, h }, this.feather, this.selectionMode);
        } else {
          await engine.selectEllipse({ x, y, w, h }, this.feather, this.selectionMode);
        }
      } else {
        // Click without drag → deselect
        await engine.deselectAll();
      }
    }

    this.isDragging = false;
    this.dragStartTexel = null;
    this.dragCurrentTexel = null;
    // Clear drag preview since the selection is now finalized
    if (engine) engine.dragPreview = null;
    this.emitChanged();
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private getEngine(): RasterSelectionEngine | undefined {
    return this.renderer.rasterSelectionEngine;
  }

  /** Get the in-progress drag rect (for UI preview rendering). */
  public getDragPreview(): { x: number; y: number; w: number; h: number } | null {
    if (!this.isDragging || !this.dragStartTexel || !this.dragCurrentTexel || this.isTransformDrag) {
      return null;
    }
    const s = this.dragStartTexel;
    const c = this.dragCurrentTexel;
    return {
      x: Math.min(s.x, c.x),
      y: Math.min(s.y, c.y),
      w: Math.abs(c.x - s.x),
      h: Math.abs(c.y - s.y),
    };
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

  private emitChanged(): void {
    const info = this.getSelectionInfo();
    this.onSelectionChanged.emit(info);
  }

  private eventListenersAttached = false;

  private attachListeners(): void {
    if (this.eventListenersAttached) return;
    const canvas = this.interactionService.canvas;
    addZonelessListener(canvas, 'pointerdown', this.downBound);
    addZonelessListener(canvas, 'pointermove', this.moveBound);
    addZonelessListener(canvas, 'pointerup', this.upBound);
    addZonelessListener(canvas, 'pointercancel', this.cancelBound);
    this.eventListenersAttached = true;
  }

  /** Re-bind pointer listeners to the (possibly new) canvas after a renderer
   *  reinitialize (e.g. Shell → illustration swaps the canvas). */
  public reinitializeEventListeners(): void {
    const canvas = this.interactionService.canvas;
    removeZonelessListener(canvas, 'pointerdown', this.downBound);
    removeZonelessListener(canvas, 'pointermove', this.moveBound);
    removeZonelessListener(canvas, 'pointerup', this.upBound);
    removeZonelessListener(canvas, 'pointercancel', this.cancelBound);
    this.eventListenersAttached = false;
    this.touches.reset();
    this.attachListeners();
  }
}
