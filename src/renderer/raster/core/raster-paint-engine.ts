/**
 * RasterPaintEngine — the single entry-point for all raster painting operations.
 *
 * Owns:
 *  • BrushEngine (dab stamping, dynamics, stabilization)
 *  • RasterSnapshotManager (undo/redo)
 *  • Brush preset library (CRUD, import/export)
 *  • Active texture reference
 *
 * The RasterDrawingService talks to this class — not to the renderer directly.
 * The WebGPURenderer creates one RasterPaintEngine at init and exposes it.
 */

import { BrushEngine, PointerInput } from '../brushes/brush-engine';
import { RasterSnapshotManager } from './raster-snapshot-manager';
import {
  BrushPreset,
  serializePreset,
  deserializePreset,
  generatePresetId,
  BRUSH_PRESET_VERSION,
  LINEAR_CURVE,
  CONSTANT_CURVE,
} from '../brushes/brush-preset';
import { CanvasGrainManager, CanvasGrainSettings, CanvasGrainType } from '../canvas-grain';

export class RasterPaintEngine {
  private device: GPUDevice;

  // Sub-systems
  public readonly brushEngine: BrushEngine;
  public readonly snapshotManager: RasterSnapshotManager;

  // Active painting state
  private activeTexture: GPUTexture | null = null;
  private activePresetId: string | null = null;

  // Preset library
  private presets = new Map<string, BrushPreset>();

  // Brush color (set by the service / UI)
  private brushColor: [number, number, number, number] = [0, 0, 0, 1];

  // Aspect correction (set from renderer based on canvas geometry)
  private aspectCorrection: [number, number] = [1, 1];

  // Callback to schedule a render after each dab
  private scheduleRender: () => void;

  // Brush grain: per-brush texture that modulates dab alpha (controlled from brush editor)
  public readonly brushGrainManager: CanvasGrainManager;
  // Paper grain: global canvas material texture applied as a post-process overlay
  public readonly paperGrainManager: CanvasGrainManager;

  /** @deprecated Use brushGrainManager instead. Kept for back-compat references. */
  public get canvasGrainManager(): CanvasGrainManager { return this.brushGrainManager; }

  constructor(device: GPUDevice, scheduleRender: () => void) {
    this.device = device;
    this.scheduleRender = scheduleRender;
    this.brushEngine = new BrushEngine(device);
    this.snapshotManager = new RasterSnapshotManager(device);

    // Two independent grain managers so brush editor & paper material never collide
    this.brushGrainManager = new CanvasGrainManager(device);
    this.paperGrainManager = new CanvasGrainManager(device);

    // Wire brush grain to the brush engine (per-stroke modulation)
    this.brushEngine.setCanvasGrainManager(this.brushGrainManager);

    // Seed default presets
    this.registerDefaultPresets();
  }

  // ── Texture management ────────────────────────────────────────────

  /** Set the texture that painting operations will target. */
  public setActiveTexture(texture: GPUTexture | null): void {
    this.activeTexture = texture;
  }

  public getActiveTexture(): GPUTexture | null {
    return this.activeTexture;
  }

  /** Initialize undo history with the current texture state. */
  public async initializeSnapshots(): Promise<void> {
    if (this.activeTexture) {
      await this.snapshotManager.initialize(this.activeTexture);
    }
  }

  // ── Brush color & config ──────────────────────────────────────────

  public setBrushColor(r: number, g: number, b: number, a: number = 1): void {
    this.brushColor = [r, g, b, a];
    this.brushEngine.setStrokeColor(r, g, b, a);
  }

  public setAspectCorrection(aspect: [number, number]): void {
    this.aspectCorrection = aspect;
    this.brushEngine.setAspectCorrection(aspect);
  }

  /** Set erase mode: null = use preset default, 1 = fade, 2 = clear, 3 = hard. */
  public setEraseMode(mode: number | null): void {
    this.brushEngine.setEraseModeOverride(mode);
  }

  /** Per-dab brush-size multiplier (1 = normal). 3D-surface painting sets this from the local UV density so a
   *  stroke stays a constant physical size on the mesh despite unwrap stretch. Reset to 1 for 2D/UV-pane paint. */
  public setSizeScale(scale: number): void {
    this.brushEngine.setSizeScale(scale);
  }

