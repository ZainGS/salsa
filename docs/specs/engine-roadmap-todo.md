# Engine roadmap — performance + architecture TODO (ordered)

**Created:** 2026-10-01 · **Purpose:** one ordered checklist for getting from "lags in big worlds" to steady 60 fps
with endless streaming. Detail and measurements live in performance-plan.md (P1–P22), fog-horizon.md,
occlusion-culling.md and docs/ui/performance.md; this file is the order of work.

> **Built vs not built, one page:** [../STATUS-2026-10-04.md](../STATUS-2026-10-04.md) (everything that landed
> 2026-09-28 → 10-04, default on / off, open items, caveats).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Estimates are rough working days.

## Why this order
- The frame is limited by two separate processors:
  - The **CPU** decides what to draw (JavaScript loops over ~13k objects, 2–4k draw calls): 12–17 ms in the
    tiled world.
  - The **GPU** shades pixels: about 3.6 M pixels per frame at 2.5K, each running one big fragment shader, plus the
    post passes.
- Steps 0–3 are cheap and remove waste.
- Steps 4–6 are the structural changes that close most of the gap to AAA-style frame rates.
- Steps 7+ come after, or only if measurements say so.

---

## Step 0 — Measure first (≈1 day) — DONE 2026-10-01: performance-plan.md §P13 (baseline table + findings)
- [x] **One full Play-frame CPU profile at street level**, diorama and tiled 3×3. Split the time into:
  - simulation: traffic, walkers, live crowd, trains, springs, clouds, day cycle;
  - culling and draw-list building, and instance uploads;
  - editor overhead: the 2D overlay walks, Angular change detection, HUD polls;
  - waiting on the GPU.

  Save it as a baseline table in performance-plan.md. → **§P13 "Baseline profile"**: diorama Play 8.7 ms busy a
  frame (vsync-limited, ~7.7 ms idle), tiled 3×3 Play **CPU-bound** at 15.9 ms p50 / **46.7 ms p95**. Simulation is
  1.6 ms (diorama) / 0.8 ms (tiled); the rest is draw lists, pass encoding, the editor's 2D walks and host scans.
- [~] Same profile in real Frogmarks: the dist (2026-10-01 16:04) predates P11/P12, so only the HOST costs were
  measured there (Angular change detection on pointermove, the stats HUD poll; §P13 "Frogmarks"). Re-run
  `pupdrive/prof/fm-angular.js` + `prof.js` against a rebuilt dist.

## Step 1 — Simulation LOD (≈2–3 days) — DONE 2026-10-01: §P13 "Step 1", docs/ui/performance.md §Simulation LOD
- [x] **Nothing in the fog updates.** Past the fog horizon's cull distance (+4 m) walkers, cars, trains, other movers,
  chat bubbles, live-crowd poses and promotion, character idles and springs are frozen, and no crowd cell is built.
- [x] **Movers as a function of time.** Walkers (`world/walker-clock.ts`) and trains (`train.ts` `trainRunAt`) are a
  closed form of the world clock; frozen ones reappear on their route / schedule. Traffic playback was NOT
  time-based (the worker precomputes spawn specs and the road net only); cars stay a stepped sim (they interact),
  stepped at the band rate in substeps and paused in the fog.
- [x] **Update rate by distance and visibility:**
  - near and on screen: every frame;
  - mid-distance: about 10 Hz;
  - far or off screen: about 2 Hz, or frozen;
  - in the fog: frozen.

  Applies to animation sampling, spring bones and mover steering. Plus an anti-stutter floor (a moving thing on
  screen updates before it moves 1.5 px) and hysteresis. Switch `sm.setSimLod3D({ enabled: false })`.
- [x] Wind needs nothing: it's a vertex-shader effect, so it costs no CPU.
- **Result** (§P13): diorama Play simulation 1.57 → 0.97 ms a frame, main thread −1.0 to −1.3 ms; tiled ≈ 0 (no traffic there).
  **The profile says step 1 was not where the frame goes** — see "Order after the profile" below.

## Order after the profile (P13, 2026-10-01)
The baseline moves the editor overhead and the structure-change hitches ahead of step 3:
1. **Step 2 first** (≈ 4.7 ms a tiled frame) — DONE 2026-10-01: the 2D walks (2.7 ms incl. render-list rebuilds) and the host renderer's
   per-frame node scans (2.0 ms: `draw3DMeshes` / `draw3DParticles` instanceof filters over ~13 k nodes and a full
   `forEachDeep` in `draw3DGp` every frame).
