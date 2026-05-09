# 18 — Full System Map

Complete reference for the Salsa repository: file structure, component dependencies, and every major data flow. Use this as a navigation guide when touching any part of the system.

---

## Repository Structure

```
src/
├── animation/                    # Raster animation timeline & keyframes
│   ├── animation-timeline.ts     # Timeline state (fps, frames, loop mode)
│   ├── animation-types.ts        # Shared animation types
│   ├── animation-exporter.ts     # Export to sprite sheet / video frames
│   └── onion-skin-renderer.ts    # Onion skin overlay compositor
│
├── renderer/
│   ├── core/                     # WebGPU main loop
│   │   ├── webgpu-renderer.ts    # ★ Central renderer — owns the GPU device, runs render()
│   │   ├── renderer.ts           # Base renderer interface
│   │   └── managers/
│   │       ├── pipeline-manager.ts    # Creates all 16 2D WebGPU pipelines
│   │       └── bindgroup-manager.ts   # Pairs pipeline layouts with cache buffers
│   │
│   ├── 3d/                       # 3D rendering subsystem
│   │   ├── renderer-3d.ts        # ★ 3D render pass (injected into main render pass)
│   │   ├── pipeline-3d.ts        # 3D-specific WebGPU pipelines (opaque/transparent/shadow/gizmo)
│   │   ├── camera-3d.ts          # Perspective/orthographic camera + view-projection matrix
│   │   ├── orbit-controller.ts   # Mouse-driven 3D camera orbit
│   │   ├── gizmo-renderer.ts     # Transform gizmo geometry and picking
│   │   ├── mesh-picker.ts        # GPU readback-based mesh selection
│   │   ├── frustum-culler.ts     # View-frustum AABB culling
│   │   ├── mesh-generators.ts    # Procedural box/sphere/plane/cylinder/torus geometry
│   │   ├── material-3d.ts        # Material3D type + DEFAULT_MATERIAL
│   │   ├── gltf-importer.ts      # GLTF/GLB model import → MeshGeometry
│   │   ├── obj-importer.ts       # OBJ text import → MeshGeometry
│   │   ├── animation-player-3d.ts # Keyframe interpolation + playback loop
│   │   ├── cloth-geometry-builder.ts # PBD cloth grid → vertex/constraint buffers
│   │   ├── cloth-simulator.ts    # 4-pass GPU compute cloth solver
│   │   ├── cloth-solidifier.ts   # Cloth mesh → solid inflated geometry
│   │   ├── cloth-preview-renderer.ts # Real-time cloth builder preview
│   │   ├── live-cloth-simulation.ts  # Continuous GPU cloth simulation loop
│   │   ├── html-texture-3d.ts    # HTML/CSS → GPUTexture for 3D mesh surfaces
│   │   ├── mesh-highlight-pass.ts    # Mesh selection highlight render pass
│   │   ├── outline-pass.ts       # Ink outline post-process pass
│   │   └── shaders/              # WGSL shader strings for all 3D passes
│   │       ├── mesh3d-shaders.ts      # Main Gouraud + texture shader
│   │       ├── shadow-shaders.ts      # PCF shadow map shader
│   │       ├── gizmo-shaders.ts       # Gizmo color + depth shader
│   │       ├── cloth-shaders.ts       # PBD compute + pose GPU shaders
│   │       ├── highlight-shaders.ts   # Selection highlight shader
│   │       ├── outline-shaders.ts     # Ink outline shader
│   │       └── style-shaders.ts       # Cel/sketch/ink style variants
│   │
│   ├── raster/                   # Raster painting subsystem
│   │   ├── core/
│   │   │   ├── raster-compositor.ts      # ★ GPU layer blend compositor
│   │   │   ├── raster-paint-engine.ts    # Per-stroke GPU paint operations
│   │   │   ├── raster-snapshot-manager.ts # CPU snapshots for undo/redo
│   │   │   └── raster-text-stamp.ts      # Text rendered into raster layers
│   │   ├── brushes/
│   │   │   ├── brush-engine.ts           # Dab placement + pressure/tilt
│   │   │   ├── brush-preset.ts           # Brush preset serialization
│   │   │   ├── brush-stabilizer.ts       # Stroke smoothing
│   │   │   ├── brush-stamp-pipeline.ts   # GPU dab rendering pipeline
│   │   │   ├── brush-tip.ts              # Tip shape generation
│   │   │   └── stroke-texture-renderer.ts # Stroke texture mapping
│   │   ├── effects/
│   │   │   ├── dither-engine.ts          # GPU Bayer/halftone + WASM Floyd-Steinberg
│   │   │   └── text-effect-engine.ts     # Wave/glitch/glow/chromatic aberration
│   │   ├── selection/
│   │   │   ├── raster-selection-engine.ts   # Marquee/lasso/magic wand → mask
│   │   │   ├── raster-selection-mask.ts     # 1-bit GPU selection texture
│   │   │   ├── raster-transform-engine.ts   # Move/scale/rotate selected pixels
│   │   │   └── selection-overlay-renderer.ts # Marching ants + transform handles
│   │   ├── tools/
│   │   │   └── flood-fill-engine.ts     # Paint bucket (scanline fill)
│   │   ├── raster-canvas.ts             # Canvas wrapper
│   │   ├── raster-texture-manager.ts    # GPUTexture lifetime per layer
│   │   └── canvas-grain.ts             # Paper grain + brush grain overlay
│   │
│   ├── caches/                   # GPU buffer management
│   │   ├── geometry-cache/       # Vertex + index buffer pools per shape type
│   │   │   ├── gpu-geometry-cache.ts     # Base geometry cache
│   │   │   ├── shapes-render-gcache.ts
│   │   │   ├── strokes-render-gcache.ts
│   │   │   ├── sdftext-render-gcache.ts
│   │   │   ├── highlights-render-gcache.ts
│   │   │   ├── bounding-box-render-gcache.ts
│   │   │   └── pattern-legacy-gcache.ts
│   │   ├── uniform-cache/        # Per-shape 256-byte uniform slices
│   │   │   ├── gpu-uniform-cache.ts      # Base uniform cache
│   │   │   ├── shapes-render-ucache.ts
│   │   │   ├── strokes-render-ucache.ts
│   │   │   ├── sdftext-render-ucache.ts
│   │   │   ├── highlights-render-ucache.ts
│   │   │   ├── bounding-box-render-ucache.ts
│   │   │   └── pattern-legacy-ucache.ts
│   │   ├── texture-cache/        # Texture atlases and arrays
│   │   │   ├── texture-array-atlas.ts    # 2D texture array for patterns/stamps
│   │   │   ├── pattern-atlas.ts          # Pattern atlas management
│   │   │   ├── stamp-registry.ts         # Stamp texture registration
│   │   │   ├── texture-cache.ts          # LRU texture cache
│   │   │   └── textured-instance-buffer.ts # Instance buffer for textured draws
│   │   └── buffers/
│   │       ├── indirect-draw-command-buffer.ts # Per-shape drawIndexedIndirect commands
│   │       └── strokes-staging-buffer.ts       # Triple-buffered stroke staging
│   │
│   ├── render-strategies/        # Pluggable strategy pattern
│   │   ├── render-strategy.ts    # Base interface (currently minimal)
│   │   └── webgpu-render-strategy.ts  # Standard WebGPU implementation
│   │
│   └── util/
│       ├── aabb.ts               # AABB intersection + containment
│       ├── viewport-bounds.ts    # World→screen bounds
│       ├── gpu-buffer-utils.ts   # GPUBuffer create/write helpers
│       ├── geometry.ts           # 2D geometry math
│       ├── handles.ts            # Scale/rotate handle hit testing
│       ├── event-emitter.ts      # Typed EventEmitter
│       └── staging-container.ts  # In-progress stroke container
│
├── scene-graph/
│   ├── core/
│   │   ├── scene-graph.ts        # Root Node tree, findNodeById, forEachDeep
│   │   └── shape-factory.ts      # Factory: creates typed shapes from JSON or params
│   └── shapes/
│       ├── base/
│       │   ├── node.ts           # ★ Base class: visible, locked, parent, localMatrix, children
│       │   ├── shape.ts          # Extends Node: fill, stroke, x/y/z, rotation, scale, bounding box
│       │   └── group.ts          # Group container with child transforms
│       ├── mesh-3d.ts            # 3D mesh scene node (extends Shape; 3D pipeline renders it)
│       ├── cloth-mesh-3d.ts      # Cloth mesh (extends Mesh3D; adds clothConfig, simState, liveConfig)
│       ├── mesh-group-3d.ts      # Group of Mesh3D nodes from GLTF import
│       ├── rectangle.ts          # Rect, Circle, Triangle, Diamond, Polygon, etc.
│       ├── line.ts               # Line with start/end endpoints + connector snapping
│       ├── scribble.ts           # Freehand stroke (point array)
│       ├── highlight.ts          # Highlight stroke (non-overlapping shader pass)
│       ├── text.ts               # Legacy text
│       ├── sdf-text/             # SDF text node (glyph atlas references)
│       ├── live-text.ts          # HTML-rendered text → GPUTexture per frame
│       ├── speech-balloon.ts     # Speech balloon with configurable tail
│       ├── sticky-note.ts        # Sticky note shape
│       ├── panel-layout.ts       # Panel/card layouts
│       ├── pattern.ts            # Pattern fill (texture array)
│       ├── stamp.ts              # Stamp shape (texture instance)
│       └── section.ts            # Section divider
│
├── services/
│   ├── shape-manager.ts          # ★★ Main API singleton (~6400 lines); delegates to sub-managers
│   ├── interaction-service.ts    # Mouse/keyboard/touch events; pan, zoom, selection state
│   ├── raster-layer-manager.ts   # ★ Layer stack, blend modes, cel animation, pixel export
│   ├── texture-library.ts        # TextureLibrary — shared GPU textures for 3D meshes
│   ├── layer-manager.ts          # Vector layer ordering helper
│   ├── cache-service.ts          # GPU cache registry (holds all geometry/uniform caches)
│   ├── connector-service.ts      # Smart arrow connectors with snapping
│   ├── raster-drawing-service.ts # Brush stroke entry point (calls paint engine + notifyStrokeEnd)
│   ├── raster-move-service.ts    # Raster layer pixel move
│   ├── raster-selection-service.ts # Selection tool dispatch
│   ├── raster-text-service.ts    # Raster text stamp
│   ├── selection-service.ts      # Vector shape selection
│   ├── world-manager.ts          # World transform (pan/zoom) state
│   │
│   ├── managers/                 # Delegate sub-managers (preferred API surface)
│   │   ├── manager-context.ts    # Shared ManagerContext interface
│   │   ├── raster-manager.ts     # Raster layer CRUD + compositing operations
│   │   ├── text-manager.ts       # SDF text + LiveText creation/editing
│   │   ├── animation-manager.ts  # Timeline control, cel ops, 3D animation sync
│   │   ├── scene3d-manager.ts    # ★ All 3D mesh operations (~3700 lines)
│   │   ├── drawing-tool-manager.ts # Drawing tool dispatch
│   │   ├── persistence-manager.ts  # Save/load delegate (wraps DocumentPersistence)
│   │   ├── transform-controller-3d.ts # Gizmo pointer events → mesh transforms
│   │   └── undo-manager-3d.ts    # 3D undo/redo stack
│   │
│   ├── drawing/                  # Drawing service implementations
│   │   ├── scribble-drawing-service.ts
│   │   ├── line-drawing-service.ts
│   │   ├── highlight-drawing-service.ts
│   │   ├── text-drawing-service.ts
│   │   ├── sdftext-drawing-service.ts
│   │   ├── live-text-drawing-service.ts
│   │   ├── pattern-drawing-service.ts
│   │   ├── stamp-drawing-service.ts
│   │   ├── polygon-drawing-service.ts
│   │   ├── section-drawing-service.ts
│   │   ├── eraser-service.ts
│   │   ├── caret-manager.ts
│   │   ├── overlay-dot-manager.ts
│   │   └── selection-highlight-manager.ts
│   │
│   └── persistence/
│       ├── document-persistence.ts # ★ OPFS read/write, auto-save debounce
│       └── project-package.ts      # .frogmarks ZIP pack/unpack
│
├── types/
│   ├── rgba.ts                   # RGBA color type
│   ├── interaction.ts            # Vec2, ShapeDimensions, cursor types
│   ├── keyframe-3d.ts            # Mesh3DKeyframeTracks type
│   └── ribbon-3d.ts              # Ribbon mesh data type
│
├── wasm/
│   └── wasm-bindings.ts          # Rust error-diffusion dither bindings
│
└── main.ts                       # Entry point: wire up renderer + services + start loop
```

