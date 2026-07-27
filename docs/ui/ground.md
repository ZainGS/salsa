# Procedural Ground — Frogmarks UI Integration

**Last Updated:** 2026-07-25 (**Phases 1–6**: the ashlar **limestone** material + **usage-biased weathering**
(P1/P2) + the **radialMedallion** & **borderStrip** tilers and composed `salsaGroundPlaza()` (P3) + the **grass**
surface with a **dirt-path blend** (P4) + the **mask-driven SCATTER** system (P5: `scatterOnGround3D` +
`salsaGroundScatter()`, §1b) + the **13-surface MATERIAL LIBRARY** (P6, §5: asphalt · concrete · dirt ·
cobble · plank · brick · granite · slate · sandstone, and `salsaGroundLibrary()`) — plus the move to
**world-metric tiling** (`gr_uvMetres`), so tile/grout sizes are physical on any mesh at any scale and
`extentMeters` is retired. The material half (spec §A) + the scatter half (§7) are in; **transitions between
surfaces are the next feature and are NOT built** (§5).
**Engine spec:** [../specs/procedural-ground.md](../specs/procedural-ground.md)
**Sibling UI docs:** [building-creator.md](./building-creator.md), [foliage-creator.md](./foliage-creator.md),
[3d-scene.md](./3d-scene.md) (the Lighting/Material panels this sits beside).

Procedural Ground is a **shader-generated floor material** — no textures. A ground mesh (a plane, an
imported floor, or a city street/plaza deck) gets a `groundShade` material that draws pavers, grout,
per-stone colour variation, and surface relief **per fragment from a tiny parameter set**. **Thirteen
surfaces ship** — see the library table in §5. Sizes are given in **real millimetres** and are physical on
any mesh: the shader recovers world-metres-per-UV from fragment derivatives, so a 600 mm paver is 600 mm on
a plaza plane, on a cube face, and on a box stretched 3× along one axis.

> **Status legend:** ✅ Salsa (done) · 🟦 Frogmarks must implement · 🔶 not built yet (either side).

---

## 0. Try it right now (zero Frogmarks wiring) ✅

In any illustration doc with a 3D scene, run in the console:
```js
salsaGround();                                  // drops a 20 m plane + applies the limestone material
salsaGround({ size: 30, tileMm: 450, groutMm: 12, tint: [0.82, 0.76, 0.64] });
// Pick any of the 13 surfaces with `surface` (§5) — `salsaGroundNames()` lists them:
salsaGround({ surface: 'radialMedallion', wedges: 16, ringMm: 600 });   // polar rings × wedges centrepiece
salsaGround({ surface: 'borderStrip', tileMm: 900 });                    // long linear frame pavers
salsaGround({ surface: 'grass' });              // lawn + a default worn DIRT PATH carved through it
salsaGroundPlaza();                             // COMPOSED plaza: ashlar field + radial medallion + border ring
salsaGround({ surface: 'brick' });              // …or asphalt · concrete · dirt · cobble · plank · granite · slate · sandstone
salsaGroundScatter();                           // P5: grass ground + mask-driven SCATTER (flowers/grass thin over the wear track)
salsaGroundLibrary();                           // ★ P6: ALL 13 surfaces on one grid — review/compare in a single screenshot
```
`salsaGround(opts?)` creates a `createPlane3D` ground plane, applies the chosen surface material (default
`ashlar`), and returns the mesh id. `salsaGroundPlaza(opts?)` drops the 3 composed meshes (region composition
is MULTI-MESH, not per-fragment) and returns their ids. Fastest way to eyeball + tune the look.

---

## 1. The API ✅ (engine)

Apply the ground material to ANY existing 3D mesh (a plane, an imported floor, a street deck):
```ts
sm.applyGroundMaterial3D(meshId, {
  surface?: GroundSurfaceName,  // one of the 13 below (→ groundMode 0..8); default 'ashlar'
  tileMm?: number,        // paver size (long axis); default 600 mm → 900×600 LANDSCAPE running-bond pavers.
                          //   radial: ring spacing fallback · border: stone length · grass: unused
  groutMm?: number,       // seam width; default 15 mm (tilers only)
  tint?: [r, g, b],       // base colour 0..1; OMIT to use the surface's own recipe colour (§5)
  extentMeters?: number,  // ACCEPTED BUT IGNORED (kept so old call sites compile) — see below
  // P3 radialMedallion / borderStrip:
  wedges?: number,        // radialMedallion wedge ("pizza slice") count; default 12
  ringMm?: number,        // radialMedallion ring spacing (falls back to tileMm)
  // P4 grass (procedural-ground §8-§9):
  dirtTint?: [r, g, b],   // bare dirt-path colour the lawn blends toward across the wear band; default brown
  // P2 weathering (procedural-ground §5):
  weather?: 'new'|'worn'|'ancient'|'mossy'|'dirty',  // usage-biased aging profile; default 'worn'
  wearPath?: [cx, cy, radiusUv],  // worn TRACK in uv (center + radius); radius 0 = noise-only. For grass this
                                  //   is the DIRT-PATH mask — bare ground carves through the lawn where worn
  mossTint?: [r, g, b],           // moss colour for the moisture mask (stored; shader constant for now)
}) → boolean;             // false if the mesh id doesn't resolve
```
- **★ You no longer size the mesh for it.** The shader recovers world-metres-per-UV-unit per fragment
  from screen-space derivatives (`gr_uvMetres`), so `tileMm`/`groutMm` are true physical sizes on any
  mesh, at any scale: a 600 mm paver is 600 mm on a 30 m plaza plane, on a cube face, and on a box
  stretched 3× along X. `extentMeters` is a no-op now and can be dropped from call sites.
- **Grout is isotropic.** Previously the row seams and the column seams were compared against one UV
  width, so stretching the mesh made one axis' seams visibly thicker. Both are now measured in metres.
- The material **persists** with the mesh (it's embedded in `Mesh3D`'s material, round-trips through the
  document). `groundShade` is mutually exclusive with the packaging board flags — a mesh is a ground
  tile OR a package panel, never both.
- No lighting setup needed — it's a normal PBR surface; the scene's directional + ambient light it.
  (Note the neutral default ambient — see [3d-scene.md] Lighting — so the tan reads true.)
- **Repaints immediately.** Applying a ground material flags the mesh `materialDirty` (the *repack-only*
  flag), **not** `gpuDirty`. `gpuDirty` means "the geometry changed": the instance-upload fast paths skip
  unmoved resident meshes, so a material carried on `gpuDirty` never reached the GPU and the flag was
  cleared the same frame by the geometry pass — the surface only repainted when some later structural edit
  (e.g. adding a scatter group) forced a full repack. Use `applyMaterialPatch(mesh, patch)`
  (`renderer/3d/material-3d`) for **every** material-only mutation.

**Under the hood** (for reference): the material sets `groundShade: true` + repurposed pattern slots
(`groundGrout` = seam RGBA where `.a` is the grout width in **METRES** — for the organic surfaces this slot
instead carries `groundDirtTint`; `groundTile` = mode-multiplexed, in metres: [tileW, tileH] / [ringSpacing,
wedgeCount] / [stoneLength, rowCount] / [cellSize, —] / [boardLength, boardWidth]; `groundJitter`;
`groundMode` = 0 ashlar · 1 radialMedallion · 2 borderStrip · 3 grass · 4 asphalt · 5 concrete · 6 dirt ·
7 cobble · 8 plank). The WGSL `groundSurface` dispatch picks the tiler; `groundWeather` (P2) then applies
uniformly over every mode; a mode-aware `groundHeightM` feeds the height field → normal.
⚠ **`groundHeightM` must gain a branch whenever `groundSurface` does** — a mode present in one and missing
from the other lights paver seams across a surface whose albedo has none. A test pins both switches.
All per fragment, no stored textures.

---

## 1b. Scatter ✅ (engine, P5)

The SCATTER half (spec §7): instanced props (flowers / pebbles / twigs / tall-grass clumps / bushes /
rocks) placed over a ground mesh, with per-type DENSITY driven by the **same weathering masks the
material uses** — so flowers + grass visibly **THIN over the wear track** (fewer where the material
draws bare dirt), and more grass/bush grow in the moist edges. One source of truth, two consumers.

```ts
sm.scatterOnGround3D(groundMeshId, {
  seed?: number,                       // stable across reloads (baked off the seed)
  flowers?, pebbles?, twigs?,          // per-type density multipliers (1 = park default, 0 = off)
  tallGrass?, bushes?, rocks?: number,
  wearPath?: [cx, cy, radiusUv] | null,// the worn track (uv); DEFAULTS to the mesh's own material
                                       //   `groundWearPath`, so material + scatter share the track
  alignToSurface?: boolean,            // ★ default TRUE — see below
  reject?: (x, z) => boolean,          // extra world-space reject (ponds / paved paths)
}) → groupId | null;                   // null if the mesh id doesn't resolve or nothing was placed
sm.clearGroundScatter3D(groupId) → boolean;
```

- **Props GROW OUT OF THE MESH SURFACE.** Placement samples the ground mesh's **real triangles**
  (area-weighted, respecting the index buffer), so a non-flat, tilted, holed or non-rectangular ground
  scatters correctly and every prop sits *on* the surface. Each sample carries an interpolated surface
  **normal** and **uv**.
  *(This replaced a flat world-space rectangle at a single `y` — the source of "rotating the ground leaves
  the foliage behind" and "props float on a plane over a bumpy ground".)*
- **★ `alignToSurface` (default `true`)** — the instance's up-axis is the **surface normal**, so plants grow
  *perpendicular to the ground*. Set `false` to grow straight up along the parent's +Y instead (the old
  behaviour, right for a ground that is stylistically flat). The random yaw + lean jitter rides on top of
  **whichever** basis.
- **★ The scatter FOLLOWS the mesh.** The scatter group is **parented to the ground mesh's node**, and the
  instance transforms are in that mesh's **local space** — so moving / rotating / scaling the ground carries
  its foliage automatically (scene-graph `parentChainMatrix`), with no re-scatter. Metre-denominated spacing
  and prop sizes are converted through the mesh's world scale at scatter time, so a 2×-scaled ground still
  gets real-size plants at real spacing.
- **Placement is blue-noise, never a grid** (§7): seeded area-weighted dart throwing with a greedy
  min-distance reject in **real 3D space** — every accepted pair is ≥ the type's spacing apart along the
  surface. Clumping (the low-freq patchiness) and mask-driven density are unchanged.
- **Masks stay meaningful on a surface**: the wear / moist / dirt fields are read at the sample's **mesh uv**
  when the mesh has real uvs, else at the planar XZ projection (what the flat footprint always used).
- **Instanced draw** — each prop type is **one canonical geometry + one GPU-instanced `ArrayGroup3D`**
  (not thousands of loose meshes), under a band sub-group; `cheapBounds` on the sources.
- **LOD** — a camera-distance gate drops bands in order as you zoom out (flowers→twigs→pebbles→tall-grass
  first; bushes/rocks last). Toggle with the internal `setGroundScatterLOD`.

Try it: `salsaGroundScatter()` drops a grass ground with a worn dirt track and scatters it — watch the
flowers/grass thin across the track (the shared-mask payoff).

## 2. What Frogmarks builds 🟦

Phase 1 has **no dedicated panel** — it's an engine material + console harness. The minimal host wiring,
when you want it in the UI:

- **A "Ground" material option** on a selected 3D mesh (in the 3D Scene / Material panel): a button/preset
  dropdown that calls `sm.applyGroundMaterial3D(selectedMeshId, opts)`. For now the only preset is
  `limestone`; expose **Tile size (mm)**, **Grout width (mm)**, a **Base tint** swatch, and **Ground
  extent (m)** as the controls (they map 1:1 to the opts). Re-call `applyGroundMaterial3D` on any change.
- That's the whole surface for P1. A full **Ground Creator mode** (author a plaza's regions/tilers/
  weathering + preview, like the Building/Character creators) is a later phase — see §3.

