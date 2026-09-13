# Salsa — Architecture Review & Work List

**Produced 2026-08-17** by a 5-agent parallel audit (ShapeManager · Scene3DManager+siblings · Renderer · World+Packaging+SceneGraph · repo-wide tech-debt + new-code verification), synthesized + cross-checked. This is the durable record — the **Work List (§4)** is what we execute from. Line citations are against the tree as of this date; re-grep before editing (files shift).

---

## 0. Verdict (TL;DR)

**The library is in genuinely good shape — cleaner than most codebases this size — and NO major re-architecture is needed.** Engineering discipline is unusually high:
- **0 `@ts-ignore`/`@ts-expect-error` across all ~154k lines / 395 files.**
- **~9 TODOs total** (most benign header/section notes), **0 real FIXME/HACK**.
- Every `as any` (~575) is a **bounded boundary cast** (JSON deserialize, gl-matrix `.d.ts` gaps, optional-method probing), not lazy typing.
- The core **"params → geometry → params-only persistence"** thesis is implemented consistently end-to-end.
- A debt item the specs kept flagging — duck-typed `.isProceduralBody`/`.isClothing`/`.isFaceDecal` mesh flags — is **ALREADY RETIRED** (real typed fields at `mesh-3d.ts:151-163`, confirmed by 3 of 5 audits). Close that item everywhere it's still listed as open.

What's left is **incremental**: continue the proven decomposition pattern into new areas (now the **renderer**), and fix a handful of concrete bugs/leaks (§4.A–B).

**Scale snapshot:** ~154k LOC, 395 source files, 89 test files (~860 `it`/`test` blocks). Deps minimal (`gl-matrix`, `fflate`, wasm). Single `tsconfig.json` (`strict`, `include:["src"]`) so `npm run build` (`tsc && vite build`) typechecks tests too.

---

## 1. Architecture overview

Layered engine, dependency direction leaves → core → facade → host:

```
Frogmarks (Angular host)
        │ calls
   ShapeManager (facade, 13,058 ln) ──► SceneAuthoringAPI (the stable AI/programmatic surface)
        │ delegates                          └─ scene-authoring-tools (JSON-schema + dispatcher)
        │                                     └─ scene-authoring-session (transport-agnostic agentic loop)
   ┌────┴───────────────────────────────────────────────┐
   Scene3DManager (7,701) · WorldManager (3,115) · RasterManager · TextManager · PackagingManager (1,825)
        │ each takes ManagerContext + a narrow host
   ┌────┴────┐
   ~20 scene3d-* siblings (~9,600 ln) · src/world generators (pure) · src/packaging templates (pure)
        │
   Scene Graph (Node → Shape → Mesh3D) · Renderer (WebGPU: webgpu-renderer 5,034 · renderer-3d 4,544)
```

**Three patterns define the codebase — all sound:**
1. **DI spine — `ManagerContext` + narrow hosts.** Each subsystem gets one shared infra bag (`manager-context.ts:19-45`: sceneGraph/renderer/interactionService/scheduleRender…) + a *small per-subsystem host of just the closures it needs*. Breaks the manager→facade cycle. Audits found **no runtime circular deps between siblings**, only type-only cross-refs.
2. **"Params → geometry," persisted as params-only markers.** Generators are pure `params → geometry`; the scene persists only params (a lightweight marker), geometry regenerates on load (`world-manager.ts:723-746`, `packaging-manager.ts:145`, `mesh-3d.ts:119` `excludeFromDocument`). This is why AI-authored content gets free save/reload.
3. **Extraction-behind-verbatim-bridges.** God-object decomposition moves method bodies *byte-for-byte* into siblings behind getter "bridges" (`ctx` + host), preserving behavior at low risk. This session added 5 (ephemera-overlay, live-text-manager, decal-manager, packaging-composite, shape-serializer), each with a CPU-safe test.

---

## 2. Health by layer

