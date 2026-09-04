# Armature/Gizmo/Selection/Camera Tangle — Extraction Map

**Created 2026-08-16** (from a full-file recon of `src/services/managers/scene3d-manager.ts`, ~10,122 lines). This is the plan for the LAST scene3d-manager decomposition milestone: extracting the interactive-editing "tangle" after the 10 clean/GPU subsystems are out. Companion to `god-object-status-and-mcp.md`. Class body opens ~line 278; constructor ~559–643.

## Strategy: peel the ONE separable sub-cluster (weight paint); the rest is indivisible

The "tangle" has **3 canvas-listener closures**. Weight paint owns one and its own fields → separable. **But a code-level check (2026-08-16) proved the camera/orbit is NOT separately peelable:** `_illustrationSync` (36 refs) is read by orbit-controls (1575–1623), mesh-edit-orbit (1762–1851), skinned-import (2794), AND the bone-overlay/armature-mode cluster (5175–5204); `_orbitController` (46 refs) is read from deep inside the bone-overlay mega-closure (7394–7522). These two fields are the connective tissue of the whole remainder — so illustration/orbit/gizmo/bone-overlay/selection must move as ONE unit.

1. **Scene3DWeightPaint** — ✅ DONE 2026-08-16 (scene3d-weight-paint.ts). 10 fields + own listener closure + weight math. Only outward coupling was the bone-overlay closure's 3 `!_weightPaintMeshId` gate-reads → now `_weightPaint.isActive()`. Host: getSkinnedMesh/getOrbitController/getCamera/pickFromClient3D/getVerticesNearPoint3D.
2. **Scene3DArmature core** (LAST — one indivisible ~2,300-line move, its OWN focused session): camera/orbit/illustration (h `_orbitController`/`_viewGizmo`/`_orbitUpdateCallback`; i `_illustrationSync`/`_illustrationProjection`/`_autoSyncCallback`; c camera-lock fields) + gizmo (a `_gizmoRenderer`/`_transformController`/`_transformSyncCallback`/`_meshEditOverlay`) + bone overlay+joint (b) + IK/FK+joint drag (e) + bone placement (f) + selection/thin-wrapper (j). The two mega-closures **enableTransformControls (~6579–6982)** + **_setupBoneOverlayListeners (~6988–7605)**, plus orbit/illustration cluster (~1185–2100), showBoneOverlay/armature-mode/isolation (~5094–5490), selection/hover (5539/6256–6558), gizmo API (7607–7933), bone editing/IK (8502–8948). Because it's indivisible (no green intermediate — the tree is red mid-move until fully wired), do it as ONE atomic operation with fresh context; keep the 9 accessor points (below) as manager delegators and rewire the constructor host-closures.

## ★ The 9 accessor/host-callback points (fields read by NON-tangle code)
After extraction the manager must keep these reachable (delegate to the subsystem that ends up owning them):
1. `_illustrationProjection` — persistence: getGlobalScene3DSettings(6042 read) + restoreGlobalScene3DSettings(6076 write).
2. `_illustrationSync` + `_applyIllustrationCamera` — Scene3DPrimitives host(593), Scene3DImport host(631/632), skinned-import path(2794). Keep the `isIllustrationSync()`/`applyIllustrationCamera()` host-callback shape.
3. `_orbitController` — Scene3DCharacter host(578) + public getOrbitController()(2067).
4. `_transformController.orientationMode`/`.mode` — Scene3DArrays host(610) + enterGpDrawMode(4650, saves/restores gizmo mode around GP draw).
5. `_boneOverlayExplicit` + `_boneOverlaySkeletonId` — idle/spring anim (_springsActiveFor 677, idle closure 714) + public getBoneOverlaySkeletonId()(5337).
6. `_selectedGroupId` — Scene3DArrayBake host(638, clearSelectedGroup) + _expandGroupSelection(5539).
7. `_selectedThinWrapper` + `_thinWrapperTransformSyncs` — public setThinWrapperTransformSync/addThinWrapperTransformSync called by world-manager.ts:252; group-delete(2482) clears wrapper. Keep public registration API delegating.
8. `_gizmoRenderer` — enableArrayTool(7661).
9. **`_picker`** (286) — used by ~15 NON-tangle sites (delete/evict 2032/2487/4315/5795/5813, attachment place-pick 4771/4847/4911, GP raycast 4995, surface-paint host 599, hover/pick 6451/6486). **LEAVE `_picker` ON THE MANAGER**; pass into subsystems via host `getPicker()`.

## Constructor host closures that currently read tangle fields (update these on extraction)
- Scene3DCharacter(575): `getOrbitController` → armature/camera accessor.
- Scene3DPrimitives(591)/Scene3DImport(626): `isIllustrationSync`/`applyIllustrationCamera` → camera accessor.
- Scene3DSurfacePaint(597): `getPicker` → stays (picker on manager).
- Scene3DArrays(607): `getTransformOrientationMode` → armature accessor.
- Scene3DArrayBake(634): `clearSelectedGroup` → armature/selection accessor.

Everything else in the tangle is internally self-contained and movable. `_picker`, `_orbitController`, `renderer3D` are the closures' only outward reaches — all satisfiable via a host object.
