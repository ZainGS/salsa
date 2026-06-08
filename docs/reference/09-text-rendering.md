# 09 — Text Rendering
**Last Updated:** 2026-05-09  

Salsa has three text systems, each serving a different use case:

| System | Use Case | Rendering Method |
|--------|----------|-----------------|
| **SDF Text** | Scene text (labels, sticky notes, speech balloons) | Glyph quads from SDF atlas, scales cleanly at any zoom |
| **LiveText** | Rich text with shader effects | GPU texture captured from HTML/canvas each frame |
| **Legacy Text** | Deprecated | Canvas 2D → texture upload |

---

## Part 1: SDF Text

**Files:** `src/scene-graph/shapes/sdf-text/`

### What is SDF Rendering?

Signed Distance Field (SDF) rendering stores glyphs not as bitmaps but as **distance fields** — each texel encodes the distance to the nearest edge of the glyph outline. Positive = outside, negative = inside.

The fragment shader applies a threshold: `if (distance < threshold) → glyph pixel, else → transparent`.

**Advantages:**
- Crisp text at **any zoom level** (no pixelation)
- Configurable **smoothing** (anti-aliasing width)
- Easy **outlines** (draw at slightly larger threshold with a different color)
- Small atlas (one SDF per glyph serves all sizes)

### SDF Text Atlas

**File:** `src/scene-graph/shapes/sdf-text/sdf-text-atlas.ts`

A single `GPUTexture` (starts at 1024×1024, grows by 2×) that packs all glyph SDFs:

```
┌──────────────────────────────────────────┐
│ A  B  C  D  E  F  G  H  I  J  K  ...    │ ← row 0
│ L  M  N  O  P  Q  R  S  T  U  V  ...    │ ← row 1
│ W  X  Y  Z  a  b  c  d  e  f  g  ...    │ ← row 2
│ (free space for new glyphs)              │
│                                          │
└──────────────────────────────────────────┘
```

**Key concepts:**
- **Gutter:** 4 texels between glyphs (prevents SDF bleed)
- **Row packing:** Glyphs are placed left-to-right in rows, advancing to a new row when the current one fills
- **Supersample factor:** 8× — glyphs are rasterized at 8× their natural size before SDF conversion
- **Character key:** `"char-fontSize-fontFamily"` — deduplicates across all SDFText nodes
- **Growth:** When the atlas fills, a new 2× texture is created, old content GPU-copied, and a `onAtlasRecreated` callback fires so bind groups can be rebuilt
- **Version counter:** Bumped on every atlas recreate so the bind group manager knows to rebuild
- **Compaction:** When `atlasSize >= 4096` (64 MB), `WebGPURenderer.handleAtlasCompactIfNeeded()` calls `atlas.compact()` — wipes the charMap, resets the packing cursor, and replaces the GPU texture with a fresh 1024×1024. It then calls `refreshText()` on every live `SDFText` node, which re-adds only the glyphs that are actually in use. The atlas re-grows naturally to the minimum size the scene needs. A `_lastCompactedAtVersion` guard prevents re-running when live glyphs already fill a large atlas. After repopulation, `atlas.bumpVersion()` triggers `handleAtlasChangeIfNeeded()` to rebuild the bind group on the same frame.

**Character info stored per glyph:**
```typescript
interface CharacterInfo {
    atlasX: number;     // UV position in atlas
    atlasY: number;
    texWidth: number;   // Size in atlas texels
    texHeight: number;
    width: number;      // Glyph metrics (for layout)
    height: number;
    advance: number;    // Horizontal advance
    bearingX: number;   // Offset from baseline
    bearingY: number;
}
```

### SDF Generation: Jump Flood Algorithm

**File:** `src/scene-graph/shapes/sdf-text/sdf-glyph-compute.ts`

When a new glyph is needed:

1. **Rasterize:** Render the character on an OffscreenCanvas at 8× size using Canvas 2D
2. **Upload:** Copy the bitmap to a GPU texture
3. **Init pipeline:** GPU compute shader seeds edge pixels (where alpha transitions from 0→1)
4. **JFA passes:** Log₂(texSize) iterations of the Jump Flood Algorithm:
   - Each pixel looks at 8 neighbors at distance `2^n` (decreasing each pass)
   - Propagates the nearest seed pixel
5. **Finalize pipeline:** Converts seed distances to actual SDF values (signed float → 8-bit unorm)
6. **Copy:** Blit the SDF into the atlas at the allocated position

The JFA uses temporary `rgba32float` textures for the intermediate passes.

### SDFText Node

**File:** `src/scene-graph/shapes/sdf-text/sdf-text.ts`

**Key properties:**
| Property | Type | Purpose |
|----------|------|---------|
| `text` | `string` | The text content |
| `font` | `string` | Font family name |
| `fontSize` | `number` | Size in pixels |
| `sdfThreshold` | `number` | Edge threshold (default 0.5) |
| `smoothing` | `number` | Anti-aliasing width (default 10) |
| `outlineWidth` | `number` | Outline thickness (0 = no outline) |
| `outlineColor` | `RGBA` | Outline color |
| `align` | `string` | Horizontal alignment |
| `valign` | `string` | Vertical alignment |
| `writingMode` | `string` | Horizontal or vertical text |
| `lineHeight` | `number` | Line spacing multiplier |

**Glyph quad generation (`generateGlyphQuads()`):**
1. For each character, call `sdfAtlas.addCharacter(char, fontSize, font)` — ensures glyph exists in atlas
2. Lay out characters horizontally (or vertically), handling word wrap and line breaks
3. For each character, produce a `GlyphQuad`: position (x, y, width, height) + atlas UV (u, v, texW, texH)
4. The geometry cache converts each quad to 4 vertices (pos + UV) and 6 indices (2 triangles)

**Caret system (for text editing):**
- `caretIndex`, `caretVisible` — blinking cursor position
- `selectionStart`, `selectionEnd` — text selection range
- `caretPositions[]` — computed x-coordinates for each character boundary
- `getCaretIndexAtWorldPos(x, y)` — hit-tests for click-to-place caret
- `getSelectionRects()` — returns rectangles for selection highlighting

### SDF Text Shader

The vertex shader reads per-glyph (x, y, atlasU, atlasV) and transforms by localMatrix × worldMatrix.

The fragment shader:
```wgsl
fn fragment(uv: vec2f) -> vec4f {
    let dist = textureSample(sdfAtlas, sdfSampler, uv).r;
    
    // Main glyph
    let alpha = smoothstep(threshold - smoothing, threshold + smoothing, dist);
    var color = fillColor * alpha;
    
    // Outline (if outlineWidth > 0)
    let outerThreshold = threshold - outlineWidth;
    let outlineAlpha = smoothstep(outerThreshold - smoothing, outerThreshold + smoothing, dist);
    color = mix(outlineColor * outlineAlpha, color, alpha);
    
    return color;
}
```

---

## Part 2: LiveText (HTML-in-Canvas)

**File:** `src/scene-graph/shapes/live-text.ts`

LiveTextNode renders arbitrary HTML text (with fonts, styles, effects) as a GPU texture that's updated each frame.

### Two Capture Paths

#### Path A: HTML-in-Canvas (Chrome experimental)

When available (`chrome://flags → enable-experimental-web-platform-features`):

1. A hidden `<div>` is created as a child of `<canvas layoutsubtree>`
2. Text content is set as innerHTML with full CSS styling
3. Chrome's `GPUQueue.copyElementImageToTexture()` captures the element directly to GPU texture
4. No CPU readback — zero-copy GPU capture

**Detection:** `TextEffectEngine.htmlInCanvasMode()` checks for `GPUQueue.copyElementImageToTexture` (WebGPU native) or `texElementImage2D` (WebGL bridge).

#### Path B: OffscreenCanvas Fallback (universal)