| Layer | Verdict | Notes |
|---|---|---|
| `src/world` generators | 🟢 Excellent | Pure, uniform signatures, deterministic (test-pinned `biome-idempotency.test.ts`), 0 debt markers, 0 `as any` |
| `src/packaging` | 🟢 Very good | Cleanly layered, feature-flagged/tree-shakeable, exceptional test density |
| `src/scene-graph` | 🟢 Good | Clean `Node→Shape→Mesh3D`, tuned-under-load base, 11 casts (mostly intentional cycle-avoidance `node.ts:58-64`) |
| Scene3DManager + 20 siblings | 🟢 Sound | Down to **7,701** (was ~12k); clean boundaries, type-only cross-refs; armature "tangle" well-contained in `scene3d-armature.ts` (2,672) |
| ShapeManager (facade) | 🟡 Improved, still large | 13,058 ln / ~1,160 methods, but ~half are thin delegators (`this.scene3d.` ×650); `SceneAuthoringAPI` is the right long-term surface |
| WorldManager (bridge) | 🟡 Needs decomposition | 3,115 ln fusing ~17 responsibilities — the world domain's mini-god-object |
| Renderer (`src/renderer`) | 🟡 Good but undivided | Disciplined WebGPU resource caching, but two 5k/4.5k god-objects + `raster-texture-manager` dup, and **no decomposition plan started** |

**The structural finding:** decomposition **RELOCATED** the god-object mass rather than dissolving it — and it's now moved *past the service layer into the renderer*. `webgpu-renderer.ts` (5k: render loop + ALL 2D input + 2D/3D compositor + text previews) and `renderer-3d.ts` (4.5k: three ~500–860-line upload/draw methods) are the biggest single-file concentrations, with no started extraction plan. **That's the highest-ROI place to point the same `ManagerContext` template next.**

---

## 3. Already fixed (this session, during the audit)
- ✅ **`applyScenePlan` didn't await async ops** — plan verbs `addCharacter`/`screenshot`/stamp left unresolved Promises + `endBatch` closed before completion. Now an async loop awaiting each op (`scene-authoring-tools.ts`, +test).
- ✅ **`screenshot` dead `height` param** — schema/dispatch/API mismatch; now `maxWidth` only.

---

## 4. WORK LIST

Effort: **S** ≤ half-day · **M** ~1 day · **L** dedicated session(s). Browser-gated = can't unit-test, needs manual verify.

### A. Correctness / hygiene (do first — small, high-value)

> **2026-09-08 status pass:** A1–A4 + B2 + B4(scanlineFill) were found ALREADY FIXED in the code (done in prior
> sessions; boxes never ticked). This session added: B4(applyColorMapping → one shared WGSL const), D1 (15 casts
> removed — the helper was already typed), D2 (casts removed + **fixed a latent bug**: `(service as any).engine`
> never existed, so flood fill silently IGNORED the active selection mask — now a real
> `RasterSelectionService.getMaskTexture()`), D4. **E4 re-scoped → won't-fix:** the offscreen→swapchain copy is no
> longer a thumbnail luxury — it IS the present step (post-process input, capture mode, transparent export, and
> post-process-immune overlays all build on `lastFrameTex`); removing it would re-plumb 4 features to save one blit.
- [x] **A1 · Latent WebGPU crash — brush `pingTex` usage flags.** `BrushStampPipeline.pingTex` is reused across paths needing different usage: wet-stroke allocs `TEXTURE_BINDING|COPY_DST` (`brush-stamp-pipeline.ts:445,485`) but `applyBleed` binds it as a write storage texture and only adds `STORAGE_BINDING` when *it* allocates (`:811`); reuse is gated on size only → a bleed after a same-size wet dab reuses a texture lacking `STORAGE_BINDING` → validation error. **Fix:** allocate `pingTex` with `STORAGE_BINDING` unconditionally (or a dedicated storage ping). **[S · only crash-class bug found]**
- [x] **A2 · `debugSnapshots = true` default** (`raster-texture-manager.ts:20`) → `console.log` spam on every snapshot/undo/redo in prod. Flip off. **[trivial]**
- [x] **A3 · `destroy()` leaks** — `RasterCompositor` never frees `_onionPingTex`/`_baseOpacityBuf` (`raster-compositor.ts:448-458`); `TextEffectEngine.destroy()` frees only `paramBuf`, leaking `customParamBuf` + cached textures. **[S]**
- [x] **A4 · Compositor sync/async dither divergence** — `composite()` silently skips error-diffusion dither while `compositeAsync()` honors it (`raster-compositor.ts:524`); same scene renders differently by path. Reconcile. **[S · correctness]**

