# Package Creator — Frogmarks UI Integration

**Last Updated:** 2026-07-22 (**§4 polish round**: studio stage default — soft-grey gradient bg + engine-managed contact shadow + ~450 ms camera drift-in, wavy bg now an opt-in theme via `setStageBackground`; board material — paper grain + edge rim via `setBoardPreset('white'|'kraft')`, persisted; fold tween eased **easeInOutCubic**; **+ `setStyle(id, style)`** — the style dropdown now converts an EXISTING box, and `enterCreatorMode({style})` applies it on re-enter instead of ignoring it. See §0 studio-stage bullet, §3b snippets, §4 table. Earlier 2026-07-21: **parity round — Outliner flow ≡ toolbar flow**: one converged internal enter procedure for every `enterCreatorMode` path, `{packageId}` accepts root/pivot/panel ids, LOUD warn on unresolvable ids, `addPackage` announces itself to the Outliner immediately, per-package `'Dieline'` ownership scoping, and the re-enter-hides-the-base-layer fix — see §0b. Earlier same-day: critical-bug round 2: **reload re-adoption** — the packaging registry now persists params-only in the doc and re-binds to the restored nodes on load (§0b: no duplicate box on re-enter, restored packages stay editable) + **live-refresh hardening**: the paint engine re-resolves its write target from the layer manager at every stroke *begin* (a doc/canvas resize reallocates every layer texture; the engine previously kept writing the orphaned old object), links re-sync at stroke *begin* as well as end, re-points evict the renderer's cached texture bind group, and the permanent `salsaPkgPaintProbe()` console diagnostic dumps every texture identity in the chain. Round 1: **paint reaches the box** — the live-texture link samples the dieline layer's *manager* texture (the object every stroke writes) instead of the reassignable `layer.texture` snapshot; **click-select suppressed for packages inside the mode** (left-click paints, §0); **pane never mounts/resizes stale** — immediate synced render on attach + a ResizeObserver + the new `DielinePaneHandle.onPaneResize` overlay hook (§0c). Prior polish round: **transparent-by-default dieline** composited over the kraft base (`texOverBase`), the Dieline is a **hidden system layer** (`systemOwner:'packaging'` — filter it from the Layers panel, §0/§1), the pane is **aspect-correct** (letterboxed, §0c), and the **§0d view modes** (3D/Split/2D). Earlier pivot note: **Package Creator is a MODE inside the Illustration editor** — entered from a normal Illustration document with one call, `sm.packaging.enterCreatorMode()`, exactly like the Character Creator / City Edit Mode patterns. The bespoke `/packaging` route is **deprecated**; see §2.)
**Engine spec:** [packaging-system.md](../specs/packaging-system.md)
**Sibling UI docs:** [character-creator.md](./character-creator.md) (the mode + UV-paint pattern this mirrors), [3d-scene.md](./3d-scene.md), [clothing.md](./clothing.md).

Package Creator is an **edit mode in the existing Illustration editor** (the canvas where "Add Cube", Character Creator, and City Edit Mode all demonstrably work). Entering the mode drops a foldable **3D box** into the **current illustration document's** scene, creates (or reuses) a **transparent "Dieline" raster layer** — a hidden SYSTEM layer live-textured onto the box (strokes composite over the kraft cardboard) — frames + alt-orbits the box on a clean focus stage, and arms **3D-surface painting**. You orbit the box and paint directly on it, *or* paint the flat net in the **dieline pane** (§0c) — **one texture, two ways to paint**. A fold slider folds the flat net into the closed box; export is the flat dieline PNG.

> **Status legend:** ✅ Salsa (done) · 🟦 Frogmarks must implement · 🔶 not built yet (either side).
> **Modularity:** everything is gated by `PACKAGING_ENABLED` (`shell-storage.ts`). Off → `sm.packaging` returns `null`. Null-check once.

---

## 0. The mode — one call in, one call out ✅

```ts
// ENTER — from ANY open illustration document (toolbar button in the EXISTING illustration editor):
sm.packaging!.enterCreatorMode();                                  // default 80×60×40 mm simpleBox
sm.packaging!.enterCreatorMode({ params: { width: 120, height: 80, depth: 50, bleed: 3 } });

// Panel state (poll after enter / after any param change):
const st = sm.packaging!.getCreatorState();
// → { active, packageId, params, foldAmount, dielineLayerId, guides }

// EXIT — camera returns to the illustration sync; the box + artwork STAY in the scene as a
// normal, visible, paintable object (mirrors how exitCityMode3D leaves the city):
sm.packaging!.exitCreatorMode();
```

What `enterCreatorMode` guarantees:

- **Idempotent re-enter.** Re-entering (even after exit) **reuses the same box and the same layer** — no duplicate boxes, no duplicate 'Dieline' layers. A layer already **named `Dieline`** in the doc is adopted rather than recreated (and tagged as a system layer, below). Passing `params` on re-enter re-dimensions the existing box.
- **Fresh Dieline layers start TRANSPARENT.** The panel material composites the dieline texture **over the kraft base by its alpha** (`texOverBase`: final = mix(kraft, tex.rgb, tex.a)), so an empty layer renders as **blank cardboard** and strokes appear painted directly on it. Erasing is a real alpha-erase (back to cardboard). **A white background is a design choice** — the user fills the layer white themselves if they want white board. A **reused** layer is never touched — artwork is preserved.
- **The Dieline is a hidden SYSTEM layer.** It is created with `systemOwner: 'packaging'` and composite-visibility **off** — it never draws on the artboard (the box samples the layer's GPUTexture directly, not the composite) and **must be filtered out of the Layers panel**: skip entries where `sm.getRasterLayers()[i].systemOwner === 'packaging'`. The flag persists in the document manifest, so reloads keep it hidden. Flat drawing goes through the **dieline pane** (§0c), not artboard raster tools.
- **Your document is untouched.** Unlike the lower-level `enterEditor`, the mode does **not** call `setDocumentSize`. The Dieline layer is document-sized and artwork maps onto the box via the net UVs. ⚠ **Print caveat:** the exported PNG is therefore **doc-sized, not 1:1 print mm→px**. For print-exact sizing use the lower-level `enterEditor` (which resizes the doc to the dieline canvas), or resize the doc yourself before entering.
- **City-mode enter/exit hygiene.** Enter: measured-bounds framing + 3/4 alt-orbit (camera claimed from the 2D sync), clean focus background, view gizmo, box-select suppressed, selection/hover cleared. Exit: all of it restored.
- **STUDIO STAGE (§4 polish) ✅.** The mode's focus background defaults to a **neutral soft-grey studio gradient** (not the wavy bg — that's now an opt-in theme via `setStageBackground`, see §3b), a **contact shadow** blob grounds the box (engine-managed: sized from the live fold-pose footprint, tracks `setDimensions`/fold, non-pickable/never framed/never serialized, removed on exit), and the camera **drifts in** (~450 ms eased dolly/orbit settle instead of a hard cut; cancelled by the first pointer/wheel input). Exit restores the user's own background exactly. Panels render as **board stock** (§4.2): paper-fiber grain + a subtle darkened rim at panel borders, under the painted artwork — preset via `setBoardPreset` ('white' default / 'kraft'), persisted with the package.
- **Click-select is SUPPRESSED for packages while the mode is active.** Every package is a select-as-a-unit thin wrapper (§0b), so outside the mode clicking any panel selects the whole box — correct there, but inside the mode it fought painting (a stroke start would select the package and pop selection chrome over the stage). The mode suppresses click-picking for package panel/pivot/root nodes (an `InteractionService.pickSuppressed3D` predicate over the live package registry, so it survives `setDimensions` rebuilds): **left-click/drag on the box goes to PAINT, never selection**. Clicks on non-package meshes / empty space still select/deselect normally; alt+left-drag orbit and middle/right pan are untouched. Fully restored on `exitCreatorMode` — no host wiring needed.
- **The target package is ISOLATED.** With multiple packages in the scene, entering the mode hides every OTHER package (remembering its previous visibility) so the stage shows ONE box, not an overlapping pile. Exit restores each hidden package to its prior visibility (a package the user had hidden stays hidden). Re-entering targeting a different package while the mode is active switches cleanly (the old target is hidden, the new one shown); packages deleted while hidden never break the restore.
- **Panel materials are re-asserted on every enter.** Each (re)link of the dieline layer re-applies the panel material contract (kraft base + `texOverBase` compositing) to all 6 panels — so boxes restored from a saved document (whose persisted materials predate `texOverBase`) or otherwise carrying legacy multiply materials render as kraft cardboard again instead of near-black.

