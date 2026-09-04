# Pipeline Warm-Up — eliminate the first-3D-mesh freeze

**Status:** Phase 1 DONE (2026-08-12, typecheck clean, 804 tests, +5 in `pipeline-warmup.test.ts`). Phase 2/3 deferred. **Owner spec.** Related: the §3.1 plain-shader change (uber-shader pattern-strip) and the lazy-pipeline deferral in `pipeline-3d.ts`.

**Stage A / Part 1 shipped (2026-08-13, typecheck clean, 805 tests):** the 16 CORE pipelines are now deferred + async-warmed too. `Pipeline3D` runs `createPipelines()` in COLLECT mode (`_collectingCore`): each core site uses `_mkCore(assign, descriptor)` to record its descriptor instead of compiling. `ensureCore()` compiles them sync on first getter access (every core getter self-ensures → a draw can never read an uncompiled pipeline); `warmDeferredAsync()` now includes the core group (createRenderPipelineAsync). The constructor now compiles ZERO pipelines. So `warmDeferredAsync()` warms all 29 render pipelines (16 core + 13 deferred) off the main thread. Test updated (6 cases).

★ **Key finding on the aux passes:** the 4 always-on aux passes (highlight/silhouette/ghost/armature) and the lazy feature passes use SIMPLE special-purpose shaders (stencil, outline, solid dim, ghost), NOT the ~2000-line uber mesh3d FS. Their compile cost is a fraction of a core/plain pipeline. So Part 1 (core + the earlier plain/SSAO/wp groups — all the uber-shader pipelines) removes the DOMINANT first-render freeze; warming the aux passes (Stage A Part 2 + Stage B) is marginal-value polish weighed against refactoring ~9 more classes with browser-only verification. Recommend browser-testing Part 1 before investing in the aux-pass warm.

**Phase 1 shipped:** `pipeline-3d.ts` — each deferred group (plain ×10 / SSAO ×1 / weight-paint ×2) is now one `PipelineSpec[]` (`{descriptor, assign}`) consumed by BOTH a sync fallback (`_buildSpecsSync`, via the getters) and an async warm (`_buildSpecsAsync` → `createRenderPipelineAsync`). `warmDeferredAsync()` is memoized (`_warmPromise`) and race-guarded (re-checks the built flag after `await`). `renderer-3d.ts` — `warmPipelinesAsync()` delegates. `webgpu-renderer.ts` — `_schedulePipelineWarmup()` runs once at device-ready via `requestIdleCallback` (setTimeout(300) fallback): creates `Renderer3D` (core compile, during idle) then `warmPipelinesAsync()`. Browser-verify: raster doc → wait a beat → add a cube → should be instant; reload a 3D doc → smoother.

## Problem

WebGPU render pipelines are compiled the first time any 3D mesh renders (`Renderer3D` is lazy — created on the first `draw3DMeshes`). The §3.1 "plain shader" optimization roughly **doubled the pipeline count (12 → 22)**, so that first-3D-frame compile burst became visible:

- Draw on a raster layer → reload → fast (a 2D-only doc never creates `Renderer3D`).
- **Add a cube → freeze.** A plain cube (no pattern/normal/ground flags → `_usesPatterns()==false`) routes to the plain pipeline, so its first frame compiles the **9 core pipelines** (renderer init) **+ the 10 plain pipelines** (its getter) ≈ 19 synchronous shader compiles in one frame.
- Reload a doc that contains 3D → the same burst replays on load.

The deferral we added (plain/SSAO/weight-paint lazy) trimmed the *startup* set and moved SSAO/weight-paint off the path, but a plain mesh's first draw still eats the plain set. The compile cost is the freeze.

## Key insight

**Pipelines are compiled once per page-load and persist for the whole session** — they live on the single `Pipeline3D` instance, reused across every document. So a *single* background warm-up, done while the user is idle, makes the entire rest of the session hot. The freeze happens at most once per page-load, and we can move that once into idle time before the user needs it.

## Mechanism — no web workers

