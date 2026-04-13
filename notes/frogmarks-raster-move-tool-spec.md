# Frogmarks Integration: Raster Move/Grab Tool + Selection Handle Fixes

This document describes the Salsa-side changes made and what Frogmarks needs to do to integrate them.

---

## 1. New Tool: Raster Move / Grab

A new raster tool that translates (shifts) the **active raster layer's pixels** when the user clicks and drags anywhere on the canvas. Unlike the selection tool which requires select-all → cut → paste → drag, this directly moves the layer content.

### Salsa API

```typescript
// Enable the grab/move tool (disables drawing + selection tools automatically)
shapeManager.enableRasterMove();

// Disable the grab/move tool
shapeManager.disableRasterMove();
```

These follow the same pattern as `enableRasterDrawing()` / `enableRasterSelection()`. Only one raster tool can be active at a time — enabling one disables the others.

### Behavior

- **Click + drag**: Shifts all pixels on the active layer by the drag delta.
- **Undo**: Automatically pushes an undo snapshot at drag start, so Ctrl+Z restores the previous position.
- **Areas vacated** by the shift become transparent (cleared to `rgba(0,0,0,0)`).
- Works with the currently selected layer (same layer the paint tool would paint to).
- Uses `grabbing.cur` cursor (already in `src/assets/`).

### Suggested UI

Add a **Move/Grab** button to the raster toolbar (left sidebar in the screenshot). Recommended placement: between the Pan tool (hand icon) and the Paint tool (pen icon).

**Icon**: A four-directional arrow (↕↔) or a hand/grab icon. The existing `grabbing.cur` cursor asset can also be used for a toolbar icon reference.

**Cursor**: When the grab tool is active, set the canvas cursor to:
```css
cursor: url('/src/assets/grabbing.cur'), move;
```

**Toolbar state**: The grab tool button should be mutually exclusive with all other tool buttons (paint, eraser, selection tools, etc.). When activated, depress/highlight this button and un-highlight others.

---

## 2. Fixed: Selection Transform Handles (Scale & Rotate)

Previously, the 8 scale handles and rotation zone drawn on a raster selection (after paste or select → drag) were **purely visual** — clicking them did nothing. The selection tool's pointer handler now properly hit-tests these handles and sends scale/rotation updates to the transform engine.

### What Changed (No Frogmarks Action Required)

- **Scale handles**: Click and drag any of the 8 handles (4 corners + 4 edge midpoints) to scale the floating selection. Corner handles scale both axes; edge handles scale one axis.
- **Rotation**: Click and drag above the top-center of the selection to rotate. The rotation zone is above the top edge, roughly where a rotation handle icon would go.
- **Translate**: Clicking inside the selection bounds (but not on a handle) still translates as before.
- **Commit**: Clicking outside the selection bounds commits the transform as before.

No Frogmarks changes needed — this works automatically with the existing overlay rendering.

### Optional Frogmarks Enhancement

If you want to show **contextual cursor changes** when hovering over handles (resize arrows, rotation icon), you can subscribe to the selection info and do cursor math on hover. The Salsa API for getting current transform state:

```typescript
const info = shapeManager.rasterSelectionService?.getSelectionInfo();
// info.isTransforming — whether a floating selection is active
// info.transform — { translateX, translateY, scaleX, scaleY, rotation }
// info.bounds — { x, y, w, h } in texel coordinates
```

---

## 3. Fixed: Box-Select Ghost Behind Pasted Selection

Previously, when dragging a pasted selection with the raster selection tool active, the vector renderer's `handlePointerDown` would **also** fire and start a box-select behind the selection drag. This caused a visible ghost selection rectangle.

### What Changed (No Frogmarks Action Required)

The renderer now checks if `rasterSelectionService.isEnabled` or `rasterMoveService.isEnabled` before processing left-clicks for vector interaction (dragging shapes, box-selecting, etc.). When either raster service is active, the renderer skips its vector pointer handling entirely.

---

## 4. API Summary

### New Methods on ShapeManager

| Method | Purpose |
|--------|---------|
| `enableRasterMove()` | Activate the grab/move tool |
| `disableRasterMove()` | Deactivate the grab/move tool |

### New Service

| Service | Property | Purpose |
|---------|----------|---------|
| `RasterMoveService` | `shapeManager.rasterMoveService` | Pointer handler for the grab tool |

### Mutual Exclusion (Automatic)

| When you call... | Automatically disables... |
|------------------|--------------------------|
| `enableRasterDrawing()` | Selection, Move |
| `enableRasterSelection()` | Drawing, Move |
| `enableRasterMove()` | Drawing, Selection |

---

## 5. Files Changed

| File | Change |
|------|--------|
| `src/services/raster-move-service.ts` | **NEW** — Grab/move tool service with GPU compute offset shader |
| `src/services/raster-selection-service.ts` | Added handle hit-testing for scale + rotation on transform handles |
| `src/services/shape-manager.ts` | Added `enableRasterMove()`, `disableRasterMove()`, mutual exclusion, service wiring |
| `src/renderer/core/webgpu-renderer.ts` | Added `rasterSelectionService` + `rasterMoveService` fields; suppress vector pointer handling when raster tools are active |
