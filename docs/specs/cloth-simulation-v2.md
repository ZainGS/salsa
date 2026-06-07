# Cloth System Improvements — Design Spec
**Last Updated:** 2026-06-06  

> **Status: ✅ COMPLETE (all three items shipped)**
> Covers three issues raised 2026-05-03:
>  1. ✅ Bug: duplicate mesh after re-edit + simulate — fixed in Frogmarks (`previewMeshId = existingMeshId` at modal open in `cloth-builder.component.ts:260-261`)
>  2. ✅ Feature: live simulation preview inside the builder modal — `LiveClothHandle` in `src/renderer/3d/live-cloth-simulation.ts`, `createLiveClothSim` in `scene3d-manager.ts`
>  3. ✅ Feature: Wind Frame Link Animation + live cloth physics in the scene — `enableLiveCloth`/`disableLiveCloth`, `'wind'` `FrameLinkAnimation3DType`, self-registering `_ensureLiveClothTick` preRenderCallback

---

## 1. Bug: Duplicate Mesh on Re-Edit

### Root Cause

This is a **Frogmarks-side bug** caused by an incorrect initial value in the builder state. The handoff doc specified `previewMeshId = null` at modal open for both new and re-edit flows. For the re-edit flow this is wrong.

**What happens:**
1. User double-clicks existing cloth → modal opens with `existingMeshId = "A"`, `previewMeshId = null`
2. User clicks [Hang ▶]
3. Modal code: `if (!previewMeshId) { previewMeshId = createClothMesh(...).id }` → creates mesh "B" **(duplicate)**
4. Simulation result applied to "B", original "A" untouched
5. Scene now has A + B visible simultaneously

If the user clicks [Create], the doc's cleanup step (`removeNode(previewMeshId)`) does remove B — so the duplicate disappears. But it was visible throughout the modal session, which reads as a bug.

**If the user clicks [Create] without running simulation first**, `previewMeshId` is still null → no cleanup step fires, A is updated correctly → no bug. That's why the user sees it specifically "when I resimulate."

### Fix (Frogmarks)

Initialize `previewMeshId = existingMeshId` at modal open in re-edit mode. The existing node acts as the live preview target — no separate mesh is created. Save the original state for Cancel restoration.

```typescript
// ── At modal open (re-edit) ──────────────────────────────────────────────────
const cfg     = scene3dManager.getClothConfig(existingMeshId)!;
const node    = getNodeById(existingMeshId) as ClothMesh3D;

setState({
    existingMeshId,
    previewMeshId: existingMeshId,   // ← fix: use existing mesh as preview target

    // Spread current config as editable state
    ...cfg.grid,
    ...cfg.physics,
    simMode: node.simState.simulationMode,

    // Save original state for Cancel
    _savedGrid:      { ...cfg.grid },
    _savedPhysics:   { ...cfg.physics },
    _savedPositions: Float32Array.from(node.simState.positions),
    _savedSimMode:   node.simState.simulationMode,
});

// ── On [Hang ▶] or [Drape ▶] ─────────────────────────────────────────────────
// The `if (!previewMeshId)` branch never fires in re-edit mode.
// updateClothMeshPose(existingMeshId, ...) updates the original in-place.

// ── On [Create] ──────────────────────────────────────────────────────────────
// replaceClothMesh(existingMeshId, ...) — same as before.
// No removeNode needed; previewMeshId === existingMeshId.

// ── On [Cancel] ──────────────────────────────────────────────────────────────
if (existingMeshId) {
    // Restore original appearance (the mesh was updated live during simulation)
    scene3dManager.replaceClothMesh(
        existingMeshId,
        state._savedGrid,
        state._savedPhysics,
        state._savedPositions,
        state._savedSimMode,
    );
} else if (previewMeshId) {
    scene3dManager.removeNode(previewMeshId);
}
```

**Salsa changes needed:** None. This is entirely a Frogmarks state-management fix.

---

## 2. Feature: Live Cloth Builder Preview

### Problem

The current flow is a blind feedback loop:

```
design grid → [Hang ▶] → wait 0.5–3s → static result → close → re-open to edit → repeat
```

Users can't see how their grid shape, pinning, or physics settings affect the drape until after a full simulation run. This is slow and discouraging for experimentation.

### Proposed Experience

When the builder modal opens, a simulation starts automatically and runs continuously. The cloth settles in real time as the user watches. Physics sliders update the live cloth immediately. Grid changes (cols, cells, pins) trigger a near-instant reset and re-simulation.

```
open modal → cloth starts falling live → tweak gravity → cloth responds → [Create]
```

