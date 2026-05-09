# 08 — Raster Rendering & Layer Compositor

Salsa's raster system is a full GPU-powered digital painting pipeline with multi-layer compositing, per-layer effects, brush dynamics, and real-time dithering. It co-exists with the vector system — raster layers are composited as a single textured quad that renders underneath vector shapes.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    RasterLayerManager                    │
│  Manages the ordered stack of raster layers              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ Layer 0  │ │ Layer 1  │ │ Layer 2  │  ...            │
│  │ BG       │ │ Inks     │ │ Colors   │                │
│  │ Normal   │ │ Multiply │ │ Screen   │                │
│  │ opacity:1│ │opacity:.8│ │ opacity:1│                │
│  └──────┬───┘ └──────┬───┘ └──────┬───┘                │
│         │            │            │                     │
│  ┌──────▼────────────▼────────────▼───┐                 │
│  │        RasterCompositor            │                 │
│  │  GPU compute: blend layers         │                 │
│  │  + dither + grain + onion skin     │                 │
│  └──────────────┬────────────────────┘                 │
│                 ▼                                       │
│          rasterTexture (final composited)               │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼ drawn as textured quad in render pass
          ┌──────────────┐
          │ Screen pixel │
          └──────────────┘
```

---

## Raster Layers

**File:** `src/services/raster-layer-manager.ts`

Each layer is a **full-resolution GPU texture** (sized to the illustration bounds):

```typescript
interface RasterLayer {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    blendMode: LayerBlendMode;
    opacity: number;           // 0.0–1.0
    clipped: boolean;          // Clip to alpha of layer below
    lockTransparency: boolean; // Only paint on existing pixels
    texture: GPUTexture;       // rgba8unorm, illustration-sized
    manager: RasterTextureManager; // Owns the GPU resources
    ditherConfig?: DitherConfig;   // Per-layer dithering
    frameLinkAnimation?: FrameLinkAnimation; // Per-layer displacement animation
}
```

### Layer Operations

| Operation | What Happens |
|-----------|-------------|
| `addLayer(name)` | Creates new GPUTexture, initializes RasterTextureManager, registers with animation timeline |
| `deleteLayer(id)` | Destroys texture + manager, unregisters from timeline |
| `selectLayer(id)` | Notifies renderer via callback — painting goes to this layer's texture |
| `setBlendMode(id, mode)` | Changes compositing blend mode, triggers recomposite |
| `setOpacity(id, val)` | Changes layer opacity, triggers recomposite |
| `setClipped(id, bool)` | Enables/disables clipping to alpha of layer below |
| `setDitherConfig(id, cfg)` | Enables per-layer dithering (algorithm, levels, etc.) |
| `setFrameLinkAnimation(id, anim)` | Assigns displacement animation (wave, shake, ripple, etc.) |

### Blend Modes

The compositor supports 12 blend modes:

| Mode | Formula |
|------|---------|
| Normal | `src × α + dst × (1-α)` |
| Multiply | `src × dst` |
| Screen | `1 - (1-src) × (1-dst)` |
| Overlay | `if dst < 0.5: 2×src×dst, else: 1 - 2×(1-src)×(1-dst)` |
| Soft Light | Pegtop formula |
| Hard Light | Overlay with src/dst swapped |
| Color Dodge | `dst / (1 - src)` |
| Color Burn | `1 - (1 - dst) / src` |
| Darken | `min(src, dst)` |
| Lighten | `max(src, dst)` |
| Add/Glow | `src + dst` (clamped) |
| Difference | `abs(src - dst)` |

---

## RasterCompositor

**File:** `src/renderer/raster/core/raster-compositor.ts`

The compositor is a **GPU compute** pipeline that flattens the layer stack into a single output texture.

### Compositing Flow

```
For each layer (back-to-front):
    1. Read layer texture
    2. Apply displacement animation (if configured)
    3. Apply per-layer dithering (if configured)
    4. Blend with accumulated result using layer's blend mode + opacity
    5. If clipped: multiply result alpha by layer-below alpha
    
After all layers:
    6. Apply global dithering (if enabled)
    7. Apply onion skin overlay (if enabled)
    8. Apply canvas grain overlay (if enabled)
    9. Output → rasterTexture
