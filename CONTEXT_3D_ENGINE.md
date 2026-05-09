# Salsa 3D Engine Context & Next Steps for Claude Opus 4.6

**Date:** April 27, 2026  
**Project:** Salsa (PS1-style 3D + 2D raster hybrid renderer)  
**Workspace:** `c:\Users\szain\source\repos\salsa`  
**Target:** Implement 3D picking, transform gizmos, 3D keyframe animation, and texture library support

---

## Executive Summary

Salsa is a **WebGPU-based hybrid 2D/3D renderer** designed for illustrative 2D+3D artwork. It combines:
- **2D raster layers** (paint, brushes, dither) with frame/cel animation support
- **3D mesh rendering** (PS1-style vertex-lit, affine texture mapping, vertex jitter)
- **Unified scene graph** where 2D shapes and 3D meshes coexist
- **A 3D scene divider layer** that lets raster layers render before AND after 3D meshes (background + foreground)

The frontend **Frogmarks** is a design app that consumes Salsa's APIs via `shapeManager`.

This doc explains what's been built, the architecture, and what needs to work next.

---

## Architecture Overview

### File Structure (Key Locations)

```
src/
├── renderer/
│   ├── core/
│   │   ├── webgpu-renderer.ts         ← Main rendering orchestrator
│   │   └── managers/                  ← View/interaction management
│   ├── 3d/
│   │   ├── renderer-3d.ts             ← 3D mesh drawing (camera, lights, PS1 effects)
│   │   ├── pipeline-3d.ts             ← WebGPU render pipeline creation
│   │   ├── camera-3d.ts               ← Camera perspective/orthographic math
│   │   ├── orbit-controller.ts        ← Mouse/touch orbit controls + damping
│   │   ├── material-3d.ts             ← Material properties (diffuse, spec, emissive)
│   │   └── shaders/
│   │       └── mesh3d-shaders.ts      ← WGSL vertex/fragment shaders
│   ├── raster/
│   │   ├── raster-canvas.ts           ← 2D brush painting
│   │   ├── raster-layer-manager.ts    ← Paint layer lifecycle + frame animation
│   │   └── ...brushes/
│   └── util/
│       ├── aabb.ts                    ← Bounding box culling
│       └── geometry.ts                ← Geometry utilities
├── scene-graph/
│   ├── core/
│   │   ├── scene-graph.ts             ← Tree management (findNodeById, addChild, etc.)
│   │   ├── shape-factory.ts           ← Deserialize nodes from JSON
│   ├── shapes/
│   │   ├── base/
│   │   │   ├── node.ts                ← Base Node (x, y, z, rotation, scale, children)
│   │   │   ├── shape.ts               ← Shape extends Node (2D shapes, 3D meshes)
│   │   │   └── group.ts               ← Group (container with matrix transforms)
│   │   ├── mesh-3d.ts                 ← Mesh3D extends Shape (geometry, material, GPU buffers)
│   │   ├── mesh-group-3d.ts           ← MeshGroup3D (3D group container)
│   │   ├── rectangle.ts, circle.ts... ← 2D shape nodes
│   └── ...other shape types
├── services/
│   ├── managers/
│   │   ├── scene3d-manager.ts         ← 3D API delegate (createBox, setPosition, frameAll, etc.)
│   │   ├── raster-manager.ts          ← Raster API delegate (addLayer, paintStroke, etc.)
│   │   └── manager-context.ts         ← Shared context (sceneGraph, renderer, interactionService)
│   ├── shape-manager.ts               ← PRIMARY USER-FACING API (sm.scene3d.*, sm.raster.*, etc.)
│   ├── animation-manager.ts           ← Frame/cel timeline management
│   └── ...other services (selection, interaction)
└── types/
    └── interaction.ts                 ← Vec2, Vec3, etc.
```

### Rendering Pipeline (Order of Draw)

```
Render frame:
1. Clear render target
2. beginFrame() — collect visible 2D nodes, prepare indirect draw buffers
3. draw2DShapes()     — render raster layer textures
4. drawRasterBG()     — composite raster BG layers → rasterTexture quad
5. draw3DMeshes()     — render 3D meshes with depth testing
6. drawRasterFG()     — composite raster FG layers (above divider) → rasterTextureFG quad
7. drawVectorShapes() — 2D vector shapes (text, scribbles, panels, etc.)
```

