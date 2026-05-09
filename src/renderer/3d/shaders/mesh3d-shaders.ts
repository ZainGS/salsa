/**
 * PS1-style WGSL shaders for 3D mesh rendering.
 *
 * Design goals (PS1 fidelity):
 *  - Vertex-lit Gouraud shading (per-vertex, NOT per-pixel) for non-normal-mapped meshes
 *  - Per-pixel Phong lighting when a normal map is bound (bit 1 of material flags)
 *  - Affine texture mapping (no perspective correction — classic PS1 warping)
 *  - Vertex jitter/snapping (optional — maps world positions to a low-res grid)
 *
 * Render styles (bits 2-3 of material flags — see material-3d.ts):
 *  0 = default   standard Phong/Gouraud
 *  1 = cel       toon shading (stepped diffuse bands + hard specular)
 *  2 = sketch    crosshatch shading (pencil-drawn look)
 *  3 = ink       flat + silhouette rim darkening (manga look)
 *
 * Vertex format: position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4) = 48 bytes
 *
 * Uniform layout:
 *  Bind group 0, binding 0: per-mesh instance storage buffer (model matrix, material)
 *  Bind group 0, binding 1: scene-wide uniform buffer (viewProj, camera, lights, PS1 params)
 *  Bind group 1, binding 0: diffuse texture
 *  Bind group 1, binding 1: diffuse sampler
 *  Bind group 1, binding 2: normal map texture  (flat-normal 1×1 default when not set)
 *  Bind group 1, binding 3: normal map sampler
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_VERTEX_SHADER = /* wgsl */ `

// ── Per-mesh instance data (storage buffer) ─────────────────────

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,    // 64 bytes
  normalMatrix:   mat4x4<f32>,    // 64 bytes  (inverse-transpose of model for normals)
  diffuseColor:   vec4<f32>,      // 16 bytes  (r,g,b,a)
  specularColor:  vec4<f32>,      // 16 bytes  (r,g,b, shininess in .a)
  emissiveColor:  vec4<f32>,      // 16 bytes  (r,g,b, flags in .a)
  // flags.a: bit0 = hasTexture, bit1 = hasNormalMap, bits2-3 = renderStyle
  textureIndex:   u32,            //  4 bytes  layer index into diffuse texture_2d_array
  normalMapIndex: u32,            //  4 bytes  layer index into normal map texture_2d_array
  _pad0:          u32,            //  4 bytes  pad → total 192 bytes
  _pad1:          u32,            //  4 bytes
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

// ── Scene-wide uniforms ─────────────────────────────────────────

struct SceneUniforms {
  viewProjection: mat4x4<f32>,    // 64 bytes
  cameraPosition: vec4<f32>,      // 16 bytes  (.xyz = position, .w unused)
  ambientColor: vec4<f32>,        // 16 bytes  (.rgb = color, .a = intensity)
  lightDirection: vec4<f32>,      // 16 bytes  (.xyz = normalized dir, .w = intensity)
  lightColor: vec4<f32>,          // 16 bytes  (.rgb = color, .a unused)
  ps1Config: vec4<f32>,           // 16 bytes  (.x = jitterStrength, .y = snapGridSize,
                                  //            .z = affineStrength, .w = colorDepth)
  resolution: vec4<f32>,          // 16 bytes  (.xy = render target size in pixels)
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// ── Vertex I/O ──────────────────────────────────────────────────

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,  // .xyz = tangent dir, .w = handedness
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:     vec4<f32>,  // Gouraud-lit color (used when no normal map)
  @location(1) uv:        vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:      vec3<f32>,  // for per-pixel lighting
  @location(4) worldNormal:   vec3<f32>,  // TBN: N
  @location(5) worldTangent:  vec3<f32>,  // TBN: T
  @location(6) worldBitangent:vec3<f32>,  // TBN: B
};

// ── Helpers ─────────────────────────────────────────────────────

fn snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  let screenX = pos.x / w;
  let screenY = pos.y / w;
  let grid = gridSize;
  snapped.x = round(screenX * grid) / grid * w;
  snapped.y = round(screenY * grid) / grid * w;
  return snapped;
}

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let levels = depth;
  return floor(c * levels + 0.5) / levels;
}

// ── Main vertex shader ──────────────────────────────────────────

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  let worldPos4   = inst.modelMatrix * vec4<f32>(in.position, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  // Clip-space position
  var clipPos = scene.viewProjection * worldPos4;

  // PS1 vertex jitter
  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // ── Gouraud lighting (always computed; used when hasNormalMap = 0) ──

  var lit = inst.diffuseColor.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += inst.diffuseColor.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let V = normalize(scene.cameraPosition.xyz - worldPos4.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;
  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  // ── TBN for normal mapping ──────────────────────────────────
  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  // Gram-Schmidt re-orthogonalize
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos       = clipPos;
  out.color         = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv            = in.uv;
  out.instanceIdx   = idx;
  out.worldPos      = worldPos4.xyz;
  out.worldNormal   = worldNormal;
  out.worldTangent  = T;
  out.worldBitangent = B;
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  FRAGMENT SHADER — textured (with optional normal map + render styles)
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER = /* wgsl */ `

