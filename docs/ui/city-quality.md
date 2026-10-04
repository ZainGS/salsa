# City quality — UI contract (Frogmarks City Tool)

Status: engine built 2026-09-29, browser-unverified. Roadmap and item status: [docs/specs/city-quality-upgrade.md](../specs/city-quality-upgrade.md).
Everything here is reached through `shapeManager.world` (the `WorldManager`) unless noted. Every look value **persists
with the city** (the City marker's `worldParams.lighting`) and is restored by `world.restoreFromSave()`.

> Frogmarks types Salsa from its built `dist/` — rebuild Salsa before these members type-check.

## Panel layout (Frogmarks, reorganised 2026-09-29)

The City Tool panel is a set of **collapsible sections** (open state is a per-browser convenience in
`localStorage['frogmarks.citySections']`). The action row stays on top.

| Section | Contents |
|---|---|
| (top row) | Regenerate · **Hero view** · Clear · Expand all / Collapse all |
| **Presets** (open) | one button per style pack (`world.styleNames` / `world.styles` labels) — active pack highlighted |
| **Look** (open) | Style · Toon shadows · Rim light · Palette · Sky lighting · Wet reflections · Contact shadows · Ink outlines (+ colour, sensitivity) · Street haze · Lamp colour · *Per time of day*: phase buttons, Shadow colour, Cinematic grade (Bloom, Vignette, Shadow tone, Highlight tone) |
| **Time & Weather** (open) | City lighting · Time · Cycle · Weather · Fog · Clouds (+ density) · Night mode · Day cycle / Traffic / Spin |
| **Layout** | Mode (+ tiled options) · Border · Pattern · Seed · Size · Roads · Street W · Plaza · Lots · *Terrain*: Parks, Water, Elevation, Warp, Junction variety, Terraces · Regions |
| **Streets & Buildings** | *Streets*: Sidewalks, Road paint, Street lights, Traffic lights, Power lines, Railway · *Buildings*: Detailed buildings, Facade detail, Rooftop detail, Corners, Roof, Awnings, Signage, Landmarks, Shotengai |
| **Life & Props** | Pedestrians (+ density) · Parked cars · Furniture · Bicycles · Lanterns · Holograms · *Nature*: Street trees, Leaf colour, Leaf variety |
| **Edge** | Void grid (+ extent, line width) · Border glow (+ wall height) · Nature apron |

After loading a doc or applying a pack, the host re-reads the look (`_syncCityLookFromEngine`).

## Style packs

| API | Notes |
|---|---|
| `world.applyStyle(name)` | Regenerates with the pack's params AND applies its full **look** (resets anything the pack doesn't set). |
| `world.styleNames: string[]` | Pack names for buttons. |
| `world.styles: {name,label}[]` | Names + display labels. |
| `world.applyLook(look: CityLook)` | Apply a look without regenerating. |

New packs: **`persona5`** "Phantom Night" (palette `phantom`, cel-hd, ink outlines, red/black neon night) and
**`persona4`** "Inaba Dusk" (palette `inaba`, warm dusk at t = 0.72, heavy street haze). New palettes
`phantom` / `inaba` (never picked by `auto`, so existing seeded cities keep their colours).

## Look controls

| Control | API | Default |
|---|---|---|
| Sky lighting | `world.setSkyLighting(on)` / `world.skyLighting` | off |
| Wet reflections | `world.setWetReflections(on)` / `world.wetReflections` | off |
| Contact shadows (SSAO) | `world.setSSAO(on)` / `world.ssao` | off |
| Ink outlines | `world.setCityOutlines({color:[r,g,b,a], threshold} \| null)` / `world.cityOutlines` — ★ `threshold` is the LINE WIDTH in px (1–8; values < 1 used to draw nothing) | null |
| Street haze (height fog) | `world.setHeightFog(0..1.2)` / `world.heightFog` — 0 = off; needs Fog on | 0 |
| Lamp colour | `world.setLampColor([r,g,b])` / `world.lampColor` (0..1) | warm `[1,0.85,0.55]` |
| Shadow colour per phase | `world.setShadowTints({night?,dawn?,noon?,dusk?})` / `world.shadowTints` | indigo / blue / violet |
| Grade split-tone | `world.setTimeGradeKey(phase, { shadowTint?, highlightTint? })` (rgb 0..1, luminance-normalised = hue only) | off (1,1,1) |
| Hero view | `world.heroView({fovDeg?, pitchDeg?, azimuthDeg?, zoom?})` → false with no city | 40° / 30° |

SSAO and ink outlines are city-scoped: leaving City mode hands the host its own settings back; re-entering re-applies
the city's.

## Scene-level (non-city) additions

| API | Notes |
|---|---|
| `sm.scene3d.setShadowTint3D([r,g,b] \| null)` | Coloured cast shadows (global, persisted). |
| `sm.scene3d.setHeightFog3D(density, baseY, falloff, reach)` | Ground-hugging fog (global, persisted). The city drives it; hosts can use it outside cities too. |
| post-process `bloom.wide` | 0 = original halo; > 0 adds a 5-level wide glow (city sets it by night level). |

## Agent-built items

Sections for the streets / buildings / life upgrades (new params and their panel homes) are appended below as
they land.

### Buildings (B2–B11, L6, L10 — built 2026-09-29)

Automatic in cities (no panel control needed; "Detailed buildings" on):
- Street walls with party walls (plain, flush).
- Storey-true sash windows and varied night windows (warm homes, cool offices, TV-blue).
- Lit shop interiors with roller shutters.
- Lettered kanji signs: vertical stacks, per-floor tenant signs, konbini fascia.
- Utility clutter: AC units, meters, pipes, laundry.
- Japanese roofs, and bigger lamp pools that drape on slopes.

**Building Creator / block** params worth exposing (`BuildingParams`):

| Area | Params |
|---|---|
| Shop | `windowSash`, `shopInterior`, `shutterBays`, `fascia`, `lanterns`, `menuBoard` |
| Balconies / access | `balconyStyle` (`'rail'` \| `'panel'`), `openCorridor`, `outsideStair` |
| Utilities | `acUnits`, `utilities`, `laundry` |
| Roof | `roofAerial`, `solarHeater` |
| Signs | `signStack`, `floorSigns`, `signColor2`, `signColor3` |

Other additions:
- Material `'siding'` and door style `'sliding'`.
- New archetypes: `zakkyo`, `apato`, `mansion`, `konbini`, `izakaya`, `jp-house`. `machiya` and `neon-arcade` are now used too.
- The block starter row is Japanese.

Suggested UI: in the Building Creator, add a **Japan** group with the table above, and add the new archetypes to the archetype
list.

### Streets & terrain (S1–S15, B1, E8, E14 — built 2026-09-29)

Automatic (no panel control needed):
- Exact ground: road, paint, pavement, lots and water sit on one draped lattice, so nothing floats or sinks on hills.
  Hills get real normals.
- Kerbs, gutters with grates, rounded block corners.
- Dropped kerbs with tactile paving at every zebra. Real-scale zebras, lines and arrows.
- Stairs with 18 cm risers and handrails.
- Retaining walls only where the ground steps, with coping, drains, stains and a chain-link fence.
- Proper ramps.
- Sunk canal water with a wet band.
- Pond coping.
- Blended apron with real instanced forest.
- Grid blocks are now **frontage strips** (4–12 m lots, mostly touching), so buildings form a street wall.

Params:
- `terrainSeed` (new, optional): keeps one world height field across tiles. Tiled mode sets it; hosts rarely need it.
- `streetWidth` / `arterialWidth` now scale with the city radius when omitted.
- **Lots (Radial / Angular) only affect radial layouts** now. The Frogmarks panel hides them for Grid.

### Life: people, traffic, trees, props (E1–E7, E9–E15 — built 2026-09-29)

Automatic (no panel control needed):
- **People:** 13 faceless mannequin archetypes (salaryman, office, sailor + gakuran uniforms, yukata,
  elders…) with real clothes cuts, hair styles, shoes and bags. Since 2026-09-30 they are modelled at HIGH detail
  (≈2.5k tris: smooth heads with ears, a shaped torso with chest / waist / hips and squared shoulders, hands with
  fingers + thumb, cuffs and hems with thickness, lapels on jackets, hair with a part line and piecey bangs, flat-soled
  shoes) for anyone within ~30 m of the camera, and at a cheaper FAR detail (≈0.85k) beyond that. Walkers always use
  HIGH, and their hips sway ~1 cm per step. Walkers bend their knees (heel strike, toe-off, a
  natural bob) and swing their arms. ~70% carry umbrellas in rain, which are closed under shelters. Crowds follow a
  footfall field, form groups, talk, sit, queue and browse, rest on one leg, lean on shop walls and on bridge rails.
