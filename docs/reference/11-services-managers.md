# 11 — Services & Managers
**Last Updated:** 2026-05-10  

Salsa's service layer sits between the UI (Frogmarks) and the rendering engine. The `ShapeManager` is the primary public API — almost all operations go through it.

---

## ShapeManager — The Main API

**File:** `src/services/shape-manager.ts`

ShapeManager is a **singleton façade** (~3500+ lines) that Frogmarks calls for all operations. It wires together all services and exposes six typed **delegate managers** that group operations by domain.

### Delegate Manager Architecture

After construction, `ShapeManager.initDelegates()` creates six sub-managers that share a common `ManagerContext`:

```typescript
sm.raster     // RasterManager      — raster layers, cel animation, compositing
sm.text       // TextManager        — SDF text, LiveText, speech balloons
sm.animation  // AnimationManager   — timeline playback, cel operations, 3D sync
sm.scene3d    // Scene3DManager     — 3D camera, meshes, gizmos, shadows, undo
sm.drawing    // DrawingToolManager — tool dispatch for brush/line/scribble/etc.
sm.persist    // PersistenceManager — document save/load, export, thumbnails
sm.meshPaint  // MeshPaintManager   — CPU brush painting on 3D mesh UV textures
```

Frogmarks should prefer the namespaced sub-manager APIs (`sm.scene3d.createBox(...)`) over top-level ShapeManager methods where both exist. Top-level methods are mostly kept for backward compatibility.

### ManagerContext

All delegate managers receive a shared `ManagerContext` with:

```typescript
interface ManagerContext {
  sceneGraph: SceneGraph;
  shapeFactory: ShapeFactory;
  interactionService: InteractionService;
  webgpuRenderer: WebGPURenderer;
  layerManager: LayerManager;
  rasterLayerManager: RasterLayerManager;
  scheduleRender(): void;
  beginInteractive(): void;
  endInteractive(): void;
  emitSceneGraphChanged(): void;
  setSelectedNode(nodeId: string): void;
}
```

### Legacy Top-Level Responsibilities

| Category | Methods |
|----------|---------|
| **Shape creation** | `createRectangle()`, `createCircle()`, `createTriangle()`, `createDiamond()`, `createLine()`, `createScribble()`, `createHighlight()`, `createPattern()`, `createStamp()`, `createPolygon()`, `createRegularPolygon()`, `createPresetPolygon()`, `createSection()`, `createSDFText()`, `createStickyNote()`, `createSpeechBalloon()`, `createLiveText()`, `createPanelLayout()` |
| **Shape manipulation** | `deleteSelectedShapes()`, `duplicateSelectedShapes()`, `groupSelected()`, `ungroupSelected()`, `bringToFront()`, `sendToBack()`, `moveForward()`, `moveBackward()` |
| **Properties** | `setFillColor()`, `setStrokeColor()`, `setStrokeWidth()`, `setName()`, `setLocked()`, `setVisible()` |
| **LiveText CRUD** | `createLiveText()`, `setLiveTextEffects()`, `updateLiveText()`, `updateLiveTextStyle()`, `beginLiveTextEditing()`, `endLiveTextEditing()`, `flattenLiveText()` |
| **Raster layers** | Layer creation/deletion, selection, blend mode, opacity, dithering, animation config — delegated to `sm.raster` |
| **Serialization** | `serializeSceneGraph()`, `updateSceneGraph()`, `recreateNode()`, `getSceneGraphJSON()` |
| **Export** | `exportToImage()`, `generateThumbnail()` |
| **Drawing tools** | Delegates to per-tool drawing services via `sm.drawing` |
| **Raster undo/redo** | Via `RasterPaintEngine` (not the 3D undo stack) |
| **3D undo/redo** | `sm.undo3D()`, `sm.redo3D()`, `sm.canUndo3D`, `sm.canRedo3D` |
| **3D shadows** | `sm.enableShadows3D()`, `sm.disableShadows3D()`, `sm.shadowsEnabled3D` |
| **Frustum culling** | `sm.frustumCulling3D` getter/setter |
| **3D groups** | `sm.deleteMeshGroup3D(groupId)` |
| **3D outliner** | `sm.setMeshVisible3D`, `sm.isMeshVisible3D`, `sm.setGroupVisible3D`, `sm.isGroupVisible3D`, `sm.setMeshName3D`, `sm.getMeshName3D`, `sm.setGroupName3D`, `sm.getGroupName3D`, `sm.getScene3DHierarchy()` |
| **3D normal maps** | `sm.setMeshNormalMap3D`, `sm.clearMeshNormalMap3D`, `sm.uploadAndApplyNormalMap3D` |

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

## AnimationManager

**File:** `src/services/managers/animation-manager.ts`  
**Access:** `sm.animation`

Delegates for the raster timeline and cel animation system. Also provides the sync hook that ties raster playback to the 3D `AnimationPlayer3D`.

| Method | Purpose |
|--------|---------|
| `setEnabled(enabled)` | Enable/disable animation mode |
| `setCurrentFrame(frame)` | Jump to a specific frame |
| `getCurrentFrame()` / `getFrameCount()` | Frame position |
| `setFps(fps)` | Set playback rate |
| `play()` | Start timeline playback + fire `_sync3DPlayback(true)` |
| `pause()` | Pause + fire `_sync3DPlayback(false)` |
| `stopPlayback()` | Stop + reset + fire `_sync3DPlayback(false)` |
| `togglePlayPause()` | Smart toggle |
| `set3DPlaybackSync(cb)` | Register callback that fires on play/pause/stop — used by ShapeManager to sync Renderer3D's AnimationPlayer3D |
| `setOnionSkin(config)` | Configure onion skinning |
| `onEvent(listener)` | Subscribe to timeline events (`frame-changed`, etc.) |
| `getCels(layerId)` | List cels for a layer |
| `addCelAtCurrentFrame(layerId)` | Add a cel at the current frame |
| `deleteCel(layerId, celId)` | Remove a cel |

---

## Scene3DManager

**File:** `src/services/managers/scene3d-manager.ts`  
**Access:** `sm.scene3d`

Central manager for all 3D scene operations. See [15 — 3D Rendering System](15-3d-rendering-system.md) and [16 — 3D Animation System](16-3d-animation-system.md) for full details.

