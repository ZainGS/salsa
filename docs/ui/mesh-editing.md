# Mesh Editing UI — Frogmarks Integration Guide

Covers wiring the Angular mesh-editing panel to the Salsa `ShapeManager` edit-mesh API.

---

## Overview

Mesh editing is a **modal** operation. The user selects a mesh, enters Edit Mode,
performs operations (vertex drag, extrude, inset, delete, weld, paint face color), then
exits Edit Mode. All operations are undo/redo-able via the existing 3D undo stack.

The edit API lives on `ShapeManager` directly (not `sm.meshEdit` — use `sm` itself).

### Method naming note

The canonical method names use the `*MeshEditMode*` / `*Vertex*` / `*Face*` pattern
(e.g. `enterMeshEditMode3D`, `selectVertex3D`). The doc-friendly aliases
(`enterEditMode3D`, `selectEditVertex3D`, etc.) are identical wrappers — both work.

---

## Entering and exiting Edit Mode

```typescript
// Enter — returns false if meshId not found
const ok = sm.enterMeshEditMode3D(meshId);   // or alias: sm.enterEditMode3D(meshId)

// Exit — always safe to call even if not currently editing
sm.exitMeshEditMode3D();                      // or alias: sm.exitEditMode3D()

// Query
const inEditMode: boolean = sm.isMeshEditMode3D;   // getter, not a method
const activeMeshId: string | null = sm.activeMeshId3D();
```

### Canvas interaction — Salsa owns it

**Frogmarks does not need to set up pointer listeners or manage the cursor.**
Call `attachMeshEditPointerHandlers` once when entering edit mode and Salsa handles
everything: face/vertex/edge picking, vertex drag (with correct undo), cursor changes
(crosshair → grab → grabbing), and `setPointerCapture` during drag.

```typescript
// Enter edit mode and attach handlers — two lines, done
sm.enterMeshEditMode3D(meshId);
sm.attachMeshEditPointerHandlers(canvas, meshId, () => panel.refreshSelectionCount());

// Switch mode tabs
sm.setMeshEditSelectionMode('face');   // or 'vertex' / 'edge'

// Exit edit mode and remove handlers
sm.detachMeshEditPointerHandlers();
sm.exitMeshEditMode3D();
```

`onSelectionChange` (third arg) fires whenever the selection changes — use it to
refresh the panel's count display and enable/disable operation buttons. Do not poll
`getEditSelection3D` on every frame; wait for the callback.

### Keyboard shortcut

| Key | Action |
|-----|--------|
| `Tab` | Toggle Edit Mode on the selected mesh |

When entering Edit Mode, switch the tool panel to show the Edit Mesh controls. When
exiting (Tab or clicking elsewhere), switch back to the Object Mode panel.

---

## Making a mesh editable

A mesh must be made "editable" before topology operations work on it. `enterEditMode3D`
calls `makeEditable3D` automatically, but you can call it explicitly if you want to
build an EditMesh without entering Edit Mode (e.g. on import):

```typescript
sm.makeEditable3D(meshId);  // no-op if already editable
```

**What happens internally:** Salsa converts the mesh's current primitive geometry into
a half-edge EditMesh, then calls `syncFromEditMesh()` to keep the GPU geometry in sync.
The mesh's `vertexColors` buffer is populated from that point forward and the renderer
switches to the vertex-color pipeline.

**Exception — polygon and circle meshes:** `addPolygonMesh3D` and `addCircleMesh3D`
return a mesh with `editMesh` already attached. `enterEditMode3D` is safe to call
immediately — there is no `makeEditable3D` round-trip needed.

---

## Viewport overlay

When Edit Mode is active, Salsa draws an always-rendered wireframe overlay on top of the scene geometry. **No Frogmarks code is needed** — the overlay is driven automatically by the `MeshEditDataProvider`.

### What you see

| Visual | Color | Notes |
|--------|-------|-------|
| Edges (unselected, in front) | Gray `[0.65, 0.65, 0.65]` at 50% opacity | Solid lines; float above scene geometry |
| Edges (selected, in front) | Orange `[1.0, 0.55, 0.0]` | Solid lines; full opacity |
| Edges (behind front faces) | Same colors, **stippled** | 4-pixel diagonal dash pattern; ~55% opacity |
| Vertex dots | Warm `[1.0, 0.72, 0.4]` at 85% opacity | Billboard quad, always faces camera |
| Selected vertices | Orange `[1.0, 0.55, 0.0]` | 1.5× larger than unselected |
| Selected face fill | Orange at 25% opacity | Triangle fill over the face |

