# Frogmarks: 3D Phase 4 UI Spec

> **Date:** April 27, 2026
> **Covers:** Shadow mapping, 3D undo/redo, frustum culling toggle, 3D/raster animation sync

This spec describes all Frogmarks UI work required to expose the Phase 4 salsa library additions. All APIs are already implemented in the library — this document tells the Angular app what to build.

---

## 1. Shadow Mapping

### What Was Added

A full shadow mapping pipeline was added to the 3D renderer. Opaque meshes cast and receive PCF soft shadows from the directional light. Shadows are disabled by default and require opt-in.

**Salsa API:**
```ts
sm.enableShadows3D(mapSize?, halfExtent?, bias?)
sm.disableShadows3D()
sm.shadowsEnabled3D  // getter: boolean
```

Or via `sm.scene3d`:
```ts
sm.scene3d.enableShadows(1024, 15, 0.002)
sm.scene3d.disableShadows()
sm.scene3d.shadowsEnabled  // getter: boolean
```

### Where to Show It

Add a **Shadows** subsection inside the existing **Lighting** accordion in the 3D Scene panel. Place it directly below the directional light controls.

### Layout

```
▸ LIGHTING ─────────────────────────────────
  Direction  X [0.3] Y [-0.8] Z [-0.5]
  Color      [■ #ffffff]  Intensity [1.0]

  Ambient    [■ #272733]  Intensity [1.0]

  ── Shadows ──────────────────────────────
  Cast Shadows   [OFF ○]  ←── toggle

  (when enabled:)
  Map Size       [1024 ▾]   ← dropdown: 512 / 1024 / 2048 / 4096
  Shadow Extent  [15  ════●═══]  range 5–50
  Bias           [0.002 ══●═══]  range 0.0001–0.02
```

### Behavior Notes

- **Toggle on:** calls `sm.enableShadows3D(mapSize, halfExtent, bias)`.
- **Toggle off:** calls `sm.disableShadows3D()`.
- Map size, extent, and bias changes should call `sm.enableShadows3D(...)` again with the new values (the method recreates the shadow texture).
- Show a warning tooltip for map size 4096: "High VRAM usage — use on powerful hardware only."
- Shadow extent controls the orthographic light frustum. For small scenes use 5–15; for larger scenes use 20–50. Expose as a labeled slider.
- Bias prevents shadow acne (flickering self-shadows). Default 0.002 is a safe starting point. Expose with 4 decimal places or as a small slider.
- Transparent meshes do **not** cast or receive shadows (library limitation — by design, transparent geometry is not in the shadow pre-pass).

### Example Code

```ts
// Enable button clicked:
sm.enableShadows3D(
  shadowMapSizeDropdown.value,   // e.g. 1024
  shadowExtentSlider.value,      // e.g. 15
  shadowBiasSlider.value,        // e.g. 0.002
);

// Disable button clicked:
sm.disableShadows3D();

// Read state (e.g., initializing panel UI):
shadowToggle.checked = sm.shadowsEnabled3D;
```

---

## 2. 3D Undo / Redo

### What Was Added

A closure-based command stack (`UndoManager3D`) with depth 50. Currently it records:
- **Gizmo drag transforms** — any move/rotate/scale performed via the on-canvas gizmo automatically pushes an undo command when the drag finishes.

Future extensions (create/delete mesh, material change) can be added by pushing commands via `sm.scene3d._undoManager` or by extending `Scene3DManager`. For now, gizmo transforms are the main use case.

**Salsa API:**
```ts
sm.undo3D()                  // returns true if something was undone
sm.redo3D()                  // returns true if something was redone
sm.canUndo3D                 // boolean getter
sm.canRedo3D                 // boolean getter
sm.undoDescription3D         // string | null — describes next undoable action
sm.redoDescription3D         // string | null — describes next redoable action
sm.clearUndo3D()             // clear stack (e.g., on scene reset)
```

### Keyboard Shortcuts

Wire the existing keyboard shortcut handler to call 3D undo/redo **when the 3D scene is active** (i.e., the 3D Scene entry is selected in the layer panel, or a mesh is selected):

```ts
// In the keyboard handler:
if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
  if (event.shiftKey) {
    if (sm.canRedo3D) sm.redo3D();
  } else {
    if (sm.canUndo3D) sm.undo3D();
  }
  event.preventDefault();
}
```

**Important:** The 3D undo stack is **separate** from the 2D raster undo stack. When the 3D panel is active, Ctrl+Z should undo 3D actions. When a raster layer is active, Ctrl+Z should undo raster paint actions. Route based on which panel is currently focused.

