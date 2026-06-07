# Frogmarks: Array Tool (Repeat) UI Spec
**Last Updated:** 2026-06-06 (object offset, bake multi-repeat fix, layer position fix, Phase 8 merged bake)

---

## What It Is

The Array Tool (Frogmarks label: **Repeat**) lets a user select a mesh, click Repeat, and get N linked instances. All instances render live whenever the source is edited. The user can bake to independent meshes when done.

Three modes are available: **Linear** (instances along a single axis), **Grid** (NxM instances across two axes), and **Radial** (N instances around a center point).

> **How instances work:** There are no copy objects in the scene graph. Instances are GPU-only — computed each frame from `arrayParams` and drawn in one WebGPU draw call alongside the source. Clicking any rendered instance in the viewport selects the `ArrayGroup3D` node (the engine resolves this via ray–AABB picking).

---

## Primary Flow: Hover-Handle Interaction

The main way to create an array is through hover-handles. The user does not click a "create" button — they hover the mesh to see directional face-arrow handles, then click a handle.

### Tool lifecycle

```
Frogmarks                                  Salsa
──────────────────────────────────────────────────────────────
User picks "Repeat" tool
  → shapeManager.enableArrayTool('line')    // or 'grid' | 'radial'

User hovers any mesh
  → face-arrow handles appear at AABB face centers (drawn by engine)

User hovers an arrow handle
  → ghost instances fade in (0 → 30% opacity, light-blue hologram)
  → scroll wheel adjusts count live

User scrolls (optional panel readback)
  → shapeManager.getArrayToolCount()

User clicks the hovered handle
  → ArrayGroup3D created + selected
  → hover state cleared; normal array gizmo + Repeat panel appear

User picks a different tool
  → shapeManager.disableArrayTool()
```

### Enabling / disabling

```typescript
// When the user clicks the Repeat tool button:
shapeManager.enableArrayTool('line', 3);   // mode, initialCount

// When the user picks any other tool:
shapeManager.disableArrayTool();

// Switching mode while the tool is active (mode-strip button):
shapeManager.setArrayToolMode('grid');     // 'line' | 'grid' | 'radial'
```

### Count panel integration (tool options strip)

While the Array Tool is active, show a **Count** control in the tool options strip:

```typescript
// Panel → engine (user types or clicks ± buttons):
shapeManager.setArrayToolCount(newCount);

// Engine → panel (sync after scroll wheel changes it):
const count = shapeManager.getArrayToolCount();
```

Count range: 1–32 (enforced by the engine; no UI guard needed).

### Radial controls (tool options strip, radial mode only)

When `mode === 'radial'`, show four additional controls in the strip alongside Count. Each updates the ghost ring preview immediately:

```typescript
// Initialise strip when switching to radial:
const axis   = shapeManager.getArrayToolAxis();    // 'x'|'y'|'z', default 'y'
const radius = shapeManager.getArrayToolRadius();  // number | null  (null = auto from mesh AABB)
const arc    = shapeManager.getArrayToolArc();     // degrees 1–360, default 360
const orient = shapeManager.scene3d.getGizmoOrientation(); // 'world'|'local'

// On user input:
shapeManager.setArrayToolAxis('x');          // Axis buttons
shapeManager.setArrayToolRadius(4.0);        // Radius input  (pass null to restore auto-size)
shapeManager.setArrayToolArc(180);           // Arc input
shapeManager.scene3d.setGizmoOrientation('local'); // Orient toggle
```

**Radius** — when null the engine sizes the ring from the mesh's AABB automatically. The input should show the live auto-computed value when null and allow the user to override it. A "reset" icon can pass `null` back.

**Arc** — 1–360°. Full ring = 360. Partial arc places Count instances from angle 0 to arcDeg.

**Orient** — World / Local buttons. Calls the same `setGizmoOrientation` used by the main gizmo toolbar, so they stay in sync. In local mode the ring orbits the mesh's own local axis; in world mode it orbits the world axis.

All four values are committed verbatim into `arrayParams` when the user clicks. Hide all four when the mode is Line or Grid.

### Mode strip layout

