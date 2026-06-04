/**
 * Shadow map shaders for the Salsa 3D renderer.
 *
 * Two shader sets:
 *  1. SHADOW_PASS: depth-only vertex shader for rendering the shadow map.
 *  2. MESH3D_*_SHADOW: full-render shaders with shadow sampling added.
 *
 * Shadow map bind group index varies by pipeline path:
 *   Textured shadow   (mesh + texture + shadow): shadow is at group 2
 *   Untextured shadow (mesh + shadow only):       shadow is at group 1
 * WebGPU forbids gaps in bind group indices, so the index shifts when no
 * texture group sits between the mesh group (0) and the shadow group.
 *
 * SceneUniforms here is the EXTENDED layout (adds lightSpaceMatrix + shadowParams
 * beyond the base 160 bytes). The base mesh3d shaders still work because their
 * structs only read the first 160 bytes of the same 256-byte uniform buffer.
 */

// ── Extended SceneUniforms (shared by all shadow shaders) ─────────────
const SCENE_UNIFORMS_SHADOW_WGSL = /* wgsl */`
struct SceneUniforms {
  viewProjection:  mat4x4<f32>,   // 64 bytes  (floats  0-15)
  cameraPosition:  vec4<f32>,     // 16 bytes  (floats 16-19)
  ambientColor:    vec4<f32>,     // 16 bytes  (floats 20-23)
  lightDirection:  vec4<f32>,     // 16 bytes  (floats 24-27)
  lightColor:      vec4<f32>,     // 16 bytes  (floats 28-31)
  ps1Config:       vec4<f32>,     // 16 bytes  (floats 32-35)
  resolution:      vec4<f32>,     // 16 bytes  (floats 36-39)
  lightSpaceMatrix:mat4x4<f32>,   // 64 bytes  (floats 40-55)
  shadowParams:    vec4<f32>,     // 16 bytes  (floats 56-59, .y=bias, .z=mapSize)
  fogColor:        vec4<f32>,     // 16 bytes  (floats 60-63, .rgb=fog color)
  fogParams:       vec4<f32>,     // 16 bytes  (floats 64-67, .x=near, .y=far, .z=density, .w=mode)
};
`;

// ── MeshInstance (shared) ─────────────────────────────────────────────
const MESH_INSTANCE_WGSL = /* wgsl */`
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
`;

// ═══════════════════════════════════════════════════════════════════
//  SHADOW PASS — depth-only vertex shader (no fragment output needed)
// ═══════════════════════════════════════════════════════════════════

export const SHADOW_VERTEX_SHADER = /* wgsl */ `
${MESH_INSTANCE_WGSL}

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

${SCENE_UNIFORMS_SHADOW_WGSL}

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@vertex
fn vs_shadow(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @builtin(instance_index) idx: u32,
) -> @builtin(position) vec4<f32> {
  let worldPos = u_instances[idx].modelMatrix * vec4<f32>(position, 1.0);
  return scene.lightSpaceMatrix * worldPos;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  SHADOW-ENABLED VERTEX SHADER (outputs lightSpacePos for fragment)
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_VERTEX_SHADER_SHADOW = /* wgsl */ `
${MESH_INSTANCE_WGSL}

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

${SCENE_UNIFORMS_SHADOW_WGSL}

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos:        vec4<f32>,
  @location(0) color:                vec4<f32>,
  @location(1) uv:                   vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) lightSpacePos:        vec4<f32>,
  @location(4) worldPos:             vec3<f32>,
};

