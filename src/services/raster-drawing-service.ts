import { InteractionService } from "./interaction-service";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import { RGBA } from "../types/rgba";
import { EventEmitter } from "../renderer/util/event-emitter";
import { RasterPaintEngine } from "../renderer/raster/core/raster-paint-engine";
import { PointerInput } from "../renderer/raster/brushes/brush-engine";

export class RasterDrawingService {
  private interactionService: InteractionService;
  private renderer: WebGPURenderer;
  private sceneGraph: SceneGraph;
  public isEnabled = false;
  private isDrawing = false;
  private brushColor: RGBA = { r: 1.0, g: 0, b: 0, a: 1.0 };
  private brushRadiusPx = 32; // in pixels (texel space) — used as maxSize for legacy compat
  // tool mode: 'paint' | 'erase' | 'clear'
  private toolMode: 'paint' | 'erase' | 'clear' = 'paint';
  private eraserHard: boolean = false;
  private lastTex: { x: number, y: number } | null = null;
  private lastPressure: number = 1;

  private startBound = (e: PointerEvent) => this.start(e);
  private moveBound = (e: PointerEvent) => this.move(e);
  private upBound = (e: PointerEvent) => this.end(e);

  // stroke events emitted for external UI
  public onStrokeStart = new EventEmitter<any>();
  public onStrokeUpdate = new EventEmitter<any>();
  public onStrokeEnd = new EventEmitter<any>();

  constructor(interactionService: InteractionService, renderer: WebGPURenderer, sceneGraph: SceneGraph) {
    this.interactionService = interactionService;
    this.renderer = renderer;
    this.sceneGraph = sceneGraph;
    this.attachListeners();
  }

  // ── Public brush config API ───────────────────────────────────────

  public setBrushColor(c: RGBA) {
    this.brushColor = c;
    this.getPaintEngine()?.setBrushColor(c.r, c.g, c.b, c.a ?? 1);
  }

  public setBrushRadiusPx(r: number) { this.brushRadiusPx = Math.max(1, r | 0); }

  public setEraserMode(mode: 'erase' | 'clear' | 'paint') {
    this.toolMode = mode === 'clear' ? 'clear' : mode === 'erase' ? 'erase' : 'paint';
    const engine = this.getPaintEngine();
    if (engine) {
      if (this.toolMode === 'paint') engine.setEraseMode(null);
      else if (this.toolMode === 'erase') engine.setEraseMode(this.eraserHard ? 3 : 1);
      else engine.setEraseMode(2);
    }
  }

  public setEraserHard(hard: boolean) {
    this.eraserHard = !!hard;
    // Re-apply erase mode in case it changed
    if (this.toolMode !== 'paint') this.setEraserMode(this.toolMode);
  }

  public enable() { this.isEnabled = true; this.interactionService.clearSelectedNodes(); }
  public disable() { this.isEnabled = false; }

  /** Set lock-transparency for the current layer (paint only where alpha > 0). */
  public setLockTransparency(locked: boolean): void {
    this.lockTransparency = locked;
    this.getPaintEngine()?.setLockTransparency(locked);
  }
  private lockTransparency = false;

  // ── Preset passthrough API (for ShapeManager / Frogmarks) ─────────

  /** Get the paint engine (if initialized). */
  public getPaintEngine(): RasterPaintEngine | undefined {
    return this.renderer.rasterPaintEngine;
  }