**Line / Grid mode:**
```
┌────────────────────────────────────────────────────────┐
│  [Repeat]  Mode: [●Line]  [Grid]  [Radial]  Count: 3  │
└────────────────────────────────────────────────────────┘
```

**Radial mode** — the strip expands to show all radial parameters:
```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  [Repeat]  Mode: [Line]  [Grid]  [●Radial]  Count: 6  Radius: 3.0  Arc: 360°  Axis: [X][●Y][Z]  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Line** — 6 cardinal face arrows (+X, −X, +Y, −Y, +Z, −Z); click any arrow → linear array along that axis.
- **Grid** — same 6 plus 4 XZ-diagonal corner arrows (smaller, magenta); click a diagonal → 2D grid array.
- **Radial** — no arrows; an orbital ring appears immediately on hover based on Count + Axis; click anywhere on the mesh → radial array committed with those settings.

### When to show the Repeat panel

| State | UI |
|-------|----|
| Array Tool active, no array committed yet | Tool options strip only (mode + count) |
| After click-to-commit; `ArrayGroup3D` now selected | Full Repeat panel (count, spacing, gizmo) |
| `ArrayGroup3D` selected via scene graph (tool not active) | Full Repeat panel |

---

## Direct-Create Flow (programmatic)

To skip the hover-handle UX and create an array immediately from code:

```typescript
// Linear — N instances along a spacing vector
shapeManager.createLinearArray3D(selectedMeshId);
// Defaults: count = 3, spacing = source width × 1.1 along world-X

// Grid — NxM instances across two axes
shapeManager.createGridArray3D(selectedMeshId);
// Defaults: 2×2, source AABB-based spacing

// Radial — N instances around a center point
shapeManager.createRadialArray3D(selectedMeshId);
// Defaults: 6 instances, Y axis, 360°, radius from source AABB
```

The source mesh is **not moved**. An `ArrayGroup3D` is added as a sibling alongside it in the scene root. The array gizmo activates immediately after creation.

---

## Detecting an Array Selection

The hierarchy node type for an array group is `'3DArrayGroup'`. Check via `getScene3DHierarchy()` or listen to scene-graph-changed events:

```typescript
const hierarchy = shapeManager.getScene3DHierarchy();
const selected  = hierarchy.find(n => n.id === selectedNodeId);

if (selected?.type === '3DArrayGroup') {
  showArrayPanel(selectedNodeId);
} else if (selected?.type === '3DMesh') {
  showMeshPanel(selectedNodeId);
} else {
  showGroupPanel(selectedNodeId);
}
```

`shapeManager.isArrayGroup3D(nodeId)` is the direct boolean check.

---

## Panel Layout

When an `ArrayGroup3D` is selected, replace the normal mesh transform/material body with the Repeat panel.

### Linear mode

```
┌─────────────────────────────────────────┐
│  Repeat                                 │
│  ─────────────────────────────────────  │
│  Mode:  [●Linear]  [ Grid ]  [ Radial ] │
│                                         │
│  Count    [─────────────────────] 4     │
│  Spacing  [─────────────────────] 2.0   │
│  Axis     [ X ]  [ Y ]  [ Z ]   ● X    │
│                                         │
│  [ Edit Source ]        [ Bake ]        │
└─────────────────────────────────────────┘
```

### Count control

Binds to `arrayParams.countX`. Min = 1, max = 32 (soft cap; no hard limit in API).

```typescript
function onCountChange(groupId: string, newCount: number) {
  shapeManager.updateArrayParams3D(groupId, { countX: newCount });
}
```

Changes are live — no confirm needed. `updateArrayParams3D` never pushes undo. For slider interactions, push once on `pointerup`:

```typescript
// On slider commit (pointerup / blur):
const oldParams = shapeManager.getArrayParams3D(groupId);
shapeManager.updateArrayParams3D(groupId, { countX: newCount });
shapeManager.scene3d.pushCommand3D({
  description: 'Change array count',
  undo: () => shapeManager.updateArrayParams3D(groupId, { countX: oldParams!.countX as number }),
  redo: () => shapeManager.updateArrayParams3D(groupId, { countX: newCount }),
});
```

> The gizmo-driven spacing drags push their own undo steps internally. Only panel-driven count/spacing changes need manual undo.

### Spacing control

Displays `Math.sqrt(spacing[0]² + spacing[1]² + spacing[2]²)` (magnitude). When the user edits it:

```typescript
function onSpacingChange(groupId: string, magnitude: number) {
  const params = shapeManager.getArrayParams3D(groupId)!;
  if (params.mode !== 'linear') return;
  const s = params.spacing;
  const oldMag = Math.sqrt(s[0]**2 + s[1]**2 + s[2]**2) || 1;
  const scale  = magnitude / oldMag;
  shapeManager.updateArrayParams3D(groupId, {
    spacing: [s[0] * scale, s[1] * scale, s[2] * scale],
  });
}
```

### Axis buttons (X / Y / Z)

Each button sets the spacing vector to `[magnitude, 0, 0]`, `[0, magnitude, 0]`, or `[0, 0, magnitude]`:

```typescript
function onAxisChange(groupId: string, axis: 'x' | 'y' | 'z') {
  const params = shapeManager.getArrayParams3D(groupId)!;
  if (params.mode !== 'linear') return;
  const s = params.spacing;
  const mag = Math.sqrt(s[0]**2 + s[1]**2 + s[2]**2) || 2;
  shapeManager.updateArrayParams3D(groupId, {
    spacing: axis === 'x' ? [mag, 0, 0] : axis === 'y' ? [0, mag, 0] : [0, 0, mag],
  });
}