### Rear edge stipple

Edges that are **occluded by the mesh's own front faces** are drawn as stippled (dashed) lines rather than solid. The dash pattern runs diagonally at 4 pixels on / 4 pixels off — visible at any line angle. This provides clear depth cues when editing curved or closed-surface meshes (e.g. a cube viewed at an angle shows solid edges on the front faces and stippled edges on the back).

This is implemented as a second draw call over the same vertex buffer, using `depthCompare: 'greater'` so the stipple shader only fires where an edge fragment is further from the camera than the already-rendered mesh surface.

---

## Selection

Edit Mode has two selection targets: **vertices** and **faces**. Only one type is active
at a time (selecting a vertex clears the face selection and vice versa).

```typescript
// Select by picking — pass the vertex / face index returned by the mesh picker
sm.selectVertex3D(meshId, vertexIndex);          // replaces selection
sm.selectVertex3D(meshId, vertexIndex, true);    // additive (Shift-click)

sm.selectFace3D(meshId, faceIndex);
sm.selectFace3D(meshId, faceIndex, true);        // additive

sm.clearMeshSelection3D(meshId);

// Read current selection
const sel = sm.getEditSelection3D(meshId);
// sel: { meshId, vertices: Set<number>, edges: Set<number>, faces: Set<number> } | null
```

Aliases (`selectEditVertex3D`, `selectEditFace3D`, `clearEditSelection3D`) are identical — both work.

### Pointer event routing (Edit Mode)

In Edit Mode, pointer events on the canvas should use the `MeshPicker` to resolve
which vertex or face was clicked:

```typescript
// On pointerdown in Edit Mode:
const hit = sm.pickMesh3D(canvasX, canvasY);   // resolves mesh
if (hit) {
  const faceIdx = sm.pickFace3D(canvasX, canvasY, hit.meshId);  // face under cursor
  if (faceIdx !== null) {
    sm.selectEditFace3D(hit.meshId, faceIdx, event.shiftKey);
  }
}
```

Vertex picking (for vertex drag) requires projecting the mesh's EditMesh vertices
into screen space and finding the nearest one within a pick radius (~12 px).

---

## Topology operations

All operations push to the undo stack automatically.

### Vertex drag

```typescript
// delta in 3D world units
sm.moveVertex3D(meshId, vertexIndex, dx, dy, dz);  // alias: sm.moveEditVertex3D
```

For interactive drag: capture the start position on `pointerdown`, then call
`moveVertex3D` on every `pointermove` with the delta from the start position (not
incremental deltas — compute `current - start` each time and call once per pointer event).

Set `canvas.style.cursor = 'grabbing'` on drag start, restore to `'crosshair'` on release.

### Extrude face

```typescript
sm.extrudeFace3D(meshId, faceIndex, distance);  // alias: sm.extrudeEditFace3D
```

### Inset face

```typescript
sm.insetFace3D(meshId, faceIndex, amount);  // alias: sm.insetEditFace3D
// amount: 0 = no inset, 1 = collapse to center
```

### Delete face

```typescript
sm.deleteFace3D(meshId, faceIndex);  // alias: sm.deleteEditFace3D
```

### Weld vertices

```typescript
sm.weldVertices3D(meshId, v1Index, v2Index);  // alias: sm.weldEditVertices3D — welds v2 into v1
```

---

## Phase 3 — Loop cut and edge dissolve

### Edge selection

Before calling loop cut or dissolve, the user selects an edge. Edges are identified by
half-edge index. Retrieve one by calling `getHalfEdgeVertices` on the EditMesh (via
`sm.getEditMesh3D(meshId)?.getHalfEdgeVertices(idx)`) or by resolving a face pick to
the nearest edge.

```typescript
// Select an edge (clears vertex/face selection)
sm.selectEdge3D(meshId, halfEdgeIdx);

// Additive
sm.selectEdge3D(meshId, halfEdgeIdx, true);
```

### Loop cut

Inserts a new edge ring across a chain of quad faces. The loop travels through adjacent
quads in both directions from the starting half-edge and stops at mesh boundaries or
non-quad faces.

