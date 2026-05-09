# 16 — 3D Animation System

The 3D animation system handles per-mesh keyframe tracks, interpolation, a `requestAnimationFrame`-driven playback clock, and an undo/redo command stack.

**Files:**
- `src/types/keyframe-3d.ts` — keyframe types, interpolation, track sampler
- `src/renderer/3d/animation-player-3d.ts` — rAF playback clock
- `src/services/managers/undo-manager-3d.ts` — command stack
- `src/services/managers/scene3d-manager.ts` — wires everything together
- `src/services/managers/animation-manager.ts` — raster↔3D sync hook

---

## Keyframe Tracks

**File:** `src/types/keyframe-3d.ts`

Each `Mesh3D` node carries a `keyframeTracks: Mesh3DKeyframeTracks` property. Tracks are per-property arrays of timed keyframe entries.

### Types

```typescript
type KeyframeEasing = 'step' | 'linear';

interface Keyframe<T> {
  frame: number;    // timeline frame index (integer)
  value: T;
  easing: KeyframeEasing;  // interpolation to use between THIS keyframe and the NEXT
}

interface Mesh3DKeyframeTracks {
  position?:     Keyframe<[number, number, number]>[];  // [x, y, z]
  rotation?:     Keyframe<[number, number, number]>[];  // [rx, ry, rz] — radians
  scale?:        Keyframe<[number, number, number]>[];  // [sx, sy, sz]
  diffuseColor?: Keyframe<[number, number, number, number]>[];  // [r, g, b, a]
  opacity?:      Keyframe<number>[];
  visible?:      Keyframe<boolean>[];
}
```

### Interpolation Helpers

```typescript
interpolateScalar(a, b, t, easing)    // number
interpolateVec3(a, b, t, easing)      // [number,number,number]
interpolateVec4(a, b, t, easing)      // [number,number,number,number]
```

`'step'` returns `a` unchanged (no interpolation — jumps at frame boundary).
`'linear'` linearly interpolates from `a` to `b` using parameter `t ∈ [0,1]`.

### Track Sampler

```typescript
sampleTrack<T>(track, frame, interpolateFn): T | null
```

1. Sort keyframes by frame
2. If `frame ≤ first.frame` → return `first.value`
3. If `frame ≥ last.frame` → return `last.value`
4. Find surrounding pair `[k0, k1]` where `k0.frame ≤ frame < k1.frame`
5. Compute `t = (frame - k0.frame) / (k1.frame - k0.frame)`
6. Return `interpolateFn(k0.value, k1.value, t, k0.easing)`

Returns `null` for empty tracks so callers can skip writing unchanged properties.

### Track CRUD

```typescript
setKeyframe(track, frame, value, easing?)   // upsert: replaces if frame exists
removeKeyframe(track, frame)                // returns false if not found
```

### Applying Keyframes

`Scene3DManager.applyMeshKeyframesAtFrame(meshId, frame)` samples all 6 track types and writes to the mesh properties:

```typescript
const pos = sampleTrack(tracks.position, frame, interpolateVec3);
if (pos) { mesh.x = pos[0]; mesh.y = pos[1]; mesh.z = pos[2]; }

const rot = sampleTrack(tracks.rotation, frame, interpolateVec3);
if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }
// ... scale, diffuseColor, opacity, visible
```

`applyAllKeyframesAtFrame(frame)` calls this for every mesh in the scene.

---

## Timeline Integration

Keyframes can be driven by the **raster timeline** (shared with 2D animation) or by the independent `AnimationPlayer3D`.

### Raster Timeline Sync

```typescript
scene3d.attachKeyframesToTimeline()
// Subscribes to timeline 'frame-changed' events.
// Calls applyAllKeyframesAtFrame(e.frame) on every frame change.
// Also called when the user scrubs the timeline manually.

scene3d.detachKeyframesFromTimeline()
// Unsubscribes.
```

This is the preferred integration for Frogmarks — it ties 3D mesh animation to the same frame counter as cel animation.

---

## AnimationPlayer3D

**File:** `src/renderer/3d/animation-player-3d.ts`

A `requestAnimationFrame`-driven clock with time accumulation to hit the target FPS precisely regardless of display refresh rate (60 Hz monitor plays a 24 fps animation correctly).

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
player.play()                // start rAF loop
player.pause()               // cancel rAF
player.stop()                // pause + seek to startFrame + fire onFrame
player.seek(frame)           // jump to frame (doesn't change play state)
player.toggle()              // play if paused, pause if playing

player.onFrame(cb)           // callback fired on every frame advance
player.onStop(cb)            // callback fired when non-looping playback ends

player.currentFrame          // read-only
player.playing               // read-only
player.fps = 30              // writable
player.startFrame = 0
player.endFrame = 240
player.loop = false
player.destroy()             // cancel rAF, clear callbacks
```

### Time Accumulation

```
each rAF tick:
  dt = timestamp - lastTimestamp
  accumulator += dt
  frameDuration = 1000 / fps

  while accumulator >= frameDuration:
    accumulator -= frameDuration
    frame++
    if (frame > endFrame && loop) frame = startFrame
    onFrame(frame)