GPU shader compilation already runs off the JS main thread, inside the browser's GPU process on the driver's own threads. A `GPUDevice` can't be shared into a Web Worker to produce pipelines usable on the main thread, so workers buy nothing. Two primitives do the job:

- **`device.createRenderPipelineAsync(desc)`** → `Promise<GPURenderPipeline>`. The driver compiles on its background threads; the JS main thread stays free until it resolves. (Our current getters use the *sync* `createRenderPipeline`, which blocks — that's the freeze.)
- **`requestIdleCallback(cb)`** → main-thread scheduling; picks a quiet moment. Fallback: `setTimeout(cb, ~200ms)` where unsupported.

Warm-up = schedule at idle (`requestIdleCallback`) + compile without blocking (`createRenderPipelineAsync`).

## Design

### Pipeline3D — sync fallback + async warm, sharing one descriptor source

Each deferred group (plain ×10, SSAO ×1, weight-paint ×2) is expressed once as a **spec list** — `{ descriptor, assign }[]` — built by a closure that captures the vertex modules / buffer layouts / blend + depth descriptors from `createPipelines()`. Two runners consume the same specs:

- `_ensureXPipelines()` (sync) — the on-demand fallback the getters already call. Builds via `createRenderPipeline` if a draw needs a pipeline before warm-up finished.
- `warmXAsync()` (async) — builds via `createRenderPipelineAsync` (non-blocking). Used by the idle warm-up.

A `_xBuilt` flag guards both. Race handling (warm in-flight when a draw hits the sync getter): the async path re-checks `_xBuilt` after its `await` and discards its results if the sync path won — a rare, harmless double-compile, since warm-up runs at idle *before* interaction. `Pipeline3D.warmDeferredAsync()` runs all three groups concurrently.

### Renderer3D

`warmPipelinesAsync(): Promise<void>` → delegates to `pipeline.warmDeferredAsync()`. Constructing `Renderer3D` already compiles the 9 core pipelines synchronously; the warm-up scheduler creates the renderer during idle so that cost lands off the interaction path too.

### Scheduler — WebGPURenderer

Once the device is ready (end of `initWebGPU`), schedule **once** (guard flag) a `requestIdleCallback` (setTimeout fallback) that:
1. Ensures `Renderer3D` exists (`getRenderer3D()` → core 9 compile, during idle).
2. `await renderer3D.warmPipelinesAsync()` (deferred groups, non-blocking).

After this runs, adding a cube / opening the next doc finds every pipeline hot.

## Phases

- **Phase 1 (this pass):** async warm of the deferred groups + idle scheduler + early `Renderer3D` creation. Fixes the reported raster→idle→cube flow and every subsequent doc in the session. The core-9 compile still runs synchronously, but inside the idle callback (invisible on the dashboard/idle).
- **Phase 2 (follow-up):** predictive gating on the doc-load path — the parsed scene JSON tells us 2D vs 3D node counts before first render, so a 2D-only doc can warm 3D lazily during idle while a 3D doc compiles its needed set first. Also: skip/delay 3D warm for genuinely 2D-only sessions to save the few MB of pipeline VRAM.
- **Phase 3 (optional):** move the core-9 build out of the constructor onto an async path too, so even a hard reload directly into a 3D-heavy doc never blocks. Only if Phase 1's idle core-compile proves noticeable.

## Risks / notes

- Warming 3D for a doc that stays 2D wastes a few MB of pipeline VRAM. Accepted in Phase 1 (Phase 2 gates it). It directly enables the user's "add a cube later → instant" requirement.
- A hard reload landing *directly* on a 3D-heavy doc (no idle gap before first paint) still compiles what that first frame draws — warm-up starts at device-ready to minimize the window; everything after frame one is hot.
- Testing: pipeline creation needs a real device, so unit tests cover the **scheduling + guard logic** (idempotent, fallback, no double-schedule) with a mock device; the actual compile + no-freeze is **browser-verified** (raster doc → wait a beat → add a cube → should be instant; reload a 3D doc → smoother).
