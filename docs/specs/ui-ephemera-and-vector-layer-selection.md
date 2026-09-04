# UI System — Ephemera as selectable shapes + vector-shape layer-scoping

**Status:** Investigation + **Issue A (A1) DONE + Issue B (B1) DONE 2026-09-01** (1161 tests).

### B1 implemented (vector shapes are now layer-tied like ephemera)
The map surfaced two load-bearing gaps: shapes weren't stamped when no vector layer was active, and **`layerId` was serialized but never restored** (`recreateNode` dropped it — a real bug: even stamped shapes came back unassigned/always-selectable). Fixes:
- **Persistence:** `recreateNode` now restores `node.layerId` from JSON (`shape-manager.ts` ~11455).
- **Always-stamp on create:** shared `ShapeManager._stampVectorLayer(target)` = `_activeVectorLayerId ?? rasterLayerManager.getDefaultVectorLayerId()`; replaced the 9 `if (activeVectorLayerId) X.layerId=…` creator sites + the LiveText creator. So every new vector shape gets a real layer home.
- **Backfill legacy:** `_backfillUnassignedVectorLayers()` runs in `restoreDocumentState` after layers are recreated — assigns the default vector layer to top-level shapes with no `layerId` (one-time per document, persists on save; idempotent; `layerId`-bearing shapes untouched).
- **`RasterLayerManager.getDefaultVectorLayerId()`** — the first `'vector'`-type entry.
- **No gate change, no selection→active bridge.** Relies on the host's EXISTING active-vector-layer mechanism (the same one that already gates ephemera — sets active on vector/ephemera-layer select, clears otherwise). A stamped vector shape is now selectable exactly when its vector layer is the active one — like ephemera.

⚠️ **Depends on: (1) a vector layer existing** (else shapes stay unassigned = backward-compatible always-live), and **(2) the host activating the vector layer on selection** (proven working for ephemera). Browser-verify: select the vector layer → shapes selectable; select a raster layer → shapes inert; existing shapes become layer-tied on load (save to persist). Boards (unexposed) now also ties shapes to layers; if Boards is exposed later it'd need an opt-out (no mode flag exists — see Q7).