  /** Optional manual snapshot trigger. */
  public takeSnapshot() {
    const engine = this.getPaintEngine();
    if (engine && engine.getActiveTexture()) {
      engine.snapshotManager.pushSnapshot(engine.getActiveTexture()!).catch(console.warn);
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private attachListeners() {
    const canvas = this.interactionService.canvas;
    canvas.addEventListener('pointerdown', this.startBound);
    canvas.addEventListener('pointermove', this.moveBound);
    canvas.addEventListener('pointerup', this.upBound);
  }

  private toTexelCoords(ev: PointerEvent): { x: number; y: number } {
    // Map pointer → world → raster texture texel coordinates
    const world = this.interactionService.toWorldCoords(ev);

    const texSize = this.renderer.getRasterTextureSize?.() ?? { w: this.interactionService.canvas.width, h: this.interactionService.canvas.height };
    const texW = texSize.w || 1;
    const texH = texSize.h || 1;

    const isIll = this.renderer.getIllustrationMode();
    let worldQuadW = 2.0;
    let worldQuadH = 2.0;

    if (isIll) {
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

    // Use floating-point texel coords to preserve sub-pixel precision.
    // Integer truncation caused slow vertical strokes to round to the same texel,
    // producing zero-length segments that were discarded by the brush engine.
    let tx = u * texW;
    let ty = v * texH;
    tx = Math.max(0, Math.min(texW - 1, tx));
    ty = Math.max(0, Math.min(texH - 1, ty));

    return { x: tx, y: ty };
  }

  // ── Stroke lifecycle ──────────────────────────────────────────────

  private async start(ev: PointerEvent) {
    if (!this.isEnabled || ev.button !== 0) return;
    this.isDrawing = true;
    this.interactionService.beginInteractive();

    const tex = this.toTexelCoords(ev);
    const pressure = ev.pressure ?? 1;
    this.lastTex = tex;
    this.lastPressure = pressure;

    const engine = this.getPaintEngine();
    if (engine) {
      // Sync color, erase mode, lock-transparency
      engine.setBrushColor(this.brushColor.r, this.brushColor.g, this.brushColor.b, this.brushColor.a ?? 1);
      engine.setLockTransparency(this.lockTransparency);
      this.updateAspectCorrection(engine);

      // Sync selection mask so painting is constrained to the selection (if any)
      const selEngine = this.renderer.rasterSelectionEngine;
      const selInfo = selEngine?.getSelectionInfo();
      if (selEngine && selInfo?.hasSelection && !selInfo.isTransforming) {
        engine.setSelectionMask(selEngine.getMaskTexture());
      } else {
        engine.setSelectionMask(null);
      }

      const input: PointerInput = { x: tex.x, y: tex.y, pressure, timestamp: Date.now(), tiltX: ev.tiltX ?? 0, tiltY: ev.tiltY ?? 0 };
      engine.beginStroke(input);
    } else {
      // Fallback to legacy path
      this.stampAtLegacy(tex.x, tex.y, pressure);
    }

    this.onStrokeStart.emit({
      world: this.interactionService.toWorldCoords(ev),
      texel: tex,
      pressure,
      timestamp: Date.now()
    });
  }

  private move(ev: PointerEvent) {
    if (!this.isEnabled || !this.isDrawing) return;

    const tex = this.toTexelCoords(ev);
    const pressure = ev.pressure ?? 1;

    const engine = this.getPaintEngine();
    if (engine) {
      engine.addStrokePoint({ x: tex.x, y: tex.y, pressure, timestamp: Date.now(), tiltX: ev.tiltX ?? 0, tiltY: ev.tiltY ?? 0 });
    } else {
      // Legacy interpolation fallback
      if (this.lastTex) {
        const dx = tex.x - this.lastTex.x;
        const dy = tex.y - this.lastTex.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.max(1, Math.ceil(dist / Math.max(1, this.brushRadiusPx * 0.1)));
        for (let i = 1; i <= step; i++) {
          const t = i / step;
          const ix = Math.round(this.lastTex.x + dx * t);
          const iy = Math.round(this.lastTex.y + dy * t);
          const ip = this.lastPressure + (pressure - this.lastPressure) * t;
          this.stampAtLegacy(ix, iy, ip);
        }
      } else {
        this.stampAtLegacy(tex.x, tex.y, pressure);
      }
    }

    this.lastTex = tex;
    this.lastPressure = pressure;

    this.onStrokeUpdate.emit({
      world: this.interactionService.toWorldCoords(ev),
      texel: tex,
      pressure,
      timestamp: Date.now()
    });
  }

  private async end(_ev?: PointerEvent) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.interactionService.endInteractive();

    const engine = this.getPaintEngine();
    if (engine) {
      const lastPt = this.lastTex ?? { x: 0, y: 0 };
      await engine.endStroke({ x: lastPt.x, y: lastPt.y, pressure: this.lastPressure, timestamp: Date.now(), tiltX: 0, tiltY: 0 });

      // Push snapshot to the layer manager's per-layer undo stack.
      // endStroke() pushes to the paint engine's own RasterSnapshotManager,
      // but rasterUndo() reads from the layer's RasterTextureManager — these
      // are separate stacks. Without this, undo never has anything to restore.
      const layerMgr = (this.renderer as any).rasterLayerManager;
      const selectedId = layerMgr?.getSelectedLayerId?.();
      if (selectedId && layerMgr) {
        layerMgr.pushSnapshotForLayer(selectedId);
      }
    } else {
      // Legacy snapshot fallback
      try {
        if ((this.renderer as any).rasterPushSnapshot) {
          await (this.renderer as any).rasterPushSnapshot();
        }
      } catch (e) {
        console.warn('Failed to push snapshot after stroke:', e);
      }
    }

    this.onStrokeEnd.emit({ timestamp: Date.now() });
  }

  // ── Legacy fallback (used only when paint engine isn't available) ──

  private stampAtLegacy(tx: number, ty: number, pressure: number) {
    const radius = Math.max(1, Math.round(this.brushRadiusPx * pressure));
    const alpha = (this.brushColor.a ?? 1);
    const color: [number, number, number, number] = [this.brushColor.r, this.brushColor.g, this.brushColor.b, alpha];
    let dispatchMode: 'paint' | 'erase' | 'clear' = 'paint';
    let dispatchColor: [number, number, number, number] = color;
    if (this.toolMode === 'erase') {
      dispatchMode = 'erase';
      dispatchColor = [0, 0, 0, 1];
    } else if (this.toolMode === 'clear') {
      dispatchMode = 'clear';
      dispatchColor = [0, 0, 0, 1];
    }
    (this.renderer as any).dispatchGpuBrush(tx, ty, radius, dispatchColor, dispatchMode, this.eraserHard);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private updateAspectCorrection(engine: RasterPaintEngine) {
    const texSize = this.renderer.getRasterTextureSize?.() ?? { w: 1, h: 1 };
    let worldQuadW = 2.0;
    let worldQuadH = 2.0;
    if (this.renderer.getIllustrationMode()) {
      const ib = this.renderer.getIllustrationBounds();
      if (ib && ib.width > 0 && ib.height > 0) {
        worldQuadW = ib.width;
        worldQuadH = ib.height;
      }
    }
    const worldAspect = worldQuadW / worldQuadH;
    const texAspect = (texSize.w || 1) / (texSize.h || 1);
    const mismatch = texAspect / worldAspect;
    // Shader multiplies distance by aspect, so to make the brush *extend* further
    // vertically on wide canvases (compensating for texel squeeze), we need the
    // reciprocal — smaller multiplier = larger visible extent.
    engine.setAspectCorrection([1.0, 1.0 / mismatch]);
  }
}
