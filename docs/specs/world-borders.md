# World Borders — Void Grid, Terrain Apron, Tiled Expansion & Planet Mode

> **Deliverable of this pass:** this SPEC only. **No engine changes yet** — the phases below are built one at a
> time, each approved from a screenshot before the next. Save as `docs/specs/world-borders.md` (+ a backlog line
> + a memory pointer). Builds on the existing world stack ([[world-generation]], [[city-detail]]).

## Context — "give the world a *beyond*"
Today the city diorama floats on void with a hard border edge (the border N-gon at `params.radius`). Everything
below is about answering *what's past the edge* — and it layers cleanly from **decoration → terrain → topology**:

1. A **grid/rings extending past the border** (the "city in cyberspace" read) + an **edge glow** in City Edit Mode.
2. The grid giving way to **nature** (fields / forest / water) — the urban edge blending outward.
3. **Expanding the world into more tiles** (the "chunking" idea — a bigger flat map, Elden-Ring style).
4. **Planet mode** — curving the world onto a sphere, toggleable against **Flat mode**.

The through-line: each phase reuses the last. The void grid establishes the visual language; the terrain apron
fills it; tiling makes it infinite; the planet curves it. Ship the cheap, gorgeous parts first.

## Baseline (what exists, to reuse — don't rebuild)
- **Border polygon** `graph.border` (circle / square / hex / oct N-gon at `params.radius`, `center [0,0]`,
  spanning `[-R, +R]`). `borderPolygon(border, radius, sides)` in `util.ts`.
- **Ground / flat map**: `preview.buildLayoutPreview` tessellates the border into a draped road base (`fillGrid`,
  with a `skip?` predicate — already used to cut canal holes). A ground plane at `params.groundY`.
- **Shader pattern modes** (the "free texture" lever): `Material3D.patternMode` incl. `grid` (mode 5, world-
  proportional UVs), `windows`, `waves` — packed `patternParams` (freq/angle/scale/spacing) at MeshInstance
  floats 52–55. `LayoutPreviewLayer.pattern` + `emissive` plumbed through `addFlatColorMeshGroup`.
- **Cinematic post** (`setCinematicGrade`): bloom / grade / vignette keyed to the day cycle — the glow lever.
- **Height field**: `makeElevation(graph)` / `makeHeightField` = seeded value-noise sampled in WORLD coords; the
  manager drapes/lifts every layer through `_heightFn` / `_smoothFn`. **Already continuous in world space.**
- **Biome composer** `biome.ts` (trees in parks, garden trees, rocks) — the nature scatter to extend outward.
- **Seeded determinism**: `mulberry32` + `hash2`/`hash11`; **params-only persistence** (seed + sparse overrides).
- **Active-region editor** (multi-region enable/disable) — the LOD/streaming seam to reuse for tiling.
- **City thin-wrapper container** ([[world-generation]]) — the whole city is one node; a curve/planet vertex
  transform can ride on its shader path uniformly.

---

## Phase A — The Void Grid + edge glow  *(EASY · do first · huge payoff)*
A ground grid (or rings) extending **past** the border, fading with distance, + a bright border outline & glow
that reads especially in City Edit Mode. This is the "city exists in cyberspace" look and sets the visual
language for every phase after it.

### A1 · The infinite-feel ground grid
- A large ground quad at `groundY` (say `4·R` half-size) UNDER + AROUND the city, drawn with the existing
  `grid` shader pattern. **Radial alpha fade**: `alpha = 1 - smoothstep(R·1.0, R·3.5, d)` where `d` = distance
  from center → the grid is solid under the city and dissolves into the sky by the far edge (no hard cutoff, so
  no visible boundary of the grid plane itself).
- **Grid line color** = an emissive accent (cyber cyan by default; palette-driven) so it blooms via the existing
  post stack. New `LayoutPreviewLayer` `'World Void Grid'` with `pattern.mode='grid'` + `emissive`.
- Cheap: ONE quad + the existing shader. No new geometry system.

### A2 · Grid shape follows border type
The lattice under the void should echo the border:
| Border | Void pattern |
|---|---|
| Square | square grid (honeycomb of quads) |
| Hex | **hex grid** (needs a `hexgrid` shader pattern mode — a 3-axis line SDF, small addition) |
| Oct | oct+square grid (or fall back to square) |
| Circle | **concentric rings** expanding outward (a `rings` shader mode — `fract(d / spacing)` ring lines) + faint radial spokes |
- Two small new shader pattern modes (`hexgrid`, `rings`) — same packed-param plumbing as `grid`. Everything
  else is a branch on `params.border`.

### A3 · Border edge glow (City Edit Mode)
- Trace the **border polygon** as an emissive outline strip (a thin extruded ribbon along `graph.border`, a
  couple units tall or flat on the ground) — bright, palette-accent, bloom-boosted.