---

## Component Dependency Graph

```
Frogmarks (Angular UI)
        │
        │ ShapeManager public API
        ▼
┌────────────────────────────────────────────────────────────────────┐
│                         ShapeManager                               │
│  shape-manager.ts (singleton, ~6400 lines)                        │
│                                                                    │
│  Delegate sub-managers:                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ raster   │ │ text     │ │animation │ │    scene3d         │   │
│  │ Manager  │ │ Manager  │ │ Manager  │ │    Manager         │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬───────────┘   │
│       │             │            │                 │               │
│  ┌────┴─────┐       │            │        ┌────────┴───────────┐   │
│  │ drawing  │       │            │        │ TransformCtrl3D    │   │
│  │ Manager  │       │            │        │ UndoManager3D      │   │
│  └──────────┘       │            │        │ AnimationPlayer3D  │   │
│                     │            │        └────────────────────┘   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                  PersistenceManager                        │   │
│  │  DocumentPersistence (OPFS)  │  project-package (.frogmarks)│  │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
        │                    │                     │
        ▼                    ▼                     ▼
  SceneGraph          InteractionService      WebGPURenderer
  (Node tree)         (events, pan/zoom)      (GPU device)
        │                                          │
        ▼                                          ▼
  Shape instances                           RenderStrategy
  Mesh3D instances                          beginFrame()
  ClothMesh3D                                     │
                                                  ├─ CacheService
                                                  │   ├─ GeometryCaches (VB/IB)
                                                  │   ├─ UniformCaches (storage buf)
                                                  │   └─ TextureCaches (atlas)
                                                  │
                                                  ├─ RasterLayerManager
                                                  │   ├─ GPUTexture per layer
                                                  │   └─ RasterCompositor
                                                  │
                                                  └─ Renderer3D
                                                      ├─ Pipeline3D
                                                      ├─ Camera3D
                                                      ├─ FrustumCuller
                                                      ├─ MeshPicker
                                                      └─ GizmoRenderer
```

