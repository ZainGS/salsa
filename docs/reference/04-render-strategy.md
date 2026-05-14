# 04 — Render Strategy & Draw Commands
**Last Updated:** 2026-04-27  

The `WebGPURenderStrategy` is the bridge between the scene graph and the GPU. Each frame, it traverses the node tree, decides how to handle each shape type, feeds the cache system, and builds indirect draw command buffers.

**File:** `src/renderer/render-strategies/webgpu-render-strategy.ts`

---

## `beginFrame()` — The Per-Frame Pipeline

Called at the start of every render cycle. It processes a flat, z-sorted `nodes[]` array (prepared by the renderer from the scene graph).

### Step-by-Step Flow

```
beginFrame(nodes, stagingContainer)
│
├── For each node in z-order:
│   │
│   ├── Rectangle / Circle / Triangle / InvertedTriangle / Diamond / Polygon / Section
│   │   ├── Allocate geometry cache slot (if new)
│   │   ├── Allocate uniform cache slot (if new)
│   │   ├── If isDirty:
│   │   │   ├── Re-upload geometry to shared vertex/index buffers
│   │   │   └── Re-upload uniforms (resolution, worldMatrix, localMatrix, color)
│   │   └── Add to shapeDrawCommands (indirect draw buffer)
│   │
│   ├── Scribble
│   │   ├── If isStaging: push to stagingContainer.scribbles (deferred)
│   │   ├── If wasCommitted (first commit frame):
│   │   │   └── Copy geometry from staging buffer → shared geometry cache
│   │   └── If committed: add to strokeDrawCommands
│   │
│   ├── Line
│   │   ├── If isStaging: push to stagingContainer.lines
│   │   └── If committed: allocate/update line geometry + add to lineDrawCommands
│   │
│   ├── Highlight
│   │   ├── If isStaging: push to stagingContainer.highlights
│   │   └── If committed: add to highlightDrawCommands (unique stencil ref per highlight)
│   │
│   ├── Pattern
│   │   ├── Ensure texture loaded in TextureArrayAtlas
│   │   ├── Compute instance transform (midpoint, angle, scale from endpoints)
│   │   └── Write to TexturedInstanceBuffer (flags=1)
│   │
│   ├── Stamp
│   │   ├── Ensure texture loaded in TextureArrayAtlas
│   │   └── Write to TexturedInstanceBuffer (flags=2)
│   │
│   ├── LiveTextNode
│   │   ├── Feed dynamic uniforms (time, cursorUV, mouseDown)
│   │   ├── Call node.updateTexture() to capture/process text
│   │   └── Collect in liveTextNodes[] for later drawLiveTextNodes()
│   │
│   ├── SDFText
│   │   ├── Allocate/update glyph geometry (per-character quads from atlas)
│   │   ├── Allocate/update uniforms (+ SDF-specific: threshold, smoothing, outline)
│   │   └── Add to sdfTextDrawCommands
│   │
│   └── Selected shapes (any type)
│       ├── Allocate bounding box geometry (8 vertices for frame outline)
│       ├── Update bounding box uniforms (localMatrix)
│       └── Add to boundingBoxDrawCommands
│
├── Upload all indirect draw command buffers to GPU
├── Collect overlay data (carets, selection highlights, connection dots)
└── Return control to renderer for the actual render pass
```

---

## Indirect Draw Command Buffers

**File:** `src/renderer/caches/buffers/indirect-draw-command-buffer.ts`

Each draw type has its own `IndirectDrawCommandBuffer`. These store GPU-compatible `drawIndexedIndirect` arguments:

```
┌──────────────┬────────────────┬────────────┬────────────┬───────────────┐
│ indexCount   │ instanceCount  │ firstIndex │ baseVertex │ firstInstance │
│ (uint32)     │ (always 1)     │ (uint32)   │ (uint32)   │ (uint32)      │
└──────────────┴────────────────┴────────────┴────────────┴───────────────┘
         × N shapes
```

