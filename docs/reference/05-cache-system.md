# 05 — Cache System
**Last Updated:** 2026-04-27  

The cache system is the GPU memory management layer. It stores vertex data, index data, and per-shape uniforms in shared GPU buffers and tracks which slice belongs to which shape.

**Files:** `src/renderer/caches/`

---

## Architecture Overview

Every renderable shape type has a trio of components:

```
Registry (bookkeeping)  ←→  GeometryCache (vertices/indices)
                        ←→  UniformCache (per-shape constants)
```

The `CacheService` (`src/services/cache-service.ts`) instantiates all of them and provides a single access point.

---

## The Slice-Based Model

All per-shape uniform data lives in a single large `GPUBuffer(STORAGE)` with **256-byte-aligned slices**:

```
┌─────────────────────────────────────────────────────────┐
│ Buffer: 1,600,000 bytes                                 │
│                                                         │
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐       │
│ │  Slice 0 ││  Slice 1 ││  Slice 2 ││  Slice 3 │ ...   │
│ │ 256 bytes││ 256 bytes││ 256 bytes││ 256 bytes│       │
│ │ Shape A  ││ Shape B  ││ (free)   ││ Shape C  │       │
│ └──────────┘└──────────┘└──────────┘└──────────┘       │
└─────────────────────────────────────────────────────────┘
```

- 256 bytes = the WebGPU minimum uniform buffer offset alignment
- Each slice packs: resolution (vec4) + worldMatrix (mat4) + localMatrix (mat4) + color (vec4) + extras
- The `firstInstance` field in the indirect draw command tells the shader which slice to read
- When a shape is removed, its slice goes into a `unallocatedOffsets[]` pool for reuse
- When the buffer fills up, it doubles in size (old data GPU-copied to new buffer)

**Why STORAGE and not UNIFORM?** WebGPU UNIFORM buffers have a 64KB limit. STORAGE buffers can be much larger and support dynamic indexing from the shader via `@builtin(instance_index)`.

---

## Registries

**Files:** `src/renderer/caches/cache-registry/`

### RenderDataRegistry<T>

A `Map<string, RenderData>` keyed by `shape.id`. Each entry stores:

```typescript
interface RenderData {
  shapeIndex: number;      // = uniformOffset / 256 (the slice number)
  uniformOffset: number;   // byte offset into the uniform buffer
  geometry?: GeometryOffsets;
}

interface GeometryOffsets {
  vertexOffset: number;    // byte offset into the vertex buffer
  indexOffset: number;     // byte offset into the index buffer
  vertexCount: number;
  indexCount: number;
}
```

**8 registries** exist in CacheService: shape, boundingBox, stroke, line, highlight, pattern, legacyPattern, sdfText.

### LegacyDataRegistry<T>

Identical interface but uses shallow spread (`...`) for merge instead of field-level merge. Used exclusively by the legacy pattern pipeline.

### Legacy RenderCache

The original monolithic cache (pre-refactor). Still present in the codebase but superseded by the specialized caches. Allocates 256-byte slices from a single UNIFORM buffer.

---

## Geometry Caches

**Files:** `src/renderer/caches/geometry-cache/`

