# Railway + metro upgrade

Started 2026-09-30. It follows the Persona polish work ([persona-polish-plan.md](persona-polish-plan.md)).

Status: `[ ]` todo · `[~]` partial · `[x]` done · `[-]` dropped (with reason).

## Today (the investigation)

- **Static viaduct** (`src/world/railway.ts`):
  - One straight single-track elevated line over a grid road line.
  - Hex piers every ~16.5 m (skipped over canals), a flat deck slab, 2 thin side girders and 2 round-beam rails.
  - No sleepers, ballast, catenary, parapets, stations or crossings.
- **Moving train** (`src/world/traffic.ts` `trainLayers`, ticker in `src/services/managers/world-traffic.ts`):
  - 4 articulated cars that shuttle between the span ends.
  - Each car is 2 boxes: a blue body and a dark window band (glows at night).
- **Materials:** 4 flat colours only.
- **Sky-train** (holograms mode): a glowing maglev beam plus a pod train (`buildSkyway`). Out of scope, keep it working.
- **Metro:** none.
- **Scale is wrong.** City scale is 1 unit = 15·s m, with s = R/10.

| Part | Now | Real |
|---|---|---|
| Car length | 9.6 m | ~20 m |
| Car height | **1.26 m** | 3.7–4 m |
| Car width | 1.5 m | ~2.9 m |
| Deck width | 1.8 m | ~5 m single / ~10 m double |
| Deck depth | ~0.36 m | ~1–1.5 m |
| Gauge | 0.72 m | 1.067 m |
| Pier | ~0.9 m hex | 1.5–2.5 m, T/rect with cap beam |
| Deck height | 10.8 m | 6–9 m |

The train is shorter than the 1.7 m Play character. It predates the real-metre city work.

**Decisions** (the main session's recommended defaults, pending the user's say):
- Fix the scale. Saved cities rebuild with it, like every recent round.
- Full scope, in phases.
- Liveries are generic and real-world-inspired: green-stripe commuter, silver with a coloured band, cream/orange local. No logos.
- Trains stop at stations with a dwell time.

## Phase 1 — Scale, viaduct, catenary, track, EMU

- [x] **R1.1 Real scale:**
  - double-track deck ~10 m wide at ~7.5 m
  - deck depth ~1.2 m
  - 1.067 m gauge per track, 4.0 m track centres
  - piers 1.6–2 m
  - everything in metres via city metres-per-unit
  - **Done 2026-09-30.** Code: `src/world/rail-layout.ts` (pure layout, `RAIL_M` table in metres) and `src/world/railway.ts` (geometry). Tests: `railway.test.ts`, `services/managers/world-rail-lod.test.ts`.
    - The deck top is 7.5 m over flat ground. It is raised so it clears the highest ground under the deck by 6.8 m (7.65–9.3 m on the default hilly seeds). **Fixed in R3.1:** the ground now includes the terrace levels. `elevation.rawTerraceLevels(params)` is params-pure, and the deck is sampled across its width with `cellLevelAt`. Over a road the street band is at the lower cell's level; over the arcade strip it is at the cell's own level. A canal cell reads its raw level, which is conservative.
    - Rail top = deck + 0.575 m (ballast 0.30 + sleeper 0.14 sunk 4 cm + pad + 0.165 m rail). The contact wire is 5.0 m over the rail top.
    - ★ The line now follows the WARPED street. The city's domain warp moves the road up to ~4.5 m, so the old straight noWarp viaduct sat on the buildings. `line.path` = warp(rx, z) sampled every 3 m. Deck parts use its rigid mitred frame; ground parts (columns, stairs) stand at warp(layout point). Still noWarp, still pure.
    - **Train contract.** `railwayLine(p)` keeps `rx, z0, z1, deckY` and adds `tracks` (2), `trackOffsets` (±2 m), `railTopY`, `gaugeU`, `contactY`, `unitsPerMetre` and `path` / `pathZ`. Helpers: `railFrameAt(line, z)`, `railTrackPath(line, k)`, `railStations(p)` → `{ z, halfLen, side }`. All pure of params.
