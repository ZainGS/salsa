# Keyframe Animation
**Last Updated:** 2026-06-10

---

## Intuition

A keyframe is an instruction to be at a specific value at a specific time. Everything in between is filled in automatically by the engine. You set the important moments — start here at frame 0, end there at frame 30 — and interpolation handles the journey.

The alternative — specifying every single frame by hand — is what animation looked like before computers. Keyframes are the encoding that makes animation authoring tractable: you define the extremes, the system computes the inbetweens.

---

## Mental Model

Imagine a horizontal ruler where each tick is a frame number. You place pins on the ruler at certain ticks, and each pin has a value attached (a position, a rotation, a weight). Between any two pins, the value travels from one to the other according to a curve you specify. Before the first pin and after the last, the value stays constant at its nearest pin.

```
 value
   │
 1.0│                    ●────────────●
   │               ╱                  ╲
 0.5│         ╱                         ╲
   │    ╱                                  ╲
 0.0│──●────────────────────────────────────────●──
   └──────────────────────────────────────────────
   0        10        20        30        40     frame
```

Each dot is a keyframe. The curve between them is the easing. The flat line before frame 0 and after frame 40 is "hold at boundary."

The key insight: **the easing belongs to the segment, not the endpoint.** When you set easing on a keyframe, you are specifying how to travel from that keyframe *to the next one*. The last keyframe's easing setting is irrelevant — there is no segment after it.

---

## Formal Explanation

### Data Model

A keyframe track is a sorted list of time-value pairs, each with an associated easing:

```typescript
interface Keyframe<T> {
  frame:  number;           // integer timeline position
  value:  T;                // the value at this moment
  easing: KeyframeEasing;   // how to interpolate toward the NEXT keyframe
}

type KeyframeEasing = 'step' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
```

A `Mesh3DKeyframeTracks` stores one track per animated property:

```typescript
interface Mesh3DKeyframeTracks {
  position?:     Keyframe<[x, y, z]>[];
  rotation?:     Keyframe<[rx, ry, rz]>[];   // Euler in radians
  scale?:        Keyframe<[sx, sy, sz]>[];
  diffuseColor?: Keyframe<[r, g, b, a]>[];
  opacity?:      Keyframe<number>[];
  visible?:      Keyframe<boolean>[];
  blendWeights?: Record<shapeName, Keyframe<number>[]>;  // per blend shape
}
```

Cameras have their own track interface (`Camera3DKeyframeTracks`) with `position`, `target`, and `fov`.

### Sampling a Track

Given a frame number, the sampler finds the surrounding keyframe pair and interpolates:

```
sampleTrack(track, frame):
  sort keyframes by frame
  if frame ≤ track[0].frame  → return track[0].value
  if frame ≥ track[last].frame → return track[last].value
  find k0, k1 where k0.frame ≤ frame < k1.frame
  t = (frame - k0.frame) / (k1.frame - k0.frame)   // t ∈ [0, 1]
  return interpolate(k0.value, k1.value, t, k0.easing)
```

`t` is a normalized position within the segment: 0 at `k0`, 1 at `k1`. The easing function remaps `t` before the interpolation, controlling the shape of the curve.

### Easing Functions

**`step`** — no interpolation. The value jumps from `k0.value` to `k1.value` at `k1.frame`:

```
f(t) = 0   (always returns k0.value regardless of t)
```

Use for: visibility toggling, cel animation frame replacement, any discrete state change.

**`linear`** — constant velocity. The value changes at the same rate throughout the segment:

```
f(t) = t
```

Use for: mechanical motion (conveyor belts), continuous data (frame counters), cases where the default "no curve" behavior is intentional.

**`ease-in`** — starts slow, ends fast. Useful for objects that begin at rest and accelerate:

```
f(t) = cubicBezier(0.42, 0, 1.0, 1.0)(t)   // CSS ease-in
```

**`ease-out`** — starts fast, ends slow. Useful for objects that decelerate to a stop:

```
f(t) = cubicBezier(0.0, 0, 0.58, 1.0)(t)   // CSS ease-out
```

**`ease-in-out`** — slow at both ends, fast in the middle. The most natural-looking motion for most animation:

```
f(t) = cubicBezier(0.42, 0, 0.58, 1.0)(t)  // CSS ease-in-out
```

### How CSS Cubic Bezier Works

A 2D cubic Bezier curve has four control points. For easing, the endpoints are fixed at `P0=(0,0)` (start) and `P3=(1,1)` (end). Only `P1=(x1,y1)` and `P2=(x2,y2)` are configurable. The x-axis is time (normalized, 0→1); the y-axis is the easing output (0→1).

```
B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
```

The problem: given an input `x` (frame progress), find the output `y` (eased progress). Since `x = Bx(t)` is not directly invertible to `t`, Salsa uses Newton's method — an 8-iteration numerical solve — to find the `t` that produces the desired `x`, then evaluates `By(t)`. Eight iterations is enough for sub-pixel accuracy at render scale.

---

## Why It Matters

**Without easing, every animation looks robotic.** A ball that moves at perfectly constant velocity from A to B looks like a block sliding on ice. Natural motion always involves acceleration and deceleration — ease-out for stopping, ease-in for starting, ease-in-out for both.

**Without keyframes, animation requires per-frame data.** 120 frames of position animation = 120 `[x,y,z]` values. With keyframes: 2 values (`start` and `end`) plus an easing curve. The more predictable the motion, the more compression keyframes provide.

