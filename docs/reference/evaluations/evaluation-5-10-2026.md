# Salsa Renderer — Evaluation (May 10, 2026)
**Last Updated:** 2026-05-10

**Evaluator:** Claude Sonnet 4.6  
**Scope:** Full audit of everything added since April 27 — armature engine, GLTF/OBJ import, render styles, outline pass, particle system, texture atlas, project package format, Salsa Viewer web component, brush bleed/smudge, layer operations, keyframe undo/redo, mesh painting (Phase 1), and documentation reorganization  
**Prior evaluations:** [April 27, 2026](evaluation-4-27-2026.md) · [April 12, 2026](evaluation-4-12-2026.md)

---

## Overall Verdict

This is the largest single session of feature work in the project's history. The armature engine alone (13 changes: Skeleton3D, SkinnedMesh3D, LBS skinning, GLTF skinned import, skeleton animation, bone overlay, joint picking, serialization) would be a respectable standalone project. On top of that: a complete web component viewer, GLTF/OBJ import pipeline, render styles, screen-space outline pass, particle system, texture atlas, `.frogmarks` ZIP format, brush bleed/smudge, and now mesh painting.

The architecture has held up. No fundamental design regressions. The two April 12 structural issues that remain open (renderer-owns-interaction, SDF atlas never shrinks) are still open but still non-blocking. The new issues introduced are mostly bounded hot-path concerns — one heap allocation per brush dab, a permanently-replaced diffuse texture on paint entry, and a skinning buffer uploaded every frame regardless of pose delta. None are correctness bugs.

Salsa is now substantially beyond MVP for its stated goals. The gap to Procreate-class brush parity is closing. The gap to basic Blender-style character pipeline (mesh painting ✅, kitbashing 📋, EditMesh 📋) has its first milestone done.

---

## Open Issues from Prior Evaluations

| Issue | First Flagged | Status |
|-------|--------------|--------|
| `recreateNode` default case loses data silently | Apr 12 | ⚠️ Still open |
| No pixel dimension validation on `writeTexture` | Apr 12 | ✅ Root cause fixed; defensive validation still missing |
| Renderer conflates rendering + interaction | Apr 12 | ⚠️ Still open |
| Legacy dead code (AnimationManager, RenderCache, etc.) | Apr 12 | ⚠️ Still open |
| SDF atlas never shrinks | Apr 12 | ⚠️ Still open |
| Raster snapshot memory pressure (50 × full frame) | Apr 12 | ⚠️ Still open |
| Deleted-mesh GPU buffers held 50 undo steps | Apr 27 | ⚠️ Still open (documented tradeoff) |
| `computeTangents()` auto-detection is heuristic | Apr 27 | ✅ Fixed — explicit `format: '8float' \| '12float'` field added |
| `FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` redundant | Apr 27 | ⚠️ Still open |
| Color mixing schema-stub not GPU-wired | Apr 27 | ✅ Addressed — bleed/smudge now implemented; pigment pickup deferred intentionally |

---

## Critical Issues

### 1. `MeshPaintManager._flushDirty` allocates on every brush dab

```typescript
// In _flushDirty — called on every pointermove during painting:
const region = new Uint8Array(rowBytes * h);
```

For a 1024px texture with a 32px brush, this is a `~4 KB` heap allocation and immediate GC on every mouse-move event. In a fast stroke this fires at 60+ Hz. The allocation isn't catastrophic but it creates GC pressure during the most latency-sensitive operation in the paint pipeline.

**Severity:** Moderate  
**Impact:** Jank during fast brush strokes; GC pauses at inopportune moments  
**Recommendation:** Pre-allocate a staging buffer at `enterMeshPaintMode` sized to the maximum dirty-rect area (e.g., `(brushRadius * 2 + 1)² * 4` bytes) and reuse it across dabs. Resize only if a larger brush is set.

---

### 2. `enterMeshPaintMode` permanently replaces `diffuseTexture` with no restore path

```typescript
// In MeshPaintManager.enterMeshPaintMode:
mesh.diffuseTexture = mesh.paintTexture;
```

