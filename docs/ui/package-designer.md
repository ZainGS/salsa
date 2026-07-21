# Package Creator — Frogmarks UI Integration

**Last Updated:** 2026-07-20 (**PIVOT: Package Creator is now a MODE inside the Illustration editor** — entered from a normal Illustration document with one call, `sm.packaging.enterCreatorMode()`, exactly like the Character Creator / City Edit Mode patterns. The bespoke `/packaging` route is **deprecated**; see §2.)
**Engine spec:** [packaging-system.md](../specs/packaging-system.md)
**Sibling UI docs:** [character-creator.md](./character-creator.md) (the mode + UV-paint pattern this mirrors), [3d-scene.md](./3d-scene.md), [clothing.md](./clothing.md).

Package Creator is an **edit mode in the existing Illustration editor** (the canvas where "Add Cube", Character Creator, and City Edit Mode all demonstrably work). Entering the mode drops a foldable **3D box** into the **current illustration document's** scene, creates (or reuses) a **white "Dieline" raster layer** live-textured onto it, frames + alt-orbits the box on a clean focus stage, and arms **3D-surface painting**. You orbit the box and paint directly on it, *or* draw on the Dieline layer with the normal raster tools — **one texture, two ways to paint**. A fold slider folds the flat net into the closed box; export is the flat dieline PNG.

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

- **Idempotent re-enter.** Re-entering (even after exit) **reuses the same box and the same layer** — no duplicate boxes, no duplicate 'Dieline' layers. A layer already **named `Dieline`** in the doc is adopted rather than recreated. Passing `params` on re-enter re-dimensions the existing box.
- **Fresh Dieline layers start WHITE.** A newly created layer is filled opaque white once (an empty layer samples as black on the box — blank paper must be white). A **reused** layer is never touched — artwork is preserved.
- **Your document is untouched.** Unlike the lower-level `enterEditor`, the mode does **not** call `setDocumentSize`. The Dieline layer is document-sized and artwork maps onto the box via the net UVs. ⚠ **Print caveat:** the exported PNG is therefore **doc-sized, not 1:1 print mm→px**. For print-exact sizing use the lower-level `enterEditor` (which resizes the doc to the dieline canvas), or resize the doc yourself before entering.
- **City-mode enter/exit hygiene.** Enter: measured-bounds framing + 3/4 alt-orbit (camera claimed from the 2D sync), clean focus background, view gizmo, box-select suppressed, selection/hover cleared. Exit: all of it restored.

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

