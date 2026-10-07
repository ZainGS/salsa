/**
 * WGSL shaders for the scene post-processing stack.
 *
 * Pipeline:
 *   1. Bloom extract  — scene (swap-chain format) → bright pixels (rgba16float)
 *   2. Blur H / V     — Gaussian blur on rgba16float (reuses BLOOM_BLUR_FS pattern)
 *   3. Bloom composite — scene + blurred bloom → output (swap-chain format)
 *   4. Grade+vignette  — combined color grading, radial vignette and the FILM look (grain + colour fringing)
 *
 * Passes 1–3 run only when bloom is enabled (the composite also applies film HALATION — a tint on the bloom).
 * Pass 4 runs when colorGrade, vignette or film is enabled.
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
// Reads the scene texture (swap-chain format: bgra8unorm or rgba8unorm), outputs bright pixels to rgba16float.
// Soft knee around threshold so the transition isn't a hard cut.
// @group(0) binding 0: scene texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: vec4f (.x = threshold)
export const PP_BLOOM_EXTRACT_FS = /* wgsl */`
@group(0) @binding(0) var sceneTex:  texture_2d<f32>;
@group(0) @binding(1) var samp:      sampler;
@group(0) @binding(2) var<uniform>   params: vec4f;  // .x = threshold, .w = chroma gate (0 = off)

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c   = textureSample(sceneTex, samp, uv);
  let lum = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let knee = smoothstep(params.x - 0.1, params.x + 0.1, lum);
  // CHROMA GATE (persona-polish A6): in an 8-bit frame a sunlit white road marking and a neon sign are equally
  // bright, so a luminance threshold alone blooms paint and pale pavement. Lights are SATURATED (neon, signal lamps,
  // warm windows); paint and paving are near-neutral - the gate fades the near-neutral pixels out of the bloom by
  // the gate amount (the city runs it at full strength by day, partly at night so white lightboxes still glow).
  let mx = max(c.r, max(c.g, c.b));
  let sat = (mx - min(c.r, min(c.g, c.b))) / max(mx, 1e-3);
  let gate = mix(1.0, smoothstep(0.28, 0.6, sat), clamp(params.w, 0.0, 1.0));
  return vec4f(c.rgb * knee * gate, 1.0);
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

// ── 2b. WIDE bloom (city-quality P6): a dual-filter (Kawase) mip chain ──────────
// The single 9-tap blur is an ~8 px halo — neon and street lamps need a WIDE soft glow. DOWN halves the image with a
// 5-tap filter; UP re-expands with an 8-tap tent and is ADDITIVELY blended onto the next larger level (so every scale
// contributes, like a film lens bloom). The last UP adds onto the small-halo bloom texture the composite already reads.
// @group(0) binding 0: source · binding 1: sampler · binding 2: vec4f (.xy = SOURCE texel size, .z = output weight)
export const PP_BLOOM_DOWN_FS = /* wgsl */`
@group(0) @binding(0) var tex:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> kp: vec4f;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hp = kp.xy * 0.5;
  var c = textureSample(tex, samp, uv) * 4.0;
  c += textureSample(tex, samp, uv - hp);
  c += textureSample(tex, samp, uv + hp);
  c += textureSample(tex, samp, uv + vec2f(hp.x, -hp.y));
  c += textureSample(tex, samp, uv - vec2f(hp.x, -hp.y));
  return c * 0.125;
}
`;

export const PP_BLOOM_UP_FS = /* wgsl */`
@group(0) @binding(0) var tex:  texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> kp: vec4f;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hp = kp.xy * 0.5;
  var c = textureSample(tex, samp, uv + vec2f(-hp.x * 2.0, 0.0));
  c += textureSample(tex, samp, uv + vec2f(-hp.x, hp.y)) * 2.0;
  c += textureSample(tex, samp, uv + vec2f(0.0, hp.y * 2.0));
  c += textureSample(tex, samp, uv + vec2f(hp.x, hp.y)) * 2.0;
  c += textureSample(tex, samp, uv + vec2f(hp.x * 2.0, 0.0));
  c += textureSample(tex, samp, uv + vec2f(hp.x, -hp.y)) * 2.0;
  c += textureSample(tex, samp, uv + vec2f(0.0, -hp.y * 2.0));
  c += textureSample(tex, samp, uv + vec2f(-hp.x, -hp.y)) * 2.0;
  return c * (kp.z / 12.0);
}
`;

// ── 3. Bloom composite ────────────────────────────────────────────────────────
// Reads scene + blurred bloom; outputs scene with soft-knee bloom added.
// Writes to the swapchain format (bgra8unorm or rgba8unorm).
// @group(0) binding 0: scene texture_2d<f32>
// @group(0) binding 1: bloom (blurred) texture_2d<f32>
// @group(0) binding 2: sampler
// @group(0) binding 3: BloomParams (.params: .x = threshold, .y = intensity, .z = halation; .tint = halation rgb)
export const PP_BLOOM_COMPOSITE_FS = /* wgsl */`
struct BloomParams {
  params: vec4f,   // .x = threshold, .y = intensity, .z = film halation amount (0 = the original bloom)
  tint:   vec4f,   // .rgb = halation tint
};
@group(0) @binding(0) var sceneTex:  texture_2d<f32>;
@group(0) @binding(1) var bloomTex:  texture_2d<f32>;
@group(0) @binding(2) var samp:      sampler;
@group(0) @binding(3) var<uniform>   bp: BloomParams;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTex, samp, uv);
  let bloom = textureSample(bloomTex, samp, uv);
  let lum   = dot(bloom.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let excess = max(0.0, lum - bp.params.x);
  let scale  = excess / max(lum, 0.001) * bp.params.y;
  // Film HALATION: light bleeding through the emulsion comes back warm (red-orange) — tint the glow, not the scene.
  let halo = mix(vec3f(1.0), bp.tint.rgb, bp.params.z);
  return vec4f(clamp(scene.rgb + bloom.rgb * scale * halo, vec3f(0.0), vec3f(1.0)), scene.a);
}
`;

// ── 4. Color grade + vignette ─────────────────────────────────────────────────
// Combined pass: brightness → contrast → saturation → tint → vignette.
// Any effect can be effectively disabled by using neutral values.
// Writes to the swapchain format.
// @group(0) binding 0: source texture_2d<f32>
// @group(0) binding 1: sampler
// @group(0) binding 2: GradeVigParams uniform (64 bytes — packGradeVigParams in post-process-pass.ts)
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
  gradeOn:      f32,  // 1 = apply the grade (always 1 with film off — the original behaviour)
  vigOn:        f32,  // 1 = apply the vignette (ditto)
  filmOn:       f32,  // 1 = film look on
  grain:        f32,  // grain strength (0 = none)
  grainSize:    f32,  // grain cell size, px
  aberration:   f32,  // colour-fringing strength (0 = none)
  timeSec:      f32,  // scene time (world-speed scaled) — animates the grain
  shadowTint:   vec4f, // split-tone: shadow hue (luminance-normalised; 1,1,1 = off)
  highlightTint: vec4f, // split-tone: highlight hue (ditto)
};

@group(0) @binding(0) var tex:    texture_2d<f32>;
@group(0) @binding(1) var samp:   sampler;
@group(0) @binding(2) var<uniform> p: GradeVigParams;

// Grain noise → 0..1 for a pixel cell + film frame: an INTEGER (PCG) hash. It used to be fract(sin(dot(q, k)) * 43758),
// whose argument grew with the frame number: after a few minutes it reached ~1e7-1e8, where GPU sin() has no
// precision left (many drivers return near-constant values), so the grain faded away until the hourly clock wrap.
// u32 maths wraps exactly, so this stays random at any time.
fn filmHash(cell: vec2f, frame: f32) -> f32 {
  let q = vec2<u32>(max(cell, vec2f(0.0)));
  var v = q.x * 1973u + q.y * 9277u + u32(max(frame, 0.0)) * 26699u;
  v = v * 747796405u + 2891336453u;
  var w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967295.0;
}

@fragment fn fs_main(@location(0) uv: vec2f, @builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  // Colour fringing: R and B sampled slightly outward / inward along the radius, growing toward the edges (0 at the
  // centre). Always three taps (offset 0 when off) — keeps textureSample in uniform control flow.
  let d   = uv - vec2f(0.5);
  let off = d * (p.aberration * length(d) * 2.0);
  var c = vec3f(
    textureSample(tex, samp, uv + off).r,
    textureSample(tex, samp, uv).g,
    textureSample(tex, samp, uv - off).b,
  );

  if (p.gradeOn > 0.5) {
    // Brightness
    c = c + p.brightness;
    // Contrast: pivot at 0.5
    c = (c - 0.5) * (1.0 + p.contrast) + 0.5;
    // Saturation
    let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    c = mix(vec3f(lum), c, 1.0 + p.saturation);
    // Tint
    c = c * vec3f(p.tintR, p.tintG, p.tintB);
    // SPLIT-TONE (city-quality P7): push the shadows toward one hue and the highlights toward another (indigo night
    // shadows under warm neon). Hue-only tints (normalised on the CPU); 1,1,1 = no change.
    let stLum = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    let stW = (1.0 - smoothstep(0.0, 0.55, stLum)) * 0.6;
    let hlW = smoothstep(0.45, 1.0, stLum) * 0.5;
    c = c * mix(vec3f(1.0), p.shadowTint.rgb, stW) * mix(vec3f(1.0), p.highlightTint.rgb, hlW);
  }

  if (p.vigOn > 0.5) {
    // Vignette: distance from center, normalized so corner = 1.0
    let dist = length(uv - vec2f(0.5)) * 1.4142;
    let vf   = smoothstep(p.vigRadius + p.vigSoftness, p.vigRadius - p.vigSoftness, dist);
    c = c * mix(1.0 - p.vigIntensity, 1.0, vf);
  }

  if (p.grain > 0.0) {
    // Film GRAIN, LAST so it sits on top: a fresh pattern every 1/24 s (film's frame rate, not the display's),
    // weighted to the mid-tones (4·l·(1−l)) so blacks stay black and highlights stay clean.
    let cell  = floor(fragPos.xy / max(p.grainSize, 0.5));
    let frame = floor(p.timeSec * 24.0);
    let n     = filmHash(cell, frame) * 2.0 - 1.0;
    let l     = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    c = c + vec3f(n * p.grain * 4.0 * l * (1.0 - l));
  }

  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