### B. Dead code / duplication (mechanical wins)
- [x] **B1 · DONE 2026-09-11** — raster-texture-manager 649→286 lines: snapshot stack now DELEGATES to `RasterSnapshotManager` (single source of truth; new optional `resize` hook on undo/redo preserves the ensureTexture-on-restore behavior for snapshots that predate a doc resize); the legacy compute brush moved verbatim to `brushes/legacy-brush-stamp.ts` (fallback-only, clearly marked — reachable solely via dispatchGpuBrush←stampAtLegacy when the paint engine is uninitialized; NOT deleted because uploadRasterCanvas can create the manager engine-less). Pixel-verified in the harness: legacy dab → snapshot → 2nd dab → undo removes only the 2nd → redo restores; 0 GPU errors. Original item: **`raster-texture-manager.ts` carries a SECOND live copy** of both the brush compute shader (`:30-240`, superseded by `BrushStampPipeline`) and the undo-snapshot stack (`:314-505`, duplicates `RasterSnapshotManager`). Delete + route through the extracted classes (~40% file shrink). **[M]**
- [x] **B2 · Four hand-synced build-order lists** — `WorldManager.BUILD_ORDER`, `centre-build.ts` `CENTRE_BUILD_ORDER`, `tile-build.ts` `TILE_BUILD_ORDER`, `generateStreets`. Already shipped a drift bug (streamed tiles dropped `'World Road Signs'`); `build-order.test.ts` guards the symptom. **Fix:** one exported `CANONICAL_BUILD_ORDER` in `src/world/` all four import (with per-context filters). **[S · high safety]**
- [x] **B3 · DONE 2026-09-11** — `extrudeJoint3D` deleted at all 3 layers (Frogmarks verified: uses `enterBonePlacementMode3D`). `getClothVertexIndex`/`getClothVertexSlot` KEPT — Frogmarks `cloth-builder.component.ts` still calls both (noted at the @deprecated site). Original item: **Delete deprecated aliases once no callers** — `extrudeJoint3D` (`scene3d-manager.ts:4686`, exact dup of `enterBonePlacementMode3D`), `getClothVertexSlot` (`:7451`). **[trivial]**
- [x] **B4 · Consolidate duplicated helpers** — `scanlineFill` (identical in flood-fill + selection-mask); `applyColorMapping` WGSL copy-pasted into all 4 dither shaders. **[M]**