If the mesh had an imported GLTF texture before entering paint mode, it is silently replaced. `exitMeshPaintMode` does not restore it. The user's original texture is not destroyed — it still exists in the TextureLibrary — but `mesh.diffuseTexture` now points to the paint texture indefinitely.

This is architecturally reasonable (paint-as-you-go workflow) but the behavior is undocumented and will surprise Frogmarks developers who expect exit to restore the previous state.

**Severity:** Moderate  
**Impact:** Potentially confusing UX; Frogmarks cannot toggle between "original texture" and "paint layer" without manual re-upload  
**Recommendation:** Save the original `mesh.diffuseTexture` reference on entry (`_savedDiffuse = mesh.diffuseTexture`) and expose a `restoreOriginalTexture()` method on `MeshPaintManager`. The integration guide (`docs/ui/mesh-painting.md`) already calls this out — the engine should make it ergonomic.

---

## Significant but Non-Critical

### 3. Skinned mesh skin matrix buffer uploaded every frame unconditionally

`Renderer3D.drawSkinnedMeshes` writes the entire skin matrix `Float32Array` to the GPU buffer every frame via `writeBuffer`, regardless of whether the skeleton pose has changed since the last frame. `SkinnedMesh3D` has a `skinDirty` flag but it is not consulted during the render loop.

For a skeleton at rest (no active animation clip), this is `numJoints × 16 × 4` bytes written to the GPU on every rAF — ~5 KB for a 20-joint character at 60 fps = 300 KB/s of unnecessary bandwidth per character.

**Severity:** Low  
**Impact:** Wasted GPU bandwidth for static-pose skinned meshes  
**Recommendation:** Check `mesh.skinDirty` before `writeBuffer`; skip the upload if false. Set `skinDirty = true` in `setJointRotation`/`setJointPosition` and after `applySkeletonClipAtFrame`. Clear on upload.

### 4. Particle system has no delta-time cap

The CPU particle simulator uses raw `performance.now()` deltas:
```typescript
const dt = (now - this._lastTick) / 1000;
```

If the browser tab is backgrounded and then restored, `dt` can be seconds rather than milliseconds. This causes particles to teleport (velocity × large dt) or the emitter to spawn a burst of hundreds of particles to "catch up." A simple `Math.min(dt, 0.1)` cap would bound the behavior.

**Severity:** Low  
**Impact:** Visual glitch on tab restore; may spike particle count  
**Recommendation:** `const dt = Math.min((now - this._lastTick) / 1000, 0.1);` in the tick function.

### 5. `relinkSkinnedMeshSkeletons()` is O(N×M) on restore

On project load, `relinkSkinnedMeshSkeletons()` scans all skeletons for each skinned mesh to match `mesh.skeletonId`. For typical scenes (3–5 skeletons, 20 meshes) this is trivial. For a large scene with many imported characters it could be noticeable.

**Severity:** Low  
**Impact:** Slow load times for scenes with many skeletons  
**Recommendation:** Build a `Map<skeletonId, Skeleton3D>` once before the loop. O(N+M) instead of O(N×M). Trivial fix.

### 6. `peekThumbnailFromBlob` parses the entire manifest entry, not just the thumbnail field

`SalsaViewerCore.peekThumbnailFromBlob` unpacks and JSON-parses the entire `manifest.json` (which includes the full document manifest with all layer metadata) just to read the `thumbnail` string. For large documents with many layers, this JSON is not small.

**Severity:** Low  
**Impact:** Unnecessary parse cost in the gallery/list-view thumbnail path  
**Recommendation:** The thumbnail could be stored as a separate `thumbnail.jpg` entry in the ZIP for O(1) extraction without JSON parsing, or the manifest could be split into a lightweight `meta.json` (name, thumbnail, dims) and a full `manifest.json`.

---

## Possible Improvements (Not Flaws)

### 7. Grease pencil / kitbashing still not started

The armature engine is complete (Phase A). Phases B (kitbashing) and C (grease pencil) are specified in `docs/specs/kitbash-armature-grease-pencil.md` but not started. These are the natural next steps for the character creation pipeline; deferring them leaves the armature system with no direct creative workflow beyond raw GLTF import.

