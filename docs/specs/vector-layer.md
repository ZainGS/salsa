# VectorLayer Architecture Spec

## Current State

Vector shapes (scene graph nodes: rectangles, ellipses, speech balloons, etc.) are drawn every frame by `drawVectorShapes()` in the WebGPU render strategy. They always render above all raster layers — there is no concept of a layer that owns them, and they cannot be interleaved with raster layers in the compositor stack.

Ephemera placements (`EphemeraPlacement` records) are stored non-destructively on `'ephemera'` marker layer entries. These entries have no GPU texture and are excluded from the compositor, but without a live overlay renderer, placements are invisible until the user explicitly rasterizes them. That makes the non-destructive placement system meaningless in practice.

Neither system has a `layerId` concept today. Both always render on top.

---

## The Problem

1. **Ephemera placements are invisible** — they exist as data but don't render on the canvas until rasterized. The overlay rendering is not a nice-to-have; it's what makes Phase 3 non-destructive placements useful at all.
2. **No layer panel representation** — vectors and ephemera have no visible entry in the layer panel. Users cannot toggle visibility, reorder, or know they exist.
3. **Split types for the same concept** — `'ephemera'` and scene graph shapes are both "live, non-rasterized vector content." There is no reason to model them as different layer types.

---

## Recommendation: Single VectorLayer Entry

Add a single `type: 'vector'` entry to the layer stack that supersedes `'ephemera'`. This entry:

- Is always topmost by convention (matches current behavior — no regression)
- Represents both scene graph shapes and ephemera placements
- Is the layer the user selects to use vector tools or the ephemera panel
- Has no GPU texture (like `'3d-scene'` today) — vectors and SVG overlays are drawn by their own render paths
- Renders in two passes: **GPU geometry** (scene graph shapes) + **2D SVG overlay** (ephemera placements)

The layer panel UI shows one "Vector" layer pinned at the top. Clicking it activates vector/ephemera tools.

### Layer Stack Example

```
┌─────────────────────────────┐
│  Vector Layer  (type: vector) ← always topmost; no GPU texture
├─────────────────────────────┤
│  Ink Layer 2   (type: layer)
├─────────────────────────────┤
│  Ink Layer 1   (type: layer)
├─────────────────────────────┤
│  3D Scene      (type: 3d-scene)
└─────────────────────────────┘
```

### Render Pipeline

```
Frame render
 ├── [pre-raster] GPU vector pass (panel nodes with renderBelowRaster)
 ├── [raster compositor] all 'layer' and 'reference' entries
 ├── [post-raster] GPU vector pass (scene graph shapes)
 └── [2D overlay] SVG draw pass (ephemera placements on overlay canvas)
```

---

## Implementation Plan

### Phase A — VectorLayer entry + SVG overlay (core deliverable)

The overlay rendering and the layer type are a single unit. Without the overlay, the vector layer exists as data but is invisible for ephemera.

- [x] Add `'vector'` to `LayerEntryType` in `raster-layer-manager.ts` (keep `'ephemera'` for backwards-compat deserialization)
- [x] Add `addVectorLayer(name?)` and `addVectorLayerWithId(id, name, opts)` to `RasterLayerManager`
- [x] Add `removeVectorLayer(id)` and `getVectorLayers()` to `RasterLayerManager`
- [x] Fix `deleteLayer` to handle `'vector'` type (no manager, no timeline unregistration)
- [x] Migrate `addEphemeraLayer` / `addEphemeraLayerWithId` / `removeEphemeraLayer` / `getEphemeraLayers` to delegate to the new vector methods
- [x] Add post-frame callback hook to `WebGPURenderer` (`addPostFrameCallback`)
- [x] Add `setEphemeraOverlayCanvas(canvas)` to `ShapeManager`; register a post-frame hook that draws all visible ephemera placements onto the overlay 2D canvas using the current world transform
- [x] Expose `addVectorLayer()` and `getVectorLayers()` on `ShapeManager`
- [x] Update `restoreDocumentState` to handle both `type: 'vector'` and `type: 'ephemera'` (both restore as vector layers)
- [x] **`main.ts`:** Overlay canvas created with `position: fixed; pointer-events: none`, synced to WebGPU canvas via `ResizeObserver`; `setEphemeraOverlayCanvas` called automatically
- [x] New Illustration documents auto-create a default `'Vector'` layer on init
- [x] Placement click/drag: `setEphemeraInteractionCallbacks` wires hit-test → `draggingPlacement` mode → `movePlacementTo` in real time
- [x] `hitTestEphemeraPlacement` with rotation-aware AABB test; `selectPlacement` / `clearPlacementSelection` / `getSelectedPlacement` selection state

