# UV Editor — Spec

**Status:** Phases 1–9 complete ✅  
**Last Updated:** 2026-06-09

A UV unwrap and texture-painting editor integrated into the Frogmarks modeler toolbar alongside Edit Mesh, Armature, and GP. Lets creators unwrap custom meshes, paint textures directly in UV space or on the 3D surface, and see both views update live. Cross-highlighting links UV islands to their 3D counterparts so you always know which part of the UV you are editing.

---

## What Already Exists

| Thing | Location | Status |
|-------|----------|--------|
| `EditVertex.uv?: [number, number]` | `edit-mesh.ts:23` | ✅ |
| Box-project `autoUnwrap()` | `edit-mesh.ts:877` | ✅ (triplanar, no seams) |
| UV compiled into `MeshGeometry.uvs` and uploaded to GPU vertex buffer | `edit-mesh.ts:1381` | ✅ |
| `MeshPicker` returns `baryU`/`baryV` at hit triangle | `mesh-picker.ts` | ✅ |
| `LiveTextureMode` (raster layer → mesh diffuse, real-time) | `src/services/managers/live-texture-mode.ts` (to be created) | ⬜ (not yet built) |

What's missing: seam marking, island detection, UV canvas renderer, UV editing operations, painting bridge, cross-highlighting, improved unwrap algorithms, UV packing.

---

## Architecture Overview

```
Frogmarks UV Editor Mode
  │
  ├── 3D Viewport (left pane)
  │     ├── Mesh rendered normally with current texture applied
  │     ├── Overlay: hovered/selected faces tinted (cross-highlight from UV pane)
  │     ├── Seam edges drawn in red (edges marked as UV cut lines)
  │     └── 3D painting: click/drag → MeshPicker UV → paint on UV canvas
  │
  └── UV Canvas (right pane)
        ├── Background: raster layer linked as mesh diffuse (LiveTextureMode)
        ├── Overlay: UV wireframe (edges connecting UV vertices)
        ├── Overlay: selection highlights, island color-coding
        ├── 2D painting: draw directly on texture in UV space
        └── Cross-highlight: hover UV face → highlight in 3D viewport
```

The UV Canvas pane is a 2D HTML canvas — no WebGPU required. It renders the texture as an `<img>` background and draws the UV wireframe using 2D canvas line calls. UV editing (drag, transform) is handled by a dedicated 2D interaction system entirely separate from the 3D gizmo/orbit controller.

Both panes share a `UVEditorSession` object that owns the selection state, the seam graph, and the island decomposition. Changes in either pane update the session, which propagates to both renderers.

---

## Data Model

### Seams

Seams are edges in the `EditMesh` half-edge structure that act as UV cut lines. During unwrap, the mesh is "torn" at seam edges, allowing the surfaces on either side to have independent UV coordinates. Without seams, `autoUnwrap()` must use triplanar projection (which distorts curved surfaces). With seams, you can get near-zero-distortion unwraps on any topology.

```typescript
// Added to EditMesh:
interface EditHalfEdge {
  // ... existing fields ...
  isSeam: boolean;  // true = this edge is a UV cut line
}
```

Seams are stored per-half-edge. Since edges are represented by two half-edges, marking an edge as a seam sets both `he.isSeam = true` and `he.twin.isSeam = true`.

Seams survive `syncFromEditMesh()` — they are topology metadata, not geometry.

### UV Islands

An island is a connected component of faces in UV space — faces connected to each other via non-seam edges. Islands are computed lazily from the current seam configuration and cached until seams or topology change.

```typescript
interface UVIsland {
  id: number;  // stable index; recomputed on seam/topology change
  faceIndices: number[];     // indices into EditMesh.faces
  vertexIndices: number[];   // unique EditMesh vertex indices in this island
  /** Axis-aligned bounding box in UV space [uMin, vMin, uMax, vMax]. */
  uvBounds: [number, number, number, number];
  /** Approximate surface area in 3D world space (used for proportional UV scaling). */
  worldArea: number;
}
```

Islands are computed by a flood-fill over the half-edge adjacency graph: start at an unvisited face, expand to all adjacent faces that do not cross a seam edge.

