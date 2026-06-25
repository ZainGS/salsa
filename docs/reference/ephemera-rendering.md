# Ephemera: What They Are and How They Render

## What Is an Ephemera?

Ephemera are procedurally generated SVG graphic elements — barcodes, globe wireframes, crosshairs, warning labels, serial strings, motion lines, registration marks, waveforms, geometric frames, and star/sparkle clusters.

Each ephemera type is a **generator**: a pure, synchronous TypeScript class that takes a parameter record and returns an SVG string. There are no assets on disk. Every barcode, globe, or crosshair is computed fresh from its parameters on demand.

```
params → IEphemeraGenerator.generate(params) → SVG string
```

Generators are registered in `EphemeraService` and accessed by `typeId`. The UI shows categories of generators, lets users configure parameters, and previews the live SVG output before placing it.

---

## The Two Render Pipelines

Ephemera can enter the document in two ways: **destructive stamp** (Phase 1/2) and **non-destructive placement** (Phase 3).

### Destructive Stamp (Phase 1/2)

The user picks a generator, configures it, and presses "Stamp to Layer." The SVG is rasterized and permanently painted into a raster layer's GPU texture.

```
SVG string
  → Blob (image/svg+xml)
  → createImageBitmap({ resizeWidth, resizeHeight })   ← browser SVG rasterizer
  → OffscreenCanvas drawImage()
  → copyExternalImageToTexture()                        ← into layer's WebGPU texture
```

This is identical to the `mergeLayerDown` path used elsewhere in the renderer. After stamping, the ephemera has no separate existence — it is pixels. Undo restores the pre-stamp snapshot.

Multiple placements in a single pass use `compositeMultipleImagesOntoLayer`: one OffscreenCanvas receives all placements drawn in sequence (with per-placement `ctx.translate/rotate` for rotation), then a single `copyExternalImageToTexture` and a single undo snapshot.

### Non-Destructive Placement (Phase 3)

The user places an `EphemeraPlacement` on an ephemera layer. The placement record stores the type, parameter snapshot, position, size, rotation, opacity, and a cached SVG string. Nothing is written to any GPU texture until the user explicitly rasterizes.

```typescript
interface EphemeraPlacement {
  id, layerId, typeId,
  params,       // parameter snapshot — re-generate SVG any time
  svg,          // cached at placement time
  x, y, width, height,
  rotation,     // degrees
  opacity,      // 0–1
  visible,
}
```

The vector layer entry (`type: 'vector'` in the layer stack) is a **marker** — it has no GPU texture and is excluded from the WebGPU compositor. Placements are rendered by a 2D overlay canvas drawn every frame on top of the WebGPU canvas.

To make placements permanent, `rasterizeEphemeraLayer()` runs the same stamp pipeline as Phase 1/2 — all placements composited in one OffscreenCanvas pass at document resolution — and writes the result into a target raster layer.

---

## How Ephemera Differ From Scene Graph Shapes

| | Ephemera | Scene Graph Shapes |
|---|---|---|
| **Source format** | SVG string (procedural generator) | GPU geometry (triangles, paths) |
| **Render path** | Browser SVG engine → OffscreenCanvas → GPU texture (on stamp/rasterize) | WebGPU draw calls every frame |
| **Live rendering** | Only after rasterization, or via 2D overlay for placement preview | Every frame, always live |
| **Undo** | Single snapshot per stamp/rasterize operation | Per-operation undo on scene graph |
| **Parameterization** | Arbitrary params record, re-generate any time | Shape properties (transform, fill, stroke) |
| **Layering** | Marker layer entry, excluded from GPU compositor | Always drawn above all raster layers by `drawVectorShapes()` |
| **3D export** | `exportAs3DTexture()` → PNG Blob | Not applicable |
| **Persistence** | `ephemera.json` in project ZIP (`{ version: 2, sheets, placements }`) | Scene graph serialization |

---

## The Overlay Canvas and Interaction

### How rendering works

`ShapeManager.setEphemeraOverlayCanvas(canvas)` attaches a 2D `HTMLCanvasElement` that lives on top of the WebGPU canvas (positioned absolutely in the UI, same dimensions). Every frame after the GPU submit, `_renderEphemeraOverlay()` fires via the renderer's post-frame hook and:

1. Clears the overlay canvas
2. Reads the current world matrix from `InteractionService` (pan/zoom/transform)
3. Converts it to a 2D canvas `setTransform` so placements draw at the correct screen position and scale
4. Draws each visible placement's cached SVG image via `drawImage`

SVG strings are converted to `HTMLImageElement` via Blob URL once and cached by placement ID. The cache invalidates automatically when `placement.svg` changes (i.e. when the user edits params).

### Interaction: clicks and dragging

The overlay canvas has `pointer-events: none`. **All input stays on the WebGPU canvas**, which is where Salsa's entire pointer pipeline already lives. Placement interaction (click to select, drag to move, resize, rotate) is **wired and live** via `setEphemeraInteractionCallbacks` / `setEphemeraHandleCallbacks`:

1. The pointer handler converts screen coords → world coords via the inverse world matrix (shared with shapes)
2. `_ephemeraHandleHitTester` (resize/rotate handles) and `_ephemeraHitTester` (placement body) run in `handlePointerDown` **before** scene-graph picking (the overlay draws above shapes)
3. On hit: select the placement and enter `draggingPlacement` / `resizingPlacement` / `rotatingPlacement` mode
4. On drag: the callbacks update the placement (`movePlacementTo` / resize / rotate) — the overlay redraws on the next frame

