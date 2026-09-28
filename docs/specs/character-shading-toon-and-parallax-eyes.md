# Character shading: skin toon-ramp + parallax eyes — design

**Status:** Part A (skin toon-ramp) ✅ BUILT 2026-09-27 (1516 tests; WGSL browser-unverified). Part B (parallax eyes)
📝 PLANNED — not started.

**Part A — what shipped:** `Material3D.skinRamp` (flag **bit 29**) marks a material's skin as toon-ramped; the LOOK is
scene-global — `SkinRampSettings` (bands / softness / shadowFloor / warm shadowTint) packed into a new
`skinRampParams` vec4 appended to the scene uniform (floats 204-207; buffer 816→832 bytes, `SCENE_UNIFORM_SIZE_PADDED`).
Shader: a `skinRamp()` helper (identical copy in `skinning-shaders.ts` + `mesh3d-shaders.ts`) bands the **soft-lit**
`NdotL` — applied right after the half-Lambert `mix()` in the vertex-Gouraud path — and warm-tints the shadow band;
returns `.rgb`=tint, `.a`=ramped ndl. **No-op when the flag is off** (returns white + unchanged ndl → bit-identical to
before). The skinned struct was extended (lightCounts + pointLights + skinRampParams) so the tail field resolves. APIs:
`sm.setSkinShadingMode3D(id,'classic'|'ramp')` / `getSkinShadingMode3D` (per-mesh opt-in, live) +
`sm.setSkinRampSettings3D(patch)` / `getSkinRampSettings3D` (the global look). Persists: flag rides the material in
`Mesh3D.toJSON`; look in `GlobalScene3DSettings.skinRamp`. **Classic default** — new characters unchanged; opt in per
call. +2 flag tests, scene-uniform offset test extended. ⚠ browser-verify the visual + confirm un-opted meshes identical.
**Frogmarks UI guide:** `docs/ui/character-shading.md` (soft lighting + skin ramp — API, panel mockup, wiring).

Original plan below.

---

Two independent visual upgrades for procedural characters, designed to the **same safety contract we used for
soft-lighting**: each is an **opt-in, parallel system that coexists with the current behaviour**, defaults OFF, needs
**no migration**, and leaves every existing mesh / scene / saved document **pixel-identical** until you turn it on.

