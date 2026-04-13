# 11 — Services & Managers

Salsa's service layer sits between the UI (Frogmarks) and the rendering engine. The `ShapeManager` is the primary public API — almost all operations go through it.

---

## ShapeManager — The Main API

**File:** `src/services/shape-manager.ts`

ShapeManager is the **largest class** in the codebase (~3500 lines). It's the façade that Frogmarks (the Angular UI) calls for everything.

### Responsibilities

| Category | Methods |
|----------|---------|
| **Shape creation** | `createRectangle()`, `createCircle()`, `createTriangle()`, `createDiamond()`, `createLine()`, `createScribble()`, `createHighlight()`, `createPattern()`, `createStamp()`, `createPolygon()`, `createRegularPolygon()`, `createPresetPolygon()`, `createSection()`, `createSDFText()`, `createStickyNote()`, `createSpeechBalloon()`, `createLiveText()`, `createPanelLayout()` |
| **Shape manipulation** | `deleteSelectedShapes()`, `duplicateSelectedShapes()`, `groupSelected()`, `ungroupSelected()`, `bringToFront()`, `sendToBack()`, `moveForward()`, `moveBackward()` |
| **Properties** | `setFillColor()`, `setStrokeColor()`, `setStrokeWidth()`, `setName()`, `setLocked()`, `setVisible()` |
| **LiveText CRUD** | `createLiveText()`, `setLiveTextEffects()`, `updateLiveText()`, `updateLiveTextStyle()`, `beginLiveTextEditing()`, `endLiveTextEditing()`, `flattenLiveText()` |
| **Raster layers** | Layer creation/deletion, selection, blend mode, opacity, dithering, animation config — delegated to `RasterLayerManager` |
| **Serialization** | `serializeSceneGraph()`, `updateSceneGraph()`, `recreateNode()` |
| **Export** | `exportToImage()`, `generateThumbnail()` |
| **Drawing tools** | Delegates to per-tool drawing services |
| **Undo / Redo** | Raster undo/redo via `RasterPaintEngine` |

### Shape Creation Flow

When `createRectangle(x, y, w, h, fillColor, strokeColor, strokeWidth)` is called:

```
1. shapeFactory.createRectangle(x, y, w, h, colors, strokeWidth)
   → new Rectangle(...)
   → rectangle.finalizeInitialization()
       → updateLocalMatrix()
       → calculateBoundingBox()
   
2. interactionService.maxGlobalZIndex++
   rectangle.zIndex = maxGlobalZIndex
   
3. targetNode.addChild(rectangle)   // Add to scene graph
   sceneGraph.registerNode(rectangle)
   
4. interactionService.emit('onSceneGraphChanged')
5. webgpuRenderer.scheduleRender()
6. return rectangle
```

### Serialization: `recreateNode(data)`

Deserializes a JSON node back into the correct Shape subclass. Uses a `switch(data.type)`:

| Type String | Created Via |
|-------------|------------|
| `"Rectangle"` | `shapeFactory.createRectangle(...)` |
| `"Circle"` | `shapeFactory.createCircle(...)` |
| `"Triangle"` | `shapeFactory.createTriangle(...)` |
| `"InvertedTriangle"` | `shapeFactory.createInvertedTriangle(...)` |
| `"Diamond"` | `shapeFactory.createDiamond(...)` |
| `"Line"` | `shapeFactory.createLine(...)` + restore bindings |
| `"Scribble"` | `shapeFactory.createScribble(...)` + restore all points |
| `"Highlight"` | `shapeFactory.createHighlight(...)` + restore all points |
| `"Pattern"` | `shapeFactory.createPattern(...)` + restore texture key |
| `"Stamp"` | `shapeFactory.createStamp(...)` |
| `"Polygon"` | `shapeFactory.createPolygon(...)` + restore points + preset |
| `"SDFText"` | `shapeFactory.createSDFText(...)` |
| `"Sticky Note"` | `shapeFactory.createStickyNote(...)` + restore nested SDFText |
| `"Speech Balloon"` | `shapeFactory.createSpeechBalloon(...)` + restore tail/style |
| `"LiveText"` | `shapeFactory.createLiveText(...)` + engine + worldUnitsPerPixel + DOM init |
| `"Panel Layout"` | `shapeFactory.createPanelLayout(...)` |
| `"Section"` | `shapeFactory.createSection(...)` |
| `"Group"` | `shapeFactory.createGroup(recreatedChildren)` |
| `default` | `new Node()` (bare node — data loss!) |

After the switch, generic properties are restored:
```typescript
node.name = data.name;
node.x = data.x;
node.y = data.y;
node.scaleX = data.scaleX;
node.scaleY = data.scaleY;
node.rotation = data.rotation;
node.zIndex = data.zIndex;
node.visible = data.visible;
node.locked = data.locked;
```

---

## ShapeFactory

**File:** `src/scene-graph/core/shape-factory.ts`

Pure factory — creates shape instances without adding them to the scene graph.

- Holds `InteractionService` and `CacheService` references
- All methods return the created shape (caller adds to scene)
- `positionCheck(x, y)` defaults null coordinates to viewport center
- Static polygon helpers: `generateRegularPolygonPoints()`, `generatePresetPoints()`, `generateStarPoints()`

---

## SelectionService

**File:** `src/services/selection-service.ts`

Hit testing and spatial queries:

