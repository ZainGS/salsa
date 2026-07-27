# Foliage Creator — Frogmarks UI Integration

Host-facing contract for the **Foliage Creator** (the "Add / Edit Foliage" flow for **freestanding** plants), mirroring
the [Building Creator](building-creator.md) / [Character Creator](character-creator.md) pattern: **Salsa owns the
generator + scene lifecycle + persistence; Frogmarks owns the panels/buttons.** Spec:
[../specs/foliage-generator.md](../specs/foliage-generator.md). Item 1 (generator) + a freestanding manager are built.

## Two kinds of foliage — this doc is for FREESTANDING only
- **Freestanding foliage** (a loose bush on the sidewalk, a hedgerow, a potted plant, a street tree) = independent scene
  objects placed anywhere → **this Foliage Creator** (its own thin-wrapper containers, like buildings).
- **Building-attached foliage** (hedges hugging a building base, vines up its walls, window boxes, door planters) is NOT
  here — it lives in the **Building** panel as building params (`baseHedge` / `vines` / `windowBoxes` / `basePlanters`),
  so it travels with the building. See [building-creator.md](building-creator.md).

## The flow (what the host builds)
Exactly like Add/Edit Building:
1. **Add Foliage** button → `createProceduralFoliage3D(...)` → a plant appears + a new outliner item; select it (returned `id`).
2. **Select** (outliner click / returned id). Gate the toolbar on `isProceduralFoliage3D(selectedId)` → show **Edit Foliage**.
3. **Edit** → params panel seeded from `getFoliageParams3D(id)`; every change calls `setFoliageParams3D(id, {...changed})`
   → regenerates in place (same id, selection + placement kept).
4. **Type picker** → `setFoliageParams3D(id, { type })` switches the plant type.

Selection/gizmo/outliner are automatic (thin-wrapper container, moved/rotated as a unit; gizmo moves persist).

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `createProceduralFoliage3D(params?, x?, y?, z?, { scale?, frame? }) → { id, meta }` | Add + place. Auto-frames (pass `frame:false` to suppress). |
| `setFoliageParams3D(id, partial) → boolean` | Live-edit params, regenerate in place. Merge-style. |
| `getFoliageParams3D(id) → FoliageParams \| null` | Seed the host sliders. |
| `getFoliageMeta3D(id) → FoliageMeta \| null` | `{ footprint, height, type }` (footprint drives placement/overlap). |
| `isProceduralFoliage3D(id) → boolean` | Gate the "Edit Foliage" affordance. |
| `setFoliageTransform3D(id, {x,y,z,rx,ry,rz}) → boolean` | Move/rotate a placed plant. |
| `setFoliageScale3D(id, unitsPerMetre) → boolean` | Display scale (e.g. `0.1` = 1 unit : 10 m). Regenerate-free. |
| `getFoliageScaleInfo3D(id) → { scale, metersPerUnit, realHeightM, displayHeightUnits }` | UI ratio + real-dimension readout. |
| `frameFoliage3D(id) → boolean` | Re-frame the camera on a plant. |
| `removeFoliage3D(id) → boolean` | Delete. |
| `listFoliage3D() → { id, name, type }[]` | Host outliner / picker. |
| `foliageTypeNames3D() → string[]` | The type picker's options. |
| `restoreFoliageFromSave3D() → number` | Regenerate all foliage from a loaded save's markers. **Call after document load** (alongside `world.restoreFromSave()` + `restoreBuildingsFromSave3D()`). |

## `FoliageParams` (the panel model)
Resolved as **defaults ← explicit overrides**.
- **Type:** `type` — `bush` · `shrub` · `hedge` · **`grass-tuft`** · **`tall-grass`** · `flower-bed` · **`daisy`** ·
  **`rapeseed`** · **`lavender`** · `planter` · `potted` · `small-tree` · `vine` · `ivy` · `window-box`. `seed`.
  - **`tall-grass`** (foliage-quality.md P1, the NTE meadow look): taller, floppier, **wider** straps and
    **fewer** per clump than `grass-tuft`. Both are **blade** archetypes (see below).
  - **`daisy` / `rapeseed` / `lavender` are new** (foliage-quality.md P2) — real **flowers**: a `stalk` with
    `whorl` heads. **`flower-bed` was rebuilt** on the same primitives (it used to be blob spheres); the type
    name is unchanged, so **existing scenes and saves upgrade on reload**. All four are **flower** archetypes
    (see the Flower section below). A good picker grouping: *Ground cover* (grass) · **Flowers** (daisy ·
    rapeseed · lavender · flower-bed) · *Shrubs* · *Trees* · *Vessels* · *Climbers*.
  - **`ivy` / `vine` were REBUILT** (foliage-quality.md P3) on the `runner` primitive — real growth over a
    host surface (crawl · cling · branch · hang) instead of blobs on a plane. The type names are unchanged,
    so **existing scenes and saves upgrade on reload**. Both are **climber** archetypes (see the Climber
    section below), and they support **two authoring flavours** — an ivy *area* or an authored ivy *path*.
  - **★ `bush` / `shrub` / `hedge` / `small-tree` were REBUILT** (foliage-quality.md **P4**) on the `branch`
    primitive — the last four types on the old construction. Type names unchanged, so **existing scenes and
    saves upgrade on reload**. They are the **woody** archetypes (see the Woody section below):

