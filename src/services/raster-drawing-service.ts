import { InteractionService } from "./interaction-service";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import { RGBA } from "../types/rgba";
import { EventEmitter } from "../renderer/util/event-emitter";
import { RasterPaintEngine } from "../renderer/raster/core/raster-paint-engine";
import { PointerInput } from "../renderer/raster/brushes/brush-engine";
import type { RasterLayerManager } from './raster-layer-manager';
import { addZonelessListener, removeZonelessListener } from '../renderer/util/zoneless-listeners';
import { isPointerEventClaimed } from '../renderer/util/pointer-claims';
import { getStrokePrediction, predictionAppliesTo } from '../renderer/raster/brushes/brush-input-settings';
import { TouchGestureTracker } from '../renderer/util/touch-gesture-tracker';

/** A stroke's pointerdown, mapped once (TOUCH-5: a finger stroke keeps it until its first dab). */
interface StrokeStart {
  input: PointerInput;
  pointerType: string;
  clientX: number;
  clientY: number;
  world: { x: number; y: number };
}

/** Stroke prediction limits (BRUSH-4): a predicted sample more than this far ahead of the last real one (ms) is
 *  dropped — about 1.5 frames at 60 Hz, the input-to-display gap worth hiding; further out the predictor overshoots
 *  turns and stops. */
