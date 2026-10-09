/**
 * BrushEngine — orchestrates one stroke from pointer input to GPU dabs.
 *
 * Responsibilities:
 *  1. Accept raw pointer events (with pressure, timestamp).
 *  2. Run them through the BrushStabilizer.
 *  3. Space dabs along the smoothed polyline at the preset's spacing interval.
 *  4. Evaluate dynamics (pressure/velocity curves) for each dab.
 *  5. Dispatch each dab through BrushStampPipeline.
 *
 * Lifetime: one BrushEngine lives for the entire session.
 * Call `beginStroke` / `addPoint` / `endStroke` per gesture.
 */

import {
  BrushPreset,
  BrushTip,
  BrushTipParametric,
  evaluateCurve,
  LINEAR_CURVE,
} from './brush-preset';
import { BrushStabilizer, StabilizedPoint } from './brush-stabilizer';
import { stabilizationForPointer } from './brush-input-settings';
import type { BrushStabilization } from './brush-preset';
import { BrushStampPipeline, StampParams, TexelRect } from './brush-stamp-pipeline';
import { BrushTipGenerator, textureDataKey } from './brush-tip';
import { CanvasGrainManager } from '../canvas-grain';
import { rgbToHsb, hsbToRgb } from '../../../utils/color';
import { StrokeTextureRenderer, StrokeVertex } from './stroke-texture-renderer';

export interface PointerInput {
  /** Texel X coordinate on the raster texture. */
  x: number;
  /** Texel Y coordinate on the raster texture. */
  y: number;
  /** Pressure 0-1 (1 if unavailable). */
  pressure: number;
  /** Performance.now() or Date.now(). */
  timestamp: number;
  /** Pen tilt in X (degrees, -90 to 90). 0 if unavailable. */
  tiltX?: number;
  /** Pen tilt in Y (degrees, -90 to 90). 0 if unavailable. */
  tiltY?: number;
}

/**
 * The texel bounds (max-exclusive, unclipped) of the strip StrokeTextureRenderer draws for `vertices`: it writes a
 * texel only when the texel centre lies within a segment's (interpolated) half-width of it, so the vertex bbox
 * grown by the widest half-width (+1 texel of slack) contains every write. Exported for tests.
 */
export function strokeStripBounds(vertices: readonly StrokeVertex[]): TexelRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hw = 0;
  for (const v of vertices) {
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
    y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    hw = Math.max(hw, v.width);
  }
  const pad = hw + 1;
  return { x0: Math.floor(x0 - pad), y0: Math.floor(y0 - pad), x1: Math.ceil(x1 + pad), y1: Math.ceil(y1 + pad) };
}

const CANVAS_ORIGIN: [number, number] = [0, 0];

/** The soft eraser's tip hardness cap: a soft eraser is soft-edged even with a hard brush (a softer tip stays). */
export const SOFT_ERASER_HARDNESS = 0.3;

/**
 * The tip the eraser TOOL erases with (erase mode set by the tool, not an Eraser-category preset's own tip):
 * soft (1) caps a parametric tip's hardness at SOFT_ERASER_HARDNESS, hard (3) makes it fully hard (the stamp
 * shader also cuts image tips to a crisp silhouette). Same shape (roundness / angle). Other modes: the tip as is.
 */
export function eraserTip(tip: BrushTip, mode: number): BrushTip {
  if (tip.type !== 'parametric') return tip;
  if (mode === 3 && tip.hardness < 1) return { ...tip, hardness: 1 };
  if (mode === 1 && tip.hardness > SOFT_ERASER_HARDNESS) return { ...tip, hardness: SOFT_ERASER_HARDNESS };
  return tip;
}

export class BrushEngine {
  private device: GPUDevice;
  private stampPipeline: BrushStampPipeline;
  private tipGenerator: BrushTipGenerator;
  private stabilizer: BrushStabilizer;

  private preset!: BrushPreset;

  // Stroke state
  private isActive = false;
  private lastDabX = 0;
  private lastDabY = 0;
  private lastDabTime = 0;
  private lastDabPressure = 0.5;
  private lastDabTiltX = 0;
  private lastDabTiltY = 0;
  private currentVelocity = 0; // texels/ms, smoothed
  private distanceSinceLastDab = 0;

  // Target texture (set per stroke)
  private targetTexture: GPUTexture | null = null;

  // Aspect correction (set by paint engine based on canvas/world geometry)
  private aspectCorrection: [number, number] = [1, 1];

  // Erase mode override (so eraser preset can be applied)
  private eraseModeOverride: number | null = null;

  // Lock transparency: paint only where existing alpha > 0
  private lockTransparency: boolean = false;

  // Selection mask: when set, painting is constrained to the selected region
  private selectionMask: GPUTexture | null = null;

  // Canvas grain manager: provides paper texture for grain modulation
  private grainManager: CanvasGrainManager | null = null;

  // Dual brush texture (cached GPU texture loaded from preset)
  private dualBrushTexture: GPUTexture | null = null;

  // The preset's own Texture (BrushPreset.texture): an uploaded image (loaded async here) - a built-in pattern
  // comes from the grain manager's cache instead. strokeAnchor = the stroke's first dab (stroke-anchored texture).
  private brushTextureImage: GPUTexture | null = null;
  private strokeAnchor: [number, number] = [0, 0];
  /** The eraser tool's variant of the preset tip (eraserTip), memoised per source tip values + mode. */
  private _eraserTip: { src: BrushTipParametric; h: number; r: number; a: number; mode: number; tip: BrushTip } | null = null;

