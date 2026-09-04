# Textured Artboard + Transparent PNG Export — Frogmarks host integration

The 2D illustration shown **on the artboard plane in 3D-Free** (so you can arrange 3D objects against your art), plus a **transparent PNG export** of the illustration. Engine spec: `docs/specs/textured-artboard.md`. APIs on `ShapeManager` (`sm`).

## Textured artboard (illustration × free3D)

Automatic — no wiring needed to *show* it. On entering illustration × free3D the engine captures the 2D illustration (raster + vectors + ephemera, transparent) and draws it on the artboard plane. Default **on**; persisted in the view state.

**Toggle** (optional UI — a checkbox next to the artboard-frame toggle):
```ts
sm.setArtboardTextured3D(on: boolean): void   // default true; persisted (viewState.showArtboardTexture)
sm.isArtboardTextured3D: boolean
```

### ⚠️ Requires the 3D Scene layer to be ACTIVE (host action)

The whole free3D 3D view — orbit camera + the `scene3DVisible` 3D pass (meshes, grid, **and this quad**) — is only live when the **"3D Scene" layer is the active/selected layer**. On a fresh load into free3D nothing 3D renders until that layer is selected. **Host fix:** when switching to illustration × free3D, **auto-activate the 3D Scene layer** (select it / ensure `scene3DVisible` + the orbit camera are live) so the 3D view isn't dormant. This affects *all* 3D-in-free3D, not just the quad.

## Transparent PNG export

```ts
const blob = await sm.exportIllustrationTransparentPNG(maxSize?);   // default maxSize 2048
```

Returns a **transparent-background PNG** of the illustration at artboard framing — raster + vector shapes + ephemera, with real alpha (empty/no-background areas are transparent; anti-aliased edges are clean). Unlike `captureDocumentBoundsToBlob` (which bakes in the opaque canvas background), this is the see-through asset export (stickers, overlays, layered art).

- Frames the artboard automatically and restores the user's view afterward — no flicker (the capture never presents to the screen).
- **Best run from a 2D camera mode** (2D Ortho/Perspective). It renders the 2D content with a transparent clear; the raster+vectors layer needs the 2D content live (in free3D the 2D composite is hidden by the workspace backdrop, so a from-free3D export would carry only ephemera). Wire the "Export transparent PNG" action to switch to a 2D mode first, or expose it only in 2D modes.

Example host action:
```ts
async onExportTransparentPng() {
  const blob = await this.sm.exportIllustrationTransparentPNG();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'illustration.png'; a.click();
  URL.revokeObjectURL(url);
}
```

## Notes

- Ephemera are composited from a DOM-overlay rasterization (they're not in the WebGPU frame); already-displayed ephemera composite synchronously — a just-added one may need one more frame for its SVG to load.
- The quad shows **2D content only** (raster+vectors+ephemera), never your 3D meshes — those are already visible as real 3D.
