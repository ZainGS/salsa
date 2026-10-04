# Occlusion Culling — plan + is it worth it?

> **STATUS 2026-10-01 (performance-plan.md §P11):**
> - **Phase 0 MEASURED.** Play third person at street level, diorama + tiled 3×3:
>   - Perfect per-mesh occlusion would remove ~48–50 % of the main-pass triangles in the diorama and 72–74 % in the tiled world.
>   - A box test against the building walls alone gets 20–24 %.
>   - Looking at the ground, only ~1.5 % (the ground is the only "occluder").
>   - The view still reaches through a wall to the far plane, so facing one changes little without occlusion.
> - **Phase 1 tightening BUILT, default on:** `Renderer3D.rangeCulling`, sub-mesh cull ranges, bit-identical.
>   - Heavy merged chunks and whole streamed-tile layers draw only their 256-triangle runs inside the view and inside each near cascade.
>   - Main pass −14 to −40 %, near cascade −25 to −52 %.
> - **A CPU software occlusion cull BUILT, default OFF:** `Renderer3D.occlusionCulling`, `src/renderer/3d/occlusion-culler.ts`.
>   - It is a hybrid of Phase 3 with building-wall occluders, run in the same frame, so there is no latency.
>   - Conservative by construction; 0 wrongly culled meshes over 112 checked frames of fast turns and Play walking.
>   - It drops 15–27 % of main-pass triangles and 27–40 % of draw calls.
>   - It costs 1–4 ms CPU a frame (tiled: ~10 k occluder polygons) for no measurable GPU change, since the main pass is pixel-bound (P6). So it stays opt-in.
> - **Recommendation:** occlusion pays only with a GPU-driven path (Phase 4: Hi-Z from the SSAO depth prepass + a compute cull feeding indirect draws), or for walk mode via the Phase 2 PVS. Neither is built.
> - **Update 2026-10-04:** the GPU-driven half IS built and ON by default — performance-plan §P15 (compute cull →
>   `drawIndexedIndirect` in render bundles, `Renderer3D.gpuDriven`, `sm.setGpuDriven3D` / `setGpuCullingMode3D`,
>   `src/renderer/3d/gpu-driven.ts`, `gpu-scene.ts`). Only its **Phase D Hi-Z occlusion stage is not built**; the Phase 2
>   street-canyon PVS is not built either. The CPU occlusion cull above stays built and off. Index:
>   [../STATUS-2026-10-04.md](../STATUS-2026-10-04.md).

> **Deliverable of this pass:** this SPEC only (analysis + phased plan + a go/no-go per view mode). Nothing built.
> *(Superseded by the STATUS block above: Phases 0–1 + a CPU Phase-3 hybrid are built.)*
> Save as `docs/specs/occlusion-culling.md` (+ backlog line + memory pointer). Companion: [[city-lod]] (zoom-gated
> detail cull), [[spatial-streaming]] (view-driven geometry disposal), [[street-level-mode]] (the future first-person
> view that MOST wants this), [[depth-precision]] (reversed-Z, relevant if we build Hi-Z).

## Context — what culling the city ALREADY does
Occlusion culling only matters on top of what's here, so first the baseline (all in `renderer-3d.ts` + the world managers):
- **Frustum culling** — per-frame, `FrustumCuller`, ~700 meshes; plus **whole-group** cull (an off-screen per-cell
  group skips ALL its instances). Working.
- **LOD** — [[city-lod]]: detail hidden past a zoom threshold; far buildings drop to mass.
- **Tiled streaming** — [[spatial-streaming]]: geometry OUTSIDE the focus window is DISPOSED (memory scales to the
  view, not the world). This is the closest thing to occlusion we have — it culls by *distance/region*, not by
  *what's hidden behind what*.
- **Instancing** (trees/clutter/detail/cars), **shadow-map throttle + suspend**, an **SSAO depth prepass** + an
  **outline depth-normal prepass** + the **shadow depth render** (three depth passes already exist).
- **Draw path (critical constraint):** draws are **CPU-issued per mesh** — a shared vertex/index buffer with
  per-mesh `(firstIndex, baseVertex)` slices, `drawIndexed` per mesh after the frustum test (array-groups draw an
  instanced range). It is **NOT GPU-driven indirect.** So "cull a mesh" today = "the CPU loop skips its draw call."

**What's missing:** nothing skips a building because it's HIDDEN BEHIND another building. That's true occlusion culling.

## Is it worth it? — benefit depends entirely on the view mode
The user's three view modes have very different occlusion profiles:

| View | Occlusion present? | Benefit of OC | Why |
|---|---|---|---|
| **Ortho, top-down (current default)** | almost none | **LOW** | You look down at rooftops; buildings barely occlude each other. Frustum + LOD already do the job. |
| **Perspective, orbit / low angle** | moderate | **MEDIUM** | Front rows hide back rows; a dense skyline has real overdraw. Worth culling if profiling shows fill/draw pain. |
| **Street-level walkaround (future)** | massive | **HIGH ★** | Inside a street canyon you can see maybe 2–4 blocks down each connected street; the walls occlude ~90 % of the city. This is where OC pays for itself many times over — and it's the reason to plan now. |

