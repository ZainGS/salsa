/**
 * WGSL shaders for 3D mesh rendering — Cook-Torrance PBR + SH-based IBL.
 *
 * Lighting model (renderStyle == 0 "default"):
 *  - Cook-Torrance BRDF: GGX NDF + Smith geometry + Schlick Fresnel
 *  - Direct: single directional light (scene.lightDirection / lightColor)
 *  - Ambient (IBL off): constant ambient from scene.ambientColor
 *  - Ambient (IBL on):  SH L0+L1+L2 irradiance from ibl.shCoeffs (9 vec4<f32>)
 *
 * Render styles (bits 2-3 of material flags — see material-3d.ts):
 *  0 = default   Cook-Torrance PBR (replaces Phong/Gouraud)
 *  1 = cel       toon shading (stepped diffuse bands + hard specular)
 *  2 = sketch    crosshatch shading (pencil-drawn look)
 *  3 = ink       flat + silhouette rim darkening (manga look)
 *
 * Vertex format: position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4) = 48 bytes
 *
 * Uniform layout:
 *  Bind group 0, binding 0: per-mesh instance storage buffer (model matrix, material, roughness, metalness)
 *  Bind group 0, binding 1: scene-wide uniform buffer (viewProj, camera, lights, PS1 params)
 *  Bind group 0, binding 2: IBL uniform buffer (SH coefficients, iblEnabled, iblIntensity)
 *  Bind group 1, binding 0: diffuse texture
 *  Bind group 1, binding 1: diffuse sampler
 *  Bind group 1, binding 2: normal map texture  (flat-normal 1×1 default when not set)
 *  Bind group 1, binding 3: normal map sampler
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';

// ── Shared PBR + IBL WGSL (included in both fragment shader variants) ──────

const PBR_IBL_WGSL = /* wgsl */`

struct IBLUniforms {
  shCoeffs:    array<vec4<f32>, 9>,  // L0+L1+L2 SH irradiance coefficients (rgb, w unused)
  iblEnabled:  f32,                  // 0 = off (use scene.ambientColor), 1 = on
  iblIntensity:f32,                  // scale multiplier
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(2) var<uniform> ibl: IBLUniforms;

const PBR_PI: f32 = 3.14159265359;

// GGX (Trowbridge-Reitz) normal distribution function
fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
  let a  = roughness * roughness;
  let a2 = a * a;
  let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PBR_PI * d * d);
}

// Smith-Schlick-GGX geometry term (one lobe)
fn G_SchlickGGX(NdotX: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  return NdotX / (NdotX * (1.0 - k) + k);
}

// Smith combined geometry (both view and light lobes)
fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return G_SchlickGGX(max(NdotV, 0.0001), roughness) *
         G_SchlickGGX(max(NdotL, 0.0001), roughness);
}

// Schlick Fresnel approximation
fn F_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

// Evaluate L0+L1+L2 SH irradiance.  Coefficients must be pre-multiplied by the
// Ramamoorthi & Hanrahan (2001) cosine-lobe ZH factors (baked CPU-side).
fn evalSHIrradiance(N: vec3<f32>) -> vec3<f32> {
  let x = N.x; let y = N.y; let z = N.z;
  // Normalization constants: Y00=0.2821, Y1x=0.4886, Y2-2/Y2-1/Y21=1.0925, Y20=0.3154, Y22=0.5463
  var e: vec3<f32> =
      0.282095 * ibl.shCoeffs[0].rgb
    + 0.488603 * (ibl.shCoeffs[1].rgb * y + ibl.shCoeffs[2].rgb * z + ibl.shCoeffs[3].rgb * x)
    + 1.092548 * (ibl.shCoeffs[4].rgb * (x*y) + ibl.shCoeffs[5].rgb * (y*z) + ibl.shCoeffs[7].rgb * (x*z))
    + 0.315392 *  ibl.shCoeffs[6].rgb * (3.0*z*z - 1.0)
    + 0.546274 *  ibl.shCoeffs[8].rgb * (x*x - y*y);
  return max(e, vec3<f32>(0.0));
}
`;

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
  roughness:      f32,            //  4 bytes  PBR roughness (0 = mirror, 1 = rough)
  metalness:      f32,            //  4 bytes  PBR metalness (0 = dielectric, 1 = metal)
                                  //  total 192 bytes
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
  resolution:       vec4<f32>,          // 16 bytes  (.xy = render target size in pixels)
  lightSpaceMatrix: mat4x4<f32>,        // 64 bytes  (floats 40-55)
  shadowParams:     vec4<f32>,          // 16 bytes  (floats 56-59)
  fogColor:         vec4<f32>,          // 16 bytes  (floats 60-63, .rgb = fog color)
  fogParams:        vec4<f32>,          // 16 bytes  (floats 64-67, .x=near .y=far .z=density .w=mode)
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
${PBR_IBL_WGSL}

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

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
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
  let renderStyle  = (flags >> 2u) & 3u;

  let L = normalize(-scene.lightDirection.xyz);
  let V = normalize(scene.cameraPosition.xyz - worldPos);

  // Sample textures unconditionally — textureSample requires uniform control flow.
  let texSample    = textureSample(diffuseTexture,   diffuseSampler,   uv, i32(inst.textureIndex));
  let normalSample = textureSample(normalMapTexture, normalMapSampler, uv, i32(inst.normalMapIndex));

  // Resolve surface normal
  var N = normalize(worldNormal);
  if (hasNormalMap) {
    let mapN = normalSample.xyz * 2.0 - 1.0;
    N = normalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
  }

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
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(inst.roughness, 0.04);
    let metalness = inst.metalness;
    let albedo    = inst.diffuseColor.rgb;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

    let D  = D_GGX(NdotH, roughness);
    let G  = G_Smith(NdotV, NdotL, roughness);
    let F  = F_Schlick(HdotV, F0);
    let kD = (1.0 - F) * (1.0 - metalness);
    let specularBRDF = D * G * F / max(4.0 * NdotV * NdotL, 0.0001);
    let directLight  = (kD * albedo / PBR_PI + specularBRDF)
                     * scene.lightColor.rgb * scene.lightDirection.w * NdotL;

    var ambient: vec3<f32>;
    if (ibl.iblEnabled > 0.5) {
      ambient = evalSHIrradiance(N) * albedo * (1.0 - metalness) * ibl.iblIntensity;
    } else {
      ambient = scene.ambientColor.rgb * scene.ambientColor.a * albedo;
    }

    var total = directLight + ambient + inst.emissiveColor.rgb;
    let cd = scene.ps1Config.w;
    if (cd > 0.0) { total = quantizeColor(total, cd); }
    lit = total;
  }

  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);

  if (hasTexture) {
    if (renderStyle == 2u) {
      finalColor = vec4<f32>(mix(finalColor.rgb, finalColor.rgb * texSample.rgb, 0.5), finalColor.a * texSample.a);
    } else {
      finalColor = vec4<f32>(finalColor.rgb * texSample.rgb, finalColor.a * texSample.a);
    }
  }

  if (finalColor.a < 0.01) { discard; }
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
//  VERTEX SHADER — vertex color (slot 1 float32x4 per-vertex color)
// ═══════════════════════════════════════════════════════════════════