  /** Lock transparency: when true, paint only where existing alpha > 0. */
  public setLockTransparency(locked: boolean): void {
    this.brushEngine.setLockTransparency(locked);
  }

  /** Set the selection mask texture. When non-null, painting is constrained to selected pixels. */
  public setSelectionMask(mask: GPUTexture | null): void {
    this.brushEngine.setSelectionMask(mask);
  }

  // ── Brush grain (per-brush texture, set from brush editor) ────────

  /** Set the per-brush grain that modulates dab alpha during painting. */
  public setBrushGrain(settings: CanvasGrainSettings): void {
    this.brushGrainManager.setGrain(settings);
    this.scheduleRender();
  }

  /** Get the current per-brush grain settings. */
  public getBrushGrain(): CanvasGrainSettings {
    return this.brushGrainManager.getSettings();
  }

  /** @deprecated Use setBrushGrain instead. */
  public setCanvasGrain(settings: CanvasGrainSettings): void {
    this.setBrushGrain(settings);
  }

  /** @deprecated Use getBrushGrain instead. */
  public getCanvasGrain(): CanvasGrainSettings {
    return this.getBrushGrain();
  }

  // ── Paper grain (global canvas material, like real paper) ─────────

  /** Set the global paper grain — the physical paper/canvas material texture. */
  public setPaperGrain(settings: CanvasGrainSettings): void {
    this.paperGrainManager.setGrain(settings);
    this.scheduleRender();
  }

  /** Get the current paper grain settings. */
  public getPaperGrain(): CanvasGrainSettings {
    return this.paperGrainManager.getSettings();
  }

  // ── Shared grain helpers ──────────────────────────────────────────

  /** Get all available grain type names (for UI dropdowns). */
  public getAvailableGrainTypes(): CanvasGrainType[] {
    return CanvasGrainManager.getAvailableTypes();
  }

  // ── Stroke lifecycle (called by RasterDrawingService) ─────────────

  public beginStroke(input: PointerInput): void {
    if (!this.activeTexture) {
      console.warn('RasterPaintEngine: no active texture');
      return;
    }
    this.brushEngine.setStrokeColor(...this.brushColor);
    this.brushEngine.setAspectCorrection(this.aspectCorrection);
    this.brushEngine.beginStroke(this.activeTexture, input);
    this.scheduleRender();
  }

  public addStrokePoint(input: PointerInput): void {
    this.brushEngine.addPoint(input);
    this.scheduleRender();
  }

  public async endStroke(input: PointerInput): Promise<void> {
    this.brushEngine.endStroke(input);
    this.scheduleRender();

    // Push snapshot for undo after the stroke finishes
    if (this.activeTexture) {
      await this.snapshotManager.pushSnapshot(this.activeTexture);
    }
  }

  // ── Undo / Redo ──────────────────────────────────────────────────

  public async undo(): Promise<boolean> {
    if (!this.activeTexture) return false;
    const ok = await this.snapshotManager.undo(this.activeTexture);
    if (ok) this.scheduleRender();
    return ok;
  }

  public async redo(): Promise<boolean> {
    if (!this.activeTexture) return false;
    const ok = await this.snapshotManager.redo(this.activeTexture);
    if (ok) this.scheduleRender();
    return ok;
  }

  // ── Preset library ────────────────────────────────────────────────

  /** Get all registered presets (for UI listing). */
  public getPresets(): BrushPreset[] {
    return Array.from(this.presets.values());
  }

  /** Get a preset by id. */
  public getPreset(id: string): BrushPreset | undefined {
    return this.presets.get(id);
  }

  /** Set the active brush by preset id. */
  public setActivePreset(id: string): boolean {
    const preset = this.presets.get(id);
    if (!preset) {
      console.warn('RasterPaintEngine: preset not found:', id);
      return false;
    }
    this.activePresetId = id;
    this.brushEngine.setPreset(preset);
    return true;
  }

  public getActivePresetId(): string | null {
    return this.activePresetId;
  }