### C. Continue decomposition (proven `ManagerContext` + narrow-host pattern)
- [ ] **C1 · RECON DONE 2026-09-12 (no code moved)** — full extraction map at `docs/specs/render-layer-extraction-map.md`: pointer handlers = 1,280 ln / 57 couplings (interactionService ×78, mode ×61 → per-mode strategy is the slice-2 design call); renderer-3d mega-methods sized (drawMeshes ~900 / uploadSceneUniforms ~420 / uploadMeshInstances ~1,080 = last). Session order + per-slice verification plan in the map. THE most user-facing code in the engine — dedicated sessions with in-app passes, not overnight work. Original item: **RENDER LAYER (new frontier, no plan started — highest structural ROI).** Carve 2D input out of `webgpu-renderer.ts` → a `RasterInteractionController` (`handlePointerDown` 963-1334, `handlePointerMove` 1531-1995, `handlePointerUp` 2036+). Split `renderer-3d.ts` mega-methods (`drawMeshes` 1719-2420, `uploadSceneUniforms` 2753-3174, `uploadMeshInstances` 3174-4036). **[L]**
- [x] **C2 · DONE 2026-09-11** — `src/services/persistence/document-state-coordinator.ts` (~690 lines): gatherDocumentState + restoreDocumentState moved VERBATIM (deterministic string-transform; zero unmapped couplings) — reaches facade publics via a type-only `sm` and privates via a 21-hook `DocumentStatePrivate` bag (note: `packagingIfCreated()` NOT the public getter — that lazily constructs packaging, which a routine save must never trigger). `recreateNode` (3D/Group cases) moved to shape-serializer.ts beside recreate2DShape (Shape2DRestoreDeps already carried everything). ShapeManager 14,511→13,797. Harness round-trip verified: Path anchors exact, skinned bind + skeleton + layers + docSize all restored. ✅ LATENT BUG FIXED same day: recreateNode now SKIPS 'SkinnedMesh3D'/'Skeleton3D' entries (returns null; callers filter) — the scene3d pass owns rebuilding those with GPU state; the old default-case placeholder Nodes accumulated one per save/reload cycle. Harness-verified stable across two reload cycles. Original item: **Finish the serializer split** — `recreate2DShape` was extracted; the 3D `recreateNode` (`shape-manager.ts:~10563`) + `gatherDocumentState` (`~12093`) + `restoreDocumentState` (`~12275`) (~1,150 ln) remain inline → `DocumentSerializer`/`DocumentStateCoordinator`. Biggest mechanical win left in ShapeManager, but restore-critical + browser-gated. **[L]**
- [ ] **C3 · `WorldManager` (3,115, ~17 responsibilities).** ✅ FIRST CUT DONE 2026-09-11: the pure canvas painting → `src/world/landmark-card.ts` (drawLandmarkCard/drawLandmarkPill/wrapText/roundRectPath + LM_TAGLINE + CARD3D_RADIUS_PX, 6 tests); WorldManager keeps mesh lifecycle/animation. ✅ SECOND CUT 2026-09-11: day/night LIGHTING MATH → pure `src/world/day-night.ts` (computeDayNight + skyAt + DEFAULT_SKY + SkyKey/TimeGradePhase types, 8 tests — sun sweep/dusk gaussian/weather/flash/fog/lamp curves now unit-tested); WorldManager keeps application (setDirectionalLight/fog/lamps/glow/grade) + tickers; types re-exported for host compat. WorldManager 2,943 lines. Remaining: traffic sim, streaming, day-night ticker. Original first-cut note: landmark hover-card canvas renderer (`world-manager.ts:1731-2113`, ~380 ln pure `CanvasRenderingContext2D`, zero cross-state) → `LandmarkCardRenderer`. Then day/night (`:2114`), traffic sim (`:2265`), streaming (`:375`). **[L]**
- [x] **C4 · COMPLETE 2026-09-12 (all four slices)** — `scene3d-animation.ts` (14th extraction): AnimationPlayer + skeleton-clip playback + full NLA (~200 ln, 3 tests). 🐛 Fixed 2 latent NLA bugs found in recon: Skeleton3D.toJSON DROPPED nlaTracks (persistence never worked despite the code comment) + nothing re-seeded the registry on load — now serialized (nlaTracks + nlaBindPose on SkeletonData) with LAZY re-seed on first NLA access (no restore-ordering coupling); round-trip tested. Slice D also DONE (default anims + pose library + pose/body export, 6 more host hooks, +3 tests; scene3d-animation.ts now ~543 ln, manager 8,016). Slice B also DONE (FLA CRUD + config/rest maps into the subsystem; the 4 readers — keyframe-apply, cloth, ribbons, armature host — rewired to public map getters; harness-smoked spin/bob/remove). Slice C also DONE: the idle/breaks/squash/leg engine moved with tick order intact (idle→squash→foot-IK×2→springs inside the one callback); the cooperative live-rAF cohort (idle + focus-bg holds) STAYS on the manager, flipped via a setIdleLiveHold hook; the ghost body preview reuses public applyIdle + exported IDLE_JOINTS. Harness-verified live (chest breathes, squash scales, off restores base exactly). scene3d-animation.ts = 994 lines (players/NLA/FLA/defaults/poses/idle); scene3d-manager 7,626 (was ~15.3k). USER: eyeball a character idle + breaks + squash in-app when convenient. Original item: **Scene3D animation cluster → `scene3d-animation.ts`.** Keyframe/FLA/NLA/player/skeleton-anim (`scene3d-manager.ts:5859-6390`) + idle/squash-stretch (`653-1033`) + default-anims/pose-library (`6880-7701`), ~1,500 ln + ~10 state maps (`_nlaTracks/_nlaPlayers/_frameLinkAnims3D/_idleRigs/_squashStretch/…`). Largest remaining non-facade block. **[L]**
- [x] **C5 · DONE 2026-09-11** — `scene3d-kitbash.ts` (13th extraction): kitbash library + createCharacter/swap/recolor/remove + character registry save/restore + baked-part store + spawn spin, VERBATIM via ManagerContext + narrow host (shared GLB/skeleton helpers `_createSkeletonFromResult`/`_createSkinnedMeshForSlot` + `_modelStore` STAY on the manager, host-hooked — the procedural-body path uses them too). Manager 8,404 lines. 4 unit tests; harness-verified registry/catalog/procedural paths (spawn-spin freeze in the harness proven PRE-EXISTING via stash A/B). GLB kitbash flow itself needs Frogmarks assets — spot-check there. Original item: **Scene3D kitbash/character-assembly** (`createCharacter` `scene3d-manager.ts:2863-3773`, ~600 ln + `_kitbashLibrary/_bakedParts/_spawnSpins/_characterMap`) → `scene3d-kitbash.ts` or fold into `scene3d-character.ts`. **[M]**
- [ ] **C6 · Packaging host contract** (`shape-manager.ts:~4021-4805`, ~750 ln `PackagingHost` literal) → move beside `PackagingManager`/`PackagingComposite`; facade keeps a thin delegator. **[M]**
- [ ] **C7 · UV-paint session** (`shape-manager.ts:~6342-6730` + 8 shared fields `:200-224` + shared `_uvPaintController` juggled across character/packaging/mesh) → `UVPaintSessionController`. This is UVPaint "Step 3" we deferred; **Step 2 (packaging dep-inversion) is already done**, so the packaging entanglement is already broken. **[M · browser-gated]**
- [x] **C8 · DONE 2026-09-11** — `createEmptySkeleton3D`/`addBone3D`/`bindMeshToSkeleton3D` moved verbatim into `Scene3DArmature`; manager keeps 1-line delegators; harness-verified (box→skeleton→bind→pose renders skinned). Original item: **Finish split skeleton-authoring region** (`scene3d-manager.ts:6401-6879`) — ~6 stragglers (`createEmptySkeleton3D`, `addBone3D`, `bindMeshToSkeleton3D`) still inline while 18 delegate to `_armature`. Move the stragglers so the boundary is uniform. **[S]**

