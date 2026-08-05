# Building Creator — Frogmarks UI Integration

Host-facing contract for the **Building Creator** (the "Add / Edit Building" flow), mirroring the
[Character Creator](character-creator.md) pattern: **Salsa owns the generator + scene lifecycle +
persistence; Frogmarks owns the panels/buttons.** Spec: [../specs/building-generator.md](../specs/building-generator.md).
Phase 1 is built (core generator + typology + facade engine + 5 archetypes + create/select/edit/persist).

## The flow (what the host builds)
Exactly like Add/Edit Character:
1. **Add Building** button → `createProceduralBuilding3D(...)` → a building appears in the scene + a new outliner
   item; select it (use the returned `id`).
2. **Select a building** (outliner click, or the returned id on Add). Gate the toolbar on
   `isProceduralBuilding3D(selectedId)` — when true, show the **Edit Building** button.
3. **Edit Building** → open the params panel seeded from `getBuildingParams3D(id)`; every slider/toggle change calls
   `setBuildingParams3D(id, { ...changed })` and the building regenerates in place (same id, selection kept).
4. **Style picker** (category → archetype) drives the panel defaults: `setBuildingParams3D(id, { archetype })`
   reloads a preset (keeps seed + placement).

Selection/gizmo/outliner are automatic: a building is a thin-wrapper container (one outliner node, moved/rotated as a
unit). Move/rotate via the gizmo persists automatically; or call `setBuildingTransform3D(id, {...})`.

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `createProceduralBuilding3D(params?, x?, y?, z?) → { id, meta }` | Add + place a building. `id` = container node id (selection handle). |
| `setBuildingParams3D(id, partial) → boolean` | Live-edit params, regenerate in place. Merge-style (send only changed fields). |
| `getBuildingParams3D(id) → BuildingParams \| null` | Seed the host sliders. |
| `getBuildingMeta3D(id) → BuildingMeta \| null` | Door / sign slots / roof anchor (for the sim + brandable-surface layer). |
| `isProceduralBuilding3D(id) → boolean` | Gate the "Edit Building" affordance. |
| `setBuildingTransform3D(id, {x,y,z,rx,ry,rz}) → boolean` | Move/rotate a placed building. |
| `removeBuilding3D(id) → boolean` | Delete a building. |
| `listBuildings3D() → { id, name, category, archetype }[]` | Host outliner / picker. |
| `buildingArchetypeNames3D() → string[]` | The style picker's options. |
| `buildingArchetypeParams3D(name) → Partial<BuildingParams> \| null` | Preview a style's defaults. |
| `restoreBuildingsFromSave3D() → number` | Regenerate all buildings from a loaded save's markers. **Call after document load** (like `world.restoreFromSave()`). |

## `BuildingParams` (the panel model)
Resolved as **defaults ← archetype preset ← explicit overrides**, so the host can send just `{ archetype }` for a
one-click style, or any subset of fields to fine-tune.

- **Typology:** `category` (`house`·`shophouse`·`apartment`·`office`·`tower`·`machiya`·`warehouse`·`mall`), `archetype`
  (11 styles: `suburban-house`, `brick-townhouse`, `retro-shophouse`, `neon-arcade`, `apartment-balcony`, `office-block`,
  `glass-tower`, `corporate-spire`, `machiya`, `warehouse`, `mall`), `seed`.
- **Massing:** `floors`, `width`, `depth`, `floorHeight`, `groundFloorHeight`, `cornerStyle`
  (`sharp`·`chamfer`·`round`), `cornerAmount`, `setbacks`, `setbackInset`, `podium`, `podiumFloors`.
- **Facade:** `windowStyle` (`grid`·`punched`·`ribbon`·`curtain`), `bayWidth`, `material`
  (`concrete`·`brick`·`plaster`·`tile`·`glass`·`timber`·`metal`), `pilasters`, `quoins`, `quoinStyle`
  (`alternating` — interlocking corner stones, the default · `block` — the old chunky corner cubes; only applies when
  `quoins` is on), `cornice`, `mullions`.
- **Ground/storefront:** `storefront`, `shopBays`, `stallriser`, `transom`, `shutter`, `awning`, `awningStyle`
  (`flat`·`sloped`·`dome`), `awningStripe` (striped fabric), `noren`, `recessedEntry`, `rollerDoors`, `canopy`,
  `lattice`, `doorStyle` (`flush`·`panel`·`glazed`·`double`·`auto-slide` — a real procedural door: frame + leaf/leaves +
  glazing + handle + transom + step; `auto-slide` = two commercial sliding glass panels + a header + sensor eye, baked
  closed, ready for later slide-open animation).
