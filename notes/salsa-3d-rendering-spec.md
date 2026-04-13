# Salsa 3D WebGPU Rendering — Implementation Plan

> **For**: Salsa engine  
> **Prerequisite**: Current 2D WebGPU renderer passing `npm run build`  
> **Date**: April 2026

---

## Current State Assessment

Salsa's 2D renderer already has significant 3D-ready infrastructure:

| Component | Current State | 3D Readiness |
|---|---|---|
| Transform matrices | `mat4` throughout (gl-matrix) | **Ready** — Z hardcoded to 0 but infrastructure is mat4 |
| Depth buffer | `depth24plus-stencil8` created and attached | **Ready** — just disabled (`depthCompare: "always"`) |
| Uniform layout | 256-byte blocks with slot `[41]` reserved for Z depth | **Ready** — enable the commented-out Z slot |
| Cache system | Geometry, uniform, texture, indirect draw caches | **Reusable** — generic and type-parameterized |
| Render loop | Multi-pipeline dispatch via `drawVectorShapes` | **Extensible** — add 3D pipeline section |
| gl-matrix | `mat4`, `vec3`, `vec4` imported across 35+ files | **Ready** — `mat4.perspective()`, `.lookAt()`, `.rotateX/Y` available |

### What Needs to Be Built

- Camera system (perspective + orbit controls)
- 3D vertex format (position + normal + UV)
- 3D WGSL shaders (vertex transform + fragment lighting)
- Mesh geometry generators (primitives + OBJ/glTF loading)
- Lighting system (directional, point, ambient)
- Material system (Phong/PBR)
- 3D render pipeline in PipelineManager
- 3D scene graph nodes (Mesh3D, Light, Camera)

---

## Implementation Phases

### Phase 1 — Camera & Projection

**Goal**: Replace the flat affine "world matrix" with a proper camera that can switch between orthographic (existing 2D behavior) and perspective (3D).

#### 1.1 Camera Class

Create `src/renderer/core/camera.ts`:

```ts
class Camera {
  position: vec3;       // eye position
  target: vec3;         // look-at point
  up: vec3;             // up vector (usually [0, 1, 0])
  fov: number;          // vertical field of view (radians), perspective only
  near: number;         // near clip plane
  far: number;          // far clip plane
  aspect: number;       // width / height
  mode: 'perspective' | 'orthographic';

  getViewMatrix(): mat4;            // mat4.lookAt(eye, target, up)
  getProjectionMatrix(): mat4;      // mat4.perspective or mat4.ortho
  getViewProjectionMatrix(): mat4;  // projection × view
}
```

#### 1.2 Orbit Camera Controller

Create `src/renderer/core/orbit-controller.ts`:

```ts
class OrbitController {
  camera: Camera;
  radius: number;      // distance from target
  azimuth: number;     // horizontal angle (radians)
  elevation: number;   // vertical angle (radians)
  minElevation: number;
  maxElevation: number;
  enableDamping: boolean;

  // Input handlers
  onPointerDown(ev: PointerEvent): void;
  onPointerMove(ev: PointerEvent): void;  // drag → rotate
  onWheel(ev: WheelEvent): void;          // scroll → zoom (radius)
  onPointerUp(ev: PointerEvent): void;
  update(): void;  // apply damping, recompute camera.position from spherical coords
}
```

#### 1.3 Wire Into Renderer

- Add `camera: Camera` to `WebGPURenderer`
- In interaction service, when 3D mode is active, use `camera.getViewProjectionMatrix()` instead of the current manual affine world matrix
- Existing 2D rendering continues to work — camera in orthographic mode with Z=0 produces the same result as the current system

#### Steps
1. Create Camera class with perspective and orthographic modes
2. Create OrbitController with mouse/touch input
3. Add `setCamera()` / `getCamera()` to WebGPURenderer
4. When camera is set, use its VP matrix as the world matrix uniform
5. Expose through ShapeManager: `shapeManager.setCamera3D(config)`

---

### Phase 2 — Depth Testing & Z Axis

**Goal**: Enable the already-existing depth buffer and allow nodes to have Z positions.

#### 2.1 Enable Z on Nodes

In `src/scene-graph/shapes/base/node.ts`:
- Add `z: number = 0` property
- In `updateLocalMatrix()`: change `mat4.translate(local, local, [this.x, this.y, 0])` → `[this.x, this.y, this.z]`

#### 2.2 Enable Depth Testing

New 3D pipelines will use:
```ts
depthStencil: {
  format: "depth24plus-stencil8",
  depthWriteEnabled: true,
  depthCompare: "less",
}
```

Existing 2D pipelines remain with `depthCompare: "always"` — no breakage.

#### 2.3 Enable Z in Uniforms