```typescript
// t = placement parameter: 0=at start vertex, 1=at end vertex, 0.5=midpoint
sm.loopCut3D(meshId, halfEdgeIdx, 0.5);
```

**UI pattern:** User hovers over an edge — highlight the would-be loop (calling
`loopCut3D` with `t=0.5` on `pointermove` on a temp mesh, or compute the loop purely
for preview). On click, call `loopCut3D` on the real mesh.

| Key | Action |
|-----|--------|
| `Ctrl+R` | Activate Loop Cut tool |
| Scroll | Adjust `t` (position along edge) |
| Click | Confirm cut |
| Right-click / Esc | Cancel |

### Edge dissolve

Removes the shared edge between two adjacent faces and merges them into one polygon.
The half-edge must not be a boundary edge (i.e. both adjacent faces must exist).

```typescript
sm.dissolveEdge3D(meshId, halfEdgeIdx);
```

Keyboard shortcut: `X` → "Dissolve Edge" option in the delete menu when an edge is
selected.

### Bevel edge

Replaces the selected edge with a quad chamfer strip. `amount` (0–1) controls how far
the new vertices slide along each adjacent edge from the original endpoints.

```typescript
// amount 0 = no change, 0.5 = slide to midpoint of adjacent edges
sm.bevelEdge3D(meshId, halfEdgeIdx, amount);
```

**UI pattern:** Show an `amount` slider (0–1) next to a "Bevel" button. When an edge is
selected (edges set non-empty), pressing the button calls `bevelEdge3D` with the first
edge in the selection and the current slider value.

| Key | Action |
|-----|--------|
| `Ctrl+B` | Activate Bevel tool on selected edge |
| Scroll / drag | Adjust `amount` interactively |
| Click / Enter | Confirm bevel |
| Right-click / Esc | Cancel |

---

## Knife cut

Free-cut across one or more faces by drawing a line in screen space.

```typescript
// x0,y0 → x1,y1 in canvas pixels; canvasWidth/Height must match the WebGPU canvas
sm.knifeCut3D(meshId, x0, y0, x1, y1, canvasWidth, canvasHeight);
```

The engine projects all EditMesh vertices through the current camera, finds which face
edges the line crosses (2D segment intersection), and splits those faces at the
intersection points. Returns false if no faces were cut.

**UI pattern:** On `pointerdown`, start recording the knife line start point. On
`pointermove`, draw a preview line on a canvas overlay. On `pointerup`, call
`knifeCut3D` with the two endpoints and the canvas dimensions.

```typescript
let knifeStart: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', e => {
  knifeStart = { x: e.offsetX * dpr, y: e.offsetY * dpr };
});

canvas.addEventListener('pointerup', e => {
  if (!knifeStart || !activeMeshId) return;
  sm.knifeCut3D(
    activeMeshId,
    knifeStart.x, knifeStart.y,
    e.offsetX * dpr, e.offsetY * dpr,
    canvas.width, canvas.height,
  );
  knifeStart = null;
});
```

Note: `offsetX`/`offsetY` are CSS pixels — multiply by `devicePixelRatio` to convert
to canvas physical pixels, which must match `canvas.width` / `canvas.height`.

| Key | Action |
|-----|--------|
| `K` | Activate Knife tool |
| Drag | Draw cut line |
| Release | Confirm cut |
| Esc | Cancel |

---

## UV unwrap

### Auto UV unwrap

Generates UV coordinates for every vertex using smart-project (box / triplanar mapping).
Each vertex is projected onto the plane perpendicular to its dominant face-normal axis.
UVs are normalised to [0, 1] with uniform scale.

Call once before enabling UV texture painting on a native EditMesh model:

```typescript
sm.autoUnwrap3D(meshId);
```

After this call, the mesh's compiled geometry carries real UVs. The mesh is now compatible
with UV texture painting (same pipeline as GLTF-imported meshes).

**UI pattern:** A single "Auto Unwrap" button in the Edit Mode panel. No parameters —
the result is immediately visible as the UV layout updates. Undoable.

---

### Bridge edge loops

Fills the gap between two open edge-loop selections with a ring of quad faces. Both
loops must have the same vertex count. Typical use: capping the open ends of a
cylinder, connecting the wrist ring of an arm to the hand, or sealing any two
matching open boundaries.

