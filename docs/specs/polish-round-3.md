# Polish round 3 — P5X-clean city, adverts, play mode, characters, camera + streaming

Started 2026-09-29. Target look: the Persona 5 X Shibuya street shot. The environment is clean PBR (only characters
are toon), with one warm golden-hour light, quiet surfaces, dense real-image signage, curved medium-poly props,
clumped soft tree crowns, an eye-level camera and muted buildings under saturated signs.

Status: `[ ]` todo · `[~]` partial · `[x]` done · `[-]` dropped (with reason).
Each track is owned by one agent. Frogmarks UI wiring is done by the main session at the end
(see [../ui/city-quality.md](../ui/city-quality.md) and [../ui/frogmarks-update-2026-09-28.md](../ui/frogmarks-update-2026-09-28.md)).

## T1 — Clean look + time/weather presets (styles.ts, day-night.ts, sky.ts, ground-surfaces, world-manager look)
- [x] **T1.1** City presets become TIME OF DAY × WEATHER combinations on one PBR look: Morning, Noon, Golden Hour,
      Dusk, Night, Rainy Evening, Snowy Morning, Overcast. The old style packs stay reachable through the API.
      → `CITY_SCENE_PRESETS` (src/world/scene-presets.ts), `world.applyScenePreset` / `scenePresets` / `scenePreset`
      (persisted). New weather `'overcast'`. API: [../ui/city-quality.md](../ui/city-quality.md).
- [x] **T1.2** The "clean" PBR baseline (`CITY_CLEAN_LOOK`; the default for new cities, saved cities unchanged):
  - procedural grunge and cracks down or off on roads and pavements
  - SSAO off by default
  - soft shadows, gentle bloom on signs only
  - subtle distance haze
  - muted building palette
  - done as live material edits in the glow walk (`_applySurfaceLook`): ground weathering 'new' + low jitter, and
    asphalt crack suppression via its unused tile slot (a small WGSL change in `groundAsphalt`)
- [x] **T1.3** Golden-hour sky: a purple→orange gradient and painted cloud cards lit by the sun.
      → `CLEAN_SKY` keys; smooth ellipsoid clouds (`Accum3D.ellipsoid`) with sky-tinted self-light; a ring of horizon
      banks (`world:sky-clouds`); `sunWarmth` gives a broader golden bell and a longer dusk phase.
- [x] **T1.4** Clean paving: large pale tiles with thin joints (P5X pavement). → `paving: 'tiles'` (50 cm, 4 mm joints).
- [x] **T1.5** A street-view camera preset: eye-level perspective, ~50° FOV. → `world.streetView()` (sun-aware).
- [ ] **T1.6** (stretch) Calmer facades: tidier window grids and glass curtain walls with reflections. Not started;
      the building mute covers the palette half.

## T2 — Adverts: GARP signage pool (building sign emission, signage.ts, GARP registry in shape-manager)
- [x] **T2.1** A `salsa/signage` pool with buckets:
  - portrait (~1:3–1:4, vertical kanban)
  - landscape (16:9–3:1 billboards)
  - square
  - fascia (~6:1 shop strips)
- [x] **T2.2** Users add images per bucket; Salsa packs them into an atlas (like the can labels). Each image has a
      Lit / Unlit flag. Images are cropped to fill. — 512² pages per bucket (4 portrait · 2 landscape · 4 square ·
      4 fascia), padded + bled; cover crop per sign face in `src/world/adverts.ts`.
- [x] **T2.3** Every city sign is tagged with a bucket and picks an image by position hash. An empty pool falls back
      to today's procedural signs. — Buckets come from each face's own aspect: tenant signs, fascia bands, blades,
      sign stacks, floor signs, wrap bands, LED screens and rooftop billboards, plus the simple signage pass.
      Picks use rendezvous hashing. An empty pool is byte-identical (tested).
- [x] **T2.4** Persistence plus a host API (add / remove / list images, pack), documented in docs/ui/garp.md. —
      The images are saved in garp.json (`signage`); the pages are packed again on load. API: `sm.addSignageImage3D`
      / `removeSignageImage3D` / `setSignageImageLit3D` / `listSignageImages3D` / `packSignage3D` /
      `signageBuckets3D` / `setSignageShare3D` / `clearSignage3D`. See docs/ui/garp.md §Adverts. Checked in the
      browser (day and night). Frogmarks Adverts panel pending (main session).

## T3 — Street props with real geometry (streets.ts lamps, signals.ts, furniture poles/plates)
- [x] **T3.1** Street lamps with a curved arm, a bell or lantern head, bevelled posts and a base collar. —
      `lamp-post.ts`: every post is one bevelled lathe (chamfered plinth, flared base, collar ring, taper). Arterials
      get a swept swan-neck arm to a bell over a glowing bowl. Junction lights get a curved davit arm to a cobra
      head. Classic is a faceted hex lantern with a roof and finial. `lampHeadOffset()` is the one source for the
      glass position, and the streets.ts pools use it. The junction glass sits about 5.3 m up, within 0.35 m of the
      0.34·s point lights (tested). Layer names and street-slots spacing are unchanged.
- [x] **T3.2** Traffic signals: housings with visors and backplates, and pedestrian signal heads. Mast arms get
      brackets. — `signals.ts`: bevelled poles with a domed cap (`signPost`), a tapered mast arm on a flange plate
      with a tie rod, bevelled housings on a backplate hung by two clamps, domed lenses under tunnel visors, and a
      pedestrian head on each pole. The walking and standing figures ride the crossing axis's green and red lamp
      layers, so the stock phase clock switches them. The layer grammar is unchanged. STOP plates get a dark back
      plate, a rail and straps.
- [x] **T3.3** Poles and sign plates: round sign plates with rims and brackets, bevelled utility poles. — Utility
      poles (`furniture.ts addPole`) are lathed with a chamfered foot and cap. They get step bolts, a bevelled
      cross-arm with two braces, bell insulators and a banded transformer. Road signs (`road-sign.ts`) have their
      post running up behind the plate, rimmed backing plates (a diamond for warnings) and clamp straps. Road signs
      no longer spawn on signalled crosses, where they collided with a signal pole. New meshbuild helpers:
      `lathe`, `sweep`, `bevelBox`. Tests: `street-props.test.ts`.

## T4 — Trees: soft clumped crowns (branch.ts, foliage.ts, city-foliage.ts)
- [x] **T4.1** Crowns are a few textured leaf-CLUSTER cards with spherised normals, so each crown shades as one soft
      volume. Keep sprig detail only close up, or blend the two. The shadow pass honours the leaf cut-out if it's
      cheap.
  - Done 2026-09-29. `branch.ts` `emitClumpCrown` (§3.6c), `leafStyle: 'clump'` in foliage.ts, and a per-species
    `CLUMP` table in city-foliage.ts: zelkova is a vase of clumps at the limb ends; ginkgo has small tall clumps
    along its spur limbs; camphor is a dense dome; sakura carries flat, sky-facing pads.
  - Clump centres sit at the terminal twig ends, plus fill along the terminal limbs and the level above. Interior
    clumps are skipped by 3D depth inside the crown, not by distance from the axis. The clump radius is fitted to
    coverage (crown shell area ÷ clump count), so branch-LOD variants grow fewer, bigger clumps.
  - Each clump has 10–14 cards on a jittered golden spiral. Each vertex normal is 0.4 clump-outward + 0.5
    crown-outward + 0.1 the card's own facing, with a slight lift toward the sky. Translucency is 0.3 (leaf) and
    0.4 (tip), because a crown is a volume, not one leaf thick.
  - Cluster cards set their UV u to the range [2, 3]. The shader's `leafCardCoverage` then picks the dense `leafClump`
    rosette (a solid core with about 15 leaves). No flag bit or instance slot is used. The per-card shading on
    clump cards is kept quiet.
  - **Shadow cut-out: done.** The depth pass now has a fragment stage, `fs_shadow`, that discards outside the
    silhouette, for bit-13 meshes only. The leaf WGSL is shared (`LEAF_CARD_WGSL`), and the change touches only
    shadow-shaders.ts and one line in pipeline-3d.ts.
  - **Sprig detail is not kept**, not even close up. The rosette cut-out already reads as leaves at 13 m, and city
    trees have no per-instance distance LOD, only fixed variants. A sprig near-LOD would bring the noise back into
    any avenue shot. The sprig style is still available (`leafStyle: 'sprig'`).
  - Triangle cost:

    | Measure (seed-3 city) | Before | After |
    |---|---|---|
    | Tree pool | 112.5k | 72.6k |
    | Leaf pool | 90.5k | 57.6k |
    | Drawn tree triangles | 1.21M | 0.69M |
    | Full-detail broadleaf variant | ~5.7–7.9k | ~3.0–4.4k |

    Overdraw per card is higher, because the cards are bigger and alpha-tested.
  - Browser check: headless screenshots at close, eye, mid and far distances. Not yet checked: overdraw and frame
    time on a dense avenue, and a direct A/B of the shadow cut-out.

## T5 — Play mode (src/game/, scene3d play)
- [x] **T5.1** A first-person player height setting, persisted. — `sm.setPlayerEyeHeight3D(h, metresPerUnit?)` /
      `getPlayerEyeHeight3D` / `getDefaultPlayerEyeHeight3D` (world units; metres via `cityMetresPerUnit()`), saved as
      `globalScene.play.eyeHeight` (absent = automatic 1.6 / 0.9·avatar). `play-settings.ts`. Docs: docs/ui/play-mode.md §Play settings.
- [x] **T5.2** Third-person with no player set spawns a default animated character automatically (idle/walk/run
      from the animation library). It is never saved into the document. — `play-auto-player.ts` (procedural body,
      excludeFromDocument mesh + skeleton, outliner-filtered, removed on Stop, cached between runs) + generated
      Walk/Run gait clips (`default-locomotion.ts`, idle = Breathe). Opt-out `sm.setAutoDefaultPlayer3D(false)` (persisted).
      Tests: play-auto-player.test.ts, default-locomotion.test.ts. Browser-unverified (see play-mode.md).

## T6 — Random character defaults (character randomizer / generators)
- [x] **T6.1** Eyes ≈ 0.4 wide × 0.2 tall, no bottom lash.
- [x] **T6.2** Hair cards: Cap Layers = 6.
- [x] **T6.3** Rim light on.
- [x] **T6.4** Tops long enough (crop 0).
- [x] **T6.5** Pants looseness > 0.014.
- ✅ 2026-09-29: engine-owned seeded randomizer `character-randomizer.ts` → `sm.randomCharacterParams3D(seed, body)` /
  `sm.createRandomCharacter3D({seed, position, body})`; `createFullCharacter3D` gained optional `rimLight`. Test:
  `character-randomizer.test.ts` (500 seeds + belly-coverage geometry + hair smoke). Docs: character-creator.md
  "Random character". ⚠ Frogmarks still randomizes host-side (`_randomizeCharacterInputs` in illustration.component.ts)
  — it must switch to the new API for the change to show in the app.

## T7 — 3D camera + city streaming / culling (orbit controller, viewport clamps, world-manager stream/LOD)
- [x] **T7.1** In 3D free mode, zoom never slows down (no illustration-style easing near the limits); it is
      effectively unbounded. — The slowdown was the orbit wheel's multiplicative dolly, which approaches the pivot
      by ever-smaller steps. `OrbitController.dollyThrough` (with `wheelDollyStep`) keeps the step multiplicative
      while far. Within `dollyFloor` of the pivot, each step moves a constant `floor × zoomSpeed`, and the pivot is
      pushed forward along the view ray. The floor is 10% of the framed content radius. free3D and City mode set
      `minRadius` 1e-4 and `maxRadius` 1e5. Edit-Mesh, packaging and armature orbits keep the classic dolly. The 2D
      zoom is untouched. Tests: `orbit-dolly.test.ts`.
