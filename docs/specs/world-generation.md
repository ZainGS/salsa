# World Generation — Procedural Tiny Worlds (Roads, Biomes, Buildings, Life)

**Last Updated:** 2026-07-02
**Status:** 🚧 IN PROGRESS. Phases **1 (Layout), 2 (Biome), 3 (Street/Building) have a first pass built** in
`src/world/` (2026-07-02) — a seeded flat top-down map that extrudes into a low-poly 3D diorama. See
**§ v1 build status** at the bottom. Phases 4–8 remain spec-only, landing one at a time, screenshot-tuned like
the character/wardrobe work.
**Engine (proposed):** **two** new removable, feature-flagged modules in the `src/packaging/` style — **`src/world/`**
(the generation **composers**, `sm.world.*`) and **`src/game/`** (the runtime **sim**, `sm.game.*`). Both reuse the
procedural-generator pattern already proven in `body-generator.ts` / `clothing-generator.ts` / `hair-generator.ts` /
`attachment-generator.ts`, plus `scene3d-manager.ts` (scene graph, render, particles, lighting) and the PS1 retro shaders.
**v1 shape (see §6):** one **tiny orbitable diorama** (single region), **free-orbit** camera, **hybrid** roads
(grid for cities / organic for towns), **100% procedural** (hand-editing added later).
**Ownership — engine / editor / player (three layers, not two):**
- **Salsa engine** owns everything runtime: deterministic geometry + the render kit (the `src/world/` composers)
  **and a new Game System module** — `src/game/`, a *removable, feature-flagged* module in the same style as
  `src/packaging/` (core never imports it; single `sm.game.*` API surface). The Game module owns the **sim**: NPC
  schedules, battles, quests, rumors, world state, audio triggers. Its data **serializes into the `.frogmarks`
  document** (and packages into a `.frogcart`), like every other Salsa node.
- **Frogmarks = the UI host**, in two roles: the **Editor** (author/open `.frogmarks` projects) and the
  **Frogmarks Player** (runtime — play a packaged `.frogcart`). It provides UI + input, *not* game logic.
- **Why engine-side, not UI-side:** the Player runs the sim with **no editor present** (the Salsa Viewer already
  renders `.frogmarks` framework-free), so game logic can't live in the Angular editor — it lives in the shared
  engine module and its state rides in the package. This mirrors how `sm.packaging.*` already works.
**Siblings:** [character-variety.md](./character-variety.md) · [dollz-creator.md](./dollz-creator.md) ·
[render-styles.md](./render-styles.md) · [ephemera-system.md](./ephemera-system.md) · [array-tool.md](./array-tool.md).
**UI:** [world.md](../ui/world.md) (panel + `sm.world` API + `LayoutParams` reference).

---

## 0. Philosophy — a few PARENT systems that spawn coherent families (not 100 isolated generators)

The wishlist (roads, grass, trees, shops, roofs, lamp posts, benches, manholes, weather, frogs, NPCs, audio…)
is **not** 40 one-off generators. Scattering independent props reads as *random*; the goal is *handcrafted*. So
the whole system is a small number of **Composers** — parent systems that walk the world and emit a **coherent
family** of objects together, already placed to make sense with each other.

The canonical example (from the design chat that seeded this doc):

> **Street composer** → road → sidewalks → curb → lamp posts → street signs → shopfronts → manholes → benches →
> NPC spawn points → **all emitted in one pass, spaced and aligned to the same street centerline.**

That single rule — *compose families, don't scatter objects* — is the spine of this spec. Every system below is a
composer over a shared **world graph**, not a bag of loose generators.

**This is the same move we already made for characters.** "12 wardrobe features = 2 engines + cheap wins" and
"16 hairstyles = 6 reusable primitives" both collapsed a long wishlist into a few parametric systems. World-gen is
the same philosophy at city scale: **8 composers cover the whole list.**

---

## 1. What we already have (REUSE — do not rebuild)