```

Each step is a separate compute dispatch reading from ping texture and writing to pong texture (or vice versa).

### Displacement Animations (FrameLink)

Each layer can have a displacement animation that shifts pixels procedurally:

| Animation | Effect |
|-----------|--------|
| `wave` | Sinusoidal horizontal/vertical displacement |
| `shake` | Random per-row offset |
| `ripple` | Radial sinusoidal displacement from center |
| `noise` | Perlin-noise-based warping |
| `turbulence` | Multi-octave noise displacement |

Parameters: amplitude, frequency, speed, time. The compute shader reads from the layer texture at offset UV coordinates.

---

## Painting System

### RasterPaintEngine

**File:** `src/renderer/raster/core/raster-paint-engine.ts`

The top-level painting coordinator. Owns:
- `BrushEngine` — dab stamping with dynamics
- `RasterSnapshotManager` — undo/redo texture snapshots
- Brush preset library (create, serialize, load)
- Two `CanvasGrainManager` instances:
  - `brushGrainManager` — per-stroke dab modulation (brush texture)
  - `paperGrainManager` — global paper texture overlay

### BrushEngine

**File:** `src/renderer/raster/brushes/brush-engine.ts`

Handles the core painting math: pressure curves, spacing, rotation dynamics, and dab stamping.

**Stroke lifecycle:**
```
beginStroke(x, y, pressure)  → snapshot for undo, initialize state
addStrokePoint(x, y, pressure) → compute dab positions along path
                                 → for each dab: dispatch GPU compute
endStroke()                  → finalize, save undo state
```

**Dab spacing:** Dabs are placed along the stroke path at intervals of `spacing × diameter`. If the cursor moves less than one spacing, no dabs are emitted.

### BrushStampPipeline

**File:** `src/renderer/raster/brushes/brush-stamp-pipeline.ts`

A **GPU compute shader** that stamps individual brush dabs onto the raster texture.

```wgsl
// Compute shader: for each pixel in the dab's bounding box:
1. Check if pixel is inside the dab circle (distance from center ≤ radius)
2. Apply brush tip mask (circular, square, custom)
3. Apply grain/texture modulation
4. Blend with targets texture using selected mode:
   - Paint:      alpha blend (src × α + dst × (1-α))
   - Erase-fade: reduce dst alpha
   - Erase-clear: zero out dst in dab area
   - Erase-hard: cubic falloff erase
5. Apply aspect ratio correction (prevents oval brushes on non-square textures)
```

### Brush Presets

**File:** `src/renderer/raster/brushes/brush-preset.ts`

Pre-configured brush settings (size, opacity, spacing, hardness, dynamics). Serializable to/from JSON. The preset library supports CRUD operations and versioning.

### Brush Stabilizer

**File:** `src/renderer/raster/brushes/brush-stabilizer.ts`

Smooths jittery pointer input by averaging recent positions (moving window). Configured via a stabilization strength parameter.

---

## Dithering

**File:** `src/renderer/raster/effects/dither-engine.ts`

The dither engine supports two classes of algorithms:

### GPU-Based (ordered dithering)
- **Bayer** — threshold matrix dithering (2×2, 4×4, 8×8)
- **Halftone** — circular dot pattern
- **Blue Noise** — noise-texture-based thresholding

These run as GPU compute shaders on the compositor output.

### WASM-Based (error diffusion)
- **Floyd-Steinberg** — classic error diffusion
- **Atkinson** — retro Mac look (distributes only 75% of error)
- **Jarvis-Judice-Ninke** — wide kernel, smooth gradients
- **Stucki** — sharp error diffusion
- **Sierra** — full 3-row kernel
- **Sierra Lite** — lightweight 2-row variant

These run on the CPU via WebAssembly (Rust). The compositor reads back the GPU texture, runs WASM, and re-uploads. Error diffusion requires sequential pixel processing and can't be parallelized on the GPU.

### DitherConfig

```typescript
interface DitherConfig {
    enabled: boolean;
    algorithm: 'bayer' | 'halftone' | 'blue-noise' | 'floyd-steinberg' | ...;
    levels: number;    // 2 = 1-bit, 4 = 2-bit, etc.
    strength: number;  // 0.0–1.0 mix factor
}
```

Dithering can be applied:
- **Per-layer** — via `RasterLayerManager.setDitherConfig(layerId, config)`
- **Globally** — as a post-composite step

---

## Canvas Grain

**File:** `src/renderer/raster/canvas-grain.ts`

Simulates paper texture by overlaying a noise pattern on the final composite:

- **Grain texture generation:** Perlin noise or custom texture loaded into a GPUTexture
- **Overlay blending:** Multiplicative or soft-light blend in the compositor compute pass
- **Parameters:** grain intensity, scale, seed

Two independent grain managers exist:
1. **Paper grain** — global overlay on the composite output (paper texture feel)
2. **Brush grain** — per-dab modulation during painting (brush texture)

---

## Raster Selection

### RasterSelectionEngine

**File:** `src/renderer/raster/selection/raster-selection-engine.ts`

GPU-accelerated pixel selection tools:
- **Marquee** (rectangle)
- **Ellipse** selection
- **Lasso** (freeform polygon)
- **Magic Wand** (flood-fill-based, with tolerance and contiguous options)

All produce a **selection mask** (`RasterSelectionMask`) — a 1-bit-per-pixel GPU texture.

### RasterTransformEngine

**File:** `src/renderer/raster/selection/raster-transform-engine.ts`

Transforms selected pixels (move, scale, rotate) as a "floating selection" layer. The pixels are lifted from the source layer, transformed, and composited back on commit.

### SelectionOverlayRenderer

**File:** `src/renderer/raster/selection/selection-overlay-renderer.ts`

Draws the selection visualization:
- **Marching ants** — animated dashed outline around the selection
- **Transform handles** — corners and edges for scaling the selection

---

## Undo / Redo

### RasterSnapshotManager

**File:** `src/renderer/raster/core/raster-snapshot-manager.ts`

CPU-side texture snapshots for undo/redo:
- Before each stroke, the active layer's texture is read back and stored as a `Uint8Array`
- Max 50 snapshots in the stack
- `undo()` uploads the previous snapshot back to the GPU texture
- `redo()` uploads the next snapshot

Snapshots are tightly packed (RGBA rows only for the affected dirty rect) to minimize memory.

---

## Flood Fill

**File:** `src/renderer/raster/tools/flood-fill-engine.ts`

The paint bucket tool. Reads the active layer texture, performs a scanline flood fill from the click point, and writes the filled area back. Tolerance-based color matching for anti-aliased edges.

---

## OPFS Document Persistence

Raster layer pixel data is saved to and loaded from the browser's **Origin Private File System (OPFS)**, not the WebGPU texture directly.

### Storage Format

Each layer's pixel data is stored as a raw **RGBA `ArrayBuffer`** (`Uint8Array`, 4 bytes per pixel at document resolution). This avoids the encode/decode overhead of image formats (WebP, PNG) on every save/load cycle.

```
OPFS layout per document:
  <docId>/
    manifest.json          — layer metadata (names, blend modes, opacity, etc.)
    scene.json             — vector scene graph
    layers/
      <layerId>.bin        — raw RGBA bytes for each layer
    cels/
      <celId>.bin          — raw RGBA bytes for each animation cel
    scene3d.json           — 3D mesh node states
    models3d/
      <meshId>.glb         — raw GLB buffers for imported meshes
    textures3d.json        — TextureLibrary snapshot (base64 WebP data URLs)
