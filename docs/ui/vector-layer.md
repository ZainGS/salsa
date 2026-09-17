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
// Set it as the active vector layer. This does TWO things:
//  1. Newly created shapes are stamped with this layerId.
//  2. POINTER INTERACTIVITY is gated to this layer (see below) — only this layer's shapes
//     and ephemera are clickable/draggable/marquee-selectable; everything else is inert.
shapeManager.setActiveVectorLayer(layerId);

// Then activate vector + ephemera tools in the toolbar
// (your UI logic — show shape tools AND ephemera panel)
```

When a raster or 3D layer is selected, clear the active vector layer so vector content stops
intercepting clicks (they fall through to raster paint / 3D orbit):

```typescript
shapeManager.setActiveVectorLayer(null); // signature is (id: string | null)
```

### Pointer interactivity is gated to the active vector layer

As of the interactivity pass, a vector shape **or** ephemera placement is only hit-testable
(click-select, drag, resize, marquee, hover) when its `layerId` matches the active vector layer:

- **No vector layer active** (`null`, i.e. a raster/3D layer is selected) → all layer-tagged
  vector content is inert; clicks pass straight through to the canvas beneath.
- **A vector layer active** → only that layer's shapes/placements respond; other vector layers
  are inert.
- Shapes with no `layerId` (unassigned) are always interactive.
- Switching the active layer **auto-deselects** anything (shape or placement) that just went inert,
  so no stale selection ring/handles linger.

This is **interactivity only** — inert shapes still render exactly as they would in the final
artwork (no dimming, no hover glow). The layer panel is the only way to switch the active layer.

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

Drag-to-move on the canvas is already wired — the user can click and drag placements directly
(but only while the placement's layer is the active vector layer — see the interactivity-gating
note under "Select the vector layer").

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
- **Deselect on layer switch** — selecting a different (or no) vector layer auto-clears a placement selection that just became inert (its handles disappear)
- **Only the active layer's placements are interactive** — placements on other vector layers (or any placement when a raster/3D layer is active) don't hit-test; clicks fall through

The UI can read `shapeManager.getSelectedPlacement()` on `onSceneGraphChanged` events if it needs to show additional metadata (e.g. display the current placement's params in a sidebar).

---

## Shape Creation with layerId

**Every** 2D creation path stamps `layerId` from the active vector layer (falling back to the document's default vector layer): the ShapeManager creators, **all `sm.drawing.*` methods, every drag-to-draw tool service** (scribble, line, highlight, polygon, pattern, stamp, text, section), and the interactive preview path. No extra call needed from the UI — just ensure `setActiveVectorLayer(layerId)` is called when the user selects a vector layer.

> ⚠️ Fixed 2026-09-09: previously ONLY the ShapeManager creators stamped — anything drawn through `sm.drawing.*` or the tool services landed **unassigned** (never hid with its layer, was clickable from every layer, and re-homed to the *default* layer on reload). Stamping now happens once at the `ShapeFactory` choke point, so every path is covered uniformly. Shapes drawn before this fix are unassigned until a save/reload backfills them to the default vector layer.

---

## API Reference Summary

| Method | Where | Purpose |
|---|---|---|
| `addVectorLayer(name?)` | ShapeManager | Create vector layer, returns ID |
| `removeVectorLayer(id)` | ShapeManager | Delete layer + all its placements |
| `getVectorLayers()` | ShapeManager | List all vector layers with `{ id, name, visible }` |
| `setVectorLayerVisible(id, visible)` | ShapeManager | Show/hide layer nodes + persists flag |
| `setActiveVectorLayer(id: string \| null)` | ShapeManager | Set the layer new shapes stamp to **AND** gate pointer interactivity to it (null = all vector content inert); auto-deselects newly-inert items |
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

---

## Vector-shape Outliner + Delete key (2026-09-09)

The engine now supports a per-layer **vector shape outliner** (like the 3D Scene one) and owns the **Delete key**:

| API | What it does |
|---|---|
| `sm.getVectorShapes(layerId?)` → `[{ id, name, type, layerId?, visible, parentId? }]` | List all 2D shapes (recursive — shapes inside 2D groups carry `parentId` for an indented tree). Pass the active vector layer's id to scope the outliner to it; shapes with **no** `layerId` are legacy/unassigned and appear in every layer's list (mirrors the hit-test gate). |
| `sm.selectNodesByIds(ids, additive?)` | Outliner row click → select on canvas (replaces selection; `additive: true` for shift-click). 3D ids are ignored. |
| `sm.deselectNode(id)` / `sm.clearSelectedNodes()` | The other half of row-click behavior. |
| `sm.onShapeSelectionChanged(cb)` | Canvas selection → highlight the outliner rows (same subscription the UI panel uses). |
| **Delete / Backspace** | Now handled **engine-side** (like `g`/`u` group shortcuts): deletes the selected 2D shapes via `deleteSelectedShapes()` (proper GPU-cache dealloc + package routing). Guards: ignored while typing in an input/textarea, while a single text shape (Sticky Note / SDFText / Speech Balloon) is selected, and while a creator/Player mode owns input (`suppressBoxSelect`). 3D mesh selection is a separate system and is untouched. **Remove any host-side Delete→`deleteSelectedShapes` binding for canvas shapes to avoid double-handling** (the 3D outliner's per-row ✕ is separate and unaffected). |

**Suggested panel:** under a vector layer's row (mirroring the 3D Scene panel): `getVectorShapes(activeLayerId)` → rows with eye toggle (`shape.visible` — re-render via your normal change path), name, type icon; row click → `selectNodesByIds([id])`; refresh on `onUIEvent`/scene-graph-changed and after deletes.

**Layer-row exclusivity (the "both look selected" issue):** engine state is consistent — `setActiveVectorLayer(null)` when the 3D Scene layer is chosen makes vector content inert and auto-drops stale selections. The *highlight* on the layer rows is host UI state: treat "active layer" as one radio group across vector layers AND the 3D Scene row.

**Freeform polygon tool fixed + browser-verified (2026-09-10):** the tool's construction overlay (rubber-band edge, committed edges, blue vertex markers, green close-target on the first vertex) now actually renders while drawing, and the committed polygon lands exactly on the clicked points — verified end-to-end in a driven browser session. Three stacked engine bugs: a renderer staging-buffer limitation drew every overlay line as a copy of the last one; **every factory-created `Line` was silently viewport-culled** (a constructor-order bug left its transform matrix NaN, so its bounding box failed every overlap test — fixing this also revives committed lines/arrows from the line tool); and **`Polygon` baked its point-bounds size into its transform** while uploading real-size geometry, so a freeform commit rendered scaled + displaced from the drawn outline (only unit-sized presets looked right). Polygon hit-testing and its selection bbox were subtly wrong for the same reason and are fixed too. Also: `getVectorShapes` no longer lists transient scaffolding (`isStaging`/`isPreview` nodes are skipped), so the outliner won't flood with `Line` rows mid-draw. Flow reminder: click to place points, click the green first-vertex marker / double-click / Enter to close (min 3 points), Escape or right-click to cancel. A self-intersecting click order still triangulates ugly (ear-clipping) — now that points are visible, users can see what they're outlining.

**Curves — pen gesture SHIPPED (P0, 2026-09-10, harness-verified):** the polygon tool now has the standard pen gesture — **click = sharp corner, click-and-DRAG = pull out mirrored Bézier handles** for a smooth point (a light-blue handle bar shows through the anchor while dragging; adjacent edges curve live in the preview; the auto-close path back to the first vertex renders as a thin DASHED ghost so it never reads as a committed edge). Commit flattens curves adaptively (~0.35 px tolerance) into a normal Polygon — **zero new APIs for Frogmarks**; just update the tool's tooltip: "Click to place points; click-drag to curve. Double-click or press Enter to close." **P1 shipped (2026-09-10):** the tool now commits a true **`Path` shape** — anchors + handles persist in the document (save/reload keeps them), ready for the upcoming node editor. Frogmarks impact: the outliner lists these as type `"Path"` (was `"Polygon"`); selection/move/delete behave identically. `PathNode`/`PathAnchor` are exported from `@zaings/salsa`. Full roadmap: `docs/specs/vector-paths.md`.

**Path NODE EDITOR shipped (P2, 2026-09-10, harness-verified):** committed `Path` shapes can be re-edited anchor-by-anchor. Engine API (all on `sm`):

**Entry is engine-owned:** double-clicking a committed Path on the canvas enters the editor automatically — no host wiring needed. It respects the vector-layer interactivity gate (the Path's layer must be the ACTIVE vector layer, same as click-select) and stays out of the way while the pen tool or another creator owns input. The API below is for *programmatic* entry (e.g. an "Edit path" button on an outliner row) and for the inspector:

| API | Use |
| --- | --- |
| `sm.enterPathEdit(shapeId): boolean` | Programmatic entry (returns false for non-Path ids) — e.g. an "Edit path" context item on the outliner row when the selected shape's type is `"Path"`. Canvas double-click already works without this. |
| `sm.exitPathEdit()` | Leave edit mode (engine also exits on Escape or a click away from the path). |
| `sm.isPathEditActive` | Gate other host tools/shortcuts while editing (box-select is already suppressed engine-side). |
| `sm.getPathEditTarget(): PathNode \| null` | The path being edited — read `anchors`/`closed` for an anchor-properties panel. |
| `sm.onPathEdited(cb)` | Fires on enter (with the path), after EVERY anchor mutation, and on exit (with `null`) — refresh the inspector off this. |

In-editor interactions (engine-handled, worth a tooltip): **click an anchor** selects it (green; its Bézier handle bars appear) · **drag an anchor** moves it · **drag a handle tip** re-aims the tangent — smooth anchors mirror the opposite handle, **Alt-drag** breaks the mirror (cusp) · **double-click a segment** inserts an anchor there without changing the curve · **Delete/Backspace** removes the selected anchor (min 3 closed / 2 open; consumed — won't fall through to shape deletion) · **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** undo/redo anchor edits (one drag = one step) · **Escape** or clicking off the path exits. The shape re-tessellates and re-renders live during drags.

**Undo note for the host:** anchor-edit undo is **session-scoped and engine-owned** — the stack lives inside one edit session (cleared on enter/exit) and the editor consumes the Ctrl+Z/Y keydown (`stopImmediatePropagation`, same as its Delete handling), so your existing Ctrl+Z routing (raster vs `undo3D`) will not double-fire while `sm.isPathEditActive`. No host changes needed; anchor edits do NOT appear on the raster or 3D undo stacks after exiting.

**SVG path import + Polygon→Path convert (P3, 2026-09-10, harness-verified):**

| API | Use |
| --- | --- |
| `sm.importSVGPath(d, opts?): PathNode[]` | Import SVG `<path d="...">` data as **editable Path shapes** — one per subpath, curves kept as true Béziers (quadratics and arcs converted; handles land on the anchors, so the node editor works immediately). `opts`: `{ x?, y? (world center — default viewport center), width? (world width to fit, aspect preserved — default 1), fillColor?, strokeColor?, strokeWidth? }`. Geometry is y-flipped (SVG y-down → world y-up) and stamped to the active vector layer. **Throws on malformed data** — wrap in try/catch for a paste-SVG UI. Suggested host surfaces: a "Paste SVG path" action in the vector toolbar, and drag-drop of `.svg` files (extract each `<path>`'s `d` attribute host-side). |
| `sm.convertPolygonToPath(shapeId): PathNode \| null` | Convert a committed Polygon (e.g. pre-2026-09-10 freeform shapes or presets) into an editable Path — same outline (corner anchors), same fill/stroke/layer/visibility/transform/z-order. The Polygon is removed. Returns `null` for non-Polygon ids. Suggested host surface: a "Make editable" context item on outliner rows of type `"Polygon"`; follow with `sm.enterPathEdit(newNode.id)` to drop straight into editing. |

`parseSVGPath(d)` / `SVGSubpath` are also exported from `@zaings/salsa` if the host wants to inspect subpaths before placing them.

**Even-odd fill (2026-09-11, harness-verified):** closed Path shapes now fill by the **even-odd rule** — a self-intersecting outline renders the way every vector tool renders it (a pentagram gets a hollow center; a crossed "bowtie" click order gets an empty waist) instead of the previous ear-clip artifacts, and rendering finally matches hit-testing (which was always even-odd). Purely an engine rendering fix — **no host changes**, and simple non-crossing shapes are pixel-identical. Update any "self-intersecting shapes triangulate ugly" caveat you surfaced in tooltips: they're correct now.

**AI authoring (2026-09-11):** the SceneAuthoringAPI (`sm.authoring`) gained `addPath({anchors, closed?, fill?, stroke?, strokeWidth?})` (per-anchor optional `out`/`in` handle offsets; `out` alone auto-mirrors into a smooth point) and `importSVG({d, x?, y?, width?, fill?, ...})` → shape ids, with matching tool schemas for the LLM tool list — AI copilots can now draw and import true curves.

## 2D object undo (P1, 2026-09-14, harness-verified)

**Moving / rotating / scaling / grouping (`g`) / ungrouping (`u`) / deleting 2D shapes is now undoable** — this closes the long-standing gap where raster strokes, path-anchor edits, and 3D transforms each had undo but the most common vector-object operations did not. One pointer gesture = one undo step (section drop-in/out and group-bounds recalcs are folded into the same step). Undone deletes re-attach the ORIGINAL node instances, so shape ids stay stable across undo/redo — outliner rows keyed by id keep working.

**Keys are engine-owned, conditionally:** the engine consumes **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** (window keydown, `stopImmediatePropagation`) **only when this 2D object stack has something to undo/redo** — otherwise the event falls through untouched, so your existing raster/`undo3D` Ctrl+Z routing keeps working with no changes. (Path-anchor edit sessions still consume their own Ctrl+Z first while `sm.isPathEditActive`, exactly as before.) If you route Ctrl+Z host-side yourself, check `sm.canUndo2DShapes` FIRST and skip your handling when it's true — the engine will already have consumed the key.

**Facade for host buttons (all on `sm`):**

| API | Use |
| --- | --- |
| `sm.undo2DShapes(): boolean` / `sm.redo2DShapes(): boolean` | Wire to Edit-menu / toolbar undo-redo buttons for the 2D canvas. |
| `sm.canUndo2DShapes` / `sm.canRedo2DShapes` | Enable/disable those buttons. |
| `sm.undoDescription2DShapes` / `sm.redoDescription2DShapes` | Tooltip text — "Move shapes", "Rotate shapes", "Scale shapes", "Group shapes", "Ungroup shapes", "Delete shapes". |

Depth cap 50 steps. **Not yet recorded (phase 2):** shape *creation* and style/color property edits — see `docs/specs/editing-loop-polish.md` P1.

**Bug fix riding along (2026-09-14):** `deleteSelectedShapes()` (the Delete/Backspace path) had regressed into a silent no-op for ordinary shapes when the package-deletion special case landed — the selection cleared but nothing was removed. Fixed; Delete works again and is now undoable. If you had a "delete does nothing" report open, this was it.

## 2D duplicate (P2, 2026-09-15, harness-verified)

**Ctrl+D duplicates the selected 2D shapes/groups** (engine-owned key, consumed only when at least one 2D shape is selected — otherwise it falls through, so a browser bookmark shortcut outside the canvas is unaffected). Copies are deep (groups bring their whole subtree), offset ~16 px at the current zoom, land on the **same layer and same parent** as their source (duplicating inside a group/section stays inside it), get **fresh ids**, end up **selected** (sources deselected), and record one **"Duplicate shapes"** undo command on the 2D object stack (Ctrl+Z removes the copies).

Host surface: `sm.duplicateSelectedShapes(): Node[]` — wire it to an Edit-menu "Duplicate" item; returns the copies (empty array when nothing eligible is selected). 3D nodes are skipped (use `duplicateMesh3D`); package nodes are skipped (they have their own creator flow). Not yet: alt-drag-to-copy.

## 2D align / distribute / flip (P4, 2026-09-15, harness-verified)

Facade methods for host toolbar buttons (no engine-owned keys yet); each records ONE undo command on the 2D object stack and returns `false` when nothing changed:

| API | Use |
| --- | --- |
| `sm.alignSelectedShapes('left'\|'centerX'\|'right'\|'top'\|'middleY'\|'bottom')` | Align 2+ selected shapes over the selection's union bounds (world space, y-up: `top` = greatest y). Undo label "Align shapes". |
| `sm.distributeSelectedShapes('x'\|'y')` | Even out the CENTERS of 3+ selected shapes along the axis; the outermost two stay put. "Distribute shapes". |
| `sm.flipSelectedShapes('horizontal'\|'vertical')` | Mirror the selection across its center axis; a single shape mirrors in place. Exact for all matrix-transformed shapes (negative scale renders + hit-tests correctly — pixel-verified); **Lines** mirror their endpoints; **Scribble/Highlight** get position mirroring only (stroke content is world-baked). "Flip shapes". |

Bounds come from the marquee's own world-AABB source (`getWorldSpaceBoundingBoxPolygon`), so rotated shapes, groups, paths, and lines all measure correctly. Bonus riding along: **line endpoint drags are now undoable** ("Edit line") — endpoints joined the undo snapshot for flip support.
