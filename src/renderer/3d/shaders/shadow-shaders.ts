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

import { SKIN_BLEND_WGSL } from '../dual-quat-skin';
import { FOLIAGE_WIND_WGSL, LEAF_CARD_WGSL, FOG_FADE_WGSL } from './mesh3d-shaders';

// ── Extended SceneUniforms (shared by all shadow shaders) ─────────────
// Extended THROUGH lightCounts so the depth pass can read scene TIME (ps1Config2.z) + the scene WIND
// (lightCounts.yzw) — the shadow of a swaying plant must sway with it (foliage-quality S1).
// Fog horizon (2026-10-01): extended through fogEye (floats 268-271) so the fog of the legacy shadow FS below is
// measured from the fog eye and the depth pass can dissolve fading casters with the fog-horizon band (the same rule
// as the colour pass, measured from the camera). Every field up to it is declared because WGSL has no @offset.
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
  ps1Config2:      vec4<f32>,     // 16 bytes  (floats 68-71, .z = scene time seconds)
  lightCounts:     vec4<f32>,     // 16 bytes  (floats 72-75, .y=windDirRad .z=windStrength .w=windSpeed)
  pointLights:     array<vec4<f32>, 32>,     // floats 76-203 (unread here)
  skinRampParams:  vec4<f32>,     // floats 204-207 (unread here)
  styleParams:     vec4<f32>,     // floats 208-211 (unread here)
  toonParams:      vec4<f32>,     // floats 212-215, .w = the fog-horizon flag bits
  rimParams:       vec4<f32>,     // floats 216-219 (unread here)
  heightFog:       vec4<f32>,     // floats 220-223 (unread here)
  cascadeMatrices: array<mat4x4<f32>, 2>,    // floats 224-255 (unread here)
  cascadeParams:   vec4<f32>,     // floats 256-259 (unread here)
  cascadeBias:     vec4<f32>,     // floats 260-263 (unread here)
  aerialParams:    vec4<f32>,     // floats 264-267 (unread here)
  fogEye:          vec4<f32>,     // floats 268-271, .xyz = the fog eye, .w = the fog-horizon fade band width
};
`;

// ── MeshInstance (shared) ─────────────────────────────────────────────
const MESH_INSTANCE_WGSL = /* wgsl */`
struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,   // foliage wind repurposes patternParams.xyz
  patternParams:  vec4<f32>,   //   = (windHeight, windStiffness, windAmount, packedTranslucencyColor)
  uvTransform:    vec4<f32>,   // to MESH_INSTANCE_STRIDE = 240 (unused in shadow VS; keeps the stride aligned)
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

${FOLIAGE_WIND_WGSL}
${LEAF_CARD_WGSL}
${FOG_FADE_WGSL}

struct ShadowOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) idx: u32,
  @location(2) wpos: vec3<f32>,   // fog horizon P2: the fade band is measured in world space from the fog eye
};

