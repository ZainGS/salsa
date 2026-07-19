# Procedural Patterns + Layered Base Garments — Spec

**Created:** 2026-06-29 · **Status:** Phase 1 (pattern engine) ✅ BUILT · Phase 2 (base-layer garments) ✅ BUILT
**Related:** [wardrobe-expansion.md](./wardrobe-expansion.md) · [clothing.md](../ui/clothing.md) · [3d-scene.md](../ui/3d-scene.md) §Material · shader gotchas: memory `reference_3d_shaders`

A way to give garments **crisp geometric patterns** — stripes, dots, diamonds, checks, grids — with a primary/secondary
colour and live size/angle/spacing controls, and a pair of **skin-tight base layers** (undershirt / underpants) that
wear them and peek out under the main top/bottom.

## Decision: render patterns IN THE SHADER (analytic), not as baked textures

We deliberately do NOT bake these to a tiling texture. For geometric patterns the shader route is the correct
destination, primarily for **antialiasing / zoom-independence**:

- A baked tile, when it minifies (camera pulls back / character is small), either **aliases** (no mipmaps → shimmering
  pinstripes, crawling dots as it moves) or **blurs to a flat grey average** (mipmaps → lost edges). There is no setting
  that gives sharp-up-close *and* clean-at-distance from a baked geometric tile. Shimmering pinstripes on orbit is exactly
  the cheap artifact that undercuts a "looks designed, not modeled" tool.
- Evaluated per-fragment, the pattern is **antialiased analytically** with `fwidth`/`smoothstep` (edge softness derived
  from how fast the UV changes on screen) → razor-sharp close up, resolves to the correct average colour at distance,
  **zero shimmer**. This is how procedural geometry should be rendered.
- Secondary wins: the pattern id is a **uniform → uniform control flow → no warp divergence → effectively free**; live
  edits are a **uniform write** (no texture re-upload); at crowd scale there's **no per-pattern texture or extra bind**.
- The patterns are one-liners (`fract(uv.x*f)` etc.) — same analytic-in-shader model as the screentone/speed-line
  effects already in the codebase.

**Compositing with hand-painted UV art (relevant — we paint garments):** a garment can have BOTH. The fragment samples
the painted diffuse texture, then overlays the analytic pattern on top (mix/multiply). So painted art at the hem + a
crisp procedural pattern on the same garment, composited live.

## Patterns + params (Phase 1)

