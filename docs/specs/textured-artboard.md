# Textured Artboard — see your 2D illustration in 3D-Free (spec + to-do)

**Date:** 2026-09-01 · **Status:** Phase-1 core BUILT (capture + PNG export + 3D quad + toggle), browser-verified · **Parent:** `free-camera-and-scene-targets.md` (§3, illustration × free3D) · **Home:** engine (renderer-3d / gizmo-renderer + scene3d-manager)

## One line

In **illustration × 3D-Free**, draw the 2D illustration as a **textured quad on the artboard plane** (z=0, at the artboard bounds) so you can arrange 3D objects *against your 2D art* — instead of an empty dark void + an outline. Toggleable; off falls back to the outline-only frame we ship today.

## ⚠️ GOTCHA — free3D 3D-view is dormant until the "3D Scene" layer is ACTIVE

**In illustration × free3D, the entire 3D render (the free3D orbit camera + the `scene3DVisible` 3D pass) is only live when the "3D Scene" layer is the SELECTED/active layer.** On a fresh load into free3D, nothing 3D renders — no meshes, no grid, no artboard-texture quad — until you click the 3D Scene layer in the Layers panel. Symptoms while it's dormant: black free3D viewport; or the camera is stale so 3D content sits fixed and doesn't pan/orbit with the view. Selecting the 3D Scene layer flips `scene3DVisible` + activates the orbit camera, and everything snaps correct.

