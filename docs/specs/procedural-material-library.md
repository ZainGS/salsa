# Procedural Material Library — Stylized Surfaces for AI/UI Authoring (spec, NOT built)

**Date:** 2026-08-19 · **Status:** planned · **Companions:** `procedural-ground.md`, `wall-materials.md`, `docs/ui/scene-authoring.md`.

## Why

The AI can build the right *shapes* for a stylized diorama (windmill, tower, barrels, fences) but everything comes out **flat-colored** — no stone, wood, shingle, or grass surfacing. An LLM can't paint texture *images*, but it CAN pick a **procedural material by name + params** — which is exactly how you get "make the tower stone, the roof blue shingles, the ground grass" with no image assets. Procedural materials are the LLM-friendly path to texture, and the single biggest lever to move AI scenes from "colored blocks" toward asset-quality.

## What ALREADY exists (build on it, don't reinvent)

- **Procedural surface catalog** `GROUND_SURFACES` (`src/world/ground-surfaces.ts`) — WGSL-shaded, NO images, world-space mapped so each works on **any mesh face** at any scale: **ashlar / brick / granite / slate / sandstone** (all the ashlar tiler, mode 0), **radialMedallion** (1), **borderStrip** (2), **grass** (3), **asphalt** (4), **concrete** (5), **dirt** (6), **cobble** (7), **plank** (8, wood). Each carries tile/grout/jitter/rough/tint + height→normal relief + weathering.
- **General applier:** `ShapeManager.applyGroundMaterial3D(meshId, { surface, extentMeters, tileMm, groutMm, tint, weather, … })` (`:3130`) — sets `material.groundMode` + params on ANY mesh. (Named "ground" but not ground-specific.)
- **Cel / toon shading:** `Material3D.renderStyle: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit'` — the diorama's hand-painted look = `'cel'`. Already settable via `setMaterial` (so the AI can already toon-shade; it just doesn't know to).
- **Geometric patterns** (`setMeshPattern3D`): stripes/checker/grid/dots + named presets (argyle, gingham…) — for windows, tiling accents.

**So a lot is already possible — it's mostly unexposed.** The new *materials* below are the genuinely missing stylized surfaces.

---

## Part A — Procedural materials to CREATE

Each new surface = a WGSL branch in `mesh3d-shaders.ts` (append a new `groundMode`; ⚠ never renumber) + a `GROUND_SURFACES` recipe. Priority-ordered by diorama impact.

> **Key mapping note:** the existing stone/grass surfaces map in **world space** (metres) so they tile consistently on any mesh. **Shingles/tiles must map in UV space** (mesh UVs) so rows follow a roof's slope. Primitives (cone/cylinder/revolve) have good UVs; metaballs/creatures have flat UVs (shingles won't map there — but roofs are cones, which do). Call this out per-material.

### A1. Shingles — LINEAR **[P1] — ✅ SHIPPED 2026-08-19**

**Built:** `groundShingle` WGSL fn (mesh3d-shaders.ts) — running-bond scalloped courses (rows along p.y, shingles along p.x, half-shingle offset), rounded lower edge (wider gap toward the sides), overlap shadow under the course above, lit lower lip, per-shingle tint jitter + height relief; dispatched as **groundMode 9** in `groundSurface` + `groundHeightM`. `GROUND_SURFACES.shingle` recipe (slate-blue default; tileMm=shingle width, aspect=w/rowH; tint to recolor). No API change — it's data-driven, so `setSurfaceMaterial(id,'shingle',{tint,tileSize})` already works. +4 tests (recipe mode 9, tile math, shader wiring). **★ browser-verify the LOOK** (shaders are appearance-untestable) — on a flat plane + a cone roof (UV-metric → courses should converge toward the apex). Original design below.


Overlapping scalloped rows: each row offset half a shingle, a rounded/pointed lower edge, a subtle per-shingle tint jitter + a darker shadow line under each row (the overlap). UV-space: rows along `v`, scallops repeat in `u`.
- **On a cone roof this gives the "radial converging" look for free** — the cone's UVs (u=around, v=base→apex) narrow toward the apex, so UV-linear shingles *appear* to converge. So LINEAR covers most stylized round/pitched roofs.
- Params: `rowHeight`, `shinglesPerRow` (or shingle width), `shape` (rounded|pointed|square), `overlapShade`, `jitter`, tint + `tintColor2` (two-tone like the blue roof).

### A2. Shingles — RADIAL (polar) **[P1] — ✅ SHIPPED 2026-08-19**

