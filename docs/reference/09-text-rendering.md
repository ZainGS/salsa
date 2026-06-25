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

### Two Architectures (by capability)

#### Path A: HTML-in-Canvas — native inline editing (Chrome 150 + flag)

When available (`chrome://flags/#canvas-draw-element`, an origin-trial API):

1. A `contenteditable` `<div>` lives as a child of `<canvas layoutsubtree>` **full-time** (invisible, but laid out + hit-tested).
2. Each frame, **inside the canvas `onpaint` handler**, `canvas.captureElementImage(el)` snapshots it and `GPUQueue.copyElementImageToTexture({ source: img }, { destination: { texture } })` copies it to a GPU texture. The dest texture is sized to `ceil(elementCSS × backingDPR)` **per axis** — the snapshot rasterizes at the canvas backing resolution, which can be anisotropic; sizing to `img.width` (the CSS size) over/under-fills the copy → misaligned glyphs or a GPU-validation crash. (This was the original disabling bug.)
3. The element **is the editable surface** — focus, caret, selection, and IME are all native on it, and the caret is captured *through* the effect chain. No hidden textarea.
4. The element's CSS transform is synced over the rendered quad every frame, so clicks and the caret land on the glyphs the user sees (the transform is the hit region — ignored for drawing, honored for hit-testing).

Unlike the original design, the element is captured for **display** (every frame, with effects) — not only during editing.

**Detection:** `TextEffectEngine.htmlInCanvasMode()` requires **both** `HTMLCanvasElement.prototype.captureElementImage` and `GPUQueue.prototype.copyElementImageToTexture` (WebGPU native), or `texElementImage2D` (WebGL bridge).

#### Path B: OffscreenCanvas Fallback (universal)

1. Create an `OffscreenCanvas` sized to the text bounds + padding
2. Get a 2D context, set font/color/style
3. Call `fillText()` (with word wrapping)
4. Upload to GPU via `device.queue.copyExternalImageToTexture()`

The fallback is always available and is used whenever the native API isn't (it keeps the pre-June blind-`<textarea>` input model).

### Editing System

When the user double-clicks a LiveTextNode to edit:

- **Native path:** `enterEditAt(clientX, clientY)` flips the element to `pointer-events:auto`, focuses it, and replays the swallowed click via `caretPositionFromPoint` (the caret-on-entry handshake). Typing goes straight into the `contenteditable`; the caret renders through effects. `endEditing()` blurs + clears the selection; the element **stays** for display capture.
- **Fallback path:** `beginEditing()` creates a hidden `<textarea>` that receives keyboard input (IME/clipboard/undo); the OffscreenCanvas re-renders each frame; `endEditing()` syncs final text from the textarea and destroys it.

ShapeManager exposes `beginLiveTextEditing(id)` (new node) and `enterLiveTextEditingAt(id, clientX, clientY)` (caret-at-click); the renderer drives the `onpaint` capture + `requestPaint` + overlay sync via `driveLiveTextHtml()`.

### Dimension Model (standard, since June 2026)

LiveTextNode uses the **same model as every other shape**: the real size lives in `_width/_height`, and `scaleX/scaleY` are a pure user multiplier.

```
_width  = content world width   (auto-fit from the captured text each frame, ÷ supersample)
_height = content world height
scaleX/scaleY = 1 by default     (a user multiplier set by the transform handles)
visual size   = _width × scaleX  (and _height × scaleY)

_localMatrix = translate(x,y) × rotate(rot) × scale(scaleX, scaleY)
```

`_applySizeFromTexture()` writes `_width/_height` (never `scaleX/scaleY`), and the transform handles write `scaleX/scaleY` (never `_width`) — so they don't fight: typing re-fits `_width`, and any user scale rides on top. This is what makes the **resize handles scale instead of translate** (the old unit-quad hack — `_width=1`, size in `scaleX` — broke that).

> **Serialization migration:** `toJSON` writes `liveTextOptions.sizeModel = 'v2'`. Both loaders (`LiveTextNode.fromJSON` and `ShapeManager.recreateNode`) reset `scaleX/scaleY` to `1` for **legacy** nodes (no `v2` marker, where `scaleX` encoded the visual *size*) so the saved value doesn't double-apply over the recomputed `_width`; the node then auto-fits to the same visual size.

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
