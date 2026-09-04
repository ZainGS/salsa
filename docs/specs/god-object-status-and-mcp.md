# God-Object Decomposition — Status + the Path to AI Scene-Authoring

**Created 2026-08-15.** A status report on how far the two god-objects (`shape-manager.ts`, `scene3d-manager.ts`) have been decomposed, what remains, and how finishing that work sets up an **AI scene-authoring API** (a local model driving the renderer's procedural systems from a prompt). Companion to `docs/specs/god-objects-and-perf.md` (the original execution plan) and `docs/specs/character-manager-extraction.md`.

> How to read this: §1 = where we are (the honest "how close"). §2/§3 = per-file remaining work with line-cited plans. §4 = the capability catalog (what an AI could drive). §5 = the AI scene-authoring / "MCP" design. §6 = recommended sequence + areas of improvement.

---

## 1. Executive summary — how close are we?

Two files, two very different states of progress:

| God-object | Original | Now | Δ removed | Subsystems extracted | Decomposition state |
|---|---|---|---|---|---|
| `scene3d-manager.ts` | ~15,267 | **11,988** | ~3,280 (~21%) | **7** (particles, html-textures, grease-pencil-data, blend-shapes, cloth, ribbon, **character overlays**) | **Meaningfully underway** — the low/medium-coupling subsystems are out; what remains is (a) thin delegators that *are* the intended API surface, (b) a few cohesive clusters still to extract, (c) the armature/gizmo/skeleton/weight-paint **tangle** (deliberately last). |
| `shape-manager.ts` | ~14,245 | **14,262** | ~0 | **0** (facade over ~30 pre-existing delegates; residual inline subsystems never moved) | **Barely started.** The facade + delegates predate this effort; the large *inline* subsystems the plan targets (Decals+GARP, LiveText, Ephemera, Packaging, Document persistence) are all still inline. |

**Headline:** `scene3d-manager` is the further-along one — the proven `ManagerContext` + narrow-host + thin-delegator template has been applied 7×. `shape-manager` is where the next big neatness wins are, and they're *lower-risk* than they look because the target owners (GarpManager, EphemeraService, PackagingManager) already exist — it's moving inline code to a home that exists, not inventing architecture.

**By the numbers.**
- **`scene3d-manager` (11,988 lines, ~35–40% decomposed):** 7 subsystems extracted (~3,486 impl lines in siblings). Of what remains: ~900 lines are done-as-delegators (the intended API surface), ~700 stay as facade infra, ~6,200 are cohesive subsystems queued for extraction, and ~3,900 are the armature tangle (last).
- **`shape-manager` (14,262 lines, ~1,161 public methods, ~5–8% decomposed):** roughly *half* the file is thin delegation to `scene3d` — but that work happened *inside* `Scene3DManager`, not here. The ~5,400 lines of subsystems ShapeManager itself owns (Decals, GARP glue, LiveText, Ephemera overlay, Packaging glue, UV-paint sessions, shape-restore, and the ~1,156-line persistence orchestrator) have had **zero** extractions. It is one full decomposition phase behind scene3d.
- **Net:** the codebase is meaningfully neater than a year ago (scene3d down ~21%, 7 clean subsystems, proven template), but the *majority of movable line-count still to move* is split between scene3d's queued subsystems + tangle and shape-manager's entirely-untouched inline subsystems. "Properly organized" is maybe **halfway** by the honest measure — with the crucial caveat that the AI-authoring goal needs far less than 100% (see §5).

---

## 2. `scene3d-manager.ts` — remaining work

**11,988 lines. ~35–40% decomposed.** Seven subsystems are out (siblings, ~3,486 impl lines): `scene3d-particles.ts` (104), `-html-textures.ts` (179), `-grease-pencil.ts` (234, data-only), `-blend-shapes.ts` (78), `-cloth.ts` (833), `-ribbons.ts` (492), `-character.ts` (1,566, overlay content). Constructor wiring at `585–616`.

**The remaining 11,988 lines break down as:**
- **~900 "done" — thin delegators** to the extracted subsystems (blend-shape, face, overlay, GP, ribbon, HTML-tex, cloth, particles). These *are* the intended public API surface — complete by design.
- **~700 "stays" — facade infra (d):** undo, render-settings delegators to `renderer3D`, persistence glue (`restoreMeshState`), GLTF export, dirty aggregator, + ~250 lines of field declarations. Correct to keep on the god-object.
- **~6,200 "still to extract" — cohesive class-(b) subsystems** (queued, medium risk): see the table below.
- **~3,900 "the tangle"** — armature/gizmo/skeleton/weight-paint/IK + character-skeleton animation. Extractable but **last** (high-risk, browser-gated).

### Not-yet-extracted subsystems (the queue), easiest → hardest

| Proposed class | Lines | Est. | Difficulty | Narrow host it needs |
|---|---|---|---|---|
| **Scene3DModifiers** (geometry-modifier stack) | `6256–6372` | ~120 | **easy** (cleanest remaining — state lives on `Mesh3D`, like blend-shapes) | `{ getMesh }` |
| **Scene3DPrimitives** (primitives, obj/gltf import, ground scatter) | `2044–2298`, `2592–3007`, `2299–2469` | ~840 | easy–med (mostly pure builders; `createMesh` is the shared factory) | `{ addNodeToScene, getModelStore, autoScaleToFit }` |
| **Scene3DSurfacePaint** (viewport→UV paint input) | `4939–5128` | ~190 | easy–med | pointer/raycast→UV |
| **Scene3DMaterials** (render-style/pattern/textures/normal-maps) | `3447–3666`, `7236–7300`, `11252–11307` | ~500 | med (scattered — collect first) | `{ getMesh }` + atlas |
| **Scene3DArrays** (array tool + live sync + bake) | `6168–6255`, `6373–7096`, `8917–9057` | ~900 | med (`_ensureArrayGroupSync` is a shared host method) | selection + transform host |
| **Scene3DGrouping** (mesh groups, city containers, outliner) | `2470–3007`, `5942–6167`, `11112–11251` | ~940 | med (thin-wrapper couples to gizmo) | `{ getMesh, sceneGraph }` |
| **Scene3DCameraViewport** (camera + orbit + illustration-sync + focus) | `1214–2043`, `9058–9200` | ~830 | med (armature camera-lock straddles the tangle) | `{ getMeshCenter, isArmatureModeActive }` |
| **Scene3DSelection** (selection/hover/picking/projection) | `7518–7814` | ~300 | med (the transform controller consumes it — binds to tangle) | `interactionService`, highlight pass |
| **Scene3DKeyframes** (keyframes/FLA/NLA/camera-keys) | `9201–9705`, `9758–9959` | ~680 | med — **cut the FLA↔keyframe-apply seam first** (flagged interwoven) | `{ getMesh, getSkeleton, applyPoseToSkeleton }` |
| **Scene3DGpDraw** (GP interactive draw-mode controller) | `4685–4938` | ~250 | med–hard (broad host: gizmo + pick + canvas + unproject) | `{ unprojectScreen, setGizmoMode, pickFaceFromClient, getGpSubsystem }` |
| **Body-orchestration / kitbash / char-animation** | `3667–3975`, `4169–4577`, `585–1051` | ~1,000 | **hard** — bound to skeleton/IK/undo/GLB; effectively part of the eventual `Scene3DArmature` | (folds into armature) |

### The tangle — one eventual `Scene3DArmature`, extracted last

Spans `5516–5941`, `7815–8916`, `9783–10790`, `10791–11074`, + character-anim `585–1051`. The reason it can't be split piecemeal: a block of ~40 shared mutable fields (`342–457`) — bone overlay (`_boneOverlaySkeletonId`, `_selectedJointIndex`), armature camera-lock (`_armatureOrbitCenter`, `_armatureOrtho*`), mesh isolation (`_isolatedMeshId`, `_savedMeshVisibility`), joint/IK/FK drag state, bone placement, weight-paint, and the gizmo objects (`_transformController`, `_gizmoRenderer`) — is read+written by **two mega-closures**: `_setupBoneOverlayListeners()` (**~617 lines, `8252–8869`**, one move/down/up triple doing IK-drag + FK-rotate + joint-gizmo + drag-to-move + tail-preview + hover + bone-placement) and `enableTransformControls()` (`7843–8869`, which *nests* the bone-overlay setup). `showBoneOverlay3D` alone touches camera + selection + gizmo + isolation in one method. Any single extraction (e.g. "just weight paint") relocates the shared closure → partial splits just move the tangle. **Recommendation:** extract it as one `Scene3DArmature` *after* Selection (2.10) and Camera (2.1) are out (the gizmo closure reads both), with browser verification (no automated coverage).

*(The full public 3D API inventory Agent A produced is folded into §4's capability table and §5; it's the raw surface a `SceneAuthoringAPI` façade would wrap.)*

---

## 3. `shape-manager.ts` — remaining work

**14,262 lines, 1,161 public methods, ~30 delegates (`initDelegates()` @ `377`). ~5–8% decomposed — it is at the starting line.** The important nuance: roughly **half the file is thin delegation to `scene3d` and friends** — but that decomposition was done *inside `Scene3DManager`*, not here. The code ShapeManager *itself* owns and must extract — **~5,400 lines of residual inline subsystems — has had zero extractions.** Every planned ShapeManager move in `god-objects-and-perf.md` is still deferred. It is one full phase behind scene3d-manager.

### Residual inline subsystems ShapeManager owns (the queue), easiest → hardest

| Proposed target | Lines | Est. | Owner | Difficulty | Notes |
|---|---|---|---|---|---|
| **DecalManager** (new) | `5297–5523` + `5984–6240` | ~450 | new | **low** — best first pilot | id-keyed (`_decals`/`_decalPlace*` @ `5303`), self-contained; decals ≠ GARP (the spec said GarpManager — a *new* class is correct) |
| **LiveTextManager** (new) | `9878–10370` | ~465 | new | **low** — cleanest | near-zero shared state (only `_editingLiveTextId` + `findLiveTextNode` @ `10206`); spec undercounted it as ~370 |
| **Ephemera overlay** → `EphemeraService` | `13710–13913` (`_renderEphemeraOverlay` @ `13734`) | ~200 | exists | low–med | inline 2D-canvas overlay renderer + selection handles (`_ephemeraOverlay*` @ `250`) |
| **GARP glue** → `GarpManager` | `5524–5983` | ~460 | exists | low–med | `_ensure*Garp` seeders + `_garpPaintTargets` @ `5773`; the paint-bridge half couples to UV-paint |
| **UV-paint sessions** → `UVPaintSessionManager` (new) | `6802–7140` | ~340 | new | med | one shared `_uvPaintController` drives both character- and packaging-paint — a real inline subsystem the spec missed |
| **Packaging glue** → `PackagingManager` | `4542–4934` | ~390 | exists | med | `_pkgComposites` + `_pkgRecomposite`/`_pkgRefreshVectorProxies`; tangled with the shared UV-paint controller + live-texture wiring |
| **Frame-Link-Animation (2D)** | `2230–2656` | ~425 | new/service | med | ~425 lines of inline anim logic, not a pure delegator (spec missed this) |
| **Shape-restore switch + uniform registry** | `11381–12006` | ~1,540 | shape-factory / persistence | med | large inline `switch(type)` re-hydrating every 2D shape — belongs with the factory |
| **DocumentPersistence** | `12414–13570` (+ `packProject`/`unpackProject` `12833–12940`) | ~1,156 | **extract LAST** | high | orchestrator — see below |

### Document persistence — the last-to-extract orchestrator (and the load bottleneck)
`restoreDocumentState` (`13152`) / `gatherDocumentState` (`12970`) / `packProject`/`unpackProject` sequence-orchestrate nearly every subsystem: scene-graph JSON, brush presets, raster layers (clear/recreate/upload/resize `13191–13251`), 3D scene JSON, per-mesh UV-paint restore, `scene3d.restore*Rigs`/`restoreBakedParts`/`restoreBodyParams` (`13456–13495`), `_ephemera.deserialize`, `_garp.restore`, then **`restoreProceduralFromSave3D()` (`6219`)** + `_restoreProceduralMeshTextures`. It's the correct *last* extract: once decals/GARP/livetext/ephemera/packaging each own `serialize()/restore()`, this collapses to a list of `subsystem.restore(payload.x)` calls and becomes a thin `DocumentPersistence`.

**The load bottleneck lives here.** `restoreProceduralFromSave3D` (`6219`) is **synchronous** and blocks the load: `world.restoreFromSave()` regenerates the **whole city** (`6220`), then `blocks.restoreFromSave()`, then a loop over all 11 procedural creators (`6227`) each re-running its generator, then decals + packaging. It's bracketed by the `_lap('★ procedural regen …')` timer (`13542`) — the confirmed hotspot. Isolating `DocumentPersistence` is the natural moment to make this async/chunked/worker-offloaded (§6).

*(Full public API inventory — raster/brush, vector shapes, layers, text/LiveText, save/load, procedural creators, packaging, decals, GARP, UV paint, kitbash/character, mesh-edit/UV-editor, ephemera — is folded into §4's capability table.)*

---

## 4. Capability catalog — what an AI could author

The engine is already **"params → geometry"** end to end, which is the single biggest asset for AI authoring: the procedural generators take plain param objects, and props/buildings/characters all serialize as **params-only markers that regenerate on load** — so anything the AI authors gets free save/reload. Two façades matter: **`ShapeManager`** (`shape-manager.ts:155`, the host-facing surface; `*3D` methods wrap 3D ops) and **`Scene3DManager`** (the 3D god-object). The city is reached via the public field **`sm.world.*`** (`WorldManager`). Every creator prop extends one **`ProceduralObjectManager`** base with a universal `createFromParams`/`setParams`/`setTransform`/`frame`/`remove`/`restoreFromSave` lifecycle.

Readiness legend: 🟢 clean single entry-point (good tool as-is) · 🟡 usable but large-payload or stateful (drive via `getDefault*` + partial patch) · 🔴 buried/coupled (needs a small facade first).

| Area | Best entry-point (file:line) | Params source | Ready |
|---|---|---|---|
| **Primitives** | `createBox3D/createSphere3D/createCylinder3D/createTorus3D/createPlane3D/createCustomMesh3D` (`shape-manager.ts:2942`+), all take `material?` | `mesh-generators.ts` gens | 🟢 |
| **City / world** | `sm.world.generateWorld(params?, draft?)` (`world-manager.ts:1125`); live `updateCity` (`:1293`); `enterCityMode` | `LayoutParams` (~60, `world/types.ts:64`, `DEFAULT_LAYOUT_PARAMS`) | 🟢 gen / 🔴 internals |
| **Creator props (×10)** | `createCreator3D(typeId, params?, transform?)` (`shape-manager.ts:5274`) + `creatorParamSchema3D(typeId)` (`:5269`) — **one tool + one schema query covers all props** | per-type schema (self-describing) | 🟢 (best surface in repo) |
| **Standalone buildings** | `createProceduralBuilding3D(params?, x,y,z, opts?)` (`shape-manager.ts:5186`); `setBuildingParams3D` (archetype-switch keeps seed) | `BuildingParams` (~90, `world/building.ts:51`), 11 archetypes @ `:178` | 🟢 (expose `{archetype,seed,x,y,z}` for common case) |
| **Characters (one-shot)** | `createFullCharacter3D(opts)` (`shape-manager.ts:5087`) → body+face+hair+6 garments+skin | nested `Body/Clothing/Hair/Eye` params | 🟢 |
| — body | `createProceduralBody3D` (`:5073`); `setBodyParams` (`scene3d-manager.ts:3866`, live regen) | `BodyParams` (12 multipliers, `body-generator.ts:18`) | 🟢 |
| — clothing | `setClothingParams3D(body, params)` (`:7297`, slot inferred) | `ClothingParams` union by `slot` (`clothing-generator.ts:141`) | 🟢 |
| — hair | `setHairParams3D` (`:7193`) | `HairParams` (~70 fields, `hair-generator.ts:25`) | 🟡 |
| — attachments (17 types) | `addAttachment3D(body, type, placement?, params?)` (`:7400`) | `AttachmentParams` + `AttachmentPlacement{joint,offset,scale}` | 🟢 |
| — face/eyes | `ensureFace3D`→`createFaceExpression3D`→`setFaceExpressionProcedural3D` (multi-step) | `EyeParams` (~35, `eye-generator.ts:27`) | 🟡 |
| — skin tone | `setSkinTone3D(body, hex)` (`:5137`) | hex string | 🟢 |
| **Materials** | `sm.scene3d.setMaterial(nodeId, Partial<Material3D>)` (`scene3d-manager.ts:7211`) — **no `*3D` wrapper (gap)**; `setRenderStyle3D` (`:3851`); `setMeshPattern3D` (`:3872`) | `Material3D` (`material-3d.ts:22`) | 🟢 |
| **Textures** | `uploadAndApplyTexture3D` (`:8839`), `applyLibraryTexture3D` (`:8844`) | image source + id | 🟢 |
| **UV paint** | non-interactive **`setPartTexture3D(meshId, image)`** (`:7367`, tracked, survives regen) — prefer over the stateful `enterUVPaintMode3D` | image source | 🟢 (non-interactive) / 🔴 (interactive) |
| **Packaging** (flag-gated) | `sm.packaging.create(style, params)` (`packaging-manager.ts:693`); `setFoldAmount`, `fold/unfold` | `DielineParams` (mm, `types.ts:11`), 5 `BoxStyle`s | 🟢 (PNG export only; PDF not built) |
| **Particles** | `addParticleEmitter(x,y,z, config?, preset?)` (`:11750`) | `ParticleEmitterConfig` + presets dust/sparks/snow/magic | 🟢 |
| **Ribbons** | `addRibbon3D(x,y,z, controlPoints[], width, segments?, material?)` (`:11323`) | control points | 🟢 |
| **Cloth** | `createClothMesh(...)` (`:11502`) | `ClothGridConfig` | 🟢 create / 🔴 full sim authoring |
| **Grease pencil** | `createGpObject`→`beginGpStroke`→`addGpPoint`→`endGpStroke` | stroke sequence | 🟡 |
| **HTML/canvas texture** | `setHtmlTexture3D(meshId, html, w, h)` (`:11433`) | HTML string | 🟢 |
| **Decals** | `placeDecalAtScreen3D(source, x, y, rect, opts)` (`:5336`) | image + screen pos | 🟢 |
| **Blend shapes** | `addBlendShape3D(meshId, name, deltaVertices)` (`:3010`) | raw `Float32Array` | 🟡 |
| **Lighting** | `setDirectionalLight` (`:7423`), `setAmbientLight` (`:7428`), `setPointLights3D` (`:1180`), `setEnvironmentMap3D` (IBL) | RGB + dir/intensity | 🟢 |
| **Camera** | `createCamera(config?)` (`:1218`), `setIllustrationProjection3D` (`shape-manager.ts:2869`) | `Camera3DConfig` | 🟢 |
| **Render style / PS1 / fog / SSAO / bloom / outline** | `setPS1Config` (`:7395`), `setFog3D` (`:7433`), `setSSAO3D` (`:1117`), `enableBloom`/`enableOutlines` | typed config objects | 🟢 |
| **Scene snapshot** | **`getGlobalScene3DSettings()` / `restoreGlobalScene3DSettings(partial)`** (`:7303`/`:7338`) — one object: projection, ps1, lighting, bg, fog, ibl, postProcess, ssao, shadows, grid | `GlobalScene3DSettings` (`:144`) | 🟢 (ideal AI surface) |
| **Transforms** | `setPosition3D` (`:8202`), `setRotation3D` (Euler rad, `:8211`), `setScale3D` (`:8220`) — **absolute only, no deltas** | x/y/z | 🟢 |
| **Grouping / array / duplicate** | `createMeshGroup3D` (`:7978`); `createLinearArray3D`/`createGridArray3D`/`createRadialArray3D` (`:8008`+, GPU-instanced); `duplicateMesh3D` (`:4930`) | counts/spacing | 🟢 |
| **Geometry modifiers** | any-mesh CPU stack `addGeomModifier3D` (`:8114`, Mirror/Solidify) **vs** edit-mode topology `addMirror/SubdivisionModifier3D` (`:7948`) — **two distinct stacks** | mod configs | 🟢 |
| **Selection** | `getSelected3DIDs`/`setSelected3DIDs`/`clearSelection3D` (`:8822`+) | id arrays | 🟢 |
| **2D vector shapes** | `createRectangle/Circle/Triangle/Line/Arrow` (`shape-manager.ts:2585`+) — fill comes from ambient `shapeColor` (facade should pass fill explicitly) | x/y/w/h + stroke | 🟡 |
| **2D raster paint** | `getRasterPaintEngine()` → `beginStroke`/`addStrokePoint`/`endStroke` (stroke lifecycle) | `PointerInput` points | 🔴 (needs `paintStroke(points[])`) |
| **Text** | `createLiveText` (`:9911`) + `setLiveTextContent/Style/Effects`; `stampEffectedText` (`:10403`, one call) | text + style/fx | 🟢 |

**Needs a small facade before AI use:** raster brush paint (synthesize a `paintStroke(layerId, points[], brush)` over the begin/add/end lifecycle), interactive UV paint (prefer `setPartTexture3D`), grease-pencil stroke sequences, full cloth-sim authoring (~30 GPU-coupled methods), vector-shape fill (ambient color), `createEffectedText` (returns a raw GPUTexture — use `stampEffectedText`).

**Gotchas to bake into any tool schema:** a **cone** is `createCylinder3D` with `radiusTop: 0` (no cone primitive); there are **two** geometry-modifier stacks; `packaging.setStyle` **changes the package id** (topology rebuild); the character **GLB-kitbash** path (`createCharacter`) is asset-coupled — use the procedural path; world methods live on `sm.world.*` (not `*3D`), and `setMaterial` has no `*3D` wrapper — an MCP layer should normalize these. **Not built (spec only):** emotes (`playEmote3D`), packaging PDF/spec-sheet export.

---

## 5. AI scene-authoring / "MCP" design

**Why decomposition and this goal are the same project:** an AI tool surface is only as clean as the API it calls. Today an AI would face a 12k-line manager (~640 public methods) and a 14k-line manager (~1,200) with no coherent, safe, documented surface. Every extracted subsystem that exposes a small typed API (`Scene3DParticles`, `Scene3DCharacter`, …) is *exactly one clean tool group*. So finishing the decomposition **is** the MCP groundwork — the two goals converge.

### Design principles
1. **A thin `SceneAuthoringAPI` façade — NOT the managers.** ~40–60 curated, stable, documented verbs that delegate to ShapeManager/Scene3DManager. The AI never sees the god-objects, and the AI contract is decoupled from the ongoing refactor. This is the deliverable — one new file, not a rewrite.
2. **Verbs map to *capabilities*, not internal methods.** `addPrimitive({kind,size,position,material})`, `generateCity({seed,size,biome})`, `addCharacter({body})`, `dressCharacter({id,slot,params})`, `addProp({type,params,position})`, `paintPart({meshId,image})`, `setLighting({sun,ambient})`, `setSceneStyle(GlobalScene3DSettings)`. Each returns a stable id.
3. **The generators' param objects ARE the tool schema.** The whole engine is "params → geometry"; `BodyParams`/`ClothingParams`/`LayoutParams`/`BuildingParams`/the creator schemas (`creatorParamSchema3D` is already machine-readable) become the tools' JSON Schema directly. This is the biggest asset — most of the schema already exists.
4. **Everything id-based, idempotent-ish, undoable.** Wrap each op in the existing undo system → an AI mistake is one Undo. Use `getDefault*() + partial patch` for the large-payload params (Hair ~70, Eye ~35, Building ~90, Layout ~60) so the model only emits deltas.
5. **Read-back verbs for a closed loop.** `listObjects()`, `describeScene()`, `getObject(id)`, and a `screenshot()` (render-to-image) so the model can *see* what it made and self-correct — the same critic loop that makes agentic work good. `getGlobalScene3DSettings()` already gives a perfect one-object scene readout.
6. **A `applyScenePlan(ops[])` transaction verb.** Accept a whole declarative scene plan and execute in one undo group — lets a local model emit a full scene in one shot, then refine.

### Where each capability sits for MCP
- **Ready to wrap directly (most of the engine):** primitives, city (`generateWorld`), all 10 creator props (`createCreator3D` + schema — the cleanest surface), buildings, characters (`createFullCharacter3D` + the setters), materials/textures/`setPartTexture3D`, packaging, particles/ribbons/decals/HTML-textures, transforms/grouping/array/duplicate/selection, and the scene-control setters + `getGlobalScene3DSettings`.
- **Wrap with a helper first:** raster paint (`paintStroke(points[])` over begin/add/end), grease pencil, full cloth authoring, vector-shape fill. These are the same "needs a facade" items §4 flags.
- **Normalize in the façade:** `sm.world.*` → `world*` verbs; add the missing `setMaterial3D` wrapper; the cone/two-modifier-stacks/`setStyle`-changes-id gotchas become schema docs or are hidden by the verb.

---

## 6. Recommended sequence + areas of improvement

### Recommended order (converges "neat architecture" + "AI can author")
The ordering rule: **do the low-risk, high-neatness moves first; define the AI façade the moment the capability groups are stable; leave the interactive-editing tangle for last (the AI doesn't need it).**

1. **Finish the low-risk ShapeManager extractions** (biggest neatness-per-risk — targets mostly exist, so it's relocation, not new architecture), in this order: **DecalManager** (new, `5297–5523`+`5984–6240`, lowest coupling — the pilot) → **LiveTextManager** (new, `9878–10370`, near-zero shared state) → **Ephemera overlay** → `EphemeraService` → **GARP glue** → `GarpManager` → **Packaging glue** → `PackagingManager`. This is where the biggest line-count wins are (shape-manager has 0 of its own extractions done).
2. **Extract the easy scene3d subsystems** in queue order: `Scene3DModifiers` (cleanest) → `Scene3DPrimitives` → `Scene3DSurfacePaint` → `Scene3DMaterials`. Each is the proven `ctx` + narrow-host template; each is one green typecheck + a colocated test.
3. **Extract the medium scene3d subsystems:** `Scene3DArrays`, `Scene3DGrouping`, `Scene3DCameraViewport`, `Scene3DSelection`, `Scene3DKeyframes` (cut the FLA seam first), `Scene3DGpDraw`.
4. **Define `SceneAuthoringAPI`** (the AI façade, §5) — *this can happen now, in parallel with step 3*, because the authoring capabilities (primitives, city, props, characters, materials, scene settings) are already stable and don't depend on the tangle. The AI never needs the gizmo/weight-paint/IK editing machinery.
5. **Generate the MCP tool schema** from the generator param types + `creatorParamSchema3D` (already machine-readable) + the façade verbs.
6. **Extract the armature tangle last** as one `Scene3DArmature` (after Selection + Camera are out), browser-verified.
7. **Document persistence last** on the ShapeManager side — once each subsystem owns `serialize()/restore()`, `DocumentPersistence` orchestrates instead of reaching in.

### Areas of improvement (independent of the two goals)
- **Load time is a scene-build problem, and it's the same code an AI would hit.** The traced load bottleneck is `restoreProceduralFromSave3D` — synchronous city/prop/character regen on the main thread, un-awaited, right before the overlay-clearing emit (`shape-manager.ts:13521`/`:13551`). Time-slicing or worker-offloading the centre-city build is both a load-time win *and* what stops an AI "generate a big city" call from freezing the tab. High-value, and it touches the persistence region that's slated for extraction anyway.
- **Finish `§5.2` typed flags.** Duck-typed `(mesh as any).isProceduralBody/.isClothing/…` still exist in places; promoting them to typed optional fields makes every remaining extraction compiler-checked *and* makes the AI tool schema self-documenting (the type IS the contract).
- **Naming convention.** Sibling files are `scene3d-*.ts`; ShapeManager's future extractions should adopt one matching convention, and `sm.world.*` / the missing `setMaterial3D` wrapper should be normalized (the façade can do this).
- **Subsystem-owned serialization is the right end-state** (already true for character/cloth/ribbon) — finishing it collapses the giant persistence region into a thin orchestrator.
- **Pipelines: the `§3.1` plain-shader + granular-warm work is done** (see `docs/specs/pipeline-warmup.md`); the remaining perf items P2/P3/P4 (skinned batching, pass coalescing, incremental atlas) are the close-up bottlenecks and align with the instancing spec.

### Bottom line
- **`scene3d-manager`:** ~35–40% decomposed, template proven 7×; the low/medium subsystems are a well-understood queue, and only the armature tangle is genuinely hard — but the AI-authoring goal doesn't need the tangle, so a clean authoring façade is reachable *soon*.
- **`shape-manager`:** the neatness debt is bigger here (barely started) but the risk is *lower* than scene3d's remaining work, because the targets are relocations to owners that already exist.
- **The MCP goal is closer than the "finish all decomposition" goal** — most authoring capabilities already have clean entry points (§4). The façade + schema is the direct path; the decomposition makes it *stay* clean.

---

## Progress — SceneAuthoringAPI v1 SHIPPED (2026-08-17)

**`src/services/scene-authoring-api.ts` (+8 tests) — the §5 façade now exists.** A thin, curated, STABLE class over `ShapeManager`, reached via **`sm.authoring`** (lazy getter). tsc-verified against the REAL ShapeManager signatures (every verb type-checks against the actual entry-points), 8 delegation/normalization tests, build clean.

**v1 verb groups (all 🟢 from §4):**
- **Primitives** — `addBox/addSphere/addCylinder/addTorus/addPlane` (options-object in, id out). *(Cone omitted: `createCylinder3D` takes a single `radius`, not `radiusTop` — the §4 cone gotcha is the mesh-generator level, not the wrapper; needs the custom-mesh path, deferred.)*
- **Transform** — `setPosition/setRotation/setScale` (absolute; documented axis defaults).
- **Material** — `setMaterial` (normalizes the missing `setMaterial3D` wrapper) + `setColor`.
- **World** — `generateCity` (normalizes `sm.world.generateWorld` into a verb).
- **Props** — `addProp` + `propSchema` (the one-verb-covers-all-creators surface).
- **Buildings** — `addBuilding`.
- **Lighting** — `setDirectionalLight/setAmbientLight`.
- **Read-back (closed loop)** — `listObjects/removeObject/getSelection/select/describeScene`.
- **Scene settings** — `getSceneSettings/applySceneSettings` (the whole GlobalScene3DSettings object).

**Design realized:** thin façade (no god-object exposure); the AI contract is decoupled from the ongoing refactor; gotchas normalized in the verbs; params-as-schema (the delegated methods' own param types are the schema).

**v2+ backlog:** more verb groups (characters via `createFullCharacter3D`, textures, particles/ribbons, decals, packaging, text); read-back `getObject(id)` + `screenshot()` (render-to-image for the critic loop); the `applyScenePlan(ops[])` one-undo-group transaction verb; and generating the MCP tool JSON Schema from the generator param types + `creatorParamSchema3D` (already machine-readable).

## Progress — SceneAuthoringAPI v3: model-consumable (2026-08-17)

**The full model bridge now exists.** `src/services/scene-authoring-tools.ts` (+7 tests):
- **`sceneAuthoringTools(): ToolDef[]`** — ~33 Anthropic/MCP-style tools (name + description + JSON-Schema `input_schema`), authored declaratively in one place. Hand these to a model's `tools` param.
- **`runSceneAuthoringTool(api, name, input)`** — the dispatcher: executes a returned `tool_use` against a live `SceneAuthoringAPI`, returns the verb result to feed back. A **sync-guard test** asserts every generated tool has a dispatch case (schema ↔ dispatcher can't drift).
- Creator props stay schema-driven at runtime: the model calls `propTypes`/`propSchema` then `addProp`.

**API v3 additions (`scene-authoring-api.ts`):** `screenshot(maxWidth?)` → PNG `data:` URL (via `sm.captureThumbnailBlob` → `webgpuRenderer.snapshotToBlob`) — the **visual critic loop**; `list2DObjects()` (via new `ShapeManager.getVectorShapes()` — the 2D counterpart of `getAllMeshesForAnimation3D`, closing the vector read-back gap); `propTypes()`.

**Wiring (Frogmarks, ~one loop):** `tools = sceneAuthoringTools()` → Messages API with the user prompt → on each `tool_use` call `runSceneAuthoringTool(sm.authoring, name, input)` → return results (incl. `screenshot` images as base64) → loop until `end_turn`. Anthropic API key (not the subscription).

**Status: the AI-authoring pipeline is complete end-to-end** (tools → model → dispatcher → API → engine, with screenshot feedback). 3D + 2D-vector composition are both drivable today; raster paint deliberately excluded. Remaining polish: `applyScenePlan(ops[])` one-undo-group transaction; per-type generated prop tools (vs the generic addProp+propSchema); more verb groups (characters/text/particles/decals). Browser-verify: the vector verbs + `getVectorShapes` + `screenshot` render/capture correctly.