- **Walkers:** pick routes at junctions and wait for the green at zebras.
- **Traffic:** now drives on the LEFT (it silently drove on the right before). Signals switch; cars route
  straight/left/right, stop at the line, swerve around parked cars, and show headlight pools at night.
- **Pavement bands** keep trees, poles, furniture and parked cars out of the walking band and out of buildings.
- **Trees:** paired rows of Japanese species with grates and guards; autumn colours when `leafColor` is warm.
- **Props:**
  - JP post boxes, cabinets, benches, mamachari on racks, bollards.
  - Vending machines in runs with a bin.
  - Catenary power / telecom wires with service drops.

| Control | API | Panel |
|---|---|---|
| Signal timing | `world.setSignalTiming({green?, yellow?, allRed?})` / `world.signalTiming` (seconds; persisted) | Life & Props → Signal green |
| Crowd density | `pedestrianDensity` param (existing; static crowd capped at 4000, walkers up to ×4) | Life & Props → Pedestrians → Density |
| Pedestrian style | `pedestrianStyle` param: `'flat'` (default, the soft Persona-NPC colour blocks) · `'default'` (normal lit PBR) · `'cel'` · `'cel-hd'` · `'ink'`. Live, no rebuild: `world.setPedestrianStyle(s)` / `world.pedestrianStyle`, or `updateCity({ pedestrianStyle })`; console `salsaWorld.pedestrianStyle('cel')`. Only the crowd changes (static people, walkers, the live near-field rigs); the ground and buildings keep the city's style. `'flat'` follows the city's render style. Persisted with the city params. | Life & Props → Pedestrians → **Style** (select — Frogmarks wiring pending) |
| Behaviour toggles | `traffic`, `trafficLights`, `weather` (umbrellas), `nightMode` (thinner crowd), `leafColor` (autumn) | existing controls |

Not exposed yet: car / walker caps (`MAX_CARS = 64`, `MAX_WALKERS = 240` in traffic.ts).

### Fixed 2026-09-29 — red roads / pavements / kerbs

- **Cause:** procedural-ground meshes store their weathering data in the `specularColor` instance slot. The default "worn" profile packs `(1, 0, 0)`. The **Cel**, **Cel HD** and **toon-shadow** paths read that slot as the specular colour, so every road, pavement and kerb got a red highlight.
- **Where it showed:** any pack or Environment/City style using those looks (Phantom Night, Inaba Dusk, Toon Town, or Style = Cel).
- **Fix:** ground meshes get zero specular in the stylised paths (`styleSpec` in mesh3d-shaders.ts). The default PBR path is unchanged.
- **Also:** lamp light-pools are now hidden by day (night > 0.12). In daylight they read as dark discs at every junction.

### Fixed 2026-09-29 — Ink outlines drew nothing; panel tidy-up

- **Ink outlines:** the edge-outline "threshold" is really the line width in whole pixels. The panel sent 0.18 and Phantom Night sent 0.12; both truncated to 0 px, so nothing drew. The renderer now clamps the width to 1–8 px (`outlineWidthPx`), and Phantom Night uses 1. The panel's *Sensitivity* slider is now **Line width** (1–4 px).
- **Style-only options:** *Toon shadows* only affects Cel and Cel HD. It is now shown only when one of those styles is selected, in the City, Environment, Block and Character panels. *Rim light* works in every style, so it always shows.
- **SSAO:** the city's *Contact shadows* toggle is renamed **SSAO**, with a tooltip noting it's GPU-heavy. Style packs may turn it on (Phantom Night, Inaba Dusk), so switch it off after applying a pack if frame rate dips.

### Round 2 fixes (2026-09-29) — automatic, no panel changes

- **Trees:** broadleaf crowns grow small alpha-cut leaf cards in sprays along the twigs (0.10–0.17 m, 4–6× as many). They no longer float as ~0.5 m blades. About +14% tree triangles.
- **Bridges:** each deck end matches the approach road and the kerb-raised footways, and the deck ramps between banks at different terrace levels. Sunk junctions get no zebra.
- **People:** nobody stands in canal water or under a deck. People on a bridge stand at deck height, and walkers cross on the deck.
- **Canal-side buildings:** new lot edge kinds `'water'` and `'drop'` get a 2 m walkway setback. Doors prefer a real street.
- **Tactile paving:** real 30 cm tiles with 5×5 dots of 2.5 cm, aligned to the kerb. The dot relief no longer ghosts.
- **Known leftover:** a bollard can stand on the tactile tiles at some crossings (street-furniture placement).

### Scene presets + clean PBR look (polish-round-3 T1 — built 2026-09-29)

The City **Presets** section should now show **scene presets**: time of day × weather on one clean PBR look (the
P5X street shot). They never regenerate the layout and never change the render style (always PBR). The old style
packs still work through `world.applyStyle(name)`, so they can move to a secondary "Style packs" row or dropdown.

| API | Notes |
|---|---|
| `world.scenePresets: {name,label,timeOfDay,weather}[]` | One button per preset, in panel order. |
| `world.scenePresetNames: string[]` | `morning`, `noon`, `golden`, `dusk`, `night`, `rainyEvening`, `snowyMorning`, `overcast`. |
| `world.applyScenePreset(name) → boolean` | Sets time + weather + cloud cover + the full look. False for an unknown name. |
| `world.scenePreset: string \| null` | The active preset (highlight it). Any hand edit to a clean-look control resets it to null. Persisted. |
| `world.streetView({fovDeg?, eyeHeightM?, pitchDeg?, pick?, side?}) → boolean` | Eye-level (1.6 m) perspective, 50° FOV, on a pavement looking along a street. It picks a street the sun lights. `pick` cycles to the next street. Suggested: a **Street view** button beside **Hero view**, and a second click to cycle `pick`. |

New **Look** controls. Each is persisted and applied live (no rebuild):

| Control | API | Clean default |
|---|---|---|
| Ground finish | `world.setGroundFinish('clean' \| 'weathered')` / `world.groundFinish` — clean = crack-free warm-grey asphalt with broad variation, repair patches and faint tyre-wear lanes; matte off-white road paint with worn edges (never emissive); no grime, quiet slabs | clean |
| Paving | `world.setPaving('tiles' \| 'slabs')` / `world.paving` — tiles = warm 50 cm tiles, per-tile value steps, 3 mm soft joints | tiles |
| Mute buildings | `world.setBuildingMute(0..1)` / `world.buildingMute` — walls, trim and roofs go toward warm grey; signs keep their colour | 0.35 |
| Painted clouds | `world.setPaintedClouds(on)` / `world.paintedClouds` — horizon cloud banks, and sky-tinted drifting clouds | on |
| Shadow softness | `world.setCityShadowSoftness(0.5..4)` / `world.cityShadowSoftness` | 1.9 (legacy 1.3) |
| Golden warmth | `world.setSunWarmth(0..1)` / `world.sunWarmth` — near sunrise and sunset the sun goes deeper gold and the dusk sky lasts longer | 0.8 (Golden Hour: 1) |

- **Street surfaces (persona-polish B1–B3, 2026-09-30):** no new controls; the Ground finish and Paving rows above
  got the new look. Only the clean finish and tiles paving change: a weathered / slabs city renders exactly as before.
  A saved city on the clean look (any scene preset) reloads with the new asphalt, paint and tiles. Two new ground
  surfaces, `roadPaint` (mode 20) and `paverTiles` (mode 21), are also in the library for `applyGroundMaterial3D`.
- **Facades (persona-polish B4 / D2 / D3, 2026-09-30):** no new controls.
  - Detailed buildings now pick a facade material per lot: tile, concrete, painted render, metal panel or brick,
    weighted by district. Each gets a muted wall swatch, so the signs carry the colour. Floor-band ledges and
    cornices appear on part of the flat-roofed stock.
  - Joints are finer, and sub-pixel grain fades out at mid distance.
  - Windows sit in a shaded reveal with a sill (`world:detail-trim-sill`, DETAIL tier). The glass reflects the sky.
  - AC units and pipes dress the first storeys of street faces.
  - Saved cities rebuild with the new facades (the look comes from the params). Building Creator params: new material
    `'panel'` and `windowSills` (see [building-creator.md](building-creator.md)).
