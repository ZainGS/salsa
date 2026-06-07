# Parametric Arrays (Linked Copies)
**Last Updated:** 2026-06-06

---

## Intuition

When you want ten fence posts, you don't model ten fence posts. You model one and describe the pattern: offset by X, repeat N times. The pattern is the data; the individual copies are derived outputs. If you change the post shape later, the entire fence updates automatically — no manual duplication needed.

This is a parametric array. The name comes from the fact that the repetition is defined by *parameters* (count, spacing, direction) rather than by explicit, independent geometry for each copy. The copies are not data — they're evaluated results. Changing a parameter re-evaluates the result without touching any copy individually.

---

## Mental Model

Think of a parametric array as two separate things that happen to appear as one:

1. **One source mesh** — the geometry that gets repeated. Editing this mesh propagates to all copies automatically.
2. **A placement rule** — count N, direction D, spacing S. Evaluated left-to-right: copy 1 at `source + 1*S`, copy 2 at `source + 2*S`, ..., copy N at `source + N*S`.

The key insight: *copies have no geometry of their own — and in Salsa, they have no scene-graph existence either*. Instances are positions derived from `arrayParams` each frame, written directly into the GPU instance buffer. No `Mesh3D` objects are created; no scene graph mutations occur when count changes.

```
Source mesh           Instance 0             Instance 1             Instance 2
[geometry: torus]     [geometry: same]       [geometry: same]       [geometry: same]
[pos: 0,0,0]          [pos: 2,0,0]           [pos: 4,0,0]           [pos: 6,0,0]
        │                    │                      │                      │
        └────────────────────┴──────────────────────┴──────────────────────┘
         one VB/IB upload; instance buffer slots computed from arrayParams
```

---

## Formal Explanation

### Placement (translation mode)

For a linear array with source at position `P₀`, spacing vector `S`, and count `N`:

```
copy_i.position = P₀ + i × S     for i ∈ {1, 2, ..., N}
```

`S` is a world-space 3D vector, not a scalar. It encodes both the direction and the per-step magnitude. `S = [2, 0, 0]` means step 2 units in +X. `S = [1.4, 1.4, 0]` means step diagonally in XY.

### Placement (object offset mode)

When `objectOffsetId` is set, spacing is replaced by a full matrix transform derived from a second scene mesh (the "offset mesh"). Each copy gets a compounded transform:

```
D = offsetMesh.localMatrix × inv(source.localMatrix)
copy_i.modelMatrix = D^i × source.localMatrix     for i ∈ {1, 2, ..., N}
```

`D` encodes the *relative* transform from source to offset mesh — translation, rotation, and scale all included. Raising it to the power `i` means each successive copy advances by the same incremental transform. Moving the offset mesh 2 units in X AND rotating it 30° around Y makes every copy step 2 units in X AND rotate 30°, producing a staircase or helix effect.

The accumulation is computed each frame by `uploadMeshInstances`:
```
accum = copy of source.localMatrix
for i in 1..N:
  accum = D × accum     // advance by one step
  write accum to instance slot i
```

Because `D` compounds rotation and scale, each instance's normal matrix must be fully recomputed (inverse-transpose of the instance model matrix), unlike translation-only mode where normal matrices are shared with the source.

### Geometry Sharing

The source mesh's vertex/index data is uploaded once to the GPU geometry pool, keyed by the source's own mesh ID. Instance buffer slots for the array are computed every frame by `uploadMeshInstances` — no `geometryKeyOverride` is needed because instances are not separate `Mesh3D` objects; they share the source's draw range directly.

```
geometry pool
  slot for "source-mesh-id"  →  vertices + indices for Cube

instance buffer
  slot 0  (source)       model matrix for source at (0,0,0)
  slot 1  (instance 0)   same R/S as source, translation += offset[0]
  slot 2  (instance 1)   same R/S as source, translation += offset[1]
  ...

draw call: drawIndexed(triCount, N+1, firstIndex, baseVertex)
           ↑ covers source + all N instances in one call
```

### Live Edit Propagation

When the source is edited, `source.gpuDirty = true` triggers a geometry pool rebuild on the next frame. Since instances share the source's geometry slot, they automatically draw from the updated geometry — same as before, nothing extra needed.