- [x] **R1.2 Viaduct structure:**
  - T or rectangular piers with a wide cap beam, bevelled and tapered, with stained concrete
  - box-girder or slab edges with drip lines
  - solid parapets / noise barriers both sides, about 1.1–2 m (the Tokyo elevated look)
  - edge chips on caps and parapets via the existing chip helper, near only
  - **Done 2026-09-30:**
    - Over a grid street: PORTAL (rigid-frame) piers. Two tapered 1.5 × 1.6 m columns stand on the two pavements, so the carriageway stays clear for traffic, with a 1 m cap beam across the road. Where no street runs under the line (radial): T piers (one 2 × 1.8 m column + a 6.6 m cap). The column feet have a darker splash-zone band.
    - Frame placement:
      - one frame per block, clear of the junction box and its zebra landings (spans ~27 m)
      - slides along in 0.6 m steps to keep off shop doors
      - skips canals (the deck spans them), except where the line runs ALONG a canal for > 60 m; there the frames stand in the channel
      - never on a built lot, a landmark, a carriageway or outside the border
    - Deck: a box girder with sloped webs and cantilever slabs. Each edge has a fascia drip lip, a dark drip groove and a rain-stain band. End diaphragms close the section.
    - Parapets: 1.25 m concrete with panel joints and a separate coping. Metal noise-barrier panels (+0.8 m) run on ~45 % of the ~30 m runs. Cable troughs sit inside.
    - E2 edge chips: when `edgeWear` is subtle / heavy, the cap beams and parapet copings get chipped NEAR twins (`nearTwin` keys `rail-cap`, `rail-cope`) plus worn layers. Otherwise only the clean far twins are built.
- [x] **R1.3 Track:**
  - I-profile rails
  - instanced sleepers on a ballast bed or a concrete slab track
  - sleepers go in the fine-detail distance tier
  - **Done 2026-09-30:**
    - A ballast bed (dotted gravel) on the open line; concrete slab track through stations.
    - 2.0 m concrete sleepers every 0.62 m: about 910, 10.9k tris. They are merged and chunked along the line rather than GPU-instanced.
    - 12-point I-profile rails (foot / web / head) on 6 m chords.
    - Layers `world:rail-fine-sleeper` / `world:rail-fine-rail` (fine-detail tier).
- [x] **R1.4 Overhead catenary:**
  - steel masts every ~50 m, alternating sides or portal frames
  - cantilever arms
  - contact wire plus messenger wire with droppers (reuse the power-line catenary maths)
  - fine-detail tier
  - **Done 2026-09-30:**
    - Portal masts (the Japanese beam type) every ~45 m, wider through stations.
    - Per track: a hanger and steady arm (not true cantilever arms), a sagging messenger 1.1 m above a level contact wire staggered ±0.2 m, and 7 droppers per span.
    - `catenary()` moved from furniture.ts to meshbuild.ts and is shared.
    - Layers `world:rail-fine-cat-mast` / `-wire` (fine tier), ~1.6k tris.
- [x] **R1.5 EMU train:** one real commuter car definition, shared by the static parked train and the moving consist.
  - **Done 2026-09-30** — `src/world/train.ts` (tests `train.test.ts`, `services/managers/world-traffic-train.test.ts`):
    - 20 m pitch / 19.5 m body × 2.9 m × 3.68 m roof (3.95 m over the AC units), wheels on the rail top; cab / mid / pantograph variants (pantograph head at the 5.0 m contact wire).
    - Profile extrusion (tucked sill, smooth-shaded rounded roof) + overlays: 4 bi-parting door sets per side with door windows, window band with pillars, livery bands; cab: tapered nose, black mask, split windscreen, amber destination sign, headlights + tail lights, skirt + coupler; bogies (side frames, bolster, 4 wheels + axles), underfloor boxes, roof AC units.
    - Materials: car-paint `reflect` (stainless brighter/rougher), satin trim, painted `metal` AC units, tinted cab glass. Side glass = the facade INTERIOR-ROOM shader (`windows`, facade code 2) with a new TRANSIT flag (code 2 + `scale > 0.9`: every pane on the plain lit fraction, no per-band/per-floor gating — one small edit in `windowsPattern`); the glow walk puts `/train-win/` meshes at ~100 % lit after dark. Open doorways show a lit cabin (`-lit`, glow row with `-sign`).
    - Triangles: cab 1,176 · mid 940 · pantograph 956 → ~8k per 8-car consist (16k for both tracks).
    - Consist `railCars` 2–10 (default 8, fewer if the line is short); liveries `railLivery` green-stripe / silver + coloured band / cream-orange two-tone (`auto` = seeded). Names keep `world:traffic-train*` / `world:rail-train*` (hide rule + GLOW rows).
    - Cars ride the rail-layout track polylines (`railTrackInfo`: mitred-normal offsets of `line.path`, same maths as `railTrackPath`): each car is the CHORD between its bogies (±7 m) so the wheels stay on the rails through the warp curves (test: bogies < 1 cm off the track centre, pitch error < 5 cm).
    - Parked train: `buildParkedTrain(p, railwayLine(p), railStations(p))` (called by `buildRailway`), parked on track 0 at the first station, lead headlights + rear tail lights only.
  - Body and ends:
    - a 20 m body with a rounded roofline
    - cab ends with windscreen, headlights and tail lights on the end cars
    - 4 door sets per side with door windows
  - Windows:
    - a window band with pillars
    - a livery stripe
  - Roof and underframe:
    - pantograph, roof AC units, skirt and bogies with wheels
  - Glass and lights:
    - tinted glass
    - lit interiors at night, reusing the facade interior-room shader where feasible
  - Consist and materials:
    - 6–10 cars (default 8)
    - glossy paint and metal from the vehicle look
    - livery per line from a small palette
