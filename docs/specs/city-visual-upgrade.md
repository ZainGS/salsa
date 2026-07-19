# City Visual Upgrade — the "Neverness to Everness" anime-city look

> **Deliverable of this pass:** this SPEC only. Built later, one phase at a time, screenshot-tuned. Save as
> `docs/specs/city-visual-upgrade.md` (+ backlog line + memory pointer). Builds on the whole city stack
> ([[world-generation]], [[city-detail]], [[render-styles]], [[post-processing]], [[world-borders]]).

## Context — the target
Reference: **Neverness to Everness** (Hotta Studio / Perfect World) — a stylized-realistic **anime open-world city**:
dense Japanese-flavoured urban sprawl, lush nature bleeding into the buildings, gorgeous atmosphere (aerial-
perspective haze, big painterly clouds, golden-hour warmth), grounded lighting (soft shadows + ambient occlusion),
and rich close-up material/prop detail (wet reflective pavement, ivy on walls, tiled sidewalks, packed street
clutter, storefront signage). The goal is to render **that look** in Salsa's procedural city.

## The key insight (why this is a POLISH problem, not a rebuild)
Salsa's city is **structurally already close** — a clean daylight shot of our bridge + skyline + traffic + sakura is
recognisably the same *kind* of image NTE ships. The gap is not capability; it's **atmosphere · lighting · material
richness · density**. And it splits cleanly by VIEW:

- **AERIAL / diorama shots** (the whole city from above) read great from **fog + sky/clouds + colour grade +
  skyline density + lighting** — all of which we can do **at the current City-Edit-Mode zoom, no street view needed.**
- **STREET-LEVEL shots** read great from **wet pavement, ivy, pavers, dappled shadows, dense prop clutter, storefront
  signage** — fine detail that **only shows when you're down in it**, so it pays off only with a **street-view /
  close-zoom** mode (the LOD-by-view principle: the object generators hold close-up detail, revealed near the camera).

**⇒ We can make a dramatic jump toward NTE *now* in City Edit Mode (Phases 1–5). Street-level detail (Phase 6) is
gated on a future street/close-zoom mode.** Phases 1–5 need no street view.

## Baseline — what already exists to REUSE (don't rebuild)
- **Day/night cycle** (`setTimeOfDay`/`playDayCycle`) — sun sweep + warm horizons, sky gradient, lit windows, glow.
- **Cinematic grade** (`setCinematicGrade` + 4 time-of-day keyframes) → bloom / colour grade / vignette post stack.
- **Shadows** — PCF soft shadows (`shadowParams.w`), shadow-receiving FS variants, NoCull-shadow pipelines, throttling.
- **Point lights ×16** (`setPointLights3D`) — night street lamps / warm pools.
- **Fog** — camera-relative linear (near/far, weather-aware, colour matched to horizon).
- **Clouds** — drifting billboard cloud movers (`cloudDensity`, storm decks), + the `windows`/`waves`/`grid` shader
  pattern modes, **interior mapping** (parallax rooms behind windows), facade grain/stucco, shingle roofs, pattern relief.
- **PBR / IBL lighting**; **render styles** (cel / cel-hd / sketch / ink / gouraud / PBR) + PS1 retro.
- **City content** — buildings by zone + roof variety + signage + awnings + furniture + landmarks + traffic + biome
  (trees/rocks) + water/canals + terraces + weather (rain/snow, wet-road roughness).
- **World-borders** — void grid / apron (nature past the edge) / border glow / tiled worlds.
- **NOT yet:** SSAO (flagged "future"), screen-space reflections, aerial-perspective fog grading, god rays, foliage
  wind/translucency, ivy/decal props, sidewalk paver materials.

---

## Phase 1 — Atmosphere  *(biggest single leap · City Edit Mode)*
The thing that turns "clean low-poly city" into "NTE aerial shot" is **depth + mood**, before any geometry changes.

