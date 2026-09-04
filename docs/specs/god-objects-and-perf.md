# God-Object Extraction + Performance Spec

**Created 2026-08-05.** Source: `docs/backlog-audit-2026-08-05.md` §5.1 + a live 6-agent research sweep of the working tree. This is the execution plan for (A) decomposing the two ~15k-line god-objects and (B) the eight *new* performance opportunities found during that sweep.

Line counts verified live: `scene3d-manager.ts` = 15,267 lines / 814 KB · `shape-manager.ts` = 14,245 · `renderer-3d.ts` = 4,487 · `webgpu-renderer.ts` = 4,998.

> **Working-tree rule:** the tree is shared. I never run state-mutating git. The user commits. Every step below is verified with `npx tsc --noEmit` + `npx vitest run` before moving on.

---

## Part A — God-object extraction (§5.1)

### The finding that reframes the risk

The safe extraction pattern **already exists and is battle-tested here** — this is *continuing an established migration*, not inventing an architecture:

- **`Scene3DManager` already takes a narrow `ManagerContext`** (`manager-context.ts:19`): `{ sceneGraph, webgpuRenderer, interactionService, layerManager, scheduleRender(), emitSceneGraphChanged(), sceneStructureVersion(), setSelectedNode() }`. It touches `ctx` in ~8 shapes, dominated by `scheduleRender` (289×), `emitSceneGraphChanged` (120×), `sceneGraph` (105×), `webgpuRenderer` (88×). **Any extracted subsystem takes the same `ManagerContext` + a typed back-reference to the parent for the few cross-subsystem calls.**
- **`ShapeManager` is already a facade** over ~30 delegates built in `initDelegates()` (`shape-manager.ts:371`). Its bulk is **residual inline subsystems that were never moved to a delegate that already exists**, not a first-time decomposition.

### Extraction strategy (safe, incremental)

1. **Reuse `ManagerContext`, never pass raw `this`.** Each new subsystem is `class Scene3DFoo { constructor(private ctx: ManagerContext, private host: Scene3DHost) }` where `Scene3DHost` is a *narrow typed interface* exposing only the handful of cross-subsystem calls it needs (`getMesh`, `getSkeleton`, `_ensureArrayGroupSync`, …). Preserves the no-circular-dependency property.
2. **Keep public signatures as thin delegators on the god-object.** `removeParticleEmitter(id)` → `this._particles.remove(id)`. Callers and the ~214 `as any` pokes never change — they're on `Mesh3D`/`Node` scene-graph objects (`.liveConfig`, `.clothConfig`, `.gpuDirty`), *not* manager privates.
3. **Move state field-by-field, one subsystem per step.** State is already grouped by subsystem in the class header (`scene3d-manager.ts:360–632`); each move is a mechanical cut of a contiguous field block + its method cluster. Type-check after each — the `private` fields make a missed cross-reference a compile error.
4. **Sequence low→high coupling.** Prove the template on 4–5 easy subsystems before facing the armature/gizmo/skeleton tangle.
5. **§5.2 first (prerequisite).** Promote duck-typed `(mesh as any).isSkinned/.isClothing/.isProceduralBody/.clothConfig/.liveConfig` to typed optional fields on the mesh interface, so every subsequent move is compiler-checked instead of runtime-fragile. **Highest-leverage safety prep.**

### Scene3D subsystem map + extraction order

Best first extractions (low→high coupling):

1. **Particles** → `Scene3DParticles` (~120 lines, `14898–14990`). `_particleEmitters` (8×) + `_particleTickCb` + `ctx` only. Zero cross-subsystem field access — the **risk-free pilot** that proves the template.
2. **HTML textures** → `Scene3DHtmlTextures` (~180 lines, `13708–13884`). `_htmlTextures` (7×) + `ctx`. Two stray reads (`_clothData`, `_ribbonData`) live in a shared dirty-scan → resolve with a parent `getDirtyMeshIds()` aggregator.
3. **Grease Pencil** → `Scene3DGreasePencil` (~1050 lines, `6230–7278`). All `_gp*` state + draw-listeners, id-keyed, self-contained; only outward call is camera unproject (via `ctx`).
4. **Cloth** → `Scene3DCloth` (~900 lines, `13884–14813`) and **Keyframes/NLA** → `Scene3DAnimation` (~800 lines, `10931–11497`). Both cohesive + id-keyed.

