# Spring Bones (dynamic hair / cloth)

Spring bones are **dynamic ("jiggle") bones** — a chain of skeleton joints that, each frame, swings toward
its rest (FK) pose with **inertia + gravity** and is **collision-resolved** against the body, then settles.
Rotation-only (bones keep their length). They're what makes a ponytail trail behind a turning head or a skirt
swish on a kick. This is the same model as **VRM Spring Bone** / Unity Dynamic Bone.

They live **in the armature** (on `SkeletonData`), so they persist, are authored in Edit Armature, and are
reusable for hair, cloth, accessories, tails — not hair-specific.

## Evaluation order

Spring bones extend the existing per-frame skeleton pipeline (see `constraint-solver.ts`):

1. **FK** — `skel.computeWorldMatrices()`
2. **IK** — `solveAllIKChains()`
3. **Constraints** — `solveAllConstraints()` → `computeWorldMatrices()`
4. **Spring bones** — `solveSpringBones(skel, dt)` ← world-space physics on the already-posed skeleton

Driven by a **pre-render callback** in `scene3d-manager` (registered after the IK callback). It runs for any
skeleton with enabled spring chains — **not gated on armature editing** (hair jiggles during normal viewing) —
and returns `true` while anything is still moving, so the renderer keeps ticking until it **settles, then idles**
(no busy loop; `addPreRenderCallback` returning `true` schedules the next frame).

## Data model (`src/types/armature-3d.ts`)

```ts
interface SpringChain {
  id: string;
  jointIndices: number[];   // ROOT first → tip; each is simulated, the root's PARENT is the anchor
  stiffness: number;        // 0..1 — spring-back toward the FK pose
  drag: number;             // 0..1 — velocity damping (settles faster)
  gravity: number;          // world units / 60fps-frame along gravityDir
  gravityDir: [number,number,number];   // usually [0,-1,0]
  hitRadius: number;        // the hair/cloth's own thickness, added to every collider radius
  enabled: boolean;
}
interface SpringCollider {
  jointIdx: number;                       // body joint it's parented to
  offset: [number,number,number];         // sphere centre (or capsule start) in that joint's LOCAL frame
  radius: number;
  tail?: [number,number,number];          // present → CAPSULE from offset → tail (local frame)
}
```

Both are on `SkeletonData` (`springChains?`, `springColliders?`) and **serialized** in `skeleton-3d.ts`
`toJSON`/`fromJSON`. Ephemeral per-joint tip state (Verlet) lives in a `WeakMap` inside the solver — never on
the serialized skeleton.

## Solver (`src/renderer/3d/spring-bone-solver.ts`)

`solveSpringBones(skel, dt): boolean` — per chain, **root → tip**, per joint:

1. `head` = `parent.worldMatrix × localPosition` (the joint origin; rigid — only the tip swings).
2. `restTip` = the FK rest-pose tip (where the bone points with no physics).
3. **Verlet**: `next = curr + (curr − prev)·(1−drag)` (inertia) `+ (restTip − curr)·stiffness·step` (spring-back)
   `+ gravityDir·gravity·step`.
4. **Rigid length**: re-pin the tip to exactly `boneLength` from `head`.
5. **Collision**: for each collider, closest point on its capsule segment → if within `radius + hitRadius`,
   push the tip out, then re-pin the length.
6. Re-derive the joint's **worldMatrix** (rotate the rest bone dir → the resolved tip dir) + its **skinMatrix**.

`step = clamp(dt·60, 0.2, 2.5)` makes the swing **framerate-independent**. Because the length is re-pinned
every frame, the tip can't fly off — the chain is bounded, so bad params read as jittery/too-stiff, never an
explosion. `resetSpringState(skel)` clears the tip state (call when chains change so they re-seed from rest).

## Hair integration (auto)

Procedural hair tails build their own chains on `setHairParams3D` (`scene3d-manager._buildHairSpringRig`):

- `generateHair` returns `tailBones` (per tail, a chain of **draped** rest positions sampled from the
  post-shrink-wrap tail) + `tailVertId` (which tail each vertex belongs to).
- Each tail → a **4-joint chain** appended to the skeleton (root parented to the head). All tail joints inherit
  the head's bind rotation → identity local rotation + pure-translation local position, and
  `inverseBind = inverse(compose(Rh, Pᵢ))` so the skin matrix is identity at rest (the hair sits exactly on the
  draped tail). The tail mesh is skinned **2-bone graduated** along the chain by `uv.v` (root→tip); the
  cap/bangs/sidelocks stay 100% on the head.
- A `SpringChain` per tail + default body colliders (head / chest / hips spheres) via `_ensureBodySpringColliders`.
- **Rebuild lifecycle:** the tail joints are appended at the **end** of the joint list, so on a live rebuild
  they're removed with `Skeleton3D.truncateJoints(base)` (drops the trailing joints — never re-indexes the body
  joints, unlike `removeJoint`). Reload-safe: the skeleton persists the tail joints + chains, and
  `restoreHairRigs` → `setHairParams` truncates + rebuilds them fresh.

## Authoring API (`shapeManager`, for Edit Armature)

`createSpringChain3D(skelId, jointIndices, params?)` · `setSpringChainParams3D` · `removeSpringChain3D` ·
`getSpringChains3D` · `addSpringCollider3D` · `removeSpringCollider3D` · `getSpringColliders3D`. See
`docs/ui/armature.md` → **Spring Bones** for the param ranges and the recommended Frogmarks panel.

**Visual:** a bone in an enabled spring chain draws **light blue** in the armature overlay
(`gizmo-renderer.ts` `COL_SPRING_BONE`), instead of the normal beige — so jiggle bones are obvious, and
disabling a chain reverts its bones to beige.

## Follow-ups (not yet done)

- **Capsule colliders from the body fit** — the hair default colliders are rough spheres; the torso would be
  better as a capsule built from `_buildBodyFit` joint radii.
- **Dynamic skirts** — a skirt is currently a rigid hips-weighted cone (`buildSkirt`); the proper swishy skirt
  is a **ring of spring chains** (a cage) + leg capsule colliders, reusing this system. See `docs/ui/clothing.md`.
- **VRM springbone export** — map `springChains`/`springColliders` to the glTF `VRMC_springBone` extension.
- **Default tuning** — `stiffness 0.6 / drag 0.55 / gravity 0.004 / hitRadius head.rx·0.18`, pending live feel.
