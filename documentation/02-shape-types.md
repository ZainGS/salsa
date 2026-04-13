# 02 — Shape Types

Every renderable object in Salsa is a subclass of `Shape`. This document covers all shape types, their unique properties, and how their geometry is generated.

**Files:** `src/scene-graph/shapes/`

---

## Solid Shapes

These shapes share the standard geometry pipeline: vertices and indices are generated in the shape class, cached in the shared geometry cache, and drawn via `drawIndexedIndirect` with the `shapePipeline`.

### Rectangle

| Field | Value |
|-------|-------|
| `getType()` | `"Rectangle"` |
| **Geometry** | Unit quad at ±0.5 — 4 vertices, 2 triangles (6 indices) |
| **Properties** | `width`, `height` (via Shape base) |
| **containsPoint** | Transforms mouse to local space via inverse matrix, checks ±halfW/halfH |

Rectangles are the workhorse shape. The unit quad is scaled by the `_localMatrix` (which includes scaleX/scaleY). Many other systems use rectangles as building blocks (StickyNote backgrounds, PanelLayout borders).

### Circle

| Field | Value |
|-------|-------|
| `getType()` | `"Circle"` |
| **Geometry** | 60-segment triangle fan from center — 61 vertices (center + 60 perimeter), 60 triangles |
| **Properties** | `radius` (stored as `width = height = radius * 2`) |
| **containsPoint** | Distance from center ≤ radius (in local space) |

### Triangle

| Field | Value |
|-------|-------|
| `getType()` | `"Triangle"` |
| **Geometry** | 3 vertices: top-center, bottom-left, bottom-right |
| **Properties** | `width`, `height` |
| **containsPoint** | Barycentric coordinates check |

### InvertedTriangle

| Field | Value |
|-------|-------|
| `getType()` | `"InvertedTriangle"` |
| **Geometry** | 3 vertices: bottom-center, top-left, top-right (flipped Triangle) |

### Diamond

| Field | Value |
|-------|-------|
| `getType()` | `"Diamond"` |
| **Geometry** | 4 vertices forming a diamond (rotated square): top, right, bottom, left |

### Section

| Field | Value |
|-------|-------|
| `getType()` | `"Section"` |
| **Geometry** | Unit quad ±0.5 (same as Rectangle) |
| **Special** | `transformMode = "translate-only"` — children don't inherit rotation/scale. Translucent yellow fill. Used as organizational frames.|

Sections act as visual containers. When a shape is dropped into a section (detected on pointer-up), the shape becomes a child of the section. Section children maintain their position when the section is scaled (the renderer compensates).

---

## Stroke Shapes

Strokes are freehand paths stored as point arrays. They use a different pipeline (`scribblePipeline`) and geometry generation (quad-strip tessellation with smoothed normals).

### Scribble

| Field | Value |
|-------|-------|
| `getType()` | `"Scribble"` |
| **Geometry** | Quad-strip: for each segment, 4 vertices offset perpendicular to the stroke direction by ±halfThickness. Normals are averaged between neighboring segments for smooth joins. |
| **Properties** | `_points: {x, y}[]` — accumulated during drawing |
| **Key methods** | `addPoint(x, y)`, `intersectsLine()` (for eraser hit-testing) |
| **Pipeline** | While staging: `stagingLinePipeline`. After commit: `scribblePipeline` with `drawIndexedIndirect`. |

**Geometry generation in detail:**
For points P₀, P₁, P₂, ..., Pₙ:
1. For each point Pᵢ, compute the tangent as `normalize(Pᵢ₊₁ − Pᵢ₋₁)` (averaged from neighbors)
2. The normal is the tangent rotated 90°: `(-tangentY, tangentX)`
3. Two vertices are placed at `Pᵢ ± normal × halfThickness`
4. Two triangles connect each quad (4 vertices → 6 indices per segment)

### Highlight

| Field | Value |
|-------|-------|
| `getType()` | `"Highlight"` |
| **Geometry** | Same as Scribble |
| **Properties** | Alpha forced to 0.65 for translucency |
| **Pipeline** | `highlightPipeline` with stencil — prevents self-overlap darkening |

Highlights use the stencil buffer to ensure overlapping segments of the same stroke don't double-blend. Each highlight has a unique stencil reference value.

---

## Line

| Field | Value |
|-------|-------|
| `getType()` | `"Line"` |
| **Geometry** | Simple 2-triangle quad from start to end, offset by halfThickness along the perpendicular |
| **Properties** | `x1, y1, x2, y2` — world-space endpoints |
| **Arrowheads** | `arrowStart`, `arrowEnd`: `'none' \| 'closedCircle' \| 'openCircle' \| 'triangle' \| 'open'` |
| **Connectors** | `startBinding`, `endBinding`: `{ shapeId, portId }` — binds endpoints to shape connection ports |
| **Pipeline** | `linePipeline` (committed) or `stagingLinePipeline` (in-progress) |