**Verdict:** for the *current* iso/orbit views, occlusion culling is **not** a priority — frustum + LOD + streaming
carry it, and the honest first step is to MEASURE (below) rather than assume. But **street-level makes it a real
need**, and the cheapest, highest-leverage technique there is *not* the fancy GPU one — it's a graph PVS.

## Phase 0 — MEASURE first (don't cull blind)
The renderer already has a per-frame profile (`drawCalls`, timings — `renderer-3d.ts:952`). Before building anything:
- In each view mode, read `drawCalls` + GPU frame time. Determine the bottleneck: **CPU draw submission** (too many
  `drawIndexed` calls) vs **GPU overdraw/fill** (too many shaded pixels).
- OC helps BOTH — CPU-side culling removes draw calls; hidden-surface removal removes overdraw — but the RIGHT
  technique differs by which dominates. If the city is GPU-fill-bound in perspective, OC helps a lot; if it's
  CPU-draw-bound, the bigger win is *fewer, batched draws* (GPU-driven indirect — see Phase 4), which OC composes with.
- Also confirm streaming isn't already the answer for street-level (a tight focus window disposes most of the far
  city → little left to occlude). It may make heavy OC unnecessary.

## The technique options (and their fit for THIS engine)
| Technique | How | Fit here | Cost |
|---|---|---|---|
| **Graph / cell PVS (portal-ish)** | Precompute, per road CELL, which blocks are visible down the connected street segments (a canyon sees a few blocks each way). Runtime = O(1) lookup of the visible set for the cell you're standing in. | ★ **Best for street-level.** Reuses the road graph + block structure we already have; deterministic; near-zero runtime cost. Composes with the active-region/streaming machinery. | Precompute per city (cheap, seed-deterministic); tiny runtime. |
| **CPU software occlusion** | Rasterize a handful of BIG occluders (tall buildings) into a low-res CPU depth buffer each frame; test other meshes' AABBs against it before issuing their draw. | Fits the CPU-issued draw path directly (no GPU rearchitecture). Good for orbit. | Moderate CPU/frame; occluder selection heuristics. |
| **GPU Hi-Z occlusion** | Build a hierarchical-depth pyramid from a depth prepass (we HAVE prepasses), test AABBs in a compute pass, cull draws. | Powerful + scales to thousands, but needs either occlusion QUERIES (1-frame readback latency → temporal artifacts) or **GPU-driven indirect draws** — and our draws are CPU-issued, so this is a draw-path rearchitecture. | High eng; best ROI only when CPU draw submission is the ceiling. |
| **Hardware occlusion queries** | WebGPU `occlusionQuery`: draw AABBs, query pixels-passed, skip draws that fail. | Simple API but per-object query overhead + readback stall/lag; poor for hundreds of small meshes. | Low eng, poor scaling. |

## Recommended phasing
1. **Phase 0 — measure** (above). Gate everything on real numbers per view mode.
2. **Phase 1 — cheap tightening (no OC)**: distance cull for tiny props, more aggressive far-LOD in perspective,
   per-instance frustum for big city-wide array-groups (whole-group cull is coarse when a group spans the map). Often
   removes the perceived "need" before any OC.
3. **Phase 2 — Street-canyon PVS ★ (build WITH street-level)**: the targeted big win. Precompute per-cell visible
   block sets from the road graph; at street level, draw only the visible set + neighbours. Cheap, deterministic,
   reuses existing graph + streaming. **This is the one to actually build**, and only when street-level lands.
4. **Phase 3 — CPU software occlusion for orbit** (only if Phase 0 shows perspective fill/draw pain): big-building
   occluders → low-res CPU depth → AABB reject before draw. General, fits the CPU draw path.
5. **Phase 4 — GPU-driven indirect + Hi-Z** (only if CPU draw submission is the proven ceiling): move the ~700 CPU
   `drawIndexed` calls to indirect draws fed by a compute cull (frustum + Hi-Z) built off a depth prepass. Biggest
   engineering, biggest scaling ceiling — but a real rearchitecture, so justify it with numbers first.

## The honest recommendation
- **Now (ortho + orbit):** don't build occlusion culling. Frustum + LOD + streaming suffice; if orbit feels heavy,
  Phase 1 tightening is the cheap fix. Measure (Phase 0) before anything.
- **When street-level is built:** build the **Phase 2 graph PVS** — it's cheap, deterministic, reuses what we have,
  and it's the difference between "walk around a full city" and "melt the GPU." That's the one occlusion technique
  this project will genuinely need.
- **Defer** the GPU Hi-Z / indirect rearchitecture (Phase 4) unless profiling proves CPU draw submission is the wall;
  it's a large investment whose payoff a PVS + streaming largely pre-empts for the diorama + street views.

## Open questions for build time
- Does the tiled streaming focus-window already dispose enough of the far city at street level that a PVS is
  gilding? (Measure at street-level once it exists.)
- If we go GPU-driven (Phase 4), pair it with [[depth-precision]]'s reversed-Z so the Hi-Z pyramid has usable
  precision at range.
- Transparent/emissive night lights + bloom: OC must not cull the *source* of an on-screen bloom/light-pool that
  spills into view — cull geometry, keep the light candidates (they're already a separate camera-followed set).
