# 07 — Staging & Live Drawing

When a user draws a stroke (Scribble, Line, Highlight), the geometry changes every frame as new points are added. This can't use the standard committed cache path (which assumes static geometry). Instead, Salsa uses a **triple-buffered staging system** for live preview, with a commit step that moves final geometry into the shared cache.

---

## Why Staging Exists

The committed cache uses `drawIndexedIndirect` — the GPU reads a pre-built command buffer that references fixed offsets in shared vertex/index buffers. If we overwrote those buffers every frame during drawing, we'd need to synchronize CPU writes with GPU reads, causing stalls.

The staging system solves this with **separate per-frame buffers** that the GPU never reads until the CPU is done writing.

---

## Triple-Buffered Staging

**File:** `src/renderer/caches/buffers/strokes-staging-buffer.ts`

### Architecture

```
Frame 0: [vertex buf A] [index buf A] [uniform buf slot 0]  ← GPU reading
Frame 1: [vertex buf B] [index buf B] [uniform buf slot 1]  ← CPU writing
Frame 2: [vertex buf C] [index buf C] [uniform buf slot 2]  ← idle
         ↓ rotate on beginFrame()
```

Three sets of CPU-side typed arrays + GPU buffers. Each frame:
1. `beginFrame()` advances to the next buffer index and clears the CPU arrays
2. Shapes write to the **current** frame's arrays
3. Arrays are uploaded to the current frame's GPU buffers
4. The render pass reads from the current frame's GPU buffers

Since we always write to a different buffer than the GPU is reading from the previous frame, there are no sync stalls.

### Storage

```typescript
class StrokesStagingBuffer {
    frameCount = 3;
    currentFrame = 0;
    
    vertexBuffers: GPUBuffer[];         // VERTEX + COPY_DST, one per frame
    indexBuffers: GPUBuffer[];          // INDEX + COPY_DST, one per frame  
    vertexData: Float32Array[];         // CPU-side, one per frame
    indexData: Uint16Array[];           // CPU-side, one per frame
    uniformBuffer: GPUBuffer;           // STORAGE, 272 bytes × 3 frames
    
    vertexOffset: number;              // Current write position in vertex array
    indexOffset: number;               // Current write position in index array
}
```

### Auto-Resize

If a stroke exceeds the current buffer capacity, both CPU arrays and GPU buffers are doubled:
1. New `Float32Array` / `Uint16Array` at 2× size
2. Old data copied in
3. Old GPU buffer destroyed, new one created
4. Write position maintained

---

## The Drawing Flow

### 1. User starts drawing

The drawing service (e.g., `ScribbleDrawingService`) creates a new shape with `isStaging = true` and adds it to the scene graph.

### 2. Per pointer-move

```
pointerMove event
    → drawingService.addPoint(x, y)
    → shape._points.push({x, y})
    → shape.markDirty()
    → renderer.scheduleRender()
```

### 3. During beginFrame()

The render strategy encounters the staging shape:

```typescript
if (node instanceof Scribble && node.isStaging) {
    stagingContainer.scribbles.push(node);
    return; // Skip committed cache
}
```

### 4. During render()

```typescript
// renderer.renderStagingShapes(stagingContainer.scribbles)
for (const shape of stagingShapes) {
    // 1. Pack uniform data (resolution, worldMatrix, localMatrix, color, strokeWidth)
    const uniformData = getStrokeUniformData(shape);     // 64 floats
    stagingBuffer.writeUniforms(uniformData);              // → current frame's uniform slot
    
    // 2. Tessellate stroke geometry into current frame's buffers
    shape._stagingInfo = stagingBuffer.writeStroke(shape); // quad-strip tessellation
    
    // 3. Create bind group pointing to current frame's uniform data
    const bindGroup = stagingBuffer.createStagingBindGroup(pipelineLayout);
    
    // 4. Draw
    passEncoder.setPipeline(stagingLinePipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, stagingBuffer.vertexBuffers[currentFrame]);
    passEncoder.setIndexBuffer(stagingBuffer.indexBuffers[currentFrame], 'uint16');
    passEncoder.drawIndexed(indexCount, 1, firstIndex, baseVertex);
}
```

Each staging shape gets its own `drawIndexed()` call (not batched via indirect — too dynamic).

### 5. User lifts pen (pointerUp)

```
pointerUp event
    → drawingService.finishStroke()
    → shape.isStaging = false
    → shape.wasCommitted = true
    → renderer.scheduleRender()
```

### 6. Commit: Staging → Shared Cache

On the next `beginFrame()`, the strategy detects `wasCommitted`:

```typescript
if (node instanceof Scribble && node.wasCommitted) {
    // Copy final geometry from staging buffer to the shared geometry cache
    stagingBuffer.copyToSharedBuffer(node, strokeGeometryCache);
    node.wasCommitted = false;
    // From now on, this shape uses the committed path (drawIndexedIndirect)
}
```

The `copyToSharedBuffer()` method:
1. Reads the final vertex/index data from the staging CPU arrays
2. Allocates a slot in the shared geometry cache
3. Copies the data to the shared GPU buffers
4. Records the offsets in the registry

After commit, the shape renders via `drawIndexedIndirect` just like any other committed shape.

---

## Drawing Services

**Files:** `src/services/drawing/`

Each drawing tool has a service that handles pointer events and creates/manages the in-progress shape.

### ScribbleDrawingService

```
pointerDown → create Scribble (isStaging=true, isPreview=false)
              add to scene graph, set selectionGuard
pointerMove → addPoint(worldX, worldY), scheduleRender
pointerUp   → finishStroke(), clear selectionGuard, commit
```

### HighlightDrawingService

Same flow as Scribble but creates a Highlight shape (alpha forced to 0.65).

### LineDrawingService

```
pointerDown → create Line (isStaging=true)
              set initial endpoints
pointerMove → update end point (x2, y2)
pointerUp   → commit, snap to connector port if near one
```

Lines use the `stagingLinePipeline` during interaction and `linePipeline` after commit.

### PolygonDrawingService

Interactive point-by-point polygon drawing:
```
click      → addPoint()
mousemove  → updateLastPoint() (rubber-band preview)
double-click / Enter → finishPolygon(), commit
Escape     → cancel
```

### PatternDrawingService

Creates Pattern shapes with texture keys. Manages the `TextureArrayAtlas` for loading/ensuring textures:
```
pointerDown → create Pattern with texture key
pointerMove → update endpoint (stretches/rotates the pattern)
pointerUp   → commit, compute final transform for instanced rendering
```

### StampDrawingService

Single-click placement of stamp textures:
```
pointerDown → create Stamp at click position
              set width/height from texture dimensions
              commit immediately (no drag)
```

### SectionDrawingService

Drag-to-create section frames:
```
pointerDown → create Section at click position
pointerMove → resize section (update width, height)
pointerUp   → commit, reparent any shapes within bounds as children
```

---

## EraserService

**File:** `src/services/drawing/eraser-service.ts`

The eraser doesn't use staging. On pointer move, it tests intersection between the eraser path and all Scribble shapes (via `scribble.intersectsLine()`). Intersected scribbles are removed from the scene graph and their cache entries are deallocated.
