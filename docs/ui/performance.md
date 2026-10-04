# Performance — host integration

Engine plan: `docs/specs/performance-plan.md`. This page covers what a host (Frogmarks) wires up. All APIs are on `ShapeManager` (`sm`) unless noted.

## Shader compile status (P2.3) — the "Preparing shaders… n/m" toast

WebGPU compiles every shader pipeline the first time it is needed. Since P2 the engine never blocks a frame on a compile. It compiles in the background (`createRenderPipelineAsync`), skips the draws that are waiting for one, and redraws when the compile lands. The scene can appear in pieces for a moment: a character a beat after the city, or bloom a frame late. The toast tells the user why.

```ts
import type { PipelineWarmupStatus } from '@zaings/salsa';

// One-shot read
const s: PipelineWarmupStatus = sm.getPipelineWarmup3D();
// { pending, total, compiled, failed, waitingDraws, ready }

// Live updates. Safe to call before the GPU device exists (it attaches when the device is ready).
// Notifications are coalesced to at most one per microtask, so no extra throttling is needed.
const off = sm.onPipelineWarmup3D((s) => ngZone.run(() => {
  this.shaderToast = s.waitingDraws > 0 ? `Preparing shaders… ${s.compiled}/${s.total}` : null;
  cdr.markForCheck();
}));
// later: off();

// Await "everything compiled", e.g. before a scripted screenshot
await sm.whenPipelinesReady3D();
```

| Field | Meaning |
|---|---|
| `pending` | Pipelines queued or compiling right now. |
| `total` | Every pipeline requested so far (`compiled + pending + failed`). It grows as features are turned on. |
| `compiled` | Pipelines ready to draw. |
| `failed` | Pipelines that failed to compile. Their draws are skipped for good, and the console logs a `[Salsa][pipe-cache] … failed` error. |
| `waitingDraws` | Pending pipelines that a frame has already asked for. **While this is above 0, content is visibly missing.** |
| `ready` | `pending === 0`. |

**Recommended toast rule:** show it while `waitingDraws > 0`, and hide it when that reaches 0. The background warm-up keeps `pending > 0` for a while after boot even when nothing is missing. Showing the toast on `pending` alone would flash it on every page load.

`sm.bootAndWarm()` (existing) still starts the background warm-up early, for example from the Shell at mount. The engine also schedules the warm-up itself at device-ready, so calling it is optional.

## How the engine behaves (for QA)

- **Opening a document directly.** The first frames draw whatever is already compiled. Meshes, characters, outlines and post effects pop in as their pipelines land, with no freeze. The draws a frame actually needs compile first. The rest of the common set (and the variants the document uses but has off-screen) compile in the background, at idle priority, two at a time.
- **First character, or turning on outline / bloom / SSAO / FXAA / the PS1 lo-res path.** The feature appears a moment later instead of freezing the page. A pending post-process chain presents the scene unprocessed. A pending shadow pass leaves the scene fully lit, never black. Pending SSAO means no occlusion.
- **Captures and exports** (thumbnails, `captureArtboardRegionCanvas`, PDF/print, cloth bakes) still get complete images. Outside the live frame loop, a missing pipeline compiles synchronously, as before. An async bake awaits it.
- **A/B switch (diagnostics only):** set `globalThis.__salsaPipelineMode = 'sync'` before the engine boots to restore the old blocking behaviour.

## For engine code adding a new pipeline

Never call `device.createRenderPipeline` / `createComputePipeline` in a per-frame path. Register the pipeline through the cache instead:

```ts
import { GPUPipelineCache, PipelineSet, PIPELINE_PRIORITY } from '../core/gpu-pipeline-cache';

// One pipeline:
const h = GPUPipelineCache.for(device).render({ label: 'MyPass', layout, vertex, fragment, primitive });
// per frame:
const p = h.get(); if (!p) return;   // still compiling → skip; the cache schedules a redraw when it lands
pass.setPipeline(p);

// A pass with several pipelines that must run together (stencil steps, ping-pong chains):
private readonly _pipes = new PipelineSet(device, PIPELINE_PRIORITY.DOCUMENT);   // warms as soon as added
private readonly _a = this._pipes.render({...}, 'MyPassA');
run() { if (!this._pipes.ready()) return; pass.setPipeline(this._a.get()!); ... }

// Compute, or an async one-shot bake:
const c = GPUPipelineCache.for(device).compute(() => ({ layout: 'auto', compute: { module, entryPoint } }), 'MyBake', 'my-bake:key');
const pipe = await c.warm(PIPELINE_PRIORITY.NOW);   // null = compile failed → take the fallback path
```

Rules:

- When a pass's output is read later in the frame, gate both the producer and the consumer on the same `ready()`. Readiness cannot change mid-frame, because results that land mid-frame are published when the frame ends.
- A skipped producer must leave a neutral target (cleared depth = lit, white AO, zero reflection) and stay "stale", so it re-renders the frame its pipeline lands. See the shadow-pass handling in `renderer-3d.ts`.
- Priorities: `NOW` is an on-demand draw (bypasses the cap). `DOCUMENT` is needed by the open document or a just-enabled feature. `COMMON` is likely soon. `RARE` is tools and debug.

## Background work (P3) — the worker-job progress overlay

Since P3, heavy generation runs in Web Workers through one shared **WorkerJobService** (`src/services/workers/worker-job-service.ts`). This covers city builds and selective city regens, streamed tiles, character generation, advert and GARP sheet packing, and autosave PNG encodes. The page keeps animating while it works. A host can show a small "Building city…" overlay or progress bar from the service's progress events.

```ts
import type { WorkerJobProgress, WorkerJobStats } from '@zaings/salsa';

// One-shot read
const p: WorkerJobProgress = sm.getWorkerJobProgress3D();
// { queued, running, done, total, active, jobs: [{ id, kind, label, priority, p, running }] }

// Live updates (coalesced: at most one call per microtask). Fires on enqueue / start / progress / finish,
// and once more with active === false when everything settles.
const off = sm.onWorkerJobProgress3D((p) => ngZone.run(() => {
  const visible = p.jobs.filter((j) => j.priority !== 'background');   // don't show autosave encodes
  this.loading = visible.length ? { label: visible[0].label ?? 'Working…', frac: p.total ? p.done / p.total : 0 } : null;
  cdr.markForCheck();
}));
// later: off();

// Diagnostics: live workers per lane, the hardware cap, and per-kind run counts and timings
const s: WorkerJobStats = sm.getWorkerJobStats3D();
```

| Field | Meaning |
|---|---|
| `queued` / `running` | Jobs waiting for a worker, and jobs executing now. |
| `done` / `total` | Jobs finished, and jobs enqueued, since the service was last idle. Together they give a loading fraction. Both reset to 0 when the service goes idle. |
| `active` | `queued + running > 0`. |
| `jobs[].label` | Short human text: `Building city`, `Updating city`, `City tile`, `Generating character`, `Packing images`, `Saving`. |
| `jobs[].priority` | `interactive` (the user is waiting: a slider or a click), `visible` (on screen soon: streamed tiles, the document-load city), or `background` (autosave encodes). |
| `jobs[].p` | 0..1 progress, when a job reports it (most report only start and finish). |

**Recommended overlay rule:** while the document loads, show the overlay while any job that isn't `background` is active. Alternatively, keep using `onCityBuildStateChange` / `isBuildingCity()` for the city alone. After load, a slim non-blocking indicator is enough. Slider regens finish in under ~1.5 s, and the old city stays visible and interactive until the new one swaps in. `sm.world.isUpdatingCity()` is true while a selective regen (weather, pedestrians, furniture …) is still building.

### What runs where (for QA)

- **Document load with a city.** The city is generated in a worker: layout, every builder, drape, chunking and contact shadows. The main thread only wraps and uploads the result, time-sliced (≤ 6 ms per frame), then swaps it in within one frame. *Harness: the worst frame dropped from 1.4 s to ~0.1 s.*
- **Opening the City tool on a document with no city** (`sm.world.enterCityMode(params)`, and the Generate button, which calls it again with params). Since P5.W1 this no longer freezes. The call returns at once with a **layout-only graph**: regions, roads and lots are there, so `sm.world.regions` already fills the district list. The city is generated in the worker, reassembled time-sliced, and revealed in one frame. City mode's setup runs in that reveal frame: the workspace and camera framing, shadows sized to the city, the city lighting, and the edit pulse. The traffic (mover routes, geometry and the road network) is computed in the worker too; its meshes appear a few frames after the reveal, all at once.
  - Until the reveal, `sm.world.hasWorld` is `false` and `isBuildingCity()` is `true`. `onCityBuildStateChange` fires `{ building: true, reason: 'load' }`, so the existing pill reads "Building city…". Regenerating an existing city reports `reason: 'edit'` instead, and the old city stays up until the swap.
  - An `updateCity(p)` issued while that build runs, with the same params, **joins** it: nothing restarts. With different params it **supersedes** the build, merged onto its params, still non-blocking. Calling `enterCityMode()` with no args, or `enterCityMode(sameParams)`, while a build runs (a document-load build, or a re-opened panel) just waits for it.
  - `exitCityMode()` before the reveal cancels the deferred setup. The city still lands, placed like any illustration city.
  - *Harness: worst frame 2.7 s → ~150 ms. Since P5.W4 the traffic spawn, the GARP placeholder skin encodes and the sign rasterization are off the reveal frames too. What remains are the renderer's first frames with the new meshes (~50–100 ms).*
- **Tiled worlds** (`worldMode: 'tiled'`: switching to tiled, seed or layout changes on a tiled world, and document load). Since P5.W2 the centre tile also builds in the worker. The swap tears down the old tile grid, and the neighbour tiles then stream in as before. *Harness: worst frame 2.4–3.1 s → ~110 ms.*
- **Weather / pedestrians / furniture / signage / roof or corner style / lights …** (the selective regens). Only the affected groups are rebuilt, in a worker, on a copy of the city graph. The old groups stay visible until the new ones are uploaded, then swap in. A newer change to the same groups cancels the older job. *Harness: worst frame 1.1–2.3 s → ~30–60 ms.*
- **Railway / stations / seed / layout params** (full regens). These already ran in the worker; they now also get priority over streamed tiles and supersede an older build. *Harness: worst frame 1.2 s → ~0.1 s.*
- **Creating a character** (`createFullCharacter3D` / `createRandomCharacter3D`, the Play auto player). The body, garments and hair are generated in one worker job, and the main thread commits the meshes. Garments are applied in the order top → undershirt → underpants → socks → shoes → bottom → hair, which removes the old redundant hair refits. *Real app before: 370 ms frame. Harness after: ~70 ms warm, ~200 ms on the very first character (cold worker).*
- **Advert / shop images** (`sm.addSignageImages3D(items)`, and the batched `demoAdverts` / `pickAdverts`). Sheets are packed in an OffscreenCanvas worker. A batch produces one pack, one atlas rebuild and one city regen, and a host loop of awaited single `addSignageImage3D` calls is also coalesced into one regen. *Real app before: 14 s with 37 long tasks (worst 717 ms). Harness after: ~0.7 s, worst frame 120 ms (the dev-only demo image generation).*
- **Headless / no Worker (tests, SSR).** Every job runs the same handler on the main thread, one job per macrotask. With no `requestAnimationFrame`, `enterCityMode`, tiled builds and the city selective regens stay synchronous, as before.
- **A/B (diagnostics):** `salsaWorld.streamWorkers(false)` turns off the world lane: city builds, regens and tiles go back to the main thread. `salsaWorld.manager.trafficOffThread = false` restores the old one-shot traffic spawn after a city appears.

### For engine code adding a job kind

```ts
// my-jobs.ts — PURE (no DOM / WebGPU / scene-graph classes): imported by the worker AND the main-thread fallback
export const MY_LANE = 'my';
export const MY_JOB = { build: 'my.build' } as const;
export const myBuild: JobHandler<MyInput, MyOutput> = (input, api) => {
    const out = buildIt(input);              // deterministic
    api.transfer(out.vertices.buffer);       // zero-copy back (no-op in the fallback)
    return out;
};
// my-worker.ts
serveJobs({ [MY_JOB.build]: myBuild });
// my-lane.ts
import MyWorker from './my-worker?worker&inline';   // inlined → no asset resolution in the host bundler
const svc = getWorkerJobService();
svc.registerLane({ lane: MY_LANE, create: () => new MyWorker(), maxWorkers: 2 });
svc.registerKind({ kind: MY_JOB.build, lane: MY_LANE, handler: myBuild });   // handler = the fallback too
const h = svc.run<MyInput, MyOutput>(MY_JOB.build, input, { priority: 'interactive', key: 'my.build:' + id, label: 'Building' });
const out = await h.promise;   // rejects with JobCancelledError when superseded by a newer job with the same key
```