  /** Register a preset (for programmatic creation or after import). */
  public registerPreset(preset: BrushPreset): void {
    this.presets.set(preset.id, preset);
  }

  /** Delete a preset. Cannot delete built-in defaults. */
  public deletePreset(id: string): boolean {
    return this.presets.delete(id);
  }

  /** Update fields on an existing preset (partial merge). */
  public updatePreset(id: string, changes: Record<string, any>): boolean {
    const existing = this.presets.get(id);
    if (!existing) return false;
    Object.assign(existing, changes);
    // If this is the active preset, re-apply it to the engine so changes take effect
    if (this.activePresetId === id) {
      this.brushEngine.setPreset(existing);
    }
    return true;
  }

  /** Serialize a preset to JSON string (for export to Frogmarks). */
  public exportPreset(id: string): string | null {
    const preset = this.presets.get(id);
    if (!preset) return null;
    return serializePreset(preset);
  }

  /** Import a preset from JSON string (from Frogmarks). Returns the id. */
  public importPreset(json: string): string {
    const preset = deserializePreset(json);
    // Preserve original id if present; only generate a new one if missing.
    // This prevents duplication when restoring saved documents that
    // re-import the default presets already registered at startup.
    if (!preset.id) {
      preset.id = generatePresetId();
    }
    this.presets.set(preset.id, preset);
    return preset.id;
  }

  /** Export all presets as a JSON array string. */
  public exportAllPresets(): string {
    return JSON.stringify(this.getPresets(), null, 2);
  }

  /** Import multiple presets from a JSON array string. Returns the ids. */
  public importPresets(json: string): string[] {
    const arr = JSON.parse(json) as BrushPreset[];
    const ids: string[] = [];
    for (const p of arr) {
      // Preserve original id to avoid duplication on document restore.
      // Only generate a fresh id if the preset has no id at all.
      if (!p.id) {
        p.id = generatePresetId();
      }
      this.presets.set(p.id, p);
      ids.push(p.id);
    }
    return ids;
  }

  // ── Default presets ───────────────────────────────────────────────

  private registerDefaultPresets(): void {
    const defaults = createDefaultPresets();
    for (const p of defaults) {
      this.presets.set(p.id, p);
    }
    // Activate the first one
    if (defaults.length > 0) {
      this.activePresetId = defaults[0].id;
      this.brushEngine.setPreset(defaults[0]);
    }
  }

  public destroy(): void {
    this.brushEngine.destroy();
    this.snapshotManager.destroy();
    this.brushGrainManager.destroy();
    this.paperGrainManager.destroy();
  }
}

// ── Default preset definitions ──────────────────────────────────────

