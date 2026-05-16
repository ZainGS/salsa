# Salsa — Array Tool ("Repeat")
**Last Updated:** 2026-05-15 (pre-commit radial controls)  

**Status:** Phases 1–4 ✅ Complete (incl. local/world radial orientation) | Phase 5 📋 Planned

---

## What This Is

The Array tool lets a user select any mesh, see directional face handles appear, hover a handle to ghost-preview the cloned copies, scroll to change count, then click to commit a linked `ArrayGroup3D`. All copies share the source's geometry; editing the source updates all copies live. When finished, the user can bake to independent meshes.

**Three modes** (selected in the tool options strip):

| Mode | Handles shown | Result |
|------|--------------|--------|
| **Line** | 6 cardinal face arrows (+X, −X, +Y, −Y, +Z, −Z) | 1-D chain of copies |
| **Grid** | 6 cardinal + 4 horizontal diagonal corners | N×M tiled copies |
| **Radial** | Orbital ring preview around mesh | N copies on a circle (world or local axis) |

---

## Core Architecture: Reference, Not Ownership

> `ArrayGroup3D` **references** the source mesh by ID. It does not own it — and it has **no children**.

The source mesh lives independently in the scene graph as a normal sibling node. `ArrayGroup3D` stores only `sourceId` and `arrayParams`. Instances are rendered entirely on the GPU using true instancing — no `Mesh3D` copy objects exist in the scene graph.

```
SceneRoot
├── Cube                  ← source mesh, always here, always editable
├── ArrayGroup A          ← Line +X: no children, instances computed from arrayParams
└── ArrayGroup B          ← Line +Z: no children, instances computed from arrayParams
```

**Not:**
```
ArrayGroup               ← source-stealing model (DO NOT USE)
├── Cube source
├── Copy
└── Copy
```

Every frame a pre-render callback passes all `ArrayGroup3D` nodes to the renderer via `setArrayGroups()`. The renderer calls `computeArrayOffsets(params, sourcePos)` to get N translation offsets, then writes N instance-buffer slots contiguous with the source's slot — one WebGPU draw call covers source + all instances.

---

## UX Philosophy

> "The user is creating relationships, not copies."

The user sees the mesh as a generator. Clicking any copy selects the generator (the `ArrayGroup3D`), not the individual instance. The modifier panel shows spacing, count, and mode for the selected generator.

```
click source mesh  →  edit source geometry, material, transform
click any copy     →  select the ArrayGroup3D (the generator)
edit source        →  all linked arrays update live
scroll on canvas   →  adjust count of hovered handle's ghost preview
click handle       →  commit new ArrayGroup3D for that direction
```

---

## Handle States

Each face handle can be in one of three states:

| State | Tier | Visual | Click action |
|-------|------|--------|-------------|
| **Free** | `'primary'` / `'secondary'` | Axis-colored sphere + spoke | Create new ArrayGroup in this direction |
| **Occupied** | `'occupied'` | Brighter, filled ring, existing copies ghosted along axis | Select the existing ArrayGroup for this direction |
| **Hovered** | any | Yellow | Show ghost preview (free) or highlight group (occupied) |

An occupied handle means an `ArrayGroup3D` whose `sourceId` matches the selected mesh already exists in that direction. Clicking it selects that group instead of creating a duplicate.

Diagonal handles (Grid mode) are always `'secondary'` — they don't track occupancy since grid groups blend two axes.

---

## Interaction Detail

### Handle appearance

Face handles are placed at the centers of the mesh's world-space AABB/OBB faces, offset slightly outward (×1.3). Axis colors follow the universal 3D convention: **X = red, Y = green, Z = blue**. Diagonal handles = magenta. Thin axis spokes connect the OBB center to each handle tip.

**Line mode** — 6 primary handles:
```
        ▲ +Y (green)
        │
   ◄ −X ┼ +X ►  (red)
        │
        ▼ −Y (green)
  (±Z handles into/out of screen — blue)
```

**Grid mode** — 6 primary + 4 secondary diagonal handles:
```
  ◤ −X+Z   ▲ +Z   ◥ +X+Z
           │
  ◄ −X ───┼─── +X ►
           │
  ◣ −X−Z   ▼ −Z   ◢ +X−Z
```

Diagonal handles only generate copies at positions where *both* offsets ≥ 1 (no axis-aligned rows, which the cardinal handles already cover).

**Radial mode** — no face arrows; a dotted orbital ring with ghost instances. The ring plane follows the transform gizmo's orientation mode: in **world** mode the ring is perpendicular to the chosen world axis; in **local** mode it is perpendicular to the source mesh's own local axis.

All radial parameters (count, radius, arc, axis, orient) are configurable in the tool options strip **before** committing and reflected live in the ghost preview. Committed `arrayParams` values are taken directly from the strip at click time.

### Ghost preview

