# Armature IK — Inverse Kinematics Implementation Spec

**Status:** Specification  
**Last Updated:** 2026-06-05  
**Prerequisite:** FK Rotation (done)

---

## Goal

Drag an end-effector handle in the viewport and have the joint chain automatically
solve to reach it. The mesh deforms live as the target moves.

---

## Algorithm — FABRIK

**FABRIK** (Forward And Backward Reaching IK) is an iterative, position-based solver.
It preserves exact bone lengths, handles arbitrary chain lengths, requires no matrix
inversions, and converges in 3–10 iterations for typical character chains.

### Core loop (pseudocode)

```
inputs:
  positions[0..n]   — world-space joint positions; 0 = chain root (fixed), n = end effector
  boneLengths[0..n-1] — distance from joint i to joint i+1 (constant; measured at bind time)
  target            — desired world-space position of end effector
  maxIterations = 10
  tolerance = 0.001

// Unreachable target: stretch the chain straight toward it
totalLen = sum(boneLengths)
if dist(positions[0], target) >= totalLen:
    dir = normalize(target - positions[0])
    for i in 0..n-1:
        positions[i+1] = positions[i] + dir * boneLengths[i]
    return

for iter in 0..maxIterations:
    if dist(positions[n], target) < tolerance: break

    // Forward pass — pull end to target, drag each joint toward it
    positions[n] = target
    for i in (n-1) down to 0:
        r      = length(positions[i] - positions[i+1])
        lambda = boneLengths[i] / r
        positions[i] = lerp(positions[i+1], positions[i], lambda)

    // Backward pass — pin root, push toward end
    positions[0] = rootPos  // restore fixed root
    for i in 0 to (n-1):
        r      = length(positions[i+1] - positions[i])
        lambda = boneLengths[i] / r
        positions[i+1] = lerp(positions[i], positions[i+1], lambda)
```

`lerp(A, B, t) = A + (B − A) * t`. The `lambda = boneLen / dist` ratio places the new
point exactly `boneLen` world units from its neighbor along the current direction,
preserving bone length exactly.

---

## Position → Rotation Conversion

FABRIK outputs new world-space positions. We need to write those back as
`joint.localRotation` quaternions so the skinning system picks them up.

For each joint i in the chain from root toward end (i = 0 to chainLength − 1):

```
origDir = normalize(origWorldPos[i+1] - origWorldPos[i])   // FK-posed direction
newDir  = normalize(newWorldPos[i+1]  - newWorldPos[i])    // FABRIK output direction

deltaRot    = quatBetweenVectors(origDir, newDir)           // minimal-arc rotation
newWorldRot = quatMul(deltaRot, worldRot(joint.worldMatrix))

parentWorldRot = joint.parentIndex >= 0
    ? worldRot(joints[joint.parentIndex].worldMatrix)
    : [0,0,0,1]

joint.ikRotation = quatMul(quatInverse(parentWorldRot), newWorldRot)
```

After updating joint i, **recompute joint i's worldMatrix inline** before moving to
joint i+1 — otherwise joint i+1's parent rotation would be stale. The per-joint
update is just `fromRotationTranslationScale(ikRot || localRot, localPos, [1,1,1])`
multiplied by the parent worldMatrix.

### `quatBetweenVectors(a, b)` — the one non-trivial math piece

```typescript
function quatBetweenVectors(a: vec3, b: vec3): quat {
    const dot = vec3.dot(a, b);
    if (dot >= 0.9999)  return [0, 0, 0, 1];    // parallel — identity
    if (dot <= -0.9999) {                         // anti-parallel — 180° around perp axis
        let perp = vec3.cross([0,0,0], a, [1,0,0]);
        if (vec3.length(perp) < 0.001) perp = vec3.cross([0,0,0], a, [0,1,0]);
        vec3.normalize(perp, perp);
        return [perp[0], perp[1], perp[2], 0];
    }
    const axis = vec3.cross([0,0,0], a, b);
    return vec3.normalize([...axis, 1 + dot], []);  // not normalized yet — caller normalizes
    // Correct form: [axis.x, axis.y, axis.z, 1 + dot], then normalize to unit quat
}
```

