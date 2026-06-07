# Frogmarks — Grease Pencil 3D UI Guide
**Last Updated:** 2026-06-06 (draw mode added)

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
│  Draw Order: [0]                                      │
└──────────────────────────────────────────────────────┘
```

---

## Panel initialization (on document load)

When the document loads, populate the GP panel from existing data:

```typescript
// List all GP objects already in the scene (e.g. from a saved project).
const gpObjects = sm.getAllGpObjects3D();
// [{ id, name, skeletonId? }, ...]

// For each GP object, list its layers.
for (const gpObj of gpObjects) {
  const layers = sm.getGpLayers3D(gpObj.id);
  // [{ id, name, visible, opacity }, ...]
}
```

---

## API quick reference

All GP calls go through `ShapeManager` (injected from the Salsa engine).

### Object & layer management

```typescript
// Create a GP object (returns gpId).
const gpId = sm.createGpObject3D('Hero outlines', skeletonId?);

// Rename a GP object.
sm.renameGpObject3D(gpId, 'Cel shading');

// Add a layer to a GP object (returns layerId).
const layerId = sm.addGpLayer3D(gpId, 'Outlines');

// Rename a layer.
sm.renameGpLayer3D(gpId, layerId, 'Shadows');

// Remove a layer.
sm.removeGpLayer3D(gpId, layerId);

// Remove the whole GP object.
sm.removeGpObject3D(gpId);
```

### Layer visibility & opacity

```typescript
// Toggle layer visibility.
sm.setGpLayerVisible3D(gpId, layerId, false);

// Set layer opacity (0–1).
sm.setGpLayerOpacity3D(gpId, layerId, 0.5);

// Read back current state (e.g. to sync UI toggles).
const layers = sm.getGpLayers3D(gpId);
// [{ id, name, visible, opacity }, ...]
```

### Draw mode (recommended)

The engine handles all pointer events automatically. Call `enterGpDrawMode3D` when the
user clicks the Draw or Erase button, and `exitGpDrawMode3D` when they switch away.

```typescript
// Enter draw mode (hooks canvas pointer events automatically).
sm.enterGpDrawMode3D(gpId, layerId, {
  mode:       'draw',          // 'draw' | 'erase'
  color:      { r: 0, g: 0, b: 0, a: 1 },
  baseWidth:  0.02,            // world-unit stroke width
  fillColor:  null,            // set to RGBA to enable fill
  parentJoint: 'chest',        // optional bone name for parenting
  closed:     false,
  depthMode:  'surface',       // snap to mesh surface; fallback to last depth
  // depthMode: 'fixed', depth: 0.5  — draw on a fixed plane at 50% depth
});

// Update settings live (e.g. on color picker or width slider change).
sm.setGpDrawSettings3D({ color: { r: 0.8, g: 0.1, b: 0.1, a: 1 } });
sm.setGpDrawSettings3D({ mode: 'erase', eraseRadius: 0.15 });

// Exit (remove canvas listeners; finalises any open stroke).
sm.exitGpDrawMode3D();

// Check if active (e.g. to update Draw/Erase button highlight).
const active = sm.isGpDrawMode3D;  // boolean getter
```

**Typical panel wiring:**

```typescript
// Draw button click
drawBtn.addEventListener('click', () => {
  sm.enterGpDrawMode3D(gpId, layerId, {
    mode: 'draw',
    color: currentColor,
    baseWidth: widthSlider.value,
    parentJoint: boneSelect.value || null,
    closed: closedCheckbox.checked,
    fillColor: fillCheckbox.checked ? fillColor : null,
  });
});

// Erase button click
eraseBtn.addEventListener('click', () => {
  sm.enterGpDrawMode3D(gpId, layerId, {
    mode: 'erase',
    eraseRadius: 0.1,
  });
});

// Panel close / tool switch
sm.exitGpDrawMode3D();
```

### Drawing strokes (manual / advanced)

If you need direct control (e.g. custom projection logic), call the low-level API
instead of the draw mode above:

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

### Erase tool (manual)

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

Grease Pencil draws at a fixed Z depth relative to the camera.

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

---

## Parent joint selector

Populate the joint dropdown from the GP object's associated skeleton:

```typescript
// Get the GP object descriptor to read its skeletonId.
const gpObjects = sm.getAllGpObjects3D();
const gpObj = gpObjects.find(g => g.id === gpId);

