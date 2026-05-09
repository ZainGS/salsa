/**
 * WGSL shaders for transform gizmo rendering.
 *
 * Flat-color, no lighting, always-on-top (depth compare = always).
 * Vertex format: position(vec3) + color(vec4) = 28 bytes.
 * Uniforms: viewProjection(mat4) + modelMatrix(mat4) = 128 bytes.
 */

export const GIZMO_VERTEX_SHADER = /* wgsl */ `

struct GizmoUniforms {
  viewProjection: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> u: GizmoUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let worldPos = u.modelMatrix * vec4<f32>(in.position, 1.0);
  out.clipPos = u.viewProjection * worldPos;
  out.color = in.color;
  return out;
}
`;

export const GIZMO_FRAGMENT_SHADER = /* wgsl */ `

@fragment
fn fs_main(
  @location(0) color: vec4<f32>,
) -> @location(0) vec4<f32> {
  if (color.a < 0.01) { discard; }
  return color;
}
`;

/** Vertex stride for gizmo geometry: position(12) + color(16) = 28 bytes. */
export const GIZMO_VERTEX_STRIDE = 28;
/** Size of GizmoUniforms in bytes: 2 × mat4 = 128 bytes. */
export const GIZMO_UNIFORM_SIZE = 128;