---

## Data Flow: GPU Rendering (Single Frame)

Every frame runs through one call to `WebGPURenderer.render()`:

```
requestAnimationFrame
        │
        ▼
WebGPURenderer.render()
        │
        ├─1─ Collect staging shapes (in-progress strokes)
        │
        ├─2─ GPUCommandEncoder.beginRenderPass(offscreenTex)
        │
        ├─3─ [RASTER MODE] RasterCompositor.composite()
        │      │  For each layer below 3D scene entry:
        │      │    GPU compute: blend → dither → grain
        │      │  Output → offscreen quad
        │      └─ [then draw raster text preview, floating selection, marching ants]
        │
        ├─4─ [VECTOR MODE] Draw artboard background
        │      backgroundPipeline, fullscreen quad, dot-grid shader
        │
        ├─5─ drawVectorShapes(passEncoder)
        │      For each pipeline type (shape/scribble/line/sdfText/highlight/boundingBox):
        │        passEncoder.setPipeline(pipeline)
        │        passEncoder.setBindGroup(0, sharedBindGroup)   ← uniforms storage buf
        │        passEncoder.setVertexBuffer(0, geometryCache.vb)
        │        passEncoder.setIndexBuffer(geometryCache.ib)
        │        passEncoder.drawIndexedIndirect(commandBuffer, 0)
        │           └─ GPU reads: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
        │                         firstInstance → 256-byte slice offset in uniform buffer
        │
        ├─6─ draw3DMeshes()  →  Renderer3D
        │      │
        │      ├─6a─ Shadow pre-pass (own GPUCommandEncoder, submitted first)
        │      │       depthPipeline, depth32float map, opaque + 2-sided meshes
        │      │
        │      ├─6b─ Opaque meshes (frustum-culled)
        │      │       Gouraud + Phong specular, optional PCF shadow, PS1 snapping
        │      │       Textured path if mesh.material.hasTexture
        │      │
        │      ├─6c─ Transparent meshes (depth write OFF, alpha blend)
        │      │
        │      └─6d─ Gizmos (depth write OFF)
        │               Move / Rotate / Scale handles
        │
        ├─7─ [RASTER MODE] FG RasterCompositor (layers above 3D divider)
        │
        ├─8─ Staging shapes (live stroke preview)
        │      stagingLinePipeline, stagingHighlightPipeline
        │
        ├─9─ Textured instances (patterns + stamps)
        │      texturedPipeline, instanced draw, texture array atlas
        │
        ├─10─ LiveText quads
        │       rasterPipeline, per-node GPUTexture (HTML canvas → GPU each frame)
        │
        ├─11─ Overlays
        │       Text selection highlights, connection port dots, text carets
        │
        ├─12─ End render pass
        │
        ├─13─ copyTextureToTexture(offscreenTex → swapChain backbuffer)
        │
        └─14─ queue.submit()
```

