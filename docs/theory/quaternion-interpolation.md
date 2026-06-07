# Quaternion Interpolation
**Last Updated:** 2026-06-06

---

## Intuition

Euler angles describe where a rotation ends up, but they say nothing about the path taken to get there. Linearly interpolating between two Euler angle triples — the obvious approach to keyframe blending — moves each axis independently, producing curved paths through orientation space even when the intended motion is a clean, single-axis turn. The result: unnatural wobble, inconsistent speed, and the famous gimbal lock.

Quaternions represent rotations as points on the surface of a 4-dimensional unit sphere. Interpolating between two quaternions is interpolating between two points on that sphere — traveling along the great circle arc between them. The path is the shortest possible rotation, at constant angular velocity, with no axis wobble.

---

## Mental Model

### A quaternion as a rotation axis + angle

Any rotation in 3D can be described as "rotate by angle θ around axis (x, y, z)." A quaternion encodes this as a unit-length 4-vector:

```
q = [w, x, y, z]
  = [cos(θ/2), sin(θ/2)·axis.x, sin(θ/2)·axis.y, sin(θ/2)·axis.z]
```

The half-angle appears everywhere in quaternion math. It is not a simplification — it falls out of the algebra and is why quaternion composition (multiplying two quaternions) gives the correct composed rotation.

For a rotation around the Y axis by 90°:
```
q = [cos(45°), 0, sin(45°), 0]
  = [0.707, 0, 0.707, 0]
```

### The unit sphere

All valid rotation quaternions live on the surface of the 4D unit sphere (`|q| = 1`). Think of the surface of an ordinary sphere as an analogy — except it lives in 4D. Every point on the surface is a valid orientation.

The "distance" between two orientations is the angle between their quaternions on this sphere. Interpolation travels along the arc connecting them.

### The double-cover problem

Both `q` and `-q` represent the same rotation. Negating all four components doesn't change the rotation because `cos(θ/2)` and `-cos(θ/2)` both square to the same value in the rotation matrix expansion. This means every orientation has two quaternion representations — antipodal points on the sphere.

This matters for interpolation. `slerp(q1, q2, t)` travels the short arc. `slerp(q1, -q2, t)` travels the long arc (going the "wrong way around the sphere"). They end at the same destination but via opposite paths, one of which spins more than 180°.

Fix: before slerping, check `dot(q1, q2)`. If the dot product is negative, negate `q2`. This flips it to the same hemisphere as `q1`, ensuring the shorter arc.

```
if dot(q1, q2) < 0:
    q2 = -q2
```

---

## Formal Explanation

### Slerp (spherical linear interpolation)

```
slerp(q1, q2, t) = q1 · sin((1-t)·Ω) / sin(Ω)  +  q2 · sin(t·Ω) / sin(Ω)
```

where `Ω = acos(dot(q1, q2))` is the half-angle between the two quaternions (the arc length in quaternion space).

Properties:
- `slerp(q1, q2, 0) = q1`, `slerp(q1, q2, 1) = q2`
- Constant angular velocity: equal `t` increments produce equal angular steps
- Shortest path (after the hemisphere fix above)

### Nlerp (normalized linear interpolation)

Slerp has a singularity when `Ω → 0` (the `sin(Ω)` denominator). It also involves `acos` and two `sin` calls — more expensive than a simple lerp.

Nlerp is the cheap approximation:

```
nlerp(q1, q2, t) = normalize(lerp(q1, q2, t))
                 = normalize((1-t)·q1 + t·q2)
```

Properties:
- Correct endpoints
- NOT constant angular velocity — slightly slower near the midpoint and faster near the ends (the "sine bulge" of linear interpolation on a sphere)
- No singularity when `Ω ≈ 0` — degrades smoothly to the correct answer
- Commutative (unlike slerp)

For most animation use cases, nlerp is indistinguishable from slerp. Use slerp only when constant angular velocity visually matters (camera pan, turntable spin).

### Rotation between two vectors

Given two unit vectors `a` and `b`, the quaternion that rotates `a` onto `b`:

```
half = normalize(a + b)
q = [dot(a, half), cross(a, half).x, cross(a, half).y, cross(a, half).z]
```