### D. Type cleanups (low effort, remove risky casts)
- [x] **D1 · Type `removeZonelessListener`'s options param** → kills ~11 `{capture:true} as any` casts (`scene3d-manager.ts`, `scene3d-surface-paint.ts`, `scene3d-armature.ts`). One helper-signature fix. **[S]**
- [x] **D2 · Type the renderer raster-undo surface** — `(webgpuRenderer as any).rasterUndo/rasterRedo/rasterPushSnapshot` (`shape-manager.ts:1295,1308,1319`) + selection-engine mask cast (`:1066,1161`). **[S]**
- [x] **D3 · DONE 2026-09-11** — webgpu-renderer duck-casts retired via `instanceof SDFText/Shape/Group` (SDFText atlas collect is now `SDFText[]`; ancestor helpers, bake-scale, setFromLocalMatrix use base Node accessors). Original item: **Typed scene-graph-node interface** → retire ~22 duck-typed `(n as any).getType?.()/.refreshText?.()/.markDirty?.()` in `webgpu-renderer.ts` (2745-2790, 4670-4738). **[M]**
- [x] **D4 · Legacy 2D-shape color accessors** (`shape-manager.ts:2592-2609`) → a small `ColoredShape` interface; + `var`→`const` (`:2615,2625,2635`). **[S]**
- [x] **D5 · DONE 2026-09-11** — armature/IK is cast-free: solver files already had 0 `as any` (audit predated D1); the 5 left in scene3d-armature fixed (public `getSwapChainFormat()`, per-mode `Partial<ArrayParams>` patches, `setGizmoRenderer(undefined)` signature). shape-manager's updateArrayParams3D cast narrowed to the union. Original item: **Type the armature/IK subsystem** (`scene3d-armature.ts`, `constraint-solver.ts`, `ik-solver.ts`, `skeleton-animator.ts`) — the densest `as any` region in the engine. **[M]**

