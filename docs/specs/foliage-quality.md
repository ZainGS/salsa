# Foliage Quality — Primitives, Shading & Planting

**Status:** 📋 Spec (2026-07-24). **§2 / phases S1 + S2 (the shared shading + motion layer) BUILT 2026-07-24;
§3.1 / phase P1 (the `blade` primitive → real grass tufts, `tall-grass`, blade scatter + LOD) BUILT 2026-07-24;
§3.2 + §3.3 / phase P2 (the `whorl` + `stalk` primitives → real daisy · rapeseed · lavender flowers, a rebuilt
`flower-bed`, and a real flower scatter band) BUILT 2026-07-24; §3.4 / phase P3 (the `runner` primitive → real
ivy/vines: two path sources, growth + cling + hang, the coverage frontier, attachment-graded wind) BUILT
2026-07-24; §3.5 + §3.6 / phase P4 (the `branch` primitive → recursive limbs, leaf masses at the TIPS, the
hedge SHELL, and rebuilt `bush` · `shrub` · `hedge` · `small-tree`) BUILT 2026-07-24; ★ §4 vessel types /
phase P4v (the `plantingArrangement` COMPOSITION → rebuilt `potted` · `planter` · `window-box` — the LAST
three types on the old construction: soil, a focal/filler/trailing layout, and the window-box SPILL) BUILT
2026-07-25** — see §8; the rest (authoring P5) is still spec. **All 15 types are now off the old
construction.** Reference: *Neverness to Everness* (dense backlit grass fields,
rapeseed/daisy meadows, ivy-clad brick, blossom trees).
**Relationship to existing docs:** [foliage-generator.md](foliage-generator.md) defines the *placement*
architecture (two kinds: building-ATTACHED + FREESTANDING, one `buildFoliage(spec)`) — **that stays**. This spec
replaces the *geometry + shading* half: how a plant is actually generated and lit. UI: [../ui/foliage-creator.md](../ui/foliage-creator.md).
**Siblings:** [procedural-ground.md](procedural-ground.md) (the P5 scatter that plants this), [hair-styles.md](hair-styles.md)
(the card/curve machinery we reuse), [instancing-blocks.md](instancing-blocks.md), [city-visual-upgrade.md](city-visual-upgrade.md).

---

## 0. Diagnosis — why ours reads as low-quality

`src/world/foliage.ts` is **230 lines** and the three headline plants are the weakest constructs in it:

| Type | What it actually is today | Why it reads wrong |
|---|---|---|
| ~~`grass-tuft`~~ ✅ **fixed (P1)** | ~~3-sided **cones** (`acc.cone`)~~ → a clump of real swept `blade`s | ~~A cone is not a blade — no curve, no taper-to-a-point, no light catch~~ |
| ~~`flower-bed` / blooms~~ ✅ **fixed (P2)** | ~~**spheres** (`bloom.blob`)~~ → a patch of real `stalk`s carrying `whorl` heads | ~~No petals, no stem, no floret structure~~ |
| ~~`ivy` / `vine`~~ ✅ **fixed (P3)** | ~~random blobs/quads on a flat z≈0 plane~~ → `runner`s that crawl, cling, branch + hang | ~~No growth, no runners, doesn't follow or cling to the surface~~ |
| ~~`potted` / `planter` / `window-box`~~ ✅ **fixed (P4v)** | ~~a (correct) vessel + ONE `foliageClump` blob + `foliageBloom` specks~~ → a **planting ARRANGEMENT** | ~~The vessel was never wrong; the PLANTING was — a green ball is not a plant, and a window box with nothing spilling over its front is not a window box~~ |

But the deeper finding: **the quality gap is mostly not geometry.** Verified in the codebase —

- **No wind anywhere in the vegetation path.** The only `sway` is the CPU rain/snow/petal fall-movers.
  Static vegetation reads as plastic instantly; it is the single loudest tell.
- **No translucency / subsurface.** There is a `rim` term (bit 8) but nothing that lets light *pass through*
  a leaf. Every NTE grass/meadow shot is selling primarily on **backlit glow**.
- **No ground blend / base AO**, so cards look stuck into the ground rather than growing from it.

**Rule of thumb: ~70% of the gap is shared shading + motion; ~30% is per-plant geometry.** Wind +
translucency + ground-blend lift **all 11 existing types at once** — build them first. Three beautiful new
generators without them would still look plastic.

---

## 1. Architecture — three layers

```
FOLIAGE
├── (S) SHADING + MOTION      shared by every plant — wind, translucency, ground blend, AO, variation
│                              → §2. Highest leverage. Build FIRST.
├── (P) PRIMITIVES            the generative atoms a plant is composed of
│                              blade · whorl · stalk · runner · branch · leafCard · clump  → §3
└── (L) PLANTING              one instance (an object) vs a FIELD (an area) → §5
                               fields route through the ground P5 scatter (already built)
```

An **archetype** (grass, rapeseed, daisy, ivy, bush, tree) is a **recipe over primitives** (§4) — not a
bespoke code path. Same lesson as the packaging mechanisms: build the primitives, compose the products.

---

## 2. (S) Shading + motion — the shared layer ★ do this first — ✅ BUILT (S1 + S2, 2026-07-24)

All of it rides the existing `leafCard`/`rim` material family (new flag bits + a vertex-stage offset). No new
pipeline. Applies to every foliage type immediately, including the ground-scatter placeholders.

### 2.1 Wind (vertex shader — the biggest single win)
- **Height-graded sway**: displacement ∝ `(localY / height)^stiffness` — the base stays planted, the tip
  travels. `stiffness` per archetype (grass floppy ≈1.2, hedge stiff ≈3).
  - ⚠ **ATTACHED plants break this assumption.** Ivy is glued to its wall at *every* height and only moves
    where it is unattached, so height is the wrong grading axis for it. P3 grades climbers by
    **free-length / attachment** instead — a low stiffness flattens the height ramp, and the geometry is
    split clinging-vs-free into separate layers with ~20× the sway amount on the free half. See §8 P3.
- **Phase per instance** so a field doesn't pulse in unison: `phase = hash(instanceId)`.
- **Two-band motion**: a slow global sway + a faster ripple; plus **gusts** — a low-frequency travelling
  wave across the world (`sin(dot(worldXZ, windDir) * k - t * speed)`) so wind visibly *moves through* a
  meadow rather than shimmering in place. This is what makes NTE fields feel alive.
- **Directional**: a scene-level `windDir` + `windStrength` (shared with any future cloth/flag).
- Cost: a few ALU in the vertex stage, zero CPU, no per-frame uploads. Works with instancing.

