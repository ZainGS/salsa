# Scene Animation — Architecture & Roadmap
**Status:** Living document  
**Date:** 2026-06-10

---

## Overview

Animation in Salsa spans three distinct domains, each owned by one of the three core creative modes. Each domain works in a different coordinate space and has its own data model. Together, they combine into **scene composition** — a fully animated 3D scene where characters move, their ink strokes follow, and props and cameras animate along a shared timeline.

| Domain | Mode | Space | Data model | Engine status |
|--------|------|-------|------------|---------------|
| **Armature** | Armature | Local joint space | Poses + Animation Clips | ✅ Implemented |
| **Grease Pencil** | Grease Pencil | Drawing-plane space | Frames (cel animation) | ✅ Partial |
| **Mesh** | Edit Mesh / scene | World space | Keyframe tracks | ✅ Implemented |

The shared backbone tying all three together is a single **playback head** — one frame counter that all systems read simultaneously. This is already implemented via `AnimationPlayer3D` and `attachKeyframesToTimeline`.

---

## 1. Armature — Poses + Animation Clips

### Concept

Armature animation lives in **local joint space**: each joint stores a local rotation (quaternion), local position, and local scale relative to its parent. The skeleton hierarchy computes world-space bone matrices from these local values at runtime. This means animation data is independent of where the character stands in the world.

Two levels of armature animation:

- **Pose** — a named snapshot of all joint rotations at a single point in time. Not time-indexed. Used for references (T-pose, A-pose), IK targets, and as the base for building clips.
- **Animation Clip** (`SkeletonAnimClip`) — a named sequence of joint keyframes with timing. Multiple clips can exist per skeleton (idle, walk, run, jump). Clips are played back via an `AnimationPlayer3D` instance or blended via the NLA system.

### What's implemented

| Feature | API | Notes |
|---------|-----|-------|
| Joint FK (local rotation/position/scale) | `setJointRotation3D`, `setJointPosition3D` | Direct joint control |
| IK chains (FABRIK solver) | `setIKTarget3D`, `solveIK3D` | Per-chain, multi-iteration |
| IK target keyframing | `setIKKeyframe3D`, `IKKeyframeTrack` | Wired to eval path |
| Animation clips | `SkeletonAnimClip`, `applySkeletonClipAtFrame` | Per-joint tracks, slerp rotation |
| Clip playback | `playSkeletonClip3D` | `AnimationPlayer3D`-backed |
| NLA (non-linear animation) | `createNLATrack3D`, `addNLASegment3D`, `crossfade3D` | Replace + additive blend, fade ramps |
| Pose library | `capturePose3D`, `applyPose3D`, `getPoses3D` | Snapshots + recall |
| Bone constraints | `addJointConstraint3D` | lookAt, copyRotation, stretchTo |
| Blend shapes (shape keys) | `setBlendWeight3D`, `addBlendShape3D` | CPU morph before LBS |
| Blend shape weight keyframing | `setBlendShapeKeyframe3D`, `removeBlendShapeKeyframe3D`, `getBlendShapeKeyframeTracks3D` | `blendWeights` map in `Mesh3DKeyframeTracks`; sampled in `applyMeshKeyframesAtFrame` |

### What's missing

| Feature | Priority | Notes |
|---------|----------|-------|
| **Clip editor UI** | High | `SkeletonAnimClip` tracks exist in engine with no Frogmarks panel to create, trim, or edit them |
| **NLA track editor UI** | Medium | `NLATrack` API exists; needs a Frogmarks dope-sheet/NLA panel |
| **Retarget clip to different skeleton** | Low | Useful once multiple characters share the same motion library |

---

## 2. Grease Pencil — Frames

### Concept

GP animation lives in **drawing-plane space**: each stroke is a polyline of 3D world-space points anchored to a locked drawing plane. If the plane is parented to a bone via `parentJoint`, the stroke follows that bone automatically in the vertex shader — so GP animation is mostly *driven* by armature animation rather than keyframed independently.

When independent GP animation is needed (a speech bubble animating on/off, ink that changes shape frame to frame), it uses **cel animation** — the same frame-replacement model as 2D: each keyframe stores a full snapshot of the layer's strokes, and the renderer picks the correct snapshot at playback time.

### What's implemented

| Feature | API | Notes |
|---------|-----|-------|
| Strokes with bone parenting | `beginGpStroke3D(..., { parentJoint })` | Zero CPU cost — vertex shader |
| GP keyframes (cel snapshots) | `setGpKeyframe3D`, `clearGpKeyframe3D` | Frame-exact replacement, no interpolation |
| Drawing plane (face-locked) | `enterGpFaceSelectMode3D`, `getGpDrawPlane3D` | Ray-plane unproject for stable placement |
| Per-layer visibility + opacity | `setGpLayerVisible3D`, `setGpLayerOpacity3D` | — |
| Render order | `setGpRenderOrder3D` | Within GP pass |

### What's missing

| Feature | Priority | Notes |
|---------|----------|-------|
| **GP timeline row in Frogmarks** | High | The engine stores keyframes; there's no visual timeline track showing which frames have stroke snapshots |
| **Onion skin for GP layers** | Medium | 2D raster has onion skin (`setOnionSkin`); GP has no equivalent for previewing stroke motion across frames |
| **GP stroke interpolation** | Low | Currently frame-exact only; tweening between two stroke sets (morphing) is a future enhancement |
| **Multiple drawing planes** | Low | One active plane at a time; switching planes requires a new face selection |

---

## 3. Mesh — Keyframe Timeline

### Concept

