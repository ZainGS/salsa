/**
 * WGSL shaders for per-mesh hover/selection highlight outlines.
 *
 * Technique: two-pipeline stencil approach.
 *  1. STENCIL_WRITE_SHADER — renders the original mesh silhouette into the
 *     stencil buffer (stencil=1 for visible mesh pixels).  No color output.
 *  2. HIGHLIGHT_SHADER     — renders the expanded mesh where stencil=0
 *     (outside the original silhouette), producing a clean ring outline that
 *     works correctly for all mesh shapes including smooth closed surfaces.
 *
 * The old inverted-normals (cullMode:'front') approach is NOT used here; it
 * produced a filled disc for smooth spheres because the back-hemisphere
 * fragments overlap the projected disk and depth precision alone is not
 * reliable enough to reject them on all geometry.
 */

import { SKIN_BLEND_WGSL } from '../dual-quat-skin';
// ── Stencil-write pass ────────────────────────────────────────────
// Transforms the mesh with no normal expansion; writes nothing to color.
// The pipeline is configured with writeMask:0 and stencil replace=ref.

export const STENCIL_WRITE_SHADER = /* wgsl */`

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissive:      vec3<f32>,   // emissive rgb (floats 40-42)
  flags:         u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  // padding — matches MESH_INSTANCE_STRIDE = 240 (texIndex/normIndex + 2 pad u32 + roughness/metalness/2 pattern vec4 + uvTransform)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
  _pad4:      vec4<f32>,
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:     SceneUniforms;

@vertex fn vs_stencil(
  @location(0) pos: vec3<f32>,
  @builtin(instance_index) iIdx: u32,
) -> @builtin(position) vec4<f32> {
  let inst = instances[iIdx];
  let worldPos = inst.modelMatrix * vec4<f32>(pos, 1.0);
  return scene.viewProjection * worldPos;
}

@fragment fn fs_stencil() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}

`;

// ── Outline draw pass ─────────────────────────────────────────────
// Expands each vertex along its model-space normal, then draws only where
// stencil!=1 (outside the original mesh footprint).  cullMode:'back' so
// the front faces of the expanded shell are drawn — they sit just outside
// the original silhouette once stencil blocks the interior.

export const HIGHLIGHT_SHADER = /* wgsl */`

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissive:      vec3<f32>,   // emissive rgb (floats 40-42)
  flags:         u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  // padding — matches MESH_INSTANCE_STRIDE = 240 (texIndex/normIndex + 2 pad u32 + roughness/metalness/2 pattern vec4 + uvTransform)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
  _pad4:      vec4<f32>,
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}
struct HighlightParams {
  color:        vec4<f32>,   // base outline colour (rgb) + alpha
  patternColor: vec4<f32>,   // secondary pattern colour (rgb) + .w = glow multiplier
  params:       vec4<f32>,   // .x = outlineWidth (model space) .y = patternMode .z = freq .w = scroll speed
  screen:       vec4<f32>,   // .xy = render-target size (px) .z = time (s) .w = unused
  boil:         vec4<f32>,   // line boil: .x = wobble (0 = off) .y = wobbles per unit .z = redraws per second
}

// LINE BOIL — outline thickness scale at a model-space point: 1 ± wobble · smooth noise, re-rolled boilFps times a
// second (hand-drawn lines re-drawn each animation frame). b = (wobble, wobbleFreq, boilFps, _); wobble 0 → exactly 1.
fn boilScale(p: vec3<f32>, b: vec4<f32>, t: f32) -> f32 {
  if (b.x <= 0.0) { return 1.0; }
  let frame = floor(t * max(b.z, 0.0));
  let f = max(b.y, 0.001);
  let n = sin(dot(p, vec3<f32>(1.7, 9.2, 3.1)) * f + frame * 2.39) * sin(dot(p, vec3<f32>(8.3, 2.8, 5.6)) * f * 0.73 + frame * 1.37);
  return max(0.0, 1.0 + b.x * n);
}


@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:     SceneUniforms;
@group(1) @binding(0) var<uniform>       params:    HighlightParams;

@vertex fn vs(
  @location(0) pos:    vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) iIdx: u32,
) -> @builtin(position) vec4<f32> {
  let inst = instances[iIdx];
  let expanded = pos + normalize(normal) * (params.params.x * boilScale(pos, params.boil, params.screen.z));
  let worldPos  = inst.modelMatrix * vec4<f32>(expanded, 1.0);
  return scene.viewProjection * worldPos;
}

// Animated SCREEN-SPACE pattern (a continuous field the outline band reveals) — consistent across meshes and
// projection-agnostic (it reads @builtin(position), never a reconstructed world point). 0 = flat (no pattern).
fn hlPattern(uv: vec2<f32>, mode: i32, freq: f32, t: f32) -> f32 {
  let p = uv * freq;
  if (mode == 2) {                                    // dots (scroll along +x)
    let g = fract(p - vec2<f32>(t, 0.0)) - vec2<f32>(0.5, 0.5);
    return 1.0 - smoothstep(0.24, 0.30, length(g));
  }
  if (mode == 3) {                                    // checker
    let c = floor(p - vec2<f32>(t, 0.0));
    return fract((c.x + c.y) * 0.5) * 2.0;            // 0 or 1
  }
  return step(0.5, fract((p.x + p.y) * 0.5 - t));     // mode 1: scrolling diagonal stripes
}

@fragment fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let mode = i32(params.params.y);
  if (mode <= 0) { return params.color; }             // flat (selection / no-pattern) — unchanged behaviour
  let uv = fragCoord.xy / max(params.screen.xy, vec2<f32>(1.0, 1.0));
  let m  = hlPattern(uv, mode, params.params.z, params.screen.z * params.params.w);
  let rgb = mix(params.color.rgb, params.patternColor.rgb, m) * params.patternColor.w;   // .w = glow (>1 → catches bloom)
  return vec4<f32>(rgb, params.color.a);
}

`;