function getActiveAxis(spacing: [number, number, number]): 'x' | 'y' | 'z' | null {
  const [x, y, z] = spacing;
  if (Math.abs(y) < 1e-4 && Math.abs(z) < 1e-4) return 'x';
  if (Math.abs(x) < 1e-4 && Math.abs(z) < 1e-4) return 'y';
  if (Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4) return 'z';
  return null;  // diagonal — no button highlighted
}
```

### Edit Source button

Opens EditMesh mode on the source mesh. Use `getArraySourceId` to retrieve the source ID:

```typescript
function onEditSource(groupId: string) {
  const sourceId = shapeManager.getArraySourceId(groupId);
  if (sourceId) shapeManager.enterMeshEditMode3D(sourceId);
}
```

While in EditMesh mode, hide the Repeat panel (edit mode shows vertex/edge/face controls). When the user exits edit mode, the Repeat panel reappears; all instances reflect the updated source automatically.

### Bake button

Converts the `ArrayGroup3D` into a plain `MeshGroup3D` containing independent copies of the source. The source mesh is placed inside the baked group alongside the instances — **unless other Repeat arrays still reference the same source**, in which case the source stays in the scene so the remaining repeats continue to work.

This operation is undoable. Show a confirmation dialog first:

```typescript
async function onBake(groupId: string) {
  const confirmed = await showConfirmDialog(
    'Bake Array',
    'Convert to independent meshes? The source and all instances will become separate, ' +
    'editable meshes in one group. Changes to one mesh will no longer affect the others. ' +
    '(Undo will restore the linked array.)'
  );
  if (!confirmed) return;
  shapeManager.bakeArray3D(groupId);
}
```

After baking:
- `isArrayGroup3D(groupId)` returns `false`
- The panel should switch to normal `MeshGroup3D` controls
- The baked group is automatically selected
- Any other Repeat arrays referencing the same source mesh are unaffected

### Bake Merged button (Linear arrays only)

An alternative bake mode that produces a **single unified Mesh3D** instead of a group of independent copies. All copy geometries are transformed to world space and vertex-welded into one contiguous mesh. Useful when the copies should share topology (e.g. a tiled corridor where adjacent walls share edges, or a chain where links interlock).

```typescript
async function onBakeMerged(groupId: string) {
  const confirmed = await showConfirmDialog(
    'Bake Merged',
    'Merge all copies into a single mesh with welded vertices? This cannot be undone beyond ' +
    'this operation. (Undo will restore the linked array.)'
  );
  if (!confirmed) return;
  shapeManager.bakeArrayMerged3D(groupId);
}
```

**Gap fill:** Before baking, the user can enable "Gap fill" in the Repeat panel. When active, the engine inserts bridge geometry in the space between each pair of adjacent copies (if a gap exists). Enable via `updateArrayParams3D`:

```typescript
shapeManager.updateArrayParams3D(groupId, { gapFill: true });
// Optional: tune the weld distance (default 0.001 world units)
shapeManager.updateArrayParams3D(groupId, { weldThreshold: 0.002 });
```

After baking merged:
- `isArrayGroup3D(groupId)` returns `false`
- A single `Mesh3D` is selected (not a group)
- The mesh sits at the world origin — its vertices are already in world space

---

## Source-Link Feedback

When the source mesh is selected (and has linked arrays), the engine automatically draws a faint **amber/gold outline** on all linked instances. No Frogmarks call is needed — the renderer detects source selection from `getSelectedMeshIds()` each frame and updates the highlight automatically.

To list related arrays from a source mesh (e.g. to show a "Linked arrays" badge in the panel):

```typescript
const sourceId = getCurrentSelectedMeshId();
const linkedGroups = sm.getArrayGroupsForSource3D(sourceId);
// ['group-id-1', 'group-id-2', ...]
```

---

## Gizmo Behavior

When an array group is selected, the standard Move/Rotate/Scale gizmo is hidden and replaced by the **array spacing handle**:

- A light-blue shaft runs from the source position to the drag handle.
- A sphere at the handle tip is the drag target — turns yellow on hover.
- Dragging the sphere changes the `spacing` magnitude (and thus all instance positions) live.
- Releasing the drag pushes an undo step automatically (handled internally).

The gizmo is drawn and hit-tested entirely by the engine — Frogmarks does not implement it.

What Frogmarks **does** need to do: ensure the mode strip does not show Move/Rotate/Scale buttons as "active" when an `ArrayGroup3D` is selected. You can either hide the mode strip for array selections or show a neutral "Array" state.

---

## Reading Params for Panel Sync

Subscribe to scene-graph-changed events and re-read params each time. Check `params.mode` to render the correct panel body:

```typescript
shapeManager.interactionService.onSceneGraphChanged.subscribe(() => {
  const selected = getCurrentSelectedId();
  if (!shapeManager.isArrayGroup3D(selected)) return;
  const params = shapeManager.getArrayParams3D(selected);
  if (!params) return;

  // Always show mode buttons
  setActiveMode(params.mode);

  if (params.mode === 'linear') {
    setCountInput(params.countX);
    setSpacingInput(Math.sqrt(params.spacing[0]**2 + params.spacing[1]**2 + params.spacing[2]**2));
    setActiveAxis(getActiveAxis(params.spacing));
  } else if (params.mode === 'grid') {
    setCountXInput(params.countX);
    setCountYInput(params.countY);
    setSpacingXInput(Math.sqrt(params.spacingX[0]**2 + params.spacingX[1]**2 + params.spacingX[2]**2));
    setSpacingYInput(Math.sqrt(params.spacingY[0]**2 + params.spacingY[1]**2 + params.spacingY[2]**2));
  } else if (params.mode === 'radial') {
    setCountInput(params.count);
    setRadiusInput(params.radius);
    setArcInput(params.arcDeg);
    setActiveAxis(params.axis);
  }
});
```

`updateArrayParams3D` triggers `onSceneGraphChanged` internally, so this subscription stays in sync with gizmo drags as well.

---

## Hierarchy Panel

In the node hierarchy / outliner, an `ArrayGroup3D` is a leaf — there are no child copy nodes. Show an instance count badge:

```
  Repeat  ×4            [3DArrayGroup]