When a free handle is hovered (line/grid) or a mesh is hovered (radial):
- Ghost copies shown at computed positions
- Translucent light-blue, alpha ≈ 0.30, fade-in over 300 ms
- Positions update live with scroll wheel (count) and tool strip controls

For radial mode the ghost ring uses the current strip values each frame:
- **Radius** — user-set, or auto-computed from mesh AABB when not overridden
- **Arc** — distributes `count` instances from angle 0 to `arcDeg`
- **Axis** — which local/world axis the ring is perpendicular to
- **Orient** — world or local (follows gizmo orientation toggle)

When an occupied handle is hovered:
- The existing copies along that axis are highlighted
- No new ghost overlay

### Scroll wheel
- Scroll up → count + 1 (max 32)
- Scroll down → count − 1 (min 1)
- Only affects count; radius/arc/axis are set via tool strip controls

### Click to commit (free handle)
- Creates `ArrayGroup3D` — source stays in place, group is added as sibling with no children
- Renderer begins computing GPU instance slots for the group on the next frame
- Group immediately selected; array adjustment gizmo activates

### Click (occupied handle)
- Selects the existing `ArrayGroup3D` for that direction
- No new group created

### Click any instance
- Engine resolves the click via ray–AABB test against instance positions (no copy objects exist)
- `ArrayGroup3D` selected; source mesh subtly highlighted to show the relationship

---

## Data Model

### `ArrayGroup3D`

```typescript
class ArrayGroup3D extends MeshGroup3D {
  arrayParams: ArrayParams;  // LinearArrayParams | GridArrayParams | RadialArrayParams
  sourceId: string;          // ID of the source mesh — source lives as a sibling in SceneRoot
  getType(): '3DArrayGroup'
}
```

**Children:** none. Instances are GPU-only. The source mesh is a sibling node in SceneRoot, not a child of this group.

### `LocalBasis3`

```typescript
interface LocalBasis3 {
  x: [number, number, number]; // source local +X in world space
  y: [number, number, number]; // source local +Y in world space
  z: [number, number, number]; // source local +Z in world space
}
```

Extracted from the source mesh's `localMatrix` (columns 0/1/2, normalized). Passed to `computeArrayOffsets` when the gizmo is in local orientation mode so the radial ring orbits the source's own axis instead of a world axis.

### `ArrayParams` — discriminated union

```typescript
interface LinearArrayParams {
  mode:    'linear';
  countX:  number;
  spacing: [number, number, number];
}

interface GridArrayParams {
  mode:        'grid';
  countX:      number;
  spacingX:    [number, number, number];
  countY:      number;
  spacingY:    [number, number, number];
  diagonalOnly?: boolean; // true when created from a diagonal handle
}

interface RadialArrayParams {
  mode:   'radial';
  count:  number;
  radius: number;
  axis:   'x' | 'y' | 'z';
  arcDeg: number;
  center: [number, number, number];
}
```

---

## Salsa API

```typescript
// ── Create ───────────────────────────────────────────────────────────
createLinearArray3D(sourceId, count?, spacing?)
createGridArray3D(sourceId, countX?, spacingX?, countY?, spacingY?, diagonalOnly?)
createRadialArray3D(sourceId, count?, radius?, axis?, arcDeg?)

// ── Update ───────────────────────────────────────────────────────────
updateArrayParams3D(groupId, partialParams)

// ── Bake / Separate ──────────────────────────────────────────────────
bakeArray3D(groupId)    // copies become real independent meshes; group deleted; undo-able

// ── Query ─────────────────────────────────────────────────────────────
isArrayGroup3D(nodeId): boolean
getArrayParams3D(groupId): ArrayParams | null
getArraySourceId(groupId): string | null          // ID of the source mesh for this group

// ── Array Tool (interactive hover + preview) ──────────────────────────
enableArrayTool(mode: 'line' | 'grid' | 'radial')
disableArrayTool()
setArrayToolMode(mode)
setArrayToolCount(count)
getArrayToolCount(): number

// Radial pre-commit controls — all update ghost immediately:
setArrayToolAxis(axis: 'x' | 'y' | 'z')
getArrayToolAxis(): 'x' | 'y' | 'z'
setArrayToolRadius(r: number | null)   // null = auto-size from mesh AABB
getArrayToolRadius(): number | null
setArrayToolArc(deg: number)           // 1–360
getArrayToolArc(): number
```

---

## Renderer Integration

### GPU Instancing

Array instances bypass the scene graph entirely. The instance buffer layout is `MESH_INSTANCE_STRIDE = 192 bytes` per slot: model matrix (64), normal matrix (64), material (48), padding (16).

```
instance buffer
┌─────────────────────┐
│  slot 0: source     │  ← Mesh3D uploaded normally
│  slot 1: instance 0 │  ← copy of source model matrix, translation overridden
│  slot 2: instance 1 │    by computeArrayOffsets result
│  ...                │
│  slot N: instance N-1│
└─────────────────────┘
```

