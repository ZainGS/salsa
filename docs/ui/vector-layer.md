# Vector Layer — UI Integration Guide

This document is for the Frogmarks UI. All backend work is complete. This guide covers every API call the UI needs to make and what the user-facing behaviour should be.

---

## Concepts

A **Vector Layer** (`type: 'vector'` in the layer stack) is a non-paintable marker layer that owns:

- **Scene graph shapes** — rectangles, ellipses, speech balloons, etc. drawn via WebGPU every frame
- **Ephemera placements** — non-destructive SVG elements (barcodes, crosshairs, globes, etc.) drawn on a 2D canvas overlay every frame

Neither type is ever composited into the raster stack. They always render on top.

Every new document is created with one default vector layer named `'Vector'`. Old projects with `type: 'ephemera'` layer entries are automatically restored as vector layers.

---

## Layer Panel

### Show vector layers

`getLayers()` already returns vector layers alongside raster layers. Filter by `type`:

```typescript
const layers = shapeManager.getRasterLayers(); // returns all layer metadata
const vectorLayers  = layers.filter(l => l.type === 'vector');
const rasterLayers  = layers.filter(l => l.type === 'layer' || l.type === 'reference');
```

Vector layers should appear at the top of the panel (or pinned above raster layers), since they always render above everything.

### Add a new vector layer

```typescript
const id = shapeManager.addVectorLayer('Vector'); // returns the new layer ID
```

### Remove a vector layer

```typescript
shapeManager.removeVectorLayer(layerId); // also clears all ephemera placements on it
```

### Toggle visibility

```typescript
shapeManager.setVectorLayerVisible(layerId, visible);
// When hidden: GPU shapes on this layer disappear AND the overlay canvas hides them.
// Also persists the visible flag on the layer entry returned by getVectorLayers().
```

The overlay canvas already checks layer visibility before drawing placements — no extra call needed.

### Select the vector layer

When the user clicks the vector layer entry in the panel:

```typescript
// 1. Set it as the active vector layer so newly created shapes are stamped to it
shapeManager.setActiveVectorLayer(layerId);

// 2. Activate vector + ephemera tools in the toolbar
// (your UI logic — show shape tools AND ephemera panel)
```

When a raster layer is selected, clear the active vector layer:

```typescript
shapeManager.setActiveVectorLayer(null as any); // or track separately
```

### Multiple vector layers

Multiple vector layers are fully supported. Each layer independently shows or hides its nodes. The layer panel can list all vector layers and allow the user to toggle each one:

```typescript
// Create a second vector layer
const id2 = shapeManager.addVectorLayer('Annotations');

// Toggle visibility of each independently
shapeManager.setVectorLayerVisible(id1, true);
shapeManager.setVectorLayerVisible(id2, false);

// Read all vector layers for panel rendering
const vectorLayers = shapeManager.getVectorLayers();
// [{ id, name, visible }, ...]
```

All visible vector layers render in the same GPU pass (no interleaving between raster layers — see spec for the deferred Phase D optional item). Reordering entries in the panel is purely UI — it has no effect on render order.

---

## Ephemera Panel

The ephemera panel is activated when the active layer is a vector layer. It uses the existing `EphemeraService` API via ShapeManager.

### Browse generators

```typescript
const categories = shapeManager.getEphemeraCategories();
// [{ id: 'barcode-1d', displayName: 'Barcodes (1D)' }, ...]

const generators = shapeManager.getEphemeraGeneratorsByCategory('barcode-1d');
// [{ typeId, displayName, description, getDefaultParams(), getParamSchema() }, ...]
```

### Live preview

```typescript
const params = shapeManager.getEphemeraDefaultParams(typeId); // start from defaults
const svgString = shapeManager.generateEphemera(typeId, params); // update on param change
// Render svgString in an <img> or inline <svg> for the preview panel
```

### Place an ephemera on the canvas

Call `getDefaultPlacementSize` first to get dimensions that match the SVG's natural pixel size at the current zoom — otherwise the placement will appear stretched if you use arbitrary W/H values:

```typescript
const { width, height } = shapeManager.getDefaultPlacementSize(typeId);

const placement = shapeManager.addEphemeraPlacement(
    layerId,       // active vector layer ID
    typeId,        // e.g. 'barcode-code128'
    params,        // param record from the panel
    x, y,          // world-space position (top-left corner)
    width, height, // world-space size (use getDefaultPlacementSize for natural proportions)
    rotation,      // degrees (default 0)
    opacity,       // 0–1 (default 1)
);
// The overlay canvas shows the placement immediately on the next frame.
```

### Update params of an existing placement

```typescript
shapeManager.updateEphemeraPlacement(layerId, placementId, { params: newParams });
// SVG is regenerated and the overlay redraws automatically.
```

### Move / resize a placement programmatically

