# Salsa Renderer — Evaluation (April 27, 2026)

**Evaluator:** Claude Sonnet 4.6
**Scope:** 3D rendering system (Phases 3–4b), raster brush engine audit, MVP readiness assessment
**Prior evaluation:** [April 12, 2026](evaluation-4-12-2026.md)

---

## Overall Verdict

The 3D system has matured from a bare-bones mesh renderer into a credible PS1-aesthetic engine with shadows, picking, gizmos, keyframe animation, frustum culling, undo, normal maps, and an outliner API. For the stated retro/low-poly use-case, it is feature-complete at MVP. The raster brush engine was audited this session and is substantially more capable than expected — parametric + image tips, dual textures, canvas grain, 5 stabilization methods, pressure/velocity curves — roughly 70–80% of Procreate parity. The remaining gaps (bristle physics, pigment pickup) are polish, not blockers.

The most significant new issues introduced since April 12 are a bounded GPU memory leak in the undo system and two redundant constants tracking the same value. The architecture is otherwise clean.

---

## Critical Issues

### 1. Deleted-mesh GPU buffers live for up to 50 undo steps

When `deleteMesh()` pushes an undo command, the closure keeps the `Mesh3D` object (and its GPU vertex/index buffers referenced in `meshBuffers`) alive until the undo entry is evicted at the 50-command limit. For large meshes this is a deliberate tradeoff, but there is no documentation of it and no size cap. A user who rapidly creates and deletes high-poly meshes could accumulate ~50× the peak mesh memory.

**Severity:** Moderate-Critical
**Impact:** GPU memory growth in edit-heavy sessions
**Recommendation:** Either (a) destroy GPU buffers on delete and rebuild on undo-redo (re-upload), or (b) log a warning and document the tradeoff. Option (a) is safer; option (b) is acceptable for MVP where meshes are small.

### 2. `computeTangents()` auto-detection is heuristic and silently upgrades geometry

`Mesh3D.setGeometry()` detects legacy 8-float geometry via:
```typescript
const needs = geom.vertices.length % FLOATS_PER_VERT !== 0 && geom.vertices.length % 8 === 0;
```
This is fragile — any 12-float geometry whose length happens to also be divisible by 8 (i.e., vertex count is a multiple of 3) would be misidentified as 8-float and have `computeTangents()` applied incorrectly, corrupting position/normal data. The condition should also check `% 12 !== 0` is impossible (length divisible by 8 is always divisible by 12 when vertex count is a multiple of 3 — so this specific case is actually safe today), but the implicit contract is fragile as the stride evolves.

**Severity:** Moderate
**Impact:** Potential silent geometry corruption if vertex format ever changes again
**Recommendation:** Add an explicit `format?: '8float' | '12float'` field to `MeshGeometry` rather than inferring from array length. Throw on unrecognized format.

---

## Significant but Non-Critical

### 3. `FLOATS_PER_VERT` and `MESH3D_VERTEX_STRIDE` are redundant constants

`FLOATS_PER_VERT = 12` lives in `mesh-generators.ts` and `MESH3D_VERTEX_STRIDE = 48` lives in `pipeline-3d.ts`. They encode the same fact (`12 * 4 = 48`). If the vertex format ever changes, both must be updated in sync. Neither references the other.

**Severity:** Low
**Impact:** Maintenance risk — two-place update, easy to miss one
**Recommendation:** Define `FLOATS_PER_VERT` once (e.g., in a shared `mesh-3d-types.ts`) and derive `MESH3D_VERTEX_STRIDE = FLOATS_PER_VERT * Float32Array.BYTES_PER_ELEMENT` from it.

### 4. Normal map activation silently mutates material state

`setMeshNormalMap()` / `uploadAndApplyNormalMap()` auto-create a white 1×1 diffuse texture if the mesh has no diffuse, and set `material.hasNormalMap = true`. The caller gets no feedback that this happened. A future caller checking `mesh.material.hasTexture` will find it `true` without having set a texture — surprising.

**Severity:** Low
**Impact:** Confusing material state, potential UI inconsistency if Frogmarks renders a "no texture" badge
**Recommendation:** Return a boolean or emit a log message when the fallback diffuse is auto-created. Document the behavior in the method signature JSDoc.

