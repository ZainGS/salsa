# Case Study: Array Tool — Copy-Node Architecture to True GPU Instancing

**Date:** 2026-05-15  
**Files changed:** `src/scene-graph/shapes/array-group-3d.ts`, `src/renderer/3d/renderer-3d.ts`, `src/services/managers/transform-controller-3d.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`  
**Change size:** ~350 lines removed, ~280 lines added (net −70)  
**What changed:** Replaced per-instance `Mesh3D` scene-graph nodes with a framebuffer-level instancing approach driven by `ArrayGroup3D.arrayParams`

---

## Background

The Array Tool ("Repeat") creates N linked copies of a source mesh in a parametric pattern — linear chains, NxM grids, radial rings. The user edits the source and all copies update live. When finished they can bake to independent meshes.

The initial implementation was built quickly to prove the feature worked. It used the most straightforward model available: each instance was a real `Mesh3D` node in the scene graph, and the geometry pool's `geometryKeyOverride` mechanism made all copies share the source's vertex/index data. This worked correctly but carried significant overhead that compounded with instance count.

This case study documents the full before/after of replacing that approach with true GPU instancing — where instances are buffer slots computed from `arrayParams` each frame and no scene-graph nodes exist for them.

---

## Old Architecture: Copy-Node Instancing

### Core idea

When a user created a linear array of N copies, `createLinearArray3D` in `scene3d-manager.ts` called `_createArrayCopy` N times. Each call created a new `Mesh3D`, positioned it at `source.pos + i * spacing`, set `geometryKeyOverride = "array-src:{sourceId}"` on it, and added it as a child of the `ArrayGroup3D`.

```
SceneRoot
├── Cube (source)                     ← real Mesh3D, geometryKeyOverride = "array-src:abc"
└── ArrayGroup A  [3DArrayGroup]
    ├── Cube-copy-1 [3DMesh]          ← real Mesh3D, geometryKeyOverride = "array-src:abc"
    ├── Cube-copy-2 [3DMesh]          ← real Mesh3D, geometryKeyOverride = "array-src:abc"
    └── Cube-copy-3 [3DMesh]          ← real Mesh3D, geometryKeyOverride = "array-src:abc"
```

The geometry pool scanned meshes in scene order. The first mesh with a given `geometryKey` uploaded its geometry; all subsequent meshes with the same key reused `{ baseVertex, firstIndex }`. So one VB/IB upload fed all N+1 draw calls — this part was efficient.

### Geometry key override mechanism

`Mesh3D.setGeometryKeyOverride(key)` forced the pool key regardless of primitive type. Without it, if the source was a default torus, editing it later changed its key from `torus:0.5:0.2:16:24` to `custom:{meshId}`, and the copies would still have the old torus key — decoupling them from the updated geometry. The override pinned all copies and source to the same stable `array-src:{sourceId}` key that never changes.

```typescript
// _createArrayCopy (old scene3d-manager.ts):
const copy = this.createMesh(source.x + dx, source.y + dy, source.z + dz);
copy.geometryKeyOverride = `array-src:${group.sourceId}`;
copy.gpuDirty = true;
group.addChild(copy);
```

After creation, `_ensureGeomPool` detected the shared key and deduplicated the upload:

```
_ensureGeomPool:
  mesh "source"   key "array-src:abc"  → upload geometry → slot 0
  mesh "copy-1"   key "array-src:abc"  → reuse slot 0
  mesh "copy-2"   key "array-src:abc"  → reuse slot 0
  mesh "copy-3"   key "array-src:abc"  → reuse slot 0
```

### Per-frame sync: `_syncAllArrayGroups`

The copies' positions were stored on the `Mesh3D` nodes themselves. When the source moved, the copies needed to be repositioned. A pre-render callback ran `_syncAllArrayGroups` every single frame:

```typescript
// _syncAllArrayGroups (old):
private _syncAllArrayGroups(): void {
    for (const group of this._getAllArrayGroups()) {
        const sig = this._computeGroupSig(group);  // JSON.stringify of params + source pos
        if (this._arraySyncLastSigs.get(group.id) === sig) continue;
        this._arraySyncLastSigs.set(group.id, sig);
        this._rebuildArrayCopyPositions(group);
    }
}
```

`_computeGroupSig` serialized the group's params and source position to a JSON string, then compared it against the cached string from last frame. A mismatch triggered `_rebuildArrayCopyPositions`:

```typescript
// _rebuildArrayCopyPositions (old):
private _rebuildArrayCopyPositions(group: ArrayGroup3D): void {
    const source = this.getMesh(group.sourceId);
    if (!source) return;
    const offsets = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z]);

    // Trim excess copies
    while (group.children.length > offsets.length) {
        const last = group.children[group.children.length - 1];
        group.removeChild(last);
    }
    // Add new copies if count increased
    while (group.children.length < offsets.length) {
        const copy = this.createMesh(0, 0, 0);
        copy.geometryKeyOverride = `array-src:${group.sourceId}`;
        group.addChild(copy);
    }
    // Reposition all copies
    for (let i = 0; i < offsets.length; i++) {
        const [dx, dy, dz] = offsets[i];
        group.children[i].x = source.x + dx;
        group.children[i].y = source.y + dy;
        group.children[i].z = source.z + dz;
    }
    this.renderer3D.markInstancesDirty();
}
```

This ran every frame for every array group, even when nothing had changed — the `JSON.stringify` signature check was the guard.

### Count change: scene graph mutation

When the user dragged the array count slider or committed a new count, `updateArrayParams3D` wrote new params to the group then called `_rebuildArrayCopyPositions`. This could add or remove `Mesh3D` children from the scene graph:

```
User drags count from 4 → 2:
  _rebuildArrayCopyPositions:
    group.removeChild(copy-3)   ← Mesh3D destroyed, heap object GC'd
    group.removeChild(copy-4)   ← Mesh3D destroyed, heap object GC'd
    reposition copy-1, copy-2

User drags count from 2 → 5:
  _rebuildArrayCopyPositions:
    new Mesh3D() × 3            ← heap allocation × 3
    set geometryKeyOverride × 3
    group.addChild() × 3
    reposition all 5
```

Every count change during a live drag fired this entire sequence.

### Picking: MeshPicker + parent walk

Clicking an instance in the viewport used `MeshPicker.pickMesh`, which did a full BVH ray-triangle intersection test against each visible `Mesh3D`. When a copy was hit, `_expandGroupSelection` walked up the scene-graph parent chain:

```typescript
// _expandGroupSelection (old):
private _expandGroupSelection(ids: Set<string>): { meshIds: Set<string>; groupId: string | null } {
    for (const id of ids) {
        const mesh = this.getMesh(id);
        if (mesh?.parent instanceof ArrayGroup3D) {
            return { meshIds: new Set([mesh.parent.sourceId]), groupId: mesh.parent.id };
        }
    }
    return { meshIds: ids, groupId: null };
}
```

### Serialization

`ArrayGroup3D.toJSON()` serialized the full child array:

```json
{
  "type": "3DArrayGroup",
  "sourceId": "abc123",
  "arrayParams": { "mode": "linear", "countX": 4, "spacing": [2, 0, 0] },
  "children": [
    { "id": "copy-1", "type": "3DMesh", "x": 2, "y": 0, "z": 0, ... },
    { "id": "copy-2", "type": "3DMesh", "x": 4, "y": 0, "z": 0, ... },
    { "id": "copy-3", "type": "3DMesh", "x": 6, "y": 0, "z": 0, ... },
    { "id": "copy-4", "type": "3DMesh", "x": 8, "y": 0, "z": 0, ... }
  ]
}
```

On load, `recreateNode` recreated each child `Mesh3D`, and a separate `restoreDocumentState` fixup re-applied `geometryKeyOverride` to all of them.

