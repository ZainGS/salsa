/**
 * SSAO shaders — screen-space ambient occlusion, WORLD-SPACE formulation.
 *
 * Spec: docs/specs/ssao.md. Pipeline:
 *   1. PREPASS  — render scene geometry, write per-pixel WORLD POSITION to an rgba32float G-buffer
 *                 (.w = 1 for geometry, 0 for background/sky). Reuses the mesh vertex layout + the
 *                 shadow-pass pipeline layout (group 0 = instances + scene uniforms).
 *   2. AO       — fullscreen: reconstruct the normal from world-pos neighbours (the IMPROVED
 *                 closer-neighbour method — no halos at silhouettes), hemisphere-sample occlusion,
 *                 write AO to r8unorm.
 *   3. BLUR     — fullscreen depth-aware bilateral blur (no near→far AO bleed).
 *   4. DEBUG    — fullscreen blit of the AO buffer to screen (verify BEFORE it touches lighting).
 *
 * Working in WORLD space (not view space) means the AO pass needs only viewProjection + cameraPos —
 * both already in the scene uniforms — so there is NO inverse-projection / view-matrix reconstruction
 * to get wrong. NOTE: never put a backtick in a WGSL comment (these are template literals).
 */

// ── MeshInstance (must match the 224-byte storage stride; see mesh-instance-layout.test) ──────────
const MESH_INSTANCE_WGSL = /* wgsl */`
struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
};
`;

// ═══════════════════════════════════════════════════════════════════
//  PREPASS — world-position G-buffer (rgba32float)
// ═══════════════════════════════════════════════════════════════════

export const SSAO_PREPASS_SHADER = /* wgsl */`
${MESH_INSTANCE_WGSL}

@group(0) @binding(0) var<storage, read> u_instances: array<MeshInstance>;

// Only the leading viewProjection is read — the bound buffer is larger, which WGSL permits.
struct SceneUniforms { viewProjection: mat4x4<f32>, };
@group(0) @binding(1) var<uniform> scene: SceneUniforms;

struct VSOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @builtin(instance_index) idx: u32,
) -> VSOut {
  let inst = u_instances[idx];
  let worldPos = inst.modelMatrix * vec4<f32>(position, 1.0);
  var out: VSOut;
  out.clipPos = scene.viewProjection * worldPos;
  out.worldPos = worldPos.xyz;
  return out;
}

@fragment
fn fs_main(@location(0) worldPos: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(worldPos, 1.0);   // .w = 1 marks a real surface (clear value has .w = 0)
}
`;

// ═══════════════════════════════════════════════════════════════════
//  Shared fullscreen-triangle vertex shader (outputs uv)
// ═══════════════════════════════════════════════════════════════════

const FULLSCREEN_VS = /* wgsl */`
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  // uv in [0,1], y flipped so (0,0) is top-left (matches texture sampling of the G-buffer)
  out.uv = vec2<f32>(p[vid].x * 0.5 + 0.5, 1.0 - (p[vid].y * 0.5 + 0.5));
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  AO pass
// ═══════════════════════════════════════════════════════════════════

export const SSAO_AO_SHADER = /* wgsl */`
${FULLSCREEN_VS}

struct AOParams {
  viewProjection: mat4x4<f32>,   // world → clip, to project kernel samples to screen
  cameraPos:      vec4<f32>,     // .xyz
  params:         vec4<f32>,     // .x=radius(world) .y=intensity .z=bias(world) .w=power
  texel:          vec4<f32>,     // .xy = 1/w,1/h   .zw = w,h
};
@group(0) @binding(0) var<uniform> ao: AOParams;
@group(0) @binding(1) var gWorld:  texture_2d<f32>;
@group(0) @binding(2) var gSamp:   sampler;

fn camDist(p: vec3<f32>) -> f32 { return distance(ao.cameraPos.xyz, p); }

// Hash → pseudo-random in [0,1)
fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash33(n: f32) -> vec3<f32> {
  return fract(sin(vec3<f32>(n, n + 1.7, n + 3.3)) * vec3<f32>(43758.5453, 22578.145, 19642.37));
}

// World position at a uv (returns .w = 0 when no surface)
fn worldAt(uv: vec2<f32>) -> vec4<f32> { return textureSampleLevel(gWorld, gSamp, uv, 0.0); }

