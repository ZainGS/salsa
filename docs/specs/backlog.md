# Salsa — Backlog & Deferred Items
**Last Updated:** 2026-06-06

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
*(First flagged: April 12, 2026)*  
The SDF glyph atlas grows whenever new text is added, but never reclaims space from deleted/modified text shapes. Long sessions accumulate all glyphs ever used.  
**Fix:** Reference-count glyph slots; compact atlas on low-memory pressure.

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

## Readiness Summary

| Item | Status |
|------|--------|
| Pose Library | ⛔ Not started |
| Bone Constraints | ⛔ Not started |
| IK target keyframing | ⚠️ Partially wired |
| Armature pan bug | ⚠️ Fix attempted, reverted |
| `recreateNode` data loss | ⚠️ Open since Apr 2026 |
| Raster snapshot pressure | ⚠️ Open since Apr 2026 |
| SDF atlas growth | ⚠️ Open since Apr 2026 |
| Skin matrix upload overhead | ⚠️ Open since May 2026 |
| Billboard frame-rebuild | ⚠️ Open since Jun 2026 |
| Particle dt cap | ⚠️ Open since May 2026 |
| MeshPaint flush alloc | ⚠️ Open since May 2026 |
| MeshPaint texture restore | ⚠️ Open since May 2026 |
| `FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` | 🔵 Minor cleanup |
| Legacy dead code | 🔵 Minor cleanup |
| Vector layer interleaving | 🔵 Deferred by design |
| Modifier stack drag-reorder UI | 🔵 Deferred by design |

---

## Missing Features (not yet specced — MVP gaps vs. existing tools)

### PBR Materials (roughness + metalness)

The material system is diffuse + specular + emissive — roughly 2010-era quality. Every surface looks plasticky or matte because there is no roughness/metalness workflow and no physically-based specular distribution. Blender EEVEE has had PBR since 2018; Marmoset, Unity URP, and Three.js all ship it by default.

What's needed:
- Add `roughness: number` (0–1) and `metalness: number` (0–1) to `Material3D`
- PBR BRDF in fragment shader: Cook-Torrance specular (GGX NDF + Smith geometry + Schlick Fresnel), Lambertian diffuse weighted by `(1 - metalness)`
- Roughness map + metalness map texture slots (can reuse the existing normal-map pipeline pattern)
- Update `setMeshMaterial3D` / `getMeshMaterial3D` to expose the new fields
- API: `sm.setMeshRoughness3D(meshId, r)`, `sm.setMeshMetalness3D(meshId, m)`

---

### IBL / Environment Lighting

A single directional light makes scenes look flat regardless of how good the PBR BRDF is — there is no ambient specular, no sky contribution, no color-bleed from the environment. Illustrators rely on HDRI environment maps for mood lighting; even CSP and Sketchfab's viewer support this.

What's needed:
- Equirectangular HDRI texture upload + storage in `TextureLibrary`
- Diffuse irradiance: precompute or approximate as 9 spherical harmonics coefficients (low cost, high payoff)
- Specular IBL: prefiltered environment map (split-sum approximation) — can be low-res (128px mip chain)
- Exposure control (EV offset scalar)
- API: `sm.setEnvironmentMap3D(textureLibraryId, exposure?)`, `sm.clearEnvironmentMap3D()`

Prerequisite: PBR materials (IBL only pays off with a proper BRDF).

---

### Blend Shapes / Shape Keys

Without morph targets there is no facial animation — no blink, smile, lip sync, or any nuanced expression. Every character animation tool (Blender, VRoid, CSP, Unity) ships blend shapes as a baseline. Skeletal animation alone cannot deform facial geometry convincingly.

