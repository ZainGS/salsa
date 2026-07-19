# Streaming / LOD / City — Optimization Spec

> **Scope:** performance + perceived-load improvements to the tiled-world streaming path, the zoom-gated LOD, and the
> tile build/upload pipeline. Companion to [[spatial-streaming]] (which built the streaming engine, Phases 0–3 + 5).
> **Status:** **Phases 1–4 BUILT** (2026-07-17). `msUpload` coalesced-run fix also shipped. Phase 4 (Web Workers)
> needs **in-browser verification in Frogmarks** (the blob-worker is the one thing headless tests can't prove). The
> smaller items (pool-compaction-on-idle, time-sliced reassembly, `maxLiveChunks`) are pending.

## Why (the three stacked costs behind "tiled loading lags")

Tracing what happens when a neighbour tile enters the window:

1. **CPU generation** — `_buildTile` runs `generateCityLayout()` + `buildStreets/buildBiome/buildLandmarks/…`
   per tile. For `tileDetail:'full'` that's a *whole city* generated in JS on the main thread. The `StreamManager`
   pump time-slices at ~10 ms, **but cannot preempt mid-tile** — one `full` tile can overrun a frame on its own.
2. **GPU upload on reveal** — each tile is added *visible* via `_add`, so the next render sees the instance slot
   count change and does a **full instance repack** (sort by geometryKey + rebuild slot maps + re-upload,
   O(all instances)). The pump renders after every slice → **one growing repack per slice**, not one at the end.
3. **Geometry-pool append** — incremental (`_appendGeometry`), cheaper, but still real per reveal.

**Key structural finding:** single-city regen already solves this (`_startAsyncFull` → `_asyncStep` → `_finishAsync`
builds groups **hidden**, pre-uploads geometry with `warmGroupGeometry3D` across frames, then reveals with a cheap
**visibility flip**). **Streamed tiles bypass all of it** — they add visible-and-cold. That's the biggest lever.

Separately, the zoom LOD wastes main-thread time: `_tier`'s `else if (!show) this._applyLOD(re, false)` **re-walks the
entire scene graph every frame while detail is hidden** (to catch newly-spawned visible nodes), running a regex
`.test()` per node — O(all nodes) × 2 tiers, 60×/sec, exactly in the zoomed-out state where a big world needs headroom.

## Optimizations (impact / effort)

### Perceived-load ("make it feel instant")
- **① Proxy-first, always** *(high impact, medium effort)* — the instant a tile enters the window, build only the
  flat layout preview (cheap) and show it, then build full detail and swap. The world is never empty where you look:
  "empty → lag → city" becomes "flat map instantly → detail fills in." Reuses the existing flat build + proxy key;
  the change is *sequence* (coarse first, refine).
- **② Warm/stage tiles** *(high impact, medium effort)* — route the full-detail build through `warmGroupGeometry3D`
  so the geometry is pre-uploaded; the reveal render then only pays the instance repack, not the geometry upload.
- **③ Prefetch one ring beyond the window** *(medium)* — keep a cheap proxy ring just outside `loadRadius` so crossing
  a tile boundary reveals an already-resident proxy (then upgrades), instead of building on the boundary.
- **⑤ Batch reveals** *(low)* — the pump already renders once per ~10 ms slice (so repacks are batched per slice, not
  per tile); with proxy-first the previews drain in 1–2 frames, so the full pass can render less often → fewer repacks.
- **④ Web Workers for generation** *(highest ceiling, high effort — future)* — move `generateCityLayout` + mesh
  builders to a worker pool, transfer geometry back (transferable `ArrayBuffer`s) for main-thread upload. Removes the
  CPU stall entirely; 60 fps holds through any build. World-gen is already pure/deterministic; text rasterization
  stays on main (tiles don't currently get text signs). Do ①–③ first; this is the last mile.

### LOD
- **LOD re-walk gate** *(high impact when zoomed out, low effort)* — only re-hide when the scene graph changed since
  the last apply (a `_sceneEpoch` counter bumped on add/spawn), instead of every frame.
- **Precompute the hide-set** *(medium)* — build a `Set` of LOD-controlled nodes once per graph change; toggle by
  membership instead of regex-per-node-per-walk.

### Streaming
- **`_streamCb` per-frame string alloc** *(low)* — compare `loadRadius`/`detailRadius` as integers, not a
  `` `${a},${b}` `` string; early-out when `camera.target` + zoom are unchanged.
- **O(n²) dispose** *(low)* — `_disposeTileGroups` does `indexOf` + `splice` per group; batch into one filter pass.
- **Pool compaction on idle dispose** *(medium — the "memory doesn't drop" issue)* — the append-only pool keeps
  disposed-tile space until an incidental compaction (`vtxCapMB` lags `liveAllocs`). Request a compaction after a
  dispose batch **when the view is idle** and dead space exceeds a threshold, so the memory win lands promptly.
- **Split a tile's build across frames** *(medium)* — `_buildTile` builds all of `BUILD_ORDER` atomically; let the
  pump build a tile's groups incrementally so slicing is honest (~10 ms, not "10 ms or one whole city").
- **Enforce `maxLiveChunks`** *(low, correctness)* — drop the farthest tile when over budget and `log` it.

### City build / upload
- **Instance repack is O(all instances) on any structural change** — the load-hitch root; mitigated by proxy-first +
  warm + batching. A deeper per-geometry free-list (append instances without a global repack) is a larger change —
  hold unless batching is insufficient.
- **`msUpload` steady-state — FIXED 2026-07-17** — coalesced-run upload (only the touched mover slot-runs, not one
  `[lo,hi]` span across the whole 43 MB buffer). Removed the ~23 ms/frame zoomed-in cost.

## Phased plan

- **Phase 1 — LOD re-walk gate. ✅ BUILT.** `_sceneEpoch` bumped in `_add` / `_finishAsync` / `_spawnTraffic`; the
  LOD re-hide (`_tier`) re-walks only when the epoch advanced, with a 30-frame safety sweep — no per-frame full tree
  walk. Isolated, no visible change, frees zoomed-out frame time.
- **Phase 2 — Proxy-first + warm tiles (① + ②). ✅ BUILT.** Generic two-phase build in `StreamManager`
  (`buildPreview` → `build`, `_previewQueue` drained before `_fullQueue`): every tile shows a cheap flat stand-in
  almost at once, then the full 3D upgrades and disposes the preview. `CityStreamSource.buildPreview` builds the flat
  proxy for full tiles (null for already-flat tiles). `_buildTile` **warms** each full tile's geometry
  (`warmGroupGeometry3D`) so the reveal render pays only the instance repack, not the geometry upload. 5 new vitest
  cases (preview-before-full ordering, null-preview skip, no-rebuild-when-full, dispose-current-handle).
- **Phase 3 — Prefetch + batch reveals (③ + ⑤). ✅ BUILT (reframed).** Key insight: **proxy-first supersedes
  aggressive prefetch** — on-demand tiles already appear instantly as flat, so pre-building ahead isn't needed and a
  uniform prefetch RING would re-grow the zoomed-in memory win (it scales with radius²). So prefetch is **tunable,
  default 0** (`salsaWorld.streamPrefetch(0–2)`), adding only cheap PROXY rings when raised. Batch reveals (⑤) were
  already in place: the pump renders once per ~10 ms slice, so repacks are batched per slice, not per tile.
- **Phase 4 — Web Workers for tile generation (the CPU-stall fix). ✅ BUILT** (needs in-browser verify). See below.
- **Later — pool-compaction-on-idle-dispose, per-frame tile-build slicing, `maxLiveChunks` enforcement,
  `_streamCb` string-alloc + O(n²) dispose micro-opts.**

## Phase 4 — Web Workers for tile generation (detailed)

**Goal:** move the ~10–50 ms/tile of procedural JS (`generateCityLayout` + the mesh builders) OFF the main thread so
it never stalls the frame. The main thread keeps only the cheap "wrap finished geometry into a mesh + upload."

### Why it's feasible in this codebase (verified)
- `src/world` is **browser-free** — the builders touch no `document`/`window`/`canvas`, so they run in a Worker as-is.
- `Accum3D.geometry()` returns `{ vertices: Float32Array, indices: Uint32Array }` — both `ArrayBuffer`-backed, so
  `postMessage` can **transfer** them (zero-copy; the memory is handed over, not cloned).
- Generation is **deterministic** (seed) → a worker-built tile is byte-identical to a main-built one; nothing is
  stored, everything re-derives.
- **Text-sign rasterization** (the one thing needing a canvas) only runs for the CENTRE city, never neighbour tiles —
  so nothing canvas-bound needs to move.

### The split (compute in worker, upload on main)
```
WORKER: buildTileLayerGroups(params, tx, tz, full=true) → [{name, layers}]   (flat LayoutPreviewLayer geometry)
        → postMessage({id, groups}, [every layer.geometry.vertices.buffer, indices.buffer])   ← transfer
MAIN:   receive groups → _addTracked(name, layers) per group (drape + make Mesh3D + material) → warm/upload → swap out the flat preview
```
`buildTileLayerGroups` is a **shared** function in `src/world/tile-build.ts` that both the worker AND the
main-thread fallback (`_buildTile`) call — one source of truth, no worker/main drift. It's the "produce flat layers"
stage; the main thread's `_addTracked` still does the terrain drape + mesh/material creation + GPU upload (that part
must stay on main — it's WebGPU-bound — but it's the cheap part).

### Integration — proxy-first is the seam
- `buildPreview` (flat stand-in) stays **synchronous** on main → instant.
- `build` (full 3D) becomes **async**: `CityStreamSource.build` posts to the worker pool, awaits geometry,
  reassembles, resolves the handle. The `StreamManager` gains **async-build support**: `build` may return
  `H | Promise<H>` (detected via `.then`), tracked in an `_inflight` set with **cancellation** (a tile that leaves
  the window mid-build has its result discarded on arrival via a `_wanted` set). Sync sources (the depth source, the
  headless/no-worker path) are unchanged — the sync branch is byte-identical to today.
- The **pool** (`TileWorkerPool`) spawns `hardwareConcurrency − 1` workers, round-robin dispatch, a `pending` map
  keyed by request id. Tiles generate **in parallel across cores** → a 5×5's tiles cook simultaneously. If `Worker`
  is unavailable (headless/tests) `available=false` and the source takes the sync main-thread path.

### Worker delivery across the Salsa-dist → Frogmarks-webpack boundary (the risk)
Salsa is a **built library** consumed by Frogmarks via webpack. A `new Worker(new URL('./tile-worker.ts',
import.meta.url))` emits a separate asset whose URL the *consuming* bundler must resolve — fragile across the
lib→app boundary. Mitigation: **inline the worker** (Vite `?worker&inline` → the worker code, including the bundled
`src/world`, is embedded as a base64 blob in Salsa's `dist`), so it's fully self-contained and needs no asset
resolution by Frogmarks. Cost: a larger dist chunk (the world builders are embedded twice). **Must be verified
in-browser in Frogmarks** — this is the one piece that can't be proven by `tsc` + headless tests.

### Transfer gotcha (fixed 2026-07-17)
The worker must **COPY geometry into fresh buffers and transfer the copies**, NOT transfer the builders' geometry
directly. Instanced detail (balcony / greenery clumps) is **module-cached and reused across tiles**, so transferring
(which *detaches*) corrupts the cache → `DataCloneError: An ArrayBuffer is detached and could not be cloned` on the
NEXT build (and a buffer shared by two layers would be transferred twice). The `.slice()` copies are unique +
cache-safe; the memcpy runs on the worker thread; the main thread still receives them zero-copy.

### What Phase 4 does NOT remove (the honest ceiling)
The **instance repack** on reveal (O(all instances), main thread) stays — workers remove *generation*, not upload.
But it's the smaller cost, it's warmed, and it batches per slice. If reassembly of several just-completed tiles
lands in one tick and spikes, the v2 refinement is a **time-sliced reassembly queue** (split `build` into
`requestBuild` (async worker) + `commitBuild` (sync, sliced)); v1 accepts the naturally-staggered worker responses.

### Build order — DONE
1. ✅ Async `StreamManager` (`build → H | Promise<H>`, `_inflight` + `_wanted` cancellation; sync path unchanged; 4
   new vitest cases). 2. ✅ Shared `src/world/tile-build.ts` `buildTileLayerGroups` + `_buildTile`/`_assembleTile`
   refactor (no behaviour change, removed the duplicate `_buildGroupFor`). 3. ✅ `tile-worker.ts` (`self`-cast, no
   webworker-lib clash) + `TileWorkerPool` (round-robin, crash-rejects pending, `available` guard) — INLINE worker
   (`?worker&inline`, verified embedded as a blob in dist, 0 unresolved imports). 4. ✅ `CityStreamSource.build`
   routes full tiles to `host.buildTileAsync` (worker) when `canUseWorkers()`; `world-manager._buildTileAsync` awaits
   the pool then `_assembleTile` on main, **falls back to a sync build if the worker rejects**; `salsaWorld.streamWorkers(on)`
   toggle (default ON) + `streamStats().workers`. 5. ✅ `tsc` + Salsa build clean — **in-browser verify pending**.

### Verify in-browser (the one thing tests can't prove)
Restart Frogmarks (rebuilt dist) → `tiled` + `tileDetail:'full'` + `streamFollow(true)`, pan/zoom. Expected: tiles
show flat instantly then **fill in with detail at 60 fps — no main-thread stutter during the full build**.
`salsaWorld.streamStats().workers` should be `true`. A/B it: `salsaWorld.streamWorkers(false)` → the old stutter
returns (main-thread build); `streamWorkers(true)` → smooth. If the blob-worker is blocked (CSP `worker-src`) it
silently **falls back to the main-thread build** — tiles still appear, just with the stall, and `workers` reads
`false`.

## Verification
`npx tsc --noEmit` + the streaming vitest suite per phase. In-browser on a `tiled` + `tileDetail:'full'`, `5×5`
world with `streamFollow(true)`: Phase 1 → zoomed-out `frameStats().msTotal` drops with no visual change; Phase 2 →
panning/zooming shows flat tiles immediately then detail fills in, `frameStats` load spikes shrink; Phase 3 → crossing
a boundary shows no empty gap. Reminder: Frogmarks consumes the **built `dist/`** — `npm run build` after changes.

Links: [[spatial-streaming]] · [[project_city_lod]] · [[project_instancing_blocks]] · [[project_spatial_streaming]].