### Edit Menu Integration

If Frogmarks has an Edit menu:

| Menu item | Condition | Action |
|-----------|-----------|--------|
| Undo (3D: Transform mesh) | `sm.canUndo3D && 3d panel active` | `sm.undo3D()` |
| Redo (3D: Transform mesh) | `sm.canRedo3D && 3d panel active` | `sm.redo3D()` |

Use `sm.undoDescription3D` and `sm.redoDescription3D` to dynamically populate the menu labels.

### Toolbar Integration

In the 3D Scene panel header or toolbar row, add Undo/Redo buttons:

```
[←Undo]  [Redo→]
```

```ts
// Undo button:
disabled = !sm.canUndo3D
tooltip = sm.undoDescription3D ?? 'Nothing to undo'
onClick = () => sm.undo3D()

// Redo button:
disabled = !sm.canRedo3D
tooltip = sm.redoDescription3D ?? 'Nothing to redo'
onClick = () => sm.redo3D()
```

Update button states after every 3D operation (subscribe to scene graph change events or after each gizmo interaction).

---

## 3. Frustum Culling Toggle

### What Was Added

CPU-side 6-plane frustum culling for 3D meshes. Meshes whose world-space AABB is entirely outside the camera frustum are skipped before being sent to the GPU. Enabled by default.

**Salsa API:**
```ts
sm.frustumCulling3D          // boolean getter
sm.frustumCulling3D = false  // setter — disables culling
```

Or via `sm.scene3d`:
```ts
sm.scene3d.frustumCulling         // getter
sm.scene3d.frustumCulling = false // setter
```

### Where to Show It