```

This ensures a 24 fps animation plays at exactly 24 fps on a 60 Hz display (frames accumulate until enough time has passed) without drift.

### Usage in Scene3DManager

```typescript
const player = scene3d.createAnimationPlayer({
  startFrame: 1, endFrame: 48, fps: 12, loop: true,
});
// Player automatically calls applyAllKeyframesAtFrame(frame) via the onFrame callback
// registered in createAnimationPlayer().
player.play();
```

---

## Raster ↔ 3D Playback Sync

The raster `AnimationManager` has a `set3DPlaybackSync(cb)` hook. `ShapeManager.initDelegates()` wires it automatically:

```typescript
this.animation.set3DPlaybackSync((playing) => {
  if (playing) this.scene3d.startSyncedPlayback();
  else         this.scene3d.stopSyncedPlayback();
});
```

`startSyncedPlayback()` calls `_animPlayer?.play()`.
`stopSyncedPlayback()` calls `_animPlayer?.stop()`.

The sync fires on:
- `animation.play()` → `startSyncedPlayback()` (3D player starts)
- `animation.pause()` → `stopSyncedPlayback()` (3D player pauses to match)
- `animation.stopPlayback()` → `stopSyncedPlayback()` (3D player resets)

**Prerequisite:** A 3D `AnimationPlayer3D` must have been created via `sm.createAnimationPlayer3D(...)`. If no player exists, the sync callbacks are no-ops.

---

## UndoManager3D

**File:** `src/services/managers/undo-manager-3d.ts`

A closure-based command stack for 3D scene edits. Commands capture the state they need via closures — no context injection required.

### Command Interface

```typescript
interface Command3D {
  description: string;
  undo(): void;
  redo(): void;
}
```

### API

```typescript
undoManager.push(cmd)           // truncate redo history, append, evict oldest if over limit
undoManager.undo()              // calls cmd.undo(), decrements pointer, returns bool
undoManager.redo()              // increments pointer, calls cmd.redo(), returns bool
undoManager.clear()             // empty the stack

undoManager.canUndo             // boolean
undoManager.canRedo             // boolean
undoManager.undoDescription     // string | null — next undoable action's description
undoManager.redoDescription     // string | null — next redoable action's description
undoManager.stackSize           // current depth
```

Default max depth: **50 commands**. Oldest commands are evicted when the limit is reached.

### Transform Undo (Automatic)

`Scene3DManager.enableTransformControls()` passes an `onTransformComplete` callback to `TransformController3D`. When a gizmo drag ends, the callback fires with before/after transform snapshots and pushes a command:

```typescript
onTransformComplete: (before, after) => {
  undoManager.push({
    description: 'Transform mesh',
    undo: () => { /* restore before positions for all dragged meshes */ },
    redo: () => { /* reapply after positions */ },
  });
}
```

### Custom Commands

For other undoable operations (create mesh, delete mesh, material change), push commands manually:

```typescript
// Before creating a mesh:
const mesh = scene3d.createBox(0, 0, 0);
undoManager.push({
  description: 'Create box',
  undo: () => { mesh.parent?.removeChild(mesh); scheduleRender(); },
  redo: () => { root.addChild(mesh); scheduleRender(); },
});
```

### ShapeManager API

```typescript
sm.undo3D()                 // boolean
sm.redo3D()                 // boolean
sm.canUndo3D                // boolean
sm.canRedo3D                // boolean
sm.undoDescription3D        // string | null
sm.redoDescription3D        // string | null
sm.clearUndo3D()
```

---

## Scene3DManager — Animation Methods Summary

All keyframe and animation methods are accessible via `shapeManager.scene3d`:

| Method | Description |
|--------|-------------|
| `setMeshKeyframe(id, prop, frame, value, easing?)` | Upsert a keyframe on a mesh property track |
| `removeMeshKeyframe(id, prop, frame)` | Remove a keyframe |
| `getMeshKeyframeTracks(id)` | Get all tracks for a mesh |
| `clearMeshKeyframeTracks(id)` | Delete all tracks for a mesh |
| `applyMeshKeyframesAtFrame(id, frame)` | Apply interpolated values from all tracks |
| `applyAllKeyframesAtFrame(frame)` | Apply to all meshes in the scene |
| `attachKeyframesToTimeline()` | Auto-apply on raster timeline frame changes |
| `detachKeyframesFromTimeline()` | Unsubscribe |
| `createAnimationPlayer(config?)` | Create/replace the 3D playback clock |
| `getAnimationPlayer()` | Get the current player (if any) |
| `destroyAnimationPlayer()` | Stop and destroy the player |
| `startSyncedPlayback()` | Play 3D animation (called by raster timeline sync) |
| `pauseSyncedPlayback()` | Pause 3D animation |
| `stopSyncedPlayback()` | Stop and reset 3D animation |

ShapeManager also exposes these via top-level delegation:

```typescript
sm.setMeshKeyframe3D(id, prop, frame, value, easing?)
sm.removeMeshKeyframe3D(id, prop, frame)
sm.getMeshKeyframeTracks3D(id)
sm.clearMeshKeyframeTracks3D(id)
sm.applyAllKeyframesAtFrame3D(frame)
sm.attachKeyframesToTimeline3D()
sm.detachKeyframesFromTimeline3D()
sm.createAnimationPlayer3D(config?)
sm.getAnimationPlayer3D()
```