${STYLE_WGSL_FUNCTIONS}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  _pad0:          u32,
  _pad1:          u32,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:      vec4<f32>,
  resolution:     vec4<f32>,
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0) var diffuseTexture:   texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler:   sampler;
@group(1) @binding(2) var normalMapTexture: texture_2d_array<f32>;
@group(1) @binding(3) var normalMapSampler: sampler;

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@fragment
fn fs_main(
  @location(0) gouraudColor:   vec4<f32>,
  @location(1) uv:             vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:       vec3<f32>,
  @location(4) worldNormal:    vec3<f32>,
  @location(5) worldTangent:   vec3<f32>,
  @location(6) worldBitangent: vec3<f32>,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = bitcast<u32>(inst.emissiveColor.a);
  let hasTexture   = (flags & 1u) != 0u;
  let hasNormalMap = (flags & 2u) != 0u;
  let renderStyle  = (flags >> 2u) & 3u;   // bits 2-3: 0=default 1=cel 2=sketch 3=ink

  let L = normalize(-scene.lightDirection.xyz);
  let V = normalize(scene.cameraPosition.xyz - worldPos);

  // Sample textures unconditionally — textureSample requires uniform control flow.
  // textureIndex / normalMapIndex index into the shared texture_2d_array atlas.
  let texSample    = textureSample(diffuseTexture,   diffuseSampler,   uv, i32(inst.textureIndex));
  let normalSample = textureSample(normalMapTexture, normalMapSampler, uv, i32(inst.normalMapIndex));

  // Resolve surface normal (apply normal map if bound)
  var N = normalize(worldNormal);
  if (hasNormalMap) {
    let mapN = normalSample.xyz * 2.0 - 1.0;
    N = normalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
  }

  var lit: vec3<f32>;

  if (renderStyle == 1u) {
    // ── Cel shading ────────────────────────────────────────────
    lit = cel_lighting(
      inst.diffuseColor.rgb, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      inst.emissiveColor.rgb,
    );
  } else if (renderStyle == 2u) {
    // ── Sketch / crosshatch ────────────────────────────────────
    lit = sketch_lighting(
      inst.diffuseColor.rgb, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 3u) {
    // ── Ink / manga rim ───────────────────────────────────────
    lit = ink_lighting(
      inst.diffuseColor.rgb, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (hasNormalMap) {
    // ── Default: per-pixel Phong (normal map path) ─────────────
    var phong = inst.diffuseColor.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
    let NdotL = max(dot(N, L), 0.0);
    phong += inst.diffuseColor.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
    let H    = normalize(L + V);
    let spec = pow(max(dot(N, H), 0.0), max(inst.specularColor.a, 1.0));
    phong += inst.specularColor.rgb * scene.lightColor.rgb * spec;
    phong += inst.emissiveColor.rgb;
    let cd = scene.ps1Config.w;
    if (cd > 0.0) { phong = quantizeColor(phong, cd); }
    lit = phong;
  } else {
    // ── Default: Gouraud from vertex shader ───────────────────
    lit = gouraudColor.rgb;
  }

  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);

  if (hasTexture) {
    // texSample was fetched unconditionally above (uniform control flow requirement)
    if (renderStyle == 2u) {
      finalColor = vec4<f32>(mix(finalColor.rgb, finalColor.rgb * texSample.rgb, 0.5), finalColor.a * texSample.a);
    } else {
      finalColor = vec4<f32>(finalColor.rgb * texSample.rgb, finalColor.a * texSample.a);
    }
  }

  if (finalColor.a < 0.01) { discard; }
  return finalColor;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  UNTEXTURED FRAGMENT SHADER — Gouraud/style, no texture group needed
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED = `

${STYLE_WGSL_FUNCTIONS}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  _pad0:          u32,
  _pad1:          u32,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:      vec4<f32>,
  resolution:     vec4<f32>,
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@fragment
fn fs_main(
  @location(0) gouraudColor: vec4<f32>,
  @location(1) uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:     vec3<f32>,
  @location(4) worldNormal:  vec3<f32>,
) -> @location(0) vec4<f32> {
  let inst       = u_instances[instanceIdx];
  let flags      = bitcast<u32>(inst.emissiveColor.a);
  let renderStyle = (flags >> 2u) & 3u;

  let L = normalize(-scene.lightDirection.xyz);
  let V = normalize(scene.cameraPosition.xyz - worldPos);
  let N = normalize(worldNormal);

  var lit: vec3<f32>;
  if (renderStyle == 1u) {
    lit = cel_lighting(
      inst.diffuseColor.rgb, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      inst.emissiveColor.rgb,
    );
  } else if (renderStyle == 2u) {
    lit = sketch_lighting(
      inst.diffuseColor.rgb, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 3u) {
    lit = ink_lighting(
      inst.diffuseColor.rgb, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else {
    lit = gouraudColor.rgb;
  }

  let finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  if (finalColor.a < 0.01) { discard; }
  return finalColor;
}
`;