- **Frontage dressing (persona-polish D1, 2026-09-30):** new layout param `frontageDressing` (boolean, absent = on).
  Suggested: a **Frontage dressing** checkbox in the Streets / props group, next to Street furniture (it also turns
  off with Street furniture). It is a selective rebuild of the furniture group only.
  - Nobori flag runs (1-3 tall shop banners on a pole in a weighted base, swaying in the scene wind) beside shop
    doors and down both sides of the shotengai. Noren curtains over the doors of small shops that do not hang their
    own. Pots flanking doorways, residential doorstep gardens, bikes parked against the wall, and extra crate stacks
    and menu boards along commercial frontage.
  - Density follows the zone: commercial dense, civic a little, residential light. Everything is placed by the
    shared pavement plan, so walkers, trees, poles and vending runs never collide with it.
  - Layer names: `world:frontage-nobori-*` (PROPS distance tier), `world:noren-door-*` (DETAIL tier). Bikes merge
    into the existing `world:bicycle-*` layers.
  - Saved cities rebuild with the dressing (it comes from the params). Set `frontageDressing: false` for the old
    frontage. Pots, crates and menu boards come from the shared plan, so they stay when only the dressing is off.
- **Painted sky (persona-polish E1, 2026-09-30):** no new control; the **Painted clouds** look row above got the new sky.
  - Horizon banks are large soft painted cloud cards: a sky-tinted shade with a sunlit crown. Golden hour gives
    gold / apricot crowns over lilac undersides; noon gives white crowns over blue-grey.
  - With painted clouds on in clear weather, the hundreds of small drifting puffs are replaced by a few big, high,
    slow painted clouds, placed where an eye-level view sees sky. The count follows `cloudDensity`.
  - The painted clouds never count toward auto-framing, so Hero view frames the city itself.
  - Rain, snow and overcast keep their cloud decks. With painted clouds off, the legacy puffs return.
  - Mechanism: the look keeps a new layout param `paintedClouds` in step. Hosts only call `setPaintedClouds` or a
    scene preset, as before.
- **Stairs (persona-polish B6, 2026-09-30):** no new control. Street stairs get their own surface: one granite slab
  per step (the tone changes step to step, and no joint crosses a tread), a dark or yellow anti-slip nosing strip with
  fine grooves on every tread, a flat top landing, and a plain side wall in the retaining wall's material with a
  coping. New layers: `world:stair-nosing`, `world:stair-wall` (PROPS distance tier, with the stairs).
- **Edge wear (persona-polish E2, 2026-09-30):** new layout param `edgeWear: 'off' | 'subtle' | 'heavy'` (absent =
  off, so saved cities are unchanged). Suggested: an **Edge wear** dropdown (Off / Subtle / Heavy) in the Look group.
  - Call `world.setEdgeWear(level)` (or `updateCity({ edgeWear })`); read it back with `world.edgeWear`. A look may
    also carry `edgeWear`; unlike the other look fields it is applied only when present, so a scene preset never
    resets it. It is a selective rebuild of the layout (kerbs) and terraces (stairs, copings) groups.
  - Stair nosings, kerb top edges and the retaining-wall / stair copings get small deterministic chips, notches and
    occasional bites, plus a lighter worn band along the arris.
  - Chips are drawn only for chunks within ~18 m of the camera. Farther chunks draw the clean geometry. With distance
    LOD off, or under an ortho camera, everything is clean.
  - Cost (seed 3, radius 10): about +150k (subtle) / +300k (heavy) triangles held in memory, of which only the near
    chunks are drawn (a few thousand triangles at street level).
  - Console: `salsaWorld.edgeWear('heavy')`.
- **Character outlines (persona-polish E3, 2026-09-30):** `sm.setCharacterOutlines3D(style | null)` /
  `sm.getCharacterOutlines3D()`. It outlines every procedural character (body, clothes and hair as one silhouette) and
  every character created later. The city is never outlined. `{}` gives a thin near-black ink line; `null` (the
  default) is off. It is saved with the scene settings, and each body also keeps its own outline. Suggested: a
  **Character outlines** checkbox in the Look group. See [object-outlines.md](object-outlines.md).
- **Pedestrians (persona-polish E4, 2026-09-30):** no new control. Static crowd heads are 8-sided (they were 7) and
  symmetric, and they now match the hair shell. This stays inside the crowd triangle budget.
- **Weather:** new value `'overcast'` — a pale grey cloud deck, flat dim light, no rain or snow. Add it to the Weather dropdown.
- **Defaults:** a fresh session's new cities start on the clean look. A saved city restores its own look, and an older
  save without these fields reloads weathered, exactly as it was.
- **Console:** `salsaWorld.scene('golden')`, `salsaWorld.scenes()`, `salsaWorld.street({ pick: 1 })`.

### Camera + streaming (polish-round-3 T7 — built 2026-09-30)

**Frogmarks wiring — one button.** Put a **Return to scene** button (a frame/target icon) where the 2D autofit
button sits by the zoom controls. Show it in free 3D and in City mode.

| API | Notes |
|---|---|
| `sm.frameScene3D(padding = 1.1) → boolean` | Frames all visible content from the current view direction. A below-horizon or street-level view is lifted to a 3/4 angle. Sky stars and moon, void grid, apron and border glow are ignored. In City mode it frames the city, without the traffic, clouds or planes. False when there's nothing to frame. |
| `sm.resetView3D(padding?)` | Alias. |
| `world.frameCity(padding?) → boolean` | The City-mode path, callable directly. |

Everything else is automatic:

- **Zoom (free 3D and City):** the wheel zoom no longer slows down near the orbit pivot. Close in, each step moves
  a constant distance and pushes the pivot forward, so you can fly through the scene. The range is effectively
  unbounded (radius 1e-4 to 1e5). City mode no longer stops at radius 50. A diorama city's haze now scales with
  the pull-back once you are well past the normal framing. Tiled worlds cap the zoom-out at 1.5 × the streaming
  render distance. The Edit-Mesh, packaging and armature orbits and the 2D illustration zoom are unchanged.
- **Street-level culling:** tiles and the centre city are culled as 3D boxes against the view frustum and ranked
  by distance from the camera. Looking up at buildings from the pavement no longer hides the tile you stand in.
  Detail tiers use the camera's distance to the city, so props around the lens stay while you orbit a far pivot.
- **Lag fixes (measured, seed-3 City, headless):**

  | Symptom | Cause | Fix | Before → after |
  |---|---|---|---|
  | Periodic hitch every few seconds | Signal lamp re-dress set `gpuDirty`, so every phase change did a full geometry-pool rebuild (about 190 ms of re-upload) | Material-only write (`materialDirty`) | max frame 229 ms → 16–25 ms, no long tasks |
  | Steady per-frame CPU | The traffic tick was about 44% of main-thread time: up to 3 matrix rebuilds plus an OBB refresh per mover mesh per frame, about 1.5k meshes | One rebuild per mesh (`Node.setPoseXYZYaw`). Lazy bounds for `cheapBounds` movers. A pose gate skips LOD-hidden and off-screen movers (re-posed every 8th frame so they are current when they return) and throttles far walkers, cars and clouds to every 2nd or 3rd frame. The simulation still runs every frame. | tick 2.3 ms → 0.9 ms (hero view), 2.1 → 0.6 ms (street) |
  | Stall on traffic, weather or railway toggles and on regen | Each of about 430 mover groups was a non-silent add, so a full-scene walk per group | Silent adds plus one notification | spawn 59–73 ms → 13–19 ms |
  | GPU load from the rebuilt street props | `world:signal-*` (about 120k tris), `world:lamp-banner`, `world:detail-door*` (about 40k) and `world:detail-sign-text` (about 80k) had no LOD tier | Signals and banners go in PROPS (with the poles they hang on). Doors go in DETAIL. Sign lettering goes in STRUCTURE (extreme zoom-out only). The lit lamp glass (`world:lamplights`) and the lamp pools stay drawn. | drawn only when near enough to read |
- **Console:** `salsaWorld.manager['_traffic'].poseGate = false` switches the mover pose gate off for an A/B test.
- **Browser check still needed:** real GPU frame time at the hero and street views, with wheel feel on a trackpad
  and on a mouse. Each wheel event is still one step, so a trackpad zooms fast.

### Culling stats (Round 5 — 2026-09-30)