| Type | Was | Is now |
|---|---|---|
| `small-tree` | a beam + ONE blob — a lollipop | a tapered **gnarled leaning trunk** → 3±1 main limbs → **3 levels** of sub-branching → leaf clusters at the **TIPS** of the outer twigs, with an irregular canopy outline |
| `bush` | one flattened blob sphere | a **4–7 stem fan from the base** → tip clusters with an irregular outline and **see-through gaps** to a shadowed interior |
| `shrub` | a short beam + one blob | a **visible short woody base** → 3 limbs → 2 levels → tip clusters |
| `hedge` | a **ROW OF SPHERES** | ★ a **CLIPPED BOX**: leaves on the **SHELL** of a rounded box (top + 4 sides), subtle surface irregularity, a few **sprigs escaping** the cut plane, and one cheap dark interior core. `width` is still the run length |
  - **★ `potted` / `planter` / `window-box` were REBUILT** (foliage-quality.md **P4v**) — the **last three**
    types on the old construction, and now every type in the library is off it. Type names unchanged, so
    **existing scenes and saves upgrade on reload**. They are the **vessel** archetypes (see the Vessel
    section below). ⚠ **The vessel SHAPES did not change** — the pot frustum and both boxes are identical
    down to their dimensions. What changed is what grows out of them:

| Type | Was | Is now |
|---|---|---|
| `potted` | a pot + ONE blob sphere | a pot + **soil** + a **GROUP**: an identifiable focal specimen (small shrub · flowering stalk · strappy blade clump, picked per seed), fillers out toward the rim, and a trailing plant spilling radially over the edge |
| `planter` | a box + one blob | a box + soil + a **GROUP**: a focal plant toward the back, 2–3 fillers, and a **trailing plant spilling over a front corner** |
| `window-box` | a box + a cloud of random blobs | ★ a box + soil + a **ROW** of upright flowering plants **behind** **TRAILING plants that spill over the FRONT (+Z) edge and hang below the box** — that spill is the whole reason a window box reads as a window box |
- **Shape:** `size` (m — height for bush/shrub/tree/grass, box height for planter), `width` (run length for hedge/
  window-box/vine; spread for flower-bed), `density` (0..1 leaf fullness).
- **Render:** `render` — `chunky` (low-poly blob clumps) · `card` (**layered leaf-CLUSTER cards** — big quads, each cut
  in-shader to a *sprig of ~5 leaves*, packed through the volume/prism the way real foliage layers cards; alpha-test so
  order-independent + leaf-shaped shadows; also cheaper than chunky). `celShade` (boolean) → **toon/BotW-Ghibli look**:
  cel-banded lighting + rim back-light on the leaves. Combine `card` + `celShade` for the stylized foliage look.
- **Flowers/vessel:** `bloom` (flowers/berries on), `potMaterial` (`terracotta`·`ceramic`·`metal`·`wood`·`stone`).
  ★ On the three **vessel** types `bloom` now emits real **`whorl` flower heads** on the planted stalks (petals +
  a disc/eye) instead of blob specks, and biases the specimen pick toward the flowering recipe.