---

## Data Flow: Raster Painting (Brush Stroke)

```
Pointer event (pointerdown/pointermove/pointerup)
        │
        ▼
WebGPURenderer pointer handler
        │
        ▼
RasterDrawingService.onPointerMove()
        │
        ├─ BrushEngine.computeDabs(points, pressure, tilt)
        │     └─ Dab positions along stroke path (spacing + jitter)
        │
        ├─ RasterPaintEngine.paintDabs(dabs, activeLayerTexture)
        │     └─ BrushStampPipeline: GPU render dab stamps onto layer texture
        │           (blend mode: normal/multiply/screen/erase/etc.)
        │
        └─ scheduleRender()   ← marks frame dirty
               │
               ▼
         next render(): compositor reads updated layer texture
               └─ RasterCompositor blends all layers → output

On pointerup:
  RasterSnapshotManager.pushSnapshot(layerPixels)  ← undo stack
  notifyStrokeEnd()  ← triggers OPFS auto-save (debounced)
```

---

## Data Flow: OPFS Auto-Save

Triggered automatically after every stroke ends (debounced 1–5 seconds):

```
RasterDrawingService.endStroke()
        │
        ▼
ShapeManager.notifyStrokeEnd()
        │
        ▼
DocumentPersistence.notifyStrokeEnd()
        │  debounce (strokeDebounceMs, default 5s)
        ▼
DocumentPersistence.executeSave()
        │
        ▼
ShapeManager.gatherDocumentState()
        │
        ├─ Build DocumentManifest (layer metadata, canvas size, animation state)
        ├─ getSceneGraphJSON()         → scene.json
        ├─ exportAllBrushPresets()     → brushes.json
        ├─ rasterLayerManager.exportLayerPixels()  → layers[].pixelData (raw RGBA)
        ├─ rasterLayerManager.exportCelPixels()    → cels[].pixelData (raw RGBA)
        │
        └─ [3D — ONLY IF getDirtyMeshIds3D().length > 0]
               getAllMeshes().map(_buildMeshState)  → scene3dJSON
               getModelStore() entries             → models3d GLB buffers
               getTextureLibraryData()             → textureLibrary
               _onWriteComplete = clearDirtyMeshState3D   ← fired after write
        │
        ▼
DocumentPersistence.writeToOPFS(payload)
        │
        ├─ write manifest.json
        ├─ write scene.json
        ├─ write brushes.json
        ├─ write layers/{id}.bin        (parallel writes)
        ├─ write cels/{id}.bin          (parallel writes)
        ├─ [if scene3dJSON] write scene3d.json
        ├─ [if models3d]    write models3d/{id}.glb
        └─ [if textureLib]  write textures3d.json
        │
        ▼
payload._onWriteComplete?.()
  → clearDirtyMeshState3D()  (only if 3D was written)
```