**Console harness (zero Frogmarks wiring):** in any illustration doc run `salsaPkgCreator()` (optionally `salsaPkgCreator({width,height,depth,bleed})`) to enter + log the creator state, and `salsaPkgCreatorExit()` to leave. `salsaPkgFold(t)` / `salsaPkgDims({...})` / `salsaDebug()` still work on the creator box.

---

## 0b. Outliner integration ✅ (Salsa API) / 🟦 (Frogmarks menu + button)

Packages are now **first-class scene objects**, so the Outliner can treat them like Characters/Buildings/Foliage:

```ts
// "Add Mesh > Package…" — create a package in the scene WITHOUT entering the mode.
const st = sm.packaging!.addPackage();                                        // default 80×60×40 mm simpleBox
const st2 = sm.packaging!.addPackage({ width: 120, height: 80, depth: 50 });  // custom dims (+ optional style arg)
// st.id = the package id (== its root container node id). Starts flat, kraft-brown, no dieline layer yet.

// Selection → "Package Mode" button: resolve ANY selected node id to its package.
const pkgId = sm.packaging!.isPackageNode(selectedNodeId);   // panel mesh / hinge pivot / root → package id, else null
if (pkgId) showPackageModeButton();

// Button click → enter the mode targeting THAT package (frame/orbit/paint it — not create-or-reuse):
sm.packaging!.enterCreatorMode({ packageId: pkgId });
```

