# Advanced Shaders & Materials — gemstones, rocks, glass, glow, and the effects layer (spec)

**Date:** 2026-08-25 · **Status:** planned (spec only) · **Companions:** `procedural-material-library.md` (stylized surfaces — stone/wood/grass), `render-styles.md` (cel/ink/sketch/PBR lighting), `post-processing.md` (bloom/grade/vignette), `wall-materials.md`, `ssao.md`, `procedural-ground.md`, `hover-outline.md`, `car-creator.md` (matcap note).

## Why

Salsa already has **stylized surfacing** (the procedural material library: stone, shingle, grass, brick, metal, water, neon) and **lighting styles** (PBR, cel, ink, sketch). What it does *not* have is the **"jewel" layer** — the materials and effects that make something read as *precious, energetic, or otherworldly*: a faceted gemstone that fires colored sparkle, marble with real veining, glass you can see *through* (not just reflect off), a glowing animated outline, a plasma/portal surface. These are the materials that make a hero object or a data-viz node **pop**, and they're the visual vocabulary of "content worth posting" and of a polished interactive product.

This spec catalogs that layer, grounded in the **exact extension points** the engine already exposes, and phases it cheap-high-impact first. It also answers the interactive-world-map / supply-chain-data question (§9) — because that use case is mostly *assembly of things that already exist* plus a couple of these new materials.

## How the engine extends (the three real insertion points)

From the architecture (mesh3d-shaders.ts / material-3d.ts / post-process-pass.ts):

1. **New per-mesh material** = one **flag bit** in `encodeMaterialFlags` (material-3d.ts:354) + a field on `Material3D` + a WGSL helper + a gated branch in `fs_main` (mesh3d-shaders.ts, ~lines 2080–2125). It reuses the two spare instance slots `patternColor: vec4` + `patternParams: vec4` (mesh3d-shaders.ts:1643). **No new pipeline.** Add it to `_usesPatterns` (renderer-3d.ts:1654) so it takes the full (non-plain) shader.
2. **New lighting style** = extend the `RenderStyle` union + `styleMap` (material-3d.ts:20/355) + a `*_lighting` fn in style-shaders.ts + a branch at mesh3d-shaders.ts:2129.
3. **New screen-space effect** = a pass in `PostProcessPass.run()` (post-process-pass.ts:233) + an FS in post-process-shaders.ts + a config in `DEFAULT_POST_PROCESS_CONFIG`. Reflections/refraction that need scene geometry data want a **G-buffer prepass** — `ssao-pass.ts` is the exact template (it already writes a world-position `rgba32float` target).

> ⚠️ **The slot-starvation constraint is real and shapes this whole spec.** Every special material "rides" the `patternColor`/`patternParams` instance slots, and **they are mutually exclusive per mesh** — a mesh can be a gemstone *or* a window *or* water, not two at once. Pack aggressively (`packRGB8`/`unpackRGB8`, material-3d.ts:293). If a material needs more than 8 floats of params, it needs either a small per-material UBO or to sacrifice a feature. Call this out per-material below.

---

## 1. Gemstones & crystals

The headline family. A gemstone is: a **hard Fresnel rim** (bright edges), **internal depth** (fake refraction / a glow core), and **dispersion** ("fire" — colored sparkle that shifts with view/light). We already have `F_Schlick`, `sparkleGlint`/`sparkleStar`, and `envSpecular` — a gem is those composed with a tint and a view-dependent hue shift.

| Material | Look | Technique (reuses) | Params (slots) |
|---|---|---|---|
| **Faceted gem** (ruby/sapphire/emerald) | deep tinted body, bright facet edges, sparkle "fire" | Fresnel body tint + `envSpecular` reflection + `sparkleStar` modulated by a hue-rotated dispersion term | tint (packed), fire intensity, facet scale, IOR-ish rim power |
| **Diamond / white gem** | near-colorless, maximum sparkle + rainbow dispersion | as above, tint≈white, dispersion drives an HSV sweep on the glint | dispersion strength, sparkle density |
| **Jade / opal** | soft internal glow, milky subsurface, opal = shifting color patches | thin-film iridescence fn (§3) + a low-freq value-noise "cloud" driving emissive | base tint, glow, patch scale, iridescence |
| **Obsidian / onyx** | black glass, sharp specular streaks, faint depth | low roughness + strong `envSpecular` + dark body, subtle interior parallax (reuse `interiorRoom`, line 333) | tint, streak sharpness |
| **Amethyst / geode cluster** | banded crystal, translucent tips glowing | banded value noise along local Y + tip emissive by height (`groundHeightM`-style) | band colors (packed), tip glow |

