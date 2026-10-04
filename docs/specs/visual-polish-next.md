# Visual polish: what to do next (ranked)

Written 2026-10-01 from a fresh headless capture pass, measured against the Persona 5 Royal / P5X look. It ranks
the work that would raise visual quality the most **from where the engine is today**: after polish round 3, the
persona-polish passes A–E, the railway upgrade and the film-look / toon work.

Status: `[ ]` todo · `[~]` partial · `[x]` done · `[-]` dropped (with reason).
Related: [persona-polish-plan.md](persona-polish-plan.md) · [polish-round-3.md](polish-round-3.md) ·
[city-quality-upgrade.md](city-quality-upgrade.md) · [railway-upgrade.md](railway-upgrade.md) ·
[film-look-and-toon-shadows.md](film-look-and-toon-shadows.md) ·
[character-shading-toon-and-parallax-eyes.md](character-shading-toon-and-parallax-eyes.md) ·
[world-borders.md](world-borders.md) · [hair-styles.md](hair-styles.md) · [emotes.md](emotes.md) ·
UI: [../ui/city-quality.md](../ui/city-quality.md).

## Screenshots

Folder: `C:\Users\szain\AppData\Local\Temp\claude\c--Users-szain-source-repos-salsa\e266d482-ab0c-44d9-b2aa-ae6e144a9b3f\scratchpad\pupdrive\polish\`
(it is session scratch, so copy anything worth keeping). Driver: `cap.js`, run as `STAGE=city|styles|play|chars|tiled node cap.js`
(1360×900, seed-3 grid city with a square border, the clean look by default). Copies of the older drivers
(`t1-shots.js`, `skyalt-drive.js`, `hcommon.js`, `h-p5.js`, `drive-r62.js`) are in the same folder.

| Set | Files |
|---|---|
| City × preset | `city-{noon,golden,night}-{hero,overview,roof,street0,street1,street2}.png`, `city-dusk-street0.png`, `city-rainyEvening-street0.png` |
| Toon city | `city-celhd-street0.png`, `city-celhd-hero.png`, `city-celhd-ink-street0.png` (cel-hd environment, then ink outlines at 1.5 px) |
| Style packs | `style-persona5-{hero,street0,street1}.png`, `style-persona4-{hero,street0,street1}.png` |
| Play, third person | `play-{golden,night}-{idle,idle-front,run,run-turn,run2,stop,jump}.png` (auto player) |
| Characters | `chars-lineup.png`, `chars-lineup-outlines.png`, `chars-face1.png`, `chars-face2.png`, `chars-face2-nooutline.png` (4 random characters, bare scene) |
| Tiled world | `tiled-golden-{overview,mid,roof}.png`, `tiled-night-overview.png` (`salsaWorld.tiles(1,'focus')`) |

Below, screenshot names drop the folder and `.png`.

## Where it stands (one paragraph)

The structure is right. Street layout, kerbs, zebras, poles and wires, lightbox signs with real words, nobori,
crowd, cascaded shadows, FXAA and the train all read as a Tokyo street at eye level. The gap to Persona 5 is now
mostly **art direction**, not missing systems:
- Colour and light are muddy. Golden hour is sepia, night is near-black with grey lamp discs, and the sky is flat.
- A few loud placeholders sit in every shot: rainbow shop shelves, static-noise video screens, and the cyan
  "cyberspace" void grid and border wall.
- Characters have no brows or mouth, and wear noisy hair and glossy cloth.
- The Play camera frames the player small and wide.

The toon parts that would close most of the gap are already built (cel-hd, ink outlines, toon shadows, rim, skin
ramp, character outlines) but they are all off by default and not composed into a look. `city-celhd-ink-street0`
is the most Persona-like frame in the whole set.

---

## Ranked list

Impact: how much of the frame it changes × how often you see it. Effort: S < 1 day, M 1–3 days, L about a week or more.
Risk: the chance of regressions or perf cost. **QW** marks a quick win.

| # | Item | Impact | Effort | Risk | QW |
|---|---|---|---|---|---|
| 1 | [~] Remove the cyber void grid and border wall from Tokyo looks; add a skyline backdrop | Very high (every elevated shot) | S (off) + M (backdrop) | Low | ✔ (part 1) |
| 2 | [x] Character face kit: brows, mouth, nose, hair shadow | Very high (every close-up and Play) | M | Low | |
| 3 | [~] Shop-window interiors: drop the rainbow shelves | Very high (every street shot) | S (retone) + M (per-trade) | Low | ✔ (part 1) |
| 4 | [x] Complementary light: warm key, cool shadows, no sepia grade | High (every daytime frame) | S | Low | ✔ |
| 5 | [x] Night streets: warm light spill, coloured lamp pools, a wet sheen that reads | Very high (night and dusk) | M | Med | |
| 6 | [~] Video screens: designed content instead of moiré static; starter advert images | High | S + M | Low | ✔ (part 1) |
| 7 | [~] Play camera and player readability: FOV, distance, shoulder offset, occluder fade, character light | Very high (Play) | S–M | Low | ✔ (FOV/distance) |
| 8 | [x] A "Graphic" city look from the built toon parts; fix the broken `persona5` pack | High | S–M | Low | ✔ |
| 9 | [x] Sky: night gradient and horizon glow, painted clouds with shape, fix the sliced cloud card | High | M | Low | |
| 10 | [x] Character shading defaults: cel clothes, matte cloth, chunky hair with a highlight band, outlines on in Play | High | M | Low | |
| 11 | [x] City value and colour variety seen from above (facades and roofs) | Med-high | M | Low | |
| 12 | [~] Tiled world: low-detail massing on the outer tiles instead of empty lots | Med-high (tiled only) | M | Med | |
| 13 | [x] Animation feel: idle personality, arm swing, skirt follow-through, landing, turn anticipation | Med-high (Play) | M–L | Med | ✔ |
| 14 | [x] Faceted "crumpled" shading on large blank walls | Med | S | Low | ✔ |
| 15 | [x] Persona-style screen-space UI kit: HUD, transitions, halftone, call-outs | Very high for "feel", zero for the 3D | L | Low | ✔ |
| 16 | [x] Motion grounding: blobs for moving walkers and cars, denser traffic and crowd | Med | M | Med | |

### Quick wins (do first, roughly a day each or less)

- **1a** Turn `voidGrid` and `borderGlow` off for the clean look and every scene preset.
- **3a** Retone the procedural shop shelves.
- **4** Rebalance the golden-hour and noon grade and shadow tints.
- **6a** Remove the 'waves' moiré from `bldg:screen`.
- **7a** Play camera: FOV 72 → about 50, distance about 4.4 m → about 3 m, plus a shoulder offset.
- **8** A "Graphic" look preset, and a retune of the `persona5` pack.
- **14** The faceted blank-wall shading.

### Quick-win pass status (2026-10-03, after shots taken and tuned)

Before / after shots, same poses: `scratchpad/pupdrive/polish2/before/` and `scratchpad/pupdrive/polish2/after/`
(driver `polish2/cap.js`: `OUTDIR=after STAGE=city|styles|play node cap.js`, `PRESET=night` for the night Play run; the
city stage now also shoots `city-graphic-{hero,street0,street1,street2}`). Zero GPU / WGSL errors in every run.
UI notes: [../ui/city-quality.md](../ui/city-quality.md) §Visual polish quick wins.

- `[x]` **1a** `voidGrid` / `borderGlow` default **false**; presets + Phantom Night switch them off, Neon Cyber keeps
  them. After: `city-golden-hero`, `city-night-hero` (no cyan wall / sky grid). 1b (skyline) not started (status
  2026-10-04: partly covered in tiled worlds by the HLOD skyline + impostor ring, see "Big items").
- `[x]` **3a** shop interiors retoned. After-shot tune: by day the retoned room read as a flat grey void, so shops now
  show the room more (mix 0.55, less desaturation), the accent is 1 in 7, and a shop is softly self-lit by day
  (`shopDayGlow`, behind the glass Fresnel; night unchanged). After: `city-noon-street0`, `city-golden-street0`,
  `city-night-street1`.
- `[x]` **4** golden: warm sun + cool shade (`coolFill`). After-shot tune: the near-neutral frame tint read GREY, so the
  frame tint is back to `[1.07, 1, 0.92]`, the gold split is `[1.18, 0.96, 0.72]`, saturation 0.14 and Golden's building
  mute 0.22. No sepia: shade stays blue-violet. After: `city-golden-hero`, `city-golden-street0`.
- `[x]` **6a** ad screens: three designed layouts read cleanly from street level to the overview (no aliasing), and at
  night. **Saved scenes:** gated on the new `LayoutParams.adScreens` (default true). `restoreFromSave` pins a marker
  without the field to false, and `buildStreets` → `BuildingParams.adScreen: false` emits the legacy 'waves' screen, so
  old documents keep the old look. Practical because the marker stores the full params, so "absent" reliably means
  "saved before". After: `city-noon-overview`, `city-golden-street1`, `city-night-street1`.
- `[x]` **7a** Play camera: FOV 50, 1.8·H / 3 m, chest pivot, 0.35 m shoulder offset. Reads like a modern third-person
  camera (player large, a little left of centre). **Saved scenes:** documents that set `play.cameraDistance` /
  `play.fovDeg` keep them; documents that never set them get the new framing (documented in play-settings.ts). The
  driver's idle shot now waits 9 s (the auto player streams in after `autoPlayerId3D` is set). After:
  `play-golden-{idle,run,idle-front}`, `play-night-*`.
- `[x]` **8** Graphic look + persona5. **Bug found:** `applyLook` enabled a look's ink outlines and then disabled them
  again (the E2 edgeWear line sat between the `if` and its `else`), so Graphic and Phantom Night had no ink at all;
  fixed + tested. persona5: new opt-in look field **`windowGlow`** (0.7 on the pack; packed into the window material's
  `patternColor.a`, absent = 1x, persisted only when set) so lit windows show frames and blinds instead of white blobs;
  `clouds: false` (the unlit cloud polygon). Sign lettering: cream text only on faces with luminance ≤ 0.5, dark ink
  above, coloured ink only above 0.75 (`letteringFor`). After: `city-graphic-*`, `style-persona5-{hero,street0,street1}`.
- `[x]` **14** utility cabinets: fixed earlier, `addCabinet` half-extents × u.

### Night / player light / ink pass status (2026-10-03, after shots taken and tuned)

Before / after shots, same poses: `scratchpad/pupdrive/night/before/` (the new look fields off = the legacy look) and
`scratchpad/pupdrive/night/after/` (driver `night/cap.js`: `OUTDIR=after STAGE=city|play`, `OFF=1` for the before set;
GPU A/B `night/perf.js`). Zero GPU / WGSL errors. UI notes: [../ui/city-quality.md](../ui/city-quality.md) §Night streets,
player light, ink on foliage.

- `[x]` **5a** light spill: `CityLook.nightSpill` (opt-in, on in every scene preset, night-gated). Warm pools in front of
  lit shopfronts and sign-coloured washes under low shop signs, from the lot meta (`src/world/light-spill.ts`, one
  radial-fade layer per colour bucket, draped). Vending machines and lower walls are not covered (the street-lamp point
  lights still light walls). After: `city-night-street{0,1,2}`, `city-night-hero`, `style-persona5-street0`.
- `[x]` **5b** lamp pools: the grey-white disc was the glow pass's 1.9 x emission clipping every channel to white (plus the
  lamp point light on a bright diffuse). With the spill on they glow in a slightly saturated `lampColor`, below 1, soft.
- `[x]` **5c** wet: the procedural ground shader ignored the material roughness, so rain never reached SSR. New
  `CityLook.wetSheen` (Night 0.6 = damp, Rainy Evening 1): a material roughness under 0.3 glosses the ground with ~4 m
  puddles and darker asphalt; SSR reflections of signs show (`city-rainyEvening-street0`). Measured: +0.01 ms street /
  +0.11 ms hero (spill), +0.13 ms (wet), all within the 0.5 ms budget.
- `[x]` **7c** player light: `CityLook.playerLight` (opt-in, on in every scene preset, night-gated); a pinned point light
  ahead of the lamp candidates (`Renderer3D.setPinnedPointLights`, `src/game/player-light.ts`). After:
  `play-night-{idle,idle-front,run,run2,stop}`. The player's shadow is its skinned shadow caster; a contact blob for moving
  characters stays with item 16. 7b (occluder fade) not started.
- `[x]` **ink on foliage + ledge dashes**: `CityOutlines.foliage` ('silhouette' in Graphic + Phantom Night) and
  `CityOutlines.creaseFade` (15 → 70 m). The outline pre-pass now cuts leaf cards to their leaves in every mode (it inked
  the card squares: the long straight lines across canopies; a documented default change for inked saved scenes).
  After: `city-graphic-{hero,street0,street1,street2}`, `style-persona5-street{0,1}`.

### District palette / roofs / motion grounding / thin-crease ink pass status (2026-10-04, after shots taken and tuned)

Before / after shots, same poses: `scratchpad/pupdrive/life/before/` (the code before this pass) and
`scratchpad/pupdrive/life/after/` (driver `life/cap.js`, same poses as `polish2/cap.js`; side-by-sides in `life/cmp/`;
mover-blob close-ups off / on in `life/closeup/`; ink A/B in `life/ink/`). Zero GPU / WGSL errors. UI notes:
[../ui/city-quality.md](../ui/city-quality.md) §District palette, roof variety, mover shadows, density.

- `[x]` **11** district palette (`LayoutParams.districtPalette`) + roof variety (`roofVariety`): a 3 × 3 value × hue grid
  per facade material weighted per district, per-lot roof finishes + turf gardens; both CityLook fields on in every scene
  preset and on for new cities; saved cities pinned off on restore. After: `city-{noon,golden,night}-{overview,hero,roof}`,
  `city-graphic-hero`. The overview now shows white tile, dark brick, charcoal cladding and coloured render; roof decks
  vary but the roof plant (tanks, AC, penthouses) still dominates many tops ("fewer, larger roof-equipment pieces" not done).
- `[x]` **16** moving contact blobs (`world.setMoverShadows`): one instanced-style quad mesh for every routed car / bus,
  walker, rail car and the Play player, following the poses at the sim-LOD rate (partial vertex upload,
  `Renderer3D.patchMeshVertices`), hidden in the fog / past 180 m. Density: `trafficDensity` 1.3 and `pedestrianDensity`
  1.4 on new cities (old saves keep theirs). After: `closeup/{night,overcast}-{car,walker}*-{off,on}`, `play-night-*`.
  Cost: GPU within noise (≤ 0.2 ms), CPU ≈ 0.2 ms / frame; density +0.14 ms GPU, +0.28 ms traffic tick.
- `[x]` **ink dashes (#3 leftover)**: `creaseFade.thinPx` (3 in Graphic + Phantom Night) drops crease ink along faces
  thinner than 3 px past the crease-fade near distance unless the depth steps. After: `ink/graphic-street{0,1,2}-tp{0,2,3}`,
  `city-graphic-street{0,1,2}`. +0.11 ms GPU.

### Big items

- `[~]` **1b** A skyline backdrop. Status (2026-10-04): in TILED worlds the P17 HLOD skyline (default on, up to 24 tiles)
  plus the P19 impostor ring (`setStreamHlod({ ring: true })`, off by default; `src/world/skyline-ring.ts`) fill the
  horizon; a backdrop ring around a single (diorama) city is not built.
- **2** The face kit. [x] Done 2026-10-03 (see the status under §2).
- `[ ]` **3b** Per-trade interiors (still one generic `shopInterior` in mesh3d-shaders.ts).
- **5** Night light spill. `[x]` 2026-10-03 (see the pass status above).
- `[x]` **9** The sky (2026-10-03: the sky dome; see item 9).
- `[x]` **10** Character shading defaults (2026-10-03; hair via the 2026-10-04 locks styles, see item 10).
- `[~]` **12** Tiled massing. Status (2026-10-04): the outer tiles are covered by the perf work: the P10.C1 massing tier
  (`src/world/tile-massing.ts`) and P17 HLOD (`src/world/tile-hlod.ts`, the default Outside-tiles mode `'hlod'`). Not
  re-shot against this item's screenshots; the Flat / Focus worlds keep their own path.
- `[x]` **13** Animation feel (2026-10-03; see item 13).
- `[x]` **15** The UI kit (2026-10-04; see item 15 and [persona-ui-kit.md](../ui/persona-ui-kit.md)).

---

## Details

### 1. Remove the cyber void grid and border wall from Tokyo looks; add a skyline backdrop
- **Wrong:**
  - A translucent cyan wall rings the city.
  - Glowing grid lines run across the sky and the void. They are the void-grid cells, one per city size.
  - At night the wall is the brightest thing on the horizon.
  - Together they make the city read as a board-game diorama, not a place.
  - Screenshots: `city-golden-hero`, `city-golden-roof`, `city-night-hero`, `city-night-roof`, `style-persona5-hero`
    (grid lines across the whole sky), `tiled-golden-roof`.
- **Fix:**
  - (a) The clean look and all `CITY_SCENE_PRESETS` set `voidGrid: false, borderGlow: false`. Keep them in the cyber
    and holo packs, where they belong. Saved cities keep their value, and only new cities and preset applications
    change.
  - (b) A cheap **skyline backdrop**: 2–3 rings of flat-shaded building silhouettes (instanced boxes with random
    heights and lit-window dots at night) at 1.5–4 R, fog-tinted. It fills the horizon the way P5's skybox city
    does. The terrain apron (`terrainApron`, Phase B) is the "nature" alternative.
- **Files:**
  - `src/world/types.ts` (defaults: `voidGrid: true, borderGlow: true`)
  - `src/world/scene-presets.ts`, `src/world/styles.ts`
  - `src/world/voidgrid.ts`
  - a new `src/world/skyline-backdrop.ts`
  - `src/world/apron.ts`
  - `world-manager.ts` (FLATMAP / far tiers)
- **Planned?** [world-borders.md](world-borders.md) covers grid → apron → dome. No Tokyo skyline ring is planned.

### 2. Character face kit: brows, mouth, nose, hair shadow
- **Wrong:**
  - Faces have only eyes.
  - There are no eyebrows, no mouth line, no nose tip or shadow and no cheek blush. Seed 18 has dot marks under
    the eyes.
  - The eye decal reads unlit and pasted on (bright sclera on a dark face).
  - The low jaw facets show as a dark triangle under the nose.
  - P5 faces are carried by bold brows, a small mouth line and the hair's hard shadow across the forehead.
  - Screenshots: `chars-face1`, `chars-face2`; also `play-golden-idle-front`, where the face reads blank.
- **Fix:**
  - Extend the eye-decal canvas into a face decal: brows (shape, thickness, angle per expression), a mouth (line,
    open, smile and frown shapes), a nose tick and shadow, and blush. Drive it from the existing face rig and
    expressions so blink, gaze and emotion stay in one system.
  - Light the decal with the skin ramp so it sits in the skin, not on it.
  - Add a fake hair-shadow band on the forehead: a skin-ramp darkening driven by the distance below the hairline,
    which avoids self-shadow cost.
  - Phase 2: mouth shapes for talking, using emote and dialogue hooks.
- **Files:**
  - `src/services/managers/eye-generator.ts` (canvas drawing)
  - `src/services/managers/scene3d-character.ts` (face rigs, `frameFace3D`)
  - `body-generator.ts` (jaw and nose profile, about lines 798–832)
  - `shaders/skinning-shaders.ts` (skin ramp)
- **Planned?** No. The eyes are done ([[project_anime_face_eyes]]). [emotes.md](emotes.md) explicitly excludes the face.
  Parallax eyes (Part B of character-shading) is planned but is a smaller win than brows and a mouth.
- **Status: [x] built 2026-10-03.** API + params: [../ui/character-creator.md](../ui/character-creator.md) §2.5b.
  - Built as two raycast skin overlays (skin layer + brow layer) with MULTIPLY-blended multiplier textures, instead of
    extending the eye-decal canvas. So it works in every render style and with the skin ramp for free, and the eye decal
    (and every saved eye PNG) is untouched.
  - Brows and covered eyes draw through the hair fringe with a view-ray depth pull (flags2 bit 6, normalMatrix column 3 .z).
  - The hair shadow is painted from the hair's fringe profile (no self-shadow cost).
  - New: an eye upper-lid shadow (`EyeParams.lidShadow`), eyes partly lit by the scene (`eyeShade`), and distance-LOD line weights.
  - Expressions: `setCharacterExpression3D` (5 shapes + blends). Life hooks: a brow raise on some blinks, idle smiles, and
    expression events in the clip face tracks.
  - Old saves load identically (opt-in).
  - Not done: lip-sync (phase 2). The low-jaw "dark triangle" under the nose is body shading (item 10); multiply cannot lighten it.
  - Screenshots: scratchpad `pupdrive/face/` (`before-front/`, `it9/`, `persist/`).

### 3. Shop-window interiors: drop the rainbow shelves
- **Wrong:**
  - Every shop window at street level shows huge saturated rainbow "book" blocks on pale shelves.
  - By day it is the most saturated thing in frame. At night the rooms glow pale lavender and look like toy boxes.
  - It is the loudest placeholder in the city.
  - Screenshots: `city-golden-street0` (right third of the frame), `city-noon-street0`, `city-night-street0`,
    `city-dusk-street0`, `play-night-run2`, `style-persona4-street0`.
- **Fix:**
  - (a) Quick: retone the procedural `shopInterior`.
    - Product blocks get a muted, per-shop palette, use a third of the current size, and gain a value jitter.
    - The room is darker by day (glass Fresnel and sky reflection carry the window).
    - At night the light is warm with a soft falloff from the ceiling.
  - (b) Per-trade procedural interiors keyed off the sign word kind (`signWordKind`): a konbini (white shelves,
    small items, a bright cool light), a ramen counter and noren, a clothing rail, a pharmacy, a book shop, a bar
    (dark, warm).
  - (c) Ship a small original starter set for the `interior` and `poster` GARP buckets (C3/C4).
- **Files:**
  - `src/renderer/3d/shaders/mesh3d-shaders.ts` (shopInterior)
  - `src/world/building-parts.ts`, `src/world/building.ts`
  - `src/world/sign-style.ts`
  - `src/world/garp.ts`
- **Planned?** C4 (built) only replaces the shelves when the user adds images. C3 (starter images) is open. The
  procedural fallback itself was never revisited.

### 4. Complementary light: warm key, cool shadows, no sepia grade
- **Wrong:**
  - Golden hour is one sepia mass. Buildings, sky haze, shadows and asphalt are all tan-brown.
  - The lit and shaded sides differ in value but not in hue.
  - The preset multiplies the whole frame by `tint [1.14, 1.0, 0.82]` with warm shadow tints `[1.0, 0.86, 0.76]` and
    a warm shadow split-tone. That was tuned 2026-09-30 to escape "lavender" and overshot.
  - Noon still has a blue-grey cast on facades.
  - P5 golden hour is orange-lit faces against blue-violet shade, with saturated signs on top.
  - Screenshots: `city-golden-street0`, `city-golden-hero`, `city-golden-roof`, `play-golden-idle-front`;
    for comparison `city-noon-street0`.
- **Fix:**
  - Warmth moves to the **sun colour** only.
  - Shadows get a cool tint (about `[0.80, 0.86, 1.0]`), weaker than the old violet.
  - The grade tint goes to about `[1.04, 1.0, 0.95]`, and the highlight split-tone keeps the gold.
  - Raise `keyFill` for golden.
  - Add a mild saturation boost on mid-tones only, so signs pop and buildings stay muted.
  - Re-render hero + street + Play at noon, golden and dusk.
- **Files:** `src/world/scene-presets.ts` (golden and noon entries), `src/world/day-night.ts`, `styles.ts` (`CITY_CLEAN_LOOK`).
- **Planned?** A4 (key/fill) is done. This is a retune of A4 and T1.1.

### 5. Night streets: warm light spill, coloured lamp pools, a wet sheen that reads
- **Status:** `[x]` 2026-10-03: (a) spill + (b) pools via `CityLook.nightSpill`, (c) via `CityLook.wetSheen` (see the pass
  status near the top). Vending-machine spill not done.
- **Wrong:**
  - At night the pavement and road are near-black everywhere except one grey-white streak of road.
  - Lamp pools render as **flat grey-white discs**, not warm light. This is clearest from above.
  - Shops and signs throw no light onto the ground.
  - The Night and Rainy Evening presets set `reflections: true`, but no sign reflections are visible on the road.
  - P5 night streets glow: coloured spill under every sign, warm pools from shops, specular streaks on wet asphalt.
  - Screenshots: `city-night-street0`, `city-night-street2`, `city-night-hero`, `tiled-night-overview`,
    `city-rainyEvening-street0`, `play-night-run2`.
- **Fix (no new texture binding, so no P8 risk):**
  - (a) **Light-spill decals.** At build time, emit a radial-fade additive quad on the ground in front of each lit
    shop window, under each sign stack and under each vending machine. Colour comes from the source (sign palette,
    warm shop light). It uses the same radialFade path as `world:lamp-pool` and the contact-shadow blobs. Night
    only, faded by the glow walk.
  - (b) Lamp pools: find why the `[1.0, 0.88, 0.60]` pool comes out grey. The likely causes are the night grade,
    the bloom chroma gate or opacity blending over a dark base. Make pools additive and warm, and honour
    `world.lampColor`.
  - (c) Wet look: check that SSR or the planar path actually reaches the road in the city at night. Make Rainy
    Evening set a puddle and wetness mask on the asphalt (lower roughness, darker albedo) so reflections have
    something to land on.
- **Files:**
  - `src/world/streets.ts` (about line 831, the lamp pool)
  - a new `src/world/light-spill.ts` (shaped like `contact-shadows.ts`)
  - `world-manager.ts` `_applyGlow`
  - `ground-surfaces` (the asphalt wetness)
  - `renderer-3d.ts` (SSR on the city)
- **Planned?** City-quality P8 (the light map) was dropped. L10 enlarged the pools. Spill decals are not planned.

### 6. Video screens: designed content instead of moiré static; starter advert images
- **Wrong:**
  - The large building screens show white TV-static noise from every distance.
  - `bldg:screen` uses the `'waves'` pattern at `freq: 9`, which aliases into noise beyond a few metres.
  - Op-art wavy panels show at street level.
  - With the advert pool empty (the default), every billboard is a placeholder.
  - Screenshots: `city-golden-street1` (left), `city-celhd-ink-street0`, `play-golden-run`, `city-noon-overview`,
    `tiled-golden-overview` (the white static rectangles everywhere).
- **Fix:**
  - (a) Replace the pattern with a low-frequency procedural ad layout: 2–3 colour blocks, a big glyph word from
    `SIGN_WORDS`, a slow scroll or cut every few seconds, and an fwidth fade to the average colour.
  - (b) Ship 10–20 original starter images across the advert buckets. They should be graphic, high-contrast and
    Persona-flavoured: food, idols, phones, drinks. Keep them toggleable.
- **Files:** `src/world/building.ts` (line 724), `src/world/streets.ts` (`world:screen-*`), the `mesh3d-shaders.ts`
  pattern modes, `src/world/garp.ts`, `docs/ui/garp.md`.
- **Planned?** C3 is open ("consider shipping starter images"). The screen pattern is not planned.

### 7. Play camera and player readability
- **Wrong:**
  - In third person the player is about a sixth of the frame height and centred, with a 72° FOV and a camera about
    4.4 m back and high (`thirdPersonFovDeg: 72`). It reads like a CCTV view.
  - Thin props between the camera and the player fill the frame. In `play-golden-idle-front` a black pole covers a
    third of the screen.
  - At night the player almost vanishes, because nothing lights her.
  - P5 uses a lower, closer camera (about 45–55° FOV, about 2.5–3 m) with the character left of centre, always
    rim-lit and outlined.
  - Screenshots: `play-golden-idle`, `play-golden-run`, `play-golden-idle-front`, `play-night-run2`.
- **Fix:**
  - (a) Defaults: FOV about 50, distance about 3 m (the `H * 2.6` rule goes to about `H * 1.8`), a shoulder offset of
    about 0.35 m, and a pivot at chest height.
  - (b) An occluder fade: dither out props that the camera-to-pivot ray hits within about 1.5 m of the camera,
    using the existing raycast bundle. Poles, signs and trees fade instead of popping in.
  - (c) A **character key light** in Play: one unshadowed point or rim light that follows the player (it fits the
    16 point lights). Turn on character outlines and rim by default while playing.
- **Files:**
  - `src/game/character-controller.ts` (line 97 defaults), `src/game/third-person-camera.ts` (line 66)
  - the play module in scene3d (`_tpCam`, `_regionCandidates`)
  - `scene3d-manager.ts` `setCharacterOutlines3D`
- **Planned?** R6.2 tuned game feel, but not the framing, occluder fade or character light.

### 8. A "Graphic" city look from the built toon parts; fix the broken `persona5` pack
- **Wrong:**
  - **The good:** the cel-hd environment plus ink outlines (`city-celhd-ink-street0`) is the most P5-like frame of
    the set. Sunlit facades are bold and flat, shadows are crisp, and the ink lines give it the graphic edge.
  - It is only reachable by hand-combining `setEnvironmentStyle3D({renderStyle:'cel-hd'})` and `setCityOutlines`.
  - The ink at 1.5 px breaks into dashes on poles and on the window grid at range.
  - **The bad:** the `persona5` "Phantom Night" pack is broken.
    - The whole frame is pure saturated blue.
    - Window lights clip to pink-white blobs.
    - The white sign lettering is lost on white boxes.
    - An unlit polygonal cloud and the grid lines cross the sky.
  - Screenshots: `city-celhd-ink-street0`, `city-celhd-street0`, `style-persona5-street0`, `style-persona5-hero`.
- **Fix:**
  - Add a `graphic` look, also offered as a scene-preset modifier: cel-hd environment, toon shadow, rim, ink
    outlines with a depth fade (thinner and lighter with distance, which fixes the dashes), and cool shadow tints.
    It is opt-in, so the clean PBR default (the P5X reference) stays.
  - Retune `persona5`:
    - a red, black and white palette;
    - a neutral night sky, not blue;
    - window emissive capped (around 0.8×) so the frames show;
    - sign text and box contrast enforced by `sign-style`;
    - `voidGrid` off.
- **Files:** `src/world/styles.ts` (lines 88–124), `src/world/scene-presets.ts`, `world-manager.ts` (`setCityOutlines`,
  the look apply), the outline pass (`src/renderer/3d/outline-pass.ts`, depth-faded width).
- **Planned?** The packs exist ([../ui/city-quality.md](../ui/city-quality.md)). No combined preset is planned.
  Bug-hunt D-R3 (toggling outlines drops a few frames) affects A/B toggling of this look.

### 9. Sky: night gradient and horizon glow, painted clouds with shape, fix the sliced cloud card
- **Wrong:**
  - The night sky is flat black with no horizon glow, moon or stars.
  - At golden hour, street level shows a flat lavender sky with no clouds in view, and the roof view shows a few
    blurry beige smudges with no shape.
  - A painted cloud card is **cut by a hard straight edge** in `tiled-golden-roof`. The card is sliced, probably by
    the far plane or by another card.
  - Screenshots: `city-night-street0`, `city-night-roof`, `city-golden-street0`, `city-golden-roof`, `tiled-golden-roof`.
- **Fix:**
  - Night: a zenith-to-horizon gradient (deep navy to warm city-glow orange or teal at the horizon), a moon disc
    with a halo, and sparse stars faded by city light.
  - Clouds: give each painted card a defined, toon-stepped edge (two-tone lit and shade, like anime cloud
    painting) instead of the pure radial blur. Place a few big ones in the street-level view cone.
  - Clamp cloud cards inside the far plane, and sort or depth-fade overlapping cards.
- **Files:** `src/world/sky.ts`, `src/services/managers/world-traffic.ts`, `traffic.ts` (painted clouds),
  `src/renderer/3d/procedural-sky.ts`.
- **Planned?** E1 is done (painted cards). The night sky and the clipping bug are not planned.
- **Status `[x]` (2026-10-03):** built as the **sky dome** — a view-direction sky backdrop (`ArmatureBgPass` mode
  `'sky'` → `src/renderer/3d/sky-dome-pass.ts`, CPU half + reference `sky-dome.ts`, per-time look `skyDomeParams` in
  `src/world/sky.ts`). Night: navy zenith → horizon with a warm city-glow band, a shaded moon disc with a two-scale
  halo, sparse twinkling stars faded near the glow. Clouds: two layers of anime cumulus silhouettes in the dome
  (horizon banks + a 13–36° layer for street views), toon two-tone (an offset-SDF lit cap that follows every lump), a
  gold rim at golden hour, dark silhouettes after sunset, moonlit at night, city glow on the undersides, a soft flat
  base. The sun gets a disc + halo + a warm horizon band. Behind look field **`CityLook.skyDome`** (on in every scene
  preset + both Persona packs; absent = the legacy flat gradient, so saved cities keep their sky). The sliced card was
  the **far plane**: tiled-world horizon banks sat at 2.6–3.1 × the tiled extent, past autoFar (~2.8 ×); the legacy
  cards now sit at 1.7–1.9 × in tiled worlds (same apparent size), and the dome's own clouds live at infinity. IBL
  unchanged (baked from the sky keys only). UI + numbers: [../ui/city-quality.md](../ui/city-quality.md) §Sky dome.

### 10. Character shading defaults: cel clothes, matte cloth, chunky hair with a highlight band
- **Wrong:**
  - Clothes are glossy PBR, with long white specular streaks down the trousers (plastic).
  - Hair cards are thin, stringy and noisy, with aliasing at the tips, where P5 hair is a few big solid locks with
    flat colour and one highlight band.
  - Character outlines are off by default.
  - Body proportions show a long thin neck and narrow shoulders.
  - Screenshots: `chars-lineup`, `chars-lineup-outlines`, `chars-face1`, `chars-face2`.
- **Fix:**
  - The random-character defaults turn on the skin ramp and soft lighting on the body, cel-hd on the clothes
    (roughness about 0.9, no spec), rim on, and character outlines on in Play.
  - Hair: default to the existing CHUNKY mode (or bigger merged card clumps) and add a hair-highlight band (an
    anisotropic or fixed-UV ring in the hair shader).
  - The neck and shoulder fit belongs to the silhouette work.
- **Files:**
  - `src/services/managers/character-randomizer*` / `body-generator.ts` / `hair-generator.ts`
  - `material-3d.ts`
  - `shaders/skinning-shaders.ts`, `style-shaders.ts`
- **Planned?** T6 tuned the randomiser defaults. The skin ramp and toon pieces are built but opt-in.
  [hair-styles.md](hair-styles.md) phases B–E are open. [[project_body_silhouette]] is being tuned.
- **Status: [x] built 2026-10-03 (faces + defaults; hair partly).** UI + API: [../ui/character-shading.md](../ui/character-shading.md)
  "Anime face shading · matte · hair band · Play outlines"; random defaults in [../ui/character-creator.md](../ui/character-creator.md).
  - **Cel HD face (the big one):** the dark facet wedges across the nose and cheeks were the body's shading of the 9-ring head.
    New `BodyParams.faceNormals` (body-generator.ts `faceNormalProxy`): the head's normals become an ellipsoid proxy pulled onto the
    face's forward plane, faded in over the jaw. Flat skin with only a soft jaw / far-cheek shadow, in every style (it is just the
    vertex normal); the body keeps its form shading. New bodies get 1 (`NEW_BODY_DEFAULTS`); saved bodies have no field → classic.
  - **Seed 25's bright forehead block** under the fringe (Cel HD) was the lit cel band of a few forehead facets framed by the hair
    shadow; gone with the flat face plane. **Seed 32's "°°°" cheek marks** were the eye decal's under-eye dots
    (`EyeParams.underDeco`, 3 accent dots); the randomizer no longer turns them on.
  - **Hair over the eyes** (≈40 % of seeds): `hairlineFront` was 0–0.40 and below ≈0.25 the cap cards hang to the eyes. Now
    0.28–0.46; ≥ 90 % of seeds keep the fringe above the eye line (character-randomizer.test.ts measures the generated fringe).
  - **Defaults for new characters:** matte skin + cloth (`setCharacterMatte3D`), the hair sheen as one highlight band in Cel /
    Cel HD (`HairParams.sheenBand`, flags2 bit 7), character outlines on in Play (`setPlayCharacterOutlines3D`, runtime-only).
  - **Not done:** chunky hair as the default. With the random ranges chunky reads as a helmet / hood (no bangs) or a row of small
    teeth (with bangs); the big solid locks need hair-styles B–E. Cards + the band stay the default. Neck / shoulders: silhouette work.
  - **Status (2026-10-04): superseded for hair.** hair-styles B–E are built as `hairMode: 'locks'`
    (`src/services/managers/hair-locks.ts`, 15 styles); the random character now picks a lock style
    (`character-randomizer.ts`, `randomLockStyle`), so new random characters get solid locks + the band. The neck got the anime
    head / chin shadow (docs/ui/character-shading.md §Anime head). See [hair-styles.md](hair-styles.md).
  - Screenshots: scratchpad `pupdrive/face2/` (`before/`, `after/`, `sheet-before-after-front.png`, `sheet-expr-after.png`,
    `sheet-face-after*.png`, `sheet-play-after*.png`, `persist/`).

### 11. City value and colour variety seen from above
- **Wrong:**
  - From the hero and overview cameras every building is the same mid tan (golden) or mid grey (noon).
  - Roofs are a uniform grid of grey boxes.
  - The B4 swatches are muted to the point that the value range collapsed.
  - Real Tokyo from above has white tile, dark brick, coloured render, green and blue roof sheets and rooftop
    signage frames.
  - Screenshots: `city-noon-overview`, `city-golden-hero`, `city-celhd-hero`, `tiled-golden-overview`.
- **Fix:**
  - Widen the facade value range per district (some near-white, some dark), keeping saturation low.
  - Roof decks get per-lot colour (green or blue waterproofing, red metal, pale concrete) and fewer, larger
    roof-equipment pieces.
  - This overlaps T1.6, "calmer facades".
- **Files:** `src/world/palette.ts` (`facadeFor`), `building.ts` (roof deck, roof equipment), `styles.ts`.
- **Planned?** B4 is done. T1.6 is not started.
- **Status:** `[x]` 2026-10-04 (district palette + roof variety; see the pass status above). The fewer / larger roof
  plant was done later the same day as `LayoutParams.roofEquipment: 'clustered'`. Each flat roof gets one stair box, one
  coloured tank and one AC bank at the back, plus up to two district extras (solar, laundry, neon frame, lit mast,
  garden planters, rare helipad). New cities and presets use it; saved cities are pinned to 'classic'. Tiles are 0.06–0.34 MB
  lighter, and the HLOD mid tier draws the stair box. See [city-quality.md](../ui/city-quality.md) §Roof equipment.

### 12. Tiled world: low-detail massing on the outer tiles instead of empty lots
- **Wrong:** in `'focus'` detail the eight outer tiles are flat lot grids with no buildings: an endless empty board
  around one city. Screenshots: `tiled-golden-overview`, `tiled-golden-roof`, `tiled-night-overview`.
- **Fix:**
  - Outer tiles get a massing tier: one extruded box per lot (height from the archetype hash), a facade tint, a
    lit-window pattern at night and no detail.
  - This is the same geometry as the skyline backdrop (item 1b). Share the builder.
- **Files:** `world-manager.ts` (`tileDetail`, about line 1403 `flatOnly`), `src/world/centre-build.ts`, the tile workers.
- **Planned?** [world-borders.md](world-borders.md) covers tiled expansion, and the streaming and LOD specs mention
  far tiers. A massing tier is not specified.

### 13. Animation feel
- **Wrong (from stills, so it needs a video check):**
  - The run under a long skirt reads as gliding: the legs are hidden and the skirt is stiff (`play-golden-run`,
    `play-golden-jump`).
  - The arms stay close to the body.
  - The idle is a straight-arm stand (`play-golden-idle-front`).
  - The jump shot 250 ms after Space shows no airborne pose.
- **Fix:**
  - Arm swing amplitude scaled by speed.
  - Skirt follow-through on the hem: spring bones or the cloth sim lag.
  - Stride-length lean.
  - A 2–3 frame turn anticipation.
  - Landing squash and a dust puff.
  - A personality idle from `default-animations.ts` for the auto player.
  - Check the jump input path in the harness.
- **Files:** `src/game/locomotion.ts`, `character-controller.ts`, `default-animations.ts`, `pose-authoring.ts`, spring bones.
- **Planned?** R6.2 / Round 8 did walk, run, sneak and jump. Follow-through and personality are not planned.
- **Done (2026-10-03).** Details are in [docs/ui/play-mode.md](../ui/play-mode.md) §Animation feel.
  - **The jump finding is real, not a timing artefact.** An instant Space tap (keydown and keyup inside one tick) was
    dropped. 3 of 4 harness taps never jumped. `KeyboardInput.readTick()` fixes it: 4 of 4 taps are airborne at 250 ms.
  - **Jump:** a 60 ms wind-up crouch, then the take-off.
  - **Landing:** the Land squash no longer throws the arms toward a T-pose (an additive-reference bug).
  - **Idle:** a new runtime idle, `Stand` (breath, weight shift, glance, shoulder roll).
  - **Gait:** a walk loading dip and a fuller arm swing; a 16° run lean.
  - **Arms:** fitted to the body plus its top, so they clear bulky jackets.
  - **Turns:** the head leads them.
  - **Skirts:** a light steer follow-through in Play.
  - **Open:**
    - A real skirt-hem swing needs skirt spring chains. Skirts have no spring bones today; a slower steer lag made the
      knee poke through.
    - The landing dust puff.
    - A personality idle variety (Stand is the one idle).
    - **Status (2026-10-04):** the dust puff (`src/game/landing-dust.ts`, `play-dust-driver.ts`) and idle variety
      (`idleVariant` in `locomotion-animator.ts`, `default-idle-variants.ts`) are built (docs/ui/play-mode.md §Landing dust +
      idle variety). The skirt-hem swing (`skirt-swing.ts`) is part of clothing round 2, still in progress — see
      [../STATUS-2026-10-04.md](../STATUS-2026-10-04.md).
  - **Round 2 (2026-10-03):** jump variety (6 variant families picked per jump, tap = hop) and a looser walk / run
    (pelvis tilt, torso sway, arm overlap, a stroll, a settle step on stops, per-character personality, follow-through).
    See [docs/ui/play-mode.md](../ui/play-mode.md) §Jump variety + a looser walk / run.

### 14. Faceted "crumpled" shading on large blank walls
- **Wrong:** some large blank walls and building shells show big triangular facets, like crumpled paper. They look
  like per-face normals on the stucco or concrete facet pattern at wall scale. Screenshots: `city-noon-street2`
  (centre right), `play-golden-idle-front` (top right).
- **Fix:** find the layer (probably the render-stucco facets or a retaining-wall material). Clamp the facet strength
  to the pixel footprint the way B4 fades grain, or use smooth value noise as B4 did for render.
- **Files:** `mesh3d-shaders.ts` (`windowsPattern` / facade modes), `src/world/terraces.ts` if it is a retaining wall.
- **Planned?** No.

### 15. Persona-style screen-space UI kit
- **Wrong:** Play has no HUD or screen-space style. Persona's identity is half its UI: slanted red, black and white
  panels, halftone, big kinetic type, a location and time banner, the call-out on interaction, and stylised
  transitions.
- **Fix:** a UI kit on the existing UI system. It needs:
  - slanted-panel and halftone primitives;
  - a location/date banner on district change;
  - an interaction prompt over NPCs and doors;
  - transition wipes (the system has transitions and worldBlur);
  - a minimap.
  It ships as an optional template for Play.
- **Files:** `src/ui-system` / the UI state machine, post (halftone overlay), and the Frogmarks Player.
- **Planned?** The [ui-system.md](ui-system.md) engine is complete, and Ph5 (the editor) is pending. There is no
  Persona kit.
- **Done 2026-10-04:** [persona-ui-kit.md](../ui/persona-ui-kit.md).
  - 15 kit kinds, including slanted / torn panels, halftone and stripe tones, ransom and slanted type, HP/SP bars,
    status panel, date / weather, mini-map frame, prompts, menu, splash, damage, location banner and call-out.
  - 5 transitions: slash, shatter, stripe burst, panel slide and zoom punch.
  - The Persona HUD and pause-menu demos.
  - Drawn post-process-immune at full resolution (pixel-identical under TAAU at 0.5 scale).
  - Authorable from the Frogmarks UI panel.
  - Not done: a minimap fed by the real city map, a call-out that follows its 3D target, and the automatic
    district-change banner trigger.

### 16. Motion grounding
- **Wrong:** moving walkers and traffic cars, and the Play character at night, have no contact blob (A3/E4 "not
  covered"). The street shots show few moving cars or people for a Tokyo shopping street. (Motion was not filmed in
  this pass, so check it with a short frame sequence.)
- **Fix:**
  - Per-frame blobs as one instanced layer updated from the mover transforms.
  - A pedestrian-density default of about 1.5–2 for downtown districts, within the R6.4 budgets.
- **Files:** `src/world/contact-shadows.ts`, `world-traffic.ts`, `world-live-crowd.ts`, `crowd-live.ts`.
- **Planned?** It is the known gap in A3 and E4.
- **Status:** `[x]` 2026-10-04 (mover blobs + traffic / crowd density; see the pass status above).

---

## Also seen (small)

- `city-golden-street1`: `streetView({pick:1})` put the camera inside a cherry-tree crown. The street-view picker
  should reject spots with foliage within about 2 m.
- Tree crowns at eye level are flat dark-centred leaf cards (`city-golden-street1`). They look acceptable from mid
  range but papery up close. A two-tone toon foliage shade would help under the "Graphic" look.
- Crowd NPCs are faceless by design (P5 crowd style). Keep it.
- Bug-hunt items that touch visuals:
  - **D-W5**: the static crossing arm reappears beside the live arm after zooming out and in.
  - **D-R3**: toggling outlines or bloom loses the effect for a few frames.
  - **D-P3**: city look fields leak into the next document's new city, so A/B comparisons across documents are
    unreliable until it is fixed.

## Suggested order

1. Quick wins in one pass: 1a, 4, 3a, 6a, 7a, 8, 14. Re-render the same cameras with `cap.js` and compare.
2. Characters: 2 (face kit), then 10 (shading defaults), then 7b/7c (occluder fade and character light).
3. Night: 5 (spill, pools, wet), then 9 (sky).
4. World edge: 1b + 12 (one shared massing builder), then 11.
5. Feel: 13 (animation), 16 (motion), 15 (UI kit).

Gate every step with the persona-polish standing rules: old saves unchanged unless it is a bug fix or opt-in,
before/after renders at noon, golden and night (hero, two streets, Play third person), `wgsl-static-check`, and
the frame stats.
