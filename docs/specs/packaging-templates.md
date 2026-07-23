# Packaging Templates — Mechanisms, Box Catalog, Manufacturing Export & Polish

**Status:** 📋 Spec (2026-07-21). `simpleBox` shipped. **Round A BUILT (2026-07-21): the §2
contract additions (fold sequencing + cut-path types), M1 + M2 as reusable mechanism helpers
(`src/packaging/mechanisms.ts`), and the `tuckEnd` + `sleeve` templates. Round B BUILT
(2026-07-21): M4 (`addRollWall` + `ROLL_SEQUENCE`) + M5 (`FoldPanel.foldTranslate` — the
fold-driven TRANSLATION mechanism — + the derived-panels contract) and the `rollEndMailer` +
`rigidTwoPiece` templates** — everything else below is still roadmap.
**Engine spec:** [packaging-system.md](packaging-system.md) · **UI doc:** [../ui/package-designer.md](../ui/package-designer.md)
**Prime directive:** *mechanisms, not SKUs.* Pacdora lists thousands of boxes because SKU count is
marketing surface area (three pizza boxes that differ only by size). We ship a small set of
**structural mechanisms** that combine into every mainstream box, each exposing dimensions as
parameters. ~7 mechanisms ≈ the whole Tier-1/Tier-2 retail catalog.

---

## 1. Structural mechanisms (the real build units)

Each mechanism is a reusable extension of the existing hinge-hierarchy architecture
(`box-hierarchy.ts`: panels + hinge pivots + fold sequencing + net-UV authoring + guides).
A "box type" is a template that composes mechanisms + a dieline layout.

| # | Mechanism | What it is structurally | Unlocks | Effort |
|---|-----------|------------------------|---------|--------|
| M1 | **Tuck flap** ✅ | Child pivot on a panel edge: tongue panel + 2 dust flaps, fold sequence (dust flaps fold before tongue), slit/friction-lock notch in the dieline. **Built: `addTuckFlap` (mechanisms.ts)** — chamfered tongue, trapezoid dust flaps, shoulder 'slit' guides, `TUCK_SEQUENCE` windows | RTE, STE, flip-top carton | S |
| M2 | **Glue tab** ✅ | Non-painted seam panel joining first↔last wall; excluded from art UV, marked on the dieline. **Built: `addGlueTab` (mechanisms.ts)** — tapered tab, UVs remapped to a margin strip, labeled 'Glue Tab' marker guide, folds with its wall | Every folding carton (RTE/STE/gable/auto-lock) | S |
| M3 | **Lock bottom** | 4 interlocking bottom panels with a crash-lock fold sequence (auto-lock) or 1-2-3 snap sequence | Auto-lock bottom carton, heavier product boxes | M |
| M4 | **Roll-end / web corner** ✅ | Double-wall side panels rolling 180°+, front tuck lip with locking tabs. **Built: `addRollWall` (mechanisms.ts)** — the ROLL = chained rigid pivots: outer wall folds 90° off the base, the inner ply hinges on its top edge and folds a further **180° relative**, ending COPLANAR against the outer wall's inner face (zero-thickness plies lying on each other — exactly what the interpenetration oracle admits). `ROLL_SEQUENCE` windows (outers → rolls → front+locks → lid → lip). ⚠ **Dust WEBS deliberately OMITTED**: a triangular web folds along a *diagonal* crease (non-rigid — the paper twists), so a rigid-hinge approximation is unclean; we neither fake bendy geometry nor emit dead cut lines. Revisit with M6 (tessellated non-rigid folds). | Roll-end mailer (FEFCO 0427/0429), tray | M |
| M5 | **Telescoping pair** ✅ | TWO hinge hierarchies (two ROOT panels) under one package root, lid dims derived from base + board thickness clearance. **Built: `FoldPanel.foldTranslate` (types.ts / box-hierarchy.ts)** — fold-driven **TRANSLATION** segments on a panel (the lid subgroup ROOT): pivot position offset = Σ `axis·(from + (to−from)·windowedProgress(t, window))`, driven by the SAME global fold scalar as every hinge and implemented **identically in `setBoxFold`, `computeFoldWorldCorners` and `compileFoldMesh`** (axes authored in flat-net mm, baked into the parent frame + unit scale by `buildPanelBuilds`). Flat-net invariant: `from: 0` ⇒ fold 0 is the exact dieline. The lid's 3-segment path (lift → carry over → seat) clears the base walls — no sweep-through. | Two-piece rigid box, sleeve+tray | M |
| M6 | **Curved crease** | Hinge whose crease line is an arc: panel geometry bends across a curved fold (tessellated strip, not a rigid pivot) | Pillow box, curved-lid boxes | L |
| M7 | **Cutout / window** | Boolean hole in a panel: dieline cut path + geometry hole + optional PET film layer (translucent material) | Window box, hang-tab (euro slot), handle holes, die-cut logos | M |