2. **Structure-change hitches** (new, added to step 3) — DONE 2026-10-01 with step 2: the tiled p95 frame is 47 ms. Every structure change (a
   lazily built crowd cell, a live-crowd promotion) re-sorts the main pass draw order over all meshes by geometry-key
   strings (~10 ms), rebuilds the 2D render list (~8 ms), re-scans meshes for character skeletons (~2 ms) and
   re-prewarms the pipeline roster (~3 ms).
3. Then steps 3 and 4 as planned (draw lists + cull 4.8 ms and pass encoding 3 ms are the biggest steady costs).

## Step 2 — Remove editor overhead from the frame (≈2–3 days) — DONE 2026-10-01: §P13 "Step 2", docs/ui/performance.md §Editor overhead
- **Result** (§P13 "Step 2"): tiled 3×3 Play busy 16.2 / **46.9** / 19.4 → 12.2 / **21.9** / 13.9 ms (p50 / p95 / mean),
  frame interval p95 47 → 22 ms; diorama 7.6 / 10.5 → 6.4 / 8.5. 2D walks 2.7 → 0.13 ms, host scans 2.0 → 0.3 ms.
  Pixel-identical frozen-clock A/B in 2D and 3D; A/B switch `sm.setFrameScanOptions3D({...})`.
- [x] **The 2D overlay walks every 3D node each frame.**
  - The 3D meshes live in the same scene graph as the 2D shapes. So the per-frame 2D overlay steps loop over all
    ~13k 3D nodes looking for selected text and carets, even in 3D Free + Scene mode:
    `collectSelectionHighlights(visibleNodes)`, `collectActiveCarets(visibleNodes)` and the 2D strategy's
    `beginFrame`, in webgpu-renderer.ts.
  - Fix: keep a separate list of 2D overlay candidates (text nodes, 2D selections), or skip 3D subtrees. About
    2 ms per frame.
  - Done: per-kind render lists from one structure walk (`render-list-index.ts`); the 2D steps see 0 nodes in a city.
- [x] **Angular change detection on every mouse move.**
  - The canvas `(pointermove)` template binding (illustration.component.html line 33) runs inside Angular's zone.
    Every mouse move re-checks the bindings of a 15k-line component with a 12k-line template.
  - Fix: register the canvas pointer handlers with `ngZone.runOutsideAngular`, and re-enter the zone only when
    a UI value actually changes.
  - Done (Frogmarks): registered outside the zone; re-enters on a ribbon-handle change or while a button is held
    (drags keep their per-move change detection). Hover storm: 17.7 → 0 ms/s of change detection.
- [x] **HUD polling.**
  - The stats HUD calls `getRenderStats3D()` every 250 ms. That call walks every mesh to total the scene
    triangles, and each poll also triggers a full change detection.
  - The Performance panel and stream stats poll on their own timers too.
  - Fix:
    - cache the scene totals and update them on scene change;
    - poll outside the zone, applying results inside the zone only when they changed;
    - pause all polls while their panel is closed (the stream and perf polls already do).
  - Done: cached per-mesh figures in `getRenderStats3D` (a poll reads only `visible`); the stats / perf / stream polls
    run outside the zone and enter it only when a shown value changed.
- [ ] **Angular version and change detection.** Frogmarks is on Angular 17.3 with zone.js.
  - Upgrading to 21 alone won't speed anything up.
  - What helps is what newer Angular makes easy: zoneless change detection, signals and OnPush. Angular then
    updates only the bindings whose data changed, instead of re-checking everything on every event.
  - Plan: do the runOutsideAngular / OnPush fixes now. Treat the upgrade to zoneless as a separate host project:
    a large component, and every binding needs a signal or explicit markForCheck.
- [ ] Autosave: confirm it never runs on a frame during Play or a pan (it already defers during Play).
- [x] **Host renderer node scans (P13).** `draw3DMeshes`, `draw3DParticles` and `isRenderBelowRaster` filter all ~13 k
  render-list nodes every frame, and `draw3DGp` walks the whole scene graph (`forEachDeep`) every frame to find
  skeletons: ~2 ms a tiled frame. Cache the per-kind lists on the render-list version.
  - Done: cached 3D lists + the walk's skeleton list; host render() other 1.97 → 0.32 ms tiled.
- [x] **`_syncCharacterSkeletons` (P13)** walks `getAllMeshes()` twice every frame when any character exists
  (0.4 ms, 2 ms p95 tiled). Cache the driver list per structure version.
  - Done: skinned-mesh list per structure version: 0.36 / p95 1.8 → 0.10 / p95 0.1 ms.
- [x] **Camera-motion resolution in Play** (was a step-6 note): `setResolutionScale3D({ motion })`, default `'auto'`
  = editor moves as before, Play only while the GPU frame is over budget. Tiled Play now renders at 1.0.