OPFS directory layout for a document:
```
salsa-documents/
  {docId}/
    manifest.json
    scene.json
    brushes.json
    layers/
      {layerId}.bin          ← raw RGBA, 4 bytes/pixel at doc resolution
    cels/
      {celId}.bin
    scene3d.json             ← present only if 3D meshes exist
    models3d/
      {meshId}.glb           ← raw GLB bytes for GLTF-imported meshes
    textures3d.json          ← TextureLibrary entries with base64 data URLs
```

---

## Data Flow: OPFS Load

```
Frogmarks: shapeManager.loadDocument(docId)
        │
        ▼
DocumentPersistence.loadDocument(docId)
        │
        ├─ readJSON(manifest.json)
        ├─ readText(scene.json)
        ├─ readText(brushes.json)
        ├─ Promise.all( manifest.layers.map → readBinary layers/{id}.bin )
        ├─ Promise.all( allCelMetas.map    → readBinary cels/{id}.bin )
        ├─ readText(scene3d.json)          → null if absent
        ├─ for-await models3d/*.glb        → Record<meshId, ArrayBuffer>
        └─ readJSON(textures3d.json)       → null if absent
        │
        ▼
ShapeManager.restoreDocumentState(payload)
        │
        ├─1─ clearScene()          ← remove all existing nodes
        ├─2─ restoreSceneGraphJSON → recreate vector shapes
        ├─3─ rasterLayerManager.restoreLayers(manifest, layers)
        │      └─ createLayer() per entry + uploadPixelsToLayer()
        ├─4─ restoreBrushPresets()
        ├─5─ restore globalDitherConfig
        └─6─ [if scene3dJSON] restoreScene3DNodes()
               │  for each mesh state:
               │    scene3d.restoreMeshState(state, glbBuf?)
               │      ├─ new Mesh3D(...)
               │      ├─ setGeometry / rebuildGeometry
               │      ├─ restore material, keyframes, ribbonData, etc.
               │      └─ mesh.stateDirty = false   ← restored mesh is not dirty
               └─ restoreTextureLibraryData(textureLibrary)
                    └─ Promise.all → restoreFromBitmap (parallel)
        │
        ▼
Return: { success, layers, scene3dRestored: !!(payload.scene3dJSON) }
  scene3dRestored = true  → Frogmarks skips cloud 3D fetch (OPFS had it)
  scene3dRestored = false → Frogmarks fetches 3D from cloud backend
```

