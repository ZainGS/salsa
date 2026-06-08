# Armature & Skeleton Authoring — Frogmarks UI Guide
**Last Updated:** 2026-06-07

---

## Overview

The armature system lets you build rigs from scratch, bind meshes, paint vertex weights, author animation clips, and retarget animations between skeletons — all without importing from Blender or any external tool.

Eight feature groups:
1. **Create Skeleton** — build a joint hierarchy programmatically or by dragging in the viewport
2. **Bone Overlay** — visualise and interact with joints directly in the 3D viewport
3. **FK Rotation** — rotate joints with arc ring gizmos to pose the character for animation
4. **IK** — drag gold target handles; FABRIK solver drives the chain automatically
5. **Bone Constraints** — per-joint rules (lookAt, copyRotation, stretchTo) that run after FK+IK
6. **Pose Library** — capture and recall named FK pose snapshots (T-pose, A-pose, etc.)
7. **Weight Painting** — assign per-vertex joint influences with a heatmap view
8. **Clip Authoring** — create, edit, and play animation clips
9. **Retarget** — copy clips from one skeleton to another by joint name

---

## Part 1 — Create Skeleton from Scratch

### List Existing Skeletons

```ts
const skeletons = shapeManager.getAllSkeletons3D()
// Returns: { id: string; name: string }[]
// Re-call on every sceneGraphChanged event to keep the dropdown current.
```

### Create an Empty Skeleton

```ts
const skelId = shapeManager.createEmptySkeleton3D('MyRig')
// Returns: skeleton ID (string)
```

Creates a `Skeleton3D` with no joints and adds it to the scene root.
Fires `sceneGraphChanged` — re-query `getAllSkeletons3D()` in your handler to refresh the dropdown.

### Activate the Armature Background (Panel Open)

Call this the moment the Armature panel opens — even before a skeleton exists — so
the wavy background appears immediately:

```ts
shapeManager.enterArmatureMode3D()         // activate background; no camera change
shapeManager.enterArmatureMode3D(meshId)   // activate background + auto-center camera on mesh
```

This activates the animated background independently of whether a skeleton has been
created yet. The background is deactivated automatically by `showBoneOverlay3D(null)`.

### Show the Bone Overlay

Call this immediately after selecting a skeleton in the panel so joints are
visible in the viewport **before** the mesh is bound:

```ts
shapeManager.showBoneOverlay3D(skelId)          // show — auto-centers camera on all visible meshes
shapeManager.showBoneOverlay3D(skelId, meshId)  // show — centers camera on a specific mesh
shapeManager.showBoneOverlay3D(null)            // hide (call on panel close — restores camera)
```

On entry the engine automatically:
- **Zeroes the mesh's world rotation** (rotationX/Y/Z → 0) so armature work always starts from a clean front-facing pose. The original rotation is saved and restored on exit.
- Saves the current camera position
- Centers and zooms the viewport so the mesh fills ~75 % of the screen (using the zeroed rotation for correct framing)
- Activates the custom background (wavy by default)
- Enables orbit camera controls for the navigation gizmo

On exit (passing `null`):
- The mesh rotation is restored to its saved values
- The camera is restored to its pre-armature position
- Orbit controls are disabled (canvas drag no longer orbits)

Bones are drawn as diamond sticks with sphere handles at each joint.
Root joints are orange, regular joints are blue, hovered are yellow, selected are teal.
Bones render at depth `always` — they are always visible, even through the mesh.

**There are no viewport gizmo arrows on joints.** Joints are repositioned by dragging
their sphere handle directly (see drag-to-move below) or via the numeric XYZ inputs
in the panel.

### Click-to-Place a Joint (Bone Placement Mode)

Instead of specifying numeric coordinates, the user can click directly in the
viewport to place joints on the mesh surface.

```ts
// Enter placement mode (e.g. when user clicks [+ Add Bone] or opens Armature panel)
shapeManager.enterBonePlacementMode3D(skelId)

// Poll state so the panel can show a hint
const waiting = shapeManager.isBonePlacementModeActive3D()  // true until placement completes

// Cancel without placing (e.g. user presses Escape or closes panel)
shapeManager.exitBonePlacementMode3D()
```

**Root bones — two-click placement:**

Root bones (no parent joint selected) use a two-step workflow:

1. **First click (head)** — must land on the mesh surface. The joint head is pinned there. A bone gizmo appears immediately with a tiny stub tail.
2. **Mouse move** — the tail follows the cursor live, previewing the bone direction in real time.
3. **Second click (tail)** — must land on the mesh surface. The tail is finalized at that point, and placement mode exits.

Both clicks are silently ignored if they miss the mesh — placement mode stays alive until both land on-mesh.

**Child bones — single-click placement (fork vs extend):**

When a parent joint is selected (`parentIdx >= 0`), only one click is needed to set the tail.
The head position depends on **which part of the joint the user clicked to select it**:

| Selection | New bone head position | Semantics |
|-----------|----------------------|-----------|
| **Tail sphere** (leaf joint) | Parent's tail world position | **Extend chain** — no gap, seamless continuation |
| **Head sphere** | Parent's own head position | **Fork / branch** — sprouts from the joint itself |

Read `shapeManager.getSelectedJointIsTail3D()` after `sceneGraphChanged` to know which mode is active and update the Add Bone button label or tooltip accordingly (e.g. "Extend chain" vs "Branch here").

The click must hit the mesh; off-mesh clicks are ignored and keep placement alive.

**After placement:**

- Placement mode clears itself (`isBonePlacementModeActive3D()` → `false`).
- `sceneGraphChanged` fires — re-query `getSkeletonJoints3D(skelId)` to refresh.
- The new joint is auto-selected in the viewport.

**Suggested UX flow:**

```
User selects mesh → clicks [Armature] button
  → enterArmatureMode3D(meshId)           ← background appears, camera frames mesh
  → createEmptySkeleton3D(name)
  → showBoneOverlay3D(newId, meshId)
  → enterBonePlacementMode3D(newId)
  → show "Click mesh to place joint head" tooltip

User clicks mesh → head placed; tooltip changes to "Click mesh to place joint tail"
User moves cursor → tail follows live
User clicks mesh → tail placed; isBonePlacementModeActive3D() → false
  → hide tooltip, show full Armature panel
```

**Difference between [+ Add Bone] and [Extrude]:**

| Button | Head placement | Tail placement |
|--------|---------------|----------------|
| **Extrude** | Always at selected joint's **tail** | Single click on mesh sets tail |
| **+ Add Bone (root)** | First click on mesh sets head | Second click on mesh sets tail (live preview) |
| **+ Add Bone (child, tail selected)** | At selected joint's **tail** — extend chain | Single click on mesh sets tail |
| **+ Add Bone (child, head selected)** | At selected joint's **head** — fork/branch | Single click on mesh sets tail |

```ts
// [Extrude]: always head at parent's tail, one click to set tail
shapeManager.extrudeJoint3D(skelId)
// show "Click mesh to place bone tail" hint → single click → sceneGraphChanged

// [+ Add Bone] with joint selected (hint driven by getSelectedJointIsTail3D()):
shapeManager.enterBonePlacementMode3D(skelId)
const isTail = shapeManager.getSelectedJointIsTail3D()
// isTail=true  → show "Extending chain — click mesh to place tail"
// isTail=false → show "Branching — click mesh to place tail"
// single click → sceneGraphChanged

// [+ Add Bone] with nothing selected: two clicks for head then tail
shapeManager.enterBonePlacementMode3D(skelId)
// show "Click mesh to place bone head" → click → "Click mesh to place bone tail" → click → done
```

### Add Bones (Numeric)

