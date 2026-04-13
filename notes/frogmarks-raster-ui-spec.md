# Frogmarks Raster UI — Implementation Spec for Copilot

> **Context**: Frogmarks uses `@zaings/salsa` as its rendering engine. Salsa exposes a `ShapeManager` singleton which is the public API. The raster painting system was recently rebuilt with a proper brush engine, preset system, dynamics curves, stabilization, and layer compositor. This document tells you exactly what UI to build and which ShapeManager methods to call.

---

## 1. Current State (What Already Exists)

From the screenshot, Frogmarks currently has:
- **Left toolbar**: tool icons (select, hand/pan, pen, eraser, circle, rectangle, triangle, arrow, text, components)
- **Left panel** ("Drawing Options"): hex color input, hue strip, SV picker, "Stroke Size" with a custom px input
- **Right panel**: "Tool Options" (BG Color, Dot Color), Layers panel with search + "Background" layer
- **Bottom right**: zoom (−/+)

The current raster tool just has a color picker and a single pixel-size input. There's no brush preset selector, no dynamics controls, no stabilization, no opacity/flow sliders, no blend mode selector, no proper eraser sub-tools.

---

## 2. Target UI Layout

### 2.1 Left Toolbar — Tool Switcher

Add/modify these tool entries (top to bottom):

| Icon | Tool | On Select (call) |
|------|------|-------------------|
| ✏️ Pen | Vector pen (existing) | existing behavior |
| 🖌️ **Brush** | Raster brush | `shapeManager.enableRasterTool()` then `shapeManager.setActiveBrushPreset(currentPresetId)` |
| 🫧 **Airbrush** | Raster airbrush | `shapeManager.enableRasterTool()` then `shapeManager.setActiveBrushPreset('default_airbrush')` |
| 🧹 **Eraser** | Raster eraser | `shapeManager.enableRasterEraserTool()` or `shapeManager.enableRasterClearEraserTool()` |
| 📐 Select | Selection (existing) | existing behavior |
| 🤚 Pan | Pan (existing) | existing behavior |

When switching away from any raster tool, call `shapeManager.disableRasterTool()`.

### 2.2 Left Panel — Brush Options (replaces "Drawing Options" when a raster tool is active)

This panel should appear when the Brush, Airbrush, or Eraser tool is selected.

```
┌─────────────────────────────┐
│  🖌️ Brush Options           │
├─────────────────────────────┤
│                             │
│  ┌─ Preset Picker ────────┐│
│  │ [Round Soft] [Hard Pen] ││
│  │ [Airbrush]  [Flat Pen] ││
│  │ [Eraser]   [+ Custom]  ││
│  └─────────────────────────┘│
│                             │
│  Preset: "Round Soft"  [⚙]  │
│                             │
│  ── Color ──────────────── │
│  [#9B58B6] [hue strip]     │
│  [    SV picker grid    ]   │
│                             │
│  ── Size ───────────────── │
│  Min: [  2] px              │
│  Max: [ 64] px              │
│  [========○=========] 64    │
│                             │
│  ── Opacity & Flow ─────── │
│  Opacity: [====○====] 100%  │
│  Flow:    [======○==]  80%  │
│                             │
│  ── Stabilization ──────── │
│  Method: [Moving Avg ▾]     │
│  Level:  [====○====]  3     │
│                             │
│  ── Advanced (collapsed) ── │
│  ▶ Tip Shape                │
│  ▶ Dynamics Curves          │
│  ▶ Spacing & Scatter        │
│  ▶ Texture / Grain          │
│                             │
│  [Save Preset] [Export]     │
│  [Import Preset File]       │
└─────────────────────────────┘
```

### 2.3 Preset Picker (grid at top of panel)

A grid of small square thumbnails showing each brush preset. Clicking one activates it.

**Data source:**
```ts
const presets = shapeManager.getBrushPresets();
// returns: BrushPreset[] — each has { id, name, category, icon? }
```

**On click:**
```ts
shapeManager.setActiveBrushPreset(preset.id);
// Then update all sliders/controls to reflect the new preset's values
```

**Grouping:** Group by `preset.category` ("Pen", "Airbrush", "Eraser", etc.) with collapsible headers.

**Active indicator:** Highlight the currently active preset.
```ts
const activeId = shapeManager.getActiveBrushPresetId();
```

### 2.4 Core Controls (always visible when raster tool active)

#### Color Picker
Reuse your existing hex input + hue strip + SV picker. On change:
```ts
shapeManager.setRasterBrushColor('#9B58B6'); // hex string
```

