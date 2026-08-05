# Salsa — Work-Item Backlog (multi-agent audit, 2026-08-05)

A prioritized backlog produced by a six-subagent sweep of the whole `src/` tree + `docs/`, cross-referenced
against `docs/audit-2026-07-19.md` and `docs/TODO.md`. Items the July audit already fixed are **excluded**.

**Legend** — Severity: 🔴 High · 🟠 Med · 🟢 Low. Effort: **S** (hours) · **M** (a day or two) · **L** (multi-day / phased).
File refs are illustrative entry points, not exhaustive.

## Health summary

- The **renderer** and **scene-graph core** are in very good shape: the July audit's findings there are almost
  entirely worked off (leaf caches, skinned-mesh VRAM, and instance-path resources are refcounted and evicted on
  removal). Near-zero rotting `TODO`/`FIXME` markers in code; no `.skip`/`.only` left in tests.
- The **real risk concentrates in four places**: (1) persistence/undo correctness bugs in the services layer,
  (2) two ~15k-line untested god-objects (`scene3d-manager.ts`, `shape-manager.ts`), (3) character generators
  still running on the main thread, and (4) the uber-shader running full pattern/window ALU on every fragment.
- Below that sits a large, well-specced backlog of **unbuilt visual features** (city atmosphere, foliage, cars,
  wall materials, street-level, instancing).

---

## 1. Quick wins — high value, small effort (recommended first batch)

Mostly concrete save/load correctness bugs that silently lose or corrupt user work.

### 1.1 Placed props vanish on document reload — 🔴 **S**
`restoreProceduralFromSave3D()` hand-calls `restoreFromSave()` for only 8 of the 11 registered creators. Placed
**trash-bin, crate, vent, a-board, and stall** props write a params marker on save but are never re-adopted /
regenerated on load, so their geometry is lost. The base class already generalizes this — iterate
`this._creators.values()` instead of the hard-coded list.
Ref: `src/services/shape-manager.ts:6213` (and the registry at `:428`).

### 1.2 Saves persist the *previous* city after an async regen — 🔴 **S**
The params-only save marker is stamped in `generateLayout` / `_reflowTiledExtent`, but the primary City-mode
topology path (async/worker full regen) swaps `_graph`/`_params` in `_finishAsync` without re-stamping
`_cityContainer.worldParams`. After any seed/pattern/border/radius change through the async pipeline, save→reload
rebuilds the stale city (and the aliasing that lets selective edits survive is broken by the fresh `_params`).
Re-stamp at the end of `_finishAsync` + the worker-adopt branch.
Ref: `src/services/managers/world-manager.ts:1566`, `:723`, `:1298`.

### 1.3 Lighting edits don't persist without a topology regen — 🔴 **S**
`worldParams.lighting` is copied by value at stamp time; `setTimeOfDay` / `setSunAzimuth` /
`setOverrideGlobalLighting` re-apply the look but never re-stamp. Set dusk + a sun bearing and save without a
regen → the persisted lighting is whatever existed at the last regen. (JSDoc wrongly claims these persist; `sky`
is stored by reference so sky-palette edits leak through and mask the bug in testing.)
Ref: `src/services/managers/world-manager.ts:723`, `:2058`.

### 1.4 Undo stacks not cleared on document load — 🟠 **S**
`restoreDocumentState` clears layers/scene but never calls the existing `clearUndo3D()` (or resets the raster
snapshot stack). Load doc B while doc A's stack holds closures capturing A's meshes → Undo operates on
destroyed/foreign nodes, or resurrects a deleted A-mesh into B.
Ref: `src/services/shape-manager.ts:13143` (restore) + `:9715` (`clearUndo3D`, uncalled on load).

### 1.5 Night lamp point-lights leak out of City mode — 🟠 **S**
`_applyTimeOfDay` fills the night lamp pool via `setCandidatePointLights3D` (a distinct renderer list), but
`exitCityMode` / `_restoreGlobalLighting` only clear `setPointLights3D([])`; the candidate channel is never
cleared and `_snapshotGlobalLighting` never captured it. Exit City mode at night → warm lamp pools stay applied
to the host illustration.
Ref: `src/services/managers/world-manager.ts:1196`, `:2805`; `src/services/managers/scene3d-manager.ts:1202`.