---

## Data Flow: packProject / .frogmarks Manual Save

```
Frogmarks: shapeManager.packProject()
        │
        ▼
ShapeManager.gatherDocumentState(forceAll3D = true)
        │  (same as auto-save but always includes all 3D regardless of dirty)
        ▼
_packProject({ docPayload, nodes3d, models3d, textureLibrary })
        │  (project-package.ts)
        │
        ├─ fflate.zip({
        │     "manifest.json"    ← docPayload.manifest
        │     "scene.json"       ← docPayload.sceneGraphJSON
        │     "brushes.json"     ← docPayload.brushPresetsJSON
        │     "scene3d.json"     ← nodes3d serialized
        │     "textures3d.json"  ← textureLibrary
        │     layers/{id}.bin    ← raw RGBA per layer
        │     cels/{id}.bin      ← raw RGBA per cel
        │     models3d/{id}.glb  ← GLB per GLTF mesh
        │   })
        └─ returns Blob (ZIP)
        │
        ▼
ShapeManager.clearDirtyMeshState3D()   ← full snapshot; all dirty flags cleared

Frogmarks triggers browser download or uploads to cloud.
```

---

## Data Flow: unpackProject / .frogmarks Restore

```
Frogmarks: shapeManager.unpackProject(file: File | Blob)
        │
        ▼
_unpackProject(file)   (project-package.ts)
        │
        ├─ fflate.unzip(file bytes)
        ├─ parse manifest.json
        ├─ parse scene.json, brushes.json, scene3d.json, textures3d.json
        ├─ read layers/{id}.bin  → layerPixelData[]
        ├─ read cels/{id}.bin    → celPixelData[]
        └─ read models3d/{id}.glb → models3d Map<meshId, ArrayBuffer>
        │
        ▼
ShapeManager.restoreDocumentState(docPayload)   ← same path as OPFS load
ShapeManager.restoreScene3DNodes(nodes3d, models3d)
ShapeManager.scene3d.restoreTextureLibraryData(textureLibrary)
```

Unknown files inside the ZIP (e.g., Frogmarks-injected `frogmarks-state.json`, `thumbnail.png`) are silently ignored.

---

## Data Flow: Cloud Save (Frogmarks Pattern)