#### Size Slider
Two numeric inputs (Min / Max) + a slider for the **maxSize**.

The preset defines `minSize` and `maxSize`. The slider should control `maxSize` (the base/maximum brush diameter). Pressure dynamics scale between min and max.

```ts
shapeManager.setRasterBrushSize(64); // sets brush radius in px (legacy)
// For the new engine, modify the preset directly:
const engine = shapeManager.getRasterPaintEngine();
const preset = engine?.getPreset(activeId);
if (preset) {
  preset.maxSize = newValue;
  preset.minSize = Math.min(preset.minSize, newValue);
  engine.registerPreset(preset); // re-register with updated values
  engine.setActivePreset(preset.id); // refresh
}
```

#### Opacity Slider (0-100%)
Controls `preset.blending.opacity` — the maximum opacity for the entire stroke.
```ts
preset.blending.opacity = sliderValue / 100; // 0-1
```

#### Flow Slider (0-100%)
Controls `preset.blending.flow` — the per-dab paint amount. Low flow = build up gradually.
```ts
preset.blending.flow = sliderValue / 100; // 0-1
```

#### Stabilization
- **Method dropdown**: `'none'` | `'moving-average'` | `'predictive'`
- **Level slider**: 0-10 (only visible when method ≠ 'none')

```ts
preset.stabilization.method = selectedMethod;
preset.stabilization.level = sliderValue;
```

### 2.5 Advanced Section (collapsible sub-panels)

#### ▶ Tip Shape
| Control | Field | UI |
|---------|-------|----|
| Hardness | `tip.hardness` (0-1) | Slider. 0 = soft edge, 1 = hard circle |
| Roundness | `tip.roundness` (0-1) | Slider. 1 = circle, lower = flatter ellipse |
| Angle | `tip.angle` (radians) | Rotation knob or slider 0-360° |
| Image Tip | `tip.type: 'image'` | File picker for grayscale PNG. Convert to base64 and set `tip.imageData` |

Show a small **preview circle** that updates live as sliders change — render an ellipse with the current hardness/roundness/angle.

#### ▶ Dynamics Curves
For each curve, show a small interactive **curve editor** (a ~150×100px box with draggable control points on a 0-1 grid):

| Curve | Field | Description for tooltip |
|-------|-------|------------------------|
| Size | `dynamics.sizePressureCurve` | "How pen pressure affects brush size" |
| Opacity | `dynamics.opacityPressureCurve` | "How pen pressure affects dab opacity" |
| Flow | `dynamics.flowPressureCurve` | "How pen pressure affects paint flow" |

Each curve is an array of `{ x: number, y: number }` (0-1 on both axes). The UI should:
1. Plot the points and draw lines between them
2. Allow clicking to add a point
3. Allow dragging to move points
4. Allow right-click to delete a point (keep at least 2)
5. Show "Linear" and "Constant" quick-preset buttons

```ts
// After user edits a curve:
preset.dynamics.sizePressureCurve = updatedPoints;
engine.registerPreset(preset);
engine.setActivePreset(preset.id);
```

#### ▶ Spacing & Scatter
| Control | Field | UI |
|---------|-------|----|
| Spacing | `spacing` (0.01-2.0) | Slider. Low = smooth stroke, high = visible dabs |
| Scatter Distance | `dynamics.scatterDistance` (0-2) | Slider. 0 = no scatter |
| Size Jitter | `dynamics.sizeRandomJitter` (0-1) | Slider |
| Rotation Jitter | `dynamics.rotationRandomJitter` (0-π) | Slider labeled 0-180° |

#### ▶ Texture / Grain
| Control | Field | UI |
|---------|-------|----|
| Enable | presence of `texture` object | Checkbox |
| Image | `texture.imageData` | File picker (tiling grayscale PNG) |
| Scale | `texture.scale` (0.1-5.0) | Slider |
| Strength | `texture.strength` (0-1) | Slider |
| Mode | `texture.mode` | Dropdown: "Multiply" / "Subtract" |
| Fixed to Canvas | `texture.fixedToCanvas` | Checkbox |

### 2.6 Preset Management Buttons

```
[Save Preset] — Save current settings as a new named preset
[Export]       — Export selected preset to clipboard/file
[Import]       — Import preset from clipboard/file
```

**Save Preset:**
```ts
const newPreset = { ...currentPreset, id: undefined, name: userInputName };
// The engine will generate an id
const json = JSON.stringify(newPreset);
const newId = shapeManager.importBrushPreset(json);
shapeManager.setActiveBrushPreset(newId);
```

