/**
 * Brush preset schema — fully serializable to JSON for import/export.
 * No GPU state, no runtime handles. Pure data.
 */

// ─── Control Point for transfer curves ─────────────────────────────
/** A point on a dynamics transfer curve (normalized 0-1 on both axes). */
export interface ControlPoint {
  x: number; // input  (0 = no pressure/velocity, 1 = max)
  y: number; // output (0 = min value, 1 = max value)
}

// ─── Brush Tip ─────────────────────────────────────────────────────
export interface BrushTipParametric {
  type: 'parametric';
  hardness: number;   // 0-1: 0 = soft airbrush, 1 = hard circle
  roundness: number;  // 0-1: 1 = circle, <1 = ellipse
  angle: number;      // rotation of ellipse in radians
}

export interface BrushTipImage {
  type: 'image';
  /** Base64-encoded grayscale PNG (alpha channel = tip shape). */
  imageData: string;
  /** Native resolution of the tip image (px). */
  imageSize: number;
}

export type BrushTip = BrushTipParametric | BrushTipImage;

// ─── Dynamics (pressure/velocity/random → parameter curves) ────────
export interface BrushDynamics {
  /** Pressure → brush diameter multiplier (0-1). */
  sizePressureCurve: ControlPoint[];
  /** Pressure → per-dab opacity multiplier (0-1). */
  opacityPressureCurve: ControlPoint[];
  /** Pressure → flow (paint amount per dab) (0-1). */
  flowPressureCurve: ControlPoint[];
  /** Pressure → tip rotation offset (optional). */
  rotationPressureCurve?: ControlPoint[];
  /** Pressure → scatter distance (optional). */
  scatterPressureCurve?: ControlPoint[];
  /** Velocity → size multiplier (optional). */
  sizeVelocityCurve?: ControlPoint[];
  /** Random jitter on size (0 = none, 1 = ±100%). */
  sizeRandomJitter?: number;
  /** Random jitter on rotation in radians (0 = none). */
  rotationRandomJitter?: number;
  /** Scatter distance in brush-diameters (0 = none). */
  scatterDistance?: number;
}

// ─── Paper / Canvas Texture ────────────────────────────────────────
export interface BrushTexture {
  /** Base64-encoded tiling grayscale image. */
  imageData: string;
  scale: number;       // texture scale relative to dab (1 = 1:1)
  strength: number;    // 0-1 mix with the dab alpha
  mode: 'multiply' | 'subtract';
  /** true = texture stays fixed in canvas space; false = follows stroke. */
  fixedToCanvas: boolean;
}

// ─── Blending ──────────────────────────────────────────────────────
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export interface BrushBlending {
  mode: BlendMode;
  /** Max opacity for the entire stroke (0-1). */
  opacity: number;
  /** Per-dab opacity / flow (0-1). */
  flow: number;
}

// ─── Dual Brush (shape × texture) ─────────────────────────────────
/** Blend operation for combining dual brush texture with tip shape. */
export type DualBrushBlendOp = 'multiply' | 'subtract' | 'minimum';

export interface DualBrushSettings {
  /** Enable the dual brush texture. */
  enabled: boolean;
  /** Base64-encoded grayscale PNG texture (tiles within the dab). */
  textureData: string;
  /** Native resolution of the texture image. */
  textureSize: number;
  /** How the texture tiles: 'dab-local' = UV relative to dab, 'canvas-tiling' = UV in canvas space. */
  tileMode: 'dab-local' | 'canvas-tiling';
  /** Scale of the texture relative to the dab (1 = 1:1). */
  scale: number;
  /** Blend operation: how texture combines with tip shape. */
  blendOp: DualBrushBlendOp;
  /** Texture strength: 0 = no effect, 1 = full texture. */
  strength: number;
  /** Random rotation per dab (adds organic variation). */
  randomRotation: boolean;
}

// ─── Color Jitter ──────────────────────────────────────────────────
export interface ColorJitter {
  /** Per-dab hue variation (±degrees, 0-180). */
  hueJitter: number;
  /** Per-dab saturation variation (±amount, 0-1). */
  saturationJitter: number;
  /** Per-dab brightness variation (±amount, 0-1). */
  brightnessJitter: number;
  /** Per-dab opacity variation (±amount, 0-1). */
  opacityJitter: number;
}

// ─── Wet Edges ─────────────────────────────────────────────────────
export interface WetEdgeSettings {
  /** Enable wet edge post-processing. */
  enabled: boolean;
  /** How dark the edges become (0-1). */
  edgeDarkness: number;
  /** How wide the edge detection kernel is in texels (1-5). */
  edgeWidth: number;
  /** Overall strength of the wet edge effect (0-1). */
  strength: number;
}

// ─── Stroke Texture Mapping ────────────────────────────────────────
export interface StrokeTextureSettings {
  /** Enable stroke-texture rendering (replaces dab stamping). */
  enabled: boolean;
  /** Base64-encoded grayscale PNG strip texture. Horizontal = across stroke width, vertical = along stroke length. */
  textureData: string;
  /** Native size of the texture image. */
  textureSize: number;
  /** How many texels of texture per canvas-pixel of stroke length (controls tiling). */
  texelsPerUnit: number;
  /** Edge softness / feather amount (0-1). Softens the stroke edge mask. */
  edgeSoftness: number;
}

// ─── Bleed / Diffusion ─────────────────────────────────────────────
export interface BleedSettings {
  /** Enable paint bleed/diffusion beyond the stroke edge. */
  enabled: boolean;
  /** Spread radius in pixels (1–20). Controls how far paint bleeds. */
  radius: number;
  /** 0–1 mix between blurred and original stroke. 1 = full bleed. */
  strength: number;
  /** When true, bleed is applied after every dab (slower but more organic).
   *  When false, bleed is applied once at stroke end (faster). */
  perDab: boolean;
}

