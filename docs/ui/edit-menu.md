# Edit Menu & Selection Actions — Frogmarks UI Integration

One-read contract for building the **Edit menu / selection toolbar** over the 2026-09-14/15
editing-loop work (spec: [../specs/editing-loop-polish.md](../specs/editing-loop-polish.md)).
Detailed per-feature notes live in [vector-layer.md](vector-layer.md) (2D) and
[3d-scene.md](3d-scene.md) (3D grouping); this page is the roll-up of what the host draws and
what the engine already owns.

## Undo / Redo — who owns which stack

There are FOUR undo stacks. Three are engine-owned end to end; the host only routes the fourth.

| Stack | Covers | Keys | Host buttons |
| --- | --- | --- | --- |
| **2D object** (new) | move / rotate / scale / group / ungroup / delete / duplicate / align / distribute / flip / line-endpoint edits of vector shapes | Engine consumes Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y **only when this stack can act** — otherwise the event falls through untouched | `sm.undo2DShapes()` / `sm.redo2DShapes()`, enable via `sm.canUndo2DShapes` / `sm.canRedo2DShapes`, tooltip via `sm.undoDescription2DShapes` |
| **3D** | every 3D transform, group ops, emitters, modifiers… | Host routes Ctrl+Z → `sm.undo3D()` (as today) | `sm.canUndo3D` / `sm.undoDescription3D` |
| **Path-anchor** (session) | anchor edits inside the path editor | Engine consumes its own Ctrl+Z while `sm.isPathEditActive` | none needed |
| **Raster** | brush strokes | Host's existing raster routing | unchanged |

**Routing rule for a host-side Ctrl+Z handler:** check `sm.canUndo2DShapes` first and skip your
handling when it's true — the engine will already have consumed the key (it uses
`stopImmediatePropagation`). Nothing double-fires.

## Selection actions (2D vector shapes)

All engine-implemented; each records ONE step on the 2D object stack and returns a useful value
for disabling menu items. Keys marked ✓ are engine-owned — menu items are optional accelerators.

| Action | API | Key | Notes |
| --- | --- | --- | --- |
| Duplicate | `sm.duplicateSelectedShapes(): Node[]` | Ctrl+D ✓ | Deep copies, +16px offset, same layer/parent, copies end up selected. 3D nodes → use `duplicateMesh3D`; packages skipped. |
| Delete | `sm.deleteSelectedShapes()` | Delete/Backspace ✓ | **Was silently broken for plain shapes (fixed 2026-09-15)** — and is now undoable. |
| Group / Ungroup | (engine keys only for now) | `g` / `u` ✓ | Any nesting depth; ungroup keeps world position, rotation, and scale. |
| Align | `sm.alignSelectedShapes('left'\|'centerX'\|'right'\|'top'\|'middleY'\|'bottom')` | — | 2+ shapes; union-bounds aligned (world y-up: `top` = greatest y). Returns false when nothing moved. |
| Distribute | `sm.distributeSelectedShapes('x'\|'y')` | — | 3+ shapes; centers evened, outermost two stay put. |
| Flip | `sm.flipSelectedShapes('horizontal'\|'vertical')` | — | Mirrors across the selection center; single shape mirrors in place. Exact for all matrix shapes (negative scale renders + hit-tests, pixel-verified); Lines mirror endpoints; Scribble/Highlight position-only. |

Suggested toolbar: the six align buttons + two distribute + two flip, enabled when
`interactionService.selectedNodes.size` meets each action's minimum (2 / 3 / 1).

## 3D selection parity (already surfaced elsewhere)

`duplicateMesh3D` · `deleteMeshGroup3D` / `addMeshToGroup3D` / `removeMeshFromGroup3D` (now
world-pose-preserving — see [3d-scene.md](3d-scene.md)) · rigid multi-selection rotate/scale via
the gizmo (world mode orbits the formation; local mode = individual origins, by design).

## Not built yet (phase 2 — don't draw buttons for these)

Shape *creation* undo and style/property-edit undo (2D stack covers object ops only) ·
alt-drag-to-copy · keyboard accelerators for align/distribute/flip · numeric transform input for
2D · z-order bring-forward/back commands (check before adding — may exist via zIndex APIs).