// ── SKINNED outline (armature-rigged characters) ──────────────────────────────
// Same two-pipeline stencil technique + pattern FS as above, but the vertices are SKINNED (moved by the bone
// matrices via linear-blend skinning) BEFORE the normal-expand — otherwise the outline would trace the bind pose,
// not the animated one. group 1 = the per-skeleton skinMatrices buffer (same layout the skinned mesh pipelines use);
// group 2 = the outline params (outline pass only). Vertex layout = the 72-byte skinned vertex (pos/normal/joints/weights).

export const SKINNED_STENCIL_WRITE_SHADER = /* wgsl */`

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
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,    // to MESH_INSTANCE_STRIDE = 240
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}
@group(0) @binding(0) var<storage, read> instances:    array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:        SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;
${SKIN_BLEND_WGSL}
// Diffuse texture (group 2) — sampled ONLY to alpha-test alpha-cutout meshes (hair cards / fringe) so the mask
// follows the VISIBLE silhouette, not the full card quad (else a black gap shows between the hair and its outline).
@group(2) @binding(0) var diffuseTexture: texture_2d_array<f32>;
@group(2) @binding(1) var diffuseSampler: sampler;

struct VOut {
  @builtin(position)               pos:  vec4<f32>,
  @location(0)                     uv:   vec2<f32>,
  @location(1) @interpolate(flat)  iIdx: u32,
}

@vertex fn vs_stencil(
  @location(0) pos:     vec3<f32>,
  @location(2) uv:      vec2<f32>,
  @location(4) joints:  vec4<u32>,
  @location(5) weights: vec4<f32>,
  @builtin(instance_index) iIdx: u32,
) -> VOut {
  let inst = instances[iIdx];
  let skinMat = skinMatrixFor(joints, weights);
  let worldPos = inst.modelMatrix * (skinMat * vec4<f32>(pos, 1.0));
  var o: VOut;
  o.pos  = scene.viewProjection * worldPos;
  o.uv   = uv;
  o.iIdx = iIdx;
  return o;
}

@fragment fn fs_stencil(in: VOut) -> @location(0) vec4<f32> {
  let inst = instances[in.iIdx];
  let flags = inst.flags;
  // Sample UNCONDITIONALLY (textureSample needs uniform control flow), then discard transparent alpha-cutout pixels
  // so the mask matches the color pass — the hair-card silhouette follows the visible strands, not the full quad.
  let a = textureSample(diffuseTexture, diffuseSampler, in.uv, i32(inst.textureIndex)).a;
  if ((flags & 32u) != 0u && a < 0.5) { discard; }
  return vec4<f32>(0.0);
}

`;

