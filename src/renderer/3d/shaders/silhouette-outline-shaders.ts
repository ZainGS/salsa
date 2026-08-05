/**
 * Screen-space SILHOUETTE OUTLINE — a thick, uniform, animated band around a mesh's CURRENT projected silhouette,
 * from any angle, boxy or smooth. Unlike expand-along-normals / inverted-hull (which tear on hard-edged buildings
 * and vary in thickness), this is purely screen-space:
 *
 *   1. MASK      — render the target geometry into an r8 mask (1 = silhouette, 0 = else). No depth: the full
 *                  projected silhouette (union of all its triangles), so the outline wraps the whole thing.
 *   2. COMPOSITE — fullscreen: for each EXTERIOR pixel, scan a disc of radius `thickness` px; if any tap lands on
 *                  the mask, the pixel is within the band → fill it with the animated pattern and blend over the
 *                  scene (depthCompare 'always' → reads on top). Uniform thickness, round corners, no normal tearing.
 *
 * Projection-agnostic by construction (screen-space; nothing reconstructed from the camera). NOTE: never put a
 * backtick in a WGSL comment (template-literal gotcha).
 */

// ── MASK pass — rasterize the target silhouette to r8 ─────────────────────────────────────────────
export const OUTLINE_MASK_SHADER = /* wgsl */`
struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissiveColor: vec4<f32>,
  _texIndex:  u32,
  _normIndex: u32,
  _pad0:      u32,
  _pad1:      u32,
  _pad2:      vec4<f32>,
  _pad3:      vec4<f32>,
}
struct SceneUniforms { viewProjection: mat4x4<f32>, }

@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:     SceneUniforms;

@vertex fn vs(@location(0) pos: vec3<f32>, @builtin(instance_index) iIdx: u32) -> @builtin(position) vec4<f32> {
  let worldPos = instances[iIdx].modelMatrix * vec4<f32>(pos, 1.0);
  return scene.viewProjection * worldPos;
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

// ── COMPOSITE — disc-scan the mask, draw the patterned band ────────────────────────────────────────
export const OUTLINE_COMPOSITE_SHADER = /* wgsl */`
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  out.uv  = vec2<f32>(p[vid].x * 0.5 + 0.5, 1.0 - (p[vid].y * 0.5 + 0.5));
  return out;
}

struct OutlineParams {
  color:        vec4<f32>,   // band base colour (rgb) + alpha
  patternColor: vec4<f32>,   // secondary pattern colour (rgb) + .w = glow multiplier
  params:       vec4<f32>,   // .x = thickness(px) .y = patternMode .z = freq .w = scroll speed
  screen:       vec4<f32>,   // .xy = mask size (px) .z = time(s) .w = unused
}
@group(0) @binding(0) var<uniform> op: OutlineParams;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var maskSamp: sampler;

fn maskAt(uv: vec2<f32>) -> f32 {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
  return textureSampleLevel(maskTex, maskSamp, uv, 0.0).r;
}

// Animated SCREEN-SPACE pattern (0 = flat). Same modes as the mesh highlight.
fn olPattern(uv: vec2<f32>, mode: i32, freq: f32, t: f32) -> f32 {
  let p = uv * freq;
  if (mode == 2) { let g = fract(p - vec2<f32>(t, 0.0)) - vec2<f32>(0.5, 0.5); return 1.0 - smoothstep(0.24, 0.30, length(g)); }
  if (mode == 3) { let c = floor(p - vec2<f32>(t, 0.0)); return fract((c.x + c.y) * 0.5) * 2.0; }
  return step(0.5, fract((p.x + p.y) * 0.5 - t));
}

@fragment fn fs(@location(0) uv: vec2<f32>, @builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  if (maskAt(uv) > 0.5) { discard; }                       // interior of the mesh — no band
  let T = max(op.params.x, 1.0);
  let texel = 1.0 / max(op.screen.xy, vec2<f32>(1.0, 1.0));
  // Disc scan: nearest mask hit within T px (concentric rings). ~36 taps, only while hovering.
  var minD = T + 1.0;
  let RINGS = 3; let SPOKES = 12;
  for (var ri = 1; ri <= RINGS; ri = ri + 1) {
    let r = T * f32(ri) / f32(RINGS);
    for (var si = 0; si < SPOKES; si = si + 1) {
      let a = f32(si) / f32(SPOKES) * 6.2831853;
      if (maskAt(uv + vec2<f32>(cos(a), sin(a)) * r * texel) > 0.5) { minD = min(minD, r); }
    }
  }
  if (minD > T) { discard; }                               // outside the band
  let edge = 1.0 - smoothstep(T - 1.5, T, minD);           // soft outer edge (AA)
  let m = olPattern(fragCoord.xy / op.screen.xy, i32(op.params.y), op.params.z, op.screen.z * op.params.w);
  let rgb = mix(op.color.rgb, op.patternColor.rgb, m) * op.patternColor.w;
  return vec4<f32>(rgb, op.color.a * edge);
}
`;
