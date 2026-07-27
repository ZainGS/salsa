# Procedural Ground — Material + Scatter System

**Status:** 📋 Spec (2026-07-24). NOT built. Reference: Pokémon Legends Z-A plaza/park/street ground.
**Sibling specs:** [world-generation.md](world-generation.md) (the composer pipeline this plugs into),
[foliage-generator.md](foliage-generator.md) (the card/clump vegetation this scatters),
[instancing-blocks.md](instancing-blocks.md) (how scatter draws cheaply), [city-detail.md](city-detail.md)
(the existing texture/patternMask layer), [city-visual-upgrade.md](city-visual-upgrade.md).

**Thesis.** Game Freak's ground isn't "one grass texture" or "one pavement texture" — it's a **small set of
repeatable rules with local variation**, layered. That is exactly Salsa's model: generate the diffuse / normal /
roughness / AO / height **in the shader from a seed + a compact parameter set**, and layer instanced **scatter**
(flowers, pebbles, tall-grass clumps, bushes, rocks) on top. Storage stays tiny (params, not textures); variety is
effectively unlimited. **Two halves, built independently:** (A) the procedural ground **MATERIAL** (§2–§6, a shader
job that extends the existing `patternMask` machinery) and (B) the **SCATTER** layer (§7–§9, an instancing job that
extends the existing `world/biome.ts` scatter). What sells the world is (B) layered over (A).

**Prime directive — REUSE, don't rebuild.** The engine already has: `patternMask(uv, mode, params, time)`
(mesh3d-shaders.ts:160 — running-bond brick, concrete speckle, staggered tiled-roof courses via `spacing>0.5`,
windows, animated waves) + **pattern RELIEF** (mask-gradient → normal perturbation, ~line 730) + a **per-tile hash
grain** (~line 733); `world/streets.ts` (street/deck meshes + `patternMode` selection); `world/biome.ts`
(`buildBiome` → merged colour layers, `scatterInPolygon`/`addTree`/`addRock` scatter); the foliage card/clump
generator; instancing + `Mesh3D.cheapBounds`; params-only persistence. The ground system is **new patternMask
GROUND modes + a scatter-rules pass**, NOT a new renderer.

---

## 1. Architecture — two layers over one param set

```
GroundZone (a plaza / park lot / street segment — a polygon in the world graph)
│  params = { seed, groundMix[], tiler, material, weathering, accents[], scatter } (a few hundred bytes)
│
├── (A) MATERIAL  — shader-generated per fragment, no stored textures:
│     mesh (the ground plane / street deck, already built by streets.ts / tile-build.ts)
│       └─ GROUND patternMask mode → diffuse · normal (from height) · roughness · AO
│
└── (B) SCATTER   — instanced props placed on the mesh at generate time:
      blue-noise clumps → flowers · pebbles · twigs · tall-grass clumps · bushes · rocks · trees
      density driven by the same wear / moisture masks the material uses (one source of truth)
```

- **A biome/zone is a compact parameter set** (a `GroundParams`), consumed by the world composer exactly like
  building/foliage params today. No baked maps; the shader draws the surface, the scatter pass places the props.
- The material's **masks (wear, moisture, dirt)** are computed once (procedurally, from the zone's path graph +
  noise) and **shared** by both halves: worn areas are smoother AND have fewer flowers; edges are darker AND grow
  moss. One mask, two consumers — the world reads coherent, not two independent noise fields fighting.

---

## 2. The ground MATERIAL model (layered, shader-generated)

Each ground fragment composes these layers (all cheap WGSL, no textures). This mirrors the Z-A pavement/grass
breakdowns. Everything is driven by a **per-stone/per-cell hash** so neighbours are never identical.