**Shared new WGSL:** `gemFire(N, V, L, dispersion) -> vec3` (hue-rotate the specular by `dot(N,V)` so color shifts across facets) and `dispersionHueShift`. One flag bit `gemShade`; a `gemType` sub-selector in `patternParams.x` (like ground/window sub-types) keeps it to **one bit** for the whole family. **Cost:** cheap (algebra + existing sparkle), P1.

---

## 2. Rocks, minerals & ore

The "natural material" counterpart — matte, structural, but with the geological detail that sells a boulder, a marble column, or a supply-chain **ore node**.

| Material | Look | Technique | Params |
|---|---|---|---|
| **Granite / speckled stone** | matte base + multi-color mineral speckle | 2–3 octave hash speckle over base (extends the brick per-tile tint at line 260) | base + 2 speckle colors (packed), grain scale |
| **Marble** | smooth base with flowing colored veins | domain-warped ridged noise for veins, `mix` over polished base + soft specular | base, vein color, vein freq, warp |
| **Ore / metallic inclusions** | rock matrix with embedded shiny metal flecks (gold/copper/iron) | speckle mask drives a *per-fleck metalness+F0* blend into the PBR term | matrix color, ore F0 (packed), density |
| **Sandstone / strata** | horizontal sediment banding, dusty | Y-banded color ramp + high roughness + fine grain | band colors, band freq |
| **Slate / schist** | layered, slightly reflective cleavage planes | directional anisotropic streak (reuse hair-sheen tangent math) + cool tint | tint, layer sharpness |

**Reuse:** the ground library already has speckle/weathering/relief machinery (`groundSurface`, `groundWeather`). Several of these could ship as **new `groundMode` sub-surfaces** (bit 18) rather than a new bit — marble/granite/ore are "a stone surface with veining," conceptually identical to ashlar/cobble. That's the cheapest path and keeps them AI-authorable by name like the rest of the library. **Cost:** low–medium, P2.

---

## 3. Glass & transparency (the real-refraction gap)

Today "glass" is **Fresnel sky-reflection only** (fs_main:2863) + window **interior parallax** (`interiorRoom`) — no true see-through. Three tiers:

- **P1 (cheap, no new infra): frosted / tinted / thin-film glass.** All doable in the uber-shader now.
  - **Frosted**: existing alpha-blend transparent pass + roughened Fresnel + a blurred-sky approximation (sample SH along a jittered normal). No refraction needed.
  - **Tinted**: Beer-Lambert absorption tint by view thickness proxy (`1 - dot(N,V)`).
  - **Thin-film iridescence** (soap bubble / oil / dichroic glass): `thinFilm(cosTheta, thickness) -> vec3` interference color. New WGSL fn, reused by opal/pearlescent too.
- **P2 (real refraction): screen-space refraction.** Sample the *already-rendered opaque scene texture* offset by the surface normal — the standard "grab-pass" refraction. Needs the scene color available to a later transparent pass (we already render opaque→then transparent; expose the opaque result as a bound texture). This is what makes a glass gem, a potion bottle, or a magnifying lens read correctly. Medium effort; **the highest-value single addition** for the whole gem/glass family.
- **P3: thickness / volume.** Depth-difference (back-face depth − front-face depth) for absorption that deepens with thickness — real colored glass. Needs a back-face depth prepass (cheap, mirrors shadow pass).

> ⚠️ **Ortho-safety.** Any screen-space refraction/reflection that reconstructs a world position from depth **must not** use the `cameraPos + rayDir·distance` trick — it silently breaks under the orthographic camera (documented failure in `ssao-versions.md`). Reconstruct from the inverse view-projection, or sample a world-position G-buffer like SSAO does.

---

## 4. Glow, outlines & energy effects

Outlines already exist three ways (MeshHighlightPass stencil-expand, SilhouetteOutlinePass screen-space, OutlinePass Sobel ink). This family is about making them **glow and animate**, plus surface-level energy.

| Effect | Look | Technique (reuses) |
|---|---|---|
| **Glowing rim / emissive Fresnel** | object edges bloom with color | `rimEnabled` already exists → route rim into the **emissive** term so BloomPass picks it up (bloom is already wired). One extra "rim→bloom" toggle. |
| **Animated energy outline** | pulsing / scanning / dashed silhouette | extend `MeshHighlightPass` `HighlightStyle` (already supports patterned/animated bands) with time + pattern params; feed emissive so it blooms. |
| **Hologram** | scanline flicker, transparency, chromatic edge, jitter | new material bit: scanline mask (reuse waves mode 7 math) + Fresnel alpha + emissive tint + slight vertex jitter (reuse PS1 jitter). |
| **Force-field / shield** | Fresnel-bright transparent dome, hex pattern, impact ripples | Fresnel alpha + hex `patternMask` variant + radial ripple emissive. |
| **Selection/data pulse** | a node that "breathes" glow to draw attention | animated emissive scalar via `frameLink`-style time; no geometry change. |