```ts
// Append a root joint (parentIndex = -1)
const rootIdx = shapeManager.addBone3D(skelId, -1, [0, 0, 0], 'root')

// Append children
const hipIdx   = shapeManager.addBone3D(skelId, rootIdx, [0, 1, 0],    'hip')
const spineIdx = shapeManager.addBone3D(skelId, hipIdx,  [0, 0.5, 0],  'spine')
const headIdx  = shapeManager.addBone3D(skelId, spineIdx,[0, 0.8, 0],  'head')
```

- `parentIndex`: -1 = root joint; ≥0 = child of that joint index
- `localPos`: [x, y, z] **relative to the parent joint** (world origin for root)
- `name`: optional string label
- Returns the new joint index (stable until `removeBone3D` is called)

Each call fires `sceneGraphChanged`. Refresh the joint list by calling:

```ts
const joints = shapeManager.getSkeletonJoints3D(skelId)
// Returns: { index, name, parentIndex, localPosition: [x,y,z],
//            tailOffset: [x,y,z], isLeaf: boolean }[]
// Returns [] if skeleton not found.
```

### Extrude Bone from Selected Joint

Mirrors the Blender E-key workflow: arms bone placement mode with the new bone's head
pre-snapped to the currently selected joint's tail.  The user then clicks the mesh once
to set the tail.

- **Head** of the new bone is placed at the parent's **tail** world position (no gap).
- **Tail** is set by a single on-mesh click (placement mode, same as child [+ Add Bone]).

```ts
shapeManager.extrudeJoint3D(skelId)
// Arms placement mode — show "Click mesh to place bone tail" hint.
// Parented to the currently selected joint.
// Head = parent's tail; user click sets tail.
```

Placement mode activates automatically; `isBonePlacementModeActive3D()` → `true`.
`sceneGraphChanged` fires when the tail click lands. The new joint is immediately selected.

### Move, Rename, Remove Bones

```ts
shapeManager.moveBone3D(skelId, hipIdx, [0, 1.2, 0])     // move (local pos)
shapeManager.renameBone3D(skelId, headIdx, 'neck')        // rename
shapeManager.removeBone3D(skelId, lArmIdx)                // remove + all descendants
```

All four mutation methods fire `sceneGraphChanged`. Subscribe and call
`getSkeletonJoints3D(skelId)` to refresh the joint list:

```ts
// Pattern: call after sceneGraphChanged or immediately after any mutation
const joints = shapeManager.getSkeletonJoints3D(skelId)
// → [{ index, name, parentIndex, localPosition, tailOffset, isLeaf }, ...]
```

> **WARNING — `removeBone3D`:** removes the joint *and all its descendants*.
> All remaining joint indices are re-numbered — re-fetch the joint list from
> `getSkeletonJoints3D()` after any remove call.

### Tail Handle — Set Bone Length Without Extruding

Every **leaf joint** (a joint with no children) has a **tail handle**: a small
light-gray sphere rendered at the tip of the bone, connected to the head sphere
by a diamond stick.  Dragging the tail handle in the viewport stretches or
shortens the bone and sets its direction — without creating a new joint.

This mirrors the Blender workflow where you grab the white tail circle of a leaf
bone to set its length before deciding whether to extrude a child from it.

**Viewport interaction — automatic, no code needed:**
- Hovering the tail sphere turns it yellow.
- Click-dragging it moves the tip on a camera-facing plane.
- Releasing fires `sceneGraphChanged`; re-call `getSkeletonJoints3D` to read
  the updated `tailOffset`.

**Setting tail offset programmatically:**

```ts
// tailOffset is in the joint's own local frame (applied through worldMatrix).
// [0, 0.3, 0] = 0.3 world units above the joint in its local +Y direction.
shapeManager.setJointTailOffset3D(skelId, jointIdx, [0, 0.5, 0])
```

The `tailOffset` field is included in `getSkeletonJoints3D()` returns:

```ts
const joints = shapeManager.getSkeletonJoints3D(skelId)
// joints[i].tailOffset  → current [x, y, z] in joint's local frame
// joints[i].isLeaf      → true if the joint has no children (tail visible)
```

**Note:** `tailOffset` is purely visual — it does **not** affect skinning or the
joint hierarchy.  Binding the mesh (`bindMeshToSkeleton3D`) only uses
`localPosition`, `localRotation`, and `inverseBindMatrix`.

**There are no visual gizmo arrows on joints.** Joints are positioned numerically
via XYZ inputs in the panel or by drag in the viewport (see Part 2).

### Bind a Mesh to the Skeleton

```ts
const ok = shapeManager.bindMeshToSkeleton3D(meshId, skelId)
// Returns false if mesh or skeleton not found, or skeleton has 0 joints.
```

**Disable "Bind Mesh" until the skeleton has ≥1 joint** — binding with zero joints is a no-op.

What binding does:
- Auto-assigns each vertex to its nearest 4 joints using inverse-distance² weights
- Bakes the current joint positions as the **bind pose** (inverseBindMatrices)
- Upgrades `Mesh3D` → `SkinnedMesh3D` in the scene graph (same ID preserved)
- The bone overlay remains active after binding

**Tip:** Set joint positions before binding. The inverse bind matrices are baked from
whatever pose the skeleton is in at bind time. If you move joints after binding, call
`bindMeshToSkeleton3D` again to rebake.

---

## Part 2 — Bone Overlay & Viewport Interaction

The bone overlay renders joint spheres and diamond bone sticks directly in the
3D viewport. It activates for both bare `Skeleton3D` nodes and bound `SkinnedMesh3D`.

### Activate / Deactivate

```ts
shapeManager.showBoneOverlay3D(skelId)   // activate for this skeleton
shapeManager.showBoneOverlay3D(null)     // deactivate
shapeManager.getBoneOverlaySkeletonId3D() // → current skeleton ID or null
```

Call `showBoneOverlay3D(skelId)` whenever the panel's selected skeleton changes,
and `showBoneOverlay3D(null)` when the Armature panel is closed.

### Clicking a Joint

Every joint has a **head sphere** (orange for root, blue for children) and, if it is a leaf
(no children), a **tail sphere** (small gray sphere at the bone tip). Both are clickable:

- **Head sphere click** — selects the joint at its origin; `getSelectedJointIsTail3D()` → `false`
- **Tail sphere click** (leaf joints only) — selects the joint at its tail; `getSelectedJointIsTail3D()` → `true`

Both fire `sceneGraphChanged`. Read state after the event:

```ts
const idx    = shapeManager.getSelectedJointIndex3D()   // null if nothing selected
const isTail = shapeManager.getSelectedJointIsTail3D()  // true = tail sphere was clicked
```

`isTail` controls **Add Bone** semantics — see the fork vs extend table in Part 1.
Use it to update the Add Bone button label/tooltip so the user knows which mode is active.

Use `getSelectedJointIndex3D()` to auto-fill the "Move Bone" XYZ inputs in the panel.

### Programmatic Selection

```ts
shapeManager.selectJoint3D(2)     // select joint at index 2
shapeManager.selectJoint3D(null)  // deselect
```

Also fires `sceneGraphChanged`.

### Armature Tool Mode — Move vs. Rotate

The Armature panel has two mutually exclusive tool modes that control what the selected joint's gizmo does:

```ts
shapeManager.setArmatureToolMode3D('move')    // default
shapeManager.setArmatureToolMode3D('rotate')  // FK rotation
shapeManager.getArmatureToolMode3D()          // → 'move' | 'rotate'
```

| Mode | Gizmo | Effect |
|------|-------|--------|
| `'move'` | XYZ arrow axes (red/green/blue) | Repositions the joint origin in world space — edits the skeleton structure and bind pose |
| `'rotate'` | XYZ arc rings (red/green/blue) | Rotates the joint around a world axis — poses the character for animation without moving the joint origin |

