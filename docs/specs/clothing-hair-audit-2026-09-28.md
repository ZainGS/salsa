# Clothing + hair — measured audit (2026-09-28)

**Status:** audit complete; **clothing fixes BUILT + gated** (see *Range-of-motion sweep + fixes* at the end — the tables
directly below are the BEFORE); hair (finding 2) and skirt weights not yet. Measured, not read: every number comes from
`src/services/managers/clothing-hair-audit.test.ts`, which generates a real body + every garment preset + hair styles in
Node, poses them through the **same skinning math the GPU uses** (`skinMatrixForTS`), and counts problems. Re-run:

```
AUDIT_OUT=report.txt  npx vitest run src/services/managers/clothing-hair-audit.test.ts    # the tables below
AUDIT_DRILL=drill.txt npx vitest run src/services/managers/clothing-hair-audit.test.ts    # the root-cause drill-down
```

Enabling refactor: `Scene3DCharacter._buildBodyFit`'s computation moved verbatim into the pure `buildBodyFitFrom()`
(the class now calls it) so garments can be fitted without a live mesh — the full suite confirms no behaviour change.

## Method

- **Clothing poke-through:** body vertices that are *inside* a garment at rest (a garment vertex within 4 cm, body on
  its inner side) and end up **> 3 mm outside** it when posed — skin showing through fabric. Reported as
  `count (% of covered) / max depth mm`.
- **Hair penetration:** head-skinned (rigid) hair vertices that end up **> 4 mm inside** the torso / shoulders / arms
  (head + neck skin excluded — hair is supposed to touch those).
- Two configs: **NEW** (seam blend 0.5 + dual-quaternion — what new characters get) and **CLASSIC** (0 + linear).
- Poses: rest, Relaxed, A-pose, arms up 70°, elbows 90°, walk (one leg forward, one back + knee bent), sit (hips + knees
  90°), torso twist; head: look left/right 60°, look down, tilt left/right 25°.

## Findings, ranked

### 1. 🔴 Trousers: skin shows through at the seat/hips when walking or sitting — every trouser style
| Garment | walk (NEW) | sit (NEW) | walk (CLASSIC) | sit (CLASSIC) |
|---|---|---|---|---|
| Shorts | **24%** / 34 mm | 21% / 33 mm | 22% / 34 mm | 17% / 32 mm |
| Pants | 13% / 33 mm | 13% / 36 mm | 13% / 33 mm | 12% / 39 mm |
| Baggy Jeans | 17% / 35 mm | 16% / 25 mm | 16% / 35 mm | 19% / 39 mm |
| Skinny | 12% / 33 mm | 12% / 36 mm | 12% / 33 mm | 11% / 39 mm |
| Wide Leg | 10% / 25 mm | 5% / 21 mm | 10% / 25 mm | 4% / 8 mm |

**Up to 3–4 cm of body through the fabric**, same in both configs, so it isn't the skinning method — it's the
garment's weights. **Root cause (drill-down):** the poking skin is mostly **hips**-bound (Pants walk: 24 of 36; Shorts:
40 of 44 — the seat/pelvis), while the fabric right over it is bound to the **thighs** (Pants: 192 vertices per leg
follow the thighs vs only 48 follow the hips). When a leg swings, the cloth over the seat goes with the thigh and the
body's seat stays with the hips. Same bug class as the body's armpit seam. **Likely fix:** give the trouser top (the
pelvis/seat band) the body's own hip weights — the crotch-fill rings are deliberately kept per-leg (`noXfer`, so the
legs can split), and that protection probably extends over the whole seat; narrow it to the inner crotch and/or blend
the band hips→thigh like the body's seam blend. Confirm by reading `buildLegs` before changing.

### 2. 🟠 Shoulder-length (and longer) hair goes into the shoulders when the head moves
| Style | rigid verts | rest | look L/R | look down | tilt L | tilt R |
|---|---|---|---|---|---|---|
| Long to shoulders (NEW) | 2293 | **3 / 33 mm** | 38 / 37 mm | 13 / 16 mm | **151 / 50 mm** | 119 / 49 mm |
| Long to shoulders (CLASSIC) | 2293 | 2 / 29 mm | 33 / 34 mm | 32 / 33 mm | 142 / 47 mm | 128 / 47 mm |
| Twintails / bob / front drape / shorter long cuts | | 0 | 0–(≤20) | ≤2 | ≤25 | ≤25 |

Real, but **only for hair long enough to reach the shoulders** — the default and shorter styles are essentially clean.
Cause: scalp-length hair is skinned 100% to the head (only tails and the front drape get spring bones), so when the head
tilts the hanging ends swing into the shoulder. Even at rest 2–3 verts clip ~3 cm (the rest-pose push-out misses them).
**Likely fix (audit C6):** grade long scalp hair's weights head → neck → chest down its length (the front drape already
does this for its wrap), or give it spring chains; add a rest-pose push-out pass against the shoulders.

### 3. 🟡 Long skirt: 5% / 14 mm when sitting (NEW)
Expected — skirts use fixed analytic weights, not the body's (audit C6). Low priority.