- **Only in City Edit Mode** (or a `borderGlow` param): a soft pulsing glow band just inside/along the edge,
  so the authoring workspace reads as a defined "stage." Reuses emissive + `setCinematicGrade` bloom.
- Optional: a subtle vertical "wall of light" / scanline sheet at the border for the Tron read (deferred sub-item).

**Phase A params:** `voidGrid` (bool), `voidGridColor`, `voidGridSpacing`, `voidFadeStart`/`voidFadeEnd` (×R),
`borderGlow` (bool). All `?? default`-guarded, persist with the world. **No topology, no seams** — it's
decorative ground, nothing has to connect. Frogmarks: a "Border" group (grid toggle + color + glow toggle).

---

## Phase B — Terrain apron (nature beyond the city)  *(MEDIUM)*
Past the border, the void grid gives way to **nature**: fields, forest, scattered ponds — the city blends
outward instead of ending at a line.

- **Apron ring** between `R` and `~2.5·R`: filled by an extended **Biome composer** — grass/field ground tint,
  tree clusters (reuse the scatter + tree geometry), rocks, the occasional pond (reuse `buildPonds`/water).
- **Urban→nature falloff**: a transition band just inside/outside the border where buildings thin (density
  ramp) → sparse structures (farmhouses/sheds) → open fields. Drives off distance-from-border.
- **The grid underlays and fades** as nature takes over (Phase-A grid alpha × a "nature mask") → "cyberspace
  becoming real." 
- Seamless by construction: the height field + biome already sample **continuous world-space noise**, so the
  apron meets the city ground with no discontinuity.

**Phase B params:** `terrainApron` (bool), `apronRadius` (×R), `natureDensity`, `apronBiome`
(`fields`|`forest`|`mixed`). Reuses `biome.ts`, tree/rock geometry, `makeElevation`.

---

## Phase C — Flat multi-tile expansion ("Elden Ring map")  *(MEDIUM-LARGE)*
The "expand into more grids" idea: the world becomes an **infinite lattice of tiles**; you grow it outward and
each new tile is a fresh seeded layout that **connects** to its neighbors. This is the first phase where
**seamlessness genuinely matters** — and it's the well-understood part.

### C1 · The tile lattice
- World = tiles indexed by integer coords `(tx, tz)` (square/oct borders) or **axial hex coords `(q, r)`** (hex
  border). Each tile spans `2R` (or a hex cell of circumradius `R`).
- **Per-tile seed** `hash(globalSeed, tx, tz)` → each tile is deterministic AND independently generable (no
  global build). The existing single-city generator becomes "generate tile (0,0)."

### C2 · The edge-lattice contract (the crux of seamlessness)
Two neighboring tiles must independently agree on what crosses their shared edge:
- Each **edge** has a canonical id `edgeId = hash(globalSeed, canonicalize(tileA, tileB, direction))` — both
  tiles compute the SAME id for the shared edge (canonicalize by ordering the two tile coords).
- From `edgeId`, deterministically place **portals** = the road/sidewalk crossing points along that edge (count +
  positions). Both tiles read the same `edgeId` → generate identical portals → **arterials from each side extend
  to the portals and meet**. Water channels / rivers cross via edge-seeded crossing points the same way.
- **Continuous fields, not per-tile**: elevation, biome, zoning/districts sample **global world-space noise**
  (already how `makeElevation` works) → automatically seamless across tile borders. Only the discrete lattice
  (roads/lots) needs the portal contract; everything continuous is free.
- This is exactly the Minecraft/No-Man's-Sky chunk-border technique: per-chunk deterministic seed + shared edge
  constraints. Medium difficulty, not scary.

### C3 · Streaming / LOD
- Generate only tiles within a radius of the active view; unload far ones (reuse the **active-region** enable/
  disable seam as a proximity filter). Far tiles → cheap flat-map LOD (the existing draft/preview build).
- Persistence stays params-only: the world = `globalSeed` + per-tile sparse overrides (KB, not MB).

**Phase C params:** `worldMode: 'diorama'|'tiled'`, `tileRadius` (how many rings of tiles live at once),
`expandDirection` hints. Pairs with the world-gen north-star ("later tile dioramas / streaming deferred").

### C — build milestones (do NOT need a LOD system up front)
A general/continuous LOD system is **not** a prerequisite for C. The render side has real headroom (one city =
227k tris at 60 fps on a Turing; frustum culling already exists → off-screen tiles are ~free), and a *coarse
tile-granularity* LOD is assembled for near-free from parts we already own: the **draft build** (`DRAFT_SKIP`) is a
ready-made MID tile, the **flat map** (`buildLayoutPreview` alone) is a ready-made FAR tile, and the **active-region
seam** already gates which tiles build at full detail. What actually walls first as tile count grows is *generation
time + scene bookkeeping* (each tile ≈ one city-gen) — that's **streaming**, not render-LOD. So:

- **C1 · Seam-proof (full detail, NO LOD, fixed small tile block).** `worldMode:'tiled'` generates a small N×N block
  (e.g. 2×2 or 3×3), each tile a per-tile-seeded `generateCityLayout` offset to its position, merged into ONE graph;
  restrict to **grid/square, terraces off, shotengai off** first (avoids the `levels`/canal seam trap). The whole point
  is to prove the HARD part — do the roads connect across the seam, and do the existing composers survive merged data?
  You want that visible at full detail; LOD would only hide whether the seams are right. Gated so diorama mode is 100%
  untouched. Note: for a regular grid with equal `cw` and tiles offset by exactly `2R`, edge roads *coincide* at the
  seam → connection is nearly automatic; the work is the graph MERGE (offset geometry + uniquify block/lot/region ids +
  union border + decouple `params.radius` = tile-size/prop-scale from the world extent used by fog/shadow).
- **C2 · Stream + coarse tile-LOD (scale past a handful).** Generate/keep only tiles within `tileRadius` of the view,
  unload far ones (active-region seam as the proximity filter); pick each live tile's build tier by camera distance:
  **full (near) → draft (mid) → flat-map (far)**. Cheap — it reuses draft/flat-map/frustum-cull. Profile first, add
  where it points. A sophisticated proximity/mesh LOD only becomes essential for the **street-level walkaround**
  north-star (zoom/walk INTO the world), which is a later, separate track — not a C blocker.

---

## Phase D — Planet mode  *(split: D1 achievable now · D2 research spike)*
"Curve the world onto a sphere" is really **two different problems**. Ship the easy, gorgeous one first.

