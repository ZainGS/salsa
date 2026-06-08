/**
 * WGSL shaders for the scene post-processing stack.
 *
 * Pipeline:
 *   1. Bloom extract  — scene (bgra8unorm) → bright pixels (rgba16float)
 *   2. Blur H / V     — Gaussian blur on rgba16float (reuses BLOOM_BLUR_FS pattern)
 *   3. Bloom composite — scene + blurred bloom → output (bgra8unorm)
 *   4. Grade+vignette  — combined color grading and radial vignette (bgra8unorm → bgra8unorm)
 *
 * Passes 1–3 run only when bloom is enabled.
 * Pass 4 runs when either colorGrade or vignette is enabled.
 */

// Shared fullscreen triangle VS (generates NDC quad from vertex_index, no VB needed)
export const PP_FULLSCREEN_VS = /* wgsl */`
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  const pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0),
  );
  let xy = pos[vi];
  return VsOut(vec4f(xy, 0.0, 1.0), xy * vec2f(0.5, -0.5) + 0.5);
}
`;

// ── 1. Bloom extract ──────────────────────────────────────────────────────────
// Reads the bgra8unorm scene texture, outputs bright pixels to rgba16float.
// Soft knee around threshold so the transition isn't a hard cut.
// @group(0) binding 0: scene texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: vec4f (.x = threshold)
export const PP_BLOOM_EXTRACT_FS = /* wgsl */`
@group(0) @binding(0) var sceneTex:  texture_2d<f32>;
@group(0) @binding(1) var samp:      sampler;
@group(0) @binding(2) var<uniform>   params: vec4f;  // .x = threshold

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c   = textureSample(sceneTex, samp, uv);
  let lum = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let knee = smoothstep(params.x - 0.1, params.x + 0.1, lum);
  return vec4f(c.rgb * knee, 1.0);
}
`;

// ── 2. Blur (H and V, shared) ─────────────────────────────────────────────────
// 9-tap separable Gaussian (σ ≈ 2). Works on any float texture.
// @group(0) binding 0: source texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: vec2f step — (1/w, 0) horizontal or (0, 1/h) vertical
export const PP_BLUR_FS = /* wgsl */`
@group(0) @binding(0) var tex:      texture_2d<f32>;
@group(0) @binding(1) var samp:     sampler;
@group(0) @binding(2) var<uniform>  blurStep: vec2f;

const W = array<f32, 5>(0.227027, 0.194595, 0.121621, 0.054054, 0.016216);

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSample(tex, samp, uv) * W[0];
  for (var i = 1; i < 5; i++) {
    let off = blurStep * f32(i);
    c += textureSample(tex, samp, uv + off) * W[i];
    c += textureSample(tex, samp, uv - off) * W[i];
  }
  return c;
}
`;

// ── 3. Bloom composite ────────────────────────────────────────────────────────
// Reads scene + blurred bloom; outputs scene with soft-knee bloom added.
// Writes to bgra8unorm (swapchain format).
// @group(0) binding 0: scene texture_2d<f32>
// @group(0) binding 1: bloom (blurred) texture_2d<f32>
// @group(0) binding 2: sampler
// @group(0) binding 3: vec4f (.x = threshold, .y = intensity)
export const PP_BLOOM_COMPOSITE_FS = /* wgsl */`
@group(0) @binding(0) var sceneTex:  texture_2d<f32>;
@group(0) @binding(1) var bloomTex:  texture_2d<f32>;
@group(0) @binding(2) var samp:      sampler;
@group(0) @binding(3) var<uniform>   params: vec4f;  // .x = threshold, .y = intensity

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTex, samp, uv);
  let bloom = textureSample(bloomTex, samp, uv);
  let lum   = dot(bloom.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let excess = max(0.0, lum - params.x);
  let scale  = excess / max(lum, 0.001) * params.y;
  return vec4f(clamp(scene.rgb + bloom.rgb * scale, vec3f(0.0), vec3f(1.0)), scene.a);
}
`;

// ── 4. Color grade + vignette ─────────────────────────────────────────────────
// Combined pass: brightness → contrast → saturation → tint → vignette.
// Any effect can be effectively disabled by using neutral values.
// Writes to bgra8unorm.
// @group(0) binding 0: source texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: GradeVigParams uniform (48 bytes)
export const PP_GRADE_VIG_FS = /* wgsl */`
struct GradeVigParams {
  brightness:   f32,  // -1 to +1, default 0
  contrast:     f32,  // -1 to +1, default 0
  saturation:   f32,  // -1 to +1, default 0
  vigIntensity: f32,  // 0 to 1, default 0
  tintR:        f32,  // default 1
  tintG:        f32,  // default 1
  tintB:        f32,  // default 1
  vigRadius:    f32,  // 0 to 1, default 0.75
  vigSoftness:  f32,  // 0 to 1, default 0.45
  _pad0:        f32,
  _pad1:        f32,
  _pad2:        f32,
};

@group(0) @binding(0) var tex:    texture_2d<f32>;
@group(0) @binding(1) var samp:   sampler;
@group(0) @binding(2) var<uniform> p: GradeVigParams;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = textureSample(tex, samp, uv).rgb;

  // Brightness
  c = c + p.brightness;
  // Contrast: pivot at 0.5
  c = (c - 0.5) * (1.0 + p.contrast) + 0.5;
  // Saturation
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(lum), c, 1.0 + p.saturation);
  // Tint
  c = c * vec3f(p.tintR, p.tintG, p.tintB);

  // Vignette: distance from center, normalized so corner = 1.0
  let dist = length(uv - vec2f(0.5)) * 1.4142;
  let vf   = smoothstep(p.vigRadius + p.vigSoftness, p.vigRadius - p.vigSoftness, dist);
  c = c * mix(1.0 - p.vigIntensity, 1.0, vf);

  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