| Method | Purpose |
|--------|---------|
| `findFirstNodeUnderMouse(x, y)` | Reverse z-order traversal, returns first hit |
| `findAllShapesDeep(node)` | Flat list of all Shape descendants |
| `boxSelect(worldRectPoly)` | SAT-based intersection test, returns top-level shapes |
| `sectionsContainingCenter(shape)` | Find Sections whose bounds contain the shape's center |

---

## LayerManager (Vector)

**File:** `src/services/layer-manager.ts`

Lightweight layer system treating root children as layers:

| Method | Purpose |
|--------|---------|
| `getLayers()` | Returns `LayerNode[]` with id, name, visible, locked, node |
| `addLayer(name)` | Creates a plain Node, adds as root child |
| `deleteLayer(id)` | Removes from root children |
| `selectLayer(id)` | Sets the active layer for new shapes |

---

## RasterLayerManager

**File:** `src/services/raster-layer-manager.ts`

GPU-backed raster layer stack. Each layer owns a `GPUTexture` and a `RasterTextureManager`.

See [08 — Raster System](08-raster-system.md) for full details.

Key operations: `addLayer()`, `deleteLayer()`, `selectLayer()`, `setBlendMode()`, `setOpacity()`, `setClipped()`, `setLockTransparency()`, `setDitherConfig()`, `setFrameLinkAnimation()`, `enableAnimation()`.

Notifies the renderer via a composition callback when the layer stack or any property changes.

---

## RasterDrawingService

**File:** `src/services/raster-drawing-service.ts`

Converts pointer events into paint strokes on the active raster layer.

```
pointerDown → toTexelCoords(ev) → paintEngine.beginStroke(texX, texY, pressure)
pointerMove → toTexelCoords(ev) → paintEngine.addStrokePoint(texX, texY, pressure)
pointerUp   → paintEngine.endStroke()
```

**Coordinate conversion (`toTexelCoords`):**
1. Pointer event → world coordinates (via InteractionService)
2. World → UV on the raster quad (illustration bounds mapping)
3. UV → texel coordinates (multiply by texture width/height)

Also manages: brush color, radius, eraser mode, lock transparency, selection mask sync.

---

## RasterSelectionService

**File:** `src/services/raster-selection-service.ts`

Converts pointer events into raster selection operations:

| Method | Purpose |
|--------|---------|
| `setTool('rect'|'ellipse'|'lasso'|'magic-wand')` | Choose selection tool |
| `setMode('new'|'add'|'subtract')` | Set selection combination mode |
| `selectAll()` / `deselectAll()` / `invertSelection()` | Global ops |
| `deleteSelection()` | Clear selected pixels |
| `cut()` / `copy()` / `paste()` | Clipboard operations |
| `beginTransform()` | Lift selected pixels into floating layer |
| `commitTransform()` / `cancelTransform()` | Apply or discard transform |

Pointer events: pointerDown inside existing transform → drag. Outside → commit + start new selection.

---

## Drawing Services

**Files:** `src/services/drawing/`

Each drawing tool has its own service:

| Service | File | Purpose |
|---------|------|---------|
| `ScribbleDrawingService` | `scribble-drawing-service.ts` | Freehand stroke drawing |
| `HighlightDrawingService` | `highlight-drawing-service.ts` | Translucent highlighter |
| `LineDrawingService` | `line-drawing-service.ts` | Line with arrowheads |
| `PatternDrawingService` | `pattern-drawing-service.ts` | Textured stroke |
| `StampDrawingService` | `stamp-drawing-service.ts` | Single-click stamp placement |
| `PolygonDrawingService` | `polygon-drawing-service.ts` | Click-to-add-point polygon |
| `SectionDrawingService` | `section-drawing-service.ts` | Drag-to-create section frame |
| `SdfTextDrawingService` | `sdftext-drawing-service.ts` | SDF text placement/editing |
| `LiveTextDrawingService` | `live-text-drawing-service.ts` | LiveText creation/editing |
| `TextDrawingService` | `text-drawing-service.ts` | Legacy text (deprecated) |
| `EraserService` | `eraser-service.ts` | Erases scribbles by intersection |
| `CaretManager` | `caret-manager.ts` | Blinking text cursor rendering |
| `SelectionHighlightManager` | `selection-highlight-manager.ts` | Text selection rectangles |
| `OverlayDotManager` | `overlay-dot-manager.ts` | Connection port indicator dots |

---

## AnimationService

**Files:** `src/services/animation/`

### AnimationService

Simple frame-based animation playback:
- `frames: SceneGraph[]` — pre-parsed frame scene graphs
- `start(frameJsons, interval)` — parses JSON, runs `setInterval` to swap root children
- `stop()` — clears interval

### TestAnimations

Hardcoded test data: a 36-frame hopping frog animation made of Scribble shapes (body, eyes, smile).

### AnimationManager (disabled)

`src/services/animation-manager.ts` — entirely commented out. Was designed for multi-scene-graph frame management.

---

## WorldManager

**File:** `src/services/world-manager.ts`

A lightweight coordinator that holds references to the `SceneGraph` and `InteractionService`. Provides:
- `setSceneGraph()` / `getSceneGraph()`
- `setInteractionService()` / `getInteractionService()`
- Acts as the injection root for the system

---

## CacheService

**File:** `src/services/cache-service.ts`

See [05 — Cache System](05-cache-system.md) for full details.

Creates and holds all registries, geometry caches, uniform caches, texture atlases, SDF atlas, and overlay buffers. Acts as a single access point for the entire GPU buffer management system.