- [x] **T7.2** A "return to scene" API (frame the scene) for a button beside the zoom controls. — `sm.frameScene3D(padding = 1.1)`
      (alias `sm.resetView3D`) frames all visible content. It skips `frameExclude` decoration: sky stars and moon,
      void grid, apron and border glow. In City mode it frames the city without its movers (`world.frameCity`). It
      uses the renderer's cached world AABBs and a tight 8-corner fit, keeps the current view direction, and lifts
      a below-horizon or grazing view to a 3/4 angle. Tests: `scene-frame.test.ts`.
- [x] **T7.3** City streaming regressed (laggier). Measure, find the cause, and fix it. — Measured with a CPU
      profile of the seed-3 City (headless dev server). The main cause was that traffic-signal re-dressing called
      `setDiffuseColor`, which sets gpuDirty. On a resident mesh that triggers a full geometry-pool rebuild,
      about 190 ms of re-upload on every signal phase change: the periodic 230 ms hitch. It is now a material-only
      write. Also fixed:
      - the traffic tick was 44% of main-thread time. There is now one matrix rebuild per mover mesh
        (`Node.setPoseXYZYaw`), lazy bounds for cheapBounds meshes, and a pose gate that skips hidden and
        off-screen movers and throttles far ones by distance.
      - the traffic spawn fired one scene-graph notification per mover group (about 430 full-scene walks). It is
        now silent adds with one notification.
      - untiered heavy layers now have LOD tiers: signal housings and lamps and lamp banners (PROPS), doors
        (DETAIL), sign lettering (STRUCTURE).
      Results: max frame 229 → about 16–25 ms, tick 2.3 → 0.9 ms, spawn 59–73 → 13–19 ms. See
      [../ui/city-quality.md](../ui/city-quality.md) § Camera + streaming.
- [x] **T7.4** The zoom-out limit in city mode: remove or raise it. — City mode used the orbit default
      `maxRadius = 50`. It now uses the free-zoom setup (1e5). Diorama fog scales with the pull-back once the
      camera is more than 0.6 × the base fog end from the centre, so the city doesn't drown in haze. Normal framings
      are unchanged. Tiled worlds keep a cap of `maxRenderTiles × span × 1.5` so the streamed ring still fills the
      view.
- [x] **T7.5** Culling assumes a top-down view. At street level, looking around makes surroundings disappear. Make
      culling camera/frustum-aware (perspective, low pitch), not zoom-level only. — `view-cull.ts`: a streamed tile
      or the centre city is now a 3D box (footprint × building height) tested against the frustum. It is ranked by
      distance from the camera, not by the flat ground footprint's NDC corners, which culled the tile you stood in
      when you looked up. The detail-LOD metric is `min(orbit radius, 2 × camera distance to the city disc)`. It
      matches the old metric at an overview pitch, collapses at street level, and never culls more than before.
      Tests: `view-cull.test.ts`, which also pins the old test's failure.

## Integration (main session, 2026-09-30)

**Frogmarks wiring (all logged in Frogmarks ClientApp/salsa-tracker.md):**
- City panel:
  - scene preset buttons, with the old style packs behind "Show style packs"
  - Street view
  - the new Look controls
  - Overcast weather
- Skins panel: Adverts section.
- Top toolbar: a ⚙ Play settings popover (Player height, Auto default character).
- Zoom control: a "Scene" button, and in free3D the % readout returns to the scene view.
- The random character uses the T6 ranges plus `rimLight: true`.

**Tuning pass from street-view renders:**
- Golden Hour: warm dusk shadows, a warmer zenith and a gold grade. It was reading lavender.
- Night and Rainy Evening: lifted blacks, and bloom that starts later.
- Shop glass: its night glow goes from 0.95 to 0.6.

**Still open (browser):**
- Golden Hour is warm-neutral, not yet P5X gold.
- Big white shopfront / screen panels still bloom out at night when the Adverts pool is empty.
- The auto player is unscaled in cities: ~1.7 units tall, so it looks giant.
- STOP lettering: built on the browser path (`signals.ts` computeSignalTextSigns + `world-manager` `_addTextSigns`, canvas rasterized); headless renders skip text bitmaps by design, so it only looked missing there.
- Real-GPU frame times.

## Round 4

### Sky lighting blew PBR surfaces out to white (fixed 2026-09-30)

- **Symptom.** With the clean look's `skyLighting` on, the default PBR style washed pale surfaces (the 50 cm tile pavements most of all) to near-white at every daytime preset. Cel HD looked fine.
- **Cause.** `_applySkyLighting` baked the sky into SH-IBL at a fixed `intensity = ambientIntensity x 1.1`. The SH integrator (`renderer-3d._computeSHCoeffs`) returns true irradiance, which is PI x radiance, and the PBR ambient term (`evalSHIrradiance(N) * albedo * iblIntensity`) applies it with no 1/PI. A pale day sky (radiance about 0.6 to 0.8) therefore gave an up-facing fill of about 2.0 against the flat ambient's 0.53, roughly 3.8x at noon/overcast and 3x at morning/golden, all added on top of the sun. The pale tiles (albedo about 0.8) went past 1.0 before the grade, and bloom clipped them white. Only PBR (style 0) reads IBL; cel, cel HD and ink use `scene.ambientColor`, which is why they were unaffected. The env specular was not the cause: it only runs on metals, SSR-smooth or planar surfaces, and never on the rough ground.
- **Fix (city only; no shader change).** `procedural-sky.ts` adds `skyIrradiance(sky, sunDir, n)`, a CPU cosine integral in the same units as the SH path, and `ambientMatchedSkyIntensity(sky, sunDir, ambient, { gain, maxUp })`. The city now picks the bake intensity so the mean of the up-facing and side-facing sky fill matches the tuned flat ambient (`ambientColor x ambientIntensity`), then scales it by `gain = 1 + 0.45 * day`: brighter, airier shade by day, flat energy at night where lamps and neon light the scene. `maxUp = 0.75` caps the up-facing fill so pale ground plus sun stays under white. The bake's ground hemisphere went from 0.3 to 0.5 x horizon (bounce off a lit city), because 0.3 left cloud undersides and eaves murky. Up-facing fill before and after: noon 2.0 -> 0.75, overcast 2.3 -> 0.75, snowyMorning 1.9 -> 0.75, morning 1.3 -> 0.60, golden 1.2 -> 0.56, dusk 0.37 -> 0.13, night/rainyEvening about 0.07 (unchanged).
- **Not changed.** The global PI factor in the PBR IBL path. Non-city scenes (sky presets, imported HDRIs, the Frogmarks Sky picker) were tuned and browser-verified against it, so the renormalisation lives in the city caller. A shader-level 1/PI would dim every existing IBL scene about 3x. Cel, cel HD and ink are untouched because they never sample IBL.
- **Verified.** Headless before/after renders of hero and street views: noon, golden, snowyMorning, overcast, night (before), plus morning, dusk and rainyEvening (after). Pavements read as grey tiles at every preset. Day shade is lighter than with sky lighting off and carries a slight sky tint. Night and rain are unchanged. The unit tests are in `procedural-sky.test.ts`.

### Play in a city: real-size, dressed default character + move speed (2026-09-30)

- **Symptom.** In a city the third-person auto default character was a giant (1.7 units = ~25 m at `cityMetresPerUnit()` = 15) and naked (a bare procedural body). Speeds, jump, eye height and the camera follow distance were also city-unit giants (walk 52 m/s, eye 24 m).
- **Scale.** ShapeManager installs `scene3d.setPlayMetresPerUnitProvider(() => city ? cityMetresPerUnit() : null)`. Play divides every `DEFAULT_CHARACTER` length / speed / acceleration by it (eye height, move speed, jump, gravity, radius, step height, follow distance/pivot, camera padding/min distance) and the avatar-framing distance floor is 1 m, not 1 unit. That covers a user-set Player too. The auto character is scaled to 1.7 m (`AUTO_PLAYER_HEIGHT_M`) via `PlayAutoPlayer.acquire(x, y, z, { height })`. Outside a city nothing changes (provider null means 1).
- **Dressed.** The auto character is now the seeded random character (`AUTO_PLAYER_SEED` = 20260930 in `randomCharacterParams`): face with procedural eyes, garments (made before the hair so the hair fits over them once), card hair, skin tone and rim light. It is assembled directly on `Scene3DCharacter`, so there is no ShapeManager wrapper, no undo and no paint-carry. **Never saved:** every part is `excludeFromDocument`. `Scene3DCharacter.markRuntimeBody` makes every `serialize*` and `getFaceTextureExports` skip that body. `clearForDocumentLoad` keeps its rigs (the cache outlives documents). `getSceneGraphJSONForDocument` drops its nodes by id (`dropRuntimeNodesFromSceneJSON`). The outliner filter covers all its parts. `play-auto-player.test.ts` runs a full `DocumentStateCoordinator.gather` mid-Play with a fake GPU device and checks that none of it is in `scene3dJSON` or `meshTextures`, while a user character in the same scene still serializes.
- **Hair springs on a scaled character.** `spring-bone-solver.ts` used LOCAL bone length, collider radius, hit radius and gravity as world values, and wrote spring joints back at scale 1. On the shrunk body, hair tails would have been full size. The solver now scales them by the parent joint's world scale, snapped to exactly 1 near 1, so unscaled rigs solve bit-identically. There is a test for this in `spring-bone-solver.test.ts`.
- **Ground.** The ground ray started at y = 10 000, so the topmost surface was the floor. At real scale the player spawned on a cloud and would pop onto any canopy it walked under. The ray now starts at `groundProbeTop` (feet + max(step, ½ eye), the wall-ray height), and a camera spawn stands on the ground under the camera.
- **Move speed setting.** `sm.setPlayerMoveSpeed3D(mps | null)` / `sm.getPlayerMoveSpeed3D()` take metres per second (default 3.5). The value is stored in `play.moveSpeed` only when it isn't the default, and it applies live. The walk/run thresholds and blend stops follow it: the animation gets `speed × 3.5 / moveSpeed`. Frogmarks wiring: a "Move speed (m/s)" slider under Player height (see docs/ui/play-mode.md).
- **Verified.** Headless city (seed 3, street view): the character is 0.1133 units = 1.70 m and dressed next to pedestrians of the same size. Idle, walk and run animations play. Run measured 3.50 m/s, and 7.00 m/s after `setPlayerMoveSpeed3D(7)` (still Run). The first-person eye is 1.60 m. A save snapshot mid-Play has none of its ids and it is gone on Stop. A non-city third-person run is unchanged and the re-spawn comes from the cache (5 ms, same id).

### City cars: lofted "Persona 5 / GT" bodies (2026-09-30)

- **Before.** `vehicle.ts` stacked `obox` slabs with a 5-quad greenhouse and `beam` wheels: about 320 tris per car, and every car read as a box. Cars had no lights, because they were left for a GARP texture that was never built.
- **Now.** A LOFTED body, as described in car-creator.md §"The geometry engine" (built inside `vehicle.ts`; the separate `car.ts` Creator is still future work).
  - **Profile and section.** A side profile of 30 to 40 stations: hood with a convex drop to the nose, cowl, a slightly bowed raked windshield, a crowned roof arc, a convex backlight and the deck. Each station is a closed 16-point cross-section: underbody, rocker tuck, SHOULDER crease, belt, side glass with tumblehome, drip rail and roof crown.
  - **Shading.** Rings are stitched with AUTO-SMOOTH normals (neighbouring faces within 42° blend). Panels read rounded while the shoulder and belt lines stay crisp.
  - **Wheels.** Wheel ARCHES are cut into the section: the rocker and floor rise on a circle over each axle, which forms a dark wheel-well roof. Tyres are lathed and tucked in, on silver multi-spoke alloys (sedan 7, hatch 6, kei 5) or chrome hubcaps (classic, taxi, van).
  - **Greenhouse.** Dark tinted glass, thin body-colour A and C pillars plus a drip rail, and a blacked-out B pillar.
  - **Fascias.** Flush head and tail lamps, grille, rub strips (chrome bumpers on the classic) and a rear plate.
  - **Sides.** Door shut-lines, handles, a body-side moulding (sedan and hatch) and door mirrors.
  - **Taxi.** Checker door belt and an andon roof sign.
