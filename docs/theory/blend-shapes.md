# Blend Shapes (Morph Targets)
**Last Updated:** 2026-06-07

---

## Intuition

A blend shape stores the *difference* between a base mesh and a sculpted variant. You give it a weight from 0 to 1 and interpolate: at weight 0 you see the base mesh; at weight 1 you see the fully-displaced variant; at 0.5 you see halfway between. Because the blend is linear and the result is a plain vertex buffer, it composes with skeletal animation for free — the vertex shader just sees already-deformed positions.

---

## Mental Model

Imagine a face mesh with 5000 vertices. For a "smile" shape, every vertex that moves during a smile has a tiny arrow showing how far and in which direction it should travel. Vertices at the back of the head might have arrows of length zero (they don't move). At weight 0.7, each vertex travels 70% of the way along its arrow. Nothing about topology changes — indices, UVs, and joint weights stay identical.

You can have 30 shapes active simultaneously. The total displacement at any vertex is the sum of all individual contributions:

```
final_position = base_position + Σ(weight[i] × delta[i])
```

For normals, the same additive rule applies to the delta:

```
final_normal = normalize(base_normal + Σ(weight[i] × deltaNormal[i]))
```

---

## Formal Explanation

A blend shape (GLTF calls them *morph targets*) is a set of per-vertex position offsets `Δp[v]` and optionally normal offsets `Δn[v]` for every vertex `v` in the mesh. The mesh stores a *base* pose (bind pose), and evaluation produces the final vertex array:

```
p[v] = p_base[v] + Σ_i( w_i × Δp_i[v] )
n[v] = normalize( n_base[v] + Σ_i( w_i × Δn_i[v] ) )
```

where `w_i ∈ [0, 1]` and `i` ranges over all attached shapes.

UV coordinates and tangents are not typically morphed (UVs are topology-level, tangents are derived from positions+UVs). Salsa stores 6 floats per vertex per shape: `(dX, dY, dZ, dNX, dNY, dNZ)`.

### Interaction with Skeletal Animation

Blend evaluation happens *before* skinning:

```
1. blend: final_base = base + Σ(weight × delta)   ← CPU, updates vertex buffer
2. skin:  final_world = skinMatrix × final_base     ← GPU, vertex shader
```

This is the correct and standard ordering — a character's face shape is defined in bind pose space (before any bone moves it). The skeleton then moves the already-blended face. Salsa implements step 1 on the CPU when `setBlendWeight3D` is called, then marks `skinDirty = true` so the skinned vertex buffer is rebuilt from the new base geometry before the next draw.

### World-Space Transform and GLTF Deltas

GLTF morph target deltas are in the primitive's *local* object space. Salsa bakes the GLTF node's world transform into geometry vertex positions on import (via `bakeWorldTransform`). Therefore the same world-matrix rotation+scale must be applied to the position deltas — without the translation component, since deltas are differences, not absolute positions.

For normal deltas, the inverse-transpose of the 3×3 rotation+scale sub-matrix is applied (same rule as transforming regular normals, but without renormalization — the result is added to the base normal and the sum is normalized per-pixel in the shader).

---

## Why It Matters

Without blend shapes:
- Facial animation is impossible with skeletal rigs alone. A jaw bone can open a mouth; it cannot change a smile to a frown without deforming the jaw shape itself.
- Lip sync and eye blink are table-stakes for character animation in every major DCC tool.

With blend shapes:
- Characters can express emotion by blending shapes (sad, angry, surprised, O-phoneme, etc.)
- A single skeleton drives the body; blend shapes drive the face independently.
- GLTF files from VRoid, Blender, Character Creator, etc. come with pre-built morph targets — Salsa can play them back immediately on import.

---

## Where the Mental Model Breaks

**Weights > 1 or < 0 are valid but extrapolate.** A weight of 1.3 pushes past the sculpted position; −0.5 moves in the opposite direction. Some rigs use negative weights for directional shapes (eye look left / look right). Salsa clamps weights to [0, 1] at the API level. If you need bidirectional shapes, model them as two separate shapes (one per direction) and blend them.

**Additive composition creates artefacts at high combined weights.** If two shapes both move the upper lip by 5 mm, activating both at weight 1.0 moves it 10 mm — which may exit the mesh entirely. This is expected and the animator's responsibility to control via mutual exclusion or partial weights.

**Delta normals do not renormalize during blending.** The CPU evaluation adds normal deltas directly. The vertex shader (or CPU for non-GPU paths) normalizes the final normal. Intermediate un-normalized normals can cause flickering if inspected mid-pipeline — this is cosmetic and resolves at the normalize step.

**Blend shapes do not scale with the mesh.** If a mesh's `scaleX` is 2, the model matrix doubles positions in the vertex shader — but `baseVertices` and `deltaVertices` are stored in world-baked space at import scale. Changing scale after import does not invalidate blend shapes; the deltas are already at the right world scale.

---

## Common Confusions

**"Blend shapes change topology."** No. Indices, UVs, and vertex count are fixed. Only positions and normals shift. You cannot add or remove vertices with a blend shape.

**"I need to call evaluateBlendShapes every frame."** No. Evaluation runs only when `setBlendWeight3D` is called. The result persists in `_geometry.vertices` and the GPU buffer until the weight changes. Idle shapes cost nothing per frame.

**"Blend shapes and modifiers conflict."** They operate at different stages. `_geometry.vertices` is the source fed to the modifier stack. `evaluateBlendShapes()` writes to `_geometry.vertices` and nulls the `_modifiedGeom` cache, so the modifier stack re-evaluates from the blended geometry on the next geometry access. The modifier output is what the GPU pool sees.

**"GLTF morph weights in the file are applied automatically."** Salsa imports morph targets but initializes all weights to 0. Playback of the GLTF's initial weight values from `mesh.weights[]` in the JSON is not yet wired.

---

## How Salsa Uses It

| Component | Role |
|-----------|------|
| `BlendShape` (mesh-3d.ts) | Interface: `{ name, deltaVertices: Float32Array }` — 6 floats/vert |
| `Mesh3D.blendShapes[]` | Array of all attached shapes |
| `Mesh3D.blendWeights` | Parallel Float32Array of weights |
| `Mesh3D.baseVertices` | Snapshot of `_geometry.vertices` before first blend; base for evaluation |
| `Mesh3D.evaluateBlendShapes()` | CPU evaluation: restore base, apply weighted deltas, set `gpuDirty` |
| `GltfImporter.buildPrimitive()` | Parses `prim.targets[]` + `mesh.extras.targetNames` into `BlendShape[]` |
| `bakeWorldTransformDeltas()` | Applies rotation+scale world transform to GLTF position/normal deltas |
| `Scene3DManager._applyMorphTargets()` | Attaches imported morph targets and snapshots `baseVertices` |
| `Scene3DManager.setBlendWeight3D()` | Public: sets weight, calls `evaluateBlendShapes`, marks `skinDirty` for skinned meshes |
| `restoreMeshState()` | Deserializes `blendShapes[]` + `blendWeights` + `baseVertices` from saved state |

**Evaluation order for skinned meshes:**
```
setBlendWeight3D(meshId, idx, w)
  → mesh.blendWeights[idx] = w
  → mesh.evaluateBlendShapes()           ← writes mesh._geometry.vertices
     → mesh.gpuDirty = true
  → mesh.skinDirty = true
  → scheduleRender()

  Next frame: renderer._ensureSkinnedVBIB(mesh)
    → reads mesh.geometry.vertices        ← blended positions
    → builds 72-byte skinned VB           ← skinning data attached
    → writes to GPU
  → _ensureSkinMatBuf(mesh)              ← uploads bone matrices
  → drawIndexed(...)                     ← GPU applies LBS on top
```

---

## Related Concepts

- [skeletal-animation.md](skeletal-animation.md) — LBS skinning that runs after blend evaluation
- [coordinate-spaces.md](coordinate-spaces.md) — Why deltas need the world-bake transform applied
- [half-edge-meshes.md](half-edge-meshes.md) — Topology that blend shapes cannot change
- [gpu-pipelines.md](gpu-pipelines.md) — How `gpuDirty` / `skinDirty` drive GPU buffer rebuilds