**Keyframe tracks are composable.** Position, rotation, scale, color, opacity, blend shape weights — each is an independent track. You can animate color without touching position. An animator can hand off position keys to a layout artist and blend shape keys to a character artist, and both track sets compose on the same mesh.

---

## Where the Mental Model Breaks

**"The easing on the last keyframe does something."** It doesn't. The easing specifies how to interpolate to the *next* keyframe. The last keyframe has no successor, so its easing is never used. This surprises users who set `ease-out` on the last keyframe expecting a slow finish and see no effect — the slow finish is already built into the `ease-in-out` on the *previous* keyframe.

**"Step easing jumps at the keyframe's own frame."** No. `step` jumps at the *next* keyframe's frame. Concretely: if `k0.frame=0, k0.easing='step'` and `k1.frame=10`, then frames 0–9 all return `k0.value`, and frame 10 returns `k1.value`. The jump happens when you arrive at `k1`, not when you leave `k0`.

**"t is in frame units."** `t` is always in [0,1] — a normalized progress within the segment. The raw frame position is only used to compute `t`. The easing function always receives and returns values in [0,1].

**"Easing controls velocity."** Not directly. Easing remaps the progress parameter `t`. The resulting *position* change per frame depends on both the easing curve and the value range. A position track going from 0 to 100 with `ease-out` moves faster at the start than the end — but two position tracks going from 0→10 and 0→100 with the same easing will have different velocities despite identical `t` progressions.

**"I need smooth keyframe curves to match two segments."** Linear and the preset easings are independent per segment. A keyframe between two segments may create a velocity discontinuity: the value decelerates into it (from an ease-in before it) and immediately accelerates away (ease-in on the next segment). Full curve continuity (C2 continuity) requires per-handle Bezier control, which the step/linear/preset system doesn't provide. For professional animation, a curve editor with draggable Bezier handles per keyframe is the standard solution; Salsa's presets cover 90% of use cases without one.

---

## Common Confusions

**"Why is there a `frame` integer, not a float?"** Keyframes live at discrete frame positions. Sub-frame timing (e.g., "this keyframe fires 1.5 frames in") is valid conceptually but requires rational frame indices — this is handled by the `fps` setting at the clip level rather than fractional keyframe positions, which keeps storage simple and editing intuitive.

**"How do I make a loop that starts and ends at the same value?"** Set the first and last keyframe to the same value. The sampler clamps to boundary values, so if both ends are 0, the animation holds at 0 before and after the loop range — only the internal motion between them is interpolated.

**"Does `applyAllKeyframesAtFrame` run every render tick?"** Only when the raster timeline fires a `frame-changed` event (or an `AnimationPlayer3D` tick fires). It does NOT run on every `requestAnimationFrame`. If the frame counter doesn't change, keyframes are not re-sampled.

**"Why doesn't the first keyframe use its easing setting to interpolate from a starting value?"** There is no implicit "zero" or "neutral" value at frame 0. The track holds the first keyframe's value for all frames before it. The first segment starts at the first keyframe, not at frame 0.

---

## How Salsa Uses It

| Component | Role |
|-----------|------|
| `Keyframe<T>` (`keyframe-3d.ts`) | Base type: `{ frame, value, easing }` |
| `Mesh3DKeyframeTracks` | Per-mesh track map (position, rotation, scale, color, opacity, visible, blendWeights) |
| `Camera3DKeyframeTracks` | Camera-specific tracks (position, target, fov) |
| `sampleTrack<T>()` | Generic sampler — sort, clamp, find segment, interpolate |
| `setKeyframe<T>()` | Upsert by frame number (replaces if same frame exists) |
| `removeKeyframe<T>()` | Remove by frame, returns false if not found |
| `interpolateScalar/Vec3/Vec4()` | Per-type interpolators; dispatch to `applyEasing(t, easing)` |
| `makeCubicBezier(p1x,p1y,p2x,p2y)` | Returns a function `x → y` via Newton's method (8 iterations) |
| `applyMeshKeyframesAtFrame()` | Samples all 7 track types for one mesh; writes to mesh properties |
| `applyCameraKeyframesAtFrame()` | Samples camera tracks; writes position/target/fov to Camera3D |
| `applyAllKeyframesAtFrame()` | Calls mesh + camera versions for the whole scene |
| `setBlendShapeKeyframe()` | Inserts/updates a keyframe in `blendWeights[shapeName]` |
| `UndoManager3D` | Every `setKeyframe` / `removeKeyframe` call pushes a reversible command |

**Evaluation order for a frame that has both keyframes and blend shapes:**

```
applyAllKeyframesAtFrame(42)
  → applyMeshKeyframesAtFrame(meshId, 42)
      → sample position/rotation/scale/color/opacity/visible tracks
      → sample blendWeights[shapeName] tracks → setBlendWeight(idx, w)
         → evaluateBlendShapes() → writes mesh._geometry.vertices
         → gpuDirty = true
  → applyCameraKeyframesAtFrame(42)
      → sample position/target/fov tracks → write to Camera3D
```

---

## Related Concepts

- [blend-shapes.md](blend-shapes.md) — what blend shape weights represent; the CPU evaluation that keyframing drives
- [skeletal-animation.md](skeletal-animation.md) — skeleton clips use a parallel keyframe system (`SkeletonKeyframeTrack`) with slerp rotation
- [quaternion-interpolation.md](quaternion-interpolation.md) — why skeleton rotation tracks use slerp instead of linear interpolation of Euler angles
- [nla.md](nla.md) — non-linear animation: multiple clips on one timeline, with blending and crossfades
