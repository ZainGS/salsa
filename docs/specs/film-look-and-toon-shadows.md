# Film look + coloured toon shadows — spec

**Status:** ✅ Phases 1, 2 and 3 BUILT 2026-09-28 (film look · toon shadows + rim · line boil) — tests + WGSL static
check green; **browser-unverified** (WGSL compiles at runtime). ⏳ Phase 2b (per-MATERIAL shadow tint) deferred: skin
already gets its own warm tint (skin ramp) and everything else the scene tint.
**Goal:** get Salsa to the *Orbitals* / 90s-OVA look: cel-shaded characters and environments whose shadows are
**colour-shifted** (not just darker), a crisp **rim light**, soft **film** texture (grain, slight colour fringing,
halation around glowing screens), and optionally **hand-drawn line boil** on outlines.
**Rule:** every feature is **opt-in and off by default**, so saved scenes render exactly as they do today.

Reference traits and where each lands:

| Trait in the reference | Feature |
|---|---|
| Shadows are a darker, more saturated, cooler hue (blue/purple on clothes and walls; warm on skin) | **B. Toon shadows** |
| Thin, bright, slightly hard edge light on the side of forms | **C. Rim light** |
| Film grain; soft colour fringing towards the frame edges; warm glow bleeding around bright screens | **A. Film look** |
| Slightly irregular, living ink lines | **D. Line boil** |
| Dark inked outlines on characters and props | ✅ exists (per-mesh outlines + stacked rings; screen-space edge outline for non-skinned) |
| Painted surfaces, emissive screens, moody point lights, vignette | ✅ exists (UV paint, emissive + bloom, 16 point lights, grade, vignette) |

---

## What exists today (the facts this builds on)

- **Post-processing** (`post-process-pass.ts`): bloom → colour grade → vignette, all **off by default**. Grade and
  vignette share one shader (`PP_GRADE_VIG_FS`) and a 48-byte uniform, of which floats 9–11 are free padding. It is
  configured by `setPostProcessing3D({...})` and **persisted** in the global scene settings (`postProcess`). It has no
  time uniform. Quirk: with only vignette enabled, any stored non-neutral grade values also apply.
- **Skin toon-ramp** (material flag bit 29 + `scene.skinRampParams`, floats 204–207): bands, softness, shadow floor
  and a warm shadow tint. It is computed **per-vertex in the vertex shaders**, but the fragment shaders use that
  vertex colour **only in the `'gouraud'` style**. So on a Cel / Cel-HD / default / Sketch / Ink character, the skin
  ramp currently has **no visible effect**. Frogmarks' Body → Skin Shading → "Ramp" control is wired, but only shows
  in Gouraud. This spec fixes that as part of B.
- **Cel / Cel-HD** (`style-shaders.ts`): per-pixel, **3 hard-coded bands**, plain `max(N·L,0)`, no tint.
- **Rim** (flag bit 7 `rimEnabled`): exists after the style branch in both fragment templates, but the constants are
  hard-coded (`pow(1−N·V, 3) · 0.42 · lightColor`).
- **Scene uniform:** 212 floats / 848 B. `styleParams` (floats 208–211): `.x` = Sketch paper; `.yzw` free. It is
  declared in 4 WGSL copies (mesh3d VS, both fragment templates, skinning). The static check
  (`wgsl-static-check.test.ts`) now guards `scene.<field>` reads against each module's struct.
- **Material flags:** bits **30 and 31 are the only free ones**. The render-style field (bits 2–4) is full (8 styles).
- **Per-instance data** (`MeshInstance`, 240 B) has **no spare slot**. Growing it means updating ~10 struct copies,
  guarded by `mesh-instance-layout.test.ts`.
- **Outlines:**
  - the per-mesh inverted hull, which expands along the normal in `highlight-shaders.ts` (regular `:104`, skinned
    `:247`) and already has `screen.z` = time, with `screen.w` free;
  - the screen-space edge pass (`enableOutlines3D`), which **does not draw skinned meshes**;
  - the hover silhouette pass.

