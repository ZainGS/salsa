# Case Study: GLTF Multi-Mesh Import — Exploded Parts Bug

**Date:** 2026-05-14  
**File fixed:** `src/services/managers/scene3d-manager.ts`  
**Fix size:** 1 line  
**Time to find:** ~1 full day

---

## The Problem

Importing a multi-part GLB file (Porygon, 6 meshes) produced a visually "exploded" model — all parts were present but each one appeared at a wildly different scale, scattering the geometry across the scene instead of assembling into the intended shape.

At import time, all 6 meshes had **identical** scale (15.46) and **identical** position (0, -6.218, 1.322). The import was correct. The bug happened later.

---

## Overall Data Flow

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                           IMPORT PATH                                       │
 │                                                                             │
 │  File/Buffer                                                                │
 │      │                                                                      │
 │      ▼                                                                      │
 │  importGltfFile / importGltfBuffer  (scene3d-manager.ts)                    │
 │      │ await file.arrayBuffer()                                             │
 │      │                                                                      │
 │      ▼                                                                      │
 │  parseGLB / parseGLTF  (gltf-importer.ts)                                  │
 │      │ → GltfMeshResult[]  (one per mesh node)                              │
 │      │                                                                      │
 │      ▼                                                                      │
 │  _createMeshesFromGltf  (scene3d-manager.ts)                                │
 │      │ → Mesh3D[] added to MeshGroup3D                                      │
 │      │ → group added to sceneGraph.root                                     │
 │      │ → emitSceneGraphChanged() ◄─ BUG ENTRY POINT                        │
 │      │                                                                      │
 │      ▼ (async microtask, triggered by emitSceneGraphChanged)                │
 │  _scene3dAutoScale  (illustration.component.ts) ← EXTERNAL CONSUMER        │
 │      │ iterates ALL Mesh3D nodes individually                               │
 │      │ calls scene3d.setScale(id, perMeshSpan...)  ← OVERWRITES IMPORT     │
 │      │                                                                      │
 └──────┼──────────────────────────────────────────────────────────────────────┘
        │
        ▼ (next frame — scheduleRender)
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                          RENDER PATH                                        │
 │                                                                             │
 │  WebGPURenderer.render()                                                   │
 │      │                                                                      │
 │      ▼                                                                      │
 │  Renderer3D.draw(meshes)                                                    │
 │      │                                                                      │
 │      ├── uploadMeshInstances(meshes)                                        │
 │      │       │ reads mesh.localMatrix  (= parentChain × _localMatrix)       │
 │      │       │ writes 16-float model matrix per mesh to GPU storage buffer  │
 │      │       │                                                              │
 │      ├── _ensureGeomPool(meshes)                                            │
 │      │       │ uploads vertex/index buffers to GPU                          │
 │      │       │                                                              │
 │      └── draw calls (instanced)                                             │
 │              │ shader reads model matrix from storage buffer                │
 │              │ transforms vertices: clipPos = VP * modelMatrix * pos        │
 │                                                                             │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## Import Method Flow: `_createMeshesFromGltf`

```
_createMeshesFromGltf(ox, oy, oz, results: GltfMeshResult[], rawBuffer)
│
├── 1. UNIFIED BOUNDING BOX
│       Scan all vertices from all results combined (i += 12 per vertex)
│       Track: geoMinX/Y/Z, geoMaxX/Y/Z across all N meshes
│
├── 2. NORMALIZATION CONSTANTS
│       geoSpan = max(rangeX, rangeY, rangeZ)
│       autoScale = 20 / geoSpan          ← single scale for the whole group
│       geoCX/Y/Z = (min + max) / 2       ← geometric center of all parts combined
│
├── 3a. SINGLE MESH PATH (results.length === 1)
│       createMesh(
│         ox + (r.position[0] - geoCX) * autoScale,  ← center at drop point
│         ...
│       )
│       mesh.setScale3D(r.scale * autoScale, ...)
│       _modelStore.set(mesh.id, rawBuffer)
│       return [mesh]
│
└── 3b. MULTI-MESH PATH (results.length > 1)   ← Porygon hits here
        group = new MeshGroup3D()
        │
        for each result r:
        │   mesh = new Mesh3D(
        │     ox + (r.position[0] - geoCX) * autoScale,
        │     oy + (r.position[1] - geoCY) * autoScale,
        │     oz + (r.position[2] - geoCZ) * autoScale,
        │   )
        │   ┌────────────────────────────────────────────────────┐
        │   │ KEY: r.position is [0,0,0] for all parts because   │
        │   │ bakeWorldTransform() already encoded the relative   │
        │   │ offsets into the vertex positions themselves.       │
        │   │ So every mesh gets position = (-geoCX, -geoCY,     │
        │   │ -geoCZ) * autoScale — exactly the same for all 6.  │
        │   └────────────────────────────────────────────────────┘
        │   mesh.setScale3D(autoScale, autoScale, autoScale)
        │   _modelStore.set(mesh.id, rawBuffer)
        │   group.addChild(mesh)
        │
        root.addChild(group)
        emitSceneGraphChanged()   ← triggers _scene3dAutoScale asynchronously
        setSelectedNode(group.id)
        scheduleRender()
        _undoManager.push(...)
```