**Defer (the tangle):** camera/orbit, transform/gizmo, armature/bone-overlay/IK, skeleton-edit, weight-paint (blocks 1/12/15/18/19). They share `_boneOverlay*`, `_selectedJointIndex`, `_isolatedMeshId`, and the ~620-line `_setupBoneOverlayListeners` closure (`9971`). Extracting one relocates the tangle — treat as one eventual `Scene3DArmature`, **last**.

### ShapeManager subsystem map + extraction order

The extractable weight is inline code that never reached a delegate:

1. **Decals + GARP** → existing `GarpManager` / new `DecalManager` (~750 lines, `5340–6098`). Highest ratio of self-contained inline code to an already-existing owner. `_creatorOwning`/`_decalHitToward`/`_ensure*Garp` are id-keyed, touch only sceneGraph + renderer.
2. **Live text** → `LiveTextManager` (~370 lines, `9905–10273`). No shared state beyond `findLiveTextNode`.
3. **Ephemera overlay rendering** → fold into existing `EphemeraService` (`_renderEphemeraOverlay`/`_ephemeraOverlayCache`, `13557–14201`).
4. **Packaging glue** → into existing `PackagingManager` (`_pkgResolveOwningPackage`/`_pkgRecomposite`/`_pkgRefreshVectorProxies`, `4556–4924`).
5. **Document persistence** last (`gatherDocumentState`/`restoreDocumentState`/`packProject`, `10868–13557`) — extract after each subsystem exposes its own `serialize()/restore()` so `DocumentPersistence` orchestrates instead of reaching in.

Leave block C (`2816–9705`, the pure 3D delegators) as the public API surface.

### Characterization-test harness

- **Most risk is pure logic needing no device.** Generators (`body`/`clothing`/`hair`/`attachment`-generator.ts) are pure `params→typed arrays` — testable **today**. Same for `_buildBodyFit`, `_garmentRadiusAt`, FLA rest-transform math, keyframe interpolation, array-group slot math.
- **Seam 1 — generator invariant tests (§5.3), do FIRST, no GPU.** `validateBodyResult()`: weights sum to 1±ε, no NaN/degenerate tris, stable joint count, no verts collapsed to origin. Run as both dev-guard + test oracle. Would have caught the documented armpit-spike / UV-bleed / 4-restore-bug history.
- **Seam 2 — mock `GPUDevice`.** A stub recording buffer/texture calls characterization-tests orchestration (slot assignment, dirty-flag flow, id-map lifecycle, undo entries) via the `ManagerContext` injection point. Persistence round-trips test cleanly (assert DTO, not pixels).
- **Seam 3 — real-device smoke tests** only for shader/pipeline compile (WGSL compiles only on a real GPU). Keep few + separate.

**Test-first order:** (1) generator invariants → (2) persistence DTO round-trips → (3) per-subsystem tests written *as each subsystem is extracted*.

---

## Part B — Performance opportunities (new — no overlap with §3.1/3.3/3.4/3.6/3.8/3.9)

Ranked by ROI, weighted to the stated **mid-to-close-up as detail grows** bottleneck.

| Rank | Item | Effort | Risk | Helps close-up? |
|------|------|--------|------|-----------------|
| **P1** | Kill double scene-uniform upload per frame | S | very low | indirect (per-frame) |
| **P2** | Batch/instance skinned character parts | L | med | **yes — crowd/close-up bottleneck** |
| **P3** | Coalesce 4 geometry passes + share depth prepass | M | med | **yes** |
| **P4** | Incremental texture atlas | M | low-med | **yes — texture-edit hitches** |
| **P5** | Point-light loop active-count / early-out | S–M | low | yes (night close-up fill) |
| **P6** | `_selectNearestPointLights` scratch + quickselect | S | low | minor |
| **P7** | Cache `_usesPatterns` per mesh | S | low | minor |
| **P8** | Hoist atlas white-layer / DataView allocations | S | none | minor |