Lines support **endpoint dragging** — the renderer has a dedicated `endpointDragging` interaction mode that lets the user grab either end and reposition it, including snapping to connection ports on other shapes.

---

## Textured Shapes

These shapes render as instanced textured quads using the `texturedPipeline` and a `TextureArrayAtlas`.

### Pattern

| Field | Value |
|-------|-------|
| `getType()` | `"Pattern"` |
| **Rendering** | Instanced quad — texture sampled from a layer in the `TextureArrayAtlas` |
| **Properties** | `textureKey` (image URL/key), `layerIndex` in atlas, relative endpoints `_relativeX1/Y1/X2/Y2` |
| **Transform** | Computed from stroke midpoint, angle between endpoints, and length → produces a proper model matrix for the instance buffer |

Patterns are essentially textured brush strokes. The texture key maps to an image loaded into the shared atlas.

### Stamp

| Field | Value |
|-------|-------|
| `getType()` | `"Stamp"` |
| **Rendering** | Same instanced textured pipeline as Pattern |
| **Properties** | `textureKey`, `layerIndex`, `atlasWidth`, `atlasHeight` |
| **Instance flags** | `flags = 2` (stamps) vs `flags = 1` (patterns) — the shader may handle them differently |

---

## Polygon

| Field | Value |
|-------|-------|
| `getType()` | `"Polygon"` |
| **Geometry** | Triangulated from arbitrary point array using ear-clipping or fan triangulation |
| **Properties** | `_points: {x, y}[]`, `presetTag: string \| null` |
| **Drawing** | Interactive click-to-add-point tool, or created from presets |

**Polygon presets** (via `ShapeFactory`):
`parallelogram`, `trapezoid`, `arrowRight`, `chevron`, `star5`, `star6`, `cross`, `speechBubble`

Stars use `generateStarPoints(n, outerR, innerR)` to compute alternating inner/outer vertices.

---

## Composite Shapes (Groups with semantics)

### StickyNote

| Field | Value |
|-------|-------|
| **Type** | Group (returns Group getType) |
| **Children** | Rectangle (background) + SDFText (body) + optional SDFText (signature) |
| **Properties** | `color`, `text`, `signatureText`, `font`, `fontSize`, `lineHeight`, `minWidth`, `maxWidth`, `minHeight`, `padding` |
| **Auto-layout** | Text changes trigger re-measurement → rectangle resize → group recalculate |

### SpeechBalloon

| Field | Value |
|-------|-------|
| **Type** | Group |
| **Children** | Rectangle (background) + SDFText (text) + optional LiveTextNode |
| **Properties** | `balloonStyle` (`'ellipse' \| 'rounded-rect' \| 'cloud' \| 'burst' \| 'thought'`), tail config (`tailSide`, `tailPosition` 0–1, `tailLength`, `tailWidth`, `showTail`), `writingMode` |
| **Auto-layout** | Same as StickyNote — text changes trigger re-layout |

### PanelLayout

| Field | Value |
|-------|-------|
| **Type** | Group |
| **Properties** | `rows`, `cols`, `gutterWidth`, `bleedMargin`, `borderWidth`, `borderColor`, `backgroundColor`, `pageWidth`, `pageHeight` |
| **Children** | `Panel` Groups, each containing a border `Rectangle` + `clipRect` |
| **Special** | `renderBelowRaster = true` — renders behind raster layers (manga page panels) |
| **Templates** | `PanelTemplate` presets: `grid-2x2`, `manga-4-panel`, `manga-action`, etc. |

---

## Text Shapes

### SDFText

See [09 — Text Rendering](09-text-rendering.md) for full details.

| Field | Value |
|-------|-------|
| `getType()` | `"SDFText"` |
| **Rendering** | Per-glyph quads sampled from SDF atlas texture |
| **Key properties** | `text`, `font`, `fontSize`, `sdfThreshold`, `smoothing`, `outlineWidth`, `outlineColor`, `align`, `valign`, `writingMode`, `lineHeight` |
| **Editing** | Built-in caret system: `caretIndex`, `selectionStart/End`, `beginTyping()`, `endTyping()` |

### LiveTextNode

See [09 — Text Rendering](09-text-rendering.md) for full details.

| Field | Value |
|-------|-------|
| `getType()` | `"LiveText"` |
| **Rendering** | Textured quad — GPU texture captured from HTML or OffscreenCanvas each frame |
| **Key properties** | `text`, `font`, `fontSize`, `bold`, `italic`, `writingMode`, `effects[]`, `padding` |
| **Dimension model** | Unit quad (`_width = _height = 1`); actual world size in `scaleX`/`scaleY` |

### Text (Legacy)

| Field | Value |
|-------|-------|
| `getType()` | `"Text"` |
| **Rendering** | Canvas 2D → GPU texture upload → textured quad |
| **Status** | Legacy — superseded by SDFText and LiveText |