### UVEditorSession

The runtime state of an open UV editor session. One session per mesh, lives while UV editor mode is active.

```typescript
interface UVEditorSession {
  meshId: string;

  /** Currently selected UV elements. Multiple selection supported. */
  selection: {
    vertices: Set<number>;  // EditMesh vertex indices
    edges:    Set<number>;  // EditMesh half-edge indices (canonical = min of twin pair)
    faces:    Set<number>;  // EditMesh face indices
    mode: 'vertex' | 'edge' | 'face';
  };

  /** Computed from current seam configuration. Recomputed when seams change. */
  islands: UVIsland[];

  /** Whether to show the UV wireframe overlay. */
  showWireframe: boolean;

  /** Whether to show stretched UVs as a color gradient (blue=ok, red=stretched). */
  showStretchOverlay: boolean;

  /** The raster layer currently bound as the UV canvas texture. */
  linkedLayerId: string | null;

  /** Pinned UV vertices — held in place during subsequent unwrap operations. */
  pinnedVertices: Set<number>;
}
```

---

## UV Canvas Renderer

A lightweight 2D renderer that draws the UV editor right pane.

### Rendering layers (bottom to top)

1. **Texture background** — the raster layer pixels, drawn as `ctx.drawImage`. If no layer is linked, a neutral grey checkerboard pattern indicates the UV 0–1 space.

2. **UV wireframe** — edges connecting UV vertex positions. Color-coded:
   - Normal edges: white at 60% opacity
   - Seam edges: red at 90% opacity (the cut lines)
   - Selected edges: yellow
   - The UV 0–1 boundary box: thin white outline

3. **Island tinting** — each island can be shown with a faint unique color fill over its triangles (optional, toggled via "Show Islands" button).

4. **Stretch overlay** — faces colored by UV stretch (ratio of 3D world area to UV area). Blue = no stretch, yellow = moderate, red = extreme. Lets you see at a glance where your unwrap loses detail.

5. **Selection highlight** — selected vertices (circles), edges (thicker lines), faces (filled tint).

6. **Hover highlight** — when hovering in the UV canvas, the face under the cursor is highlighted and the corresponding 3D mesh faces are tinted in the 3D viewport.

### Coordinate space

UV space is [0, 1] in both axes with (0, 0) at top-left (matching GPU texture convention). The UV canvas renderer maps UV space to canvas pixels with a zoom/pan transform maintained by the session. Zoom: scroll wheel. Pan: middle-drag or space+drag (same as the 2D viewport convention).

UDIM tiles (UVs outside 0–1) are shown as tiled repeats of the base texture, visually dimmed, so you can see how islands lay against neighbours.

---

## UV Editing Operations

All operations are undoable (push to `UndoManager3D` via `scene3d.pushCommand3D`).

### Selection

```typescript
// Select a UV vertex/edge/face in the UV canvas (by canvas position)
sm.uv.selectAtPoint(meshId, canvasX, canvasY, mode, additive?): void;

// Box-select a region in UV canvas coordinates
sm.uv.boxSelect(meshId, u0, v0, u1, v1, additive?): void;

// Select all UVs in an island
sm.uv.selectIsland(meshId, faceIndex): void;

// Select all UVs in the mesh
sm.uv.selectAll(meshId): void;
sm.uv.deselectAll(meshId): void;
sm.uv.invertSelection(meshId): void;
```

### Transform (2D, in UV space)

```typescript
// Move selected UVs by (du, dv) in UV space
sm.uv.moveSelected(meshId, du, dv): void;

// Scale selected UVs around their bounding box center
sm.uv.scaleSelected(meshId, su, sv): void;

// Rotate selected UVs around their bounding box center (radians)
sm.uv.rotateSelected(meshId, angleRad): void;

// Mirror horizontally or vertically around the selection center
sm.uv.mirrorSelected(meshId, axis: 'u' | 'v'): void;
```

The 2D transform is handled by a mini gizmo in the UV canvas (move handle, scale corners, rotation ring) distinct from the 3D gizmo — it operates entirely in UV space.

