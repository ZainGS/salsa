import { InteractionService } from "./interaction-service";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import { RGBA } from "../types/rgba";
import { EventEmitter } from "../renderer/util/event-emitter";
import { RasterPaintEngine } from "../renderer/raster/core/raster-paint-engine";
import { PointerInput } from "../renderer/raster/brushes/brush-engine";
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';

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
  /** Pre-render hook while a stroke is live: stamps the queued coalesced samples (BRUSH-4). */
  private drainBound = (): boolean => { this.drainPending(); return false; };

  // BRUSH-3 stroke ownership: the pointer the stroke is locked to, and whether we hold an interactive lease.
  private activePointerId: number | null = null;
  private interactiveHeld = false;
  // BRUSH-4: samples waiting for the next frame, and the stroke's last timestamp (kept non-decreasing).
  private pending: PointerInput[] = [];
  private lastTs = -Infinity;
  /** Queue cap: past this many samples (render loop stalled), stamp immediately. */
  private static readonly MAX_PENDING = 64;

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

  /**
   * Pick a brush preset: the BRUSH SWITCH. Activates the preset on the engine AND leaves erase mode (back to
   * 'paint'), so choosing a brush after the eraser tool never keeps erasing. An Eraser-category preset still
   * erases on its own (BrushEngine maps category 'Eraser' to erase-fade when no override is set).
   * Returns false (and changes nothing) when there is no engine or no such preset.
   */
  public selectBrushPreset(id: string): boolean {
    const engine = this.getPaintEngine();
    if (!engine || !engine.setActivePreset(id)) return false;
    this.setEraserMode('paint');
    return true;
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

  // Brush state for UV/mesh paint is mirrored onto the separate UV paint engine from
  // this (illustration) engine at stroke time — see ShapeManager._mirrorBrushToUVEngine
  // — so the same 2D brush UI drives both without any routing/override coupling. These
  // two getters expose the bits the engine can't read back (current color + erase mode).

  /** Current brush color (the last value set via setBrushColor). */
  public getBrushColor(): RGBA { return this.brushColor; }

  /** Current engine erase mode for the active tool (null=paint, 1/3=erase, 2=clear).
   *  Mirrors the mapping in setEraserMode — used to replicate erase onto the UV engine. */
  public getEraseMode(): number | null {
    if (this.toolMode === 'paint') return null;
    if (this.toolMode === 'erase') return this.eraserHard ? 3 : 1;
    return 2; // clear
  }

  /** Optional manual snapshot trigger. */
  public takeSnapshot() {
    const engine = this.getPaintEngine();
    if (engine && engine.getActiveTexture()) {
      engine.snapshotManager.pushSnapshot(engine.getActiveTexture()!).catch(console.warn);
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private eventListenersAttached = false;

  private attachListeners() {
    if (this.eventListenersAttached) return;
    const canvas = this.interactionService.canvas;
    addZonelessListener(canvas, 'pointerdown', this.startBound);
    addZonelessListener(canvas, 'pointermove', this.moveBound);
    addZonelessListener(canvas, 'pointerup', this.upBound);
    // BRUSH-3: a cancelled pointer (OS gesture, palm rejection) or lost capture ENDS the stroke — it used to
    // leave isDrawing stuck (and the interactive lease held) until some later pointerup.
    addZonelessListener(canvas, 'pointercancel', this.upBound);
    addZonelessListener(canvas, 'lostpointercapture', this.upBound);
    this.eventListenersAttached = true;
  }

  /**
   * Re-bind pointer listeners to the (possibly new) canvas after a renderer
   * reinitialize. Navigating from the Shell into an illustration swaps the
   * canvas; without re-binding, the brush stays attached to the old canvas and
   * strokes never reach the new one (painting silently does nothing).
   */
  public reinitializeEventListeners(): void {
    const canvas = this.interactionService.canvas;
    removeZonelessListener(canvas, 'pointerdown', this.startBound);
    removeZonelessListener(canvas, 'pointermove', this.moveBound);
    removeZonelessListener(canvas, 'pointerup', this.upBound);
    removeZonelessListener(canvas, 'pointercancel', this.upBound);
    removeZonelessListener(canvas, 'lostpointercapture', this.upBound);
    this.eventListenersAttached = false;
    this.attachListeners();
  }

  /** Map a canvas-relative CSS-pixel position → raster texture texel coordinates. Built once per pointer
   *  event (BRUSH-4/7: one getBoundingClientRect + texture-size lookup for all of its coalesced samples). */
  private texelMapper(): (canvasX: number, canvasY: number) => { x: number; y: number } {
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

    return (canvasX: number, canvasY: number) => {
      // Map pointer → world → raster texture texel coordinates
      const world = this.interactionService.toWorldCoordsFromCanvas(canvasX, canvasY);
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
    };
  }

  private canvasOrigin(): { left: number; top: number } {
    const r = this.interactionService.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  /** The event's own timestamp (BRUSH-4: `e.timeStamp`, not Date.now() at handling time — coalesced samples
   *  carry their real times), kept non-decreasing within a stroke. */
  private eventTime(e?: { timeStamp?: number }): number {
    const t = e?.timeStamp;
    let ts = (typeof t === 'number' && t > 0 && Number.isFinite(t)) ? t : performance.now();
    if (ts < this.lastTs) ts = this.lastTs;
    this.lastTs = ts;
    return ts;
  }

  /** BRUSH-3: is this event from the pointer that owns the current stroke? */
  private isStrokePointer(ev: PointerEvent): boolean {
    return this.activePointerId === null || ev.pointerId === undefined || ev.pointerId === this.activePointerId;
  }

  /** Feed the queued points to the engine as ONE dab batch (BRUSH-1b/4). Runs as a pre-render callback, so a
   *  frame's coalesced samples are stamped right before the frame that shows them. */
  private drainPending(): void {
    if (this.pending.length === 0) return;
    const pts = this.pending;
    this.pending = [];
    try {
      this.getPaintEngine()?.addStrokePoints(pts);
    } catch (e) {
      console.warn('RasterDrawingService: stroke points failed', e);
    }
  }

  // ── Stroke lifecycle ──────────────────────────────────────────────

  private async start(ev: PointerEvent) {
    if (!this.isEnabled || ev.button !== 0) return;
    // BRUSH-3: one stroke at a time. A second pointer (resting palm, pinch finger) or a duplicate pointerdown
    // used to restart the stroke mid-way AND take another interactive lease that end() never returned.
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.activePointerId = typeof ev.pointerId === 'number' ? ev.pointerId : null;
    const canvas = this.interactionService.canvas;
    if (this.activePointerId !== null) {
      try { canvas.setPointerCapture?.(this.activePointerId); } catch { /* pointer already gone */ }
    }
    if (!this.interactiveHeld) {
      this.interactiveHeld = true;
      this.interactionService.beginInteractive();
    }
    this.pending = [];
    this.lastTs = -Infinity;

    const o = this.canvasOrigin();
    const map = this.texelMapper();
    const tex = map(ev.clientX - o.left, ev.clientY - o.top);
    const pressure = ev.pressure ?? 1;
    this.lastTex = tex;
    this.lastPressure = pressure;
    const timestamp = this.eventTime(ev);

    // Safety net: layer textures get reallocated on resize/restore, which can
    // leave the paint engine pointing at a stale texture (invisible strokes).
    // Re-point it at the live selected-layer texture before beginning the stroke.
    this.renderer.syncActiveLayerTexture?.();

    const engine = this.getPaintEngine();
    if (engine) {
      // Sync color, erase mode, lock-transparency
      engine.setBrushColor(this.brushColor.r, this.brushColor.g, this.brushColor.b, this.brushColor.a ?? 1);
      engine.setLockTransparency(this.lockTransparency);
      // The tool mode is the source of truth for erase: re-apply it every stroke, so an engine that missed a
      // setEraserMode (created / re-created after it, e.g. renderer reinit) can't keep a stale erase override.
      engine.setEraseMode(this.getEraseMode());
      this.updateAspectCorrection(engine);

      // Sync selection mask so painting is constrained to the selection (if any)
      const selEngine = this.renderer.rasterSelectionEngine;
      const selInfo = selEngine?.getSelectionInfo();
      if (selEngine && selInfo?.hasSelection && !selInfo.isTransforming) {
        engine.setSelectionMask(selEngine.getMaskTexture());
      } else {
        engine.setSelectionMask(null);
      }

      const input: PointerInput = { x: tex.x, y: tex.y, pressure, timestamp, tiltX: ev.tiltX ?? 0, tiltY: ev.tiltY ?? 0 };
      engine.beginStroke(input);
      this.renderer.addPreRenderCallback?.(this.drainBound, 'raster-brush-stroke');
    } else {
      // Fallback to legacy path
      this.stampAtLegacy(tex.x, tex.y, pressure);
    }

    this.onStrokeStart.emit({
      world: this.interactionService.toWorldCoordsFromCanvas(ev.clientX - o.left, ev.clientY - o.top),
      texel: tex,
      pressure,
      timestamp: Date.now()
    });
  }

  private move(ev: PointerEvent) {
    if (!this.isEnabled || !this.isDrawing) return;
    if (!this.isStrokePointer(ev)) return;   // BRUSH-3: other fingers / a palm never feed this stroke
    // BRUSH-3: no button held any more → the pointerup was missed (released outside / swallowed); end here
    // instead of drawing a hover line.
    if (typeof ev.buttons === 'number' && (ev.buttons & 1) === 0) {
      void this.end(ev);
      return;
    }

    const o = this.canvasOrigin();
    const map = this.texelMapper();

    const engine = this.getPaintEngine();
    let tex: { x: number; y: number };
    let pressure: number;
    if (engine) {
      // BRUSH-4: every sample the browser coalesced into this event (a pen reports 120–240 Hz; one event per
      // frame), each with its own timestamp — queued and stamped as one batch right before the next frame.
      const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : null;
      const samples: PointerEvent[] = coalesced && coalesced.length ? coalesced : [ev];
      tex = this.lastTex ?? { x: 0, y: 0 };
      pressure = this.lastPressure;
      for (const e of samples) {
        tex = map(e.clientX - o.left, e.clientY - o.top);
        pressure = e.pressure ?? 1;
        this.pending.push({ x: tex.x, y: tex.y, pressure, timestamp: this.eventTime(e), tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0 });
      }
      // No render loop to drain us (no pre-render hook, or rendering stalled) → stamp now rather than grow.
      if (!this.renderer.addPreRenderCallback || this.pending.length >= RasterDrawingService.MAX_PENDING) this.drainPending();
      else this.renderer.scheduleRender?.();
    } else {
      tex = map(ev.clientX - o.left, ev.clientY - o.top);
      pressure = ev.pressure ?? 1;
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
      world: this.interactionService.toWorldCoordsFromCanvas(ev.clientX - o.left, ev.clientY - o.top),
      texel: tex,
      pressure,
      timestamp: Date.now()
    });
  }

  private async end(ev?: PointerEvent) {
    if (!this.isDrawing) return;
    if (ev && !this.isStrokePointer(ev)) return;   // another pointer lifting doesn't end this stroke
    this.isDrawing = false;
    const pointerId = this.activePointerId;
    this.activePointerId = null;

    // Stamp whatever is still queued, then stop draining.
    this.drainPending();
    this.renderer.removePreRenderCallback?.(this.drainBound);
    const canvas = this.interactionService.canvas;
    if (pointerId !== null) {
      try { if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId); } catch { /* gone */ }
    }
    // BRUSH-3: exactly one endInteractive per beginInteractive (the counter used to leak → a render every vsync).
    if (this.interactiveHeld) {
      this.interactiveHeld = false;
      this.interactionService.endInteractive();
    }

    const engine = this.getPaintEngine();
    if (engine) {
      const lastPt = this.lastTex ?? { x: 0, y: 0 };
      // BRUSH-6: ONE undo snapshot per stroke. The selected layer's stack is what undo reads; the paint engine
      // used to push its own (never read) snapshot AND the layer pushed a full-canvas one. Now the engine
      // builds a rect BEFORE/AFTER patch and it goes to the layer stack (a full push only as a fallback).
      const layerMgr = (this.renderer as any).rasterLayerManager;
      const selectedId: string | null = layerMgr?.getSelectedLayerId?.() ?? null;
      const layerTexMgr = selectedId ? layerMgr?.getSelectedLayerManager?.() : null;
      const useLayerStack = !!(selectedId && layerMgr);
      const patch = await engine.endStroke(
        { x: lastPt.x, y: lastPt.y, pressure: this.lastPressure, timestamp: this.eventTime(ev), tiltX: 0, tiltY: 0 },
        { pushSnapshot: !useLayerStack },
      );

      if (useLayerStack) {
        if (patch && layerTexMgr && typeof layerTexMgr.pushStrokePatch === 'function') {
          try { await layerTexMgr.pushStrokePatch(patch.texture, patch); }
          catch (e) { console.warn('Failed to push stroke undo patch:', e); }
        } else {
          layerMgr.pushSnapshotForLayer(selectedId);
        }
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