| Layer | What | Frequency | Notes |
|---|---|---|---|
| **Base tint** | HSV base per surface (§4) | — | limestone H 38–43° S 12–20% V 72–86%; grass H 95–110° S 35–55% V 45–70% |
| **Per-tile jitter** | brightness ±8%, hue ±2°, sat ±5% per stone id | per-tile | the anti-repetition rule — hash the tile id |
| **Macro cloud** | very-low-freq colour drift | 8–15 m | kills "golf-course / tiled-floor syndrome"; some areas yellower/darker |
| **Medium streaks** | soft limestone/grain streaks, random dir | 10–40 cm | very subtle; anisotropic noise along a per-tile angle |
| **Micro pores/pits** | tiny dark dots | 1–3 mm | sparse; a high-threshold hash |
| **Grout** | recessed seam between tiles | 1–2 cm wide | RGB ~(120,115,105) gray-brown; darker AO, +roughness, −height (§ height) |
| **Edge wear** | tile borders brighter/smoother/rounded | edge band | foot traffic polishes edges; drives the normal bevel + roughness down |
| **Dirt / moisture / wear masks** | usage-biased accumulation | zone-scale | §5 — the shared masks |
| **Height → normal** | per-tile height ±3 mm + edge bevel + pit dimples | — | derive the normal from the height field (reuse the relief-gradient trick, line 730), NOT a stored normal map |
| **Roughness** | per-tile 0.45–0.65 ±0.05, −at worn/polished, +at grout/dirt | — | packed into the material roughness the PBR path already reads |

**Compact param set (the whole point).** A zone stores only: `seed`, the `tiler` id + its dims, the `material`
preset id (+ small overrides), the `weathering` profile id, `accents[]`, and `scatter` rules. The shader
regenerates every map from that. Persist it in the world graph like building/foliage markers — a few hundred bytes
per plaza, not megabytes of texture.

---

## 3. Tilers (stone layout) — the cell/id generator

The tiler answers "which stone id owns this uv, and where is its local edge?" per fragment. New `patternMask` GROUND
modes (they extend the existing brick/shingle tilers). Each returns **cell id + local uv + edge distance** so the
material layers (§2) can jitter per-id and bevel at edges.

- **`runningBond` / `ashlar`** — large rectangular pavers (45×90 / 60×90 / 60×60 cm), offset rows; random-ashlar
  variant breaks the row rhythm. (Generalizes the existing running-bond brick tiler.)
- **`borderStrip`** — long linear stones framing a region (the plaza border bands).
- **`radialMedallion`** — concentric rings + radial wedges ("pizza slices"), each wedge a cell pointing at centre;
  the courtyard centrepiece. Polar-space tiling: `id = ring*N + floor(theta / wedgeAngle)`.
- **`herringbone`** — 45° interlocked rectangles (brick plazas / paths).
- **`voronoiCobble`** — irregular cobblestones via a jittered-grid Voronoi (Worley) — rounded, uneven.
- **`slab`** — simple square slabs 40–60 cm, random per-slab offset (the "simpler than the courtyard" path stones).
- **`none` (grass/asphalt/dirt)** — no tile grid; the surface is pure layered noise (§8, §6-asphalt).

A **plaza composes regions**: e.g. `radialMedallion` centre ⊂ `runningBond` field ⊂ `borderStrip` frame. Region
membership is a cheap polygon/ring test in uv; the world composer authors the region rects/rings.

## 4. Material presets (surface archetypes)

A preset = base HSV + roughness range + which layers dominate + tiler affinity. Small, hand-tuned, extendable.