```

`getScene3DHierarchy()` now includes `instanceCount` directly on every `3DArrayGroup` node — no extra call needed:

```typescript
const hierarchy = shapeManager.getScene3DHierarchy();

for (const node of hierarchy) {
  if (node.type === '3DArrayGroup') {
    renderOutlinerRow(node.name, node.instanceCount); // e.g. "Repeat ×4"
  }
}
```

`node.instanceCount` is the number of GPU instances (source not counted). If you need to call it outside the hierarchy loop, `getArrayParams3D(id)` is the fallback, but the hierarchy value is always up to date.

The source mesh is a sibling in the scene root, not nested under the array group. Clicking any rendered instance in the viewport selects the `ArrayGroup3D` node (not the source).

### Outliner auto-selection after creation

When a Repeat array is created (via hover-handle click or direct-create API), the engine calls `ctx.setSelectedNode(group.id)` so the outliner immediately scrolls to and highlights the new Repeat row. No manual scroll or refresh is needed.

### Clicking a Repeat row

When the user clicks a Repeat row in the outliner, `syncSelectionFromOutliner` resolves the `ArrayGroup3D`'s `sourceId` to the source `Mesh3D` and calls `setSelectedMeshIds` with it. The 3D viewport shows the gizmo on the source mesh, which is the anchor for all instance positions.

### Hover highlight

Hovering a Repeat row calls `setHoveredMesh(groupId)`. The engine resolves this to the source mesh ID **and** sets `_hoveredArrayGroupId` on the renderer to the hovered group's ID. The renderer then narrows the highlight outline to only the instance buffer slots belonging to that specific group (`[firstSlot, firstSlot + N)`). This means:

- Hovering "Repeat linear+X" highlights only the linear copies — not radial copies from a second Repeat on the same source.
- Hovering "Repeat radial Y" highlights only the radial ring — not the linear chain.

Multiple Repeat rows on the same source mesh correctly highlight independently.

---

## Grid Mode Panel

```
┌─────────────────────────────────────────┐
│  Repeat                                 │
│  ─────────────────────────────────────  │
│  Mode:  [ Linear ]  [●Grid ]  [ Radial ]│
│                                         │
│  Count X  [──────────────────────] 3    │
│  Count Y  [──────────────────────] 3    │
│  Spacing X [─────────────────────] 2.0  │
│  Axis X   [ X ]  [ Y ]  [ Z ]   ● X    │
│  Spacing Y [─────────────────────] 2.0  │
│  Axis Y   [ X ]  [ Y ]  [ Z ]   ● Z    │
│                                         │
│  [ Edit Source ]        [ Bake ]        │
└─────────────────────────────────────────┘
```

### Count X / Count Y

```typescript
function onCountXChange(groupId: string, v: number) {
  shapeManager.updateArrayParams3D(groupId, { countX: v });
}
function onCountYChange(groupId: string, v: number) {
  shapeManager.updateArrayParams3D(groupId, { countY: v });
}
```

### Spacing X / Axis X

```typescript
function onSpacingXChange(groupId: string, mag: number) {
  const params = shapeManager.getArrayParams3D(groupId)!;
  if (params.mode !== 'grid') return;
  const s = params.spacingX;
  const oldMag = Math.sqrt(s[0]**2 + s[1]**2 + s[2]**2) || 1;
  shapeManager.updateArrayParams3D(groupId, {
    spacingX: [s[0]/oldMag*mag, s[1]/oldMag*mag, s[2]/oldMag*mag],
  });
}