World-gen is mostly *assembly* of tools we've built for the character creator. The hard parts already exist:

| Need | Already have | Where |
|---|---|---|
| Parametric mesh generators (seeded, live params, `?? default` guards) | body/clothing/hair/attachment generators | `src/services/managers/*-generator.ts` |
| **Seeded determinism** + per-strand jitter | `hash11` / seeded randomizer + fashion collections | character-variety.md, hair-generator |
| **GPU instancing** (thousands of identical parts, one draw) | Array Tool `MeshInstance` instancing | [array-tool.md](./array-tool.md) |
| **Params-only persistence** (save a scene as a seed + sparse edits, KB not MB) | character save-size work (60MB→96KB) | `project_perf_persistence` |
| **PS1 retro look** (affine warp, color-depth, dither) so the world matches the characters | `PS1Config` + mesh/skinning WGSL | [render-styles.md](./render-styles.md), reference_3d_shaders |
| **Lighting / sky / IBL** for time-of-day + weather mood | PBR/IBL lighting pass | recent "PBR/IBL lighting" commit |
| **Particles** for rain/fog/pollen/fireflies/dust | `ParticleEmitter3D` | ephemera-system.md, emotes.md |
| **Ground grid + snapping** for road/lot layout | 3D scene grid + viewport snapping | `project_scene_grid`, viewport-snapping.md |
| **Crowd / LOD** thinking (tiny worlds must stay cheap) | LOD noted as a crowd-render concern | `project_perf_persistence` |
| **Rigged, animated characters** (NPCs + trainers ARE our characters) | the entire character/armature/anim stack | clothing/hair/pose-driven-animation specs |
| Scene graph, orbit camera, scene animation / keyframes | `scene3d-manager.ts`, scene-animation.md | — |

**The character creator IS the NPC generator.** Every townsperson and rival trainer is a procedural character with
wardrobe + hair + face we can already generate, vary (seeded), and animate. World-gen adds the *stage*, not the actors.

---

## 2. Architecture — the World Graph + Composers

### 2.1 The World Graph (everything attaches to it)
A world is a **seeded hierarchical graph**, subdivided top-down, deterministically from one `worldSeed`:

```
World
 └ Region (biome + climate + palette)          ← "grassland town", "reactor wastes"
    └ District (residential / market / civic)   ← zoning
       └ Block (bounded by roads)
          └ Lot (a single parcel)
             └ Slot (building | plaza | park | landmark | empty)
```

Roads/paths are the **edges** between blocks; lots are the **faces**; slots are what gets built. **Layout is Phase
1 because every other composer reads this graph** (biomes fill the lot interiors, the street composer walks the
edges, landmarks claim slots, NPCs spawn at slot doors).

### 2.2 The Composer contract
```ts
interface Composer {
  name: string;
  /** Deterministic: same (worldSeed, chunk) → identical emission. Reads the graph, writes a family of things. */
  compose(ctx: WorldContext, chunk: ChunkId): Emission;
}
interface Emission {
  instances:    InstancedPlacement[];  // kit-part id + transform → ONE instanced draw per part (Array Tool)
  meshes:       GeneratedMesh[];        // unique geometry when instancing won't do (a specific facade)
  spawns:       SpawnPoint[];           // NPC / creature / item anchors — the Game module's sim consumes these
  interactions: InteractionTag[];       // door/sign/gate/shop → the Game module binds behavior to the mesh
  colliders:    Collider[];             // navmesh + physics
}
```
Composers **only read the graph + seed and emit**; they never mutate global state. This keeps the world
reproducible, streamable, and cheap to persist.

### 2.3 The shared Kit (why it all looks coherent)
One **retro kit** of modular, instanceable parts + a small palette per region: wall panels, roof pieces, window/
door modules, curb/road tiles, fence posts, foliage cards, rock chunks, props. Everything a composer emits is
either a **kit instance** (cheap, instanced) or a **parametric mesh** built from kit rules. Shared kit + shared
palette + shared PS1 material = the whole town reads as one artist made it.