---

## A. Film look (post-process) — Phase 1

New `film` block in `PostProcessConfig`, persisted with the rest of `postProcess`:

```ts
sm.setPostProcessing3D({ film: {
  enabled: true,
  grain: 0.06,          // 0..0.3  luminance-weighted animated grain (strongest in the mid-tones, like film)
  grainSize: 1.5,       // px      grain cell size (1 = per-pixel, 2–3 = chunky 16 mm)
  aberration: 0.0025,   // 0..0.01 radial RGB split, grows towards the frame edges (0 at the centre)
  halation: 0.35,       // 0..1    warm tint on the BLOOM (glowing screens bleed orange-red, like film halation)
  halationTint: [1.0, 0.45, 0.3],
} });
```

- **Where:** fold into the grade+vignette pass. It already samples the lit image once per pixel; aberration becomes
  three offset samples, and grain is added last so it sits on top. The order in the shader is: aberration sample →
  grade → vignette → grain.
- **Halation** tints the existing bloom composite (`PP_BLOOM_COMPOSITE_FS`) instead of adding a new blur: it
  multiplies the bloom by `mix(1, halationTint, halation)`.
- **Uniform:** grow `GradeVigParams` from 48 to 64 bytes: grainAmt, grainSize, aberration, timeSec, plus the halation
  tint in the bloom uniform. Pass `timeSec`, world-speed scaled, so grain freezes with `freezeWorld`.
- **Enable bits:** add explicit per-effect enables so "film only" doesn't also apply stored grade values (fixes the
  quirk above for new configs; old configs keep their behaviour).
- **Grain animation:** hash of (pixel / grainSize, floor(time · 24)), stepping at 24 fps like film. Weight
  `4·l·(1−l)` so blacks and whites stay clean.
- Cost: ~4 extra texture samples per pixel in an existing pass. Negligible.

## B. Coloured toon shadows — Phase 2 (the big visual win)

Make the ramp a **per-pixel** toon shade that works in the **Cel and Cel-HD** styles, for **every** material, with a
coloured shadow.

**B1 — scene-wide toon ramp (no per-mesh cost).**
- New scene params `toonParams` (scene uniform, floats 212–215 → 216 floats / 864 B):
  - bands (1–4),
  - softness,
  - shadow floor,
  - a **shadow hue shift** (packed: hue, saturation boost, value).
- When a material is Cel / Cel-HD **and** the new flag **bit 30 `toonShadow`** is set, the style branch computes:
  ```
  band   = smoothstep-banded(N·L, bands, softness)
  shadow = hueShift(diffuse, hue, +sat, ×value)      // "anime shadow colour": darker, more saturated, cooler
  lit    = mix(shadow, diffuse, band) · light + emissive
  ```
  This replaces the hard `floor(N·L·3)/3`.
- Cel with bit 30 off stays **bit-identical** to today.
- One scene setting then gives every object blue-purple shadows.

**B2 — per-material shadow colour (optional, later).** Skin wants warm shadows while clothes want cool ones. Either:
- **(a)** grow `MeshInstance` to 256 B with a `toonParams` vec4 (shadow tint rgb + strength), guarded by the layout
  test; or
- **(b)** a tiny per-material palette: a scene array of 8 shadow tints, with the material storing a 3-bit index in
  `patternParams`. Only valid if patterns and toon don't co-exist; to be decided.

Recommend (a): cleaner, and it leaves room for more per-material style knobs.

**Skin:** the existing `skinRamp` (bit 29) becomes a **per-material override inside the same per-pixel path**. Skin
uses the skin-ramp tint, everything else uses the scene hue shift. This finally makes Frogmarks' "Ramp" skin control
visible in Cel. The old per-vertex Gouraud skin ramp stays for the Gouraud style.

**Characters in one call:** `setCharacterToonShadows3D(bodyId, on)` sets bit 30 on the body, clothes, hair and eye
decal (the eyes stay unlit).

## C. Rim light — Phase 2 (ships with B)

