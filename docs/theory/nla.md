# Non-Linear Animation (NLA)

## Intuition

A character animation system where you can only play one clip at a time is like a music player with no crossfade — every transition is a hard cut. Non-linear animation solves this by treating clips as independent objects you place on a timeline and blend together, rather than playing sequentially.

The "non-linear" part means you can rearrange, overlap, and weight clips independently of each other, unlike linear sequenced playback.

---

## Mental Model

Picture a multi-track audio mixer. Each track plays its clip from a start position. Tracks overlap in time. Each track has a volume knob (weight). The output is a mix of all active tracks.

NLA applies the same idea to skeleton poses instead of audio samples. Each "clip track" evaluates its animation at the current frame and contributes a weighted pose. The evaluator mixes all active contributions and writes the result to the skeleton.

```
Frame 20:
  Replace track A (idle):   weight 0.5 (fading out) → poseA
  Replace track B (walk):   weight 0.5 (fading in)  → poseB
  Additive track C (breathe): weight 0.6              → delta_C

  Final = blendPoses(bindPose → poseA → poseB) + delta_C * 0.6
```

---

## Formal Explanation

### Pose Representation

A `SkeletonPose` is a flat snapshot of every joint's local transform:

```
{ rotations: quat[], positions: vec3[], scales: vec3[] }
```

Indices correspond 1:1 to `skeleton.data.joints`.

### Replace Blending

Replace segments blend sequentially, starting from the bind pose:

```
currentPose = bindPose
for each active replace segment in order:
    segPose = sampleClipAtFrame(clip, localFrame)
    currentPose = slerp(currentPose, segPose, effectiveWeight)
```

`effectiveWeight` is `segment.weight` modulated by fade-in/out ramps:

```
if elapsed < fadeIn:   effectiveWeight *= elapsed / fadeIn
if remaining < fadeOut: effectiveWeight *= remaining / fadeOut
```

This naturally models crossfades: two overlapping replace segments — one fading out, one fading in — blend cleanly at their intersection.

### Additive Blending

Additive segments add a delta on top of the replace result:

```
for each active additive segment:
    segPose = sampleClipAtFrame(clip, localFrame)
    for each joint i:
        delta_rot = segPose.rot[i] * inv(bindPose.rot[i])
        currentPose.rot[i] = slerp(identity, delta_rot, w) * currentPose.rot[i]
        currentPose.pos[i] += (segPose.pos[i] - bindPose.pos[i]) * w
        currentPose.scale[i] *= (1 + (segPose.scale[i] - bindPose.scale[i]) * w)
```

The delta is always relative to the bind pose, which is why the bind pose must be stable. A breathing animation authored from a T-pose will add the same breathing motion regardless of whether the character is idle, walking, or running.

### Why Additive Needs a Reference Pose

If you animate a character breathing and bake it as absolute joint rotations, the chest joint might be at rotation `(0, 0, 0.1)` at rest and `(0, 0, 0.3)` at peak inhale. To apply this additively:

- **Absolute:** overrides the chest rotation entirely — you lose whatever FK pose the replace blend produced.
- **Delta from bind:** `(0, 0, 0.2)` delta — adds on top of whatever the chest currently is. The chest goes from `idle_chest + 0.2` to `run_chest + 0.2`. The breathing motion is preserved across all locomotion states.

This is why `sampleClipPose(clip, bindPose, frame)` substitutes the bind pose for any joint channel not covered by the clip, and why the evaluator computes `segPose − bindPose` rather than using `segPose` directly.

---

## Why It Matters

NLA makes two patterns practical that are otherwise tedious:

**Crossfades between locomotion states.** An idle-to-walk transition is a fade between two replace segments. Without NLA, you'd need to bake a transition clip. With NLA, you just set `fadeOut` on idle and `fadeIn` on walk and let the evaluator interpolate.

**Secondary motion layers.** Breathing, eye blinks, head sway, cloth secondary are all small motions that apply on top of any locomotion state. As additive clips they're authored once and "just work" over any replace layer.

---

## Where the Mental Model Breaks

**Order matters for replace blending.** Sequential `blendPoses(A → B, t)` is not commutative. If segment B comes after A and they overlap, the result at `t=0.5` is `blendPoses(blendPoses(bind, A, 1.0), B, 0.5)`. This is usually what you want (the later segment wins), but swapping order changes the result.

**Additive rotation composition isn't commutative either.** Applying additive segment C then D is not the same as D then C. In practice this rarely matters if the deltas are small (< 30°), but large additive rotations can produce unexpected results when multiple additive layers combine.

**The bind pose must match the source clips.** If a breathing clip was authored against an A-pose and the bind pose captured by the NLA track is a T-pose, the additive delta will be the wrong magnitude. Author all additive clips from the same reference pose, and snapshot the bind pose at that reference.

---

## Common Confusions

**"Why do I need a bind pose? Can't I just start from the current joints?"**  
Starting from the current joints would make the blend depend on whatever pose the skeleton was in when the track was created — non-deterministic across sessions. The bind pose is a stable reference that makes additive deltas reproducible.

**"What if a clip doesn't cover all joints?"**  
`sampleClipPose` substitutes bind pose values for joints not covered by any track in the clip. This means a partial clip (e.g., an arm-only gesture) blends naturally — the rest of the skeleton stays at the blend result from the replace layer.

**"Does NLA replace `applySkeletonClipAtFrame`?"**  
No. `applySkeletonClipAtFrame` remains the fast path for single-clip playback (direct joint mutation, no pose snapshots). `evaluateNLAAtFrame` is the multi-clip path that uses `SkeletonPose` snapshots for blending. Use NLA when you need crossfades or additive layers; use the single-clip API for simple looping animations.

---

## How Salsa Uses It

- **`src/renderer/3d/skeleton-animator.ts`** — `evaluateNLAAtFrame`, `sampleClipPose`, `blendPoses`, `snapshotSkeletonPose`
- **`src/services/managers/scene3d-manager.ts`** — `_nlaTracks`, `_nlaPlayers`, `_nlaBindPoses`; all `createNLATrack3D` / `playNLATrack3D` / `crossfade3D` methods
- **`src/types/armature-3d.ts`** — `NLAClipSegment`, `NLATrack`; `SkeletonData.nlaTracks`
- **`src/renderer/3d/animation-player-3d.ts`** — provides the RAF-based frame clock; one player per NLA track

---

## Related Concepts

- [skeletal-animation.md](skeletal-animation.md) — inverse bind matrices, LBS skinning, `computeWorldMatrices`
- [quaternion-interpolation.md](quaternion-interpolation.md) — slerp and why we can't just lerp quaternions
- [inverse-kinematics.md](inverse-kinematics.md) — IK evaluation runs after NLA in the full evaluation order