// ─── Smudge / Color Mixing ─────────────────────────────────────────
export interface SmudgeSettings {
  /** Enable smudge: picks up canvas color under the brush and mixes it into the stroke. */
  enabled: boolean;
  /** 0–1 how much canvas color bleeds into the brush color at full pressure. */
  strength: number;
  /** Radius in pixels to sample from the canvas around the dab center. */
  sampleRadius: number;
}

// ─── Stabilization ────────────────────────────────────────────────
export type StabilizationMethod = 'none' | 'moving-average' | 'predictive' | 'catmull-rom' | 'pull-string';

export interface BrushStabilization {
  method: StabilizationMethod;
  /** Smoothing strength (0-10). Higher = more latency but smoother. */
  level: number;
  /**
   * Pull-string length in pixels. Only used with 'pull-string' method.
   * The cursor drags a virtual string — the brush only moves when the
   * string goes taut. Produces very deliberate, controlled lines.
   * Typical values: 10–60px.
   */
  pullStringLength?: number;
}

// ─── Full Preset ───────────────────────────────────────────────────
export interface BrushPreset {
  id: string;
  name: string;
  /** Category for UI grouping ("Pen", "Pencil", "Airbrush", "Watercolor", "Eraser", etc.) */
  category: string;
  /** Optional base64-encoded thumbnail (PNG, small). */
  icon?: string;

  tip: BrushTip;
  /** Spacing between dabs as a fraction of brush diameter (0.01 - 2.0). */
  spacing: number;

  dynamics: BrushDynamics;
  /** Optional paper/canvas grain texture. */
  texture?: BrushTexture;
  blending: BrushBlending;
  stabilization: BrushStabilization;
  antiAliasing: boolean;

  /** Dual brush: multiply tip shape with a grunge/grain texture per dab. */
  dualBrush?: DualBrushSettings;
  /** Per-dab color randomization (hue/sat/brightness/opacity). */
  colorJitter?: ColorJitter;
  /** Wet edge effect: darkens/concentrates pigment at stroke borders. */
  wetEdges?: WetEdgeSettings;
  /** Stroke texture mapping: renders a textured strip along the stroke path. */
  strokeTexture?: StrokeTextureSettings;
  /** Paint bleed/diffusion: spreads paint beyond the stroke edge (watercolor, gouache). */
  bleed?: BleedSettings;
  /** Smudge: picks up canvas color and mixes it into the stroke (finger-smear, blending). */
  smudge?: SmudgeSettings;

  /** Minimum brush size in px (for size dynamics). */
  minSize: number;
  /** Maximum / base brush size in px. */
  maxSize: number;

  /** Schema version for forward compatibility. */
  version: number;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Linear identity curve (output = input). */
export const LINEAR_CURVE: ControlPoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** Constant curve (output always = 1 regardless of input). */
export const CONSTANT_CURVE: ControlPoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

/**
 * Evaluate a transfer curve at a given input value `t` (0-1).
 * Uses piecewise-linear interpolation between control points.
 */
export function evaluateCurve(curve: ControlPoint[], t: number): number {
  if (curve.length === 0) return t;
  if (curve.length === 1) return curve[0].y;

  const clamped = Math.max(0, Math.min(1, t));

  // Find the two surrounding control points
  if (clamped <= curve[0].x) return curve[0].y;
  if (clamped >= curve[curve.length - 1].x) return curve[curve.length - 1].y;

  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (clamped >= a.x && clamped <= b.x) {
      const segLen = b.x - a.x;
      if (segLen <= 0) return a.y;
      const frac = (clamped - a.x) / segLen;
      return a.y + (b.y - a.y) * frac;
    }
  }

  return curve[curve.length - 1].y;
}

/**
 * Validate a BrushPreset object, returning an array of error strings (empty = valid).
 */
export function validatePreset(p: Partial<BrushPreset>): string[] {
  const errors: string[] = [];
  if (!p.id) errors.push('Missing id');
  if (!p.name) errors.push('Missing name');
  if (!p.tip) errors.push('Missing tip');
  if (!p.dynamics) errors.push('Missing dynamics');
  if (!p.blending) errors.push('Missing blending');
  if (p.spacing !== undefined && (p.spacing < 0.01 || p.spacing > 2)) {
    errors.push(`spacing out of range: ${p.spacing}`);
  }
  if (p.blending) {
    if (p.blending.opacity < 0 || p.blending.opacity > 1) errors.push('blending.opacity out of range');
    if (p.blending.flow < 0 || p.blending.flow > 1) errors.push('blending.flow out of range');
  }
  if (p.tip?.type === 'parametric') {
    const t = p.tip as BrushTipParametric;
    if (t.hardness < 0 || t.hardness > 1) errors.push('tip.hardness out of range');
    if (t.roundness <= 0 || t.roundness > 1) errors.push('tip.roundness out of range');
  }
  return errors;
}

/**
 * Serialize a preset to a JSON string (for export / Frogmarks storage).
 */
export function serializePreset(preset: BrushPreset): string {
  return JSON.stringify(preset, null, 2);
}

/**
 * Deserialize a JSON string to a BrushPreset. Throws on invalid JSON.
 */
export function deserializePreset(json: string): BrushPreset {
  const parsed = JSON.parse(json) as BrushPreset;
  const errors = validatePreset(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid brush preset: ${errors.join(', ')}`);
  }
  return parsed;
}

/** Generate a short random id. */
export function generatePresetId(): string {
  return 'brush_' + Math.random().toString(36).slice(2, 10);
}

/** Current schema version. Bump when BrushPreset shape changes. */
export const BRUSH_PRESET_VERSION = 1;
