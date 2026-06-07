# Skeletal Animation & Skinning
**Last Updated:** 2026-06-06

---

## Intuition

A skeleton is not geometry — it is a coordinate frame hierarchy. Each bone defines a local space. When a bone rotates, everything expressed in that local space rotates with it. Skinning is the process of blending vertex positions across multiple bones so that skin stretches and deforms naturally instead of snapping rigidly with a single bone.

The fundamental contract: every vertex stores a small list of bones that influence it and how much each one pulls. When the skeleton poses, each influencing bone "votes" on where the vertex should land, and the vertex lands at the weighted average of those votes.

---

## Mental Model

### The bind pose problem

Imagine you sculpt a character standing in a T-pose. You then attach a skeleton and animate it. The bones are now in a different position (elbows bent, arm raised). The question the GPU must answer every frame is: **given that bone #3 is now at this world position and rotation, where should vertex 142 go?**

The naïve answer — "put the vertex at the bone's current position" — is wrong. The vertex isn't at the bone's origin; it's offset from it in a specific way that was established when the skeleton was first attached.

The correct answer requires two pieces:
1. **Where was the vertex relative to this bone when the weights were painted?** (bind pose)
2. **Where is that same bone-relative position in the current world?** (current pose)

The bind pose is the reference frame. Every vertex position in the mesh is implicitly stored as "where it was when the skeleton was first bound."

### Inverse bind matrices

The inverse bind matrix for bone `i` answers the first question: it transforms a vertex from world space at bind time *into* bone `i`'s local coordinate space. Multiplying by the inverse bind matrix says "pretend we're at bind time; what is this vertex's position relative to bone `i`?"

```
invBind_i = inverse(bone_i.worldMatrix at bind time)
vertexInBoneSpace = invBind_i × vertexWorldPositionAtBindTime
```

This transform is computed once and cached. It never changes unless you re-bind.

### Skin matrices

The skin matrix for bone `i` is the full round-trip:

```
skinMatrix_i = bone_i.currentWorldMatrix × invBind_i
```

Reading right to left: take the vertex from world space at bind time → into bone-local space → back out to world space at the current pose. The result is where the vertex would land if it were rigidly attached to bone `i` alone.

### Vertex blending

Most vertices are influenced by more than one bone — the forearm blend between upper arm and hand bones, for example. Blending is a weighted sum:

```
finalPosition = Σ ( weight_i × skinMatrix_i × bindPosition )
```

Weights sum to 1. If `weight_0 = 0.8` for the upper arm and `weight_1 = 0.2` for the lower arm, the vertex mostly follows the upper arm but bends slightly with the lower arm. This produces the smooth "squash" at joints instead of a sharp fold.

```
               weight_0 = 1.0 (rigid, attached to bone 0)
bone 0 ────────●────────────●────────── bone 1
                             weight_0 = 0.5, weight_1 = 0.5 (blend zone)
                                          ●────────── bone 1
                                         weight_1 = 1.0 (rigid, attached to bone 1)
```

---

## Formal Explanation

### Data layout

Each vertex stores up to 4 joint indices and 4 corresponding weights:

```
vertex v:
  jointIndices[4]  ← indices into the joint array
  jointWeights[4]  ← weights, sum must equal 1.0
```

Limiting to 4 joints per vertex is a GPU convention — 4 floats fit neatly in a `vec4`. Vertices with fewer real influences pad with index 0 and weight 0.

### Skin matrix upload

Every frame (or whenever the skeleton is re-posed), the renderer computes N skin matrices (one per joint) and uploads them to a GPU storage buffer:

```
for i in 0..N_joints:
    skinMatrices[i] = joint[i].worldMatrix × invBindMatrices[i]
```

The vertex shader reads from this buffer by joint index.

### Vertex shader

```wgsl
// Simplified: blend up to 4 influences
fn skinVertex(pos: vec4f, indices: vec4u, weights: vec4f) -> vec4f {
    var result = vec4f(0.0);
    result += weights.x * skinMatrices[indices.x] * pos;
    result += weights.y * skinMatrices[indices.y] * pos;
    result += weights.z * skinMatrices[indices.z] * pos;
    result += weights.w * skinMatrices[indices.w] * pos;
    return result;
}
```