- [x] Next found by the step-2 profile: `WorldManager._scheduleTileBounds` after a streamed tile settles (up to
  132 ms in a timer task) is now the biggest part of the tiled p95 frames.
  - Done in step 3: cached per-geometry boxes folded in 3 ms slices (`group-bounds.ts`); timer tasks 0.77 → 0.02 ms a
    tiled frame, gone from the p95 frames.

## Step 3 — Lighter tiles and no hitches (≈1–1.5 weeks) — DONE 2026-10-02 (two slimming items not applicable, one deferred): §P13 "Step 3", docs/ui/performance.md §Lighter tiles
- **Result** (§P13 "Step 3"): tiled 3×3 Play, every step-3 switch off → on in one build: 15.4 / 26.4 / 17.3 → 13.3 /
  22.0 / 14.2 ms (p50 / p95 / mean); against the code before the step (plain): p95 25.0 → 18.5 ms, long tasks 7 (max
  146 ms) → 1 (51 ms); diorama 7.1 → 5.9 ms mean. Collision rays 1.4 → 0.34 ms with 0 differences over 33,598 live rays.
  30-tile street fly: worst task 135 → 77 ms, worst frame gap 176 → 85 ms. Pixel-identical (frozen-clock A/B).
- [x] **Instanced crowd (P12, done 2026-10-01; performance-plan §P12).**
  - Was: crowd vertices baked into merged meshes in near/mid/far copies, ~91 MB per tile.
  - Now: per-person records (~100 KB a tile) and GPU-instanced shared far variants (~85 for a 3×3, 1.3 MB). The exact
    near / mid people are built lazily for the 50 m cells around the camera (~18 MB at street level).
  - Results: crowd pool 787 → 20 MB in a 3×3; tile build 2.7 → 1.4 s; crowd reassembly 409 → 48 ms per landing.
    No crowd job is over 2 ms per tile.
  - Open: per-instance GPU culling for the whole-tile far groups; the far silhouettes are approximations.
  - [x] Worker-side cell builds (step 3): the `near` worker lane builds near / mid cells from their record rows (the
    same meshes, number for number); a fast street fly shows far figures ~10× less (0–14 vs 83–131 cell-frames).
- [x] **Structure-change hitches (P13, the tiled p95)** — DONE 2026-10-01 with step 2 (§P13 "Step 2"). A structure change re-sorts the whole draw order
  (`_drawOrderDirty` → `meshes.slice().sort` by `geometryKey`, ~10 ms in a 3×3), rebuilds the 2D render list
  (~8 ms) and re-prewarms the roster (~3 ms). Insert new meshes into the rank incrementally; make the render list
  incremental (or 3D-free); batch the crowd / live-crowd structure notifications to one per frame.
  - Done: incremental draw rank by numeric key codes (`draw-order-rank.ts`, main pass p95 12.4 → 3.6 ms); incremental
    render list (p95 8.7 → 0.1 ms); prewarm only new pipeline names (p95 3.2 → 0.1 ms); coalesced structure-version
    bumps (`structure-version.ts`). The quiet crowd path was already one flag per frame.
- [x] **Play collision rays** are 1.3–1.4 ms a frame in both worlds (P13): the next CPU item after the walks.
  - Done (step 3): 1.41 → 0.34 ms tiled, 1.49 → 0.33 ms diorama (all collision work incl. cell upkeep 0.50 / 0.40).
- [x] **Lazy collision.** Collision is only needed within a few metres of the player. Build BVHs per block, in the
  worker, only for blocks near the player, instead of one 0.2 s BVH for a whole tile.
  - Done: per-CELL merged BVHs (`game/collision-cells.ts`) for the 3×3 cells around the player, gathered in 1.5 ms
    slices (run boxes from the tile worker) and built in the new `near` worker lane. Same hits (0 differences over
    33,598 live rays). Next: the collision snapshot rebuild (2.1 ms in the tiled p95 frames) as an incremental grid.
- [x] **Sliced uploads.** No single geometry upload over about 2–4 MB per frame. Split big layers at build time,
  and prioritise by distance and in-view.
  - Done: no write over 4 MB (bigger geometry: one ≤ 4 MB slice a frame), ≤ 16 MB a frame in all, nearest in-view
    first. A 4 MB frame total was measured and rejected (streaming at its limit; more long tasks).