- [~] **R1.6 Keep it working:**
  - the articulated consist, the noWarp rule (the viaduct and train share pure layout space)
  - rail-* layer routing with no height field
  - LOD tiers, chunking, culling, persistence
  - the sky-train, tiled-world tiles, `params.railway` off
  - **Structure side done 2026-09-30:**
    - Every rail layer is `noWarp` + `drape: 'baked'` (tested).
    - Tiers go by name, on purpose, and each name is in exactly one zoom tier (tested):
      - DETAIL: `world:rail-fine-*` (sleepers, rails, catenary)
      - PROPS: `world:rail-stn-prop` and `world:metro-*` (not the lit sign)
      - STRUCTURE: every other `world:rail-*` (`/world:rail-(?!train|fine-|stn-prop)/`)
    - Layers are plain merged geometry, so `chunkCityLayers` splits them along the line.
    - The sky-train is untouched. `railway: false` drops everything but the metro kiosks.
    - `railway`, `stations` and `metroEntrances` are now FULL-regen params: the street plan is memoised and reserves their footprints.
    - Tiled-world tiles build their own line. Only the unit-tested code path is covered; not checked in the browser.

## Phase 2 — Stations, metro, stops

- [x] **R2.1 Elevated station:**
  - Platform: an island or side platform on the viaduct, 1–2 per line, placed over a road junction or near the station footfall landmark.
  - Platform dressing:
    - canopy roof
    - platform-edge tactile line
    - benches, signs and lights
  - Street connection:
    - a stair or escalator block down to a ticket-gate hall at street level: a box with a lit sign, glass front and gates
  - **Done 2026-09-30** (param `stations`, default on):
    - SIDE platforms. The tracks keep their 4 m centres through the station, so the train needs no spread.
      - The edge is 3.57 m from the centre and 1.6 m over the deck (≈1.03 m over the rail top).
      - ~2.4 m wide at the default street width; the station deck overhangs the lot line by at most 0.5 m.
    - Placement and length:
      - Length = `railPlatformCars` (the train's `railCars`, default 8) × 20 m + 6 m, centred over a grid junction near a seeded spot.
      - The car count never changes which junction is chosen.
      - The city is ~280 m across, so an 8-car line gets one station; short trains leave room for a second.
    - Dressing:
      - a white edge line, and a yellow tactile strip 0.8 m back
      - a canopy on posts over the middle ~65 %, with lamp strips under it
      - hanging name boards facing the track, and benches
      - a lit station sign on each wing parapet
    - Street connection:
      - A covered stair runs from each platform's outer edge down the CROSS-STREET pavement: 34°, 1.2 m foot landing, hand rails.
      - The ticket-gate hall is tucked under the stair's upper flight: solid back and lot-side wall, glazed road side, lit name band, a row of gate cabinets.
      - A side is used only if the flight and hall clear lots, canals, carriageways, the border and every shop door. Otherwise that platform has no stair (seed 7 has none).
      - The stair's top is blended onto the deck frame and its foot onto the warped pavement.
    - Street plan: nothing is placed on a column, a stair or a hall. No street tree or utility pole stands under the deck or within ~3 m of a stair (tested over 6 seeds).
    - Not built: escalators, the island-platform variant, and placement near the station footfall landmark.
- [x] **R2.2 Station stops:**
  - [x] Trains slow, dwell (~20–30 s, scaled) and depart. `stepTrainRun` (train.ts): accel 0.8 m/s², cruise 12 m/s, braking curve v = √(2·1.0·d) to a stop with the consist CENTRED on each `railStations` z (arc position via `trackArcAtZ`), dwell 24 s (30 s at a terminus) × `railDwellScale`, reverse at the termini. One consist per track, opposite directions (keep-left). Ticker: `WorldTraffic._tickRailRun` (allocation-free, trains always pose).
  - [x] Doors slide open/closed (2.2 s) during the dwell: the `-doorA` / `-doorB` leaf meshes are posed ±0.64 m along the car axis. Both sides open.
  - [x] **Walkers and the footfall field treat station entrances as destinations.** Done 2026-09-30 (`src/world/station-entrances.ts`):
    - The entrances are the elevated line's stair feet (the ticket hall sits under the upper flight), the metro kiosks' open ends and the local line's platform stairs (R3.2).
    - The footfall field (`pedestrians.ts footfallField`) adds a hot spot at each one: stairs 1.8·s radius, weight 0.9; kiosks and local stations 1.2·s, 0.6. More of the crowd and the routed walkers gather there.
    - Live walkers within ~5 m of an entrance may catch a train (~32 % per 10 s window, at most 8 at once). They walk up, vanish "through the gates" and someone walks back out 8–22 s later. This is the door-visit sim with no door leaf (`DoorSpot.station`); the walk in and out takes as long as walking that distance.
    - Test: `world-traffic-local.test.ts` (station visits happen).
- [~] **R2.3 Metro entrances:**
  - street kiosks with a stair down under a glass or metal canopy
  - an "M" sign pillar and vent grilles
  - placed on pavements near major junctions via street-slots (reserve space)
  - optionally a tunnel portal where a line dives underground at the city edge
  - [x] **Kiosks done 2026-09-30** (`src/world/metro.ts`, param `metroEntrances`, default on):
    - The kiosk: 5.2 × 1.56 m in teal metal, with low walls, glass panels and a flat canopy.
    - The stair well shows as dark striped treads just above the pavement; the ground is never cut.
    - A lit square sign box on a pillar at the open end: subway blue with a lit white "M" on both faces (`world:metro-sign-letter`, added in R3.1; there are no 地下鉄 glyphs in sign-glyphs). A vent grille block sits at the back.
    - Placed by street-slots step 15, which runs last so no other family moves:
      - just past a tee / cross junction mouth, taking the whole pavement width
      - ≥ 8 m off the viaduct deck, ≥ 30 m from a station stair, ≥ 70 m apart
      - about 3 per city, commercial / arterial sides preferred
    - The toggle stops only the emit; the reservation stays.
    - Layers `world:metro-*` are baked at each kiosk's ground height and warped with the city. Kiosks get contact shadows.
  - [-] Tunnel portal: not built, because no underground line exists to dive into.

## Phase 3 — Under-viaduct life, crossings, routes

- [x] **R3.1 Arches under the viaduct:** some bays become izakaya, shops, bike parking or storage (reusing frontage, shop windows, lightbox signs and noren), others fenced service space.
  - **Done 2026-09-30** as a second viaduct style, `railViaduct: 'arcade'`. The default stays `'portal'`, so saved cities are unchanged.
  - Code:
    - `rail-layout.ts`: `ARC_M`, `railViaductMode`, `arcadeStrip`, `claimViaductLots`, and `RailLayout.bays` / `.runs`
    - `rail-arcade.ts`: the geometry
    - `railway.ts`: slab deck, plate girders and the arcade emit
  - Tests: `railway.test.ts` (arcade block), `world-rail-lod.test.ts`, `city-materials.test.ts`.
  - **Line.**
    - The line runs BESIDE its road, on a seeded side. Its centre is the lot line + 4 m.
    - The deck is still ±5 m, so it hangs 1 m over the pavement (the shaded footway) and reaches 9 m into the strip.
    - `RailLine` gains `mode`, `roadX` and `side`. `rx` is the arcade centre, so `path` / `railFrameAt` / `railTrackPath` / `railStations` describe the arcade line and the train needs no change. `train.ts` still never imports `railway.ts`.
  - **Lot claim.**
    - `claimViaductLots` runs in `generateCityLayout`, after the districts and before landmarks / shotengai (and in the layout-only path).
    - It claims a 9.9 m strip from the lot line. Overlapping lots are trimmed to the part behind the strip when at least 4 m remains, otherwise dropped. Trimmed lots keep their other street edges.
    - Each block the strip crosses gets BAY lots (slot `'viaduct'`, ~10 m pitch, `lot.bay` = the fill) and is tagged `block.viaduct`, so landmarks and the shotengai skip it.
    - Because bay lots are built-zone lots, the street plan treats the arcade as the building line: an entrance slot at each bay door (one small street-slots edit makes it use the bay's street face), nothing placed inside, nothing tall under the deck.
    - Shop, eatery and izakaya bays get `lot.door` / `doorOut` (door visits); their lots feed the footfall field.
    - The bay nearest each station becomes its station entrance.
  - **Structure.**
    - A cross wall every bay (0.9 m; 1.3 m end walls at a cross street) up to the deck soffit.
    - Pilasters with bulkhead lamps, and a cornice band.
    - Brick style (about 55 % of cities): basket arches with a proud voussoir ring, keystone and imposts, and a barrel vault through each bay. Concrete style: lintels and a flat soffit.
    - The deck is a lipped 0.6 m slab carried by the walls. Steel plate girders (`world:rail-arc-girder`) span the gaps between runs. T piers stand only in open gaps over 22 m (a canal, the border approach).
    - Parapets, barriers, track and catenary are unchanged.
  - **Fills** (street face; the back face has steel service doors and louvres):
    - izakaya: a sliding lattice door and lit shoji windows over a timber dado, noren, two red chōchin lanterns, a lightbox with sign-glyphs words, a vertical tate sign on the pilaster, a menu board and a plaster tympanum
    - eatery: the same front with shop-interior glass and a fabric awning
    - shop: a glass shopfront on the shop-interior window pattern, aluminium mullions, a lightbox and an optional awning
    - bike parking: floor bays, two rows of `bike-rack.ts` hoops with parked bicycles, a lit "P" sign and ceiling lamps
    - storage: a roller shutter with its box and a louvred panel
    - service: a mesh fence and gate, pipes, meters, a cabinet and a warning plate
    - station entrance: a lit name band with the line stripe, ticket gates, ticket machines and a stair climbing into the viaduct
    - The fill is seeded per bay and weighted by district. Bays near a station lean to bike parking; a bay facing a canal is never a shop.
  - **Tiers, glow and materials.**
    - `world:rail-arc-prop*` is PROPS (added to `PROPS_LOD`, excluded from `STRUCTURE_LOD`). Every other `world:rail-arc-*` is STRUCTURE.
    - Lit parts glow by name: `-sign-`, `lantern`, `lamplights`, `shop-glass`. Lettering ink is `letter-ink` (not lit).
    - One family per mesh (tested). Everything is noWarp + baked, plain merged layers (chunk-friendly).
  - **Numbers (seed 3 arcade).**
    - 20 bays: 5 shop, 4 eatery, 3 service, 2 izakaya, 3 bike, 2 storage, 1 station entrance.
    - Arcade about 22k tris (22–29k over seeds 1/3/7/11); whole railway about 51k.
    - Build about 100–170 ms (cold).
    - Headless `trisTotal` at the arcade: 2.79M.
  - **Browser-verified** (headless WebGPU, `scratchpad/pupdrive/arc/arc.js`, seeds 3 and 6):
    - street-level views of every bay kind, Noon and Night
    - a moving train overhead
    - the concrete style (seed 6)
    - the metro "M" at night
  - Limits:
    - A station on an arcade line has no platform-to-street stair of its own. The cross-street run behind the arcade is shorter than a flight, so the stair sits inside the entrance bay and the platform shows no opening.
    - The deck lifts with the highest terrace under the line (it stays level). Seed 7's arcade deck is 11.7 m, so its spandrels are tall.
    - Frogmarks control not added (param reported).
- [x] **R3.2 Level crossing (fumikiri):** where a line runs at grade or a road crosses a low line:
  - yellow/black barrier arms that lower when a train approaches
  - a crossbuck and alternating red lamps synced to the train
  - cars and walkers wait
  - **Done 2026-09-30, on the new at-grade LOCAL LINE** (param `localLine`, default off; `localLineCars` 2–4, default 2). Code: `src/world/local-line.ts` (pure layout), `src/world/local-line-build.ts` (geometry, track contract, consist), `src/world/level-crossing.ts` (timing), `src/services/managers/world-crossings.ts` (live arms, lamps, road-user hold).
  - **The line.** A single-track private line in the Tokyu Setagaya / Enoden style. It runs at street level on its own fenced ballast corridor through the middle of a block row, between the back-to-back lot strips. It crosses every cross street at grade and ends in a buffer-stop terminus at each end. Grid cities only.
    - It is planned inside `gridLayout`, deterministically:
      1. Pick a row, the run and the stations; flatten the terrace level of the cells it touches (before the S9 fix-ups).
      2. After the fix-ups, merge away the road segments a station platform or the curve spans.
      3. After the lots, carve every lot over the corridor into the parts either side of it. The cut is axis-aligned (the building generator fits rectangles), with a 0.4 m setback. A piece under 3 m deep, or with no street edge, is dropped.
      4. After the roads, find the crossings.
    - It never crosses the elevated line's road. It ends beside it (an interchange), clear of the arcade strip.
    - Corridor: 2.4 m either side of the track, 4.75 m on a station platform's side. Walls onto it read as party walls, so no fire escape or balcony hangs over the track.
    - Blocks it runs through are tagged `localLine`: landmarks, the shotengai and ponds skip them.
  - **Track.** It follows the smooth terrain on the block paving. The rail top is kerb + 0.315 m: a thin ballast bed, 2 m concrete sleepers every 0.65 m, and I-profile rails at 1.067 m gauge.
    - Pipe fences with a see-through mesh run both sides.
    - A single-track catenary has a mast every ~30 m, bracket and steady arms, and a messenger with droppers over a staggered contact wire at 5.0 m (the EMU pantograph reach).
    - The static layers are layout space, baked heights, and warped with the city.
  - **Crossings** (5–6 per line):
    - The road is raised onto the rails by a board table (concrete panels over the track core, asphalt ramps with the road's own world uv). Cars and walkers ride the same surface (`crossingSurfaceY` in the ticker's ground sampler).
    - Paint: white stop bars on each approach lane, white edge lines, a yellow centre line.
    - Per approach, on its left pavement edge (the diagonal narrow-road layout):
      - a barrier machine with a yellow/black sleeve, and a striped arm spanning the pavement and the approach lane
      - a warning mast with a crossbuck, two red lamps on a black backplate with visors, a direction box and a bell dome
    - Crossings on the curve are skewed up to ~24°. A crossing near a row junction turns that junction into a pass-through, so no crossing is closer than ~9 m to a junction (tested).
  - **Timing** (`level-crossing.ts`):
    - Demand: the consist overlaps the crossing's zone (the street band along the track, + 2 m), or its estimated arrival is under 11 s.
    - The estimate is dwell left + the time to cover the gap accelerating to cruise, with no braking. It is never late.
    - A train that will stop short of the crossing at a station does not close it; a terminus counts the direction it will leave in.
    - Lamps flash alternately (~50 a minute) as soon as demand starts. The arms start down 2.5 s later and take 4 s; they rise over 4 s once the rear has cleared.
    - Tested against `stepTrainRun` on 4 seeds: arms fully down whenever the train is on a road (≥ 6.5 s early), and every crossing reopens.
  - **Live** (`world-crossings.ts`, owned by WorldTraffic):
    - The arms are their own meshes, posed about local Z (`setPoseXYZYaw` roll). The static build carries raised arms that are hidden while the sim runs, like the parked train.
    - The lamps are static `world:local-xing-lamp-<i><a|b>` layers, re-dressed with a MATERIAL-only write (`materialDirty`, never `gpuDirty`), like the signals.
    - Cars brake onto the stop line of a closed crossing. They also never enter an OPEN crossing whose far side is blocked by a queued car (the exit-box rule).
    - Walkers wait 0.5 m outside the barrier.
    - Tested over 4 simulated minutes (`world-traffic-local.test.ts`): no car or walker is on a crossing while the train is, cars queue at the stop lines, and the lamps flash.
  - **Stations**: one at each terminus when the run is long enough (else one, at the viaduct end).
    - The platform is sized for the consist: cars × 16 m + 3 m. It is merged across the block roads it spans.
    - Side platform, 1.0 m over the rail top, 2.6 m wide, 1.5 m off the track. A white edge line, a yellow tactile strip, a shelter over the middle half with a lamp strip, a bench, a lit name board and a back fence.
    - A stair runs down at the buffer end. Its foot is a walker destination (R2.2).
  - **The consist.** The EMU car scaled to 16 m × 2.7 m (0.8 × 0.93). The −x cab carries a pantograph (`emuCarLayersEx` in train.ts).
    - Livery: cream/orange, or green-stripe when the main line is cream.
    - It runs terminus to terminus with `stepTrainRun` (cruise 9 m/s, accel 0.7 m/s²) and dwells 30 s × `railDwellScale` at each end with the doors open.
    - Each car rides its terrain-following rails: y and pitch come from the two bogies' rail heights (`MoverSpec.run.heights`).
    - Parked (traffic off): at the first station, as `world:local-train*`.
  - **Tiers, glow and shadows** (tested in `world-local-lod.test.ts`):
    - DETAIL: `world:local-fine-*` (sleepers, rails, fence, catenary).
    - PROPS: `world:local-prop`, `world:local-xing-*` (the lamps excepted).
    - STRUCTURE: every other `world:local-*`.
    - Untiered: the lamps, the station sign and lamps, and the train.
    - GLOW row: `local-xing-lamp` with the signals (0.55 / 1.5).
    - Contact shadows: `world:local-xing-prop`, `world:local-prop`.
    - Each layer carries one material family (tested).
  - **Street plan**: step 0 claims every band on both sides of each crossing's stretch of road, so nothing parks on the tracks or plants a tree under an arm. `okSlot` also refuses the corridor. The arterial lamp posts (streets.ts) and the static crowd keep off crossings and the corridor.
  - Not built: the warning bell sound, double track and passing loops, mid-line stations, and a Frogmarks control (params reported).
- [~] **R3.3 Routes:**
  - [x] Gentle curves, on the local line: one reverse (S) curve over ~3 cells (L ≈ 2.3–3 cell widths) carries the line to the next block row: z = zA + (zB − zA)·(1 − cos πt)/2.
    - Minimum radius ≥ 28 m (≈ 50 m at the default size); slope ≤ 0.52.
    - The row street it would cross diagonally is merged away where the corridor passes, so it only crosses cross streets.
    - The consist bends through it on its bogie chords, like the main line through the warp. The warp still curves the whole line gently.
  - [x] An optional second line at a different height: the at-grade local line (R3.2) beside the elevated line.
  - [-] The main line's own curve option: not built. The elevated line files (railway.ts, rail-layout.ts) belong to the arcade work.
  - [-] Tiled worlds with continuous lines across tiles: not feasible cheaply, because each tile has its own seed and so its own row choice. With `localLine` set, a neighbour tile builds its own self-contained line (buffer stops at both ends; `offsetGraphGeometry` offsets the plan). Only the centre runs a moving train.

## Budgets and verification

- **Measured 2026-09-30 (seed 3, structure side):**

  | Item | Triangles |
  |---|---|
  | Viaduct, piers, parapets, bed | ≈ 9.6k |
  | Sleepers + rails (fine) | 15.5k |
  | Catenary (fine) | 1.6k |
  | Station | ≈ 7.1k |
  | Metro (3 kiosks) | 0.4k |
  | **Total** | **≈ 34k** |

  - Build time is about 100 ms.
  - **Local line (R3.2, seeds 1/3/4):**
    - ≈ 22.8k triangles: rails 7.3k, fence 5.7k, sleepers 3.2k, crossings (boards, ramps, paint, equipment) ≈ 3.7k, stations ≈ 1.1k, catenary 0.9k.
    - The moving 2-car consist adds ≈ 2.4k (cab + pantograph 1,212, cab 1,196, mid 960).
    - Build 12–37 ms. The layout plan adds ≈ 10 ms to the layout.
  - Headless `frameStats` at the 35°/28° hero view: `trisTotal` is 2.78M with the railway on and 2.73M with it off. The difference includes the train.
- Rough triangle targets (seed-3 city):

  | Item | Triangles |
  |---|---|
  | Viaduct + parapets | +10–20k |
  | Catenary | +15–25k (fine detail) |
  | Sleepers | +20–40k (fine detail, near) |
  | 8-car EMU | 16–24k (moving, culled) |
  | Station | +20–40k |
  | Metro entrances | +2–5k |
- Each phase ends with:
  - tsc and the full vitest suite
  - headless renders: an eye-level view of the train passing, the viaduct from the street, and the station platform (Noon + Night)
  - `salsaWorld.frameStats()` numbers
  - status updates here, and UI docs for any new params (e.g. `railLivery`, `railCars`, `stations`, `metroEntrances`, `levelCrossings`)
