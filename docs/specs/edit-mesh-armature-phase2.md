# Edit Mesh Phase 2 + Skeleton Authoring — Implementation Spec
**Date:** 2026-05-31  
**Status:** ✅ Complete

---

## Overview

Two related feature groups implemented together:

1. **Edit Mesh Phase 2** — seven improvements that make the modeler genuinely useful: multi-select operations, flip normals, merge by distance, subdivide face, proportional editing, fill hole, separate faces.
2. **Skeleton Authoring** — four features that make the armature system usable without Blender: create skeleton from scratch, weight painting, clip authoring, and animation retargeting.

All features are implemented in existing files — no new files required.

---

## Part 1 — Edit Mesh Phase 2

### 1. Multi-select operations

All per-face and per-vertex operations gain plural variants accepting `Set<number>`.

**`edit-mesh.ts`** — new methods:
```ts
extrudeFaces(fIdxSet: Set<number>, distance: number): void
insetFaces(fIdxSet: Set<number>, amount: number): void
deleteFaces(fIdxSet: Set<number>): void
```

`extrudeFaces` is the most nuanced: for shared interior edges (both adjacent faces are in the set), do NOT generate a side quad — only perimeter edges get side faces. Algorithm: collect all face half-edges; mark edges shared by two set-members as "interior"; only extrude exterior edges.

`deleteFaces` / `insetFaces`: iterate set, apply existing single-face logic, call `_buildTopology` once at the end.

**`mesh-edit-manager.ts`** — new methods:
```ts
extrudeFaces(meshId, fIdxSet, distance): boolean
insetFaces(meshId, fIdxSet, amount): boolean
deleteFaces(meshId, fIdxSet): boolean
```

Each follows the snapshot-undo pattern. Use `getEditSelection3D(meshId).faces` as the default set when null is passed.

**`shape-manager.ts`** — delegates:
```ts
extrudeFaces3D(meshId, fIdxSet, distance): boolean
insetFaces3D(meshId, fIdxSet, amount): boolean
deleteFaces3D(meshId, fIdxSet): boolean
```

---

### 2. Flip face normals

Included in the multi-select batch as `flipFaces`.

**`edit-mesh.ts`**:
```ts
flipFaces(fIdxSet: Set<number>): void
```
Algorithm: for each face index in set, reverse the vertex winding in `faceLists[i]` (reverse the array). Call `_buildTopology` once.

**`mesh-edit-manager.ts`** / **`shape-manager.ts`**:
```ts
flipFaces(meshId, fIdxSet): boolean
flipFaces3D(meshId, fIdxSet): boolean
```

---

### 3. Merge by distance

**`edit-mesh.ts`**:
```ts
mergeByDistance(threshold: number): number  // returns vertices removed
```

Algorithm:
1. Quantized spatial bucket (cell = threshold). For each vertex i, check its bucket and 26 neighbors; build `remap[i] → representativeIndex` for all pairs within threshold.
2. Representatives take the centroid of their cluster.
3. Apply remap to all face vertex lists. Remove degenerate faces (a face where the remapped vertex set has fewer unique members than the original, or < 3 vertices).
4. Compact vertex array: remove unreferenced vertices, shift all face indices down accordingly.
5. Call `_buildTopology` on cleaned face lists.

**`mesh-edit-manager.ts`** / **`shape-manager.ts`**:
```ts
mergeByDistance(meshId, threshold): number
mergeByDistance3D(meshId, threshold): number
```

---

### 4. Subdivide face

**`edit-mesh.ts`**:
```ts
subdivideFace(fIdx: number): void
```

Algorithm for an n-gon:
1. Compute centroid → push as new center vertex (index = `vertices.length - 1` after push).
2. For each of the n edges, compute midpoint → push as edge-midpoint vertex. Track by edge key (`min(v0,v1):max(v0,v1)`) to deduplicate midpoints shared with adjacent faces in future calls.
3. Replace `faceLists[fIdx]` entry with n new quad faces: `[v[k], edgeMid[k], center, edgeMid[(k-1+n)%n]]`.
4. Call `_buildTopology`.

