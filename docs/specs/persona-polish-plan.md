# Persona polish plan — closing the gap to P5's street visuals

Started 2026-09-30, from a visual review of the street-level screenshots taken after polish round 3. The city now
has the right structure: layout, props, crowd and the player character read well. What separates it from Persona 5
is mostly **lighting, material restraint, signage content and eye-level richness**, not geometry.

Status: `[ ]` todo · `[~]` partial · `[x]` done · `[-]` dropped (with reason).
Related: [polish-round-3.md](polish-round-3.md) · [city-quality-upgrade.md](city-quality-upgrade.md) ·
UI: [../ui/city-quality.md](../ui/city-quality.md).

Standing rules:
- Old and new coexist: saved scenes stay visually identical unless a change is a bug fix or the user opts in.
- Verify every visual change with before/after street-level renders in the headless harness.
- WGSL has no backticks in comments and must pass `wgsl-static-check`.
- New ShapeManager features forward directly to their sub-module.
- Document every host API change in the UI doc and the Frogmarks handoff doc.

---

## What the review found

| Area | Now | Persona 5 |
|---|---|---|
| Light | Flat and even with a cool blue cast. Lit and shaded sides are nearly the same value. | One strong warm sun, a cool sky fill, strong lit/shade contrast. |
| Shadows | Barely visible at street level. Cars and people look pasted on. | Crisp, dark, long cast shadows. Everything is grounded by contact darkening. |
| Anti-aliasing | **None in 3D.** No MSAA on the 3D pipelines and no post AA, so wires, poles and edges shimmer. | Clean edges. |
| Asphalt | Near-black navy, uniform. | Lighter warm grey with subtle variation and patching. |
| Road markings | Glowing blue-white; they look emissive and catch bloom. | Off-white, slightly worn, never glowing. |
| Pavements | Cold pale blue, high-contrast joints. | Warm, soft joints. |
| Facades | The same grey block grid on every building ("graph paper"). Windows are flat dark rectangles. | Varied materials, bands and cornices, recessed windows with frames. |
| Palette | Signs are pure primary yellow/red/blue bars. | Neutral buildings; signs saturated but varied in hue and value. |
| Signage | Colour bars with random-kana placeholder text. Shop interiors are rainbow blocks. | Real images and real words. Signs have depth and glow. |
| Eye level | Ground floors are grey boxes with shutters; streets feel wide and empty. | Dense frontage: awnings, noren, nobori flags, menu boards, vending, plants, bikes. |
| Sky | Small white "popcorn" drifting clouds near the top. | Painted clouds and a soft horizon. |
| Depth | Little haze; far buildings are as contrasty as near ones. | Clear aerial perspective. |
| Stairs | Wall masonry pattern at wall scale on treads and risers; reads as a pile of cubes. | Solid steps with nosing strips. |

---

## Pass A — Light, shadows, anti-aliasing, haze (biggest visible win, no content work)

- [x] **A1 Anti-aliasing** (built 2026-09-30): post **FXAA** (FXAA 3.11 quality edge walk + sub-pixel blend), run
  FIRST in the post chain (before bloom / grade / film), only on frames that drew 3D, never in the lo-res PS1 mode.
  - MSAA rejected: the 3D meshes draw into the SAME main pass as the 2D content, so 4x MSAA means every 2D and 3D
    pipeline at sampleCount 4, a multisampled depth buffer, and a resolve before every pass that reads depth or
    colour afterwards (SSR grab, outline Sobel, post-bg-keep, post overlays, planar mirror). SMAA needs three passes
    plus lookup textures for a similar result at this resolution. FXAA is one fullscreen pass.
  - Cost: about +0.3-0.5 ms at 1300x850 (interleaved A/B, seed-3 city). Wires, poles and roof edges lose their stair
    steps (see pa/aa-cmp.png). Pattern moire (window grids, tactile dots) is NOT fixed by FXAA; those patterns are
    already fwidth-filtered in-shader and read clean at street level; far-distance moire is unchanged.
  - API: `sm.scene3d.setAntiAliasing3D({ mode: 'fxaa' | 'off', quality: 'low' | 'medium' | 'high' })`,
    `sm.scene3d.antiAliasing3D`. Default FXAA medium. Persisted in the global scene settings (`antiAliasing`); older
    saves load with the default (on). Code: src/renderer/3d/fxaa-pass.ts.