- [~] **Slim the full tiles.**
  - [-] Drop prop far-twins and the far crowd tier from neighbour tiles where unneeded: not applicable to the
    eye-centred window — every 3×3 neighbour touches the focus tile and its families draw to 411–822 m (a tile is
    420 m), so a far twin is visible there. Only pays past the families' draw distance (5×5, fog Far).
  - [-] Coarser ground for proxy and massing tiles: a 2–3× coarser lattice sags 0.4–0.9 m at the default relief,
    more than the 0.15 m kerb between the stacked ground layers (z-fighting from the air); the proxies already build
    in the worker. Fold into fog-horizon P3 (silhouette tiles).
  - [x] Reclassify overlays (road paint, wear, gutters, storefronts) as fog-culled: fog class 'overlay' (culled past
    Far, no fade): +0.3–0.5 M triangles culled per tiled pose at Far 80 m, 0 differing pixels.
  - [ ] Put array groups into the P9 clusters: deferred until the §P14 shadow bookkeeping in the group loop settles.
  - [x] **Instanced props (P20, 2026-10-04; performance-plan §P20, docs/ui/performance.md §Lighter tiles):** poles,
    signal heads, lamp posts, roof railings / plant, parked-car wheels, vending trim, benches, bollards, cabinets,
    frosted panels become canonical geometry + fitted per-copy 3×3s (exact to 1 mm against the baked build; content-keyed
    and shared by every tile). A full tile 134–145 → 90–96 MB; teleport landing 9.2–11 → 6.4–9.0 s; landing after a
    60-tile fly 11.3 / 12.7 → 9.0 / 9.1 s. Also: memoised drape, split worker messages, the worker slot freed on worker
    done, a new-mesh attach budget, cheaper compaction bookkeeping. Switch `sm.world.setLighterTiles(...)`. Fixed on the
    way: city tree instanceKeys collided across tiles (seed-built variants, one key; now content-hashed).
  - [x] Instanced prop groups cull per run of 4 copies (P22 `propCull`, 2026-10-04; performance-plan §P22): CPU spans +
    a GPU instance-range job; street main pass 8.75 → 7.00 M triangles (CPU path), 8.93 → 7.2–7.4 M (GPU), 0 px.
  - [x] Smaller GPU vertex format (P22 `packedVertices`, 2026-10-04): streamed full tiles stored as 32-byte vertices
    (the constant tangent from a stride-0 buffer; lossless) + 16-bit indices, packed twins of the pool pipelines; a tile
    90–96 → 59–65 MB, 0 px in both paths.
  - [~] Faster landing (P22, 2026-10-04): byte-identical build speed-ups, a two-worker tile split, the focus tile first,
    a landing reassembly budget / slots / write ledger: the focus tile lands in 3.2–3.8 s (was 4.7–8.8), the 9-tile
    window in 6.3–8.4 s (was 7.2–10.2) — the ≤ 4 s target is not met (worker-bound; next: cheaper drape / builders).
- [x] **Budgets HUD.** Warn when a scene exceeds its budgets, e.g. 3 M triangles drawn, 2k draw calls, 500 MB of
  geometry.
  - Rule: tiny detail (bolts, cans, sleepers) goes into textures or instances, not unique geometry.
  - Done: `sm.getSceneBudget3D()` / `setSceneBudget3D()` (+ 200 k instances); Frogmarks stats HUD + Performance line.
- [x] **Streaming leftovers (P10.D open items):**
  - [x] the border glow, apron and void grid follow the window (rebuilt around the focus tile in the world worker);
  - [x] re-attached tiles refresh their night glow and style (scoped to their own meshes, at once);
  - [x] prune `_agAABBCache`;
  - [x] bring ortho onto the eye-centred window (it centres on the view centre); Flat / Focus worlds stay on the
    visible-set path: they have no full neighbour tiles, so the window has nothing to choose.

## Step 3c — Streaming hitches (P16) — built 2026-10-02: performance-plan §P16, docs/ui/performance.md §Streaming hitches
- [x] Instance uploads: the slot allocator's free list is coalesced and size-bucketed (a landing tile's ~300 group allocs
  scanned thousands of single-slot entries: up to 22 ms); new array groups are packed under a per-frame instance budget,
  nearest in view first, and are not drawn until packed (no stale slots).
- [x] writeBuffer: one per-frame write ledger (8 MB; instances first, geometry ≥ 2 MB floor), no geometry write over 2 MB,
  and a compaction no longer writes fresh geometry whole. Worst frame 19–23 → 8–11 MB.
- [x] Geometry pool: the GPU compaction moves runs of adjacent geometry as one copy.
- [x] Tile removal: detached at once, the renderer cleanup drained under 1.5 ms a frame; re-attach flushes; the backdrop
  swap removes silently.