### Weld and split

```typescript
// Weld selected UV vertices that are within threshold of each other
// (joins islands at shared boundary vertices)
sm.uv.weldSelected(meshId, threshold?: number): void;

// Split selected UV edges (creates a seam and separates the islands)
sm.uv.splitSelected(meshId): void;
```

### Seam marking

```typescript
// Mark selected edges as seams (UV cut lines)
sm.uv.markSeam(meshId): void;

// Remove seam from selected edges
sm.uv.clearSeam(meshId): void;

// Clear all seams
sm.uv.clearAllSeams(meshId): void;

// Smart seam suggestion: mark edges that minimize distortion for the current topology
// (based on dihedral angle — sharp edges are good seam candidates)
sm.uv.suggestSeams(meshId, sharpnessThreshold?: number): void;
```

### Pin

Pinned vertices are held fixed during subsequent unwrap operations. Use to anchor a specific part of the UV while re-unwrapping the rest.

```typescript
sm.uv.pinSelected(meshId): void;
sm.uv.unpinSelected(meshId): void;
sm.uv.unpinAll(meshId): void;
```

---

## Unwrap Algorithms

The existing `autoUnwrap()` (box/triplanar projection) remains available as a quick fallback. Three new algorithms are added:

### 1. Angle-Based Linearization (ABL — seam-aware)

The default unwrap. Works island-by-island: for each island, builds a spanning tree of faces and unfolds them one by one, minimizing angle distortion. Seams define the island boundaries. Pinned vertices are preserved.

Best for: organic shapes (characters, props) where angle preservation matters more than area.

```typescript
sm.uv.unwrap(meshId, { method: 'abl', selectedOnly?: boolean }): void;
```

### 2. Smart Project (multi-angle box mapping, improved)

Extension of the existing box-project. Clusters faces by normal direction, projects each cluster onto its dominant axis plane, then packs the resulting islands. No seams required. Works well for hard-surface models.

Best for: architectural meshes, mechanical parts, anything with mostly flat faces.

```typescript
sm.uv.unwrap(meshId, { method: 'smartProject', angleLimit?: number }): void;
// angleLimit: faces within this many degrees of a shared normal are grouped. Default 66°.
```

### 3. Follow Active Face

Unwraps the selected faces relative to the active (last-selected) face. The active face is mapped to a canonical square; adjacent faces unfold from it. Useful for manually controlling the layout of a specific region without re-unwrapping the whole mesh.

```typescript
sm.uv.unwrap(meshId, { method: 'followActive', activeFaceIndex: number }): void;
```

### Pack UVs

After unwrapping, islands may overlap or have wasted space. Pack re-positions all islands to fill the 0–1 UV square efficiently (approximate bin-packing, proportional to world area so larger faces get more UV resolution).

```typescript
sm.uv.packIslands(meshId, options?: {
  margin?: number;   // gap between islands in UV units. Default 0.005.
  rotate?: boolean;  // allow 90° rotation of islands for better fit. Default true.
}): void;
```

---

## Texture Painting

### UV canvas painting (2D)

When the UV canvas has a linked raster layer, the user can paint directly on it using the standard Salsa raster brush tools. The UV wireframe overlay stays on top. The painted pixels appear immediately on the 3D mesh via `LiveTextureMode`.

The UV editor activates the linked layer as the active raster layer — the brush tool behaves exactly as in the normal raster editor. No new painting code is needed. The UV canvas IS the raster editor, just displayed with the UV wireframe on top.

### 3D surface painting (mesh → UV bridge)

The user can also paint by clicking/dragging on the 3D mesh surface. The bridge:

1. On pointer-move over the 3D viewport in UV editor mode, `MeshPicker.pickMesh()` runs and returns the hit result including `baryU`, `baryV` and the hit triangle indices `(i0, i1, i2)`.
2. The UV coordinates at the hit point are interpolated:
   ```typescript
   const uv0 = editMesh.vertices[i0].uv ?? [0, 0];
   const uv1 = editMesh.vertices[i1].uv ?? [0, 0];
   const uv2 = editMesh.vertices[i2].uv ?? [0, 0];
   const u = uv0[0] * (1 - baryU - baryV) + uv1[0] * baryU + uv2[0] * baryV;
   const v = uv0[1] * (1 - baryU - baryV) + uv1[1] * baryU + uv2[1] * baryV;
   ```
