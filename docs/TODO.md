# Salsa — TODO / Roadmap

A living, consolidated list of remaining work. Grouped by area; each item tagged **[status]**.
Status legend: **[next]** teed up · **[planned]** spec'd, not built · **[partial]** built but incomplete ·
**[wiring]** engine done, host (Frogmarks) UI pending · **[idea]** not yet spec'd.

> Companion doc: [SYSTEMS.md](./SYSTEMS.md) — what already exists (reuse before rebuilding).
> Deeper specs live in [docs/specs/](./specs/); host UI contracts in [docs/ui/](./ui/).
>
> ⚠ **Fix list from the 2026-09-28 audit:** [audit-2026-09-28.md](./audit-2026-09-28.md) — persistence data-loss
> bugs, renderer robustness, CI/lint, architecture, character system. Its Tier 1 (persistence) comes before new features.
> **Newer audit: [audit-2026-10-04.md](./audit-2026-10-04.md)** (the user is working through it).
>
> ★ **Status index for 2026-09-28 → 10-04 (built / not built / defaults / caveats): [STATUS-2026-10-04.md](./STATUS-2026-10-04.md).**
> Perf + streaming order of work: [specs/engine-roadmap-todo.md](./specs/engine-roadmap-todo.md) (steps 0–9, Later) and
> [specs/performance-plan.md](./specs/performance-plan.md) P1–P22. Items below were re-checked against the code on 2026-10-04.

---

## GARP — Grouped Asset Randomizer Pool
Spec: [specs/city-props-garp.md](./specs/city-props-garp.md) · Host contract: [ui/garp.md](./ui/garp.md)

- **[next]** Browser-verify the per-face body unwrap: `salsaGarp.paintBody()` → paint front + a side → `saveVendingSkin` → regenerate → confirm patches land on the right faces. Fix any face that comes out rotated/mirrored (per-face UV tweak in `vendingShellGeometry`).
- **[wiring]** Real brand art — host registers real skins via `registerGarpPool3D` (key `vending/<brand>/<slot>`), replacing the solid-color placeholders. Engine side complete.
- **[built]** `products` slot instanced in the city (Option A: a flat GARP-skinned display panel behind the glass; both `body` + `products` now `live`, coordinated per skin). NEXT: the richer 3D-bottles display is a separate street-level feature, not this slot.
- **[planned]** Single-layer atlas update — `rebuildGarpAtlas3D` is a full rebuild; add a per-layer upload for live per-stroke 3D preview (fine as-is for save-commit).
- **[planned]** Persistence pin-vs-latest decision — does a saved city pin a pool `version`/hash or take latest? Decide before cities are shared widely. Recommendation on record: pin, with content-addressing/local-cache so a city survives an unpublished pool.
- **[idea]** GARP for other props — the pool system generalizes to bike-racks, bollards, shop signage, poster boards, kiosks.

---

## Props & street furniture
Spec: [specs/city-props-garp.md](./specs/city-props-garp.md)

- **[built]** Lamp posts + banners (`world/lamp-post.ts` + manager + `lamp-post` creator; emissive lamp head + windSway banners). NEXT: optional city placement in `furniture.ts` (careful — streets.ts already emits massed street lights) + GARP/decal art on the banner.
- **[planned]** Trash bins / post boxes upgraded from single boxes to real sub-layered generators (easy on the `ProceduralObjectManager` + creator-registry template — "new prop ≈ 5 members + a schema entry").
- **[idea]** More Tier-1 props: utility cabinets, planters, A-boards, ticket machines.

---

## Decals
Spec: [specs/decals.md](./specs/decals.md) · Host contract: [ui/decals.md](./ui/decals.md)

- **[built]** Mode A — floating quad on a picked surface (place/tool/persist).
- **[built]** Mode B — baked-into-texture: `sm.stampDecalAtUV3D` / `stampDecalAtScreen3D` composite a decal image into the mesh's paint texture (transparent decal layer + `texOverBase`), curves/wraps with the surface. Harness: `salsaDecal.stampDemo`. NEXT (host): a "decal stamp" tool button within UV Paint + a ghost preview; browser-verify orientation/flip.
- **[planned]** Mode C — conforming decals (project onto geometry).
- **[planned]** City-scatter decals (posters/stickers auto-scattered like ground scatter).