---

## Data Model

### New: `IKChain` in `src/types/armature-3d.ts`

```typescript
export interface IKChain {
    /** Stable nanoid. */
    id: string;
    /** Index of the end-effector joint (e.g. hand, foot). */
    endJointIdx: number;
    /**
     * Number of bones to include in the chain.
     * chainLength=3 means: end → parent → grandparent → (fixed anchor = great-grandparent).
     * The anchor joint is NOT modified by the solver.
     */
    chainLength: number;
    /** Current IK target world position — dragged by the user. */
    target: [number, number, number];
    /** When false, solver skips this chain and joint rotations fall back to FK. */
    enabled: boolean;
}
```

Add to `SkeletonData`:
```typescript
export interface SkeletonData {
    // ...existing fields...
    ikChains?: IKChain[];
}
```

### New field on `Joint3D`

```typescript
export interface Joint3D {
    // ...existing fields...
    /**
     * IK-solved local rotation for this frame.
     * Set by the FABRIK solver each frame for joints that are in an active IK chain.
     * computeWorldMatrices() uses this INSTEAD OF localRotation when present.
     * Cleared (set to undefined) when the chain is disabled or removed.
     */
    ikRotation?: [number, number, number, number];
}
```

`ikRotation` intentionally does NOT get serialized — it is ephemeral per-frame state.
`localRotation` remains the durable FK rotation.

---

## Evaluation Order (per frame)

```
1. User FK drags / clip playback → writes joint.localRotation
2. [IK solve step, in pre-render callback in Scene3DManager]:
       for each skeleton with enabled IK chains:
           a. computeWorldMatrices() using current localRotation → FK world positions
           b. for each IK chain (ordered by chain index):
                  run FABRIK → get new world positions
                  convert positions → ikRotation for chain joints (inline worldMatrix update)
           c. computeWorldMatrices() — now uses ikRotation where set → final world positions
3. Renderer reads skeleton.skinMatrices → uploads to GPU → mesh deforms
```

`computeWorldMatrices()` is called twice when IK is active: once to get FK world
positions as FABRIK input, and once after the solve to produce the final skinMatrices.
This is O(2n) joints per skeleton per frame — negligible.

When NO IK chains are enabled, the solve step is skipped entirely (zero cost).

---

## `computeWorldMatrices` Modification

Change one line in `skeleton-3d.ts`:

```typescript
// Before:
mat4.fromRotationTranslationScale(local, j.localRotation, j.localPosition, j.localScale);

// After:
const rot = j.ikRotation ?? j.localRotation;
mat4.fromRotationTranslationScale(local, rot, j.localPosition, j.localScale);
```

No other changes to the existing matrix computation path.

---

## New File: `src/renderer/3d/ik-solver.ts`

A pure utility module — no GPU code, no scene state.

```typescript
export interface IKSolveInput {
    positions: [number,number,number][];  // length = chainLength + 1 (root first)
    boneLengths: number[];                // length = chainLength
    target: [number,number,number];
    maxIterations?: number;               // default 10
    tolerance?: number;                   // default 0.001
}

/** Runs FABRIK in-place on the positions array. Returns final end-effector distance to target. */
export function solveFabrik(input: IKSolveInput): number { ... }

/**
 * Full IK chain solve for one IKChain on one skeleton.
 * Reads FK world positions from joint.worldMatrix, runs FABRIK,
 * writes joint.ikRotation for each chain joint (and updates worldMatrix inline).
 * Does NOT call skeleton.computeWorldMatrices() — the caller does that.
 */
export function solveIKChain(skeleton: Skeleton3D, chain: IKChain): void { ... }

/** Runs solveIKChain for every enabled IKChain on the skeleton. */
export function solveAllIKChains(skeleton: Skeleton3D): void { ... }

/** Clears ikRotation from all joints (call when IK is disabled globally or chains removed). */
export function clearAllIKRotations(skeleton: Skeleton3D): void { ... }
```

### `solveIKChain` steps (detailed)

