# Decals — a flexible surface-decal placement system

**Status:** ✅ Mode A built · ✅ Mode B built (2026-07-30, engine side) · 📋 Mode C specced, not built · city-scatter not built
**Related:** [city-props-garp.md](city-props-garp.md) (decals rank *above* GARP for the anime-city look) ·
[ephemera-system.md](ephemera-system.md) (the primary decal source) · [creator-modes.md](creator-modes.md)

---

## 0 · Why

Posters, stickers, paste-up bills, hand-painted shop text and grime streaks are the **single strongest tell**
of the Japanese/anime city look — and Salsa has no way to place one. They are also *cheaper and less blocked*
than GARP: a decal is an image on a surface, and almost every piece needed already exists in the codebase
(the eye-decal, the `texOverBase` compositing mode, the UV-paint texture pipeline, ephemera→raster, the
picker's world normal/position). This spec defines a **flexible** decal system so one tool covers everything
from a flat wall poster to a label wrapping a vending machine.

## 1 · The flexibility — three independent axes

A decal placement is a choice along three axes; the tool exposes all three, and most combinations are valid:

| Axis | Options |
|---|---|
| **Source** — where the image comes from | **ephemera** (an `IEphemeraGenerator` rasterised to PNG) · **uploaded image** · (later) a curated decal library |
| **Mode** — how it attaches | **A floating quad** (a flat card on the face) · **B baked** (composited into the surface texture, curves/wraps) · **C conforming** (a grid that hugs a curved surface as geometry) |
| **Surface** — where it lands | **3D mesh** (raycast a click to the surface) · **UV pane** (stamp directly in UV space while UV-painting) |

Both sources ship from day one. Mode A ships first (below); B and C follow.

## 2 · The modes, and when each is right

- **A · Floating quad** — a flat textured quad placed on the face, oriented to the picked normal, transparent
  texels discarded, its own outliner node (movable / resizable / deletable / persisted). **Best for FLAT
  surfaces** — walls, shopfronts, boards. The anime city is ~90% flat walls, so this delivers most of the
  visual value at the least cost. Does NOT curve. **This is the first build.**
- **B · Baked into the texture** — the image is composited into the surface's own paint texture at the picked
  UV, lit as part of the surface via `texOverBase`. **Curves and wraps perfectly** (it *is* the surface); no
  z-fight, no transparency ordering. Destructive (edits the texture), needs the mesh to have UVs + a paint
  texture. **Best for curved/irregular surfaces** and the UV-pane workflow. Second build.
- **C · Conforming grid** — a subdivided grid that samples the surface and hugs it as *geometry* (the eye
  decal generalised), movable and curving without editing the base texture. Most work; only if a case needs
  "movable + curves + non-destructive" at once. Later.

## 3 · Reuse map — almost everything exists

| Piece | Reuse | New work |
|---|---|---|
| Ephemera → PNG raster | `EphemeraService.exportAs3DTexture(typeId, params, size)` (SVG→PNG blob) | — |
| Image → mesh texture | `setMeshTexture3D(nodeId, File\|Blob\|ImageBitmap)` · `setPartTexture3D` (tracked, survives regen) | — |
| Surface hit → world **position + normal** | `pick3D` / `pickFromClient3D` return `{ meshId, hitPoint, faceNormal, triangleIndex }` | surface-paint callback drops normal — a placement mode calls `pick3D` directly (like `beginAttachmentPlacePick`) |
| Flat quad on a surface | a `plane`/`custom` Mesh3D + transform from the hit normal | orient-from-normal math + a DecalManager |
| Transparent-texel decal look | shader global `if (finalColor.a < 0.01) discard` + `alphaCutout` (bit 5) — the eye-decal recipe | — |
| **Baked** decal compositing (Mode B) | `texOverBase` (bit 15) — production-proven on packaging panels + the UV-paint texture | compositing a FULL-COLOUR image at a UV rect (brush dabs are alpha-only) |
| **Conforming** geometry (Mode C) | `_buildFaceDecal`'s sample-surface / offset-outward / flat-UV grid | generalise head-bbox → arbitrary picked region |

**Only two genuinely new pieces across the whole system:** (a) a floating-quad placement mode (Mode A), and
(b) full-colour image compositing into a texture at a UV rect (Mode B). Everything else is wiring.

## 4 · Mode A — floating quad decals (THE FIRST BUILD)

### 4.1 The decal object
A decal is a lightweight scene node: a **quad Mesh3D**, textured, alpha-cut, placed on a surface. It is its
own thin-wrapper-style node (one outliner item; select / move / delete / persist), NOT baked into anything.

- **Geometry** — a unit quad in its local XY plane facing +Z, UV 0..1, `alphaCutout` on (crisp poster edges).
  Lit like the surface (a printed poster is lit by the scene), not fullbright — though an `emissive` toggle
  gives glowing/neon decals later.
- **Placement** — from a surface hit `{ hitPoint, faceNormal }`: position at `hitPoint + faceNormal * ε`
  (clear the surface, no z-fight); orient so the quad's **+Z aligns to `faceNormal`** and its **+Y aligns to
  world-up projected onto the face plane** (posters hang upright); a `rotation` param spins it in-plane; a
  `size` (metres) + `aspect` from the image set the extents.
- **Texture** — resolved from the source (§4.2) and applied via `setMeshTexture3D`. Async: the quad appears
  immediately (untextured/ghost), the texture lands when decoded.

### 4.2 Source resolution
`DecalSource = { kind: 'ephemera'; typeId; params } | { kind: 'image'; dataUrl }`.
- **ephemera** → `EphemeraService.exportAs3DTexture(typeId, params, size)` → PNG blob → `ImageBitmap`.
- **image** → decode the data URL → `ImageBitmap`.
The source is stored on the decal (for persistence + re-texture on reload), not just the resolved bitmap.

### 4.3 Placement mode (interaction) ✅ BUILT
`enterDecalPlaceMode3D(source, opts)` / `exitDecalPlaceMode3D()`:
- A translucent, **non-pickable** ghost quad (textured with the real source) follows the cursor: on pointer
  MOVE, `pickFromClient3D(..., includeNonPickable=true)` → orient + size the ghost at the hit; no hit → hide.
- On left-CLICK (alt = orbit): finalise a real decal at the hit; stays in the mode for rapid placement.
- `setDecalToolSize3D` / `setDecalToolRotation3D` retune the ghost live.
- ★ **Pickability:** the city/props/buildings are `pickable=false` (fast selection), so decal placement opts
  into them via a new `includeNonPickable` flag on `pickMesh`/`pick3D`/`pickFromClient3D` (default false —
  selection/hover elsewhere unchanged). Without this, a poster could not land on a city wall.

### 4.4 Persistence
Params-only marker (`worldParams.kind: 'decal'`): `{ source, targetMeshId?, position, normal, rotation,
size, aspect, emissive }`. Restore rebuilds the quad + re-resolves the texture from `source`. (The decal is
anchored in WORLD space by position+normal; it does not follow the target mesh if that mesh later moves —
Mode C is the answer when following is required.)

### 4.5 Host API (planned `sm.*`)
`enterDecalPlaceMode3D(source)` / `exitDecalPlaceMode3D()` · `placeDecal3D(hit, source, opts) → id` (direct)
· `setDecalSource3D(id, source)` · `setDecalSize3D(id, m)` · `setDecalRotation3D(id, rad)` ·
`listDecals3D()` · `removeDecal3D(id)` · `isDecal3D(id)`. Frogmarks owns the Decal tool + source subpanel;
Salsa owns geometry / texture / placement / persistence. Doc: `docs/ui/decals.md`.

## 5 · Mode B — baked decals (SECOND BUILD)
In UV-paint mode, a "decal stamp" tool composites the chosen source image into the mesh's paint texture at
the clicked UV (3D mesh or UV pane), through the existing `texOverBase` path. New code: composite a
full-colour `ImageBitmap` into a `RasterTextureManager` at a UV rect with rotation/scale (the brush dab is
alpha-only, so this is a small dedicated blit, not a brush change). Everything else — the transparent
paintable texture, the lit over-base blend, the UV raycast — is already there.

## 6 · Mode C — conforming grid (LATER)
Generalise `_buildFaceDecal`: given a picked point + radius on any mesh, build a small subdivided grid that
samples the local surface, offsets outward, carries a flat 0..1 UV, and (for skinned targets) weights to the
covered joints so it follows poses. A movable, curving, non-destructive decal. Only if needed.

## 7 · City scatter (LAST — per the agreed order)
Once the manual system exists, the city generator scatters floating-quad decals (Mode A) on wall bands:
poster height / eye-level stickers / faded high ads, position-hashed, density by district (dense downtown,
sparse residential), slight rotation + overlap + torn variants. This is `buildStreets`-side work reusing the
decal geometry + a pool of poster ephemera; it is deliberately the last step so the manual tool + source
pipeline are proven first.

## 8 · Cross-cutting
- **Determinism** (city scatter): position-hashed, never a running RNG.
- **Perf**: a floating decal is 2 tris + a standalone texture (own draw). Fine for authored decals; the city
  scatter should batch same-texture decals via the atlas (`textureLibraryId`) or instance them, so a wall of
  posters is not a wall of draws. Note this when scatter lands.
- **Source stored, not baked**: a decal persists its `source` (ephemera ref / image), so it re-resolves on
  reload and a document stays small — the same params-over-pixels principle as the rest of the engine.