### 5. Shadow shaders use `@group(1)` for shadow on the untextured path (easy to misread)

The untextured-shadow pipeline has bind group layout `[meshBGL, shadowBGL]` — shadow at group 1. The textured-shadow pipeline has `[meshBGL, textureBGL, shadowBGL]` — shadow at group 2. This is correct (WebGPU forbids gaps) but the group index for the same conceptual resource differs between the two pipelines. A developer reading the shadow shader in isolation and not the pipeline layout will assume shadow is always at group 2.

**Severity:** Low
**Impact:** Developer confusion, potential bind group binding errors when extending shadow pipelines
**Recommendation:** Add an in-code comment at the pipeline layout definition and in the shadow shader file explaining why shadow occupies group 1 vs 2 depending on path.

---

## Possible Improvements (Not Flaws)

### 6. Raster brush color mixing is schema-stubbed but not GPU-wired

`BrushPreset` has `colorMixing` and `colorStretch` fields. The GPU compute shader in `brush-stamp-pipeline.ts` does not read them. This means any preset that sets these fields silently has no effect.

**Recommendation:** Either implement pigment pickup in the shader (sample existing canvas color under dab, blend with brush color) or remove the fields from the schema to avoid false expectations. For MVP, removal is the safer choice.

### 7. Raster undo memory cap should match the 3D undo cap

`RasterSnapshotManager` uses 50 full-frame CPU copies (up to ~800MB for large canvases — noted in the April 12 evaluation). `UndoManager3D` also uses 50 closure-based commands. These caps are not synchronized. For a mixed-media session the user could hit 100 undo steps total — 50 in each stack — with no unified history. Consider a shared undo budget or a unified undo stack that interleaves 2D and 3D operations.

### 8. `getScene3DHierarchy()` returns a snapshot, not a live view

The outliner API returns a fresh `Scene3DHierarchyNode[]` array on each call by traversing the scene graph. Fine for now, but if Frogmarks calls it on every pointer event to check for hover state, it will allocate on every frame. For MVP this is fine; for a large scene with hundreds of meshes it will cause GC pressure.

**Recommendation:** Document that callers should cache the result and invalidate on scene-graph-changed events.

---

## What's Done Well

| Area | Assessment |
|------|-----------|
| **PS1 pipeline completeness** | Vertex jitter, affine warping, Gouraud shading, color quantization — all four PS1 pillars implemented and configurable |
| **Dual lighting path** | Gouraud (PS1-authentic) when no normal map; per-pixel Phong when normal map active — elegant single-shader approach with zero pipeline cost for the common case |
| **Shadow mapping** | Depth-only pre-pass in own command encoder (guarantees GPU ordering without explicit barriers), PCF 3×3, front-face cull for Peter-Pan bias, 30% ambient floor — production quality |
| **Frustum culling** | Gribb–Hartmann plane extraction with WebGPU z∈[0,1] convention correctly handled; AABB positive-vertex test is textbook correct |
| **Keyframe animation** | Clean type-safe track system; sampleTrack handles edge cases (empty, past-end clamping); raster↔3D sync is zero-boilerplate via the set3DPlaybackSync hook |
| **Undo system** | Closure-based commands are simple and correct; create/delete undo preserves live mesh objects avoiding re-upload cost |
| **Brush engine** | Parametric + image tips, dual textures, canvas grain, 5 stabilization methods, pressure/velocity/scatter curves, wet edges — a serious brush implementation |
| **Stroke texture renderer** | Alternative continuous-strip rendering path gives charcoal/crayon/marker character without dab stamping artefacts at large spacing |
| **TBN Gram-Schmidt re-orthogonalization** | Correct Mikktspace-compatible tangent computation in both the mesh generators and the vertex shader — avoids shearing artefacts on scaled meshes |
| **Texture bind group defaulting** | 1×1 flat-normal and white fallback textures prevent bind group creation failures for partially-configured meshes — robust pipeline design |

---

## 3D System — MVP Readiness Checklist