```ts
// Frogmarks: apply-ground-to-selection (Material panel)
onApplyGround(): void {
  const id = this.scene3dSelectedMeshId;                 // your existing selection state
  if (!id) return;
  sm.applyGroundMaterial3D(id, {
    tileMm: this.groundTileMm, groutMm: this.groundGroutMm,
    tint: this.hexToRgb01(this.groundTintHex), extentMeters: this.groundExtentM,
  });
}
```

---

## 3. Roadmap (spec §12) 🔶 — NOT built

Phase 1 is the limestone material; **P2 (weathering) is now built too.** The spec's later phases (each a follow-up):
- **P2 — weathering masks** ✅ BUILT: usage-biased wear/moisture/dirt + edge/corner masks (worn paths brighter/
  smoother, edges darker/mossy, corners chipped), one `weather` profile knob → five looks; the biggest "walked-on"
  cue. Exposed as the `weather` + `wearPath` opts above; try `salsaGround({ weather: 'ancient' })`.
- **P3 — radial medallion + border regions** ✅ BUILT: two new tilers (`radialMedallion` = polar rings × wedges,
  `borderStrip` = long linear pavers) reusing the P1 per-cell + P2 weathering machinery; composition is MULTI-MESH
  (a disc + a border ring + an ashlar field, placed separately — `salsaGroundPlaza()`), not per-fragment regions.