**`mesh-edit-manager.ts`** / **`shape-manager.ts`**:
```ts
subdivideFace(meshId, fIdx): boolean
subdivideFace3D(meshId, fIdx): boolean
```

---

### 5. Proportional editing / soft selection

Adds falloff-based vertex drag: moving one vertex smoothly shifts nearby vertices too.

**`edit-mesh.ts`** — new fields and setters:
```ts
proportionalEditEnabled: boolean = false
proportionalEditRadius: number = 1.0
proportionalEditFalloff: 'smooth' | 'linear' | 'sharp' = 'smooth'
```

Modify existing `moveVertex(vIdx, dx, dy, dz)`:
```
if not proportionalEditEnabled: existing behavior unchanged
else:
  origin = vertices[vIdx].position
  for each vertex vi:
    dist = distance(vi.position, origin)
    if dist >= proportionalEditRadius: skip
    t = dist / proportionalEditRadius   // 0 = at pivot, 1 = at radius edge
    weight = falloff(t):
      smooth: (1 - t)²
      linear: 1 - t
      sharp:  t < 0.1 ? 1 : 0   (step at 10%)
    vi.x += dx * weight; vi.y += dy * weight; vi.z += dz * weight
```

**`mesh-edit-manager.ts`**:
```ts
setProportionalEdit(meshId, enabled, radius?, falloff?): void
```

**`shape-manager.ts`**:
```ts
setProportionalEdit3D(meshId, enabled, radius?, falloff?): void
```

**Serialization**: `proportionalEditEnabled`, `proportionalEditRadius`, `proportionalEditFalloff` added to `EditMesh.toJSON()` / `fromJSON()`.

---

### 6. Fill hole

Caps an open boundary loop.

**`edit-mesh.ts`**:
```ts
fillHole(boundaryHalfEdgeIdx: number): number   // new face index, or -1
```

Algorithm:
1. Assert `halfEdges[boundaryHalfEdgeIdx].twin === -1`.
2. Walk the boundary loop: from `he`, follow `he.next` half-edges; at each step, find the outgoing boundary half-edge from the current vertex (an outgoing half-edge with twin === -1 that continues the loop). Collect `halfEdges[he].vertex` at each step. Stop when back to start vertex, max 10,000 iterations guard.
3. If loop is valid and ≥ 3 vertices: push a new face to `faceLists` (the collected vertex indices in loop order).
4. Call `_buildTopology`. Return the new face index.

**`mesh-edit-manager.ts`** / **`shape-manager.ts`**:
```ts
fillHole(meshId, boundaryHalfEdgeIdx): boolean
fillHole3D(meshId, boundaryHalfEdgeIdx): boolean
```

---

### 7. Separate faces to new mesh

Extracts selected faces into a new sibling Mesh3D.

**`mesh-edit-manager.ts`** (needs scene context — lives here, not edit-mesh.ts):
```ts
separateFaces(meshId: string, fIdxSet: Set<number>): string | null
```

Algorithm:
1. Get `em = mesh.editMesh`. Gather unique vertex indices from the selected face lists → build `oldToNew` compact map.
2. Build a new `EditMesh`: copy compacted vertices + remapped face lists, call its `_buildTopology`.
3. Create a new `Mesh3D` at the source mesh's `(x, y, z)` position (via `ctx.createMesh`).
4. Set `newMesh.editMesh = newEm`, call `syncFromEditMesh` on new mesh.
5. Call `em.deleteFaces(fIdxSet)` on source, `syncFromEditMesh` on source.
6. Undo: captures source JSON before + deletes new mesh. Redo: re-applies both operations.
7. Return new mesh ID.

**`shape-manager.ts`**:
```ts
separateFaces3D(meshId: string, fIdxSet: Set<number>): string | null
```

---

## Part 2 — Skeleton Authoring

### Data type changes — `armature-3d.ts`

```ts
// Add id field to SkeletonAnimClip:
export interface SkeletonAnimClip {
  id: string;   // NEW — uuid for registry lookup
  name: string;
  startFrame: number;
  endFrame: number;
  fps: number;
  tracks: SkeletonKeyframeTrack[];
}

// Add clips to SkeletonData:
export interface SkeletonData {
  name: string;
  joints: Joint3D[];
  clips?: SkeletonAnimClip[];   // NEW
}
```

