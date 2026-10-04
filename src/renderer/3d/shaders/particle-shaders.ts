/**
 * Billboard particle shaders for ParticleEmitter3D.
 *
 * No vertex buffer — the vertex shader generates a camera-facing quad
 * procedurally from builtin(vertex_index) and builtin(instance_index).
 *
 * Bind group 0, binding 0: particle storage buffer (array<ParticleInstance>)
 * Bind group 0, binding 1: particle scene uniforms (viewProj + camera axes)
 * Bind group 1, binding 0: texture_2d_array (shared atlas, same layout as mesh textured BGL)
 * Bind group 1, binding 1: sampler
 */

export const PARTICLE_VERTEX_SHADER = /* wgsl */ `

// Compact particle data — 48 bytes (3 vec4s)
struct ParticleInstance {
  posSize: vec4<f32>,   // .xyz = world position, .w = size
  color:   vec4<f32>,   // rgba
  texInfo: vec4<u32>,   // .x = textureIndex, .yzw = pad
};

struct ParticleSceneUniforms {
  viewProjection: mat4x4<f32>,  // 64 bytes
  cameraRight:    vec4<f32>,    // 16 bytes (.xyz = world-space right)
  cameraUp:       vec4<f32>,    // 16 bytes (.xyz = world-space up)
};

@group(0) @binding(0) var<storage, read> particles: array<ParticleInstance>;
@group(0) @binding(1) var<uniform> scene: ParticleSceneUniforms;

// Six vertices forming two triangles (CCW front face)
const QUAD_XY = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>(-0.5,  0.5),
  vec2<f32>(-0.5,  0.5),
  vec2<f32>( 0.5, -0.5),
  vec2<f32>( 0.5,  0.5),
);

const QUAD_UV = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(1.0, 0.0),
);

struct VertexOut {
  @builtin(position)              clipPos:  vec4<f32>,
  @location(0)                    uv:       vec2<f32>,
  @location(1)                    color:    vec4<f32>,
  @location(2) @interpolate(flat) texIndex: u32,
  // Procedural shape mode (Play landing dust, 2026-10-04): x = shape (0 = the textured quad, 1 = cel puff,
  // 2 = droplet), y = dissolve 0..1000, z = per-particle seed. Ordinary emitters pad these with zeros.
  @location(3) @interpolate(flat) shape:    vec4<u32>,
};

@vertex
fn vs_particle(
  @builtin(vertex_index)   vi: u32,
  @builtin(instance_index) ii: u32,
) -> VertexOut {
  let p      = particles[ii];
  let corner = QUAD_XY[vi];
  let right  = scene.cameraRight.xyz;
  let up     = scene.cameraUp.xyz;
  let size   = p.posSize.w;

  // Expand billboard in world space along camera axes
  let worldPos = p.posSize.xyz
    + right * corner.x * size
    + up    * corner.y * size;

  var out: VertexOut;
  out.clipPos  = scene.viewProjection * vec4<f32>(worldPos, 1.0);
  out.uv       = QUAD_UV[vi];
  out.color    = p.color;
  out.texIndex = p.texInfo.x;
  out.shape    = vec4<u32>(p.texInfo.y, p.texInfo.z, p.texInfo.w, 0u);
  return out;
}
`;

export const PARTICLE_FRAGMENT_SHADER = /* wgsl */ `

@group(1) @binding(0) var particleTex:     texture_2d_array<f32>;
@group(1) @binding(1) var particleSampler: sampler;

@fragment
fn fs_particle(
  @location(0)                    uv:       vec2<f32>,
  @location(1)                    color:    vec4<f32>,
  @location(2) @interpolate(flat) texIndex: u32,
  @location(3) @interpolate(flat) shape:    vec4<u32>,
) -> @location(0) vec4<f32> {
  // Unconditional sample (uniform control flow requirement)
  let texColor = textureSample(particleTex, particleSampler, uv, i32(texIndex));
  var finalColor = color * texColor;
  if (shape.x != 0u) {
    // Procedural anime dust: a hard-edged puff with a lumpy outline and a two-tone shade band, eroded by a
    // noisy dissolve edge as it ages (instead of an alpha fade). Shape 2 = a small hard droplet with a highlight.
    let p = uv * 2.0 - vec2<f32>(1.0, 1.0);
    let d = length(p);
    let s = f32(shape.z) * 0.0137;
    let dis = f32(shape.y) * 0.001;
    if (shape.x == 2u) {
      let a = 1.0 - smoothstep(0.78, 0.9, d);
      let hl = 1.0 - smoothstep(0.0, 0.32, length(p - vec2<f32>(-0.3, -0.32)));
      finalColor = vec4<f32>(mix(color.rgb, vec3<f32>(1.0, 1.0, 1.0), 0.55 * hl), color.a * a);
    } else {
      let ang = atan2(p.y, p.x);
      let lump = 0.07 * sin(ang * 3.0 + s) + 0.045 * sin(ang * 5.0 + s * 1.7) + 0.03 * sin(ang * 8.0 + s * 2.9);
      let n = 0.5 + 0.5 * sin(p.x * 6.3 + s * 3.1) * sin(p.y * 5.7 - s * 1.3);
      let edge = 0.84 + lump - dis * (0.75 + 0.45 * n);
      let a = 1.0 - smoothstep(edge - 0.05, edge, d);
      // Light from above: the lower part of each puff takes the shade tone; a soft rim lightens the top edge.
      let band = smoothstep(0.12, 0.2, p.y + 0.18 * p.x + 0.1 * sin(ang * 2.0 + s));
      let rim = smoothstep(edge - 0.2, edge - 0.05, d) * (1.0 - band);
      let rgb = color.rgb * mix(1.0, 0.74, band) + vec3<f32>(0.06, 0.06, 0.06) * rim;
      finalColor = vec4<f32>(rgb, color.a * a);
    }
  }
  if (finalColor.a < 0.01) { discard; }
  return finalColor;
}
`;

/** Byte size of ParticleSceneUniforms (viewProj 64 + right 16 + up 16 = 96). */
export const PARTICLE_SCENE_UNIFORM_SIZE = 96;

/** Byte stride of one ParticleInstance in the storage buffer (48 bytes). */
export const PARTICLE_INSTANCE_STRIDE = 48;