### 8. Mesh painting has no UV seam blending

Brush dabs that land near UV seam boundaries will show a sharp discontinuity in the painted texture — the dab is clipped at the seam edge in UV space even though both triangles share the same surface in world space. This is a known hard problem (requires atlas padding or per-edge seam detection) and is correctly deferred for Phase 1. Worth documenting explicitly in the spec so future contributors don't attempt naive fixes.

### 9. `UndoManager3D` and raster undo stacks remain independent

Noted in the April 27 evaluation. Still open. Mixed-media sessions accumulate two separate undo histories. No action needed for MVP; flagging for roadmap.

---

## What's Done Well

| Area | Assessment |
|------|-----------|
| **Armature engine** | Textbook LBS implementation: flat joint array, GPU storage buffer, per-mesh VB with joint/weight attributes at loc 4–5, correct `computeWorldMatrices()` parent-to-child traversal. The GLTF skin import correctly handles `inverseBindMatrices` and quaternion→Euler conversion. |
| **Bone overlay rendering** | Diamond bone sticks (6v/8tri) are an efficient and clear representation. Joint spheres color-coded by state (root/regular/hover/selected) with `depthCompare: 'always'` so the overlay is never occluded — correct choice for a modeling tool. |
| **Texture atlas (texture_2d_array)** | Moving from per-mesh bind groups to a shared atlas bind group is the correct scaling strategy. The 192-byte instance stride with `textureIndex`/`normalMapIndex` per instance is clean and the atlas rebuild on TextureLibrary change is correctly gated. |
| **Render style system** | Packing `cel/sketch/ink` mode into bits 2–3 of `encodeMaterialFlags` (reusing the existing flag scheme) avoids any pipeline multiplications. The WGSL injection via template literals is elegant — one fragment shader file, four behaviors. |
| **Outline pass** | 3-stage pipeline (depth pre-pass → Sobel → composite) in a separate command encoder is the correct approach. `depth32float` pre-pass texture auto-recreated on resize is robust. The 30% ambient-floor approach for outline color blending is simple and effective. |
| **`.frogmarks` ZIP format** | Clean separation of concerns: `manifest.json` (metadata + thumbnail), `scene.json` (2D), `scene3d.json` (3D nodes + skeletons), `textures3d.json` (library), `models3d/*.glb` (raw geometry), `layers/*.bin` + `cels/*.bin` (raster). fflate streaming ZIP is the right choice for a browser context. |
| **`<salsa-viewer>` web component** | Zero Angular dependency, shadow DOM encapsulation, ResizeObserver-driven canvas resize, WebGPU fallback to thumbnail static image, loading spinner + progressive thumbnail reveal. The `peekThumbnailFromBlob` pattern is exactly right for gallery views. |
| **Brush bleed (separable blur)** | Two-pass separable box blur on the GPU compute path is `O(N)` not `O(N²)` — the architecturally correct implementation. Per-dab vs. end-of-stroke toggle is the right user-facing control. |
| **Brush smudge (async readback)** | Async GPU readback with 1-dab lag is the correct tradeoff — avoids pipeline stalls while providing realistic color pickup. The `_smudgeReadbackPending` guard prevents request storms during fast strokes. |
| **Keyframe undo/redo** | Capturing before-state for `setMeshKeyframe` (existing value or absence), `removeMeshKeyframe` (value + easing before deletion), and `clearMeshKeyframeTracks` (full deep-copy before clear) covers all three cases correctly. Closures call helper functions directly to avoid recursive undo pushes — an easy mistake avoided. |
| **MeshPicker barycentric** | Both BVH and linear-scan paths correctly expose `baryU`/`baryV`. The BVH strategy (re-run MT on the winning triangle) is the right tradeoff: one extra ray-triangle test, no changes to `MeshBVH`, no heap allocation. UV Y-flip in `MeshPaintManager` (`texY = (1 - uvV) * sz`) is correct. |
| **Documentation reorganization** | `docs/reference/`, `docs/specs/`, `docs/ui/`, `docs/migrations/` with a `README.md` index and **Last Updated** headers on all 66 files is exemplary project hygiene. A context-less contributor can orient themselves in under 5 minutes. |

