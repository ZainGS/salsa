# Frogmarks — .frogmarks Project Package Format

## Why this exists

Frogmarks is a web app. Storing large 3D model files (GLBs, 50–200 MB each) in a backend or cloud bucket is expensive and complex. The `.frogmarks` format bundles everything the user needs to reload a project — raster layers, vector shapes, 3D meshes with their imported GLB files, textures, brush presets, and animation data — into a single portable ZIP that the user downloads locally.

No server round-trip required for 3D assets. The browser download is free.

---

## File format

A `.frogmarks` file is a standard ZIP archive. You can open it in any OS archive tool:

```
project.frogmarks
├── manifest.json          ← document metadata + layer list + 3D node count
├── scene.json             ← vector scene graph (shapes)
├── brushes.json           ← brush presets
├── scene3d.json           ← 3D mesh node states (position, material, keyframes)
├── textures3d.json        ← TextureLibrary snapshot with embedded base64 images
├── layers/
│   └── {layerId}.bin      ← raster layer RGBA pixel data (one file per layer)
├── cels/
│   └── {celId}.bin        ← animation cel pixel data
└── models3d/
    └── {meshId}.glb       ← raw GLB for each GLTF-imported mesh
```

---

## Salsa API

```typescript
import { packProject, unpackProject } from 'salsa/services/persistence/project-package';

// --- SAVE ---
const blob = await packProject({
  docPayload,        // DocumentSavePayload from the state provider
  nodes3d,           // Mesh3D.toJSON() for each mesh in the scene
  models3d,          // Map<meshId, ArrayBuffer> from shapeManager.scene3d.getModelStore()
  textureLibrary,    // from shapeManager.getTextureLibraryData3D()
});
// blob is a standard Blob — trigger a download:
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = `${projectName}.frogmarks`; a.click();
URL.revokeObjectURL(url);

// --- LOAD ---
const data = await unpackProject(file);   // file is a File from a file picker
// data.docPayload   → restore raster layers + scene graph
// data.nodes3d      → restore 3D mesh nodes
// data.models3d     → Map<meshId, ArrayBuffer> of GLB files to re-import
// data.textureLibrary → restore texture library
```

---

## Frogmarks integration: Save

Frogmarks needs to gather the data from ShapeManager before calling `packProject`:

```typescript
async saveProjectToFile(projectName: string): Promise<void> {
  // 1. Get standard document state (layers, scene graph, brushes, animation)
  const docPayload = await this.shapeManager.getDocumentState();   // see note below

  // 2. Get 3D mesh node states
  const nodes3d = this.shapeManager.getAllMeshes3D()
    .map(m => ({ ...m.toJSON(), glbMeshId: this.modelStoreHasMesh(m.id) ? m.id : undefined }));

  // 3. Get raw GLB buffers (only for GLTF-imported meshes)
  const models3d = this.shapeManager.scene3d.getModelStore();

  // 4. Get texture library
  const textureLibrary = this.shapeManager.getTextureLibraryData3D();

  const blob = await packProject({ docPayload, nodes3d, models3d, textureLibrary });
  // ... trigger download
}
```

**All persistence methods are now public** — no extra setup needed:

```typescript
// ── SAVE ────────────────────────────────────────────────────────────
// Full snapshot (layers + scene + brushes + animation + 3D nodes + GLB buffers)
const payload = await shapeManager.snapshotDocument();   // → DocumentSavePayload

// 3D data separately (if you want granular access)
const nodes3d  = shapeManager.getScene3DNodeStates();    // → any[]  (JSON-safe)
const models3d = shapeManager.getGltfBuffers3D();        // → Record<string, ArrayBuffer>

// ── LOAD ────────────────────────────────────────────────────────────
// Full restore (raster + vector + 3D in one call)
await shapeManager.restoreDocument(payload);

// 3D-only restore (after restoring raster/vector separately)
await shapeManager.restoreScene3DNodes(nodes3d, models3d);
```

---

## Frogmarks integration: Load

```typescript
async loadProjectFromFile(file: File): Promise<void> {
  const data = await unpackProject(file);

  // 1. Restore raster layers + scene graph + brushes
  await this.shapeManager.restoreDocumentState(data.docPayload);

  // 2. Restore texture library
  if (data.textureLibrary) {
    await this.shapeManager.restoreTextureLibraryData3D(data.textureLibrary);
  }

  // 3. Restore 3D mesh nodes
  for (const nodeState of data.nodes3d) {
    if (nodeState.glbMeshId && data.models3d.has(nodeState.glbMeshId)) {
      // Re-import from GLB, then apply saved transform/material
      const buffer = data.models3d.get(nodeState.glbMeshId)!;
      const meshes = await this.shapeManager.importGltfBuffer3D(
        nodeState.x, nodeState.y, nodeState.z, buffer
      );
      if (meshes[0]) {
        const m = meshes[0];
        m.name = nodeState.name;
        this.shapeManager.setRotation3D(m.id, nodeState.rotationX, nodeState.rotationY, nodeState.rotation);
        this.shapeManager.setScale3D(m.id, nodeState.scaleX, nodeState.scaleY, nodeState.scaleZ);
        this.shapeManager.setMaterial3D(m.id, nodeState.material);
      }
    } else {
      // Primitive mesh — recreate directly from config
      const mesh = this.shapeManager.createCustomMesh3D(
        nodeState.x, nodeState.y, nodeState.z,
        nodeState.config?.geometry, nodeState.material
      );
      mesh.name = nodeState.name;
      this.shapeManager.setRotation3D(mesh.id, nodeState.rotationX, nodeState.rotationY, nodeState.rotation);
      this.shapeManager.setScale3D(mesh.id, nodeState.scaleX, nodeState.scaleY, nodeState.scaleZ);
    }
  }
}
```

---

## OPFS vs .frogmarks

These are two separate storage mechanisms — use both:

| | OPFS (auto-save) | .frogmarks (export) |
|---|---|---|
| Trigger | Automatic (every 30s + after stroke) | User-initiated ("Save File" button) |
| Location | Browser-private storage | User's local disk |
| Portability | None (browser-only) | Full (shareable, backupable) |
| 3D models | Not stored (currently) | Stored as GLB in ZIP |
| Use case | Don't-lose-work recovery | Export, share, version control |

**Recommendation:** also extend the OPFS save to include `scene3d.json` and model store buffers so the auto-save is complete. That's a separate task from the portable format.

---

## File size expectations

| Content | Typical size (compressed) |
|---|---|
| Raster layers (1920×1080, 4 layers) | 2–8 MB |
| Game Boy Color GLB (low-poly) | 0.5–5 MB |
| Detailed character GLB | 20–80 MB |
| Vector shapes + brushes | < 500 KB |

A typical illustration with 1–3 imported 3D models: **5–25 MB** as a `.frogmarks` file.