### 2.2 Translucency / subsurface (the anime cue)
- `transmission` term: light *through* the leaf ∝ `max(0, dot(-N, L))` (or `pow(max(0,dot(V,-L)), k)` for a
  view-dependent wrap), tinted by a **transmission colour** (a lighter, more saturated green/yellow than
  the diffuse) and scaled by a per-material `translucency` 0..1.
- Thin geometry (blades, leaf cards) gets it strongest; trunks/vessels none.
- Pairs with the existing `rim`; together they produce the glowing backlit grass in the reference shots.

### 2.3 Ground blend + base AO
- **Base AO**: darken the lowest ~15% of a plant (by local Y) → it *sits* in the ground.
- **Ground tint bleed**: mix a little of the ground colour into the base so blades don't read as separate
  objects floating on a plane. Ties directly to the [procedural-ground](procedural-ground.md) surface colour.

### 2.4 Per-instance + per-element variation
- Per-instance: hue ±3°, value ±10%, scale ±15%, yaw random, lean random (already partly there via scatter).
- Per-element (blade/leaf within a plant): tip gradient (exists), slight hue drift, a few "dry/older"
  elements at a low probability — the anti-uniformity rule that made the ground material work.

### 2.5 LOD (needed the moment density goes up)
- Bands: full geometry near → reduced blade/leaf count mid → **billboard-cluster / impostor** far → cull.
- The P5 scatter LOD gate already exists; extend it to swap *geometry variants*, not just visibility.

---

## 3. (P) Primitives — the generative atoms

### 3.1 `blade` — curved tapered strip → **grass**, reeds, iris, palm frond ✅ **BUILT** (P1, 2026-07-24)
**Reuse: the hair generator already has this.** `perpFrame` (parallel-transport frames that don't spin or
flip along a curve), `cardSegments` (length subdivisions), and cubic-bezier spines are written and debugged
in `hair-generator.ts`. A grass blade is a hair card with a different profile — adapt, don't reinvent.

★ **Where the shared curve machinery lives: [`src/world/curve-frame.ts`](../../src/world/curve-frame.ts).**
The frame/bezier math was **extracted** out of `hair-generator.ts` (not copied): `perpFrame`, `rotAxis`
(Rodrigues), `bezierSpine` (quadratic *or* cubic) and `sweepFrames` (parallel transport over an arbitrary,
possibly non-uniform param list). It sits under `src/world/` because **`src/world/` must not import from
`src/services/managers/`** — and `hair-generator.ts` now imports `perpFrame` / `rotAxis` back from it, so hair
and foliage share **one** implementation. The primitive itself is [`src/world/blade.ts`](../../src/world/blade.ts)
(`emitBlade` + the `bladeTuft` clump recipe); it emits through two new `Accum3D` escape hatches,
`vertex()` / `triangle()`, because a folded+twisted strip needs **analytic** normals.

| Param | Meaning |
|---|---|
| `length`, `lengthVar` | blade height + per-blade variation |
| `width`, `taper` | base width → tip; taper to a point (or a rounded/split tip) |
| `curve`, `curveVar` | arc of the spine (droop); high = flopping, low = upright |
| `segments` | spine subdivisions (3–7; more = smoother curve, more verts) |
| `twist` | rotation along the spine (catches light — important for the shimmer) |
| `foldAngle` | V-cross-section (a real blade is folded, not flat — huge for light catch) |

**Cross-section as built:** three columns per station — left edge (`uv.u` 0), **fold ridge** (0.5), right edge
(1); `uv.v` runs base→tip so the tip gradient ramps. The two half-planes splay by **±`foldAngle`** about the
tangent, so they can *never* share a normal, and `twist` rotates that pair along the length — together they are
the entire light catch. The spine leaves the base **vertical** (the S1 wind grading assumes a planted base) and
arcs outward by `curve`. The upper `tipStart..1` portion is emitted into a **separate accumulator** → the
lighter new-growth colour is a real length-wise gradient, not a per-blade coin flip.

### 3.2 `whorl` — radial elements around an axis → **flowers**, succulents, ferns, palm crowns ✅ **BUILT** (P2, 2026-07-24)
★ **Built by GENERALISING `emitBlade`, not by writing a second sweep** — a petal *is* a short, wide blade
with a different tip. [`src/world/blade.ts`](../../src/world/blade.ts) gained five optional params, all
defaulting to the P1 grass behaviour (verified byte-identical by a test): **`shape`** (the width profile —
`blade` · `rounded` · `pointed` · `notched` · `strap`, via `bladeWidthProfile`), **`notch`** (retracts the tip
*ridge* between two lobes → the heart-shaped end a 3-column strip can express no other way), **`pitch`** (the
opening angle from the growth axis — bud → flat → reflexed), **`axis`/`out`** (an arbitrary growth frame, so a
floret can stand on a tilted stem frame) and **`faceFlip`** (present the UPPER surface to the light).
`bladeReach()` exports the spine-end decomposition so callers size footprints without re-deriving the spine.
The primitive itself is [`src/world/whorl.ts`](../../src/world/whorl.ts) (`emitWhorl` + the oriented fan disc);
petals and the eye go to **separate accumulators** so the disc carries its own `centerColor`.

| Param | Meaning |
|---|---|
| `count` | petals/leaflets per whorl |
| `rows`, `rowOffset` | stacked whorls, rotated between rows (a real flower isn't one ring) |
| `elementLength/Width`, `shape` | petal silhouette: rounded · pointed · notched · strap |
| `pitch`, `pitchVar` | how far petals open (bud → flat → reflexed) — *the* bloom-state knob |
| `centerRadius`, `centerColor` | disc/eye |

### 3.3 `stalk` — an axis with elements distributed along it → **rapeseed, lavender, foxglove, wheat** ✅ **BUILT** (P2, 2026-07-24)
[`src/world/stalk.ts`](../../src/world/stalk.ts) (`emitStalk`). This is the primitive that answers "flowers up a
stem". Everything is reused: the stem is a **tube swept along a `bezierSpine` with `sweepFrames`** (the same
parallel-transport module hair cards and grass blades ride — no hand-rolled frames), the stem **leaves are
`emitBlade`** (pointed/strap profile), and the **florets are `emitWhorl` instances placed on the sweep's own
frames** (phyllotaxis azimuth, a pedicel beam, and a floret axis that leans *out* from the stem). `branches`
recurse into whole sub-stalks (one level). `StalkResult` reports every floret's `{ t, y, scale, depth, terminal }`
so the bloom band is verifiable, plus the measured height/radius for wind grading and the footprint.