1. Create an `OffscreenCanvas` sized to the text bounds + padding
2. Get a 2D context, set font/color/style
3. Call `fillText()` (with word wrapping)
4. Upload to GPU via `device.queue.copyExternalImageToTexture()`

The fallback is always available. HTML-in-Canvas is only used during active editing (for live cursor/selection/IME rendering).

### Editing System

When the user double-clicks a LiveTextNode to edit:

1. `beginEditing()` creates a hidden `<textarea>` in the DOM
2. The textarea receives keyboard input (IME, clipboard, undo/redo for free)
3. On HTML-in-Canvas path: the `<div>` DOM element shows a visual text cursor and selection highlights
4. On fallback path: the OffscreenCanvas is re-rendered each frame
5. `endEditing()` syncs final text from textarea, destroys it

### Unit-Quad Dimension Model

LiveTextNode uses a different dimension model than other shapes:

```
_width = 1, _height = 1     (always unit quad)
scaleX = textWorldWidth      (actual world-space size)
scaleY = textWorldHeight

_localMatrix = translate(x,y) × rotate(rot) × scale(scaleX, scaleY)
```

The quad vertices are always at ±0.5. The `_localMatrix` scale encodes the visual size. This makes the scaling handle system work correctly — the handle code reads `baseW = _width = 1` and manipulates `scaleX`/`scaleY` as absolute sizes.

**The `_hasUserScale` flag** prevents `updateTexture()` from overwriting manually-applied scale (from the transform handles). Once the user scales the node, the flag is set and texture re-capture no longer changes scaleX/scaleY.

### Effect Chain

LiveTextNode supports a pipeline of GPU compute effects applied to the captured texture each frame:

```
Source texture → Effect 1 → Effect 2 → ... → Final output texture
```

The `TextEffectEngine` (`src/renderer/raster/effects/text-effect-engine.ts`) provides:

| Effect | Key Parameters |
|--------|---------------|
| Chromatic Aberration | strength, angle, cursor-reactive |
| Glow | radius, intensity, color |
| Wave | amplitude, frequency, speed (animated) |
| Glitch | intensity, blockSize (animated) |
| Outline | thickness, color |
| Custom | User-written WGSL shader body |

**Dynamic uniforms** (fed per frame by the render strategy):
- `time` — seconds since start (for animation)
- `cursorUV` — normalized mouse position relative to the node
- `mouseDown` — boolean for interactive effects

**Custom shaders** receive auto-provided bindings:
```wgsl
@group(0) @binding(0) var src: texture_2d<f32>;      // Source texture
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;  // Output
@group(0) @binding(2) var<uniform> u: Uniforms;       // resolution, time, mouse, 4 user params
```

### Rendering

LiveTextNodes are drawn AFTER all vector shapes. The renderer:
1. Collects all LiveTextNodes during `beginFrame()`
2. Packs all quad vertices into a single GPU buffer (one write)
3. For each node, creates a bind group with the node's unique texture
4. Issues `drawIndexed(6)` per node with byte offsets

---

## Part 3: Legacy Text

**File:** `src/scene-graph/shapes/text.ts`

The original text system:
1. Renders text via Canvas 2D `fillText()`
2. Uploads the canvas as a GPU texture
3. Draws as a textured quad via `textPipeline`
4. Has basic caret blinking support

**Status:** Superseded by SDFText (for scene text) and LiveText (for rich text with effects). Still present in the codebase but not used for new features.

---

## Comparison

| Feature | SDF Text | LiveText | Legacy Text |
|---------|----------|----------|-------------|
| Zoom quality | Infinite (SDF) | Re-captured each edit | Fixed resolution |
| Outlines | Yes (shader) | Yes (via effects) | No |
| Animations | No | Yes (wave, glitch, etc.) | No |
| Editing | Built-in caret | Textarea + DOM | Basic caret |
| Performance | Excellent (cached atlas) | Per-frame capture | Per-edit capture |
| Rich formatting | No (single font/size) | Yes (HTML/CSS) | No |
| Use case | Labels, sticky notes | Title text, manga SFX | Deprecated |
