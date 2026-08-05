# Salsa — Systems Inventory

> **Snapshot: 2026-07-29** (from a full codebase sweep). This doc tells you **where to look**, not what's
> guaranteed still true. Status claims decay — **verify against the code** before relying on any status/line-ref
> that hasn't been touched in the last few sessions, and update the entry when you do.

An at-a-glance map of **what already exists**, so we reuse/extend instead of rebuilding. Grouped bottom-up by
layer. Each entry: **role · key file(s) · status · reuse notes**. The **[Integration & reuse map](#integration--reuse-map)**
at the end is the anti-spaghetti section — the shared primitives and cross-mode wiring.

> Companion: [TODO.md](./TODO.md) (remaining work) · specs in [docs/specs/](./specs/) · host contracts in [docs/ui/](./ui/).
> Status: **built** · **partial** (built, gaps noted) · **pure** (logic done, GPU/host half elsewhere).

---

## Architecture at a glance

```
src/world  (PURE generation, no GPU/services deps — only imports MeshGeometry type)
     │  layout → biome → streets/buildings → props → set-pieces → LayoutPreviewLayer[]
     ▼
services/managers/world-manager.ts  (the bridge: LayoutPreviewLayer[] → scene)
     ▼
src/scene-graph  (Mesh3D / MeshGroup3D / ArrayGroup3D / SkinnedMesh3D / ClothMesh3D)
     ▼
src/renderer/3d  (Renderer3D → Pipeline3D, texture atlases, per-instance MeshInstance buffer, WGSL)
```

Two façades sit on top: **`ShapeManager`** (`sm`, host-facing API + mode enter/exit + decal + creator dispatch)
and **`Scene3DManager`** (all 3D runtime). Managers never import ShapeManager — they share one **`ManagerContext`**
dependency bag. Modes are entered via thin `sm.enterXxx3D()` wrappers.

---

## 1. World generation — `src/world` (pure, deterministic)

Everything here is BUILT and emits real geometry unless noted. Output type is **`LayoutPreviewLayer`** (geometry +
optional render descriptors: `pattern`/`ground`/`metal`/`neon`/`water`/`glass`/`leafCard`/`wind`/`foliageShade` +
instancing `instances`/`instanceKey`/`arrayGroup` + `garp:{pool,slot,seed}`).

### Foundation / shared primitives
| System | Role | Key file | Notes |
|---|---|---|---|
| **types** | Shared types + **diorama-scale single source of truth** (`cityMetresPerUnit`, `metalScaleFor`, `LayoutParams`, `WorldGraph`, `LayoutPreviewLayer`, `InstanceXform`) | `world/types.ts` | 9 call sites must agree on scale — all read from here. |
| **util** | Seeded RNG (`makeRng`), `hash2`, `valueNoise2D`, polygon toolkit (clip/triangulate/chamfer/scatter), memoized `graphLookups` | `world/util.ts` | `hash2` + integer-grid hashing underpin all deterministic placement (incl. GARP `pickSkin`). |
| **meshbuild (Accum3D)** | The geometry accumulator — merges low-poly primitives into ONE `MeshGeometry` (12-float interleaved) | `world/meshbuild.ts` | **Used by every generator.** Primitives: `obox`, `prism`, `beam`, `cone`, `blob`, `walls/wallsWin`, `quad4/quad4u/quadUV/quadUV4`, `vertex/triangle` escape hatch. `quadUV4` (per-corner UVs) = GARP shell unwrap. |
| **palette** | Seeded city color grades + shared painted-metal recipes (`METAL_PAINTED/GALVANISED/POLE`) | `world/palette.ts` | Metal recipes shared by water/terraces/furniture/signals so metalwork weathers identically. |
| **garp** | GARP data model + `pickSkin` (**weighted rendezvous hashing** over 64/unit integer grid) | `world/garp.ts` | Pure half; renderer/services build the atlas. Skin choice happens at instantiation over the runtime pool. |

### Layout & terrain
`layout` (roads→blocks→lots→zoning `WorldGraph`, radial/grid) · `preview` (flat top-down map) · `elevation`
(height field drape) · `warp` (domain warp for curved roads) · `terraces` (retaining walls + stairs) · `drape`
(streamed-tile pre-drape, must mirror main path) · `tiled` (tile-LOD helpers) · `styles` (data-only style packs).

### Streets, buildings & the building generator
- **streets** (`world/streets.ts`) — extrudes lots into massed buildings + lamp posts/lights; drives `buildBuilding` per lot when detailed.
- **building** (`world/building.ts`) — Procedural Building Generator (`buildBuilding`: params→`{layers,meta}`, 11 archetypes, phases 1–7).
- **building-parts** / **building-geom** — geometry part-builders (`emitMassing/Storefront/Balconies/WindowTrim/Roof/Signage/Traditional/Greenery`) + pure geom helpers.

### Foliage (recipes over primitives)
- **foliage** (`world/foliage.ts`) — `buildFoliage`; chunky v1 built, **`render:'card'` alpha leaf path partial** (falls back to chunky).
- Primitives: `blade`, `whorl`, `stalk`, `branch`, `runner`, `curve-frame` (shared bezier sweep), `conifer`, `planting` (vessel arrangements).
- **city-foliage** — instanced city trees (canonical pool + `InstanceXform`) · **biome** — scatters trees/gardens/rocks into the graph.

### Ground
`ground-surfaces` (surface library → WGSL mode 0–8: ashlar/radial/border/grass/asphalt/concrete/dirt/cobble/plank) ·
`ground-scatter` (blue-noise props → ArrayGroup) · `ground-masks` (CPU mirror of the weathering-mask WGSL — one source of truth). **All built.**

### Props & street furniture
`furniture` (poles+wires, parked cars, manholes, benches, bus stops, post boxes, cones, guardrails) · **`vending`**
(the GARP template prop — sub-layers + `vendingShellGeometry`/`vendingGarpPool`) · `bike-rack` · `bollard` ·
`lamp-post` (pole + emissive lamp + **windSway banners**) — the minimal "≈5 members + schema" prop templates.

### Set-pieces & streetscape
`landmarks` (9 block templates) · `water` (canals/ponds/bridges) · `shotengai` (market street) · `awnings` ·
`signals` (traffic lights) · `signage` + `signtext` (**shop blades still colored rects — partial**) · `roadpaint` ·
`railway`/skyway · `voidgrid` + `apron` (world borders A/B) · `sky` · `pedestrians` (static crowd) · `traffic` (movers).

---

## 2. Scene graph — `src/scene-graph/shapes`

| Node | Role | Key fields (reuse-relevant) |
|---|---|---|
| **Mesh3D** | 3D leaf (geometry + `Material3D`) | `submeshes` (multi-material), `textureLibraryId`/`normalMapLibraryId`, **`garpLayer`** (session-local GARP layer, never serialized), `castsInstancedShadow`, `billboard`, `pickable`/`excludeFromDocument`/`cheapBounds` |
| **MeshGroup3D** | Transform container | `thinWrapper` (moved as a unit = the placed object), **`documentSkipChildren` + `worldParams`** = the marker-persistence pattern (regenerate on load, no baked geometry saved) |
| **ArrayGroup3D** | Parametric repeat array (extends MeshGroup3D) | `arrayParams` (linear/grid/radial/**explicit**), **`instanceOverrides`** per-copy `rotation/scale/visible/`**`textureIndex`** (GARP per-instance skins). `explicit` = the procedural-instancing vehicle. |
| **SkinnedMesh3D** | LBS skinning (extends Mesh3D) | `skeletonId`, `jointIndices`/`jointWeights`, edit-mesh weight remap |
| **ClothMesh3D** | Cloth sim (extends Mesh3D) | `clothConfig`/`physicsConfig`/`simState`/`liveConfig` (all persist) |
| others | `Skeleton3D`, `GpObject3D`, `ParticleEmitter3D`, `EditMesh` + the 2D shape family + `shape-factory`/`scene-graph` core | |

---

## 3. Renderer / GPU — `src/renderer/3d`

| System | Role | Key file | Notes |
|---|---|---|---|
| **Renderer3D** | The whole 3D frame — instance buffer, geometry pool, atlases, uniforms, shadow, particles, sub-passes | `renderer-3d.ts` | `drawMeshes()` entry. Pooled draw-lists, append/compaction geometry pool, dynamic render-scale while panning. |
| **Pipeline3D** | All pipelines + bind-group layouts + samplers | `pipeline-3d.ts` | Only file touching `createRenderPipeline`. See bind groups below. |
| **Texture atlases** | Batch textured meshes into few draws | `renderer-3d.ts` | **diffuse** + **normal** `texture_2d_array` (`_buildTextureAtlas`, layer 0 = white, `_atlasLayerMap`); **dedicated GARP** `texture_2d_array` (`uploadGarpAtlas`, layer 0 = blank). |
| **Material + flags** | Per-mesh visuals → packed floats + a bitfield | `material-3d.ts` | `encodeMaterialFlags` — **the shared flag registry** (table below). |
| **Instancing** | One draw for source + array copies | `renderer-3d.ts` (repack ~3060) | `copyWithin(+32..+56)` copies material incl. pattern slots; `InstanceOverride.textureIndex` = per-copy GARP skin. |
| **Camera3D** | Perspective/ortho, adaptive near/far | `camera-3d.ts` | `autoNear`/`autoFar` track orbit distance (depth precision). |
| **Shadow/depth** | Depth-only pass → 2048 `depth32float` map, PCF | `pipeline-3d.ts`, `shaders/shadow-shaders.ts` | Throttled; wind runs in shadow VS too. |
| **Passes** | Outline (depth+normal→Sobel), MeshHighlight (stencil), LoFi (PS1 pixelation), PostProcess (bloom+grade+vignette), Bloom, GpRenderer3D, weight-paint overlay, ghost/cloth previews, ViewGizmo | `outline-pass.ts`, `mesh-highlight-pass.ts`, `lofi-pass.ts`, `post-process-pass.ts`, `bloom-pass.ts`, … | Each returns null / no-ops when disabled (zero overhead). |
| **Sim/rig** | skeleton-animator, spring-bone-solver, ik-solver, constraint-solver, cloth-simulator, mesh-bvh, gltf/obj import-export | various | |

**Bind groups** (Pipeline3D): **G0** = MeshInstance storage(0) + SceneUniforms(1) + IBL(2). **G1 (textures)** = diffuse
array(0) + sampler(1) + normal array(2) + sampler(3) + **GARP array(4)** (sampled unconditionally, `select()`ed;
never unbound). **G2** = shadow depth(0) + comparison sampler(1) — but shadow is **G1 in untextured** layouts (no gaps
allowed). Skin/weight-paint groups appended per variant.

**Material flag bits** (u32 in `emissiveColor.a`, float 43) — *the shared registry; edit here + every WGSL struct*:

| Bit | Flag | | Bit | Flag |
|---|---|---|---|---|
| 0 | hasTexture | | 15 | texOverBase (decal-over-base) |
| 1 | hasNormalMap | | 16 | boardShade |
| 2–4 | renderStyle (0 default/1 cel/2 sketch/3 ink/4 gouraud/5 cel-hd) | | 17 | radialFade |
| 5 | alphaCutout | | 18 | groundShade |
| 6 | hairSheen | | 19 | windSway |
| 7 | rimEnabled | | 20 | foliageShade |
| 8 | sparkleEnabled | | 21 | waterShade |
| 9–11 | patternMode (none/stripes/dots/diamonds/checker/grid/windows/waves) | | 22 | neonShade |
| 12 | sparkleStar | | 23 | metalShade |
| 13 | leafCard | | 24 | **garpTex** (sample GARP atlas; last exact-f32 bit 2²⁴) |
| 14 | glassEnhance (**free composable flag**) | | | |

★ **Pattern-family rule:** `patternMode`/`boardShade`/`groundShade`/`windSway`+`foliageShade`/`waterShade`/`neonShade`/
`metalShade` all reuse the same 4 instance floats (patternColor 48–51 + patternParams 52–55) → **mutually exclusive per
mesh**. `glassEnhance` (14) and `garpTex` (24) are free/composable.

**MeshInstance buffer** — 224 B / 56 floats: model(0–15), normalMatrix(16–31), diffuse+opacity(32–35),
specular+shininess(36–39), emissive.rgb+**flags@43**, **textureIndex@44**, normalMapIndex@45, roughness@46, metalness@47,
patternColor(48–51), patternParams(52–55). *Stride must match all 9 WGSL struct declarations.*

**WGSL shading families** (`shaders/mesh3d-shaders.ts`): PBR/IBL, render styles, patterns + `windowsPattern`/interior-mapping,
ground (9 tilers + weathering), metal, water, neon, foliage wind/transmission, PS1 (grid-snap/affine/color-depth/LoFi).
★ **No backticks inside WGSL** (they end the JS template literal).

### Raster renderer — `src/renderer/raster` (2D paint, compute-based)
`RasterTextureManager` (paint GPUTexture + brush compute + `exportToBlob`/`readToCanvas` + undo snapshots) ·
`BrushStampPipeline` + `BrushEngine` + `RasterPaintEngine` (the single paint entry) · `FloodFillEngine` (GPU/CPU bucket) ·
`DitherEngine` · `RasterCompositor` (layer flatten, 12 blend modes) · selection/transform engines · `text-effect-engine`.

---

## 4. Services / managers / modes — `src/services`

### Façades & infrastructure
- **ShapeManager** (`shape-manager.ts`, `sm`) — host-facing API; owns delegates, decal registry (`_decals`), GARP registry (`_garp`), creator dispatch (`_creators`), `window.salsa*` dev harnesses.
- **Scene3DManager** (`managers/scene3d-manager.ts`) — the entire 3D runtime: camera/orbit/gizmo, `MeshPicker`, `TransformController3D`, `GizmoRenderer`, `AnimationPlayer3D`, `UndoManager3D`, `Renderer3D`, city containers, lighting, IK/armature. **Base every mode reuses** (`addFlatColorMeshGroup`, `addExplicitArrayInstances`, orbit/frame).
- **ManagerContext** (`managers/manager-context.ts`) — shared dependency bag (avoids circular deps). Consumed by every manager.

### The generalized Creator system
- **ProceduralObjectManager** (`managers/procedural-object-manager.ts`) — abstract base; shared lifecycle (create/setParams/transform/remove/restore + gizmo sync + marker persistence). Subclass = **5 members**.
- **creator-registry** (`managers/creator-registry.ts`) — machine-readable param **schemas** (reuses the ephemera `EphemeraParamSchema`) → one schema-driven panel serves all creators. Registers `vending`/`foliage`/`bike-rack`/`bollard`/`lamp-post`.
- **Generic dispatch** (ShapeManager) — `createCreator3D(typeId)` / `setCreatorParams3D` / **CreatorStage** (`enterCreatorStage3D`/`exit`: isolate → studio bg → frame+orbit). New prop ≈ base subclass + schema entry, zero per-creator glue.

### Procedural object managers
`WorldManager` (city bridge; drives City mode + streaming) · `BuildingManager` (+ Building Editor mode + foliage-attach
tool) · `BlockManager` (neighborhood blocks, cross-building instancing) · `FoliageManager` · `VendingManager` ·
`BikeRackManager`/`BollardManager` (16/14-line templates) · **`GarpManager`** (pure GARP registry: pools/textures/
`skinLayer`/`serialize`/`restore`; GPU half is the renderer's dedicated atlas).

### Decal system
`decal-geometry` (pure quad + orientation maths; defines **`DecalSource`** = ephemera|image) · decal placement + Decal
Place mode on ShapeManager (`placeDecal3D`, `enterDecalPlaceMode3D`, select-then-place tool). **`DecalSource` is reused as
the GARP texture source type.**

### Mesh / UV / texture modes
- **MeshEditManager** (`mesh-edit-manager.ts`) — Edit Mesh mode (extrude/inset/weld/loop-cut/bevel/mirror/subdiv, vertex colors); **knife + auto-UV partial**. Pointer input in `mesh-edit-pointer-controller`.
- **UVEditManager** + **UVCanvasRenderer** — UV editing ops + the UV pane (islands/seams/stretch). Session rebuilt from EditMesh (not serialized).
- **UVPaintController** (`uv-paint-controller.ts`) — **UV Paint mode**: brush a mesh texture on its unwrap OR the 3D surface; owns a dedicated `RasterPaintEngine`. ★ **One shared controller**, reused by: standalone UV Paint, **Creator/packaging surface paint**, garment/hair paint, **Eye Draw mode**. `_paintSessionKind` keeps sessions from cross-contaminating.
- **MeshPaintManager** — legacy Phase-1 painter, **superseded** by UVPaintController (consolidation candidate).
- **LiveTextureMode** — zero-copy raster-layer GPUTexture → mesh diffuse (paint a layer, mesh updates live).

### Animation, shell, raster services, generators
- **AnimationManager** (2D cel timeline) · **ShellUIManager** (home-screen state; renderer lifecycle partial).
- **RasterManager** façade over: `RasterLayerManager` (layer stack + timeline), `RasterSelection/Drawing/Move/Text` services, `FloodFillEngine`. **DrawingToolManager** (vector tools) · **TextManager** (SDF/LiveText) · **PersistenceManager**.
- **Character generators**: `body-generator` (**v1 partial**), `hair-generator`, `clothing-generator`, `eye-generator`, `attachment-generator`, `vert-grid`, `default-animations`, `kitbash-library`.
- **Adjacent**: `ephemera/` (EphemeraService + ~28 generators — source of DecalSource, GARP textures, creator schemas), `streaming/` (StreamManager/CityStreamSource/TileWorkerPool), `persistence/`, `drawing/`, top-level `interaction-service`/`selection-service`/`texture-library`/`cache-service`.

### Modes (enter/exit)
City · Object/Group orbit · **Creator Stage** · Building Editor · Decal Place · **Edit Mesh** · UV editor · **UV Paint** ·
Mesh Paint (legacy) · Eye Draw · Armature · Bone Placement · Weight Paint · Grease-Pencil Draw · GP Face Select ·
Surface Paint input · Shell · raster tool modes. (Full method table: services inventory / `shape-manager.ts`.)

---

## 5. Persistence — `src/services/persistence`

- **DocumentPersistence** — OPFS auto-save (30s + debounced), gzip JSON, **PNG encode on a worker pool** (off main thread). `DocumentSavePayload` fields: `sceneGraphJSON`, `scene3dJSON`, `models3d`, `meshTextures` (UV-paint PNGs), **`garpJSON`** (pools + DecalSource skins), `ephemeraJSON`, `bakedParts`, `textureLibrary`, `brushPresets`, `layers`/`cels`.
- **project-package** — portable `.frogmarks` ZIP (fflate); also carries skeletons/characters/rig params.
- ★ **Marker-regeneration pattern** — procedural content (city, buildings, blocks, foliage, vending, bike-racks, bollards, lamp-posts, decals, packaging) persists ONLY as `worldParams` markers (via `MeshGroup3D.documentSkipChildren`), regenerated on load by `ShapeManager.restoreProceduralFromSave3D()`. Nothing serialized ever holds a GPU atlas layer index.
- ★ **Stable-key texture persistence** — UV-paint on a REGENERATED mesh (child ids change on regen) persists via a stable key, re-applied after regeneration: garments `__cloth__:bodyId:slot`, faces `__face__:…`, procedural props `__proc__:containerId:childName`. GARP skins persist separately in `garpJSON` (by pool+skin name). A volatile mesh id would lose the paint on reload.

---

## Integration & reuse map

The point of this doc: **before building, check if a shared primitive already does it.** The load-bearing shared
subsystems and where they're reused:

| Shared primitive | Reused by | Extend here when… |
|---|---|---|
| **Accum3D** (`world/meshbuild.ts`) | every generator | you need geometry — never hand-roll vertex arrays; add a primitive here. |
| **Material flag registry** (`material-3d.ts`) | all shading | you add a shading mode — claim a bit, respect the pattern-family mutual-exclusion, update all 9 WGSL structs. |
| **Texture atlases** (diffuse/normal/GARP) | all textured meshes | you add textured content — atlas-resident batches into one draw; standalone falls back to layer 0. |
| **DecalSource** (`decal-geometry.ts`) | decals **and** GARP skins | any "pick an image (ephemera/upload)" feature — reuse this + `_resolveDecalBitmap`. |
| **EphemeraService** (~28 generators) | decals, GARP textures, creator param schemas | you need procedural 2D art or a param panel schema. |
| **ProceduralObjectManager + creator-registry + CreatorStage** | building/foliage/vending/bike-rack/bollard | you add a new standalone editable object — 5 members + a schema entry, no glue. |
| **UVPaintController** (ONE instance) | standalone UV Paint, creator/packaging surface paint, garment/hair, Eye Draw | any "paint on a mesh/unwrap" need — reuse; disambiguate with a session kind. |
| **RasterPaintEngine / RasterTextureManager** | 2D illustration, UV Paint, LiveTexture | any GPU brush / paintable texture / readback (`exportToBlob`). |
| **worldParams marker persistence** (`MeshGroup3D`) | all procedural content | anything regenerable — persist params, not baked geometry; add a `restoreFromSave`. |
| **InstanceXform / ArrayGroup3D + `addExplicitArrayInstances`** | city trees, ground scatter, blocks, GARP body | any "N copies of one canonical geometry" — incl. per-instance `textureIndex` skins. |
| **ManagerContext** | every manager | a new manager — take the context, never import ShapeManager. |
| **UndoManager3D** | Edit Mesh, UV Edit, transforms | any reversible 3D op — push a command. |

### Live integration threads (candidate wiring)
- **GARP ↔ UV Paint** — `sm.paintVendingBody3D()` already spawns the body shell + enters UV Paint; the natural next step the user flagged is **surfacing the GARP library inside UV Paint mode** (pick/apply a pool skin while painting). Both sides exist; it's a wiring task, not new infra.
- **UV Paint ↔ Creator Stage** — already wired (creator/packaging surface paint reuse the one controller); a new creator that wants painting reuses the same path.
- **Decal ↔ GARP** — shared `DecalSource`; a decal placed on a prop could become a GARP skin source and vice-versa.
- **Host (Frogmarks) contracts** — GARP (`ui/garp.md`, incl. `garpSlotRegions3D` overlays), Decals (`ui/decals.md`). Engine owns geometry/atlas/persistence; host owns panels.

### UI information architecture: Edit Modes vs Libraries
Every user-facing capability is one of two kinds — place it accordingly:
- **Edit MODE** (Mesh Edit, Armature Edit, UV Paint/Edit, Weight Paint) — edits **one aspect of the selected
  object**; mutually exclusive; a **contextual** toolbar button gated on a compatible selection. "A verb on the object."
- **LIBRARY / pool** (GARP "Skins", texture library, brush presets, ephemera catalog, kitbash) — **reusable assets
  across many objects**; an **always-available panel**, not selection-gated. "A collection you draw from / add to."
- They **bridge, they don't nest**: a library can *launch* a mode to author an item (Skins → `paintVendingBody3D`
  enters UV Paint), and a mode can *save into* a library ("Save as variant" → `addGarpSkin3D`). A **subpanel** holds a
  tool's *options/sub-tools*, never another top-level mode. (Host contract: [ui/garp.md](./ui/garp.md).)

### Golden rules
1. **Reuse before rebuild** — check the table above; most "new" needs are a compose of existing primitives.
2. **Scale from `world/types.ts`** — never hardcode metres/units; use `cityMetresPerUnit`/`metalScaleFor`.
3. **Procedural content persists as markers**, not baked geometry (autosave stays fast).
4. **Never serialize a GPU atlas layer index** — session-local; resolve from stable ids/names each session.
5. **Determinism** — placement uses `hash2` over integer grid cells (platform-stable); same for GARP `pickSkin`.
6. **No backticks in WGSL**; keep the MeshInstance stride in sync across all WGSL structs — now **guarded by a
   test** (`src/renderer/3d/mesh-instance-layout.test.ts` scans the TS constant + every WGSL `struct MeshInstance`
   and fails on any size drift). Prefer converting silent-failure rules like this into tests over documenting them.
</content>