### 2.4 Determinism & persistence (the character-save trick, again)
A saved world = **`worldSeed` (+ later a sparse `overrides` list)**, *not* baked geometry. Regenerate from the seed
on load. This is exactly the params-only character persistence that took saves from 60MB → 96KB — a whole world
persists in kilobytes. **v1 is 100% procedural (seed only, no overrides)**; the `overrides` list is *reserved in the
format now* so hand-editing can layer on later without a save-format change (see §6.6).

### 2.5 Budget, LOD & streaming (tiny worlds stay tiny)
- **v1 = one diorama, no streaming.** A single Region composes at once (it fits in view). Chunk-streaming below is a
  *later* concern for when dioramas tile into a bigger world — designed for, not built in v1.
- **Instancing first**: foliage, fences, windows, props, road tiles → instanced (Array Tool path). Unique meshes
  only where needed. Hard **budgets** (foliage/props can explode — cap them, like the hair card budget).
- **LOD tiers**: hero (close), mid, impostor (billboard). NPC crowds reuse the same LOD thinking flagged in perf work.
- **(Later) Chunked streaming**: the graph tiles into chunks; only near chunks compose + render; far = impostors.

---

## 3. The 8 Composers (the whole wishlist, grouped)

| # | Composer | Coherent family it emits | Maps to wishlist |
|---|---|---|---|
| 1 | **Layout** | roads, paths, sidewalks, plazas, alleys, bridges, gates, block/lot subdivision | World layout |
| 2 | **Biome** | grass, flowers, trees, shrubs, rocks, dirt, water edges, moss, weeds, ruins | Biomes / dressing |
| 3 | **Street & Building** | facades, roofs, windows, doors, balconies, signs, awnings, stairs, fences + lamp posts, benches, manholes, bins, poles, spawn points | Buildings + Props |
| 4 | **Landmark** | vaults, arenas, reactor, forest village, caves, crypts, battle tower (authored-feeling anchors) | Landmark / events |
| 5 | **Sky / Weather / Time** | sun/moon/stars, clouds, rain, fog, wind, seasonal palette shifts | Weather + time + sky |
| 6 | **Creature (FROG)** | species families, variants, evolutions/downgrades, abilities, battle + traversal anims | Creature generator |
| 7 | **NPC Life** | schedules, relationships, trainer-strength drift, rumors, shop hours, seasonal events | NPC simulation |
| 8 | **Audio** | procedural ambience layered by biome + weather + time + density + creatures | Audio system |

**Interaction** isn't its own composer — it's a *tag* every composer can attach (`interactions[]`), so a door a
building emits is already interactable, a sign already readable, a gate already lockable. The Game module binds behavior.

---

## Phase 1 — Layout composer  *(build first — everything hangs off it)*
The skeleton. Produces the world graph + the road/path network everything else reads.
- **Roads/paths — HYBRID by region type (§6.3):** a **grid** strategy for cities (clean blocks) and an **organic**
  strategy (seeded Voronoi / L-system winding paths) for towns/villages — one composer, the region picks the
  strategy. Arterials → streets → alleys. Snap to the ground grid (reuse the 3D grid + snapping). Emit **road tiles**
  (instanced) + curbs + crossings + bridges over water.
- **Subdivision:** blocks between roads → lots → slots, each tagged (residential/market/civic/park/landmark).
- **Emits:** road/sidewalk/curb instances, a **navmesh**, and the graph (consumed by all later phases).
- **Reuse:** ground grid, snapping, Array Tool instancing, seeded subdivision.
- **Unlocks:** literally everything downstream.

## Phase 2 — Biome composer  *(makes it feel alive fast, low risk)*
Fills lot interiors + roadside + wilds with dressing driven by a **biome field** (noise → grass/forest/rocky/water).
- **Scatter:** grass tufts, flowers, shrubs, trees, rocks, weeds, moss, dirt patches, water edges, ruins — Poisson/
  blue-noise scatter, density from the biome field, **all instanced**, avoiding roads + lots (reads the graph).
