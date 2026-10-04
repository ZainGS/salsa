/**
 * WGSL shaders for the screen-space ink outline pass.
 *
 * Three-stage pipeline:
 *  1. Depth+Normal pre-pass — render meshes into an offscreen depth texture (depth32float)
 *     AND a packed world-normal texture (rgba8unorm), driven by Renderer3D.
 *  2. Sobel pass — detect edges from BOTH silhouette boundary (depth→FAR) AND
 *     hard-crease discontinuity (normal dot < CREASE_DOT) → rgba8unorm edge mask.
 *  3. Composite pass — blend edge mask into the main render pass via fullscreen quad.
 */

import { FOG_FADE_WGSL, FOLIAGE_WIND_WGSL, LEAF_CARD_WGSL } from './mesh3d-shaders';

// ── Outline depth+normal pre-pass shader ─────────────────────────────────────

/**
 * Combined depth+normal vertex/fragment shader.
 * Vertex: transforms position+normal into clip space.
 * Fragment: packs world normal into rgba8unorm color target.
 * Depth is written automatically by the GPU from the clip-space position.
 */
export const OUTLINE_DEPTH_NORMAL_SHADER = /* wgsl */`
${FOG_FADE_WGSL}
${FOLIAGE_WIND_WGSL}
${LEAF_CARD_WGSL}

struct MeshInstance {
  modelMatrix:  mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  diffuseColor: vec4<f32>,
  specularColor: vec4<f32>,
  emissiveColor: vec4<f32>,
  _pad0:        vec4<f32>,   // pad to MESH_INSTANCE_STRIDE = 240 (texIndex/normIndex/rough/metal + 2 pattern vec4 + uvTransform)
  _pad1:        vec4<f32>,
  _pad2:        vec4<f32>,
  _pad3:        vec4<f32>,
}
// The full scene layout through fogEye (fog horizon P2 reads fogParams / toonParams.w / fogEye; WGSL has no @offset).
struct SceneUniforms {
  viewProjection:   mat4x4<f32>,
  cameraPosition:   vec4<f32>,
  ambientColor:     vec4<f32>,
  lightDirection:   vec4<f32>,
  lightColor:       vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,
  lightCounts:      vec4<f32>,
  pointLights:      array<vec4<f32>, 32>,
  skinRampParams:   vec4<f32>,
  styleParams:      vec4<f32>,
  toonParams:       vec4<f32>,
  rimParams:        vec4<f32>,
  heightFog:        vec4<f32>,
  cascadeMatrices:  array<mat4x4<f32>, 2>,
  cascadeParams:    vec4<f32>,
  cascadeBias:      vec4<f32>,
  aerialParams:     vec4<f32>,
  fogEye:           vec4<f32>,
}

@group(0) @binding(0) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(1) var<uniform>       scene: SceneUniforms;

struct VertOut {
  @builtin(position) pos:         vec4<f32>,
  @location(0)       worldNormal: vec3<f32>,
  @location(1)       worldPos:    vec3<f32>,
  @location(2) @interpolate(flat) iIdx: u32,
  @location(3)       uv:          vec2<f32>,
}

@vertex fn vs(
  @location(0) pos:    vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv:     vec2<f32>,
  @builtin(instance_index) iIdx: u32,
) -> VertOut {
  // FOLIAGE WIND (bit 19, visual-polish #3): the same sway as the colour + shadow passes, so a canopy's ink stays on
  // its leaves instead of on where they were at rest (patternParams.xyz = _pad2 here).
  var localPos = pos;
  if ((bitcast<u32>(instances[iIdx].emissiveColor.a) & 524288u) != 0u) {
    let m = instances[iIdx].modelMatrix;
    let wp = instances[iIdx]._pad2;
    localPos = localPos + foliageWindOffset(pos, vec3<f32>(m[3].x, m[3].y, m[3].z), wp.x, wp.y, wp.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }
  let worldPos  = instances[iIdx].modelMatrix  * vec4<f32>(localPos, 1.0);
  let worldNorm = instances[iIdx].normalMatrix * vec4<f32>(normal, 0.0);
  return VertOut(
    scene.viewProjection * worldPos,
    normalize(worldNorm.xyz),
    worldPos.xyz,
    iIdx,
    uv,
  );
}

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  // visual-polish #3: a LEAF CARD (bit 13) writes depth only inside its leaf silhouette, like the colour and shadow
  // passes (the pre-pass used to ink the bare card squares: long straight lines across every canopy). FOLIAGE
  // (leaf cards + foliage-shade bit 20) packs a HALF-LENGTH normal so the Sobel pass can tell it apart and apply the
  // foliage mode; the direction is kept, so the 'full' mode inks it exactly as before.
  let mflags = bitcast<u32>(instances[in.iIdx].emissiveColor.a);
  if ((mflags & 8192u) != 0u && leafCardCoverage(in.uv) < 0.5) { discard; }
  let isFoliage = (mflags & (8192u | 1048576u)) != 0u;
  // Pack world normal from [-1,1] to [0,1] for rgba8unorm storage.
  // .a = the FOG HORIZON fade coverage (P2) of a fading mesh, 1 otherwise: the Sobel pass scales its ink by it, so a
  // dissolving object's outline fades with it instead of popping at the fog line.
  var cov = 1.0;
  let fhFlags = u32(scene.toonParams.w);
  if ((fhFlags & 2u) != 0u && fhFades(u32(instances[in.iIdx].normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    cov = fhCoverage(length(scene.fogEye.xyz - in.worldPos), fhEdge, scene.fogEye.w);
  }
  // HLOD CROSS-FADE (performance-plan P17; flags2 bit 5): a dissolving tier's ink fades with its coverage (normalMatrix
  // column 3 .y) the same way, instead of popping when the swap ends (a dithered normal would ink the dither pattern).
  if ((u32(instances[in.iIdx].normalMatrix[3].x) & 32u) != 0u) { cov = min(cov, instances[in.iIdx].normalMatrix[3].y); }
  // Silhouette outline cut live (scene flag bit 5): a NO-FOG mesh (Material3D.noFog) writes exactly 1 and every other
  // mesh at most 254/255, so the Sobel pass can keep the ink on no-fog pixels past the fog edge (it rescales the rest).
  if ((fhFlags & 32u) != 0u) {
    cov = select(min(cov, 254.0 / 255.0), 1.0, fhNoFog(u32(instances[in.iIdx].normalMatrix[3].x), fhFlags));
  }
  return vec4<f32>(normalize(in.worldNormal) * select(0.5, 0.25, isFoliage) + 0.5, cov);
}

`;

