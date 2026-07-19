# City Detail — Materials, Awnings & Street Furniture (phased spec)

**Status:** ✅ **Phases A–D first pass BUILT** (2026-07-03, engine); **E** = Salsa params + docs done, Frogmarks panel toggles pending. Screenshot-tune next.
**Engine:** `src/world/*` composers + the `world-manager.ts` bridge. Phase A needed **NO** core shader edit after all —
the `patternMask` already ships modes 1–5 (stripes/dots/diamonds/checker/grid); Phase A just plumbed a `mode` through
`LayoutPreviewLayer.pattern`. So the whole detail pass is contained (no core-render changes). **Host:** Frogmarks owns the panel toggles.
**Sibling specs:** [world-generation.md](./world-generation.md) · **UI:** [../ui/world.md](../ui/world.md)

> **Build note (2026-07-03):** A = pattern `mode`/`angle`/`emissive` plumbed through `LayoutPreviewLayer` → `addFlatColorMeshGroup`;
> sidewalks (slab grid) + plaza (tile) + per-zone facades. B = `awnings.ts` (striped awnings + shopfront glass + noren,
> reusing the frontage split). C = `furniture.ts` (utility poles + sagging wires, parked cars, glowing vending, manholes;
> position-hash deterministic, canal-skipping). D = `nightMode` param cranks emissive on signs/screens/lamps/vending/signal
> lamps (the `emissive` layer field). Rooftop water tanks + benches/planters/hydrants = the remaining C nice-to-haves;
> full day/night sky/ambient dimming = the Phase-5 sky/weather follow-up. All verified headless (0 NaN, deterministic).

> Answers the user's "what details can we add — sidewalk/road textures, materials, shop/building awnings?" The
> city today reads as clean massing on flat-colour ground. This spec is the plan to make surfaces + shopfronts +
> streets read *dressed*, using the three cheap levers this engine already has.

---

## 0. Where we are
The world renders as **flat-colour merged mesh layers** (`addFlatColorMeshGroup` → one colour per layer, half-emissive,
roughness 1), post-transformed onto the terrain by `world-manager._add`. Buildings already carry **windows** via a
**shader grid pattern** (`LayoutPreviewLayer.pattern` → `Material3D.patternMode:'grid'`), NOT geometry. Signage already
splits a building's street frontage into shops. Biome scatters trees/rocks. **The gap:** sidewalks/roads/plaza/facades
are solid colour; no awnings; street furniture is just lamp posts + signals. This spec fills that in.

## 1. The three levers (how detail is added HERE)
1. **Shader patterns** — "free" surface texture, zero geometry. Today only `grid` exists. **Cheapest lever, biggest
   reach** (Phase A). The only thing that edits core WGSL (`mesh3d-shaders`).
2. **`Accum3D` geometry** merged into flat-colour layers — props/furniture/awnings (`prism/cone/blob/walls/cap/beam/
   obox/disc/hood/pyramid/frustum/quad4`). Region-filterable + auto-draped by `_add`. Phases B–C.
3. **Materials** — per-layer colour / roughness / emissive; **night glow**. Phase D.

## 2. Cross-cutting requirements (EVERY phase)
- **Params:** add to `LayoutParams` + `DEFAULT_LAYOUT_PARAMS`, `?? default`-guarded so old saves load; live via `updateCity`.
- **Deterministic:** mulberry32 + `hash2`/`hash11`; same seed ⇒ same city.
- **Merged layers** (few draws) · **region-filterable** (the `keep(region)` predicate) for anything heavy · **capped counts**
  (poles/cars/tanks can explode — budget them) · rides the **height post-transform** for free (props lift, flat texture drapes).
- **Verify headless** (`npx tsc --noEmit` → esbuild+node: 0 NaN/bad-idx, deterministic) then **screenshot-tune**.
- **NEVER** `npm run build`; only `npx tsc --noEmit`. **No backticks in WGSL comments** (breaks the template literal) — see
  the 3D-shaders reference. Skinned meshes reuse the mesh3d fragment, so any `patternMode` change must keep the VS↔FS contract.

---

## Phase A — Surface textures & materials  *(highest ROI — textures the whole city cheaply)*

### A1 · New `patternMode`s: `stripes` + `brick`  (± `dots`/`tile`)
- **Problem:** only `grid` exists → can't do paving bond, awning stripes, masonry courses.
- **Design:** extend the `patternMode` enum + the WGSL `patternMask` (`mesh3d-shaders`), reusing the packed
  `patternParams` (freq, angle, scale, spacing @ MeshInstance floats 52–55):
  - **`stripes`** — 1-D bands along `angle` (awnings, hazard, barber, road tarmac seams).
  - **`brick`** — grid with every other row offset half a cell (running-bond masonry / paving).
  - *(optional)* **`dots`/`tile`** — dot screen / square tile (tatami, plaza inlay).
- **Plumb:** widen `LayoutPreviewLayer.pattern` to `{ mode?: 'grid'|'stripes'|'brick'; color; freq; scale?; angle?; spacing? }`
  (default `mode:'grid'` so existing window layers are unchanged); `addFlatColorMeshGroup` maps it onto the material.
- **Reuse:** the entire pattern pipeline already exists for windows — this is +2 mask branches, not a new system.

