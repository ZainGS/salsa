# 06 — Vector Shape Rendering Pipeline

This document traces the full journey of a vector shape from creation to pixels on screen.

---

## The Full Pipeline

```
User creates shape (via ShapeManager)
        │
        ▼
    Shape object added to SceneGraph tree
        │
        ▼
    Renderer schedules frame (requestAnimationFrame)
        │
        ▼
    WebGPURenderStrategy.beginFrame()
        │
        ├── 1. Geometry generation (shape.getGeometryVertices())
        ├── 2. Geometry cache allocation (write to shared GPU vertex/index buffer)
        ├── 3. Uniform cache allocation (write to shared GPU storage buffer)
        ├── 4. Indirect draw command (add to IndirectDrawCommandBuffer)
        │
        ▼
    WebGPURenderer.render()
        │
        ├── 5. Set pipeline + bind group
        ├── 6. Set vertex/index buffers
        └── 7. drawIndexedIndirect() — GPU executes all shape commands
```

---

## Step 1: Geometry Generation

Each shape subclass implements `getGeometryVertices()` and `getGeometryIndices()`.

### Solid Shapes (Rectangle, Circle, Triangle, Diamond, Section)

**Vertex format:** 2 floats per vertex (x, y) in local space, centered at origin.

| Shape | Vertices | Indices |
|-------|----------|---------|
| Rectangle | 4: `(±0.5, ±0.5)` | 6: two triangles |
| Circle | 61: center + 60 perimeter points | 180: 60 triangles (fan) |
| Triangle | 3: top, bottom-left, bottom-right | 3: one triangle |
| Diamond | 4: top, right, bottom, left | 6: two triangles |
| Section | Same as Rectangle | Same as Rectangle |

Geometry is computed once and cached in `shape.cachedVertices` / `shape.cachedIndices`. Re-generated only on `markDirty()`.

### Polygon

**Vertex format:** Same 2-float format.

Polygons have arbitrary point arrays. Vertices come directly from `_points[]`. Indices are generated via fan triangulation from the first point.

### Shared Geometry Optimization

The geometry cache deduplicates: all Rectangles share the same 4 vertices. The unique transform comes from the per-shape uniform (localMatrix). Only Polygons with custom points get individual allocations.

---

## Step 2: Geometry Cache Write

**File:** `src/renderer/caches/geometry-cache/shapes-render-gcache.ts`

```typescript
shapeGeometryCache.allocate(shape);  // First time: reserve a slot
shapeGeometryCache.update(shape);    // Write/rewrite vertex + index data
```

### Allocation

1. Check if the shape type already has shared geometry → reuse offsets
2. Otherwise, append vertices at `currentVertexOffset` and indices at `currentIndexOffset`
3. Record offsets in the registry: `{ vertexOffset, indexOffset, vertexCount, indexCount }`
4. If the buffer is full, `ensureBufferCapacity()` doubles it (GPU copy + destroy old)

### Write

```typescript
// Write vertices to shared GPU buffer at the shape's offset
device.queue.writeBuffer(vertexBuffer, data.vertexOffset, vertices);
device.queue.writeBuffer(indexBuffer, data.indexOffset, indices);
```

---

## Step 3: Uniform Cache Write

**File:** `src/renderer/caches/uniform-cache/shapes-render-ucache.ts`

```typescript
shapeUniformCache.allocate(shape);  // Reserve a 256-byte slice
shapeUniformCache.update(shape);    // Write uniform data
```

### What gets written (64 floats = 256 bytes):

```
Float[0..3]:   resolution (canvasWidth, canvasHeight, 0, 0)
Float[4..19]:  worldMatrix (mat4 — camera/view transform)
Float[20..35]: localMatrix (mat4 — shape's world transform: parent chain × local)
Float[36..39]: fillColor (r, g, b, a)
Float[40]:     strokeWidth
Float[41..63]: padding (zeros)
```

### Version Tracking

The localMatrix write uses version checking:
```typescript
if (shape.localMatrixVersion !== lastWrittenVersion[shape.id]) {
    device.queue.writeBuffer(uniformBuffer, offset + 80, shape.localMatrix);
    lastWrittenVersion[shape.id] = shape.localMatrixVersion;
}
```

This skips the buffer write for shapes that haven't moved — critical for large static scenes.

---

## Step 4: Indirect Draw Command

**File:** `src/renderer/caches/buffers/indirect-draw-command-buffer.ts`

