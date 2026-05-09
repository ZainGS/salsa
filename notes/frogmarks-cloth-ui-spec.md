# Frogmarks Cloth UI Spec — Create & Edit Flows

**Date:** 2026-05-05  
**Status:** Engineering reference — use this to iron out the modal behaviour

---

## The Core Problem: Two Paths Exist and They Conflict

Before anything else, you need to understand why you're seeing inconsistencies.

There are currently **two entirely separate rendering paths** for cloth in Salsa:

### Path A — "Static / CPU Path" (the old system)

```
buildClothGeometry (CPU)
  → ClothSimulator.runToConvergence() (GPU compute, but blocks on readback)
  → positions array on CPU
  → _resolveClothGeometry() (CPU — optionally calls solidifyCloth for thickness)
  → node.setGeometry() (CPU upload to GPU vertex buffer)
  → Renderer3D draws from that vertex buffer
```

This path is used by:
- `simulateCloth()` — the one-shot "run until convergence" function
- `updateClothMeshPose()` — applies a position snapshot to a scene mesh
- `_renderClothPreview()` → `ClothPreviewRenderer` — the canvas in the modal
- Every `setGeometry` call (changing grid params, adding stitches, baking a pose)
- **Thickness (`solidifyCloth`) only works here** — it rebuilds the vertex/index count on the CPU

### Path B — "Live / GPU Pose Path" (the new system)

```
enableLiveCloth() → LiveClothHandle → ClothSimulator.step() (GPU)
  → CLOTH_POSE_SHADER writes positions + normals → poseVertexBuf (STORAGE|VERTEX)
  → Renderer3D._vertexBufferOverrides uses poseVertexBuf directly (zero CPU)
  → rate-limited readback every 8 frames → simState only (no setGeometry)
```

This path is used by:
- `enableLiveCloth()` — live sim on an existing scene mesh
- `createLiveClothSim()` — standalone handle for builder modal preview (partial)
- **Thickness has zero effect here** — `poseVertexBuf` is the single-layer thin cloth, `solidifyCloth` is never called

### Why the preview looks different from the scene mesh

The `ClothPreviewRenderer` is a completely independent `Renderer3D` instance. It has no knowledge of `_vertexBufferOverrides`. It reads `mesh.geometry` — the CPU-side vertex buffer on the `ClothMesh3D` node. 

When Path B is active (`enableLiveCloth` running), the scene mesh renders beautifully via the GPU pose override. But `mesh.geometry` is **stale** — the new `onPositionsUpdate` callback no longer calls `setGeometry()` (we intentionally removed that to eliminate the CPU upload). The preview renderer reads stale geometry, so the preview is frozen or shows the last baked pose.

### Why thickness works in the old path but not the new one

`solidifyCloth()` is a CPU function that **triples the vertex and index count** of the mesh (outer surface + inner surface + wall strip). The `poseVertexBuf` is created at `init()` time from the original geometry's vertex count. The pose shader writes one record per vertex using the original layout. If solidification happened, the vertex count is 3× bigger, the buffer size is wrong, and the pose shader would be writing to the wrong memory. They are structurally incompatible.

**The rule**: thickness/solidification is a bake-time operation. It cannot be previewed live.

---

## What Frogmarks Should Do

The goal is to **use Path B (GPU pose) wherever possible** and fall back to Path A only for:
- The final bake when thickness > 0
- The static preview in the modal before physics is started

Below are the complete Create and Edit flows.

---

## Flow 1 — Create Cloth

This is the flow where no `ClothMesh3D` node exists yet. The user is configuring a new cloth from scratch.

### Phases

```
[Configure] → [Preview (live sim in modal)] → [Simulate to Rest] → [Create]
```

### Step-by-step

#### Phase 1: Modal opens

1. No scene node exists yet. Do not call `createClothMesh()` yet.
2. Resolve default grid + physics config from the UI controls.
3. Create a `LiveClothHandle` for the preview:
   ```typescript
   const handle = scene3d.createLiveClothSim(gridConfig, physicsConfig, 'hang');
   ```
   This handle owns its own `ClothSimulator` and rAF loop. It has a `poseBuffer` (the `poseVertexBuf`).

4. **Do not use `attachClothPreviewCanvas` yet** — that API is for a mesh that already exists in the scene. For Create, you need a different approach (see Preview below).