### 4. 🟢 Tops: minor
≤ 3% of covered skin, ≈1 cm, in Relaxed / elbows-bent (sleeve at the armpit). CLASSIC is slightly worse with arms up
(Tank / Long Sleeve 2–4%, ~2 cm) — the new seam blend + DQS helps here.

### 5. ✅ Shoes and socks: perfect
Zero poke-through in every pose, both configs (all 6 shoe and 5 sock presets).

### 6. ✅ No garment clips at rest
Every garment, both configs: 0 poke-through in the rest pose — the rest-pose fit/de-collision works. The problems are
all **pose-dependent** (weights), not fit.

## What the measurement did not cover
- **Spring hair** (tails, drape tips) — it's simulated at runtime; this audit poses statically. Its rest chains are
  head-attached, so the static numbers are its un-simulated baseline only.
- **Charms/attachments** and **hair colliding with clothing** (only the body is used as the collider here).
- **Code-level issues already known from the character audit** (not measurable this way): every slider nudge destroys and
  rebuilds every garment (C7); new garment *types* (hoods, jackets) need a new builder each (extensibility).

## Recommended order
1. **Trouser seat weights** (finding 1) — biggest visible problem, every trouser, likely a targeted weight fix.
2. **Long-hair grading** (finding 2 / C6).
3. Skirt weights (finding 3 / C6), then sleeves (finding 4) if still visible after the new skinning.

Each fix is re-measured with the same test — the tables above are the before.

## Range-of-motion sweep + fixes (2026-09-28, built)

A wider sweep, so posed animation can rely on the clothes: **every garment preset × 26 poses** — arm raises / forward /
back / cross-body, elbow flex, walk, run, kicks, side raise, splits, knee 130°, sit, squat, lunge, torso bend / arch /
side-bend / twist, and three combos. Shared harness `clothing-audit-harness.ts`; report
`AUDIT_ROM=rom.txt npx vitest run src/services/managers/clothing-rom-sweep.test.ts`. New metric besides poke-through:
**tear** = % of garment triangles stretched > 2× or flipped, compared with the SKIN's own % under the garment
(garment ≈ skin = inherent to the pose; garment ≫ skin = a garment bug).

### Fixes (all only on seam-blended = NEW bodies; classic garments verified bit-identical to the previous code for every preset)
| Problem (measured) | Cause | Fix |
|---|---|---|
| Trouser seat skin shows walking/sitting (24% / 3–4 cm) | crotch protection (`noXfer`) covered the whole ring → seat pinned to the thigh | protect only the inner ±60° sectors, and only verts on their own side of the midline |
| Undershirt: skin at the arm socket in 25 poses | offset-built base layers never took the body's new blended weights | `inheritBlendedBodyWeights` |
| Tops tear at the waist bending forward (Tank 10% vs skin 2%) | weights copied from the NEAREST body vertex; waist rings are ~14 cm apart, so garment rings snapped between them | torso garments interpolate the body's weights over the closest body TRIANGLE (`surfaceWeightsAt`) |

Tried and **rejected by the numbers**: triangle interpolation on trousers (knee rings ~19 cm apart + 110° squat → fabric
sank ~1.5 cm into the thigh), a distance ramp for it (worse on tops), fading crossed-over crotch verts to hips (squat
tear doubled).

### After (NEW config — worst over 26 poses)
| Garment | worst poke | tear: garment vs skin | | Garment | worst poke | tear |
|---|---|---|---|---|---|---|
| Tee | 3% / 9 mm | 3.7% vs 2.8% | | Shorts | 9% / 13 mm | 30% vs 16% (squat) |
| Crop | 5% / 9 mm | 8.1% vs 3.8% | | Pants / Skinny | 7% / 20 mm | 10% vs 3% (squat) |
| Tank | 3% / 8 mm | 4.2% vs 1.9% | | Baggy Jeans | 5% / 28 mm | 10.5% vs 3% (squat) |
| Long Sleeve | 4% / 19 mm | 4.1% vs 0.6% | | Wide Leg | 7% / 29 mm | 3.2% vs 0% |
| Undershirt | 3% / 4 mm | 4.8% vs 2.2% | | Long skirt | 5% / 14 mm | 0 |
| Underpants | 1% / 13 mm | 12.7% vs 11.1% | | Mini skirt, all shoes, all socks | 0 | ≈0 |

### Still open
- **Deep squat / knee bend on shorts & trousers** — stretch at the knee band (the skin stretches there too: 16% for
  shorts). Knee body rings are ~19 cm apart; a real fix is denser body rings around the knee (C4 topology) or a
  knee-specific garment weight profile.
- **Long Sleeve collar, both arms straight overhead** — 6 neck verts, ~2 cm: shoulder fabric rises into the neck with the
  shoulder weights (the skin does the same).
- **Crotch geometry** — near the waist each leg's ring is pulled ~10 cm past the midline and overlaps the other leg;
  any weights there are a compromise. A proper fix is building the pelvis as one piece that splits into legs.
- Long skirt weights, long hair (findings 2–3, audit C6). No dress garment exists yet (needs a new builder).

### Regression gate
`clothing-regression.test.ts` (runs in CI, ~9 s): every preset × 26 poses must stay within its measured
poke % / depth / excess-tear limits. Improve a garment → tighten its row.
