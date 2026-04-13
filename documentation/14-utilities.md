# 14 — Utilities

Salsa includes utility modules for geometry math, GPU buffer operations, viewport culling, event handling, and handle hit-detection.

**Files:** `src/renderer/util/`

---

## AABB — Axis-Aligned Bounding Box

**File:** `src/renderer/util/aabb.ts`

```typescript
interface AABB {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
```

### Functions

| Function | Purpose |
|----------|---------|
| `aabbOverlaps(a, b)` | Separated axis test: `!(a.maxX < b.minX \|\| a.minX > b.maxX \|\| a.maxY < b.minY \|\| a.minY > b.maxY)` |
| `polyToAABB(polygon)` | Computes AABB from a `[x,y][]` polygon by finding min/max coordinates |
| `getWorldAABB(shape)` | Computes world-space AABB for a shape. For groups: recursively unions children's AABBs |
| `viewportAABB(canvas, worldMatrix)` | Computes the viewport's world-space AABB by inverse-transforming the canvas corners |

---

## Geometry — Polygon Math

**File:** `src/renderer/util/geometry.ts`

### `polygonsIntersect(a, b): boolean`

**Separating Axis Theorem (SAT)** for convex polygons.

For each edge of polygon A, then each edge of polygon B:
1. Compute the edge normal (perpendicular)
2. Project all vertices of A onto the normal → get [minA, maxA]
3. Project all vertices of B onto the normal → get [minB, maxB]
4. If intervals don't overlap → separating axis found → no intersection → return false
5. If no separating axis found across all edges → polygons overlap → return true

Used for box selection (selection rectangle vs. shape bounding polygon).

### `pointInPolygon([px, py], polygon): boolean`

**Ray casting algorithm.** Cast a horizontal ray from the point to +∞. Count how many polygon edges the ray crosses. Odd count = inside, even = outside.