```typescript
// loopA and loopB are ordered arrays of vertex indices, same length, ≥ 2.
sm.bridgeEdgeLoops3D(meshId, loopA, loopB);
```

**Winding:** each quad is `[loopA[i], loopA[i+1], loopB[i+1], loopB[i]]` (wraps at
the end). If the resulting face normals point inward, reverse one of the loops before
calling (or use the face-flip tool after).

**UI pattern:**
1. User selects vertices forming the first loop (ring-select shortcut).
2. Shift-selects vertices forming the second loop.
3. Clicks "Bridge Loops" button (or presses **B** while in Edge select mode).
4. Frogmarks partitions `selection.vertices` into two same-size groups (e.g. by
   proximity, or by the user picking each loop separately), then calls
   `sm.bridgeEdgeLoops3D(meshId, loopA, loopB)`. Undoable.

---

## Vertex / face color painting

```typescript
// Paint a single face (with undo)
sm.paintFaceColor3D(meshId, faceIndex, r, g, b, a);

// Paint a single vertex (no undo — intended for rapid brush strokes)
sm.paintVertexColor3D(meshId, vertexIndex, r, g, b, a);
```

Colors are `[0, 1]` floats. `paintFaceColor3D` sets all vertices of the face to the
same color, so the face appears flat-shaded in the result. `paintVertexColor3D`
sets a single vertex for Gouraud blending across adjacent faces.

### Rendering behavior

Vertex colors replace the mesh's diffuse color in the Gouraud lighting pass. The
mesh-level material color is ignored once vertex colors are present. The renderer
automatically switches to the vertex-color pipeline when `mesh.vertexColors` is set.

---

## Modifier stack

```typescript
// Add modifiers
const mirrorIdx = sm.addMirrorModifier3D(meshId, 'x');  // axis: 'x' | 'y' | 'z'
const subdivIdx = sm.addSubdivisionModifier3D(meshId, 1);  // iterations: 1 | 2

// Toggle without removing
sm.setModifierEnabled3D(meshId, mirrorIdx, false);

// Remove
sm.removeModifier3D(meshId, mirrorIdx);

// Bake into geometry (destructive, undoable)
sm.applyModifier3D(meshId, subdivIdx);

// Read
const mods = sm.getModifiers3D(meshId);
// mods: Array<{ type: 'mirror'|'subdivision', enabled: boolean, ... }>
```

### Modifier panel layout

```
┌─ Modifier Stack ────────────────────────────────────┐
│  [+ Add Mirror]  [+ Add Subdivision]                │
│                                                     │
│  #0  Mirror X   [●] enabled  [Apply] [✕ Remove]    │
│  #1  Subdiv ×1  [●] enabled  [Apply] [✕ Remove]    │
└─────────────────────────────────────────────────────┘
```

---

## Panel layout reference

```
┌─ Edit Mesh ─────────────────────────────────────────┐
│  [Exit Edit Mode]            Mesh: "Box_01"         │
│  ─────────────────────────────────────────────────  │
│  Mode: ○ Vertex   ● Face   ○ Edge                  │
│                                                     │
│  ─ Face / Vertex Ops ───────────────────────────    │
│  [Extrude]  distance: [____] ↕                     │
│  [Inset]    amount:   [____] ↕                     │
│  [Delete Face]                                     │
│  [Weld Vertices] (pick two vertices)               │
│                                                     │
│  ─ Edge Ops ────────────────────────────────────    │
│  [Loop Cut]  t: [____] ↕    (Ctrl+R)               │
│  [Dissolve Edge]            (X → Dissolve)         │
│  [Bevel Edge]  amount: [____] ↕  (Ctrl+B)          │
│  [Knife Cut]                (K)                    │
│  [Bridge Loops]             (B, two loops selected) │
│                                                     │
│  ─ UV / Paint ──────────────────────────────────    │
│  [Auto Unwrap]                                     │
│  Color: [████]  [Paint Face]  [Paint Vertex]       │
│                                                     │
│  ─ Modifiers ───────────────────────────────────    │
│  [+ Mirror] [+ Subdivision]                        │
│  (modifier list)                                   │
└─────────────────────────────────────────────────────┘
```

---

## Undo / redo

Mesh editing shares the same 3D undo stack as transforms and animation:

```typescript
sm.undo3D();
sm.redo3D();
```

All topology operations are single undoable snapshots:

| Operation | Undoable |
|-----------|---------|
| Extrude face | ✅ |
| Inset face | ✅ |
| Delete face | ✅ |
| Weld vertices | ✅ |
| Loop cut | ✅ |
| Dissolve edge | ✅ |
| Bevel edge | ✅ |
| Knife cut | ✅ |
| Bridge edge loops | ✅ |
| Auto UV unwrap | ✅ |
| Paint face color | ✅ |
| Apply modifier (bake) | ✅ |
| Vertex drag | ✅ |

Modifier **toggle** and **remove** are NOT on the undo stack — they're cheap and reversible directly in the modifier panel.

---

## Creating editable meshes from 2D silhouettes

Box, sphere, and cylinder are the standard entry points. Two additional methods let
users sketch a 2D outline and extrude it immediately:

```typescript
// Arbitrary polygon — points are [x, z] in the XZ plane, Y is up
const leafPoints: [number, number][] = [
  [0, 0], [0.3, 0.5], [0, 1.2], [-0.3, 0.5],
];
const leaf = sm.addPolygonMesh3D(0, 0, 0, leafPoints, 0.1, 'Leaf');

// Regular circle (n-gon approximation)
const gem = sm.addCircleMesh3D(0, 0, 0, 0.5, 6, 0.4, 'Gem');
```

Both methods return a `Mesh3D` with `editMesh` already attached — you can call
`sm.enterEditMode3D(mesh.id)` immediately without a `makeEditable3D` round-trip.

**Parameters:**
- `addPolygonMesh3D(x, y, z, points, height?, name?, material?)` — arbitrary silhouette
- `addCircleMesh3D(x, y, z, radius, segments?, height?, name?, material?)` — regular n-gon

Setting `height = 0` creates a flat cap (no side faces), useful as a decal or when
you want to extrude interactively in Edit Mode afterward.

**Winding:** Points can be passed in any order; the implementation normalizes to CCW
(outward normals) automatically. If your extruded mesh appears hollow (backface culled),
the winding was reversed — check that `height > 0` and points are not degenerate.

---

## Code sample — minimal Edit Mode component

```typescript
@Component({ ... })
export class MeshEditPanelComponent {
  constructor(private scene: SceneService) {}

  get sm() { return this.scene.shapeManager; }

  get inEditMode() { return this.sm.isMeshEditMode3D; }        // getter, not method
  get activeMeshId() { return this.sm.activeMeshId3D(); }

  enterEdit(meshId: string) {
    this.sm.enterMeshEditMode3D(meshId);
    this.sm.attachMeshEditPointerHandlers(this.canvas, meshId, () => this.refreshPanel());
    this.sm.setMeshEditSelectionMode('face');  // default to face mode
  }
  exitEdit() {
    this.sm.detachMeshEditPointerHandlers();
    this.sm.exitMeshEditMode3D();
  }
  onModeTabChange(mode: 'vertex' | 'face' | 'edge') {
    this.sm.setMeshEditSelectionMode(mode);
  }
  refreshPanel() {
    const sel = this.activeMeshId ? this.sm.getEditSelection3D(this.activeMeshId) : null;
    this.selectedFaceCount   = sel?.faces.size    ?? 0;
    this.selectedVertexCount = sel?.vertices.size ?? 0;
    this.selectedEdgeCount   = sel?.edges.size    ?? 0;
  }

  extrudeSelected(distance: number) {
    const sel = this.activeMeshId ? this.sm.getEditSelection3D(this.activeMeshId) : null;
    if (!sel || sel.faces.size === 0) return;
    for (const fi of sel.faces) {
      this.sm.extrudeFace3D(this.activeMeshId!, fi, distance);
    }
  }

  paintSelected(r: number, g: number, b: number, a: number) {
    const sel = this.activeMeshId ? this.sm.getEditSelection3D(this.activeMeshId) : null;
    if (!sel) return;
    for (const fi of sel.faces)    { this.sm.paintFaceColor3D(this.activeMeshId!, fi, r, g, b, a); }
    for (const vi of sel.vertices) { this.sm.paintVertexColor3D(this.activeMeshId!, vi, r, g, b, a); }
  }
}
```
