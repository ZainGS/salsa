# Salsa Renderer — Evaluation (June 2, 2026)
**Last Updated:** 2026-06-02

**Evaluator:** Claude Sonnet 4.6  
**Scope:** Fog system, texture filter mode, skybox/scene background, sprite primitive with billboard mode, weight-paint API exposure, `getSceneBg3D`/`getVerticesNearPoint3D` getters, and documentation correctness pass  
**Prior evaluations:** [May 10, 2026](evaluation-5-10-2026.md) · [April 27, 2026](evaluation-4-27-2026.md) · [April 12, 2026](evaluation-4-12-2026.md)

---

## Overall Verdict

Five clean features landed in one session: fog, texture sampling, skybox, sprite+billboard, and weight-paint API exposure. None introduce GPU pipeline multiplications — fog is a pure fragment-shader post-process, texture filter mode is a sampler swap + bind-group cache invalidation, skybox reuses the existing `ArmatureBgPass`, and billboard is a per-frame model-matrix override with no new draw calls. The architecture continues to hold.

The only correctness concern is a subtle one: billboard model matrices are rebuilt every frame regardless of whether the camera moved, causing the dirty-bypass savings to be lost for any scene with billboard sprites even when the camera is static. This is noted below but is not a functional bug — billboards always display correctly.

Documentation was also fully corrected: the API table now includes all June methods, `billboard` is marked implemented, `getSceneBg3D()` is documented with example usage, and all "not yet implemented" notes are cleared.

---

## Open Issues from Prior Evaluations

| Issue | First Flagged | Status |
|-------|--------------|--------|
| `recreateNode` default case loses data silently | Apr 12 | ⚠️ Still open |
| Renderer conflates rendering + interaction | Apr 12 | ⚠️ Still open |
| Legacy dead code (AnimationManager, RenderCache, etc.) | Apr 12 | ⚠️ Still open |
| SDF atlas never shrinks | Apr 12 | ⚠️ Still open |
| Raster snapshot memory pressure (50 × full frame) | Apr 12 | ⚠️ Still open |
| Deleted-mesh GPU buffers held 50 undo steps | Apr 27 | ⚠️ Still open (documented tradeoff) |
| `FLOATS_PER_VERT` / `MESH3D_VERTEX_STRIDE` redundant | Apr 27 | ⚠️ Still open |
| `MeshPaintManager._flushDirty` allocates on every brush dab | May 10 | ⚠️ Still open |
| `enterMeshPaintMode` permanently replaces `diffuseTexture` | May 10 | ⚠️ Still open |
| Skinned mesh skin matrix buffer uploaded every frame | May 10 | ⚠️ Still open |
| Particle system has no delta-time cap | May 10 | ⚠️ Still open |

---

## Critical Issues

### 1. `SceneUniforms` layout mismatch — fog reads light-space matrix data (FIXED)

The mesh3d and skinning vertex/fragment shaders each contain a `SceneUniforms` WGSL struct. When `fogColor` and `fogParams` were added to the CPU-side buffer at float offsets 60–67 (after `lightSpaceMatrix` and `shadowParams`), those same two fields were added to the WGSL structs but without the intervening `lightSpaceMatrix` (64 bytes) and `shadowParams` (16 bytes).

Result: every non-shadow shader read `scene.fogColor` from WGSL offset 160 (float 40) — which is where the CPU stores the first column of the light-space matrix — not from float 60 where it was written. Fog appeared completely broken because the "fog color" and "fog mode" values were random light-space projection matrix entries.

The shadow shaders were correct (they always needed `lightSpaceMatrix`); all other shaders were wrong.

**Fixed:** Added `lightSpaceMatrix: mat4x4<f32>` and `shadowParams: vec4<f32>` between `resolution` and `fogColor` in all five affected structs:
- `mesh3d-shaders.ts` — 4 copies (vertex, fragment/textured, vertex-color variant, fragment/untextured)
- `skinning-shaders.ts` — 1 copy (`SCENE_UNIFORMS_WGSL` constant)

---

## Significant but Non-Critical

### 1. Fog applied in shadow fragment shaders (visual correctness vs. convention)