  // Stroke texture renderer (for charcoal/crayon/marker brushes)
  private strokeTextureRenderer: StrokeTextureRenderer;
  private strokeTextureGpu: GPUTexture | null = null;
  private strokeVertices: StrokeVertex[] = [];

  // Smudge: picked-up canvas color from previous dab (1-dab lag via async GPU readback)
  private _smudgeColor: [number, number, number, number] = [0, 0, 0, 0];
  private _smudgeReadbackPending = false;

  // ── Stroke DIRTY RECT (E5 tail) — union of the stroke's dab centres, consumed at endStroke by the
  // snapshot readback so undo captures only the touched region instead of the whole canvas. ──
  private _dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private _maxDabRadius = 0;

  /** The finished stroke's touched region, generously padded (soft edge / wet-edge halo / bleed spread /
   *  dual-tip offsets — overshoot only costs readback bytes, never correctness), or null for an empty
   *  stroke. Clears the accumulator. Unclamped — the consumer clamps to its texture. */
  public takeStrokeDirtyRect(): { x: number; y: number; w: number; h: number } | null {
    const d = this._dirty;
    this._dirty = null;
    if (!d) return null;
    const pad = Math.ceil(this._maxDabRadius * 2 + 64);
    return {
      x: Math.floor(d.x0 - pad), y: Math.floor(d.y0 - pad),
      w: Math.ceil(d.x1 - d.x0 + 2 * pad), h: Math.ceil(d.y1 - d.y0 + 2 * pad),
    };
  }

  /**
   * BRUSH-6: the finished stroke's undo patch — BEFORE pixels (the stroke-start snapshot) and AFTER pixels
   * (`texture`) of the region the stroke wrote, read straight from the GPU (two small readbacks, no full-canvas
   * one). The region is the stamp pipeline's EXACT written rect (every composite and direct dab into the target
   * is recorded there, so nothing outside it changed). Null for a stroke that wrote nothing or whose base no
   * longer matches `texture`. Call once after endStroke(), before the next beginStroke().
   */
  public captureStrokePatch(
    texture: GPUTexture,
  ): Promise<{ x: number; y: number; w: number; h: number; before: Uint8Array; after: Uint8Array }> | null {
    this.takeStrokeDirtyRect();   // consume the padded centre rect too (it only feeds the legacy snapshot path)
    const exact: TexelRect | null = this.stampPipeline.takeStrokeTouchedRect();
    if (!exact) return null;   // nothing reached the texture (off-canvas / no dab)
    return this.stampPipeline.readStrokeRect(texture, exact);
  }

  /** BRUSH-1b: open a dab batch — every dab until endBatch() goes to the GPU as ONE submit with one composite.
   *  The paint engine wraps each pointer frame's points in one batch. Nests. */
  public beginBatch(): void { this.stampPipeline.beginBatch(); }
  public endBatch(): void { this.stampPipeline.endBatch(); }

  /** Diagnostics / tests: the stamp pipeline's submit + texel-traffic counters. */
  public get stampStats(): { submits: number; copiedTexels: number; compositedTexels: number } {
    return this.stampPipeline.stats;
  }

  constructor(device: GPUDevice) {
    this.device = device;
    this.stampPipeline = new BrushStampPipeline(device);
    this.tipGenerator = new BrushTipGenerator(device);
    this.stabilizer = new BrushStabilizer({ method: 'none', level: 0 });
    this.strokeTextureRenderer = new StrokeTextureRenderer(device);
  }

  // ── Configuration ─────────────────────────────────────────────────

  public setPreset(preset: BrushPreset): void {
    this.preset = preset;
    this.stabilizer.configure(preset.stabilization);
    this.configuredStabilization = preset.stabilization;

    // Pre-load image tips async if needed
    if (preset.tip.type === 'image') {
      this.tipGenerator.loadImageTipAsync(preset.tip).catch(console.warn);
    }

    // Pre-load dual brush texture if configured
    this.dualBrushTexture = null;
    if (preset.dualBrush?.enabled && preset.dualBrush.textureData) {
      const key = textureDataKey('dual', preset.dualBrush.textureData);
      // Check cache first (sync), then async-load if missing
      const cached = this.tipGenerator.getCachedTexture(key);
      if (cached) {
        this.dualBrushTexture = cached;
      } else {
        this.tipGenerator.loadGrayscaleTextureAsync(
          key, preset.dualBrush.textureData, preset.dualBrush.textureSize,
        ).then(tex => {
          // Only set if preset hasn't changed since the load started
          if (this.preset === preset) this.dualBrushTexture = tex;
        }).catch(console.warn);
      }
    }

    // Pre-load stroke texture if configured
    this.strokeTextureGpu = null;
    if (preset.strokeTexture?.enabled && preset.strokeTexture.textureData) {
      const key = textureDataKey('stroke', preset.strokeTexture.textureData);
      const cached = this.tipGenerator.getCachedTexture(key);
      if (cached) {
        this.strokeTextureGpu = cached;
      } else {
        this.tipGenerator.loadGrayscaleTextureAsync(
          key, preset.strokeTexture.textureData, preset.strokeTexture.textureSize,
        ).then(tex => {
          if (this.preset === preset) this.strokeTextureGpu = tex;
        }).catch(console.warn);
      }
    }

    // Pre-load the brush's own Texture: an uploaded image async, a built-in pattern generated now (not mid-stroke)
    this.brushTextureImage = null;
    const tx = preset.texture;
    if (tx && tx.strength > 0) {
      if (tx.imageData) {
        const key = textureDataKey('tex', tx.imageData);
        const cached = this.tipGenerator.getCachedTexture(key);
        if (cached) {
          this.brushTextureImage = cached;
        } else {
          this.tipGenerator.loadGrayscaleTextureAsync(key, tx.imageData, 256).then(tex => {
            if (this.preset === preset) this.brushTextureImage = tex;
          }).catch(console.warn);
        }
      } else {
        this.grainManager?.getTextureFor(tx.grain ?? 'cold-press');
      }
    }
  }