### 1.6 Streamed tiles miss road signs (build-order drift) — 🟠 **S**
`TILE_BUILD_ORDER` claims to mirror `BUILD_ORDER` but drops `World Road Signs` (uncommented). The other three
build orders include it, so streamed neighbour tiles silently lack regulatory sign poles + warning-diamond GARP —
the exact "support group missing from one list" hazard.
Ref: `src/world/tile-build.ts:22` vs `src/services/managers/world-manager.ts` `BUILD_ORDER`.

### 1.7 Delete the tracked dead file — 🟢 **S**
`src/services/managers/body-generator.acceptable.ts.bak` (~975 lines) ships in git; it mirrors the live generator,
pollutes grep/search, and will diverge silently. (Flagged by three agents.)

---

## 2. Correctness bugs

### 2.1 GPU texture use-after-free in undo/redo — 🔴 **M**
`duplicateMesh` shares `diffuseTexture` / geometry by reference (`copy.diffuseTexture = src.diffuseTexture`), while
delete/clear/swap paths call `.destroy()` unconditionally — so deleting or re-texturing either copy frees a
`GPUTexture` the other still holds (use-after-free). Separately, GLB-import undo destroys textures but redo only
sets `gpuDirty` and re-adds the mesh (never re-uploads) → renders untextured after undo→redo. Needs a refcount /
clone-on-write + a redo re-upload.
Ref: `src/services/managers/scene3d-manager.ts:8798`, `:2921`, `:2832`.

### 2.2 Biome scatter breaks selective-regen idempotency — 🔴 **M**
`buildBiome` opens one shared composer-level RNG and consumes it in filtered lot-visit order for park trees,
rocks, and garden trees. The sequence a lot receives depends on how many earlier lots passed the region `keep`
filter, so editing one active region reshuffles trees/rocks elsewhere. This is the *same* class of bug the
streets fix eliminated (`streets.ts` now uses position-hash and brags about it) — biome was left behind. Switch
to position-hash (the street-tree block at `biome.ts:148` is already correct).
Ref: `src/world/biome.ts:66,108,111,113`.

### 2.3 IBL environment map doesn't round-trip on reload — 🟠 **S**
`getGlobalScene3DSettings` / `restoreGlobalScene3DSettings` never serialize the IBL env-map image, and restore
reaches a renderer private (`(renderer3D as any)._iblIntensity`) without re-enabling `iblEnabled` → image-based
lighting is silently dropped every reload. Also `directional`/`ambient` are captured by reference (not spread like
the sibling `{...fogConfig}`), so a later light edit mutates a snapshot a caller may still hold.
Ref: `src/services/managers/scene3d-manager.ts:9037`.

### 2.4 Orthographic view uses a perspective view-vector — 🟠 **M**
The scene uniform always writes the finite camera eye and shaders compute `V = normalize(camPos − worldPos)` per
fragment. In the orthographic builder/city view all view rays should be parallel (constant −forward); instead
fresnel, `envSpecular` reflections, rim light, and water specular track a fake eye, so highlights wander as you
pan/zoom. Pass an ortho flag (or a `w=0` direction) and use the constant forward when orthographic — the same
ortho-hazard class the SSAO notes warn about.
Ref: `src/renderer/3d/renderer-3d.ts:2698`; `src/renderer/3d/shaders/mesh3d-shaders.ts:413`.

### 2.5 CPU picker + selection box use rest-pose geometry — 🟠 **M**
GPU hover is skinning-aware but the CPU picker/selection-box path is not, so a posed/animated character
mis-picks and draws its selection box offset from where it renders.
Ref: `src/renderer/3d/mesh-picker.ts` (no `jointWeights`/skin path).

### 2.6 Shader marker substitution is unguarded — 🟠 **S**
The shadow-receiving shader variants are built with `String.prototype.replace('//__SHADOW_APPLY__', …)`, which
replaces only the first occurrence and silently no-ops if the marker text ever drifts → a shader compiles with the
literal comment left in and shadows vanish with no error. Assert each `replace` changed the string.
Ref: `src/renderer/3d/shaders/mesh3d-shaders.ts:2587` (markers at 1461/1873/2112/2510).

### 2.7 Water-draw vs water-test predicate mismatch — 🟢 **S**
`buildWater` only draws flat water for `zone==='water'` lots when the city has *no* canals, but `makeWaterTest`
(pedestrians + ducks) always treats water-zoned lots as water. In a graph carrying both canals and a water lot,
that lot becomes an invisible no-walk hole with no water disc under it. Latent today (grid-canals and
radial-water-lots are mutually exclusive) but the two predicates should derive from one source.
Ref: `src/world/water.ts:63` vs `src/world/elevation.ts:155`.