Show a **[ Move ] [ Rotate ]** toggle in the Armature panel header. Call `setArmatureToolMode3D` when either button is clicked. The gizmo in the viewport updates immediately.

`sceneGraphChanged` is **not** fired on tool mode change — no need to refresh the panel on switch.

### Drag-to-Move a Joint

Only active when tool mode is `'move'`. When a joint sphere is **clicked and dragged** in the viewport, the engine moves it interactively by intersecting the mouse ray with a camera-facing plane locked to the joint's world position. `moveBone3D` is called continuously during the drag; `sceneGraphChanged` fires on mouse-up.

No Frogmarks code is needed for this — it is handled automatically in the engine.
Your panel's `sceneGraphChanged` handler will receive the final position update.

### Joint Name Labels

Project joint world positions to screen coordinates each frame to render name labels
as DOM elements over the canvas:

```ts
const labels = shapeManager.getJointScreenPositions3D(skelId, canvas.width, canvas.height)
// Returns: { index: number; name: string; x: number; y: number }[]
// x/y are pixel coordinates from the top-left of the canvas.
```

Call this inside a `requestAnimationFrame` loop (or after each `scheduleRender`
notification) and position absolutely-placed `<span>` elements accordingly.

---

## Part 2.5 — FK Rotation (Posing)

Forward Kinematics rotation lets the animator rotate a joint around its local X, Y, or Z axis to pose the character. The rotation propagates down the hierarchy — child joints inherit the parent's rotation, and the bound mesh deforms live through the skinning matrices.

### Viewport interaction

Switch to Rotate tool mode first (`setArmatureToolMode3D('rotate')`). When a joint is selected, three colored arc rings appear at its world position (red=X, green=Y, blue=Z). Dragging a ring rotates the joint around that axis. The mesh deforms in real time. `sceneGraphChanged` fires on drag release.

No Frogmarks code is needed for the drag itself — it is handled entirely by the engine.

### Reading and writing rotation

```ts
// Get current quaternion [x, y, z, w]
const q = shapeManager.getJointRotation3D(skelId, jointIndex)

// Set rotation programmatically (e.g. from numeric Euler inputs in the panel)
shapeManager.setJointRotation3D(skelId, jointIndex, [qx, qy, qz, qw])

// Reset one joint to rest pose
shapeManager.resetJointRotation3D(skelId, jointIndex)

// Reset all joints to rest pose (clear entire pose)
shapeManager.resetAllJointRotations3D(skelId)
```

### Euler angle display

Quaternions are hard to read. Convert to Euler degrees for the panel's XYZ rotation inputs:

```ts
import { quat } from 'gl-matrix'

function quatToEulerDeg(q: [number,number,number,number]): [number,number,number] {
    const e = new Float32Array(3)
    // gl-matrix doesn't expose toEuler, so use Math directly:
    const [x, y, z, w] = q
    const sinr = 2 * (w*x + y*z)
    const cosr = 1 - 2 * (x*x + y*y)
    const rx = Math.atan2(sinr, cosr)
    const sinp = 2 * (w*y - z*x)
    const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)
    const siny = 2 * (w*z + x*y)
    const cosy = 1 - 2 * (y*y + z*z)
    const rz = Math.atan2(siny, cosy)
    return [rx * 180/Math.PI, ry * 180/Math.PI, rz * 180/Math.PI]
}

// And back to quaternion for setJointRotation3D:
function eulerDegToQuat(rx: number, ry: number, rz: number): [number,number,number,number] {
    const [cx, sx] = [Math.cos(rx*Math.PI/360), Math.sin(rx*Math.PI/360)]
    const [cy, sy] = [Math.cos(ry*Math.PI/360), Math.sin(ry*Math.PI/360)]
    const [cz, sz] = [Math.cos(rz*Math.PI/360), Math.sin(rz*Math.PI/360)]
    return [
        sx*cy*cz + cx*sy*sz,
        cx*sy*cz - sx*cy*sz,
        cx*cy*sz + sx*sy*cz,
        cx*cy*cz - sx*sy*sz,
    ]
}
```

### Keyframing FK rotations

FK rotations are keyframeable through the existing clip system — no new API needed:

```ts
const q = shapeManager.getJointRotation3D(skelId, jointIndex)
shapeManager.setClipJointKeyframe3D(clipId, jointIndex, 'rotation', frame, q)
```

`recordSkeletonPose3D` captures all joint rotations at once:

```ts
// Pose the skeleton with FK drags or setJointRotation3D calls, then:
shapeManager.recordSkeletonPose3D(skelId, clipId, frame)
```

---

## Part 2.6 — Inverse Kinematics

Inverse Kinematics (IK) lets the user drag a gold **target handle** in the viewport and have the joint chain automatically solve to reach it using FABRIK. The mesh deforms live on every frame.

### Concept

Each IK chain has:
- An **end-effector joint** — the tip of the chain (e.g. hand, foot)
- A **chain length** — how many bones back from the end-effector are included (min 2)
- A **target position** — the world-space point the end-effector tries to reach (the gold sphere)
- An **enabled flag** — when false, the chain falls back to FK

The **anchor** joint (one hop above the chain) is not modified — it stays fixed as the chain's root.

### Viewport Interaction — Automatic

Gold sphere handles appear automatically at each chain's target position. No Frogmarks code is needed for the drag:
- **Hover** — sphere turns bright yellow
- **Click + drag** — sphere turns white; `chain.target` updates live every frame; `sceneGraphChanged` fires on release
- **Orbit** — disabled during IK drag, restored on release

The end-effector joint tracks the target as closely as the chain allows. When the target is unreachable, the chain stretches toward it.

### Adding an IK Chain

```ts
// Call when user clicks [+ Set as IK Target] with a joint selected
const chainId = shapeManager.addIKChain3D(skelId, endJointIdx, 3)
// Default chain length = 3 (end → parent → grandparent; great-grandparent is fixed anchor)
// Returns: chain ID string
// Fires: sceneGraphChanged
```

The initial target is placed at the end-effector's current world position.

### Removing an IK Chain

```ts
shapeManager.removeIKChain3D(skelId, chainId)
// Clears ikRotation on chain joints → they fall back to FK localRotation
// Fires: sceneGraphChanged
```

### Reading Chain State

```ts
const chains = shapeManager.getIKChains3D(skelId)
// Returns: IKChain[]
// Re-call on every sceneGraphChanged to keep the panel in sync
```

Each `IKChain` has:
```ts
interface IKChain {
  id: string
  endJointIdx: number
  chainLength: number
  target: [number, number, number]       // world-space position of the gold sphere
  poleTarget?: [number, number, number]  // optional pole vector world position (cyan sphere)
  blendWeight: number                    // 0 = pure FK, 1 = pure IK (default)
  enabled: boolean
}
```

Use `chains.find(c => c.endJointIdx === selectedIdx)` to check whether the selected joint is an IK end-effector (determines Case A vs Case B in the panel — see Panel Layout below).

### Moving the Target Programmatically

```ts
// Bind to the Target XYZ inputs in the panel (Case B)
shapeManager.setIKTarget3D(skelId, chainId, x, y, z)
// Does NOT fire sceneGraphChanged — use scheduleRender-style update
```

During a viewport drag, target XYZ inputs should be **read-only** (read from `getIKChains3D` after each `sceneGraphChanged`). Outside of a drag, they are editable.

### Enable / Disable

```ts
shapeManager.setIKChainEnabled3D(skelId, chainId, true)   // IK active
shapeManager.setIKChainEnabled3D(skelId, chainId, false)  // fall back to FK; gold handle hidden
// Fires: sceneGraphChanged
```

