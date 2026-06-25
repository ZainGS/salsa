# UV Editor UI — Frogmarks Integration Guide

**Last Updated:** 2026-06-15  
**Engine phases complete:** 1–9 + GPU UV paint  
**Covers:** Opening the UV editor, all panel controls, cross-highlight wiring, **GPU UV texture painting** (paint directly on the unwrapped UV *or the 3D mesh*; persists with the document), live texture linking, UV export

> **2026-06-15 updates:** (1) the unwrap auto-orienter now builds a **signed, world-up-aligned** tangent frame per island — side faces come out upright and **no longer mirrored** (the old `abs`-axis projection mirrored back/negative faces). Top/bottom faces have no natural "up" and fall back to a consistent orientation — paint those **directly on the 3D mesh**. (2) The orange **vertex handles are hidden in paint mode** (they only show during true mesh-editing). (3) The **UV pane is now optional** — call `enterUVPaintMode3D(meshId)` with no renderer to paint **only on the 3D mesh** (see "Hiding the UV pane"). (4) **`openUVEditor3D` now auto-unwraps on first open** when the mesh has no usable UVs (fresh primitive) — no "click Unwrap first" step. Imported/already-unwrapped meshes keep their layout (never clobbered). (5) **UV/mesh paint now shares the full 2D brush system** — the same brush presets, color picker, dynamics, and grain. Drop the mini color/size/erase controls and drop in your existing brush panel; the same `sm.*` brush APIs auto-route to the UV engine while paint mode is active (see "Reusing the 2D brush panel"). (6) **Focus background** — entering mesh edit / UV paint now shows a full-screen focus background (default 'wavy') that **hides the 2D illustration content** (raster + vector layers) for a clean workspace, same system + options as armature. Choose the style with `sm.setMeshEditBgMode3D(opts)` (reuse the `ARMATURE_BG_*` presets, or `{ mode: 'none' }` to keep the 2D layers visible). Note: the **ephemera overlay** (separate DOM canvas) is not hidden by this.