- **Trees/plants:** a small parametric plant generator (trunk + branch + foliage cards) — the hair-card / clothing
  generator pattern, PS1-carded. Seasonal tint hook (Phase 5 drives it).
- **Reuse:** `hash11` scatter, instancing, PS1 cards, collision-avoid vs the graph.
- **Unlocks:** a populated, non-empty world before any buildings exist (great for early testing).

## Phase 3 — Street & Building composer  *(the hero — the "handcrafted" payoff)*
The composer from §0. Walks each street centerline and each lot, emitting the **whole street family together**.
- **Buildings:** a facade/roof/window/door/balcony/awning/sign generator — modular kit parts stacked to a seeded
  height + width per lot (apartments, shops, stalls). Shopfronts face the street; roofs + fences fill gaps.
- **Street furniture:** lamp posts (evenly spaced on the centerline), benches, manholes, bins, utility poles,
  mailboxes, street signs, awnings — spaced *along the road*, not randomly, so it reads as planned.
- **Spawn points:** NPC + shopkeeper + item anchors at doors/corners (Phase 7 consumes them).
- **Interactions:** doors/shops/signs emitted pre-tagged.
- **Reuse:** kit + palette, instancing, the parametric-stack pattern (like clothing panel stacks), spring/anim later.
- **Unlocks:** dense, believable towns — the core of the game's overworld.

## Phase 4 — Landmark composer  *(authored-feeling anchors)*
Hand-designed set-pieces placed onto reserved landmark slots: ancient vault, tournament arena, reactor facility,
forest village, caves, crypts, battle tower.
- **Model:** each landmark is a *template* (a curated mini-scene / parametric structure) that claims a slot and
  blends its edges into the surrounding layout + biome. Seeded variation within a template (not fully random).
- **Reuse:** the building kit for structure; the graph for placement; interaction tags for entrances.
- **Unlocks:** memorable, quest-worthy locations; the "someone designed this" feeling.

## Phase 5 — Sky / Weather / Time composer  *(mood multiplier)*
A **global environment driver** (not tied to a chunk) that sets lighting, sky, and weather particles.
- **Sky/time:** sunrise→noon→sunset→night; sun/moon/stars; cloud layer. Drives the IBL/lighting + a palette curve.
- **Weather:** rain, fog, wind, snow via `ParticleEmitter3D` + fog/post params; wind sways foliage + spring bones.
- **Seasons:** a palette + foliage-tint shift the Biome composer reads (recolor, not regen).
- **Reuse:** PBR/IBL lighting, particles, post-processing, spring-bone wind, the retro palette system.
- **Unlocks:** the single biggest "expensive-looking" upgrade for the least geometry.

## Phase 6 — Creature (FROG) composer  *(the game's stars)*
The character-generator pattern aimed at frogs: **species families → variants → evolutions/downgrades**, each with
abilities + battle/traversal animations.
- **Model:** a parametric frog body (body/limb/eye/pattern params, seeded) with **family presets** (like hair/
  fashion collections); evolution = a param delta along a growth axis; "downgrade" = the reverse.
- **Anim:** reuse the armature + pose/clip system for idle/battle/traversal (hop, swim, climb).
- **Reuse:** body/attachment generators, armature, pose-driven animation, seeded variety, params persistence.
- **Unlocks:** the collectible roster — its own big sub-spec later (this phase just stakes the approach).

## Phase 7 — NPC Life composer  *(the sim layer — the Game System module)*
Pure data/sim over the Phase-3 spawn points (no new geometry). **Owned by the Game module (`sm.game.*`), not the UI;
its state saves into the `.frogmarks` project and packages into the `.frogcart`.**
- **Schedules:** NPCs route home→work→shop→home on the navmesh by time-of-day (Phase 5 clock).
- **Systems:** relationships, rival trainer-strength drift over time, rumors that propagate, shops opening/closing,
  seasonal events/festivals tied to landmarks.
