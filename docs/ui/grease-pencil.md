# Frogmarks — Grease Pencil 3D UI Guide
**Last Updated:** 2026-05-10

Grease Pencil lets users draw 2D strokes in 3D world space — directly on or around 3D characters. Strokes can be bone-parented (they follow the character's skeleton), keyframe-animated, and filled with a flat color.

---

## Concepts

| Concept | What it is |
|---------|-----------|
| **GP Object** | The container — like a raster layer group. Holds one or more layers. |
| **GP Layer** | Organizes strokes within a GP object. Rendered bottom-to-top. |
| **GP Stroke** | A single drawn line — a polyline of 3D world-space points with color, width, and optional fill. |
| **Bone parenting** | Stroke follows a skeleton joint (`parentJoint` = joint name). Zero CPU cost — done in the vertex shader. |
| **Keyframe** | A frame-specific override for a layer's strokes. Frames without a keyframe fall back to the base strokes. |

---

## Panel layout

```
┌─ Grease Pencil ──────────────────────────────────────┐
│  [+] New GP Object   [Name field]   [🗑 Delete]       │
├──────────────────────────────────────────────────────┤
│  Layers:                                              │
│    ● Outlines    👁  [+] [🗑]                         │
│    ● Fills       👁  [+] [🗑]                         │
│                  [+ Add Layer]                        │
├──────────────────────────────────────────────────────┤
│  Stroke settings:                                     │
│    Color: ████   Width: [2.0]   Opacity: [1.0]       │
│    Fill:  ████ (optional — check "Filled" to enable) │
│    Parent joint: [none ▾]   Closed: [ ]              │
├──────────────────────────────────────────────────────┤
│  Keyframes:                                           │
│    [Set Keyframe]  [Clear Keyframe]  Frame: [24]     │
└──────────────────────────────────────────────────────┘
```

---

## API quick reference

All GP calls go through `ShapeManager` (injected from the Salsa engine).

### Object & layer management

```typescript
// Create a GP object (returns gpId).
const gpId = sm.createGpObject3D('Hero outlines', skeletonId?);

// Add a layer to a GP object (returns layerId).
const layerId = sm.addGpLayer3D(gpId, 'Outlines');

// Remove a layer.
sm.removeGpLayer3D(gpId, layerId);

// Remove the whole GP object.
sm.removeGpObject3D(gpId);
```

### Drawing strokes (pointer events)

```typescript
// On pointerdown — start a new stroke.
const strokeId = sm.beginGpStroke3D(
  gpId,
  layerId,
  { r: 0, g: 0, b: 0, a: 1 },  // stroke color
  0.02,                          // baseWidth in world units
  {
    fillColor:   { r: 1, g: 0.8, b: 0.2, a: 1 }, // optional fill
    parentJoint: 'chest',                           // optional bone name
    closed:      false,
  },
);

// On pointermove — add world-space points (project pointer to 3D as needed).
sm.addGpPoint3D(worldX, worldY, worldZ, pressure, opacity);

// On pointerup — finalize (strokes with < 2 points are auto-discarded).
sm.endGpStroke3D();
```

### Erase tool

```typescript
// On pointermove while eraser active — erase nearby strokes.
sm.eraseGpStrokes3D(
  gpId,
  layerId,
  [worldX, worldY, worldZ],  // eraser center
  0.1,                         // radius in world units
  frame?,                      // target a keyframe's strokes (optional)
);
```

### Keyframe animation

```typescript
// Save a keyframe snapshot of the layer's current strokes.
sm.setGpKeyframe3D(gpId, layerId, frame);

// Remove the snapshot (layer reverts to base strokes at that frame).
sm.clearGpKeyframe3D(gpId, layerId, frame);
```

---

## Getting 3D world position from a pointer event

Grease Pencil draws at a fixed Z depth relative to the camera or snaps to a character mesh surface.

**Fixed depth (simplest):**
```typescript
function pointerToWorld(e: PointerEvent, sm: ShapeManager, depth = 0): [number, number, number] {
  // Normalize device coordinates
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  const ndcY = ((e.clientY - rect.top)  / rect.height) * -2 + 1;

  // Unproject using camera VP inverse
  const cam = sm.getCamera3D();
  const invVP = mat4.invert(mat4.create(), cam.getViewProjectionMatrix());
  const clip = vec4.fromValues(ndcX, ndcY, depth, 1);
  const world = vec4.transformMat4(vec4.create(), clip, invVP);
  return [world[0]/world[3], world[1]/world[3], world[2]/world[3]];
}
```

**Surface snap (raycasting — future):**  
Call `sm.pickMesh3D(ndcX, ndcY)` to get a hit position on the character mesh surface. This gives natural stroke placement directly on 3D geometry. (C8 — not yet implemented.)

---

## Parent joint selector

Populate the joint dropdown by reading the character's skeleton:

```typescript
// Get all joint names for the dropdown.
const charData = sm.getCharacterDefinition3D(charId);
if (charData) {
  const skeleton = sm.getSkeleton3D(charData.skeletonId);
  const joints   = skeleton?.data.joints.map(j => j.name) ?? [];
  // Populate <select> with joints + "none" option.
}
```

Pass the selected joint name as `parentJoint` in `beginGpStroke3D()`.

---

## Closed + filled strokes

To draw filled regions (like cartoon shadows or color flats):

1. Enable "Closed" checkbox before drawing — the last point auto-connects to the first.
2. Enable "Filled" checkbox and pick a fill color — fill is rendered behind the outline.

```typescript
sm.beginGpStroke3D(gpId, layerId, outlineColor, width, {
  fillColor: { r: 0.9, g: 0.7, b: 0.2, a: 0.8 },
  closed:    true,
});
```

---

## Layer visibility & opacity

Layer `visible` and `opacity` are on the `GpLayer3D` object. Read them back via `getGpObject()` if you expose controls:

```typescript
// Toggle layer visibility.
const gpObj = sm.scene3d.getGpObject(gpId);
const layer = gpObj?.getLayer(layerId);
if (layer) {
  layer.visible = !layer.visible;
  sm.scheduleRender3D();
}
```

(Direct layer mutation is fine — GP objects are not immutable.)

---

## Save & restore

GP objects are automatically included in `.frogmarks` project saves via `packProject()` / `unpackProject()`. No extra wiring needed.

---

## Performance notes

- Each stroke is a separate draw call. For interactive drawing at 60 Hz, keep per-frame stroke counts below ~200.
- Bone parenting has **zero CPU cost** — all transform math runs in the vertex shader.
- Keyframe snapshots are stored as plain JS object arrays (deep copies of points). Memory scales with the number of keyframes × average stroke count.

---

## Render Order / Z-Sort

**✅ Shipped.**

GP objects render as a group after meshes and particles. Within that group, draw order is controlled per-object via `renderOrder`:

```typescript
sm.setGpRenderOrder3D(gpId, 0);   // default — draws after particles
sm.setGpRenderOrder3D(gpId, 10);  // draws on top within the GP group
sm.setGpRenderOrder3D(gpId, -1);  // reserved for future full Z-sort (below particles)
```

**Recommended UI:** an integer field (or drag slider) in the GP object inspector, under the layers list. Label: "Draw Order".

Full interleaving between GP objects and mesh/particle draw calls (so a GP object could render *between* two mesh passes) is deferred — design it when a scene demands it.