- **`indexCount`**: How many indices to draw for this shape
- **`firstIndex`**: Byte offset into the shared index buffer where this shape's indices start
- **`baseVertex`**: Offset added to each index value — locates this shape's vertices in the shared vertex buffer
- **`firstInstance`**: Encodes the **uniform buffer offset** — the shader uses `@builtin(instance_index)` to index into the storage buffer and read this shape's uniforms

### How one `drawIndexedIndirect` call draws many shapes

```
GPU reads command buffer → for command[i]:
  1. Read indices from indexBuffer[firstIndex..firstIndex+indexCount]
  2. Each index value += baseVertex → points into vertexBuffer
  3. instance_index = firstInstance → shader reads uniforms from storageBuffer[firstInstance * 256]
  4. Draw the shape with those vertices and those uniforms
```

### Draw types

| Command Buffer | Shapes | Pipeline |
|----------------|--------|----------|
| `shapeDrawCommands` | Rectangle, Circle, Triangle, InvertedTriangle, Diamond, Polygon, Section | `shapePipeline` |
| `strokeDrawCommands` | Scribble (committed) | `scribblePipeline` |
| `lineDrawCommands` | Line (committed) | `linePipeline` |
| `highlightDrawCommands` | Highlight (committed) | `highlightPipeline` |
| `sdfTextDrawCommands` | SDFText | `sdfTextPipeline` |
| `boundingBoxDrawCommands` | Selection outlines | `boundingBoxPipeline` |

---

## Textured Instance Buffer

**File:** `src/renderer/caches/texture-cache/textured-instance-buffer.ts`

Patterns and Stamps use **instanced rendering** — one draw call for all instances. Each instance is a 256-byte record:

| Offset | Field | Size |
|--------|-------|------|
| 0 | worldMatrix (mat4) | 64 bytes |
| 64 | localMatrix (mat4) | 64 bytes |
| 128 | UV scale/offset | 16 bytes |
| 144 | atlasLayerIndex (u32) | 4 bytes |
| 148 | flags (u32) | 4 bytes |
| 152 | tint color | 16 bytes |
| 168–255 | padding | 88 bytes |

The shader reads instance data from a storage buffer, samples the correct layer of the 2D array texture atlas, and applies the tint. One `drawInstanced(6, instanceCount)` call renders all patterns/stamps.

---

## LiveTextNode Collection

LiveTextNodes are not drawn via indirect commands. Instead, `beginFrame()` collects them into a `liveTextNodes[]` array. After the main vector draws, the renderer calls `drawLiveTextNodes()` which:

1. Packs all node quads into a single vertex buffer (64 bytes per node)
2. Creates a per-node bind group with the node's individual GPU texture
3. Issues one `drawIndexed(6)` per node with byte offsets into the vertex buffer

This is necessary because each LiveTextNode has its own unique texture (unlike shapes which share the same pipeline/uniform structure).

---

## Overlay Collection

At the end of `beginFrame()`, the strategy collects overlay data:

- **Carets:** `collectActiveCarets()` — finds SDFText nodes in typing mode, computes caret rectangle from glyph positions, writes to the shared caret uniform buffer
- **Selection highlights:** `collectSelectionHighlights()` — finds SDFText nodes with active selections, computes per-line highlight rectangles, writes to the selection highlight buffer
- **Connection dots:** Collected from hovered shapes' connection ports, written to the overlay dot buffer

These are drawn after all scene content as fullscreen-independent overlays.

---

## Deduplication: Shared Geometry

For solid shapes, the geometry cache uses a **shared geometry map** to avoid storing duplicate vertex data:

```
All Rectangles → same 4 vertices (unit quad at ±0.5)
All Circles → same 61 vertices (60-segment fan)
All Triangles → same 3 vertices
```

Each Rectangle doesn't get its own vertex allocation — they all reference the same slot. The unique appearance comes from the per-shape **uniform** (which includes the `localMatrix` for position/size/rotation and the `fillColor`).

Only shapes with unique geometry (Polygons with custom points, Scribbles with unique paths) get individual vertex allocations.