**Key concept:** The **3D scene divider layer** is a raster layer entry with `type: '3d-scene'` that acts as a split point:
- Layers below (BG) → render before 3D
- Layers above (FG) → render after 3D

---

## Current Implementation Status

### ✅ Implemented (Phase 1–2)

#### 3D Mesh Rendering
- **Mesh3D node type** — extends Shape, holds geometry + material
- **Primitives:** Box, Sphere, Plane, Cylinder, Torus, Custom
- **Materials:** Diffuse/Specular/Emissive colors, shininess, opacity, `hasTexture` flag
- **GPU buffers:** Per-mesh vertex/index buffers + instance storage buffer (176 bytes per mesh)
- **Pipelines:**`opaqueTextured`, `opaqueUntextured`, `transparentTextured`, `transparentUntextured`
- **Texture support:** GPU texture binding; sampler uses nearest-neighbor (PS1 style)
- **Multi-mesh rendering:** Fixed stride (176 bytes) so N meshes render correctly

#### PS1 Aesthetics
- **Vertex jitter:** Snap vertices to grid during rasterization (screen-space)
- **Color quantization:** Reduce to N levels per channel (5-bit = 32 levels = authentic PS1)
- **Affine texture mapping:** Optional simulated perspective warping
- **Per-vertex Gouraud lighting:** Vertex-lit (not per-pixel) for PS1 chunkiness

#### Camera & Orbit
- **Perspective + Orthographic modes** with FOV, near/far, aspect
- **Orbit controller:** Left-drag rotate, middle/right-drag pan, scroll zoom
- **Damping/momentum:** Per-frame velocity decay with `enableDamping: true`
- **lookAt() method:** Direct position/target setting
- **Frame utilities:** `frameAllMeshes(padding?)`, `frameMesh(nodeId, padding?)`

#### 3D Scene Integration
- **3D scene divider layer:** Raster layer with `type: '3d-scene'`, splits BG/FG composition
- **Layer manager splits:** `getTextureForCompositionSplit() → { background, foreground }`
- **Renderer compositing:** Two raster passes (BG before 3D, FG after 3D)

#### Mesh Grouping
- **MeshGroup3D node type:** Container that transforms children (extends Group)
- **APIs:** `createMeshGroup()`, `addMeshToGroup()`, `removeMeshFromGroup()`, `getMeshGroups()`

#### Texture Upload
- **setMeshTexture(nodeId, source):** Async File/Blob → GPUTexture upload
- **clearMeshTexture(nodeId):** Remove texture, set `hasTexture: false`

#### ShapeManager Routing
- Legacy methods in `shape-manager.ts` now delegate to `scene3d` manager
- Both `sm.scene3d.*` and `sm.*3D()` methods work (aliasing for compatibility)

---

## 📋 Next Steps (TODO)

### 1. 3D Picking + Transform Gizmos (HIGH PRIORITY)

**Goal:** Click on 3D meshes to select them; show move/rotate/scale gizmos; drag to transform.

**Scope:**
- **Ray casting:** Calculate ray from camera through mouse position; check intersection with mesh triangles
- **Selection visual:** Outline or highlight selected mesh (may use stencil buffer or alternate color pass)
- **Gizmo rendering:** Draw Move (XYZ arrows), Rotate (arc circles), Scale (cubes at axis ends)
- **Interaction:** Mouse drag on axis/plane → manipulate selected mesh
- **Mode toggle:** M (move) / R (rotate) / S (scale) hotkeys or UI buttons
- **World vs Local:** Toggle transform space (affects gizmo orientation)
- **Multi-select:** Shift+click to add/remove from selection; transform all selected

**Files to create/modify:**
- `src/renderer/3d/mesh-picker.ts` — Ray casting, triangle intersection
- `src/renderer/3d/gizmo-renderer.ts` — Gizmo mesh generation + rendering
- `src/services/managers/transform-controller-3d.ts` — Handle mouse drag → mesh transform
- `src/renderer/core/webgpu-renderer.ts` — Add picking pass, gizmo draw calls
- `src/services/shape-manager.ts` — Add selection UI update hooks

**Tech details:**
- Ray: `ray = camera.position + t * (worldPosition - camera.position)` where `t = (mouse_screenspace / clipspace)`
- Gizmo render: Simple line/cone meshes, no lighting, flat colors (red=X, green=Y, blue=Z)
- Hit test: Meshes sorted front-to-back; first hit = selected (or use depth buffer)