Mesh animation lives in **world space**: the object's position, rotation, and scale are keyframed directly on the scene's shared timeline. This is the standard approach for props, environment pieces, and cameras moving through the scene. For a *skinned* mesh driven by an armature, the mesh itself doesn't need its own keyframe tracks — the bones drive it — but the skeleton's root position can be keyframed on the mesh's transform track.

### What's implemented

| Feature | API | Notes |
|---------|-----|-------|
| Position / rotation / scale tracks | `setMeshKeyframe3D(id, 'position', frame, value)` | Per-property, per-frame keyframes |
| Color / opacity / visible tracks | `setMeshKeyframe3D(id, 'diffuseColor' \| 'opacity' \| 'visible', ...)` | Material and visibility animation |
| Step, linear, and bezier easing | `Keyframe.easing: 'step' \| 'linear' \| 'ease-in' \| 'ease-out' \| 'ease-in-out'` | CSS cubic-bezier, Newton's method; per-keyframe |
| Camera keyframing | `setCameraKeyframe3D`, `recordCameraKeyframe3D`, `getCameraKeyframeTracks3D` | `Camera3DKeyframeTracks`: position, target, fov; wired to `applyAllKeyframesAtFrame` |
| Timeline sync | `attachKeyframesToTimeline3D` | Mesh keyframes driven by raster timeline frame counter |
| Standalone playback clock | `createAnimationPlayer3D(config)` | Independent of raster timeline |
| Raster ↔ 3D playback sync | Automatic via `set3DPlaybackSync` hook | Play/pause/stop on raster timeline mirrors 3D |

### What's missing

| Feature | Priority | Notes |
|---------|----------|-------|
| **Keyframe timeline UI** | High | Engine tracks exist; Frogmarks has no panel to set/remove/scrub 3D mesh keyframes |
| **Multi-property dope sheet** | Medium | No UI to see all animated properties for a mesh in one view |

---

## 4. Shared Infrastructure

These pieces serve all three animation domains.

### What's implemented

| Feature | Status | Notes |
|---------|--------|-------|
| `AnimationPlayer3D` (rAF clock) | ✅ | Time-accumulation loop, frame-accurate at any FPS |
| Raster timeline frame counter | ✅ | `shapeManager.setCurrentFrame`, `onAnimationEvent` |
| 3D ↔ raster playback sync | ✅ | Play/pause/stop coupled via `set3DPlaybackSync` |
| `applyAllKeyframesAtFrame` | ✅ | Applies mesh + skeleton tracks at a frame number |
| Undo/redo for 3D edits | ✅ | `UndoManager3D`, 50-command stack |

### What's missing

| Feature | Priority | Notes |
|---------|----------|-------|
| **Unified 3D timeline panel** | High | The raster timeline shows 2D layer cels; there's no panel in Frogmarks that shows 3D mesh keyframe tracks, armature clip ranges, and GP keyframe rows in one synchronized view |
| **Graph editor / curve editor** | Medium | Editing keyframe interpolation curves (bezier handles) requires a separate curve editor view — not needed for step/linear but critical once bezier easing is added |
| **Playback range gating per system** | Low | Currently all systems play frame 0–N; ability to loop one clip while another plays once is NLA-level control (already in engine, not yet exposed) |

---

## 5. Scene Composition

A fully animated scene uses all three domains simultaneously:

```
Frame 42
│
├─ Mesh keyframes          → hero mesh at world position (0, 0, 2), visible: true
│
├─ Armature clip           → "walk_cycle" clip at t=42 → joint rotations computed
│   └─ Bone parented GP    → ink strokes follow chest/arm joints via vertex shader
│
├─ GP keyframes            → "speech_bubble" layer: frame 38–45 has stroke snapshot
│
└─ Mesh keyframes          → spotlight mesh at (3, 4, 0), opacity fade-in
```

The engine already supports this composition — `applyAllKeyframesAtFrame(42)` applies mesh tracks, `applySkeletonClipAtFrame(clip, skel, 42)` applies bone transforms, and GP keyframe lookup happens during GP render. All three respond to the same frame number.

**The gap is exclusively UI**: there is no Frogmarks panel that lets an artist see, scrub, and edit all of these tracks together in one place.

---

## 6. Roadmap

Priority order for completing the animation story:

| # | Feature | Domain | Status | Notes |
|---|---------|--------|--------|-------|
| 1 | Unified 3D timeline panel (mesh keyframe rows + GP rows + armature clip ranges) | All | 📋 Frogmarks | Critical — without this, all the engine work is invisible |
| 2 | Keyframe UI for mesh tracks (set/remove/view keys for position, rotation, scale) | Mesh | 📋 Frogmarks | Engine tracks fully wired |
| 3 | Armature clip editor (create, trim, set timing for SkeletonAnimClip) | Armature | 📋 Frogmarks | Engine clips already exist |
| 4 | GP timeline rows (show which frames have stroke snapshots, add/clear keyframes) | GP | 📋 Frogmarks | Engine keyframes already exist |
| 5 | Bezier easing | Mesh | ✅ Done | `ease-in/ease-out/ease-in-out` in `KeyframeEasing`; CSS cubic-bezier, Newton's method |
| 6 | Blend shape weight keyframing | Armature / Mesh | ✅ Done | `setBlendShapeKeyframe3D` / `removeBlendShapeKeyframe3D`; `blendWeights` in `Mesh3DKeyframeTracks` |
| 7 | Camera keyframing | Mesh | ✅ Done | `Camera3DKeyframeTracks`; `setCameraKeyframe3D` / `recordCameraKeyframe3D` |
| 8 | NLA track editor UI | Armature | 📋 Frogmarks | Engine `NLATrack` API complete |

All engine work (items 5–7) is now done. Items 1–4 and 8 are purely Frogmarks UI work — the Salsa engine has the full data model and API for all of them.