---

### Feature A — Create skeleton from scratch

**`scene3d-manager.ts`** — new public methods:
```ts
createEmptySkeleton3D(name?: string): string
addBone3D(skeletonId, parentIndex, localPos, name?): number
moveBone3D(skeletonId, jointIndex, localPos): void
removeBone3D(skeletonId, jointIndex): void
renameBone3D(skeletonId, jointIndex, name): void
bindMeshToSkeleton3D(meshId, skeletonId): boolean
```

`createEmptySkeleton3D`: constructs `new Skeleton3D({ name, joints: [], clips: [] })`, adds to `sceneGraph.root`, returns `skel.id`.

`addBone3D`: pushes `Joint3D` with `index = joints.length`, appends index to `parent.children[]`, calls `computeWorldMatrices()`.

`removeBone3D`: recursively collects joint + all descendants, removes them, re-indexes all remaining joints (shift `index`, `parentIndex`, `children[]` values > removed range down), resizes `skinMatrices`, calls `computeWorldMatrices()`.

`bindMeshToSkeleton3D` — heat-diffusion weights by distance:
1. Get vertex positions from `mesh.geometry.vertices` (positions at float offsets 0,1,2 with `FLOATS_PER_VERT = 12`).
2. For each vertex: compute world-space position = `mesh.localMatrix × [vx, vy, vz, 1]`.
3. For each vertex: compute distances to all joint world positions. Sort by distance, take top 4, compute weights = `1/dist²` (min distance floor 0.001), normalize to sum = 1.0.
4. Upgrade the `Mesh3D` to `SkinnedMesh3D`: replace the node in `sceneGraph` with a new `SkinnedMesh3D`, copy all geometry/material/transform fields, set `skeletonId`, `skeleton`, `jointIndices` (Uint8Array, 4/vertex), `jointWeights` (Float32Array, 4/vertex).
5. For each joint, compute `inverseBindMatrix = mat4.invert([], joint.worldMatrix)`.
6. Mark mesh `skinDirty = true`, `skeleton.matricesDirty = true`.

**`shape-manager.ts`** — delegate all 6:
```ts
createEmptySkeleton3D(name?): string
addBone3D(skeletonId, parentIndex, localPos, name?): number
moveBone3D(skeletonId, jointIndex, localPos): void
removeBone3D(skeletonId, jointIndex): void
renameBone3D(skeletonId, jointIndex, name): void
bindMeshToSkeleton3D(meshId, skeletonId): boolean
```

---

### Feature B — Weight painting

**`scene3d-manager.ts`** — private state:
```ts
private _weightPaintMeshId: string | null = null;
private _weightPaintJointIndex: number | null = null;
private _weightPaintSavedColors: Float32Array | null = null;  // saved vertex colors
```

New methods:
```ts
enterWeightPaintMode3D(meshId, skeletonId, jointIndex): boolean
paintWeightDab3D(meshId, jointIndex, vertexIndices, targetWeight, brushStrength): void
normalizeWeights3D(meshId): void
exitWeightPaintMode3D(): void
```

`enterWeightPaintMode3D`:
1. Get `mesh = getSkinnedMesh(meshId)`. Ensure `mesh.editMesh` exists.
2. Save `_weightPaintSavedColors = mesh.editMesh.compileVertexColors()` (or null if none).
3. Set state fields, call `_applyWeightHeatmap(meshId, jointIndex)`.

`_applyWeightHeatmap(meshId, jointIndex)` — private:
- For each vertex `vi`: find weight = `jointWeights[vi*4 + k]` where `jointIndices[vi*4 + k] === jointIndex`, default 0.
- Map weight to heat color: `0 → [0,0,1,1]` (blue), `0.5 → [0,1,0,1]` (green), `1 → [1,0,0,1]` (red) via linear RGB lerp.
- Set on `editMesh.vertices[vi].color`, call `mesh.syncFromEditMesh()`.