- [x] World LOD stamps: tier lookups memoised per name; whole-world restamps skip already-stamped groups.
- [x] Collision snapshot: per-mesh geometry version (the global epoch made every sync re-read all ~13 k members) and the
  auto player's part ids in a Set (was a linear scan per mesh): 3–11 → 2.7–3.3 ms.
- **Result** (interleaved, no wrappers): 30-tile street fly long tasks 11–24 (worst 75–100 ms) → 2–11 (worst 53–79 ms),
  frame-gap p95 16.8 ms (vsync); Play walk 3–41 (worst 70–132) → 0–6 (worst 54–66); 60-tile fly heap flat
  (1.7–2.9 GB, no trend). Switch: `sm.setStreamHitchOptions3D({...})`.
- [ ] Left: draw-list / cull-range spikes in landing frames (step 4), the compaction's bookkeeping CPU (5–16 ms), worker
  message deserialisation (13–15 ms), GPU-backpressure stalls in tiny writes, a delta-driven collision sync.
- [x] P19 follow-ups (2026-10-03, performance-plan §P19): worker messages deserialised one group per part
  (`messageParts`); a cancelled full build's recycled worker is replaced at once (`WorkerJobService.respawnRecycled`:
  the lane drained 8 → 0 in a Play run and a 3.4 s main-thread full build followed); no synchronous flat preview for a
  moving window (`standInFirst`). Still left: the compaction's bookkeeping (≤ 7 compactions a 60-tile fly) and the
  unbudgeted new mesh-slot writes (renderer / step-4 code).
- [x] P20 (2026-10-04, performance-plan §P20): the compaction's bookkeeping re-points moved keys' meshes instead of
  rebuilding every per-mesh map (`cheapCompaction`; same end state, but no measurable CPU win on a landed window: 20.5
  vs 21.6 ms median, inside noise — the move planning dominates); new mesh slots are budgeted world-side (≤ 600 new meshes attached a
  frame, `budgetNewSlots`); big groups come back in ≤ 48-layer / 6 MB worker messages (`splitParts`). Still left: the
  instance uploads of a landing tile's biggest array groups (one group packs whole: up to ~25–70 ms frames) and
  GPU-backpressure stalls.

## Step 4 — Persistent GPU scene + GPU culling + indirect draws (≈2–4 weeks) — the big CPU win
> **Status 2026-10-02: ON by default** (`Renderer3D.gpuDriven`; `sm.setGpuDriven3D({ enabled: false })` = the CPU
> path exactly). Built and verified pixel-identical (diorama, tiled, streamed; street to sky; Play; fog horizon; night,
> Cel HD + ink, PS1 lo-res, resolution scaling, planar mirror, SSAO; motion; a 30-tile streaming fly):
> - **Phase A:** the opaque main pass.
> - **Phase B:** near / far twins, P11 cull ranges and the prepasses on the GPU.
> - **Phase C:** the shadow casters (far map + cascades) from the same records, with the P14 static caches kept.
>
> Play walk CPU (drawMeshes): diorama 5.2 → 2.9 ms, tiled 3×3 12.4 → 8.9 ms (mean). Phase D (Hi-Z) is not built.
> See performance-plan.md §P15.
>
> **2026-10-03: the GPU cost is mostly fixed.**
> - **Cause:** the old "+2–3 ms main pass" was partly a timing-driver artefact. The real part was the merged
>   full-shader pipeline, which made plain meshes run the heavy shader.
> - **Fix:** `mergePatterned` is off by default, and the draw rank now keys the plain / full shader and an 80 m cell,
>   in both paths, so the pictures stay identical (0 px at 16 poses).
> - **Now:** the main pass is within 0.2–0.4 ms of the CPU path at 1300×850, and the frame is +1.6–2.2 ms at
>   2500×1390 (was +4.4).
> - **Shadows fixed (2026-10-03, later):** the per-frame dynamic shadow layers draw from compact lists the GPU
>   appends to, K draws each (a CPU upper bound), instead of one indirect draw per caster record
>   (`sm.setGpuDriven3D({ shadowCompact })`, default on). GPU shadow passes 0.57 → 0.15 ms a frame (tiled, 1300×850;
>   the CPU path: 0.16), frame −0.5 ms (−1.2 at 2500×1390), 0 px at 16 poses and on 17 shadow walk steps.
>   Finished later the same day: the bound's box tests are cached per record and box epoch and the reach test is
>   kept (`boundReach`), so K ≈ the real caster count (tiled 512 / 256, was 2048 / 512) for ≈ +0.1 ms of main thread
>   net. Re-verified: 0 GPU errors with culling 'on' / 'auto' in the diorama, tiled and streamed worlds, geometry
>   present, 0 px (32 poses, 16 shadow steps), verify 0 missing.
> - **Left:** the main pass's ~13 k zero-instance indirect draws. ≈ 0.5 ms on an idle GPU, but +3 / +33 ms of main
>   pass at 1300 / 2500 when other applications load the GPU (a visible-only bundle costs what the CPU path costs).
>   The shadow trick does not carry over (order matters there; the cheap CPU bound is loose), see §P15.
> - **Mode:** `sm.setGpuCullingMode3D('auto' | 'on' | 'off')` (default Auto, per-machine). Auto was retuned after
>   live runs showed it flapping under GPU contention.
- [x] **Persistent scene.** Objects are registered once in GPU buffers (geometry pool + instance data, which
  mostly exists already) and updated only when they change. No per-frame rebuild of a 13k-entry draw list in
  JavaScript.
