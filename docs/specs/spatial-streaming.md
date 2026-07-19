# Spatial Streaming — Spec

> **Status:** **Phases 0–3 + 5 BUILT** (2026-07-16) — the generic `StreamManager` + `StreamSource` engine and a
> `CityStreamSource` drive the tiled world (identical behaviour, general seam); the tile window is
> **focus-relative**, **follows the camera**, and is **zoom-adaptive** (`salsaWorld.streamFollow(true)` → pan loads
> ahead / unloads behind; zoom resizes the window + demotes far tiles to cheap proxies → **memory scales to the
> view**). Default OFF = the origin diorama. A second source (`DepthStreamSource`, the depth/scale axis) proves the
> engine generalises beyond cities with no engine change. **Phase 4 (street-level per-tile life) is the only one
> left** — deferred until the street-level view exists. Built one phase at a time; each testable in isolation.
> **Thesis:** *Load only what the focus needs, at the detail the view warrants; unload the rest.* A **content-agnostic,
> toggleable** engine — the city is the flagship, but the same primitive serves products, sims, and material structure.

## Why this is a general primitive (not a city feature)

Everything expensive in a 3D scene obeys one rule: **you can only see a bounded amount at once.** A 9-city tiled world
holds 498 MB resident but you're ever looking at one corner. A zoomed-out planet doesn't need street furniture. A
product zoomed to its surface doesn't need the *inside* until you cut into it. Streaming is the engine that exploits
that rule generically: given a **focus** + a **budget**, decide which chunks of the world are live, at what detail,
and load/dispose to match — as the focus moves.

There are **two axes**, and this design covers both with one abstraction:

- **Horizontal / positional** — pan across a world larger than memory (city tiles, an open map). The focus slides in
  XZ; tiles ahead load, tiles behind unload.
- **Depth / scale (hierarchical)** — zoom *into* finer structure that doesn't exist until you approach it (a
  packaging product → its board's fibre grain; a sim material → its micro-structure; a building → its interior). The
  focus descends a scale hierarchy; the finer level streams in, the coarser level can drop.

Both are "the focus entered a region → realise its chunks at the right detail; it left → free them." Games call the
positional case *world streaming* and the scale case *HLOD / clipmaps*; unifying them is the point of this spec.

**User-facing north-star (the theoretical thoughts that motivated this):** a product/structural creator where zooming
"way in" streams in material micro-structure, a sim that reveals finer physical detail as you descend, a street-level
walk where only the blocks around you are high-detail. All are the *same* engine with a different `StreamSource`.

## What already exists (reuse, don't rebuild)

The tiled city already contains most of the machinery — this spec generalises it, it does not start from zero:

- **Tile cache** (`world-manager` `_tiles: Map<key, MeshGroup3D[]>`) — realised chunks keyed by coord.
- **Async build pump** (`_tileQueue` + rAF, ~10 ms slices) — builds newcomers without a frame hitch.
- **Reconcile step** (`_syncNeighborTiles`) — diffs a target set vs. the cache; drops out-of-range, queues newcomers.
- **Content signature** (`_tileSigOf`) — invalidates the cache only when *baked* params change (movers/post excluded).
- **Deterministic content** — a chunk is a pure function of `(coords, seed, params)` (`tileSeed`/`offsetGraphGeometry`),
  so an unloaded chunk regenerates *identically* — streaming stores **nothing**; the world is always re-derivable.
- **Composes with the perf stack** — 2-tier zoom **LOD**, spatial **chunking** (`detailGrid`), **instancing**
  (ArrayGroups), the **material fast-path**, and per-array-group frustum cull. Streaming decides *which* chunks are
  live; those systems make each live chunk cheap.

The gap streaming fills that none of the above can: **memory scales to the VIEW, not the world.** LOD/chunking cull
*draws* but keep geometry resident (the 498 MB stays); streaming **disposes** it.

## The abstraction

