# Face-shading fix — plan (the "dark triangle" on anime faces)

**Status:** ✅ BUILT 2026-09-27 (1514 tests; WGSL browser-unverified). Implemented per the locked decisions.
Original plan preserved below.

**What shipped:** `Material3D.softLighting` (flag **bit 28**) marks a material as soft-lit; the AMOUNT is a
scene-GLOBAL strength stored in the spare `lightColor.w` scene-uniform slot (no per-instance stride bump). Shader:
the vertex Gouraud diffuse (skinned VS + regular mesh3d VS — the path characters actually use, since skin has no
normal map) does `ndl = mix(max(dot(N,L),0), dot(N,L)*0.5+0.5, s)` where `s = softLightFlag ? scene.lightColor.w : 0`
— so `s=0` (or flag off) is bit-identical to before. The **PBR fragment path is deliberately NOT changed** (its
`NdotL` multiplies specular too; and skin uses the Gouraud path anyway). New procedural body skin gets
`softLighting=true`; strength defaults to **0.6**. APIs: `sm.setSoftLightingStrength3D(v)` / `getSoftLightingStrength3D`
(the global slider) + `sm.setMeshSoftLighting3D(id,on)` (per-mesh flag). Persists: flag rides the material in
`Mesh3D.toJSON`; strength is in `GlobalScene3DSettings.softLightStrength`. No migration — only NEW characters get it.
+2 flag tests, scene-uniform offset test updated. ⚠ browser-verify the visual.

---

## 1. The symptom

Close-up of a procedural character shows a hard-edged **dark triangle across the face** (nose / brow / cheek
region). It looks like a shading blotch, not part of the design. It's most visible up close.

## 2. Diagnosis (what the code actually does)

Two external readings guessed this was **received shadows** or **bad/stale face normals**. I traced the code; both
are ruled out:

- **NOT received shadows.** Skinned characters *cast* shadows (`skinnedShadowPipeline`, a depth pre-pass) but do
  **not receive** them. The skinned colour pipelines use layouts `[mesh, texture, skin]` / `[mesh, skin]`
  (`pipeline-3d.ts:140-141`) — there is **no shadow bind group** — and their fragment shader is the base
  (non-shadow) variant (`SKINNED_MESH3D_FRAGMENT_SHADER_*` = `MESH3D_FRAGMENT_SHADER*`, no `sampleShadow`). So
  "make the face not receive shadows" is a **no-op** here — it already doesn't.
- **NOT SSAO.** Skinned meshes are excluded from the SSAO world-position prepass, so no ambient-occlusion term
  touches the face.
- **NOT stale/hard normals.** `body-generator.ts:1065-1092` already recomputes **smooth, area-weighted** vertex
  normals after all the pushes (nose, etc.), per-face oriented outward. The face normals are smooth.

**Actual cause:** plain **Lambert diffuse** (`NdotL`) on the face's genuine 3-D form. The nose/brow push the surface,
so part of the face normal-faces away from the directional light → `NdotL` drops → a dark region. It is
"physically correct" lighting; it just looks wrong for a **flat-shaded anime** face. This is the classic anime-model
problem, and the classic fix is a **softer lighting model on skin**, not a geometry or shadow change.

Confidence: high, but Phase 0 below confirms it empirically before we touch anything.

## 3. Constraints that shape the fix

- The **face is not a separate mesh/material** — it's part of the one procedural **body** skinned mesh (skin =
  face + neck + arms + torso, one material). Hair and clothes are *separate* meshes/materials. So any per-material
  change applies to the **whole skin**, not just the face. That's acceptable (and anime-appropriate — flat skin
  everywhere), and it means clothes/hair are unaffected unless separately flagged.
- Characters render through the **PLAIN** skinned fragment shader (`_usesPatterns` is false for characters), so the
  lighting math to change lives in the plain mesh3d FS path (shared by the full FS — change both for consistency).
- Material flags travel as a **raw u32** now (all 32 bits usable; bits 0-27 taken, **bit 28+ free**), so a new flag
  is cheap and collision-free.