This is **host-managed** (Frogmarks drives `scene3DVisible` off the 3D-Scene layer eye and activates the 3D editing context on layer selection) — NOT a bug in this feature. When debugging "my 3D thing doesn't show in free3D," **select the 3D Scene layer first.** Fix relayed to Frogmarks: *on entering illustration × free3D, auto-activate the 3D Scene layer* so the 3D view is live without a manual click. (A Salsa-side force — `setCameraMode3D('free3D')` asserting `scene3DVisible`+orbit — is possible but risks fighting the host's layer model; deferred.)

## Why

Illustration × free3D exists so you can place/adjust 3D objects in the context of a 2D piece (the "viewport vs render" split). But today the 2D composite is hidden (clean 3D workspace), so with no 3D objects yet you get a dark void, and even with objects you can't align them to your drawing because the drawing isn't visible. The artboard **outline** shows *where* the frame is, not *what's in it*. This spec fills the frame with the art.

## The texture-source problem (why this isn't a one-liner)

There is **no single existing texture that holds the full 2D illustration**:

- **Raster layers** → composited into `webgpuRenderer.rasterTexture` (has alpha). ✅ in a texture.
- **Vector shapes** (rectangles, notes, balloons, scribbles, the whole Boards lineage) → drawn live in a separate 2D pass (`drawVectorShapes`). ❌ never in a texture.
- **Ephemera** → separate overlay. ❌ never in a texture.

So "just sample `rasterTexture` on the quad" shows a **blank quad for a vector-based illustration** (the common case). The art has to be **rendered to a texture** first. Two ways to get that texture, phased:

---

## Phase 2 (v1, ship first) — capture the composited frame

Reuse the existing thumbnail-capture machinery (`webgpuRenderer.lastFrameTex` + `snapshotRegion…`), which already holds the **full composited 2D image (raster + vectors + ephemera)** whenever the app is in a 2D camera mode.

**Flow:**
1. On **entering illustration × free3D** (or toggling the feature on), while the last 2D frame is still valid — or via a one-shot fit-to-artboard 2D render — copy the **artboard region** of `lastFrameTex` into a dedicated `_artboardTex` (an `rgba8unorm` GPUTexture at a capped artboard resolution).
2. Each 3D frame, draw a **textured quad** at the artboard rect (`±halfW, ±halfH, z=0`) sampling `_artboardTex`, alpha-blended, **depth-tested + depth-write** so 3D objects correctly occlude / are occluded by the art plane.
3. **Re-capture on each free3D entry.** 2D content can't change *while* you're in free3D (2D tools are hidden), so one capture per entry is always fresh — no per-frame re-render cost.

**Pipeline:** a small textured-quad pass mirroring `gizmoRenderer.drawArtboardFrame` (same camera-VP uniform + artboard rect), but pos+uv geometry and a texture/sampler bind group instead of the line pipe. Draw it in the 3D pass right after `drawArmatureBg` (the #0D0D0D backdrop), before/with the meshes.

**Toggle + persistence:** `sm.setArtboardTextured3D(on)` → `viewState.showArtboardTexture` (default **true** for the illustration target). Host adds a checkbox next to the existing artboard-frame toggle. Persisted with the rest of the view state.

### ⚠️ Phase 2 limitation — NO transparency (this is the key trade-off)

`lastFrameTex` is the **final composited screen frame** — your art *over the opaque canvas backdrop*. There is no alpha to recover. So:

- An illustration with **"no background color"** captures as **lines-on-dark**, not lines-on-transparent.
- The quad is therefore an **opaque rectangle** of your art. Good for "see and align to my drawing"; **not** good for a floating-lines look or a transparent corner preview.

Phase 2 delivers *"my art, positioned in 3D"* — opaque. Transparency needs Phase 1.

---

## Phase 1 (CHOSEN — building this) — transparent capture + composite

Render the 2D **content** to a transparent RGBA image ourselves, so we control alpha, framing, and export. Includes **raster + vectors + ephemera** via a compositing step (ephemera live on a DOM overlay, not the GPU frame — see below).

### Architecture reality (from the render-path mapping)

- **Vector shapes bake the view matrix per-instance** at upload time (`ShapesRenderUniformCache.getShapeUniformData` writes `interactionService.getWorldMatrix()` into each record). There is no single projection uniform to swap. → To reframe them we set the VIEW to fit-the-artboard and re-render; the normal per-frame uniform upload then bakes the fit matrix. No shader changes.
- **Ephemera are a DOM/SVG overlay** (`EphemeraOverlay._renderEphemeraOverlay`), NOT in the WebGPU frame. → They can't be captured by a GPU readback; we **rasterize the overlay and composite** it (same pattern the packaging system already uses for vector proxies).
- No existing offscreen-2D-render helper exists; `lastFrameTex` + `snapshotRegion` is the reusable capture machinery.

### Flow (`captureArtboardImage`)

1. **Save** pan/zoom. **Set** the view to fit-the-artboard (maximizes artboard pixels in the frame). `updateWorldMatrix`.
2. Render one frame in **capture mode** (flags on `render()`): **transparent clear** (`{0,0,0,0}`), **skip** the artboard checker pattern, **skip the 3D mesh pass** (the quad shows 2D content only — 3D objects are already visible as real 3D), and **do NOT present** to the swapchain (so the screen never flickers). The normal draw path runs, so raster + vectors render with the fit matrix.
3. **Read back** the artboard region of `lastFrameTex` → RGBA (transparent where empty).
4. **Composite ephemera:** render `EphemeraOverlay` at artboard framing onto a transparent 2D `OffscreenCanvas`, draw the GPU readback under it (source-over) → one transparent RGBA canvas with **raster + vectors + ephemera**.
5. **Restore** pan/zoom; re-upload uniforms for the next on-screen frame.

Capture runs **once per free3D entry** (2D can't change while in free3D), so the readback/composite cost is a non-issue.

### Feeds two things

- **3D preview quad:** upload the composited canvas → `_artboardTex` (GPUTexture) → the textured quad (§Rendering details).
- **Transparent PNG export:** `canvas.toBlob('image/png')`. For crisp export, capture at the artboard's native pixel size (`_explicitDocPixelSize`) instead of canvas res.

### Corner live-preview (north-star, later)

Once the composited transparent texture exists, a screen-space HUD quad docked in a corner showing the render-camera output, re-captured on 2D-content change, is a thin layer on top.

### Unlocks: the corner live-preview (the north-star this enables)

Once Phase 1 gives an **alpha-correct, live** illustration texture, a **picture-in-picture** becomes trivial: a small **screen-space HUD quad** docked in a corner of the viewport, always showing the **render-camera (artboard) output**, updated live as you move 3D objects in free3D. So while you compose in 3D, you see the actual 2D result — with transparency — in the corner. This is the "little front-view live preview" goal, and it's a thin feature on top of Phase 1 (a fixed-position quad + the live texture; no new render logic).

---

## Rendering details (shared by both phases)

- **Quad geometry:** two triangles at `(-halfW,-halfH,0)…(halfW,halfH,0)`, UVs `(0,0)…(1,1)` (y-flip to match texture orientation). `halfW/halfH` from `getIllustrationBounds()` (same source as the outline).
- **Blend:** standard alpha (`src-alpha / one-minus-src-alpha`). Phase 2 alpha is all-1 (opaque); Phase 1 carries real alpha.
- **Depth:** `less-equal` + **depth write on**, so the art plane participates in occlusion (3D objects in front draw over it, objects behind are hidden). Draw before meshes, or in the opaque batch.
- **Draw site:** `renderer-3d` gains `setArtboardTexture(visible, halfW, halfH, texture, opacity)` + `drawArtboardTextureIfActive(pass)`, called beside `drawArtboardFrameIfActive`. `scene3d-manager._applyArtboardFrame()` sizes/enables it from the view rules (gated on `illustration && free3D && showArtboardTexture`).

## Toggle / API / persistence

```ts
sm.setArtboardTextured3D(on: boolean): void   // viewState.showArtboardTexture; default true (illustration)
sm.isArtboardTextured3D(): boolean
// host: checkbox next to the artboard-frame toggle, visible only in illustration × free3D
```

## Testing

Browser-gated (it's a visual). Unit-testable pieces: the quad position/UV math and the artboard-rect sizing from bounds (mirror the existing artboard-frame math). The capture + pipeline + alpha behaviour are verified in-browser.

## Phasing summary

- **Phase 1 (BUILT):** fit-view transparent capture (render() `_captureMode`) → straight-alpha (un-premultiplied) canvas. Feeds: the **transparent PNG export** (`sm.exportIllustrationTransparentPNG`), and the **free3D artboard quad** (`captureArtboardToTexture` → `copyExternalImageToTexture` → straight-alpha quad). **Ephemera composited** into both (rasterized from the DOM overlay via `EphemeraOverlay.rasterizePlacements` + the renderer's `setArtboardEphemeraCompositor` hook). Toggle `sm.setArtboardTextured3D` persisted in `viewState.showArtboardTexture`. Host doc: `docs/ui/textured-artboard.md`. **Browser-verified 2026-09-02:** quad shows raster + vectors + ephemera (barcode) upright & transparent, and a 3D mesh occludes it correctly.
- **Phase 1+ (north-star, NOT built):** the **corner live-preview HUD** (PiP of the artboard/render-camera output docked in a corner while editing in 3D) — a thin screen-space-quad layer on top of the existing capture.
- **Known nuances:** the export is best run from a 2D camera mode (from free3D the 2D composite is hidden → base would be ephemera-only); the free3D 3D view (incl. the quad) requires the 3D Scene layer active (host auto-activation relayed to Frogmarks — see the GOTCHA at top).