### P1 — scene uniforms uploaded twice per frame ⭐ free win
`webgpu-renderer.ts:3436` `drawMeshes` and `:3441` `drawSkinnedMeshes` run back-to-back in the same pass; **both** call `uploadSceneUniforms(w,h)` (`renderer-3d.ts:1701` + `:4175`). In any scene with characters that runs `_selectNearestPointLights()`, `_updateShadowCenter()`, `computeLightSpaceMatrix()`, and a ~816-byte `writeBuffer` **twice per frame**.
**Fix:** per-frame token (frame counter); `uploadSceneUniforms` early-returns if already uploaded this frame. Reset the token at pass start. Data is identical within a frame → trivial.

### P2 — skinned characters unbatched
`drawSkinnedMeshes` (`:4214`) issues `drawIndexed(...,1,...)` per mesh with its own `setVertexBuffer`/`setIndexBuffer` (`:4226`) + per-part `createTextureBindGroup` (`:4246`). One character ≈ body+hair+6 garments+eyes+face ≈ ~10 draws/10 rebinds; crowd = ~10N. Also excluded from shadow/AO/outline passes (`:4197`) → characters don't cast shadows / receive AO.
**Fix (phased, aligns with §4.5 instancing):** (a) share skin bind group per skeleton [done — `_skinBGs`]; (b) group same-pipeline/geometry parts to cut rebinds; (c) shared skinned VB/IB pool keyed by part geometry → instanced same-part-across-characters. Do after instancing-blocks foundation.

### P3 — four full-geometry passes
Main + shadow (`:1955`) + outline depth-normal prepass (`:1900`) + SSAO prepass (`:2000`) each re-iterate `opaqueForPasses` and re-issue the whole opaque list, each with its own `commandEncoder`+`queue.submit`. Throttled at city scale, but all four run over dense geometry at close-up.
**Fix:** (a) coalesce shadow/SSAO/outline encoders into fewer submits; (b) outline-prepass and SSAO-prepass both need scene depth → share ONE depth-normal prepass; (c) reuse the culled/batched sub-run across passes (recomputed per pass today).

### P4 — texture atlas fully rebuilt on any change
`_buildTextureAtlas` (`:3691`) destroys `_atlasTexture`/`_normalAtlasTexture` and re-copies **every** layer (`:3741`) + allocates a fresh `Uint8Array(W*H*4).fill(255)` white layer (`:3729`) whenever `_atlasDirty || anyGpuDirty`. Every close-up paint edit → full rebuild hitch.
**Fix:** incremental — stable layer→libId map, grow the array texture only when capacity exceeded, `copyTextureToTexture` **only the changed layer**, cache the white layer once. Preserve layer-index stability (meshes carry `textureIndex`).

### P5 — point-light loop always 16 iterations
`mesh3d-shaders.ts:1848` loops `pi < min(lightCounts.x, 16)` per fragment for every PBR/cel/cel-HD fragment; each does `length()`+divide+`dot` even for lamps whose `att` clamps to 0. `uploadSceneUniforms` also writes all `MAX_POINT_LIGHTS` slots every frame (`:2787`).
**Fix:** ensure `lightCounts.x` is the **active** count (0 in daytime → loop fully skips — free + safe); for night city, a cheap `att<=0 → continue` early-out or coarse tile/grid light assignment.

### P6 — `_selectNearestPointLights` allocates per re-select
`renderer-3d.ts:1051–1053` builds `cands.map(...)`, sorts, slices, maps again on every focus move. Large night candidate set → allocation + O(n log n) while panning.
**Fix:** reuse a scratch `{l,d}[]` + partial-selection (quickselect / bounded nearest-16 insertion) instead of full sort + two maps.

### P7 — `_usesPatterns` recomputed per-mesh per-frame
`:2096`/`:2111` call `_usesPatterns(m)` (`:1584`, 7 property reads) for lead + every group member every frame during the opaque batch scan.
**Fix:** cache a per-mesh boolean bumped on material change (like `materialDirty`); invalidate on material edits.

### P8 — atlas white-layer + DataView allocs
`new Uint8Array(W*H*4)` white fill (`:3729`) + `new DataView(data.buffer)` in full repack (`:3320`) allocate on each rebuild. Hoist to reusable scratch.

---

## Execution order (this effort)

**Batch 1 — safe perf wins (no behavior change):** P1 → P7 → P6 → P8 → P5(daytime zero-count skip). Each verified with typecheck + tests.