Per-mesh chunked saves using dirty tracking — only changed meshes are uploaded:

```
Frogmarks cloud save cycle:
        │
        ▼
dirtyIds = shapeManager.getDirtyMeshIds3D()
        │  returns IDs where mesh.stateDirty === true
        │
        ├─ [if dirtyIds.empty] skip 3D upload
        │
        └─ [if dirtyIds non-empty]:
               for each id in dirtyIds:
                 state = shapeManager.getMeshState3D(id)
                 ← single-mesh serialize; no cost for unchanged meshes
                 gzip(state) → Blob
                 PUT /mesh/{id}  (binary FormData, no base64)
               │
               ├─ allMeshIds stored in ExtendedState.MeshIds (DB)
               └─ on upload success:
                    shapeManager.clearDirtyMeshState3D(dirtyIds)

Texture library:
  if (texLibDirty):
    data = scene3d.getTextureLibraryData()
    gzip(data) → Blob
    PUT /texture-library
    clearTexLibDirty()
```

**Cloud load:**
```
fetch scene3d blob (gunzip → JSON) → nodes[]
for each id in allMeshIds: fetch /mesh/{id} (gunzip → meshState)
fetch /texture-library (gunzip → textureLibData)

shapeManager.restoreScene3DNodes(nodes, glbBuffers)
shapeManager.scene3d.restoreTextureLibraryData(textureLibData)
```

---

## Data Flow: 3D Interaction (Gizmo → Mesh)

```
Canvas pointer event
        │
        ▼
TransformController3D (transform-controller-3d.ts)
        │
        ├─ onPointerDown: pick mesh via Renderer3D.pickMesh()
        │     └─ MeshPicker: GPU readback (meshId encoded in color buffer)
        │
        ├─ onPointerMove: compute delta
        │     Move mode:  translate selected meshes
        │     Rotate mode: compute angle delta around gizmo axis
        │     Scale mode:  compute scale delta from drag distance
        │
        └─ onPointerUp:  callbacks.onTransformComplete(before, after)
                │
                ▼
        Scene3DManager.onTransformComplete callback
                │
                ├─ UndoManager3D.push({ undo: restore before, redo: apply after })
                ├─ for each mesh in after.keys():
                │     mesh.stateDirty = true       ← marks for next save
                └─ [if autoKey3D]: recordKeyframeForMesh(id) per moved mesh
```

---

## Data Flow: 3D Rendering Setup (Scene3DManager → Renderer3D)

When a mesh is created or modified:

```
scene3d.createBox(x, y, z, config)
        │
        ▼
new Mesh3D(interactionService, x, y, z, config)
        │  mesh.gpuDirty = true
        │  mesh.stateDirty = true
        │
        └─ added to sceneGraph.root

Next render():
  draw3DMeshes() → Renderer3D.render(meshes, camera, passEncoder)
        │
        ├─ FrustumCuller.cull(meshes, viewProjection)
        │     → visible subset
        │
        ├─ For each visible mesh where mesh.gpuDirty:
        │     device.createBuffer (vertex + index)
        │     queue.writeBuffer(vertices, indices)
        │     mesh.gpuDirty = false
        │
        ├─ Shadow pre-pass (own encoder, submitted before main pass):
        │     depthPipeline.render(shadowCasters, lightViewProj)
        │     → depth32float texture
        │
        ├─ Opaque pass:
        │     for each opaque mesh:
        │       setPipeline(opaque or textured pipeline)
        │       setBindGroup(0, meshUniformBindGroup)   ← model/view/proj matrices
        │       setBindGroup(1, lightBindGroup)         ← light params + shadow map
        │       [setBindGroup(2, textureBindGroup)]     ← diffuse + normal map sampler
        │       draw(indexCount, 1, 0, 0)
        │
        ├─ Transparent pass (same, depth write OFF):
        │
        └─ Gizmo pass:
              GizmoRenderer.render(selectedMeshes, camera, passEncoder)
```

---

## Key File Quick Reference