// Project a world point to screen uv (y flipped like FULLSCREEN_VS)
fn projectUV(world: vec3<f32>) -> vec3<f32> {
  let clip = ao.viewProjection * vec4<f32>(world, 1.0);
  let ndc = clip.xyz / clip.w;
  return vec3<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5), clip.w);
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let center = worldAt(uv);
  if (center.w < 0.5) { return vec4<f32>(1.0); }   // background → fully lit
  let P = center.xyz;

  // ── Improved normal reconstruction: sample ±1 texel each axis, keep the neighbour CLOSER in
  //    camera-distance before the cross product. Naive derivatives halo at silhouettes.
  let dx = vec2<f32>(ao.texel.x, 0.0);
  let dy = vec2<f32>(0.0, ao.texel.y);
  let cD = camDist(P);
  let rP = worldAt(uv + dx); let lP = worldAt(uv - dx);
  let uP = worldAt(uv + dy); let dP = worldAt(uv - dy);
  // x tangent: pick the horizontal neighbour whose depth is closest to centre
  var ddx = rP.xyz - P;
  if (abs(camDist(lP.xyz) - cD) < abs(camDist(rP.xyz) - cD) || rP.w < 0.5) { ddx = P - lP.xyz; }
  var ddy = uP.xyz - P;
  if (abs(camDist(dP.xyz) - cD) < abs(camDist(uP.xyz) - cD) || uP.w < 0.5) { ddy = P - dP.xyz; }
  var N = normalize(cross(ddx, ddy));
  let toCam = normalize(ao.cameraPos.xyz - P);
  if (dot(N, toCam) < 0.0) { N = -N; }

  let radius = ao.params.x;
  let bias   = ao.params.z;
  let rnd    = hash12(uv * ao.texel.zw) * 6.2831853;   // per-pixel rotation for kernel dither
  let cs = cos(rnd); let sn = sin(rnd);

  // Build a tangent basis around N
  var up = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(N.y) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
  let T = normalize(cross(up, N));
  let B = cross(N, T);

  let KN = i32(ao.cameraPos.w);   // hemisphere sample count (configurable; SSAOConfig.samples → cameraPos.w)
  var occlusion = 0.0;
  for (var i = 0; i < KN; i = i + 1) {
    var h = hash33(f32(i) * 1.618 + 0.5);            // random dir in a cube
    h = h * 2.0 - 1.0;
    h.z = abs(h.z);                                   // into the +N hemisphere (tangent space)
    // rotate the tangent-plane part by the per-pixel angle (dither)
    let hx = h.x * cs - h.y * sn;
    let hy = h.x * sn + h.y * cs;
    let scale = 0.2 + 0.8 * (f32(i) / f32(KN)) * (f32(i) / f32(KN));   // bias samples nearer the centre
    let dir = (T * hx + B * hy + N * h.z);
    let samplePos = P + dir * radius * scale;

    let sUV = projectUV(samplePos);
    if (sUV.x < 0.0 || sUV.x > 1.0 || sUV.y < 0.0 || sUV.y > 1.0) { continue; }
    let stored = worldAt(sUV.xy);
    if (stored.w < 0.5) { continue; }                 // sample landed on background
    let dStored = camDist(stored.xyz);
    let dSample = camDist(samplePos);
    // occluded when the stored surface at that screen point is nearer the camera than our sample
    if (dStored < dSample - bias) {
      let rangeCheck = smoothstep(0.0, 1.0, radius / max(distance(P, stored.xyz), 1e-4));
      occlusion = occlusion + rangeCheck;
    }
  }

  var aoVal = 1.0 - (occlusion / f32(KN)) * ao.params.y;
  aoVal = pow(clamp(aoVal, 0.0, 1.0), max(ao.params.w, 0.01));
  return vec4<f32>(aoVal, aoVal, aoVal, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  BLUR — depth-aware bilateral (reads AO raw + the world G-buffer for depth guarding)
// ═══════════════════════════════════════════════════════════════════

export const SSAO_BLUR_SHADER = /* wgsl */`
${FULLSCREEN_VS}

struct BlurParams { texel: vec4<f32>, }; // .xy = 1/w,1/h
@group(0) @binding(0) var<uniform> bp: BlurParams;
@group(0) @binding(1) var aoTex:  texture_2d<f32>;
@group(0) @binding(2) var gWorld: texture_2d<f32>;
@group(0) @binding(3) var samp:   sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let centerW = textureSampleLevel(gWorld, samp, uv, 0.0);
  if (centerW.w < 0.5) { return vec4<f32>(1.0); }
  let cP = centerW.xyz;
  var sum = 0.0;
  var wsum = 0.0;
  // 5x5 box, weighted down where the neighbour surface is far from the centre in world space
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let o = vec2<f32>(f32(x), f32(y)) * bp.texel.xy;
      let nW = textureSampleLevel(gWorld, samp, uv + o, 0.0);
      let a  = textureSampleLevel(aoTex,  samp, uv + o, 0.0).r;
      // depth-aware weight: near in world space → full weight; far → ~0 (no near→far bleed)
      var w = 1.0;
      if (nW.w < 0.5) { w = 0.0; } else { w = exp(-distance(cP, nW.xyz) * 4.0); }
      sum  = sum  + a * w;
      wsum = wsum + w;
    }
  }
  let r = select(1.0, sum / wsum, wsum > 0.0001);
  return vec4<f32>(r, r, r, 1.0);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  DEBUG — blit the AO buffer to screen as greyscale
// ═══════════════════════════════════════════════════════════════════

export const SSAO_DEBUG_SHADER = /* wgsl */`
${FULLSCREEN_VS}

@group(0) @binding(0) var aoTex: texture_2d<f32>;
@group(0) @binding(1) var samp:  sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let a = textureSampleLevel(aoTex, samp, uv, 0.0).r;
  return vec4<f32>(a, a, a, 1.0);
}
`;
