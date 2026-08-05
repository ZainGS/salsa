# Hover Outline — animated patterned silhouette on mesh hover (+ building info card)

**Status:** ✅ P1–P3 BUILT (2026-08-03; 713 tests green, tsc clean; browser-verify pending — check in ORTHO first). P4 (more patterns / explicit any-mesh / any-building) not done. **Host wiring needed:** Frogmarks calls `sm.world.hoverLandmarkAtScreen(clientX, clientY, rect)` on pointermove over the city canvas + `sm.world.clearLandmarkHover()` on leave.

## The idea
Hover a building → a **thick outline** traces its silhouette, and that outline band is filled with an **animated pattern** (scrolling stripes / dots / checker). Reusable **generically** for any mesh; **start with significant buildings (landmarks)**. Optionally coupled with a small **info card** anchored to the building.

## The key finding — most of this already exists
The system-map turned up that Salsa **already renders a per-mesh silhouette outline on hover** — it's just flat-coloured and thin. So this is **not** a from-scratch build; it's an **FS upgrade + a city input path + a card**, which massively de-risks it.

- `src/renderer/3d/mesh-highlight-pass.ts` + `shaders/highlight-shaders.ts` — **`MeshHighlightPass`**. Stencil-ring technique: (1) write stencil=1 over the mesh, (2) re-draw the mesh with vertices **expanded along model-space normals** (`pos + normalize(normal)*width`, highlight-shaders.ts:102) with stencil `not-equal` so only the OUTSIDE ring paints, (3) clear stencil. Two style slots — `'hover'` and `'select'` (`writeParams`, ~195). The fragment shader currently just returns a **flat colour** (highlight-shaders.ts:107) — no UV, no time.
- **The whole hover pipeline is already wired:** pointer-move → `scene3d-manager.pick3D()` (~10103) → `setHoveredMesh(meshId)` (~9254) → resolves group / array-group membership → `renderer3D.setHoveredMeshIds(Set)` → consumed at `renderer-3d.ts:2098-2168` (hovered minus selected).
- **Animated pattern math already exists:** `patternMask(uv, mode, params, time)` in `mesh3d-shaders.ts:160-219` — stripes/dots/diamonds/checker/grid + a scrolling **waves** mode; time is `scene.ps1Config2.z = performance.now()/1000` (`renderer-3d.ts:2618`), always current.
- **Projection primitive for the card:** `worldToScreen3D(worldPos) → [px,py]|null` (`shape-manager.ts:8718`).
- **Keep-alive for the scroll:** `scheduleRender` + `beginInteractive/endInteractive` (`webgpu-renderer.ts:435-452`); the `ps1Config2.z` clock is free.

**Consequence:** an upgraded `MeshHighlightPass` gives the animated outline for **any pickable mesh for free** (hover already flows to it). The only real work beyond the look is **feeding it city buildings**, which are deliberately non-pickable.