fn snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  snapped.x = round(pos.x / w * gridSize) / gridSize * w;
  snapped.y = round(pos.y / w * gridSize) / gridSize * w;
  return snapped;
}

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) idx: u32) -> VertexOutput {
  let inst = u_instances[idx];
  let worldPos    = inst.modelMatrix  * vec4<f32>(in.position, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting
  var lit = inst.diffuseColor.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L    = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += inst.diffuseColor.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let V = normalize(scene.cameraPosition.xyz - worldPos.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;

  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  var out: VertexOutput;
  out.clipPos       = clipPos;
  out.color         = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv            = in.uv;
  out.instanceIdx   = idx;
  out.lightSpacePos = scene.lightSpaceMatrix * worldPos;
  out.worldPos = worldPos.xyz;
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  SHADOW-ENABLED FRAGMENT SHADER — textured variant
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER_SHADOW = /* wgsl */ `
${MESH_INSTANCE_WGSL}

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

${SCENE_UNIFORMS_SHADOW_WGSL}

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0) var diffuseTexture: texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler: sampler;

@group(2) @binding(0) var shadowMap:     texture_depth_2d;
@group(2) @binding(1) var shadowSampler: sampler_comparison;

fn sampleShadow(lightSpacePos: vec4<f32>) -> f32 {
  // Perspective divide → NDC
  let ndc = lightSpacePos.xyz / lightSpacePos.w;
  // Map x,y from [-1,1] to [0,1]; WebGPU y is flipped in clip space vs texture UV
  let uv  = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  // Track bounds without early-returning — textureSampleCompare requires uniform control flow
  let inRange   = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  let clampedUV = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let bias  = scene.shadowParams.y;
  let depth = ndc.z - bias;
  // PCF 5x5 — always executed to satisfy uniform control flow requirement
  let mapSize = max(scene.shadowParams.z, 1.0);
  let texel   = 1.0 / mapSize;
  var shadow  = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let offset = vec2<f32>(f32(dx), f32(dy)) * texel;
      shadow += textureSampleCompare(shadowMap, shadowSampler, clampedUV + offset, depth);
    }
  }
  return select(1.0, shadow / 25.0, inRange);
}

@fragment
fn fs_main(
  @location(0) color:       vec4<f32>,
  @location(1) uv:          vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) lightSpacePos: vec4<f32>,
  @location(4) worldPos:    vec3<f32>,
) -> @location(0) vec4<f32> {
  let inst  = u_instances[instanceIdx];
  let flags = bitcast<u32>(inst.emissiveColor.a);

  // Sample diffuse texture unconditionally — textureSample requires uniform control flow
  let texColor = textureSample(diffuseTexture, diffuseSampler, uv, i32(inst.textureIndex));
  var finalColor = color;
  let hasTexture = (flags & 1u) != 0u;
  if (hasTexture) {
    finalColor = vec4<f32>(color.rgb * texColor.rgb, color.a * texColor.a);
  }
  if (finalColor.a < 0.01) { discard; }

  // Shadow attenuation (shadow darkens to 30% min)
  let shadowFactor = sampleShadow(lightSpacePos);
  finalColor = vec4<f32>(finalColor.rgb * mix(0.3, 1.0, shadowFactor), finalColor.a);

  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u) {
    let fogDist = length(scene.cameraPosition.xyz - worldPos);
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }
  return finalColor;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  SHADOW-ENABLED FRAGMENT SHADER — untextured variant
//  NOTE: shadow is at group(1) here (no texture group between mesh and shadow)
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW = /* wgsl */ `
${SCENE_UNIFORMS_SHADOW_WGSL}

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0) var shadowMap:     texture_depth_2d;
@group(1) @binding(1) var shadowSampler: sampler_comparison;

fn sampleShadow(lightSpacePos: vec4<f32>) -> f32 {
  let ndc = lightSpacePos.xyz / lightSpacePos.w;
  let uv  = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let inRange   = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  let clampedUV = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let bias  = scene.shadowParams.y;
  let depth = ndc.z - bias;
  let mapSize = max(scene.shadowParams.z, 1.0);
  let texel   = 1.0 / mapSize;
  var shadow  = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let offset = vec2<f32>(f32(dx), f32(dy)) * texel;
      shadow += textureSampleCompare(shadowMap, shadowSampler, clampedUV + offset, depth);
    }
  }
  return select(1.0, shadow / 25.0, inRange);
}

@fragment
fn fs_main(
  @location(0) color:         vec4<f32>,
  @location(1) uv:            vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) lightSpacePos: vec4<f32>,
  @location(4) worldPos:      vec3<f32>,
) -> @location(0) vec4<f32> {
  if (color.a < 0.01) { discard; }
  let shadowFactor = sampleShadow(lightSpacePos);
  var finalColor = vec4<f32>(color.rgb * mix(0.3, 1.0, shadowFactor), color.a);
  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u) {
    let fogDist = length(scene.cameraPosition.xyz - worldPos);
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }
  return finalColor;
}
`;
