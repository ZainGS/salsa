# 16 — 3D Animation System
**Last Updated:** 2026-06-10

The 3D animation system handles per-mesh keyframe tracks, camera keyframes, blend shape weight keyframes, interpolation with bezier easing, a `requestAnimationFrame`-driven playback clock, and an undo/redo command stack.

**Files:**
- `src/types/keyframe-3d.ts` — keyframe types, interpolation, track sampler, bezier easing
- `src/renderer/3d/animation-player-3d.ts` — rAF playback clock
- `src/services/managers/undo-manager-3d.ts` — command stack
- `src/services/managers/scene3d-manager.ts` — wires everything together
- `src/services/managers/animation-manager.ts` — raster↔3D sync hook

---

## Keyframe Tracks

**File:** `src/types/keyframe-3d.ts`

Each `Mesh3D` carries a `keyframeTracks: Mesh3DKeyframeTracks` property. Tracks are per-property arrays of time-value-easing entries.

### Types

```typescript
type KeyframeEasing = 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

interface Keyframe<T> {
  frame:  number;
  value:  T;
  easing: KeyframeEasing;  // applied to the segment AFTER this keyframe
}

interface Mesh3DKeyframeTracks {
  position?:     Keyframe<[number, number, number]>[];  // [x, y, z]
  rotation?:     Keyframe<[number, number, number]>[];  // [rx, ry, rz] — radians
  scale?:        Keyframe<[number, number, number]>[];  // [sx, sy, sz]
  diffuseColor?: Keyframe<[number, number, number, number]>[];  // [r, g, b, a]
  opacity?:      Keyframe<number>[];
  visible?:      Keyframe<boolean>[];
  blendWeights?: Record<string, Keyframe<number>[]>;  // per blend shape name
}

/** Camera keyframe tracks — separate from Mesh3DKeyframeTracks. */
interface Camera3DKeyframeTracks {
  position?: Keyframe<[number, number, number]>[];
  target?:   Keyframe<[number, number, number]>[];
  fov?:      Keyframe<number>[];  // degrees, perspective mode only
}
```

### Easing

All five easing modes are available for every keyframe on every track type:

| Mode | Curve | Use for |
|------|-------|---------|
| `'step'` | Instant jump at k1.frame | Cel replacement, discrete state |
| `'linear'` | Constant velocity | Mechanical motion, data playback |
| `'ease-in'` | Slow start → fast end | Acceleration from rest |
| `'ease-out'` | Fast start → slow end | Deceleration to stop |
| `'ease-in-out'` | Slow–fast–slow | Most natural-looking motion |

`ease-in/ease-out/ease-in-out` use CSS cubic-bezier curves with Newton's method (8 iterations) for the x→t inversion. See [theory/keyframe-animation.md](../theory/keyframe-animation.md) for the derivation.

### Interpolation Helpers

```typescript
interpolateScalar(a, b, t, easing)    // number → number
interpolateVec3(a, b, t, easing)      // [n,n,n] → [n,n,n]
interpolateVec4(a, b, t, easing)      // [n,n,n,n] → [n,n,n,n]
```

### Track Sampler

```typescript
sampleTrack<T>(track, frame, interpolateFn): T | null
```

1. Sort keyframes by frame
2. If `frame ≤ first.frame` → return `first.value` (clamp at start)
3. If `frame ≥ last.frame` → return `last.value` (clamp at end)
4. Find surrounding pair `[k0, k1]` where `k0.frame ≤ frame < k1.frame`
5. Compute `t = (frame - k0.frame) / (k1.frame - k0.frame)`
6. Return `interpolateFn(k0.value, k1.value, t, k0.easing)`

Returns `null` for empty tracks — callers skip writing unchanged properties.

### Track CRUD

```typescript
setKeyframe(track, frame, value, easing?)   // upsert: replaces if frame exists
removeKeyframe(track, frame)                // returns false if not found
```

### Applying Keyframes

`Scene3DManager.applyMeshKeyframesAtFrame(meshId, frame)` samples all track types and writes to the mesh:

```typescript
const pos = sampleTrack(tracks.position ?? [], frame, interpolateVec3);
if (pos) { mesh.x = pos[0]; mesh.y = pos[1]; mesh.z = pos[2]; }

const rot = sampleTrack(tracks.rotation ?? [], frame, interpolateVec3);
if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }

const scale = sampleTrack(tracks.scale ?? [], frame, interpolateVec3);
if (scale) { mesh.scaleX = scale[0]; mesh.scaleY = scale[1]; mesh.scaleZ = scale[2]; }

const color = sampleTrack(tracks.diffuseColor ?? [], frame, interpolateVec4);
if (color) mesh.setDiffuseColor(...color);

const opacity = sampleTrack(tracks.opacity ?? [], frame, interpolateScalar);
if (opacity !== null) mesh.setOpacity(opacity);

const vis = sampleTrack(tracks.visible ?? [], frame, (a) => a);
if (vis !== null) mesh.visible = vis;

// Blend shape weight tracks
if (tracks.blendWeights) {
    for (const [shapeName, track] of Object.entries(tracks.blendWeights)) {
        const w = sampleTrack(track, frame, interpolateScalar);
        if (w !== null) {
            const idx = mesh.blendShapes.findIndex(s => s.name === shapeName);
            if (idx >= 0) mesh.blendWeights[idx] = w;
        }
    }
    mesh.evaluateBlendShapes();
}
```

