# Creator Modes & the Generator Registry — the Frogmarks platform spec

**Status:** 📋 Spec (2026-07-08). Nothing built this pass — phases land one at a time later.
**Companion:** [world-generation.md](./world-generation.md) (the composer/IR architecture) · [character-variety.md](./character-variety.md) (the preset/collection pattern) · docs/ui/world.md (the consuming city)

---

## 1. The vision this serves (the "world compiler" framing)

Frogmarks is converging on a four-layer platform:

| Layer | What | Examples |
|---|---|---|
| **1 · Engine (Salsa)** | render/runtime tech | WebGPU renderer, scene graph, instancing, post stack |
| **2 · Procedural authoring** | the GENERATORS — the core product | character, hair, clothing, city, packaging… and everything in §4 |
| **3 · World compiler** | seed + style + rules + gameplay → a compiled playable world | params = *source code* · **WorldGraph = the IR** · composers = *codegen passes* · `.frogcart` = the *binary* |
| **4 · Experiences** | products built on it | the FROG game (flagship), avatar creator, package designer, education/engineering |

Every shipped system already follows one contract: **`params + seed → deterministic output + metadata`**, sparse
overrides, presets as data, `sm.*` bridge, removable module. This spec names that contract, gives each generator
an authoring UI (**a Creator Mode**), and defines how user-authored presets feed back into the city compiler
(**preset pools**). Discipline (agreed): **extract the framework from shipped generators — never pre-design it.**
The Character Creator is the template; the city's sub-objects are the extraction candidates.

## 2. The core idea — Creator Modes + preset pools

Today the city hard-codes its sub-objects (`addTree` has four baked species; `carLayers` has five baked colours;
`addAwning` has three baked silhouettes). The move:

1. **Extract** each sub-object into a parameterized generator: `buildX(params: XParams, seed) → LayoutPreviewLayer[]`
   (pure, Accum3D-merged, deterministic — exactly like every existing builder).
2. **Author** it in an **X Creator Mode** — the Character-Creator pattern applied to everything: enter a focus
   workspace (orbit + clean bg, the `enterCityMode3D` machinery), one live preview instance, sliders bound to
   params, seed + 🎲 randomize, style presets, **Save as Preset**.
3. **Consume** saved presets in the city: `LayoutParams` gains **preset pools** — per archetype slot, a weighted
   list of saved presets the composer hash-picks from per instance:

```ts
// LayoutParams (addition — JSON-serializable, so it persists + stays deterministic)
presetPools?: {
  tree?:     TreeParams[];      // street/park trees pick from YOUR trees
  vehicle?:  VehicleParams[];   // traffic + parked cars pick from YOUR cars
  awning?:   AwningParams[];
  door?:     DoorParams[];
  building?: BuildingParams[];  // massing/roof/facade recipes per zone
  // …one optional slot per extracted generator; absent slot = the built-in defaults (today's look)
}
```

