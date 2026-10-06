/**
 * WGSL for ALPHA-SHAPED sprite outlines (docs/specs/sprite-alpha-outlines.md) — a separate pipeline from the hull
 * outline (highlight-shaders.ts), used ONLY for textured sprites whose image has transparency.
 *
 * The VS draws the sprite quad GROWN in its own plane by the total outline width (same instance model matrix, so a
 * billboard sprite's outline turns with it). The FS reads the image's signed distance field and keeps only the
 * band(s) outside the shape: layer i covers distances up to its cumulative outer width (the same inner → outer rings
 * as the hull outline's outlineLayers), shaded with that layer's colour / pattern / glow, thresholds boiled by the
 * same line-boil noise.
 *
 * SOLID CARD mode (mode.x = 1, spriteShape 'card'): distances are to the QUAD's rectangle instead of the image's
 * shape, and inside the quad the sprite's see-through pixels are filled with the main outline's look (the binding-1
 * texture is then the sprite's own image, read for its alpha) — a solid square card with rings around it.
 */

export const SPRITE_OUTLINE_SHADER = /* wgsl */`

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
struct SpriteLayer {
  color:        vec4<f32>,   // rgb + alpha
  patternColor: vec4<f32>,   // rgb + .w = glow
  params:       vec4<f32>,   // .x = OUTER distance (model units, cumulative) .y = patternMode .z = freq .w = speed
  boil:         vec4<f32>,   // .x = wobble (0 = off) .y = wobbles per unit .z = redraws per second
}
struct SpriteOutlineParams {
  quad:   vec4<f32>,         // .xy = sprite half-size (model units) .z = grow (outermost width) .w = model units per field texel
  field:  vec4<f32>,         // .xy = image area (field texels) .z = padding (texels) .w = max encoded distance (texels)
  screen: vec4<f32>,         // .xy = render-target size (px) .z = time (s) .w = layer count
  mode:   vec4<f32>,         // .x = 0 image shape (SDF) · 1 solid card (the sprite's own texture)
  uvt:    vec4<f32>,         // card mode: the sprite's UV transform (uv * .xy + .zw), as the sprite samples it
  layers: array<SpriteLayer, 8>,
}

@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene:     SceneUniforms;
@group(1) @binding(0) var<uniform>       sp:        SpriteOutlineParams;
@group(1) @binding(1) var sdfTex:  texture_2d<f32>;   // the SDF (image mode) or the sprite's image (card mode)
@group(1) @binding(2) var sdfSamp: sampler;

struct VOut {
  @builtin(position) pos:   vec4<f32>,
  @location(0)       local: vec2<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) iIdx: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0),  vec2<f32>(-1.0, 1.0));
  let c = corners[vi];
  let local = c * (sp.quad.xy + vec2<f32>(sp.quad.z, sp.quad.z));
  var o: VOut;
  o.pos   = scene.viewProjection * (instances[iIdx].modelMatrix * vec4<f32>(local, 0.0, 1.0));
  o.local = local;
  return o;
}

// LINE BOIL — same noise as the hull outline's boilScale (highlight-shaders.ts), sampled at the fragment's point.
fn spBoil(p: vec3<f32>, b: vec4<f32>, t: f32) -> f32 {
  if (b.x <= 0.0) { return 1.0; }
  let frame = floor(t * max(b.z, 0.0));
  let f = max(b.y, 0.001);
  let n = sin(dot(p, vec3<f32>(1.7, 9.2, 3.1)) * f + frame * 2.39) * sin(dot(p, vec3<f32>(8.3, 2.8, 5.6)) * f * 0.73 + frame * 1.37);
  return max(0.0, 1.0 + b.x * n);
}

// Screen-space pattern — same as the hull outline's hlPattern.
fn spPattern(uv: vec2<f32>, mode: i32, freq: f32, t: f32) -> f32 {
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

fn spShade(li: i32, px: vec2<f32>) -> vec4<f32> {
  let S = sp.layers[li];
  let mode = i32(S.params.y);
  if (mode <= 0) { return S.color; }
  let suv = px / max(sp.screen.xy, vec2<f32>(1.0, 1.0));
  let m = spPattern(suv, mode, S.params.z, sp.screen.z * S.params.w);
  let rgb = mix(S.color.rgb, S.patternColor.rgb, m) * S.patternColor.w;
  return vec4<f32>(rgb, S.color.a);
}

@fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(in.local.x / (2.0 * sp.quad.x) + 0.5, 0.5 - in.local.y / (2.0 * sp.quad.y));
  let card = sp.mode.x > 0.5;
  var d: f32;
  var cap: f32;
  if (card) {
    // Signed distance to the quad's rectangle (model units; < 0 inside the quad).
    let q = abs(in.local) - sp.quad.xy;
    d = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0);
    cap = 1e9;
    if (d <= 0.0) {
      // Inside the quad: fill the see-through part with the main outline's look. Blended by (1 - image alpha) so the
      // picture stays on top and its soft edge melts into the card.
      let a = textureSampleLevel(sdfTex, sdfSamp, uv * sp.uvt.xy + sp.uvt.zw, 0.0).a;
      let fill = spShade(0, in.pos.xy);
      let k = fill.a * (1.0 - a);
      if (k <= 0.004) { discard; }
      return vec4<f32>(fill.rgb, k);
    }
  } else {
    // Image UV → field texel; beyond the field's own border add the straight distance to it.
    let fieldSize = sp.field.xy + vec2<f32>(2.0 * sp.field.z, 2.0 * sp.field.z);
    let ft = uv * sp.field.xy + vec2<f32>(sp.field.z, sp.field.z);
    let enc = textureSampleLevel(sdfTex, sdfSamp, ft / fieldSize, 0.0).r;
    let beyond = length(max(vec2<f32>(0.0, 0.0), max(-ft, ft - fieldSize)));
    d = ((enc - 0.5) * 2.0 * sp.field.w + beyond) * sp.quad.w;   // model units; > 0 outside the shape
    // capped below the field's saturation distance — past it every far point reads the same value
    cap = 0.98 * sp.field.w * sp.quad.w;
    if (d <= 0.0) { discard; }
  }
  let p3 = vec3<f32>(in.local, 0.0);
  let n = i32(sp.screen.w);
  var li = -1;
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    let L = sp.layers[i];
    if (d < min(L.params.x * spBoil(p3, L.boil, sp.screen.z), cap)) { li = i; break; }
  }
  if (li < 0) { discard; }
  return spShade(li, in.pos.xy);
}

`;
