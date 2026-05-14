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
  evaluateCurve,
  LINEAR_CURVE,
} from './brush-preset';
import { BrushStabilizer, StabilizedPoint } from './brush-stabilizer';
import { BrushStampPipeline, StampParams } from './brush-stamp-pipeline';
import { BrushTipGenerator } from './brush-tip';
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

  // Stroke texture renderer (for charcoal/crayon/marker brushes)
  private strokeTextureRenderer: StrokeTextureRenderer;
  private strokeTextureGpu: GPUTexture | null = null;
  private strokeVertices: StrokeVertex[] = [];

  // Smudge: picked-up canvas color from previous dab (1-dab lag via async GPU readback)
  private _smudgeColor: [number, number, number, number] = [0, 0, 0, 0];
  private _smudgeReadbackPending = false;

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

    // Pre-load image tips async if needed
    if (preset.tip.type === 'image') {
      this.tipGenerator.loadImageTipAsync(preset.tip).catch(console.warn);
    }

    // Pre-load dual brush texture if configured
    this.dualBrushTexture = null;
    if (preset.dualBrush?.enabled && preset.dualBrush.textureData) {
      const key = `dual_${preset.id}_${preset.dualBrush.textureData.slice(0, 32)}`;
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
      const key = `stroke_${preset.id}_${preset.strokeTexture.textureData.slice(0, 32)}`;
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

  /**
   * Call at pointerdown. Sets up state for a new stroke.
   */
  public beginStroke(texture: GPUTexture, firstPoint: PointerInput): void {
    if (!this.preset) {
      console.warn('BrushEngine: no preset set');
      return;
    }

    this.targetTexture = texture;
    this.isActive = true;
    this.distanceSinceLastDab = 0;
    this.currentVelocity = 0;
    this.stabilizer.reset();
    this.strokeVertices = [];
    this._smudgeColor = [0, 0, 0, 0];
    this._smudgeReadbackPending = false;

    // Begin wet-stroke: snapshot the canvas and prepare the stroke accumulation layer
    this.stampPipeline.beginStroke(texture);

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
    const st = this.preset?.strokeTexture;
    if (st?.enabled && this.strokeVertices.length >= 2 && this.targetTexture) {
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
          [this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], this.strokeColor[3]],
          st.texelsPerUnit,
          st.edgeSoftness,
        );
      }
    }

    // End wet-stroke: apply wet edges / bleed if configured, then flatten stroke layer
    const we = this.preset?.wetEdges;
    const bl = this.preset?.bleed;
    const weSettings = we?.enabled
      ? { edgeDarkness: we.edgeDarkness, edgeWidth: we.edgeWidth, strength: we.strength }
      : undefined;
    const bleedEnd = (bl?.enabled && !bl.perDab)
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
    const diameter = this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor;
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
    const currentDiameter = this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor;
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

    const diameter = (this.preset.minSize + (this.preset.maxSize - this.preset.minSize) * sizeFactor) * sizeJitter * velocitySizeFactor;
    const radius = Math.max(1, diameter / 2);

    // Final per-dab alpha = preset opacity × flow × dynamics
    let alpha = this.preset.blending.opacity * this.preset.blending.flow * opacityFactor * flowFactor;

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

    // Get tip texture
    const tipTexture = this.tipGenerator.getTipTexture(this.preset.tip);

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
    };

    const bl = this.preset?.bleed;
    const bleedPerDab = (bl?.enabled && bl.perDab)
      ? { radius: bl.radius, strength: bl.strength }
      : undefined;
    this.stampPipeline.stampWithPingPong(this.targetTexture, params, bleedPerDab);

    // ── Smudge readback: sample canvas color under brush for next dab ──
    if (smudge?.enabled && !this._smudgeReadbackPending && this.targetTexture) {
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
