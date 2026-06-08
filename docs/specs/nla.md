# Non-Linear Animation (NLA) — Spec

**Status:** Completed June 2026  
**Files:** `src/types/armature-3d.ts`, `src/renderer/3d/skeleton-animator.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`

---

## Goal

Extend the single-clip `applySkeletonClipAtFrame` evaluator to support multi-clip blending on a shared timeline: multiple clips active simultaneously, each with a weight and blend mode (`replace` or `additive`), with fade-in/fade-out ramps at segment boundaries.

---

## Data Model

All types live in `src/types/armature-3d.ts`.

### `NLAClipSegment`

A single clip placed on an NLA timeline:

```ts
interface NLAClipSegment {
  clipId: string;          // references SkeletonAnimClip.id on the skeleton
  startFrame: number;      // NLA timeline frame where playback of this segment begins
  clipStartOffset: number; // how many frames into the clip to start (default 0; trims the head)
  weight: number;          // 0–1 blend contribution (default 1.0)
  blendMode: 'replace' | 'additive';
  fadeIn: number;          // frames to ramp 0 → weight at segment start (default 0)
  fadeOut: number;         // frames to ramp weight → 0 at segment end (default 0)
}
```

### `NLATrack`

A named, ordered set of `NLAClipSegment`s on a shared timeline:

```ts
interface NLATrack {
  id: string;
  name: string;
  skeletonId: string;    // ID of the Skeleton3D this track drives
  segments: NLAClipSegment[];
  fps: number;           // playback FPS for this track's clock (default 24)
  loop: boolean;         // whether the track loops back to frame 0 (default true)
}
```

`NLATrack` objects are stored at `SkeletonData.nlaTracks[]` and serialized in the project file.

---

## Evaluation Algorithm (`evaluateNLAAtFrame`)

Located in `src/renderer/3d/skeleton-animator.ts`.

**Inputs:** `track: NLATrack`, `clips: SkeletonAnimClip[]`, `skeleton: Skeleton3D`, `bindPose: SkeletonPose`, `frame: number`.

**Steps:**

1. **Segment filtering** — For each segment, compute its active window:
   ```
   segEnd = startFrame + (clipDuration − clipStartOffset)
   active if: startFrame ≤ frame < segEnd
   ```

2. **Effective weight with ramps:**
   ```
   elapsed   = frame − startFrame
   remaining = segEnd − frame
   effectiveWeight = weight
   if fadeIn  > 0 and elapsed   < fadeIn:   effectiveWeight *= elapsed / fadeIn
   if fadeOut > 0 and remaining < fadeOut:  effectiveWeight *= remaining / fadeOut
   effectiveWeight = clamp(0, 1)
   ```

3. **Separate** active segments into `replaceSegs` and `additiveSegs` lists.

4. **Replace blend** — Start from a mutable copy of `bindPose`. For each replace segment (in order):
   ```
   segPose = sampleClipPose(clip, bindPose, localFrame)
   currentPose = blendPoses(currentPose, segPose, effectiveWeight)
   ```
   `blendPoses` uses `quat.slerp` for rotation, linear lerp for translation/scale.

5. **Additive blend** — For each additive segment, compute the delta from `bindPose` and add it to `currentPose`:
   ```
   // Rotation: delta = segRot * inv(bindRot); apply slerp(identity, delta, w) * currentRot
   // Translation: += (segPos − bindPos) * w
   // Scale: *= (1 + (segScale − bindScale) * w)
   ```

6. `writePoseToSkeleton(currentPose, skeleton)` → `skeleton.computeWorldMatrices()`.

---

## Bind Pose

The evaluator needs a stable `SkeletonPose` representing the reference/rest state. This is captured via `snapshotSkeletonPose(skeleton)` when `createNLATrack3D` is first called for a skeleton and stored in `scene3d-manager`'s `_nlaBindPoses` map (keyed by `skeletonId`).

**Important:** The bind pose is the joint state at the moment `createNLATrack3D` is called — typically the T-pose or A-pose. If the skeleton's joints are modified later, call `createNLATrack3D` again to re-capture the bind pose.

---

## Manager State (`scene3d-manager.ts`)

```ts
private _nlaTracks    = new Map<string, NLATrack>();
private _nlaPlayers   = new Map<string, AnimationPlayer3D>();
private _nlaBindPoses = new Map<string, SkeletonPose>();  // keyed by skeletonId
```

### API Surface

| Method | Description |
|--------|-------------|
| `createNLATrack3D(skelId, name, fps?, loop?)` | Creates a track, snapshots bind pose, returns track ID |
| `getNLATracks3D(skelId)` | Returns all tracks for a skeleton |
| `addNLASegment3D(trackId, clipId, startFrame, opts?)` | Appends a segment; returns segment index |
| `removeNLASegment3D(trackId, segIndex)` | Removes a segment by index |
| `updateNLASegment3D(trackId, segIndex, updates)` | Patches arbitrary fields on a segment |
| `playNLATrack3D(trackId)` | Creates + returns AnimationPlayer3D (starts paused) |
| `stopNLATrack3D(trackId)` | Stops and destroys the player |
| `seekNLATrack3D(trackId, frame)` | One-shot evaluate at frame (no player needed) |
| `crossfade3D(trackId, fromIdx, toIdx, dur)` | Schedules fade-out on fromSeg, fade-in on toSeg at current player frame |

All methods are delegated from `shape-manager.ts` via the matching `*3D` public methods.

---

## Persistence

`NLATrack` objects are stored at `skeleton.data.nlaTracks[]`. `Skeleton3D.toJSON()` serializes `SkeletonData`, so tracks and their segments survive save/load automatically.

The `_nlaBindPoses` map is runtime-only (not serialized). On project load, the bind pose will be re-captured the next time `createNLATrack3D` is called. For existing tracks loaded from JSON, the bind pose must be re-established before calling `playNLATrack3D` — the manager checks `_nlaBindPoses.has(skeletonId)` and creates the snapshot on `createNLATrack3D`.

---

## Multiple Tracks on One Skeleton

Each `NLATrack` is independent. Two tracks targeting the same skeleton both call `evaluateNLAAtFrame`, both writing to `skeleton.data.joints`. The second write wins. To layer two tracks properly, combine their segments into a single track (using additive mode for the secondary layer) rather than running two independent tracks.

---

## Known Limitations

- **No IK target blending in NLA** — `IKKeyframeTrack` data is not evaluated during NLA playback. IK targets remain at their last-set positions; only FK joint channels are blended.
- **No per-segment looping** — if a clip is shorter than the NLA timeline, the segment ends when the clip ends. To loop a clip, set `loop: true` on the `NLATrack` and size `endFrame` to a multiple of the clip duration.
- **No additive IK blend** — additive mode applies joint-space FK deltas only.
- **Bind pose re-capture on load** — `_nlaBindPoses` is not serialized. This is acceptable for the current use case but may require a one-time re-snapshot step after project load in future tooling.