The city's big merged layers are now split into spatial cells, so anything off-screen is not drawn. This applies in
the editor and in Play mode, and it changes nothing you can see. To check it, paste `salsaWorld.frameStats()` in the
console:
- **`trisVisible` vs `trisTotal`.** This is the share of the city's triangles that survived the camera cull. At
  street level about 55–70 % is normal. Before chunking it was about 88 % everywhere. At a frame-all overview it is
  about 100 %, which is expected.
- **`meshesCulled`, `groupsCulled`, `instancesCulled`.** These are what the camera rejected this frame. Instanced
  trees and props are culled per cell.
- **`drawCalls`.** This counts every pass. Chunking adds about 20–30 % at street level and about 40 % at a frame-all
  overview.
- **`shadowCasters` / `shadowCulled` / `shadowOffView` / `shadowTris`.** The shadow map draws only casters inside the
  sun's shadow box whose shadow can reach the view. That includes buildings just off-screen that shade the street.
  `shadowTris` is 0 on frames where the throttled map isn't refreshed.
- **`msCull`.** This is the CPU cost of the tests, about 0.3–0.7 ms.
- **A/B tests:**
  - `salsaWorld.cullChunks(false)` rebuilds the city unchunked.
  - `sm.renderer3D.shadowLightCulling = false` puts back the old shadow list, which was culled against the camera.

### Skinned culling + distance LOD (R6.1 — 2026-09-30)

**Skinned characters are now culled** like everything else. A character that is off screen isn't drawn, and its
skin matrices aren't uploaded. It still casts a shadow if that shadow can land in view. If it is also outside a
margin around the view, its idle animation pauses; the idle picks up at the right phase when the character comes
back. With 300 idling characters, looking away went from about 12 ms to 1 ms of CPU. From inside the crowd it went
from 13 ms to 4 ms. The pixels are identical. New stats in `salsaWorld.frameStats()`:
- `skinnedMeshes`, `skinnedDrawn`, `skinnedCulled`
- `skinnedShadow` (casters)
- `skinUploads`, `skelAnimCulled` (idle paused)
- `skinnedTris`, `msSkinned`

For A/B tests: `sm.renderer3D.skinnedCulling = false` / `skinnedAnimCulling = false`.

**Distance LOD, per chunk and camera-aware.** The fine layers are the same ones the zoom tiers use: DETAIL, ROOF,
PROPS and FLATMAP, plus the sign lettering. They now also stop drawing once the camera is far from that chunk's own
box, in every mode (editor free3D, City orbit, Play):
- **Distances:** fine detail at 0.6 × 2.8 R, roof objects 1.25 × that, props at 1.2 × 2.8 R, flat-map layers at
  1.4 × 2.8 R.
- **Adjustments:** the distances are scaled by the lens (a 75° Play camera drops detail sooner) and grow by the
  camera's height above the city, so the aerial overview keeps its look.
- **Hysteresis:** 10 %, so a chunk on the threshold doesn't flicker.
- **Never hidden by distance:** structure, roads, building bodies and the lit layers.
- **Per family (P7, 2026-10-01):** sub-metre clutter — the crowd, walkers, wires, doors, railings, ducts, rail
  sleepers, signal housings, pole insulators, car trim, tactile paving, benches, bikes, bollards, planters — no longer
  takes the height adjustment, and the small street furniture drops at the fine-detail distance instead of the tree
  distance; vending-machine cans drop at about a third of it. Street level looks the same; from the sky only the
  nearby clutter is drawn (tiled 3×3 sky view: 15.8 M → 9.5 M triangles). Heavy instanced props (trees, vending
  cans) are now chunked finely enough to be culled. Full table: `docs/ui/performance.md` §How LOD works.

What to expect:
- **Default diorama city:** nothing changes, because it is small enough that every chunk is close.
- **Tiled worlds:** this is where it pays. In a 5×5 world, street level draws 15–19 % fewer triangles with
  pixel-identical screenshots, and a far free3D fly-out draws half the triangles.
- **Stats:** `lodHidden` and `lodTrisHidden`.
- **Tuning:** `salsaWorld.distanceLod(true, mul)` scales every distance. `salsaWorld.distanceLod(false)` turns it off
  (or set `sm.renderer3D.distanceLod = false`).

**The old zoom tiers are still there.** They are global: one switch per tier, keyed off the zoom. They are what
thins the city when you pull back to an overview or zoom out in ortho. At street level and in Play their metric is
about 0, so they show everything. The per-chunk distance LOD covers that case now.

### Light, shadows, anti-aliasing, haze (persona-polish Pass A — built 2026-09-30)

Suggested Frogmarks controls (Look group unless noted). All persist; all apply live (no rebuild).

| Control | API | Default |
|---|---|---|
| **AA** (Off / FXAA, quality Low / Medium / High) — suggested in a Render or View settings group, global to the doc | `sm.scene3d.setAntiAliasing3D({ mode: 'fxaa' \| 'off', quality: 'low' \| 'medium' \| 'high' })` / `sm.scene3d.antiAliasing3D` | FXAA medium (on) |
| **Shadow quality** (Standard = 1, High = 2, Ultra = 3 cascades) + **Near shadow distance** (m) | `world.setShadowCascades({ cascades?: 1\|2\|3, nearMetres?: 8..120 })` / `world.shadowCascades` | 2 cascades, 24 m |
| **Contact shadows** (checkbox + strength) — soft blobs under people, parked cars and props | `world.setGroundContact(on, strength?: 0..1)` / `world.groundContact` → `{on, strength}` | on, 0.55 |
| **Key/fill contrast** slider | `world.setKeyFill(0..1)` / `world.keyFill` | clean look 1 (older saves 0) |
| **Aerial haze** slider (needs Fog) | `world.setAerialHaze(0..1)` / `world.aerialHaze` | clean look 1 (older saves 0) |

- "Contact shadows (SSAO)" in the table above is the screen-space AO (`world.setSSAO`); name the new checkbox
  **Ground contact** or relabel SSAO as **Ambient occlusion** to avoid two "Contact shadows" rows.
- MSAA is not offered: the 3D draws into the shared 2D + 3D pass (see docs/specs/persona-polish-plan.md A1).
- Scene-level (non-city) equivalents: `sm.scene3d.setShadowCascades3D({ cascades, nearExtent (world units, 0 = auto),
  mapSize, blend, updateInterval })`, `sm.scene3d.setAerialHaze3D(strength, reach, contrast, tint)`, post-process
  `bloom.chromaGate` (0..1). Outside a city the cascades default to 1 (the original single map).
- Automatic: city bloom is chroma-gated (white paint and pale paving never bloom by day); shadows are crisp near the
  camera in the editor free 3D view, city orbit and Play (first and third person); an animated player refreshes only
  the near cascades.
- Scene presets were retuned (warmer key, less blue shade, aerial haze). A saved city keeps its own saved look; the
  new look fields are absent in older saves, so they reload unchanged. Shadow quality and ground contact default ON
  for every city, including older saves.
- Measured (seed-3 city, 1300x850, headless, interleaved A/B, GPU shared with other runs so absolute numbers are
  noisy): FXAA about +0.3-0.5 ms; 2 cascades about +1-1.5 ms at street level; frameStats gains `cascades`,
  `cascadeCasters` (about 800-850 at street level), `cascadeDrawCalls`, `cascadePasses`.
- Console: `salsaWorld.frameStats()`, `sm.scene3d.setShadowCascades3D({ cascades: 1 })` for an A/B.

### Railway structure, stations, metro entrances (railway-upgrade R1.1–R1.4, R2.1, R2.3 — built 2026-09-30)

The elevated railway is now built at real scale. Spec and status: [docs/specs/railway-upgrade.md](../specs/railway-upgrade.md).

- A double-track concrete viaduct runs over a grid street: deck ~7.5 m up, 10 m wide, 1.2 m deep. Portal piers stand on the two pavements, and parapets carry noise-barrier runs.
- On the deck: ballasted track with I-profile rails at 1.067 m gauge on concrete sleepers, and an overhead catenary on portal masts.
- One elevated station with side platforms. A covered stair and a ticket-gate hall lead down a cross-street pavement.
- A few metro-entrance kiosks stand on busy junction pavements.

Suggested Frogmarks controls: add these to **Streets & Buildings → Streets**, next to **Railway**.

| Control | Param (`world.update({...})`) | Default | Notes |
|---|---|---|---|
| **Stations** (checkbox, disabled when Railway is off) | `stations` | on | Full regen. The street plan reserves the stair / hall footprints. |
| **Metro entrances** (checkbox) | `metroEntrances` | on | Full regen. Kiosks don't depend on the Railway toggle. |
| (train agent) **Cars**, **Livery**, dwell | `railCars`, `railLivery`, `railDwellScale` | 8, auto, 1 | See the R1.5 / R2.2 notes in the spec. The platform length follows `railCars`. |