```ts
// A StreamSource owns one kind of streamable content. City / product / sim / material each implement it.
interface StreamSource {
  // The chunk coords the focus needs, given the current view budget. Positional sources return an XZ window;
  // hierarchical sources return a depth band. Cheap + pure — called every reconcile tick.
  targetChunks(focus: Focus, budget: StreamBudget): ChunkKey[];
  // Realise one chunk (build geometry into a container, async-friendly) / dispose it (free GPU + JS).
  build(key: ChunkKey): ChunkHandle;      // deterministic from key + seed + params
  dispose(handle: ChunkHandle): void;     // frees vertex/index buffers, evicts caches
  // Detail tier for a chunk at this distance/scale from focus (full | reduced | proxy). Drives per-chunk LOD.
  detailFor(key: ChunkKey, focus: Focus): DetailTier;
}

type Focus = { x: number; z: number; scale: number };   // world position + a scale/zoom (for the depth axis)
type StreamBudget = { loadRadius: number; detailRadius: number; unloadRadius: number; maxLiveChunks: number };
```

The **StreamManager** is content-agnostic: it holds a set of `StreamSource`s, runs the reconcile loop against the
current `Focus`, and drives the shared async build pump + disposal. `worldMode:'tiled'` becomes *"the CityStreamSource
is registered"*; turning streaming off just unregisters sources (or pins a single chunk = today's diorama).

## Phases

Each phase is shippable and reversible; behaviour is unchanged until Phase 2 flips streaming on.

### Phase 0 — Extract the StreamManager + StreamSource (no behaviour change) ✅ BUILT
The tiled machinery now lives behind the general seam:
- `src/services/streaming/stream-manager.ts` — the content-agnostic engine: a live chunk cache, an async
  time-sliced build queue (~10 ms/frame, headless-safe), and the reconcile diff (`reconcile(target)` /
  `sync(focus,budget)` / `clear()`). Knows nothing about cities. Types: `StreamKey`/`Focus`/`StreamBudget`/
  `DetailTier`/`StreamSource<H>`.
- `src/services/streaming/city-stream-source.ts` — `CityStreamSource implements StreamSource<MeshGroup3D[]>`:
  `targetChunks` returns the fixed nearest-first grid around origin (Phase 0 ignores focus/budget), `build`/
  `dispose` delegate to the world manager via a small `CityStreamHost` interface.
- `world-manager.ts` — dropped the hand-rolled `_tiles`/`_tileQueue`/`_tileRaf`/`_pumpTiles`/`_clearTiles`;
  `_syncNeighborTiles` now just computes the content sig + calls `_stream.sync(...)`. `_buildTile` returns groups
  (the manager owns the cache). Behaviour is identical.
- `stream-manager.test.ts` — 7 headless vitest cases lock the reconcile/dispose/order/idempotence behaviour.

Toggle framing: streaming default OFF = a single pinned chunk (the current diorama); `worldMode:'tiled'` is what
registers the city source's neighbour grid.

### Phase 1 — Focus-relative window ✅ BUILT
`CityStreamSource.targetChunks(focus, …)` now builds a `tileRadius` window around the **focus tile**
(`round(focus.xz / (2·radius))`) instead of a grid hardwired to origin, nearest-**to-focus** first, still skipping
the origin (0,0) centre-city tile. The world manager passes a `_streamFocus` field (origin in Phase 1). With focus
pinned to origin this is byte-for-byte the old grid; the window is quantised to whole tiles so sub-tile focus
movement can't thrash it. 5 headless vitest cases (`city-stream-source.test.ts`) cover origin=old-grid, a shifted
window, sub-tile no-op, 5×5, and the empty (`tileRadius 0`) case. Phase 2 just moves `_streamFocus`.