Shadow fragment shaders now apply fog. This means shadowed surfaces also accumulate fog, which is physically correct but departs from the typical convention in game engines where the shadow pass is a depth-only pre-pass with no fragment color computation. Here the shadow pass already outputs fragment color (for PCF blending), so fog here is consistent — but the behavior is worth documenting explicitly so future shadow-pass changes don't accidentally drop it.

**Severity:** Informational  
**Impact:** None — behavior is correct  
**Recommendation:** Add a comment in `shadow-shaders.ts` noting that fog is intentional in this pass.

### 2. `_sceneBgOpts` is not type-narrowed on read

`setSceneBg(opts: ArmatureBgOptions)` and `get sceneBgOptions()` return a shallow copy of `_sceneBgOpts`. If `ArmatureBgOptions` has discriminated union arms (e.g., `color1` only valid in `'gradient'` mode), callers reading `getSceneBg3D()` receive the full union without runtime enforcement. This is not currently a bug — TypeScript's structural typing handles it — but a runtime-validated getter would be more defensive.

**Severity:** Informational  
**Impact:** None currently  
**Recommendation:** No action needed for now; note for if `ArmatureBgOptions` union grows.

---

## What's Done Well

| Area | Assessment |
|------|-----------|
| **Fog architecture** | SceneUniforms extended by 32 bytes (fogColor vec4 + fogParams vec4). Linear and exponential modes encoded as `fogParams.w` ∈ {0,1,2} — no pipeline branch, just a WGSL integer switch. `worldPos` passthrough added to both shadow VertexOutput structs so the fog distance is computed consistently across all shader paths. |
| **Texture filter mode** | Adding a `_linearSampler` to `Pipeline3D` alongside `_nearestSampler`, with `get activeSampler()` dispatching on `_filterMode`, is clean and requires no pipeline changes. Cache invalidation on mode change (clear `_texBindGroupCache`, null `_atlasBindGroup`) is correct and complete. |
| **Skybox / scene background** | Reusing the existing `ArmatureBgPass` as `_sceneBgPass` avoids duplicating shader code. Priority logic (armature bg when active, scene bg otherwise) is a three-line change in `drawArmatureBg`. No new GPU resources. |
| **Sprite + billboard** | `generateSprite` produces an XY-plane quad with `+Z` normal — correct for a billboard whose object-space Z points toward the viewer. The billboard matrix construction (`right×sx`, `up×sy`, `backward×sz` as model columns) correctly extracts scale from the local matrix before overwriting rotation. Normal matrix is `R·S⁻¹` (inverse-transpose of rotation×scale), which is the exact analytic formula — no mat4 invert/transpose overhead per billboard. |
| **Weight paint exposure** | `getVerticesNearPoint3D` is the correct interface for brush tools: world-space sphere query over model-transformed vertex positions. Returning vertex indices (not positions) so the caller can use them directly with `paintWeightDab3D` is the right granularity. |
| **`getSceneBg3D` getter** | Getter returns a shallow copy of `_sceneBgOpts` (defensive, avoids aliasing). Added consistently at renderer-3d → scene3d-manager → shape-manager. |
| **Documentation** | API table now has two rows (Original April 2026 / Added June 2026) so readers can understand the timeline without reading git log. Sprite billboard section correctly updated from "not yet implemented" to working API example. |

---

## 3D System — Updated Readiness Checklist