### Summary of old data flows

```
CREATE ARRAY
  createLinearArray3D(sourceId, count, spacing)
    → _createArrayCopy() × N          [N Mesh3D allocations, N scene-graph addChild calls]
    → each copy: geometryKeyOverride   [N string assignments]
    → markInstancesDirty()

EVERY FRAME (pre-render callback)
  _syncAllArrayGroups()
    for each group:
      JSON.stringify(params + sourcePos)    [string allocation per group per frame]
      compare to cached sig                 [string comparison]
      if changed:
        _rebuildArrayCopyPositions()
          reposition N children             [N property writes per group]

COUNT CHANGE (slider drag)
  updateArrayParams3D(groupId, { countX: newCount })
    → _rebuildArrayCopyPositions()
        add/remove Mesh3D nodes            [scene graph mutation, possible alloc/GC]
        reposition all N copies

CLICK INSTANCE
  MeshPicker.pickMesh()                    [BVH ray-triangle intersection × N copies]
  → hit = copy Mesh3D
  → _expandGroupSelection walks parent chain
  → returns group ID

SAVE
  ArrayGroup3D.toJSON()
    → children[0..N-1] each toJSON()      [N child objects in JSON]
```

---

## New Architecture: True GPU Instancing

### Core idea

`ArrayGroup3D` has no children. It is a pure data node — `sourceId` and `arrayParams` only. Instances exist only as slots in the GPU instance buffer, computed from `arrayParams` each frame by the renderer.

```
SceneRoot
├── Cube (source)              ← real Mesh3D, normal geometry key
└── ArrayGroup A  [3DArrayGroup]
    (no children)
```

The renderer holds a list of `ArrayGroup3D` nodes, pushed each frame via a pre-render callback. During `uploadMeshInstances`, it calls `computeArrayOffsets(params, sourcePos)` — a pure function — and writes N instance buffer slots immediately after the source's slot. No scene-graph access, no property writes, no allocations.

### `computeArrayOffsets` and `getArrayInstanceCount`

Two pure functions added to `array-group-3d.ts` encode all placement math:

```typescript
export function computeArrayOffsets(
    params: ArrayParams,
    sourcePos: [number, number, number],
): Array<[number, number, number]> {
    // linear:  i = 1..countX,  offset = [i*sx, i*sy, i*sz]
    // grid:    all (ix,iy) combinations excluding (0,0)
    // radial:  i = 0..count-1, angle = i * arcDeg/count,
    //          offset = center + radialPos(angle, axis) - sourcePos
}

export function getArrayInstanceCount(params: ArrayParams): number {
    if (params.mode === 'linear') return params.countX;
    if (params.mode === 'radial') return params.count;
    const { countX, countY, diagonalOnly } = params;
    return diagonalOnly ? countX * countY : (countX + 1) * (countY + 1) - 1;
}
```

These replace the inline positioning logic that was scattered across `_createArrayCopy`, `_rebuildArrayCopyPositions`, and `bakeArray3D`. They are used by the renderer, the picking callback, and the bake operation — a single source of truth for all instance placement.

### Renderer integration: `setArrayGroups` and `uploadMeshInstances`

```typescript
// renderer-3d.ts (new fields):
private _arrayGroups: ArrayGroup3D[] = [];
private _arrayGroupFirstSlot = new Map<string, number>();   // groupId → first instance slot index
private _arrayGroupSourceVers = new Map<string, number>();  // groupId → last seen localMatrixVersion

// Called once per frame by the pre-render callback:
setArrayGroups(groups: ArrayGroup3D[]): void {
    this._arrayGroups = groups;
    this._instancesDirty = true;
}
```

Inside `uploadMeshInstances`, slot assignment was modified so that each array group's slots are placed *immediately after* its source mesh's slot:

```typescript
// Assign slots — array group instances must be contiguous with source:
for (const m of sorted) {
    if (m.submeshes.length === 0) {
        this._meshInstanceSlots.set(m.id, slotIdx++);
        // Immediately assign this group's instance slots:
        for (const group of this._arrayGroups) {
            if (group.sourceId !== m.id) continue;
            const N = getArrayInstanceCount(group.arrayParams);
            if (N > 0) {
                this._arrayGroupFirstSlot.set(group.id, slotIdx);
                slotIdx += N;
            }
        }
    } else {
        // multi-submesh: one slot per submesh
        for (const sub of m.submeshes) {
            this._meshSubmeshSlots.set(`${m.id}:${sub.material}`, slotIdx++);
        }
    }
}
```

Contiguity matters because the draw call batching loop groups consecutive same-geometry slots into a single `drawIndexed(triCount, slotCount)`. Source at slot X, instances at X+1..X+N → one draw call covers all of them.

After writing the source mesh's instance data, the array instance data is written:

```typescript
// Write instance data for all array groups:
for (const group of this._arrayGroups) {
    const firstSlot = this._arrayGroupFirstSlot.get(group.id);
    if (firstSlot === undefined) continue;
    const source = sorted.find(m => m.submeshes.length === 0 && m.id === group.sourceId);
    if (!source) continue;

    const srcSlot   = this._meshInstanceSlots.get(source.id)!;
    const srcOffset = srcSlot * floatsPerInstance;
    const srcMat    = source.localMatrix as Float32Array;
    const nc        = this._normalMatCache.get(source.id);   // pre-computed (R*S)⁻ᵀ

    const offsets = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z]);
    for (let i = 0; i < offsets.length; i++) {
        const [dx, dy, dz] = offsets[i];
        const slot   = firstSlot + i;
        const offset = slot * floatsPerInstance;

        // Copy full model matrix from source, then override translation column only:
        data.set(srcMat, offset);
        data[offset + 12] = srcMat[12] + dx;
        data[offset + 13] = srcMat[13] + dy;
        data[offset + 14] = srcMat[14] + dz;

        // Normal matrix: translation doesn't affect (R*S)⁻ᵀ — share source's
        if (nc) data.set(nc.floats, offset + 16);

        // Material: copy 16 floats from source's slot (diffuse/specular/emissive/flags)
        data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 48);
    }
    this._arrayGroupSourceVers.set(group.id, source.localMatrixVersion);
}
```

The dirty check now also looks at `localMatrixVersion` to detect when the source has moved:

```typescript
const anyArrayMoved = this._arrayGroups.some(g => {
    const src = meshes.find(m => m.id === g.sourceId);
    return src ? src.localMatrixVersion !== (this._arrayGroupSourceVers.get(g.id) ?? -1) : false;
});
if (!this._instancesDirty && !anyGpuDirty && !anyArrayMoved && totalSlots === this._instanceCount) return;
```

`localMatrixVersion` is an integer incremented whenever `x`, `y`, `z`, `rotationX/Y/Z`, or `scaleX/Y/Z` change on the source. Comparing one integer per group per frame replaces the old `JSON.stringify` signature comparison.

### Pre-render callback: `_ensureArrayGroupSync`

```typescript
// scene3d-manager.ts (new):
private _ensureArrayGroupSync(): void {
    if (this._arrayGroupSyncCb) return;
    this._arrayGroupSyncCb = () => {
        const groups: ArrayGroup3D[] = [];
        for (const node of this.ctx.sceneGraph.root.children) {
            if (node instanceof ArrayGroup3D) groups.push(node as ArrayGroup3D);
        }
        this.renderer3D.setArrayGroups(groups);
        return false;
    };
    this.ctx.webgpuRenderer.addPreRenderCallback(this._arrayGroupSyncCb);
}
```

This registers once and collects all `ArrayGroup3D` nodes from the scene root. It replaces `_syncAllArrayGroups` entirely. The renderer does the actual position math; this callback only needs to pass node references.

### Count change: one flag

