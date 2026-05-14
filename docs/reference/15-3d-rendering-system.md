# 15 — 3D Rendering System
**Last Updated:** 2026-05-13  

Salsa includes a self-contained WebGPU 3D rendering system with a PS1-aesthetic pipeline. It coexists with the 2D renderer by drawing into the same render pass, positioned between background and foreground raster layers.

**Root directory:** `src/renderer/3d/`

---

## Architecture Overview

```
ShapeManager.scene3d (Scene3DManager)
    │
    ├─ Renderer3D          ← Core draw loop, uniform upload, frustum cull, shadow pre-pass
    │   ├─ Pipeline3D      ← All GPU pipelines (opaque/transparent/shadow variants)
    │   ├─ Camera3D        ← View/projection matrices, perspective/ortho
    │   ├─ GizmoRenderer   ← Move/rotate/scale gizmo draw + hit test
    │   └─ FrustumCuller   ← 6-plane AABB culling (CPU-side)
    │
    ├─ OrbitController     ← Mouse-driven camera orbit with damping
    ├─ MeshPicker          ← Ray-cast triangle intersection for click-to-select
    ├─ TransformController3D ← Gizmo drag, selection, undo callback
    └─ TextureLibrary      ← Shared GPU textures for mesh materials

Scene graph nodes:
    Mesh3D              ← Individual renderable mesh (geometry + material + keyframes)
    MeshGroup3D         ← Group container for organizing meshes; tracks groupPos3D/groupScale3D/groupRot3D
                           for delta-based child propagation (not serialized — children encode state)
    ParticleEmitter3D   ← CPU-simulated billboard particle emitter
    SkinnedMesh3D       ← Mesh3D + per-vertex joint indices/weights (Linear Blend Skinning)
    Skeleton3D          ← Joint hierarchy + flat skinMatrices array (not a Shape — extends Node)
    ClothMesh3D         ← Mesh with PBD soft-body physics simulation
```

---

## Integration with WebGPURenderer

`Renderer3D` does **not** own the render pass. `WebGPURenderer.draw3DMeshes()` calls `renderer3D.drawMeshes()` and passes the active `GPURenderPassEncoder`. The 3D renderer injects its draw calls at a specific point in the frame:

```
...
5. drawVectorShapes() — vector geometry (shapes, scribbles, lines, SDF text)
6. draw3DMeshes()     ← 3D mesh pass — after vector shapes, before FG raster
7. Foreground raster composite (layers above 3D divider)
8. Staging shapes, LiveText, overlays
...
```

The `Renderer3D` is lazy-initialized on first use. It can also be replaced with `webgpuRenderer.setRenderer3D(customRenderer)` for testing or advanced setups.

---

## Renderer3D

**File:** `src/renderer/3d/renderer-3d.ts`

The central 3D draw orchestrator. Called once per frame with a list of `Mesh3D` nodes.

### Draw Sequence (per frame)

```
drawMeshes(pass, meshes, width, height):
  1. uploadSceneUniforms(w, h)
       ├─ viewProjection mat4x4  (floats 0–15)  ← same buffer also read by drawParticles
       ├─ cameraPosition vec4    (floats 16–19)
       ├─ ambientColor vec4      (floats 20–23)  .a = intensity
       ├─ lightDirection vec4    (floats 24–27)  .w = intensity
       ├─ lightColor vec4        (floats 28–31)
       ├─ ps1Config vec4         (floats 32–35)
       ├─ resolution vec4        (floats 36–39)
       ├─ lightSpaceMatrix mat4  (floats 40–55)  ← only written when shadows enabled
       └─ shadowParams vec4      (floats 56–59)  .y=bias .z=mapSize
       (uses pre-allocated Float32Array — no heap allocation per frame)
  2. ensureInstanceBuffer(meshes.length)
  3. uploadMeshInstances(meshes)           ← SKIPPED if nothing changed (see Instance Dirty Tracking)
       └─ per mesh: modelMatrix + normalMatrix + diffuseColor + specularColor + emissiveColor (176 bytes)
       (reuses pre-allocated staging Float32Array — no heap allocation per frame)
  4. _ensureGeomPool(meshes)               ← SKIPPED if mesh list and geometry unchanged
       └─ Packs all vertex/index data into two shared GPUBuffers (see Geometry Pool)
  5. Ensure meshBindGroup                  ← CACHED — only recreated when instanceStorageBuffer grows
  6. FrustumCuller.fromViewProjection(vp)  ← if frustumCulling enabled
       └─ Sort meshes into opaque[] / transparent[], skipping culled meshes
  7. opaque[] sorted by pipeline key (useTexture | noCull) ← minimizes GPU pipeline state switches
  8. [setVertexBuffer(sharedVB), setIndexBuffer(sharedIB)] ← SET ONCE for outline + shadow + main passes
  9. Shadow pre-pass (if shadowsEnabled)
       └─ New command encoder → depth-only render pass → shadow pipeline → N×drawIndexed → submit
 10. Main opaque draws (pipelines: opaqueTextured / opaqueUntextured or shadow variants)
       └─ setBindGroup(1, createTextureBindGroup(mesh)) ← CACHED per mesh, keyed on texture identity
 11. Main transparent draws (transparentTextured / transparentUntextured, no shadows)
       └─ Same texture bind group cache as opaque
 12. GizmoRenderer.drawGizmo() if selectedMeshIds non-empty

drawParticles(pass, emitters, width, height):   ← called AFTER drawMeshes in the same pass
  1. For each visible emitter:
       - Resolve config.animTextures (TextureLibrary IDs) → atlas layer indices via _atlasLayerMap
       - Call emitter.buildGPUData(animLayers) — writes compact 48-byte structs into emitter.gpuData
         (animLayers=[] → uses static config.textureIndex; animLayers present → per-particle flipbook)
  2. Filter to active emitters (activeCount > 0) — activeCount is set by buildGPUData
  3. Lazy-init particle pipeline (first call only)
  4. Pack all active emitters' gpuData into one growing STORAGE buffer
  5. Write ParticleSceneUniforms (viewProj + cameraRight + cameraUp extracted from view matrix rows)
  6. [if bloom enabled]
       - BloomPass.ensureTextures(w, h) — create/resize rgba16float source + ping textures
       - Lazy-init bloom capture pipeline (uses same particle VS + rgba16float target, additive blend)
       - BloomPass.captureAndBlur():
           a. Capture pass: draw particles into bloom source texture (no depth, additive blend)
           b. H-blur pass: 9-tap Gaussian, source → ping
           c. V-blur pass: 9-tap Gaussian, ping → source
           d. device.queue.submit([encoder.finish()]) ← before main pass encoder submission
  7. Bind group 0: particle STORAGE + scene uniform
  8. Bind group 1: atlas texture_2d_array (or default white 1×1) + nearestSampler
  9. For each emitter: pass.draw(6, activeCount, 0, firstInstance)
       ← 6 procedural vertices per quad, no vertex buffer bound
       ← firstInstance = byte offset into the shared STORAGE buffer / stride
 10. [if bloom enabled] BloomPass.drawComposite(pass) — fullscreen triangle, additive blend
       - Applies soft-knee threshold + intensity to the blurred bloom texture
       - Bright halos accumulate over the already-drawn particle colors
```

### Instance Dirty Tracking

`uploadMeshInstances` (step 3) is gated on a dirty flag to avoid per-frame GPU uploads when nothing changed. This is the main hotspot for large-vertex-count scenes during 2D pan or idle camera:

```
Upload is skipped when ALL of:
  - _instancesDirty = false
  - no mesh has gpuDirty = true
  - meshes.length === _instanceCount (no add/remove)
```

**What sets `_instancesDirty = true`:**
- Startup / first draw
- `markInstancesDirty()` called externally (e.g., after gizmo drag completes in `onTransformComplete`)
- `ensureInstanceBuffer()` grows the storage buffer (capacity change)
- Any mesh with `gpuDirty = true` (geometry or material change) is detected in the upload loop

**`markInstancesDirty()` — public API:**
```typescript
renderer3D.markInstancesDirty()
```
Call this whenever mesh model matrices change outside the `gpuDirty` path — specifically after gizmo transforms, undo/redo of transforms, and animation playback that moves mesh positions. `Scene3DManager.onTransformComplete` already calls this automatically after every gizmo drag. If Frogmarks drives mesh animation keyframes directly, it must call this after advancing the animation state.

**Bind group caching — scene/instances (`meshBindGroup`):** Created once, only recreated when `instanceStorageBuffer` grows (capacity change). Avoids `device.createBindGroup()` every frame for the shared scene+instance uniforms.

**Bind group caching — per-mesh textures (`_texBindGroupCache`):** Each mesh's texture bind group (diffuse + normal map) is cached in a `Map<meshId, { bg, diffuse, normal }>`. A hit requires both texture object references to match. On cache miss the bind group is recreated and the entry is updated. This avoids a `createView()` + `createBindGroup()` driver call per textured mesh per frame. Call `renderer3D.evictTextureBindGroup(meshId)` when a mesh's texture changes or the mesh is removed.

**Normal matrix cache (`_normalMatCache`):** The inverse-transpose matrix required for correct lighting normals is expensive (mat4.invert + mat4.transpose ≈ 40 scalar ops per mesh). `_instancesDirty = true` is a scene-wide flag — without caching, one mesh moving would recompute all N normal matrices. The cache stores 16 floats per mesh keyed on `mesh.localMatrixVersion`; only meshes whose transform actually changed since the last upload recompute. Static meshes in an animated scene pay zero cost.

**World AABB cache (`_meshAABBCache`):** `getMeshWorldAABB3D` (used by the frustum culler) previously scanned the full vertex buffer (O(V)) every frame per mesh. Now two-level cached: local AABB (from vertex scan) is stored until `gpuDirty = true`; world AABB (8-corner transform) is stored until `localMatrixVersion` changes. For a 100k-vertex static mesh, the vertex scan runs once at load time and never again.

**Instance buffer sort + slot map (`_meshInstanceSlots`):** `uploadMeshInstances` sorts meshes by `geometryKey` before writing to the storage buffer. This places all instances of the same primitive type at contiguous slots (e.g. spheres at 0–9, cubes at 10–14). A `_meshInstanceSlots: Map<meshId, slot>` is built alongside so the draw loop can look up the correct buffer index for each frustum-culled mesh.

**GPU instancing (opaque pass):** After frustum culling, `opaque[]` is sorted by `(pipelineKey, geometryKey)`. The draw loop scans for runs sharing the same geometry, pipeline, and texture references, then emits **one instanced draw per contiguous sub-run of instance slots**. Frustum culling can remove members mid-group, creating gaps in the slot sequence. The loop splits at each gap rather than bailing to N individual draws:

```
10 spheres — all visible:        slots {0..9}            → 1 draw
10 spheres — sphere 3 culled:    slots {0,1,2}+{4..9}    → 2 draws  (not 9)
10 spheres — alternating culled: slots {0},{2},{4},...    → 5 draws  (worst case)
```

Each sub-run issues `drawIndexed(indexCount, subLen, firstIndex, baseVertex, firstSlot)`. The shadow pre-pass uses the same sub-run logic (no texture split needed — one pipeline).

**Pipeline sort (opaque pass):** The sort key `(pipelineKey, geometryKey)` ensures `setPipeline()` is called only when the variant actually changes, and same-geometry instances are adjacent for instancing opportunities.

**Buffer reuse:** Both `_instanceDataBuf` (staging for instance data) and `_sceneUniformsData` (scene uniforms) are pre-allocated at construction time (or grown on first use) and reused every frame — no `new Float32Array(...)` allocations in the hot render path.

### Geometry Pool

All mesh vertex and index data is packed into two shared `GPUBuffer`s (`_geomVB`, `_geomIB`) instead of one buffer per mesh. This eliminates N×`(setVertexBuffer + setIndexBuffer)` GPU state changes per frame — the largest driver-overhead bottleneck in scenes with many meshes.

**Per-mesh allocation:** `_geomAllocs: Map<meshId, { baseVertex, firstIndex, indexCount }>`. Each mesh's slice is addressed via the `drawIndexed(count, 1, firstIndex, baseVertex, instanceIdx)` parameters:
- `firstIndex` — element position of this mesh's first index in the shared IB
- `baseVertex` — vertex element index added to each IB value (maps 0-based mesh indices into the shared VB)
- `instanceIdx` — storage buffer slot for model/normal matrix (unchanged from before)

**Geometry deduplication:** Meshes that produce identical vertex/index data share one pool slot. Identity is determined by `Mesh3D.geometryKey` — a string encoding the primitive type and all generation parameters (e.g. `"sphere:0.5:16:12"`). Two meshes with the same key map to the same `{ baseVertex, firstIndex }` in the pool; their geometry is uploaded only once.