In the uniform cache, populate slot `[41]` (already reserved):
```ts
uniformData[41] = shape.z; // was commented out
```

#### Steps
1. Add `z` property to Node
2. Update `updateLocalMatrix()` to use `this.z`
3. Populate uniform Z slot
4. Create a new pipeline flag/variant with `depthWriteEnabled: true`
5. Verify existing 2D rendering is unaffected (all Z=0, no depth writes)

---

### Phase 3 — 3D Vertex Format & Shaders

**Goal**: New vertex layout and WGSL shaders for lit 3D geometry.

#### 3.1 Vertex Layout

```
float32x3 position  (12 bytes)
float32x3 normal    (12 bytes)
float32x2 uv        (8 bytes)
─── total: 32 bytes per vertex ───
```

#### 3.2 Vertex Shader (WGSL)

```wgsl
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex fn vs(in: VertexInput, @builtin(instance_index) idx: u32) -> VertexOutput {
  let data = uniforms[idx];
  let worldPos = data.modelMatrix * vec4<f32>(in.position, 1.0);
  var out: VertexOutput;
  out.clipPos = data.viewProjection * worldPos;
  out.worldPos = worldPos.xyz;
  out.worldNormal = normalize((data.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);
  out.uv = in.uv;
  return out;
}
```

#### 3.3 Fragment Shader (Blinn-Phong)

```wgsl
struct Light {
  direction: vec3<f32>,  // for directional
  color: vec3<f32>,
  intensity: f32,
  type: u32,             // 0=directional, 1=point, 2=ambient
  position: vec3<f32>,   // for point lights
  range: f32,
};

@fragment fn fs(in: VertexOutput) -> @location(0) vec4<f32> {
  let normal = normalize(in.worldNormal);
  var color = vec3<f32>(0.0);

  for (var i = 0u; i < lightCount; i++) {
    let light = lights[i];
    if (light.type == 2u) {
      // Ambient
      color += material.diffuse.rgb * light.color * light.intensity;
    } else {
      // Directional or point
      var L: vec3<f32>;
      var atten = 1.0;
      if (light.type == 0u) {
        L = normalize(-light.direction);
      } else {
        let toLight = light.position - in.worldPos;
        let dist = length(toLight);
        L = toLight / dist;
        atten = saturate(1.0 - dist / light.range);
      }
      let NdotL = max(dot(normal, L), 0.0);
      color += material.diffuse.rgb * light.color * light.intensity * NdotL * atten;

      // Specular (Blinn-Phong)
      let V = normalize(camera.position - in.worldPos);
      let H = normalize(L + V);
      let spec = pow(max(dot(normal, H), 0.0), material.shininess);
      color += material.specular.rgb * light.color * spec * atten;
    }
  }

  return vec4<f32>(color, material.diffuse.a);
}
```

#### Steps
1. Define new vertex buffer layout in PipelineManager
2. Write WGSL vertex shader with model-view-projection transform
3. Write WGSL fragment shader with Blinn-Phong lighting
4. Create `create3DRenderPipeline()` in PipelineManager
5. Register as a new pipeline type alongside existing shape/text/stroke pipelines

---

### Phase 4 — Mesh Geometry & 3D Primitives

**Goal**: 3D shape nodes that generate GPU geometry.

#### 4.1 Mesh3D Node

Create `src/scene-graph/shapes/mesh-3d.ts`:

```ts
class Mesh3D extends Shape {
  vertices: Float32Array;   // position + normal + uv
  indices: Uint32Array;
  material: Material3D;

  // Optional: generate from primitives
  static createBox(w, h, d): Mesh3D;
  static createSphere(radius, segments): Mesh3D;
  static createPlane(w, h, subdivisions): Mesh3D;
  static createCylinder(radiusTop, radiusBottom, height, segments): Mesh3D;
  static createTorus(radius, tube, radialSegments, tubularSegments): Mesh3D;

  getType(): '3DMesh';
}
```

#### 4.2 Geometry Generators

Create `src/renderer/caches/geometry-generators/mesh-generators.ts`:

| Primitive | Parameters | Notes |
|---|---|---|
| Box | width, height, depth | 24 verts (6 faces × 4), 36 indices |
| Sphere | radius, widthSegments, heightSegments | UV sphere |
| Plane | width, height, widthSegments, heightSegments | Subdivided quad |
| Cylinder | topRadius, bottomRadius, height, radialSegments | Cone when topRadius=0 |
| Torus | radius, tubeRadius, radialSegments, tubularSegments | Donut |

All generators produce `{ vertices: Float32Array, indices: Uint32Array }` in the 32-byte vertex format.

#### 4.3 OBJ / glTF Import (Future)

