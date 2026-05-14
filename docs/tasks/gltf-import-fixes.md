# GLTF Import Fixes — Task Spec

Identified from two rounds of code review on `scene3d-manager.ts` and `gltf-importer.ts`.
All line numbers reference `src/services/managers/scene3d-manager.ts` unless noted.

---

## Task 1 — Fix stale comment

**Priority:** Trivial  
**File:** `scene3d-manager.ts:753`

Comment says "normalize baked world-space vertices to ~30 units" but `autoScale = 20 / geoSpan`.

**Fix:** Update comment to read `"~20 units"`.

---

## Task 2 — Use `FLOATS_PER_VERT` in all bounding-box loops

**Priority:** Low (latent correctness risk)  
**Files:** `scene3d-manager.ts:471`, `scene3d-manager.ts:759`, `scene3d-manager.ts:1138`

Three bounding-box loops (`computeWorldBounds`, `_createMeshesFromGltf`, `autoScaleToFit`) hardcode `i += 12`. `applySimulatedPositions` already uses `FLOATS_PER_VERT` (line 5424) and the constant is already imported. If the vertex format ever changes, the hardcoded loops will silently produce wrong bounds while `applySimulatedPositions` keeps working.

**Fix:** Replace all three `i += 12` literals with `i += FLOATS_PER_VERT`.

---

## Task 3 — Fix `.gltf` rawBuffer corruption

**Priority:** High (serialization breakage)  
**Files:** `scene3d-manager.ts:622–625` (non-skinned), `scene3d-manager.ts:652–657` (skinned — applies once Task 10 is implemented)

For `.gltf` files, `buffer` holds raw UTF-8 JSON bytes. These bytes are passed as `rawBuffer` into `_createMeshesFromGltf` and stored in `_modelStore`. When `restoreMeshState` later calls `parseGLB(glbBuffer)` on those bytes, it will throw because the data is JSON text, not a GLB binary.

The same corruption will affect the skinned path once Task 10 adds `rawBuffer` pass-through to `_createSkinnedMeshesFromGltf`: `importSkinnedGltfFile` at line 652 decodes the same `buffer` to text and then passes the raw bytes through as `rawBuffer`, recreating the identical bug.

**Fix:** In both `importGltfFile` (line 622) and `importSkinnedGltfFile` (line 652), for `.gltf` branches pass an empty `new ArrayBuffer(0)` instead of `buffer` as `rawBuffer`. Guard `_modelStore.set()` to skip zero-length buffers. On restore, the empty buffer causes `restoreMeshState` to fall back to inline serialized geometry, which is already the correct fallback path.

---

## Task 4 — Add scene-graph emit, selection, and undo to `_createSkinnedMeshesFromGltf`

**Priority:** High (outliner broken, import not undoable)  
**File:** `scene3d-manager.ts:660–741`

`_createSkinnedMeshesFromGltf` adds meshes and skeletons to the scene graph but never calls `emitSceneGraphChanged()`, never updates selection, and pushes no undo entry. The outliner won't update and the user cannot undo a skinned mesh import.

**Fix:** After all meshes and skeletons are added:
- Call `this.ctx.emitSceneGraphChanged()`
- Call `this.ctx.setSelectedNode(meshes[0]?.id)`
- Call `this.renderer3D.setSelectedMeshIds(new Set(meshes.map(m => m.id)))`
- Push an undo entry that removes all created meshes and skeletons and a matching redo

---

## Task 5 — Add `autoScale` normalization to `_createSkinnedMeshesFromGltf`

**Priority:** Medium (metre-scale GLBs import invisible)  
**File:** `scene3d-manager.ts:705–719`

Skinned meshes use raw GLTF positions and scale with no normalization. A GLTF authored in metres will import at a scale ~400× smaller than what the non-skinned path produces, appearing invisible or as a single pixel.

**Fix:** Before the loop in `_createSkinnedMeshesFromGltf`, add the same bounds-scan + `autoScale = 20 / geoSpan` + `geoCX/Y/Z` centering logic from `_createMeshesFromGltf`. Apply to each mesh's position and scale exactly as the non-skinned path does.