Rules:

- **Determinism.** The worker and the fallback run the same handler. The fallback structured-clones the payload first, as `postMessage` does. Add a vitest test that compares the worker-path bytes with a direct call (see `world-jobs.test.ts`, `character-jobs.test.ts`, `atlas-sheet-ops.test.ts`).
- **Never transfer cached buffers.** Transferring detaches a buffer. Copy module-cached geometry first (see `transferGroups`).
- **Builders that mutate shared state** (the city graph) must return the change. `world.groups` returns a graph patch that the main thread applies in place at the swap.
- **Keep the main-thread half small.** Results should be GPU-ready typed arrays. Spread mesh wrapping and uploads across frames: city results go through WorldManager's reassembly queue, which uploads per job within a frame budget.
- **Worker-only kinds** have no handler, or are run with `mode: 'worker'`. They reject with `WorkerUnavailableError`, and the caller keeps its own fallback (the tile and pixel pools do this).

## How LOD works (city level of detail, 2026-10-01)

Engine plan and measurements: `docs/specs/performance-plan.md` §P7. Nothing here needs host wiring; it is what decides how much of the city is drawn at each camera height, so QA knows what to expect.

Four mechanisms decide what draws. They stack: a mesh is drawn only if every one of them lets it through.

1. **Frustum culling per chunk.** The city's merged layers are split into spatial cells, and instanced layers (trees, vending machines, planters …) are split by instance position. Since P7, instances with 300+ triangles each (a tree's leaves, a vending machine's cans) may sit alone in a cell, so a species of 13 trees is no longer one city-wide box that never culls. Off-screen cells are not drawn and, unless their shadow can reach the view, do not cast.
2. **Zoom tiers** (`WorldManager`, global). One switch per tier hides every matching layer at once when a single *zoom metric* crosses the tier's threshold (10 % hysteresis):
   - **Metric:** under an ortho camera, `orthoSize`. Under perspective, `min(orbit radius, 2 × the camera's distance to the city volume)`. At street level, rooftop level and in Play that distance is about 0, so the zoom tiers never hide anything there.
   - **Thresholds** (F = 2.8 × the city radius; the default city: F ≈ 46 units ≈ 690 m): fine DETAIL at F, ROOF objects at 1.25 F, PROPS at 1.2 F, flat-map fine layers at 1.4 F, STRUCTURE (the rail viaduct, bridge dressing, shotengai fabric, landmark ornament, sign lettering) at 1.7 F. Ortho uses 0.3 × the city radius as F, so the 2D views thin out much earlier.
3. **Distance LOD per chunk** (the renderer). Every city mesh in a tier carries a `drawDistance`. The renderer stops drawing a chunk once the camera is farther than that from the chunk's own box (shows it again inside 0.9 ×). It applies in every pass and every perspective mode (free 3D, City orbit, Play):
   - **Lens:** distances are scaled by `tan(22.5°) / tan(fov / 2)`: 1 at 45°, 0.89 at the 50° street view, 0.57 in Play (72° third-person), so a wide lens drops detail sooner.
   - **Aerial bias:** the city adds the camera's distance to the city volume (≈ its height above the roofs) to the distance of the families that make the overview look rich. It is 0 at street level, ~45 m at rooftop level, ~300 m from the sky.
   - **Ortho:** every mesh is treated as being `orthoSize / tan(22.5°)` away (the zoom, the same across the view), with no bias.
   - **Per-family distances** (default city; metres at the 45° reference lens):

     | Family | Distance | Aerial bias |
     |---|---|---|
     | Vending-machine cans | 144 m | no |
     | Tiny clutter: the crowd, walkers, birds, wires, laundry, doors, steel railings, ducts, rail sleepers / rails / catenary | 411 m | no |
     | Small street furniture: signal housings, pole insulators, parked-car trim, tactile paving, cones, manholes, post boxes, cabinets, planters, benches, bikes, banners, bollards, tree grates | 411 m | no |
     | Utility poles and lamp posts | 822 m | no |
     | Facade detail: window trim, sills, juliet balconies, greenery, awnings, balconies, and the lit sign lettering, name plates and road signs | 411 m | yes |
     | Roof objects (equipment, roof clutter, markings) | 514 m | yes |
     | Props: trees, parked cars, bus stops, shopfronts, stairs, nobori flags …, and the contact-shadow blobs | 822 m | yes |
     | Flat-map fine layers: sidewalks, courtyards, plazas, parking | 960 m | yes |
     | Roads, building bodies and roofs, landmarks, water, lit signs, lamps and screens, movers | never | — |
4. **Near/far twins.** The static crowd has a detailed near version, a cheap mid version and (P9) a cheapest far version, swapped at 30 m and 100 m. Since P12 the near and mid versions are built only for the 50 m cells around the camera, and the far version is instanced (§Instanced crowd below). Chipped stone edges (terraces, railway) swap at 18 m. P9 heavy props also have a cheap far twin, built from the same primitive calls (`src/world/lod-accum.ts`): utility poles + insulators and signal housings at 45 m, lamp posts at 45 m, roof plant (detailed buildings) at 60 m, parked and traffic cars' trim + chrome at 35 m. A prop far twin drops parts under ~1 px at its swap distance (bolts, braces, thin rods) and uses fewer ring sides; with distance LOD off the full prop draws. No aerial bias; ortho swaps by zoom. The prop swap distances are `'twin'` tiers in `WorldManager.cityDistanceTiers` (so the Performance panel lists them as families; their multiplier scales the swap distance). The traffic cars' trim and chrome also take the small-props draw distance.
5. **Resolution (P9).** On a canvas shorter than 900 px every draw and swap distance shrinks in proportion (down to 0.6×), so a small view drops detail sooner. They never grow on a big canvas by default (`Renderer3D.LOD_RES_MAX = 1`; 2 lets a 4K view keep detail farther, at a GPU cost). The canvas height is used, never the resolution-scaling target, so auto resolution cannot make LOD pop.
   - **Tree crowns (P8):** every tree's leaf and tip cards have a far crown that keeps one card in three, each grown to cover the same crown. It swaps in past 160 m (a `'twin'` tier in `cityDistanceTiers`, so the Performance panel lists it as a family). The trunks never swap. A/B: `Renderer3D.groupTwins = false` shows the full crowns everywhere.
5. **Shadow LOD (P8).** The sub-metre classes (cans 0.12 m, the crowd 0.8 m since its shadow is long, tiny clutter and small street furniture 0.4 m, poles 0.3 m) carry a feature size. A caster leaves a shadow map's casters only when both tests agree: the map's texels are coarser than its feature, and the feature is under 2 px at the camera's height above the city. Each map decides for itself. At street and roof level nothing changes. From the sky (texels ~0.7 m, features under a pixel) the small classes drop out of the far map. A/B: `Renderer3D.shadowSizeLod = false`.

6. **Cull ranges (P11).** A heavy merged mesh (≥ 2,048 triangles) that is only partly in view draws only its 256-triangle runs inside the view, and inside each near shadow cascade. This matters most for streamed tiles: one mesh per layer per tile, a 420 m box. The image is identical (A/B `sm.renderer3D.constructor.rangeCulling = false`). In a 3×3 tiled world at street level it cuts the main pass by ~15–30 % and the near cascade by about half.
7. **Occlusion (P11, off by default).** `sm.renderer3D.constructor.occlusionCulling = true` also skips meshes hidden behind building walls. Nothing pops, but it costs 1–4 ms CPU a frame for no measured GPU gain, so it is an experiment, not a setting.

**Reading the stats HUD.** "in scene N tris" (the old headline, `getRenderStats3D().triangles`) is everything loaded. It does not change with the view. "tris drawn" (`drawn.main`) is what the colour pass drew last frame, after all of the above. "shadow" is the shadow maps at their last refresh. In a tiled world at street level expect ~36 M in scene, ~5–6 M drawn, and ~1 M shadow per frame.

Also: off-screen skinned characters are not drawn or skinned and their idle pauses; the traffic tick skips hidden and off-screen movers and throttles far ones.

### What you get at each height

| Camera | What decides detail | What you see |
|---|---|---|
| **Street level** (eye 1.6 m, free 3D or City) and **Play** (third person) | Distance LOD + twins only (zoom metric ≈ 0, bias ≈ 0) | Full detail around you; down a long street the crowd, signs, small furniture and facade trim stop at ~370 m with the 50° street lens (Play ~230 m), trees and cars at ~730 m (Play ~470 m). |
| **Rooftop** (~45 m) | The same, with a ~45 m bias on facade / roof / props | Practically the street-level set, seen over the roofs. |
| **Sky** (~300 m) | Distance LOD with a ~300 m bias on the overview families; the zoom tiers are still all on (fine detail starts to go at ~380 m altitude for a diorama) | Buildings, roofs, roof equipment, trees and facade texture across the whole view; people, signal housings, wires and other sub-metre clutter only within ~370 m of the camera (cans ~130 m). |
| **Far out** (the whole city small on screen) | The zoom tiers | Detail, props and roof objects go first, then sidewalks / plazas, then the viaduct, bridge dressing and sign lettering: roads and road paint, building bodies, roofs, lit sign panels, water and the movers remain. |
| **2D ortho / 2D perspective** | Zoom tiers by `orthoSize` (much earlier than 3D) + distance LOD by zoom | The 2D view thins out as you zoom out, uniformly across the frame. |

### Diorama vs tiled worlds