- `railway`, `stations` and `metroEntrances` are now **full-regen** params, not the old instant selective rebuild. The shared street plan keeps trees and poles out from under the deck and keeps everything off piers, stairs and kiosks, and it is memoised per graph.
- The edge-wear look (`edgeWear`) also chips the pier cap beams and parapet copings, near the camera only.
- Everything persists with the city params. Older saves have no `stations` / `metroEntrances` fields, so they default on and rebuild at the new scale.
- Console:
  - `salsaWorld.frameStats()`
  - layer names `world:rail-*` (structure), `world:rail-fine-*` (sleepers, rails, catenary: fine-detail tier), `world:rail-stn-*`, `world:metro-*`

### Railway arcade: life under the viaduct (railway-upgrade R3.1 — built 2026-09-30)

A second viaduct style, the Tokyo look (Yurakucho, Koenji, Akihabara). The line runs **beside** its road over the lot strip, carried on a continuous brick-arch (or concrete rectangular) arcade. The bays underneath hold izakaya, eateries, shops, bike parking, roller-shuttered storage, fenced service bays and the station entrance.

| Control | Param (`world.update({...})`) | Default | Notes |
|---|---|---|---|
| **Viaduct** (select: *Over the road* / *Arcade beside the road*, disabled when Railway is off) | `railViaduct` | `'portal'` | Full regen: the arcade claims the lot strip beside the rail road. Grid cities only; radial cities keep the portal / T-pier viaduct. |

- The default stays `'portal'`, so saved cities are unchanged. There is no seeded variation of the default.
- The side of the road is seeded. Brick arches or concrete bays are seeded per city (about 55 % brick).
- The bay fill is seeded per bay and weighted by district:
  - downtown and market: mostly izakaya, eateries and shops
  - residential: more bike parking, storage and service bays
  - bays near the station lean to bike parking
  - a bay whose face looks onto a canal is storage, service or bike space
- The street face gets the life; the back face is plain, with steel service doors.
- The shops count as buildings for the rest of the city:
  - the street plan puts an entrance slot at each bay door, so nobori, A-boards and pots land at the doors and nothing is placed inside the arcade
  - shop, eatery and izakaya bays get a door that the door-visit sim uses
  - their lots feed the footfall field like other commercial lots
- Console: layer names `world:rail-arc-*` (structure; `world:rail-arc-prop*` = props tier), `world:rail-arc-girder`.

Also new this round:

- **Deck clearance** now counts the terrace levels as well as the smooth terrain, in both viaduct styles. A line over a raised terrace gets a higher deck (seed 7 arcade: 11.7 m).
- **Metro kiosks** have a lit white "M" on both faces of the sign box (`world:metro-sign-letter`).

### At-grade local line + level crossings (railway-upgrade R3.2 / R3.3 — built 2026-09-30)

An optional second railway at street level, in the Tokyu Setagaya / Enoden style:

- a single track on its own fenced ballast corridor through the blocks, with one gentle reverse curve to the next block row when there is room
- a **level crossing (fumikiri)** at every cross street: striped barrier arms, a crossbuck mast with alternating red lamps, boards, stop lines
- a small station at each end, and a short 2–4 car train running between them

Spec and status: [docs/specs/railway-upgrade.md](../specs/railway-upgrade.md) (R3.2, R3.3).

Suggested Frogmarks controls: add these to **Streets & Buildings → Streets**, under **Railway**.

| Control | Param (`world.update({...})`) | Default | Notes |
|---|---|---|---|
| **Local line** (checkbox) | `localLine` | off | Full regen: it merges a few roads and carves the lots it runs through. Grid cities only. Independent of the Railway toggle; with the railway on, it ends beside the viaduct (an interchange). |
| **Local cars** (slider 2–4, disabled when Local line is off) | `localLineCars` | 2 | Full regen: the platforms are sized for the train (cars × 16 m + 3 m). |

- Off by default, so saved cities are unchanged. It is deterministic per seed. Most grid seeds get a line; a few have no row that fits.
- What happens when the traffic sim runs:
  - The lamps start flashing about 11 s before the train reaches a road. The arms come down 2.5 s later.
  - Cars stop at the stop line and walkers wait at the barrier. A car never drives onto a crossing it can't clear.
  - Walkers also head into the station entrances: the elevated line's stairs, the metro kiosks and the local stations. The crowd gathers round them.
- When traffic is off, the train is parked at the first station with the arms up.
- At night the lamps and the station name boards glow. The train windows are lit.
- Station-entrance destinations apply to every city, with the local line or without.
- Console: layer names `world:local-*`:
  - `world:local-fine-*`: sleepers, rails, fence, catenary (fine-detail tier)
  - `world:local-xing-*`: crossing equipment (props tier)
  - `world:local-xing-lamp-<n><a|b>`: the phase-switched lamps
  - `world:local-train*`: the parked train
  - the moving consist is `world:traffic-train-local*`
- Live state: `salsaWorld.manager._traffic.xing.states` (per crossing: `arm` 0 up … 1 down, `lamps`).

## Hard fog edge (2026-10-01)

A linear fog with Near and Far close together used to give a sharp cutoff. In a city it fades instead, because
two later effects use the fog colour and start at zero distance: **aerial haze** (persona-polish A5) and
**height fog** (city-quality P9). The city also rescales the fog when the camera pulls back, and replaces it on
every time-of-day or preset change.

`sm.setFogHardEdge3D(true)` (Frogmarks: Global settings → Fog → **Hard edge**) restores the sharp cutoff:

- Only the plain linear / exponential fog draws. Aerial haze, height fog and the aerial desaturation are
  uploaded as off, but their stored values are kept, so turning it off brings them back.
- The city stops rescaling or replacing the fog. A save in City mode and leaving City mode keep your fog rather
  than the pre-city snapshot.
- Turning it off in City mode hands the fog back to the city (its time-of-day fog is re-applied).
- Saved in the document's global settings as `fogHardEdge: true`, only when on, so older saves are unchanged.
  `sm.getFogHardEdge3D()` reads it.
- The sky is not fogged: beyond Far you see the sky backdrop, not a solid fog wall.

Code: `Renderer3D.fogHardEdge` (renderer-3d.ts, scene-uniform pack), `WorldManager._fogLocked` /
`onFogHardEdgeChanged` (world-manager.ts), persistence in scene3d-manager.ts. Test: world-fog-hard-edge.test.ts.

## Fog horizon (2026-10-01)

With **Hard edge** on and a **linear** fog, everything past Far is one flat colour, so distant buildings read as a
stylised silhouette skyline against the sky. These settings build on that (Frogmarks: Global settings → Fog, under
Hard edge, shown only while it is on). All are off / today's look by default, and they do nothing while Hard edge is
off or the fog is exponential.

| Setting | Default | What it does |
|---|---|---|
| **Buildings only in fog** | off | Past Far, only building silhouettes draw. Trees, parked and moving cars, people, poles, lamps, road signs, benches and the rest stop at the fog line (they were flat fog colour there anyway). A big saving at a short Far: at 150 m in a 3×3 tiled city, about two thirds of the triangles and half the draw calls, 0.5–1 ms GPU at street level, 2–3 ms from a rooftop. |
| **Include signs, awnings & rooftop equipment** | off | Keep the building attachments in the silhouettes: shop signs and lightboxes, screens, awnings, facade trim and balconies, rooftop units and clutter. |
| **Fade distance** | 15 m | The band before Far over which the culled objects dissolve with a screen-door dot pattern, in and out, as you move. 0 = they pop at the fog line. Their shadows and ink outlines fade with them. |
| **Fade style** | Dither | Dither = a fine per-pixel 4×4 pattern; Dither (coarse) = the same pattern in 2×2-pixel cells, more stylised. |
| **Silhouette outlines** | on | Off = the ink outlines (Edge outlines) stop at the fog line, so the silhouettes stay clean. |

What always stays in the fog: building bodies and roofs, landmarks, the ground, roads and paving, water, the rail viaduct
and bridges.

Notes for QA:
- The fog is now measured from a **fog eye**. In free 3D, City, Play and 2D perspective that is the camera (no change).
  In **2D ortho** it is where the 2D perspective camera sits for the same framing, so 2D ortho and 2D perspective show
  the same fog line (before, 2D ortho measured from a point far behind the view and fogged too much).