---

## 3D System — Updated Readiness Checklist

| Capability | April 27 | May 10 |
|-----------|----------|--------|
| Primitive mesh creation | ✅ | ✅ |
| PS1 aesthetics | ✅ | ✅ |
| Diffuse textures + TextureLibrary | ✅ | ✅ |
| Normal maps + per-pixel Phong | ✅ | ✅ |
| Directional shadows (PCF) | ✅ | ✅ |
| Perspective + orthographic camera | ✅ | ✅ |
| Orbit controls | ✅ | ✅ |
| Frustum culling | ✅ | ✅ |
| Ray-triangle picking (with barycentric) | ✅ | ✅ |
| Move / rotate / scale gizmos | ✅ | ✅ |
| OBB corner-drag scaling | ⛔ | ✅ |
| Keyframe animation + bezier easing | ✅ | ✅ |
| Camera keyframes | ⛔ | ✅ |
| Keyframe undo/redo | ⛔ | ✅ |
| Raster timeline sync | ✅ | ✅ |
| Mesh groups | ✅ | ✅ |
| Multi-material slots (Submesh3D) | ⛔ | ✅ |
| Grid snapping | ⛔ | ✅ |
| Mesh duplication | ⛔ | ✅ |
| Outliner API (visibility, rename, hierarchy) | ✅ | ✅ |
| Undo / redo (transform + create + delete) | ✅ | ✅ |
| OBJ import | ⛔ | ✅ |
| GLTF/GLB import (static) | ⛔ | ✅ |
| GLTF/GLB import (skinned) | ⛔ | ✅ |
| Render styles (cel / sketch / ink) | ⛔ | ✅ |
| Screen-space ink outline pass | ⛔ | ✅ |
| Texture atlas (texture_2d_array) | ⛔ | ✅ |
| Particle system | ⛔ | ✅ |
| Skeletal animation (LBS) | ⛔ deferred | ✅ |
| Bone overlay + joint picking | ⛔ | ✅ |
| Mesh painting (UV texture) | ⛔ | ✅ Phase 1 |
| 3D illustration mode | ⛔ | ✅ |
| Scene save / restore (.frogmarks) | ✅ | ✅ |
| `<salsa-viewer>` web component | ⛔ | ✅ |
| Kitbashing (part library + joint remap) | ⛔ | 📋 |
| Grease pencil | ⛔ | 📋 |
| EditMesh + vertex drag | ⛔ | 📋 |
| IBL / environment lighting | ⛔ deferred | ⛔ |
| GPU picking | ⛔ deferred | ⛔ |

---

## Summary

The April 27 evaluation concluded Salsa was at MVP for PS1-aesthetic scene composition. That remains true, and the ceiling has risen substantially. The armature system enables skinned character animation. The GLTF importer handles the real-world model pipeline. Render styles, outline pass, and the particle system provide the visual language for stylized illustration. The `.frogmarks` format and `<salsa-viewer>` component close the loop from creation to sharing.

The two remaining open issues from April 12 (renderer-owns-interaction, SDF atlas never shrinks) are unchanged and remain the largest technical debt items. The new issues introduced this session are smaller in scope: a hot-path allocation in the paint pipeline, a paint texture restore gap, and a skinning upload without pose-change gating. All are straightforward to fix and do not block any current use case.

The modeler roadmap (Phase 1 ✅ → Phase B Kitbashing → Phase C Grease Pencil → Phase 2 EditMesh) is on track and well-specified.

---

## Changes Since April 27, 2026

