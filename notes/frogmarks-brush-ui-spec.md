# Frogmarks UI Spec — Realistic Brush Controls

> **For**: Frogmarks front-end team  
> **Salsa version**: Current (`npm run build` passing)  
> **Date**: April 2026

Everything below is already wired in Salsa's engine. Frogmarks just needs UI to expose it.

---

## Quick Summary

Seven control sections need to be added or updated in the **Brush Editor panel**:

| Section | Where in UI | Priority |
|---------|------------|----------|
| [Dual Brush](#1-dual-brush-texture) | New collapsible section in brush editor | 🔴 Highest |
| [Color Jitter](#2-color-jitter) | New collapsible section in brush editor | 🟡 Medium |
| [Wet Edges](#3-wet-edges) | New collapsible section in brush editor | 🟡 Medium |
| [Stroke Texture](#4-stroke-texture) | New collapsible section in brush editor | 🟢 Lower |
| [Velocity → Size Curve](#9a-velocity--size-curve-new) | Curve editor in Dynamics section | 🔴 Highest |
| [Scatter Pressure Curve](#9b-scatter-pressure-curve-new) | Curve editor in Rotation & Scatter section | 🟡 Medium |
| [Brush Blend Mode](#9c-brush-blend-mode-new) | Dropdown in Blending & Flow section | 🔴 Highest |

Plus a [Brush Pack Import](#5-brush-pack-import) flow and updates to the [Preset Picker](#6-preset-picker-updates).

---

## 1. Dual Brush (Texture)

**What it does**: Multiplies a second grayscale texture with the brush tip on every dab. This is the #1 feature that turns flat digital brushes into organic, textured strokes (think True Grit, Kyle Webster).

### API

```ts
shapeManager.setBrushDualBrush(presetId: string, settings: DualBrushSettings)
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Enable** | Toggle | on/off | off | `"Overlay a second texture on each brush dab to add grain, grit, or organic variation."` |
| **Texture** | Image picker / thumbnail | — | empty | `"The grayscale image that modulates the brush tip. White = full paint, black = no paint. Use scanned paper, concrete, or fabric textures for realistic results."` |
| **Tile Mode** | Segmented toggle | `dab-local` / `canvas-tiling` | `dab-local` | `"Dab-Local: texture moves with each dab (organic). Canvas-Tiling: texture stays fixed to the canvas (consistent grain across the stroke)."` |
| **Scale** | Slider | 0.1 – 5.0 | 1.0 | `"How large the texture appears relative to the brush tip. Smaller values = finer grain, larger = chunkier texture."` |
| **Blend Op** | Dropdown | Multiply / Subtract / Minimum | Multiply | `"How the texture combines with the tip shape. Multiply: dark areas cut away. Subtract: inverted cut. Minimum: keeps whichever is darker."` |
| **Strength** | Slider | 0 – 1 | 0.7 | `"How much the texture affects the brush. 0 = no texture visible, 1 = full texture (gritty)."` |
| **Random Rotation** | Toggle | on/off | on | `"Randomly rotate the texture on each dab. Creates organic variation — disable for uniform patterned effects."` |

### Data Shape

```ts
interface DualBrushSettings {
  enabled: boolean;
  textureData: string;       // base64 grayscale PNG
  textureSize: number;       // e.g. 256 or 512
  tileMode: 'dab-local' | 'canvas-tiling';
  scale: number;
  blendOp: 'multiply' | 'subtract' | 'minimum';
  strength: number;
  randomRotation: boolean;
}
```

### UX Notes
- The **Texture** picker should show a small grayscale thumbnail preview.
- Consider a "built-in textures" gallery (concrete, paper fiber, fabric, noise) so users don't need to upload their own immediately.
- When `enabled` is toggled off, grey out / collapse all other controls.
- A canvas preview stroke that updates live as the user changes settings would be very powerful here.

---

## 2. Color Jitter

**What it does**: Randomly varies the hue, saturation, brightness, and opacity of each individual brush dab. This is what makes watercolor and gouache look alive instead of dead-flat.

### API

```ts
shapeManager.setBrushColorJitter(presetId: string, jitter: ColorJitter)
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Hue Jitter** | Slider | 0 – 180 (degrees) | 0 | `"Randomly shifts the color hue on each dab. Low values (2-5°) add subtle warmth variation. High values create rainbow scatter."` |
| **Saturation Jitter** | Slider | 0 – 1 | 0 | `"Randomly shifts color intensity on each dab. Adds natural inconsistency — real paint isn't perfectly uniform."` |
| **Brightness Jitter** | Slider | 0 – 1 | 0 | `"Randomly shifts lightness on each dab. Great for simulating pigment density variation in watercolor and gouache."` |
| **Opacity Jitter** | Slider | 0 – 1 | 0 | `"Randomly varies the transparency of each dab. Creates an uneven, hand-made quality."` |

### Data Shape

```ts
interface ColorJitter {
  hueJitter: number;         // ±degrees (0-180)
  saturationJitter: number;  // ±amount (0-1)
  brightnessJitter: number;  // ±amount (0-1)
  opacityJitter: number;     // ±amount (0-1)
}
```

### UX Notes
- These are all **±** values — the engine applies `(random - 0.5) × 2 × value` per dab.
- Hue Jitter is in degrees (0-180). The slider label should show "°" (e.g. "5°"). The underlying value sent to the API is the raw degree number (the engine converts to 0-1 internally).
- Consider showing a small color swatch strip preview showing what the jitter range looks like for the current brush color.
- All four can be 0 — that means no jitter at all. No "enable" toggle is needed; just set everything to 0.
- These controls should be grouped under a header like **"Color Variation"** or **"Color Dynamics"**.

---

## 3. Wet Edges

**What it does**: Darkens and concentrates pigment at the borders of each stroke, simulating how watercolor paint pools at the edges as it dries. This single effect is what sells "watercolor" more than anything.

### API

```ts
shapeManager.setBrushWetEdges(presetId: string, settings: WetEdgeSettings)
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Enable** | Toggle | on/off | off | `"Darken the edges of each stroke to simulate watercolor pigment pooling. The paint looks thinner in the middle and darker at the borders."` |
| **Edge Darkness** | Slider | 0 – 1 | 0.4 | `"How much darker the edges become. Higher = more dramatic darkening at stroke borders."` |
| **Edge Width** | Slider (integer) | 1 – 5 | 2 | `"How wide the darkened edge band is, in pixels. Higher = wider border effect."` |
| **Strength** | Slider | 0 – 1 | 0.5 | `"Overall intensity of the wet edge effect. 0 = disabled, 1 = maximum."` |

### Data Shape

```ts
interface WetEdgeSettings {
  enabled: boolean;
  edgeDarkness: number;  // 0-1
  edgeWidth: number;     // 1-5 (integer, texels)
  strength: number;      // 0-1
}
```

### UX Notes
- When `enabled` is off, collapse / grey out the sub-controls.
- Edge Width should snap to integers (it's a pixel kernel radius).
- This effect is applied **once per stroke** (at pen-up), not per-dab. The user won't see the wet edges appear until they lift the pen. Consider a tooltip or subtle indicator: `"Applied when you lift the pen."`.
- Pairs beautifully with Color Jitter — the Watercolor Wash and Concept Shader presets already use both together.

---

## 4. Stroke Texture

**What it does**: Instead of stamping individual round dabs, maps a texture strip along the entire stroke path. Creates continuous fibrous looks — charcoal, crayon, dry marker, chalk. Think of dragging a real crayon across paper: the texture is continuous, not a chain of dots.

### API

```ts
shapeManager.setBrushStrokeTexture(presetId: string, settings: StrokeTextureSettings)
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Enable** | Toggle | on/off | off | `"Render a continuous textured strip along the stroke path instead of individual dabs. Best for charcoal, crayon, and dry media brushes."` |
| **Texture** | Image picker / thumbnail | — | empty | `"A grayscale strip texture. Horizontal = across the stroke width, vertical = along the stroke length (tiles). Scan real charcoal or crayon marks for best results."` |
| **Tiling Density** | Slider | 0.1 – 5.0 | 0.5 | `"How quickly the texture repeats along the stroke. Lower = stretched, higher = tightly tiled. Adjust until the grain looks natural."` |
| **Edge Softness** | Slider | 0 – 1 | 0.2 | `"How soft the edges of the stroke are. 0 = hard cut, 1 = fully feathered. Higher values give a more natural fade-out at the stroke border."` |

### Data Shape

```ts
interface StrokeTextureSettings {
  enabled: boolean;
  textureData: string;    // base64 grayscale PNG
  textureSize: number;    // e.g. 256
  texelsPerUnit: number;  // tiling density
  edgeSoftness: number;   // 0-1
}
```

### UX Notes
- When enabled, this **replaces** dab-based rendering with strip rendering. The user will see dab-based preview while drawing (live feedback), and the final textured result appears when they lift the pen.
- The texture image should be oriented so: **horizontal** = across the stroke width, **vertical** = along the stroke length (it tiles vertically).
- This is mutually exclusive with Dual Brush in spirit (Dual Brush modulates individual dabs, Stroke Texture replaces dabs entirely). You could hide Dual Brush controls when Stroke Texture is enabled, or show a note: `"Dual Brush is bypassed when Stroke Texture is active."`.
- Good for: charcoal, crayon, chalk, dry marker, pencil lead, pastel.
- Not for: ink, watercolor, airbrush (those work better with dab stamping).

---

## 5. Brush Pack Import

Frogmarks should support importing brush packs as JSON files. The format:

```json
{
  "packId": "distressed-inking-v1",
  "packName": "Distressed Inking",
  "version": 1,
  "author": "Frogmarks",
  "textures": [
    { "id": "tip-ink-01", "type": "tip", "size": 512, "data": "<base64>" },
    { "id": "dual-grunge-01", "type": "dual", "size": 256, "data": "<base64>" }
  ],
  "presets": [ ... ]
}
```

### UI for Import

| Element | Description | Tooltip |
|---------|------------|---------|
| **Import Brush Pack** button | Opens file picker (`.json`) | `"Import a brush pack file containing presets and textures. Packs add new brushes to your library."` |
| **Pack confirmation dialog** | Shows pack name, author, number of presets, thumbnail | `"Review the brush pack before importing."` |
| **Imported packs badge** | Small badge on preset picker showing pack origin | `"This brush was imported from the [Pack Name] pack."` |

### Relevant APIs

```ts
// Import single preset:
shapeManager.importBrushPreset(json: string): string | null  // returns new ID

// Import multiple presets:
shapeManager.importBrushPresets(json: string): string[]  // returns new IDs

// Register a preset object directly:
shapeManager.registerBrushPreset(preset: BrushPreset)

// Export for sharing:
shapeManager.exportBrushPreset(presetId: string): string | null
shapeManager.exportAllBrushPresets(): string
```

---

## 6. Preset Picker Updates

The default preset library now has **11 brushes** across these categories:

| Category | Presets | New Features |
|----------|---------|-------------|
| **Pen** | Round Soft, Hard Pen, Flat Pen, Mono-Weight Liner | — |
| **Airbrush** | Airbrush | — |
| **Eraser** | Eraser | — |
| **Watercolor** | Watercolor Wash, Gouache, Concept Shader | Color Jitter, Wet Edges |
| **Pencil** | Dry Brush | Dual Brush (slot ready) |
| **Stippling** | Stippling | Scatter dynamics |

### UI Suggestions

| Element | Description | Tooltip |
|---------|------------|---------|
| **Category tabs/filter** | Let users filter by category | `"Filter brushes by type — Pen, Watercolor, Pencil, etc."` |
| **Feature badges** | Small icons on presets that use new features | `"🎨 = Color Jitter, 💧 = Wet Edges, 🧱 = Dual Texture, 📐 = Stroke Texture"` |
| **Preset thumbnail** | Auto-generated stroke preview for each preset | `"Preview of what this brush looks like."` |
| **Custom/Imported section** | Separate area for user-created & imported presets | `"Brushes you've created or imported from brush packs."` |

---

## 7. General Brush Editor Layout

Suggested order of sections in the Brush Editor panel:

```
┌─────────────────────────────────┐
│ Preset Name + Category          │
├─────────────────────────────────┤
│ ▸ Tip Shape                     │  (existing: parametric or image)
│ ▸ Size & Spacing                │  (existing)
│ ▸ Pressure Dynamics             │  (existing: size/opacity/flow curves)
│ ▸ Velocity Dynamics        [NEW]│  (section 9a below)
│ ▸ Rotation & Scatter            │  (existing + scatter pressure curve)
│ ▸ Brush Blend Mode         [NEW]│  (section 9c below)
├─────────────────────────────────┤
│ ▸ Dual Brush Texture       [NEW]│  (section 1 above)
│ ▸ Color Variation           [NEW]│  (section 2 above)
│ ▸ Wet Edges                 [NEW]│  (section 3 above)
│ ▸ Stroke Texture            [NEW]│  (section 4 above)
├─────────────────────────────────┤
│ ▸ Brush Grain (per-brush)       │  (existing)
│ ▸ Blending & Flow               │  (existing)
│ ▸ Stabilization                  │  (existing)
└─────────────────────────────────┘
```

Each `▸` section should be **collapsible**. Sections with an enable toggle (Dual Brush, Wet Edges, Stroke Texture) should show the toggle in the section header so users can quickly enable/disable without expanding.

---

## 8. Tooltip Reference (All Strings)

Copy-pasteable tooltip strings for every control, all in one place:

### Dual Brush
| Control | Tooltip |
|---------|---------|
| Enable | `"Overlay a second texture on each brush dab to add grain, grit, or organic variation."` |
| Texture | `"The grayscale image that modulates the brush tip. White = full paint, black = no paint. Use scanned paper, concrete, or fabric textures for realistic results."` |
| Tile Mode (Dab-Local) | `"Texture moves with each dab — more organic and varied."` |
| Tile Mode (Canvas-Tiling) | `"Texture stays fixed to the canvas — consistent grain across the entire stroke."` |
| Scale | `"How large the texture appears relative to the brush tip. Smaller values = finer grain, larger = chunkier texture."` |
| Blend Op (Multiply) | `"Dark areas of the texture cut away brush opacity. The most natural-looking option."` |
| Blend Op (Subtract) | `"Light areas of the texture cut away brush opacity. Inverted effect."` |
| Blend Op (Minimum) | `"Takes whichever value is darker between the tip and texture. Harsh, punchy."` |
| Strength | `"How much the texture affects the brush. 0 = no texture visible, 1 = full texture (gritty)."` |
| Random Rotation | `"Randomly rotate the texture on each dab. Creates organic variation — disable for uniform patterned effects."` |

### Color Jitter
| Control | Tooltip |
|---------|---------|
| Hue | `"Randomly shifts the color hue on each dab. Low values (2-5°) add subtle warmth variation. High values create rainbow scatter."` |
| Saturation | `"Randomly shifts color intensity on each dab. Adds natural inconsistency — real paint isn't perfectly uniform."` |
| Brightness | `"Randomly shifts lightness on each dab. Great for simulating pigment density variation in watercolor and gouache."` |
| Opacity | `"Randomly varies the transparency of each dab. Creates an uneven, hand-made quality."` |

### Wet Edges
| Control | Tooltip |
|---------|---------|
| Enable | `"Darken the edges of each stroke to simulate watercolor pigment pooling. The paint looks thinner in the middle and darker at the borders."` |
| Edge Darkness | `"How much darker the edges become. Higher = more dramatic darkening at stroke borders."` |
| Edge Width | `"How wide the darkened edge band is, in pixels. Higher = wider border effect."` |
| Strength | `"Overall intensity of the wet edge effect. 0 = disabled, 1 = maximum."` |
| _Info_ | `"Applied when you lift the pen."` |

### Stroke Texture
| Control | Tooltip |
|---------|---------|
| Enable | `"Render a continuous textured strip along the stroke path instead of individual dabs. Best for charcoal, crayon, and dry media brushes."` |
| Texture | `"A grayscale strip texture. Horizontal = across the stroke width, vertical = along the stroke length (tiles). Scan real charcoal or crayon marks for best results."` |
| Tiling Density | `"How quickly the texture repeats along the stroke. Lower = stretched, higher = tightly tiled. Adjust until the grain looks natural."` |
| Edge Softness | `"How soft the edges of the stroke are. 0 = hard cut, 1 = fully feathered. Higher values give a more natural fade-out at the stroke border."` |
| _Info_ | `"Replaces dab-based rendering. Preview appears on pen-up. Dual Brush is bypassed when this is active."` |

### Preset Picker
| Element | Tooltip |
|---------|---------|
| Category Filter | `"Filter brushes by type — Pen, Watercolor, Pencil, etc."` |
| Feature Badge 🎨 | `"This brush uses Color Jitter for natural color variation."` |
| Feature Badge 💧 | `"This brush uses Wet Edges for watercolor-style pigment pooling."` |
| Feature Badge 🧱 | `"This brush uses a Dual Texture overlay for organic grain."` |
| Feature Badge 📐 | `"This brush uses Stroke Texture for continuous fibrous media like charcoal."` |
| Import Pack | `"Import a brush pack file containing presets and textures. Packs add new brushes to your library."` |

### Velocity Dynamics
| Control | Tooltip |
|---------|---------|
| Enable | `"When enabled, pen speed affects brush size in addition to pressure."` |
| Velocity → Size Curve | `"Maps pen speed to brush size. Left = slow strokes, right = fast strokes. Drag the curve to control how movement speed affects thickness."` |

### Scatter Pressure
| Control | Tooltip |
|---------|---------|
| Scatter Pressure Curve | `"Maps pen pressure to scatter amount. Left = light pressure, right = heavy pressure. Shape the curve to control how pressure affects dab spread."` |

### Brush Blend Mode
| Control | Tooltip |
|---------|---------|
| Blend Mode | `"How the brush color combines with existing pixels."` |
| Normal | `"Standard paint — covers what's underneath based on opacity."` |
| Multiply | `"Darkens existing colors by multiplying. Painting white has no effect. Great for shadows and shading over existing art."` |
| Screen | `"Lightens existing colors. Painting black has no effect. Great for highlights and glow over dark areas."` |
| Overlay | `"Combines Multiply and Screen based on the existing pixel brightness. Darkens darks and lightens lights. Great for adding contrast and texture over existing art."` |

---

## 9a. Velocity → Size Curve (NEW)

**What it does**: Maps pen movement speed to brush size. Fast strokes can thin out (like a real nib under speed) or fatten (like a marker pushed harder). This is a core feature in CSP and Procreate — it's what makes strokes feel "alive" rather than mechanically uniform.

### Where in UI

Add a **"Velocity → Size"** curve editor inside the existing **Pressure Dynamics** section, or as a new **Velocity Dynamics** collapsible section directly below it.

### API

The curve is part of the existing `BrushDynamics` in the preset:

```ts
// Already in BrushPreset.dynamics — just wasn't wired until now
dynamics: {
  sizeVelocityCurve?: ControlPoint[];  // velocity (0-1) → size multiplier (0-1)
}
```

Set via the preset object — same pattern as the existing pressure curves:

```ts
const preset = shapeManager.getRasterBrushPreset();
preset.dynamics.sizeVelocityCurve = [
  { x: 0, y: 1 },   // slow movement → full size
  { x: 1, y: 0.3 },  // fast movement → 30% size (thins out)
];
shapeManager.setRasterBrushPreset(preset);
```

### UI Controls

| Control | Type | Default | Tooltip |
|---------|------|---------|---------|
| **Velocity → Size Curve** | Curve editor (same as pressure curves) | Linear `[{x:0,y:0},{x:1,y:1}]` or empty | `"Maps pen speed to brush size. Left = slow strokes, right = fast strokes. Drag the curve to control how movement speed affects thickness."` |
| **Enable** | Toggle (or just: curve present = enabled) | off (empty array) | `"When enabled, pen speed affects brush size in addition to pressure."` |

### Behavior Notes

- Velocity is normalized to 0–1 where 0 = stationary and 1 = ~2 texels/ms (fast pen movement).
- Velocity is exponentially smoothed (α=0.3) to prevent frame-to-frame noise.
- The velocity factor **multiplies** with the pressure-based size, not replaces it. So both pressure AND velocity affect the final diameter.
- An empty or undefined `sizeVelocityCurve` means velocity has no effect (backward compatible).

---

## 9b. Scatter Pressure Curve (NEW)

**What it does**: Controls how much scatter (random dab displacement) varies with pen pressure. Without this, scatter distance is constant regardless of how hard you press. With it, you can make light pressure scatter widely (spray effect) and hard pressure concentrate tightly (detail work), or vice versa.

### Where in UI

Add a **"Scatter Pressure"** curve editor inside the existing **Rotation & Scatter** section, below the existing Scatter Distance slider.

### API

```ts
// Already in BrushPreset.dynamics — just wasn't wired until now
dynamics: {
  scatterDistance?: number;              // existing: base scatter in brush-diameters
  scatterPressureCurve?: ControlPoint[]; // pressure (0-1) → scatter multiplier (0-1)
}
```

### UI Controls

| Control | Type | Default | Tooltip |
|---------|------|---------|---------|
| **Scatter Pressure Curve** | Curve editor | Linear `[{x:0,y:0},{x:1,y:1}]` or empty | `"Maps pen pressure to scatter amount. Left = light pressure, right = heavy pressure. Shape the curve to control how pressure affects dab spread."` |

### Behavior Notes

- The curve output **multiplies** `scatterDistance`. So if `scatterDistance = 0.5` and the curve says `0.3` at the current pressure, effective scatter = `0.15` brush-diameters.
- An empty or undefined `scatterPressureCurve` means scatter doesn't vary with pressure (backward compatible).
- This is most useful for spray/splatter brushes where you want pressure to control spread.

---

## 9c. Brush Blend Mode (NEW)

**What it does**: Changes how the brush color combines with existing pixels. Normal just paints over. Multiply darkens. Screen lightens. Overlay enhances contrast.

### Where in UI

Change the **Blending & Flow** section's existing blend mode control from a hidden/unused field to a **visible dropdown**.

### API

```ts
// Already in BrushPreset.blending — modes are now implemented in the GPU shader
blending: {
  mode: 'normal' | 'multiply' | 'screen' | 'overlay';
  opacity: number;
  flow: number;
}
```

### UI Controls

| Control | Type | Options | Default | Tooltip |
|---------|------|---------|---------|---------|
| **Blend Mode** | Dropdown | Normal / Multiply / Screen / Overlay | Normal | `"How the brush color combines with existing pixels."` |

### Option Tooltips

| Option | Tooltip |
|--------|---------|
| Normal | `"Standard paint — covers what's underneath based on opacity."` |
| Multiply | `"Darkens existing colors by multiplying. Painting white has no effect. Great for shadows and shading over existing art."` |
| Screen | `"Lightens existing colors. Painting black has no effect. Great for highlights and glow over dark areas."` |
| Overlay | `"Combines Multiply and Screen based on the existing pixel brightness. Darkens darks and lightens lights. Great for adding contrast and texture over existing art."` |

### Behavior Notes

- Blend mode applies per-dab in the GPU compute shader. The wet-stroke system still uses max-alpha accumulation within the stroke — the blend mode affects how the stroke layer composites onto the canvas.
- Eraser presets always use erase modes regardless of the blend mode setting.
- This is distinct from **layer blend modes** (which affect how entire layers composite). Brush blend mode affects how the paint goes onto a single layer.

---

## 10. Automatic Improvements (No UI Required)

These improvements are engine-level and work automatically. No Frogmarks UI changes needed, but they're documented here for awareness.

### Pressure Interpolation Between Dabs

Previously, all dabs interpolated along a stroke segment used the endpoint's pressure value. Now pressure is linearly interpolated across each dab position. This eliminates visible "steps" in size/opacity during fast pressure transitions (e.g., flicking a pen from hard to light).

### Pen Tilt Support

`PointerEvent.tiltX` and `tiltY` are now extracted from pointer events and passed through the full pipeline (stabilizer → dab interpolation → GPU). When pen tilt exceeds 5° in either axis, dab rotation follows the tilt direction automatically. This makes flat/chisel brushes and calligraphy tips respond naturally to pen angle — no settings required.

All four stabilizer methods (moving-average, predictive, catmull-rom, pull-string) smooth tilt data alongside position and pressure, preventing jittery rotation from noisy digitizer hardware.

### Tilt-Aware Preset Tips

For best results with tilt, presets should use **non-round tips** (roundness < 1.0 or image tips with asymmetric shapes). A round tip rotated by tilt still looks round. An elliptical tip with `roundness: 0.4` will visibly change width based on pen angle — like a real chisel marker.

---

## 11. Types Exported from Salsa

Frogmarks can import these from `@zaings/salsa/shape-manager`:

```ts
import ShapeManager from '@zaings/salsa/shape-manager';
import type {
  BrushPreset,
  BrushDynamics,
  BrushBlending,
  BlendMode,
  ControlPoint,
  DualBrushSettings,
  DualBrushBlendOp,
  ColorJitter,
  WetEdgeSettings,
  StrokeTextureSettings,
  DitherConfig,
  DitherAlgorithm,
} from '@zaings/salsa/shape-manager';
```

The blend op enum is also available as a static:
```ts
ShapeManager.DualBrushBlendOp
// → { Multiply: 'multiply', Subtract: 'subtract', Minimum: 'minimum' }
```
