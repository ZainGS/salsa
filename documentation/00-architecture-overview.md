# Salsa Renderer — Architecture Overview

Salsa is a **WebGPU-based 2D/3D rendering engine** for an interactive whiteboard/illustration application. It supports vector shapes, freehand drawing, raster painting with layers, SDF text, live HTML-to-GPU text rendering, GPU-compute effects, cel animation, and a PS1-style 3D mesh rendering pipeline.

This guide is organized into self-contained documents. Read them in order for a full understanding, or jump to any section as needed.

---

## Document Index

| # | Document | What You'll Learn |
|---|----------|-------------------|
| 01 | [Scene Graph & Node System](01-scene-graph.md) | The tree structure, Node/Shape base classes, transforms, bounding boxes, parent-child relationships, z-ordering |
| 02 | [Shape Types](02-shape-types.md) | Every shape type (Rectangle, Circle, Scribble, Polygon, etc.), their geometry, properties, and serialization |
| 03 | [WebGPU Renderer Core](03-renderer-core.md) | The main render loop, render pass order, interaction modes, the offscreen render target, pipeline list |
| 04 | [Render Strategy & Draw Commands](04-render-strategy.md) | How `beginFrame()` traverses the scene graph, collects draw commands, and feeds the GPU |
| 05 | [Cache System](05-cache-system.md) | Geometry caches, uniform caches, registries, buffer management, the slice-based allocation model |
| 06 | [Vector Shape Rendering Pipeline](06-vector-rendering.md) | From shape data → geometry generation → GPU buffers → indirect draw calls → screen |
| 07 | [Staging & Live Drawing](07-staging-drawing.md) | How in-progress strokes render via triple-buffered staging, commit flow, drawing services |
| 08 | [Raster Rendering & Layer Compositor](08-raster-system.md) | Raster layers, paint engine, brush system, GPU compositor, blend modes, dithering, grain, onion skin |
| 09 | [Text Rendering](09-text-rendering.md) | SDF text (atlas, glyph compute, shader), LiveText (HTML-in-Canvas, OffscreenCanvas, effect engine), legacy text |
| 10 | [Interaction & Transform System](10-interaction-transform.md) | Pan/zoom, selection, dragging, scaling handles, rotation, coordinate conversion, hit testing |
| 11 | [Services & Managers](11-services-managers.md) | ShapeManager, InteractionService, LayerManager, RasterLayerManager, DrawingServices, AnimationService |
| 12 | [Textures & Atlases](12-textures-atlases.md) | TextureArrayAtlas, PatternAtlas, StampRegistry, TextureCache, instanced textured rendering |
| 13 | [WASM Module](13-wasm-module.md) | Error-diffusion dithering algorithms in Rust, integration with the dither engine |
| 14 | [Utilities](14-utilities.md) | AABB culling, viewport bounds, geometry math, GPU buffer helpers, event emitter, handle hit detection |
| 15 | [3D Rendering System](15-3d-rendering-system.md) | Renderer3D, Pipeline3D, Camera3D, OrbitController, GizmoRenderer, MeshPicker, FrustumCuller, shadow mapping, PS1 aesthetics, TextureLibrary |
| 16 | [3D Animation System](16-3d-animation-system.md) | Keyframe tracks, interpolation, AnimationPlayer3D, UndoManager3D, raster↔3D playback sync |
| 17 | [Cloth Simulation System](17-cloth-simulation-system.md) | PBD physics, Verlet integration, constraint types, graph coloring, four GPU compute passes, GPU pose pass, zero-readback rendering |
| 18 | [Full System Map](18-full-system-map.md) | Complete annotated file tree, component dependency graph, and every major data flow (rendering, raster paint, OPFS save/load, .frogmarks pack/unpack, cloud save, 3D interaction) |

---