### A1 implemented (ephemera are now first-class UI targets)
- **Selection reporting:** `EphemeraOverlay.onPlacementSelectionChanged` emitter (fires on `selectPlacement`/`clearPlacementSelection`); `ShapeManager.onShapeSelectionChanged` now subscribes to BOTH `interactionService.onSelectionChanged` AND that emitter, and `getSelectedShapeIds()` includes the selected placement id. So clicking an ephemera registers in the panel exactly like a vector shape. (Placement ids are globally unique — `makeId()` = timestamp+random — so no collision with node UUIDs; the placement id IS the `shapeId`.)
- **Hit-testing:** `UIManager.setEphemeraAdapter({pickAt,has,setVisible,isVisible})` + `hitTestEphemera(wx,wy)`; `pointerDown`/`pointerMove` try ephemera FIRST (overlay is on top), then 2D nodes, then a 3D-mesh pick. ShapeManager wires the adapter to `EphemeraOverlay.hitTestEphemeraPlacement` + `EphemeraService` (`_findPlacementById` resolves a placement's owning layer).
- **Effect application:** `UIManager._setShapeVisible`/`_shapeVisible` branch on `adapter.has(id)` → drive `EphemeraService.updatePlacement({visible})` for placements, else `node.visible`.
- Tests: `ui-manager.test.ts` (+1, ephemera pick→click→visibility); `ephemera-overlay.test.ts` still green.

Below is the original investigation (unchanged).

---

**Original investigation (no code changes yet). 2026-08-31.**

Two related problems the user hit while wiring the UI authoring panel:
1. Clicking a **vector shape** (circle/square) registers in the panel's SHAPE INTERACTIONS; clicking an **ephemera** does not.
2. Vector shapes are selectable **even with no layer active**, while ephemera require their layer active first. In Illustrations, vector shapes *should* be layer-tied like ephemera.

Both trace to the same architectural fact: there are **two parallel "shape" systems** that share one interactivity gate but have separate selection state.

---

## 0. The two shape systems

| | **Scene-graph vector shapes** (Boards-era) | **Ephemera placements** (newer) |
|---|---|---|
| What | circle/square/polygon/text/… | barcode/globe/crosshair/warning/… |
| Representation | a `Shape extends Node` in the scene graph | an `EphemeraPlacement` data record, **not** in the scene graph (`ephemera-types.ts:62`) |
| Stored | scene graph tree | `Map<layerId, EphemeraPlacement[]>` on `EphemeraService` (`ephemera-service.ts:85`) |
| Rendered by | the WebGPU scene-graph renderer | a **separate 2D overlay canvas** floated above (`ephemera-overlay.ts`) |
| Stable id | `Node.id` | `EphemeraPlacement.id` |
| `layerId` | **optional** (`node.ts:23`) — stamped only if a vector layer was active at creation | **required** (`ephemera-types.ts:65`) — always set (`ephemera-service.ts:277`) |
| Hit-test | `SelectionService.findFirstNodeUnderMouse` (`selection-service.ts:18`) | `EphemeraOverlay.hitTestEphemeraPlacement` (`ephemera-overlay.ts:253`), rotated-AABB |
| Selection state | `InteractionService.selectedNodes` (`interaction-service.ts:23`) | `EphemeraOverlay._selectedPlacementId/_LayerId` (`ephemera-overlay.ts:33`) |
| Selection event | `onSelectionChanged.emit(...)` on select (`interaction-service.ts:322`) | **none** — `selectPlacement` only mutates + `scheduleRender()` (`ephemera-overlay.ts:238`) |

**The shared gate** (both systems route through it): `InteractionService.isVectorLayerInteractive(layerId)` —
```ts
// interaction-service.ts:82
return !layerId || layerId === this.activeVectorLayerId;
```
- Scene-graph: bound into `SelectionService.isInteractable` at `webgpu-renderer.ts:835`, plus re-checked in the marquee filter at `webgpu-renderer.ts:1758`.
- Ephemera: checked at the renderer's two ephemera hit-test call sites (`webgpu-renderer.ts:1118` handles, `:1141` body).

---

## 1. Issue A — ephemera don't register as a "selected shape"

**Root cause: two selection systems, only one emits an event.**
- Click a vector shape → `webgpu-renderer` picks the node → `InteractionService.selectNode` → `onSelectionChanged.emit([ids])` (`interaction-service.ts:322`) → `ShapeManager.onShapeSelectionChanged` (the wrapper I added) → the UI panel. ✅
- Click an ephemera → `webgpu-renderer.ts:1142` calls `_ephemeraSelectCallback` → `EphemeraOverlay.selectPlacement(layerId, id)` → sets two fields + `scheduleRender()`. **No event.** The UI panel's `onShapeSelectionChanged` never fires. ❌

**Beyond the event, three more things are needed for an ephemera to actually work as a UI target** (the panel needs more than "it's selected"):
1. **Selection reporting** — bridge placement selection into the same signal the panel listens to (`onShapeSelectionChanged`), so a placement id becomes a valid `shapeId`.
2. **Hit-testing** — `UIManager.hitTest(worldX, worldY)` currently walks `shapeInteractions` and calls `sceneGraph.findNodeById(id).containsPoint(...)`. Ephemera **aren't nodes**, so a placement can never be hit this way. Needs an ephemera hit-test path (there's already `hitTestEphemeraPlacement` to bridge — exactly like the `setMeshPicker` provider I added for 3D-mesh targets).
3. **Effect application** — `UIManager._setShapeVisible(id, v)` sets `node.visible`. For a placement it must instead call `ephemera.updatePlacement(layerId, id, { visible })`. Same for hover cursor etc. So the manager needs to know "is this id a node or a placement?"

**Id uniqueness caveat:** placement selection is keyed by **(layerId, placementId)**, but a UI `shapeId` is a single string. `EphemeraPlacement.id` comes from `makeId()` (`ephemera-service.ts:277`) — need to confirm it's globally unique (not per-layer); if not, the UI would key on a composite `layerId:placementId`.

### Fix options for A
- **A1 (recommended) — treat placement ids as first-class shape ids, mirroring the 3D-mesh-target pattern.**
  - Add an emitter to `EphemeraOverlay` (fires on `selectPlacement`/`clearPlacementSelection`); `ShapeManager.onShapeSelectionChanged` reports the union of `selectedNodes` ids **and** the selected placement id.
  - Add a `setEphemeraPicker`-style provider to `UIManager` (bridges `hitTestEphemeraPlacement`) so `pointerDown`/`hitTest` can hit placements — analogous to `setMeshPicker`.
  - Branch `UIManager`'s visibility/hover effect application: if the id resolves to a placement, drive `ephemera.updatePlacement`; else the node path.
  - **Scope:** moderate; self-contained; testable (the pure hit-test/dispatch logic mockable like the 3D-mesh tests). No change to how ephemera themselves work.
- **A2 — promote placements to real scene-graph nodes.** Would make them "just work" everywhere, but it's a large architectural change (ephemera render on their own overlay, have their own transform/serialize path). Not recommended for this.

---

## 2. Issue B — vector shapes selectable with no active layer