- **Greenery (attached foliage, auto-placed from the building's own geometry):** `baseHedge`, `vines`, `windowBoxes`,
  `basePlanters` + `greeneryColor`, `bloomColor`.
- **Features:** `balconies` (projecting walk-out slabs), `julietBalconies` (ornamental wrought-iron French railings
  hugging each upper-floor window — no slab; auto-aligned to the window grid, and only shown on `punched`/`grid`
  window styles, not `ribbon`/`curtain`) with `julietColor` (railing tint, default dark iron) + `julietScroll`
  (0 = plain bars → 1 = diamond + side scrolls), `windowTrim` (raised stone surround — sill + lintel + jambs, +
  keystone on `punched`; same window-grid alignment + `punched`/`grid`-only gating as juliet), `ledges`,
  `fireEscape`, `downpipes`, `wallUnits`.
- **Roof:** `roofStyle` (`flat`·`parapet`·`hip`·`gable`·`mansard`·`sawtooth`·`tiled-hip`), `roofPitch`, `deepEaves`,
  `roofClutter`, `roofPenthouse`, `roofRailing`, `roofGarden`, `roofDishes`, `roofVents`, `helipad`, `crown`
  (`none`·`spire`·`mech`·`blade`).
- **Signage:** `signage`, `bladeSign`, `wrapSign`, `rooftopSign`, `ledScreen`, `neon`.
- **Shading style:** `renderStyle` — `default` (PBR) · `cel` · `cel-hd` · `sketch` · `ink` · `gouraud`. Applies to the
  WHOLE building (every layer). Cel/Cel-HD = BotW/Ghibli toon; Ink = manga silhouette darkening.
- **Colour:** `baseColor`, `trimColor`, `roofColor`, `glassColor`, `accentColor`, `signColor`, `storefrontColor`
  (shopfront framing), `awningColor`, `doorColor` (leaf), `doorFrameColor` (jambs+head surround), `doorHandleColor`
  (handle/hardware — the door's three parts colour independently), `julietColor`, `windowTrimColor` (window surrounds
— sill/lintel/jambs, separate from general `trimColor`), `nightWindows` (0..1 lit fraction —
  ramps live with the day/night cycle). **Colour values accept any format** — `[0..1]` triple, `[0..255]` triple, `{r,g,b}`, or `"#rrggbb"` hex — the
  manager coerces to 0..1 (so a host picker can't send the wrong scale). NOTE: a color must be a value, not its inverse —
  Salsa renders exactly the RGB it's given (verified: no inversion in material/shader/post).

`BuildingMeta` (out): `{ height, footprint, door: {pos,out,width,height}|null, signSlots: {pos,out,width}[],
roofAnchor, windowAnchors: {pos,out}[] }`. (`door.width/height` = the opening, for slide/swing anim; `windowAnchors` =
upper-floor window centres, for window boxes + interactions.)

Note: **building-attached greenery** (hedges/vines/window-boxes/planters) lives in the *Building* panel above
(`baseHedge`/`vines`/… params) — it travels with the building. FREESTANDING foliage (loose bushes, trees, hedgerows) is
the separate **Foliage Creator** ([foliage-creator.md](foliage-creator.md)).

## Building Editor mode + foliage placement (the grid tool)
A dedicated edit mode (parallels the Character Creator's edit modes) for authoring foliage *on* a building. The host
flow: **Edit Building → Foliage tool → click the ground grid to drop plants** (rejected if they'd overlap the building
or another plant). Placements are stored in the building's params (`foliage[]`), so they **travel + persist with the
building** (into the city, on save).

| Method | Purpose |
|---|---|
| `enterBuildingEditMode3D(id) → boolean` | Frame the building + show the ground grid (for placement). |
| `exitBuildingEditMode3D()` | Leave; hides the grid. |
| `canPlaceBuildingFoliage3D(id, x, z, radius?) → boolean` | Hover check — is building-local `(x,z)` clear of the building + existing plants? Drive the host's valid/invalid cursor with this. |
| `addBuildingFoliage3D(id, placement, { checkOverlap? }) → number` | Drop a plant. `placement` = `{ x, z, rot?, ...FoliageParams }` (building-local metres). Returns its index, or `-1` if it overlaps (pass `checkOverlap:false` to force). Regenerates + persists. |
| `removeBuildingFoliage3D(id, index) → boolean` · `clearBuildingFoliage3D(id) → boolean` | Remove one / all. |
| `getBuildingFoliage3D(id) → FoliagePlacement[]` | List placed plants (to re-draw handles). |

`(x,z)` are **building-local metres** — the same space as `meta.footprint` and the grid — so the host snaps grid cells
to metres and passes them straight through. Console: `salsaBuild.edit(id)` / `.plant(id, {type:'bush', x:12, z:10})` /
`.plants(id)` / `.unplant(id, i)` / `.exitEdit()`.

> This is **manual** placement (precise, per-plant). The **auto** greenery (`baseHedge`/`vines`/`windowBoxes`/
> `basePlanters` params) is the quick, whole-building option — both coexist and both persist.

## Scale (model ↔ real)
The generator authors in **real metres** (a floor is ~3 m), then each building is *displayed* at a uniform scale mapping
metres → world units, so it sits at canvas ("model") scale with consistent relative sizes — a skyscraper genuinely
dwarfs a house. **Default: 1 world unit = 10 m** (house ≈ 0.6 u tall, office ≈ 2.9 u, tower ≈ 9–12 u). Add auto-frames
the camera on the new building, so it fits the view regardless.

| Method | Purpose |
|---|---|
| `createProceduralBuilding3D(params?, x?, y?, z?, { scale?, frame? })` | `scale` = units/metre override; `frame:false` suppresses the auto-frame. |
| `setBuildingScale3D(id, unitsPerMetre)` | e.g. `0.1` = 1 unit : 10 m. Regenerate-free (transform only). |
| `setBuildingMetersPerUnit3D(id, metresPerUnit)` | Set by the "1 : N" ratio directly. |
| `getBuildingScaleInfo3D(id) → { scale, metersPerUnit, realHeightM, displayHeightUnits, realWidthM, realDepthM }` | Drives the UI ratio + a real-dimensions readout (e.g. "1 : 10 · 29 m tall"). |
| `frameBuilding3D(id)` | Re-frame the camera on a building. |

The scale is persisted per building and applies as a uniform container transform (geometry + `meta` anchors stay in
metres — so the **city can later choose its own metres-per-unit** to size a building to a lot without regenerating).

## Persistence
Params-only, automatic — the building serializes as a lightweight marker (`worldParams.kind === 'building'`), NOT baked
geometry (same principle as the City). The marker IS saved into the document; but on load it restores as an *empty*
container that must be **regenerated**. So **the host MUST call a restore method once after the document finishes
loading** — otherwise buildings won't reappear on reopen.

> ⚠️ **Required on doc load:** call **`restoreProceduralFromSave3D()`** — one call that regenerates the City + all
> buildings + all foliage from their markers (returns `{ city, buildings, foliage }`). It replaces calling
> `world.restoreFromSave()` + `restoreBuildingsFromSave3D()` + `restoreFoliageFromSave3D()` separately. If buildings are
> missing on reopen, this call is almost certainly not wired. (Quick check: run `salsaBuild.restore()` in the console —
> if they appear, the markers are saved fine and just need this call on load.)

## Dev/testing without the UI
A console harness exists (built by `BuildingManager`): `salsaBuild.archetype('retro-shophouse')` returns an id;
`salsaBuild.set(id, { floors: 5, awning: true, nightWindows: 0.6 })`; `salsaBuild.move(id, { x: 20 })`;
`salsaBuild.list()` / `.archetypes()` / `.remove(id)` / `.restore()`.

## Not yet (later work — see the spec)
Phases 1–7 are built (11 archetypes; storefronts, facade detail, rooftop kit, setback towers, signage/neon, traditional
styles). Still pending: **visual tuning from a render** (the geometry numbers are first-guesses); viewport
click-to-select a building (currently outliner/return-id selection, matching the City); a ghost preview before commit;
Phase 8 (LOD tiers + a standalone shop designer); and **city integration** — the city auto-assigning `category` per lot
and passing a full frontage-mask / party-wall context to `buildBuilding` (the contract already accepts `footprint`, a
`frontRef` block-interior point that orients the entrance toward the street — the city passes the block centroid — and
per-edge `frontage`).