---

### New Salsa API

#### `LiveClothHandle`

```typescript
interface LiveClothHandle {
    /**
     * Rebuild geometry and restart simulation from flat.
     * Called when grid config or simulation mode/proxy changes.
     */
    reset(
        grid:    ClothGridConfig,
        physics: ClothPhysicsConfig,
        mode:    'hang' | 'drape',
        proxy?:  DrapeProxy,
    ): void;

    /**
     * Hot-update physics uniforms without resetting positions.
     * Safe to call every slider tick. Only gravity/damping/stiffness/wind.
     * Grid-dependent params (pinnedVertices, etc.) require reset().
     */
    setPhysics(params: Partial<Pick<ClothPhysicsConfig,
        'gravity' | 'damping' | 'stiffness' | 'wind'>>): void;

    /**
     * Callback fired after each update batch with the latest vertex positions.
     * Set by Frogmarks: (pos) => scene3dManager.updateClothMeshPose(previewId, pos, mode)
     */
    onPositionsUpdate: ((positions: Float32Array) => void) | null;

    /** Returns current positions (one GPU readback, ~1–2ms). */
    snapshot(): Promise<Float32Array>;

    pause():  void;
    resume(): void;

    readonly running:     boolean;
    readonly vertexCount: number;

    /** Destroy all GPU resources. Always call on modal close. */
    destroy(): void;
}
```

#### `scene3dManager.createLiveClothSim`

```typescript
scene3dManager.createLiveClothSim(
    grid:    ClothGridConfig,
    physics: ClothPhysicsConfig,
    mode:    'hang' | 'drape',
    proxy?:  DrapeProxy,
): LiveClothHandle | null   // null if WebGPU not available
```

#### Internal design of `LiveClothHandle`

- Owns a `ClothSimulator` instance.
- Runs a self-managed `requestAnimationFrame` loop.
- Each frame: dispatch N simulation steps (default 4) → submit async readback → on resolve, call `onPositionsUpdate`.
- Because readback is async, there is a 1-frame lag between simulation and mesh update. This is invisible to users.
- `setPhysics()` writes new values directly to the simulator's uniform buffers (no geometry rebuild).
- `reset()` destroys the current simulator, builds new `ClothGeometryResult`, creates a fresh simulator, and restarts the loop.
- Steps-per-frame config: 4 for interactive feel during convergence; increases to 8 after convergence (detected when max displacement < 0.001) to keep wind animation lively without burning frame budget.

#### New `ClothSimulator` method needed

```typescript
// Hot-update the integrate/constrain uniform buffers without rebuilding geometry.
// Only gravity, damping, stiffness, and wind are hot-updatable.
ClothSimulator.setPhysicsParams(params: Partial<Pick<ClothPhysicsConfig,
    'gravity' | 'damping' | 'stiffness' | 'wind'>>): void
```

---

### Builder Modal Redesign (Frogmarks)

#### UX Changes

| Current | Proposed |
|---------|----------|
| [Hang ▶] and [Drape ▶] buttons | Simulation mode toggle: **Off / Hang / Drape** |
| User clicks button to trigger sim | Changing mode auto-starts live sim |
| Static result shown after wait | Cloth falls and settles in real time |
| [Create] bakes snapshot | [Create] snapshots current live positions |

The toggle replaces both action buttons. "Off" shows the flat grid (useful when the user just wants to edit the grid shape quickly without waiting for simulation).

#### Modal State Changes

```typescript
interface ClothBuilderState {
    // ... (existing fields) ...
    liveSimMode: 'off' | 'hang' | 'drape';   // replaces simMode
    _liveHandle: LiveClothHandle | null;       // Salsa handle (not serialized)
}
```

#### Lifecycle Code

