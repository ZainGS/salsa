/**
 * WGSL vertex shaders for Linear Blend Skinning (LBS).
 *
 * Vertex format (72 bytes per vertex):
 *   location 0: position    float32x3  offset  0
 *   location 1: normal      float32x3  offset 12
 *   location 2: uv          float32x2  offset 24
 *   location 3: tangent     float32x4  offset 32
 *   location 4: joints      uint8x4    offset 48  (4 joint indices, u8 each)
 *   location 5: weights     float32x4  offset 52  (blend weights, sum = 1)
 *   (4 bytes padding at offset 68)
 *
 * Bind group layout by pipeline variant:
 *   Textured:   [meshBGL(0), textureBGL(1), skinBGL(2)]  → skinMatrices @group(2)
 *   Untextured: [meshBGL(0), skinBGL(1)]                 → skinMatrices @group(1)
 *
 * Fragment shaders are identical to the standard non-skinned variants
 * (MESH3D_FRAGMENT_SHADER / MESH3D_FRAGMENT_SHADER_UNTEXTURED) and can be
 * reused directly — they only reference groups 0 and 1 (textures).
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';

// ── Shared WGSL snippets ────────────────────────────────────────────────────

const MESH_INSTANCE_WGSL = /* wgsl */`
struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
};
`;

const SCENE_UNIFORMS_WGSL = /* wgsl */`
struct SceneUniforms {
  viewProjection:   mat4x4<f32>,
  cameraPosition:   vec4<f32>,
  ambientColor:     vec4<f32>,
  lightDirection:   vec4<f32>,
  lightColor:       vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,
};
`;

const VERTEX_OUTPUT_WGSL = /* wgsl */`
struct VertexOutput {
  @builtin(position) clipPos:       vec4<f32>,
  @location(0)       color:         vec4<f32>,
  @location(1)       uv:            vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3)       worldPos:      vec3<f32>,
  @location(4)       worldNormal:   vec3<f32>,
  @location(5)       worldTangent:  vec3<f32>,
  @location(6)       worldBitangent:vec3<f32>,
};
`;

const HELPERS_WGSL = /* wgsl */`
fn snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  let screenX = pos.x / w;
  let screenY = pos.y / w;
  snapped.x = round(screenX * gridSize) / gridSize * w;
  snapped.y = round(screenY * gridSize) / gridSize * w;
  return snapped;
}

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}
`;

// ── Shared vertex body (inserted after skinning math) ──────────────────────

const SKINNED_VS_BODY = /* wgsl */`
  let inst = u_instances[idx];

  // Linear Blend Skinning: blend 4 joint matrices
  let skinMat =
    in.weights.x * skinMatrices[in.joints.x] +
    in.weights.y * skinMatrices[in.joints.y] +
    in.weights.z * skinMatrices[in.joints.z] +
    in.weights.w * skinMatrices[in.joints.w];

  let skinnedPos4   = skinMat * vec4<f32>(in.position, 1.0);
  let skinnedNorm   = (skinMat * vec4<f32>(in.normal, 0.0)).xyz;
  let skinnedTanXYZ = (skinMat * vec4<f32>(in.tangent.xyz, 0.0)).xyz;

  let worldPos4   = inst.modelMatrix * skinnedPos4;
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(skinnedNorm, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting
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

  // TBN
  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(skinnedTanXYZ, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv             = in.uv;
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  return out;
`;

// ── Skinned input struct (same for both variants) ─────────────────────────

const SKINNED_INPUT_WGSL = /* wgsl */`
struct SkinnedVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,
  @location(4) joints:   vec4<u32>,   // uint8x4 format → vec4u in WGSL
  @location(5) weights:  vec4<f32>,
};
`;

// ═══════════════════════════════════════════════════════════════════════════
//  TEXTURED variant — skinMatrices at @group(2)
//  Pipeline layout: [meshBGL(0), textureBGL(1), skinBGL(2)]
// ═══════════════════════════════════════════════════════════════════════════

export const SKINNED_MESH3D_VERTEX_SHADER_TEXTURED = /* wgsl */`
${MESH_INSTANCE_WGSL}
${SCENE_UNIFORMS_WGSL}
${VERTEX_OUTPUT_WGSL}
${HELPERS_WGSL}
${SKINNED_INPUT_WGSL}

@group(0) @binding(0) var<storage, read> u_instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:       SceneUniforms;
@group(2) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32) -> VertexOutput {
  ${SKINNED_VS_BODY}
}
`;

