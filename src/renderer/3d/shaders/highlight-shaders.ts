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
  color:        vec4<f32>,
  outlineWidth: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
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
  let expanded = pos + normalize(normal) * params.outlineWidth;
  let worldPos  = inst.modelMatrix * vec4<f32>(expanded, 1.0);
  return scene.viewProjection * worldPos;
}

@fragment fn fs() -> @location(0) vec4<f32> {
  return params.color;
}

`;