```typescript
// ── On liveSimMode change ─────────────────────────────────────────────────────
function onSimModeChange(newMode: 'off' | 'hang' | 'drape') {
    state._liveHandle?.destroy();

    if (newMode === 'off') {
        setState({ liveSimMode: 'off', _liveHandle: null });
        return;
    }

    const handle = scene3dManager.createLiveClothSim(
        buildGrid(state), buildPhysics(state), newMode, state.drapeProxy,
    );
    if (!handle) { showToast('WebGPU required for live simulation', 'error'); return; }

    handle.onPositionsUpdate = (pos) => {
        scene3dManager.updateClothMeshPose(state.previewMeshId!, pos, newMode);
        setState({ lastSimPositions: pos });
    };

    setState({ liveSimMode: newMode, _liveHandle: handle, lastSimPositions: null });
}

// ── On grid param change (cols, rows, activeCells, cornerRadius, cellSize, pinnedVertices)
function onGridChange(field, value) {
    // Update state immediately for the canvas redraw
    setState({ [field]: value });
    debouncedResetSim(500);   // 500ms debounce — reset live sim with new grid
}

// ── On physics slider change (gravity, damping, stiffness, wind)
function onPhysicsChange(field, value) {
    setState({ [field]: value });
    if (state._liveHandle && state.liveSimMode !== 'off') {
        debouncedHotUpdate(100);  // 100ms debounce — hot-update uniforms
    }
}

function debouncedHotUpdate() {
    state._liveHandle?.setPhysics({
        gravity:  state.gravity,
        damping:  state.damping,
        stiffness: state.stiffness,
        wind:     state.wind,
    });
}

function debouncedResetSim() {
    state._liveHandle?.reset(buildGrid(state), buildPhysics(state), state.liveSimMode, state.drapeProxy);
}

// ── [Create] ─────────────────────────────────────────────────────────────────
async function onCreate() {
    let positions = state.lastSimPositions ?? undefined;
    if (state._liveHandle && state.liveSimMode !== 'off') {
        positions = await state._liveHandle.snapshot();
    }
    state._liveHandle?.destroy();

    if (state.existingMeshId) {
        scene3dManager.replaceClothMesh(
            state.existingMeshId, buildGrid(state), buildPhysics(state),
            positions, state.liveSimMode !== 'off' ? state.liveSimMode : 'none',
        );
    } else {
        const mesh = scene3dManager.createClothMesh(
            dropX, dropY, dropZ, buildGrid(state), buildPhysics(state),
            positions, state.name,
        );
    }
    closeModal();
}

// ── [Cancel] ─────────────────────────────────────────────────────────────────
function onCancel() {
    state._liveHandle?.destroy();
    if (state.existingMeshId) {
        scene3dManager.replaceClothMesh(
            state.existingMeshId,
            state._savedGrid, state._savedPhysics,
            state._savedPositions, state._savedSimMode,
        );
    } else if (state.previewMeshId) {
        scene3dManager.removeNode(state.previewMeshId);
    }
    closeModal();
}
```

#### "Reset to Flat" button

Calls `handle.reset(grid, physics, mode, proxy)` — cloth returns to flat and re-simulates from scratch. Useful after draping to preview a different proxy.

---

## 3. Feature: Wind Frame Link Animation + Live Cloth Physics

### Problem

Cloth meshes are currently static — the simulation is baked at create time. A hanging banner or flag should react to wind in the scene. The user wants a "Wind" animation that keeps the cloth physics running at runtime.

### Two Linked Changes

This feature requires two things working together:
1. **Live cloth physics in the scene** — a mesh whose vertex buffer is updated every render frame by a running simulator.
2. **Wind Frame Link Animation** — a stateless procedural animation (consistent with the existing `FrameLinkAnimation3D` system) that drives the wind force.

---

### 3.1 Wind Frame Link Animation

Add `'wind'` to `FrameLinkAnimation3DType` in `src/types/keyframe-3d.ts`.

**Interpretation of existing fields in wind context:**

| Field | Meaning for 'wind' |
|-------|-------------------|
| `axis` | Primary wind direction (`'x'` = sideways, `'z'` = depth, `'y'` = updraft) |
| `amplitude` | Peak wind force in world units/s² |
| `framesPerCycle` | Frames per full gust cycle (e.g. 48 = 2 s at 24 fps) |
| `phase` | Phase offset (0–1) to stagger multiple cloths |

**Wind vector at frame F:**

```
strength = amplitude × sin((F / framesPerCycle + phase) × 2π)
windVec  = strength × axisUnitVector
```

Axis unit vectors: `x → [1,0,0]`, `y → [0,1,0]`, `z → [0,0,1]`.

**Output from `evalFrameLink3D`:**

Add a `wind: Vec3Value` field to the return object (defaults to `[0,0,0]` for non-wind types). The existing pos/rot/scale/uvOffset outputs are unchanged — wind is additive.

```typescript
// evalFrameLink3D return type addition:
wind: Vec3Value   // [wx, wy, wz] world units/s²
```

For `type !== 'wind'`: `wind = [0, 0, 0]` — no change to existing behavior.

---

### 3.2 Live Cloth Physics in Scene

#### New field on `ClothMesh3D`

```typescript
interface ClothLiveConfig {
    /** When true, cloth simulation runs every render frame. */
    enabled: boolean;
    /** Simulation steps dispatched per render frame. Default 4. */
    stepsPerFrame: number;
}
```

