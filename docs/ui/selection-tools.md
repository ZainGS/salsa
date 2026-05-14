# Frogmarks Phase 3 — Selection & Transform Tools UI Spec
**Last Updated:** 2026-04-27  

> **Prerequisites**: Phase 1 (brush presets/dynamics), Phase 2 (layer compositor/blend modes).
> This phase adds **rectangle select**, **ellipse select**, **lasso select**,
> **move/scale/rotate transform**, and **cut/copy/paste/delete** operations.

---

## 1. What Changed in Salsa

Four new engine components power the selection system:

| Component | File | Responsibility |
|-----------|------|----------------|
| `RasterSelectionMask` | `renderer/raster/selection/raster-selection-mask.ts` | GPU r8unorm texture — 255 = selected, 0 = not, feathered edges |
| `RasterSelectionEngine` | `renderer/raster/selection/raster-selection-engine.ts` | Orchestrates selection creation, cut/copy/paste, floating layer |
| `RasterTransformEngine` | `renderer/raster/selection/raster-transform-engine.ts` | GPU move/scale/rotate with bilinear sampling |
| `RasterSelectionService` | `services/raster-selection-service.ts` | Pointer event handler for selection tools (rect/ellipse/lasso drag) |

---

## 2. Selection Tools

### 2.1 Tool Modes

Three selection tools, chosen via a toolbar or keyboard shortcut:

| Tool | Icon | Description |
|------|------|-------------|
| Rectangle Select | ⬜ | Click-drag a rectangular region |
| Ellipse Select | ⭕ | Click-drag an elliptical region |
| Lasso Select | ✏️ | Freehand draw a closed polygon |

```ts
// Set the active selection tool:
rasterSelectionService.setTool('rect');    // or 'ellipse' or 'lasso'
```

### 2.2 Selection Feathering

An optional feather radius (in pixels) softens the selection edge:

```ts
rasterSelectionService.setFeather(5); // 5px soft edge
rasterSelectionService.setFeather(0); // hard edge (default)
```

**UI**: A small numeric input or slider (0–50px) next to the selection tool buttons.

---

## 3. Selection Toolbar Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Selection Tools                                             │
├──────────────────────────────────────────────────────────────┤
│  [⬜ Rect] [⭕ Ellipse] [✏️ Lasso]   Feather: [___0__] px  │
│                                                              │
│  [Select All] [Deselect] [Invert]                           │
│                                                              │
│  [✂️ Cut] [📋 Copy] [📄 Paste] [🗑️ Delete]                │
│                                                              │
│  [↕️ Transform] [✓ Commit] [✗ Cancel]                       │
└──────────────────────────────────────────────────────────────┘
```

### Button States

| Button | Enabled When | Action |
|--------|-------------|--------|
| Rect / Ellipse / Lasso | Always (in raster mode) | Switch tool, highlight active |
| Select All | Always | Select entire canvas |
| Deselect | Selection exists | Clear selection |
| Invert | Selection exists | Invert selection mask |
| Cut | Selection exists | Copy + delete selected pixels |
| Copy | Selection exists | Copy selected pixels to clipboard |
| Paste | Clipboard has content | Paste as floating selection |
| Delete | Selection exists | Clear selected pixels to transparent |
| Transform | Selection exists, not transforming | Lift selected pixels for move/scale/rotate |
| Commit (✓) | Transform in progress | Apply the transform |
| Cancel (✗) | Transform in progress | Discard, put pixels back |

---

## 4. Interaction Behavior

### 4.1 Creating a Selection (Rect / Ellipse)

1. User selects the **Rectangle** or **Ellipse** tool
2. **Click + drag** on the canvas
3. A dashed preview rectangle follows the mouse during drag
4. **On release**, the selection is finalized (marching ants appear)

The `RasterSelectionService` handles all pointer events automatically when enabled.

### 4.2 Creating a Selection (Lasso)

1. User selects the **Lasso** tool
2. **Click + drag** — freehand drawing accumulates polygon points
3. **On release**, the polygon is closed and the selection mask is generated via winding-number GPU shader

### 4.3 Moving a Selection (Transform)

1. With an active selection, **click inside** the selected area
2. This automatically lifts the pixels into a floating layer and enters transform mode
3. **Drag** to move the floating pixels
4. **Release** — pixels stay at new position (still in transform mode)
5. **Enter** or click **Commit** to apply
6. **Escape** or click **Cancel** to put pixels back

### 4.4 Clicking Outside a Selection

- If **transforming**: commits the transform, then starts a new selection
- If **not transforming**: starts a new selection (replaces old one)

---

## 5. Full API Cheat Sheet

### 5.1 Direct ShapeManager Methods (Programmatic)

All coordinates are in **texel space** (0,0 = top-left of raster texture).

```ts
// ── Selection Creation ──
shapeManager.rasterSelectRect(x, y, w, h, feather?)   // Rectangle
shapeManager.rasterSelectEllipse(x, y, w, h, feather?) // Ellipse
shapeManager.rasterSelectLasso([{x, y}, ...])           // Freeform polygon
shapeManager.rasterSelectAll()                          // Entire canvas
shapeManager.rasterDeselectAll()                        // Clear selection
shapeManager.rasterInvertSelection()                    // Invert mask