- [x] **Compute culling** (Hi-Z occlusion not built). A compute shader tests every object or cluster box against:
  - the frustum;
  - the distance-LOD and fog-horizon rules;
  - the near/far twin choice, cull ranges and occlusion (Hi-Z from the previous depth).

  It writes the draw lists into indirect buffers.
- [x] **Indirect draws** (one per record in render bundles; multi-draw-indirect opportunistically). Merge geometry into a few big batches by pipeline/material, and draw each batch with
  `drawIndexedIndirect`. Browsers' WebGPU has no multi-draw-indirect yet, so batch by shared mesh (instancing)
  or merged buffers.
- [ ] **Consolidate the stacked LOD systems** into this one place: zoom tiers, distance LOD, twins, fog cull,
  cull ranges, occlusion, massing. One set of rules on the GPU, with one set of stats read back.
- [x] Keep every A/B switch working during the transition, and keep the CPU path as a fallback.

## Step 5 — HLOD: merged distant blocks and districts (≈1–2 weeks)
- [x] A tile far away is one simplified merged mesh. Mid-distance, one merged mesh per block. Near, the
  individual buildings and props. (As built: far = 3 draws a tile; mid = per-tile merged shells in colour buckets.)
  - Levels swap by distance with the dither fade.
  - Built in the worker; extends the current massing tiles and fog-horizon phase 3 (silhouette tiles).
- [x] Endless skyline: stream silhouette/HLOD tiles well past the full-detail window, plus an optional impostor ring.
  (Skyline distance 10 tiles by default, up to 24; the impostor ring is built since P19, off by default.)
