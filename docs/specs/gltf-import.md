# Frogmarks — GLTF/GLB Import UI
**Last Updated:** 2026-05-13  

> **Status: COMPLETE** — Both regular and skinned GLTF/GLB import are implemented. Skinned mesh import (`parseSkinnedGLB`, `importSkinnedGltfFile3D`) was added in Phase A (May 2026). Texture restore on reload fixed May 2026 (see [Texture Restore Bug Fix](#texture-restore-bug-fix-2026-05-13)).

> **Status: COMPLETE** — Both regular and skinned GLTF/GLB import are implemented. Skinned mesh import (`parseSkinnedGLB`, `importSkinnedGltfFile3D`) was added in Phase A (May 2026).

## What was built

Salsa now parses `.glb` (binary GLTF) and `.gltf` (JSON GLTF) files. The importer handles:
- Multi-mesh scenes (each node in the GLTF hierarchy becomes a separate `Mesh3D`)
- **Auto-grouping**: when a GLB contains more than one mesh, all meshes are automatically placed under a single `MeshGroup3D` named after the file (e.g. importing `porygon.glb` creates a group called `"porygon"` containing all part meshes)
- Embedded diffuse textures and normal maps (uploaded to GPU automatically)
- `baseColorFactor` → diffuse color
- Node TRS transforms (position, quaternion rotation, scale) applied to each `Mesh3D`
- Zero-scale guard: GLB exporters occasionally emit `scale:[0,0,0]` for hidden/collapsed parts; each axis is clamped to `1e-6` to avoid a non-invertible local matrix
- Missing normals → recomputed automatically
- Missing tangents → computed by Salsa's `computeTangents` pass
- Transparent materials (`alphaMode: BLEND`) flagged correctly

OBJ import still works as before.

---

## API

```typescript
// From a drag-and-drop or file-picker File (recommended)
const meshes: Mesh3D[] = await shapeManager.importGltfFile3D(x, y, z, file);

// From a pre-loaded ArrayBuffer (if you already have the bytes)
const meshes: Mesh3D[] = await shapeManager.importGltfBuffer3D(x, y, z, buffer);

// OBJ (unchanged)
const mesh: Mesh3D = await shapeManager.importObjFile3D(x, y, z, file);
```

Both GLTF methods return `Mesh3D[]` (array) because a single GLB can contain many meshes. Each mesh is already added to the scene and selected.

**Multi-mesh (auto-grouped) imports:** when the GLB contains more than one mesh the returned array contains the child `Mesh3D` nodes. A `MeshGroup3D` parent is also created and added to the scene — it is not included in the returned array but is the selected node in the outliner (`setSelectedNode` is called with the group's ID). Clicking any part mesh on the canvas will bubble the selection up to the whole group; individual parts can be selected via the outliner.

**Single-mesh imports:** the single `Mesh3D` is returned and selected normally; no group is created.

---

## UI: drag-and-drop handler

```typescript
onFileDrop(event: DragEvent): void {
  event.preventDefault();
  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'glb' || ext === 'gltf') {
      this.shapeManager.importGltfFile3D(0, 0, 0, file)
        .then(meshes => console.log(`Imported ${meshes.length} mesh(es): ${meshes.map(m => m.name).join(', ')}`))
        .catch(err => this.showError(`Failed to import ${file.name}: ${err.message}`));
    } else if (ext === 'obj') {
      this.shapeManager.importObjFile3D(0, 0, 0, file)
        .then(() => {})
        .catch(err => this.showError(`Failed to import ${file.name}: ${err.message}`));
    }
  }
}
```

Also wire a file input `accept=".glb,.gltf,.obj"` as a fallback for browsers without drag-and-drop.

---

## UI: import button in 3D panel

Add an **Import Model** button to the 3D panel toolbar (next to the existing add-primitive buttons):

```
[ + Box ] [ + Sphere ] [ ... ] [ ↑ Import Model ]
```

On click: open a file picker filtered to `.glb,.gltf,.obj`. On file selected: call the appropriate import method above.

---

## Scale / coordinate note — AUTO-SCALE IMPLEMENTED ✓

GLTF files use **metres** as their unit. A typical character model might be 1.8 units tall. Salsa's illustration canvas uses **pixels** as its world unit.

**Auto-scale is now built in.** After every `importGltfFile3D` / `importGltfBuffer3D` call, Scene3DManager automatically calls `autoScaleToFit()` on the imported meshes. The scale is only applied when the bounding-box span is < 5% of the target size (400 world units default), so correctly-sized models are never touched.

If you need manual control:

```typescript
// After import, auto-scale a specific set of meshes to ≤400px span
shapeManager.autoScaleToFit3D(meshIds, 400);

// Or expose a "Scale to Fit" button:
shapeManager.frameAllMeshes3D();
```

---

## Selection behavior for grouped imports

When a multi-mesh GLB is imported, clicking any part on the canvas selects the **entire group**, not the individual part. The selection box drawn around the group is a single unified world-space AABB enclosing all part meshes — not N separate OBBs.

To select an individual part, use the outliner. Part meshes do not show corner scale handles when the group is selected; corner dragging is only available for single-mesh selections.

---

## Group transforms

`setPosition`, `setScale`, and `setRotation` all accept a group ID. Transforms are propagated to all child `Mesh3D` nodes:

- **Position**: a delta (new minus current group position) is added to each child's world position.
- **Rotation**: the rotation delta is added to each child's individual rotation.
- **Scale**: a factor (`new / old`) is applied to each child's scale AND to each child's position relative to the group centroid, keeping the group from shearing apart.

`MeshGroup3D` tracks `groupPos3D`, `groupScale3D`, and `groupRot3D` internally to allow correct delta computation across successive calls. These fields are **not serialized** — only the individual child transforms are persisted.

---

## Restore behavior (GLB re-load)

On document restore, `restoreMeshState` prioritizes saved geometry over re-importing the GLB:

1. If `state.config.geometry.vertices` is present (serialized inline by `Mesh3D.toJSON()`), the mesh is recreated directly from those vertices — no GLB parsing.
2. After the mesh is created, the GLB is parsed **once more** to extract textures only (matching by mesh name). Textures are re-uploaded via `_applyGltfTextures`. A parse failure in this step is caught silently so a broken or missing GLB does not prevent mesh restore.

This avoids the duplicate-group bug: calling `importGltfBuffer` unconditionally during restore would parse the full multi-mesh GLB and create a new group for every child, producing N groups instead of one.

---

## Group hierarchy serialization (handled automatically — 2026-05-13)

Group hierarchy is now persisted and restored automatically by the engine. No Frogmarks-side code is required.

**How it works**: the scene graph JSON (`scene.json` / `sceneGraphJSON`) always contains the full node tree including `MeshGroup3D` containers and their children. During restore, `recreateNode` now preserves the serialized IDs of both groups and their child meshes. The `restoreDocumentState` path captures the group–child mapping before the mesh-clear step, then re-populates each group with its restored (and now textured) children after `restoreMeshState` completes. The `.frogmarks` load path similarly detects existing meshes by their preserved IDs, so no duplicates are created and group membership is never lost.

`getScene3DHierarchy()` and `addMeshToGroup3D()` remain public for custom use cases, but are no longer needed for standard save/restore.

---

## Euler Order Bug Fix (2026-05-13)

`decomposeWorldMatrix` in `gltf-importer.ts` was using the **ZYX** decomposition formula (`asin(-r[2][0])`) while the engine composes rotations in **YXZ** order (`Ry · Rx · Rz`). For any mesh whose world matrix had combined rotations around more than one axis, the extracted Euler angles were wrong — the engine would re-apply them in the wrong order and produce a different rotation than the original.

Visually this showed as child meshes with combined hierarchy rotations (e.g. eyes on a tilted head node) appearing slightly displaced relative to their authored position. Meshes with single-axis or zero rotation were unaffected and looked correct.

**Fix:** `decomposeWorldMatrix` now uses the YXZ formulas:
```typescript
rx = asin(-r12);         // r12 = m[9]/sz  — matches -sin(rx) in Ry·Rx·Rz
ry = atan2(r02, r22);    // sin(ry)/cos(ry) — relative to col-2 of rotation
rz = atan2(r10, r11);    // sin(rz)/cos(rz) — relative to col-0/col-1
```

The fix is consistent with `quatToEulerYXZ` in `transform-controller-3d.ts`, which was already correct.

See [Euler Rotations theory doc](../theory/euler-rotations.md) for the full derivation and matrix formulas.

---

## Texture Restore Bug Fix (2026-05-13)

After page reload, GLTF-imported meshes would appear **dark/black** instead of showing their correct colors. Three root causes were identified and fixed:

### Root Cause 1 — All-same mesh name (`glbMeshIndex`)

GLB exporters frequently name every mesh node `"defaultMaterial"`. The restore path matched textures by name (`results.find(r => r.name === state.name)`), so every mesh in the group hit `results[0]` and got the same (wrong) texture.

**Fix:** `Mesh3D` now carries a `glbMeshIndex: number | null` property set during import (the position of this mesh in the GLB's parsed result array). `toJSON()` serializes it. `restoreMeshState` uses it for O(1) index lookup, falling back to name-search only for states saved before the fix.

```typescript
// import path (_createMeshesFromGltf)
mesh.glbMeshIndex = i;   // i = loop index in results[]

// restore path (restoreMeshState)
const idx = state.glbMeshIndex ?? -1;
const r = (idx >= 0 && idx < results.length)
    ? results[idx]
    : (results.find(rr => rr.name === state.name) ?? results[0]);
```

### Root Cause 2 — Missing GLB buffers after reload (`findGroupMemberGlbId`)

The GLB buffer for each mesh is stored in `_modelStore` (keyed by mesh ID) and written to OPFS as `models3d/{meshId}.glb`. During restore, `_buildMeshState` checks `store.has(m.id)` to decide whether to set `glbMeshId`. After a degraded save cycle (where some mesh IDs were lost from `_modelStore`), those 4 of 6 meshes would have `glbMeshId: undefined`, so their buffers were never passed to `restoreMeshState`.

**Fix:** `Scene3DManager.findGroupMemberGlbId(meshId)` walks the parent `MeshGroup3D`'s children and returns any sibling's ID that IS in the model store. `_buildMeshState` uses this as a fallback for `glbMeshId`. After one reload with the fallback active, `restoreMeshState` repopulates `_modelStore` for the previously-missing mesh and the system self-heals.

### Root Cause 3 — `Object.assign` clobbering texture flags

`_applyGltfTextures` correctly set `mesh.material.hasTexture = true`, but the common post-restore section `Object.assign(mesh.material, state.material)` ran AFTER and overwrote it with the stale `false` value from a degraded save.

**Fix:** After `Object.assign`, re-derive texture flags from the actual GPU texture references:
```typescript
if (mesh.diffuseTexture)   mesh.material.hasTexture   = true;
if (mesh.normalMapTexture) mesh.material.hasNormalMap = true;
```

See the companion theory doc: [texture-restore-bug.md](../theory/texture-restore-bug.md).

---

## Stale Rotation Angles After Re-import (Known Issue)

If a multi-mesh GLB was imported **before** the YXZ Euler fix (2026-05-13) and then **saved**, the stored mesh states contain the wrong rotation angles. On reload, the meshes appear assembled incorrectly (parts floating away from where they should be).

**Fix:** Delete the imported group from the scene and re-import the GLB. The new `decomposeWorldMatrix` produces correct YXZ angles and all parts will align as authored.

---

## Illustration Mode Camera Drift When DevTools Is Open

This is a known visual artifact, not a data bug. In illustration mode the 3D camera is synced to the 2D viewport via `syncIllustrationCamera(panX, panY, zoom, canvas.width, canvas.height)` where `canvas.width/height` are **physical pixels** (DPR-multiplied) but `panX/panY` accumulate from `event.clientX/clientY` which are **logical CSS pixels**. When Chrome DevTools docks to the browser window it changes `window.innerWidth/Height`, which triggers `setCanvasSize` and re-fires `syncIllustrationCamera` with new physical dimensions.

**Visible effect:** immediately after DevTools opens/closes, 3D meshes may appear at shifted positions or different apparent scales relative to the 2D canvas content. The mesh **world-space data is correct** — only the camera projection temporarily mismatches the 2D world matrix.

**Workaround:** close DevTools (or undock it to a separate window), or pan/zoom slightly to force a `syncIllustrationCamera` call with consistent dimensions.

---

## What's not supported (deferred)

- External URI buffers/images (models that reference separate `.bin` or texture files)
- Skeletal/morph animation
- GLTF extensions (`KHR_*`)
- Multiple primitives per mesh node with different materials (imports only first primitive)

For Sketchfab downloads: always use **GLB** format — it embeds everything in one file and is fully supported.