```
10 default spheres (key="sphere:0.5:16:12") + 5 default cubes (key="box:1:1:1"):
  Old pool: 15 copies of geometry  — 15 writeBuffer calls, 15× the VRAM
  New pool:  2 unique geometries   —  2 writeBuffer calls, all 15 meshes share them
```

Custom and imported meshes always get a unique key (`custom:<meshId>`) and are never deduplicated — their geometry is arbitrary.

**Cloth override compatibility:** Cloth-simulated meshes register a compute-written `GPUBuffer` via `setVertexBufferOverride()`. The shared IB is still used for those meshes (indices are 0-based within the mesh, compatible with `baseVertex=0` and the override VB). Only VB slot 0 switches on cloth draws, not the IB.

**API call count comparison (N meshes, C cloth overrides):**
| Approach | API calls per frame | VRAM for geometry |
|----------|---------------------|-------------------|
| Old (per-mesh buffers) | 3N | N × mesh size |
| Geometry pool (no dedup) | 2 + N + 3C | N × mesh size |
| Geometry pool + dedup | 2 + N + 3C | unique geometries only |

At 500 meshes with 1 cloth mesh: 1500 → 505 API calls. With 50 spheres, sphere geometry lives in VRAM once instead of 50 times.

**Pool rebuild:** `_ensureGeomPool` rebuilds when:
- Any mesh has `gpuDirty = true` (geometry changed or new import)
- Mesh list count or order changed (mesh added or removed)
- Pool not yet initialized

During rebuild, `_fullRebuildGeomPool` iterates meshes once, grouping by `geometryKey`. Each unique key triggers one `writeBuffer` pair; all other instances with that key reuse the same `alloc` with zero additional uploads. Between rebuilds (every static frame), the check is O(N) identity comparison — essentially free. Shared buffer capacity grows at 1.5× to amortize future rebuilds.

### Configuration

```typescript
renderer3D.setAmbientLight(r, g, b, intensity)
renderer3D.setDirectionalLight(dx, dy, dz, r, g, b, intensity)
renderer3D.setPS1({ vertexJitter, snapGridSize, affineStrength, colorDepth })
renderer3D.enableShadows(mapSize?, halfExtent?, bias?)
renderer3D.disableShadows()
renderer3D.frustumCulling = true | false   // default true
renderer3D.markInstancesDirty()            // force re-upload of all instance data next frame
renderer3D.evictTextureBindGroup(meshId)   // invalidate cached texture bind group for a specific mesh
```

### Scene Uniform Buffer

The `SceneUniforms` buffer is **256 bytes** (padded from 240 for WebGPU 256-byte alignment). Base mesh3D shaders only read the first 160 bytes — backward compatible with the extended shadow layout.

| Offset | Field | Size |
|--------|-------|------|
| 0 | `viewProjection: mat4x4<f32>` | 64 B |
| 64 | `cameraPosition: vec4<f32>` | 16 B |
| 80 | `ambientColor: vec4<f32>` (.a = intensity) | 16 B |
| 96 | `lightDirection: vec4<f32>` (.w = intensity) | 16 B |
| 112 | `lightColor: vec4<f32>` | 16 B |
| 128 | `ps1Config: vec4<f32>` (jitter, gridSize, affine, colorDepth) | 16 B |
| 144 | `resolution: vec4<f32>` (.x=w, .y=h) | 16 B |
| 160 | `lightSpaceMatrix: mat4x4<f32>` | 64 B |
| 224 | `shadowParams: vec4<f32>` (.y=bias, .z=mapSize) | 16 B |
| 240–255 | padding | 16 B |

### MeshInstance Buffer

One **192-byte** entry per mesh in a GPU storage buffer:

| Offset | Field | Size |
|--------|-------|------|
| 0 | `modelMatrix: mat4x4<f32>` | 64 B |
| 64 | `normalMatrix: mat4x4<f32>` (inverse-transpose of model) | 64 B |
| 128 | `diffuseColor: vec4<f32>` (.a = opacity) | 16 B |
| 144 | `specularColor: vec4<f32>` (.a = shininess) | 16 B |
| 160 | `emissiveColor: vec4<f32>` (.a = bitcast flags) | 16 B |
| 176 | `textureIndex: u32` | 4 B |
| 180 | `normalMapIndex: u32` | 4 B |
| 184 | `_pad0: u32, _pad1: u32` | 8 B |

`textureIndex` / `normalMapIndex` select the layer of the shared `texture_2d_array` atlas. Standalone meshes (no `textureLibraryId`) always use index 0 of their own 1-layer texture view. TextureLibrary meshes use the atlas layer assigned by `_buildTextureAtlas()`.

The storage buffer grows at 1.5× capacity as meshes are added. Indexed by `@builtin(instance_index)` in the vertex shader.

---

## Pipeline3D

**File:** `src/renderer/3d/pipeline-3d.ts`

Creates and owns all WebGPU render pipelines for 3D rendering. Instantiated by `Renderer3D`.

### Vertex Format

48 bytes per vertex — `MESH3D_VERTEX_STRIDE = 48`:

| Offset | Attribute | Format |
|--------|-----------|--------|
| 0 | `position: vec3<f32>` | `float32x3` |
| 12 | `normal: vec3<f32>` | `float32x3` |
| 24 | `uv: vec2<f32>` | `float32x2` |
| 32 | `tangent: vec4<f32>` | `float32x4` |

The tangent `.xyz` is the object-space tangent direction and `.w` is the handedness (+1 or −1) used to compute the bitangent as `cross(normal, tangent.xyz) * tangent.w`.

### Pipelines

| Name | Layout | Use Case |
|------|--------|----------|
| `opaqueTexturedPipeline` | [mesh, texture] | Opaque mesh with diffuse texture |
| `opaqueUntexturedPipeline` | [mesh] | Opaque solid-color mesh |
| `transparentTexturedPipeline` | [mesh, texture] | Transparent mesh with texture |
| `transparentUntexturedPipeline` | [mesh] | Transparent solid-color mesh |
| `opaqueTexturedShadowPipeline` | [mesh, texture, shadow] | Opaque textured + shadow recv |
| `opaqueUntexturedShadowPipeline` | [mesh, shadow] | Opaque untextured + shadow recv |
| `shadowPassPipeline` | [mesh] | Depth-only shadow pre-pass |

All opaque pipelines use `depthWriteEnabled: true`, `depthCompare: 'less'`, `cullMode: 'back'`.
Transparent pipelines use `depthWriteEnabled: false` with standard alpha blend.
Shadow pass uses `depthFormat: 'depth32float'`, `cullMode: 'front'` (front-face cull = Peter-Pan bias compensation).

### Bind Group Layouts

| Group | Bindings | Used by |
|-------|----------|---------|
| `meshBGL` (group 0) | binding 0: instances (storage), binding 1: scene (uniform) | All pipelines |
| `textureBGL` (group 1) | binding 0: diffuseTexture, binding 1: diffuseSampler, binding 2: normalMapTexture, binding 3: normalMapSampler | Textured pipelines |
| `shadowBGL` (group 2 for textured, group 1 for untextured) | binding 0: shadowMap (depth), binding 1: shadowSampler (comparison) | Shadow pipelines |

**Note on bind group gaps:** The untextured shadow pipeline uses `@group(1)` for the shadow bind group (not `@group(2)`). WebGPU disallows gaps in bind group indices, so placing shadow at group 1 when there is no texture group at group 1 is the correct layout.

**Default placeholder textures:** When a mesh uses the textured pipeline but has no diffuse or normal map assigned, `Renderer3D` lazily creates 1×1 fallback textures:
- `_defaultWhiteTex` — `(255, 255, 255, 255)` used as the diffuse when `hasNormalMap=true` but no diffuse is set
- `_defaultFlatNormalTex` — `(128, 128, 255, 255)` encodes a flat surface normal `(0, 0, 1)` in tangent space, used when no normal map is set

### Samplers

- `nearestSampler` — nearest-neighbor mag/min filter, repeat address mode. Used for PS1 texture aliasing.
- `shadowSampler` — comparison sampler (`compare: 'less'`, `minFilter: 'linear'`) for PCF shadow lookups.

---

## Shadow Mapping

**Shader files:** `src/renderer/3d/shaders/shadow-shaders.ts`

### Light Space Matrix

`computeLightSpaceMatrix()` builds an orthographic VP matrix for the directional light:

```
eye = -lightDirection * (halfExtent * 4)
center = (0, 0, 0)
up = (0, 1, 0) — or (1, 0, 0) if light is near-vertical
view = lookAt(eye, center, up)
proj = ortho(±halfExtent, ±halfExtent, 0.1, halfExtent * 8)
lightSpaceMatrix = proj * view
```

The orthographic extents (`±halfExtent`) control how large a region of the scene receives shadows. Increase `halfExtent` for larger scenes.

### Shadow Pre-Pass

A depth-only render pass runs in a **separate command encoder** before the main render pass:

```
device.createCommandEncoder()
  → beginRenderPass({ depthStencilAttachment: shadowTextureView })
  → setPipeline(shadowPassPipeline)   ← depth-only, front-face cull
  → draw all opaque meshes
  → end()
device.queue.submit([shadowEncoder.finish()])
   ↑ submitted BEFORE the main pass encoder, so GPU executes it first
```

The shadow map (`depth32float` texture) is then bound in the main pass for shadow sampling.

### PCF Soft Shadows

The fragment shaders sample the shadow map with a 3×3 PCF kernel (9 taps). The shadow factor is averaged across taps, then used to attenuate the fragment color:

```wgsl
finalColor.rgb *= mix(0.3, 1.0, shadowFactor)
// shadowFactor = 1.0 → fully lit; shadowFactor = 0.0 → 30% ambient only
```

The 30% minimum ensures shadowed areas still receive ambient light and aren't completely black.

### Bias

A depth bias (`shadowParams.y`) is subtracted from the NDC z depth before the comparison to prevent shadow acne (self-shadowing artefacts). Default: `0.002`.

---

## Camera3D

**File:** `src/renderer/3d/camera-3d.ts`

Holds position, target, up vector, and projection parameters. Computes a combined view-projection matrix each frame.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `position` | `vec3` | `[0, 0, 3]` | World-space camera position |
| `target` | `vec3` | `[0, 0, 0]` | Look-at target |
| `up` | `vec3` | `[0, 1, 0]` | Up vector |
| `fov` | `number` | π/3 (60°) | Vertical field of view (radians) |
| `aspect` | `number` | 1 | Width / height — updated each frame from canvas |
| `near` / `far` | `number` | `0.1` / `1000` | Clip planes |
| `mode` | `'perspective' \| 'orthographic'` | `'perspective'` | Projection type |
| `orthoSize` | `number` | 5 | Half-height of the ortho frustum |

Key methods:
- `lookAt(ex, ey, ez, tx, ty, tz)` — set position and target in one call
- `getViewProjectionMatrix()` — returns a cached `mat4` (recomputed when dirty)
- `getViewMatrix()` / `getProjectionMatrix()` — individual matrices

---

## OrbitController

**File:** `src/renderer/3d/orbit-controller.ts`

Converts pointer events into spherical-coordinate camera movement with momentum/damping.

| Property | Default | Description |
|----------|---------|-------------|
| `radius` | `5` | Distance from target |
| `elevation` | `0.4` rad | Vertical angle (clamped to avoid gimbal) |
| `azimuth` | `0` rad | Horizontal angle |
| `enableDamping` | `true` | Momentum after release |
| `dampingFactor` | `0.08` | Per-frame velocity decay (lower = more glide) |
| `enabled` | `true` | When false, ignores all input |

Pointer events: `pointerdown` → start drag, `pointermove` → orbit (left) / pan (right/middle), `wheel` → zoom.

The `update()` method must be called once per frame to apply damping. `Scene3DManager.enableOrbitControls()` registers this via `webgpuRenderer.addPreRenderCallback()`.

---

## FrustumCuller

**File:** `src/renderer/3d/frustum-culler.ts`

CPU-side AABB-vs-frustum test for skipping off-screen meshes before any GPU work.

### Plane Extraction (Gribb–Hartmann, WebGPU convention)

```
vp = column-major view-projection matrix
row i = [m[i], m[i+4], m[i+8], m[i+12]]

Left:   row3 + row0
Right:  row3 - row0
Bottom: row3 + row1
Top:    row3 - row1
Near:   row2          ← WebGPU z ∈ [0,1], no OpenGL row3+row2
Far:    row3 - row2
```

Each plane is normalized to unit length.

### AABB Test

For each of the 6 planes, find the "positive vertex" — the AABB corner maximizing the dot product with the plane normal:

```
px = (a >= 0) ? maxX : minX
py = (b >= 0) ? maxY : minY
pz = (c >= 0) ? maxZ : minZ
if (a*px + b*py + c*pz + d < 0) → outside this plane → cull
```

If the AABB survives all 6 planes, it's visible (or potentially visible — false positives are acceptable).

### World AABB from Mesh

