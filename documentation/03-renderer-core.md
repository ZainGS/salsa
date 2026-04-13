# 03 — WebGPU Renderer Core

The `WebGPURenderer` is the central rendering class. It owns the GPU device, manages all render passes, handles pointer input for interaction modes, and coordinates the raster and vector subsystems.

**File:** `src/renderer/core/webgpu-renderer.ts`

---

## Initialization

The renderer is created with a `HTMLCanvasElement` and an `InteractionService`. It requests a `GPUDevice` and configures the canvas context with `bgra8unorm` format.

After construction, the host app sets up the renderer by injecting service references (pipeline manager, cache service, drawing services, etc.) via setter properties. This loose coupling allows the `ShapeManager` to wire everything together.

---

## The `render()` Method — Main Loop

All rendering happens in a **single GPU render pass** to an offscreen texture (`lastFrameTex`), which is then copied to the swap chain backbuffer. This minimizes GPU state transitions.

### Complete Draw Order

```
┌─── render() ─────────────────────────────────────────────┐
│                                                           │
│  1. Collect staging shapes (in-progress strokes)         │
│  2. Create GPUCommandEncoder                              │
│  3. Begin single render pass (offscreen texture target)   │
│                                                           │
│  ┌─── IF RASTER MODE ───────────────────────────────────┐ │
│  │ 4a. RasterCompositor.composite()                     │ │
│  │     └─ Blend all layers → dither → grain → output    │ │
│  │ 4b. Draw artboard background pattern                 │ │
│  │ 4c. Pre-raster vector shapes (panels)                │ │
│  │ 4d. Apply canvas grain overlay                       │ │
│  │ 4e. Draw composited raster quad                      │ │
│  │ 4f. Draw raster text preview (if typing)             │ │
│  │ 4g. Draw floating selection layer                    │ │
│  │ 4h. Draw selection overlay (marching ants)           │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─── VECTOR MODE ONLY ────────────────────────────────┐  │
│  │ 4i. Draw artboard background pattern                │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                           │
│  5. drawVectorShapes() — all committed vector geometry    │
│     ├── Solid shapes (shapePipeline, drawIndexedIndirect) │
│     ├── Scribbles (scribblePipeline, drawIndexedIndirect) │
│     ├── Lines (linePipeline, drawIndexedIndirect)         │
│     ├── SDF Text (sdfTextPipeline, drawIndexedIndirect)   │
│     ├── Highlights (highlightPipeline + stencil)          │
│     └── Bounding boxes (boundingBoxPipeline)              │
│                                                           │
│  6. Staging shapes (live stroke preview)                  │
│     ├── In-progress scribbles (stagingLinePipeline)       │
│     ├── In-progress lines (stagingLinePipeline)           │
│     └── In-progress highlights (stagingHighlightPipeline) │
│                                                           │
│  7. Textured instances (patterns + stamps)                │
│     └── texturedPipeline, instanced draw                  │
│                                                           │
│  8. LiveText nodes (drawLiveTextNodes)                    │
│     └── rasterPipeline, per-node textured quad            │
│                                                           │
│  9. Overlays                                              │
│     ├── Text selection highlights                         │
│     ├── Connection port dots                              │
│     └── Text carets (drawn last, always on top)           │
│                                                           │
│  10. End render pass                                      │
│  11. Copy offscreen → swap chain backbuffer               │
│  12. queue.submit()                                       │
│  13. SDF atlas cleanup (sweep retired textures)           │
└───────────────────────────────────────────────────────────┘
```

### `drawVectorShapes(passEncoder)`

This batched method issues all committed vector draws using indirect draw calls:

```typescript
// For each pipeline type:
passEncoder.setPipeline(pipeline);
passEncoder.setBindGroup(0, sharedBindGroup);         // Shared uniform/storage buffers
passEncoder.setVertexBuffer(0, geometryCache.vb);      // Shared vertex buffer
passEncoder.setIndexBuffer(geometryCache.ib, 'uint16'); // Shared index buffer
passEncoder.drawIndexedIndirect(commandBuffer, 0);      // GPU reads per-shape commands
```

Each shape's draw command (5 × u32) tells the GPU exactly which slice of the shared buffers to read. `firstInstance` encodes the uniform buffer offset so the shader can index into the right 256-byte slice.

---

## Pipelines

**File:** `src/renderer/core/managers/pipeline-manager.ts`

The `PipelineManager` creates **16 GPU render pipelines** in its constructor:

| Pipeline | Vertex Format | Use Case |
|----------|--------------|----------|
| `shapePipeline` | pos(x,y) | Rectangles, circles, triangles, diamonds, polygons, sections |
| `linePipeline` | pos(x,y) | Committed line shapes |
| `scribblePipeline` | pos(x,y) | Committed scribble strokes |
| `highlightPipeline` | pos(x,y) | Committed highlights (+ stencil for non-overlap) |
| `stagingLinePipeline` | pos(x,y) | In-progress scribbles and lines |
| `stagingHighlightPipeline` | pos(x,y) | In-progress highlights |
| `texturedPipeline` | instanced | Patterns and stamps (texture array atlas) |
| `rasterPipeline` | pos(x,y)+uv(u,v) | Raster texture quad, LiveText quads, floating selection |
| `sdfTextPipeline` | pos(x,y)+uv(u,v) | SDF text glyphs |
| `textPipeline` | pos(x,y)+uv(u,v) | Legacy bitmap text |
| `boundingBoxPipeline` | pos(x,y) | Selection bounding box outlines |
| `backgroundPipeline` | pos(x,y) | Dot-grid canvas background |
| `caretPipeline` | — | Text cursor bars |
| `selectionHighlightPipeline` | — | Text selection highlight rectangles |
| `overlayDotPipeline` | — | Connection port indicator dots |

All pipelines use `premultiplied` alpha blending with standard `src-alpha / one-minus-src-alpha` factors.

---

## Bind Group Manager

**File:** `src/renderer/core/managers/bindgroup-manager.ts`

Shared bind groups pair pipeline layouts with the cache system's GPU buffers:

- **Shape bind group:** storage buffer (uniforms) from `ShapesRenderUniformCache`
- **Stroke/Line/Highlight bind groups:** their respective uniform caches
- **SDF text bind group:** storage buffer + atlas texture view + sampler (version-tracked for atlas rebuilds)
- **Textured bind group:** instance storage buffer + texture array view + sampler
- **Overlay bind groups:** caret, selection highlight, dot uniform buffers

Bind groups are recreated when caches resize their underlying GPU buffers.

---

## Interaction Mode State Machine

The renderer handles all mouse/pointer events and maintains an interaction mode:

```
'idle' → pointer down → 'panning' | 'dragging' | 'boxSelecting' | 'rotating' | 'scaling' | 'endpointDragging'
                       → pointer move → mode-specific behavior
                       → pointer up → 'idle'
```

| Mode | Trigger | Behavior |
|------|---------|----------|
| `idle` | Default | Hover cursor logic (scale/rotate handle detection) |
| `panning` | Middle mouse or pan tool | Adjusts pan offset via `interactionService.adjustPan()` |
| `dragging` | Click on selected shape | Moves all selected nodes, converting world delta to parent-local delta per node |
| `boxSelecting` | Click on empty space | Draws selection rectangle, runs polygon intersection on release |
| `rotating` | Click on rotation handle | Computes angle delta, applies to shape `rotation` |
| `scaling` | Click on scale handle | 8 directions (4 edges + 4 corners), applies size changes via `scaleX`/`scaleY` |
| `endpointDragging` | Click on line endpoint | Moves start or end of a Line, with connector port snapping |

### Scaling Details

Each scaling mode carries:
- `side`: which of the 8 handles (`topLeft`, `top`, `topRight`, `right`, etc.)
- `anchorWorld`: the mouse position at drag start
- `initial`: `{ x, y, width, height, baseW, baseH, scaleX, scaleY }`

During drag:
1. Mouse movement is decomposed into rotation-aligned axes (`alongW`, `alongH`)
2. Based on the `side`, new width/height are computed from `initial.width ± alongW`
3. For Groups: `scaleX = newW / baseW` (ratio-based)
4. For other shapes: `scaleX = newW` (absolute — `baseW` is the shape's `_width`, which is 1 for unit-quad shapes)

---

## Render Scheduling (rAF)

The renderer uses `requestAnimationFrame` with dirty-checking:

- **`scheduleRender()`**: Sets `needsFrame = true`. On the next rAF tick, if `needsFrame` is true, calls `render()` and clears the flag.
- **`beginInteractive()`**: Increments `interactiveCount`. While > 0, the renderer runs **continuously** (every rAF tick). Used during editing, animation playback, and effects that need time-based updates.
- **`endInteractive()`**: Decrements `interactiveCount`. When it hits 0, the renderer returns to on-demand rendering.

This avoids unnecessary GPU work when the scene is static.

---

## Offscreen Render Target

All drawing targets a persistent **offscreen texture** (`lastFrameTex`) rather than the swap chain directly. After the render pass completes, the offscreen texture is copied to the swap chain backbuffer.

**Why:** The offscreen texture persists across frames. It's used for:
- **Thumbnail generation** — read back without blocking the swap chain
- **Consistent frame output** — the same texture is available even when the swap chain isn't presenting
- **Post-process compositing** — intermediate results can be sampled

---

## Background Pattern

The dot-grid background pattern uses a dedicated fullscreen quad (`bgQuadVB`) and `backgroundPipeline`. Uniform buffers carry:
- `bgResBuf` — canvas resolution
- `bgInvWorldBuf` — inverse world matrix (for pan/zoom-stable dot spacing)
- `bgBgColorBuf`, `bgDotColorBuf` — colors

Background rendering has its own dirty flags (`bgDirty: { res, matrix, colors }`) to avoid redundant buffer writes.