### Chain Length

```ts
// Spinner: min=2, max = depth of endJointIdx in hierarchy
shapeManager.setIKChainLength3D(skelId, chainId, n)
// Fires: sceneGraphChanged
```

### FK/IK Blend Weight

Each chain has a `blendWeight` (0–1, default 1). At 1 the chain is fully IK-driven. At 0 the solver skips the chain entirely and joints fall back to their FK `localRotation`. Values in between slerp smoothly between the FK pose and the FABRIK-solved IK pose — useful for transitioning between authored FK animation and physics/IK-driven motion.

```ts
// Slider: 0.0–1.0
shapeManager.setIKBlendWeight3D(skelId, chainId, 0.7)
// Does NOT fire sceneGraphChanged — use scheduleRender-style update
```

The blend is applied per-frame in the IK solve, so the slider can be animated or driven from code every frame without performance cost.

### Pole Vector

A **pole vector** constrains the plane of rotation — it controls which way the chain bends. With no pole target the chain bends in whichever direction FABRIK finds; with a pole target the intermediate joints are pulled onto the plane defined by (chain anchor, IK target, pole target), so the bend direction is deterministic.

A **cyan sphere** appears at the pole target position. Drag it exactly like the gold IK target sphere. A thin cyan line connects the chain anchor to the pole sphere so the relationship is always visible.

```ts
// Attach a pole vector (cyan sphere appears immediately)
// Suggested initial position: beside the chain's mid-joint
shapeManager.setPoleTarget3D(skelId, chainId, x, y, z)
// Fires: sceneGraphChanged

// Remove pole vector (cyan sphere disappears; chain reverts to unconstrained FABRIK)
shapeManager.clearPoleTarget3D(skelId, chainId)
// Fires: sceneGraphChanged
```

**Viewport interaction for the pole sphere is automatic** — the same hover/click-drag/release flow as the gold target sphere, using dedicated cyan colors:
- **Hover** — sphere brightens to light cyan
- **Drag** — sphere turns white; `chain.poleTarget` updates live; `sceneGraphChanged` fires on release

### Joint List — IK Indicator

Joints that are the end-effector of an enabled IK chain should show a `◆IK` badge (gold) next to their name in the joint list. Check after `sceneGraphChanged`:

```ts
const chains = shapeManager.getIKChains3D(skelId)
const ikEndSet = new Set(chains.filter(c => c.enabled).map(c => c.endJointIdx))
// joints[i].index in ikEndSet → show ◆IK badge
```

### Suggested Panel — Selected Joint IK Section

The IK section appears **below** the Move/Rotate inputs and depends on whether the selected joint is a chain end-effector:

**Case A** — no IK chain on this joint:
```
── IK ──────────────────────────────────────────────
[+ Set as IK Target]   → addIKChain3D(skelId, idx, 3)
```

**Case B** — this joint IS an IK end-effector (`chains.find(c => c.endJointIdx === selectedIdx)`):
```
── IK ──────────────────────────────────────────────
Chain Length  [3]          → setIKChainLength3D(skelId, chainId, n)
                              min=2, max=depth of joint in hierarchy
FK ←────[████░░]──→ IK     → setIKBlendWeight3D(skelId, chainId, weight)
  0.0                1.0      (slider; 0 = pure FK, 1 = pure IK)
Target  X [0.00]  Y [1.50]  Z [0.00]
                           → setIKTarget3D(skelId, chainId, x, y, z)
                              (read-only during viewport drag; editable otherwise)
Pole  X [0.50]  Y [0.80]  Z [0.00]   [✕]
                           → setPoleTarget3D(skelId, chainId, x, y, z)
                              (✕ button → clearPoleTarget3D to remove the pole)
                              (read-only during viewport drag; editable otherwise)
[+ Add Pole]               → setPoleTarget3D(skelId, chainId, …)
                              (shown only when chain.poleTarget is undefined)
[ ✓ Enabled ]              → setIKChainEnabled3D(skelId, chainId, bool)
[Remove IK]                → removeIKChain3D(skelId, chainId)
```

**Case C** — selected joint is an intermediate chain member (not the end-effector):
Show nothing in the IK section. Intermediate joints are implicitly controlled by the chain and have no panel controls.

### Keyframing IK Targets

IK chain properties can be keyframed inside any `SkeletonAnimClip`, alongside joint rotation/translation tracks. This lets you animate the gold target sphere, the cyan pole sphere, and the blend weight over time.

**How it fits into the clip system:**

```
SkeletonAnimClip
  ├── tracks[]      ← per-joint rotation / translation / scale
  └── ikTracks[]    ← per-chain target / poleTarget / blendWeight
```

IK tracks are played by `playSkeletonClip3D` automatically — no extra code needed. During playback, `chain.target` / `chain.poleTarget` / `chain.blendWeight` are updated each frame, and the IK solver picks them up on the same frame.

**Set a keyframe on a chain property:**

```ts
// Keyframe the gold target sphere at frame 12
shapeManager.setIKKeyframe3D(clipId, chainId, 'target', 12, [0.5, 1.2, 0.0])

// Keyframe the pole sphere at frame 12
shapeManager.setIKKeyframe3D(clipId, chainId, 'poleTarget', 12, [0.5, 0.8, 0.4])

// Keyframe the blend weight (0 = FK, 1 = IK)
shapeManager.setIKKeyframe3D(clipId, chainId, 'blendWeight', 12, [1.0])
// Note: blendWeight value is a 1-element array: [w]
```

**Remove a keyframe:**

```ts
shapeManager.removeIKKeyframe3D(clipId, chainId, 'target', 12)
```

**Record the current IK state as keyframes** (all enabled chains at once):

```ts
// Drag the IK handles to the desired positions, then:
shapeManager.recordIKPose3D(skelId, clipId, frame)
// Captures target, poleTarget (if set), and blendWeight for every enabled chain
```

**Workflow — animating IK targets across frames:**

```
1. Create or select a clip        → createSkeletonClip3D / getSkeletonClips3D
2. Drag IK target to frame 0 pose → chain.target updates live via viewport drag
3. Record                         → recordIKPose3D(skelId, clipId, 0)
4. Advance to frame 24
5. Drag IK target to new position
6. Record                         → recordIKPose3D(skelId, clipId, 24)
7. Play                           → playSkeletonClip3D(skelId, clip)
   IK target interpolates linearly between the two recorded positions each frame.
```

All three properties (`target`, `poleTarget`, `blendWeight`) are interpolated linearly between keyframes. For step transitions (e.g. instantly switching blend weight) set two keyframes on adjacent frames.

### IK API Summary

| Method | Signature | Description |
|--------|-----------|-------------|
| `addIKChain3D` | `(skelId, endJointIdx, chainLength) → string` | Add IK chain; returns chainId. Initial target = end-effector world pos |
| `removeIKChain3D` | `(skelId, chainId) → void` | Remove chain; clears ikRotation → FK fallback |
| `getIKChains3D` | `(skelId) → IKChain[]` | Read all chains; re-call on sceneGraphChanged |
| `setIKTarget3D` | `(skelId, chainId, x, y, z) → void` | Move target programmatically (panel XYZ inputs) |
| `setIKChainEnabled3D` | `(skelId, chainId, enabled) → void` | Enable/disable; disabling hides gold handle |
| `setIKChainLength3D` | `(skelId, chainId, n) → void` | Change chain length; min 2 |
| `setIKBlendWeight3D` | `(skelId, chainId, weight) → void` | FK/IK blend; 0 = pure FK, 1 = pure IK; slerps between localRotation and FABRIK pose |
| `setPoleTarget3D` | `(skelId, chainId, x, y, z) → void` | Attach/move pole vector (cyan sphere); constrains bend plane |
| `clearPoleTarget3D` | `(skelId, chainId) → void` | Remove pole vector; chain reverts to unconstrained FABRIK |
| `setIKKeyframe3D` | `(clipId, chainId, property, frame, value) → void` | Add/update a keyframe on a chain property (`'target'`/`'poleTarget'`/`'blendWeight'`) |
| `removeIKKeyframe3D` | `(clipId, chainId, property, frame) → void` | Remove a keyframe from an IK track |
| `recordIKPose3D` | `(skelId, clipId, frame) → void` | Snapshot current IK state (all enabled chains) as keyframes at `frame` |