**Batch 2 — §5.2 prerequisite + generator invariants (§5.3):** promote duck-typed flags to typed fields; add `validateBodyResult()` + golden tests. This is the safety net for Part A.

**Batch 3 — first extraction pilot:** `Scene3DParticles` (proves the `ManagerContext` + narrow-host template), with a colocated mock-`ctx` test. Then HTML-textures, then re-evaluate scope with the user.

**Deferred to focused sessions (risk/size):** P2, P3, P4; the ShapeManager decals/GARP + live-text + persistence extractions; the armature tangle.

---

## Progress log

**2026-08-06 — Batch 1 (safe perf) + Batch 2 (safety net + pilot) landed. Typecheck clean, 757 tests (was 740).**

Perf:
- ✅ **P1** — `drawMeshes`/`drawSkinnedMeshes` gained `uploadUniforms = true`; `webgpu-renderer.draw3DMeshes` passes `false` to the skinned call when `drawMeshes` already ran → scene uniforms (light-select + shadow-center + light-space matrix + ~816 B write) upload once per frame in mixed scenes, not twice. Viewer/cloth-preview paths default to `true` (unchanged).
- ✅ **P5** — `_selectNearestPointLights` now clears `_pointLights` when candidate lamps go empty *and the selection was candidate-owned* (new `_lightsFromCandidates` flag; a direct `setPointLights` is left intact). Daytime → 0 point lights → the shader's `lightCounts.x`-bounded loop fully skips. Fixes latent stale-night-lamps-in-daytime retention.
- ✅ **P6** — `_selectNearestPointLights` selects the nearest-K by bounded insertion into a reused output array + parallel `_lightSelDist` buffer. No per-select `map`+`sort`+`slice`+`map`; O(n·K) not O(n log n).
- ✅ **P8** — atlas layer-0 white buffer reused across rebuilds via `_whiteLayerScratch` (per atlas size); the full-repack `DataView` cached in `_instanceDataView`, recreated only when `_instanceDataBuf` reallocates.
- ⏭️ **P7 — SKIPPED (deliberate).** `_usesPatterns` is 7 field reads; material is a plain object with no setter to hook, and `materialDirty`/`gpuDirty` clear mid-frame before the batch scan → no cheap bulletproof invalidation seam. A stale cache = wrong pipeline = visual bug. Not worth it (same honest call as §3.5). Value-key it only if a profile ever flags it.

Extraction safety net + pilot:
- ✅ **§5.3** — `src/services/managers/generator-invariants.ts` `validateSkinnedResult()` (stride, skinning sizing, finite geometry, weights→1, in-range joints/indices, non-degenerate bounds) + `generator-invariants.test.ts` (9 tests: 7 body-param extremes + explicit-default + a corruption-rejection guard). Pure, no GPU. Green before any extraction. *Follow-up:* clothing/hair invariants need a `BodyFit`/`HeadFrame` fixture.
- ✅ **Pilot** — `src/services/managers/scene3d-particles.ts` `Scene3DParticles` (add/remove/get/setConfig/getAll/registerRestored/dispose + tick lifetime), depends only on `ManagerContext`. Scene3DManager keeps thin delegators; public API + callers unchanged. `scene3d-particles.test.ts` (8 tests) drives it with a mock ctx — proving the isolation payoff. This establishes the reusable template for the next extractions (HTML-textures → Grease Pencil → …).

**2026-08-06 (cont.) — two more extractions. Typecheck clean, 771 tests (was 757).**
- ✅ **Scene3DHtmlTextures** (`scene3d-html-textures.ts`) — the HTML-in-Canvas / Canvas-2D texture subsystem (set/setCanvas/update/remove/has/dispose). FIRST to exercise the **narrow-host** half of the template: takes `ctx` + a `Scene3DHtmlTextureHost { getMesh, getRibbonData }` (2 lookups) instead of raw `this`. Manager keeps delegators; wires the host to `getMesh`/`getRibbonData3D`. `scene3d-html-textures.test.ts` (6 tests) pin the host-wiring + guard logic (missing mesh / no device / bad dims / update-remove-before-set) — the GPU upload path needs a real device.
- ✅ **Scene3DGreasePencil** (`scene3d-grease-pencil.ts`) — GP is ~1050 lines that split cleanly: the **data model** (objects/layers/strokes/keyframes/active-stroke cursor/render-order + JSON) is `ctx`-only and extracted here; the interactive **draw-mode controller** (`_gpDraw*`, pointer listeners, plane raycast, gizmo save/restore, face-select) legitimately couples to gizmo/pick/canvas and STAYS in the manager, driving the subsystem through its API. Manager keeps all public GP delegators. `scene3d-grease-pencil.test.ts` (8 tests, real SceneGraph) pin the stroke lifecycle + JSON round-trip.

