/**
 * WGSL shaders for the bloom post-processing pass.
 *
 * Pipeline:
 *   1. Capture — re-render particles into rgba16float bloom source (additive blend).
 *      Reuses PARTICLE_VERTEX_SHADER; fragment writes raw particle color.
 *   2. H-blur — 9-tap separable Gaussian, horizontal.
 *   3. V-blur — 9-tap separable Gaussian, vertical.
 *   4. Composite — fullscreen additive blend: threshold + intensity applied here.
 */

// ── Bloom capture fragment ─────────────────────────────────────────────────
// Matches the VertexOut locations emitted by PARTICLE_VERTEX_SHADER.
// Renders into rgba16float bloom source texture (no threshold — composite handles it).

export const BLOOM_CAPTURE_FS = /* wgsl */`
@group(1) @binding(0) var particleTex:     texture_2d_array<f32>;
@group(1) @binding(1) var particleSampler: sampler;

@fragment fn fs_bloom_capture(
  @location(0)                    uv:       vec2<f32>,
  @location(1)                    color:    vec4<f32>,
  @location(2) @interpolate(flat) texIndex: u32,
) -> @location(0) vec4<f32> {
  let texColor = textureSample(particleTex, particleSampler, uv, i32(texIndex));
  var c = color * texColor;
  if (c.a < 0.01) { discard; }
  return c;
}
`;

// ── Fullscreen vertex shader ───────────────────────────────────────────────
// Used by blur and composite passes.

export const BLOOM_FULLSCREEN_VS = /* wgsl */`
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@vertex fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> VsOut {
  const positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let xy = positions[vi];
  // NDC → UV: flip Y so (1,-1)→(1,1) maps to (1,1)→(1,0)
  let uv = xy * vec2f(0.5, -0.5) + 0.5;
  return VsOut(vec4f(xy, 0.0, 1.0), uv);
}
`;

// ── Blur fragment (shared for H and V passes) ──────────────────────────────
// @group(0) binding 0: source texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: vec2f step — (1/w,0) horizontal, (0,1/h) vertical

export const BLOOM_BLUR_FS = /* wgsl */`
@group(0) @binding(0) var tex:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> blurStep: vec2f;

// 9-tap Gaussian (σ ≈ 2): centre + 4 symmetric pairs
const W = array<f32, 5>(0.227027, 0.194595, 0.121621, 0.054054, 0.016216);

@fragment fn fs_blur(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSample(tex, samp, uv) * W[0];
  for (var i = 1; i < 5; i++) {
    let off = blurStep * f32(i);
    c += textureSample(tex, samp, uv + off) * W[i];
    c += textureSample(tex, samp, uv - off) * W[i];
  }
  return c;
}
`;

// ── Composite fragment ─────────────────────────────────────────────────────
// Samples the blurred bloom texture, applies threshold + intensity.
// Rendered with additive blend in the main pass so bright halos glow over the scene.
// @group(0) binding 0: blurred bloom texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: vec2f — (.x = threshold, .y = intensity)

export const BLOOM_COMPOSITE_FS = /* wgsl */`
@group(0) @binding(0) var tex:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: vec2f;  // .x = threshold, .y = intensity

@fragment fn fs_composite(@location(0) uv: vec2f) -> @location(0) vec4f {
  let bloom = textureSample(tex, samp, uv);
  let lum   = dot(bloom.rgb, vec3f(0.2126, 0.7152, 0.0722));
  // Soft knee: only the "excess" brightness above threshold contributes
  let excess = max(0.0, lum - params.x);
  let scale  = excess / max(lum, 0.001) * params.y;
  return vec4f(bloom.rgb * scale, 0.0);  // alpha=0: additive blend ignores dst alpha
}
`;