// ── Pixel Operations ──
shapeManager.rasterDeleteSelection()                    // Delete → transparent
await shapeManager.rasterCutSelection()                 // Cut (copy + delete)
await shapeManager.rasterCopySelection()                // Copy to clipboard
shapeManager.rasterPaste()                              // Paste (creates floating)

// ── Transform ──
shapeManager.rasterBeginTransform()                     // Lift pixels
shapeManager.rasterUpdateTransform(dx, dy, scaleX?, scaleY?, rotation?)
shapeManager.rasterCommitTransform()                    // Apply
shapeManager.rasterCancelTransform()                    // Discard

// ── Query ──
const info = shapeManager.getRasterSelectionInfo()
// info: {
//   hasSelection: boolean,
//   bounds: { x, y, w, h } | null,
//   isTransforming: boolean,
//   transform: { translateX, translateY, scaleX, scaleY, rotation } | null,
// }
```

### 5.2 Service Methods (Event-Driven — For Tool Modes)

The `RasterSelectionService` handles pointer events automatically:

```ts
// Enable/disable the selection tool (mutually exclusive with drawing)
rasterSelectionService.enable();
rasterSelectionService.disable();

// Set tool mode
rasterSelectionService.setTool('rect');    // 'rect' | 'ellipse' | 'lasso'
rasterSelectionService.setFeather(5);       // feather in px

// Operations (convenience wrappers)
rasterSelectionService.selectAll();
rasterSelectionService.deselectAll();
rasterSelectionService.invertSelection();
rasterSelectionService.deleteSelection();
await rasterSelectionService.cut();
await rasterSelectionService.copy();
rasterSelectionService.paste();
rasterSelectionService.beginTransform();
rasterSelectionService.commitTransform();
rasterSelectionService.cancelTransform();

// Query
const info = rasterSelectionService.getSelectionInfo();

// Event listener for UI updates
rasterSelectionService.onSelectionChanged.on((info) => {
  // Update toolbar button states, marching ants overlay, etc.
  updateSelectionUI(info);
});

// Get drag preview rect (for rendering selection preview during drag)
const preview = rasterSelectionService.getDragPreview();
// preview: { x, y, w, h } | null (only during active drag)
```

---

## 6. Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+A` | Select All | Any raster mode |
| `Ctrl+D` | Deselect All | Selection exists |
| `Ctrl+Shift+I` | Invert Selection | Selection exists |
| `Delete` / `Backspace` | Delete selected pixels | Selection exists |
| `Ctrl+X` | Cut | Selection exists |
| `Ctrl+C` | Copy | Selection exists |
| `Ctrl+V` | Paste | Clipboard has content |
| `Ctrl+T` | Begin Transform | Selection exists |
| `Enter` | Commit Transform | Transform in progress |
| `Escape` | Cancel Transform | Transform in progress |
| `M` | Rectangle Select tool | — |
| `E` | Ellipse Select tool | — |
| `L` | Lasso Select tool | — |