Slots are contiguous: the source's slot is assigned first in `uploadMeshInstances`, then each array group immediately appends its N instance slots. This lets the existing batching loop emit a single `drawIndexed(triangleCount, N+1)` call for the source + all instances combined.

The renderer detects when re-upload is needed by checking `source.localMatrixVersion` against a cached version. If the source hasn't moved and `_instancesDirty` is false, the upload is skipped entirely.

`computeArrayOffsets` accepts an optional `LocalBasis3` third argument. When supplied (local orientation mode), radial instances orbit around the source's local axis instead of the world axis. `setArrayGroups(groups, localBases?)` on `Renderer3D` accepts a `Map<string, LocalBasis3>` that is forwarded to `computeArrayOffsets` per group — built each frame by `_ensureArrayGroupSync` when `orientationMode === 'local'`.

**Instance picking** (`pickAdditional` callback): since there are no `Mesh3D` objects for instances, clicking an instance runs a ray–AABB test against the source AABB translated by each instance offset. The nearest hit returns the `ArrayGroup3D` ID.

### Ghost preview and handles

- **`GhostPreviewRenderer`** — instanced, alpha-blended. Renders after transparent pass, before gizmos.
- **`GizmoRenderer.drawFaceHandles`** — axis-colored sphere + spoke per handle. Occupied handles render as filled rings. Rendered in gizmo overlay pass (depth compare = always).

---

## Phased Rollout

### Phases 1–3 ✅ — Engine foundation

- `ArrayGroup3D`, geometry pool sharing, `createLinear/Grid/Radial`, `updateArrayParams3D`, `bakeArray3D`
- Array adjustment gizmo (shaft + sphere drag handle per axis)
- Undo/redo for create, param adjust, bake

### Phase 4 ✅ — Hover handles + ghost preview + GPU instancing

- `ArrayToolController` — selection-driven locks, face handle computation, ghost position math
- `GhostPreviewRenderer` — translucent instanced mesh rendering with fade-in
- `GizmoRenderer.drawFaceHandles` — axis-colored arrows (X=red, Y=green, Z=blue) + center spokes
- `checkState()` pre-render polling for instant handle updates on selection/orientation change
- **Source detachment** — source stays in SceneRoot; `ArrayGroup3D` has no children
- **True GPU instancing** — no `Mesh3D` copies; instance buffer slots computed from `arrayParams` each frame via `computeArrayOffsets()`. One draw call covers source + all instances.
- **Occupied handles** — directions with existing arrays show edit handles, not create handles
- **Instance picking** — `pickAdditional` ray–AABB callback; clicking any instance selects the `ArrayGroup3D`
- **Local/world radial orientation** — `LocalBasis3` type; `computeArrayOffsets` optional `localBasis` param; `setArrayGroups(groups, localBases?)` on renderer; sync callback builds basis map from source `localMatrix` when `orientationMode === 'local'`; gizmo arc and radius-drag plane follow local basis
- **Pre-commit radial controls** — `setArrayToolAxis/Radius/Arc` on `ArrayToolController`; ghost uses `_radialRadius ?? autoAABB` and distributes over `_radialArc` degrees; all values committed verbatim into `arrayParams` at click time
- Scroll-to-count, click-to-commit flow

### Phase 5 📋 — Procedural relationships + per-instance overrides

- `getArrayGroupsForSource(sourceId)` — query all generators for a source
- Source-edit propagation UI feedback (subtle highlight on linked instances when source selected)
- Per-instance overrides (rotation, scale, visibility) without full separation

### Phase 6 📋 — Modifier stack

- `ModifierStack` container in scene graph
- Mirror modifier (axis X/Y/Z, merge threshold)
- Solidify modifier (thickness, fill caps)
- Drag-reorderable stack UI
- Stack serialization in `.frogmarks` project file

### Phase 7 📋 — Power features

- Relative spacing (as multiples of source AABB)
- Object offset (use a second mesh to define per-step transform)
- Merge vertices across adjacent copies
- Per-copy randomize (offset/rotation/scale variation)

---

## Related Files

- [src/scene-graph/shapes/array-group-3d.ts](../../src/scene-graph/shapes/array-group-3d.ts) — `ArrayGroup3D`, all `ArrayParams` types
- [src/renderer/3d/ghost-preview-renderer.ts](../../src/renderer/3d/ghost-preview-renderer.ts) — ghost instance renderer
- [src/renderer/3d/gizmo-renderer.ts](../../src/renderer/3d/gizmo-renderer.ts) — face handles + array adjustment gizmo
- [src/renderer/3d/renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) — geometry pool, render loop hooks
- [src/services/managers/array-tool-controller.ts](../../src/services/managers/array-tool-controller.ts) — hover/preview/commit interaction
- [src/services/managers/scene3d-manager.ts](../../src/services/managers/scene3d-manager.ts) — `createLinear/Grid/Radial`, `enableArrayTool`
- [src/services/managers/transform-controller-3d.ts](../../src/services/managers/transform-controller-3d.ts) — array adjustment gizmo drag