```typescript
shapeManager.updateEphemeraPlacement(layerId, placementId, {
    x, y,
    width, height,
    rotation,
    opacity,
});
```

Drag-to-move on the canvas is already wired — the user can click and drag placements directly.

### Delete a placement

```typescript
shapeManager.deleteEphemeraPlacement(layerId, placementId);
```

### Get the currently selected placement (for showing UI handles)

```typescript
const sel = shapeManager.getSelectedPlacement();
// { layerId, placementId } or null

if (sel) {
    const placements = shapeManager.getEphemeraPlacementsForLayer(sel.layerId);
    const p = placements.find(x => x.id === sel.placementId);
    // Show transform handles at p.x, p.y, p.width, p.height, p.rotation
}
```

### Rasterize to a raster layer

```typescript
// Burn all visible placements on a vector layer into a raster layer (one undo snapshot)
await shapeManager.rasterizeEphemeraLayer(vectorLayerId, targetRasterLayerId);
// targetRasterLayerId is optional — defaults to the currently selected raster layer
```

---

## Overlay Canvas

The overlay canvas is created and managed automatically in `main.ts`. The UI does not need to create it. It:

- Is `position: fixed` over the WebGPU canvas
- Has `pointer-events: none` — all clicks fall through to the WebGPU canvas
- Stays in sync with the WebGPU canvas size and position via `ResizeObserver`
- Is cleared and redrawn after every GPU frame

**The UI does not need to call any rendering methods for the overlay.** It updates automatically whenever placement data changes.

---

## Placement Selection and Transform Handles

All selection UX is handled automatically by the Salsa backend — no UI implementation needed:

- **Selection highlight** — dashed cyan outline drawn on the overlay canvas every frame
- **Resize handles** — 8 white squares at corners and edge midpoints; drag to resize, pinning the opposite corner/edge
- **Rotation handle** — circle above the top-center; drag to rotate around the placement center
- **Deselect on background click** — clicking empty canvas or a scene graph shape clears the selection automatically

The UI can read `shapeManager.getSelectedPlacement()` on `onSceneGraphChanged` events if it needs to show additional metadata (e.g. display the current placement's params in a sidebar).

---

## Shape Creation with layerId

All shape creation methods (`createRectangle`, `createCircle`, `createTriangle`, `createLine`, `createArrow`, `createStickyNote`, `createSpeechBalloon`, `createLiveText`, `createPanelLayout`, and the interactive preview path) automatically stamp `layerId` from the active vector layer onto every new node. No extra call needed from the UI — just ensure `setActiveVectorLayer(layerId)` is called when the user selects a vector layer.

---

## API Reference Summary

| Method | Where | Purpose |
|---|---|---|
| `addVectorLayer(name?)` | ShapeManager | Create vector layer, returns ID |
| `removeVectorLayer(id)` | ShapeManager | Delete layer + all its placements |
| `getVectorLayers()` | ShapeManager | List all vector layers with `{ id, name, visible }` |
| `setVectorLayerVisible(id, visible)` | ShapeManager | Show/hide layer nodes + persists flag |
| `setActiveVectorLayer(id)` | ShapeManager | Track which layer new shapes go to |
| `getActiveVectorLayerId()` | ShapeManager | Read active layer for stamping |
| `setEphemeraOverlayCanvas(canvas)` | ShapeManager | Attach/detach overlay canvas |
| `addEphemeraPlacement(...)` | ShapeManager | Place SVG element on canvas |
| `updateEphemeraPlacement(...)` | ShapeManager | Move, resize, reparametrize |
| `deleteEphemeraPlacement(...)` | ShapeManager | Remove placement |
| `getEphemeraPlacementsForLayer(id)` | ShapeManager | Read placements for a layer |
| `hitTestEphemeraPlacement(wx, wy)` | ShapeManager | Manual hit-test if needed |
| `selectPlacement(layerId, id)` | ShapeManager | Set selection state |
| `clearPlacementSelection()` | ShapeManager | Clear selection state |
| `getSelectedPlacement()` | ShapeManager | Read current selection for handles |
| `movePlacementTo(layerId, id, x, y)` | ShapeManager | Move (called by drag handler) |
| `rasterizeEphemeraLayer(id, target?)` | ShapeManager | Flatten placements to pixels |
| `getEphemeraCategories()` | ShapeManager | Generator categories for panel |
| `getEphemeraGeneratorsByCategory(id)` | ShapeManager | Generators for a category |
| `generateEphemera(typeId, params)` | ShapeManager | SVG string for live preview |
| `getEphemeraDefaultParams(typeId)` | ShapeManager | Starting params for a generator |
| `getDefaultPlacementSize(typeId)` | ShapeManager | Natural world-space `{width, height}` for "Place on Canvas" default — avoids stretching |