| Pattern | id | math (analytic, AA'd) |
|---|---|---|
| none | 0 | — (plain `diffuse`) |
| stripes | 1 | `fract(p.x * freq)` band |
| dots | 2 | distance test inside `fract(p * freq)` cells |
| diamonds | 3 | rotated check / `abs(fract(p.x*f)-.5)+abs(fract(p.y*f)-.5)` |
| checker | 4 | `(floor(p.x*f)+floor(p.y*f)) & 1` |
| grid | 5 | thin lines on the cell borders of `fract(p*f)` |

- **`color` (primary)** = the existing `material.diffuse`. **`patternColor` (secondary)** = NEW.
- **`patternParams` = (freq, angleRad, scale, spacing)**: `freq` = repeats across UV 0..1; `angle` rotates the UV before
  the pattern; `scale` = stripe width / dot radius / line thickness (0..1 of a cell); `spacing` = a per-pattern extra
  (dot gap / second-axis freq). Pattern uses the garment's existing UVs (`p = rot(uv - 0.5, angle) * freq`).
- Output: `albedo = mix(diffuse, patternColor, mask)`, where `mask` is the AA'd 0..1 pattern value; then the normal
  PBR/lighting runs on `albedo`. Textured garments: overlay `mask` onto the sampled texture.

## Engine wiring (Phase 1)

- **`Material3D`** gains `patternMode?: 'none'|'stripes'|'dots'|'diamonds'|'checker'|'grid'`, `patternColor?: RGBA`,
  `patternFreq?`, `patternAngle?`, `patternScale?`, `patternSpacing?`. `encodeMaterialFlags` packs the mode into
  **flag bits 9–11** (`(mode & 7) << 9`).
- **`MeshInstance` storage struct grows by 2×`vec4`** → `patternColor` (rgb + spare a) + `patternParams` (freq, angle,
  scale, spacing). **`MESH_INSTANCE_STRIDE` 192 → 224** (14×16, vec4-aligned). ALL 9 struct declarations (mesh3d ×4 +
  highlight ×2 + outline + shadow + skinning — the non-mesh3d ones are padding-stubs) and BOTH upload sites in
  `renderer-3d.ts` must match the new stride or instance indexing breaks. (See the past "padding for alignment" commit.)
- **Shaders** (`mesh3d-shaders.ts`, both fragment variants): a `patternMask(uv, mode, params)` helper with `fwidth` AA,
  applied to the albedo in the PBR branch (and overlaid on the texture in the textured fragment). Cel/gouraud get it on
  the base colour too (it's an albedo modifier, render-style-independent).
- **API:** `shapeManager.setMeshPattern3D(meshId, { mode, color, freq, angle, scale, spacing })` (scene3d
  `setMeshPattern` → sets the material fields). Works on ANY mesh (tops/bottoms now, base layers later). Persists with
  the mesh material.
- **Presets** (✅ added 2026-06-29): `clothingPatternPresetNames3D()` / `clothingPatternPreset3D(name)` →
  None · Pinstripe · Stripes · Diagonal · Polka Dots · Micro Dots · Argyle (45° diamonds) · Harlequin · Checkerboard ·
  Gingham · Grid · Graph. Each returns a `ClothingPattern` (drop on a garment's `pattern`, or feed `setMeshPattern3D`).

## Phase 2 — skin-tight base layers ✅ BUILT (2026-06-29)

Two NEW clothing slots, **`undershirt`** + **`underpants`**. **They reuse the existing top/bottom generators** rather
than new geometry: `buildTorso` already supports a NEGATIVE `hemHeight` (= below the hips, down to −0.45), so an
undershirt is just a tight `generateTop`; an underpants is a tight `generateBottom` shorts. Both consume the pattern
engine (default to one so the layering reads immediately).

- **`UndershirtParams`** (`generateUndershirt` → maps to a tight `TopParams`): `sleeves` (0 tank…1 long),
  `shoulderCoverage`, `neckline` (round/crew/v), **`hemExtend`** (0 at hips … 1 mid-thigh = below the main top),
  `thickness` (thin, ~0.002 → it HUGS via the de-collision). Default pattern: thin stripes.
- **`UnderpantsParams`** (`generateUnderpants` → tight `BottomParams` shorts): **`legExtend`** (0 brief … 1 boxer),
  `waistHeight`, `thickness`. Default pattern: dots.
- **`ClothingPattern`** (`pattern?` on EVERY garment param interface — top/bottom/shoes/socks too, not just base layers):
  `{ mode, secondaryColor, freq, angle, scale, spacing }`. `scene3d.setClothingParams` applies it to the mesh material
  (`patternMode`/`patternColor`/…), so ANY garment can carry a persisted pattern.
- Widened the `ClothingParams` slot union + the `'top'|'bottom'|'shoes'|'socks'` slot type everywhere (scene3d +
  shape-manager, ~20 sites) + the two `_clothingRigs` slot-array loops + the dispatch/name/defaults. Persistence
  round-trips automatically (rigs iterate the map; params are the union). Baking maps undershirt→top / underpants→bottom
  (CharacterSlot). API: `getDefaultClothingParams3D('undershirt'|'underpants')` + `setClothingParams3D` (generic).

## Build order
1. **Phase 1 — pattern engine** (this pass): material fields + struct/stride growth + shader + API. Usable on existing
   tops/bottoms right away. Verify patterns are crisp on orbit (no shimmer) AND shadows/outline still render (stride OK).
2. **Phase 2 — base-layer garments** that wear it.

**Constraint:** `npx tsc --noEmit` only (never `npm run build`); user rebuilds + restarts `ng serve`. tsc does NOT
validate WGSL stride — a missed struct declaration shows as garbled rendering at runtime, so update all 9 + both uploads
together and verify visually.