- WGSL compiles at runtime — any shader edit is **browser-verify-only** (not caught by tsc/vitest).

## 4. Options

| # | Approach | What it does | Blast radius | Risk |
|---|----------|--------------|--------------|------|
| **A (recommended)** | Per-material **soft / half-Lambert** flag | `ndl = dot(N,L)*0.5+0.5` (wrapped) instead of `max(dot(N,L),0)` when the flag is set — the dark side lifts to mid-grey, keeping subtle form. Applied to the skin material. | Only meshes with the flag (skin). Default-off → **zero** change to all existing content. | Low. One gated branch in the FS lighting; opt-in. |
| B | **Flatten the toon ramp** on skin | For toon/cel skin, snap the ramp so the face is one flat tone. | Same (per-material). | Low-med. Only helps cel-styled skin; less general than A. |
| C | **Fill light / lift ambient** | Raise `ambientColor` or add a fill light so nothing goes fully dark. | **Global** (whole scene). | Med. Washes out every material, not just skin. Rejected as the primary fix. |
| D | Separate **face material** + flatten only the face | True per-face control. | Body-generator surgery (new material slot + UV/region split). | **High.** Big change to a system whose save path was recently stabilized. Rejected for now. |
| E | Tweak the **light direction** so the face isn't side-lit | Move the sun. | Global; fragile (breaks other angles/poses). | Rejected. |

## 5. Recommendation

**Option A: a per-material `softLighting` (wrapped-diffuse / half-Lambert) flag, opt-in, applied to the skin
material.** It's the standard anime fix, is per-material (no global impact), defaults off (no risk to existing
scenes), and needs only a small gated branch in the FS lighting. Half-Lambert keeps a little form (better than fully
unlit) while removing the hard dark triangle.

Optionally expose a 0..1 **strength** later (lerp between Lambert and wrapped) if full half-Lambert is too flat —
but ship the boolean first.

## 6. Phased plan (each phase independently verifiable; stop if a phase looks wrong)

- **Phase 0 — CONFIRM the cause (no permanent change).** Temporarily hard-set the skin's lighting to wrapped/flat (or
  render `N` as colour) in a throwaway edit and confirm the dark triangle is `NdotL`, not something else. Revert.
  *Gate: only proceed if wrapping the diffuse removes the triangle.*
- **Phase 1 — the flag.** Add `Material3D.softLighting?: boolean` + encode as **bit 28** in `encodeMaterialFlags`
  (+ its doc comment). Pure TS; add a `material-flags.test.ts` case (bit 28 set/clear, composes with others). No
  visual change yet (nothing sets it).
- **Phase 2 — the shader branch.** In the mesh3d FS lighting (plain **and** full variants, so skinned + regular
  agree), read the flag and compute `ndl = select(max(dot(N,L),0.0), dot(N,L)*0.5+0.5, softLighting)`. Guard: the
  branch must not disturb specular/rim/other terms; verify the plain-shader contract test still passes. Browser-
  verify a flagged box looks softly lit and an un-flagged box is pixel-identical to before.
- **Phase 3 — apply to skin.** Set `softLighting: true` on the procedural body's skin material at creation
  (`createProceduralBody3D` / the body material setup) and expose `sm.setMeshSoftLighting3D(id, on)` so the host
  can toggle it. Persists for free (material serialized in `Mesh3D.toJSON`; verify round-trip).
- **Phase 4 — browser verify + tune.** Confirm the dark triangle is gone on the face, the body still reads with
  some form (not pancake-flat), clothes/hair unchanged. If too flat, wire the optional strength (0..1) lerp.

## 7. Risks & mitigations

- **WGSL runtime compile** — a shader typo shows only in the browser. Mitigate: minimal, obviously-correct branch;
  Phase 2 verifies an un-flagged mesh is unchanged before Phase 3 touches the body.
- **Whole-skin flatten** (face + body) — intended, but if the body looks too flat, the strength lerp (Phase 4)
  dials it back. Clothes/hair are separate materials → never affected.