- **P4 — grass material + dirt-path blending** ✅ BUILT: `grass` surface (layered noise — base green + macro blobs +
  directional fibers + dry flecks + moss) that THINS to bare dirt across the P2 wear band (a worn path carves dirt
  through the lawn); `salsaGround({ surface: 'grass' })`.
- **P5 — SCATTER** ✅ BUILT: blue-noise flowers / pebbles / twigs / tall-grass clumps / bushes / rocks,
  density driven by the P2 masks (CPU-mirrored in `src/world/ground-masks.ts`), one instanced draw per type,
  a distance-LOD band cull. `sm.scatterOnGround3D` / `salsaGroundScatter()` (see §1b). Vegetation geometry is
  a documented LATER quality pass. **P6/P7 remain.**
- **P6 — the MATERIAL LIBRARY** ✅ BUILT (§5): 13 surfaces — asphalt / concrete / dirt / cobble / plank as
  new `groundMode`s, and brick / granite / slate / sandstone as **ashlar presets** (no shader code).
  Still open from P6: accent **decals** (drains, road paint — decals, not baked into the material).
- **★ TRANSITIONS between surfaces** 🔶 NOT BUILT — the next real feature, and the thing standing between
  this and a composed world (§5). Two adjacent surfaces currently meet at a hard mesh seam.