All geometry caches maintain:
- A CPU-side typed array (`vertexData: Float32Array`, `indexData: Uint16Array/Uint32Array`)
- A mirrored `GPUBuffer(VERTEX)` and `GPUBuffer(INDEX)`
- Offset tracking per shape (where in the buffer each shape's data lives)

### ShapesRenderGeometryCache

For solid shapes (Rectangle, Circle, Triangle, etc.).

**Shared geometry optimization:** Multiple shapes of the same type share vertex data. For example, all Rectangles share one 4-vertex unit quad. The `sharedGeometryMap` deduplicates by shape type string. Only Polygons (with unique point arrays) get individual allocations.

- Default capacity: 500K vertices, 1M indices
- Auto-grows by doubling when exhausted

### StrokesRenderGeometryCache

For committed Scribble strokes. Uses quad-strip tessellation with smoothed normals.

- Default capacity: 1M vertices, 2M indices
- Only the **newest** stroke can be updated (during the commit process — geometry is copied from the staging buffer)
- Also handles Line shapes via `allocateLine()` which generates a simple 2-triangle quad

### HighlightsRenderGeometryCache

Nearly identical to the strokes cache but dedicated to Highlight shapes. Same smoothed-normal quad-strip tessellation.

### BoundingBoxRenderGeometryCache

For selection outlines. Each bounding box is 8 vertices (4 outer + 4 inner corners) forming 4 thin rectangles (top/bottom/left/right edges). Uses a **shared index buffer** (24 indices, reused for every box).

- Default: 128 boxes, doubles when needed

### SdfTextRenderGeometryCache

Per-glyph quad geometry for SDF text. Each glyph = 4 vertices (pos + UV). The vertex format is 4 floats per vertex: (x, y, atlasU, atlasV).

- Default: 100K vertices, 200K indices
- Can re-allocate at end of buffer if text grows beyond its initial slot

### PatternLegacyGeometryCache

Legacy path for pattern shapes. Uses `Uint16Array` indices. Manual buffer growth with chunked writes and NaN-safety checks.

---

## Uniform Caches

**Files:** `src/renderer/caches/uniform-cache/`

All uniform caches derive from `GpuUniformCache<T>` (abstract base). They manage a `GPUBuffer(STORAGE)` with 256-byte-aligned slices.

### Common Uniform Layout (per 256-byte slice)

```
Bytes 0–15:    resolution (vec4)        — canvas width, height, 0, 0
Bytes 16–79:   worldMatrix (mat4×float) — camera/view transform
Bytes 80–143:  localMatrix (mat4×float) — this shape's world transform
Bytes 144–159: color (vec4)             — fillColor or strokeColor (RGBA)
Bytes 160–163: strokeWidth (float)      — line thickness
Bytes 164–255: padding / type-specific
```

### Type-Specific Caches

| Cache | Color Source | Extra Fields |
|-------|-------------|-------------|
| `ShapesRenderUniformCache` | `fillColor` | — |
| `StrokesRenderUniformCache` | `strokeColor` | — |
| `HighlightsRenderUniformCache` | `strokeColor` | — |
| `SdfTextRenderUniformCache` | `fillColor` | `fontSize`, `sdfThreshold`, `smoothing`, `outlineWidth`, `outlineColor` |
| `PatternLegacyUniformCache` | adaptive (fill vs stroke) | — |

### BoundingBoxRenderUniformCache

**Not** derived from GpuUniformCache. Uses two separate buffers:
- `localMatrixBuffer` (STORAGE): 256-byte slots per shape (mat4 at offset 0)
- `worldMatrixBuffer` (UNIFORM): single mat4 for the entire pass

### Version-Based Dirty Tracking

Each uniform cache has an `allocateLocalMatrix(shape)` method that checks `shape.localMatrixVersion` against the last-written version. If unchanged, the buffer write is skipped — this is the primary optimization for static scenes.

---

## Buffer Growth

When any cache exceeds capacity:

1. Allocate a new GPU buffer at 2× the old size
2. Copy old buffer contents to new buffer via GPU commands (`commandEncoder.copyBufferToBuffer`)
3. Destroy old buffer
4. Notify the `BindGroupManager` to recreate affected bind groups (since the buffer handle changed)

The copy uses `GpuBufferUtils.ensureBufferCapacity()` which handles the encoder creation, copy, and submission. For very large buffers, `writeBufferInChunks()` breaks writes into 256KB chunks to stay within WebGPU limits.

---

## CacheService — The Orchestrator

**File:** `src/services/cache-service.ts`

Creates and holds all caches, registries, and texture resources:

- **8 registries** (one per draw type)
- **7 uniform caches** (shapes, strokes, lines, bounding boxes, highlights, SDF text, legacy patterns)
- **8 geometry caches** (shapes, strokes, lines, bounding boxes, highlights, patterns, legacy patterns, SDF text)
- **1 TextureArrayAtlas** (256×256, 128 layers — for patterns/stamps)
- **3 overlay buffers** (carets: 8KB, selection highlights: 8KB, dots: 8KB — all STORAGE usage)
- **SDF atlas + sampler** for SDF text rendering

CacheService is injected into both the `WebGPURenderStrategy` and the `WebGPURenderer` via setter properties.
