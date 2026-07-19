# Procedural Instancing + Neighborhood Blocks — Spec

> **Status:** NOT built (planning, 2026-07-15). Foundational perf + authoring architecture for the Building
> generator (extends to Foliage / any repeated procedural detail). Prereq for dense neighborhoods + city scale.
> Related: [building-generator.md](building-generator.md), [world-generation.md](world-generation.md),
> [foliage-generator.md](foliage-generator.md), [street-level-mode.md](street-level-mode.md) (LOD).

## 1. Problem
A building's geometry is **dominated by repeated detail**, baked as unique triangles per window (merged into one
mesh per material layer):

| Building | Total tris | juliet | window-trim | rest |
|---|--:|--:|--:|--:|
| brick-townhouse 4fl | 11,834 | 9,408 | 2,016 | 410 |
| office-block 9fl | 44,474 | 35,840 | 7,680 | 954 |

**Juliet + trim are 80–96% of a building**, and every railing is a near-identical copy. A hand-assembled
neighborhood of 30 buildings ≈ 1.3M tris of which ~1.2M is redundant. This blocks dense neighborhoods and city
scale. Draw calls are already fine (one per material layer, merged) — the cost is **redundant vertex data**.

## 2. Core idea — canonical, bucketed, *keyed* geometry
Stop baking N copies. Emit **one canonical geometry per unique shape + a list of per-instance transforms**.
- **Canonical = LOCAL space.** Build the railing at the origin facing +Z, NOT world-placed per window via `edgePt`.
  `forEachWindow` already yields each window's centre / out-normal / width / sill → that becomes the **transform**
  (translate + yaw), not geometry input.
- **Bucket by width.** A railing's only per-window variable is the window opening width. Windows within a face
  share a width; parallel faces share a width → a rectangular building has **1–2 unique geometries**, not 24. Snap
  width to a **quantization step (0.05 m)** so different *buildings* with the same bucket share too.
- **Key by (feature, bucket, style).** e.g. `juliet:w1.40:s0.6`. Same key ⇒ identical geometry ⇒ instanceable
  together, anywhere in the scene.

This one change (local + bucketed + keyed geometry + transforms) is the **foundation every tier below builds on.**

## 3. Two instancing mechanisms (both already in the engine)
| | Cross-building batching | Scene nodes | Needs a central owner |
|---|---|---|---|
| **A. Shared geometry key** (`instanceKey`→`setGeometryKeyOverride`, the traffic-mover path) | **automatic, scene-wide** (global key) | **1 per instance** | no |
| **B. ArrayGroup3D** — one source + N transforms in a GPU instance buffer | only if **one shared** group per key | **1 per key (total)** | **yes** |