```

### Parallel Load

`DocumentPersistence.loadDocument()` reads all layer and cel pixel files **concurrently** using `Promise.all`:

```typescript
// All layer .bin reads start at once; total time ≈ slowest single read
const results = await Promise.all(
  manifest.layers.map(async (entry) => {
    const pixels = await readBinary(layersDir, `${entry.id}.bin`);
    return pixels ? { id: entry.id, pixelData: pixels } : null;
  }),
);
```

The same pattern applies to animation cel files. On a document with 9 layers, this brings the total OPFS read time from ~341ms (sequential) down to roughly the time of the single largest layer.

After reads complete, `uploadPixelsToLayer()` calls `device.queue.writeTexture()` synchronously for each layer — no async overhead on the upload side.

---

## Viewport Resize Safety

Raster layer textures store **document-resolution pixel data** — they must never be resized when the browser viewport changes. `WebGPURenderer.setCanvasSize()` adjusts the swap chain canvas to match the current viewport (DPR-scaled), but it does **not** call `RasterLayerManager.setSize()`.

`setSize()` is legitimate only for true document-dimension changes (`setDocumentSize()`, `clearDocumentSize()`, initial load). Calling it on viewport changes would call `ensureTexture()` on every layer, which would destroy and recreate each texture as blank.

`RasterTextureManager.ensureTexture(w, h)` copies the old texture content to the new one before destroying it, so pixel data is preserved for legitimate document-size changes:

```
ensureTexture(w, h):
  if dimensions unchanged → return existing texture
  create new texture at w×h
  if old texture exists → GPU copy min(old, new) region → destroy old
  return new texture
```

---

## How Raster Composites Into the Render Pass

In the main `render()` method:

```typescript
// 1. Run compositor (GPU compute passes)
this._rasterCompositor.composite(layers, rasterTexture, options);

// 2. Draw composited texture as a world-space quad using rasterPipeline
const bg = device.createBindGroup({
    entries: [
        { binding: 0, resource: rasterTexture.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: rasterWorldBuf } }, // world transform
    ],
});
passEncoder.setPipeline(rasterPipeline);
passEncoder.setBindGroup(0, bg);
passEncoder.setVertexBuffer(0, rasterQuadVB);  // fullscreen quad
passEncoder.drawIndexed(6);
```

The raster texture appears as a flat surface in world space, positioned and sized to match the illustration bounds. Vector shapes render on top of it.