/**
 * Vertex shader variant for EditMesh vertex-painted geometry.
 * Identical to MESH3D_VERTEX_SHADER except it reads a per-vertex RGBA color
 * from @location(4) (a second vertex buffer slot, stride 16) and uses it
 * in place of inst.diffuseColor.rgb for Gouraud lighting.
 * Fragment shader: reuse MESH3D_FRAGMENT_SHADER_UNTEXTURED unchanged.
 */
export const MESH3D_VERTEX_SHADER_VERTEX_COLOR = /* wgsl */ `

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

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position:    vec3<f32>,
  @location(1) normal:      vec3<f32>,
  @location(2) uv:          vec2<f32>,
  @location(3) tangent:     vec4<f32>,
  @location(4) vertexColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:      vec4<f32>,
  @location(1) uv:         vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:       vec3<f32>,
  @location(4) worldNormal:    vec3<f32>,
  @location(5) worldTangent:   vec3<f32>,
  @location(6) worldBitangent: vec3<f32>,
};

fn vc_snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  snapped.x = round(pos.x / w * gridSize) / gridSize * w;
  snapped.y = round(pos.y / w * gridSize) / gridSize * w;
  return snapped;
}

fn vc_quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  let worldPos4   = inst.modelMatrix * vec4<f32>(in.position, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = vc_snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting — use per-vertex color instead of instance diffuse color
  let vcol = in.vertexColor;
  var lit = vcol.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += vcol.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let V = normalize(scene.cameraPosition.xyz - worldPos4.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;
  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = vc_quantizeColor(lit, colorDepth); }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
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

// ═══════════════════════════════════════════════════════════════════
//  UNTEXTURED FRAGMENT SHADER — Gouraud/style, no texture group needed
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED = /* wgsl */`

${STYLE_WGSL_FUNCTIONS}
${PBR_IBL_WGSL}

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

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

fn quantizeColorUntex(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@fragment
fn fs_main(
  @location(0) gouraudColor: vec4<f32>,
  @location(1) uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:     vec3<f32>,
  @location(4) worldNormal:  vec3<f32>,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = bitcast<u32>(inst.emissiveColor.a);
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
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(inst.roughness, 0.04);
    let metalness = inst.metalness;
    let albedo    = inst.diffuseColor.rgb;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

    let D  = D_GGX(NdotH, roughness);
    let G  = G_Smith(NdotV, NdotL, roughness);
    let F  = F_Schlick(HdotV, F0);
    let kD = (1.0 - F) * (1.0 - metalness);
    let specularBRDF = D * G * F / max(4.0 * NdotV * NdotL, 0.0001);
    let directLight  = (kD * albedo / PBR_PI + specularBRDF)
                     * scene.lightColor.rgb * scene.lightDirection.w * NdotL;

    var ambient: vec3<f32>;
    if (ibl.iblEnabled > 0.5) {
      ambient = evalSHIrradiance(N) * albedo * (1.0 - metalness) * ibl.iblIntensity;
    } else {
      ambient = scene.ambientColor.rgb * scene.ambientColor.a * albedo;
    }

    var total = directLight + ambient + inst.emissiveColor.rgb;
    let cd = scene.ps1Config.w;
    if (cd > 0.0) { total = quantizeColorUntex(total, cd); }
    lit = total;
  }

  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  if (finalColor.a < 0.01) { discard; }
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