function onAxisXChange(groupId: string, axis: 'x' | 'y' | 'z') {
  const params = shapeManager.getArrayParams3D(groupId)!;
  if (params.mode !== 'grid') return;
  const mag = Math.sqrt(params.spacingX[0]**2 + params.spacingX[1]**2 + params.spacingX[2]**2) || 2;
  shapeManager.updateArrayParams3D(groupId, {
    spacingX: axis === 'x' ? [mag,0,0] : axis === 'y' ? [0,mag,0] : [0,0,mag],
  });
}
```

### Spacing Y / Axis Y

Same pattern as Spacing X / Axis X, but reads/writes `spacingY`.

### Gizmo (grid)

Two arms are drawn automatically: blue for X, green for Y. Each arm has its own drag sphere. The mode strip should suppress Move/Rotate/Scale in the same way as linear mode.

---

## Radial Mode Panel

```
┌─────────────────────────────────────────┐
│  Repeat                                 │
│  ─────────────────────────────────────  │
│  Mode:  [ Linear ]  [ Grid ]  [●Radial ]│
│                                         │
│  Count  [────────────────────────] 6    │
│  Radius [────────────────────────] 3.0  │
│  Arc    [────────────────────────] 360° │
│  Axis   [ X ]  [ Y ]  [ Z ]   ● Y      │
│  Orient [ World ]  [ Local ]            │
│                                         │
│  [ Edit Source ]        [ Bake ]        │
└─────────────────────────────────────────┘
```

### Count (radial)

Binds to `params.count`. Min = 1 (a single instance at angle 0 is valid):

```typescript
function onRadialCountChange(groupId: string, v: number) {
  shapeManager.updateArrayParams3D(groupId, { count: Math.max(1, v) });
}
```

### Radius

```typescript
function onRadiusChange(groupId: string, v: number) {
  shapeManager.updateArrayParams3D(groupId, { radius: Math.max(0.1, v) });
}
```

### Arc

Degrees 1–360. 360 = full ring. Below 360, instances are distributed from angle 0 to arcDeg:

```typescript
function onArcChange(groupId: string, deg: number) {
  shapeManager.updateArrayParams3D(groupId, { arcDeg: Math.min(360, Math.max(1, deg)) });
}
```

### Axis buttons (radial)

```typescript
function onRadialAxisChange(groupId: string, axis: 'x' | 'y' | 'z') {
  shapeManager.updateArrayParams3D(groupId, { axis });
}
```

The meaning of the axis depends on the current orientation mode:

| Orientation | Axis `'y'` | Axis `'x'` | Axis `'z'` |
|-------------|-----------|-----------|-----------|
| **World** | Floor ring — instances in world XZ plane | Wall ring — instances in world YZ plane | Wall ring — instances in world XY plane |
| **Local** | Ring perpendicular to source's local Y axis | Ring perpendicular to source's local X axis | Ring perpendicular to source's local Z axis |

### Orientation toggle (World / Local)

The radial ring can orbit around a world axis or the source mesh's own local axis. This is driven by the gizmo's orientation mode — the same toggle that controls Move/Rotate/Scale gizmo behavior.

```typescript
// Read current orientation mode:
const mode = shapeManager.scene3d.getGizmoOrientation(); // 'world' | 'local'