  /** The texture of the preset's own Texture block for this dab (null = none / still loading). */
  private resolveBrushTexture(): GPUTexture | null {
    const tx = this.preset.texture;
    if (!tx || !(tx.strength > 0)) return null;
    if (tx.imageData) return this.brushTextureImage;
    return this.grainManager?.getTextureFor(tx.grain ?? 'cold-press') ?? null;
  }

  /** The tip a dab stamps with: the preset's, or the eraser tool's soft / hard variant of it (eraserTip). */
  private dabTip(mode: number): BrushTip {
    const tip = this.preset.tip;
    if (this.eraseModeOverride === null || tip.type !== 'parametric' || (mode !== 1 && mode !== 3)) return tip;
    const m = this._eraserTip;
    if (m && m.src === tip && m.h === tip.hardness && m.r === tip.roundness && m.a === tip.angle && m.mode === mode) return m.tip;
    const out = eraserTip(tip, mode);
    this._eraserTip = { src: tip, h: tip.hardness, r: tip.roundness, a: tip.angle, mode, tip: out };
    return out;
  }

  /**
   * Directly set the dual brush GPU texture (e.g. loaded externally by Frogmarks).
   */
  public setDualBrushTexture(tex: GPUTexture | null): void {
    this.dualBrushTexture = tex;
  }

  public getPreset(): BrushPreset | undefined {
    return this.preset;
  }

  public setAspectCorrection(aspect: [number, number]): void {
    this.aspectCorrection = aspect;
  }

  /**
   * Per-dab size multiplier applied to the computed brush diameter (and dab spacing). Used by 3D-SURFACE
   * painting to keep a stroke a CONSTANT physical size on the mesh even where the UV unwrap is stretched:
   * the caller sets this to (local UV texel density ÷ mesh-average density) before each stroke point, so a
   * fixed screen brush covers the same surface area everywhere. 1 = no change (the 2D / UV-pane default).
   */
  private brushSizeScale = 1;
  public setSizeScale(scale: number): void {
    this.brushSizeScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
  }

  /**
   * Override the blend mode for the next stroke (e.g. force erase mode
   * even if the preset is a paint brush). Set to null to use preset default.
   */
  public setEraseModeOverride(mode: number | null): void {
    this.eraseModeOverride = mode;
  }

  public setLockTransparency(locked: boolean): void {
    this.lockTransparency = locked;
  }

  /** Set the selection mask texture. When non-null, painting is constrained to selected pixels. */
  public setSelectionMask(mask: GPUTexture | null): void {
    this.selectionMask = mask;
  }

  /** Set the canvas grain manager for paper texture modulation. */
  public setCanvasGrainManager(manager: CanvasGrainManager | null): void {
    this.grainManager = manager;
  }

  // ── Stroke lifecycle ──────────────────────────────────────────────

  /** The stabilization the stabilizer is configured with (the preset's own, or a touch-capped copy). */
  private configuredStabilization: BrushStabilization | null = null;

  /**
   * Call at pointerdown. Sets up state for a new stroke.
   * `opts.pointerType` (the PointerEvent's) selects the smoothing: a finger ('touch') caps the preset's stabilizer
   * at the per-machine touch-smoothing level (brush-input-settings.ts); pen / mouse / unset use the preset as is.
   */
  public beginStroke(texture: GPUTexture, firstPoint: PointerInput, opts?: { pointerType?: string }): void {
    if (!this.preset) {
      console.warn('BrushEngine: no preset set');
      return;
    }

    const stab = stabilizationForPointer(this.preset.stabilization, opts?.pointerType);
    if (stab !== this.configuredStabilization) {
      this.stabilizer.configure(stab);
      this.configuredStabilization = stab;
    }

    this.targetTexture = texture;
    this.isActive = true;
    this.distanceSinceLastDab = 0;
    this.currentVelocity = 0;
    this.stabilizer.reset();
    this.strokeVertices = [];
    this._smudgeColor = [0, 0, 0, 0];
    this._smudgeReadbackPending = false;
    this._dirty = null;               // fresh stroke → fresh dirty-rect accumulation (E5 tail)
    this._maxDabRadius = 0;
    this.strokeAnchor = [firstPoint.x, firstPoint.y];   // a stroke-anchored brush texture starts here

    // Begin wet-stroke: snapshot the canvas and prepare the stroke accumulation layer
    // (lock transparency on the wet path is applied in the accum → layer composite, against the layer's alpha)
    this.stampPipeline.beginStroke(texture, { lockAlpha: this.lockTransparency });

    const smoothed = this.stabilizer.push({
      x: firstPoint.x,
      y: firstPoint.y,
      pressure: firstPoint.pressure,
      timestamp: firstPoint.timestamp,
      tiltX: firstPoint.tiltX,
      tiltY: firstPoint.tiltY,
    });

    // Collect vertex for stroke texture mapping
    this.collectStrokeVertex(smoothed);

    // Stamp the first dab immediately
    this.stampDab(smoothed.x, smoothed.y, smoothed.pressure, smoothed.timestamp, smoothed.tiltX ?? 0, smoothed.tiltY ?? 0);
    this.lastDabX = smoothed.x;
    this.lastDabY = smoothed.y;
    this.lastDabTime = smoothed.timestamp;
    this.lastDabPressure = smoothed.pressure;
    this.lastDabTiltX = smoothed.tiltX ?? 0;
    this.lastDabTiltY = smoothed.tiltY ?? 0;
  }