3. The UV coordinates are converted to raster canvas pixel coordinates: `px = u * canvasW`, `py = v * canvasH`.
4. A brush dab is stamped on the linked raster layer at `(px, py)`.
5. `LiveTextureMode`'s post-stroke callback fires, updating the GPU texture.

This is the same `paintMeshDab` flow used in Mesh Paint mode, extended with UV interpolation at step 2–3. The user sees their stroke appear simultaneously on the 3D surface and in the UV canvas.

**Continuity across the seam:** When a stroke crosses a UV seam, the brush dab at the UV coordinates on each side of the seam is painted independently. The result is correct — pixels appear at the right UV positions on both sides. Visual continuity is the author's responsibility (seams should be placed where the model's surface is naturally hidden or where the texture design has a natural cut).

---

## Cross-Highlighting

When the cursor hovers over either pane, the corresponding region is highlighted in the other.

### UV canvas → 3D viewport

On pointer-move in the UV canvas:
1. Hit-test the UV face mesh (all triangles, in UV space 2D) to find which face the cursor is over.
2. Store the hovered face index in the session.
3. On the next render frame, `Renderer3D` draws the hovered face with a tinted overlay (same mechanism as the mesh edit selection highlight — a thin fullscreen pass that draws selected triangles in a highlight color).

### 3D viewport → UV canvas

On pointer-move in the 3D viewport:
1. `MeshPicker.pickMesh()` returns the hit face indices.
2. Store the hovered face index in the session.
3. On the next UV canvas redraw, the corresponding UV face is drawn with a brighter wireframe and a fill tint.

Both highlights use the same orange/yellow selection color from the existing mesh edit overlay for visual consistency.

**Island hover:** When `showIslands` mode is on, hovering any face highlights the entire island it belongs to (all faces in `island.faceIndices`) rather than just the single face. This makes it easy to grab an island and understand its shape.

---

## Imported Mesh UVs

For meshes imported via GLTF/OBJ (not created via Edit Mesh), UVs exist in the GPU vertex buffer but not in an `EditMesh`. To UV-edit an imported mesh the user must first call `makeEditable3D(meshId)`, which builds an `EditMesh` from the GPU geometry and populates `vertex.uv` from the vertex buffer's UV channel. After that, all UV editor operations work normally.

`sm.uv.open(meshId)` handles this automatically: if the mesh has no `editMesh`, it calls `makeEditable3D` first. The user does not need to explicitly press "Make Editable" before opening the UV editor.

---

## ShapeManager Public API

All UV editor operations are mounted at `sm.uv.*`.