```
1. Walk up from endJointIdx by chainLength hops to find the anchor joint index.
   If the chain runs past the skeleton root, clamp at root (chainLength shortens).

2. Collect chain joint indices: [anchorIdx, ...intermediates, endIdx]
   (root-first order — same as traversal order)

3. Extract world positions: pos[i] = [worldMatrix[12], worldMatrix[13], worldMatrix[14]]

4. Compute boneLengths[i] = dist(pos[i], pos[i+1])
   (measured from CURRENT FK pose — keeps lengths consistent with where joints actually are)

5. Run solveFabrik({ positions: pos, boneLengths, target: chain.target })

6. Convert new positions → ikRotation for each non-anchor joint (index 1..chainLength):
       for k in 1..chainLength:
           jointIdx = chainJoints[k]
           joint    = skeleton.data.joints[jointIdx]
           origDir  = normalize(origPos[k+1] - origPos[k])   // before FABRIK
           newDir   = normalize(newPos[k+1]  - newPos[k])    // after FABRIK
           delta    = quatBetweenVectors(origDir, newDir)
           curWorldRot  = extractQuat(joint.worldMatrix)
           newWorldRot  = quatMul(delta, curWorldRot)
           parentWorldRot = joint.parentIndex >= 0
               ? extractQuat(joints[joint.parentIndex].worldMatrix)
               : [0,0,0,1]
           joint.ikRotation = quatMul(quatInverse(parentWorldRot), newWorldRot)
           // Inline world matrix update for this joint so next iteration is correct:
           recomputeWorldMatrix(joint, joints)
```

`extractQuat(mat4)` — extract the rotation quaternion from a column-major mat4 by
normalising the upper 3×3 columns and converting to quaternion via standard formula.
`gl-matrix` provides `mat4.getRotation(quat, mat)` which does exactly this.

---

## Viewport Interaction

### IK Target Handle

Each IK chain's end-effector position (`chain.target`) is shown as a distinct handle
in the viewport. Visual design:

- **Shape:** small sphere + two crossed rings (a simple "target crosshair")
- **Color (idle):** gold/amber `[1.0, 0.78, 0.1, 1.0]` — visually distinct from joint blue/orange
- **Color (hovered):** bright yellow `[1.0, 1.0, 0.2, 1.0]`
- **Color (dragging):** white `[1.0, 1.0, 1.0, 1.0]`
- **Size:** similar to joint sphere but slightly larger
- **Depth:** rendered with `depthCompare: 'always'` (always on top, same as bone overlay)

Only shown when the bone overlay is active (`_boneOverlayExplicit = true`) and the
skeleton has at least one enabled IK chain.

### In `GizmoRenderer`

```typescript
drawIKTargets(
    pass: GPURenderPassEncoder,
    chains: IKChain[],
    skeleton: Skeleton3D,
    camera: Camera3D,
    hoveredChainId: string | null,
    draggingChainId: string | null,
): void

hitTestIKTargets(
    rayOrigin: vec3,
    rayDir: vec3,
    chains: IKChain[],
    camera: Camera3D,
): string | null  // returns chain.id of the nearest hit, or null
```

`drawIKTargets` reuses the existing gizmo sphere geometry (already used for joint
spheres). The crosshair rings can reuse the arc ring geometry from the rotate gizmo,
scaled to the same size as the sphere.

Hit test: ray-sphere intersection per chain target, same formula as `hitTestJoint`.
Hit radius = 1.8× visual radius for comfortable picking (same as joint spheres).

### In `Renderer3D`

Add a call in `drawBoneOverlayIfActive`, after the bone overlay draw:

```typescript
if (this._ikSkeleton) {
    const chains = this._ikSkeleton.data.ikChains?.filter(c => c.enabled) ?? [];
    if (chains.length > 0) {
        this._gizmoRenderer.drawIKTargets(
            pass, chains, this._ikSkeleton, this.camera,
            this._hoveredIKChainId, this._draggingIKChainId,
        );
    }
}
```

