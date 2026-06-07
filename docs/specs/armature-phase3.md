# Armature Phase 3 — FK Rotation, IK, Pose Library, Constraints

**Status:** Specification  
**Last Updated:** 2026-06-05

---

## Overview

Phase 3 completes the core animation authoring loop. Phase 1–2 delivered skeleton creation, weight painting, clip authoring, and playback. This phase adds the four remaining pieces needed for a character animator to actually pose and animate a rig entirely within the viewport.

**Items (priority order):**
1. **FK Joint Rotation** — rotate joints in the viewport to pose the character
2. **IK Solver** — drag an end effector and have the chain solve automatically
3. **Pose Library** — save, name, and recall full skeleton poses
4. **Bone Constraints** — look-at, copy-rotation, stretch-to

---

## Armature Tool Mode — Move vs. Rotate

Currently the Armature panel has no tool selector. All viewport interaction targets joint movement (repositioning joint origins in world space). Phase 3 adds a **tool toggle** in the Armature panel header:

```
[ Move ]  [ Rotate ]
```

These are mutually exclusive and control what the selected joint's gizmo does:

| Tool | Gizmo | What it changes |
|------|-------|-----------------|
| **Move** | XYZ arrow axes (existing) | Joint origin position in world space — edits the skeleton structure / bind pose |
| **Rotate** | XYZ arc rings (new) | Joint local rotation — poses the character for animation without moving the joint origin |

Move and Rotate are fundamentally different operations:
- **Move** edits the rest pose. After moving joints, you should rebind the mesh (`bindMeshToSkeleton3D`) for correct deformation.
- **Rotate (FK)** drives the skinned deformation live. It does not change joint positions — it applies a rotation on top of the bind pose and deforms the mesh vertices through the skinning matrix.

Frogmarks API for tool mode:

```ts
shapeManager.setArmatureToolMode3D('move')    // default — XYZ translate gizmo
shapeManager.setArmatureToolMode3D('rotate')  // FK rotate — arc gizmo
shapeManager.getArmatureToolMode3D()          // → 'move' | 'rotate'
```

The `sceneGraphChanged` event fires when the tool mode changes so Frogmarks can update the button state.

---

## Item 1 — FK Joint Rotation

### What it is

Forward Kinematics rotation: the animator rotates a joint around its local X, Y, or Z axis. The rotation propagates down the hierarchy — child joints inherit the parent's rotation through the normal skinning matrix chain. The mesh deforms live as the joint rotates.

This is the primary posing tool. Every animation pose is built from FK rotations before IK is added on top.

### Viewport interaction

When the **Rotate** tool is active and a joint is selected:
- An **arc ring gizmo** appears at the joint's world position — three colored rings (X=red, Y=green, Z=blue), same visual language as the mesh rotate gizmo.
- Dragging a ring rotates the joint around that axis in local space.
- The mesh deforms in real time during the drag.
- On drag release, `sceneGraphChanged` fires.

The arc gizmo reuses the existing `GizmoRenderer` arc geometry + hit test infrastructure, with a new `drawJointRotateGizmo` / `hitTestJointRotateGizmo` pair scoped to a single world position (no multi-mesh centroid).

### Data model

Each joint stores a quaternion rotation:

```ts
joint.localRotation: [x, y, z, w]  // quaternion, default [0, 0, 0, 1]
```

This already exists on `Armature3DJoint`. The skinning matrix is:

```
jointMatrix = parentWorldMatrix × T(localPosition) × R(localRotation) × S(1)
```

`Skeleton3D.updateWorldMatrices()` already walks the hierarchy computing `worldMatrix` per joint. FK rotation is applied by writing `joint.localRotation` and calling `updateWorldMatrices()`.

### Frogmarks API

```ts
// Set a joint's local rotation (quaternion xyzw)
shapeManager.setJointRotation3D(skelId, jointIndex, [qx, qy, qz, qw])

// Get current rotation
shapeManager.getJointRotation3D(skelId, jointIndex) // → [qx, qy, qz, qw]

// Reset a joint to its bind-pose rotation
shapeManager.resetJointRotation3D(skelId, jointIndex)

// Reset all joints to bind pose
shapeManager.resetAllJointRotations3D(skelId)
```

`setJointRotation3D` already exists. `resetJointRotation3D` / `resetAllJointRotations3D` are new.

### Keyframe integration

FK rotations are keyframeable through the existing clip system:

```ts
shapeManager.setClipJointKeyframe3D(clipId, jointIndex, 'rotation', frame, [qx, qy, qz, qw])
```

No new clip API needed — this path already exists. The Armature panel's keyframe editor already handles rotation channel keyframes.

### Panel UX

In the **Selected Joint** section, below the Head XYZ inputs, add:

```
Rotation    X [__] Y [__] Z [__]   [Reset]
```

Displayed as Euler angles (degrees) for readability; converted to quaternion internally. Update on `sceneGraphChanged`.

---

## Item 2 — Inverse Kinematics (IK)

### What it is

IK lets the animator position an end effector (e.g. a hand or foot) and have the joint chain from that bone back to a root solve automatically. Instead of rotating each joint manually (FK), the solver figures out the rotations needed to reach the target.

### Solver choice — FABRIK