- [x] **A2 Cascaded shadow maps** (built 2026-09-30). The original map stays the FAR cascade (zoom-adaptive,
  throttled, unchanged); up to two NEAR cascades are layers of one depth-array texture.
  - Near box: half-width `nearMetres` (city default 24 m, so about 37 m covered in front of the eye), centred AHEAD
    of an eye-level / Play / fly camera, on the target for an orbit camera. Texel-snapped in LIGHT space (exact
    stabilisation at any sun angle). Its depth reaches up the sun ray to the tallest caster, so tall buildings still
    shade the near box. 2048 per layer: about 2.3 cm per texel at street level (the far map is about 12 cm there).
  - Per pixel the nearest cascade that contains it wins, fading into the next one in a 15 % band at its edge.
  - Per-cascade caster lists: every kept (light-box + shadow-reach culled) caster is also tested against each
    cascade's box. Characters (skinned) cast into the cascades too.
  - Throttle: the cascades re-render when their snapped box moves, on structural changes, when a character's pose
    changes, else every `updateInterval` frames (city: 2). A moving player now refreshes ONLY the cascades, so an
    animated character no longer forces the whole-city far map to redraw every frame.
  - Pulled-out cameras (orbit distance past about 3x the near box) drop the cascades: the adaptive far map is sharp
    enough there and a cascade would redraw most of the city.
  - Cost: about +1-1.5 ms at street level (mostly the extra PCF taps; the cascade pass itself is about 800 draw calls
    / 1.1 M triangles every 2nd frame). 3 cascades: another ~1-3 ms for little visible gain; 2 is the default.
  - Non-city scenes keep the single map (cascades 1 = the original shader result).
  - API: `sm.scene3d.setShadowCascades3D({ cascades: 1|2|3, nearExtent, mapSize, blend, updateInterval })`,
    persisted in `shadows.cascades`; city `world.setShadowCascades({ cascades, nearMetres })` / `world.shadowCascades`,
    persisted with the city (`lighting.shadowQuality`), default 2 / 24 m. Code: src/renderer/3d/shadow-cascades.ts,
    scene-uniforms.ts (computeCascadeMatrix, cascadeCentre), mesh3d-shaders sampleShadowCascaded.
- [x] **A3 Contact grounding** (built 2026-09-30): soft radial-fade ground blobs under people, parked cars, benches,
  vending machines, bins, bikes, stalls, bus shelters (src/world/contact-shadows.ts). Footprints come from the finished
  layer geometry (connected parts, merged when their plans overlap, principal axes), so no builder changed and it
  runs on the main-thread, worker and streamed-tile paths. One transparent layer per build group (about 1.8k blobs /
  3.6k triangles for seed 3). API: `world.setGroundContact(on, strength?)` / `world.groundContact`, persisted, default
  on at 0.55.
  - Not covered: moving traffic cars and walkers (the traffic movers are built outside the staging path) and the
    Play character, which is grounded by its real cascade shadow by day but has no blob at night.
  - SSAO street tuning left as is (opt-in, `world.setSSAO`).
- [x] **A4 Key/fill balance** (built 2026-09-30): new look field `keyFill` (0..1): by day a warmer (+22 %) sun over a
  20 % lower, less sky-blue fill; the sky-lighting fill bake uses a partly desaturated zenith (the visible sky keeps
  its blue). The clean look sets keyFill 1; noon / dawn shadow tints and the noon split-tone are less blue. Weather
  damps it (rain, snow, overcast: 35 %); night is untouched. Checked: noon, golden, night (hero + 2 streets + Play 3P),
  morning, dusk, rainy evening, snowy morning, overcast (street). Older saves without the field are unchanged.
  API: `world.setKeyFill(0..1)` / `world.keyFill`.
