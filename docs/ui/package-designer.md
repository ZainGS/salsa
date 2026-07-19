# Package Designer — Frogmarks UI Integration

**Last Updated:** 2026-06-26 (v1 engine + shell app done; editor UI is Frogmarks-side)
**Engine spec:** [packaging-system.md](../specs/packaging-system.md)
**Sibling UI docs:** [shell-ui.md](./shell-ui.md) (the shell app + dashboards), [character-creator.md](./character-creator.md) (the procedural-slider pattern this mirrors), [clothing.md](./clothing.md).

Package Designer is a first-class Frogmarks app (a shell tile between Illustrator and Import): **design a flat dieline → watch it fold into a 3D box**, with **procedural** W×H×D generation (the character-creator pattern) and **live-texture** drawing (draw the flat net, it appears on the folded box). The box is a `.frogmarks` document tagged `kind: 'packaging'`.

> **Status legend:** ✅ engine done (Salsa) · 🟦 Frogmarks must implement · 🔶 not built yet (either side).
> **Modularity:** everything is gated by `PACKAGING_ENABLED` (`shell-storage.ts`). Off → no tile/dashboard/box, `sm.packaging` returns `null`. Treat the whole feature as optional.

---

## 0. What's already done in Salsa (don't rebuild)
- **Shell app** ✅ — the "Package Designer" tile (kraft-box icon + a spinning 3D cardboard-box cartridge on hover) and a **packages sub-dashboard** (same grid as Illustrator, filtered to packaging docs, with a **"+ New Product Packaging"** tile). Clicking the tile calls `openPackageDashboard()` internally.
- **Engine** ✅ — `sm.packaging.*`: create the box mesh, regenerate on dimension change, fold/unfold, live-texture a dieline layer, export PNG. See §4.

## 1. The flow
```
Shell home ▸ [Package Designer tile]  → packages dashboard (grid of packaging projects)
   ├── "+ New Product Packaging" tile → host creates a kind:'packaging' doc → opens the editor
   └── a project card                 → host opens that doc in the editor
Editor:  dieline canvas (draw)  ⟷  3D box (folds, live-textured)  +  procedural panel  +  export
```

---

## 2. Shell integration — what Frogmarks must wire 🟦

The shell hands you everything via the existing `onActivate` event; the new piece is the **`dashboardKind`** field.

```ts
sm.shell.onActivate.subscribe(e => {
  // e.kind: 'project' | 'empty' | 'system' | 'local' | 'remote'
  // e.dashboardKind: 'illustration' | 'packaging' | undefined   ← NEW
  if (e.kind === 'empty') {
    // "+ New …" tile. Open your New-doc modal; on confirm create the document with the right kind:
    const kind = e.dashboardKind ?? 'illustration';   // 'packaging' → a packaging doc
    // …create doc tagged `kind`, then open it…
  } else if (e.kind === 'project') {
    // Open e.id. e.dashboardKind tells you which editor: 'packaging' → Package Designer, else Illustrator.
  }
});
```

**Host responsibilities (the doc store):**
1. **Tag** new docs created from the packages dashboard with `kind: 'packaging'`.
2. In `ShellDocumentSource.listProjects()`, return each entry's **`ProjectEntry.kind`** (`'illustration'` default, `'packaging'`) so the shell filters each dashboard correctly. (The shell does the filtering; you just provide the tag.)
3. Route `onActivate` to the correct editor by `dashboardKind`.

---

## 3. The editor (Frogmarks builds this) 🟦

```
Edit Package ▸                              ┌───────────────────────────┐
  Box style   [ Simple Box ▾ ]              │                           │
  Width   [ 80  mm ] ●                      │     3D box  (folds,       │
  Height  [ 60  mm ] ●                      │     live-textured)        │
  Depth   [ 40  mm ] ●                      │                           │
  Bleed   [ 3   mm ] ●                      └───────────────────────────┘
  ──────────────────────────────            ┌───────────────────────────┐
  [ ▶ Fold Preview ]  [ ↺ Unfold ]          │  Dieline canvas (draw)     │
  Fold ●─────────── (0..1 scrub)            │  + cut/fold/bleed guides   │
  ──────────────────────────────            └───────────────────────────┘
  Guides  ☑cut ☑fold ☑bleed
  Export  [ ↓ Dieline PNG ]
```

### On opening a packaging project
```ts
// Create (new) or restore (existing) the package, then size the document to the dieline + link a draw layer:
const p = sm.packaging!.create('simpleBox', { width: 80, height: 60, depth: 40 });
sm.setDocumentSize(p.canvasWidth, p.canvasHeight);     // the doc IS the dieline canvas (so artwork lands 1:1)
const layer = sm.addRasterLayer('Dieline');
sm.packaging!.setDielineLayer(p.id, layer.id);          // draw on this layer → shows on the box
```
> The persisted document carries the `params` (regenerate the box on load) + the dieline raster layer (the artwork). Restore = `create` with the saved params, then `setDocumentSize` + `setDielineLayer` to the restored layer.