**Export:**
```ts
const json = shapeManager.exportBrushPreset(activePresetId);
// Copy to clipboard or trigger file download as .salsabrush
navigator.clipboard.writeText(json);
```

**Import:**
```ts
// From file input or clipboard
const json = await readFileAsText(file);
const newId = shapeManager.importBrushPreset(json);
if (newId) shapeManager.setActiveBrushPreset(newId);
```

**Bulk export/import (for preset packs):**
```ts
const allJson = shapeManager.exportAllBrushPresets(); // JSON array
const newIds = shapeManager.importBrushPresets(jsonArrayString);
```

---

## 3. Right Panel — Raster Layers

### 3.1 Layer List

Replace the current simple "Background" layer with a proper layer panel:

```
┌─────────────────────────────┐
│  Layers                     │
├─────────────────────────────┤
│  [Search layers...]         │
│                             │
│  👁️ 🔒  Layer 2          ▣ │
│  👁️ 🔓  Layer 1          ▣ │
│  👁️ 🔓  Background       ▣ │
│                             │
│  [+ Add] [🗑 Delete]       │
│  [⬆ Up]  [⬇ Down]          │
└─────────────────────────────┘
```

Each layer row shows:
- **Eye icon** (👁️): toggle visibility — `shapeManager.setRasterLayerVisibility(id, visible)`
- **Lock icon** (🔒/🔓): toggle lock (prevents drawing on this layer)
- **Layer name**: editable
- **Thumbnail**: small preview of the layer content

**Data source:**
```ts
const layers = shapeManager.getRasterLayers();
// returns: { id: string, name: string, visible: boolean, locked: boolean }[]
```

**Add layer:**
```ts
const newLayer = shapeManager.addRasterLayer('Layer ' + (layers.length + 1));
```

**Delete layer:**
```ts
shapeManager.deleteRasterLayer(selectedLayerId);
```

**Select layer (for drawing):**
```ts
shapeManager.selectRasterLayer(layerId);
```

### 3.2 Layer Blend Mode (Phase 2 — show dropdown but it's not wired yet)

Show a blend mode dropdown per layer. Values: Normal, Multiply, Screen, Overlay, etc. This is a placeholder for Phase 2 of the raster compositor. For now, all layers use Normal blending.

---

## 4. Keyboard Shortcuts

| Shortcut | Action | Call |
|----------|--------|------|
| `B` | Switch to Brush tool | `enableRasterTool()` + `setActiveBrushPreset('default_round_soft')` |
| `E` | Switch to Eraser | `enableRasterEraserTool()` |
| `[` | Decrease brush size | Decrement maxSize by 5 |
| `]` | Increase brush size | Increment maxSize by 5 |
| `Ctrl+Z` | Undo | `shapeManager.rasterUndo()` |
| `Ctrl+Shift+Z` | Redo | `shapeManager.rasterRedo()` |
| `1-5` | Quick-select first 5 presets | `setActiveBrushPreset(presets[n].id)` |

---

## 5. Eraser Sub-Tool Panel

When the Eraser tool is selected, show a simplified panel:

```
┌─────────────────────────────┐
│  🧹 Eraser Options          │
├─────────────────────────────┤
│  Mode: (●) Soft  (○) Hard   │
│                             │
│  Size: [========○===] 40 px │
│                             │
│  ── Eraser Style ────────── │
│  (●) Fade    — gradual      │
│  (○) Clear   — hard cutout  │
└─────────────────────────────┘
```

**Mode mapping:**
- "Soft" + "Fade" → `shapeManager.enableRasterEraserTool()` (mode=1, smooth falloff)
- "Soft" + "Clear" → `shapeManager.enableRasterClearEraserTool()` (mode=2, hard alpha cut)
- "Hard" toggle → sets `eraserHard = true` on the drawing service (mode=3, cubic falloff)

---

## 6. Brush Preview (cursor)

Replace the default cursor with a circle outline showing the current brush size at the current zoom level. This gives artists instant feedback about their brush footprint.

```ts
// On pointermove (when raster tool active):
const diameter = currentPreset.maxSize * currentZoomLevel;
// Draw a circle of that diameter centered on the cursor
// Use CSS: cursor: none; + overlay canvas with a circle
```

---

## 7. BrushPreset Type Reference (for TypeScript)

