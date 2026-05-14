# Texture Restore Bug — GLTF Multi-Mesh Groups
**Last Updated:** 2026-05-13

---

## 1. Intuition

When you import a multi-mesh GLB, Salsa stores the raw bytes and the parsed GPU textures together. On reload, it must reconstruct both the geometry (from serialized vertices) and the textures (from the GLB bytes again). Three independent failure modes combined to make every 3D mesh render black after reload — even though the geometry was always correct.

---

## 2. Mental Model

Think of each GLTF mesh part as a package with three pieces:
1. **Geometry** — vertex and index arrays, always serialized inline in `scene3d.json`.
2. **Texture** — a GPU image decoded from the GLB; can't survive serialization, must be re-decoded on reload.
3. **Material flags** — a packed bitfield (`hasTexture`, `hasNormalMap`, etc.) that tells the shader whether to sample a texture at all.

The restore pipeline must:
a. Re-decode the texture from the GLB bytes.
b. Upload it to the GPU as a `GPUTexture`.
c. Set `material.hasTexture = true` so the fragment shader samples it.
d. Keep doing all of the above correctly across repeated save/reload cycles.

If ANY of a, b, or c breaks for even one cycle, the mesh renders black and the malformed state is written to the next save — making each subsequent reload worse than the one before it.

---

## 3. Formal Explanation — Three Root Causes

### Root Cause 1: Name-based texture matching (index collision)

The GLB stores mesh nodes, each with a name. Many exporters (e.g., Blender with default settings, Sketchfab downloads) give ALL mesh nodes the name `"defaultMaterial"`. The original restore code picked the right texture result with:

```typescript
const r = results.find(r => r.name === state.name) ?? results[0];
```

`find()` returns the **first** match. When all 6 names are `"defaultMaterial"`, every mesh gets `results[0]` — the texture of the first node in the file. For a 6-part model, 5 parts get the wrong texture.

**Fix:** Assign each mesh its **index** in the parsed results array at import time:
```typescript
mesh.glbMeshIndex = i;  // set during _createMeshesFromGltf
```
Serialize `glbMeshIndex` in `toJSON()`. On restore, use it for O(1) lookup:
```typescript
const r = (idx >= 0 && idx < results.length)
    ? results[idx]
    : (results.find(rr => rr.name === state.name) ?? results[0]);
```

### Root Cause 2: Model store degradation across reload cycles

Every imported mesh maps its ID to its raw GLB buffer in `Scene3DManager._modelStore`. When saving, `_buildMeshState` checks `store.has(m.id)` to decide whether to write `glbMeshId` to the JSON. On the first import, all 6 IDs are in the store and all 6 get `glbMeshId`.

After a reload cycle where **some** meshes don't have their GLB buffers re-populated in `_modelStore` (e.g., because an earlier save was written before a fix landed), those meshes get `glbMeshId: undefined`. On the NEXT load, no buffer is passed to `restoreMeshState` for them — so no texture is decoded — so the state is saved again without `glbMeshId`. The system degrades with each cycle.

**Fix:** If a mesh's own ID is missing from the store, `findGroupMemberGlbId` checks its parent `MeshGroup3D` for any sibling that IS in the store, and returns that sibling's ID. Since all parts of a group share the same source GLB, using any sibling's buffer is equivalent. After one reload with the fallback active, the mesh's buffer is re-stored under its own ID and the fallback is no longer needed.

### Root Cause 3: Material flags overwritten by `Object.assign`

Inside `restoreMeshState`, the texture restore happens BEFORE the general material restore:

```typescript
// 1. Re-decode the GLB texture → sets mesh.material.hasTexture = true
this._applyGltfTextures(mesh, r, device);

// ... later in the common post-processing block:

// 2. Restore all saved material properties — overwrites hasTexture with the SAVED value
if (state.material) { Object.assign(mesh.material, state.material); }
```

If the mesh was saved in a degraded state (no texture, so `hasTexture: false`), step 2 immediately undoes step 1. The GPU texture exists on the `Mesh3D` object (`mesh.diffuseTexture !== null`) but the shader flag is `false`, so the fragment shader never samples it. The mesh renders with its diffuse color only — typically (0,0,0) for GLTF models with no base color factor — producing solid black output.

**Fix:** Re-derive the flags from the GPU texture references after the `Object.assign`:
```typescript
if (state.material) { Object.assign(mesh.material, state.material); mesh.gpuDirty = true; }
// Object.assign may have overwritten hasTexture/hasNormalMap with stale saved values.
// Re-derive from actual GPU texture references.
if (mesh.diffuseTexture)   mesh.material.hasTexture   = true;
if (mesh.normalMapTexture) mesh.material.hasNormalMap = true;
```

---

## 4. Why It Matters

This failure mode is **self-compounding**. A single degraded save cycle poisons every subsequent save because:

```
reload → no texture → hasTexture saved as false → next save writes false → next reload overwrites fix
```

Without all three fixes, patching one cause just lets another dominate. All three must land together for the system to converge to a correct state.

---

## 5. Where the Mental Model Breaks

The intuitive model is "if the mesh has a texture object, it will show the texture." This breaks because the **shader decision** (`hasTexture` flag in the material bitfield) is independent of the **mesh object state** (`mesh.diffuseTexture !== null`). They can disagree. The GPU sees only the packed bitfield written by `encodeMaterialFlags` into the per-instance buffer; it never directly inspects the `Mesh3D` object. The two must be kept in sync manually.

---

## 6. Common Confusions

- **"The log says `hasTexture: true` — why does it still look black?"** The log runs before `Object.assign`. The assignment happens in the common post-processing section, after the log, and resets the flag.
- **"Only 2 of 6 meshes have their GLB buffer on reload — did the save fail?"** Not necessarily. The save writes `glbMeshId` only for meshes in `_modelStore`. If the previous RESTORE failed to repopulate `_modelStore` for 4 meshes, those 4 never get `glbMeshId` in the saved state. The OPFS files may still exist under the OLD mesh IDs from the degraded save.
- **"I can see `diffuseTexture: true` in the log — shouldn't it work?"** `mesh.diffuseTexture !== null` only means the GPU texture object was created. The fragment shader reads from the per-instance buffer which encodes `hasTexture` from `mesh.material.hasTexture`, not from the presence of `mesh.diffuseTexture`.

---

## 7. How Salsa Uses It

| File | Role |
|------|------|
| `src/scene-graph/shapes/mesh-3d.ts` | `glbMeshIndex` field + serialized in `toJSON()` |
| `src/services/managers/scene3d-manager.ts` | `_createMeshesFromGltf` sets `glbMeshIndex`; `restoreMeshState` uses it for lookup and re-derives texture flags after `Object.assign`; `findGroupMemberGlbId` provides sibling fallback |
| `src/services/shape-manager.ts` | `_buildMeshState` uses `findGroupMemberGlbId` for degraded-save recovery |
| `src/renderer/3d/renderer-3d.ts` | `encodeMaterialFlags` packs `hasTexture` into the per-instance GPU buffer; must agree with `mesh.material.hasTexture` |

---

## 8. Related Concepts

- [gpu-pipelines.md](gpu-pipelines.md) — how per-instance data reaches the shader
- [euler-rotations.md](euler-rotations.md) — the companion decomposition bug fixed the same day
- [scene-graphs.md](scene-graphs.md) — MeshGroup3D hierarchy and why the sibling fallback works