Key insight: the city never places ONE door — it places hundreds with seeded variety. So the unit of consumption
is a **pool** (a user's *collection*, same as fashion collections), not a single preset: the composer picks per
instance by position-hash and may still jitter *within* a preset (per-instance scale/tint wiggle stays).

## 3. The generator contract (extracted, minimal)

Every generator — existing and future — exposes:

| Piece | What | Exists today as… |
|---|---|---|
| `XParams` + `DEFAULT_X_PARAMS` | flat, JSON-safe, `?? default`-guarded (old saves load) | `LayoutParams`, `HairParams`, clothing params |
| `buildX(params, seed)` | pure, deterministic, merged geometry + metadata | every `src/world` builder |
| **Param schema** | machine-readable UI spec: `{key, label, type: number\|bool\|enum\|color, min, max, step, group}` | *(new — see §6)* |
| Presets | named param bundles | style packs, hair presets, clothing presets |
| Creator Mode | the authoring workspace | Character Creator / City Tool mode pattern |
| Consumption hook | which composer slots accept its presets | *(new — preset pools)* |
| (later) simulation hooks, constraints, export | the engineering extension | traffic sim is the toy proof |

The **param schema** is the highest-leverage new piece: with 20+ creator modes, Frogmarks cannot hand-build 20
panels. Schema-driven panels mean one generic Angular component renders any creator; the same schema doubles as
the **MCP tool spec** later (the AI-as-interface story — "make it more Scandinavian" = a parameter walk).

## 4. The generator catalog — everything we could make a creator for

**Legend:** ✅ shipped generator · 🏗 implicit in the city (hardcoded constants → extraction candidate) · 📋 future.

### Characters & life
| Generator | Status | Notes |
|---|---|---|
| Character | ✅ | THE template for creator modes |
| Hair | ✅ | style-system spec phased separately |
| Clothing (top/bottom/shoes/socks) | ✅ | presets exist |
| Accessories/charms | ✅ v1 | |
| Face/eyes | ✅ | procedural eye generator |
| Pedestrian/NPC archetype | 🏗 | walkerLayers (cloth/robot) → later replaced by crowd-scale characters |
| Creature/FROG | 📋 | own spec after worldbuilding |

### Buildings & architecture
| Generator | Status | Notes |
|---|---|---|
| Building (massing + roof + facade recipe) | 🏗 | the crown jewel; zone-weighted pools |
| Roof | 🏗 | 9 styles + shingle shader params |
| Window/facade rhythm | 🏗 | windows-mode params (freq/inset/wall style) + interior-mapping palette |
| Door + stoop | 🏗 | already stamped anchors (door-visit sim) |
| Awning | 🏗 | 3 silhouettes + stripe params |
| Balcony / fire escape | 🏗 | |
| Landmark templates | 🏗 | 11 authored templates → parameterize |
| Interior room | 🏗 | interiorRoom() hash palette → author room types |
| Interiors (real, walkable) | 📋 | street-level mode era |
| Furniture | 📋 | benches/tables exist as micro-props |

### Streets & infrastructure
| Generator | Status | Notes |
|---|---|---|
| Street light / lamp post | 🏗 | |
| Utility pole + wires | 🏗 | catenary params |
| Traffic signal / signage | 🏗 | |
| Shop sign / blade sign / sandwich board | 🏗 | + text-sign fonts/colours |
| Bridge | 🏗 | arch/fascia/balustrade/lamps params |
| Railway/viaduct + train | 🏗 | consist length, livery |
| Road paint & markings | 🏗 | |
| Fence/railing, stairs | 🏗 | |
| Street furniture (vending/bench/bus stop/post box) | 🏗 | |

### Nature & environment
| Generator | Status | Notes |
|---|---|---|
| Tree / plant / bush | 🏗 | 4 species + sakura → the ideal FIRST extraction |
| Rocks | 🏗 | |
| Terrain/elevation | 🏗 | noise + terraces params |
| Water (canal/pond) | 🏗 | ripple params |
| Cloud | 🏗 | |
| Weather system | 🏗 | rain/snow/lightning params |
| Sky (stars/moon), day-cycle grade | 🏗 | TimeGradeKeys are already author-able |
| Park props (playground/fountain/gazebo) | 🏗 | |

### Vehicles & movers
| Generator | Status | Notes |
|---|---|---|
| Car/vehicle | 🏗 | archetype instancing makes pools nearly free |
| Bus, boat, flying vehicle, hologram | 🏗 | |
| Bird/flock | 🏗 | |

### Meta-generators (cross-cutting)
| Generator | Status | Notes |
|---|---|---|
| Palette | 🏗 | 5 curated → user palettes feed EVERYTHING |
| Surface pattern/texture | 🏗 | the shader pattern modes ARE a texture generator |
| Style pack | 🏗 | packs are data — a "Style Pack Creator" composes other presets |
| Packaging/box | ✅ | the package designer |
| Text effects/ephemera | ✅ | |
| City/world | ✅ | the consumer of all of the above |

### Engineering extension (later, per the vision)
Door/chair/beam/bridge with constraints + simulation (structural, flow, traffic) — same contract + a simulation
layer; **not before the game loop ships**.

## 5. Decision (2026-07-27) — scope, decomposition, and how the stage gets extracted

Two refinements agreed after the first props/materials pass, updating everything above:

### 5.1 Procedural creation is its OWN feature family — armature/mesh-edit are NOT part of it

There are two distinct kinds of "edit one object in orbit":

- **Mesh / armature editing** — you edit *existing* geometry (vertices, bones, weights, UVs). Its own family,
  its own isolation/orbit, its own modes (Edit Mesh, Armature, Weight Paint). **Left alone.**
- **Procedural creation** — you generate from params, orbit the result, tweak sliders, optionally paint / save a
  variant. Packaging is the first member; vending, building, foliage, and everything in §4 are future members.

The shared system is built ONLY within the procedural-creation family. This is deliberate: an earlier attempt to
unify the *isolation* helpers across both families (packaging's isolate vs armature's isolate) crossed abstraction
boundaries — packaging works through its host-adapter (`this.host.*`); armature/mesh are `scene3d`-direct — and
they had already diverged. Keeping the families separate removes that risk entirely: we only share code that is
internally coherent.

### 5.2 The system is THREE parts — one is already built

| Part | What | State |
|---|---|---|
| **Lifecycle + persistence** | create / orbit-frame / tweak / regenerate-in-place / params-only marker / restore / gizmo-sync | ✅ **Built** — `ProceduralObjectManager<TParams,TMeta>` (`src/services/managers/procedural-object-manager.ts`), used by Building + Foliage, 11 characterization tests. Packaging keeps its richer bespoke manager (paint layers aren't regenerable). |
| **The stage** | isolate target · flatten rotation · frame + orbit (`enterGroupOrbit3D`) · studio bg + lighting · drift + ambience | ✅ **Built** (2026-07-28) — `sm.enterCreatorStage3D(nodeId)` / `exitCreatorStage3D()`. A FRESH stage for the creator system, composed from the same public scene primitives packaging uses but on its OWN state, so packaging is untouched (not the risky "extract from the one working stage" — see §5.3). Verify in-browser: `salsaCreator.add('vending')`. NOT YET: surface paint inside the stage (arrives with GARP). |
| **Generator registry** | `typeId → { defaultParams, schema, build, previewScene }` — the 2D `IEphemeraGenerator` shape, for 3D | 📋 Not built. Packaging + vending + building/foliage each register one entry. |

### 5.3 Sequencing — extract the stage from TWO members, never one

Packaging's stage is the *only* working procedural creator today, and it is browser-verified code. Extracting it
into a generic `CreatorStage` and re-pointing packaging at it, verified only by `tsc`, is how the one working
creator gets silently broken. So:

1. Give the **vending machine** a creator mode as consumer #2, referencing packaging's stage.
2. Extract the shared `CreatorStage` from packaging **and** vending together, with in-browser verification at
   each step (the enter/exit/orbit/paint behaviour cannot be checked by the test suite).

Extracting from two real members is an extraction; extracting from one is a guess. This is the same discipline as
§2's "extract the framework from shipped generators — never pre-design it," made concrete: the shipped generator
count for the *stage* must reach two first. (The *lifecycle* part already had two — Building + Foliage — which is
why it was safe to extract now.)

## 6. Phased build

- **Phase A — pilot loop (prove it end-to-end with THREE):** extract **Tree**, **Vehicle**, **Awning** (simple
  params, big visual spread, awning proves the smallest loop fast). Params + schema + `buildX(params, seed)`;
  city builders accept optional pools (absent = today's defaults, byte-identical). Engine: generic
  `sm.creator.enter(kind, params?)` / `update` / `savePreset(name)` / `exit` over a **generator registry**
  (`{schema, defaults, build, previewScene}`); one preview instance in the focus workspace. Frogmarks: ONE
  schema-driven panel component serves all creators.
- **Phase B — preset library + persistence:** named presets per kind; storage = the shell/OPFS library (global,
  cross-project) + embedded copies in `.frogmarks` when a city references them (documents stay self-contained —
  the sparse-override principle). Pool picker UI in the City panel per slot.
- **Phase C — the big ones:** Building Creator (massing/roof/facade recipe consumed per zone), Palette Creator,
  Style-Pack Creator (composes other presets — packs become user data).
- **Phase D — schema → MCP:** expose the registry as MCP tools (schemas already machine-readable); AI edits
  params, engine stays deterministic.

## 6. Cross-cutting rules & risks

- **Determinism is sacred:** pools live in `LayoutParams` → same params + seed = same city, byte for byte.
- **Perf is non-negotiable:** user presets flow into the SAME merged layers / archetype-instanced paths (a tree
  preset = an archetype key; a vehicle preset = one shared geometry). A preset must never mean per-instance meshes.
- **Old saves load:** every params field `?? default`-guarded; preset schema carries a version.
- **Extraction order = value order,** not completeness: only promote a sub-object when someone would actually
  author it. The catalog is a menu, not a to-do list.
- **Don't fork the look:** default pools must reproduce today's city exactly, so extraction never regresses visuals.