---

## 3. Performance

### 3.1 Uber-shader specialization (compile-time material variants) — 🔴 **M–L**
`patternMask()` ×3 + the large `windowsPattern()` execute per-fragment in both the textured and untextured mesh
shaders, for **every** mesh (characters, cars, terrain), even when patterns are off. Can't be runtime-branched
(fwidth uniformity), so it needs compile-time pipeline variants by material class via the marker-substitution
mechanism that already exists for shadows. Single largest citywide GPU cost still on the table. (Flagged by 3
agents.)
Ref: `src/renderer/3d/shaders/mesh3d-shaders.ts:1512`, `:2179`.

### 3.2 Character generators → Web Worker — 🔴 **L**
Body / clothing (6 fit passes) / hair (full spring-rig teardown+rebuild) run synchronously on the main thread; a
body-slider drag-end fires a multi-ms hitch. The generators are pure (params + verts in, typed arrays out) → a
Worker with transferable buffers is the unlock for live sliders and any crowd. Orchestration is already
debounced/diffed; the generators themselves are not offloaded. (Flagged by 2 agents.)
Ref: `src/services/managers/scene3d-manager.ts:3951`, `:4048`; `src/services/managers/body-generator.ts`.

### 3.3 `envSpecular` runs for every PBR fragment — 🟠 **S**
The ambient term unconditionally adds `envSpecular(...)` (a `reflect()` and, with IBL on, a 9-term SH irradiance
eval) even for matte dielectrics whose contribution is negligible. Gate on `metalness > ε` or an F0/roughness
threshold.
Ref: `src/renderer/3d/shaders/mesh3d-shaders.ts:100`, `:1807`, `:2423`.

### 3.4 Drape height-field is evaluated per-vertex — 🟠 **M**
`makeHeightField` runs ~8 hash lookups per vertex for a signal whose frequency is ~`1/(0.7·R)` (nearly constant
across a footprint) → millions of evaluations per full-detail regen. Replace with a coarse grid + bilinear
sample. (Audit §1.12, still deferred.)
Ref: `src/world/elevation.ts:16`.

### 3.5 Two disabled shape caches — 🟠 **M**
`getWorldSpaceCorners` caching is commented out with a TODO ("scaling handles break if I cache this") and
`getInverseLocalMatrix`'s cache is likewise disabled → hit-test sweeps (eraser/marquee) allocate 4 vec4 + a full
`mat4.invert` per shape per pointer event. The root cause (why caching breaks the handles) was never resolved.
Ref: `src/scene-graph/shapes/base/shape.ts:401`, `:358`.

### 3.6 Day-cycle rebuilds the lamp array every frame — 🟠 **S**
`playDayCycle` → `_applyTimeOfDay` rebuilds the entire candidate-lamp array (alloc + O(intersections) warp /
`cellLevelAt` walk) every frame, unthrottled, while `_applyGlow` right beside it is gated on `_lastGlowNight`.
Gate it the same way.
Ref: `src/services/managers/world-manager.ts:2800`.

### 3.7 Raster undo snapshot is full-canvas per paint — 🟠 **M**
`pushSnapshot` does a full-canvas `copyTextureToBuffer` + `mapAsync` + row-unpack + byte dedup per paint action,
retaining uncompressed RGBA copies (O(canvas), main-thread). (Audit §2.2, still deferred.)

### 3.8 Per-frame draw-list allocation to find overlays — 🟠 **S**
The always-on-top overlay capture spreads the whole draw list into a fresh `[...opaqueSimple, ...opaqueVC,
...transparent]` array every frame purely to collect `alwaysOnTop` meshes (usually zero — only the landmark
card). Track a `hasAlwaysOnTop` flag or iterate the three lists in place.
Ref: `src/renderer/3d/renderer-3d.ts:2317`.

### 3.9 Instance-buffer growth hitch on big-city load — 🟢 **S**
`ensureInstanceBuffer` grows with 50% headroom; each growth allocates a new GPUBuffer, rebuilds `meshBindGroup`,
and forces a full repack. On first big-city load or a large streamed region this is a visible one-frame hitch.
Seed the initial capacity from a city-scale estimate to avoid repeated warm-up doublings.
Ref: `src/renderer/3d/renderer-3d.ts:2777`.

---

