# Editing-Loop Polish — Correctness & Parity Work List

**Date:** 2026-09-14 · **Origin:** the parent/child + transform audit (drive-parenting / drive-nest2d /
drive-rigid in the session harness) and the gaps it exposed. This is the "same family" follow-up to the
2026-09-14 fixes that already landed: nested 2D/3D grouping, rigid multi-selection rotate/scale,
ungroup rotation/scale composition, decal attach-to-mesh (with the regenerating-content guard), and
particle emitters as first-class objects.

**Theme:** the editing loop's *invariants* — "undo always works", "nothing jumps", "what exists in 3D
exists in 2D" — are worth more than new features. Every item below is a violated invariant, ranked.

---

## P1 · Undo for 2D vector OBJECT operations  ★ the gap

**Invariant violated:** Ctrl+Z works for raster strokes, path-anchor edits, and every 3D transform —
but NOT for moving/rotating/scaling/grouping/ungrouping/deleting 2D vector shapes. The most common
editing operations in a drawing app are the only ones that can't be taken back.

**Design (implemented 2026-09-14 — see status below):**
- **Generic snapshot-diff engine** (`src/services/vector-object-undo.ts`): capture a watch-set of
  nodes (selected top-level + descendants + ancestor chain) BEFORE a gesture, diff AFTER it, push one
  command holding `{before, after}` maps of per-node `{parentId, x, y, rotation, scaleX, scaleY,
  zIndex}` snapshots. `null` snap = node absent (created/deleted). **Node instances are RETAINED in
  the command** (not serialized) — undo of a delete/group re-attaches the same objects, so ids stay
  stable across undo/redo and later commands keep working.
- **Command stack:** reuses the generic `UndoManager3D` (description/undo/redo/dispose, pointer +
  depth cap) — it was never 3D-specific.
- **Recording points:** pointer-up after drag / rotate / scale gestures (after Section drop-in/out and
  pending-group recalcs, so those reparents are inside the same command); `g` / `u`;
  `deleteSelectedShapes` (Delete key + host calls).
- **Apply:** detach-removed pass → attach/retransform passes (looped until stable, so parents attach
  before children) → `updateLocalMatrix` + `markDirty` per node → `recalculateSize()` on restored
  Groups (deepest-first) → scene-graph-changed + render. Selection is cleared (stale-ref safety).
- **Keys:** the engine consumes Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y in `handleKeyDown` **only when the 2D
  object stack has something to undo/redo** — otherwise the event falls through untouched to the
  host's raster/3D routing. Path-edit sessions already consume their own Ctrl+Z with
  `stopImmediatePropagation` before anyone else sees it.
- **Facade:** `undo2DShapes()` / `redo2DShapes()` / `canUndo2DShapes` / `canRedo2DShapes` for host
  buttons.
- **Out of scope (phase 2):** shape *creation* undo (nine drawing services commit shapes through
  different paths — wants a choke-point hook in ShapeFactory), style/color property edits.

**Status: ✅ BUILT 2026-09-14** — unit tests + harness drive (drag/rotate/scale/group/ungroup/delete
round-trips, incl. pixel-verified GPU-cache resurrection after delete-undo). See
`vector-object-undo.test.ts` + `drive-undo2d.js`; host notes in `docs/ui/vector-layer.md` §"2D object
undo". **Bug found by the drive:** `deleteSelectedShapes` had regressed into a silent no-op for
ordinary shapes (the package-deletion patch's `remaining` aliased `selected`, so the
clear-and-repush emptied both) — fixed in the same change, so Delete works again at all.

## P2 · 2D duplicate parity  [S]

`duplicateMesh3D`, `duplicateLayer`, `duplicateCel`, and emitter Duplicate exist; 2D shapes have no
duplicate at all. Add `duplicateSelectedShapes()` (serialize → recreate via shape-serializer → offset
by ~16px → select the copies) + Ctrl+D in `handleKeyDown` (same guards as g/u) + alt-drag-to-copy
later. Must push a P1 undo command ("created" diffs).