---

## Part 2.7 — Bone Constraints

Bone constraints are per-joint rules that automatically drive a joint's rotation or scale each frame. They run **after** FK and IK, so they always see the final IK-solved pose.

Three constraint types:

| Type | Effect |
|------|--------|
| `lookAt` | Rotates the joint so a chosen local axis points toward a target joint |
| `copyRotation` | Copies another joint's FK rotation, blended by an influence weight |
| `stretchTo` | Scales the joint's bone length to reach a target joint, with optional volume preservation |

### Adding a Constraint

```ts
// Look At — joint 2's Y axis points toward joint 5
shapeManager.addJointConstraint3D(skelId, 2, {
    type: 'lookAt',
    targetJointIdx: 5,
    axis: 'y',
    influence: 1.0,
})

// Copy Rotation — joint 3 mirrors joint 1's rotation at 60 %
shapeManager.addJointConstraint3D(skelId, 3, {
    type: 'copyRotation',
    sourceJointIdx: 1,
    influence: 0.6,
})

// Stretch To — joint 4 scales to reach joint 7; volume preserved at 50 %
shapeManager.addJointConstraint3D(skelId, 4, {
    type: 'stretchTo',
    targetJointIdx: 7,
    influence: 1.0,
    volumePreserve: 0.5,
})
// Returns: constraint index (integer) — save it if you need to remove later
```

`influence` is 0–1: 0 = no effect, 1 = full. Values in between blend the constraint result with the joint's pre-constraint rotation/scale.

### Removing a Constraint

```ts
shapeManager.removeJointConstraint3D(skelId, jointIndex, constraintIndex)
// constraintIndex is the integer returned by addJointConstraint3D
// After removal, remaining constraint indices may shift — re-read getJointConstraints3D
```

### Reading Constraints

```ts
const constraints = shapeManager.getJointConstraints3D(skelId, jointIndex)
// Returns: JointConstraint[]
// Re-call on sceneGraphChanged to keep the panel in sync
```

Each entry is one of:
```ts
{ type: 'lookAt';       targetJointIdx: number; axis: 'x'|'y'|'z'; influence: number }
{ type: 'copyRotation'; sourceJointIdx: number; influence: number }
{ type: 'stretchTo';    targetJointIdx: number; influence: number; volumePreserve: number }
```

Constraints are serialized as part of each joint in `toJSON`/`fromJSON` — they survive project save/load.

### Suggested Panel — Constraints Sub-section

Display a collapsible **Constraints** sub-panel inside the Selected Joint section, below the IK section:

```
── Constraints ──────────────────────────────────
  [+ Add]  [Look At ▾]     ← dropdown: Look At / Copy Rotation / Stretch To

  Look At → joint_3   axis [Y ▾]   inf [1.00]  [🗑]
  Copy Rot ← joint_5   inf [0.60]              [🗑]
```

**Add flow:**
1. User picks type from dropdown and clicks **[+ Add]** → call `addJointConstraint3D` with defaults
2. Target joint / source joint shown as a dropdown (populated from `getSkeletonJoints3D`)
3. Influence slider 0–1; axis dropdown for lookAt (X/Y/Z); volumePreserve slider for stretchTo
4. Changes call `removeJointConstraint3D(old index)` + `addJointConstraint3D(new values)` (simplest update path)
5. Trash icon → `removeJointConstraint3D(skelId, jointIndex, constraintIndex)`

Refresh the constraint list on every `sceneGraphChanged`.

### Constraints API Summary

| Method | Signature | Description |
|--------|-----------|-------------|
| `addJointConstraint3D` | `(skelId, jointIndex, constraint) → number` | Add constraint; returns constraint index |
| `removeJointConstraint3D` | `(skelId, jointIndex, constraintIndex) → void` | Remove by index; remaining indices may shift |
| `getJointConstraints3D` | `(skelId, jointIndex) → JointConstraint[]` | Read all constraints on a joint |

---

## Part 2.8 — Pose Library

The Pose Library lets animators capture a snapshot of the skeleton's current FK rotations as a named pose, then recall it at any time without re-entering joint values. Poses survive project save/load.

### Capture a Pose

```ts
// Pose the skeleton using FK drags or setJointRotation3D, then:
const poseId = shapeManager.capturePose3D(skelId, 'T-Pose')
// Returns: pose ID string
// Fires: scheduleRender (does NOT fire sceneGraphChanged — list refresh is not needed)
```

Call `getPoses3D` after capturing to refresh the list.

### Apply a Pose

```ts
shapeManager.applyPose3D(skelId, poseId)
// Sets all joint localRotations to the saved values
// Fires: sceneGraphChanged
```

### List Poses

```ts
const poses = shapeManager.getPoses3D(skelId)
// Returns: { id: string; name: string }[]
// Re-call on sceneGraphChanged to keep the list current
```

### Rename / Delete

```ts
shapeManager.renamePose3D(skelId, poseId, 'A-Pose')   // fires sceneGraphChanged
shapeManager.deletePose3D(skelId, poseId)              // fires sceneGraphChanged
```

### Suggested Panel — Pose Library Section

Collapsible section below Animation Clips:

```
── Pose Library ──────────────────────────────────
  Name [_______________]  [+ Capture]

  T-Pose      [Apply] [Rename] [🗑]
  A-Pose      [Apply] [Rename] [🗑]
  Idle Ref    [Apply] [Rename] [🗑]
```

**Capture flow:**
- Name input (default: `Pose ${poses.length + 1}` when blank)
- Click **[+ Capture]** → `capturePose3D(skelId, name)` → re-call `getPoses3D` to refresh list

**Apply:** calls `applyPose3D(skelId, poseId)` — the viewport updates immediately and `sceneGraphChanged` fires for the panel to refresh joint rotation inputs.

**Rename:** inline edit; confirm on Enter/blur → `renamePose3D(skelId, poseId, newName)`

**Delete:** `deletePose3D(skelId, poseId)` → re-call `getPoses3D` to refresh list

Refresh the pose list on every `sceneGraphChanged`.

### Pose Library API Summary

| Method | Signature | Description |
|--------|-----------|-------------|
| `capturePose3D` | `(skelId, name) → string` | Snapshot current FK rotations; returns pose ID |
| `applyPose3D` | `(skelId, poseId) → void` | Apply saved pose; fires sceneGraphChanged |
| `getPoses3D` | `(skelId) → { id, name }[]` | List all saved poses |
| `renamePose3D` | `(skelId, poseId, name) → void` | Rename a pose; fires sceneGraphChanged |
| `deletePose3D` | `(skelId, poseId) → void` | Delete a pose; fires sceneGraphChanged |

---

## Part 3 — Weight Painting

Weight painting visualizes and edits per-vertex joint influence as a heatmap:
**blue = 0 influence, green = 0.5, red = full influence**.

### Enter / Exit Weight Paint Mode

```ts
shapeManager.enterWeightPaintMode3D(meshId, skelId, jointIndex)  // enter
shapeManager.exitWeightPaintMode3D()                              // exit
```