- **Colour:** `foliageColor`, `tipColor` (lighter new-growth tips), `bloomColor`, `potColor`, `trunkColor`,
  **`soilColor`** (the vessel types' soil surface), and — for the flower archetypes — `petalColor` +
  `centerColor`. Colour values accept any format (`[0..1]` / `[0..255]` /
  `{r,g,b}` / `"#rrggbb"`) — coerced to 0..1 (same as buildings).
- **Blade** (shown only for `grass-tuft` / `tall-grass` — the archetype-scoped section). Each plant is a radial clump
  of curved, tapered, twisted, **folded** strips; `density` sets the blade count (grass-tuft 30→60, tall-grass 14→28)
  and `size` the blade length. The three shape knobs are **relative**: `0.5` = that archetype's own default, `0` = none,
  `1` = double — so one slider set reads correctly for both a lawn tuft and a floppy meadow clump.

| Param | Range | Meaning |
|---|---|---|
| `bladeCurve` | 0..1 (**0.5** = default) | droop arc — 0 = upright spikes, 1 = flopped right over |
| `bladeTwist` | 0..1 (**0.5** = default) | rotation along the blade — the light-catch shimmer |
| `bladeFold` | 0..1 (**0.5** = default) | V cross-section depth (a real blade is folded, not flat) |
| `bladeLod` | 0 · 1 · 2 | distance LOD — ×1 / ×0.55 / ×0.30 blades. Leave at 0 for authored plants |

  Blade plants are **real geometry**, so `render: 'card'` does *not* alpha-cut them; they also get the library's
  strongest translucency + ground blend automatically (see Look, below). A clump caps at **96 blades** and logs if
  it truncates. `getFoliageMeta3D(id).height` is the clump's **measured** height, not the nominal `size`.

- **Flower** (shown only for `daisy` / `rapeseed` / `lavender` / `flower-bed` — the other archetype-scoped section,
  foliage-quality.md §3.2 `whorl` + §3.3 `stalk`). A flower is a **stem with florets distributed along it**; each
  floret is a small **whorl** of petals. ★ **Every one of these params is OPTIONAL, and leaving it out uses that
  archetype's own recipe value** — that is what makes rapeseed look like rapeseed with no panel work at all. Only
  send the ones the user actually moves; sending `undefined` is the same as not sending it.

| Param | Range | Meaning |
|---|---|---|
| ★ `bloomStart` | 0..1 | **Fraction up the stem where florets begin.** daisy `0.95` (one terminal head) · rapeseed `0.55` · lavender `0.6` |
| `bloomEnd` | 0..1 | Where they stop (`1` = right to the tip). All three archetypes ship `1` |
| `bloomDensity` | florets per **metre** of the bloom band | daisy `12` (→ a single head) · rapeseed `26` · lavender `62` |
| ★ `bloomScaleCurve` | 0..1 | Florets **shrink toward the tip** — `0` = all the same size, `0.72` (rapeseed) = open flowers below, buds at the apex. The single most species-defining slider |
| `branches` | integer ≥ 0 | Recursive side stalks. rapeseed `3–5`, lavender/daisy `0` |
| `petalCount` | 3.. | Petals per whorl **row** (daisy 13–21, rapeseed 4, lavender 5) |
| `petalRows` | 1.. | Stacked whorl rows — `2` (daisy) stops a flower reading as a paper cut-out |
| ★ `petalPitch` | 0..1 | **Bloom state**: `0` = a closed bud · `~0.55` = flat open · `1` = fully reflexed |
| `petalShape` | `rounded`·`pointed`·`notched`·`strap` | Petal silhouette |
| `petalColor` / `centerColor` | colour | Default = the archetype's signature (daisy white/yellow · rapeseed yellow · lavender violet) |
| `flowerLod` | 0 · 1 · 2 | Distance LOD — fewer florets **and** fewer petals. Leave at 0 for authored plants |

  `size` is the stem height in metres and `density` scales the leaf/floret/stalk counts. Flowers are **real
  geometry**, so like blades they are never alpha-cut by `render:'card'`; petals carry the library's **highest
  translucency (0.9)** with a petal-hue backlight (a backlit violet lavender stays violet). Emitted layers:
  `foliage:leaf` (stem + lower leaves), `foliage:bloom` (**petals**, coloured by `petalColor`) and
  `foliage:center` (the disc/eye). Caps: **48 petals** per whorl and **160 florets** per stalk, each logged if it
  truncates. `getFoliageMeta3D(id).height` is again the **measured** height.

- **Climber** (shown only for `ivy` / `vine` — the third archetype-scoped section, foliage-quality.md §3.4
  `runner`, phase P3). A climber is **runners that grow over a host surface**: a woody stem that crawls,
  **clings**, branches and **hangs** off the top edge, carrying leaves along its length. ★ Same as the
  flower params: **every one is OPTIONAL and omitting it uses the archetype's own recipe**, so `ivy` looks
  like ivy with no panel work. **`ivy` and `vine` keep their type names**, so existing scenes/saves upgrade
  on reload (they used to be random blobs on a flat plane).

  ★ **Two authoring flavours, one type.** They are a *param* (`ivyMode`), not two types, because the
  growth/geometry model downstream is identical — the panel just swaps which inputs it shows:

| `ivyMode` | The panel shows | What it does |
|---|---|---|
| `'area'` (default) | **Area Width** · **Area Height** · Coverage · Runners · Growth Bias · Wander | Seeds runners over a wall region and **grows** them (the "ivy wall") |
| `'path'` | a **point-list editor** → `ivyPath` | The user's polyline **IS** the runner centreline; leaves + optional side branches grow along it (the "ivy path") |

| Param | Range | Meaning |
|---|---|---|
| `ivyMode` | `area` · `path` | Which path source feeds the growth model. Default `area` |
| `ivyPath` | `[x,y,z][]` (metres, plant-local) | `path` mode only — the authored centreline. **< 2 points falls back to area mode** |
| `ivyPathNormal` | `[x,y,z]` | `path` mode — the outward direction leaves face. Default `[0,0,1]` (the wall-face convention) |
| ★ `areaWidth` | m | **Area WIDTH** of the host region. Defaults to `width` |
| ★ `areaHeight` | m | **Area HEIGHT**. Defaults to `size` |
| ★ `leafDensity` | 0..1 | **THE continuum knob**: low = sparse, visible **woody runners** on bare wall · high = a leaf **carpet** with the stems hidden. Same runners either way. Defaults from `density` |
| `coverage` | 0..1 | How much of the region fills in. Drives the **frontier mask** — the mass fingers out into individual runners at its edge instead of ending in a straight line |
| `runnerCount` | int | Seed runners (branches add more). ivy `4 + density·8 + width·1.2` |
| `runnerLength` | m | Centreline budget per runner. Tuned so a runner mostly clings and only its last stretch hangs over the top |
| `runnerStep` | m | Crawl step (also the centreline's point spacing) |
| `branchChance` | 0..1 per step | Side runners (one level deep). In `path` mode: side branches per path segment |
| `growthBias` | −1..1 | **−1 trails DOWN · 0 crawls ALONG · +1 climbs UP** the host |
| `wander` | 0..1 | Random walk — 0 = ruler-straight runners |
| `leafSpacing` | m | Along-runner leaf spacing. ivy `0.07`, vine `0.115` |
| `leafSize` / `leafSizeVar` | m / ± fraction | Leaf size. ★ Leaves also **shrink toward the growing tip** automatically (young growth is small — visible in every ivy photo) |
| `leafDroop` | 0..1 | Gravity droop per leaf |
| `phyllotaxy` | `alternate` · `opposite` · `spiral` | Leaf arrangement (`opposite` = two leaves per node ≈ double the leaves) |
| `stemColor` | colour | ★ The **woody runner** colour — pale grey-brown by default, because in sparse ivy the stems are half the read |
| `runnerLod` | 0 · 1 · 2 | Distance LOD — ×1 / ×0.55 / ×0.32 leaves. Widens the spacing; it never deletes runners, so the silhouette survives. Leave at 0 for authored plants |

  **Wiring a point-list editor** (`path` mode): the host owns the point picking exactly like the Ribbon
  tool — collect `[x,y,z]` triples in the plant's LOCAL space (metres, `y` up, the plant's origin at the
  wall's bottom-centre) and push the whole array on every edit via
  `setFoliageParams3D(id, { ivyMode: 'path', ivyPath: pts })`. The generator smooths the polyline through a
  spline that **passes exactly through every point**, so what the user places is what the runner follows;
  add/move/delete a point and re-send the array. `ivyPathNormal` is the direction leaves face (the wall's
  outward normal). Nothing else changes — the same Look/colour/wind sections apply.

  Emitted layers: `foliage:stem` (the woody runner, `stemColor`), `foliage:leaf` / `foliage:tip`, and —
  wherever a runner has left the surface — `foliage:stem-free` / `foliage:leaf-free` / `foliage:tip-free`.
  ⚠ **Those `-free` layers are the wind split, not a cosmetic one** (see Look, below). Climbers are **real
  geometry**, so `render:'card'` does not alpha-cut them; leaves carry translucency `0.8`/`0.9` (backlit ivy
  glows) and **no ground blend** (a climber is attached to a wall, not planted). Caps: **64 runners** and
  **1400 leaves** per plant, each logged if it truncates. `getFoliageMeta3D(id).height` is the **measured**
  height (a hanging fringe can exceed `areaHeight`).

- **Woody** (shown only for `bush` / `shrub` / `hedge` / `small-tree` — the fourth archetype-scoped section,
  foliage-quality.md §3.5 `branch` + §3.6 `leafCard`/`clump`, phase P4). A woody plant is a **recursive limb
  skeleton with leaf masses at the twig TIPS** — that, not a central ball, is what gives it a silhouette.
  ★ Same rule as the flower/climber params: **every one is OPTIONAL and omitting it uses the archetype's own
  recipe**, so a `small-tree` looks like a tree with no panel work.

| Param | Range | Meaning |
|---|---|---|
| ★ `branchLevels` | 0..4 | **Recursion depth**: 0 = a bare trunk · 1 = trunk + limbs · 3 = trunk → limbs → branches → twigs. small-tree `3` · shrub `2` · bush `1` |
| `branchSplit` | 1..5 | Children per limb. Total limbs = `stemCount × Σ branchSplit^level` — raise it carefully |
| `branchSplitAngle` | rad (≈0.4–0.9) | How far a child leaves its parent by |
| ★ `branchGnarl` | 0..1 | Sideways bend of each limb's own spine. **0 = ruler-straight beams**, the loudest procedural-tree tell |
| `branchUpBias` | 0..1 | How hard limbs curve back toward the light — most of a tree's silhouette |
| ★ `stemCount` | 1.. | **1 = a single trunk** (tree/shrub) · **4–7 = a multi-stem fan from the base** (a bush) |
| `clusterSize` | m | Leaf-mass radius at each twig tip |
| ★ `canopyIrregular` | 0..1 | How far each leaf mass deviates from a **sphere**. The anti-lollipop knob |
| ★ `leafGaps` | 0..1 | Probability a tip is left **bare** — the see-through gaps into a shadowed interior (interior tips also thin automatically) |
| `hedgeSprigs` | int ≥ 0 | `hedge` only — shoots that have **escaped the clipped plane** |
| `hedgeRound` | m | `hedge` only — corner rounding of the clipped box |
| `branchLod` | 0 · 1 · 2 | Distance LOD — thins limbs (×1 / ×0.62 / ×0.38) **and** leaves (×1 / ×0.55 / ×0.30). A small tree goes 2 240 → 616 → 128 tris. Leave at 0 for authored plants |

  `size` is the plant height in metres, `width` the hedge **run length**, and `density` scales stem count,
  cluster fullness and hedge leaf density. ⚠ **`render` means something different for these four**: the limbs
  are always real swept tubes, but `chunky` gives the leaf masses low-poly **blobs** (the classic look, kept)
  while **`card` now emits REAL swept leaves** rather than alpha-cut quads — so `card` is the *quality* lean
  here, not the cheap one, and it is never alpha-cut. Caps: **320 limbs** and **1200 leaves** per plant, each
  logged if it truncates. `getFoliageMeta3D(id).height` / `.footprint` are **measured** from the geometry.

  Typical cost (default `size`, `chunky`): small-tree ~2.2 k tris · bush ~0.9 k · shrub ~0.6 k · hedge
  ~0.76 k at `width` 1 and ~1.9 k at `width` 4. ★ The hedge is **cheaper than the row of spheres it
  replaced** (−21 % / −33 %) because a shell costs surface AREA, not volume; the other three are 2–7× the
  old blob-on-a-stick, which is the price of having a silhouette (use `branchLod` for distant copies).

- **Vessel** (shown only for `potted` / `planter` / `window-box` — the fifth archetype-scoped section,
  foliage-quality.md §4 vessel types, phase **P4v**). These are not plants, they are **ARRANGEMENTS**: a
  vessel (unchanged), a **soil** surface, and a small composition of identifiable plants laid out by one
  rule — **a taller FOCAL plant (or a ROW of them along a long box) toward the back, MID filler around it,
  and EDGE plants at the rim TRAILING over the outward side**. Each plant is itself a composition of the
  P1–P4 primitives (a `branch`+`canopy` shrub · a `stalk`+`whorl` flowering plant · a `strap`-profile
  `blade` clump · a `runner` spilling downward), so nothing new had to be invented and every Look knob
  below already applies. ★ Same rule as the other sections: **every param is OPTIONAL and omitting it uses
  the vessel's own recipe**, so a window box looks like a window box with no panel work.

| Param | Range | Meaning |
|---|---|---|
| ★ `spill` | 0..1 (**default 0.5**) | **How far the TRAILING plants hang below the rim** — the window box's signature. `1` reaches well past the bottom of the box; **`0` removes the trailing plants entirely** (an upright-only arrangement) |
| ★ `plantCount` | int ≥ 1 | How many plants the arrangement places (the mix of focal/filler/trailing is preserved). Default: `potted` / `planter` 3–4 uprights + 1 trailer · `window-box` 3–5 uprights + 2–4 trailers, scaled by `width` and `density` |
| `soilColor` | colour | The soil disc/slab just under the rim — it is what stops you seeing through the opening into an empty vessel |
| `plantLod` | 0 · 1 · 2 | Distance LOD — fewer plants (×1 / ×0.6 / ×0.35) **and** a lighter version of each. ★ The **spill survives every band** (thinning it away would delete the look). Leave at 0 for authored plants |

  `size` is the vessel size in metres (pot height / planter height; the window box has fixed 22 × 28 cm
  proportions), `width` the window box's **run length**, and `density` scales plant count and per-plant
  fullness. The spill is always pinned to the **outward (+Z / front)** face for a planter or window box; a
  trailing plant in a **pot** spills radially, all the way round. Vessel plants are **real
  geometry**, so `render:'card'` does not alpha-cut them (it only swaps the shrub canopy's blobs for real
  swept leaves), and they get **no ground blend** — a plant in a pot is not planted in the world.
  Emitted layers: `foliage:vessel` (the pot/box), **`foliage:soil`**, `foliage:trunk` (shrub limbs),
  `foliage:leaf` / `foliage:tip`, `foliage:bloom` / `foliage:center` (real flower heads, with `bloom`),
  `foliage:stem` and — for the spill — **`foliage:stem-free` / `foliage:leaf-free` / `foliage:tip-free`**.
  ⚠ Those `-free` layers carry a **lifted geometry frame** (see the wind note in Look, below); their
  vertices are NOT in plant space until you add the layer's single `instances[0].y` offset. Caps:
  **10 plants** and **1 400 leaves** per vessel, each logged if it truncates — and the trailing plants get a
  **reserved share** of that leaf budget so a lush set of uprights can never starve the spill.
  `getFoliageMeta3D(id).height` and `.footprint` are **measured** from the arrangement (the footprint grows
  to cover the spill).

#### ★ Vessel QUALITY pass (they used to read below the other archetypes)

The arrangement *model* was right; the numbers under it were not, and the three vessel types came out
visibly poorer than a same-size `bush` / `grass-tuft` / `daisy`. What was actually wrong, and what changed:

| Was | Now |
|---|---|
| `potted` planted **exactly ONE** plant, dead centre (`single` layout) — `density` moved nothing and a ring of bare soil showed round the rim: a twig in a bucket | A pot uses the **GROUP** rule like a planter: a focal specimen + 2–3 fillers **pushed out toward the rim** + a radial trailer |
| The vessel shrub ran its canopy at **0.42 × density** vs the freestanding `bush`'s full density, on **2–4 stems** vs 4–7, leaves **0.13 × size** | Canopy density, stem count and canopy radius now **match the `bush` recipe**; leaves 0.17 × size. Only the tube tessellation stays lean (3 sides) |
| The vessel grass emitted **7–16 blades** where `grass-tuft` emits 30–60 at the same size | **15–36 blades**, full tuft length + a wider clump radius |
| The vessel flower was **one bare spine** (`branches: 0`) with 2–4 leaves and a single 6–10-petal head | **1–2 side branches**, each with its own head; 9–15 petals per head; 4–8 stem leaves |
| The spill was **2–4 see-through strands**, and the uprights ate the whole leaf budget before the trailers were planted | **4–7 strands**, leaves spaced 1.1 (was 1.4) leaf-lengths apart at near-full density, over a **reserved** budget share |
| Fillers bottomed out at **0.52** of the focal and sat at 0.42–0.72 of the half-extent (a huddle in the middle) | **0.62–0.88** of the focal, ringed at **0.5–0.88** of the half-extent (still strictly under the focal, still rooted inside the vessel) |

  Worst-case vegetation triangles over a seed / `bloom` / `render` sweep at `density 0.8` (**before → after**):
  `potted` **254 → 2 588** · `planter` **~600 → 2 580** · `window-box` **~1 000 → 4 552** (of which
  **≥ 1 350** is the hanging spill). A same-size standalone `bush` is ~2 670, which is the bar these are now
  held to; `pnpm vitest src/world/planting.test.ts` pins the floor so it cannot silently regress.
  `density` now genuinely runs sparse → lush (≥ 1.8× the triangles from the bottom to the top of its range)
  on **both** the plant count and each plant's own leaf mass. Use `plantLod` for distant copies.

`FoliageMeta` (out): `{ footprint: V2[], height, type }`.

## Scale + persistence + dev harness
- **Scale:** same system as buildings — authored in **real metres**, displayed at **1 unit : 10 m** default (shared so a
  bush reads correctly next to a tower); auto-framed on Add. `setFoliageScale3D` / `getFoliageScaleInfo3D` / `frameFoliage3D`.
- **Persistence:** params-only marker (`worldParams.kind === 'foliage'`). The marker is saved, but restores as an empty
  container that must be **regenerated on load** — the host MUST call **`restoreProceduralFromSave3D()`** once after the
  document loads (one call restores City + buildings + foliage; see [building-creator.md](building-creator.md#persistence)).
  Otherwise foliage (and buildings) won't reappear on reopen.
- **Console (no UI):** `salsaFoliage.type('window-box')` returns an id; `salsaFoliage.set(id, { size: 2, bloom: true })`;
  `salsaFoliage.move(id, { x: 5 })`; `salsaFoliage.list()` / `.types()` / `.remove(id)` / `.restore()`.

## Look (wind / translucency) — the SHARED shading + motion layer
**Built** (foliage-quality.md phases **S1 + S2**). This is *not* per-type geometry — it applies to **all 15 foliage
types at once** *and* to the ground **P5 scatter** vegetation (flowers / tall grass / bushes). Two halves:

- **S1 · Wind** (vertex stage). Displacement ∝ `pow(clamp(localY / windHeight, 0, 1), windStiffness)` — the **base
  stays planted**, the tip travels. Two bands (slow sway + fast ripple) plus **travelling gusts** that sweep across the
  world along the wind direction, and a **per-instance phase** hashed from each copy's world position, so a field never
  pulses in unison. The **shadow pass applies the same displacement**, so shadows sway with the plants.
- **S2 · Translucency + ground blend + base AO** (fragment stage). Light *through* the leaf
  (`max(0, dot(-N, L))` + a view-aligned backlight wrap) tinted by `translucencyColor` — the anime backlit-grass glow.
  It **composes with** the existing rim light (`celShade`), it does not replace it. The lowest ~15 % of the plant
  darkens (`baseAOAmount`) and picks up the ground colour (`groundBlend` / `groundTint`) so cards stop reading as
  floating.

### Scene wind (one global, drives everything)
| Call | Notes |
|---|---|
| `setSceneWind3D({ dirDeg?, strength?, speed? }) → SceneWind3D` | Partial patch; unspecified fields keep their value. Returns the resolved wind. |
| `sceneWind3D → { dirDeg, strength, speed }` | Getter for the panel's slider values. |

- `dirDeg` — heading over the world XZ plane (0 = +X, 90 = +Z); wraps into 0..360.
- `strength` — tip travel in local units at `windAmount` 1. **0 = dead calm.** Default ≈ `0.06` (a gentle breeze).
- `speed` — time multiplier for the sway/ripple/gust cycles. Default `1`.
- Console: **`salsaWind()`** reads it back · `salsaWind({ strength: 0.15 })` · `salsaWind({ dirDeg: 90, speed: 2 })`.
  A good "Look" panel section is three sliders bound straight to these.

### Per-material knobs (set by the generator; exposed for a future per-plant panel)
The generator picks sensible values per type, so the host does **not** have to set these to get the look. They live on
`Material3D` (flag bits 19 `windSway` / 20 `foliageShade`) and are stamped per emitted layer:

| Knob | Meaning | Generator defaults |
|---|---|---|
| `windStiffness` | Bend exponent — low = floppy, high = only the very tip moves. | ★ **ivy `0.5` / vine `0.55`** (see the climber note below — deliberately flat, *not* floppy) · **tall-grass `1.0`** · grass-tuft `1.2` · daisy/flower-bed `1.3` · rapeseed `1.5` · lavender `1.55` (a tall spike is woodier at the base than a little daisy) · **window-box `1.4`** (mostly soft bedding + trailing plants — see the spill note below) · bush `2.0` · planter `1.9` / potted `2.0` · shrub `2.1` · small-tree `2.2` (mid-LOW — a tree's floppiness comes from its tip layer, not from the exponent) · **hedge `3.0`** |
| `windHeight` | The plant's local height (m) — the grading denominator; **also** the base-AO/ground-blend ramp. | the type's computed `meta.height` |
| `windAmount` | Per-layer sway scale. | leaf ×1 · tip ×1.15 · bloom ×1 · **trunk ×0.15** · **vessel + soil ×0.04** (wood/ceramic/dirt barely moves) · ★ **woody types (P4): trunk ×0.1, tip ×1.35** — a tree's limbs barely move while its outer twig masses are the floppiest thing on it · ★ **vessel SPILL (P4v): stem-free ×1.0, leaf-free ×1.35, tip-free ×1.6** — nothing holds a hanging plant |
| `translucency` | Transmission strength 0..1. | leaf `0.55` · tip `0.7` · bloom `0.5` · **blade types leaf `0.75` / tip `0.88`** · **vessel types `0.72` / `0.86`** · ★ **flower PETALS `0.9`** (the thinnest geometry there is → the strongest backlit glow) · woody types in `card` (real leaves) `0.72` / `0.86`, in `chunky` (blobs) the plain `0.55` / `0.7` · centre `0.3` · **trunk/vessel none** |
| `translucencyColor` | Backlit tint — lighter + more saturated than the diffuse. | derived from `tipColor` / `bloomColor`; **petals use `petalTint()`**, which brightens the petal hue instead of pushing it green |
| `groundBlend` / `groundTint` | Ground-colour bleed at the base. | `0.35` for ground-planted types (bush · shrub · hedge), **`0.45`** for the real-geometry types (grass-tuft · tall-grass · daisy · rapeseed · lavender · flower-bed); **0** for vessel plants + wall climbers (neither touches the world's soil) |
| `baseAOAmount` | Base darkening over the lowest ~15 %. | `0.35` (blade + flower types `0.45`) |

### ⚠ Climbers sway by ATTACHMENT, not by height (`ivy` / `vine`, P3)
The height grading above assumes a plant **planted at its base**. Ivy is glued to its wall at *every*
height and only moves where it is **unattached** — grading it by height would make clinging leaves swing
like grass. So climbers do two things differently, with no shader change and no change to the S1 contract
(one `windHeight` + one `windStiffness` per plant, as every other type):
1. their `windStiffness` is deliberately **low (`0.5`)**, which flattens the height ramp to ~uniform, and
2. the generator **splits the geometry clinging vs free**: everything past a runner's last cling point goes
   to the `foliage:*-free` layers, which get ~**20×** the sway `amount` (attached `×0.06`, hanging `×1.05`).

Net effect: an ivy wall is visually still, and only the hanging fringe and free tips move in the wind.
Nothing for the host to set — it falls out of the generated layers.

### ⚠ A vessel's SPILL sways on a lifted frame (`potted` / `planter` / `window-box`, P4v)
The height grading also assumes a plant grows **upward from its origin**. A window box's trailing plants
hang **below** it — and `grade = pow(clamp(localY / windHeight, 0, 1), stiffness)` is exactly **0** below
the origin, so the one genuinely free-hanging part of the plant would be the only part that never moves.
Two things fix it, again with no shader change and no change to the S1 contract:
1. the `foliage:*-free` layers are emitted in a **LIFTED local frame** — every vertex pushed up, plus a
   single `instances[0] = { x:0, y:-lift, z:0 }` transform putting the mesh back. The world position is
   bit-identical; the shader just sees positive local Y. ⚠ **If the host reads a layer's vertices, add
   `instances[0].y` to get plant space** (this is the only place foliage uses `instances`), and
2. those layers carry a deliberately tiny `windHeight` (**0.12 m**) so the ramp **saturates** across the
   whole spill → a uniform, full-amplitude sway, with amounts ×1.0 / ×1.35 / ×1.6 on stem / leaf / tip.

Net effect: the box, the soil and the upright plants behave normally, and the spill is the floppiest thing
on the plant — which is what a real window box looks like in a breeze. Nothing for the host to set.

⚠ These knobs **repurpose the pattern instance slots** (like the packaging board + procedural-ground materials), so a
mesh is either a foliage material *or* a patterned/board/ground one — never both.

## Not yet (later work — see the spec)
Viewport click-to-select; a ghost preview. **Every generator phase is built** — P1 `blade`,
P2 `whorl`+`stalk`, P3 `runner`, P4 `branch` and P4v the vessel **arrangements** (see the Blade + Flower +
Climber + Woody + Vessel sections above), so **all 15 types are off the old blob construction**.
Still open: blossom `whorl` accents on a tree, an arbitrary-MESH ivy host, and ivy as a
building-attached param. Also open: a billboard/impostor far LOD band, and grass/flower **FIELDS** as an authored object (today a
field = the P5 ground scatter's `tallGrass` + `flowers` bands, driven by `scatterOnGround3D` / `salsaGroundScatter()`;
the `flowers` band is a real instanced daisy clump as of P2, with its own reduced-geometry LOD variant). (Item 4 — Building Editor mode + the foliage GRID tool — is built;
see [building-creator.md](building-creator.md#building-editor-mode--foliage-placement-the-grid-tool).)