- [x] **A5 Aerial perspective** (built 2026-09-30): renderer aerial haze (contrast fade + horizon-colour tint that
  starts at zero distance, about 63 % built up at 320 m, 220 m in rain / snow), riding the Fog toggle. Look field
  `aerialHaze` (clean look 1). API: `world.setAerialHaze(0..1)` / `world.aerialHaze`; scene level
  `sm.scene3d.setAerialHaze3D(strength, reach, contrast, tint)` (persisted, handed back on city exit).
- [x] **A6 Bloom hygiene** (built 2026-09-30): the bloom extract has a CHROMA GATE (`bloom.chromaGate` 0..1): near-
  neutral pixels (white paint, pale paving, white facades) are kept out of the bloom; saturated lights (neon, signal
  lamps, warm windows) still bloom. The city runs it at 1 by day and 0.4 at night, so white lightboxes still glow a
  little. The emissive catch-all (5 % day / 3 % night) is too low to reach any threshold; clean road paint is already
  0. City exit resets the optional bloom keys (`wide`, `chromaGate`) the host never set.

## Pass B — Materials and colour restraint

- [x] **B1 Asphalt:** a lighter warm grey base with low-frequency variation, patch repairs and faint tyre wear lanes. Keep the clean-look intent: no crack noise.
  - Done 2026-09-30, clean finish only. Asphalt tint 0.33/0.31/0.28, replacing the near-black navy 0.17/0.18/0.20.
  - Asphalt mode 4 gained `p1` "street extras": very broad tonal drift, plus sparse rectangular repair patches (5 m
    cells, about 1 in 3 patched) with a tar sealant seam, also mirrored in the relief. `p1 = 0` (every non-clean road)
    is the old shader exactly.
  - Tyre wear: a new `world:roads-wear` layer (roadpaint.ts `buildRoadWear`), one 1.8 m band per lane, lift 1. It
    carries the road's own asphalt recipe and world uv, so as built it is invisible. The clean look darkens it to 0.92×.
    It costs about 7.6k triangles at radius 10. Per-wheel-track strips were tried and cost 14 to 28k, over the
    street-ground budget.
- [x] **B2 Road markings:** off-white (not pure white), slightly worn edges, matte, excluded from bloom and emissive.
  - Done 2026-09-30.
  - Why they looked blue: the paint was flat 0.90 white at roughness 1 with no specular or SSR, so there was no
    reflection. The cyan was the blue sky-IBL irradiance on an up-facing near-white albedo, plus the catch-all
    0.05 emissive lift, which pushed it toward the 0.95 noon bloom threshold.
  - The paint layer is now built as a new `roadPaint` ground surface (mode 20). Each stripe's uv is laid in its own
    frame, and the raw v packs the stripe width, so the shader knows the distance to the nearest long edge without a
    mesh split. That gives ragged 0.6 to 3 cm worn edges and faint scuffs where the asphalt aggregate shows through.
  - Clean look: off-white 0.82/0.79/0.71, roughness 1, and emissive 0 (a gated rule in `_applyGlow`).
  - Any other finish turns the ground shading off, which is exactly the old flat paint.
- [x] **B3 Pavements:** warmer tile tones, softer and thinner joints, subtle per-tile value variation.
  - Done 2026-09-30, `paving: 'tiles'` only. It uses a new `paverTiles` surface (mode 21), replacing the concrete
    tiler.
  - Warm tile 0.75/0.68/0.57, blended 80%. ±5% per-tile value and a faint warm/cool drift per tile.
  - 3 mm joints (were 4 mm) that fade into the tile, only 0.8× the tile colour and mixed at 55%, plus a 1.5 cm arris
    roll-off.
  - The granite kerb top warms 45% toward the tile colour under the clean finish.
  - Weathered and slabs cities are unchanged. A saved city on the clean look reloads with the new B1 to B3 look.