What's needed:
- `BlendShape` type: `{ name: string; deltaVertices: Float32Array }` (per-vertex position delta, same vertex count as base mesh)
- `Mesh3D.blendShapes: BlendShape[]` + `blendWeights: Float32Array` (0–1 per shape)
- Blend shape evaluation: `finalPos = basePos + Σ(weight[i] * delta[i])` — runs before skinning
- GPU path: store deltas in a storage buffer; evaluate in a compute pass or vertex shader variant
- GLTF import: read `KHR_draco_mesh_compression` morph targets / `mesh.primitives[].targets`
- API: `sm.addBlendShape3D(meshId, name, deltaVertices)`, `sm.setBlendWeight3D(meshId, shapeName, weight)`, `sm.getBlendShapes3D(meshId)`

---

### Non-Linear Animation (clip blending)

The current system plays one clip at a time. There is no way to blend two clips (crossfade walk→idle), layer additive animations (breathing on top of a walk), or sequence clips with timing. Blender NLA, Unity Animator, and Rive all consider this table-stakes for any animation tool.

What's needed:
- `AnimationTrack`: a named sequence of `{ clip, startFrame, weight, blendMode: 'replace'|'additive' }` entries
- Evaluator: at any given frame, sum all active track contributions (lerp for replace, add for additive)
- `AnimationPlayer3D` extension or a new `NLAPlayer3D` that evaluates tracks instead of a single clip
- Crossfade: ramp a track's weight from 0→1 over N frames while ramping the outgoing track from 1→0
- API: `sm.createAnimationTrack3D(skelId, name)`, `sm.addTrackClip3D(trackId, clipId, startFrame, weight?)`, `sm.playTrack3D(trackId)`

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

### Export to Standard Formats (GLTF/GLB)

There is no path to take a Salsa scene and open it in Blender, Unity, Unreal, or any other tool. Everything is locked to `.frogmarks`. This matters for users who want Salsa as part of a larger pipeline rather than a standalone product.

What's needed:
- GLTF 2.0 export: scene graph → `nodes`, `meshes`, `materials`, `accessors`, `bufferViews`
- Skeleton export: `skins`, `inverseBindMatrices`, joint node hierarchy
- Animation clip export: `animations` with rotation/translation/scale channels per joint
- Blend shape export: `mesh.primitives[].targets` (once blend shapes exist)
- GLB packaging: binary chunk for buffer data
- API: `sm.exportSceneGltf3D(): Promise<Blob>` (GLB)

Scope: export the 3D scene only (not raster layers). Skinned meshes with their skeleton and animation clips are the priority.

---

### Viewport Interaction Shortcuts

Power users posing characters spend most of their time repeating the same transform operations. Gizmo dragging is accurate but slow. Blender's keyboard-driven transform (`G` grab, `R` rotate, `S` scale, then `X`/`Y`/`Z` to constrain) is dramatically faster for repetitive work.

What's needed:
- Hotkey hooks on the canvas: `G` → start grab, `R` → start rotate, `S` → start scale (on selected mesh/joint)
- Axis constraint: after pressing `G`/`R`/`S`, pressing `X`, `Y`, or `Z` locks to that world axis
- Numeric input: typing a number after the hotkey sets the exact value (e.g. `R Z 45 Enter` = rotate 45° around Z)
- `Escape` or right-click cancels and restores the original transform

This is a `TransformController3D` + canvas keydown handler addition. No new GPU work.

---

### Viewport Snapping

No ability to snap a vertex to another vertex, snap object origin to grid, or snap during mesh editing. Essential for precise scene assembly and model alignment.

What's needed:
- **Vertex snap**: during gizmo drag, find the nearest vertex in any other mesh within a screen-pixel radius; snap the dragged object's origin to that world point
- **Grid snap**: already exists (`snapGridSize3D`) but not surfaced in the viewport as a visual indicator
- **Surface snap**: project the dragged object's origin onto the nearest mesh surface (useful for placing characters on terrain)
- Visual indicator: a small snap target icon at the snap point during drag

API additions: `sm.setSnapMode3D('vertex' | 'grid' | 'surface' | 'none')`, `sm.getSnapMode3D()`