| Capability | Status |
|-----------|--------|
| Primitive mesh creation (box/sphere/plane/cylinder/torus/custom) | ✅ |
| PS1 aesthetics (jitter, affine, Gouraud, color quantization) | ✅ |
| Diffuse textures + TextureLibrary | ✅ |
| Normal maps + per-pixel Phong | ✅ |
| Directional shadows (PCF) | ✅ |
| Perspective + orthographic camera | ✅ |
| Orbit controls with damping | ✅ |
| Frustum culling | ✅ |
| Ray-triangle picking | ✅ |
| Move / rotate / scale gizmos | ✅ |
| Keyframe animation (6 track types) | ✅ |
| Raster timeline sync | ✅ |
| Mesh groups | ✅ |
| Outliner API (visibility, rename, hierarchy) | ✅ |
| Undo / redo (transform + create + delete) | ✅ |
| Scene save / restore | ✅ |
| Skeletal animation | ⛔ Deferred — PS1 aesthetic doesn't require it |
| IBL / environment lighting | ⛔ Deferred |
| GPU picking | ⛔ Deferred — CPU ray-cast is sufficient for retro scene complexity |

## Raster Brush — MVP Readiness Checklist

| Capability | Status |
|-----------|--------|
| Parametric tips (hardness, roundness) | ✅ |
| Custom image tips (PNG alpha mask) | ✅ |
| Pressure curves (size, opacity, flow, rotation, scatter) | ✅ |
| Velocity-based size curve | ✅ |
| Random jitter (size, rotation, scatter, color) | ✅ |
| Dual brush textures | ✅ |
| Canvas grain / paper texture | ✅ |
| Stroke texture renderer (continuous strip) | ✅ |
| Stabilization (5 methods) | ✅ |
| Wet edges | ✅ |
| 7 blend modes (paint, erase variants, multiply, screen, overlay) | ✅ |
| Serializable presets | ✅ |
| Color mixing / pigment pickup | ❌ Schema stub only — not GPU-wired |
| Bristle / fiber physics | ❌ Not implemented |
| Velocity curves for opacity/flow | ❌ Size only |

---

## Summary

The April 12 evaluation flagged organizational issues (renderer-owns-interaction, legacy dead code, uniform layout duplication). Those remain open but unchanged — this session's work was entirely additive. The new issues introduced are bounded and low-severity: a documented memory tradeoff in the undo system, two redundant stride constants, and a silent material state mutation on normal map assignment.

Salsa is at MVP for its stated goals. The primary remaining gap for full Procreate-style brush parity is pigment pickup and bristle physics — both are polish, not blockers. The 3D engine covers everything needed for PS1-aesthetic scene composition and basic keyframe animation.

---

## Changes This Session

| Change | File(s) |
|--------|---------|
| Vertex format: 32 B → 48 B, added tangent vec4 | `pipeline-3d.ts`, `mesh-generators.ts` |
| `computeTangents()` utility for legacy 8-float geometry | `mesh-generators.ts` |
| Dual lighting path: Gouraud (default) + per-pixel Phong (normal map) | `mesh3d-shaders.ts` |
| 4-binding textureBGL (diffuse + normal map slots) | `pipeline-3d.ts` |
| Default placeholder textures (white 1×1, flat-normal 1×1) | `renderer-3d.ts` |
| `hasNormalMap` material flag (bit 1 of emissiveColor.a) | `material-3d.ts` |
| Normal map fields on Mesh3D (`normalMapTexture`, `normalMapLibraryId`) | `mesh-3d.ts` |
| Undo for mesh/group create and delete operations | `scene3d-manager.ts` |
| `deleteMeshGroup()` with child promotion to root | `scene3d-manager.ts` |
| Outliner APIs: visibility, rename, `getScene3DHierarchy()` | `scene3d-manager.ts` |
| Normal map APIs: `setMeshNormalMap`, `clearMeshNormalMap`, `uploadAndApplyNormalMap` | `scene3d-manager.ts` |
| Top-level delegation of all new APIs | `shape-manager.ts` |
| Documentation updated for vertex format, material flags, normal map system, outliner APIs | `documentation/15-3d-rendering-system.md`, `documentation/11-services-managers.md` |