`paintWeightDab3D`:
- For each `vi` in `vertexIndices`: blend `newW = lerp(currentW, targetWeight, brushStrength)`.
- Update `mesh.jointWeights[vi*4 + k]` for the matching joint slot (or slot with lowest existing weight if joint not yet influencing vertex).
- Call `normalizeWeights3D` if in weight paint mode.
- Refresh heatmap.

`normalizeWeights3D`: for each vertex, sum 4 weights; if sum > 0, divide each by sum.

`exitWeightPaintMode3D`: restore saved vertex colors (or clear vertex colors if none were saved). Clear state.

**`shape-manager.ts`** — delegate all 4.

---

### Feature C — Animation clip authoring

**`scene3d-manager.ts`** — new methods:
```ts
createSkeletonClip3D(skeletonId, name, fps, endFrame): string
setClipJointKeyframe3D(clipId, jointIndex, channel, frame, value): void
removeClipJointKeyframe3D(clipId, jointIndex, channel, frame): void
getSkeletonClips3D(skeletonId): SkeletonAnimClip[]
deleteSkeletonClip3D(clipId): void
recordSkeletonPose3D(skeletonId, clipId, frame): void
```

Clips are stored in `skeleton.data.clips[]`. Private helper `_findClip(clipId): { skel, clip } | null` iterates `getAllSkeletons()`.

`createSkeletonClip3D`: generate id via `crypto.randomUUID()`, push `{ id, name, startFrame:0, endFrame, fps, tracks:[] }` into `skel.data.clips`.

`setClipJointKeyframe3D`: find/create track for `{jointIndex, channel}`, upsert keyframe at `frame`, keep tracks sorted by frame.

`recordSkeletonPose3D`: for every joint, call `setClipJointKeyframe3D` for `translation` (localPosition), `rotation` (localRotation), `scale` (localScale) at given frame.

**Serialization**: `Skeleton3D.toJSON()` includes `skeletonData.clips`. `Skeleton3D.fromJSON` restores clips including `id`.

**`shape-manager.ts`** — delegate all 6.

---

### Feature D — Retarget animations

**`scene3d-manager.ts`**:
```ts
retargetSkeletonClip3D(clipId, targetSkeletonId): string
```

Algorithm:
1. `_findClip(clipId)` → `{ sourceSkel, clip }`.
2. `targetSkel = getSkeleton(targetSkeletonId)`.
3. Build `nameToIdx` maps (lowercase names) for both skeletons.
4. For each track: find target joint index by name match. If found, copy track with remapped `jointIndex`. If not found, `console.warn('retarget: no match for joint', name)` — skip.
5. Create new clip on target skeleton via `createSkeletonClip3D`, populate tracks directly, return new clip id.

**`shape-manager.ts`**:
```ts
retargetSkeletonClip3D(clipId, targetSkeletonId): string
```

---

## Serialization summary

| New data | Persisted in |
|----------|-------------|
| `SkeletonAnimClip.id` | `Skeleton3D.toJSON()` → `skeletonData.clips[].id` |
| `SkeletonData.clips` | `Skeleton3D.toJSON()` → `skeletonData.clips` |
| `EditMesh.proportionalEditEnabled/Radius/Falloff` | `EditMesh.toJSON()` / `fromJSON()` |

---

## Files changed

| File | What changes |
|------|-------------|
| `src/types/armature-3d.ts` | Add `id` to `SkeletonAnimClip`, add `clips?` to `SkeletonData` |
| `src/scene-graph/shapes/edit-mesh.ts` | `extrudeFaces`, `insetFaces`, `deleteFaces`, `flipFaces`, `mergeByDistance`, `subdivideFace`, `fillHole`, proportional edit fields + `moveVertex` update, `toJSON`/`fromJSON` update |
| `src/services/managers/mesh-edit-manager.ts` | Plural op wrappers, `separateFaces`, `setProportionalEdit` |
| `src/scene-graph/shapes/skeleton-3d.ts` | `addJoint`, `removeJoint`, `moveJoint`, `renameJoint`, `computeInverseBindMatrices`; `toJSON`/`fromJSON` clip persistence |
| `src/services/managers/scene3d-manager.ts` | Skeleton creation methods, weight paint methods, clip methods, retarget |
| `src/services/shape-manager.ts` | All new public API delegates |
