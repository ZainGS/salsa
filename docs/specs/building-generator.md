# Procedural Building Generator

> **Deliverable of this pass:** this SPEC only. Built later, phased, screenshot-tuned. Save as
> `docs/specs/building-generator.md` (+ backlog line + memory pointer). This is a **foundational system** at the
> level of the character / hair / clothing generators. It's the geometry engine the [[city-visual-upgrade]] spec's
> Phase 4 + 6 depend on, the LOD-by-view detail source for a future [[project_street_level_mode]], and — a shop with
> signage being a brandable object — a step toward the branded-object product ([[frogmarks_vision]]).

## Context — the problem + the target
Today the city has NO building generator: `buildStreets` (src/world/streets.ts) extrudes each lot footprint, caps it
with a roof, and punches shader-pattern window holes — inline and minimal, so **every building is a near-copy**
(pink prism, dark hip roof, flat windows). The target is the **Neverness-to-Everness** range: varied glass towers,
detailed corner buildings with wrapped signage, ground-floor shops with awnings + neon, apartments with balconies,
traditional machiya, shotengai arcades — an urban fabric that reads *intentional and rich*.

A dedicated generator makes each building a **fresh parameterized instance**, so variety + detail are the default and
they COMPOUND: every facade feature we add multiplies the building space (same property as the hair primitives /
clothing modifiers). Much of the raw geometry (walls, roofs, signage, awnings, rooftop clutter) already exists scattered
across `streets.ts` / `signage.ts` / `awnings.ts` / `furniture.ts`; this spec **unifies** them into a real generator with
a typology, a facade-composition engine, an archetype library, and LOD — then extends the detail.

## The building CONTRACT (the interface)
The generator is a pure function: **BuildingSpec in → geometry + metadata out.** The CITY owns placement; the generator
owns the artifact. Contract (mirrors the character/hair minimum contract):
- **Generate** — `buildBuilding(spec) → { layers: LayoutPreviewLayer[]; meta: BuildingMeta }`.
- **Customize** — everything is params in the spec (regenerate on change).
- **Metadata out** — `BuildingMeta`: door anchor(s), sign/billboard slots, AC/rooftop anchors, the frontage — for the
  NPC sim, the brandable-surface layer, and later interactions.
- **LOD** — the spec carries a detail tier (far mass / mid / near) so the same building serves the diorama, the tiled
  world, and a future street view.

```
BuildingSpec {
  footprint: V2[]        // lot polygon (from the city)
  floors: number         // storey count (from buildingHeight)
  category: BuildingCategory   // ← the typology (below) — the city assigns it
  archetype?: string     // optional named style; else picked by category + seed
  frontage: boolean[]    // per-footprint-edge: true = STREET-FACING (gets a facade), false = party wall / interior
  corner: boolean        // two+ street-facing edges meeting → a corner building (wrap detail/signage)
  attached: boolean      // shares party walls with neighbours (row/shophouse) → no side walls on shared edges
  seed, style/palette, groundY, lod
}
```

## Typology — category × scale  *(THE spine — the city can't place buildings randomly)*
A building **must be tagged**, because scale + form are not interchangeable: you don't drop a 40-storey glass tower on a
residential lot or a detached house in a downtown core. Two axes:

**Category** (form + purpose):
| Category | Form | Where the city places it |
|---|---|---|
| `house` | detached, 1–3 floors, pitched roof, small footprint | residential district, small lots |
| `rowhouse` | attached townhouses, 2–4 floors, shared party walls | residential/market streets |
| `shophouse` | ground-floor shop + apartments above (the classic JP building) | commercial/market frontages |
| `apartment` | mid-rise residential block, balconies | residential/mixed, medium lots |
| `office` | mid-rise commercial block, ribbon/punched windows | commercial/downtown |
| `tower` | glass curtain-wall skyscraper, setbacks | downtown core, big lots |
| `mall`/`department` | large-footprint retail box, big signage | commercial hubs |
| `warehouse`/`industrial` | low box, roller doors | edge/industrial zones |
| `machiya`/`traditional` | timber facade, tiled roof, lattice | old-town / temple precinct |

**Scale class** (footprint × floors): `small` (house/shop) · `medium` (apartment/office) · `large` (tower/mall) — sets
the height range + footprint expectations + which archetypes are legal.

**The city assigns category** from what it already knows — `zone` (residential/commercial/civic) + `district`
(downtown/residential/market/mixed) + lot area + a seeded roll — so downtown big lots → towers/offices, market frontages
→ shophouses, residential → houses/apartments. This EXTENDS the existing zone→height logic in `buildStreets`; the new
piece is a `category` per lot, chosen by a placement table. **This mapping (zone/district/area → category → archetype) is
the crux — get it right and the city reads coherent, not a random pile of shapes.**

## Placement & context  *(the other half of "can't place randomly")*
A building is rarely alone — the generator must respect how it sits among its neighbours. The **city provides the
context** (from lot adjacency, which the block subdivision already computes); the generator consumes it:
- **Frontage mask** (`frontage[]`) — only STREET-FACING edges get a full facade (windows/storefront/signage); interior
  or neighbour-shared edges get a plain wall or none. (The "longest edge = frontage" helper in signage/streets is the
  seed of this — generalise to a per-edge street-adjacency test.)