The mesh must be a `SkinnedMesh3D` (already bound to a skeleton). Works for both
hand-built meshes and GLB imports — no `makeEditable3D` required.

### Weight Paint Viewport Behavior

When weight paint mode is active, the viewport changes significantly:

- **Joint drag is disabled** — clicking and dragging joint head spheres has no effect. The user cannot accidentally move joints while painting.
- **Tail drag is disabled** — leaf bone tail handle dragging is also suppressed.
- **Transform gizmo is hidden** — the XYZ arrow gizmo disappears; only the selected joint sphere is shown.
- **Single joint display** — only the currently selected joint is rendered as a sphere (1.2× larger than normal, cyan). All other bones, diamonds, and joints are hidden, keeping the viewport focused on the painted joint.
- **Vertex dot overlay** — small billboard squares appear at every mesh vertex position. Dots outside the brush radius are grey (`rgba 0.5, 0.5, 0.5, 0.6`); dots inside the brush radius turn cyan (`rgba 0.0, 1.0, 0.88, 1.0`), giving precise visual feedback on which vertices will be affected by the current stroke.

### Brush Settings

The canvas mouse interaction (raycasting, vertex lookup, painting) is handled
automatically by Salsa once weight paint mode is entered. Frogmarks only needs
to push slider values whenever they change:

```ts
shapeManager.setWeightPaintBrush(
    radius,       // world-space brush radius (e.g. 0.05–1.0)
    strength,     // lerp per stroke (0.1 = slow, 1.0 = full replace)
    targetWeight, // 0.0 = remove influence, 1.0 = full influence
)
```

Call this once on panel open with the current slider values, and again on
every slider change. Defaults: radius=0.3, strength=0.2, targetWeight=1.0.

The user simply clicks and drags on the mesh to paint. Weights are automatically
normalised to sum to 1 after each stroke.

### Switch Active Joint While Painting

Call this when the user clicks a different joint in the panel's joint list to switch
which joint is being painted — without exiting and re-entering weight paint mode:

```ts
shapeManager.setWeightPaintJoint3D(jointIndex)
```

This updates the active joint and refreshes the heatmap display immediately.

### Highlight a Joint from the Panel

While weight paint mode is active, hovering a row in the joint list can highlight
that joint in the viewport without changing the selected/active joint:

```ts
shapeManager.highlightJoint3D(jointIndex)   // highlight this joint cyan
shapeManager.highlightJoint3D(null)         // clear the highlight
```

The highlight is programmatic (independent of the canvas pointer). Highlighted joints
appear cyan alongside any joint the user is hovering with the mouse. Call
`highlightJoint3D(null)` on `mouseleave` of each list row.

### Lighting Mode

Toggle between lit (default, gives depth cues) and unlit (every face same brightness — useful for reading heatmap colours on the back of the mesh):

```ts
shapeManager.setWeightPaintUnlit3D(true)   // unlit — heat colour at full brightness
shapeManager.setWeightPaintUnlit3D(false)  // lit   — NdotL shading (default)
```

Takes effect on the next frame; no need to re-enter weight paint mode.

### Show / Hide Skeleton

```ts
shapeManager.setWeightPaintShowSkeleton(true)   // show bone diamonds while painting (default)
shapeManager.setWeightPaintShowSkeleton(false)  // hide skeleton — only the selected joint sphere remains
```

### Query Weight Paint State

```ts
shapeManager.isWeightPainting3D()  // → true while weight paint mode is active
```

Use this to conditionally show/hide the weight paint panel controls (brush sliders,
normalize button, joint list) and to guard against calling `setWeightPaintJoint3D`
when weight paint mode is not active.

### Manual Normalize

```ts
shapeManager.normalizeWeights3D(meshId)
```

---

## Part 4 — Clip Authoring

### Create a Clip

```ts
const clipId = shapeManager.createSkeletonClip3D(skelId, 'Walk', 24, 48)
// args: skeletonId, name, fps, endFrame (startFrame is always 0)
```

### Set Keyframes Manually

```ts
shapeManager.setClipJointKeyframe3D(
    clipId,
    jointIndex,
    'rotation',           // 'translation' | 'rotation' | 'scale'
    frame,
    [0, 0.707, 0, 0.707], // quaternion xyzw for rotation, [x,y,z] for translation/scale
)
```

### Record a Pose

```ts
// Pose the skeleton first
shapeManager.setJointRotation3D(skelId, hipIdx, [0, 0.2, 0, 0.98])

// Capture all joints at once
shapeManager.recordSkeletonPose3D(skelId, clipId, frame)
```

### Remove a Keyframe

```ts
shapeManager.removeClipJointKeyframe3D(clipId, jointIndex, 'rotation', frame)
```

### Get / Delete Clips

```ts
const clips = shapeManager.getSkeletonClips3D(skelId)   // SkeletonAnimClip[]
shapeManager.deleteSkeletonClip3D(clipId)
```

### Play a Clip

```ts
const player = shapeManager.playSkeletonClip3D(skelId, clip)
player.play()
// player.pause(), player.stop(), player.destroy() also available
```

---

## Part 5 — Retarget Animations

```ts
const newClipId = shapeManager.retargetSkeletonClip3D(clipId, targetSkeletonId)
// Returns new clip ID on the target skeleton, or '' if source not found.
```

Copies tracks by matching joint names (case-insensitive). Unmatched joints are
skipped with a `console.warn`. New clip is named `originalName (retargeted)`.

---

## Suggested Panel Layout