**Root cause: the gate's `!layerId` short-circuit.** `isVectorLayerInteractive` returns `true` whenever `layerId` is falsy. A vector shape created with **no active vector layer** never got a `layerId` (`shape-manager.ts:2643` and siblings all stamp it only `if (this._activeVectorLayerId)`), so `!layerId` is `true` → **always interactive**, regardless of the active layer or even `null`. Ephemera can't hit this branch (their `layerId` is always set), so they're always gated.

This is a **Boards-vs-Illustrations** distinction:
- **Boards** (the original whiteboard prototype — complete but never exposed as a Shell app): free-floating, layer-less shapes are the intended model. The `!layerId` short-circuit exists for them.
- **Illustrations**: every vector shape should belong to a vector layer and be selectable only when that layer is active — i.e. behave like ephemera.

The user's current circles/squares are **Boards-era artifacts**: created with no active vector layer → no `layerId` → always live.

### What "layer-tied vector shapes in Illustrations" requires
1. **Creation** — a vector shape created in Illustrations must always get a `layerId`. Today creators only stamp it when `_activeVectorLayerId` is set. So either (a) guarantee an active vector layer exists in Illustrations (auto-create a default vector layer on first shape, always stamp it), or (b) make the creators require one.
2. **Backfill** — existing no-`layerId` shapes (the user's current ones) need a `layerId` assigned to a vector layer, or they'll stay always-live. A one-time migration (assign to a default/active vector layer on load), or a "assign to layer" action.
3. **Gate** — once every Illustrations vector shape carries a `layerId`, the existing gate already scopes them correctly (no gate change needed). **Alternatively/additionally**, make the `!layerId` short-circuit **mode-aware**: in Illustrations, treat "no layerId" as *inert* (or as belonging to a default layer) rather than *always live* — a smaller change that fixes selection immediately but doesn't tie the shape to a real layer for rendering/organization.

### Fix options for B
- **B1 (recommended) — always assign a vector layer in Illustrations.** Ensure a default vector layer exists + is active, and stamp `layerId` on every created vector shape (drop the `if (activeVectorLayerId)` guard in Illustrations). Backfill existing shapes on load. This makes them behave exactly like ephemera and is the "correct" long-term model. Boards keeps the current layer-less behavior (mode-scoped).
- **B2 (smaller, partial) — mode-aware gate.** In Illustrations, change `isVectorLayerInteractive` (or the binding at `webgpu-renderer.ts:835`) so `!layerId` is not treated as always-live. Fixes the *selection* asymmetry without reorganizing shapes into layers. Doesn't give the shapes a real home; more of a stopgap.
- **B3 — expose Boards as a Shell app.** Orthogonal but the user flagged it: Boards is a complete feature that just isn't launchable. Not required for A/B, but if Boards becomes its own mode, the "layer-less vector shapes" behavior can live cleanly there while Illustrations enforces layer-tying.

---

## 3. How the two connect + suggested sequencing

They're the same underlying seam:
- **B** makes vector shapes carry a `layerId` (so they gate like ephemera).
- **A** makes ephemera selection visible to the UI (so they register like vector shapes).
- Do both and the two systems become symmetric: everything is layer-scoped and everything reports selection to the UI panel.

**Suggested order:**
1. **A1 first** — it directly unblocks the UI panel (the user's immediate ask: "clicking an ephemera should register"). Self-contained, testable, no data migration.
2. **B1 next** — the bigger, correctness change (layer-tying + backfill). Needs care around migration of existing no-`layerId` shapes and is mode-scoped (Illustrations vs Boards).
3. **B3 (optional)** — expose Boards as a Shell app whenever convenient; it cleanly separates the "layer-less" model from Illustrations.

### Key files (reference)
- `src/services/ephemera/ephemera-types.ts:62` — `EphemeraPlacement` (`layerId` required :65)
- `src/services/ephemera/ephemera-overlay.ts:33,238,253` — placement selection state + `selectPlacement` (no event) + hit-test
- `src/services/ephemera/ephemera-service.ts:85,277` — placements map + `addPlacement`/`makeId`
- `src/services/interaction-service.ts:23,25,73,82,322` — selectedNodes, onSelectionChanged, activeVectorLayerId, isVectorLayerInteractive, selectNode emit
- `src/services/selection-service.ts:16,18` — isInteractable gate + pick
- `src/renderer/core/webgpu-renderer.ts:835,1118,1141,1758` — gate binding, ephemera hit-test gates, marquee gate
- `src/services/shape-manager.ts:2643(+siblings),13651,13717,13740` — layerId stamping, setActiveVectorLayer, onShapeSelectionChanged, placement delegators
- `src/scene-graph/shapes/base/node.ts:23,411` — optional layerId + serialize
- `src/ui/ui-state-machine.ts` / `src/services/managers/ui-manager.ts` — the UI hitTest/effect paths that assume scene-graph nodes