## High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Frogmarks (UI)                        │
│   Angular app, toolbar, panels, object list, property editor │
└───────────────────────────┬──────────────────────────────────┘
                            │ calls ShapeManager public API
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      ShapeManager                            │
│   Delegates: raster · text · animation · scene3d ·          │
│              drawing · persist                               │
└──────┬──────────┬──────────┬──────────┬─────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
  SceneGraph  InteractionSvc  Services  WebGPURenderer
       │          │          │          │
       ▼          ▼          │          ▼
    Node tree   Selection   Drawing   RenderStrategy
    (Shapes    Pan/Zoom    Services   ┌──────────┐
     +Mesh3D)                         │beginFrame│──▶ Cache System
                                       │  render  │     ├─ GeometryCaches
                                       │  overlay │     ├─ UniformCaches
                                       └────┬─────┘     ├─ DrawCommandBuffers
                                            │           └─ Texture Atlases
                                            ▼
                                    GPU Render Pass (single pass)
                                     ├─ BG Raster Compositor
                                     │   └─ BG Layers → Blend → Dither → Grain
                                     ├─ Vector Shapes (indirect draws)
                                     │   └─ Shapes, Scribbles, Lines, SDF Text
                                     ├─ 3D Mesh Pass (Renderer3D)
                                     │   ├─ Shadow pre-pass (own encoder, submitted first)
                                     │   ├─ Opaque meshes (Gouraud + optional PCF shadows)
                                     │   ├─ Transparent meshes
                                     │   └─ Gizmos (move/rotate/scale)
                                     ├─ FG Raster Compositor
                                     │   └─ FG Layers above 3D scene entry
                                     ├─ Staging Strokes (live preview)
                                     ├─ Textured Instances (patterns/stamps)
                                     ├─ LiveText Quads
                                     └─ Overlays (carets, selection, dots)
```

---

## Key Design Decisions

### Single Render Pass
All geometry — background, raster composite, vector shapes, text, overlays — is drawn in a **single GPU render pass** to an offscreen texture, then copied to the swap chain. This minimizes GPU state transitions.

### Indirect Draw Calls
Committed vector shapes use `drawIndexedIndirect` — the CPU writes a command buffer containing (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) per shape, and the GPU reads it once per pipeline type. This batches hundreds of shapes into one API call per pipeline.

### Slice-Based Uniforms
Per-shape uniform data occupies **256-byte-aligned slices** in a shared `GPUBuffer(STORAGE)`. Each indirect draw indexes into the buffer using `firstInstance` as a base offset. This avoids per-shape bind group switching.

### Triple-Buffered Staging
In-progress drawing strokes use a triple-buffered staging system to prevent GPU ↔ CPU synchronization stalls. Once committed, the geometry is copied into the shared geometry cache.

### Dual Rendering Modes
The renderer supports **vector mode** (shapes only) and **raster mode** (raster layers composited on GPU + vector overlays). The raster pipeline includes per-layer blend modes, dithering, displacement animations, and paper grain.

### SDF Text
Text is rendered via Signed Distance Fields generated on the GPU using Jump Flood Algorithm compute shaders. Glyphs are packed into a growable atlas texture. This enables crisp text at any zoom level with configurable outlines and smoothing.

### LiveText (HTML-in-Canvas)
A separate text system captures HTML DOM elements or OffscreenCanvas renders to GPU textures each frame, with a shader effect pipeline for real-time text effects (wave, glitch, glow, chromatic aberration, custom WGSL).

### 3D Mesh Rendering
A fully self-contained 3D rendering system (`Renderer3D`) injects into the shared render pass between the background and foreground raster layers. Features: Gouraud lighting with Phong specular, PS1-style vertex snapping and color quantization, PCF soft shadow mapping, frustum culling, interactive transform gizmos, keyframe animation, and a shared texture library for multi-mesh texture reuse.

### Delegate Manager Architecture
`ShapeManager` exposes six typed sub-managers (`raster`, `text`, `animation`, `scene3d`, `drawing`, `persist`) that group related operations. Frogmarks should use these namespaced APIs instead of top-level ShapeManager methods wherever possible.