- **Styles.** `sedan` (90s Accord/Civic 4-door, the primary), `hatch`, `kei` (tall Wagon R), `van` (kei one-box, cab-over), `classic` (80s Crown/Cedric, square with chrome bumpers) and `taxi` (the classic body plus a sign and belt). `bus` and `truck` are rebuilt from bevelled boxes on the same wheels; the truck is a JP aluminium-box delivery truck. The traffic mix is 9% taxi, 11% classic, 15% hatch, 12% kei, 7% van and 46% sedan. Parked plan "sedan" slots split by position hash into 60% sedan, 22% hatch and 18% kei. The plan, slot lengths and determinism are unchanged.
- **Tris per vehicle** (before, then after): sedan 322 -> 1972, hatch (new) 1900, kei (new) 1860, van 322 -> 1732, classic 322 -> 1860, taxi 346 -> 1964, bus 332 -> 800, truck 308 -> 712.
  - **Sharing.** Traffic archetypes share geometry per (type, colour). Parked cars stay merged per paint colour, as before.
  - **Budget test.** Every style must be at most 2.5k tris.
- **Lights and night glow.** Moving cars carry `world:veh-headlight` / `world:veh-taillight`, which the GLOW walk matches. Parked cars (`lights:false`) put the same lenses into UNLIT `lensHead` / `lensTail` layers, named `world:car-lens-head/-tail` or `world:veh-lens-*`. These names must never contain "headlight" or "taillight", and a test guards this.
- **Movers.** Mover structure is unchanged: the same layer list per archetype, built at the origin along +X. The traffic `halfLen` and headlight-pool offset now come from `vehicleHalfLength(type)`.
- **Files.** `src/world/vehicle.ts` (rewrite), `src/world/vehicle.test.ts` (12 tests: finite, deterministic, unit normals, budget, proportions, glow names, orientation), `src/world/traffic.ts` (type mix and halfLen), `src/world/furniture.ts` (parked variety, lens layers, shared paint look).
- **Verified.** Headless (seed 3, golden plus night) in a showroom row on a real street, at 3/4 front and rear per style, with street views while traffic runs, and at night (taillights glow on moving cars).
- **Pending browser check.** Paint and chrome gloss on a real GPU with sky IBL. Parked-car frame cost on large cities: merged parked meshes grew about 6x in tris. If that bites, instance them per style.

### City pedestrians: Persona 5-style crowd NPCs (2026-09-30)

- **Before.** `mannequin.ts` people had a big round head (a 0.1 m sphere plus a hair cap) and a boxy half-hip block and shoes. They wore stripe-pattern garments in a saturated palette and were lit like everything else. The static crowd was about 206 tris per person (max 251) and walkers about 383 (max 421).
- **Now.** The crowd is modelled on P5's faceless background NPCs.
  - **Proportions.** Adult proportions: the hip joint at 0.53 of height, a head that is 1/7.5 of height (a narrow ellipsoid, 0.19 x 0.23 x 0.16 m), narrow shoulders (shoulder joint about 0.17 m from centre, 0.158 m for the female figure) and slim limbs.
  - **Geometry.** The torso is one smooth tapered loft with slope-aware normals. Hems sit at the crotch for a jacket or top, the knee for a coat and the ankle for a yukata. The legs are thigh + shin tubes (walkers add a calf), and the shoes are ellipsoids. Hidden caps are dropped, since city meshes are double-sided.
  - **Faceless heads.** The head is plain skin. A hair SHELL opens a face window at the fringe line (`ellip(..., front)`) and hangs lower at the sides and back per style. There is a back panel for long hair, a bun, and cap or brim hats.
  - **Wardrobe.** Archetypes: suits (the trousers match the jacket, with a white shirt V and a tie), office blouse and skirt, cardigan, gakuran, sailor, casual (with caps), elder (brim hats), student, parent, worker, long coat and yukata (with an obi). Bags are briefcase, shoulder, backpack and tote. The palette is muted (navy, charcoal, black, grey, white shirts, beige, camel, khaki, plus pastel sky, sage and oat).
  - **Poses (static crowd, `staticPose`).** People at bus stops and signals mostly look at a phone (the head dips) or clasp their hands. Strollers are caught mid-stride. Groups and shoppers stand, and bench users sit.
- **Flat shading (no shader, no flag bit).** `PED_SHADE` dims each crowd layer's diffuse (x0.6). The world GLOW walk gives `world:ped-` / `world:traffic-walker` an emissive of that colour x0.62 by day and x0.24 at night. Output is about colour x 0.6 x (light + 0.62): roughly the same brightness in sun, but shadowed sides only drop to about half, so the crowd reads as soft colour blocks behind the hero characters. The garment stripe pattern was removed (`clothPattern` is gone; `crowdLayer()` builds both kinds of layer).
- **Walkers swing their arms.** A FREE arm (not holding a phone, umbrella, briefcase, tote or handlebar) is its own mesh, `world:traffic-walker-armL/R`, built in shoulder-pivot space. The hand is in the sleeve colour, so the arm is one mesh. The ticker swings it about the shoulder, opposite its same-side leg, at 0.8x the leg angle (`gait.arm`). It uses the same `setPoseXYZYaw` write and the same pose gate. Held arms stay in the rigid body. Skirts step shorter (amp 0.34) and yukata much shorter (0.16). Walkers are now 6 to 11 meshes (up to 2 arms added). Hats, obis and phones fold into an existing same-colour part, so they add no mesh. There are 20 walker looks, up from 16.
- **Tris** (before, then after): static person avg 206 -> 315 (max 251 -> 358; worst pose under 420). Walker avg 383 -> 433 (max 421 -> 477, both arms included). Static crowd at the default density is about 770 people, so about 160k -> 243k tris in about 30 merged draws.
- **Bug fixed: the crowd never appeared after zooming in (headless and orbit-only sessions).** The host renderer (`webgpu-renderer.updateRenderList`) filters `visible` only when it rebuilds its render list, which happens on a structure change or a 2D pan. The zoom LOD hides the static crowd, walkers and fine detail at spawn, and turning them back on with `visible = true` never re-filtered the list, so they stayed undrawn. The same applied to chat emotes, walkers coming back out of a door visit, headlight pools, and night lamp-pools and stars.
  - **Fix.** `Scene3DManager.notifyVisibilityChanged3D()` (`requestBackgroundRender`, the cheap viewport re-filter, plus a frame) is now called by `_applyLOD` when it shows a tier, by the traffic ticker when any mover mesh goes from hidden to shown (`_show`), and by the time-of-day pass when a pool, star or cloud mesh turns on.
- **Tests.** `src/world/mannequin.test.ts` (new) covers proportions, determinism and wardrobe coverage, the tri budgets, the faceless face window, held vs free arms, skirt and yukata step length, `PED_SHADE` contrast and static poses. `world-traffic.test.ts`: arms swing opposite the same-side leg, and a shown mesh notifies the host. `route-sim.test.ts`: arm layers plus `gait.arm`, and crowd layers are flat (no pattern, emissive lift). The budget bounds in `street-slots.test.ts` (350 per person) and `route-sim.test.ts` (500 per walker) were raised.
- **Verified (headless, seed 3).** Street views and close-ups at the default clear day, golden and night: waiting crowds with phones, suited strollers mid-stride with briefcases, a bus-stop bench, chatting groups, frozen walkers (coat, cyclist, office). People render without the forced render-list refresh.
- **Pending browser check.** Real-GPU look of the flat shading under the cel / cel-HD city styles and SSAO. Walker arm swing in motion. Frame cost with the extra arm meshes on a dense crowd (`pedestrianDensity` 3 to 4).

### Round 4 — main-session fixes (2026-09-30)
- **Scene preset buttons didn't work.** This was a Frogmarks bug: the `*ngFor` source was a getter returning fresh objects every tick, so the buttons were rebuilt constantly. It is now cached.
- **Move speed slider** added to the Play settings popover (`setPlayerMoveSpeed3D`, in m/s).
- **Lit shopfronts at night blew out to white.** Shop glow in `windowShade` was a fixed ~1.2× white, ignoring the GLOW table. Shops now glow with the interior-mapped room (shelves, products, strip lights) at 0.62, so the interior reads through the glass. Browser-checked at night.

## Round 5 — culling (2026-09-30)

Goal: whatever is outside the camera is not drawn, in the editor and in Play mode, so walking a city doesn't lag.

**What was wrong.** The renderer already culls per mesh against the camera (`FrustumCuller` in
`Renderer3D._buildDrawLists`; explicit array groups are culled as a whole). Play mode (third- and first-person) uses
the same `drawMeshes` path, and nothing in Salsa turns culling off. (Frogmarks has a per-document "frustum culling"
toggle, which is on by default.) But the city merges most layers across the whole city: roads, pavements, kerbs,
paint, building detail, signs, poles, wires, the crowd per colour, parked cars per colour. Each of those meshes has a
bounding box as big as the city, so none of them could ever be culled. At street level about 88 % of the city's
triangles were drawn every frame (2.1–2.2 M of 2.47 M).

**Spatial chunking** (`src/world/chunking.ts`, `chunkCityLayers`). Each big layer is split into an nx × nz grid over
its own XZ bounds:
- World-baked geometry is split by triangle centroid. Instanced array layers (trees, vending machines, GARP props,
  detail) are split by instance position. Each cell's instanced group shares one GPU geometry through a content-hash
  `instanceKey`, so whole-group culling works per cell.
- Cells per axis = `floor(sqrt(tris / 1500))`, capped at 10, and no cell narrower than 0.15 × radius (22 m at the
  default radius). Array layers also need at least 4 instances per cell. Small layers pass through unchanged.
- **Names are unchanged.** Every name rule still matches: the GLOW table, the DETAIL / ROOF / PROPS / FLATMAP /
  STRUCTURE LOD regexes, snow and wet, `SIGNAL_LAMP_RE`, the drape tiers, the rail-train hide. No consumer looks up a
  city mesh by name. The cell id is kept on `layer.chunk` for diagnostics only.
- **Never split:** transparent layers (they sort per mesh), landmark layers with `outlineRanges` (hover silhouettes),
  layers with one mesh per instance, and the Sky, Border Glow, Traffic and Visit Doors groups.
- **Procedural ground:** each chunk carries the unsplit layer's uv-scale sample triangles (`Mesh3D.groundUvSample`),
  so every chunk gets exactly the same metres-per-uv. Without this, sloped chunks would each get a slightly different
  scale, and you would see a seam in the paver pattern at every cell border.
- **Where it runs:** at the one step every centre build passes through. The centre-build worker chunks in the worker
  (`CentreBuildOptions.chunk`), and `WorldManager._chunked` handles the main-thread paths. Already-chunked layers pass
  through. **Streamed tiles are not chunked**, because each tile is already its own cell. Chunking tiles measured
  +73 % meshes and 2× renderer CPU on a 3×3 full world. The reassembly job weight now counts a per-layer spawn cost,
  so a regen's worst job went from 8.8 ms to 6.4 ms (it was 16.5 ms before that fix).
- The build output is deterministic. Saved cities regenerate from params, so nothing about saving changes and the
  chunking can't be seen. Toggle with `salsaWorld.cullChunks(false)` (this rebuilds the city). Tune with
  `salsaWorld.cullChunks(true, { targetTris, maxCells, minInstances, minCellMul })`.
- `LayoutParams.detailGrid` (which chunks only the detailed-building instanced detail) is left at 0. The generic step
  already chunks those layers.

