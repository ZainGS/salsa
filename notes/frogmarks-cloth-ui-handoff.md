# Cloth Mesh Builder — Frogmarks UI Handoff

> **Scope:** Everything Frogmarks needs to build cloth mesh creation and editing UI on top of the Salsa 3D engine. Salsa handles all GPU simulation, geometry construction, and scene graph integration. Frogmarks owns all React UI.
>
> **Updated 2026-05-04:** Salsa has shipped live simulation (`createLiveClothSim`, `LiveClothHandle`) and Wind Frame Link Animation. See §3 for new APIs, §4.3/4.4 for revised builder UX, §6 for inspector changes.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Type Reference](#2-type-reference)
3. [Salsa API Reference](#3-salsa-api-reference)
4. [Cloth Builder Modal](#4-cloth-builder-modal)
   - 4.1 [Modal Lifecycle](#41-modal-lifecycle)
   - 4.2 [Grid Editor Canvas](#42-grid-editor-canvas)
   - 4.3 [Physics Panel](#43-physics-panel)
   - 4.4 [Simulation Preview](#44-simulation-preview)
   - 4.5 [React State Model](#45-react-state-model)
5. [API Call Sequences](#5-api-call-sequences)
   - 5.1 [Create (new cloth)](#51-create-new-cloth)
   - 5.2 [Create with Simulation](#52-create-with-simulation)
   - 5.3 [Re-Edit Existing Cloth](#53-re-edit-existing-cloth)
   - 5.4 [Cancel](#54-cancel)
6. [Inspector Panel Extension](#6-inspector-panel-extension)
7. [Phase 3 Gaps and Workarounds](#7-phase-3-gaps-and-workarounds)
8. [Error Handling](#8-error-handling)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Frogmarks React App                                │
│  ┌──────────────────────┐  ┌───────────────────┐   │
│  │  ClothBuilderModal   │  │ Inspector Panel   │   │
│  │  (grid editor +      │  │ (cloth properties │   │
│  │   physics controls)  │  │  for selected     │   │
│  └──────────┬───────────┘  │  ClothMesh3D)     │   │
│             │              └─────────┬─────────┘   │
└────────────┼─────────────────────────┼─────────────┘
             │  Scene3DManager API      │
┌────────────▼─────────────────────────▼─────────────┐
│  Salsa 3D Engine                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  scene3dManager                              │  │
│  │  .createClothMesh()    — add new node        │  │
│  │  .replaceClothMesh()   — re-edit in-place    │  │
│  │  .simulateCloth()      — GPU physics → pos[] │  │
│  │  .updateClothMeshPose()— live preview update │  │
│  │  .getClothConfig()     — load existing cfg   │  │
│  └──────────────────────────────────────────────┘  │
│  ┌────────────────┐  ┌──────────────────────────┐  │
│  │ ClothGeometry  │  │  ClothSimulator (WebGPU)  │  │
│  │ Builder (CPU)  │  │  3 compute passes / step  │  │
│  └────────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Salsa provides:** mesh geometry generation, constraint graph, GPU Verlet simulation, scene graph node (`ClothMesh3D`), serialization / reload.

**Frogmarks builds:** all UI — the Cloth Builder modal, inspector controls, toolbar button, and any canvas drawing for grid editing.

---

## 2. Type Reference

These types are exported from Salsa. Import them from wherever `scene3dManager` is exposed.

### `ClothGridConfig`
```typescript
interface ClothGridConfig {
  cols: number;           // number of quad columns (min 1)
  rows: number;           // number of quad rows (min 1)
  cellSize: number;       // world-unit edge length per quad (e.g. 0.1)
  cornerRadius: number;   // corner rounding in cells (0 = sharp corners)
  activeCells: boolean[]; // flat array [row * cols + col]; true = quad exists
  pinnedVertices: number[]; // dense vertex indices pinned (immovable in sim)
}
```

### `ClothPhysicsConfig`
```typescript
interface ClothPhysicsConfig {
  gravity: number;        // downward acceleration (m/s²); default 9.8
  damping: number;        // velocity retention per step (0–1); default 0.98
  stiffness: number;      // constraint-solve iterations per step; default 30
  thickness: number;      // shell extrusion depth (world units); 0 = single surface
  solidifyRounded: boolean; // half-cylinder hem profile when thickness > 0
  wind?: { x: number; y: number; z: number }; // constant wind acceleration (world units/s²)
}
```

### `ClothSimState` (read-only, returned on node)
```typescript
interface ClothSimState {
  positions: number[];          // [x,y,z] per vertex, post-simulation
  isSimulated: boolean;         // true once a simulation has been accepted
  simulationMode: 'hang' | 'drape' | 'none';
}
```

### `DrapeProxy`
```typescript
type DrapeProxy =
  | { type: 'none' }
  | { type: 'ground'; y?: number }         // y defaults to 0
  | { type: 'sphere'; center?: [number,number,number]; radius: number }
  | { type: 'box'; min: [number,number,number]; max: [number,number,number] };
```

### Defaults
```typescript
const DEFAULT_CLOTH_GRID: ClothGridConfig = {
  cols: 8, rows: 10, cellSize: 0.1, cornerRadius: 0,
  activeCells: [],   // filled by createClothMesh / simulateCloth
  pinnedVertices: [],
};

const DEFAULT_CLOTH_PHYSICS: ClothPhysicsConfig = {
  gravity: 9.8, damping: 0.98, stiffness: 30,
  thickness: 0, solidifyRounded: false,
};
```

---

## 3. Salsa API Reference

All methods live on `scene3dManager` (the `Scene3DManager` singleton).

---

### `createClothMesh`
Creates a new `ClothMesh3D` node and adds it to the scene graph.

```typescript
scene3dManager.createClothMesh(
  x: number,
  y: number,
  z: number,
  gridConfig?: Partial<ClothGridConfig>,    // missing fields get defaults
  physicsConfig?: Partial<ClothPhysicsConfig>,
  simulatedPositions?: Float32Array,        // [x,y,z] × vertexCount from simulateCloth
  name?: string,
): ClothMesh3D
```

- Returns the new node. The node is immediately in the scene graph and will render.
- If `simulatedPositions` is provided, geometry is baked with those positions. Otherwise the cloth is rendered flat on the XZ plane.
- `simulatedPositions.length` must equal `vertexCount * 3` (mismatch → silently ignored, flat used).

---

### `replaceClothMesh`
Updates an existing `ClothMesh3D` in-place. Preserves node ID, layer order, name, and material.

```typescript
scene3dManager.replaceClothMesh(
  meshId: string,
  gridConfig: ClothGridConfig,
  physicsConfig: ClothPhysicsConfig,
  simulatedPositions?: Float32Array,
  mode?: 'hang' | 'drape' | 'none',       // default 'none'
): boolean  // false if node not found or not ClothMesh3D
```

Use this for the **re-edit flow**: fetch config with `getClothConfig`, let the user modify it, then call `replaceClothMesh` on [Create].

---

### `simulateCloth`
Runs GPU cloth physics to steady state. Does **not** create or modify any scene node.

```typescript
await scene3dManager.simulateCloth(
  gridConfig:    Partial<ClothGridConfig>,
  physicsConfig: Partial<ClothPhysicsConfig>,
  mode: 'hang' | 'drape',
  proxy?: DrapeProxy,     // default { type: 'none' }; only used for 'drape'
  maxSteps?: number,      // default 3000
): Promise<Float32Array>  // [x, y, z] per vertex at steady state
```

**Hang mode:** top row of vertices is auto-pinned (if `pinnedVertices` is empty). Cloth hangs under gravity.

**Drape mode:** cloth starts above the proxy shape and falls onto it. `proxy` must be set. The `pinnedVertices` array in `gridConfig` is respected for drape as well (e.g. if the user has manually pinned vertices).

**Duration:** ~0.5–3 s for an 8×10 cloth on modern hardware. Show a loading spinner while awaiting. Throws if WebGPU is unavailable.

---

### `updateClothMeshPose`
Applies new vertex positions to an existing node without rebuilding geometry config. Used for live preview inside the modal before the user commits.

```typescript
scene3dManager.updateClothMeshPose(
  meshId: string,
  simulatedPositions: Float32Array,   // [x,y,z] × vertexCount
  mode?: 'hang' | 'drape' | 'none',  // default 'none'
): boolean
```

Returns `false` if the node is not found or if `simulatedPositions.length` doesn't match the cached vertex count.

---

### `getClothConfig`
Fetches the current grid and physics config from an existing node. Use at modal open for re-edit.

```typescript
scene3dManager.getClothConfig(meshId: string):
  { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null
```

---

### `getClothGeometryResult`
Returns the cached geometry result (constraint graph, inverse masses, slot maps). Needed for advanced editor features. May be `null` if the mesh was loaded from a saved file — call `buildClothGeometry(grid)` to regenerate in that case.

```typescript
scene3dManager.getClothGeometryResult(meshId: string): ClothGeometryResult | null
```

---

### `createLiveClothSim` *(new)*
Creates a `LiveClothHandle` for interactive live preview in the Cloth Builder modal. The handle runs its own simulation loop via `requestAnimationFrame` and fires `onPositionsUpdate` after each GPU readback. **Always call `handle.destroy()` when the modal closes.**

```typescript
scene3dManager.createLiveClothSim(
  grid:    Partial<ClothGridConfig>,
  physics: Partial<ClothPhysicsConfig>,
  mode:    'hang' | 'drape',
  proxy?:  DrapeProxy,
): LiveClothHandle | null   // null if WebGPU unavailable
```

**`LiveClothHandle` interface:**
```typescript
interface LiveClothHandle {
  // Called with positions after each GPU readback — set before reset()
  onPositionsUpdate: ((positions: Float32Array) => void) | null;

  // Rebuild geometry + restart sim (call on grid/mode/proxy change, 500ms debounce)
  reset(grid, physics, mode, proxy?): void;

  // Hot-update gravity/damping/stiffness/wind without resetting positions (100ms debounce)
  setPhysics(params: Partial<Pick<ClothPhysicsConfig,
    'gravity' | 'damping' | 'stiffness' | 'wind'>>): void;

  snapshot(): Promise<Float32Array>;  // one GPU readback, ~1–2ms
  pause():    void;
  resume():   void;
  readonly running:     boolean;
  readonly vertexCount: number;
  destroy():  void;
}
```

**Auto-tuning:** The handle dispatches 4 steps/frame during convergence, dropping to 2 after max displacement < 0.001. No `stepsPerFrame` config needed.

---

### `enableLiveCloth` / `disableLiveCloth` *(new)*
Enable/disable persistent live physics on a cloth mesh in the scene (for Wind animation).

```typescript
scene3dManager.enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean
await scene3dManager.disableLiveCloth(meshId: string, bakeCurrentPose?: boolean): Promise<boolean>
```

- `enableLiveCloth`: starts a simulation loop for the mesh; the loop is driven by the WebGPU renderer's preRenderCallback — no manual tick needed.
- `disableLiveCloth(id, true)`: snapshots current positions and bakes them into the mesh geometry before stopping.
- Wind is driven by calling `scene3dManager.setFrameLinkAnimation3D(meshId, { enabled: true, type: 'wind', axis, amplitude, framesPerCycle, phase })`.

---

## 4. Cloth Builder Modal

### 4.1 Modal Lifecycle

The modal has two entry points:

| Entry | Trigger | Initial State |
|-------|---------|---------------|
| **Create new** | Toolbar "Cloth" button | Default grid (8×10), default physics, `previewMeshId = null` |
| **Re-edit** | Double-click existing `ClothMesh3D` in scene (or Inspector "Edit" button) | Loaded config from `getClothConfig(meshId)` |

**Critical: re-edit initialization.** Set `previewMeshId = existingMeshId` immediately at modal open (not null). This prevents a duplicate mesh from appearing when the user runs simulation. Also save the original state for Cancel:

```typescript
// At re-edit modal open:
const cfg  = scene3dManager.getClothConfig(existingMeshId)!;
const node = getNodeById(existingMeshId) as ClothMesh3D;
setState({
    existingMeshId,
    previewMeshId: existingMeshId,   // ← critical: use existing node as preview target
    ...cfg.grid, ...cfg.physics,
    liveSimMode: 'off',
    _savedGrid:      { ...cfg.grid },
    _savedPhysics:   { ...cfg.physics },
    _savedPositions: Float32Array.from(node.simState.positions),
    _savedSimMode:   node.simState.simulationMode,
});
```

---

### 4.2 Grid Editor Canvas

Recommended: **HTML5 Canvas 2D** (`<canvas>` element). Do not use the Salsa WebGPU canvas for grid editing — the 3D canvas is for the final render preview.

#### What to draw
```
┌───┬───┬───┬───┐
│ ▪ │ ▪ │ ▪ │ ▪ │   ▪ = active cell (filled)
├───┼───┼───┼───┤   □ = inactive cell (transparent / hatched)
│ ▪ │ □ │ ▪ │ ▪ │
├───┼───┼───┼───┤   ● = pinned vertex (blue circle over vertex)
│ ▪ │ ▪ │ ▪ │ ▪ │
└───┴───┴───┴───┘
```

- Draw `cols × rows` cells as squares.
- Color active cells (e.g. `#c8d8f0`), inactive cells (e.g. transparent or `#f0f0f0`).
- Draw vertex circles at grid intersections. Blue filled circles for pinned vertices.
- Highlight the top row of vertex circles in a distinct color (auto-pin indicator for Hang mode).

#### Interaction modes
| Mode | Cursor | On click/drag |
|------|--------|---------------|
| **Draw** (default) | Pencil | Toggle cell active/inactive |
| **Pin** | Pin icon | Toggle vertex pinned/unpinned |
| **Pan** | Hand | Pan the canvas view |

To convert a click position to a grid cell:
```typescript
// Given click at (cx, cy) on the canvas element:
const col = Math.floor((cx - panX) / (cellSizePx));
const row = Math.floor((cy - panY) / (cellSizePx));
if (col >= 0 && col < cols && row >= 0 && row < rows) {
  activeCells[row * cols + col] = !activeCells[row * cols + col];
}
```

To convert a click to a vertex (for pinning):
```typescript
// Vertices are at grid intersections:
const vc = Math.round((cx - panX) / cellSizePx);  // vertex col 0..cols
const vr = Math.round((cy - panY) / cellSizePx);  // vertex row 0..rows
// Convert to dense vertex index:
// (requires getClothGeometryResult, or maintain slot map locally)
```

**Simpler pin approach:** let the user draw a pin zone (e.g. top N rows) with a checkbox "Pin top row" rather than individual vertex picking. Salsa auto-pins the top slot row in Hang mode anyway if `pinnedVertices` is empty.

#### Corner radius control
A numeric input (0–min(cols,rows)/2). Cells in the n-cell corner region outside the quarter-circle are excluded. Re-run `buildClothGeometry` (CPU-only, instant) and redraw the canvas on change.

---

### 4.3 Physics Panel

| Control | Field | Type | Range | Default |
|---------|-------|------|-------|---------|
| Gravity | `gravity` | slider + number | 0–20 | 9.8 |
| Damping | `damping` | slider | 0.8–0.999 | 0.98 |
| Stiffness | `stiffness` | slider + number | 10–80 | 30 |
| Wind X/Y/Z | `wind.x/y/z` | three number inputs | −20–20 | 0 |
| Thickness | `thickness` | slider + number | 0–0.5 | 0 |
| Rounded Hem | `solidifyRounded` | checkbox | — | false |

**Thickness guidance:** Safe range is `0 – (min(clothWidth, clothHeight) × 0.03)`. For a default 8×10 cloth with `cellSize=0.1` (width=0.8, height=1.0), max safe thickness ≈ 0.024. Warn the user if they exceed this limit: "Thickness may cause visible artifacts at sharp corners." At `thickness=0` the cloth renders as a single surface (no wall).

---

### 4.4 Simulation Preview (Live)

Replace [Hang ▶] / [Drape ▶] buttons with a **simulation mode toggle: Off / Hang / Drape**. The simulation starts automatically when the user selects Hang or Drape — no button press needed.

**On mode toggle:**
```typescript
function onSimModeChange(newMode: 'off' | 'hang' | 'drape') {
    state._liveHandle?.destroy();
    if (newMode === 'off') { setState({ liveSimMode: 'off', _liveHandle: null }); return; }

    // Create preview mesh if needed (new cloth only)
    if (!state.previewMeshId) {
        const mesh = scene3dManager.createClothMesh(dropX, dropY, dropZ, buildGrid(state), buildPhysics(state));
        setState({ previewMeshId: mesh.id });
    }

    const handle = scene3dManager.createLiveClothSim(buildGrid(state), buildPhysics(state), newMode, state.drapeProxy);
    if (!handle) { showToast('WebGPU required for live simulation', 'error'); return; }

    handle.onPositionsUpdate = (pos) => {
        scene3dManager.updateClothMeshPose(state.previewMeshId!, pos, newMode);
        setState({ lastSimPositions: pos });
    };

    setState({ liveSimMode: newMode, _liveHandle: handle });
}
```

**On grid param change** (cols, rows, activeCells, cornerRadius, cellSize, pinnedVertices) — debounce 500ms:
```typescript
state._liveHandle?.reset(buildGrid(state), buildPhysics(state), state.liveSimMode, state.drapeProxy);
```

**On physics slider change** (gravity, damping, stiffness, wind) — debounce 100ms:
```typescript
state._liveHandle?.setPhysics({ gravity, damping, stiffness, wind });
```

**[Reset to Flat]** button: calls `handle.reset(...)` — cloth returns to flat and re-simulates.

**[Create]:**
```typescript
const positions = state._liveHandle ? await state._liveHandle.snapshot() : state.lastSimPositions;
state._liveHandle?.destroy();
// then createClothMesh or replaceClothMesh with positions
```

**[Cancel]:** `handle.destroy()` then restore original (re-edit) or `removeNode` (new cloth).

**Drape proxy selector:**
```
Collision: ○ None  ○ Ground  ○ Sphere  ○ Box
           [Ground Y: _0.0_]
```
Show the relevant inputs based on selection:
- Ground: `y` float input (default 0)
- Sphere: `center [x,y,z]` + `radius` float inputs
- Box: `min [x,y,z]` + `max [x,y,z]` float inputs

Build `DrapeProxy` from these values before calling `simulateCloth`.

---

### 4.5 React State Model

```typescript
interface ClothBuilderState {
  // Identity
  existingMeshId: string | null;   // null = creating new
  previewMeshId: string | null;    // temp node for in-modal preview

  // Grid config (mirrors ClothGridConfig)
  cols: number;
  rows: number;
  cellSize: number;
  cornerRadius: number;
  activeCells: boolean[];
  pinnedVertices: number[];

  // Physics
  gravity: number;
  damping: number;
  stiffness: number;
  wind: { x: number; y: number; z: number };

  // Simulation state
  liveSimMode: 'off' | 'hang' | 'drape';  // replaces simMode
  drapeProxy: DrapeProxy;
  lastSimPositions: Float32Array | null;
  _liveHandle: LiveClothHandle | null;     // not serialized; always null on init
  simError: string | null;

  // Re-edit: saved original state for Cancel restoration
  _savedGrid?: ClothGridConfig;
  _savedPhysics?: ClothPhysicsConfig;
  _savedPositions?: Float32Array;
  _savedSimMode?: 'hang' | 'drape' | 'none';

  // UI
  editorMode: 'draw' | 'pin' | 'pan';
}
```

**Initialization for new cloth:**
```typescript
const initial: ClothBuilderState = {
  existingMeshId: null,
  previewMeshId: null,
  cols: 8, rows: 10, cellSize: 0.1, cornerRadius: 0,
  activeCells: Array(8 * 10).fill(true),
  pinnedVertices: [],
  gravity: 9.8, damping: 0.98, stiffness: 30,
  wind: { x: 0, y: 0, z: 0 },
  simMode: 'none',
  drapeProxy: { type: 'none' },
  lastSimPositions: null,
  isSimulating: false,
  simError: null,
  editorMode: 'draw',
};
```

**Initialization for re-edit** (called with `meshId`):
```typescript
const cfg = scene3dManager.getClothConfig(meshId);
// cfg.grid and cfg.physics → spread into state
// Also read node.simState.positions / simulationMode from the ClothMesh3D node
```

---

## 5. API Call Sequences

### 5.1 Create (new cloth, flat / no simulation)

```
User fills grid  →  clicks [Create]
                         │
                         ▼
         scene3dManager.createClothMesh(
           x, y, z,
           { cols, rows, cellSize, cornerRadius, activeCells, pinnedVertices },
           { gravity, damping, stiffness, wind },
           undefined,   // no simulated positions → flat cloth
           name,
         )
                         │
                         ▼
                   ClothMesh3D added to scene
                   Close modal
```

**x, y, z:** Use the camera focus point or 0,0,0 as the drop position. The cloth is centered at that position.

---

### 5.2 Create with Simulation

```
User clicks [Hang ▶] or [Drape ▶]
                │
                ▼
  state.isSimulating = true  →  show spinner
                │
                ▼
  if (!previewMeshId):
    previewMeshId = scene3dManager.createClothMesh(x, y, z, grid, physics).id
                │
                ▼
  positions = await scene3dManager.simulateCloth(
    grid, physics, mode, drapeProxy, 3000
  )
                │
         ┌──────┴──────┐
       success        error
         │              │
         ▼              ▼
  updateClothMeshPose   show error toast
  (previewMeshId,       state.isSimulating = false
   positions, mode)     return
         │
         ▼
  state.lastSimPositions = positions
  state.simMode = mode
  state.isSimulating = false
  hide spinner

User then clicks [Create]:
         │
         ▼
  if (existingMeshId):           // re-edit path
    scene3dManager.replaceClothMesh(existingMeshId, grid, physics, lastSimPositions, mode)
    if (previewMeshId && previewMeshId !== existingMeshId):
      scene3dManager.removeNode(previewMeshId)   // clean up temp preview
  else:                          // new cloth path
    if (previewMeshId):
      scene3dManager.replaceClothMesh(previewMeshId, grid, physics, lastSimPositions, mode)
    else:
      scene3dManager.createClothMesh(x, y, z, grid, physics, lastSimPositions, name)
  Close modal
```

---

### 5.3 Re-Edit Existing Cloth

```
User double-clicks ClothMesh3D  (meshId known)
                │
                ▼
  cfg = scene3dManager.getClothConfig(meshId)
  node = scene (lookup by meshId, read node.simState)
  Open ClothBuilderModal with:
    existingMeshId = meshId
    ...spread cfg.grid
    ...spread cfg.physics
    simMode = node.simState.simulationMode
    lastSimPositions = Float32Array.from(node.simState.positions)
                │
                ▼
  (user edits grid / physics / runs new simulation)
                │
                ▼
  User clicks [Create]
                │
                ▼
  scene3dManager.replaceClothMesh(
    meshId,
    { cols, rows, cellSize, cornerRadius, activeCells, pinnedVertices },
    { gravity, damping, stiffness, wind },
    lastSimPositions ?? undefined,
    simMode !== 'none' ? simMode : 'none',
  )
  Close modal
```

---

### 5.4 Cancel

```
User clicks [Cancel]
        │
        ▼
  if (previewMeshId && previewMeshId !== existingMeshId):
    scene3dManager.removeNode(previewMeshId)   // clean up temp preview
  Close modal
```

This ensures no orphan nodes are left in the scene.

---

## 6. Inspector Panel Extension

When a `ClothMesh3D` node is selected, show these additional fields in the Inspector:

### Cloth Info (read-only)
```
Grid:       8 × 10  (cols × rows)
Cell size:  0.1
Vertices:   99
Triangles:  160
Simulated:  Yes (Hang)     ← from simState.isSimulated / simulationMode
```

To get vertex/triangle count:
```typescript
const result = scene3dManager.getClothGeometryResult(meshId);
// result?.vertexCount
// result?.geometry.indices.length / 3
// If null (loaded from file): rebuild via buildClothGeometry(getClothConfig(meshId).grid)
```

### Physics (read-only display, editable via [Edit] button)
```
Gravity:   9.8 m/s²
Damping:   0.98
Stiffness: 30 iterations
Wind:      0, 0, 0
```

### Edit Button
```
[✎ Edit Cloth...]
```
Opens `ClothBuilderModal` with `existingMeshId = selectedNode.id` (re-edit flow). Remember to set `previewMeshId = existingMeshId` at modal open.

### Live Physics Section *(new)*
```
Live Physics
☐ Enable live simulation
```

- **Enable on:** `scene3dManager.enableLiveCloth(meshId)` — cloth starts simulating every frame.
- **Enable off:** `await scene3dManager.disableLiveCloth(meshId, true)` — bakes current shape and stops.

### Wind Animation Section *(new, visible only when Live Physics is enabled)*
```
Wind Animation
☐ Enable
Direction:  ● X  ○ Y  ○ Z
Peak Force: [────●────────────] 3.0 u/s²
Gust Speed: [──●──────────────] 48 frames
Phase:      [────────●────────] 0.25
```

Maps directly to `FrameLinkAnimation3D` with `type = 'wind'`:

```typescript
// On any wind control change:
scene3dManager.setFrameLinkAnimation3D(meshId, {
    enabled: windEnabled,
    type: 'wind',
    axis:           state.windAxis,           // 'x' | 'y' | 'z'
    amplitude:      state.windAmplitude,      // peak force (u/s²)
    framesPerCycle: state.windFramesPerCycle, // gust frequency
    phase:          state.windPhase,          // 0–1
});
```

The live simulation tick reads this animation each frame and feeds the wind vector to the cloth simulator automatically — no additional wiring needed.

**One constraint:** Wind requires live physics. If the user enables Wind but live physics is off, auto-enable live physics first.

---

## 7. Known Limitations

| Feature | Status | Note |
|---------|--------|------|
| Shell solidification (thickness) | **Implemented** | Safe range `thickness < 3%` of cloth dimension; warn at runtime |
| Rounded hem (`solidifyRounded`) | **Implemented** | 4-segment half-cylinder arc; increase `arcSegments` in solidifyCloth call for smoother silhouette |
| Arc-vertex corner rounding | **Staircase approximation** | Corner radius deactivates cells in a staircase pattern; label it "Corner Cells" in UI |
| Subdivision (smoother cloth) | **Not planned** | Increase cols/rows for finer mesh |
| Graph-colored parallel constraint solve | **Sequential only** | No UI impact; simulation ~10% slower for cloths >50×50 |
| Undo/redo of simulation result | **Not wired** | Hook into the existing undo stack after `createClothMesh` / `replaceClothMesh` return |

---

## 8. Error Handling

### `simulateCloth` throws
```typescript
try {
  const positions = await scene3dManager.simulateCloth(...);
  // ...
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('WebGPU device not available')) {
    showToast('Cloth simulation requires WebGPU. Try Chrome 113+ or Edge 113+.', 'error');
  } else {
    showToast(`Simulation failed: ${msg}`, 'error');
  }
  setState({ isSimulating: false });
}
```

### `replaceClothMesh` / `updateClothMeshPose` returns `false`
This means the mesh was deleted while the modal was open. Close the modal and show a brief "Object no longer exists" notice.

### Grid validation before calling Salsa
```typescript
function validateGrid(state: ClothBuilderState): string | null {
  if (state.cols < 1 || state.cols > 200) return 'Columns must be 1–200';
  if (state.rows < 1 || state.rows > 200) return 'Rows must be 1–200';
  if (state.cellSize <= 0) return 'Cell size must be > 0';
  if (!state.activeCells.some(Boolean)) return 'At least one cell must be active';
  return null;
}
```

---

## 9. Quick Reference: Button → API

| UI Action | Salsa call |
|-----------|-----------|
| [Create] — new, no sim | `createClothMesh(x,y,z, grid, physics)` |
| [Create] — new, with live sim | `handle.snapshot()` → `createClothMesh(..., positions)` |
| [Create] — re-edit | `handle.snapshot()` → `replaceClothMesh(existingId, grid, physics, positions, mode)` |
| Sim mode toggle → Hang | `createLiveClothSim(grid, physics, 'hang')` |
| Sim mode toggle → Drape | `createLiveClothSim(grid, physics, 'drape', proxy)` |
| Sim mode toggle → Off | `handle.destroy()` |
| Grid param change | `handle.reset(newGrid, physics, mode)` (debounce 500ms) |
| Physics slider change | `handle.setPhysics(...)` (debounce 100ms) |
| [Reset to Flat] | `handle.reset(grid, physics, mode)` |
| Live preview update (auto) | `handle.onPositionsUpdate` → `updateClothMeshPose(previewId, pos, mode)` |
| Open re-edit modal | `getClothConfig(meshId)` + set `previewMeshId = existingMeshId` |
| Inspector vertex count | `getClothGeometryResult(meshId)?.vertexCount` |
| Inspector "Enable live physics" on | `enableLiveCloth(meshId)` |
| Inspector "Enable live physics" off | `disableLiveCloth(meshId, true)` |
| Inspector wind controls | `setFrameLinkAnimation3D(meshId, { type: 'wind', ... })` |
| Cancel new cloth | `handle.destroy()` + `removeNode(previewMeshId)` |
| Cancel re-edit | `handle.destroy()` + `replaceClothMesh(existingId, _savedGrid, _savedPhysics, _savedPositions, _savedSimMode)` |
