# Salsa — Backlog & Deferred Items
**Last Updated:** 2026-06-10

Collected outstanding work as of June 6, 2026. Items are ordered by priority within each section.

---

## Unimplemented Features (specs written, no code yet)

### Shell UI — WebGPU Home Screen

**Spec:** `docs/specs/shell-ui.md`  
**Value:** Replaces the HTML/SCSS Frogmarks dashboard with a Salsa-rendered spatial home screen: 3D cartridge viewer + slot grid. The foundation of the Frogmarks console identity.

8 phases: shell scaffold → cartridge viewer → thumbnails → local cart install → remote cart install → auto-update → polish → system app panels (Frogmarks-side).

---

### Armature Phase 3 — Pose Library

**Spec:** `docs/specs/armature-phase3.md` § Item 3  
**Value:** Lets animators snapshot and recall full FK poses (T-pose, A-pose, idle reference) without re-keying joints by hand.

Data model on `Skeleton3D.data.poses`:
```ts
{ id: string; name: string; rotations: { jointIndex: number; rotation: [qx,qy,qz,qw] }[] }[]
```

API needed on `ShapeManager`:
```ts
capturePose3D(skelId, name)           // → poseId; snapshots all joint localRotations
applyPose3D(skelId, poseId)           // set all joints + fire sceneGraphChanged
getPoses3D(skelId)                    // → { id, name }[]
renamePose3D(skelId, poseId, name)
deletePose3D(skelId, poseId)
```

Poses must survive project save/load (serialized in `Skeleton3D.toJSON()`).

---

### Armature Phase 3 — Bone Constraints

**Spec:** `docs/specs/armature-phase3.md` § Item 4  
**Value:** Automates common rigging patterns — eye-tracking, symmetric limbs, stretchy limbs — without manual keyframing.

Three constraint types:

| Type | Effect |
|------|--------|
| `lookAt` | Rotates joint so its chosen axis points toward a target joint or world position |
| `copyRotation` | Mirrors another joint's FK rotation (weighted) |
| `stretchTo` | Scales bone to reach a target with volume preservation |

Constraints run as a third evaluation step after FK and IK (see `armature-phase3.md` evaluation order diagram).

API needed on `ShapeManager`:
```ts
addJointConstraint3D(skelId, jointIndex, constraint)   // → constraintIndex
removeJointConstraint3D(skelId, jointIndex, constraintIndex)
getJointConstraints3D(skelId, jointIndex)              // → JointConstraint[]
```

---

### IK Target Keyframing

**Spec:** `docs/specs/armature-ik.md` § Not Yet Implemented  
**Value:** Lets animators move an IK handle at frame 0, keyframe it, move to frame 24, keyframe again — the same workflow used for FK rotation tracks.

Currently `chain.target` world position is not keyframeable. Workaround: bake solved rotations to FK channels via `setClipJointKeyframe3D`.

What's needed:
- Add `target` as a keyframeable track on `IKKeyframeTrack` (currently only stores chain-level data)
- `setIKKeyframe3D(skelId, chainId, frame)` — snapshots current `chain.target` position ← **exists** but may not be wired to clip playback
- `evalFrameLink3D` / `applyAllKeyframesAtFrame` path needs to read IK target tracks and call `setIKTarget` before the FABRIK solve runs

---

## Known Bugs (deferred)

### ~~Armature Pan Bug~~ ✅ Fixed June 2026

**Root cause:** `_applyIllustrationCamera` (called every frame via `_autoSyncCallback`) was setting `camera.target` to world-space X/Y from the 2D pan offset. This overrode whatever the orbit controller had computed, making orbit-controller pan (right/middle drag) ineffective and causing movement in world-space directions after orbiting.

**Fix (`scene3d-manager.ts`):**
- `syncIllustrationCamera`: when `_boneOverlayExplicit`, update `_illustrationSync` and return — orbit controller owns the camera entirely.
- `_applyIllustrationCamera`: early-return guard `if (this._boneOverlayExplicit) return` covers all direct callers.

The orbit controller's existing `pan()` method already used camera-space vectors correctly; it only needed `_applyIllustrationCamera` to stop fighting it each frame.

---

## Performance & Correctness Issues (open since evaluation)

### Critical / Correctness