// ── Edge detection shader ─────────────────────────────────────────────────────

/**
 * Detects outline pixels from two independent criteria:
 *
 *   (a) Silhouette edge — the pixel is on a mesh (depth < FAR) and at least
 *       one neighbor within `width` pixels is background (depth >= FAR).
 *
 *   (b) Hard-crease edge — both the pixel and a neighbor are on the mesh, but
 *       their world normals diverge by more than ~60° (dot < CREASE_DOT).
 *       This draws outlines along cube edges, cylinder cap rings, etc.
 *
 * Bind group 0:
 *   binding 0 = texture_depth_2d  (depth pre-pass output)
 *   binding 1 = uniform OutlineParams
 *   binding 2 = texture_2d<f32>   (packed normal, rgba8unorm pre-pass output)
 */
export const OUTLINE_SOBEL_SHADER = /* wgsl */`

struct OutlineParams {
  color: vec4<f32>,
  width: f32,   // outline half-width in physical pixels
  fadeNear: f32,   // DEPTH FADE (visual-polish #8): full width + alpha up to this camera distance (world units)
  fadeFar: f32,    // ... 1 px and fadeMin x alpha from here on; fadeFar <= fadeNear = off (constant ink)
  fadeMin: f32,
  invViewProj: mat4x4<f32>,   // the inverse of the pre-pass view-projection (world from depth): fog cut + depth fade
  fogCut:      vec4<f32>,     // .xyz = the fog eye, .w = the fog edge distance (0 = off: outlines everywhere)
  camEye:      vec4<f32>,     // .xyz = the camera eye (depth fade), .w = the thin-crease minimum in px (visual-polish #3b; below 2 = off)
  extra:       vec4<f32>,     // visual-polish #3: .x = foliage mode (0 full, 1 silhouette, 2 off), .yzw = crease fade near / far / min alpha (far <= near = off)
}

@group(0) @binding(0) var depthTex:  texture_depth_2d;
@group(0) @binding(1) var<uniform>   params: OutlineParams;
@group(0) @binding(2) var normalTex: texture_2d<f32>;

struct VertOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertOut {
  var positions = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  return VertOut(vec4<f32>(positions[vi], 0.0, 1.0));
}

fn loadDepth(coord: vec2<i32>) -> f32 {
  let sz = vec2<i32>(textureDimensions(depthTex));
  let c  = clamp(coord, vec2<i32>(0), sz - vec2<i32>(1));
  return textureLoad(depthTex, c, 0);
}

fn loadNormal(coord: vec2<i32>) -> vec3<f32> {
  let sz  = vec2<i32>(textureDimensions(normalTex));
  let c   = clamp(coord, vec2<i32>(0), sz - vec2<i32>(1));
  let enc = textureLoad(normalTex, c, 0).rgb;
  return enc * 2.0 - 1.0; // unpack [0,1] → [-1,1]
}

// visual-polish #3: the pre-pass writes FOLIAGE normals at half length (about 0.5; every other mesh about 1).
// Returns the unit normal in .xyz and 1 in .w for a foliage pixel.
fn loadNormalF(coord: vec2<i32>) -> vec4<f32> {
  let n = loadNormal(coord);
  let l = length(n);
  return vec4<f32>(n / max(l, 1e-4), select(0.0, 1.0, l < 0.75));
}

// Fog horizon fade coverage of a pixel (the pre-pass alpha; 1 for everything that does not fade, and the cleared
// background).
fn loadCoverage(coord: vec2<i32>) -> f32 {
  let sz = vec2<i32>(textureDimensions(normalTex));
  let a = textureLoad(normalTex, clamp(coord, vec2<i32>(0), sz - vec2<i32>(1)), 0).a;
  // With the fog cut live the pre-pass caps every fogged mesh at 254/255 (1 marks a no-fog mesh): undo the cap.
  return select(a, min(a * (255.0 / 254.0), 1.0), params.fogCut.w > 0.0);
}

const FAR: f32        = 0.9999;
const CREASE_DOT: f32 = 0.3; // normals differing by >~72 degrees → hard edge

// World distance from the camera eye of the pixel at coord (the pre-pass depth through the inverse view-projection).
fn eyeDist(coord: vec2<i32>) -> f32 {
  let sz = vec2<i32>(textureDimensions(depthTex));
  let cc = clamp(coord, vec2<i32>(0), sz - vec2<i32>(1));
  let uv = (vec2<f32>(cc) + vec2<f32>(0.5)) / vec2<f32>(sz);
  let w = params.invViewProj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, loadDepth(cc), 1.0);
  return length(w.xyz / w.w - params.camEye.xyz);
}

// visual-polish #3b THIN CREASES: are both faces of the crease between c (normal cN) and its tap nc (normal nN) at
// least tp pixels thick along the tap direction? A sub-pixel face (a ledge underside at 30 to 40 m) is rasterised in
// some pixels and not others, so the crease ink along it broke into dashes.
fn creaseThick(c: vec2<i32>, nc: vec2<i32>, cN: vec3<f32>, nN: vec3<f32>, tp: i32) -> bool {
  let st = vec2<i32>(sign(vec2<f32>(nc - c)));
  for (var k: i32 = 1; k < tp; k = k + 1) {
    if (dot(loadNormalF(nc + st * k).xyz, nN) < 0.9) { return false; }
    if (dot(loadNormalF(c - st * k).xyz, cN) < 0.9) { return false; }
  }
  return true;
}

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  let c = vec2<i32>(floor(in.pos.xy));

  // Skip background pixels
  let cDepth = loadDepth(c);
  if (cDepth >= FAR) { return vec4<f32>(0.0); }

  // FOG HORIZON (Silhouette outlines off): no ink on a pixel at or past the fog edge, where the colour pass drew the
  // flat fog colour. World position from this pixel's depth (the pre-pass used the camera's view-projection), distance
  // from the fog eye, the same edge the colour pass uses. fogCut.w = 0 = off (the original pass).
  // A NO-FOG pixel (pre-pass alpha exactly 1 while the cut is live, see the pre-pass) keeps its ink.
  let fcRaw = textureLoad(normalTex, c, 0).a;
  if (params.fogCut.w > 0.0 && fcRaw < 0.999) {
    let fcUv = (vec2<f32>(c) + vec2<f32>(0.5)) / vec2<f32>(textureDimensions(depthTex));
    let fcW = params.invViewProj * vec4<f32>(fcUv.x * 2.0 - 1.0, 1.0 - fcUv.y * 2.0, cDepth, 1.0);
    if (length(fcW.xyz / fcW.w - params.fogCut.xyz) >= params.fogCut.w) { return vec4<f32>(0.0); }
  }

  let cN4 = loadNormalF(c);
  let centerNormal = cN4.xyz;
  let cFol = cN4.w > 0.5;
  let folMode = u32(params.extra.x + 0.5);
  if (folMode == 2u && cFol) { return vec4<f32>(0.0); }   // foliage ink 'off': no ink on a leaf pixel
  // DEPTH FADE: thinner (down to 1 px) and lighter ink with camera distance, so far thin geometry (poles, window
  // reveals) reads as a soft line instead of a broken dash. Off (fadeFar <= fadeNear) = the constant width.
  var wPx = params.width;
  var fadeA = 1.0;
  if (params.fadeFar > params.fadeNear) {
    let dfUv = (vec2<f32>(c) + vec2<f32>(0.5)) / vec2<f32>(textureDimensions(depthTex));
    let dfW = params.invViewProj * vec4<f32>(dfUv.x * 2.0 - 1.0, 1.0 - dfUv.y * 2.0, cDepth, 1.0);
    let dfT = smoothstep(params.fadeNear, params.fadeFar, length(dfW.xyz / dfW.w - params.camEye.xyz));
    wPx = mix(params.width, 1.0, dfT);
    fadeA = mix(1.0, params.fadeMin, dfT);
  }
  let r = max(1, i32(round(wPx)));
  var isEdge = false;
  var edgeCov = 1.0;   // fog horizon P2: the fade coverage of the edge (min of this pixel and the neighbour that made it)
  // CREASE FADE (visual-polish #3): crease ink fades with camera distance (silhouette ink does not). Off = 1.
  var creaseA = 1.0;
  var cDist = 0.0;
  if (params.extra.z > params.extra.y) {
    let cfUv = (vec2<f32>(c) + vec2<f32>(0.5)) / vec2<f32>(textureDimensions(depthTex));
    let cfW = params.invViewProj * vec4<f32>(cfUv.x * 2.0 - 1.0, 1.0 - cfUv.y * 2.0, cDepth, 1.0);
    cDist = length(cfW.xyz / cfW.w - params.camEye.xyz);
    creaseA = mix(1.0, params.extra.w, smoothstep(params.extra.y, params.extra.z, cDist));
  }
  // visual-polish #3b: past the crease-fade near distance, a crease needs both of its faces thinPx pixels thick (an
  // occlusion edge, a depth step of over 4 percent of the distance, always counts).
  let thinPx = i32(round(params.camEye.w));
  let thinOn = thinPx >= 2 && params.extra.z > params.extra.y && cDist > params.extra.y;
  var creaseHit = false;   // a crease neighbour was found (a silhouette neighbour later still wins at full ink)
  var creaseCov = 1.0;

  // PERF (audit 5.3): once any neighbor confirms an edge, no further tap can
  // change the result, so bail out of both loops immediately. Interior pixels
  // (the common case) still scan the full window, but edge pixels stop after
  // the first hit instead of paying all (2w+1)^2 - 1 taps. The || below
  // short-circuits, so loadNormal is skipped for background neighbors exactly
  // like the old if/else-if structure. Output is bit-identical to the
  // exhaustive scan: isEdge is a pure any-of over the same taps.
  for (var dy: i32 = -r; dy <= r && !isEdge; dy = dy + 1) {
    for (var dx: i32 = -r; dx <= r; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let nc = c + vec2<i32>(dx, dy);
      // Silhouette: neighbor is background. Hard crease: neighbor is mesh but
      // its normal diverges sharply from the center normal.
      if (loadDepth(nc) >= FAR) {
        isEdge = true;
        edgeCov = min(loadCoverage(c), loadCoverage(nc));
        break;
      }
      if (creaseHit) { continue; }
      // FOLIAGE MODES (visual-polish #3): 'full' = the plain crease test; 'silhouette' = no ink between two foliage
      // pixels, always ink where foliage meets non-foliage; 'off' = never ink against foliage.
      let nN4 = loadNormalF(nc);
      let nFol = nN4.w > 0.5;
      var crease = dot(centerNormal, nN4.xyz) < CREASE_DOT;
      if (folMode != 0u && (cFol || nFol)) { crease = folMode == 1u && cFol != nFol; }
      if (crease && thinOn && !creaseThick(c, nc, centerNormal, nN4.xyz, thinPx)) {
        crease = abs(eyeDist(nc) - cDist) > cDist * 0.04;
      }
      if (crease) {
        creaseHit = true;
        creaseCov = min(loadCoverage(c), loadCoverage(nc));
        if (creaseA >= 0.999) { isEdge = true; edgeCov = creaseCov; break; }   // no fade: first hit wins (the original early-out)
      }
    }
  }
  // A faded crease (no silhouette neighbour found): ink at the crease alpha.
  var edgeA = 1.0;
  if (!isEdge && creaseHit) { isEdge = true; edgeCov = creaseCov; edgeA = creaseA; }

  let alpha = select(0.0, params.color.a * edgeCov * fadeA * edgeA, isEdge);
  return vec4<f32>(params.color.rgb * alpha, alpha);
}

`;

// ── Composite shader ──────────────────────────────────────────────────────────

/**
 * Blends the edge mask over the current render pass via a fullscreen triangle.
 * Edge texture is pre-multiplied-alpha RGBA — use (ONE, ONE_MINUS_SRC_ALPHA) blend.
 * Bind group 0: binding 0 = texture_2d<f32>  (Sobel edge mask)
 */
export const OUTLINE_COMPOSITE_SHADER = /* wgsl */`

@group(0) @binding(0) var edgeTex: texture_2d<f32>;

struct VertOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VertOut {
  var positions = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0),
  );
  return VertOut(vec4<f32>(positions[vi], 0.0, 1.0));
}

@fragment fn fs(in: VertOut) -> @location(0) vec4<f32> {
  return textureLoad(edgeTex, vec2<i32>(floor(in.pos.xy)), 0);
}

`;
