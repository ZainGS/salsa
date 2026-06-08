# Spec: Blend Shapes / Shape Keys
**Last Updated:** 2026-06-07  
**Status:** Implemented (June 2026)

---

## Summary

Blend shapes (also called morph targets or shape keys) let a mesh smoothly interpolate between its base geometry and any number of sculpted variants. Each variant stores only the *delta* from the base — a compact per-vertex offset. Weights in `[0, 1]` control how much each variant contributes. Evaluation happens on the CPU before skinning, so blend shapes compose with skeletal animation without any shader changes.

---

## Data Model

### `BlendShape` interface (`mesh-3d.ts`)

```typescript
export interface BlendShape {
  name: string;
  deltaVertices: Float32Array; // 6 floats per vertex: dX dY dZ dNX dNY dNZ
}
```

Six floats per vertex: three for the position delta, three for the normal delta. Normal deltas are in the same object-space as the base normal and are summed before the normalize step.

### Fields on `Mesh3D`

| Field | Type | Description |
|-------|------|-------------|
| `blendShapes` | `BlendShape[]` | All attached shapes, in index order |
| `blendWeights` | `Float32Array` | Parallel weight per shape, all 0 by default |
| `baseVertices` | `Float32Array \| null` | Snapshot of `_geometry.vertices` taken on first `addBlendShape` call; evaluation always restores from this |

`baseVertices` is the bind pose. It is taken once and never mutated. All subsequent calls to `evaluateBlendShapes()` restore from this snapshot before applying deltas.

---

## Evaluation

`Mesh3D.evaluateBlendShapes()` runs on the CPU:

```
out = copy of baseVertices
for each shape i:
    w = blendWeights[i]
    if |w| < 1e-7: skip
    for each vertex v:
        out[v].pos  += w × delta[v].dPos
        out[v].norm += w × delta[v].dNorm   ← NOT normalized here
_geometry.vertices = out
_modifiedGeom = null    ← invalidates modifier cache
gpuDirty = true         ← triggers geometry pool rebuild next frame
```

Normalization of the final normal happens in the fragment shader (or in the CPU path for non-GPU renders).

---

## Evaluation Order with Skinning

Blend evaluation **always runs before skinning**:

```
setBlendWeight3D(meshId, idx, w)
  → mesh.blendWeights[idx] = w
  → mesh.evaluateBlendShapes()     ← writes mesh._geometry.vertices (bind-pose space)
     → mesh.gpuDirty = true
  → mesh.skinDirty = true          ← skinned VB needs rebuild
  → scheduleRender()

Next frame: renderer._ensureSkinnedVBIB(mesh)
  → reads mesh.geometry.vertices   ← blended bind-pose positions
  → builds skinned VB with joint indices/weights attached
  → writes to GPU pool
→ GPU vertex shader applies LBS on top
```

No renderer changes were needed — the existing `skinDirty` path already rebuilds the skinned vertex buffer from `mesh.geometry.vertices` whenever that buffer is dirty.

---

## GLTF Morph Target Import

### Source format

GLTF morph targets live at `mesh.primitives[i].targets[j]`, which is an accessor map:

```json
"targets": [
  { "POSITION": 42, "NORMAL": 43 },
  { "POSITION": 44 }
]
```

Shape names come from `mesh.extras.targetNames[j]`. If absent, shapes are named `shape_0`, `shape_1`, etc.

### World-transform baking

GLTF deltas are in the primitive's local object space. Salsa bakes the GLTF node's world transform into base geometry on import via `bakeWorldTransform`. The same rotation+scale (no translation) must be applied to position deltas:

```
dPos_world = R × dPos_local         ← rotation+scale part of the world matrix, no translation
dNorm_world = (R⁻ᵀ) × dNorm_local  ← inverse-transpose of the 3×3 sub-matrix
```

This is handled by `bakeWorldTransformDeltas(deltas, worldMat)` in `gltf-importer.ts`. The function applies this transformation in-place to the interleaved 6-float delta buffer.

### Import paths that wire morph targets

`_applyMorphTargets(mesh, targets)` is called from three GLTF import paths in `scene3d-manager.ts`:
- Single-mesh GLB import
- Multi-mesh GLB import  
- Skinned GLB import (via `GltfSkinnedResult` which extends `GltfMeshResult` and inherits `morphTargets`)

`_applyMorphTargets` snapshots `baseVertices` from the freshly-built geometry and attaches the shape array with all weights at 0.

---

## API

All methods are on `ShapeManager` (delegating to `Scene3DManager`):

| Method | Description |
|--------|-------------|
| `addBlendShape3D(meshId, name, delta)` | Attach a new shape; snapshots `baseVertices` if first shape. Returns shape index. |
| `setBlendWeight3D(meshId, index, weight)` | Set weight → `evaluateBlendShapes()` → mark `skinDirty` if skinned → `scheduleRender()` |
| `getBlendShapes3D(meshId)` | Returns `{ name, weight }[]` for all attached shapes |
| `removeBlendShape3D(meshId, index)` | Splice shape; rebuild `blendWeights`; re-evaluate; clear `baseVertices` if no shapes remain |

---

## Serialization

`Mesh3D.toJSON()` serializes blend shape data when shapes are present:

```json
{
  "blendShapes": [
    { "name": "smile", "deltaVerticesB64": "<base64>" },
    { "name": "blink_L", "deltaVerticesB64": "<base64>" }
  ],
  "blendWeights": [0.0, 0.0],
  "baseVerticesB64": "<base64>"
}
```

`Float32Array` data is Base64-encoded via `float32ToBase64` / `base64ToFloat32` (exported from `mesh-3d.ts`). Deserialization runs in `Scene3DManager.restoreMeshState()` via a dynamic import of those helpers.

---

## Constraints and Known Limitations

- **Weights clamped to [0, 1] at the API.** Negative or >1 weights are physically valid (extrapolation / opposite-direction shapes) but are not exposed in the public API. To model bidirectional shapes, create two separate shapes (one per direction).

- **CPU evaluation only.** Evaluation runs on the main thread. For meshes with many vertices and many active shapes, this could be a bottleneck at 60 fps. A GPU compute path (storage buffer of deltas, compute dispatch before the draw pass) is the natural upgrade but is deferred.

- **GLTF initial weights not applied.** GLTF files may include `mesh.weights[]` to specify default morph target weights. Salsa imports the shapes but initializes all weights to 0. Initial weights from the file are not yet applied on import.

- **Evaluation runs only on weight change.** `evaluateBlendShapes()` is not called every frame — only when `setBlendWeight3D` is called. Idle shapes cost nothing at runtime.

---

## Related

- `docs/theory/blend-shapes.md` — first-principles explanation
- `docs/specs/gltf-import.md` — GLTF import pipeline overview
- `src/scene-graph/shapes/mesh-3d.ts` — `BlendShape`, `evaluateBlendShapes`, `float32ToBase64`
- `src/renderer/3d/gltf-importer.ts` — `bakeWorldTransformDeltas`, morph target parsing
- `src/services/managers/scene3d-manager.ts` — `_applyMorphTargets`, `addBlendShape3D`, `setBlendWeight3D`
- `src/services/shape-manager.ts` — public API delegation