## 4. Unfinished features (high user-visible value)

### 4.1 City Visual Upgrade — "City Edit Mode" atmosphere pass — 🔴 **L (phased)**
The most user-visible aerial win, achievable now (Salsa is structurally close; the gap is atmosphere / lighting /
density). Phased: aerial fog + sky/clouds → SSAO/soft-shadow/hemisphere fill → grade/god-rays → glass-tower
skyline density → lush nature. Reuses the existing fog/grade/shadow/cloud/point-light stack.
Ref: `docs/specs/city-visual-upgrade.md`.

### 4.2 Procedural Foliage Generator — 🔴 **L**
Building-attached bushes/hedges, wall vines, window flower baskets + freestanding landscaping via one shared
`buildFoliage(spec)`. Also finish the alpha-cutout **leaf-card** render path (`render:'card'` currently falls back
to chunky). Big visual-density lever.
Ref: `docs/specs/foliage-generator.md`, `docs/specs/foliage-quality.md`; `src/world/foliage.ts:9`.

### 4.3 Car Creator — lofted bodies + matcap sheen — 🔴 **L**
Replaces the boxy `vehicle.ts` fallback with GT-PS1-grade lofted car bodies, profile presets, a matcap
reflection (sequenced **first** — biggest independent ROI), and a single paintable body atlas feeding UV-paint +
GARP liveries. Highly visible across the whole city.
Ref: `docs/specs/car-creator.md`.

### 4.4 Building Generator — visual tuning + Phase 8 (LOD + Designer) — 🔴 **M**
Phases 1–7 are built and wired on by default. Remaining: a subjective visual-tuning pass from real renders, plus
Phase 8 LOD + a standalone Building Designer UI (the LOD source a street-level view needs).
Ref: `docs/specs/building-generator.md`.

### 4.5 Instancing tiers / Neighborhood Blocks — 🔴 **L (foundational)**
Canonical local geometry per width-bucket + transforms, keyed by (feature, bucket, style); tiers up to scene-wide
shared buffers and a Block container. Cuts draw calls + VRAM (incl. the 147→46MB instanced-building-foliage win)
— foundational for bigger/denser cities and street-level.
Ref: `docs/specs/instancing-blocks.md`, `docs/specs/city-lod.md`.

### 4.6 Street-level walkaround mode — 🔴 **L**
North-star second camera that walks the world rendering nearby blocks at high detail; reuses the active-region
streaming seam as an LOD filter. Gates occlusion-culling PVS, storefront-detail, and streaming Phase 4. Deferred
until the builder view is high-quality, but it's the pivot point for much downstream work.
Ref: memory `project_street_level_mode`; `docs/specs/occlusion-culling.md`.

### 4.7 Shop "blade"/storefront sign text atlas — 🟠 **M**
Shop signs are still colored rectangles; only landmark plates + shotengai boards are real text. A sign/text atlas
would sharply raise the "real city" read at low effort.
Ref: `src/world/signtext.ts:5`.

### 4.8 Wall Materials P2–P4 — 🟠 **M**
Phase 1 (brick-course / concrete-seam relief in the shader) is built; remaining is a real wall-material library
(stucco/precast/tile/metal/timber + per-building selection), trim/cornice grain + edge AO, and lighting-contrast /
glass. Directly attacks "buildings look flat."
Ref: `docs/specs/wall-materials.md`.

### 4.9 SSAO — finish Stage 2/3 + persistence + style gating — 🟠 **M**
Stages 1+2 built. Remaining: browser-verify Stage 2 tuning, gate off for cel/PS1 styles, persist `ssao` in
`worldParams.lighting`, Stage 3 half-res + depth-aware upsample + tiled-full auto-off, and add skinned characters
to the prepass. (Plus the low-effort "AO Clay" render style.)
Ref: `docs/specs/ssao.md`; memory `project_ssao`.

### 4.10 Reversed-Z depth (depth-precision Phase 2) — 🟠 **M**
Phase 1 adaptive near-plane is built; Phase 2 (reversed-Z, `depth32float`, a DepthConvention module) is not. Fixes
z-fighting at city scale / far distances — strategic for the perspective/street-level view. (Flagged by 2 agents.)
Ref: `docs/specs/depth-precision.md`; `src/renderer/3d/camera-3d.ts`.