### Phase 2 — Focus-driven streaming (the "move through the world" moment) ✅ BUILT
`world-manager` registers a second pre-render callback (`_streamCb`, beside the LOD one) that reads the orbit
**look-at** (`camera.target`) in city-local space, snaps it to a focus tile through `hysteresisTile` (a 0.65-tile
deadband so hovering a boundary can't thrash), and — only when the focus **crosses a tile boundary** — moves
`_streamFocus` and calls `_stream.sync(...)`. The reconcile disposes tiles behind and queues tiles ahead through
the async pump, so **memory is already bounded to the window while panning** (a real slice of Phase 3's win, for
free). Decisions locked in: focus = **camera target** (stable under orbit; swappable to a player pos for the
Phase-4 street view); zoom does **not** move the focus (dolly changes radius, not target) — that's Phase 3's axis.
- Toggle: `salsaWorld.streamFollow(on)` — **default OFF** (origin diorama, zero per-frame cost); off snaps the
  window back to origin. Diagnostics: `salsaWorld.streamStats()` → `{follow, focusTile, live, pending, building}`.
- `hysteresisTile` is a pure exported helper with 3 vitest cases (deadband hold, boundary no-flicker, big-jump snap).
- Known Phase-4 refinements: the origin (0,0) centre city stays resident (never streamed); focus uses translation
  only (city rotation deferred); cadence is per-frame-check / per-boundary-sync (fine — the check is a few multiplies).

### Phase 3 — Distance detail + **unload** (the memory win) ✅ BUILT
The streaming **budget** is now zoom-derived (`_streamBudget`), so the window resizes and far tiles demote:
- **Window radius** = `metric/span` (visible half-extent in tiles) + a 1-tile prefetch ring, clamped to
  `tileRadius`, stabilised by the same `hysteresisTile` deadband. Zoomed OUT ⇒ big window (keep-all, auto-fallback
  to today); zoomed IN ⇒ tight window, tiles past it **disposed** by the reconcile → **VRAM scales to the view**.
- **Detail is a ZOOM decision, not a distance one** — the key insight for the **ortho** builder view: every visible
  tile is the same on-screen size, so "far = small" is false. When zoomed in (tiles large on screen) the whole
  window is full; when zoomed out (tiles tiny) only the focused ring stays full and the rest become cheap flat
  **proxies**. The tier is encoded in the chunk key (`"tx,tz"` vs `"tx,tz|p"`, `tileKey`/`parseKey`), so a zoom
  change that reclassifies a tile makes the generic reconcile dispose the old build and make the new one — the
  `StreamManager` needs no detail concept (so `detailFor` from the abstraction wasn't needed; the source owns it).
- **Proxy is inert for default worlds**: it only differs when a tile would be a full 3D city (`tileDetail:'full'`);
  flat/focus neighbours keep the plain key, so no dispose/rebuild churn and **byte-identical to Phase 2** there.
- Follow OFF ⇒ a full budget (window = detail = `tileRadius`) ⇒ exactly today's all-full grid.
- `salsaWorld.streamStats()` now also reports the live `window` (`"load,detail"`). 20 streaming vitest cases
  (10 source + 10 engine) cover the window clamp, proxy tiers, the non-full no-proxy rule, and key round-trips.
- Reserved for later: `unloadRadius` (currently = `loadRadius`; a separate load<unload hysteresis band) and
  `maxLiveChunks` enforcement (the window radius already bounds live count to ≤ 49).

### Phase 4 — Street-level hook
Street view sets a small `unloadRadius` + a tight `detailRadius`, so only the blocks around the player are high-detail
and the rest is disposed. Per-tile **life** (clouds/pedestrians/traffic) becomes first-class here — each live tile can
own its movers instead of the whole world sharing the centre's (fixes "clouds only over the original city"). Ties to
[[street-level-mode]].

### Phase 5 — Non-city StreamSources (the generalisation) ✅ BUILT
`src/services/streaming/depth-stream-source.ts` — `DepthStreamSource<H>`, a second `StreamSource` on the **depth /
scale axis**. Where the city streams a window of tiles around a world POSITION, this streams a band of structural
**levels** around a zoom DEPTH (`focus.scale`): `targetChunks` returns `["L<n>", …]` for the levels within `band`
of `round(levelForScale(scale))` (current level first), clamped to `[minLevel, maxLevel]`; `build`/`dispose`
delegate to caller `buildLevel`/`disposeLevel`. As you zoom "way in", finer levels stream in and coarser ones drop
— the material-microstructure / product-internals / sim-detail use the whole spec was written for. It is fully
content-agnostic (a caller supplies the level mapping + geometry); `octaveLevel(base, factor)` is a ready-made
geometric mapping. **The proof: the identical `StreamManager` drives it** — 10 vitest cases including an end-to-end
"zoom deeper → build finer levels, dispose coarse ones" run through `StreamManager.sync`, no engine change. This is
a reusable template; a future product/material/sim app registers a `DepthStreamSource` the way the city registers a
`CityStreamSource`.

## Cross-cutting requirements (every phase)

- **Determinism = free persistence.** A chunk is a pure function of `(key, seed, params)`. Streaming persists
  **nothing** — save the seed/params, re-derive on demand. Never serialise streamed geometry.
- **Async, no hitch.** All `build` work goes through the existing time-sliced rAF pump (~10 ms budget/frame); a chunk
  entering range never blocks a frame. Prefetch one ring beyond `loadRadius` so motion doesn't reveal empty space.
- **Reconcile cadence.** Recompute the target set on **focus-tile change** (crossed a tile boundary) + a slow
  heartbeat, NOT every frame — the per-frame cost stays O(live chunks), not O(world). Matches the ScheduleWakeup
  cache-window discipline: don't poll faster than the state changes.
- **Budget-aware.** `maxLiveChunks` is a hard ceiling; over budget → drop the farthest / coarsest first and `log` the
  cap (no silent truncation — a dropped ring must be visible in a stat, not read as "covered").
- **Composes, doesn't replace.** Each live chunk still uses LOD + chunking + instancing + the material fast-path.
  Streaming is the outer loop; those are the inner optimisations. Order of leverage: cull draws (LOD) → batch
  (instancing) → free memory (streaming).
- **Toggleable + content-agnostic.** Default OFF (single pinned chunk = diorama). Any content registers a
  `StreamSource`; nothing in `StreamManager` knows about cities.

## Trade-offs (name them, don't discover them)

- **Chunk size** — too large ⇒ load hitches + wasted resident detail; too small ⇒ reconcile/draw-call overhead (we
  already hit this with `detailGrid` — 9-city × fine grid = 8000 draws). Tune per source; expose as budget.
- **Pop-in** — a chunk appearing as you cross a boundary. Mitigate with hysteresis + a prefetch ring; accept a proxy
  tier so *something* is always there.
- **Focus thrash** — orbiting near a boundary. Hysteresis + tile-quantised focus (only re-target on tile change).
- **Depth-axis blending** — crossing a scale level (Phase 5) needs a cross-fade or the finer level "pops"; a dither/
  alpha transition over a scale band avoids it.

## Recommended implementation order

**0 → 1 → 2 → 3 → 5 are done.** Only **4** (street-level per-tile life) remains, and it's deferred until the
street-level view exists — its tight-window part already works via Phase 3, and its remaining parts (per-tile
clouds/pedestrians/traffic, unloading the origin city, focus rotation) belong with that view. Phase 3 is the one
that changed what's *possible* (world > memory); Phase 5 proved the engine is content-agnostic.

## Verification (per phase)

`npx tsc --noEmit` → regenerate a tiled world → **measure** with `salsaWorld.frameStats()` / `salsaWorld.perf()`:
resident `meshes`/`instances`/mesh-MB should **fall** as tiles unload (Phase 3); `drawCalls`/`msUpload` stay flat as
the world grows (streaming keeps per-frame cost O(live), not O(world)). Pan across a boundary and confirm no frame
hitch (async pump) and no pop (prefetch + hysteresis).

Links: [[world-generation]] · [[street-level-mode]] · [[world-borders]] (tile/planet expansion) · the perf stack
([[instancing-blocks]], `city-lod`, the `detailGrid` chunking toggle).