- With the fade on, objects inside the band show a dot pattern; with FXAA it reads as a dissolve. Use the coarse style
  for a deliberate retro look.
- **Clouds and sky (2026-10-01):** the sky, stars, moon and drifting clouds now skip the fog while Hard edge is on, so
  past Far they stay clouds instead of fog-coloured blobs. With Hard edge off they look exactly as before (they keep
  blending into the soft haze).
- **Characters (2026-10-01):** generated characters and NPCs obey Buildings only in fog like the props: past Far they
  are not drawn, and in the fade band they dissolve, shadow included. The Play player and the selected character are
  never culled or faded.
- **Crowd (2026-10-01):** the static crowd and the walkers were already distance-limited and fog-culled. Two paths were
  drawn at any distance and are fixed: the live near-field people (the ones promoted to animated meshes near the
  camera, ~30-38 m) and the walkers' chat bubbles. The live people also used to count as "building" for the fog, so
  they never dropped out at the fog line.
- **AO (2026-10-01):** the ambient-occlusion darkening of a dissolving object fades with it (it used to stay at full
  shape inside the band).
- **No fog per object (2026-10-01):** any object can ignore the fog: Frogmarks material panel → **No fog** (Off /
  Always / Hard edge only), `sm.setMeshNoFog3D(meshId, false | true | 'hardEdge')`. Saved with the object.
- A planar mirror in view turns the culling off for that frame (the mirror shows what the fog hides from the eye).
- Saved with the document's global settings (`fogHorizon`, only the changed fields), so older documents load the same.

API: `sm.setFogHorizon3D({ buildingsOnly, includeAttachments, fadeM, fadeStyle, silhouetteOutlines })` (merge;
`{ reset: true }` = defaults) and `sm.getFogHorizon3D()`. Console A/B: `sm.renderer3D.constructor.fogHorizonFastPath`
(the pixel-identical early-out for fogged pixels) and `.fogHorizonCpuCull`; `getFrameStats3D().fogHidden /
fogTrisHidden` (`skinnedFogHidden` for characters); the follow-ups' A/B switches are `.hcFogReject`,
`.skinnedFogHorizon` and `.geomPoolFastSkip`. Engine details: docs/specs/fog-horizon.md §0.

## Visual polish quick wins (2026-10-03)

Spec: [../specs/visual-polish-next.md](../specs/visual-polish-next.md) (items 1a, 3a, 4, 6a, 7a, 8, 14). Before / after
shots: the session scratchpad `pupdrive/polish2/before/` and `pupdrive/polish2/after/` (driver `polish2/cap.js`).

| What | Where you see it | Saved documents |
|---|---|---|
| **No cyber grid / border wall** on the Tokyo looks (`voidGrid` / `borderGlow` default off; every scene preset and Phantom Night switch them off; the Neon Cyber pack keeps them) | hero / roof views | A saved city keeps its own value. Only a city saved before the two fields existed changes. |
| **Shop windows**: four muted per-shop palettes, small products, warm light from the ceiling, and a soft self-lit room by day (it read as a grey void under awnings) | every street shot | Shader change: all cities. |
| **Golden Hour**: warm sun with cool blue-violet shade (`coolFill`), a gold highlight split, a slightly warm frame tint, less building mute (0.22) | Golden preset | Preset data: only when the preset is applied again. |
| **Ad screens**: the big LED screens show designed ad loops (three layouts, a 6 s cut, a far fade to their average colour) instead of the moiré static | street + overview, also at night | `LayoutParams.adScreens` (default **true** for new cities). A city saved before it existed restores with `adScreens: false` and keeps the old screens. To upgrade an old city: `world.updateCity({ adScreens: true })` (a rebuild). |
| **Play camera**: FOV 50 (was 72), follow distance 1.8 × avatar height / 3 m (was 2.6 × H / 4.5 m), a chest pivot, a 0.35 m right-shoulder offset (wall-aware) | third-person Play | A document that set a follow distance or FOV keeps it. A document that never set them gets the new framing (see play-settings.ts). |
| **Graphic look** (`'graphic'` preset = Golden Hour + cel-hd, toon shadows, rim, ink outlines 2 px near → 1 px and faint by 180 m) and `world.setGraphicLook(on)` over any preset | City → Presets: **Graphic** button + **Graphic look** checkbox | Persisted through the look fields (render style + outline depth fade). |
| **Phantom Night (P5)** retune: red / black / white, a near-black night sky, neutral shadows, bloom only on real lights, no cloud deck, lit windows capped (`windowGlow: 0.7`) | Show style packs → Phantom Night | Pack data: only when the pack is applied again. |
| **Sign lettering contrast**: cream text only on dark or saturated boxes (luminance ≤ 0.5); mid-light boxes (teal, orange, sage, dusty pink) get dark ink, coloured ink only on clearly light boxes | every sign | Geometry rule: all cities on their next build. |
| **Utility cabinets** were ~10 × 17 m grey blocks (half-extents not scaled); now real size | street level | All cities. |

Fixed on the way: a look **with** ink outlines (Graphic, Phantom Night) had its outlines switched straight back off by
`applyLook` (the edge-wear line had been inserted between an `if` and its `else`).

New look field `CityLook.windowGlow` (0.1–2, absent = 1): a multiplier on the lit-window and shop-window glow, so lit
windows stop clipping to white blobs under bloom. It is packed into the window material's `patternColor.a`
(`Material3D.windowGlow`); absent = 0 = the built glow, so saved looks render exactly as before. Saved in the City
marker only when set.

## Sky dome (visual-polish #9, 2026-10-03)

Spec: [../specs/visual-polish-next.md](../specs/visual-polish-next.md) item 9. Before / after shots: session scratchpad
`pupdrive/sky2/before/` (the legacy sky, `SKY=legacy`) and `pupdrive/sky2/after/` (driver `sky2/cap.js`, every scene
preset at `street0` / `roof` / `overview` / `up`, `sun` / `moon` views, the Persona packs, a tiled world;
`after-cards/` = cloud style "cards" in a tiled world). Zero GPU / WGSL errors in every run.

The city sky is now a **view-direction dome** drawn as the focus backdrop (`ArmatureBgOptions` mode `'sky'`,
`src/renderer/3d/sky-dome-pass.ts`; CPU layout + reference in `sky-dome.ts`; the per-time look in
`src/world/sky.ts` `skyDomeParams`). It sits at infinity, so it follows the horizon when the camera tilts and can never
be far-clipped, fogged or depth-sorted (single city, tiled worlds, HLOD and the fog horizon all look the same).

| Term | What you see |
|---|---|
| Gradient | the sky keys' top → bottom, now anchored to the real horizon (`1 - (1 - up)^3`), softening into the fog colour below it |
| City glow | night only: a warm band along the horizon fading up the sky; under rain / snow / overcast it spreads onto the deck |
| Sun | a crisp disc + halo + a warm band along the horizon on the sun side (stronger at golden hour); hidden under weather |
| Moon | a shaded disc (limb + soft maria) with a two-scale halo, ~24° up; clear nights only |
| Stars | sparse, twinkling, faded near the horizon and by the city glow; clear nights only |
| Clouds | anime cumulus in two layers (horizon banks + a 13–36° layer for street views): an offset-SDF lit cap that follows every lump over a shaded underside, a thin bright rim, a soft flat base. Noon white over blue-grey; golden = gold-peach tops, violet shade, gold rims; after sunset dark violet silhouettes with lit undersides; night moonlit, city glow on the undersides. Clear weather + the look's painted clouds + the Clouds toggle only |

| Control | API | Default |
|---|---|---|
| Sky dome on / off | `world.setSkyDome({} \| null)` / `world.skyDome` (a copy; null = off) | on in every scene preset and both Persona packs |
| Stars | `world.setSkyDome({ stars: 0..1 })` | 1 (Phantom Night 0.55) |
| Moon | `world.setSkyDome({ moon: 0..1, moonAzimuthDeg?, moonElevationDeg? })` | 1, 200° from the sun's base bearing, 24° up |
| City glow | `world.setSkyDome({ cityGlow: 0..1, cityGlowColor: [r,g,b] })` | 0.6, warm sodium `[1, 0.55, 0.32]` (Phantom Night red 0.55) |
| Cloud style | `world.setSkyDome({ clouds: 'anime' \| 'cards' })` | `'anime'` (cards = the older soft cloud cards) |