### Camera

```typescript
sm.scene3d.createCamera(config?)         // create + set camera
sm.scene3d.resetCamera()                 // look at origin from (0, 2, 5)
sm.scene3d.setCameraMode('perspective' | 'orthographic')
sm.scene3d.setFOV(degrees)
sm.scene3d.frameAllMeshes(padding?)      // fit all meshes in view
sm.scene3d.frameMesh(nodeId, padding?)   // fit one mesh in view
```

### Orbit Controls

```typescript
sm.scene3d.enableOrbitControls(config?)  // attach pointer events + per-frame update()
sm.scene3d.disableOrbitControls()
sm.scene3d.toggleOrbitControls(enabled?) // toggle without recreating
```

### Mesh Creation

```typescript
sm.scene3d.createBox(x, y, z, w, h, d, material?)
sm.scene3d.createSphere(x, y, z, radius?, segments?)
sm.scene3d.createPlane(x, y, z, w, h?)
sm.scene3d.createCylinder(x, y, z, radius?, height?, segments?)
sm.scene3d.createTorus(x, y, z, radius?, tubeRadius?)
sm.scene3d.createCustomMesh(x, y, z, geometry, material?)
sm.scene3d.deleteMesh(nodeId)      // undo-able
sm.scene3d.getAllMeshes()

// Sketch-to-3D: polygon extrude — mesh starts immediately editable
sm.addPolygonMesh3D(x, y, z, points, height?, name?, material?)
sm.addCircleMesh3D(x, y, z, radius?, segments?, height?, name?, material?)
```

`points` for `addPolygonMesh3D` is `[number, number][]` — XZ-plane coordinates (Y is up).
`height = 0` creates a flat cap; `height > 0` creates a closed prism.
Both methods return a `Mesh3D` with `editMesh` pre-attached; call `sm.enterEditMode3D(mesh.id)` immediately.

All create operations (`createBox`, `createSphere`, `addPolygonMesh3D`, etc.) and `deleteMesh` push entries onto the 3D undo stack. Undoing a delete restores the original mesh object including its GPU buffers; redoing a create re-adds the same mesh node without rebuilding geometry.

### Mesh Groups

```typescript
sm.scene3d.createMeshGroup(name?)                  // create a named group (undo-able)
sm.scene3d.deleteMeshGroup(groupId)                // remove group; children promoted to root (undo-able)
sm.scene3d.addMeshToGroup(meshId, groupId)
sm.scene3d.removeMeshFromGroup(meshId)
```

### Array Tool (Repeat)

Parametric arrays — N linked copies sharing the source mesh's geometry in three modes: **linear**, **grid**, and **radial**. All copies update automatically when the source is edited. Call via `shapeManager.*` (public façade) or `sm.scene3d.*` directly.

```typescript
// Linear: N copies along a single axis.
// count = copies beyond source (source not counted). Default 3.
// spacing = world-space step vector. Default: source width × 1.1 along X.
sm.scene3d.createLinearArray3D(sourceId, count?, spacing?)       // → ArrayGroup3D; pushes undo

// Grid: (countX+1) × (countY+1) instances. Source sits at (0,0).
// spacingX/Y default to source AABB extent + 10% along X and Z.
sm.scene3d.createGridArray3D(sourceId, countX?, spacingX?, countY?, spacingY?)

// Radial: count total instances (including source) on a circle.
// axis = rotation axis ('y' for floor ring). arcDeg = 360 for full ring.
sm.scene3d.createRadialArray3D(sourceId, count?, radius?, axis?, arcDeg?)

// Live-update parameters (no undo pushed — push once on drag commit).
sm.scene3d.updateArrayParams3D(groupId, partialParams)

// Bake to independent meshes — converts ArrayGroup3D → MeshGroup3D. Pushes undo.
sm.scene3d.bakeArray3D(groupId)                                  // → MeshGroup3D | null

// Query
sm.scene3d.isArrayGroup3D(nodeId)    // → boolean
sm.scene3d.getArrayParams3D(groupId) // → ArrayParams | null
```

`ArrayParams` — discriminated union on `mode`:

```typescript
interface LinearArrayParams {
  mode:    'linear';
  countX:  number;                     // copies (not counting source)
  spacing: [number, number, number];   // world-space step vector
}

interface GridArrayParams {
  mode:     'grid';
  countX:   number;                    // copies along X beyond source
  spacingX: [number, number, number];
  countY:   number;                    // copies along Y beyond source
  spacingY: [number, number, number];
}

interface RadialArrayParams {
  mode:   'radial';
  count:  number;                      // total instances including source
  radius: number;
  axis:   'x' | 'y' | 'z';            // rotation axis
  arcDeg: number;                      // arc in degrees (360 = full ring)
  center: [number, number, number];    // world-space ring center (fixed at creation)
}

type ArrayParams = LinearArrayParams | GridArrayParams | RadialArrayParams;
```

`Scene3DHierarchyNode.type` is `'3DArrayGroup'` for these nodes. Children include source (index 0) plus all copies. The panel label is **Repeat**.

### Outliner / Visibility

```typescript
sm.scene3d.setMeshVisible(meshId, visible)
sm.scene3d.isMeshVisible(meshId)
sm.scene3d.setGroupVisible(groupId, visible)
sm.scene3d.isGroupVisible(groupId)

sm.scene3d.setMeshName(meshId, name)
sm.scene3d.getMeshName(meshId)
sm.scene3d.setGroupName(groupId, name)
sm.scene3d.getGroupName(groupId)

// Hierarchy snapshot for driving outliner UI
sm.scene3d.getScene3DHierarchy()   // → Scene3DHierarchyNode[]
```

`Scene3DHierarchyNode` is an exported interface:

```typescript
interface Scene3DHierarchyNode {
  id:        string;
  name:      string;
  type:      '3DMesh' | '3DMeshGroup' | '3DArrayGroup';
  visible:   boolean;
  locked:    boolean;
  collapsed: boolean;
  children:  Scene3DHierarchyNode[];
}
```

### Normal Maps

