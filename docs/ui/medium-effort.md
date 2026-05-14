# Frogmarks UI Spec — Medium Effort Features (May 2026)
**Last Updated:** 2026-05-08  

Two new Salsa features with UI surfaces in Frogmarks.
All APIs are on `shapeManager` (the global singleton, `sm`).

---

## 1. Grid Snapping (Ctrl+Drag)

### What it does

Holding **Ctrl** while dragging any gizmo (move / rotate / scale) snaps the
transform to discrete increments:

| Mode   | Snap unit                     | Default       |
|--------|-------------------------------|---------------|
| Move   | `sm.snapGridSize3D` (world units) | 1.0           |
| Rotate | `sm.snapAngle3D` (radians)    | π/12 = 15°    |
| Scale  | `sm.snapScaleStep3D` (factor) | 0.25          |

No Frogmarks wiring is needed to activate snapping — Salsa detects `ctrlKey`
from the pointer event automatically. Frogmarks only needs to:

1. Provide optional snap-settings UI (panel or popover).
2. Optionally show a snap indicator while dragging.

### API

```ts
// Read / write snap settings at any time (persist in user prefs)
sm.snapGridSize3D    // default 1.0  (world units)
sm.snapAngle3D       // default Math.PI / 12  (15°)
sm.snapScaleStep3D   // default 0.25

// True while Ctrl is held during a drag
sm.snapActive3D      // boolean (read-only)
```

### UI touchpoints

#### Snap settings panel / popover

Show these three inputs anywhere in the 3D toolbar or a settings drawer.
Label in degrees for rotate (convert: `sm.snapAngle3D * 180 / Math.PI`).

```
┌──────────────────────────────────────────┐
│  Snap Settings                           │
│                                          │
│  Grid size   [ 1.0  ] world units        │
│  Rotate      [  15  ] degrees            │
│  Scale step  [ 0.25 ]                    │
└──────────────────────────────────────────┘
```

```ts
// On input change:
sm.snapGridSize3D   = parseFloat(gridInput.value);
sm.snapAngle3D      = parseFloat(rotateInput.value) * Math.PI / 180;
sm.snapScaleStep3D  = parseFloat(scaleInput.value);
```

#### Snap indicator (optional but recommended)

While `sm.snapActive3D` is true, show a small badge near the gizmo or in the
toolbar:

```
🔲 SNAP  (shown while Ctrl is held)
```

Poll `sm.snapActive3D` each animation frame alongside `sm.getDragInfo3D()` to
show/hide the badge without any extra events.

#### Degree readout already works

The existing rotation drag readout (`sm.getDragInfo3D().angleDeg`) already
reflects the snapped angle — no changes needed there.

---

## 2. Multi-Material Slots (Submesh Model)

### What it does

Each `Mesh3D` can now have multiple **submeshes**, each with its own
`Material3D`. This mirrors GLTF's multi-primitive model and Blender's material
slot workflow.

A submesh is defined by an index range into the mesh's shared geometry buffer:

```ts
interface Submesh3D {
  label?: string;       // e.g. "Body", "Eyes", "Glass"
  indexOffset: number;  // byte offset into the index buffer
  indexCount: number;   // number of indices in this submesh
  material: Material3D; // independent material per submesh
}
```

When a mesh has submeshes, the main `mesh.material` is ignored; each submesh's
material drives rendering instead.

### API

```ts
// ── Submesh CRUD ────────────────────────────────────────────────────

sm.getMeshSubmeshes3D(meshId): Submesh3D[]
// Returns the submesh list (empty if mesh uses a single material).

sm.setMeshSubmesh3D(meshId, slotIndex, partial: Partial<Submesh3D>): void
// Update label or material on an existing slot.
// slotIndex must be within bounds of the current submesh list.

sm.appendMeshSubmesh3D(meshId, submesh: Submesh3D): void
// Add a new submesh slot at the end (for procedural mesh building).

sm.removeMeshSubmesh3D(meshId, slotIndex): void
// Remove a submesh slot. If the list becomes empty the mesh falls back
// to its top-level material.

sm.clearMeshSubmeshes3D(meshId): void
// Remove all submesh slots (revert to single-material mode).
```

### UI touchpoints

#### Material slots panel (Inspector → Materials tab)

Replace the single material swatch in the 3D inspector with a slot list.
When `submeshes.length === 0`, show the current single-material UI unchanged.

```
┌────────────────────────────────────────────────┐
│ MATERIALS                           [+ Add]    │
│                                                │
│  [0] Body     ████ DiffuseColor  [✏ Edit] [🗑] │
│  [1] Eyes     ████ DiffuseColor  [✏ Edit] [🗑] │
│  [2] Glass    ████ DiffuseColor  [✏ Edit] [🗑] │
└────────────────────────────────────────────────┘
```

**Populate the list:**
```ts
const submeshes = sm.getMeshSubmeshes3D(selectedMeshId);
// render a row per submesh
```

**Edit a material (e.g., diffuse color):**
```ts
sm.setMeshSubmesh3D(selectedMeshId, slotIndex, {
  material: { ...currentMaterial, diffuseColor: [r, g, b, a] },
});
```

**Rename a slot:**
```ts
sm.setMeshSubmesh3D(selectedMeshId, slotIndex, { label: newName });
```

**Remove a slot:**
```ts
sm.removeMeshSubmesh3D(selectedMeshId, slotIndex);
refreshMaterialPanel();
```

**Revert to single material (clear all slots):**
```ts
sm.clearMeshSubmeshes3D(selectedMeshId);
```

#### Texture assignment per slot

Each submesh's material has the same texture fields as the top-level material.
The existing texture-picker UI can be reused per slot row:

```ts
sm.setMeshSubmesh3D(selectedMeshId, slotIndex, {
  material: { ...currentMaterial, textureId: newTextureId },
});
```

#### Render style per slot

Each submesh can have its own `renderStyle` (e.g., one slot opaque, one
transparent for glass):

```ts
sm.setMeshSubmesh3D(selectedMeshId, slotIndex, {
  material: { ...currentMaterial, renderStyle: 'transparent' },
});
```

#### Import note

When importing GLTF/GLB (`sm.importGLTF3D`), meshes with multiple GLTF
primitives will automatically arrive as multi-submesh `Mesh3D` objects with
`submeshes` pre-populated. The material slot UI will just work without extra
wiring.

---

## API Reference Summary

```ts
// ── Grid snapping ─────────────────────────────────────────────────
sm.snapGridSize3D   // get/set — position snap grid (world units, default 1.0)
sm.snapAngle3D      // get/set — rotation snap (radians, default π/12 = 15°)
sm.snapScaleStep3D  // get/set — scale snap step (default 0.25)
sm.snapActive3D     // read-only boolean — true while Ctrl is held in a drag

// ── Multi-material submeshes ──────────────────────────────────────
sm.getMeshSubmeshes3D(meshId): Submesh3D[]
sm.setMeshSubmesh3D(meshId, slotIndex, partial: Partial<Submesh3D>): void
sm.appendMeshSubmesh3D(meshId, submesh: Submesh3D): void
sm.removeMeshSubmesh3D(meshId, slotIndex): void
sm.clearMeshSubmeshes3D(meshId): void
```