**`recreateNode` default case loses data silently**  
*(First flagged: April 12, 2026)*  
If a scene JSON contains a node type that `recreateNode`'s switch doesn't handle, the default case silently discards the node. Projects with unknown node types (e.g. from a newer version) open without error but are missing content.  
**Fix:** Default case should log a warning and create a placeholder node (or throw in dev mode).

---

### Memory Pressure

**Raster snapshot memory: 50 × full-frame RGBA**  
*(First flagged: April 12, 2026)*  
The raster undo stack keeps up to 50 full-canvas snapshots in GPU memory. At 1920×1080 RGBA that's ~400 MB of GPU textures held alive at peak. Most of those snapshots are never accessed (users undo ≤ 5 steps).  
**Fix options:** Cap undo depth at ~10 for raster; or compress via GPU → CPU PNG at snapshot time.

**SDF atlas never shrinks**  
*(First flagged: April 12, 2026 — Fixed June 2026)*  
~~The SDF glyph atlas grows whenever new text is added, but never reclaims space from deleted/modified text shapes. Long sessions accumulate all glyphs ever used.~~  
**Fixed:** `SDFTextAtlas.compact()` resets the atlas to 1024×1024 and repopulates from live SDFText shapes only. Triggered automatically in `WebGPURenderer.handleAtlasCompactIfNeeded()` when `atlasSize >= 4096`. The atlas re-grows naturally to the minimum size required by the current scene. A version guard prevents re-compacting when live glyphs genuinely need a large atlas.

---

### CPU / GPU Overhead

**Skinned mesh skin matrices uploaded every frame**  
*(First flagged: May 10, 2026)*  
`drawSkinnedMeshes` rebuilds and re-uploads `skinMatrices` every frame for every skinned mesh, even when the skeleton is not animating.  
**Fix:** Dirty-track `Skeleton3D` (set a `skinDirty` flag on `setJointRotation`, clear after upload); skip upload when clean.

**Billboard model matrices rebuilt every frame**  
*(First flagged: June 2, 2026)*  
Billboard meshes override their model matrix in `uploadMeshInstances` every frame regardless of camera movement. The existing `localMatrixVersion` dirty-bypass is bypassed for billboards.  
**Fix:** Cache the last camera-right/up vectors; only rebuild billboard matrices when either the mesh moved or the camera moved.

**Particle system has no delta-time cap**  
*(First flagged: May 10, 2026)*  
If the tab is backgrounded and then refocused, `performance.now()` delta is the full hidden duration. Particle positions explode with huge dt values.  
**Fix:** Cap `dt` to ~100ms (about 3 frames) in the particle tick.

---

### Brush / Paint

**`MeshPaintManager._flushDirty` allocates on every dab**  
*(First flagged: May 10, 2026)*  
`_flushDirty` creates a new typed array slice on every `paintMeshDab` call. At 60 dabs/second during a stroke this produces significant GC pressure.  
**Fix:** Pre-allocate a reusable staging buffer sized to the largest dirty rect.

**`enterMeshPaintMode` permanently replaces `diffuseTexture`**  
*(First flagged: May 10, 2026)*  
Calling `enterMeshPaintMode(meshId)` sets the paint texture as `mesh.diffuseTexture` with no way to restore the original texture on exit.  
**Fix:** Save and restore `mesh.diffuseTexture` in `enterMeshPaintMode` / `exitMeshPaintMode`.

---

### Minor / Housekeeping

~~**`FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` redundant constants**~~  
✅ Already fixed — `pipeline-3d.ts` exports `MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * Float32Array.BYTES_PER_ELEMENT`. No manual sync needed.

~~**Legacy dead code**~~  
✅ Investigated June 2026 — `AnimationManager` is live (timeline/cel/onion skinning); `RenderCache` was never a class (just an old comment). The only actual dead artifact was `src/services/feature-managers.txt` (a stale planning note), which has been deleted.

---

### UV Editor — Phase 1 (Seam System) — ✅ Completed June 2026

**Spec:** `docs/specs/uv-editor.md`

Phase 1 ships the seam data model and rendering backbone needed for all subsequent UV phases.

| Deliverable | Status |
|-------------|--------|
| `EditHalfEdge.isSeam: boolean` — initialized in `_buildTopology`, persisted in `EditMesh.toJSON/fromJSON` as `[vFrom, vTo][]` pairs | ✅ |
| `EditMesh.markSeams()` / `clearSeams()` / `clearAllSeams()` / `suggestSeams(thresholdDeg)` | ✅ |
| `MeshEditManager.markSeam()` / `clearSeam()` / `clearAllSeams()` / `suggestSeams()` — all undoable | ✅ |
| Seam edges rendered red in `MeshEditOverlayRenderer` (`C_SEAM_EDGE = [0.9, 0.15, 0.15, 1.0]`) | ✅ |