- **A** is dead simple and cross-instances automatically, but every instance is a scene node → tens of thousands of
  nodes at city scale = CPU cull/traversal cost (GPU draw is batched; the bookkeeping isn't free).
- **B** is the node-efficient end state (instances live in a buffer, not the scene graph), but a *single* shared
  group per key must be **owned + updated** as buildings are added / moved / deleted. Per-building ArrayGroups do
  NOT cross-batch (1 draw per building per bucket).

Both consume the **same** generator output (§2). They differ only in *where the transform list lives*.

## 4. Instancing tiers (the plan is to climb these)
- **Tier 0 — today:** merged per-building geometry. Keep as the fallback / lowest-complexity path.
- **Tier 1 — within-building shared-key:** generator emits canonical/keyed geometry + transforms; the building
  manager creates shared-key meshes. Cross-instances scene-wide *for free*. Node count fine for a handful of
  buildings. **First milestone** — verifiable on a manual neighborhood.
- **Tier 2 — Blocks (§5):** a Block container owns a **central ArrayGroup per key** for its member buildings →
  node-efficient instancing outside city mode + an authoring unit.
- **Tier 3 — City (detailed buildings + city-wide instancing):** WorldManager assembles **scene-wide** shared
  instance buffers across all lots. **Seam:** `buildStreetscape` (streets.ts ~L59) loops `graph.lots` (each has
  `poly`=footprint, `zone`, `block`, frontage) → today a basic extrude; detailed path calls `buildBuilding(params,
  lot.poly, frontage)` (contract ALREADY accepts footprint+frontage). **FALLBACK = first-class:** a city param
  `detailedBuildings: boolean` — false = current basic extrude UNCHANGED (safe fallback), true = detailed. Both
  coexist. **Zone→category** map (civic→office/tower, commercial→shophouse/mall, residential→house/apartment).
  Collect all lots' instanced detail into CITY-wide ArrayGroups (reuse `addExplicitArrayInstances`); **cross-lot
  dedup needs `setGeometryKeyOverride(instanceKey)` on the source meshes** (block sources use custom geom = unique
  pool key today → NOT deduped across lots — fix for city scale). **LOD is the gate:** detailed-everywhere is too
  heavy even instanced → `detailedBuildings` should become a DISTANCE TIER (near=detailed, far=basic extrude), the
  street-level/LOD work. Until LOD, use detailed on small authored areas / drop authored **Blocks** into a basic
  city. **SEQUENCING: (1) toggle+zone map (small, fallback-safe, first) → (2) city-wide collector + key dedup → (3)
  LOD near/far.**

## 5. Neighborhood **Blocks** (new standalone container)
A **Block** groups multiple placed buildings + their layout into one authored unit — the standalone extraction of
the city's `Block` level.
- **What it is:** a thin-wrapper container (like a building) holding N **building instances** (each = building
  params + a local transform on the block) + optional street/lot layout. Selected / moved / saved as one unit.
- **Why it earns its place (not just perf):**
  1. **Efficient instancing owner** — the Block builds Tier-2 central ArrayGroups across its buildings (low node
     count) without needing full city mode.
  2. **Authoring unit** — lay out a row of townhouses / a courtyard block; duplicate, mirror, save to a pool.
  3. **Bridge to city** — a Block *is* a mini city-region; city integration consumes Blocks as pre-authored lots.
- **Authoring flow:** New Block → add buildings into it (or drag existing) → arrange on a lot grid → the Block
  re-instances. Mirrors Building Editor mode + the foliage grid tool.
- **Persistence:** params-only — a Block marker = `{ kind:'block', buildings:[{params, transform, scale}], layout }`.
  Regenerates (and re-instances) on load via the same `restoreProceduralFromSave3D()` path.

## 6. Layer / API contract changes
- **`LayoutPreviewLayer`** gains an instanced variant: `{ geometry (LOCAL canonical), instanceKey, instances:
  InstanceXform[] }` where `InstanceXform = { x, y, z, ry, s? }` (translate + yaw + optional uniform scale). When
  `instances` is present the layer geometry is the *canonical* shape, not world-baked.
- **`addFlatColorMeshGroup`** (or a new `addInstancedMeshGroup`) consumes `instances`:
  - Tier 1: N shared-key meshes (`setGeometryKeyOverride('wld:'+key)`), each transformed.
  - Tier 2/3: one `ArrayGroup3D` (source = canonical geom, instanceOverrides = transforms).
- **Generator emitters** (`emitJulietBalconies`, `emitWindowTrim`, later mullions/balusters/roof-clutter): build
  canonical LOCAL geometry per width bucket + collect `InstanceXform[]` from `forEachWindow`. Non-instanced Tier-0
  path stays as a fallback flag.

## 7. What to instance, in priority order
1. **Juliet balconies** — 80% of the cost, highly repetitive. Tier-1 first (the measurable win).
2. **Window trim** — same `forEachWindow` grid, same bucketing. Do alongside juliet.
3. **Mullions / shopfront bars / balusters / roof clutter** — repeated boxes; fold in once the contract is proven.
4. **Whole buildings** (Block/City) — identical building params ⇒ instance the *entire* building geometry (the
   1000× Building-A case). Same key mechanism, one level up.

## 8. Width bucketing details
- `bucket = round(openingWidth / STEP) * STEP`, `STEP = 0.05 m` (tunable). Log if a building spans > 4 buckets
  (unexpected footprint).
- Canonical geometry built for the bucket's exact width (centre of the bucket), so instances of that key are
  byte-identical. Slight width error (< STEP/2) is imperceptible and is the price of cross-instancing.
- Key includes anything that changes geometry: `julietScroll` (bucketed), style variant. Colour/renderStyle are
  MATERIAL, not geometry → do NOT enter the key (same geometry, different material per building is fine — material
  is per-mesh/instance, geometry is shared).

## 9. Interactions / risks
- **LOD composes, doesn't compete.** Instancing makes each building cheap to *hold*; LOD decides how many to *draw*
  and swaps in low-detail canonical geometry by distance (a per-key LOD variant). The 160/260 caps stay as far-tier
  budgets. Biggest wins stack: LOD (skip) → instancing (cheap transform) → merged (fallback).
- **Node count (Tier 1)** — acceptable to ~dozens of buildings; Blocks/City (Tier 2/3) are the fix beyond that.
- **Picking/selection** — instanced detail is decoration (`pickable=false`); the building/Block container is the
  selection unit. No per-balcony picking (unchanged from today).
- **Geometry-key correctness** — canonical geometry MUST be deterministic per key (no `Math.random`, no world
  offsets baked in) or sharing breaks silently. Verify byte-identical output per key in the smoke test.
- **Persistence** — instanced geometry is regenerated, never serialized (`excludeFromDocument`), so save size is
  unaffected (params-only marker principle holds for buildings AND blocks).
- **Material per instance — CONFIRMED FREE (2026-07-15).** The renderer's instance storage buffer
  (`_instanceDataBuf`, `MESH_INSTANCE_STRIDE`) carries the FULL material **per instance**: diffuse+opacity (f32-35),
  specular (36-39), emissive + material FLAGS (40-43, and `renderStyle` is flag bits 2-4 → not a pipeline switch),
  tex/normal idx + roughness/metalness (44-47), **patternColor (48-51)** + patternParams (52-55). The geometry key
  shares only vertex/index data; every instance indexes its own material record via the instance index. So
  per-instance **tint, window-frame colour, emissive, pattern colour, even renderStyle** are ALL free — instancing
  does NOT force uniform material. Only requirement: same **pipeline** (all flat-colour building layers are
  untextured + doubleSided = one uber-shader; transparent/glass is a separate pass, so keep opaque detail opaque).

## 10. Phased implementation
- **P0 — Foundation ✅ BUILT 2026-07-15.** `buildJulietCanonical` / `buildWindowTrimCanonical` build at the origin
  (local +X=width, +Y=up-from-sill, +Z=out); emitters bucket windows by width (`IBUCKET=0.05`), build ONE canonical
  geom per `(feature, wBucket, hBucket, scroll)` key, collect per-window transforms `{x,y,z, ry=atan2(out.x,out.z)}`
  into `ctx.instGroups`. `LayoutPreviewLayer.instances` + `InstanceXform` added. `assembleLayers` groups instGroups
  by name → **`EMIT_INSTANCED=false`** bakes all instances into ONE merged layer (`xformGeo`+`mergeGeos`) = Tier-0
  fallback (default, behaviour-identical). Colour/pattern still assigned in assembly (emitters stay geometry-only).
  Verified: vertex-count parity EXACT (juliet 28224, trim 6048 = old), 1 merged layer each, 0 non-finite/88 cases;
  instanced view (flag=true) = 224 canonical × 42 instances vs 9408 baked (~21× store). Flip `EMIT_INSTANCED` for P1.
- **P1 — Tier 1 (shared-key) ✅ BUILT 2026-07-15.** `EMIT_INSTANCED=true`; `addFlatColorMeshGroup` now expands a
  layer's `instances` into one mesh PER instance (`makeMesh(L, inst)` closure) — position via ctor, yaw via
  `setRotation3D(0,ry,0)`, geometry shared via `setGeometryKeyOverride('wld:'+instanceKey)`, per-instance `tint`
  overrides colour. Same-key meshes (incl. across buildings) share ONE pool alloc + batch. Frustum culling is
  transform-aware (`getMeshWorldAABB3D`), so off-centre instances cull correctly (the mover path). Verified: 0
  non-finite, 4940 instances/88 cases all-finite + keyed; office-9fl juliet stores 1344 verts vs 107520 baked (80×).
  ⚠️ **KNOWN LIMIT:** `cacheGroupBounds` (selection box) uses RAW geometry coords (identity assumption) → instanced
  meshes contribute an origin box; walls still define the building's box (fine, misses ~0.3m balcony projection). MUST
  make it transform-aware BEFORE whole-building instancing (P2/P3) or those bounds collapse to origin. RENDER-verify.
- **P2 — Blocks (IN PROGRESS 2026-07-15).**
  - ✅ **Enabling primitive: `ExplicitArrayParams` (`mode:'explicit'`, `offsets[]`)** in array-group-3d.ts —
    arbitrary per-instance positions (source at origin, source-relative offsets like radial) + per-instance yaw via
    `instanceOverrides[i].rotationEulerDeg=[0,yaw°,0]`. Rides the existing renderer array path (verified: standard
    mode = srcMat R+S + translation, then post-multiply override 3×3 → `T(pos)·R_y(yaw)` on the origin geometry =
    exactly a placed balcony). Unit-tested (count + offsets). Fixed 3 union-narrowing sites (renderer rnd guard,
    `_arrayDirectionKey`, array-gizmo `data` init null + radial branch guard — explicit arrays get no edit gizmo).
  - ⏳ **NEXT — the collector + `BlockManager`:** container (`worldParams.kind:'block'`) holding `buildings[]`
    ({params, transform, scale}); `_rebuild` → for each building `buildBuilding()`, transform its instGroup
    transforms into BLOCK-local, group ALL instances across buildings by key, emit ONE hidden source mesh (canonical
    geom @origin) + ONE explicit `ArrayGroup3D` per key. Non-instanced geometry (walls/roof) stays per-building.
    Params-only marker + restore via `restoreProceduralFromSave3D`. Host API mirrors BuildingManager.
  - ✅ **ALL integration unknowns RESOLVED (2026-07-15) — collector is de-risked, ready to build:**
    1. **Hidden source → SOURCE-IS-INSTANCE-0.** `visible=false` won't work (the source drops out of the render
       `meshes` list, so the ArrayGroup's `meshes.find(sourceId)` fails and nothing draws). Instead the source mesh
       IS the first balcony (canonical geom at `window[0]` pos + `Ry(yaw0)`, key colour); the ArrayGroup adds the
       OTHER N-1 (offsets = `window[i]` absolute, `computeArrayOffsets` subtracts sourcePos=window0 → source-relative;
       per-instance override yaw = `window[i].yaw − yaw0` since override post-multiplies: `Ry(yaw0)·Ry(δ)=Ry(yaw_i)`).
       No hidden source, no wasted draw, exact placement. Node cost per key = 1 source mesh + 1 ArrayGroup = 2 nodes.
    2. **Nested ArrayGroups need DEEP traversal.** `_ensureArrayGroupSync` (scene3d-manager ~L7250) only scans
       `sceneGraph.root.children` for ArrayGroups → a Block's nested ArrayGroups wouldn't render. Change it to a deep
       walk (`forEachDeep` / recurse). The SOURCE mesh is fine nested (it's found via the full render `meshes` list +
       `getMesh`). One small renderer-manager change.
    3. **ArrayGroup instances share the SOURCE material** (renderer copies src floats 32-55) → per-instance tint is
       LOST at Tier-2 → instance KEY includes colour: `(geometry, railH, scroll, julietColor)`. Bounded by distinct
       geom×colour combos; fine (balconies are uniform-per-building today).
  - ✅ **BlockManager BUILT 2026-07-15** (block-manager.ts): all of the above. New scene3d methods
    `addExplicitArrayInstances` (source=instance-0 + explicit ArrayGroup + registerRestoredArrayGroups) +
    `createChildGroup`. ShapeManager `createBlock3D`/`addBuildingToBlock3D`/`setBlock*`/`getBlockStats3D`/…;
    `restoreProceduralFromSave3D` now returns `+blocks`. Console `salsaBlock.*`. **Collector verified headlessly:
    24 varied buildings, 2332 instances → 8 distinct geometries → 256 block nodes vs 2572 Tier-1 = 10× node cut**
    (balconies 2332→16 nodes; residual 240 = per-building walls). ⏳ NEEDS RENDER-VERIFY (live ArrayGroup draw).
    NEXT polish: `cacheGroupBounds` transform-aware (for whole-building instancing); merge same-colour walls; Block
    editor UI + host doc.
- **P3 — LOD variants:** per-key low-detail canonical geometry; distance swap (ties into street-level/LOD work).
- **P4 — City integration:** WorldManager consumes Blocks + builds scene-wide shared instance buffers per key.
- **P5 — Generalize:** foliage cards, other repeated generator detail through the same contract.

## 11. Open questions
- Tier-1 shared-key vs jump straight to per-building ArrayGroup? (Lean: shared-key first — simplest, cross-batches,
  lets us measure before the ArrayGroup lifecycle work.)
- ~~Per-instance material?~~ **RESOLVED (§9): fully per-instance + free.** Consequence: the geometry key encodes
  ONLY geometry-affecting inputs (feature + width bucket + `julietScroll` bucket). Colour / tint / renderStyle do
  NOT enter the key → aggressive geometry sharing (a red and a blue building share balcony geometry; each window can
  carry its own frame tint) at zero cost. This makes instancing strictly more attractive.
- Block layout model — freeform transforms vs a lot/street grid? (Start freeform; add a grid later.)
- Bucket STEP value + whether to expose it (default 0.05 m, internal).
- ~~Fixed-size windows (`windowWidth` param) for better sharing?~~ **MEASURED + REJECTED for perf (2026-07-15):** at
  STEP 0.05 a neighborhood of **180 varied buildings** already shares just **4** juliet geometries (window widths
  cluster via `round(wall/pitch)`; railH caps at 1.10 → height dimension collapses to 1 bucket). Fixed windows would
  gain ~4→2 geometries = negligible. Geometry sharing is ALREADY near-optimal; the remaining scale cost is NODE COUNT
  (180 buildings = 10,422 instance nodes) which is a **Tier-2/Blocks** problem, unrelated to window sizing. So a
  `windowWidth` slider is a FEATURE (user control / realism), not a perf lever — `bayWidth` already gives rough size
  control. Do NOT do the fixed-window shader rework for performance.
