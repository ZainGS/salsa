# Wardrobe Expansion — Charms, Accessories, Draw→Geometry, Garment Upgrades & Drapes

**Last Updated:** 2026-06-28
**Status:** 📋 SPEC (roadmap). Nothing here is built yet except where a row says ✅. Build order is **Phase 1 (quick
upgrades) → Phase 2 (charms/accessories engine) → Phase 3 (draw→geometry) → Phase 4 (drapes)**, per the
2026-06-28 direction call.
**Engine:** `src/services/managers/clothing-generator.ts` (garments), `scene3d-manager.ts` (rigging / slots /
persistence), `shape-manager.ts` (public `*3D` API + UV paint). Host: **Frogmarks** owns the UI.
**Siblings:** [clothing-generation.md](./clothing-generation.md) · [shoe-generation.md](./shoe-generation.md) ·
[hair-styles.md](./hair-styles.md) · [character-variety.md](./character-variety.md) · UI: [clothing.md](../ui/clothing.md).

---

## 0. Philosophy — 12 features collapse into 2 engines + cheap wins + big garments

The wishlist (bracelets, watches, chokers, hair pins/clips, pendants, flowers, pockets, hanging chains, belt
loops, zippers, embroidery, cutouts, layering, tapered pants, scarves, shawls, cloaks, hijab, burqa) is **not**
12 one-off features. It's:

- **Engine A — "Attach anything" (charms & accessories).** One pipeline: place a small parametric mesh at a point
  on the body/garment, skin it so it follows the pose, optionally give it a **spring-bone dangle**. A *third* of the
  list falls out of this one system.
- **Engine B — "Draw → geometry" (UV-path features).** A stroke in UV-paint → an ordered polyline → a 3D surface
  curve → **sweep** a profile (zipper teeth, piping) or **emboss** it (embroidery). The distinctive "draw a zipper
  and it appears on your line" wow.
- **Cheap wins — extend the existing garment generators.** Taper pants ends, cutouts (the shader *already* has an
  alpha-cutout discard), clothing layering (the rig already supports multiple garments).
- **Big garments — draped cloth.** Scarves / shawls / cloaks / hijab / burqa — large sheets that want spring-bone
  or cloth drape; best *after* the attach + drape foundations exist.

