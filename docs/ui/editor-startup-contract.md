# Editor Startup Contract — how Illustration boots, and how Packaging reuses it

**Last updated:** 2026-07-20.
**Why this exists:** the Packaging editor showed no 3D box because its Frogmarks route did NOT boot the renderer
the way the Illustration editor does. The fix is not new code — it's **reusing the exact illustration boot** and
adding one call. This doc is the authoritative host-side startup sequence (traced from `src/main.ts` +
`src/renderer/core/webgpu-renderer.ts` + `src/services/shape-manager.ts`).

> **Core truth:** the 3D scene renders **by default** (`scene3DVisible = true`, `webgpu-renderer.ts:364`) on the
> **same swapchain canvas** as the 2D document — *provided the renderer went through `initialize()` below.* A
> `Mesh3D` (the packaging box) added to the scene draws with **no extra host call**. Packaging's route was
> rendering only the 2D artboard because it never ran this boot.

---

## A. Illustration editor startup (the host call sequence)

The reference is `src/main.ts:startWebGPURendering()`. Ordered:

1. **Construct the renderer on the canvas** — `new WebGPURenderer(canvas, interactionService)`. (Binds
   pointer/wheel listeners to the canvas.)
2. **`await webgpuRenderer.initialize()`** — this is the whole WebGPU bring-up. It:
   - requests adapter + device (raised buffer limits), `canvas.getContext('webgpu')`, and
     `context.configure({ device, format: 'bgra8unorm', usage: RENDER_ATTACHMENT|COPY_DST, alphaMode: 'premultiplied' })`.
   - `setCanvasSize(device)` — sizes the pixel buffer to `getBoundingClientRect() × devicePixelRatio`, builds the
     world matrix + depth view.
   - installs a **`ResizeObserver` on the canvas** + a `window 'resize'` handler (both call `setCanvasSize`). ← see §C.
   - `play()` — starts the on-demand rAF loop (`scheduleRender()` sets `needsFrame`; a frame presents via
     `context.getCurrentTexture()`).
3. **Wire the scene stack** — `PipelineManager`, `BindGroupManager`, `CacheService` (`setPipelineManager`),
   `WebGPURenderStrategy` (`setWebGPURenderStrategy`), `new SceneGraph` (`setSceneGraph`).
4. **Create services + `ShapeManager.getInstance(...)`** — drawing services, then `addVectorLayer('Vector')`,
   ephemera overlay canvas + callbacks.
5. **Open a doc** — `shapeManager.restore*/load` → **`setDocumentSize(w, h)` exactly once** → `fitArtboard()`.
   (Infinite-canvas docs call `clearDocumentSize()` instead.)
6. **On navigation to a NEW canvas element** — `renderer.reinitialize(newCanvas)`: clears suspend, swaps the
   canvas, **rebinds every tool's listeners**, re-`getContext` + `configure`, `setCanvasSize`, `play()`. (Use
   this when the editor route mounts a fresh `<canvas>`.)

**That's the entire boot.** After step 5, any `Mesh3D` in the scene renders on the same canvas.

---

## B. Packaging = the same boot + ONE call

Packaging is **the illustration editor route with the packaging panel/overlay layered on top** — the user's
model, and literally correct. Do **not** build a separate flat-canvas page.

1. Run the **exact** illustration boot, steps 1–6 above (same `WebGPURenderer.initialize()`, same scene stack,
   same `ShapeManager`, same 3D pass). If the Packaging route mounts its own `<canvas>`, use `reinitialize`.
2. Create the box: `const p = sm.packaging!.create('simpleBox', { width, height, depth, bleed })`.
3. **`sm.packaging!.enterEditor(p.id, { layerId? })`** — the one packaging-specific call. It sizes the doc to the
   dieline, links the dieline layer as the box's live texture, starts flat, **forces `scene3DVisible = true` +
   frames + alt-orbits the box**, and arms 3D-surface painting. This is the ONLY thing an illustration doc
   doesn't already do.
4. Layer the packaging UI on top: the W/H/D/Bleed panel, the guide overlay (draw **all** `segments[]`), the fold
   slider/buttons, Export — all per [package-designer.md §3b](./package-designer.md).

**If you did step 1 correctly, the box is already on screen** (kraft-brown, framed) before you even touch the
packaging panel. If it's NOT visible, step 1 is incomplete — the route isn't running the illustration renderer
boot (most likely it mounted a canvas but never called `initialize()`/`reinitialize()`, or it's a different
ShapeManager instance than the one the box was created in).

### Quick sanity checks (browser console, on the packaging page)
- `sm.packaging.getAll()` → should list your box (`meshId`, `foldAmount`). Empty ⇒ `create` never ran / wrong SM instance.
- `sm.scene3DVisible` → must be `true`. False ⇒ `enterEditor`/`frameAndOrbit` didn't run.
- Scrub Fold: if `getAll()[0].foldAmount` changes but you see nothing, the **renderer boot (step 1) is the gap** —
  the mesh exists and folds, but no 3D pass is drawing to this canvas.

---

## C. The `setDocumentSize` thrash + "Destroyed texture used in a submit"

Symptom: `setDocumentSize` logs repeatedly with changing sizes (e.g. 2362→1654→1854→4240) + GPU errors
`Destroyed texture … used in a submit`.

**Root cause is a host-side feedback loop.** `setDocumentSize` does not touch `canvas.width/height`, but it
changes the artboard aspect; if the host re-lays-out the canvas *element* in response (or drives the doc size
from the container size), the renderer's canvas **`ResizeObserver` fires `setCanvasSize`**, the host re-reads the
new container size and calls `setDocumentSize` again → oscillation. Packaging worsened it because `enterEditor`
calls `setDocSize(dielineW, dielineH)` which then fights the host's own canvas sizing every frame.

**Host fix (required — this is the real fix):**
- Call `setDocumentSize` **once per doc-size intent** (on open, and on a W/H/D/bleed change). **Never** call it
  from a `ResizeObserver`/resize handler.
- Treat the **dieline size as the single source of truth** for the packaging doc; do not also derive it from the
  container element size. Let the canvas element fill its pane and let Salsa's `setCanvasSize` handle pixel
  sizing independently of the document size.

**Salsa hardening (done this session):** `RasterTextureManager.ensureTexture` no longer destroys the old doc
texture inline — it defers to `queue.onSubmittedWorkDone()`, so a mid-frame reallocation can't throw
"destroyed texture used in a submit." This stops the *crash*, but the host must still stop the *loop* (above) —
the deferral makes resizing safe, not free.