This is the same pattern as scene graph shape interaction. The overlay renders; the main canvas handles input.

**Active-layer gating:** placement hit-tests are gated by the active vector layer exactly like scene-graph shapes (`interactionService.isVectorLayerInteractive(layerId)`). A placement only responds when its layer is the active vector layer; otherwise it's inert and the click falls through (to a shape beneath, or to deselect). Switching the active layer auto-clears a now-inert placement selection. See [VectorLayer UI guide](../ui/vector-layer.md#pointer-interactivity-is-gated-to-the-active-vector-layer).

### Does rasterized output match the overlay?

Yes, exactly. Both use the same coordinate system:

| | Overlay | Rasterization |
|---|---|---|
| Placement coords | world space (document pixels) | same |
| Transform | world matrix → screen pixels | none (direct draw at document res) |
| SVG renderer | browser 2D canvas | browser `createImageBitmap` |

At any zoom level the overlay preview shows exactly where the rasterized pixels will land.

---

## Where Ephemera Live in the VectorLayer Plan

Both ephemera placements and scene graph shapes are vector content unified under `type: 'vector'` layer entries. See the [VectorLayer spec](../specs/vector-layer.md) for the full plan.

Current implementation state (complete):
- `'vector'` layer type is live; `'ephemera'` entries in old projects are restored as `'vector'` automatically
- `node.layerId` exists on all scene graph nodes (optional, defaults to the default vector layer)
- Overlay canvas infrastructure is in place (`setEphemeraOverlayCanvas`, post-frame hook, SVG cache)
- Overlay canvas is mounted automatically in `main.ts` (`position: fixed`, `ResizeObserver`-synced)
- Placement pointer interaction (select / drag / resize / rotate) is wired and **gated by the active vector layer**
- Layer panel entry, visibility toggle, and multi-vector-layer support are all live (see VectorLayer spec Phases A–D)

---

## 3D Texture Export

Any generator can export its output as a PNG texture for 3D mesh UV mapping:

```typescript
async exportAs3DTexture(typeId, params, size): Promise<Blob>
```

The SVG is rendered at `size × size` pixels via `createImageBitmap({ resizeWidth: size, resizeHeight: size })`, drawn onto an `OffscreenCanvas`, and exported as `image/png`. The resulting Blob can be uploaded to a `GPUTexture` for 3D material use.

---

## FAQ

### Why are ephemera SVG handled through the browser pipeline instead of our WebGPU vector pipeline?

The answer is about what the WebGPU vector pipeline actually is.

**What the WebGPU vector pipeline handles today:**

Scene graph shapes are defined as geometric primitives — a rectangle is 2 triangles, an ellipse is a fan of triangles, a speech balloon is a tessellated path. These get fed directly to the GPU as vertex buffers. The pipeline knows about fills, strokes, and transforms because those are explicit properties on the node.

**What ephemera actually produce:**

Ephemera generators emit SVG programs — not geometry. An EAN-13 barcode is:

- ~95 individually sized bars with computed widths
- Guard bars that extend a different height
- `<text>` elements with precise font metrics and kerning
- Digit positions derived from the encoding algorithm

A warning label uses `<pattern>`, `<mask>`, `<clipPath>`, and SVG symbol definitions. A Mollweide globe has ~40 projected curves approximated by many path segments. None of this is "a shape with a fill" — it's a document.

**What routing them through WebGPU would require:**

1. An SVG parser (extract all elements and their attributes)
2. A curve tessellator (convert Bézier arcs to triangles — `earcut` or similar)
3. `<pattern>` and `<mask>` support (requires additional render passes or texture sampling)
4. A text layout engine (glyph atlas, SDF fonts, advance widths — this alone is a large system)
5. `<clipPath>` via stencil buffer or texture masks

That is essentially writing a full SVG renderer on top of WebGPU. The browser already has one, and it's correct.

**The practical conclusion:**

The browser SVG engine is the right tool here because the generators output SVG programs by design. The cost is paid once at stamp/rasterize time — not every frame — so there's no performance argument for GPU-side. You get full fidelity (correct fonts, patterns, masks) for free.

The only scenario where you'd want ephemera in the live GPU pipeline is if they needed to animate or respond to real-time parameter changes every frame. For editorial stamps, that's not the use case.

---

## File Locations

| Path | Purpose |
|---|---|
| [src/services/ephemera/ephemera-types.ts](../../src/services/ephemera/ephemera-types.ts) | Core interfaces: `IEphemeraGenerator`, `EphemeraElement`, `EphemeraElementSheet`, `EphemeraPlacement`, `EphemeraCategory` |
| [src/services/ephemera/ephemera-service.ts](../../src/services/ephemera/ephemera-service.ts) | Service: generator registry, sheet management, placement CRUD, stamp/export, serialize/deserialize |
| [src/services/ephemera/generators/](../../src/services/ephemera/generators/) | 13 generators across Phase 1 and Phase 2 |
| [src/services/raster-layer-manager.ts](../../src/services/raster-layer-manager.ts) | `addVectorLayer`, `compositeMultipleImagesOntoLayer`, `isDrawable` guard |
| [src/services/shape-manager.ts](../../src/services/shape-manager.ts) | Public API surface: `addVectorLayer`, `setEphemeraOverlayCanvas`, `addEphemeraPlacement`, `rasterizeEphemeraLayer`, `exportEphemeraAs3DTexture`, etc. |
| [src/services/persistence/project-package.ts](../../src/services/persistence/project-package.ts) | `ephemera.json` read/write in `.frogmarks` ZIP |