### 4.11 Character content depth — 🟠 **L**
Body generator self-describes as a v1 prototype (silhouette/extremities rough). Unbuilt content specs: Character
Variety (silhouette classes + seeded randomizer + crowd hook), Hair-style system (bob/wolf/bun/braid/afro, phased
A–E), Emotes (joint-anchored 2D billboards), Dollz/Fashion Creator wrapper. Spring-bone authoring UI + garment
dynamics (cloth Phase 2) also pending.
Ref: `docs/specs/character-variety.md`, `hair-styles.md`, `emotes.md`, `dollz-creator.md`; `character-system-backlog.md`.

### 4.12 Package Creator print pipeline + mechanisms — 🟠 **L**
Only mechanisms `M1 addTuckFlap` and `M2 addGlueTab` exist; the spec's `M3/M6/M7` and the Print-PDF / dieline
export (the `[next]` item) are unbuilt — the gap between "folds in the viewport" and "manufacturable die-line."
Ref: `src/packaging/mechanisms.ts:1`; `docs/specs/packaging-templates.md`.

### 4.13 Frogmarks (host) UI wiring — 🟠 **M**
A large batch of shipped engine features have no host UI: City Detail toggles (day/night, weather, holograms,
shader modes), scene-grid, anime face/eyes, hair/clothing/eyes panels, UV-Paint toggle + mesh-texture library,
GARP "Skins" panel sync, Decals stamp tool. Low engine risk, high perceived-completeness payoff. (Re-verify
against code — the integration-status notes are stale.)
Ref: `docs/TODO.md` (Host UI wiring); memory `project_frogmarks_integration_status`.

### 4.14 Shell UI — renderer-coupled lifecycle — 🟠 **L**
The WebGPU home-screen data/state layer is built, but the render-coupled lifecycle
(`initialize/destroy/launchSlot`) is stubbed and there's an unsolved AppComponent-black render-coupling bug.
Largest remaining greenfield host item.
Ref: `docs/specs/shell-ui.md`; memory `project_shell_render_coupling`.

### 4.15 Ground-scatter props are placeholders — 🟢 **L**
`ground-scatter.ts` self-documents that everything but tallGrass is a "LOW-POLY placeholder" pending the P2/P4
quality pass.
Ref: `src/world/ground-scatter.ts:322`.

---

## 5. Tech debt / robustness

### 5.1 Two untested ~15k-line god-objects — 🔴 **L**
`scene3d-manager.ts` (15.2k lines, ~290 private fields, ~20 subsystems) and `shape-manager.ts` (14.2k) hold nearly
all the `as any` and all the risk, with **no tests**. Concrete first extractions (low coupling, self-contained
state): LandmarkCard overlay (`world-manager.ts:1675`), TrafficSim (`world-manager.ts:2199`), grease-pencil,
global scene settings, snap/grid, procedural-ground scatter, clothing-rig — behind typed interfaces + a
characterization-test harness.
Ref: `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`.

### 5.2 Duck-typed mesh flags via `(x as any).flag` — 🔴 **M**
Hot-path flags are read/written untyped: `(mesh as any).isSkinned` / `.skinDirty` (`scene3d-manager.ts:3061`),
`(mesh as any).isClothing` (`shape-manager.ts:6860`), `(m as any).isProceduralBody` (`:7468`). Renaming any
silently breaks rendering with zero compiler help. Promote to declared optional fields on the mesh/shape interface.

### 5.3 No generator / rig-invariant tests — 🔴 **M**
The entire character pipeline (body/clothing/hair/eye/skeleton/spring) has zero tests, despite a documented
history of silent geometry bugs (collapsed verts, armpit spikes, UV bleed, 4 restore bugs). Add a
`validateBodyResult()` dev guard (weights sum to 1, no NaN/degenerate tris, joint-count stability) + golden tests
before further tuning. (Flagged by 2 agents.)
Ref: `src/services/managers/{body,clothing,hair}-generator.ts`.

### 5.4 Untyped persistence deserialization — 🟠 **M**
Save JSON is cast straight to `any` at the load boundary (`blendShapes`, `rasterLayers`, `textureLibrary` —
`scene3d-manager.ts:3357`, `shape-manager.ts:10929`). Exactly where a save-format change becomes a silent runtime
break rather than a type error. Define explicit persisted-state DTOs and validate on load.

### 5.5 Texture library stored as base64 in JSON — 🟠 **M**
`TextureLibrary.toJSONWithData()` embeds every material texture as a base64 data-URL in the saved JSON (+33% size,
re-gzipped every 3D-dirty save). Move to binary sidecars like GLB/PNG. (Audit §2.13, still open.)
Ref: `src/services/texture-library.ts:160`.

