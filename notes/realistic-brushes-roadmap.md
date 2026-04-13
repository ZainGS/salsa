# Realistic Brush Engine — Roadmap & Architecture

> **Status**: Active Development  
> **Last updated**: April 2026

## Table of Contents
1. [How Professional Brush Makers Achieve Realism](#how-professional-brush-makers-achieve-realism)
2. [Engine Feature Matrix](#engine-feature-matrix)
3. [Implementation Roadmap](#implementation-roadmap)
4. [Dual Brush System](#1-dual-brush-shape--texture)
5. [Color Jitter](#2-color-jitter)
6. [Wet Edges](#3-wet-edges)
7. [Stroke Texture Mapping](#4-stroke-texture-mapping)
8. [Built-in Brush Packs](#built-in-brush-packs)
9. [Scanned Texture Guidelines](#scanned-texture-guidelines)
10. [ShapeManager API Reference](#shapemanager-api-reference-for-frogmarks)

---

## How Professional Brush Makers Achieve Realism

Studios like True Grit Texture Supply, Kyle T. Webster, and Procreate's built-in brush
team follow the same formula:

**90% textures, 10% engine features.**

They scan/photograph real media (ink on paper, marker bleeds, watercolor washes) at
high DPI (600-1200+), clean up the alpha channel in Photoshop, then use the engine's
features to combine them expressively. The key ingredients:

| Technique | What it does | Engine requirement |
|-----------|-------------|-------------------|
| **Image tip textures** | Real scanned ink/marker marks as the dab shape | Tip texture sampling |
| **Dual brush (shape × texture)** | Multiply a shape mask with a grunge texture per dab | Two-texture system |
| **Canvas grain** | Paper/canvas texture modulates brush alpha globally | Grain pipeline |
| **Pressure → size/opacity/flow** | Dynamic response to pen input | Dynamics curves |
| **Wet-stroke accumulation** | Max-alpha prevents opacity buildup | Stroke lifecycle |
| **Color jitter** | Per-dab hue/sat/brightness variation | Random color offset |
| **Wet edges** | Darken/concentrate pigment at stroke borders | Edge detection pass |
| **Bleed / diffusion** | Paint spreads beyond the stroke edge | Post-process blur |
| **Stroke texture mapping** | Tile a texture *along* the stroke path | UV-mapped stroke |

### Why Textures + Engine > Pure Procedural

- **Programmatic**: hardness falloff, roundness, noise jitter, wet edges, bleed.
  These are engine features that *all* brushes benefit from.
- **Textures (scanned)**: the specific character of a particular marker brand,
  a particular paper, a particular ink. No algorithm will replicate the exact fiber
  pattern of a Copic marker on Strathmore paper — you scan it.

The engine needs to **support the features that combine textures expressively**.

---

## Engine Feature Matrix

| Feature | Status | Impact | Complexity |
|---------|--------|--------|------------|
| Image tip textures (r8unorm) | ✅ Shipped | High | — |
| Canvas grain (paper texture) | ✅ Shipped | Medium | — |
| Pressure dynamics (size/opacity/flow) | ✅ Shipped | High | — |
| Wet-stroke accumulation (max-alpha) | ✅ Shipped | High | — |
| Tip rotation / scatter / jitter | ✅ Shipped | Medium | — |
| **Dual brush (shape × texture)** | ✅ Shipped | **Highest** | Medium |
| **Color jitter (H/S/B per dab)** | ✅ Shipped | Medium | Low |
| **Wet edges** | ✅ Shipped | High | Medium |
| **Stroke texture mapping** | ✅ Shipped | High | High |
| Bleed / diffusion | 📋 Planned | Medium | High |
| Color mixing (smudge) | 📋 Planned | High | High |

---

## Implementation Roadmap

### Phase 1: Dual Brush (Highest Visual Impact)
Every realistic brush preset uses this. The final dab alpha becomes:
```
dabAlpha = tipTexture(uv) × dualBrushTexture(uv) × pressure × flow
```

**Architecture:**
- Add `DualBrushSettings` to `BrushPreset`
- Add a second texture binding in the stamp compute shader
- Sample the dual brush texture at dab-local or tiling UVs
- Multiply with the tip alpha before blending

### Phase 2: Color Jitter
Per-dab random variation in hue, saturation, and brightness. Makes watercolor/gouache
look alive instead of dead-flat.

**Architecture:**
- Add `ColorJitter` fields to `BrushDynamics`
- In `stampDab()`, apply random HSB offsets to the stroke color before dispatch
- Seed from dab position + stroke ID for deterministic replay

### Phase 3: Wet Edges
A post-process on the stroke accumulation layer that detects alpha edges and darkens them.
This single effect sells "watercolor" more than anything.

**Architecture:**
- After all dabs in a stroke, run a compute pass on `strokeAccumTex`
- Detect edge pixels (where alpha transitions from >0 to ~0 in the neighborhood)
- Darken and concentrate alpha at the edges
- Controls: edge width, darkness, spread

### Phase 4: Stroke Texture Mapping
Instead of stamping individual round dabs, map a rectangular texture strip along the
stroke polyline. This is how charcoal, crayon, and marker brushes achieve continuous
fibrous looks without visible dab spacing.

**Architecture:**
- Store the stroke polyline (position, pressure, width at each vertex)
- Generate a triangle strip mesh along the path
- UV-map the mesh so `u` runs 0→1 across the width, `v` tiles along the length
- Render the strip with the stroke texture into the stroke accumulation layer

---

## 1. Dual Brush (Shape × Texture)

### Preset Schema

```typescript
interface DualBrushSettings {
  /** Enable the dual brush texture. */
  enabled: boolean;
  /** Base64-encoded grayscale PNG texture (tiles within the dab). */
  textureData: string;
  /** Native resolution of the texture image. */
  textureSize: number;
  /** How the texture tiles within the dab: 'dab-local' | 'canvas-tiling'. */
  tileMode: 'dab-local' | 'canvas-tiling';
  /** Scale of the texture relative to the dab (1 = 1:1). */
  scale: number;
  /** Blend operation: how texture combines with tip shape. */
  blendOp: 'multiply' | 'subtract' | 'minimum';
  /** Texture strength: 0 = no effect, 1 = full texture. */
  strength: number;
  /** Random rotation per dab (true = adds organic variation). */
  randomRotation: boolean;
}
```

### Shader Changes (brush-stamp-pipeline.ts)

New binding: `@group(0) @binding(11) var dualTex: texture_2d<f32>;`

In the main function, after sampling `tipAlpha`:
```wgsl
// Dual brush texture modulation
if (dualStrength > 0.001) {
  let dualUV = ...; // dab-local or canvas-tiling UV
  let dualVal = textureSampleLevel(dualTex, tipSamp, dualUV, 0.0).r;
  if (dualBlendOp == 0) { // multiply
    tipAlpha = tipAlpha * mix(1.0, dualVal, dualStrength);
  } else if (dualBlendOp == 1) { // subtract
    tipAlpha = tipAlpha * mix(1.0, 1.0 - dualVal, dualStrength);
  } else { // minimum
    tipAlpha = min(tipAlpha, mix(tipAlpha, dualVal, dualStrength));
  }
}
```

---

## 2. Color Jitter

### Preset Schema

```typescript
interface ColorJitter {
  /** Per-dab hue variation (±degrees, 0-180). */
  hueJitter: number;
  /** Per-dab saturation variation (±amount, 0-1). */
  saturationJitter: number;
  /** Per-dab brightness variation (±amount, 0-1). */
  brightnessJitter: number;
  /** Per-dab opacity variation (±amount, 0-1). */
  opacityJitter: number;
}
```

### Implementation (brush-engine.ts)

In `stampDab()`, before dispatching:
```typescript
if (jitter.hueJitter > 0 || jitter.saturationJitter > 0 || jitter.brightnessJitter > 0) {
  let [h, s, b] = rgbToHsb(color[0], color[1], color[2]);
  h += (Math.random() - 0.5) * 2 * jitter.hueJitter / 360;
  s += (Math.random() - 0.5) * 2 * jitter.saturationJitter;
  b += (Math.random() - 0.5) * 2 * jitter.brightnessJitter;
  [color[0], color[1], color[2]] = hsbToRgb(clamp01(h % 1), clamp01(s), clamp01(b));
}
```

---

## 3. Wet Edges

### Compute Shader (post-stroke pass)

```wgsl
// For each pixel in strokeAccumTex:
// 1. Sample 3×3 neighborhood alpha
// 2. Compute edge factor = current alpha × (1 - min neighbor alpha)
// 3. Darken RGB and boost alpha at edges
let edgeFactor = srcAlpha * (1.0 - minNeighborAlpha);
let wetEdgeAlpha = srcAlpha + edgeFactor * wetEdgeStrength;
let wetEdgeRGB = srcRGB * (1.0 - edgeFactor * wetEdgeDarkening);
```

### Preset Schema

```typescript
interface WetEdgeSettings {
  enabled: boolean;
  /** How dark the edges become (0-1). */
  edgeDarkness: number;
  /** How wide the edge detection kernel is (1-5 px). */
  edgeWidth: number;
  /** Overall strength of the wet edge effect (0-1). */
  strength: number;
}
```

---

## 4. Stroke Texture Mapping

### Architecture

Instead of dab-based rendering, a stroke texture brush:
1. Captures the full polyline during the stroke
2. On `endStroke()`, generates a triangle strip mesh from the polyline
3. UV-maps the mesh: `u` = 0→1 across width, `v` = tiles along length
4. Renders the strip into the accumulation layer using a texture

This is best for: charcoal, crayon, dry marker, pencil lead, chalk.

### Preset Schema

```typescript
interface StrokeTextureSettings {
  enabled: boolean;
  /** Base64 grayscale PNG: the texture strip (horizontal = across stroke, vertical = along). */
  textureData: string;
  /** How many pixels of texture per world-unit of stroke length. */
  texelsPerUnit: number;
  /** Edge softness / feather amount (0-1). */
  edgeSoftness: number;
}
```

---

## Built-in Brush Packs

Each pack ships as a JSON array of `BrushPreset` objects referencing texture IDs.
Textures are shipped as optimized assets (WebP or PNG, bundled in the app).

### Pack Categories

| Pack Name | Key Techniques Used | Style |
|-----------|-------------------|-------|
| **Distressed Inking** | Scanned ink tips + dual brush grunge + wet edges | Comic, editorial illustration |
| **Color Formula** | Soft parametric tips + high color jitter + low flow | Painterly, gouache, poster art |
| **Mono-Weight Liners** | Hard round tips + constant size + no dynamics | Technical drawing, line art |
| **Studio Markers** | Scanned Copic tips + canvas grain + stroke texture | Industrial/fashion design |
| **Pencils & Pastels** | Canvas grain + dual brush paper texture + low opacity | Sketching, figure drawing |
| **Precision Stippling** | Scatter-heavy + tiny hard tips + high spacing | Scientific illustration, tattoo |
| **Distressed Halftone** | Halftone dither + grunge dual brush | Retro, screen-print, punk |
| **Ultra Shady** | Large soft tips + low flow + wet edges + color jitter | Atmospheric, concept art |

### Seamless Paper Textures

Ship as canvas grain presets (separate from brush tips):

| Paper | Description |
|-------|------------|
| Cold Press Watercolor | Heavy tooth, random fiber pattern |
| Hot Press Watercolor | Smooth with subtle grain |
| Bristol Board | Very smooth, minimal texture |
| Kraft Paper | Warm tan, visible fiber |
| Canvas | Woven crosshatch pattern |
| Newsprint | Coarse, visible halftone-like dots |
| Rice Paper | Organic, translucent fibers |
| Linen | Fine parallel fibers |

---

## Scanned Texture Guidelines

For anyone creating textures for the brush engine:

### Tip Textures (dab shapes)
- **Format**: Grayscale PNG, alpha = shape mask
- **Resolution**: 512×512 or 1024×1024 px (power-of-2)
- **Background**: Pure black (transparent)
- **Foreground**: White = full opacity
- **Scanning**: 600-1200 DPI, high-contrast real media on white paper
- **Cleanup**: Levels adjustment → isolate the mark → convert to grayscale

### Dual Brush Textures (grunge/grain overlays)
- **Format**: Grayscale PNG, tileable
- **Resolution**: 256×256 to 512×512 (tiles, so smaller is fine)
- **Must tile seamlessly** (use Photoshop offset filter + clone stamp)
- **Good sources**: concrete, paper fiber close-ups, fabric, rust, noise

### Canvas Grain Textures (paper surface)
- **Format**: Grayscale PNG, tileable
- **Resolution**: 512×512 or 1024×1024
- **Must tile seamlessly**
- **Should be subtle** — heavy grain overpowers the brush character

---

## ShapeManager API Reference (for Frogmarks)

All brush features are accessed through `ShapeManager` methods. Frogmarks should
never interact with the GPU layer directly.

### Brush Preset Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `getBrushPresets()` | `() → BrushPreset[]` | Get all registered presets |
| `getBrushPreset(id)` | `(id: string) → BrushPreset \| undefined` | Get preset by ID |
| `setActiveBrushPreset(id)` | `(id: string) → boolean` | Set active brush |
| `getActiveBrushPresetId()` | `() → string \| null` | Get active preset ID |
| `importBrushPreset(json)` | `(json: string) → string \| null` | Import preset, returns ID |
| `exportBrushPresets()` | `() → string` | Export all as JSON |
| `deleteBrushPreset(id)` | `(id: string) → boolean` | Delete a custom preset |
| `updateBrushPreset(id, partial)` | `(id: string, changes: Partial<BrushPreset>) → boolean` | Update preset fields |

### Brush Texture Management (NEW)

| Method | Signature | Description |
|--------|-----------|-------------|
| `loadBrushTipTexture(base64, size)` | `(data: string, size: number) → string` | Load tip texture, returns texture ID |
| `loadDualBrushTexture(base64, size)` | `(data: string, size: number) → string` | Load dual brush texture, returns ID |
| `getLoadedTextureIds()` | `() → string[]` | List all loaded texture IDs |
| `unloadTexture(id)` | `(id: string) → void` | Free a loaded texture |

### Color Jitter (NEW)

| Method | Signature | Description |
|--------|-----------|-------------|
| `setBrushColorJitter(preset)` | `(id: string, jitter: ColorJitter) → boolean` | Set color jitter on a preset |

### Wet Edges (NEW)

| Method | Signature | Description |
|--------|-----------|-------------|
| `setBrushWetEdges(id, settings)` | `(id: string, settings: WetEdgeSettings) → boolean` | Configure wet edges |

### Drawing / Stroke (Existing)

| Method | Signature | Description |
|--------|-----------|-------------|
| `setBrushSize(size)` | `(size: number) → void` | Set brush radius in px |
| `setBrushColor(hex)` | `(hex: string) → void` | Set stroke color |
| `setBrushOpacity(opacity)` | `(opacity: number) → void` | Set global opacity |
| `setEraserMode(enabled)` | `(enabled: boolean) → void` | Toggle eraser |

### Layer Management (Existing)

| Method | Signature | Description |
|--------|-----------|-------------|
| `setRasterLayerBlendMode(id, mode)` | `(id: string, mode: LayerBlendMode) → boolean` | Set blend mode |
| `setRasterLayerOpacity(id, opacity)` | `(id: string, opacity: number) → boolean` | Set layer opacity |
| `setRasterLayerDither(id, config)` | `(id: string, config: DitherConfig) → boolean` | Set layer dither |

### Static Enums

| Property | Type | Description |
|----------|------|-------------|
| `ShapeManager.LayerBlendMode` | `enum` | Normal, Multiply, Screen, etc. |
| `ShapeManager.DualBrushBlendOp` | `enum` | Multiply, Subtract, Minimum (NEW) |

---

## Brush Pack JSON Format

Each pack is a JSON file containing:

```json
{
  "packId": "distressed-inking-v1",
  "packName": "Distressed Inking",
  "version": 1,
  "author": "Frogmarks",
  "textures": [
    {
      "id": "tip-ink-splatter-01",
      "type": "tip",
      "size": 512,
      "data": "<base64 PNG>"
    },
    {
      "id": "dual-concrete-grain",
      "type": "dual",
      "size": 256,
      "data": "<base64 PNG>"
    }
  ],
  "presets": [
    {
      "id": "distressed-ink-heavy",
      "name": "Heavy Distressed Ink",
      "category": "Inking",
      "tip": { "type": "image", "imageData": "ref:tip-ink-splatter-01", "imageSize": 512 },
      "dualBrush": {
        "enabled": true,
        "textureRef": "dual-concrete-grain",
        "tileMode": "dab-local",
        "scale": 1.5,
        "blendOp": "multiply",
        "strength": 0.7,
        "randomRotation": true
      },
      "spacing": 0.08,
      "dynamics": { "..." : "..." },
      "blending": { "mode": "normal", "opacity": 1.0, "flow": 0.9 },
      "wetEdges": { "enabled": true, "edgeDarkness": 0.3, "edgeWidth": 2, "strength": 0.5 },
      "colorJitter": { "hueJitter": 0, "saturationJitter": 0, "brightnessJitter": 0.05, "opacityJitter": 0 }
    }
  ]
}
```
