# Face Artboard — click a 3D face to design its panel

**Status:** Not started (design only) — **post-MVP** for [packaging](./packaging-system.md), but the architecture is already shaped for it.
**Last Updated:** 2026-06-26
**Related:** [packaging-system.md](./packaging-system.md) (panels = the primary case), [uv-editor.md](./uv-editor.md) (UV islands + cross-highlight this builds on), [docs/ui/package-designer.md](../ui/package-designer.md).

## Vision

Click any **face** of a 3D object — the front of a packaging box, a side panel — and the 2D editor **focuses into that face as an artboard**, with the full Illustrator toolset (vector, text, layers, raster), and the result shows **live on the 3D box**. Design *the front of the box*, not "a region of a flat net."

This is the difference between a packaging *toy* and a packaging *tool*: designers think per-panel. It is **not** "paint a brush on a curved 3D surface" (that's the harder moonshot — see §7); the v1 is "**a click reframes the existing 2D editor onto the panel's region of the texture**," which reuses the entire editor and adds only a small bridge.

```
3D box ──click "Front" face──▶  2D editor framed on the Front panel's texture rect
   ▲                               (full vector/text/raster tools, panel outline overlaid)
   └──────────── live-texture ◀──── edits composite to the dieline layer ──┘
```

---

## What it reuses (this is mostly a bridge)

| Need | Already exists |
|------|----------------|
| Pick a 3D face from a click | `MeshPicker` → face index + barycentric (`pickFromClient3D`) |
| Which panel a face belongs to | the fold compiler knows it per-triangle (emit a `face → panelId` map — cheap) — or, for arbitrary meshes, **UV islands** (`computeUVIslands`, `EditMesh`) |
| Panel → a rect of the texture | each `FoldPanel.uvs` is a known UV region of the dieline canvas (axis-aligned rect for the simple box) |
| The "advanced editor" | the existing illustration editor (vector + text + raster + layers) |
| Edits appear on the box | `LiveTextureMode` (the dieline layer textures the box) — already wired for packaging |
| 3D↔2D correspondence highlight | `sm.setUVHoverFace3D` cross-highlight (UV editor Phase 7) |

So the **new** code is: (a) resolve a click → panel, (b) a "focus the 2D editor on a texture rect" mode, (c) a panel-boundary overlay, (d) navigation between panel / whole-dieline / 3D views.

---

## User flow

```
1. BOX VIEW          3D box (any fold). Hover a face → it highlights + shows the panel label.
2. click a face  →   resolve to a panel (front/back/left/right/lid…)
3. PANEL ARTBOARD    the 2D editor reframes onto that panel's texture rect:
                       • full Illustrator tools operate inside the panel
                       • the panel outline is drawn; neighbours dimmed (focus mask)
                       • a safe-zone/bleed guide from the dieline
                       • edits composite → dieline layer → live on the box
4. nav            →   [Whole dieline]  [3D box]  [next/prev panel]  back to box view
```

The flat dieline, the per-panel artboard, and the folded box are **three views of one document** — no separate files, no export/import. (The flat dieline is the box mesh at `foldAmount 0`; the panel artboard is a *framed sub-rect* of the same dieline canvas.)

---

## Technical design

### 1. Face → panel resolution
The fold compiler (`compileFoldMesh`) emits, alongside the geometry, **`panelRanges: { panelId: string; triStart: number; triCount: number }[]`** (panels are contiguous triangle runs). A picked face index → panel by range lookup. For non-packaging meshes, fall back to **UV islands** (the picked face's island).

```ts
sm.packaging.pickPanel(meshId, clientX, clientY): {
  panelId: string;
  label: string;                       // from panelLabels
  rectPx: [number, number, number, number];   // the panel's dieline-canvas rect (x,y,w,h)
} | null
```

### 2. "Focus panel" artboard mode
A general 2D-editor capability (not packaging-specific): frame the document view to a rect, with padding + a focus mask. It's a thin reuse of the existing 2D pan/zoom.

```ts
sm.focusArtboardRect(rectPx, opts?: {
  paddingFrac?: number;     // breathing room around the panel (default 0.12)
  maskOutside?: boolean;    // dim everything outside the rect (default true)
  outline?: boolean;        // draw the rect border (default true)
}): void
sm.exitArtboard(): void     // back to the full document
```

### 3. Panel-boundary overlay
While focused: draw the panel outline (its dieline polygon) + optionally the bleed/safe-zone guides from the dieline `guides`. Neighbours are dimmed so the panel reads as the artboard. Drawing is clipped to the panel? — **No** (let artwork bleed past the cut line into the bleed margin, as real print needs); the cut outline is just a guide.

### 4. The click bridge
```ts
// in the editor's 3D-click handler, when a packaging box is the target:
const hit = sm.packaging.pickPanel(boxMeshId, e.clientX, e.clientY);
if (hit) {
  sm.focusArtboardRect(hit.rectPx);
  // (optional) sm.setUVHoverFace3D(boxMeshId, …) to keep the 3D face highlighted
}
```

---

## API summary (proposed)

| Method | Description |
|---|---|
| `sm.packaging.pickPanel(meshId, x, y)` | Resolve a screen click to a panel (id, label, dieline rect) or null. |
| `sm.packaging.getPanels(id)` | List panels (id, label, rect) — for a "panel list" sidebar / prev-next nav. |
| `sm.focusArtboardRect(rectPx, opts?)` | Frame the 2D editor on a texture rect + focus mask + outline. (General; reusable for UV islands.) |
| `sm.exitArtboard()` | Return to the full document. |
| `compileFoldMesh` → `panelRanges` | (engine) per-panel triangle ranges, so a picked face → panel. |

Everything else (the design tools, the live-texture, the fold, export) is unchanged — the artboard is a **view**, not a new editor.

---

## Phases
1. **Face→panel plumbing** — `compileFoldMesh` emits `panelRanges`; `sm.packaging.pickPanel` (MeshPicker + range lookup). Hover-highlights the face + shows the label.
2. **Artboard focus** — `sm.focusArtboardRect` / `exitArtboard` (reframe the 2D view + focus mask + outline). Click a face → focus its panel; design with the full toolset; it shows on the box.
3. **Panel nav + guides** — prev/next panel, a panel list, per-panel safe-zone/bleed overlay, "whole dieline / 3D box" view toggles.
4. **(moonshot) Paint-on-3D** — see §7.

---

## Open questions
- **Vector/text → the box.** The box samples a flat texture, so vector/text **rasterize onto the dieline layer** to appear on the box (they stay editable in the doc; the box shows the composited raster). This is exactly how raster+vector compositing already works — confirm the dieline layer is the composite target.
- **Non-rectangular panels.** The simple box's panels are clean rects. Tuck-end/mailer flaps are angular → frame the panel's **bounding rect** + mask to the panel polygon. (Or, longer term, an unwrap so every panel is a tidy rect.)
- **2D/3D coexistence.** One canvas (see package-designer.md §Open-questions answer): the artboard is a framed view of the 2D document; the 3D box is the preview. A "split" (2D pane + 3D pane) is a host DOM choice, not a Salsa split-viewport.
- **Generality.** This wants to be **mesh-agnostic** — "click a face → focus its UV island" works for any UV-mapped mesh (reusing `computeUVIslands` + the UV-editor cross-highlight). Packaging panels are just islands the compiler labels for free. Worth building `focusArtboardRect` + the UV-island picker as core, with packaging supplying the nicer per-panel labels.

## §7 — The moonshot: paint directly on the folded 3D surface
Brush a stroke *on the curved box* (not the flat panel): `MeshPicker` → hit triangle + barycentric → interpolate UV → paint at that UV on the dieline layer. Already flagged as packaging-system.md's Phase-9 question. **Harder** (brush footprint distorts across the surface + at fold seams; needs UV-space dab projection). The §1–3 flat-panel-focus flow delivers ~90% of the value without it, so it stays deferred.
