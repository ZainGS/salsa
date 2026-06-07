# Inverse Kinematics
**Last Updated:** 2026-06-06

---

## Intuition

Forward kinematics (FK) is the natural direction: rotate the shoulder, the elbow follows, the hand ends up wherever the chain puts it. You control causes; positions are consequences.

Inverse kinematics (IK) reverses this: you specify where the hand must be, and the algorithm figures out what shoulder and elbow rotations achieve that. You control the consequence; the algorithm works backward to find causes.

This reversal is genuinely harder. FK has a unique answer — apply rotations, compute positions. IK typically has infinitely many solutions (an elbow can be above or below the forearm plane and still reach the same hand position), no solutions (the target is out of reach), or solutions that require joint angles beyond physical limits. The algorithm has to navigate this under-determined, constrained search problem every frame, fast enough to appear instantaneous.

---

## Mental Model

### FK chains

A joint chain is a directed list of bones: root → joint₁ → joint₂ → ... → end effector. Each joint stores a local rotation. World position of each joint is computed by accumulating transforms from the root outward:

```
joint_0.worldPos = root.worldPos
joint_1.worldPos = joint_0.worldPos + bone_0.direction × bone_0.length
joint_2.worldPos = joint_1.worldPos + bone_1.direction × bone_1.length
...
```

Changing `joint_0.rotation` changes the direction all downstream bones point, cascading through the chain. The end effector ends up wherever the chain puts it — you don't get to say.

### IK as an optimization problem

IK wants to find joint rotations `{θ_0, θ_1, ..., θ_n}` such that the end effector's world position equals (or is close to) the target position `T`. This is:

```
minimize |endEffector(θ_0, ..., θ_n) - T|²
subject to: joint angle limits for each θ_i
```

Analytical solutions exist for 2-bone chains (simple arm with shoulder + elbow). For longer chains, iterative numerical solvers are the standard.

### FABRIK: the reach-and-pull picture

FABRIK (Forward And Backward Reaching Inverse Kinematics) is a position-based solver. It does not work with angles directly — it moves joint positions, then derives rotations from the resulting directions.

The intuition in two passes:

**Forward pass (backward reaching):** Ignore the root constraint. Pull the end effector to the target. Then pull each joint toward the next one, maintaining exact bone lengths. Work from the end toward the root.

```
Before:           After forward pass:
  root             root (now displaced)
   |                |
  J1               J1 (pulled toward J2's new position)
   |                |
  J2               J2 (pulled toward J3's new position)
   |                |
  J3               J3 (snapped to target T)
   |
  end ─────────── T
```

**Backward pass (forward reaching):** Now the root is out of place. Pin it back to its original position. Push each joint away from the previous one, maintaining bone lengths. Work from the root toward the end.

```
After backward pass:
  root (pinned back)
   |
  J1 (pushed to correct distance from root)
   |
  J2 (pushed to correct distance from J1)
   |
  J3 (end effector, now close to T)
```

Repeat until the end effector is within tolerance of the target. Most chains converge in 3–10 iterations.

The elegance: FABRIK never computes a rotation matrix. It operates entirely on world-space positions and derives joint directions from `normalize(next - current)`. Rotations are extracted afterward from direction changes between iterations.

---

## Formal Explanation

### FABRIK algorithm

```
inputs:
  p[0..n]          world-space joint positions; p[0] = root (fixed)
  L[0..n-1]        bone lengths (constant; L[i] = |p[i+1] - p[i]| at bind time)
  target T
  maxIter = 10
  tolerance = 0.001

totalLen = sum(L)

// Unreachable: stretch chain toward target
if dist(p[0], target) >= totalLen:
    dir = normalize(target - p[0])
    for i in 0..n-1:
        p[i+1] = p[i] + dir * L[i]
    return

root0 = p[0]   // save original root

for iter in 1..maxIter:
    // Forward pass: pull end to target, work root-ward
    p[n] = target
    for i in n-1 downto 0:
        dir = normalize(p[i] - p[i+1])
        p[i] = p[i+1] + dir * L[i]

    // Backward pass: pin root, work end-ward
    p[0] = root0
    for i in 0..n-1:
        dir = normalize(p[i+1] - p[i])
        p[i+1] = p[i] + dir * L[i]

    if dist(p[n], target) < tolerance:
        break
```

### Converting positions to joint rotations

After FABRIK produces world-space positions, each joint's local rotation is derived from the new bone direction relative to the previous bone direction:

```
for i in 0..n-1:
    oldDir = normalize(p[i+1] - p[i])   // before solving
    newDir = normalize(p[i+1] - p[i])   // after solving (same in world space)
    // quaternion that rotates oldDir → newDir:
    q = rotationBetween(bindDir[i], newDir)
    joint[i].localRotation = parentInvRotation × q
```

The `parentInvRotation` term converts from world-space rotation difference to bone-local rotation, since joints store local rotations.

### Pole vectors

A 2-bone chain (shoulder → elbow → hand) has infinitely many solutions. The elbow can be anywhere on a circle around the shoulder-hand axis. A **pole vector** constrains the elbow to always point toward a specific world-space point, picking a unique solution:

```
// Project elbow onto the shoulder-hand axis, then offset toward pole
mid = shoulder + proj(elbow - shoulder, normalize(hand - shoulder))
dir = normalize(poleVector - mid)
elbow = mid + dir * elbowReach
```