---

## Foliage
Spec: [specs/foliage-generator.md](./specs/foliage-generator.md), foliage-quality.md

- **[built]** Alpha "leaf-card" render path (`render:'card'`) — sets the leafCard material (bit 13) and is used by the city trees (`city-foliage.ts`, `biome.ts`). The default param is still `'chunky'`; the "falls back to chunky" comment at the top of `foliage.ts` is stale (2026-10-04).
- **[idea]** Foliage Creator mode polish + more species presets.

---

## Buildings & city detail
Specs: [specs/building-generator.md](./specs/building-generator.md), city-detail.md, city-visual-upgrade.md, instancing-blocks.md

- **[built]** `buildStreets` → `buildBuilding` is wired **and on by default** (`types.ts` `detailedBuildings: true`; each lot fills with a full procedural building, metres→city scale-bridge in `streets.ts`). Remaining: **[next]** a subjective building *visual tuning* pass (not wiring).
- **[planned]** Building Generator Phase 8 — LOD + a Building Designer UI.
- **[partial]** Shop "blade" signs in `signtext.ts` are still colored rectangles — only landmark plates + shotengai boards are real text. Needs a text/sign atlas pass.
- **[built]** City Visual Upgrade — realised through city-quality-upgrade.md, visual-polish-next.md (items 1–16; open: 1b diorama skyline, 3b per-trade interiors, 6b advert images, 7b occluder fade) and fog-horizon.md; CityLook + scene presets (docs/ui/city-quality.md). Not built: god rays / lens flare. Browser check pending for much of it.
- **[partial]** Instancing tiers (instancing-blocks.md): P0–P2 + Blocks built 2026-07; instanced trees, P9 far twins, P12 instanced crowd, P20 instanced props shared across tiles (`sm.world.setLighterTiles`, on). Left: whole-building instancing, the city consuming Blocks.

---

## World borders / streaming / LOD
Specs: [specs/world-borders.md](./specs/world-borders.md), spatial-streaming.md, performance-plan.md P7–P22 (there is no `city-lod.md`; memory `project_city_lod`)

- **[built]** Void grid + border glow (Phase A, now default off), terrain apron (Phase B), flat multi-tile world (Phase C), spatial tile streaming with the eye-centred window (P10.D), streaming hitches (P16), HLOD + endless skyline (P17, default on), speed-aware window + Play corridor (P19), lighter tiles / tile landing (P20, P22), detail LOD by camera height (P7–P9).
- **[planned]** World borders: shader tiny-planet dome (Flat/Planet modes), true sphere (hex→Goldberg).
- **[built]** LOD far-box proxy + distance bands — superseded by P10 `farMassing` / the massing tier, the HLOD far tier and P7/P8 bands. Left: building-attached greenery is still merged into the building (not instanced).
- **[partial]** Faster tile landing: focus tile 3.2–3.8 s, 9-tile window 6.3–8.4 s; the ≤ 4 s target is not met (P22 "Left").
- **[planned]** Hi-Z occlusion (P15 Phase D) and the street-canyon PVS; the CPU occlusion cull is built but off (P11).

---

## Rendering / shaders / depth
Specs: [specs/depth-precision.md](./specs/depth-precision.md), 3d-shaders reference · **Lighting deep-dive: memory `project_lighting_shadows`**