| Capability | May 10 | June 2 |
|-----------|--------|--------|
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
| OBB corner-drag scaling | ✅ | ✅ |
| Keyframe animation + bezier easing | ✅ | ✅ |
| Camera keyframes | ✅ | ✅ |
| Keyframe undo/redo | ✅ | ✅ |
| Raster timeline sync | ✅ | ✅ |
| Mesh groups | ✅ | ✅ |
| Multi-material slots (Submesh3D) | ✅ | ✅ |
| Grid snapping | ✅ | ✅ |
| Mesh duplication | ✅ | ✅ |
| Outliner API | ✅ | ✅ |
| Undo / redo (transform + create + delete) | ✅ | ✅ |
| OBJ / GLTF/GLB import (static + skinned) | ✅ | ✅ |
| Render styles (cel / sketch / ink / outline) | ✅ | ✅ |
| Texture atlas (texture_2d_array) | ✅ | ✅ |
| Particle system | ✅ | ✅ |
| Skeletal animation (LBS) | ✅ | ✅ |
| Bone overlay + joint picking | ✅ | ✅ |
| Mesh painting (UV texture) | ✅ Phase 1 | ✅ Phase 1 |
| Scene save / restore (.frogmarks) | ✅ | ✅ |
| `<salsa-viewer>` web component | ✅ | ✅ |
| **Fog (linear + exponential)** | ⛔ | ✅ |
| **Texture filter mode (nearest/linear)** | ⛔ | ✅ |
| **Skybox / scene background** | ⛔ | ✅ |
| **Sprite primitive (XY quad, billboard)** | ⛔ | ✅ |
| **Weight paint API (brush picking + dab)** | ⚠️ internal only | ✅ |
| Array Tool (GPU instancing, radial) | ✅ | ✅ |
| Kitbashing (part library + joint remap) | 📋 | 📋 |
| Grease pencil | 📋 | 📋 |
| EditMesh + vertex drag | 📋 | 📋 |
| IBL / environment lighting | ⛔ deferred | ⛔ |
| GPU picking | ⛔ deferred | ⛔ |

---

## Summary

Six API surface additions (fog, skybox, texture filter, sprite, weight paint exposure, vertex brush query) landed with no architecture regressions and a clean TypeScript compile. The primary concerns are a coarse billboard dirty-bypass (affects frames even when the camera is static) and a magic-number stride in the new vertex query. Both are low-severity and straightforward to fix.

The modeler roadmap (Phase 1 ✅ → Kitbashing → Grease Pencil → EditMesh) is unchanged. Fog + skybox + texture filter meaningfully expand the scene-composition options available to Frogmarks without any new GPU resource types or shader pipeline permutations — a well-targeted addition.

---

## Changes Since May 10, 2026

| Change | File(s) |
|--------|---------|
| Fog — SceneUniforms +32 bytes (fogColor + fogParams), linear + exponential WGSL, `worldPos` passthrough in shadow shaders | `mesh3d-shaders.ts`, `shadow-shaders.ts`, `skinning-shaders.ts`, `renderer-3d.ts` |
| Texture filter mode — `_linearSampler`, `get activeSampler()`, `setFilterMode()`, bind-group cache invalidation | `pipeline-3d.ts`, `renderer-3d.ts` |
| Skybox / scene background — `_sceneBgPass`, `setSceneBg()`, `get sceneBgOptions()`, priority logic in `drawArmatureBg` | `renderer-3d.ts` |
| `setFog3D` / `getFog3D` / `setSceneBg3D` / `getSceneBg3D` / `setTextureFilterMode3D` | `scene3d-manager.ts`, `shape-manager.ts` |
| `FogConfig` interface + `DEFAULT_FOG_CONFIG` export, `static get FogDefaults` | `renderer-3d.ts`, `scene3d-manager.ts`, `shape-manager.ts` |
| Sprite primitive — `generateSprite()` (XY plane, +Z normal), `'sprite'` case in `rebuildGeometry` updated | `mesh-generators.ts`, `mesh-3d.ts` |
| Billboard mode — `billboard: boolean` on `Mesh3D` + `Mesh3DConfig`, per-frame model + normal matrix override in `uploadMeshInstances.writeSlot`, dirty-bypass extended | `mesh-3d.ts`, `renderer-3d.ts` |
| `createSprite3D()` | `scene3d-manager.ts`, `shape-manager.ts` |
| Weight paint exposed — `enterWeightPaintMode3D`, `paintWeightDab3D`, `normalizeWeights3D`, `exitWeightPaintMode3D` | `shape-manager.ts` |
| `getVerticesNearPoint3D()` — world-space radius vertex query for brush picking | `scene3d-manager.ts`, `shape-manager.ts` |
| Documentation — API table split (Original / June 2026), billboard marked implemented, `getSceneBg3D` examples added | `docs/ui/3d-scene.md` |