@vertex
fn vs_shadow(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @builtin(instance_index) idx: u32,
) -> ShadowOut {
  let inst = u_instances[idx];
  // FOLIAGE WIND (bit 19) — the depth pass applies the SAME displacement as the colour pass, so the cast
  // shadow sways with the plant instead of staying pinned (foliage-quality S1).
  var localPos = position;
  if ((inst.flags & 524288u) != 0u) {
    let originW = vec3<f32>(inst.modelMatrix[3].x, inst.modelMatrix[3].y, inst.modelMatrix[3].z);
    localPos = localPos + foliageWindOffset(position, originW,
      inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }
  let worldPos = inst.modelMatrix * vec4<f32>(localPos, 1.0);
  var out: ShadowOut;
  out.pos = scene.lightSpaceMatrix * worldPos;
  out.uv = uv;
  out.idx = idx;
  out.wpos = worldPos.xyz;
  return out;
}

// LEAF-CARD CUT-OUT (bit 13) — the depth pass honours the SAME silhouette as the colour pass, so a leaf card
// shadows as its leaves instead of as a full square (polish-round-3 T4). Every other mesh writes depth untouched.
@fragment
fn fs_shadow(in: ShadowOut) {
  let flags = u_instances[in.idx].flags;
  if ((flags & 8192u) != 0u) {
    if (leafCardCoverage(in.uv) < 0.5) { discard; }
  }
  // FOG HORIZON FADE BAND (P2): the caster dissolves with the SAME coverage as its colour pass (measured from the
  // fog eye, not the light), dithered in shadow-map texels, so the PCF-filtered shadow fades with its object.
  let fhFlags = u32(scene.toonParams.w);
  if ((fhFlags & 2u) != 0u && fhFades(u32(u_instances[in.idx].normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    if (!fhDitherKeep(fhCoverage(length(scene.fogEye.xyz - in.wpos), fhEdge, scene.fogEye.w), in.pos.xy, (fhFlags & 4u) != 0u)) { discard; }
  }
  // HLOD CROSS-FADE (performance-plan P17; flags2 bit 5): the caster dissolves with its colour pass's coverage
  // (normalMatrix column 3 .y), dithered in shadow-map texels, so a tier swap's shadow fades instead of popping.
  // A fading caster is drawn in the dynamic list (Renderer3D._casterIsDynamic), never baked into the static cache.
  if ((u32(u_instances[in.idx].normalMatrix[3].x) & 32u) != 0u && !fhDitherKeep(u_instances[in.idx].normalMatrix[3].y, in.pos.xy, false)) { discard; }
}
`;

// ═══════════════════════════════════════════════════════════════════
//  SKINNED SHADOW PASS — depth-only, skin-deformed (E1 tail c: characters CAST shadows)
// ═══════════════════════════════════════════════════════════════════
// Same skinning math as skinning-shaders vs_main (weights x joint matrices); the skinned instance
// buffer's modelMatrix is identity for skeleton-driven meshes, kept for parity with the colour path.
// Layout matches the UNTEXTURED skinned convention: [meshBGL(0) → instances+scene, skinBGL(1)].

export const SKINNED_SHADOW_VERTEX_SHADER = /* wgsl */ `
${MESH_INSTANCE_WGSL}

@group(0) @binding(0) var<storage, read> u_instances: array<MeshInstance>;

${SCENE_UNIFORMS_SHADOW_WGSL}

@group(0) @binding(1) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;
${SKIN_BLEND_WGSL}
${FOG_FADE_WGSL}

struct SkShadowOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) idx: u32,
  @location(1) wpos: vec3<f32>,   // fog horizon: the fade band is measured in world space from the fog eye
};

@vertex
fn vs_shadow(
  @location(0) position: vec3<f32>,
  @location(4) joints:   vec4<u32>,
  @location(5) weights:  vec4<f32>,
  @builtin(instance_index) idx: u32,
) -> SkShadowOut {
  let inst = u_instances[idx];
  let skinMat = skinMatrixFor(joints, weights);
  let worldPos = inst.modelMatrix * (skinMat * vec4<f32>(position, 1.0));
  var out: SkShadowOut;
  out.pos = scene.lightSpaceMatrix * worldPos;
  out.idx = idx;
  out.wpos = worldPos.xyz;
  return out;
}

// FOG HORIZON FADE BAND (2026-10-01, skinned characters): the same dissolve as fs_shadow above, so a character's
// shadow fades with it. The skinned upload sets the flags2 fade bit only while the band is live; otherwise nothing is
// discarded and the depth is the vertex shader's (identical to the old depth-only pipeline).
@fragment
fn fs_skshadow(in: SkShadowOut) {
  let fhFlags = u32(scene.toonParams.w);
  if ((fhFlags & 2u) != 0u && fhFades(u32(u_instances[in.idx].normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    if (!fhDitherKeep(fhCoverage(length(scene.fogEye.xyz - in.wpos), fhEdge, scene.fogEye.w), in.pos.xy, (fhFlags & 4u) != 0u)) { discard; }
  }
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
    // Jitter 0..1 = how far each vertex is pulled onto the Snap Grid (1 = fully snapped, the classic PS1 wobble);
    // past 1 the grid itself coarsens (2 = half the Snap Grid resolution).
    clipPos = mix(clipPos, snapToGrid(clipPos, gridSize / max(jitter, 1.0)), min(jitter, 1.0));
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
  lit += inst.emissive;

  let colorDepth = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (inst.flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
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
  let flags = inst.flags;

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
  // Material3D.noFog (flags2 bits 2 / 3; bit 3 only under Hard edge = scene flag bit 4): no fog.
  let nfF2 = u32(inst.normalMatrix[3].x);
  let noFogM = (nfF2 & 4u) != 0u || ((nfF2 & 8u) != 0u && (u32(scene.toonParams.w) & 16u) != 0u);
  if (fogMode != 0u && !noFogM) {
    let fogDist = length(scene.fogEye.xyz - worldPos);   // fog-horizon: the fog eye (perspective = the camera)
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
    let fogDist = length(scene.fogEye.xyz - worldPos);   // fog-horizon: the fog eye (perspective = the camera)
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
