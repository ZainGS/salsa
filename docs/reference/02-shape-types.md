# 02 — Shape Types
**Last Updated:** 2026-05-10  

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
| **Geometry** | Fully triangulated via ear-clipping (handles convex and concave, not self-intersecting) |
| **Properties** | `_points: {x, y}[]`, `presetTag: string \| null` |
| **Drawing** | Interactive click-to-add-point tool, or created from presets |

**Polygon presets** (via `ShapeFactory`):
`parallelogram`, `trapezoid`, `arrowRight`, `chevron`, `star5`, `star6`, `cross`, `speechBubble`

Stars use `generateStarPoints(n, outerR, innerR)` to compute alternating inner/outer vertices.

### Bounding Box

Polygon overrides `getWorldSpaceBoundingBoxPolygon()` to transform each `_point` through `localMatrix` using `vec4`, returning the polygon's exact world-space vertex positions. **Do not rely on the base `Shape` implementation here** — the base class uses `this.width / 2` and `this.height / 2` to build a rectangle, but Polygon never sets `_width`/`_height` (those setters belong to the transform system, not the point array), so the base would always return a zero-area box at the origin and the AABB culler would cull the polygon every frame.

### PolygonDrawingService

Interactive click-to-add-point tool (`src/services/drawing/polygon-drawing-service.ts`):

- Vertices are world-space coordinates accumulated on each `pointerdown`
- Rubber-band line tracks cursor from last vertex; staging edge lines show committed edges
- **Close threshold:** `15` world units (~15 pixels) — click within this distance of the first vertex to auto-close
- **Double-click / Enter / Escape:** double-click commits the polygon; Enter commits if ≥ 3 vertices; Escape cancels
- **Double-click guard:** `pointerdown` with `event.detail >= 2` is ignored — the second `pointerdown` of a double-click (fired by the browser before `dblclick`) would otherwise add a spurious extra vertex before `handleDblClick` runs
- Minimum 3 vertices required to commit

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

---

## 3D Shapes

3D mesh nodes participate in the same scene graph as 2D shapes but are rendered exclusively by `Renderer3D`, not the 2D pipeline. The 2D renderer skips them during `beginFrame()` traversal.

**Files:** `src/scene-graph/shapes/mesh-3d.ts`, `src/scene-graph/shapes/mesh-group-3d.ts`

### Mesh3D

| Field | Value |
|-------|-------|
| `getType()` | `"3DMesh"` |
| **Rendering** | `Renderer3D.drawMeshes()` — Gouraud lighting, PS1 aesthetics, shadow mapping |
| **Geometry** | `MeshGeometry { vertices: Float32Array, indices: Uint32Array }` — stride 12 floats (`FLOATS_PER_VERT = 12`): position xyz, normal xyz, uv xy, tangent xyzw |
| **Primitives** | `'box' \| 'sphere' \| 'plane' \| 'cylinder' \| 'torus' \| 'custom'` |
| **Material** | `Material3D` — diffuse, specular, emissive colors; shininess; opacity; hasTexture flag |
| **Texture** | `diffuseTexture: GPUTexture \| null`; `textureLibraryId: string \| null` |
| **Animation** | `keyframeTracks: Mesh3DKeyframeTracks` — per-property keyframe arrays |
| **GPU state** | `gpuDirty = true` — set on any geometry/material change, cleared when buffers are uploaded |

**3D position** uses `x`, `y`, `z` (same base fields as 2D shapes, extended to 3D).
**3D rotation** uses `rotationX`, `rotationY`, `rotation` (Z) in radians.
**3D scale** uses `scaleX`, `scaleY`, `scaleZ`.

The 2D bounding box (`calculateBoundingBox`) projects world-space 3D AABB corners to 2D for use by the 2D interaction system. `getWorldSpaceBoundingBoxPolygon()` returns `[]` so that the 2D viewport frustum culler never hides 3D meshes.