  /**
   * Call on pointermove. Interpolates dabs along the segment from the
   * last dab position to the new smoothed position.
   */
  public addPoint(input: PointerInput): void {
    if (!this.isActive || !this.targetTexture || !this.preset) return;

    const smoothed = this.stabilizer.push({
      x: input.x,
      y: input.y,
      pressure: input.pressure,
      timestamp: input.timestamp,
      tiltX: input.tiltX,
      tiltY: input.tiltY,
    });

    // Update velocity (smoothed exponential)
    const dt = smoothed.timestamp - this.lastDabTime;
    if (dt > 0) {
      const dx = smoothed.x - this.lastDabX;
      const dy = smoothed.y - this.lastDabY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const instantVel = dist / dt; // texels/ms
      // Exponential smoothing: α = 0.3 blends new velocity in
      this.currentVelocity = this.currentVelocity * 0.7 + instantVel * 0.3;
    }

    // Collect vertex for stroke texture mapping
    this.collectStrokeVertex(smoothed);

    this.interpolateDabs(smoothed);
  }

  /**
   * Call at pointerup. Flushes stabilizer and stamps any remaining dabs.
   */
  public endStroke(finalPoint: PointerInput): void {
    if (!this.isActive) return;
    this.stampPipeline.clearProvisional();   // a predicted tail never reaches the committed stroke
    this.stampPipeline.flush();   // dabs batched so far land before the end-of-stroke passes

    const flushed = this.stabilizer.flush({
      x: finalPoint.x,
      y: finalPoint.y,
      pressure: finalPoint.pressure,
      timestamp: finalPoint.timestamp,
    });

    for (const pt of flushed) {
      this.collectStrokeVertex(pt);
      this.interpolateDabs(pt);
    }

    // If stroke texture is enabled, render the textured strip onto the stroke
    // accumulation texture, replacing the dab-based preview with the final result.
    // (Only for a stroke that painted into the accum — an erase stroke never did, and its accum is discarded.)
    const st = this.preset?.strokeTexture;
    if (st?.enabled && this.strokeVertices.length >= 2 && this.targetTexture && this.stampPipeline.strokeHasAccumPaint) {
      // Get access to the stroke accum texture to overwrite it
      const accumTex = this.stampPipeline.getStrokeAccumTex();
      if (accumTex) {
        // Clear the accum (remove dab preview)
        this.stampPipeline.clearStrokeAccum();
        // Render the textured strip
        this.strokeTextureRenderer.render(
          this.strokeVertices,
          accumTex,
          this.strokeTextureGpu,
          // Opacity is the strip's coverage (the stroke ceiling, as for dabs); the dab-only settings don't apply.
          [this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], this.strokeColor[3] * Math.max(0, Math.min(1, this.preset.blending.opacity))],
          st.texelsPerUnit,
          st.edgeSoftness,
        );
        // ... and tell the pipeline where, so endStroke's bounded flatten puts it on the canvas.
        this.stampPipeline.markStrokeAccumWritten(strokeStripBounds(this.strokeVertices));
      }
    }

    // End wet-stroke: apply wet edges / bleed if configured, then flatten stroke layer
    const we = this.preset?.wetEdges;
    const bl = this.preset?.bleed;
    const weSettings = we?.enabled
      ? { edgeDarkness: we.edgeDarkness, edgeWidth: we.edgeWidth, strength: we.strength }
      : undefined;
    // A stroke-texture brush's per-dab bleed would spread the dab preview the strip replaces: it bleeds the strip
    // once at the end instead.
    const bleedEnd = (bl?.enabled && (!bl.perDab || st?.enabled))
      ? { radius: bl.radius, strength: bl.strength }
      : undefined;
    this.stampPipeline.endStroke(weSettings, bleedEnd);

