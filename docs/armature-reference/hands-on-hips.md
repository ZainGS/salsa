# Hands on Hips

**Kind:** hand-on-body (body-dependent) · **Baked into:** `default-animations.ts` → `POSES['Hands on Hips']` · **Captured:** 2026-06-29

A confident akimbo stance — both fists on the hips, elbows winged out. Captured as **left hand on hip** (right arm was left relaxed), then **mirrored** to the right via `[x,-y,-z,w]`.

## Body context (captured 2026-06-29, skeleton 4a3dd216, body a402cebe)
A small, thin, flat build — note `height:0.5` scales the skeleton (bone lengths below are post-scale).
```
params: {"height":0.5,"limbThick":0.75,"torsoThick":0.7,"headSize":1.08,"legLength":0.85,
         "torsoLength":0.8,"bust":0,"waist":0.65,"hipWidth":1,"hipFront":0.75,
         "shoulderWidth":1.1,"buttSize":0}
rest measures (world units): upperArm=0.133 forearm=0.115 thigh=0.178 shin=0.178
                             hipsToNeck=0.184 neckToHead=0.050
```
This is the REFERENCE body the baked rotations are exact on. Drift to expect on other bodies scales mainly with **hipWidth** (lateral) and **torsoLength/legLength** (hip height vs arm reach). bust/buttSize don't touch where the hand sits.

## Captured pose (left arm = exact export; right arm = mirrored `[x,-y,-z,w]`)
Source: `exportPoseData3D` on skeleton 4a3dd216. The elbow bend is **−87° on Z** (not Y!) — this is why the default elbow `limitRotation` (±20° Z clamp) had to be removed; it blocked the bend entirely.

```
shoulder_L  [-0.0495, 0.1215, -0.3609, 0.9233]  euler°(-10.5, 10.9, -43.7)
lowerarm_L  [-0.0521, -0.0466, -0.6872, 0.7231]  euler°(-0.7, -8.0, -87.0)   ← elbow bend on Z
hand_L      [0.1806, -0.0347, 0.3185, 0.9299]    euler°(18.6, -10.4, 36.1)
shoulder_R  [-0.0495, -0.1215, 0.3609, 0.9233]   (mirror of L)
lowerarm_R  [-0.0521, 0.0466, 0.6872, 0.7231]    (mirror of L)
hand_R      [0.1806, 0.0347, -0.3185, 0.9299]    (mirror of L)
```

Torso/head from the capture were tiny (<4°, incidental) → dropped; pose keeps the torso at rest so it composes cleanly.

## Adaptive: GIRTH BLEND ✅ (IK was abandoned — it splayed the arms)
First attempt IK-solved the hands onto a hip landmark; "hand on hip" is redundant so FABRIK splayed the arms straight out on a wide body. Pivoted to **blending two captured poses by `girth = torsoThick + hipWidth`** (see [README.md](README.md)). Endpoints are exact; in-between bodies slerp.

**Sample 1 — thin (girth 1.7)** — body a402cebe (above):
```
shoulder_L [-0.0495, 0.1215, -0.3609, 0.9233]
lowerarm_L [-0.0521, -0.0466, -0.6872, 0.7231]
hand_L     [0.1806, -0.0347, 0.3185, 0.9299]
```
**Sample 2 — fat (girth 2.5)** — body c3174762, params `{height:0.62, torsoThick:1.35, hipWidth:1.15, bust:1, buttSize:1, waist:0.86, hipFront:0.86, …}`, user-posed:
```
shoulder_L [0.0000, 0.0000, -0.1296, 0.9916]   euler°(0,0,-14.9)   ← less abduction
lowerarm_L [0.0000, 0.0000, -0.8046, 0.5938]   euler°(0,0,-107.1)  ← more elbow bend
hand_L     [0.0000, 0.0000, 0.3288, 0.9444]    euler°(0,0,38.4)
```
Pattern: girth ↑ → shoulder abducts LESS, elbow bends MORE. Right arm mirrored from left in both. Add a 3rd sample (e.g. a very lean/athletic body) if the mid-range needs it.