This is the standard "rotation between" construction used in IK (converting a bone's old direction to its new direction after the position solve).

Edge case: when `a ≈ -b` (180° rotation), `a + b ≈ 0` and the half vector is undefined. Pick an arbitrary perpendicular axis:

```
if |a + b| < ε:
    perp = any vector perpendicular to a
    q = [0, perp.x, perp.y, perp.z]  // 180° rotation around perp
```

### Quaternion composition

Composing two rotations `q1` then `q2` is quaternion multiplication (Hamilton product):

```
q_composed = q2 × q1   // NOTE: right-to-left, like matrix multiplication
```

This composes without gimbal lock, in O(1) with no trigonometry. It is the fundamental reason quaternions replaced Euler angles in production animation pipelines.

### Converting to/from rotation matrix

Quaternion to 3×3 rotation matrix:

```
R = [
  1-2(y²+z²),  2(xy-wz),   2(xz+wy),
  2(xy+wz),    1-2(x²+z²), 2(yz-wx),
  2(xz-wy),    2(yz+wx),   1-2(x²+y²)
]
```

Matrix to quaternion (Shepperd's method): extract from the trace and off-diagonal elements, handling four cases to avoid near-zero denominators. Standard libraries (`gl-matrix`, three.js) implement this reliably — prefer them over manual implementations.

---

## Why It Matters

**Keyframe interpolation.** Animation clips store keyframes as (frame, value) pairs. For rotation channels, values are quaternions. Blending from keyframe A to keyframe B uses slerp (or nlerp). If keyframes were stored as Euler angles and blended by lerp, a 90° Y rotation + 90° Z rotation as separate keys would produce an ugly intermediate orientation that tumbles through both axes simultaneously.

**FK ↔ IK blending.** The IK solver produces a joint rotation; FK playback produces another. The final joint rotation is `slerp(fkQuat, ikQuat, blendWeight)`. Both inputs are quaternions; the blend is a single slerp call per joint.

**Smooth look-at.** A camera tracking a moving target uses `slerp(currentOrientation, targetOrientation, dampingFactor)` each frame. Euler lerp would cause visible wobble.

---

## Where the Mental Model Breaks

**"Slerp is always better than lerp."**
For the camera turntable case, yes. For most joint keyframe blending at 60fps, the difference between slerp and nlerp is invisible — the keyframe delta is small, and the arc is nearly straight. Nlerp is faster and doesn't have the near-zero-angle singularity.

**"Quaternions solve gimbal lock completely."**
Quaternions themselves don't gimbal lock — there's no discontinuity in the 4D sphere representation. But if you convert to Euler angles for display or storage and back again, you reintroduce the Euler representation and its lock conditions. Gimbal lock is a property of the Euler parametrization, not of the rotation itself.

**"q and -q are different rotations."**
They represent the same rotation. The confusion arises because they are different points on the 4D sphere. Many bugs come from comparing quaternions for equality and missing that `q == -q` should be true for rotational purposes. Always check `dot(q1, q2) > 0.9999` (not `q1 == q2`) when testing if two rotations are identical.

**"Composing two slerps gives a smooth path."**
`slerp(slerp(a, b, t), c, t)` does NOT produce a smooth cubic curve — it produces two linear arcs with a kink at the join. For smooth multi-keyframe paths, use Squad (spherical cubic) or run a Catmull-Rom spline in quaternion space.

---

## Common Confusions

**"My animation snaps at frame boundaries."**
The dot product between adjacent keyframe quaternions is negative — the interpolation is taking the long arc instead of the short arc. Normalize the quaternion track on import: for each consecutive pair `(q_i, q_{i+1})`, if `dot(q_i, q_{i+1}) < 0`, negate `q_{i+1}`.

**"I extract Euler angles from a quaternion and get a jitter."**
Floating-point precision causes the extracted angle to flip between equivalent representations near the gimbal-lock singularity (rotationX = ±90°). If you need Euler for display/export, extract once at keyframe time and cache — don't extract per frame from the blended quaternion.

**"Quaternion multiplication order is confusing."**
gl-matrix uses column-major matrices and right-to-left composition: `q_total = q_second × q_first`. The rotation applied first goes on the right. This matches matrix multiplication convention — `M_total = M_second × M_first`. Getting the order backward produces the composed rotation in the wrong sequence.

---

## How Salsa Uses It

**`src/scene-graph/shapes/skeleton-3d.ts`** — joint local rotations are stored as Euler angles (matching the Node base class) for compatibility with the 2D transform system, but animation keyframe interpolation reads/writes quaternions. `sampleAnimClip(clip, frame)` converts joint Euler angles to quaternions, slerps between keyframe values, and converts back.

**`src/types/armature-3d.ts`** — `SkeletonKeyframeTrack.channel` can be `'rotation'`, in which case values are `[w, x, y, z]` quaternion tuples. Translation and scale channels use plain float triples.

**`src/services/managers/scene3d-manager.ts`** — `retargetSkeletonClip3D` copies tracks directly (quaternion values are channel-agnostic numbers); no quaternion math needed for retargeting.

**IK rotation-between** (see [Inverse Kinematics](inverse-kinematics.md)) — the conversion from FABRIK's new bone direction to a joint local rotation uses the "rotation between two vectors" construction above, calling `gl-matrix`'s `quat.rotationTo`.

**GLTF import** — glTF stores animation rotation channels as quaternions. The import pipeline reads them directly and either stores as-is (quaternion track) or converts to Euler via Shepperd + YXZ decomposition to match Salsa's node rotation convention.

---

## Related Concepts

- [Euler Rotations](euler-rotations.md) — Euler angles are what the scene-graph Node stores; quaternion interpolation is what animation uses internally; conversion between them is the constant seam
- [Inverse Kinematics](inverse-kinematics.md) — the "rotation between two vectors" quaternion construction is used to convert IK position results to joint rotations
- [Skeletal Animation](skeletal-animation.md) — keyframe tracks blend joint rotations via slerp; skin matrices are derived from the resulting poses
