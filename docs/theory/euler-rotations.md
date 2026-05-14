# Euler Rotations, Rotation Order, and Decomposition
**Last Updated:** 2026-05-13

---

## Start Here: Building Up From Zero

This section is for anyone who has never touched 3D math before. It builds every concept from the ground up so the rest of the document makes sense.

### What is a rotation?

Imagine you are holding a book flat on a table. You can spin it left or right — that's rotating around the **vertical axis** running through the center of the table. You can tilt it toward you or away — rotating around an axis pointing left-right across the table. You can roll it to the side — rotating around an axis pointing toward you.

In 3D graphics those three axes have names:

```
Y axis — points straight up (like the pole of the Earth)
X axis — points to the right
Z axis — points toward you out of the screen
```

Any rotation in 3D is a turn by some number of degrees around one of these axes (or a combination). When you say "rotate 30 degrees around Y" you mean "spin the object to the left or right" — like a spinning top, or turning a compass needle.

### What are Euler angles?

Leonhard Euler (1707–1783) proved something very useful: **any orientation in 3D space can be reached by three rotations, each around a single axis**.

So instead of storing some complicated arbitrary spin, you can just store three numbers:
- `rx` — how much to rotate around X (tilt forward/back)
- `ry` — how much to rotate around Y (spin left/right)
- `rz` — how much to rotate around Z (roll left/right)

These three numbers are called **Euler angles**. They're simple, human-readable, and easy to put in a property panel or keyframe. That's why almost every 3D app uses them for its UI.

### The order problem: a kitchen demonstration

Here's the catch. Try this physically:

1. Take your phone and set it face-up on the table.
2. **Tilt it** 90° away from you (rotate around X). Now the screen faces away from you.
3. **Spin it** 90° to the left (rotate around Y). Now the screen faces left.

Now reset, and do the same two rotations in the opposite order:

1. Start face-up on the table.
2. **Spin it** 90° to the left (rotate around Y). Now the bottom edge points away.
3. **Tilt it** 90° away from you (rotate around X). Now the screen faces up — **but rotated 90°**.

You got a completely different final orientation, even though you used exactly the same two angles. **The order matters.** This is not a math quirk — it is a physical reality of 3D rotation. Addition is commutative (3+5 = 5+3) but rotation is not (X then Y ≠ Y then X).

This is the entire reason "rotation order" exists as a concept. If you store three angles, you also have to store the order you intend to apply them.

### What does "apply a rotation" mean in code?

When your code says `rotateY(matrix, angle)`, it is multiplying the matrix by the rotation matrix for Y. A **rotation matrix** is a 3×3 (or 4×4) grid of numbers that, when multiplied with a point's coordinates, moves that point to where it would be after the rotation.

For example, rotating 90° around Y maps:
```
(1, 0, 0) → (0, 0, -1)   (what was to the right is now behind you)
(0, 1, 0) → (0, 1,  0)   (up stays up)
(0, 0, 1) → (1, 0,  0)   (what was in front is now to the right)
```

You can write this as a grid:
```
Ry(90°) = |  0   0   1 |
           |  0   1   0 |
           | -1   0   0 |
```

Every rotation — however complicated — can be written as one of these 3×3 grids. And multiplying two grids together gives you a single grid that does both rotations at once.

So "apply Ry then Rx" means: build the Ry matrix, build the Rx matrix, multiply them together, and you get a single combined matrix. That combined matrix is `Ry · Rx` (read right-to-left: Rx is applied first, then Ry). 

**Why right-to-left?** Matrix multiplication works like function composition. `f(g(x))` means apply g first, then f. When we write `Ry · Rx · point`, the rightmost thing touches the point first.

---

## What is "Decomposition"?

Now here is the important flip side. We just saw how to **compose** (build up a single matrix from multiple rotations). **Decomposition** is the reverse: you start with a finished rotation matrix and you want to find the three Euler angles that would produce it.

### A cooking analogy

Composition is like baking a cake. You have flour, eggs, sugar, and butter — you combine them in order and get a cake.

Decomposition is reverse-engineering a cake you found in a box. You taste it, analyze it, and figure out: "this has about 200g flour, 2 eggs, 150g sugar, 100g butter." You're extracting the original ingredients from the finished product.

Just like there are different ways to make a cake (different recipes), there are different ways to decompose a rotation matrix — one for each possible Euler order. You must use the recipe that matches how the cake was originally baked. If you analyze the cake assuming it was a shortbread (butter-heavy recipe) when it was actually a sponge (egg-heavy recipe), your extracted ingredient list will be wrong — and if you try to bake from that list, you'll get a different cake.