`sm.uv.markSeam` / `sm.uv.clearSeam` etc. are deferred to Phase 8 (Frogmarks UI); the underlying engine layer is complete. Phase 2 (island detection) in progress.

---

## Deferred by Design

### Vector Layer Interleaving (Phase D)

Frogmarks's Phase D vector layer work is otherwise complete. The single remaining item is the ability to draw a vector/GP layer *between* two specific raster compositor passes — e.g. a GP ink layer rendered on top of one raster cel but under another.

**Why deferred:** The current render strategy executes all 3D/GP passes as a block, then composites raster layers. Interleaving would require either splitting the compositor into multiple sub-passes or making the GP renderer aware of the raster compositor timeline. Both are non-trivial render strategy changes.

**Current behavior:** All GP objects always render after all raster layers (or with `renderOrder` within the GP pass). The standard use case (GP on top of everything) works fine.

---

### Geometry Modifier Stack — Drag-Reorder UI

The backend supports modifier reordering via `removeGeomModifier3D` + `addGeomModifier3D`. A first-class `reorderGeomModifier3D(meshId, fromIndex, toIndex)` API and drag-reorderable panel list would complete the UX.

**Current workaround:** Frogmarks can implement drag-reorder by removing the modifier at `fromIndex` and re-adding it at the desired position.

---

### ✅ Lo-Fi / Retro Rendering (PS1 + 3DS) — Completed June 2026

**Spec:** `docs/specs/lofi-rendering.md`

Implemented features:

| Feature | Status |
|---------|--------|
| Low-res render buffer + nearest blit | ✅ `LoFiPass` — `PS1Config.renderResolution` / `renderScale` |
| `'gouraud'` render style | ✅ `RenderStyle` — per-vertex lighting, no per-pixel PBR |
| In-shader Bayer dithering | ✅ `PS1Config.dither` / `ditherStrength` |
| UV quantization | ✅ `PS1Config.uvQuantize` / `uvQuantizeSteps` |
| `setRetroPreset3D('wobble'\|'pocket'\|'off')` | ✅ On `ShapeManager` |
| CRT scanline filter | 🔵 Deferred (optional polish) |

API: `sm.setRetroPreset3D('wobble')`, `sm.setPS1Config({...})`, `mesh.material.renderStyle = 'gouraud'`.  
See `docs/specs/lofi-rendering.md`, `src/renderer/3d/lofi-pass.ts`.

---

## Readiness Summary

