# Salsa — Backlog & Deferred Items
**Last Updated:** 2026-06-07

Collected outstanding work as of June 6, 2026. Items are ordered by priority within each section.

---

## Unimplemented Features (specs written, no code yet)

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

### Armature Pan Bug

**Memory file:** `memory/project_armature_pan_bug.md`  
**Symptom:** After orbiting the viewport in Armature mode, panning moves the mesh in the wrong direction. It applies displacement in world-space X/Y instead of camera-space right/up.

**Root cause:** `_applyIllustrationCamera` drives the 3D camera from the 2D pan offset using world-space X/Y. Correct for front view; wrong after any orbit.

**Previous attempt (reverted 2026-06-04):** Added `_armaturePanTracking` + camera-space delta math using cross-product fwd/right/up and `worldPerPx = 1 / (canvasH × zoom)`. Direction was correct but scale/magnitude was off. Reverted because the coordinate system unit didn't match the illustration camera's `cx/cy` formula.

**Fix requirements (isolated commit):**
1. Suppress `_applyIllustrationCamera` while `_boneOverlayExplicit` is true (prevents 2D camera fighting orbit camera)
2. Apply pan deltas in camera-right/up space — `worldPerPx` scale must match whatever `_applyIllustrationCamera` uses for its own `cx/cy` translation
3. Verify pan magnitude and zoom feel correct on entry/exit before shipping

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

**`FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` redundant constants**  
*(First flagged: April 27, 2026)*  
`FLOATS_PER_VERT = 12` in `mesh-generators.ts` and `MESH3D_VERTEX_STRIDE = 48` in `renderer-3d.ts` represent the same format (12 floats × 4 bytes = 48 bytes). They are kept in sync manually.  
**Fix:** Derive `MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * 4` at the single import site.

**Legacy dead code** *(First flagged: April 12, 2026)*  
`AnimationManager`, `RenderCache`, and several other pre-delegate classes exist in the codebase but are no longer invoked. Safe to delete once confirmed unused.

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
| Armature pan bug | ⚠️ Fix attempted, reverted |
| `recreateNode` data loss | ✅ Fixed June 2026 — warns + placeholder |
| Raster snapshot pressure | ✅ Fixed June 2026 — capped at 10 |
| SDF atlas growth | ✅ Fixed June 2026 — size-threshold compaction in `WebGPURenderer`; atlas resets to 1024 and repopulates from live shapes |
| Skin matrix upload overhead | ✅ Fixed June 2026 — dirty-flag guard before writeBuffer |
| Billboard frame-rebuild | ✅ Already had viewChanged early-return |
| Particle dt cap | ✅ Already capped at 100ms |
| MeshPaint flush alloc | ✅ Already uses reusable staging buffer |
| MeshPaint texture restore | ✅ Already has _savedDiffuse / restoreOriginalTexture |
| `FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` | 🔵 Minor cleanup |
| Legacy dead code | 🔵 Minor cleanup |
| Vector layer interleaving | 🔵 Deferred by design |
| Lo-Fi rendering (PS1/3DS) | ✅ Completed June 2026 |
| Modifier stack drag-reorder UI | 🔵 Deferred by design |

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

### Post-Processing Stack

The only post-process effect today is the screen-space ink outline. There is no bloom, color grading, depth-of-field, or vignette. Every stylized renderer ships a post-process stack; without one, Salsa scenes look flat compared to screenshots from Blender EEVEE, Marmoset, or Unity URP.

Minimum viable stack (in render order, all as fullscreen passes):

| Effect | Cost | Value |
|--------|------|-------|
| **Bloom** | Medium (2-pass Kawase blur on bright pixels) | High — makes lights and emissives feel physical |
| **Color grading** | Low (LUT texture or curves uniforms) | High — lets artists color-grade the final composite |
| **Vignette** | Very low (radial falloff in composite shader) | Medium — quick cinematic feel |
| **Depth of field** | High (CoC map + bokeh blur) | Medium — can defer to Phase 2 |
| **Chromatic aberration** | Very low | Low — stylistic only |

Architecture: chain of `GPURenderPassDescriptor` passes after the GP pass, reading from an offscreen `rgba16float` color target. Each effect reads the previous pass output and writes to a swap buffer.

API: `sm.setPostProcessing3D({ bloom?: BloomConfig, colorGrade?: ColorGradeConfig, vignette?: VignetteConfig })`

---

### ✅ Export to Standard Formats (GLTF/GLB) — Completed June 2026

`exportSceneToGlb` in `src/renderer/3d/gltf-exporter.ts` walks all `Mesh3D` and `Skeleton3D` nodes, serializes geometry (position, normal, UV, tangent, vertex color), skinning data (JOINTS_0 / WEIGHTS_0), skeleton hierarchy, inverse bind matrices, all `SkeletonAnimClip` keyframes, and blend shape morph targets into a GLB binary blob. Sync, CPU-only — no GPU readback. API: `sm.exportSceneGltf3D()` → `{ blob, meshCount, skeletonCount, animationCount, vertexCount }`. See `docs/specs/gltf-export.md` and `docs/reference/15-3d-rendering-system.md` § GLTF 2.0 / GLB Export.

---

### ✅ Viewport Interaction Shortcuts — Completed June 2026

Blender-style G/R/S keyboard transforms shipped. Salsa exposes a pure state-machine API (`beginTransform3D`, `constrainAxis3D`, `appendNumericInput`, `commitTransform3D`, `cancelTransform3D`); Frogmarks drives it from its existing `@HostListener('document:keydown')`. The pre-existing `window.addEventListener('keydown')` in `TransformController3D` was removed. Pre-transform snapshot captured at `beginTransform3D` enables clean cancel in both shortcut-active and mid-drag-gizmo cases. See `docs/specs/viewport-shortcuts.md`.

---

### ✅ Viewport Snapping — Completed June 2026

`snapMode3D` (`'none' | 'grid' | 'vertex'`) controls Ctrl+drag snap behavior. Vertex snap: O(V) screen-space scan (20 px threshold), centroid-based for multi-selection, overrides axis constraints. `getSnapTarget3D()` returns the active vertex world position for Frogmarks to draw an indicator dot; `worldToScreen3D(pt)` converts it (and `gizmoCenterWorld` from drag info) to canvas pixels. Surface snap deferred. See `docs/specs/viewport-snapping.md`.
