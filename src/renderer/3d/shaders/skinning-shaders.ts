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

import { SKIN_BLEND_WGSL } from '../dual-quat-skin';
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
  _pad0:          vec4<f32>,   // pad to MESH_INSTANCE_STRIDE = 240 (pattern vec4s + uvTransform, unused in the VS)
  _pad1:          vec4<f32>,
  _pad2:          vec4<f32>,
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
  // These trailing fields are declared so skinRampParams lands at its buffer offset (floats 204-207). The skinned
  // VS doesn't use lightCounts / pointLights, but WGSL has no @offset, so the preceding layout must be present.
  lightCounts:      vec4<f32>,
  pointLights:      array<vec4<f32>, 32>,
  skinRampParams:   vec4<f32>,   // skin toon-ramp: .x=bands .y=softness .z=shadowFloor .w=tint rgb packed 8:8:8
  styleParams:      vec4<f32>,   // render-style knobs: .x = Sketch paper amount
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
  // Perspective-free UV for PS1 affine warp. Must match the textured fragment
  // (MESH3D_FRAGMENT_SHADER) which reads location 7.
  @location(7) @interpolate(linear) uvAffine: vec2<f32>,
  // Must mirror the shared mesh3d fragment shader's @location(8) input. Skinned meshes never carry the foliage
  // AO ramp (bit 20 is a static-mesh feature), so it is always 0 here — but the field MUST be emitted, or the
  // FS input at location 8 has no corresponding vertex output (a CreateRenderPipeline validation warning).
  @location(8) foliageY: f32,
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