- **Existing saved characters** — default-off means old scenes are unchanged; Phase 3 only flags *newly created*
  bodies. A saved character won't get the softer face until re-created or toggled via the new API (call it out to
  the user; optional: a one-time migration that flags existing skin materials on load).
- **Rollback** — the whole feature is one flag; clearing `softLighting` (or reverting Phase 2/3) restores exact
  prior behavior. No geometry, persistence-format, or pipeline-layout changes.

## 8. What this plan deliberately does NOT do

- Does not touch shadows (irrelevant here), SSAO, normals, the body geometry, or the light rig.
- Does not add a separate face material (Option D) — too invasive for the payoff.
- Does not change any global lighting default.

## 9. Decisions (LOCKED 2026-09-27)

1. **Whole skin** — soften lighting on the entire skin material (face + arms + torso). No separate face material.
2. **No migration** — apply only to **newly created** characters; existing saved characters keep their current
   (default-off) look until re-created or toggled via the API.
3. **Strength slider from the start** — a 0..1 value (0 = normal Lambert, 1 = full half-Lambert), not just a boolean.
   - Implementation note: with a strength float, the shader is `ndl = mix(max(dot(N,L),0), dot(N,L)*0.5+0.5, s)` —
     at `s=0` it's **bit-identical** to today, so **no flag bit is needed**; the strength value alone gates it.
     Storage: either a dedicated instance float (another small stride bump like `uvTransform`, fully covered by the
     layout test) or reuse the unused `patternParams` slot for plain materials (skin is plain). Pick during Phase 1;
     dedicated float is cleaner, slot-reuse avoids a stride change. New body skin default: **~0.6**.

## 10. Expected visual result & new issues (what to expect before we build)

**What half-Lambert does:** normal Lambert clamps `NdotL` to `[0,1]`, so a surface turned away from the light goes to
**0** (only ambient) — a hard dark region (the triangle). Half-Lambert remaps it to `NdotL*0.5+0.5`, so the away-side
lifts to a **soft mid-tone** and the light "wraps" gently around the form. The strength slider lerps between the two.

**Expected result on the character:**
- The **dark triangle on the face dissolves** into an even, soft skin tone — the face reads flat/anime.
- The **whole skin** (arms, torso, neck) shades more evenly and softly — a cel/anime look rather than a
  form-revealing realistic one.
- Skin gets **overall a bit brighter** (the dark side is now mid, not black), so average skin luminance rises.
- Specular/rim/sheen are **untouched** (only the diffuse `NdotL` term changes), so the skin keeps some liveliness
  where it has a highlight.
- At `strength 1` it's flattest (almost no light-direction gradient); ~`0.5-0.7` keeps subtle form while killing the
  hard dark side. Default ~0.6.

**New visual issues to expect (honest list):**
1. **Flatter body form.** Softening removes the shadowing that reads musculature/curves — desirable for anime,
   "pancake-y" for a realistic body. → the strength slider is the dial; lower it for more form.
2. **Brighter skin overall.** The lifted dark side raises average brightness; a character may look lighter than
   before. → if it's too bright, lower strength, or the user can drop the skin albedo / light intensity. (We are NOT
   auto-compensating albedo — that'd be surprising; the slider is the control.)
3. **Skin-vs-clothes contrast.** Clothes and hair keep normal Lambert (not flagged), so the **skin will look flatter
   than the sweater**. Usually fine, but under strong side-light the mismatch can read slightly odd. → if it bugs
   you, we can flag clothes too (a follow-up; you chose "whole skin" for now).
4. **No dramatic/moody shadowing on skin.** The character never gets a truly dark side, so a horror/dramatic
   lighting setup won't shade the face moodily. Anime-appropriate; note it for cinematic scenes. → lower strength or
   toggle off per-shot.
5. **No regression risk to non-characters.** Default strength 0 on everything except new skin → every existing mesh,
   scene, prop, and saved document renders **exactly as before**. This is the key safety property.

Nothing here creates a *broken* look — the trade is "flatter, brighter, more anime" vs "form-revealing, can go
harshly dark." The slider spans that range.