### D1 · "Tiny Planet" shader dome  *(ACHIEVABLE · a Flat/Planet MODE toggle · no seams)*
A pure **vertex-shader projection** that domes the flat world toward a planetary horizon (Mario Galaxy /
Katamari). No topology change, no tiling, **no seams** (it's one continuous curved surface).

**The math** (applied to every vertex; center of curvature under the city at origin):
- Let `p = (x, y, z)` world-space, `d = length(x, z)` = horizontal distance from center, `R_p` = planet radius.
- **Gentle (parabolic) dome — first pass, cheapest:**
  `y' = y - d*d / (2*R_p)`  → the ground falls away quadratically; the horizon curves down. Buildings keep their
  Y-extent (just their base drops), which reads fine for gentle curvature.
- **True spherical bend — nicer, slightly more work:** arc angle `θ = d / R_p` (arc length preserved).
  - horizontal pull-in: `xz' = normalize(x, z) * R_p * sin(θ)`  (far things compress toward the limb)
  - height: `y' = (R_p + y) * cos(θ) - R_p`  (surface drops by `R_p*(1 - cosθ)`, local height rides the normal)
- **Building lean:** with a raw Y-drop, buildings far from center visually *lean* (they don't follow the surface
  normal). For a gentle dome the lean is negligible. To keep them upright, rotate each building's verts about its
  base point by `θ` toward the radial — needs the **building base `(x,z)` as a per-vertex attribute** so a whole
  building shares one `θ`. Deferred; the gentle dome ignores it.
- **Minimum radius** (the user's instinct, formalized): the edge (`d = R`) drops by `R²/(2·R_p)`. Keep that a
  sane fraction of `R` → clamp `R_p ≥ k·R` with `k ≈ 2–3`. Below that the world over-curves into a marble.

**D1 params:** `worldShape: 'flat'|'planet'`, `planetRadius` (×R, clamped ≥ 2R), `planetCurve` (0 = flat …
1 = full dome) for a smooth slider between the two. Rides the thin-wrapper container's shader path so ALL city
geometry curves uniformly. Sky/clouds either curve too or stay as a backdrop (tunable).

### D2 · True spherical tiling (walk all the way around)  *(RESEARCH SPIKE · gate by border shape)*
The genuinely hard version: tile the **whole** sphere with cells you can walk around. The catch — **you cannot
tile a sphere with a single regular polygon that tiles the plane.** Curvature has to come from somewhere:

| 2D cell | Tiles a flat plane? | Closes a sphere? | Planet topology |
|---|---|---|---|
| **Square** | ✅ | ❌ alone | **Cube-sphere** — 6 square faces subdivided + normalized. 8 mild corner singularities. |
| **Hexagon** | ✅ (honeycomb) | ❌ alone (stays flat) | **Goldberg polyhedron** — hexagons + **exactly 12 pentagons**. NO pole singularity. ★ gold standard. |
| **Triangle** | ✅ | ✅ | **Icosphere / geodesic** — all triangles, always closes. Universal fallback. |
| **Octagon** | ❌ (needs squares) | ❌ | flat only → gate OUT of true-planet (fall back to D1 dome). |
| **Circle** | ❌ (not a tiling) | — | no true tiling → D1 dome, or map onto an icosphere. |

**So the border shape *chooses* the planet topology** (the user's "only allow a spherical grid for shapes capable
of a sphere"):
- **Hex → Goldberg (hex + 12 pentagons)** is the flagship. It's the *gold standard* for procedural planets
  precisely because it avoids the pole-pinch of a UV-sphere. The **12 pentagons are the curvature defects** — and
  a delightful design hook: make them **12 special zones** (capital districts / anomaly landmarks) so the "seams"
  become features, not artifacts.
- **Square → cube-sphere** as an alternative (common in games; seams at 6-face edges, mild corner distortion).
- **Triangle/geodesic (icosphere)** = the universal fallback for any border.
- **Oct / Circle → no true tiling** → Planet mode falls back to the D1 dome (gate the toggle accordingly).

**Why it's a spike, not a phase:** our layout composer thinks in a flat plane (`x0(c)/y0(r)` grids, world-space
noise). Porting it onto Goldberg/cube-sphere cells means generating **in cell/face UV space** and handling the
seams (cube edges, the 12 pentagon neighborhoods). The **radius is quantized**: a closed Goldberg/cube-sphere of
a given cell size only exists at radii set by the subdivision **frequency** (cell count) — you can't dial an
arbitrary radius with fixed cell size (this *is* the "minimum radius so terrain wraps perfectly," made precise).
Do D2 **after** Phase C, so the edge-lattice/portal machinery already exists to reuse at cell boundaries.

---

## Recommended implementation order
**A → B → D1 → C → D2.**
- **A** (void grid + glow) first: cheap, sets the whole aesthetic, zero seam risk.
- **B** (nature apron): easy, makes the beyond feel real.
- **D1** (shader dome) early: a mode toggle with outsized wow-factor and NO seams — jump the queue ahead of tiling.
- **C** (flat tiling): the "bigger world" investment; builds the edge-lattice/portal contract.
- **D2** (true sphere): research spike LAST, reusing C's seam machinery; **hex→Goldberg** is the flagship path.

## Difficulty / seamlessness honesty
- **A** decoration → trivially seamless (it's ground). **B** apron → easy (continuous world-space fields).
- **C** flat tiles → **medium**, and this is the *only* place flat-world seams live — solved by the edge-portal
  contract + world-space continuous fields.
- **D1** dome → **no seams at all** (one curved surface). **D2** sphere → **hard**, seams at cube edges / the 12
  pentagon defects; the reason it's gated by border shape and deferred.

## Cross-cutting requirements (every phase)
- **Params:** add to `LayoutParams` + `DEFAULT_LAYOUT_PARAMS` with `?? default` guards (old saves load). Persist +
  restore via the params bundle; live via `updateCity` (debounced regen) where topology changes.
- **Determinism:** everything seeded (`globalSeed` + tile/edge/cell hashes); same seed → same world, always.
- **Persistence:** stays params-only — world = seed + sparse per-tile overrides (KB). No baked geometry saved.
- **Performance:** void grid = 1 quad; apron reuses instanced foliage; tiling streams within a radius (LOD far
  tiles to flat map); the dome is a vertex-shader transform (free). Cap concurrent tiles.
- **Reuse, don't rebuild:** border polygon, `fillGrid` skip-predicate, shader pattern modes, `makeElevation`
  world-space noise, `biome.ts`, active-region streaming seam, cinematic bloom, the thin-wrapper container.
- **Frogmarks (UI only):** a "Border / World" panel — grid toggle+color+glow (A), apron (B), Flat/Planet toggle +
  planet radius slider (D1), world mode diorama/tiled (C). Salsa owns geometry/shader; Frogmarks owns sliders.
- **Verification (per phase):** `npx tsc --noEmit` → rebuild + restart `ng serve` → screenshot each phase against
  its intent → tune the new params from the screenshot before the next phase.

## Open questions (decide per phase, at build time)
- Void grid: infinite-feel via a big fading quad, or a true camera-locked infinite-grid shader? (start with the quad.)
- Dome: do clouds/sky curve with the world or stay a flat backdrop? (probably backdrop first.)
- Tiling: pre-generate a fixed N×N, or true on-demand streaming as the camera pans? (fixed ring first.)
- Planet: is Planet mode a live authoring space (edit on the sphere) or a "finish → wrap" presentation mode? (present first.)