// Set it (also changes the gizmo mode for Move/Rotate/Scale):
shapeManager.scene3d.setGizmoOrientation('local');  // 'world' | 'local'
```

When the orientation toggle button (World / Local) changes:
- The gizmo axes flip to local space
- The radial ring immediately reorients — the same arc now orbits around the source's own Y/X/Z axis instead of the world axis
- No `arrayParams` change is needed; the engine recomputes instance positions each frame using the source's current `localMatrix`

When the source mesh is not rotated, world and local modes produce identical output.

### Gizmo (radial)

A circle arc is drawn at the current radius in the ring plane, plus a shaft from the center to the angle-0 handle. In **local orientation mode** the arc is drawn relative to the source's local axes, so it tilts with the mesh. Dragging the angle-0 sphere changes `radius`. Count and arc are adjusted via the panel sliders only — no drag handles for those.

---

## API Reference

All methods on `shapeManager` (`ShapeManager`):

**Array Tool (hover-handle mode)**

| Method | Description |
|--------|-------------|
| `enableArrayTool(mode?, initialCount?)` | Activate hover-handle mode. `mode` = `'line'` \| `'grid'` \| `'radial'`. Default: `'line'`, count = 3. |
| `disableArrayTool()` | Deactivate; clears all ghost/handle visuals. |
| `setArrayToolMode(mode)` | Switch mode while active. |
| `setArrayToolCount(count)` | Override ghost copy count (1–32) from a panel control. |
| `getArrayToolCount()` | Read current count back for panel display. |
| `setArrayToolAxis(axis)` | Set the radial ring axis (`'x'` \| `'y'` \| `'z'`). Ghost updates immediately. |
| `getArrayToolAxis()` | Current radial axis. Default `'y'`. |
| `setArrayToolRadius(r)` | Set ring radius (`number`) or restore auto-AABB sizing (`null`). Ghost updates immediately. |
| `getArrayToolRadius()` | Current radius override, or `null` if auto-sizing. |
| `setArrayToolArc(deg)` | Set arc span in degrees (1–360). Ghost updates immediately. |
| `getArrayToolArc()` | Current arc in degrees. Default `360`. |

**Array creation**

| Method | Description |
|--------|-------------|
| `createLinearArray3D(sourceId, count?, spacing?)` | Create a linear array. Default count = 3, spacing = source width + 10% gap along world-X. |
| `createGridArray3D(sourceId, countX?, spacingX?, countY?, spacingY?, diagonalOnly?)` | Create a grid array. Defaults: 2×2, source AABB-based spacing. |
| `createRadialArray3D(sourceId, count?, radius?, axis?, arcDeg?)` | Create a radial ring. Defaults: 6 instances, Y axis, 360°. |

**Array management**

| Method | Description |
|--------|-------------|
| `updateArrayParams3D(groupId, partialParams)` | Live-update any params. Does **not** push undo. |
| `bakeArray3D(groupId)` | Convert to N+1 independent meshes in a `MeshGroup3D`. Pushes undo. Source is kept in scene if other repeats reference it. |
| `bakeArrayMerged3D(groupId)` | Merge all copies into a single welded `Mesh3D`. Respects `gapFill` and `weldThreshold` on `LinearArrayParams`. Pushes undo. Linear mode only. |
| `isArrayGroup3D(nodeId)` | `true` if this node is an `ArrayGroup3D`. |
| `getArrayParams3D(groupId)` | Returns `LinearArrayParams \| GridArrayParams \| RadialArrayParams` or `null`. |
| `getArraySourceId(groupId)` | Returns the source mesh ID, or `null` if not found. |
| `getArrayGroupsForSource3D(sourceId)` | Returns all `ArrayGroup3D` IDs whose source is `sourceId`. |

**Object offset (linear arrays only)**

Set `objectOffsetId` on the array params to make each copy inherit the transform of an offset mesh relative to the source. Copy *i* gets `D^i × sourceMat` where `D = offsetMesh.localMatrix × inv(sourceMat)`. Moving, rotating, or scaling the offset mesh live-updates all copies. When `objectOffsetId` is set, `spacing` is ignored.

```typescript
// Set an offset mesh to drive per-step transform:
shapeManager.updateArrayParams3D(groupId, { objectOffsetId: offsetMeshId });