**Built:** `groundRadialShingle` WGSL fn (mesh3d-shaders.ts) — the polar cousin of mode 9: concentric COURSES (rings along radius, ringH) of SCALLOPS (around the angle) that converge to the centre. Scallop COUNT scales with each ring's circumference so a scallop stays ~scallopW wide at any radius (integer count → tiles the ring cleanly); half-scallop running-bond offset per course, rounded exposed edge facing the eave (outer r), overlap shadow from the course above, tint jitter + height relief. Centre = `uvM*0.5` (reuses the medallion's polar setup) → dispatched as **groundMode 11** in `groundSurface` + `groundHeightM`. `GROUND_SURFACES.radialShingle` recipe (slate-blue; tileMm = scallop width, aspect = scallopW/ringH). `setSurfaceMaterial(id,'radialShingle',{tint,tileSize})` works. +2 tests (recipe mode 11 + shader wiring). ★ **needs a disc-like/planar UV** (turret cap / flat rosette), NOT a lat-long sphere UV — same limitation as the medallion. ★ browser-verify the LOOK on a turret cap / cone tip. Original design below.

Concentric rings of scallops converging to a CENTER, mapped in **polar UV** (angle × radius) — for domes, turret caps, and top-down rosette roofs where UV-linear isn't enough. Reuses the `radialMedallion` polar machinery (mode 1) but with a scalloped cell instead of a paver.
- Params: `rings`, `scallopsPerRing` (or scales with radius), `shape`, two-tone tint.

### A3. Half-timber (plaster + beam frame) **[P1 — the tower body] — ✅ SHIPPED 2026-08-19**

**Built:** `groundHalfTimber` WGSL fn (mesh3d-shaders.ts) — off-white plaster panels (soft noise + fine grain) framed by a brown **timber lattice**: vertical posts + horizontal rails (shared on panel borders) + one diagonal brace whose direction **alternates per panel** (a zig-zag, so it reads as carpentry not a grid), wood-grain along each beam, beams proud of recessed plaster (height relief) + matte plaster / smoother timber roughness split. Dispatched as **groundMode 10** in `groundSurface` + `groundHeightM`. `GROUND_SURFACES.halfTimber` recipe (tint = plaster, grout = beam brown; tileMm = panel size, groutMm = beam width). Data-driven → `setSurfaceMaterial(id,'halfTimber',{tint,tileSize})` already works. +1 test + shader-wiring test. **★ browser-verify the LOOK** (on the tower body — panel size vs beam width, brace direction). Original design below.

A plaster/stucco base (soft noise, off-white) with a **timber beam lattice** over it (vertical posts + diagonal braces + horizontal sills, in a wood tint). The classic Tudor / windmill-tower look. A beam mask in UV (or world) space composited over a plaster base.
- Params: `plasterTint`, `beamTint`, `beamWidth`, `pattern` (posts | posts+diagonals | cross), `beamSpacing`, plaster `roughness`.

### A4. Toon stone **[P2] — ✅ SHIPPED 2026-08-19 (recipe-only, as predicted)**

**Built:** `GROUND_SURFACES.toonStone` — a preset over the **ashlar tiler (mode 0, zero new shader code)**: big blocks (1400 mm), bold dark grout (40 mm), low jitter (0.35) so it reads clean under `renderStyle:'cel'`. Exactly the "mostly free" path. +1 test. Pair with `setSceneStyle('cel')` for the punchy stylized-tower wall. ★ browser-verify the cel pairing is punchy enough; only add a dedicated branch if not.

Bolder, flatter masonry for the cel look: fewer/larger blocks, thicker high-contrast grout, near-flat per-block shading. Likely achievable as an **ashlar preset (big tile, wide grout, low jitter) + `renderStyle:'cel'`** rather than new shader code — spec it as a preset first, only add a dedicated branch if cel-over-ashlar isn't punchy enough.

### A5. Thatch **[P2] — ✅ SHIPPED 2026-08-19** — cottage/hut roofs
**Built:** `groundThatch` (mode 12) — horizontal courses of fine vertical straws (per-strand tint + shading streaks), a ragged shadowed lower fringe per course, matte + fluffy height. `GROUND_SURFACES.thatch` (warm straw; tileMm=strawW, aspect=strawW/courseH → portrait). Rows along p.y.

### A6. Clay barrel roof tiles **[P2] — ✅ SHIPPED 2026-08-19** — Mediterranean/Spanish roofs
**Built:** `groundClayTile` (mode 13) — rows of half-cylinder barrels (rounded cross-section: bright ridge/shaded sides via a `sqrt(1-x²)` dome), shadowed valleys between barrels, per-course overlap shadow, terracotta per-tile tint, glazed (rough 0.5). `GROUND_SURFACES.clayTile` (tileMm=barrelW, aspect=barrelW/courseH).