`Renderer3D.getMeshWorldAABB3D(mesh)` transforms 8 object-space AABB corners through the model matrix to get a tight world-space AABB:

```typescript
// gl-matrix column-major: wx = m[0]*cx + m[4]*cy + m[8]*cz + m[12]
for (ci = 0..7) {
  cx = (ci & 1) ? ox1 : ox0;  cy = (ci & 2) ? oy1 : oy0;  cz = (ci & 4) ? oz1 : oz0;
  wx = m[0]*cx + m[4]*cy + m[8]*cz + m[12];
  ...
}
```

---

## GizmoRenderer

**File:** `src/renderer/3d/gizmo-renderer.ts`

Renders interactive transform gizmos (move/rotate/scale axes) on top of selected meshes, plus the OBB selection box with corner scale handles.

- **Move:** Three arrows along X/Y/Z axes + three plane handles (XY, XZ, YZ)
- **Rotate:** Three arcs around X/Y/Z axes
- **Scale:** Three axis handles + 8 OBB corner sphere handles (Spline-style)

Key methods:
- `drawGizmo(pass, meshes, camera, mode, hoveredAxis, w, h)` — issues GPU draw calls
- `drawSelectionBox(pass, meshes, camera, hoveredCorner)` — draws the OBB wireframe + corner spheres for a single mesh, or a unified world AABB wireframe (no corners) for multiple meshes; `hoveredCorner` (0–7) highlights the hovered corner in yellow
- `hitTest(rayOrigin, rayDir, meshes, camera, mode)` — returns hovered `GizmoAxis` (`'x'|'y'|'z'|'xy'|'xz'|'yz'|null`)
- `hitTestCorner(rayOrigin, rayDir, meshes, camera)` — ray-sphere test against the 8 OBB corners; returns corner index (0–7) or `null`; returns `null` when `meshes.length !== 1` (no corner handles for multi-mesh groups)
- `computeCenter(meshes)` — returns world-space centroid of selected meshes
- `computeCombinedAABBCorners(meshes)` — iterates all OBB corners from all meshes and returns 8 corners of their combined world-space AABB; used by `buildSelectionBoxGeometry` when `meshes.length > 1`

Gizmos are drawn in a post-projection pass with depth write disabled so they always appear on top.

### Orientation Mode (World / Local)

`GizmoRenderer` has a public field:
```typescript
orientationMode: 'world' | 'local' = 'world';
```

- **World** — gizmo handles are always world-axis-aligned (default). The X handle always points in world +X, etc.
- **Local** — handles rotate with the selected mesh. The X handle points along the mesh's local X axis.

The gizmo model matrix changes accordingly:
```
World:  translate(center) → scale(gizmoScale)
Local:  translate(center) → rotate(meshRotation) → scale(gizmoScale)
```

The mesh rotation is extracted from `localMatrix` by normalising its column vectors (strips scale, keeps pure rotation). Both `drawGizmo` and `hitTest` use the exact same model matrix, so picking always matches the visual.

`TransformController3D` has a matching `orientationMode` getter/setter. Setting it also updates `GizmoRenderer.orientationMode` and schedules a render. At drag start in local mode, the local X/Y/Z axis directions are captured into `DragState.localBasis` so they don't need to be re-extracted each frame.

The drag operations in local mode:
- **Move** — projects delta onto `localBasis.x/y/z` (or removes local normal component for plane handles)
- **Scale** — uses `localBasis.x/y/z` as the screen-space tip direction for the drag projection
- **Rotate** — per-mesh rotation axis is the local axis column instead of world axis; also dynamically detects which ring is face-on to the camera (dot product with camera view direction) and uses screen-space angular delta for face-on rings, dx+dy for edge-on rings

Public API: `shapeManager.setGizmoOrientation3D('world' | 'local')` / `getGizmoOrientation3D()`.

See [Gizmo Orientation spec](../specs/gizmo-orientation.md) for details.

### OBB Selection Box vs. World AABB

The selection box is drawn using the mesh's **Oriented Bounding Box (OBB)** — the 8 corner points of the geometry bounding box transformed through the full model matrix (translation × rotation × scale). The OBB corners stay tight around the mesh regardless of orientation.

**Why not a world AABB?** A world-space axis-aligned bounding box is computed by taking the min/max of the OBB corners across each world axis. This collapses 3D orientation into a flat envelope that grows whenever the mesh is rotated away from axis alignment — a mesh rotated 45° around Y produces a world AABB roughly √2 wider than the mesh itself. The visual result is a box that never matches what the user sees.

```
         OBB (correct)              World AABB (incorrect for rotated mesh)
         ┌──────┐                   ┌──────────────┐
        /  mesh /                   │              │
       /  ┌──/ ┐                    │   (padded)   │
      └──────┘                      └──────────────┘
```

**Exception — multi-mesh groups:** when multiple meshes are selected (e.g. all parts of a GLB-imported model group), a single **unified world AABB** is drawn around all of them using `computeCombinedAABBCorners`. This is intentional: the individual OBBs at different orientations would look noisy, and the merged box cleanly shows the group footprint. Corner scale handles are disabled for multi-mesh selections.

**Implementation:** `Mesh3D.calculateBoundingBox()` stores both:
- `obbCorners` — 8 world-space corner positions (`[number,number,number][]`), updated every time `updateLocalMatrix()` runs
- `obbLocalCorners` — 8 geometry-space corner positions (fixed for a given mesh geometry)

Corner indices are bit-encoded: bit 0 = X side (0=min, 1=max), bit 1 = Y side, bit 2 = Z side. The corner opposite to corner `ci` is `ci ^ 7`.

**Frustum culling** still uses a world AABB (from `getMeshWorldAABB3D` in `Renderer3D`), which is derived from the OBB corners. Over-rejection of off-screen meshes is acceptable; under-rejection of on-screen meshes is not. The selection UI uses OBB exclusively for single meshes, unified AABB for groups.

### Corner Scale Handles

When scale mode is active, all 8 OBB corner spheres become interactive **for single-mesh selections only**. Dragging a corner scales the mesh while holding the **opposite corner** (the anchor) fixed in world space — matching the Spline 3D editor's corner-drag behavior. Multi-mesh group selections do not show corner handles (`hitTestCorner` returns `null` when `meshes.length !== 1`).

**Hit test:** `hitTestCorner` performs a ray-sphere test against each OBB corner position, using a hit radius 2× the visual sphere size for easier selection.

**Scale math:** Given corner index `ci`, the anchor is `corners[ci ^ 7]`. For each frame of the drag:

1. Project the mouse ray onto a camera-facing plane through the initial dragged-corner world position → `newDraggedWorld`
2. `delta = newDraggedWorld − anchorWorld`
3. Extract unit local axes `r0, r1, r2` from the normalised columns of the model matrix (captured at drag start; rotation is constant during scale)
4. Solve the system `sx·dxG·r0 + sy·dyG·r1 + sz·dzG·r2 = delta` via dot products (orthonormal basis):

```
sx' = (r0 · delta) / dxG
sy' = (r1 · delta) / dyG
sz' = (r2 · delta) / dzG
```

where `dxG = draggedGeom.x − anchorGeom.x` (geometry-space axis extent).

5. New translation to hold the anchor fixed:

```
T' = anchorWorld − sx'·anchorGeom.x·r0 − sy'·anchorGeom.y·r1 − sz'·anchorGeom.z·r2
```

---

## MeshPicker

**Files:** `src/renderer/3d/mesh-picker.ts`, `src/renderer/3d/mesh-bvh.ts`

Ray-triangle intersection for click-to-select **and** hover detection (the hover handler fires on every `mousemove` over the canvas). Both paths transform the ray into object space and use one of two strategies:

```
pickMesh(mouseX, mouseY, w, h, camera, meshes)
  → castRay() — unproject pixel through inverse VP
  → For each visible mesh:
      → Transform ray to local space (inverse model matrix)
      → Strategy A — static mesh (gpuDirty = false):
            BVH traversal   O(log N)   build once, cache forever
            After BVH finds winning triangle, re-runs MT on that triangle to recover baryU/baryV
      → Strategy B — dynamic mesh (gpuDirty = true, e.g. cloth):
            AABB pre-reject  O(1)
            Linear scan      O(N)      BVH evicted; rebuilt when geometry settles
  → Returns PickResult or null
```

### PickResult

```typescript
interface PickResult {
  mesh: Mesh3D;
  distance: number;          // world-space distance from camera origin to hit
  triangleIndex: number;     // index of first triangle vertex (triIndex * 3)
  hitPoint: [number, number, number];  // world-space hit position
  baryU: number;             // barycentric weight for indices[tri*3+1]
  baryV: number;             // barycentric weight for indices[tri*3+2]
  // baryW = 1 - baryU - baryV is weight for indices[tri*3+0]
}
```