### Phase B — `layerId` on scene graph Node

- [x] Add `layerId?: string` to the scene graph `Node` base type
- [x] Update `Node.toJSON()` to include `layerId` when set
- [x] Render loop filters `aboveRasterNodes` by **visibility** (`_hiddenVectorLayerIds`, see Phase D) — nodes with no layerId always pass. (Note: rendering is NOT filtered by the *active* layer; all visible vector layers render. The active layer drives stamping + interactivity, not visibility.)
- [x] `setActiveVectorLayer(id)` / `getActiveVectorLayerId()` on ShapeManager. (The renderer's `setActiveVectorLayerId(id)` is now a **dead no-op stub** — active-layer state flows ShapeManager → `interactionService.activeVectorLayerId`; see Phase E.)
- [x] Update `ShapeManager` shape-creation methods to stamp `layerId` onto new nodes (activate once layer panel can set the active layer)

### Phase C — Layer panel UI

- [x] Show the vector layer entry in the layer panel (pinned topmost, teal-accented)
- [x] Selecting the vector layer activates vector shape tools and the ephemera panel
- [x] Vector layer visibility toggle (hides both GPU shapes and SVG overlay when off)
- [x] "Add Vector Layer" action in the layer panel (✦ Vector Layer in the add dropdown)

### Phase D — Multiple VectorLayers

- [x] Each vector layer independently filters scene graph nodes by `layerId` — `WebGPURenderer` now maintains `_hiddenVectorLayerIds: Set<string>`; hidden layers' nodes are excluded from `aboveRasterNodes`. API: `sm.setVectorLayerVisible(layerId, visible)`.
- [x] Layer panel allows creating and reordering multiple vector layers — `sm.addVectorLayer(name)` already existed; reordering is Frogmarks panel UI only (no render-order effect without interleaving).
- [ ] Optional (deferred): interleave vector draw call between raster compositor layers (requires render strategy work)

### Phase E — Pointer interactivity gating

Make the active vector layer gate *interaction* (not just stamping/visibility): only the active
layer's vector content is hit-testable; everything else is inert (clicks fall through). Visual
rendering is untouched — no dimming. Deliberate policy: unassigned (no-`layerId`) shapes stay
interactive; inactive layers are fully inert (no click-to-activate — the layer panel is the switch).

- [x] `interactionService.activeVectorLayerId` + `isVectorLayerInteractive(layerId)` (one rule, shared)
- [x] `setActiveVectorLayer(id)` mirrors the id onto `interactionService` and auto-deselects newly-inert nodes/placements
- [x] `SelectionService.isInteractable` gates single-click picking (`findFirstNodeUnderMouse`) and marquee (`boxSelect`)
- [x] Inline marquee path in `handlePointerMove` (`boxSelecting`) also gated — it's a separate path from `boxSelect()`
- [x] Ephemera handle + body hit-tests in `handlePointerDown` gated by the same rule
- [ ] Not gated (by design): the LiveText draw-mode hover (scoped to the text tool's own discoverability)

---

## What Does NOT Change

- GPU compositor stack for raster layers is untouched
- Ephemera generators, service, and placement CRUD pipeline are unchanged
- 3D rendering is unchanged
- Existing projects load correctly: old `'ephemera'` layer entries restored as `'vector'`; shapes with no `layerId` render on the default vector layer

---

## Files Affected

| File | Change |
|---|---|
| [raster-layer-manager.ts](../../src/services/raster-layer-manager.ts) | Add `'vector'` to `LayerEntryType`; add `addVectorLayer`, `addVectorLayerWithId`, `removeVectorLayer`, `getVectorLayers`; fix `deleteLayer`; migrate ephemera methods |
| [webgpu-renderer.ts](../../src/renderer/core/webgpu-renderer.ts) | Add `addPostFrameCallback` hook called after each frame submit |
| [shape-manager.ts](../../src/services/shape-manager.ts) | Expose vector layer API; add overlay canvas + renderer; update `restoreDocumentState` |
| [node.ts](../../src/scene-graph/shapes/base/node.ts) | Add `layerId?: string`; update `toJSON()` |
| [webgpu-render-strategy.ts](../../src/renderer/render-strategies/webgpu-render-strategy.ts) | Filter `drawVectorShapes` by layerId (Phase B) |
| Layer panel UI | Show vector layer; activate tools on selection (Phase C) |