### 1A · Aerial-perspective fog (the #1 win)
- **Problem:** current fog is a flat haze; NTE fades distant buildings toward a **pale desaturated blue** (real aerial
  perspective) which reads as vast atmospheric depth.
- **Design:** grade fog COLOUR by distance toward a sky-matched pale blue (not one flat colour), and add a mild HEIGHT
  component so low/far geometry hazes more than near/tall. Extend the existing linear fog: `fogColor` becomes a
  near→far ramp toward the horizon sky colour; distant buildings blue-shift + desaturate. Keep camera-relative.
- **Reuse:** the fog uniform (`fogColor`/`fogParams`) + the day/night horizon colour already computed in `_applyTimeOfDay`.

### 1B · Sky + clouds glow-up
- **Sky:** richer multi-stop gradient (deep zenith blue → pale horizon), sun disk + glow halo, subtle gradient banding
  removal (dither). At golden hour, warm the horizon band strongly (already partly done).
- **Clouds:** bigger, softer, **layered** billboard clouds (2–3 parallax layers at different altitudes), painterly
  soft edges (alpha falloff), lit by the sun direction (bright tops / cool undersides). Reuse the cloud movers; add a
  cloud shape/shading pass so they read fluffy/volumetric, not flat sprites.
- **Optional:** a distant cloud BAND on the horizon (the NTE "wall of clouds" behind the skyline).

**Phase 1 params:** `aerialPerspective` (0..1), `skyStyle`/sun-glow knobs, cloud layer count + softness.

---

## Phase 2 — Lighting quality  *(the grounding · City Edit Mode)*
NTE's scenes feel *solid* because of ambient occlusion + soft contact shadows + a warm sky-fill.

### 2A · SSAO (screen-space ambient occlusion)
- New post pass sampling the depth buffer → darkens creases/contacts (building bases, under eaves, tree canopies,
  between props). This is the single biggest "grounded, not floating" cue. Tunable radius/intensity; part of the post stack.

### 2B · Softer + contact shadows
- Widen PCF for softer penumbra (already have `shadowParams.w`); add a short-range contact-shadow term so objects
  sit on the ground even where the cascade is coarse. Tune the city shadow softness toward NTE's diffuse look.

### 2C · Sky-colour ambient / hemisphere fill
- Replace/augment flat ambient with a **hemisphere** term: warm-ish sky colour from above, cool bounce from below,
  so shadows read blue and lit sides read warm (the anime look). Drive it from the day/night sky colour.

**Phase 2 params:** `ssao` (on + radius/intensity), shadow softness, ambient hemisphere strength.

---

## Phase 3 — Colour grade + post polish  *(the finish · City Edit Mode)*
- **Grade to the NTE palette:** push the 4 time-of-day keyframes toward higher saturation + a clean warm/cool balance
  (teal shadows, warm highlights). Reuse `setTimeGradeKey`.
- **God rays / light shafts** at low sun (screen-space radial blur from the sun) — a big golden-hour mood lever.
- **Lens flare / stronger sun bloom** at golden hour; subtle chromatic aberration + vignette already exist — tune.
- **Optional:** a mild sharpen + film-grain-free clean pass so it reads crisp-anime, not muddy.

**Phase 3 params:** grade keyframes (exist), `godRays` (on + intensity), lens-flare toggle.

---