> **The "Unwrap Mesh" button is now safe to hide** from the paint panel — auto-unwrap-on-open covers the normal flow, so most users never need it. **Keep the `autoUnwrap3D` API**, though (it's what auto-unwrap calls): it's the escape hatch for the two rare cases the auto-path intentionally skips — (a) an **imported mesh whose UVs are present but bad** (auto-unwrap won't clobber existing UVs), and (b) **stale UVs after heavy topology edits**. Both are mesh-editing situations, so if you resurface a manual re-unwrap action, put it in the **mesh-edit panel**, not here.

All UV logic lives in the Salsa engine. Frogmarks provides the split-viewport layout, toolbar button, and panel UI. This doc describes every `ShapeManager` call the UI needs to make.

---

## Layout

The UV editor uses a **side-by-side split** (3D viewport left, UV canvas right) that activates when the user clicks "UV Editor" on a selected mesh. It is an **independent mode** — do not enter mesh-edit mode first.

```
┌─────────────────────┬─────────────────────┐
│  3D Viewport        │  UV Canvas          │
│  (existing WebGPU)  │  (new HTML canvas)  │
│                     │                     │
│  Seam edges = red   │  Checkerboard BG    │
│  Hover = cyan tint  │  Wireframe overlay  │
│                     │  Hover = orange     │
└─────────────────────┴─────────────────────┘
               UV Panel (right inspector)
```

The UV canvas is a standard `HTMLCanvasElement` driven by `UVCanvasRenderer`. It is **not** a WebGPU canvas — no device setup required.

The 3D viewport re-renders automatically while the UV editor is open (the render loop calls the data provider on every frame). You only need to manually trigger redraws on the **UV canvas** by calling `uvRenderer.draw(session, em)`.

---

## Entering and exiting UV edit mode

```typescript
// 1. Open the UV session.
//    auto-calls makeEditable3D if needed, activates the 3D seam/hover overlay,
//    and enables mesh-edit orbit on the camera. No enterMeshEditMode3D required.
const session = sm.openUVEditor3D(meshId);

// 2. Create the UV canvas renderer (one-time, bound to the HTML canvas element)
const uvRenderer = sm.createUVCanvasRenderer(uvCanvas);

// 3. Initial draw
const em = sm.getEditMesh3D(meshId);
if (em) uvRenderer.draw(session, em);

// ── On close ──
sm.closeUVEditor3D(meshId);  // restores camera; cleans up session + paint canvas
```

---

## Session state (read and write directly)

`openUVEditor3D` returns a `UVEditorSession` object. The UI reads and writes its fields, then calls `redraw()`:

```typescript
session.showWireframe       = true;   // toggle UV wireframe overlay
session.showIslands         = true;   // toggle island colour fills
session.showStretchOverlay  = false;  // toggle stretch/compression heatmap
session.islandHoverMode     = false;  // hover highlights whole island vs single face

// Pan and zoom (set directly, then redraw)
session.panU = 0.5;   // UV coord at canvas centre (default 0.5)
session.panV = 0.5;
session.zoom = 1.0;   // 1 = UV [0,1] square fills ~85% of shorter canvas axis

// Selection mode
session.selection.mode = 'face';  // 'vertex' | 'edge' | 'face'
```

Convenience helper used throughout:

```typescript
function redraw() {
  const em = sm.getEditMesh3D(meshId);
  if (em) uvRenderer.draw(session, em);
}
```

---

## UV canvas pointer events

Wire the UV canvas pointer events manually. The engine provides hit-test and selection helpers via the renderer:

```typescript
uvCanvas.addEventListener('pointermove', (e) => {
  const rect = uvCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // Find face under cursor, drive cross-highlight in both panes
  const fi = uvRenderer.hitTestFace(cx, cy, session, sm.getEditMesh3D(meshId)!);
  sm.setUVHoverFace3D(meshId, fi);  // 3D viewport cyan tint (schedules its own render)
  redraw();                          // UV canvas orange tint
});

uvCanvas.addEventListener('click', (e) => {
  const rect = uvCanvas.getBoundingClientRect();
  const em = sm.getEditMesh3D(meshId)!;
  const fi = uvRenderer.hitTestFace(e.clientX - rect.left, e.clientY - rect.top, session, em);
  if (fi !== null) {
    session.selectFace(fi, e.shiftKey);   // shift = additive
    redraw();
  }
});

uvCanvas.addEventListener('pointerleave', () => {
  sm.setUVHoverFace3D(meshId, null);
  redraw();
});

// Pan: drag with middle mouse or Alt+drag
// Zoom: wheel
uvCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  session.zoom = Math.max(0.1, Math.min(20, session.zoom * (1 - e.deltaY * 0.001)));
  redraw();
}, { passive: false });
```

---

## UV Panel layout

```
▸ UV EDITOR ──────────────────────────────────
  Selection  [Vertex] [Edge] [Face ●]

  [✓] Show wireframe
  [✓] Show islands
  [ ] Show stretch overlay
  [ ] Island hover mode

  ── Seams ─────────────────────────────────
  [Mark Seam]  [Clear Seam]  [Clear All Seams]
  [Suggest Seams]  angle threshold [60°  ──●──]

  ── Unwrap ────────────────────────────────
  [Smart Project]        all verts, triplanar box-project
  [Unwrap Islands]       per-island, uses each island's avg normal
  [Follow Active Face]   whole mesh projected from selected face's normal

  ── Layout ────────────────────────────────
  [Pack Islands]  margin [0.002  ──●──]

  ── Transform (acts on selection) ─────────
  Move    Δu [    ]  Δv [    ]  [Apply]
  Scale   su [    ]  sv [    ]  [Apply]
  Rotate  angle [    ] °        [Apply]
  [Mirror U]  [Mirror V]

  ── Weld / Split ──────────────────────────
  [Weld]  threshold [0.001  ──●──]
  [Split Edges]  (edge selection mode only)

  ── Pin ───────────────────────────────────
  [Pin Selected]  [Unpin Selected]  [Unpin All]

  ── Live Texture ──────────────────────────
  Layer  [▾ select raster layer]
  [Link]  [Unlink]

  ── Export ────────────────────────────────
  [Export UV Layout]  size [1024 ▾]  →  PNG download
```

---

## Wiring all panel controls

```typescript
// ── Selection mode tabs ────────────────────────────────────────────────────
vertexTabBtn.onclick = () => { session.selection.mode = 'vertex'; redraw(); };
edgeTabBtn.onclick   = () => { session.selection.mode = 'edge';   redraw(); };
faceTabBtn.onclick   = () => { session.selection.mode = 'face';   redraw(); };

// ── Display toggles ───────────────────────────────────────────────────────
wireframeCheck.onchange     = (e) => { session.showWireframe      = e.target.checked; redraw(); };
islandsCheck.onchange       = (e) => { session.showIslands        = e.target.checked; redraw(); };
stretchCheck.onchange       = (e) => { session.showStretchOverlay = e.target.checked; redraw(); };
islandHoverCheck.onchange   = (e) => { sm.setUVIslandHoverMode3D(meshId, e.target.checked); };

// ── Seams ─────────────────────────────────────────────────────────────────
markSeamBtn.onclick = () => {
  const sel = sm.getEditSelection3D(meshId);
  sm.markSeam3D(meshId, [...(sel?.edges ?? [])]);
  redraw();
};
clearSeamBtn.onclick    = () => { sm.clearSeam3D(meshId, [...(sm.getEditSelection3D(meshId)?.edges ?? [])]); redraw(); };
clearAllSeamsBtn.onclick = () => { sm.clearAllSeams3D(meshId); redraw(); };
suggestSeamsBtn.onclick  = () => { sm.suggestSeams3D(meshId, +thresholdSlider.value); redraw(); };

// ── Unwrap ────────────────────────────────────────────────────────────────
smartProjectBtn.onclick  = () => { sm.autoUnwrap3D(meshId);    redraw(); };
unwrapIslandsBtn.onclick = () => { sm.unwrapIslands3D(meshId); redraw(); };
followActiveBtn.onclick  = () => {
  // Use first selected face as the "active" face
  const fi = [...(session.selection.faces)][0];
  if (fi != null) { sm.followActiveFaceUV3D(meshId, fi); redraw(); }
};

// ── Layout ────────────────────────────────────────────────────────────────
packBtn.onclick = () => { sm.packUVIslands3D(meshId, +marginSlider.value); redraw(); };

// ── Transform ─────────────────────────────────────────────────────────────
moveApplyBtn.onclick   = () => { sm.moveSelectedUVs3D(meshId, +duInput.value, +dvInput.value);         redraw(); };
scaleApplyBtn.onclick  = () => { sm.scaleSelectedUVs3D(meshId, +suInput.value, +svInput.value);        redraw(); };
rotateApplyBtn.onclick = () => { sm.rotateSelectedUVs3D(meshId, +angleInput.value * Math.PI / 180);    redraw(); };
mirrorUBtn.onclick     = () => { sm.mirrorSelectedUVs3D(meshId, 'u'); redraw(); };
mirrorVBtn.onclick     = () => { sm.mirrorSelectedUVs3D(meshId, 'v'); redraw(); };

// ── Weld / Split ──────────────────────────────────────────────────────────
weldBtn.onclick  = () => { sm.weldSelectedUVs3D(meshId, +weldThreshInput.value); redraw(); };
splitBtn.onclick = () => { sm.splitSelectedUVs3D(meshId); redraw(); };

// ── Pin ───────────────────────────────────────────────────────────────────
pinBtn.onclick      = () => { sm.pinSelectedUVs3D(meshId);   redraw(); };
unpinBtn.onclick    = () => { sm.unpinSelectedUVs3D(meshId); redraw(); };
unpinAllBtn.onclick = () => { sm.unpinAllUVs3D(meshId);      redraw(); };

// ── UV Texture Paint (GPU brush — paint directly on the unwrapped UV) ───────
// Salsa owns the whole interaction: it attaches pointer listeners to the UV
// canvas, maps screen → UV → texel, brushes the mesh's own texture with the GPU
// brush engine, updates the 3D mesh LIVE (same texture reference), and redraws
// the UV pane itself (your paint shows under the wireframe). Frogmarks only
// toggles the mode and pushes brush settings — no hand-rolled 2D drawing.

// ── RECOMMENDED: auto-start painting on editor open (no "Start Painting" button) ──
// The UV Editor's only feature is painting, so just enter paint mode when the editor
// opens and exit when it closes. `enterUVPaintMode3D` is a complete one-call bootstrap
// (self-opens the session, auto-unwraps a fresh mesh, wires pane + 3D-mesh input), so
// you do NOT need a button OR a separate openUVEditor3D call. Brush controls stay
// permanently visible. Navigation while painting: alt/middle-drag orbit, right-drag pan.
function openUvEditor(meshId, showPane) {
  sm.enterUVPaintMode3D(meshId, showPane ? uvRenderer : null, DEFAULT_BRUSH);
}
function closeUvEditor(meshId) {
  sm.closeUVEditor3D(meshId);   // already calls exitUVPaintMode3D — painting stops on close
}

// ── ALTERNATIVE: explicit Paint toggle (only if you want left-drag to orbit when off) ──
// `enterUVPaintMode3D` self-opens the UV session and makes the mesh editable if needed,
// so you still don't have to call openUVEditor3D first — important for the pane-hidden
// case where you never created a renderer.
paintToggle.onclick = () => {
  if (sm.isUVPaintActive3D(meshId)) {
    sm.exitUVPaintMode3D();
    resumeUvPaneLoop();              // re-enable your own pane redraw + hover handlers
  } else {
    pauseUvPaneLoop();               // Salsa drives the pane while painting — see note
    sm.enterUVPaintMode3D(meshId, uvRenderer, {
      color: { r: 0.1, g: 0.1, b: 0.12, a: 1 },  // 0–1 per channel
      radius: 16,                                  // brush radius in UV-pane SCREEN pixels
      opacity: 1,
      erase: false,
    });
  }
};

// Brush controls — DEPRECATED mini path. setUVPaintBrush3D still works (color/erase;
// `radius` is now ignored — size comes from the active preset), but prefer the shared
// 2D brush panel below.
colorPicker.oninput   = () => sm.setUVPaintBrush3D({ color: hexToRgba01(colorPicker.value) });
eraseToggle.onclick   = () => sm.setUVPaintBrush3D({ erase: eraseToggle.checked });
```

### Reusing the 2D brush panel (recommended)

UV/mesh paint now uses the **same brush engine state** as 2D raster drawing — the
full preset library, color picker, dynamics, color-jitter, and grain. So the right UI
is your **existing brush panel**, not a bespoke one.

**How it works:** the UV painter keeps its own engine (so the mesh texture's undo stays
isolated), and at the **start of every stroke** Salsa mirrors the *live* 2D brush — the
active preset, color, and erase mode — from the illustration engine onto it. So your
brush panel just drives the normal 2D engine exactly as it does for raster layers, and
whatever it sets shows up on the mesh. **This is deliberately independent of *how* your
brush UI reaches the engine** (directly, or via `sm.*` APIs) — it reads the 2D engine's
resulting state per stroke, so there's nothing to route and no UV-specific brush state
to manage.

**Frogmarks change:** drop your existing brush-options component into the UV editor
panel and delete the mini brush section. Nothing else — it already drives the brush
engine through the shared service.

```html
<!-- UV editor panel: replace the mini Brush section with your real brush panel -->
<app-brush-options [activeRasterTool]="'brush'"></app-brush-options>
```

> **Brush size** is now the brush's real texel size (like 2D), not a screen-px value —
> simpler and consistent across the UV pane and the 3D mesh. **Stabilization** is
> whatever the chosen brush defines (same as 2D); the old forced "no stabilization" hack
> is gone, so a stabilized brush will "catch up" on mouse-up exactly as it does on a 2D
> layer. Verify that feels right on a live build.

> **Eraser** restores the **blank base (white)**, it does not erase to transparent — a
> mesh diffuse is opaque, so a transparent texel would render *black*. The eraser keeps
> its preset's shape/softness; it just paints the base colour. (It can't restore an
> imported base texture — only the white clear.) **Painting across a face edge** on the
> 3D mesh breaks the stroke at the UV seam (adjacent faces are distant islands in the
> atlas, so a continuous line there would streak across other islands). Expect a thin
> unpainted sliver right at the seam — there's no cross-seam bleed/dilation yet.

### Hiding the UV pane (paint on the mesh only)

The unwrapped UV layout rarely places a face's neighbours next to it, so for most
texturing the **3D mesh is the more intuitive surface to paint on**. The UV pane is
best kept as an **opt-in** secondary view (whole-texture overview, precise island
work). Recommended default: **pane hidden**, with a `[ ] Show UV Pane` checkbox.

`enterUVPaintMode3D`'s renderer argument is **optional**. Pass it only when the pane
is visible; omit it (or pass `null`) when hidden — painting on the 3D mesh still works
and the engine skips the per-stroke pane readback entirely:

```typescript
// Pane hidden → 3D-mesh painting only (no pane wiring, no readback cost):
sm.enterUVPaintMode3D(meshId, null, brushOpts);

// Pane shown → both views wired and kept in sync:
sm.enterUVPaintMode3D(meshId, uvRenderer, brushOpts);
```

Toggling the checkbox while paint mode is active is just an exit + re-enter with the
new argument:

```typescript
showUvPaneCheck.onchange = (e) => {
  uvPaneEl.hidden = !e.target.checked;
  if (sm.isUVPaintActive3D(meshId)) {
    sm.exitUVPaintMode3D();
    sm.enterUVPaintMode3D(meshId, e.target.checked ? uvRenderer : null, currentBrushOpts);
  }
};
```

> **Dual-input — paint on the 3D mesh too.** While paint mode is active, the user
> can also **brush directly on the model in the 3D viewport** (left-drag paints,
> alt-drag orbits, middle/right pans). Salsa raycasts each hit to a UV coordinate
> and paints the **same** texture, so the 3D mesh and the UV pane stay in sync. No
> extra wiring — `enterUVPaintMode3D` sets this up automatically (`exit` tears it
> down). The 3D-paint brush uses the same texel size as the current UV-pane brush.

> **⚠ While paint mode is active, Salsa fully owns UV-canvas input.** The controller
> attaches **capture-phase** listeners and `stopImmediatePropagation`s the events it
> handles (left-button paint, hover, left-click), so your own pointer/hover/click
> handlers on that canvas **never fire** — you do **not** need `isUVPaintActive3D`
> guards. **Middle/right-drag and wheel pass through**, so the host can still
> pan/zoom the pane while painting. Salsa also **redraws the pane** after every dab
> and on hover, so **don't redraw the pane yourself while paint mode is active**
> (it would briefly overwrite the live paint until the next dab). The brush radius is
> in **UV-pane screen pixels** (constant on screen at any zoom). The painted texture
> is the mesh's diffuse and **persists with the document** (`meshTextures/{meshId}.png`).

### Concepts — three different things people confuse

| Tool | What it does | Paints the texture? |
|------|--------------|---------------------|
| **UV Texture Paint** (above) | Brush directly on the unwrapped UV → the mesh's own texture, live | ✅ This is texture painting |
| **Link Illustration Layer** (below) | Maps a 2D raster *layer* onto the mesh diffuse; you paint on the separate illustration canvas | ✅ but you paint *blind* (no UV reference) |
| **Pinning** | **Unwrap** control — fixes UV vertices so re-unwrapping solves around them. Anchors island position/scale | ❌ Unrelated to painting |

```typescript
// ── Live Texture (raster layer sync — alternative to UV paint) ────────────
linkLayerBtn.onclick = () => {
  const layerId = layerSelect.value;
  if (layerId) sm.linkLiveTexture3D(meshId, layerId);
};
unlinkBtn.onclick = () => sm.unlinkLiveTexture3D(meshId);

// After every raster stroke ends, push the layer's GPU texture to the mesh:
rasterCanvas.addEventListener('pointerup', () => {
  sm.syncLiveTextures3D();  // zero-copy: writes layer GPUTexture → mesh.diffuseTexture
});

// ── Export ────────────────────────────────────────────────────────────────
exportUVBtn.onclick = () => {
  const size = +sizeSelect.value || 1024;
  const canvas = sm.exportUVLayout3D(meshId, size, size);
  if (!canvas) return;
  const a = document.createElement('a');
  a.href     = canvas.toDataURL('image/png');
  a.download = 'uv-layout.png';
  a.click();
};
```

---

## Complete ShapeManager API reference

All UV-related methods on `ShapeManager` (`sm`):

```typescript
// ── Session lifecycle ─────────────────────────────────────────────────────
sm.openUVEditor3D(meshId): UVEditorSession      // open; auto-makeEditable if needed
sm.closeUVEditor3D(meshId): void                // close; session is discarded
sm.getUVSession3D(meshId): UVEditorSession | null
sm.createUVCanvasRenderer(canvas): UVCanvasRenderer
sm.exportUVLayout3D(meshId, width?, height?): HTMLCanvasElement | null

// ── Seams ─────────────────────────────────────────────────────────────────
sm.markSeam3D(meshId, halfEdgeIndices): boolean
sm.clearSeam3D(meshId, halfEdgeIndices): boolean
sm.clearAllSeams3D(meshId): boolean
sm.suggestSeams3D(meshId, thresholdDeg?): boolean   // default 60°

// ── Unwrap ────────────────────────────────────────────────────────────────
sm.autoUnwrap3D(meshId): boolean                // one-click auto: seam-by-angle → unwrap islands → pack
                                                //   (hard edges become separate packed islands; a cube → 6 squares)
sm.unwrapIslands3D(meshId): boolean             // per-island smart project (no auto-seam/pack)
sm.followActiveFaceUV3D(meshId, faceIndex): boolean
sm.packUVIslands3D(meshId, margin?): boolean    // default margin 0.002

// ── Transform (operate on current UV selection) ───────────────────────────
sm.moveSelectedUVs3D(meshId, du, dv): boolean
sm.scaleSelectedUVs3D(meshId, su, sv): boolean
sm.rotateSelectedUVs3D(meshId, angleRad): boolean
sm.mirrorSelectedUVs3D(meshId, axis: 'u'|'v'): boolean

// ── Weld / Split ──────────────────────────────────────────────────────────
sm.weldSelectedUVs3D(meshId, threshold?): boolean   // default 0.001
sm.splitSelectedUVs3D(meshId): boolean               // edge mode only

// ── Pin ───────────────────────────────────────────────────────────────────
sm.pinSelectedUVs3D(meshId): void
sm.unpinSelectedUVs3D(meshId): void
sm.unpinAllUVs3D(meshId): void

// ── Cross-highlighting ────────────────────────────────────────────────────
sm.setUVHoverFace3D(meshId, faceIndex | null): void  // also schedules 3D render
sm.setUVIslandHoverMode3D(meshId, enabled): void

// ── UV Texture Paint (GPU brush — recommended) ───────────────────────────
sm.enterUVPaintMode3D(meshId, uvRenderer?, opts?): void
  // Attach the GPU brush. opts: { color?, radius?, opacity?, erase? }.
  // uvRenderer present → paint on the UV pane AND the 3D mesh (Salsa owns pane input
  //   + redraws the pane; pause your own pane loop while active).
  // uvRenderer omitted/null → paint on the 3D mesh only (pane hidden); no readback cost.
sm.exitUVPaintMode3D(): void                       // keeps the painted texture on the mesh
sm.setUVPaintBrush3D({ color?, radius?, opacity?, erase? }): void
  // color 0–1 per channel; radius in UV-pane SCREEN px; opacity 0–1.
sm.isUVPaintActive3D(meshId?): boolean
sm.getUVPaintTexture3D(meshId): RasterTextureManager | null   // backing texture (persistence)

// ── UV Texture Paint — CPU prototype (DEPRECATED; use the GPU brush above) ─
sm.ensureUVPaintCanvas3D(meshId, size?): HTMLCanvasElement | null  // @deprecated
sm.commitUVTexture3D(meshId): void                                 // @deprecated
sm.shareUVTexture3D(sourceMeshId, targetMeshIds: string[]): void
  // Copy diffuseTexture reference from source to all targets — zero GPU cost.
  // Call after commitUVTexture3D to stamp one painted texture onto N similar meshes.
  // Must re-call after each repaint (commitUVTexture3D creates a new GPUTexture each time).

// ── Live Texture (raster layer sync) ─────────────────────────────────────
sm.linkLiveTexture3D(meshId, layerId): void      // link raster layer as diffuse
sm.unlinkLiveTexture3D(meshId): void
sm.syncLiveTextures3D(): void                    // call on stroke-end/pointerup
sm.isLiveTextureLinked3D(meshId): boolean
sm.getLiveTextureLayerId3D(meshId): string | null

// ── Island query ─────────────────────────────────────────────────────────
sm.getUVIslands3D(meshId): UVIsland[]
```

All undoable operations (unwrap, transform, weld, split, seams) push onto the standard 3D undo stack. Use `sm.undo3D()` / `sm.redo3D()` as normal.

---

## Imported GLTF meshes

GLTF/GLB meshes that have `TEXCOORD_0` data automatically get `vertex.uv` populated when `openUVEditor3D(meshId)` is called (it calls `makeEditable3D` internally, which now copies UV from the vertex buffer). No extra step needed — open the UV editor and the original UV layout appears in the canvas immediately.

If UVs look wrong or a mesh was made editable before this fix, run `sm.autoUnwrap3D(meshId)` or `sm.unwrapIslands3D(meshId)` → `sm.packUVIslands3D(meshId)` to regenerate from scratch.