**Extraction template now proven both ways:** `ctx`-only (Particles, GP-data), and `ctx` + narrow host (HtmlTextures). **Next candidates:** GP *draw-mode* controller (needs a broader host: getMesh/unproject/setGizmoMode/transform-controller/face-pick — its own careful pass), then Cloth (`_clothData` + live sim, tier-2, needs cloth-§5.2 first), Keyframes/NLA, Ribbon. ShapeManager side: Decals+GARP → existing GarpManager.

**2026-08-10 — cloth-§5.2 prerequisite + Scene3DBlendShapes. Typecheck clean, 778 tests (was 771).**
- ✅ **cloth-§5.2 (Cloth extraction prerequisite)** — `ClothMesh3D` gained typed `setClothConfig()` / `setLiveConfig()` (the ONE sanctioned write to the otherwise-`readonly` configs). The 11 `(node as any).clothConfig/.liveConfig = …` readonly-bypass casts in Scene3DManager are gone. Cloth is now compiler-safe to extract when its (larger, GPU-sim) session comes.
- ✅ **Scene3DBlendShapes** (`scene3d-blend-shapes.ts`, +7 tests) — blend-shape/morph-target ops. Owns NO map (state lives on the Mesh3D), so it's a cohesive OPERATION group taking `ctx` + a `{ getMesh }` host; the 3 GLB-import callers use `applyMorphTargets(mesh, targets)`. Fully unit-tested with a fake mesh (base-geometry capture, weight grow/reindex, clamping, evaluate/render side-effects) — no GPU.

**2026-08-10 (cont.) — Cloth extracted (the tier-2 move). Typecheck clean, 785 tests (was 778).**
- ✅ **Prerequisites**: relocated the 3 shared cloth helpers (`drapeStartY`/`resolveClothGeometry`/`applySimulatedPositions`) to `src/renderer/3d/cloth-mesh-helpers.ts` (imported by both the subsystem and the manager restore path); added typed `setPhysicsConfig`/`setSimState` to `ClothMesh3D` and removed the remaining ~6 `readonly`-bypass `as any` casts (replaceClothMesh/setClothConfig/setClothPhysics/clearClothStitches) — the cloth region is now fully de-`any`'d.
- ✅ **Scene3DCloth** (`scene3d-cloth.ts`, +7 tests) — ALL 38 cloth methods + the 5 state maps (`_clothData`/`_liveClothHandles`/`_previewRenderers`/`_stitchTool`/`_clothConfigTimers`) + the live-cloth tick moved out (~1050 lines). Takes `ctx` + a `Scene3DClothHost { getMesh, getFrameLinkAnim }` (FLA supplies the live 'wind'). Manager keeps a thin delegator for every public method; the restore path calls `registerGeometry()`. The GPU sim/preview isn't unit-testable (needs a device) → tests cover the CPU paths (create/config/geometry/wind-zones/vertex-slot/guards); **the sim/preview/stitch/live-edit paths MUST be browser-verified.**

**2026-08-10 (cont.) — Ribbon extracted. Typecheck clean, 792 tests (was 785).**
- ✅ **Scene3DRibbons** (`scene3d-ribbons.ts`, +7 tests) — all 20 ribbon methods + the data map + scroll counters + handle-drag depth cache + the camera-facing/scroll update tick (~460 lines). Takes `ctx` + a `Scene3DRibbonHost { createRibbonMesh, getMesh, getFrameLinkAnim, projectWorldToScreen3D, unprojectScreenToWorld3D }`. The FLA↔ribbon coupling was cut cleanly: the manager's `setFrameLinkAnimation3D` (scroll) / `removeFrameLinkAnimation3D` now call `startScrollAnimation()` / `clearScrollFrames()`, and the tick's scroll loop was inverted to iterate ribbons and read FLA per-mesh via the host (equivalent — scroll only affects ribbon meshes). Restore path calls `registerRibbon()` + `ensureTick()`. `nearestPow2` moved with `computeTextureSize`. Geometry rebuilds are pure CPU (tested); **browser-verify camera-facing ribbons, UV scroll, and handle dragging** (camera/projection dependent).