    this.isActive = false;
    this.targetTexture = null;
    this.strokeVertices = [];
  }

  public get strokeActive(): boolean {
    return this.isActive;
  }

  /**
   * Abandon the live stroke: the texture goes back to its stroke-start pixels (BrushStampPipeline.abortStroke — GPU
   * only, no readback) and no undo patch is made. UV paint uses it when a second finger turns a stroke into a pinch.
   * Returns true when the stroke had written something that was put back.
   */
  public abortStroke(): boolean {
    if (!this.isActive) return false;
    const restored = this.stampPipeline.abortStroke();
    this.isActive = false;
    this.targetTexture = null;
    this.strokeVertices = [];
    this._dirty = null;
    this._maxDabRadius = 0;
    return restored;
  }

  /**
   * Pen-up / pen-down INSIDE the live stroke (UV paint seam jump): finish the current run at `runEnd` exactly like
   * endStroke would (the stabilizer catch-up dabs), then start a new run at `next` exactly like beginStroke would
   * (fresh stabilizer, spacing, velocity and smudge pickup; a dab at the new point) — with no interpolated line in
   * between and without ending the stroke (no undo patch, no base copy). One stroke = one undo step.
   * False (nothing done) when no stroke is live or the preset draws a stroke-texture strip: the strip is one
   * polyline over the whole stroke, so it would bridge the gap — the caller ends + restarts instead.
   * `nextSizeScale` (optional): the new run's size scale, applied after the old run's catch-up dabs.
   */
  public liftTo(runEnd: PointerInput, next: PointerInput, nextSizeScale?: number): boolean {
    if (!this.isActive || !this.targetTexture || !this.preset) return false;
    if (this.preset.strokeTexture?.enabled) return false;
    this.stampPipeline.clearProvisional();
    const flushed = this.stabilizer.flush({ x: runEnd.x, y: runEnd.y, pressure: runEnd.pressure, timestamp: runEnd.timestamp });
    for (const pt of flushed) {
      this.collectStrokeVertex(pt);
      this.interpolateDabs(pt);
    }
    if (nextSizeScale !== undefined) this.setSizeScale(nextSizeScale);
    this.distanceSinceLastDab = 0;
    this.currentVelocity = 0;
    this.stabilizer.reset();
    this._smudgeColor = [0, 0, 0, 0];
    this._smudgeReadbackPending = false;
    const smoothed = this.stabilizer.push({
      x: next.x, y: next.y, pressure: next.pressure, timestamp: next.timestamp, tiltX: next.tiltX, tiltY: next.tiltY,
    });
    this.collectStrokeVertex(smoothed);
    this.stampDab(smoothed.x, smoothed.y, smoothed.pressure, smoothed.timestamp, smoothed.tiltX ?? 0, smoothed.tiltY ?? 0);
    this.lastDabX = smoothed.x;
    this.lastDabY = smoothed.y;
    this.lastDabTime = smoothed.timestamp;
    this.lastDabPressure = smoothed.pressure;
    this.lastDabTiltX = smoothed.tiltX ?? 0;
    this.lastDabTiltY = smoothed.tiltY ?? 0;
    return true;
  }

  /** The live stroke's touched region so far (dab centres, padded like {@link takeStrokeDirtyRect}) WITHOUT
   *  consuming it, or null. A live preview (the UV pane readback) reads just this region mid-stroke. */
  public peekStrokeDirtyRect(): { x: number; y: number; w: number; h: number } | null {
    const d = this._dirty;
    if (!d) return null;
    const pad = Math.ceil(this._maxDabRadius * 2 + 64);
    return {
      x: Math.floor(d.x0 - pad), y: Math.floor(d.y0 - pad),
      w: Math.ceil(d.x1 - d.x0 + 2 * pad), h: Math.ceil(d.y1 - d.y0 + 2 * pad),
    };
  }

  // ── Provisional (predicted) tail — BRUSH-4 stroke prediction ──────

  /** Upper bound on dabs in one provisional tail (bounded dispatches; a longer tail is cut short). */
  public static readonly MAX_PROVISIONAL_DABS = 96;
  /** Non-null while drawProvisional collects dabs instead of stamping them. */
  private _provisionalDabs: StampParams[] | null = null;

  /**
   * Can the live stroke's preset draw a provisional tail? Not for SMUDGE (each dab samples the canvas and the
   * pickup colour carries into the next dab — a predicted dab would leak into the real stroke's colour) nor
   * PER-DAB BLEED (it spreads paint over the whole accum: a provisional pass would be full-canvas work). Erase and
   * blend-mode brushes ARE supported: the provisional pass saves and restores the texels it touches on any path.
   */
  public get provisionalSupported(): boolean {
    const p = this.preset;
    if (!p) return false;
    if (p.smudge?.enabled) return false;
    if (p.bleed?.enabled && p.bleed.perDab) return false;
    return true;
  }

  /**
   * Draw a PROVISIONAL tail for `points` (predicted pointer samples, after the last real one): they run through the
   * stabilizer, spacing and dynamics exactly like real points, but the dabs go to BrushStampPipeline.drawProvisional
   * (shown until the next clearProvisional / real dab / stroke end, then restored byte-exactly) and every bit of
   * stroke state they touched (stabilizer, last dab, spacing remainder, velocity, strip vertices, dirty rect) is put
   * back. So the committed stroke, its undo patch and anything saved are the same as with no prediction.
   * Returns true when a tail was drawn.
   */
  public drawProvisional(points: readonly PointerInput[]): boolean {
    this.stampPipeline.clearProvisional();
    if (!this.isActive || !this.targetTexture || !this.preset || points.length === 0 || !this.provisionalSupported) return false;
    const saved = {
      lastDabX: this.lastDabX, lastDabY: this.lastDabY, lastDabTime: this.lastDabTime,
      lastDabPressure: this.lastDabPressure, lastDabTiltX: this.lastDabTiltX, lastDabTiltY: this.lastDabTiltY,
      currentVelocity: this.currentVelocity, distanceSinceLastDab: this.distanceSinceLastDab,
      vertices: this.strokeVertices.length,
      dirty: this._dirty ? { ...this._dirty } : null, maxDabRadius: this._maxDabRadius,
      stab: this.stabilizer.saveState(),
    };
    const dabs: StampParams[] = [];
    this._provisionalDabs = dabs;
    try {
      for (const p of points) {
        if (dabs.length >= BrushEngine.MAX_PROVISIONAL_DABS) break;
        this.addPoint(p);
      }
    } finally {
      this._provisionalDabs = null;
      this.lastDabX = saved.lastDabX; this.lastDabY = saved.lastDabY; this.lastDabTime = saved.lastDabTime;
      this.lastDabPressure = saved.lastDabPressure; this.lastDabTiltX = saved.lastDabTiltX; this.lastDabTiltY = saved.lastDabTiltY;
      this.currentVelocity = saved.currentVelocity; this.distanceSinceLastDab = saved.distanceSinceLastDab;
      this.strokeVertices.length = saved.vertices;
      this._dirty = saved.dirty; this._maxDabRadius = saved.maxDabRadius;
      this.stabilizer.restoreState(saved.stab);
    }
    if (dabs.length > BrushEngine.MAX_PROVISIONAL_DABS) dabs.length = BrushEngine.MAX_PROVISIONAL_DABS;
    return this.stampPipeline.drawProvisional(this.targetTexture, dabs);
  }

  /** Take the provisional tail back (byte-exact). True when one was showing. */
  public clearProvisional(): boolean {
    return this.stampPipeline.clearProvisional();
  }

  /** True while a provisional tail is on the texture. */
  public get hasProvisional(): boolean {
    return this.stampPipeline.hasProvisional;
  }

  public destroy(): void {
    this.stampPipeline.destroy();
    this.tipGenerator.destroy();
    this.strokeTextureRenderer.destroy();
  }

  // ── Stroke vertex collection ──────────────────────────────────────

  /**
   * Collect a vertex for stroke texture mapping.
   * Records position and pressure-based width for the textured strip mesh.
   */
  private collectStrokeVertex(pt: StabilizedPoint): void {
    if (!this.preset) return;
    const dyn = this.preset.dynamics;
    const sizeFactor = evaluateCurve(dyn.sizePressureCurve ?? LINEAR_CURVE, pt.pressure);
    const diameter = (this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor) * this.brushSizeScale;
    this.strokeVertices.push({
      x: pt.x,
      y: pt.y,
      pressure: pt.pressure,
      width: Math.max(1, diameter / 2), // half-width (radius)
    });
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Walk from the last dab position to `target`, placing dabs at spacing intervals.
   */
  private interpolateDabs(target: StabilizedPoint): void {
    const dx = target.x - this.lastDabX;
    const dy = target.y - this.lastDabY;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);

    // Accumulate sub-pixel movements instead of discarding them.
    if (segmentLength < 0.001) return; // truly zero movement, skip

    // Spacing = fraction of current brush diameter (in texels)
    const sizeFactor = evaluateCurve(
      this.preset.dynamics.sizePressureCurve ?? LINEAR_CURVE,
      target.pressure,
    );
    const currentDiameter = (this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor) * this.brushSizeScale;
    const spacingPx = Math.max(1, currentDiameter * this.preset.spacing);

    // How far along the segment we need to travel to reach the next dab
    let traveled = this.distanceSinceLastDab;

    let dabPlaced = false;

    while (traveled + spacingPx <= segmentLength + this.distanceSinceLastDab) {
      traveled += spacingPx;
      const t = (traveled - this.distanceSinceLastDab) / segmentLength;
      if (t > 1) break;

      const dabX = this.lastDabX + dx * t;
      const dabY = this.lastDabY + dy * t;
      // Lerp pressure and tilt between previous dab and target for smooth transitions
      const dabPressure = this.lastDabPressure + (target.pressure - this.lastDabPressure) * t;
      const dabTiltX = this.lastDabTiltX + ((target.tiltX ?? 0) - this.lastDabTiltX) * t;
      const dabTiltY = this.lastDabTiltY + ((target.tiltY ?? 0) - this.lastDabTiltY) * t;
      const dabTime = this.lastDabTime + (target.timestamp - this.lastDabTime) * t;

      this.stampDab(dabX, dabY, dabPressure, dabTime, dabTiltX, dabTiltY);
      dabPlaced = true;
    }

    // Track remaining distance for the next segment
    this.distanceSinceLastDab = (segmentLength + this.distanceSinceLastDab) - traveled;
    if (this.distanceSinceLastDab < 0) this.distanceSinceLastDab = 0;

    // CRITICAL: only update lastDabX/Y to the target if a dab was actually placed.
    // Otherwise, keep lastDabX/Y at the previous position so that distance
    // accumulates correctly across multiple small segments. Without this,
    // slow strokes with soft/large brushes (high spacing) never accumulate
    // enough distance to place a dab because lastDabX/Y keeps jumping forward.
    if (dabPlaced) {
      this.lastDabX = target.x;
      this.lastDabY = target.y;
      this.lastDabPressure = target.pressure;
      this.lastDabTiltX = target.tiltX ?? 0;
      this.lastDabTiltY = target.tiltY ?? 0;
    }
    this.lastDabTime = target.timestamp;
  }

  /**
   * Evaluate dynamics and dispatch a single dab to the GPU.
   */
  private stampDab(x: number, y: number, pressure: number, _timestamp: number, tiltX: number = 0, tiltY: number = 0): void {
    if (!this.targetTexture || !this.preset) return;

    const dyn = this.preset.dynamics;

    // ── Evaluate dynamics ──
    const sizeFactor = evaluateCurve(dyn.sizePressureCurve ?? LINEAR_CURVE, pressure);
    const opacityFactor = evaluateCurve(dyn.opacityPressureCurve ?? LINEAR_CURVE, pressure);
    const flowFactor = evaluateCurve(dyn.flowPressureCurve ?? LINEAR_CURVE, pressure);

    // Velocity → size multiplier (0-1 range, where velocity is normalized to ~2 texels/ms max)
    let velocitySizeFactor = 1.0;
    if (dyn.sizeVelocityCurve && dyn.sizeVelocityCurve.length >= 2) {
      // Normalize velocity to 0-1 range. ~2 texels/ms is fast pen movement.
      const normalizedVel = Math.min(1, this.currentVelocity / 2.0);
      velocitySizeFactor = evaluateCurve(dyn.sizeVelocityCurve, normalizedVel);
    }

    // Tilt → rotation: derive rotation from pen tilt direction
    let rotationOffset = 0;
    if (dyn.rotationPressureCurve) {
      rotationOffset = evaluateCurve(dyn.rotationPressureCurve, pressure) * Math.PI * 2;
    }
    if (dyn.rotationRandomJitter) {
      rotationOffset += (Math.random() - 0.5) * 2 * dyn.rotationRandomJitter;
    }
    // Tilt-based rotation: if pen is tilted, rotate the dab to match tilt direction
    if (Math.abs(tiltX) > 5 || Math.abs(tiltY) > 5) {
      const tiltAngle = Math.atan2(tiltY, tiltX);
      rotationOffset += tiltAngle;
    }

    // Size with jitter + velocity
    let sizeJitter = 1.0;
    if (dyn.sizeRandomJitter) {
      sizeJitter = 1.0 + (Math.random() - 0.5) * 2 * dyn.sizeRandomJitter;
    }

    const diameter = (this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor) * sizeJitter * velocitySizeFactor * this.brushSizeScale;
    const radius = Math.max(1, diameter / 2);

    // Opacity × opacity pressure = the dab's coverage CEILING; flow × flow pressure = how much of the way there one
    // dab goes (the stamp shader builds overlapping dabs up toward the ceiling). Flow 1 = the old max-of-dabs stroke.
    let alpha = this.preset.blending.opacity * opacityFactor;
    const flow = Math.max(0, Math.min(1, this.preset.blending.flow * flowFactor));

    // ── Color jitter ──
    const jitter = this.preset.colorJitter;
    let r = this.strokeColor[0];
    let g = this.strokeColor[1];
    let b = this.strokeColor[2];
    if (jitter && (jitter.hueJitter > 0 || jitter.saturationJitter > 0 || jitter.brightnessJitter > 0)) {
      let [h, s, v] = rgbToHsb(r, g, b);
      if (jitter.hueJitter > 0) {
        h = (h + (Math.random() - 0.5) * 2 * (jitter.hueJitter / 360)) % 1;
        if (h < 0) h += 1;
      }
      if (jitter.saturationJitter > 0) {
        s = Math.max(0, Math.min(1, s + (Math.random() - 0.5) * 2 * jitter.saturationJitter));
      }
      if (jitter.brightnessJitter > 0) {
        v = Math.max(0, Math.min(1, v + (Math.random() - 0.5) * 2 * jitter.brightnessJitter));
      }
      [r, g, b] = hsbToRgb(h, s, v);
    }
    if (jitter?.opacityJitter && jitter.opacityJitter > 0) {
      alpha = Math.max(0, Math.min(1, alpha + (Math.random() - 0.5) * 2 * jitter.opacityJitter));
    }

    // ── Smudge: mix brush color with picked-up canvas color (1-dab lag) ──
    const smudge = this.preset.smudge;
    if (smudge?.enabled && this._smudgeColor[3] > 0) {
      const t = Math.min(1, smudge.strength * pressure);
      r = r + (this._smudgeColor[0] - r) * t;
      g = g + (this._smudgeColor[1] - g) * t;
      b = b + (this._smudgeColor[2] - b) * t;
    }

    // Scatter: evaluate scatter pressure curve if present, else use flat scatterDistance
    let dabX = x;
    let dabY = y;
    let scatterDist = dyn.scatterDistance ?? 0;
    if (dyn.scatterPressureCurve && dyn.scatterPressureCurve.length >= 2) {
      scatterDist *= evaluateCurve(dyn.scatterPressureCurve, pressure);
    }
    if (scatterDist > 0) {
      const scatterPx = scatterDist * diameter;
      const angle = Math.random() * Math.PI * 2;
      dabX += Math.cos(angle) * scatterPx * (Math.random());
      dabY += Math.sin(angle) * scatterPx * (Math.random());
    }

    // E5 tail: accumulate the stroke's DIRTY RECT over the FINAL (post-scatter) dab centres. The
    // radius-based pad is applied once in takeStrokeDirtyRect (soft edge / wet halo / bleed / dual tip).
    if (radius > this._maxDabRadius) this._maxDabRadius = radius;
    if (!this._dirty) this._dirty = { x0: dabX, y0: dabY, x1: dabX, y1: dabY };
    else {
      const d = this._dirty;
      if (dabX < d.x0) d.x0 = dabX; else if (dabX > d.x1) d.x1 = dabX;
      if (dabY < d.y0) d.y0 = dabY; else if (dabY > d.y1) d.y1 = dabY;
    }

    // Determine blend mode
    // 0 = normal, 1 = erase-fade, 2 = erase-clear, 3 = erase-hard,
    // 4 = multiply, 5 = screen, 6 = overlay
    let mode = 0; // paint (normal)
    if (this.eraseModeOverride !== null) {
      mode = this.eraseModeOverride;
    } else if (this.preset.category === 'Eraser') {
      mode = 1; // default erase-fade for eraser presets
    } else {
      // Map preset blend mode to shader mode
      const blendMode = this.preset.blending.mode;
      if (blendMode === 'multiply') mode = 4;
      else if (blendMode === 'screen') mode = 5;
      else if (blendMode === 'overlay') mode = 6;
    }

    // Get tip texture (the eraser tool's soft / hard variant while erasing)
    const tipTexture = this.tipGenerator.getTipTexture(this.dabTip(mode));
    const brushTexture = this.resolveBrushTexture();
    const tx = this.preset.texture;

    // ── Dual brush per-dab rotation ──
    let dualRotation = 0;
    const dual = this.preset.dualBrush;
    if (dual?.enabled && dual.randomRotation) {
      dualRotation = Math.random() * Math.PI * 2;
    }

    const params: StampParams = {
      cx: dabX,
      cy: dabY,
      radius,
      color: [r, g, b, Math.max(0, Math.min(1, alpha))],
      flow,
      rotation: rotationOffset,
      mode,
      aspect: this.aspectCorrection,
      tipTexture,
      lockTransparency: this.lockTransparency,
      selectionMask: this.selectionMask,
      grainTexture: this.grainManager?.getGrainTexture() ?? null,
      grainInvScale: this.grainManager?.getGrainInvScale() ?? [0, 0],
      grainStrength: this.grainManager?.getGrainStrength() ?? 0,
      // Dual brush
      dualBrushTexture: (dual?.enabled && this.dualBrushTexture) ? this.dualBrushTexture : null,
      dualBrushScale: dual?.scale ?? 1,
      dualBrushStrength: dual?.strength ?? 0,
      dualBrushBlendOp: dual?.blendOp === 'subtract' ? 1 : dual?.blendOp === 'minimum' ? 2 : 0,
      dualBrushTileMode: dual?.tileMode === 'canvas-tiling' ? 1 : 0,
      dualBrushRotation: dualRotation,
      // The preset's own texture
      brushTexture,
      brushTextureScale: tx?.scale ?? 1,
      brushTextureStrength: brushTexture ? Math.max(0, Math.min(1, tx?.strength ?? 0)) : 0,
      brushTextureMode: tx?.mode === 'subtract' ? 1 : 0,
      brushTextureOrigin: tx?.fixedToCanvas === false ? this.strokeAnchor : CANVAS_ORIGIN,
    };

    // Stroke prediction: collect the dab for the provisional pass instead of stamping it (no smudge pickup — the
    // provisional pass excludes smudge and per-dab bleed presets, see provisionalSupported).
    if (this._provisionalDabs) {
      if (this._provisionalDabs.length < BrushEngine.MAX_PROVISIONAL_DABS) this._provisionalDabs.push(params);
      return;
    }

    const bl = this.preset?.bleed;
    const bleedPerDab = (bl?.enabled && bl.perDab && !this.preset.strokeTexture?.enabled)
      ? { radius: bl.radius, strength: bl.strength }
      : undefined;
    this.stampPipeline.stampWithPingPong(this.targetTexture, params, bleedPerDab);

    // ── Smudge readback: sample canvas color under brush for next dab ──
    if (smudge?.enabled && !this._smudgeReadbackPending && this.targetTexture) {
      // (samplePixel flushes the open dab batch first, so it reads this dab — same as before batching)
      this._smudgeReadbackPending = true;
      const tex = this.targetTexture;
      this.stampPipeline.samplePixel(tex, dabX, dabY).then(color => {
        this._smudgeColor = color;
        this._smudgeReadbackPending = false;
      }).catch(() => {
        this._smudgeReadbackPending = false;
      });
    }
  }

  /**
   * Set the stroke color (RGB in 0-1). Called before beginStroke.
   */
  private strokeColor: [number, number, number, number] = [0, 0, 0, 1];

  public setStrokeColor(r: number, g: number, b: number, a: number = 1): void {
    this.strokeColor = [r, g, b, a];
  }
}