export const SKINNED_HIGHLIGHT_SHADER = /* wgsl */`

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissive:      vec3<f32>,   // emissive rgb (floats 40-42)
  flags:         u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  // padding to MESH_INSTANCE_STRIDE = 240 (only modelMatrix is read here)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
  _pad4:      vec4<f32>,
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}
struct HighlightParams {
  color:        vec4<f32>,
  patternColor: vec4<f32>,
  params:       vec4<f32>,   // .x = outlineWidth (model space) .y = patternMode .z = freq .w = scroll speed
  screen:       vec4<f32>,   // .xy = render-target size (px) .z = time (s)
  boil:         vec4<f32>,   // line boil: .x = wobble (0 = off) .y = wobbles per unit .z = redraws per second
}

// LINE BOIL — outline thickness scale at a model-space point: 1 ± wobble · smooth noise, re-rolled boilFps times a
// second (hand-drawn lines re-drawn each animation frame). b = (wobble, wobbleFreq, boilFps, _); wobble 0 → exactly 1.
fn boilScale(p: vec3<f32>, b: vec4<f32>, t: f32) -> f32 {
  if (b.x <= 0.0) { return 1.0; }
  let frame = floor(t * max(b.z, 0.0));
  let f = max(b.y, 0.001);
  let n = sin(dot(p, vec3<f32>(1.7, 9.2, 3.1)) * f + frame * 2.39) * sin(dot(p, vec3<f32>(8.3, 2.8, 5.6)) * f * 0.73 + frame * 1.37);
  return max(0.0, 1.0 + b.x * n);
}

@group(0) @binding(0) var<storage, read> instances:    array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:        SceneUniforms;
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4<f32>>;
${SKIN_BLEND_WGSL}
@group(2) @binding(0) var<uniform>       params:       HighlightParams;

@vertex fn vs(
  @location(0) pos:     vec3<f32>,
  @location(1) normal:  vec3<f32>,
  @location(4) joints:  vec4<u32>,
  @location(5) weights: vec4<f32>,
  @builtin(instance_index) iIdx: u32,
) -> @builtin(position) vec4<f32> {
  let inst = instances[iIdx];
  let skinMat = skinMatrixFor(joints, weights);
  let skinnedPos  = (skinMat * vec4<f32>(pos, 1.0)).xyz;
  let skinnedNorm = normalize((skinMat * vec4<f32>(normal, 0.0)).xyz);
  let expanded    = skinnedPos + skinnedNorm * (params.params.x * boilScale(pos, params.boil, params.screen.z));   // bind-pose pos → the wobble sticks to the body
  let worldPos    = inst.modelMatrix * vec4<f32>(expanded, 1.0);
  return scene.viewProjection * worldPos;
}

fn hlPattern(uv: vec2<f32>, mode: i32, freq: f32, t: f32) -> f32 {
  let p = uv * freq;
  if (mode == 2) {
    let g = fract(p - vec2<f32>(t, 0.0)) - vec2<f32>(0.5, 0.5);
    return 1.0 - smoothstep(0.24, 0.30, length(g));
  }
  if (mode == 3) {
    let c = floor(p - vec2<f32>(t, 0.0));
    return fract((c.x + c.y) * 0.5) * 2.0;
  }
  return step(0.5, fract((p.x + p.y) * 0.5 - t));
}

@fragment fn fs(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let mode = i32(params.params.y);
  if (mode <= 0) { return params.color; }
  let uv = fragCoord.xy / max(params.screen.xy, vec2<f32>(1.0, 1.0));
  let m  = hlPattern(uv, mode, params.params.z, params.screen.z * params.params.w);
  let rgb = mix(params.color.rgb, params.patternColor.rgb, m) * params.patternColor.w;
  return vec4<f32>(rgb, params.color.a);
}

`;