| File | What it does | Lines |
|------|--------------|-------|
| `src/services/shape-manager.ts` | Main API singleton; all public operations; owns all delegate managers | ~6400 |
| `src/renderer/core/webgpu-renderer.ts` | GPU device, render loop, interaction modes, `render()` | ~4100 |
| `src/services/managers/scene3d-manager.ts` | All 3D mesh operations, gizmo wiring, cloth, animation, dirty tracking | ~3700 |
| `src/services/managers/raster-manager.ts` | Raster layer CRUD, compositing, cel animation ops | ~3500 |
| `src/renderer/raster/core/raster-compositor.ts` | GPU layer blend, dither, grain, displacement | ~4200 |
| `src/renderer/core/managers/pipeline-manager.ts` | All 16 WebGPU 2D pipeline definitions | ~8000 |
| `src/renderer/core/managers/bindgroup-manager.ts` | Bind group creation and cache | ~900 |
| `src/services/raster-layer-manager.ts` | Layer stack, GPUTexture lifetime, pixel export, timeline | ~3900 |
| `src/services/persistence/document-persistence.ts` | OPFS read/write, auto-save debounce, `DocumentSavePayload` | ~550 |
| `src/services/persistence/project-package.ts` | `.frogmarks` ZIP pack/unpack | ~300 |
| `src/renderer/3d/renderer-3d.ts` | 3D render pass: shadow, opaque, transparent, gizmo | ~2000 |
| `src/renderer/3d/pipeline-3d.ts` | 3D WebGPU pipeline definitions | ~800 |
| `src/renderer/3d/cloth-simulator.ts` | 4-pass GPU PBD compute solver | ~600 |
| `src/renderer/3d/live-cloth-simulation.ts` | Continuous cloth simulation loop | ~500 |
| `src/scene-graph/shapes/base/node.ts` | Base node: visibility, children, parent chain matrix | ~300 |
| `src/scene-graph/shapes/base/shape.ts` | Base shape: fill, stroke, x/y/z, rotation, scale, bounding box | ~600 |
| `src/scene-graph/shapes/mesh-3d.ts` | 3D mesh scene node: geometry, material, `stateDirty`, `gpuDirty` | ~335 |
| `src/scene-graph/shapes/cloth-mesh-3d.ts` | Cloth mesh: grid config, sim state, live config, wind zones | ~400 |
| `src/services/texture-library.ts` | Shared GPU texture store for 3D materials; parallel restore | ~400 |
| `src/services/managers/transform-controller-3d.ts` | Canvas pointer → gizmo → mesh transform pipeline | ~1600 |
| `src/renderer/3d/animation-player-3d.ts` | Keyframe interpolation + `requestAnimationFrame` playback loop | ~300 |
| `src/renderer/render-strategies/webgpu-render-strategy.ts` | `beginFrame()` scene traversal, AABB cull, cache update | ~800 |

---

## Key Invariants

**`gpuDirty` vs `stateDirty`**
- `gpuDirty = true` → GPU vertex/index buffers need re-upload next frame. Cleared by `Renderer3D` after upload. Set by any geometry or material change.
- `stateDirty = true` → save-relevant state has changed since last persist. Cleared only by `clearDirtyMeshState3D()` (after cloud/OPFS save) or `restoreMeshState()`. Animation playback does NOT set `stateDirty`.

**Render scheduling**
- `scheduleRender()` — sets `needsFrame = true`; renders once on next rAF tick.
- `beginInteractive()` / `endInteractive()` — reference-counted continuous render mode. Used during animation playback, gizmo drags, and live cloth simulation.

**OPFS 3D gating**
- Auto-save skips all 3D serialization when `getDirtyMeshIds3D().length === 0`. Raster-only sessions have zero 3D overhead per stroke.
- `packProject()` bypasses the gate (`forceAll3D = true`) — always produces a complete snapshot.

**`scene3dRestored` contract**
- `loadDocument()` returns `scene3dRestored: true` when `scene3d.json` was present in OPFS and meshes were restored. Callers should skip their own 3D restore when this is true to avoid double-restore races.

**Texture library restore order**
- `restoreScene3DNodes()` must complete before `restoreTextureLibraryData()`. The texture library restore iterates `getAllMeshes()` to bind textures to existing mesh nodes — meshes must exist first.

**Transform-only vs full inheritance**
- `Node.transformMode = 'translate-only'` prevents rotation/scale from cascading to children. Used by group containers that hold independently-transformed children.