export function createDefaultPresets(): BrushPreset[] {
  return [
    // 1. Round Brush (soft)
    {
      id: 'default_round_soft',
      name: 'Round Soft',
      category: 'Pen',
      tip: { type: 'parametric', hardness: 0.3, roundness: 1.0, angle: 0 },
      spacing: 0.1,
      dynamics: {
        sizePressureCurve: LINEAR_CURVE,
        opacityPressureCurve: CONSTANT_CURVE,
        flowPressureCurve: LINEAR_CURVE,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 0.8 },
      stabilization: { method: 'moving-average', level: 3 },
      antiAliasing: true,
      minSize: 2,
      maxSize: 64,
      version: BRUSH_PRESET_VERSION,
    },
    // 2. Hard Pen (inking)
    {
      id: 'default_hard_pen',
      name: 'Hard Pen',
      category: 'Pen',
      tip: { type: 'parametric', hardness: 1.0, roundness: 1.0, angle: 0 },
      spacing: 0.05,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }],
        opacityPressureCurve: CONSTANT_CURVE,
        flowPressureCurve: CONSTANT_CURVE,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 1.0 },
      stabilization: { method: 'moving-average', level: 5 },
      antiAliasing: true,
      minSize: 1,
      maxSize: 32,
      version: BRUSH_PRESET_VERSION,
    },
    // 3. Airbrush
    {
      id: 'default_airbrush',
      name: 'Airbrush',
      category: 'Airbrush',
      tip: { type: 'parametric', hardness: 0.0, roundness: 1.0, angle: 0 },
      spacing: 0.08,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }],
        opacityPressureCurve: LINEAR_CURVE,
        flowPressureCurve: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.15 }, { x: 1, y: 0.4 }],
      },
      blending: { mode: 'normal', opacity: 0.6, flow: 0.15 },
      stabilization: { method: 'none', level: 0 },
      antiAliasing: true,
      minSize: 10,
      maxSize: 200,
      version: BRUSH_PRESET_VERSION,
    },
    // 4. Eraser (soft)
    {
      id: 'default_eraser',
      name: 'Eraser',
      category: 'Eraser',
      tip: { type: 'parametric', hardness: 0.5, roundness: 1.0, angle: 0 },
      spacing: 0.1,
      dynamics: {
        sizePressureCurve: LINEAR_CURVE,
        opacityPressureCurve: LINEAR_CURVE,
        flowPressureCurve: CONSTANT_CURVE,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 1.0 },
      stabilization: { method: 'none', level: 0 },
      antiAliasing: true,
      minSize: 4,
      maxSize: 80,
      version: BRUSH_PRESET_VERSION,
    },
    // 5. Flat Pen (calligraphy / manga nib)
    {
      id: 'default_flat_pen',
      name: 'Flat Pen',
      category: 'Pen',
      tip: { type: 'parametric', hardness: 0.9, roundness: 0.3, angle: Math.PI / 6 },
      spacing: 0.05,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }],
        opacityPressureCurve: CONSTANT_CURVE,
        flowPressureCurve: CONSTANT_CURVE,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 1.0 },
      stabilization: { method: 'moving-average', level: 4 },
      antiAliasing: true,
      minSize: 2,
      maxSize: 48,
      version: BRUSH_PRESET_VERSION,
    },

    // ── New realistic brush presets using dual brush / color jitter / wet edges ──

    // 6. Watercolor Wash — soft, wet edges, color jitter
    {
      id: 'default_watercolor_wash',
      name: 'Watercolor Wash',
      category: 'Watercolor',
      tip: { type: 'parametric', hardness: 0.05, roundness: 0.9, angle: 0 },
      spacing: 0.06,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.4 }, { x: 1, y: 1 }],
        opacityPressureCurve: LINEAR_CURVE,
        flowPressureCurve: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.12 }, { x: 1, y: 0.25 }],
        sizeRandomJitter: 0.05,
        rotationRandomJitter: 0.3,
      },
      blending: { mode: 'normal', opacity: 0.5, flow: 0.15 },
      stabilization: { method: 'moving-average', level: 2 },
      antiAliasing: true,
      colorJitter: {
        hueJitter: 3,
        saturationJitter: 0.08,
        brightnessJitter: 0.06,
        opacityJitter: 0.05,
      },
      wetEdges: {
        enabled: true,
        edgeDarkness: 0.5,
        edgeWidth: 3,
        strength: 0.65,
      },
      minSize: 20,
      maxSize: 150,
      version: BRUSH_PRESET_VERSION,
    },

    // 7. Gouache — opaque, slight color jitter, no wet edges
    {
      id: 'default_gouache',
      name: 'Gouache',
      category: 'Watercolor',
      tip: { type: 'parametric', hardness: 0.2, roundness: 0.85, angle: 0 },
      spacing: 0.08,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }],
        opacityPressureCurve: [{ x: 0, y: 0.7 }, { x: 1, y: 1 }],
        flowPressureCurve: [{ x: 0, y: 0.4 }, { x: 1, y: 0.9 }],
        rotationRandomJitter: 0.2,
      },
      blending: { mode: 'normal', opacity: 0.85, flow: 0.6 },
      stabilization: { method: 'moving-average', level: 3 },
      antiAliasing: true,
      colorJitter: {
        hueJitter: 2,
        saturationJitter: 0.05,
        brightnessJitter: 0.08,
        opacityJitter: 0,
      },
      minSize: 10,
      maxSize: 120,
      version: BRUSH_PRESET_VERSION,
    },

    // 8. Stippling Pen — high scatter, tiny hard dabs
    {
      id: 'default_stippling',
      name: 'Stippling',
      category: 'Stippling',
      tip: { type: 'parametric', hardness: 1.0, roundness: 1.0, angle: 0 },
      spacing: 0.4,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }],
        opacityPressureCurve: CONSTANT_CURVE,
        flowPressureCurve: CONSTANT_CURVE,
        scatterDistance: 1.5,
        sizeRandomJitter: 0.4,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 1.0 },
      stabilization: { method: 'none', level: 0 },
      antiAliasing: true,
      minSize: 1,
      maxSize: 6,
      version: BRUSH_PRESET_VERSION,
    },

    // 9. Dry Brush — uses dual brush (with canvas-tiling grunge) for texture
    // Note: textureData will be loaded from brush pack assets
    {
      id: 'default_dry_brush',
      name: 'Dry Brush',
      category: 'Pencil',
      tip: { type: 'parametric', hardness: 0.4, roundness: 0.75, angle: 0 },
      spacing: 0.07,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }],
        opacityPressureCurve: LINEAR_CURVE,
        flowPressureCurve: [{ x: 0, y: 0.3 }, { x: 1, y: 0.8 }],
        rotationRandomJitter: 0.15,
      },
      blending: { mode: 'normal', opacity: 0.9, flow: 0.5 },
      stabilization: { method: 'moving-average', level: 2 },
      antiAliasing: true,
      dualBrush: {
        enabled: false, // will be enabled when texture data is loaded from pack
        textureData: '',
        textureSize: 256,
        tileMode: 'canvas-tiling',
        scale: 1.2,
        blendOp: 'multiply',
        strength: 0.6,
        randomRotation: false,
      },
      colorJitter: {
        hueJitter: 0,
        saturationJitter: 0,
        brightnessJitter: 0.04,
        opacityJitter: 0.02,
      },
      minSize: 6,
      maxSize: 80,
      version: BRUSH_PRESET_VERSION,
    },

    // 10. Concept Art Shader — large soft tip, wet edges, color jitter
    {
      id: 'default_concept_shader',
      name: 'Concept Shader',
      category: 'Watercolor',
      tip: { type: 'parametric', hardness: 0.0, roundness: 0.7, angle: Math.PI / 8 },
      spacing: 0.05,
      dynamics: {
        sizePressureCurve: [{ x: 0, y: 0.5 }, { x: 1, y: 1 }],
        opacityPressureCurve: LINEAR_CURVE,
        flowPressureCurve: [{ x: 0, y: 0.02 }, { x: 0.5, y: 0.08 }, { x: 1, y: 0.2 }],
        sizeRandomJitter: 0.03,
      },
      blending: { mode: 'normal', opacity: 0.4, flow: 0.1 },
      stabilization: { method: 'moving-average', level: 4 },
      antiAliasing: true,
      colorJitter: {
        hueJitter: 5,
        saturationJitter: 0.1,
        brightnessJitter: 0.1,
        opacityJitter: 0.03,
      },
      wetEdges: {
        enabled: true,
        edgeDarkness: 0.3,
        edgeWidth: 2,
        strength: 0.4,
      },
      minSize: 30,
      maxSize: 250,
      version: BRUSH_PRESET_VERSION,
    },

    // 11. Mono-weight Liner — constant width, no dynamics
    {
      id: 'default_monoweight_liner',
      name: 'Mono-Weight Liner',
      category: 'Pen',
      tip: { type: 'parametric', hardness: 1.0, roundness: 1.0, angle: 0 },
      spacing: 0.04,
      dynamics: {
        sizePressureCurve: CONSTANT_CURVE,
        opacityPressureCurve: CONSTANT_CURVE,
        flowPressureCurve: CONSTANT_CURVE,
      },
      blending: { mode: 'normal', opacity: 1.0, flow: 1.0 },
      stabilization: { method: 'predictive', level: 6 },
      antiAliasing: true,
      minSize: 2,
      maxSize: 2, // fixed width (min == max)
      version: BRUSH_PRESET_VERSION,
    },
  ];
}