- [x] **B4 Facade variety:** (built 2026-09-30)
  - Several facade materials per district (tile, concrete, painted render, metal panel, brick), with fewer and finer joints.
  - Horizontal floor bands and cornices, and a per-building tint within a muted palette.
  - Tone down the fine grain that reads as noise at mid distance.
  - *Done:*
    - `palette.ts` `facadeFor()` picks a material per lot. The weights are district × archetype affinity: downtown
      leans to cladding and tile, the market to render and tile. Each material has muted swatches, and the region's
      tint index leans the pick.
    - Machiya, siding houses, glass towers, the konbini and the warehouse keep their identity material.
    - The trim is derived from the wall, so painted cornices no longer appear on these fronts.
    - New material `'panel'` (metal-panel cladding with windows, facade code 8).
    - Shader joints are finer and lower contrast:
      - tile: 22 × 30 per cell;
      - concrete: 2-bay × 1-storey panels;
      - brick: 9 × 26 per cell;
      - render: smooth value noise instead of hashed squares;
      - panel: 2 × 2 per cell with thin dark joints.
    - Every joint pattern fades to its average when it gets under 2 px.
    - Shader floor bands on every upper storey, plus faint rain streaks on render and concrete.
    - Sub-pixel grain fades with the pixel footprint, now in `windowsPattern().w`. This covers the wall grain, the
      stucco facets, the joint relief and the mode 1–5 hash grain.
    - Trim and parapet stone and flat roof decks use plain larger joints. The shingle-variant noise read as
      graph paper from the air.
    - In the city, part of the flat-roofed masonry stock gets floor-band ledges and a cornice (lot hashes).
    - Tests: `src/world/facade-variety.test.ts`.
- [x] **B5 Palette discipline:** (signs built 2026-09-30; the facades are B4)
  - Buildings are neutral and muted.
  - Sign colours are drawn from a curated set with varied hue and value (not pure primaries), and include white and black lightboxes like real Shibuya signage.
  - *Done:*
    - New `src/world/sign-style.ts`. `SIGN_PALETTES` has a curated set per district mood:
      - nightlife (downtown): rose, teal, amber, violet, vermilion, lime, white, black;
      - food (market): vermilion, cream, mustard, deep green, navy, white, black;
      - shop and quiet (residential) sets.
    - `pickSignColors` gives each building three distinct colours from a lot hash (no rng draw). A city style's
      `neon` joins the pool, tempered. A trio with no value spread gets a white or black box.
    - The konbini and izakaya keep their brand colours.
    - The lettering follows the face colour:
      - cream glowing text on dark and saturated boxes;
      - dark or coloured ink (deep red, navy, green, orange) on white, cream and yellow boxes, drawn 1.3× bolder so
        bloom doesn't eat it;
      - coloured glowing text on black boxes.
    - New layers `bldg:sign-text-c` and `bldg:sign-ink-c`. They ride the existing `detail-sign-text` and
      `detail-sign-ink` glow and LOD rules.
    - White and cream boxes emit 0.72× so they stop blooming into a flat blob at night.
    - The simple (non-detailed) signage palette is re-toned the same way, with the same count and order.