Add setters: `setHoveredIKChainId(id: string | null)`, `setDraggingIKChainId(id: string | null)`.

### In `Scene3DManager` — drag interaction

New state fields:
```typescript
private _hoveredIKChainId: string | null = null;
private _draggingIKChainId: string | null = null;
private _ikDragPlaneNormal: vec3 = vec3.create();
private _ikDragOffset: vec3 = vec3.create();
```

**`onMouseMove`:** before joint hover test, ray-test IK target handles.
If a chain is hovered, set `_hoveredIKChainId` and update renderer.

**`onMouseDown`:** if `_hoveredIKChainId !== null`, start IK drag:
- Set `_draggingIKChainId`
- Build camera-facing drag plane at `chain.target`
- Disable orbit controller
- `e.stopPropagation()`

**During drag (`onMouseMove` with drag active):**
- Intersect ray with drag plane → new world position
- Update `chain.target = newWorldPos`
- The pre-render callback (next frame) picks up the new target and re-solves

**`onMouseUp`:** clear drag state, re-enable orbit controller, emit `sceneGraphChanged`.

### Pre-render callback for IK solve

The existing orbit update callback in `enableOrbitControls` already fires each frame.
Add IK solving alongside it, or register a separate pre-render callback:

```typescript
// Called once per frame, before renderer reads skinMatrices
private _ikSolveCallback = () => {
    const skel = this._boneOverlayExplicit
        ? this.getSkeleton(this._boneOverlaySkeletonId ?? '')
        : null;
    if (!skel) return false;
    const chains = skel.data.ikChains;
    if (!chains || chains.every(c => !c.enabled)) return false;

    // FK pass: compute world matrices from localRotation
    skel.computeWorldMatrices();

    // IK solve: writes ikRotation on chain joints, updates worldMatrix inline
    solveAllIKChains(skel);

    // Final pass: propagate ikRotation through full hierarchy
    skel.computeWorldMatrices();
    return false; // don't self-schedule
};
```

Register in `enableOrbitControls` (alongside the orbit callback), and clean up in
`disableOrbitControls`.

---

## Public API

### `scene3d-manager.ts` (new public methods)

```typescript
// Add an IK chain — returns the new chain's id
addIKChain(skelId: string, endJointIdx: number, chainLength: number): string

// Remove by chain id
removeIKChain(skelId: string, chainId: string): void

// List all chains
getIKChains(skelId: string): IKChain[]

// Move the IK target programmatically (e.g. from panel XYZ inputs)
setIKTarget(skelId: string, chainId: string, x: number, y: number, z: number): void

// Enable / disable a chain (disabling clears ikRotation → FK fallback)
setIKChainEnabled(skelId: string, chainId: string, enabled: boolean): void

// Change chain length after creation
setIKChainLength(skelId: string, chainId: string, chainLength: number): void
```

### `shape-manager.ts` surface

```typescript
shapeManager.addIKChain3D(skelId, endJointIdx, chainLength)   → string (chainId)
shapeManager.removeIKChain3D(skelId, chainId)
shapeManager.getIKChains3D(skelId)                             → IKChain[]
shapeManager.setIKTarget3D(skelId, chainId, x, y, z)
shapeManager.setIKChainEnabled3D(skelId, chainId, enabled)
shapeManager.setIKChainLength3D(skelId, chainId, chainLength)
```

---

## Serialization

`IKChain[]` is stored in `skeleton.data.ikChains` and serialized in `Skeleton3D.toJSON()`:

```typescript
toJSON() {
    return {
        // ...existing fields...
        ikChains: this.data.ikChains ?? [],
    };
}
```

Deserialized in `fromJSON` / `fromData`. `joint.ikRotation` is NOT serialized — it is
recomputed each frame.

---

## Frogmarks Panel UX

### Joint List — IK indicators

Joints that are the **end-effector of an IK chain** show a small gold `IK` badge
next to their name in the joint list. Joints that are **intermediate members** of a
chain (between end and anchor) show a subtle tint or no badge — they are implicitly
included. The **anchor joint** (chain root, not modified by solver) has no indicator.

