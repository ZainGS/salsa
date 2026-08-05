# Salsa — TODO / Roadmap

A living, consolidated list of remaining work. Grouped by area; each item tagged **[status]**.
Status legend: **[next]** teed up · **[planned]** spec'd, not built · **[partial]** built but incomplete ·
**[wiring]** engine done, host (Frogmarks) UI pending · **[idea]** not yet spec'd.

> Companion doc: [SYSTEMS.md](./SYSTEMS.md) — what already exists (reuse before rebuilding).
> Deeper specs live in [docs/specs/](./specs/); host UI contracts in [docs/ui/](./ui/).

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

- **[partial]** Alpha "leaf-card" render path (`render:'card'`) falls back to chunky where the cutout material isn't fully wired (`foliage.ts`). Finish the alpha-cutout leaf material end-to-end.
- **[idea]** Foliage Creator mode polish + more species presets.

---

## Buildings & city detail
Specs: [specs/building-generator.md](./specs/building-generator.md), city-detail.md, city-visual-upgrade.md, instancing-blocks.md

- **[built]** `buildStreets` → `buildBuilding` is wired **and on by default** (`types.ts` `detailedBuildings: true`; each lot fills with a full procedural building, metres→city scale-bridge in `streets.ts`). Remaining: **[next]** a subjective building *visual tuning* pass (not wiring).
- **[planned]** Building Generator Phase 8 — LOD + a Building Designer UI.
- **[partial]** Shop "blade" signs in `signtext.ts` are still colored rectangles — only landmark plates + shotengai boards are real text. Needs a text/sign atlas pass.
- **[planned]** City Visual Upgrade — aerial "City Edit Mode": fog/sky → SSAO → color grade → glass density → nature density (atmosphere/lighting/density polish, not structure).
- **[planned]** Instancing tiers (instancing-blocks.md): scene-wide shared buffers, Block container tier — reduce draw calls + VRAM further.

---

## World borders / streaming / LOD
Specs: [specs/world-borders.md](./specs/world-borders.md), spatial-streaming.md, city-lod.md

- **[built]** Void grid + border glow (Phase A), terrain apron (Phase B), spatial tile streaming, detail LOD Phase 1.
- **[planned]** World borders: shader tiny-planet dome (Flat/Planet modes), flat-tile expansion, true sphere (hex→Goldberg).
- **[planned]** LOD Phase 3b far-box proxy + Phase 2 bands; instanced building foliage VRAM win.

---

## Rendering / shaders / depth
Specs: [specs/depth-precision.md](./specs/depth-precision.md), 3d-shaders reference · **Lighting deep-dive: memory `project_lighting_shadows`**

