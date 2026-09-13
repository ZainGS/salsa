# Render Layer Decomposition — Extraction Map (audit C1)
**Date:** 2026-09-12 · **Status:** recon complete, NO code moved · **Precedent:** `armature-tangle-extraction-map.md`, `animation-cluster-extraction-map.md` (recon-then-slices; both C4-scale efforts went clean because the map came first).

C1 is the last L-tier structural item: `webgpu-renderer.ts` (5,383 ln) and `renderer-3d.ts` (5,327 ln)
have had zero decomposition. It is also THE most user-facing code in the engine — every click, drag,
paint stroke, and selection runs through the pointer handlers — so this is a dedicated-session effort
with in-app verification after each slice, NOT overnight work.

## Part 1 — `webgpu-renderer.ts` pointer input → `RasterInteractionController`
The three handlers span ~1,280 lines (`handlePointerDown` 1021, `handlePointerMove` 1600,
`handlePointerUp` 2112) + `handleWheel` (979) + `handleKeyDown` (777) + the bound-listener plumbing
(403-406, attach at ~556, reinit path).

**Coupling census (down+move+up):** 57 distinct members. Dominant:
- `interactionService` ×78 (selection, coords, box-select, interactive signals)
- `mode` ×61 — the draw/select/pan mode switch is smeared through all three handlers.
  ★ DESIGN CALL for the session: don't just relocate — consider a per-mode handler strategy
  (`onDown/onMove/onUp` per mode object) so the mode dispatch becomes structure instead of ifs.
  That's a REFACTOR (behavior-risk), so do it as slice 2, after a verbatim relocation lands as slice 1.
- drawing services (scribble/highlight/pattern/stamp/eraser) ×3 each, `selectionService`,
  `_uiPointerHandler` (UI-system capture), `isolatedTarget`/`pendingGroupBounds` (group edit state),
  coordinate helpers (`canvasPxToWorld`, `transformMouseCoordinatesToWorldSpace`, `safeInvert`),
  `stickyAncestorOf`/`speechBalloonAncestorOf`, `renderListDirty`, `scheduleRender`.

**Slice plan:**
1. Verbatim relocation: `RasterInteractionController` with a wide host (the recreate2DShape precedent
   — relocation buys isolation now, decoupling later). Keep handler names; renderer keeps bound
   delegator methods so listener attach/detach/reinit paths don't change.
2. (Optional, later) per-mode strategy objects to dissolve the `mode` switch.
3. Wheel + keydown ride along in slice 1 (small, same state).

**Verification per slice:** the established harness drives cover most of it — vector draw (drive-pen /
drive-edit2), raster dab+undo (drive-b1), box-select + shape drag need a new drive; plus a user pass
(pan/zoom feel, group edit, sticky/balloon interactions, UI-system pointer capture).

## Part 2 — `renderer-3d.ts` mega-method splits
- `drawMeshes` (2151 → ~3060, ~900 ln): batching walk + pipeline groups + per-texture bind logic +
  debug views. Split candidates: the opaque batching walk (shares shape with E2's `passRuns` — a
  follow-the-thread unification), the transparent pass, the standalone-bind-group path.
- `uploadSceneUniforms` (3401 → ~3820, ~420 ln): light selection + shadow matrix + fog/sky/grade
  packing. Mostly straight-line struct packing — extract pure packers (the day-night precedent:
  math out, application stays).
- `uploadMeshInstances` (3823 → ~4900, ~1,080 ln): THE monster — full repack + transforms fast path +
  array-group instancing + GARP overrides. Touches `_instance*` state everywhere; highest risk; last.

## Explicitly out of scope for C1
The raster paint/selection engines (already extracted), the pre-pass structure (E2 done), the
compositor (E5 done), camera/orbit (armature subsystem).

## Suggested session order
1. Part 1 slice 1 (verbatim controller move) + harness + user pass.
2. Part 2 `uploadSceneUniforms` pure packers (small, testable).
3. Part 2 `drawMeshes` split.
4. Part 2 `uploadMeshInstances` (dedicated session of its own).