// SKIN TOON-RAMP (bit 29). Quantise the (already soft-lit) NdotL into bands with a soft terminator, lift the
// darkest band to a tone, and warm-tint the shadow. Returns .rgb = shadow-tint multiplier, .a = ramped NdotL.
// When the flag is off it is an exact no-op (tint = white, ndl unchanged). VS-only, so a branch is fine (no
// derivatives / uniformity constraints). MUST stay identical to the copy in mesh3d-shaders.ts.
fn skinRamp(ndl: f32, flags: u32, p: vec4<f32>) -> vec4<f32> {
  if ((flags & 536870912u) == 0u) { return vec4<f32>(1.0, 1.0, 1.0, ndl); }
  let bands = max(p.x, 1.0);
  let soft  = max(p.y, 0.001);
  let stepped = floor(ndl * bands) / bands;
  let edge    = fract(ndl * bands);
  let s       = smoothstep(0.5 - soft, 0.5 + soft, edge);
  let v       = clamp(mix(stepped, stepped + 1.0 / bands, s), 0.0, 1.0);
  let ramped  = p.z + (1.0 - p.z) * v;
  let tr = floor(p.w / 65536.0);
  let tg = floor((p.w - tr * 65536.0) / 256.0);
  let tb = p.w - tr * 65536.0 - tg * 256.0;
  let tint = mix(vec3<f32>(tr, tg, tb) / 255.0, vec3<f32>(1.0), ramped);
  return vec4<f32>(tint, ramped);
}
`;

// ── Shared vertex body (inserted after skinning math) ──────────────────────

const SKINNED_VS_BODY = /* wgsl */`
  let inst = u_instances[idx];

  // Linear Blend Skinning: blend 4 joint matrices
  let skinMat = skinMatrixFor(in.joints, in.weights);

  let skinnedPos4   = skinMat * vec4<f32>(in.position, 1.0);
  let skinnedNorm   = (skinMat * vec4<f32>(in.normal, 0.0)).xyz;
  let skinnedTanXYZ = (skinMat * vec4<f32>(in.tangent.xyz, 0.0)).xyz;

  let worldPos4   = inst.modelMatrix * skinnedPos4;
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(skinnedNorm, 0.0)).xyz);

  // FACE KIT depth pull (flags2 bit 6, amount = normalMatrix column 3 .z in local units, scaled by the skin + model
  // matrix): slide the vertex toward the eye along its own view ray, so the screen position is unchanged but the depth
  // is nearer, and the brow overlay draws through the hair fringe just in front of it. Ortho = the constant forward.
  var clipSrc = worldPos4;
  if ((u32(inst.normalMatrix[3].x) & 64u) != 0u) {
    let pullScale = length((skinMat * vec4<f32>(1.0, 0.0, 0.0, 0.0)).xyz) * length(inst.modelMatrix[0].xyz);
    let toEye = select(normalize(scene.cameraPosition.xyz - worldPos4.xyz), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
    clipSrc = vec4<f32>(worldPos4.xyz + toEye * (inst.normalMatrix[3].z * pullScale), 1.0);
  }
  var clipPos = scene.viewProjection * clipSrc;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting
  var lit = inst.diffuseColor.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  // SOFT LIGHTING (bit 28): wrap the diffuse toward half-Lambert (away-side lifts to mid, no hard dark triangle on a
  // face) by scene.lightColor.w — flat anime skin. select() keeps it a no-op (exact Lambert) when the flag is off.
  let softS = select(0.0, scene.lightColor.w, (bitcast<u32>(inst.emissiveColor.a) & 268435456u) != 0u);
  let rawNdL = dot(worldNormal, L);
  let softNdL = mix(max(rawNdL, 0.0), rawNdL * 0.5 + 0.5, softS);
  // SKIN TOON-RAMP (bit 29): band the diffuse + warm the shadow (no-op when the flag is off). Applied AFTER soft.
  let ramp = skinRamp(softNdL, bitcast<u32>(inst.emissiveColor.a), scene.skinRampParams);
  lit += inst.diffuseColor.rgb * ramp.rgb * scene.lightColor.rgb * scene.lightDirection.w * ramp.a;
  let V = normalize(scene.cameraPosition.xyz - worldPos4.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;
  let colorDepth = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (bitcast<u32>(inst.emissiveColor.a) & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  // TBN
  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(skinnedTanXYZ, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv             = in.uv;
  out.uvAffine       = in.uv;   // perspective-free copy for PS1 affine warp
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  out.foliageY       = 0.0;   // no foliage AO ramp on skinned meshes; emit 0 to satisfy the FS location-8 input
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
${SKIN_BLEND_WGSL}

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
${SKIN_BLEND_WGSL}

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
${SKIN_BLEND_WGSL}
@group(2) @binding(0) var<storage, read> vertexColors:  array<vec4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32, @builtin(vertex_index) vertIdx: u32) -> VertexOutput {
  let inst  = u_instances[idx];
  let vcol  = vertexColors[vertIdx];

  let skinMat = skinMatrixFor(in.joints, in.weights);

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
  let colorDepth = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (bitcast<u32>(inst.emissiveColor.a) & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(skinnedTanXYZ, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), vcol.a);
  out.uv             = in.uv;
  out.uvAffine       = in.uv;   // perspective-free copy for PS1 affine warp
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  out.foliageY       = 0.0;   // no foliage AO ramp on skinned meshes; emit 0 to satisfy the FS location-8 input
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
${SKIN_BLEND_WGSL}
@group(2) @binding(0) var<storage, read> vertexColors:  array<vec4<f32>>;

@vertex
fn vs_main(in: SkinnedVertexInput, @builtin(instance_index) idx: u32, @builtin(vertex_index) vertIdx: u32) -> VertexOutput {
  let inst  = u_instances[idx];
  let vcol  = vertexColors[vertIdx];

  let skinMat = skinMatrixFor(in.joints, in.weights);

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
  out.uvAffine       = in.uv;   // perspective-free copy for PS1 affine warp
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  out.foliageY       = 0.0;   // no foliage AO ramp on skinned meshes; emit 0 to satisfy the FS location-8 input
  return out;
}
`;

// Fragment shaders for skinned meshes are the standard ones imported from mesh3d-shaders.ts.
// The skinned vertex shader outputs the same VertexOutput struct, so the fragments are compatible.
// Re-export them here for convenience so Pipeline3D can import everything from one place.
export {
  MESH3D_FRAGMENT_SHADER               as SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED    as SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED,
  // §3.1 plain (pattern-stripped) variants — characters have no patterns, so their pipelines use these.
  MESH3D_FRAGMENT_SHADER_PLAIN            as SKINNED_MESH3D_FRAGMENT_SHADER_TEXTURED_PLAIN,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN as SKINNED_MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN,
} from './mesh3d-shaders';

// Dedicated fragment shader for weight paint pipelines.
// The vertex shader computes the heat color (Gouraud-lit or unlit) and puts it in out.color.
// This shader outputs it as-is, bypassing all render-style / PBR logic that would otherwise
// replace it with the mesh material's diffuse color.
export const SKINNED_MESH3D_FRAGMENT_SHADER_WEIGHT_PAINT = /* wgsl */`
@fragment
fn fs_main(
  @builtin(position)              fragPos:     vec4<f32>,
  @location(0)                    heatColor:   vec4<f32>,
  @location(1)                    uv:          vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3)                    worldPos:    vec3<f32>,
  @location(4)                    worldNormal: vec3<f32>,
) -> @location(0) vec4<f32> {
  return heatColor;
}
`;