This is a **performance/debugging setting** — not a primary creative control. Place it in one of these locations (pick whichever fits Frogmarks' design language):

**Option A:** Inside a collapsible **Performance** or **Advanced** section in the 3D Scene panel.

**Option B:** In a global Settings panel (if one exists).

**Option C:** Hidden unless a developer/debug mode is active.

### Layout (Option A)

```
▸ ADVANCED ─────────────────────────────────
  Frustum Culling   [ON ●]
```

### Behavior

- Default: **on**. Don't expose this control prominently — it's a debugging escape hatch.
- When culling is off, all meshes in the scene graph are sent to the GPU every frame regardless of visibility. Useful for debugging "where did my mesh go?" issues.
- No performance concern for small scenes; for scenes with hundreds of off-screen meshes, keeping culling on is important.

```ts
frustumCullingToggle.checked = sm.frustumCulling3D; // true by default
frustumCullingToggle.onChange = (v) => { sm.frustumCulling3D = v; };
```

---

## 4. 3D Animation Sync with Raster Timeline

### What Was Added

The raster timeline's play/pause/stop now automatically drives the 3D `AnimationPlayer3D` via a callback wired in `ShapeManager.initDelegates()`. No explicit code is needed in Frogmarks to achieve sync — clicking play on the raster timeline will also start the 3D player if one has been created.

**The sync is automatic when:**
1. A 3D AnimationPlayer exists (`sm.createAnimationPlayer3D(...)` was called)
2. The raster timeline plays/pauses/stops via `sm.animation.play()` / `sm.animation.pause()` / `sm.animation.stopPlayback()`

**Salsa API for creating the 3D player:**
```ts
const player = sm.createAnimationPlayer3D({
  startFrame: 0,
  endFrame: 120,
  fps: 24,
  loop: true,
});
// player.play() is called automatically when sm.animation.play() is called
```

**Manual sync control (if needed):**
```ts
sm.scene3d.startSyncedPlayback()   // start 3D player
sm.scene3d.pauseSyncedPlayback()   // pause 3D player
sm.scene3d.stopSyncedPlayback()    // stop + reset 3D player to startFrame
```

### UI Changes Needed

#### 3D Scene Panel — Animation Section

Add an **Animation** subsection to the 3D Scene panel, visible when a 3D mesh has keyframe tracks.

```
▸ 3D ANIMATION ─────────────────────────────
  Sync with Timeline   [ON ●]
  Start Frame  [0  ]   End Frame  [120]
  FPS          [24 ]   Loop       [ON ●]

  [▶ Play]  [⏸ Pause]  [⏹ Stop]
  Frame: [----●-----------] 60 / 120
```

#### Sync Toggle Behavior

- **Sync ON (default when player exists):** 3D player is driven by raster timeline. The 3D Play/Pause/Stop buttons in this section are disabled — use the raster timeline transport instead.
- **Sync OFF:** 3D player runs independently. The 3D Play/Pause/Stop buttons become active.

```ts
// Sync on:
// nothing to call — already wired automatically in initDelegates

// Sync off (user wants independent 3D playback):
// Override by calling sm.scene3d.startSyncedPlayback() / pauseSyncedPlayback() manually
// Note: if sync is off, don't call sm.animation.play() — call sm.getAnimationPlayer3D()?.play() directly
const player = sm.getAnimationPlayer3D();
if (player) player.play();
```

#### Keyframe Recording Shortcut

Provide a **Record Keyframe** button (or "K" keyboard shortcut when 3D panel is active) for quickly setting a keyframe on the selected mesh at the current frame:

```ts
// "K" pressed while mesh is selected:
const meshId = [...sm.getSelected3DIDs()][0];
const frame = sm.animation.getCurrentFrame();

// Record current transform state:
const mesh = sm.getMesh3D(meshId);
if (mesh) {
  sm.setMeshKeyframe3D(meshId, 'position', frame, [mesh.x, mesh.y, mesh.z]);
  sm.setMeshKeyframe3D(meshId, 'rotation', frame, [mesh.rotationX, mesh.rotationY, mesh.rotation]);
  sm.setMeshKeyframe3D(meshId, 'scale',    frame, [mesh.scaleX, mesh.scaleY, mesh.scaleZ]);
}
```

---

## 5. Complete Updated 3D Scene Panel Layout

Below is a revised panel layout incorporating all Phase 4 controls alongside the existing Phase 3 controls:

```
┌─────────────────────────────────────────┐
│ 3D Scene                           [✕]  │
├─────────────────────────────────────────┤
│ [←] [→]   ← 3D Undo / Redo buttons     │
├─────────────────────────────────────────┤
│ VIEWPORT                                │
│  Mode:  [Move▾]                        │
│  [Perspective▾]  [Frame All] [Reset]   │
│  FOV: [60°  ══════●═══]                │
│  Orbit: [ON ●]                         │
├─────────────────────────────────────────┤
│ MESHES                                  │
│  ⬡ box                    [🗑]         │
│  ● sphere  ← selected     [🗑]         │
│  [+ Box] [+ Sphere] [+ Plane]          │
│  [+ Cylinder] [+ Torus]                │
├─────────────────────────────────────────┤
│ ─── sphere ────────────────────────── │
│ TRANSFORM                              │
│  Pos  X [0.0] Y [0.5] Z [0.0]        │
│  Rot  X [0  ] Y [0  ] Z [0  ]        │
│  Scale X [1.0] Y [1.0] Z [1.0]       │
│                                        │
│ MATERIAL                               │
│  Color [■]  Opacity [100%]            │
│                                        │
│ TEXTURE                                │
│  [thumbnail]  [Upload] [Clear]        │
├─────────────────────────────────────────┤
│ ▸ PS1 RETRO STYLE                      │
├─────────────────────────────────────────┤
│ ▸ LIGHTING                             │
│   Direction  Intensity  Color          │
│   Ambient    Intensity  Color          │
│   ── Shadows ────────────────────────  │
│   Cast Shadows   [OFF ○]               │
│   (when on:)                           │
│   Map Size [1024▾]  Extent [15]  Bias [0.002] │
├─────────────────────────────────────────┤
│ ▸ 3D ANIMATION                         │
│   Sync with Timeline  [ON ●]           │
│   Start [0] End [120] FPS [24]         │
│   [▶] [⏸] [⏹]   Frame: 60/120        │
├─────────────────────────────────────────┤
│ ▸ ADVANCED                             │
│   Frustum Culling  [ON ●]              │
└─────────────────────────────────────────┘
```

---

## 6. API Quick Reference

| Feature | API | Default |
|---------|-----|---------|
| Enable shadows | `sm.enableShadows3D(mapSize, halfExtent, bias)` | disabled |
| Disable shadows | `sm.disableShadows3D()` | — |
| Shadow state | `sm.shadowsEnabled3D` | `false` |
| Undo 3D | `sm.undo3D()` | — |
| Redo 3D | `sm.redo3D()` | — |
| Can undo | `sm.canUndo3D` | — |
| Can redo | `sm.canRedo3D` | — |
| Undo label | `sm.undoDescription3D` | `null` |
| Frustum culling | `sm.frustumCulling3D = true/false` | `true` |
| Create 3D player | `sm.createAnimationPlayer3D(config)` | — |
| Start synced play | `sm.scene3d.startSyncedPlayback()` | auto-wired |
| Stop synced play | `sm.scene3d.stopSyncedPlayback()` | auto-wired |