### Joint angle constraints

Hard joint limits clamp each angle after the solve:

```
after each backward pass iteration:
    for each joint i:
        clamp joint[i].localEuler to [minAngle_i, maxAngle_i]
```

Clamping disrupts the solve (a constrained joint may not reach the target), but FABRIK still converges to the best achievable configuration within the constraints.

---

## Why It Matters

**Procedural animation reuse.** A hand reaching for a door handle, a foot planting on uneven ground, a tentacle wrapping around an object — all are specified as target positions in world space, with no manual rotation keyframes. The IK solver derives the joint rotations automatically.

**Live interaction.** Dragging an end-effector handle in the viewport gives immediate visual feedback. The solver runs each frame (≈10 iterations × chain length operations) and is fast enough to run in the main thread without frame drops.

**FK ↔ IK blending.** Animation clips store FK rotations (keyframes per joint). During playback, an IK override can layer on top: `finalRotation = lerp(fkRotation, ikRotation, blend)`. This lets animation drive the base pose while IK corrects the hands/feet for environmental contact.

---

## Where the Mental Model Breaks

**"IK has a unique solution."**
Rarely true for chains of 3+ bones. The solver finds *a* solution consistent with the constraints and initial pose, not *the* solution. Different starting poses converge to different results. This is usually desirable (a character crouching reaches differently than one standing), but can surprise when the solver flips to a different solution branch.

**"FABRIK gives me rotations."**
FABRIK operates on positions and outputs positions. Rotations are a post-processing step. This means FABRIK cannot natively enforce joint *rotation* limits — only joint *position* constraints. Angular limits are approximated by clamping after the position solve, which can cause the end effector to fall short of the target.

**"More iterations = better result."**
Past convergence (typically 5–10 iterations), additional iterations do nothing — the positions stop changing. The tolerance check exits early. The cost is O(iterations × chainLength) per frame; a 10-bone chain at 10 iterations is 100 distance/normalize operations, cheap.

**"The end effector always reaches the target."**
Not if the target is farther than the total chain length. FABRIK detects this (`dist(root, target) >= totalLength`) and stretches the chain straight toward the target — the closest achievable configuration. The end effector stops short of the target.

**"IK is just for limbs."**
IK is general. Spine IK curves a spine to lean toward a target. Tentacle IK wraps a long chain around geometry. Camera IK rigs keep a character's eyes on a look-at target by treating the eye direction as an end effector.

---

## Common Confusions

**"I set a target but the chain barely moved."**
Check that the IK chain is actually connected: `joint[0]` is the first bone in the chain (closest to root), not the root of the whole skeleton. IK chains are subsets of the skeleton, not the whole thing.

**"The elbow is flipping between solutions each frame."**
The solver is landing on different solution branches between frames because the initial pose (FK) is changing. Add a pole vector to pin the elbow plane — this removes the ambiguity.

**"Joints are going past their physical limits."**
Angle clamping must be applied after each backward pass iteration, not just at the end. Applying it only at the end means the mid-solve positions violated the limits, and the final clamped result will be wrong.

**"FK animation plays but IK override does nothing."**
Check that the IK blend weight is > 0 and that `isActive` is true on the constraint. If the target ID doesn't resolve to a scene node, the constraint silently no-ops.

---

## How Salsa Uses It

**`src/services/managers/scene3d-manager.ts`** — `solveIKChain3D(skeletonId, chainRootJointIndex, targetPos, maxIter, poleVector?)`: collects world-space joint positions from `skeleton.joints`, runs the FABRIK loop, then writes back updated local rotations via `quaternionBetween(bindDir, newDir)` per joint.

**`src/types/armature-3d.ts`** — `IKConstraint` interface: `{ chainRootIndex, endEffectorIndex, targetId, poleVectorId?, blendWeight, isActive }`. Constraints are stored on `SkeletonData` and evaluated each frame before skin matrices are computed.

**`src/renderer/3d/gizmo-renderer.ts`** — `drawIKHandles` renders the end-effector drag sphere and (optionally) a pole vector sphere. `hitTestIKHandle` returns which handle was clicked for the drag controller.

**`src/services/managers/transform-controller-3d.ts`** — drag events on IK handles call `scene3d.solveIKChain3D` with the cursor's world-space ray projected onto the end-effector's constraint plane, then call `scheduleRender()`.

**Solving order:** IK constraints solve before skin matrices upload. The per-frame order is: `evaluateFK()` (apply animation keyframes) → `solveIKConstraints()` (override end-effector joints) → `computeWorldMatrices()` → `uploadSkinMatrices()` → draw.

---

## Related Concepts

- [Skeletal Animation](skeletal-animation.md) — IK poses the skeleton; skinning converts that pose to mesh deformation
- [Quaternion Interpolation](quaternion-interpolation.md) — converting IK position results back to joint rotations requires rotation-between operations; blending FK and IK uses slerp
- [Euler Rotations](euler-rotations.md) — joint local rotations are Euler angles in the scene graph; understanding rotation order matters when extracting angles from the IK result
- [Scene Graphs](scene-graphs.md) — joint chains are scene-graph paths; `worldMatrix` accumulation is what FK actually computes