### The procedural sliders (the character-creator parallel)
Every W/H/D/bleed control writes into one `DielineParams` object and calls `setDimensions` for a **live** rebuild:
```ts
params = { ...params, width: value };       // debounce ~40 ms like the Body sliders
sm.packaging!.setDimensions(p.id, params);  // net + box regenerate, current fold amount preserved
// the new p.guides + p.canvasWidth/Height are on sm.packaging!.get(p.id) — re-draw guides / resize if changed
```

### Drawing on the dieline
- Draw on the linked layer with the **normal raster tools** — it's live-textured onto the box.
- **Call `sm.syncLiveTextures3D()` on stroke-end** (pointer-up) so the box updates. (Wire this into your raster stroke-end hook.)
- Draw the **guide overlay** from `state.guides` (`DielineGuide[]`, canvas px): `type` ∈ `cut|fold|bleed|safeZone`, `segments` (line pairs), `color`. Toggle by type.

### Fold preview + export
```ts
sm.packaging!.fold(p.id);            // animate flat → folded (box closes, artwork folds with it)
sm.packaging!.unfold(p.id);
sm.packaging!.setFoldAmount(p.id, t);    // 0..1 scrub slider, no animation
const png = await sm.packaging!.exportDielinePng(p.id);   // Blob — download / send to print
```

---

## 4. `sm.packaging` API ✅ (engine, gated → may be `null`)

Always null-check: `sm.packaging?.…` (returns `null` when `PACKAGING_ENABLED` is off).

| Method | Description |
|---|---|
| `create(style, params, name?) → PackagingState` | Make the box (starts **flat**). `style` = `'simpleBox'` (more later). Adds a kraft-brown 3D mesh to the scene. |
| `setDimensions(id, params)` | Regenerate the net + box at new dimensions; preserves the current fold amount. The live-edit path. |
| `setFoldAmount(id, amount)` | `0` flat → `1` folded, no animation (scrub). |
| `fold(id, durationMs?)` / `unfold(id, durationMs?)` | Tweened fold/unfold (default 700 ms). |
| `setDielineLayer(id, layerId)` | Live-texture a raster layer (the dieline) onto the box. `clearDielineLayer(id)` removes it. |
| `exportDielinePng(id) → Promise<Blob \| null>` | The dieline canvas as a flat PNG. |
| `get(id)` / `getAll()` / `remove(id)` | State lookup / list / delete (unlinks + removes the mesh). |

```ts
interface DielineParams { width: number; height: number; depth: number; bleed?: number; dpi?: number; }  // mm
type BoxStyle = 'simpleBox';
interface PackagingState {
  id: string; meshId: string; style: BoxStyle; params: DielineParams;
  foldAmount: number;            // 0..1
  canvasWidth: number; canvasHeight: number;   // dieline canvas size (px) → set the doc to this
  guides: DielineGuide[];        // draw these as the cut/fold/bleed overlay
  panelLabels: Record<string,string>;
  dielineLayerId?: string;
}
interface DielineGuide { type: 'cut'|'fold'|'bleed'|'safeZone'; segments: [[number,number],[number,number]][]; color: string; }
```

---

## 5. Procedural parallel (so it feels like the rest of the creator)
| Character creator | Package Designer |
|---|---|
| `setBodyParams3D` (slider → regen) | `sm.packaging.setDimensions` (slider → regen) |
| presets (Tee / Crop) | box styles (`simpleBox` → tuck-end / mailer / sleeve, later) |
| paint in UV → mesh texture | draw the dieline → folds onto the box (the UV **is** the dieline) |

---

## 6. Status / TODO
- ✅ Salsa: shell app + dashboard + box cartridge; `sm.packaging.*` (create/setDimensions/fold/setFoldAmount/setDielineLayer/exportDielinePng); kraft-brown material; live-texture (reuses `LiveTextureMode`).
- 🟦 Frogmarks: doc tagging (`kind:'packaging'`) + `dashboardKind` routing + `createProject` for packaging; the editor panel + dieline canvas + guide overlay + sync-on-stroke + Fold Preview + export buttons; persist `params` + dieline layer and restore on load.
- 🔶 Not built (either side): more box styles (tuck-end/mailer/sleeve/pillow/lid+tray — spec Phase 8), print-ready **PDF** export (`exportPrintPdf`, needs a PDF lib — the candidate for lazy-loading the module), `exportFoldedRender`, the `.frogcart` order-submission flow (`httpRequest` action), keyframeable creases.

## 7. Caveats
- **Fold geometry is not yet visually verified** (built but un-rendered). If a panel folds the wrong way or a face shades inside-out, it's a winding/sign fix in `simpleBox`/`compileFoldMesh` — report it.
- **Dieline sizing:** the raster layer is document-sized, so set the doc to `canvasWidth × canvasHeight` for 1:1 artwork. Otherwise artwork stretches to the doc then maps via UV (still works, just not print-accurate).
- **Sync:** `syncLiveTextures3D()` must be called on stroke-end (not automatic).
- Box mesh is scaled mm × 0.02 → sane world units.