#### Phase 2: Live preview in the modal

The modal canvas needs to show the live-simulating cloth. There are two options:

**Option A (preferred — zero CPU):**  
Wire the handle's `poseBuffer` directly into the `ClothPreviewRenderer`. This requires adding a `setVertexBufferOverride(buf)` method to `ClothPreviewRenderer` so it can swap the vertex buffer before each `render()` call, the same way `Renderer3D` does it.

When the handle's `poseBuffer` changes (reset/destroy lifecycle), call `preview.setVertexBufferOverride(handle.poseBuffer)`.

The modal then calls `preview.render(stubMesh)` each rAF tick (or on a timer). The stub mesh only needs to carry the index buffer and material — `ClothPreviewRenderer.setVertexBufferOverride` overrides the vertex buffer.

**Option B (simpler to implement, acceptable for a preview):**  
Wire `handle.onPositionsUpdate` to update a temporary `Mesh3D` and re-render the preview:
```typescript
handle.onPositionsUpdate = (positions) => {
    const geom = applySimulatedPositions(result, positions); // CPU path — OK at 7.5fps for a preview
    previewMesh.setGeometry(geom);
    previewMesh.gpuDirty = true;
    preview.render(previewMesh);
};
```
This calls the CPU path at ~7.5fps (rate-limited readback), which is fine for a small preview canvas. The main canvas is not involved at all.

**Which to choose:** Use Option B now (simpler, no changes to `ClothPreviewRenderer`). Option A is the long-term clean path and should be tracked as a future task.

#### Phase 3: User changes grid/physics parameters

When the user changes any grid parameter (cols, rows, cellSize, cornerRadius, activeCells) or physics parameter:

1. Destroy the old handle: `handle.destroy()`.
2. Re-create: `handle = scene3d.createLiveClothSim(newGrid, newPhysics, mode)`.
3. Re-wire `onPositionsUpdate` for the preview (same as Phase 2 setup).

**Do not call `createClothMesh()` or any scene graph mutation here.**

#### Phase 4: User changes only physics (gravity, damping, stiffness, wind)

Grid topology did not change — no need to rebuild:
```typescript
handle.setPhysics({ gravity: newGravity, damping: newDamping });
```
This is a hot update. The sim continues from its current positions.

#### Phase 5: User clicks "Simulate to rest" / "Hang" / "Drape"

This runs a one-shot convergence simulation (not interactive):
```typescript
const positions = await scene3d.simulateCloth(gridConfig, physicsConfig, 'hang');
```
Then update the preview:
```typescript
// Show the converged result in the preview
const geom = _resolveClothGeometry(result, positions, physicsConfig);
previewMesh.setGeometry(geom);
previewMesh.gpuDirty = true;
preview.render(previewMesh);
// Also feed these positions back into the live handle so live sim continues from rest:
handle.reset(gridConfig, physicsConfig, 'hang', undefined, positions);
```

If the user then wants to continue tweaking with live sim, the handle is now seeded from the converged rest pose.

#### Phase 6: User clicks "Create"

At this point you have `positions` (either converged or from the live sim readback) and the final config.

```typescript
// Get current positions for creation
const positions = await handle.snapshot(); // or use last onPositionsUpdate value

// Destroy the preview handle — it was only for the modal
handle.destroy();
previewRenderer.destroy();

// Create the scene node
const meshId = await scene3d.createClothMesh(x, y, z, gridConfig, physicsConfig, positions);
```

**If `physicsConfig.thickness > 0`:**  
`createClothMesh()` calls `_resolveClothGeometry()` which calls `solidifyCloth()` — the thick mesh is baked at creation time. The mesh in the scene is the solidified version. **Live simulation is not supported on solidified meshes** (incompatible vertex counts). Do not call `enableLiveCloth()` after this.

**If `physicsConfig.thickness === 0`:**  
After `createClothMesh()`, if the user wants live physics on the scene mesh:
```typescript
scene3d.enableLiveCloth(meshId);
```
This starts Path B on the newly created mesh.

#### Phase 7: User cancels

```typescript
handle.destroy();
previewRenderer.destroy();
// No scene mutation happened — nothing to undo
```

---

## Flow 2 — Edit Cloth

This is the flow where a `ClothMesh3D` already exists in the scene and the user opens it to edit.

### Phases

```
[Open modal] → [Live preview / parameter changes] → [Apply / Close]
```