- **[built]** Lighting overwrite fix (A) + city-lighting toggle/persistence (B) — the city snapshots global lighting on enter, restores on exit; `sm.world.setOverrideGlobalLighting(on)` (default on) chooses city-drives vs inherit-global; `worldParams.lighting` persists timeOfDay+toggle. See memory `project_lighting_shadows`.
- **[built]** Shadow fix (C) — the structural defect (origin-locked box → no shadows outside it in tiled/panned worlds) is fixed: the ortho box now **follows the camera focus** (`renderer-3d.ts` `_updateShadowCenter`, called in `uploadSceneUniforms` before the light matrix), **texel-snapped** so panning doesn't shimmer, and refreshes the throttled map only when the snapped centre moves a texel. Toggle `sm.scene3d.setShadowFollowCamera3D(on)` (default on) reverts to the origin-locked box. NEXT (browser-verify): shadow consistency across a panned/tiled city + no shimmer while panning. Follow-up **[built]**: the box is now **zoom-adaptive** — `_updateShadowCenter` shrinks the effective half-extent toward the visible footprint (`≈1.1 × camera distance`, floor `8`) when zoomed in → 2048 texels cover a small area → **sharp** shadows, and grows back to the full base box when zoomed out → the whole view still gets shadows. Bias scales with the effective texel size (`_effBias`), cutting peter-panning. `HE_PER_DIST`/`MIN_HE` in `renderer-3d.ts` are the tuning knobs (browser-tune: too small → edges cut off; too large → less sharpening). Remaining (only if browser shows it's not enough): cascaded maps. **(2026-10-04: cascades are BUILT — `shadow-cascades.ts`, plus P14 static / dynamic shadow caches and Low–Ultra quality presets, `sm.setShadowQualityPreset3D`; left: a second cached cascade level.)**
- **[partial]** *(2026-10-04: half-res + `worldParams.lighting.ssao` persistence are built and city looks turn SSAO on; still not done: the auto-off for cel / PS1 styles, skinned characters in the prepass.)* SSAO (spec [specs/ssao.md](./specs/ssao.md)) — **Stages 1+2 built** (debug buffer browser-verified clean: no silhouette halos, no near→far bleed). Stage 1: world-position depth prepass → AO estimate (improved closer-neighbour normal reconstruction) → depth-aware bilateral blur → debug view. Stage 2: the mesh FS multiplies the **ambient term only** by AO (group-0 binding 3/4; 1×1 white bound when off → exact no-op; before bloom since it's in the color pass). Toggle `sm.scene3d.setSSAO3D(on, {radius,intensity,bias,power})` / `setSSAODebug3D` / harness `salsaSSAO`. Off by default. **NEXT:** browser-verify Stage 2 (creases grounded, sun shadows not double-darkened, tune intensity), gate off for cel/PS1 styles, persist `ssao` in `worldParams.lighting` (Fix A+B scope). Stage 3: half-res + depth-aware upsample, quality tier + tiled-full auto-off. Characters (skinned) not yet in the prepass → bind white (no AO) for now.
- **[idea]** "AO Clay" render style — promote the SSAO debug view (matte white/greyscale occlusion render) into a real stylized render style alongside cel/ink/sketch (small; reuses the AO buffer; add a touch of directional shading so forms read). User flagged it.
- **[partial]** Filmic tone-map / color grade pass — the film look + colour grade (split-tone, LGG, wide Kawase bloom) are built (film-look-and-toon-shadows.md, city-quality P6/P7); a real ACES / Reinhard tone-map is not.
- **[built 2026-10-03/04, default OFF]** TAA / TAAU (`sm.setTemporalAA3D`, P18) — switch on after a real-GPU browser pass.
- **[built, default ON]** GPU-driven rendering (P15), shader variants (P21), sim LOD (P13), device-lost recovery (docs/ui/device-recovery.md).

---

## Character / rig / animation
Specs: [specs/character-variety.md](./specs/character-variety.md), hair-styles.md, emotes.md, dollz-creator.md

- **[partial]** `body-generator.ts` self-describes as a v1 prototype — silhouette/posture refinements pending (base-body sculpt is being tuned).
- **[partial]** Spring bones — engine core + hair tails + charm dangles built (lock tails / braids are spring-tagged); open: long loose locks, skirt chains, capsule colliders, VRM export, authoring UI.
- **[partial]** Character Variety — seeded randomizer built (`sm.createRandomCharacter3D`, lock hair styles); open: outerwear, fabric material presets, fashion collections, crowd hook.
- **[built 2026-10-04]** Hair style system — `hairMode: 'locks'`, 15 styles (`sm.getHairStyles3D` / `applyHairStyle3D`; hair-styles.md B–E + part 2). Part 2 styles + `headShape` need a dist rebuild for Frogmarks.
- **[in progress 2026-10-04]** Clothing fit round 2 (body-hiding mask, cloth lining, hip-weight smoothing, knee fix, layer order, skirt hem) — another agent; docs pending (clothing-generation.md, ui/character-creator.md, ui/play-mode.md).
- **[planned]** Emotes — AC/anime 2D joint-anchored billboards (sweat/anger/notes), phased A–C.
- **[planned]** Dollz/Fashion Creator — PS1/dollcore character + card creator wrapping the Fashion Creator.
- **[idea]** Wardrobe expansion — drapes + garment layering beyond the built charms/taper/cutouts.

---

## UV / texture / paint
Host contract: [ui/garp.md](./ui/garp.md) (region overlays)

- **[partial]** Edit Mesh — knife tool + auto-UV noted as remaining (Phase 2–3 otherwise built).
- **[built]** UV-paint persistence on PROCEDURAL props — painting a creator object (which regenerates from a marker, changing child mesh ids) now survives reload via a stable `__proc__:containerId:childName` key (same pattern as garments/faces). `_procMeshKey` + `_restoreProceduralMeshTextures` in shape-manager.
- **[idea]** Surface GARP library access inside UV Paint mode — let a UV-paint session pull/apply a GARP skin (the integration the systems-doc exercise surfaced; see SYSTEMS.md reuse notes).
- **[note]** `MeshPaintManager` is the legacy Phase-1 painter, superseded by the `UVPaintController` path — candidate for removal/consolidation.
- **[wiring]** UV Paint toggle + mesh-texture library surfacing in Frogmarks.

---

## Packaging (Package Creator)
Spec: [specs/packaging-templates.md](./specs/packaging-templates.md)

- **[next]** Print-PDF export → then package mechanisms M3/M6/M7. (2026-10-04: the PDF writer `packaging/print-pdf.ts` exists but is only used by the CD kit, `sm.exportCDKitPrintPDF3D`; box-dieline print-PDF is still not built.)

---

## Host (Frogmarks) UI wiring — engine done, panel pending
- **[wiring]** GARP "Skins" panel — BUILT by Frogmarks; keep in sync with `garpSlotRegions3D` region overlays + the `body`/`products` slots.
- **[wiring]** City Detail panel toggles (day/night, weather, holograms, shader modes), scene grid toggle, anime face/eyes, hair — engine features exist; host toggles pending.
- **[wiring]** Frogmarks integration status notes are stale in places — verify against code, not notes.

---

## Text / ephemera
Specs: retro-text/ephemera, html-in-canvas-text.md

- **[partial]** HTML-in-Canvas live text — the DPR bug is fixed and the path is on when `htmlInCanvasAvailable()` (2026-06-16); a live Canary test is pending.
- **[built]** Retro text Phase 2 (ephemera kit + blendMode) and Phase 3 (arc text) — engine done (retro-text-ephemera-polish.md); Frogmarks exposure only.

---

## Shell UI
Spec: [specs/shell-ui] · Memory: project_shell_ui

- **[partial]** ShellUIManager data/state built; renderer-coupled lifecycle (`initialize/destroy/launchSlot`) stubbed for later phases. Unsolved AppComponent-black bug (render coupling).

---

## Performance (from the 2026-07 whole-project audit)
Ref: docs/audit-2026-07-19.md

- **[partial]** Autosave-on-main-thread — mitigated (PNG encode moved to a worker pool + gzip + marker-only procedural persistence); confirm no remaining main-thread stalls.
- **[planned]** Character-regen storm — O(n²) generate hitch (VertGrid helps; confirm end-to-end). (A character worker lane exists since P3: `services/workers/character-*`.)
- **[built 2026-10-04]** Uber-shader cost — specialised variants per flags value (P21, `sm.setShaderVariants3D`, default on; main pass −30 to −40 %). Left: skinned, planar-mirror and textured families.
- **[built]** Instancing leaf cards + LOD — instanced city trees with card crowns, branch LOD, P9 twins.
- **[built 2026-09-30 → 10-04]** General perf pass — performance-plan.md P1–P22 (index in STATUS-2026-10-04.md). Open: the default tile radius (3×3 vs 1×1) decision, the zero-instance indirect draws under GPU contention, landing ≤ 4 s.

---

## Deferred / parked
- **[fixed]** Armature pan-direction bug (breaks after orbiting) — fixed 2026-06-08 (+ 2026-09-28 follow-ups; memory `project_armature_pan_bug`).
- **[largely built]** Street-level walkaround mode — covered by Play mode (`src/game/`, docs/ui/play-mode.md) + the P19 Play corridor of full tiles + the near / live crowd. Not built: interiors, per-tile traffic in tiled worlds, a separate street camera mode.
</content>
