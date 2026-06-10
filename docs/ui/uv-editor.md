# UV Editor UI — Frogmarks Integration Guide

**Last Updated:** 2026-06-10  
**Engine phases complete:** 1–9  
**Covers:** Opening the UV editor, all panel controls, cross-highlight wiring, live texture painting, UV export

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

// ── UV Texture Paint ──────────────────────────────────────────────────────
// The mesh owns its own per-mesh texture — no layer panel involvement.
// paintCanvas is a plain HTMLCanvasElement; draw strokes onto it with 2D context.
// UV [0,1] → texture pixel: px = u * paintCanvas.width, py = v * paintCanvas.height

const paintCanvas = sm.ensureUVPaintCanvas3D(meshId); // call once; reuse across strokes

// Pass it as the UV canvas background so the user sees their paint under the wireframe:
function redrawWithPaint() {
  const em = sm.getEditMesh3D(meshId);
  if (em) uvRenderer.draw(session, em, paintCanvas);
}

// Example: painting a dot on pointer-down in the UV canvas
uvCanvas.addEventListener('pointerdown', (e) => {
  if (!paintCanvas) return;
  const rect = uvCanvas.getBoundingClientRect();
  const [u, v] = uvRenderer.canvasToUV(e.clientX - rect.left, e.clientY - rect.top, session);
  const ctx2d = paintCanvas.getContext('2d')!;
  ctx2d.fillStyle = currentColor;  // your brush colour
  ctx2d.beginPath();
  ctx2d.arc(u * paintCanvas.width, v * paintCanvas.height, brushRadius, 0, Math.PI * 2);
  ctx2d.fill();
  redrawWithPaint();
});

uvCanvas.addEventListener('pointerup', () => {
  sm.commitUVTexture3D(meshId);  // upload CPU canvas → GPUTexture → mesh.diffuseTexture
});

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
sm.autoUnwrap3D(meshId): boolean                // smart project (triplanar)
sm.unwrapIslands3D(meshId): boolean             // per-island smart project
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

// ── UV Texture Paint (mesh-owned, no layer panel) ────────────────────────
sm.ensureUVPaintCanvas3D(meshId, size?): HTMLCanvasElement | null
  // Returns (creating if needed) a CPU HTMLCanvasElement as the mesh's texture.
  // size defaults to 1024.  Draw strokes on it: UV [0,1] → px = u*w, py = v*h.
  // Pass it as the texture arg of uvRenderer.draw() to show paint under wireframe.
sm.commitUVTexture3D(meshId): void
  // Uploads the CPU canvas → new GPUTexture → mesh.diffuseTexture.  Call on pointerup.
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