### Step-by-step

#### Phase 1: Modal opens

1. Read current config from the node:
   ```typescript
   const node = scene3d.getClothNode(meshId); // returns ClothMesh3D
   const gridConfig   = { ...node.clothConfig };
   const physicsConfig = { ...node.physicsConfig };
   ```

2. **Start live simulation on the scene mesh** (this drives both the main 3D scene and can drive the preview):
   ```typescript
   scene3d.enableLiveCloth(meshId);
   ```
   This: creates a `LiveClothHandle`, wires `poseBuffer` override onto the main `Renderer3D`, seeds from `node.simState.positions` if available.

3. **For the modal preview**: Use `attachClothPreviewCanvas()` to create a preview renderer watching the same mesh:
   ```typescript
   const disposePreview = scene3d.attachClothPreviewCanvas(meshId, previewCanvas);
   ```
   **Problem**: `_renderClothPreview()` is only called from `updateClothMeshPose()`, which with Path B active is never called during the live sim. The preview will be frozen.

   **Fix needed in `enableLiveCloth`**: The `onPositionsUpdate` callback (fired every 8 frames) should also trigger `_renderClothPreview()` when a preview is attached. Change the callback to:
   ```typescript
   handle.onPositionsUpdate = (positions) => {
       if (handle.poseBuffer) {
           // Path B: update simState only, then trigger preview re-render
           const cached = this._clothData.get(meshId);
           if (cached && positions.length === cached.vertexCount * 3) {
               node.simState.positions      = Array.from(positions);
               node.simState.isSimulated    = true;
               node.simState.simulationMode = mode;
               // For modal preview: apply positions to mesh.geometry at 7.5fps
               // (preview renderer reads mesh.geometry, not poseVertexBuf)
               const previewGeom = applySimulatedPositions(cached, positions);
               node.setGeometry(previewGeom);
               node.gpuDirty = true;
               this._renderClothPreview(meshId);  // ← add this
               node.gpuDirty = true;              // reset after preview render
           }
       } else {
           this.updateClothMeshPose(meshId, positions, mode);
       }
       this.ctx.scheduleRender();
   };
   ```
   Note: calling `node.setGeometry(previewGeom)` does NOT break the main scene rendering because the main `Renderer3D` ignores `buf.vertex` for this mesh — it uses `poseVertexBuf` via the override. The preview renderer reads `mesh.geometry` and gets the CPU-side positions.

   This is a rate-limited compromise: the modal preview updates at ~7.5fps, the main scene is smooth at 60fps.

#### Phase 2: User changes physics parameters (gravity, damping, stiffness, wind)

No topology change — hot update:
```typescript
handle.setPhysics({ gravity, damping, stiffness, wind });
```
Get the handle from `scene3d._liveClothHandles.get(meshId)` or expose a `getLiveHandle(meshId)` accessor.

The live sim immediately uses the new parameters. The preview updates at the next 8-frame tick.

#### Phase 3: User changes grid parameters (cols, rows, cellSize, cornerRadius, activeCells)

This requires rebuilding the entire constraint graph and vertex buffer. Use the existing API:
```typescript
scene3d.setClothConfig(meshId, newGridConfig);
```
This method:
1. Calls `buildClothGeometry(newGrid)`
2. Calls `node.setGeometry(_resolveClothGeometry(result, undefined, physicsConfig))` — flat geometry
3. Calls `_refreshLiveSimAfterConstraintChange()` which destroys and recreates the live handle

After this, the live handle is fresh, the poseBuffer override is re-wired via `onPoseBufferChange`, and both the scene and preview show the flat cloth ready to simulate.

#### Phase 4: User changes thickness

Thickness cannot be previewed live. Options for Frogmarks:

**Recommended**: Disable the thickness slider while live simulation is running. Show a tooltip: "Thickness is applied on bake. Disable live simulation or click Apply to see the effect."

**Alternative**: Apply thickness on every "Apply" click (not live). The scene shows the thin live cloth; clicking Apply bakes with thickness.

Do not try to make thickness work during live sim — the vertex buffer topologies are incompatible.

#### Phase 5: User changes pins

```typescript
scene3d.setClothPinnedVertices(meshId, newPinnedVertices);
```
If a live sim is running, this calls `handle.setInverseMass()` internally — pins take effect on the next GPU step. No rebuild needed.