Later extension — parse mesh files into the same vertex/index format:
- OBJ: text-based, positions + normals + UVs, simple parser
- glTF 2.0 / GLB: binary, materials + textures + animations, standard for web

#### Steps
1. Create Mesh3D scene graph node extending Shape
2. Implement box and sphere geometry generators
3. Add plane, cylinder, torus generators
4. Wire geometry into the 3D geometry cache (reuse `ShapesRenderGeometryCache` pattern)
5. Add `createMesh3D()` to ShapeFactory

---

### Phase 5 — Lighting System

**Goal**: Scene lights that affect 3D meshes.

#### 5.1 Light Node

Create `src/scene-graph/shapes/light-3d.ts`:

```ts
type LightType = 'directional' | 'point' | 'ambient';

class Light3D extends Node {
  lightType: LightType;
  color: vec3;         // RGB 0–1
  intensity: number;   // multiplier
  range: number;       // for point lights (attenuation distance)

  getType(): '3DLight';
}
```

#### 5.2 Light Uniform Buffer

Lights are uploaded once per frame as a uniform/storage buffer. Layout:

```
struct Light {
  direction: vec4<f32>,  // .xyz = dir, .w = type (0/1/2)
  color: vec4<f32>,      // .rgb = color, .a = intensity
  position: vec4<f32>,   // .xyz = position, .w = range
};
// Max 8 lights, 48 bytes each = 384 bytes
```

#### 5.3 Light Collection

Before each frame, scan scene graph for `Light3D` nodes → pack into the light uniform buffer → bind to light bind group (group 1) for 3D pipelines.

#### Steps
1. Create Light3D node with directional/point/ambient types
2. Create light uniform buffer layout (max 8 lights)
3. Collect scene lights in beginFrame and upload
4. Bind light buffer to fragment shader bind group
5. Add ShapeFactory methods: `createDirectionalLight()`, `createPointLight()`, `createAmbientLight()`
6. Expose through ShapeManager

---

### Phase 6 — Material System

**Goal**: Per-mesh visual properties beyond flat color.

#### 6.1 Material3D

```ts
interface Material3D {
  diffuse: RGBA;              // base color
  specular: RGBA;             // specular highlight color
  emissive: RGBA;             // self-illumination
  shininess: number;          // specular exponent (1–256)
  diffuseTexture?: GPUTexture; // optional albedo map
  normalTexture?: GPUTexture;  // optional normal map (Phase 8)
  opacity: number;
}
```

#### 6.2 Material Uniform Layout

Packed into the per-mesh uniform block (extending the existing 256-byte layout):
```
[44-47]: diffuse (vec4)
[48-51]: specular (vec4)
[52-55]: emissive (vec4)
[56]:    shininess (f32)
[57]:    opacity (f32)
[58]:    textureFlags (u32) — bitmask: bit0=hasDiffuseMap, bit1=hasNormalMap
```

#### Steps
1. Define Material3D interface
2. Extend uniform layout with material properties
3. Update fragment shader to read material uniforms
4. When diffuseTexture is set, sample it in fragment shader and multiply with diffuse color
5. Add material setters to Mesh3D

---

### Phase 7 — Render Integration

**Goal**: Mix 3D and 2D content in the same scene.

#### 7.1 Render Order

```
1. Clear color + depth
2. Draw 3D opaque meshes (front-to-back, depth write ON)
3. Draw 3D transparent meshes (back-to-front, depth write OFF, blend ON)
4. Draw raster layers (existing composite, ignores depth)
5. Draw 2D vector shapes (existing pipeline, depth compare ALWAYS)
6. Draw 2D text, selections, overlays (existing)
```

This means 3D content is always "behind" 2D content unless specifically composited. This is the simplest integration — 2D overlays always float on top of the 3D scene.

#### 7.2 Render Pass Structure

Two options:

**Option A — Single render pass (simpler)**:
One render pass, shared depth/color attachments. 3D drawcalls first (depth enabled), then 2D drawcalls (depth disabled). Current approach extended.

**Option B — Separate passes (cleaner)**:
- Pass 1: 3D scene → offscreen color+depth textures
- Pass 2: 2D scene → composites on top of Pass 1's output
- More flexible (can add 3D post-processing between passes) but more complexity.

**Recommendation**: Start with Option A. Move to Option B when post-processing is needed.

#### Steps
1. In `render()`, add a 3D draw section before 2D draws
2. Collect Mesh3D nodes from scene graph, sort by material/depth
3. Draw opaque meshes with depth pipeline
4. Draw transparent meshes back-to-front with blend pipeline
5. Continue with existing 2D rendering (unchanged)
6. Verify 2D rendering is unaffected

---

### Phase 8 — Advanced Features (Future)

These are post-MVP enhancements:

#### 8.1 Shadow Mapping
- Render scene from light's POV into a depth-only texture
- Sample shadow map in fragment shader for shadow testing
- Support directional light shadow maps (orthographic) and point light (cubemap)

#### 8.2 Normal Mapping
- Add tangent vectors to vertex format (40 bytes/vert)
- Sample normal map texture in fragment shader
- Perturb surface normal for detailed surface appearance without extra geometry

#### 8.3 Environment Mapping
- Cubemap texture for reflections
- Sample cubemap using reflected view direction in fragment shader
- HDR environment maps for image-based lighting (IBL)

#### 8.4 Instanced Mesh Rendering
- Same mesh drawn hundreds/thousands of times with different transforms
- Use instance buffer (the `TexturedInstanceBuffer` pattern already exists)
- Ideal for particle systems, foliage, crowds

#### 8.5 Skeletal Animation
- Bone hierarchy with per-bone transforms
- Vertex skinning (4 bone weights per vertex)
- Animation clips with keyframe interpolation
- Requires extending vertex format with bone indices + weights

#### 8.6 Post-Processing
- Bloom (bright pass → blur → composite)
- SSAO (screen-space ambient occlusion)
- Tone mapping (HDR → SDR)
- Depth of field
- The CRT filter effect — applied as a full-screen post-process

#### 8.7 glTF 2.0 Import
- Binary GLB parsing
- PBR material model (metallic-roughness workflow)
- Texture loading (base color, metallic-roughness, normal, occlusion, emissive)
- Scene hierarchy, multiple meshes, embedded animations

---

## ShapeManager API Surface (Planned)

```ts
// Camera
shapeManager.createCamera3D(config: Camera3DConfig): Camera;
shapeManager.setActiveCamera(camera: Camera): void;
shapeManager.setOrbitControls(enabled: boolean): void;

// Meshes
shapeManager.createBox(x, y, z, w, h, d, material?): Mesh3D;
shapeManager.createSphere(x, y, z, radius, segments?, material?): Mesh3D;
shapeManager.createPlane(x, y, z, w, h, material?): Mesh3D;
shapeManager.createCylinder(x, y, z, config): Mesh3D;
shapeManager.createTorus(x, y, z, config): Mesh3D;
shapeManager.importMesh(url: string): Promise<Mesh3D>;  // OBJ/glTF

// Materials
shapeManager.setMeshMaterial(nodeId, material: Material3D): void;
shapeManager.setMeshDiffuseTexture(nodeId, imageData: string): void;

// Lights
shapeManager.createDirectionalLight(direction: vec3, color?, intensity?): Light3D;
shapeManager.createPointLight(x, y, z, color?, intensity?, range?): Light3D;
shapeManager.createAmbientLight(color?, intensity?): Light3D;
shapeManager.setLightColor(nodeId, color: vec3): void;
shapeManager.setLightIntensity(nodeId, intensity: number): void;

// 3D Transform helpers
shapeManager.setPosition3D(nodeId, x, y, z): void;
shapeManager.setRotation3D(nodeId, rx, ry, rz): void;  // Euler angles
shapeManager.setScale3D(nodeId, sx, sy, sz): void;
```

---

## Dependency Order

```
Phase 1: Camera & Projection      (no dependencies)
Phase 2: Depth Testing & Z Axis   (no dependencies, can parallel with 1)
Phase 3: 3D Shaders               (depends on 1 + 2)
Phase 4: Mesh Geometry             (depends on 3)
Phase 5: Lighting                  (depends on 3)
Phase 6: Materials                 (depends on 5)
Phase 7: Render Integration        (depends on 4 + 5 + 6)
Phase 8: Advanced Features         (depends on 7)
```

Phases 1 and 2 can be done in parallel. Phase 3 depends on both.
Phases 4, 5, 6 can be somewhat parallel after Phase 3.
Phase 7 ties everything together.

---

## Estimated Complexity

| Phase | New Files | Modified Files | Scope |
|---|---|---|---|
| 1 — Camera | 2 | 2 (renderer, interaction) | Small |
| 2 — Depth/Z | 0 | 3 (node, uniform cache, pipeline) | Small |
| 3 — Shaders | 1 | 1 (pipeline-manager) | Medium |
| 4 — Mesh Geometry | 2 | 2 (shape-factory, shape-manager) | Medium |
| 5 — Lighting | 1 | 2 (renderer, pipeline-manager) | Medium |
| 6 — Materials | 1 | 2 (uniform cache, fragment shader) | Small-Medium |
| 7 — Integration | 0 | 2 (renderer, render-strategy) | Medium |
| 8 — Advanced | many | several | Large (each sub-feature is its own project) |

Phases 1–7 together form a working 3D renderer with lit meshes, camera controls, and 2D/3D coexistence. Phase 8 is a la carte based on what Frogmarks needs.