- **Select-as-a-unit (City thin-wrapper pattern) ✅** — the package root is a thin-wrapper container: it shows as **ONE outliner node**, clicking **any panel** selects the whole package, and the gizmo moves/rotates the box **as a unit** (the root's transform composes into all panels; folding is untouched). The selection box/gizmo is sized from cached bounds **at the CURRENT fold pose** — refreshed on every fold scrub and re-dimension (`poseBounds(panels, foldAmount)`), so a folded box shows a box-tight selection box. *(Fixed: the bounds used to be a whole-fold-range UNION that folded in the flat-net extent — `W+2H` wide — so a closed box showed a giant net-sized selection box. At fold 1 the bounds now equal the closed `W×H×D` box.)*
- **Click-pick suppression is UNCONDITIONAL for the target in creator mode ✅** — while the mode is active, a click on the target package (any panel/pivot/root) never selects it, with **any modifier**: a plain click falls through to surface paint and an **alt** click is orbit-only. The suppression predicate (`PackagingManager.isPickSuppressed`) is independent of the active layer's paintability — it no longer lifts in vector 'place' mode, which used to let an alt-orbit click select (and snap the gizmo onto) the box. Suppression doesn't stop event propagation, so place-mode clicks still reach the illustration tools.
- **PARITY GUARANTEE ✅ (2026-07-21 parity round):** every `enterCreatorMode` entry path — toolbar create-or-reuse, `{ packageId }` targeting, orphan adoption — converges into **one internal enter procedure** after target resolution, so the full sequence is identical for all of them: re-dimension → dieline ensure + link (panel kraft+`texOverBase` material **re-asserted per panel**) → layer-stack bootstrap/migration + composite (re)wire → isolation of the OTHER packages → framing → stage hygiene (click-pick suppression, ambience ticker) → paint armed on the target's **active stack layer** (or explicitly **disarmed** when a vector layer is active — a target switch can never leave paint armed on the previous box's layer). There are no parallel half-implementations to drift.
- **`{ packageId }` accepts ANY package node id** — root container, hinge pivot, or panel mesh (it resolves through `isPackageNode`, so a host that passes the raw selection id still targets the right box), and a package-**shaped** root missing from the registry (restored doc whose re-adoption didn't run) is structurally adopted. `getCreatorState().packageId` always reflects the box actually targeted, and keeps tracking it after exit.
- **LOUD fallback ⚠:** an id that still doesn't resolve falls back to the normal create-or-reuse enter (non-throwing — that targets the *previous creator box*, not the selection), and now emits a **`console.warn`** with the unresolved id + the known registry keys. If you see that warning, the host handed a stale/foreign id — fix the caller; the silent version of this fallback was exactly the "every selection edits the same box" bug.
- **Outliner freshness ✅:** `addPackage` (and the `setDimensions` rebuild + re-adoption paths) now fire the host's scene-graph-changed notification at the **end of assembly**, so the new package appears in the Outliner immediately — not on the next unrelated scene change. The assembly is additionally wrapped in the host's **scene-graph batch** (`beginSceneGraphBatch`/`endSceneGraphBatch` → `beginSceneGraphBatch3D`/`endSceneGraphBatch3D`) so the ~13 per-node `createGroup`/`createPanelMesh` emits + the `markUnitWrapper` flag-flip emit **coalesce into ONE final emit** carrying the fully thin-wrapper-marked tree. This is the robust fix for the "invisible until the next mesh is added" symptom: a host outliner that latched the *first* emit of the burst (a pre-mark partial tree) now receives a single, final, correct emit. *(Frogmarks note: if the outliner still doesn't refresh, verify its `onSceneGraphChanged` subscription runs inside Angular's change detection — a zoneless emit fires synchronous listeners but won't re-render the panel on its own.)*
- **Per-package dielines ✅:** the by-NAME `'Dieline'` reuse is scoped by `packageOwnerId` — entering the mode on package B can never adopt (steal) A's stack base; fresh dielines are ownership-tagged at birth. Also fixed: re-entering on an already-migrated package no longer force-hides the base layer (its `visible` flag means *stack* visibility once package-tagged), which used to make paint land on a layer the composite skipped.
- `sm.packaging.getAll()` lists all packages (id, params, foldAmount, dielineLayerId) for an Outliner-side registry.
- **Reloaded packages are RE-ADOPTED ✅ and collapse to ONE Outliner item.** The package root is a **`documentSkipChildren` procedural marker** (the City/building/foliage pattern): its panel/pivot subtree is NOT serialized — the save carries only the **params-only** registry entry in the document's scene3d JSON (style, dims, fold amount, dieline layer id, layer-stack order, board preset). On load the scene graph restores the lightweight marker root (thin-wrapper + `documentSkipChildren` re-applied), so the Outliner shows ONE selectable **'Package'** immediately, and `packaging.restoreFromJSON` **REGENERATES** the panel hierarchy under that existing root from the persisted params — `isPackageNode`/`getAll` work, `setDimensions`/`fold` drive it, the dieline + layer-stack composite re-link (re-asserting the kraft+`texOverBase` panel material), and `enterCreatorMode` **reuses the restored box** (no duplicate stacked on it). *Backward-compatible:* documents saved BEFORE this (panels serialized, no `documentSkipChildren`) still re-BIND to the existing nodes (with panel-mesh reparenting repair + `<Panel> Hinge` structural name matching for id drift) instead of regenerating. **Legacy loose-panel cleanup ✅ (BUG 5):** after re-adoption, `restoreFromJSON` calls the host's `pruneLoosePackageNodes(keepIds)` to delete any stray top-level `'<Name> Hinge'` pivot subtree a pre-`documentSkipChildren` save floated up as a **loose sibling of** (or duplicate of) the real package — the "loose Package, Front, Right, Back, Left" symptom. A top-level `'* Hinge'` group is unambiguously a package leftover (real pivots always nest under a `Package` root), so the reload always collapses to exactly ONE `Package`.
- **Defensive dedupe:** if `enterCreatorMode`'s create path ever runs while an *orphaned* package root exists in the scene (package-shaped node structure not in the registry — e.g. a doc saved before re-adoption existed), the orphan is **adopted** (geometry normalized to the requested/default dims) instead of creating an overlapping second box.
- **Paint-chain probe:** `salsaPkgPaintProbe()` (console, permanent diagnostic) dumps every texture identity in the paint chain — per panel: linked layer id, layer *manager* texture, `layer.texture` snapshot, what the mesh samples, and what the renderer has **bound** (cached bind-group diffuse) — plus the armed paint session's write target and LiveTextureMode sync counters (`syncAllCalls`/`repoints`). While painting, every column should show the same `tex#N`; any mismatch localizes a "paint never reaches the box" break.

---

## 0c. Unwrap pane (the dieline as a paintable UV pane) ✅ (Salsa) / 🟦 (Frogmarks pane + overlay)

The flat-dieline pane uses the **same mechanism as character UV paint**: a `UVCanvasRenderer` over a pane canvas attaches to the one UV-paint controller, so **pane strokes and 3D box strokes paint the SAME dieline layer** (no second paint path, no divergence). Crucially it attaches **without opening a UV session** — `openUVEditor3D` would auto-unwrap and **clobber the box's authored net UVs** (the known trap), so the pane hooks onto the already-armed surface-paint session and the baked net UVs are the mapping.

```ts
// AFTER enterCreatorMode (returns null while the mode is off):
// ⚠ CSS-size the pane canvas (e.g. width/height: 100% of the pane container) — do NOT set its
// width/height attributes. The renderer sizes its own BACKING STORE from the CSS layout size ×
// devicePixelRatio on every draw, so the letterboxed texture is never CSS-stretched (a square
// 1080×1080 dieline renders as a square rect, crisp at any DPR).
const uvRenderer = new UVCanvasRenderer(paneCanvasEl);
const pane = sm.packaging!.attachDielinePane(uvRenderer);
if (pane) {
  // pane = { uvToCanvas, guides, canvasWidth, canvasHeight, panels }
  // Pane background now shows the dieline texture (throttled readback); left-drag on the pane paints
  // the dieline layer (same brush UI as everywhere); the 3D box updates live. Overlay the guides on a
  // canvas stacked over the pane: guide points are DIELINE-CANVAS px → normalize → uvToCanvas.
  // ⚠ uvToCanvas returns pane BACKING-STORE px (CSS px × devicePixelRatio) — size your overlay
  // canvas's backing store the same way (clientWidth×dpr) and the coordinates line up 1:1.
  for (const g of pane.guides) {
    for (const [a, b] of g.segments) {
      const [x0, y0] = pane.uvToCanvas(a[0] / pane.canvasWidth, a[1] / pane.canvasHeight);
      const [x1, y1] = pane.uvToCanvas(b[0] / pane.canvasWidth, b[1] / pane.canvasHeight);
      // stroke x0,y0 → x1,y1 in g.color (dash 'fold', see the guide table in §3b)
    }
  }

  // PANEL LABELS + DIM-OUTSIDE-THE-NET — pane.panels gives each panel's id, display label, and UV
  // rect, so the pane reads as the package shape rather than a bare texture:
  const octx = overlayCanvas.getContext('2d')!;
  // 1) dim everything OUTSIDE the net (punch each panel rect out of a translucent veil):
  octx.save();
  octx.fillStyle = 'rgba(0,0,0,0.35)';
  octx.beginPath();
  const [bx0, by0] = pane.uvToCanvas(0, 0);
  const [bx1, by1] = pane.uvToCanvas(1, 1);
  octx.rect(bx0, by0, bx1 - bx0, by1 - by0);                      // the whole texture rect…
  for (const p of pane.panels) {
    const [x0, y0] = pane.uvToCanvas(p.uvRect.u0, p.uvRect.v0);
    const [x1, y1] = pane.uvToCanvas(p.uvRect.u1, p.uvRect.v1);
    octx.rect(x0, y0, x1 - x0, y1 - y0);                          // …minus each panel (evenodd)
  }
  octx.fill('evenodd');
  octx.restore();
  // 2) name each panel at its rect centre:
  octx.fillStyle = 'rgba(255,255,255,0.55)';
  octx.font = '11px sans-serif'; octx.textAlign = 'center';
  for (const p of pane.panels) {
    const [cx, cy] = pane.uvToCanvas((p.uvRect.u0 + p.uvRect.u1) / 2, (p.uvRect.v0 + p.uvRect.v1) / 2);
    octx.fillText(p.label, cx, cy);                               // "Front", "Lid", …
  }
}
sm.packaging!.detachDielinePane();   // hide the pane; 3D box painting stays armed
```

- **Direct-mesh painting is already armed by the mode** — the pane is additive. Both writers hit the one dieline layer; `exitCreatorMode` tears the whole paint session down (pane auto-detaches). **Pane strokes refresh the 3D box on stroke-end exactly like 3D-surface strokes** (both funnel through the one stroke-end hook → `syncLiveTextures3D`), so the box never shows stale content.
- The pane draws in **background-only** mode (texture + UV boundary + brush ring — no wireframe/islands, since the panels are never made editable).
- **The handle is LIVE.** `uvToCanvas` is a closure over the pane's *current* pan/zoom/letterbox/canvas size (never captured values), and `guides` / `panels` / `canvasWidth/Height` are getters over the current package state — the same handle stays correct after a pane resize **and** after `setDimensions`. What Salsa can't do is repaint *your* overlay: **set `pane.onPaneResize` to redraw it** (below), and also redraw after `setDimensions` (that changes guides, not the pane canvas, so no resize event fires).
- **No stale mount, no stale resize** — `attachDielinePane` does an **immediate synced render** (backing store synced from CSS layout × DPR, letterbox recomputed, pane drawn) so the pane is correctly aligned the moment it attaches — never "misaligned until the first mouse-move". While attached, a `ResizeObserver` watches the pane canvas: any LAYOUT resize (view-mode switch 3D↔Split↔2D remounting/reflowing the pane, panel drag) re-syncs + re-renders immediately, then fires the optional **`pane.onPaneResize`** callback. **Set it and redraw your guide overlay there** — by the time it fires the mapping has already moved (`uvToCanvas` is live; your previously drawn overlay pixels are not):
  ```ts
  pane.onPaneResize = () => redrawGuideOverlay(pane);   // overlay redraw on pane layout resize
  ```
  The observer is disconnected on `detachDielinePane` / `exitCreatorMode`; the character UV pane path (host-managed backing store) is untouched.
- **Aspect-correct:** the pane **letterboxes** the UV [0,1] box to the texture's aspect (a non-square doc-sized dieline shows at its true proportions; square character-UV textures are unaffected). Background, brush ring, stroke mapping, and the `uvToCanvas` guide mapper all share the one session mapping, so a stroke on the letterboxed image lands on the right texel and guides stay aligned. The pane's **backing store auto-sizes** to CSS layout × devicePixelRatio (enabled on attach; the character UV pane, whose host manages its own store, is untouched) — CSS-size the pane canvas and everything stays unstretched.

---

## 0d. View modes (3D / Split / 2D) 🟦 (pure host layout)

The workspace toggle is **entirely host-side layout** — no Salsa mode API beyond what §0/§0c already provide. All three views paint the **one dieline layer**:

- **3D** *(current default)* — the viewport fills the workspace; paint on the mesh (armed by `enterCreatorMode`). No pane mounted.
- **Split** — viewport + dieline pane side-by-side. Mount the pane with `attachDielinePane` (§0c); both surfaces paint the same layer and update live.
- **2D** — the pane fills the workspace (viewport hidden or collapsed). Same `attachDielinePane` call — the pane works at **any canvas size** (the letterbox mapping adapts); overlay the guides per §0c.

Switching modes = mount/unmount the pane canvas (`attachDielinePane` / `detachDielinePane`) and resize your layout; 3D painting stays armed throughout. A pane-canvas **resize needs no re-attach** — the backing store auto-syncs and the handle's mapper is live — but you must **redraw your guide/label overlay** after a resize (and after `setDimensions`) since your overlay pixels don't move themselves.

---

## 0e. Package layer stack ✅ (Salsa engine) / 🟦 (Frogmarks layer-list UI)

Packages now carry a **multi-layer paint stack** (raster paint layers + vector layers), composited onto the box. The layers are **ordinary doc layers** tagged `{ systemOwner: 'packaging', packageOwnerId: <packageId> }` — hidden from the host Layers panel exactly like the dieline (filter on `systemOwner`), persisted with the document like any layer. **Both `sm.getRasterLayers()` AND `sm.getVectorLayers()` carry `systemOwner`/`packageOwnerId`** — so filter `systemOwner === 'packaging'` out of the normal panel for vector layers too (a package vector layer must appear ONLY in the package's own layer list, before *and* after reload; the tags round-trip through the layer manifest). Package-tagged layers are **structurally excluded from the artboard composite**, so their `visible` flag means *stack visibility on the box*.

**Engine model:** the box panels live-texture from an offscreen **COMPOSITE of the package's stack** (order + visibility + opacity + blend), built by the same `RasterCompositor` the artboard uses (a dedicated instance — no artboard paper-grain/dither). It recomposites throttled (~30 fps) during paint strokes, at stroke end, and on every stack change. The **legacy single `Dieline` layer migrates automatically**: on the first creator enter (or first stack API call) it becomes the stack's **base layer** — old documents keep working unchanged.

### API (`sm.packaging.…`)

| Method | Description |
|---|---|
| `addLayer(packageId, name?) → { layerId } \| null` | New RASTER paint layer on TOP of the stack; becomes the **active paint target** (surface paint re-arms on it). |
| `addVectorLayer(packageId, name?) → { layerId } \| null` | New VECTOR layer on top (§0e-vector below); becomes active → **place mode**. |
| `getLayerStack(packageId) → [{ layerId, name, visible, opacity, active, kind }]` | The stack **bottom→top** (`kind: 'raster' \| 'vector'`). Bootstraps the stack from the legacy dieline on first call. |
| `setActiveLayer(packageId, layerId)` | Raster → paint re-arms on it. Vector → paint disarms (**place mode**) + box click-pick suppression lifts. |
| `setLayerVisible(packageId, layerId, visible)` | Stack visibility (recomposites). Hiding the base shows layers above over bare board. |
| `setLayerOpacity(packageId, layerId, opacity)` | 0..1 (recomposites). |
| `reorderLayer(packageId, layerId, toIndex)` | Move within the stack (0 = bottom; recomposites). |
| `removeLayer(packageId, layerId)` | Deletes the layer. The **last raster layer is guarded** (a box always keeps one paint surface). |
| `renameLayer(packageId, layerId, name)` | Rename. |

### Layer-list UI sketch (Frogmarks)

```
Layers ▸                      ┌──────────────────────────┐
  [+ Layer] [+ Vector]        │ ● 👁  Stickers   (vector) │  ← active = place mode
  drag to reorder             │   👁  Label Art  ▓ 100%   │
                              │   👁  Dieline    ▓ 100%   │  ← base (the migrated legacy layer)
                              └──────────────────────────┘
```
Render `getLayerStack` **top→bottom** (reverse the array). Row click → `setActiveLayer`; eye → `setLayerVisible`; opacity scrub → `setLayerOpacity`; drag → `reorderLayer`; ✕ → `removeLayer` (disable on the last raster layer).

### Active-layer paint / place model

- **Raster layer active → PAINT mode.** Surface paint (3D box + pane) writes **that layer only**; the pane background and the box both show the **whole composite**. Erasing on a layer **reveals the layers below** — only where the entire stack is empty does the bare kraft/white board show. Box click-pick suppression is ON (clicks paint, never select).
- **Vector layer active → PLACE mode.** Surface paint disarms and the box click-pick suppression lifts (`isActivePaintable()` is the gate, applied automatically). The host also calls `sm.setActiveVectorLayer(layerId)` so the normal illustration tools (ephemera kit, text, vectors) place/edit on that layer — the existing vector-layer interactivity gate does the 2D-side gating. **The mode switch is implicit in which layer is active** — no separate tool toggle needed.

### Vector / ephemera flow (Part 2 granularity)

Vector layers contribute to the box composite through a **raster proxy**: the layer's **ephemera placements** (SVG) are rasterized via the existing OffscreenCanvas path into a proxy texture that joins the composite in stack order. The proxy re-renders on **vector-layer change events** (placement add / update / transform / delete / visibility), debounced ~80 ms — i.e. **change-event driven, not per-frame**: a drag updates a few times per second and settles on release. Placements stay fully **editable** (they're normal vector-layer content). *Current scope:* SVG/ephemera placements composite onto the box; raw scene-graph vector shapes (WebGPU-drawn rects/text) on the layer are editable on the artboard but not yet baked into the box composite.

> **Wiring note (the change-event chain).** Placement mutations only reach the box when they go through the ShapeManager ephemera API — `sm.addEphemeraPlacement` / `updateEphemeraPlacement` / `deleteEphemeraPlacement` / `movePlacementTo` / `applyPlacementResize` / `applyPlacementRotate`. Each fires the package's debounced proxy re-render + recomposite (resolved from the layer's `packageOwnerId`, which stays valid even after a dims/style **rebuild** re-keys the package). A vector layer added **after** the stack bootstrapped is picked up automatically (the composite reads the stack live). **Diagnose in-browser with `salsaPkgStackProbe()`** (console): it dumps the active package's stack — per layer `{ id, name, kind, visible, opacity, active, systemOwner, packageOwnerId, hasProxy, proxyPlacementCount }` — plus `compositeLinked`, the composite target texture id, and the `recomposites` counter + `lastRecompositeTick`. If a placed vector row shows `hasProxy:false` / `proxyPlacementCount:0`, or `recomposites` doesn't advance after a placement change, the change event never reached the compositor; if the vector row is missing entirely, the layer isn't package-tagged.

### Export

`exportDielinePng(packageId)` now exports the **FLATTENED composite** (all visible layers + vector proxies, bottom→top) when a stack exists — the legacy single-layer export applies only to never-migrated packages.

---

## 1. One paintable surface — now a stack

The **package layer stack (§0e) is the source of truth** for the box surface; with a single layer it degenerates to the classic dieline flow:

- **Flat drawing** — paint in the **dieline pane** (§0c / Split / 2D view). Strokes write the **ACTIVE stack layer**; the pane background shows the whole-stack **composite** (what the box shows). Package layers are hidden system layers (filtered from the Layers panel) and never draw on the artboard.
- **3D-surface painting** — left-drag on the box (armed by `enterCreatorMode`); raycast hit → net UV → **the same active layer**.
- **The box** live-textures from the **stack composite**, flat *or* folded, over the kraft base by alpha. **Export** = the flattened composite as a PNG (transparent background unless painted).

---

## 2. DEPRECATED — the bespoke `/packaging` route 🗑

The original design (a separate Package Designer shell tile / packages dashboard / `kind:'packaging'` docs / a bespoke editor route) is **deprecated — do not build it**. The bespoke route repeatedly failed to show the box because it re-implemented the illustration canvas mount instead of reusing it; the mode above kills that dependency entirely. The shell tile/dashboard plumbing still exists behind `PACKAGING_ENABLED` but is no longer the integration path. `enterEditor(id, opts)` remains documented in §4 as the **lower-level API** (it is what the mode composes, plus doc-resizing for print-exact work).

---

## 3. The Package Creator panel (Frogmarks builds this, in the EXISTING illustration editor) 🟦

```
Edit Package ▸                              ┌───────────────────────────────────┐
  Box style   [ Tuck End ▾ ]                │                                   │
    (Simple Box / Tuck End / Sleeve /       │                                   │
     Roll-End Mailer / Rigid Two-Piece)     │                                   │
  Tuck    [ Reverse ▾ ]  (tuckEnd only)     │                                   │
  Width   [ 80  mm ] ●                      │   3D box  — ORBIT + PAINT on it    │
  Height  [ 60  mm ] ●                      │   (left-drag paints,              │
  Depth   [ 40  mm ] ●                      │    alt+left-drag orbits)          │
  Bleed   [ 3   mm ] ●                      │                                   │
  ──────────────────────────────           └───────────────────────────────────┘
  [ ▶ Fold ]  [ ↺ Unfold ]                  ┌───────────────────────────────────┐
  Fold ●─────────── (0..1 scrub)            │  Flat dieline artboard (draw too)  │
  ──────────────────────────────           │  + cut/fold/bleed/panel guides     │
  Guides  ☑cut ☑fold ☑bleed ☑panel         └───────────────────────────────────┘
  Export  [ ↓ Dieline PNG ]
```

No new canvas, no new route — a **toolbar button + side panel in the illustration editor you already have** (exactly like the Character Creator panel). The button toggles `enterCreatorMode` / `exitCreatorMode`; the panel drives the same `sm.packaging` API on `getCreatorState().packageId`. **§3b is the copy-paste wiring guide.**

---

## 3b. Frogmarks wiring guide (per-control) 🟦

Everything goes through `sm.packaging!` (null-check once — `null` when `PACKAGING_ENABLED` is off). One `DielineParams` object is the source of truth for the sliders (character-creator pattern); fold + paint are **live scene behaviours**.

### Getting started — the toolbar toggle
```ts
// ENTER (toolbar "Package Creator" button) — box + Dieline layer + orbit + paint, one call.
const st = sm.packaging!.enterCreatorMode({ params: this.params /* optional */ });
this.pkgId = st.packageId!;

// The Dieline layer is a hidden SYSTEM layer — do NOT surface it in the Layers panel
// (filter systemOwner === 'packaging' out of sm.getRasterLayers()). Flat drawing happens in
// the dieline pane (§0c/§0d): mount it for Split/2D view and draw the guide overlay.
const pane = sm.packaging!.attachDielinePane(new UVCanvasRenderer(paneCanvasEl));  // Split/2D views
drawGuides(st.guides, enabledTypes);

// EXIT (button toggled off) — box + artwork stay in the scene; camera returns to the 2D sync.
sm.packaging!.exitCreatorMode();
```
> **Persistence:** the box params + Dieline artwork live in the illustration document like any other content. Re-opening the doc and re-entering the mode reuses the `Dieline` layer by name; keep `st.packageId` around while the editor is open.

### Box style dropdown → `setStyle` on a live box (or `style` at create time)
The style picker offers **`simpleBox` · `tuckEnd` · `sleeve`** (Round A) **· `rollEndMailer` ·
`rigidTwoPiece`** (Round B).
Style is chosen at create time (`enterCreatorMode({ style })` / `addPackage(params, style)`) **and
is now LIVE-SWITCHABLE on an existing box** (§4 polish round): `sm.packaging.setStyle(id, style)`
converts the box in place — the previous "dropdown does nothing on an existing box" behaviour is
fixed. A style change is a TOPOLOGY change by definition, so it always takes the clean-rebuild
path: **the package id changes** (use the returned state's `s.id`), the dieline layer/stack
re-links, paint re-arms if the mode is active, and the fold amount is preserved (the global fold
scalar is style-agnostic). ⚠ **Artwork remaps**: the layers are kept as-is, but the new net authors
different UVs, so existing strokes land in new places on the box — inherent to changing the
dieline. `enterCreatorMode({ style })` on an existing creator box now applies the same conversion
(it used to be silently ignored on re-enter).
The **`tuckEnd` variant** stays a param: `params.tuckStyle: 'reverse' | 'straight'` (RTE =
tucks on opposite faces — the default; STE = same face) goes through `setDimensions` like any
param. ⚠ A `tuckStyle` flip is also a TOPOLOGY change — rebuild, id changes, same contract.
```ts
// Style dropdown (existing box — the live path):
onStyle(style: BoxStyle): void {
  const s = sm.packaging!.setStyle(this.pkgId, style);
  if (s) { this.pkgId = s.id; this.drawGuides(s.guides, this.enabledTypes); }   // id CHANGES on conversion
}
// Style at create time still works:
const st = sm.packaging!.enterCreatorMode({ style: 'tuckEnd', params: this.params });
// tuckStyle toggle (RTE ⇄ STE) — just a param:
const s = sm.packaging!.setDimensions(this.pkgId, { ...this.params, tuckStyle: 'straight' });
if (s) { this.pkgId = s.id; this.drawGuides(s.guides, this.enabledTypes); }
```

### Studio stage theme + board preset (§4 polish) → `setStageBackground` / `setBoardPreset`
The mode now enters on a **neutral studio stage**: a soft light-grey vertical gradient replaces
the wavy focus background, and a **contact shadow** (soft dark blob, engine-managed) grounds the
box — it tracks fold/dimension changes and is removed on exit; the user's own background is
restored on exit. Zero wiring needed for the default. Optional controls:
```ts
// Stage THEME picker — StageBackgroundOpts.mode options:
//   'gradient' (studio default) · 'wavy' (the signature animated bg) · 'solid' · 'checkers' ·
//   'dim' · 'none'; color1/color2 = [r,g,b,a] primary/secondary.
sm.packaging!.setStageBackground({ mode: 'wavy' });                       // bring the wavy bg back
sm.packaging!.setStageBackground({ mode: 'solid', color1: [1, 1, 1, 1] }); // pure white sweep

// BOARD preset — 'white' (coated, the default: bright base, faint paper grain) or 'kraft'
// (brown board, heavier fiber grain). Persists with the package; live re-tint (survives painting —
// the grain/tint sit UNDER the artwork composite).
sm.packaging!.setBoardPreset(this.pkgId, 'kraft');
const preset = sm.packaging!.getBoardPreset(this.pkgId);                  // 'white' | 'kraft'
```

### Round B template params (show per style, all through `setDimensions`)
| Param | Style | Control | Contract |
|---|---|---|---|
| `lockTabs?: boolean` (default **true**) | `rollEndMailer` | "Corner locks" checkbox | ⚠ TOPOLOGY change (11 ⇄ 9 panels) → rebuild path, **package id changes** (use the returned `s.id`, tuckStyle-flip contract). |
| `restOpenAmount?: number` (0..0.95, default **0**) | `rollEndMailer` | "Lid rest open" slider | Dims-only (in-place fast path). 0 = fully closed at fold 1; ~0.25 = the classic mailer presentation with the lid ajar. |
| `lidDepth?: number` (mm; default = full telescope) | `rigidTwoPiece` | "Lid depth" slider (≈15 = shallow cap) | Dims-only (in-place fast path — same topology). |
| `boardThickness?: number` (mm, default **2**) | `rigidTwoPiece` | "Board" preset/slider | Dims-only. Drives the DERIVED lid dims: lid footprint = base + 2×board per axis, and the seated clearance gap at fold 1. |

Notes for the panel:
- **`rigidTwoPiece` shows TWO nets** on the one dieline canvas (base + lid, side by side with a
  gutter); the pane `panels` array carries the **`'Lid …'` labels** for the second net. Framing on
  `enterCreatorMode` measures BOTH trays (and the lid's mid-fold hover) automatically.
- The mailer's dust webs are deliberately absent (non-rigid diagonal folds — see
  packaging-templates.md §1 M4); no UI control to add.

### W / H / D / Bleed sliders → `setDimensions` + redraw guides
Each slider writes into the shared `params` and rebuilds the net live. `setDimensions` **returns the updated state** (new `guides` + `canvasWidth/Height`), so redraw the overlay from its return value. Debounce ~40 ms like the Body sliders. (In creator mode do **not** call `sm.setDocumentSize` — the user's doc is theirs; guides are in dieline-canvas px, so scale your overlay accordingly.)
```ts
private params: DielineParams = { width: 80, height: 60, depth: 40, bleed: 3 };
private _deb?: any;

onDim(field: 'width' | 'height' | 'depth' | 'bleed', value: number): void {
  this.params = { ...this.params, [field]: value };
  clearTimeout(this._deb);
  this._deb = setTimeout(() => {
    const s = sm.packaging!.setDimensions(this.pkgId, this.params);   // net + box regenerate, fold amount preserved
    if (!s) return;
    this.pkgId = s.id;                                                // setDimensions rebuilds → id can change
    this.drawGuides(s.guides, this.enabledTypes);                     // redraw overlay from the returned state
  }, 40);
}
```
> `sm.packaging!.getGuides(id)` / `sm.packaging!.get(id)` return the guides / whole state (guides + canvas size + params + foldAmount) any time. The box's net UVs are re-authored on each `setDimensions`; the dieline layer link + 3D-paint arming stay valid (same mesh id).

### Fold slider (0..1) → `setFoldAmount`  ·  Fold / Unfold buttons → `fold` / `unfold`
Folding is **visible now** — the box is on-screen in the 3D canvas the whole time.
```ts
onFoldScrub(t: number): void { sm.packaging!.setFoldAmount(this.pkgId, t); }  // 0 flat → 1 closed, no animation
onFold():   void { sm.packaging!.fold(this.pkgId); }                          // animate flat → closed (default 700 ms)
onUnfold(): void { sm.packaging!.unfold(this.pkgId); }                        // animate closed → flat
// optional: sm.packaging!.fold(id, 1200) for a slower tween. To keep the scrub slider synced during a
// tween, poll sm.packaging!.get(id).foldAmount on a rAF while it runs.
```
> Paint on the flat (unfolded) box, then hit **Fold** to see the artwork wrap the closed box. Painting works at any fold amount (the raycast reads whatever geometry is on screen).
>
> **STAGED FOLD (Round A):** sequenced templates (`tuckEnd`) fold in professional stages from the
> ONE scalar — walls wrap first, then dust flaps close, then the closures, then the tuck tongues
> slide in LAST (so nothing clips). No host wiring: the same slider / `fold()` tween drives it
> (each panel has a phase window inside 0..1). `simpleBox`/`sleeve` fold uniformly as before.

### Painting — nothing to wire per stroke (armed by `enterEditor` / `enterCreatorMode`)
- **3D box:** left-drag on the box paints. Alt+left-drag orbits; middle/right pan. Already armed — no per-control code.
- **Flat net:** paint in the **dieline pane** (§0c/§0d). Both writers hit the same layer texture, so the box and the flat net always agree — pane strokes update the box live.
- The active **brush / colour / eraser** are shared from the illustration brush UI automatically (same wiring as character UV-paint). On the dieline, **erase is a real alpha-erase** — strokes come off and the kraft cardboard shows through.

### cut / fold / bleed / panel checkboxes → filter guide **types** when drawing
The checkboxes never touch Salsa — they filter which `DielineGuide`s you draw. **Draw every segment of each guide** (`segments` is an array of line pairs).
```ts
enabledTypes = new Set<DielineGuideType>(['cut', 'fold', 'bleed', 'panel']);

onGuideToggle(type: DielineGuideType, on: boolean): void {
  on ? this.enabledTypes.add(type) : this.enabledTypes.delete(type);
  this.drawGuides(sm.packaging!.getGuides(this.pkgId), this.enabledTypes);
}

// Overlay renderer — canvas px ARE the dieline document space (1:1 with the flat artboard).
drawGuides(guides: DielineGuide[], enabled: Set<DielineGuideType>): void {
  const ctx = this.overlayCtx;
  ctx.clearRect(0, 0, this.docW, this.docH);
  for (const g of guides) {
    if (!enabled.has(g.type)) continue;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.type === 'panel' ? 1 : 2;
    ctx.setLineDash(g.type === 'fold' ? [6, 4] : []);   // dashed folds read as creases
    ctx.beginPath();
    for (const [a, b] of g.segments) {                  // ← ALL segments, not just segments[0]
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
  }
}
```

### Export PNG → `exportDielinePng`
Export serialises the linked dieline layer (the single source of truth — it already carries both flat drawing and 3D-surface paint). The only prerequisite is that `enterEditor` ran (it links the layer).
```ts
async onExport(): Promise<void> {
  const png = await sm.packaging!.exportDielinePng(this.pkgId);   // Blob | null (null if no layer linked)
  if (png) downloadBlob(png, 'dieline.png');                      // → download / send to print
}
```

### Guide color / type table
| `type`   | Meaning | Default color | Segments | Suggested draw |
|----------|---------|---------------|----------|----------------|
| `cut`    | The net's cut lines (outer perimeter incl. tongue chamfers / flap tapers) | `#222222` dark | many | solid, 2 px |
| `fold`   | The fold hinges (creases) | `#00aaff` blue | one seg per hinge | **dashed** |
| `slit`   | Short internal cuts — the tuck friction-lock slits at the tongue shoulders (`tuckEnd`) and the lid-lip shoulders (`rollEndMailer`) | `#ff8800` orange | 2 per tuck/lip assembly | solid, 2 px |
| `perforation` | Dashed/tear cut (reserved — no template emits it yet; display boxes will) | — | — | dash-dot |
| `bleed`  | Artwork safe/bleed rect inset by `bleed` mm | `#ff3399` pink | 4-seg rectangle | thin solid |
| `panel`  | Every panel outline; a **labeled** variant marks the glue tab (`label: 'Glue Tab'` — render the label, e.g. "no artwork here") | `#c8c8c8` grey | n segs × panel | subtle, 1 px, under everything |

> New guide types are added over time (`slit`/`perforation` in Round A) — hosts FILTER by type, so
> unknown types are safely ignorable; add checkboxes as you adopt them.

> All coordinates are **dieline canvas pixels** (= the document space, 1:1 with the artboard). `color` is a sensible default — override per your theme.

---

## 4. `sm.packaging` API ✅ (engine, gated → may be `null`)

Always null-check: `sm.packaging?.…` (returns `null` when `PACKAGING_ENABLED` is off).

| Method | Description |
|---|---|
| **`enterCreatorMode(opts?) → CreatorState`** | **THE mode entry** (§0): create-or-reuse the box in the current illustration doc, ensure the (transparent-on-fresh, reused-by-name, hidden system) `Dieline` layer + live-texture link, frame + alt-orbit on a clean stage, arm 3D-surface painting. Never resizes the doc. `opts = { params?, style?, packageId? }` — `packageId` targets an EXISTING package (§0b). Idempotent. |
| **`addPackage(params?, style?) → PackagingState`** | **Outliner "Add Mesh > Package…"** (§0b): create a package as a first-class unit-wrapper scene object WITHOUT entering the mode. Defaults: 80×60×40 mm `simpleBox`. |
| **`isPackageNode(nodeId) → string \| null`** | Resolve any panel/pivot/root node id to its package id (§0b) — the host's "selection is a package?" check. |
| **`attachDielinePane(uvRenderer) → DielinePaneHandle \| null`** | Wire a `UVCanvasRenderer` pane into the active creator paint session (§0c): pane strokes paint the dieline layer, background shows the texture, and the pane renders immediately synced (no stale mount). Returns a **LIVE** `{ uvToCanvas, guides, canvasWidth, canvasHeight, panels, onPaneResize }` handle — set `onPaneResize` to redraw your overlay after a pane layout resize (§0c); null while the mode is off. |
| **`detachDielinePane()`** | Detach the pane; 3D box painting stays armed. |
| **`exitCreatorMode()`** | Leave the mode: disarm painting, release the camera to the illustration sync, restore stage hygiene. The box + artwork + layer link stay in the scene. |
| **`getCreatorState() → CreatorState`** | `{ active, packageId, params, foldAmount, dielineLayerId, guides }` — the host panel's one-stop readout. `packageId` persists across exit. |
| `create(style, params, name?) → PackagingState` | Make the box (starts **flat**). `style` = `'simpleBox' \| 'tuckEnd' \| 'sleeve' \| 'rollEndMailer' \| 'rigidTwoPiece'`. Adds a kraft-brown 3D mesh to the scene. |
| `enterEditor(id, opts?) → EditorHandle \| null` | **Lower-level** editor setup (what the mode composes, plus doc-resizing): size doc to the dieline (**print-exact 1:1**), ensure + link the dieline layer, start flat, frame + alt-orbit, arm 3D-surface painting. `opts = { layerId?, frame? }`. Returns `{ meshId, canvasWidth, canvasHeight, dielineLayerId, guides }`. |
| `exitEditor(id)` | Disarm 3D painting + disable orbit. The box, fold state, and layer link persist. |
| `setDimensions(id, params) → PackagingState \| null` | Regenerate the net + box at new dimensions; preserves the fold amount. **Returns the updated state** (new `guides` + `canvasWidth/Height`). The live-slider path. |
| **`setStyle(id, style) → PackagingState \| null`** | **Convert an existing box to a different template** (the style dropdown, §3b). Always a clean topology rebuild: **package id changes** (use the returned `s.id`), dieline/stack re-link, paint re-arms in-mode, fold preserved. Artwork layers kept but remap onto the new net's UVs. |
| **`setStageBackground(opts: StageBackgroundOpts)`** | §4.1 stage THEME picker: `mode: 'gradient'` (studio default) `\| 'wavy' \| 'solid' \| 'checkers' \| 'dim' \| 'none'` + `color1`/`color2`. Applied live while the mode is active, remembered for re-enters; the user's own background is still restored on exit. `getStageBackground()` reads the theme in effect. |
| **`setBoardPreset(id, 'white' \| 'kraft') → boolean`** | §4.2 board stock: base tint + paper-fiber grain + panel-edge rim (all under the artwork). `'white'` coated (default) / `'kraft'`. Persisted with the package params. `getBoardPreset(id)` reads it. |
| `setFoldAmount(id, amount)` | `0` flat → `1` folded, no animation (scrub). Visible in the 3D canvas. |
| `fold(id, durationMs?)` / `unfold(id, durationMs?)` | Tweened fold/unfold (default 700 ms, **easeInOutCubic** — §4.3). |
| `setDielineLayer(id, layerId)` / `clearDielineLayer(id)` | Manually (un)link the live-texture layer. `enterEditor` does this for you. |
| **`addLayer` / `addVectorLayer` / `getLayerStack` / `setActiveLayer` / `setLayerVisible` / `setLayerOpacity` / `reorderLayer` / `removeLayer` / `renameLayer`** | **The package LAYER STACK (§0e)** — multi-layer paint + vector layers composited onto the box; the legacy dieline auto-migrates to the stack's base layer. |
| `isActivePaintable() → boolean` | `false` while the creator target's active layer is a VECTOR layer (**place mode** — surface paint disarmed, box click-pick suppression lifted). Hosts rarely need it (the gate is applied automatically); useful for toolbar state. |
| `exportDielinePng(id) → Promise<Blob \| null>` | The artwork as a flat PNG: the **flattened stack composite** (§0e) when a stack exists, else the single dieline layer. |
| `getGuides(id) → DielineGuide[]` | The current guide overlay (cut/fold/bleed/panel, canvas px). |
| `get(id)` / `getAll()` / `remove(id)` | State lookup (guides + canvas size + params + foldAmount) / list / delete (unlinks + removes the mesh). |

```ts
interface DielineParams {
  width: number; height: number; depth: number; bleed?: number; dpi?: number;   // mm
  tuckStyle?: 'reverse' | 'straight';   // tuckEnd only (RTE default) — flip via setDimensions (rebuild: id changes)
  lockTabs?: boolean;                   // rollEndMailer only (default true) — flip = topology → rebuild (id changes)
  restOpenAmount?: number;              // rollEndMailer only (0..0.95, default 0 = closed) — dims-only
  lidDepth?: number;                    // rigidTwoPiece only (mm; default full telescope) — dims-only
  boardThickness?: number;              // rigidTwoPiece only (mm, default 2; derives the lid dims) — dims-only
}
type BoxStyle = 'simpleBox' | 'tuckEnd' | 'sleeve' | 'rollEndMailer' | 'rigidTwoPiece';
interface CreatorModeOpts { params?: DielineParams; style?: BoxStyle; packageId?: string; }
interface DielinePanePanel { id: string; label: string; uvRect: { u0: number; v0: number; u1: number; v1: number }; }
interface DielinePaneHandle {   // LIVE — mapper reads current pane state, fields are getters over current package state
  uvToCanvas: (u: number, v: number) => [number, number];   // UV [0,1] → pane canvas BACKING-STORE px
  readonly guides: DielineGuide[]; readonly canvasWidth: number; readonly canvasHeight: number;
  readonly panels: DielinePanePanel[];                      // per-panel labels + UV rects (§0c overlay)
  onPaneResize?: () => void;    // SET THIS: fires after a pane LAYOUT resize re-synced + re-rendered the
                                // pane — redraw your guide overlay in it (§0c; the mapping already moved)
}
interface CreatorState {
  active: boolean; packageId: string | null; style: BoxStyle | null; params: DielineParams | null;
  foldAmount: number; dielineLayerId: string | null; guides: DielineGuide[];
}
interface EnterEditorOpts { layerId?: string; frame?: boolean; }
interface EditorHandle {
  meshId: string; canvasWidth: number; canvasHeight: number;
  dielineLayerId: string | null; guides: DielineGuide[];
}
interface PackagingState {
  id: string; meshId: string; style: BoxStyle; params: DielineParams;
  foldAmount: number;            // 0..1
  canvasWidth: number; canvasHeight: number;   // dieline canvas size (px) → the doc size
  guides: DielineGuide[]; panelLabels: Record<string,string>; dielineLayerId?: string;
}
interface DielineGuide {
  type: 'cut'|'fold'|'bleed'|'safeZone'|'panel'|'slit'|'perforation';
  segments: [[number,number],[number,number]][]; color: string;
  label?: string;   // annotation (the glue-tab marker guide carries 'Glue Tab')
}
```

### How the single paint surface is wired (Salsa internals, for reference)
`enterEditor` → the box's diffuse is the dieline raster layer's GPUTexture (`LiveTextureMode`). 3D-surface painting points the shared UV-paint engine at **that same layer's `RasterTextureManager`**, so a raycast hit → net UV → a brush dab on the one texture. Flat raster tools paint the same layer. It deliberately does **not** make the box editable / auto-unwrap (that would clobber the authored net UVs) — the raycast reads the baked geometry UVs directly. Result: one texture, three writers (flat tools, 3D paint, export reader), zero divergence.
> **Zero-divergence guarantee (bug-fix note):** `LiveTextureMode` resolves the mesh's diffuse through the layer **manager's live `getTexture()`** (falling back to the `layer.texture` snapshot field). The snapshot field is reassignable (the raster timeline's cel swap writes into it) while every paint stroke writes the manager's texture — sampling the snapshot let the two silently diverge (pane showed paint, box stayed kraft, forever). The sync also re-derives `hasTexture` even when the texture reference is unchanged, so a null-at-link layer self-heals instead of sticking on the untextured pipeline.

---

## 5. Procedural parallel (so it feels like the rest of the creator)
| Character creator | Package Designer |
|---|---|
| `setBodyParams3D` (slider → regen) | `sm.packaging.setDimensions` (slider → regen) |
| presets (Tee / Crop) | box styles (`simpleBox` / `tuckEnd` / `sleeve` / `rollEndMailer` / `rigidTwoPiece` ✅ → gable / pillow, later) |
| Character Creator mode toggle in the illustration editor | `sm.packaging.enterCreatorMode` / `exitCreatorMode` |
| `enterUVPaintMode3D` (orbit + paint the mesh) | orbit + paint the box (armed by `enterCreatorMode`) |
| paint in UV → mesh texture | paint the box / draw the net → **one dieline layer** (the UV **is** the dieline) |

---

## 6. Status / TODO
- ✅ **Salsa: TEMPLATE ROUND B (2026-07-21)** — `rollEndMailer` (M4, FEFCO 0427-style: base +
  hinged lid with chamfered front lip + shoulder slits, DOUBLE-WALL rolled sides via `addRollWall`
  — chained pivots, 180°-relative inner ply ending coplanar; front wall + corner `lockTabs`
  (default on, flip = rebuild); `restOpenAmount` rest-ajar lid — dims-only; dust webs deliberately
  omitted, non-rigid) and `rigidTwoPiece` (M5: TWO hinge hierarchies under one package root,
  DERIVED lid dims = base + 2×`boardThickness` clearance, `lidDepth` full-telescope/shallow, and
  the new **`FoldPanel.foldTranslate`** fold-driven TRANSLATION — the lid lifts/carries/SEATS onto
  the base over [0.6, 1] from the same fold scalar, implemented identically in setBoxFold /
  computeFoldWorldCorners / compileFoldMesh; TWO nets on one canvas with a gutter, 'Lid …' pane
  labels, corner-cut rigid net with no glue tabs). Full lifecycle parity: addPackage / creator
  mode / in-place `setDimensions` fast path for the dims-only params / isolation / persistence
  round-trip / unit select + framing bounds spanning both trays. Verified by
  `roll-end-mailer.test.ts` (21), `rigid-two-piece.test.ts` (22), + extended
  `packaging-sync.test.ts` (14) / `packaging-persistence.test.ts` (7). 🟦 Frogmarks: style
  dropdown entries + the §3b Round-B param controls.
- ✅ **Salsa: TEMPLATE ROUND A (2026-07-21)** — `tuckEnd` (RTE/STE via `params.tuckStyle`, 13
  panels: 4 walls + glue tab + 2 tuck assemblies) and `sleeve` (open band, 5 panels) box styles;
  reusable mechanism helpers (`src/packaging/mechanisms.ts`: `addTuckFlap` M1 / `addGlueTab` M2 /
  `buildNetGuides`); per-panel **fold sequencing** (`FoldPanel.foldWindow` phase windows — walls →
  dust flaps → closures → tongues, driven by the ONE fold scalar, `simpleBox` unchanged); new guide
  types `'slit'`/`'perforation'` + `DielineGuide.label`; glue tab excluded from artwork UVs (margin
  strip); `getCreatorState().style`; `setDimensions` topology guard (tuckStyle flip → clean rebuild
  with re-link + paint re-arm). Verified by `tuck-end.test.ts` (19), `sleeve.test.ts` (5),
  `fold-sequencing.test.ts` (7), `packaging-sync.test.ts` (7) — closed-form corners + real-node +
  hinge-coincidence + interpenetration gates. 🟦 Frogmarks: the style dropdown + tuckStyle toggle
  (§3b).
- ✅ **Salsa: PACKAGE LAYER STACK (§0e, 2026-07-21)** — multi-layer raster stack + vector layers per package (`addLayer` / `addVectorLayer` / `getLayerStack` / `setActiveLayer` / `setLayerVisible` / `setLayerOpacity` / `reorderLayer` / `removeLayer` / `renameLayer`); box + pane background sample the offscreen **stack COMPOSITE** (shared `RasterCompositor`, dedicated instance); painting targets the ACTIVE layer; legacy dieline auto-migrates to the base layer; stack order + active layer persist in the packaging entry, the layers persist as tagged doc layers (`packageOwnerId` manifest field); export flattens the composite; paint/place mode switches implicitly with the active layer kind (raster/vector) incl. the click-pick-suppression gate. Verified by `packaging-layer-stack.test.ts` (7 tests).
- ✅ **Salsa: FRESH-PACKAGE LIVE-PAINT REGRESSION (Part 0, 2026-07-21)** — a freshly created package didn't live-update while painting (a re-adopted one did): the paint session captured the dieline layer's `RasterTextureManager` ONCE at arm; when the document-restore pipeline rebuilt the layer list (`clearAllLayers` + `addLayerWithId` — same layer id, NEW manager object) the engine kept writing the orphaned manager's texture while the panels (resolved live by layer id) sampled the new one. Root fix: the paint target carries a `resolveTexMgr` provider — the MANAGER itself re-resolves by layer id at every stroke begin. Verified by `packaging-fresh-create.test.ts` (7 tests through the REAL `RasterLayerManager` + REAL `UVPaintController`, incl. the restore-race regression + lazy-texture + doc-resize variants).
- ✅ **Salsa: CREATOR MODE (the pivot)** — `enterCreatorMode` / `exitCreatorMode` / `getCreatorState` (mode-in-the-Illustration-editor; idempotent re-enter, `Dieline`-layer reuse by name, transparent-by-default dieline over the kraft base (`texOverBase`), hidden system layer (`systemOwner:'packaging'`, persisted), city-mode stage hygiene, no doc resize) + console harness `salsaPkgCreator()` / `salsaPkgCreatorExit()`. Verified by `packaging-creator.test.ts` (20 tests — incl. panel-material re-apply, creator-mode isolation, live pane handle) + `packaging-pane.test.ts` (6 tests — letterbox mapping round-trip + backing-store sizing) + `packaging-material.test.ts`.
- ✅ **Salsa: Outliner integration APIs (§0b)** — `addPackage` (first-class unit-wrapper scene object, City thin-wrapper pattern: one outliner node, click-a-panel selects the unit, whole-box gizmo, fold-range cached bounds), `isPackageNode` (panel/pivot/root → package id), `enterCreatorMode({ packageId })` targeting. 🟦 Frogmarks: the "Add Mesh > Package…" dropdown entry + the selection-driven "Package Mode" button.
- ✅ **Salsa: Unwrap pane (§0c)** — `attachDielinePane` / `detachDielinePane` reuse the ONE UV-paint controller (pane + 3D box → the same dieline layer; NO UV session opened, authored net UVs preserved; pane renders background-only: texture + boundary + brush ring). 🟦 Frogmarks: the pane canvas + guide overlay from `DielinePaneHandle`.
- ✅ **Salsa: critical-bug round (2026-07-21)** — (1) paint-reaches-the-box: `LiveTextureMode` samples the layer *manager's* live texture + `hasTexture` self-heal (see the §4 zero-divergence note); (2) in-mode click-select suppression for package nodes (`pickSuppressed3D` predicate, §0); (3) pane no-stale-mount/resize: immediate synced render on attach + ResizeObserver + `DielinePaneHandle.onPaneResize` (§0c). Verified by `packaging-paint-chain.test.ts` (8 integration tests through the REAL PackagingManager + scene nodes + LiveTextureMode, incl. the snapshot-divergence regression) + 3 new pane-resize tests in `packaging-pane.test.ts`.
- ✅ Salsa: shell app + dashboard + box cartridge (**route path deprecated**, §2); `sm.packaging.*` incl. `enterEditor`/`exitEditor` (lower-level: orbit + surface paint + dieline layer + doc size, one call); `create` / `setDimensions` / `fold` / `unfold` / `setFoldAmount` / `setDielineLayer` / `exportDielinePng` / `getGuides`; kraft-brown material; live-texture (reuses `LiveTextureMode`).
- ✅ **3D-surface painting unified with the flat dieline**: both write the one dieline raster layer (shared `RasterTextureManager`), export reads it. Mirrors the character UV-paint path but skips `openUVEditor3D` to preserve the box's authored net UVs.
- ✅ **Fold-mesh verified** (`src/packaging/fold-mesh.test.ts`, 8 tests): at fold=1 the six panels close into an exact W×H×D box, normals unit-length + outward, winding matches (a winding bug was found + fixed in `compileFoldMesh`).
- ✅ **Guides complete**: `cut` (net perimeter), `panel` (6 outlines), `fold`, `bleed`.
- 🟦 Frogmarks: a **toolbar button + side panel in the EXISTING illustration editor** calling `enterCreatorMode` / `exitCreatorMode`; the W/H/D/Bleed panel + guide overlay (+ `onPaneResize` redraw) + fold slider/buttons + export button (§3b snippets). Flat drawing goes through the dieline pane — no layer selection or stroke-end sync wiring needed (pane strokes auto-sync the box). (The old doc-tagging / `dashboardKind` routing items are obsolete with the deprecated route, §2.)
- 🔶 Not built (either side): further box styles (pillow / gable / auto-lock / display — packaging-templates.md §2; tuck-end + sleeve ✅ Round A, roll-end mailer + rigid two-piece ✅ Round B), print-ready **PDF** export (`exportPrintPdf`, needs a PDF lib), `exportFoldedRender` (3D render capture), the `.frogcart` order-submission flow, keyframeable creases.

## 7. Caveats / verify in-browser
- **Alt to orbit:** painting owns left-drag on the box, so orbit is **alt+left-drag** (pan is middle/right). Surface the "Alt = orbit" hint in the UI.
- **Fold geometry** is unit-verified (exact box, outward normals) but not yet confirmed by a live render — if a face shades inside-out, the sign logic is in `compileFoldMesh` (`src/packaging/fold-mesh.ts`).
- **Non-square dieline canvas:** the box net is a cruciform (non-square), so the paint texture is non-square. The pane **letterboxes to the texture aspect** (§0c) so the flat view isn't squeezed. Brush dabs should stay round (the engine maps UV→texel in real px), but confirm a round brush isn't elliptical on the box; if it is, that's a brush aspect-correction tune, not a wiring bug.
- **Transparent default = kraft shows through:** a fresh Dieline layer is TRANSPARENT and the box composites it over the kraft base (`texOverBase`) — an empty layer must render as **plain cardboard, not black**; that's the acceptance check for the material wiring. Want white board? Fill the layer white (the `fillLayerWhite` host hook still exists as a utility, but nothing calls it automatically).
- **Print 1:1 sizing:** creator mode does NOT resize the doc, so `exportDielinePng` is **doc-sized, not mm→px exact** (§0). The lower-level `enterEditor` sets the doc to `canvasWidth × canvasHeight` for 1:1, print-accurate artwork.
- **`Dieline` layer reuse is by NAME:** re-entering the mode adopts an existing raster layer named `Dieline` (never wipes it; legacy visible ones get tagged + hidden as system layers). Renaming it makes the next enter create a fresh transparent one.
- Box mesh is scaled mm × 0.02 → sane world units; `enterCreatorMode` / `enterEditor` frame the camera on it.
