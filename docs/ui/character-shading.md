# Character Shading — Soft Lighting + Skin Toon-Ramp (Frogmarks UI guide)

Two **anime/Pokémon-style skin looks** for procedural characters, both **opt-in and independent** so you can turn each
on/off per character and compare:

1. **Soft lighting** (half-Lambert) — lifts the dark side of the face so it never cuts a hard "dark triangle"; the skin
   reads soft and flat. A **global strength slider** dials it from normal → fully flat.
2. **Skin toon-ramp** — bands the (soft-lit) skin into discrete tones with a crisp terminator + a warm shadow tint; the
   painted-cel skin look. A **global look** (bands / softness / shadow tint) shared by every ramped character.

They **stack**: soft base + a clean 2-band ramp = the SV/ZA face recipe. Both default **off** on existing content and
new characters get soft lighting only (ramp is opt-in). Everything **persists** with the document; the panel only reads
and writes the settings.

> **Updated 2026-09-28 — which render style shows what.** The skin ramp used to be computed per-vertex and was only
> visible in the **Gouraud** render style — on a **Cel / Cel-HD** character, "Ramp" did nothing. It now also works
> **per-pixel in Cel and Cel-HD** (same bands / softness / shadow depth / tint). A saved Cel character that already had
> Ramp selected will now show it. For the **clothes and hair** to get matching coloured shadows, see
> [Toon shadows for the whole character](#toon-shadows-for-the-whole-character-cel-styles) below.

> Coexistence contract: turning either on/off is **live (no reload)**, and each character's on/off state + the two
> global looks are stored separately — flipping one never disturbs the other, and both survive save/reload. So you can
> A/B a character freely while you decide what you like.

## Engine API

```ts
// ── Soft lighting (wrapped / half-Lambert) ──
sm.setMeshSoftLighting3D(meshId, on: boolean): boolean         // per-character opt-in (the body/skin mesh)
sm.setSoftLightingStrength3D(v: number): void                  // GLOBAL "skin softness" 0..1 (0 = normal, 1 = flattest)
sm.getSoftLightingStrength3D(): number

// ── Skin toon-ramp ──
sm.setSkinShadingMode3D(meshId, mode: 'classic' | 'ramp'): boolean   // per-character toggle (live, no reload)
sm.getSkinShadingMode3D(meshId): 'classic' | 'ramp'                  // 'classic' = smooth; 'ramp' = banded
sm.setSkinRampSettings3D(patch): void        // GLOBAL look; merges + clamps; partial is fine (one field at a time)
sm.getSkinRampSettings3D(): SkinRampSettings // { bands, softness, shadowFloor, shadowTint }
```

- Per-character setters return `false` if the mesh id doesn't resolve. Pass the character's **body (skin) mesh id**.
- The two `Settings`/`Strength` calls are **scene-global** — one look for the whole cast (the "house style"), like the
  soft-light strength. They apply only to characters that are opted in.
- New procedural characters are created with **soft lighting on** (strength 0.6) and **ramp off** (classic). Existing
  saved characters are untouched until you toggle them.

## The controls

### Soft lighting
| Control | Call | Meaning |
|---|---|---|
| Enabled (per character) | `setMeshSoftLighting3D(id, on)` | Marks this character's skin as soft-lit. |
| Skin softness (global) | `setSoftLightingStrength3D(0..1)` | `0` = normal Lambert (form-revealing, can go dark) · `~0.6` = default · `1` = flattest anime. |

### Skin toon-ramp — `SkinRampSettings` (global)
| Field | Type | Meaning |
|---|---|---|
| *(mode, per character)* | `'classic' \| 'ramp'` | `setSkinShadingMode3D(id, …)`. `classic` = smooth (soft-)Lambert; `ramp` = banded. |
| `bands` | `number` (1–8) | Number of tone bands. **2** = one terminator (the anime default); 3 = a subtle mid-tone. |
| `softness` | `number` (0–1) | Terminator half-width. ~`0.02` = razor cel edge · ~`0.1` = painterly. |
| `shadowFloor` | `number` (0–1) | How dark the darkest band is. Higher = the shadow stays a **tone** (not black). Default `0.4`. |
| `shadowTint` | `[r,g,b]` 0..1 | Warm shadow colour (mixes toward white as the surface faces the light). Default a faint rose `[0.82,0.66,0.68]`; `[1,1,1]` = neutral. |

**Ramp defaults** (`setSkinRampSettings3D({})` / on first use): `bands 2`, `softness 0.08`, `shadowFloor 0.4`, warm-rose
tint. So a character just needs `setSkinShadingMode3D(id,'ramp')` to get a clean look; tune the globals from there.

### Examples
```ts
// Soften a character's face, then flatten it fully
sm.setMeshSoftLighting3D(bodyId, true);
sm.setSoftLightingStrength3D(0.8);

// Turn on banded skin + a harder cel edge with a cooler shadow
sm.setSkinShadingMode3D(bodyId, 'ramp');
sm.setSkinRampSettings3D({ bands: 2, softness: 0.02, shadowTint: [0.72, 0.62, 0.7] });

// Compare: flip back to smooth skin (both looks keep their settings)
sm.setSkinShadingMode3D(bodyId, 'classic');
```

## Suggested panel

A **Skin Shading** section on the selected character. The two **global** sliders can also live in a scene/style panel
since they affect the whole cast — but showing them here (labelled "global") is fine while you tune.

```
▾ Skin Shading   (selected character)
  ☑ Soft lighting                    → setMeshSoftLighting3D(id, on)
  Skin softness   ●────── 0.6  (global) → setSoftLightingStrength3D(v)      0..1

  Skin style   ( ) Classic  (•) Ramp    → setSkinShadingMode3D(id, 'classic'|'ramp')
  ── Ramp look (global) ──               (show when Ramp selected)
  Bands        ●──  2                    → setSkinRampSettings3D({ bands })       1–4 typical
  Softness     ●──  0.08                 → setSkinRampSettings3D({ softness })    0–0.3
  Shadow depth ●──  0.4                  → setSkinRampSettings3D({ shadowFloor }) 0–0.8
  Shadow tint  ■  [rgb picker]           → setSkinRampSettings3D({ shadowTint })
```

Wiring notes:
- Populate from `sm.getSkinShadingMode3D(id)`, `sm.getSoftLightingStrength3D()`, `sm.getSkinRampSettings3D()` on select.
- Every setter schedules the render — **no redraw call needed**, and no persistence work (both save/reload with the doc).
- The ramp fields are **global**: changing them affects every ramped character. If you later want per-character ramps,
  the engine's flag already gates it — that's a small follow-up, no format change.

## Toon shadows for the whole character (Cel styles)

The skin ramp only covers the skin. To give the **hair and clothes** the same kind of banded, **coloured** shadow
(anime-style: the shadow is the colour × a tint, a touch more saturated, not just darker), use the toon-shadow
controls — also only visible in **Cel / Cel-HD**:

```ts
sm.setCharacterToonShadows3D(bodyId, true);      // body + hair + every garment + charms (regenerated parts keep it)
sm.setToonShadows3D({ bands: 2, softness: 0.04, shadowValue: 0.62,
                      shadowTint: [0.74, 0.68, 0.96], saturation: 0.25 });   // GLOBAL look (lavender = purple/blue shadows)
sm.getToonShadows3D();
```

- **Skin keeps its own look**: a skin with Ramp on uses the skin-ramp settings above (warm tint); everything else
  uses the toon-shadow settings (cool tint). That's the classic anime split — warm skin shadows, cool clothes.
- `shadowValue` = how bright the shadow is (0–1); `shadowTint` = its colour; `saturation` = extra richness.
- Pairs with the **rim light** (`setCharacterRimLight3D(bodyId, true)` + `setRimLight3D({ strength, width, hardness,
  color })` — strength 0 = the original rim) and the film look. Details: `docs/specs/film-look-and-toon-shadows.md`,
  and the Frogmarks handoff `frogmarks-update-2026-09-28.md`.

**Suggested panel addition** (under Skin Shading, or a per-character "Style" section):
```
  ☐ Toon shadows (whole character)     → setCharacterToonShadows3D(bodyId, on)   (note: Cel / Cel-HD styles)
  ── Toon look (global) ──
  Bands ●── 2 · Softness ●── 0.04 · Shadow brightness ●── 0.62 · Shadow tint ■ · Saturation ●── 0.25
  ☐ Rim light                          → setCharacterRimLight3D(bodyId, on)
  Rim: Strength ●── 0 (0 = original) · Width · Hardness · Colour ■   → setRimLight3D({...})
```

## Retro colour on chosen objects only (PS1 colour depth + dither) ✅ 2026-09-29

The PS1 **Color Depth** and **Dither** used to apply to every 3D mesh. They can now apply to **opted-in objects
only**: e.g. characters banded at colour depth 3 with dither, while the environment keeps full colour.

```ts
sm.setRetroColorScope3D('optIn');            // 'all' (default: everything, as before) | 'optIn'
sm.getRetroColorScope3D();                   // → 'all' | 'optIn'
sm.setCharacterRetroColor3D(bodyId, true);   // body + clothes + hair + charms; returns the mesh count
sm.setMeshRetroColor3D(meshId, true);        // any single mesh (a prop, a GLB…)
sm.getMeshRetroColor3D(meshId);              // → boolean (read a character's state from its body id)
```

- **Colour depth and dither values** are still set as before (`setPS1Config({ colorDepth, dither, ditherStrength })`).
  The scope only decides **which meshes** get them. Vertex jitter / snap / affine / UV quantize stay scene-wide.
- **Everything persists:** the scope rides in the PS1 settings, and the per-object opt-in rides on each mesh's
  material. Regenerated hair / clothes / charms inherit the opt-in from the body, like toon shadows.
- **Existing scenes look identical:** scope defaults to `'all'`, and an old document loads as `'all'`.
- A retro preset (`setRetroPreset3D`) keeps the current scope; the `'off'` preset resets it to `'all'`.

**Suggested UI** (built in Frogmarks 2026-09-29):
- An **Apply to: Everything / Opted-in only** select under Color Depth in the PS1 panel.
- A **Retro colour** checkbox under the character Style row.
- Optionally the same checkbox in the object inspector (`setMeshRetroColor3D`), for props.

*Engine detail:* material flag **bit 31** (`retroColor`), the last free bit. The scope reaches the shaders as a
**negative** colour depth, and each of the 7 quantize sites checks the mesh's bit. Any path that doesn't know
about the scope skips quantizing in opt-in mode, the safe failure.

## Anime face shading · matte · hair band · Play outlines (2026-10-03)

Visual-polish item 10 (`docs/specs/visual-polish-next.md`). Four Persona-look pieces. **New characters get all four; saved
characters load exactly as they were** (every piece is a saved param / material field / scene setting that is absent on an
old save = the classic look). Each one is a toggle in the character panel.

```ts
// 1. Anime face normals — a BODY param (regenerates the body in place; live, persists)
sm.setBodyParams3D(bodyId, { faceNormals: 1 });   // 0 = classic faceted head (saved characters), 1 = full (new bodies)
// 2. Matte skin + cloth — per character (body + every garment, now and when a garment is regenerated)
sm.setCharacterMatte3D(bodyId, true);  sm.getCharacterMatte3D(bodyId);
// 3. Hair highlight band — a HAIR param (material only; Cel / Cel HD)
sm.setHairParams3D(bodyId, { ...hairParams, sheenBand: true });   // needs sheen > 0
// 4. Outlines in Play — scene-wide (persists with the document)
sm.setPlayCharacterOutlines3D(true);  sm.getPlayCharacterOutlines3D();
```

| Piece | What it does | New characters | Saved / old documents |
|---|---|---|---|
| **Anime face** (`BodyParams.faceNormals` 0..1) | The head's faceted normals become a smooth ellipsoid proxy around the head, pulled onto the face's forward plane on the front (the common anime-face trick). The face shades as **one flat skin plane**; the only shadow left is a soft shaped one along the jaw / far cheek. Works in **every** style (PBR, Gouraud, Cel, Cel HD, toon shadows, skin ramp) because it is just the vertex normal. Fades in over the jaw so the neck seam stays continuous; the body keeps its form shading; positions / UVs / weights are untouched (clothing ROM gate unchanged). | 1 (`NEW_BODY_DEFAULTS`) | absent → 0 → bit-identical classic |
| **Matte** (body `material.matte`) | No specular on the skin and every garment → no hard highlight dot (Cel) or glossy streak (Cel HD), i.e. matte cel cloth instead of plastic. Hair keeps its sheen. PBR keeps its roughness. Off restores the classic specular exactly. | on | off (old materials keep their specular) |
| **Hair band** (`HairParams.sheenBand`) | In Cel / Cel HD the Kajiya-Kay sheen becomes **one crisp highlight band** (the angel ring), a lift of the hair's own colour, instead of a soft gloss (which a lit cel hair clamps away anyway). Other styles: unchanged. | on | absent → soft sheen |
| **Outline in Play** (scene `playCharacterOutlines`) | While Play runs, every procedural character with no outline of its own (and the scene's character outlines off) gets the default thin ink line. **Runtime only** — nothing is written to the meshes, Stop removes it, a save during Play is unaffected. Takes effect at the next Play. | on (new session / new document) | a full save without the key → off |

**Suggested panel** (built in Frogmarks' character panel, shading section): an **Anime face** slider (0–1, writes the body
param), a **Matte skin + cloth** checkbox, an **Outline in Play** checkbox (labelled scene-wide), and a **Highlight band**
checkbox under Hair → Render next to Sheen.

**Why not a shader face mask?** A per-pixel face mask would need a new per-vertex attribute or a texture lookup in every style
path, while the normal proxy is free at draw time, lives in the existing vertex data, and is saved as one number. The shader only
gained the hair band (flags2 bit 7 — no new instance lane: normalMatrix column 3 stays `.x` flags2 · `.y` HLOD fade · `.z` face
pull · `.w` 1).

**Chunky hair is not the new default**: with the random style ranges it reads as a helmet / hood (see character-creator.md).

## Anime head: chin shadow + the neck (2026-10-04)

New bodies also get the **anime head** (`BodyParams.headShape: 1`, character-creator.md §2.5b). With face normals on, the neck is
re-shaded, normals only (positions, UVs and weights untouched):

- **Chin shadow.** The under-jaw band (from the under-jaw ring up to the jaw line) and the top of the neck tilt about 45° down and
  out, so they are in shadow for a key light from above. The shadow reaches further down the neck at the front centre than at
  the sides, so its edge is a soft **V that mirrors the jaw**, not a straight band. The face proxy only starts 30% up the
  under-jaw band, so the face plane and the shadow hand over cleanly along the jaw line.
- **The lit neck is never brighter than the face.** The rest of the neck never tilts up, its front half is flattened toward the
  face's forward plane (like the face proxy), and it gets a slight downward tilt. Under any key light from above (front, three
  quarter, noon) every neck vertex is at most as bright as the face plane, and the neck reads a step darker (it sits under the
  chin). Side lights: the neck's median is no brighter than the face's.
- **Why the old neck was a grey / white band.** Two causes: the classic jaw undercut, and (found in this pass) the **Fresnel rim
  light**. A straight-down neck normal is edge-on to a front camera, so the rim (`(1 − N·V)³`, strongest where the key light
  does not reach) lit it white. The shadow normals now keep facing the camera (N·V > 0.55 on the front half), so the rim stays at
  the real silhouette. Rim light stays on for new characters.
- Classic heads (saved characters, `headShape` 0) keep their old neck exactly.

Tests: body-face-normals.test.ts "anime head shape + neck shadow" (classic bit-identical when absent; narrower jaw than cheeks
and no chin spike; the face still one plane; **neck luminance across the jaw seam** for 4 top / front lights and 2 side lights;
rim-safe neck normals). Probe sheets: agent scratchpad `pupdrive/look2/neck/sheet.png` (before: rim on / off / no face normals /
classic) and `neck2/sheet.png`.

## What Salsa handles for you

- The shading math, for regular meshes **and** rigged characters: the per-vertex path in the **Gouraud** style, and
  per-pixel in **Cel / Cel-HD** (2026-09-28). (Soft lighting's half-Lambert lift applies in the Gouraud path; the Cel
  toon path bands the plain lighting.)
- Persistence: the per-character on/off rides the mesh; the global looks ride the scene settings.
- **Provably no-op when off** — a character not opted in (and all non-character content) renders exactly as before.

## Caveats

- **Browser-verify (WGSL is runtime-compiled):** confirm (1) un-opted characters/objects look unchanged, (2) soft
  lighting removes the face's dark triangle, (3) the ramp bands the skin, (4) toggling classic↔ramp is instant, and
  (5) save/reload keeps both looks independently.
- The ramp/soft only touch the **diffuse** term — specular, rim, and hair sheen are untouched. The default PBR style is
  unaffected; the ramp shows in the **Gouraud** and **Cel / Cel-HD** styles (Sketch / Ink / Unlit ignore it).
- Also verify: a Cel character with Ramp now shows banded warm skin; with `setCharacterToonShadows3D` on, the clothes
  and hair get lavender-shifted two-tone shadows; everything off looks exactly as before.
- Soft lighting brightens skin overall (the dark side lifts). If it's too bright, lower the strength.

## Related / coming next

- Both build on the same skin material. **Parallax eyes** (a depth/wet-cornea eye system, also opt-in and switchable
  against the current flat eyes) are planned next — see `docs/specs/character-shading-toon-and-parallax-eyes.md` Part B.
- Engine detail + rationale: `docs/specs/character-shading-toon-and-parallax-eyes.md` (Part A) and
  `docs/specs/face-shading-fix.md` (soft lighting).
</content>