#### Phase 6: User adds/removes stitches

```typescript
scene3d.addClothStitch(meshId, stitch);
scene3d.removeClothStitch(meshId, stitchIndex);
```
These call `_refreshLiveSimAfterConstraintChange()` which rebuilds the constraint graph and resets the live handle. The cloth snaps back to its current simulated positions (saved before reset) and continues from there with the new constraints.

#### Phase 7: User clicks "Apply" / "Close"

**Close without baking** — keep the current live simulated pose as the mesh state:
```typescript
// The live sim stays running after the modal closes.
// simState is updated every 8 frames automatically.
disposePreview();  // destroy the modal preview renderer
// DO NOT disable live sim — let it keep running in the main scene.
```

**Apply and bake** — convert the current live pose to a permanent static mesh:
```typescript
// Get the current converged positions
const positions = await handle.snapshot();

// If thickness > 0, apply solidification
if (physicsConfig.thickness > 0) {
    const result = scene3d._clothData.get(meshId);
    const solidGeom = solidifyCloth(result, positions, physicsConfig.thickness, physicsConfig.solidifyRounded);
    node.setGeometry(solidGeom);
    node.gpuDirty = true;
    // Disable live sim BEFORE setting geometry — override must be cleared first
    await scene3d.disableLiveCloth(meshId, false);
    // setGeometry after disableLiveCloth so the new CPU geometry renders correctly
    node.setGeometry(solidGeom);
    node.gpuDirty = true;
} else {
    // Bake without solidification
    await scene3d.disableLiveCloth(meshId, true); // bakeCurrentPose=true
}

disposePreview();
```

**Why the order matters for thickness bake**:  
`disableLiveCloth(meshId, true)` calls `handle.snapshot()` and `updateClothMeshPose()`, which sets the thin-cloth geometry. Then we overwrite it with the solidified geometry. The `setVertexBufferOverride(meshId, null)` inside `disableLiveCloth` clears the GPU override first, so the renderer falls back to `buf.vertex` — which at that point is the solidified geometry we just set.

#### Phase 8: User cancels

```typescript
// Live sim stays running — it was running before the modal opened.
disposePreview();
// If the user made grid changes that caused a reset, simState may have reset too.
// No undo is provided for in-modal live changes (they're continuous physics, not discrete actions).
```

---

## What Needs to Change in Salsa (not Frogmarks)

These are code changes in Salsa that should be made to support the clean flows above:

### 1. `enableLiveCloth` — trigger preview re-render every 8 frames

In `onPositionsUpdate` (in `scene3d-manager.ts`), when `handle.poseBuffer` is active, additionally call `_renderClothPreview()` so the modal preview stays fresh at ~7.5fps. Also call `applySimulatedPositions` to update `mesh.geometry` for the preview renderer to read. Without this, the modal preview is frozen during live simulation.

### 2. Expose `getLiveHandle(meshId)` or a physics hot-update shortcut

Frogmarks needs to update gravity/damping/wind in real time. Either expose the handle directly, or add a convenience method:
```typescript
setLiveClothPhysics(meshId: string, params: Partial<...>): void
```

### 3. `ClothPreviewRenderer.setVertexBufferOverride()` (future, not urgent)

For the Create Cloth modal (where no scene mesh exists), the preview renderer currently cannot use the `poseVertexBuf` from the standalone `LiveClothHandle`. This means the Create modal falls back to Option B (7.5fps CPU updates via `onPositionsUpdate`). This is acceptable for now but should be improved.

When this is implemented, the preview renderer would call `pass.setVertexBuffer(0, this._override ?? vertexBuf)` just like the main renderer does.

### 4. Thickness UI should be disabled during live simulation

No code change strictly needed — this is a UI constraint in Frogmarks. Just disable the thickness slider when live sim is running. Show a note: "Disable physics or Apply to preview thickness."

---

## Decision Summary