Add `liveConfig: ClothLiveConfig` to `ClothMesh3D`:

```typescript
export const DEFAULT_CLOTH_LIVE: ClothLiveConfig = {
    enabled: false,
    stepsPerFrame: 4,
};
```

Persist in `toJSON()` / `restoreMeshState`.

#### Scene3DManager additions

```typescript
/** Enable/disable live physics for a cloth mesh. */
scene3dManager.enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean
scene3dManager.disableLiveCloth(meshId: string, bakeCurrentPose?: boolean): boolean
```

- `enableLiveCloth`: creates a `LiveClothHandle` for the mesh, stores it in `_liveClothHandles: Map<string, LiveClothHandle>`, starts the simulation from the mesh's current `simState.positions`.
- `disableLiveCloth`: destroys the handle; if `bakeCurrentPose=true`, snapshots positions and calls `updateClothMeshPose` to freeze the current shape.

#### Per-frame update hook

`Scene3DManager` exposes:

```typescript
/** Called by the WebGPU renderer once per render frame, before draw calls. */
tickLiveCloths(frame: number): void
```

Inside `tickLiveCloths`:
- For each live cloth handle: dispatch `stepsPerFrame` steps.
- Submit a readback for each (async, resolved next frame).
- On readback resolve: read the node's `frameLink` animation, compute wind via `evalFrameLink3D(anim, frame).wind`, pass to `handle.setPhysics({ wind: { x, y, z } })`, then `updateClothMeshPose(meshId, positions)`.

**Frame budget:** For a 24 fps scene with 4 steps/frame per cloth at 100 vertices: ~4 × 0.1ms GPU dispatch + 0.5ms readback = ~0.9ms per live cloth. Two cloths ≈ 2ms — acceptable.

#### WebGPU Renderer integration

In `WebGPURenderer.render()` (or equivalent per-frame entry point):

```typescript
// At top of render, before any draw calls:
scene3dManager.tickLiveCloths(currentFrame);
```

---

### 3.3 Inspector UX (Frogmarks)

Under **Physics** section for a ClothMesh3D node:

```
┌─────────────────────────────────────────────┐
│  Live Physics                               │
│  ☐ Enable live simulation     [4] steps/frame│
│                                             │
│  Wind Animation (Frame Link)                │
│  ☐ Enable                                   │
│  Direction:  ● X  ○ Y  ○ Z                  │
│  Peak Force: [────●────────────] 3.0 u/s²   │
│  Gust Speed: [──●──────────────] 48 frames  │
│  Phase:      [────────●────────] 0.25        │
└─────────────────────────────────────────────┘
```

**"Enable live simulation" checkbox:**
- On: calls `scene3dManager.enableLiveCloth(meshId)`
- Off: calls `scene3dManager.disableLiveCloth(meshId, true)` (bake current pose)

**Wind Animation section:** Visible only when live simulation is enabled. Maps directly to the `FrameLinkAnimation3D` fields on the cloth node (type = `'wind'`).

**One constraint:** Wind animation requires live physics to be on. If the user enables Wind but not live physics, auto-enable live physics (or grey out Wind and show tooltip).

---

## 4. Summary of Changes Required

### Salsa — ✅ All done

| File | Status |
|------|--------|
| `cloth-simulator.ts` | ✅ `setPhysicsParams(params)` implemented |
| `scene-graph/shapes/cloth-mesh-3d.ts` | ✅ `ClothLiveConfig` + `liveConfig` field |
| `services/managers/scene3d-manager.ts` | ✅ `createLiveClothSim`, `enableLiveCloth`, `disableLiveCloth`, `tickLiveCloths` |
| `types/keyframe-3d.ts` | ✅ `'wind'` in `FrameLinkAnimation3DType`; `wind: Vec3Value` in `evalFrameLink3D` return |
| `renderer/3d/live-cloth-simulation.ts` | ✅ `LiveClothHandle` class (new file) |
| `renderer/core/webgpu-renderer.ts` | ✅ tick wired via self-registering `_ensureLiveClothTick` preRenderCallback (not a direct call) |

### Frogmarks — ✅ All done

| Component | Status |
|-----------|--------|
| `ClothBuilderModal` | ✅ Bug fix: `previewMeshId = existingMeshId` at re-edit open (`cloth-builder.component.ts:260-261`) |
| `ClothBuilderModal` | ✅ Mode toggle + `LiveClothHandle` integration |
| `ClothInspectorPanel` | ✅ Live Physics checkbox + Wind Animation controls |
