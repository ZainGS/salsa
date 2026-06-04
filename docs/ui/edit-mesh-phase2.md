# Edit Mesh Phase 2 — Frogmarks UI Guide
**Last Updated:** 2026-05-31

---

## Overview

Phase 2 adds seven advanced modeling operations to Edit Mesh mode. All operations are undoable and follow the same patterns as Phase 1 (single-face extrude, inset, delete).

---

## Multi-Select Operations

All three single-face operations now have multi-face variants that accept a `Set<number>` of face indices. Pass `null` to operate on the current face selection from `getEditSelection3D(meshId).faces`.

### Extrude Multiple Faces

```ts
shapeManager.extrudeFaces3D(meshId, fIdxSet, distance)
// fIdxSet: Set<number> | null — face indices to extrude
// distance: number — extrusion depth in world units
```

Extrudes each face along its own normal. Edges shared between two selected faces produce no side quad (only the outer perimeter gets side walls). This is correct for extruding a flat region: you get one unified wall around the whole region, not individual walls for each face.

### Inset Multiple Faces

```ts
shapeManager.insetFaces3D(meshId, fIdxSet, amount)
// amount: 0–1, fraction toward face center (0 = no change, 1 = collapse)
```

Each face is inset independently toward its own centroid. No coupling between faces.

### Delete Multiple Faces

```ts
shapeManager.deleteFaces3D(meshId, fIdxSet)
```

Removes all faces in the set. The border edges become open boundaries.

---

## Flip Normals

```ts
shapeManager.flipFaces3D(meshId, fIdxSet)
// fIdxSet: Set<number> | null
```

Reverses the vertex winding of each selected face, flipping its normal to point the opposite direction. Use when an imported mesh has inside-out faces, or to create one-sided effects.

---

## Merge by Distance

```ts
const removed = shapeManager.mergeByDistance3D(meshId, threshold)
// threshold: number — max distance in world units to consider vertices "the same"
// returns: number — how many vertices were welded away
```

Finds all vertex pairs within `threshold` distance, merges each cluster to its centroid, removes degenerate faces (faces where two vertices collapsed to the same position), and compacts the vertex array. Equivalent to Blender's "Merge by Distance" (M key). Useful after boolean operations, knife cuts, or any operation that produces nearly-coincident vertices.

**Typical threshold:** `0.001` for millimetre precision, `0.01` for coarser cleanup.

---

## Subdivide Face

```ts
shapeManager.subdivideFace3D(meshId, fIdx)
// fIdx: number — single face index to subdivide
```

Replaces one n-gon face with n quad faces by inserting:
- One center vertex at the face centroid
- One edge-midpoint vertex per edge

The resulting quads are `[corner[k], edgeMid[k], center, edgeMid[k-1]]`. For a quad face, this produces 4 quads. For a triangle, 3. For a hexagon, 6.

Edge midpoints are keyed by canonical edge identifier, so repeated subdivisions on adjacent faces correctly share midpoints.

---

## Fill Hole

```ts
const ok = shapeManager.fillHole3D(meshId, boundaryHalfEdgeIdx)
// boundaryHalfEdgeIdx: number — index of any half-edge on the boundary loop (twin === -1)
// returns: boolean — true if the hole was successfully capped
```

Walks the open boundary loop starting from the given half-edge, collects all boundary vertices, and caps the hole with a single n-gon face. For a loop of n boundary edges, one n-gon face is produced.

To find boundary half-edges, use:
```ts
const em = shapeManager.getMesh3D(meshId)?.editMesh;
const boundaryHEs = em?.halfEdges
  .map((he, idx) => ({ he, idx }))
  .filter(({ he }) => he.twin === -1)
  .map(({ idx }) => idx) ?? [];
// boundaryHEs[0] is a valid starting point for fillHole
```

---

## Separate Faces

```ts
const newMeshId = shapeManager.separateFaces3D(meshId, fIdxSet)
// fIdxSet: Set<number> | null — faces to move into a new mesh
// returns: string | null — ID of the new mesh, or null on failure
```

Extracts the selected faces into a brand-new `Mesh3D` node placed at the same world position as the source mesh. The original faces are deleted from the source mesh. Both meshes are independently editable after separation.

The new mesh is added to the scene root and appears immediately in the outliner. The operation is undoable.

---

## Proportional Editing (Soft Selection)

```ts
shapeManager.setProportionalEdit3D(meshId, enabled, radius?, falloff?)
// enabled: boolean
// radius:  number — world-unit sphere radius around the moved vertex
// falloff: 'smooth' | 'linear' | 'sharp'
```

When enabled, `moveVertex3D` applies a falloff to all vertices within `radius` world units of the moved vertex. Vertices closer to the pivot move more; vertices at the radius edge barely move.

**Falloff types:**
| Name | Formula | Shape |
|------|---------|-------|
| `smooth` | `(1 - t)²` | Quadratic ease-out (default) |
| `linear` | `1 - t` | Linear ramp |
| `sharp` | `t < 0.1 ? 1 : 0` | Step — only very close vertices move |

`t` is normalized distance: `0` at the pivot, `1` at the radius boundary.

**Angular UI:**
```ts
// Toggle on/off
shapeManager.setProportionalEdit3D(meshId, true, 1.5, 'smooth');

// Adjust radius without toggling
shapeManager.setProportionalEdit3D(meshId, true, 2.0);

// Turn off (radius/falloff values are preserved for next enable)
shapeManager.setProportionalEdit3D(meshId, false);
```

The `proportionalEditEnabled`, `proportionalEditRadius`, and `proportionalEditFalloff` fields are serialized in the EditMesh JSON, so they survive project save/load.

---

## Suggested Panel Layout

```
Edit Mesh Mode Panel
├── [Selection mode buttons: Vertex | Edge | Face]
│
├── ── Single Operations ──
│   ├── Extrude Face     [distance slider]
│   ├── Inset Face       [amount 0–1 slider]
│   └── Delete Face
│
├── ── Multi-Select Operations ──  (enabled when ≥1 face selected)
│   ├── Extrude Faces    [distance slider]
│   ├── Inset Faces      [amount slider]
│   ├── Delete Faces
│   └── Flip Normals
│
├── ── Mesh Cleanup ──
│   ├── Merge by Distance  [threshold input]  → shows "X vertices removed"
│   └── Fill Hole          (auto-detects boundary at hovered edge)
│
├── ── Face Operations ──
│   ├── Subdivide Face   (operate on hovered/selected face)
│   └── Separate Faces   (extract selection to new mesh)
│
└── ── Proportional Edit ──
    ├── [Toggle: Proportional On/Off]
    ├── Radius           [numeric input, world units]
    └── Falloff          [dropdown: Smooth | Linear | Sharp]
```

---

## Implementation Notes

- All operations call `meshEdit.method()` which is `MeshEditManager`. The manager handles snapshot-undo automatically.
- The shape-manager delegates are the public API (`shapeManager.method3D(...)`).
- `separateFaces3D` is the only mesh-edit operation that creates a new scene graph node; all others modify the existing mesh in place.
- `mergeByDistance3D` can return 0 even when called — that's normal (no vertices within threshold).