### What `bakeWorldTransform` does (gltf-importer.ts)

Each GLTF node has its own world matrix (TRS from parent chain). Before returning a `GltfMeshResult`, `buildPrimitive` calls `bakeWorldTransform(vertices, stride, worldMat)`, which:

```
For each vertex:
  position.xyz  = worldMat * position.xyz    ← point transform (w=1)
  normal.xyz    = (worldMat⁻¹)ᵀ * normal.xyz ← normal transform (renormalized)
  tangent.xyz   = same as normal
  tangent.w     = unchanged (handedness)
```

After baking, the returned `GltfMeshResult` has `position: [0,0,0]`, `rotation: [0,0,0]`, `scale: [1,1,1]` — identity TRS. All the relative geometry is encoded in the vertex positions. The parts' spatial relationships are preserved entirely in vertex data.

---

## GPU Upload Path: `uploadMeshInstances` → `writeSlot`

```
uploadMeshInstances(meshes: Mesh3D[])
│
├── Guard: skip if !instancesDirty && !anyGpuDirty && totalSlots unchanged
│
├── Sort meshes by geometryKey (enables contiguous instanced draws)
│
├── Assign slot indices
│       single-material mesh  → one slot each
│       multi-submesh mesh    → one slot per submesh
│
├── _buildTextureAtlas() if atlasDirty or anyGpuDirty
│
└── for each mesh m:
        writeSlot(slot, m, material, texId, normId)
        │
        ├── offset = slot * floatsPerInstance
        │
        ├── localMat = m.localMatrix         ← THIS IS WHAT GETS UPLOADED
        │       │
        │       │   localMatrix getter (shape.ts):
        │       │     parentChainMatrix = computeParentChainMatrix()
        │       │       walks root → parent chain, multiplying _localMatrix
        │       │       for each Shape ancestor
        │       │     return parentChainMatrix × _localMatrix
        │       │
        │       │   _localMatrix is built from scaleX/Y/Z, x/y/z, rotationX/Y/Z:
        │       │     T * Ry * Rx * Rz * S  (column-major mat4)
        │       │
        │       └── col [0,5,10] = scale diagonal
        │           col [12,13,14] = translation
        │
        ├── data[offset..offset+15]   = localMat (modelMatrix, 16 floats)
        ├── data[offset+16..offset+31] = (localMat⁻¹)ᵀ  (normalMatrix, 16 floats)
        └── data[offset+32..]          = material flags, texture atlas indices, etc.
        
Then: device.queue.writeBuffer(instanceStorageBuf, data)
```

The WGSL vertex shader reads `modelMatrix` from the storage buffer:
```wgsl
let worldPos = instance.modelMatrix * vec4f(position, 1.0);
let clipPos  = uniforms.viewProjection * worldPos;
```

---

## The Bug: What Actually Happened

```
IMPORT TIME (correct)
─────────────────────
_createMeshesFromGltf sets:
  mesh[0..5].scaleX = mesh[0..5].scaleY = mesh[0..5].scaleZ = 15.46
  All 6 meshes: uniform scale 15.46, same position (0, -6.22, 1.32)
  ✓ Parts would assemble correctly

emitSceneGraphChanged() fires
       │
       └── (async microtask) _scene3dAutoScale  [illustration.component.ts]
               │
               │ for each mesh node in the scene graph individually:
               │   compute spanX = max(v[0], ...) - min(v[0], ...)  ← per-mesh only
               │   spanY = max(v[1], ...)  - min(v[1], ...)
               │   targetScale = TARGET_SIZE / max(spanX, spanY)    ← different per part
               │   scene3d.setScale(mesh.id, targetScale, targetScale, targetScale)
               │         │
               │         └── mesh.setScale3D(74, 74, 74)   ← Torso:  big geo, big span
               │             mesh.setScale3D(105, 105, 105) ← Arm:   medium geo
               │             mesh.setScale3D(145, 145, 145) ← Beak:  small geo, small span
               │             ...
               │   ✗ 6 different scales destroy the assembled group
               │

RENDER TIME (wrong)
────────────────────
uploadMeshInstances reads mesh.localMatrix:
  mesh[0] localMatrix: scale=74  → uploaded to slot 0
  mesh[1] localMatrix: scale=105 → uploaded to slot 1
  mesh[2] localMatrix: scale=145 → uploaded to slot 2
  ...
  ✗ Parts render at different scales → exploded model
```

---

## Why the Math Was Fundamentally Incompatible

The import and `_scene3dAutoScale` make opposite assumptions about what "scale" means for a mesh.

**The import** computes `autoScale` from the *combined* bounding box of all 6 parts together:

```
autoScale = 20 / max(totalRangeX, totalRangeY, totalRangeZ)
```