- **Reuse:** the navmesh (Phase 1), spawn points (Phase 3), the clock (Phase 5), animated characters.
- **Unlocks:** a town that lives whether or not the player is looking.

## Phase 8 — Audio composer  *(cheap "expensive" feel)*
Procedural, **layered** ambience keyed to context — the last 10% that sells the world.
- **Layers:** base biome bed + weather (rain/wind) + city hum (density-scaled) + creature cries + battle-music
  stems. Cross-fade by biome/weather/time/proximity.
- **Reuse:** the world graph (density, biome), the clock + weather state, creature/landmark tags.
- **Unlocks:** immersion out of proportion to the effort.

---

## 4. Cross-cutting requirements (every phase)
- **Determinism:** same `worldSeed` → identical world. All randomness flows from the seed via `hash11`-style hashing.
- **Persistence:** save = seed + sparse overrides (params-only, KB). No baked geometry in saves; regen on load.
- **Retro parity:** everything renders through the PS1 material + region palette so the world matches the characters.
- **Instancing-first + budgets:** prefer instanced kit parts; cap per-chunk counts (foliage/props/windows explode).
- **Streaming + LOD:** chunked compose/render; hero/mid/impostor tiers; far chunks = silhouettes.
- **Composer discipline:** emit *coherent families* aligned to the graph — never scatter isolated objects.
- **Ownership:** the `src/world/` composers emit geometry + render kit + navmesh + spawn/interaction tags; the
  **Game module (`src/game/`, `sm.game.*`)** owns the sim + audio logic and persists into `.frogmarks`/`.frogcart`;
  **Frogmarks is only the UI** (Editor for `.frogmarks`, Player for `.frogcart`).
- **Build discipline:** `npx tsc --noEmit` only — **never `npm run build`** (breaks the Frogmarks dist). No backticks in WGSL comments.

## 5. Data model sketch (indicative)
```ts
type WorldSeed = number;
interface WorldContext { seed: WorldSeed; graph: WorldGraph; palette: Palette; env: EnvState; kit: Kit; }
interface WorldGraph { regions: Region[]; roads: RoadEdge[]; lots: Lot[]; }         // hierarchical, seed-derived
interface Lot { id: string; poly: V2[]; zone: Zone; slot: SlotKind; overrides?: LotOverride; }
interface InstancedPlacement { part: KitPartId; transform: Mat4; tint?: RGB; }       // → Array Tool instancing
interface SpawnPoint { kind: 'npc'|'shopkeeper'|'creature'|'item'; at: V3; tag: string; }
interface InteractionTag { kind: 'door'|'sign'|'shop'|'gate'|'elevator'; at: V3; meshRef: string; data?: any; }
interface EnvState { timeOfDay: number; season: Season; weather: Weather; wind: V3; }  // Phase 5 global driver
```

## 6. Decisions (resolved 2026-07-02) — the v1 shape
1. **Scale & format → TINY DIORAMA.** v1 is one hand-sized location you orbit (a single Region), matching the
   character viewer — *not* a streamed overworld. So chunk-streaming is deferred (§2.5); the whole diorama composes
   at once. A continuous/streamed world can come later by tiling dioramas.
2. **Camera → FREE ORBIT** (like the creator). Buildings/props must read from any angle (no single "front"); shop
   signage faces the street it's on, not the camera.
3. **Roads → HYBRID per region.** Cities generate on a cleaner **grid**; towns/villages use more **organic** paths
   (Voronoi/L-system). The Layout composer picks the road model from the region type — one composer, two strategies.
4. **Split → TWO MODULES.** `src/world/` (generation — pure, deterministic, cacheable, used by both Editor + Player)
   and `src/game/` (sim — stateful runtime) are **separate** removable feature-flagged modules (`sm.world.*` /
   `sm.game.*`), each lazy-loadable like the packaging chunk. Frogmarks = UI only (Editor for `.frogmarks`, Player
   for `.frogcart`). Sim state serializes into the package.