```
Armature Panel
├── ── Skeletons ──
│   ├── Dropdown (getAllSkeletons3D())    ← re-populate on sceneGraphChanged
│   └── [+ New Skeleton]                 → enterArmatureMode3D(meshId)        ← background + camera immediately
│                                          then createEmptySkeleton3D(name)
│                                          then showBoneOverlay3D(newId, meshId)
│                                          then enterBonePlacementMode3D(newId)
│                                          show "Click mesh to place joint head"
│                                          (changes to "Click mesh to place tail" after head click)
│                                          (hide hint when isBonePlacementModeActive3D() = false)
│
├── ── Joints — <Skeleton Name> ──       (shown when a skeleton is selected)
│   ├── Tool: [ Move ] [ Rotate ]        → setArmatureToolMode3D('move' | 'rotate')
│   │                                       (changes viewport gizmo instantly; no sceneGraphChanged)
│   │
│   ├── [+ Add Bone]  → enterBonePlacementMode3D(skelId)
│   │                   root:  show "Click mesh to place joint head"
│   │                   child (tail selected):  show "Extending — click mesh to place tail"
│   │                   child (head selected):  show "Branching — click mesh to place tail"
│   │                   (read getSelectedJointIsTail3D() on sceneGraphChanged to pick label)
│   ├── [Extrude]     → extrudeJoint3D(skelId)               (head always at parent's tail)
│   │                   show "Click mesh to place bone tail"
│   │
│   ├── Joint List     (getSkeletonJoints3D, refresh on sceneGraphChanged)
│   │   └── each row: index • name • ◆IK? • [x y z]
│   │       ◆IK badge shown when joint is an IK end-effector (check getIKChains3D)
│   │       click row → selectJoint3D(index)
│   │
│   └── Selected Joint (filled from getSelectedJointIndex3D() on sceneGraphChanged)
│       ├── [Rename]      → renameBone3D(...)
│       │
│       ├── ── (Move mode — getArmatureToolMode3D() === 'move') ──
│       ├── Head XYZ      → moveBone3D(...)
│       ├── Tail XYZ      → setJointTailOffset3D(...)  (shown only when isLeaf)
│       │
│       ├── ── (Rotate mode — getArmatureToolMode3D() === 'rotate') ──
│       ├── Rotation X °  ┐
│       ├── Rotation Y °  ├─ read:  quatToEulerDeg(getJointRotation3D(skelId, idx))
│       ├── Rotation Z °  ┘   write: setJointRotation3D(skelId, idx, eulerDegToQuat(rx, ry, rz))
│       ├── [Reset Rotation]  → resetJointRotation3D(skelId, idx)
│       ├── [Reset All Pose]  → resetAllJointRotations3D(skelId)
│       │
│       ├── ── IK ──
│       │   ├── (Case A — no chain on this joint)
│       │   │   └── [+ Set as IK Target]  → addIKChain3D(skelId, idx, 3)
│       │   │
│       │   └── (Case B — joint IS an IK end-effector)
│       │       ├── Chain Length [n]       → setIKChainLength3D(skelId, chainId, n)
│       │       ├── FK/IK Blend [slider 0–1] → setIKBlendWeight3D(skelId, chainId, weight)
│       │       ├── Target X [__] Y [__] Z [__]  → setIKTarget3D(skelId, chainId, x, y, z)
│       │       │     (read-only during viewport drag; editable otherwise)
│       │       ├── Pole   X [__] Y [__] Z [__] [✕]
│       │       │         (shown only when chain.poleTarget is set)
│       │       │         drag XYZ → setPoleTarget3D(skelId, chainId, x, y, z)
│       │       │         ✕        → clearPoleTarget3D(skelId, chainId)
│       │       ├── [+ Add Pole]          → setPoleTarget3D(skelId, chainId, x, y, z)
│       │       │     (shown only when chain.poleTarget is undefined; suggest a position
│       │       │      offset perpendicular to the chain mid-joint)
│       │       ├── [ ✓ Enabled ]          → setIKChainEnabled3D(skelId, chainId, bool)
│       │       └── [Remove IK]           → removeIKChain3D(skelId, chainId)
│       │
│       │
│       ├── ── Constraints ──
│       │   ├── [+ Add]  [Look At ▾]   ← dropdown: Look At / Copy Rotation / Stretch To
│       │   └── (list of constraints from getJointConstraints3D)
│       │       per row: type / target or source joint / influence / axis (lookAt) / volumePreserve (stretchTo) / [🗑]
│       │       [🗑] → removeJointConstraint3D(skelId, jointIndex, constraintIndex)
│       │       (re-read on sceneGraphChanged)
│       │
│       └── [Delete]      → removeBone3D(...)
│
├── ── Bind Mesh ──
│   ├── Mesh dropdown     (getAllMeshes3D())
│   ├── Skeleton dropdown (getAllSkeletons3D())
│   └── [Bind Mesh]       → bindMeshToSkeleton3D(...)
│                           disabled until skeleton has ≥1 joint
│
├── ── Weight Paint ──    (only when SkinnedMesh3D is selected)
│   ├── [Enter Weight Paint] → enterWeightPaintMode3D(meshId, skelId, jointIdx)
│   │                          + setWeightPaintBrush(radius, strength, weight)
│   ├── [Exit]       → exitWeightPaintMode3D()
│   │
│   ├── ── (visible only while isWeightPainting3D()) ──
│   ├── Joint List   (same getSkeletonJoints3D list)
│   │   ├── click row  → setWeightPaintJoint3D(index)
│   │   ├── mouseenter → highlightJoint3D(index)
│   │   └── mouseleave → highlightJoint3D(null)
│   ├── Lighting: [ Lit ] [ Unlit ]  → setWeightPaintUnlit3D(false | true)
│   ├── Show Skeleton [toggle]       → setWeightPaintShowSkeleton(bool)
│   ├── Brush Radius     [slider] → setWeightPaintBrush(radius, strength, weight)
│   ├── Brush Strength   [slider] → setWeightPaintBrush(radius, strength, weight)
│   ├── Target Weight    [slider] → setWeightPaintBrush(radius, strength, weight)
│   └── [Normalize Weights] → normalizeWeights3D(meshId)
│
├── ── Animation Clips ──
│   ├── [+ New Clip]   name / fps / endFrame inputs
│   ├── Clip list      — [Play] [Delete] per row
│   │
│   └── ── Keyframe Editor ──  (when clip selected)
│       ├── Joint #, Channel, Frame inputs
│       ├── [Set Keyframe] / [Remove Keyframe]
│       └── [Record Pose at Frame]
│
├── ── Pose Library ──
│   ├── Name [_______________]  [+ Capture]   → capturePose3D(skelId, name)
│   └── (list from getPoses3D — refresh on sceneGraphChanged)
│       per row: name • [Apply] → applyPose3D(skelId, poseId)
│                               • [Rename] → renamePose3D(skelId, poseId, newName)
│                               • [🗑]     → deletePose3D(skelId, poseId)
│
└── ── Retarget ──           (shown when ≥2 skeletons exist)
    ├── Source clip dropdown
    ├── Target skeleton dropdown
    └── [Retarget]
```

---

## Implementation Notes

### Overlay Activation Flow

`showBoneOverlay3D` works for bare `Skeleton3D` nodes **and** `SkinnedMesh3D`
(after binding). The older `_syncBoneOverlay` path still auto-activates the overlay
when a `SkinnedMesh3D` is selected in the viewport — both paths coexist. If both
trigger, the last call wins; they set the same state.

```
[Armature] button click → enterArmatureMode3D(meshId) → background visible; mesh rotation zeroed; camera framed
Panel selects skeleton  → showBoneOverlay3D(id)        → joints visible; orbit enabled
User clicks mesh (head) → pending joint placed         → "Click tail" hint
User clicks mesh (tail) → sceneGraphChanged            → getSkeletonJoints3D()
User clicks joint       → sceneGraphChanged            → getSelectedJointIndex3D()
User drags joint        → moveBone3D each frame        → sceneGraphChanged on mouseup (orbit suppressed during drag)
Panel closes            → showBoneOverlay3D(null)      → overlay hidden; rotation restored; orbit disabled
```

### Armature Focus Mode Background

When the bone overlay is active, the engine draws a configurable full-screen background
behind the mesh so the user can focus on joint placement without visual noise from the
rest of the scene.  Default is an animated **wavy** pattern (blue + cream).

Use the built-in named presets for the UI dropdown, or pass a custom `ArmatureBgOptions`:

```ts
import { ARMATURE_BG_WAVY_WATER, ARMATURE_BG_WAVY_SAGE } from '../renderer/3d/armature-bg-pass'

// Named presets — use these for the settings dropdown
shapeManager.setArmatureBgMode3D(ARMATURE_BG_WAVY_WATER)  // "Wavy Water" — blue + cream (default)
shapeManager.setArmatureBgMode3D(ARMATURE_BG_WAVY_SAGE)   // "Wavy Sage"  — sage green + cream

// Custom options
shapeManager.setArmatureBgMode3D({ mode: 'solid', color1: [0.08, 0.08, 0.10, 1] })
shapeManager.setArmatureBgMode3D({
    mode: 'gradient',
    color1: [0.08, 0.08, 0.10, 1],   // top color
    color2: [0.18, 0.18, 0.22, 1],   // bottom color
})
shapeManager.setArmatureBgMode3D({ mode: 'dim', dimStrength: 0.55 })  // darken scene
shapeManager.setArmatureBgMode3D({ mode: 'none' })                     // no background
```

**Background modes:**

| Mode | Description | Rendering order |
|------|-------------|-----------------|
| `wavy` | Animated domain-warped wave pattern (default; blue + cream) | Before meshes |
| `solid` | Flat color (`color1`) | Before meshes |
| `gradient` | `color1` (top) → `color2` (bottom) | Before meshes |
| `dim` | Semi-transparent dark overlay | After meshes, before bone overlay |
| `none` | No background, scene visible as normal | — |

