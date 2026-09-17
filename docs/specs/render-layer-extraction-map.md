# Render Layer Decomposition — Extraction Map (audit C1)
**Date:** 2026-09-12 · **Status:** ✅ COMPLETE 2026-09-13 — Part 1 slice 1 + Part 2 all three splits done. Part 1 slice 2 (per-mode strategy objects) DECLINED by design: it was always optional; slice 1's relocation already bought the isolation, and restructuring 1,500 lines of THE most user-facing input code as strategy objects carries behavior-drift risk for zero functional gain. Revisit only if the pointer code grows new modes. · **Precedent:** `armature-tangle-extraction-map.md`, `animation-cluster-extraction-map.md` (recon-then-slices; both C4-scale efforts went clean because the map came first).

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

**✅ Slice 1 DONE (2026-09-13):** `src/renderer/core/raster-interaction-controller.ts` (~1,530 ln) —
verbatim move of handleKeyDown (777-813) + the 979-2388 block (handleWheel, calculateMouseAngle,
isolatedTarget/lastClickTime, handlePointerDown/Move/Up, isDescendantOf, group/ungroupSelectedShapes,
getWorldPosition, transformMouseCoordinatesToWorldSpace, getTopLevelSelectedNodes, cacheRect,
triggerRerenderForStrokesDeep, moveChildrenByDeltaDeep, updatePendingGroups,
handleSectionChildrenAfterMove, handleDropIntoSection, findTopSectionContainingShape,
fixNestedGroupChildren). Host shape: `constructor(private r: WebGPURenderer)` — instead of a 50-hook
bag, the 45 private members the cluster reaches were flipped to `public` on the renderer (relocation,
not decoupling — the couplings are now visible API). Renderer keeps 5 one-line delegators with the
original names so `_bound*` listeners + reinit are untouched; webgpu-renderer.ts 5,383 → ~3,990 ln.
Deterministic python transform (`LEFTOVER: []` clean), tsc clean first pass, 1395/1395 tests,
harness: NEW drive-c1 (click-select ✓, drag-move ✓, marquee both-selected ✓, g/u group-ungroup ✓,
ctrl-wheel zoom 1→1.54 ✓, zero GPU errors) + drive-pen ✓ + drive-b1 ✓ + drive-edit2 ✓.
★ Harness gotcha found: bare-harness shapes get a `layerId` but no host activates the layer, so the
vector-layer interactivity gate makes them pointer-inert — drives must set
`interactionService.activeVectorLayerId = shape.layerId` (NOT a bug; Frogmarks activates layers).

**Verification per slice:** the established harness drives cover most of it — vector draw (drive-pen /
drive-edit2), raster dab+undo (drive-b1), box-select + shape drag = drive-c1 (NEW); plus a user pass
(pan/zoom feel, group edit, sticky/balloon interactions, UI-system pointer capture).

## Part 2 — `renderer-3d.ts` mega-method splits
- ✅ `drawMeshes` DONE 2026-09-13 — within-class split (no new file): the ~900-line body is now a
  ~60-line orchestrator + six verbatim private stage methods in original order:
  `_ensureMeshBindGroups` (bind group + 6 pass-variant siblings), `_buildDrawLists` (pooled
  opaque/transparent/array-range/opaqueForPasses), `_recordPrePasses` (outline/shadow/SSAO+SSR one
  submit), `_drawPlanarReflectionPass`, `_drawMainPass` (partition + rank sort + batched opaque walk +
  multi/VC/transparent), `_drawMainOverlays` (outline composite/hover silhouette/source-link/post-
  overlay capture/AO debug). The former closures became methods: `_drawMesh`, `_passRuns` (per-frame
  cache field `_passRunsCache`, reset by drawMeshes after list build), `_replayRuns`. tsc clean,
  1404/1404, drive-e2 (2 submits/frame, 0 GPU err) + drive-e3 (atlas identical) + drive-kitbash all
  match baselines.
- ✅ `uploadSceneUniforms` DONE 2026-09-13 → `src/renderer/3d/scene-uniforms.ts` (pure module, 9 tests):
  `packSceneUniforms(data, params)` owns the WGSL float-offset contract (camera/ambient/light/ps1/
  resolution-repurposes/shadow block/fog+aerial/wind-in-lightCounts/point lights/ps1b) — renderer builds
  one params literal per upload; `selectNearestPointLights` (the P6 bounded-insertion core; guards stay
  on the renderer); `computeLightSpaceMatrix` (cube-box ortho, caller-owned scratch bag `_lsmScratch`).
  MAX_POINT_LIGHTS + PointLight3D moved there (renderer imports back; type-only the other way — no cycle).
  tsc clean, 1404/1404, harness drive-e2 (2 submits/frame preserved, 0 GPU err) + drive-e3 (atlas
  behavior identical, boxes render lit). NOTE the recon's "~420 ln" counted the neighbors; the actual
  cluster was ~190 ln (pack 90 + select 34 + LSM 26 + shadow-center 42 — shadow-center stayed: state).
- ✅ `uploadMeshInstances` DONE 2026-09-13 — within-class split, same pattern (matching the already-
  extracted `_tryIncrementalInstances`): the change-detection scan stays inline (it drives all gating);
  `_fastPathInstances(meshes, anyMatDirty): boolean` (transforms/material-only slot rewrite + coalesced
  run uploads; false = bail → full repack); `_writeInstanceSlot` (the former writeSlot closure —
  billboard-overlay/billboard/plain transforms + material floats + atlas indices + pattern slots;
  derives data/dataView/fpi itself, normal-matrix scratch = `_wsNormalMat` field);
  `_packArrayGroupInstances` (the array-group tail loop: per-copy translation/overrides/GARP skins).
  The recon's "~1,080 ln" predated E3 (which already carved out the atlas sync); actual was ~560 →
  now ~170-line orchestrator + 3 methods. ★ Extraction bug caught by tsc: the wrapper-strip ate the
  `if (!bail)` closer — anchor-cut scripts must strip ONLY the wrapper braces. tsc clean, 1404/1404,
  drive-e2/e3/kitbash all match baselines.

## Explicitly out of scope for C1
The raster paint/selection engines (already extracted), the pre-pass structure (E2 done), the
compositor (E5 done), camera/orbit (armature subsystem).

## Suggested session order
1. Part 1 slice 1 (verbatim controller move) + harness + user pass.
2. Part 2 `uploadSceneUniforms` pure packers (small, testable).
3. Part 2 `drawMeshes` split.
4. Part 2 `uploadMeshInstances` (dedicated session of its own).