```
source.syncFromEditMesh()  →  source.gpuDirty = true
                               ↓ next frame
_ensureGeomPool rebuilds source geometry slot
all instances draw from the updated slot automatically
```

When the source is *transformed* (moved/rotated/scaled), `source.localMatrixVersion` increments. The renderer's `uploadMeshInstances` detects this via `anyArrayMoved` and rewrites the N instance buffer slots with fresh offsets — no scene graph work needed.

### Serialization Invariant

Only `sourceId` and `arrayParams` are serialized. There are no children to save:

```json
{
  "type": "3DArrayGroup",
  "sourceId": "abc123",
  "arrayParams": { "mode": "linear", "countX": 4, "spacing": [2, 0, 0] }
}
```

On load, `recreateNode` creates the empty `ArrayGroup3D` shell. The pre-render callback starts pushing it to the renderer immediately — instances appear as soon as the source mesh is restored.

---

## Why It Matters

**Iterative design speed.** A floor tiling, a row of trees, a sci-fi panel array — none of these need N separate mesh edits. Change one parameter and the entire pattern updates instantly.

**Memory efficiency.** N copies sharing one GPU buffer costs the same VRAM as a single mesh, regardless of N. A 200-post fence costs exactly as much GPU memory as one post.

**Baking as an escape hatch.** When copies need to diverge (different colors, moved individually), "baking" converts the linked array into N independent meshes. Each copy receives its own geometry pool slot and can be edited freely. This is one-way and undoable. If multiple Repeat arrays share the same source mesh, baking one does NOT remove the source — it stays in the scene so the remaining repeats continue working.

---

## Where the Mental Model Breaks

**Source position is part of the placement rule.** Moving the source moves all copies relative to it (they're all at `source.pos + i*S`). Moving the source does NOT change `S` or `N`. This surprises users who expect the copies to stay put when the source moves. The mental model that breaks here is treating source and copies as fully independent meshes — they're not: the source is the anchor of the whole pattern.

**Spacing is a world-space vector, not a scalar.** `S = [2, 0, 0]` feels like "2 units apart" when the source is axis-aligned — but if the source is rotated, the copies still space along world-X, not local-X. The copies don't inherit the source's rotation in their placement direction. To space along a rotated axis, you set `S` to the rotated unit vector × magnitude. The gizmo handles this automatically by locking the axis to the direction of first movement, but numeric panel input is always world-space.

**The shared key makes pool deduplication asymmetric.** If the source is a default torus (`torus:0.5:0.2:16:24`), creating an array overrides its key to `array-src:X`. This means the torus's original key no longer exists in the pool. If another torus with the same params exists elsewhere in the scene, it will have its own slot. The override severs the deduplication relationship between the source and its geometric twins — by design, to ensure the source's edits don't accidentally update unrelated meshes.

**Baking duplicates geometry in CPU memory.** Each copy receives `new Float32Array(source.geometry.vertices)` — a full clone. For a mesh with 50,000 vertices and 5 copies, baking allocates 5× the vertex data. This is expected for an editing operation, but it means baking a large array in a memory-constrained context can cause a spike. The spikes are bounded by the undo stack's maximum depth.

---

## Common Confusions

**"The copies are separate meshes, so editing them individually should work."**
Before baking, copies are `Mesh3D` nodes but they share a geometry pool slot. Setting geometry on a copy directly wouldn't propagate to other copies and could break the shared key. The API prohibits direct geometry edits on copies — you edit the source and all copies follow. After baking, each copy is independent and fully editable.

**"Changing `countX` adds/removes copies immediately."**
True visually — the renderer recomputes `computeArrayOffsets(params, sourcePos)` on the next frame and writes the new count of slots. But nothing happens to the scene graph. There are no `Mesh3D` objects to add or remove; the change is purely in how many instance buffer slots `uploadMeshInstances` writes. Going from 5 to 2 and back to 5 is instant and allocation-free.

**"Undo after baking gives back the ArrayGroup3D with the original params."**
Correct and by design. The undo closure captures the `ArrayGroup3D` node and the source mesh reference before the bake. Undo re-adds the group to the scene root. The pre-render sync callback picks it up on the next frame and instances reappear.

---

## How Salsa Uses It

**`src/scene-graph/shapes/array-group-3d.ts`** — `ArrayGroup3D extends MeshGroup3D`. Stores `sourceId` and `arrayParams`. `toJSON()` writes only those two fields — no children. Also exports `computeArrayOffsets(params, sourcePos)` and `getArrayInstanceCount(params)` as pure functions used by both the renderer and the picking callback.

**`src/renderer/3d/renderer-3d.ts`** — `setArrayGroups(groups)` receives the current array groups each frame from a pre-render callback. `uploadMeshInstances` assigns instance buffer slots to each array group's instances immediately after the source's slot (ensuring they are contiguous for one-draw-call batching). Slots are computed from `computeArrayOffsets()`; the copy's model matrix reuses the source's R×S columns with only the translation column overridden. Normal matrices are identical to the source's (translation doesn't affect inverse-transpose of R×S). `getMeshWorldAABB3D` is public to support picking.

