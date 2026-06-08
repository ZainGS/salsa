# Bone Constraints — Implementation Spec

**Status:** Ready to implement  
**Last Updated:** 2026-06-07  
**Prerequisite:** FK Rotation (done), IK solver (done)

---

## What it is

Per-joint rules that automatically drive a joint's rotation or scale each frame based on other joints or targets. Constraints run as a third evaluation step — after FK rotations and after the IK solve — so they always see the final IK-corrected pose.

**Phase 3 scope: three constraint types**

| Type | What it does |
|------|-------------|
| `lookAt` | Rotates the joint so a chosen local axis points toward a target joint or world position |
| `copyRotation` | Copies another joint's final rotation, blended by an influence weight |
| `stretchTo` | Scales the joint's bone length to reach a target joint, with optional volume preservation |

---

## Evaluation order (full per-frame stack)

```
1. FK:          Apply joint.localRotation
2. IK:          FABRIK solve → write joint.ikRotation
3. Constraints: lookAt / copyRotation / stretchTo
4. Finalize:    skeleton.updateWorldMatrices() → skinMatrices → GPU upload
```

Constraints read **post-IK world matrices** (call `updateWorldMatrices` once after IK, then run constraints on the result, then call `updateWorldMatrices` one final time). This means constraints see the fully IK-solved pose, not the raw FK pose.

---

## Data model

### `src/types/armature-3d.ts`

```typescript
export type JointConstraint =
    | { type: 'lookAt';       targetJointIdx: number; axis: 'x' | 'y' | 'z'; influence: number }
    | { type: 'copyRotation'; sourceJointIdx: number; influence: number }
    | { type: 'stretchTo';    targetJointIdx: number; influence: number; volumePreserve: number };

// Add to Joint3D:
export interface Joint3D {
    // ...existing fields...
    constraints?: JointConstraint[];
}
```

`targetJointIdx` / `sourceJointIdx` are indices into `skeleton.data.joints[]`. They are validated at solve time — if an index is out of range the constraint is silently skipped.

Constraints are serialized as part of the joint in `Skeleton3D.toJSON()` and restored in `fromJSON`. They are durable (survive save/load), unlike `ikRotation` which is ephemeral.

---

## Constraint math

### `lookAt`

Rotates joint `j` so that its local axis `axis` (in local space) points toward `target` (world position).

```
targetWorldPos = joints[constraint.targetJointIdx].worldMatrix.translation
jointWorldPos  = j.worldMatrix.translation
parentWorldRot = parent?.worldMatrix.rotation ?? identity

dir = normalize(targetWorldPos - jointWorldPos)

// Map the desired direction into the joint's local space:
localDir = quatRotate(quatInverse(parentWorldRot), dir)

// Build a rotation that aligns the chosen local axis with localDir:
localAxis = {x:[1,0,0], y:[0,1,0], z:[0,0,1]}[constraint.axis]
deltaRot  = quatBetweenVectors(localAxis, normalize(localDir))

// Blend with the pre-constraint rotation (influence 0 = no effect, 1 = full):
j.constraintRotation = slerp(j.localRotation, quatMul(j.localRotation, deltaRot), influence)
```

After writing `j.constraintRotation`, recompute this joint's `worldMatrix` inline before evaluating the next constraint (same pattern as the IK inline update).

### `copyRotation`

Copies `source.localRotation` and blends it with the joint's own pre-constraint rotation:

```
sourceRot = joints[constraint.sourceJointIdx].localRotation
j.constraintRotation = slerp(j.localRotation, sourceRot, influence)
```

Simple — no spatial math needed.

### `stretchTo`

Scales `j.localScale` along its primary bone axis so the tail reaches the target:

```
targetWorldPos = joints[constraint.targetJointIdx].worldMatrix.translation
jointWorldPos  = j.worldMatrix.translation
currentLen     = length(targetWorldPos - jointWorldPos)
restLen        = length(j.tailOffset ?? [0, j.boneLength ?? 1, 0])  // bind-pose bone length

stretchFactor = currentLen / max(restLen, 0.0001)

// Volume preservation: scale perp axes inversely so volume is constant:
perpScale = volumePreserve > 0
    ? lerp(1.0, 1.0 / sqrt(stretchFactor), volumePreserve)
    : 1.0

// Blend with current scale:
targetScale = [perpScale, stretchFactor, perpScale]  // Y = primary bone axis
j.constraintScale = lerp(j.localScale, targetScale, influence)
```