**Serialization (`toJSON`):** Includes all transform, material, config, keyframeTracks, and textureLibraryId. Custom geometry is serialized as plain arrays. GPU textures are NOT serialized — they are re-uploaded from the TextureLibrary on load.

### MeshGroup3D

| Field | Value |
|-------|-------|
| `getType()` | `"3DMeshGroup"` |
| **Base class** | `Group` — inherits child management and transform propagation |
| **Rendering** | Does not render geometry itself — only transforms its `Mesh3D` children |
| **Properties** | `collapsed: boolean` — for outliner/hierarchy UI collapse state |

`MeshGroup3D` acts as a named container. Meshes parented to a group inherit its world transform via the scene graph's matrix hierarchy. Used to group related 3D objects (e.g., a character made of multiple meshes) so they can be moved/rotated as a unit.

### ClothMesh3D

**File:** `src/scene-graph/shapes/cloth-mesh-3d.ts`

| Field | Value |
|-------|-------|
| `getType()` | `"ClothMesh3D"` |
| **Base class** | `Mesh3D` |
| **Rendering** | Same as Mesh3D — geometry is rebuilt each rAF frame from simulation positions |
| **Simulation** | `LiveClothHandle` — rAF-driven GPU compute loop |

The simulation positions update `Mesh3D.geometry.vertices` each frame, which sets `gpuDirty = true` to trigger a re-upload on the next render.

#### ClothGridConfig

```typescript
interface ClothGridConfig {
  cols:             number;          // grid columns
  rows:             number;          // grid rows
  cellSize:         number;          // world-unit size per cell
  cornerRadius:     number;          // rounded corner cutout radius
  activeCells:      boolean[];       // flat [col + row*cols]; false = hole/cutout
  pinnedVertices:   number[];        // vertex indices that never move (infinite mass)
  stitches?:        StitchConstraint[];   // additional vertex-to-vertex constraints
  bendStiffnessMap?: number[];            // per-vertex bend stiffness in [0, 1]
}
```

#### ClothPhysicsConfig

```typescript
interface ClothPhysicsConfig {
  gravity:          number;          // m/s² downward acceleration
  damping:          number;          // velocity retention per step (0–1)
  stiffness:        number;          // constraint solve iterations
  wind?:            [x: number, y: number, z: number];  // global wind acceleration
  thickness?:       number;
  solidifyRounded?: boolean;
}
```

#### ClothLiveConfig

```typescript
interface ClothLiveConfig {
  mode:       'hang' | 'drape';      // hang = pin top row; drape = collision proxy
  proxy?:     DrapeProxy;            // drape target: ground | sphere | box | none
  windZones?: WindZone[];            // spatial wind emitters
}
```

#### StitchConstraint

```typescript
interface StitchConstraint {
  a:          number;   // vertex index
  b:          number;   // vertex index
  restLength: number;   // target distance in world units; 0 = fully gathered
}
```

Stitches are solved at full structural strength. Adding/removing any stitch resets the live simulation from flat pose — the cloth snaps as if newly stitched. Intended to model pleats, gathers, ruffles, and garment seams.

#### WindZone

```typescript
interface WindZone {
  id:           string;
  shape:        'sphere' | 'box';
  center:       [number, number, number];
  radius?:      number;                         // sphere only
  halfExtents?: [number, number, number];       // box only: [hx, hy, hz]
  windVec:      [number, number, number];       // force direction + magnitude
  falloff:      'none' | 'linear';
  pulsePeriod?: number;                         // gust period in seconds
  pulsePhase?:  number;                         // radians phase offset
}
```

Wind zones are evaluated CPU-side each rAF frame. The pulse formula is `0.5 + 0.5 × sin(2π × t / pulsePeriod + pulsePhase)`, oscillating between 0 (no wind) and 1 (full `windVec`). Zone forces accumulate across all zones per vertex before the GPU integrate pass.