## Phase 4 — Skyline density + building variety  *(City Edit Mode)*
- **Taller, more varied hero towers** — glass curtain-wall skyscrapers with real proportions + setbacks; a denser
  downtown mass so the silhouette reads like a real skyline (NTE's downtown is a wall of varied towers).
- **Glass material** — reflective/specular curtain-wall (sky-tinted), so towers catch the light like NTE's glass.
- Reuse: `buildingHeight` tiers + roof variety + the skyline height-field grading; add a glass-tower building class +
  a reflective material variant.

**Phase 4 params:** downtown density, hero-tower frequency/height, glass-tower fraction.

---

## Phase 5 — Lush integrated nature  *(City Edit Mode)*
- **Denser, lusher trees** — fuller canopies, colour variation, subtle **wind sway** (vertex animation) + a hint of
  leaf translucency (bright rim when back-lit), so foliage reads alive like NTE's hillside forests.
- **Nature blending into the city edge** — hillside forests, green climbing the slopes between buildings (reuse the
  apron + biome; increase density + integrate with terrain/terraces).

**Phase 5 params:** foliage density, wind strength, canopy fullness.

---

## Phase 6 — Street-level material & prop detail  *(needs street-view / close-zoom · LOD-by-view)*
This is the ground-level magic (images of the character walking). It only shows up close, so it's **gated on a
street/close-zoom mode** where the object generators reveal near-camera detail. Deferred, but scoped here:
- **Wet / reflective pavement** — screen-space (or planar) reflections on roads/plaza; roughness already drops in rain.
- **Ivy / vines / moss on walls**, hanging plants, potted plants (decal + small geometry, on close-detail buildings).
- **Sidewalk paver materials** — tiled paving pattern (reuse the shader pattern modes) instead of flat concrete.
- **Dappled tree shadows** on the ground (already have shadows — density + softness at street scale).
- **Dense believable prop clutter** — bikes, crates, cones, vending, signage, planters (extend `furniture.ts`; density
  ramps up at near-LOD).
- **Rich storefront signage / billboards** — the ✦ **brandable-surface** layer (ties directly to the packaging/branding
  money thesis — every sign is a place a real brand goes).

**Phase 6 depends on:** street-view / close-zoom mode + the object generators holding near-LOD detail (see
[[project_street_level_mode]] + the LOD-by-view principle).

---

## Cross-cutting requirements (every phase)
- **Works across the day/night cycle** — every lighting/atmosphere change must lerp correctly from night→dawn→noon→dusk
  (drive from the existing time-of-day pipeline; don't hardcode noon).
- **Respects render styles** — must degrade sensibly under cel / sketch / PS1 (the post/atmosphere is a PBR-path
  concern; cel keeps its own look).
- **Performance** — SSAO / reflections / god rays are post passes with real cost, and tiled Full-view worlds are
  already heavy; gate expensive passes behind quality settings + the render-throttle, and profile (the autosave lesson:
  measure before assuming).
- **Params + persistence** — new knobs land in `LayoutParams`/post-config with `?? default` guards; persist + live-update.
- **Reuse first** — extend fog/grade/shadow/cloud/point-light systems that exist; add new passes (SSAO, god rays,
  reflections) as post stages, not a renderer rewrite.
- **Frogmarks** — a "Look / Atmosphere" panel group (aerial-perspective, sky/cloud, SSAO, god-ray, grade knobs).

## Recommended build order
**1 → 2 → 3 → 4 → 5, then 6 when street-view exists.** Atmosphere (1) + lighting (2) + grade (3) are the quartet that
separates a clean low-poly city from an NTE aerial shot — all City-Edit-Mode, biggest jump for least work, so do them
first *as one pass*. Density (4) + nature (5) deepen it. Street-level detail (6) is the payoff of a future close-zoom
mode. **Start with 1A (aerial-perspective fog) + 1B (sky/clouds)** — those two alone visibly move the aerial view
toward the reference.

## Open questions (decide per phase)
- Aerial fog: a true depth-graded fog colour, or a cheaper 2-colour near/far lerp? (start cheap.)
- SSAO quality vs cost on tiled Full-view — a quality tier, or auto-off for large tiled worlds?
- Do we want a dedicated "NTE" style pack (one call sets the whole atmosphere/grade/palette), like the existing city
  style packs? (Probably yes — it makes the look one-click.)
- Street-view (Phase 6): a separate camera mode, or just "zoom past a threshold in City Edit Mode swaps to near-LOD"?