```typescript
// Upload ImageData → create GPUTexture → bind to mesh
sm.scene3d.uploadAndApplyNormalMap(meshId, imageData, device)

// Bind an already-created GPUTexture
sm.scene3d.setMeshNormalMap(meshId, texture)

// Remove normal map (mesh reverts to Gouraud shading)
sm.scene3d.clearMeshNormalMap(meshId)
```

See [15 — 3D Rendering System §Normal Map System](15-3d-rendering-system.md) for pipeline and shader details.

### Transform + Gizmo

```typescript
sm.scene3d.enableTransformControls()     // click-to-select + gizmo drag
sm.scene3d.disableTransformControls()
sm.scene3d.setGizmoMode('move' | 'rotate' | 'scale')
sm.scene3d.pick3D(mouseX, mouseY, w, h)  // ray-cast pick (physical canvas pixels)

// Preferred for Frogmarks event handlers — accepts raw MouseEvent client coords
shapeManager.pickFromClient3D(clientX, clientY, canvasRect)  // DPR-safe
```

The hover handler in `enableTransformControls` scales mouse coordinates by `el.width / rect.width` before calling `pick3D` to match physical canvas dimensions. For event handlers outside the controller, prefer `pickFromClient3D` which handles this automatically.

### Shadows + Culling

```typescript
sm.scene3d.enableShadows(mapSize?, halfExtent?, bias?)
sm.scene3d.disableShadows()
sm.scene3d.shadowsEnabled                // getter
sm.scene3d.frustumCulling               // getter/setter
```

### Undo / Redo

```typescript
sm.scene3d.undo3D()
sm.scene3d.redo3D()
sm.scene3d.canUndo3D                     // boolean
sm.scene3d.canRedo3D                     // boolean
sm.scene3d.undoDescription3D             // string | null
sm.scene3d.redoDescription3D             // string | null
sm.scene3d.clearUndo3D()
```

### Keyframe Animation

```typescript
sm.scene3d.setMeshKeyframe(id, prop, frame, value, easing?)
sm.scene3d.removeMeshKeyframe(id, prop, frame)
sm.scene3d.applyAllKeyframesAtFrame(frame)
sm.scene3d.attachKeyframesToTimeline()   // auto-apply on raster frame changes
sm.scene3d.createAnimationPlayer(config?)
sm.scene3d.startSyncedPlayback()         // called automatically by AnimationManager sync
sm.scene3d.stopSyncedPlayback()
```

### Mesh Import

```typescript
// OBJ
sm.scene3d.importObjMesh(x, y, z, objText, material?)   → Mesh3D
sm.scene3d.importObjFile(x, y, z, file, material?)       → Promise<Mesh3D>

// GLTF/GLB — returns one Mesh3D per node in the scene hierarchy
// Auto-scales to fit (handles GLTF metre vs Salsa pixel mismatch automatically)
sm.scene3d.importGltfBuffer(x, y, z, buffer, material?)  → Promise<Mesh3D[]>
sm.scene3d.importGltfFile(x, y, z, file, material?)      → Promise<Mesh3D[]>

// Manual auto-scale (if needed after import or OBJ import)
sm.scene3d.autoScaleToFit(meshIds, targetSize?)          → void  // default 400px

// Model store (raw GLB bytes retained for project serialization)
sm.scene3d.getModelStore()                               → Map<string, ArrayBuffer>
sm.scene3d.storeModelBuffer(meshId, buffer)              → void

// Restore mesh from saved state (used by OPFS restore)
sm.scene3d.restoreMeshState(state, glbBuffer?)           → Promise<Mesh3D | null>
```

**ShapeManager delegations:**
```typescript
shapeManager.importObjFile3D(x, y, z, file, material?)         → Promise<Mesh3D>
shapeManager.importGltfFile3D(x, y, z, file, material?)        → Promise<Mesh3D[]>
shapeManager.importGltfBuffer3D(x, y, z, buffer, material?)    → Promise<Mesh3D[]>
shapeManager.autoScaleToFit3D(meshIds, targetSize?)            → void
```

### Render Style

```typescript
sm.scene3d.setRenderStyle(meshId, 'default' | 'cel' | 'sketch' | 'ink')  → boolean
sm.scene3d.getRenderStyle(meshId)                                          → RenderStyle | null
```

**ShapeManager delegations:** `setRenderStyle3D`, `getRenderStyle3D`

### Outline Pass

Screen-space silhouette outlines around all 3D meshes (boundary detector on depth buffer).

```typescript
sm.scene3d.enableOutlines(color?, width?)        // [r,g,b,a], width default 2 (pixels)
sm.scene3d.disableOutlines()
sm.scene3d.setOutlineColor(r, g, b, a)
sm.scene3d.setOutlineThreshold(n)               // n = pixel width; larger = thicker silhouette
sm.scene3d.outlineEnabled                       // boolean

// ShapeManager delegations
shapeManager.enableOutlines3D(color?, width?)
shapeManager.disableOutlines3D()
shapeManager.setOutlineColor3D(r, g, b, a)
shapeManager.setOutlineThreshold3D(n)
shapeManager.outlinesEnabled3D                  // boolean
```

`setOutlineThreshold(n)` now controls outline pixel width (default 2), not a Sobel magnitude threshold. The depth pre-pass uses `cullMode: 'none'` so back-facing planes, ribbons, and cylinder caps all write depth and produce a correct silhouette from any view angle.

### Document Persistence (3D)

```typescript
// Snapshot current document state (same data as OPFS auto-save)
const payload = await shapeManager.snapshotDocument();

// OPFS auto-save writes 3D data only when meshes are dirty (gated on getDirtyMeshIds3D()):
//   scene3d.json          — serialized Mesh3D node states (all meshes, written when any is dirty)
//   models3d/{id}.glb     — raw GLB buffers for imported meshes
//   textures3d.json       — TextureLibrary snapshot
// After a successful write, clearDirtyMeshState3D() fires automatically via _onWriteComplete hook.
// Pure raster-only sessions (no dirty meshes) skip the 3D files entirely — zero overhead.
```

#### `getScene3DNodeStates()` — Cloud/External Save API

For save paths that don't use OPFS (cloud saves, external export), `ShapeManager` exposes a snapshot of all 3D mesh states:

```typescript
const nodes: any[] = shapeManager.getScene3DNodeStates();
```