if (gpObj?.skeletonId) {
  const joints = sm.getSkeletonJoints3D(gpObj.skeletonId);
  // [{ index, name, parentIndex, worldX, worldY, worldZ }, ...]
  const jointNames = joints.map(j => j.name);
  // Populate <select> with jointNames + "none" option.
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

## Save & restore

GP objects are automatically included in `.frogmarks` project saves via `packProject()` / `unpackProject()`. No extra wiring needed.

---

## Performance notes

- Each stroke is a separate draw call. For interactive drawing at 60 Hz, keep per-frame stroke counts below ~200.
- Bone parenting has **zero CPU cost** — all transform math runs in the vertex shader.
- Keyframe snapshots are stored as plain JS object arrays (deep copies of points). Memory scales with the number of keyframes × average stroke count.

---

## Render Order / Z-Sort

GP objects render as a group after meshes and particles. Within that group, draw order is controlled per-object via `renderOrder`:

```typescript
sm.setGpRenderOrder3D(gpId, 0);   // default
sm.setGpRenderOrder3D(gpId, 10);  // draws on top of other GP objects
sm.setGpRenderOrder3D(gpId, -5);  // draws behind other GP objects
```

Objects with the same `renderOrder` value draw in scene-graph insertion order.

For each GP object, fills are drawn before strokes, so within one object the fill is never on top of its own outline. Across objects, all draws (fills and strokes) for a lower-`renderOrder` object complete before the next object starts — so a `renderOrder: 1` object is always fully in front of a `renderOrder: 0` object.

**Recommended UI:** an integer field (or drag slider) in the GP object inspector, under the layers list. Label: "Draw Order".

Full interleaving between GP objects and mesh/particle draw calls (so a GP object could render *between* two mesh passes) is not supported — all GP draws occur after the particle pass.

---

## API Reference Summary

| Method | Purpose |
|--------|---------|
| `getAllGpObjects3D()` | List all GP objects `{ id, name, skeletonId? }[]` — use on document load |
| `createGpObject3D(name, skeletonId?)` | Create a GP object, returns `gpId` |
| `removeGpObject3D(gpId)` | Delete GP object and all its layers/strokes |
| `renameGpObject3D(gpId, name)` | Rename a GP object |
| `getGpLayers3D(gpId)` | List layers `{ id, name, visible, opacity }[]` |
| `addGpLayer3D(gpId, name)` | Add a layer, returns `layerId` |
| `removeGpLayer3D(gpId, layerId)` | Remove a layer |
| `renameGpLayer3D(gpId, layerId, name)` | Rename a layer |
| `setGpLayerVisible3D(gpId, layerId, visible)` | Show/hide a layer |
| `setGpLayerOpacity3D(gpId, layerId, opacity)` | Set layer opacity 0–1 |
| `beginGpStroke3D(gpId, layerId, color, width, opts?)` | Start a stroke, returns `strokeId` |
| `addGpPoint3D(x, y, z, pressure, opacity)` | Append a point to active stroke |
| `endGpStroke3D()` | Finalize stroke (discards if < 2 points) |
| `eraseGpStrokes3D(gpId, layerId, pos, radius, frame?)` | Erase strokes near a world position |
| `setGpKeyframe3D(gpId, layerId, frame)` | Snapshot layer strokes as a keyframe |
| `clearGpKeyframe3D(gpId, layerId, frame)` | Remove keyframe (falls back to base strokes) |
| `setGpRenderOrder3D(gpId, order)` | Draw order within the GP pass (0 = default) |
| `enterGpDrawMode3D(gpId, layerId, opts?)` | Enter draw/erase mode — hooks canvas pointer events automatically |
| `exitGpDrawMode3D()` | Exit draw mode, remove listeners, finalise any open stroke |
| `isGpDrawMode3D` | Getter — `true` while draw mode is active |
| `setGpDrawSettings3D(opts)` | Update color/width/mode/etc. while draw mode is active |
| `getAllSkeletons3D()` | List all skeletons `{ id, name }[]` |
| `getSkeletonJoints3D(skeletonId)` | List joints for parent joint dropdown |