```ts
interface BrushPreset {
  id: string;
  name: string;
  category: string;        // "Pen" | "Pencil" | "Airbrush" | "Watercolor" | "Eraser"
  icon?: string;           // base64 thumbnail

  tip: {
    type: 'parametric';
    hardness: number;      // 0-1
    roundness: number;     // 0-1
    angle: number;         // radians
  } | {
    type: 'image';
    imageData: string;     // base64 grayscale PNG
    imageSize: number;     // px
  };

  spacing: number;         // 0.01-2.0

  dynamics: {
    sizePressureCurve: { x: number; y: number }[];
    opacityPressureCurve: { x: number; y: number }[];
    flowPressureCurve: { x: number; y: number }[];
    rotationPressureCurve?: { x: number; y: number }[];
    scatterPressureCurve?: { x: number; y: number }[];
    sizeVelocityCurve?: { x: number; y: number }[];
    sizeRandomJitter?: number;
    rotationRandomJitter?: number;
    scatterDistance?: number;
  };

  texture?: {
    imageData: string;
    scale: number;
    strength: number;
    mode: 'multiply' | 'subtract';
    fixedToCanvas: boolean;
  };

  blending: {
    mode: 'normal' | 'multiply' | 'screen' | 'overlay';
    opacity: number;       // 0-1
    flow: number;          // 0-1
    colorMixing?: number;  // 0-1
    colorStretch?: number; // 0-1
  };

  stabilization: {
    method: 'none' | 'moving-average' | 'predictive';
    level: number;         // 0-10
  };

  antiAliasing: boolean;
  minSize: number;         // px
  maxSize: number;         // px
  version: number;         // always 1 for now
}
```

---

## 8. Full ShapeManager API Cheat Sheet

```ts
// ── Tool activation ──
shapeManager.enableRasterDrawing()        // enable + set render mode to raster
shapeManager.disableRasterDrawing()       // disable + set render mode to vector
shapeManager.enableRasterTool()           // enable brush without changing render mode
shapeManager.disableRasterTool()          // disable brush

// ── Basic brush config ──
shapeManager.setRasterBrushSize(64)       // px radius
shapeManager.setRasterBrushColor('#FF0000')

// ── Eraser ──
shapeManager.enableRasterEraserTool()     // soft erase
shapeManager.enableRasterClearEraserTool() // hard erase
shapeManager.disableRasterEraserTool()    // back to paint

// ── Undo/Redo ──
await shapeManager.rasterUndo()
await shapeManager.rasterRedo()
shapeManager.rasterPushSnapshot()

// ── Layers ──
shapeManager.getRasterLayers()
shapeManager.addRasterLayer('Shading')
shapeManager.deleteRasterLayer(id)
shapeManager.selectRasterLayer(id)
shapeManager.setRasterLayerVisibility(id, false)

// ── Brush Presets ──
shapeManager.getBrushPresets()
shapeManager.getBrushPreset(id)
shapeManager.setActiveBrushPreset(id)
shapeManager.getActiveBrushPresetId()
shapeManager.importBrushPreset(jsonString)       // returns new id
shapeManager.exportBrushPreset(id)               // returns JSON string
shapeManager.importBrushPresets(jsonArrayString)  // returns id[]
shapeManager.exportAllBrushPresets()              // returns JSON array string
shapeManager.registerBrushPreset(presetObj)
shapeManager.deleteBrushPreset(id)

// ── Events ──
shapeManager.onRasterStrokeStart(listener)
shapeManager.onRasterStrokeUpdate(listener)
shapeManager.onRasterStrokeEnd(listener)

// ── Advanced ──
shapeManager.getRasterPaintEngine()  // direct access to engine for preset mutation
shapeManager.getRasterTextureSize()  // { w, h } | null
```

---

## 9. Implementation Priority

1. **Preset picker grid** + basic controls (size, opacity, flow) — this is the highest-impact change
2. **Stabilization controls** — dropdown + slider, very quick to implement
3. **Layer panel** with add/delete/visibility — reuses existing layer UI pattern
4. **Brush cursor preview** — circle overlay following the pointer
5. **Advanced collapsibles** (tip shape, dynamics curves, spacing, texture)
6. **Curve editor widget** — this is the most complex UI component; can defer to last
7. **Import/Export buttons** for preset sharing

---

## 10. File Format for Preset Sharing

Preset files use `.salsabrush` extension. Contents are plain JSON (the `BrushPreset` object). Preset packs use `.salsabrushpack` extension — a JSON array of `BrushPreset` objects.

```
my-awesome-ink.salsabrush     → { "id": "...", "name": "Awesome Ink", ... }
manga-pack.salsabrushpack     → [{ ... }, { ... }, { ... }]
```

Both are imported/exported via the `importBrushPreset` / `exportBrushPreset` methods on ShapeManager.