`constraintScale` is analogous to `constraintRotation` — ephemeral per-frame, not serialized.

---

## `Joint3D` ephemeral fields

Add alongside `ikRotation`:

```typescript
export interface Joint3D {
    // ...existing fields...
    ikRotation?:         [number, number, number, number];  // already exists
    constraintRotation?: [number, number, number, number];  // set by lookAt / copyRotation
    constraintScale?:    [number, number, number];          // set by stretchTo
}
```

In `updateWorldMatrices`, use these when present:

```typescript
const rot   = j.constraintRotation ?? j.ikRotation ?? j.localRotation;
const scale = j.constraintScale    ?? j.localScale;
mat4.fromRotationTranslationScale(local, rot, j.localPosition, scale);
```

Neither `constraintRotation` nor `constraintScale` is serialized.

---

## New file: `src/renderer/3d/constraint-solver.ts`

Pure utility, no GPU code, no scene state.

```typescript
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { quatBetweenVectors, slerp } from './math-utils'; // existing helpers

/**
 * Evaluate all joint constraints on the skeleton.
 * Caller must have already run IK and called updateWorldMatrices() once
 * before calling this. After this returns, caller calls updateWorldMatrices()
 * one final time to propagate constraint rotations through the hierarchy.
 */
export function solveAllConstraints(skeleton: Skeleton3D): void {
    const joints = skeleton.data.joints;
    for (const joint of joints) {
        if (!joint.constraints?.length) continue;
        for (const c of joint.constraints) {
            switch (c.type) {
                case 'lookAt':      applyLookAt(joint, joints, c);       break;
                case 'copyRotation': applyCopyRotation(joint, joints, c); break;
                case 'stretchTo':   applyStretchTo(joint, joints, c);    break;
            }
            // Inline world matrix update after each constraint so subsequent
            // constraints on this same joint see the updated orientation.
            recomputeWorldMatrixInline(joint, joints);
        }
    }
}

function applyLookAt(joint, joints, c): void { ... }
function applyCopyRotation(joint, joints, c): void { ... }
function applyStretchTo(joint, joints, c): void { ... }

/** Recompute worldMatrix for one joint using its parent's current worldMatrix. */
function recomputeWorldMatrixInline(joint, joints): void {
    const rot   = joint.constraintRotation ?? joint.ikRotation ?? joint.localRotation;
    const scale = joint.constraintScale    ?? joint.localScale;
    // mat4 compose + multiply by parent worldMatrix
    ...
}

/** Clear ephemeral constraint state (call when constraints change or are removed). */
export function clearAllConstraintState(skeleton: Skeleton3D): void {
    for (const j of skeleton.data.joints) {
        j.constraintRotation = undefined;
        j.constraintScale    = undefined;
    }
}
```

---

## `Skeleton3D` changes

**File:** `src/scene-graph/shapes/skeleton-3d.ts`

### `updateWorldMatrices`

Change the rotation/scale source lines to use constraint overrides (if present):

```typescript
const rot   = j.constraintRotation ?? j.ikRotation ?? j.localRotation;
const scale = j.constraintScale    ?? j.localScale ?? [1, 1, 1];
mat4.fromRotationTranslationScale(local, rot, j.localPosition, scale);
```

### `toJSON` / `fromJSON`

Serialize `constraints` as part of each joint:

```typescript
// toJSON:
joints: this.data.joints.map(j => ({
    ...existingJointFields,
    constraints: j.constraints ?? [],
}))

// fromJSON:
j.constraints = raw.constraints ?? [];
```

---

## Pre-render callback update

**File:** `src/services/managers/scene3d-manager.ts`

Extend the IK solve callback to include constraints:

```typescript
private _solveCallback = () => {
    const skel = this._getActiveSkeleton();
    if (!skel) return false;

    const hasIK          = skel.data.ikChains?.some(c => c.enabled);
    const hasConstraints = skel.data.joints.some(j => j.constraints?.length);

    if (!hasIK && !hasConstraints) return false;

    // Step 1: FK world matrices
    skel.updateWorldMatrices();

    // Step 2: IK solve
    if (hasIK) solveAllIKChains(skel);

    // Step 3: Post-IK world matrices (constraints need to see IK results)
    if (hasConstraints) {
        skel.updateWorldMatrices();
        solveAllConstraints(skel);
    }

    // Step 4: Final world matrices with constraint overrides
    skel.updateWorldMatrices();
    skel.matricesDirty = true;

    return false;
};
```