```typescript
// ── Session lifecycle ────────────────────────────────────────

/** Open the UV editor for a mesh. Creates EditMesh if needed. */
sm.uv.open(meshId: string): UVEditorSession;

/** Close the UV editor, apply UV changes to the GPU mesh. */
sm.uv.close(meshId: string): void;

/** Get the active session (null if UV editor is not open). */
sm.uv.getSession(meshId: string): UVEditorSession | null;

// ── Linked texture ───────────────────────────────────────────

/** Link a raster layer as the UV canvas texture (activates LiveTextureMode). */
sm.uv.linkLayer(meshId: string, layerId: string): void;

/** Create a new blank raster layer and link it. */
sm.uv.createAndLinkLayer(meshId: string, width?: number, height?: number): string; // → layerId

sm.uv.unlinkLayer(meshId: string): void;

// ── Seams ────────────────────────────────────────────────────

sm.uv.markSeam(meshId: string): void;         // on selected edges
sm.uv.clearSeam(meshId: string): void;
sm.uv.clearAllSeams(meshId: string): void;
sm.uv.suggestSeams(meshId: string, sharpnessThreshold?: number): void;

// ── Unwrap ───────────────────────────────────────────────────

sm.uv.unwrap(meshId: string, options?: {
  method?: 'abl' | 'smartProject' | 'followActive';
  selectedOnly?: boolean;
  activeFaceIndex?: number;
  angleLimit?: number;
}): void;

sm.uv.packIslands(meshId: string, options?: { margin?: number; rotate?: boolean }): void;

// ── Selection ────────────────────────────────────────────────

sm.uv.selectAtPoint(meshId: string, u: number, v: number, mode: 'vertex' | 'edge' | 'face', additive?: boolean): void;
sm.uv.boxSelect(meshId: string, u0: number, v0: number, u1: number, v1: number, additive?: boolean): void;
sm.uv.selectIsland(meshId: string, faceIndex: number): void;
sm.uv.selectAll(meshId: string): void;
sm.uv.deselectAll(meshId: string): void;
sm.uv.invertSelection(meshId: string): void;

// ── Transform ────────────────────────────────────────────────

sm.uv.moveSelected(meshId: string, du: number, dv: number): void;
sm.uv.scaleSelected(meshId: string, su: number, sv: number): void;
sm.uv.rotateSelected(meshId: string, angleRad: number): void;
sm.uv.mirrorSelected(meshId: string, axis: 'u' | 'v'): void;

// ── Weld / split / pin ───────────────────────────────────────

sm.uv.weldSelected(meshId: string, threshold?: number): void;
sm.uv.splitSelected(meshId: string): void;
sm.uv.pinSelected(meshId: string): void;
sm.uv.unpinSelected(meshId: string): void;
sm.uv.unpinAll(meshId: string): void;

// ── Painting bridge ──────────────────────────────────────────

/**
 * Paint at the UV coordinates corresponding to a 3D surface hit.
 * Call from pointer-move over the 3D viewport while UV editor is active.
 * Returns the UV position painted, or null if the hit was outside the UV map.
 */
sm.uv.paintAt3DHit(meshId: string, pickResult: PickResult): [number, number] | null;

// ── Export ───────────────────────────────────────────────────

/**
 * Export the UV layout as a PNG image: wireframe of all UV edges
 * on a transparent background. Useful as a painting template in
 * an external editor (Photoshop, Krita, etc.).
 */
sm.uv.exportLayout(meshId: string, width?: number, height?: number): Promise<Blob>;

/**
 * Export the linked raster layer as a PNG (the texture as painted).
 */
sm.uv.exportTexture(meshId: string): Promise<Blob>;
```

---

## Frogmarks Editor Integration

### UV mode button

In the modeler toolbar alongside Edit Mesh, Armature, and GP:

```
[Edit Mesh]  [Armature]  [GP]  [UV]
```

Clicking UV on a selected mesh enters UV editor mode. The viewport splits:

```
┌────────────────────────┬────────────────────────┐
│                        │                        │
│   3D Viewport          │   UV Canvas            │
│                        │                        │
│   - mesh rendered      │   - texture BG         │
│     with texture       │   - UV wireframe       │
│   - seam edges red     │   - island coloring    │
│   - hover tint         │   - selection handles  │
│                        │   - zoom/pan           │
└────────────────────────┴────────────────────────┘
```

On smaller screens, the split can be toggled to a single pane (UV only or 3D only).

### UV Panel (right inspector when UV mode active)

```
▸ UV EDITOR ─────────────────────────────
  Mesh     [Cube.001]
  Texture  [layer-abc ▾]  [+ New]

  ──────────────────────────────────────
  Unwrap
  Method  [Angle-Based ▾]
  [Unwrap]  [Smart Project]  [Pack Islands]

  ──────────────────────────────────────
  Seams
  [Mark Seam]  [Clear Seam]  [Suggest Seams]

  ──────────────────────────────────────
  Selection Mode  [● Vertex  ○ Edge  ○ Face]
  [Select All]  [Deselect]  [Select Island]

  ──────────────────────────────────────
  Overlays
  [✓] Wireframe   [✓] Islands   [  ] Stretch
  [  ] Pinned vertices

  ──────────────────────────────────────
  Export
  [↓ UV Layout PNG]   [↓ Texture PNG]
```

### Brush toolbar