```typescript
shapeDrawCommands.updateOrAdd(shape);
```

Builds a 5-uint32 command:

```typescript
{
    indexCount:     data.geometry.indexCount,
    instanceCount:  1,
    firstIndex:     data.geometry.indexOffset / 2,    // byte offset → index count (Uint16)
    baseVertex:     data.geometry.vertexOffset / 8,   // byte offset → vertex count (2 floats × 4 bytes)
    firstInstance:  data.uniformOffset / 256           // byte offset → slice index
}
```

All commands for all shapes of the same pipeline type are packed contiguous in the command buffer.

At the end of `beginFrame()`, the CPU-side command array is uploaded:
```typescript
device.queue.writeBuffer(commandGPUBuffer, 0, commandArray);
```

---

## Step 5–7: The GPU Draw

In `WebGPURenderer.drawVectorShapes()`:

```typescript
passEncoder.setPipeline(shapePipeline);
passEncoder.setBindGroup(0, sharedShapeBindGroup);  // Storage buffer with all uniforms
passEncoder.setVertexBuffer(0, shapeGeometryCache.getVertexBuffer());
passEncoder.setIndexBuffer(shapeGeometryCache.getIndexBuffer(), 'uint16');
passEncoder.drawIndexedIndirect(shapeDrawCommands.getBuffer(), 0);
```

### What the GPU Does

For each command in the indirect buffer:
1. Read `indexCount` indices starting at `firstIndex` from the index buffer
2. Add `baseVertex` to each index → lookup vertex in the vertex buffer
3. Set `instance_index = firstInstance` → shader reads uniform slice
4. The **vertex shader** transforms the vertex: `position = worldMatrix × localMatrix × vec4(vertex.xy, 0, 1)`
5. The **fragment shader** outputs `fillColor` (with alpha blending)

**One API call draws all shapes of the same type.** The GPU iterates through the command buffer internally.

---

## Stroke Rendering (Scribble, Highlight, Line)

Strokes follow the same pattern but with different geometry generation:

### Quad-Strip Tessellation

**File:** `src/renderer/caches/geometry-generators/stroke-geometry-generator.ts`

For a Scribble with points [P₀, P₁, P₂, ... Pₙ]:

```
For each point Pᵢ:
  tangent = normalize(Pᵢ₊₁ − Pᵢ₋₁)   // averaged direction
  normal  = (-tangent.y, tangent.x)     // perpendicular
  
  vertex₂ᵢ   = Pᵢ + normal × halfThickness
  vertex₂ᵢ₊₁ = Pᵢ − normal × halfThickness

For each segment (Pᵢ to Pᵢ₊₁):
  indices: [2i, 2i+1, 2(i+1), 2(i+1), 2i+1, 2(i+1)+1]  // two triangles
```

The smoothed normal averaging prevents visual "spikes" at sharp turns.

### Highlights: Stencil Buffer

Highlights use the `highlightPipeline` with stencil operations to prevent self-overlap darkening. Each Highlight shape gets a unique stencil reference value. The stencil test rejects fragments that would overlap the same highlight, achieving a flat translucent appearance even where strokes cross.

---

## Pattern / Stamp Rendering (Instanced)

Patterns and stamps use **instanced rendering** — a single draw call for all instances.

```typescript
passEncoder.setPipeline(texturedPipeline);
passEncoder.setBindGroup(0, texturedBindGroup);  // Instance storage + atlas texture
passEncoder.draw(6, instanceCount);               // One quad × N instances
```

The vertex shader reads per-instance data from the storage buffer:
- `worldMatrix` and `localMatrix` for positioning
- `atlasLayerIndex` to select the correct texture from the 2D array atlas
- `flags` to distinguish patterns (1) from stamps (2)
- `tintColor` for coloring

---

## Bounding Box Rendering

Selection outlines are rendered as thin quad-strip frames:

```
Each box = 8 vertices:
  4 outer corners + 4 inner corners (inset by outline thickness)
  
  ┌────────────────────────┐ ← outer
  │ ┌────────────────────┐ │ ← inner
  │ │                    │ │
  │ │                    │ │
  │ └────────────────────┘ │
  └────────────────────────┘

4 thin rectangles connected by 24 indices
```

Bounding boxes use a separate pipeline (`boundingBoxPipeline`) and uniform cache (`BoundingBoxRenderUniformCache`) with a storage buffer for per-shape localMatrix data and a single worldMatrix uniform.