### E. Deferred perf (scoped in `god-objects-and-perf.md`)
- [ ] **E1 · P2** — batch/instance skinned character parts (close-up/crowd bottleneck; they also cast no shadow/AO). **[L]**
- [x] **E2 · DONE (a+c) 2026-09-12** — (a) outline + shadow + SSAO/SSR pre-passes now record into ONE lazily-created encoder, submitted once before the main pass (harness-measured 4 → 2 submits/frame with all three on; in-buffer order matches the old submit order). (c) the geometry-key + contiguous-slot batched RUN LIST is computed once per frame (`passRuns`) and replayed by all pre-passes (`replayRuns`) — it was recomputed inline by shadow AND SSAO, and the outline pass drew per-entry unbatched (its opaque walk is now batched too = fewer draws). 🐛 BONUS pre-existing bug found+fixed en route: OutlinePass's composite pipeline lacked a depthStencil state vs the main pass's depth24plus-stencil8 → validation error DISCARDED the whole frame submit whenever whole-scene outlines were enabled (outlines now render; overlay semantics depthWrite:false/compare:'always'). REMAINING TAIL (b): share ONE depth-normal render between the outline + SSAO prepasses when both are on — divergences to reconcile first (outline includes TRANSPARENTS, different clear values/attachment sets); win limited to the both-on case. Shadow's render is irreducible (different camera). Original item: **P3** — share ONE depth prepass across shadow/SSAO/outline (currently 4 full-geometry passes, separate submits). **[L]**
- [x] **E3 · DONE 2026-09-12** — incremental texture atlas (`Renderer3D._syncAtlas`): grow-only array texture with 1.5× layer headroom (cap 256), STABLE layer indices for the texture's life (instance records stay valid), copy ONLY new libIds + layers whose source changed (texture-swap via identity, in-place paint via the owning mesh's gpuDirty), white layer 0 written once per allocation, bind group rebound only on structural realloc; vanished libIds park dead layers till the next structural rebuild (the geometry-pool policy). `_perf.atlasRebuilds` now counts STRUCTURAL rebuilds only. Harness-verified: 2-texture build = 1 rebuild; in-place green repaint → 0 new rebuilds, indices stable, change visible on screen; 3rd texture appended incrementally (layer 3); 0 GPU errors. Original item: **P4** — incremental texture-atlas (copy only the changed layer) instead of full rebuild on any paint edit. **[M]**
- [x] **E4 · Per-frame full-screen thumbnail copy** in `render()` (`webgpu-renderer.ts:2846-2847,3402`) — `copyTextureToTexture`→swapchain every frame just to persist a thumbnail source. Make it on-demand/throttled. **[S]**
- [x] **E5 · DONE 2026-09-11** — (1) brush-stamp-pipeline: copy+stamp+(bleed)+composite per dab now record into ONE encoder/submit (was 3-4 submits; harness-measured 0.9 submits/dab incl. spacing skips) via stampRecord/bleedRecord/compositeRecord; composite + bleed bind groups cached on texture identity (were rebuilt with fresh createViews per dab). (2) raster-compositor: per-layer blend step = one submit (copy+compute merged) with a WeakMap-cached {per-layer uniform buffer + bind group} — each layer owns its buffer so batching can't race the old shared paramsBuf. (3) snapshot dedup compare: 8-bytes-per-step Float64-view equality (full scan only on the no-op-stroke dedup case; NaN-word fallback keeps it exact). Wet-stroke no-buildup verified EXACT (single 50% dab = 204 alpha, 12 overlapping = 204, cross-stroke stacking preserved); paint/undo pixel-verified; 0 GPU errors. NOT done (future): dirty-rect snapshots to shrink the endStroke full-canvas readback itself. Original item: **Raster per-dab submit storm** (`brush-stamp-pipeline.ts:336-367,415,462,589` — 3 submits + 6 writeBuffer/dab), compositor per-frame bind-group/`createView` rebuild (`raster-compositor.ts:321-329`), full-canvas readback + O(w·h) CPU compare on every `endStroke` (`raster-snapshot-manager.ts:78-90`). **[M]**

### Not recommended
Touching `edit-mesh.ts` (2,103 — half-edge modeling kernel) or `live-text.ts` (1,099) for size alone — cohesive single-responsibility, not god-objects.

---

## 5. Audit detail (preserve the specifics)

### 5.1 ShapeManager
13,058 ln, ~1,160 public methods, singleton. DI clean (ManagerContext + narrow-host bags for the new extractions: EphemeraOverlay `:414`, LiveTextManager `:421`, DecalManager `:427`, PackagingComposite `:592`). Older creators (WorldManager, 11 procedural creators `:442-453`) take `this.scene3d` directly (pre-ManagerContext convention). `this.scene3d.` ×650; ~454 one-line delegators. Still-inline subsystems (extraction candidates): Packaging host (`~4021-4805`, ~750), GARP (`~5202-5835`, ~630), UV paint (`~6342-6730`, ~700), Text-effects wrappers (`~9339-9804`, ~465), Image import (`~10337-10800`, ~460), Document persistence (`recreateNode`+`gather/restore`, `~11537-12695`, ~1,150). Casts: 43 `as any` + 27 `as unknown as` (mostly `window as unknown as` dev-harness hooks), 0 `@ts-ignore`. 3 `var` (`:2615/2625/2635`).