**Customising default colors:**
- `color1` — primary / background / top-of-gradient color (Wavy Water default: `[0.72, 0.83, 0.91, 1]` — light blue)
- `color2` — secondary / wave-stripe / bottom-of-gradient color (default: `[0.94, 0.92, 0.85, 1]` — cream)
- Colors are `[r, g, b, a]` in 0–1 range; omit either to use the built-in default
- `dimStrength` — opacity of the dim overlay, 0–1 (default `0.5`)

The background activates either via `enterArmatureMode3D()` (before a skeleton exists)
or automatically when `showBoneOverlay3D(skelId)` is called.
Calling `showBoneOverlay3D(null)` automatically hides it.

**Save this call to a user preference** so it persists across sessions:
```ts
// On settings change:
shapeManager.setArmatureBgMode3D({ mode: userPref.armatureBg, ...userPref.bgColors })
```

### Camera Focus, Rotation Reset, and Orbit — Automatic on Entry

`enterArmatureMode3D(meshId)` and `showBoneOverlay3D(skelId, meshId)` both:

1. **Zero the mesh rotation** — saves `rotationX/Y/Z` then sets them to 0, so the mesh appears front-facing. The save is idempotent: if `enterArmatureMode3D` fires first, `showBoneOverlay3D` skips the save.
2. Save the current camera position + target
3. Frame the mesh (already zeroed, so framing is correct for the canonical pose)
4. Enable orbit controls (if not already active) for the navigation gizmo

```ts
enterArmatureMode3D(meshId)         // ← background + zeroes rotation + saves camera + frames mesh
createEmptySkeleton3D(name)
showBoneOverlay3D(newId, meshId)    // ← joints visible; rotation/camera already handled
enterBonePlacementMode3D(newId)
```

`showBoneOverlay3D(null)` (panel close):
1. Restores the saved mesh rotation
2. Restores the saved camera position
3. **Disables orbit controls** — canvas drag no longer orbits after leaving armature mode

`centerCameraOnMesh3D(meshId)` is still available as a standalone method if you need to re-center mid-session (e.g. after the user pans away).

### Tool Suppression While Bone Overlay Is Active

When a skeleton is shown in the overlay (`showBoneOverlay3D(id)` called), the
engine automatically suppresses the T/R/S gizmo and click-to-select on meshes.
**Do NOT call `disableTransformControls3D()` yourself** — that tears down the
canvas listeners that drive joint drag, tail drag, and bone placement.

`showBoneOverlay3D` also fires `sceneGraphChanged` — check
`getBoneOverlaySkeletonId3D()` in your handler to deselect T/R/S tool buttons
in the Frogmarks UI.

Correct Armature panel open/close lifecycle:

```
[User opens Armature panel / clicks 'Armature' button on mesh settings]
  enterArmatureMode3D(meshId)       ← background; zeroes mesh rotation; saves camera; frames mesh
  createEmptySkeleton3D(name)
  showBoneOverlay3D(newId, meshId)  ← joints visible; starts suppression; enables orbit; emits sceneGraphChanged
  enterBonePlacementMode3D(newId)   ← arms two-click root placement

[Frogmarks sceneGraphChanged handler]
  if (getBoneOverlaySkeletonId3D()) deselect T/R/S buttons

[User closes Armature panel]
  showBoneOverlay3D(null)           ← ends suppression; restores mesh rotation; restores camera;
                                       disables orbit; deactivates background; emits sceneGraphChanged
```

While bone overlay is active:
- **Mesh hover highlight** — suppressed during bone placement mode; normal while dragging joints
- **Mesh click-to-select** — fully suppressed; clicks go to joint/placement logic only
- **T/R/S gizmo axes** — fully suppressed (hidden and non-interactive)
- **Orbit camera** — enabled for the navigation gizmo; automatically disabled (`orbitController.enabled = false`) for the duration of any joint axis, joint head, or tail handle drag so the camera doesn't orbit simultaneously

### Bone Placement Mode

`enterBonePlacementMode3D` intercepts mousedown events on the 3D canvas until placement
is complete.  The number of clicks required depends on context:

- **Root bone** (no parent selected): two clicks — first click = head, second click = tail. Both must land on the mesh; off-mesh clicks are silently ignored and keep the mode alive.
- **Child bone** (parent joint selected): one click = tail (head auto-snaps to parent's tail). Must land on the mesh; off-mesh clicks are ignored.

While in tail-phase for a root bone, the tail follows the cursor live so the user can
preview the bone direction before confirming. The pending joint is added to the skeleton
immediately on the head click and removed automatically if `exitBonePlacementMode3D()`
is called before the tail click.

The intercept happens before normal joint selection / mesh selection logic.
`e.stopPropagation()` is called so downstream handlers see nothing.

If the user presses Escape (or your panel closes), call `exitBonePlacementMode3D()`
to cancel. If a root bone head was already placed (tail phase), the partial joint is
automatically removed from the skeleton.

### ID Stability After `removeBone3D`

`removeBone3D` re-indexes all surviving joints. Any cached joint index in component
state (e.g., `selectedJointIndex`) must be refreshed. Always call
`getSkeletonJoints3D(skelId)` and rebuild the list after any remove.

### Bind Pose vs. Animation Pose

`bindMeshToSkeleton3D` bakes `inverseBindMatrix` from joint world positions **at bind
time**. Moving joints after binding requires re-binding (call `bindMeshToSkeleton3D`
again) for deformation to be correct.

### Clip Serialization

Clips are saved in `skeleton.data.clips[]` and survive project save/load. Each clip
has a stable UUID (`clip.id`) preserved across save/load cycles.

### GLTF Clips vs. Authored Clips

GLTF-imported clips come in through `importSkinnedGltfBuffer` / `importSkinnedGltfFile`
and are stored separately from authored clips. Both can be played via
`playSkeletonClip3D(skelId, clip)`.

### Weight Paint — GLB Meshes

Weight painting works on both hand-built meshes and GLB-imported `SkinnedMesh3D` nodes.
No `makeEditable3D` call is needed — the heatmap reads directly from `jointIndices` /
`jointWeights` and writes `mesh.vertexColors`, which the renderer samples via a dedicated
skinned weight-paint pipeline.

### Weight Paint — Viewport Restrictions

While weight paint mode is active, the following interactions are automatically disabled
in the engine — Frogmarks does not need to suppress them manually:

| Interaction | Behavior |
|-------------|----------|
| Joint head sphere drag | Silently ignored; pointer events for painting take priority |
| Tail handle sphere drag | Silently ignored |
| XYZ transform gizmo | Hidden and non-interactive |
| Other joints/bones in overlay | Hidden; only the selected joint sphere renders |

Call `isWeightPainting3D()` to guard UI controls that should only appear while painting
(brush sliders, joint list for switching, normalize button).

### Weight Paint — New API Summary

| Method | Signature | Description |
|--------|-----------|-------------|
| `setWeightPaintJoint3D` | `(jointIndex: number) → void` | Switch active joint while in weight paint mode; refreshes heatmap |
| `highlightJoint3D` | `(jointIndex: number \| null) → void` | Programmatically highlight a joint cyan (for UI list hover) |
| `isWeightPainting3D` | `() → boolean` | Returns `true` while weight paint mode is active |
| `setWeightPaintUnlit3D` | `(unlit: boolean) → void` | Toggle unlit mode — heat color at full brightness (`true`) or Gouraud-lit (`false`, default) |
| `setWeightPaintShowSkeleton` | `(show: boolean) → void` | Show/hide bone diamonds while in weight paint mode (default `true`) |