### 5.6 Save-bloat is opt-out per site, not serializer-enforced — 🟠 **S**
Procedural city/scatter/block geometry stays out of the save only because each creation site remembers to set
`excludeFromDocument`/`documentSkipChildren`; any new procedural mesh path that forgets bakes full vertex data
into JSON (the autosave-freeze/bloat class). Add a serializer choke-point assertion. Separately, five mesh-restore
paths assign `mesh.keyframeTracks = state.keyframeTracks` by reference (unguarded shared-array invariant).
Ref: `src/services/managers/scene3d-manager.ts:2110`, `:3135`.

### 5.7 `WorldManager` has no `dispose()` — 🟠 **M**
Per-frame LOD/stream callbacks + gizmo-sync are registered once in the ctor via `addPreRenderCallback3D` and never
removed or rebound on renderer reinit. On device-loss / canvas reinit, City LOD culling + tiled stream-follow
silently die; on manager recreation the old callbacks fire forever against stale state (the class even ships a
leak counter acknowledging this).
Ref: `src/services/managers/world-manager.ts:252`, `:2891`.

### 5.8 `window.*` debug globals baked into shape-manager — 🟠 **M**
~20 debug hooks (`salsaCreator`, `salsaGround`, `salsaPkgCreator`, …) are attached to `window` inside the main
service file. Extract into a single typed `installDebugGlobals()` module gated behind a dev flag.
Ref: `src/services/shape-manager.ts:446`.

### 5.9 Private-member pokes via `as any` — 🟠 **S**
shape-manager reaches undeclared renderer internals: `(webgpuRenderer as any).rasterUndo?.()`,
`(renderer3D as any)._iblIntensity`, `(webgpuRenderer as any).swapChainFormat`. Expose as real public
methods/getters so a rename is caught.
Ref: `src/services/shape-manager.ts:1262`, `:9047`, `:9538`.

### 5.10 No test guards the four build-order lists — 🟠 **M**
`BUILD_ORDER` / `CENTRE_BUILD_ORDER` / `TILE_BUILD_ORDER` / `generateStreets` stay in lockstep only via prose;
item 1.6 proves that guard already failed. A table-driven test (each list ⊆ BUILD_ORDER, same relative order) +
a region-filter idempotency test would lock both invariants (and would have caught 1.6 and 2.2).

### 5.11 gl-matrix bridge-cast duplication — 🟢 **M**
~58 copies of `matrix as unknown as mat4 / Float32Array` across skeleton/solver/renderer/gizmo files hide the real
type mismatch between the engine's matrix type and gl-matrix. Add one typed helper (`asMat4()` / `asF32()`).

### 5.12 Misc in-code markers — 🟢 **S**
`raster-paint-engine.ts:305` "Remove once RasterDrawingService is fully migrated" (dead migration path still
live); `raster-selection-mask.ts:497` ping-pong optimization; two "should-never-happen" `console.error` guards
worth converting to real handling (`strokes-staging-buffer.ts:354`, `scene3d-manager.ts:13576`).

---

## Metrics (code-health sweep)

- `TODO`/`FIXME`/`HACK`/`XXX` in code: **10** (all minor — debt lives in `docs/`).
- `@ts-ignore`/`@ts-expect-error`/`as any`/`as unknown as`: **534** across 78 files (`as any` = 272 non-test; ~58
  are mechanical gl-matrix casts). The harmful subset is the ~40–50 duck-typed flag / private-member accesses.
- `console.error`/`console.warn`: **147** (only ~3 are genuine "should-never-happen" guards); empty `catch {}`:
  **3** (all benign teardown); `.skip`/`.only`/`xit` left in tests: **0**.
- Biggest files (all untested): scene3d-manager 15.2k · shape-manager 14.2k · webgpu-renderer 5.0k · renderer-3d
  4.5k · world-manager 3.0k · mesh3d-shaders 2.6k · gizmo-renderer 2.4k · pipeline-manager 2.2k.
- Test files: 60 vs 364 source files; every top-12 largest/central file has no colocated test.

---

*Generated by a six-subagent audit (renderer/GPU, world-gen, services/managers, scene-graph/character,
docs/specs, code-health) on 2026-08-05. Items already fixed in the 2026-07-19 audit round were excluded.*