Each entry is a plain object containing everything needed to restore the mesh:

```typescript
{
  // from Mesh3D.toJSON():
  type, id, x, y, z,
  rotationX, rotationY, rotation,
  scaleX, scaleY, scaleZ,
  primitive, config, material, name,
  keyframeTracks,           // per-property keyframe arrays
  textureLibraryId,         // TextureLibrary entry ID for diffuse texture
  normalMapLibraryId,       // TextureLibrary entry ID for normal map
  // added by getScene3DNodeStates():
  glbMeshId,                // meshId key in getModelStore() (custom/GLTF meshes only)
  ribbonData,               // RibbonData3D if this mesh is a ribbon
  frameLinkAnimation3D,     // FrameLinkAnimation3D for scroll/frame-link effects
}
```

Cloth meshes include the full `clothConfig` (grid layout, pinned vertices, stitches, bend stiffness map) and `liveConfig` (hang/drape mode, wind zones) via `ClothMesh3D.toJSON()`.

To restore from these states:
```typescript
await shapeManager.restoreScene3DNodes(nodes, glbBuffers?, textureLibraryData?);
```

where `glbBuffers` is a `Record<meshId, ArrayBuffer>` of raw GLB bytes for custom/imported meshes.

**Wind zones** are stored per-mesh inside `ClothMesh3D.liveConfig.windZones` — they are fully included in `getScene3DNodeStates()` and fully restored by `restoreScene3DNodes()`. No separate wind-zone snapshot API is needed.

#### Per-Mesh Dirty Tracking

`stateDirty` is a boolean flag on each `Mesh3D` node. It starts `true` (new mesh always needs saving) and is set to `true` by:

- Gizmo transforms completing (`onTransformComplete`)
- Keyframe edits (`setMeshKeyframe`, `removeMeshKeyframe`, `clearMeshKeyframeTracks`)
- Render style changes (`setRenderStyle`)
- Normal map changes (`setMeshNormalMap`, `clearMeshNormalMap`, `uploadAndApplyNormalMap`)
- Cloth config changes (all stitch/bend-stiffness/wind-zone methods)
- Material and geometry setters directly on `Mesh3D`

It is set to `false` by `restoreMeshState()` (restore path never marks restored meshes as needing re-save) and by `clearDirtyMeshState3D()`.

**Animation playback does NOT set `stateDirty`** — keyframe-driven position updates go through `updateLocalMatrix()` directly, not through the gizmo or material setters.

Use the following API for per-mesh chunked saves:

```typescript
// Get IDs of all meshes that changed since last save
const dirtyIds: string[] = shapeManager.getDirtyMeshIds3D();

// Serialize a single mesh by ID — same shape as one getScene3DNodeStates() element.
// Use this instead of getScene3DNodeStates() + filter to avoid Array.from() cost on every
// unchanged mesh's geometry. For a 50-mesh scene with 1 dirty, this avoids 49 full geometry copies.
const state: any = shapeManager.getMeshState3D(meshId);

// After successfully saving those meshes, clear the flags
shapeManager.clearDirtyMeshState3D(dirtyIds);   // specific IDs
shapeManager.clearDirtyMeshState3D();            // all meshes
```

#### OPFS `loadDocument()` — `scene3dRestored` Flag

`loadDocument()` now returns a `scene3dRestored` boolean so callers can avoid double-restoring 3D state when OPFS already has it:

```typescript
const result = await shapeManager.loadDocument(docId);
// result.success         — true if OPFS data was found and restored
// result.layers          — array of restored raster layer metadata
// result.scene3dRestored — true if scene3d.json was present in OPFS and 3D meshes were restored

if (!result.scene3dRestored) {
  // OPFS had no 3D data — fetch from cloud backend instead
}
```

Without this flag, callers that also fetch 3D state from a cloud backend would double-restore: Salsa restores from OPFS, then the caller overwrites with cloud data, potentially clobbering a fresher local state.

#### `packProject()` and dirty state

`packProject()` is a complete snapshot — it always serializes all meshes regardless of dirty flags (passes `forceAll3D = true` to `gatherDocumentState`). After a successful pack, it calls `clearDirtyMeshState3D()` internally, so the dirty set is clean after every `.frogmarks` export. Local-only users who save via packProject never accumulate stale dirty flags.

### 3D Illustration Mode

```typescript
// Sync camera to 2D viewport pan/zoom (call on every viewport change)
sm.scene3d.syncIllustrationCamera(panX, panY, zoom, canvasW, canvasH)

// Toggle perspective vs orthographic (re-syncs automatically)
sm.scene3d.setIllustrationProjection('perspective' | 'orthographic')
```

### Ribbon Handles

Canvas-overlay control-point handles for 3D ribbon meshes. The `showHandles` flag is stored in `RibbonData` on the mesh.

```typescript
// Show or hide the canvas overlay handle dots for a ribbon
sm.scene3d.setRibbonShowHandles3D(meshId, show)   // stored in RibbonData.showHandles

// Query screen positions for handle rendering (applies mesh.localMatrix → world → NDC)
sm.scene3d.getRibbonHandleScreenPositions3D(meshId)  → { x, y }[]

// Ribbon handle drag (all methods apply/invert mesh.localMatrix correctly)
sm.scene3d.beginRibbonHandleDrag3D(meshId, handleIndex)
sm.scene3d.moveRibbonHandle3D(meshId, handleIndex, worldX, worldY, worldZ)
```

`getRibbonHandleScreenPositions3D`, `beginRibbonHandleDrag3D`, and `moveRibbonHandle3D` apply `mesh.localMatrix` when converting control points to world space for projection, and its inverse when converting drag world positions back to local space. Handles remain correctly positioned after translate, rotate, or scale operations.

### Cloth Simulation

All cloth operations proxy through `ShapeManager` to `Scene3DManager`. See [15 — 3D Rendering System §Cloth Simulation System](15-3d-rendering-system.md) for the full architecture.

#### Stitching

```typescript
// Add a vertex-to-vertex stitch; returns the new stitch index or null on error
shapeManager.addClothStitch(meshId: string, a: number, b: number, restLength: number): number | null

// Remove stitch by index
shapeManager.removeClothStitch(meshId: string, index: number): boolean

// Remove all stitches
shapeManager.clearClothStitches(meshId: string): boolean

// Query stitches
shapeManager.getClothStitches(meshId: string): StitchConstraint[]
```

