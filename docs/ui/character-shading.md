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

## What Salsa handles for you

- The shading math (vertex Gouraud path — the one skinned characters use), for regular meshes **and** rigged characters.
- Persistence: the per-character on/off rides the mesh; the global looks ride the scene settings.
- **Provably no-op when off** — a character not opted in (and all non-character content) renders exactly as before.

## Caveats

- **Browser-verify (WGSL is runtime-compiled):** confirm (1) un-opted characters/objects look unchanged, (2) soft
  lighting removes the face's dark triangle, (3) the ramp bands the skin, (4) toggling classic↔ramp is instant, and
  (5) save/reload keeps both looks independently.
- The ramp/soft only touch the **diffuse** term — specular, rim, and hair sheen are untouched. The PBR path (used when a
  material has a normal map) is unaffected; characters use the Gouraud path, which is where these live.
- Soft lighting brightens skin overall (the dark side lifts). If it's too bright, lower the strength.

## Related / coming next

- Both build on the same skin material. **Parallax eyes** (a depth/wet-cornea eye system, also opt-in and switchable
  against the current flat eyes) are planned next — see `docs/specs/character-shading-toon-and-parallax-eyes.md` Part B.
- Engine detail + rationale: `docs/specs/character-shading-toon-and-parallax-eyes.md` (Part A) and
  `docs/specs/face-shading-fix.md` (soft lighting).
</content>
