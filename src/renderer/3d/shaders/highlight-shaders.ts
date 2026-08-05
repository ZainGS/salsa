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

// ── Stencil-write pass ────────────────────────────────────────────
// Transforms the mesh with no normal expansion; writes nothing to color.
// The pipeline is configured with writeMask:0 and stencil replace=ref.

export const STENCIL_WRITE_SHADER = /* wgsl */`

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissiveColor: vec4<f32>,
  // padding — matches MESH_INSTANCE_STRIDE = 224 (texIndex/normIndex + 2 pad u32 + roughness/metalness/2 pattern vec4)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
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
  emissiveColor: vec4<f32>,
  // padding — matches MESH_INSTANCE_STRIDE = 224 (texIndex/normIndex + 2 pad u32 + roughness/metalness/2 pattern vec4)
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
}
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
}
struct HighlightParams {
  color:        vec4<f32>,   // base outline colour (rgb) + alpha
  patternColor: vec4<f32>,   // secondary pattern colour (rgb) + .w = glow multiplier
  params:       vec4<f32>,   // .x = outlineWidth (model space) .y = patternMode .z = freq .w = scroll speed
  screen:       vec4<f32>,   // .xy = render-target size (px) .z = time (s) .w = unused
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
  let expanded = pos + normalize(normal) * params.params.x;
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
