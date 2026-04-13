# 12 — Textures & Atlases

Salsa uses multiple texture management strategies depending on the use case: shared atlases for batched rendering, individual textures for per-node content, and a general-purpose fetch cache.

---

## TextureArrayAtlas

**File:** `src/renderer/caches/texture-cache/texture-array-atlas.ts`

The primary atlas for patterns and stamps. Uses a **2D array texture** (WebGPU `texture_2d_array`) where each layer holds one image.

### Architecture

```
┌────────────────────────── GPU 2D Array Texture ──────────────────────────┐
│                                                                          │
│  Layer 0: Solid white (fallback)                                        │
│  Layer 1: pattern_crosshatch.png                                        │
│  Layer 2: pattern_dots.png                                              │
│  Layer 3: stamp_star.png                                                │
│  ...                                                                     │
│  Layer N-1: (available)                                                  │
│                                                                          │
│  texture size: 1024 × 1024 × maxLayers  (default: 64 layers)           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Operations

| Method | Purpose |
|--------|---------|
| `ensure(key, src?)` | Load image at `key` (URL or blob) into a layer. Returns layer index. Async (image fetch). Idempotent — same key returns same layer. |
| `getLayer(key)` | Returns the layer index for a key, or `-1` if not loaded |
| `growAtlas()` | Doubles the number of layers, GPU-copies existing layers to new texture |

### Growth Strategy

When all layers are occupied:
1. Create new 2D array texture at 2× layer count
2. Copy all existing layers via `commandEncoder.copyTextureToTexture()`
3. Destroy old texture
4. Fire `onRecreated` callback → bind group manager recreates the textured bind group

### Why 2D Array Texture?

A 2D array texture allows the shader to index layers by `u32` — the instance buffer stores `atlasLayerIndex` per pattern/stamp. One draw call renders all instances, each sampling a different layer. This avoids per-texture bind group switching.

---

## PatternAtlas

**File:** `src/renderer/caches/texture-cache/pattern-atlas.ts`

A simpler, smaller atlas (256×256, 64 layers) used by the legacy pattern pipeline. Owns its own `GPUBindGroupLayout` with 3 bindings:
- Storage buffer (instance data)
- 2D array texture
- Sampler

**Does not support growth** — throws on overflow. Legacy path, secondary to TextureArrayAtlas.

---

## TextureCache

**File:** `src/renderer/caches/texture-cache/texture-cache.ts`

A static singleton for fetching and caching images/textures from URLs.

### Two Caching Paths

**`getImageBitmap(url): Promise<ImageBitmap>`**
- Fetches the image, decodes to `ImageBitmap`
- Cached in `Map<string, ImageBitmap>`
- Used for feeding into atlases

**`getTexture(device, url): Promise<GPUTexture>`**
- Fetches the image, creates a standalone `GPUTexture` (rgba8unorm)
- Cached in `Map<string, GPUTexture>`
- Legacy path for one-texture-per-shape rendering

Both handle concurrent requests — if the same URL is requested twice before the first completes, the second request reuses the in-flight promise.

---

## TexturedInstanceBuffer

**File:** `src/renderer/caches/texture-cache/textured-instance-buffer.ts`

The CPU-side + GPU buffer for instanced textured quad rendering. Each instance = 256 bytes:

```
Bytes 0–63:    worldMatrix (mat4)       — camera transform
Bytes 64–127:  localMatrix (mat4)       — shape transform
Bytes 128–143: UV scale + offset        — texture mapping
Bytes 144–147: atlasLayerIndex (u32)    — which layer in the 2D array texture
Bytes 148–151: flags (u32)              — 1=pattern, 2=stamp
Bytes 152–167: tintColor (vec4 float)   — color modulation
Bytes 168–255: padding
```

### Per-Frame Usage

```
beginFrame():
  reset instanceCount to 0

For each Pattern/Stamp in scene:
  ensure(n)              // grow buffer if needed
  write(i, instanceData) // pack transform, UV, layer index
  
render():
  device.queue.writeBuffer(gpuBuffer, 0, cpuArray)
  passEncoder.setPipeline(texturedPipeline)
  passEncoder.draw(6, instanceCount)  // one quad × N instances
```

The shader reads per-instance data from the storage buffer, uses `instance_index` to index, and samples `textureArray[layerIndex]`.

---

## StampRegistry

**File:** `src/renderer/caches/texture-cache/stamp-registry.ts`

A trivial `Map<string, any>` for maintaining stamp definitions (name, URL, metadata). No GPU interaction — purely bookkeeping.

---

## SDF Text Atlas

**File:** `src/scene-graph/shapes/sdf-text/sdf-text-atlas.ts`

A specialized single-layer 2D texture atlas for SDF glyphs. See [09 — Text Rendering](09-text-rendering.md) for details.

Key differences from TextureArrayAtlas:
- Single 2D texture (not array) — all glyphs packed in rows
- Row-based packing with gutter spacing
- Glyphs are rasterized + SDF-computed via GPU compute (Jump Flood Algorithm)
- Grows by 2× (width or height) when full, GPU-copies old content
- Version counter for bind group rebuild tracking
- Retired texture cleanup via double-buffered sweep

---

## How Textures Flow Through the System

### Pattern / Stamp Flow

```
1. ShapeFactory creates Pattern/Stamp with textureKey
2. During beginFrame(), render strategy calls atlas.ensure(textureKey)
3. Atlas fetches image → uploads to a layer → returns layerIndex
4. Render strategy writes instance data (layerIndex, transform) to TexturedInstanceBuffer
5. During render(), one drawInstanced() call renders all patterns/stamps
6. Vertex shader: instance_index → read transform from storage buffer
7. Fragment shader: sample textureArray[layerIndex] at UV
```

### LiveTextNode Flow

```
1. LiveTextNode.updateTexture() captures HTML/canvas → GPUTexture (individual, not atlas)
2. TextEffectEngine.applyChain() processes effects → output GPUTexture
3. During render(), drawLiveTextNodes():
   - Packs all node quads into one vertex buffer
   - Per-node: create bind group with node's unique texture
   - Per-node: drawIndexed(6)
```

### SDF Text Flow

```
1. SDFText.generateGlyphQuads() → for each char, atlas.addCharacter()
2. Atlas rasterizes char on OffscreenCanvas → GPU compute JFA → SDF stored in atlas texture
3. Geometry cache writes per-glyph quads with (pos, atlasUV)
4. During render(), one drawIndexedIndirect() for all SDF text shapes
5. Shared bind group: atlas texture view + sampler + storage buffer
6. Fragment shader: sample atlas at UV, smoothstep on SDF distance
```