`baryU`/`baryV` are used by `MeshPaintManager` to interpolate the UV at the hit point without storing redundant world-space UV data. See [Mesh Painting](#mesh-painting).

### MeshBVH

**File:** `src/renderer/3d/mesh-bvh.ts`

An axis-aligned BVH built over a mesh's local-space triangles. Local-space means the tree is valid across all object transforms — only vertex edits require a rebuild.

**Build:** `MeshBVH.build(verts, idxs)` — centroid median split along the longest axis, `LEAF_MAX = 8` triangles per leaf. O(N log N). Called lazily on first pick of a static mesh; result stored in `MeshPicker._bvhCache` keyed by `mesh.id`.

**Traverse:** `bvh.intersect(ox, oy, oz, dx, dy, dz)` — slab AABB test at each node, leaf tests with Möller–Trumbore. Children are visited closer-first; if the closer child's hit t is ≤ the farther child's entry t, the farther child is skipped entirely (ordered early-exit). O(log N) in the common case.

**All math is scalar** — zero heap allocations during traversal.

**Invalidation:** When `mesh.gpuDirty = true`, the BVH cache entry is deleted before the linear-scan fallback runs. It is rebuilt on the next pick after `gpuDirty` clears (i.e., after geometry is re-uploaded to the GPU). `MeshPicker.evictMesh(meshId)` clears both the BVH and AABB cache for a mesh that is removed from the scene.

**Never rebuild for transforms:** Translating, rotating, or scaling a mesh does not set `gpuDirty` — the BVH remains valid because the ray is always transformed into local space before intersection.

**Cloth meshes:** `ClothMesh3D` sets `gpuDirty = true` every simulation step, so it always takes the linear-scan path. Since cloth typically has modest triangle counts and isn't meant to be clicked, this is acceptable.

### NDC near-plane convention

`castRay` uses `z = 0` for the near-plane NDC point (not `-1`). WebGPU's `perspectiveZO` / `orthoZO` maps near → z=0 and far → z=1, unlike OpenGL which maps near → −1. Using z=−1 would place the ray origin behind the near plane and produce incorrect pick rays.

### Convenience pick method

`pickFromClient3D(clientX, clientY, canvasRect)` on `ShapeManager` accepts raw `MouseEvent` client coordinates plus `canvas.getBoundingClientRect()`. DPR cancels in the NDC computation, so CSS pixels are always correct. **Prefer this over `pick3D` for Frogmarks event handlers.**

```typescript
const hit = shapeManager.pickFromClient3D(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
```

### Hover handler coordinate scaling

The hover handler inside `enableTransformControls` scales mouse coordinates by `el.width / rect.width` before calling `pick3D`, converting CSS pixels to physical canvas pixels so the pick ray matches the actual GPU geometry dimensions.

---

## TransformController3D

**File:** `src/services/managers/transform-controller-3d.ts`

Handles canvas pointer events for 3D mesh selection and gizmo dragging. Attached to the canvas via `attach(canvas)`.

### Callbacks

The controller receives a `TransformControllerCallbacks` object:

| Callback | Purpose |
|----------|---------|
| `getMeshes()` | Provide current mesh list for picking |
| `getCamera()` | Camera for ray casting |
| `getCanvasSize()` | Canvas dimensions |
| `getSelectedIds()` | Current selection set |
| `setSelectedIds(ids)` | Update selection |
| `scheduleRender()` | Request a frame |
| `getOrbitController?()` | Orbit reference for enable/disable during drag |
| `onTransformComplete?(before, after)` | **Undo hook** — fires after a drag ends with before/after transform snapshots |

### Drag Resolution

1. `pointerdown` → in scale mode, hit-test OBB corners first (`hitTestCorner`); if a corner is hit, start a corner scale drag. Otherwise hit-test the gizmo axis handles. Either way: capture pointer, disable orbit, start drag.
2. `pointermove` → if dragging, apply move/rotate/scale delta via `applyDrag()`; if not dragging in scale mode, update `hoveredCorner` for highlight
3. `pointerup` → end drag, re-enable orbit, call `onTransformComplete` with snapshots

The drag plane for axis constraints is chosen to maximize visibility: for an axis constraint, the plane containing the axis that faces the camera most directly. For corner drags, the plane passes through the initial dragged-corner world position and faces the camera.

`hoveredCorner` is exposed as a getter and synced to `Renderer3D.setHoveredCorner()` each frame via the pre-render callback in `Scene3DManager`.

### Group Bubble-Up Selection

When a `Mesh3D` is picked on the canvas and its parent in the scene graph is a `MeshGroup3D`, `Scene3DManager._expandGroupSelection` is called before updating the selection. It expands the selection to all sibling `Mesh3D` children and returns the group's ID for the outliner highlight (`setSelectedNode`). The net effect: clicking any part of a multi-mesh model selects the whole group.

Individual parts can still be selected via the outliner — clicking a child node directly calls `setSelectedIds([childId])` bypassing bubble-up, so the part is selected alone.

`_expandGroupSelection` is an internal method on `Scene3DManager` (not exposed on `TransformController3D`) because group structure knowledge lives within the manager. The controller's `setSelectedIds` callback is the hook point.

---

## Mesh Generators

**File:** `src/renderer/3d/mesh-generators.ts`

Pure functions that return `MeshGeometry { vertices: Float32Array, indices: Uint32Array }`.
Vertex stride: 12 floats — `FLOATS_PER_VERT = 12` (position xyz, normal xyz, uv xy, tangent xyzw).

| Generator | Parameters |
|-----------|------------|
| `generateBox(w, h, d)` | Per-face quads (24 vertices) for correct UVs and normals; tangent analytically derived from UV U-direction per face |
| `generateSphere(radius, wSegs, hSegs)` | UV sphere, poles joined; tangent = `(-sin(θ), 0, cos(θ))`, w=+1 |
| `generatePlane(w, h, wSegs, hSegs)` | Subdivided flat plane in XZ; tangent = `(1, 0, 0)`, w=+1 |
| `generateCylinder(rTop, rBot, h, radSegs)` | Sides + caps; side tangent = `(-sin, 0, cos)`, cap tangent = `(1, 0, 0)`, w=+1 |
| `generateTorus(radius, tubeRadius, radSegs, tubSegs)` | Donut; tangent = `(-sin(u), 0, cos(u))`, w=+1 |

### Legacy Geometry Upgrade

`computeTangents(geom8: MeshGeometry): MeshGeometry` — converts 8-float/vertex geometry (no tangent) to the 12-float format. Uses Mikktspace-compatible Gram-Schmidt tangent computation per triangle. Called automatically in `Mesh3D.setGeometry()` when the input vertex count is a multiple of 8 but not 12.

---

## Material3D

**File:** `src/renderer/3d/material-3d.ts`

```typescript
interface Material3D {
  diffuse:      RGBA;     // base color
  specular:     RGBA;     // .a = shininess exponent (1–256)
  emissive:     RGBA;     // self-illumination (not affected by lighting)
  shininess:    number;   // mirrors specular.a
  opacity:      number;   // <1 = transparent pipeline
  hasTexture:   boolean;  // enables diffuse texture sampling in shader
  hasNormalMap: boolean;  // enables per-pixel Phong + TBN normal mapping in shader
}
```

**Default:** grey diffuse `(0.8, 0.8, 0.8)`, subtle specular `(0.3, 0.3, 0.3)`, no emissive, shininess 16, opacity 1, `hasNormalMap: false`.

**Flags:** `encodeMaterialFlags(mat)` packs flags into a `u32`, bitcast into the `emissiveColor.a` field for transport to the shader:
- Bit 0: `hasTexture`
- Bit 1: `hasNormalMap`

Setting `hasNormalMap=true` also forces the textured pipeline path (normal maps require the 4-binding texture bind group). If no diffuse texture is set, a white 1×1 default is used automatically.

---

## TextureLibrary

**File:** `src/services/texture-library.ts`

Shared GPU texture store. Multiple meshes can reference the same texture entry by ID, avoiding duplicate uploads.

| Method | Description |
|--------|-------------|
| `upload(source, name?)` | Upload from `File \| Blob \| ImageBitmap`, returns a nanoid |
| `getTexture(id)` | Returns `GPUTexture` or null |
| `getEntry(id)` | Full entry including metadata |
| `listEntries()` | All entries |
| `rename(id, name)` | Update display name |
| `remove(id)` | Destroy GPU texture and remove entry |
| `toJSON()` | Metadata-only snapshot (no image data) |
| `toJSONWithData()` | Full snapshot including base64 WebP data URLs |
| `restoreFromJSON(data)` | Re-upload all entries from data URLs in **parallel** (`Promise.all`) — used on document load |
| `destroy()` | Destroy all GPU textures |

Textures are stored as `rgba8unorm` with `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT` usage. A WebP base64 data URL is captured at upload time for serialization.

`restoreFromBitmap(id, bitmap, name, knownDataUrl?)` accepts an optional `knownDataUrl` to skip re-encoding the bitmap back to WebP — during `restoreFromJSON` the data URL is already known, so re-encoding is skipped.

### Persistence

`getSceneGraphJSON()` includes the texture library data:
```typescript
// Saved document format:
{
  nodes: [...],
  textureLibrary: { entries: [{ id, name, width, height, dataUrl }] }
}
```

On load, call `sm.scene3d.restoreTextureLibraryData(data.textureLibrary)` to re-upload textures and re-bind them to any meshes whose `textureLibraryId` matches a library entry.

---

## PS1 Aesthetic Pipeline

All 3D shaders share PS1-style rendering controlled by `ps1Config vec4` in the scene uniform:

| Component | Field | Effect |
|-----------|-------|--------|
| `.x` | `vertexJitter` | Snaps clip-space X/Y to a grid before rasterization — produces the PS1 "wobbly vertex" effect |
| `.y` | `snapGridSize` | Grid resolution for vertex snapping (e.g., 160 = 160 virtual pixels wide) |
| `.z` | `affineStrength` | Controls perspective-correct vs. affine texture warping (0 = correct, 1 = full affine) |
| `.w` | `colorDepth` | Quantizes per-vertex Gouraud shading to N levels per channel (32 ≈ PS1 5-bit) |

The snap is applied in clip space after the perspective divide, then un-done by multiplying back by `w`. This produces the characteristic "pixel swimming" of PS1 geometry.

### Dual Lighting Paths

Lighting mode is selected per-mesh at runtime by the `hasNormalMap` material flag:

| Flag | Lighting | When to use |
|------|----------|-------------|
| `hasNormalMap = false` | **Gouraud** (per-vertex, interpolated) | PS1-authentic, all primitive meshes by default |
| `hasNormalMap = true` | **Per-pixel Phong** with TBN normal lookup | Optional upgrade when normal map texture is bound |

Both paths share the same WGSL shader source. The vertex shader always computes Gouraud color and TBN vectors; the fragment shader branches on `flags & 2u` to choose which to use. Color quantization (`colorDepth`) is applied in both paths.

---

## Normal Map System

**Files:** `src/scene-graph/shapes/mesh-3d.ts`, `src/services/managers/scene3d-manager.ts`

Normal maps are optional per-mesh textures that encode tangent-space surface normals. When bound, they switch the mesh from Gouraud to per-pixel Phong lighting for added surface detail.

### Mesh3D Fields

```typescript
mesh.normalMapTexture:   GPUTexture | null   // bound GPU texture
mesh.normalMapLibraryId: string | null        // TextureLibrary entry ID (for serialization)
```

### Setting a Normal Map via Scene3DManager

```typescript
// Upload from ImageData + auto-bind
sm.scene3d.uploadAndApplyNormalMap(meshId, imageData, device)

// Bind an already-uploaded TextureLibrary texture
sm.scene3d.setMeshNormalMap(meshId, texture)

// Remove the normal map (reverts to Gouraud shading)
sm.scene3d.clearMeshNormalMap(meshId)
```

When a normal map is set on a mesh that has no diffuse texture, a white 1×1 diffuse is automatically created so the textured pipeline is used (the normal map bind group only exists in the textured pipeline path).

### TBN Matrix

The vertex shader computes the TBN (tangent, bitangent, normal) frame per vertex:
```wgsl
T = normalize(worldTangent - dot(worldTangent, worldNormal) * worldNormal)  // Gram-Schmidt
B = cross(worldNormal, T) * tangent.w                                        // handedness sign
```

The fragment shader reconstructs the world-space normal from the normal map sample:
```wgsl
let mapN   = textureSample(normalMapTexture, normalMapSampler, uv).xyz * 2.0 - 1.0;
let worldN = normalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
```

---

## Render Style System

**Files:** `src/renderer/3d/material-3d.ts`, `src/renderer/3d/shaders/style-shaders.ts`, `src/renderer/3d/shaders/mesh3d-shaders.ts`

Every mesh has a `renderStyle` field on its `Material3D` that changes the fragment shader's lighting computation. No new pipelines or bind groups are required — the style index is packed into bits 2–3 of the existing `encodeMaterialFlags` uniform value.

### RenderStyle type

```typescript
type RenderStyle = 'default' | 'cel' | 'sketch' | 'ink';
```

### Material flags encoding

```
bit 0: hasTexture
bit 1: hasNormalMap
bits 2-3: renderStyle (0=default, 1=cel, 2=sketch, 3=ink)
```

### Style descriptions

| Style | Lighting model | Key visual |
|-------|---------------|------------|
| `default` | Gouraud (vertex) or per-pixel Phong (normal map) | Standard PS1-compatible |
| `cel` | Stepped diffuse (3 bands) + hard specular cutoff | Toon/anime look |
| `sketch` | Procedural crosshatch based on light intensity | Pencil-drawn look |
| `ink` | Two-tone + view-space rim darkening | Manga/comic ink look |

### WGSL function source

Shared functions live in `style-shaders.ts` as the `STYLE_WGSL_FUNCTIONS` constant and are injected via template literal into both the textured and untextured fragment shaders:

```typescript
import { STYLE_WGSL_FUNCTIONS } from './style-shaders';
export const MESH3D_FRAGMENT_SHADER = `${STYLE_WGSL_FUNCTIONS}\n...`;
```

### Usage

```typescript
mesh.material.renderStyle = 'cel';
mesh.gpuDirty = true;
// or via manager:
sm.scene3d.setRenderStyle(meshId, 'sketch');
```

### Compositing with PS1 config

Render styles are independent of PS1 aesthetic config. They can be combined freely — e.g., `cel` + vertex jitter produces a wobbly cartoon look.

### Screen-space silhouette outline

A silhouette boundary outline pass is available via `shapeManager.enableOutlines3D()`. See the [Screen-Space Silhouette Outline Pass](#screen-space-silhouette-outline-pass) section for details.

---

## Mesh Import System

**Files:** `src/renderer/3d/obj-importer.ts`, `src/renderer/3d/gltf-importer.ts`

### OBJ Importer (`parseOBJ`)

Parses Wavefront `.obj` text into `MeshGeometry`. Handles:
- `v / vn / vt / f` commands
- Quads and N-gons (fan triangulation)
- Missing normals (recomputed as smooth vertex normals)
- Negative (relative) indices
- UV V-flip (OBJ V=0 bottom-left → WebGPU V=0 top-left)

```typescript
import { parseOBJ } from './obj-importer';
const geom = parseOBJ(objText);  // returns MeshGeometry format:'12float'
```

### GLTF/GLB Importer (`parseGLB`, `parseGLTF`)

Parses binary GLB or JSON GLTF 2.0 into `GltfMeshResult[]` — one entry per mesh node in the scene hierarchy.

```typescript
interface GltfMeshResult {
  name: string;
  geometry: MeshGeometry;             // format:'12float', ready for createCustomMesh
  position: [number, number, number]; // from node TRS
  rotation: [number, number, number]; // Euler XYZ, radians
  scale:    [number, number, number];
  diffuseImage:   ImageBitmap | null; // baseColorTexture decoded to ImageBitmap
  normalMapImage: ImageBitmap | null; // normalTexture decoded to ImageBitmap
  diffuseColor:   [number, number, number, number]; // baseColorFactor
  isTransparent:  boolean;
}
```

**Supported:** static meshes, embedded images (bufferView + base64 data URI), `POSITION` / `NORMAL` / `TEXCOORD_0` / `TANGENT` attributes, uint16/uint32 indices, node TRS hierarchy, multi-mesh scenes, `baseColorFactor`, `baseColorTexture`, `normalTexture`, `alphaMode: BLEND`.

**Not supported:** external URI buffers/images, skeletal animation, morph targets, GLTF extensions.

**UV convention:** GLTF V is **not** flipped (GLTF uses V=0 top-left like WebGPU). OBJ flips V; GLTF does not.

### Scene3DManager methods

```typescript
// OBJ
sm.scene3d.importObjMesh(x, y, z, objText, material?)          → Mesh3D
sm.scene3d.importObjFile(x, y, z, file, material?)              → Promise<Mesh3D>

// GLTF/GLB
sm.scene3d.importGltfBuffer(x, y, z, buffer, material?, groupName?) → Promise<Mesh3D[]>
sm.scene3d.importGltfFile(x, y, z, file, material?)                 → Promise<Mesh3D[]>

// Model store (raw GLB bytes, for project serialization)
sm.scene3d.getModelStore()                                       → Map<meshId, ArrayBuffer>
sm.scene3d.storeModelBuffer(meshId, buffer)                      → void
```

**Auto-grouping (multi-mesh GLB):** when the parsed GLB contains more than one mesh, `importGltfFile` derives a `groupName` from the filename (extension stripped) and passes it to `importGltfBuffer`. Inside `_createMeshesFromGltf`:
- A `MeshGroup3D` is created with that name.
- Each `GltfMeshResult` is turned into a `Mesh3D` node added as a child of the group.
- The group is added to the scene root.
- `autoScaleToFit` is called once for all child IDs.
- One undo entry covers the entire import.
- `setSelectedNode(group.id)` is called so the outliner highlights the group.

Single-mesh GLB files follow the original `createMesh` path — no group is created.

**Zero-scale guard:** GLB exporters sometimes emit `scale:[0,0,0]` for hidden mesh parts. Salsa clamps each scale axis to `Math.max(scale[i], 1e-6)` before applying it. This prevents the 2D interaction system from calling `getInverseLocalMatrix` on a non-invertible matrix (which would spam the console and drop mouse-move responsiveness).

### restoreMeshState: geometry-first restore

`restoreMeshState` now prioritizes serialized geometry over re-running `importGltfBuffer`:

1. If `state.config.geometry.vertices` is non-empty (written by `Mesh3D.toJSON()`), the mesh is recreated from those vertices using `createCustomMesh`. No GLB parsing happens here, so no duplicate groups are created.
2. After creating the mesh, the GLB is parsed once to extract textures. The result matching `state.name` is found (falling back to `results[0]`) and `_applyGltfTextures` is called to upload diffuse/normal textures. This step is wrapped in `try/catch` — a corrupt or missing GLB does not prevent mesh restore.

Without step 2, textures would be missing after reload because vertex/index geometry is serialized but texture `ImageBitmap` data is not.

---

## Project Package Format

**File:** `src/services/persistence/project-package.ts`  
**Dependency:** `fflate` (ZIP library, ~35 KB gzipped)

Portable `.frogmarks` ZIP archives bundle all project data for local download — raster layers, vector scene, 3D nodes with imported GLB files, textures, and animation. See `docs/specs/project-package.md` for full integration details.

```typescript
import { packProject, unpackProject } from './project-package';

const blob = await packProject({ docPayload, nodes3d, models3d, textureLibrary });
// → Blob for browser download

const data = await unpackProject(file);
// → { docPayload, nodes3d, models3d, textureLibrary }
```

### ZIP structure

```
project.frogmarks
├── manifest.json      ← DocumentManifest + 3D metadata
├── scene.json         ← vector scene graph
├── brushes.json       ← brush presets
├── scene3d.json       ← 3D mesh node states (position, material, keyframes)
├── textures3d.json    ← TextureLibrary snapshot
├── layers/{id}.bin    ← raster layer pixel data
├── cels/{id}.bin      ← animation cel pixel data
└── models3d/{id}.glb  ← raw GLB per GLTF-imported mesh
```

---

## Screen-Space Silhouette Outline Pass

**Files:** `src/renderer/3d/outline-pass.ts`, `src/renderer/3d/shaders/outline-shaders.ts`

A two-stage post-process pass that draws clean outer silhouette outlines around all 3D meshes. Implemented as a screen-space effect — no geometry changes required.

### Pipeline stages

```
1. Depth pre-pass  (separate encoder, submitted first)
   ← Renders all meshes depth-only into a canvas-sized depth32float texture
   ← Uses camera view-projection (NOT the light space matrix used by shadows)
   ← cullMode: 'none' — back-facing planes, ribbon faces, and cylinder caps
      all write depth correctly when viewed from behind

2. Silhouette composite pass  (inside main render pass)
   ← Fullscreen triangle; for each pixel:
        if depth < FAR (0.9999) AND any neighbor within `width` pixels has
        depth ≥ FAR  →  draw outline color
   ← Produces a clean outer silhouette with no interior seams
   ← Blended with ONE / ONE_MINUS_SRC_ALPHA (pre-multiplied alpha)
   ← Drawn on top of all 3D mesh geometry, under the gizmo
```

### API

```typescript
// Enable with optional overrides
shapeManager.enableOutlines3D();
shapeManager.enableOutlines3D([0, 0, 0, 1], 2);        // black, 2-pixel width (default)

// Configure
shapeManager.setOutlineColor3D(0, 0, 0, 1);            // RGBA 0–1
shapeManager.setOutlineThreshold3D(3);                 // pixel width — larger = thicker silhouette

// Disable
shapeManager.disableOutlines3D();

// Query
const active = shapeManager.outlinesEnabled3D;         // boolean

// Via Renderer3D directly
renderer3D.enableOutlines([r, g, b, a], width);
renderer3D.setOutlineColor(r, g, b, a);
renderer3D.setOutlineThreshold(n);   // n = pixel width (default 2)
renderer3D.disableOutlines();
renderer3D.outlineEnabled;  // boolean
```

`OutlinePass.threshold` is now the **outline pixel width** (default 2). `setOutlineThreshold(n)` sets outline thickness in pixels; larger values produce thicker silhouettes.

### Combining with render styles

```typescript
// Ink manga look: flat ink style + outline
shapeManager.setRenderStyle3D(meshId, 'ink');
shapeManager.enableOutlines3D([0, 0, 0, 0.8], 2);

// Sketch style + no outline (crosshatch is its own line language)
shapeManager.setRenderStyle3D(meshId, 'sketch');
shapeManager.disableOutlines3D();

// PS1 jitter + outline (wobbly toon)
shapeManager.setPS1Config3D({ vertexJitter: 0.6, snapGridSize: 160 });
shapeManager.enableOutlines3D([0.05, 0.02, 0.08, 1]); // near-black purple outline
```

### Texture lifecycle

Offscreen textures (`depth32float` + `rgba8unorm`) are created at canvas size on first use and automatically recreated on canvas resize. Both textures are destroyed with `renderer3D.disableOutlines()` or `renderer3D.destroy()`.

---

## OPFS Auto-Save (3D extension)

The OPFS auto-save now includes 3D scene state alongside raster/vector data.

**Additional files written per document:**
```
{docId}/
  scene3d.json        ← JSON array of Mesh3D.toJSON() + glbMeshId field
  models3d/
    {meshId}.glb      ← raw GLB bytes for each GLTF-imported mesh
```

**`DocumentSavePayload` additions:**
```typescript
interface DocumentSavePayload {
  // ...existing fields...
  scene3dJSON?: string | null;            // Mesh3D node states
  models3d?: Record<string, ArrayBuffer>; // GLB buffer per mesh
}
```

**Public snapshot method:**
```typescript
const payload = await shapeManager.snapshotDocument();
// Same data the auto-save uses — useful for .frogmarks export
```

**Auto-scale on GLTF import:**
After every `importGltfFile3D` / `importGltfBuffer3D` call, Scene3DManager automatically calls `autoScaleToFit()` on the imported meshes. GLTF uses metres while Salsa uses pixels; a 1.8m character would be 1.8px tall without this. The scale is only applied when the bounding-box span is < 5% of targetSize (400 world units by default).

```typescript
// Manual call if needed
shapeManager.autoScaleToFit3D(meshIds, 400);
```

**Group transform APIs (`setPosition`, `setScale`, `setRotation`):**
All three methods accept either a `Mesh3D` ID or a `MeshGroup3D` ID. When a group ID is passed, the transform is propagated to all child meshes:

| Method | Group behavior |
|--------|---------------|
| `setPosition(groupId, x, y, z)` | Computes delta from `group.groupPos3D`, adds it to each child's world position |
| `setRotation(groupId, rx, ry, rz)` | Computes delta from `group.groupRot3D`, adds it to each child's individual rotation |
| `setScale(groupId, sx, sy, sz)` | Factor = `new / old` (from `group.groupScale3D`); applied to child scale AND each child's position relative to the group centroid, keeping the group from shearing apart |

The `groupPos3D`, `groupScale3D`, and `groupRot3D` fields on `MeshGroup3D` accumulate the "current effective group transform" so that successive calls correctly compute deltas. These fields are not serialized — only the children's individual transforms are persisted.

---

## Particle System

**Files:**
- `src/scene-graph/shapes/particle-emitter-3d.ts` — CPU simulation node
- `src/renderer/3d/shaders/particle-shaders.ts` — WGSL billboard shaders
- `src/renderer/3d/renderer-3d.ts` — `drawParticles()` GPU dispatch
- `src/services/managers/scene3d-manager.ts` — tick management + API
- `src/services/shape-manager.ts` — public API surface

### Architecture

```
Scene3DManager._particleTickCb (pre-render callback)
    └─ ParticleEmitter3D.tick(dt)            ← CPU Euler integration only (physics)
            └─ emitter.gpuDirty = true        ← signals GPU data needs rebuilding

WebGPURenderer.draw3DParticles(pass, nodes)
    └─ Renderer3D.drawParticles(pass, emitters, w, h)
            ├─ For each visible emitter:
            │   ├─ Resolve animTextures IDs → atlas layer indices (via _atlasLayerMap)
            │   └─ emitter.buildGPUData(animLayers)  ← writes compact 48-byte structs
            ├─ writeBuffer → one shared STORAGE buffer (all emitters packed)
            ├─ writeBuffer → ParticleSceneUniforms (viewProj + cameraRight + cameraUp)
            ├─ [if bloom enabled] BloomPass.captureAndBlur() ← separate encoder, submitted first
            ├─ pass.draw(6, count, 0, firstInstance)  ← per emitter, no vertex buffer
            └─ [if bloom enabled] BloomPass.drawComposite(pass) ← additive fullscreen quad
```

Particles are drawn in the **same render pass as mesh geometry**, after all opaque and transparent mesh draws. Depth test is ON (`depthCompare: 'less'`) and depth write is OFF — particles occlude correctly behind solid geometry but never occlude each other.

### ParticleEmitter3D

**File:** `src/scene-graph/shapes/particle-emitter-3d.ts`

Extends `Shape`, participates in the scene graph like `Mesh3D`. Owns a CPU particle pool; `tick(dt)` does **physics only** — GPU data is built by `Renderer3D.drawParticles()` on each frame to allow animated texture resolution.

#### CPU particle state (internal pool)

18 floats per particle — never uploaded to GPU directly:

| Slot | Field |
|------|-------|
| 0–2 | `px, py, pz` — world position |
| 3–5 | `vx, vy, vz` — velocity |
| 6 | `age` (seconds) |
| 7 | `lifetime` (seconds) |
| 8 | `startSize` |
| 9 | `endSize` |
| 10–13 | `startColor: r, g, b, a` |
| 14–17 | `endColor: r, g, b, a` |

Dead particles are compacted in-place on each `tick()` call — live particles are shifted forward as dead ones are encountered.

#### Key methods

| Method | Description |
|--------|-------------|
| `tick(dt)` | Physics: gravity, turbulence, Euler integration, spawn. Sets `gpuDirty = true`. Does **not** write GPU data. |
| `buildGPUData(animLayers?)` | Writes compact 48-byte structs to `gpuData`. Pass `animLayers` (resolved atlas indices) for flipbook animation. Called by `Renderer3D.drawParticles()` every frame. |
| `setConfig(partial)` | Merges a partial `ParticleEmitterConfig` and resets the particle pool. |
| `toJSON()` | Serializes type, id, position, rotation, scale, name, and full config. Wired into scene-graph serialization — no special handling needed. |

#### Compact GPU upload buffer

12 floats per particle (48 bytes = 3 × `vec4`) — what `Renderer3D` actually reads:

| Offset | Field | WGSL |
|--------|-------|------|
| 0 | `px, py, pz, size` (lerped from startSize→endSize) | `posSize: vec4<f32>` |
| 16 | `r, g, b, a` (lerped from startColor→endColor) | `color: vec4<f32>` |
| 32 | `textureIndex, 0, 0, 0` | `texInfo: vec4<u32>` |

#### ParticleEmitterConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxParticles` | `number` | 200 | Hard cap on live particle count |
| `emitRate` | `number` | 30 | New particles per second |
| `lifetime` | `[min, max]` | `[1, 2]` | Seconds before a particle dies |
| `startSize` | `[min, max]` | `[0.05, 0.15]` | Size at birth (world units) |
| `endSize` | `[min, max]` | `[0, 0]` | Size at death |
| `startColor` | `RGBA` | white opaque | Color at birth |
| `endColor` | `RGBA` | white transparent | Color at death |
| `speed` | `[min, max]` | `[0.3, 0.8]` | Initial speed along emit direction |
| `spread` | `number` | 0.4 | Cone half-angle in radians (0 = straight, π = sphere) |
| `gravity` | `[x, y, z]` | `[0, -0.3, 0]` | Per-second acceleration |
| `turbulence` | `number` | 0 | Random velocity kick per second |
| `direction` | `[x, y, z]` | `[0, 1, 0]` | Emit direction in local space |
| `loop` | `boolean` | `true` | If false, emits one burst then stops |
| `textureIndex` | `number` | 0 | Atlas layer index (0 = white default). Ignored when `animTextures` is set. |
| `animTextures` | `string[]` | `[]` | TextureLibrary entry IDs for flipbook animation. When non-empty, overrides `textureIndex`. |
| `animFrameTime` | `number` | 0.1 | Seconds each flipbook frame is shown. Frame index = `Math.floor(age / animFrameTime) % n`. |

#### Built-in presets

| Preset | Effect |
|--------|--------|
| `'dust'` | Slow drifting motes, full-sphere spread, gentle gravity |
| `'sparks'` | Fast orange→red streaks, narrow cone, strong gravity |
| `'snow'` | Large slow flakes, full-sphere, low gravity, pure white |
| `'magic'` | Purple→violet orbs, full-sphere, slight upward drift |

### Billboard WGSL Shaders

**File:** `src/renderer/3d/shaders/particle-shaders.ts`

No vertex buffer. The vertex shader generates a camera-facing quad procedurally from `@builtin(vertex_index)` (0–5, two triangles) and `@builtin(instance_index)` (particle slot).

Camera-facing is achieved by extracting world-space right and up vectors from the view matrix rows (column-major gl-matrix layout):

```
cameraRight = (view[0], view[4], view[8])   ← row 0 of view
cameraUp    = (view[1], view[5], view[9])   ← row 1 of view
```

These are written into `ParticleSceneUniforms` (a **separate 96-byte uniform buffer**, distinct from `SceneUniforms`):

| Offset | Field | Size |
|--------|-------|------|
| 0 | `viewProjection: mat4x4<f32>` | 64 B |
| 64 | `cameraRight: vec4<f32>` (.xyz = world right) | 16 B |
| 80 | `cameraUp: vec4<f32>` (.xyz = world up) | 16 B |

### Particle Pipeline

Lazily created on first `drawParticles()` call. Uses its own BGLs — not shared with mesh pipelines:

| Group | Bindings |
|-------|----------|
| `_particleBGL0` (group 0) | binding 0: particles `storage read`, binding 1: `ParticleSceneUniforms` `uniform` |
| `_particleBGL1` (group 1) | binding 0: `texture_2d_array<f32>` (atlas), binding 1: `sampler` |

Pipeline state: `topology: 'triangle-list'`, `cullMode: 'none'`, `depthWriteEnabled: false`, `depthCompare: 'less'`, alpha blend.

### Animated Textures (Flipbook)

Set `animTextures` to an array of TextureLibrary IDs and `animFrameTime` to the seconds-per-frame. The frame is selected per particle from its age:

```typescript
const frame = Math.floor(particle.age / animFrameTime) % animTextures.length;
textureIndex = atlasLayerForId(animTextures[frame]);
```

Frame resolution happens in `Renderer3D.drawParticles()` via `getAtlasLayerIndex(id)` — always current because it runs after `drawMeshes()` which rebuilds the atlas. If a TextureLibrary ID is not yet in the atlas (e.g., texture was just uploaded), layer 0 (white default) is used for that frame until the atlas rebuilds on the next frame.

```typescript
shapeManager.setParticleEmitterConfig3D(id, {
  animTextures:  ['libId1', 'libId2', 'libId3'],
  animFrameTime: 0.083,  // ~12 fps flipbook
});
```

### Serialization

`ParticleEmitter3D.toJSON()` is wired into the standard scene graph serialization. On save, particle emitters appear in the scene JSON like any other node. On load:

1. `recreateNode()` handles `case 'ParticleEmitter3D'` — creates the node from `data.x/y/z` and `data.config`.
2. After `updateSceneGraph()` completes, `setSceneGraphJSON()` scans `root.children` for `ParticleEmitter3D` instances and calls `scene3d.registerRestoredParticleEmitter(node)` on each one — this repopulates the `_particleEmitters` map and restarts the tick callback.

No special handling is required in Frogmarks load flows — particles save and restore automatically with the scene.

### Scene3DManager API

```typescript
// Add emitter — returns its ID
sm.scene3d.addParticleEmitter(x, y, z, config?, preset?)  → string

// Remove
sm.scene3d.removeParticleEmitter(id)

// Live config update (takes effect next tick)
sm.scene3d.setParticleEmitterConfig(id, config)

// Access node directly
sm.scene3d.getParticleEmitter(id)      → ParticleEmitter3D | null
sm.scene3d.getAllParticleEmitters()    → ParticleEmitter3D[]

// Register a particle emitter restored from saved JSON
sm.scene3d.registerRestoredParticleEmitter(emitter)

// Bloom
sm.scene3d.enableBloom(threshold?, intensity?)
sm.scene3d.disableBloom()
sm.scene3d.setBloomThreshold(t)   // 0–1; higher = only very bright particles bloom
sm.scene3d.setBloomIntensity(v)   // multiplier on the bloom contribution
sm.scene3d.bloomEnabled            // boolean
```

The pre-render tick callback uses `performance.now()` delta time, clamped to 100 ms to survive tab-visibility transitions without exploding particle positions. The callback self-deregisters when the last emitter is removed.

### ShapeManager API

```typescript
// Create
const id = shapeManager.addParticleEmitter3D(0, 0, 0, {}, 'sparks');

// Destroy
shapeManager.removeParticleEmitter3D(id);

// Update config (animated textures — IDs from TextureLibrary)
shapeManager.setParticleEmitterConfig3D(id, {
  animTextures:  ['libId1', 'libId2', 'libId3'],
  animFrameTime: 0.1,
});

// Access node
const emitter = shapeManager.getParticleEmitter3D(id);
emitter?.setPosition3D(x, y, z);  // move emitter in world space
emitter?.visible = false;          // hide without destroying

// Bloom
shapeManager.enableBloom3D(threshold?, intensity?);
shapeManager.disableBloom3D();
shapeManager.setBloomThreshold3D(0.6);  // 0–1; default 0.5
shapeManager.setBloomIntensity3D(1.5);  // default 1.2
```

---

## Bloom Post-Processing Pass

**Files:**
- `src/renderer/3d/bloom-pass.ts` — `BloomPass` class
- `src/renderer/3d/shaders/bloom-shaders.ts` — WGSL shaders

A screen-space bloom pass that adds a glowing halo around bright particles. Disabled by default; call `enableBloom3D()` to activate. Has zero cost when disabled.

### Pipeline stages

```
[Before main pass — separate GPUCommandEncoder]:
  1. Capture pass — re-render all visible particles into rgba16float source texture
       additive blend (accumulates multiple emitter contributions)
       no depth test or depth write
  2. H-blur — fullscreen 9-tap Gaussian, direction uniform = (1/w, 0)
       source → ping  (both rgba16float)
  3. V-blur — fullscreen 9-tap Gaussian, direction uniform = (0, 1/h)
       ping → source
  Submit encoder before main encoder

[Inside main pass — after normal particle draw]:
  4. Composite — fullscreen triangle, reads blurred source texture
       soft-knee threshold: excess = max(0, lum - threshold)
       contribution = bloom.rgb * (excess / lum) * intensity
       rendered with additive blend (src=one, dst=one) → halos add on top of scene
```

### Offscreen textures

Two `rgba16float` textures, canvas-sized:
- `sourceTexture` — capture destination and final blur output
- `pingTexture` — intermediate ping-pong for the separable blur

Both are automatically destroyed and recreated on canvas resize.

### Gaussian weights

9-tap kernel (σ ≈ 2) applied to both passes:

| Tap | Weight |
|-----|--------|
| centre | 0.227027 |
| ±1 | 0.194595 |
| ±2 | 0.121621 |
| ±3 | 0.054054 |
| ±4 | 0.016216 |

### Config

| Property | Default | Description |
|----------|---------|-------------|
| `threshold` | `0.5` | Luminance cutoff (0–1). Pixels below this luminance produce no bloom. |
| `intensity` | `1.2` | Multiplier applied to the bloom contribution after threshold. |

### Capture pipeline

The capture pipeline is a copy of the main particle render pipeline with three changes:
- Render target format: `rgba16float` (not the swap chain format)
- No depth stencil attachment
- Blend: `src-alpha + one` (additive — multiple emitters accumulate into one texture)

It reuses `_particleBGL0` and `_particleBGL1` from the main particle pipeline, so the same texture atlas is sampled during capture.

### Why capture separately instead of reading the framebuffer

WebGPU cannot read from the swap chain texture (`GPUCanvasContext.getCurrentTexture()`) during a render pass. The "draw twice" approach — once to the swap chain normally, once to the `rgba16float` capture — is the standard WebGPU pattern for post-processing effects that need a copy of rendered content.

### API

```typescript
// Via ShapeManager (Frogmarks-facing):
shapeManager.enableBloom3D();                     // enable with defaults
shapeManager.enableBloom3D(0.6, 1.5);            // threshold=0.6, intensity=1.5
shapeManager.disableBloom3D();
shapeManager.setBloomThreshold3D(0.4);           // lower = more particles bloom
shapeManager.setBloomIntensity3D(2.0);           // higher = brighter halos

// Via Renderer3D directly:
renderer3D.enableBloom(threshold?, intensity?);
renderer3D.disableBloom();
renderer3D.setBloomThreshold(t);
renderer3D.setBloomIntensity(v);
renderer3D.bloomEnabled;  // boolean
```

---

## Cloth Simulation System

Salsa includes a GPU-accelerated cloth simulation system built on WebGPU compute shaders. It powers the `ClothMesh3D` scene node and supports both interactive preview (live rAF loop) and static bake workflows.

### Architecture

```
ClothGridConfig / ClothPhysicsConfig / ClothLiveConfig
          │
          ▼
buildClothGeometry()          ← CPU: vertices, constraints, UV, normals
          │
          ▼
ClothSimulator                ← GPU: three-pass compute pipeline per step
          │
          ▼
LiveClothSimulationImpl       ← rAF loop: N steps/frame + async GPU readback
          │
          ▼
Scene3DManager                ← feeds positions → ClothMesh3D renderable
```

**Files:**
- `src/renderer/3d/cloth-geometry-builder.ts` — mesh generation + constraint graph
- `src/renderer/3d/cloth-simulator.ts` — WebGPU simulator, buffer management
- `src/renderer/3d/live-cloth-simulation.ts` — rAF driver, wind zone evaluation
- `src/renderer/3d/shaders/cloth-shaders.ts` — WGSL compute shaders
- `src/scene-graph/shapes/cloth-mesh-3d.ts` — scene node + config types

---

### Geometry Builder

**`buildClothGeometry(config: ClothGridConfig): ClothGeometryResult`**

Generates a rectangular grid cloth mesh, optionally with rounded corners and masked cells (non-rectangular cloth shapes).

**`ClothGridConfig`** fields:
| Field | Type | Purpose |
|-------|------|---------|
| `cols` | `number` | Grid columns |
| `rows` | `number` | Grid rows |
| `cellSize` | `number` | World-unit size of each cell |
| `cornerRadius` | `number` | Rounded corner cutout radius |
| `activeCells` | `boolean[]` | Flat array `[col + row*cols]`; false = hole |
| `pinnedVertices` | `number[]` | Vertex indices with infinite mass (immovable) |
| `stitches` | `StitchConstraint[]` | Additional vertex-to-vertex distance constraints |
| `bendStiffnessMap` | `number[]` | Per-vertex bend stiffness in [0, 1]; 1 = rigid |

**`ClothGeometryResult`** fields:
| Field | Type | Purpose |
|-------|------|---------|
| `vertexCount` | `number` | Total active vertices |
| `flatPositions` | `Float32Array` | Rest-pose XYZ per vertex |
| `inverseMass` | `Float32Array` | 0 = pinned, 1/mass otherwise |
| `constraintGraph` | `ConstraintGraph` | All edges with metadata |
| `vertexFromSlot` | `Int32Array` | Grid-slot → vertex index (-1 = inactive) |
| `bendStiffness` | `Float32Array` | Per-vertex bend stiffness clamped to [0, 1] |

**`ConstraintGraph`** structure:
```typescript
interface ConstraintGraph {
  edges:       ConstraintEdge[];   // all constraints: structural + shear + bend + stitch
  bendStart:   number;             // index where bend edges begin
  stitchStart: number;             // index where stitch edges begin
}

interface ConstraintEdge {
  a, b:       number;                                  // vertex indices
  restLength: number;                                  // target distance
  type:       'structural' | 'shear' | 'bend' | 'stitch';
  color:      number;                                  // graph coloring for parallel solve
}
```

Four constraint types:
- **Structural** — immediate neighbor edges (no stretch)
- **Shear** — diagonal edges (no shear)
- **Bend** — skip-1 edges (resist folding); stiffness scaled by `bendStiffnessMap`
- **Stitch** — user-added explicit vertex pairs; solved at full strength like structural

---

### GPU Simulator

**File:** `src/renderer/3d/cloth-simulator.ts`

Three compute passes per simulation step:

#### Pass 1 — Verlet Integration

**Shader bindings:**
| Binding | Type | Content |
|---------|------|---------|
| 0 | `storage read_write` | `positions: array<vec4<f32>>` |
| 1 | `storage read_write` | `prevPositions: array<vec4<f32>>` |
| 2 | `storage read` | `inverseMass: array<f32>` |
| 3 | `uniform` | `IntegrateParams` |
| 4 | `storage read` | `perVertexWind: array<vec4<f32>>` |

**`IntegrateParams`:**
```wgsl
struct IntegrateParams {
  dt, gravity, damping, windX, windY, windZ : f32,
  vertCount : u32,
  _pad      : f32,
}
```

Each vertex (except pinned): `vel = (pos - prev) * damping`, `accel = globalWind + perVertexWind - gravity`, `pos' = pos + vel + accel * dt²`.

**Binding 4 (`perVertexWind`)** is written each rAF frame from CPU-side wind zone evaluation — allows per-vertex spatial wind without shader recompiles.

#### Pass 2 — Constraint Solve

**Shader bindings:**
| Binding | Type | Content |
|---------|------|---------|
| 0 | `storage read_write` | `positions: array<vec4<f32>>` |
| 1 | `storage read` | `inverseMass: array<f32>` |
| 2 | `storage read` | `constraints: array<Constraint>` |
| 3 | `uniform` | `ConstrainParams` |
| 4 | `storage read` | `bendStiffness: array<f32>` |

**`ConstrainParams`:**
```wgsl
struct ConstrainParams {
  constraintCount : u32,
  stiffness       : u32,   // number of solve iterations
  bendStart       : u32,   // first bend constraint index
  stitchStart     : u32,   // first stitch constraint index
}
```

Dispatched as `(1, 1, 1)` — sequential inner loop. Bend constraints (`ci >= bendStart && ci < stitchStart`) have their correction scaled by the average bend stiffness of the two vertices from **binding 4**. Structural, shear, and stitch constraints always solve at full strength.

#### Pass 3 — Collision

Handles analytic collision against one proxy:
- `type 0` — none
- `type 1` — ground plane (y ≥ groundY)
- `type 2` — sphere (push outside radius)
- `type 3` — box (push out nearest face)

When a vertex is pushed by collision, `prevPositions` is reset to `positions` to kill inward velocity.

#### ClothSimulator API

```typescript
class ClothSimulator {
  init(result: ClothGeometryResult, physics: ClothPhysicsConfig,
       initPositions?: Float32Array): void
  step(): void                              // one full integrate→constrain→collide pass
  pinVertices(indices: number[]): void
  setCollision(proxy: DrapeProxy): void
  setPhysicsParams(params: Partial<ClothPhysicsConfig>): void
  setBendStiffness(map: Float32Array): void // hot-update per-vertex bend stiffness GPU buffer
  setPerVertexWind(forces: Float32Array): void  // hot-update per-vertex wind GPU buffer (vec4 per vertex)
  readPositions(): Promise<Float32Array>    // async GPU readback
  destroy(): void
}
```

---

### Live Simulation Handle

**File:** `src/renderer/3d/live-cloth-simulation.ts`

`LiveClothSimulationImpl` drives a `ClothSimulator` via `requestAnimationFrame`.

**Auto-tuning steps per frame:**
- **CONVERGING** — 4 steps/frame until max vertex displacement < 0.001 world units
- **CONVERGED** — 2 steps/frame (keeps wind/gravity alive without burning GPU budget)

Any physics or wind zone change resets `_converged = false` so simulation immediately re-activates.

**`LiveClothHandle` interface:**
```typescript
interface LiveClothHandle {
  reset(grid, physics, mode: 'hang' | 'drape', proxy?): void
  setPhysics(params: Partial<ClothPhysicsConfig>): void
  setBendStiffness(map: Float32Array): void
  setWindZones(zones: WindZone[]): void
  onPositionsUpdate: ((positions: Float32Array) => void) | null
  vertexCount: number     // readonly
  running: boolean        // readonly
  pause(): void
  resume(): void
  snapshot(): Promise<Float32Array>
  destroy(): void
}
```

**Factory:**
```typescript
createLiveClothSimulation(
  device:  GPUDevice | null | undefined,
  grid:    ClothGridConfig,
  physics: ClothPhysicsConfig,
  mode:    'hang' | 'drape',
  proxy?:  DrapeProxy,
): LiveClothHandle | null
```

Returns `null` if `device` is unavailable (safe to call before WebGPU init).

---

### Stitching System

Stitches are user-defined vertex-to-vertex distance constraints. They model pleats, gathered fabric, bound panels, and garment seams.

**Data type:**
```typescript
interface StitchConstraint {
  a:          number;   // vertex index
  b:          number;   // vertex index
  restLength: number;   // target distance in world units; 0 = full stitch
}
```

Stitches are stored in `ClothGridConfig.stitches[]` and serialized in `ClothMesh3D.toJSON()`. Adding or removing a stitch calls `buildClothGeometry` to rebuild the constraint graph, then resets the live simulation from the flat pose (the cloth visually "snaps" as if it was just stitched). This is intentional — it gives the builder instant feedback.

**Frogmarks UI requirements:**
- **Stitch tool** — user clicks/taps two vertices on the cloth grid; a connecting line is drawn overlaid on the mesh. Call `addClothStitch(meshId, a, b, restLength)`.
- **Rest-length slider** — a value of `0` means fully gathered (vertices pulled together); `1×cellSize` or larger means a soft pleat. Default: `0`.
- **Stitch list panel** — shows all stitches with a remove (×) button per entry. Call `removeClothStitch(meshId, index)`.
- **Clear all** — single button, calls `clearClothStitches(meshId)`.
- **Live preview** — simulation resets automatically after each add/remove; no extra call needed.

---

### Paintable Bend-Stiffness Map

The bend-stiffness map is a `Float32Array` with one value per vertex in [0, 1]. Lower values produce floppy (silk-like) cloth; higher values resist folding (cardboard-like). It only affects bend constraints — structural and shear constraints always solve at full strength.

**Storage:** `ClothGridConfig.bendStiffnessMap: number[]` (serialized as a plain array for JSON).

**Hot-update path:** `setClothBendStiffness(meshId, map)` rebuilds the geometry result (to get the clamped `bendStiffness` Float32Array) then calls `handle.setBendStiffness(result.bendStiffness)`. This writes directly to the GPU buffer — no simulation reset.

**Frogmarks UI requirements:**
- **Stiffness brush** — same pointer model as raster painting. On each `pointerMove`, compute which vertices fall within the brush radius, update `map[vi]` by adding/subtracting the brush strength, clamp to [0, 1], then call `setClothBendStiffness(meshId, updatedMap)`.
- **Brush modes** — "Stiffen" (add) and "Soften" (subtract). Brush radius and strength are separate parameters.
- **Visual overlay** — render vertex stiffness as a color gradient (e.g., blue = floppy → red = stiff) on top of the cloth mesh while the tool is active.
- **Stiffness presets** — "Silk" (all 0.1), "Cotton" (all 0.5), "Cardboard" (all 1.0) write the whole map at once via `setClothBendStiffness`.
- **Reset** — fills map with `1.0` (full stiffness) and calls `setClothBendStiffness`.

---

### Wind Zones

Wind zones are spatial emitters that apply per-vertex forces to the cloth each rAF frame. They are evaluated CPU-side (trivially fast for typical cloth sizes of 100–800 vertices) and written to the GPU via `setPerVertexWind`.

**Data type:**
```typescript
interface WindZone {
  id:           string;
  shape:        'sphere' | 'box';
  center:       [number, number, number];
  radius?:      number;                        // sphere only
  halfExtents?: [number, number, number];      // box only
  windVec:      [number, number, number];      // force direction + magnitude
  falloff:      'none' | 'linear';
  pulsePeriod?: number;                        // seconds; omit for constant wind
  pulsePhase?:  number;                        // radians phase offset
}
```

**Pulse formula:** `amplitude = 0.5 + 0.5 × sin(2π × t / pulsePeriod + pulsePhase)` — oscillates between 0 and 1. This gives a natural gusting effect without any step function discontinuity.

**Falloff (sphere):** `attenuation = 1 - dist / radius` when `falloff: 'linear'`; 1.0 otherwise.

**Falloff (box):** `attenuation = min(1 - |dx|/hx, 1 - |dy|/hy, 1 - |dz|/hz)` when `falloff: 'linear'`.

Zones are stored in `ClothLiveConfig.windZones[]`. Updating any zone calls `handle.setWindZones(zones)` which sets `_converged = false` so the simulation immediately reacts.

**Frogmarks UI requirements:**
- **Zone panel** — collapsible list of wind zones. Each entry shows: shape toggle (sphere/box), center XYZ inputs, wind vector XYZ inputs, falloff toggle, pulse period + phase (optional).
- **Add zone** — `+` button, calls `addWindZone(meshId, zone)`. Default: sphere at origin, wind = `[1, 0, 0]`, no falloff, no pulse.
- **Remove zone** — (×) per entry, calls `removeWindZone(meshId, zoneId)`.
- **Live sliders** — every slider `onChange` calls `updateWindZone(meshId, zoneId, patch)`. Debouncing is not needed — the CPU evaluation is sub-millisecond.
- **Zone gizmo** (optional, high-value) — draw a wireframe sphere or box in the 3D viewport indicating the zone bounds. Center + radius/halfExtents map directly to the gizmo geometry.
- **Clear all** — calls `clearWindZones(meshId)`.

---

### Cloth Serialization

**`ClothGridConfig` (persisted in `ClothMesh3D.toJSON()`):**
```typescript
{
  cols, rows, cellSize, cornerRadius,
  activeCells:      boolean[],
  pinnedVertices:   number[],
  stitches:         StitchConstraint[],      // new
  bendStiffnessMap: number[],                // new — serialized from Float32Array
}
```

**`ClothLiveConfig` (persisted in `ClothMesh3D.toJSON()`):**
```typescript
{
  mode:       'hang' | 'drape',
  proxy:      DrapeProxy,
  windZones:  WindZone[],                    // new
}
```

On scene restore, `Scene3DManager.restoreMeshState` rebuilds the `ClothSimulator` from the stored config. `enableLiveCloth` re-applies wind zones and bend stiffness to the live handle immediately after the simulation is created.

---

## Skinned Mesh & Armature Rendering

**Files:**
- `src/scene-graph/shapes/skinned-mesh-3d.ts` — `SkinnedMesh3D` node
- `src/scene-graph/shapes/skeleton-3d.ts` — `Skeleton3D` node
- `src/types/armature-3d.ts` — `Joint3D`, `SkeletonData`, `SkeletonAnimClip`
- `src/renderer/3d/shaders/skinning-shaders.ts` — LBS WGSL vertex shaders
- `src/renderer/3d/pipeline-3d.ts` — skinned pipelines (72-byte vertex layout)
- `src/renderer/3d/renderer-3d.ts` — `drawSkinnedMeshes()`

### Vertex Format (72 bytes per vertex)

Skinned meshes use a wider vertex format than regular meshes (48 bytes) to carry joint indices and weights:

| Offset | Size | Type | Content |
|--------|------|------|---------|
| 0 | 12 | float32×3 | position |
| 12 | 12 | float32×3 | normal |
| 24 | 8 | float32×2 | uv |
| 32 | 16 | float32×4 | tangent |
| 48 | 4 | uint8×4 | joint indices (up to 4 per vertex) |
| 52 | 16 | float32×4 | joint weights (must sum to 1.0) |
| 68 | 4 | — | padding |

`SKINNED_MESH3D_VERTEX_STRIDE = 72` is exported from `pipeline-3d.ts`.

### Skinned Pipelines

Two pipelines, differing only in bind group layout:

| Pipeline | Bind Groups | Notes |
|----------|------------|-------|
| `skinnedOpaqueTextured` | mesh(0) · texture(1) · skinMatrices(2) | Bind group 2 = skinning |
| `skinnedOpaqueUntextured` | mesh(0) · skinMatrices(1) | Bind group 1 = skinning |

Both use a `read-only-storage` bind group for the per-mesh `skinMatrices` buffer. The layout shift (group 2 vs group 1) follows the same pattern as shadow shaders — WebGPU forbids gaps between active bind groups.

### LBS Vertex Shader (WGSL)

The skinning vertex shader blends up to 4 joint transform matrices per vertex before applying the mesh's model matrix:

```wgsl
let skinMat =
    in.weights.x * skinMatrices[in.joints.x] +
    in.weights.y * skinMatrices[in.joints.y] +
    in.weights.z * skinMatrices[in.joints.z] +
    in.weights.w * skinMatrices[in.joints.w];
let skinnedPos4  = skinMat * vec4<f32>(in.position, 1.0);
let worldPos4    = inst.modelMatrix * skinnedPos4;
```

`skinMatrices[i]` is a pre-multiplied skin matrix: `worldMatrix[i] × inverseBindMatrix[i]`, updated every frame by `Skeleton3D.computeWorldMatrices()`.

### `drawSkinnedMeshes()` Flow

Skinned meshes **bypass the shared geometry pool** entirely — they have per-mesh vertex and index buffers because their vertex stride (72 bytes) differs from the regular pool stride (48 bytes).

```
drawSkinnedMeshes(pass, skinnedMeshes, width, height):
  For each mesh:
    1. _ensureSkinnedVBIB(mesh)
         - On first call or when skinDirty=true:
           Build interleaved Float32Array (72 bytes/vertex):
             floatBase = v*18  (18 floats × 4 = 72 bytes)
             positions/normals/uvs/tangents at floatBase+0..11
             u8 view: jointIndices at byteBase+48..51
             floatBase+13..16: jointWeights (float32×4)
         - Upload to per-mesh GPUBuffer (VERTEX | COPY_DST)
    2. _ensureSkinMatBuf(mesh)
         - On first call or when skeleton.matricesDirty=true:
           Create/resize STORAGE buffer: joints.length × 64 bytes
           Write skeleton.skinMatrices (Float32Array, joints×16 floats)
           Create skinBG via skinBindGroupLayout
    3. _uploadSkinnedInstances(mesh, i)
         - Write modelMatrix + material to _skinnedInstBuf at slot i
    4. Draw call:
         pass.setBindGroup(0, meshBindGroup)
         pass.setBindGroup(1, textureBG or skinBG)  ← depends on pipeline
         pass.setBindGroup(2, skinBG)               ← textured only
         pass.drawIndexed(mesh.indexCount, 1, 0, 0, i)
```

### Skeleton3D

**File:** `src/scene-graph/shapes/skeleton-3d.ts`

`Skeleton3D` extends `Node` (not `Shape` — it has no visual geometry of its own). It holds a `SkeletonData` struct and a flat `skinMatrices: Float32Array` (joints.length × 16 floats). 

**Key properties:**
- `id: string` — UUID, set at construction, restored from JSON
- `data: SkeletonData` — `{ name, joints: Joint3D[] }` 
- `skinMatrices: Float32Array` — pre-multiplied skin matrices, re-computed by `computeWorldMatrices()`
- `matricesDirty: boolean` — set true by `computeWorldMatrices()`, cleared by renderer after GPU upload

**Each `Joint3D`:**
```typescript
interface Joint3D {
  index: number;
  name: string;
  parentIndex: number;      // -1 for root joint
  children: number[];
  localPosition: [number, number, number];
  localRotation: [number, number, number, number];  // quaternion xyzw
  localScale:    [number, number, number];
  worldMatrix:       Float32Array;  // 16 floats — recomputed each frame
  inverseBindMatrix: Float32Array;  // 16 floats — constant, from GLTF
}
```

`computeWorldMatrices()` traverses joints parent-first, building `worldMatrix[i]` from parent's world matrix × local TRS, then `skinMatrices[i] = worldMatrix[i] × inverseBindMatrix[i]`.

### Bone Overlay Gizmo

**File:** `src/renderer/3d/gizmo-renderer.ts`

When a `SkinnedMesh3D` is selected, `GizmoRenderer.drawBoneOverlay()` renders an editor overlay showing the skeleton:

- **Bone sticks** — diamond-shaped prisms (6 verts, 8 tris) from parent joint world position to child joint world position. Width = 10% of bone length, waist at 12% from parent end.
- **Joint spheres** — UV spheres at each joint world position, color-coded:
  - Root joint: gold `[1.0, 0.65, 0.2, 1.0]`
  - Regular: blue `[0.55, 0.75, 1.0, 1.0]`
  - Hovered: yellow `[1.0, 0.85, 0.1, 1.0]`
  - Selected: cyan `[0.1, 1.0, 0.85, 1.0]`

Joint radius = `computeGizmoScale(camera, skeletonCenter) × 0.07` — scales with camera distance for consistent screen-space size.

The overlay is drawn with `depthCompare: 'always'` (same pipeline as all gizmos), so it is always visible through geometry.

`hitTestJoint(rayOrigin, rayDir, skeleton, camera)` sphere-tests each joint and returns the nearest hit joint index. Hit radius = 1.8× visual radius for comfortable picking. Called each frame on `mousemove`; `mousedown` selects the hovered joint.

---

## Mesh Painting

**Files:** `src/services/managers/mesh-paint-manager.ts`, `src/scene-graph/shapes/mesh-3d.ts`

CPU-side brush painting onto a mesh's UV-mapped texture. Requires the mesh to have valid UV coordinates (all GLTF-imported meshes do; Salsa primitives also carry UVs from their generators).

### Data model

Three new fields on `Mesh3D`:

| Field | Type | Description |
|-------|------|-------------|
| `paintTexture` | `GPUTexture \| null` | GPU `rgba8unorm` texture; null until paint mode is entered |
| `paintBuffer` | `Uint8Array \| null` | CPU mirror of `paintTexture` (same dimensions × 4 bytes/texel) |
| `paintTexSize` | `number` | Edge length in texels (square; default 1024) |

### Paint pipeline

```
pointerdown / pointermove
  → MeshPicker.pickMesh()  → PickResult { triangleIndex, baryU, baryV }
  → _interpUV(hit, channel)
      reads UV[0-7] from geometry float array at FLOATS_PER_VERT stride
      barycentrically interpolates: w0*uv0 + baryU*uv1 + baryV*uv2
  → _stampBrush(mesh, uvU, uvV)
      texX = round(uvU * texSize)
      texY = round((1 - uvV) * texSize)   ← Y-flip: UV origin bottom-left, buffer top-left
      for each texel within brushRadius:
          compute alpha falloff (hardness 0–1)
          alpha-blend brush color over existing buffer pixel
      _expandDirty(x0, y0, x1, y1)        ← accumulate dirty rect
      _flushDirty()                        → writeTexture(dirty region only)

pointerup
  → endStroke()  → _pushUndo(buf.slice())  ← full buffer snapshot, max 20
```

### Undo/redo

Each stroke (pointerdown → pointerup) produces one undo entry — a full `Uint8Array` copy of the paint buffer. Max 20 entries; oldest are evicted when full. Undo/redo upload the restored buffer via a single full `writeTexture` call.

### Texture integration

On `enterMeshPaintMode`, `MeshPaintManager` sets `mesh.diffuseTexture = mesh.paintTexture`. This means the paint layer **replaces** the mesh's diffuse input for the renderer. If the mesh had an imported texture, callers should save a reference to the original before entering paint mode if they want to restore it.

The paint texture is allocated as:
```typescript
device.createTexture({
  size:   [texSize, texSize, 1],
  format: 'rgba8unorm',
  usage:  TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
})
```

Initialized to solid white (255,255,255,255). The renderer samples it identically to any other `diffuseTexture` via the existing `texture_2d_array` bind group (1-layer array view).

---

## Vertex Color Pipeline

**Files:** `src/renderer/3d/shaders/mesh3d-shaders.ts`, `src/renderer/3d/pipeline-3d.ts`, `src/renderer/3d/renderer-3d.ts`

When a mesh has per-vertex RGBA colors (from the `MeshEditManager` paint ops or `EditMesh.paintVertexColor/paintFaceColor`), it renders via a dedicated vertex-color pipeline instead of the standard Gouraud pipeline.

### Data flow

```
EditMesh.paintVertexColor / paintFaceColor
  → stores color on EditVertex.color
  → syncFromEditMesh() calls editMesh.compile()
  → MeshGeometry.vertexColors: Float32Array  (4 floats RGBA per vertex, parallel to vertex buffer)
  → Mesh3D.vertexColors = geom.vertexColors
  → mesh.gpuDirty = true
```

### Renderer upload

In `Renderer3D.drawMeshes()`, dirty VC meshes are detected **before** `_ensureGeomPool` clears `gpuDirty`:

```typescript
const vcDirtyIds = new Set(meshes.filter(m => m.gpuDirty && !!m.vertexColors).map(m => m.id));
```

After the pool rebuild, `_uploadVCBuffers(mesh)` is called for each dirty VC mesh. It:
1. Creates a **standalone vertex buffer override** for the mesh geometry (stored in `_vertexBufferOverrides`). This forces `baseVertex = 0` in `drawIndexed`, so the color buffer's 0-based indices align with the vertex buffer's 0-based indices. (Without this, the pool's `baseVertex` offset would mis-align the two buffers.)
2. Creates (or re-creates) a `GPUBuffer` in `_vcColorBuffers` from `mesh.vertexColors`.

### Pipeline

`Pipeline3D` creates `_opaqueVertexColor` with two vertex buffer layouts:

| Slot | Stride | Contents |
|------|--------|----------|
| 0 | 48 bytes | Standard geometry (pos + normal + uv + tangent) |
| 1 | 16 bytes | `@location(4) vertexColor: vec4<f32>` (RGBA per vertex) |

The vertex shader (`MESH3D_VERTEX_SHADER_VERTEX_COLOR`) reads `in.vertexColor` instead of `inst.diffuseColor.rgb` for the Gouraud lighting calculation. The fragment shader is the same as the standard untextured path.

### Draw dispatch

```typescript
const opaqueVC = opaque.filter(e => !e.submesh && !!e.mesh.vertexColors);
// standard opaqueSimple list excludes these meshes

pass.setPipeline(pipeline.opaqueVertexColorPipeline);
pass.setBindGroup(0, meshBindGroup);
for (const { mesh, idx } of opaqueVC) {
  pass.setVertexBuffer(1, _vcColorBuffers.get(mesh.id));
  drawMesh(pass, mesh, idx, mainVBRef);  // uses standalone VB override
}
```

### Activation

The vertex-color pipeline is used automatically whenever `mesh.vertexColors` is non-null. Setting vertex/face colors via `MeshEditManager` (or directly via `EditMesh`) and calling `syncFromEditMesh()` triggers this path on the next frame.

---

## Grease Pencil Renderer (GpRenderer3D)

**Files:** `src/renderer/3d/gp-renderer-3d.ts`, `src/renderer/3d/shaders/gp-shaders.ts`

### Draw order

GP draws after all 3D meshes and particles, in two sub-passes:

```
meshes → particles → GP fills → GP strokes
```

This is controlled by `WebGPURenderer.draw3DGp()`, called at line ~2746 of `webgpu-renderer.ts`. Within the GP pass, objects are sorted by `GpObject3D.renderOrder` (ascending) before any draw calls.

### Stroke expansion

Each `GpStroke3D` is expanded into a screen-space quad strip on the GPU. The vertex shader receives world-space points and extrudes them perpendicular to the view direction by `baseWidth * pressure` per point. No index buffer is needed: `draw(6 * (pointCount - 1))` produces the correct quad count.

### Fill triangulation

Closed strokes with a `fillColor` are triangulated using the ear-clipping algorithm (CPU-side, run once per stroke when `closed = true`). The fill triangles are uploaded to a per-call `GPUBuffer` and drawn before the stroke outline.

### Bone parenting

If `stroke.parentJoint` is set:
1. The renderer resolves the joint index from the linked `Skeleton3D` (looked up by `GpObject3D.skeletonId`).
2. The skeleton's `skinMatrices` storage buffer is bound at bind group 1.
3. The vertex shader reads the joint's world matrix and applies it to every point in the stroke.

If no parent joint: a 1-matrix dummy storage buffer is bound and `jointIndex = -1`, so the shader skips the transform with no branch cost.

### Uniform layout (per stroke)

| Bytes | Field |
|-------|-------|
| 64 | `viewProj` mat4 |
| 12 | `strokeColor` vec3 |
| 4 | `baseWidth` f32 |
| 4 | `jointIndex` i32 (−1 = none) |
| 8 | `canvasSize` vec2 (px) |
| 4 | `opacity` f32 |
| 4 | padding |

Total: `GP_STROKE_UNIFORM_BYTES` = 100 bytes (aligned to 256 for WebGPU).

### Pipelines

| Pipeline | Vertex shader | Fragment shader | Use |
|----------|--------------|-----------------|-----|
| `gpStrokePipeline` | `GP_STROKE_VERTEX` | `GP_STROKE_FRAGMENT` | Quad-strip outlines |
| `gpFillPipeline` | `GP_FILL_VERTEX` | `GP_FILL_FRAGMENT` | Ear-clipped fill triangles |

Both pipelines use `depth24plus-stencil8` with depth-write **disabled** — GP draws on top of the depth buffer from the mesh pass without occluding other GP strokes.
