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
- [ ] **A1 · Latent WebGPU crash — brush `pingTex` usage flags.** `BrushStampPipeline.pingTex` is reused across paths needing different usage: wet-stroke allocs `TEXTURE_BINDING|COPY_DST` (`brush-stamp-pipeline.ts:445,485`) but `applyBleed` binds it as a write storage texture and only adds `STORAGE_BINDING` when *it* allocates (`:811`); reuse is gated on size only → a bleed after a same-size wet dab reuses a texture lacking `STORAGE_BINDING` → validation error. **Fix:** allocate `pingTex` with `STORAGE_BINDING` unconditionally (or a dedicated storage ping). **[S · only crash-class bug found]**
- [ ] **A2 · `debugSnapshots = true` default** (`raster-texture-manager.ts:20`) → `console.log` spam on every snapshot/undo/redo in prod. Flip off. **[trivial]**
- [ ] **A3 · `destroy()` leaks** — `RasterCompositor` never frees `_onionPingTex`/`_baseOpacityBuf` (`raster-compositor.ts:448-458`); `TextEffectEngine.destroy()` frees only `paramBuf`, leaking `customParamBuf` + cached textures. **[S]**
- [ ] **A4 · Compositor sync/async dither divergence** — `composite()` silently skips error-diffusion dither while `compositeAsync()` honors it (`raster-compositor.ts:524`); same scene renders differently by path. Reconcile. **[S · correctness]**

### B. Dead code / duplication (mechanical wins)
- [ ] **B1 · `raster-texture-manager.ts` carries a SECOND live copy** of both the brush compute shader (`:30-240`, superseded by `BrushStampPipeline`) and the undo-snapshot stack (`:314-505`, duplicates `RasterSnapshotManager`). Delete + route through the extracted classes (~40% file shrink). **[M]**
- [ ] **B2 · Four hand-synced build-order lists** — `WorldManager.BUILD_ORDER`, `centre-build.ts` `CENTRE_BUILD_ORDER`, `tile-build.ts` `TILE_BUILD_ORDER`, `generateStreets`. Already shipped a drift bug (streamed tiles dropped `'World Road Signs'`); `build-order.test.ts` guards the symptom. **Fix:** one exported `CANONICAL_BUILD_ORDER` in `src/world/` all four import (with per-context filters). **[S · high safety]**
- [ ] **B3 · Delete deprecated aliases once no callers** — `extrudeJoint3D` (`scene3d-manager.ts:4686`, exact dup of `enterBonePlacementMode3D`), `getClothVertexSlot` (`:7451`). **[trivial]**
- [ ] **B4 · Consolidate duplicated helpers** — `scanlineFill` (identical in flood-fill + selection-mask); `applyColorMapping` WGSL copy-pasted into all 4 dither shaders. **[M]**