Adding or removing a stitch rebuilds the constraint graph and resets the live simulation from flat — the cloth visibly snaps as if it was just stitched. `restLength: 0` = fully gathered; larger values model soft pleats.

#### Paintable Bend-Stiffness Map

```typescript
// Write a per-vertex stiffness map. Values in [0, 1]: 0 = floppy, 1 = rigid.
// Hot-updates the GPU buffer — no simulation reset.
shapeManager.setClothBendStiffness(meshId: string, map: Float32Array | number[]): boolean

// Read the current map (returns null if mesh is not a ClothMesh3D)
shapeManager.getClothBendStiffnessMap(meshId: string): Float32Array | null
```

Only bend constraints are scaled by this map. Structural and shear constraints always solve at full strength.

**Brush loop pattern (Frogmarks):**
```typescript
// On each pointer move during stiffness painting:
const map = shapeManager.getClothBendStiffnessMap(meshId) ?? new Float32Array(vertexCount).fill(1);
for (const vi of verticesInBrushRadius) {
  map[vi] = Math.max(0, Math.min(1, map[vi] + (softenMode ? -strength : strength)));
}
shapeManager.setClothBendStiffness(meshId, map);
```

#### Wind Zones

```typescript
// Add a wind zone; returns the generated zone id or null on error
shapeManager.addWindZone(meshId: string, zone: Omit<WindZone, 'id'>): string | null

// Remove by id
shapeManager.removeWindZone(meshId: string, zoneId: string): boolean

// Patch individual fields (safe to call on every slider onChange)
shapeManager.updateWindZone(meshId: string, zoneId: string, patch: Partial<Omit<WindZone, 'id'>>): boolean

// Query all zones
shapeManager.getWindZones(meshId: string): WindZone[]

// Remove all zones
shapeManager.clearWindZones(meshId: string): boolean
```

Wind zones are evaluated CPU-side each rAF frame. Updating any zone field calls `handle.setWindZones(zones)` internally, breaking convergence so the cloth reacts immediately.

**`WindZone` fields:**
| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Auto-assigned nanoid; read-only after creation |
| `shape` | `'sphere' \| 'box'` | Zone shape |
| `center` | `[x, y, z]` | Zone origin in world units |
| `radius` | `number?` | Sphere radius |
| `halfExtents` | `[x, y, z]?` | Box half-extents |
| `windVec` | `[x, y, z]` | Force direction + magnitude |
| `falloff` | `'none' \| 'linear'` | Attenuation toward zone boundary |
| `pulsePeriod` | `number?` | Gust period in seconds; omit for constant |
| `pulsePhase` | `number?` | Phase offset in radians |

---

## PersistenceManager

**File:** `src/services/managers/persistence-manager.ts`  
**Access:** `sm.persist`

Wraps `DocumentPersistence` (OPFS) with delegate callbacks provided by `ShapeManager`.

| Method | Description |
|--------|-------------|
| `saveNow()` | Immediately write the full document state to OPFS |
| `loadDocument(docId)` | Load from OPFS and restore document state |
| `listDocuments()` | Return all OPFS-saved documents with metadata |
| `deleteDocument(docId)` | Delete an OPFS document |
| `exportToFile(filename?)` | Export current document as a `.salsa` file |
| `importFromFile(file)` | Import a `.salsa` file into OPFS |

### DocumentPersistence — OPFS Layer

**File:** `src/services/persistence/document-persistence.ts`

Handles the raw OPFS reads/writes. Key behaviors:

- **Pixel data format:** Raw RGBA `ArrayBuffer` (`Uint8Array`, 4 bytes/pixel at document resolution) — no image encode/decode on save or load.
- **Parallel reads:** `loadDocument()` uses `Promise.all` to read all layer `.bin` and cel `.bin` files concurrently. For a document with 9 layers, this is the dominant load-time factor — sequential reads at ~38ms each would total ~341ms; parallel reads complete in roughly the slowest single read (~30–60ms).
- **Parallel saves (write side):** The write path (`writeToOPFS`) is called from the auto-save debounce, which fires after each stroke ends. If a large document save was slow, the next auto-save would be delayed until the previous one finished. Keeping individual layer writes fast ensures the auto-save timer stays responsive.

### Auto-Save

`DocumentPersistence` has a built-in debounce auto-save:

```typescript
persistence.notifyStrokeEnd()  // triggers debounced save (default 1000ms after last stroke)
```

`ShapeManager` calls this from `RasterDrawingService.endStroke()` automatically. The debounce ensures frequent strokes don't create a save storm, but also that every stroke is eventually persisted.

The `savedAt` timestamp in the OPFS manifest is used by Frogmarks' freshness check to decide whether to use the OPFS data or fetch from the cloud backend:

```typescript
// loadIllustrationV2 decision logic (Frogmarks side):
const useOpfs = opfsSavedAt > 0 && opfsSavedAt >= backendSavedAt;
```

---

## .frogmarks File Format

**Files:** `src/services/persistence/project-package.ts`, `src/services/shape-manager.ts`

A `.frogmarks` file is a standard ZIP archive that bundles the complete project state into a single portable file. Frogmarks can trigger a browser download with no server round-trip.

### ZIP Contents (Salsa-managed)

```
{name}.frogmarks
├── manifest.json       — DocumentManifest + 3D node count + format version
├── scene.json          — vector scene graph (ShapeManager shapes)
├── brushes.json        — brush presets
├── scene3d.json        — 3D mesh + skeleton node states ({ nodes: [...], skeletons: [...] })
├── textures3d.json     — TextureLibrary snapshot (base64 WebP data URLs)
├── layers/
│   └── {layerId}.bin   — raw RGBA bytes per raster layer
├── cels/
│   └── {celId}.bin     — raw RGBA bytes per animation cel
└── models3d/
    └── {meshId}.glb    — raw GLB buffers for GLTF-imported meshes
```

Frogmarks injects its own files (`frogmarks-state.json`, `thumbnail.png`) into the ZIP before download. Salsa's `unpackProject()` ignores unknown files, so this is safe.