**Status: ✅ BUILT 2026-09-15** — `sm.duplicateSelectedShapes()` (toJSON → `recreateNode` with ids
stripped deep → fresh ids mint; same parent + layer; ~16 px offset at current zoom; copies selected;
one "Duplicate shapes" P1 command) + Ctrl+D via `setDuplicateSelectedHandler` (consumed only with a
2D selection; sits before the text-shape guard so sticky notes duplicate too). 3D nodes and packages
skipped. Harness: `drive-dup2d.js` (fresh id/layer/selection, pixel-verified render + undo/redo,
deep group copy, empty-selection fall-through). Alt-drag-to-copy still open.

## P3 · 3D group hygiene  [S]

Close the two documented caveats (both unreachable via today's UI, one API call away from a bug):
- `addMeshToGroup3D`: compensate the mesh transform by the group's inverse so world position holds.
- `deleteMeshGroup` / `removeMeshFromGroup`: compose the group's transform into children on
  un-parenting (the 2026-09-14 2D ungroup math, in 3D).

**Status: ✅ BUILT 2026-09-15** — `src/services/managers/transform-rebase-3d.ts`:
`rebase3DNodeToParent(node, newParent)` (world TRS captured from the combined matrix → reparent →
re-express in the new parent's frame; position exact, rotation via quaternion division back to
Y→X→Z Euler, scale per-axis; rotated ancestor + non-uniform scale = shear = nearest fit, same
caveat as 2D `bakeScaleToLeaves`). Used by `addMeshToGroup` / `removeMeshFromGroup`
(scene3d-manager) and `deleteMeshGroup` (scene3d-grouping — undo restores the exact saved locals
via `captureLocalTRS3D`/`restoreLocalTRS3D`). 5+1 unit tests + `drive-grp3d.js` (add/remove/delete
into a translated+rotated group: world pose holds at every step; undo3D exact).

## P4 · 2D align / distribute / flip  [M]

Standard vector toolkit, absent: align L/C/R/T/M/B over the selection bounds, distribute evenly,
flip H/V. Flip needs a check that negative scale renders + hit-tests correctly (scaling clamps to
minimums today; mirroring may be unsupported). All operations must record P1 undo commands. Facade
methods first (host draws the buttons); keyboard later.

**Status: ✅ BUILT 2026-09-15** — `alignSelectedShapes` / `distributeSelectedShapes` /
`flipSelectedShapes` on the facade (bounds via `getWorldSpaceBoundingBoxPolygon`, world deltas
through the inverse parent chain, one P1 command each). **Negative-scale question answered: YES** —
flip pixel-verified on an asymmetric Path (red-mass swap exact) and `containsPoint` follows.
Flip = position reflected + rotation negated + scale axis negated (exact: M∘T∘R∘S = T'∘R(-θ)∘S(∓));
Lines mirror endpoints (identity contract); Scribble/Highlight position-only (world-baked strokes —
note `usesWorldSpaceBoundingBox` is NOT the discriminator, PathNode reports true yet transforms).
Bonus: NodeSnap gained Line endpoints, so endpoint drags now record "Edit line" undo commands.
Harness: `drive-align2d.js`. Keyboard bindings still open (host buttons first).

## P5 · autoFar input fixes  [S]

From the grid-clipping investigation (2026-09-13): (a) feed the reference grid's extent into
`sceneRadius` when `sceneGridVisible3D` so grazing views can't clip the grid; (b) let `sceneRadius`
track scene growth without requiring a reframe (today it only updates on reframe — a mesh dragged far
out without ever reframing can clip). The user-facing "view distance" knob stays NOT built (see the
2026-09-13 discussion — fix the inputs, don't add a workaround knob).

**Status: ✅ BUILT 2026-09-15** — (a) `_gridRadiusFloor()` in scene3d-manager (mirrors drawGrid's
extent: ±min(⌊10/step⌋,200)·step, ×√2 diagonal) applied grow-only in `_pushGridConfig` and as a
floor in `frameMeshes`, so toggling the grid arms autoFar and a reframe to a tiny scene can't clip
the grid; (b) `onTransformComplete` (scene3d-armature) grows `sceneRadius` monotonically from each
moved node's world distance to the camera target — a mesh dragged far out no longer needs a reframe
to stay inside the far plane (the next reframe re-derives the exact radius). Harness:
`drive-autofar.js` (floor 14.142 applied + survives reframe; +50 grab grows radius to 51).

## P6 · Persistence-invariant harness drive  [S · test-only]

One drive: build a scene with every marker-carrying system (groups 2D/3D, attached + world decals,
emitters, a character, a package), **save → load → save, assert the two saves are equivalent**, and
assert attached decals still ride their meshes after reload. This is cheap permanent insurance for
the params-as-source thesis and retires the "attached-decal round-trip" caveat.

**Status: ✅ BUILT 2026-09-15 — `drive-persist.js`, and it found SIX real persistence bugs, all
fixed the same day:**
1. **Attached decals NEVER persisted** — `Mesh3D.toJSON` emitted no children at all, so the decal
   container riding on its target mesh was silently dropped from every save. Fixed: decal marker
   containers (only) now serialize as mesh children; the 3D restore pass stashes them through its
   mesh wipe and re-attaches them to the rebuilt target (world-anchor fallback).
2. **Reloaded packages came back dead** (panels loose at scene root, empty Package group): the
   packaging registry survived a document load, so `_adoptPersisted` saw `items.has(id)` and
   skipped re-adoption. Fixed: `PackagingManager.clearForDocumentLoad()` + coordinator call. Same
   bug class in decals: `DecalManager.clearForDocumentLoad()`.
3. **Procedural-body Clips + Pose Library emptied on reload**: `Skeleton3D` (extends Node, plain
   `id` field) had no `peekId()`, so removeChild never unregistered it from the scene graph's
   id map — the default-clip backfill then targeted the STALE detached skeleton. Fixed: `peekId()`
   on Skeleton3D (+ backfill also added to `restoreSkeletonState` for direct callers).
4. **`updateSceneGraph` wiped children via `children = []`** — stale nodeMap entries served
   detached pre-restore nodes to any post-restore `findNodeById`. Fixed: proper removeChild loop.
5. **Root-child ORDER drifted on every load** (skeleton/package appended out of order — outliner
   reshuffle): restore now re-asserts the saved root order (stable sort by saved id sequence).
6. **Skip-wrapper content double-serialized**: package panels (children of a
   `documentSkipChildren` marker) were included in scene3dJSON's node list, so the restore
   recreated them LOOSE at root. Fixed: ancestor-based exclusion in the gather. Plus: the
   load-time vector-layer backfill stamped `layerId` onto 3D nodes (now 2D-only) and 2D groups now
   get their layer stamped at creation.

**Steady-state verdict: PASS** — save→load→save is idempotent from the first cycle (zero drift on
a second cycle); the only save1→save2 differences are three allowlisted one-time canonicalizations
(explicit material defaults on restored skinned meshes, normalized light direction, `wasCreator`
adoption). Attached decal: survives reload, quad regenerates, and pixel-exactly follows its mesh.

## Honorable mentions (unranked)

- Numeric transform input for 2D (parity with 3D's G/R/S + digits).
- Pivot options for multi-rotate (first-selected / cursor, instead of always the centroid).
- Z-order commands (bring forward/back) if not already surfaced to the host.
- `bakeScaleToLeaves` on a *rotated* child under non-uniform scale is a shear (nearest-fit today) —
  only fixable by baking into geometry; revisit if users hit it.

## Related invariants already closed (2026-09-14, for the record)

Nested 2D group ungroup (any depth) · nested 3D group selection/move · ungroup keeps rotation+scale ·
rigid multi-selection rotate/scale in world mode (local mode = individual origins, by design) ·
decals attach to meshes (with world-anchor fallback for regenerating city/package content) ·
character parts move as one · emitters: icons, click-select, gizmo, undo.
