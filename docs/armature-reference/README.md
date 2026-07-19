# Armature Reference Data — captured poses + body context

A working library of **real captured poses** (joint quaternions) tagged with the **body** they were authored on, used to bake reliable poses/clips into [`src/services/managers/default-animations.ts`](../../src/services/managers/default-animations.ts) and to author new animations from known-good data. This is what replaces "Claude guesses arm angles blind."

**Roadmap:** [pose-animation-catalog.md](pose-animation-catalog.md) — the full list of poses to capture + the animations they build (BotW/Animal-Crossing style), tiered by priority.

## The capture workflow
1. Make a character, open **Edit Armature**, pose it (FK gizmos or IK handles).
2. Click **"Copy pose + body for Claude"** — wires to:
   - `shapeManager.exportPoseData3D()` → per-joint `quat[x,y,z,w]` + Euler° for every joint off rest (effective FK/IK rotation).
   - `shapeManager.exportBodyData3D()` → body params (mesh shape) + rest bone lengths (arm/leg/torso).
3. Paste both here (or to Claude) with a one-line description ("left hand on hip"). Claude bakes the exact quats.

## Why body context matters
Poses split into two kinds:
- **Orientation** (wave, cheer, stretch, breathe, sway, look) — body-independent. The rotation is the same on any body; bake once.
- **Hand-on-body** (hands on hips, scratch head, hand to chin) — body-dependent. A fixed rotation lands the hand at a spot set by arm reach + where the hip/head is, so different proportions drift the hand off/into the surface. These either need the body recorded (to tune) or **IK-from-a-landmark** authoring (auto-adapts). Always capture body data for these.

## Adaptive hand-on-body poses — GIRTH BLEND (not IK)
Hand-on-body poses fit any body by **blending real captured poses** by a body metric — NOT by IK.

> **Why not IK?** "Hand on hip" is redundant (many joint configs reach the same spot). FABRIK picks one — and for a wide body it picked a straight-out splay (arms flung wide). A blend of *chosen-good* captured poses can't do that: endpoints are exact, in-betweens are a smooth slerp.

- A pose carries `adaptive: { metric: 'girth', samples: [{ at, left }] }` (`SkeletonPose.adaptive`, serialized). Each sample is a LEFT-arm capture at a known `girth`; the right arm is mirrored `[x,-y,-z,w]`.
- **`girth` = `torsoThick + hipWidth`** (the two params that drive hip-surface width). Observed: as girth ↑, the shoulder abducts LESS and the elbow bends MORE (a wider torso brings the elbow in).
- On `applyPose`, `_applyAdaptivePose` reads the body's girth, slerps the two bracketing samples (clamped outside the range), and writes the arm joints. Adapts live to `setBodyParams3D`.

**The "library of body-part pairs"** = each adaptive pose accumulates girth-tagged samples. To improve coverage, pose the character on a new body type, capture (pose + body), and add a `{ at, left }` sample. To add a *new* pose (one-hand-on-hip, etc.), capture 2 endpoints (thin + fat) and it adapts.

| Pose | Samples (girth) |
|---|---|
| Hands on Hips | thin `1.7`, fat `2.5` ✅ |
| _(scratch head, thinking — capture thin+fat when ready)_ | ⬜ |

_Capture more body types → more samples → better blend. The endpoints are always exact user poses._

## Rotation conventions (CONFIRMED from screenshots — see [[project_default_animations]])
Arms rest straight OUT along ±X (T-pose). Torso/head rest at identity.
- `qz` = raise/lower an arm in the frontal plane. **Right arm: `qz(-90)` = straight up, `qz(+50..+90)` = down. Left mirrored (`+` up).** `|qz|>90` crosses past the centreline (two arms → they cross).
- `qx` = tilt the arm forward (−) / back (+).
- `qy` = elbow hinge — BUT a real elbow bend often lives largely on **Z** (see hands-on-hips), not Y. Trust captured data over the axis label.
- Torso/head: `qx`=nod, `qy`=turn, `qz`=lean.

## Mirror a one-sided pose to the other arm
`[x, y, z, w]` → `[x, -y, -z, w]` (reflect across the body's YZ symmetry plane). Verified against the rig. Use to build a both-arms pose from a single captured side.

## Gotchas
- **Poses bake at character CREATE** (`createProceduralBody3D` → `installDefaultAnimations`). Edits only show on a **freshly-made** character.
- The default elbow/knee `limitRotation` constraints were **removed** (their ±20° off-axis clamp killed natural elbow posing). Add back per-joint only if needed.
- Ignore `springTail_*` / `springCharm_*` joints in exports — those are dynamic hair/charm bones, not pose.

## Index
| Pose | File | Kind | Baked? | Body-tagged? |
|---|---|---|---|---|
| Hands on Hips | [hands-on-hips.md](hands-on-hips.md) | hand-on-body | ✅ default-animations | ✅ body a402cebe (height:0.5, hipWidth:1, thin) |
| Hand Behind Head | [hand-behind-head.md](hand-behind-head.md) | hand-on-body (head) | ✅ default-animations | ✅ body a18a93c8 (headSize:0.95); 3 wrist variants on file |

_Add a row + a `<pose>.md` per capture._
