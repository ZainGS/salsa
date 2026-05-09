# Frogmarks — GLTF/GLB Import UI

## What was built

Salsa now parses `.glb` (binary GLTF) and `.gltf` (JSON GLTF) files. The importer handles:
- Multi-mesh scenes (each node in the GLTF hierarchy becomes a separate `Mesh3D`)
- Embedded diffuse textures and normal maps (uploaded to GPU automatically)
- `baseColorFactor` → diffuse color
- Node TRS transforms (position, quaternion rotation, scale) applied to each `Mesh3D`
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

## What's not supported (deferred)

- External URI buffers/images (models that reference separate `.bin` or texture files)
- Skeletal/morph animation
- GLTF extensions (`KHR_*`)
- Multiple primitives per mesh node with different materials (imports only first primitive)

For Sketchfab downloads: always use **GLB** format — it embeds everything in one file and is fully supported.