// ═══════════════════════════════════════════════════════════════════════════
//  UNTEXTURED variant — skinMatrices at @group(1)
//  Pipeline layout: [meshBGL(0), skinBGL(1)]
// ═══════════════════════════════════════════════════════════════════════════

export const SKINNED_MESH3D_VERTEX_SHADER_UNTEXTURED = /* wgsl */`
${MESH_INSTANCE_WGSL}
${SCENE_UNIFORMS_WGSL}
${VERTEX_OUTPUT_WGSL}
${HELPERS_WGSL}
${SKINNED_INPUT_WGSL}

@group(0) @binding(0) var<storage, read> u_instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:       SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32) -> VertexOutput {
  ${SKINNED_VS_BODY}
}
`;

// ═══════════════════════════════════════════════════════════════════════════
//  WEIGHT PAINT variant — skinMatrices at @group(1), per-vertex colors at @group(2)
//  Pipeline layout: [meshBGL(0), skinBGL(1), weightPaintBGL(2)]
//  Reads per-vertex heat color from a storage buffer instead of inst.diffuseColor.
//  Fragment shader: reuse SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED (Gouraud, renderStyle==0 path).
// ═══════════════════════════════════════════════════════════════════════════

export const SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT = /* wgsl */`
${MESH_INSTANCE_WGSL}
${SCENE_UNIFORMS_WGSL}
${VERTEX_OUTPUT_WGSL}
${HELPERS_WGSL}
${SKINNED_INPUT_WGSL}

@group(0) @binding(0) var<storage, read> u_instances:   array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:         SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices:  array<mat4x4<f32>>;
@group(2) @binding(0) var<storage, read> vertexColors:  array<vec4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32, @builtin(vertex_index) vertIdx: u32) -> VertexOutput {
  let inst  = u_instances[idx];
  let vcol  = vertexColors[vertIdx];

  let skinMat =
    in.weights.x * skinMatrices[in.joints.x] +
    in.weights.y * skinMatrices[in.joints.y] +
    in.weights.z * skinMatrices[in.joints.z] +
    in.weights.w * skinMatrices[in.joints.w];

  let skinnedPos4   = skinMat * vec4<f32>(in.position, 1.0);
  let skinnedNorm   = (skinMat * vec4<f32>(in.normal, 0.0)).xyz;
  let skinnedTanXYZ = (skinMat * vec4<f32>(in.tangent.xyz, 0.0)).xyz;

  let worldPos4   = inst.modelMatrix * skinnedPos4;
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(skinnedNorm, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;
  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting with heat color as diffuse (gives depth cues)
  var lit = vcol.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += vcol.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(skinnedTanXYZ, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), vcol.a);
  out.uv             = in.uv;
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  return out;
}
`;

// Unlit variant — skips NdotL; outputs heat color at full brightness on every face.
export const SKINNED_MESH3D_VERTEX_SHADER_WEIGHT_PAINT_UNLIT = /* wgsl */`
${MESH_INSTANCE_WGSL}
${SCENE_UNIFORMS_WGSL}
${VERTEX_OUTPUT_WGSL}
${HELPERS_WGSL}
${SKINNED_INPUT_WGSL}

@group(0) @binding(0) var<storage, read> u_instances:   array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:         SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices:  array<mat4x4<f32>>;
@group(2) @binding(0) var<storage, read> vertexColors:  array<vec4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32, @builtin(vertex_index) vertIdx: u32) -> VertexOutput {
  let inst  = u_instances[idx];
  let vcol  = vertexColors[vertIdx];

  let skinMat =
    in.weights.x * skinMatrices[in.joints.x] +
    in.weights.y * skinMatrices[in.joints.y] +
    in.weights.z * skinMatrices[in.joints.z] +
    in.weights.w * skinMatrices[in.joints.w];

  let skinnedPos4   = skinMat * vec4<f32>(in.position, 1.0);
  let skinnedNorm   = (skinMat * vec4<f32>(in.normal, 0.0)).xyz;
  let skinnedTanXYZ = (skinMat * vec4<f32>(in.tangent.xyz, 0.0)).xyz;

  let worldPos4   = inst.modelMatrix * skinnedPos4;
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(skinnedNorm, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;
  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(skinnedTanXYZ, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vcol;
  out.uv             = in.uv;
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  return out;
}
`;

// Fragment shaders for skinned meshes are the standard ones imported from mesh3d-shaders.ts.
// The skinned vertex shader outputs the same VertexOutput struct, so the fragments are compatible.
// Re-export them here for convenience so Pipeline3D can import everything from one place.
export {
  MESH3D_FRAGMENT_SHADER         as SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED as SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED,
} from './mesh3d-shaders';