```
Joint List rows:
  0  joint_0           [↗] [×]     ← normal joint
  1  joint_1           [↗] [×]
  2  joint_2  ◆IK      [↗] [×]     ← end-effector of an IK chain (gold ◆ badge)
  3  joint_3           [↗] [×]
```

Clicking any row still selects that joint normally. The `◆IK` badge is display-only.

---

### Selected Joint — Full State Machine

The Selected Joint section changes based on:
- Whether a joint is selected at all
- Which tool mode is active (Move / Rotate)
- Whether the selected joint is an IK end-effector

```
┌─────────────────────────────────────────────────────────────┐
│  Selected Joint: joint_2                                     │
│                                                             │
│  [Rename]                         [Delete]                  │
│                                                             │
│  ── (Move mode) ─────────────────────────────────────────── │
│  Head  X [0.00]  Y [1.20]  Z [0.00]                        │
│  Tail  X [0.00]  Y [0.30]  Z [0.00]   (leaf only)          │
│                                                             │
│  ── (Rotate mode) ───────────────────────────────────────── │
│  Rot   X [0°]    Y [45°]   Z [0°]    [Reset]               │
│                                       [Reset All]           │
│                                                             │
│  ── IK ──────────────────────────────────────────────────── │
│                                                             │
│  [case A — no IK chain on this joint]                       │
│  [+ Set as IK Target]                                       │
│                                                             │
│  [case B — this joint IS the IK end-effector]               │
│  Chain Length  [3]  ← spinner; min 1, max (depth of joint)  │
│  Target  X [0.00]  Y [1.50]  Z [0.00]   (read-only during drag, editable otherwise)
│  [ ✓ Enabled ]  ← toggle                                    │
│  [Remove IK]                                                │
└─────────────────────────────────────────────────────────────┘
```

**Case A** (`getIKChains3D(skelId)` has no chain with `endJointIdx === selectedIdx`):
- Show only `[+ Set as IK Target]` — calls `addIKChain3D(skelId, idx, 3)` with default
  chain length of 3.

**Case B** (selected joint IS an end-effector):
- Show chain configuration controls.
- **Chain Length** spinner: 1 = only this joint bends; max = number of ancestors up to
  root. On change: `setIKChainLength3D(skelId, chainId, n)`.
- **Target XYZ** inputs: display `chain.target`. Editable when not dragging — call
  `setIKTarget3D(skelId, chainId, x, y, z)`. During viewport drag, these update live
  (read from `getIKChains3D` on `sceneGraphChanged`) but are read-only (disable inputs).
- **Enabled toggle**: calls `setIKChainEnabled3D`. When disabled, the gold handle
  disappears from the viewport and the chain falls back to FK.
- **Remove IK**: calls `removeIKChain3D`, clears `ikRotation` on chain joints.

**What if the selected joint is an intermediate chain member (not the end-effector)?**
Show nothing in the IK section — only the end-effector joint owns the chain controls.
Intermediate joints are read-only participants. This keeps the UI simple.

---

### Full Updated Panel Layout

```
Armature Panel
├── ── Skeletons ──
│   ├── Dropdown + [+ New Skeleton]
│
├── ── Joints — <Skeleton Name> ──
│   ├── Tool: [ Move ] [ Rotate ]
│   │
│   ├── [+ Add Bone]  [Extrude]
│   │
│   ├── Joint List
│   │   └── each row: index • name • ◆IK? • [↗] [×]
│   │       click row → selectJoint3D(index)
│   │
│   └── Selected Joint
│       ├── [Rename]                          [Delete]
│       │
│       ├── ── Move mode ──
│       ├── Head XYZ  → moveBone3D
│       ├── Tail XYZ  → setJointTailOffset3D   (leaf only)
│       │
│       ├── ── Rotate mode ──
│       ├── Rot X/Y/Z°  → setJointRotation3D
│       ├── [Reset Rotation]  [Reset All Pose]
│       │
│       └── ── IK ──
│           ├── [+ Set as IK Target]           (case A — no chain on this joint)
│           │
│           └── (case B — this joint is IK end-effector)
│               ├── Chain Length [n]           → setIKChainLength3D
│               ├── Target X [__] Y [__] Z [__] → setIKTarget3D
│               ├── [ ✓ Enabled ]              → setIKChainEnabled3D
│               └── [Remove IK]               → removeIKChain3D
│
├── ── Bind Mesh ──
│   └── ...existing...
│
├── ── Weight Paint ──
│   └── ...existing...
│
└── ── Animation Clips / Retarget ──
    └── ...existing...
```