Parameterise the existing bit-7 rim (it is already in both fragment templates):
- `styleParams.y` = rim strength (0 = today's constant path is used unchanged when this is unset);
- `styleParams.z` = rim width (the power exponent → how thin);
- `styleParams.w` = rim hardness (0 = today's soft falloff, 1 = a crisp toon step);
- rim colour = new scene floats (in `toonParams` or a following vec4).

A **hard toon rim** (step at the width threshold, tinted, only on the lit/back-lit side) is the Orbitals edge light.
The API is scene-wide: `setRimLight3D({ strength, width, hardness, color })`; the per-mesh on/off stays
`material.rimEnabled`. Default strength 0 → the old hard-coded rim, bit-identical.

## D. Line boil — Phase 3 (optional polish)

Hand-drawn lines "boil": each redraw is slightly different, typically at 8–12 fps.
- Add `wobble` (0–1), `wobbleFreq` and `boilFps` to `HighlightStyle` (per-mesh outlines + rings). They go in a new
  vec4 in `HighlightParams` (a per-outline uniform buffer, so no scene or instance layout change).
- In the hull VS (`highlight-shaders.ts:104` and `:247`), scale the expansion by
  `1 + wobble · noise(worldPos · freq + floor(time · boilFps))`. This gives a stepping, uneven line thickness.
- The screen-space edge outline can jitter its sample offsets the same way (later).
- Default `wobble 0` → identical outlines.

## E. Out of scope / notes

- The **screen-space edge outline doesn't include skinned meshes.** Characters rely on per-mesh outlines, which is
  fine for this look. Adding skinned meshes to the depth/normal pre-pass is a separate item.
- **Painterly textures** are content (UV paint). **Soft background blur / depth-of-field** would add to the look but
  isn't planned here.

---

## Phasing, API, verification

| Phase | Ships | Layout changes | Risk |
|---|---|---|---|
| 1 | A: film look | post uniform 48 → 64 B (own buffer) | low: post pass only, off by default |
| 2 | B1 toon shadows + C rim + skin ramp in Cel | scene uniform 212 → 216/220 floats; flag bit 30 | medium: every mesh fragment path; guarded by the WGSL static check |
| 2b | B2 per-material shadow tint | `MeshInstance` 240 → 256 B | medium: ~10 struct copies; guarded by the layout test |
| 3 | D line boil | `HighlightParams` +16 B | low |

**New API (ShapeManager):**
- `setPostProcessing3D({ film })` (extends the existing call)
- `setToonShadows3D({ bands, softness, shadowFloor, hue, saturation, value })` / `getToonShadows3D()`
- `setMeshToonShadow3D(meshId, on)`
- `setCharacterToonShadows3D(bodyId, on)`
- `setRimLight3D({ strength, width, hardness, color })` / `getRimLight3D()`
- Outline style fields `wobble` / `wobbleFreq` / `boilFps`

Scene-wide values persist in the global scene settings; per-mesh flags persist on the material.

**Frogmarks UI (sketch):**
- **Scene → Film:** Grain, Grain size, Colour fringing, Halation (+ tint).
- **Scene → Toon shadows:** Bands, Softness, Shadow floor, Shadow hue / saturation / darkness, and a Rim group.
- **Object → Material:** a "Toon shadows" checkbox (Cel styles), and a "Rim light" checkbox (it exists as a flag
  today).
- **Character → one toggle** "Toon shadows (whole character)".
- **Outline:** Wobble, Boil speed.

**Verification:**
- The WGSL static check and the layout tests must stay green.
- Unit-test the packers: uniform offsets, flag bit 30, and the defaults reproduce today's values.
- The rest is **browser-only**:
  - a scene with every flag off must look **pixel-identical** to before;
  - then toggle each feature on a character and a prop.
- Use the existing pixel-verify harness (as done for dither) where possible to diff "all off" against the current
  build.

**Order to build:** 1 → 2 → 3. Phase 1 is small and independent. Phase 2 gives most of the Orbitals look. Phase 3 is
polish.