---

## 7. Selection Overlay Rendering

### 7.1 Marching Ants

When a selection exists (`info.hasSelection === true`), render a **marching ants** (animated dashed) outline around the selection bounds.

**Implementation options** (choose based on complexity budget):

1. **Simple**: Draw a dashed rectangle at `info.bounds` using an HTML canvas overlay or CSS border animation
2. **Medium**: Render a GPU quad with a shader that reads the selection mask edge pixels
3. **Full**: Use the r8unorm mask texture to render per-pixel marching ants with time-based dash animation

For the initial implementation, **option 1 is recommended** — just draw a dashed animated border at the bounds:

```ts
// In your render loop / overlay:
const info = shapeManager.getRasterSelectionInfo();
if (info.hasSelection && info.bounds) {
  const { x, y, w, h } = info.bounds;
  // Convert texel bounds → screen coords (using your coordinate mapper)
  drawMarchingAnts(screenX, screenY, screenW, screenH, animTime);
}
```

**CSS marching ants** (simplest):
```css
.selection-overlay {
  position: absolute;
  border: 2px dashed black;
  animation: march 0.4s linear infinite;
  pointer-events: none;
}
@keyframes march {
  to { border-dash-offset: 8px; /* or use stroke-dashoffset in SVG */ }
}
```

### 7.2 Transform Handles

When `info.isTransforming === true`, render **8 resize handles** + a **rotation handle** around the transformed bounds:

```
        ↻ (rotation handle — above center)
        |
  ◻─────◻─────◻
  │             │
  ◻      ✛     ◻   ← center move handle
  │             │
  ◻─────◻─────◻
```

| Handle | Position | Cursor | Drag Action |
|--------|----------|--------|-------------|
| Top-left | Corner | `nwse-resize` | Scale from corner |
| Top-center | Edge midpoint | `ns-resize` | Scale height |
| Top-right | Corner | `nesw-resize` | Scale from corner |
| Mid-left | Edge midpoint | `ew-resize` | Scale width |
| Mid-right | Edge midpoint | `ew-resize` | Scale width |
| Bottom-left | Corner | `nesw-resize` | Scale from corner |
| Bottom-center | Edge midpoint | `ns-resize` | Scale height |
| Bottom-right | Corner | `nwse-resize` | Scale from corner |
| Rotation | Above top-center | `grab` | Rotate (compute angle to center) |
| Interior | Anywhere inside | `move` | Translate (dx, dy) |

Handle drag → call `shapeManager.rasterUpdateTransform(dx, dy, scaleX, scaleY, rotation)`:

```ts
// Move: just dx/dy
shapeManager.rasterUpdateTransform(dx, dy);

// Scale from bottom-right handle:
const scaleX = (origWidth + deltaX) / origWidth;
const scaleY = (origHeight + deltaY) / origHeight;
shapeManager.rasterUpdateTransform(0, 0, scaleX, scaleY);

// Rotate: compute angle from center to mouse
const angle = Math.atan2(mouseY - centerY, mouseX - centerX) - initialAngle;
shapeManager.rasterUpdateTransform(0, 0, 1, 1, angle);
```

### 7.3 Floating Layer Preview

During transform, the floating pixels (the lifted content) should be rendered at their transformed position. The engine provides:

```ts
const floatingTex = selectionEngine.getFloatingTexture();  // GPU texture
const floatingBounds = selectionEngine.getFloatingBounds(); // { x, y, w, h }
const transform = info.transform; // { translateX, translateY, scaleX, scaleY, rotation }
```

Render the floating texture at `(bounds.x + transform.translateX, bounds.y + transform.translateY)` with the given scale/rotation. This can be done as a textured quad in the render pipeline.

---

## 8. Tool Mode Switching

Selection tools and drawing tools are **mutually exclusive**. When the user switches:

```ts
// Switch to selection mode:
rasterDrawingService.disable();
rasterSelectionService.enable();
rasterSelectionService.setTool('rect');

// Switch back to drawing mode:
rasterSelectionService.disable();
rasterDrawingService.enable();
```