- [x] **B6 Stairs:** their own surface. *(Done 2026-09-30, `terraces.ts`.)*
  - Per-step granite or concrete aligned to each tread and riser, with a contrasting nosing strip (and optional anti-slip grooves).
  - Plain risers, and a plain side-wall panel that matches the retaining wall.
  - As built:
    - Each step is one open profile (tread + riser) through `chipExtrude`, and only visible faces are built.
    - Every step's UVs are centred in their own 2.4 m granite tile. The tone varies step to step, and the tiler's
      joints never reach a face.
    - Treads carry a dark (or, on 35 % of flights, yellow) nosing strip 2.5 cm behind the edge, with ~1.1 cm
      anti-slip grooves (the stripes pattern). It is 4 tris per step.
    - The landing is one flat slab.
    - The stringer is one plain panel in the retaining wall's material, with a coping. Its top follows the nosing
      line; it used to sit one riser low, so the lowest treads poked out. The handrail follows the nosing line too.
    - New layers: `world:stair-nosing` and `world:stair-wall` (the PROPS distance tier now matches `world:stair-`).
    - Tris per stair dropped: seed 3 stairs + nosing + side wall is 636 tris.

## Pass C — Signage content (the "Shibuya" factor)

- [x] **C1 Real sign words:** procedural lettering picks from a Japanese shop/brand word list (ラーメン, 薬, カラオケ, 居酒屋, 本, カフェ, 牛丼, 美容室, 不動産…) instead of random glyphs. (built 2026-09-30)
  - Extend `sign-glyphs.ts` to cover the needed glyphs, or render text into the adverts atlas.
  - *Done (stroke geometry — works in the tile Worker, no canvas or texture):*
    - `sign-glyphs.ts` is now a hand-drawn simplified stroke font of 65 characters (katakana with dakuten and
      handakuten, a few hiragana, 27 kanji), built from polylines on the 0..4 grid.
    - `SIGN_WORDS` holds 32 real trade words in 7 kinds:
      - nightlife: カラオケ / ゲーム / パチンコ / バー / ホテル / スナック …
      - food: ラーメン / 寿司 / 焼肉 / 牛丼 / 定食 / そば / うどん …
      - shop: 薬 / ドラッグ / 本 / 中古 / 花 / 八百屋 …
      - quiet: 内科 / クリニック / 美容室 / 不動産 …
      - konbini, izakaya and lantern.
    - `signWordKind(archetype, district)` picks the list. `BuildingParams.signDistrict` is set by the city.
    - `signWord` fits the word to the slot length.
    - In vertical (tate) runs the long-vowel bar ー turns vertical.
    - Every word reads at street level (see the renders).
    - Budget: 4–15 segments per glyph, 2 tris each (≈16 tris per glyph on average). Lettering on the seed-3 centre
      city is ~76k tris (was ~79k: real words average fewer glyphs than the old random runs).
    - Tests: `sign-glyphs.test.ts`. Every listed character is in the font, and words are real, deterministic and
      sized to the slot.
- [x] **C2 Sign depth:** lightbox frames with side faces, a slight bevel and a soft glow halo at night. Blade signs get brackets. (built 2026-09-30)
  - *Done:*
    - Every procedural sign is a LIGHTBOX (`signBox` / `lightFace` in `building-parts.ts`): tenant signs, floor
      signs, wrap bands, the konbini fascia (one casing with the brand stripes laid on it), blades, sign stacks and
      rooftop billboards.
    - A lightbox is a casing in a per-building frame finish (graphite, aluminium, white or black; layer
      `bldg:lightbox-frame`, painted metal). Its side faces show the depth. It has a 2–3 cm bevelled lip and an
      inset lit face on the old front plane, so lettering and adverts sit exactly where they did.
    - Each stack panel has a top and a bottom wall bracket (was every other panel).
    - The glow halo comes from bloom: the faces stay fully emissive. There's no extra halo geometry.
    - Budget: 22 tris per wall sign (was 12), 32 per blade. The seed-3 centre has 36k frame tris and 6k face tris
      (the old faces were 21k).