---

### 2. Keyframe Tracks for 3D Scene (MEDIUM PRIORITY)

**Goal:** Tie 3D mesh transforms + camera to raster layer frame/cel timeline.

**Scope:**
- **3D keyframe track:** Per property (position, rotation, scale, visibility, material color/opacity)
- **Timeline UI integration:** Show 3D tracks alongside raster layer tracks in Frogmarks
- **Playback:** Scrubbing timeline updates 3D mesh state (and camera if camera keyframes exist)
- **Interpolation:** Step (hold), Linear, Bezier curves per track
- **Camera keyframes:** Optional; if present, interpolate camera pose per frame

**Files to create/modify:**
- `src/services/animation-manager.ts` — Extend to support 3D keyframe tracks
- `src/scene-graph/shapes/mesh-3d.ts` — Add `keyframes: Map<property, Frame[]>` field
- `src/services/managers/scene3d-manager.ts` — Add `setMeshKeyframe()`, `getMeshKeyframe()`, etc.
- `src/renderer/core/webgpu-renderer.ts` — Call animation manager per frame to update 3D state
- Serialization: Update `mesh.toJSON()` to include keyframe data

**Tech details:**
- Keyframe format: `{ frame: number, value: number | [x,y,z], easing: 'step'|'linear'|'bezier' }`
- On frame N: `interpolate(track[i], track[i+1], (N - track[i].frame) / (track[i+1].frame - track[i].frame))`
- Note: Animation manager already handles raster layer frames; reuse that pattern

---

### 3. Texture Asset Library (SALSA + FROGMARKS)

**Salsa part (library management):**
- Create `TextureLibrary` class that manages uploaded textures (ID, name, bitmap, GPU texture)
- Store references by ID (not re-uploading on reuse)
- APIs: `uploadTexture(file)`, `getTexture(id)`, `removeTexture(id)`, `listTextures()`
- Persistence: Save texture IDs + metadata in document; load from disk on open

**Frogmarks part (UI):**
- Texture library panel showing thumbnails
- Drag texture onto mesh to apply (or use "Apply to Selected")
- Right-click to rename/delete
- Search/filter by name

**Scope for Salsa:**
- `src/services/texture-library.ts` — Manage texture uploads, storage, reuse
- `src/services/managers/scene3d-manager.ts` — Add `uploadTextureToLibrary()`, `getMeshTextureId()`, etc.
- Serialization: Document format includes texture library metadata

---

### 4. Group Outliner UX Polish (1.5D PRIORITY - mostly Frogmarks, light Salsa)

**Salsa additions:**
- Group `collapsed` state tracking (already in raster layer manager for folders; extend to MeshGroup3D)
- Visibility + locked state propagation to children

**Frogmarks UI polish:**
- Outliner tree view with expand/collapse chevrons for groups and folders
- Visibility eye icon + lock icon per entry
- Drag-and-drop reordering of meshes/groups
- Multi-select in outliner; transform all selected

**Scope for Salsa:**
- `src/scene-graph/shapes/mesh-group-3d.ts` — Add `collapsed?: boolean` field
- `src/services/managers/scene3d-manager.ts` — Add `setGroupCollapsed(groupId, collapsed)`
- Node visibility inheritance: `public isVisible() → visible && parent.isVisible()`

---

## Key APIs Reference

### Scene3DManager (Main Salsa 3D API)