Used for hit testing (is this mouse point inside this shape's polygon?).

---

## GPU Buffer Utils

**File:** `src/renderer/util/gpu-buffer-utils.ts`

Static helpers for GPU buffer management. Central to all geometry and uniform caches.

| Method | Purpose |
|--------|---------|
| `writeBuffer(device, buffer, offset, data)` | Direct `device.queue.writeBuffer()` wrapper |
| `writeBufferInChunks(device, buffer, offset, data, chunkSize?)` | Breaks large writes into 256KB chunks (WebGPU has per-call size limits on some implementations) |
| `writeVertexAndIndexBuffers(device, vb, ib, vData, iData, vOff, iOff)` | Convenience: writes both vertex and index data in one call |
| `ensureBufferCapacity(device, buffer, needed, usage)` | If `buffer.size < needed`: creates new buffer at `max(needed, old×2)`, GPU-copies old data, destroys old buffer, returns new buffer |
| `createVertexBuffer(device, size)` | Creates `GPUBuffer(VERTEX \| COPY_DST \| COPY_SRC)` |
| `createIndexBuffer(device, size)` | Creates `GPUBuffer(INDEX \| COPY_DST \| COPY_SRC)` |
| `dumpGpuBuffer(device, buffer, size)` | Debug utility: reads back a GPU buffer to CPU for inspection (uses MAP_READ staging buffer) |

### `ensureBufferCapacity` Flow

```
1. If buffer.size >= needed → return same buffer
2. newSize = max(needed, buffer.size × 2)     // Double to amortize future growth
3. newBuffer = device.createBuffer(newSize)
4. encoder.copyBufferToBuffer(old → new)       // GPU copy
5. device.queue.submit()
6. old.destroy()
7. return newBuffer                             // Caller must update references
```

---

## Handles — Rotation & Scaling Handle Detection

**File:** `src/renderer/util/handles.ts`

Determines which transform handle (if any) the mouse is near.

### `canvasPxToWorld(canvasX, canvasY, canvas, worldMatrix): [number, number]`

Converts pixel coordinates to world space via inverse world matrix. Same as `InteractionService.toWorldCoordsFromCanvas()` but standalone.

### `isNearRotationHandle(mouseWorld, shape, canvas, worldMatrix, threshold?): boolean`

1. Transform mouse position to shape's **local space** (inverse shape `localMatrix`)
2. Compute rotation handle position: top-center of bounding box + offset above
3. Return `distance(mouse, handlePos) < threshold`

The threshold is in pixels (converted to local-space units using the current zoom).

### `getScalingSide(mouseWorld, shape, canvas, worldMatrix, threshold?): ScalingSide | null`

1. Transform mouse to shape's local space
2. Get the 4 corners and 4 edge midpoints of the bounding box
3. For **corner handles**: simple distance check
4. For **edge handles**: anisotropic distance — relaxed along the edge direction, strict perpendicular to it (so you can click anywhere along an edge to grab it)
5. Return the closest handle within threshold, or `null`

Returns: `'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left' | null`

### `getLocalBoundingBoxCorners(shape): [vec2, vec2, vec2, vec2]`

Returns the 4 corners of the shape's bounding box in local space:
```
topLeft:     (-width/2, -height/2)
topRight:    ( width/2, -height/2)
bottomRight: ( width/2,  height/2)
bottomLeft:  (-width/2,  height/2)
```

---

## Interaction Types

**File:** `src/renderer/util/interaction-types.ts`

A single type export:

```typescript
type ScalingSide = 'left' | 'right' | 'top' | 'bottom' | 
                   'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
```

---

## Event Emitter

**File:** `src/renderer/util/event-emitter.ts`

Minimal pub/sub implementation:

```typescript
class EventEmitter<T> {
    subscribe(listener: (data: T) => void): { unsubscribe: () => void };
    emit(data: T): void;  // Calls all listeners synchronously
}
```

Used throughout Salsa:
- `InteractionService` events (selection changed, scene changed, render requested)
- `RasterDrawingService` events (stroke start/update/end)
- `RasterSelectionService` events (selection changed)

---

## Staging Container

**File:** `src/renderer/util/staging-container.ts`

Interface for collecting in-progress shapes during `beginFrame()`:

```typescript
interface StagingContainer {
    scribbles: Scribble[];
    highlights: Highlight[];
    lines: Line[];
    patterns: Pattern[];
}
```

Created fresh each frame. Shapes with `isStaging = true` are pushed here instead of going through the committed cache path. Consumed by `renderStagingShapes()` in the renderer.

---

## Viewport Bounds — Frustum Culling

**File:** `src/renderer/util/viewport-bounds.ts`

Determines which shapes are visible in the current viewport and hides the rest.

### Architecture

```
ViewportBounds
├── worldAABB: AABB              // Viewport extent in world space
├── dirty: boolean               // Invalidated on pan/zoom
├── shapeViewportCache: Map      // Per-shape viewport in local space
└── updateVisibility(nodes[])    // Batch set visible=true/false
```

### Two Culling Strategies

**Regular shapes** (Rectangle, Circle, Triangle, etc.):
- Get the shape's world-space AABB from its bounding box
- Test `aabbOverlaps(shapeAABB, viewportAABB)`

**Control-point shapes** (Scribble, Highlight, Line, Pattern):
- These can be long, thin strokes that cross the viewport without their bounding box overlapping it
- Check if **any control point** is inside the viewport AABB
- Additionally check if **any line segment** between consecutive points intersects the viewport rectangle

### Dirty Management

- `markDirty()` — called on any pan/zoom change
- On next `updateVisibility()` call: recompute `worldAABB`, then test all nodes
- Per-shape local-space viewport is cached to avoid redundant matrix inversions

### Effect on Rendering

Shapes with `visible = false` are skipped during `beginFrame()` traversal — they don't get geometry/uniform uploads and don't appear in draw command buffers. This is the primary performance optimization for large scenes.