Frogmarks: City → Look, under **Painted clouds**: **Sky dome** checkbox, then Cloud style / Stars / Moon / City glow /
Glow colour (`worldSetSkyDome`, guarded `world?.setSkyDome?.()`).

- **Saved documents**: `CityLook.skyDome` is persisted in the City marker **only when on**; a city saved before it
  existed (or a style pack without a look: Tokyo, Noir, Cyber…) keeps the legacy flat screen gradient, blob stars /
  moon and soft cloud cards exactly. Applying a scene preset turns it on.
- **Cloud movers**: `LayoutParams.domeClouds` (kept in step by the look; a movers-only respawn) stops the drifting
  painted cloud cards from spawning when the dome paints the clouds, and the horizon cards are hidden. A freshly
  generated city keeps its built clouds until a look / preset syncs the param (never two cloud sets at once).
- **Lighting**: the dome is a backdrop only. Sky lighting (IBL / SH) is still baked from the sky keys alone, so the
  moon, stars, clouds and city glow never light the city; the default sky keys are unchanged.
- **Fixed — the sliced cloud card** (`tiled-golden-roof`): the far plane. Tiled-world horizon banks sat at 2.6–3.1 × the
  tiled extent, past autoFar (~2.8 ×). The legacy cards now sit at 1.7–1.9 × in tiled worlds with the same apparent
  size (a geometry change for tiled cities only; single cities unchanged).
- **GPU cost** (headless D3D11, 1300 × 850, timestamp A/B dome vs flat gradient): a frame that is all sky +0.12 ms
  (golden 0.49 vs 0.37 ms, night 0.55 vs 0.43 ms); street / overview frames are within noise (±0.1 ms). It is a
  full-screen pre-mesh pass, so the cost scales with resolution (~+0.2 ms at 1080p).
- Not checked with TAA / TAAU on (built alongside): the dome is drawn like the old gradient backdrop, before the meshes.

## Night streets, player light, ink on foliage (2026-10-03)

Spec: [../specs/visual-polish-next.md](../specs/visual-polish-next.md) items 5, 7c and the canopy / ledge ink notes. Before /
after shots at the same poses: the session scratchpad `pupdrive/night/before/` (the new fields switched off = the legacy
look) and `pupdrive/night/after/`; driver `pupdrive/night/cap.js` (`STAGE=city|play`, `OFF=1` for the before set), GPU
A/B driver `pupdrive/night/perf.js`. Zero GPU / WGSL errors in every run.

| What | API (`world.*`, all `CityLook` fields) | Saved documents |
|---|---|---|
| **Night light spill**: warm light on the pavement in front of every lit shopfront, a sign-coloured wash under each low shop sign (tenant signs, fascias, blade panels below 9 m; white boxes dimmer), and the street-lamp pools as soft light in the lamp colour | `nightSpill` 0–1.5, `setNightSpill(v)` | Opt-in: absent = 0 = the legacy pools and no spill. Every scene preset sets 1 (it only shows after dusk); Phantom Night sets 1. |
| **Wet streets**: rain glosses roads + pavements down to roughness 0.08 with ~4 m puddles near mirror-smooth and slightly darker asphalt, so the SSR reflections of signs and lit windows show; a dry night road goes damp (roughness 1 → 0.4 at 1: lamp highlights, no SSR) | `wetSheen` 0–1, `setWetSheen(v)` | Opt-in: absent = the legacy 0.35 rain / matte. Night sets 0.6, Rainy Evening 1, Phantom Night 0.6. |
| **Player light** (Play): a small unshadowed key light on the camera side of the player at about head height, 1.5 body heights of reach, scaled by the night level | `playerLight` 0–2, `setPlayerLight(v)` (engine: `scene3d.setPlayerLight3D({ strength, color } \| null)`) | Opt-in: absent = off. Every scene preset sets 1 (night-gated, so nothing by day). City-scoped: cleared on city exit. |
| **Ink on foliage**: `'silhouette'` = one line round each canopy, none between its leaf cards; `'off'` = no ink on foliage | `CityOutlines.foliage` via `setCityOutlines` | Absent = `'full'`. The Graphic look and Phantom Night use `'silhouette'`. |
| **Crease fade**: crease ink (ledges, window reveals, sills; not silhouettes) fades with distance, so mid-range ledges stop breaking into short dashes | `CityOutlines.creaseFade { near, far, minAlpha }` (metres) | Absent = off. Graphic + Phantom Night: 15 → 70 m, min 0.1. |

How it works:
- **Spill** (`src/world/light-spill.ts`): built on the main thread from the per-lot building meta (`lot-meta.ts`: the
  shopfront edge, the sign slots, and now the slot's colour index `k` and the building's `signColors`). Radial-fade quads
  (the lamp-pool / contact-blob material, no new texture, binding or pipeline), a 4 × 4 grid each so they drape over kerbs,
  one layer per colour bucket (12 hues + warm white, bright / dim). Group `World Light Spill`, rebuilt when the streets
  group is replaced (a regen) and dropped when the field is 0. Lots without building meta (basic boxes, older graphs)
  add none, and tiled worlds get spill on the centre city only.
- **Pools**: the grey-white disc was the glow pass multiplying the pool colour by 1.9 (every channel clipped to 1) plus
  the lamp point light on a bright diffuse. With the spill on, pools are dressed like the spill: emission in the
  (slightly saturated) lamp colour, every channel below 1, near-black diffuse. The built colour comes back when it is off.
- **Wet**: the procedural ground shader ignored the material roughness (it computes its own), so the old 0.35 rain
  roughness never reached SSR. A material roughness below 0.3 (only the wet sheen sets one) now glosses the ground
  surface, with a puddle noise; every other ground keeps its own (ground materials default to 0.5).
- **Player light**: `Renderer3D.setPinnedPointLights` uploads it ahead of the street-lamp candidates (it takes one of
  the 16 slots, so the shader loop never grows). The player's own shadow is the skinned shadow caster (moon / sun);
  a contact blob for moving characters is still item 16.
- **Ink**: the outline pre-pass now cuts leaf cards to their leaves (it inked the bare card squares: the long straight
  lines across canopies, in every mode), sways foliage with the wind like the colour pass, and marks foliage pixels with
  a half-length normal; the Sobel pass reads the foliage mode and the crease fade from a new `extra` vec4 (params buffer
  128 → 144 bytes).

**Default change** (documented): the leaf-card cut in the outline pre-pass applies to every scene with ink outlines, so
inked trees in saved scenes now outline their leaves instead of the card squares (a bug fix: the colour and shadow
passes already cut the cards).

**GPU cost** (headless D3D11, 1300 × 850, timestamp A/B, median of 9 paired off/on windows; the GPU was shared with
other jobs, so ±0.3 ms noise): night street spill +0.01 ms, night hero (whole city of spill) +0.11 ms, rain wet sheen
+0.13 ms, ink foliage mode + crease fade +0.02 ms. The player light adds no loop iteration when 16 lamps are near
(it replaces the farthest). The radial-fade quads now discard their corners before lighting (outside the unit circle
the fade is exactly 0), which also trims the lamp pools and the contact blobs.

## District palette, roof variety, mover shadows, density (visual-polish #11 / #16 + ink #3b, 2026-10-04)

Before / after shots, same poses: `scratchpad/pupdrive/life/before/` (the code before this pass) and
`scratchpad/pupdrive/life/after/` (driver `life/cap.js`: `OUTDIR=after STAGE=city|play node cap.js`; private no-HMR vite on
port 5235, `life/restart.sh`). Side-by-sides: `life/cmp/`, sheets `life/sheet-{noon,golden,night}-{air,street}.png`,
`life/sheet-graphic.png`. Mover-blob close-ups (traffic frozen, blobs off / on): `life/closeup/`; ink A/B (thinPx 0 / 2 / 3):
`life/ink/`; GPU / CPU A/B: `life/perf.js` (logs `life/perf.log`, `life/perf2.log`). Zero GPU / WGSL errors in every run.

What you get:
- **District palette** (`LayoutParams.districtPalette`, CityLook field of the same name): facades pick from a 3 × 3 grid
  per material — VALUE band (dark / mid / light) × HUE family (cool / neutral / warm), 45 low-saturation colours
  (`palette.ts` DISTRICT_SWATCHES). The region's tint picks the hue family (a neighbourhood stays coherent), a lot hash
  the value band with district weights (downtown contrasty, market warm mid-light renders, residential pale with dark
  brick). Near-white tile, dark brick, charcoal cladding and coloured render now sit side by side; the clean look's
  building mute takes half its strength on these walls (they are already low-saturation).