Supporting sub-mechanisms that ride on the above: **perforation / tear strip** (dashed cut line
variant of M7's path type, zipper geometry optional), **hanger tab** (M7 hole + a reinforced panel).

## 2. Template catalog (composition matrix)

Build order top→bottom. Each row = a `BoxStyle` template file in `src/packaging/templates/`.

| Template | Mechanisms | Notes / params beyond W×H×D | Tier |
|----------|-----------|------------------------------|------|
| `simpleBox` ✅ | — | shipped; keep as the teaching/default box | — |
| **`tuckEnd`** ✅ | M1 ×2, M2 | ONE template, param `tuckStyle: 'reverse' \| 'straight'` (on `DielineParams`, default `'reverse'`) — RTE and STE are the same box with mirrored vs same-side tucks. The retail default (electronics, cosmetics, supplements). **Built:** `templates/tuck-end.ts`, 13 panels, staged fold walls→dust→closures→tongues, closed-form + real-node + interpenetration tested (`tuck-end.test.ts`). ⚠ tuckStyle flip = topology change → `setDimensions` takes the clean-rebuild path, never the in-place fast path. | 1 |
| **`sleeve`** ✅ | M2 only | open-ended band; params reuse W (girth face) / H (sleeve width) / D (face depth). **Built:** `templates/sleeve.ts` (5 panels). Thumb notch (M7) deferred. | 1 |
| **`rollEndMailer`** ✅ | M4 (+M1 lip) | THE e-commerce/subscription box. **Built:** `templates/roll-end-mailer.ts` — base + back wall + hinged lid (lid top + chamfered front LIP with shoulder 'slit' locks), double-wall rolled sides (`addRollWall` ×2), front wall + corner lock tabs. Params: `lockTabs?: boolean` (default true; ⚠ flip = topology change → rebuild, 11 vs 9 panels) and `restOpenAmount?: number` (0..0.95, default 0 = fully closed at fold 1; scales the lid's target angle so the mailer rests AJAR — dims-only, in-place fast path). At fold 1: exact W×D×H shell, roll plies coplanar against their outer walls, lip coplanar against the front. Dust webs omitted (see M4). Tested `roll-end-mailer.test.ts` (21). | 1 |
| **`rigidTwoPiece`** ✅ | M5 | luxury lid+base. **Built:** `templates/rigid-two-piece.ts` — base tray + lid tray (10 panels, TWO roots), corner-cut rigid-style nets (4 loose walls each, **no glue tabs** — rigid board boxes are die-cut and WRAPPED, not seam-glued), TWO nets side by side on one canvas with a 10 mm gutter (`TWO_PIECE_GUTTER`), shared UV space (both trays paint from the one layer stack). Params: `lidDepth?: number` (default full telescope = base wall height; shallow cap ≈ 15) + `boardThickness?: number` (default 2) — both dims-only (in-place fast path). Fold: both trays' walls in [0, 0.6] (`TELESCOPE_SEQUENCE`; lid walls fold DOWN — an opening-down cap), then the lid subgroup TRANSLATES [0.6, 1] (lift → carry → seat) and ends SEATED: top at y = D + boardThickness, every lid wall exactly boardThickness outside its base wall. Tested `rigid-two-piece.test.ts` (22). | 1 |
| **`autoLockCarton`** | M1, M2, M3 | tuck top + crash-lock bottom; heavy products | 2 |
| **`gableBox`** | M1, M2, M7 | handle = gable peak + hand hole; bakery/gift | 2 |
| **`pillowBox`** | M6 | curved creases only; jewelry/socks | 2 |
| **`displayBox`** | M1, M2, perforation | tear-off front counter display | 3 |
| **`windowBox`** (modifier) | M7 | NOT a separate template — a **modifier** applicable to tuckEnd/gable/mailer: `window: { panel, shape, inset }` | 2 |
| `hangTab` (modifier) | M7 | euro-slot modifier on tuckEnd | 3 |

**Template contract additions** (✅ all built):
- ✅ per-panel **fold sequencing** — `FoldPanel.foldWindow: [start,end] ⊂ [0,1]`: `setBoxFold`,
  `computeFoldWorldCorners` (the test oracle) and `compileFoldMesh` (the reference compiler) all map
  the global fold amount → local progress via the ONE `windowedProgress` helper (box-hierarchy.ts).
  No window = identity (simpleBox math unchanged, bit-for-bit); the tweened fold/unfold inherits
  staging automatically (it drives the same scalar). Default tuck staging = `TUCK_SEQUENCE`
  (walls [0,.45] → dust [.45,.65] → closure [.6,.85] → tongue [.8,1]).
- ✅ **cut-path types** on `DielineGuideType`: `'slit'` + `'perforation'` added (existing `'cut'` =
  solid cut, `'fold'` = crease); `DielineGuide.label` (optional annotation, e.g. the glue-tab
  marker). Hosts filter by type → non-breaking. tuckEnd emits 'slit' at the tongue-shoulder locks.
- ✅ **derived panels** (M5, `rigidTwoPiece`) — a template may COMPUTE panels from the primary
  params instead of exposing them: the lid tray's outer footprint = base outer + 2×`boardThickness`
  clearance per axis, lid wall depth = `lidDepth` (default full telescope), and the seated pose at
  fold 1 realises the derived clearance EXACTLY (gap = boardThickness on every side; lid top at
  y = D + boardThickness). Derived panels regenerate with every `setDimensions` from the ONE
  template call, so the dieline, UVs, guides and mesh can never disagree; derived-dim changes are
  dims-only (same topology → the in-place fast path).
- ✅ **fold-driven translation** — `FoldPanel.foldTranslate: FoldTranslateSeg[]` (see M5 above):
  the same `windowedProgress` scalar can now TRANSLATE a subgroup root (not just rotate hinges),
  applied identically across `setBoxFold` / `computeFoldWorldCorners` / `compileFoldMesh`. No
  segments = bit-for-bit the pre-M5 math.

## 3. Manufacturing export — *the most commercially important item in this spec*

A PNG does not get a box manufactured. The sellable artifact is:

**`exportPrintPdf(id) → Blob`** — vector PDF, **mm-exact 1:1** (never doc-px):
- **Layers/spot colors per line type** (industry convention converters expect):
  cut = solid (spot "CutContour"), crease = dashed (spot "Crease"), perforation = dash-dot,
  bleed box, safe zone. Artwork raster (the flattened layer-stack composite) beneath, at ≥300 DPI
  for the physical dims, with bleed extended.
- **Spec block** (corner of sheet or page 2): outer dims W×H×D mm, blank size, board grade +
  caliper (user-selectable preset list: SBS/kraft/corrugated E-flute…), grain direction arrow,
  template name + FEFCO code where one exists (mailer = 0427), date, Frogmarks version.
- Library: needs a small PDF lib (candidate for lazy-loading the module — pdf-lib is the fit:
  pure TS, no DOM). Vector paths come straight from the guide segments (already canvas-px; convert
  via the mm→px authoring scale).
- Prereq fix: creator mode's export today is doc-sized; the PDF path must use the dieline's own
  mm-derived canvas (the `enterEditor` 1:1 sizing logic) regardless of doc size.

Also (cheap, later): `exportSpecSheet(id)` — JSON/text of dims + board + template for quoting.

## 4. Polish pass (the "premium feel" week — Salsa side)

Ordered; all reuse existing engine features. **§4.1–4.3 BUILT 2026-07-22** (Salsa side):
1. ✅ **Studio stage default**: creator mode swaps the focus background (the existing armature-bg
   'gradient' mode) for a neutral soft-grey studio gradient; the wavy background is an opt-in theme
   via `sm.packaging.setStageBackground({mode,color1,color2})`; the user's background is captured on
   enter and restored on exit. **Contact shadow**: an engine-managed ground quad under the box with
   an **in-shader radial alpha falloff** (material flag bit 17 `radialFade`, transparent untextured
   pipeline — chosen over a texture or a shadow-map ground catch: zero new passes/assets, one quad).
   Sized from the CURRENT fold pose's footprint (closed-form corners — flat net at 0, closed box at
   1), tracks `setDimensions`/fold, non-pickable / frame-excluded / never serialized, removed on exit.
2. ✅ **Board material**: shader flag bit 16 `boardShade` — faint two-scale **paper-fiber grain**
   modulating the BASE colour (applied UNDER the `texOverBase` artwork composite, so painted strokes
   stay clean) + **edge rim shading** (darkening within ~1.6 mm of each panel's UV-rect border → the
   thick-board read; chosen over edge geometry). Params ride the otherwise-unused pattern instance
   slots (patternColor = rimU/rimV/rimStrength/grain, patternParams = the panel's dieline-UV rect —
   patterns and board shading are therefore mutually exclusive per mesh). Presets
   `setBoardPreset(id, 'white' | 'kraft')` (white coated = the 0.96 base + low grain; kraft =
   0.66/0.50/0.34 + heavier grain), **persisted** with the package params. Warm key light/IBL tuning
   deferred (scene-level, not per-box).
3. ✅ **Motion**: fold/unfold tween easing upgraded easeInOutQuad → **easeInOutCubic** (exported,
   unit-tested); **camera drift-in** on mode enter (~450 ms eased dolly/orbit settle onto the framing
   via the orbit controller — `driftOrbitIn3D` — cancelled by the first pointer/wheel input, never
   fights the user); per-panel phase stagger verified free via M1 `foldWindow` sequencing (the tween
   drives the one global scalar — no change needed).
   **+ `setStyle(id, style)`** (same round): style is now convertible on an existing box (clean
   topology rebuild, id changes, artwork kept but remaps onto the new net's UVs); the
   `enterCreatorMode({style})` re-enter applies it instead of silently ignoring it.
4. **Progressive disclosure** (Frogmarks): panel shows W/H/D + style + fold + export;
   bleed/board/advanced under "Advanced".

## 5. Inserts & modifiers (later, after Tier 1 sells)

- **Inserts as a modular system**, not box types: divider grid (params: rows×cols×height),
  paper wrap, foam block with cavity cutouts (M7 booleans on a slab), thermoform tray
  (heightfield mold — pairs with the user's injection-mold-sleeve idea; export = mold surface).
  Any insert mounts inside any box via interior dims.
- **Finish modifiers** (visual layer, no geometry): spot UV / foil / emboss as material-mask
  layers on the layer stack (the stack already composites; these become special layer kinds
  rendered with material overrides).

## 6. Explicitly deferred (recorded so it stops tempting us)

- **Booth planner / "Creator Commerce Studio"**: real platform direction (level-editing +
  instancing + shared asset graph = engine strengths), but sequenced AFTER packaging earns
  revenue or teaches us why it can't. Packaging is the flagship; extract the platform from what
  it proves. One-page vision lives in this section, not in code.
- Bottles/cans/pouches (non-box packaging), `.frogcart` order flow, keyframeable creases,
  crowd of static mockup scenes.

## 7. Build order (the actual queue)

1. ~~Commit current state~~ (user)
2. ~~§4.1–4.3 polish (studio stage + board material + motion)~~ ✅ 2026-07-22 (+ `setStyle`)
3. §3 `exportPrintPdf` (cut/crease spot layers + spec block + 1:1)
4. ~~`tuckEnd` (M1+M2, `tuckStyle` param) + fold sequencing contract~~ ✅ Round A
5. ~~`sleeve`~~ ✅ Round A · 6. ~~`rollEndMailer` (M4)~~ ✅ Round B · 7. ~~`rigidTwoPiece` (M5)~~ ✅ Round B
8. `windowBox` modifier (M7) → then gable, auto-lock, pillow, display per demand