| Param | Meaning |
|---|---|
| `height`, `thickness`, `curve` | the stem |
| `bloomStart` (0..1) | **fraction up the stem where florets begin** ← exactly right |
| `bloomEnd` (0..1) | where they stop (1 = to the very tip) |
| `bloomDensity` / `nodeSpacing` | florets per unit length, or discrete nodes |
| `bloomScaleCurve` | florets shrink toward the tip (buds at top, open below — how rapeseed actually looks) |
| `terminalCluster` | a denser cap at the apex |
| `branches`, `branchAngle`, `branchStart` | rapeseed/lavender branch — each branch is a recursive stalk |
| `leaves`, `leafStart/End` | foliage leaves along the lower stem |

### 3.4 `runner` — growth over a surface → **ivy, vines, creepers** ✅ **BUILT** (P3, 2026-07-24)
[`src/world/runner.ts`](../../src/world/runner.ts). Genuinely different: a **growth simulation**, not a scatter.

★ **TWO PATH SOURCES, ONE growth/geometry model** — this is the architecture, and it is deliberately *not*
two systems:

| Source | What it is | Who authors it |
|---|---|---|
| **(a) AREA** — "ivy wall" | seeds auto-placed over a host region; runners **GROW** procedurally (crawl → cling → branch → hang) | `runnerCount` / `coverage` / `growthBias` … |
| **(b) PATH** — "ivy path" | the caller supplies an explicit list of 3D points; **that polyline IS a runner centreline** (smoothed by `polySpine`), with leaves + optional side-branches along it | the Ribbon-style point-list editor the host already has a mental model for |

Both then run the **same** downstream: sweep the woody stem, distribute leaves, orient/droop them, LOD.
In the API that is `RunnerSource = {mode:'area', host} | {mode:'path', points} | {mode:'paths', paths}`
feeding one `buildRunners(acc, source, spec, rnd)`.

★ **DENSITY IS THE CONTINUUM between the two ivy looks.** Low `leafDensity`/`coverage` = visible woody
runners crawling over bare wall (the sparse, graphic climber); high = a leaf **carpet** where the stems are
completely hidden. One codepath — the reference images differ only by numbers, never by type.