`updateArrayParams3D` no longer rebuilds any nodes:

```typescript
// Before:
updateArrayParams3D(groupId, params) {
    Object.assign(group.arrayParams, params);
    this._rebuildArrayCopyPositions(group);  // ← mutation, allocs, GC
}

// After:
updateArrayParams3D(groupId, params) {
    Object.assign(group.arrayParams, params);
    this.renderer3D.markInstancesDirty();    // ← one boolean
}
```

On the next frame, `uploadMeshInstances` recomputes all slots from scratch. No scene-graph nodes are touched.

### Instance picking: `pickAdditional` + ray-AABB

Since there are no `Mesh3D` objects for instances, `MeshPicker` can't find them. A new `pickAdditional` callback was added to `TransformControllerCallbacks`:

```typescript
pickAdditional?(x: number, y: number, w: number, h: number): string | null;
```

When the regular picker finds no hit and the click is not a deselect, `handlePointerDown` calls this callback:

```typescript
// transform-controller-3d.ts:
} else if (!e.shiftKey) {
    const additionalId = this.cb.pickAdditional?.(x, y, width, height) ?? null;
    if (additionalId) {
        this.cb.setSelectedIds(new Set([additionalId]));
    } else {
        this.cb.setSelectedIds(new Set());
    }
}
```

The implementation in `scene3d-manager.ts` casts a ray and tests it against source-AABB translated by each instance offset:

```typescript
pickAdditional: (x, y, w, h) => {
    const camera = this.renderer3D.getCamera();
    const { origin, dir } = this._picker.castRay(x, y, w, h, camera);
    let bestDist = Infinity;
    let bestGroupId: string | null = null;

    for (const node of this.ctx.sceneGraph.root.children) {
        if (!(node instanceof ArrayGroup3D)) continue;
        const source = this.getMesh(node.sourceId);
        if (!source) continue;
        const srcAABB = this.renderer3D.getMeshWorldAABB3D(source);
        if (!srcAABB) continue;

        const offsets = computeArrayOffsets(node.arrayParams, [source.x, source.y, source.z]);
        for (const [ddx, ddy, ddz] of offsets) {
            const t = _rayAABBIntersect(
                origin[0], origin[1], origin[2],
                dir[0], dir[1], dir[2],
                srcAABB.minX + ddx, srcAABB.minY + ddy, srcAABB.minZ + ddz,
                srcAABB.maxX + ddx, srcAABB.maxY + ddy, srcAABB.maxZ + ddz,
            );
            if (t !== null && t < bestDist) { bestDist = t; bestGroupId = node.id; }
        }
    }
    return bestGroupId;
},
```

`_rayAABBIntersect` is the standard slab method — 6 reciprocal multiplies and 6 min/max comparisons per instance. Far cheaper than the BVH ray-triangle traversal `MeshPicker` did per copy.

### `_expandGroupSelection` and `_selectedGroupId`

With no copy nodes, the old "walk parent chain" path is dead. `_expandGroupSelection` now detects when an `ArrayGroup3D` ID is passed in directly (from `pickAdditional`):

```typescript
// scene3d-manager.ts:
private _expandGroupSelection(ids: Set<string>): { meshIds: Set<string>; groupId: string | null } {
    if (ids.size === 1) {
        const [id] = ids;
        const node = this.ctx.sceneGraph.findNodeById(id);
        if (node instanceof ArrayGroup3D) {
            this._selectedGroupId = id;
            return { meshIds: new Set([node.sourceId]), groupId: id };
        }
    }
    this._selectedGroupId = null;
    // ... handle regular mesh selection
}
```

`_selectedGroupId` is checked first in the sync callback that computes `ArrayGizmoData` for the gizmo renderer, ensuring the array adjustment handles appear correctly after clicking an instance.

### Baking: `computeArrayOffsets` as the source of truth