When no IK and no constraints are active the callback returns immediately — zero cost.

---

## `Scene3DManager` — public API

```typescript
addJointConstraint(skelId: string, jointIndex: number, constraint: JointConstraint): number {
    const joint = this.getJoint(skelId, jointIndex);
    if (!joint) return -1;
    if (!joint.constraints) joint.constraints = [];
    joint.constraints.push(constraint);
    clearAllConstraintState(this.getSkeleton(skelId)!);
    this.ctx.sceneGraphChanged();
    return joint.constraints.length - 1;
}

removeJointConstraint(skelId: string, jointIndex: number, constraintIndex: number): void {
    const joint = this.getJoint(skelId, jointIndex);
    if (!joint?.constraints) return;
    joint.constraints.splice(constraintIndex, 1);
    clearAllConstraintState(this.getSkeleton(skelId)!);
    this.ctx.sceneGraphChanged();
}

getJointConstraints(skelId: string, jointIndex: number): JointConstraint[] {
    return this.getJoint(skelId, jointIndex)?.constraints ?? [];
}
```

---

## `ShapeManager` surface

**File:** `src/services/shape-manager.ts`

```typescript
/** Add a constraint to a joint. Returns the constraint index. */
public addJointConstraint3D(
    skelId: string,
    jointIndex: number,
    constraint: JointConstraint,
): number {
    return this.scene3d.addJointConstraint(skelId, jointIndex, constraint);
}

public removeJointConstraint3D(skelId: string, jointIndex: number, constraintIndex: number): void {
    this.scene3d.removeJointConstraint(skelId, jointIndex, constraintIndex);
}

public getJointConstraints3D(skelId: string, jointIndex: number): JointConstraint[] {
    return this.scene3d.getJointConstraints(skelId, jointIndex);
}
```

---

## Frogmarks panel UX

Collapsible **Constraints** sub-panel inside Selected Joint section:

```
── Constraints ──────────────────────
  [+ Add]  [Look At ▾]

  Look At → joint_3  axis Y  inf [1.0]  [🗑]
  Copy Rot ← joint_5  inf [0.6]          [🗑]
```

### API calls

```typescript
// Add Look At:
sm.addJointConstraint3D(skelId, jointIndex, {
    type: 'lookAt',
    targetJointIdx: selectedTargetIdx,
    axis: 'y',
    influence: 1.0,
});

// Add Copy Rotation:
sm.addJointConstraint3D(skelId, jointIndex, {
    type: 'copyRotation',
    sourceJointIdx: selectedSourceIdx,
    influence: 0.6,
});

// Add Stretch To:
sm.addJointConstraint3D(skelId, jointIndex, {
    type: 'stretchTo',
    targetJointIdx: selectedTargetIdx,
    influence: 1.0,
    volumePreserve: 0.5,
});

// Remove:
sm.removeJointConstraint3D(skelId, jointIndex, constraintIndex);

// Refresh on sceneGraphChanged:
const constraints = sm.getJointConstraints3D(skelId, jointIndex);
```

Refresh the constraints list any time the selected joint changes or `sceneGraphChanged` fires.

---

## Implementation order

1. `src/types/armature-3d.ts` — add `JointConstraint` type; add `constraints?` and ephemeral fields to `Joint3D`
2. `src/scene-graph/shapes/skeleton-3d.ts` — use `constraintRotation`/`constraintScale` in `updateWorldMatrices`; serialize/deserialize `constraints` per joint
3. `src/renderer/3d/constraint-solver.ts` — new file: `solveAllConstraints`, `clearAllConstraintState`, the three `apply*` functions
4. `src/services/managers/scene3d-manager.ts` — extend `_solveCallback` to call `solveAllConstraints`; add 3 public methods
5. `src/services/shape-manager.ts` — expose 3 public methods
6. Frogmarks — add Constraints sub-panel in Selected Joint section

Estimated scope: ~200 lines of code across 4 files + 1 new file.