### Export

```typescript
const blob = await shapeManager.packProject();
// Frogmarks then opens the blob as a ZIP, injects its own state, re-exports.
```

`packProject()` calls `gatherDocumentState()` internally — it reads live pixel data from the GPU textures, so it always captures the current unsaved state, not just what's in OPFS.

### Import

```typescript
// Pass the raw .frogmarks file (with or without Frogmarks-injected files — Salsa ignores extras)
await shapeManager.unpackProject(file);

// Only needed when the docId is changing (new device, different user, forked copy):
shapeManager.setCurrentDocId(newUuid, newName);

// Persist the restored state to OPFS under the (possibly new) docId:
await sm.persist.saveNow();
```

`unpackProject()` reconstructs the full `DocumentSavePayload` from the ZIP, restores raster layer textures to the GPU, re-imports GLTF meshes from their embedded GLB buffers, re-uploads TextureLibrary textures, and restores the vector scene graph.

### `setCurrentDocId(docId, name?)`

**File:** `src/services/shape-manager.ts`

Overrides the active document id and name without reloading any state. Call after `unpackProject()` when the destination UUID differs from the one embedded in the file (new-device restore, fork/copy, different user). Omit `name` to keep the name from the file.

```typescript
// Same user, same UUID (e.g. restore on a new browser) — skip setCurrentDocId
await shapeManager.unpackProject(file);
await sm.persist.saveNow();

// Fork or different-user import — override the id
await shapeManager.unpackProject(file);
shapeManager.setCurrentDocId(freshUuid, 'Copy of Illustration');
await sm.persist.saveNow();
```

---

## Armature & Skeletal Animation API

**Files:** `src/services/shape-manager.ts`, `src/services/managers/scene3d-manager.ts`

See [19 — Armature System](19-armature-system.md) for the full engine description. This section covers the public ShapeManager API surface.

### GLTF Skinned Import

```typescript
// From a File object (drag-and-drop)
const { skeletonIds, meshIds } = await sm.importSkinnedGltfFile3D(file);

// From a raw ArrayBuffer
const { skeletonIds, meshIds } = await sm.importSkinnedGltfBuffer3D(x, y, z, buffer);
```

Returns parallel arrays: `skeletonIds[i]` is the `Skeleton3D.id` that drives `meshIds[i]`.

### Joint Pose Control

```typescript
// Set one joint's local rotation (quaternion xyzw)
sm.setJointRotation3D(skeletonId, jointIndex, [x, y, z, w]);  // → boolean

// Direct skeleton access (more control)
const skel = sm.scene3d.getSkeleton(skeletonId);
skel.setJointPosition(jointIndex, [x, y, z]);
skel.computeWorldMatrices();  // manual rebuild if needed
```

### Clip Playback

```typescript
const clip: SkeletonAnimClip = {
  name: 'walk',
  startFrame: 0, endFrame: 60, fps: 24,
  tracks: [ /* SkeletonKeyframeTrack[] */ ],
};

const player = sm.playSkeletonClip3D(skeletonId, clip);
player.play();
player.pause();
player.stop();
player.currentFrame  // read-only
```

### Joint Selection (Bone Overlay)

The bone overlay activates automatically when a `SkinnedMesh3D` is selected. Joint picking is handled by mouse events — hover highlights joints, click selects them.

```typescript
// Query which joint is selected
const result = sm.getSelectedJoint3D();
// → { skeletonId: string; jointIndex: number } | null

// Programmatic joint selection
sm.selectJoint3D(jointIndex);   // selects joint in the active overlay
sm.clearSelectedJoint3D();      // deselects without deselecting the mesh
```

### Scene3DManager — Armature Methods

| Method | Description |
|--------|-------------|
| `getSkeleton(id)` | Get `Skeleton3D` by UUID |
| `getSkinnedMesh(id)` | Get `SkinnedMesh3D` by UUID |
| `getAllSkeletons()` | All `Skeleton3D` nodes in the scene |
| `getSelectedJointIndex()` | Currently selected joint index (or null) |
| `getBoneOverlaySkeletonId()` | Skeleton ID whose overlay is active (or null) |
| `selectJoint(idx)` | Programmatically select a joint |
| `clearJointSelection()` | Deselect joint |
| `playSkeletonClip(skeletonId, clip)` | Create + return `AnimationPlayer3D` for the clip |
| `restoreSkeletonState(state)` | Recreate `Skeleton3D` from JSON (used during project load) |
| `relinkSkinnedMeshSkeletons()` | Re-link `SkinnedMesh3D.skeleton` refs after load |

### Serialization

Skeletons are saved alongside mesh nodes in `scene3dJSON` using the format `{ nodes: [...], skeletons: [...] }`. Old saves (flat `[...]` array) are read back without skeletons for backward compatibility.

`Skeleton3D.toJSON()` stores the full joint hierarchy including `inverseBindMatrix` as a plain number array. `SkinnedMesh3D.toJSON()` stores `jointIndices` and `jointWeights` as base64 strings (`jointIndicesB64`, `jointWeightsB64`).

On restore: skeletons are recreated first (`restoreSkeletonState`), then meshes (`restoreMeshState` with `SkinnedMesh3D` branch), then `relinkSkinnedMeshSkeletons()` wires `SkinnedMesh3D.skeleton` references.

---

## MeshPaintManager

**File:** `src/services/managers/mesh-paint-manager.ts`

CPU-side brush painting on a `Mesh3D`'s UV-mapped texture. Works on any mesh with valid UVs — all GLTF-imported models and Salsa primitives qualify. See [15 — 3D Rendering System §Mesh Painting](15-3d-rendering-system.md#mesh-painting) for the data model and pipeline details.

### Mode control

```typescript
sm.enterMeshPaintMode(meshId: string, texSize = 1024): boolean
sm.exitMeshPaintMode(): void
```

`enterMeshPaintMode` allocates a `texSize × texSize` RGBA8 CPU buffer and GPU texture, initializes it to solid white, and sets it as the mesh's `diffuseTexture`. Returns `false` if the mesh ID is not found. Paint state is preserved on exit — calling enter again on the same mesh resumes from the existing buffer.

### Painting