### 5.2 Scene3DManager + siblings
7,701 ln (was ~12k). ~180 one-line delegators; 20 siblings ~9,600 ln (armature 2,672 · character 1,566 · cloth 833 · array-bake 511 · ribbons 492 · arrays 385 · grouping 297 · weight-paint 296 · textures 261 · keyframes 257 · import 246 · grease-pencil 234 · surface-paint 232 · html-textures 179 · primitives 142 · materials 109 · particles 104 · modifiers 81 · blend-shapes 78). No runtime circular deps; armature imports Character/WeightPaint as **type-only** + gets live instances via host. Remaining inline non-facade clusters: **animation orchestration** (~1,500 ln, ~10 state maps) and **kitbash/body-assembly** (~600 ln) — the two extraction candidates. 25 `as any` (dominant: `{capture:true} as any` ×11). 1 TODO (`:1896`). Deprecated: `extrudeJoint3D` (:4686), `getClothVertexSlot` (:7451).

### 5.3 Renderer
~55.5k ln / 130 files. God-objects: `webgpu-renderer.ts` (5,034 — render loop + all 2D input + 2D/3D compositor + text previews), `renderer-3d.ts` (4,544 — `uploadMeshInstances` alone ~860 ln). Best-designed: `pipeline-3d.ts` (798, lazy+`warmAllAsync` 3D pipeline cache — the warmup fix). Disciplined caching (per-mesh texture BGs validated on identity `:1313-1336`, shared skin BGs, only 3 `createView()` total, none per-frame; `uploadMeshInstances` dirty-flag fast path `:3222`). **Unhealthy file:** `raster-texture-manager.ts` (dup brush shader `:30-240` + dup snapshot stack `:314-505`). RasterCompositor = mini-god-object with hand-synced `composite`/`compositeAsync`. 58 `as any` (22 in webgpu-renderer node-probing). WGSL: `mesh3d-shaders.ts:2566` string-marker assembly ("drifted?" fragility), hardcoded loop bounds diverging from uniforms (`text-effect-engine.ts:1137` clamp 64, `raster-compositor.ts:981` 4 octaves). Bugs → §4.A/E.

### 5.4 World + Packaging + Scene-Graph
World generators: pure/uniform (`build*(graph, keep?) → LayoutPreviewLayer[]`), deterministic (position-hash RNG, `biome-idempotency.test.ts`), 0 debt/0 `as any`. Bridge `world-manager.ts` (3,115) = the debt (§4.C3). Build-order dup = §4.B2. Packaging: cleanly layered (types → mechanisms → templates → box-hierarchy → manager → composite), feature-flagged, heavy tests. Scene-graph: clean `Node(414)→Shape→Mesh3D(:84)`, tuned base (shared scratch vecs, warm id registry), 11 `as any` (mostly intentional cycle-avoidance `node.ts:58-64`). Unbuilt specs in-domain: instancing-blocks (perf foundation), occlusion-culling, spatial-streaming disposal (partial), foliage-generator, packaging PDF export.

### 5.5 New authoring layer (verified sound)
`scene-authoring-api.ts` (thin façade, IDs out, gotchas normalized), `scene-authoring-tools.ts` (declarative tools + dispatcher, schema↔dispatcher parity test), `scene-authoring-session.ts` (transport-agnostic loop, screenshot-as-image, turn cap, tool-error-as-`is_error`). Extractions (decal/livetext/ephemera/composite/serializer) follow the pattern precisely (ctx + documented `*Host` + verbatim bridges). The 2 bugs found → fixed (§3).

---

## 6. Strengths to preserve (do NOT "clean up")
Lazy+async 3D pipeline cache (`pipeline-3d.ts`); dirty-flag fast paths in `uploadMeshInstances`; per-mesh/per-skeleton bind-group caches; the tuned scene-graph base; the pure-generator "params→geometry" boundary (core never imports the generation modules); params-only persistence; the ManagerContext + narrow-host DI; near-total absence of suppression comments/dead code; single strict tsconfig that typechecks tests. The `SceneAuthoringAPI` thin-façade is the sanctioned stable surface — grow it, treat the raw 1,160-method facade as internal.