### C. Continue decomposition (proven `ManagerContext` + narrow-host pattern)
- [ ] **C1 · RENDER LAYER (new frontier, no plan started — highest structural ROI).** Carve 2D input out of `webgpu-renderer.ts` → a `RasterInteractionController` (`handlePointerDown` 963-1334, `handlePointerMove` 1531-1995, `handlePointerUp` 2036+). Split `renderer-3d.ts` mega-methods (`drawMeshes` 1719-2420, `uploadSceneUniforms` 2753-3174, `uploadMeshInstances` 3174-4036). **[L]**
- [ ] **C2 · Finish the serializer split** — `recreate2DShape` was extracted; the 3D `recreateNode` (`shape-manager.ts:~10563`) + `gatherDocumentState` (`~12093`) + `restoreDocumentState` (`~12275`) (~1,150 ln) remain inline → `DocumentSerializer`/`DocumentStateCoordinator`. Biggest mechanical win left in ShapeManager, but restore-critical + browser-gated. **[L]**
- [ ] **C3 · `WorldManager` (3,115, ~17 responsibilities).** First cut = landmark hover-card canvas renderer (`world-manager.ts:1731-2113`, ~380 ln pure `CanvasRenderingContext2D`, zero cross-state) → `LandmarkCardRenderer`. Then day/night (`:2114`), traffic sim (`:2265`), streaming (`:375`). **[L]**
- [ ] **C4 · Scene3D animation cluster → `scene3d-animation.ts`.** Keyframe/FLA/NLA/player/skeleton-anim (`scene3d-manager.ts:5859-6390`) + idle/squash-stretch (`653-1033`) + default-anims/pose-library (`6880-7701`), ~1,500 ln + ~10 state maps (`_nlaTracks/_nlaPlayers/_frameLinkAnims3D/_idleRigs/_squashStretch/…`). Largest remaining non-facade block. **[L]**
- [ ] **C5 · Scene3D kitbash/character-assembly** (`createCharacter` `scene3d-manager.ts:2863-3773`, ~600 ln + `_kitbashLibrary/_bakedParts/_spawnSpins/_characterMap`) → `scene3d-kitbash.ts` or fold into `scene3d-character.ts`. **[M]**
- [ ] **C6 · Packaging host contract** (`shape-manager.ts:~4021-4805`, ~750 ln `PackagingHost` literal) → move beside `PackagingManager`/`PackagingComposite`; facade keeps a thin delegator. **[M]**
- [ ] **C7 · UV-paint session** (`shape-manager.ts:~6342-6730` + 8 shared fields `:200-224` + shared `_uvPaintController` juggled across character/packaging/mesh) → `UVPaintSessionController`. This is UVPaint "Step 3" we deferred; **Step 2 (packaging dep-inversion) is already done**, so the packaging entanglement is already broken. **[M · browser-gated]**
- [ ] **C8 · Finish split skeleton-authoring region** (`scene3d-manager.ts:6401-6879`) — ~6 stragglers (`createEmptySkeleton3D`, `addBone3D`, `bindMeshToSkeleton3D`) still inline while 18 delegate to `_armature`. Move the stragglers so the boundary is uniform. **[S]**

### D. Type cleanups (low effort, remove risky casts)
- [ ] **D1 · Type `removeZonelessListener`'s options param** → kills ~11 `{capture:true} as any` casts (`scene3d-manager.ts`, `scene3d-surface-paint.ts`, `scene3d-armature.ts`). One helper-signature fix. **[S]**
- [ ] **D2 · Type the renderer raster-undo surface** — `(webgpuRenderer as any).rasterUndo/rasterRedo/rasterPushSnapshot` (`shape-manager.ts:1295,1308,1319`) + selection-engine mask cast (`:1066,1161`). **[S]**
- [ ] **D3 · Typed scene-graph-node interface** → retire ~22 duck-typed `(n as any).getType?.()/.refreshText?.()/.markDirty?.()` in `webgpu-renderer.ts` (2745-2790, 4670-4738). **[M]**
- [ ] **D4 · Legacy 2D-shape color accessors** (`shape-manager.ts:2592-2609`) → a small `ColoredShape` interface; + `var`→`const` (`:2615,2625,2635`). **[S]**
- [ ] **D5 · Type the armature/IK subsystem** (`scene3d-armature.ts`, `constraint-solver.ts`, `ik-solver.ts`, `skeleton-animator.ts`) — the densest `as any` region in the engine. **[M]**

### E. Deferred perf (scoped in `god-objects-and-perf.md`)
- [ ] **E1 · P2** — batch/instance skinned character parts (close-up/crowd bottleneck; they also cast no shadow/AO). **[L]**
- [ ] **E2 · P3** — share ONE depth prepass across shadow/SSAO/outline (currently 4 full-geometry passes, separate submits). **[L]**
- [ ] **E3 · P4** — incremental texture-atlas (copy only the changed layer) instead of full rebuild on any paint edit. **[M]**
- [ ] **E4 · Per-frame full-screen thumbnail copy** in `render()` (`webgpu-renderer.ts:2846-2847,3402`) — `copyTextureToTexture`→swapchain every frame just to persist a thumbnail source. Make it on-demand/throttled. **[S]**
- [ ] **E5 · Raster per-dab submit storm** (`brush-stamp-pipeline.ts:336-367,415,462,589` — 3 submits + 6 writeBuffer/dab), compositor per-frame bind-group/`createView` rebuild (`raster-compositor.ts:321-329`), full-canvas readback + O(w·h) CPU compare on every `endStroke` (`raster-snapshot-manager.ts:78-90`). **[M]**

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