| Preset | Palette | Tiler | Feel |
|---|---|---|---|
| **limestone** | warm tan (§2 base) | ashlar / radial | the courtyard — matte, faint grain, chipped corners |
| **sandstoneRoof** | clean warm beige | slab (large square) | rooftop "hotel flooring" — low roughness, tiny chips, slightly polished |
| **granite** | cool grey speckle | ashlar / slab | harder, tighter grout, mineral speckle |
| **slate** | blue-grey | irregular slab | flat riven layers |
| **brick** | red-brown | runningBond / herringbone | (reuses today's brick) |
| **cobblestone** | grey-brown | voronoiCobble | rounded, uneven, mossy seams |
| **asphalt** | dark blue-grey | none | §6 — cloudy 20–40 m patches, sparse seams, oil sheen near intersections |
| **grass** | green (§2) | none | §8 — the layered lawn |
| **dirt / sand** | brown / pale | none | wear-path terminus; blends from grass (§9) |
| **woodPlank** | warm timber | plank strips | bridges/decks — 20 cm planks, bevel, grain, few knots |

## 5. Weathering profiles + usage-biased wear (the shared masks)

Weathering is NOT uniform noise — it's **biased toward usage**, and the bias is a **mask shared with scatter (§7)**.

- **Traffic/wear mask** — high near the zone's walk paths + centre, low at edges/corners. Derived from the world
  graph's path splines (distance-to-path) + a little noise. High traffic → **smoother, brighter, less dirt, fewer
  flowers**. This is the single most important cue (it's what makes Z-A paths read as walked-on).
- **Moisture mask** — higher near water/shade/edges → darker, +moss tint, +grass/bush density.
- **Dirt/dust mask** — accumulates at edges and against walls/curbs.
- **Corners** → chipped (edge-wear extreme). **Edges** → darker, moss possible, dust.
- **Profiles** (presets over the masks): `new` (clean, sharp) · `worn` (default) · `ancient` (heavy edge round +
  moss) · `mossy` · `dirty`. A profile just scales the mask contributions.

## 6. Accent overlays + decals

Composited over the tiled surface (a second, sparse pattern pass or a decal):
- **Engraved rings / mosaics** (the medallion inlays), **drain grates**, **utility/manhole covers** (reuse the
  city furniture `manholes`), **expansion seams** (asphalt).
- **Painted road lines / crosswalks are DECALS, not baked** — separate quads/overlay so they stay crisp and
  independent of the ground tint (matches the Z-A note "paint = separate decals"). Reuse the existing decal/overlay
  path (eye-decal / UV-paint style transparent quads).

## 7. The SCATTER system (the biggest takeaway)

The ground itself is simple; **layered scatter is what sells it.** Extend `world/biome.ts` (which already does
`scatterInPolygon` → trees/rocks) into a general, **blue-noise, mask-driven** scatter over each zone.

```
ScatterRules (per zone/biome)
├── flowers      0.5–2% coverage   clustered      (card billboards / tiny quads)
├── pebbles      sparse            on stone/dirt  (instanced low-poly)
├── twigs        sparse            on grass       (instanced)
├── tallGrass    ~12% coverage     CLUMPS         (foliage clumps — §8; blue-noise, never a grid)
├── bushes       0.03 /m²          blobs          (foliage generator)
├── rocks        0.08 /m²          stylized       (existing addRock)
└── trees        0.08 /m²          leaf-cloud     (existing addTree / foliage)
```

- **Blue-noise placement, never a grid** — Poisson-disc / jittered-grid sampling (upgrade `scatterInPolygon`).
  Each instance gets random rotation, lean, height, density.
- **Density driven by the shared masks (§5)** — fewer flowers on the worn path, more grass/bush in moist/shaded,
  none in water (the `inWater` reject already exists). Coherent with the material.
- **Draw cheaply via instancing** ([instancing-blocks.md]) — one canonical clump/pebble/flower geometry + a
  transform buffer per zone; `cheapBounds` so movers/culling stay O(1). Vegetation reuses the **hair-card/foliage**
  path (leaf cards, alpha-tested).
- **LOD** — scatter is the first thing to cull at distance (tie into [project_city_lod] / spatial-streaming): drop
  flowers→twigs→pebbles→tall-grass as the camera pulls back; keep trees/bushes longest.

## 8. Grass (material + tall grass)

- **Lawn material (`grass` preset, tiler none):** base green + macro colour blobs (8–15 m, prevents uniformity) +
  fine directional "fibers" (brushed-fabric micro, not blades) + sparse dry tan flecks (2–8 cm) + a moisture tint.
- **Tall grass = CLUMPS, not shader blades:** each clump 30–60 curved tapered blades, 50–90 cm, placed by blue-noise
  (§7) with random rotation/lean/height. This is the foliage card/clump generator — the ground shader only tints
  the base; the volume is instanced geometry.

## 9. Dirt-wear path blending

Where grass meets a path the transition is a **blend gradient**, not a hard seam: grass 100→90→70→40→15→0% over the
wear-mask band, dirt/road showing through as grass thins (and scatter density falling to 0 across it). One blend
mask (the traffic mask, §5) drives both the material blend and the scatter falloff.

## 10. Biome / world integration

A biome names ground mixes + scatter + weathering + season; the composer generates everything from it. Extends the
existing `buildBiome` / world-generation Biome composer.

```
CityPark:
  ground:  { grass 70%, dirt 10%, stonePath 20% (slab preset) }
  scatter: { trees 0.08/m², bushes 0.03/m², flowers 0.5–2%, tallGrass 12% }
  weathering: worn
  season: summer
Plaza:
  ground:  { limestone: radialMedallion centre + runningBond field + borderStrip frame }
  scatter: { sparse — planters, drains }
  weathering: worn
```

- **Seasonal profile** (later): shift grass hue/dry-flecks, flower palette, add fallen leaves/snow scatter — reuses
  the ephemera fall-movers (petals/snow already exist in city-detail).
- Ground zones come from the world graph's lots/streets (park lots → grass biome; plaza lots → limestone; roads →
  asphalt), so this drops into the existing Layout→Biome→Street pipeline with no new topology.

## 11. WGSL implementation plan

- **New `patternMask` GROUND modes** (mode ids ≥ 8, alongside windows(6)/waves(7)): `ashlar`, `radialMedallion`,
  `herringbone`, `voronoiCobble`, `slab`. Each returns cell-id + local-edge distance (extend the mask return or add
  a companion `groundCell(uv, mode, params)` helper). ⚠ **NO backticks in WGSL** (template-literal trap —
  [reference_3d_shaders]).
- **Shared noise helpers** (add to the `PBR_IBL_WGSL` prelude so both FS variants get them, like `paperGrain`):
  `hash21`/`vnoise` (exist), add `fbm2`, `worley2` (Voronoi cobble), `anisoStreak`. Keep them cheap.
- **Height → normal** — reuse the relief-gradient perturbation (line 730): sample the height field at ±ε, perturb N.
  No stored normal map.
- **Slot packing** — reuse the per-instance material slots the pattern path already repurposes
  (`patternColor`=grout/edge/roughness knobs, `patternParams`=tiler dims / region rect). A ground material is just
  a `Mesh3D` with a ground `patternMode` + these slots — no new pipeline. Board-shade (bit 16) and texOverBase (bit
  15) show the pattern: this is a THIRD such flag family, so budget a `groundMode` sub-selector.
- **Perf** — all per-fragment math; the expensive part is Voronoi (cap octaves). Ground is large-area/low-overdraw,
  so it's cheap; scatter (§7) is the real cost, gated by LOD.

## 12. Phased build order

1. **P1 — Ashlar limestone material** ✅ BUILT 2026-07-24 (the courtyard field): `ashlar` tiler mode + base HSV +
   per-tile jitter + grout + height→normal + roughness. One preset, one zone. This alone upgrades every plaza floor.
   - **Flag** `Material3D.groundShade` = bit 18 (262144), exclusive with patternMode/boardShade/texOverBase (all
     ride the same pattern instance slots). **Slots:** `patternColor` = (groutRGB, groutWidthUv), `patternParams` =
     (tileW, tileH, jitter, groundMode). Serializes wholesale via `Mesh3D.toJSON` (params-only, no textures).
   - **WGSL** `groundAshlar(uv, base, grout, groutW, tileW, tileH, jitter) -> GroundOut{rgb,height,rough}` +
     `groundCell` / `groundHeight` helpers in the `PBR_IBL_WGSL` prelude (both FS variants share them). Running-bond
     rectangular tiler → per-tile hash jitter (brightness ±8% / hue ±2° / sat ±5°, via compact rgb↔hsv) + macro
     value-noise cloud + micro grain + sparse pits + recessed grout + polished edge-wear band. Height→normal via the
     ±ε relief-gradient trick; per-tile roughness fed into the PBR path (`roughOverride`). No Voronoi (cheap).
   - **How to try it:** in any illustration doc, run `salsaGround()` in the console (or
     `salsaGround({ size: 30, tileMm: 450, groutMm: 12 })`) — drops a large plane and applies the limestone material.
     Programmatically: `shapeManager.applyGroundMaterial3D(meshId, { tileMm, groutMm, tint, extentMeters })` (mm→uv
     via the plane's world extent, default 20 m). ⚠ Still needs an in-browser VISUAL pass (WGSL is build-verified only).
2. **P2 — Weathering masks** ✅ BUILT 2026-07-24 (§5): usage-biased aging layered over the P1 ashlar output —
   the #1 walked-on cue. Four cheap per-fragment masks in the `PBR_IBL_WGSL` prelude (both FS variants share them):
   `gr_edgeMask` (border + a CORNER extreme → darker/dust/moss/chip), `gr_wearMask` (low-freq usage noise OR an
   optional wear PATH = uv center+radius → a brighter/smoother worn TRACK; world path splines feed here later),
   `gr_moistMask` (edge + noise, lifted into grout seams → moss green tint), `gr_dirtMask` (edge/corner + noise →
   darker/rougher). `groundWeather()` applies them: **wear** brightens + polishes (−rough) + rounds edges (raises
   the relief height), **dirt/edge** darken + roughen, **moss** tints seams/edges, **corners chip** (deeper bevel +
   darker); dirt/moss/edge are gated by `(1−wear)` so worn areas wash clean. Each mask is a small fn so the P5
   scatter can mirror the formula (CPU-side equivalent = future). A `gr_profile(idx)` selector scales all four →
   **five looks from one knob**: `new`(0, ~off) · `worn`(1, default) · `ancient`(2, heavy edge/moss/dirt) ·
   `mossy`(3, moss-dominant) · `dirty`(4, dirt-dominant).
   - **Slots:** P2 ALSO repurposes `specularColor` (floats 36-39) — ground is a dielectric (metalness 0), so PBR
     spec is unused: `specular.r` = weather profile 0-4, `specular.gba` = wear-path (center uv + radius; radius 0 =
     noise-only). `diffuse.a` is left as the output opacity (NOT repurposed — a 0 profile would make the 'new' look
     transparent). Per-mask strength knobs (`groundEdge/Wear/Moss/Dirt`, `groundMossTint`) + `groundWearPath` are
     stored on `Material3D` for API + round-trip; the shader currently derives the effective weights from the
     profile (a CPU-side per-mask override is future work). No new flag bit — rides `groundShade` (18).
   - **How to try it:** `salsaGround({ weather: 'ancient' })` (or `'new'|'worn'|'mossy'|'dirty'`) — drops a plane
     with a default demo wear track (a worn center patch) so the weathering reads standalone. WGSL is build-verified
     only; the LOOK still needs an in-browser pass.
3. **P3 — Radial medallion + border regions** (§3) ✅ BUILT 2026-07-24 → composed plazas. TWO new tilers that
   reuse the P1 per-cell machinery (jitter + grout + height→normal) and the P2 weathering VERBATIM — only the
   cell-id / edge-distance function differs, factored into a shared `gr_shadeCell` + `gr_cellHeight`:
   - **radialMedallion (`groundMode` 1):** POLAR tiling about uv (0.5,0.5) — `groundCellRadial` returns
     (ring, wedge, edgeDistUv); `ring = floor(r/ringSpacing)`, `wedge = floor(theta/TAU·wedgeCount)`, edge = min of
     the radial ring-border distance and the angular wedge-border ARC length (so grout width is uniform in uv). The
     courtyard centrepiece. `groundTile` = [ringSpacing, wedgeCount].
   - **borderStrip (`groundMode` 2):** long linear pavers along uv.x — `groundCellBorder` returns (col, row, edge)
     on a non-offset grid; `groundTile` = [stoneLength, rowWidth]. The plaza frame band.
   - **COMPOSITION is MULTI-MESH, not per-fragment region logic** (matches "the composer authors the region
     rects/rings"): a disc medallion mesh + a border-ring mesh + an ashlar field mesh, placed separately.
     `salsaGroundPlaza()` drops the 3 composed meshes (ashlar field + radial medallion + 4 borderStrip frame strips,
     left/right yawed 90° so stones run the length) so it's demoable.
   - **Dispatch:** a `groundSurface(uv, mode, base, seam, groutW, p0, p1, jitter, wpc, wpr)` switch picks the tiler,
     then `groundWeather` (P2) applies over ALL modes uniformly (weathering is surface-agnostic — NOT duplicated
     per mode); a mode-aware `groundHeightM` feeds the ±eps relief normal. ⚠ WGSL build-verified only.
4. **P4 — Grass material** (§8 lawn) + **dirt-path blending** (§9) ✅ BUILT 2026-07-24. `grass` (`groundMode` 3,
   tiler NONE — pure layered noise, no pavers/grout): base green tint + MACRO low-freq colour blobs (yellower/darker
   patches, kills uniformity) + fine DIRECTIONAL fibers (anisotropic, brushed not blades) + sparse dry TAN flecks
   (high-threshold hash) + a moisture/moss tint (reuses `gr_moistMask`); high roughness (0.9), very subtle
   height→normal (soft, no tile edges).
   - **DIRT-PATH BLEND (§9):** where the P2 `gr_wearMask` (incl. the wearPath track) is high, grass THINS 100→0%
     across the wear band via `smoothstep(0.25, 0.85, wear)`, blending to a brown dirt colour (own grain + specks) +
     roughening + flattening — a worn path carves bare dirt through the lawn (the demoable payoff).
   - **Slots:** grass has no grout, so the seam slot (`patternColor.rgb`) is REPURPOSED for the dirt tint
     (`groundDirtTint`); base green rides `diffuse.rgb`; the fiber/fleck/macro knobs are WGSL constants keyed off
     the mode. Base HSV green H 95–110° S 35–55% V 45–70° via the `tint` opt (default ~[0.30,0.44,0.20]).
   - **How to try it:** `salsaGround({ surface: 'grass' })` (a default wear track carves a bare dirt patch through
     the lawn) or `salsaGround({ surface: 'grass', dirtTint: [...], tint: [...] })`. ⚠ WGSL build-verified only.
5. **P5 — SCATTER v1** (§7) ✅ BUILT 2026-07-24 — the instancing HALF: mask-driven blue-noise props over a
   ground mesh, density from the SAME weathering masks the material uses (§1 "one mask, two consumers").
   - **CPU masks** (`src/world/ground-masks.ts`): a faithful TS MIRROR of the P2 weathering WGSL
     (`pg_hash21`/`pg_vnoise`/`gr_fbm2`/`gr_edgeMask`/`gr_wearMask`/`gr_moistMask`/`gr_dirtMask` in
     mesh3d-shaders.ts) — same hash magic / fbm octave weights (0.65/0.35) / thresholds / edge band (0.16),
     with a header comment cross-referencing the WGSL so the two halves can't silently drift. Same formulas,
     not bit-exact (GPU fp32 + hw sin vs JS fp64) — close enough for shared-mask coherence. All masks ∈ [0,1].
   - **Blue-noise placer** (`src/world/ground-scatter.ts` `poissonDisc`): a jittered-grid candidate per cell,
     greedily rejected against a spatial hash → every accepted pair ≥ minDist (the min-distance property),
     seeded (stable across reloads / baked off the seed), always in-footprint. Each sample → random
     rotation / lean / height / scale.
   - **Scatter layers** (`buildScatterLayers`) — flowers (clustered, band 0), twigs (1), pebbles (2),
     tall-grass CLUMPS (leaf-card, band 3), bushes (4), rocks (5). Per candidate the shared masks modulate an
     accept probability: `wearMask` THINS (flowers/grass → 0 on the worn track), `dirtMask` suppresses,
     `moistMask` boosts grass+bush; a `fbm2` cluster field patches the clustered types. Reuses `Accum3D` for
     LOW-POLY placeholder geometry — ⚠ **vegetation quality is a deliberate LATER pass** (the user flagged the
     current foliage as low-quality); P5 ships the SYSTEM (placement + mask density + instancing + API).
   - **Instanced draw** ([instancing-blocks]): each layer → ONE canonical source Mesh3D (instance 0) + one
     explicit-offset `ArrayGroup3D` with per-instance yaw/lean/scale overrides, under its own BAND sub-group.
     A whole scatter field is a handful of nodes + draws, NOT thousands of loose meshes; `cheapBounds` on the
     sources. (`scene3d.addGroundScatterGroup`.)
   - **LOD hook** (§13): a per-frame distance gate (`_ensureScatterLOD` pre-render callback,
     `setGroundScatterLOD`) drops bands in order as the camera pulls back — flowers→twigs→pebbles→tall-grass
     first, bushes/rocks linger — keyed off the footprint extent. v1 simple gate; TODO tune per-band
     multipliers + fold into the world city-LOD regex once scatter is authored in the world composer.
   - **API:** `sm.scatterOnGround3D(groundMeshId, rules?) → groupId|null` (footprint from the mesh's world
     AABB; default `wearPath` inherited from the mesh's own `groundWearPath` so material + scatter share the
     track) + `sm.clearGroundScatter3D(groupId)`; `park` default rule set (`PARK_RULES`).
   - **How to try it:** `salsaGroundScatter()` (or `{ size, seed }`) drops a grass ground with a worn dirt
     track + scatters it — the flowers/grass visibly THIN over the track (the shared-mask payoff). ⚠ geometry
     quality + an in-browser visual pass still pending.
6. **P6 — More presets** (asphalt/cobble/granite/slate/woodPlank/sandstoneRoof) + **accents/decals** (§6).
7. **P7 — Biome params + seasonal** (§10) — wire into the world composer; the whole thing becomes a param set.

## 13. Storage / perf / scale

- **Params, not textures** — a zone is `{seed, tiler, material, weathering, accents, scatter}`; the shader draws it
  on demand. Persists like the building/foliage marker (worldParams), tiny, OPFS-friendly.
- **Instancing** for all scatter; **LOD** drops scatter first; **cheapBounds** on scatter movers. ✅ P5
  wires this: each prop type = one instanced `ArrayGroup3D` draw (not N meshes), `cheapBounds` on the source,
  and `setGroundScatterLOD` band-culls flowers→…→rocks by camera distance. TODO: fold the standalone scatter
  cull into the WorldManager city-LOD regex (`DETAIL_LOD`) so world-authored scatter culls with the city, and
  tune the per-band `×extent` thresholds from a render.
- **One material system, many surfaces** — the same shader path renders limestone, grass, asphalt, wood by preset,
  so N surfaces cost ~1 pipeline (matches the "30 generators not 3000 textures" philosophy).

## 14. Open questions

- Do ground zones get their own `Mesh3D` per lot (simple) or share a scene-wide ground buffer (fewer draws — tie to
  spatial-streaming)? Start per-lot, revisit if draw count bites.
- Radial-medallion polar tiling vs. an authored inlay decal for the fanciest ornaments — procedural for the common
  case, decal escape-hatch for bespoke centrepieces.
- Blue-noise at generate-time (bake the point set into the zone) vs. re-sampled on load — bake into the seed so the
  layout is stable across reloads.
- Is there a standalone **Ground Creator** mode (like the Building/Character creators — author a plaza's params +
  preview) or is it authored only inside the world composer? Likely a creator mode later, once presets settle.

---

## §11 · P6 — the MATERIAL LIBRARY (BUILT 2026-07-25)

Thirteen surfaces on the one `groundShade` path. Two new WGSL families plus a preset layer:

- **Organic (no cells, own shading):** `asphalt` (mode 4) — two-scale aggregate speckle, bright chips, a
  ridged-noise crack network; `dirt` (6) — broad + lump fields, grit, pale stones, and crazing *gated by
  the lump field* so cracks sit on dried crests rather than spreading evenly (even crazing reads as fabric).
- **New layouts (reuse `gr_shadeCell` verbatim):** `cobble` (7) via a new `gr_worley` voronoi returning
  (cellId, F2−F1 border distance); `plank` (8) via `groundCellPlank` with a per-row stagger + ring grain;
  `concrete` (5) via `groundCellGrid` — a **stack bond**, no row offset, because offsetting alternate rows
  is the fastest way to make poured concrete read as masonry.
- **Presets, zero shader code:** `brick` / `granite` / `slate` / `sandstone` are the **ashlar tiler** with a
  different stone size, colour, seam and jitter. A material differs from another by *appearance*; only a
  different **layout** earns a `groundMode`. `GROUND_SURFACES` in `shape-manager.ts` is the source of truth.

Also in this pass: the **grass rewrite** (§8 was a single low-frequency blob plus one globally-aligned
anisotropic streak, which smears to mud, and dry flecks drawn by a hard `step` on `floor(p * 4.5)` = 22 cm
tan squares). Now three scales — broad mow/health drift, smooth-noise **clumps** varying hue/sat/value
independently, and blade striation **rotated per clump** so the turf is never combed one way — with small
round soft-edged flecks.

### ⚠ Deferred, and the next real feature: TRANSITIONS
Every surface currently ends at a hard mesh seam. A composed world needs material-to-material borders —
grass fringing into dirt, a stone kerb between lawn and asphalt, a gravel apron round a plinth. Sketch:
a **blend mask** (two surfaces evaluated per fragment, mixed by a noise-perturbed region SDF so the join
is irregular rather than a straight line) for soft transitions, plus a **border-strip generator** driven
by the region graph for the hard architectural ones (kerbs, thresholds, edging). The shared-mask principle
already applies: the same region SDF should drive the blend AND thin the scatter across the join.