- [ ] **C3 Adverts content:** the pool is built (see [../ui/garp.md](../ui/garp.md), Adverts). The user adds images. Consider shipping a small set of original starter images per bucket.
- [x] **C4 Shop interiors and posters:** an image pool like adverts for shop interiors (shelf and product images, posters on the glass), replacing the rainbow shelves when images exist. (built 2026-09-30, see [../ui/garp.md](../ui/garp.md), Shop windows)
  - *Done:*
    - Two more buckets in the signage pool, `interior` and `poster`. No sign classifies into them.
    - They use the same library, packing, GARP pages and `garp.json` persistence. There's a separate `shopShare`.
    - An image-interior bay is a REAL recessed room (0.6–1.1 m) behind a clear pane (`bldg:shop-glass-pane`,
      opacity 0.22, glass). The image is on the back wall, with pale lit walls (`bldg:shop-room`, a new glow row).
      This gives true parallax without touching the shader.
    - Corner bays shared by two shopfront edges stay procedural, so the rooms never cross.
    - Posters go on about half the bays, at eye height, on the glass of image and procedural bays alike.
    - An empty pool gives today's procedural `shopInterior` glass, byte-identical.
    - Host API: `sm.addShopImage3D` / `removeShopImage3D` / `setShopImageLit3D` / `listShopImages3D` /
      `shopImageBuckets3D` / `setShopImageShare3D` / `clearShopImages3D`. Console:
      `salsaGarp.demoShopImages()`.
    - Budget: about 12 tris per image bay (+2 per poster).

## Pass D — Eye-level frontage and facade depth

- [x] **D1 Frontage dressing pass:** denser ground floors from existing props plus a few new ones:
  - awnings, noren curtains, nobori flags, menu and A-boards, potted plants
  - vending runs, bicycles, stacked crates, hanging signs
  - Use `lotMeta` door/front data and the street-slots frontage band.
  - *Built 2026-09-30.*
    - `street-slots.ts` step 14 dresses each door by zone. Step 14b fills commercial frontage at a ~4.5 m pitch.
      Both run last, so no earlier reservation moves. The new kinds are `nobori` and `bikewall`; extra `potted`,
      `crate` and `aboard` slots are emitted by biome and furniture as before.
    - `frontage.ts` (called from `buildFurniture`) emits the nobori: a canonical ~150-tri flag, lettering, pole and
      weighted base. They are GPU-instanced, one layer per flag or lettering colour (7 + 3), and pole + flag +
      lettering share the wind spec, so they sway together. Also noren over small-shop doors (`lotMeta` gained
      `archetype` / `doorW` / `doorH` / `doorY` / `ownNoren` / `ownAwning`, stamped in `streets.ts`), shotengai flag
      rows, and wall bikes, which merge into furniture's bicycle layers.
    - Layer names: `world:frontage-` (added to PROPS_LOD) and `world:noren-door-*` (DETAIL_LOD). Nothing is lit.
    - Toggle: `frontageDressing` (absent = on).
    - Cost on the seed-3 grid city, measured at street level: nobori / noren ≈ +37k tris and ≈ +25 main-pass draws.
      The extra pots (191 × 176 tris), crates and boards add ≈ +35k tris inside existing layers. Total ≈ +2.6 %.
    - Awnings on detailed buildings and hanging signs were left to the building and signage passes, which own
      those facades.
    - Test: `frontage.test.ts`.
- [x] **D2 Window depth:** a slight recess with a frame and sill for every window, plus a ledge per floor band. This is cheap geometry, and the interior mapping already sits behind it. (built 2026-09-30)
  - *Recess:* the recess is in the SHADER and costs no triangles.
    - `windowReveal()` traces the view ray through a hole about 15 cm deep (10 cm on aluminium sash; none on
      curtain, ribbon or shop glass).
    - Jambs, head soffit and sill reveal are shaded wall material. Sash bars, the new slim dark glass frame and the
      blinds and curtains sit at the glass plane, so they have real parallax.
    - The room trace is unchanged, and so is its pinned frame. The reveal has a CPU mirror checked against a
      world-space ground truth in `interior-mapping.test.ts`.
    - Glass also picks up a Fresnel sky reflection, so it stops reading as flat dark rectangles.
  - *Sills:* new param `windowSills` (default on). One instanced 10-triangle sill per upper-floor street window,
    in one of three fixed tones. Layer `world:detail-trim-sill`, DETAIL tier, on purpose.
  - *Ledges:* 11 cm tall and 9 cm proud (were 7 × 7 cm). The shader floor band stands in for them once the DETAIL
    tier culls them.
