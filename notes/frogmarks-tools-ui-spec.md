# Frogmarks UI Spec — Flood Fill, Stabilizer & Cel Operations

> **For**: Frogmarks front-end team  
> **Salsa version**: Current (`npm run build` passing, 122 modules)  
> **Date**: April 2026

All features below are wired in Salsa's engine. Frogmarks needs UI to expose them.

---

## Quick Summary

Three new capabilities:

| Feature | What it is | Why it matters |
|---------|-----------|----------------|
| [Flood Fill (Paint Bucket)](#1-flood-fill--paint-bucket) | Click a region → fill it with color | The #2 most-used tool in manga after brushes. Required for flat coloring. |
| [Brush Stabilizer Settings](#2-brush-stabilizer-settings) | 5 smoothing algorithms exposed to the user | Inking quality. The difference between "art tool" and "toy." |
| [Cel Operations](#3-cel-operations-duplicate--move--swap) | Duplicate, move, swap, extend cels in the timeline | Core animation workflow — animators constantly rearrange drawings. |

---

## 1. Flood Fill / Paint Bucket

### What it does
Click on a region of the canvas → all connected pixels of a similar color get replaced with the fill color. This is how manga artists do "flat coloring" — ink the outlines on one layer, then fill enclosed regions on a layer below.

### Toolbar UI

| Control | Type | Tooltip |
|---------|------|---------|
| **Paint Bucket tool** | Toolbar button (icon: paint bucket / fill) | `"Fill a region with color. Click inside an outlined area to fill it. Adjust tolerance in the tool options to control how much color variation is allowed."` |
| **Tolerance** | Slider (0–255) | `"How much color variation to allow when determining the fill boundary. 0 = exact color match only. 32 = good for clean lineart. 64+ = for rough sketches with anti-aliased edges."` |
| **Gap Closing** | Slider (0–5) | `"Close small gaps in lineart before filling. Set to 1–2 for hand-drawn lines that don't perfectly close. Set to 0 for pixel-perfect lineart."` |
| **Contiguous** | Toggle (on/off) | `"ON: fill only the connected region you clicked (standard paint bucket). OFF: fill ALL pixels of the same color on the entire layer (like 'fill by color')."` |
| **Reference Layer** | Dropdown (layer list) | `"Use another layer's pixels to determine fill boundaries, but paint on the current layer. The manga workflow: ink on Layer A, fill on Layer B using A's outlines."` |

### Tool Options Panel Layout

```
┌─ Fill Options ─────────────────────────────┐
│ Tolerance:  ■■■■■■■■□□□□□□□□  32           │
│ Gap Close:  ■■□□□□□□□□□□□□□□  1            │
│ ☑ Contiguous                               │
│ Reference:  [None ▾] / [Layer 1 ▾]         │
└────────────────────────────────────────────┘
```

### API

```ts
// Basic flood fill — click at (x, y) in texel coordinates, fill with color
await shapeManager.floodFill(120, 80, '#FF6B9D');

// Full options
await shapeManager.floodFill(120, 80, '#FF6B9D', {
  tolerance: 32,          // 0–255
  gapClosing: 2,          // pixels to close before filling
  contiguous: true,       // connected region only
  referenceLayerId: inkLayerId,  // use ink layer's outlines
});

// Fill the entire selection with a color
await shapeManager.fillSelection('#FF6B9D');
```

### Keyboard Shortcut

| Key | Action | Tooltip |
|-----|--------|---------|
| `G` | Activate paint bucket tool | `"Switch to the paint bucket fill tool."` |
| `Alt + Backspace` | Fill selection with foreground color | `"Fill the current selection (or entire layer) with the active color."` |

### Behavior
- The fill is applied to the **active layer**.
- If a selection is active, the fill is constrained to the selected area.
- The fill respects the current layer's lock-transparency setting.
- `floodFill()` returns `true` if pixels were filled, `false` if the click was out of bounds or the region was empty (useful for UI feedback — e.g. play a sound or show "nothing to fill").
- The fill is a single undo step.

### Reference Layer Workflow (important!)

This is **the** manga coloring workflow. Explain it clearly in the UI:

1. Artist inks outlines on "Ink" layer
2. Artist creates "Color" layer below "Ink" layer
3. Artist selects "Color" layer, sets Reference to "Ink"
4. Artist clicks inside an outlined region with the paint bucket
5. The fill uses "Ink" layer's outlines as boundaries, but paints on "Color" layer

**Tooltip for Reference Layer dropdown:**
`"Choose a reference layer to determine fill boundaries. When set, the tool looks at the reference layer's outlines to find the fill region, but paints on the current layer. This lets you ink on one layer and color on another — the standard manga workflow."`

### Tolerance Guide (for the UI)

| Tolerance | Best for | Tooltip snippet |
|-----------|----------|-----------------|
| 0 | Pixel art (exact match) | `"Exact match only"` |
| 8–16 | Clean digital lineart | `"Tight — for precise digital lines"` |
| 24–48 | Standard hand-drawn ink | `"Standard — good for most lineart"` |
| 64–128 | Rough sketches, anti-aliased edges | `"Loose — fills through anti-aliasing and rough edges"` |
| 255 | Fill entire layer | `"Maximum — fills everything"` |

### Gap Closing Guide

| Value | Effect | Tooltip snippet |
|-------|--------|-----------------|
| 0 | No gap closing | `"Off — lineart must be perfectly closed"` |
| 1 | Close 1px gaps | `"Minimal — fixes tiny breaks in lines"` |
| 2 | Close 2px gaps (recommended) | `"Standard — handles most hand-drawn gaps"` |
| 3–5 | Close larger gaps | `"Aggressive — for very rough sketches. May over-fill."` |

---

## 2. Brush Stabilizer Settings

### What it does
Brush stabilization smooths raw pointer input to produce cleaner strokes. Different methods suit different drawing styles. This is what makes inking feel "professional" vs "shaky."

### Tool Options Panel Layout

When any brush is active, show stabilizer settings in the brush options:

```
┌─ Stabilizer ───────────────────────────────┐
│ Method: [Moving Avg ▾]                     │
│ Level:   ■■■■■■□□□□□□□□□□□□□□  5           │
│                                            │
│ ┌ String Length (pull-string only) ──────┐ │
│ │ ■■■■■■■■■■□□□□□□□□□□  30px            │ │
│ └───────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Method** | Dropdown | 5 options (see below) | `moving-average` | `"Choose how brush input is smoothed. Each method feels different — try them to find your preference."` |
| **Level** | Slider (int) | 0–10 | 5 | `"Smoothing strength. Higher = smoother lines but more latency (delay between your pen and the stroke). 0 = off, 3 = light, 6 = medium, 10 = maximum."` |
| **String Length** | Slider (int) | 10–60 | 30 | `"How long the virtual string is (in pixels). Longer = more control but slower response. Only used with the Pull-String method."` |

### Stabilization Methods

| Method | Value | Icon idea | Tooltip |
|--------|-------|-----------|---------|
| **None** | `'none'` | Ø | `"No smoothing. Raw tablet/mouse input goes directly to the brush. Fast but shaky. Good for rough sketching."` |
| **Moving Average** | `'moving-average'` | ≈ | `"Averages the last few input points with a weighted window. Low latency, good general-purpose smoothing. The default for most drawing."` |
| **Predictive** | `'predictive'` | ⤳ | `"Dampens jitter while tracking fast movements. The line 'catches up' to your pen. Good for quick sketching and organic shapes."` |
| **Catmull-Rom** | `'catmull-rom'` | 〰️ | `"Fits a mathematical curve through recent points. Produces the smoothest, most natural curves. Best for inking and clean lineart. Slightly more latency than Moving Average."` |
| **Pull-String** | `'pull-string'` | ⌇ | `"Simulates dragging a string — the brush only moves when the string goes taut. Produces very deliberate, controlled lines. Ideal for precise inking, technical drawing, and calligraphy. Adjust String Length to control responsiveness."` |

### API

```ts
// Set stabilization on a specific brush preset
shapeManager.setBrushStabilization('hard-pen', {
  method: 'catmull-rom',
  level: 6,
});

// Set stabilization on the currently active brush
shapeManager.setActiveStabilization({
  method: 'pull-string',
  level: 5,
  pullStringLength: 40,
});

// Read current settings
const stab = shapeManager.getActiveStabilization();
// → { method: 'catmull-rom', level: 6 }

// Read settings for a specific preset
const stab2 = shapeManager.getBrushStabilization('hard-pen');
```

### Data Shape

```ts
type StabilizationMethod = 'none' | 'moving-average' | 'predictive' | 'catmull-rom' | 'pull-string';

interface BrushStabilization {
  method: StabilizationMethod;
  level: number;                  // 0–10
  pullStringLength?: number;      // 10–60px (only for pull-string)
}
```

### UX Notes
- **Show the string length slider only when method is `'pull-string'`**. Hide it otherwise to reduce clutter.
- When the user changes the stabilizer, the change applies to the **current brush preset** and persists. Different brushes can have different stabilizer settings (e.g., airbrush = none, ink pen = catmull-rom level 7).
- Consider showing a small **preview animation** next to each method in the dropdown — a short stroke demonstrating how each smoothing method affects a wiggly input line.
- **Level 0 effectively disables stabilization** regardless of method. The UI should indicate this ("Level 0 = off").
- For the pull-string method, consider rendering a small **visual indicator** on the canvas: a faint line from the pen tip to the brush position, so the user can see the string.

### Recommended Defaults per Brush Type

| Brush type | Method | Level | Why |
|------------|--------|-------|-----|
| Soft round / airbrush | `none` | 0 | Painting doesn't need stabilization |
| General pencil / sketch | `moving-average` | 3 | Light smoothing for fast sketching |
| Hard pen / ink | `catmull-rom` | 6 | Smooth curves for clean lineart |
| Mono-weight liner | `pull-string` | 5 | Deliberate, controlled inking |
| Calligraphy | `pull-string` | 7 | Slow, precise strokes |
| Eraser | `none` | 0 | Erasing doesn't need smoothing |

---

## 3. Cel Operations (Duplicate / Move / Swap)

### What these do
These extend the animation timeline with operations animators use constantly when arranging their drawings.

### UI Controls

| Action | Trigger | API | Tooltip |
|--------|---------|-----|---------|
| **Duplicate cel** | Right-click cel → "Duplicate to frame…" or Ctrl+D | `shapeManager.duplicateCel(layerId, celId, targetFrame)` | `"Copy this drawing to another frame. Creates an independent copy you can modify — perfect for 'draw a pose, duplicate, modify slightly' animation."` |
| **Move cel** | Drag a cel to a different frame in the timeline | `shapeManager.moveCel(layerId, celId, targetFrame)` | `"Move this drawing to a different frame. The drawing stays the same, it just appears at a new time."` |
| **Swap cels** | Drag a cel onto another cel (with modifier key) | `shapeManager.swapCels(layerId, celIdA, celIdB)` | `"Exchange two drawings' positions. Useful for reordering animation poses."` |
| **Set hold duration** | Drag the right edge of a cel block in the timeline | `shapeManager.setCelDuration(layerId, celId, duration)` | `"How many frames this drawing is held for. Drag to extend or shrink. A hold of 2 means this drawing is shown for 2 frames."` |
| **Mark as key** | Right-click cel → "Set as Key" | `shapeManager.setCelType(layerId, celId, 'key')` | `"Mark this as a key drawing (◆). Key drawings are the important poses in your animation."` |
| **Mark as inbetween** | Right-click cel → "Set as Inbetween" | `shapeManager.setCelType(layerId, celId, 'inbetween')` | `"Mark this as an inbetween drawing (○). Inbetweens are transitional frames between key poses."` |
| **Get cel list** | (for building the timeline UI) | `shapeManager.getCels(layerId)` | — |

### API

```ts
// Duplicate cel to frame 5 (copies pixel data)
const newCelId = shapeManager.duplicateCel(layerId, celId, 5);

// Move cel to frame 8 (no pixel copy, just repositions)
shapeManager.moveCel(layerId, celId, 8);

// Swap two cels' positions
shapeManager.swapCels(layerId, celIdA, celIdB);

// Set hold duration (2 = drawing shows for 2 frames)
shapeManager.setCelDuration(layerId, celId, 2);

// Mark as key or inbetween
shapeManager.setCelType(layerId, celId, 'key');
shapeManager.setCelType(layerId, celId, 'inbetween');

// Get all cels for timeline rendering
const cels = shapeManager.getCels(layerId);
// → [{ id, startFrame, duration, celType }, ...]
```

### Cel Data Shape

```ts
interface CelInfo {
  id: string;
  startFrame: number;     // 1-indexed
  duration: number;       // 1 = single frame, >1 = held
  celType: 'key' | 'inbetween';
}
```

### Timeline Context Menu

When right-clicking on a cel in the timeline:

```
┌──────────────────────────────┐
│ ◆ Set as Key Drawing         │
│ ○ Set as Inbetween           │
│ ──────────────────────────── │
│ 📋 Duplicate to Frame…       │
│ ✂️ Move to Frame…             │
│ 🔄 Swap with…                │
│ ──────────────────────────── │
│ 🗑️ Delete Cel                │
└──────────────────────────────┘
```

When right-clicking on an **empty frame** in the timeline:

```
┌──────────────────────────────┐
│ ✏️ New Blank Cel              │
│ 📋 Paste Cel                  │
│ ──────────────────────────── │
│ ➕ Insert Frame               │
│ ➖ Delete Frame               │
└──────────────────────────────┘
```

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `Ctrl + D` | Duplicate cel to next frame + advance | `"Copy the current drawing to the next frame and advance to it."` |
| `Shift + F5` | Duplicate cel to current frame | `"Copy a cel to this frame."` |
| `Del` | Delete the selected cel | `"Remove the current drawing. The frame becomes blank."` |

### UX Notes
- **Duplicate + advance** is the most common animation workflow: draw a pose, press Ctrl+D to copy it to the next frame, then modify. This is how nearly all frame-by-frame animation is done.
- The **move** operation should show a **ghost preview** of the cel being dragged to its new position.
- The **swap** operation is triggered by **dragging a cel onto another cel while holding Alt/Shift**. Show a visual "swap" indicator (two arrows).
- **Hold duration** is adjusted by **dragging the right edge** of a cel block in the timeline. As the user drags, the cel block visually stretches. Show the duration number (e.g., "×3") while dragging.
- `getCels()` returns all cels sorted by startFrame. Use this to render the timeline grid.

---

## 4. Types Exported from Salsa

Frogmarks can import these from `@zaings/salsa/shape-manager`:

```ts
import ShapeManager from '@zaings/salsa/shape-manager';
import type {
  // Flood fill
  FloodFillOptions,
  // Stabilizer
  StabilizationMethod,
  BrushStabilization,
  // Animation (from previous spec)
  OnionSkinConfig,
  LoopMode,
  PlaybackState,
  TimelineState,
} from '@zaings/salsa/shape-manager';
```

---

## 5. Full Tooltip Reference

### Flood Fill
| Element | Tooltip |
|---------|---------|
| Paint bucket tool | `"Fill a region with color. Click inside an outlined area to fill it."` |
| Tolerance slider | `"Color similarity threshold. 0 = exact match, 32 = standard, 64+ = rough sketches."` |
| Gap closing slider | `"Close small gaps in lineart before filling. 0 = off, 2 = recommended."` |
| Contiguous toggle | `"ON: fill connected region only. OFF: fill all similar-color pixels on the layer."` |
| Reference layer | `"Use another layer's outlines as fill boundaries. The manga workflow: ink on one layer, fill on another."` |
| Fill selection shortcut | `"Fill the current selection (or entire layer) with the active color."` |

### Stabilizer
| Element | Tooltip |
|---------|---------|
| Method dropdown | `"Choose how brush input is smoothed."` |
| Level slider | `"Smoothing strength. 0 = off, 3 = light, 6 = medium, 10 = maximum."` |
| String length slider | `"Pull-string length in pixels. Longer = more control, slower response."` |
| None | `"No smoothing. Raw input. Good for rough sketching."` |
| Moving Average | `"Weighted average. Low latency, general-purpose."` |
| Predictive | `"Dampens jitter, tracks fast movements. Good for sketching."` |
| Catmull-Rom | `"Smoothest curves via spline fitting. Best for inking."` |
| Pull-String | `"Deliberate, controlled lines. The cursor drags a virtual string."` |

### Cel Operations
| Element | Tooltip |
|---------|---------|
| Duplicate cel | `"Copy this drawing to another frame. Creates an independent copy."` |
| Move cel | `"Move this drawing to a different frame position."` |
| Swap cels | `"Exchange two drawings' positions."` |
| Set hold duration | `"How many frames this drawing is displayed for."` |
| Mark as key | `"Key drawing — an important pose. Shown as ◆ in timeline."` |
| Mark as inbetween | `"Transitional drawing between keys. Shown as ○ in timeline."` |
| Get cels | (API only — returns cel metadata for building timeline UI) |