- **Diorama:** the city is small (default radius ≈ 245 m), so at street level every chunk is within the fine distances and the distance LOD hides almost nothing; the zoom tiers own the overview.
- **Tiled worlds:** the same per-chunk rules run on every tile, which is where the distance LOD pays. The zoom metric uses only the camera's height (the tiles surround you).
  - **Streaming follow OFF (default):** the resident grid is fixed (`tileRadius`), every tile is built at its detail setting, and only the per-chunk rules above thin far tiles.
  - **Streaming follow ON, Full detail — the ACTIVE window (2026-10-01, performance-plan §P10.D):**
    - **Tile radius = the window.** 1×1 = exactly 1 full tile, 3×3 = 9, 5×5 = 25. Moving the slider changes it live, without a rebuild.
    - **Centred on the tile directly below the camera** (the eye projected onto the ground). In Play it is centred on the player. It is never the orbit target or the middle of the view, so an oblique overview from above tile (-1, 2) makes (-1, 2) the full tile, even if it is behind / below the view.
    - **Hysteresis:** standing on a tile border never flips the window; it switches once you are ~12% of a tile into the next tile.
    - **The original centre city is not special.** When the window leaves it, it leaves the scene (its GPU memory is freed; the built city is kept). It shows as an outside tile, and comes back as the same city when you return (re-attached over a few frames, no rebuild). `streamStats().centre` = `resident` / `parked` / `restoring`.
    - **Outside the window** (`sm.world.setStreamOutsideTiles(mode)`, the City panel's **Outside tiles**):
      - **Flat** (default): the cheap flat map for every other tile in view (up to 40, within 5 tiles of the look-at). It turns into massing once you are zoomed far out (the structure band below).
      - **Massing**: building boxes at every zoom.
      - **None**: nothing; the window floats in the void.
    - **Zoom still applies to the window:** past the props band the window's tiles build LITE (no detailed buildings); past the structure band they build MASSING.
    - **Memory stays bounded however far you go:** the tile caches are LRUs capped by MB and count, the geometry pool compacts while you move and gives memory back, and builds of tiles you have left are cancelled (their worker restarted).
    - **Movers:** tiled worlds run no traffic or moving trains (parked trains only). Clouds pause and hide while the centre is parked. The live crowd follows whichever tiles are resident and is restored when they leave.
    - A/B: `salsaWorld.p10({ eyeWindow: false })` = the old behaviour below (the 9 tiles nearest the camera are full, and the centre only hides).
  - **Streaming follow ON, legacy / Flat / Focus worlds / ortho:** the tiles in view are resident (frustum test on each tile's box, up to 40 tiles within 5 tiles of the look-at). Each tile is built at one of four detail levels (performance-plan §P10.C), picked from the zoom metric (`min(orbit radius, 2 × camera height)`; F = 2.8 × the city radius ≈ 48 units in the default tiled world):

    | Level | What | Built | Used for |
    |---|---|---|---|
    | **Full** | the whole city with every per-chunk rule above | worker, 2–4 s | the 9 tiles nearest the camera while the zoom metric is inside the props band (≈ r 57) — with the eye window: the Tile radius window |
    | **Lite** | full minus detailed buildings | worker | those 9 tiles past the props band (detailed buildings on) |
    | **Flat proxy** | the flat map (roads, pavements, lots, parks) | worker (since P10.D5; main thread ~18 ms without workers) | every other visible tile, and the stand-in of a full / lite tile while its worker build runs (a flat tile already on screen stays as its own stand-in) |
    | **Massing** | the flat map + one box per building lot (walls with the window pattern, flat roofs; ~20 k triangles) | worker (since P10.D5) | **every** visible tile once the zoom metric is past the structure band (≈ r 81, hysteretic), in perspective |

    So far out (a normal overview pitch, orbit radius over ~90 units) nothing waits for a worker: a pan shows its new tiles within a frame or two of stopping. A low, oblique view keeps detail longer (twice the camera height is small). In ortho the split stays full / lite / flat. Flat and focus worlds keep flat neighbours at every zoom.
  - When the centre city is off screen it is group-hidden; in ortho past the props band the movers are hidden and shadows suspended.
  - The orbit zoom-out is capped at 1.5 × the streaming distance (5 tiles × the tile span), so the ring always fills the view.
  - A/B: `salsaWorld.p10(false)` turns every P10 streaming fix off (massing tier, lite previews, cancellation, idle bounds, coalesced notifications, tile caches, tile-frame railway / landmarks, seed dedup, worker contact blobs); `salsaWorld.p10({ farMassing: false })` turns off one. `sm.renderer3D.constructor.gpuGeomCompaction = false` restores the CPU pool rebuild.

### Checking it

- `salsaWorld.streamStats()`: resident tiles by tier (`full` is the actual count, plus `lite` / `flat` / `massing` / `previews`), `window` / `windowTiles` / `focusTile`, `centre` (resident / parked / restoring), `outside`, pending, both LRUs (`cached` / `cacheMB`, `proxyCached` / `proxyCacheMB`). `salsaWorld.streamOutside('none' | 'flat' | 'massing')`. `salsaWorld.p10()` the P10 switches (P10.D: `eyeWindow`, `cheapInWorker`, `terminateCancelled`, `reserveCheapWorkers`, `heldAsPreview`, `budgetedWarm`, `compactWhileMoving`). `sm.renderer3D._lastGpuCompaction` the last geometry-pool compaction (CPU ms, copy rounds, live MB); `sm.scene3d.getGeomPoolStats3D()` used / capacity (the capacity now shrinks; `Renderer3D.geomPoolShrink = false` to A/B). Play: `Scene3DManager.collisionFollowsStructure` / `collisionBvhBudget` / `collisionSkipTileCrowd`, `MeshPicker.bvhBuildBudgetMs`.
- `salsaWorld.frameStats()`: `lodHidden` / `lodTrisHidden` (meshes and groups beyond their distance, twins included), `meshesCulled` / `groupsCulled` (frustum), `trisVisible` / `trisTotal`, `drawCalls`, `shadowTris`, `msCull`.
- P9 A/B: `salsaWorld.propTwins(false)` rebuilds without the prop far twins / crowd third tier; `salsaWorld.p9(false)` turns off the renderer and sim switches (hierarchical cull, draw-list fast paths, resolution LOD, traffic blocker grid, lazy camera candidates); `sm.renderer3D._hcStats` = clusters / members skipped last frame.
- A/B: `salsaWorld.distanceLod(false)` (or `sm.renderer3D.distanceLod = false`) turns the distance LOD off; `salsaWorld.distanceLod(true, mul)` scales every distance; `salsaWorld.detailLod(false)` turns the zoom tiers off. `WorldManager.DIST_LOD_TINY_BIAS = 1` (then `salsaWorld.distanceLod(true)`) gives the sub-metre classes the aerial bias back.
- P8 switches, all on by default, all live: `Renderer3D.groupTwins` (far tree crowns), `Renderer3D.shadowSizeLod` (shadow LOD) and `Renderer3D.shaderFastPaths` (the bit-identical facade shader shortcuts). The shadow LOD counters are `shadowLodFar` and `shadowLodCascade` in `getFrameStats3D()`.

## Instanced crowd (P12, 2026-10-01)

Engine details and measurements: `docs/specs/performance-plan.md` §P12. No host wiring is needed: the crowd looks the same and costs ~0.25 MB a tile instead of ~90 MB.

What QA should expect:
- **Close up (inside ~100 m): the same people as before.** Same clothes, poses, colours, spots and density, built for the cells around the camera a few frames after you get there.
  - While a cell is being built, people show at the next-cheaper detail for a few frames. You may notice this after a fast fly at street level; you should not when walking or in Play.
  - Edges can sit up to ~1 px off the old crowd on slopes and curved streets: each person now sits on the ground as one rigid figure.
- **Far away (past ~100 m): shared figures in each person's own colours.** About 65 silhouette classes per tile (garment, skirt length, hair length, bag, umbrella, pose). Arm holds, hats and shirt fronts merge out there, where a person is ~15 px tall.
- **Unchanged:** the crowd style (`pedestrianStyle`), day / night glow, fog fade, shadows, contact blobs, the live near-field crowd (promoted people still idle and are swapped back invisibly), and Play collision with the people around you (streamed tiles' crowd still does not collide).
- **Tile landings are lighter.** No 18 MB crowd upload, no 50 ms crowd job, and the tile builds about twice as fast in the worker.
- **Saved files are unchanged.** The crowd is rebuilt from the seed; nothing new is saved.

Checking it:
- `salsaWorld.crowdStats()`: cells per tier (`shown` = near / mid / far), resident cell meshes and bytes, lazy builds, and `bytes` (records, copies, shared variants).
- A/B: `salsaWorld.instancedCrowd(false)` rebuilds with the old baked crowd; `salsaWorld.instancedCrowd(true)` switches back. This is a world param, saved only when it is off.

## Resolution scaling (2026-10-01)

At full-screen sizes the city is GPU fill-bound (performance-plan §P6), so the engine can render the 3D scene at a fraction of the canvas and upscale it. Off by default: nothing changes until the user turns it on.

| API | What it does |
|---|---|
| `sm.setResolutionScale3D({ mode, scale, targetMs, minScale, maxScale, motion, motionScale })` | Merges the patch and returns the new state. `motion` / `motionScale`: the camera-motion drop, see below (a patch of only these two leaves the mode and the auto controller untouched). `mode`: `'off'` (native, default) / `'fixed'` (always `scale`, 0.25–1, default 0.75) / `'auto'` (keep the GPU frame time under `targetMs`, default 16.0 = 60 fps, between `minScale` (default 0.6) and `maxScale` (default 1)). |
| `sm.getResolutionScale3D()` | The setting plus `current` (the scale the 3D scene renders at right now, 1 = native), `gpuMs` (smoothed GPU frame time while timing runs, else null) and `timing` (`'timestamp'` = exact GPU timestamps, `'estimate'` = CPU start to GPU done, when the adapter lacks `timestamp-query`). |

**What is scaled and what is not.**
- The 3D scene (meshes, sky, particles, grease pencil, SSAO, outlines, SSR, the focus background) renders into a smaller target. It is upscaled with a sharpened Catmull-Rom filter, clamped to the neighbouring texels so edges never ring.
- The scene depth is upsampled into the full-size depth buffer. The 3D overlays (grid, selection box and gizmo, bones, mesh-edit handles, snap viz) therefore draw in the full-size overlay pass, crisp and correctly occluded. The same goes for 2D layers, vector shapes, text, selection UI and the landmark card.
- FXAA, bloom, the grade and the film look run at full size on the upscaled image. The focus-background restore works as on the native path.
- Picking is a CPU ray from the canvas pixel, so it is unaffected.
- **Exports are never scaled.** Thumbnails, `snapshotToBlob` / `snapshotRegionToCanvas`, video export frames (`waitForFrameSettled`) and artboard captures hold native resolution until their read-back is encoded, then the on-screen view returns to the scaled size.
- The PS1 lo-res look (`PS1Config.renderScale` / `renderResolution`) wins over resolution scaling. It keeps its chunky nearest upscale and inline overlays.
- The city's own camera-motion scale (`motionScale`, 0.78, while the camera moves in a streamed world) still applies;
  the lower of the two is used.

**Camera-motion drop (`motion`, engine-roadmap step 2, 2026-10-01).** In a tiled / streamed world the engine drops the
3D scale to `motionScale` (default 0.78) while the camera moves and restores native 400 ms after it stops: fill rate
is the dominant zoomed-out GPU cost and the drop is invisible mid-pan. In Play the camera follows the player every
frame, so the drop used to stay on for the whole Play session (a tiled Play walk rendered 1014 × 663 at 1300 × 850).
`motion` decides when it applies:

| `motion` | Editor camera moves (orbit / pan / zoom) | Play (the camera follows the player) |
|---|---|---|
| `'auto'` (default) | drop | only while the measured GPU frame is over `targetMs` (GPU timestamps; GPU timing is leased while Play moves the camera). Once on, it stays on while the frame predicted at native size (gpuMs / scale²) is over 85 % of the budget, so it doesn't flap at the threshold. With CPU-estimate timing (no `timestamp-query`) it never drops in Play: the estimate can't tell a CPU-bound frame. |
| `'always'` | drop | drop (the old behaviour) |
| `'editor'` | drop | never |
| `'off'` | never | never |

- It is independent of `mode` (off / fixed / auto): the lower of the two scales is used, and setting one never changes
  the other. It is saved with the rest of the setting (the per-machine `localStorage` preference); a stored setting from
  before step 2 reads `'auto'` / 0.78.
- `salsaWorld.dynRes(false)` still switches the whole drop off for the session (console A/B).
- Measured (tiled 3×3 Play walk, 1300 × 850, GPU 10 ms): `'auto'` renders every frame at 1.0; `'always'` renders 94 % of
  the frames at 0.78.

**Auto mode.** A GPU frame timer is enabled only in auto mode or while a readout polls `getCityLodStats3D` (a 3-second lease). It brackets every queue submission with timestamp writes and sums the spans, so a CPU-bound frame does not look GPU-bound. The controller (`src/renderer/core/resolution-scaler.ts`, unit-tested) works like this:
- It judges the median of the frames since its last change. At least 8 frames and 0.5 s must pass between changes.
- **Down:** as soon as the median is over the target. The new scale assumes the cost follows the pixel count and aims for 90 % of the target. Steps are at most −0.2 and snapped to a 0.05 grid; each change re-allocates the scene-sized textures, so the grid stays coarse.
- **Up:** one 0.05 step, after 1 s of headroom, and only if the predicted cost at the bigger scale stays under 90 % of the target. The band between the two thresholds keeps it from oscillating.

**Persistence: a per-machine viewport preference, not document data.** The right scale depends on this GPU and this monitor, not on the scene: a document opened on a laptop and on a desktop should not carry each other's setting, and saving must not change the file. The engine stores it in `localStorage['salsa.viewport.resolutionScale']` and restores it on start-up. Documents never contain it.

**Measured** (harness, seed-3 city, street view, headless Chrome on the RTX 2070 SUPER, idle GPU; engine GPU timer, whole frame):

| Canvas | Off | Fixed 0.75 | Fixed 0.6 | Auto |
|---|---|---|---|---|
| 2500 × 1390 | 15.4 ms | 10.4 ms | 8.0 ms | target 16 ms: settles at 0.9, 13.6 ms |
| 1300 × 850 | 9.9–10.8 ms | 7.1–7.9 ms | 6.0–6.6 ms | target 10 ms: settles at 0.8, 7.5 ms |

- **Pixels:** mean absolute difference against native is 1.1 / 255 at 0.75 and 1.6 / 255 at 0.5 (2500 × 1390). The noise floor is 0.03.
- **Snapshots:** a snapshot taken with 0.5 set equals the native frame (0.04 / 255).
- **GPU errors:** none. The new WGSL (sharpen blit, depth upsample) was compiled and checked in the headless browser.

**For QA.**
- Fixed 0.5 shows a softer 3D scene, while the axis widget, the grid, the gizmos and the panel text stay sharp.
- Export a thumbnail or PNG while scaled: it is full resolution.
- In auto mode, `sm.getResolutionScale3D().current` drops under load and comes back when the view is light.

## Temporal anti-aliasing and upscaling (engine-roadmap step 6, performance-plan §P18, 2026-10-03)

A jittered-history alternative to FXAA (`taa`) and a temporal upscaler (`taau`) that renders the 3D scene at a fraction
of the canvas and rebuilds a sharp full-size image. **Off by default** (see the default decision in §P18).

| API | What it does |
|---|---|
| `sm.setTemporalAA3D({ mode, scale, sharpen, retroOff, inkOff })` | Merges the patch, returns the state. `mode`: `'off'` (default) / `'taa'` (native resolution, replaces FXAA) / `'taau'` (render at `scale`, 0.5–1, default 0.65; when resolution scaling is Fixed / Auto, its scale is used instead). `sharpen` 0–1 (default 0.3). `retroOff` (default true) / `inkOff` (default false): those looks force it off. |
| `sm.getTemporalAA3D()` | The setting plus `active` (it ran on the last 3D frame), `reason` (`'ok'` / `'off'` / `'retro'` / `'ink'` / `'capture'` / `'compiling'`), `renderScale`, `samples` (16 TAA / 32 TAAU) and `velocityDraws`. |

**Persistence:** a per-machine viewport preference, `localStorage['salsa.viewport.temporalAA']`, never in documents
(the same reasoning as resolution scaling).

**What it does to the frame.**
- The 3D scene goes through the lo-res path (at full size for `taa`). While it records, the camera projection carries a
  sub-pixel Halton(2, 3) jitter, so the scene uniform (CPU and GPU-driven paths), the shadow-receiver prepasses, SSAO,
  SSR, the outline prepass, particles and grease pencil all see the same jitter.
- The jitter is cleared before the overlay pass: grid, gizmos, bones, mesh-edit handles, 2D layers, text and the
  landmark card are unjittered and crisp. The lo-res depth is upsampled for them exactly as with resolution scaling.
- A velocity pass writes the motion of movers (traffic, trains, walkers, rigid Play parts) and skinned parts; the rest
  reprojects with the camera. The resolve (full size) rejects disocclusions and clips the history to the neighbourhood.
- FXAA is skipped on TAA frames. Bloom, the grade and the film look run after it, at full size.
- The fog-horizon fade band and the HLOD cross-fade shift their dither pattern every frame, so they resolve into
  smooth fades.
- After the view stops, 32 more frames render (`WebGPURenderer.TAA_SETTLE_FRAMES`) so the history converges; then
  the on-demand loop idles as before.
- **Exports, thumbnails, snapshots and video frames render natively** (no jitter, no history) with FXAA standing in;
  a TAAU snapshot equals the native one (mean difference 0.01 / 255).
- The PS1 lo-res look always wins (reason `'retro'`); with `retroOff`, vertex snap, ordered dither, global colour
  depth and UV snap do too. The ink outlines resolve cleanly (slightly softer), so `inkOff` defaults to false.
- A device loss rebuilds it (a fresh history; the setting survives on the WebGPURenderer).

**For QA.**
- Thin wires and pole edges against the sky: TAA is clean where FXAA steps; TAAU 0.65 is close to native.
- Walk in Play: no trail behind the character or the cars; a fast spin softens briefly, then sharpens.
- `sm.renderer3D._taa.constructor.debug = 4` paints object-velocity pixels magenta, `2` rejected pixels red
  (disocclusion) / blue (off-screen), `1` shows the current frame only. `0` = off.

## LOD settings: the City panel's Performance group (2026-10-01)

Everything in §How LOD works can be tuned live, without a city regen, so the user can test what shows at what distance.

| API | What it does |
|---|---|
| `sm.setCityLodSettings3D(patch)` | Merges a patch (nested objects partial; `{ reset: true }` = the defaults first) and applies it live. Returns the settings. |
| `sm.getCityLodSettings3D()` | The settings plus `familyList` (`id`, `label`, `multiplier`, `distance` in world units and `metres`, `bias`), `shadow.cascades` / `shadow.nearMetres`, `F` (world units) and `metresPerUnit`. |
| `sm.getCityLodStats3D()` | `families`: per family `objects`, `shown` (visible and inside its distance; the frustum may still cull it), `lodHidden`, `zoomHidden`, `trisShown`, `trisHidden` (instanced groups count every copy), plus an `other` row for untiered layers. `frame`: `fps`, `gpuMs`, `cpuMs`, `trisDrawn`, `trisVisible`, `drawCalls`, `meshesCulled`, `groupsCulled`, `lodHidden`, `lodTrisHidden`, `shadowTris`. `resolution`: `mode`, `current`. Each call keeps GPU timing on for 3 s. |

**Settings** (defaults = today's behaviour):

| Field | Default | Effect |
|---|---|---|
| `distanceLod` | true | The per-chunk distance LOD on / off. |
| `global` | 1 | Multiplies every draw distance (the old `salsaWorld.distanceLod(true, mul)`). 0.05–8. |
| `families` | `{}` | Per-family multiplier by id (absent = 1, `null` resets one). 0.05–8. |
| `aerialBias` | true | Off = true distances from the air too (a much lighter aerial view). |
| `zoomTiers` | true | Off = the zoom tiers never hide anything (distance LOD still runs). |
| `zoom` | detail 1, roof 1.25, props 1.2, flatmap 1.4, structure 1.7 | Zoom-tier thresholds as multiples of F. |
| `twins` | crowdM 30, chipsM 18 (+ treesM, the P8 tree crowns) | Near/far swap distances in metres. |
| `shadow` | pcf `'5x5'`, slackTexels 16, quality `'high'` | PCF kernel (`'3x3'` is the cheaper tier: −3.2 ms at 2.5 K in P6) and the far-shadow follow slack (0 = re-centre every texel). `quality`: the step-7 preset (§Shadows: caching and quality presets) — choosing it also writes `pcf` and the cascade count. `shadow.cascades` / `nearMetres` in a patch go to the city's existing cascade setting. |
| `debugTint` | false | Colours every mesh by its LOD family: glowing family colours, the far twin darker, untiered layers dim grey. Fly around to see which colours drop out where. Material-only writes; restored exactly when turned off. Never saved. |

**Families are data-driven.** Every tier in `WorldManager.cityDistanceTiers` is a family. Known tiers get a friendly id and label (`LOD_FAMILY_PROBES` in `world-lod-settings.ts`): cans, crowd, railFine, tiny, smallProps, poles, signText, signs, roadSigns (split from the name plates with the same distance for the fog horizon, 2026-10-01), facade, roof, trees, parkedCars, vending, props, flatmap, contact. Each tier also carries its fog-horizon class (docs/specs/fog-horizon.md). A tier added later appears by itself, under an id taken from its regex. To give the panel separate sliders, the crowd, rail sleepers, name plates, trees, parked cars and vending machines were split out of their tiers with the same distance, bias and shadow size, so the stamped distances are unchanged (tested).

**Live, no regen.**
- Distances are re-stamped once (one tree walk) and twin distances rescaled from their built values.
- The aerial bias is re-pushed. The PCF tier and the shadow slack are renderer-wide: they are written while a city exists and go back to the defaults when it is cleared.

**Persistence (opt-in).** The city marker (`worldParams.lod`) stores only the fields that differ from the defaults:
- A city that never touched them saves byte-identical, and an absent field means today's behaviour.
- A document load resets to the defaults, then restores the saved fields.
- The debug tint is never saved.

**Code:** `src/services/managers/world-lod-settings.ts` (settings, families, twins, stats, tint; tests in `world-lod-settings.test.ts`). The WorldManager hooks are `setLodSettings` / `getLodSettings` / `getLodSettingsView` / `getLodStats`. ShapeManager forwards straight to them.

## Fog horizon on the CPU (2026-10-01)

With Hard edge + "Buildings only in fog" (docs/ui/city-quality.md "Fog horizon"), the objects past the fog's Far are not
drawn. Since the follow-ups this also saves CPU, not only GPU:
- **Cluster-level fog reject.** The P9 cull clusters test their whole box against the fog line once per frame; the
  culled families (props, crowd, cars, trees …) inside a cluster that is wholly past it are dropped without their own
  test. The lists are identical with it on or off (unit-tested); `sm.renderer3D.constructor.hcFogReject = false` is the
  A/B.
- **Fog first.** A fog-culled object skips the distance-LOD and twin updates; its LOD state is picked up where it was
  when it comes back.
- **Geometry-pool walk.** Every frame the renderer used to look up all ~13 k meshes of a tiled city to find new
  geometry (~1.5 ms); resident, clean meshes are now skipped (`.geomPoolFastSkip = false` = the old walk). This one
  helps with the fog off too.
- **Walkers** whose every part is fog-culled are re-posed every 8th frame, like off-screen ones.

Measured (Far 150 m, CPU ms per frame, feature off before → Buildings only after): tiled 3×3 street 14.7 → 12.1,
rooftop 14.5 → 11.9; streaming street 16.3 → 13.3, rooftop 17.4 → 13.5. With the fog off, the geometry-pool change alone
takes ~1.0-1.5 ms off. Full table: docs/specs/fog-horizon.md §0 "Follow-ups" item 4.

QA: `getFrameStats3D().fogHidden` (objects dropped by the fog) and `sm.renderer3D._hcStats.fogSkipped` (how many of
them the cluster test handled); `skinnedFogHidden` for characters.

## Editor overhead and structure-change hitches (engine-roadmap step 2, 2026-10-01)

Engine plan and measurements: `docs/specs/performance-plan.md` §P13 "Step 2". On by default; nothing needs host wiring.
Result in a tiled 3×3 Play walk: main thread 16.2 / 46.9 / 19.4 → 12.2 / 21.9 / 13.9 ms a frame (p50 / p95 / mean).

**What changed for the frame.**
- The 3D meshes live in the same scene graph as the 2D shapes. The editor's per-frame 2D steps (the vector render
  strategy, the caret and text-selection collectors, the below / above-raster split) used to loop over every node,
  ~13 k meshes in a city. They now get only the 2D nodes. The 3D passes read their own cached lists (meshes, particle
  emitters, grease pencil, skeletons), built by the same structure walk in the same order.
- A structure change (a streamed tile, a crowd cell, a live-crowd promotion) used to re-sort everything at once: the
  draw order (~10 ms), the render list (~8 ms), the pipeline prewarm (~3 ms) and the character list (~2 ms). Each is
  now incremental: the new nodes are sorted and merged into the previous order, which gives exactly the old order.
- Structure notifications are coalesced: any number of them between two reads of the scene structure version count
  once, so each cache re-walks at most once per batch.
- `getRenderStats3D()` (the stats HUD) sums cached per-mesh figures; a poll reads only each mesh's `visible` flag.
  The returned values are unchanged.

**Nothing visible changes.** Same pixels (frozen-clock A/B, 2D and 3D view modes: 0 differing pixels), same draw calls,
same 2D editing (selection boxes, carets, text selection, vector layers, the artboard and the textured artboard).

**A/B switches** (per session, never saved; all `true` by default):

| API | What it does |
|---|---|
| `sm.setFrameScanOptions3D(patch)` | `{ splitRenderList, incrementalRenderList, incrementalDrawOrder, prewarmNewOnly, cachedSkeletonSync, cachedRenderStats, iterativeSceneWalk, coalesceStructureBumps }`. `false` = that scan's old code path. Returns the options. |
| `sm.getFrameScanOptions3D()` | The options. |
| `sm.getFrameScanStats3D()` | `{ renderList: { list2D, flat2D, flat3D, meshes3D, emitters3D, gp3D, walks, merged, fullSorts, lastAdded, lastRemoved, lastNodes }, structure: { drawRank: { updates, merged, fullSorts, legacy, lastAdded, lastRemoved, size, keyCodes }, prewarmLastQueued, prewarmQueued }, structureVersion, structureBumps }`. `merged` vs `fullSorts` shows how often the incremental path was taken. |

**For the host (Frogmarks).**
- The 3D canvas `pointermove` handler is registered outside Angular's zone. It re-enters the zone only when the
  handler changed a bound value (the ribbon-handle list) or while a mouse button is held: during a drag, engine
  callbacks (viewport changes → the artboard overlay, gizmo drags) update bound panels without entering the zone
  themselves, so drags keep their per-move change detection. Plain hover moves and Play run none.
- The stats HUD (250 ms), the Performance group (500 ms) and the stream stats (500 ms) poll outside the zone and enter
  it only when a value they show changed (at the panel's own rounding).
- Measured (Angular dev server): a mouse-move storm over the canvas ran 17.7 ms/s of change detection; now 0.

**For QA.**
- Tiled world, Play, walking: no hitch when a crowd cell or a nearby tile appears (it used to be a 30–47 ms frame).
- 2D: draw shapes, select, type text, select text with Shift+Arrows, hide a vector layer, switch to free3D with the
  textured artboard: all as before.
- `sm.setFrameScanOptions3D({ splitRenderList: false, incrementalRenderList: false, incrementalDrawOrder: false })` and
  back: the picture must not change.

**Code:** `src/renderer/core/render-list-index.ts` (+ test), `src/renderer/3d/draw-order-rank.ts` (+ test),
`src/services/structure-version.ts` (+ test), `WebGPURenderer._rlClassify / _rebuild3DLists / draw3D*`,
`Renderer3D._prewarmCoded / setStructureOptions / getStructureStats`, `Scene3DManager._walkScene / _statsCache /
_syncCharacterSkeletons`, `ShapeManager.setFrameScanOptions3D`.

## Simulation LOD (engine-roadmap step 1, 2026-10-01)

Engine plan and measurements: `docs/specs/performance-plan.md` §P13. On by default; nothing needs host wiring. The
Frogmarks City → Performance section has a **Simulation** group for it.

**What it does.** Everything that is simulated every frame (walkers, cars, trains, the drifting clouds and other
movers, the live near-field crowd, character idles, hair springs) is updated by how much it matters on screen:

| Band | When | Update rate |
|---|---|---|
| Near | within `nearM` (40 m) and on screen | every frame (exactly as before) |
| Mid | `nearM`..`midM` (120 m), on screen | `midHz` (10 Hz) |
| Far | past `midM`, on screen | `farHz` (2 Hz; 0 = frozen) |
| Off-screen | anywhere off screen | `offscreenHz` (2 Hz; 0 = frozen) |
| Frozen | past the fog horizon (Hard edge + "Buildings only in fog", see §Fog horizon on the CPU) | never |

- **Hysteresis:** a thing leaves a band outward only 10 % past its edge (`hysteresis`), so a walker on a band edge never
  flips every frame. One moving to a faster band is updated on that frame.
- **No stutter:** a moving thing on screen in the mid / far band is updated at least often enough that one update moves
  it at most `stutterPx` (1.5) pixels, from its speed, its distance and the lens. A car crossing the view at 100 m stays
  smooth; a walker standing at a crossing costs nothing. An off-screen mover that will be on screen by its next update
  counts as on screen.
- **Never throttled:** the Play player, the selection, a skeleton being posed, a script behaviour's target, and every
  character while a timeline / clip / NLA preview plays.

**Movers as a function of time.** A frozen mover must come back where it would have been:
- **Walkers** (the routed pedestrians) are a closed form of the world clock (`src/world/walker-clock.ts`): the same
  leg chain, speeds, accelerations, green-man waits and turn-round beats as the per-frame sim, solved analytically
  between stops. A walker frozen for a minute costs nothing and lands exactly on its route when evaluated again; the
  signal decisions are the same whether it was evaluated every frame or once. Chats, door visits and level-crossing
  holds restart the clock from where the walker is.
- **Trains** (the rail runs) follow their station schedule as a function of the clock (`train.ts` `trainRunAt`), so a
  frozen train reappears on schedule and the level crossings read the scheduled state.
- **Clouds, birds, boats …** (the constant-speed a→b movers) are a closed form too.
- **Cars** interact (following, yielding, junctions, the parked-car swerve), so they stay a stepped sim: every frame
  near / mid (posed at the band rate), in ≤ 0.1 s substeps at the band rate far / off screen, and paused while frozen.
  A frozen car is invisible to the others (no queue forms behind it at the fog line). Traffic is precomputed in the
  worker (`traffic-precompute.ts`), but that is the spawn specs and the road net, not the playback: playback was and is
  per frame on the main thread.
- A thing past the fog is frozen only 4 m past the fog's cull distance, and a frozen walker's position (not its pose)
  refreshes once a second, so anything walking out of the fog is already updating when it reaches the line. Its jump
  to the clock position happens while it is still invisible.

**Also:** the live crowd poses by band (its idle is a function of the clock) and promotes nobody past the fog; the
instanced crowd (P12) builds no lazy cell wholly past the fog; the procedural idle poses by band; spring bones solve
only in the near band and restart cleanly (`resetSpringState`) when a character comes back.

| API | What it does |
|---|---|
| `sm.setSimLod3D(patch)` | Merges `{ enabled, nearM, midM, midHz, farHz, offscreenHz, fogFreeze, hysteresis, stutterPx }` and returns the settings. Live. Also `sm.setCityLodSettings3D({ sim })`. |
| `sm.getSimLod3D()` | The settings (also `getCityLodSettings3D().sim`). |
| `sm.getSimLodStats3D()` | `{ enabled, settings, total, systems, fogSkippedCellBuilds }`. `systems`: `walkers`, `cars`, `trains`, `otherMovers`, `liveCrowd`, `characters`, `springs`, each `{ near, mid, far, offscreen, frozen, updates, skipped, totalUpdates, totalSkipped }` for its last frame (a system that stopped reads 0). |
| `salsaWorld.simLod()` | Console: the stats. `salsaWorld.simLod(false)` = the A/B switch; `salsaWorld.simLod({ nearM: 60 })`; `salsaWorld.simLod('reset')` zeroes the counters. |

**Persistence:** with the city LOD settings (`worldParams.lod.sim`), only the fields that differ from the defaults. A
city that never touched them saves byte-identical. A document load resets to the defaults, then restores the saved
fields.

**A/B:** `sm.setSimLod3D({ enabled: false })` restores the old behaviour exactly: every mover, idle and spring updates
every frame through the old code (the T7.3 pose gate for movers). Clock-driven movers hand their state back to the
stepped sim when it is switched off, and pick it up again when it is switched on, with no jump.

**For QA.**
- Walking or in Play, near the camera: walkers and cars look exactly as before.
- From a rooftop: distant people still walk smoothly (they are updated as often as their on-screen motion needs).
- `getSimLodStats3D().total`: most movers sit in `offscreen` / `far`, and `skipped` is well above `updates`.
- Hard edge + Buildings only in fog, Far ~70 m: walk toward the fog line. People and cars come out of the fog where
  they should be, with no pop and no teleport, and `frozen` counts the movers past the fog.
- The trains keep their timetable whether or not they spent time in the fog.

**Code:** `src/world/sim-lod.ts` (bands, schedule, counters; `sim-lod.test.ts`), `src/world/walker-clock.ts` and
`train.ts` `trainRunTimeline` / `trainRunAt` (`walker-clock.test.ts`), the hooks in `world-traffic.ts`,
`world-live-crowd.ts`, `world-crowd.ts`, `scene3d-animation.ts`, `scene3d-armature.ts`, and `Scene3DManager.simLod` /
`simLodDue`. `Renderer3D.simFogEdge` is the fog line it freezes past.

## Lighter tiles and no hitches (engine-roadmap step 3, 2026-10-02)

Engine plan and measurements: `docs/specs/performance-plan.md` §P13 "Step 3". On by default; only the budget warning
needs host wiring (below). Result in a tiled 3×3 Play walk, every step-3 switch off → on in the same build: main
thread 15.4 / 26.4 / 17.3 → 13.3 / 22.0 / 14.2 ms a frame (p50 / p95 / mean). Against the code before this step (plain
runs): p95 25.0 → 18.5 ms, long tasks in 25 s 7 (max 146 ms) → 1 (51 ms).

**What changed for the frame.**
- **No more bounds hitch after a tile lands.** The City gizmo's box used to be recomputed from every vertex of the
  world (up to 132 ms in one task, 400 ms after streaming went idle). It is now folded from cached per-geometry boxes
  and only new geometry is scanned, in 3 ms slices. The box is the same.
- **Play collision is ~4× cheaper.** Rays near the player walk one merged BVH per collision cell (cells about 4× the
  third-person camera reach, the 3×3 around the player), built in a worker from the static meshes around the player.
  Movers and anything the cell does not cover still go through the per-mesh path. Same hits, distances and normals
  (checked live: 33,598 rays, 0 differences). Tiled walk: rays 1.4 → 0.34 ms a frame.
- **No geometry upload over 4 MB in one piece.** A bigger geometry is written in ≤ 4 MB slices, one a frame, and draws
  once it is complete; a frame writes at most 16 MB in all; geometry in view and near goes first. The 18 MB
  single-write frames of a landing tile are gone (30-tile street fly: worst task 135 → 77 ms, worst frame gap 176 →
  85 ms).
- **Crowd cells build in a worker.** The near / mid people around the camera are built off the main thread, so a fast
  street-level fly shows the simple far figures for far less time (25 m/s fly: 0–14 vs 83–131 cell-frames on the far
  figure) and spends ~19 instead of ~140 ms of main thread on them over 8 s. Above 50 m/s no new cell starts (it would
  land behind the camera).
- **Fog horizon:** road paint, road wear, gutters and storefronts stop drawing past the fog's Far (they were fog colour
  on fog colour); they do not dissolve in the fade band. No visible change (0 differing pixels).
- **Streaming:** the nature apron, void grid and border glow are rebuilt around the tile window as it moves (they used
  to stay around the origin); a tile coming back from the cache, or the centre city coming back, shows the current night
  glow and style at once; under an orthographic camera the window centres on the view centre.

**Nothing visible changes** (frozen-clock A/B, diorama + tiled, three poses, with and without the fog horizon: 0
differing pixels), except where it was wrong before (the backdrop around a far window, stale glow on re-attached tiles).

**A/B switches and stats** (per session, never saved; all `true` by default):

| API | What it does |
|---|---|
| `sm.setStep3Options3D(patch)` | `{ incrementalTileBounds, cachedGroupBounds, collisionCells, runBoxes, slicedUploads, crowdCellsInWorker, crowdPrefetchLead, overlaysFogCulled, backdropFollowsWindow, refreshReattached, orthoViewCentre, pruneGroupBoxCache }`. `false` = that change's old code path (`runBoxes` affects new tile builds). Returns the options. |
| `sm.getStep3Options3D()` | The options. |
| `sm.getStep3Stats3D()` | `{ collision, uploads: { lastMB, maxMB, slicing, slicedGeoms, budgetMB }, bounds: { scanned, cachedHits, slices, maxSliceMs, lastTotalMs, jobs }, crowd }`. |
| `sm.getCollisionStats3D()` | Play only (else null): `{ cells: { cells, ready, pending, builds, invalidated, stale, served, notReady, outside, unbounded, gatherMsMax, buildMsMax, soupTrisMax, bytes, core, margin }, rays: { cell, old, residual, fallback }, hood, meshBvhs, snapshot }`. |

## Streaming hitches (performance-plan §P16, 2026-10-02)

Engine plan and measurements: `docs/specs/performance-plan.md` §P16. On by default; no host wiring is needed.

**What changed for the frame** (tiled worlds, flying or walking across tiles):
- **A landing tile no longer stalls on instance slots.** The renderer's instance-slot free space is kept merged and
  indexed (it used to be scanned entry by entry for every new instanced group: up to 22 ms). New instanced groups are
  packed over a few frames, nearest in view first; a group not packed yet is simply not drawn yet (never wrong data).
- **No big upload frames.** All uploads share one budget per frame (8 MB; instance data first, geometry the rest, at
  least 2 MB), and no geometry is written in a piece over 2 MB. The worst frame wrote 19–23 MB before, 8–11 MB now.
- **Tiles leave cheaply.** A tile that leaves the window is detached at once; its renderer cleanup runs over the next
  frames (1.5 ms a frame). A tile that comes back from the cache before that finishes is cleaned up first, then re-attached.
- **Cheaper LOD stamps and collision upkeep.** The LOD tier of a node name is looked up once; the Play collision
  snapshot re-reads only the meshes that changed (3–11 → about 3 ms on a tile change).

**Result** (30-tile street fly, 3×3 tiles): long tasks over 50 ms 11–24 → 2–11 a minute, worst 75–100 → 53–79 ms, frame
interval p95 at vsync (16.8 ms). Play walk: 3–41 → 0–6 long tasks in 25 s. Memory over a 60-tile fly is flat.
**Nothing visible changes** (checked by reading the GPU's instance and geometry buffers back during a fly: every slot and
geometry equals its object).

**For QA.** Fly or walk across tiles in a tiled 3×3 world: landing tiles may fill in over a few more frames (instanced
detail and big geometry), nothing flickers or shows in the wrong place, and tiles coming back from the cache look as
before.

**A/B switches and stats** (per session, never saved; all `true` by default):

| API | What it does |
|---|---|
| `sm.setStreamHitchOptions3D(patch)` | `{ indexedSlotFree, slicedGroupPacks, deferredEviction, uploadLedger, lodStampMemo, snapshotMeshVersion, coalescedCompaction }`. `false` = that change's old path. Returns the options. |
| `sm.getStreamHitchOptions3D()` | The options. |
| `sm.getStreamHitchStats3D(reset?)` | `{ groupPacksDeferred, groupPackFramesDeferred, evictDeferred, evictQueueMax, evictBudgetHits, evictFlushed, evictPending, instBytesLast, instBytesMax, frameBytesMax, stampSkipped, stampDone, memoHits, memoMisses, limits, snapshotSync }`; `reset` zeroes the counters. |

The limits (`groupPackInstances` 1500, `evictBudgetMs` 1.5, `writeSliceBytes` 2 MB, `frameWriteBytes` 8 MB,
`geomFloorBytes` 2 MB) live in `src/renderer/3d/stream-hitch.ts` (`STREAM_HITCH_LIMITS`).

**Code:** `src/renderer/3d/stream-hitch.ts` (switches, limits, stats), `instance-slot-allocator.ts` (indexed free space),
`renderer-3d.ts` (`_groupPackDeferrals`, `evictMeshCachesDeferred` / `drainDeferredEviction` / `flushDeferredEviction`,
`_geomBudgetLeft`, the compaction's held fresh geometry), `geom-compaction.ts` (coalesced runs), `view-cull.ts` (tier
memo), `game/collision-snapshot.ts` (`geomVersion`). Tests: `stream-hitch.test.ts`, `instance-slot-allocator.test.ts`,
`geom-upload-slices.test.ts`, `geom-compaction.test.ts`, `collision-snapshot.test.ts`, `lod-stamp-memo.test.ts`.

## Scene budgets (engine-roadmap step 3, 2026-10-02)

`sm.getSceneBudget3D()` compares the scene with simple budgets and returns one line a HUD can show. Cheap: it reads the
renderer's frame counters, like `getRenderStats3D()`.

| Field | Meaning | Default limit |
|---|---|---|
| `drawnTris` | Triangles submitted this frame, every pass that ran (main + the shadow maps re-rendered this frame + depth / mirror passes) | 3,000,000 |
| `drawCalls` | Draw calls this frame, same passes | 2,000 |
| `geometryMB` | Live geometry in the GPU pool (vertex + index, minus freed space) | 500 MB |
| `instances` | Instanced copies drawn from array groups | 200,000 |
| `meshes`, `mainTris`, `shadowTris` | For a tooltip | — |
| `limits` | The limits in force | — |
| `over` | `[{ key, value, limit, ratio }]` for each key over its limit | — |
| `ok`, `warning` | `warning` = "Over budget: 6.1 M tris (3.0 M tris), 3.4 k draws (2.0 k draws)", or null | — |

`sm.setSceneBudget3D({ drawnTris, drawCalls, geometryMB, instances })` sets a patch (0 = no limit for that key; null =
the defaults). Session setting, never saved. Rule of thumb from the roadmap: tiny detail (bolts, cans, sleepers) goes
into textures or instances, not unique geometry.

**For the host (Frogmarks).** Done in Frogmarks (docs/ui/frogmarks-update-2026-09-28.md §Step 3): the stats HUD shows
the warning as an amber line, and City → Performance shows it (or "Within budget …") as a third readout line, both from
the existing outside-the-zone polls.

**For QA.**
- Tiled world, Play, walk across a tile border and wait for the tiles to land: no hitch; the City gizmo box (select the
  City) still covers the streamed tiles.
- Play: walk into walls, up kerbs and stairs, swing the camera against a wall: as before.
- Fly fast along a street at 1.6 m: the people in front build in; the simple far figures show only briefly.
- Fog horizon (Hard edge, Buildings only): road markings near the fog line look the same.
- Move the Tile radius window far from the origin (tiled, 1×1): the border glow and the apron frame the window.
- `sm.setStep3Options3D({ collisionCells: false, slicedUploads: false })` and back: the picture and Play feel the same.

**Code:** `src/services/managers/group-bounds.ts` (+ test), `src/game/collision-cells.ts` (+ test),
`src/services/workers/near-jobs.ts` / `near-lane.ts` / `near-worker.ts` (+ test), `src/renderer/3d/scene-budget.ts`
(+ test), `Renderer3D._appendGeometry / _writePartial / _clearPendingGpuDirty / getGeomPoolStats`,
`MeshPicker.identityLocalRay / hitFromLocalT`, `Scene3DManager._collisionCellsTick / _cellRaycast / getSceneBudget3D`,
`WorldCrowd` (worker tasks, lead), `crowd-instanced.ts crowdCellJob / buildCrowdCell / adoptCrowdCell`,
`WorldManager._startBoundsJob / _followBackdrop / _dressGroups`, `view-cull.ts` ('overlay'), `ShapeManager.setStep3Options3D`.

## Shadows: caching and quality presets (engine-roadmap step 7, performance-plan §P14, 2026-10-02)

Two shadow maps feed every lit pixel: the zoom-adaptive FAR map (one ortho box around the camera focus) and, in a city,
one or two NEAR cascades (sharp boxes ahead of the eye). Step 7 makes both cheaper without changing the picture.

**What happens per frame now.**
- **Far map: casters submit only their runs inside the box.** A streamed tile's layer is ONE 420 m mesh; it used to be
  drawn whole whenever any corner of it touched the far box. Heavy casters now draw only their 256-triangle index runs
  (the P11 cull ranges) inside the light box (the cached static layer) or inside the light box and the shadow reach
  (the direct path / the moving casters). The runs are worked out only on the frames the far map actually renders.
- **Near cascades: a cached static layer per cascade.** Static casters (buildings, props, parked things) are drawn into a
  per-cascade static layer only when the cascade box moves past its slack, the static set changes, or something
  structural does. Each refresh copies that layer into the sampled one and draws only the dynamic casters on top: the
  Play player and other characters, cars, walkers, trains, wind-swayed trees, billboards. The player's pose still
  refreshes them every frame, the rest every `updateInterval` frames, as before.
- **Cascade slack.** A cascade box keeps its place (and its cached layer) until the wanted box has drifted 64 cascade
  texels (about 1.5 m at the city's 24 m near cascade). Its texel grid is unchanged, so shadows do not crawl; only the
  cascade's outer edge (where it blends into the far map) trails the camera by at most the slack.
- **Streamed tiles join in batches.** A static caster that is not in a cached static layer yet (a tile mesh after its
  short probation, a crowd cell, a car that parked) is drawn with the dynamic casters until 200 k triangles have queued
  or the first one has waited 120 frames; then the static layer re-renders once with all of them. A caster that LEAVES
  (tile detached, hidden, started moving) still re-renders the layer at once, so it never keeps a shadow that is gone.
- **The sun moves the shadows in 0.15° steps.** The shadow maps follow the sun once it has turned 0.15° (a 120 s day
  cycle: about 20 updates a second instead of 60), and snap to the exact sun 8 frames after it stops. The lighting
  itself always uses the exact sun. A colour-only light change (a lightning flash, a grade) no longer re-renders the
  maps.

**Shadow quality presets** (`src/renderer/3d/shadow-quality.ts`). One select sets every shadow cost knob:

| Preset | PCF | Cascades (incl. the far map) | Cascade map | Cascade refresh | Far map | Far refresh |
|---|---|---|---|---|---|---|
| Low | 3×3 | 1 | — | — | 1024 | 2 × the scene interval |
| Medium | 3×3 | 2 | 1024 | every 2nd frame | 2048 | the scene interval |
| **High (default = today)** | 5×5 | 2 | 2048 | every 2nd frame | 2048 | the scene interval |
| Ultra | 5×5 | 3 | 2048 | every frame | 4096 | the scene interval |

(The scene interval is 3 frames in a diorama city and 30 in a tiled world; the player's pose refreshes the cascades every
frame in every preset.)

| API | What it does |
|---|---|
| `sm.setCityLodSettings3D({ shadow: { quality } })` | City mode (the owner of the city's shadow settings): sets the preset, writes its PCF kernel and cascade count (an explicit `pcf` / `cascades` in the same patch wins), applies its map sizes and refresh. Saved with the city LOD settings, only when not `'high'`. |
| `sm.getCityLodSettings3D().shadow` | Gains `quality` (the chosen preset) and `qualityShown` (the preset, or `'custom'` once the PCF kernel or the cascade count was changed on its own). |
| `sm.setShadowQualityPreset3D(q)` / `sm.getShadowQualityPreset3D()` | The same from anywhere: in City mode it is the call above; outside a city it writes the scene's own shadow settings (far map size and cascades are saved with the document's global settings; the PCF kernel is per session). Returns `{ quality, scope: 'city' \| 'scene' }`. |
| `sm.setShadowCacheOptions3D({ farRanges, cascadeCache, cascadeSlackTexels, sunStepDeg, joinDefer, farStaticCache })` | A/B switches (per session, never saved; defaults on / 64 / 0.15). All off = the pre-step-7 paths. Returns the current values. |
| `sm.getShadowCacheStats3D()` | Counters since load: far map (`staticRenders` and why: `staticSig` / `staticStale` / `staticCold`, `dynPasses`, `directRenders`, caster counts, `farTris`), `farJoiners`, cascades (`staticRenders`, `why` = cold / stale / box / sig, `dynPasses`, `recentres`, per-cascade static / dynamic caster counts, `joiners`, `held`). |

`getFrameStats3D()` adds `rangeTrisCulledShadow` (far-map triangles the runs saved on a frame it rendered),
`cascadeStaticRenders`, `cascadeDynPasses`, `cascadeRecentres`.

**Frogmarks:** City → Performance → Shadows → **Shadow quality** (Low / Medium / High / Ultra, Custom shown when the
filter or cascades were changed by hand), and the 3D Global settings → Shadows → **Quality**. See
docs/ui/frogmarks-update-2026-09-28.md.

**For QA.**
- Play in a city, walk and turn: shadows look as before, including the player's own shadow, walkers, cars, swaying trees.
- Time of day slider / day cycle: shadows follow the sun; when the slider stops they settle on the exact sun.
- City → Performance → Shadow quality Low: softer 3×3 edges, no crisp near cascade; Ultra: a third (mid) cascade and a
  sharper far map. High = what you had.
- `sm.getShadowCacheStats3D()` while walking: cascade `dynPasses` climbs every frame, `staticRenders` only every second
  or so.

**Code:** `src/renderer/3d/shadow-cache.ts` (run tester, signatures, box hold, refresh decision, joiners, sun step;
`shadow-cache.test.ts`), `src/renderer/3d/shadow-quality.ts` (`shadow-quality.test.ts`), `scene-uniforms.ts`
`cascadeLightBox` / `cascadeMatrixFromBox`, and in `renderer-3d.ts` `_recordCascadeCached`, `_expandRanges`,
`_farStatic` / `_cascStatic`, `_updateCascades`, `setDirectionalLight` / `_settleSun`.

## GPU-driven rendering (engine-roadmap step 4, performance-plan §P15, 2026-10-02; culling mode 2026-10-03)

**On by default.** The engine keeps the city on the GPU as one RECORD per opaque draw: each single-material opaque
mesh and each instanced group. A record holds its world box, LOD / fog / twin parameters and draw arguments. Each
frame a compute pass decides what draws, and pre-recorded render bundles replay the draws. The picture is identical
to the old CPU path, and so is the draw order.

**What the GPU decides:**
- the camera frustum, distance LOD (with its 10 % hysteresis), the fog horizon;
- the near / far twins (chipped edges, prop far twins, the far tree crowns);
- the partial-mesh cull ranges (a heavy chunk draws only its parts in view, as at most 4 index spans);
- the depth prepasses for ink outlines, SSAO and SSR, which reuse the same result;
- the shadow casters of the far map and the near cascades. The cached static shadow layers still re-render only
  when they must: the GPU counts the casters that left or joined a layer, and the renderer re-renders it within the
  layer's usual refresh throttle.

**Still on the CPU:** billboards, always-on-top cards, the instanced crowd's tier choice, multi-material /
vertex-coloured / transparent meshes and characters.

**The trade (updated 2026-10-03).** It takes 25–45 % off the renderer's main-thread time in a city: a Play walk's
drawMeshes went 5.2 → 2.9 ms in the diorama and 12.4 → 8.9 ms in a tiled 3×3 world. The GPU cost is now small:
- At 1300×850 in the tiled city, the main pass is within 0.2–0.4 ms of the CPU path. The whole frame is +0.8–1.7 ms
  of GPU time, mostly Phase C shadows (see below).
- At 2500×1390 the frame is +1.6–2.2 ms (it was +4.4 ms before the 2026-10-03 fix).
- The diorama is within noise.

The earlier "+2–3 ms main pass" came from two things:
- A real cost: the merged pipeline made plain meshes run the heavy full shader.
- A measurement artefact: the old timing driver divided by read-back batches, not frames.

**Shadows (2026-10-03):** the GPU shadow passes used to replay every caster record (~15 k indirect draws for a
few hundred real casters). The per-frame dynamic shadow layers now draw from compact lists of only their casters.
The GPU shadow time went 0.57 → 0.15 ms a frame in the tiled city (the CPU path: 0.16), and the frame got 0.5 ms
faster at 1300×850 and 1.2 ms faster at 2500×1390. The pictures are identical. The switch is `shadowCompact` below.

What remains:
- Every main-pass record is an indirect draw, culled ones included: about 13 k zero-instance draws a frame in the
  tiled city. They cost about 0.5 ms when the GPU is otherwise idle, but much more while other applications load
  the GPU: in one loaded run, +3 ms of main pass at 1300×850 and +33 ms at 2500×1390.

So a GPU-bound full-screen frame on a busy GPU can still be faster on the CPU path. The **GPU culling mode**
(below) picks the path for you.

### GPU culling mode: Auto / On / Off

`sm.setGpuCullingMode3D(mode)` / `sm.getGpuCullingMode3D()`. The choice is a per-machine viewport preference, stored
in localStorage `salsa.viewport.gpuCulling`. It is never saved with the document.

| Mode | Label + hint for the host UI | What it does |
|---|---|---|
| `'auto'` (default) | **Auto**: "Picks GPU or CPU culling from the measured frame times. Recommended." | Runs the GPU path unless the frame is GPU-bound and the CPU path is measured or predicted to be at least 10 % faster. It goes back to the GPU path when the frame is CPU-bound, or when the GPU path fits well inside the frame budget. Without GPU timestamps it stays on the GPU path. |
| `'on'` | **On (GPU)**: "Always cull and draw the city on the GPU. Lowest CPU cost." | The GPU-driven path, always. |
| `'off'` | **Off (CPU)**: "The classic CPU path. Use if the GPU is the bottleneck, or to compare." | The CPU path exactly. Nothing of the GPU scene runs. |

**How Auto decides:**
- **Inputs:** medians over 1 s of the renderer's main-thread ms and of the GPU frame ms (timestamp queries; the
  timer runs while Auto has a city), per path.
- **Predicting the other path:** from learned ratios, updated at each switch (30 % weight, clamped).
- **Holding:** at least 3 s between switches. A switch that made the frame slower goes straight back once, and
  doubles the hold, up to 24 s.
- **Cost of the CPU path in Auto:** while Auto runs the CPU path, the GPU scene stays warm, so switching back never
  rebuilds. That costs a little CPU, so Auto's CPU-path frames are a bit dearer than Off. The cached shadow layers
  re-render once per switch.

`getGpuCullingMode3D()` returns:
- `mode`, `active` (`'gpu'` / `'cpu'`);
- `reason` + `reasonText`: "set to On", "set to Off", "measuring", "CPU-bound", "GPU-bound", "headroom", "holding",
  "no GPU timer", "GPU path unavailable";
- `auto` (switches, the learned ratios, the last decision's inputs).

A host status line can show "GPU culling: Auto (GPU, CPU-bound)".

**Measured live** (2026-10-03, headless, the GPU 75–99 % busy with other applications in most runs, so the numbers
are noisy; medians of 250 ms samples over 2 rounds × 16 s of motion + 8 s standing):

| Scene | Off fps / GPU ms | On fps / GPU ms | Auto (before tuning) |
|---|---|---|---|
| tiled, 1300×850, Play walk | 49 / 6.5 | 59.5 / 8.7 | GPU path all the time (right) |
| tiled, 1300×850, free fly | 20.5 / 8.8 | 23.5 / 20.3 | 1 switch to CPU, then stayed |
| tiled, 2500×1390, Play walk | 37.5 / 14.5 | 54.5 / 15.0 | flapped (3 switches a segment), 28.5 fps |
| tiled, 2500×1390, free fly | 34 / 19.3 | 29.5 / 34.5 | flapped (4 a segment), 23 fps |
| diorama, any | 60 (vsync) | 60 | GPU path, at most 1 switch |

The flapping made Auto slower than both fixed paths in the full-screen tiled cases. The controller was retuned
from these runs: a longer window and hold, a regret return, slower learning, and a 10 % bar to leave the GPU path.

In the re-run, Auto made 0 switches in all four tiled cases (1300 and 2500, Play and fly) and matched On. With the
GPU saturated by other applications, Off was 1–9 fps better on some full-screen segments. Pick **Off** by hand
there. Full numbers are in performance-plan §P15.

| API | What it does |
|---|---|
| `sm.setGpuCullingMode3D('auto' \| 'on' \| 'off')` | The mode (see above). Stored per machine. |
| `sm.setGpuDriven3D({ enabled })` | The low-level master switch (`setGpuCullingMode3D('off')` sets it false). `false` = the CPU path exactly. Returns the current values, including `mdiAvailable` and `ready` (the cull pipeline compiled; until then the CPU path draws). |
| `sm.setGpuDriven3D({ twins, ranges, prepasses, shadows, cpuState, lean, mdi })` | Per-piece A/B switches, all default `true`. Each off returns that piece to the CPU (`cpuState: false`: the GPU keeps its own LOD / twin hysteresis, which can disagree with the CPU's inside the 10 % band; `lean`: the CPU still builds every camera list; `mdi`: never multi-draw-indirect). |
| `sm.setGpuDriven3D({ mergePatterned, rankPatterned, rankCellM, subBundles })` | Draw-order / pipeline A/B switches. `mergePatterned` (default **false**): every record uses the full shader in one bucket; it costs main-pass GPU time and is kept only for A/B. `rankPatterned` (default true): the draw rank keys the plain / full shader choice, so the two never alternate. `rankCellM` (default **80** m): a spatial cell in the rank (a coherent draw order, −0.5 to −1 ms of main pass in both paths). `subBundles` (default false): leave out sub-bundles that draw nothing. Both paths read the same rank, so ON = OFF stays pixel-identical. |
| `sm.setGpuDriven3D({ shadowCompact })` | Default `true`: the dynamic shadow layers (far dynamic, cascade dynamic) draw from compact GPU-written lists, K draws each (a CPU upper bound of their casters). `false` = one indirect draw per caster record (the old way, for A/B). Same shadows either way. |
| `sm.setGpuDriven3D({ boundReach })` | Default `true`: the CPU upper bound that sizes the compact lists keeps the shadow-reach test, so K is about the real caster count (512 / 128 draws in the tiled street instead of 2048 / 512). `false` = the looser bound, for A/B. Same shadows either way; the main-thread cost is the same within 0.1 ms. |
| `sm.getGpuDrivenStats3D()` | Records, draw order, buckets, the GPU-reported counters of the last read-back frame (`draws`, `tris`, `meshesCulled`, `lodHidden`, `fogHidden`, `ranged`, `rangeTris`, `shadowsOn`, `shLeave` / `shJoin`), the shadow compaction (`shCompactOn`, `shBound`, `shK`, `shCount`, and `shCompactOver`, which must stay 0), and rebuild / bundle / upload counts and CPU ms. |
| `sm.verifyGpuDriven3D()` | Debug: resolves with the next frame's comparison of the GPU's draw set against the CPU path's lists (`missing` = an error, `extra` = harmless). |

`getFrameStats3D()` has `gpuDriven` (0 off, 1 on, 2 on + lean), `gpuMainDraws` / `gpuMainTris`, `gpuRecords`,
`msGpuSync` and `gpuOrphanDraws` (meshes drawn by the CPU while they wait to be placed in the GPU order). The GPU's
shadow draws are not in `shadowDrawCalls`.

**Frogmarks:** City → Performance gets a **GPU culling** selector, **Auto / On (GPU) / Off (CPU)**, default Auto,
with the hints in the mode table above. Wire it to `sm.setGpuCullingMode3D(mode)`. The engine stores the choice per
machine, so the host does not keep it in the document. Show `getGpuCullingMode3D().active` and `reasonText` next to
it, for example "Auto: GPU (CPU-bound)". This replaces the old on/off toggle on `sm.setGpuDriven3D({ enabled })`.

**For QA.**
- Nothing should look different ON vs OFF, anywhere: streets, roofs, sky, Play, fog horizon, night, Cel HD + ink
  outlines, PS1 look, resolution scaling, mirrors, SSAO, shadows while walking and turning, streaming while flying.
- `sm.setGpuCullingMode3D('off')` then `'on'` (or `sm.setGpuDriven3D({ enabled: false })` then `true`) in the
  console must not change the picture. In Auto, a path switch must not change it either.
- `await sm.verifyGpuDriven3D()` while moving: `missing` stays 0.

**Code:** `src/renderer/3d/gpu-driven.ts` (layouts + the CPU mirrors of every GPU rule; `gpu-driven.test.ts` checks
the mirrors against the real renderer frame by frame), `gpu-scene.ts`, `shaders/gpu-cull-shaders.ts`, and the
`_gd*` members of `renderer-3d.ts`.

## HLOD (distant buildings) (engine-roadmap step 5, performance-plan §P17, 2026-10-03)

In a tiled world with Stream to camera on and Full detail, everything beyond the active Tile-radius window is an
**outside tile**. Outside tiles = **HLOD** (the default since 2026-10-03) builds them as merged distant buildings
instead of the flat map, so the city reaches the horizon:
- **Mid** tiles (near the camera, out to `midTiles`, default 4 tiles): every building lot as an extruded shell with its
  facade colour (merged into ≤ 5 wall + ≤ 3 roof colour buckets), archetype roofs and landmarks, one merged ground.
  About 12 draws and 2.5 MB a tile.
- **Far** tiles (out to the **Skyline distance**, default 10 tiles): one ground sheet, one wall mesh, one roof mesh.
  3 draws and about 0.65 MB a tile.
- A tile changing level, or entering / leaving the window, **dissolves** (a screen-door dither, ~0.45 s): the new
  tier fades in over the old one, then the old one fades out. Shadows, ambient occlusion and reflections dissolve with
  it; ink outlines fade.
- Under the fog horizon (Hard edge + linear fog) a tile past the fog is always Far: it draws as the fog-colour
  silhouette, and the skyline can be raised a long way at little cost.
- Ortho and 2D views keep the Flat / Massing outside tiles. Outside tiles and the HLOD settings are session state (not
  saved with the document).

| Call | What it does |
|---|---|
| `sm.world.setStreamOutsideTiles('hlod' \| 'flat' \| 'massing' \| 'none')` | The outside tier (`salsaWorld.streamOutside(mode)` in the console). |
| `sm.world.setStreamHlod({ skylineTiles, midTiles, maxTiles, fade, fadeMs })` | HLOD settings, merged and clamped (skyline 2–24 tiles, mid 1–24, cap 16–400 tiles, fade 0–3000 ms); returns them. `sm.world.streamHlod` reads them. Console: `salsaWorld.hlod({...})`. |
| `sm.world.getStreamStats()` | `hlodMid`, `hlodFar` (live tiles), `hlodCached`, `hlodCacheMB` (the HLOD tile cache, ≤ 96 MB). Console: `salsaWorld.hlodStats()`. |

**Cost** (measured headless, see performance-plan §P17): at the same reach as Flat (skyline 5) HLOD draws about what
Flat draws from a rooftop (2,308 vs 2,344 draws, +12 % triangles) and 73 % fewer zoomed far out (127 vs 471). The default
skyline 10 streams ~100 outside tiles (rooftop 2,482 draws / 4.7 M triangles; Flat's 36 tiles: 2,344 / 3.8 M). In a fast
fly the heap and the geometry pool stay flat (60- and 120-tile flies: 720–840 MB heap, 110–140 MB pool).

**Frogmarks:** City → Layout → Outside tiles has **HLOD (distant buildings)** (the default) and, while it is selected, a
**Skyline distance** slider (tiles).

**For QA.**
- Fly forward over a tiled world (free camera, WASD): distant buildings fill in ahead and dissolve between levels; no
  holes in the skyline, no tile flashing.
- Skyline distance 4 → 16: the skyline grows live; back to 4 trims it. Outside tiles = Flat brings the flat map back.
- With Hard edge fog on: the skyline beyond the fog is a fog-colour silhouette with a hard top edge.
- Shadows of distant buildings fade with them during a swap (no shadow pop).

**Code:** `src/world/tile-hlod.ts` (the builds), `src/services/streaming/hlod-select.ts` (levels + settings), the
`_hlod*` members of `world-manager.ts` (keys, dissolves, LRU), `CityStreamSource.fullCapFor` / `hlodBoost` (worker
share), the HLOD branches in `fs_shadow`, `prepassFadeKeep` and the outline normal prepass.

## Streaming at speed (performance-plan §P19, 2026-10-03)

The full-detail window (Tile radius) now reacts to how fast the camera (or the Play character) moves. A full tile takes
2–4 s in a worker plus seconds of sliced reassembly, so the window used to ask for tiles it could never finish.
- **Prediction.** The window centres on where the focus will be about 3 s ahead (at most 1 tile). Tiles ahead are asked
  for first; tiles being left are cancelled sooner. Outside (HLOD) tiles also queue nearest-to-the-predicted-point first.
- **Fast (≥ 0.75 tiles/s, a free fly).** No new full builds start. Window tiles that are not full yet show their HLOD
  mid stand-in. Tiles already full stay full. The full window comes back once the speed stays under 0.4 tiles/s for
  150 ms. (`fast: 'landing'` keeps one full tile at the predicted landing point instead.)
- **Capped (a Play run).** Between the speed the full window can keep up with (measured from the real full-tile landing
  time) and 0.75 tiles/s, only a **corridor** builds full: the tile under the player and the tiles along the path,
  reaching as far ahead as a build takes to land (at most 4 tiles). The rest of the window shows stand-ins. In the
  measured Play run the tile under the player is full ~90 % of the time (it was under 10 % before).
- **Stand-in first.** While moving, a window tile with nothing on screen asks for its HLOD stand-in (a worker build)
  before its full build, instead of the old synchronous main-thread flat preview (18–70 ms per tile).
- **Old tiers dissolve.** A full / flat / massing tier replaced by HLOD dissolves out with the HLOD dither (4 coverage
  steps) instead of vanishing. Instanced copies (array groups) stay whole until the tier goes.
- **Worker recycling.** A cancelled full build kills its worker (so a stale 2–4 s build stops); the worker is now
  replaced at once. Before, each recycle shrank the pool for good and a long run could fall back to a 3 s main-thread
  build.
- **Optional impostor ring** past the last HLOD tile: `setStreamHlod({ ring: true, ringDepth: 5 })`. Off by default.

| Call | What it does |
|---|---|
| `sm.world.setStreamMotion(switches?, options?)` | A/B switches (`true` / `false` = all, or `{ motionWindow, fastWindow, cappedWindow, standInFirst, dissolveOldTiers, messageParts }`) and the motion options (`{ lookAheadS, maxLeadTiles, fastTiles, slowTiles, settleMs, fast: 'hlod' \| 'landing' \| 'off', landingS, adaptive, capTiles, capAheadTiles }`). Returns both. Console: `salsaWorld.stream19(on?, options?)`. |
| `sm.world.getStreamMotionStats()` | `speed` (tiles/s), `state` (`slow` / `capped` / `fast`), `lead`, `standIns`, `fastAt`, `capAt`, `corridor` (full tiles of the capped corridor), `fullLatencyS` (the smoothed full-tile landing time). Console: `salsaWorld.streamMotion()`. |
| `WorkerJobService.respawnRecycled` | false = the old lazy respawn of a recycled worker (A/B only). |

All switches are on by default and are session state (nothing is saved).

**For QA.**
- Free-fly fast over a tiled world (Full, Stream to camera): distant buildings stay dense under the camera, nearby tiles
  are HLOD buildings while you fly, and the full window fills in a few seconds after you stop.
- In Play, run in a straight line: the street under the character and ahead of it stays full detail; tiles to the sides
  may be HLOD buildings until you slow down.
- No long freeze when stopping after a long run.

**Code:** `src/services/streaming/motion-window.ts` (velocity, states, corridor), `_windowTileKeys` /
`setStreamMotion` in `world-manager.ts`, `StreamManager.shownChunks` / `isInflight`, `WorkerJobService._cancel`,
`world-jobs.ts postGroupParts`, `src/world/skyline-ring.ts`.

## Lighter tiles: instanced props (performance-plan §P20, 2026-10-04)

A streamed full tile used to bake every street prop (utility poles, signal heads, lamp posts, roof railings and plant,
parked cars' wheels, vending machines, benches, bollards, cabinets) into big merged meshes, twice (near and far
versions). Most of those props are the same few shapes placed hundreds of times. A full tile now stores one shape per
prop kind plus a transform per copy, and the GPU draws the copies instanced.
- **A tile is about a third lighter:** 134–145 MB → 90–96 MB of geometry (a 3×3 window ≈ 0.4 GB less to build,
  send and upload). The shapes are shared by every tile.
- **The picture is the same.** Each copy is fitted to where the baked prop stood (including the terrain's tilt) and is
  only instanced when every vertex is within 1 mm of the baked one; anything that does not fit stays baked. Frozen-clock
  A/B screenshots: the diorama is identical; a tiled world differs by 600–1,000 pixels away from the street (fewer than
  75 by more than 8/255: sub-pixel edges of thin poles and shadow filtering), the street views are at the noise floor.
- **Tree fix:** streamed tiles' trees could take another tile's tree shape (the tiles' different tree variants shared
  one name, so the first upload won). Each variant's name now includes its shape, so every tile draws its own trees.
- **Draw cost:** an instanced prop group draws all its copies when any is on screen, so the main pass draws more
  triangles than the old baked chunks (street view ~9.4 M vs 7.0 M); CPU per frame is about the same.
- **The window lands sooner:** 9 new full tiles after a fly land in ~7–9 s (was ~9–13 s). The next tile starts
  building as soon as a worker is free (it used to wait for the previous tile's reassembly), the terrain drape skips
  repeated corners, big groups come back from the worker in smaller messages, and a frame attaches at most 600 new
  meshes.
- **Play:** the street under and ahead of the player is full detail a bit more often, with ~0.4 GB less memory.
- **Not collidable:** instanced copies (poles, signal heads, lamp posts, roof plant, vending trim) are not Play collision
  geometry, like the trees, vending machines, bins and crates already were. Parked car bodies stay baked (and solid).

| Call | What it does |
|---|---|
| `sm.world.setLighterTiles(on?)` | A/B switches: `true` / `false` = all, or `{ propInstancing, internProps, splitParts, slotOnWorkerDone, drapeMemo, budgetNewSlots, cheapCompaction }`. Returns them. Build-side switches (`propInstancing`, `drapeMemo`, `splitParts`) apply to tiles built after the change. Console: `salsaWorld.p20(on?)`. |
| `sm.world.getLighterTilesStats()` | `{ propGeometries, newSlotWaits }` (shared prop shapes held; frames a ready group waited for the new-mesh budget). Console: `salsaWorld.p20Stats()`. |

All switches are on by default and are session state (nothing is saved). No host UI is needed.

**For QA.**
- Fly over a tiled world (Full, Stream to camera) and stop: the window fills in a little sooner than before; poles,
  signals, lamps, roof railings and vending machines look exactly as before, cast the same shadows and get the same
  outlines in the ink / cel looks.
- `salsaWorld.p20(false)` then retile (or change the seed and back) and compare: the same streets, heavier tiles.
- In Play, walking into a utility pole or a signal post passes through it (as with trees).

**Code:** `src/world/prop-instancing.ts` (parts → variants → fitted copies), `Accum3D.beginPart / endPart / nextPart /
autoParts` (`meshbuild.ts`), the part markers in `furniture.ts`, `signals.ts`, `lamp-post.ts`, `vehicle.ts`
(`emitWheel`), `building-geom.ts` (`post`), `building.ts` (`AUTO_PART_ACCUMS`), `streets.ts` (`scaleGeoY`);
`src/world/drape-memo.ts`; `world-jobs.ts splitLayers`; `StreamSource.holdsWorker`; `Scene3DManager._addPropArrayInstances`;
`ArrayGroup3D.instanceXf` and the affine branch of `Renderer3D._packArrayGroupInstances`; `Renderer3D._compactBookkeepingP20`.

## Shader variants (engine-roadmap step 8, performance-plan §P21, 2026-10-04)

The main mesh shader handles every material feature (patterns, window interiors, procedural ground, metal, water,
foliage, every render style) in one big program, so each pixel paid for all of them. The engine now also compiles
**specialised copies** of it for the material types that cover most of the screen (procedural ground, roof grids,
window facades, glass, painted metal, plain surfaces, tree crowns and wind-swayed props, water, neon), with the
material's settings baked in. Each mesh uses its copy when one is ready and the full shader otherwise. The picture is
identical either way (measured 0 differing pixels in every look); only the cost changes.

- **Effect:** the main 3D pass is 30–40 % cheaper. At 1300 × 850 in the 3×3 tiled city: −2.7 ms at street level to
  −4.9 ms from the air. At 2500 × 1390: −8 to −11.5 ms per frame.
- **Compile:** a city needs about 17 copies per look (PBR, Cel, Cel-HD, ink, toon each have their own set). They
  compile in the background, two at a time, after the common shaders (about 1 s each on the test machine; all ready
  within a minute of opening a city or switching the look). Nothing waits for them, and the "Preparing shaders" toast
  (keyed on `waitingDraws`) never shows for them. `sm.whenPipelinesReady3D()` and `getPipelineWarmup3D().pending` do
  include them, so a scripted screenshot that awaits "everything compiled" waits for them too.
- **Switch (diagnostics / A/B; session only, nothing saved):**

| Call | What it does |
|---|---|
| `sm.setShaderVariants3D({ enabled })` | Turn the specialised shaders on (default) or off. The image is the same either way. |
| `sm.setShaderVariants3D({ max })` | Cap the number of variant keys (default 128); keys over the cap use the full shader. |
| `sm.getShaderVariants3D()` | `{ enabled, keys, max, registered, ready, pending, failed, list }`; `list` = each variant's flags key, pipeline base and ms from request to ready. |

No host UI is needed. A "Rendering diagnostics" panel could expose the switch next to GPU culling.

**For QA.** Open a city, wait a minute, toggle `sm.setShaderVariants3D({ enabled: false })` / `true` with the camera
still: the picture must not change by a pixel; the GPU frame time (Performance panel) drops with it on. Same after
switching to Cel / ink / toon (a new set compiles; the first seconds after the switch run on the full shader).

**Code:** `src/renderer/3d/shader-variants.ts` (families, key, WGSL specialisation, ids), `Pipeline3D.variantPipeline`,
the step 8 glue in `renderer-3d.ts` (`_variantPipe`, the key read-back in `_writeGroundUvScale`, `_drawBatched`,
`_ensureDrawOrder` / `rankVariants`, the GPU-driven `stateCode` / `resolve`).

## Tile landing (performance-plan §P22, 2026-10-04)

When the camera stops (or jumps) in a tiled world, the 3×3 window of full tiles around it has to build and land. Four
changes make that lighter and put the tile under the camera first. The picture is the same (frozen-clock A/B: 0
differing pixels in both rendering paths).
- **The tile under the camera lands first:** ~3.2–3.8 s after a teleport (was 4.7–8.8 s). Its reassembly goes ahead of
  the other tiles' (every tile's ground still appears first), the main thread spends up to 10 ms a frame landing tiles
  while the camera is still (was 3 ms), and the full tiles keep all their worker slots while landing. Each full tile
  also builds on two workers at once. The whole window still takes ~6.3–8.4 s on the test machine (was 7.2–10.2 s):
  building nine full tiles is CPU-bound.
- **Tiles are a third lighter on the GPU:** a full tile's geometry 90–96 → 59–65 MB (the window ≈ 0.25 GB less GPU
  memory), by storing city vertices in 32 instead of 48 bytes (the same values; the dropped part was a constant) with
  16-bit indices. Characters and everything else keep the old format.
- **Street props cost fewer triangles:** an instanced prop kind (poles, lamps, signal heads, …) now draws only the
  copies near the view instead of all of them: the street view's main pass 8.75 → 7.0 M triangles.
- **Play:** the tile under the player is full more often during a run (88 % of the time, was 65 %).

| Call | What it does |
|---|---|
| `sm.world.setTileLanding(on?)` | A/B switches: `true` / `false` = all, or `{ landingBudget, nearFirst, splitTile, landingSlots, landingLedger, packedVertices, propCull }`. Returns them. `splitTile` applies to tiles built after the change; `packedVertices` re-places the GPU geometry pool on the next frame. Console: `salsaWorld.p22(on?)`. |
| `sm.scene3d.getGeomPoolStats3D()` | Now also `packMode`, `packGate` (2 = packing), `packedKeys`, `packedMB`, `packSkips`. |

All switches are on by default and are session state (nothing is saved). No host UI is needed; a diagnostics panel
could show `packedMB` next to the pool size.

**For QA.**
- Teleport or fly then stop in a tiled world (Full, Stream to camera): the tile you stand on fills in first, the ring
  around it after; nothing looks different from before.
- `salsaWorld.p22({ packedVertices: false })` with the camera still: the picture must not change by a pixel; the pool
  size (`getGeomPoolStats3D().liveMB`) grows by ~a third of the streamed tiles' share. `p22({ propCull: false })`: same
  picture, more triangles in the Performance stats.
- Hover a city landmark in a streamed tile: its outline still shows (the outline passes have packed versions too).

**Code:** `src/world/tile-speed.ts` (build switches), `src/world/tile-build.ts` (`TILE_HALF_OF`, `mergeTileHalves`,
`markPackable`), `src/world/drape-memo.ts` (`applyDrapeFused`), `TileWorkerPool.build(…, split)`,
`WorldManager.P22` / `_reassemblyBudgetMs` / `_landing`, `CityStreamSource.fullCapFor`; `src/renderer/3d/vertex-pack.ts`
(format, pool views, pipeline twins), `src/renderer/3d/tile-landing.ts` (renderer switches), the P22 parts of
`renderer-3d.ts` (`_poolView` / `_poolAlloc`, `_pkPrepare`, `_propCullTable`), `gpu-scene.ts` (`_fmtBind`, packed
buckets, instance-range jobs), `shaders/gpu-cull-shaders.ts` (`writeSpanInst`).