The overriding requirement (user's, verbatim intent): *"I should be able to use the current eye system still OR use the
new system so that I can perform testing and decide on what I like and easily make changes to either still
individually."* So both features below are built as **A/B-switchable dual systems**, not replacements.

---

## 0. The coexistence contract (applies to BOTH features)

These rules are non-negotiable and are what make the work safe + testable:

1. **Dual-path, never in-place.** The old code path stays exactly as-is and remains fully usable. The new path is a
   *second* path selected by a flag/mode. Nothing about the old path is edited except to read "am I selected?".
2. **A live per-character toggle.** One API flips a character between `classic` and the new system at runtime, with
   **no reload**, so you can eyeball them back-to-back. (`setSkinShadingMode3D`, `setEyeSystem3D`.)
3. **Independent, side-by-side settings.** The classic settings and the new settings are stored in *separate* fields
   and both persist. Switching to the new system and back does **not** discard your classic tuning, and tuning one
   never mutates the other.
4. **Default = classic.** New characters and all existing saves resolve to the current look. You opt a character in.
5. **Zero-risk-when-off.** With the mode off / strength 0, the shader branch must be provably a no-op — bit-identical
   output. (Same property soft-lighting already has.)
6. **WGSL is runtime-compiled** → every shader edit is **browser-verify-only** (tsc/vitest can't catch it). Each phase
   verifies an *un-opted* mesh is unchanged before the next phase touches content.

---

# PART A — Skin toon-ramp

## A1. What it is / why

Half-Lambert (shipped) *softens* the diffuse curve so skin never goes black. A **toon-ramp** *shapes* that curve into
**discrete bands** with a controllable terminator — the crisp lit-zone / shadow-zone split that reads as painted
anime/Pokémon skin. They **stack**: soft base + a clean 2-band ramp on top is the SV/ZA face recipe. The *tone* of the
ramp (a warm, slightly-red shadow — not just "darker skin") matters as much as the banding.

This is deliberately a **skin modifier**, not a global render style: it composes with whatever `renderStyle` the mesh
already uses and only affects the diffuse `NdotL` term (specular / rim / sheen untouched).

## A2. Where it lives in the pipeline

Characters shade through the **vertex Gouraud** path (skinned VS + regular mesh3d VS — skin has no normal map), same
place soft-lighting's `mix()` already lives. The ramp is applied to the **same `ndl` value**, right after the
half-Lambert remap:

```
ndl_soft = mix(max(dot(N,L),0), dot(N,L)*0.5+0.5, softStrength)   // existing
ndl_out  = applyRamp(ndl_soft, rampParams)                        // NEW, gated
```

So the two features are naturally ordered (soften, then band) and each is independently zeroable.

## A3. `applyRamp` — the banding function

A small, branch-free quantiser with a soft terminator:

```
// bands ≥ 1; softness in (0,1] = terminator half-width in ndl units; shadowFloor lifts the darkest band
fn applyRamp(ndl: f32, bands: f32, softness: f32, shadowFloor: f32) -> f32 {
    let stepped = floor(ndl * bands) / bands;             // hard bands
    let next    = stepped + 1.0 / bands;
    let edge    = fract(ndl * bands);                      // 0..1 within the current band
    let soft    = smoothstep(0.5 - softness, 0.5 + softness, edge);
    let v       = mix(stepped, next, soft);               // soft terminator between bands
    return shadowFloor + (1.0 - shadowFloor) * v;         // lift the shadow so it's a tone, not black
}
```

- `bands = 2` → one terminator (the anime default). `bands = 3` → a subtle mid-tone.
- `softness` near 0 = razor terminator (cel), higher = painterly.
- `shadowFloor` keeps the dark band a *tone* (0.35-ish) rather than crushing to ambient.
- **Shadow tint** (the warm-red shift) is applied where the lit colour is composed: `tint = mix(shadowTint, white,
  ndl_out)` multiplied into the diffuse, so the shadow band leans warm. Tint defaults to a faint desaturated
  rose; at `(1,1,1)` it's a no-op.

At `bands=1, softness=1, shadowFloor=0, tint=white` this is **exactly** a smooth Lambert/half-Lambert (identity) — the
off state.

## A4. Flag + storage

- **Flag:** `Material3D.skinRamp?: boolean` → `encodeMaterialFlags` **bit 29** (`536870912`). Marks *which* materials
  opt in (default: procedural body skin, only for newly-created characters).
- **Params:** four scalars (`bands`, `softness`, `shadowFloor`) + one tint colour. Two viable homes:
  - **(recommended) Scene-global**, mirroring `softLightStrength`: a `SkinRampSettings` block in
    `GlobalScene3DSettings`, packed into currently-spare scene-uniform slots. Cheapest (no stride bump, one test
    update), and skin tends to want one consistent look per scene. `setSkinRampSettings3D({bands, softness,
    shadowFloor, shadowTint})`.
  - **(alt) Per-material**, packed into the skin's free `patternParams` slots (skin is a "plain" material, so those
    instance floats are unused). Enables per-character ramps but is more plumbing.
  - **Decision A-1 needed** (see §D). Start scene-global; the per-material path can layer on later without a format
    break (the flag already gates it).

## A5. Toggle / API

- `setSkinShadingMode3D(bodyId, 'classic' | 'ramp')` — flips `skinRamp` on the body's skin material (+ marks
  `materialDirty` / `stateDirty`). Live, no reload. `getSkinShadingMode3D(bodyId)`.
- `setSkinRampSettings3D(partial)` / `getSkinRampSettings3D()` — the global ramp tuning (bands/softness/floor/tint).
- New body creation: apply `skinRamp: false` (classic) by default, OR `true` — **Decision A-2** (do new characters
  start classic or ramped?). Recommend **classic default** so nothing changes look without an explicit opt-in, with the
  toggle one call away.

## A6. Phases (each independently verifiable; stop if one looks wrong)

- **A0 — confirm shape.** Temporarily hard-wire `applyRamp` on the skin at `bands=2` and eyeball the terminator; revert.
- **A1 — flag + encode.** `skinRamp` bit 29 + `material-flags.test.ts` cases (set/clear; composes with softLighting bit
  28 + hasTexture). Pure TS, no visual change.
- **A2 — scene params.** `SkinRampSettings` in `GlobalScene3DSettings` + pack into scene uniforms + `scene-uniforms`
  offset test. Identity defaults (bands 1 / tint white) so nothing renders differently yet.
- **A3 — shader.** Add `applyRamp` + shadow-tint to the two Gouraud paths, gated on `(flags & bit29)`. **Browser-verify
  an un-flagged mesh is pixel-identical**, a flagged box bands correctly.