| Situation | Which path | Thickness works? |
|-----------|-----------|-----------------|
| Create modal, before physics started | Path A (flat geometry) | Yes (but not live) |
| Create modal, live preview running | Path B (GPU pose, 7.5fps preview updates) | No — disable slider |
| "Simulate to rest" button | Path A (one-shot, then seed into live) | No — only at creation |
| Scene mesh, live physics off | Path A (baked geometry from last sim) | Yes (baked in) |
| Scene mesh, live physics on (`enableLiveCloth`) | Path B (GPU pose) | No — disable slider |
| Edit modal open with live running | Path B scene + Path A preview at 7.5fps | No — disable slider |
| "Apply / Bake" with thickness | Snapshot → Path A solidify → disable live | Yes — applied at bake |
| "Apply / Bake" without thickness | `disableLiveCloth(true)` bakes pose via Path A | Yes (0 thickness = none) |

---

## Initialization Sequence Summary

### Create Cloth

```
modal opens
  → createLiveClothSim(grid, physics, mode) → handle
  → handle.onPositionsUpdate = fn that updates previewMesh + re-renders previewRenderer
  [user tweaks parameters]
  → changed grid?    → handle.destroy() + createLiveClothSim(newGrid, ...) → new handle
  → changed physics? → handle.setPhysics(params)
  → changed pins?    → handle.destroy() + createLiveClothSim(newGrid, ...) with new pinnedVertices
  [click Create]
  → positions = await handle.snapshot()
  → handle.destroy()
  → createClothMesh(x, y, z, gridConfig, physicsConfig, positions) → meshId
  → thickness === 0 && wantsLive → enableLiveCloth(meshId)
  → disposePreview()
  [cancel]
  → handle.destroy()
  → disposePreview()
  → nothing created
```

### Edit Cloth

```
modal opens for meshId
  → enableLiveCloth(meshId)            ← starts GPU path B on scene mesh
  → disposePreview = attachClothPreviewCanvas(meshId, canvas)
  [user tweaks physics]
  → setLiveClothPhysics(meshId, params) (or handle.setPhysics)
  [user tweaks grid]
  → setClothConfig(meshId, newGrid)    ← rebuilds + restarts live sim automatically
  [user tweaks pins]
  → setClothPinnedVertices(meshId, pins)
  [user adds stitch]
  → addClothStitch(meshId, stitch)
  [user closes / applies]
  → thickness > 0:
      positions = await handle.snapshot()
      disableLiveCloth(meshId, false)
      const geom = solidifyCloth(result, positions, thickness, rounded)
      node.setGeometry(geom); node.gpuDirty = true
  → thickness === 0 && wantsBaked:
      disableLiveCloth(meshId, true)   ← bakes current pose, clears override
  → thickness === 0 && keepLive:
      (do nothing — sim keeps running)
  → disposePreview()
```

---

## FAQ

**Q: Why does the preview show the flat cloth when live sim is running in the modal?**  
A: `ClothPreviewRenderer` reads `mesh.geometry`. With Path B active, `mesh.geometry` is only updated every 8 frames via the `onPositionsUpdate` readback, and only if `enableLiveCloth`'s callback calls `node.setGeometry()`. Without that call (which was removed in the GPU pose optimization), the preview is frozen. The fix is to re-add a lightweight `applySimulatedPositions` + `_renderClothPreview` call inside `onPositionsUpdate` — it runs at 7.5fps which is fine for a small canvas.

**Q: Should I ever call `simulateCloth()` for the Edit modal?**  
A: No. The Edit modal uses `enableLiveCloth()` which starts from `simState.positions` (the last converged state). `simulateCloth()` is for one-shot convergence in Create flow only (the "Simulate to rest" button). In Edit, the live sim itself converges while the user watches.

**Q: Can I have thickness AND live physics at the same time?**  
A: Not with the current architecture. They're structurally incompatible. The simplest rule: if `thickness > 0`, disable live physics controls in the UI. Thickness is always a bake-time property.

**Q: What does `createLiveClothSim()` vs `enableLiveCloth()` do?**  
A: `createLiveClothSim()` creates a standalone `LiveClothHandle` not attached to any scene node — it's purely for the Create modal preview. `enableLiveCloth()` creates a `LiveClothHandle` attached to an existing scene mesh, wires the GPU pose buffer into the main `Renderer3D`, and registers the per-frame tick. Use `createLiveClothSim()` before the mesh exists; use `enableLiveCloth()` after it exists.

**Q: Is the old `simulateCloth` / `updateClothMeshPose` path going away?**  
A: No — it's still used for `disableLiveCloth(true)` (baking), for applying `solidifyCloth` with thickness, and as a fallback when WebGPU isn't available. It just shouldn't be on the critical render path during interactive editing.