Use the **FABRIK** (Forward And Backward Reaching IK) algorithm. It is iterative, handles arbitrary chain lengths, is simple to implement, and produces natural-looking results without requiring matrix inverse kinematics. Converges in 3–10 iterations for typical character chains.

FABRIK operates entirely on joint world positions, not rotations. After solving, joint rotations are extracted from the new position deltas and written back as `localRotation` quaternions so skinning picks them up.

### IK chain setup

The animator marks a joint as an **IK target** and specifies a **chain length** (number of parent joints to include):

```ts
shapeManager.setJointIKTarget3D(skelId, jointIndex, { chainLength: 3 })
shapeManager.clearJointIKTarget3D(skelId, jointIndex)
shapeManager.getJointIKTargets3D(skelId)  // → { jointIndex, chainLength }[]
```

IK target joints get a special handle in the viewport (a small diamond or crosshair) that can be grabbed and dragged. Dragging updates the target world position and re-runs FABRIK each frame.

### IK vs. FK priority

IK and FK coexist. IK solver runs after FK rotations are applied:
1. Apply all FK rotations (`joint.localRotation`)
2. For each IK chain, run FABRIK from the FK-posed positions
3. Write back solved rotations

If the user rotates a joint that is part of an IK chain via FK, the IK solve overrides it. This is standard behavior in DCCs.

### Panel UX additions

In the joint list, IK target joints show a small ⬦ icon. The Selected Joint section gains:

```
IK Chain   Length [__]   [Set IK Target] / [Clear IK]
```

---

## Item 3 — Pose Library

### What it is

A named snapshot of the entire skeleton's current FK rotation state. The animator can capture a pose, name it, and recall it later — useful for building a library of reference poses (T-pose, A-pose, idle, run cycle keyframes, etc.).

### Data model

Poses are stored on the skeleton node:

```ts
skeleton.data.poses: {
  id: string;          // nanoid
  name: string;
  rotations: {
    jointIndex: number;
    rotation: [qx, qy, qz, qw];
  }[];
}[]
```

Serialized in `Skeleton3D.toJSON()` and restored on load. Poses survive project save/load.

### Frogmarks API

```ts
// Capture current pose
const poseId = shapeManager.capturePose3D(skelId, 'T-Pose')

// Apply a saved pose (sets all joint rotations, fires sceneGraphChanged)
shapeManager.applyPose3D(skelId, poseId)

// List poses
shapeManager.getPoses3D(skelId)  // → { id, name }[]

// Rename / delete
shapeManager.renamePose3D(skelId, poseId, 'A-Pose')
shapeManager.deletePose3D(skelId, poseId)
```

### Panel UX

A collapsible **Pose Library** section below Animation Clips:

```
── Pose Library ──
[+ Capture Pose]   name input
Pose list — [Apply] [Rename] [Delete] per row
```

---

## Item 4 — Bone Constraints

### What it is

Constraints are rules applied to joints automatically each frame, driving their rotation or position based on other joints or targets. They run after FK and IK in the evaluation stack.

### Supported constraints (Phase 3 scope)

| Constraint | Effect |
|------------|--------|
| **Look At** | Rotates the joint so its +Y (or chosen axis) points toward a target world position or another joint |
| **Copy Rotation** | Mirrors another joint's FK rotation (useful for symmetric rigs) |
| **Stretch To** | Scales the bone length to reach a target, with squash-and-stretch volume preservation |

### Data model

Constraints are stored per joint on the skeleton:

```ts
joint.constraints: JointConstraint[]

type JointConstraint =
  | { type: 'lookAt';        targetJoint: number; axis: 'x'|'y'|'z' }
  | { type: 'copyRotation';  sourceJoint: number; influence: number }
  | { type: 'stretchTo';     targetJoint: number; volumePreserve: number }
```

### Frogmarks API

```ts
shapeManager.addJointConstraint3D(skelId, jointIndex, constraint)
shapeManager.removeJointConstraint3D(skelId, jointIndex, constraintIndex)
shapeManager.getJointConstraints3D(skelId, jointIndex)  // → JointConstraint[]
```

### Panel UX

In the Selected Joint section, a collapsible **Constraints** sub-panel:

```
── Constraints ──
[+ Add Constraint]  dropdown: Look At / Copy Rotation / Stretch To
Constraint list — type + params + [Remove] per row
```

---

## Evaluation Order

The full per-frame joint evaluation stack, once all four items are implemented:

```
1. Apply FK rotations (joint.localRotation) — set by animator or clip playback
2. Run IK solver (FABRIK) for each IK chain — overwrites FK rotations in chain
3. Apply constraints (lookAt, copyRotation, stretchTo)
4. Skeleton3D.updateWorldMatrices() — compute final worldMatrix per joint
5. Upload skinMatrices to GPU — mesh deforms
```

---

## Implementation Order

1. **FK Rotation** — arc gizmo in `GizmoRenderer`, `hitTestJointRotateGizmo`, drag handling in `Scene3DManager`, `resetJointRotation3D` / `resetAllJointRotations3D` on `ShapeManager`, Euler display in Frogmarks panel.
2. **IK** — FABRIK solver utility, IK target data model, viewport handle, evaluation step in `Skeleton3D.updateWorldMatrices`.
3. **Pose Library** — data model on `Skeleton3D`, capture/apply/list/delete API, panel section.
4. **Constraints** — constraint data model, evaluation step, panel sub-panel.