5. **Creature (FROG) → its own full spec, LATER.** Planned after the worldbuilding phases land; Phase 6 here only
   stakes the approach (the character-generator pattern applied to frogs).
6. **Authoring → PROCEDURAL-FIRST.** v1 generates **100% procedurally** (seed only, no `overrides`). Hand-editing
   (lot overrides, landmark placement) is added *after*, layered on as the sparse `overrides` list in §2.4 — so the
   persistence model reserves room for it now, but no editing UI is built until the procedural world feels right.

## 7. Recommended build order
**1 Layout → 2 Biome → 3 Street/Building → 4 Landmark → 5 Sky/Weather/Time → 6 Creature → 7 NPC → 8 Audio.**
(The design chat's order, and it's right: the graph must exist first; dressing makes it alive cheaply; the street
composer is the payoff; landmarks + sky + life + audio are escalating mood/immersion multipliers.) Reassess from a
screenshot after each phase before starting the next — same loop that's worked for the whole character system.

---

## v1 build status (2026-07-02) — Phases 1–3 first pass

Built in a new **`src/world/`** module (pure, deterministic; Salsa core never imports it) bridged to the scene
by **`src/services/managers/world-manager.ts`** exposed as **`sm.world`**. All geometry is verified headless
(zero NaNs / bad indices) and `npx tsc --noEmit` is green.

**File map**
- `src/world/types.ts` — `LayoutParams`, `WorldGraph`, `Lot`, `Block`, `RoadSegment`, `Zone`, preview-layer types.
- `src/world/util.ts` — seeded RNG (mulberry32) + 2D geometry: border Ngons, Sutherland–Hodgman convex clip,
  ear-clip triangulation, annular sectors, point-in-polygon, seeded scatter.
- `src/world/layout.ts` — **Phase 1**: radial (plaza→arterials→rings→wedge blocks, Lumiose-style) + grid
  strategies; clips every cell to the border; subdivides blocks→lots; seeded zoning. → `WorldGraph`.
- `src/world/preview.ts` — flat top-down **map** layers (cream road base + one merged mesh per zone + plaza).
- `src/world/meshbuild.ts` — tiny 3D accumulator (`prism`/`cone`/`blob`/`walls`/`cap`) → merged `MeshGeometry`.
- `src/world/biome.ts` — **Phase 2**: trees (2-tier conifers) dense in parks + garden trees in residential;
  rocks in parks. Merged foliage/trunk/rock layers.
- `src/world/streets.ts` — **Phase 3**: extrude building lots into massed buildings (height by zone) + slate
  roofs + lamp posts along arterials/rings. Merged per-zone building layers + roofs + posts + lamp lights.
- `src/services/managers/world-manager.ts` — `sm.world`: `generateLayout` / `generateBiome` / `generateStreets`
  / `generateWorld` / `clear`; auto-frames the camera; **DEV console hook `window.salsaWorld`**.
- `scene3d-manager.ts` — added world-agnostic `addFlatColorMeshGroup` / `removeFlatColorMeshGroup` (the ONLY
  core touch; takes plain geometry+colour, so core still never imports `src/world`).

**How to see it (until Frogmarks has UI):** in the browser console —
`salsaWorld.generate({ border: 'circle', pattern: 'radial', seed: 3 })` (or `.layout()` / `.biome()` /
`.streets()` individually, `.clear()` to remove). Borders: `circle|square|hexagon|octagon`. Patterns:
`radial|grid`. It's a ~20-unit diorama at default `radius:10` (auto-framed). Everything is seeded → same params
reproduce the same city.

**Known first-pass rough edges (for the morning):** flat-map colours + real buildings coexist (buildings sit
on the coloured plots — intended, but the palette may want tuning); lamp-post density/offset is a guess; no
water dressing yet (water lots are just blue); building massing is a single extrusion (no windows/roofs variety
yet — that's the next Street pass); grid-pattern zoning reads blockier than radial. All are param/tuning knobs.