**Extraction scope note:** remaining big subsystems — the GP **draw-mode** controller (gizmo + pointer listeners + face raycast), and the **armature/gizmo/skeleton/weight-paint tangle** — are dedicated-session moves that want browser verification. FLA (rest-transform apply) is still interwoven with the keyframe apply loop → not independently extractable.

**Deferred cloth-§5.2 note:** the remaining `(node as any).clothConfig/.liveConfig` writes (11 sites) mutate `readonly` fields on `ClothMesh3D` through a base-`Mesh3D`-typed var. That's genuinely prerequisite when **cloth** is extracted (a tier-2 target) — do it then via typed `setClothConfig`/`setLiveConfig` methods, not now.

---

**2026-08-17 — Async document restore (Part B perf; the load-freeze win). Typecheck clean, 511 world+manager tests green.**

*Measured first (three rounds of flag-gated instrumentation, not guessed):* a city-doc load spent **558ms**, of which `restoreProceduralFromSave3D` = **553ms**, and within that `world.restoreFromSave()` → `generateWorld()` = **549ms**. Per-phase split: `World Streets` **270ms** + `World Furniture` **109ms** dominated; **`generateLayout` only 58ms** (11%). Workers available (`workers=true`). Key correction to the earlier assumption: the neighbor **tiles already build async**; the freeze is the synchronous **centre** build. "Yield between creators" was the wrong lever (creators were 0; it's one 549ms call).
- ✅ **Routed load through the existing worker regen.** `WorldManager.restoreFromSave()` now calls `_startAsyncFull(wp.params, 'load')` for **non-tiled** cities instead of synchronous `generateWorld`: the whole city (layout + every group + drape) generates OFF-THREAD in the tile worker, the main thread only reassembles time-sliced, and the city reveals via `_finishAsync`. **Result: main-thread load 558ms → 9ms (~60×); `city(sync centre)` 549ms → 4ms.** Browser-verified (renders/position/reload/lighting OK; progressive city pop-in accepted).
- **Why it's safe** (the subtleties that made it viable, all verified): container adoption reuses the same `_addStaged`→`_ensureCityContainer()`→`findExistingCityContainer()` path as sync (adopts the restored "City" marker; transform re-applied via `_applyCityTransform`); the build runs AFTER `restoreDocumentState` returns + clears `_isRestoring`, so **no re-entrancy window** (sidesteps the whole "make regen async with yields" hazard); the **params-only** City marker means a mid-build autosave still serializes correctly. **TILED stays sync** (needs `_syncNeighborTiles`, which the async path doesn't drive); **headless** has no rAF so `_startAsyncFull` builds synchronously anyway.
- **Preserved behavior:** `_finishAsync` auto-applies `_timeOfDay` to GLOBAL lighting, but the sync restore deliberately only STORES the loaded city's lighting (don't stomp host lighting on reopen). One-shot `_suppressNextFinishLighting` (set after `_startAsyncFull` in the load path; cleared in `_finishAsync`/`_abortAsync`) keeps that.
- ✅ **Diagnostics kept, gated.** `src/services/debug-log.ts` — `debugFlags.enableConsoleDebug` (+ `setConsoleDebug()`, `debugLog()`); the `generateWorld` and `restoreProceduralFromSave3D` timing breakdowns route through it. **OFF by default.** Timing always computed (negligible); only the log is gated.
- ✅ **Host signal for a load-progress UI.** `WorldManager.onCityBuildStateChange` (`EventEmitter<{building, reason:'load'|'edit'}>`) + `isBuildingCity()` fire on async build start/settle (transitions only; supersede stays 'building'; abort clears). Frogmarks can bind a small non-blocking "Building city…" pill to it (the pill itself is host-side UI, not built here). Doubles as the "engine is busy" signal the future SceneAuthoringAPI will want.