- **Roof variety** (`LayoutParams.roofVariety`): every flat / parapet roof takes a finish from dark tar, green and
  blue-grey waterproofing, pale concrete, white membrane, red-oxide metal and warm grey (district weights); pitched
  roofs from ibushi kawara, glazed blue, brown / red sheet, terracotta and weathered copper; 10–24 % of the 2–10 storey
  flat roofs become turf gardens (green deck + the planter boxes). The warehouse sawtooth keeps its sheet. Roof decks
  take a third of the building mute. Water tanks / AC / penthouses are unchanged.
- **Mover shadows** (`world.setMoverShadows(on, strength)`, default on at 0.55 = the static blobs): one transparent
  radial-fade mesh holds a blob per routed car / bus, walker / cyclist (routed + shotengai), rail car, plus the Play
  player. Each rendered frame the blobs follow their movers' CURRENT poses (so a mid / far / off-screen mover's blob
  moves at its sim-LOD rate), only the changed vertex range is re-sent (`Renderer3D.patchMeshVertices`, new; no pool
  rebuild), and a blob hides with its mover (LOD, door visit, dead-end fade), past 180 m and past the fog horizon.
  Footprints come from the mover's own rigid meshes (lower 55 % only: umbrellas and pantographs don't widen it), sized
  like the parked-car blobs (`cityContactShadowOptions`). Two unreferenced anchor vertices pin the mesh bounds to the
  city, so culling never needs a refresh.
- **Density**: `LayoutParams.trafficDensity` (× the routed cars + buses; the 64-car cap rises with it up to 2×) and the
  `pedestrianDensity` default 1 → 1.4 (static crowd + walkers, within the 4000 static / 240 walker caps).
  `world.setTrafficDensity(v)` (respawns the movers), `world.setCrowdDensity(v)` (rebuilds the crowd).
- **Ink, thin creases** (`CityOutlines.creaseFade.thinPx`, 3 in Graphic + Phantom Night): past the crease-fade near
  distance a crease inks only where BOTH faces are at least thinPx pixels thick along the edge normal (an occlusion edge,
  a depth step over 4 % of the distance, always inks). The sub-pixel ledge undersides at 30–40 m — rasterised in some
  pixels and not others — no longer ink dashes; near ledges and building corners keep their line. Packed in
  `camEye.w` of the Sobel params (no buffer size change).

**Saved cities** keep their look: `WorldManager._pinLegacyParams` pins an absent `districtPalette` / `roofVariety` to
false and `trafficDensity` to 1 on restore (the marker stores the full params, so absent = saved before), and an absent
`lighting.moverShadows` = off. The saved `pedestrianDensity` is kept as saved. New cities get all of it (DEFAULT params),
and every scene preset sets the two look fields (a 'World Streets' rebuild the first time a preset meets a city without
them). Old Graphic saves without `thinPx` keep their ink.

**Cost** (headless D3D11, 1300 × 850, GpuFrameTimer p25 per window, paired A/B medians; the GPU was shared with other
agents' jobs, so about ±0.3 ms noise):
- Mover blobs, GPU: night street −0.08 ms, noon street +0.17 ms, noon hero −0.01 ms (within noise); one extra draw call.
  CPU: the blob update ≈ 0.2 ms / frame for 237 blobs (≈ 30–40 KB uploaded per frame while traffic moves).
- District palette + roof variety, GPU: +0.23 ms median of 4 rebuild pairs (noise ±0.7 ms); ~+10 merged colour layers.
- Density 1 / 1 → 1.4 / 1.3, GPU +0.14 ms (street, 4 pairs), traffic tick 1.40 → 1.68 ms, +200 draw calls (crowd cells).
- Ink thinPx 3, GPU +0.11 ms (graphic street, 10 pairs).

Console: `salsaWorld.moverShadows(on?, strength?)` (+ its stats), `salsaWorld.manager.moverShadowStats()`.

## Roof equipment: clustered roof plant (visual-polish #11 tail, 2026-10-04)

Seen from above, the old flat roofs were a grid of grey boxes: a tank, 1–3 AC boxes, vents, a mast and pipe runs spread
over a 3 × 3 slot grid on every roof, hiding the roof-variety finishes. The **clustered** plant gathers the equipment at
the back of the roof and leaves the rest of the deck clear.

- **Param / look field:** `LayoutParams.roofEquipment: 'classic' | 'clustered'` (CityLook field of the same name). It is
  'clustered' in DEFAULT params (new cities) and in every scene preset. It is geometry, so a change rebuilds 'World Streets'.
  API: `world.setRoofEquipment('classic' | 'clustered')` / `world.roofEquipment`. The city passes it to each detailed
  building as `BuildingParams.roofPlant` (absent = classic, which is what the standalone Building Creator uses).
- **What a clustered flat / parapet roof gets** (`emitRoofDetailClustered`, building-parts.ts; lot-hashed, never `ctx.rnd`):
  - Along the back edge, from one back corner (a second lane runs forward along the side edge on narrow lots): a
    **stair box** in the wall colour with a steel door and a stone lid; **one water tank** on a steel stand, an FRP
    box (15 % round), in one of five fixed colours weighted by district (FRP blue, white, cream, green, red-oxide;
    `ROOF_TANK_COLORS`). Low roofs under 4 storeys skip it 60 % of the time. Then **one AC bank** of 1–4 top-fan
    condensers on a skid. The archetype's aerial, dish and solar heater go in the same cluster, one of each.
  - Up to two extras weighted by district (`ROOF_EXTRA_W`) at the front: a **neon frame** (two lit tube outlines on posts
    facing the street; commercial roofs without a billboard), a **solar array** (tilted PV rows, 10 storeys or fewer, not on
    turf roofs), a **laundry line** (residential), and a **lit mast** (cross-arm + red aviation light, two fixed heights).
    A turf roof also gets **garden planters** along both side edges. A rare tower of 14+ storeys gets a **helipad**
    (painted deck, border and H). Rooftop billboards keep their classic rule and odds.
  - Crowns (spire / mech / blade) and railings are unchanged.
- **Layers:** the coloured pieces have their own layers, `bldg:roof-equip-tank` / `-solar` / `-pad` / `-mark`, each with a
  pattern so the city's material classifier keeps the colour. They are under `roof-equip-`, so the roof-object LOD,
  twin, fog and drape rules apply. The stair box draws in `bldg:wallbase`, the neon in the sign colours, the mast light in
  `bldg:sign-lantern`. The tank, the AC bank and the mast are P20 parts with fixed sizes in the building's front frame,
  so they instance. The tanks rarely reach the instancing threshold because they come in five colours.
- **HLOD:** the mid tier draws one stair box per clustered flat roof (`tile-hlod.ts` `stairBox`). The classic HLOD drew
  no roof plant, and still doesn't.
- **Saved cities** stay classic: `_pinLegacyParams` pins an absent `roofEquipment` to 'classic' on restore. Applying a
  scene preset switches them, the same way as for district palette and roof variety.

**Bytes** (full tile, P20 instancing on, seed 3 grid, classic → clustered): tile (1, 0) 100.26 → 99.96 MB (−0.30 MB),
(0, 0) 102.98 → 102.64 MB (−0.34 MB), (−1, 1) 92.97 → 92.91 MB (−0.06 MB). The grey `roof-equip` layers lose
0.6–1.0 MB per tile. The coloured tanks (+0.17–0.29 MB), stair boxes, laundry, neon and masts add most of that back.
`roof-plant.test.ts` pins clustered ≤ classic on tile (1, 0). The roof-plant meshes in the live city: 142 meshes /
187k tris → 128 meshes / 148k tris.

Shots, same poses, Noon / Golden / Night (hero, overview, air, rooftop, two street views):
`scratchpad/pupdrive/roofs/before/` (classic) and `scratchpad/pupdrive/roofs/after/` (clustered). The driver is
`roofs/cap.js`: `OUTDIR=after ROOFEQ=clustered node cap.js`, run against a private no-HMR vite on port 5251
(`roofs/restart.sh`). Zero GPU / WGSL errors.

Tests: `src/world/roof-plant.test.ts` covers the defaults and presets, classic unchanged byte for byte, clustered
deterministic with ≤ 1 tank in a fixed colour and less grey plant, the tile byte budget, P20 instanced-vs-baked
triangle equivalence on the roof layers, the HLOD mid tier and tile determinism.