```typescript
sm.paintMeshDab(hit: PickResult): void   // stamp one brush dab at the UV of a MeshPicker hit
sm.endMeshPaintStroke(): void            // call on pointerup to push undo snapshot
```

Typical integration loop:

```typescript
canvas.addEventListener('pointerdown', () => {
  const hit = sm.pickFromClient3D(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
  if (hit) sm.paintMeshDab(hit);
});
canvas.addEventListener('pointermove', () => {
  if (!painting) return;
  const hit = sm.pickFromClient3D(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
  if (hit) sm.paintMeshDab(hit);
});
canvas.addEventListener('pointerup', () => {
  sm.endMeshPaintStroke();
});
```

### Brush controls

| Method | Description |
|--------|-------------|
| `sm.setMeshPaintBrushColor(r, g, b, a?)` | Color in 0–255 per channel. Default alpha 255. |
| `sm.setMeshPaintBrushRadius(px)` | Brush radius in texels. Min 1. |
| `sm.setMeshPaintBrushHardness(h)` | 0 = fully feathered falloff, 1 = hard opaque disc. |

### Undo / Redo

```typescript
sm.undoMeshPaint(): void
sm.redoMeshPaint(): void
sm.canUndoMeshPaint: boolean
sm.canRedoMeshPaint: boolean
```

Each `endMeshPaintStroke()` pushes a full copy of the CPU buffer (max 20 entries). Undo/redo upload the restored buffer via a single `writeTexture` call covering the entire texture. These are separate from the `scene3d` undo stack — call both if needed.

---

## MeshEditManager

**File:** `src/services/managers/mesh-edit-manager.ts`

CPU-side interactive 3D modeling via a half-edge `EditMesh` structure. Covers Phases 2 and 3 of the Frogmarks Modeler. Frogmarks UI guide: [`docs/ui/mesh-editing.md`](../ui/mesh-editing.md). Spec: [`docs/specs/modeler.md`](../specs/modeler.md).

### Architecture

Every `Mesh3D` node carries an optional `editMesh: EditMesh | null`. When present, `syncFromEditMesh()` recompiles the half-edge structure → GPU geometry on every edit. `MeshEditManager` owns the undo stack integration (all destructive ops snapshot `EditMesh.toJSON()` before the op, restore via `EditMesh.fromJSON(before)` on undo).

### Making a mesh editable

```typescript
sm.makeEditable3D(meshId)        // convert primitive → EditMesh; no-op if already editable
sm.enterMeshEditMode3D(meshId)   // enter Edit Mode (calls makeEditable automatically)
sm.exitMeshEditMode3D()
sm.isMeshEditMode3D              // boolean getter
sm.activeMeshId3D                // string | null
```

### Selection

```typescript
sm.selectVertex3D(meshId, vIdx, addToSelection?)
sm.selectFace3D(meshId, fIdx, addToSelection?)
sm.selectEdge3D(meshId, halfEdgeIdx, addToSelection?)  // clears vertex/face selection
sm.clearMeshSelection3D(meshId)
sm.getMeshSelection3D(meshId)  // { meshId, vertices: Set<number>, faces: Set<number>, edges: Set<number> } | null
```

### Phase 2 destructive operations

All push to the 3D undo stack.

| Method | Description |
|--------|-------------|
| `sm.moveVertex3D(meshId, vIdx, dx, dy, dz)` | Translate vertex by delta. |
| `sm.extrudeFace3D(meshId, fIdx, distance)` | Extrude face along its normal. |
| `sm.insetFace3D(meshId, fIdx, amount)` | Inset face (0 = no inset, 1 = collapse). |
| `sm.deleteFace3D(meshId, fIdx)` | Delete face; edges become boundary. |
| `sm.weldVertices3D(meshId, v1, v2)` | Merge v2 into v1 at midpoint; removes v2. |

### Phase 3 topology operations

All push to the 3D undo stack.

| Method | Description |
|--------|-------------|
| `sm.loopCut3D(meshId, halfEdgeIdx, t?)` | Insert edge ring through adjacent quads; `t` ∈ [0,1] controls cut position (default 0.5). |
| `sm.dissolveEdge3D(meshId, halfEdgeIdx)` | Remove shared edge between two faces, merging into one polygon. Interior edges only. |
| `sm.bevelEdge3D(meshId, halfEdgeIdx, amount)` | Widen edge into a quad chamfer strip. `amount` ∈ [0,1] lerps new vertices along adjacent edges. |
| `sm.autoUnwrap3D(meshId)` | Smart-project (box/triplanar) UV unwrap. Projects each vertex along its dominant face-normal axis; normalises to [0,1]. |
| `sm.knifeCut3D(meshId, x0, y0, x1, y1, cw, ch)` | Free-cut along a screen-space line. Projects EditMesh vertices through the camera, intersects knife line with face edges in 2D, splits faces. `cw/ch` = canvas physical pixel dimensions. |
| `sm.bridgeEdgeLoops3D(meshId, loopA, loopB)` | Fill the gap between two open vertex-index rings with quads. Both arrays must have equal length (≥ 2). Each pair `(loopA[i], loopA[i+1], loopB[i+1], loopB[i])` becomes one face. |

For half-edge index lookup: `sm.getEditMesh3D(meshId)?.getHalfEdgeVertices(heIdx)` returns `[v_from, v_to]`.

### Vertex / face color painting

```typescript
sm.paintVertexColor3D(meshId, vIdx, r, g, b, a)  // per-vertex; no undo (fast brush path)
sm.paintFaceColor3D(meshId, fIdx, r, g, b, a)    // all vertices of face; undoable
```