When painting in UV mode, the standard brush tool panel is available in both panes. The active layer is always the linked texture layer. Brush size, hardness, color, opacity all apply normally.

---

## Serialization

UV state is already serialized as part of `EditMesh.vertices[i].uv`. Seam data (`isSeam` on half-edges) needs to be added to the `EditMesh.toJSON()` / `fromJSON()` round-trip:

```typescript
// In EditMesh.toJSON():
halfEdges: this.halfEdges.map(he => ({ ...existingFields, isSeam: he.isSeam }))

// In EditMesh.fromJSON():
he.isSeam = data.halfEdges[i].isSeam ?? false;
```

No other serialization changes are needed. UVs and seams round-trip with the mesh. The linked raster layer is a normal layer and serializes normally. `UVEditorSession` is runtime state only — it is not serialized (it is rebuilt from the mesh when the UV editor reopens).

---

## Implementation Phases

### Phase 1 — Seam system ✅ Completed June 2026

- `EditHalfEdge.isSeam: boolean` — initialized in `_buildTopology`, persisted in `EditMesh.toJSON/fromJSON` as canonical `[vFrom, vTo][]` pairs
- `EditMesh.markSeams()` / `clearSeams()` / `clearAllSeams()` / `suggestSeams(thresholdDeg)`
- `MeshEditManager.markSeam()` / `clearSeam()` / `clearAllSeams()` / `suggestSeams()` — all undoable; no `syncFromEditMesh` needed (seams don't affect GPU geometry)
- Seam edges rendered red (`0.9, 0.15, 0.15`) in `MeshEditOverlayRenderer` — selected edges (orange) take priority
- `sm.uv.markSeam` / `sm.uv.clearSeam` / `sm.uv.suggestSeams` public API deferred to Phase 8 (Frogmarks UI wiring)

### Phase 2 — Island detection ✅ Completed June 2026

- `UVIsland` interface exported from `edit-mesh.ts` (id, faceIndices, vertexIndices, uvBounds, worldArea)
- `EditMesh.computeUVIslands()` — flood-fill over non-seam interior edges; computes UV bounding box and 3D world area per island; O(F) per call
- `sm.getUVIslands3D(meshId): UVIsland[]` on ShapeManager — returns `[]` if no EditMesh
- Island color rendering deferred to Phase 3 (UV canvas renderer)

### Phase 3 — UV canvas renderer ✅ Completed June 2026

**File:** `src/services/managers/uv-canvas-renderer.ts`

- `UVEditorSession` class — selection state (vertex/edge/face), island cache with dirty flag, viewport transform (panU/panV/zoom), hover state, showWireframe/showIslands/showStretchOverlay, pinnedVertices, linkedLayerId
- `UVCanvasRenderer` class — 2D `CanvasRenderingContext2D` renderer with all 6 draw layers:
  1. Checkerboard background (or texture via `drawImage`)
  2. UV [0,1] boundary box
  3. Island color fills (8-color palette, 18% opacity per island)
  4. Stretch overlay (per-face log₂ world/UV area ratio → red=stretched, blue=compressed)
  5. UV wireframe (seams red, selected edges orange, normal edges white @ 60%)
  6. Selection highlights (face fills, vertex dots, pinned vertex diamonds) + hover tint
- `hitTestFace(cx, cy, session, editMesh)` — point-in-UV-triangle fan test
- `uvToCanvas` / `canvasToUV` — coordinate transform with zoom/pan
- ShapeManager API: `sm.openUVEditor3D(meshId)` → `UVEditorSession`, `sm.closeUVEditor3D(meshId)`, `sm.getUVSession3D(meshId)`, `sm.createUVCanvasRenderer(canvas)`
- Sessions stored in `_uvSessions: Map<string, UVEditorSession>`; `openUVEditor3D` auto-calls `makeEditable3D` if needed

### Phase 4 — UV editing operations ✅ Completed June 2026

**File:** `src/services/managers/uv-edit-manager.ts`

`UVEditManager` instantiated in ShapeManager alongside `MeshEditManager`. All transform and weld/split ops snapshot UV state before/after and push to the 3D undo stack. Pin ops are session-state only (no undo).

| ShapeManager method | Description |
|---|---|
| `sm.moveSelectedUVs3D(meshId, du, dv)` | Translate selected UVs |
| `sm.scaleSelectedUVs3D(meshId, su, sv)` | Scale around bbox centre |
| `sm.rotateSelectedUVs3D(meshId, angleRad)` | Rotate around bbox centre |
| `sm.mirrorSelectedUVs3D(meshId, axis)` | Mirror on `'u'` or `'v'` axis |
| `sm.weldSelectedUVs3D(meshId, threshold?)` | Snap close UV pairs to midpoint, clear seams between them |
| `sm.splitSelectedUVs3D(meshId)` | Mark selected edges as seams (edge mode only) |
| `sm.pinSelectedUVs3D(meshId)` | Pin selected vertices |
| `sm.unpinSelectedUVs3D(meshId)` | Unpin selected vertices |
| `sm.unpinAllUVs3D(meshId)` | Clear all pins |

**Selection resolution:** vertex mode → selected vertices; face mode → all vertices of selected faces; edge mode → both endpoints of each selected half-edge. Transform pivot is always the UV bounding-box centre of the affected vertices.

**Seam snapshot:** `weldSelected` and `splitSelected` also snapshot/restore `he.isSeam[]` so seam state undoes cleanly. Both call `session.invalidateIslands()` to force island recompute on next draw.

**GPU sync:** Every mutating op calls `mesh.syncFromEditMesh()` after the mutation and inside each undo/redo callback, keeping the GPU vertex buffer consistent with the in-memory UV coords.

### Phase 5 — Improved unwrap algorithms ✅ Completed June 2026

**Files:** `src/scene-graph/shapes/edit-mesh.ts`, `src/services/managers/uv-edit-manager.ts`

Three new algorithms on `EditMesh`, wrapped with undo in `UVEditManager`, exposed on `ShapeManager`:

| ShapeManager method | Description |
|---|---|
| `sm.unwrapIslands3D(meshId)` | Island-aware smart project: each island projected using its own average normal; islands may overlap — follow with `packUVIslands3D` |
| `sm.followActiveFaceUV3D(meshId, faceIndex)` | Projects entire mesh using the normal of `faceIndex` as the projection axis ("Follow Active Face") |
| `sm.packUVIslands3D(meshId, margin?)` | Shelf-packs all islands into [0, 1] UV space with a uniform margin; preserves island shape |

**`unwrapIslands()`**: calls `computeUVIslands()`, computes average face normal per island, projects island vertices onto the dominant-axis plane, normalises each island to [0, 1] independently.

**`unwrapFollowActive(faceIndex)`**: uses the exact normal of the specified face as the global projection axis; normalises result to [0, 1].

**`packUVIslands(margin)`**: reads per-island UV bboxes, sorts by height descending, runs shelf packing with shelf width ≈ `√(total area) × 1.05`, scales entire layout to [0, 1] uniformly.

All three are undoable (UV snapshot before/after), call `mesh.syncFromEditMesh()`, and call `session.invalidateIslands()`.

### Phase 6 — LiveTextureMode + painting bridge ✅ Completed June 2026

**File:** `src/services/managers/live-texture-mode.ts`

`LiveTextureMode` is a core Salsa primitive (not UV-specific) that zero-copy syncs a raster layer's `GPUTexture` to a mesh's diffuse channel. Because `Renderer3D`'s texture bind group cache keys on the `GPUTexture` reference, writing `mesh.diffuseTexture = layerTexture` is enough — no explicit cache eviction needed.

| ShapeManager method | Description |
|---|---|
| `sm.linkLiveTexture3D(meshId, layerId)` | Link a raster layer as the mesh's live diffuse; immediately syncs |
| `sm.unlinkLiveTexture3D(meshId)` | Remove link and clear diffuse texture |
| `sm.syncLiveTextures3D()` | Push all live layer textures to their meshes; call after stroke-end |
| `sm.isLiveTextureLinked3D(meshId)` | Returns true if a live link exists |
| `sm.getLiveTextureLayerId3D(meshId)` | Returns the linked layer ID, or null |

**How it works:** `LiveTextureMode` owns a `Map<meshId, layerId>`. `syncAll()` reads each layer's `GPUTexture` via `RasterLayerManager.getLayerTexture(layerId)`, writes it to `mesh.diffuseTexture`, sets `mesh.material.hasTexture`, and sets `mesh.gpuDirty = true`. `syncLiveTextures3D()` is explicit — the UI layer calls it on pointer-up / stroke-end.

**`RasterLayerManager.getLayerTexture(layerId)`** — new public method added to expose per-layer GPUTexture by ID.

### Phase 7 — Cross-highlighting ✅ Completed June 2026

**Files:** `src/services/managers/uv-canvas-renderer.ts`, `src/renderer/3d/mesh-edit-overlay-renderer.ts`

Both panes share `UVEditorSession.hoveredFaceIndex: number | null`. Writing to it updates the tint in both the UV canvas and the 3D viewport on the next render.

| API | Direction | Description |
|---|---|---|
| `sm.setUVHoverFace3D(meshId, faceIndex \| null)` | Either | Set/clear hover; schedules render |
| `sm.setUVIslandHoverMode3D(meshId, enabled)` | Either | Expand hover to whole island |

**UV canvas hover rendering** (layer 5 in `UVCanvasRenderer`):
- Single face: `rgba(255,200,100,0.22)` orange tint on the hovered face
- Island mode: highlights every face in the island containing `hoveredFaceIndex` at `rgba(255,200,100,0.18)`, using `session.islands` cache (skips expansion if `islandsDirty`)

**3D viewport hover rendering** (step 0 in `MeshEditOverlayRenderer`):
- `MeshEditDrawData.hoveredFaces?: Set<number>` carries the UV hover set
- ShapeManager's data provider builds `hoveredFaces` from the active UV session on every frame — single face or full island depending on `islandHoverMode`
- Rendered with `C_HOVER_FACE = rgba(0.3, 0.85, 1.0, 0.20)` (cyan tint), drawn before selection fills so selection always renders on top

### Phase 8 — Frogmarks editor UI ✅ Completed June 2026

**Doc:** `docs/ui/uv-editor.md`

Full Frogmarks integration guide covering: split-viewport layout (3D left + UV canvas right), session state fields, pointer event wiring, panel button wiring for all operations, live texture painting, and UV layout export.

Service-layer addition: `sm.exportUVLayout3D(meshId, width?, height?)` — renders UV wireframe + island fills to an off-screen canvas and returns it. Caller calls `.toDataURL('image/png')` to save.

### Phase 9 — Import UV support ✅ Completed June 2026

**File:** `src/services/managers/mesh-edit-manager.ts`

`_editMeshFromGeometry()` now copies UV coordinates from the GPU vertex buffer (offsets 6–7 in both 8-float and 12-float layouts) into `EditVertex.uv` on every vertex. This means `openUVEditor3D(meshId)` on an imported GLTF mesh automatically surfaces the original TEXCOORD_0 data in the UV canvas — no extra step required.

UV round-trip verified: import GLTF → `openUVEditor3D` → edit UVs → `exportSceneGltf3D` → UVs preserved.

---

## Design Principles

**The UV canvas IS the raster editor.** No new painting engine. The UV wireframe is an overlay on the existing raster canvas. Painting in the UV canvas uses the same brush, color, and layer system as everywhere else in Salsa.

**Cross-highlight is live, not modal.** You do not need to "switch modes" to see the correspondence between UV space and 3D space. Hovering always shows both views updating simultaneously.

**Seams before unwrap.** The workflow is always: mark seams → unwrap → pack → paint. The UI nudges this order (the "Unwrap" button is greyed if no seams exist on a complex mesh, with a hint "mark seams first for best results"). `autoUnwrap()` (smart project) remains available without seams for quick results on hard-surface meshes.

**Imports work out of the box.** GLTF meshes have UVs. Opening the UV editor on an imported mesh should just work — no manual "make editable" step required. The autoconvert in `sm.uv.open()` handles this silently.