## ★ Design rule carried over from SSAO
The whole effect must be **projection-agnostic** (works in **orthographic AND perspective** — the engine swaps them). `MeshHighlightPass` is stencil + geometry in screen space — it reconstructs nothing from the camera, so it is projection-agnostic by construction. **Do not** introduce any `cameraPos + rayDir·distance`-style reconstruction (that's what broke SSAO in ortho — see [ssao-versions.md](./ssao-versions.md)). Verify the band in **ortho first**.

---

## Architecture — two clean layers

### Layer 1 (generic): the animated outline pass — upgrade `MeshHighlightPass`
Make the outline **thick + patterned + animated**, per style slot. This is the reusable core; it applies to any hovered mesh.

1. **Thickness.** The band width is the normal-expand distance (`params.outlineWidth`, ~0.05 today). Expose it per slot; hover wants a chunkier value. Caveat: normal-expand thickness is in **model space**, so it varies with screen distance/scale — acceptable for a stylised halo; a screen-space-uniform width would need a jump-flood pass (Layer-1b, deferred).
2. **Pattern + scroll (the FS upgrade).** `highlight-shaders.ts` currently outputs a flat colour with no UV/time. Add:
   - a **UV** for the ring fragments — reuse the mesh UVs, or (cleaner for a band) the **screen-space position** so the pattern is continuous across the whole outline regardless of the mesh's UVs;
   - a **style uniform** per slot: `{ color, width, patternMode, patternColor, freq, angle, speed, glow }`;
   - a small copy of `patternMask` (or just the modes we want) driven by the same `ps1Config2.z` **time**, scrolling by `speed`.
   Output = `mix(color, patternColor, patternMask(...))`, optionally boosted so it catches **bloom** (emissive halo).
3. **API** (on `scene3d`/`ShapeManager`): `setHoverOutlineStyle3D({ patternMode, color, patternColor, width, speed, glow })` (tunes the `'hover'` slot) and the matching `'select'` style. Hover targeting is already automatic via `setHoveredMesh`. Add `setOutlineTarget3D(meshId | meshId[] | null)` for **explicit** (non-hover) outlining of any mesh — the generic reuse hook.
4. **Keep-alive.** While an outline slot is active, hold an **interactive lease** (or tick `requestRender3D`) so the scroll animates; release on clear. Follow the `world-manager _ensureTicker` self-stopping pattern.

### Layer 2 (city): feed landmarks to the outline — EXACT silhouette (decided)
City meshes are `pickable=false` (no BVH → 60fps), and **all landmarks are merged into ~9 per-material meshes** (`world:lm-stone/roof/dome/…`) — so a single building's real geometry can't be isolated from the existing meshes. The user wants the **exact** silhouette (torii, domes, masts traced — not a loose massing hull), so:

- **Per-landmark INVISIBLE silhouette mesh.** `buildLandmarks` additionally emits, per landmark, **one mesh containing that landmark's whole geometry merged** (all its materials, a single flat colour — it's never shown), flagged **outline-only / invisible**, baked at the **same anchor** as the visible building so the silhouette registers exactly. This is the hover-outline target. It reuses the real geometry → **exact** silhouette.
  - **Near-zero cost:** these meshes are invisible in the main pass and only the **one hovered** silhouette mesh is ever drawn (by the highlight pass). ~9–15 extra meshes' worth of duplicated landmark geometry (~30k tris total — trivial memory) and **no extra per-frame draws** except the hovered one.
  - **Keeps visible rendering unchanged:** the existing merged-per-material landmark meshes (and their colour/pattern/emissive variety) are untouched — we only *add* the invisible silhouette meshes. (This is why we don't split the *visible* landmarks into per-material-per-building meshes: that would be ~135 meshes and lose the merge.)
  - **One small pass change:** `MeshHighlightPass` must outline a hovered mesh even though it's flagged invisible in the main colour pass (an "outline-only" mesh). Contained.
  - **Naming for routing:** the silhouette mesh must carry `drape:'baked'` + the `lm-` name substring (or be explicitly excluded) so the domain-warp/LOD name-matched routing (`world-manager.ts:287` `STRUCTURE_LOD`, `:2608` `BAKED`) treats it like the rigid, anchor-baked landmark it mirrors — otherwise it drapes/LODs differently from the building and the outline drifts.
- **Cheap cursor pick (no BVH).** On pointer-move over the city, cast the cursor ground-ray (`MeshPicker.castRay` → intersect `y=groundY`) and **point-in-polygon** against each `Landmark.footprint` (~9–15 tests). Reuses the region-editor's mesh-free ground-resolve path; never touches the merged city meshes.
- **Wire it:** hovered landmark → `setHoveredMesh(silhouetteMeshId)` → the upgraded highlight pass traces the exact building. Leave → clear. Route the id as a **standalone** (not group-expanded), so hovering one landmark doesn't outline all of them (`setHoveredMesh` expands to group siblings — the silhouette meshes must be parentless or each in its own group).

### Layer 3 (coupled): the info card — IN-CANVAS via HtmlTexture3D (decided)
Rendered **inside the engine**, not host DOM — using the already-built HTML→texture path.

- **Card = a billboard sprite with an HTML texture.** `createSprite3D(center.x, groundY + LANDMARK_H[type] + gap, center.z, w, h)` (shape-manager.ts:8460) with `mesh.billboard = true` (renderer reorients it to face the camera every frame — projection-agnostic, renderer-3d.ts:2897/2961), then `setHtmlTexture3D(sprite.id, cardHtml, W, H)` (shape-manager.ts:9610). The card is authored as **styled HTML** (title + rows + a swatch) and rasterized by `HtmlTexture3D`'s Canvas-2D tier — **built, shipping, cross-browser** (`docs/specs/html-canvas-3d.md`). Update on hover-change via the faster `updateHtmlTexture3D` (reuses the texture). Hide by removing/parking the sprite on hover-leave.
- **NOT the LiveText/DPR path.** The DPR bug that disabled the *live editable* text node (`text-effect-engine.ts` captureElement) does **not** touch `HtmlTexture3D` — the static card renderer is unaffected. **NOT the Shell UI** (it takes over the whole swapchain — wrong compositing model).
- **Three tradeoffs to handle** (a billboard sits in the 3D pass):
  1. **Occlusion** — buildings would cover it. Lift it above the roofline (`+ LANDMARK_H + gap`) and/or give the card material a **depth-test-off / late-draw** flag so it always reads on top.
  2. **Distance scaling** — a world sprite shrinks with distance; for a roughly constant on-screen size, **scale the sprite by camera distance** each frame (a small per-hover update).
  3. **Crispness** — render the HTML texture at ~**2×** the on-screen size (generous `W/H`) so text stays sharp.
- **Content:** start minimal — **name + type** (`LANDMARK_LABEL[type]`, signtext.ts:17 → e.g. "City Hall", civic). Keep the card HTML a thin view over a `LandmarkInfo` payload so the data can grow (height, zone, district, and eventually the **generation params** — hovering a building surfacing how it was generated fits the Frogmarks "params as source" direction) without touching the outline.

---

## Reuse map (what to touch)
| Need | Reuse / touch |
|---|---|
| Outline mechanism | **`mesh-highlight-pass.ts`** (stencil-ring + normal-expand) — extend, don't replace |
| Outline look (pattern+time) | **`highlight-shaders.ts`** FS — add UV/time/style; borrow `patternMask` from `mesh3d-shaders.ts:160-219` |
| Time clock | `scene.ps1Config2.z` (`renderer-3d.ts:2618`) — free |
| Hover flow | `pick3D`→`setHoveredMesh`→`setHoveredMeshIds` (already wired) |
| City building pick | `MeshPicker.castRay` (`mesh-picker.ts`) + ground-plane hit + point-in-`Landmark.footprint` (`types.ts:53`) — NO per-mesh BVH |
| Building silhouette (EXACT) | NEW invisible per-landmark **silhouette mesh** (real geometry merged) from `buildLandmarks` (`landmarks.ts:75-122`); outline-only target |
| Card renderer | **`HtmlTexture3D` + `setHtmlTexture3D`/`updateHtmlTexture3D`** (`html-texture-3d.ts`; `scene3d-manager.ts:13511`) — BUILT/shipping |
| Card sprite | `createSprite3D` (`shape-manager.ts:8460`) + `mesh.billboard=true` (`renderer-3d.ts:2897/2961`) |
| Card labels | `LANDMARK_LABEL` (`signtext.ts:17`) |
| (Not used) | Shell UI (swapchain takeover); host-DOM overlay; proxy prism |
| Keep-alive | `beginInteractive/endInteractive` (`webgpu-renderer.ts:451`) |

## Phasing
- **P1 — generic animated outline.** Upgrade `MeshHighlightPass`/`highlight-shaders.ts` to thick + patterned + scrolling; per-slot style + `setHoverOutlineStyle3D`; keep-alive lease. **Verify on a plain pickable mesh (a box / a character) in ORTHO first, then perspective.** Ship one pattern (scrolling stripes). *(Any pickable mesh gets the effect for free once this lands.)*
- **P2 — landmarks, exact silhouette.** `buildLandmarks` also emits a per-landmark **invisible silhouette mesh** (real geometry, `lm-`-named, `drape:'baked'`) + the small `MeshHighlightPass` change to outline an invisible/outline-only mesh; footprint cursor-pick → `setHoveredMesh(silhouetteId)` as a standalone. Hovering a significant building now traces its exact outline.
- **P3 — in-canvas info card.** Billboard sprite (`createSprite3D` + `billboard`) + `setHtmlTexture3D(cardHtml)`; anchor above the roofline, depth-test-off, distance-scale, 2× texture; `LandmarkInfo` payload (name/type) with a data hook.
- **P4 — polish + generalise.** More patterns (dots/checker) + style presets; `setOutlineTarget3D` for explicit any-mesh outlining; optional **double band** / glow-into-bloom; ease-in on hover-enter; screen-space-uniform thickness via a jump-flood pass if model-space width looks uneven; extend to any building (not just landmarks) — needs a per-building silhouette source, e.g. reuse the split for regular buildings or an on-demand hull.

## Decisions (locked)
1. **Silhouette:** **EXACT** — per-landmark invisible silhouette mesh (real geometry), not a proxy prism.
2. **Card:** **IN-CANVAS** — `HtmlTexture3D` on a billboard sprite, not host-DOM, not Shell UI.
3. **Pattern UV space (still open, minor):** ring-UV (wraps the form) vs **screen-space** (continuous field revealed by the band) — I lean **screen-space** for P1; trivial to switch.
4. **Scope:** landmarks first; any-mesh generalisation is P4 (nearly free for pickable meshes; regular buildings need a silhouette source like the landmark split).

## Risks
- **Model-space thickness** varies with scale/zoom (stylised, usually fine; jump-flood is the fix if it bothers you).
- **Outline-only mesh rendering:** the highlight pass must process a hovered mesh that's invisible in the main pass — one small, contained change (drive the highlight stencil/outline from the hovered set regardless of main-pass visibility).
- **Silhouette registration:** the invisible silhouette mesh must bake to the **exact same anchor** (and `lm-`/`baked` routing) as the visible landmark, or the outline drifts off the building on slopes.
- **Card occlusion / scale:** handled by roofline lift + depth-test-off + camera-distance scale (Layer 3).
- **Group-expansion trap:** `setHoveredMesh` outlines all group siblings — silhouette meshes must be parentless / own-group, or hovering one landmark outlines all.
- **Projection-agnostic:** satisfied by construction (stencil/geometry + billboard reorient, no reconstruction) — but **must be checked in ortho**, per the SSAO lesson.
- **Perf:** outline runs only while hovered; only the one hovered silhouette mesh ever draws; footprint pick is ~a dozen point-in-polygon tests per pointer-move — negligible.