**Shadow pass.** Before this change, the shadow map replayed the list that had been culled against the camera. So a
caster just off-screen threw no shadow into the view. With chunking, that would have become visible popping at the
screen edges. Shadow casters now get their own list (`_shadowList`), culled two ways:
1. Against the light's ortho box. This matches exactly what the GPU clips, so it can't change the picture.
2. By `shadowReachesView` (in `frustum-culler.ts`). The caster's box is swept along the sun down to the scene floor
   (last frame's lowest bounding-box minY). If that swept box misses the camera frustum, the caster is dropped. This
   list always contains everything the old camera-culled list had, so it adds no popping the old list didn't have.
   The test is skipped when the sun is within about 3° of the horizon or a planar mirror is live.

Toggle: `sm.renderer3D.shadowLightCulling = false` restores the old list for A/B tests.

**Stats.** `salsaWorld.frameStats()` now also returns:
- `meshesCulled`, `groupsCulled`, `instancesCulled`
- `trisTotal`, `trisVisible`, `trisDrawn`
- `shadowCasters`, `shadowCulled`, `shadowOffView`, `shadowDrawCalls`, `shadowTris`
- `msCull`

See the reading guide in docs/ui/city-quality.md.

**Also fixed (found by the A/B).** Array-group copies never had their uvTransform written (instance floats 56–59). They
sampled whatever stale floats were left in the reused staging buffer, often (0,0), which turns a texture into one
texel. So GARP-skinned vending machine bodies showed as flat colour, and which look you got depended on the slot
layout. Copies now share the source's uvTransform. Also, uploadMeshInstances' source→group slot assignment is now a
map lookup, where it used to scan every group for every mesh.

**Measured.** Seed-3 grid city, headless Chrome on the dev machine's GPU (d3d11), 1300×850, traffic on. Values are
averages of 3 baseline and 1–2 new runs. Draw calls are the main and pre-passes, not counting shadows.

| view | tris visible (main) | main draw calls | shadow tris | shadow draw calls | renderer CPU |
|---|---|---|---|---|---|
| hero | 2.18 M → 1.52 M (−30 %) | 872 → 1132 | 2.00 M → 1.33 M | 998 → 944 | 2.8 → 2.9 ms |
| frame-all (overview) | 2.45 M → 2.45 M | 1402 → 2013 | 2.22 M → 2.24 M | 2295 → 2890 | 2.8 → 3.8 ms |
| street, 8 directions | 2.12–2.20 M → 1.12–1.58 M (−28 to −47 %) | 670–920 → 780–1220 | 1.95–2.02 M → 1.07–1.39 M | 670–1000 → 820–1220 | 2.0 → 2.6 ms |

- **GPU frame time did not change** within noise: about 7–10 ms of throughput at full resolution. On this GPU the city
  is limited by pixel fill, not triangles: at 0.4× resolution the same frame takes 3–4 ms. Culling is aimed at GPUs
  that are limited by triangles (laptop / integrated). It cuts 30–47 % of the street-level vertex work in the main
  pass and about 35 % in the shadow pass, for about +0.5 ms of renderer CPU.
- The frame-all overview can't be culled (everything is on screen). There it costs about +600 draw calls and
  +1 ms CPU.
- **Tiled 3×3 full world:** the centre is chunked and tiles are not. Main-pass tris visible go down 7–13 % at street
  level. Shadow tris at street level are unchanged at about 9 M. At the hero view the reach test is what keeps the
  shadow list bounded; with only the light box, the world-sized box would draw everything.
- **Screenshot A/B at 10 fixed cameras** (traffic off, same time of day): the only pixel differences were animated
  surfaces (screens, water glitter, tree sway). The same noise shows up between two runs of the same build. No geometry
  pops or disappears.

**Not done / next.** (Status 2026-10-04: skinned frustum culling was done in R6.1 below (`skinned-cull.ts`), and GPU
timestamp timing now exists (`src/renderer/core/gpu-frame-timer.ts`, used by performance-plan P15–P22).)
- Skinned characters are not frustum-culled (`drawSkinnedMeshes` draws everything visible). That is fine for one
  player; it would matter for a skinned crowd.
- Distance LOD: most of what is still visible at street level really is in view, down a long street.
- GPU timestamp queries would give a real per-pass GPU split. The driver used throughput timing, and it was noisy on
  a shared machine.

## Round 6 — culling/LOD, game-feel camera + movement, dress cloth, pedestrians (2026-09-30)
- [x] **R6.1** Frustum-cull SKINNED meshes (the basis for performant skinned crowds). Distance LOD per city chunk, camera-aware: the camera can go anywhere now, so distance is measured to each chunk rather than by zoom level. Review the old zoom LOD tiers. **Done 2026-09-30, see "R6.1 notes" below.**
- [x] **R6.2** Third-person game feel. **Done 2026-09-30, see "R6.2 notes" below.**
  - movement relative to the camera, and the character turns smoothly to face its move direction
  - mouse orbits the camera only
  - a further camera or FOV ~75
  - Shift toggles walk/run
  - an animation state machine with smooth crossfades (idle ⇄ walk ⇄ run, stop → idle)
  - no teleporting onto things overhead
- [x] **R6.3** Dress and skirt fabric follows the legs without clipping. **Done 2026-09-30, see "R6.3 notes" below.**
- [x] **R6.4** Pedestrians: simple but high quality, like the P5 crowd reference. **Done 2026-09-30, see "R6.4 notes" below.**
- [x] **R6.5** Pale triangular web between the shins during Walk/Run, drawn by the BODY mesh. **Fixed 2026-09-30, see "R6.5 notes" below.**

### R6.4 notes — a medium-poly Persona crowd (2026-09-30)
The crowd keeps the mannequin approach: `src/world/mannequin.ts`, not skinned characters. The same recipe feeds the
static crowd (merged per colour, `world:ped-*` / `world:ped-deck-*`) and the instanced walkers. The flat
PED_SHADE look, determinism, layer names, LOD / GLOW regexes, the pose gate, the visibility-notify fix and the
per-colour merge are all unchanged. World-manager was not touched.

**New primitives.**
- `sweep`: elliptic cross-sections along a polyline, with smooth normals and domed caps. Used for limbs, shoes,
  ponytails, bags and furled umbrellas.
- `oellip`: an oriented ellipsoid, used for hands, thumbs and buns.
- `PersonXf.lean`: rotates the upper body about the hip, or tilts the whole body about the feet.
- Arms are a 2-bone analytic IK toward a per-hold wrist target, with fixed bone lengths.
- Legs take a hip angle plus a knee flex. The body sinks until the lower heel or toe point is on the ground.

**Anatomy.**
- Egg-shaped faceless head loft with a jaw and chin.
- Neck, sloping trapezius ring and a fem bust offset.
- Shapely bare legs (narrow knee, calf bulging at the back, slim ankle). Trousers are straighter and break over the
  shoe.
- Hands: a palm plus a thumb.
- Shoes are swept with a flat sole: dress, loafer, pump, sneaker, or geta with a bare foot.

**Clothes.**
- Sleeve cuts:
  - `long` stops short of the wrist;
  - `short` bares the forearm;
  - `wide` is the yukata's hanging sleeve.
- Skirt cuts:
  - `aline`;
  - `pencil`;
  - `pleat` (pleats modulate the ring radius);
  - `flare` midi.
  Each has a hem band.
- Shirt collar band, the V under the lapels, and a longer tie. An open jacket shows the shirt down to the hem.
- Sailor collar: a back flap, the front V and a red ribbon.
- Standing collar on gakuran and coats, and the crossed yukata front.

**Hair.**
- A short cut with volume on top.
- A bob whose ends flare out.
- Long hair with a back curtain.
- A new **ponytail**.
- A bun.

**Accessories.**
- A soft shoulder bag.
- A briefcase with a handle.
- A tote or briefcase held in front with both hands (clasp pose).
- A domed 8-panel umbrella.
- A **closed umbrella** carried furled at the side. In rain, people under a shelter, awning or shop (kinds wait,
  window, vend, stall, lean, rail) carry it closed. Walkers keep theirs open.

**Static poses.** The new poses are:
- `rest`: weight on one leg, the free knee bent, a hand in a trouser pocket or on the bag strap;
- `talk`: a gesturing hand (groups);
- `lean`: back against a shop wall with one foot flat on it. This is a new spot kind: 30 % of window shoppers
  become leaners, facing the street, kept clear of doors;
- `rail`: leaning over a canal-bridge parapet with the hands on its top rail. This is a new placement: 1–2 people
  per bridge side. The lean needed to reach the rail is solved from the rail height (a 0.68 m parapet, so they
  peer over).

`stride` now has a heel-strike front leg and a toe-off back leg. `flip` mirrors a pose per person, and narrow
skirts, coats and yukata keep their thighs together.

**Walk cycle** (`world-traffic.ts`).
- Walkers have new `world:traffic-walker-shinL/R` meshes, built in knee-pivot space and hung at the swung thigh's
  knee. When the shoes differ from the legs they get separate `shoeL/R` meshes, and they get skin `handL/R`
  meshes that swing with the arms.
- `kneeFlexCurve`: the knee folds through the swing, is straight at heel strike, and gives a little on loading.
- `walkerSink`: the body dips 2–4 cm at double support, so the bob now comes from the leg geometry.
- The upper body leans forward 2°.
- Cyclists' knees follow the crank, with no ground contact.
- A yukata keeps the old rigid legs (no shins).

**Budgets (tris per person).**

| | Before | After |
|---|---|---|
| Static crowd, average (standing) | 315 | 538 |
| Static crowd, worst pose | 367 | 620–640 (with an umbrella) |
| Walkers, average | 433 | 706 |
| Walkers, maximum | 477 | 782 |
| Walkers, maximum with an umbrella | 491 | 802 |

- Walker meshes per walker went from about 9.2 to about 14.8. They are all instanced per archetype: 424 geometries
  in the seed-11 test city.
- Tests (`mannequin.test.ts`, `route-sim.test.ts`, `street-slots.test.ts`) now assert:
  - the new budgets;
  - that feet are on the ground in every pose;
  - the knee curve and the bob;
  - the wardrobe variety and the closed umbrella;
  - the pose map.
- The static crowd now has up to about 50 layers (ground plus bridge decks, one per palette colour). The test
  bound for this moved from 40 to 60.

**Visual check** (headless dev server, day, seed 3). Drivers in the session scratchpad: `ped-lineup.js`, an
every-archetype lineup on a crossing with close-ups; `ped-look.js` / `ped-look2.js`, in-world static kinds, rain
and walkers; `ped-walk.js`, a walker frame sequence.
- Confirmed:
  - the heel strike and toe-off with the knee bend;
  - the rail lean with the hands on the bridge rail;
  - the wall lean with one foot back and a closed umbrella in rain;
  - the talk gesture;
  - short sleeves and pleated sailor skirts;
  - separate sneakers.
- Fixed during the check:
  - shoulder "pads", where the sleeve caps rose above the trapezius slope;
  - thigh tops poking through jacket hems;
  - legs pushing through pencil skirts.

**Next / not done.**
- Silhouettes at lod 1 are still visibly polygonal up close: the head has 7 sides and the torso 9. The budget says
  no.
- The lineup check found that meshes added under the city container outside the world pipeline get hidden, most
  likely by the R6.1 chunk LOD. This is expected, but a debug lineup has to add to the scene root.
- There is no real-GPU browser pass yet.

### R6.2 notes — third-person game feel (2026-09-30)
- **Camera-relative movement.** The controller keeps two yaws: `yaw` for the camera / look and `facing` for the
  body. Movement is relative to the camera, and in third-person the body turns toward the move direction
  (exponential, capped at 12 rad/s). Mouse, right stick and Q/E orbit only.
- **Walk / run.** Speed eases in and out. Shift toggles walk/run (walk = 0.43 × the move speed; `sm.getPlayerRunning3D`
  / `onPlayerRunChanged3D`).
- **Gamepad.** Built-in support (`src/game/gamepad-input.ts`).
- **Frame pacing.** Render interpolation between the 60 Hz steps, and look applied per rendered frame.
- **Camera** (`src/game/third-person-camera.ts`): 72° FOV and a shoulder pivot at 0.8·H. The follow distance is
  2.6·H (4.5 m with no avatar). The pivot follow is damped (softer vertically), leashed, and leads with look-ahead.
  A 5-ray sphere cast pulls the camera in instantly and it recovers smoothly; a thin prop one ray grazes is
  ignored. Distance and FOV are persisted settings (`sm.setPlayCameraDistance3D` / `setPlayCameraFov3D`).
- **Animation** (`src/game/locomotion-animator.ts`): an idle / move / jump / fall state machine with inertial
  crossfades and a speed-blended walk ⇄ run with a shared, stride-matched phase. Clips are sampled against the
  REST pose. Root cause of "frozen in the last walking pose": `playSkeletonClipBlended` held the joints the Breathe
  idle doesn't animate at the from-pose. The discrete crossfade path and the 2-clip blend tree for engine-driven
  rigs are replaced. A user humanoid Player gets the default gait as runtime-only clips. The Run has a distinct
  upper body; the legs are unchanged for the R6.3 gate.
- **Ground.** The probe window is now the step height (it was max(step, ½ eye) = 0.8 m). A step up needs headroom,
  a jump never pulls up onto overhead geometry, and walls are cast at knee, mid and head height. These close the
  bench pop-up, the foliage-card / valance cascade and the jump-into-canopy landing.
- **Tests:** controller, collision box world, camera, animator, gamepad, keyboard and play-auto-player integration.
- **Browser-verified** in the seed-3 city (headless): facing tracks movement, orbiting while standing doesn't turn
  the body, and stopping settles to idle within 0.8 s. Shift walks at 1.5 m/s. Running under trees, bridge rails
  and walls never lifts the feet.

### R6.3 notes — skirts and dresses follow the legs (2026-09-30)

**Problem.** Skirts were skinned rigidly to the pelvis. Over the default Walk and Run clips, plus a stride, lunge, stair step, high knee, sit and side step, the thighs went 47–53 mm into the skirt. Knee-length dresses clipped in every walk frame.

**Fix, in two parts:**
1. **Static leg weights** (the standard game technique). Below the waist, each skirt vertex blends from the pelvis onto both thighs, by where it sits around the body and by height. A long hem also takes part of the lower leg's weight, more at the back. This is `clothing-generator.ts` `applySkirtLegWeights`. The fitted skirt is first subdivided along its length so the fade has vertical resolution; the new rings lie on the old surface, so the rest look is unchanged.
2. **Pose-driven steer** (`skirt-steer.ts`). Fixed weights leave the 50/50 centre lines inside the forward thigh during a stride. So each frame one signal, the difference in forward pitch between the two thighs, shifts the front panel's weights toward the forward thigh and the back panel's toward the trailing one. At symmetric poses the signal is 0 and the weights are exactly the static ones. The weights are rewritten only when the signal moves by 0.04. `Scene3DCharacter` runs it as a pre-render callback, which measured ~0 ms.

**What was rejected, and why:**
- **Spring or cone skirt bones (VRM).** These need new joints in the skeleton. They would share the hair and charm joint truncate/rebuild path and add persistence risk, and fabric sway wasn't the problem.
- **Capsule push-out in the skinning shader.** This means per-mesh capsule data plus the same change in every skinned pass (main, shadow, prepass, highlight) and in the CPU mirrors.
- **The existing GPU cloth sim.** It is for standalone banner/cloth meshes and far too heavy for this.

**Measured** (`src/services/managers/skirt-leg-follow.test.ts`; depth into leg capsules fitted to the body's own skin, over vertices and triangle centroids; new character):
- Skirt 53 → 0 mm.
- Mini skirt 47 → 0 mm.
- Knee dress 51 → 0 mm.
- Ankle dress 51 → 23 mm. The residual is only while running: the swinging calf is folded back under the hem at the thighs' crossing.
- Saved-character skinning (linear): the knee dress still clips 17 mm running; walking is clean.
- Clothing ROM gate, Skirt: poke 8% / 21 mm → 2.6% / 4.8 mm. The row was tightened.

**Costs:**
- Up to 10–15% of a long dress's triangles stretch past 2× in a stride. The fabric between a forward and a trailing leg has to stretch.
- Folding stays ≤ 1.3%.

**Compatibility:**
- Rest shape unchanged (a test checks it).
- `legFollow: 0` on the bottom params gives the old rigid skirt, bit-identical.
- Saved skirts get the new behaviour, because garments regenerate from params on load. Only their animated deformation changes.

**Browser check** (headless Chrome with WebGPU, Play mode with the auto default player in a knee-length skirt, walking and running side-on to the camera):
- **Rigid skirt:** the forward thigh shows through the front of the skirt.
- **Leg-follow:** the skirt drapes over the leading leg, with no poke-through.
- **Steer signal:** swept −1…1 during walk and run, and held at 0 when idle.
- **Unrelated finding:** a pale triangular web between the shins is drawn by the BODY mesh itself (it stays with every garment hidden). It is not from the skirt; not investigated here.

### R6.1 notes — skinned culling + camera-aware distance LOD (2026-09-30)

**1. Skinned meshes are frustum-culled** (`Renderer3D.drawSkinnedMeshes` → `_cullSkinned`, bounds in
`src/renderer/3d/skinned-cull.ts`).
- **Bounds that hold in any pose.** A skinned vertex is a weighted blend of `S_i · v` (S = the joint's skin matrix).
  Each term lies within `scale_i · r_i` of the joint's current position, where `r_i` is the largest bind-space
  distance from joint i to a vertex it influences. So the union of those joint spheres bounds the mesh in every
  pose. The radii are computed once per skin change. The joint spheres are computed once per skeleton per pose and
  shared by the body, clothes and hair. Each part's box is then a min/max over only the joints that part uses, plus
  a 6 % pad (dual-quat skinning, and the one-frame lag of the shadow replay). A NaN joint (for example a spring
  blow-up) is ignored. Weight-paint previews are never culled.
- **What a culled part skips.** The main-pass draw, the outline, the instance slot and the skin-matrix upload. A
  culled skeleton keeps its dirty flag, so it uploads the frame it comes back.
- **Shadows.** A part that is off screen still casts if its shadow can reach the view (`shadowReachesView`, the
  Round 5 test). When a planar mirror is live, every part is kept for the mirror. A change in the caster set marks a
  throttled shadow map stale, the same way a roster change does.
- **The idle animation pauses for culled characters.** `isSkeletonAnimCulled3D` is true when every part of a
  skeleton is outside the view plus a margin of half its size, and none of its parts casts into the view. The
  procedural idle (and the idle breaks) skips those characters. The idle is driven by absolute time, so it picks up
  at the right phase. The margin means a character walking or turning into view is already up to date: no
  stale-pose pop at the screen edge.
- **The Play player and selected characters** are culled only by these conservative bounds, so they are never
  wrongly dropped. Their shadow survives while the camera looks away.
- **Toggles for A/B tests:** `sm.renderer3D.skinnedCulling = false` and `sm.renderer3D.skinnedAnimCulling = false`.
- **Stats:** `getFrameStats3D()` (and `salsaWorld.frameStats()`) gained `skinnedMeshes`, `skinnedDrawn`,
  `skinnedCulled`, `skinnedShadow`, `skinUploads`, `skelAnimCulled`, `skinnedTris` and `msSkinned`.

**Measured.** Synthetic crowd of N `createRandomCharacter3D` characters (7 parts each) on a ground box, all idling,
with 2048 shadows. Headless Chrome on d3d11, 1300×850. The same build was measured with culling off and on,
interleaved 3×, minimum shown. `cpu` is the `render()` call; `sync` is render plus GPU wait.

| N = 300 view | parts drawn | skin uploads | CPU ms off → on | sync ms off → on | idle ms off → on |
|---|---|---|---|---|---|
| overview (all in view) | 2100 → 2100 | 300 → 300 | 12.1 → 13.0 | 36.7 → 40.7 (noise) | 2.6 → 2.6 |
| edge of the crowd | 2100 → 1511 | 300 → 230 | 12.4 → 9.6 | 38.3 → 28.6 | 2.9 → 2.2 |
| inside the crowd | 2100 → 458 | 300 → 87 | 13.3 → 4.3 | 39.7 → 8.9 | 2.9 → 0.9 |
| looking away | 2100 → 0 | 300 → 0 | 12.5 → 1.1 | 38.4 → 4.0 | 2.7 → 0.02 |

- The cull costs about 0.46 ms per frame for 300 animated characters (2100 parts, microbenchmark), and 0.24 ms when
  the poses are static. That is the overview's +0.9 ms, where nothing can be culled.
- The pre-change build (a separate run) was flat at 10.7–11.3 ms CPU and about 33 ms sync for N = 300 in every view,
  looking away included. For N = 100 it was 3.1–3.5 ms CPU.
- **Pixel A/B**, frozen poses, 15 cameras (12 yaw steps inside the crowd, the edge, low, top), culling on vs off:
  every pair is byte-identical, shadows included.
- Play mode, third person, player among 40 idling characters: looking away drew 7 parts (the player), culled 280,
  and paused the idle on 34 skeletons. The player was drawn in every frame.

**2. Distance LOD per chunk, camera-aware** (`Mesh3D.drawDistance` / `lodHidden`, `src/renderer/3d/distance-lod.ts`,
`WorldManager.cityDistanceTiers`, `view-cull.ts assignDrawDistances`).
- **How it works.** The city stamps a `drawDistance` on every mesh in the zoom tiers' membership. The stamp walk runs
  only when the scene epoch or the thresholds change. The renderer then drops a mesh (or an array group) in every
  pass once the camera is farther than that from the mesh's own world box. The distance is measured to the box's
  nearest point, so a chunk you stand in is at 0. The test sits inside the existing cull loop, where the box is
  already computed, and allocates nothing.
- **Hysteresis:** a mesh hides past the distance and shows again only inside 0.9 × the distance. No fade: a cheap
  per-instance fade would need a shader path, and the cut happens where features are about 2–3 px.
- **Distances.**
  - DETAIL (plus the sign lettering) = 0.6 × the Tier-1 zoom threshold (2.8 R).
  - ROOF = 1.25 × DETAIL.
  - PROPS = 1.2 × 2.8 R, and FLATMAP = 1.4 × 2.8 R: the zoom numbers, because 6 m trees and cars read from farther
    away.
  - STRUCTURE and everything untiered (roads, bodies, the lit signs and lamps) never distance-hide.
- **Camera-aware.**
  - The renderer scales the distances by the lens (`fovDistanceScale`: 1 at 45°, about 0.54 at a 75° Play camera).
  - The city adds a bias equal to the camera's distance to the city volume. That is 0 at street level. Seen from
    above, it grows with height, so an aerial overview keeps its detail, as the L5 look requires, and the zoom tiers
    still own the overview. The bias is pushed only when it moves by more than 2 % of R.
  - Ortho cameras skip the distance test (their zoom is `orthoSize`, not distance).
- **Toggles:**
  - `salsaWorld.distanceLod(false)`, or `salsaWorld.distanceLod(true, mul)` to scale every distance.
  - `sm.renderer3D.distanceLod = false` (renderer master switch) and `sm.renderer3D.distanceLodScale`.
  - `sm.scene3d.setDistanceLod3D({ bias, enabled, scale })`.
- **Stats:** `lodHidden` (meshes and groups beyond their distance) and `lodTrisHidden`.

**Measured (distance LOD on vs off, same session, traffic off).**
- **Default diorama (seed 3, R ≈ 16 units):** nothing is hidden in any of the 10 standard views, so the picture is
  unchanged. The chunk cells are large and the city is small, so at street level every tiered chunk's nearest point
  is within about 15 units. An earlier variant without the height bias hid fine detail across the whole frame-all
  overview. That cut 18 % of the triangles, but the facades visibly lost texture, so it was rejected.
- **Tiled 5×5 full world** (`tiles(2, "full")`):
  - Street level: main-pass tris down 15–19 % (for example 18.1 M → 14.7 M) and draw calls down 15–20 %. All 8
    street screenshots are pixel-identical (max diff 1).
  - Hero view: tris 28.1 M → 24.5 M (−13 %), draw calls 8855 → 7797. The only visible differences are at the
    horizon and on animated water.
  - Editor free3D, low over the world: tris 18.6 M → 16.0 M.
  - Editor free3D, far fly-out: tris 59.7 M → 29.5 M and draw calls 28.6 k → 17.1 k. The far half of the world
    reads slightly flatter.
  - Play mode, third person with a 72° FOV: tris 20.9 M → 10.3 M and 26.6 M → 14.1 M.

**3. The old zoom LOD tiers still exist and still help.**
- **What they are.** WorldManager `_lodCb`, `_tier()`, and DETAIL / ROOF / PROPS / FLATMAP / STRUCTURE.
- **What they do now.** Each tier is one GLOBAL switch. It flips `visible` on every matching layer when the metric
  crosses its threshold, with 10 % hysteresis. The metric is:
  - `orthoSize` under ortho;
  - otherwise `min(orbit radius, 2 × camera distance to the city volume)` (T7.5).
- **At street level and in Play** the metric collapses to about 0, so every tier is shown. The zoom tiers never hide
  anything down a street, and in a tiled world they never hide the far tiles either. That gap is what the per-chunk
  distance LOD fills.
- **Zoomed out** (overview, ortho, extreme pull-back) they remain the only thing that clears whole tiers at once: the
  props at 1.2 × 2.8 R, flat-map fine layers at 1.4 ×, and structure-only at 1.7 ×. Tiled worlds also use their
  state for build-level detail.
- The two combine. A tier hidden by zoom stays hidden. When it is shown, the per-chunk distance can still drop far
  chunks.

**Limits / next.**
- Many PROPS array layers (trees per species/variant, vending stock) have too few instances to chunk (fewer than 4
  per cell). They stay city-wide boxes at distance 0, so neither frustum nor distance culling can drop them. A
  per-instance distance cull for array groups would need instance compaction.
  - **Partly fixed in performance-plan P7.2 (2026-10-01):** instances with ≥ 300 triangles (tree leaves, vending
    cans) may now sit alone in a cell. A tree variant went from 1–2 groups to 5–6; vending cans from 16 to 38 groups.
    P7.1 also gave the sub-metre families their own distances without the aerial bias (the sky band drew more than
    street level).
- The draw distances do not scale with canvas resolution.

**Browser check still needed:** a real GPU (not headless). Walk a skinned crowd in Play at the screen edges and whip
the mouse to look for one-frame pose pops. Also watch a 5×5 tiled world at street level while driving the camera
down a long avenue, looking for LOD pops at the 0.9–1.0 band.

### R6.5 notes — the shin web was a cross-leg WELD (2026-09-30)
**Cause.** `weldAccum` (`body-generator.ts`) welds verts that share a position, rounded to 1e-4. The two legs are exact
mirrors, and the inner calf rings reach the midline. For some param values a mirrored L/R calf-ring pair both land
within the eps of x = 0, so the weld merged them into one vertex. The right calf/knee band's 6 triangles then
referenced a vertex skinned to `lowerleg_L`. At rest that changes nothing, because the verts were coincident. Once the
legs separate (Walk/Run), those faces stretch across to the other shin: the web. It showed at hipFront ≈ 0.636–0.660,
which includes the auto Play character (seed 20260930, hipFront 0.652). It also showed at other values, such as 0.532,
and hipFront 1.02 with hipWidth 1.3. None of the sculpt, stitch, or clamp code was involved.

**Fix.** The weld key now includes the vert's side (L, R or centre, from its `j0` joint), so a left vert never welds
to a right one. A sweep over 1,267 bodies (hipFront 0.30–1.20 × 7 param combos) found that this cross-side merge was
the ONLY weld that ever fired, so it is the only thing that changes. The default body and sampled healthy params are
bit-identical before and after: positions, indices, weights and `legSurface` all match. Bodies in a bad band get their
missing vertex back (2927 → 2928).

**Guard.** `body-leg-topology.test.ts`. Across a fine hipFront sweep × 10 other params, the randomizer range and
randomizer seeds, it checks that:
- vertex and triangle counts are param-independent, and the triangle set matches the default body's;
- no triangle joins the two lower legs;
- no lowerleg-bound vert sits above the knee band;
- in a scissored-stride LBS pose, no lower-leg edge stretches.

It fails on the old weld and passes on the fixed one.

## Round 7

### Window interior mapping — parallax direction + magnitude (mesh3d-shaders.ts, 2026-09-30)

Report: "very dramatic perspective shift" in the rooms behind windows, possibly the reverse of real life.

**What was wrong (both):**
- **Direction — MIRRORED horizontally on every wallsWin face** (all four orientations, not just some). The shader's
  frame was `T = cross(up, N)`, but wallsWin puts `u` along the edge direction `d = cross(N, up) = -T` (u runs to
  the viewer's LEFT). The box's ray origin used `winUV.x` (+u) while the ray used `-dot(V, T)` (-u), so the room slid
  the same way the camera moved — strafing right revealed the RIGHT side wall. Vertical was correct (`B = up`).
- **Magnitude / proportions.** The box was the window OPENING in unitless "half-window" units: a square 2x2 box
  whatever the window's real aspect (portrait masonry windows, wide shop bays), side walls right at the jambs, and a
  depth of ~0.65–1.35 window widths — a narrow shoebox whose side walls swept across the glass for small head moves.

**Fix:**
- Frame from the **uv derivatives** (`uvWorldAxes`, computed at fragment top level for uniform control flow): box +x
  = the way u grows, +y = the way v grows, on any face / winding / uv layout; the room is always behind the glass as
  seen by the camera (`Nf`). Directions within ~25 deg of the analytic facade frame snap to it (only the derivative's
  SIGN is kept); rotated / sheared uv keeps the raw axis (solved on the axes' Gram matrix).
- **Metric room** (`roomTrace`): the box spans the whole CELL (one storey tall, one bay wide; curtain + ribbon floors
  are open plan, 3 bays wide) with depth in storeys — homes 1.1–1.7 (~3.4–5.3 m), offices 1.4–2.3, shops 1.6–2.8
  bay-heights — and the ray in the same metric, so parallax equals a real room behind real glass. Furniture bands /
  TV / monitors / ceiling fixtures re-placed for the storey-tall box.
- **Noise guard.** Facade u runs into the thousands (per-building 128-cell bands), so up close the f32 derivative
  LENGTHS are noise — a per-pixel aspect speckled every side wall (seen in the first browser pass). `uvWorldAxes`
  returns a noise estimate; the cell aspect eases to a nominal 0.85 (2.6 m bay / 3.1 m storey) when it is high, and
  past 30% the frame falls back to the wallsWin convention outright.

**Verification:** `src/renderer/3d/interior-mapping.test.ts` — a CPU mirror of the frame + `roomTrace` against a
ground-truth world-space ray trace into a real box behind a real facade built by `Accum3D.wallsWin` (faces ±X/±Z,
single-bay + open-plan, cameras left/right/above/below/diagonal): world hit within 1e-3 and the same room face; plus
flipped-u / flipped-v / sheared-uv / flipped-normal quads, a strafe-right-sees-LEFT-wall check (exact and noisy
derivatives), a test pinning the old frame as mirrored, and a WGSL source lock. Browser (headless, seed 3, street
level, 5-frame strafes at night + noon): with a temporary colour-coded debug (left wall red / right green / back
blue) every window left of the camera shows its left wall and right of it its right wall, shifting correctly as the
camera strafes; shop bays now read as deep rooms whose far wall moves less than the frame.

### Live crowd — the static pedestrians idle near the camera (crowd-live.ts, world-live-crowd.ts, 2026-09-30)

Report: "static pedestrians should still be animated/moving to some extent so they look alive — they are just frozen
in place right now." The standing crowd (~770 people at default density, ~540 tris each) is MERGED per colour into
`world:ped-*` / `world:ped-deck-*` layers (then spatially chunked), so no individual can move.

**Design — near-field PROMOTION with an in-place index lift.** The N people nearest the camera (default 40, inside
30 m, kept until 38 m — hysteresis; in-view first, nearest first) are lifted out of the merged layers and redrawn by
small per-body-part LIVE meshes that idle; everyone else stays merged and still.
- *Hiding one person inside a merged mesh:* the builder records, per crowd layer, the index sub-range of every
  (person, body part) (`geometry.crowd`: `emitPerson` calls `sink.mark(part)` at each part boundary). Hiding =
  degenerate that range IN PLACE (every index := the first → zero-area triangles) and re-send just those bytes with
  the new `Renderer3D.patchMeshIndices` (a `writeBuffer` of a few KB into the pooled IB; `gpuDirty` would have been a
  whole-pool rebuild). Restoring copies the backup back the same way. The CPU indices are the truth, so a pool
  compaction / re-append / a retired-and-revived tile stays consistent. Rejected: rebuilding the chunk (ms per swap);
  per-cell wholesale swaps (a cell holds tens of people → hundreds of live meshes, or thousands of extra static draws
  for small cells); instancing per (archetype, pose, colour) (every person is a unique look → ~no sharing).
- *The live meshes are built from EXACTLY those triangles* (the final draped / warped / chunked render-space
  vertices, rebased into a rig frame) with the SAME names and a copy of the source material (kept in sync every scan
  → day/night glow, render style, weather follow). So the swap is invisible by construction: same vertices, normals,
  colours, flat PED_SHADE look, umbrellas. Chunking is person-aware (a person's triangles all go to the cell of their
  first triangle, ranges remapped) so nobody straddles two cells. Works for the centre (main-thread or worker build)
  and streamed tiles (the build → render offset comes from a recorded reference vertex per range).
- *Rig:* LOWER (standing leg / both legs, never moves), LEAD (the relaxed leg — shuffles on a weight shift), UPPER
  (torso, skirt, collars, bag, umbrella, non-animatable arms — rolls / pitches / twists about the hip, breathes),
  HEAD (neck + head + hair + hat, about the neck base), ARM L / ARM R (only when the hold can move on its own: free /
  phone / talk / pocket / lap; hands on a rail / strap / bag / umbrella / clasped stay in UPPER). ~9–13 meshes a
  person. Posed with `setPoseXYZYaw(x, y, z, ry, rz, rx)` (new optional `rx` → one matrix rebuild for Y·X·Z).
- *Idle behaviours* (`evalIdle`, a pure function of person + time — deterministic, desynchronised by a per-person
  hash, no state): breathing; weight shifts foot to foot every 5–9 s (upper roll + hip shift + the relaxed leg
  shuffling during the shift) and an occasional slow shoulder half-turn; looking around (smooth random "hold"
  targets); phone readers scroll (arm bob) and now and then look up and glance about; CONVERSATION GROUPS (ring id
  recorded by staticCrowd) pass a speaker slot round every 3–5 s — the speaker gestures (talk arm) and nods, the
  listeners turn their heads (and a little of their shoulders) toward the speaker, glance at another member, nod
  along; roles cross-fade (no head snaps); seated people lean forward / sit back and twist; leaners and rail-watchers
  settle and look about. Everything is multiplied by an ENVELOPE that ramps 0 → 1 over 1.4 s after promotion and
  back to 0 before the swap back — at 0 the live pose IS the static pose. Promotions / demotions out of view (1.3×
  NDC margin, so an edge shadow still ramps) skip the ramp.
- *Scheduling:* the throttled scan (every 180 ms, ≤ 6 promotions per scan) runs in the world LOD pre-render callback;
  the per-frame pose in the shared world ticker (kept alive while anyone is live). Off-screen live people re-pose on
  a 1-in-8 staggered cadence (the walker pose-gate rule). Node adds / removes are QUIET — new
  `Scene3DManager.notifySceneStructureChanged3D` (mesh-list version bump + `WebGPURenderer.markStructureDirty`)
  instead of the host-facing onSceneGraphChanged (the outliner / connector walks), since promotion churns a few
  times a second while you walk.
- *Far field:* no motion (accepted). A merged-layer sway would need a vertex-animation family — all 32 material flag
  bits are taken and the ONE-FAMILY-PER-MESH rule (city-materials.test.ts) forbids stacking one on the crowd layers.

**API:** `salsaWorld.liveCrowd(on = true, { count, radiusIn, radiusOut, ramp })` (metres / s); `salsaWorld.liveCrowdStats(reset?)`
→ `{ live, candidates, meshes, updateMs, updateAvgMs, updateMaxMs, scanMs, scanMaxMs, promotions, demotions, indexed }`.

**Perf (headless Chrome, seed 3, default density, street level, vsync 16.7 ms throughout):** 12–34 people live →
150–395 live meshes, +40–220 draw calls after frustum culling (~1.6–1.9k total); idle update 0.05–0.09 ms / frame
(max 0.2–0.3); a promotion scan ≤ 0.6 ms (≈ 5 ms once, the first scan after a build, which also indexes the ~740
people); renderer CPU within noise (3.2–3.8 ms on vs 3.2–4.0 off). Aerial / hero view: 0 live. The per-frame idle
path is allocation-free (V8 boxes doubles across non-inlined calls, so the helpers pass Smis + a scratch array —
verified: 120k person-updates, 0 scavenges).

**Verification:** `src/world/crowd-live.test.ts` (14): ranges tile every crowd layer exactly + one contiguous run
per person; pivots / holds / groups recorded, deterministic per seed; chunked layers keep whole people with the
identical triangles; the rig at envelope 0 lands every lifted vertex on its static vertex (< 2e-6 units); idle
channels exactly 0 at envelope 0, deterministic, desynchronised, smooth (< 0.04 per 60 Hz frame, incl. group
cross-fades); selection hysteresis + budget + in-view priority; degenerate / restore round trip; no GC scavenge in
the per-frame update. Browser (headless dev server, drivers `ped-live*.js` in the session scratchpad): in-app t0
check — live mesh world vertices vs the hidden static triangles, centre 0.0034 mm / streamed tile 0.014 mm worst;
PROMOTION BOUNDARY with a fixed camera (crowd forced static → re-enabled with the envelope held at 0, 12 in-view people
promoted, all parts drawn): 0 of 528k pixels differ; after the ramp ~8k pixels move; DEMOTION back to static: 0 pixels
differ; conversation-group frame strips + a motion heat-map show every member moving (heads, shoulders, sway).


## Round 8

### Third-person movement: walk / run / sneak, jump feel, editor suspended during Play (2026-09-30)

Report: "when I move in play mode in 3rd person it feels cumbersome. Upgrade the default movement (which I think is run)
to be the new walk and pressing shift will toggle a true run that is faster. Make sure the animations are polished …
make jumping feel nicer, it feels really weak and heavy and I don't think there is an animation. Pressing ctrl should
trigger a sneak. Make sure all editor hotkeys are disabled during play mode. … anything that would improve play mode
performance."

**1. Gaits** (`character-controller.ts`, `play-settings.ts`):
- **Walk is the Play default:** 1.6 m/s (`walkSpeed`). **Shift toggles a true run:** 5.2 m/s (`moveSpeed`).
  **Ctrl held, or C / gamepad B toggled, = sneak:** 1.0 m/s (`sneakSpeed`); sneak wins over run. An analog stick scales
  the active gait. The pure controller still defaults to `running = true` (full input = `moveSpeed`, as before), so
  hosts constructing it directly are unchanged; the Play loop starts walking.
- **Settings.** `setPlayerMoveSpeed3D` is now the RUN speed, default 5.2 (was 3.5 with full input running by default).
  Old saves store only a non-default value, and it always meant "full-input run speed", so it loads unchanged.
  `setPlayerWalkSpeed3D` / `play.walkSpeed` (default 1.6, never above the run speed) is new. `walkSpeedFactor` is legacy
  (0 = use `walkSpeed`).
- **Keyboard** (`keyboard-input.ts` `{ sneakKeys: true }`, Play only). The Ctrl key itself is captured. W/A/S/D, the
  arrows, Space and Shift still move while Ctrl is held, and their browser action is suppressed; every other Ctrl chord
  (Ctrl+Z, Ctrl+C, Ctrl+F) is ignored as before. The fly camera keeps the old guard. **Caveat:** windowed Chrome reserves
  Ctrl+W (close tab). The engine requests Keyboard Lock on Play enter (effective in fullscreen); C toggles sneak as the
  safe alternative.

**2. Clips** (`default-locomotion.ts`, rewritten):
- **A gait MODEL instead of hand-keyed angles:**
  - Per leg: stance with a planted ankle rolling heel → flat → toe (heel rocker, ball rocker), then a Hermite swing arc
    between footprints.
  - The pelvis sits at the height the stance legs allow (legK, a mid-stance flex), smoothed. The bob falls out of the
    geometry: ~5 cm for the walk, compression plus a flight rise for the run.
  - 2-bone IK per leg: the knee aims toward the toes, and reach is clamped so a knee can't lock or hyper-extend.
  - The foot's world pitch is authored, and the pelvis twist / roll / sway never twist a planted foot.
  - Upper body: arms counter-swing with a small lag, chest counter-rotation, lean, a head stabilised against the lean
    and twist.
- **Clips:**
  - **Walk** (1.6 m/s, 124 steps/min, duty 0.58).
  - **Run** (4.6 m/s nominal, duty 0.28 = two flight phases, heel kick ~110°, 13° lean, pumping arms).
  - **Sneak** (0.9 m/s, crouched ~14 cm, duty 0.66, arms forward).
  - **Crouch** (sneak idle, breathing / glancing).
  - **Jump** (the air pose sampled by AIR PHASE: take-off extension → tuck at the apex → legs reaching for the ground).
  - **Fall** (long-fall loop).
  - **Land** (an ADDITIVE squash: a 70 ms dip then recovery, 0.42 s).
- Each gait records `groundSpeed` (new optional `SkeletonAnimClip.groundSpeed`), so the animator plays it planted at
  any speed and scale.
- **Tuning against the skirt gate.** The first run heel kick (knee 124°) folded the calf into the knee dress (28 mm);
  lift 0.28 → knee ≤ 109° passes the R6.3 gate, which now also samples Sneak / Crouch / Jump / Fall / Land.

**3. Animator** (`locomotion-animator.ts`):
- **Blends:** a crouch mix (sneak ⇄ stand, eased), stride matching by distance per cycle from the clips' ground
  speeds, and one shared gait phase across walk / run / sneak. A move from a stand starts on the first step.
- **Air:** jump by air phase; the fall loop only after 1 s airborne; no air-pose flicker on a walk off a curb (air delay
  0.12 s unless jumped).
- **Landing:** the additive Land layer, weighted by the impact and lighter while moving.
- **Procedural lean** (`LocomotionLean`): lean into forward acceleration (≤ 8°), roll into turns (≤ 9°, scaled by
  speed), the head (and 40 % of it, the chest) leading turns. It is applied on the engine's own humanoid rigs (auto
  player / default gait). The host (`_driveLocomotionAnimator`) now passes REAL world speeds; the old "re-express at
  3.5 m/s" is kept only for a host-owned discrete handler (re-mapped so walk → 1.5, run → 3.5).

**4. Feel** (controller + camera):
- **Velocity is a vector** that approaches the target with max(exponential 10/12 per s, a linear floor of 20/24 m/s²).
  Measured in the browser (seed-3 city): 90 % of walk speed in 49–65 ms, 90 % of run speed in 167 ms, a stop from a run
  in 149–162 ms. A reversal passes through zero instead of snapping round.
- Turn 16/s capped at 15 rad/s (half in the air). Air control: 35 % linear only; releasing the stick keeps momentum.
- **Jump:**
  - Edge-triggered, with a 0.12 s BUFFER and 0.1 s COYOTE time.
  - Variable height: release while rising → gravity × 2.6.
  - Gravity 20 m/s² rising, × 1.6 falling, × 0.55 hang near the apex while held; falls capped at 30 m/s; `landImpact`
    is reported for the landing animation.
  - Measured: **held 1.03 m, tap 0.38–0.44 m, 0.66 s in the air** (was 0.84 m / 0.75 s, symmetric and floaty).
  - All metres convert with the city scale (`_playScaleConfig`).
- **Camera:** follow 12/s and vertical 8/s (was 10 / 5). While airborne only 35 % of a rise above the take-off height is
  followed (a drop below it is followed fully). Look-ahead 0.22 s, lead smoothing 4/s.

**5. Editor suspended during Play** (new `InteractionService.playActive`, `Scene3DArmatureHost.isPlaying`,
`TransformControllerCallbacks.isInputSuppressed`), set on enter and restored on Stop:
- **Keys:** `RasterInteractionController.handleKeyDown` returns after the UI hook (no Ctrl+Z / Ctrl+Y / Ctrl+D / G / U /
  Delete). `undo3D` / `redo3D` return false. `beginTransform3D` / `constrainAxis3D` / `appendNumericInput` /
  `commitTransform3D` are inert.
- **Pointer:** no 2D pointer-down / move / up / wheel work, no 3D hover pick, no joint pick, no click-select and no
  gizmo drag. Browser check: a click during Play left a 7-mesh selection untouched.
- **Overlays and callbacks:** `draw3DOverlays` skips the frustum / emitter icons / selection gizmo / bone overlay /
  mesh-edit / snap viz. The `transformGizmoSync` and `cameraFrustum` callbacks skip. The hover is cleared on enter.
- `sm.isPlaying3D` is confirmed public (ShapeManager + Scene3DManager).

**6. Perf** (headless Chrome, d3d11; A/B = the suspension forced off vs on, same session, 2–3 interleaved reps):
- **Seed-3 city, third-person Play:**
  - Pointer + mouse move handlers 0.016–0.027 → 0.013–0.017 ms/event.
  - `render()` CPU 4.2–4.7 ms either way (noise).
  - The city already suppressed the hover outline, and at ~2k draw calls the renderer, not the editor, is the cost.
- **10-character scene with a selection:**
  - Move handlers 0.020–0.038 → 0.014–0.016 ms/event.
  - `render()` CPU 0.29–0.55 → 0.29–0.48 ms.
- The measurable CPU win is small. The real wins are functional: no mid-Play selection or gizmo drags, no S-scale, no
  hover outline pass, no selection-gizmo draw, no per-move raycast.
- **Remaining ideas (not done):**
  - Pause the procedural idle / spring solve for off-screen NPCs by distance, not only by frustum.
  - Freeze `characterSkeletonSync` (0.06–0.18 ms) while the structure version is unchanged.
  - Suspend the autosave timer's dirty scan (it is already skipped while playing).
  - Skip the outliner / scene-graph change emits for runtime nodes.
  - A lower shadow-map refresh cadence while the camera is only orbiting.
  - Throttle the 2D render strategy when the 3D scene covers the canvas.

**Verification:**
- **Unit tests:**
  - `character-controller.test.ts` +9: gaits, accel timing, reversal, jump height held / tap / non-variable, apex hang
    and snappier fall, no bunny-hop + buffer, coyote, air control + land impact, fall cap + air phase.
  - `locomotion-animator.test.ts` +4: crouch mix, clip-speed stride matching, jump by air phase / fall / curb, additive
    land.
  - `keyboard-input.test.ts` +1: sneak keys and Ctrl chords.
  - `third-person-camera.test.ts` +1: jump follow.
  - `default-locomotion.test.ts` (rewritten): clip set, loops, no skating (< 6 mm / frame) or sinking, duty / flight /
    double support, knee range, bob, Land / Jump shape.
  - `default-locomotion-pose.test.ts` (new): no limb through the body in any frame of any clip on the real body (0 mm).
  - `play-auto-player.test.ts` updated, +2: walk default, run toggle, city-scale gait speeds, walk-speed setting,
    sneak / jump / land on the auto player.
  - The skirt gate (all clips), `body-leg-topology`, `collision-math` (unchanged).
- **Browser** (`scratchpad/pupdrive/drive-r8.js`, `drive-r8-perf.js`, seed-3 city, the auto player; frame strips in
  `pupdrive/r8/sheet-*.png`):
  - Walk 1.60 m/s, run 5.20 m/s (runMix 1), stop in 149–162 ms, accel lean 6.9° → −6.5° when braking.
  - Ctrl hold → sneak (crouch 0.98), Ctrl up → walk; the sneak toggle at 1.00 m/s (0.60 in a run that slid along a
    shopfront); C toggles it off.
  - Jump held 1.03 m in 0.66–0.67 s (idle > jump, then the landing squash at weight 1.0), tap 0.38–0.44 m, running jump
    1.03 m (move > jump). With the fall loop at 0.55 s a normal jump ended in the Fall pose; it is now 1 s.
  - Delete / Ctrl+Z / Ctrl+D / G / `undo3D` / `beginTransform3D('scale')` during Play changed nothing.
  - Stop restores `playActive` false.

**Still to check on a real GPU and display:** the gait / jump feel at 144 Hz with a real keyboard. Also Ctrl+W
behaviour in windowed vs fullscreen Chrome. Puppeteer's CDP key events bypass browser accelerators, so the headless
run can't show whether the tab closes.

### Pedestrians: HIGH-detail mannequins, near / far twins, and a crowd Style (mannequin.ts, pedestrians.ts, 2026-09-30)

Report: "pedestrians still look kinda bad... upgrade them (dont worry about the triangle budget…) and add an option to
set their Style."

**1. Fidelity** (`mannequin.ts`). Two detail levels share one set of profiles (`Detail` / `detailFor(lod)`): **lod 0 =
HIGH** (walkers, the static crowd's NEAR twin, and so the live rigs) and **lod 1 = FAR** (the static crowd's far twin).
- **New primitives.** `smoothRings` Hermite-resamples a loft profile by height (original rings kept exactly).
  `gridSurface` gives smooth NUMERIC normals to any section. Lofts get superellipse `sq` + front / back bulges `fb` /
  `bb`, and hem turn-backs (`lipBot` / `lipTop`). Sweeps get Catmull-Rom path subdivision, a flat lower half (`down`)
  and cuff lips (`lipB`). `box` can bevel.
- **Body.** The torso has 11 profile rings (hem, hips, belly, waist, ribs, chest / bust, armpits, squared shoulders,
  trapezius, neck), 14 sides, resampled. The 9-ring egg head has a narrow chin, a jaw that pulls in under the ears and
  a fuller skull back; ears show with short cuts, buns and ponytails. Sleeves have a shoulder cap, a soft elbow and a
  turned cuff. Bare forearms swell below the elbow. Hands are a palm, a curled finger blade (rolled into a grip when
  holding something) and a two-joint thumb. Legs have a full thigh, a narrow knee, a calf that bulges at the back and a
  slim ankle, with domed knee ends on walkers so a bent knee never gaps. Trousers break over the shoe with a turned
  hem. Shoes have a 6-point flat-soled last with toe spring.
- **Clothes.** Skirts have a hem lip + waistband lip; school pleats (24 sides) fade out by the hip, and flares get soft
  folds. A top worn with a skirt is TUCKED IN (its hem sits inside the waistband; it used to cross it and z-fight into a
  saw edge). Suits and coats get notched LAPELS. Shirts get collar points and a tie knot. Chest panels are resampled
  every 2 cm and hug the real (superellipse + bulge) surface, so a bust no longer pokes through the shirt V. Backpacks
  have shoulder straps; the shoulder bag is a D-section.
- **Hair.** 20 × 6 shell with numeric normals, a side PART groove, piecey bangs, a turned-in edge, short cuts that
  clear the ears, front locks on long hair, and a smoother ponytail and bun.
- **Tris** (13 archetypes × 6 seeds, 'rest'). **HIGH ≈ 2.5k** avg (≤ 3.1k worst). **FAR ≈ 0.84k**. **Walkers ≈ 2.6k**
  (was ~550 static / ~700 walker). Build cost: ~0.55 ms per HIGH person and ~0.2 ms per far one. `buildPedestrians` on
  the seed-3 city is ~0.6 s; it runs in the centre-build worker, but a selective 'World Pedestrians' rebuild (weather /
  pedestrians toggles) now costs that on the main thread.

**2. Near / far twins** (`pedestrians.ts` `PED_NEAR_M = 30`, `PED_TWIN_CELL_M = 110`; the E2 `nearTwin` mechanism).
- Every static person is baked twice (same names, same colours, same pivots). `nearTwin: { key: 'crowd' | 'crowd-deck',
  role, dist, cell }`, where `cell` is a new optional grid size on `nearTwin`.
- `chunkCityLayers` puts each PERSON in the cell of their render-space anchor (memoised per person), so both twins of a
  person land in the same cell. Each cell's CrowdMeta is remapped as before.
- The live crowd (`world-live-crowd.ts`) builds its rigs from the NEAR ranges only. It also hides the person's FAR
  ranges (`src[].far`), so a live person never double-draws whichever twin the renderer picks.
- Ortho / distance-LOD off draw the FAR twins (the E2 rule).
- **Frame stats** (seed 3, default density, 530 people, headless Chrome d3d11 — vsync-bound 16.67 ms throughout):

| view | before: tris visible / draws / render CPU | after |
|---|---|---|
| hero (aerial) | 2.80M / 3915 / 4.9 ms | 3.21M / 4047 / 4.5 ms |
| street 0 | 1.58M / 2508 / 5.0 ms | 1.94M / 2548 / 4.7 ms |
| street 1 | 1.75M / 2366 / 4.6 ms | 2.07M / 2409 / 3.9 ms |

  Crowd meshes 150 → 472; static crowd tris 291k → 1.87M resident (1.41M near + 0.45M far; one twin per cell draws).
  At the finer default twin grid (1.5 × dist) it was 1726 meshes / +950 draws, so the coarse `cell` matters. Live
  crowd update 0.05–0.1 ms; the scan peaks ~6 ms on a promotion burst (bigger part copies).
- **Live swap still invisible:** ped-live POP CHECK A vs B meanAbs 1.52, under the A vs A' noise floor of 2.86;
  leaked 0.

**3. Pedestrian STYLE** (`LayoutParams.pedestrianStyle`: `'flat' | 'default' | 'cel' | 'cel-hd' | 'ink'`, absent =
'flat').
- `world.setPedestrianStyle(s)` / `world.pedestrianStyle` / `updateCity({ pedestrianStyle })` (a new selective
  'crowdStyle' unit); console `salsaWorld.pedestrianStyle(s)`.
- A pure material pass over `world:ped-` / `world:traffic-walker` meshes (`_pedLook` / `_applyPedStyle`):
  - Non-flat values un-dim the build colour (÷ PED_SHADE.diffuse, from a per-mesh WeakMap of the build diffuse, so it
    is idempotent) and set that render style.
  - The GLOW lift is swapped for the ordinary 0.05 / 0.03 baseline (`_pedGlow`).
  - 'flat' restores the build colour + lift and inherits the city's render style.
- The pass runs in the glow walk, after `_applyRenderStyle`'s city style (the crowd's own style wins), and on every
  spawn / regen: `_hasStyle()` is now true for a non-flat crowd style. The marker's `style` field is gated on the city
  style alone.
- Walkers follow through the same pass. The live rigs follow through their existing material mirror (`syncMaterial`).
  Robot walkers keep their colour.
- Saved cities are unchanged (the param is absent → 'flat'). Persisted with the params.

**4. Walk.** `world-traffic.ts` `_place`: a ~1 cm lateral HIP SWAY per step. The whole walker moves, so no joint
drifts.

**Tests:** `mannequin.test.ts` (new budgets: HIGH ≤ 3.4k worst / 1.8–2.8k avg, FAR ≤ 1.1k, walkers ≤ 3.4k),
`street-slots.test.ts` (twins present + paired), `route-sim.test.ts` (walker 1.8–3.4k), `crowd-live.test.ts` (twin-aware
keys, both twins of a person in one cell; timeout 30 s), and the new `world-ped-style.test.ts` (flat default, live
restyle, idempotence, back-to-flat inherits the city style, persistence, selective updateCity).

**Browser checks** (scratchpad `pupdrive/pedup/`):
- `ped-portrait.js`: a lineup sheet of every archetype, front + 3/4, before (the original module) / after, and each
  style.
- `ped-look.js`: in-city static + walker close-ups, flat / cel / ink.
- `ped-walk.js`: walker frames. `ped-live.js`: swap / idle diffs. `ped-stats.js` / `ped-live-perf.js`: numbers.

**Not done / notes:**
- The Frogmarks "Pedestrian style" select is not wired.
- In ortho the crowd always shows the FAR twin.
- `buildPedestrians` is ~4× slower. Main-thread selective rebuilds (weather / pedestrian toggles) hitch ~0.5 s.

### Black sky at altitude — City mode lost its sky backdrop (scene3d-manager.ts `_applyViewState`, 2026-10-01)

**Symptom.** With the camera high above the city (above the clouds, or zoomed far out) the sky rendered black. From
street level it was easy to miss (buildings + haze fill the frame; only the strip above the skyline was black).

**Root cause.** The city's sky is NOT a mesh: it is the screen-space mesh-edit focus background in `gradient` mode, written
by `WorldManager._applyTimeOfDay` (`setMeshEditBgMode3D`), and only rewritten when the time of day / look / preset
changes. `Scene3DManager._applyViewState` (run on every camera-mode / target switch, Play exit, mesh-edit or armature
exit, look-through-camera off, view-state restore) unconditionally reset that same slot to `VIEW_3D_BG` (solid #0D0D0D).
So after any of those while City mode was up, the "sky" stayed near-black until the next time-of-day change. Not the far
plane, fog, autoNear, clouds, LOD or culling: all of those were ruled out (the sky gradient renders correctly at every
altitude, checked out to ~470 km of camera distance, once it is present).

**Fix.** `_applyViewState` no longer writes `VIEW_3D_BG` while `_cityModeActive`, and keeps the focus background active
in the 2D modes too while City mode is up (the illustration-target 2D branch used to drop it, compositing the 2D
artboard over the city). `exitCityMode3D` clears `_cityModeActive` before its `_applyViewState`, so leaving the City
tool still restores the neutral workspace backdrop. Test: play-auto-player.test.ts "City mode keeps its sky backdrop
through camera-mode switches". Verified headless (seed-3 city, Noon / Golden / Night × street, rooftop, overview, 5 km and 30 km
up, ~65 km out): sky correct everywhere after a free3D/ortho2D switch + Play enter/exit.

**Not changed / notes.**
- Outside City mode (the City tool closed, a placed city in the illustration or the scene target) the backdrop is the
  neutral workspace grey by design (the host owns lighting there); there is no sky then at any altitude.
- The 2D-mode branch of `_applyViewState` still disables the orbit controls during City mode (a camera-mode switch to
  ortho2D/perspective2D inside City mode drops the city orbit). Pre-existing, left alone.
- The packaging creator's stage background uses the same slot and can be reset the same way by a view-state change.