Hover highlighting is scoped per group via `_hoveredArrayGroupId: string | null`. When set, the `toEntries` helper in `drawMeshes` filters instance draw entries to only the hovered group's slot range `[firstSlot, firstSlot + N)`. This prevents a second Repeat array on the same source from lighting up when only one Repeat is hovered. Call `setHoveredArrayGroupId(id)` alongside `setHoveredMeshIds` to activate it; pass `null` to clear.

**`src/services/managers/scene3d-manager.ts`** — `createLinearArray3D`, `createGridArray3D`, `createRadialArray3D` add only the `ArrayGroup3D` node to SceneRoot (no copy creation), then call `ctx.setSelectedNode(group.id)` so the outliner auto-focuses the new Repeat row. `_ensureArrayGroupSync` registers a pre-render callback once; it collects all `ArrayGroup3D` nodes from the scene root and calls `renderer3D.setArrayGroups()`. `updateArrayParams3D` just calls `markInstancesDirty()`. `bakeArray3D` creates real `Mesh3D` nodes from `computeArrayOffsets` and wraps them in a `MeshGroup3D`. `pickAdditional` callback does ray–AABB intersection against translated source AABBs to enable clicking instances.

`syncSelectionFromOutliner` checks `instanceof ArrayGroup3D` before `instanceof MeshGroup3D`. For an array group node, it resolves `sourceId` → source mesh → `_expandGroupSelection`, giving the renderer the correct mesh IDs to show the gizmo on the source. `setHoveredMesh` similarly checks `instanceof ArrayGroup3D` first: it sets `hoveredArrayGroupId` to the group's own ID and `hoveredMeshIds` to the source's ID so the renderer can scope the highlight to that group's instances only.

**`src/renderer/3d/gizmo-renderer.ts`** — `drawArrayGizmo` switches on `data.mode`: linear/grid draw arm prisms + sphere handles (blue for X, green for Y); radial draws 64 arc segments + a center-to-rim shaft + sphere at angle 0. `hitTestArrayHandle` returns `'x' | 'y' | 'radius' | null`.

**`src/services/managers/transform-controller-3d.ts`** — `_applyArrayDrag` handles the X-arm (projects onto axis via camera-facing plane). `_applyArrayGridYDrag` is the identical logic for the Y arm. `_applyArrayRadiusDrag` projects onto the rotation-axis plane and takes the distance from center as the new radius. Each axis has its own `onArraySpacing[Y]Drag/Commit` and `onArrayRadius[Drag/Commit]` callback so undo steps are pushed with correct old/new values. `pickAdditional` callback is also defined here (signature: `(x,y,w,h) => string | null`).

---

## Related Concepts

- [Instancing](instancing.md) — Array copies use the same geometry pool slot that backs all instanced draws; understanding instance slots explains why N copies cost the same as one
- [Scene Graphs](scene-graphs.md) — `ArrayGroup3D` is a `MeshGroup3D` in the scene graph hierarchy; the parent-child relationship drives the `_expandGroupSelection` group-click behavior
- [GPU Pipelines](gpu-pipelines.md) — geometry pool deduplication is explained in the context of draw call batching