### A2 · Apply patterns across the map (near-free once A1 lands)
- **sidewalk** (`world:sidewalks`) → `grid` slab joints (large scale, light-grey line).
- **plaza / shotengai paving** → `brick`.
- **facades** — per **zone/district** variant on the `bldg-*` layers: `brick` (residential), `grid` panel (civic),
  fine `grid` glass-curtain (downtown). Drive off the existing per-lot loop in `streets.ts`.
- **roads** (optional) → faint `stripes` tarmac seams (keep subtle; lane paint already sits on top).

### A3 · Material variation
- **Per-district palette harmonisation** (warmer/neon downtown, muted residential) — a tint table keyed by `DistrictType`.
- **Wet-road sheen** (lower roughness on the road layer) · **glass emissive** (downtown facades) — sets up Phase D.
- **Params:** `groundTexture` (bool), `facadeStyle` (`auto｜brick｜panel｜glass`), `palette` (`default｜warm｜muted`).

**Unlocks:** dressed sidewalks/paving/masonry + striped-awning capability (Phase B) + the emissive hooks for night (Phase D).

---

## Phase B — Awnings + shopfronts  *(facade ground floor)*
- **Reuse:** the `signage.ts` **frontage splitter** already divides a building's longest edge into `n` shops and finds
  the outward normal — hang detail off the same loop (or a sibling `buildAwnings`).
- **Awning:** a tilted `obox` projecting over each shopfront, **striped** (`stripes` from A1) from a small palette; ~parametric
  drop + projection. **Noren** (door curtain): 2–3 short hanging quads under the awning.
- **Shopfront band:** recolour the **ground floor** darker (glass) + a small door recess (`obox` inset) — reads as storefront
  vs. the plain massing above. (A per-building base-floor strip, cheap.)
- **Params:** `awnings` (bool), `awningChance` (0..1), `shopfronts` (bool). Region-filterable; commercial/downtown always,
  residential sparse (mirror signage's rule).

**Unlocks:** the "shopping street" read at ground level everywhere (not just the shotengai).

---

## Phase C — JP street furniture  *(pure geometry — the most visible NEW stuff)*
All merged, seeded, region-filterable, count-capped. Placed at the **curb** (`streetWidth*0.5` — the real gap, per the
streetscape fix), never in the road/buildings.
- **Power poles + overhead wires** — the quintessential JP street: `prism` poles along arterials/curbs at intervals +
  **catenary `beam` wires** sagging between consecutive poles (a mid-drop control point). Cross-arms + a transformer `obox`.
- **Rooftop water tanks** — box/cylinder (`obox`/`prism`) on flat roofs (hook `buildRoof`'s flat/parapet path) + AC units.
- **Vending machines** — bright **emissive** `obox` clusters at corners / along the curb (very JP; ties to Phase D glow).
- **Parked cars / bikes** — low-poly `obox` bodies + `disc` wheels along curbs; seeded, **skip near crosswalks/junctions**;
  bicycle racks near shopfronts.
- **Small furniture** — benches, planters (+ a tiny `cone` shrub), bollards, trash bins, hydrants, **manhole `disc`s** on roads.
- **Params:** `powerLines`, `parkedCars`, `streetFurniture`, `rooftopClutter` (bools) + density knobs; hard caps per city.

**Unlocks:** the lived-in density; also seeds NPC/interaction anchors later (a bench/vending = a tag point).

---

## Phase D — Night mode / lighting mood
- **Emissive pass:** lit **windows** (emissive `grid`), **signs/screens/vending** glow, **street-light + lamp** halos.
- **`timeOfDay`** (0..1) or a `nightMode` bool: dims the sky/ambient (Phase-5 sky/weather territory) and cranks emissives.
  Can ship as a **standalone toggle first**, then fold into Phase-5 weather.
- **Params:** `nightMode` (bool) / `timeOfDay` (0..1).

**Unlocks:** the biggest single mood payoff; the neon-city hero shot.

---

## Phase E — Frogmarks UI + docs
- **World panel:** a **Detail** section — the new toggles (textures / awnings / power lines / parked cars / furniture /
  night) + density sliders, grouped; live via `updateCity`.
- **Docs:** update [../ui/world.md](../ui/world.md) `LayoutParams` table + this spec's status.

---

## Detail → lever map
| Detail | Lever | Reuses | Phase |
|---|---|---|---|
| Sidewalk slabs / plaza brick / facade masonry | shader pattern (A1) | window `grid` pipeline | A |
| District palette / wet road / glass emissive | material | per-layer colour/roughness | A |
| Striped awnings + noren | geometry + `stripes` | signage frontage splitter | B |
| Shopfront glass band + door | geometry/material | per-building base floor | B |
| Power poles + catenary wires | geometry | `prism` + `beam` | C |
| Rooftop water tanks / AC | geometry | `buildRoof` flat path | C |
| Vending machines (emissive) | geometry + material | `obox` + emissive | C/D |
| Parked cars / bikes | geometry | `obox` + `disc`, curb placement | C |
| Benches/planters/bollards/trash/hydrants/manholes | geometry | `Accum3D` primitives | C |
| Night glow (windows/signs/lamps) | material (emissive) | pattern emissive + light layers | D |

## Recommended order & ROI
**A → B → C → D → E.** Phase A is the highest leverage (one shader touch textures the entire city + enables striped
awnings). B and C are pure `src/world/` and independently shippable. D is the mood capstone (or a Phase-5 hand-off).
Reassess from a screenshot after each phase before the next.