**Reusable foundations we already have (don't rebuild):** the procedural clothing pipeline + `_buildBodyFit` +
`fitGarmentToBody` de-collision; the per-(body,slot) `ClothingRig` map with params-only persistence + bake-to-part;
the body skeleton + multi-joint skinning; **spring bones** (`docs/ui/armature.md` — jiggle chains, used by hair
tails) for anything that hangs/swings; **UV paint + surface input** (`enterUVPaintMode3D` / `enterSurfacePaintInput`
— a click/drag on the 3D mesh raycasts to a UV coord) for placement + drawn paths; the shader's `alphaCutout`
discard (`mesh3d-shaders.ts`) for holes; the kitbash `CharacterSlot` (already has `accessory_head/back/left/right`).

---

## Phase 1 — Quick garment upgrades  *(build first)*

Three small, low-risk wins that extend the existing generators. No new engine.

### 1A · Taper pants leg ends  ✅ (target: BUILT first)
- **Param:** `BottomParams.cuffTaper` (0 = straight · 1 = skinny ankle). `?? 0`-guarded (old saves unaffected).
- **Geometry:** in `buildLegs`, scale the **lower-zone** ring radii inward toward the cuff: for `lt > 0.55`,
  `tf = 1 − cuffTaper·0.45·((lt−0.55)/0.45)` → up to ~45% narrower at the cuff. The de-collision (`fitGarmentToBody`,
  maxPush 0.09) pins it to the leg so a hard taper hugs the calf/ankle instead of clipping. Applied AFTER the §6
  stack block (taper + baggy-stack are opposing looks; product is fine if both set).
- **Preset:** add **Skinny** = `{ bottomStyle:'pants', length:1.0, cuffTaper:0.8 }`.
- **UI:** a **Taper** slider on the Bottoms tab (pants only). docs/ui/clothing.md §4.

### 1B · Cutouts (alpha holes painted on a garment) — ✅ BUILT (2026-06-28)
- **BUILT as the `'cutout'` garment ERASE MODE** (`setGarmentEraseStyle3D('burn'|'clean'|'cutout')` in shape-manager).
  Cutout = a real alpha-erase in `_mirrorBrushToUVEngine` (`setEraseMode` on the UV engine) + `material.alphaCutout
  = true` on the garment (set live on the stroke, and on every paint-texture (re)apply in `_carryPartOverrides` /
  `_restoreClothingTextures`, so it persists + survives regens — **harmless on opaque paint** since opaque texels
  never discard, so no rig flag needed). The hole reveals the body behind (no `doubleSided` needed); the brush's
  soft edge frays the rim; painting any colour back fills the hole. The same toggle gave **'clean' vs 'burn'** erase
  (the burn = the brush grain/soft edge painting white = the user's "scorch border"). Below = the original plan.
- **Idea:** the user paints (erases) regions of a garment → those texels become **transparent holes** (crop
  cutouts, mesh panels, distressed rips).
- **Why it's cheap:** the mesh fragment shader *already* discards transparent texels when `alphaCutout` is set
  (`if (alphaCutout && texSample.a < 0.5) { discard; }` in `mesh3d-shaders.ts`). So a cutout = paint alpha 0 + flip
  the garment material's `alphaCutout` flag.
- **The work:** a dedicated **Cutout paint mode** (a flag on the UV paint session) where the eraser writes true
  **alpha 0** instead of the current opaque "paint white" garment-erase trick (the existing garment eraser keeps the
  diffuse opaque on purpose — see [project_uv_paint] / clothing notes). When any cutout texel exists, set
  `mesh.material.alphaCutout = true` (and `material.doubleSided = true` so the hole shows the back/inside cleanly).
  Persist the alpha channel with the painted texture (already a PNG → alpha rides along). Carry across regens like
  the paint texture (`_carryPartOverrides`).
- **Edge:** a hole exposes the body underneath (fine) — no body cutout. Distressed-edge / frayed look = a later
  texture pass.
- **UI:** a **"Cutout"** toggle inside the garment Paint panel (switches the eraser to true-erase) + the standard
  brush. No new slider.

### 1C · Clothing layering (a 2nd, open-front outer top)
- **Idea:** wear two tops — an inner tee + an **outer** that can be **long-sleeve and open at the front**
  (cardigan / open jacket / overshirt).
- **Slot:** add an **`'outer'`** clothing slot (5th slot; same `ClothingRig` pattern). It reuses `generateTop` with:
  - a slightly larger body offset (`thickness` floored higher) so it sits *over* the inner top without z-fighting,
  - a new **`TopParams.openFront`** (0 = closed · 1 = fully open): split the torso shell down the front centre —
    omit/retract the front-centre rings so the two front panels hang open, revealing the inner top. `?? 0`-guard.
  - `openFront` is a `TopParams` field so the *inner* top can stay closed and only the outer opens.
- **Render order:** outer has a larger offset → already draws outside; open-front edges need the de-collision to keep
  the panels off the inner top + body. (If transparency/sorting bites, the outer is opaque so depth handles it.)
- **UI:** a **second Top sub-tab ("Outer")** + an **Open Front** slider on it. The Top/Outer tabs share the
  `TopParams` panel; `slot` distinguishes them.
- **Stretch:** generalize later to N layers if needed; `'outer'` covers the 90% case (one layer over).

**Phase-1 deliverable:** `cuffTaper`, the cutout paint mode + `alphaCutout` wiring, the `'outer'` slot + `openFront`.
All ride existing persistence (params + the painted PNG). Frogmarks: a Taper slider, a Cutout toggle, an Outer
sub-tab + Open-Front slider.

---

## Phase 2 — Charms & Accessories engine  *(the big unlock — ✅ v1 BUILT 2026-06-28)*

A single **attachment** system: a small parametric mesh, placed at a point, skinned to follow, optional dangle.

> **✅ v1 BUILT (2026-06-28):** the foundation + **8 types** (**chain · pocket · pendant · bracelet · watch · choker ·
> clip · flower**; UI hand-off: [charms.md](../ui/charms.md)), **joint-anchored** placement,
> skinned 100% to the anchor joint (follows the pose), live params/placement, persists (OPFS **and** `.frogmarks`),
> re-anchors on a body-shape change, resolves to the body on pick. Engine: `attachment-generator.ts` +
> `scene3d-manager` (`_attachments` map, `addAttachment`/`setAttachmentParams`/`setAttachmentPlacement`/
> `removeAttachment`/`listAttachments`/`serialize`+`restoreAttachments`). **ShapeManager API:** `attachmentTypeNames3D`,
> `getDefaultAttachmentParams3D` / `getDefaultAttachmentPlacement3D`, `addAttachment3D(bodyMeshId, type, placement?,
> params?) → id`, `setAttachmentParams3D(id, params)`, `setAttachmentPlacement3D(id, placement)`, `getAttachment3D`,
> `listAttachments3D(bodyMeshId)`, `removeAttachment3D(id)`, `getAttachmentMeshId3D`. **Placement** = `{ joint, offset:
> [x,y,z], scale }` (rest-pose offset from a named joint, e.g. `hips`/`upperleg_R`/`neck`). **✅ + spring-bone DANGLE
> (2026-06-28):** the **chain** AND **pendant** hang from their anchor and **SWING** — each link/cord segment is a
> spring bone (the generator emits bone-local indices + `dangleBones`; scene3d appends them as a `springCharm_*` chain
> after the hair's `springTail_*` block and remaps). **✅ real LINK geometry + smaller defaults (2026-06-29):** the
> chain is now **interlocking oval links** (a `link()` oval-torus, alternating 90°), wire-thin, defaults/ranges
> lowered to a wallet chain (per a ref image). **✅ SWAG mode + far-joint + sway (2026-06-29):** `chainMode: 'dangle' |
> 'swag'` — `swag` is a catenary draped A→B, `span`-driven droop, auto link density (the wallet-chain look). **`endJoint`**
> anchors the far end to a DIFFERENT joint (B = endJoint.pos + `endOffset`; links blend-skin anchor→endJoint → a hip→thigh
> chain tracks the leg); **`swagSoftness`** (0..1) makes the droop SWAY (a spring chain pulls the middle, ends stay pinned).
> All four combos work via one builder (the minimal mesh builder went 4-bone). **✅ LOOP type + chain↔loop connection +
> belt loops (2026-06-29):** a `loop` (D-ring) charm you place anywhere (joint+offset); a chain's `fromLoop`/`toLoop`
> (loop ids) string it loop→loop (scene3d resolves them to the loops' joint+offset → the chain inherits their joints and
> TRACKS them). `addBeltLoops3D(body, count)` drops an auto-placed waistband row of loops. The WRAP types (bracelet/
> watch/choker) also shrink-fit + use a single `position` (no offset/scale). **✅ SURFACE-PIN placement (2026-06-29):**
> `beginAttachmentPlacePick3D(body, type, {onPlaced,onHover})` / `endAttachmentPlacePick3D` — click a garment/body to drop
> a charm exactly there; the hit raycasts the body+garments (MeshPicker), resolves to the surface's DOMINANT skin joint +
> a rest-pose offset (hit→body-local), spawns a normal joint-anchored charm (persists/poses like any). Pin in the neutral
> pose (picks rest geometry). **✅ PBR MATERIALS (2026-06-29):** metal charm types (chain/loop/bracelet/watch/choker/
> pendant/clip) render as **shiny metal** (`metalness`/`roughness` on the material; `attachmentMaterial(params)` resolver,
> per-type defaults, `color` tints gold/silver); needed a renderer fix — the PBR shader gained an **env-specular** term
> (SH-irradiance sampled along the reflection vector × roughness-aware Fresnel) so metals reflect the surroundings
> instead of going black off the key light (benefits ALL materials). **Charm PAINTING dropped** (user: charms are
> material-driven, not painted — paint would fight the metal). See 2A below. **STILL TODO (v2):** bake-to-part. Frogmarks: a
> **Charms** panel — type picker → spawn → joint dropdown + offset/scale + per-type sliders → `setAttachment*3D`; a
> list with remove. (See [charms.md](../ui/charms.md).)

### 2A · The attachment model
- **`Attachment` record** (new map `_attachments`, keyed by id, owned by a body): `{ id, bodyMeshId, type,
  placement, params, springChainId? }`.
- **Placement** = where it sits. Two modes:
  - **Joint-anchored** (bracelet/watch/choker/anklet/hair-pin): an offset frame relative to a named joint
    (`lowerarm_L`, `neck`, `foot_R`, head…). Skinned 100% to that joint → follows the pose exactly.
  - **Surface-pinned** (charm/flower/pocket/pendant on a garment): a **UV coordinate on a target mesh** (the body or
    a garment). Reuse the **surface-pick** (`enterSurfacePaintInput`'s raycast → UV) to let the user **click where it
    goes**. The attachment inherits that surface point's **skin weights** (read from the target mesh's nearest vert)
    so it follows the garment/body deformation. Position/orient from the surface point + its normal.
- **Skinning:** joint-anchored → one joint; surface-pinned → the target vertex's blended weights. Either way it
  poses correctly (it's just more skinned geometry on the shared skeleton — same trick as hair/clothing).
- **Dangle (spring bones) — ✅ BUILT for `chain` + `pendant` (2026-06-28):** anything that hangs spawns a **spring-bone
  chain** from the anchor (`docs/ui/armature.md`) so it **swings + settles** under gravity, reusing the hair-tail path.
  The **pendant** hangs its diamond on a short cord chain (top bone pinned at the anchor, the diamond rides the LAST
  bone's head so it pendulums without flinging). `_buildAttachment` points the **tip bone's `tailOffset` down the hang**
  (the default `[0,0.3,0]` points up → the tip would settle flipped against gravity).
  **How:** the generator emits vertex joint indices as **bone-local** (0 = anchor, 1..N = the link bones) + a
  `dangleBones[]` array of rest-pose link positions; `scene3d._buildAttachment` appends those as `springCharm_${id}_*`
  joints (parented off the anchor, identical rest-frame math to `_buildHairSpringRig`), pushes a `SpringChain`, then
  remaps the bone-local indices to the real skeleton joints. **Block ordering invariant:** charms are ALWAYS the
  **trailing** spring block (after hair's `springTail_*`). Any charm change → `_rebuildAllCharms(body)` (truncate from
  the first `springCharm_`, rebuild every charm fresh — hair untouched). A hair rebuild (`setHairParams`/`removeHair`)
  tears down from the earliest spring joint of *either* kind, then re-appends charms last. `_keepSpringsAlive` lets a
  freshly-built chain settle into its hang; it then swings whenever the body is posed/animated (same gate as hair).
  One/both-ends-fixed (below) chooses the chain's boundary conditions (only one-end-fixed = the swinging chain is built).

### 2B · Charm / accessory generators (each a small mesh, like a clothing preset)
A `type` → generator map (mirrors `SHOE_PRESETS` style). Each is a tiny parametric mesh:
- **WRAP types (bracelet · watch · choker) — ✅ auto-fit (2026-06-29):** they can only sit on a limb, so they DON'T
  expose `offset`/`scale`/rotation (those just let you break them). Instead a single **`position`** (0..1) slides the
  band along the bone toward its child (`hand_{side}` / `head`), the band **auto-orients** along the bone axis, and the
  radius **SHRINK-FITS** the limb (`lerp(jointR, childR, position)`; choker = neck radius, reach clamped so it stays on
  the neck). Computed in `generateAttachment` (`wrapC`/`wrapAxis`/`wrapR` → the build fns). Frogmarks shows only
  Anchor + Position + thickness (+ watch face).
- **Bracelet / anklet** — a band around `lowerarm`/`foot`. Joint-anchored, shrink-fit.
- **Watch** — a bracelet + a box/disc face. Joint-anchored to `lowerarm_L`, shrink-fit.
- **Choker / necklace** — a band around `neck`, optional pendant (a dangle). Joint-anchored, shrink-fit.
- **Hair pin / clip / bow** — small mesh anchored to a head/hair point. Joint-anchored to `head` (or surface-pinned
  on the hair).
- **Pendant / charm** — a small shape (heart, star, flower, generic) on a short dangle. Surface-pinned **or** hung
  from a choker.
- **Flower / patch / pocket** — a flat-ish appliqué mesh surface-pinned to a garment (follows it). Pocket = a flat
  pouch panel + optional flap.
- **Hanging chain** — a **catenary** of links between **two anchor points**:
  - **one end fixed** = a chain that hangs from a single anchor and **dangles** (spring chain, free end swings).
  - **both ends fixed** = a chain strung between two picked points, hanging in a **catenary droop** between them
    (e.g. a wallet chain hip→pocket). Static droop or a soft spring.
  - Authoring: pick anchor A, (optionally) pick anchor B; `linkCount`, `sag`.

### 2C · Belt loops — ✅ BUILT (2026-06-29) as a loop-charm row
- Shipped as **`addBeltLoops3D(bodyMeshId, count)`** (scene3d `addBeltLoops`): spawns `count` **`loop` charms** evenly
  around the waistband, auto-sized/placed from the body fit (radius = `hips.radius`, a touch above the joint), skinned
  to `hips`. Returns the loop ids → feed two to a chain's `fromLoop`/`toLoop` for a wallet chain. (Chose a loop-charm
  row over a `BottomParams.beltLoopCount` so the loops are first-class anchors a chain can reference, independent of
  whether a Bottoms garment exists.) A Bottoms-tab slider can just call `addBeltLoops3D` + remember the ids.
- (A real **belt** threading them is a later accessory.)

### 2D · Authoring UX (Frogmarks)
- An **Accessories / Charms** panel: pick a **type** → it spawns at a default anchor (or enters a **"click to place"**
  mode that uses the surface-pick) → sliders tune `params` (size/count/colour/dangle) → live via
  `setAttachmentParams3D`. **Move**, **remove**, **duplicate**, **bake-to-part**.
- **List** of placed attachments (the character can have many). Each persists.

### 2E · Engine API (new, mirrors clothing)
```ts
addAttachment3D(bodyMeshId, type, placement?) -> id        // spawn (default or given placement)
setAttachmentParams3D(id, params)                          // live tune
setAttachmentPlacement3D(id, placement)                    // move (joint offset or surface UV)
removeAttachment3D(id) / listAttachments3D(bodyMeshId)
beginAttachmentPlacePick3D(bodyMeshId, cb)                 // "click on the character" → surface point+UV (reuses surface-pick)
bakeAttachmentToPart3D(id, name)                           // → kitbash accessory_* slot
```
- **Persistence:** a new `attachmentRigs` array (params + placement) serialized alongside `clothingRigs` /
  `hairRigs` (same OPFS + `.frogmarks` paths — see the 2026-06-27 persistence saga; add to `serialize*`/`restore*`
  + the project-package `scene3d.json`). Params-only (regenerate on load), like everything else.
- **Collision:** surface-pinned charms sit *on* the surface (the pick point + normal offset) so they don't need the
  full de-collision; bracelets/chokers are joint tori sized from the limb radius.

---

## Phase 3 — Draw → geometry (zippers, embroidery, piping)  *(the wow — build third)*

A **UV-path** engine: a drawn stroke becomes geometry that follows the line.

### 3A · The path pipeline (shared)
1. **Capture** a stroke in a new **"draw a line" mode** (reuse `enterSurfacePaintInput` — collect the raycast UV
   points instead of painting). Output: an ordered **UV polyline** on the target garment.
2. **Resample + smooth** the polyline (even spacing, light smoothing).
3. **Map to 3D**: each UV point → the garment's surface position + normal + tangent (barycentric on the hit
   triangle, from the garment's editMesh / UV layout).
4. **Frame**: a parallel-transport frame along the curve (the same trick the hair tails use) → a stable ⊥ basis.
5. **Emit** either a **swept profile** (3B) or an **emboss** (3C).

### 3B · Zippers / piping (swept profile)
- **Zipper:** sweep a **zipper-tape + teeth** profile along the curve — two tape strips + alternating tooth boxes +
  a slider pull. `teethDensity`, `width`, open/closed (a closed seam vs a parted V at the bottom). Skinned to the
  garment's weights along the path so it deforms with the cloth.
- **Piping / trim cord:** sweep a thin tube along the curve (seam piping, drawstrings, contrast trim).
- **Authoring:** Paint mode → **"Zipper"** tool → draw the line → the zipper is generated on it; sliders tune it; it's
  an **attachment** (Phase 2 storage) keyed to the garment + the stored UV polyline (regenerates on garment regen).

### 3C · Embroidery (emboss)
- **Idea:** draw/stamp a pattern on the garment → it reads as **raised embroidery**, colourable/texturable.
- **Approach:** rasterize the drawn path/stamp into the garment's **normal map** (a raised bevel along the stroke) +
  tint the diffuse along it. The shader already samples a normal map (`hasNormalMap` in `mesh3d-shaders.ts`) — so
  embroidery = paint into a per-garment normal+colour layer, no new geometry. (A geometry-bump variant — extrude the
  stroke band slightly — is an alternative for chunky embroidery.)
- **Authoring:** an **"Embroidery"** brush in Paint mode (draws into the emboss/normal layer); `depth`, `colour`,
  `satin/chain` style as later texture variants.

---

## Phase 4 — Draped garments (scarves / shawls / cloaks / hijab / burqa)  *(biggest — build last)*

Large draped sheets. Each is a generated cloth panel anchored to the body and **draped** (spring-bone or a light
position-based drape), so it falls and moves.
- **Scarf** — a long strip around the `neck`, ends hanging (spring-bone tails so they swing). `length`, `width`, wrap
  style (loop / drape / over-shoulder).
- **Shawl / cape / cloak** — a panel from the shoulders/back (anchored to `chest`/`shoulders`), draping down the
  back; `length`, `hood?`. Cloak = full-length cape + a hood dome over the head.
- **Hijab** — a head + neck wrap: a cap over the hair (conform to the head, like the hair cap) + a draped panel over
  the shoulders/chest. Respectful, parametric (coverage, drape length, wrap).
- **Burqa / abaya / chador** — a full-length loose robe from the shoulders/crown to the floor, optional face panel.
  A large draped tube + a head veil.
- **Tech:** all reuse the body-fit + a **drape pass** (spring-bone chains on the hanging edges; the hair-tail spring
  path generalizes). Shares the Phase-2 anchor model (these are big "attachments" that drape).

---

## Cross-cutting (every phase)
- **Params + guards:** every new field is `?? default`-guarded so old saves load; lives in the relevant `*Params`
  (or the new `Attachment.params`), live via `set*3D`.
- **Persistence:** params-only, regenerate on load. New rig arrays (`attachmentRigs`) join `clothingRigs` /
  `hairRigs` / `faceRigs` / `bodyParams` in BOTH the OPFS save AND the `.frogmarks` / project-package `scene3d.json`
  (the 2026-06-27 saga: BOTH unpack sites must restore — don't drop them). Painted layers (cutout alpha, embroidery
  normal) ride `meshTextures` (keyed `__cloth__:`-style).
- **Rigging:** everything skins to the shared body skeleton (the multi-skinned-mesh buffer trick already supports
  body + decal + hair + garments + N attachments). Hanging things use **spring bones**.
- **Collision:** garments → `fitGarmentToBody`; surface charms sit on the pick point; drapes → spring + de-collision.
- **Bake / kitbash:** each new piece can `bake*ToPart` into a `CharacterSlot` (add `charm`/`outer` slots as needed).
- **UI:** Frogmarks owns panels; the engine exposes `get*Names` / `getDefault*` / `set*3D` / `remove*` / `bake*`
  mirrors of the clothing API.
- **Build rule:** `npx tsc --noEmit` ONLY (never `npm run build` — it breaks the Frogmarks dist); the user rebuilds +
  restarts `ng serve`. Verify each sub-feature against a screenshot before the next.

## Recommended implementation order
**1A → 1B → 1C → 2 → 3 → 4.** Phase 1 ships fast momentum on the existing generators. Phase 2 is the big
personalization unlock and the foundation hanging/drape things reuse. Phase 3 is the distinctive wow on top of UV
paint. Phase 4 (drapes) reuses the Phase-2 anchor + spring foundation, so it's last. Reassess from a screenshot
after each sub-feature.