---

## Task 6 — Route skinned mesh textures through `_applyGltfTextures`

**Priority:** Medium (normal maps silently dropped on skinned meshes)  
**File:** `scene3d-manager.ts:725–733`

The inline texture block in `_createSkinnedMeshesFromGltf` only handles `r.diffuseImage`. `r.normalMapImage` is ignored entirely. The non-skinned path calls `_applyGltfTextures` which handles both.

**Fix:** Replace the inline diffuse-only block with `this._applyGltfTextures(mesh, r, device)`. Verify that `SkinnedMesh3D extends Mesh3D` (it does — `_applyGltfTextures` takes `Mesh3D`) before making this change.

---

## Task 7 — Cache GLB parse in `restoreMeshState` to avoid N re-parses

**Priority:** Medium (performance — large GLBs parsed once per child mesh)  
**File:** `scene3d-manager.ts:998–1033`

When restoring a multi-mesh GLB group, each child mesh's `restoreMeshState` call independently calls `await parseGLB(glbBuffer)`. For a 6-mesh GLB with embedded textures this means 6 full parses of the same buffer.

**Fix:** Add a `Map<ArrayBuffer, Promise<GltfMeshResult[]>>` parse cache scoped to the restore session. Key on buffer identity; if a parse for this buffer is already in-flight, await the same promise. The cache can live as a local in the project-load call site or as a class-level `WeakMap`.

---

## Task 8 — Clean up `_modelStore` entries in undo callbacks

**Priority:** Medium (memory leak on every undone import)  
**Files:** `scene3d-manager.ts:844–855` (multi-mesh), `scene3d-manager.ts:1256–1267` (single-mesh via `createMesh`)

Neither undo callback deletes the `_modelStore` entries for removed meshes. Every undone import leaves an orphaned `ArrayBuffer` in the store.

**Fix:**
- Multi-mesh undo (line 846): add `for (const m of created) this._modelStore.delete(m.id)` inside the undo callback; restore on redo.
- Single-mesh: `createMesh` is generic and cannot reference `_modelStore`. Move the single-mesh GLB import off the `createMesh` path — give it a dedicated undo entry (matching the multi-mesh pattern) that cleans up `_modelStore` on undo and restores it on redo.

---

## Task 9 — Destroy GPU textures in undo callbacks

**Priority:** Medium (VRAM leak on every undone import)  
**File:** `scene3d-manager.ts:844–855`

GPU textures created by `_applyGltfTextures` are never `destroy()`'d when a mesh is removed via undo.

**Fix:** In the multi-mesh undo callback, before `removeChild`, call:
```ts
for (const m of created) {
    m.diffuseTexture?.destroy();
    m.normalMapTexture?.destroy();
}
```
Apply the same to the single-mesh path once Task 8 creates a dedicated undo entry for it.

---

## Task 10 — Store `rawBuffer` in `_createSkinnedMeshesFromGltf`

**Priority:** Medium (skinned meshes can't serialize for project save/load)  
**File:** `scene3d-manager.ts:660–741`

`_createSkinnedMeshesFromGltf` never calls `_modelStore.set()`. Skinned meshes have no stored GLB buffer, so project save/load cannot restore their geometry or textures from the model store.

**Fix:** Add `rawBuffer: ArrayBuffer` as a parameter (matching `_createMeshesFromGltf`). Call `this._modelStore.set(mesh.id, rawBuffer)` for each created `SkinnedMesh3D`. Update both callers — `importSkinnedGltfBuffer` and `importSkinnedGltfFile` — to pass the buffer through. Add `_modelStore.delete()` in the undo callback added by Task 4.

**Dependency:** Must implement Task 3's `.gltf` empty-buffer guard at the same time. `importSkinnedGltfFile` has a `.gltf` branch (line 652) that, after this task, will pass JSON text bytes as `rawBuffer` — the exact same corruption Task 3 fixes for the non-skinned path. The fix is identical: pass `new ArrayBuffer(0)` for `.gltf` inputs in `importSkinnedGltfFile`.
