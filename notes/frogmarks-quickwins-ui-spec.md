# Frogmarks UI Spec — Quick Wins (May 2026)

Three new Salsa features that each need a small UI surface in Frogmarks.
All APIs are on `shapeManager` (the global singleton).

---

## 1. Mesh Duplication

### What it does

`sm.duplicateMesh3D(meshId)` creates a copy of a mesh with the same geometry,
material, transform, textures, and keyframe tracks. The copy is placed 0.5
world-units to the right of the original and is immediately selected. The
operation is undo-able via `sm.undo3D()`.

### UI touchpoints

**Outliner row context menu / toolbar button**

Add a Duplicate button (or context-menu item "Duplicate") on each mesh row in
the Outliner. Place it alongside the existing delete button:

```
👁  ⬡ sphere ← selected   [⧉ Duplicate]  [🗑 Delete]
```

**Keyboard shortcut (recommended: Ctrl+D)**

When a mesh is selected and the 3D panel is focused, `Ctrl+D` should call:

```ts
const selected = sm.getSelectedNode3D();        // or however selection is read
if (selected) {
  const copy = sm.duplicateMesh3D(selected.id);
  // copy is already selected; just refresh the outliner
}
```

**After duplication**

- Re-fetch the scene hierarchy and re-render the Outliner.
- Update Undo/Redo button disabled state (the new operation is now undoable).

```ts
const copy = sm.duplicateMesh3D(meshId);
if (copy) {
  refreshOutliner();
  undoBtn.disabled = !sm.canUndo3D;
  redoBtn.disabled = !sm.canRedo3D;
}
```

---

## 2. Keyframe Easing Curves

### What changed

`KeyframeEasing` now supports five values instead of two:

| Value | Curve |
|---|---|
| `'linear'` | Constant velocity (previous default) |
| `'step'` | Jump at start of interval (previous default for step) |
| `'ease-in'` | Starts slow, accelerates (CSS cubic-bezier 0.42, 0, 1, 1) |
| `'ease-out'` | Starts fast, decelerates (CSS cubic-bezier 0, 0, 0.58, 1) |
| `'ease-in-out'` | Slow start and end, fast middle (CSS cubic-bezier 0.42, 0, 0.58, 1) |

The easing applies between two adjacent keyframes, using the **left keyframe's**
easing value (same convention as most animation tools).

### UI touchpoints

**Per-keyframe easing picker**

Wherever keyframes are shown in the timeline (diamond markers), right-clicking a
keyframe diamond should show an easing picker. Five options, visualised as small
curve icons or labelled buttons:

```
┌─────────────────────────────┐
│ Easing                      │
│  ◆ Step                     │
│  ╱  Linear                  │
│  ⌒  Ease In                 │
│  ⌣  Ease Out                │
│  ∫  Ease In-Out   ← default │
└─────────────────────────────┘
```

**API call on easing change:**

```ts
// Update the keyframe at `frame` on `meshId` with a new easing type.
// The value stays the same — only easing changes.
// Easiest: remove and re-add with the same value.
const tracks = sm.getMeshKeyframeTracks3D(meshId);
const track  = tracks?.position;  // whichever property was right-clicked
if (track) {
  const kf = track.find(k => k.frame === selectedFrame);
  if (kf) {
    sm.setMeshKeyframe3D(meshId, 'position', selectedFrame, kf.value, 'ease-in-out');
  }
}
```

**Camera keyframe easing** follows the same pattern using
`sm.setCameraKeyframe3D(property, frame, value, easing)`.

**When creating new keyframes** (K shortcut / Record button), default the easing
to `'ease-in-out'` for a polished result out of the box.

---

## 3. Camera Keyframes

### What it does

The camera now has its own keyframe tracks:

| Track | Value type | Notes |
|---|---|---|
| `'position'` | `[x, y, z]` | World-space camera eye position |
| `'target'` | `[x, y, z]` | World-space look-at point |
| `'fov'` | `number` (degrees) | Perspective FOV; ignored in ortho mode |

Camera keyframes are applied automatically on every animation frame alongside
mesh keyframes — no extra wiring needed in Frogmarks.

### UI touchpoints

**Camera row in the animation panel**

Add a dedicated "Camera" row above the mesh rows in the 3D animation panel.
It shows three sub-rows (Position, Target, FOV) with diamond markers at keyed
frames, exactly like mesh rows.

```
┌─────────────────────────────────────────────┐
│ 3D ANIMATION                                │
│                                             │
│  📷 Camera                      ← new row   │
│     Position  ◆────────◆─────◆             │
│     Target    ◆────────────────             │
│     FOV       ◆                             │
│                                             │
│  ⬡ sphere                                   │
│     Position  ◆─────◆──────◆               │
│     Rotation  ◆──────────◆                 │
│  ...                                        │
└─────────────────────────────────────────────┘
```

**"Record Camera Keyframe" button**

Add a camera icon button (📷) in the animation panel toolbar. Clicking it calls:

```ts
sm.recordCameraKeyframe3D();   // snapshots position + target + FOV at current frame
```

This is the one-click "bake current camera state" flow — the user orbits the
camera to the desired angle, then clicks the button to record it.

**Manual keyframe entry**

For precise control, the camera inspector (or a small popover) can show numeric
fields for position/target/FOV with a "Set Keyframe" button per field:

```ts
// Set just the position at frame 30:
sm.setCameraKeyframe3D('position', 30, [0, 2, 8], 'ease-in-out');

// Set just the FOV at frame 0 and frame 60 for a zoom effect:
sm.setCameraKeyframe3D('fov', 0,  60);
sm.setCameraKeyframe3D('fov', 60, 30, 'ease-in-out');
```

**Remove a camera keyframe** (right-click → Delete):

```ts
sm.removeCameraKeyframe3D('position', frame);
```

**Read current tracks** (to populate the timeline on panel open):

```ts
const tracks = sm.getCameraKeyframeTracks3D();
// tracks.position → Keyframe<[number,number,number]>[] | undefined
// tracks.target   → Keyframe<[number,number,number]>[] | undefined
// tracks.fov      → Keyframe<number>[] | undefined
```

**Clear all camera keyframes:**

```ts
sm.clearCameraKeyframeTracks3D();
```

### Notes

- Camera keyframes are applied during `applyAllKeyframesAtFrame` — the same call
  the animation player already makes every frame. No extra Frogmarks wiring.
- If illustration mode is active (`syncIllustrationCamera3D` is wired), camera
  keyframes will fight the illustration sync. Disable orbit + illustration sync
  before playing back a camera animation: `sm.scene3d.disableOrbitControls()`.
- FOV keyframes only affect perspective mode. In orthographic mode the FOV track
  is ignored but still stored (non-destructive).

---

## API Reference Summary

```ts
// Duplication
sm.duplicateMesh3D(meshId: string): Mesh3D | null

// Easing (existing API, new easing options)
sm.setMeshKeyframe3D(meshId, property, frame, value, easing?)
// easing: 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

// Camera keyframes
sm.setCameraKeyframe3D(property, frame, value, easing?)
// property: 'position' | 'target' | 'fov'
// value:    [x,y,z] for position/target, number (degrees) for fov

sm.removeCameraKeyframe3D(property, frame): boolean
sm.getCameraKeyframeTracks3D(): Camera3DKeyframeTracks
sm.clearCameraKeyframeTracks3D(): void
sm.recordCameraKeyframe3D(frame?): void   // snapshot current camera state
```