---

### Viewport Visual Summary

| Element | Shape | Color (idle) | Color (hover) | Color (drag) |
|---------|-------|--------------|---------------|--------------|
| IK target handle | sphere + crosshair rings | gold `[1.0, 0.78, 0.1]` | bright yellow `[1.0, 1.0, 0.2]` | white `[1.0, 1.0, 1.0]` |
| Chain joints (intermediate) | normal bone diamonds | standard blue | standard | standard |
| Chain end-effector joint | sphere (larger) | teal (same as selected joint) | — | — |
| Chain anchor joint | sphere | standard | standard | standard |

The IK target handle is drawn **at `chain.target`** — which starts at the end-effector's
world position but drifts as the user drags it. The end-effector joint sphere stays at
its **current solved position** (which tries to track the target). When the target is
unreachable, the joint sphere is as close as the chain can stretch; the gold target
handle continues to the actual target position.

This visual separation (joint sphere ≠ target handle) makes it clear to the user that
the handle is the goal and the joint is the result.

`sceneGraphChanged` fires on all IK mutations — re-call `getIKChains3D(skelId)` to
refresh the panel state.

---

## Implementation Plan (files in order)

### Step 1 — Data model
- `src/types/armature-3d.ts`: add `IKChain` interface, `SkeletonData.ikChains`, `Joint3D.ikRotation`

### Step 2 — computeWorldMatrices modification
- `src/scene-graph/shapes/skeleton-3d.ts`:
  - Use `j.ikRotation ?? j.localRotation` in `computeWorldMatrices()`
  - Add `clearIKRotations(): void` helper
  - Serialize/deserialize `ikChains` in `toJSON`/`fromJSON`

### Step 3 — FABRIK solver
- `src/renderer/3d/ik-solver.ts` (new file):
  - `solveFabrik`, `solveIKChain`, `solveAllIKChains`, `clearAllIKRotations`
  - Pure math, no imports from scene graph

### Step 4 — GizmoRenderer handles
- `src/renderer/3d/gizmo-renderer.ts`:
  - `drawIKTargets`, `hitTestIKTargets`
  - Reuse existing sphere geometry + arc ring geometry

### Step 5 — Renderer3D integration
- `src/renderer/3d/renderer-3d.ts`:
  - `_hoveredIKChainId`, `_draggingIKChainId` state + setters
  - Call `drawIKTargets` in `drawBoneOverlayIfActive`

### Step 6 — Scene3DManager interaction + solve
- `src/services/managers/scene3d-manager.ts`:
  - IK drag state fields
  - Pre-render IK solve callback
  - `onMouseMove` / `onMouseDown` / `onMouseUp` additions
  - Public API methods

### Step 7 — ShapeManager surface
- `src/services/shape-manager.ts`: expose all public IK APIs

---

## Out of Scope (Phase 1)

- **Pole vector constraints** — a third handle that controls the plane of rotation
  (e.g., knee bend direction). Implement after basic IK is proven.
- **FK/IK blend weight** — blend between FK rotation and IK rotation per chain (0=FK, 1=IK).
  Phase 1 is always IK-dominant for chain joints.
- **Multi-chain interactions** — chains that share joints (e.g., a chain ending at
  elbow and another ending at hand). Phase 1 solves chains independently.
- **Constraints interaction** — bone constraints run after IK in the evaluation stack
  but are not implemented yet. The evaluation order slot is reserved.
- **Animation keyframing of IK targets** — `chain.target` is not yet keyframeable.
  Use `setClipJointKeyframe3D` on the baked rotations as a workaround.