### Why is it needed in Salsa?

A GLB file stores each 3D node's rotation as a **quaternion** (explained later). The Salsa engine stores rotations as three Euler angles (`rotationX`, `rotationY`, `rotation`). So the importer must decompose the quaternion (first converted to a matrix) into Euler angles.

The engine later re-composes those angles back into a matrix — specifically using the **YXZ order** (`Ry · Rx · Rz`). For this roundtrip to be lossless:

```
GLB quaternion
     ↓  (convert to matrix)
rotation matrix
     ↓  decompose using YXZ formulas  ← must match engine
(rx, ry, rz) stored on Mesh3D
     ↓  compose via Ry · Rx · Rz     ← engine's updateLocalMatrix
rotation matrix  ← must equal original
```

If you decompose using the ZYX formula but compose using YXZ, you get a **different matrix** at the end. The object lands in the wrong orientation. That was the bug.

### What does a decomposition formula actually look like?

Once you have multiplied out the full rotation matrix for a given Euler order, some matrix entries have simple relationships to the individual angles. For the YXZ order (`R = Ry · Rx · Rz`), the full matrix is:

```
Row 1:  [ cx·sz,   cx·cz,   -sx ]
```

Row 1, Column 2 is just `-sin(rx)`. Nothing else — no `ry` or `rz` mixed in. So you can extract rx exactly by reading that one cell:

```
r[1][2] = -sin(rx)   →   rx = asin( -r[1][2] )
```

That's it. That's a decomposition formula. It's just reading a specific cell of the matrix and applying an inverse trig function.

For a **different** Euler order (ZYX, `R = Rz · Ry · Rx`), a different cell happens to contain the isolated sine. In that case it's Row 2, Column 0:

```
r[2][0] = -sin(ry)   →   ry = asin( -r[2][0] )
```

The formulas look almost identical but they refer to **different cells** and extract **different angles**. If you mix them — reading the ZYX cell but feeding the result into an engine that expects YXZ angles — you get slightly wrong output that's hard to debug because it often looks almost right for simple rotations.

---

## Intuition

A rotation in 3D can be described as "turn left by 30°, then tilt up by 15°, then roll right by 10°". That's three separate rotations, each around one axis — and that's exactly what Euler angles are.

The problem is hidden in the word "then". The final orientation depends not just on the three angles, but on **which order you apply them**. Turning left then tilting up is a different orientation than tilting up then turning left. This is not a bug or an edge case — it is a fundamental property of 3D rotation.

---

## Rotation Order

Given three angles (rx, ry, rz) around the X, Y, and Z axes, there are 6 possible orderings. Some common ones:

| Name | Matrix form | Also called |
|---|---|---|
| XYZ intrinsic | Rx · Ry · Rz | ZYX extrinsic |
| YXZ intrinsic | Ry · Rx · Rz | ZXY extrinsic |
| ZYX intrinsic | Rz · Ry · Rx | XYZ extrinsic |
| XZY intrinsic | Rx · Rz · Ry | YZX extrinsic |

**Intrinsic** means each rotation is applied around the axes of the **current (already-rotated) frame** — the axes move with the object. The matrix is right-to-left (innermost rotation is applied first).

**Extrinsic** means each rotation is applied around the **fixed world axes**. The matrix is left-to-right.

The important thing: both ways of thinking produce the same set of rotations, just with the names swapped. "Intrinsic YXZ" and "extrinsic ZXY" are identical matrices. Pick whichever is more intuitive for the context.

---

## Why It Matters: The Same Angles, Different Results

Let rx = 45°, ry = 30°, rz = 0°.

**YXZ order (Ry first, then Rx):**
1. Start at identity
2. Rotate 30° around world Y → object now faces a different direction
3. Rotate 45° around the object's *current* X axis (which has moved) → tilts along the new forward

**XYZ order (Rx first, then Ry):**
1. Rotate 45° around world X → object tilts forward
2. Rotate 30° around world Y → object turns left, but the tilt now also picks up a lateral component

The two procedures produce **different final orientations** from the same (rx=45°, ry=30°) input. If you record the angles from one decomposition and feed them to a system expecting a different order, the mesh lands in the wrong pose.

---

## The Rotation Matrix Formulas

For each convention, here is the combined 3×3 rotation matrix. Elements are indexed as r[row][col].