- **Attachment / party walls** — row-houses + shophouses share side walls: on a shared edge, DON'T emit a side wall (the
  neighbour's fills it) so a market street reads as a continuous terrace, not a row of detached boxes with gaps.
- **Corner buildings** — two frontages meeting → wrap the detail + signage around the corner (NTE's rounded/detailed
  corner shops); often the "hero" of a block.
- **Gaps / alleys** — the block's lot subdivision leaves small setbacks/alleys (very JP); the generator just fills its
  own footprint — the city's inset controls the gap. (Optional: a tiny-alley pass that narrows some lots.)

This is genuinely interesting and it's where the fabric comes alive: **standalone tower with plaza** vs **continuous
shophouse terrace** vs **corner hero + alley** are all the SAME generator, differing only in the context flags the city
passes. Getting the frontage/party-wall logic right is Phase 1's hard part.

## The FACADE-COMPOSITION ENGINE  *(the heart — where variety + detail come from)*
A facade is not a texture; it's a **composition** built from stackable parts (like hair primitives + modifiers):
- A facade wall = a vertical stack of **floors**; each floor = a horizontal row of **bays** (the repeating window unit).
- The **ground floor is special** — storefront (shop) or entrance (residential).
- **Bay elements** (mix per archetype): window styles (grid / punched / ribbon / curtain-wall / lattice), spandrels,
  columns/pilasters, balconies, recesses.
- **Horizontal bands**: base/plinth, floor ledges + string courses, cornice/parapet, setbacks.
- **Ground-floor storefront**: glass shopfront + awning + shutter + signage band + entrance.
- **Rooftop**: parapet / hip / gable + AC units + water tank + antenna + billboard + rooftop garden (reuse `buildRoof`).
- **Material**: concrete / brick / plaster / tile / glass / timber — drives colour + the pattern-mask window shader +
  relief normals (all exist).
Composition rules live in the **archetype**, so a `tower` composes curtain-wall bays + setbacks + a crown, while a
`shophouse` composes a storefront ground + windowed uppers + a projecting sign + a tiled roof. This engine is the thing
that makes buildings *elaborate* — invest here.

## Archetype / style library  *(coherent variety — presets, like clothing/hair styles)*
An **archetype = a bundle** (category + facade composition rules + material palette + roof type + storefront style +
signage style). Named presets so the output reads intentional: `glass-tower`, `office-block`, `retro-shophouse`,
`neon-mall`, `apartment-balcony`, `machiya`, `warehouse`, `mixed-use`, … The city picks an archetype by category + seed
(+ district flavour); a future **standalone building designer** exposes the picker + sliders (the shop-as-brandable-object
product). Same pattern as `hairStylePreset` / clothing presets.

## Feature roadmap  *(phased — each phase multiplies the building space)*
- **Phase 1 — Core generator + typology + Building Creator.** ✅ **BUILT (2026-07-11).** The `buildBuilding(params) →
  { layers, meta }` contract + typology (5 archetypes: `suburban-house` · `retro-shophouse` · `apartment-balcony` ·
  `office-block` · `glass-tower`) + a facade-composition engine (plinth · windowed floors · ground storefront glazing +
  mullions + sill/transom · per-floor ledges · balconies · parapet/cornice **or** pitched roof · rooftop clutter ·
  awning · emissive sign band · entrance) + corner styles (sharp/chamfer/round) + metadata out (door/sign slots/roof
  anchor). Files: `src/world/building.ts` (generator), `src/services/managers/building-manager.ts` (create/select/edit/
  persist lifecycle — one thin-wrapper container per building, params-only marker `worldParams.kind:'building'`),
  ShapeManager `*3D` API + `docs/ui/building-creator.md` host contract + `salsaBuild.*` console harness. **Standalone
  only so far** — the frontage-mask/party-wall CONTEXT is in the contract (`buildBuilding(params, footprint?)`) but the
  city hasn't been refactored to pass it yet (see below). This already ends the sameness for Creator-placed buildings.
  _Remaining Phase-1 work:_ refactor `buildStreets`' inline extrude to call `buildBuilding` with per-lot category +
  frontage; viewport click-to-select; ghost preview.
- **Phase 2 — Ground-floor storefronts.** ✅ **BUILT (2026-07-11).** Multi-**shop-bay** frontage (frontage split into N
  shops, each: shopfront glazing + shopfront mullions + **stallriser** + **transom** + **shutter** box + **awning**
  (flat/sloped) + **noren** hanging curtain + per-bay **sign band** + a recessed **entry**). `emitStorefront` in
  building-parts.ts; `shopBays`/`stallriser`/`transom`/`shutter`/`awning`/`awningStyle`/`noren` params.