`bakeArray3D` no longer needs to read copy node positions (they don't exist). It calls `computeArrayOffsets` directly:

```typescript
bakeArray3D(groupId: string): void {
    const group = this._getArrayGroup(groupId);
    const source = this.getMesh(group.sourceId);

    const offsets = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z]);
    const copies: Mesh3D[] = offsets.map(([dx, dy, dz]) => {
        const copy = this._createMesh3DFromSource(source,
            source.x + dx, source.y + dy, source.z + dz);
        return copy;
    });

    const bakedGroup = new MeshGroup3D(this.interactionService);
    copies.forEach(c => bakedGroup.addChild(c));
    // ... replace ArrayGroup3D with bakedGroup, push undo
}
```

### Serialization: no children

`ArrayGroup3D.toJSON()` (unchanged from before) writes only `sourceId` and `arrayParams`. The old child serialization was inherited from `MeshGroup3D.toJSON()` which iterates `this.children` — since there are no children, it serializes nothing:

```json
{
  "type": "3DArrayGroup",
  "id": "grp-abc",
  "sourceId": "abc123",
  "arrayParams": { "mode": "linear", "countX": 4, "spacing": [2, 0, 0] }
}
```

`recreateNode` in `shape-manager.ts` was updated to ignore any `children` that old saves might include:

```typescript
case '3DArrayGroup': {
    const arrayGroup = new ArrayGroup3D(this.interactionService, data.sourceId, data.arrayParams);
    if (data.id) arrayGroup.setId(data.id);
    if (data.name) arrayGroup.name = data.name;
    // GPU instancing: no copy children — ignore any children saved by older format.
    node = arrayGroup;
    break;
}
```

### Summary of new data flows

```
CREATE ARRAY
  createLinearArray3D(sourceId, count, spacing)
    → new ArrayGroup3D(sourceId, params)   [1 object allocation]
    → root.addChild(group)
    → _ensureArrayGroupSync()              [registers pre-render callback once if not already]
    → markInstancesDirty()

EVERY FRAME (pre-render callback)
  _ensureArrayGroupSync callback:
    collect ArrayGroup3D nodes from root  [O(childCount) scan, no allocs]
    renderer3D.setArrayGroups(groups)

  uploadMeshInstances (inside renderer):
    for each group: compare localMatrixVersion [1 integer compare per group]
    if dirty:
      for each instance: write 16 floats to Float32Array  [typed array write, no allocs]

COUNT CHANGE (slider drag)
  updateArrayParams3D(groupId, { countX: newCount })
    → markInstancesDirty()                [1 boolean write]
    (next frame: renderer recomputes from params)

CLICK INSTANCE
  MeshPicker.pickMesh() → null           [no copy Mesh3D to find]
  → pickAdditional(x, y, w, h)
      castRay()                          [unchanged]
      for each instance: rayAABBIntersect [12 multiply-adds per instance]
  → returns groupId

SAVE
  ArrayGroup3D.toJSON()
    → { sourceId, arrayParams }          [0 children]
```

---

## What Was Removed

| Item | Where | Why removed |
|---|---|---|
| `_createArrayCopy()` | `scene3d-manager.ts` | Copy nodes no longer exist |
| `_rebuildArrayCopyPositions()` | `scene3d-manager.ts` | No nodes to reposition |
| `_syncAllArrayGroups()` | `scene3d-manager.ts` | Replaced by renderer-side version check |
| `_arraySyncLastSigs: Map<string, string>` | `scene3d-manager.ts` | Replaced by `_arrayGroupSourceVers` int map |
| `geometryKeyOverride` usage on copies | `scene3d-manager.ts` | No copies; instances share source slot directly |
| `geometryKeyOverride` restoration on load | `scene3d-manager.ts` | No copies to restore |
| Copy child serialization/deserialization | `shape-manager.ts` | Children no longer created |
| Parent-walk in `_expandGroupSelection` | `scene3d-manager.ts` | No copy parent to walk; direct ID returned from `pickAdditional` |
| BVH intersection for copy picking | `MeshPicker` path | Ray-AABB replaces it for instances |

---

## Efficiency Analysis

### Scene graph size

| Scenario | Old node count | New node count |
|---|---|---|
| Linear array, N=4 | 5 (source + 4 copies) | 1 (group only; source is sibling) |
| Linear array, N=32 | 33 | 1 |
| Grid 4×4, N=16 | 17 | 1 |
| Grid 8×8, N=64 | 65 | 1 |
| 3 arrays of N=10 each | 33 | 3 |

Each `Mesh3D` node is a JavaScript object with ~20 properties (x, y, z, rotationX/Y/Z, scaleX/Y/Z, id, name, visible, locked, gpuDirty, stateDirty, geometryKeyOverride, keyframeTracks, parent reference, event subscriptions). For a 32-copy array, 32 of these objects existed solely to hold a position that could have been a `[number, number, number]` tuple.

Beyond raw memory, each extra node means: more iterations in `getAllMeshes()`, more candidates in `MeshPicker.pickMesh()`, more entries in `_meshInstanceSlots`, more rows in the outliner, more targets for accidentally applying operations to.

### Per-frame work when source is moving (the hot path)

This is the most important comparison — it runs on every frame while the user drags the source.

**Old:**
```
_syncAllArrayGroups():
  for each group (say K groups):
    JSON.stringify({ ...params, sx: source.x, sy: source.y, sz: source.z })
      → string allocation
      → serialize object to string
    compare to cached string
      → string equality check (proportional to string length)
    if changed:
      _rebuildArrayCopyPositions():
        for i in 0..N:
          group.children[i].x = ...    ← property setter → setter may trigger watchers
          group.children[i].y = ...
          group.children[i].z = ...    ← 3 × N property writes through JS objects
        markInstancesDirty()
```

**New:**
```
uploadMeshInstances():
  for each group:
    src.localMatrixVersion !== cached    ← 1 integer comparison per group
  if any dirty:
    computeArrayOffsets(params, sourcePos)
      → [number, number, number][] — pure math, one pass, no allocations
    for i in 0..N:
      data[offset + 12] = srcMat[12] + dx   ← Float32Array index write
      data[offset + 13] = srcMat[13] + dy   ← Float32Array index write
      data[offset + 14] = srcMat[14] + dz   ← Float32Array index write
```

The old path allocated a string, serialized it, compared two strings, then wrote through N JS property setters — each setter going through the object's prototype chain and potentially triggering `localMatrixVersion` bumps on each copy, which would then be picked up by the renderer and cause redundant dirty checks.

The new path does one integer compare and, when dirty, writes directly into a typed array. `Float32Array` writes are not property setters — they're raw memory writes with no dispatch, no prototype chain, no watchers.

### On count change

| Old | New |
|---|---|
| `Mesh3D` allocation × ΔN (if count increased) | 0 allocations |
| `group.addChild()` × ΔN (triggers scene-graph events) | 0 events |
| `geometryKeyOverride` set × ΔN | 0 |
| `group.removeChild()` × ΔN (if count decreased, triggers GC) | 0 GC pressure |
| Reposition all N copies | 0 scene-graph writes |

For live slider drags (the user is dragging the count slider and it fires on every frame), the old path did full scene-graph reconstruction on each event. The new path sets a boolean.

### Serialization size

For a linear array with N=32:

| | Old JSON size | New JSON size |
|---|---|---|
| Per-child overhead | ~140 bytes (id, x, y, z, type, geometryKeyOverride, etc.) | — |
| Total for 32 copies | ~4,500 bytes | 0 bytes |
| Group node itself | ~80 bytes | ~80 bytes |

A 32-copy grid array with `diagonalOnly: false` (35 instances) would have been ~5,000 bytes of copy data in the old format. That's per array group. A scene with several arrays this size would have save-file bloat entirely attributable to redundant copy data that is fully derivable from `arrayParams`.

### Picking per click

| Old | New |
|---|---|
| BVH ray-triangle intersection against N copy meshes | Ray-AABB slab test against N instance AABBs |
| O(N × triangleCount × BVH depth) | O(N × 12 multiplies) |
| For a cube (12 triangles): ~12 × log₂(12) ≈ 43 ops per copy | 12 multiply-adds per instance |
| Also: MeshPicker traverses all meshes in scene first | Only runs if regular pick returns null |

For a dense scene where the user clicks empty space near an array, the old path ran BVH intersection on all copies even when the click missed. The new path runs only when regular picking finds nothing, and the AABB test is a constant 12 operations per instance regardless of mesh complexity.

### GPU draw calls

Both old and new result in the same number of GPU draw calls — one per array (source + instances batched by contiguous slot assignment). The geometry pool's deduplication was already efficient in the old architecture. The improvement here is entirely CPU-side: how the instance buffer gets populated, not how many draw calls are issued.

### Memory layout improvement: `localMatrixVersion` vs. `_arraySyncLastSigs`

The old sync cache was `Map<string, string>` — one JSON string per array group, allocated fresh every frame for comparison. The new cache is `Map<string, number>` — one integer per group, never allocated.

For K array groups, the old system allocated K strings per frame, each proportional in length to the size of `arrayParams` plus three numbers. The new system allocates nothing.

---

## Correctness Notes

### Normal matrix sharing

All instances share the source's normal matrix. This is correct because the normal matrix is `(R×S)⁻ᵀ` — the inverse-transpose of the rotation-scale portion of the model matrix. Translation doesn't affect the inverse-transpose of R×S, so all instances (which differ from the source only by translation) have the same correct normal matrix. The lighting on instance surfaces matches the source exactly.

### Instance buffer layout

Instance model matrices are the source's matrix with only the translation column (floats `[12]`, `[13]`, `[14]` in column-major mat4) overridden. The R×S block (floats `[0..11]`) is copied verbatim from the source. This preserves the source's rotation and scale on all instances — if the user rotates or scales the source, all instances update automatically because the next frame's `uploadMeshInstances` copies the new R×S from the updated source matrix.

### Load-time compatibility

Old saves that included copy children are silently ignored by the updated `recreateNode`. The `3DArrayGroup` case no longer iterates `data.children`. On load, the group is empty; the pre-render sync callback immediately starts supplying it to the renderer, and instances appear as soon as the source is restored by the 3D restore pass. No explicit migration is needed.

---

## Files Changed

| File | Change |
|---|---|
| [src/scene-graph/shapes/array-group-3d.ts](../../src/scene-graph/shapes/array-group-3d.ts) | Added `computeArrayOffsets()` and `getArrayInstanceCount()` exports |
| [src/renderer/3d/renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) | Added `_arrayGroups`, `_arrayGroupFirstSlot`, `_arrayGroupSourceVers`; `setArrayGroups()`; modified `uploadMeshInstances` slot assignment and buffer write; modified `drawMeshes` totalSlots; made `getMeshWorldAABB3D` public |
| [src/services/managers/transform-controller-3d.ts](../../src/services/managers/transform-controller-3d.ts) | Added `pickAdditional?` to `TransformControllerCallbacks`; invoke it in `handlePointerDown` when regular pick returns null |
| [src/services/managers/scene3d-manager.ts](../../src/services/managers/scene3d-manager.ts) | Removed `_arraySyncLastSigs`, `_createArrayCopy`, `_rebuildArrayCopyPositions`, `_syncAllArrayGroups`; added `_selectedGroupId`, `_ensureArrayGroupSync`; rewrote create/update/bake methods; added `pickAdditional` callback with ray-AABB; added `_rayAABBIntersect` module helper |
| [src/services/shape-manager.ts](../../src/services/shape-manager.ts) | `recreateNode` `'3DArrayGroup'` case: removed child iteration |