- **[built]** Lighting overwrite fix (A) + city-lighting toggle/persistence (B) — the city snapshots global lighting on enter, restores on exit; `sm.world.setOverrideGlobalLighting(on)` (default on) chooses city-drives vs inherit-global; `worldParams.lighting` persists timeOfDay+toggle. See memory `project_lighting_shadows`.
- **[built]** Shadow fix (C) — the structural defect (origin-locked box → no shadows outside it in tiled/panned worlds) is fixed: the ortho box now **follows the camera focus** (`renderer-3d.ts` `_updateShadowCenter`, called in `uploadSceneUniforms` before the light matrix), **texel-snapped** so panning doesn't shimmer, and refreshes the throttled map only when the snapped centre moves a texel. Toggle `sm.scene3d.setShadowFollowCamera3D(on)` (default on) reverts to the origin-locked box. NEXT (browser-verify): shadow consistency across a panned/tiled city + no shimmer while panning. Follow-up **[built]**: the box is now **zoom-adaptive** — `_updateShadowCenter` shrinks the effective half-extent toward the visible footprint (`≈1.1 × camera distance`, floor `8`) when zoomed in → 2048 texels cover a small area → **sharp** shadows, and grows back to the full base box when zoomed out → the whole view still gets shadows. Bias scales with the effective texel size (`_effBias`), cutting peter-panning. `HE_PER_DIST`/`MIN_HE` in `renderer-3d.ts` are the tuning knobs (browser-tune: too small → edges cut off; too large → less sharpening). Remaining (only if browser shows it's not enough): cascaded maps.
- **[partial]** SSAO (spec [specs/ssao.md](./specs/ssao.md)) — **Stages 1+2 built** (debug buffer browser-verified clean: no silhouette halos, no near→far bleed). Stage 1: world-position depth prepass → AO estimate (improved closer-neighbour normal reconstruction) → depth-aware bilateral blur → debug view. Stage 2: the mesh FS multiplies the **ambient term only** by AO (group-0 binding 3/4; 1×1 white bound when off → exact no-op; before bloom since it's in the color pass). Toggle `sm.scene3d.setSSAO3D(on, {radius,intensity,bias,power})` / `setSSAODebug3D` / harness `salsaSSAO`. Off by default. **NEXT:** browser-verify Stage 2 (creases grounded, sun shadows not double-darkened, tune intensity), gate off for cel/PS1 styles, persist `ssao` in `worldParams.lighting` (Fix A+B scope). Stage 3: half-res + depth-aware upsample, quality tier + tiled-full auto-off. Characters (skinned) not yet in the prepass → bind white (no AO) for now.
- **[idea]** "AO Clay" render style — promote the SSAO debug view (matte white/greyscale occlusion render) into a real stylized render style alongside cel/ink/sketch (small; reuses the AO buffer; add a touch of directional shading so forms read). User flagged it.
- **[idea]** Filmic tone-map / color grade pass (deferred during the materials work).

---

## Character / rig / animation
Specs: [specs/character-variety.md](./specs/character-variety.md), hair-styles.md, emotes.md, dollz-creator.md

- **[partial]** `body-generator.ts` self-describes as a v1 prototype — silhouette/posture refinements pending (base-body sculpt is being tuned).
- **[partial]** Spring bones — engine core built + type-checks; hair-tail integration + authoring UI pending.
- **[planned]** Character Variety — silhouettes by construction class, material-driven variety, seeded randomizer + fashion collections, crowd hook.
- **[planned]** Hair style system (bob/wolf/bun/braid/afro…), phased A–E.
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

- **[next]** Print-PDF export → then package mechanisms M3/M6/M7.

---

## Host (Frogmarks) UI wiring — engine done, panel pending
- **[wiring]** GARP "Skins" panel — BUILT by Frogmarks; keep in sync with `garpSlotRegions3D` region overlays + the `body`/`products` slots.
- **[wiring]** City Detail panel toggles (day/night, weather, holograms, shader modes), scene grid toggle, anime face/eyes, hair — engine features exist; host toggles pending.
- **[wiring]** Frogmarks integration status notes are stale in places — verify against code, not notes.

---

## Text / ephemera
Specs: retro-text/ephemera, html-in-canvas-text.md

- **[partial]** HTML-in-Canvas live text path disabled by a DPR sizing bug (texture at window DPR vs copy at backing DPR). User wants true HTML-in-Canvas.
- **[planned]** Retro text Phase 2 (ephemera kit + blendMode), Phase 3 (arc text).

---

## Shell UI
Spec: [specs/shell-ui] · Memory: project_shell_ui

- **[partial]** ShellUIManager data/state built; renderer-coupled lifecycle (`initialize/destroy/launchSlot`) stubbed for later phases. Unsolved AppComponent-black bug (render coupling).

---

## Performance (from the 2026-07 whole-project audit)
Ref: docs/audit-2026-07-19.md

- **[partial]** Autosave-on-main-thread — mitigated (PNG encode moved to a worker pool + gzip + marker-only procedural persistence); confirm no remaining main-thread stalls.
- **[planned]** Character-regen storm — O(n²) generate hitch (VertGrid helps; confirm end-to-end).
- **[planned]** Uber-shader cost — the mesh shader does a lot unconditionally; evaluate variant/branch reduction.
- **[planned]** Instancing leaf cards + LOD (see Buildings/LOD above).
- **[deferred]** General perf pass (user: "optimize later") — 5×5 vs 3×3 tiling, glow throttle, etc.

---

## Deferred / parked
- **[parked]** Armature pan-direction bug (breaks after orbiting) — isolated for later.
- **[planned]** Street-level walkaround mode — 2nd view walking the world at high detail; deferred until the builder view is high-quality.
</content>