| Item | Status |
|------|--------|
| Pose Library | ✅ Completed June 2026 — `capturePose3D`, `applyPose3D`, `getPoses3D`, `renamePose3D`, `deletePose3D` on ShapeManager |
| Bone Constraints | ✅ Completed June 2026 — `addJointConstraint3D`, `removeJointConstraint3D`, `getJointConstraints3D` on ShapeManager; `constraint-solver.ts` with lookAt / copyRotation / stretchTo |
| IK target keyframing | ✅ Already fully implemented — `setIKKeyframe3D`, `IKKeyframeTrack`, eval path all wired |
| Armature pan bug | ✅ Fixed June 2026 — suppress `_applyIllustrationCamera` when `_boneOverlayExplicit`; orbit controller owns camera |
| `recreateNode` data loss | ✅ Fixed June 2026 — warns + placeholder |
| Raster snapshot pressure | ✅ Fixed June 2026 — capped at 10 |
| SDF atlas growth | ✅ Fixed June 2026 — size-threshold compaction in `WebGPURenderer`; atlas resets to 1024 and repopulates from live shapes |
| Skin matrix upload overhead | ✅ Fixed June 2026 — dirty-flag guard before writeBuffer |
| Billboard frame-rebuild | ✅ Already had viewChanged early-return |
| Particle dt cap | ✅ Already capped at 100ms |
| MeshPaint flush alloc | ✅ Already uses reusable staging buffer |
| MeshPaint texture restore | ✅ Already has _savedDiffuse / restoreOriginalTexture |
| `FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` | ✅ Already fixed — derived in `pipeline-3d.ts` |
| Legacy dead code | ✅ Investigated — no dead code; `feature-managers.txt` deleted |
| Vector layer interleaving | 🔵 Deferred by design |
| Lo-Fi rendering (PS1/3DS) | ✅ Completed June 2026 |
| Modifier stack drag-reorder UI | 🔵 Deferred by design |
| UV Editor — Phase 1 (Seam system) | ✅ Completed June 2026 — `isSeam` on half-edges, `markSeams/clearSeams/suggestSeams` on EditMesh + MeshEditManager, red overlay |
| UV Editor — Phase 2 (Island detection) | ✅ Completed June 2026 — `UVIsland` type, `EditMesh.computeUVIslands()`, `sm.getUVIslands3D()` |
| UV Editor — Phase 3 (UV canvas renderer) | ✅ Completed June 2026 — `UVEditorSession`, `UVCanvasRenderer`, `sm.openUVEditor3D` |
| UV Editor — Phase 4 (UV editing operations) | ✅ Completed June 2026 — `UVEditManager`, move/scale/rotate/mirror/weld/split/pin on ShapeManager |
| UV Editor — Phase 5 (Unwrap algorithms) | ✅ Completed June 2026 — `unwrapIslands`, `followActiveFace`, `packIslands` on EditMesh + UVEditManager + ShapeManager |
| UV Editor — Phase 6 (LiveTextureMode + painting bridge) | ✅ Completed June 2026 — `LiveTextureMode`, `RasterLayerManager.getLayerTexture`, `sm.linkLiveTexture3D` / `syncLiveTextures3D` |
| UV Editor — Phase 7 (Cross-highlighting) | ✅ Completed June 2026 — `hoveredFaces` in `MeshEditDrawData`, cyan tint in 3D overlay, island hover mode in UV canvas, `sm.setUVHoverFace3D` |
| UV Editor — Phase 8 (Editor UI) | ✅ Completed June 2026 — `docs/ui/uv-editor.md`, `sm.exportUVLayout3D` |
| UV Editor — Phase 9 (GLTF UV import) | ✅ Completed June 2026 — `_editMeshFromGeometry` copies UV from vertex buffer; round-trip verified |
| UV Editor — independent mode | ✅ Fixed June 2026 — `openUVEditor3D` no longer requires `enterMeshEditMode3D`; data provider handles UV-only overlay path; mode checker suppresses gizmo in UV mode |
| UV Editor — UV texture paint | ✅ Completed June 2026 — `ensureUVPaintCanvas3D`, `commitUVTexture3D`, `shareUVTexture3D` on ShapeManager; `uvRenderer.draw()` accepts `HTMLCanvasElement` as texture |
| WebGPU canvas resize | ✅ Fixed June 2026 — `setCanvasSize` uses `getBoundingClientRect` instead of `window.innerWidth`; `ResizeObserver` on canvas handles split-view activation |
| Pixel Codec | ✅ Completed (spec untracked in git) — `encodePixels`/`decodePixels` via `OffscreenCanvas`; `'png'` default in `AutoSaveConfig`; v2 backwards compat; `sm.getPixelFormat`/`setPixelFormat`/`isPixelFormatSupported`; UI doc at `docs/ui/storage-settings.md` |
| GP Drawing Plane | ✅ Engine complete (spec untracked in git) — `faceNormal` in `PickResult`; `_gpDrawPlane` state + ray-plane intersection; hover highlight overlay; plane visualization quad; `sm.enterGpFaceSelectMode3D` / `exitGpFaceSelectMode3D` / `setGpDrawPlaneOffset3D` / `clearGpDrawPlane3D`. Phase 4 (panel UI) is Frogmarks-side. |
| Bezier easing | ✅ Already implemented — `KeyframeEasing: 'ease-in' \| 'ease-out' \| 'ease-in-out'`; CSS cubic-bezier with Newton's method in `keyframe-3d.ts` |
| Camera keyframing | ✅ Already implemented — `Camera3DKeyframeTracks` (position/target/fov); `setCameraKeyframe3D`, `recordCameraKeyframe3D`; wired to `applyAllKeyframesAtFrame` |
| Blend shape weight keyframing | ✅ Completed June 2026 — `blendWeights: Record<string, Keyframe<number>[]>` in `Mesh3DKeyframeTracks`; sampled in `applyMeshKeyframesAtFrame`; `setBlendShapeKeyframe3D` / `removeBlendShapeKeyframe3D` / `getBlendShapeKeyframeTracks3D` on ShapeManager |

---