**Important**: When switching away from selection mode while a transform is in progress, auto-commit the transform:

```ts
function switchToDrawingMode() {
  const info = rasterSelectionService.getSelectionInfo();
  if (info.isTransforming) {
    rasterSelectionService.commitTransform();
  }
  rasterSelectionService.disable();
  rasterDrawingService.enable();
}
```

---

## 9. Common Artist Workflows

### Move Part of a Drawing
1. Select **Rectangle** tool → drag around the area
2. Click **inside** the selection → pixels lift, enter transform mode
3. Drag to new position
4. Press **Enter** to commit (or **Escape** to cancel)

### Duplicate Part of a Drawing
1. Select area → **Ctrl+C** (copy)
2. **Ctrl+V** (paste) → floating copy appears at center
3. Drag to desired position → **Enter** to commit

### Delete a Region
1. Select area → press **Delete** → pixels become transparent

### Color-Fill a Selection
1. Select area (any shape — rect, ellipse, or lasso)
2. Switch to drawing mode
3. Paint inside — the mask constrains painting to the selected area
4. (Note: painting-inside-mask is a future enhancement; currently painting ignores the mask)

### Move Content Between Layers
1. On source layer: select area → **Ctrl+X** (cut)
2. Switch to destination layer
3. **Ctrl+V** (paste) → drag into position → **Enter**

---

## 10. Data Flow Summary

```
Pointer Event (canvas)
    │
    ▼
RasterSelectionService          ← handles enable/disable, tool mode
    │
    ├─ rect/ellipse drag  ────▶ RasterSelectionEngine.selectRect/Ellipse()
    │                               │
    │                               ▼
    │                          RasterSelectionMask  ← GPU compute shader writes r8unorm
    │
    ├─ lasso drag ─────────▶ RasterSelectionEngine.selectLasso()
    │                               │
    │                               ▼
    │                          RasterSelectionMask  ← winding-number GPU shader
    │
    ├─ click inside selection ─▶ RasterSelectionEngine.beginTransform()
    │                               │
    │                               ├── lifts pixels → floatingTex
    │                               ├── clears original area
    │                               └── enters transform mode
    │
    ├─ drag during transform ──▶ RasterTransformEngine.update(dx, dy, ...)
    │                               │
    │                               └── updates TransformState
    │
    ├─ commit ─────────────────▶ RasterTransformEngine.applyToTexture()
    │                               │
    │                               └── GPU stamps floating → layer at new position
    │
    └─ cut/copy/paste/delete ──▶ RasterSelectionEngine (pixel operations)

ShapeManager                    ← public API wrapper for Frogmarks
    │
    └── rasterSelectRect(), rasterCut(), rasterPaste(), etc.
```

---

## 11. Implementation Priority

1. **Rectangle Select + Delete** — simplest, immediately useful
2. **Move (transform with translate only)** — most-requested workflow
3. **Cut / Copy / Paste** — essential clipboard operations
4. **Ellipse Select** — trivial given rect already works
5. **Lasso Select** — most complex selection tool
6. **Scale / Rotate** — advanced transform handles
7. **Feathering** — soft selection edges
8. **Marching ants + transform handles rendering** — visual polish
9. **Selection mask constraining brush painting** — future enhancement

---

## 12. Notes for Frogmarks Integration

- **`getRasterSelectionInfo()`** is the single polling point for all selection state. Call it on every render frame or subscribe to `onSelectionChanged`.
- **Texel coordinates**: All selection methods use texel coordinates (0,0 = top-left of raster texture). Use the same coordinate conversion as `RasterDrawingService.toTexelCoords()` to convert screen → texel.
- **Async operations**: `rasterCutSelection()` and `rasterCopySelection()` are async (GPU readback). Await them or handle promises.
- **Tool exclusivity**: Enable either `RasterDrawingService` or `RasterSelectionService`, not both. The UI toolbar should handle this toggle.
- The selection mask is a **GPU texture** (`r8unorm`). For rendering overlays in an HTML canvas or SVG, use `info.bounds` (bounding rect) instead of reading the mask.
