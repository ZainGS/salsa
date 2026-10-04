# Performance plan — eliminate lag and freezes

Started 2026-09-30. Status: `[ ]` todo · `[~]` partial · `[x]` done · `[-]` dropped (with reason).

## Measured (real Frogmarks, seed-default city, headless Chrome + WebGPU, 2026-09-30)

| View | Frame p50 | Tris drawn | Draw calls | Renderer CPU | Long tasks |
|---|---|---|---|---|---|
| free 3D (overview) | 16.7 ms | 0.52 M | ~950 | 1.5 ms | none |
| **2D ortho** | **62 ms (16 fps)** | **3.1 M** | **~2,500** | 3 ms | none |
| 2D perspective | 16.7 ms | 3.9 M | ~3,000 | 4 ms | none |

View switches stall for 28–131 ms (the slowest is into 2D perspective).

- **2D ortho is GPU-bound and ortho-specific.** CPU is only ~3 ms, and 2D perspective draws *more* triangles at 60 fps.
- Suspects:
  - shadow cascades or the far map re-rendering every frame in ortho
  - a full-resolution offscreen or composite pass
  - fill and overdraw at ortho zoom
  - distance LOD skipped in ortho (`lodOn = … && mode !== 'orthographic'`)
  - pedestrians always using the far version
  - a pass that runs only in ortho (2D composite, artboard texture)

## Principles
- **No main-thread freezes.** Generative and data work goes to Web Workers; GPU-friendly maths goes to compute shaders; anything else is time-sliced across frames.
- **Shaders can't compile in a Worker.** WebGPU pipelines belong to the main-thread device. The freeze comes from *synchronous* `createRenderPipeline` / `createComputePipeline`.
  - Use `createRenderPipelineAsync` everywhere, warm up early, and never block a frame on a pipeline.
  - Show a host-visible "Preparing shaders…" status while compiles are pending. Draw a placeholder or skip the mesh until its pipeline is ready.
- **Measure everything.** Before/after numbers in the real app (driver: scratchpad `pupdrive/fm-perf.js`) and the harness.

## P1 — 2D views (the measured lag)
**Status (2026-09-30):** P1.1 `[x]`, P1.2 `[x]`, P1.3 `[~]`, P1.4 `[-]` (measured negligible; the occluded case is P4.4 `[x]`).

**Measured.** Per-pass GPU time comes from `timestamp-query` timestamps injected around every render pass (no engine change; scratchpad `pupdrive/p1/gpuprof.js`). Real-app drivers: `p1/after.js on|off`, `p1/exp26.js` (switch CPU profiles), `p1/exp28.js` (switch GPU). Harness: `p1/h3.js` (A/B + screenshots), `p1/h5.js` (switch profile), `p1/h8.js` (bounds equivalence).
- The Frogmarks dist was not rebuilt (no `npm run build`). The real-app "after" column therefore runs the old dist with runtime shims that do exactly what the new code does: the viewport depth range on the passes that use the scene depth, and the new `computeWorldBounds`. The same fixes were A/B'd in the live-source harness.
- After a dist rebuild, re-run `node p1/after.js off` to get unshimmed numbers.

| Real Frogmarks (seed city in a 3D scene layer, 1600×950) | Before | After |
|---|---|---|
| 2D ortho frame p50 | **60.9 ms** (16 fps) | **16.6 ms** (60 fps, vsync) |
| 2D ortho main colour pass (GPU) | **59 ms** | **5–11.5 ms** |
| 2D ortho after zooming in | 60.7 ms | 16.6 ms |
| 2D perspective / free 3D | 16.6 ms (11.6 / 3.1 ms GPU) | unchanged |
| First switch into free 3D (sync) | **308–373 ms** | **19 ms** |
| Switch into 2D perspective (sync + 2 frames) | 73–124 ms | 25–28 ms |
| Switch into 2D ortho (sync + 2 frames) | 35–57 ms | 36–58 ms; the frames now render at 60 fps |

Two rAF intervals are 33 ms at vsync, so the switch rows include that much by construction.

- [x] **P1.1** **Root cause: depth values packed against 0.** The fix runs 2D ortho at 60 fps on the same scene.
  - The 2D-ortho illustration camera sits at z = 10 with near = 0.001 and far = 100 (`_applyIllustrationCamera`). The city's front edge is at z ≈ 10.3, so the city starts right at the near plane. Under the LINEAR ortho depth, nearly every fragment stores a depth of 0 to 0.3.
  - On this NVIDIA (Turing) GPU, that made the main colour pass ~5× slower: 60 ms vs ~10 ms. The coarse depth cull stops rejecting hidden fragments. Draw order stops mattering, and the cost adds up per mesh.
  - Moving only the stored depth, with identical clipping, proves it. Viewport depth range [0, 1] gives 37–59 ms; [0.2, 1] gives 26 ms; [0.33, 1] gives 13 ms.
  - Sweeps also showed it: the eye at z = 38 (nothing near the near plane) gives 10 ms; the near plane 9 units in front of the city with no geometry clipped gives 16 ms; far = 1000 with the eye at 38 gives 41 ms.
  - **Ruled out by toggling, each within noise of the 60 ms:** shadows suspended, cascades → 1, PCF 3×3, fog, glass, SSAO/SSR (both off here), transparent meshes or sky clouds hidden, pedestrians hidden, the 2D composite, any post pass. Shadow and post passes are ~1 ms in total.
  - **Fix (`Renderer3D.orthoDepthRemap`, on by default):** under an orthographic camera, every pass that depth-tests against the scene depth buffer maps NDC depth [0, 1] to **[1/3, 1]** with the viewport depth range. These are the main 3D draws and the overlay pass: `WebGPURenderer.draw3DMeshes` / `draw3DOverlays` call `applySceneDepthRange`.
    - Clipping (done on NDC) is untouched, and so is the depth order.
    - 1.0 stays the cleared "nothing drawn" value, so PostBgKeep's `equal` test still works.
    - Only a third of the linear depth precision is given up.
    - Perspective is a no-op: its depth already sits near 1.
  - **Visual A/B (harness, refraction and traffic frozen):** the remap frame matches an old-mode frame to a mean diff of 0.86/255 (0 px > 40). The old mode differs from itself frame to frame by more than that (animated band).
  - **Tried and dropped:** fitting the ortho near/far to the scene bounds. It was just as fast, but it un-clipped geometry in front of the eye: a cloud layer appeared over the buildings. That is a visible change, so it was reverted.
  - The SSAO/SSR prepass (~1 ms) and the outline prepass (~2 ms) keep their own depth targets. They are not slow in ortho, so they are left as they are.
- [x] **P1.2** **Ortho screen-size LOD** (`Renderer3D.orthoScreenLod`, on by default; helper `orthoLodDistance` in `distance-lod.ts`, +2 tests).
  - Under ortho, distance LOD no longer turns off. Every mesh is "at" `orthoSize / tan(22.5°)`: the distance at which the reference 45° lens shows the same view half-height, which is size × zoom and uniform across the view. That value is compared with `drawDistance` and `lodTwinDist`, so chunk detail and the pedestrian / edge-chip near/far twins follow the ortho zoom.
  - Before, ortho always drew every chunk and only the far twins.
  - The world-manager zoom tiers already key off `orthoSize` and are unchanged. The distance bias is 0 in ortho, as before.
  - **At the default 85 % zoom:** same draw/triangle budget, main pass 10.5 → 9.1 ms. Screenshots outside the animated band have a mean diff of 0.11/255 (the twins coincide). Zooming out past ~1.7 orthoSize swaps the crowd to far twins, which is intended.
- [~] **P1.3** **View switches**
  - **Done:**
    - **First free-3D entry: 308–373 ms → 19 ms.** `frameAllMeshes` → `computeWorldBounds` ran `vec4.fromValues` + `vec4.create` + `transformMat4` per vertex (~300 ms for a city). It now:
      - uses the renderer's cached world box for axis-aligned meshes (exact for scale + translate)
      - skips rotated meshes whose corner box is already inside the running bounds
      - transforms the rest inline, without allocating
      - gives a bit-identical result on 4,520 city meshes (harness: 38 ms exact scan → 10–14 ms).
    - **The 2D-perspective "stall" was GPU backlog.** Ortho frames (60 ms each) were still queued when perspective started. With P1.1 it is gone (73–124 ms → 25–28 ms).
  - **Measured, not changed:**
    - No cascade or shadow reset storm: cascade and far-map passes stay at ~1 ms on switch frames.
    - **The switch frame still costs ~20–35 ms CPU** (harness). ~12 ms of that is one **full instance repack** (`instancesDirty`) per switch.
      - The world-manager zoom tiers legitimately show or hide ~286 instanced array groups when the metric changes (free 3D camera distance vs ortho/2D zoom). A changed array-group set forces the full repack, because the P4.3 incremental path bails on new array sources.
      - **Done in P5.1:** group slot ranges are allocated or parked incrementally, so switches pay 0 full repacks.
    - **The first entry into a mode that reveals never-drawn geometry** can append-overflow into one geometry-pool rebuild (harness: 172 ms on the first ortho entry after a far free-3D start). It happens once per session. The real app opens in ortho, so it is not hit there.
      - **Done in P5.2:** the pool now grows by a GPU copy and the append is time-sliced.
- [-] **P1.4** **Cache the 2D composite: dropped, measured negligible.**
  - In the measured scene (one raster layer) the 2D path is one 1080² texture copy plus a quad on the GPU, and ~0.4 ms of CPU per frame (the per-frame node filter).
  - A content-version cache would risk stale paint, because many paths write layer textures, including host-side ones. It can't move the 60 fps result.
  - The safe case, 2D content fully hidden under the 3D backdrop, is P4.4.

## P2 — Shaders and pipelines (the worst hitch)
**Status (2026-09-30):** P2.1 `[~]` (every 3D pipeline is done; the 2D raster and Shell pipelines are left on purpose, see below), P2.2 `[x]`, P2.3 `[x]`. Host API: `docs/ui/performance.md`. Cache: `src/renderer/core/gpu-pipeline-cache.ts` (+10 tests). Pipeline3D tests: +2.

**Measured.** Salsa harness, headless Chrome on a real GPU, shader disk cache off, 3 runs each. A/B uses the `globalThis.__salsaPipelineMode = 'sync'` switch, which restores the pre-P2 behaviour.

| Scenario | Before (sync) | After (P2) |
|---|---|---|
| First procedural character right after boot (cold skinned uber-shader) | `createRandomCharacter3D` call **10.6 / 11.3 s**; longest frame gap **10.3 / 12.7 / 2.5 s** | call **0.27–0.32 s**; longest frame gap **0.15–0.20 s**. The character appears 1.8–7.5 s later while frames keep flowing. |
| City generate, the first 3D frame (needs about 8 uber pipelines) | longest main-thread block **4.4 / 5.8 / 5.8 s** | **2.6 / 3.0 / 3.3 s**. What remains is city-build JS, profiled: `splitGeometryXZ`, draw lists, noise. That is P3 work. |
| Outline / bloom+grade / SSAO first enable | no long task (small shaders), 2–4 sync compiles | no long task, 0 sync compiles; the effect appears about 50 ms later |
| Sync compiles inside a live frame, whole session | 5–8 | **0** |

- The sync-mode freeze is mostly a **GPU-process stall**, not JS: rAF gaps of 10–12 s with no matching long task.
- **Real Frogmarks before** (seed city + procedural character doc, opened directly, local IndexedDB doc; driver `pupdrive/p2/fm-p2.js open`):
  - first 3D draw at **20.8 / 26.3 s**
  - longest main-thread block **11.3 / 10.8 s**
  - longest frame gap **11.5 / 10.9 s**
  - The CPU profile puts 9.5 s of the 11 s task in `_renderHairGradient`, inside `restoreHairRigs`. That is a `copyExternalImageToTexture` waiting on the GPU process, which was busy with the on-demand **sync compile of the two skinned plain pipelines** (#35/#36) while the uncapped 36-pipeline warm ran.
- **Real Frogmarks after:** needs a `dist` rebuild (not run by this agent). Re-run `node p2/fm-p2.js open after` (doc id in `p2/docid.txt`, profile `p2/profile`).

- [~] **P2.1** Every render and compute pipeline is created with the async APIs, behind a pipeline cache that returns "pending".
  - Draws whose pipeline is pending are skipped.
  - Covers the mesh variants (styles, skinned, ground modes, transparent), post passes, outlines and shadows.
  - **Built.** `GPUPipelineCache` holds one cache per device and hands out lazy handles. `get()` inside a live frame returns null and starts `create*PipelineAsync` at NOW priority. Results that land mid-frame publish at frame end, so a frame sees one consistent ready-set. `onPipelineReady` triggers `scheduleRender`. Outside the live frame (captures, exports, tests) `get()` compiles synchronously as before. The sync API is used only as a fallback when the device has no async API.
  - **Routed through the cache:**
    - Pipeline3D, all 36 variants (render styles and ground modes are uniform-driven inside these, so there are no extra pipelines)
    - shadow pass and cascades (pending → cleared/lit map kept stale), skinned shadow, SSAO prepass/AO/blur (pending → white AO), SSR peel/resolve/heal/feather (pending → no reflection), planar
    - post chain: bloom-extract/blur/composite/grade (pending → presented unprocessed), wide bloom, FXAA (pending → returns src)
    - bg-keep, lo-res/PS1 blit (pending → full-res path), outline (gated pre-pass AND composite), mesh highlight (all-or-nothing, so stencil steps pair), silhouette, sprite outline + SDF blit
    - particles + bloom capture, ghost preview, focus bg, gizmos, grease pencil, mesh-edit overlay, weight-paint overlay
    - cloth compute (step holds; the bake awaits), onion skin, the P4 IBL compute bake (already uses the cache)
  - **Not converted (deliberate):**
    - The 2D core (`pipeline-manager.ts`), raster engines (compositor, brushes, selection, flood fill, text effects, dither), the Shell renderer/cartridges, and the standalone viewer.
    - Their shaders are tiny and compile at boot or on tool use, not in the 3D hot path.
    - Several cache their output: a skipped composite would stay blank until the next invalidation. Convert them case by case if one shows up in a profile.
- [x] **P2.2** Warm-up: on renderer init (Shell or direct illustration open), queue every common variant at idle priority. Prioritise what the loaded document needs first.
  - **Built.** `warmPipelinesNow` runs at device-ready (both routes, plus `bootAndWarm` from the Shell). It queues all Pipeline3D variants at COMMON, and tools / SSAO / SSR / overlays at RARE.
  - The drain runs in priority order, **2 concurrent**, paced by `requestIdleCallback`. On-demand requests bypass the cap, so a pipeline a draw is waiting for never queues behind the warm. The old warm fired all 36 at once.
  - **Document-driven:** `Renderer3D._prewarmForScene` runs when the mesh roster changes. It queues at DOCUMENT priority every variant the meshes route to (textured × plain/patterned × cull × shadow-receiving, transparent, skinned, casters), including off-screen ones. Feature passes warm at DOCUMENT when they are constructed (feature turned on).
- [x] **P2.3** Host status API (`sm.getPipelineWarmup3D()` → `{pending, total}` plus an event), so Frogmarks shows a small "Preparing shaders… n/m" toast instead of freezing.
  - **Built:**
    - `sm.getPipelineWarmup3D(): PipelineWarmupStatus` returns `{ pending, total, compiled, failed, waitingDraws, ready }`.
    - `sm.onPipelineWarmup3D(listener) → unsubscribe` is coalesced and safe before the device exists.
    - `sm.whenPipelinesReady3D()`
  - The types are exported from the package. The toast rule is `waitingDraws > 0`.

## P3 — Worker orchestration
Measured 2026-09-30. "Before" is the real Frogmarks app (current dist, headless Chrome + WebGPU). "After" is the Salsa vite harness with live source, A/B'd in one build with `salsaWorld.streamWorkers(false)` = main thread. The Frogmarks dist was not rebuilt (no `npm run build`), so the real-app "after" is still pending a build. Stall = the worst rAF frame gap in the window. The `longtask` observer under-reports synchronous work started from `page.evaluate`. Drivers: scratchpad `pupdrive/p3w/fm-p3.js` (real app) and `p3w/h-p3.js` (harness, with `PROF=<label>` for CPU-profile long-run breakdowns).

| Action | Before (worst frame) | After (worst frame) |
|---|---|---|
| Document load with a city | harness main 1.4 s (7 long tasks, 2.9 s total) | **~0.1 s** (worst task ~80 ms = the swap) |
| Weather rain / clear | real 1.2 s · harness 1.1–1.3 s | **33–56 ms** |
| Pedestrians on | real 24 s (!) · harness 2.3 s | **35–39 ms** |
| Street furniture off / on | real 0.3 s · harness 0.6–1.7 s | **31–69 ms** |
| Corner style (World Streets) | harness 1.06 s | **~50 ms** |
| Railway toggle (full regen, already worker) | real 0.66 s · harness 1.2 s | **~0.1 s** |
| Create a random character | real 370 ms (one 315 ms task) | **71 ms** warm · 209 ms first (cold worker) |
| Add advert images (`demoAdverts`) | real 14 s, 37 long tasks, worst 717 ms | **0.74 s, worst frame 120 ms** (the dev-only demo image generation) |

Under concurrent machine load (other agents' builds and browsers), single runs showed 0.8–3.8 s outliers on both paths. Profiles of those windows showed no world-manager work; repeated runs give the numbers above.

- [x] **P3.1** A shared **WorkerJobService** (`src/services/workers/worker-job-service.ts`, worker side `worker-job-runtime.ts`). Host API is in `docs/ui/performance.md` §Background work.
  - **Lanes** are one worker script each: `world`, `pixel`, `character`, `atlas`. They spawn lazily up to the hardware cap (`hardwareConcurrency − 1`, ≤ 8, total across lanes), and every lane is guaranteed one worker.
  - **Typed job kinds** are registered by modules. The same handler runs in the worker and in the main-thread fallback, which runs one job per macrotask with a structured-cloned payload. That makes the two paths identical by construction.
  - **Priorities** (`interactive > visible > background`) are dispatched from a service-side queue to idle workers, so a slider never waits behind a FIFO of tiles.
  - **Cancellation:** handles, plus supersede-by-key for stale regens; `terminateOnCancel` is optional.
  - **Transferables** go both ways.
  - **Sticky shared state** is broadcast by identity, as the tile params already were.
  - **Progress events and stats:** `sm.getWorkerJobProgress3D()`, `sm.onWorkerJobProgress3D(cb)` and `sm.getWorkerJobStats3D()`.
  - **Crash handling:** a crash rejects only that worker's jobs. After 3 crashes a lane stops respawning and falls back.
  - **Existing pools:** `tile-worker-pool.ts` and `pixel-encode-pool.ts` are now façades over the `world` and `pixel` lanes. Their API and their available/fallback contract are unchanged.
  - Tests: `worker-job-service.test.ts` (fake-Worker protocol + fallback).
- [~] **P3.2** Moved to workers:
  - [x] **Pedestrian builds and all selective city regens.** The PARAM_TIER partial rebuilds (weather, pedestrians, furniture, signage, awnings, signals, streets roof/corner/facade, biome, layout, road paint, apron, void grid, border glow, terraces, shotengai) run as the `world.groups` job.
    - The job runs on a copy of the graph and returns pre-draped, chunked groups with contact shadows. The old groups stay live, and the new ones reassemble hidden and are swapped in.
    - `World Streets` mutates `lots[]` (builtH, doors, buildingMeta) when the style changes. The job returns a **graph patch**, applied in place at the swap.
    - Tests: `world-jobs.test.ts`.
      - Per tier, worker bytes == fallback bytes == the direct build, and the patch reproduces the in-place mutation.
      - At WorldManager level, the async path lands the same layer content and the same graph as the sync path.
    - Railway, stations and metro entrances were already full regens (the street plan reserves their footprint), and those already ran in the worker.
    - Headless (no rAF) and tiled worlds keep the sync selective path.
  - [x] **Fixed: contact shadows were split by the reassembly.** In the centre-worker regen, the per-job contact-shadow pass split every person into per-colour-part blobs: 12× the blob geometry of the sync build, measured. Blobs are now built in the worker over the whole group (`CentreBuildOptions.contact`).
  - [x] **Tiled-world centre builds**: done in P5.W2 (below). The original note said they stayed synchronous by design: Neighbour FULL tiles already stream through the worker.
    - Moving the centre needs a tiled-aware swap: generateLayout's per-tile flat maps and extent groups, then `_syncNeighborTiles` after the reveal.
    - It would also double-buffer a multi-tile scene (the reason the async path excludes tiled worlds). Left for a follow-up.
  - [x] **Procedural character generation.** The `character` lane runs `character.body` and `character.parts` (body → fit → garments → hair in one job).
    - The callers are `createProceduralBody3D`, the new `createProceduralCharacter3D` (primes the sync setters with exact-match results), `createFullCharacter3D` / `createRandomCharacter3D`, and the Play auto player.
    - Garment order is now top → undershirt → underpants → socks → shoes → bottom → hair, which removes 5 redundant hair regenerations and a bottom re-pile per character. Hair is now fitted against the final dressed state.
    - Main thread: ~7–12 ms warm in vitest, down from 100–200 ms.
    - Live slider setters stay synchronous.
    - Tests: `character-jobs.test.ts`.
  - [x] **GARP / adverts / sign atlas packing.** The `atlas` lane (OffscreenCanvas) runs `atlas.compose`, painting a shared pure op list (`atlas-sheet-ops.ts`).
    - Uses: advert pages, upload normalise, vending can labels, `packGarpSheet3D`.
    - Batching: `sm.addSignageImages3D(items)` does one pack, one atlas rebuild and one city regen. The refresh is held while adds are in flight, so a host loop of awaited single adds also gets one regen. Only changed pages are redrawn.
    - `GarpAtlasBuilder` coalesces overlapping rebuilds and caches decoded bitmaps.
    - Still on the main thread:
      - The built-in placeholder skins: ~30 one-time 512² encodes on the first city.
      - Demo image generation.
      - `uploadGarpAtlas` re-creating the whole texture array (owned by renderer-3d).
    - Tests: `atlas-sheet-ops.test.ts`.
  - [x] **Done in P5.W1 (below):** the **first city creation** (`enterCityMode` with no city, i.e. Frogmarks `openWorldPanel`) was a synchronous `generateWorld`. It measured 3.7 s in the real app and 2.6–2.9 s in the harness. It needed a sync layout-only preview followed by the async worker build. Callers read the returned graph synchronously, so this was an API decision.
- [x] **P3.3** Workers return GPU-ready typed arrays: MESH3D-stride `Float32Array` vertices and `Uint32Array` indices, pre-draped, chunked, with per-geometry bounds and contact blobs. The geometry is transferred zero-copy.
  - City results go through the existing reassembly queue: wrap and upload per job, ≤ 6 ms per frame (3 ms while tiles stream), worst job ≤ ~10 ms. They swap in within one frame.
  - The swap frame no longer recomputes the city gizmo bounds (~20–25 ms, now done on the next frame).
  - Character parts arrive as typed arrays. Their meshes are created and uploaded in the commit (~5–9 ms).

## P4 — GPU compute and frame-time hygiene
Measured 2026-09-30 in the Salsa vite harness (live source, seed-3 grid city, headless Chrome + WebGPU, d3d11). The Frogmarks dist was not rebuilt, so the real app still runs the old code: there, two sky-lit `setTimeOfDay` calls took 164 ms. Drivers are in scratchpad `pupdrive/p4/`:
- `skybake.js` and `iblcompare.js` for P4.1
- `shadow.js` and `shadowverify.js` for P4.2
- `trace.js`, `glowcost.js`, `slotcheck.js` and `fastpath.js` for P4.3
- `fm-check.js` for the real app

The machine was shared with other agents' builds and browsers, so single-frame maxima are noisy. Prefer the counters.

- [x] **P4.1** The sky-lighting / IBL bake runs as compute: `ibl-gpu-bake.ts` + `shaders/ibl-bake-shaders.ts`, entry `Renderer3D.bakeSkyLighting`.
  - **Three dispatches, no readback:**
    - `csSH9`: one 256-thread workgroup integrates the 64×32 equirect directions and tree-reduces. It uses the same 8-bit sRGB round-trip, K factors and 4π/ΣdΩ normalisation as `_computeSHCoeffs`. The result is copied straight into IBL uniform floats 0–35. `_writeIBLBuffer` then writes only floats 36+ while the GPU owns the SH.
    - `csPrefilter`: one invocation per texel × face × mip, GGX 48 samples. It writes packed sRGB RGBA8 into 256-byte rows, which `copyBufferToTexture` puts into the existing cube.
    - `csBrdfLut`: runs once.
  - **Pipelines** come from the P2 `GPUPipelineCache`, warmed at DOCUMENT priority when the renderer starts. A bake that arrives before they compile is held, keeping the previous lighting, and replayed when they land.
  - **CPU fallback:** the CPU functions stay as the reference and the fallback (no compute, a failure, or `setIBLBakeMode('cpu')`). `ambientMatchedSkyIntensity` is unchanged.
  - **Lazy env-map cache:** scene3d's cache now stores only the sky source. The equirect image and its webp data URL are built on first save, restore or reset, not on every rebake.
  - **Matches the CPU reference** (headless readback, 3 skies):
    - SH max error 4e-5 (relative to DC ≤ 1e-5)
    - cube ≤ 1 LSB on all 8,190 texels (0 texels > 1 LSB)
    - BRDF LUT ≤ 1 LSB
    - Same-page CPU/GPU screenshot A/B is within the animation noise floor.
  - **Main-thread cost per bake** (`setSky3D`): **33–35 ms → 0.1 ms**.
    - Time-of-day scrub step (whole `setTimeOfDay`): 34 ms → 0.5 ms.
    - First-use BRDF LUT: 660–1230 ms → part of the GPU bake.
    - GPU round-trip ~3 ms, asynchronous.
  - Tests: `ibl-gpu-bake.test.ts` (host-side layout contract) and wgsl-static-check (shader registered).
- [x] **P4.2** The static far shadow map is cached (`Renderer3D._recordCachedFarShadow`).
  - **Static casters** are rendered into `_shadowStaticTex` only when one of these changes:
    - their set signature (uid, slot, count and array-source version; picks up LOD flips, streamed adds and removals; throttled like the old refresh)
    - the light box or sun, or a structural stale
  - The static set is light-box culled **without** the camera reach test, so a camera-only orbit keeps it valid.
  - **Dynamic casters** are drawn on a copy of the static map every `_shadowUpdateInterval` frames (the old mover cadence):
    - meshes that moved in the last 1,800 frames (new meshes start on a 90-frame probation)
    - wind-swayed foliage
    - billboards
    - skinned characters (a pose change refreshes only this layer)
  - **Falls back to the old direct path** while the light box or sun is moving (pan, zoom, sun sweep). With no dynamic casters, the static set renders straight into the sampled map.
  - A/B with `renderer3D.shadowStaticCache = false`. Diagnostics: `getShadowCacheStats()`.
  - **Correctness:** `debugVerifyShadowCache()` renders static + dynamic directly in the same encoder and compares depth. It was **bit-identical (0 / 4.19 M texels) in 16 / 16 samples** across hero and street views, still and orbiting, with traffic, walkers and trains moving.
  - **Per 150 frames:**

    | Scenario | Full far-map re-renders | Far-map triangles |
    |---|---|---|
    | hero still | 50 → 0 | 79 M → 28 M |
    | hero orbit | 50 → 0 | 87 M → 32 M |
    | street still | 50 → 1 | 91 M → 34 M |
    | street orbit | 50 → 13 (distance-LOD flips) | 87 M → 56 M |

    The remaining cost is the dynamic layer, mostly wind-swayed trees.
- [x] **P4.3** Periodic spikes are spread or removed. A 60 s trace (30 s street-level fly-along + 30 s Play walk, per-method attribution) found the dominant spike: a **full instance repack (30–100 ms)**. Any structural add or remove (every live-crowd promotion or demotion, streamed adds) and any material change on an array source or textured mesh (the day-cycle glow walk) re-sorted and re-wrote every slot, because the city always has instanced greenery.
  - **Incremental path:** the append/free path now runs with array groups present. Their slot ranges are untouched, and a new array source bails to the full repack.
  - **Array-source material change:** only that source's groups are re-packed (`_repackGroupsOf`).
  - **Textured material change:** writes just that mesh's slots, unless the atlas is dirty.
  - **Re-rank:** the draw order is rebuilt only when the mesh set or geometry changes.
  - **Re-dress budget:** material-only rewrites are capped at 1,500 slot-equivalents per frame (`Renderer3D.MATERIAL_SLOT_BUDGET`). The rest stay dirty for the next frames, and `onDeferredWork` schedules a render.
  - **Live-crowd scans** have a 2 ms promote/demote budget, with a 34 ms follow-up scan for the backlog.
  - **Diagnostics:** `getRepackReasons()`.
  - **Correctness:** `slotcheck.js` re-wrote every settled slot with the full-repack writer during a running day cycle. 0 / ~3.8 k mesh slots and 0 / 6,716 instanced slots differed.
  - **Results:**

    | Scenario | Before | After |
    |---|---|---|
    | Street 30 s | p99 42.7 ms, 69 frames > 33 ms, 25 > 50 ms | **p99 17.1 ms, 0 > 33 ms, 0 > 50 ms**, max 32 ms |
    | Play 30 s | p99 81 ms, 59 > 33 ms, 47 > 50 ms | **p99 16.1 ms, 2 > 33 ms, 0 > 50 ms**, max 35 ms |
    | Day cycle (40 s period, 20 s) | p99 48 ms, 94 > 33 ms, 23 > 50 ms, 67 full repacks | **p99 23.5 ms, 5 > 33 ms, 0 > 50 ms, 0 full repacks** |
    | Full repacks per 15 s of street | 32 | **0** |

  - **Not changed:**
    - The glow walk itself (`WorldManager._applyGlow`, 3–5 ms per re-dress, regex classification of every mesh) was still one-shot. Done in P5.W3 (below).
    - Multi-second one-offs that appeared once per run inside trivial functions (pipeline compiles or GC) are P2's.
    - Streaming tile reassembly is already budgeted (P3.3).
    - Signal and lamp redress, LOD tier flips and contact shadows never exceeded 3 ms in the traces.
- [x] **P4.4** The 2D raster layers are skipped while the 3D view covers the canvas (`Renderer3D.focusBgCoversCanvas` + the gate at the top of the main pass in `WebGPURenderer.render`).
  - **When it applies:** the opaque 3D workspace backdrop (free 3D, or a 2D mode on the scene target) paints the full canvas after the 2D layers. In that case the BG raster composite (a full-document copy plus per-layer blend, dither and grain passes, run every frame while the scene animates), the raster quad, the artboard pattern and the below-raster panels are skipped.
  - FG layers and layer-bound vector nodes were already skipped there.
  - **Live checks** each frame:
    - the backdrop is opaque
    - armature mode is off
    - the 3D layer is visible
    - no capture is in progress
  - So the textured-artboard capture, which turns the backdrop off, and the return to the illustration both composite fresh.
  - **Harness A/B in free 3D:** mean diff 0.07/255, identical. There is no GPU change in a one-layer document; the saving scales with the layer count and the raster effects.

## P5 follow-ups

- [x] **P5.1 View switches: no full instance repack when whole array groups show or hide** (P1.3's open item). Measured 2026-09-30.
  - **What it was:** the city zoom tiers show or hide ~340 instanced array groups on a view-mode change (free 3D ↔ 2D ortho / 2D perspective). A changed group SET forced `_instancesDirty`, so every slot was re-sorted and re-written: 11 ms of instance upload on each switch into ortho. Separately, P4.3's incremental path bailed on any new array source.
  - **Slot-range allocator** (`src/renderer/3d/instance-slot-allocator.ts`, +9 tests). It owns every instance slot outside a full repack:
    - single mesh slots and contiguous N-slot group ranges
    - best fit over unowned free ranges, then the high-water, then a lazy merge of the free list
    - **parked** ranges. A hidden group's range keeps its data, owned by the group. Others reuse it only after the unowned space and the high-water have both failed.
    - nothing fits → the caller's full repack compacts (`reset`)
  - **Placement** (`Renderer3D._syncArrayGroupSlots`, runs inside the incremental path):
    - A placed group that leaves the set is parked; a group that loses its source, or changes count, is freed.
    - A group that joins the set reclaims its parked range with **zero writes**, if it is still valid: same group and source objects, same source and object-offset matrix versions, identical source-slot material floats 32–59, not relative spacing, no radial local basis.
    - Otherwise it allocates a fresh range and only its N slots are packed and uploaded (`_packArrayGroupInstances(undefined, onlyGroups)`).
    - New array sources no longer bail. Every group is its own instanced-range draw `(firstSlot, N)`, so source and instances never had to be adjacent.
    - `anyArrayMoved` only looks at placed groups. Evicting a source releases its parked groups.
  - **Instance buffer growth** copies the old buffer on the GPU (`_growInstanceBuffer`; buffers now have `COPY_SRC`) instead of forcing a repack and an atlas rebuild. It is used by `ensureInstanceBuffer` when no repack is pending, and by placement when no range fits.
  - Unchanged: the transforms fast path, the P4.3 re-dress budget and `_repackGroupsOf`. A re-shown group of a re-dressed source is packed once, by `_repackGroupsOf`.
  - **A/B:** `renderer3D.incrementalArrayGroups = false` restores the pre-P5 behaviour (also for P5.2). New counters in `getPerfCounters()`: `groupPlacements`, `groupPacks`, `groupReclaims`, `instanceGrows`, `poolGrows`.
  - **Fixed along the way:** the incremental writers (`_writeIncSlot`, `_writeIncSlotMatrices`, material rewrites) skipped `_writeGroundUvScale`. Ground meshes appended or moved incrementally drew at the default uv scale until the next full repack. slotcheck found 37–79 such slots.
- [x] **P5.2 First reveal of never-drawn geometry: no pool rebuild.** The first ortho entry after a far free-3D start appends ~145 MB of geometry (3,054 `writeBuffer` calls). That overflowed into the full pool rebuild: 100–190 ms, plus the instance growth repack.
  - **Pool growth:** an append that overflows now **grows** the pool (`_growGeomPool`): new VB/IB sized for all pending keys ×1.5, one GPU copy of the used spans, and the old buffers are destroyed after this frame's submit (`_retireBuffer`).
  - **Compaction** stays on the idle/need-gated path (`requestGeomCompaction`), or runs when the device max buffer size is reached.
  - **Time-sliced:** at most `Renderer3D.GEOM_APPEND_BUDGET` (16 MB, about 5 ms) of new geometry is uploaded per frame, and `onDeferredWork` schedules the next frame.
  - **Not drawn yet:** while a time-sliced append is pending, meshes and group sources whose geometry isn't resident are left out of the draw lists. That also keeps them out of the P4.2 static-shadow signature, which changes when they land.
  - **Visible effect:** the reveal fills in over about 9 frames (~150 ms) instead of one frozen frame.
- **Measured.** Harness, live source, default city, illustration target, 1540×900, headless Chrome + WebGPU (d3d11). Before and after were run in one build with the A/B switch. Driver: scratchpad `pupdrive/p5r/sw.js [target] [off]`.
  - "Busy" is main-thread JS: the synchronous switch plus every rAF callback, the app render included, over the 2 frames after the switch.
  - Wall time stays ~25–33 ms both ways: it is two vsync'd rAF intervals.

  | Switch | Before | After |
  |---|---|---|
  | Into 2D ortho (repeat; groups 9 → 348) | busy **24–26 ms**, instance upload 10.7–11.4 ms, 1 full repack | busy **15–17 ms**, upload 2.2–2.7 ms, 339 groups reclaimed with 0 slots written, 0 repacks |
  | Into 2D perspective / free 3D (348 → 9) | busy 6–14 ms, 1 full repack (~2.4 ms upload) | busy 9–14 ms (noise), 0 repacks |
  | All switches after the first: median / max busy | 13.8 / 25.6 ms (+198 first reveal) | **12.7 / 17.3 ms** |
  | Full repacks per 9 switches (`getRepackReasons`) | 6 (`instancesDirty`) | **0** |
  | First ortho entry (reveals ~145 MB of never-drawn geometry) | busy **198 ms** (one 190 ms frame: pool rebuild 120 ms + full repack) | **68 ms** over the first 2 frames (instance growth by copy, pool growth by copy), then ~7 frames of 18–28 ms while the rest streams in. No pool rebuild, no repack |

  - **Real Frogmarks, before only.** The app runs the built Salsa dist, which was not rebuilt (no `npm run build`). Driver: `pupdrive/p5r/fm-sw.js`, a city in a 3D scene layer.
    - Into ortho: busy **41–42 ms with a full repack** (`instancesDirty`), 24.5 ms without one.
    - Into perspective: 16–19 ms. Into free 3D: 7.6–7.9 ms.
    - 2 full repacks per 7 switches. Median busy 19.3 ms, max 42 ms.
    - Re-run `node p5r/fm-sw.js` after a dist rebuild for the "after".
  - **Correctness.** `pupdrive/p5r/slotcheck.js` stops the world at 22 checkpoints on the default city and 22 on a tiled 3×3 world (`CITY='{"seed":3,"pattern":"grid","worldMode":"tiled","tileRadius":1}'`). The checkpoints cover mode switches, street views (LOD flips, live-crowd promotions, streaming), pedestrian and street-tree regens (mesh adds and evictions, groups removed and re-added), and a running day cycle (budgeted re-dress).
    - Method: snapshot the CPU mirror, read back the GPU buffer, re-write every settled resident slot with the full-repack writer (`_writeInstanceSlot` + `_packArrayGroupInstances()`), compare, restore.
    - **0 differences** in every checkpoint: up to 4.4 k mesh slots, and 5,617 / 7,226 group instance slots.
    - **GPU == CPU mirror** on every live slot (0 diffs).
    - **0 overlapping** or out-of-range slots.
    - The placed group set equals the full repack's rule (0 missing / extra / count mismatches).
    - Screenshots with the switch on vs off, after the reveal settled (traffic frozen): mean diff 0.57 / 0.03 / 0 / 0.04 per 255 (ortho / persp / ortho again / free 3D), 0 px > 40.
  - **Not changed:**
    - The first reveal still writes ~3 k new mesh slots and packs 339 groups (~11 ms) in its first frame.
    - `getMeshWorldAABB3D`'s first vertex scan of each newly drawn mesh (~11–15 ms in total) is spread over the fill-in frames.
    - Moving an array source (`anyArrayMoved` / `movedArraySource`) still takes the full repack. It never occurs on view switches; gizmo drags call `markInstancesDirty` anyway.
    - In-place edits to a group's params or overrides must keep calling `markInstancesDirty`, as they do today. A parked group is only reclaimed when it is the same object.

### P5 world follow-ups (W1–W4): first city, tiled centre, glow pass, traffic off the main thread
Measured 2026-09-30.
- **"Before"** is two sources:
  - the real Frogmarks app (current dist, headless Chrome + WebGPU, d3d11), driver scratchpad `pupdrive/p5/fm-p5.js`;
  - the Salsa vite harness on the pre-change source, driver `p5/h-p5.js`.
- **"After"** is the harness on the live source, same driver (`ONLY=first,firstupd,tiled,glow`, `PROF=<label>` for a CPU-profile breakdown of the longest runs).
- The Frogmarks dist was not rebuilt, so the real-app "after" is pending a build. Re-run `p5/fm-p5.js` after one.
- Worst frame = the worst rAF gap in the window. Long tasks come from a `PerformanceObserver('longtask')`.
- The machine was shared with other agents. Single maxima vary ±50 %; the table gives representative runs.

| Action | Real app before | Harness before | Harness after |
|---|---|---|---|
| First city: `openWorldPanel` / `enterCityMode(p)` | worst task 3.0 s (4 long tasks, 5.2 s total) | call 2.7 s, worst 2.7 s | **call 8–13 ms**, worst **~150 ms**, city revealed after ~3.4 s |
| `enterCityMode(p)` + `updateCity(p)` 10 ms later | — | 4.8 s (built **twice**) | **19 ms call, one build** (the update joins it), worst ~150 ms |
| … + `updateCity({ seed: 9 })` 10 ms later | — | 4.9 s call, worst 2.8 s | **25 ms call**, worst ~170 ms, lands seed 9 |
| Generate button (`enterCityMode(p)` on an existing city) | — | 2.1 s | **~100 ms** |
| Diorama → tiled r1 'focus' | worst frame 4.6 s | 2.4 s call, worst 3.1 s | **1 ms call, worst ~110 ms** |
| Tiled seed change | worst frame 6.2 s | 2.2 s call, worst 2.8 s | **~1 ms call, worst ~100 ms** |
| Tiled 'focus' → 'full' (9 full tiles stream) | — | 2.2 s call, worst 2.5 s | **0 ms call, worst ~180–220 ms** (remaining = tile streaming, see below) |
| Glow re-dress (one forced pass, ~5.1 k meshes) | 3.7–6.2 ms | 3.8–8.9 ms | **1.0–2.8 ms** |
| Day cycle, 10 s period, 8 s | — | worst frame 40 ms | worst frame 24 ms; every incremental pass ≤ 1.6 ms |

- [x] **P5.W1 First city creation is non-blocking.**
  - **What happens now:** `WorldManager.enterCityMode(params)` (no city, or the Generate button on an existing one) goes through the same async full build as a document load:
    - the 'world' worker centre job (`world.centre`, label "Building city", now reporting per-group progress);
    - time-sliced staged reassembly;
    - a one-frame swap in `_finishAsync`.
  - **Return value:** the call returns a **layout-only graph** (`generateCityLayout`, 2–4 ms) with the same regions, roads and lots the worker builds. `regions` serves it until the reveal, so Frogmarks' `worldRefreshRegions()` right after the call still fills the district list.
  - **Deferred City-mode setup:** `_enterCityModeTail` (workspace + framing on the real city, shadow extent / interval / softness / cascades, cinematic grade + time of day, SSAO / outlines, edit pulse) is deferred to the reveal frame (`_flushPendingCityEnter`). The host scene is never re-lit or re-framed over an empty city.
    - A sync build that supersedes it also flushes it, at the end of `generateWorld`.
    - `exitCityMode()` before the reveal cancels it and restores the lighting snapshot. The city still lands, placed.
  - **Traffic** spawns over the two frames after the swap (`_spawnTrafficSoon`): the road net + street plan (~80 ms) first, then `computeTraffic` + meshes. That took 60–200 ms off the reveal frame (the swap frame is now ~55–65 ms).
  - **Concurrent calls:**
    - `updateCity(p)` while the build runs, with the same params (key-order-insensitive, ignoring `adverts`), **joins** the build (`_sameParams`). This is the Frogmarks `openWorldPanel` → `updateCity` case, which used to build the city twice.
    - Different params **supersede** it, merged onto the in-flight params (`_targetParams`), still reason 'load'.
    - `enterCityMode()` / `enterCityMode(sameParams)` during a build (a doc-load build, a re-opened panel) waits for it. It used to build a second default city.
  - **First-city geometry upload:** `Renderer3D.warmGeometry` used to bail when no geometry pool existed yet, so the whole city uploaded in ONE full pool rebuild on the reveal frame (0.3–2 s of `writeBuffer` in profiles). It now seeds the pool with the first staged group, and the rest append and grow (the P5.2 growth path above) during staging. This is a geometry-pool change only; instance packing is untouched.
  - **Headless fix:** the headless (no rAF) main-thread staging loop is fixed. `_asyncStep` scheduled a rAF that doesn't exist, which broke a headless `restoreFromSave` with more than 2 groups. A headless restore also no longer leaves `_suppressNextFinishLighting` stuck on.
  - **Unchanged:** headless `enterCityMode`, the draft drag-preview path, and selective regens.
  - **Remaining long tasks** (one-offs, ≤ ~170 ms):
    - the traffic spawn's two frames (~80 / ~120 ms);
    - on the first city of a session, shape-manager's built-in GARP placeholder skins (`_ensureVendingGarp` / `_ensureClutterGarp`, ~70 ms of `toDataURL` each, inside a reassembly job);
    - `_addTextSigns` (~35 ms) in the swap frame.
  - Done in P5.W4 (below): the traffic computation moved into the centre job, the GARP placeholder encodes into the 'atlas' worker, and the text signs out of the swap frame.
- [x] **P5.W2 Tiled-world centre builds** use the async path: worker, or main-thread staging without workers.
  - `buildCentreGroups` mirrors `generateLayout`'s tiled branch:
    - grid / square / no terraces / no shotengai;
    - the drape env (`makeElevation`, whose pavement index captures the border) is taken **before** the widen;
    - `widenToTiledExtent` (now shared) runs before 'World Apron';
    - 'flat' detail stops after the extent groups.
  - The un-widened frame comes back as `CentreBuildResult.centreFrame`, so the main thread rebuilds the same drape env.
  - The main-thread staging queue gets a widen pseudo-step.
  - **The swap** (`_finishAsync`) first tears down the old world's streamed tiles through the stream itself (disposal, retire cache, pump state). That also fixes a tiled → diorama async regen leaving the stream with dead tiles. Then it swaps the centre, sizes the shadow box to the tiled extent, and calls `_syncNeighborTiles(params, false)`. A fresh City-mode entry frames the whole world once the tiles settle.
  - **Double buffering** is the old world + the new centre only, never two tile grids: the neighbours stream after the swap, as they did after the sync build. `restoreFromSave` and `refreshAdverts` take the async path for tiled worlds too.
  - **Unchanged:** the incremental tileRadius-only path, and selective regens on tiled worlds (sync).
  - **Remaining long tasks** in 'full' tile streaming are pre-existing streaming costs, not the centre:
    - the flat proxy tile builds (~120 ms each, sync in the stream pump);
    - contact shadows on a tile's reassembly job (~70 ms);
    - `_cacheCityBounds` on settle (~160 ms tree walk).
- [x] **P5.W3 Day-cycle glow pass.**
  - **Per-name traits:** `WorldManager.glowTraits(name)` classifies each distinct mesh name once and caches it: GLOW row, border-glow skip, celestial / clouds / cloud-rim / lamp-pool visibility, crowd, snow-ground, wet-road, train-window, and the surface-look tests (clean ground, mute, sidewalks, roads-wear, kerb, road paint). The cache is a static `Map`, bounded by the finite name set, with a 20 k safety valve. `_applySurfaceLook` takes the traits. The GLOW table is a static constant.
  - **Slicing:** a **forced** re-dress (`_lastGlowNight` reset: fresh meshes, a look change, a weather change) still runs in one shot, so nothing is ever shown half-dressed. An **incremental** day-cycle step (same weather, night moved ≥ 0.004) is sliced under `GLOW_SLICE_MS` (2 ms) per frame (`_glowRun` cursor over a mesh snapshot; a newer pass supersedes).
  - **GPU side:** the material slot writes go through the renderer's P4.3 re-dress budget (`MATERIAL_SLOT_BUDGET` + `onDeferredWork`), unchanged.
  - With the cache, a whole pass is ~1–1.6 ms, so day-cycle passes fit one slice. The budget is a cap for bigger scenes.
  - Diagnostics: `salsaWorld.manager._glowStats`.
- [x] **P5.W4 Traffic off the main thread (+ the other W1 one-offs).** Measured 2026-10-01, harness only (driver scratchpad `pupdrive/p5t/h-traffic.js`: first city → Generate → `restore()` → traffic off/on; "before" = the same driver on the pre-change source, 2 runs; "after" = 3 runs).
  - **Worker precompute:** the centre job (`world.centre`, new option `traffic`) runs `precomputeTraffic` (`src/world/traffic-precompute.ts`) on the FINISHED graph after the drape/chunk passes: `computeTraffic` (mover specs: routes, archetype geometry, consists, sky / weather / wildlife) + the routing net as plain data (`roadNetData`: nodes, edges, the street plan as `StreetPlanData` — roads, slots, band claims). Mover geometry is copied once per SOURCE geometry and transferred (`transferTraffic` shares the groups' copy map; archetype sharing survives → one upload per archetype). Requested only where the swap will spawn movers (`wantsTraffic` + traffic on / City mode); tiled and `traffic: false` cities skip it.
  - **Adoption:** the swap hands it to `WorldTraffic.preload(graph, tp)`. The first spawn on that graph takes it if the params fingerprint still matches (`trafficParamsKey`; a selective regen in between changes params in place → stale → computed main-side as before), and seeds the adopted graph's caches with `adoptRoadNet` / `adoptStreetPlan` (the plan object is rebuilt over the data by the same `assemblePlan` the builder uses; its lot index for `frontageAt` / `inBuilding` is rebuilt lazily). No main-thread road net / street plan (~50 ms) or `computeTraffic` (~50–95 ms) after a city appears.
  - **Main-thread staging (no worker):** two pseudo-steps at the end of the queue (`__traffic-net`, `__traffic-specs`), each in a staging frame of its own, never the swap frame.
  - **Sliced spawn:** `_spawnTrafficSoon` → `WorldTraffic.startSliced(budget)`. `spawn()` is now a step generator (`_spawnSteps`): the synchronous `spawn()` / `start()` run it in one go (unchanged behaviour); the sliced run creates the mover groups a few per frame under `WorldManager._sliceBudgetMs()` (the reassembly budget: 6 ms, 3 ms while the stream pump / reassembly queue is busy), HIDDEN (each mesh's own visibility recorded), pre-uploaded (`warmGroupGeometry3D`), and OUT of `_groups` (the zoom LOD / glow / crowd walks never see a half-spawned mover). The last step reveals everything at once (visibility restore, emote / headlight-pool hides, parked-train hide, `_groups` in creation order, epoch bump) and then runs the unchanged tail (crossings, signals scan, glow flag, render style, `tick(0)`). A `start()` / `spawn()` mid-slice finishes it synchronously; `stop()` / despawn / a world clear cancels it and removes its hidden groups. Headless (no rAF) = `start()`.
  - **Fixed on the way:** `despawn()` removed only `meshes[0]`'s group per mover, so every articulated consist leaked its other cars' groups (+14 groups per traffic off/on in the harness city). It now removes every group of every mover in one `_groups` pass.
  - **Swap frame:** `_finishAsync` removes the old city's groups SILENTLY (the swap already notifies once); the per-group host scene-graph walk (connectors) was ~30 ms of the swap frame.
  - **Text signs:** `_addTextSigns` still adds the plates in the swap, but NEW sign canvases rasterize time-sliced from the next frame under the same budget (cached ones apply at once); a newer batch abandons an older one (`_signGen`). Plates show their base colour for those frames, as they already did while `createImageBitmap` resolved.
  - **GARP placeholder skins:** when a city build starts (`onCityBuildStateChange` building), ShapeManager pre-encodes the built-in vending / crate / clutter placeholder PNGs in the 'atlas' worker (`_prewarmGarpPlaceholders`: the same draws captured with registration skipped, one pool family per frame, `composeAtlasSheet` of the drawn bitmap → PNG) into a per-recipe cache that `_ensure*Garp` reads. A miss (no OffscreenCanvas, or the build won the race) encodes synchronously exactly as before. Same pixels; only the PNG byte stream may differ.
  - **A/B:** `salsaWorld.manager.trafficOffThread = false` (no precompute + the old one-shot spawn two frames after the reveal); `salsaWorld.manager._traffic.warmStaged = false` (no pre-upload of staged mover groups). Diagnostics: `_traffic.lastSpawnPrecomputed`, `_traffic.sliceStats` (`{ slices, maxMs, movers }`).

  | Action (harness) | Before: long tasks ≥ 50 ms after the call | After |
  |---|---|---|
  | First city `enterMode(p)` | 4–6 tasks, worst 172–227 ms, sum 615–725 ms (spawn 100–120 ms, GARP encode ~80 ms, swap + text signs ~80 ms, road net ~75 ms) | 3–6 tasks, worst 90–99 ms in 2 of 3 runs (one run had a 418 ms first task), sum 218–765 ms; spawn = 8–9 slices, longest 32–42 ms (the reveal: `tick(0)` + time-of-day dressing) |
  | Generate (`enterMode` on an existing city) | 4–5 tasks, worst 118–121 ms, sum 368–465 ms | 2–3 tasks, worst 65–69 ms, sum 122–190 ms; spawn = 6–7 slices, longest 11–19 ms |
  | Document load (`restore()`) | 3–4 tasks, worst 118–177 ms, sum 250–423 ms | 1 task, 66–121 ms; spawn = 5–7 slices, longest 11–18 ms |
  | Traffic toggle on (sync `startTraffic`, unchanged path) | call 59–60 ms | call 83–127 ms (still main-thread `computeTraffic`; machine noise) |

  - **Remaining after a city appears:** the renderer's first frames with the new meshes (`uploadMeshInstances` / `_buildDrawLists`, ~45–90 ms), `_cacheCityBounds` (~20 ms, next frame), `frameAllMeshes` in City-mode entry (~15–30 ms), and the spawn's reveal slice (`tick(0)` places every mover, ~20 ms, + the forced glow re-dress ~12 ms on a first city). Some runs showed 0.4–1.5 s rAF gaps with NO long task (GPU / machine contention; the pre-change baseline had them too, 640–757 ms). They were not reproducible.
  - **Unchanged:** the explicit traffic toggle and selective-regen respawns (weather / clouds / railway …) still `start()` synchronously (~60–120 ms; the graph's road net is already cached there).
- Tests: `src/services/managers/world-first-city.test.ts`, `src/services/managers/world-traffic-precompute.test.ts` (P5.W4).
  - P5.W4: the centre job's precompute == the old main-thread `computeTraffic` + `roadNet` on the adopted clone, byte-for-byte (geometry bytes included), no buffer transferred twice, archetype sharing kept, the graph untouched; tiled / traffic-off build none; an adopted net answers every plan / net / routing query (`of`, `side`, `onSide`, `free`, `frontageAt`, `at`, `inBuilding`, `dry`, `carLeg`, `walkLeg`, `walkNext`) like a fresh one; a sliced spawn over a precompute == `start()` (movers, meshes, `_groups`, then 20 s of sim), hidden and out of `_groups` until the reveal; a stale precompute is ignored; `start()` mid-slice drains it; `stop()` mid-slice removes its groups.
  - P5.W1: async enter returns at once and defers the setup to one reveal; the same city as the sync build; same-params join / different-params supersede (merged); exit before reveal; headless stays sync.
  - P5.W2: main-thread async tiled centre == sync centre and graph; worker tiled centre job == sync centre.
  - P5.W3: a sliced incremental pass == a one-shot pass, material by material.
- **Host (Frogmarks):** no change is required.
  - `openWorldPanel`'s follow-up `updateCity` with the same params now joins the in-flight build. If it sends different params, it supersedes the build (still async, but restarted). Sending the same params, or skipping that call right after `enterCityMode`, avoids the restart.
  - The existing `onCityBuildStateChange` pill shows "Building city…" for the first build ('load') and "Updating city…" for the Generate button ('edit').
  - Panel code that reads engine state right after `enterCityMode` sees the pre-reveal state until the reveal: `hasWorld` is false, and lighting / traffic flags are not yet applied. `regions` is already correct. Frogmarks' current `openWorldPanel` reads only `regions`, the style and `overrideGlobalLighting`, so it is fine.

## P6 — Street level and Play (walking / flying through the city)

Measured 2026-10-01. User report: "walking around the city runs at 20–40 fps instead of 60".
- **Harness:** the Salsa vite harness, live source, seed-3 grid city, headless Chrome + WebGPU (d3d11) on the RTX 2070 SUPER.
- **Two scenarios, 15–25 s each:**
  - **Play:** third person with the auto player, walking down a street with periodic turns (`setPlayInput3D`).
  - **Fly:** free 3D at 1.6 m, moving 8 m/s with a ±35° yaw sweep.
- **Drivers:** scratchpad `pupdrive/p6/`:
  - `walk.js`: per-frame dt, renderer CPU, main-thread busy, `frameStats`, counters, long tasks, GC; with `GPU=1`, per-pass timestamps; with `PROF` / `HEAP`, CPU and allocation profiles; with `TRACE=1`, per-method attribution of the worst frames.
  - `ab.sh`: interleaved on / off A/B.
  - `rays.js` / `raycheck.js`: Play ray census and the equivalence check.
  - `gpuab2.js`: static-view GPU toggles.
  - `shot.js`, `mmverify.js`, `mmreal.js`: pixel A/B.
  - `fm-walk.js`: the real app.
- **GPU timings are only trustworthy with the GPU otherwise idle.** Other agents' headless browsers pushed it to 100 % (`nvidia-smi`) for long stretches, which doubled every pass time. The drivers wait for an idle GPU first (`p6/gpuidle.sh`).
- **Treat the shipping app as a separate build.** The real Frogmarks app (`https://localhost:44452`) runs the dist built 2026-09-30 22:50. That build predates P5 and everything below, so the real-app numbers are "before" only. Re-run `node p6/fm-walk.js` after a dist rebuild.

### Measured (before)

| Where | Frame p50 / p95 / max | Notes |
|---|---|---|
| Harness Play, 1540×900, uncapped | 15.7 / 28.1 / 137 ms | Render CPU 8.3 ms. Play collision rays **4.5 ms a frame**. 97 GCs in 20 s (2.6 MB allocated a frame). Far shadow map re-rendered on 481 of 1,155 frames. |
| Harness fly (free 3D), 1540×900 | — | Far shadow map re-rendered on **~85 % of frames**: 4,650 draw calls, 5.7 M tris submitted. |
| Real Frogmarks Play, 1600×950, vsync | 16.7 / 23.2 / 689 ms | Main colour pass 14.3 ms GPU; 11 frames > 33 ms in 20 s. Old dist. |
| Harness Play, **2500×1390** (a full-screen window) | uncapped 21.8 / 38.6 ms → **30 fps under vsync** | **GPU-bound:** main colour pass 19–21 ms. This is the user's 20–40 fps. |

**Culling is working.** At street level:
- the camera culls ~2,900 of ~4,700 meshes;
- 1.6–2.2 M of 4.6 M triangles survive;
- distance LOD hides 240–650 meshes.

**Triangles are not the GPU limit either.** Hiding the whole crowd (0.93 M of the 1.9 M visible tris) or all trees left the main pass unchanged. Half resolution cut it 2.7×. The main pass is pixel-bound.

**Where the CPU went (Play, per frame, `TRACE` / profiles):**
- **Collision rays, ~4.5 ms.** ~10 rays a frame: the 5-ray camera bundle, the knee / mid / head wall rays and the ground ray.
  - Each ray tested **~520 broadphase candidates** with a matrix inverse plus a BVH walk.
  - A chunked city layer's box is a whole 20–30 m cell, so the character stands inside ~200 of them. The prefilter can't reject those.
  - Each BVH walk searched the entire ray, even for a 2 cm wall ray.
  - Walking into a new block built the BVH of every candidate at once: a **~100 ms hitch**, repeatable in every off-run.
- **`_buildDrawLists` ~2.3 ms**, traffic tick ~1.8 ms, instance upload ~1.3 ms, main-pass recording ~1.1 ms.
- **After Play's Stop:** the skirt-steer callback walked the whole scene graph every frame (~0.4 ms) looking for the auto player's detached skirt.
- **Allocation:** 0.8–0.9 MB a frame came from `_buildDrawLists` (inlined helpers, Maglev-only tier) and ~80 MB per 10 s from `geometryKey` template strings.

**Where the GPU went (main colour pass, static street view, 2500×1390, idle GPU; each toggle A/B'd):**

| Toggle | Main pass |
|---|---|
| Baseline | 19.8–21.7 ms |
| Shadow receiving off | −6.5 ms |
| PCF 3×3 instead of 5×5 | −3.2 ms |
| 1 cascade instead of 2 | −2 ms |
| Front-to-back draw order | −1.6 ms |
| IBL / fog / point lights / FXAA | ≈ 0 |
| Resolution 0.75 | 13.4 ms |
| Resolution 0.5 | 7.7 ms |

### Fixes

- [x] **P6.1 Play collision rays.** All the changes are confined to the ray caster (`MeshPicker.raycastWorld`, `MeshBVH`, the new `src/game/collision-hood.ts`) and `Scene3DManager._rayCaster` / `_buildCollisionGrid`. `third-person-camera.ts` and `collision-math.ts` are untouched.
  - **World-box prefilter:** a slab test against a cached per-mesh world AABB, keyed by matrix version and geometry. Misses and boxes entered beyond `maxDist` are dropped before the matrix inverse.
  - **Nearest-box-first walk:** candidates sorted by box entry distance; the walk stops once a box starts beyond the best hit.
  - **Capped BVH walk:** `MeshBVH.intersect(..., tMax)` prunes nodes entered beyond the cap. The world-to-local conversion of the cap is exact for an affine model matrix.
  - **Pure-translation fast inverse:** world-baked city meshes skip the general 4×4 inverse.
  - **Per-list box cache:** a list sent again (the hood list below) costs no map lookups.
  - **`CollisionHood`:** one box around the character, holding the grid candidates that really have a triangle inside it (`MeshPicker.meshMayTouchWorldBox`, `MeshBVH.overlapsBox`).
    - A bounded ray whose segment lies inside the box tests only that list. Unbounded rays (the ground search) keep their own list.
    - Movers (`cheapBounds`) are always kept. Meshes without a BVH yet answer from their box, so a rebuild never builds BVHs: 4–6 ms, once every couple of seconds of walking.
  - **Equivalence:** `raycheck.js` cast every Play ray both ways (prefilter + hood vs the pre-P6 full walk) while walking, strafing and turning: **7,497 rays, 0 differences** in hit distance and normal. Tests: `mesh-picker-raycast.test.ts` (random scenes and rays, coplanar ties, moving meshes, capped BVH = uncapped within the cap, `overlapsBox` never misses) and `collision-hood.test.ts`.
  - **Result:** rays 4.5 → **1.6–2.3 ms a frame** (candidates tested a frame 4,930 → ~800). The **~100 ms new-block hitch is gone**.
  - **A/B switches:** `MeshPicker.worldBoxPrefilter`, `Scene3DManager.collisionHood`.
- [x] **P6.2 Far shadow box slack** (`Renderer3D.SHADOW_FOLLOW_SLACK_TEXELS`, default 16; 0 = the old behaviour).
  - **What it was:** the far map's box followed the camera focus texel by texel. At street level a texel is ~0.1 m, so walking re-centred it every 1–4 frames and flying every frame. Each re-centre re-rendered the whole far map (~1,250 draws, 1.5 M tris) and voided the P4.2 static cache.
  - **Fix:** the box now re-centres only once the focus drifts 16 texels (~2 m) from its centre. The centre stays on the same texel lattice. Only the coverage edge, 100+ m away, trails the focus. A box resize always re-centres.
  - **Play, 15 s:** direct far renders 221 → **6**, static renders 161 → 28, far-map tris −68 %.
  - **Fly:** direct renders 800 → **47–59**; draw calls 4,650 → **2,830**; tris submitted 5.7 M → **3.7 M**.
  - **Pixels:** 2 of 3 street views identical. One differs by max 34/255 on 336 px (0.02 %) on distant facades. That is the same sub-texel variation every texel re-centre already produced while walking: world X/Z snapping isn't exact in light space.
- [x] **P6.3 Exact PCF shortcut** (`src/renderer/3d/shadow-minmax.ts`; `Renderer3D.shadowMinMax`, default on).
  - **Build:** after a frame writes the far map or the cascades, two small compute passes build, per 8×8 tile, the min/max stored depth over the tile and its neighbours.
  - **Shader:** `sampleShadow` / `sampleCascade` read one texel of that. A reference below the min passes every tap of the 5×5 kernel, so the PCF result is exactly 1; at or above the max it is exactly 0. Only shadow edges run the full PCF.
    - It applies only when the kernel fits a tile (`radius × softness + 2.5 ≤ 8`) and the reference is inside 0..1.
    - A map whose rebuild can't run (pipeline compiling) turns its shortcut off. It is never stale.
  - **Bindings:** the shadow bind group gains bindings 3–5.
  - **Verified bit-identical:**
    - Time frozen, 3 street views, shortcut on vs off: 0 differing pixels.
    - A shader-patched run that computes both the shortcut and the full PCF and paints any mismatch white: none.
  - **Cost and gain:** builds 0.13 ms per map update. Main pass −1.3 to −1.6 ms at 2500×1390 (19.8 → 18.2, 21.7 → 20.4). In a walk the gain is within run-to-run GPU noise.
  - **Why it isn't bigger:** a sloped receiver's own depth varies across the 24-texel tile window by more than the bias, so many lit pixels still take the full path. A shader-patched 1-tap PCF shows the taps still cost ~3.7 ms.
  - Registered in `wgsl-static-check`.
- [x] **P6.4 CPU hygiene:**
  - **Skirt-steer callback:** it holds its garment mesh and skips detached ones, so there is no scene walk per frame after Stop.
  - **`Mesh3D.geometryKey`:** caches `custom:<id>`.
  - **World AABB cache:** the renderer's entry is also held on the mesh (`Mesh3D._r3Aabb`, owner-, liveness- and identity-checked) and updated in place. A moving mesh used to get a new object every frame.
  - **`_buildDrawLists`:** reads the instance slot once and the caster uid from the dynamic-caster lookup it just did.
- [-] **Front-to-back opaque order: dropped.** It gains −1.6 ms at 2.5 K, but coplanar (z-fighting) layers resolve differently: 53 px > 8/255 in a street view. The same applies to a depth pre-pass with 'equal'.
- [-] **Instance upload merge gap: unchanged.** Smaller runs (16 slots) made the upload slower (1.6 → 6.4 ms): `writeBuffer` calls cost more than the bytes.

### Results

**Harness, 1540×900, interleaved A/B: all P6 switches off vs on, idle GPU.**

| Scenario | Off | On |
|---|---|---|
| Play, vsync: main-thread busy p50 / max | 11.1–11.9 / **103–104 ms** | **8.6 / 16.4–16.8 ms** |
| Play, vsync: dropped frames per 15 s | 10–11 | **0** |
| Play, uncapped: frame p50 / p95 / max | 10.5–10.9 / 16–17 / 102–105 ms | **8.2–9.5 / 13.5–17.3 / 23–28 ms** |
| Play, uncapped: fps | 92–95 | **105–122** |
| Fly, vsync: frame p50 / p95 | 16.6 / 21–22 ms | 16.6 / 21–22 ms (both 60 fps) |
| Fly, vsync: draw calls / tris submitted | 4,650 / 5.7 M | **2,830 / 3.7 M** |

The "off" column already includes P6.4, so it is a bit better than the true before: Play uncapped was 15.7 / 28.1 / 137 ms at the start of the session.

**At 2500×1390 the GPU is still the limit.** The main pass is 18–20 ms, so Play and fly run ~45 fps uncapped, which is 30 under vsync. CPU work is now well under budget. 60 fps at that size needs ~−6 ms of main-pass fragment work. Every remaining lever changes the picture; measured costs are listed above:
- **dynamic resolution** (`setDynamicResScale3D(0.75)`: 21 → 13.4 ms)
- **PCF 3×3** quality tier (−3.2 ms)
- **1 cascade** (−2 ms)
- **front-to-back order** (−1.6 ms, z-fight risk)
- a **leaner shadow-receiving shader**: occupancy. With the shadow sampling compiled out, the pass is 13.9 ms.

The host could offer an automatic dynamic-resolution or "performance" toggle.

### Remaining ideas (not done)

- **Exact per-texel kernel min/max.** A separable filter over ±(r·soft + 1.5) texels instead of 24-texel tiles would let most sloped lit receivers skip the PCF. That is up to ~3.5 ms at 2.5 K, but costs ~0.5 ms per map update and 32 MB per map.
- **Static / dynamic split for the near cascades,** like P4.2. Today they re-render every frame in Play because the player animates: ~700 draws, ~0.35 ms GPU, plus CPU.
- **CPU:**
  - The traffic tick (~1.8 ms in Play) lives in `world-traffic.ts`, owned by the traffic-worker work.
  - `_buildDrawLists` (~1.7 ms) could use a per-cell hierarchical cull (P7.9).
  - The draw-list helpers stay on V8's Maglev tier (`%GetOptimizationStatus`): ~0.9 MB of boxed doubles a frame, ~7 scavenges a second.
- **`_thirdPersonCamera`** still runs a grid query plus `.slice()` every frame for a fallback list the hood usually makes unnecessary. It belongs to the third-person-camera work.

## P7 — LOD by camera height (street / rooftop / sky / far out) + opportunities

Measured 2026-10-01 in the Salsa vite harness (live source, seed-3 grid city, headless Chrome + WebGPU on d3d11, 1300×850, time of day 0.62, traffic on). How LOD works end to end, for QA and the host: `docs/ui/performance.md` §How LOD works. Drivers are in scratchpad `pupdrive/p7lod/`:
- `bands.js`: the band table
- `ab.js`: interleaved A/B against the R6.1 tiers, with screenshots
- `groups.js`: instanced-group census; `census.js`: per-family census
- `sweep.js`: fly-out and jitter flicker check
- `exper.js`: GPU attribution toggles
- `h.js`: shared helpers; `gpuprof.js`: per-pass GPU timestamps

**Bands.** The camera stands over a pavement looking down a street (1 unit = 15 m in the default city).
- **Street:** the 1.6 m street view (50° lens).
- **Rooftop:** 45 m up, looking 160 m ahead.
- **Sky:** 300 m up, looking 350 m ahead.
- **Far:** the whole world small on screen. Diorama: 3.9 × its radius away. Tiled: 135 units, just inside the tiled orbit cap.
- **Play:** third person, 72° lens.
- Free 3D (City mode exited), except the City hero and frame-all views.

**GPU numbers are unreliable on this machine today.** Other agents' headless browsers share the GPU: the same pose measured 60–196 ms main-pass GPU within one session. Triangle and draw-call counts are deterministic, so they are the primary evidence. GPU times are min-of-N, and are quoted only where they repeat.

### What was wrong (before)

- **The sky band drew more than street level.** The R6.1 aerial bias (the camera's distance to the city volume, added to every draw distance) let the whole fine-detail set through from the air.
  - 300 m up, every person, vending can, signal housing, wire and sign glyph across the city was drawn, at 1–3 px each.
  - In perspective, the zoom tiers stay all on until ~380 m altitude, so nothing else removed them.
  - Diorama: sky 2.64 M tris / 3,317 draws, against street 2.06 M / 1,674.
  - Tiled 3×3: sky **15.8 M tris / 6,798 draws** (main-pass GPU 160–200 ms), against street 10.0 M. The shadow list was 13.9 M tris.
- **PROPS was one distance for everything.**
  - 6 m trees shared 1.2 F (~820 m) with 0.3 m signal housings, pole insulators, parked-car trim and tactile paving.
  - Vending cans (0.12 m each, ~1,000 tris per machine) were the second-largest family at street level in the tiled world (0.5 M tris).
- **Heavy instanced groups were city-wide boxes.** Chunking needed ≥ 4 instances per cell, so neither the frustum nor the distance LOD could ever drop these groups:
  - A tree species variant (13 trees × ~1,500 tris) stayed 1–2 groups spanning 14–20 units of a 32-unit city.
  - The 16 vending-can groups spanned ~10 units.
- **Contact-shadow blobs were never distance-hidden.** At the tiled far view that was 0.12 M tris, under props that were already gone.
- **Checked and fine:**
  - **No hysteresis flicker.** A 60-frame ±0.3 % camera jitter at all 4 bands, in both worlds, flips no mesh more than once.
  - **Fly-out.** A 160-step fly-out flips each chunk at most twice: 1 of 2,343 meshes (diorama) and 42 of 2,833 (tiled) flip twice, because the bias re-shows facade and props detail as the camera climbs.
  - **Zoom tiers and distance LOD don't fight.** They AND together (`visible` vs `lodHidden`), each with its own hysteresis.
  - **Distance LOD applies in Play and free 3D** (bias ≈ 0.2 units, lens scale 0.57 at 72°). In Play the tiled world draws more than the free street view only because the lens is wider.
  - **2D ortho is unchanged:** identical counts old vs new at two zooms. Its zoom tiers (0.3 R basis) bind long before the new distances.
  - **The far-band "flicker" was the driver.** A first tiled run showed 300+ meshes flickering at the far band. The driver had placed the camera outside the tiled zoom-out cap (orbit radius ≤ 5 tiles × span × 1.5), which re-clamped it every frame. Inside the cap: 0 flicker.
- **Not wrong, by design:** a 3×3 tiled world never uses tile proxies.
  - With streaming follow OFF, the grid is all full.
  - With follow ON, the 9 nearest tiles get full 3D, which is all 9.
  - The proxies are flat maps, so using them for far tiles in view would drop the skyline (see P7.8).

### Fixes

- [x] **P7.1 Per-family draw distances + bias fraction.**
  - **Renderer:** `Mesh3D.drawDistanceBias` (0..1, default 1) is the fraction of the renderer's aerial bias a mesh takes. `Renderer3D` tests `drawDistance + distanceLodBias × drawDistanceBias` for meshes and array groups.
  - **Stamp:** `DistanceTier` gains an optional third element, and `assignDrawDistances` stamps it (`cityDrawDistanceBias`).
  - **Classes:** `WorldManager.cityDistanceTiers` now claims four distance-only classes before the zoom-tier regexes. The zoom tiers themselves are unchanged.
    - **Cans** (`world:vending-stock`): 0.35 × fine (~144 m), no bias.
    - **Tiny** (crowd, walkers, birds, sign-glyph geometry, wires, laundry, alley clutter, doors, steel railings, ducts, rail sleepers / rails / catenary): fine (~411 m, unchanged), no bias.
    - **Small props** (signal housings + lenses, pole insulators, parked-car trim + lenses, tactile paving, cones, manholes, post boxes, cabinets, planters, benches, bikes, banners, bollards, rail posts, tree grates / guards): fine (was 1.2 F), no bias.
    - **Thin props** (utility poles, lamp posts): 1.2 F (unchanged), no bias.
    - **Contact shadows** (`world:contact-shadow`): 1.2 F with the bias. They were never distance-hidden before.
  - **Kept on the bias,** so the aerial overview keeps its look: facade detail, the lit name plates and road signs, roof objects, trees, parked cars and the flat-map layers.
  - **Tuning:** `WorldManager.DIST_LOD_TINY_BIAS` (default 0) and `DIST_LOD_CANS` can be set from the console; `salsaWorld.distanceLod(true)` re-stamps.
  - **Tests:** `world-distance-lod.test.ts` (+1): class membership, distances, bias fractions, the stamp.
- [x] **P7.2 Heavy instances chunk alone.**
  - **Rule:** in `chunkCityLayers`, an instanced array layer whose instances have ≥ `CHUNK_HEAVY_INSTANCE_TRIS` (300) triangles each uses `minInstances = 1`.
  - **Bounds:** the 1,500-tris-per-cell target and the minimum cell width still limit the grid, so light instances (grates, planters, trim) chunk exactly as before.
  - **Diorama result:**
    - vending cans: 16 → 38 groups, max extent 9.7 → 4.8 units
    - one zelkova variant: 2 → 6 groups, max extent 14 → 5 units
    - groups in all: 365 → 432 (tiled: 2,795 → 2,868)
  - **Test:** `chunking.test.ts` (+1).

### Measured

Each cell is main-pass triangles / draw calls (all passes) / distance-LOD hidden, from `bands.js`.
- **Before:** `d0` and `t0`. The tiled far row comes from `t2old`: new chunking with the old tiers.
- **After:** `d1` and `t2`.

| Diorama (R 245 m) | Before | After |
|---|---|---|
| Street (free 3D) | 2.06 M / 1,674 / 236 | 1.87 M / 1,704 / 280 |
| Rooftop | 1.92 M / 1,889 / 236 | 1.75 M / 1,913 / 285 |
| **Sky** | **2.64 M / 3,317** / 236 | **1.58 M / 1,979** / 2,074 |
| Far | 0.51 M / 934 / 1 | 0.47 M / 905 / 60 |
| Play third person | 2.28 M / 2,339 / 241 | 2.10 M / 2,359 / 341 |
| City hero view (`ab.js`) | 3.21 M / 4,632 | **1.68 M / 2,305** |
| City frame-all (`ab.js`) | 3.20 M / 5,149 | **1.67 M / 2,730** |

| Tiled 3×3 full (38.7 M tris resident) | Before | After |
|---|---|---|
| Street | 10.0 M / 3,885 | 9.35 M / 3,820 |
| Rooftop | 9.94 M / 4,031 | 9.24 M / 3,961 |
| **Sky** | **15.8 M / 6,798**, shadow list 13.8 M | **9.50 M / 5,724**, shadow list 8.9 M |
| Far | 2.07 M / 3,740 | 1.99 M / 3,344 |
| **Play third person** | **13.2 M / 5,057** | **11.0 M / 4,769** |
| Play, turned 160° | 11.5 M / 4,287 | 9.85 M / 4,056 |

- **Main-pass GPU, where it repeated:**
  - diorama sky: 21–22 → 18–19 ms
  - tiled Play: 33 → 20–21 ms
  - tiled street: 29 → 19–22 ms
  - Tiled rooftop and sky stay at 120–180 ms in both builds (see P7.3).
- **Pictures** (`ab.js`, traffic frozen). Each value is the mean absolute difference per 255; the noise floor in brackets is the same config shot twice.

  | View | Diorama | Tiled |
  |---|---|---|
  | Street | 0.02 (0.03) | 0.04 (0.03) |
  | Second street | 0.21 (0.13) | — |
  | Rooftop | 0.07 (0.25) | 0.10 (0.35) |
  | Hero | 0.60 (0.17–0.62) | 0.53 (0.43) |
  | Frame-all | 0.61 (1.0) | — |
  | Sky | 0.72 (0.54) | 1.77 (0.77) |
  | Far | 0.19 (0.23) | — |

  - Street level is identical within noise.
  - From the sky, the removed people, cans and signal housings were 1–3 px specks.
  - The first tiled sky A/B also lost some coloured lit sign lettering and shop name plates, so those went back on the bias (final numbers above include them). The remaining tiled-sky difference is the dropped crowd, cans, signal lenses and wires: specks of 1–3 px.

### P7 opportunities (ranked, not done)

(P7.3, P7.4 and P7.5 were taken up in **P8** below. P7.3's 60–180 ms turned out to be GPU contention plus clock drops; the real rooftop / sky cost is 11.5 / 15.5 ms at 1300×850.)

Estimates come from the counts above and from hide-the-family experiments (`exper.js`). GPU gains are uncertain until re-measured on a quiet GPU.

| # | Opportunity | Evidence | Estimated gain | Effort | Risk |
|---|---|---|---|---|---|
| P7.3 | **Rooftop / sky fill cost in tiled worlds** | Main pass 60–180 ms at rooftop / sky vs ~20 ms at street, for the same 9.3 M triangles. Half render scale cut frame GPU 143 → 72 ms, so it is fragment-bound. | Up to 3–6× on the worst bands (the only band below 10 fps) | S to attribute on a quiet GPU; M to fix | Medium |
| P7.4 | **Tree far LOD**: a low-poly variant or impostor cards past ~100 m, through the near/far twin mechanism on array groups | Trees are 700–1,500 tris each. Hiding trees at tiled sky: 8.8 → 5.5 M tris, 5,357 → 3,883 draws. | −2.5 M tris at sky, −0.5 M at street | M (the generator already has branch-LOD variants) | Medium (silhouette pop at the swap) |
| P7.5 | **Shadow-caster LOD**: a shadow distance of the near cascades (~100 m) for the tiny and small classes | The shadow list is as big as the main list (8.7 M tris at tiled street and sky). Tiny + small families are ≈ 30 % of it at tiled street. | −2.5 M shadow tris at street; more on refresh frames and in the cascades | S–M | Low (coordinate with P6) |
| P7.6 | **Far twins for heavy props** | Tiled street: util poles 0.29 M, signal housings 0.36 M, roof equipment 0.34 M, lamp posts 0.20 M, car trim 0.23 M. Sky: roof equipment 0.58 M, util poles 0.51 M. | −1 M tris at tiled street and sky | S per family (the `nearTwin` path) | Low |
| P7.7 | **Cheaper far crowd**: point-sprite or impostor people past ~120 m | The far twin is still a mannequin mesh. The crowd is ≥ 1.0 M tris at tiled street (`ped-skin` alone 0.63 M), 0.3 M in the diorama. | −0.8 M tris at street, −1 M in Play | M | Medium |
| P7.8 | **HLOD far proxies for tiled worlds**: per-tile merged massing + baked emissive facades, in place of the flat-map proxies | Tiled far: 2.0 M tris / 3,344 draws, all untiered per-building layers | ~10× fewer draws and ~3× fewer tris far out; makes real far proxies possible in streaming follow | L | Medium |
| P7.9 | **CPU: hierarchical cull**: test tile / group boxes first and skip whole subtrees | The tiled world walks ~10.9 k meshes + 2.9 k groups per frame: renderer CPU 5.8–9.3 ms, `msCull` 2.4–3.5 ms | −2–4 ms CPU per frame in tiled worlds | M | Low (coordinate with P6) |
| P7.10 | **Mover detail tiers** | Traffic cars' trim and chrome are untiered: ~0.1 M of the diorama's 0.47 M far-out tris | −20 % far out | S | Low |
| P7.11 | **Resolution-aware draw distances**: scale by the canvas height | Distances assume a ~900 px tall view (R6.1 limit) | Quality at high res; ~20 % fewer tris at small canvases | S | Low |

Notes on the table:
- **P7.3**
  - The cause is not attributed yet. In one run, hiding the transparent layers (water, glass, clouds, void grid, apron) took the main pass from 154 to 86 ms.
  - Suspects: transparent overdraw, the procedural ground and water shading over a mostly-ground view, and quad overshading from sub-pixel triangles.
  - Possible fixes: an altitude-driven render scale, cheaper far ground and water shading, impostors.
- **P7.5**
  - The far map's texels (~0.4 m and up) cannot resolve the tiny and small classes.
  - Tiny + small at tiled street: the crowd ~1.2 M, signals 0.36 M, wires 0.26 M, car trim 0.23 M, railings 0.22 M, insulators 0.19 M, and more.
  - Build it as a `shadowDrawDistance` beside `drawDistance`. The P4.2 static signature already tracks set changes.
- **P7.6:** a utility pole is ~1,500 tris, a lamp post ~2,200, a roof-equipment set ~2,000.
- **P7.11:** at 4K the distances cut ~2.4× too early, which shows. At 720p they cut too late, which wastes work.

## P8 — GPU: rooftop / sky fill cost (P7.3), far tree crowns (P7.4), shadow LOD (P7.5)

Measured 2026-10-01 in the Salsa vite harness: live source, seed-3 grid city, tiled 3×3 (`tiles(1, 'full')`), headless Chrome + WebGPU (d3d11) on the RTX 2070 SUPER, 1300×850, time of day 0.62, traffic frozen. Poses are the P7 bands (`p7lod/exper.js` placement): street (pick 0, a covered shopping street), rooftop (45 m up), sky (300 m up), far (the whole world small).

Drivers are in scratchpad `pupdrive/p8/`:
- `lib.js`: boot, the world and poses. The live render loop is suspended for the whole session, and frames render only on request.
- `abtime.js`: paired A/B GPU timing in one page call. It warms up for 1.2 s, then runs K rounds of (A frames, B frames) back to back, and reports the median main pass and the median paired difference.
- `attr4.js`: attribution by hiding families and toggling material flags.
- `ab8.js`: each P8 switch OFF / ON / OFF again per pose. It saves screenshots, pixel diffs against the noise floor (the OFF / OFF2 pair), paired timings and the caster counts.
- `crop.js`: zoomed side-by-side crops (A | B | diff ×4).
- `gpuprof-p1.js`: the P1 timestamp injector, fixed because the engine now requests `timestamp-query` itself (GpuFrameTimer). The old injector silently stopped reporting.

### Why the P7 numbers were wrong

**The 60–180 ms rooftop / sky main pass in P7 was measurement, not rendering.** Two things inflated every GPU time on this machine:
- **Other GPU users.** Other agents' headless browsers and a desktop Teams call (7–18 % on its own) share the GPU, and the P7 waits checked utilisation only at the start.
- **The clock governor.** A driver that waits for each frame to finish leaves the GPU idle between frames, and the core clock then drops (1.2 GHz instead of 2.1 GHz boost, read with `nvidia-smi`). The same pose measured 6–31 ms within one session that way.

`abtime.js` keeps 2 frames in flight and pairs A and B within a few hundred ms, so the drift cancels. The control experiment (A = B) reads 0.05–0.3 ms.

On an idle GPU the main colour pass costs, before P8:

| Band | Main pass | Tris drawn / draw calls |
|---|---|---|
| Street | 7–8 ms | 7.7 M / 3,830 |
| Rooftop | 11.5–12 ms | 7.4 M / 3,970 |
| Sky | 15–15.5 ms | 8.0 M / 5,690 |

So sky costs about 2× street, not 6–9×. It is still pixel-bound: half resolution halves it.

### Root cause of the rooftop / sky premium

From the air the screen fills with the expensive materials, and the frame holds 8 M triangles, mostly sub-pixel. Paired A/B at sky, main pass, before P8:

| Experiment | Δ main pass | Share |
|---|---|---|
| Hide all trees (3.3 M tris, leaf cards with alpha cut-out) | −4.1 ms | 26 % |
| Procedural ground shading off (`groundShade`) | −2.5 ms | 16 % |
| `windowsPattern` run for every *non-facade* patterned surface (fixed by P8.1) | −2.0 ms | 13 % |
| Window facades → plain (`patternMode 'windows'` off) | −0.8 ms | 5 % |
| Transparent list empty (lamp pools, contact shadows, clouds) | −0.7 ms | 4 % |
| Shadow LOD on the main pass | −0.2 ms | — |

Notes on the rows:
- **Ground at street:** the same ground costs −2.2 ms of ~8 at street. Ground alone, with everything else removed, is 2.2 ms.
- **Transparent at street:** ≈ 0. The P7 "154 → 86 ms with transparent layers hidden" was contention noise.
- **Every patterned mesh, not only facades:** `PATTERN_BLOCK_FULL` runs `windowsPattern` unconditionally, because its fwidth calls need uniform control flow. Ground, roofs and paving therefore evaluated all six facade materials (brick, concrete, tile, siding, plaster, panel) on every pixel, only to read its pixel footprint (`.w`).
- **Facade wall pixels:** `windowShade` ran the full interior-mapped room trace, the reveal and the glass for wall pixels too. These pixels sit outside every opening, and their result is `mix(wall, glass, 0)` = the wall.

### Fixes

- [x] **P8.1 Shader fast paths: bit-identical** (`Renderer3D.shaderFastPaths`, default on; uniform `scene.cascadeBias.z`).
  - **`windowsPattern`:** every fwidth is now taken up front, in uniform control flow. Two shortcuts follow:
    - A non-facade mesh (`patMode != 6`) returns `(0, 0, 0, footprint)` straight away. Nothing reads its `.xyz`.
    - A facade evaluates only its own material. The six materials are now pure functions, `wpBrick` … `wpPanel`, and the slow path computes all six and selects one, exactly as before.
  - **`windowShade`:** a wall pixel (`winWL.x == 0`) returns the wall before the room trace. It has no derivatives below that point.
  - **Pixels:** sky diff mean 0.27 against a 0.30 noise floor; rooftop 0.06 against 0.17.
  - **Gain:** −1.5 to −2.0 ms at sky, −1.4 to −1.8 ms at rooftop.
- [x] **P8.2 Far tree crowns** (`Renderer3D.groupTwins`, default on; P7.4).
  - **Build:** `city-foliage.ts` `farCrownGeometry` keeps every 3rd leaf / tip card (`TREE_FAR_KEEP`) of each tree variant and grows each kept card by √3 about its own centre. Positions, normals, uvs and colour are unchanged.
    - Cards are emitted clump by clump along a golden spiral, so every clump keeps a spread of cards, and the crown keeps its coverage and outline.
    - Trunks are not twinned.
  - **Swap:** past 160 m (`TREE_TWIN_M`), with the lens scale and 10 % hysteresis.
  - **Registration:** a `'twin'` tier in `WorldManager.cityDistanceTiers`, so the Performance panel lists it as a family. `world-lod-settings` keeps the chip multiplier off it.
  - **Renderer, the ArrayGroup instances:**
    - New group-twin code in `_buildDrawLists` (`_lodTwinNearGroups`).
    - The decision uses the instances' ORIGIN box (`_agAABBCache.org`), which is identical for the two twins of a cell.
    - It runs before every other skip, so the two twins stay in lockstep.
  - **Renderer, instance 0** (the source mesh, drawn by the mesh loop):
    - It takes the mesh-twin path (`lodTwinInstanced`, `lodTwinOffNear`).
    - Both crowns carry one union local box (`geometry.bounds`), so the near and far instance 0 decide alike.
  - **Chunking:** `chunkCityLayers` splits a twin pair's transforms on ONE grid. `nearTwin.gridTris` fixes it from the near twin's triangle count, and `chunking.test.ts` checks it.
  - **Results:**
    - Sky: tris 7.98 → 6.50 M, main −1.5 ms (−2.0 in the attribution run), all passes −3.5 ms (the trees cast too).
    - Rooftop: −0.6 ms, 7.40 → 6.58 M tris.
- [x] **P8.3 Shadow LOD** (`Renderer3D.shadowSizeLod`, `SHADOW_LOD_TEXELS = 1`, default on; P7.5).
  - **Feature sizes:** the P7 sub-metre classes get a feature size, the fourth element of their distance tier (`WorldManager.SHADOW_FEATURE_M`): cans 0.12 m; tiny clutter 0.4 m; small street furniture 0.4 m; poles 0.3 m. The stamp is `Mesh3D.shadowFeatureSize`.
    - The crowd is 0.8 m. A person is 0.5 m across, but its shadow runs ~1.7 m along the sun. A first run at 0.4 m showed person shadows changing in the 12 m-high "low" views, where the far map's texels are ~0.43 m.
  - **Rule:** a caster leaves a map when two tests agree. The far map and each near cascade decide separately (`shadow-lod.ts`).
    - **Texel:** its feature size is under one texel of that map.
    - **Screen guard** (`SHADOW_LOD_SCREEN_PX = 2`): its feature is under 2 px at the camera's distance to the city volume (`distanceLodBias`).
      - That distance is 0 at street and roof level, so nothing is skipped there.
      - The guard is constant per frame, so the skipped set, and with it the cached far map, changes only with the camera's height.
      - Without the guard, the 12 m-high "low" views (far-map texels ~0.43 m) lost railing / clutter shadows right beside the camera: diff 0.26–0.37, max 18–48 levels, noise floor ≈ 0.
    - A far-map skip also stays out of the P4.2 static set and signature, so the cached map re-renders exactly when the set changes.
    - The near cascades keep every caster they can resolve.
  - **Street level:** nothing is skipped. The far map's texels there are ~0.12 m.
  - **Sky:** 360 casters skipped. The far map's tris drop 7.59 → 6.65 M (all P8 together: → 5.15 M, −32 %). Pixel diff 0.20–0.34 against a 0.16–0.45 noise floor.
  - **Rooftop and the low views:** nothing is skipped (the guard), and they are identical.
  - **Counters:** `shadowLodFar` / `shadowLodCascade` in `getFrameStats3D()`.
- [ ] **P8.4 Ground relief LOD** (`Renderer3D.groundReliefLod`, uniform `scene.cascadeBias.w`): **built, default OFF.**
  - **What it does:** the procedural ground's relief normal comes from heights a grout width (2–9 mm) apart. Between a 4 and an 8 cm pixel footprint it fades out, and beyond that the four height samples are skipped.
  - **Measured:** sky −1.2 ms, diff 0.32 against a 0.62 noise floor.
  - **Why off:** it is not bit-identical. It removes the sub-pixel relief grain on distant roads, so it is left for a look review.

**Dropped / not done (P6 leftovers):**
- **Near-cascade static / dynamic split:** not done here; done in P14.2 (with a box slack). The near cascades follow the camera, texel-snapped, so in Play and fly their box moves every few frames, and a static cache would be voided almost as often as it is built. P6 measured ~0.35 ms GPU and ~700 draws there.
- **Exact per-texel PCF min / max:** not done. It is not cheap in memory: 32 MB per map, plus ~0.5 ms per map update.

### Results

The tables come from `ab8.js` on the tiled 3×3 world at 1300×850, idle GPU. Timings are the paired-A/B medians (5 rounds × 7 frames). "P8" = fast paths + far crowns + shadow LOD: the defaults. The relief LOD stays off.

**Per altitude band, P8 off → on:**

The band rows below are from the final code (`ab8u.log`, with the screen guard). The far row and the per-switch table are from the first full run (`ab8.log`), before the guard.

| Band | Main pass | All GPU passes | Tris drawn | Far shadow map tris | Pixels: mean diff (noise floor) |
|---|---|---|---|---|---|
| Street (pick 0) | 6.4 → 6.0 ms (−0.4) | −0.5 ms | 7.68 → 6.92 M | 1.92 → 1.90 M | **0 (0): bit-identical** |
| Low (12 m up, looking 400 m along / across the street) | 7.1 → 6.2 / 7.3 → 7.0 ms | −0.9 / −0.7 ms | 7.81 → 7.00 M / 7.34 → 6.76 M | 8.27 → 7.46 M / 6.60 → 6.01 M | 0 (0) / 0.005 (0.007) |
| Rooftop | 10.8 → 8.9 ms (−1.9) | −1.9 ms | 7.40 → 6.58 M | 7.52 → 6.79 M | 0.20 (0.04–0.31): far-crown card edges |
| **Sky** | **15.4 → 12.1 ms (−3.3, −21 %)** | −3.3 ms | 8.21 → 6.72 M | **7.59 → 5.15 M (−32 %)** | 1.2 (0.46): far-crown card edges |
| Far | 3.4 → 3.2 ms | −0.8 ms | 1.98 M (trees already zoom-hidden) | 1.73 M | 0.03 (0.04) |

**Per switch (main-pass Δ):**

| Switch | Street | Rooftop | Sky | Far | Pixels |
|---|---|---|---|---|---|
| `shaderFastPaths` | −0.2 ms | −1.8 ms | −1.5 ms | −0.2 ms | at the noise floor everywhere |
| `groupTwins` (far crowns) | −0.2 ms | −0.6 ms | −1.5 ms (all passes −3.5) | 0 | street 0; rooftop 0.45 (0.30); sky 0.89 (0.59) |
| `shadowSizeLod` | 0 (nothing skipped) | 0 (nothing skipped, with the guard) | −0.2 ms (360 casters, far map −0.94 M tris) | 0 | sky 0.20–0.34 (0.16–0.45); low views 0 with the guard |
| `groundReliefLod` (off) | 0 | −0.4 ms | −1.2 ms | −0.3 ms | rooftop 0.18 (0.11): above the floor, so it stays off |

**Pictures:** `ab8-<pose>-<switch>-{OFF,ON,OFF2}.png`, with crops from `crop.js`.
- The far-crown differences above the noise floor are leaf-card edges inside crowns past 160 m. Silhouette and colour are unchanged: `crop-rooftop-trees.png` shows the worst 160×100 window, a crown whose card pattern differs a few pixels at the edge.
- The noise floor itself is the slow cloud / haze drift. `performance.now` is frozen for the shots, but the sky band still shimmers.

**Decision:** `shaderFastPaths`, `groupTwins` and `shadowSizeLod` default on. `groundReliefLod` defaults off.

**Where the sky band stands now.** At 12.1 ms against street's ~6 ms, the remaining premium is:
- the ground shading (−2.5 ms if it were free);
- the trees' fragments: the far crowns keep the crowns' pixel coverage, so the alpha-cut card overdraw stays;
- 6.5 M mostly sub-pixel triangles.

Next levers, in order:
- a real impostor (2 triangles per tree) past ~400 m;
- the ground relief LOD, after a look review;
- trunk / limb thinning in the far crown (the trunk is now half a far tree's triangles);
- the HLOD proxies of P7.8.

**Tests:**
- `city-foliage.test.ts` (+2): far-crown pairing and transforms; `farCrownGeometry`.
- `chunking.test.ts` (+1): twin grid; the whole-city draw count counts a twin pair once.
- `world-distance-lod.test.ts` (+1): shadow feature sizes and the stamp.
- `world-lod-settings.test.ts`: tree twins are tier-driven.
- `shadow-lod.test.ts` (new).
- `ground-surfaces.test.ts`: the relief string.
- WGSL is verified in the headless browser (every pose rendered, no GPU errors) and by `wgsl-static-check.test.ts`.

## P9 — CPU and geometry: prop far twins, a third crowd tier, mover detail tiers, hierarchical cull, CPU hygiene

Measured 2026-10-01 in the Salsa vite harness (seed-3 grid city, headless Chrome + WebGPU d3d11, 1300 × 850, time 0.62). Drivers are in scratchpad `pupdrive/p9/`:
- `p9ab.js`: all of P9 on vs the pre-P9 build in one session (`salsaWorld.propTwins(false)` regen + `salsaWorld.p9(false)`). Traffic and the live crowd are frozen, screenshots go to `<tag>-<pose>-{ON,ON2,OFF,OFF2}.png`, and `pixdiff.py` compares them against the noise floor.
- `bench.js`: `_buildDrawLists` timed on the frame's own mesh list, 60 calls per config, interleaved. This isolates its CPU cost from the shared GPU.
- `abtog.js`: interleaved A/B of any runtime switch.
- `tab.js`: traffic tick A/B plus an equivalence check.
- `heap.js`: per-frame allocation sampling.
- `prof.js` / `tprof.js`: line-level CPU profiles.

**Evidence and baseline.**
- The GPU was shared with other agents and was 100 % busy most of the session. Triangle and draw counts plus CPU timings are the evidence.
- The "OFF" column already contains the unconditional refactors (indexed loops, scratch arrays), so the true before is slightly worse than shown.

### Fixes

- [x] **P9.1 Far twins of the heavy props** (P7.6; `src/world/lod-accum.ts`).
  - **How it builds:** `TwinAccum3D` is an `Accum3D` that also forwards every primitive call to a `LoAccum3D`.
    - A builder swaps `new Accum3D()` for `twinAccum(distM, unitsPerMetre, p.propTwins)`.
    - Its full output is bit-identical (tested); `.lo` holds the far twin.
    - `withFarTwin` turns the layer into a near / far pair with the same name and material, so every name-keyed rule still holds.
  - **The cheap shape:**
    - Parts under ~1.2 px at the swap distance are dropped: step bolts, braces, clamps, thin rods.
    - Ring sides drop to the fewest that keep the polygon within 1 px of the circle (6 at most).
    - Lathe profiles are Douglas-Peucker simplified at half a pixel. Sweeps keep every other ring. Chamfered boxes become plain boxes.
    - Wheel faces, which are raw triangles, are replaced by one flat disc each (`fullOnly` / `loOf`).
  - **Families and swap distances** (`PROP_TWIN_M`):
    - utility poles + insulators: 45 m
    - signal housings: 45 m
    - lamp posts: 45 m
    - roof plant on detailed buildings: 60 m
    - parked-car trim + chrome: 35 m
  - **Far / full triangles** (seed-3 diorama): poles 35 %, signal housings 47 %, car trim 59 % (the rest is body-loft strips), car chrome 14 %.
  - **Chunking:** a pair splits like the plain layer.
    - `nearTwin.gridTris` makes `nearTwinGrids` use the plain layer's own `chunkGridFor` grid.
    - Every layer has its own key: poles ≠ insulators, trim ≠ chrome, roof plant per detail cell.
    - So each family has exactly 2 × its old mesh count, exactly one twin of a cell draws, and draw calls are unchanged.
  - **Shared twin boxes:** `chunkCityLayers` gives every twin layer of one (key, cell) the same `bounds`, their union.
    - The renderer takes a mesh's local box from `geometry.bounds` when present (`Renderer3D.useGeometryBounds`).
    - Twins therefore decide near / far on the identical box.
    - This also fixes the old crowd twins' few-centimetre disagreement at the threshold.
  - **Degraded far twins** (`nearTwin.uvFromNear` → `Mesh3D.lodTwinOffNear`):
    - With distance LOD off, the NEAR twin draws, so the "LOD off" A/B picture is the pre-P9 one.
    - A ground layer takes its uv-scale sample from the near geometry.
    - The contact-shadow footprints skip the far copy.
    - The LOD settings' twin rescale leaves these twins to their tiers.
  - **Registered in `WorldManager.cityDistanceTiers`:** the swap distances are `'twin'` tiers.
    - They use a fifth tuple element (`view-cull.ts` `DistanceTierKind`; `propTwinTiers`).
    - The draw-tier helpers skip them. `assignDrawDistances` stamps `lodTwinDist` from them.
    - The Performance panel lists them as families (`CityLodFamily.kind`). A family multiplier scales the swap distance, shown in metres.
    - The P8 tree crowns use the same format.
  - **Switch:** the world param `propTwins` (absent = on). `salsaWorld.propTwins(false)` rebuilds without the twins.
  - **Build cost:** ~+12 % for the furniture, signal and street builders, on the main thread or in the workers. Warm: furniture 263 → 292 ms, streets 237 → 278 ms.
- [x] **P9.2 Third crowd tier** (P7.7).
  - **What changes:** past `PED_XFAR_M` (100 m) the static crowd swaps its cheap mannequins (853 tris per person) for an XLO bake (344 tris).
    - The XLO bake is `mannequin.ts` `DETAIL_XLO`, lod 2: 5-sided torso and head, every other loft ring, one-blob hands.
    - The near look (< 30 m) is untouched. The 30–100 m tier is the old far twin.
  - **Renderer:** twin roles 3 (MID, between `lodTwinDist` and `lodTwinDist2`) and 4 (XFAR) sit beside roles 1 and 2.
    - `distance-lod.ts` `twinDraws` picks exactly one role per state pair (tested).
    - With distance LOD off, the mid tier draws, as before.
  - **Other systems:**
    - The live crowd treats the mid and xfar ranges as hidden copies.
    - The LOD settings' crowd multiplier scales both thresholds.
    - The stats count the new roles.
- [x] **P9.3 Mover detail tiers** (P7.10).
  - The traffic cars' and buses' trim and chrome build far twins too, swapped at 35 m.
  - Each role gets its own `instanceKey`, and both twins share the near geometry's box.
  - `world:veh-trim` / `veh-chrome` joined the small-props draw-distance class (fine distance, no aerial bias), so far-out views drop them like the parked cars' trim.
- [x] **P9.4 Hierarchical cull** (P7.9; `src/renderer/3d/cull-clusters.ts`, `Renderer3D.hierarchicalCull`).
  - **Clusters:** a loose quadtree over the static, single-material, resident meshes.
    - It is an XZ grid of ~32 members per cell.
    - Each mesh goes to the finest level whose cell is as wide as its box. City-wide layers sit in coarse cells rather than being left out.
  - **Rejection:** a cluster rejects all its members at once when it is outside the view and either outside the light box or its swept shadow box misses the view.
  - **Identical lists:** members are still visited in order, so the draw lists and their batching are unchanged. Draw calls and triangles are identical ON vs OFF in every band.
  - **Cost of a rejected member:** a few reads (its cached box, for the floor / top) plus the P4.2 static-cache push it would have had anyway.
  - **Safety:**
    - A member takes the fast path only at the matrix version it joined with.
    - Moved or new meshes are processed normally, and trigger a rebuild after 30 frames.
    - A twin that sat in a rejected cluster re-seeds its swap state, and so does its partner.
  - **Diorama:** the canal's planar mirror turns the shadow-reach test off, so clusters never reject there. The cull pays off in tiled worlds.
  - **Tests:** `cull-clusters.test.ts` uses random scenes and views and checks that no member of a rejected cluster passes its own tests.
- [x] **P9.5 Draw-list fast paths** (`Renderer3D.drawListFastPaths`).
  - The world box is read inline from the cache entry. The `getMeshWorldAABB3D` call and its getters were ~15 % of the build.
  - The pool allocation and instance slot come from per-mesh copies (`Mesh3D._r3GA` / `_r3Slot`), instead of two string-keyed `Map` lookups per mesh. A generation counter, bumped on every `_geomAllocs` / `_meshInstanceSlots` change, validates the copies.
  - The distance-LOD distance is computed inline once and reused by the twin test. Triangle counts are ints.
  - The frustum and reach tests take the box object (`FrustumCuller.testBox`, `shadowReachesViewBox`). They are equal to the six-number forms (tested).
- [x] **P9.6 Allocation:** 1.5–2.0 MB per frame → **0.66 MB** (tiled street).
  - **Iterators:** for-of over city-sized arrays allocated an iterator result per element below TurboFan, and the draw-list helpers stay on Maglev. Those loops are now indexed:
    - `drawMeshes`, `_buildDrawLists`, `uploadMeshInstances` and the pass loops
    - `FrustumCuller.testAABB`
    - the host renderer's list building
  - **Fresh arrays:** the host renderer copied its 13 k-node `renderList` every frame (`.slice()` plus two `.filter()`s). It now fills persistent arrays by index and sets `length` once. (`length = 0` followed by `push` drops and regrows the backing store every frame.)
  - **What is left:** ~0.4 MB per frame in `_buildDrawLists`, from the pooled draw lists' `length = 0` resets. Removing it needs a counted-list type through the pass code.
- [x] **P9.7 Lazy camera candidates** (`Scene3DManager.lazyCameraCandidates`). `_thirdPersonCamera` builds its fallback grid query + `.slice()` only on first use; most frames every camera ray is inside the collision hood.
- [x] **P9.8 Traffic tick** (`WorldTraffic.blockGrid`).
  - The car AI's blocker scan, `_carBlocked`, was O(cars × movers) and the tick's largest cost.
  - It now reads only the cars and walkers in a per-tick uniform grid around the car.
  - The query radius covers every predicate's reach, so the result is the same boolean. `checkBlockGrid` ran both versions for 76,800 calls with **0 mismatches**.
- [x] **P9.9 Resolution-aware draw distances** (P7.11; `Renderer3D.resolutionLod`).
  - **The height:** `lodViewHeight` comes from the host renderer's CANVAS height, so the auto resolution scaler cannot make LOD pop.
  - **The scale:** distances scale by height / 900, clamped to `LOD_RES_MIN` 0.6 … `LOD_RES_MAX` 1.
  - **Default on, shrink-only.** At 2500 × 1390 (×1.54), letting distances grow added +1.5 M tris in Play (8.66 → 10.12 M) and +3.3 M from the sky (6.74 → 10.01 M), on a view that is already GPU-bound.
  - At 1300 × 850 (×0.94) the shrink saves 0.07 M tris at street level and 0.15 M in Play.
  - For a 4K quality setting, set `LOD_RES_MAX = 2`.
- [-] **P7.8 HLOD tile proxies: not done.** It is large, and P9.1–P9.5 took the session.

### Results

**Triangles / draw calls** (`p9ab.js`, main + shadow passes, median of 3; logs `t4` / `d4`):

| Tiled 3 × 3 | Pre-P9 | P9 | Δ tris |
|---|---|---|---|
| Street | 8.58 M / 3,849 | **6.77 M / 3,805** | −1.80 M (−21 %) |
| Street, looking back | 9.48 M / 3,572 | **7.21 M / 3,577** | −2.27 M |
| Second street | 8.37 M / 3,662 | 6.62 M / 3,633 | −1.75 M |
| Rooftop | 8.46 M / 4,057 | 6.57 M / 4,012 | −1.89 M |
| Sky | 8.02 M / 5,745 | 6.58 M / 5,587 | −1.44 M |
| Far | 2.00 M / 3,352 | 1.98 M / 3,255 | −0.02 M |
| Play (72° lens) | 10.08 M / 4,340 | **7.49 M / 4,228** | −2.59 M (−26 %) |

- At the sky band:
  - roof plant: 579 k → 347 k
  - utility poles: 510 k → 180 k
  - lamp posts: 342 k → no longer in the top 14
- At street level the crowd fell from ~1.2 M to ~0.5 M tris.

| Diorama | Pre-P9 | P9 |
|---|---|---|
| Street | 1.85 M | 1.72 M |
| Rooftop | 1.69 M | 1.46 M |
| Sky | 1.29 M | 1.16 M |
| Play | 1.99 M | 1.76 M |
| Far | 0.46 M | 0.45 M |

Diorama draw calls conflict between the two measurements:
- In `p9ab.js` they read 10–20 % higher with P9. Those medians mix in shadow-refresh frames and were taken while the CPU was contended.
- A static count at the same pose (`dc.js`: opaque entries + shadow runs per family) gives 1,458 with P9 vs 1,639 before, with fewer utility-pole, lamp-post and trim draws.

**CPU** (renderer, tiled, ms):
- **`_buildDrawLists` microbench** (`bench.js`; min / median of 60 calls; `bench4.log`):

  | Config | Min | Median |
  |---|---|---|
  | Pre-P9 loop ("none") | 2.6–3.0 | 3.2–3.8 |
  | Fast paths only | 1.3 | 1.5 |
  | Clusters only | 2.1–2.3 | 2.4–2.9 |
  | **All of P9** | **1.2–1.3** | **1.4–1.6 (−55 %)** |

- **In-frame `msCull`** (`p9ab.js`, median):
  - street 3.7 → **2.2**
  - rooftop 3.7 → 2.2
  - sky 4.0 → 2.5
  - Play 3.6 → 2.4
  - far 1.1 → 0.7
- **Renderer `msTotal`:** street 8.4–11.2 → 6.9, Play 8.3 → 7.5.
- **Traffic tick** (diorama, 432 movers, 300 ticks × 3 rounds; `tab4.log`):
  - mean 0.64–0.84 → **0.46–0.64 ms**
  - median 0.6–0.8 → 0.4–0.6 ms
  - An earlier run on a busier machine: 0.7–1.2 → 0.5–0.6 ms.

**Pictures** (`pixdiff.py`, traffic off; mean absolute difference per 255; the noise floor is the same config shot twice):

| View | Diorama | (noise) | Tiled | (noise) |
|---|---|---|---|---|
| Street | 0.075 | 0.083 | 0.029 | 0.064 |
| Second street | 0.18 | 0.12 | 0.26 | 0.24 |
| Play | 0.013 | 0.013 | 0.007 | 0.011 |
| Rooftop | 0.16 | 0.005 | 0.69 | 0.04 |
| Sky | 0.29 | 0.05 | 0.92 | 0.23 |

- **Street level and Play are unchanged**: within the noise floor.
- **Rooftop:** the differences are 1-px rods on roof plant 50–100 m away, which the far twin drops. The tiled rooftop shot also lost a parked train. The regen + `traffic(false)` order hid it, not the LOD.
- **Sky:** the differences are sub-pixel pole, lamp and crowd detail.

### Switches (all default on)

- `propTwins` world param: `salsaWorld.propTwins(on)`, rebuilds the city.
- `Renderer3D` switches:
  - `hierarchicalCull`
  - `drawListFastPaths`
  - `useGeometryBounds`
  - `resolutionLod`, tuned by `LOD_RES_MIN` / `LOD_RES_MAX` / `LOD_REF_HEIGHT`
- `WorldTraffic.blockGrid`, plus the `checkBlockGrid` verification mode.
- `Scene3DManager.lazyCameraCandidates`.
- `salsaWorld.p9(on)` sets all the runtime switches together.

### Tests

- **New:**
  - `lod-accum.test.ts`: the twin accumulator's bit-identity, the far twin's cost and box, each builder's near twin equal to the `propTwins: false` layer, and the crowd tiers.
  - `cull-clusters.test.ts`: cluster boxes, conservative verdicts, `testBox` / `shadowReachesViewBox` equality, and `twinDraws`.
- **Extended:**
  - `chunking.test.ts`: shared twin boxes, the near uv sample, and the plain-layer grid.
  - `world-distance-lod.test.ts`: the twin tiers and their stamp, and the `veh-` trim class.
- **Adjusted:**
  - The budgets in `street-props.test.ts` / `street-slots.test.ts` now count near twins only.
  - `city-water-edges.test.ts` gets a longer timeout for the extra crowd tier.

### Remaining ideas (not done)

- P7.8 HLOD proxies for tiled far views.
- Counted draw lists, to remove the last ~0.4 MB of allocation per frame.
- Per-entry caches for array groups. Their `_arrayGroupFirstSlot` / `_meshById` lookups are ~14 % of the build, but those maps are changed from several places, so a generation counter needs care.
- Clusters for array groups.
- The traffic tick's mover placement (`updateLocalMatrix` / `setPoseXYZYaw`), ~20 % of the tick.

## P10 — Streaming: duplicate tile geometry, pan latency, a zoomed-out tier

Measured 2026-10-01 in the Salsa vite harness: the Frogmarks City-panel sequence (seed 3, grid 11 × 11, radius 10: diorama → Tiled → 3 × 3 → Full → Stream to camera), headless Chrome + WebGPU (d3d11), 1300 × 850, City mode (perspective orbit). The GPU was shared with other agents, so the evidence is CPU time, counts and long tasks. "HEAD" is the last commit (`6477348`) served from a `git archive` copy on port 5198. "Before" and "after" are the live source with `salsaWorld.p10(false)` + `Renderer3D.gpuGeomCompaction = false` vs the defaults, in one build. Drivers are in scratchpad `pupdrive/stream/`:
- `dup.js`: census per step of the host sequence (containers, meshes, triangles, groups, tiles, duplicate meshes, movers, pool).
- `dup2.js` / `misplaced.js`: identical meshes in world space; tile meshes outside their own tile; tile seed collisions.
- `pan.js`: pan-to-appear latency. A 0.5 s drag (30 frames, 2 tiles) at an orbit radius `ZOOM` (50 / 80 / 140 units at 49° pitch), then frames until every new tile is live and until the stream is idle. Long tasks, rAF gaps, sync tile-build time, worker queue, triangles and draw calls. `PROF=1` adds a CPU profile.
- `proxybench.js`: one flat proxy / massing / full tile build, HEAD vs live.
- `poolprobe.js` / `compactcheck.js`: geometry-pool rebuild triggers; the GPU compaction read back and compared byte for byte with every resident geometry.
- `shots.js` / `massshot.js`: pictures (on / off sessions).

### A. Duplicate geometry: yes, and it was drawn on top of the centre city

| Checked | Result |
|---|---|
| Diorama city container surviving under the tiled world | No. One `City` container in every state; the centre keeps one group set (16 names in a tiled world). |
| Centre tile built twice (sync + worker) | No. |
| Stale tiles / proxies after a mode switch | No. Follow on → off restores the 3 × 3 exactly (same mesh and triangle counts); tiled → diorama leaves 0 tile groups. |
| Live crowd / traffic / trains per tile | No. Tiled worlds run no movers (auto-off); the live crowd works on the centre only. |
| Far twins, prop twins, tree crowns (P8 / P9) doubling draws | No. Exactly one role of each twin set draws (the world-space duplicate census finds none). |
| Fog-horizon / near-twin variants all drawn | No. |
| **Railway + landmarks of every full tile** | **Yes — 334 meshes in a 3 × 3, all at the centre city's coordinates.** |
| **Contact blobs of tiles** | **Yes — overlapping copies (per reassembly job).** |
| **Two pairs of identical tiles** | **Yes — tile seed collisions.** |
| **Planter / potted vessels** | **Yes — one pooled geometry shared by every tile's planters.** |

- [x] **P10.A1 Tile railway and landmarks were built over the centre city** (pre-existing; HEAD has it).
  - **Symptoms:**
    - Every full neighbour tile built its viaduct, station, parked train, metro entrances and landmarks at the CENTRE city's coordinates.
    - In a 3 × 3 that is 8 viaducts in 3 distinct columns, plus 6–8 landmark sets, over the centre.
    - At street level in the centre the camera stood inside a stacked station platform (`shot-street-off.png`).
  - **Causes:**
    - `offsetGraphGeometry` moved roads, blocks, lots, ponds, bridges and the local line, but not `graph.landmarks`.
    - `railwayLine` / `railStations` / `railLayout`'s junction rows / `skywayPath` are derived from params relative to the city centre (`-R + col·2R/cols`, `±0.94 R`), so they never saw the offset.
    - The line was also warped with the TILE's seed, while the tile's roads drape with the WORLD's warp.
  - **Fix** (`TileBuildOptions.tileFrame`, default on):
    - `offsetGraphGeometry` also offsets landmark footprints, centres and entrances.
    - The tile build stamps two new tile-only params on the tile graph after generation: `tileOrigin` (its world offset) and `warpSeed` (the world's warp seed).
    - `railwayLine`, `railStations`, `railLayout`'s junction rows and `skywayPath` place themselves at the origin. `makeDomainWarpInto` uses `warpSeed`, so the line follows the tile's warped road. This also aligns the R3.2 local line's own warp in tiles.
    - Layout-time claims (`claimViaductLots`) still run in the local frame, like the lots they move with.
  - **After:** 0 misplaced meshes in 3 × 3 and 5 × 5 (one tree chunk sits 1.16 R from its tile centre, on the edge); 0 duplicate meshes. Each tile has its own viaduct over its own road (`shot-tile-air-on.png`), and the centre has only its own (`shot-centre-air-*.png`).
- [x] **P10.A2 Tile seed collisions.**
  - **The bug:** `−x = ~(x − 1)` flips exactly the bits up to x's lowest set bit. Both multipliers are odd, so whenever tx and tz have the same number of trailing zeros the flips cancel: (tx, tz) ≡ (−tx, −tz) and (tx, −tz) ≡ (−tx, tz). The four corners of a 3 × 3 were two identical cities; a 5 × 5 also repeats (±2, ±2).
  - **Fix** (`seedDedup`): re-salt one member of each pair (tx < 0). Every other tile keeps its seed, so 7 of a 3 × 3's 8 neighbours are unchanged (2 tiles change). 0 collisions over 17 × 17.
- [x] **P10.A3 Tile contact blobs were duplicated.** The main thread built them per reassembly JOB. A job holds a slice of a group, so a person's colour parts and the near / mid / far crowd tiers landed in different jobs and each got its own blob: identical, overlapping blob meshes in a tile, so darker shadows. Fixed by P10.B2 below.
- [x] **P10.A4 Vessel geometry key collision.**
  - **The bug:** `vessel:${type}:${layer}` (biome.ts) did not include the seed the arrangement is built from. 14 meshes across tiles (3 different geometries, some of different lengths) shared ONE pooled geometry: whichever uploaded first, including a disposed tile's.
  - **Fix:** the key carries the seed.
  - **Found by:** the GPU-compaction readback (`compactcheck.js`). The renderer now also tracks which geometry object a key's resident bytes came from, so any future collision is re-uploaded by a compaction exactly as the CPU rebuild would.
- [ ] **Not fixed:**
  - `salsaWorld.untile()` (console) loses `terraces` / `shotengai`: the tiled build's forced overrides are stored in `_params`. The Frogmarks panel always resends both, so the app is not affected.
  - Tile graphs keep un-offset `regions[].center`, so the skyline's downtown boost (`streets.ts` `dtc`) is relative to the centre city and neighbour tiles read slightly "suburban". Moving it changes neighbour-tile heights; left for a content decision.

### B. Why zoomed-out streaming got slow

| Pan (30 frames, 2 tiles) | HEAD (cap r = 50) | Before P10 | After P10 |
|---|---|---|---|
| r = 50 (full ring) | 0.63–0.9 s; new tiles live 12–237 ms; long tasks 0–0.2 s; 0.9–1.8 k draws | 3.4–5.1 s; live 41–1,320 ms; idle at 5.0–6.3 s; long tasks 3.7–6.8 s (max 0.9 s); 6.1–7.8 k draws | 1.5–2.0 s; live 43–306 ms; idle at 3.5–4.2 s; long tasks 1.3–2.6 s (max 0.13 s); 5.5–5.8 k draws |
| r = 80 (lite ring) | — (HEAD could not zoom out this far) | 1.6–3.1 s; live 3.2–4.7 s; long tasks 1.3–2.6 s | 0.55–0.89 s; live 12–75 ms; long tasks 0–0.16 s |
| r = 140 (far) | — | 2.4–2.7 s; live 2.7–3.8 s; long tasks 2.2 s (max 0.23 s); 1.2 M tris / 1.55 k draws; worker queue ≤ 4 | **0.58–0.80 s; live 5–36 ms; long tasks 0–53 ms; 0.55 M tris / 0.79 k draws; 0 worker jobs** |

- "Live" = every newly visible tile shows something (preview or build). "Idle at" = the stream and reassembly queues are empty (full upgrades landed). The full ring's idle time is the worker build itself (2–4 s a tile).

**Causes, by size** (CPU profiles of one pan, before P10):

| # | Cause | Cost | Where it came from |
|---|---|---|---|
| 1 | `_cacheCityBounds` on EVERY stream drain: a whole-tree walk of 10–15 k meshes, ~110–160 ms. A zoomed-out pan drains after almost every proxy. | 1.65–1.8 s per pan | Pre-existing; the tree got 2–3× bigger (P9 twins, crowd tiers, chunks) |
| 2 | Idle geometry-pool compaction: a full CPU re-upload (`writeBuffer`) of the whole pool, 1.1–1.9 GB in a streamed tiled world. | ~0.8–1.0 s freeze, 350 ms after every pan stops | The pool grew with the content |
| 3 | Content growth per tile: a full tile 0.44 → 2.2 s in the worker; a flat proxy 5.4 → 28 ms on the main thread. The proxy's ground mesh went 11 k → 37 k vertices; the kerb-lift elevation (pavement index) was built for proxies that never sample it; and far tiles drape through the height field's out-of-core memo map. | Proxies 0.4–0.75 s per pan (one per frame) | P9 twins / crowd tiers, ground-mesh S8, kerb lift S12 |
| 4 | T7.4 lifted City mode's zoom-out cap from 50 to 150 units in tiled worlds, so the view holds the full 40-tile window. The raised zoom-tier thresholds (L5) also keep FULL tiles up to r ≈ 57 (HEAD went lite at r ≈ 38). | More tiles to build, heavier ones | T7.4, city-quality L5 |
| 5 | Lite ("\|l") tiles had no preview: blank for the whole worker build. | 2.7–4.7 s to appear | Pre-existing, exposed by #3 |
| 6 | Contact blobs built on the main thread per reassembly job (also A3). | 0.4–0.65 s per pan | P3.2 moved the centre's into the worker, not the tiles' |
| 7 | One host scene-graph event per tile add / remove (connector walk, Angular in Frogmarks). | ~80 ms per pan in the harness (more in the app) | Pre-existing |
| 8 | A tile that left the window kept its worker job and its in-flight slot until done (2–4 s). | Small at these settings (queue ≤ 6 on 8 workers) | Pre-existing |

**Checked and not a cause:**
- The follow window is unchanged: 5-tile render distance, 40 live tiles and 9 full, the same as HEAD. (That fixed 9 is the "full 9 at 1×1" bug — see §D.)
- Builds are not serialised: 8 `world` workers, plus 1 `atlas`.
- No debounce or idle gate was added on the pan path. The 350 ms idle compaction already existed at HEAD.
- The per-tile param snapshot (D-W2) clones a small object.
- `cancelSelective` and the stream tokens (D-W4) do not touch tiles.
- Traffic precompute and crowd tiers do not run on tiles.

### Fixes (each with an A/B switch; all default on)

All `WorldManager.P10.*` switches are set from the console with `salsaWorld.p10(false)` (all off), `salsaWorld.p10({ farMassing: false })` (one), and read back with `salsaWorld.p10()`.

- [x] **P10.B1 Idle bounds** (`idleTileBounds`). The City gizmo bounds walk runs once, 400 ms after the stream went idle, instead of on every drain.
- [x] **P10.B2 Tile contact blobs in the tile build** (`tileContactInWorker`).
  - `buildTileLayerGroups(…, { contact })` builds each group's blobs over the WHOLE group, after the drape, and marks them done. That is the worker for full tiles; reassembly skips them.
  - Same blobs as the centre's worker build (tested). Fixes A3 and takes 0.4–0.65 s per pan off the main thread.
- [x] **P10.B3 Cheaper proxies** (`lazyElevation`). A proxy build is 28 → 18 ms, (HEAD 5.4 ms; the rest is the denser ground mesh).
  - The kerb-lift elevation is built lazily, on the first full-tier sample, so proxies never build it. This is bit-identical (tested).
  - For flat / massing tiles the height field's precomputed core moves onto the tile, snapped to whole lattice cells. Same nodes and triangles; differences < 1e-4 R (tested). The drape is 14.8 → 3.8 ms a tile.
- [x] **P10.B4 Lite preview + preview key fix** (`previewLite`, `previewKeyFix`).
  - Lite tiles show the flat proxy while their worker build runs. They were blank for 2–4 s.
  - **Fixed along the way:** a preview stand-in that left the window before its upgrade landed was RETIRED UNDER THE FULL KEY. The tile then came back flat for good, with its full build skipped as a "cache hit". `StreamSource.dispose(key, handle, preview)` now says which handles are previews, and the city retires them as `tx,tz|p`.
- [x] **P10.B5 Stale-build cancellation** (`cancelStaleTiles`).
  - `StreamSource.cancel(key)`: when a full / lite tile leaves the window mid-build, the manager frees its in-flight slot at once.
  - The city cancels the worker job (`world.tile:<key>` supersede key). It drops the tile's queued reassembly jobs and removes the part already assembled.
  - A cancelled build no longer falls back to a seconds-long main-thread build.
- [x] **P10.B6 GPU geometry-pool compaction** (`Renderer3D.gpuGeomCompaction`).
  - **How:** compaction (the idle request and the append-overflow case) slides every live geometry down to a dense prefix with `copyBufferToBuffer` through a 64 MB scratch buffer (`geom-compaction.ts` `planSpanCompaction`). Moves run in ascending old-offset order, so a move never reads bytes already overwritten. Only geometry the pool has not seen is written from the CPU.
  - **Cost:** 13–27 ms CPU for a 1.8 GB pool (~20 k moves), against ~0.95 s.
  - **Correctness:** `compactcheck.js` read back the pool after 3 compactions and compared all ~10.4 k resident geometries with their CPU copies: **0 differences**, 0 overlapping allocations.
  - It returns null (→ the full rebuild) when the live + new geometry would not fit the current buffers, so growth still goes through the CPU path.
- [x] **P10.B7 One host notification per streaming burst** (`coalesceTileNotify`). Each tile add / remove does a QUIET structure bump at once (mesh caches + render list), and ONE host scene-graph event fires 250 ms after the last change.
- [x] **P10.B8 Flat / massing tile LRU** (`proxyCache`). Cheap tiles retire to a 64 MB LRU, so a pan back re-attaches them instead of rebuilding.
- [x] **P10.C1 The MASSING tier** (`farMassing`; see §C).

### C. Detail levels for streamed tiles (now)

| Tier | Key | What it is | Built where / cost | When |
|---|---|---|---|---|
| FULL | `tx,tz` | The whole city: buildings with detail, props, crowd (3 tiers), signals, railway … with every per-chunk LOD rule | Worker, 2–4 s; main-thread reassembly time-sliced | `tileDetail: 'full'`, the 9 tiles nearest the camera, while the zoom metric is inside the PROPS band |
| LITE | `tx,tz\|l` | FULL without detailed buildings | Worker (cheaper) | Those 9 tiles once the zoom metric is past the PROPS band (1.2 F), when `detailedBuildings` is on |
| FLAT PROXY | `tx,tz\|p` | The flat map: roads, pavements, lots and parks, draped, ~37 k vertices | Main thread, ~18 ms (one per frame) | The other visible tiles (rank > 9), and as the PREVIEW of every FULL / LITE tile while its build runs |
| **MASSING** (new) | `tx,tz\|m` | The flat map plus one extruded box per building lot (`tile-massing.ts`): walls in the zone's tint bucket with the window pattern, flat roofs, ~20 k triangles in ≤ 10 layers. Heights use buildStreets' per-lot RNG stream, so boxes stand about as tall as the full buildings. | Main thread, ~16–18 ms; no worker, no upload storm | **EVERY visible tile** once the zoom metric is past the STRUCTURE band (1.7 F, hysteretic), in perspective |
| (flat / focus worlds) | `tx,tz` | Flat map | Main thread | Every neighbour tile, at any zoom |

- **The zoom metric:** `min(orbit radius, 2 × the camera's height above the ground)`. F = 2.8 × the city radius, ≈ 48 units in the default tiled world, so PROPS is r ≈ 57 and STRUCTURE is r ≈ 81 (hide at ~91 with the hysteresis).
- **A low oblique view keeps detail:** at r = 140 and 17° pitch, 2 × height ≈ 82 — the near tiles are close to the lens.
- **Ortho (2D)** keeps the full / lite / proxy split; its zoom tiers already thin it.
- **Which tiles:** the visible set comes from the camera frustum (tile boxes, T7.5), ranked by camera distance. The 9 nearest get the FULL / LITE seats, with a 1.5 × hysteresis band. Window membership uses a 0.2 / 0.5 NDC margin hysteresis.
- **Zoomed far out (r ≥ ~91 at a normal pitch):** the 40 visible tiles are all MASSING. A 2-tile pan builds ~14 of them synchronously, one per frame (~20 ms frames), and they are live 5–36 ms after the pan stops. The stream starts no worker build at all.

### P10 recommendations (ranked, not done)

| # | Opportunity | Evidence | Gain | Effort | Overlap |
|---|---|---|---|---|---|
| P10.1 | **Full-tile weight**: a full tile is now 2.2 s to generate and ~150–200 MB of vertex data (the pool holds 1.1–1.9 GB at r = 50). Profile the builders; drop the P9 prop twins and the crowd's xfar tier from neighbour tiles (only the centre is ever walked); share archetype geometry across tiles. | `proxybench.js` fullTile 442 → 2,250 ms; `poolprobe.js` | 2–4× faster full-ring fill, ~1 GB less VRAM | M | — |
| P10.2 | **Massing in the worker + for the outer ring at every zoom**: build `\|m` in the worker instead of `\|p` for the rank > 9 tiles, so the skyline never drops. | Massing ≈ proxy cost; flat proxies drop the skyline (P7 note) | A consistent skyline; ~18 ms × 31 tiles off the main thread on a far pan | S–M | **fog-horizon P3** (silhouette tiles = the massing boxes, material-less, one draw per tile) |
| P10.3 | **One draw per massing / proxy tile**: merge a cheap tile's layers into one mesh with vertex colours (or a single atlas material). | 17 layers per massing tile → ~680 draws at r = 140 | ~5× fewer far-out draws | S | fog-horizon P3 step 3 |
| P10.4 | **Cheaper proxy ground**: a far-only ground tessellation (no lattice split, ~10 k vertices) for `\|p` / `\|m`. Keep the full split for the preview of near tiles. | 37 k vs 11 k vertices; ~7 ms of the 18 ms | Proxy 18 → ~8 ms | S | — |
| P10.5 | **Zoom-scaled full budget**: in the PROPS → STRUCTURE band, drop the 9 full seats to 4 (lite tiles are still 1–2 s worker builds). | 9 lite builds per far pan | Halves the settle time in that band | S | — |
| P10.6 | **Time-slice `_takeRetired` re-attach + warm** for full tiles (a retired 150 MB tile re-uploads in one job). | Reassembly / warm jobs up to 60 ms | No > 50 ms task on pan-back | S | — |
| P10.7 | **Terminate-on-cancel for tile jobs**, or chunk the tile job, so a cancelled 2–4 s build frees its worker too (today only the stream slot is freed). | Not saturated at 8 workers; matters at 2–4 cores | Faster refill on small machines | S | — |
| P10.8 | **Regions in the tile frame** (A1 follow-up): offset `regions[].center` so a tile's downtown boost is its own. | Neighbour tiles read low-rise | Content | S (visual sign-off) | — |

### D. The active window: Tile radius, eye-centred, the centre streams too (2026-10-01)

**The bug** (user screenshot): Tiled, Tile radius 1×1, Full, Stream to camera, a free-3D oblique overview → "live 40 · full 9", 39.6 M triangles, 2.3 GB of mesh.

**Root cause:**
1. Follow mode never read `tileRadius`. `_visibleTileKeys` gave FULL seats to the `_fullTileBudget = 9` tiles nearest the camera among everything in the frustum (up to 40), whatever the slider said. The slider only drove the follow-OFF origin grid.
2. The centre city (0,0) was not streamed. It stayed resident as full geometry and was only group-hidden when off-screen. So 1×1 was really 9 full tiles + the centre (10 cities).
3. The stats line read `full: this._fullTileBudget`, the constant 9, not a count.

Reproduced in the harness (`pupdrive/stream2/repro.js`, eye (-22, 34, 30) over tile (-1, 2), looking at the origin): 9 full + the centre, 20.6 M triangles resident, 13.8 k meshes, pool 1.70 / 1.83 GB.

**What it does now** (all `WorldManager.P10.*` A/B switches, default on; `src/services/streaming/tile-window.ts`):
- [x] **P10.D1 The window** (`eyeWindow`). In a Full world with follow on:
  - The Tile radius IS the active window: (2r+1)² FULL tiles. 1×1 = 1, 3×3 = 9, 5×5 = 25. The slider drives it live: a tileRadius change is the existing incremental path, with no regen.
  - Centred on the tile directly below the camera EYE (the eye projected onto the ground, city-local XZ). In Play it is the player's feet (`sm.scene3d.getPlayerFeet3D()`). It is never the orbit target or the view centre.
  - Hysteresis: the focus tile changes only once the point is 12% of a tile into the next tile (`WINDOW_MARGIN`).
  - Zoomed past the PROPS band, the active tiles build LITE. Past the STRUCTURE band, with `farMassing`, they build MASSING (the zoom tiers hide everything else there anyway).
  - After: the repro reads full 1 (the tile under the eye), 41 live (1 full + 40 flat), the centre parked, 2.6 M triangles, 1.4 k meshes, pool 238 / 329 MB. At 3×3: full 9 around the eye.
- [x] **P10.D2 The centre streams like any tile.**
  - When the window leaves (0,0), the centre's groups are PARKED: removed from the scene (GPU geometry evicted), and the built CPU objects kept, like the tile LRU. The world-extent backdrop (apron, void grid, border glow, sky) stays.
  - (0,0) then shows as an outside tile (`0,0|p` / `0,0|m`, built by `buildTileLayerGroups` with the world seed, which is the same layout).
  - Coming back re-attaches the SAME objects, time-sliced. Each group is attached hidden and its geometry warmed in 8 MB slices. Everything is revealed in one frame, and the stand-in tile stays until then.
  - A regen / clear drops a parked centre (`_dropCentreParking`). Follow off, or `eyeWindow` off, re-attaches it at once.
  - `centre.js`: home resident (442 groups) → away parked (0) → back resident, the same 442 group objects.
- [x] **P10.D3 Outside tiles** (`setStreamOutsideTiles('none' | 'flat' | 'massing')`, console `salsaWorld.streamOutside()`; session state, not saved).
  - **Flat** (default): the flat map, auto-promoted to massing past the STRUCTURE band when `farMassing` is on.
  - **Massing**: massing at every zoom.
  - **None**: nothing beyond the window.
  - The set is the frustum-visible tiles (unchanged scan, up to 40, within 5 tiles of the look-at) minus the window.
- [x] **P10.D4 Bounded caches and a pool that shrinks.**
  - **LRUs:** the full / lite LRU (256 MB, max 8) and the flat / massing LRU (64 MB, max 96) are `ByteLru`s, bounded by bytes AND count, oldest evicted first.
  - **Shrink** (`Renderer3D.geomPoolShrink`, `geom-compaction.ts` `planPoolShrink`). After a GPU compaction, buffers > 3× the live bytes are reallocated to 1.6× (min 64 MB). The live prefix moves with one GPU copy, and the old buffers are retired. A full rebuild also reallocates smaller. An empty pool releases its buffers (bug-hunt D-R1).
  - **Compact before grow** (`Renderer3D.compactBeforeGrow`). An overflowing append compacts when dead space would absorb it, instead of growing ×1.5.
  - **Compact while moving** (`compactWhileMoving`). A compaction deferred > 2 s by continuous motion is requested anyway. A straight fly never went idle, so the dead space of the tiles it left stayed for the whole flight: overview fly pool 588–1602 MB → 76–85 MB.
  - **Leak fixed:** `Renderer3D._groundUvScaleCache` held the GEOMETRY of every removed ground mesh, about 2 MB per streamed tile. This was pre-existing. Post-GC heap over a 30-tile fly: 758 → 1203 MB before, flat at ~770 MB after.
- [x] **P10.D5 Cheap tiles in workers** (`cheapInWorker`). Flat / massing tiles are built by the worker pool (`TileJob.full = false`, priority `interactive`), so the ~18 ms main-thread build per tile is gone. A cache hit still re-attaches synchronously.
- [x] **P10.D6 Concurrency classes + worker recycling.**
  - `StreamSource.isCheapKey` / `maxConcurrentCheap`: cheap keys have their own in-flight cap. Full builds use workers − 2 slots (`reserveCheapWorkers`).
  - A FULL build cancelled while it runs kills + respawns its worker (`terminateCancelled`, per-job `RunOptions.terminateOnCancel`).
  - Before: flying 1 tile/s at 3×3 showed 0 flat tiles for the whole flight. Every worker was busy with stale 2–4 s full builds, and the cheap tiles starved behind them. After: 33–37 flat tiles all the way.
- [x] **P10.D7 A held tile is its own stand-in** (`heldAsPreview` → `StreamManager.heldAsPreview`). A flat tile that the moving window promotes to full stays on screen, through the tier-flip hold, until the full build lands. Before, it was disposed and rebuilt as an identical sync flat preview: ~1 s of main thread per 10 s of flight.
- [x] **P10.D8 Budgeted warms** (`budgetedWarm`, `WorldManager.WARM_SLICE` = 8 MB). Tile reassembly jobs, LRU re-attaches and the centre restore pre-upload geometry in slices (`warmGeometry(meshes, budgetBytes)`). The render-time append (16 MB / frame) finishes visible tiles.
- [x] **P10.D9 Play across streamed tiles** (`scene3d-manager.ts`, `mesh-picker.ts`, `mesh-bvh.ts`):
  - **Collision follows the scene** (`Scene3DManager.collisionFollowsStructure`). The collision snapshot was taken at Play start only. New tiles had no ground (the player walked on the fallback plane), and removed tiles stayed collision geometry. It now rebuilds after a structure change, at most every 500 ms.
  - **Detached meshes are ignored.** Removed meshes are marked in the picker (`setDetached`), so a not-yet-refreshed ray never hits them or rebuilds their BVH. Those re-built BVHs were never freed: the Play heap grew ~100 MB/s.
  - **BVH build budget** (`MeshPicker.bvhBuildBudgetMs` = 4, `Scene3DManager.collisionBvhBudget`). Collision rays build ≤ 4 ms of new BVHs per frame. A ground ray that skipped a mesh holds the current height for that frame. The Play-enter spawn ray is unbudgeted.
  - **Tile crowd** (`collisionSkipTileCrowd`). A streamed tile's merged static crowd layers (0.1–0.7 M triangles each) are not collision geometry. The centre's crowd is unchanged.
  - **BVH build ~4.6× faster** (`mesh-bvh.ts`): centroids are precomputed once and each node splits at the median by quickselect. 180 k random triangles: 880–930 → 190–195 ms (node). Same median split; tested against a brute-force ray scan.
- [x] **Movers:**
  - Tiled worlds run no traffic / trains (auto-off since P5.W2; neighbour tiles build parked trains).
  - Clouds and any forced-on traffic stay attached with the centre's backdrop and are paused + hidden while the centre is parked (`_setMoversHidden`).
  - The live crowd indexes every resident `… World Pedestrians` group. When a tile or the parked centre leaves, its live people are restored into their static layers and dropped (`WorldLiveCrowd._syncIndex`), so no movers are orphaned.

**Long runs** (`pupdrive/stream2/fly.js`, headless d3d11 1300 × 850, shared GPU → CPU counts; GC'd heap sampled every 5 s):

| Run | Meshes | Pool used / cap (MB) | GC'd JS heap | Long tasks |
|---|---|---|---|---|
| Street 1×1, 30 tiles at 0.5 tile/s | 252–3.5 k (0–1 full) | 66–74 / 105 in flight | **flat 755–784 MB** (was +8 MB/s before the uv-cache fix) | **0** (worst rAF gap 59 ms) |
| Street 3×3, 30 tiles at 0.5 tile/s | 284–9.1 k (0–7 full) | 106–1441 / 118–1878; shrinks between full sets | 1.25–1.94 GB, no trend | 35 (max 191 ms) — rendering up to 7 full cities at street level |
| ↳ same, legacy (`eyeWindow` / `cheapInWorker` / shrink / compact-before-grow off) | 3.5–8.7 k | cap stuck at 1835 | 1.14–1.69 GB | 70, **max 2.9 s**; only 33 one-second samples in 74 s; 0 flat tiles in flight |
| Overview 3×3, 30 tiles out and back at 1 tile/s | 271–7.1 k | **70–85 / 110–116 in flight** | 783–831 MB in flight | 32 (max 92 ms) |
| Play 3×3, run ×20 (~6.5 units/s), 60 s, 19 tiles, walls off | 3.7–10 k | ~0.9–1.2 GB / 1.4–2.0 GB | 3.2–4.0 GB, no trend | max **208 ms** (was 5.9 s; heap was growing ~100 MB/s) |

- The 3×3 street-level long tasks are frame rendering: 22 of 30 s of CPU was `render`, with up to 9 full cities in view. That is the other agent's street-level culling work, not spawn work. At 1×1 the same flight has none.
- "Play, walls off" moves the controller's wall resolver out of the way so it crosses tiles in a straight line. The ground sampler, camera collision and streaming are all live. With walls on, the player stops at the first building.

**Not done / open:**
- The full tile itself is the remaining cost: ~225 MB of vertex data, 87 MB of it crowd. A 3×3 street window is 1.5–2 GB of pool. See P10.1. (P12, 2026-10-01: the crowd part is gone. The instanced crowd is ~0.25 MB a tile; a 3×3 pool is ~1.2 GB.)
- A worst reassembly job of 65–150 ms ("World Pedestrians") still shows at tile landings. One 18 MB crowd geometry is one writeBuffer, and a single big BVH build (~0.2 s) is still one frame. (P12: the crowd jobs are now ≤ 2 ms a tile; the worst job is 14–28 ms, Furniture / Signals / Streets.)
- `World Border Glow` / apron / void grid stay sized to the origin's tile extent. Far from the origin you fly past the ring. (Step 3: they follow the window — §P13 "Step 3".)
- A parked / re-attached centre keeps its glow / style from when it left (the glow re-dresses on the next cycle tick); LRU tiles behave the same. (Step 3: dressed at once.)
- `_agAABBCache` (array-group AABBs) is keyed by group id and never pruned. It is small (~10 KB per tile). (Step 3: pruned.)
- Ortho (2D) and flat / focus worlds keep the legacy visible-set path. (Step 3: ortho centres the window on the view centre; flat / focus worlds have no full neighbour tiles, so they keep it.)

### Tests

- **P10.D (new):**
  - `src/services/streaming/tile-window.test.ts`: radius → set, the eye (not the target) and the player focus, hysteresis, the outside tiers.
  - `src/services/streaming/byte-lru.test.ts`: the cache LRU, by bytes and by count, take / re-put order, bounded under an endless stream.
  - `src/services/managers/world-stream-window.test.ts`: through WorldManager. 1×1 at the user's overview = the one tile under the eye, and the centre parks. 3×3 around the eye. The slider live. The centre re-attaches. Border hysteresis. Play focus. Stats.
  - `src/renderer/3d/geom-compaction.test.ts` (+3): pool shrink.
  - `stream-manager.test.ts` (+3): the cheap class is never starved; a held tile skips the preview (+ A/B).
  - `src/renderer/3d/mesh-bvh-build.test.ts`: the BVH equals a brute-force scan; build time.
- **`src/world/tile-build.test.ts`** (new):
  - Every railway / landmark / skyway layer lies on its own tile; the legacy build put the viaduct on the centre.
  - The tile railway line is the local line moved to the origin.
  - No seed collisions in 17 × 17, and non-colliding tiles keep their legacy seed.
  - The worker-built contact blobs equal a whole-group computation (≤ 1 blob layer per group).
  - The massing tier: one box per building lot, inside the tile, ≤ 10 layers.
  - Lazy elevation is bit-identical; the centred field is equal to within 1e-4 R.
- **`src/renderer/3d/geom-compaction.test.ts`** (new): the compaction plan, simulated on bytes over 60 random layouts with tiny scratch chunks. Every byte arrives, the result is dense, and spans already in place make no move.
- **`stream-manager.test.ts`** (+3): cancellation frees slots and stale results are discarded; no cancel → the slot is held; preview handles are disposed with `preview = true`.
- **`city-stream-source.test.ts`** (+4, +1 key test): massing builds through `buildTile(massing)` and never previews; lite previews, unless retired; async builds carry their key and cancel delegates; a dropped preview retires as `|p`.

### Host (Frogmarks) findings (read-only, not changed)

- **The "Stream to camera" checkbox toggles twice.**
  - The template has `[(ngModel)]="worldStreamFollow" (ngModelChange)="worldToggleStreamFollow()"`. The banana binding assigns the new value, then `worldToggleStreamFollow()` flips it back and calls `setStreamFollow(!checked)`.
  - Checking the box therefore turns follow OFF, and the box stays checked because the model value did not change. The second click turns it ON with the box unchecked.
  - **Fix:** drop the `!` toggle (`setStreamFollow(this.worldStreamFollow)`), or use `[ngModel]` + `(ngModelChange)`.
- **The stream stats line reads two fields that don't exist.** It uses `s.focusTile` and `s.window`, which `getStreamStats()` does not return, so it shows "focus 0,0 · window undefined". Show `full`, `cached` and `pending` instead.
- **The "Tiled" button starts at Tile radius 1 × 1** (`worldTileRadius = 0`), which has no neighbour tiles, so "Tiled" alone shows no tiling until the slider is moved.

## P11 — Culling: what "tris" counts, frustum granularity, shadow share, occlusion

Measured 2026-10-01 in the Salsa vite harness (seed 3 grid city: the diorama and a tiled 3×3 'full' world; headless Chrome + WebGPU d3d11; 1540×900; Play third person at street level, 72° lens).
- **User report:** "at street level, walking as a player, it shows millions of tris, even facing a wall. Anything outside my view should be culled, right?"
- **Drivers** (scratchpad `pupdrive/occl/`):
  - `poses.js`: Play poses (a) down a street, (b) 2.7 m from a facade (ray-picked), (c) looking at the ground. Per pose, `analyze.js` reports the engine's per-pass counters, the per-family split of every pass list, a per-triangle frustum check of the main pass, a CPU z-buffer occlusion estimate and a sub-range estimate.
  - `verify.js` + `check.js`: occlusion correctness (Play walk with fast turns, a 25°-per-frame free-camera spin). CPU A/B is in `abcpu.js`, GPU A/B in `gpuab.js` (paired timer), and the frozen-time pixel A/B in `rangeab.js` + `pd.py`.
- **GPU caveat:** the GPU was shared with other agents for most of the session (30–100 %). Counts and CPU timings are the evidence; GPU deltas are paired differences only.

### 1. What the HUD's "tris" counted

`getRenderStats3D().triangles` (the Frogmarks 3D stats HUD headline) is the **scene** total:
- It sums the triangles of every mesh whose `visible` flag is set: no frustum culling, no distance LOD, no fog cull.
- Both near/far twins count, and an instanced group counts once.
- It does not depend on the camera at all: 4.57 M in the diorama and 36.0 M in the 3×3 world, whatever the view. That was the user's "millions, even facing a wall".

The renderer's own `trisDrawn` (the Performance panel) is honest about culling but mixes every pass: main + far shadow map + cascades + outline / SSAO / SSR prepasses.

**Now:**
- Every `_drawMesh` adds to a per-pass bucket. `getFrameStats3D()` gains:
  - `passMainTris` / `passMainDraws`
  - `passFarShadow*`, `passCascade*`, `passOutline*`, `passPrepass*`, `passPlanar*`, `passOther*`
  - `passFarShadowLast*` / `passCascadeLast*`: the last frame each map actually rendered, since the maps are throttled and cached.
- The skinned shadow casters are counted in their pass.
- `getRenderStats3D()` keeps `triangles` and adds:
  - `drawn` / `drawCalls` = `{ main, shadow, other, total, shadowThisFrame, passes }`
  - `sceneTriangles`
  - `culling`
- `getCityLodStats3D().frame` adds `trisMain` / `trisShadow` / `trisOther` and `draws*`.
- The split is in `src/renderer/3d/pass-stats.ts`.
- Frogmarks shows `drawn.main` as the headline (see docs/ui/frogmarks-update-2026-09-28.md).

### 2. Per-pass breakdown (before P11, Play third person)

Triangles submitted. The cascade and far rows are each map's last refresh; there is one near cascade at street level, ±24 m. "Scene" is the old HUD number. Outline / SSAO / SSR / mirror prepasses were off in these cities (0).

| Pose | Scene | Main (static + characters) | Main draws | Near cascade (every frame) | Far map (on refresh) |
|---|---|---|---|---|---|
| Diorama, street | 4.57 M | 1.65 M + 28 k | 2,270 | 1.10 M | 0.53 M |
| Diorama, wall (2.7 m) | 4.58 M | 1.62 M + 28 k | 2,057 | 1.04 M | 0.37 M |
| Diorama, ground | 4.58 M | 0.94 M + 28 k | 636 | 1.08 M | 0.34 M |
| Tiled 3×3, street | 36.0 M | 7.18 M + 28 k | 4,234 | 2.36 M | 6.25 M (static re-render) |
| Tiled 3×3, wall | 36.0 M | 6.70 M + 28 k | 3,909 | 1.88 M | 6.29 M |
| Tiled 3×3, ground | 36.0 M | 0.93 M + 28 k | 614 | 1.98 M | 6.10 M |

- **Families, main pass, diorama street:** the static crowd is the biggest (ped-skin 107 k, ped-black 41 k, navy 32 k …, ~350 k in all), then steel railings 51 k, facade trim 30 k, utility wires 29 k, roof equipment 29 k, walkers 29 k.
- **Families, tiled:** the same families, plus whole streamed-tile layers (below).
- **Families, far static map:** 1.46 M in the diorama: everything in the light box, by design (P4.2 caches it and re-renders only on change).

**Shadow share.**
- In Play the near cascade re-renders every frame, because the player animates. The far map's static layer re-renders only when the static set changes; its dynamic layer (trees, walkers) re-renders every `shadowUpdateInterval` frames.
- Per frame that is main 1.7 M + cascade 1.1 M in the diorama (shadow ≈ 40 %), and main 7.2 M + cascade 2.4 M in the tiled world (≈ 25 %). On a far-map refresh frame the tiled world adds 6.2 M.
- **Caster selection is not too generous by rule:** the light box, the shadow-reach test and the cascade box. The waste is again box granularity: looking at the ground, the ±24 m cascade still took 1.1 M (diorama) / 2.0 M (tiled) triangles, because whole 100–420 m chunks touch it.

### 3. Is frustum culling correct?

**Yes. No test is missing**, and no main-pass entry lacked a box (`noBox` 0 in every pose). Skinned parts are culled on their own path.

**The granularity is coarse:**

| Pose | Main-pass triangles wholly outside the frustum |
|---|---|
| Diorama street / wall / ground | 41 % / 38 % / 94 % |
| Tiled street / wall / ground | 36 % / 40 % / 95 % |

These triangles lie inside boxes that pass the frustum test. They are clipped by the GPU, but they cost vertex work and draw submission. Where they come from:
- **Streamed tiles: one mesh per layer per tile.** A 420 m box: diag 27.9 units, the tile span. Utility wires 73 k triangles in ONE mesh, roof equipment 60 k, crowd 55 k, signal housings 47 k, ducts 44 k, car trim 35 k, sign text 30 k. Round 5 chose this on purpose (`_addTracked` chunk=false: re-chunking tiles measured +73 % meshes and 2× renderer CPU).
- **The static crowd's twin grid** (`PED_TWIN_CELL_M = 110` m, deliberately coarse so ~25 colours × 3 tiers stay a few hundred meshes): one near cell holds 61 k triangles of skin.
- **Small detail layers are never split.** `chunkGridFor` needs 4 × 1,500 triangles before it splits at all, so 3–6 k triangle layers (door frames, doors, sign ink, trim, lamplights) are one city-wide box (diag ≈ 27 units).
- **Corner cases:** 90–130 entries per pose had every triangle outside although their box passed. These are boxes crossing a frustum corner. That is normal for an AABB test, not a bug.

**Verification finding (no engine bug):** an instanced group's box is `origins ± the source's world extent`. The source mesh's own rotation and scale apply to every instance, so the box is conservative. The first version of the checker missed that and reported false violations.

### 4. Occlusion: how much would perfect occlusion remove?

A CPU z-buffer of the frame's opaque main-pass triangles (320×200, near-clipped) was used, then each entry was tested.

| Pose | Perfect occlusion, per entry | Box test, all occluders | Box test, building walls only |
|---|---|---|---|
| Diorama street | 48 % of main tris, 75 % of entries | 26 % | 20 % |
| Diorama wall | 50 % | 29 % | 24 % |
| Diorama ground | 65 % (the "occluder" is the ground) | 1.5 % | 1.2 % |
| Tiled street | 74 % | 41 % | 21 % |
| Tiled wall | 72 % | 28 % | 22 % |

Two reasons hold the real gain down:
- The view reaches through a wall to the far plane, but a whole chunk is drawn if any part of it peeks out.
- Many occluders are not walls: kerbs, parked cars, the shop glass.

### Fixes (each with an A/B switch)

- [x] **P11.1 Honest per-pass counters + HUD fields** (§1). `pass-stats.ts`, `Renderer3D` pass buckets, `getRenderStats3D().drawn / drawCalls`, `getCityLodStats3D().frame.trisMain…`. Frogmarks HUD updated. Tests: `pass-stats.test.ts`.
- [x] **P11.2 Sub-mesh cull ranges** (`src/renderer/3d/cull-ranges.ts`; `Renderer3D.rangeCulling`, **default on**). This fixes the oversized boxes without more meshes.
  - **How it works:** a single-material opaque mesh of ≥ 2,048 triangles (`CULL_RANGE_MIN_TRIS`) gets runs of 256 triangles (`CULL_RANGE_TRIS`) in index order, each with a world box. Blocks of 16 runs also get a box.
  - **When it applies:** a mesh that passes the frustum test but is not wholly inside it (`FrustumCuller.containsBox`) draws only its runs that pass, as index sub-ranges. Kept runs ≤ 2 runs apart merge (`CULL_RANGE_MERGE_GAP`).
  - **Where:** the same applies to each near cascade against its own box. The prepass / outline / SSAO replays reuse the main-pass spans.
  - **Not ranged:** wind-swayed, billboard, vertex-coloured, multi-material and moving meshes (moving = matrix changed within 120 frames). Ranges are also off while a planar mirror is live or with PS1 vertex jitter.
  - **Builds:** lazy, capped at 400 k triangles a frame (`CULL_RANGE_BUILD_TRIS`).
  - **Why it is bit-identical:** a run is dropped only when its box is wholly outside one clip plane of the pass it is dropped from. Triangles keep their order.
  - **Frozen-time pixel A/B** (`rangeab.js`; ranges off / on / on + occlusion / off again):
    - 0 differing pixels at 4 of 6 diorama poses and 5 of 6 tiled poses.
    - The other poses differ only by the off-vs-off noise floor (24 and 303 px).
  - **Result (rangeab / poses):**

    | | Main pass | Near cascade |
    |---|---|---|
    | Tiled street | 8.0 → 5.6 M (−30 %) | 0.95 → 0.53 M |
    | Tiled, looking down | 2.3 → 0.9 M | — |
    | Tiled, Play street / wall / ground | 7.2 / 6.7 / 0.9 → 6.0 / 5.4 / 0.57 M | 2.36 / 1.88 / 1.98 → 1.13 / 0.90 / 0.98 M |
    | Diorama, Play street / wall / ground | 1.65 / 1.62 / 0.94 → 1.43 / 1.37 / 0.57 M | 1.10 / 1.04 / 1.08 → 0.82 / 0.78 / 0.81 M |

  - **Play walk, interleaved** (`abcpu.js`):

    | | Triangles submitted | Draw calls | `msCull` CPU | `msTotal` CPU |
    |---|---|---|---|---|
    | Tiled | 9.09 → 6.33 M | +5 % | +0.8 ms | +0.7 ms |
    | Diorama | 2.67 → 2.21 M | +3 % | +0.5 ms | +0.9 ms |

  - **GPU, paired, tiled street, 1540×900, shared GPU:** main pass −0.5 to −0.6 ms at 3 of 4 poses (−0.13 at the 4th). All passes −2 to −6 ms, but that figure is noisy.
  - **Tests:** `cull-ranges.test.ts` (run cover, boxes, matrix, merged spans = exactly the passing runs, block hierarchy, gap merge, `containsBox`).
- [x] **P11.3 CPU occlusion cull** (`src/renderer/3d/occlusion-culler.ts`; `Renderer3D.occlusionCulling`, **default OFF**).
  - **What it rasterises:** the frame's building walls (`OCCLUDER_NAMES`: detailed buildings' walls, party walls and ground floors, plain / massing bodies; opaque, untextured, fog class 0) into a 256-px-wide CPU depth buffer from the frame's own view-projection.
  - **What it culls:** main-pass meshes and groups whose box is wholly behind them. Shadow lists are untouched; the outline / SSAO prepasses follow the main list.
  - **Why it cannot pop:** same frame, no latency, so nothing pops while turning.
  - **Why it is conservative by construction:**
    - A pixel is marked only when one convex occluder polygon covers its whole square. Coplanar triangle pairs are merged into quads first, so a wall's diagonal is no hole.
    - It stores the polygon's farthest depth over the pixel.
    - A box is hidden only if every pixel it touches is marked nearer than its nearest corner.
    - Boxes crossing the near plane stay.
  - **Kept regardless:** outlined, selected, hovered and always-on-top meshes. The cull is off for ortho cameras and with a planar mirror.
  - **Verification:**
    - `occlusion-culler.test.ts`: 60 random wall / box scenes against a dense ray reference, with 0 wrongly culled.
    - `verify.js`: a Play walk with ~20°-per-frame turn bursts plus a 25°-per-frame free-camera spin, diorama and tiled. 52 + 60 checked frames, up to 2,024 culled meshes a frame, **0 culled meshes visible** in a CPU reference depth buffer of what was drawn.
    - Frozen-time pixel A/B: identical (above).
  - **Gain:**

    | | Main tris (street / wall) | Main draw calls |
    |---|---|---|
    | Diorama | −0.25 M (−15 %) | −40 % |
    | Tiled | −0.45 M | −27 % |

  - **Cost:**
    - Occluder raster 0.9 ms (diorama) / 3.6 ms (tiled, ~10 k occluder polygons) a frame, plus ~0.3–0.6 ms of box tests.
    - `msTotal` +0.7 / +1.0 ms in a Play walk.
    - GPU main pass ±0.06 ms (no measurable change: hidden fragments already fail the depth test, and the pass is pixel-bound, P6).
  - **Decision:** kept off. A net CPU cost for no measured GPU gain. Its value would come with a GPU-driven draw path (below).
- [-] **Re-chunking streamed tiles / a finer crowd grid / splitting small detail layers: not done.** P11.2 removes their out-of-view triangles without the +73 % meshes and 2× draw-list CPU that Round 5 measured for re-chunking.

### Switches

| Switch | Default | Effect |
|---|---|---|
| `Renderer3D.rangeCulling` | true | Sub-mesh cull ranges, main pass + cascades |
| `Renderer3D.CULL_RANGE_TRIS` | 256 | Run size |
| `Renderer3D.CULL_RANGE_MIN_TRIS` | 2048 | Smallest ranged mesh |
| `Renderer3D.CULL_RANGE_MERGE_GAP` | 2 | Dropped runs bridged into one draw |
| `Renderer3D.CULL_RANGE_BUILD_TRIS` | 400 k | Run-box build budget a frame |
| `Renderer3D.occlusionCulling` | false | CPU occlusion cull |
| `Renderer3D.OCCLUSION_WIDTH` | 256 | Occlusion buffer width |
| `Renderer3D.OCCLUDER_NAMES` | building wall layers | Occluder families |
| `renderer3D.occlusionDebugList` | null | When an array: the meshes and groups culled last frame (verification) |

Diagnostics: `getFrameStats3D()` `rangeTrisCulled`, `rangeTrisCulledCascade`, `rangeBuilds`, `occlCulled`, `occlTrisCulled`, `msOccl`; `renderer3D.occlusionStats`.

### Recommendations (ranked, not done)

1. **Triangles are not the GPU limit at street level** (P6: the main pass is pixel-bound). Expect fps from resolution / PCF tiers rather than from more culling; P11.2 is kept because it is free of artefacts and trims vertex and cascade work.
2. **A GPU-driven path is where occlusion would pay.**
   - The design: a depth prepass (it exists for SSAO), a Hi-Z pyramid and a compute cull of chunk / run boxes feeding `drawIndexedIndirect`.
   - It removes the CPU cost that sinks P11.3, and the vertex work of hidden geometry.
   - It is only worth it once the CPU draw list is the ceiling (occlusion-culling.md Phase 4).
3. **(Done: P14.1.)** **The far static shadow map in tiled worlds** (6.1–6.3 M triangles a re-render) is the largest single submission. Range-culling its casters against the shadow-reach volume is the next step. It is cached, so it only matters on re-render frames.
4. **(Done: P14.2.)** **Near cascades** re-render every frame in Play. A static / dynamic split like P4.2 (P6 "remaining ideas") would cut 0.8–1.1 M triangles a frame to the dynamic casters.
5. **Occluder raster in tiled worlds:**
   - It could skip occluders whose screen box is under ~8 buffer pixels (most of the 10 k polygons).
   - Or it could reuse last frame's wall set.
   - That would make P11.3 affordable (≈ 1 ms) if a GPU gain shows up at large resolutions.
6. **A street-canyon PVS** (occlusion-culling.md Phase 2) remains the cheap, deterministic option for walk mode. It needs a cell graph that is still not built. The measurements above bound its gain at ≈ 50 % of main-pass triangles (perfect per-entry occlusion), with less from the box granularity.

## P12 — Instanced crowd (2026-10-01)

**Problem.** The static crowd was baked. Every person's posed vertices were merged into per-colour layers, three times over (the near, mid and far tiers from P9), and cut on the 110 m twin grid. That cost:
- ~91 MB of vertex data per full tile (out of 240 MB);
- a 50–60 ms "World Pedestrians" reassembly job whenever a tile landed;
- ~1,000 crowd meshes per tile in the draw-list loop.

**Why not one mannequin per pose.** Almost every person is different. Clothes cut × hair × bag × pose × mirroring gives ~400 distinct shapes in a ~550-person tile (~3 people per shape) and ~1,500 across a 3×3 window, before height and build are counted. A shared mesh can only stand in where a person is small.

### Architecture (`src/world/crowd-instanced.ts`, `src/services/managers/world-crowd.ts`)

- **Each build stores one RECORD per person.**
  - It is 22 doubles: anchor, facing, archetype + look seed, pose, umbrella, mirroring, rail, group, seed, cell and drape offset.
  - It holds every input `emitPerson` needs, derived with the same hashes as the baked build (`staticPersonSpec`, shared by both paths).
  - The records ride on one AUX layer, which never becomes a mesh. Its geometry is the people's ground footprints (one convex hull per person), so the contact-blob pass (worker or main thread) treats it like any crowd layer.
- **XFAR, past the second twin distance (100 m): GPU-instanced shared variants.**
  - A variant is a coarse silhouette class: garment, skirt length, hair length, bag kind, umbrella (open or furled) and the pose silhouette (stand / stride / sit / lean / rail). It is emitted once, at the cheapest tessellation, for a canonical 1.70 m person.
  - Each vertex carries a palette SLOT code in uv.x.
  - Each copy carries its own colours (12 slots × 5 bits, in patternColor.xyz) and a (width, height, width) scale.
  - There is one ArrayGroup per (tile, variant): ~65 per tile.
  - ~85 variants (1.3 MB) are shared by the whole 3×3 window. They share one GPU allocation through instanceKey and one JS geometry through `WorldCrowd.intern`.
  - The group's source is a phantom (`Mesh3D.arraySourceOnly`): it owns the slot and the material, but is never drawn and never collided with. So every person is a copy, and any one person can be hidden through `InstanceOverride.visible`. `Renderer3D.repackArrayGroups` then repacks only that group, never everything.
- **NEAR (< 30 m) and MID (< 100 m): the exact baked people, built lazily.**
  - Only the cells around the camera are built. Cells are 50 m, tile-aligned, 6 × 6 per tile.
  - `CrowdCellBuilder` makes the same `emitPerson` calls as the baked build into ONE palette-coded mesh per cell. Each vertex carries a palette index, so there is no per-colour split. The mesh keeps the live crowd's (person, part) ranges.
  - Building is time-sliced on the main thread: 3 ms of people per frame, then one frame for the merge + upload (≤ 4.5–6.6 ms).
  - A tier is prefetched at 1.45 × (near) / 1.25 × (mid) its swap distance and evicted past 2.2 × / 1.7 ×, with a 160 MB cap (LRU). Under ortho (one uniform zoom distance) only cells in view are built.
- **The crowd manager, not the renderer, picks each cell's tier** (`WorldCrowd.update`, called from the world LOD callback).
  - It applies the renderer's rules: lens and quality scale, ortho = `orthoLodDistance`, 10 % hysteresis, distance LOD off = mid.
  - A cell switches to the wanted tier only once that mesh is on the GPU (`hasMeshGeometry`). Until then it shows the nearest tier that is resident, or xfar. So there is never a frame where neither tier draws.
  - The choice is written into the meshes' externally driven twin state, `Mesh3D.lodTwinExternal`, and into the xfar copies' visibility. The renderer only applies `twinDraws` to that state; it never updates it, re-seeds it or resets it when LOD is off.
- **Colour: one grey material for the whole crowd** (`Material3D.crowdPalette`, flags2 bit 4, `renderer/3d/crowd-palette.ts`).
  - diffuse = the PED_SHADE grey, and the GLOW walk sets emissive = grey × factor.
  - The vertex shader and both fragment shaders multiply diffuse and emissive by the palette colour.
  - So `pedestrianStyle`, the day / night glow and the city render style apply unchanged. `WorldManager._dressCrowdMesh` dresses each new cell mesh the way a baked layer was dressed.
- **Live crowd hand-off.**
  - The live crowd indexes the lazily built cell meshes the same way it indexed the baked layers.
  - When a person is promoted, their ranges are degenerated in both the near and the mid cell meshes, and their xfar copy hides (`WorldCrowd.setLive`).
  - If a cell is built while someone in it is live, their ranges are hidden at once (re-index on `WorldCrowd.version`).
  - On release everything is restored.
- **Drape: one rigid offset per person.** It is the height tier at the feet (people on a bridge deck use the smooth field) plus the warp displacement at the feet (`drapeCrowdRecords`, in `drapeLayerGroups` and `_addStaged`).
  - The baked crowd draped per vertex. On flat paving the result is the same.
  - The domain warp's gradient across a person shifts edges by under a pixel (see below).
- **Lifecycle.**
  - The lazily built meshes are children of their build's group.
  - A tile dispose, a tile retire or a centre park strips them first (`onGroupsRemoved`). They are rebuilt on demand, not cached.
  - Groups that come back (an LRU re-attach, a centre restore) are found again by the liveness scan. Each group keeps a `_crowdReg` stash holding only the records and ids.
- **Persistence: nothing new is saved.**
  - The lazy meshes are `excludeFromDocument`.
  - `instancedCrowd` is a world param like `propTwins`: absent means on, and only `false` is stamped.
- **Play collision.**
  - The centre's crowd still collides, through the lazily built near / mid cells (the people around the player) and the live rigs.
  - The phantom sources are skipped.
  - Streamed tiles' crowd is not collision geometry, as before (`collisionSkipTileCrowd`).

### Results (3×3 'full' tiled world, seed 3, headless harness; pupdrive/crowd)

| | Baked (`instancedCrowd(false)`) | Instanced |
|---|---|---|
| Crowd bytes per tile (node, 8 tiles) | 91.0 MB vertex data | 98 KB records + 570 copies × 240 B GPU slots (134 KB). AUX footprints: 449 KB, CPU only, dropped after the contact pass |
| Shared crowd geometry | — | 85 xfar variants, 1.3 MB for the window |
| Lazily built near + mid geometry (around the camera) | — | 17–20 MB at street level and in Play, 0 from the overview |
| Geometry pool, 3×3 (all / crowd) | 1,975 / 787 MB | 1,207 / 20 MB |
| Tile build in the worker (node, whole tile) | 2,738 ms | 1,358 ms |
| 3×3 settle from a diorama | 15.5 s | 11.1 s |
| Crowd reassembly jobs while the 3×3 lands (count / sum / worst) | 384 / 409 ms / 50.5 ms | 166 / 48 ms / 1.7 ms per tile (26.7 ms: the centre's first job) |
| Worst reassembly job overall | 55–62 ms, "World Pedestrians" | 14–28 ms, not crowd (Furniture / Signals / Streets) |
| Long tasks while landing | 16–20, top 186–237 ms | 13–21, top 145–235 ms (none from the crowd: centre staging, streets) |
| Crowd draws, main pass (street / rooftop / Play) | 332 / 277 / 330 | 175 / 150 / 154 |
| Crowd triangles, main pass (street / Play) | 617 k / 541 k | 733 k / 640 k (includes the zero-scale hidden copies in whole-tile groups) |
| Crowd triangles, near cascades (street / Play) | 52 k / 60 k | 120 k / 137 k |
| Renderer CPU at street, rendering suspended (msTotal / msCull) | 7.5 / 3.4 ms | 6.9 / 3.2 ms |
| Renderer CPU, live loop (street / rooftop / Play) | 7.4 / 7.6 / 8.1 ms | 7.1 / 7.5 / 9.2 ms (within run-to-run noise) |
| Crowd meshes + groups | ~9,000 meshes | ~50 cell meshes + 635 groups |
| Live crowd scan, worst | 8.6 ms | 3.1–5.2 ms |
| Crowd meshes in the centre's collision snapshot | 1,044 | 146 (cells + live rigs) |

Diorama (seed 3), at street level: crowd draws drop from 172 to 94, crowd triangles stay the same (182 k), and the crowd's share of the pool drops from 787 MB to ~18 MB.

**Visual identity.** Measured with `crowd/ab.js` (diorama) and `crowd/ab2.js` (tiled, across sessions). The clock, wind, traffic, signals and border glow are frozen or hidden. Diffs are measured only inside the crowd's own pixels, i.e. where hiding the crowd changes the frame.
- **Near and mid people are the baked ones, triangle for triangle** (`crowd-instanced.test.ts` compares positions and normals per person and colour, before the drape).
- **Street, low, mid and aerial poses:**
  - 8–15 % of crowd pixels differ by more than 8 levels, and 2–5 % by more than 32.
  - These are 1 px edge shifts (rigid vs per-vertex warp) plus slightly different contact blobs.
  - The noise floor is 0, and the rest of the frame is identical.
- **Every `pedestrianStyle` (flat / default / cel / cel-hd / ink) and night:** the same edge-only diffs, so the colours are exact.
- **Xfar (sky, or ortho past 100 m):** ~20 % of crowd pixels differ by more than 8, and 5 % by more than 32. These are the coarse silhouette classes, at ~15 px per person.

### Switches

| Switch | Default | Effect |
|---|---|---|
| world param `instancedCrowd` / `salsaWorld.instancedCrowd(false)` | on | false = the baked crowd (rebuilds the world) |
| `CROWD_XFAR.bigK` / `.detail` (crowd-instanced.ts) | 6 (whole tile) / 0 | xfar group size / how fine the silhouette classes are (1 also splits figure, hat and shirt front: ~77 per tile) |
| `CROWD_CELLS_PER_TILE` | 6 (50 m) | near / mid cell size |
| `WorldCrowd.BUILD_MS` / `PREFETCH` / `EVICT` / `MAX_BYTES` | 3 ms / [1.45, 1.25] / [2.2, 1.7] / 160 MB | lazy build budget and residency |

Diagnostics: `salsaWorld.crowdStats(reset?)`. It reports cells shown per tier, resident cells and bytes, builds, build / finish / update maxima and repacks; `bytes` breaks down records, copies and variants.

### Tests

- `src/world/crowd-instanced.test.ts`:
  - the palette table equals PED_PALETTE;
  - the records are the baked build's people, and are deterministic;
  - cells are tile-aligned;
  - the drape offset;
  - near / mid cells equal the baked tiers exactly;
  - one copy per person, carrying its own slots;
  - one geometry per variant key;
  - the per-build payload is small;
  - the A/B switch.
- `src/services/managers/world-crowd.test.ts` (fake world):
  - a cell shows xfar until its tier is resident, then near;
  - the twin flags and the copies' visibility;
  - far away = all xfar, with the lazy tiers evicted;
  - the 10 % hysteresis;
  - the live hand-off;
  - LOD off = mid;
  - a vanished build is dropped.
- Updated for the A/B:
  - `crowd-live`, `lod-accum`, `street-slots` and `city-water-edges` now build with `instancedCrowd: false`;
  - `world-first-city` (AUX layers are not meshes).
- Browser: `pupdrive/crowd/handoff.js`. With 25 people live, 664 ranges are degenerated in near + mid cells, 25 copies are hidden, and every copy matches its cell's tier. All are restored on release.

### Open items

- **The xfar classes are approximations.** Arm holds, mirroring, hats and shirt fronts (at detail 0), the height-dependent head size and the shoe cut are merged. The baked far tier was exact. `detail: 1` brings back the figure, hats and shirt fronts at ~+40 % groups.
- **The drape is rigid per person.** For an exact match, `CrowdCellBuilder` could apply the warp per vertex (main-thread warp, ~5–10 ms per near cell). Heights stay rigid either way, because the tile graph's kerb field is not on the main thread.
- **Whole-tile xfar groups have coarse culling.**
  - When any part of a tile is in view, all of that tile's xfar copies are vertex-shaded.
  - They cast into the near cascades as one box.
  - 150 m groups would fix both, but cost +3 ms CPU. A per-instance GPU cull, or putting array groups into the P9 clusters, would give the 150 m granularity back without that cost.
- **The lazy builds run on the main thread:** ~0.55 ms per near person and 0.2 ms per mid person. A worker lane for cell builds would take the 4–7 ms finish frames off it. Flying fast at street level shows xfar for a few frames before mid lands; the prefetch hides this at walking and Play speeds.
- **The instanced crowd always has three tiers,** so `propTwins: false` does not change it. With distance LOD off, mid is built only within 125 m, and xfar shows beyond that.
- **Contact blobs** are built from the xfar classes' footprints, while the baked build used every tier's vertices. Blob extents differ by centimetres.

## P13 — Baseline frame profile (engine-roadmap step 0) + simulation LOD (step 1), 2026-10-01

**Scenes.** Salsa vite harness (live source), headless Chrome + WebGPU (d3d11, RTX 2070 SUPER), 1300 × 850, vsync 60:
- **Diorama:** seed-3 grid city, traffic on (432 movers), Play third person with the auto player walking down a street
  with periodic turns (`setPlayInput3D`), 25 s ≈ 1,500 frames.
- **Tiled 3×3:** the same city as a tiled world (`tiles(1, 'full')`), Stream to camera on (9 full + 35 flat tiles,
  ~11.5 k meshes), the same Play walk, 25 s ≈ 1,250 frames. Tiled worlds run no traffic (P10.D).

**Method** (drivers in scratchpad `pupdrive/prof/`):
- `prof.js` + `early.js` + `inject.js`: ~60 subsystem methods wrapped with `performance.now()` (EXCLUSIVE time: a
  wrapped child is subtracted from its parent), every rAF callback, worker message and timer task bucketed, frames cut
  at each `render()`. Per-frame sums → p50 / p95 / mean. `performance.now()` is 0.1 ms-quantized in the page, so small
  buckets have a p50 / p95 of 0 or 0.1: read their means. Wrapper overhead: busy p50 8.7 (wrapped) vs 8.1 ms (plain).
- Cross-checks: the same runs without wrappers (`NOINST=1`), Chrome tracing (`TRACE=1`: MinorGC / MajorGC, the RunTask
  union on the main thread) and the CDP sampling profiler (`PROF=1`, `b-*-prof-prof.txt`). They agree: diorama
  526 ms/s of main-thread tasks (8.8 ms a frame) vs 8.5 ms busy mean; tiled 996 ms/s (CPU-bound).
- GPU: per-pass timestamps (`GPU=1`, p1/gpuprof.js) on an idle GPU (`p6/gpuidle.sh`: 0 % before each run).
- Real Frogmarks: `fm-angular.js` (below). Its dist (2026-10-01 16:04) predates P11 / P12, so it measures host costs only.

### Baseline profile (and the step-1 after columns)

ms per frame. "p50 / p95 / mean" are the baseline runs (the code before step 1); the after columns are a later pair
of runs in one build, sim LOD off → on (means). The "after step 2" columns are the same Play walks with every step-2
change on (`pupdrive/step2/`, wrapped run; §Step 2 below has the paired before / after of the same session). A row
with "– / –" sums several buckets (no per-frame p50 / p95).

| Subsystem | Diorama p50 / p95 / mean | Tiled 3×3 p50 / p95 / mean | Diorama after: sim LOD off → on (mean) | Tiled after: off → on (mean) | Diorama after step 2 p50 / p95 / mean | Tiled after step 2 p50 / p95 / mean |
|---|---|---|---|---|---|---|
| **Simulation** | | | | |  |  |
| Walkers: route sim | 0.1 / 0.3 / 0.12 | 0 | 0.12 → 0.00 | 0.00 → 0.00 | 0 | 0 |
| Walkers: pose write (limbs, gait) | 0.3 / 0.5 / 0.32 | 0 | 0.32 → 0.10 | 0.00 → 0.00 | 0.1 / 0.2 / 0.10 | 0 |
| Walkers: door visits | 0.0 / 0.1 / 0.01 | 0 | 0.01 → 0.01 | 0.00 → 0.00 | 0.0 / 0.1 / 0.01 | 0 |
| Cars: route sim | 0.1 / 0.3 / 0.11 | 0 | 0.10 → 0.04 | 0.00 → 0.00 | 0.0 / 0.1 / 0.04 | 0 |
| Cars: yield scan | 0.1 / 0.2 / 0.07 | 0 | 0.06 → 0.02 | 0.00 → 0.00 | 0.0 / 0.1 / 0.02 | 0 |
| Cars: pose write | 0.1 / 0.2 / 0.10 | 0 | 0.10 → 0.05 | 0.00 → 0.00 | 0.0 / 0.2 / 0.05 | 0 |
| Trains (rail runs) | 0.1 / 0.2 / 0.09 | 0 | 0.08 → 0.03 | 0.00 → 0.00 | 0.0 / 0.1 / 0.03 | 0 |
| Signals + level crossings | – / – / 0.00 | – / – / 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | – / – / 0.00 | – / – / 0.00 |
| Movers: tick (chat scan, block grid, legacy movers, sim-LOD bands) | 0.2 / 0.5 / 0.24 | 0 | 0.24 → 0.35 | 0.00 → 0.00 | 0.3 / 0.6 / 0.35 | 0 |
| Movers: pose gate + terrain + warp | – / – / 0.20 | – / – / 0.00 | 0.22 → 0.08 | 0.00 → 0.00 | – / – / 0.08 | – / – / 0.00 |
| Clouds + other legacy movers (pose) | – / – / 0.03 | – / – / 0.00 | 0.03 → 0.01 | 0.00 → 0.00 | – / – / 0.02 | – / – / 0.00 |
| Live crowd: scan + promotion | 0.0 / 0.1 / 0.01 | 0.0 / 0.2 / 0.02 | 0.01 → 0.01 | 0.02 → 0.03 | 0.0 / 0.1 / 0.01 | 0.0 / 0.2 / 0.02 |
| Live crowd: poses | 0.0 / 0.1 / 0.04 | 0.0 / 0.1 / 0.04 | 0.04 → 0.04 | 0.04 → 0.05 | 0.0 / 0.1 / 0.04 | 0.1 / 0.1 / 0.06 |
| Crowd cells (P12): tier update | 0.0 / 0.1 / 0.03 | 0.1 / 0.3 / 0.13 | 0.03 → 0.03 | 0.13 → 0.13 | 0.0 / 0.1 / 0.03 | 0.1 / 0.2 / 0.12 |
| Crowd cells (P12): lazy builds | – / – / 0.00 | – / – / 0.03 | 0.00 → 0.00 | 0.03 → 0.04 | – / – / 0.00 | – / – / 0.03 |
| Day cycle + world ticker | – / – / 0.02 | – / – / 0.10 | 0.03 → 0.03 | 0.12 → 0.12 | – / – / 0.02 | – / – / 0.10 |
| Character skeleton sync | 0.1 / 0.2 / 0.14 | 0.2 / 2.1 / 0.38 | 0.14 → 0.14 | 0.37 → 0.38 | 0.0 / 0.1 / 0.02 | 0.0 / 0.1 / 0.10 |
| Locomotion animator (player) | 0.0 / 0.1 / 0.04 | 0.1 / 0.2 / 0.06 | 0.04 → 0.03 | 0.05 → 0.05 | 0.0 / 0.1 / 0.04 | 0.0 / 0.1 / 0.04 |
| Procedural idle / spring bones | – / – / 0.00 | – / – / 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | – / – / 0.00 | – / – / 0.00 |
| Play controller + camera + player mesh | – / – / 0.12 | – / – / 0.33 | 0.12 → 0.12 | 0.31 → 0.33 | – / – / 0.12 | – / – / 0.24 |
| Play collision rays | 1.3 / 1.6 / 1.28 | 1.3 / 2.4 / 1.40 | 1.33 → 1.27 | 1.35 → 1.33 | 1.3 / 1.7 / 1.29 | 1.3 / 2.0 / 1.40 |
| Script behaviours | 0 | 0 | 0.00 → 0.00 | 0.00 → 0.00 | 0 | 0 |
| **Rendering CPU** | | | | |  |  |
| Draw lists + cull (frustum, ranges, fog, LOD / twins, clusters) | 1.6 / 2.0 / 1.68 | 4.6 / 5.8 / 4.77 | 1.70 → 1.55 | 4.65 → 4.69 | 1.6 / 2.1 / 1.67 | 4.5 / 5.7 / 4.62 |
| Instance uploads | 0.7 / 1.0 / 0.78 | 1.4 / 3.8 / 1.55 | 0.76 → 0.49 | 1.61 → 1.59 | 0.2 / 0.3 / 0.18 | 0.8 / 1.4 / 0.85 |
| Geometry pool | 0.0 / 0.1 / 0.04 | 0.1 / 1.3 / 0.19 | 0.04 → 0.04 | 0.21 → 0.22 | 0.0 / 0.1 / 0.05 | 0.1 / 0.6 / 0.18 |
| Main pass encode (incl. draw-order re-sort on structure changes) | 1.0 / 1.4 / 1.08 | 2.3 / 13.1 / 2.96 | 1.06 → 1.01 | 2.76 → 2.85 | 0.9 / 1.3 / 0.95 | 2.4 / 3.6 / 2.49 |
| Shadow + prepass encode | 0.2 / 0.3 / 0.18 | 0.2 / 0.4 / 0.23 | 0.19 → 0.18 | 0.22 → 0.21 | 0.1 / 0.3 / 0.12 | 0.1 / 0.3 / 0.15 |
| Planar mirror pass | 0.1 / 0.2 / 0.09 | 0.3 / 0.5 / 0.33 | 0.10 → 0.08 | 0.35 → 0.36 | 0.1 / 0.2 / 0.10 | 0.3 / 0.4 / 0.32 |
| Skinned characters (cull, skin upload, draw) | 0.1 / 0.2 / 0.06 | 0.1 / 0.2 / 0.08 | 0.05 → 0.05 | 0.08 → 0.08 | 0.0 / 0.2 / 0.06 | 0.1 / 0.2 / 0.07 |
| Overlays / post / particles / scene uniforms / other | – / – / 0.24 | – / – / 0.74 | 0.22 → 0.22 | 0.77 → 0.78 | – / – / 0.22 | – / – / 0.56 |
| GPU API (writeBuffer, submit) | – / – / 0.22 | – / – / 0.18 | 0.36 → 0.24 | 0.16 → 0.18 | – / – / 0.22 | – / – / 0.10 |
| **Editor / host overhead** | | | | |  |  |
| 2D strategy beginFrame (walks every node) | 0.5 / 0.7 / 0.53 | 1.5 / 1.7 / 1.55 | 0.53 → 0.53 | 1.56 → 1.57 | 0.0 / 0.0 / 0.00 | 0.0 / 0.0 / 0.00 |
| collectActiveCarets + collectSelectionHighlights | – / – / 0.18 | – / – / 0.53 | 0.16 → 0.16 | 0.53 → 0.53 | – / – / 0.00 | – / – / 0.00 |
| 2D render-list rebuild (on visibility changes) | 0.0 / 0.0 / 0.03 | 0.0 / 8.3 / 0.61 | 0.03 → 0.03 | 0.59 → 0.65 | 0.0 / 0.0 / 0.01 | 0.0 / 0.1 / 0.12 |
| 2D uploads / vector draw | – / – / 0.01 | – / – / 0.01 | 0.01 → 0.01 | 0.01 → 0.01 | – / – / 0.01 | – / – / 0.01 |
| Host render() other (mesh / particle / grease-pencil list scans, compose, submit) | – / – / 0.74 | – / – / 2.02 | 0.71 → 0.72 | 2.05 → 2.00 | – / – / 0.09 | – / – / 0.13 |
| Pre-render callbacks (arrays, world LOD, orbit, misc.) | – / – / 0.08 | – / – / 0.36 | 0.09 → 0.09 | 0.38 → 0.39 | – / – / 0.09 | – / – / 0.35 |
| **Streaming** | | | | |  |  |
| Stream follow callback + worker messages | – / – / 0.00 | – / – / 0.02 | 0.00 → 0.00 | 0.02 → 0.02 | – / – / 0.00 | – / – / 0.01 |
| Timers / other tasks | – / – / 0.00 | – / – / 0.66 | 0.00 → 0.00 | 0.54 → 0.56 | – / – / 0.00 | – / – / 0.57 |
| **Totals (per-frame sums)** | | | | | | |
| Simulation (sim + anim) | 1.5 / 1.9 / 1.57 | 0.6 / 2.6 / 0.76 | 1.57 → 0.97 | 0.77 → 0.79 | 0.8 / 1.2 / 0.85 | 0.3 / 1.3 / 0.46 |
| Play (controller, rays, camera) | 1.4 / 1.7 / 1.39 | 1.4 / 2.8 / 1.73 | 1.46 → 1.39 | 1.66 → 1.66 | 1.4 / 1.8 / 1.40 | 1.4 / 2.3 / 1.64 |
| Rendering CPU (Renderer3D) | 3.9 / 5.2 / 4.16 | 9.5 / 27.0 / 10.87 | 4.12 → 3.61 | 10.65 → 10.79 | 3.7 / 5.1 / 3.88 | 9.7 / 14.8 / 10.31 |
| 2D overlay walks | 0.7 / 1.0 / 0.76 | 2.1 / 10.4 / 2.70 | 0.73 → 0.72 | 2.70 → 2.76 | 0.0 / 0.1 / 0.03 | 0.0 / 0.2 / 0.13 |
| Host render() other | 0.7 / 1.0 / 0.74 | 2.0 / 2.4 / 2.02 | 0.71 → 0.72 | 2.05 → 2.00 | 0.2 / 0.3 / 0.16 | 0.3 / 0.5 / 0.32 |
| Main thread busy (rAF + worker + timer tasks) | 8.7 / 10.4 / 8.93 | 15.9 / 46.7 / 19.31 | 9.05 → 7.74 | 18.94 → 19.16 | 6.4 / 8.5 / 6.64 | 12.2 / 21.9 / 13.90 |
| Frame interval (vsync 60) | 16.7 / 16.8 / – | 16.7 / 46.9 / – | | | 16.7 / 16.8 / – | 16.7 / 22.3 / – |
| GC (MinorGC + MajorGC, trace) | – / – / 0.028 | – / – / 0.066 | 0.036 → 0.026 | 0.071 → 0.076 | – | – |
| Idle / GPU wait (16.67 − busy) | – / – / 7.73 | – / – / 0.00 | | | – / – / 10.02 | – / – / 2.77 |

**GPU frame** (idle GPU, median per pass): diorama main colour pass 7.3 ms + near cascade 0.43 + shadow min/max 0.13 +
post ≈ 0.5 → ~8.8 ms; tiled main pass 7.6 ms, but at 1014 × 663: the pan-time dynamic resolution (0.78) is kicked on
every camera move, so Play in a streamed world always renders scaled. Both are under the 16.7 ms budget at this size;
the diorama is vsync-bound with ~7.7 ms of CPU idle, the tiled world is CPU-bound.

**Top costs.**
- **Tiled (CPU-bound, 48–50 fps, p95 frame 47 ms):** draw lists + cull 4.8 ms, pass encoding ~3.5 ms (main pass p95
  13 ms), the editor's 2D walks 2.7 ms (beginFrame 1.55, carets + highlights 0.53, render-list rebuild p95 8.3 ms),
  host `render()` scans 2.0 ms, instance uploads 1.6 ms, Play collision rays 1.4 ms, character skeleton sync 0.4 ms
  (p95 2.1). Simulation 0.8 ms.
- **The p95 is structure-change hitches.** Each structure change (a lazily built crowd cell, a live-crowd promotion /
  demotion) costs, in one frame: the main pass's draw-order re-sort (`_drawOrderDirty` → `meshes.slice().sort` of all
  meshes by `geometryKey` strings, ~10 ms), the 2D render-list rebuild (~8 ms), the pipeline-roster prewarm (p95
  3.3 ms), the skeleton-sync `getAllMeshes()` instanceof scan (~2 ms) and an incremental instance repack (p95 2.3 ms).
  Measured with extra wrappers (`x-tiled-extra.log`).
- **Host scans (in "Host render() other"):** `draw3DMeshes` (0.33 ms) and `draw3DParticles` (0.29 ms) instanceof-filter
  every render-list node each frame, and `draw3DGp` walks the whole scene graph with `forEachDeep` every frame to find
  skeletons (0.22 ms; `forEachDeep` was 4.3 % of the tiled CPU profile).
- **Diorama (vsync-bound):** render CPU 4.2 ms (draw lists 1.7, main pass 1.1, instance uploads 0.8), Play 1.4 ms
  (collision rays 1.3), simulation 1.6 ms (walkers 0.45, cars 0.28, trains 0.09, mover tick / gate / terrain 0.47),
  2D walks 0.8 ms, host 0.7 ms.
- **GC:** 0.03 ms a frame (diorama) / 0.07 (tiled): ~4 minor GCs a second, no major GC in 25 s. Not a factor.
- **Streaming / worker messages** at steady state: 0.02 ms.

**Frogmarks (real app, old dist, free 3D street view, 1600 × 950; `fm-angular.json`).** 8 s phases, CPU sampling:
- 60 trusted pointer moves a second over the canvas: Angular change detection 17.7 ms/s (the root-most `refreshView` /
  `detectChangesInView*` frames) = **~0.3 ms a frame** on top of the engine; the canvas handler itself 0.7 ms/s.
- The stats HUD (250 ms poll): `getRenderStats3D` 1.8 ms/s (~0.45 ms a poll: it walks every mesh); no measurable change
  detection from the poll in this sample.
- So the Angular cost is real but small next to the engine's own 2D walks (2.7 ms tiled); both belong to step 2.

### Step 1 — simulation LOD (built; docs/ui/performance.md §Simulation LOD)

- **Bands** (`src/world/sim-lod.ts`): near (< 40 m, on screen) every frame; mid (< 120 m) 10 Hz; far 2 Hz; off screen
  2 Hz; past the fog horizon's cull distance (+4 m) frozen. 10 % outward hysteresis; a move to a faster band updates on
  that frame; an anti-stutter floor (`stutterPx` 1.5: a moving thing on screen updates before it moves 1.5 px); an
  off-screen mover that will be on screen by its next update counts as on screen. Exempt: the Play player, the
  selection, a posed skeleton, script targets, every character during a timeline / clip preview.
- **Walkers as a function of time** (`src/world/walker-clock.ts`): the stepped walker rules in continuous time (the
  `walkNext` leg chain, accel 2.5·V, the 4·d approach envelope with its 0.3·V floor, gates solved exactly from the
  signal phase clock, instant stops at gate-0 legs, holds for chats and level crossings). O(1) per evaluation inside a
  stop-to-stop run, O(events) across a gap.
- **Trains as a function of time** (`train.ts` `trainRunTimeline` / `trainRunAt`): the run as a periodic schedule of
  trapezoid legs and dwells, written into the same run object (the level crossings read it).
- **Traffic precompute check:** `traffic-precompute.ts` ships the mover SPECS and the road net from the worker; playback
  was and is per frame on the main thread. Cars stay stepped (they follow, yield and queue): every frame near / mid
  (posed at the band rate), ≤ 0.1 s substeps at the band rate far / off screen, paused while frozen and invisible to
  the others (NaN in the pose buffer, so no queue builds behind a frozen car).
- **Other movers** (clouds, boats, birds, rain …): constant-speed closed forms, posed by band; no-fog meshes never
  freeze; the big ones skip the distance bands.
- **Live crowd:** poses by band (`evalIdle(t)` was already time-based); nobody past the fog is promoted. **Crowd cells
  (P12):** no lazy build for a cell wholly past the fog. **Character idles** by band; **springs** only in the near
  band, `resetSpringState` when they resume.
- **Switch + tuning:** `sm.setSimLod3D(patch)` / `getSimLod3D()` / `getSimLodStats3D()`, `setCityLodSettings3D({ sim })`
  (saved with the city LOD settings, opt-in), `salsaWorld.simLod(false)`. Off = the old code paths exactly.

**After** (the table's right-hand columns; plain runs without wrappers in brackets):

| | Sim LOD off | Sim LOD on |
|---|---|---|
| Diorama Play: simulation (sim + anim), mean | 1.57 ms | **0.97 ms** |
| Diorama Play: walkers / cars / trains / mover tick + gate | 0.45 / 0.26 / 0.08 / 0.49 ms | 0.11 / 0.11 / 0.03 / 0.43 ms |
| Diorama Play: instance uploads | 0.76 ms | 0.49 ms |
| Diorama Play: main-thread busy, mean (plain) | 9.05 (8.39) ms | **7.74 (7.36) ms** |
| Diorama Play: movers per frame, updated / skipped | 444 / 0 | ~35 / ~410 (near 15, mid 23, far 21, off screen 383) |
| Tiled 3×3 Play: simulation; busy mean (plain) | 0.77; 18.9 (18.9) ms | 0.79; 19.2 (19.2) ms — no traffic to save on |
| Diorama, Hard edge Far 150 m + Buildings only: simulation | 1.55 ms | **0.94 ms**, 56 movers frozen |

- The diorama frame is ~1 ms lighter (1.0–1.3 ms busy): the sim itself −0.6 ms, the instance upload −0.27 ms (fewer
  moved meshes), the draw lists −0.15 ms. The band bookkeeping adds ~0.1 ms to the mover tick.
- Tiled worlds gain nothing measurable: there is no traffic, and the live crowd / crowd cells / character work is
  ~0.3 ms. This is the finding that reorders the roadmap (engine-roadmap-todo.md "Order after the profile").
- The fog-on diorama run's Play rows are noisy (the player's walk differs between sessions: one 0.8 s collision hitch in
  the 'on' run); the simulation rows are not affected.

**Verified in the harness** (`pupdrive/prof/vis.js`, `jump.js`, `vis-*.json`):
- **Near the camera, the same:** per tick, on-screen walkers / cars moving > 3 px: 148 (on) vs 290 (off) in a 10 s Play
  walk; the band-0 counts are ordinary motion of movers a few metres away. Screenshots `vis-near-on*.png` /
  `vis-near-off*.png`.
- **Out of the fog, no teleport:** Hard edge, Far 70 m, a 4 m/s walk down the street: 574 frozen → updating
  transitions, the first pose always ≥ 71.7 m from the fog eye (the edge is 70.7 m; the fade band starts at 55.7 m),
  **0 jumps > 1.5 m inside the clear zone**. Switching sim LOD off and on mid-run: 0 jumps in the clear zone (the frozen
  walkers handed back jump to their clock position while still in the fog).
- **Trains keep their schedule:** station departures over 150 s with sim LOD on vs off agree to 0.1 s (4.62 vs 4.72,
  55.93 vs 55.97, 101.25 vs 101.22, 140.45 vs 140.37 s; the second consist alike).
- **Characters** (no city, 8 idling characters): 3 / 6 / 25 m → 60 updates/s, 60 / 90 m → 10/s; with bands 20 / 50 m:
  25 m → 10/s, 60 / 90 m → 2/s; the selected 90 m character → 60/s. Springs solve near only (3 of 5 skeletons).
  Characters past the camera's far plane are renderer-culled and skipped, as before.

**Tests:** `src/world/sim-lod.test.ts` (bands, hysteresis, exemption, rates, staggering, anti-stutter, fog margin,
counters, settings diff), `src/world/walker-clock.test.ts` (gate solve = `gateOpen` polling; the clock = the stepped
walker at 1 kHz over 150 s within 2 cm, same legs; at 60 Hz ≥ 95 % within 5 cm; frozen-then-resumed = continuous
exactly; signal stops; chat holds; trains: same stops in order, departures within 1.5 s over 3 cycles at 60 Hz),
`src/services/managers/world-traffic-simlod.test.ts` (in the ticker: walkers fogged for 30 s = continuous ones exactly;
on the stepped routes; the selection every tick vs ~2 Hz far; switching off hands back in place),
`world-lod-settings.test.ts` (+1: `sim` saved only when changed, restored on load). Full suite: 2,575 passed.
Note: `stepTrainRun`'s discrete braking curve drifts ~0.4 s per round trip at 60 Hz and, at very small steps (≤ 4 ms),
can skip a station (its next-stop search ignores stops within 1e-7 of the train); the clock has neither issue.

### Step 2 — editor and host scans, structure-change hitches (built 2026-10-01; docs/ui/performance.md §Editor overhead)

Same Play walks (diorama, tiled 3×3, 25 s), same harness. Before = the code at the start of step 2; after = everything
below on. Drivers in `pupdrive/step2/`: `prof.js` (= `prof/prof.js` plus a p95-frame breakdown and structure-event
counters), `before.sh` / `after2.sh`, `table2.js`. Main thread busy per frame, p50 / p95 / mean:

| | Before | After step 2 |
|---|---|---|
| Tiled 3×3, wrapped | 16.2 / 46.9 / 19.36 | **12.2 / 21.9 / 13.90** |
| Tiled 3×3, plain (no wrappers) | 15.4 / 44.0 / 18.45 | **11.9 / 23.7 / 13.90** |
| Diorama, wrapped | 7.6 / 10.5 / 7.93 | **6.4 / 8.5 / 6.64** |
| Diorama, plain | 7.1 / 9.6 / 7.43 | **5.8 / 7.3 / 6.02** |
| Tiled frame interval p95 (vsync 60) | 47.2 | **22.3** |

Per subsystem (tiled, wrapped; p50 / p95 / mean):

| Bucket | Before | After |
|---|---|---|
| 2D overlay walks (beginFrame, carets, highlights, render-list rebuild) | 2.1 / 10.6 / 2.69 | 0.0 / 0.2 / 0.13 |
| — 2D strategy beginFrame | 1.5 / 1.6 / 1.54 | 0.0 / 0.0 / 0.00 |
| — collectActiveCarets + collectSelectionHighlights (mean) | 0.53 | 0.00 |
| — 2D render-list rebuild | 0.0 / 8.7 / 0.61 | 0.0 / 0.1 / 0.12 |
| Host render() other (incl. the draw3DMeshes / particles / GP scans) | 1.9 / 2.4 / 1.97 | 0.3 / 0.5 / 0.32 |
| — draw3DParticles scan + draw3DGp forEachDeep (mean) | 0.25 + 0.20 | 0.00 + 0.00 |
| Main pass encode (incl. the draw-order re-sort) | 2.3 / 12.4 / 2.95 | 2.4 / 3.6 / 2.49 |
| Pipeline-roster prewarm | 0.0 / 3.2 / 0.19 | 0.0 / 0.1 / 0.01 |
| Character skeleton sync | 0.2 / 1.8 / 0.36 | 0.0 / 0.1 / 0.10 |
| Rendering CPU total | 9.9 / 26.5 / 11.28 | 9.7 / 14.8 / 10.31 |
| Draw lists + cull (unchanged: step 4) | 4.7 / 5.5 / 4.77 | 4.5 / 5.7 / 4.62 |

Diorama: 2D walks 0.73 → 0.03 ms, host 0.71 → 0.16 ms, busy −1.3 ms mean.

**What changed.**
- **Per-kind render lists** (`renderer/core/render-list-index.ts`, used by `WebGPURenderer`).
  - One structure walk builds three lists, each in the old order (a stable zIndex sort of the preorder walk): the 2D
    list (what the render strategy can act on), the 3D list (Mesh3D / ParticleEmitter3D / GpObject3D) and the
    Skeleton3D list.
  - Mesh and array groups are in neither list. No consumer read them from the render list, and each one cost a 2D
    viewport box on every rebuild (3.3 ms for 4 k array groups).
  - The per-frame 2D steps (beginFrame, carets, text selection, the below / above-raster split) see only the 2D list:
    0 nodes in a city.
  - `draw3DMeshes`, `draw3DParticles` and `draw3DGp` read the cached 3D lists with the same per-frame visible / layer /
    below-raster filter.
  - The grease-pencil skeleton map comes from the walk. It falls back to the old forEachDeep when a stroke's skeleton
    is missing from it.
- **Incremental structure walk.**
  - Each node carries the last walk's generation and its preorder position (`Node._rlGen` / `_rlPos`).
  - A walk keeps the previous order's survivors and checks in O(n) that they are still in (zIndex, position) order. It
    then sorts only the new nodes and merges them in, which gives exactly the full sort's result.
  - A zIndex edit, a reorder, a node reached twice or more than 25 % new nodes falls back to the full sort.
  - Render-list rebuild in the tiled world: a structure change 11.3 → 1.5 ms, a visibility re-filter 4.8 → 0.2 ms
    (in-page timings, `step2/smoke.js`).
- **Incremental draw rank** (`renderer/3d/draw-order-rank.ts`).
  - Geometry keys are interned to numeric codes that keep the string order (`GeomKeyCodes`). New keys take a midpoint
    code; the table is renumbered when a gap runs out and pruned when evicted keys pile up.
  - The rank keeps its sorted order and merges new or changed meshes by (pipe, code, input position). The ranks are
    identical to the old stable string sort; duplicate ids reproduce the old Map exactly.
  - 9.6 ms full sort → about 1 ms merge at 11.5 k meshes.
- **Prewarm only new pipeline names.**
  - Each mesh caches its 5-bit material variant (`Mesh3D._pwGen` / `_pwCode`, reset by `setMaterial`).
  - A roster change classifies only meshes not yet classified, and warms only names not queued before for this
    Pipeline3D. A shadows or force-double-sided change starts over.
  - Limit: a material edited in place (not through `setMaterial`) after it was classified is not classified again. Its
    pipeline still compiles on its first draw, as for any visible mesh. The old full rescan caught it at the next
    roster change.
- **Skeleton sync.** The skinned meshes are listed once per structure version, and the per-frame passes loop over
  those. `getAllMeshes` / `getAllSkeletons` share one explicit-stack walk per structure version.
- **Stats HUD.** `getRenderStats3D` sums cached per-mesh figures, keyed on the structure version and
  `Mesh3D.geometryEpoch`, and refreshed every 2 s regardless. A poll reads only each mesh's `visible`. The totals are the
  same as the old loop's (checked in the harness).
- **Coalesced structure notifications** (`services/structure-version.ts`).
  - Bumps between two reads of the structure version advance it once, so every version-keyed cache re-walks at most
    once per batch of changes.
  - The quiet structure path (crowd cells, live crowd) was already one renderer flag per frame.
  - Host-facing scene-graph events were already coalesced (the 250 ms tile-notify timer): 4–5 host events in a 25 s
    tiled Play walk, against ~150–220 quiet notifications.
- **Camera-motion resolution (C).** New fields `setResolutionScale3D({ motion, motionScale })`, default `'auto'`:
  - Editor camera moves drop to 0.78 as before; in Play only while the GPU frame (timestamps) is over `targetMs`.
  - Tiled Play walk: `'auto'` → 331 of 331 frames at 1.0 (GPU 10.2 ms < 16); `'always'` → 316 frames at 0.78 (the old
    behaviour); a 4 ms budget → 318 at 0.78.
  - The mode (off / fixed / auto) is untouched (`step2/motion.js`).
- **A/B:** `sm.setFrameScanOptions3D({ splitRenderList, incrementalRenderList, incrementalDrawOrder, prewarmNewOnly,
  cachedSkeletonSync, cachedRenderStats, iterativeSceneWalk, coalesceStructureBumps })`, all true by default. Stats:
  `sm.getFrameScanStats3D()`.

**Verified.**
- Frozen-clock screenshots, step 2 on vs everything off vs on again: **0 differing pixels** (`step2/vis3d.js`,
  `vis2d.js`, `cmp.py`):
  - 3 diorama and 3 tiled poses, after a forced structure change through the quiet path (so "on" is the incremental
    result), with the same draw calls and triangles;
  - 4 view cells with 2D shapes, a 3D box and SDF text with a caret and a selection highlight: illustration ortho,
    illustration free3D (the textured artboard), scene free3D, scene ortho.
- 2D text editing in the harness with real pointer and keyboard events (the text tool, typing, Shift+Arrow selection)
  behaves the same with step 2 on and off: same text, caret and selection range; 1 caret and 1 highlight collected.
- Frogmarks, host costs only (an Angular dev server on the current Frogmarks source; its engine is the 22:19 Salsa
  dist, which predates step 2; `step2/fm-angular.js`, `fm-angular-after.json`):
  - pointer-move storm: Angular change detection **17.7 → 0 ms/s**;
  - idle `ApplicationRef.tick` 54 → 41 ms/s;
  - stats HUD on: change detection only when a shown value changes (3.9 ms/s at 4 polls a second while the fps and
    drawn figures change).

**Tests.**
- `render-list-index.test.ts`: random trees with adds, removes, reparents, zIndex edits, an in-place re-sort, duplicates
  and two indexes all equal the full rescan, and the merge path is taken.
- `draw-order-rank.test.ts`: key codes keep the order through gap exhaustion and batches; random adds, evictions, key and
  pipe changes, reorders and delete / re-add equal the full sort; duplicate ids; pruning.
- `structure-version.test.ts`: coalescing; every reader sees every change.
- `resolution-scaler.test.ts` (+3): the motion modes, the Play hysteresis, a motion-only patch keeps the auto controller.

**What the tiled p95 is now.** The p95 frames (≥ 21.9 ms) average:
- timer tasks 10.7 ms: `WorldManager._scheduleTileBounds` after a streamed tile settles, 6 calls in 20 s, up to 132 ms;
- draw lists + cull 5.4, main pass 3.9, collision rays 2.3, incremental instance upload 1.9;
- the render-list walk 1.8 (the 19 k-node walk itself), geometry pool 1.2, skeleton sync 1.1 (the shared getAllMeshes
  walk on a structure change).

Next: slice or defer `_scheduleTileBounds`, then steps 3–4. (Done: §Step 3 below.)

### Step 3 — lighter tiles, no hitches (built 2026-10-02; docs/ui/performance.md §Lighter tiles and no hitches)

Same Play walks as Step 2 (diorama, tiled 3×3, 25 s, wrapped + plain), plus the 30-tile street fly (3×3, 0.5 tile/s,
`stream2/fly.js`). Before = a frozen copy of the source taken at the start of the session, served on its own port, so
both sides ran in the same session. The shadow work (§P14) landed in the same tree meanwhile, so the "after" columns
include it; the per-bucket rows below are the step-3 ones. Drivers in `pupdrive/step3/`: `prof.js` (= step 2's plus
long tasks, pool, per-tile bytes, tile-job times, collision stats), `runall.sh`, `table3.js`, `fly.js`, `raycheck.js`,
`vis3d.js` + `cmp.py`, `crowdfly.js`.

**After step 3** (main thread per frame, p50 / p95 / mean; "plain" = no wrappers):

| | Before | After step 3 |
|---|---|---|
| Tiled 3×3, wrapped | 12.8 / 23.7 / 14.72 | **13.3 / 22.0 / 14.21** |
| Tiled 3×3, plain | 13.1 / 25.0 / 15.15 | **13.0 / 18.5 / 13.83** |
| Tiled 3×3, wrapped, same tree: every step-3 switch off → on | 15.4 / 26.4 / 17.29 | **13.3 / 22.0 / 14.20** |
| Tiled frame interval p95 / max (plain) | 25.3 / 160 ms | **19.1 / 52 ms** |
| Tiled long tasks in 25 s, count / max (plain) | 7 / 146 ms | **1 / 51 ms** (wrapped: 9 / 146 → **0**) |
| Diorama, wrapped | 7.7 / 11.0 / 8.03 | **6.5 / 8.5 / 6.84** |
| Diorama, plain | 6.8 / 9.0 / 7.08 | **5.6 / 7.6 / 5.91** |
| Pool used / cap, tiled (MB) | 1100 / 1320 | 1104 / 1371 |
| Full tile (seed 3) | 138 MB vertex + index data, 309 groups | unchanged (see "Not done") |
| `world.tile` worker jobs, mean / max | 293 / 2695 ms | 410 / 2724 ms (same jobs: the mean mixes cheap and full tiles; the max is a full tile) |

| Bucket, tiled (p50 / p95 / mean) | Before | After |
|---|---|---|
| Timer tasks (the City bounds walk after a tile settles) | 0.0 / 0.0 / 0.77 (p95 frames: **14.98**) | 0.0 / 0.0 / **0.02** |
| Play collision rays | 1.3 / 2.0 / 1.41 | **0.3 / 0.5 / 0.34** |
| All Play collision work (rays + cell upkeep + snapshot) | 1.3 / 2.0 / 1.41 | **0.3 / 0.6 / 0.50** |
| Crowd cells built on the main thread (people) | 0.03 | **0** (the worker) |
| Geometry pool | 0.1 / 1.3 / 0.21 | 0.1 / 0.7 / 0.22 |
| Diorama: Play collision rays | 1.4 / 2.1 / 1.49 | **0.3 / 0.5 / 0.33** |

The tiled p95 frames are now draw lists + cull 5.9, main pass 4.2, the incremental instance upload 2.5, the render-list
walk 2.1 and the collision snapshot rebuild 2.1 ms (it was inside "play: controller" before). Rendering CPU in the
tiled walk rose 10.7 → 12.0 ms against the frozen copy; with every step-3 switch off in the same tree it is 13.1 ms
(draw lists 6.0 vs 5.5 ms), so the rise comes from the other work in the tree, not from step 3.

**30-tile street fly** (3×3, 0.5 tile/s, 60 s):

| | Before | After |
|---|---|---|
| Long tasks (> 50 ms): count / worst | 39 / 135 ms | 53 / **77 ms** |
| Worst rAF gap | 176 ms | **85 ms** |
| Pool used (MB) | 492–1116 | 492–1124 |
| Geometry written in one frame / in one write | up to ~32 MB / one write per geometry | **≤ 16 MB / ≤ 4 MB** |
| Full tiles in flight, flat tiles | 9, 30–37 | 9, 30–37 |

More tasks just over 50 ms, none over 77: the frames that wrote a whole 18 MB geometry are gone; a frame that lands a
tile still does the mesh wrap + reassembly job (`World Furniture` 52–56 ms worst job, unchanged).

Same tree, every step-3 switch off → on (12-tile street fly, 0.5 tile/s, GC every 4 s): long tasks 27 → **9**, worst
139 → **77 ms**, worst rAF gap 156 → **97 ms**; GC'd JS heap 1.93–3.31 GB (mean 2.64) → 1.92–2.60 GB (mean 2.25). The
frozen copy measured 1.37–2.20 GB (mean 1.83): the rest of the tree, not step 3, holds the extra ~0.4–0.8 GB.

**What changed.**
1. **Tile bounds** (`services/managers/group-bounds.ts`; `WorldManager.STEP3.incrementalTileBounds`,
   `Scene3DManager.STEP3.cachedGroupBounds`). The City gizmo's box is a min / max over the same vertices, so it is
   folded from per-geometry boxes cached by vertex array (a WeakMap: a dropped tile frees its entry, a replaced geometry
   is a new array, a mesh being edited is rescanned). After a tile settles only the new geometry is scanned, in 3 ms
   slices (`GroupBoundsJob`, one per macrotask), restarted if the structure changes between slices. Every other
   `cacheGroupBounds` call (centre builds, blocks, procedural objects) uses the cache too. Same box, bit for bit.
2. **Collision cells** (`game/collision-cells.ts`, `services/workers/near-*.ts`; `Scene3DManager.STEP3.collisionCells`).
   - The static world around the player is cut into XZ cells (core 4 × the camera reach, margin 1.5 ×). A cell's
     triangles are every triangle of every STATIC collision mesh (identity matrix, uploaded, not skinned, not a mover)
     overlapping its window. They are gathered on the main thread in 1.5 ms slices — per-mesh run boxes of 256
     triangles (computed in the tile / centre worker: `geometry.runBoxes`, `TileBuildOptions.runBoxes`) skip the far
     parts of tile-wide layers — and turned into ONE flat BVH in a worker (the new `near` lane: one-two workers, every
     lane is guaranteed one, so tile builds never starve it). The 3 × 3 cells around the player are kept.
   - A ray whose XZ footprint lies inside a ready cell's window walks that BVH; everything the cell does not cover
     (movers, moved / non-identity meshes, meshes newer than the gather) still goes through the old per-mesh path, and
     a cell that meets newer static meshes is re-gathered in the background. A member that moves or changes geometry
     stops the cell answering (validated on its first ray of each tick).
   - **Same results.** For an identity matrix the old local ray is the world ray rounded through gl-matrix's f32 vec4
     math; the cell walks its f32 vertex copies with that same ray and the same Möller–Trumbore arithmetic, keeps each
     mesh's nearest triangle, picks across meshes by world distance (ties to the earlier candidate) and reports the
     hit through the same tail code (`MeshPicker.identityLocalRay` / `hitFromLocalT`). Hits within f32 rounding of the
     nearest are resolved exactly as the old code would.
   - **Live check** (`raycheck.js`, every Play ray both ways, the old path unbudgeted): tiled **16,448 rays, 0
     differences**; diorama **17,150 rays, 0 differences**; every ray served by a cell. Unit test: 6,000+ random rays
     over random scenes with coplanar duplicates (opposite normals: the tie rule is exercised), near-coplanar layers,
     movers, hidden and late meshes, a sliced gather.
   - In a tiled walk: 12 cells, 17 builds (worker 37–320 ms each, never on the main thread), ~30 MB, ~100–116 k
     triangles in the biggest cell; per-mesh BVHs built during the walk 230 (was every candidate the hood touched).
   - Not served (old path): unbounded slanted rays, rays leaving the window, a cell not built yet (the first ~40 rays).
3. **Sliced uploads** (`Renderer3D.slicedUploads`, `UPLOAD_GEOM_SLICE` 4 MB, `UPLOAD_FRAME_BUDGET` 16 MB).
   - No geometry goes in one write over 4 MB: a bigger one reserves its region at once and takes one ≤ 4 MB slice a
     frame (its meshes draw once the last slice is in). The frame total (render-time appends + the warm calls since the
     last frame, together) stays within 16 MB, nearest in-view geometry first (priority from last frame's frustum).
   - A 4 MB frame TOTAL was built and measured first: in the street fly the streaming then ran at its limit, tiles
     waited ~5 × longer for their geometry, and the per-frame cost of waiting meshes (they kept `gpuDirty`, so every
     frame took the O(all meshes) incremental instance path and re-ranked the draw order) outweighed the smaller
     writes: 17–42 long tasks vs 6. Kept: a mesh whose slot is written but whose geometry is still queued no longer
     holds `gpuDirty` (`_clearPendingGpuDirty`), and the P9 clusters stay on while appends are deferred (rebuilt once
     they caught up).
4. **Crowd cells in the worker** (`world/crowd-instanced.ts` `crowdCellJob` / `buildCrowdCell` / `adoptCrowdCell`;
   `WorldCrowd.inWorker`, `MAX_IN_FLIGHT` 2). A cell's people are sent as their record rows; the worker runs the same
   CrowdCellBuilder and returns the merged mesh, the live-crowd ranges and every person's pivots (the main thread only
   merges into a mesh + uploads, one per frame). Number for number the main-thread build (test). The prefetch radius
   grows by a second of camera travel (`LEAD_S`, capped at 40 m), and above 50 m/s no new cell starts (`SKIP_SPEED_MS`:
   a 210 m/s fly otherwise built and evicted 2.4 × more cells). `crowdfly.js`, diorama, 25 m/s street fly, 8 s,
   interleaved: cell-frames showing a cheaper tier than wanted **0 / 14 vs 131 / 83**; main-thread cell build time
   **19 vs 133–143 ms**; worst build step 2.3 vs 3.3–3.6 ms.
5. **Fog class 'overlay'** (`WorldManager.FOG_OVERLAYS`, `STEP3.overlaysFogCulled`; `Mesh3D.fogNoFade`). Road paint,
   road wear, gutters and storefronts are class 2 for the fog-horizon cull (dropped past Far) but do not dissolve in
   the fade band: they fog with the surface under them up to Far. Tiled, Far 80 m, Buildings only: +65–79 meshes and
   +0.3–0.5 M triangles culled per pose. Frozen-clock A/B: 0 differing pixels (3 poses × 2 worlds).
6. **Budgets** (`renderer/3d/scene-budget.ts`, `sm.getSceneBudget3D()` / `setSceneBudget3D()`): this frame's drawn
   triangles / draw calls (every pass that ran), the pool's live geometry, the instanced copies; defaults 3 M / 2 k /
   500 MB / 200 k; `over` + a one-line `warning`. Frogmarks shows it in the stats HUD and the Performance group.
7. **Streaming leftovers.**
   - The apron / void grid / border glow follow the window (`STEP3.backdropFollowsWindow`): on a focus-tile change they
     are rebuilt around it by the world worker's selective-group job (built at the origin, moved by whole tiles before
     the drape: `SelectiveBuildRequest.offset`), background priority, and dressed alone when they swap in. (The first
     version re-ran the whole-world style + time-of-day pass on every swap: 100+ ms tasks in the fly; fixed.)
   - Re-attached LRU tiles and a restored centre are dressed at once with the current style, glow and contact shadows,
     scoped to their own meshes (`STEP3.refreshReattached`); before, they waited for the next day-cycle tick.
   - `_agAABBCache` is pruned to the live groups when the group set changes and it holds twice the live set
     (`Renderer3D.pruneGroupBoxCache`).
   - Ortho: the window centres on the view centre (the target), not the eye (`STEP3.orthoViewCentre`): an oblique ortho
     camera sits far off along its axis. Flat / Focus worlds stay on the visible-set path: they have no full neighbour
     tiles (the centre is their only 3D city), so the window has nothing to choose.

**Switches:** `sm.setStep3Options3D({ incrementalTileBounds, cachedGroupBounds, collisionCells, runBoxes, slicedUploads,
crowdCellsInWorker, crowdPrefetchLead, overlaysFogCulled, backdropFollowsWindow, refreshReattached, orthoViewCentre,
pruneGroupBoxCache })`, all true by default, per session. Stats: `sm.getStep3Stats3D()`, `sm.getCollisionStats3D()`,
`getGeomPoolStats3D()` (`uploadMaxMB`, `maxWriteMB`, `slicing`, `slicedGeoms`, `liveMB`), `salsaWorld.crowdStats()`
(`workerJobs`, `waitCellFrames`, `skippedFast`).

**Verified.**
- Frozen-clock screenshots, step 3 on vs every switch off vs on again, diorama + tiled, street / back / high, with and
  without the fog horizon (Hard edge, Buildings only, Far 80 m), the crowd's near / mid cells rebuilt in each mode (on =
  worker, off = main thread): **0 differing pixels** in all 24 pairs (`vis3d.js`, `cmp.py`).
- The ray equivalence above (33,598 live rays, 0 differences).

**Tests.** `group-bounds.test.ts` (the sliced walk = the old walk through adds / removes / swaps / edits; the cache),
`collision-cells.test.ts` (run boxes, flat BVH, cell answers = the per-mesh path over thousands of rays, hidden / late /
moved / edited members, a sliced gather, rays not served), `geom-upload-slices.test.ts` (a recording device that models
buffer contents: ≤ 16 MB a frame, ≤ 4 MB a write, every byte at its allocation, the switch-off path, in-view first),
`crowd-instanced.test.ts` (+1: a worker cell = the main-thread cell exactly), `near-jobs.test.ts` (the lane, the
fallback), `fog-overlay.test.ts`, `scene-budget.test.ts`, `world-backdrop-follow.test.ts` (the backdrop follows, the
switch, the ortho centre).

**Not done (and why).**
- **Prop far twins / the far crowd tier dropped from neighbour tiles.** P10.1 proposed it when only the centre was ever
  walked. With the eye-centred window every neighbour of a 3×3 touches the focus tile, and their families draw far:
  crowd 411 m, poles / props 822 m, roof objects 514 m against a 420 m tile. A far twin is drawn from 35–60 m to that
  distance, so dropping it changes street-level views. It can only go where a tile is farther than its families' draw
  distance (5×5 windows, or the fog horizon's Far): not built.
- **A coarser ground for proxy / massing tiles.** The ground is split on the terrain lattice so the stacked layers (road
  sheet, pavement, lots, a kerb height apart) stay on the field exactly. At the default relief (amplitude 0.0225 R ≈
  3.4 m, wavelength ~105 m) a 3× coarser cell sags ~0.9 m mid-cell, a 2× one ~0.4 m, both far more than the 0.15 m kerb:
  the road would poke through the pavements from the air. Proxies are built in the worker since P10.D5, so the gain left
  is ~1.3 MB a proxy (~45 MB over 35). Better done with fog-horizon P3's merged silhouette tiles.
- **Array groups in the P9 clusters.** The group loop of `_buildDrawLists` now carries the §P14 static / dynamic cascade
  bookkeeping, built in parallel with this step; a cluster skip there has to reproduce it. Left for after §P14 settles.
- The collision snapshot rebuild (`_buildCollisionGrid`, every structure change, ≤ 2 a second) is 2.1 ms in the tiled
  p95 frames: an incremental grid is the next collision item.

## P14 — Shadows (engine-roadmap step 7, 2026-10-02)

Salsa vite harness (live source), seed-3 grid city, headless Chrome + WebGPU (d3d11, RTX 2070 SUPER), 1300 × 850,
Play third person with the auto player. Diorama (traffic on) and tiled 3×3 'full' with Stream to camera on. Drivers in
scratchpad `pupdrive/shadow/`:
- `walk.js`: a Play walk with turns, P14 OFF / ON interleaved in one page (2 rounds × 7.5 s each, 1 s settle after each
  switch, not recorded). Per frame: shadow triangles per pass, CPU (`msShadow`, `msCull`, `msTotal`), the frame
  interval, the re-render counters; with `GPU=1`, per-pass timestamps (p8 `gpuprof-p1.js`).
- `poses.js`: three standing Play poses (down the street, across, at the ground). PAIRED GPU timing as in p8
  `abtime.js` (rounds of OFF frames / ON frames, 2 in flight); `steady` = normal frames, `refresh` = both maps forced to
  re-render every frame (the cost of one far-map refresh).
- `pix.js` + `pd.py`: the frozen-clock pixel A/B (below). `churn.js`: what enters / leaves the static sets.
  `fams.js`: per-family triangles per list. `presets.js`: the presets, the day cycle, the sun settle.
- CPU: the step-2 profile (`step2/prof.js`, wrapped subsystems, 15 s walks) via `shadow/cpu.sh`.
- **GPU noise.** The GPU was shared with another agent's headless browsers (20–66 % `nvidia-smi` between runs). Every
  GPU segment waits for < 25 % with our own page suspended first (`gpuIdle`, the reported `util`). Even so the colour
  pass spread was 1.5–6.7 ms between rounds of the same setting, so main-pass and whole-frame GPU deltas below are
  noise; the shadow-pass deltas are consistent across rounds and poses.

### Before (what P11 left)
- Far map: the P4.2 static cache re-renders on a static-set change, a structural change or a box move. In a tiled world
  a re-render drew 6.1–7.6 M triangles: whole 420 m tile layers touching the light box (the light box is ~240 m at
  street level).
- Near cascades: every Play frame re-rendered every caster (the player's pose marks them stale): 0.8–1.3 M triangles.
- A day cycle re-rendered both maps on every frame (every `setDirectionalLight` marked them stale, even colour-only).

### Fixes (each with an A/B switch; `sm.setShadowCacheOptions3D`, all default on)
- [x] **P14.1 Far-map ranges** (`Renderer3D.shadowRangeCulling`). Heavy casters (≥ 2,048 triangles, single material,
  not moving) carry their P11 run table; when the far map renders, the static list is expanded into the runs inside
  the light box and the direct / dynamic lists into the runs inside light box ∩ shadow reach (`ShadowRunTester`,
  `_expandRanges`). Lazy: the first version selected runs on every frame's list build and cost +5 ms of `msCull` in the
  tiled walk; now it runs only on refresh frames. Exact: a run is dropped only when it is clipped anyway (light box) or
  cannot shadow a visible receiver (reach: the rule the whole-mesh list already used).
- [x] **P14.2 Cascade static / dynamic split** (`Renderer3D.cascadeStaticCache`). Per cascade a cached static layer
  (`ShadowCascadeStatic`, a second depth array): static casters inside the cascade box without the camera reach test
  (so turning keeps it valid), re-rendered only on a cold cache, a box move, a change of the static set (signature) or
  a structural change. Each refresh copies it into the sampled layer and draws the dynamic casters (reach-culled) and
  the skinned characters on top with depth load: the same per-texel minimum. A skinned pose change now marks only the
  dynamic layer due. Static / dynamic = the P4.2 rule (moved within 30 s, wind sway, billboard, fog fade band).
- [x] **P14.2 Cascade slack** (`Renderer3D.CASCADE_FOLLOW_SLACK_TEXELS` = 64; 0 = the old box). The cascade keeps its
  light-space box while the wanted one stays within 64 texels on both axes and inside its depth range; a re-centre pads
  the depth range by `cascadeDepthMargin` (covers every move the centre test lets through, unit-tested). The texel
  lattice is unchanged.
- [x] **P14.3 Joiners** (`Renderer3D.staticJoinDefer`, `STATIC_JOIN_TRIS` 200 k, `STATIC_JOIN_FRAMES` 120). The
  tile-attach answer: a static caster not yet in a cached static layer (a streamed tile's mesh after its 90-frame
  probation, a crowd cell, a parked car) is drawn with the dynamic casters until the joiners pass the budget, then the
  layer re-renders once with all of them (`StaticLayerMembers`, the kept signature). A detach / hide / start-moving
  still re-renders at once (the far map on its interval throttle, as P4.2). A region-only re-render was not needed:
  with P14.1 a refresh costs the light box's contents, not the tile's, and tiles outside the light box never touch the
  static set at all. Tiled walk: cascade signature re-renders 106 → 12 in ~7 s while tiles were landing.
- [x] **P14.4 Stepped sun** (`Renderer3D.SUN_SHADOW_STEP_DEG` = 0.15, `SUN_SETTLE_FRAMES` 8). The shadow maps follow
  the sun once it has turned 0.15° and snap to the exact sun 8 frames after it stops; the lighting keeps the exact
  sun. A colour-only `setDirectionalLight` (lightning, grade) no longer marks the maps stale.
- [x] **P14.5 Shadow quality presets** (`shadow-quality.ts`): Low / Medium / High (= today) / Ultra → PCF, cascades +
  their size and refresh, far map size and refresh scale. `setCityLodSettings3D({ shadow: { quality } })` (the city
  LOD settings own the city's shadow options), `setShadowQualityPreset3D` / `getShadowQualityPreset3D` (city → the
  same; outside a city the scene's own shadow settings). New renderer hooks `setShadowMapSize`,
  `setShadowIntervalScale`. Frogmarks: City → Performance and Global settings selects.

### Results

**Play walk (`walk.js`, 2 × 7.5 s per setting, interleaved; OFF = every P14 switch off).**

| | Diorama OFF | Diorama ON | Tiled 3×3 OFF | Tiled 3×3 ON |
|---|---|---|---|---|
| Shadow triangles a frame, mean (p95) | 1.12–1.19 M (2.6 M) | **0.53–0.59 M** (1.3–2.0 M) | 1.38–1.46 M (1.4 M) | **0.67–0.69 M** (1.45 M) |
| — near cascades, mean | 0.88–0.93 M | **0.35 M** | 1.16–1.22 M | **0.53–0.56 M** |
| — far map, mean (refresh frames only) | 0.25–0.26 M | 0.18–0.24 M | 0.22–0.24 M | 0.13–0.15 M |
| GPU: cascade passes ms a frame | 0.26–0.28 | **0.12–0.14** | 0.45–0.54 | **0.23–0.24** |
| GPU: far-map passes ms a frame (amortised) | 0.08–0.09 | 0.06–0.08 | 0.07–0.09 | 0.04–0.05 |
| GPU: all passes ms a frame (noisy, see above) | 5.87 | 5.37–5.88 | 11.2–11.3 | 8.9–9.5 |
| CPU `msShadow` (encode) | 0.30–0.33 | **0.19–0.21** | 0.37–0.41 | **0.25–0.26** |
| CPU `msCull` (draw lists) | 2.25–2.31 | 2.30–2.32 | 6.3–6.9 | 6.6–6.7 |
| Frame interval mean / p95 (vsync 60) | 16.67 / 17.3–17.6 | 16.67 / 17.1–17.4 | 19.7–20.5 / 35.5–35.9 | 18.9–19.0 / 31.9–32.6 |
| Far map re-renders per 15 s: static / dynamic layer / direct | 60 / 304 / 10 | 38 / 305 / 10 | 19 / 20 / 10 | 19 / 21 / 9 |
| Cascade full re-renders per 15 s | 902 (every frame) | — | 751 | — |
| Cascade static re-renders / composites per 15 s | — | 83 / 901 (box 58, sig 15, stale 10) | — | 83 / 797 (box 53, sig 21, stale 9) |

The cascade box still re-centres ~3.5–4 times a second: the auto player turns every few seconds and the box sits
0.55 × its half-width ahead of the eye, so a turn sweeps it. Each re-centre is one static re-render (~0.6 M diorama /
~1.3 M tiled triangles, range-culled).

**Street poses (`poses.js`, paired GPU; triangles = the submission of one frame).**

| Pose | Far map, one refresh: tris OFF → ON | GPU OFF → ON (paired Δ) | Cascades, steady: tris OFF → ON | GPU OFF → ON (paired Δ) |
|---|---|---|---|---|
| Tiled, street | 6.69 → **3.64 M** | 1.74 → 0.82 ms (−0.92) | 1.30 → **0.44 M** | 0.34 → 0.16 ms (−0.18) |
| Tiled, across | 7.62 → **4.56 M** | 1.91 → 1.10 ms (−0.83) | 1.11 → **0.45 M** | 0.23 → 0.13 ms (−0.11) |
| Tiled, ground | 7.15 → **4.89 M** | 3.15 → 2.37 ms (−0.78) | 1.04 → **0.35 M** | 0.35 → 0.24 ms (−0.11) |
| Diorama, street | 1.89 → 1.84 M | 1.10 → 1.04 ms (−0.17) | 0.95 → **0.32 M** | 0.27 → 0.15 ms (−0.16) |
| Diorama, across | 1.75 → 1.70 M | 0.87 → 0.76 ms (0.0) | 0.90 → **0.29 M** | 0.27 → 0.12 ms (−0.11) |
| Diorama, ground | 1.70 → 1.65 M | 0.74 → 0.74 ms (0.0) | 0.95 → **0.31 M** | 0.27 → 0.10 ms (−0.17) |

- In the diorama the far box covers most of the city, so the ranges save little; in the tiled world the far map
  halves.
- A forced refresh frame (both maps) costs more CPU with P14: `msShadow` 1.1 → 2.0 ms tiled, 0.5 → 0.9 ms diorama (the
  run expansion and the bigger reach-free cascade static list, 0.95 → 0.98 M / 1.30 → 1.34 M). Refreshes are rare
  (above), so the walk's mean `msShadow` still drops.

**CPU, whole frame** (`step2/prof.js`, 15 s Play walks, separate page loads; main-thread busy mean, p50 / p95):

| | OFF | ON |
|---|---|---|
| Diorama: busy | 7.77 (7.3 / 10.3) | 7.73 (7.4 / 9.8) |
| Diorama: draw lists + cull / shadow + prepass encode | 2.24 / 0.29 | 2.29 / 0.18 |
| Tiled: busy | 17.25 (15.3 / 30.3) | 16.95 (15.4 / 28.3) |
| Tiled: draw lists + cull / shadow + prepass encode | 6.39 / 0.40 | 6.39 / 0.24 |
| Tiled: frame interval p95 | 30.8 | 28.6 |

The split's bookkeeping (a second signature, the joiner set lookups) is within the draw-list noise (+0.05 ms diorama,
0 tiled). The machine was loaded (another agent's builds), so whole-frame CPU differences under ~0.5 ms are noise.

**Day cycle** (`presets.js`, 120 s day, standing in Play, 10 s): sun step 0 (the old behaviour) re-rendered the far
map on 456 of 457 frames (direct path) and the cascades' static layers on every frame, 634 M far-map triangles; at
0.15° the far map rendered 142 times direct + 50 static / 50 dynamic, the cascade static layers 142 times (~17 Hz),
296 M triangles (−53 %). After the slider stops, the shadow direction is the exact sun within 8 frames
(`exactAfter600ms: true`).

**Pictures (frozen clock).** `pix.js`: walk 0.8 s with P14 on (caches evolve; the player, walkers, cars and the
swaying trees move; `SUN=1` also moves the sun 0.6° a step), freeze `performance.now` and the rAF clock, then shoot
ON (the cached / ranged path as it stands), OFF (ranges + split off, both maps forced to re-render every caster) and
OFF again (noise floor):
- Diorama, 6 + 8 steps (with the moving sun): **0 differing pixels** at every step (noise floor 0).
- Tiled 3×3, 6 + 8 steps (with the moving sun): 0 differing pixels at 13 of 14 steps; one step 6 px at max 2/255
  (noise floor 0). That is the reach-free static layers holding a caster whose shadow lands just outside the view: a
  PCF tap at the screen edge.
- The joiner deferral was on in every ON shot (tiled steps saw tile meshes joining).
- By design not identical (each has its own switch): the cascade slack (`MODE=slack`, slack 64 vs 0: 2.5–4.8 k of
  1.1 M px differ, mean 0.004–0.016, max 13–40/255, at the cascade's outer blend band and depth-quantisation edges;
  P6.2 measured the same class for the far map) and the stepped sun while it moves (`MODE=sun`, mean 0.3–1.1/255:
  the shadows lag the sun by < 0.15°, about 3 frames of a 120 s day; 0 after it stops).
- Presets (`preset-*.png`): High = today exactly (same settings); Low drops the near cascade (soft 3×3 far-map
  shadows only; thin poles lose their shadow at 1024); Ultra adds the mid cascade. No GPU errors in any run.

### Switches

| Switch | Default | Effect |
|---|---|---|
| `Renderer3D.shadowRangeCulling` (`farRanges`) | true | Far-map sub-mesh runs |
| `Renderer3D.cascadeStaticCache` (`cascadeCache`) | true | Cascade static layers + dynamic composite |
| `Renderer3D.CASCADE_FOLLOW_SLACK_TEXELS` (`cascadeSlackTexels`) | 64 | Cascade box slack (0 = re-centre every texel) |
| `Renderer3D.staticJoinDefer` (`joinDefer`), `STATIC_JOIN_TRIS`, `STATIC_JOIN_FRAMES` | true, 200 k, 120 | Joiner batching (far map + cascades) |
| `Renderer3D.SUN_SHADOW_STEP_DEG` (`sunStepDeg`), `SUN_SETTLE_FRAMES` | 0.15, 8 | Stepped shadow sun (0 = every change) |
| `renderer3D.shadowStaticCache` (`farStaticCache`) | true | The P4.2 far cache (unchanged) |

Diagnostics: `sm.getShadowCacheStats3D()` (far: static renders + why, dynamic passes, direct renders, joiners;
cascades: static renders + why, composites, re-centres, list sizes, joiners, held), `getFrameStats3D()`
`rangeTrisCulledShadow`, `cascadeStaticRenders`, `cascadeDynPasses`, `cascadeRecentres`.

### Tests
- `shadow-cache.test.ts` (new): run selection = brute force for light box and light box ∩ reach on a block-ordered tile
  mesh; no triangle with a vertex inside the light box is dropped; `containsAABB` conservative; signature order
  independence; box hold / re-centre rules; the depth margin covers every allowed move (3 sun angles);
  `cascadeLightBox` + `cascadeMatrixFromBox` = `computeCascadeMatrix` bit for bit; the refresh decision table and a
  walk sequence; joiners batch and stay exact while tiles arrive and leave; the stepped sun.
- `shadow-quality.test.ts` (new): High = today's values, the presets' order, `custom`, the LOD-settings field (saved
  only when changed, writes the PCF kernel, an explicit `pcf` wins, old saves), the renderer scale hook.
- `world-lod-settings.test.ts` (+1): a preset through WorldManager sets the cascades, map sizes, refresh and PCF, is
  saved in the marker, and `custom` / back to High.
- Full suite: 2,635 passed. WGSL unchanged (no shader edits).

### Next
- A second cached level for the cascades: the movers at the cascade interval and only the player every frame (today the
  player's pose redraws all dynamic casters, mostly wind-swayed trees: ~0.3 M of the remaining ~0.35 M diorama
  triangles). Not bit-identical in motion (trees at 30 Hz instead of 60), so it needs a look call.
- Fewer cascade re-centres when turning: centre the box on the eye with a forward bias that turns with hysteresis, or a
  larger slack (128 texels ≈ 3 m) once coverage is checked.
- Cheaper run expansion on refresh frames (+0.4–0.9 ms CPU): skip entries wholly inside the tester by their mesh box,
  reuse the previous frame's spans while the light box holds.

## P15 — GPU-driven rendering (engine-roadmap step 4), status 2026-10-02

**State:** Phases A, B and C are built, verified pixel-identical, and **ON by default** (`Renderer3D.gpuDriven = true`).
Phase D (Hi-Z occlusion) is not built. Every piece keeps its own switch: `sm.setGpuDriven3D({ enabled, lean, twins,
ranges, prepasses, mergePatterned, shadows, cpuState, mdi })`. `enabled: false` is the CPU path exactly (nothing of the GPU
scene runs). See docs/ui/performance.md §GPU-driven rendering for the host / QA view.

**UPDATE 2026-10-03: read "The GPU-path main-pass cost: cause, fix, auto tuning" below first.** The numbers in this
paragraph came from a timing driver that inflated the GPU path (finding 1). The real main-pass cost was the merged
full-shader pipeline. It is fixed: `mergePatterned` is now off by default, and the rank keys plain / full shaders
and uses 80 m cells. The rest is zero-instance draws, and the main part of that is in the GPU shadow passes.

**The trade (as measured 2026-10-02).** The GPU path saves main-thread time on every frame. On D3D12 (Windows) it costs
GPU time in big tiled worlds. Every record is an indirect draw, culled ones included (instanceCount 0). In the real
scene a zero-instance `drawIndexedIndirect` costs about 0.3 µs of GPU front-end time. That was measured by turning
the CPU path's own draws into indirect draws (no cost) and then adding 3 zero-instance draws after each one (+3.5 ms
for ~12 k zero draws). With ~15 k records in a tiled 3×3 world:
- at 1300×850 the main pass is +2.3–3 ms (5–6 → 8–9 ms) and Phase C's shadow passes +0.4–1 ms;
- at 2500×1390 the frame's GPU time is +4–6 ms (≈24 → ≈30 ms);
- the diorama (5.4 k records) is within noise.
A CPU-bound frame (the common case at window sizes, and every diorama) is faster ON. A GPU-bound full-screen tiled
frame is slower ON. The host should expose the switch (see docs/ui/performance.md). Multi-draw-indirect with a count
buffer would issue only the visible draws, but it exists only in flagged Chrome and Dawn's MDI validation costs 2–10 ms
per frame in a micro-benchmark (`pupdrive/gd2/mdi2.js`), so it is not a fix today. The GPU in these runs was 30–60 %
busy with other applications throughout; GPU numbers are paired medians and noisy (spreads 2–16 ms).

### Phase A — the opaque main pass (built earlier; validated and switched on 2026-10-02)
- `gpu-driven.ts` (layouts, the CPU mirror `gdCullRecord`, buckets, dirty ranges), `shaders/gpu-cull-shaders.ts`
  (`cs_cull`: frustum with a relative epsilon, distance LOD + hysteresis, fog horizon), `gpu-scene.ts` (`GpuDrivenMain`:
  persistent records, the draw order = the CPU path's rank order, render bundles of one `drawIndexedIndirect` per
  record, O(new) insertion, throttled rebuilds, async stats + verification).
- **Identity (frozen clock, ON / OFF / ON2, `pupdrive/gpu/vis.js`, `pupdrive/gd2/feat.js`):** 0 px at street /
  rooftop / sky / Play, with and without the fog horizon (hard edge, Buildings only, 15 m fade), in the diorama, tiled
  3×3 and tiled with Stream to camera. Also 0 px with night, Cel HD + ink outlines, the PS1 400×240 lo-res look,
  resolution scaling 0.75, a planar mirror and SSAO, in the diorama and tiled. (One tiled sky shot differed by 7 px,
  and so did its ON-vs-ON2 shot: frame noise.)
- **Motion (`pupdrive/gd2/motion2.js`, a verification on every frame in real time):** Play walk with 20°/frame turn
  bursts and a 25°/frame free-camera spin, diorama and streamed: 0 missing in 6.3 M record checks. (The earlier
  `motion-*.log` with missing objects predates the WGSL record-layout fix.) A later, longer streamed walk found
  LOD-band disagreements between the GPU's and the CPU's hysteresis. They are fixed by taking the CPU's state
  (Phase B, `cpuState`): 0 missing in 13 M checks since.
- **Streaming (`pupdrive/gd2/streamfly.js`):** a 30-tile fly at street height, Stream to camera on, a verification
  on every frame plus 10 frozen ON / OFF / OFF2 pixel triplets: 2.8 M records checked, 0 missing, 0 px at all 10
  samples. (Two traps found in the driver, not in the engine: camera-motion resolution scaling drops the first
  frame after a pause to 0.78, and an unfrozen clock moves crowds and traffic between shots.)
- **CPU (paired Play walks, interleaved ×3, ~2,100 frames per mode, no profiling wrappers):**

| World | Metric (ms, mean / p95) | OFF | Phase A | A+B | A+B+C |
|---|---|---|---|---|---|
| diorama | drawMeshes | 5.19 / 6.7 | 4.14 / 5.4 | 4.15 / 5.8 | **2.91 / 3.9** |
| diorama | draw lists + GPU sync + main encode | 3.50 / 4.2 | 2.53 / 3.1 | 2.55 / 3.4 | **1.52 / 2.0** |
| tiled 3×3 | drawMeshes | 18.33 / 30.7 | 14.63 / 28.2 | 10.18 / 17.0 | **8.85 / 16.3** |
| tiled 3×3 | draw lists + GPU sync + main encode | 12.72 / 20.2 | 9.10 / 16.2 | 6.64 / 9.7 | **5.01 / 8.1** |

  (The OFF tiled row comes from two different sessions: 18.3 / 12.7 in the A run, 12.4 / 8.9 in the C run. Compare
  within a column pair. The frame gap stayed at the 16.7 ms vsync in the diorama; tiled p95 gaps 25.6 OFF vs
  25.0 ON.)
- **Fixed poses (tight loop, lean on, `shprobe.js`):** tiled street drawMeshes OFF 21.0 → A+B 13.7 ms, rooftop
  13.5 → 7.8 ms. The shadow lists were 3.7 / 2.3 ms of the remaining list build. A later session with C (its tiled
  world rendered lighter: OFF 6.4 ms) measured OFF 6.4 → C 2.8 ms at street, against 1.8 ms with no shadow lists
  at all.

### Phase B (built 2026-10-02)
- **Twins on the GPU.** Mesh twins (`lodTwinNear` / `lodTwinNear2`, roles 1–4, `lodTwinOffNear`,
  `lodTwinInstanced` + `Renderer3D.groupTwins`) and P8 group twins (the instances' origin box) are decided by
  `cs_cull` with the CPU's hysteresis. The P9 re-seed: the loop stamps `GD_CTL_VISITED` where the CPU sets
  `_hcSeen`, and the state keeps `GD_STATE_VISITED_LAST`. A twin not visited the frame before (not in the roster, a
  rejected cluster, a frame without the hierarchical cull) re-seeds. A member of a rejected cluster now draws 0 and
  holds its LOD / twin state, exactly as the CPU skips it (before, the GPU kept updating it). Verification extras
  went 5 → 0. P12 crowd tiers stay CPU-decided (`lodTwinExternal`): their owner swaps a cell only once its mesh is
  resident, which is not a distance rule. Switch: `twins`.
- **P11 cull ranges on the GPU.** A heavy record (its `_rangesFor` run table, built where the CPU path would build it)
  owns `GD_RANGE_SPANS` = 4 argument blocks. `cs_ranges` runs one workgroup per ranged record. It tests block and run
  boxes into a bitmask, merges kept runs with the CPU's gap of 2, and splits at the 3 largest remaining gaps (the
  optimal 4-span cover; equal to the CPU's spans whenever they fit). Run boxes live in a bump-allocated box pool.
  Sizing: in the tiled world ~320 ranged meshes are in view, 97 % need ≤ 4 spans, and the tables hold ~15 k runs
  (360 KB). Phase A drew them whole: +23 % main-pass triangles at rooftop height. With the jobs the triangle count
  equals the CPU path's (5.61 vs 5.51 M at street). Switch: `ranges`.
- **The fog fade band** needed nothing new. The cull keeps faders, since it culls only past edge × 1.01, and the
  band affects only the shadow static / dynamic split and a shader uniform. Fog-fade identity runs: 0 px.
- **The prepasses reuse the culled set.** The outline depth + normal pass, the SSAO / SSR G-buffer pass and the SSR
  depth peel replay the main pass's argument blocks from their own bundles. They run in the CPU pass list's order
  (roster, then groups), tracked per frame; a bundle re-records only when that order changes. The first version used
  rank order and moved ink lines at coplanar kerb / crossing paint by 1–23 px. Only multi-material,
  vertex-coloured and unplaced meshes are still drawn by the CPU. Lean mode now stays on with ink outlines / SSAO /
  SSR. Switch: `prepasses`.
- **The LOD / twin state comes from the CPU loop** (`cpuState`, `GD_CTL_CPU_*`). The final motion run caught a
  streamed Play walk with 622 missing draws in 3.8 M checks, all window-sill trims (`detail-trim-sill`, 27 m draw
  distance) inside the LOD hysteresis band. There the GPU's state said hidden and the CPU's said shown. The GPU
  kept its own f32 hysteresis (Phase A). Once the two histories split at a threshold (an f32 / f64 rounding tie,
  likelier at tiled-world coordinates), they disagree for as long as the camera stays inside the 10 % band. The
  CPU loop computes the LOD and twin state of every visited record anyway (Phase C still needs it). Now the control
  word carries the CPU's post-loop state and the cull takes it, so the GPU decides frustum, ranges, fog and shadows
  and the CPU's hysteresis is the only one. The loop writes the bits where it decides them (`cpuMesh` /
  `cpuGroupNear` / `cpuGroupLod`), so it costs nothing: GPU sync 0.61 ms with it vs 0.63 ms without. A first version
  read every record's state in the control pass and cost +0.76 ms. After the fix: 0 missing in 17.4 M walk checks
  and 3 M spin checks (three 20 s streamed walks), and vis tiled is 0 px. The GPU still has its own hysteresis code (`cpuState: false`), which a future loop
  skip would need, with a tie-proof rule.
- **Merged pipelines.** The city interleaves plain and patterned meshes in rank order. A pre-recorded bundle switches
  pipeline at every alternation, culled records included (the CPU path only between visible ones). With
  `mergePatterned` every record uses the full (patterned) variant, which renders identically (§3.1). Buckets went
  4,036 → 397 in tiled and 905 → 188 in the diorama; main pass −1.1 to −1.2 ms. The merge waits until all four
  full variants have compiled (`_gdMergeOk`, then `recode()`), so no plain mesh waits on a pipeline the CPU path
  would not use. Without that wait, the first frames after switching on missed a few props (found by vis.js).

### Phase C — shadows from the same records (built 2026-10-02)
- `cs_shadow` evaluates the CPU loop's shadow section per record in light space:
  - the far light box, the shadow reach (the box swept along the light to the floor against the camera frustum),
    and the P8 shadow LOD (far / cascade texels);
  - the P4.2 / P14 static / dynamic split: motion hold + probation come from the CPU (`GD_CTL_DYNAMIC`, kept per
    record from `_casterUntil`); wind sway and the fade band are evaluated on the GPU;
  - the near-cascade boxes, split or not, and the HC_NOREACH static push (`GD_CTL_NOREACH`).
- It writes 7 argument layers per record: far direct / static / dynamic, and each cascade static / dynamic. Each
  shadow pass replays its layer from a bundle; the CPU lists hold only the CPU-decided casters. The loop skips the
  whole shadow section for GPU records.
- **The P14 caches are kept.** Static membership lives in the state word (`MEM_*`). A commit pass (`cs_commit`) on
  the frame a static layer re-renders makes it the layer's drawn set (`IN_*`). Joiners (members not drawn in yet)
  go to the dynamic layer exactly like the CPU's StaticLayerMembers. The pass counts each layer's leavers / joiners
  / joiner triangles. The renderer reads them back (1–3 frames late) and turns them into a signature epoch and the
  joiner-due rule, so a static layer still re-renders only on invalidation, inside its own refresh throttle (3 / 30
  frames). Static re-render counts per 12 s walk round: OFF 22–32 far / 42–53 cascade, C 19–26 / 47–55.
- **Identity:** `gpu-driven.test.ts` runs two identical scenes in lockstep and checks that every layer's GPU casters
  = the CPU path's shadow lists, on every frame of a 160-frame path. The path includes probation, a mover, wind sway,
  shadow LOD, both cascades and real static-layer commits, and the static re-render counts are equal.
  Browser (`pupdrive/gd2/shpix.js`, the P14 pix.js pattern: ON as the caches evolved vs CPU lists with forced
  re-renders): diorama 8 / 8 and tiled 10 / 10 Play-walk steps at 0 px, with GPU-reported leavers / joiners on 7 of
  the steps.
- **Not on the GPU yet:** the P14.1 shadow cull ranges. GPU casters draw whole into the shadow maps; the pixels are
  identical, but shadow passes rasterise more triangles on the frames they render. The shadow draw counters
  (`shadowDrawCalls`, `farTris`) count only the CPU-drawn casters. Switch: `shadows`.

### Status / resume here (2026-10-03): GPU culling mode + sub-bundle omission
- **Done: GPU culling mode** `sm.setGpuCullingMode3D('auto' | 'on' | 'off')` / `getGpuCullingMode3D()` (default 'auto';
  localStorage `salsa.viewport.gpuCulling`; 'off' = gpuDriven false). Controller `gpu-cull-auto.ts`: medians of renderer
  main-thread ms (WebGPURenderer.render) and GPU timestamp ms per path; switch to the CPU path when GPU-bound
  (GPU ≥ 0.9 × budget and ≥ CPU) and the other path is predicted ≥ 8 % faster (ratios learned at each switch); back on
  CPU-bound or headroom (predicted < 0.75 × budget); dwell 1.5 s (doubled after a regretted switch, up to 12 s); 'estimate'
  timer = stay on GPU, timer off (captures) = hold. While on the CPU path the GPU scene stays WARM (stamps, syncs,
  finish, bundles; no dispatch, no lean, no GPU shadows), so a switch never rebuilds or re-records (tested); the
  cached shadow layers re-render once on a switch. Tests: `gpu-cull-auto.test.ts` (10), `gpu-driven.test.ts` (+7).
  **Not yet measured live** (driver ready: `pupdrive/gdauto/autobeh.js`, WORLD=diorama|tiled, VW/VH).
- **Done but default OFF: sub-bundle omission** (`GpuDrivenMain.subBundles`, `Renderer3D.rankCellM`; A/B
  `sm.setGpuDriven3D({ subBundles: true, rankCellM: 80 })`). The draw rank gets a Z-order 80 m cell key (both paths,
  so ON = OFF by construction; the old order among `custom:<uuid>` keys was arbitrary); one sub-bundle per cell run +
  2 group levels (8 / 64); per frame `gdSkippable` (control words) + `gdBoxOutside` (union box) pick the replay list.
  Identity: frozen ON / OFF / ON2 / ON-full 0 px at 16 poses (tiled + diorama, fog on / off), verify 0 missing and 0
  omitted-but-drawn, no GPU errors (`pupdrive/gdauto/vis.js`). Tiled street: 215 sub-bundles, ~5.8-7.6 k zero draws
  left out a frame, 75 bundles replayed.
- **Why OFF: no measurable GPU saving.** On the same recorded bundles, kept vs full = −0.07 ms (IQR ±2.4) and full +
  5.9 k extra zero-only draws = −0.70 ms (IQR ±3.4) (`gdauto/gtab.js`, 1300×850, GPU 16-72 % busy with other apps).
  Micro-benchmark (`gdauto/subbench.js`): ≤ 0.04 µs per zero draw inside bundles; 200 sub-bundles cost nothing there,
  but in the city ~3 µs each. So the 0.3 µs/zero-draw figure above does NOT reproduce in bundles today, and the GPU
  path's extra main-pass time (paired OFF→ON +3.4 ms at 1300×850 in the last run) comes from elsewhere. Re-record CPU:
  3.3 ms one bundle vs 7-13 ms with sub-bundles + groups.
- **Next (DONE 2026-10-03, see the next section):** (1) find the real GPU-path main-pass cost: per-piece runs (`gdauto/gt.js` MODES=OFF,ONS,ONNM,ONNR,ONNT,ONNP,ONNC)
  last gave OFF 6.4 / ON 10.5 / merge-off 11.5 / ranges-off 11.1 ms; suspects: indirect draws with compute-written
  args (Dawn validation / root constants), the merged full-pattern shader; (2) run `autobeh.js` (diorama / tiled,
  window / 2500×1390) and tune the thresholds; (3) only re-enable sub-bundles if (1) shows zero draws matter.

### The GPU-path main-pass cost: cause, fix, auto tuning (2026-10-03)

Drivers are in `pupdrive/gdcause/`:
- `cause.js`: factor modes with replayed bundles;
- `fix.js`: the shipped-state A/B;
- `vis.js`: identity;
- `autobeh2.js`: auto mode live, with `absum.py` to summarise;
- `vite5203.config.mjs`: a private no-HMR server.

All runs were at the tiled Play street pose with a frozen pose, the live loop suspended, 2 frames in flight, and
rotating paired rounds. The GPU was 20–99 % busy with other applications in most runs, so read the paired medians,
not single numbers.

**1. Most of the old "+4 ms main pass" was a measurement artefact.** `gdauto/gt.js` (and `gtab.js`) computed a
pass's time as its sum over the run ÷ `__gp.frames`. But `__gp.frames` counts timestamp read-back BATCHES, and a
batch is skipped while the previous read-back is busy. The GPU path has one more submit per frame (the cull), so it
had fewer batches per frame and inflated numbers. In one run the "main pass" was 14.3 ms in a frame whose whole GPU
time (the engine's own GpuFrameTimer, the sum of the submit spans) was 8.8 ms. The new drivers read:
- each pass's per-instance median (one main pass a frame, checked: `mainN` = frames);
- the engine timer's frame ms (`fr`).

**2. The real main-pass cost was the merged pipeline (`mergePatterned`).** Paired against OFF at 1300×850:

| Mode (what the main pass draws) | main Δ | frame Δ |
|---|---|---|
| OND: DIRECT draws of the GPU's visible set, same order and buckets, merged pipelines | +6.7 | — |
| ONDP: the same with each record's per-mesh (plain / full) pipeline | +0.26 | — |
| ONCPU: the CPU path's own command stream, replayed in an ON frame | +0.2 | +0.2 |

(These numbers use the old pass metric, but the pairs within one run compare the same thing. The ONDP vs OND
contrast held in every run.)
- The full shader costs much more fragment time than the plain one, and the merge made every plain mesh pay it.
- Turning the merge off alone (old rank, `ONU0`) gave 4,040 buckets. The pipeline then switches at every
  plain / patterned alternation, culled records included.
- **Fix:** `Renderer3D.rankPatterned` (default on) puts the plain / full choice into the draw rank's pipeline class,
  in BOTH paths. The two kinds then form separate runs (398 buckets unmerged, as many as merged), and
  `GpuDrivenMain.mergePatterned` now defaults to false.

**3. Draw order.** `Renderer3D.rankCellM` = 80 m (the spatial cell key, built for sub-bundles) is now on by default.
The coherent order cuts the CPU path's own main pass by 0.48 ms at 1300×850 and 0.9–1.1 ms at 2500×1390, with the
same draws (3 runs). Front-to-back sorting was not needed: the CPU path never sorted by depth either. The orders of
the two paths are identical by construction.

**4. Indirect and bundles are not the cost; zero-instance draws are, a little and erratically.** Same args buffer,
same order and pipelines, paired vs OFF:

| Canvas | full bundle (17.2 k blocks) | ONC: indirect bundle of the visible 3.7–4.1 k only | OND: direct | ONCPU |
|---|---|---|---|---|
| 1300×850, main / frame | +0.26–0.72 / +0.6–1.3 | +0.07–0.18 / +0.1–0.14 | +0.04–0.19 / +0.15–0.3 | +0.2–0.29 / ≈0 |
| 2500×1390, main / frame | +1.1 / +1.6 (quiet run); +12.7 / +17 (busy run) | +0.07–0.15 / +0.1–0.36 | −0.01 / −0.23 | −0.21 / +0.09 |

The ~13.5 k zero-instance draws cost ≈ 40 ns each in the pass, plus about as much again outside it (Dawn's indirect
validation is per draw). The worse part: the runs that include them are the only ones whose round-to-round spread
explodes (8–37 ms vs ≤ 2 ms for every other mode) when other applications use the GPU. A visible-only bundle is not
a usable design (the visible set is the GPU's), so the options are:
- sub-bundles (built, off: on the new metric ON+S vs OFF+S was +0.86 ms main at 2500 in a quiet run, and lost in the
  noise in a busy one; the re-record CPU is 2–4× higher);
- count-buffer MDI (Dawn validation cost);
- or the auto mode.

**5. Phase C shadows are the other remaining cost, again zero draws.** Each shadow pass replays a bundle of EVERY
caster record. The per-frame dynamic layers are sparse: 212 nonzero of ~15 k in cascade 0, 468 in the far map.
- GPU shadows on vs off: +0.76–1.3 ms frame at 1300×850 (ShadowCascade0 0.52–0.58 vs 0.14–0.20 ms a pass).
- With the shadow bundles cut to their nonzero blocks (driver flag `+SHC`): +0.04 ms.
- A real fix needs a CPU-side superset of each dynamic layer, which the GPU-decided joiners make hard. The order
  within a depth-only pass does not matter, so a compacted (non-order-preserving) list is identity-safe, but WebGPU
  still needs the draw count on the CPU. **Done 2026-10-03:** see "Compacted dynamic shadow layers" below.

**6. Other passes.** `GdCull` (cull + ranges + shadow compute) is 0.075–0.09 ms; the stats copy is negligible.

**Result (the fix, paired vs OFF of the same rank, frame = engine GPU timer):**

| | before (merged, old rank) | after (per-mesh pipelines, plain / full rank) |
|---|---|---|
| tiled 1300×850 street, main / frame | +2.38 / +2.53 | +0.38 / +1.70 (another run +0.22 / +0.78) |
| tiled 2500×1390 street, main / frame | +2.78 / +4.44 | +1.62 / +2.23 |
| diorama 1300×850, main / frame | +0.27 / +0.90 | −0.17 / +0.31 |
| tiled rooftop 1300×850, main / frame | +0.31 / +0.59 | +0.46 / +0.87 (noise floor) |

- Merged pipelines with the new rank (`ONM`): +3.7 / +5.0 at 1300×850. The merge itself was the loss.
- Identity (`gdcause/vis.js`, frozen clock, ON / OFF / ON2, with rankCellM 80 + rankPatterned): 16 poses (street,
  rooftop, sky, Play; fog on and off; diorama and tiled), 32 / 32 pairs 0 px, verify 0 missing / 0 extra at every
  pose, no GPU errors.
- Test: `gpu-driven.test.ts` "the rank keys plain / full shaders" (no alternation, plain records keep the plain
  state code, GPU = CPU sequence, the old rank has more buckets).

**Auto mode, live** (`autobeh2.js`: the real loop, vsync; modes auto / on / off rotated, 2 rounds × (16 s motion +
8 s standing); medians of 250 ms samples; the GPU 75–99 % busy with other applications in most runs):

| World, canvas, motion | Off: fps, GPU ms, CPU ms | On: fps, GPU, CPU | Auto, first tuning: fps, share on GPU, switches |
|---|---|---|---|
| tiled 1300, Play | 49, 6.5, 18.3 | 59.5, 8.7, 12.0 | 55, 100 %, 0 |
| tiled 1300, fly | 20.5, 8.8, 49 | 23.5, 20.3, 57 | 21, 73–100 %, 1 |
| tiled 2500, Play | 37.5, 14.5, 25.6 | 54.5, 15.0, 12.5 | 28.5, 56–100 %, 0–3 a segment |
| tiled 2500, fly | 34, 19.3, 31.7 | 29.5, 34.5, 24.8 | 23, 31–44 %, 4 a segment |
| diorama 1300 / 2500, Play / fly | 60 | 49.5–60 | 60, 65–100 %, ≤ 1 |

The first controller (0.6 s window, 1.5 s dwell, 8 % gain, 50 % learning) flapped in the GPU-contended
full-screen tiled cases. There it was slower than both fixed paths. Under contention its learned GPU ratio reached
1.9–2.8 from one noisy before / after pair.

Retuned (`gpu-cull-auto.ts` defaults):
- 1 s window, 12 samples, a 3 s dwell (24 s max);
- a 10 % bar to leave the GPU path (`leaveGain`; the prior ratio is 1.15, so a higher bar would never leave);
- learning weight 0.3, ratios clamped to [0.3, 1.2] (CPU) and [0.85, 2] (GPU);
- a regretted switch goes straight back once, then the dwell doubles.

Tests: `gpu-cull-auto.test.ts` +2 ("a regretted switch goes straight back", "spiky GPU ms from other applications
do not make it flap").

Re-run with the tuned controller (same driver; GPU 48–100 % busy with other applications):

| World, canvas, motion: move / stand | Off fps (GPU ms) | On fps (GPU ms) | Auto fps (GPU ms), share on GPU, switches |
|---|---|---|---|
| tiled 1300, Play | 60 / 60 (8.2) | 60 / 60 (9.4) | 60 / 60 (8.6), 100 %, 0 |
| tiled 1300, fly | 57 / 60 (7.9) | 55.5 / 60 (10.0) | 55.5 / 60 (10.0), 100 %, 0 |
| tiled 2500, Play | 42 / 49 (13.0) | 41 / 41 (16.2) | 43.5 / 40 (18.0), 100 %, 0 |
| tiled 2500, fly | 53.5 / 41 (18.7) | 49 / 39.5 (20.4) | 49 / 39 (20.3), 100 %, 0 |

- No flapping, and Auto = On within noise everywhere.
- At 2500×1390 with the GPU saturated by other applications, Off was 1–9 fps better on some segments. Auto did
  not try it: the CPU path's predicted CPU cost (CPU ms ÷ 0.7) was above the GPU path's frame. Under GPU
  back-pressure the measured CPU ms inflate on both paths, and the 0.7 prior then over-predicts the CPU path's cost.
- On an unloaded GPU the paths are within 1–2 ms of GPU time (finding 4), so staying on the GPU path (the lower
  main-thread cost) is the right default.
- The diorama was not re-run (before tuning it was already on the GPU path with at most 1 switch, and the tuning only
  makes leaving harder).

### Compacted dynamic shadow layers (2026-10-03): the shadow passes' zero draws removed

**What.** The per-frame DYNAMIC shadow layers (far dynamic, cascade 0 / 1 dynamic) used to replay a bundle of every
caster record (~15.8 k in the tiled city) for ~110–700 nonzero blocks. Now `cs_shadow` also APPENDS each nonzero
block of those three layers to a compact list per layer (an atomic slot counter in the stats buffer, words 25–27;
the lists sit after the 7 per-record layers in the args buffer). The shadow pass draws K slots of the list.
- **Why it is identity-safe:** a depth-only pass keeps the per-texel minimum whatever the draw order (the shadow
  pipelines use depthCompare 'less', no colour targets; the fade-band dissolve discards per texel).
- **K, the CPU draw count:** `gdCompactSize` (a power of two ≥ 32) of an UPPER BOUND that the control pass computes
  per record (`gdShadowDynMaybe`, gpu-driven.ts). It uses only facts the CPU has this frame:
  - the control word: enabled, forced, visited, the CPU's dynamic hold, its LOD / twin verdict;
  - the record: caster / wind flags, shadow LOD, fog class and box;
  - loosened (1e-4 relative) light-box / reach / cascade box tests;
  - the static layers' IN bits, from a read-back STATE SNAPSHOT. IN changes only by a commit or a CPU state upload,
    so a copy at the start of a cull after each commit (≈ 60 KB, async) is exact until the next commit of that
    layer. Between a commit and the landing of the next snapshot, that layer counts every candidate.
  The GPU-only facts (fog, membership) are assumed either way, so the bound can only be too high. The slots past
  the GPU's count are cleared to zero draws every frame (`clearBuffer`, ≤ K × 20 bytes).
- **Casters with their own vertex buffer** (`GD_CODE_VB_OVERRIDE`, flagged `GD_CTL_VB_OV`) stay out of the lists
  and draw from their per-record blocks after the K slots. The tiled city has none.
- **Bundles:** one per (layer, bind group, K), cached. They re-record only when the pipeline, buffers or the
  own-vertex-buffer list change, NOT on order changes (the per-record bundles re-record on every insert).
- **The static and direct layers keep per-record bundles.** They render only on invalidation (P14).
- **Upload fix found on the way.** State uploads bridged gaps of 256 records, so they overwrote the GPU-owned state
  (hysteresis, static-layer IN / MEM bits) of neighbours the CPU never seeded. They now upload contiguous runs only.
  Seeded words are stamped (`_seedF`), so the snapshot never vouches for a reset IN bit.
- **CPU:** the bound runs in the control pass (no new loop). Committed static casters skip it. The far light box
  and the near cascade boxes are tested once per record per box epoch (`_lbOut` / `_cbOut`, reset when the record is
  rewritten or a box moves), so the per-frame call (`gdShadowDynMaybe(..., cached = true, excl)`) runs only the
  camera-dependent shadow-reach test. The first version (every test every frame) cost +0.9 ms of GdSync in the
  tiled street.
  - An intermediate version also skipped the reach test in the cached call. That made the bound 3–4× the GPU's
    count (tiled far 1,062 bound vs 394 counted, K 2048; diorama far 1,994 vs 522, K 2048–4096) for no CPU saving.
    The reach test is back in the cached call (`gdBoundReach`, A/B `sm.setGpuDriven3D({ boundReach })`, default
    true): the bound now equals the count (tiled far 402 / 402, cascade 0 181 / 177; diorama 523 / 522, 191 / 190).
  - Measured (`gdshc/ctlprobe3.js`: a live Play walk, 18 alternating 2 s segments, `_ctlPass` ms per frame,
    performance.now resolution 0.1 ms): tiled median / p90 2.0 / 3.0 ms with reach, 2.0 / 3.4 without, 1.4 / 2.5
    with the per-record bundles (no bound); diorama 0.7 / 1.1, 0.5 / 0.9, 0.3 / 0.6.
  - The control pass is ~0.6 ms dearer in the tiled street, but the per-record shadow bundles re-record on every
    order change and the compact ones do not. A CPU profile of a 6 s tiled walk (`gdshc/prof.js`, 0.1 ms sampling):
    `_ctlPass` + `gdShadowDynMaybe` 345 ms vs 237 ms, `drawShadow` 50 ms vs 120 ms. Net ≈ +0.1 ms a frame of main
    thread for the compaction.
- **Switch:** `sm.setGpuDriven3D({ shadowCompact })` (`GpuDrivenMain.shadowCompact`, default **true**; false = the
  per-record bundles). `boundReach` (default true) only tightens K; the casters are the same either way. Stats in `getGpuDrivenStats3D()`: `shCompactOn`, `shBound`, `shK`, `shCount` (GPU, read
  back), `shCompactOver` (frames whose GPU count exceeded their K: must stay 0), `shOwnVb`, `shSnapAge`.

**Bound vs the GPU's count** (pix walks, before the box caches; the shipped cached + reach form measures the same,
see CPU above): tiled far 255–294 bound vs 255–294 counted (usually equal), cascade 0
108–128 vs 108–128 (538 on a frame right after a commit); diorama far 590–780 vs the same, cascade 0 136–165
(530–590 after a commit). K = 256–1024 against ~15.8 k (tiled) / ~5.5 k (diorama) per-record draws. Overflow:
0 frames in every run.

**GPU timing** (`pupdrive/gdshc/time.js`: the gdcause pattern, a frozen Play street pose, the live loop suspended,
2 frames in flight, 9 rotating paired rounds × 12 frames; per-pass PER-INSTANCE medians from the timestamp rows and
the engine GpuFrameTimer frame ms; not the old frames division). ONF = the per-record dynamic bundles (before),
ON = compact, OFF = the CPU path, ONNC = GPU path with GPU shadows off. `nvidia-smi`: the GPU was 40–53 % busy with
other applications in the 1300 tiled run, 99 % in the diorama run, 24–78 % at 2500.

| World, canvas | ShadowCascade0 / pass: ONF → ON (OFF) | shadow GPU ms / frame: ONF → ON (OFF, ONNC) | paired Δ shadow | frame ms ONF → ON (OFF) | paired Δ frame |
|---|---|---|---|---|---|
| tiled 1300×850 | 0.62 → **0.15** (0.15) | 0.57 → **0.15** (0.16, 0.14) | −0.41 | 8.69 → 8.25 (7.00) | −0.54 (IQR 0.8–1.0) |
| tiled 2500×1390 | 0.67 → **0.16** (0.16) | 0.68 → **0.16** (0.17, 0.15) | −0.53 | 23.5 → 22.6 (16.6) | −1.18 (IQR 2.9–3.9) |
| diorama 1300×850 | 0.26 → **0.10** (0.10) | 0.38 → **0.17** (0.18, 0.17) | −0.21 | 6.52 → 6.33 (6.03) | −0.21 (IQR 0.1) |

Re-run after the box caches and the reach-test fix (same driver, + mode ONNR = `boundReach: false`; `nvidia-smi`
5–7 % before each run, so other applications were quiet; the tiled frame series is still bimodal, 9 or 17 ms, from
the main pass):

| World, canvas | shadow GPU ms / frame: ONF → ON (OFF, ONNC, ONNR) | paired Δ shadow ON − ONF | frame ms ONF → ON (OFF) | paired Δ frame |
|---|---|---|---|---|
| tiled 1300×850 | 0.67 → **0.155** (0.175, 0.137, 0.150) | −0.49 | 10.3 → 9.7 (8.0) | −0.60 (IQR 7.5–8.7) |
| tiled 2500×1390 | 0.69 → **0.167** (0.173, 0.160, 0.160) | −0.51 | 30.8 → 18.4 (14.9) | −1.42 (IQR 9–16) |
| diorama 1300×850 | 0.26 → **0.125** (0.137, 0.137, 0.147) | −0.14 | 6.09 → 5.87 (5.63) | −0.28 (IQR 0.3–0.5) |

K with the reach test: tiled 512 / 256 (bound 468 / 212), diorama 1024 / 512 (840 / 267); without (ONNR) 1024 / 512
and 2048 / 512. On a quiet GPU the extra ~500–1,000 zero draws of ONNR do not show (0.150 vs 0.155 ms); the tighter K
matters under contention, where zero draws are erratic (finding 4).

The GPU shadow passes now cost what the CPU path's shadow passes cost (and what GPU shadows off costs): the shadow
part of the GPU-path deficit is gone. The far dynamic pass went 0.68 → 0.47 ms a pass (OFF 0.50).

**Stability check (`gdshc/check.js`, after a sky agent saw `GdCullEnc` / `GdShadowCompact` validation errors and
missing city geometry during this work):** live loop, shadows on, GPU culling 'on' → 'auto' → 'off' → 'on' with a
6 s walk each, in the diorama, the tiled 3×3 and the tiled 3×3 with Stream to camera (fast walk): 0 GPU errors in all
three worlds, `shCompactOver` 0, verify 0 missing (5.5 k / 15.2 k / 15.8 k records), and the main pass draws what the
CPU path draws (tiled 3.1–3.9 k draws, 4.9–5.7 M triangles; stream 3.5–4.2 k, 5.6–6.3 M). Auto stayed on the GPU path
(reasons headroom / cpu-bound). The errors did not reproduce with the finished code (most likely the sky agent loaded a half-edited intermediate state).

**Identity:**
- Re-run after the box caches and the reach-test fix: `gdshc/vis.js` tiled + diorama 32 / 32 pairs 0 px (ON vs OFF
  and ON vs ON2 at 8 poses each), verify 0 missing at every pose, no GPU errors; `gdshc/shpix.js` tiled 8 / 8 and
  diorama 8 / 8 steps 0 px for ON vs OFF, ON vs ONF and OFF vs OFF2 (bound = count on 15 of 16 steps; one step just
  after a commit 993 vs 294), overflow 0; `gdshc/walk.js` per 100 frames tiled cascade static 14.6 ON / 11.2 ONF /
  10.2 CPU, far 2.0 / 1.8 / 1.7; diorama cascade 15.4 / 14.5 / 13.8, far 5.5 / 5.8 / 4.8 (the walks differ by path;
  most cascade renders are camera-driven 'box' re-centres; within the earlier runs' spread).
- `gdcause/vis.js` pattern (`gdshc/vis.js`, frozen clock, ON / OFF / ON2, compaction on): 16 poses (street,
  rooftop, sky, Play; fog on / off; tiled and diorama), 32 / 32 pairs 0 px. Verify: 0 missing / 0 extra
  (163 k records checked). No GPU errors.
- The P14 / P15 shadow pix pattern (`gdshc/shpix.js`, a live Play walk; per step ON = compact with the caches as
  they evolved, ONF = per-record bundles, OFF = the CPU lists with both maps forced to re-render, OFF2 = noise):
  tiled 9 / 9 and diorama 8 / 8 steps at 0 px for both ON-vs-OFF and ON-vs-ONF (noise floor 0). Joiners and
  leavers occurred on 6 of the tiled steps. (A first diorama run differed at step 0 only by the auto player still
  spawning between shots; with a 5 s settle it was 0 px.)
- P14 re-render counts: the compaction changes no decision (the lockstep test: the GPU path with compaction = the
  CPU path's static renders and cascade re-render reasons, frame for frame). Live walks (`gdshc/walk.js`, 3
  interleaved rounds × 10 s; the walks differ by path) were within run-to-run noise. Per 100 frames: tiled
  cascade static 13.7 ON / 15.9 ONF / 14.6 CPU, far 1.7 / 1.8 / 1.4; diorama cascade 15.8 / 15.5 / 13.6, far 6.2 /
  6.0 / 5.7.

**Tests** (`gpu-driven.test.ts`, +4, 40 in all):
- the constants match the shader, and the compact sizes;
- the bound's cases: committed static casters are out; joiners, movers, wind and unknown membership are in; light
  box, reach, cascade box, LOD and forced misses are out; the cached form honours the caller's cascade verdicts and
  still drops a reach miss (and keeps it with `boundReach` off);
- a 24 k-record fuzz (random records, control words, states, frames, city coordinates): the bound ⊇ the dynamic
  bits of `gdShadowRecord`, for any known-IN subset;
- end to end on the recording device with read-backs resolving: every frame, each compact bundle draws exactly the
  layer's per-record casters, each once. The appended count is never past K, and the snapshot never vouches for an
  IN bit the GPU state lacks. The static re-render counts and the cascade re-render reasons equal the CPU path's.
  K summed to 36 % of one draw per record in that small scene.

**The main pass: the same trick? Not as is.** Re-checked with `gdcause/cause.js` (MODES OFF, ON, ONC = a bundle of
only the drawn blocks, OND = direct draws of them; the GPU 75–99 % busy with other applications):

| canvas | main pass OFF | ON (17.4 k blocks, ~13 k zero) | ONC (4.1–4.7 k visible, indirect) | frame OFF → ON → ONC |
|---|---|---|---|---|
| 1300×850 | 8.24 | 11.6 (spread 17) | 8.30 | 9.25 → 22.2 → 9.20 |
| 2500×1390 | 16.95 | 49.9 (series 31–97) | 17.07 | 18.7 → 81 → 18.9 |

So under contention the main pass's zero draws are now by far the biggest GPU-path cost, and a visible-only bundle
is as cheap as the CPU path. But the shadow trick does not carry over:
- the main pass's order matters: coplanar ties and colour, not a per-texel minimum. Any compaction would have to
  preserve order (a per-bucket scan);
- the draw count would be needed per bucket (398 buckets);
- the cheap CPU bound is loose here. `gdshc/mainbound.js` at the tiled street: records the CPU cannot rule out
  (enabled, forced-visible or visited past the hierarchical cull, not LOD-hidden) = 12.9 k of 17.8 k blocks, for
  4.0 k drawn. At the rooftop 10.9 k of 17.1 k. A tight bound needs the per-record frustum test the GPU path exists
  to avoid.
- a per-bucket K would also re-record the 17 k-draw bundle (3.3 ms CPU) whenever any bucket's K changes.
Options, in order: an order-preserving per-bucket compaction with a CPU frustum bound only for the visited
records, plus K hysteresis; count-buffer MDI (it removes the need for K entirely) once Dawn's validation is cheap;
or the Auto mode leaving the GPU path when GPU-bound (it did not, see above). Not built.

### Stats fix (2026-10-03): stale numbers after a scene loses its last static mesh
**Symptom (Frogmarks HUD):** an empty scene with one procedural character (10 objects, 22,062 tris in the scene)
showed "1,887,571 tris drawn", "2,960 draws" (all main; shadow 0, other 0) and "Over budget: 3.0 k draws".

**Cause: a stats bug, plus a held GPU scene. Nothing stale was drawn.** All the character's parts are skinned. With
no regular (non-skinned) meshes, `WebGPURenderer.draw3DMeshes` skips `Renderer3D.drawMeshes`, and `drawMeshes`
returns at once on an empty list. That function is the only place the per-frame counters are reset (`drawCalls`,
`trisDrawn`, `pass*`, `meshes`, `gpu*`). So after a city (or a document) was cleared, the HUD kept showing the last
static frame for good. `getRenderStats3D().drawn` and `getSceneBudget3D()` both read those counters, which explains
the false budget warning: its formula was right, but the inputs were stale. The GPU-driven scene was held the same
way. `gd.finish` never ran again, so no rebuild ever freed the records: all 5,330 records stayed, and they kept the
departed `Mesh3D`s and their CPU geometry alive. The pending P16 evictions were never drained either. The records
were not drawn, because the main pass that executes the bundle did not run.

Repro (`pupdrive/statsbug/p2.js`; diorama seed 3; exit, then `clear()`, then one character, seed 25):

| step | before the fix | after the fix |
|---|---|---|
| empty after clear | main 388,914 tris · 469 draws · fs.meshes 4,920 · 5,330 GPU records | 0 · 0 · 0 · 0 records |
| + one character (9 skinned parts) | main 421,032 tris · 478 draws | main 32,118 tris · 9 draws (= scene tris, one draw per part) |

The other sequences now read honestly too (`p3-*.js`):
- **A box stays after the clear:** 10 draws, 32,130 tris, 1 record.
- **Tiled 3×3 + HLOD, then clear:** 0, then 9 draws and 32,118 tris; 0 records, 0 pending evictions.
- **Document load over a city:** 9 draws and 32,118 tris; 0 records.

**Fix:**
- `Renderer3D.noStaticMeshesThisFrame()` runs on every frame with no regular meshes. It is called by `drawMeshes([])`,
  by both empty branches of `draw3DMeshes`, and by `SalsaViewerCore`. It:
  - zeroes the per-frame counters (the since-start cascade counters are kept);
  - drops the GPU-driven records (`gd.reset()`);
  - drains the deferred evictions.
- `draw3DMeshes` now runs `drawSkinnedMeshes` once more on an empty roster (`skinnedLastCount > 0`). Without that,
  the last character's skinned stats, shadow-change signal and replay list also stayed.
- `GpuDrivenMain.reset()` now clears the read-back counters, and a read in flight from a frame at or before the
  reset is ignored (`_statsFloor`). Before, a replaced scene's draws showed until the next read-back landed, and for
  good if on-demand rendering stopped first.
- `clearForDocumentLoad3D` calls `Renderer3D.resetGpuScene()`.
- `noteRemoved` also asks for the deferrable rebuild once the dead records reach `1 / DEAD_SHARE_DEN` (4) of all
  records. Before, a cleared small scene stayed under `DEAD_REBUILD` (256) and its records kept their meshes until
  some unrelated change.

**Tests** (`gpu-driven.test.ts`, P15 stats fix and P17):
- an empty static frame zeroes the frame stats and the pass split, and leaves 0 records and no held mesh; the scene
  then comes back drawing the CPU sequence;
- an in-flight read-back from before `resetGpuScene` is ignored;
- the dead-share rebuild, plus its control (3 dead records still wait).

Both new tests fail without the fix.

**Not changed:** a scene with only skinned meshes renders no shadow pass, since the shadow passes live in
`drawMeshes`. That has always been the case. There is no static mesh to receive a shadow either, so nothing visible
is lost.

### Draw bug (2026-10-04): a new character not drawn in the editor
**Report:** in a city, a procedural character created with `createFullCharacter3D` (with clothing and hair) and no
further input was sometimes not drawn in the editor. Its meshes showed `gpuDirty = true` until something forced a
redraw or a scale change. Play drew it fine.

**Repro** (`pupdrive/drawbug/repro.js`: city seed 3 or no city, then a character, then idle frames; it logs each
rendered frame's waiting draws, each part's pipeline state, cull flags, and whether the part is in the host render
list; `CULL`, `VARIANTS` and `TAA` switch the options):
- With **no city** (on-demand loop idle): the **whole character is missing for 2–8 s** in headless Chrome. All its
  skinned pipelines (`skinnedOpaque*Plain`, `skinnedFaceMultiply`) are compiling. The loop renders nothing while it
  waits, then the cache's ready event requests a frame and the character appears (`waitingDraws` goes to 0). The
  result is the same with TAA on or off, GPU culling on or off, and shader variants on or off.
- **In a city** the loop is live (traffic and crowds), so it never stalls. The window is 3.6 s, and longer while the
  city's warm-up queue is busy.
- `repro-vis.js` gives the case that never recovers. A part is hidden when a render-list rebuild runs (any structure
  change while it is hidden), then shown again with only a `scheduleRender`. The part stays undrawn
  (`inRL: false, visible: true`) until an unrelated structure change. A scale change is one such change.

**Root causes:**
1. **The host's 3D render list dropped hidden nodes.** `WebGPURenderer._rebuild3DLists` skipped `!visible` nodes,
   and it runs only on a rebuild (`onSceneGraphChanged` / `requestBackgroundRender`). Every show path that does not
   emit (`notifyVisibilityChanged3D`) left its node out of every frame:
   - the eye decal when its expression texture lands (`_applyTexture`: `visible = !!tex` + `gpuDirty = true`, the
     `gpuDirty` in the report);
   - the face kit (`paint`: `visible = enabled`);
   - script-destroyed meshes restored on Stop;
   - any host `mesh.visible = true`.

   The world code already worked around this with `notifyVisibilityChanged3D`. The character paths did not.
   `createFullCharacter3D` itself is safe: it batches and emits once, after everything is visible. But the regenerate
   paths, which await the worker after the decal is created hidden and emitted, can hit it.
2. **The skinned stats lied while pipelines compiled.** `drawSkinnedMeshes` counted `skinnedDrawn` before the pipeline
   check. A character that was invisible for seconds therefore read "7/9 drawn" (the two face overlays were the only
   parts not counted). `gpuDirty` is never cleared on skinned meshes, because the geometry pool clears it and skinned
   meshes have their own vertex buffers. Both signals pointed the wrong way: at uploads, not at compiles.
3. **A failed pipeline's retry needed a frame.** The bounded retry (D-R4) starts only from a `get()`, and an idle
   on-demand loop renders no frame by itself. A draw waiting on a transiently failed compile stayed missing until
   input arrived.

**Checked and ruled out** (the cache works as designed here):
- Pipeline-ready does re-request a frame for skinned draws: every skinned getter goes through `handle.get()`, so the
  skip is a waited draw.
- Shader variants never block a draw, because the base pipeline draws meanwhile.
- GPU-driven records: skinned meshes are not records; they draw in `drawSkinnedMeshes`.
- `noStaticMeshesThisFrame`.
- TAA settle.
- The upload budget (`upload-on-demand.test.ts`).

**Fix:**
- `_rebuild3DLists` keeps hidden 3D nodes. `draw3DMeshes`, `draw3DParticles` and `draw3DGp` already filter
  `visible` every frame, so a shown node draws on the next frame. The cost is a per-frame visible check over the
  hidden ones.
- `drawSkinnedMeshes` now counts `skinnedDrawn` and `skinnedTris` only when the draw is issued. A new frame stat,
  `skinnedWaiting`, counts the live parts skipped this frame because a pipeline is compiling or buffers are missing.
  A skip that is not a pipeline wait (no vertex/index buffer, skin bind group or VC bind group) calls
  `onDeferredWork`, so the on-demand loop retries; the cache's ready event cannot cover that case.
- `GPUPipelineCache._fail`: for a waited handle that may still retry, a timer wakes the ready listeners when the
  backoff expires. The host then schedules a frame, and that frame's `get()` starts the retry.

**Tests** (each fails without its fix):
- `src/renderer/core/render-list-hidden-show.test.ts`: a part hidden across a rebuild draws as soon as it is shown.
  This uses the real `_rebuild3DLists` and `draw3DMeshes` on a minimal host.
- `src/renderer/3d/skinned-draw-on-demand.test.ts`: a real `Renderer3D` in a live frame with the async compile
  pending. The part is waiting, not drawn, and the cache counts a waited draw; the landed compile fires the ready
  event, and the next frame draws it.
- `gpu-pipeline-cache.test.ts`: a transient failure on a waited draw wakes the host when the backoff expires, with no
  input, using fake timers; the retry lands and wakes it again.

**Still open:** in headless Chrome the first character waits seconds for its skinned pipelines whenever the warm-up
queue is long. This is on-demand compiling as designed, made slow by headless compile times. Warming the skinned
plain set at DOCUMENT priority, before any character exists, would shorten the window.

### Remaining
- **The main-pass zero-instance draws** (findings 4 and the section above): ≈ 0.5 ms on an idle GPU, but tens of
  ms under GPU contention (+3 ms main at 1300, +33 ms at 2500 in the 2026-10-03 re-check). The shadow passes' share
  is fixed (compacted dynamic layers). Options:
  - order-preserving per-bucket compaction with a CPU frustum bound;
  - sub-bundles (built, off);
  - count-buffer MDI once Dawn's validation is cheap;
  - the auto mode.
- Shadow cull ranges on the GPU (Phase C), and GPU-reported shadow draw stats.
- The loop still runs fog / LOD / twins on the CPU for every record (shadows of forced records, CPU state other code
  reads). Skipping that for GPU records is the next CPU win: ON-without-shadows ran 1.2 ms vs C's 2.0 ms of lists in
  the fixed-pose probe.
- Phase D (Hi-Z occlusion): not built.

**Files:** `src/renderer/3d/gpu-driven.ts` (+ `gpu-driven.test.ts`, 24 tests), `gpu-scene.ts`,
`shaders/gpu-cull-shaders.ts` (`cs_cull`, `cs_ranges`, `cs_shadow`, `cs_commit`), `renderer-3d.ts` (`_gd*`),
`mesh-3d.ts` / `array-group-3d.ts` (record keys). Drivers: `pupdrive/gpu/` (smoke, vis, gputime, gt2 = paired GPU
modes incl. the OFFI / OFFZ indirect experiments, mdibench) and `pupdrive/gd2/` (feat, motion2, streamfly, abwalk,
shprobe, rprobe, bprobe, oprobe, shpix, mdi2).

### Step 3b (small CPU hitch items), status 2026-10-02
- **Switches,** all on by default (`sm.setStep3Options3D`):
  - `incrementalCollisionGrid`: the Play collision broadphase follows structure changes;
  - `slicedReassembly`: a landing tile's groups are wrapped / warmed / attached in slices;
  - `packInstances`: tile instance lists cross from the worker as typed arrays;
  - `scopedBackdropLod`.
- **Collision cross-check:** 0 differences over 17,771 (diorama) + 15,341 (tiled) rays. Snapshot member diffs are
  0 too.
- **30-tile fly, with profiling wrappers:** long tasks 24 → 15, worst 100 → 77 ms.
- **Play walk, tiled 3×3, re-run cleanly ×2, interleaved, no wrappers:** OFF and ON are within noise (0–1 long
  tasks; frame-gap p50 16.7 / p95 33.3 ms either way). An earlier ON run looked worse (73 ms), but it ran while
  the machine was loaded: unrelated draw-list time was 16–22 ms against ~7 ms.
- `world-sliced-reassembly.test.ts`: the wall-clock assertions (worst job < 8 ms) were flaky under full-suite load
  and were removed. Structural checks remain: more frames, sliced jobs > 0, identical output and order.

## P16 — Streaming hitches (2026-10-02; docs/ui/performance.md §Streaming hitches)

**Goal:** endless exploration of a tiled 3×3 streaming world (Play and a free fly) with no main-thread hitches.
**Starting point:** the step-3b fly evidence (`pupdrive/step3b/tasks-ab-on-flyw.json`, `byTop`). The worst frames came from:
- instance uploads, up to 34–38 ms;
- a single writeBuffer, up to 53 ms;
- the geometry pool, up to 23 ms;
- tile removal: `evictMeshCaches` about 10 ms, plus remove group / removeChild;
- `cb: world LOD`, up to 27 ms;
- the collision snapshot sync, 4–9 ms.

Drivers: `pupdrive/hitch2/` (`tasks.js` = step 3b's per-task attribution plus writeBuffer bytes and slow-write stacks, perf counters, allocator state, heap samples; `ab.sh` / `final.sh` interleaved OFF/ON; `slotcheck.js` GPU readback check; `vis.js` frozen-clock shots; `snapprobe.js`).

### What the instrumented fly showed (P16 off)

| Bucket | Cause found |
|---|---|
| Instance uploads 23–39 ms | Not a full repack (0 in the fly). `_syncArrayGroupSlots` placing a landing tile's ~300 new array groups: each range alloc **scanned the whole unsorted free list** (one entry per evicted mesh slot, thousands): `inst: alloc fit` up to 22 ms. Then packing every new group in that frame (up to 11 ms). |
| writeBuffer 34–65 ms | Tiny writes (even a 0-byte-ish uniform write) **blocking**: Chrome's GPU-process backpressure after big frames. Frames wrote up to 18–22 MB (geometry 16 MB + instances + warms), 4 MB per write. |
| Geometry pool 18–23 ms | The GPU compaction (CPU 5–20 ms: one copy pair per live geometry, thousands of encoder calls; it also wrote every fresh geometry in whole pieces) and growth around it. |
| Tile removal 10–64 ms | `evictMeshCaches` per tile (free-list coalescing per released key, outline / skin cleanup), all in the removing call. The backdrop swap removed its 3 groups **non-silently** (a scene-graph event each). |
| `cb: world LOD` 27 ms | Only with step 3b's `scopedBackdropLod` off (it is on by default: ≤ 3 ms). Left: `_applyLodToGroup` up to 9 ms on one group, the per-node tier regex scans. |
| Collision snapshot 3–11 ms | Every new streamed mesh bumps `Mesh3D.geometryEpoch`, so every sync on a tile change re-read **every** member's footprint. And `PlayAutoPlayer.isRuntimeNode` scanned the auto player's parts linearly for each of ~13 k meshes per sync (about half of the sync). |

### Fixes (each an A/B switch: `sm.setStreamHitchOptions3D`, all on by default; `src/renderer/3d/stream-hitch.ts`)

1. **`indexedSlotFree`** (`instance-slot-allocator.ts`). The instance-slot free space is kept as maximal ranges (coalesced on every free; indexed by start and by end) in size buckets (floor log2). A free is O(1); a range alloc scans one or two buckets. The parked (owned) ranges are unchanged. The allocator converts its free space when the switch flips.
2. **`slicedGroupPacks`** (`renderer-3d.ts` `_syncArrayGroupSlots` / `_groupPackDeferrals`).
   - Newly shown array groups that need a fresh pack are packed under `STREAM_HITCH_LIMITS.groupPackInstances` (1,500 instances a frame, about 2–4 ms with per-instance rotation / scale). The order is in view first, then by camera distance (the group's instance box).
   - The first group always goes. A parked group that reclaims its range costs nothing and is never deferred.
   - **Hold rule:** a waiting group has no range, so the draw loop skips it. It is never drawn with stale slots.
   - `_groupsPending` keeps the next frames on the incremental path (not the fast path) until every group is placed, without forcing the id-map rebuild.
3. **`deferredEviction`** (`scene3d-manager.ts` `removeFlatColorMeshGroup`; `renderer-3d.ts` `evictMeshCachesDeferred` / `drainDeferredEviction` / `flushDeferredEviction`).
   - A removed group leaves the scene graph and the picker at once (not drawn, not hit).
   - The renderer's per-mesh cleanup (slots, geometry refs, outline / skin buffers, caches) is queued. It is drained at the top of each upload: batches of 64, `evictBudgetMs` 1.5 ms a frame.
   - The drain neither bumps the P9 cache generation nor re-ranks the draw order (the frame the meshes left already did).
   - A re-attach (`reattachFlatColorMeshGroup`, the LRU and centre restore) flushes its meshes first. A queued mesh found back in a frame's list is flushed before anything else, so a resident mesh never carries a pending eviction.
   - The backdrop swap now removes silently, with one coalesced host notification.
4. **`uploadLedger`** (`renderer-3d.ts` `_noteInstBytes` / `_geomBudgetLeft` / `_geomSlice`).
   - One per-frame write budget, `frameWriteBytes` 8 MB. Instance, group-pack and crowd-repack bytes come off it first (what is already resident draws first). Geometry gets the rest, never under `geomFloorBytes` (2 MB), so it never starves.
   - No geometry write is over `writeSliceBytes` (2 MB; step 3's was 4 MB).
   - A GPU compaction no longer writes fresh geometry in whole pieces. It moves only the live spans, and the fresh meshes stay unallocated (held out of the draw lists by the step-3 rule) until the sliced append places them.
5. **`coalescedCompaction`** (`geom-compaction.ts` `planSpanCompaction(…, coalesce)`). Spans adjacent in the old layout shift by the same distance, so a run of them is one move (chunked by the scratch size) instead of one copy pair per geometry.
6. **`lodStampMemo`** (`view-cull.ts` `memoTier` / `fogExtraIndex`; `world-manager.ts` `_stampDrawDistances`).
   - The LOD stamp's tier lookups (draw tiers, twin tiers, fog tiers, fog extras) are memoised per tier list and name. Lists with a global or sticky regex are never memoised. A new list (thresholds moved) starts a new memo.
   - A whole-world restamp forced only by the scene epoch skips groups already stamped for the current key with the same node count. `_applyLodToGroup` records its stamps.
7. **`snapshotMeshVersion`** (`collision-snapshot.ts` `geomVersion` dep; `Mesh3D.geometryVersion`; `play-auto-player.ts`).
   - A snapshot member's footprint is trusted by its own geometry version (bumped with the global epoch, per mesh). The global epoch is held constant under the switch.
   - `isRuntimeNode` answers from a Set of the cached body's part ids.

**Instance-buffer layout and upload timing (for the GPU-driven path, §P15):** the slot layout rules are unchanged (single slots, contiguous group ranges, parked ranges). What changed:
- free slots are reused in a different order;
- a new group can be placed a few frames after it appears;
- a removed mesh's slot stays allocated, but unread, until its eviction drains.

`gd.seeGroup` only sees placed groups, and removed meshes are not in the frame's list, so `gpu-scene.ts` needed no change.

### Results (headless d3d11 1300 × 850, tiled 3×3 seed 3, shared GPU → CPU counts; NOINST = no subsystem wrappers; OFF = every P16 switch false, same build; interleaved)

| Run | OFF (P16 off) | ON (P16 on) |
|---|---|---|
| 30-tile street fly, long tasks (> 50 ms) count / worst | 24 / 100, 11 / 83, 21 / 81, 14 / 75 | 5 / 70, 2 / 53, 7 / 79, 11 / 62 |
| … frame-gap p95 / max (ms) | 33.3 / 100, 16.8 / 67, 33.3 / 83, 16.8 / 67 | 16.8 / 67, 16.8 / 67, 16.8 / 167¹, 16.8 / 67 |
| … bytes written in the worst frame / largest single write | 18.9–22.7 MB / 4 MB | 8.0–10.8 MB / 2 MB |
| Play walk 25 s, long tasks count / worst | 5 / 70, 35 / 108, 41 / 132, 3 / 73 | 6 / 66, 1 / 62, 4 / 54, **0** |
| … frame-gap p95 | 33.3, 50, 50, 33.3 | 33.3 (all four) |
| … collision snapshot sync (last) | 3.1, 7.3, 11.2, 2.7 ms | 3.0, 2.7, 3.3, 2.7 ms |
| 60-tile street fly (120 s), long tasks / worst / gap max | 22 / 144 / 150 ms | 11 / 75 / 67 ms |
| … GC'd JS heap every 5 s | 1.81–2.65 GB, no trend | 1.66–2.88 GB, no trend (start 1.89, end 1.66) |
| … pool used | 216–1008 MB | 434–934 MB |

¹ One 166 ms gap caused by a 76 ms block in a 0-byte uniform writeBuffer (`BoundingBoxRenderUniformCache`, the 2D strategy). This is GPU-process backpressure while another client was using the GPU (other runs show the same stalls in unrelated tiny writes).

**Wrapped fly (P16 on vs the step-3b evidence).** writeBuffer worst 53–65 → 9–11 ms. `inst: alloc fit` 22 ms → gone. Group placement 23 → ≤ 8 ms. `evictMeshCaches` 10–11 → ≤ 2.6 ms. Remove group 20–64 → ≤ 11 ms. LOD stamp ≤ 3 ms (memo: 0.3 M hits / 9 k misses in a fly).

**Not met:** "zero long tasks > 50 ms in the fly". The fly has 2–11 a minute left (worst 53–79 ms), against 11–24 (worst 75–100) with P16 off. The frame-gap p95 target is met in the fly (16.8 ms, vsync). Play is CPU-bound at ~16–17 ms a frame anyway (p95 33.3 = alternate missed vsyncs, not hitches).

**Correctness.**
- **Unit tests:**
  - `stream-hitch.test.ts`: the real renderer on a recording device. Every drawn slot holds its owner's transform, every frame. Sliced packs draw a subset of the one-shot frame while catching up, then exactly the one-shot draws. Deferred eviction gives the same draws and the same geometry refs as eager eviction; a mid-queue re-attach never rebuilds the pool. The ledger arithmetic.
  - `instance-slot-allocator.test.ts`: every case in both forms; streamed batches (disjoint, every slot accounted); maximal free space; the switch mid-run.
  - `geom-upload-slices.test.ts`: ledger caps per frame / per write, every byte at its allocation; a compaction holds fresh geometry and every byte lands later.
  - `geom-compaction.test.ts`: coalesced plan = per-span plan, byte for byte, with fewer moves.
  - `collision-snapshot.test.ts`: survivors not re-read; an edited member re-read; answers = a rebuild.
  - `lod-stamp-memo.test.ts`: the memo stamps exactly what the scans stamp, including the city's lists and a fresh list.
- **Live GPU readback** (`slotcheck.js`, 2 × 17 checks across a 12-tile fly, P16 on): **0** bad mesh slots of 165 k, **0** bad group instances of 0.9 M, **0** bad geometry spans of 13 k. The same with P16 off.
  - The first version of the checker compared a readback taken frames earlier against the current slot maps and reported false "stale" slots. Its expectations are now captured in the same task as the copy submit.
- **Frozen clock** (`vis.js`). Cross-session shots of the same pose differ by as much between two P16-on sessions as between on and off (LOD-twin and crowd state differ per session), so that A/B cannot see P16. In-session, re-rendering one state gives 0–64 px.
  - A forced one-shot re-layout (every switch off, full repack, full pool rebuild) changes the picture by the same amount with P16 on or off (the twin hysteresis restarts). So pixel identity is argued from the slot / geometry readback above, not from screenshots.

### Open (not done)
- **Remaining fly long tasks** (wrapped runs):
  - draw lists + cull up to 20 ms and the cull-range build up to 15 ms in landing frames (step 4's area: renderer cull / draw-list code);
  - the GPU compaction's CPU (5–16 ms: loops over every mesh / key after the moves, not the copies);
  - tile worker-message deserialisation 13–15 ms;
  - writeBuffer blocks caused by GPU-process backpressure (tiny writes waiting 10–75 ms while the GPU is shared).
- New mesh slots are not budgeted, only group packs (`new slot writes` ≤ 5 ms a landing). It would need a hold for unslotted meshes in the draw-list build, which is step 4's code.
- The collision snapshot sync is still a walk over every mesh (~0.25 µs each now, 2.7–3.3 ms at 13 k). The next step is a structure-change delta or a sliced sync.
- `inst: pack deferral plan` re-sorts the waiting groups every deferred frame (≤ 3 ms with ~1 k waiting). It could keep the order.

## P17 — HLOD: merged distant tiles and the endless skyline (engine-roadmap step 5, 2026-10-03)

**Goal:** past the full-detail window, a streamed tile is a few merged meshes instead of a flat map, so the city reaches
the horizon at about the cost of today's flat ring. Docs for QA: docs/ui/performance.md §HLOD (distant buildings).

**As built.** Outside tiles `'hlod'` (`sm.world.setStreamOutsideTiles('hlod')`, `salsaWorld.streamOutside('hlod')`),
**the default since 2026-10-03** (`WorldManager.DEFAULT_OUTSIDE_TILES`; `'flat'` = the old default). Ortho / 2D views keep
Flat / Massing.
- `src/world/tile-hlod.ts`: MID (`"tx,tz|h"`: per-lot extruded shells in ≤ 5 wall + ≤ 3 roof colour buckets, archetype
  roofs, landmarks, merged ground; ~12 draws / ~2.5 MB / 33 ms main-thread build) and FAR (`"tx,tz|f"`: ground sheet +
  walls + roofs, 3 draws / ~0.65 MB / 8 ms). Built in the world worker (`TileBuildOptions.hlod`).
- `src/services/streaming/hlod-select.ts`: mid / far by eye distance with a 15 % band; past fog Far × 1.45 always far
  under the fog horizon. Settings `sm.world.setStreamHlod({ midTiles: 4, skylineTiles: 10, maxTiles: 160, fade: true,
  fadeMs: 450 })` (`salsaWorld.hlod({...})`).
- Tier swaps dissolve (flags2 bit 5, coverage in normalMatrix column 3 .y): the new tier fades in over the held old one,
  then the old one fades out (HLOD) or goes (full / flat). Since 2026-10-03 the dissolve also runs in the shadow pass
  (fs_shadow, shadow-map texels; a fading caster is a dynamic caster on both the CPU and the GPU-driven path) and the
  AO / SSR prepasses (prepassFadeKeep, the colour pass's pixel cells); the outline normal prepass scales its ink by the
  coverage (a dithered normal buffer would ink the dither pattern).
- Own byte-capped LRU (96 MB / 192 tiles). Stats: `hlodMid` / `hlodFar` / `hlodCached` / `hlodCacheMB` in
  `getStreamStats()`, `salsaWorld.hlodStats()`.

### The fly bugs (heap growth, far tiles draining away) — root causes and fixes

Driver: `pupdrive/hlod/fly.js` (rooftop, 2.2 above ground, 3×3 Full window, 1 tile/s, GC every 5 s, one row a second),
`leak.js` (Mesh3D census against the scene / LRUs / fades), `retainers.js` (retainer paths from a heap snapshot).

1. **The heap leak: the GPU-driven scene kept every removed mesh.** A 60-tile HLOD fly grew the GC'd heap linearly,
   875 → 2311 MB (+30 MB/s) while the live tiles, the LRUs and the pool stayed flat. A Mesh3D census found the excess as
   detached HLOD meshes (no parent group in the scene, not in an LRU / fade / the renderer maps): 158 MB at t = 10 s,
   525 MB at t = 20 s. Heap-snapshot retainer path (every tagged group):
   `sm.webgpuRenderer._renderer3D._gd._obj[i] → Mesh3D → .parent → MeshGroup3D`. `GpuDrivenMain` frees a record only
   in a full rebuild, and a removal never requested one: a streamed fly adds through orphan inserts and only removes,
   so the dead records (and their meshes, with the CPU geometry) piled up in `_obj` (15.5 k records with ~110 tiles
   live). **Fix:** `GpuDrivenMain.noteRemoved(m)` (called by `Renderer3D.evictMeshCachesDeferred` and
   `evictMeshCaches`) counts dead records and past `GpuDrivenMain.DEAD_REBUILD` (256) requests a deferrable rebuild
   (≥ 30 frames apart; dead records are not drawn meanwhile). All streamed modes leaked this way; HLOD the fastest
   (~1,400 tile builds a minute in the fly). Unit test: gpu-driven.test.ts "P17 leak fix" (+ a control without the
   trigger).
2. **Far tiles drained away (live 120 → 7).** Two starvations:
   - Main thread: an HLOD tile's one group reassembled at prio 3, behind every full-tile job (hundreds per tile,
     re-filled each second of a fly), and behind the sliced job (a full-tile group can hold the slice for up to 120
     frames while its upload drips in). The finished worker builds sat unassembled holding the cheap in-flight slots.
     **Fix:** HLOD groups are prio -1 and assemble one-shot even while a slice runs (~0.4 ms each;
     `WorldManager.HLOD_REASSEMBLY_FIRST`).
   - Workers: full builds keep n - 2 workers (P10.D6), so the cheap class had 2, while a rooftop fly asks for ~40 new
     HLOD tiles a second (the skyline's leading edge, the frustum's sides, the far → mid swaps). **Fix:**
     `CityStreamSource.hlodBoost`: under HLOD the cheap class may use every worker, and while more than 2 × its cap of
     cheap keys wait, the full class keeps two fewer slots (never under one; `StreamSource.fullCapFor`). In a fast fly
     those full builds are cancelled before they land anyway.
3. **Pool dead space after a swap.** The idle compaction is armed by the reconcile (350 ms), but a dissolved swap
   disposes the old tier ~450+ ms after the landing, so a swapped-out full window stayed in the pool as dead space
   (far pose: 952 MB used for 526 meshes). **Fix:** a fade-out disposal re-arms the compaction (→ 147 MB).

### Validation (headless Chrome, shared GPU; counts and CPU timings)

Flies at 1 tile/s, rooftop height, 3×3 Full window, seed 3. "Outside" = live outside tiles over the fly (the full window
never lands at this speed, in either mode); long tasks during the fly and during the landing of the 9 full tiles after it.

| Run | GC'd heap MB (fly) | Pool MB (fly) | Outside tiles min / median / max | Long tasks fly (n / max ms) | Landing (n / max ms) |
|---|---|---|---|---|---|
| flat, 60 tiles | 636–720 | 72–84 | 19 / 33 / 36 | 22 / 92 | 16 / 1033 (one GC-like stall) |
| HLOD before (the resume note's run) | 903 → 1966, growing | 20–137 | 0 / 91 / 111 (drains to 7) | 41 / 118 | 26 / 208 |
| HLOD, starvation fixed, leak not | 875 → 2311, growing | 114–136 | 74 / 106 / 111 | 26 / 93 | 27 / 160 |
| **HLOD, 60 tiles (all fixes)** | **723–783, flat** | 115–137 | 75 / 104 / 111 | 30 / 93 | 6 / 65 |
| **HLOD, 120 tiles (all fixes)** | **787–842, flat** | 112–137 | 56 / 102 / 111 | 26 / 91 | 15 / 102 |
| HLOD, 60 tiles, final build (+ the GPU-driven dynamic-caster bit, HLOD default) | 760–785, flat | 117–140 | 104 / 111 / 111 | 11 / 69 | 1 / 60 |

Worker build latency in the fly (dispatch → result, queue wait included): mid median 150–200 ms (p90 400–800), far
65 ms (p90 180–200); ~14 mid + ~34 far builds a second. Main pass during the fly: ~390 draws / 0.78 M triangles (flat:
54 / 0.07 M: the flat map is nearly free; the ~340 extra draws are ~14 % of a landed rooftop frame's ~2,400).

**Pose A/B, skyline 5 (≈ flat's tile set), 3-draw far level** (main pass, CPU-counted submission; resident tiles = the
window + outside):

| Pose | Flat | Massing | HLOD (skyline 5) | HLOD (skyline 10, default) |
|---|---|---|---|---|
| rooftop | 2344 draws / 3.81 M tris, 45 tiles, far 65 | 2225 / 3.99 M | 2308 / 4.27 M, 37 tiles (24 mid + 4 far), far 191 | 2482 / 4.66 M, 105 tiles (24 + 72), far 311 |
| sky | 884 / 1.41 M, 46 tiles | 1070 / 1.49 M | 1005 / 1.60 M, 40 tiles (22 + 9), far 217 | 1172 / 1.82 M, 114 tiles (22 + 83), far 337 |
| far | 471 / 0.38 M, 49 tiles (massing) | 471 / 0.38 M | **127 / 0.25 M**, 41 tiles (17 + 24) | 352 / 0.76 M, 123 tiles (17 + 106) |

At skyline 5 HLOD costs what flat costs (rooftop −2 % draws, +12 % triangles; sky +14 % / +13 %) with real buildings
instead of a flat map, and the zoomed-out view drops 73 % of the draws. The HLOD scan centres on the window's focus
tile (flat's on the look-at), so its outside set is a little smaller at the same radius (28 vs 36 at the rooftop).

**Visual checks** (`pupdrive/hlod/visual.js`): the mid → far dissolve as a frame sequence with `fadeMs` stretched to
2.4 s (`vis-dissolve-strip.png`): the old tier stays whole while the new one dithers in, then dithers out; no holes, no
pop. Hard edge + linear fog (Near 30 / Far 120) with the skyline at 16 tiles: the air view shows the fog-colour skyline
silhouette with a hard edge out to the horizon (`vis-fog120-air-hlod.png`); flat ends at 5 tiles on a bare horizon.

**Default:** switched to HLOD (items above clean: the heap and the pool flat over 60 and 120 tiles, the outside set
steady, no new long tasks, the dissolves and silhouettes right).

### Switches (A/B)
`WorldManager.DEFAULT_OUTSIDE_TILES` ('hlod'), `WorldManager.HLOD_REASSEMBLY_FIRST`, `CityStreamSource.hlodBoost`,
`GpuDrivenMain.DEAD_REBUILD` (2^30 = the old never-on-removal behaviour), `StreamManager.crossFade` (false = swaps pop),
`setStreamHlod({ fade: false })`.

### Left
- Browser check on a real GPU: the shadow / AO dissolve (CPU path counted: dynamic casters 402 → 515 while 204 meshes
  fade out; the GPU-driven path marks the records dynamic but its static shadow layer was not inspected).
- Old full / flat tiers do not dissolve (only HLOD tiers carry the coverage): they go when the HLOD tile is whole.
- At 1 tile/s the full window never lands (both modes); its 2–4 s builds are cancelled. A speed-aware window (build
  full tiles only once the camera slows) would save that worker time.
- The skyline impostor ring past the last tile (not built).
- The outside set still dips under the 1 tile/s fly (min 56 of ~110); a faster mid build (layout generation dominates)
  would close it.
- **Status 2026-10-03 (§P19):** the speed-aware window, the old-tier dissolves, the outside-set dip (fly min 115–121) and
  the impostor ring (off by default) are done.

## P18 — Temporal upscaling: TAA + TAAU (engine-roadmap step 6, 2026-10-03; docs/ui/performance.md §Temporal anti-aliasing and upscaling)

P6 found the GPU pixel-bound at 2.5 K (main pass 18–20 ms; half resolution cut it 2.7×). P18 renders the 3D scene at a
fraction of the canvas and rebuilds a sharp full-size image from jittered history (TAAU), or runs the same resolve at
native size instead of FXAA (TAA). API: `sm.setTemporalAA3D({ mode: 'off' | 'taa' | 'taau', scale, sharpen, retroOff,
inkOff })` / `getTemporalAA3D()`, a per-machine viewport preference (`localStorage['salsa.viewport.temporalAA']`).

### Architecture (`src/renderer/3d/temporal-aa.ts`; glue = the "Temporal AA" section of renderer-3d.ts)
- **Path:** the existing lo-res path (resolution scaling): `getLoResSize` returns the TAA size (full size for `taa`), so
  the full-size depth copy-up, the deferred overlay pass, FXAA placement and the focus-background restore all work
  unchanged. Host edits: `setTemporalFrame` per frame (`_applyResolutionScale`), `endLowResScene` after the lo-res
  pass ends (same encoder), and the settle loop.
- **Jitter:** `Camera3D.setProjectionJitter` (T(j) · P, both projections) set in `beginLowResRenderPass`, cleared in
  `endLowResScene`. Halton(2, 3), 16 samples (TAA) / 32 (TAAU). Everything recording in the scene window sees it (scene
  uniform, so the GPU-driven path too; SSAO / SSR / outline prepasses; particles; grease pencil). The resolve takes the
  jittered VP the scene actually used and un-jitters it exactly (`unjitterViewProj`).
- **Velocity (lo-res rg16float, cleared to "use the camera"):** a depth-tested pass (scene depth attached read-only,
  less-equal, pulled forward by a bias) over
  - movers: every slot the transforms fast path rewrites on a TAA frame records the matrix still in the CPU mirror
    (= the one the GPU showed last frame; `_taaNoteMove`, two one-line hooks in `_fastPathInstances`). Traffic,
    trains, walkers, rigid Play parts; pose-gated movers are right too (they really did jump);
  - skinned parts: previous skin matrices per skeleton (a CPU copy of the last upload → a prev buffer) + previous model.
  - Not tracked: instanced groups (they move only through a full repack, which also skips the movers that frame),
    wind sway (sub-pixel per frame), the PS1 wobble (retro looks force TAA off).
- **Resolve (full size, rgba16float history + r32float depth, ping-pong):** 3x3 lo-res neighbourhood at the jittered
  sample positions (Gaussian in output pixels; a bilinear tent for the no-history fallback), closest-depth dilation for
  velocity, camera reprojection from depth, Catmull-Rom history, one-sided disocclusion (history = nearest-sample view
  depth, expected = dilated depth; the first version stored the dilated depth and speckled every silhouette as the
  jittered 3x3 changed), YCoCg variance clip (γ 1.25 → 0.75 with motion, ×0.8 on object-velocity pixels),
  luminance-weighted blend (new-frame weight 0.07 TAA / 0.06 TAAU, +0.2 with motion, lower where no sample lands near
  the output pixel), premultiplied alpha (2D layers under the 3D stay clean). Camera cuts reset the history.
- **Blit:** the history into the main pass with a clamped 4-neighbour sharpen (default 0.3; never feeds back).
- **Dither fades:** mesh FS fog-band + HLOD dither use `fragPos + fhTaaShift(scene.cascadeParams.w)` (float 259, 0 =
  off, bit-identical); 16 frames visit all 16 Bayer offsets (inverse-Bayer order).
- **Settle:** 32 frames after the last requested frame (`WebGPURenderer.TAA_SETTLE_FRAMES`); any real request restarts it.
- **Exports:** `_fullResHold` / capture frames bypass TAA (`reason 'capture'`, FXAA stands in); a TAAU snapshot equals
  the native one (mean difference 0.01 / 255). **Device loss:** history on the rebuilt Renderer3D, setting on the
  WebGPURenderer, owner `'temporal-aa'` resets the settle state (verified: recovered, TAAU active, 0 errors).

### Quality (headless d3d11, seed-3 grid city; drivers `pupdrive/taa/`: smoke, dbg, motion, fade, look, snap, lost)
- **Stills** (`smoke-*.png`, crops `crop1.png` poles / sign, `crop3.png` wires, `crop4.png` sign text): TAA removes the
  stair-steps FXAA leaves on wires and pole silhouettes; TAAU 0.65 is close to native, slightly softer on small text.
  Mean difference vs native+FXAA: TAA 1.0 / 255, TAAU 1.4 / 255 (edges only).
- **Motion** (`mo-*.png` Play walk, `mo-s*.png` fast spin; `mo-seq.png` character crops): no ghost behind the character,
  cars or the tram; the velocity view (`debug = 4`) shows the character, walkers and vehicles; rejections (`debug = 2`)
  sit in disocclusion trails and the incoming screen edge only.
- **Dither fades** (`fade-crop.png`): the HLOD / fog-band screen door becomes a smooth fade; a faint residue is left in
  a still (the EMA ripple of the 16-step cycle).
- **Looks:** ink (Graphic preset) resolves cleanly and a little softer (`ink-crop.png`) → `inkOff` default false; PS1
  snap and PS1 lo-res report `'retro'`.
- **GPU validation errors:** 0 in every run.

### GPU timing (engine GpuFrameTimer = summed submit spans, paired rounds with rotating order, frozen Play pose, 2 frames
in flight; `pupdrive/taa/gt.js`). Medians; `d` = median paired difference vs native+FXAA. The GPU was shared with other
agents' browsers (`nvidia-smi` 31–99 % around the 2.5 K runs), so absolute 2.5 K medians are noisy; the paired deltas
were stable across the repeat.

| Canvas / world | native + FXAA | TAA | TAAU 0.65 | Res-scale 0.65 (no TAA) | d TAA | d TAAU |
|---|---|---|---|---|---|---|
| 1300 × 850 diorama | 6.2 | 6.4 | 4.2 | 4.1 | +0.2 | −2.0 |
| 1300 × 850 tiled 3×3 | 7.9 | 8.8 | 5.8 | 5.8 | +0.1 | −2.1 |
| 2500 × 1390 diorama (idle-ish run) | 15.1 | 16.2 | 9.8 | 9.0 | +0.7 | −5.5 |
| 2500 × 1390 diorama (repeat) | 17.4 | 18.1 | 10.7 | 9.9 | +0.4 | −6.8 |
| 2500 × 1390 tiled 3×3 | 20.3 | 20.8 | 13.5 | 12.3 | +1.3 | −6.8 |

TAA costs about the same as FXAA (+0.1–0.4 ms at 1300, +0.4–1.3 ms at 2.5 K: the full-size resolve and blit). TAAU 0.65
saves 2 ms at 1300 and 5.5–7 ms at 2.5 K, within ~1 ms of a plain 0.65 upscale while looking close to native.

### Default decision
**Off** until a browser pass on the user's real GPU and monitor (the drivers are headless). Recommendation after that:
**TAAU** for full-screen / Play (2.5 K: the frame drops from ~17 ms to ~10 ms, i.e. 60 fps), **TAA** as the quality
option at window sizes. Retro looks stay off automatically.

### Tests
`temporal-aa.test.ts` (settings, scale rules, Halton, the dither order, Camera3D jitter = T·P and its exact inverse,
`invert4`, camera cuts, the uniform layout, WGSL shape); `wgsl-static-check.test.ts` covers the four TAA shaders.

### Left
- A real-GPU browser pass, then switch the default.
- Wind sway / instanced-group motion vectors (only if foliage smears in a real pass).
- The faint dither residue in stills (a longer cycle or a lower static blend).
- Per-look defaults in the Frogmarks look presets.

## P19 — Streaming follow-ups: speed-aware window, old-tier dissolves, ring, landing hitches (2026-10-03; docs/ui/performance.md §Streaming at speed)

**Goal** (the P17 / P16 leftovers, roadmap steps 3c and 5): a window that does not waste full builds at speed and still
lands in Play; old full / flat tiers dissolve; no dip in the outside set; an optional impostor ring; fewer landing
hitches. Built in two sessions (the first was cut off mid-edit; this section covers both).

### As built (each an A/B switch: `sm.world.setStreamMotion(switches?, options?)`, `salsaWorld.stream19(...)`, all on)
- **`motionWindow`** (`src/services/streaming/motion-window.ts` `FocusMotion`, `predictedWindowTiles`). A smoothed velocity
  of the window focus (the eye, or the player in Play; τ 250 ms; a jump > 2 tiles, > 25 tiles/s or a > 1 s gap restarts
  it). The window centres on the focus + velocity × 3 s (≤ 1 tile); the tile under the focus stays in; window tiles and
  the HLOD outside tiles queue nearest to the predicted point first, so trailing tiles leave (and are cancelled) earlier.
- **`fastWindow`**. At ≥ `fastTiles` (0.75 tiles/s; left after 150 ms under 0.4) no new full builds: window tiles not
  already full take their stand-in (HLOD mid, or flat / massing). `fast: 'landing'` keeps one full tile at the focus +
  velocity × 3 s instead.
- **`cappedWindow`** (second session). The adaptive keep-up speed `keepUpTiles(latency, lead, radius)` = (radius − 0.12 +
  lead) / the smoothed full-tile latency (dispatch → reassembled, `_noteFullLatency`). Between it and `fastTiles` the
  state is **capped**: only a CORRIDOR builds full (`corridorTiles`): the tile under the focus, then the tiles the path
  crosses out to speed × latency × 1.25 + 0.75 tiles (≤ `capAheadTiles` 4, ≤ `capTiles` 4 tiles). Already-full window
  tiles stay full; the rest show stand-ins. The first session's version put this band into the fast state (all
  stand-ins: the player ran on HLOD tiles); `cappedWindow: false` restores that.
- **`standInFirst`** (second session). While moving, a window tile with nothing on screen (not live, not held, not in
  flight: `StreamManager.shownChunks` / `isInflight`) asks for its stand-in first; the next reconcile asks for the full
  tile over it. This removes the stream's synchronous flat preview of the predicted window's leading row (the first
  session's 0.5 tile/s fly showed 3 × 37–72 ms `sync tile build (main thread)` tasks; now 0).
- **`dissolveOldTiers`**. A replaced full / flat / massing / preview tier dissolves out with the HLOD dither (flags2 bit 5;
  colour, shadow and prepasses as in P17) in `OLD_TIER_FADE_STEPS` (4) coverage steps (`oldTierFadeLevel`; each step is a
  material rewrite of the tile's meshes). Array-group sources stay whole until the tier goes (a group repack per step
  would cost more than the fade).
- **`messageParts`** (`world-jobs.ts` `postGroupParts` / `resolveGeoRefs`). A full tile comes back one group per worker
  message (shared geometry by reference), so the main thread deserialises it in pieces.
- **`WorkerJobService.respawnRecycled`** (second session; a static, not part of `stream19`). A cancelled full build's
  worker is terminated (P10.D6). It was respawned only when a job queued service-side, but the stream sizes its
  dispatch to the LIVE worker count, so every recycle shrank the lane for good. A Play run drained it 8 → 0; the pool
  then reported unavailable and the stream fell back to a **3.4 s main-thread full-tile build** (and a 1.9 s one in the
  landing). The worker is now replaced at once.
- **Skyline impostor ring** (`src/world/skyline-ring.ts`, `setStreamHlod({ ring: true, ringDepth: 5 })`): a band of
  hashed, world-anchored boxes past the HLOD skyline, 4 draws (~30 k triangles), built in the world worker around the
  focus tile. **Off by default**: with the default fog it sits inside the haze, and the shots with and without it look
  the same (`pupdrive/stream3/ring-*.png`, air / rooftop / high, default and Hard-edge fog). Cost +4 draws, +27 k
  triangles; 16.6 ms if built on the main thread (the no-worker fallback).
- Diagnostics: `sm.world.getStreamMotionStats()` → `{ speed, state: 'slow' | 'capped' | 'fast', lead, standIns, fastAt,
  capAt, corridor, fullLatencyS }`.

### Results (headless d3d11 1300 × 850, seed 3, 3×3 Full window, HLOD outside; OFF = `stream19(false)`, same build, interleaved)
Drivers: `pupdrive/stream3/fly.js` + `batch2.sh` (rooftop fly / Play run), `pupdrive/hitch2/tasks.js` (task attribution).
"Outside" = live outside tiles during the fly (min / median). "Wasted" = full builds dispatched but cancelled or
discarded (and their worker-seconds). Landing = the time for the 9 full tiles after the run stops. `respawnRecycled` is
on in both columns.

| Run | Long tasks n / max ms | Frame gap p95 ms | Outside min / median | Wasted full builds | Landing s (long tasks) | GC'd heap MB / pool MB |
|---|---|---|---|---|---|---|
| 60 tiles, 1 tile/s OFF | 37 / 153 | 33.1 | 48 / 103 | 106 of 115 (195 s) | 14.4 (14 / 95) | 765–1918 / 115–1157 |
| 60 tiles, 1 tile/s ON | **12 / 77** | **19.6** | **115 / 131** | **3 of 12 (0.9 s)** | 10.0 (4 / 60) | 758–1486 / 121–1162 |
| 60 tiles, 2 tiles/s OFF | 30 / 215 | 39.1 | 5 / 19 | 59 of 68 (61 s) | 19.4 (24 / 126) | 726–2085 / 38–1159 |
| 60 tiles, 2 tiles/s ON | **5 / 79** | **20.9** | **121 / 130** | **3 of 12 (0.3 s)** | 10.2 (3 / 66) | 749–2053 / 132–1158 |
| 120 tiles, 1 tile/s OFF | 70 / 144 (one 2.95 s gap) | 31.3 | 30 / 97 | 199 of 208 (358 s) | 18.0 (28 / 145) | 703–1882 / 115–1133 |
| 120 tiles, 1 tile/s ON | **13 / 83** | **21.1** | **115 / 131** | **3 of 12 (0.8 s)** | 21.6 (64 / 193) | 788–1862 / 121–1134 |
| 120 tiles, 2 tiles/s OFF | 9 / 94 | 23.0 | 33 / 84 | 171 of 180 (148 s) | 10.4 (3 / 67) | 729–1871 / 110–1133 |
| 120 tiles, 2 tiles/s ON | **2 / 64** | **19.6** | **120 / 130** | **3 of 12 (0.3 s)** | 11.0 (3 / 61) | 771–1998 / 133–1114 |

The heap and pool maxima are the landed full window after the fly; during the fly both stay flat. The first session's
matrix (same driver, before `cappedWindow` / `standInFirst` / the respawn fix) gave the same fly picture (ON long tasks
3–9, wasted 3, outside min 115–122; OFF min 11–91).

**Play run** (third person, run speed × 20 ≈ 0.35 tiles/s, straight for 40 s). "Own" / "ahead" = the fraction of
seconds the tile under the player / the next tile is full:

| Play run | Own / ahead full | Long tasks n / max | Frame gap p95 | Wasted full | Outside min / median | Landing |
|---|---|---|---|---|---|---|
| OFF (the P10.D window) | 0.09 / 0.00 | 147 / 214 | 88.1 | 15 of 39 (92 s) | 89 / 118 | 8.2 s |
| first-session P19 (`cappedWindow: false`: the band is fast) | 0.05 / 0.00 | 35 / 125 | 20.2 | 1 of 10 | 133 / 140 | 11.8 s |
| **ON (capped corridor)** | **0.88 / 0.58** | 176 / 258 | 99.6 | 22 of 43 (12 s) | 112 / 134 | 6.6 s |
| ON before the respawn fix | 0.94 / 0.84 | 197 / **3609** | 142 | 15 of 26 | 16 / 133 | 11.5 s (a 1.9 s task) |

Without P19 the window never lands during a run. The reassembly queue sits at 500–1,300 jobs: the full tiles arrive from
the workers, but the sliced reassembly and the upload ledger cannot place ~1 tile/s of ~120 MB tiles, so tiles leave
before they are whole. The first session's adaptive threshold made Play worse (all stand-ins). The corridor asks for
about one tile per crossing, early enough, and the player's tile is full ~90 % of the run. The long tasks are the cost
of actually landing full tiles in Play (the OFF run's full tiles land too, behind the player); the stand-ins-only run is
the cheap end.

**Task attribution** (`hitch2/tasks.js`, NOINST). 30-tile street fly at 0.5 tiles/s: OFF 12 / 82 ms, ON 15 / 68 ms,
frame-gap p95 16.8 ms in both. ON has no `sync tile build` tasks (the first session's ON run had 3, 37–72 ms) and its
worker-message tasks are ≤ 6.9 ms (OFF 13.9). Play walk 25 s (slow): OFF 28 / 97, ON 44 / 75, gap p95 50 in both. This
walk is noisy run to run (the first session measured 6 / 65 vs 95 / 110; its idle-pose runs had 8–126 long tasks either
way).

### Tests
- `motion-window.test.ts`: velocity, lead and teleports; the fast hysteresis; the adaptive capped band (enter, hold,
  fast, back to capped, slow; adaptive off = no band); `corridorTiles` (own first, path order, reach, caps, diagonal, and
  a walk showing every tile joins at least latency × margin before the focus reaches it); predicted window order; the
  fast tier rule; old-tier dissolve levels.
- `world-stream-motion.test.ts` (WorldManager with a recording scene): still = the P10.D window; prediction; 1×1; fast
  stand-ins; landing; parked centre; **capped corridor** (full keys = the corridor in path order, already-full kept,
  switch off = stand-ins, adaptive off = the full window); **standInFirst** (stand-in first; full once shown or in flight;
  switch off or still = full); cancellation of in-flight full builds; the old-tier dissolve bookkeeping.
- `worker-job-service.test.ts`: a terminateOnCancel cancel keeps the live count (switch off: drains to 0, still serves).
- `job-parts.test.ts`, `skyline-ring.test.ts` (first session).

### Left
- **Landing throughput.** After a fly the 9 full tiles take 10–22 s to land (up to 64 long tasks, max 193 ms, in the
  120-tile run): the sliced reassembly (3–6 ms a frame, one group at a time, each waiting a frame for its warm) and the
  8 MB write ledger, for ~120 MB per full tile. The same limit is why Play still shows ~150–180 long tasks while tiles
  land. Lighter full tiles or concurrent slices would help.
- **Compaction bookkeeping** (5–16 ms CPU; 6–7 compactions in a 60 s fly, 13–14 with P19 off) and the **unbudgeted new
  mesh-slot writes**: both live in `renderer-3d.ts` (being edited by the GPU-shadow work; step-4 code). Not changed.
- **Deserialisation:** parts cap a message at one group; a single huge group (an 18 MB crowd layer) is still one message.
- The capped corridor wastes about half its full builds in Play (22 of 43: the run speed jitters 0.2–0.36 tiles/s with
  the frame rate, which moves the reach). Worker time is still 12 s vs 92 s OFF.
- A browser / real-GPU check of the dissolves and the ring.

## P20 — Lighter tiles: instanced props, lighter landing (2026-10-04; docs/ui/performance.md §Lighter tiles: instanced props)

**Goal** (the P19 "Left" list + P10.1): a full tile was 134–145 MB of geometry; a 9-tile window took 10–22 s to land
after a fly (up to 64 long tasks, max ~193 ms); one huge group was one worker message; the pool compaction's
bookkeeping (5–16 ms) and the new mesh-slot writes were unbudgeted. Targets: a tile ≤ ~40 MB, landing ≤ 5 s, no long
task > 50 ms while landing, fewer Play hitches. Drivers: `pupdrive/slim/` (`land3.js` teleport landings with a per-tile
dispatch / worker / reassembly timeline, `fly.js` = stream3's fly / Play run, `tasks.js` = hitch2's task attribution,
`vis.js` + `probe.js` + `crop.js` frozen-clock A/B, `comp.js` compaction CPU, `prof.js` / `probe2.js` frame profiles,
`an.js` / `famcmp.js` per-family bytes; `batch.sh` = the final interleaved matrix).

### 1. Where the bytes are (full tile (1, 0), seed 3; geometry bytes = vertices + indices, each geometry once)

Measured on the worker's output (`buildTileLayerGroups`): **142.5 MB = 122.6 MB vertices (48 B a vertex: pos, normal,
uv and a constant tangent) + 19.9 MB indices**, ~1,060 layers. By group: Streets 52.7, Furniture 47.1, Signals 15.6,
Biome 9.3, Road Paint 6.0, Layout 5.1, Railway 3.3, Water 1.8, Pedestrians 1.4 MB. The top families were nearly all
REPEATED PROPS baked into tile-wide merged layers, each twice (the P9 near and far twins):

| Family (layer) | Before MB | After MB | What it is |
|---|---|---|---|
| detail-roof-equip | 13.66 | 3.63 | roof railing posts, tank legs, plant (fixed-size boxes repeated thousands of times) |
| signal-housing | 13.43 | 3.91 | signal heads: pole, mast arm, housing, visors, ped head |
| car-trim | 9.59 | 6.48 | parked cars' tyres / wheels (instanced) + body trim (stays baked) |
| util-pole | 8.93 | 0.17 | concrete utility poles |
| detail-railing-steel | 5.09 | 5.09 | facade railings (sized per facade — not instanced) |
| util-pole-insulator | 4.45 | 0.09 | insulators + transformer cans |
| util-wire | 4.20 | 4.20 | catenaries (unique) |
| lightpoles | 3.90 | 0.80 | street lamps (post / arm / bell) |
| tactile, roadpaint, storefront, lightbox frames, trim, sign text / ink, duct, door, car bodies … | ~45 | ~45 | per-facade / per-road geometry (unique) |
| vending trim / chrome / buttons, bollards, cabinets, frosted panels | 7.3 | 0.7 | street furniture |
| **Tile total** | **142.5** | **95.6** | (five tiles: 134–145 → 90–96 MB, −33 %) |

### 2. What changed (each an A/B switch; `sm.world.setLighterTiles(on | {…})`, console `salsaWorld.p20(…)`, all on)

1. **Instanced props** (`propInstancing`; `src/world/prop-instancing.ts`). The builders only MARK their repeated props:
   `Accum3D.beginPart(origin, forward) / endPart / nextPart` (furniture poles, parked-car trim, vending, benches,
   bollards, cabinets, post boxes; signal heads and lamp posts as several parts — the full-tier drape lifts what stands
   on the pavement by the kerb and not what hangs over the road; wheels own parts) and `Accum3D.autoParts` (every
   obox / prism / beam of the roof plant and frosted panels). Recording happens only inside a streamed tile build
   (`setPartRecording`); every other build is byte-identical. Each part's vertices are also recorded in DOUBLE precision
   in the part's own frame, so identical props quantise (1/65536 unit) to identical canonical bytes in every tile.
   After the drape, each part's transform is FITTED to its own draped vertices (a ridge least-squares affine for the
   positions, a separate linear map for the normals: the height drape tilts normals, the warp does not) and the part is
   instanced only when every vertex lands within **1 mm** of its baked position and every normal within 0.02; a variant
   needs ≥ 4 copies and ≥ 96 KB saved (one more array group costs a draw + a per-frame group visit). Near / far twins
   pair part by part (both groups hold the same transforms → the same twin decision). What stays baked keeps its
   ORIGINAL bounds (twin / LOD decisions unchanged) and procedural-ground layers keep their uv scale (a one-triangle
   `groundUvSample`). Contact blobs are built before the pass, from the baked props (bit-identical). Per tile: ~10.4 k
   copies in ~60 variants (~120 array groups incl. far twins).
   - Copies travel as ONE typed array per layer (`LayoutPreviewLayer.propXf`, 21 floats a copy: translation, model 3×3,
     normal 3×3) → `ArrayGroup3D.instanceXf`; the renderer's group pack reads it directly (no per-copy objects anywhere;
     the reassembly never slices it: one variant = one group). The source is a never-drawn phantom with the layer's
     whole look (`Scene3DManager._addPropArrayInstances`: metal, ground, neon, pattern, glass … via `_makeFlatMesh`),
     `castsInstancedShadow` (copies cast and feed the outline prepass like the baked mesh).
   - Cross-tile sharing (`internProps`): the canonical's content hash is its `instanceKey` (`p20:…`), so all tiles' copies
     share ONE GPU allocation, and the main thread keeps one JS geometry per key.
2. **Memoised drape** (`drapeMemo`; `src/world/drape-memo.ts`): the tile drape evaluates the height field, its gradient
   and the warp once per distinct vertex (x, z) of a layer (exact table keyed by the f32 bits; a box's 24 vertices sit
   on 8 corners). Bit-identical output (test); the tile build −10 to −25 %.
3. **Split messages** (`splitParts`; `world-jobs.ts splitLayers`): with P19 messageParts, a group is posted as parts of
   ≤ 48 layers / 6 MB (World Streets / Furniture were one ~300-layer, 40–50 MB message each); merged back main-side in
   `resolveGeoRefs`. The job now reports its PART count (`jobParts(n)`). (The 18 MB crowd layer of the P19 note is the
   baked crowd; with P12's instanced crowd no layer of that size is left.)
4. **Worker slot on worker done** (`slotOnWorkerDone`; `StreamSource.holdsWorker`): an in-flight full tile stops
   counting against the full-class cap when its worker result arrives (its main-thread reassembly no longer holds a
   worker idle). The window's second wave starts ~2–3 s earlier (9 tiles over 6 full-class slots = two waves).
5. **Budgeted new mesh slots** (`budgetNewSlots`; `WorldManager.NEW_SLOTS_PER_FRAME` = 600): the sliced reassembly
   attaches at most 600 new meshes a frame (the renderer writes each new mesh's instance slot the next frame); the first
   group of a frame always attaches. A world-side budget: the renderer's draw-list / GPU-record code (step-4 code, being
   edited elsewhere) is untouched — no mesh is ever drawn without its slot.
6. **Cheap compaction bookkeeping** (`cheapCompaction`, renderer side: `lighter-tiles.ts P20_RENDER`;
   `Renderer3D._compactBookkeepingP20`): after the GPU moves, the meshes of moved keys are re-pointed at NEW alloc objects
   (the GPU-driven records key on alloc identity), dead keys and off-list meshes are dropped, only unmapped meshes are
   added — instead of clearing and rebuilding all five per-mesh maps. Same end state (test: allocs, refs, residency,
   bytes).

**Not done (and why).**
- **A smaller vertex format** (quantised normals, no constant tangent: 48 → 32 B, −33 % of every remaining byte). The
  pool has ONE 48-byte vertex layout shared by every pipeline (main, shadow, prepasses, outline, highlight, TAA,
  GPU-driven, skinned overrides) and the CPU picker / BVH / collision cells read the 12-float CPU arrays; a packed GPU
  format means an upload-time pack + a second layout for every pipeline — the pipeline / shader code the shader-variant
  work owns this session. It is the next lever for bytes (it would take the tile to ~65 MB).
- **16-bit indices**: one 32-bit index buffer serves every draw (and the GPU-driven indirect draws); indices are 14 %
  of a tile now.
- **Car bodies and the rest of car trim** stay baked: a parked car's per-vertex drape bends it over the terrain by up to
  ~2 cm along its length, over the 1 mm tolerance, and the bodies are Play collision geometry (instanced copies are not
  collision geometry — like the trees, vending shells, bins and crates before them). Signal / lamp arms that cross the
  kerb line stay baked for the same reason (the kerb step tears them).
- **Per-facade building detail** (railings, storefronts, frames, doors, trim, signs; ~25 MB) is sized per facade: no
  repetition to share.
- **Instanced groups have no cull ranges**: a baked layer drew only its in-view 256-triangle runs; a variant group draws
  all its copies when any is in view (`vis.js` main pass: street pose 5,448 draws / 9.4 M tris vs 4,913 / 7.0 M OFF, high
  pose 1,043 / 3.6 M vs 688 / 1.5 M — vertex work; frame CPU 20.1 vs 19.3 ms at the low pose). Per-copy culling (or
  chunked variant groups) is the follow-up.

### 3. Results (headless d3d11 1300 × 850, seed 3, 3×3 Full window, HLOD outside; OFF = `p20(false)` before the tiles
build, same build, interleaved; CPU timings and counts — the GPU is shared)

| Run | OFF | ON |
|---|---|---|
| Full tile (five tiles, worker output) | 134–145 MB | **90–96 MB** |
| Tile build in the worker (node, one at a time, 4 reps) | 1.6–2.2 s | 1.8–2.3 s (instancing pass ≈ +0.4 s, memoised drape ≈ −0.2 s) |
| Teleport landing, 9 new full tiles (2 runs × 3 jumps) | 10.5 / 10.0 / 9.2, 11.0 / 9.6 / 9.2 s | **9.0 / 8.0 / 7.6, 8.0 / 7.2 / 6.4 s** |
| … long tasks during the landing (n / max ms) | 3–12 / 59–100 | 1–13 / 81–136 |
| 60-tile fly at 1 tile/s: landing after the fly | 11.3 s (10 / 85 ms) | **9.0 s (6 / 67 ms)** |
| 60-tile fly at 2 tiles/s: landing after the fly | 12.7 s (13 / 92 ms) | **9.1 s (2 / 65 ms)** |
| … long tasks during the fly (1 / 2 tiles/s) | 9 / 104, 9 / 140 | 8 / 108, 8 / 104 |
| Pool with the window landed (MB used) | 1167 | 1059 |
| Play run 40 s (capped corridor): long tasks n / max | 131 / 172 | 130 / 162 |
| … frame-gap p95 / own / ahead full / pool max / GC'd heap | 78.8 ms / 1.0 / 0.51 / 1203 MB / 2.72–3.49 GB | **65.9 ms** / 0.89 / **0.75** / **812 MB** / **2.27–3.16 GB** |
| Play walk 25 s (`tasks.js`): long tasks n / max | 61 / 119 | **51 / 106** |
| 30-tile street fly (`tasks.js`): long tasks n / max | 21 / 85 | 23 / 126 |
| GPU pool compaction CPU (`comp.js`, landed window after a 4-tile fly, 11.6 k meshes, 913 MB live; median of 4) | 21.6 ms | 20.5 ms (noise: 13.7–21.3 vs 17.3–22.3) |

Teleport-landing timeline (`land3.js`, ON): four full builds dispatch at once and two more ~0.7 s later (the other
three wait for a slot); worker builds take 2.9–3.9 s while six run in parallel (vs ~1.8 s alone); with `slotOnWorkerDone` the last
three dispatch at ~2.9–3.6 s (OFF: after the first wave's reassembly, ~5.7–6.3 s); each tile's reassembly after its
worker result is 1.5–2.1 s. The landing is now worker-bound: **two waves of 2.5–4 s builds**, so the 5 s target needs
faster tile builds (or a smaller window), not lighter uploads alone.

**Compaction bookkeeping**: the cheap path is the same end state but does not measurably shorten a compaction on the
landed window (median 20.5 vs 21.6 ms, inside the run-to-run noise): at 11.6 k meshes the time is in planning the moves
over every live key and the per-mesh visit, not in rebuilding the maps. Kept on (equivalent, tested); the real lever is
compacting less often or incrementally.

**Visual A/B** (`vis.js`, frozen clock, five poses, ON vs OFF vs ON again): the diorama is 0 px different at every pose.
Tiled: the street pose is at the ON-vs-ON noise floor; back / low / high showed 1.4 k / 5.8 k / 6.7 k differing px. The
low-pose cluster was traced to a PRE-EXISTING bug, not to instancing: city trees were keyed
`tree:kind:variant:layer`, but each streamed tile generates its variants from its own seed, so different tiles' DIFFERENT
tree meshes shared one key and the GPU pool (which shares geometry by `instanceKey`) drew whichever tile uploaded first
— P20 changed the upload order, so the trees changed shape. Fixed: tree keys (near and far crowns) now end in a content
hash of the geometry (`city-foliage.ts geoKey`; identical variants still share; test in `city-foliage.test.ts`). The
planter vessels were already seed-keyed. After the fix (tiled, differing px ON vs OFF / ON vs ON again): street 35.1 k / 32.9 k (> 8/255: 51 / 16), street2
42.9 k / 42.6 k (71 / 12), back 675 / 0, low 974 / 0, high 629 / 2 — the low pose fell from 5.8 k (1.7 k > 32/255) to
974 (7 > 32/255); what is left is sub-pixel edges of thin poles and shadow filtering.

**Not met:** a tile ≤ ~40 MB (95 MB; the vertex format is the next lever), landing ≤ 5 s (6.4–9.1 s), no long task
> 50 ms while landing (max 65–136 ms: instance uploads of a landing tile's big groups and GC). The Play run's long
tasks are unchanged (~130: P19's capped corridor lands tiles under the player all the time; frame-gap p95 improved).

### Tests
- `src/world/prop-instancing.test.ts`: the per-tile byte budget (< 115 MB, ≥ 30 MB lighter than baked); **instance
  output equivalence** — every triangle of the instanced build (leftovers + every copy expanded through its 3×3s) has a
  baked twin within the tolerances, triangle for triangle, and the counts match; copies keep the layer look (phantom
  source, typed `propXf`, no part bookkeeping left); content-keyed variants (two tiles share the canonical bytes);
  determinism; part recording off = byte-identical geometry.
- `src/world/drape-memo.test.ts`: the exact memo through resets; memoised height / gradient / warp = direct; a whole
  tile drapes to the same bytes.
- `src/renderer/3d/prop-instances.test.ts`: the real renderer on a recording device — each copy's slot holds its own
  model 3×3, translation and normal matrix (per-copy overrides and the typed `instanceXf`), the phantom source never
  draws.
- `src/renderer/3d/geom-compaction-p20.test.ts`: cheap vs full compaction bookkeeping — same allocs, refs, residency,
  every byte at its allocation, new alloc objects for moved keys.
- `src/services/workers/job-parts.test.ts` (+2): **message split reassembly** (big groups in parts, merged back layer
  for layer, shared geometry restored across parts; the job service resolves with the part count).
- `src/services/streaming/stream-manager.test.ts` (+1): `holdsWorker` frees the slot (and the A/B).
- `src/services/managers/world-sliced-reassembly.test.ts` (+1): `budgetNewSlots` attaches ≤ the budget a frame, same result.
- `src/renderer/3d/upload-on-demand.test.ts`: under on-demand rendering a mesh added to an idle, busy-pool scene (big
  sliced, tiny "character", and across a compaction) finishes uploading through `onDeferredWork` alone.
- `src/world/city-foliage.test.ts` (+1): one instanceKey names one geometry across seeds (the tree-key fix).
- `src/world/tile-build.test.ts`: the contact-blob test reads its expected count from the baked build (the blobs are
  built before instancing and are bit-identical — asserted).

## P21 — Specialised shader variants (engine-roadmap step 8, 2026-10-04; docs/ui/performance.md §Shader variants)

The main mesh fragment shader is one uber-shader that tests the 32 material flag bits per instance. Every pixel pays
the registers and code of every feature (P15 found the full shader alone cost plain meshes +5–7 ms). Step 8 compiles
**variants with the flags as compile-time constants** for the feature families that cover most pixels, keeps the
uber-shader for everything else, and routes each mesh to its variant only when its instance flags EQUAL the constant.

Drivers: scratchpad `pupdrive/variants/` (`lib.js` boot / worlds / poses on a private no-HMR vite at 5237,
`cover2.js` + `covsum.py` coverage, `vis.js` + `viscmp.py` identity, `ab.js` + `absum.js` paired timing, `compile.js`
compile cost, `bisect.js` per-key identity).

### Coverage (which flag values shade the pixels)
`cover2.js` patches the mesh fragment shaders in its own page to write the instance's 32 flag bits as the colour and
reads back the main colour target (before post), binning pixels by flags (only values present in the instance buffer
count, so sky / background drop out). Seed-3 grid city, PBR look, 1300×850; share of the covered pixels summed over
street, rooftop, sky, far and Play:

| Flags (family) | Diorama | Tiled 3×3 |
|---|---|---|
| procedural ground (`groundShade`) | 27.5 % | 31.9 % |
| roof grid pattern (patMode 5) | 11.8 % | 21.2 % |
| window facades (patMode 6) | 24.4 % | 13.4 % |
| painted metal | 8.0 % | 9.2 % |
| glass (`glassEnhance`) | 9.1 % | 8.5 % |
| plain PBR (no feature bit) | 6.5 % | 5.9 % |
| window facades + glass | 6.0 % | 5.7 % |
| stripes / dots / checker / waves | 5.2 % | 1.9 % |
| tree crowns (cel + rim + leaf card + wind + foliage), bushes, wind props | 1.2 % | 1.5 % |
| water, textured (GARP props) | 0.4 % | 0.8 % |

Per pose: Play is half ground (49–52 %); rooftop / sky are the grid roofs and the window facades. The top 8 values
cover 93–96 % of the pixels; 17 distinct values in the whole city. Characters (skinned) are a few % in Play only.

### As built (`src/renderer/3d/shader-variants.ts`; small glue in `pipeline-3d.ts` and `renderer-3d.ts`)
- **Key** = the exact 32-bit flags value, when its FEATURE FAMILY (flags minus the look modifiers: render style, rim,
  matte, soft lighting, skin ramp, toon, retro colour) is one of `VARIANT_FAMILIES` (the coverage list above: plain,
  ground, the six patterns, windows + glass, glass, metal, the three foliage / wind families, water, neon; untextured
  only). Anything else (textured, normal maps, sparkle, board, triplanar, combinations) stays on the uber-shader.
- **WGSL**: `specialiseMeshFragment(src, flags, fastPaths)` replaces the one line
  `let flags = bitcast<u32>(inst.emissiveColor.a);` with `const flags = <key>u;` (and, while
  `Renderer3D.shaderFastPaths` is on, `p8Fast` with `true`). Every flag test folds to a constant and the compiler strips
  the dead features. It WRAPS the 8 exported fragment strings (plain / full × textured / untextured × shadow), so other
  edits to `mesh3d-shaders.ts` apply to the variants unchanged; it throws if the flags line is not found exactly once.
  flags2 (normalMatrix column 3 .x) stays dynamic: array copies take it from their source only at a group repack.
- **Identity by construction**: the CPU path reads the key back from the instance slot right after the slot is written
  (`_writeGroundUvScale`, float 43 as a u32; multi-material meshes never get one) and a batched group never mixes keys;
  the GPU-driven state code carries the variant id (bits 5+, from the material: it runs before the frame's slot writes),
  so a bucket is one exact flags value.
- **Draw order**: `Renderer3D.rankVariants` (on) adds the variant id to the rank's pipeline class whether variants are
  on or not. The first version keyed the rank only while variants were on and moved coplanar draws (27 px of kerb /
  paint z-order at the diorama street); with the id always in the rank the A/B never changes the order. Buckets
  405 → 413 (tiled), 196 → 204 (diorama).
- **Compile**: `Pipeline3D.variantPipeline(base, key, fast)` registers the handle on first sight and queues a background
  compile at `VARIANT_PRIORITY` (COMMON + 0.5: after the common set, before the rare). Until it is ready the base
  (uber) pipeline draws, so there is never a skipped draw, a "waiting" draw or a blocking compile (a capture outside a
  live frame also uses the base). The GPU path's bundle re-records when a variant lands (`gdBucketsChanged`).
- **Ids** (`ShaderVariantIds`): dense ids per key, capped at 128 (17 keys per look in the city; each look switch adds
  its own set: base + Cel + Cel-HD + ink + toon = 64 keys in the identity run).

### Identity (frozen clock, ON / OFF / ON2 = variants on (every requested variant compiled first) / off / on again)
`vis.js`, seed-3 city, 1300×850, CPU path (GPU culling off) and GPU-driven path, every pose:
- **Diorama**, street / rooftop / sky / far / Play × PBR, Cel, Cel-HD + ink outlines, ink, toon (the Toon Town look),
  PS1 (400×240 lo-res, 32-level colour depth + dither), night, fog horizon (Hard edge, Buildings only, 15 m fade band):
  **80 / 80 pairs 0 px**, no GPU errors, 65 variants compiled, 0 failed.
- **TAA** (diorama street / sky / Play; tiled street / Play): 10 / 10 pairs 0 px. (The first run differed in every
  pair, ON2 vs OFF too: the jitter phase and history carried over between shots. The driver now resets both per shot.)
- **Tiled 3×3**, street / sky / Play × PBR, Cel-HD + ink, toon, night, fog horizon, PS1 (+ TAA above): 0 px in every
  pair once the driver takes a settle shot after each look switch. Without it, 3 pairs showed 5–7 k px on crowd
  people in the CPU path; that was the look switch still settling: the first shot after the switch differed from the
  second with variants ON in both (ON0 vs ON: 4.6–6.9 k px), and ON / OFF / ON2 after it are 0 px.
- **HLOD dissolve** (every third mesh at `hlodFade` 0.5) and **SSAO**, diorama street / rooftop / Play, both paths:
  12 / 12 pairs 0 px. (flags2, which carries the fades, is not specialised.)
- The driver also waits for `waitingDraws === 0` before an OFF shot: with variants on, the base pipelines of the
  variant meshes are not requested by draws and may still be in the background warm when variants are switched off.
- Total: 174 frozen-clock pairs, all 0 px; no GPU errors in any run.

### Compile cost (`compile.js`: one createRenderPipelineAsync at a time, a nonce defeats Dawn's cache; headless d3d11, median of 3)
| Fragment shader | Compile |
|---|---|
| uber, full (untextured, shadow-receiving) | 2.38 s |
| uber, plain | 1.87 s |
| variant: ground | 1.63 s |
| variant: window facade / roof grid / metal | 1.00 / 0.84 / 0.79 s |
| variant: glass / plain / tree crown | 0.72 / 0.73 / 0.71 s |

A city look needs 17–18 variant pipelines (one cull / shadow base each): ~15 s of compile in total, in the background
2 at a time. In the harness all were ready 37–51 s after their first request (the queue, the remaining base warm-up,
and other GPU clients). Nothing waits for them: the uber-shader draws until each lands. Fewer variants were not
considered: every listed key is above 0.3 % of the pixels in some pose, and a key costs nothing until a mesh draws it.

### GPU time (paired: OFF / ON / OFF2 in rotating rounds, K = 7 × 9 frames, 2 frames in flight; main = the main colour
pass's per-instance median from the timestamp injector; frame = the engine GpuFrameTimer (sum of submit spans), first
pose of each session only (later poses of a session report no timer samples with the injector also installed); GPU
culling Auto (= the GPU path))

| World, canvas, path | Pose | Main pass OFF → ON | Δ main (A = B noise) | Δ frame |
|---|---|---|---|---|
| diorama 1300×850 | street | 7.53 → 4.59 | **−2.89** (−0.10) | −3.17 |
| | rooftop | 8.72 → 5.94 | −2.77 (+0.14) | |
| | sky | 4.29 → 3.20 | −1.08 (−0.14) | |
| | Play | 6.92 → 4.42 | −2.47 (−0.24) | |
| tiled 1300×850 | street | 9.04 → 6.43 | **−2.65** (+0.24) | −3.27 |
| | rooftop | 15.15 → 10.43 | −4.65 (−0.38) | |
| | sky | 15.43 → 10.86 | −4.91 (+0.12) | |
| | Play | 13.34 → 9.42 | −4.38 (+0.39) | |
| tiled 1300×850, CPU path | Play | 12.43 → 7.52 | −4.92 (−0.62) | −5.06 |
| | street | 13.59 → 8.16 | −5.48 (+0.23) | |
| tiled 2500×1390 | street | 23.74 → 14.57 | **−7.98** (−1.17, IQR 6.8) | −8.91 |
| | rooftop | 33.72 → 22.88 | −10.74 (+0.65) | |
| | sky | 32.41 → 22.44 | −9.60 (−0.09) | |
| | Play | 33.36 → 21.82 | −11.52 (−0.17) | |
| diorama 2500×1390 | Play | 17.01 → 10.72 | −6.50 (−0.33) | −6.25 |

The main pass drops 30–40 % everywhere (a third of the frame at full screen). Noise: the A = B pairs stay within
±0.4 ms at 1300 and ±1.2 ms at 2500. nvidia-smi: 6–22 % busy (other clients) at the start of each pose, 45–97 % during
the runs (ours included), core clock 1.6–1.9 GHz. The CPU cost is a Map lookup per batched group / per GPU bucket.

### Default decision
**On** (`Renderer3D.shaderVariants = true`, `rankVariants = true`): a clear win at every pose, world, canvas and
path, with identity. A/B: `sm.setShaderVariants3D({ enabled })` (session state; nothing saved), stats
`sm.getShaderVariants3D()`.

### Tests
- `shader-variants.test.ts` (new, 13): key derivation (families, look modifiers, unsigned bit 31, unlisted families),
  the specialisation of all 8 fragment shaders (one line, p8Fast, unsigned constants, fails loud on drift, no
  backticks), the id registry (dense, stable, capped), the layout contract (emissiveColor at floats 40–43 in every
  MeshInstance copy; the renderer writes the flags at float 43 and reads the key back from the same float).
- `wgsl-static-check.test.ts`: the variants are checked like every shader (each base fragment shader specialised, every
  family with a PBR and a Cel-HD + toon modifier).
- `gpu-driven.test.ts` (+1): the cached key equals the slot's flags, one variant per rank run, the state codes carry
  the ids, GPU = CPU draw sequence, switching off keeps the draw order and drops the ids. The rankPatterned test turns
  `rankVariants` off for its old-rank comparison.

### Left
- Skinned meshes (the same fragment strings with the skinned vertex shaders) and the planar-mirror pass still use the
  uber / plain pipelines; textured families (0.3–0.8 % of the city's pixels) too.
- Scene-global specialisation (fog mode, IBL / SSR off, no point lights, cascades) would strip more, but multiplies the
  keys per look; not measured.
- A real-GPU (D3D12 / DXC) browser check of the gain and of the compile times.

## P22 — Tile landing: faster builds, packed vertices, prop culling (2026-10-04; docs/ui/performance.md §Tile landing)

**Goal** (the P16 / P17 / P19 / P20 leftovers): a 9-tile window lands in ≤ 4 s (was 6.4–9 s), a tile ≤ ~65 MB, the
street view back to ≤ ~7.0 M main-pass triangles (9.4 M with P20's whole-group prop draws), no landing task > 50 ms.
Drivers (scratchpad `pupdrive/land2/`): `bench.run.mjs` / `ab.run.mjs` (the real tile build bundled for node: phase
timings + output hash, paired A/B), `half.run.mjs` (split identity), `mb.run.mjs` (per-tile MB packed / unpacked),
`land3.js` (teleport landings + per-tile timeline), `landtasks.js` (hitch2 `tasks.js` + `MODE=land`), `fly.js` (stream3's
fly / Play run), `pkvis.js` (frozen-clock A/B of one switch in one session, CPU + GPU path), `pcsweep.js` (prop-cull run
size), `fin.sh` (the final interleaved matrix). The first session (cut off) added the phase timings and the first two
speed switches; this section covers both.

### 1. The build profile (full tile (1, 0), seed 3, node, one build at a time; ms; `TileBuildOptions.timings`)

| Phase | ms | Phase | ms |
|---|---|---|---|
| drape (height + gradient + warp + bounds) | 460–620 | g:Signals | 90–120 |
| g:Streets (buildings) | 390–460 | contact blobs | 95–110 |
| g:Furniture | 290–370 | parts (P20 snapshot) | 80–90 |
| g:Biome | 180–210 | g:Layout / Road Paint | 65–85 each |
| instance (P20 fit) | 170–190 | Pedestrians / Railway / run boxes / rest | ≤ 40 each |

Whole tile 1.8–2.4 s alone; **3–5.5 s each while 6–8 build at once** (the box was shared with other agents at
~60 % load). CPU profile: the drape's height-field nodes / memo / warp ~22 %, GC 9 %, then a long flat tail of builders
(vert / obox / twins / instancing). The drape evaluates 0.86 M distinct points + 0.41 M out-of-core gradients (4 field
samples each) per tile; the field arithmetic itself is ~265 ms, so a large speed-up needs different math (not identical
bytes). Measured and rejected: a fast `Math.hypot` (−3 %, not byte-identical).

### 2. What changed (each an A/B switch; `sm.world.setTileLanding(on | {…})`, console `salsaWorld.p22(…)`, all on)

1. **Build speed-ups** (`src/world/tile-speed.ts` `TILE_SPEED`, per job `TileBuildOptions.speed`): `nodeBlocks`
   (out-of-core height nodes in 32 × 32 double blocks instead of a Map), `fusedWarp` (the warp's two noise pairs share
   floors / fades; dense corner-hash window), `fusedDrape` (height + warp + bounds in ONE pass over each layer on one
   memo table, `drape-memo.ts applyDrapeFused`). All byte-identical (test). Gain inside the noise: drape −5 to −11 %.
2. **`splitTile`** (`tile-build.ts TILE_HALF_OF`, `TileWorkerPool.build(…, split)`, `mergeTileHalves`): a full tile
   builds as two worker jobs merged back in build order. Only World Streets writes into the graph (each lot's builtH /
   door / buildingMeta / slot), and Signage / Awnings / Furniture / Pedestrians read it, so half 0 = Streets + its
   readers + landmarks / railway / skyway (~70 %), half 1 = flat map, water, road paint, biome, signals, road signs
   (~30 %; the layout is generated in both, +4 % CPU). Same groups, same bytes (test; the instanced crowd's per-build id
   nonce is the only difference, as between two whole builds).
3. **`nearFirst`** (`WorldManager._enqueueReassembly`): a full tile's reassembly jobs rank by the tile's distance from
   the window focus after the ground / road class, so the tile under the camera lands first (it used to finish with all
   the others: the queue took every tile's class 1, then every tile's class 2, …).
4. **`landingBudget`** (`WorldManager._reassemblyBudgetMs`, `LANDING_BUDGET_MS` 10): while the camera is still or slow
   (motion 'slow', not Play) and full-tile work waits, the sliced reassembly gets 10 ms a frame (was 3 ms whenever the
   stream had anything queued — always, with the HLOD skyline — or 6 ms).
5. **`landingSlots`** (`CityStreamHost.landing`, `CityStreamSource.fullCapFor`): while landing the HLOD backlog no longer
   borrows two full-build slots (the window's first wave was 4 + 2 builds).
6. **`landingLedger`** (`tile-landing.ts TILE_LANDING`, `Renderer3D._geomBudgetLeft`): the per-frame write ledger is
   16 MB instead of 8 MB while landing.
7. **`packedVertices`** (renderer; `src/renderer/3d/vertex-pack.ts`): see 3.
8. **`propCull`** (renderer): see 4.

### 3. Packed vertices + 16-bit indices (48 → 32 B; lossless)

Every city / world vertex carries the constant tangent (1, 0, 0, 1) (no normal maps; all 1.82 M vertices of a tile
checked), so the packed format just drops it: **position, normal, uv at 32 bytes, the same f32 values**, plus 16-bit
indices. Oct normals / half UVs were not needed for 32 B and would not be lossless (half UVs break world-scale uv
tiling, oct normals move toon thresholds).
- **Pool:** one buffer for both strides — every vertex span is padded to 96 B (lcm of 32 and 48), so any allocation
  divides by its own stride; `GeomAlloc.pk`, `baseVertex` / `firstIndex` in the allocation's units. Packed at upload
  (`poolViewOf`, cached while a sliced upload runs, dropped after) — the CPU arrays (picker, BVH, collision) are
  unchanged. Every path is format-aware: whole writes, slices, `patchMeshVertices` / `patchMeshIndices` (re-pack the
  range), the GPU compaction (moves keep the format), the P20 bookkeeping, the full rebuild (sized by the unpacked upper
  bound: no packed copy of the whole pool is ever held). A switch flip re-places the pool (`repackGeometryPool`).
- **Who is packed:** geometry marked `packable` by the full-tile build (`tile-build.ts markPackable`: indexed, ≤ 65,536
  vertices; a tile has 3–4 bigger ones that stay 48 B / 32-bit) whose tangent is exactly constant (checked while
  packing). Characters (skinned buffers), the centre city, HLOD, movers and everything else keep the 48-byte format.
- **Pipelines:** a packed TWIN of every pool pipeline (`packedTwin`: the same descriptor, slot 0 at stride 32, the
  tangent attribute from slot 1 = a 16-byte (1, 0, 0, 1) buffer at arrayStride 0; shader modules unchanged — no vertex
  shader edits, nothing for shader-variants.ts, whose specialisation is fragment-only). Pipeline3D notes each compiled
  pipeline's descriptor (`noteTwinSource`; base set + shader variants); the outline depth+normal pipeline too;
  highlight / silhouette build their own stride-32 copies. Geometry is packed only once the twins of the compiled
  pipelines are ready (`_pkGate`), so a packed mesh never waits for one; a packed draw falls back to the base pipeline's
  twin while a variant's twin compiles.
- **Draws:** CPU path — `_setPipe` records the base pipeline, `_drawMesh` switches twin / tangent slot / index format
  per allocation (`_pkPrepare`; code that rebinds the pool buffers or runs a bundle calls `_pkLost`). GPU path — state
  code bit `GD_CODE_PACKED` (bit 20; the variant id is now read masked), `resolve` returns the twin, buckets bind uint16
  + slot 1; the prepass / shadow bundles switch per record (`_fmtBind`, re-recorded when a missing twin lands:
  `twinEpoch`); packed casters take the own-buffer path of the compacted dynamic shadow layers (never compacted, drawn
  from their own blocks). TAA velocity skips packed meshes (static: camera reprojection).
- **Bytes per tile** (`mb.run.mjs`, five tiles): **89.5–95.6 → 59.2–65.4 MB** (998–1070 of ~1,000–1,070 geometries
  packed). Street pose pool with the window landed: 895 → 659 MB live.
- **Identity** (`pkvis.js`, frozen clock, ON / OFF / ON2 = packed / re-placed 48 B / packed again, one session):
  street (tile 1, 0) + far, CPU path and GPU-driven path: **0 px in all 8 pairs**, 0 GPU errors, 0 skipped draws.

### 4. Prop culling (P20 instanced groups)

An instanced prop group partly in the view draws only its runs of `PROP_CULL_RUN` (4) consecutive copies whose box
passes the frustum (copies are emitted prop by prop, so a run is compact); kept runs ≤ `PROP_CULL_GAP` (1) apart merge.
Run boxes = the copies' origins (the group's explicit offsets through the parent chain) ± the group box's geometry
margin, cached per group (`Renderer3D._propCullTable`, a `CullRanges` table with `inst: true`). A run is dropped only
when its box fails a plane, so its copies are clipped anyway: the same pixels.
- **CPU path:** one draw entry per kept span (`selectRanges`), in instance order.
- **GPU path:** the group becomes a ranged record with an INSTANCE-range job (`GdRangeJob.pad0 = 1`); `cs_ranges`
  writes up to 4 instance spans (`writeSpanInst`: the whole geometry for [first, first + count) of the copies).
- **Effect (street pose, tile (1, 0)):** main pass 8.75 → **7.00 M** triangles (+174 draws) on the CPU path, 8.93 →
  7.2–7.4 M on the GPU path (4 spans a record). Run size sweep (CPU): 8 → 7.16 M / 5,770 draws, 4 → 7.00 M / 5,944,
  2 → 6.82 M / 6,331. Rooftop: 9.46 → 8.49 M (run 8). **Identity:** street + rooftop × CPU / GPU: 0 px, 0 GPU errors.
- Shadows still draw whole groups (the light frustum is wide; future work).

### 5. Results (headless d3d11 1300 × 850, seed 3, 3×3 Full window, HLOD outside; OFF = `p22(false)`, same build,
interleaved; the machine was shared — worker builds 3–5.5 s each in parallel vs 2 s alone)

| Run | OFF | ON |
|---|---|---|
| Full tile geometry | 89.5–95.6 MB | **59.2–65.4 MB** |
| Teleport landing, 9 tiles (3 runs × 3 jumps) | 7.2–10.2 s (median 7.8) | **6.3–8.4 s (median 7.3)** |
| … the focus tile landed | 4.7–8.8 s | **3.2–3.8 s** |
| … long tasks (n / max ms) | 4–27 / 80–118 | 8–27 / 89–114 |
| 60-tile fly (1 tile/s): landing after it | 9.1 s | 8.1 s |
| … fly long tasks / gap p95 / outside min | 9 / 79 / 19.7 ms / 115 | 13 / 156 / 19.5 ms / 123 |
| Play run 40 s: own / ahead tile full | 0.65 / 0.41 | **0.88 / 0.53** |
| … long tasks n / max, gap p95 | 239 / 248, 108 ms | 255 / 290, 118 ms |
| 30-tile street fly (`tasks.js`): long tasks n / max | 33 / 115 | 24 / 113 |
| Street main-pass triangles (CPU / GPU path) | 8.75 / 8.93 M | **7.00 / 7.2–7.4 M** |

**Not met:** the 9-tile window in ≤ 4 s (6.3–8.4 s; only the focus tile, 3.2–3.8 s). The landing is worker-bound:
9 × ~2 s of build CPU over 6–8 workers on a shared box, then ~1–2 s of main-thread reassembly — more parallelism
(8 full slots, 12 jobs) made each build slower, not the window sooner (`sched-*.log`: 13–20 s). It needs much cheaper
builds: drape math the GPU or a coarser field could do, or a smaller window. **No landing task > 50 ms:** not met —
the landing's long tasks are render frames (draw lists + cull up to 22 ms, new instance-slot writes up to 14 ms) plus
GPU-process writeBuffer stalls (single 2 MB writes waiting 40–60 ms); the larger landing budget adds a few more but no
longer ones. Fixed on the way: packing every waiting geometry up front in one frame (a 30 ms `pool: append`). The 9
synchronous flat previews of a teleport (~27 ms each) remain.

### Tests
- `src/renderer/3d/vertex-pack.test.ts`: encode / decode exact (bit for bit, −0, tiny values), a bad tangent refuses;
  16-bit indices exact, padded, ≥ 65,536 refuses; the twin vertex state; pool views; the REAL pool on a recording device
  (mixed formats in one pool, slices, GPU compaction, full rebuild, switch flip, partial vertex / index patches — every
  byte decodes to the CPU arrays); draws (twin + slot 1 + uint16 vs base + uint32, `_pkLost`).
- `src/renderer/3d/prop-cull.test.ts`: cull equivalence — every copy whose box passes is in a kept span; spans ordered,
  disjoint, starting / ending on passing runs.
- `src/world/tile-speed.test.ts`: build identity — speed switches on = off, half 0 + half 1 = the whole build (same
  groups, order and bytes), every group has a half, packable marks.
- Existing suites unchanged (geom-upload-slices, geom-compaction-p20, upload-on-demand, gpu-driven, wgsl static check).

### Left
- Landing ≤ 4 s: cheaper builds (the drape is a quarter of a build; the builders' tail is flat), or build fewer / smaller
  tiles first. Teleport previews (9 × ~27 ms sync flat builds) could come from the worker.
- Prop groups in the shadow passes still draw whole; GPU spans capped at 4 per record.
- Packing for the centre city and HLOD tiles (they are 48 B; the switch only takes full streamed tiles).
- Browser check on a real GPU (D3D12 / Vulkan) of the stride-0 tangent buffer and the twin compile times.

## Host (Frogmarks) work
- A shader warm-up toast bound to P2.3.
- Optionally, a loading overlay during document load that shows worker-job progress: `sm.onWorkerJobProgress3D(cb)` / `sm.getWorkerJobProgress3D()`. See docs/ui/performance.md §Background work.
- Rebuild the dist and re-run `pupdrive/p3w/fm-p3.js` and `pupdrive/p5/fm-p5.js` to get real-app "after" numbers for P3 and P5 (incl. P5.W4).
- P6: the shipping dist predates P5/P6. Rebuild it and re-run `pupdrive/p6/fm-walk.js` (Play + fly in the real app). At full-screen sizes (~2.5 K) the city is GPU fill-bound, so a "Performance" toggle or automatic dynamic resolution (`sm.scene3d.setDynamicResScale3D(0.75)`, 21 → 13 ms main pass) is the host-side lever for a steady 60 fps.
- P10: fix the City panel's "Stream to camera" double toggle and its stats line (see §P10 Host findings).
- [x] Done 2026-10-01: `sm.setResolutionScale3D({ mode: 'off' | 'fixed' | 'auto', ... })` (auto keeps the GPU frame time under a target; exports stay native) and the City panel's **Performance** group (resolution scaling + per-family LOD settings + live stats). See docs/ui/performance.md §Resolution scaling / §LOD settings. Measured at 2500 × 1390: 15.4 ms native → 10.4 ms at 0.75; auto at 16 ms settles at 0.9 (13.6 ms).
