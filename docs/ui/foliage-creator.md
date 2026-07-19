# Foliage Creator — Frogmarks UI Integration

Host-facing contract for the **Foliage Creator** (the "Add / Edit Foliage" flow for **freestanding** plants), mirroring
the [Building Creator](building-creator.md) / [Character Creator](character-creator.md) pattern: **Salsa owns the
generator + scene lifecycle + persistence; Frogmarks owns the panels/buttons.** Spec:
[../specs/foliage-generator.md](../specs/foliage-generator.md). Item 1 (generator) + a freestanding manager are built.

## Two kinds of foliage — this doc is for FREESTANDING only
- **Freestanding foliage** (a loose bush on the sidewalk, a hedgerow, a potted plant, a street tree) = independent scene
  objects placed anywhere → **this Foliage Creator** (its own thin-wrapper containers, like buildings).
- **Building-attached foliage** (hedges hugging a building base, vines up its walls, window boxes, door planters) is NOT
  here — it lives in the **Building** panel as building params (`baseHedge` / `vines` / `windowBoxes` / `basePlanters`),
  so it travels with the building. See [building-creator.md](building-creator.md).

## The flow (what the host builds)
Exactly like Add/Edit Building:
1. **Add Foliage** button → `createProceduralFoliage3D(...)` → a plant appears + a new outliner item; select it (returned `id`).
2. **Select** (outliner click / returned id). Gate the toolbar on `isProceduralFoliage3D(selectedId)` → show **Edit Foliage**.
3. **Edit** → params panel seeded from `getFoliageParams3D(id)`; every change calls `setFoliageParams3D(id, {...changed})`
   → regenerates in place (same id, selection + placement kept).
4. **Type picker** → `setFoliageParams3D(id, { type })` switches the plant type.

Selection/gizmo/outliner are automatic (thin-wrapper container, moved/rotated as a unit; gizmo moves persist).

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `createProceduralFoliage3D(params?, x?, y?, z?, { scale?, frame? }) → { id, meta }` | Add + place. Auto-frames (pass `frame:false` to suppress). |
| `setFoliageParams3D(id, partial) → boolean` | Live-edit params, regenerate in place. Merge-style. |
| `getFoliageParams3D(id) → FoliageParams \| null` | Seed the host sliders. |
| `getFoliageMeta3D(id) → FoliageMeta \| null` | `{ footprint, height, type }` (footprint drives placement/overlap). |
| `isProceduralFoliage3D(id) → boolean` | Gate the "Edit Foliage" affordance. |
| `setFoliageTransform3D(id, {x,y,z,rx,ry,rz}) → boolean` | Move/rotate a placed plant. |
| `setFoliageScale3D(id, unitsPerMetre) → boolean` | Display scale (e.g. `0.1` = 1 unit : 10 m). Regenerate-free. |
| `getFoliageScaleInfo3D(id) → { scale, metersPerUnit, realHeightM, displayHeightUnits }` | UI ratio + real-dimension readout. |
| `frameFoliage3D(id) → boolean` | Re-frame the camera on a plant. |
| `removeFoliage3D(id) → boolean` | Delete. |
| `listFoliage3D() → { id, name, type }[]` | Host outliner / picker. |
| `foliageTypeNames3D() → string[]` | The type picker's options. |
| `restoreFoliageFromSave3D() → number` | Regenerate all foliage from a loaded save's markers. **Call after document load** (alongside `world.restoreFromSave()` + `restoreBuildingsFromSave3D()`). |

## `FoliageParams` (the panel model)
Resolved as **defaults ← explicit overrides**.
- **Type:** `type` — `bush` · `shrub` · `hedge` · `grass-tuft` · `flower-bed` · `planter` · `potted` · `small-tree` ·
  `vine` · `ivy` · `window-box`. `seed`.
- **Shape:** `size` (m — height for bush/shrub/tree/grass, box height for planter), `width` (run length for hedge/
  window-box/vine; spread for flower-bed), `density` (0..1 leaf fullness).
- **Render:** `render` — `chunky` (low-poly blob clumps) · `card` (**layered leaf-CLUSTER cards** — big quads, each cut
  in-shader to a *sprig of ~5 leaves*, packed through the volume/prism the way real foliage layers cards; alpha-test so
  order-independent + leaf-shaped shadows; also cheaper than chunky). `celShade` (boolean) → **toon/BotW-Ghibli look**:
  cel-banded lighting + rim back-light on the leaves. Combine `card` + `celShade` for the stylized foliage look.
- **Flowers/vessel:** `bloom` (flowers/berries on), `potMaterial` (`terracotta`·`ceramic`·`metal`·`wood`·`stone`).
- **Colour:** `foliageColor`, `tipColor` (lighter new-growth tips), `bloomColor`, `potColor`, `trunkColor`. Colour values
  accept any format (`[0..1]` / `[0..255]` / `{r,g,b}` / `"#rrggbb"`) — coerced to 0..1 (same as buildings).

`FoliageMeta` (out): `{ footprint: V2[], height, type }`.

## Scale + persistence + dev harness
- **Scale:** same system as buildings — authored in **real metres**, displayed at **1 unit : 10 m** default (shared so a
  bush reads correctly next to a tower); auto-framed on Add. `setFoliageScale3D` / `getFoliageScaleInfo3D` / `frameFoliage3D`.
- **Persistence:** params-only marker (`worldParams.kind === 'foliage'`). The marker is saved, but restores as an empty
  container that must be **regenerated on load** — the host MUST call **`restoreProceduralFromSave3D()`** once after the
  document loads (one call restores City + buildings + foliage; see [building-creator.md](building-creator.md#persistence)).
  Otherwise foliage (and buildings) won't reappear on reopen.
- **Console (no UI):** `salsaFoliage.type('window-box')` returns an id; `salsaFoliage.set(id, { size: 2, bloom: true })`;
  `salsaFoliage.move(id, { x: 5 })`; `salsaFoliage.list()` / `.types()` / `.remove(id)` / `.restore()`.

## Not yet (later work — see the spec)
Wind-sway; viewport click-to-select; a ghost preview. (Item 4 — Building Editor mode + the foliage GRID tool — is built;
see [building-creator.md](building-creator.md#building-editor-mode--foliage-placement-the-grid-tool).)