export const PREDICT_MAX_MS = 25;
/** At most this many predicted samples per event (a 240 Hz pen gives ~6 in PREDICT_MAX_MS). */
export const PREDICT_MAX_EVENTS = 8;
/** Absolute cap on how far (CSS px) a predicted sample may be from the last real one. */
export const PREDICT_MAX_PX = 64;
/** Slack (CSS px) on top of the speed-based limit, so a finger at rest still allows the predictor's jitter. */
export const PREDICT_SLACK_PX = 4;

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
  private upBound = (e: PointerEvent) => { this.touches.up(e); return this.end(e); };
  private cancelBound = (e: PointerEvent) => { this.touches.up(e); return this.lostPointer(e); };
  private lostCaptureBound = (e: PointerEvent) => this.lostPointer(e);
  /** Pre-render hook while a stroke is live: a waiting finger stroke gets its first dab (TOUCH-5), then the queued
   *  coalesced samples are stamped (BRUSH-4). */
  private drainBound = (): boolean => { this.commitTouchStart(); this.drainPending(true); return false; };

  // TOUCH-5 (mobile-parity §3): the fingers on the canvas (a 2nd one = a pinch → the stroke is taken back), the
  // finger stroke waiting for its first dab (1 frame or TouchGestureTracker.TOUCH_START_PX), and the live stroke's
  // pointer type (only a FINGER stroke is ever taken back by a pinch — mouse / pen strokes are unchanged).
  private readonly touches = new TouchGestureTracker();
  private touchPending: StrokeStart | null = null;
  private strokePointerType = '';
  /** Post-composite hook while a predicting stroke is live: takes the provisional tail back out of the layer. */
  private clearProvisionalBound = (): void => { this.getPaintEngine()?.clearProvisionalStroke?.(); };

  // BRUSH-4 prediction: this stroke may predict (touch / pen + setting + renderer hooks); the latest event's
  // filtered predicted samples (drawn by the next frame's drain, then discarded); the last real sample in CSS px.
  private predictStroke = false;
  private predicted: PointerInput[] = [];
  private lastCss: { x: number; y: number; t: number } | null = null;

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
  /** TOUCH-5: a stroke was ABANDONED (a second finger made it a pinch, a pen took over from a resting finger, or
   *  cancelActiveStroke()). Its paint is already put back; there is no onStrokeEnd for it, so a host that saves /
   *  marks the layer dirty on onStrokeEnd does nothing. `{ timestamp, began }` — `began` false = no dab was painted. */
  public onStrokeCancel = new EventEmitter<any>();

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
  /** The selected layer's own "Lock transparency" (the layers panel sets it on the LAYER via
   *  setRasterLayerLockTransparency; nothing forwarded it here, so a locked layer painted unlocked — mobile-parity 7.2). */
  private selectedLayerLocksAlpha(): boolean {
    const lm = (this.renderer as unknown as { rasterLayerManager?: Partial<Pick<RasterLayerManager, 'getSelectedLayerId' | 'getLayerById'>> })
      .rasterLayerManager;
    const id = lm?.getSelectedLayerId?.() ?? null;
    return !!(id && lm?.getLayerById?.(id)?.lockTransparency);
  }

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
    // leave isDrawing stuck (and the interactive lease held) until some later pointerup. (TOUCH-5: a finger stroke
    // still waiting for its first dab paints nothing.)
    addZonelessListener(canvas, 'pointercancel', this.cancelBound);
    addZonelessListener(canvas, 'lostpointercapture', this.lostCaptureBound);
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
    removeZonelessListener(canvas, 'pointercancel', this.cancelBound);
    removeZonelessListener(canvas, 'lostpointercapture', this.lostCaptureBound);
    this.eventListenersAttached = false;
    this.touches.reset();
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
  private drainPending(fromFrame = false): void {
    const engine = this.getPaintEngine();
    // A provisional tail still showing (normally the post-composite hook took it back) goes before any real dab.
    if (this.predictStroke) engine?.clearProvisionalStroke?.();
    if (this.pending.length > 0) {
      const pts = this.pending;
      this.pending = [];
      try {
        engine?.addStrokePoints(pts);
      } catch (e) {
        console.warn('RasterDrawingService: stroke points failed', e);
      }
    }
    // BRUSH-4 prediction: the frame's provisional tail, ahead of the real points just stamped. Only from the frame
    // callback (so the post-composite hook removes it after this frame's composite), and used once.
    if (fromFrame && this.predicted.length > 0) {
      const pred = this.predicted;
      this.predicted = [];
      if (this.predictStroke && getStrokePrediction()) {
        try { engine?.drawProvisionalStroke?.(pred); }
        catch (e) { console.warn('RasterDrawingService: stroke prediction failed', e); }
      }
    }
  }

  /**
   * BRUSH-4: the event's predicted samples (getPredictedEvents), filtered: each must be later than the last real
   * sample by at most PREDICT_MAX_MS, and no further from it than the recent speed allows (2 × speed × Δt +
   * PREDICT_SLACK_PX, never past PREDICT_MAX_PX) — the first implausible one ends the list. Empty when the API is
   * missing or the stroke doesn't predict.
   */
  private collectPredicted(
    ev: PointerEvent, last: { x: number; y: number; t: number }, ref: { x: number; y: number; t: number } | null,
    origin: { left: number; top: number }, map: (x: number, y: number) => { x: number; y: number },
    lastPressure: number, lastTs: number,
  ): PointerInput[] {
    if (!this.predictStroke || !getStrokePrediction() || typeof ev.getPredictedEvents !== 'function') return [];
    let list: PointerEvent[];
    try { list = ev.getPredictedEvents() ?? []; } catch { return []; }
    if (!list.length) return [];
    const speed = ref && last.t > ref.t ? Math.hypot(last.x - ref.x, last.y - ref.y) / (last.t - ref.t) : 0;   // CSS px/ms
    const out: PointerInput[] = [];
    for (const p of list) {
      if (out.length >= PREDICT_MAX_EVENTS) break;
      const dt = (p.timeStamp ?? 0) - last.t;
      if (!(dt > 0) || dt > PREDICT_MAX_MS) break;
      const cx = p.clientX - origin.left, cy = p.clientY - origin.top;
      const d = Math.hypot(cx - last.x, cy - last.y);
      if (!Number.isFinite(d) || d > Math.min(PREDICT_MAX_PX, 2 * speed * dt + PREDICT_SLACK_PX)) break;
      const tex = map(cx, cy);
      const pr = p.pressure;
      out.push({
        x: tex.x, y: tex.y, pressure: typeof pr === 'number' && pr > 0 ? pr : lastPressure,
        timestamp: Math.max(lastTs, p.timeStamp), tiltX: p.tiltX ?? 0, tiltY: p.tiltY ?? 0,
      });
    }
    return out;
  }

  // ── Stroke lifecycle ──────────────────────────────────────────────

  private async start(ev: PointerEvent) {
    // TOUCH-5: count fingers first (even with the tool off, so the count is right if it turns on mid-gesture). A
    // second finger makes this a pinch / two-finger pan (RasterInteractionController zooms): the finger stroke is
    // taken back. Extra fingers, `!isPrimary` ones and fingers of a blocked gesture never start a stroke.
    const verdict = this.touches.down(ev);
    if (verdict === 'gesture') {
      if (this.isDrawing && this.strokePointerType === 'touch') this.cancelActiveStroke();
      return;
    }
    if (verdict === 'ignore') return;
    if (!this.isEnabled || ev.button !== 0) return;
    // 7.3b P1: a finger that 3D surface paint took (it can't stop a touch — the orbit controller needs it) never
    // also starts a 2D stroke on the layer under the mesh.
    if (isPointerEventClaimed(ev)) return;
    // TOUCH-5: a pen landing while a FINGER stroke is live (a resting palm / knuckle started it) takes that stroke
    // back and draws — a palm can no longer lock the pen out.
    if (this.isDrawing && ev.pointerType === 'pen' && this.strokePointerType === 'touch') this.cancelActiveStroke();
    // BRUSH-3: one stroke at a time. A second pointer (resting palm, pinch finger) or a duplicate pointerdown
    // used to restart the stroke mid-way AND take another interactive lease that end() never returned.
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.strokePointerType = ev.pointerType ?? '';
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
    this.predicted = [];
    // BRUSH-4 prediction: touch / pen only (mouse never — desktop stays byte-identical), when the setting is on and
    // the renderer can take the tail back after its composite (the post-composite hook).
    this.predictStroke = predictionAppliesTo(ev.pointerType) && getStrokePrediction()
      && typeof this.renderer.addPreRenderCallback === 'function'
      && typeof this.renderer.addPostRasterCompositeCallback === 'function';

    const o = this.canvasOrigin();
    const map = this.texelMapper();
    const tex = map(ev.clientX - o.left, ev.clientY - o.top);
    const pressure = ev.pressure ?? 1;
    this.lastTex = tex;
    this.lastPressure = pressure;
    const timestamp = this.eventTime(ev);
    this.lastCss = { x: ev.clientX - o.left, y: ev.clientY - o.top, t: timestamp };
    const start: StrokeStart = {
      input: { x: tex.x, y: tex.y, pressure, timestamp, tiltX: ev.tiltX ?? 0, tiltY: ev.tiltY ?? 0 },
      pointerType: ev.pointerType, clientX: ev.clientX, clientY: ev.clientY,
      world: this.interactionService.toWorldCoordsFromCanvas(ev.clientX - o.left, ev.clientY - o.top),
    };

    // TOUCH-5 (the 7.3b P1 UV-paint rule): a FINGER stroke's first dab waits for the next frame or
    // TOUCH_START_PX of movement, so a second finger landing in that window makes a pinch with no paint at all.
    // Mouse and pen begin at once, exactly as before. (No frame hook → no delay: nothing would commit it.)
    if (ev.pointerType === 'touch' && this.getPaintEngine() && typeof this.renderer.addPreRenderCallback === 'function') {
      this.touchPending = start;
      this.renderer.addPreRenderCallback(this.drainBound, 'raster-brush-stroke');
      this.renderer.scheduleRender?.();
      return;
    }
    this.beginEngineStroke(start);
  }

  /** TOUCH-5: the waiting finger stroke gets its first dab now (its next frame came, it moved TOUCH_START_PX, or
   *  it lifted — a tap paints a dot). No-op when nothing is waiting. */
  private commitTouchStart(): void {
    const s = this.touchPending;
    if (!s) return;
    this.touchPending = null;
    this.beginEngineStroke(s);
  }

  /** Sync the engine to the tool and begin the engine stroke at `s` (the first dab). */
  private beginEngineStroke(s: StrokeStart): void {
    // Safety net: layer textures get reallocated on resize/restore, which can
    // leave the paint engine pointing at a stale texture (invisible strokes).
    // Re-point it at the live selected-layer texture before beginning the stroke.
    this.renderer.syncActiveLayerTexture?.();

    const tex = { x: s.input.x, y: s.input.y };
    const pressure = s.input.pressure;
    const engine = this.getPaintEngine();
    if (engine) {
      // Sync color, erase mode, lock-transparency
      engine.setBrushColor(this.brushColor.r, this.brushColor.g, this.brushColor.b, this.brushColor.a ?? 1);
      engine.setLockTransparency(this.lockTransparency || this.selectedLayerLocksAlpha());
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

      // pointerType: a finger stroke gets the touch smoothing cap (brush-input-settings.ts); pen / mouse don't.
      engine.beginStroke(s.input, { pointerType: s.pointerType });
      this.renderer.addPreRenderCallback?.(this.drainBound, 'raster-brush-stroke');
      if (this.predictStroke) this.renderer.addPostRasterCompositeCallback?.(this.clearProvisionalBound);
    } else {
      // Fallback to legacy path
      this.stampAtLegacy(tex.x, tex.y, pressure);
    }

    this.onStrokeStart.emit({
      world: s.world,
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
      const ref = this.lastCss;
      let last = ref;
      for (const e of samples) {
        tex = map(e.clientX - o.left, e.clientY - o.top);
        pressure = e.pressure ?? 1;
        const ts = this.eventTime(e);
        this.pending.push({ x: tex.x, y: tex.y, pressure, timestamp: ts, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0 });
        last = { x: e.clientX - o.left, y: e.clientY - o.top, t: ts };
      }
      this.lastCss = last;
      // TOUCH-5: a waiting finger stroke that moved TOUCH_START_PX is a stroke — its first dab now (the samples
      // queued so far follow with the next frame, as usual).
      const p = this.touchPending;
      if (p && Math.hypot(ev.clientX - p.clientX, ev.clientY - p.clientY) >= TouchGestureTracker.TOUCH_START_PX) this.commitTouchStart();
      // BRUSH-4: this event's predicted samples replace the previous event's (drawn once by the next frame).
      if (this.predictStroke && last && !this.touchPending) this.predicted = this.collectPredicted(ev, last, ref, o, map, pressure, this.lastTs);
      // No render loop to drain us (no pre-render hook, or rendering stalled) → stamp now rather than grow.
      if (!this.renderer.addPreRenderCallback || this.pending.length >= RasterDrawingService.MAX_PENDING) {
        this.commitTouchStart();
        this.drainPending();
      } else this.renderer.scheduleRender?.();
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

    if (this.touchPending) return;   // TOUCH-5: no update before the stroke has started
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
    this.commitTouchStart();   // TOUCH-5: a quick tap (lifted before its first frame) still paints its dot
    this.isDrawing = false;
    const pointerId = this.activePointerId;
    this.activePointerId = null;

    // Stamp whatever is still queued (a provisional tail is taken back first and never redrawn), then stop draining.
    this.predicted = [];
    this.drainPending();   // (takes a still-showing tail back first; BrushEngine.endStroke would too)
    this.predictStroke = false;
    this.lastCss = null;
    this.renderer.removePreRenderCallback?.(this.drainBound);
    this.renderer.removePostRasterCompositeCallback?.(this.clearProvisionalBound);
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

  /** pointercancel / lostpointercapture of the stroke's pointer: a live stroke ENDS (BRUSH-3 — it never stays stuck;
   *  what was drawn is kept, as before); a finger stroke still waiting for its first dab paints nothing (TOUCH-5).
   *  After a normal pointerup the stroke is already over (the release fires lostpointercapture): no-op. */
  private lostPointer(ev: PointerEvent): Promise<void> | void {
    if (!this.isDrawing || !this.isStrokePointer(ev)) return;
    if (this.touchPending) { this.cancelActiveStroke(); return; }
    return this.end(ev);
  }

  /**
   * TOUCH-5: ABANDON the live stroke — a second finger turned it into a pinch / two-finger pan (or a pen landed on
   * a finger stroke, or a waiting finger was cancelled). The 7.3b P1 UV-paint take-back, on the 2D layer: queued
   * samples and a predicted tail are dropped, RasterPaintEngine.cancelStroke() puts every touched texel back to its
   * stroke-start bytes (GPU only; the restore is reported to the dirty composite + incremental autosave against the
   * layer texture), and there is NO undo patch, NO snapshot and NO onStrokeEnd — so the host neither schedules an
   * autosave nor marks the layer dirty for upload. A finger stroke still waiting for its first dab painted nothing:
   * it is just dropped. Emits onStrokeCancel. True when a stroke was abandoned.
   */
  public cancelActiveStroke(): boolean {
    if (!this.isDrawing) return false;
    const began = this.touchPending === null;
    this.touchPending = null;
    this.isDrawing = false;
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    this.pending = [];
    this.predicted = [];
    this.predictStroke = false;
    this.lastCss = null;
    this.renderer.removePreRenderCallback?.(this.drainBound);
    this.renderer.removePostRasterCompositeCallback?.(this.clearProvisionalBound);
    const canvas = this.interactionService.canvas;
    if (pointerId !== null) {
      try { if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId); } catch { /* gone */ }
    }
    if (this.interactiveHeld) {
      this.interactiveHeld = false;
      this.interactionService.endInteractive();
    }
    if (began) {
      try { this.getPaintEngine()?.cancelStroke?.(); }   // (the legacy no-engine path can't take its stamps back)
      catch (e) { console.warn('RasterDrawingService: cancel stroke failed', e); }
    }
    this.renderer.scheduleRender?.();
    this.onStrokeCancel.emit({ timestamp: Date.now(), began });
    return true;
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