## Missing Features (not yet specced — MVP gaps vs. existing tools)

### ✅ PBR Materials (roughness + metalness) — Completed June 2026

Cook-Torrance BRDF (GGX NDF + Smith geometry + Schlick Fresnel) shipped in the June 2026 build. `roughness` and `metalness` are in `Material3D` and the `MeshInstance` GPU buffer. See `docs/reference/15-3d-rendering-system.md` § PBR Materials & IBL and `docs/ui/3d-scene.md` § Material.

---

### ✅ IBL / Environment Lighting — Completed June 2026

SH L0+L1+L2 diffuse irradiance from equirectangular env maps shipped alongside PBR. 160-byte `IBLUniforms` buffer at group 0 binding 2. `setEnvironmentMap3D` / `clearEnvironmentMap3D` / `iblEnabled3D` are on `ShapeManager`. See `docs/reference/15-3d-rendering-system.md` § IBL Uniforms Buffer.

---

### ✅ Blend Shapes / Shape Keys — Completed June 2026

CPU morph target evaluation before LBS skinning. GLTF `prim.targets[]` import with world-transform baking. `addBlendShape3D` / `setBlendWeight3D` / `getBlendShapes3D` / `removeBlendShape3D` on `ShapeManager`. See `docs/specs/blend-shapes.md`, `docs/theory/blend-shapes.md`, and `docs/reference/15-3d-rendering-system.md` § Blend Shapes.

---

### ✅ Post-Processing Stack — Completed June 2026

Bloom (bright-pixel extract + Gaussian blur + additive composite), color grade (brightness/contrast/saturation/tint), and vignette shipped as a combined `PostProcessPass`. All effects chain between `passEncoder.end()` and the swapchain copy. See `docs/specs/post-processing.md` and `docs/reference/15-3d-rendering-system.md` § Post-Processing Stack.

---

### ✅ Non-Linear Animation (clip blending) — Completed June 2026

`NLATrack` and `NLAClipSegment` types added to `armature-3d.ts`. `evaluateNLAAtFrame` in `skeleton-animator.ts` handles replace and additive blending with fade-in/out ramps. Full API on `ShapeManager`: `createNLATrack3D`, `addNLASegment3D`, `playNLATrack3D`, `crossfade3D`, etc. See `docs/specs/nla.md`, `docs/theory/nla.md`, and `docs/reference/15-3d-rendering-system.md` § Non-Linear Animation.

---

### ✅ Export to Standard Formats (GLTF/GLB) — Completed June 2026

`exportSceneToGlb` in `src/renderer/3d/gltf-exporter.ts` walks all `Mesh3D` and `Skeleton3D` nodes, serializes geometry (position, normal, UV, tangent, vertex color), skinning data (JOINTS_0 / WEIGHTS_0), skeleton hierarchy, inverse bind matrices, all `SkeletonAnimClip` keyframes, and blend shape morph targets into a GLB binary blob. Sync, CPU-only — no GPU readback. API: `sm.exportSceneGltf3D()` → `{ blob, meshCount, skeletonCount, animationCount, vertexCount }`. See `docs/specs/gltf-export.md` and `docs/reference/15-3d-rendering-system.md` § GLTF 2.0 / GLB Export.

---

### ✅ Viewport Interaction Shortcuts — Completed June 2026

Blender-style G/R/S keyboard transforms shipped. Salsa exposes a pure state-machine API (`beginTransform3D`, `constrainAxis3D`, `appendNumericInput`, `commitTransform3D`, `cancelTransform3D`); Frogmarks drives it from its existing `@HostListener('document:keydown')`. The pre-existing `window.addEventListener('keydown')` in `TransformController3D` was removed. Pre-transform snapshot captured at `beginTransform3D` enables clean cancel in both shortcut-active and mid-drag-gizmo cases. See `docs/specs/viewport-shortcuts.md`.

---

### ✅ Viewport Snapping — Completed June 2026

`snapMode3D` (`'none' | 'grid' | 'vertex'`) controls Ctrl+drag snap behavior. Vertex snap: O(V) screen-space scan (20 px threshold), centroid-based for multi-selection, overrides axis constraints. `getSnapTarget3D()` returns the active vertex world position for Frogmarks to draw an indicator dot; `worldToScreen3D(pt)` converts it (and `gizmoCenterWorld` from drag info) to canvas pixels. Surface snap deferred. See `docs/specs/viewport-snapping.md`.