```typescript
// Camera
getCamera(): Camera3D
createCamera(config?: Camera3DConfig): Camera3D
resetCamera(): void
setCameraMode(mode: 'perspective' | 'orthographic'): void
setFOV(fovDeg: number): void
frameAllMeshes(padding?: number): boolean
frameMesh(nodeId: string, padding?: number): boolean

// Mesh Creation
createBox(x, y, z, width?, height?, depth?, material?): Mesh3D
createSphere(x, y, z, radius?, segments?, material?): Mesh3D
createPlane(x, y, z, width?, height?, material?): Mesh3D
createCylinder(x, y, z, radius?, height?, segments?, material?): Mesh3D
createTorus(x, y, z, radius?, tubeRadius?, material?): Mesh3D
createCustomMesh(x, y, z, geometry, material?): Mesh3D

// Mesh Queries & Deletion
getMesh(nodeId: string): Mesh3D | null
getAllMeshes(): Mesh3D[]
deleteMesh(nodeId: string): boolean

// Mesh Properties
setPosition(nodeId, x, y, z): void
setRotation(nodeId, rx, ry, rz): void  // radians
setScale(nodeId, sx, sy, sz): void
setDiffuseColor(nodeId, r, g, b, a?): void
setOpacity(nodeId, opacity): void
setMaterial(nodeId, material): void

// Texture
setMeshTexture(nodeId, source: File|Blob|ImageBitmap): Promise<boolean>
clearMeshTexture(nodeId): boolean

// Grouping
createMeshGroup(name?): MeshGroup3D
getMeshGroups(): MeshGroup3D[]
addMeshToGroup(meshId, groupId): boolean
removeMeshFromGroup(meshId): boolean

// Orbit Controls
enableOrbitControls(config?): OrbitController
disableOrbitControls(): void
toggleOrbitControls(enabled?): void
getOrbitController(): OrbitController | undefined

// PS1 & Lighting
setPS1Config(config: Partial<PS1Config>): void
setDirectionalLight(dx, dy, dz, r?, g?, b?, intensity?): void
setAmbientLight(r, g, b, intensity?): void
```

### Mesh3D Properties

```typescript
class Mesh3D extends Shape {
  id: string                           // Unique node ID
  name: string
  x, y, z: number                     // 3D position
  rotation: number                    // Z-axis 2D rotation
  rotationX, rotationY: number        // X,Y 3D rotations
  scaleX, scaleY, scaleZ: number
  visible: boolean
  locked: boolean
  
  meshPrimitive: MeshPrimitive         // 'box' | 'sphere' | 'plane' | ...
  geometry: MeshGeometry              // { vertices, indices }
  material: Material3D                // { diffuse, specular, emissive, shininess, opacity, hasTexture }
  
  diffuseTexture: GPUTexture | null   // GPU texture handle
  gpuVertexBuffer: GPUBuffer | null
  gpuIndexBuffer: GPUBuffer | null
  gpuDirty: boolean                   // Mark for re-upload to GPU
  
  localMatrix: mat4                   // Computed from x,y,z,rotation,scale
  parent: Node | null
  children: Node[]
  
  setPosition3D(x, y, z): void
  setRotation3D(rx, ry, rz): void
  setScale3D(sx, sy, sz): void
  setPrimitive(type, config?): void
  setDiffuseColor(r, g, b, a?): void
  setOpacity(opacity): void
  setMaterial(partial): void
  toJSON(): any                       // Serialization
}
```

### Scene Graph Structure

```typescript
class Node {
  id: string
  name: string
  x, y, z: number
  scaleX, scaleY, scaleZ: number
  rotation: number
  rotationX, rotationY: number
  visible: boolean
  locked: boolean
  parent: Node | null
  children: Node[]
  
  addChild(child: Node): void
  removeChild(child: Node): void
  forEachDeep(callback: (node: Node) => void): void
  updateParentChainMatrix(): void
  markChildrenParentChainDirty(): void
  
  localMatrix: mat4 // Cached/computed on property change
  parentChainMatrix: mat4 // Ancestors' transforms up to root
}

// Hierarchy:
// - SceneGraph.root (Group node)
//   - Mesh3D, MeshGroup3D, 2D shapes, etc.
//   - MeshGroup3D (container)
//     - Mesh3D, Mesh3D, ...
```

---

## Rendering Pipeline Details

### 3D Draw Path

```typescript
// From webgpu-renderer.ts
async render() {
  // Pre-render callbacks (orbit controller update, etc.)
  for (const cb of preRenderCallbacks) {
    if (cb()) scheduleRender();
  }
  
  // Prepare 2D content
  beginFrame(visibleNodes);
  
  // Render pass inside render target
  const pass = renderTarget.makeRenderPass(...);
  
  // === DRAW ORDER ===
  pass.draw2DShapes(...);           // Flat raster layers BG
  pass.drawRasterBG(...);            // BG raster layers as quad (before 3D)
  pass.draw3DMeshes(...);            // 3D.drawMeshes() called here
  pass.drawRasterFG(...);            // FG raster layers as quad (after 3D)
  pass.drawVectorShapes(...);        // Vector shapes on top
  pass.end();
}
```

### 3D.drawMeshes() Implementation