// Clear object offset (revert to spacing-based placement):
shapeManager.updateArrayParams3D(groupId, { objectOffsetId: undefined });
```

Use case: staircase railings, DNA helices, coiling cables — anything where each step also rotates or scales, not just translates.

**Per-instance overrides**

| Method | Description |
|--------|-------------|
| `setInstanceOverride3D(groupId, index, override)` | Set a rotation/scale/visibility override on one instance slot. Pushes undo. |
| `clearInstanceOverride3D(groupId, index)` | Remove the override and restore source defaults. Pushes undo. |
| `getInstanceOverrides3D(groupId)` | Returns `{ index, override }[]` for all overridden instances. |

`InstanceOverride` shape:
```typescript
interface InstanceOverride {
  rotationEulerDeg?: [number, number, number]; // additional XYZ local-space rotation, degrees
  scale?:            [number, number, number]; // per-axis multiplier (1.0 = no change)
  visible?:          boolean;                  // false = skip rendering this instance
}
```

Example: rotate instance 2 by 90° around Y, and hide instance 4:
```typescript
sm.setInstanceOverride3D(groupId, 2, { rotationEulerDeg: [0, 90, 0] });
sm.setInstanceOverride3D(groupId, 4, { visible: false });
```

**Gizmo orientation (also controls radial ring axis)**

| Method | Description |
|--------|-------------|
| `scene3d.getGizmoOrientation()` | Returns `'world'` \| `'local'`. |
| `scene3d.setGizmoOrientation(mode)` | Sets world or local mode. Affects the Move/Rotate/Scale gizmo axes **and** the radial array ring plane. |

**Scene graph change subscription**

```typescript
// Subscribe to any scene-graph change (selection, params update, bake, undo, etc.):
shapeManager.interactionService.onSceneGraphChanged.subscribe(() => {
  // re-read params and update panel
});
```

**Pushing a manual undo step** (for panel-driven count/spacing changes):

```typescript
shapeManager.scene3d.pushCommand3D({
  description: 'Change array count',
  undo: () => { /* restore old params */ },
  redo: () => { /* re-apply new params */ },
});
```