### A7. Lower priority **[P3] — ✅ CORE FOUR SHIPPED 2026-08-19**
- **Bark** (mode 14, `groundBark`) — vertical fibres + deep vertical cracks + height relief; tileMm=ridge spacing. Trunks/posts.
- **Corrugated metal** (mode 15, `groundMetal`) — sinusoidal corrugations + panel seams + brushed streaks, rough 0.35; tileMm=pitch, aspect=pitch/panelH. Tint grey=steel, copper/green=patina.
- **Leaves / hedge** (mode 16, `groundLeaves`) — two offset layers of jittered leaf dabs (`gr_leafLayer` helper), green per-leaf tint, soft height; tileMm=leaf size. Bushes/canopy.
- **Fabric / canvas** (mode 17, `groundFabric`) — plain over-under weave (rounded warp/weft) + soft folds; tileMm=thread spacing. Awnings/sails/tents.
- **Wicker / basket** (mode 18, `groundWicker`) — chunky over-under strand weave (checker of rounded strand ridges, dark gaps); tileMm=strand width. Baskets/furniture. **✅ SHIPPED 2026-08-20**
- **Rope / cord** (mode 19, `groundRope`) — twisted diagonal helical strand ridges + fibre grain; tileMm=strand pitch. Rope/cable/coiled handles. **✅ SHIPPED 2026-08-20**
- **NOTHING LEFT in Part A — the material library is COMPLETE (20 groundModes, 25 named surfaces).**

All six data-driven → `setSurfaceMaterial(id, 'thatch'/'clayTile'/'bark'/'metal'/'leaves'/'fabric', {tint,tileSize,weather})` works for AI + UI with no new plumbing. +2 test groups (shader wiring modes 12–17 + recipe sanity). ★ browser-verify the LOOKS (shaders are appearance-untestable — a single WGSL error would break ALL 3D, so eyeball each on a plane first).

---

## Part B — What ELSE we need to do (exposure + support)

### B1. Expose the surface materials to AI/UI **[the biggest immediate win] — ✅ SHIPPED 2026-08-19**

**Built:** `ShapeManager.surfaceMaterials3D()` (catalog names) + `SceneAuthoringAPI.setSurfaceMaterial(id, name, {tint,tileSize,weather})` (thin wrapper over `applyGroundMaterial3D`) + `surfaceMaterials()` + `setRenderStyle(id, style)` + `setSceneStyle(style)` (cel-shade the whole scene). Tools + dispatch + system-prompt ("objects default to flat color — setSurfaceMaterial(id, 'stone'/'grass'/'plank'…) + setSceneStyle('cel') for the stylized look"). +1 test. The AI can now texture any object with stone/brick/granite/slate/sandstone/grass/dirt/cobble/concrete/wood-plank and toon-shade the scene — **with zero new shader code**. ★ browser-verify surfacing on non-ground meshes + scale density.


- **`ShapeManager.setSurfaceMaterial3D(meshId, name, params?)`** — a clean rename/wrapper over `applyGroundMaterial3D` (the name "ground" misleads the AI). `name` = any catalog entry (ashlar/brick/granite/slate/sandstone/grass/dirt/cobble/plank + the new shingle-linear/shingle-radial/half-timber/thatch/…). `params` = tint / scale / weather overrides.
- **`ShapeManager.surfaceMaterials3D()`** — the catalog names (like `creatureSpecies()`), so the AI/UI can enumerate.
- `SceneAuthoringAPI.setSurfaceMaterial(id, name, params)` + `surfaceMaterials()` + tool defs + dispatch.
- System-prompt: "to texture a surface, call setSurfaceMaterial(id, 'stone'|'grass'|'shingle-linear'|'plank'|…). For the stylized/hand-painted look, also setMaterial(id, {renderStyle:'cel'})."

### B2. Cel/toon guidance **[free — already exists]**
`renderStyle:'cel'` is already settable via `setMaterial`. Add it to the system-prompt recipe for stylized scenes, and consider a per-surface cel default. A `setSceneStyle('toon')` convenience that cel-shades everything would be a nice one-liner.

### B3. Scale mapping **[must-handle]**
The surfaces tile in **metres** (`tileMm`) but illustration meshes are pixel-scale. `applyGroundMaterial3D` already takes `extentMeters`; `setSurfaceMaterial` must derive a sensible tile size from the mesh's world size (or expose a simple `scale`/`tileSize` param) so shingles/bricks read at a good density on a small object. Reuse the city-scale convention.

### B4. UV coverage **[constraint to document]**
Shingles/tiles/thatch need mesh UVs (they map in UV space). Primitives (cone/cylinder/revolve/box/sphere) have them; **metaballs/creatures have flat UVs** → world-space surfaces (stone/grass/plank) still work on them, but UV surfaces (shingles) won't. Note in the tool description which materials are world-mapped (any mesh) vs UV-mapped (primitives/roofs).