```typescript
// renderer-3d.ts
drawMeshes(pass: GPURenderPassEncoder, meshes: Mesh3D[], w, h) {
  // Update camera aspect and scene uniforms
  camera.aspect = w / h;
  uploadSceneUniforms(w, h);  // VP matrix, lights, PS1 config
  
  // Ensure instance buffer sized for all meshes
  ensureInstanceBuffer(meshes.length);
  
  // Upload per-mesh model matrix, normal matrix, material
  uploadMeshInstances(meshes);
  
  // Create bind group 0 (instances + scene uniforms)
  meshBindGroup = device.createBindGroup({
    layout: pipeline.meshBindGroupLayout,
    entries: [
      { binding: 0, resource: instanceStorageBuffer },
      { binding: 1, resource: sceneUniformBuffer },
    ]
  });
  
  // Sort opaque front-to-back, transparent back-to-front
  const [opaque, transparent] = partitionByOpacity(meshes);
  
  // Draw opaque
  for (mesh of opaque) {
    pass.setPipeline(useTexture ? opaqueTexturedPipeline : opaqueUntexturedPipeline);
    pass.setBindGroup(0, meshBindGroup);
    if (useTexture) {
      texBG = device.createBindGroup({
        layout: pipeline.textureBindGroupLayout,
        entries: [
          { binding: 0, resource: mesh.diffuseTexture.createView() },
          { binding: 1, resource: pipeline.nearestSampler },
        ]
      });
      pass.setBindGroup(1, texBG);
    }
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(indexCount, 1, 0, 0, meshIndex);  // instanceIndex = meshIndex
  }
  
  // Draw transparent (same, but different pipeline + depth write off)
  ...
}
```

### Gizmo Rendering (TODO)

```typescript
// Proposed: renderer-3d.ts or gizmo-renderer.ts
drawGizmos(pass: GPURenderPassEncoder, selectedMeshes: Mesh3D[], gizmoMode: 'move'|'rotate'|'scale') {
  if (selectedMeshes.length === 0) return;
  
  // Compute gizmo position (center of selected meshes)
  const gizmoPos = computeCenter(selectedMeshes);
  
  // Generate gizmo geometry based on mode
  // - Move: 3 colored arrows (X=red, Y=green, Z=blue)
  // - Rotate: 3 colored arc circles
  // - Scale: 3 colored cubes at axis ends
  
  const gizmoMesh = generateGizmoGeometry(gizmoMode, gizmoPos, transformSpace);
  
  // Render gizmo as wireframe/flat color (no lighting)
  pass.setPipeline(gizmoPipeline);  // Custom pipeline, no lighting
  pass.setVertexBuffer(0, gizmoMesh.vertexBuffer);
  pass.setIndexBuffer(gizmoMesh.indexBuffer, 'uint32');
  pass.drawIndexed(gizmoMesh.indexCount);
}
```

---

## Implementation Checklist for Next Phase

- [ ] **3D Picking**
  - [ ] Ray casting from camera through mouse
  - [ ] Triangle-ray intersection tests
  - [ ] Front-to-back hit detection
  - [ ] Visual selection feedback (outline or tint)
  - [ ] Store selected mesh ID(s) in interaction service

- [ ] **Transform Gizmos**
  - [ ] Generate gizmo geometry (arrows, arcs, cubes)
  - [ ] Render gizmos in 3D space
  - [ ] Detect gizmo axis/plane hit from mouse
  - [ ] Constrain transform to selected axis/plane
  - [ ] Update mesh transform while dragging
  - [ ] Mode switching (M/R/S keys or UI)

- [ ] **Keyframe Animation**
  - [ ] Extend `Mesh3D` with keyframe tracks per property
  - [ ] Add keyframe CRUD to `Scene3DManager`
  - [ ] Integrate with `AnimationManager` frame playback
  - [ ] Interpolate mesh state on timeline scrub
  - [ ] Optional: Camera keyframes

- [ ] **Texture Library**
  - [ ] Create `TextureLibrary` service
  - [ ] Deduplicate GPU textures by ID
  - [ ] Persist library metadata in document JSON
  - [ ] Expose `getTextureLibrary()` API to Frogmarks

- [ ] **Group Outliner Polish**
  - [ ] Add `collapsed` field to `MeshGroup3D`
  - [ ] Implement visibility inheritance
  - [ ] Test multi-select transform

---

## Important Patterns & Conventions