- **Phase 3 — Facade detail + materials.** ✅ **BUILT.** `emitFacadeDetail`: **pilasters** (bay strips), **quoins**
  (corner blocks), pronounced **cornice**, **downpipes**, wall **AC units**, **fire escape** (zigzag on a side edge),
  per-floor **ledges**, **balconies** (`emitBalconies`), residential entrance+canopy. Material system (brick/concrete/
  plaster/tile/glass/**timber**=lattice grid/**metal**=corrugated) drives the wall shader pattern in assembly.
- **Phase 4 — Rooftop detail.** ✅ **BUILT.** `emitRoofDetail` (flat/parapet roofs): **penthouse** access box, parapet
  **railing**, water-**tank** on legs, **AC array**, **antenna** mast, satellite **dishes**, **vents**, roof **garden**
  planters, **helipad** (H mark), house **chimney** on pitched roofs.
- **Phase 5 — Glass towers / skyline.** ✅ **BUILT.** Massing **sections** with **setbacks** + retail **podium**
  (`computeSections`, non-inverting centroid-shrink), real curtain-wall **mullions** (vertical fins), **crown** styles
  (`spire`/`mech`/`blade`). Archetypes `glass-tower` (26f) + `corporate-spire` (34f).
- **Phase 6 — Signage / billboards + neon.** ✅ **BUILT.** `emitSignage`: **blade signs** (perpendicular), **wrap** band
  (front + adjacent corner edge), **rooftop sign** box on legs, animated **LED screen** (`waves` shader, emissive),
  **neon** flag (boosts sign emissive). All push `meta.signSlots` — the ✦ brandable-surface anchors. Archetype
  `neon-arcade`.
- **Phase 7 — Traditional / special archetypes.** ✅ **BUILT.** `machiya` (timber, `tiled-hip` deep-eave roof, `lattice`
  koshi, noren), `warehouse` (metal/corrugated, `sawtooth` north-light roof, `rollerDoors`), `mall` (big footprint,
  entrance `canopy`, LED screens, rooftop sign). New roof styles: `hip`/`gable`/`mansard`/`sawtooth`/`tiled-hip`.
- **Phase 8 — LOD tiers + standalone building/shop designer.** 📋 Full/mid/far emission; a designer surface reusing the generator.

**Status 2026-07-11:** Phases 1–7 BUILT + type-check clean + smoke-tested (15,100-case sweep: 0 non-finite verts, 0 empty
results; per-building ≈70–3,800 tris). 11 archetypes. **NOT yet:** city wiring (Phase-1 remainder), Phase 8 LOD/designer,
and screenshot-based visual tuning (needs a render — the numbers are first-guesses).

## LOD tiers
The spec carries a `lod`: **far** = coloured mass + roof + a window pattern (cheap, for the tiled world's outer tiles),
**mid** = facade bays + storefront + basic rooftop, **near** = full detail + props + signage (street view). Same
parameters, different emission depth → one generator serves the diorama, the tiled world, and a future street view.

## How it slots in
- **Consumes the city's placement, doesn't replace it.** The city keeps roads/blocks/lots/zones/districts/heights; it
  gains a `category` per lot + the frontage/attachment context, and calls `buildBuilding(spec)` instead of the inline
  extrude. `buildStreets` becomes: build the spec per lot → call the generator → collect layers.
- **Subsumes the visual-upgrade spec's geometry phases** — that spec's Phase 4 (towers/skyline) and Phase 6's building
  detail (storefronts/facade) LIVE HERE; its atmosphere/lighting phases (fog/sky/SSAO/grade) stay renderer-side and are independent.

## Cross-cutting requirements
- **Reuse first** — walls/prism/obox/roofs/signage/awnings/rooftop-clutter/interior-mapping/window-shader all exist;
  unify + extend, don't rewrite. Emit `LayoutPreviewLayer[]` into the same flat-colour-group pipeline.
- **Determinism** — seeded per building (`hash(seed, lotId)`); same seed → same building.
- **Performance** — more detail = more geometry; lean on the archetype **geometry sharing / instancing** (buildings of
  the same archetype+params share a pool alloc) + LOD to keep the tiled world bounded. Profile.
- **Persistence** — params-only (the city already persists as seed+params; buildings regenerate).
- **Frogmarks** — later, a Building/Shop designer panel (category + archetype picker + facade sliders + signage).

## Recommended build order
**1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.** Phase 1 (core generator + typology + frontage/party-wall) is the foundation AND the
biggest immediate win (it ends the sameness); do it first even minimally. Storefronts (2) + facade detail (3) give the
street-level richness; towers (5) + signage/neon (6) give the NTE skyline + night look. Traditional archetypes (7) and
the standalone designer (8) come last.

## Open questions (decide per phase)
- Category assignment: a fixed zone/district→category table, or a seeded weighted pick per lot? (start with a weighted table.)
- Party walls: detect shared edges from lot adjacency, or infer from "edge not near a road"? (adjacency is cleaner if the block subdivision exposes neighbours.)
- Facade engine granularity: per-bay geometry (rich, heavier) vs a smarter window-shader + a few real balconies/ledges (cheaper)? (hybrid — real geometry for silhouette-defining detail, shader for flat window grids.)
- Does the standalone building designer share the exact city archetypes, or a superset? (superset — the city uses a curated subset.)