`applyAllKeyframesAtFrame(frame)` calls this for every mesh in the scene, then calls `applyCameraKeyframesAtFrame(frame)`.

---

## Camera Keyframes

**Managed by:** `Scene3DManager._cameraKeyframeTracks: Camera3DKeyframeTracks`

Camera keyframes animate the active scene camera's position, look-at target, and field of view.

```typescript
// Set a keyframe on the scene camera
sm.setCameraKeyframe3D('position', frame, [x, y, z], easing?);
sm.setCameraKeyframe3D('target',   frame, [x, y, z], easing?);
sm.setCameraKeyframe3D('fov',      frame, degrees,   easing?);

// Snapshot the current camera state as a keyframe
sm.recordCameraKeyframe3D(frame?);   // omit frame → uses current raster timeline frame

// Read / clear
sm.getCameraKeyframeTracks3D();      // → Camera3DKeyframeTracks
sm.removeCameraKeyframe3D(prop, frame);
sm.clearCameraKeyframeTracks3D();
```

Camera tracks are sampled in `applyCameraKeyframesAtFrame`, which is called at the end of `applyAllKeyframesAtFrame`. Fov is written to `camera.fov` in radians (converted from degrees).

---

## Blend Shape Weight Keyframes

Blend shape weights are keyframeable via `mesh.keyframeTracks.blendWeights` — a `Record<shapeName, Keyframe<number>[]>`. Tracks are keyed by the shape's **name string** (not its index), so they survive re-ordering.

```typescript
// Author a smile that opens over 24 frames
sm.setBlendShapeKeyframe3D(meshId, 'smile', 0,  0.0);
sm.setBlendShapeKeyframe3D(meshId, 'smile', 24, 1.0, 'ease-in-out');

// Remove one keyframe
sm.removeBlendShapeKeyframe3D(meshId, 'smile', 24);

// Read all tracks for a mesh
sm.getBlendShapeKeyframeTracks3D(meshId);
// → Record<shapeName, { frame, value, easing }[]> | null
```

All operations are undoable. The sampler runs inside `applyMeshKeyframesAtFrame` after the standard 6 tracks, so blend shape weights animate in sync with position/rotation/color on the same timeline.

---

## Timeline Integration

### Raster Timeline Sync

```typescript
sm.attachKeyframesToTimeline3D();
// Subscribes to the raster timeline's 'frame-changed' event.
// Every time the user scrubs or playback advances, applyAllKeyframesAtFrame fires.

sm.detachKeyframesFromTimeline3D();
```

This is the standard Frogmarks integration — 3D mesh and camera animation is tied to the same frame counter as 2D cel animation.

### AnimationPlayer3D

For playback independent of the raster timeline (e.g., a looping background prop):

```typescript
const player = sm.createAnimationPlayer3D({
  startFrame: 0,
  endFrame:   48,
  fps:        24,
  loop:       true,
});
player.play();
```

The player's `onFrame` callback automatically calls `applyAllKeyframesAtFrame` on each tick.

---

## AnimationPlayer3D Reference

**File:** `src/renderer/3d/animation-player-3d.ts`

A `requestAnimationFrame`-driven clock with frame-accurate time accumulation.

### Config

```typescript
interface AnimationPlayer3DConfig {
  startFrame?: number;   // default 0
  endFrame?:   number;   // default 120
  fps?:        number;   // default 24
  loop?:       boolean;  // default true
}
```

### API

```typescript
player.play()
player.pause()
player.stop()          // pause + seek to startFrame + fire onFrame
player.seek(frame)
player.toggle()

player.onFrame(cb)     // fired on every frame advance
player.onStop(cb)      // fired when non-looping playback ends

player.currentFrame    // read-only
player.playing         // read-only
player.fps = 30
player.startFrame = 0
player.endFrame = 240
player.loop = false
player.destroy()
```

### Time Accumulation

```
each rAF tick:
  dt = timestamp - lastTimestamp
  accumulator += dt
  while accumulator >= 1000/fps:
    accumulator -= 1000/fps
    frame++
    if (frame > endFrame && loop) frame = startFrame
    onFrame(frame)
```