Every part gets this *same* number. Because all parts are scaled identically, their *relative sizes* are preserved. A torso that is 4× larger than a beak in the original model stays 4× larger after import. The parts assemble because the vertex positions (baked into world space by `bakeWorldTransform`) plus the uniform scale reconstruct the original geometry.

**`_scene3dAutoScale`** computes its scale from each mesh's *own* bounding box individually:

```
for each mesh:
    targetScale = TARGET_SIZE / max(mesh.ownSpanX, mesh.ownSpanY)
```

Every part is rescaled to fit within `TARGET_SIZE` *on its own*, regardless of its size relative to the other parts. This is correct behavior for a standalone mesh — it normalizes a tiny 0.01-unit object and a massive 1000-unit object to the same comfortable viewing size. But applied to group members it destroys the relative proportions: the beak (small span → large targetScale) blows up to the same visual footprint as the torso (large span → small targetScale).

```
IMPORT CONTRACT                 _scene3dAutoScale CONTRACT
──────────────────────────────  ────────────────────────────────────────
combined span = 1.294 units     torso span = 0.271 units
autoScale = 20 / 1.294 = 15.46  torso targetScale = 20 / 0.271 = 73.8
                                beak  span = 0.138 units
                                beak  targetScale = 20 / 0.138 = 144.9

All 6 parts → scale 15.46       torso → 73.8, beak → 144.9, ...
  ✓ Relative sizes preserved      ✗ All parts forced to same visual size
  ✓ Parts assemble                ✗ Parts explode
```

The two contracts are mutually exclusive. Any feature that normalizes individual meshes to a target visual size will always break multi-mesh groups whose parts have different spans — which is every real model.

---

## Why the Import Logs Looked Correct

At import time, directly after `setScale3D`, the values were right (15.46 on all 6). The `_scene3dAutoScale` override happens as an async microtask queued by `emitSceneGraphChanged()` — it runs *after* the synchronous import code returns but *before* the first render frame. Any log at import time sees the correct state; any log at render time sees the corrupted state.

This is why tracing the import math was a dead end — the math was fine. The GPU upload log was the only place that could reveal the discrepancy, because it reads the values at render time after all async side effects have settled.

---

## The Fix

**`src/services/managers/scene3d-manager.ts` — `setScale()`**

```typescript
setScale(nodeId: string, sx: number, sy: number, sz: number): void {
    const mesh = this.getMesh(nodeId);
    if (mesh) {
        if (mesh.parent instanceof MeshGroup3D) return;  // ← THE FIX
        mesh.setScale3D(Math.max(sx, 1e-6), Math.max(sy, 1e-6), Math.max(sz, 1e-6));
        this.ctx.scheduleRender();
        return;
    }
    // ...group handling
}
```

If a mesh belongs to a `MeshGroup3D`, external `setScale` calls are silently ignored. The group's scale was already set correctly by the importer and can only be changed through group-level operations.

`_scene3dAutoScale` legitimately serves standalone meshes — it normalizes their view size for a good first impression. The fix is minimal: the engine's `setScale` gate, not a change to the consumer.

---

## Debugging Lessons

### 1. For async overwrite bugs: instrument the GPU upload path, not the import path

If geometry looks correct in the scene graph at import time but wrong on screen, add a log inside `writeSlot` in `uploadMeshInstances` that prints the scale diagonal from `m.localMatrix` (`[0]`, `[5]`, `[10]`). That log fires at render time — after all async side effects — and shows exactly what the shader sees. Any delta between import values and upload values means something modified the scene graph asynchronously between those two points.

### 2. The stack trace is the fastest path to the culprit

Once the render-time log showed wrong scales, a single `console.trace()` inside `setScale3D` in the next render cycle printed the full call stack, showing `_scene3dAutoScale` at `illustration.component.ts:1000`. That single trace replaced hours of reading code.

### 3. Multi-file async bugs don't appear in the file you're debugging

The entire bug was in `illustration.component.ts`, a consumer file outside the engine. Reading `scene3d-manager.ts`, `gltf-importer.ts`, `renderer-3d.ts`, and `shape.ts` exhaustively would never find it. When all engine code checks out, look for side effects triggered by events the engine emits.

---

## Related Files

- [src/services/managers/scene3d-manager.ts](../../src/services/managers/scene3d-manager.ts) — `setScale` fix (~line 2161), `_createMeshesFromGltf`
- [src/scene-graph/shapes/mesh-group-3d.ts](../../src/scene-graph/shapes/mesh-group-3d.ts) — `MeshGroup3D` type used in the guard
- [src/scene-graph/shapes/base/shape.ts](../../src/scene-graph/shapes/base/shape.ts) — `localMatrix` getter, `updateLocalMatrix`, `parentChainMatrix`
- [src/renderer/3d/renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) — `uploadMeshInstances`, `writeSlot` (~line 1278)
- [src/renderer/3d/gltf-importer.ts](../../src/renderer/3d/gltf-importer.ts) — `bakeWorldTransform`, `buildPrimitive`, `parseGLB`
- [docs/tasks/gltf-import-fixes.md](../tasks/gltf-import-fixes.md) — 10 follow-up GLTF import bugs identified during this investigation