### YXZ intrinsic: R = Ry · Rx · Rz

This is the order Salsa's engine uses.

```
Ry = | cy   0   sy |      Rx = | 1   0    0  |      Rz = | cz  -sz  0 |
     |  0   1    0 |           | 0   cx  -sx |           | sz   cz  0 |
     |-sy   0   cy |           | 0   sx   cx |           |  0    0  1 |
```

Combined R = Ry · Rx · Rz:

```
Row 0:  [ cy·cz + sy·sx·sz,   -cy·sz + sy·sx·cz,   sy·cx ]
Row 1:  [ cx·sz,               cx·cz,              -sx    ]
Row 2:  [-sy·cz + cy·sx·sz,    sy·sz + cy·sx·cz,   cy·cx  ]
```

Key extractions:
- `r[1][2] = -sin(rx)` → **rx = asin( -r[1][2] )**
- `r[0][2] = sin(ry)·cos(rx)`, `r[2][2] = cos(ry)·cos(rx)` → **ry = atan2( r[0][2], r[2][2] )**
- `r[1][0] = cos(rx)·sin(rz)`, `r[1][1] = cos(rx)·cos(rz)` → **rz = atan2( r[1][0], r[1][1] )**

In Salsa's column-major mat4 (gl-matrix), with scale pre-divided:
```
rx = asin( -m[9]  / sz_col2 )
ry = atan2(  m[8]  / sz_col2,  m[10] / sz_col2 )
rz = atan2(  m[1]  / sx_col0,  m[5]  / sy_col1 )
```

### ZYX intrinsic: R = Rz · Ry · Rx

Combined R = Rz · Ry · Rx:

```
Row 0:  [ cy·cz,   cz·sx·sy - cx·sz,   cx·cz·sy + sx·sz ]
Row 1:  [ cy·sz,   cx·cz + sx·sy·sz,   cx·sy·sz - cz·sx ]
Row 2:  [-sy,      cy·sx,               cx·cy            ]
```

Key extraction: `r[2][0] = -sin(ry)` → **ry = asin( -r[2][0] )**

This is why the old Salsa importer code used `asin(-r20)` — it was applying the ZYX formula, not the YXZ formula.

---

## The Bug: Mismatched Decompose vs. Compose Order

The GLB importer reads a node's world matrix and must convert it into (rx, ry, rz) that the engine can later re-compose via `Ry · Rx · Rz`. The roundtrip must be an identity:

```
decompose(worldMatrix)  →  (rx, ry, rz)
                         ↓
compose(rx, ry, rz) via Ry·Rx·Rz  =  worldMatrix  ✓ only if decompose also uses YXZ
```

If you decompose using the ZYX formula and compose using YXZ, the roundtrip is wrong for any mesh whose rotation has non-zero angles on more than one axis simultaneously. For axes that only rotate around a single axis, the formulas coincidentally agree (a pure Ry rotation produces a matrix with the same non-trivial element regardless of the assumed order). That's why "most" mesh parts import correctly — they have trivial rotations — while parts with combined XY rotations (like eyes on a head node chain) land in the wrong place.

**The fix in `gltf-importer.ts`:** `decomposeWorldMatrix` now uses `asin(-r12)` and `atan2(r02, r22)` / `atan2(r10, r11)` — the correct YXZ formulas.

---

## Quaternions: Why They Avoid This Problem

A quaternion is a 4-component value (x, y, z, w) that encodes an arbitrary rotation as "rotate by angle θ around axis (x,y,z)":

```
q = (sin(θ/2)·nx,  sin(θ/2)·ny,  sin(θ/2)·nz,  cos(θ/2))
```

Quaternion multiplication composes rotations without any concept of "order around X, Y, Z". The composition order is explicit in the multiply: `q_total = q2 * q1` means "apply q1 first, then q2".

Quaternions have two major advantages over Euler angles:

1. **No order ambiguity** — there is no "XYZ vs YXZ" issue. A quaternion is a self-contained rotation.
2. **Smooth interpolation** — SLERP (spherical linear interpolation) between two quaternions produces the shortest-arc rotation. Euler angle lerp produces non-uniform speed and can take the long way around.

The GLB format stores node rotations as quaternions for exactly these reasons. The importer must convert them to Euler angles for Salsa's property system — which is where the order must match.

Salsa's `TransformController3D` internally accumulates rotations as quaternions (`eulerYXZtoQuat` / `quatToEulerYXZ`) and only converts back to Euler at the end of a drag. This prevents gimbal lock and drift from accumulating during interactive rotation.