Normals and tangents need the same treatment, but using the inverse-transpose of the rotation part (translation doesn't affect direction vectors).

### Auto-weighting by distance

When binding a mesh to a skeleton for the first time, weights can be estimated automatically. The simplest method: for each vertex, find the 4 nearest bones by world-space distance, compute weights as `1/d²`, and normalize so they sum to 1:

```
raw_weight_i = 1 / max(distance(vertex, bone_i), ε)²
weight_i = raw_weight_i / Σ raw_weight_j
```

This gives smooth falloff that keeps vertices near a bone primarily influenced by that bone.

---

## Why It Matters

**Character animation becomes separable.** The skeleton drives poses; the mesh responds automatically. An animator works with bones, not vertices. The same skeleton can drive multiple meshes (body, clothing, accessories) by binding each one independently.

**GPU efficiency.** Skinning runs entirely in the vertex shader. No CPU geometry rebuilding per frame. The skin matrix buffer is small (N joints × 64 bytes per matrix) and changes only when the skeleton poses.

**Procedural animation.** Because skin matrices are computed from bone transforms, anything that drives bone transforms — keyframe animation, IK, physics ragdolls, procedural scripts — automatically drives the mesh. The skinning layer is unaware of what upstream process changed the bones.

---

## Where the Mental Model Breaks

**"The vertex is attached to the bone."**
Before blending, this is true — each `skinMatrix_i × bindPosition` is the vertex rigidly attached to bone `i`. But after blending, the vertex is NOT at any bone's position. It is at a weighted average of N such positions. At a joint's center of rotation, with equal weights on two bones, the vertex traces an arc through the interior of the mesh as the bones rotate. This produces volume loss ("candy wrapper twist") at extreme rotations — a known artifact of linear blend skinning.

**"Inverse bind matrices are always identity."**
Only if all bones are at the world origin in bind pose. In practice bones are scattered throughout the scene; their inverse bind matrices encode complex offsets. A common bug: recomputing inverseBindMatrices after the animator has already moved the skeleton away from bind pose. The resulting matrices are wrong and the mesh explodes.

**"Skin matrices only need rotation."**
The skin matrix is a full 4×4 — it includes translation. The inverse bind matrix captures the bone's translation at bind time, and the bone's current world matrix includes its current translation. Translation is essential: a bone that moves 5 units still needs to drag its influenced vertices.

**"Normals transform the same way as positions."**
Normals are direction vectors, not position vectors. They transform by the inverse-transpose of the model matrix's rotation part. Using the full skin matrix on normals produces incorrect lighting at joints. The vertex shader must separately compute and apply the normal skin matrix.

---

## Common Confusions

**"I moved the skeleton before binding. Why does the mesh look exploded?"**
The inverse bind matrices were computed at bind time. If the bones moved afterward (without re-binding), the "rest pose" the GPU thinks the skeleton was in is wrong. Fix: call `computeInverseBindMatrices()` immediately after positioning the skeleton in its intended bind pose, before any animation.

**"Why do weights need to sum to 1?"**
They don't technically — the GPU shader is just a weighted sum. But non-normalized weights mean the vertex scales as it blends: a vertex with two weights of 2.0 each would end up at 4× the expected distance. Normalizing to sum-to-1 keeps the mesh in place.

**"Why only 4 influences per vertex?"**
Any number is valid. The limit of 4 is a practical GPU constraint: `vec4u`/`vec4f` fit naturally in shader registers; more influences require either larger vectors or loops. Most production meshes need no more than 2–3 meaningful influences per vertex anyway. Extra influences below ~0.05 weight barely affect the result.

**"Why is there a separate invBind for each joint when the bind pose only exists once?"**
The bind pose is the same skeleton pose for all joints, but the inverse bind for joint `i` is specifically the inverse of joint `i`'s world matrix in that pose — not a global scene-wide value. Joints at different positions have different inverse bind matrices.

---

## How Salsa Uses It

**`src/scene-graph/shapes/skinned-mesh-3d.ts`** — `SkinnedMesh3D extends Mesh3D`. Adds:
- `jointIndices: Uint8Array` — 4 per vertex, flat array
- `jointWeights: Float32Array` — 4 per vertex, flat array
- `skeletonId: string` — ID of the owning skeleton
- `skeleton: Skeleton3D` — direct reference cached at bind time

**`src/scene-graph/shapes/skeleton-3d.ts`** — stores `Joint3D[]` each with `worldMatrix`, and `inverseBindMatrices: Float32Array[]` (one per joint). `computeWorldMatrices()` recomputes the full joint chain; `computeInverseBindMatrices()` snaps the current pose as the bind reference.

**`src/services/managers/scene3d-manager.ts`** — `bindMeshToSkeleton3D`:
1. Reads vertex positions from `mesh.geometry.vertices` at float offsets 0,1,2 (stride = `FLOATS_PER_VERT = 12`)
2. Transforms each vertex to world space via `mesh.localMatrix`
3. Finds 4 nearest joints by world distance, computes `1/d²` weights, normalizes
4. Upgrades `Mesh3D` → `SkinnedMesh3D` in the scene graph, copies all fields, sets joint data
5. Calls `computeInverseBindMatrices()` on the skeleton immediately

**`src/renderer/3d/shaders/skinning-shaders.ts`** — WGSL vertex shader for `SkinnedMesh3D`. Reads skin matrices from a per-skeleton storage buffer; applies the 4-influence blend for both position and normal.

**`src/renderer/3d/renderer-3d.ts`** — `_skinnedVCBufs` / `_skinnedInstBuf` hold separate GPU buffers for skinned meshes (they can't share the regular instance buffer since skin matrix lookup is per-mesh). Skin matrices are computed CPU-side and uploaded each frame when `skeleton.matricesDirty = true`.

---

## Related Concepts

- [Euler Rotations](euler-rotations.md) — joint local rotations are Euler angles under the hood; decomposition matters when importing GLB keyframes
- [Inverse Kinematics](inverse-kinematics.md) — IK poses the skeleton; skinning converts that pose to mesh deformation
- [Scene Graphs](scene-graphs.md) — the joint hierarchy is a scene-graph subtree; `worldMatrix` is accumulated via the same parent-chain logic
- [GPU Pipelines](gpu-pipelines.md) — skinned meshes use a separate render pipeline from static meshes (different vertex layout and shader)
- [Weight Painting](weight-painting.md) — the process of assigning and editing `jointWeights` per vertex