- [~] **D3 Facade clutter where eyes land:** AC units, pipes and signage brackets on the first 2–3 floors (the building generator already has `utilities`; raise its density near eye level).
  - *Done (2026-09-30):* `emitEyeLevelClutter`.
    - AC condensers on brackets on the STREET faces of storeys 1–3, under sash windows or on wide piers, with
      refrigerant pipe runs into the wall. One grey conduit per face down a corner margin.
    - Deterministic per window (ihash, not the shared rnd stream), at most 6 per building.
    - Never on a party wall or in the sign-stack / blade / screen zone, and skipped on balcony, corridor and juliet
      fronts.
    - Back and side AC is denser on the first 3 storeys.
  - *Left:* signage brackets. They belong to C2 (sign depth, blade brackets) in the signage pass.

## Pass E — Sky, stone and characters

- [x] **E1 Sky:** replace the small drifting "popcorn" clouds with large soft painted cloud cards near the horizon and a few big high clouds. Tie them to the scene preset (golden hour gets lit cloud edges).
  - *Built 2026-09-30.*
    - `sky.ts` horizon banks are now soft radial-fade cards (a body layer plus a sunlit-crown `-rim` layer drawn over
      it) at 2.6–3.1 R. At ~5 R the camera far plane sliced them. Each puff has a concentric core for a painted edge,
      and each bank has a flat underside card.
    - `traffic.ts`: in clear weather, when `paintedClouds` is set, 8 (at density 0.4) big high clouds replace the
      ~200 puffs. They are tilted cards facing the city, drifting on long chords, and excluded from framing.
    - `WorldManager` keeps the new layout param `paintedClouds` in step with the look (the preset / `setPaintedClouds`
      does a movers-only respawn). The glow walk gives the rim cards the sun colour, saturated when the sun is low and
      normalised so it never clips to white. The body gets a zenith + horizon shade, and scene light on the cards is
      cut to 25 %.
    - Legacy look (painted off) and weather decks are unchanged.
    - Cost: −47k tris and −170 meshes versus the legacy movers.
- [x] **E2 Edge chips (hybrid, approved in principle):** *(Done 2026-09-30. See the notes below the list.)*
  - A build-time chip helper cuts small, deterministic chamfers, notches and occasional bites along sharp edges of eligible pieces: stair nosings, kerb and coping ends and corners, plinths, step corners.
  - Mild wear shading from a per-vertex edge distance stored at build time, so no material slot is needed.
  - Only near chunks get the chipped version, through the existing distance LOD.
  - A Look toggle: Edge wear off / subtle / heavy. Also usable by creator props (benches, planters, shrine steps).
  - As built:
    - **Helper.** `chipExtrude` + `edgeChipSpec` in `meshbuild.ts` (added only). A 2D profile is extruded along an
      edge, and flagged corners get an arris plus position-hashed notches, bites and end-corner chips. Each strip
      only takes the stations of its own corners.
    - **Wear shading is geometry.** The chamfer facets plus a thin band beside each chipped arris go to a separate
      `*-wear` layer with the same material, tinted ×1.08–1.09. There is no vertex channel: the city path has no
      vertex colour, and `tangent.w` would need a shader read that NaNs on the (1,0,0)-tangent faces. No flag bit is
      used.
    - **Near only.** `LayoutPreviewLayer.nearTwin { key, role, dist }`. The clean far twin is bit-identical to the
      wear-off build. `chunkCityLayers` splits every layer of a key on one grid (cells ≈ 1.5 × dist), and ground
      twins share the far layer's uv-scale sample, so the texture never jumps.
    - **Renderer.** `Mesh3D.lodTwinRole / lodTwinDist / lodTwinNear` in renderer-3d's LOD loop. Both twins run the
      same hysteresis from the same start state, so exactly one of them draws. No aerial bias. Distance LOD off or
      ortho gives far twins only.
    - **Where.** Stair nosings (`terr-step`), retaining-wall + stringer copings (`terr-cap`, front-top arris, corner
      chips at gaps and run ends), and kerb top arrises (`kerb`, via the new `edge-chips.ts`; kerbs.ts only collects
      the segments).
    - **Control.** `LayoutParams.edgeWear` (a selective rebuild of World Layout + World Terraces),
      `WorldManager.setEdgeWear / edgeWear`, and `CityLook.edgeWear` (applied only when present),
      `salsaWorld.edgeWear()`.
    - **Cost, seed 3 / R10.** Subtle is +~150k tris held (coping 39k, kerb 125k near + wear, stairs ~4k). Heavy is
      +~300k. Browser: 266 twin meshes LOD-hidden at street level (≈295k tris hidden), so only the near chunks draw.
    - **Not done.** Plinths, benches and planters are not chipped yet (`furniture.ts` belongs to another owner). The
      helper's header documents the recipe for creator props.