### Transform Updates
Always set transform properties directly on nodes; they auto-dirty internal matrices:
```typescript
mesh.x = 5;  // Sets _x and calls updateLocalMatrix() + markChildrenParentChainDirty()
mesh.rotation = Math.PI / 4;
mesh.scaleX = 2;
```

### GPU Dirty Flag Pattern
Meshes track when their geometry or material changes:
```typescript
mesh.gpuDirty = true;  // Next draw will re-upload buffers
// Later in renderer-3d.ts:
if (!mesh.gpuDirty) return cachedBuffers;
// else: upload new buffers, cache them
```

### Pre-render Callbacks
Renderer supports registered callbacks before each frame (used by orbit controller):
```typescript
renderer.addPreRenderCallback(() => {
  // Called every frame before render()
  if (orbitController) {
    const hadMomentum = orbitController.update();
    if (hadMomentum) scheduleRender();  // Keep animating
    return hadMomentum;
  }
  return false;
});
```

### Scene Graph Tree Walks
```typescript
// Iterate all descendants
sceneGraph.root.forEachDeep((node) => {
  if (node instanceof Mesh3D) { ... }
});

// Find by ID
const node = sceneGraph.findNodeById(id);

// Parent chain traversal
let n = node;
while (n) {
  console.log(n.name);
  n = n.parent;
}
```

### Material/Shader Correspondence
WGSL `MeshInstance` struct (176 bytes) ↔ Mesh3D material + Renderer3D instance upload:
```typescript
struct MeshInstance {
  modelMatrix: mat4x4<f32>,      // 64 bytes
  normalMatrix: mat4x4<f32>,     // 64 bytes
  diffuseColor: vec4<f32>,       // 16 bytes (r,g,b,a)
  specularColor: vec4<f32>,      // 16 bytes (r,g,b, shininess in .a)
  emissiveColor: vec4<f32>,      // 16 bytes (r,g,b, flags in .a)
};  // Total = 176 bytes, aligned to 16 bytes
```

---

## Testing & Debugging Tips

1. **Enable Orbit Damping:** `sm.scene3d.enableOrbitControls({ enableDamping: true, dampingFactor: 0.08 })`
2. **Test Multi-Mesh:** Create 3+ meshes and verify each renders (previously only 1st worked due to stride bug)
3. **Frame All:** `sm.scene3d.frameAllMeshes(1.5)` should zoom camera to fit all meshes
4. **Texture Upload:** Use `await sm.scene3d.setMeshTexture(meshId, file)` with a PNG/JPG; should appear on mesh
5. **Group Transforms:** Nest mesh in group with translation; child should move with parent
6. **PS1 Effects:** Toggle `sm.scene3d.setPS1Config({ vertexJitter: 0.8, snapGridSize: 160, colorDepth: 32 })`

---

## Known Limitations & TODOs

- **No picking system yet** — can't click to select meshes
- **No gizmos** — can't visually manipulate transforms
- **No 3D keyframes** — all animation is 2D raster-only
- **Texture library not persistent** — textures uploaded per-session only
- **Single draw call per mesh** — could batch with instancing for >100 meshes
- **No soft-body deformation** — all meshes are rigid
- **Canvas access:** Currently relies on `webgpuRenderer.getCanvas()`; ensure it's stable

---

## References

- **Camera3D:** `src/renderer/3d/camera-3d.ts` — View/projection matrices, lookAt method
- **OrbitController:** `src/renderer/3d/orbit-controller.ts` — Spherical coordinates, damping
- **Mesh3D:** `src/scene-graph/shapes/mesh-3d.ts` — 3D mesh node
- **Scene3DManager:** `src/services/managers/scene3d-manager.ts` — Main API
- **Renderer3D:** `src/renderer/3d/renderer-3d.ts` — GPU state, draw calls
- **Shaders:** `src/renderer/3d/shaders/mesh3d-shaders.ts` — WGSL vertex/fragment
- **Animation:** `src/services/animation-manager.ts` — Frame timeline (2D; extend for 3D)

---

## Contact / Continuation

This document is the full handoff for continuing 3D engine work. Claude Opus 4.6 should use this as the authoritative reference before diving into code. All file paths are relative to the workspace root `c:\Users\szain\source\repos\salsa`.

**Last updated:** April 27, 2026  
**Build status:** ✅ Clean (npm run build passes)