Colors are `[0, 1]` floats. Once any vertex color is set, the mesh renders via the vertex-color pipeline (Gouraud with per-vertex color instead of material diffuse). See [15 — Vertex Color Pipeline](15-3d-rendering-system.md#vertex-color-pipeline).

### Modifier stack

Non-destructive modifiers are applied on every `compile()` pass without modifying the base `EditMesh`.

```typescript
const mirrorIdx = sm.addMirrorModifier3D(meshId, axis, clipping?)   // 'x'|'y'|'z'
const subdivIdx = sm.addSubdivisionModifier3D(meshId, iterations?)  // Catmull-Clark
sm.setModifierEnabled3D(meshId, index, enabled)
sm.removeModifier3D(meshId, index)
sm.applyModifier3D(meshId, index)  // bake into base mesh — undoable
sm.getModifiers3D(meshId)          // serialisable state array
```

### Undo / Redo

Mesh edits share the `scene3d` undo stack:

```typescript
sm.undo3D()
sm.redo3D()
```

Each destructive op (extrude, inset, delete, weld, loop cut, dissolve, bevel, paintFaceColor, applyModifier, knifeCut, autoUnwrap, bridgeEdgeLoops) is one undo snapshot. Modifier toggle/remove are not on the stack.

---

---

## GpObject3D — Grease Pencil Scene Node

**File:** `src/scene-graph/shapes/gp-object-3d.ts`

A `GpObject3D` holds an ordered list of `GpLayer3D` layers, each containing `GpStroke3D` arrays. The renderer reads active strokes each frame and expands them to screen-space quad strips. Strokes with a `parentJoint` are transformed by that joint's world matrix in the GPU vertex shader (zero CPU overhead).

### Data model

```typescript
interface GpPoint  { x: number; y: number; z: number; pressure: number; opacity: number; }
interface GpStroke3D {
  id:          string;
  points:      GpPoint[];
  color:       { r: number; g: number; b: number; a: number };
  baseWidth:   number;
  closed?:     boolean;
  fillColor?:  { r: number; g: number; b: number; a: number };
  parentJoint?: string;  // joint name in the linked skeleton
}
interface GpLayer3D {
  id:        string;
  name:      string;
  visible:   boolean;
  opacity:   number;           // 0–1, multiplied on top of per-point opacity
  strokes:   GpStroke3D[];     // base strokes (shown when no keyframe exists at current frame)
  keyframes: Record<number, GpStroke3D[]>;  // frame → stroke snapshot
}
```

### `Scene3DManager` GP API

| Method | Description |
|--------|-------------|
| `createGpObject(name?, skeletonId?)` | Create a new GP object; returns its ID. Adds "Layer 1" automatically. |
| `removeGpObject(gpId)` | Remove the GP object and all its layers. |
| `getGpObject(gpId)` | Return the `GpObject3D` node, or null. |
| `getAllGpObjects()` | All GP objects in the scene. |
| `addGpLayer(gpId, name?)` | Add a new layer; returns layerId. |
| `removeGpLayer(gpId, layerId)` | Remove a layer and all its strokes. |
| `beginGpStroke(gpId, layerId, color, baseWidth, options?)` | Open a stroke for streaming. Returns strokeId. |
| `addGpPoint(x, y, z, pressure?, opacity?)` | Append a world-space point to the active stroke. |
| `endGpStroke()` | Close the active stroke. Strokes with < 2 points are discarded. |
| `eraseGpStrokes(gpId, layerId, worldPos, radius, frame?)` | Sphere-erase all strokes within radius. |
| `setGpKeyframe(gpId, layerId, frame)` | Snapshot current base strokes onto frame N. |
| `clearGpKeyframe(gpId, layerId, frame)` | Remove the snapshot at frame N. |
| `setGpRenderOrder(gpId, order)` | Set draw order within the GP pass. 0 = default; negative = background. |

### `ShapeManager` public API

All methods are thin delegates to `scene3d`:

```typescript
sm.createGpObject3D(name?, skeletonId?)             // → gpId
sm.removeGpObject3D(gpId)
sm.addGpLayer3D(gpId, name?)                        // → layerId
sm.removeGpLayer3D(gpId, layerId)
sm.beginGpStroke3D(gpId, layerId, color, baseWidth, options?)  // → strokeId
sm.addGpPoint3D(x, y, z, pressure?, opacity?)
sm.endGpStroke3D()
sm.eraseGpStrokes3D(gpId, layerId, worldPos, radius, frame?)
sm.setGpKeyframe3D(gpId, layerId, frame)
sm.clearGpKeyframe3D(gpId, layerId, frame)
sm.setGpRenderOrder3D(gpId, order)
```

### Drawing a stroke (pointer event pattern)

```typescript
const gpId    = sm.createGpObject3D('Ink Lines');
const layerId = sm.addGpLayer3D(gpId, 'Outline');

// On pointerdown
const strokeId = sm.beginGpStroke3D(gpId, layerId,
  { r: 0, g: 0, b: 0, a: 1 }, 0.008);

// On pointermove
sm.addGpPoint3D(worldX, worldY, worldZ, event.pressure);

// On pointerup
sm.endGpStroke3D();
```

### Bone-parented strokes

Attach a stroke to a skeleton joint so it moves with the character:

```typescript
sm.beginGpStroke3D(gpId, layerId, color, width, { parentJoint: 'left_hand' });
```

`parentJoint` is the joint **name** (string) in the skeleton identified by `GpObject3D.skeletonId`. The GP renderer binds the skeleton's `skinMatrices` buffer and applies the joint transform in the vertex shader — no CPU work per frame.

### Render order

GP objects always render as a group (fills first, then strokes) after all 3D meshes and particles. Within that group, order is controlled by `renderOrder`:

| `renderOrder` | When it draws |
|---------------|--------------|
| < 0 | Background GP (before particles) — *not yet supported; reserved for future full Z-sort* |
| 0 (default) | Standard foreground — after particles |
| > 0 | On top within the GP group |

### Keyframe animation

```typescript
// Draw base pose (frame 0 shape)
sm.beginGpStroke3D(gpId, layerId, color, width);
// ... add points ...
sm.endGpStroke3D();

// Snapshot onto frame 12
sm.setGpKeyframe3D(gpId, layerId, 12);

// The renderer auto-selects keyframes[frame] if present, else base strokes
```

### Serialization

GP objects are serialized inside the `.frogmarks` ZIP as `gpObjects3d` in the `docPayload`. `packProject()` / `unpackProject()` handle this automatically — no extra calls needed.

---

## CacheService

**File:** `src/services/cache-service.ts`

See [05 — Cache System](05-cache-system.md) for full details.

Creates and holds all registries, geometry caches, uniform caches, texture atlases, SDF atlas, and overlay buffers. Acts as a single access point for the entire GPU buffer management system.