- [x] **E3 Character outlines:** outlines on characters only (P5 outlines characters, not the city), via the existing mesh-outline / sprite-outline passes. Optional, default off. *(Done 2026-09-30.)*
  - `sm.setCharacterOutlines3D(style | null)` / `getCharacterOutlines3D()`. It applies the per-object outline
    (body + clothes + hair as one union silhouette) to every procedural body, and to bodies created later.
  - The setting is persisted as `characterOutlines` in the scene settings. The default is a near-black 0.012 line.
  - Browser-verified: 2 characters outlined, the ground box untouched, clears cleanly.
- [~] **E4 Pedestrian polish:** smoother heads and torsos (more segments where budget allows), and contact shadows from A3. *(2026-09-30: partial.)*
  - Static-crowd heads went from 7 to 8 sides: symmetric, and matching the hair shell. That is +10 tris
    (avg 538 → 548, budget 560).
  - Torsos and walkers have no budget room left, so they are unchanged. A 10-sided walker head measured 806 tris,
    over the 800 budget; a 10-sided static torso would put the average at ~560.
  - Crowd-live part ranges are unaffected (only the count changed), and the tests pass.
  - Contact shadows: A3 covers the STATIC crowd (`world:ped-*`). Moving walkers, traffic cars and the Play character still have no blob (blobs are made at build time; movers need per-frame blobs). **Status (2026-10-04): moving blobs built** — visual-polish-next #16 (`world.setMoverShadows`, `src/world/mover-shadows.ts`, `world-mover-shadows.ts`); E4 stays partial only for the head / torso budget.

---

## Order and gates

1. **Pass A**, then a user review of street-level screenshots.
2. **Pass B** (B6 stairs can go early, since it's small).
3. **Pass C** (C1 + C2), with the user adding advert images alongside.
4. **Pass D.**
5. **Pass E.**

Each pass ends with the following.
- **Tests:** tsc + the full vitest suite.
- **Renders:** before/after at the same cameras (hero, 2 street spots × 4 directions, one Play third-person view) across Noon, Golden Hour and Night.
- **Measurements:** triangles, draw calls and frame ms (`salsaWorld.frameStats()`).
- **Docs:** status updates in this file, plus the UI doc and Frogmarks handoff for any new control.

## Frogmarks controls expected

- AA mode (Off / MSAA / SMAA).
- Shadow quality (cascades, near distance).
- Contact shadows on/off.
- Edge wear (off / subtle / heavy).
- Character outlines on/off.
- Wiring for any new look fields.

The main session wires these at the end of each pass.