| Change | File(s) |
|--------|---------|
| Texture atlas — `texture_2d_array`, 192-byte instance stride, `textureIndex`/`normalMapIndex` per instance | `pipeline-3d.ts`, `renderer-3d.ts` |
| Particle system — CPU simulation, billboard quad-strip shaders, `ParticleEmitter3D` node | `particle-emitter-3d.ts`, `particle-shaders.ts`, `renderer-3d.ts`, `scene3d-manager.ts` |
| OBJ importer — v/vn/vt/f parsing, fan triangulation, UV V-flip | `obj-importer.ts` |
| GLTF/GLB importer (static) — accessor reading, TRS transforms, quaternion→Euler, embedded textures | `gltf-importer.ts` |
| GLTF/GLB importer (skinned) — JOINTS_0/WEIGHTS_0/skins/inverseBindMatrices | `gltf-importer.ts` |
| Render style system — cel/sketch/ink packed into `encodeMaterialFlags` bits 2–3 | `material-3d.ts`, `style-shaders.ts`, `scene3d-manager.ts` |
| Screen-space ink outline pass — depth pre-pass → Sobel → composite | `outline-pass.ts`, `outline-shaders.ts`, `renderer-3d.ts` |
| Project package format — `.frogmarks` ZIP via fflate | `project-package.ts`, `persistence-manager.ts` |
| OPFS 3D extension — `scene3d.json` + `models3d/*.glb` per document | `document-persistence.ts`, `scene3d-manager.ts` |
| 3D illustration mode — fixed-camera sync to 2D pan/zoom | `scene3d-manager.ts` |
| OBB corner handles + scale drag | `mesh-3d.ts`, `gizmo-renderer.ts`, `transform-controller-3d.ts` |
| Screen-space rotation fix — Z-ring uses `atan2` angular delta | `transform-controller-3d.ts` |
| Bezier easing — CSS cubic-bezier + Newton's method | `keyframe-3d.ts` |
| Camera keyframes — `Camera3DKeyframeTracks` | `keyframe-3d.ts`, `scene3d-manager.ts` |
| Mesh duplication — deep copy geometry/material/transform/textures/keyframes | `scene3d-manager.ts` |
| Grid snapping — `snapGridSize`/`snapAngle`/`snapScaleStep` on Ctrl+drag | `transform-controller-3d.ts` |
| Multi-material slots — `Submesh3D[]` on `Mesh3D`, per-submesh draw calls | `mesh-3d.ts`, `renderer-3d.ts`, `scene3d-manager.ts` |
| Armature engine (Phase A) — `Skeleton3D`, `SkinnedMesh3D`, LBS skinning shaders, bone overlay, joint picking, serialization | `skeleton-3d.ts`, `skinned-mesh-3d.ts`, `skinning-shaders.ts`, `skeleton-animator.ts`, `gizmo-renderer.ts`, `scene3d-manager.ts` |
| Brush bleed — separable box blur compute shader, per-dab + end-of-stroke modes | `brush-stamp-pipeline.ts`, `brush-engine.ts`, `brush-preset.ts` |
| Brush smudge — async GPU readback, 1-dab lag color mixing | `brush-stamp-pipeline.ts`, `brush-engine.ts`, `brush-preset.ts` |
| Layer duplicate / merge-down / canvas resize / reference image | `raster-layer-manager.ts` |
| Salsa Viewer — `<salsa-viewer>` custom element, Phases 1–5 (texture lib, GLTF restore, raster layers, spinner, thumbnail) | `salsa-viewer-core.ts`, `salsa-viewer-element.ts`, `scene-deserializer.ts` |
| Keyframe undo/redo — `setMeshKeyframe`, `removeMeshKeyframe`, `clearMeshKeyframeTracks` | `scene3d-manager.ts` |
| `packProject()` auto-thumbnail — 512px JPEG captured and embedded in manifest | `shape-manager.ts`, `document-persistence.ts` |
| MeshPicker barycentric — `baryU`/`baryV` in `PickResult`, `rayTriangleUV` helper | `mesh-picker.ts` |
| Mesh painting Phase 1 — `MeshPaintManager`, paint fields on `Mesh3D`, CPU brush stamp + dirty-rect GPU upload + undo | `mesh-paint-manager.ts`, `mesh-3d.ts`, `shape-manager.ts` |
| Documentation reorganization — `docs/reference/`, `docs/specs/`, `docs/ui/`, `docs/migrations/`, `README.md`, Last Updated on all 66 files | `docs/` |