This ensures 24 fps animation plays at exactly 24 fps on a 60 Hz display without drift.

---

## Raster ↔ 3D Playback Sync

`ShapeManager.initDelegates()` wires this automatically:

```typescript
this.animation.set3DPlaybackSync((playing) => {
  if (playing) this.scene3d.startSyncedPlayback();
  else         this.scene3d.stopSyncedPlayback();
});
```

The sync fires on `animation.play()`, `animation.pause()`, and `animation.stopPlayback()`. Requires a 3D `AnimationPlayer3D` to have been created first via `sm.createAnimationPlayer3D(...)`.

---

## UndoManager3D

**File:** `src/services/managers/undo-manager-3d.ts`

A closure-based command stack. All keyframe mutations (set, remove, clear) push reversible commands automatically.

```typescript
interface Command3D {
  description: string;
  undo(): void;
  redo(): void;
}

undoManager.push(cmd)
undoManager.undo()
undoManager.redo()
undoManager.clear()

undoManager.canUndo             // boolean
undoManager.canRedo             // boolean
undoManager.undoDescription     // string | null
undoManager.redoDescription     // string | null
undoManager.stackSize
```

Default max depth: **50 commands**.

---

## ShapeManager API Summary

### Mesh keyframes

```typescript
sm.setMeshKeyframe3D(meshId, property, frame, value, easing?)
sm.removeMeshKeyframe3D(meshId, property, frame)
sm.getMeshKeyframeTracks3D(meshId)
sm.clearMeshKeyframeTracks3D(meshId)
sm.recordKeyframeForMesh3D(meshId, frame?)     // snapshots position/rotation/scale
sm.recordKeyframesForSelectedMeshes3D(frame?)
sm.autoKey3D                                    // getter/setter for auto-keying
```

### Blend shape weight keyframes

```typescript
sm.setBlendShapeKeyframe3D(meshId, shapeName, frame, weight, easing?)
sm.removeBlendShapeKeyframe3D(meshId, shapeName, frame)
sm.getBlendShapeKeyframeTracks3D(meshId)
```

### Camera keyframes

```typescript
sm.setCameraKeyframe3D(property, frame, value, easing?)
sm.removeCameraKeyframe3D(property, frame)
sm.getCameraKeyframeTracks3D()
sm.clearCameraKeyframeTracks3D()
sm.recordCameraKeyframe3D(frame?)
```

### Timeline sync

```typescript
sm.attachKeyframesToTimeline3D()
sm.detachKeyframesFromTimeline3D()
sm.applyAllKeyframesAtFrame3D(frame)
```

### Playback

```typescript
sm.createAnimationPlayer3D(config?)
sm.getAnimationPlayer3D()
sm.destroyAnimationPlayer3D()
```

### Undo / redo

```typescript
sm.undo3D()
sm.redo3D()
sm.canUndo3D
sm.canRedo3D
sm.undoDescription3D
sm.redoDescription3D
sm.clearUndo3D()
```

---

## Skeleton Animation

**Files:**
- `src/types/armature-3d.ts` — `SkeletonAnimClip`, `SkeletonKeyframeTrack`, `JointKeyframe`
- `src/renderer/3d/skeleton-animator.ts` — `applySkeletonClipAtFrame()`
- `src/services/managers/scene3d-manager.ts` — `playSkeletonClip()`

Skeleton clips use a parallel keyframe system to mesh tracks. Rotation uses quaternion slerp (`quat.slerp`) rather than Euler lerp to avoid gimbal lock. See [theory/skeletal-animation.md](../theory/skeletal-animation.md) and [theory/quaternion-interpolation.md](../theory/quaternion-interpolation.md).

```typescript
interface SkeletonKeyframeTrack {
  jointIndex: number;
  channel:    'translation' | 'rotation' | 'scale';
  keyframes:  { frame: number; value: number[] }[];
}

interface SkeletonAnimClip {
  name:       string;
  startFrame: number;
  endFrame:   number;
  fps:        number;
  tracks:     SkeletonKeyframeTrack[];
}
```

```typescript
// Play a clip via AnimationPlayer3D
const player = sm.playSkeletonClip3D(skeletonId, clip);
player.play();

// Apply at a specific frame (no player, manual control)
applySkeletonClipAtFrame(clip, skeleton, frame);
```

---

## Theory

- [keyframe-animation.md](../theory/keyframe-animation.md) — tracks, interpolation, easing curves, the "easing-after" convention
- [blend-shapes.md](../theory/blend-shapes.md) — what blend shape weights represent
- [skeletal-animation.md](../theory/skeletal-animation.md) — LBS skinning driven by skeleton poses
- [quaternion-interpolation.md](../theory/quaternion-interpolation.md) — why skeleton clips use slerp
- [nla.md](../theory/nla.md) — multi-clip blending on a shared timeline