- **P7 — biome params + a Ground Creator mode + world-composer integration:** a plaza becomes a compact
  param set (seed + tiler + material + weathering + scatter), authored in a creator panel and consumed by
  the world/biome pipeline.

Now that the presets have settled, the Frogmarks surface can graduate from "apply material to a mesh" to a
proper **Ground Creator** panel (surface picker + the recipe knobs + weathering); this doc gets a §3b
wiring guide then. Build the picker from `Object.keys(GROUND_SURFACES)` / `salsaGroundNames()` — never a
hard-coded list, or it goes stale the next time a surface is added.

---

## 4. Caveats / verify in-browser
- **WGSL is build-verified only — the LOOK needs your eyes.** The limestone tuning (base tan, grout
  colour/width, per-stone jitter, macro cloud, height depth, roughness range) are first-guess constants;
  eyeball `salsaGround()` and adjust the exposed opts (or ask for a constant tune). Expected iteration,
  like the packaging board grain.
- **Non-uniform scale is handled, degenerate UVs are not.** The metric derivation needs a non-degenerate
  UV mapping; a mesh whose UV triangle collapses falls back to 1 m per UV unit (pavers will look wrong on
  that face). Expect one or two pixels of derivative noise exactly on a UV seam (e.g. a cube's edges).
- **★ The P6 surfaces are UNREVIEWED.** Every colour and noise frequency in asphalt / concrete / dirt /
  cobble / plank — and in the brick / granite / slate / sandstone recipes — is a first guess, exactly as the
  original limestone was. Run `salsaGroundLibrary()` and expect a tuning pass.
- **One material path, many surfaces:** all 13 are the SAME `groundShade` path with a different
  `groundMode` + recipe — adding a surface is a table row (or at most one tiler fn), never a new pipeline.


---

## 5. The SURFACE LIBRARY (P6)

`GROUND_SURFACES` (exported from `shape-manager`) is the single source of truth — build the picker from
`Object.keys(GROUND_SURFACES)`, or call `salsaGroundNames()` in the console. **`salsaGroundLibrary()` lays
every surface out on a grid of tiles** so the whole set can be compared in one screenshot; pass
`{ only: ['asphalt','dirt'] }` while tuning a couple.

| Surface | mode | Tiler | Notes |
|---|---|---|---|
| `ashlar` | 0 | running bond | 900 × 600 limestone pavers — the P1 default |
| `brick` | 0 | running bond | 215 × 65 red clay, pale mortar, high per-brick jitter |
| `granite` | 0 | running bond | 800 mm square, low jitter, **polished** (roughness 0.34) |
| `slate` | 0 | running bond | 600 × 300, cool blue-grey, high jitter |
| `sandstone` | 0 | running bond | 700 × 500, warm ochre |
| `radialMedallion` | 1 | polar rings × wedges | the courtyard centrepiece |
| `borderStrip` | 2 | long linear stones | the plaza frame band |
| `grass` | 3 | — | 3-scale turf + the dirt-path blend |
| `asphalt` | 4 | — | aggregate speckle, bright chips, crack network |
| `concrete` | 5 | **stack-bond grid** | 3 m slabs, pores, trowel mottling, expansion joints |
| `dirt` | 6 | — | clumped earth, grit, stones, crazing on the dried crests |
| `cobble` | 7 | **voronoi** | 150 mm irregular set stones |
| `plank` | 8 | staggered boards | 1800 × 150 mm decking with ring grain |

**★ Four of these cost no shader code.** `brick` / `granite` / `slate` / `sandstone` are all *the ashlar
tiler* with a different stone size, colour, seam and jitter — they differ as materials, not as geometry.
Only a genuinely different **layout** earns a new `groundMode`. Adding "limestone flags" or "terracotta
tile" is a row in `GROUND_SURFACES`, not a shader change.

⚠ **Saves store the `groundMode` NUMBER, not the surface name.** Never renumber an existing mode — append.
The four legacy names (`ashlar` 0 · `radialMedallion` 1 · `borderStrip` 2 · `grass` 3) are pinned by test.

### Not built yet — the TRANSITION system
Right now two adjacent surfaces meet at a **hard mesh seam**. Composing a believable world needs
material-to-material transitions: a mown-grass fringe fading into dirt, a stone kerb between a lawn and
asphalt, a gravel apron round a plinth. That is its own feature (a blend mask + a border-strip generator
driven by the region graph), deliberately **deferred** — see the note at the end of `procedural-ground.md`.

---

## 6. In the CITY (BUILT 2026-07-25)

The world generator now stamps surfaces onto the ground it emits — this is the first time the material
library reaches generated content rather than a standalone demo plane. Nothing to wire on the host side:
regenerate a city and the ground is material.

| City layer | Surface | Why |
|---|---|---|
| `world:roads` | `asphalt` | aggregate + chips + cracks (was a dots pattern) |
| `world:sidewalks` | `concrete` @ 1200 mm | footway slabs — the library's 3 m default is a road pour |
| `world:courtyard` | `cobble` | a block interior should differ in *layout*, not just be a darker grey |
| `world:park` | `grass` | real turf (was a dot mottle) |
| `world:residential` / `commercial` / `civic` | `concrete` @ 2000 mm | built lot ground |
| `world:plaza` | `ashlar` | the flagship surface, on the ground the camera lingers on |

**The palette still owns colour.** Every layer passes its existing zone colour through as `tint`, so the
material supplies *detail* and the palette supplies *identity* — styles and seasons keep working, and the
map's zone readability survives. A test pins `ground.tint === layer.color` for every ground layer.

### ★ `groundWorldUV` — why city ground needed a new flag
City ground geometry is parameterised `uv = worldXZ * 0.5`, deliberately: it means neighbouring road,
pavement and plaza meshes **tile continuously** instead of each restarting its pattern at 0. Tiling copes
with that already (`gr_uvMetres` derives metres-per-uv per fragment either way), but the **P2 weathering
masks assume uv is a 0..1 region**:

- `gr_edgeMask` computes `min(uv.x, 1 - uv.x)`, which for city uv is hugely negative → the mask saturates
  to **1 across the entire city**, darkening every surface and applying the corner-chip everywhere.
- the wear/moisture noise would run at ~1 cycle per metre and read as static.

So a ground material now carries `groundWorldUV`, encoded as `groundMode + 100` (there is no free instance
float left). It switches the masks to a world-scaled coordinate and zeroes the edge/corner term — a
continuous ground has no region border. Standalone planes are unaffected and keep the edge mask.

### Known-unverified / likely tuning
- **Emissive.** City layers render half-emissive (0.45) so the map reads flat and even; that washes out
  paver detail, so ground layers drop to **0.15**. That number is a guess and is the most likely thing to
  need moving — too low and the ground goes muddy in a dim scene, too high and the material flattens again.
- **Hard seams at every zone boundary** (road ↔ pavement ↔ park). Expected — this is exactly the case the
  deferred TRANSITION system exists for (§5), and the city is now the place to design it against.
- The scatter layer is *not* wired into the city; parks are material-only for now.
