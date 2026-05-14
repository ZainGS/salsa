# Scene Graphs
**Last Updated:** 2026-05-11

---

## Intuition

Objects in a 3D scene are usually related to each other. A sword is held by a hand, which is attached to a wrist, which moves with the arm. When the arm moves, everything downstream should move with it — automatically, without needing to update every object's position individually.

A scene graph is just a tree that encodes these relationships. Each node has a *local* transform (position, rotation, scale relative to its parent). World position is derived: multiply all the local transforms from the root down to the node. Move the parent, and every descendant's world position changes automatically — because their world positions are computed from the parent's world matrix.

---

## Mental Model

Every node in the tree has two matrices: **local** and **world**.

Local matrix: "where am I, relative to my parent?"
World matrix: "where am I, relative to the scene origin?"

The relationship is simple:

```
worldMatrix(node) = worldMatrix(node.parent) × localMatrix(node)
```

At the root, `worldMatrix = localMatrix` (the root *is* the scene).

This means moving a parent node changes the world matrix of every descendant — not because you updated them, but because they recompute from the now-changed parent chain. A character's hand bone doesn't need to know the character moved; it just recomputes its world matrix from its local matrix and the torso's (now updated) world matrix.

---

## Formal Explanation

For a node N at depth d in the tree:

```
worldMatrix(N) = M_root × M_1 × M_2 × ... × M_{d-1} × M_N
```

Where each M_i is the local matrix of the ancestor at depth i. Matrix multiplication is associative but not commutative — order matters, and it's parent-before-child (left to right in the chain above).

**Constructing a local matrix from TRS (translation, rotation, scale):**

```
localMatrix = T × R × S
```

Where T is the translation matrix, R is the rotation matrix, S is the scale matrix. The order encodes semantics: scale first (grow/shrink the object in its own space), then rotate (orient in parent space), then translate (position in parent space). Different order gives different results for non-uniform scales.

**Decomposing a matrix back to TRS:** Extract scale as the length of each column vector, rotation from the normalized column vectors, translation from the last column.

---

## Why It Matters

**Hierarchical animation.** Bone skeletons are scene graphs. The spine bone is the root; rib bones are children; shoulder bones are children of rib bones; and so on. To make a character reach forward, you rotate the shoulder bone. The elbow, wrist, hand, and all the fingers move correctly because they inherit the shoulder's world matrix.

**Grouped objects.** A "folder" or group node in a 2D canvas tool works the same way: group a set of shapes, move the group, and all shapes inside maintain their relative positions. The group node has a local transform; shapes inside have local transforms relative to the group.

**Instancing.** You can express "place this mesh at position X with rotation Y" as a scene graph node with a local transform. The mesh's geometry is defined in object space; the scene graph node positions it in world space.

**Parented particles, GP strokes, cloth.** A cloth mesh parented to a character node inherits the character's world transform. When the character moves, the cloth is repositioned without any explicit update — it reads `parent.worldMatrix × localMatrix` on demand.

---

## Where the Mental Model Breaks

**Non-uniform scale corrupts normals.** If a parent node has non-uniform scale — say (2, 1, 1), stretching in X — child normals transformed by the same matrix become incorrect. A normal pointing in Y on an X-stretched surface should still point in Y after the stretch, but naive matrix multiplication would tilt it. The correct normal transform is the *inverse transpose* of the model matrix: `(M⁻¹)ᵀ`.

This is one of the most common silent rendering bugs. Salsa's 3D shaders pass a separate normal matrix uniform derived from the inverse transpose of the model matrix. If you forget this, lighting looks slightly off on non-uniformly scaled objects — and it's hard to notice unless you're looking for it.

**The world matrix is a derived value, not a source of truth.** The scene graph only stores local matrices. World matrices are computed (and optionally cached) from the hierarchy. This means:
1. If you set `node.worldMatrix = someMatrix` directly, you're wrong — it'll be overwritten on the next compute pass.
2. If you want to "detach" a node from its parent and keep it in the same world position, you must compute its world matrix *before* detaching, then set it as the new local matrix with no parent.

**Deep hierarchies accumulate floating-point error.** Each matrix multiply introduces small floating-point rounding errors. A bone chain 20 joints deep will have slightly more positional error at the fingertip than at the spine. For stylized low-poly characters this is invisible. For precise mechanical simulations it matters.

**The scene graph is not the render list.** The scene graph encodes transform hierarchy. The renderer needs a flat sorted list of visible objects grouped by pipeline/material to minimize GPU state changes. These are different structures. Salsa's renderer walks the scene graph via `sceneGraph.root.forEachDeep()` to collect renderable nodes, then sorts and batches them separately.

---

## Common Confusions

**"Setting position moves the node in world space."**
It moves it in *local* space — relative to the parent. If the parent is offset 10 units right, setting `node.position.x = 0` puts the node 10 units right in world space. To move in world space, you have to transform the target world position into the parent's local space first.

**"The root of the scene graph has no transform."**
Depends on implementation. Salsa's root node has an identity local matrix, so `worldMatrix = localMatrix = identity`. Some engines use the root to encode a global scene scale or handedness correction.

**"Matrix multiplication is commutative."**
It's not. `T × R ≠ R × T` in general. "Translate then rotate" puts you somewhere different than "rotate then translate." The convention in Salsa (and most engines) is TRS order: scale first, rotate second, translate last. This means scale is applied in the object's own unrotated frame, and translation positions the already-scaled, already-rotated object.

**"I should cache the world matrix."**
You should — but only carefully. A cached world matrix is correct only until any ancestor's local matrix changes. Caching without invalidation is worse than not caching at all. The common pattern is a `dirty` flag: mark the node and all descendants dirty when any local transform changes; recompute lazily on first access. Salsa uses `scheduleRender()` to trigger a full recompute rather than per-node dirty tracking.

---

## How Salsa Uses It

`src/scene-graph/core/scene-graph.ts` — the root node. `Node` base class (`src/scene-graph/shapes/base/node.ts`) holds `parent`, `children`, `localMatrix`, and provides `forEachDeep()` for tree traversal.

`src/scene-graph/shapes/base/shape.ts` — extends `Node` with renderable properties (fill, stroke, visibility). All 2D shapes and 3D nodes extend `Shape`.

`src/renderer/core/webgpu-renderer.ts` — traverses the scene graph at render time via `forEachDeep` to collect nodes for each render pass (2D shapes, 3D meshes, particles, GP objects). The 3D mesh renderer reads each mesh's `localMatrix` as its model matrix.

`src/scene-graph/shapes/skeleton-3d.ts` — the bone hierarchy *is* a local scene graph: joints reference their parent joint by index, and world joint matrices are computed by multiplying down the joint chain. This is a scene graph inside a scene graph — the `Skeleton3D` node itself lives in the scene graph, and its joints have their own transform hierarchy internally.

---

## Related Concepts

- [Coordinate Spaces](coordinate-spaces.md) — the model matrix that transforms from object space to world space is exactly the node's world matrix from the scene graph
- [Half-Edge Meshes](half-edge-meshes.md) — the scene graph positions meshes; the half-edge structure defines their shape; both are orthogonal
- [GPU Pipelines](gpu-pipelines.md) — the scene graph provides the per-instance transform data that goes into the instance buffer before each draw call