**Reuse:** bloom + emissive is the entire trick — anything you push into `emissiveColor` with intensity >1 blooms for free. Most of this family is "compute an emissive mask." **Cost:** low, P1 (glow rim + animated outline are the two to ship first).

---

## 5. Metals & car-paint (real matcap + anisotropy)

Metals work today via PBR `envSpecular`, but there's **no matcap sampler** and no anisotropy.

| Material | Look | Technique |
|---|---|---|
| **Brushed / anisotropic metal** | directional highlight streak (brushed aluminum, satin gold) | anisotropic GGX using the mesh tangent (hair-sheen already carries tangent) |
| **Real matcap** | art-directed sphere-map shading, no lights needed | **new** `texture_2d` matcap sampler indexed by view-space normal → uv. The one genuinely new *sampler* in this spec; enables the "GT-style car sheen" the car-creator wanted without a full lighting rig. |
| **Iridescent / patina metal** | oil-slick or aged-copper color shift | thin-film (§3) over metal F0 |
| **Gold / copper / chrome presets** | correct colored F0 | just F0 presets over existing PBR — trivial, ship as named materials |

**Cost:** presets are free (P1); anisotropy low (P2); **matcap** is the one item needing a new bind — medium (P2/P3), but high aesthetic ROI and directly unblocks car-creator.

---

## 6. Liquids, lava & exotic

The "wow" tail — lower priority, high spectacle.

- **Lava / magma**: emissive cracked-crust (value noise threshold) with glowing fissures scrolling; reuse waves + emissive.
- **Plasma / portal**: swirling domain-warped emissive with Fresnel edge; a great "landmark/teleport" node.
- **Liquid / potion**: refraction (§3 P2) + tint + a meniscus rim + optional animated surface.
- **Velvet / fabric sheen**: inverse-Fresnel (brighter at grazing) — cloth already wants this; a `sheen` term.
- **Subsurface (wax/skin/jade/marble)**: cheap wrapped-diffuse + back-light transmission (foliage already has `foliageTransmission` — generalize it to a `sssShade`).

**Cost:** each is a self-contained emissive/noise material; P3–P4, pick by what a scene needs.

---

## 7. Post-processing additions

Bloom/grade/vignette exist. Additions that compound the materials above (all via the `PostProcessPass.run()` chain):

- **Chromatic aberration** (cheap) — sells glass, energy, retro looks.
- **Depth of field** (medium) — needs scene depth (available); huge for hero-object/product shots and the cinematic camera exports.
- **God rays / volumetric light** (medium) — radial blur from a bright source; pairs with gems/emissive.
- **Film grain + lens dirt** (cheap) — texture; already have retro/PS1 leanings.
- **Heat haze / distortion** (cheap-ish) — screen-space UV warp, localized; lava/portal/engine.
- **Screen-space reflections (SSR)** (hard) — the big one; needs a G-buffer (SSAO template) + ray-march. Defer to P3+; **screen-space refraction (§3 P2) is the cheaper 80% of the value** for our gem/glass goals.

---

## 8. Environment & reflection upgrade (the shared foundation gap)

The single thing that would lift **every** reflective/refractive material (gems, glass, metal, water, car paint) is a **real environment**:

- **Today:** 9 SH coefficients (`IBLUniforms`) for irradiance + a *procedural* sky/ground hemisphere fake for specular (`envSpecular`). No cubemap.
- **P2 add:** a **prefiltered environment cubemap** (or an equirect skybox texture) sampled by the reflection vector — turns "fake gray reflection" into "reflects the actual sky/scene." One new sampler on group 0; roughness → mip level. This is the highest-leverage infrastructure item; do it before/with the exotic materials, not after.
- **P4:** dynamic/local reflection probes.

---

## 9. Interactive world map / supply-chain data-viz — is it hard?

**Short answer: no — it's mostly assembly of parts that already exist, plus 2–3 materials from this spec. The rendering is days-to-weeks; the bulk of the real work is your *data model, calculations, and UI*, which live host-side in Frogmarks, not in the shader engine.**

What a supply-chain material map needs, and what already exists to build it:

| Need | Reuse (already in Salsa) |
|---|---|
| The map/globe surface | Textured sphere primitive, or extruded per-country/region meshes; **choropleth coloring** via per-instance tint (already in the instance data) or a new `dataChoropleth` ground-mode driven by a value→color ramp |
| Region hover → detail card | `SilhouetteOutlinePass` per-object sub-ranges (`outlineRanges` — highlight one country out of a merged mesh) + the **HTML-in-canvas hover card** (`scene3d-html-textures.ts`) already used for landmark info cards |
| Click a node → drill in | `mesh-picker.ts` (BVH raycast) — already per-mesh pickable |
| Supply routes / trade flows | **Animated arcs** between locations — `createRibbonMesh`/tube with a scrolling emissive (glowing flow), or the `_boneLinePipe` line overlay for thin links |
| Material nodes (mines, refineries, ports) | **Gemstone / ore materials** (§1/§2) on billboards or small meshes — a lithium node literally rendered as a glowing crystal; **billboards** + `refreshBillboards3D` for labels that scale/face camera |
| Data labels / values | **HTML-in-canvas text** (LiveText) for crisp numbers/labels; `font-variant-numeric` etc. |
| Zoom from globe → region → facility | The **tiled-world streaming** engine + **spatial-streaming** + LOD already handle "load detail for where you're looking"; the **free-camera** + **cinematic cameras** give you flythroughs and recorded explainer clips |
| Time-series / animation | The **animation timeline** + keyframes (animate node values, arc intensity, camera cuts over time) |
| Highlight / attention | §4 glow-pulse materials to draw the eye to a stressed supplier |

**What you'd actually build (the real work, host-side):**
1. A **data → scene binding layer** (Frogmarks): map rows (region, material, tonnage, price, risk) → node positions, colors, arc weights. This is TypeScript app logic, not engine work.
2. **Calculations** (supply/demand, cost, risk scoring): pure host logic; the engine just *displays* the results. This is where most of your time goes and where the product value is.
3. A couple of **new materials** from this spec (choropleth ramp + glowing arc + gem/ore nodes) — P1-cheap.
4. **UI panels** (filters, drill-downs, calc readouts) — standard Frogmarks Angular.

**Honest effort read:** the 3D map *visualization* is a **medium** engine/assembly task because the hard primitives (streaming, picking, hover cards, billboards, arcs, text, camera) are done. The **data pipeline + calculations + product UI is the larger, open-ended part** and is a normal app-development effort, independent of Salsa. The shaders in this spec make it look *premium* (glowing gem nodes, energy trade-arcs, choropleth) rather than "colored dots" — which is exactly the difference between a demo and something you'd sell.

> This could warrant its own spec (`data-viz-worldmap.md`) once you decide to pursue it — it'd reuse this material work + the world/streaming stack + the scene-authoring API. Flag it and I'll write it.

---

## 10. Phasing

- **P1 — cheap, high-impact (ship first):** gemstone family (§1, one `gemShade` bit + `gemType` sub-selector), glow-rim→bloom + animated energy outline (§4), frosted/tinted/thin-film glass (§3 P1), metal presets (§5). All uber-shader-only, no new pipeline/sampler. Plus one post add (chromatic aberration).
- **P2 — the refraction/reflection foundation:** screen-space refraction (§3 P2), the environment cubemap (§8), marble/granite/ore as ground-modes (§2), anisotropic + matcap metal (§5), DOF (§7).
- **P3 — volume & screen-space:** glass thickness/absorption (§3 P3), SSR (§7/§8), hologram/force-field (§4), lava/plasma/portal (§6).
- **P4 — exotic tail + probes:** subsurface generalization, iridescent everything, dynamic reflection probes, god rays, heat haze.

## 11. Gotchas (learned from the existing shader work)

- **Pattern-slot exclusivity** (§How-it-extends): a mesh is one special material at a time; the `gemType`/sub-selector pattern (one bit, many variants) is how the library stays bit-frugal — copy it.
- **fwidth uniformity:** all `fwidth`/`dpdx` calls run **unconditionally** at fragment top (WGSL uniform-control-flow rule) — new pattern-relief must follow the `PATTERN_BLOCK_FULL`/`PLAIN` split or it bloats plain meshes.
- **Ortho-safety:** never reconstruct position via `cameraPos + rayDir·distance` — breaks the orthographic camera (SSAO lesson). Use inverse-VP or a world-pos G-buffer.
- **Pipeline warm-up:** new material **flags are free**; a new **pipeline state combo** (blend/cull) multiplies across plain/full × shadow × textured/untextured and grows warm-up time — avoid unless necessary. Transparent materials already have a transparent pipeline; refraction that needs the opaque scene texture may need one new bind, not a new pipeline family.
- **Slot packing:** use `packRGB8`/`unpackRGB8` to fit two colors in one float; several library materials already do — gems/rocks will need it.
- **No backticks in WGSL comments** (breaks the template-literal shader source) — a standing engine rule.
- **Emissive = bloom** is already wired: the cheapest "glow" for any effect is to write intensity>1 into `emissiveColor`; don't build a new glow pass.

## 12. Not doing (this spec)

- Path-traced / offline-quality refraction, caustics, true volumetrics.
- A node-graph material editor (that's a separate authoring-tool spec).
- Per-material UBOs beyond the instance slots unless a P2+ material truly needs it.
- The data-viz app itself (§9) — separate spec when you commit to it.