- **Select-as-a-unit (City thin-wrapper pattern) ✅** — the package root is a thin-wrapper container: it shows as **ONE outliner node**, clicking **any panel** selects the whole package, and the gizmo moves/rotates the box **as a unit** (the root's transform composes into all panels; folding is untouched). The selection box/gizmo is sized from cached bounds covering the whole fold range (flat net ∪ closed box).
- `enterCreatorMode({ packageId })` with an unknown/stale id safely falls back to the normal create-or-reuse enter. After exiting, `getCreatorState().packageId` keeps tracking the targeted package.
- `sm.packaging.getAll()` lists all packages (id, params, foldAmount, dielineLayerId) for an Outliner-side registry.
- ⚠ `isPackageNode`/`getAll` cover packages created **this session** — package hierarchies reloaded from a saved document are not yet re-adopted by the manager (pre-existing limitation, unchanged).

---

## 0c. Unwrap pane (the dieline as a paintable UV pane) ✅ (Salsa) / 🟦 (Frogmarks pane + overlay)

The flat-dieline pane uses the **same mechanism as character UV paint**: a `UVCanvasRenderer` over a pane canvas attaches to the one UV-paint controller, so **pane strokes and 3D box strokes paint the SAME dieline layer** (no second paint path, no divergence). Crucially it attaches **without opening a UV session** — `openUVEditor3D` would auto-unwrap and **clobber the box's authored net UVs** (the known trap), so the pane hooks onto the already-armed surface-paint session and the baked net UVs are the mapping.

```ts
// AFTER enterCreatorMode (returns null while the mode is off):
const uvRenderer = new UVCanvasRenderer(paneCanvasEl);
const pane = sm.packaging!.attachDielinePane(uvRenderer);
if (pane) {
  // pane = { uvToCanvas, guides, canvasWidth, canvasHeight }
  // Pane background now shows the dieline texture (throttled readback); left-drag on the pane paints
  // the dieline layer (same brush UI as everywhere); the 3D box updates live. Overlay the guides on a
  // canvas stacked over the pane: guide points are DIELINE-CANVAS px → normalize → uvToCanvas.
  for (const g of pane.guides) {
    for (const [a, b] of g.segments) {
      const [x0, y0] = pane.uvToCanvas(a[0] / pane.canvasWidth, a[1] / pane.canvasHeight);
      const [x1, y1] = pane.uvToCanvas(b[0] / pane.canvasWidth, b[1] / pane.canvasHeight);
      // stroke x0,y0 → x1,y1 in g.color (dash 'fold', see the guide table in §3b)
    }
  }
}
sm.packaging!.detachDielinePane();   // hide the pane; 3D box painting stays armed
```

- **Direct-mesh painting is already armed by the mode** — the pane is additive. Both writers hit the one dieline layer; `exitCreatorMode` tears the whole paint session down (pane auto-detaches).
- The pane draws in **background-only** mode (texture + UV boundary + brush ring — no wireframe/islands, since the panels are never made editable). Re-attach (or redraw the overlay from `getGuides`) after `setDimensions` — guides change with the net.
- ⚠ **Aspect:** the pane maps UV [0,1] to a square region, so a non-square dieline layer (it's doc-sized in creator mode) shows slightly aspect-squeezed. Painting is still texel-correct; strokes, background, and `uvToCanvas`-mapped guides all agree.

---

## 1. One surface, two ways to paint

The **Dieline raster layer is the single source of truth** for the box surface:

- **Flat drawing** — select the Dieline layer and use the normal raster tools. The net UVs map the layer onto the box panels.
- **3D-surface painting** — left-drag on the box (armed by `enterCreatorMode`); raycast hit → net UV → **the same dieline layer**.
- **The box** live-textures from that layer, flat *or* folded. **Export** = that same layer as a PNG.

---

## 2. DEPRECATED — the bespoke `/packaging` route 🗑

The original design (a separate Package Designer shell tile / packages dashboard / `kind:'packaging'` docs / a bespoke editor route) is **deprecated — do not build it**. The bespoke route repeatedly failed to show the box because it re-implemented the illustration canvas mount instead of reusing it; the mode above kills that dependency entirely. The shell tile/dashboard plumbing still exists behind `PACKAGING_ENABLED` but is no longer the integration path. `enterEditor(id, opts)` remains documented in §4 as the **lower-level API** (it is what the mode composes, plus doc-resizing for print-exact work).

---

## 3. The Package Creator panel (Frogmarks builds this, in the EXISTING illustration editor) 🟦

```
Edit Package ▸                              ┌───────────────────────────────────┐
  Box style   [ Simple Box ▾ ]              │                                   │
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

// Select the dieline layer so the flat raster tools draw onto it, and draw the guide overlay.
if (st.dielineLayerId) sm.selectRasterLayer(st.dielineLayerId);
drawGuides(st.guides, enabledTypes);

// EXIT (button toggled off) — box + artwork stay in the scene; camera returns to the 2D sync.
sm.packaging!.exitCreatorMode();
```
> **Persistence:** the box params + Dieline artwork live in the illustration document like any other content. Re-opening the doc and re-entering the mode reuses the `Dieline` layer by name; keep `st.packageId` around while the editor is open.

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

### Painting — nothing to wire per stroke (armed by `enterEditor`)
- **3D box:** left-drag on the box paints. Alt+left-drag orbits; middle/right pan. Already armed by `enterEditor` — no per-control code.
- **Flat artboard:** select the dieline layer (getting-started step 3) and use the **normal raster tools**. Both write the same layer, so the box and the flat net always agree.
- The active **brush / colour / eraser** are shared from the illustration brush UI automatically (same wiring as character UV-paint).
- **`syncLiveTextures3D` is called for you on 3D stroke-end.** For **flat** raster strokes, call `sm.syncLiveTextures3D()` on your raster stroke-end hook (pointer-up) so the box refreshes — it's a cheap refresh (shared texture), not a copy.

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
| `cut`    | Outer perimeter of the whole cruciform net (the scissor/crease-cut line) | `#222222` dark | perimeter loop (12 segs) | solid, 2 px |
| `fold`   | The 5 fold hinges (base↔walls, back↔lid) | `#00aaff` blue | one seg per hinge | **dashed** |
| `bleed`  | Artwork safe/bleed rect inset by `bleed` mm | `#ff3399` pink | 4-seg rectangle | thin solid |
| `panel`  | Each of the 6 panel outlines (base/front/back/left/right/lid) | `#c8c8c8` grey | 4 segs × 6 panels | subtle, 1 px, under everything |

> All coordinates are **dieline canvas pixels** (= the document space, 1:1 with the artboard). `color` is a sensible default — override per your theme.

---

## 4. `sm.packaging` API ✅ (engine, gated → may be `null`)

Always null-check: `sm.packaging?.…` (returns `null` when `PACKAGING_ENABLED` is off).

| Method | Description |
|---|---|
| **`enterCreatorMode(opts?) → CreatorState`** | **THE mode entry** (§0): create-or-reuse the box in the current illustration doc, ensure the (white-on-fresh, reused-by-name) `Dieline` layer + live-texture link, frame + alt-orbit on a clean stage, arm 3D-surface painting. Never resizes the doc. `opts = { params?, style?, packageId? }` — `packageId` targets an EXISTING package (§0b). Idempotent. |
| **`addPackage(params?, style?) → PackagingState`** | **Outliner "Add Mesh > Package…"** (§0b): create a package as a first-class unit-wrapper scene object WITHOUT entering the mode. Defaults: 80×60×40 mm `simpleBox`. |
| **`isPackageNode(nodeId) → string \| null`** | Resolve any panel/pivot/root node id to its package id (§0b) — the host's "selection is a package?" check. |
| **`attachDielinePane(uvRenderer) → DielinePaneHandle \| null`** | Wire a `UVCanvasRenderer` pane into the active creator paint session (§0c): pane strokes paint the dieline layer, background shows the texture. Returns `{ uvToCanvas, guides, canvasWidth, canvasHeight }`; null while the mode is off. |
| **`detachDielinePane()`** | Detach the pane; 3D box painting stays armed. |
| **`exitCreatorMode()`** | Leave the mode: disarm painting, release the camera to the illustration sync, restore stage hygiene. The box + artwork + layer link stay in the scene. |
| **`getCreatorState() → CreatorState`** | `{ active, packageId, params, foldAmount, dielineLayerId, guides }` — the host panel's one-stop readout. `packageId` persists across exit. |
| `create(style, params, name?) → PackagingState` | Make the box (starts **flat**). `style` = `'simpleBox'`. Adds a kraft-brown 3D mesh to the scene. |
| `enterEditor(id, opts?) → EditorHandle \| null` | **Lower-level** editor setup (what the mode composes, plus doc-resizing): size doc to the dieline (**print-exact 1:1**), ensure + link the dieline layer, start flat, frame + alt-orbit, arm 3D-surface painting. `opts = { layerId?, frame? }`. Returns `{ meshId, canvasWidth, canvasHeight, dielineLayerId, guides }`. |
| `exitEditor(id)` | Disarm 3D painting + disable orbit. The box, fold state, and layer link persist. |
| `setDimensions(id, params) → PackagingState \| null` | Regenerate the net + box at new dimensions; preserves the fold amount. **Returns the updated state** (new `guides` + `canvasWidth/Height`). The live-slider path. |
| `setFoldAmount(id, amount)` | `0` flat → `1` folded, no animation (scrub). Visible in the 3D canvas. |
| `fold(id, durationMs?)` / `unfold(id, durationMs?)` | Tweened fold/unfold (default 700 ms). |
| `setDielineLayer(id, layerId)` / `clearDielineLayer(id)` | Manually (un)link the live-texture layer. `enterEditor` does this for you. |
| `exportDielinePng(id) → Promise<Blob \| null>` | The dieline canvas as a flat PNG (both flat + 3D-painted content). |
| `getGuides(id) → DielineGuide[]` | The current guide overlay (cut/fold/bleed/panel, canvas px). |
| `get(id)` / `getAll()` / `remove(id)` | State lookup (guides + canvas size + params + foldAmount) / list / delete (unlinks + removes the mesh). |

```ts
interface DielineParams { width: number; height: number; depth: number; bleed?: number; dpi?: number; }  // mm
type BoxStyle = 'simpleBox';
interface CreatorModeOpts { params?: DielineParams; style?: BoxStyle; packageId?: string; }
interface DielinePaneHandle {
  uvToCanvas: (u: number, v: number) => [number, number];   // UV [0,1] → pane canvas px
  guides: DielineGuide[]; canvasWidth: number; canvasHeight: number;
}
interface CreatorState {
  active: boolean; packageId: string | null; params: DielineParams | null;
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
interface DielineGuide { type: 'cut'|'fold'|'bleed'|'safeZone'|'panel'; segments: [[number,number],[number,number]][]; color: string; }
```

### How the single paint surface is wired (Salsa internals, for reference)
`enterEditor` → the box's diffuse is the dieline raster layer's GPUTexture (`LiveTextureMode`). 3D-surface painting points the shared UV-paint engine at **that same layer's `RasterTextureManager`**, so a raycast hit → net UV → a brush dab on the one texture. Flat raster tools paint the same layer. It deliberately does **not** make the box editable / auto-unwrap (that would clobber the authored net UVs) — the raycast reads the baked geometry UVs directly. Result: one texture, three writers (flat tools, 3D paint, export reader), zero divergence.

---

## 5. Procedural parallel (so it feels like the rest of the creator)
| Character creator | Package Designer |
|---|---|
| `setBodyParams3D` (slider → regen) | `sm.packaging.setDimensions` (slider → regen) |
| presets (Tee / Crop) | box styles (`simpleBox` → tuck-end / mailer / sleeve, later) |
| Character Creator mode toggle in the illustration editor | `sm.packaging.enterCreatorMode` / `exitCreatorMode` |
| `enterUVPaintMode3D` (orbit + paint the mesh) | orbit + paint the box (armed by `enterCreatorMode`) |
| paint in UV → mesh texture | paint the box / draw the net → **one dieline layer** (the UV **is** the dieline) |

---

## 6. Status / TODO
- ✅ **Salsa: CREATOR MODE (the pivot)** — `enterCreatorMode` / `exitCreatorMode` / `getCreatorState` (mode-in-the-Illustration-editor; idempotent re-enter, `Dieline`-layer reuse by name, white fill on fresh layers only, city-mode stage hygiene, no doc resize) + console harness `salsaPkgCreator()` / `salsaPkgCreatorExit()`. Verified by `packaging-creator.test.ts` (14 tests).
- ✅ **Salsa: Outliner integration APIs (§0b)** — `addPackage` (first-class unit-wrapper scene object, City thin-wrapper pattern: one outliner node, click-a-panel selects the unit, whole-box gizmo, fold-range cached bounds), `isPackageNode` (panel/pivot/root → package id), `enterCreatorMode({ packageId })` targeting. 🟦 Frogmarks: the "Add Mesh > Package…" dropdown entry + the selection-driven "Package Mode" button.
- ✅ **Salsa: Unwrap pane (§0c)** — `attachDielinePane` / `detachDielinePane` reuse the ONE UV-paint controller (pane + 3D box → the same dieline layer; NO UV session opened, authored net UVs preserved; pane renders background-only: texture + boundary + brush ring). 🟦 Frogmarks: the pane canvas + guide overlay from `DielinePaneHandle`.
- ✅ Salsa: shell app + dashboard + box cartridge (**route path deprecated**, §2); `sm.packaging.*` incl. `enterEditor`/`exitEditor` (lower-level: orbit + surface paint + dieline layer + doc size, one call); `create` / `setDimensions` / `fold` / `unfold` / `setFoldAmount` / `setDielineLayer` / `exportDielinePng` / `getGuides`; kraft-brown material; live-texture (reuses `LiveTextureMode`).
- ✅ **3D-surface painting unified with the flat dieline**: both write the one dieline raster layer (shared `RasterTextureManager`), export reads it. Mirrors the character UV-paint path but skips `openUVEditor3D` to preserve the box's authored net UVs.
- ✅ **Fold-mesh verified** (`src/packaging/fold-mesh.test.ts`, 8 tests): at fold=1 the six panels close into an exact W×H×D box, normals unit-length + outward, winding matches (a winding bug was found + fixed in `compileFoldMesh`).
- ✅ **Guides complete**: `cut` (net perimeter), `panel` (6 outlines), `fold`, `bleed`.
- 🟦 Frogmarks: a **toolbar button + side panel in the EXISTING illustration editor** calling `enterCreatorMode` / `exitCreatorMode`; the W/H/D/Bleed panel + guide overlay + fold slider/buttons + export button (§3b snippets); select the dieline layer for flat drawing + `syncLiveTextures3D` on flat stroke-end. (The old doc-tagging / `dashboardKind` routing items are obsolete with the deprecated route, §2.)
- 🔶 Not built (either side): more box styles (tuck-end/mailer/sleeve/pillow/lid+tray — spec Phase 8), print-ready **PDF** export (`exportPrintPdf`, needs a PDF lib), `exportFoldedRender` (3D render capture), the `.frogcart` order-submission flow, keyframeable creases.

## 7. Caveats / verify in-browser
- **Alt to orbit:** painting owns left-drag on the box, so orbit is **alt+left-drag** (pan is middle/right). Surface the "Alt = orbit" hint in the UI.
- **Fold geometry** is unit-verified (exact box, outward normals) but not yet confirmed by a live render — if a face shades inside-out, the sign logic is in `compileFoldMesh` (`src/packaging/fold-mesh.ts`).
- **Non-square dieline canvas:** the box net is a cruciform (non-square), so the paint texture is non-square. Brush dabs should stay round (the engine maps UV→texel in real px), but confirm a round brush isn't elliptical on the box; if it is, that's a brush aspect-correction tune, not a wiring bug.
- **Sync on FLAT strokes:** `syncLiveTextures3D()` is automatic on 3D-surface strokes but must be called on flat raster stroke-end.
- **Print 1:1 sizing:** creator mode does NOT resize the doc, so `exportDielinePng` is **doc-sized, not mm→px exact** (§0). The lower-level `enterEditor` sets the doc to `canvasWidth × canvasHeight` for 1:1, print-accurate artwork.
- **`Dieline` layer reuse is by NAME:** re-entering the mode adopts an existing raster layer named `Dieline` (never wipes it). Renaming it makes the next enter create a fresh white one.
- Box mesh is scaled mm × 0.02 → sane world units; `enterCreatorMode` / `enterEditor` frame the camera on it.