---

## Gimbal Lock

Gimbal lock occurs when two rotation axes become aligned due to an intermediate rotation, collapsing the 3-DOF system to 2 DOF. For YXZ:

When rx = ±90°, cos(rx) = 0, so:
- `r[1][0] = cos(rx)·sin(rz) = 0`  
- `r[1][1] = cos(rx)·cos(rz) = 0`

The atan2 for rz gets `atan2(0, 0)` — undefined. You've lost the ability to distinguish ry from rz because rotating 90° around X has aligned Y and Z.

In gimbal lock, the convention is to absorb the total ry+rz rotation into ry and set rz = 0. This is an arbitrary choice (any split works), but it makes the decomposition deterministic.

The practical impact on Salsa: meshes with rx at exactly ±90° (looking straight up or down) will have their ry and rz redistributed, which looks correct visually but means the stored angles don't match the original authoring intent. This is rare in practice for static mesh imports.

---

## How Salsa Uses This

### Engine (composition)

`Shape.updateLocalMatrix()` in `src/scene-graph/shapes/base/shape.ts`:
```typescript
mat4.translate(this._localMatrix, this._localMatrix, [this.x, this.y, this.z]);
if (this.rotationY !== 0) mat4.rotateY(..., this.rotationY);  // Ry first
if (this.rotationX !== 0) mat4.rotateX(..., this.rotationX);  // then Rx
mat4.rotateZ(..., this.rotation);                              // then Rz
// = Ry · Rx · Rz
```

### GLB Importer (decomposition)

`decomposeWorldMatrix()` in `src/renderer/3d/gltf-importer.ts`:
```typescript
// Accumulates world matrix through node hierarchy, then decomposes:
rx = asin(-r12);         // r12 = m[9]/sz  (Row 1, Col 2)
ry = atan2(r02, r22);    // r02 = m[8]/sz,  r22 = m[10]/sz
rz = atan2(r10, r11);    // r10 = m[1]/sx,  r11 = m[5]/sy
```

### Interactive Rotation (quaternion path)

`TransformController3D.handlePointerDown` / `applyRotate()`:
```typescript
// Drag start: convert initial Euler → quaternion
initialQuats.set(m.id, eulerYXZtoQuat(init.ry, init.rx, init.rz));

// Each frame: compose initial quat with delta rotation
const qDelta = quat.setAxisAngle(quat.create(), rotAxis, angle);
const qNew   = quat.multiply(quat.create(), qDelta, q0);

// Drag end: convert back to Euler (YXZ order)
const [rx, ry, rz] = quatToEulerYXZ(qNew);
mesh.rotationX = rx; mesh.rotationY = ry; mesh.rotation = rz;
```

### Gizmo Orientation and Local Basis

When the gizmo is in Local mode, `TransformController3D` extracts the mesh's local axes from `localMatrix` column vectors (which encode the post-TRS orientation). Normalising those columns strips scale and gives the pure rotation axes, which are then used to build `localBasis { x, y, z }` for constrained dragging. This is equivalent to extracting the rotation matrix columns — the same math as `decomposeWorldMatrix` but without the angle step.

---

## Summary Table

| Where | Operation | Convention |
|---|---|---|
| `shape.ts` updateLocalMatrix | Compose | YXZ intrinsic (Ry · Rx · Rz) |
| `gltf-importer.ts` decomposeWorldMatrix | Decompose | YXZ intrinsic (matches engine) |
| `transform-controller-3d.ts` eulerYXZtoQuat | Euler → quat | YXZ intrinsic |
| `transform-controller-3d.ts` quatToEulerYXZ | Quat → Euler | YXZ intrinsic |
| `gltf-importer.ts` node.rotation | Input (from GLB) | Quaternion (no order issue) |
| GLTF 2.0 spec | File format | Quaternion XYZW |

The rule: **every Euler ↔ matrix conversion in Salsa uses YXZ intrinsic order**. Any new code that decomposes a rotation matrix into Euler angles must use `asin(-r[1][2])` as the rx extraction, not `asin(-r[2][0])`.

---

## Related Docs

- [Coordinate Spaces](coordinate-spaces.md) — model/world/view/clip space chain
- [gizmo-orientation spec](../specs/gizmo-orientation.md) — World vs Local gizmo modes; local basis extraction
- [GLTF Import spec](../specs/gltf-import.md) — how node hierarchy transforms are accumulated before decomposition