- **Status (2026-10-03): BUILT, ON by default** (performance-plan §P17, docs/ui/performance.md §HLOD). HLOD is the
  Outside tiles mode `'hlod'` and the default (`WorldManager.DEFAULT_OUTSIDE_TILES`; ortho / 2D keep Flat / Massing).
  `src/world/tile-hlod.ts` (mid "tx,tz|h": merged shells in ≤ 5 wall + ≤ 3 roof colour buckets, archetype roofs,
  landmarks, merged ground, ~12 draws / ~2.5 MB; far "tx,tz|f": ground + walls + roofs, 3 draws / ~0.65 MB), built in
  the worker; `hlod-select.ts` (mid / far by eye distance, 15 % band, the fog-Far rule; `setStreamHlod({ midTiles,
  skylineTiles, maxTiles, fade, fadeMs })`); the HLOD LRU (96 MB / 192); dither dissolves (flags2 bit 5) in the colour,
  shadow (dynamic casters on both paths) and AO / SSR passes, outline ink scaled.
  - The fly bugs (resume note's open item 1), fixed: (a) the heap leak was the GPU-driven scene: removed meshes stayed
    in `GpuDrivenMain._obj` until a full rebuild no removal requested (heap-snapshot retainer path
    `_renderer3D._gd._obj[i] → Mesh3D`; +30 MB/s in an HLOD fly, every streamed mode leaked) → `noteRemoved` +
    `DEAD_REBUILD`; (b) far tiles drained away because HLOD groups reassembled behind every full-tile job and the slice
    (→ prio -1, one-shot) and the cheap class had 2 workers (→ `CityStreamSource.hlodBoost` / `fullCapFor`); (c) a
    dissolved swap's disposals now re-arm the pool compaction.
  - Validation (1 tile/s rooftop flies): 60 / 120 tiles: GC'd heap 723–783 / 787–842 MB (flat), pool 112–137 MB,
    outside tiles median 104 / 102 (min 75 / 56), long tasks in flight 30 / 26 (max ~93 ms), landing 6 / 15 (max 65 /
    102 ms). Pose A/B at skyline 5 with the 3-draw far level: rooftop 2308 draws / 4.27 M tris vs flat 2344 / 3.81 M,
    sky 1005 / 1.60 M vs 884 / 1.41 M, far 127 / 0.25 M vs 471 / 0.38 M. Visual: dissolve frame sequence and Hard-edge
    fog silhouettes checked (pupdrive/hlod/visual.js). Frogmarks: Outside tiles "HLOD (distant buildings)" (default) +
    "Skyline distance" slider.
  - Left: browser check of the shadow / AO dissolve on a real GPU.
  - [x] P19 (2026-10-03, performance-plan §P19, docs/ui/performance.md §Streaming at speed): a speed-aware window
    (prediction + ahead-first queues; fast ≥ 0.75 tiles/s = HLOD stand-ins, no new full builds; a capped CORRIDOR of
    full tiles for a Play run, from the measured landing time), old full / flat tiers dissolve out (flags2 bit 5,
    4 steps), the outside set no longer dips (fly min 115–121 of ~130 vs 5–48 with P19 off), the impostor ring (built,
    off by default: `setStreamHlod({ ring: true })`). Switches: `sm.world.setStreamMotion(...)`.

## Step 6 — Temporal upscaling (≈1–2 weeks, after step 4) — BUILT 2026-10-03, default OFF (performance-plan §P18)
> `sm.setTemporalAA3D({ mode: 'off' | 'taa' | 'taau', scale, sharpen, retroOff, inkOff })` / `getTemporalAA3D()`;
> `src/renderer/3d/temporal-aa.ts` (+ a small "Temporal AA" glue section in renderer-3d.ts). A per-machine viewport
> preference like resolution scaling. Frogmarks: "Anti-aliasing / Upscaling" in City → Performance (Resolution) and
> Global → Rendering. See docs/ui/performance.md §Temporal anti-aliasing and upscaling.
- [x] Jitter the camera by a sub-pixel amount each frame, keep a history buffer, reproject it with motion vectors,
  and blend.
  - Render at about 65% and reconstruct a sharp image. (TAAU: 0.65 default, or the resolution scaler's scale.)
  - It also turns the dither fades into smooth fades. (The fog-band / HLOD Bayer pattern shifts every TAA frame;
    a faint residue is left in a still.)
- [x] Motion vectors for everything that moves: skinned characters, instances, wind sway, trains, and the PS1
  vertex wobble.
  - As built: camera reprojection from depth for everything, plus a velocity pass for the movers (every mesh the
    transforms fast path rewrote this frame: traffic, trains, walkers, rigid Play parts) and the visible skinned
    parts (previous skin matrices + previous model).
  - Not tracked: wind sway (sub-pixel per frame; the variance clip absorbs it), instanced groups (they move only by a
    full repack), the PS1 wobble (the retro looks force TAA off).
- [x] Note (P13): in a tiled world the pan-time dynamic resolution (0.78×) is kicked on every camera move, so Play
  in a streamed world always renders at 0.78 (main pass 1014×663). Decide whether Play should opt out.
  Done in step 2: the `motion` setting (default `'auto'`: Play drops only while the GPU frame is over budget).
- [x] Handle ghosting on fast movers. Offer it per look, since retro pixel looks may prefer it off. It works with
  the existing resolution scaler.
  - Done: closest-depth velocity dilation, a one-sided depth disocclusion test, a YCoCg variance clip that tightens
    with motion and on object-velocity pixels. PS1 lo-res always wins; `retroOff` (default true) also covers vertex
    snap / ordered dither / global colour depth / UV snap; `inkOff` (default false: the ink resolves cleanly).
  - Left: switch the default on after a real-GPU browser pass (the user's monitor), and decide per look in the
    Frogmarks look presets.

## Step 7 — Shadows (≈3–5 days; can run alongside steps 3–4) — done 2026-10-02 (performance-plan §P14)
- [x] Range-cull the far shadow map's casters against the shadow-reach volume. In tiled worlds it redraws about
  6 M triangles on each refresh.
  Done: per-caster index runs against the light box (cached static layer) / light box ∩ reach (direct path, movers),
  expanded only on frames the map renders. Tiled street poses: 6.7–7.6 M → 3.6–4.9 M triangles and −0.8 to −0.9 ms GPU
  per refresh. Streamed tiles now join the cached layers in batches (200 k triangles or 120 frames) instead of one
  re-render each; a detach still re-renders at once.
- [x] Split the near cascades into static and dynamic layers, like the far map. They re-render 0.8–1.1 M triangles
  every Play frame.
  Done: a cached static layer per cascade + the dynamic casters on top each refresh, with a 64-texel box slack.
  Play poses: 0.9–1.3 M → 0.29–0.45 M cascade triangles a frame (−64 to −67 %), cascade GPU −0.1 to −0.18 ms.
  Frozen-clock A/B with the player walking, sway, movers and a moving sun: 0 differing pixels (one tiled step: 6 px at
  2/255).
- [x] Offer shadow quality presets: 3×3 PCF, one cascade, resolution.
  Done: Low / Medium / High (= today) / Ultra (`shadow-quality.ts`) via the city LOD settings and
  `setShadowQualityPreset3D`; Frogmarks City → Performance and Global settings selects.
- [ ] Left: a second cached level for the cascades (movers at the cascade interval, only the player every frame), and
  cheaper run expansion on far-map refresh frames (+~1 ms CPU in tiled).

## Step 8 — Specialised shaders — BUILT 2026-10-04, default ON (performance-plan §P21)
> `sm.setShaderVariants3D({ enabled, max })` / `getShaderVariants3D()`; `src/renderer/3d/shader-variants.ts` (+ small
> glue in pipeline-3d.ts / renderer-3d.ts). See docs/ui/performance.md §Shader variants.
- [x] Compile variants of the main fragment shader for common material combinations (plain building, plain
  ground, glass, foliage), so most pixels don't carry 32 optional features. Use the warm-up system to hide
  compile time.
  - Done: coverage profile by pixel (ground ~30 %, roof grid 12–21 %, window facades 13–24 %, metal ~9 %, glass ~9 %,
    plain ~6 %); a variant = the uber-shader source with the flags line as a constant, for 16 listed feature families
    (any look), keyed on the exact flags value; the uber-shader stays the fallback and draws until a variant lands
    (background compile, VARIANT priority after the common set; 0.7–1.6 s each vs 1.9–2.4 s for the uber, headless).
  - Identity: 0 px in all 174 frozen-clock pairs (diorama and tiled; street / rooftop / sky / far / Play; PBR, Cel,
    Cel-HD + ink, ink, toon, PS1, night, fog horizon, TAA, HLOD dissolve, SSAO; CPU and GPU path); the variant id joins
    the draw rank always (`rankVariants`), so the A/B never moves coplanar draws.
  - GPU: main pass −30 to −40 % (tiled 1300: −2.7 street to −4.9 ms sky; tiled 2500: −8 to −11.5 ms; diorama 1300:
    −1.1 to −2.9 ms), A = B noise ≤ 0.4 ms (1.2 at 2500).
  - Left: skinned meshes, the planar-mirror pass and textured families still use the uber / plain shaders; a real-GPU
    check.

## Step 9 — Fog horizon remaining phases
- [x] Phase 3 (silhouette tiles): folded into step 5 (HLOD, 2026-10-03; fog-horizon.md §P3 status).
- [ ] Phase 4: the dither cross-fade for every detail swap (vending cut-off, crowd, prop and tree twins).

## Later / only if needed
- [ ] **Renderer in a worker** (OffscreenCanvas): a big refactor.
  - Every synchronous API becomes async or mirrored; picking, gizmos, the 2D layers and DOM overlays need rework;
    adds one message hop of input latency.
  - Not now. Steps 2 and 4 get most of the benefit.
- [ ] **CPU occlusion cull** (built, off by default): enable it only if a GPU gain shows at high resolution;
  otherwise it is replaced by Hi-Z in step 4.

## Other open items worth tracking (from bug-hunt-2026-10-01.md)
- [x] GPU device-lost recovery, and a WebGPU-unavailable overlay. **Done 2026-10-03** (docs/ui/device-recovery.md):
      automatic recovery (new device, document rebuilt from CPU data + an exact raster read-back shadow), repeated
      losses verified leak-free, saves / exports wait through it; Frogmarks banner + "waiting for Play" toast.
      Still not covered: the Shell UI scene (host re-mounts), HTML textures, live cloth sims, Play (stopped).
- [x] A .frogmarks export made during Play still captures the in-game state. **Done 2026-10-03** (G14: `packProject` waits for Stop).
- [ ] Decide on a default tile radius of 3×3 instead of 1×1 (Frogmarks), and whether "Outside tiles" is saved.

## Architecture verdict (2026-10-01)
**The foundations are right:** a geometry pool, per-object GPU storage data, async pipelines, a worker job
system, a streaming manager, chunking and LOD, and deterministic seeded generation.

**The weaknesses:**
- object granularity: many tiny unique meshes, and a baked crowd;
- a per-frame CPU rebuild of all draws;
- the editor and the game sharing one thread;
- one giant shader;
- several stacked LOD systems.

**Steps 3–5 fix these without a rewrite.**
