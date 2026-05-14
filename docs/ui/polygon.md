# Polygon Features — Frogmarks Integration Guide
**Last Updated:** 2026-04-27  

## Overview

Salsa now supports **Polygon** as a full shape type with three creation methods, a freeform drawing tool, and preset shapes. This document describes the new API surface and what Frogmarks needs to build in the UI layer.

---

## 1. Regular Polygon (toolbar shape)

**Use case:** User picks "Pentagon", "Hexagon", "Octagon" etc. from the shape toolbar, then clicks/drags to place.

### API

```ts
// Set how many sides the next polygon will have (default: 6)
shapeManager.defaultPolygonSides = 5; // pentagon

// Use the existing preview/drag-to-create flow
shapeManager.setPreviewShape(ShapeType.Polygon, mouseEvent);
shapeManager.updatePreviewShapePosition(mouseEvent);
shapeManager.confirmPreviewShape();
```

### UI needed

- Add a **Polygon** option to the shape toolbar (alongside Rectangle, Circle, Triangle, etc.)
- Add a **side count selector** (dropdown or stepper, range 3–12 is sensible):
  - 3 = Triangle (but the dedicated Triangle is better here)
  - 5 = Pentagon
  - 6 = Hexagon (default)
  - 8 = Octagon
  - etc.
- Bind the selector to `shapeManager.defaultPolygonSides`
- The `ShapeType.Polygon` enum value already exists

---

## 2. Freeform Polygon Drawing Tool

**Use case:** User selects the freeform polygon tool, clicks around the canvas to place vertices, and closes the shape.

### API

```ts
// Enable / disable
shapeManager.enablePolygonDrawing();
shapeManager.disablePolygonDrawing();

// Check state
shapeManager.isPolygonDrawing;           // tool is active
shapeManager.isPolygonDrawingInProgress; // user has placed ≥1 vertex

// Set colors before or during drawing
shapeManager.setPolygonDrawingColors(fillColor, strokeColor, strokeWidth);
```

### Drawing interaction (handled by Salsa)

| Action | Effect |
|--------|--------|
| **Click** | Place a vertex |
| **Mouse move** | Rubber-band line from last vertex to cursor |
| **Click near first vertex** (≥3 pts) | Close and commit the polygon |
| **Double-click** (≥3 pts) | Close and commit the polygon |
| **Enter** (≥3 pts) | Close and commit the polygon |
| **Escape** | Cancel drawing, remove all staging visuals |
| **Right-click** | Cancel drawing |

### UI needed

- Add a **"Freeform Polygon"** tool button (pen/polygon icon)
- Toggle `enablePolygonDrawing()` / `disablePolygonDrawing()` on button click
- Disable other drawing tools when this is active (same pattern as line tool)
- Optionally show a hint: "Click to place points. Double-click or press Enter to close."
- Wire fill/stroke color pickers to `setPolygonDrawingColors()`

---

## 3. Preset Polygons (flowchart / callout shapes)

**Use case:** User picks from a gallery of predefined shapes like parallelogram, star, speech bubble, etc.

### API

```ts
// Create programmatically (centered at x,y with given dimensions)
shapeManager.createPresetPolygon(x, y, width, height, 'chevron', strokeColor, strokeWidth);

// Get all available preset names (for building a UI gallery)
const presets = ShapeManager.PolygonPresets;
// → ['parallelogram', 'trapezoid', 'arrowRight', 'chevron', 'star5', 'star6', 'cross', 'speechBubble']
```

### Available presets

| Preset | Description | Typical use |
|--------|-------------|-------------|
| `parallelogram` | Skewed rectangle | Flowchart: data/IO |
| `trapezoid` | Tapered top edge | Flowchart: manual operation |
| `arrowRight` | Block arrow pointing right | Flow direction |
| `chevron` | Pointed ribbon / process step | Process diagrams |
| `star5` | 5-point star ★ | Ratings, emphasis |
| `star6` | 6-point star ✡ | Badges, emphasis |
| `cross` | Plus / cross shape ✚ | Medical, add icon |
| `speechBubble` | Rectangle with tail at bottom-left | Callouts, annotations |

### UI needed

- Add a **"More Shapes"** panel or expandable section in the shape toolbar
- Display preset shapes as clickable thumbnails (render a mini preview of each)
- On click: either place at center of viewport, or enter a click-to-place mode
- The presets are extensible — new ones can be added to Salsa without UI changes if the gallery dynamically reads `ShapeManager.PolygonPresets`

---

## 4. Programmatic creation (no UI needed)

For cases where Frogmarks creates polygons from code (e.g. AI-generated diagrams):

```ts
// From arbitrary points (world-space coordinates)
shapeManager.createPolygonFromPoints(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
    strokeColor, strokeWidth
);

// Regular polygon at a position
shapeManager.createRegularPolygon(x, y, radius, sides, strokeColor, strokeWidth);
```

---

## 5. Serialization

Polygons serialize/deserialize automatically. The JSON includes:

```json
{
  "type": "Polygon",
  "points": [{ "x": 0, "y": -0.5 }, { "x": 0.43, "y": -0.15 }, ...],
  "presetTag": "star5",
  "fillColor": { "r": 1, "g": 1, "b": 1, "a": 1 },
  "strokeColor": { "r": 0, "g": 0, "b": 0, "a": 1 },
  "strokeWidth": 0.01
}
```

`presetTag` is `null` for freeform/regular polygons. No migration needed for existing boards — polygons are a new shape type.

---

## Summary of Frogmarks UI work

| Priority | Task | Effort |
|----------|------|--------|
| 🔴 High | Add Polygon to shape toolbar + side count selector | Small |
| 🔴 High | Add Freeform Polygon tool button + enable/disable wiring | Small |
| 🟡 Medium | Preset shape gallery panel | Medium |
| 🟢 Low | Color picker wiring for polygon drawing tool | Small (reuse existing) |