- **Crawl / cling / branch / hang.** Each step biases by `growthBias` (−1 down · 0 along · +1 up) plus a
  `wander` term, then **clings** — `host.project()` puts the stepped point back ON the surface, offset by
  `clingOffset` (leaf thickness). `branchChance` per step throws a side runner (rotated about the surface
  normal, `branchDecay` of the parent's remaining budget). ★ **Hang**: the moment a step leaves the region,
  gravity takes over (`hangGravity` blends the direction toward −Y each step, `hangDrift` peels it off the
  wall) and the runner droops — the detail that sells ivy on a wall.
- **Coverage frontier** — `coverageAt(u, v, coverage, seed)`: a dense core that fades at the sides and
  (hardest) toward the top, broken up by **`fbm2` from [`ground-masks.ts`](../../src/world/ground-masks.ts)**
  (the same noise the ground material and the P5 scatter already share). Runners die below `frontier` and
  leaves thin with the mask, so the mass **fingers out into individual runners at its edge** instead of
  ending in a straight line.
- **Leaves along the runner** at `leafSpacing` **metres of arclength** (`polySpine` is chord-length
  parameterised, so `t ≈ s / length`), `alternate` · `opposite` · `spiral` `phyllotaxy`, ★ **scaled by AGE**
  (`tipScale` → full size over `ageSpan`, so new leaves at the growing tip are small), oriented **outward
  from the host surface** — the leaf lies in the host's tangent plane, lifted by `leafLift`, drooping by
  `droop`, arcing its tip away from the wall — with per-leaf yaw/tilt jitter. Leaves within `newGrowth` of
  the tip go to the **tip accumulator** (the yellow-green new growth against dark mature leaves).
- **Reuse, not a third sweep**: the stem is `emitTube` **exported from [`stalk.ts`](../../src/world/stalk.ts)**
  (a runner *is* structurally a stalk — a swept stem with elements distributed along it, leaves instead of
  florets) swept over `polySpine` + `sweepFrames`; every leaf is **`emitBlade`** with a new **`palmate`**
  width profile (narrow petiole → broad shoulders → a point); `polySpine` itself is new shared machinery in
  [`curve-frame.ts`](../../src/world/curve-frame.ts) (Catmull-Rom **through** every supplied point).
- **Host surface v1** = a wall plane/quad done properly — `wallHost({origin, right, up, normal, width,
  height})`, not the old "everything sits at z≈0" assumption. ★ **Extension point:** `RunnerHost` is three
  methods (`project` · `at` · `size`), none of which knows it is a plane, so an **arbitrary mesh host**
  (closest-point/raycast, reusing the hair-collision machinery) is a second implementation and `growRunners`
  needs no change. Not built (§9 open question).
- Params: `runnerCount`, `maxLength`, `stepSize`, `branchChance`/`branchAngle`/`branchDecay`/`branchDepth`,
  `growthBias`, `wander`, `coverage`, `frontier`, `seedRow`, `clingOffset`, `hangGravity`, `hangDrift`,
  `thickness`, `sides`, `leafSpacing`, `leafDensity`, `leafSize/Var`, `tipScale`, `ageSpan`, `newGrowth`,
  `droop`, `leafLift`, `phyllotaxy`, `leafShape/Curve/Fold/Twist/Segments`, `lodLevel`, `maxRunners`,
  `maxLeaves`.

### 3.5 `branch` — recursive limbs → **trees, shrubs** ✅ **BUILT** (P4, 2026-07-24)
[`src/world/branch.ts`](../../src/world/branch.ts). Trunk → limbs → twigs, with the leaf **masses at the
TIPS** — that, not a central ball, is what gives a woody plant a silhouette.

★ **REUSE, not a third sweep.** Every limb is a **tapered tube swept with `emitTube` exported from
[`stalk.ts`](../../src/world/stalk.ts)** (a branch *is* a tapered tube — there is ONE tube sweep in the
codebase) over a `bezierSpine` carried by `sweepFrames` parallel transport
([`curve-frame.ts`](../../src/world/curve-frame.ts)). Every leaf is **`emitBlade`** using the P2
`axis`/`out`/`pitch` generalisation, so a canopy leaf, a petal and a grass blade are the same 40-line
sweep. The canopy's non-spherical envelope rides **`fbm2` from
[`ground-masks.ts`](../../src/world/ground-masks.ts)** — the noise the ground material and the P5 scatter
already share.

| Param | Meaning |
|---|---|
| `levels` | recursion depth: 0 = a bare trunk · 3 = trunk → limbs → branches → twigs |
| `splitCount` (+`Var`) | children per non-terminal limb. Limbs = `stems × Σ splitCount^level` (exact, pinned by a test) |
| `splitAngle` (+`Var`) | radians a child leaves its parent's tangent by |
| `lengthDecay` / `radiusDecay` | child length / base radius vs the parent's — **monotonic**, so a twig is never fatter than its limb |
| `tipTaper` | one limb's own base→tip taper |
| ★ `gnarl` | sideways bend of a limb's OWN spine — branches are not straight, and a straight beam is *the* procedural-tree tell |
| `wander` | azimuthal jitter of a child's direction, so children aren't on a clean ring |
| ★ `upBias` | limbs curve back toward the light along their length (phototropism) — most of the silhouette |
| `lean`, `attachStart` | trunk lean off plumb; the fraction up the shaft where the lowest child attaches (children shed *along* a limb, not all at its tip) |
| ★ `stems` (+`stemAngle`/`stemSpread`) | 1 = a single trunk (tree/shrub) · 4–7 = a **multi-stem fan from the base** (a bush) |
| `seed` | when set, the primitive builds its own rng and ignores the caller's — deterministic per seed |

`BranchResult` returns **`tips: {p, dir, depth, radius, length}[]`** — the terminal twig ends, which is
exactly where a caller hangs foliage — plus the measured height/radius for wind grading + footprints.
Limb tubes carry a **built-in depth LOD** (a twig is 2 segments × 3 sides, a trunk is the full spec).
`BRANCH_LOD_SCALE` `[1, 0.62, 0.38]` thins `splitCount`; `MAX_LIMBS_PER_PLANT` 320 is a **hard** cap
(checked before anything is emitted) and logs on truncation (§7).

### 3.6 `leafCard` + `clump` — shared atoms ✅ **BUILT** (P4, 2026-07-24)
`emitLeafCluster` (one terminal mass) + **`emitCanopy`** (a mass on every branch tip) in
[`branch.ts`](../../src/world/branch.ts). Both render modes are honoured: **`render:'card'` ⇒ real swept
`emitBlade` leaves** (the quality lean), **`render:'chunky'` ⇒ the existing low-poly blobs** — same
placement machinery either way.

The three things that stop a canopy reading as a ball:
- ★ **A lobed, non-spherical envelope** — `irregular` mixes an `fbm2` field over (azimuth, elevation) into
  each cluster's radius, seeded per cluster, so no two masses have the same outline.
- **An outer-shell bias** (`0.42 + 0.58·cbrt(u)`) — a real leaf mass is a skin over shadowed air, not a
  solid ball. Plus per-cluster `sizeVar`.
- ★ **Interior gaps** — `gapChance` leaves tips bare and `innerGap`/`innerScale` thin and shrink the
  clusters nearest the plant's axis, so you see *through* to a shadowed core.

`LEAF_LOD_SCALE` `[1, 0.55, 0.3]`; `MAX_LEAVES_PER_PLANT` 1200, logged.

★ **The HEDGE SHELL technique** (`emitHedgeShell`, same module). A manicured hedge is a **surface**, not a
plant with a silhouette — so the leaves are distributed over the **SHELL of a rounded box** (top + 4
sides; the bottom and the whole interior are never seen). A point is sampled on a face by area, then put
through the standard **rounded-box SDF projection** (clamp into the inner box, step back out by `round`),
which yields the surface point *and* its normal in one shot; a smooth `fbm2` `irregular` term displaces
it along that normal so the clipped plane isn't a CAD plane; and a few **`sprigs`** escape the cut into
the new-growth tip layer. The unseen interior is ONE cheap `core` box (12 tris) so a sparse shell reads
as shadow, not as a hole. Cost then scales with **AREA, not volume** — which is why it is materially
cheaper than the row of solid mounds it replaces.

---

## 4. Archetype recipes (composition, not new code paths)

| Archetype | Recipe |
|---|---|
| **grass tuft** ✅ | `clump` of `blade` ×30–60, radial lean-out, height variation — `bladeTuft()`, type `grass-tuft` |
| **tall grass** ✅ | the same clump, fewer (14–28) / taller / wider / floppier blades — type `tall-grass` |
| **grass field** ✅ | the tuft as a scatter element, blue-noise **clumped** (§5) — the P5 `tallGrass` band |
| **rapeseed** ✅ | `stalk` (branches ≈3–5, `bloomStart` ≈0.55, `bloomEnd` 1.0, `bloomScaleCurve` 0.72 shrink-to-tip, `terminalCluster` on) + tiny 4-petal yellow `whorl` florets — type `rapeseed` |
| **daisy / meadow flower** ✅ | short `stalk` (`bloomStart` 0.95 ≈ terminal only) + `whorl` (count 13–21 over 2 interleaved rows, white rays, yellow disc) — type `daisy` |
| **lavender / foxglove** ✅ | `stalk`, dense 5-petal florets, `bloomStart` 0.6, no branches, narrow violet spike — type `lavender` |
| **flower bed** ✅ | a PATCH: 4–14 short daisy-like `stalk`s splayed over the spread — type `flower-bed` (rebuilt from blob spheres in P2) |
| **ivy wall** ✅ | `runner`s over the host surface + real swept `palmate` leaves along them — type `ivy` (area mode) / the same type with `ivyMode:'path'` for an authored point list; **`vine`** = the same primitive, fewer/longer/droopier |
| **bush** ✅ | `branch` with `stems` 4–7 / `levels` 1 (a multi-stem FAN from the base) + `emitCanopy` tip clusters with gaps — type `bush` (rebuilt from one flattened blob in P4) |
| **shrub** ✅ | `branch` with a short visible woody base → `levels` 2 → tip clusters — type `shrub` |
| **hedge** ✅ | ★ NOT a plant recipe: `emitHedgeShell` — leaves on the SHELL of a rounded clipped box + escaping sprigs — type `hedge` (rebuilt from a row of spheres in P4) |
| **small tree** ✅ | `branch` `levels` 3 / `splitCount` 3 (gnarled tapered trunk) + `emitCanopy` at the twig TIPS — type `small-tree` (rebuilt from a beam + one blob in P4) |
| **potted plant** ✅ | ★ NOT a plant recipe — a **vessel + `plantingArrangement`** (`layout:'single'`): the `potShape` frustum (unchanged), a soil disc, and **ONE identifiable specimen** picked per seed from the four atoms below — type `potted` (rebuilt from a pot + one blob in **P4v**) |
| **planter** ✅ | the `obox` box (unchanged) + `plantingArrangement` (`layout:'group'`): a focal plant toward the back, 1–2 fillers, and a trailing plant spilling over a front corner — type `planter` |
| **window box** ✅ | ★ the signature case: the box (unchanged) + `plantingArrangement` (`layout:'row'`) — a ROW of upright flowering plants **behind** TRAILING plants that spill over the **FRONT (+Z)** edge and hang below the box — type `window-box` |
| **blossom tree** | the `small-tree` recipe + petal `whorl` accents + falling-petal movers (exist) — not built |

★ **The vessel types are COMPOSITIONS, not generators.** `planting.ts` adds **no geometry code at all** —
it is a layout rule plus four recipe atoms, each of which is a composition of the P1–P4 primitives:

| Atom | Composed of | Reads as |
|---|---|---|
| `shrub` | `emitBranch` (§3.5, `stems` 2–4, `levels` 1) + `emitCanopy` (§3.6) | a small woody plant with a silhouette |
| `flower` | `emitStalk` (§3.3) carrying an `emitWhorl` head (§3.2) | a bedding/flowering plant — ★ what `bloom` now drives |
| `grass` | `bladeTuft` (§3.1) on the **`strap`** width profile | strappy / grassy foliage |
| `trailing` | ★ `buildRunners` (§3.4) in `paths` mode over centrelines that leave the rim and FALL | the spill — *a trailing plant IS a runner with a downward growth bias* |

---

## 5. (L) Planting — one instance vs a FIELD

Two authoring scales, and they compose:

- **Instance** — a single plant object (a bush by a door, one potted plant). Today's `foliage-manager`
  thin-wrapper container. Unchanged.
- **Field** — an *area* of plants (a lawn, a meadow, an ivy wall). Params: `width` × `depth` (or a polygon),
  `density`, `clumping`, `seed`, `variation` ranges, plus the mask hooks.
  - **Routes through the ground P5 scatter** (`scatterOnGround3D` / `buildScatterLayers`) — already built,
    already blue-noise, already instanced, already mask-driven. A grass field is scatter rules pointing at a
    blade-tuft geometry, **not** one giant mesh.
  - ★ **Scatter in CLUMPS, not per-blade uniform.** Uniform per-blade placement reads as carpet; clumps of
    30–60 blades read as nature (the Z-A finding, visible in every NTE meadow shot).
  - Density falls off with the shared wear/moisture masks — a worn path already thins grass (built in P5).

---

## 6. UI / authoring model

**One Foliage Creator, extended** — exactly the existing pattern (pick a type → the mesh regenerates → that
type's params appear), which already works for buildings/characters. Additions:

1. **Type picker gains the new archetypes** (grass, rapeseed, daisy, lavender, ivy, blossom tree…), grouped
   (Ground cover · Flowers · Climbers · Shrubs · Trees · Vessels).
2. **Params are archetype-scoped** — the panel shows only the primitives that archetype uses (a `stalk` plant
   shows Bloom Start/End/Density/Branches; a `blade` plant shows Length/Curve/Twist/Fold; ivy shows
   Runners/Coverage/Droop). Same schema-driven panel idea as the Creator Modes spec.
3. **A shared "Look" section on every type** — Wind (strength/stiffness), Translucency, Colour + variation,
   Ground blend. These are the §2 knobs and they apply to all archetypes.
4. **An Instance ⇄ Field toggle** — "Single plant" vs "Field": Field reveals Width/Depth (or *paint an
   area*), Density, Clumping, Seed. Field mode drives the P5 scatter under the hood.
5. **Presets per archetype** (Meadow, Manicured lawn, Overgrown, Spring blossom) — a param bundle, like the
   packaging styles / hair presets.

---

## 7. Perf

- **Instanced** always (P5 path): one canonical geometry per plant variant + transforms; a field is a handful
  of nodes, not thousands of meshes.
- **Wind is free-ish** (vertex ALU); translucency is a few ALU in the fragment stage.
- **Budget by band** (§2.5): near = full blades, mid = fewer/simplified, far = billboard-cluster, then cull.
- Cap total blade counts per field; log when a cap truncates (no silent density loss).

---

## 8. Phases

1. **S1 — Wind** ✅ **BUILT** (2026-07-24) — vertex sway, height-graded, per-instance phase, gusts, scene wind
   dir/strength/speed. Material flag **bit 19 `windSway`** (+ `windStiffness` / `windHeight` / `windAmount`),
   applied in LOCAL space before the model transform in **every** vertex shader foliage renders through
   (`MESH3D_VERTEX_SHADER`, `MESH3D_VERTEX_SHADER_VERTEX_COLOR`, **and the shadow depth pass** — a static shadow
   under a swaying plant looks broken). Phase is hashed from the instance's model-matrix world translation, so
   the GPU-instanced ground scatter varies per copy with **no extra per-instance data**. Scene wind lives in the
   free `lightCounts.yzw` uniform slots → `ShapeManager.setSceneWind3D({ dirDeg, strength, speed })` /
   `sceneWind3D`, console `salsaWind(...)`. *Lifts all 11 foliage types + the P5 scatter immediately.*
2. **S2 — Translucency + ground blend + base AO** ✅ **BUILT** (2026-07-24) — material flag **bit 20
   `foliageShade`** (+ `translucency` / `translucencyColor` / `groundBlend` / `groundTint` / `baseAOAmount`).
   Transmission = `max(0, dot(-N, L))` + a view-aligned wrap, **added on top of** the lit result so it *composes*
   with the existing rim (bit 8); base AO + ground bleed ride the same normalized local-Y ramp as the wind
   grading (passed VS→FS as `@location(8) foliageY`). Both bits repurpose the pattern instance slots (colours
   8:8:8-packed), so foliage materials are mutually exclusive with pattern/board/ground shading.
   Per-instance *variation* (hue/value/scale jitter) is still open — the scatter already varies yaw/lean/scale.
3. **P1 — `blade` primitive** ✅ **BUILT** (2026-07-24) — `src/world/blade.ts` (`emitBlade` / `bladeTuft`) over the
   extracted shared curve module `src/world/curve-frame.ts` (§3.1), which **hair-generator.ts now imports too**.
   · **`grass-tuft` rebuilt** from 3-sided cones to a radial clump of **30–60 real blades** (density-scaled),
   leaning out from the centre with per-blade length/curve/twist/width variation and a length-wise tip colour
   split at 0.6 — the type name is unchanged, so **existing scenes and saves improve on reload**.
   · **New archetype `tall-grass`** (the NTE meadow look): taller, floppier, wider straps, ~14–28 per clump;
   in `FoliageType` / `FOLIAGE_TYPES` so it shows in the picker, with `FOLIAGE_WIND` `[1.0, 1.1]` — the floppiest
   entry in the table — and in `GROUND_PLANTED`.
   · **Shading**: blade types are in `BLADE_TYPES` → they never take the alpha-cut `leafCard` silhouette (it would
   eat real geometry) and they carry the strongest translucency (leaf `0.75` / tip `0.88`), `groundBlend` `0.45`
   and `baseAO` `0.45`. `windHeight` is the clump's **measured** tip height, not the nominal size.
   · **P5 scatter**: the `tallGrass` band now instances a real blade clump (canonical geometry + transforms via
   the existing `ArrayGroup3D` path — never per-blade meshes), with its wind height measured from the geometry.
   · **LOD**: `bladeTuft` takes a `lodLevel` (0/1/2 → ×1 / ×0.55 / ×0.30 blades, `BLADE_LOD_SCALE`); the scatter
   emits a reduced `lodGeometry` variant and `scene3d-manager` swaps the two **inside** the band at `1.8 × extent`
   (the band-cull gate still runs on top). Foliage instances expose it as the `bladeLod` param.
   · **Caps**: `MAX_BLADES_PER_TUFT` (96) per clump and `MAX_FIELD_BLADES` (240 000) per scatter field; both
   `console.warn` when they truncate — no silent density loss (§7). Tests: `src/world/blade.test.ts` (19).
   *Still open for a later pass: billboard/impostor far band (§2.5), and grass FIELDS as an authored object (§5).*
4. **P2 — `whorl` + `stalk`** ✅ **BUILT** (2026-07-24) — real flowers, and the `bloomStart` model validated.
   · ★ **`emitBlade` was GENERALISED, not duplicated** (§3.2): `shape` (width profile: blade · rounded · pointed ·
   notched · strap), `notch` (retracted tip ridge), `pitch` (opening angle from the axis = the bloom-state knob),
   `axis`/`out` (arbitrary growth frame) and `faceFlip` (lit face = the petal's upper surface), plus the exported
   `bladeReach()`. All optional; with them omitted the P1 grass path is **byte-identical** (a test pins it). That
   one generalisation is what let a petal, a stem leaf and a grass blade all be the same 40-line sweep — and it
   is what P4's `branch` leaves will reuse next.
   · **`whorl`** [`src/world/whorl.ts`](../../src/world/whorl.ts): `count × rows` petals with `rowOffset`
   interleaving, per-row pitch/scale/lift (a flower is never one flat ring), `pitch`/`pitchVar` bloom state,
   and an oriented fan **disc** in its own accumulator so the eye carries `centerColor`. `WHORL_LOD_SCALE`
   `[1, 0.6, 0.38]`; `MAX_PETALS_PER_WHORL` 48, logged on truncation (§7).
   · **`stalk`** [`src/world/stalk.ts`](../../src/world/stalk.ts): bezier stem tube over `curve-frame.ts`,
   `bloomStart`/`bloomEnd` as **fractions up the stem**, `bloomDensity` (florets/m) or `nodeSpacing`,
   ★ `bloomScaleCurve` (florets shrink to buds at the apex — the detail that makes rapeseed read as rapeseed),
   `terminalCluster`, **recursive `branches`**, and stem `leaves` (which are `emitBlade` again).
   `STALK_LOD_SCALE` `[1, 0.55, 0.32]`; `MAX_FLORETS_PER_STALK` 160, logged.
   · **Archetypes** in `FoliageType` / `FOLIAGE_TYPES`: **`daisy`** · **`rapeseed`** · **`lavender`**, each a
   recipe in `FLOWER_RECIPES` (params + signature colours), and **`flower-bed` REBUILT** on stalks+whorls —
   same type name, so existing scenes and saves upgrade on reload. `foliageBloom` (the old blob-speck helper)
   is **kept**: `building-parts.ts` still uses it for berry/blossom specks on building greenery.
   · **Shading**: `FLOWER_TYPES` is the `BLADE_TYPES` precedent — real geometry, so **never** alpha-cut by
   `render:'card'`, `groundBlend`/`baseAO` `0.45`, `windHeight` = the **measured** plant height, and petals carry
   the library's **highest translucency (0.9)** with a new `petalTint()` backlight that brightens the petal hue
   instead of pushing it green (a backlit violet lavender must stay violet). `FOLIAGE_WIND`: daisy `[1.3, 0.95]`,
   rapeseed `[1.5, 0.9]`, lavender `[1.55, 0.85]`, flower-bed `[1.3, 0.9]`.
   · **P5 scatter**: the `flowers` band is now a **3-stalk daisy clump** (instanced canonical geometry +
   transforms) with a reduced `lodGeometry` variant (1 stalk, fewer petals). A prop may now emit **sibling
   sub-layers over the SAME transform list** (`BuiltProp.extra`) so petals · eye · stem each get their own
   colour without re-running placement — the meadow shot needed white rays on a yellow eye on a green stem.
   · Tests: `src/world/flower.test.ts` (24).
   *Still open: whorl/stalk params in the Creator panel are host-side (see the UI doc); flower FIELDS as an
   authored object are still the scatter's job (§5).*
5. **P3 — `runner`** ✅ **BUILT** (2026-07-24) — real ivy/vines with clinging + hanging.
   · ★ **TWO PATH SOURCES, ONE MODEL** (§3.4): **area** (seeds over a host region, runners GROW) and
   **path** (an authored 3D point list IS a runner centreline). Both feed one `buildRunners()` — the stem
   sweep, leaf distribution, droop and LOD are a single codepath. They ship as **params on the existing
   types** (`ivyMode` + `ivyPath`), *not* as new types: the downstream model is identical, the panel just
   reveals a point-list editor in `path` mode, and **existing `ivy`/`vine` scenes and saves upgrade on
   reload** (the old version was random blobs/quads on a flat z≈0 plane — no growth, no runners, no cling).
   · ★ **DENSITY IS THE CONTINUUM**: low `leafDensity`/`coverage` = visible woody runners on bare wall,
   high = a leaf carpet with the stems hidden. Same runners either way.
   · **Growth**: crawl (bias + wander) → **cling** (`host.project()` back onto the surface, offset by leaf
   thickness) → **branch** (`branchChance`/`branchAngle`, one level) → ★ **hang** (past an edge, gravity
   blends the direction toward −Y and the runner droops off — the ivy-on-a-wall tell).
   · **Coverage frontier**: `coverageAt()` = a dense core fading at the sides + top, broken by `fbm2` from
   `ground-masks.ts`, so growth dies out unevenly and the mass **fingers out** rather than ending in a line.
   · **Reuse**: `emitTube` is now **exported from `stalk.ts`** (a runner is structurally a stalk) and leaves
   are `emitBlade` with a new **`palmate`** width profile; `polySpine` (Catmull-Rom *through* every point,
   chord-length parameterised) is new shared machinery in `curve-frame.ts`.
   · ★ **WIND — graded by ATTACHMENT, not height** (the §2.1 nuance for climbers). S1 grades sway by
   `localY / windHeight`, which is right for a planted stem and **wrong** for ivy: it is glued to the wall at
   *every* height and only moves where it is unattached. Cheapest fix that respects it, with **no shader
   change**: (1) the `ivy`/`vine` rows of `FOLIAGE_WIND` carry a deliberately **low stiffness** (`0.5`/`0.55`),
   which flattens the height grade to ~uniform — height is not this plant's axis of freedom; (2) the geometry
   is **split CLINGING vs FREE at generation time** — `runner.ts` routes every span past the last cling point
   into the `*Free` accumulators, and `buildFoliage` emits them as their own layers with ~**20×** the sway
   `amount` (attached `×0.06`, hanging `×1.05`). Clinging leaves barely twitch, hanging tips swing. The S1
   contract is untouched: one `windHeight` + one `stiffness` per plant, so nothing else in the pipeline moves.
   · **Layers**: `foliage:stem` (★ its own accumulator AND a pale woody colour — visible ivy runners are
   grey-brown, and in sparse ivy they are half the read), `foliage:leaf` / `foliage:tip`, plus
   `foliage:stem-free` / `foliage:leaf-free` / `foliage:tip-free`. `RUNNER_TYPES` is the `BLADE_TYPES` /
   `FLOWER_TYPES` precedent: real geometry → **never** alpha-cut by `render:'card'`, leaves at translucency
   `0.8`/`0.9` (backlit ivy glows), stems `0.12`, and **`groundBlend` 0** (wall-attached, not ground-planted).
   · **LOD + caps**: `RUNNER_LOD_SCALE` `[1, 0.55, 0.32]` widens the leaf spacing (the silhouette survives —
   LOD never deletes runners) and thins the stem rings; `MAX_RUNNERS` 64 and `MAX_RUNNER_LEAVES` 1400, both
   `console.warn` on truncation (§7). A 3 × 2.4 m ivy wall is ~4 k tris sparse, ~14 k as a carpet.
   · Tests: `src/world/runner.test.ts` (26).
   *Still open: the arbitrary-MESH host (the `RunnerHost` extension point above), and ivy as a
   building-attached generator param (today it is a freestanding Foliage Creator type placed on a wall).*
6. **P4 — `branch`** ✅ **BUILT** (2026-07-24) — the last four types come off the old construction.
   · ★ **`branch` primitive** [`src/world/branch.ts`](../../src/world/branch.ts) (§3.5): recursive limbs
   swept with the **exported `emitTube`** (no third tube sweep) over `bezierSpine`/`sweepFrames`, returning
   the **TIP frames + a depth per tip** so callers place leaf masses exactly where foliage belongs. Plus
   `emitLeafCluster` / `emitCanopy` (§3.6) and `emitHedgeShell` (the clipped-box shell).
   · **`small-tree`** — was `trunk.beam()` + ONE `foliageClump` blob (a lollipop). Now: a tapered, gnarled,
   leaning trunk → 3 (±1) main limbs → **3 levels** of sub-branching → leaf clusters only at the TIPS of the
   outer twigs, with an irregular canopy silhouette. 27-ish tips, ~2.2 k tris (was ~330).
   · **`bush`** — was one flattened `foliageClump` sphere. Now: a **4–7 stem fan from the base** (`stems`),
   one split level, tip clusters with `gapChance`/`innerGap` so the outline is irregular and you can see
   through it. ~0.9 k tris (was ~320).
   · **`shrub`** — was a beam + one clump. Now: a **visible short woody base** → 3 limbs → 2 levels → clusters.
   · ★ **`hedge`** — was a **ROW OF SPHERES** (one `mound` per segment), exactly the wrong read for something
   manicured. Now a **CLIPPED BOX**: leaves on the SHELL of a rounded box (top + 4 sides), rounded-box SDF
   projection for point + normal, `fbm2` surface irregularity, a few **escaping sprigs**, one 12-tri interior
   core, and **no limb structure at all** (it is unseen). `width` is still the run length. **Cheaper than the
   old row of mounds: 756 vs 960 tris at `width` 1, 1 940 vs 2 880 at `width` 4** (−21 % / −33 %), and only
   ~2.5 % of its vertices sit deep inside the box vs ~55 % for the old solid row.
   · **All four keep their type names**, so existing scenes and saves upgrade on reload. `BRANCH_TYPES` is
   the new set alongside `BLADE_TYPES`/`FLOWER_TYPES`/`RUNNER_TYPES` — with one difference: a woody type's
   *limbs* are always real swept tubes, but its *leaves* are only real swept blades in `render:'card'`, so
   `real` (never alpha-cut, higher translucency, `groundBlend` 0.45) is **render-dependent** for these four.
   · ★ **WIND — a trunk barely moves while its outer foliage does.** The S1 height ramp already gives a
   canopy most of its travel (the clusters sit at the top), so the split is per-layer rather than a `-free`
   geometry split like ivy needed: **trunk ×0.1**, leaf ×1, **tip ×1.35** (the new-growth twig masses are the
   floppiest thing on the tree). `FOLIAGE_WIND`: bush `[2.0, 0.6]`, shrub `[2.1, 0.56]`, small-tree
   `[2.2, 0.6]` (mid-**low** stiffness, floppiness delivered by the tip layer), **hedge `[3.0, 0.24]`** — the
   stiffest, least-travelled row in the table. Leaves take the BLADE/FLOWER translucency precedent (card
   leaf `0.72` / tip `0.86`; chunky blobs keep the blob-era `0.55`/`0.7`), trunks none, and all four stay in
   `GROUND_PLANTED`.
   · **LOD + caps**: `BRANCH_LOD_SCALE` `[1, 0.62, 0.38]` (splits) and `LEAF_LOD_SCALE` `[1, 0.55, 0.3]`
   (leaves), both driven by the `branchLod` param — a small tree goes 2 240 → 616 → 128 tris. Limb tubes also
   shed segments/sides with depth automatically. `MAX_LIMBS_PER_PLANT` 320 and `MAX_LEAVES_PER_PLANT` 1200,
   both `console.warn` on truncation (§7); the limb cap is checked *before* emission so it can never overshoot.
   · Tests: `src/world/branch.test.ts` (29) — exact limb counts per `levels`/`splitCount`, tips at limb ends,
   monotonic length/radius decay, leaves land at tips, ★ a silhouette-variance test (canopy CV ≈ 0.55 vs a
   `foliageClump` ball's ≈ 0.085), ★ the hedge shell-vs-solid comparison, determinism, LOD and both caps.
   *Still open: blossom `whorl` accents on a tree (§4 "blossom tree"), and the P5 scatter's `bushes` band is
   still its own cheap construction rather than an instanced `branch` bush.*
7. **P4v — the VESSEL composition round** ✅ **BUILT** (2026-07-25) — the last three types come off the old
   construction, and **not one new primitive was written**. `potted` · `planter` · `window-box` were a
   correct vessel + ONE `foliageClump` blob + `foliageBloom` sphere specks. The vessel SHAPES are kept
   verbatim (`potShape` frustum, `obox` boxes); what changed is the PLANTING.
   · ★ **`plantingArrangement`** [`src/world/planting.ts`](../../src/world/planting.ts): given a vessel's
   top surface (`VesselTop` = soil centre + half-extents + round/rect) + a seed + density, it lays out
   plants by ONE rule — **a taller FOCAL plant (or a ROW of them along a long box) toward the BACK, MID
   filler between/around it, and EDGE plants at the rim on the OUTWARD side, trailing over it** — with
   per-plant scale / yaw / lean jitter, every root clamped inside the footprint and sunk to the soil plane.
   The four recipe atoms are all §4 compositions (see the table there); the module contains no sweep,
   no envelope, no new mesh helper.
   · **`emitSoil`** — a disc (round) / slab (rect) just under the rim in its own `foliage:soil` layer, so
   you no longer see through the opening into an empty pot. Colour `soilColor`.
   · **`potted`** — pot + ONE identifiable specimen, drawn per seed from {small shrub · flowering stalk ·
   strappy blade clump · small trailing plant}; it now reads as *a plant in a pot*.
   · **`planter`** — a GROUP of 2–3 plants + a trailing plant over a front corner.
   · ★ **`window-box`** — the type this round exists for. A ROW of upright plants **behind** trailing
   plants that arc over the **FRONT (+Z)** rim and hang **below the bottom of the box**. `width` is still
   the run length; `spill` (0..1) sets the hang depth and `spill: 0` removes the trailing plants entirely.
   · ★ **`bloom` now drives real `whorl` FLOWER HEADS** on the planted stalks (petals + a disc/eye) instead
   of `foliageBloom` sphere specks, and biases the focal pick toward the flowering recipe. `foliageBloom`
   itself is **kept** — `building-parts.ts` still uses it for berry specks on attached greenery.
   · ★ **WIND — the hanging-spill fix, the exact inverse of the P3 climber problem.** S1 grades sway by
   `pow(clamp(localY / windHeight, 0, 1), stiffness)`, so geometry **below the plant's origin gets grade 0
   and literally cannot move** — which would make a window box's spill, the one genuinely free-hanging
   thing on it, the only dead-still part. Fixed with no shader change and no change to the S1 contract:
   (1) the `*-free` layers are emitted in a **LIFTED local frame** (every vertex pushed up by `lift`, plus
   ONE instance transform of `-lift` putting the mesh back — the world position is bit-identical), and
   (2) that layer carries a tiny `windHeight` (`SPILL_WIND_HEIGHT` 0.12) so the ramp **SATURATES** across
   the whole spill → uniform, full-amplitude sway. Amounts on top: stem-free ×1.0, leaf-free ×1.35,
   tip-free ×1.6 (vs ivy's 0.95/1.05/1.25 — nothing holds a spill). The vessel + soil layers stay at the
   ×0.04 vessel precedent. `FOLIAGE_WIND`: **window-box `[1.4, 0.85]`** (softer + floppier than before —
   it is mostly bedding and trailing plants), planter `[1.9, 0.5]`, potted `[2.0, 0.45]`.
   · **Shading**: `VESSEL_TYPES` joins `BLADE_TYPES`/`FLOWER_TYPES`/`RUNNER_TYPES`/`BRANCH_TYPES` — real
   swept geometry in BOTH render modes, so **never** alpha-cut by `render:'card'`; leaf `0.72` / tip `0.86`
   translucency; **`groundBlend` 0** (a vessel plant never touches the world's soil).
   · **LOD + caps**: `PLANTING_LOD_SCALE` `[1, 0.6, 0.35]` thins the plant count and forwards `lodLevel`
   into every primitive underneath (`plantLod`); a window box goes **1 756 → 374 → 174 tris**, and the
   SPILL survives every band (thinning it away would delete the look). `MAX_PLANTS_PER_VESSEL` 10 and
   `MAX_VESSEL_LEAVES` 900, both `console.warn` on truncation (§7).
   · **Cost** (default size, `chunky`, before → after): potted **350 → 518** · planter **324 → 1 296** ·
   window-box **172 → 1 756** (of which ~575 is the spill itself). With `bloom` on, potted actually gets
   *cheaper* (414 → 248) because a flowering stalk is lighter than a blob mound plus specks.
   · **All three keep their type names**, so existing scenes and saves upgrade on reload.
   · Tests: `src/world/planting.test.ts` (35) — layout rule, roots inside the footprint, the window-box
   spill below the box on the +Z face, `spill: 0`, whorl heads vs specks, the lifted wind frame (and that
   it leaves the climbers alone), vessel geometry unchanged, determinism, LOD bands and both caps.
8. **P5 — Authoring**: archetype-scoped panels, Instance⇄Field toggle, presets; wire fields into the biome
   composer so parks/meadows generate from params.

---

## 9. Open questions

- **Blade geometry vs shell/fin**: per-blade cards (accurate, heavier) vs a shell-texture technique for
  distant lawns. Start per-blade + billboard LOD; revisit if fill-rate bites.
- **Ivy host surface**: wall-plane v1 ✅ shipped (P3) behind the 3-method `RunnerHost` interface; arbitrary
  **mesh** projection is still open — where's the cutoff worth the complexity?
- **Wind as a scene service** (shared with cloth/flags/hair spring bones) vs foliage-local. Prefer scene-level
  `windDir/windStrength` so everything moves together.
- **Do blades need the fold (V) cross-section** at our camera distances, or is a twisted flat card enough?
  Cheap to try both; fold is the bigger light-catch win up close.