### B5. Assembly quality (orthogonal, but it's what closes the gap)
Textures fix the *finish*; the remaining gap to asset-quality is *assembly* — placing ~15 objects precisely + the fine geometry (individual shingles are now the shingle MATERIAL, not geometry — a big win). This is model-tier + iteration (Opus + our framing/fitToFrame), not new engine work.

---

## Sequencing & effort

1. **B1 expose the existing catalog [S — huge ROI]** — instantly gives the AI stone/brick/grass/wood/cobble/concrete on any object. Do FIRST; it's mostly wiring over `applyGroundMaterial3D`.
2. **A1 linear shingles [M]** — roofs are the most-wanted missing surface; covers cone/pitched roofs via UV.
3. **A3 half-timber [M]** + **A4 toon-stone preset [S]** — the tower look.
4. **A2 radial shingles [M]**, **A5 thatch / A6 clay tiles [M]** — more roof variety.
5. **B2 cel recipe / setSceneStyle [S]**, **B3 scale, B4 UV notes** — alongside B1.
6. **A7 bark/metal/leaves/fabric [M each]** — as needed.

## Definition of done (per material)
- WGSL branch in `mesh3d-shaders.ts` (new appended `groundMode`) + `GROUND_SURFACES` recipe + height→normal where it reads better.
- Reachable via `setSurfaceMaterial3D` + catalog list + `SceneAuthoringAPI` verb + tool + dispatch (sync-guard green) + system-prompt.
- Works under `renderStyle:'cel'` (verify the flat-band look).
- Params persist on the material (params-only, regenerate on load) — verify a save→reload.
- tsc + vitest (shader-string guards + the catalog/dispatch tests) + build green; **browser-verify the actual surface** (shaders can't be unit-tested for appearance) on a primitive + a cone roof.

## Not doing
- Image-texture generation (LLM can't; that stays the user texture-library path).
- Full PBR material authoring / node graphs — this is a curated stylized catalog, not Substance.

---

## Appendix — Material realism: how Substance works, and why our path is right for Salsa

*(Strategy note, so the reasoning survives compaction. Prompted by "why are Substance materials so realistic — do we need a node system?")*

**Why Substance materials look "so 3D and shaded":** not the color — it's a **full PBR map set** working under physical lighting: base color + **normal** (per-pixel surface direction — the "3D") + height + **roughness** (per-pixel matte/gloss — the "shaded well") + metalness + AO. A brick reads real because light responds correctly per-pixel (mortar deep + rough, brick smoother, wet spots glossy, AO in the lines). Plus **deep multi-scale layering** — macro shape → medium blocks → micro grain → nano roughness, composed explicitly (often 50–200 nodes).

**Static vs dynamic is the wrong axis (and almost backwards):** both are procedural. Substance usually **bakes to static image maps** loaded as textures; OUR materials run **live in the shader** (per-frame, resolution-independent) — so at runtime *ours* is the dynamic one. The realism gap is (1) full PBR maps vs our mostly-albedo+shallow-height/roughness, (2) a composable node graph vs our hand-coded single-purpose shaders, (3) detail depth. Not static-vs-live.

**The node system** = visual functional programming for images: generator nodes (perlin/voronoi/gradient/tile) + filter nodes (blend/warp/blur/curve/levels/height→normal) wired into a pure-function DAG that outputs the maps. Non-destructive, parametric, resolution-independent.

**Difficulty to build a Substance-like workflow, by part:**
- **Rendering side — mostly DONE.** We already do PBR-ish shading (diffuse/roughness/metalness + normals from height). The engine can *display* rich materials today.
- **Node-graph editor — medium→large.** A basic DAG + ~20 core nodes is achievable; a Substance-grade library + UI is a team-years project.
- **AI text-to-texture / image-to-material (Firefly) — NOT buildable by us.** It's a trained neural net. The only realistic path is integrating an **external image-gen model** (prompt → tiling albedo → derive normal/roughness algorithmically). Separate ML track.

**Verdict for Salsa (stylized/toon, NOT photoreal):** chasing Substance-realism would be building the *wrong* tool — stylized materials deliberately want clean shapes + cel shading + light surface relief, not photoreal micro-detail. Our procedural-surface + normal/height + `renderStyle:'cel'` approach is the *correct* tool for the diorama look. If we ever want richer, the 80/20 (in order): (1) **deepen the PBR maps we already emit** — more roughness variation, AO in crevices, stronger normals (cheap, big "3D surface" payoff); (2) **a small layering system** — stack 2–3 procedural layers per material with **curvature/AO masks** (wear on edges, dirt in cracks) — the "directed layering" that reads as intentional, ~5% of Substance's complexity for ~80% of the effect; (3) external image-gen only if photoreal text-to-texture is genuinely wanted. **This spec (curated stylized surfaces + cel) is the right track; a node graph is explicitly out of scope.**