- **A4 — apply + toggle.** Wire `setSkinShadingMode3D` / `setSkinRampSettings3D`; opt new-body skin in per the A-2
  decision. Round-trip persistence test.
- **A5 — tune.** Browser session to find the default band/softness/tint that reads as "clean skin". This is where the
  time goes; the code is small.

---

# PART B — Parallax eye system

## B1. What it is / why

Current eyes = a single flat Canvas2D composite on an unlit decal quad (`eye-generator.renderEyes` → one texture →
`a<0.01` cutout). It reads flat because it *is* flat. The upgrade is a **shader-based parallax eye** that fakes a
curved, wet cornea with an iris sunk behind it — the thing that makes anime/Genshin eyes look 3D rather than sticker.

Three tricks, in order of impact:
1. **Parallax iris.** Offset the iris/pupil UV by the view direction (in the decal's tangent frame) scaled by a depth
   param → the pupil appears to sit *behind* a curved surface; it shifts as the head turns. This is the big one.
2. **View-locked catchlight.** Draw the highlight on the "cornea plane" (opposite/zero parallax) so it slides across
   the eye as the view moves — the wet glint.
3. **Unlit + bright.** Eyes bypass scene lighting so they stay readable when the face is shadowed. (The decal is
   *already* unlit emissive — so this is free; the classic system already benefits.)

## B2. Coexistence design — the two systems share the decal, differ in texture layout + shader branch

The decal mesh, skinning, blink driver, gaze, persistence plumbing, and UV-paint drawing flow are **100% shared and
unchanged**. The two systems differ in only two places:

| | **Classic (existing)** | **Parallax (new)** |
|---|---|---|
| Texture | 1 flat composite (array layer 0) | 3 layers: 0 = socket (sclera+lids+lashes, no parallax), 1 = iris+pupil (parallaxed in), 2 = catchlight (parallaxed out) |
| Generator | `renderEyes()` (unchanged) | `renderEyesLayered()` (NEW — reuses all the same drawing code, just routes each layer to its own canvas) |
| Shader | current skinned-textured FS (`a<0.01` discard) | same FS + a gated parallax branch (new flag) that samples the 3 layers at per-layer offsets and composites |
| Depth | none | `eyeDepth` param (per-rig) + view-vector parallax |

Because the diffuse is **already a `texture_2d_array`**, the 3 layers cost **no new bind groups** — layer 0 is exactly
what classic uses, so a classic decal is just "parallax with only layer 0 present".

## B3. Layer split (the only real content change)

`renderEyesLayered(params, aspect)` runs the **existing `drawEye` logic** but into three canvases:
- **Socket layer:** sclera fill + upper/lower lids + lashes + double-eyelid + outer flicks + under-deco. (Everything
  that is "the frame", drawn at zero parallax so the opening stays put.)
- **Iris layer:** iris gradient + limbal ring + pupil, on transparent bg. Gaze offset still applies here.
- **Catchlight layer:** the `highlights[]` dots, on transparent bg.

This is a mechanical refactor of the current single-pass `drawEye` — the *same* primitives, split by destination. The
classic `renderEyes` single-composite function is left in place untouched.

## B4. Shader (parallax branch)

Gated on a new flag (`eyeParallax`, **bit 30**). Only the face decal ever sets it. In the skinned-textured FS:

```
// tangent frame of the flat decal is trivial: T = +X (u), B = -Y (v), N = face normal
// v = normalize(view dir in tangent space); depth = eyeDepth (small, e.g. 0.04)
let par = v.xy / max(v.z, 0.2) * depth;
let socket = textureSample(diffuseArr, samp, uv,            layer0);   // no offset
let iris   = textureSample(diffuseArr, samp, uv - par,      layer1);   // sink behind
let glint  = textureSample(diffuseArr, samp, uv + par*0.6,  layer2);   // float above
// composite back-to-front over transparent, alpha-cut the whole thing on socket bounds
```

- `max(v.z, 0.2)` clamps grazing angles so the offset can't explode.
- Sampling must be **unconditional** (uniformity), then composited — same rule the alpha-cut outline shader follows.
- All three layers are **unlit** (emissive path) exactly as the decal already is.
- Off state: if the flag is absent the FS takes the existing single-sample path → classic decals unaffected.

## B5. Flag + storage + params

- **Flag:** `Material3D.eyeParallax?: boolean` → **bit 30** (`1073741824`). Set only on the decal when a rig is in
  parallax mode.
- **Params (per face-rig, additive to `FaceRigState` JSON):**
  - `eyeSystem?: 'classic' | 'parallax'` (default `'classic'`).
  - `eyeDepth?: number` (parallax strength, default ~0.04).
  - `catchlightSlide?: number` (how much layer 2 counter-moves, default ~0.6).
- **Independence:** the classic composite texture and the 3 parallax layers are stored/keyed separately (`__face__:…`
  vs `__faceL0/L1/L2__:…`), so switching modes keeps both sets. Tuning eye params in one mode never regenerates the
  other.

## B6. Toggle / API

- `setEyeSystem3D(bodyId, 'classic' | 'parallax')` — regenerates the active expression into the right texture layout,
  sets/clears `eyeParallax` on the decal, live. `getEyeSystem3D(bodyId)`.
- `setEyeParallaxParams3D(bodyId, {eyeDepth, catchlightSlide})` / getter.
- Existing eye APIs (`setFaceExpressionProcedural3D`, `setFaceGaze3D`, blink, draw-mode) work in **both** systems — they
  feed the generator, which routes to 1 or 3 layers based on mode.

## B7. Phases

- **B0 — spike parallax.** Temporarily feed the current composite as layer 0 + a hand-made iris as layer 1, hard-wire
  the parallax branch, confirm the sink/slide reads right in the browser. Throwaway.
- **B1 — flag.** `eyeParallax` bit 30 + `material-flags.test.ts`. No visual change.
- **B2 — layered generator.** `renderEyesLayered` (refactor of `drawEye` into 3 destinations) + a unit test that the 3
  layers composited == the classic single composite (proves the split is lossless). Classic `renderEyes` untouched.
- **B3 — shader branch.** Parallax sampling gated on bit 30. **Browser-verify a classic decal is unchanged** (flag
  off), then a parallax decal sinks/slides.
- **B4 — mode + persistence.** `setEyeSystem3D` regenerates active expr into the right layout; `FaceRigState` gains the
  additive fields; round-trip test (save in each mode, reload, both retained). Blink/gaze verified in both.
- **B5 — tune.** Browser session for `eyeDepth` / catchlight defaults; decide the shipping default depth.

## B8. Honest risks / limits (parallax eyes)

- **Flat-decal parallax is an approximation.** It fakes cornea curvature on a (near-)flat surface; at extreme side
  angles the illusion weakens. Acceptable for a stylized face; the `max(v.z, …)` clamp prevents blow-up.
- **Layer memory.** 3 array layers per decal instead of 1 (still one small texture; negligible, but noted).
- **Content authoring.** The layered generator must keep the *look* identical to classic when composited (B2 test
  guards this) so switching to parallax at depth 0 looks like classic — a good sanity anchor.
- **Drawn (hand-painted) expressions.** Freehand-drawn eyes are a single painted image with no layer separation. v1
  parallax targets **procedural** eyes (which have structured layers). A drawn expression in a parallax rig falls back
  to layer-0-only (= classic look) — call this out; layer-separated painting is future work.

---

## C. What this plan deliberately does NOT do

- No new render style (the enum is full); both features are **modifier flags** (bits 29 / 30).
- No change to the classic eye composite, the blink driver, gaze, UV-paint drawing, skinning, or the decal geometry.
- No global lighting default change; no migration of existing characters; no stride bump (scene-global params).
- No real refraction/POM, no per-eye geometry — parallax is the stylized fake, on purpose.

## D. Decisions (LOCKED 2026-09-27)

- **Order: Part A first** (skin ramp) — smaller, safer, pairs with soft-lighting. Part B (parallax eyes) after.
- **A-1: Scene-global** ramp params. Rationale: Pokémon/Genshin technically use per-material ramp textures, but every
  character shares one authored house style, so scene-global reproduces the *look* with far less plumbing; the flag
  gates it, so per-material can layer on later without a format break.
- **A-2: Classic default** for new characters — nothing changes look without an explicit `setSkinShadingMode3D` opt-in.
- **B-1: Classic default** for eyes too (decided upfront) — opt in per character until parallax is tuned.

## E. Test / verification checklist (per the constraints)

- `npx tsc --noEmit` clean + `npx vitest run` green after every phase.
- New unit tests: bits 29 & 30 (`material-flags.test.ts`); scene-uniform offsets for ramp params; `renderEyesLayered`
  composite-equivalence.
- Browser-verify (user): (1) un-opted meshes pixel-identical; (2) skin ramp bands + warm shadow; (3) eyes sink/slide;
  (4) toggle both directions live with no reload; (5) save→reload retains both classic + new settings independently.
- ⚠ All WGSL is browser-unverified until the user checks it.
</content>
</invoke>
