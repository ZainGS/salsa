/**
 * WGSL shaders for 3D mesh rendering — Cook-Torrance PBR + SH-based IBL.
 *
 * Lighting model (renderStyle == 0 "default"):
 *  - Cook-Torrance BRDF: GGX NDF + Smith geometry + Schlick Fresnel
 *  - Direct: single directional light (scene.lightDirection / lightColor)
 *  - Ambient (IBL off): constant ambient from scene.ambientColor
 *  - Ambient (IBL on):  SH L0+L1+L2 irradiance from ibl.shCoeffs (9 vec4<f32>)
 *
 * Render styles (bits 2-3 of material flags — see material-3d.ts):
 *  0 = default   Cook-Torrance PBR (replaces Phong/Gouraud)
 *  1 = cel       toon shading (stepped diffuse bands + hard specular)
 *  2 = sketch    crosshatch shading (pencil-drawn look)
 *  3 = ink       flat + silhouette rim darkening (manga look)
 *
 * Vertex format: position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4) = 48 bytes
 *
 * Uniform layout:
 *  Bind group 0, binding 0: per-mesh instance storage buffer (model matrix, material, roughness, metalness)
 *  Bind group 0, binding 1: scene-wide uniform buffer (viewProj, camera, lights, PS1 params)
 *  Bind group 0, binding 2: IBL uniform buffer (SH coefficients, iblEnabled, iblIntensity)
 *  Bind group 1, binding 0: diffuse texture
 *  Bind group 1, binding 1: diffuse sampler
 *  Bind group 1, binding 2: normal map texture  (flat-normal 1×1 default when not set)
 *  Bind group 1, binding 3: normal map sampler
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';
import { CROWD_PALETTE_WGSL } from '../crowd-palette';

// ── Shared PBR + IBL WGSL (included in both fragment shader variants) ──────

const PBR_IBL_WGSL = /* wgsl */`

struct IBLUniforms {
  shCoeffs:    array<vec4<f32>, 9>,  // L0+L1+L2 SH irradiance coefficients (rgb, w unused)
  iblEnabled:  f32,                  // 0 = off (use scene.ambientColor), 1 = on
  iblIntensity:f32,                  // DIFFUSE ambient scale (the SH irradiance on matte surfaces)
  iblSpecularEnabled: f32,           // 0 = SH-probe specular (soft), 1 = prefiltered cubemap specular (crisp, split-sum)
  specularMaxMip: f32,               // highest mip index of the prefiltered cube (roughness 1) — roughness*this = LOD
  iblSpecularIntensity: f32,         // SPECULAR (reflection) scale — INDEPENDENT of diffuse, so the two can be balanced
  ssrEnabled: f32,                   // 1 = ray-march the on-screen scene for reflections (composited over the cube)
  ssrMaxSteps: f32,                  // ray-march iteration count
  ssrStride: f32,                    // world-space step length per iteration
  ssrThickness: f32,                 // hit tolerance behind a surface (world units)
  ssrIntensity: f32,                 // SSR contribution over the cubemap fallback (0..1)
  ssrMaxRoughness: f32,              // surfaces rougher than this skip SSR
  ssrDebug: f32,                     // 1 = visualize SSR hit UV (red=u, green=v) instead of the reflected colour
  ssrFillBlur: f32,                  // backface-fill INTERNAL blur radius (half-res texels; 0 = sharp)
  ssrEdgeFeather: f32,               // backface-fill EDGE feather ring radius (half-res texels; 0 = hard edge)
  ssrDepthPeel: f32,                 // 1 = backface-fill uses the depth-peel BACK layer (volume membership test)
  ssrFallbackShadow: f32,            // silhouette-solidify strength 0..1 (0 = off) - back-layer borrowing opacity
  ssrDeferred: f32,                  // 1 = sample the half-res resolve pass result (Stage 3b); 0 = inline trace
  dbgShade: f32,                     // RENDER DEBUG (render-debug.ts): 0 = off, 1 = unlit, 2 = constant colour, 3 = magenta, 4-6 read tests, 7 grey, 8 white, 9 normal
  dbgFlags: f32,                     // RENDER DEBUG bits (render-debug.ts): 1 = clamp the texture-array layer indices, 2 = NaN / Inf highlight, 4 = safe lighting maths
  _fpad5: f32,
};

@group(0) @binding(2) var<uniform> ibl: IBLUniforms;

// RENDER DEBUG dbgNanCheck (render-debug.ts; ibl.dbgFlags value 2): the lit path's final colour goes through dbgFinal.
// NaN / Inf is tested on the BITS (exponent all ones), never with x != x, which a compiler may fold to false.
// rdState: 0 = fine, 1 = out of range (a channel above 4 or below -0.01), 2 = NaN or Inf in any channel.
fn rdState(v: vec4<f32>) -> u32 {
  let e = bitcast<vec4<u32>>(v) & vec4<u32>(0x7f800000u);
  let nonFinite = any(e == vec4<u32>(0x7f800000u));
  let outOfRange = any(v > vec4<f32>(4.0)) || any(v < vec4<f32>(-0.01));
  return select(select(0u, 1u, outOfRange), 2u, nonFinite);
}
// Off (bit clear, a uniform test): returns c untouched. On: GREEN where c or the earlier state pre (rdState of the
// unclamped lit colour, 0 when not measured) is NaN / Inf, CYAN where it is only out of range.
fn dbgFinal(c: vec4<f32>, pre: u32) -> vec4<f32> {
  if ((u32(ibl.dbgFlags) & 2u) == 0u) { return c; }
  let st = max(pre, rdState(c));
  return select(select(c, vec4<f32>(0.0, 1.0, 1.0, 1.0), st == 1u), vec4<f32>(0.0, 1.0, 0.0, 1.0), st == 2u);
}
// Prefiltered specular environment (P1b): the sky convolved with the GGX lobe per roughness (mip chain), + the
// environment-independent split-sum BRDF LUT (rg = scale, bias). Sampled with EXPLICIT LOD (textureSampleLevel) so
// the specular branch stays uniformity-safe inside envSpecular's non-uniform call site. 1x1 dummies when not baked.
@group(0) @binding(7) var prefilteredEnvMap: texture_cube<f32>;
@group(0) @binding(8) var iblCubeSampler:    sampler;
@group(0) @binding(9) var brdfLUT:           texture_2d<f32>;
// Scene color (prev frame) + its sampler (also used by glass refraction in the body) and the SSR world-position
// prepass. Declared HERE (before traceSSR/envSpecular use them) rather than in each FS template.
@group(0) @binding(5) var sceneColorTexture: texture_2d<f32>;
@group(0) @binding(6) var sceneColorSampler: sampler;
@group(0) @binding(10) var ssrWorldPosTex:   texture_2d<f32>;   // rgba32float world position (.w=1 surface); read via textureLoad
@group(0) @binding(11) var ssrWorldPosBackTex: texture_2d<f32>; // depth-peel SECOND layer (backface-fill volume test); 1x1 dummy when off
@group(0) @binding(12) var ssrNormalTex:     texture_2d<f32>;   // prepass NORMAL+material target (deferred resolve input); 1x1 dummy when off
@group(0) @binding(13) var ssrReflectionTex: texture_2d<f32>;   // deferred SSR result (colour + fade, half-res); 1x1 dummy when off
@group(0) @binding(14) var planarReflectionTex: texture_2d<f32>; // P4b planar mirror pass result (full-res); 1x1 dummy when off

// One probe along the SSR ray's SCREEN-SPACE line at param s in [0,1] — the WGSL twin of the CPU reference in
// src/renderer/3d/ssr-trace.ts (probeS). That file is UNIT-TESTED against analytic mirror optics; KEEP IN LOCKSTEP.
// uv is linear in s (screen-space parameterization); the ray's world point is recovered projective-correctly as
// Q(s)/k(s) with Q = worldPos/w and k = 1/w interpolated linearly. Depth comparisons are along the camera-forward
// axis only (Euclidean distance folded the half-res buffer's lateral texel quantization into the test → stripes).
// The reflector's own plane is rejected here (offPlane vs the UNBIASED start, tiny epsilon → self-hits/echo dead,
// near-coplanar targets kept). uv at any s is just mix(uv0, uv1, s), so it isn't returned.
// Returns vec4(rayDepth, surfDepth, surfValid, backDepth): y valid only when z = 1; w = the depth of the peel's
// SECOND layer at that texel, or -1e30 when there is none (open geometry / peel off -> the shell fallback).
fn ssrProbeS(s: f32, uv0: vec2<f32>, uv1: vec2<f32>, k0: f32, k1: f32, Q0: vec3<f32>, Q1: vec3<f32>,
             startPos: vec3<f32>, N: vec3<f32>, fwd: vec3<f32>, dims: vec2<f32>, minOffPlane: f32) -> vec4<f32> {
  let uv = mix(uv0, uv1, s);
  let k = mix(k0, k1, s);
  let rayP = mix(Q0, Q1, s) / k;                                          // projective-correct ray point at this texel
  let rayDepth = dot(fwd, rayP);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec4<f32>(rayDepth, 0.0, 0.0, -1.0e30); }
  let px = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999)) * dims);
  let sw = textureLoad(ssrWorldPosTex, px, 0);
  if (sw.w <= 0.5) { return vec4<f32>(rayDepth, 0.0, 0.0, -1.0e30); }     // background
  let offPlane = abs(dot(sw.xyz - startPos, N));                          // reflector's own plane → self-hit, reject
  if (offPlane <= minOffPlane) { return vec4<f32>(rayDepth, 0.0, 0.0, -1.0e30); }
  // The REFLECTOR'S OWN PLANE is rejected as a back layer too: at silhouette-edge texels an object's exit
  // fragment can be missing (nearly edge-on face, half-res) leaving the scene BEHIND as the second layer - a
  // degenerate [object-front, reflector] column that admits deep rays (thin false-fill LINES on the mirror).
  let bw = textureLoad(ssrWorldPosBackTex, px, 0);
  let backOk = bw.w > 0.5 && abs(dot(bw.xyz - startPos, N)) > minOffPlane;
  var backDepth = select(-1.0e30, dot(fwd, bw.xyz), backOk);
  var validCode = 1.0;
  // BACK-LAYER BORROWING (ssrFallbackShadow > 0; mirrors ssr-trace.ts): a missing second layer at an ON-OBJECT
  // texel is dropout (a grazing/subpixel exit face) - borrow the shallowest valid neighbour back. z code 2 marks
  // borrowed evidence; fills admitted on it paint at slider strength. Only on-object texels reach this point,
  // so the extra taps cost nothing on background.
  if (backDepth < -1.0e29 && ibl.ssrFallbackShadow > 0.001) {
    for (var nb = 0; nb < 4; nb = nb + 1) {
      var doff = vec2<i32>(1, 0);
      if (nb == 1) { doff = vec2<i32>(-1, 0); }
      if (nb == 2) { doff = vec2<i32>(0, 1); }
      if (nb == 3) { doff = vec2<i32>(0, -1); }
      let npx = clamp(px + doff, vec2<i32>(0), vec2<i32>(dims) - vec2<i32>(1));
      let nbw = textureLoad(ssrWorldPosBackTex, npx, 0);
      if (nbw.w > 0.5 && abs(dot(nbw.xyz - startPos, N)) > minOffPlane) {
        let nd = dot(fwd, nbw.xyz);
        if (backDepth < -1.0e29 || nd < backDepth) { backDepth = nd; validCode = 2.0; }
      }
    }
  }
  return vec4<f32>(rayDepth, dot(fwd, sw.xyz), validCode, backDepth);
}

// Screen-space reflections (P2): march the reflection ray in FIXED steps and take the FIRST sample that sits just
// behind an on-screen surface, then BISECT within that single stride to pin the exact hit (kills the step-banding
// that painted staggered copies of small objects, without global crossing logic — refinement never leaves the stride
// that already validated a hit, so it cannot jump to another surface and ghost). The ray ORIGIN is biased off the
// surface along the fragment normal (see the call site) so the half-res world-pos buffer cannot produce false
// SELF-hits at grazing angles — those sampled the reflector's own previous-frame pixels (which already contain its
// rendered reflection) and echoed fading extra copies. Projection-agnostic (NDC depth) → correct in perspective AND
// ortho. Returns reflected colour + edge-fade confidence in .a (0 = miss). textureLoad / textureSampleLevel only
// (explicit LOD) → uniformity-safe in envSpecular's non-uniform branch.
// Screen-space DDA trace — the WGSL twin of ssr-trace.ts traceSSRRef (unit-tested; KEEP IN LOCKSTEP). The reflection
// ray is projected ONCE and the march walks its projected line ~one buffer texel per step with projective-correct
// depth. (A fixed WORLD stride sampled steeply-receding surfaces — e.g. a cube top seen at grazing reflection
// angles — with uneven screen spacing: acceptance flickered per fragment = striped reflections. Per-texel screen
// traversal tests every texel along the reflection exactly once: no phase, no stripes, no thin-object skip.)
fn traceSSR(startPos: vec3<f32>, N: vec3<f32>, dir: vec3<f32>, viewProj: mat4x4<f32>) -> vec4<f32> {
  let dims = vec2<f32>(textureDimensions(ssrWorldPosTex));
  let maxSteps = i32(ibl.ssrMaxSteps);
  let stride = max(ibl.ssrStride, 0.001);
  let origin = startPos + N * (stride * 0.5);                  // lift off the surface (self-hit guard)
  // Camera-forward axis in WORLD space (unit, pointing away from the camera) for the depth-only comparison.
  // Perspective encodes it in the matrix's w-row (clip.w = view depth); ortho's w-row is zero, so use the z-row
  // (ndc.z is linear in ortho) — the same convention the ortho view-ray V above uses.
  let wvec = vec3<f32>(viewProj[0].w, viewProj[1].w, viewProj[2].w);
  let zvec = vec3<f32>(viewProj[0].z, viewProj[1].z, viewProj[2].z);
  let wlen = length(wvec);
  let fwd = select(zvec / max(length(zvec), 1e-6), wvec / max(wlen, 1e-6), wlen > 1e-4);
  let minOffPlane = stride * 0.25;
  let maxDist = f32(maxSteps) * stride;                        // world reach (same semantics as the old world march)

  // Clip the world segment so the far end stays in front of the camera (clip.w is linear along the world ray).
  var end = origin + dir * maxDist;
  let c0 = viewProj * vec4<f32>(origin, 1.0);
  if (c0.w <= 1e-4) { return vec4<f32>(0.0); }
  var c1 = viewProj * vec4<f32>(end, 1.0);
  if (c1.w <= 1e-4) {
    let f = (c0.w - 1e-3) / (c0.w - c1.w);
    end = origin + dir * (maxDist * f);
    c1 = viewProj * vec4<f32>(end, 1.0);
  }

  let uv0 = (c0.xy / c0.w) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  let uv1 = (c1.xy / c1.w) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);

  // Clip the s-range to the screen rect (uv is linear in s) — march only the visible portion of the line.
  var s0 = 0.0;
  var s1 = 1.0;
  for (var axis = 0; axis < 2; axis = axis + 1) {
    let a = select(uv0.y, uv0.x, axis == 0);
    let d = select(uv1.y - uv0.y, uv1.x - uv0.x, axis == 0);
    if (abs(d) < 1e-9) {
      if (a < 0.0 || a > 1.0) { return vec4<f32>(0.0); }
    } else {
      var lo = (0.0 - a) / d;
      var hi = (1.0 - a) / d;
      if (lo > hi) { let tmp = lo; lo = hi; hi = tmp; }
      s0 = max(s0, lo);
      s1 = min(s1, hi);
    }
  }
  if (s0 >= s1) { return vec4<f32>(0.0); }

  // STRICTLY ~1 buffer texel per step. The budget caps the REACH (how far the march goes), never the density:
  // stretching maxSteps across a long line made steps span several texels with huge perspective depth ranges — the
  // range test degenerated into a fat box and accepted any off-plane surface along the way (long smeared ghosts).
  let pix = (uv1 - uv0) * (s1 - s0) * dims;
  let pixLen = length(pix);
  let marchTexels = min(pixLen, f32(maxSteps));
  let sEnd = s0 + (s1 - s0) * (marchTexels / max(pixLen, 1e-6));
  let numSteps = max(1, i32(ceil(marchTexels)));

  // Projective-correct interpolation attributes.
  let k0 = 1.0 / c0.w;
  let k1 = 1.0 / c1.w;
  let Q0 = origin * k0;
  let Q1 = end * k1;

  // FRONT-SIDE-CROSSING acceptance (mirrors ssr-trace.ts). The world-pos buffer stores only CAMERA-FACING surfaces,
  // and the crossing DIRECTION of f = rayDepth - surfDepth carries the facing information we don't store:
  //   front-to-behind (f: - to +) = the ray pushes INTO the surface from the camera side = a legitimate hit.
  //   behind-to-front (f: + to -) = the ray EXITS through the surface's BACK - a face no real reflection can see
  //   (a floor ray rising up through a cube's TOP face, or a wall-mirror ray exiting an object's volume). Accepting
  //   those painted the "taller than the object" ghosts + stripes; rejected outright, so impossible cases (true wall
  //   mirrors) cleanly fall back to the cubemap. No depth window/thickness pad needed - a crossing is exact.
  // BACKFACE-FILL gate (mirrors ssr-trace.ts): the fill arms only when the reflected ray heads back TOWARD the
  // camera — the geometry where a reflection shows backsides (wall mirrors, steep look-down floors). Glancing floor
  // rays (heading away) keep the gate closed so the back-exit ghost family cannot return there.
  // Direction gate: blocks the back-exit ghost family on rays heading AWAY from the camera (glancing floors).
  // PEEL mode arms almost immediately - volume-membership proof does the legitimacy work, and the conservative
  // ramp (0.15..0.45) translucent-washed ENTIRE fills at 30-45 degree mirror views: ungated primary rim hits
  // stayed bright while the gated interior washed out = the "hollow at angles" look.
  let toCam = -dot(dir, fwd);
  let peel = ibl.ssrDepthPeel > 0.5;
  let backGate = select(smoothstep(0.15, 0.45, toCam), smoothstep(0.02, 0.12, toCam), peel);
  // Back-layer slack BASE: tolerates the peel buffer's half-res depth quantization WITHOUT re-creating a depth
  // band - a generous slack re-admits thin-object skimmers, the very trail family the peel exists to kill. Each
  // march step widens it by the LOCAL back-depth gradient (steep back surfaces flicker per texel under a fixed
  // tolerance - hatched/serrated fills), capped so object-boundary jumps can't blow the test open.
  let epsB0 = stride * 0.25;
  let gT = max(ibl.ssrThickness, 1e-4);
  var candS = -1.0;
  var candUv = vec2<f32>(0.0);
  var candFB = 0.0;                  // how far the candidate stayed BEHIND the surface (0 = exact exit)
  var candShell = false;             // true = admitted via the thickness-SHELL fallback -> depth feather applies
  var candBorrowed = false;          // true = admitted on BORROWED back evidence -> paints at slider strength
  var candLocked = false;            // stops upgrading once its surface region ends (or an exact exit was found)

  var prev = ssrProbeS(s0, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
  var sPrev = s0;
  for (var i = 1; i <= numSteps; i = i + 1) {
    let s = s0 + (sEnd - s0) * f32(i) / f32(numSteps);
    let cur = ssrProbeS(s, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
    if (cur.z > 0.5) {
      let fA = prev.x - select(cur.y, prev.y, prev.z > 0.5);
      let fB = cur.x - cur.y;
      if (fA <= 0.0 && fB > 0.0) {
        // Bisect to the exact front-side crossing within this step (track the behind-side probe for validation).
        var lo = sPrev;
        var hi = s;
        var mB = cur;
        for (var kk = 0; kk < 6; kk = kk + 1) {
          let ms = 0.5 * (lo + hi);
          let m = ssrProbeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
          let fm = select(fA, m.x - m.y, m.z > 0.5);
          if (fm > 0.0) { hi = ms; mB = m; } else { lo = ms; }
        }
        let huv = mix(uv0, uv1, hi);
        // OVER-PASS VALIDATION (Euclidean, slope-aware; mirrors ssr-trace.ts): a depth-crossing only proves the
        // ray entered this texel's depth COLUMN - a shallow away-heading floor ray passing OVER an object crosses
        // its column inside the silhouette too (debug-confirmed: the long stretched-column ghosts trailing floor
        // reflections were all primary hits). A genuine hit's ray point coincides with the stored surface point
        // to within texel quantization; an over-passer is offset by the object's own scale. Radius scales with
        // the surface's local world-per-texel so steeply receding surfaces (grazing cube tops) stay accepted.
        // (Euclidean is banned as the MARCH acceptance test - per-texel flicker; this validates ONE crossing.)
        let mH = ssrProbeS(hi, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
        let hitPx = vec2<i32>(clamp(huv, vec2<f32>(0.0), vec2<f32>(0.99999)) * dims);
        let hitSw = textureLoad(ssrWorldPosTex, hitPx, 0);
        let rayPH = mix(Q0, Q1, hi) / mix(k0, k1, hi);
        let pUv = clamp(mix(uv0, uv1, sPrev), vec2<f32>(0.0), vec2<f32>(0.99999));
        let cUv = clamp(mix(uv0, uv1, s), vec2<f32>(0.0), vec2<f32>(0.99999));
        let pSw = textureLoad(ssrWorldPosTex, vec2<i32>(pUv * dims), 0);
        let cSw = textureLoad(ssrWorldPosTex, vec2<i32>(cUv * dims), 0);
        let surfStep = select(0.0, distance(cSw.xyz, pSw.xyz), pSw.w > 0.5 && cSw.w > 0.5);
        let allow = max(3.0 * surfStep, 2.0 * stride);
        // COLUMN-ENTRY validation (the Euclidean check's complement; mirrors ssr-trace.ts): the slope-scaled
        // radius is exactly as loose as the surface is steep - steep texels (sphere limbs) accept over-passers
        // by Euclid alone, but their depth columns are near-zero: a genuine entrant is inside [front, back]
        // just past the crossing while a skimmer is already beyond the back. Over-passers above FLAT deep
        // columns (cube tops) pass membership but fail Euclid. Each ghost family fails one; real hits pass both.
        let pSlope = select(0.0, abs(cur.w - prev.w), cur.w > -1.0e29 && prev.w > -1.0e29);
        let entryBack = select(mB.w, mB.y + gT, mB.w < -1.0e29);
        let epsP = max(epsB0, min(min(pSlope * 0.75, stride * 2.0), max(0.0, (entryBack - mB.y) * 0.5)));
        let memberOK = mB.z > 0.5 && mB.x <= entryBack + epsP;
        if (memberOK && mH.z > 0.5 && distance(rayPH, hitSw.xyz) <= allow) {
          if (ibl.ssrDebug > 0.5) { return vec4<f32>(huv.x, huv.y, 0.0, 1.0); }   // debug: hit UV as red/green
          let e = min(min(huv.x, 1.0 - huv.x), min(huv.y, 1.0 - huv.y));
          // Edge fade (data runs out at screen borders) x REACH fade (hits in the last 25% of the marched range
          // ease toward the cubemap — otherwise the reach limit cuts reflections with a hard, zoom-dependent seam.
          let frac = (hi - s0) / max(sEnd - s0, 1e-9);
          let fade = smoothstep(0.0, 0.08, e) * (1.0 - smoothstep(0.75, 1.0, frac));
          return vec4<f32>(textureSampleLevel(sceneColorTexture, sceneColorSampler, huv, 0.0).rgb, fade);
        }
        // Over-passer: not a hit - keep marching (the ray may genuinely strike something farther along).
      }
      if (backGate > 0.001 && !candLocked) {
        if (peel) {
          // DEPTH-PEELED backface-fill (mirrors ssr-trace.ts): a candidate needs PROVEN volume membership -
          // front <= rayDepth <= back(+eps). Texels with no back layer (open/thin geometry) substitute a
          // thickness shell (candShell -> the squared depth feather still applies; proven members paint full).
          let slopeOk = cur.w > -1.0e29 && prev.w > -1.0e29;
          let slope = select(0.0, abs(cur.w - prev.w), slopeOk);
          // Slope widening is CLAMPED to half the local column depth (see the per-branch eps below): near a
          // silhouette the column shrinks while the back gradient SPIKES - uncapped widening admitted rays
          // passing just OUTSIDE the object (under-object pass-bys = tall curtain smears at elevated cameras).
          let slopeEps = min(slope * 0.75, stride * 2.0);
          if (fA > 0.0 && fB <= 0.0) {
            // The ray pierced the front surface from behind. Bisect to the exact exit, then VALIDATE the pierce
            // with the last BEHIND-side probe: a genuine pierce is inside the volume just before the crossing; a
            // texel-boundary fake (ray behind object A while the next texel shows nearer object B) is beyond A's
            // back there. Also accepts one-step full pierces of thin volumes (prev sample beyond the back).
            var lo = sPrev;
            var hi = s;
            var mLo = prev;
            for (var kk = 0; kk < 6; kk = kk + 1) {
              let ms = 0.5 * (lo + hi);
              let m = ssrProbeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
              let fm = select(fA, m.x - m.y, m.z > 0.5);
              if (fm > 0.0) { lo = ms; mLo = m; } else { hi = ms; }
            }
            let loBack = select(mLo.w, mLo.y + gT, mLo.w < -1.0e29);
            let epsE = max(epsB0, min(slopeEps, max(0.0, (loBack - mLo.y) * 0.5)));
            let genuine = mLo.z > 0.5 && (mLo.x - mLo.y) > 0.0 && mLo.x <= loBack + epsE;
            if (genuine) {
              candS = hi;
              candUv = mix(uv0, uv1, hi);
              candFB = 0.0;
              candShell = false;
              candBorrowed = mLo.z > 1.5;
              candLocked = true;
            }
          } else if (fB > 0.0) {
            let shl = cur.w < -1.0e29;
            let effBack = select(cur.w, cur.y + gT, shl);
            let epsI = max(epsB0, min(slopeEps, max(0.0, (effBack - cur.y) * 0.5)));
            if (cur.x <= effBack + epsI && (candS < 0.0 || fB < candFB)) {
              candS = s;                     // in-volume sample (covers exits via camera-invisible faces)
              candUv = mix(uv0, uv1, s);
              candFB = fB;
              candShell = shl;
              candBorrowed = cur.z > 1.5;
            }
          }
        } else if (fA > 0.0 && fB <= ibl.ssrThickness) {
          // SINGLE-LAYER heuristic (the setSSRDepthPeeling(false) escape hatch): BACK-EXIT or NEAR-EXIT within
          // ssrThickness behind the surface. The candidate UPGRADES while the ray keeps approaching (fB shrinking)
          // and LOCKS at an exact exit. The near-exit band soft-fills grazing silhouettes at the cost of the
          // tangent-skimmer TRAIL family, which the squared depth feather can only dim.
          if (fB <= 0.0) {
            var lo = sPrev;
            var hi = s;
            for (var kk = 0; kk < 6; kk = kk + 1) {
              let ms = 0.5 * (lo + hi);
              let m = ssrProbeS(ms, uv0, uv1, k0, k1, Q0, Q1, startPos, N, fwd, dims, minOffPlane);
              let fm = select(fA, m.x - m.y, m.z > 0.5);
              if (fm > 0.0) { lo = ms; } else { hi = ms; }
            }
            candS = hi;
            candUv = mix(uv0, uv1, hi);
            candFB = 0.0;
            candShell = true;
            candBorrowed = false;
            candLocked = true;
          } else if (candS < 0.0 || fB < candFB) {
            candS = s;                       // near-exit: the sample as-is (fills are blurred; sub-texel precision unneeded)
            candUv = mix(uv0, uv1, s);
            candFB = fB;
            candShell = true;
            candBorrowed = false;
          }
        }
      }
    } else if (candS >= 0.0 && !candLocked) {
      candLocked = true;                   // left the candidate's surface region — no closer approach is coming
    }
    prev = cur;
    sPrev = s;
  }
  if (candS >= 0.0) {
    if (ibl.ssrDebug > 0.5) { return vec4<f32>(candUv.x, candUv.y, select(0.5, 0.75, candBorrowed), 1.0); }   // debug: fill UV (blue tinge; 0.75 = borrowed)
    let e = min(min(candUv.x, 1.0 - candUv.x), min(candUv.y, 1.0 - candUv.y));
    let frac = (candS - s0) / max(sEnd - s0, 1e-9);
    // FULL strength: the fill must match true-hit luminance — a dimmer middle against full-strength edge hits reads
    // as a CONCAVE/hollow object (shading gradient = shape cue). Softness comes from the blur, not from dimming.
    // DEPTH feather (SQUARED), SHELL candidates only: without a back layer, trails and shallow volume passages
    // are a continuum no scalar separates (three guard designs each failed a case) — the feather dims the band's
    // outer edge. PROVEN volume members (depth-peel, candShell=false) paint full strength: their legitimacy is
    // exact, and dimming them read as concave/hollow objects.
    var depthFeather = 1.0;
    if (candShell) {
      let df = 1.0 - smoothstep(0.0, gT, max(candFB, 0.0));
      depthFeather = df * df;
    }
    // SCREEN-SPACE COVERAGE feather (the Edge-Feather slider): probe a ring around the fill uv in the world-pos
    // buffer; alpha follows the fraction of neighbours on-object — interior solid, silhouette fades across the ring.
    // (Widening the DEPTH band instead admitted rays passing behind objects -> elongated smears, not feathering.)
    // Slider-driven EDGE FEATHER ring: fraction of ring neighbours on-object drives silhouette alpha.
    var coverage = 1.0;
    if (ibl.ssrEdgeFeather > 0.01) {
      var on = 0.0;
      for (var kk = 0; kk < 8; kk = kk + 1) {
        let ang = f32(kk) * 0.7853981634;
        let tuv = candUv + vec2<f32>(cos(ang), sin(ang)) * (ibl.ssrEdgeFeather / dims);
        if (tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
          let tpx = vec2<i32>(clamp(tuv, vec2<f32>(0.0), vec2<f32>(0.99999)) * dims);
          let tsw = textureLoad(ssrWorldPosTex, tpx, 0);
          if (tsw.w > 0.5 && abs(dot(tsw.xyz - startPos, N)) > minOffPlane) { on = on + 1.0; }
        }
      }
      coverage = smoothstep(0.35, 0.95, on / 8.0);
    }
    // Borrowed-evidence fills paint at ssrFallbackShadow strength (the artist's solidify slider).
    let borrowScale = select(1.0, clamp(ibl.ssrFallbackShadow, 0.0, 1.0), candBorrowed);
    let fade = smoothstep(0.0, 0.08, e) * (1.0 - smoothstep(0.75, 1.0, frac)) * backGate * depthFeather * coverage * borrowScale;
    // VALIDITY-WEIGHTED 5-tap blur, radius = ssrFillBlur half-res texels (0 = all taps coincide = sharp). Taps whose
    // world-pos texel is OFF the object (background/reflector plane) are excluded from the average — a plain box blur
    // pulled the dark background into the fill's edges (visible edge darkening).
    let o = ibl.ssrFillBlur / dims;
    var col = textureSampleLevel(sceneColorTexture, sceneColorSampler, candUv, 0.0).rgb;
    var wsum = 1.0;
    for (var bt = 0; bt < 4; bt = bt + 1) {
      var off = vec2<f32>(o.x, 0.0);
      if (bt == 1) { off = vec2<f32>(-o.x, 0.0); }
      if (bt == 2) { off = vec2<f32>(0.0, o.y); }
      if (bt == 3) { off = vec2<f32>(0.0, -o.y); }
      let tuv = candUv + off;
      if (tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
        let tpx = vec2<i32>(clamp(tuv, vec2<f32>(0.0), vec2<f32>(0.99999)) * dims);
        let tsw = textureLoad(ssrWorldPosTex, tpx, 0);
        if (tsw.w > 0.5 && abs(dot(tsw.xyz - startPos, N)) > minOffPlane) {
          col = col + textureSampleLevel(sceneColorTexture, sceneColorSampler, tuv, 0.0).rgb;
          wsum = wsum + 1.0;
        }
      }
    }
    return vec4<f32>(col / wsum, fade);
  }
  return vec4<f32>(0.0);
}

const PBR_PI: f32 = 3.14159265359;

// GGX (Trowbridge-Reitz) normal distribution function
fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
  let a  = roughness * roughness;
  let a2 = a * a;
  let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PBR_PI * d * d);
}

// Smith-Schlick-GGX geometry term (one lobe)
fn G_SchlickGGX(NdotX: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  return NdotX / (NdotX * (1.0 - k) + k);
}

// Smith combined geometry (both view and light lobes)
fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return G_SchlickGGX(max(NdotV, 0.0001), roughness) *
         G_SchlickGGX(max(NdotL, 0.0001), roughness);
}

// Schlick Fresnel approximation
fn F_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

// Roughness-aware Fresnel for the ambient/environment specular term (rough surfaces don't get a harsh grazing rim).
fn F_SchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * f;
}

// Evaluate L0+L1+L2 SH irradiance.  Coefficients must be pre-multiplied by the
// Ramamoorthi & Hanrahan (2001) cosine-lobe ZH factors (baked CPU-side).
fn evalSHIrradiance(N: vec3<f32>) -> vec3<f32> {
  let x = N.x; let y = N.y; let z = N.z;
  // Normalization constants: Y00=0.2821, Y1x=0.4886, Y2-2/Y2-1/Y21=1.0925, Y20=0.3154, Y22=0.5463
  var e: vec3<f32> =
      0.282095 * ibl.shCoeffs[0].rgb
    + 0.488603 * (ibl.shCoeffs[1].rgb * y + ibl.shCoeffs[2].rgb * z + ibl.shCoeffs[3].rgb * x)
    + 1.092548 * (ibl.shCoeffs[4].rgb * (x*y) + ibl.shCoeffs[5].rgb * (y*z) + ibl.shCoeffs[7].rgb * (x*z))
    + 0.315392 *  ibl.shCoeffs[6].rgb * (3.0*z*z - 1.0)
    + 0.546274 *  ibl.shCoeffs[8].rgb * (x*x - y*y);
  return max(e, vec3<f32>(0.0));
}

// Specular environment reflection — what makes METAL read as metal (it reflects the surroundings tinted by F0
// instead of going black off the key light) and gives dielectrics a subtle grazing sheen. Modulated by a
// roughness-aware Fresnel.
//   IBL on:  the SH irradiance is diffuse-convolved (low-frequency), so it doubles as a soft reflection probe
//            sampled along the reflection vector R.
//   IBL off: a cheap FAKE environment so metals still look reflective out-of-the-box (not flat-dark) — a soft
//            sky/ground hemisphere (floored so it is never black) + the key light reflected as a soft sun glint.
//            (L = direction toward the light; lightColor/lightIntensity = the key light.)
fn envSpecular(N: vec3<f32>, V: vec3<f32>, F0: vec3<f32>, roughness: f32, NdotV: f32,
               iblOn: bool, iblSpecIntensity: f32, ambientFlat: vec3<f32>,
               L: vec3<f32>, lightColor: vec3<f32>, lightIntensity: f32, worldPos: vec3<f32>, viewProj: mat4x4<f32>,
               planarOn: bool) -> vec3<f32> {
  let R = reflect(-V, N);
  var env: vec3<f32>;
  if (iblOn) {
    if (ibl.iblSpecularEnabled > 0.5) {
      // Split-sum specular IBL: prefiltered cube (roughness -> mip) x BRDF LUT (F0*scale + bias). The LUT already
      // carries the Fresnel term, so this branch returns directly WITHOUT the extra F_SchlickRoughness below.
      let lod  = clamp(roughness, 0.0, 1.0) * ibl.specularMaxMip;
      var reflColor = textureSampleLevel(prefilteredEnvMap, iblCubeSampler, R, lod).rgb;   // cubemap fallback
      // SSR: where the reflection ray hits on-screen geometry, use the actual SCENE colour; composite over the cube.
      // P4b PLANAR mirror: exact reflection from the mirrored render pass - it lines up with the main view
      // pixel-for-pixel (project(VP*M, P) = project(VP, virtualImage(P))), so sample at this fragment's own
      // screen position. Alpha 0 = nothing rendered there -> the cubemap shows through. Priority: planar > SSR.
      if (planarOn) {
        let pclip = viewProj * vec4<f32>(worldPos, 1.0);
        if (pclip.w > 1e-4) {
          let puv = (pclip.xy / pclip.w) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
          if (puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0) {
            let pl = textureSampleLevel(planarReflectionTex, sceneColorSampler, puv, 0.0);
            reflColor = mix(reflColor, pl.rgb, pl.a);
          }
        }
      } else if (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) {   // strict: AT the cutoff roughFade is 0 anyway
        // DEFERRED (Stage 3b, default): the half-res RESOLVE pass already traced this surface - sample its
        // result at this fragment's screen uv (bilinear upsample; colour in .rgb, confidence/fade in .a).
        // setSSRDeferred3D(false) = the inline-trace escape hatch (identical algorithm, per-fragment cost).
        var ssr = vec4<f32>(0.0);
        if (ibl.ssrDeferred > 0.5) {
          let sclip = viewProj * vec4<f32>(worldPos, 1.0);
          if (sclip.w > 1e-4) {
            let suv = (sclip.xy / sclip.w) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
            if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
              ssr = textureSampleLevel(ssrReflectionTex, sceneColorSampler, suv, 0.0);
            }
          }
        } else {
          ssr = traceSSR(worldPos, N, R, viewProj);   // origin bias + self-plane rejection live inside traceSSR
        }
        // Roughness-graded: a smooth surface shows the SHARP screen reflection; a rougher one fades toward the
        // already-blurred cubemap (a cheap blur without mipping the scene-color grab). Zero at the roughness cutoff.
        let roughFade = 1.0 - smoothstep(0.0, ibl.ssrMaxRoughness, roughness);
        reflColor = mix(reflColor, ssr.rgb, clamp(ssr.a * ibl.ssrIntensity * roughFade, 0.0, 1.0));
      }
      let ab   = textureSampleLevel(brdfLUT, iblCubeSampler, vec2<f32>(clamp(NdotV, 0.0, 1.0), clamp(roughness, 0.0, 1.0)), 0.0).rg;
      return reflColor * (F0 * ab.x + vec3<f32>(ab.y)) * iblSpecIntensity;
    }
    env = max(evalSHIrradiance(R), vec3<f32>(0.0)) * iblSpecIntensity;
  } else {
    let envBase = max(ambientFlat, vec3<f32>(0.22));        // a floor so metal is lit, not black
    let up      = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);          // 0 = looking down (ground), 1 = up (sky)
    let sky     = envBase * mix(0.7, 1.3, up);               // hemisphere gradient → reflective variation
    let sun     = pow(max(dot(R, L), 0.0), 24.0);            // the key light reflected as a soft highlight
    env = sky + lightColor * lightIntensity * sun * 0.5;
  }
  return env * F_SchlickRoughness(NdotV, F0, roughness);
}

// Procedural geometric PATTERN mask (0..1) over the garment UV, ANALYTICALLY ANTIALIASED with fwidth so it stays
// crisp up close and resolves to the correct average at distance (no shimmer/moire). mode: 1 stripes · 2 dots ·
// 3 diamonds · 4 checker · 5 grid · 6 windows (handled by windowsPattern below) · 7 animated waves.
// params = (freq, angleRad, scale, spacing). albedo = mix(primary, secondary, mask). time = scene seconds.
fn patternMask(uv: vec2<f32>, mode: u32, params: vec4<f32>, time: f32) -> f32 {
  let freq = max(params.x, 0.001);
  let ca = cos(params.y); let sa = sin(params.y);
  let cc = uv - vec2<f32>(0.5);
  let p = vec2<f32>(cc.x * ca - cc.y * sa, cc.x * sa + cc.y * ca) * freq;   // rotated, scaled UV
  let dp = fwidth(p);                                  // screen-space change → AA width (computed before the branch)
  let w = max(dp.x, dp.y) + 1e-5;
  let scale = clamp(params.z, 0.02, 0.98);
  if (mode == 1u) {                                    // stripes
    return 1.0 - smoothstep(scale * 0.5 - w, scale * 0.5 + w, abs(fract(p.x) - 0.5));
  } else if (mode == 2u) {                             // dots
    return 1.0 - smoothstep(scale * 0.5 - w, scale * 0.5 + w, length(fract(p) - vec2<f32>(0.5)));
  } else if (mode == 3u) {                             // diamonds
    let cell = abs(fract(p) - vec2<f32>(0.5));
    return 1.0 - smoothstep(scale - w, scale + w, cell.x + cell.y);
  } else if (mode == 4u) {                             // checker
    let q = floor(p);
    return abs((q.x + q.y) - 2.0 * floor((q.x + q.y) * 0.5));
  } else if (mode == 5u) {                             // grid lines (spacing > 0.5 = SHINGLE variant, see below)
    var q = p;
    let shingle = params.w > 0.5;
    if (shingle) { q.x = q.x + step(0.5, fract(q.y * 0.5)) * 0.5; }   // stagger alternate rows half a cell (running bond)
    let cell = abs(fract(q) - vec2<f32>(0.5));
    let lw = scale * 0.5;
    var m = max(smoothstep(0.5 - lw - w, 0.5 - lw + w, cell.x), smoothstep(0.5 - lw - w, 0.5 - lw + w, cell.y));
    if (shingle) {
      // SHINGLE realism: the HORIZONTAL course line dominates (each row shadows the one below), vertical
      // joints stay subtle; every tile gets a hash shade; and a two-scale WEATHERING MOTTLE (large soft
      // patches + mid clusters) breaks the tiling so big roofs stop reading as one repeated texture.
      let courseShadow = smoothstep(0.5 - lw * 1.6 - w, 0.5 - lw * 0.4, cell.y) * 0.55;
      let id = floor(q);
      let tile = fract(sin(id.x * 127.1 + id.y * 311.7) * 43758.5453) - 0.5;
      let mot1 = fract(sin(dot(floor(q * 0.09), vec2<f32>(26.7, 63.1))) * 9157.33) - 0.5;
      let mot2 = fract(sin(dot(floor(q * 0.27), vec2<f32>(71.9, 13.7))) * 5417.11) - 0.5;
      m = clamp(m + courseShadow + tile * 0.34 + mot1 * 0.30 + mot2 * 0.18, 0.0, 1.0);
    }
    return m;
  } else if (mode == 7u) {                             // ANIMATED WAVES — big screens / water. spacing = scroll speed.
    // scale picks the WAVEFORM: <0.35 soft drifting bands (the wavy-bg vibe) · <0.65 zigzag sweep · else blocky
    // glitch scanlines — so a wall of screens can run visibly different animations from one shader mode.
    let spd = params.w;
    let ph = p.x + sin(p.y * 1.9 + time * spd * 0.7) * 0.7 + sin(p.y * 0.6 - time * spd * 0.23) * 0.5 - time * spd;
    if (scale < 0.35) { return 0.5 + 0.5 * sin(ph * 3.1416); }
    let tri = abs(fract(ph) - 0.5) * 2.0;
    if (scale < 0.65) { return tri * tri * (3.0 - 2.0 * tri); }
    return step(0.5, fract(ph * 2.0 + tri * 0.4));
  }
  if (mode == 6u) {
    // windows: the OPENING mask (inset rectangle per cell), so the FS relief gradient can bevel the reveal.
    // Uses windowsPattern's UNROTATED convention (uv*freq) so the groove aligns to the real window cells; for
    // mode 6 params.y is wallStyle (not an angle), so the rotated p above must not drive the window grid.
    let pw = uv * freq;
    let fw = fract(pw);
    let ins = winInsets(params);                                  // the SAME opening windowsPattern paints (sash / shop aware)
    let iwx = smoothstep(ins.x - w, ins.x + w, fw.x) * (1.0 - smoothstep(1.0 - ins.x - w, 1.0 - ins.x + w, fw.x));
    let iwy = smoothstep(ins.y - w, ins.y + w, fw.y) * (1.0 - smoothstep(1.0 - ins.z - w, 1.0 - ins.z + w, fw.y));
    return iwx * iwy;
  }
  return 0.0;
}

// AD SCREEN (pattern mode 7 with patternScale > 1.5, visual-polish #6): designed advert loops for the big building
// LED screens instead of the freq-9 waves that aliased into TV static. The CPU normalises each screen face to
// u = id + 0..1 across, v = 0..1 up (id = a per-building integer), so the layout fits the screen. Three layouts
// (product + slash + copy bars, bold blocky type + scrolling ticker, a split with a starburst) in a punchy Persona
// palette cut every ~6 s with a short flash. Every shape is an SDF anti-aliased by the uv footprint (fw = fwidth(uv),
// taken by the caller in uniform flow), and once the details go sub-pixel the screen settles to its average colour,
// so a distant screen is a clean coloured panel, never noise. No derivatives inside -> safe in branches.
fn ad_hash(n: f32) -> f32 { return fract(sin(n * 91.345 + 3.17) * 47453.5453); }
fn ad_pal(i: i32) -> vec3<f32> {
  var pal = array<vec3<f32>, 7>(
    vec3<f32>(0.90, 0.08, 0.12), vec3<f32>(0.06, 0.05, 0.07), vec3<f32>(0.96, 0.94, 0.90), vec3<f32>(1.0, 0.80, 0.10),
    vec3<f32>(0.10, 0.72, 0.90), vec3<f32>(0.92, 0.22, 0.62), vec3<f32>(1.0, 0.48, 0.10));
  return pal[((i % 7) + 7) % 7];
}
fn ad_box(p: vec2<f32>, c: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p - c) - b + vec2<f32>(r);
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn ad_fill(d: f32, w: f32) -> f32 { return 1.0 - smoothstep(-w, w, d); }
fn adScreen(uv: vec2<f32>, fw: vec2<f32>, aspect: f32, time: f32) -> vec3<f32> {
  let id = floor(uv.x);
  let A = aspect;
  let p = vec2<f32>(clamp(uv.x - id, 0.0, 1.0) * A, clamp(uv.y, 0.0, 1.0));   // screen-height units
  let w = max(max(fw.x * A, fw.y), 1e-4) * 1.2;                  // AA half-width in the same units
  let tt = time / 6.0 + ad_hash(id) * 7.0;
  let slot = floor(tt);
  let ph = tt - slot;
  let s = ad_hash(id * 13.1 + slot * 7.7);
  let lay = i32(floor(s * 3.0));
  let ia = i32(floor(ad_hash(s * 31.7) * 7.0));
  let ib = ia + 1 + i32(floor(ad_hash(s * 57.3) * 5.0));
  let ic = ib + 1 + i32(floor(ad_hash(s * 11.9) * 5.0));
  let ca = ad_pal(ia); let cb = ad_pal(ib); var cc = ad_pal(ic);
  if (all(cc == ca)) { cc = ad_pal(ic + 1); }
  let white = vec3<f32>(0.96, 0.94, 0.90);
  let black = vec3<f32>(0.05, 0.04, 0.06);
  let lumA = dot(ca, vec3<f32>(0.3, 0.55, 0.15));
  let ink = select(white, black, lumA > 0.5);                    // copy colour that reads on the background
  var col = ca;
  if (lay == 0) {
    // PRODUCT: a diagonal slash band, a big product disc with a white rim, three copy bars
    let n = normalize(vec2<f32>(0.55, -1.0));
    col = mix(col, cb, ad_fill(abs(dot(p - vec2<f32>(A * 0.5, 0.5), n)) - 0.11, w));
    let dc = length(p - vec2<f32>(A * 0.27, 0.52)) - 0.3;
    col = mix(col, white, ad_fill(dc - 0.035, w));
    col = mix(col, cc, ad_fill(dc, w));
    col = mix(col, white, ad_fill(length(p - vec2<f32>(A * 0.27 - 0.1, 0.62)) - 0.06, w));   // a highlight
    for (var i = 0; i < 3; i = i + 1) {
      let fi = f32(i);
      let d = ad_box(p, vec2<f32>(A * 0.7, 0.72 - fi * 0.18), vec2<f32>(A * (0.2 - 0.04 * fi), 0.045 + 0.02 * select(0.0, 1.0, i == 0)), 0.02);
      col = mix(col, select(ink, cc, i == 2), ad_fill(d, w));
    }
  } else if (lay == 1) {
    // BOLD TYPE: blocky glyphs with a hard drop shadow over a scrolling ticker band
    col = cb;
    let inkB = select(white, black, dot(cb, vec3<f32>(0.3, 0.55, 0.15)) > 0.5);
    let n = 4;
    for (var i = 0; i < n; i = i + 1) {
      let fi = f32(i);
      let gx = A * (0.16 + 0.68 * fi / 3.0);
      let gh = ad_hash(s * 3.3 + fi);
      let c0 = vec2<f32>(gx, 0.56);
      let hb = vec2<f32>(min(A * 0.085, 0.16), 0.24);
      var d = ad_box(p, c0, hb, 0.015);
      let notchY = select(0.1, -0.1, gh > 0.5);
      d = max(d, -ad_box(p, c0 + vec2<f32>(0.0, notchY), vec2<f32>(hb.x * 0.4, 0.07), 0.0));   // a counter / notch
      let dsh = ad_box(p, c0 + vec2<f32>(0.03, -0.03), hb, 0.015);
      col = mix(col, black, ad_fill(dsh, w) * 0.85);
      col = mix(col, select(cc, inkB, gh > 0.7), ad_fill(d, w));
    }
    let band = ad_fill(p.y - 0.15, w);
    col = mix(col, black, band);
    let tick = abs(fract((p.x + time * 0.35) * 2.2) - 0.5) - 0.2;   // dashes scrolling along the ticker
    col = mix(col, ca, band * ad_fill(max(tick / 2.2, abs(p.y - 0.075) - 0.025), w));
  } else {
    // SPLIT + STARBURST: a slanted two-colour split, a sunburst of rays behind a badge
    let ds = (p.x - A * 0.55) + (p.y - 0.5) * 0.45;
    col = mix(ca, cb, ad_fill(-ds, w));
    let q = p - vec2<f32>(A * 0.3, 0.5);
    let rr = length(q);
    let ang = atan2(q.y, q.x) / 6.2831853 * 14.0 + time * 0.08;
    let rayW = max(w / max(rr, 0.05) * 14.0 / 6.2831853, 1e-3);
    let ray = 1.0 - smoothstep(0.25 - rayW, 0.25 + rayW, abs(fract(ang) - 0.5));
    col = mix(col, cc, ray * ad_fill(rr - 0.46, w) * 0.85);
    col = mix(col, white, ad_fill(rr - 0.21, w));
    col = mix(col, ca, ad_fill(rr - 0.15, w));
    col = mix(col, ink, ad_fill(ad_box(p, vec2<f32>(A * 0.78, 0.32), vec2<f32>(A * 0.14, 0.06), 0.02), w));
  }
  col = mix(col, white, (1.0 - smoothstep(0.0, 0.02, ph)) * 0.55);   // the cut flash
  let avg = ca * 0.55 + cb * 0.27 + cc * 0.18;                   // what the screen reads as from far away
  return mix(col, avg, smoothstep(0.03, 0.12, w));
}

// WINDOWS pattern (mode 6): the UV grid becomes window CELLS (inset rectangles) and a per-cell hash decides
// which are LIT. Returns (isWindow, isLit, wallShade, 0). params = (freq, facade code, inset 0..0.45, lit fraction
// 0..1). FACADE CODE (params.y): 0 running-bond BRICK · 1 CONCRETE panels · 2 CURTAIN glass · 3 RIBBON glazing ·
// 4 small square TILE · 5 lap SIDING · 6 SHOP window (one cell per bay, lit shop interior) · 7 smooth PLASTER;
// plus 10 = Japanese sliding SASH openings (wide, low, a centre meeting rail). World-gen makes ONE CELL PER STOREY
// vertically, and offsets each face's u by whole cells (a per-building band of 128 cells + a per-face hash), so
// faces / buildings light different windows and the band index gives a per-building lit fraction.
fn winBase(ws: f32) -> f32 { return select(ws, ws - 10.0, ws > 9.5); }
fn winIsMasonry(b: f32) -> bool { return b < 1.5 || (b > 3.5 && b < 5.5) || b > 6.5; }
// Opening insets as cell fractions: (x each side, bottom, top). Mirrored on the CPU by windowInsets() in
// building-parts.ts (juliet / trim / window-box placement) - change both together.
fn winInsets(params: vec4<f32>) -> vec3<f32> {
  let ws = params.y;
  let b = winBase(ws);
  if (ws > 9.5) { return vec3<f32>(0.13, 0.30, 0.16); }
  if (b > 5.5 && b < 6.5) { return vec3<f32>(0.03, 0.03, 0.03); }
  if (b > 1.5 && b < 2.5) { return vec3<f32>(0.05, 0.05, 0.05); }
  if (b > 2.5 && b < 3.5) { return vec3<f32>(0.04, 0.22, 0.22); }
  let ix = max(clamp(params.z, 0.05, 0.45), 0.2);                // masonry: PORTRAIT windows (tall rectangles)
  return vec3<f32>(ix, ix * 0.5, ix * 0.5);
}
// Per-BUILDING hash from the cell column (the u offset band - see above).
fn winBandHash(cellX: f32) -> f32 { return fract(sin(floor(cellX / 128.0) * 57.31 + 3.7) * 43758.5453); }

// FACADE MATERIALS of windowsPattern (persona polish B4 - fewer, finer, lower-contrast joints: the old coarse joint
// grids read as "graph paper" across the whole city). Every joint pattern is fwidth-AA'd and settles to its flat
// AVERAGE once a unit is under ~2 px, so mid-distance walls read as clean material + the floor bands, never as noise.
// Pure functions of the material coordinates and their fwidths (taken by the caller in uniform control flow), so
// they may run inside a branch.
// BRICK: small running-bond bricks (about 1/9 of a window cell wide, 26 courses per storey) with LIGHT,
// low-contrast mortar and a per-brick tint spread.
fn wpBrick(bc: vec2<f32>, db: vec2<f32>) -> f32 {
  let brow = floor(bc.y);
  let bx = bc.x + fract(brow * 0.5);                   // running bond: alternate rows shift half a brick
  let bf = vec2<f32>(fract(bx), fract(bc.y));
  let mw = vec2<f32>(max(db.x * 1.5, 0.07), max(db.y * 1.5, 0.12));
  let brickMask = min(smoothstep(0.0, mw.x, bf.x) * (1.0 - smoothstep(1.0 - mw.x, 1.0, bf.x)),
                      smoothstep(0.0, mw.y, bf.y) * (1.0 - smoothstep(1.0 - mw.y, 1.0, bf.y)));
  let btint = fract(sin(dot(vec2<f32>(floor(bx), brow), vec2<f32>(41.3, 289.1))) * 34761.77);
  // Joints DARKER + brick faces LIGHTER - paint polarity matches the RELIEF so they reinforce into one 3-D brick.
  return mix(mix(0.9, 0.98 + 0.1 * btint, brickMask), 0.99, smoothstep(0.35, 0.8, max(db.x, db.y)));
}
// CONCRETE: cast / precast panels TWO BAYS x ONE STOREY (seams on every other pier centre + the floor line, so a
// seam never crosses a window), faint seams, a per-panel value shift and a soft low-frequency staining.
fn wpConc(p: vec2<f32>, cpan: vec2<f32>, dc: vec2<f32>, bh: f32) -> f32 {
  let cf = vec2<f32>(fract(cpan.x), fract(cpan.y));
  let cw = vec2<f32>(max(dc.x * 1.5, 0.012), max(dc.y * 1.5, 0.016));
  let seam = min(smoothstep(0.0, cw.x, cf.x) * (1.0 - smoothstep(1.0 - cw.x, 1.0, cf.x)),
                 smoothstep(0.0, cw.y, cf.y) * (1.0 - smoothstep(1.0 - cw.y, 1.0, cf.y)));
  let stain = pg_vnoise(p * vec2<f32>(0.8, 0.55) + vec2<f32>(bh * 23.0, 0.0)) - 0.5;
  return mix(0.955, 1.0, seam) * (0.975 + 0.05 * fract(sin(dot(floor(cpan), vec2<f32>(12.99, 78.23))) * 43758.5453)) * (1.0 + stain * 0.06);
}
// TILE: fine glazed facade tiles (22 across a cell, 30 up a storey - about 11 x 10 cm), pale grout, a small
// per-tile value spread. Fades to the average once a tile is under ~2 px (no moire, no grid at the overview).
fn wpTile(tc: vec2<f32>, dt: vec2<f32>) -> f32 {
  let tf = fract(tc);
  let tw = vec2<f32>(max(dt.x * 1.5, 0.08), max(dt.y * 1.5, 0.08));
  let tileMask = min(smoothstep(0.0, tw.x, tf.x) * (1.0 - smoothstep(1.0 - tw.x, 1.0, tf.x)),
                     smoothstep(0.0, tw.y, tf.y) * (1.0 - smoothstep(1.0 - tw.y, 1.0, tf.y)));
  let ttint = fract(sin(dot(floor(tc), vec2<f32>(17.3, 91.7))) * 5413.7);
  return mix(mix(1.05, 0.975 + 0.05 * ttint, tileMask), 0.995, smoothstep(0.25, 0.6, max(dt.x, dt.y)));
}
// SIDING: horizontal lap boards (about 12 per storey) - each board lighter at its top, a shadow line under it.
fn wpLap(sc: f32, dsd: f32) -> f32 {
  return mix(mix(0.8, 1.02, smoothstep(0.0, max(0.3, dsd * 1.5), fract(sc))), 0.93, smoothstep(0.3, 0.7, dsd));
}
// PLASTER / painted RENDER: smooth, with soft organic blotches (value noise - the old floor(p) hash painted a
// grid of flat squares).
fn wpPlaster(p: vec2<f32>, bh: f32) -> f32 {
  return 0.985 + 0.06 * (pg_vnoise(p * vec2<f32>(1.6, 1.2) + vec2<f32>(bh * 17.0, 3.1)) - 0.5);
}
// METAL PANEL cladding (code 8): aluminium composite panels, 2 per bay x 2 per storey, thin dark open joints,
// each panel its own sheen value plus a faint vertical oil-can gradient.
fn wpPanel(pc: vec2<f32>, dpc: vec2<f32>) -> f32 {
  let pcf = fract(pc);
  let pjw = vec2<f32>(max(dpc.x * 1.5, 0.02), max(dpc.y * 1.5, 0.025));
  let pMask = min(smoothstep(0.0, pjw.x, pcf.x) * (1.0 - smoothstep(1.0 - pjw.x, 1.0, pcf.x)),
                  smoothstep(0.0, pjw.y, pcf.y) * (1.0 - smoothstep(1.0 - pjw.y, 1.0, pcf.y)));
  let pval = 0.955 + 0.09 * fract(sin(dot(floor(pc), vec2<f32>(63.7, 17.9))) * 24634.63) + 0.035 * (pcf.y - 0.5);
  return mix(mix(0.7, pval, pMask), 0.97, smoothstep(0.3, 0.7, max(dpc.x, dpc.y)));
}

fn windowsPattern(uv: vec2<f32>, params: vec4<f32>, time: f32, full: bool, fast: bool) -> vec4<f32> {
  let freq = max(params.x, 0.001);
  let p = uv * freq;
  let cell = floor(p);
  let f = fract(p);
  let ws = params.y;
  let b = winBase(ws);
  let sash = ws > 9.5;
  let isCurtain = b > 1.5 && b < 2.5;
  let isShop = b > 5.5 && b < 6.5;
  let masonry = winIsMasonry(b);
  let dp = fwidth(p);
  let w = max(dp.x, dp.y) + 1e-4;
  // P8 FAST PATH (fast = scene.cascadeBias.z, Renderer3D.shaderFastPaths): every fwidth below is taken HERE, in
  // uniform control flow, so the rest may branch. Only a FACADE (full = patMode 6) reads .xyz, every other patterned
  // mesh (ground, roofs, paving) only the footprint .w, so they return now; a facade evaluates only ITS material.
  // Same expressions, same values: the output is bit-identical to the slow path.
  let bc = vec2<f32>(p.x * 9.0, p.y * 26.0);
  let db = fwidth(bc);
  let cpan = vec2<f32>(p.x * 0.5, p.y);
  let dc = fwidth(cpan);
  let tc = vec2<f32>(p.x * 22.0, p.y * 30.0);
  let dt = fwidth(tc);
  let sc = p.y * 12.0;
  let dsd = fwidth(sc);
  let pc = p * 2.0;
  let dpc = fwidth(pc);
  if (fast && !full) { return vec4<f32>(0.0, 0.0, 0.0, w); }
  let ins = winInsets(params);
  let insetX = ins.x;
  let inX = smoothstep(insetX - w, insetX + w, f.x) * (1.0 - smoothstep(1.0 - insetX - w, 1.0 - insetX + w, f.x));
  let inY = smoothstep(ins.y - w, ins.y + w, f.y) * (1.0 - smoothstep(1.0 - ins.z - w, 1.0 - ins.z + w, f.y));
  // LIT SET: each cell reshuffles on its OWN phase (was one city-wide 50 s clock - every lit window in town
  // flipped on the same frame); the per-building band scales the lit fraction (some blocks dark, some bright).
  let ph = fract(sin(dot(cell, vec2<f32>(19.19, 47.73))) * 24634.63);
  let slot = floor(time * 0.02 + ph);
  let h = fract(sin(dot(cell + vec2<f32>(slot), vec2<f32>(127.1, 311.7))) * 43758.5453);
  let bh = winBandHash(cell.x);
  let lf0 = clamp(params.w, 0.0, 1.0);
  // shops: ~90% of bays lit as soon as dusk starts (a lit shop street); homes / offices: 0.3x .. 1.7x per building
  let litFrac = select(clamp(lf0 * (0.3 + 1.4 * bh), 0.0, 1.0), clamp(lf0 * 4.0, 0.0, 0.92), isShop);
  // CURTAIN towers light whole FLOORS (per-row hash -> glowing floor bands), each tower on its own set + phase.
  let rslot = floor(time * 0.02 + fract(sin(cell.y * 13.7 + bh * 71.0) * 9173.1));
  let hRow = fract(sin((cell.y + rslot) * 91.7 + 12.3 + bh * 37.0) * 43758.5453);
  // TRANSIT glazing (world/train.ts EMU side glass): curtain code with scale > 0.9 = every cell on the plain lit
  // fraction (a commuter train is lit end to end) - no per-building band or per-floor gating.
  let transit = isCurtain && params.z > 0.9;
  let lit = select(select(step(1.0 - litFrac, h), step(1.0 - litFrac, hRow), isCurtain), step(1.0 - lf0, h), transit);
  // FACADE MATERIALS (persona polish B4 - fewer, finer, lower-contrast joints: the old coarse joint grids read as
  // "graph paper" across the whole city). Every joint pattern is fwidth-AA'd and settles to its flat AVERAGE once a
  // unit is under ~2 px, so mid-distance walls read as clean material + the floor bands below, never as noise.
  // (each material is a pure function of the coordinates + the fwidths taken above - see wpBrick .. wpPanel)
  var shade: f32;
  if (fast) {
    // P8: evaluate only this facade's material (the slow path below computes all six and selects one).
    if (b < 0.5) { shade = wpBrick(bc, db); }
    else if (b > 3.5 && b < 4.5) { shade = wpTile(tc, dt); }
    else if (b > 4.5 && b < 5.5) { shade = wpLap(sc, dsd); }
    else if (b > 6.5 && b < 7.5) { shade = wpPlaster(p, bh); }
    else if (b > 7.5 && b < 8.5) { shade = wpPanel(pc, dpc); }
    else { shade = wpConc(p, cpan, dc, bh); }
  } else {
    let brick = wpBrick(bc, db);
    let conc = wpConc(p, cpan, dc, bh);
    let tile = wpTile(tc, dt);
    let lap = wpLap(sc, dsd);
    let plaster = wpPlaster(p, bh);
    let panelC = wpPanel(pc, dpc);
    shade = conc;
    if (b < 0.5) { shade = brick; }
    if (b > 3.5 && b < 4.5) { shade = tile; }
    if (b > 4.5 && b < 5.5) { shade = lap; }
    if (b > 6.5 && b < 7.5) { shade = plaster; }
    if (b > 7.5 && b < 8.5) { shade = panelC; }
  }
  // RAIN STREAKS under the sills of render / concrete fronts: a faint darkening below some windows, strongest just
  // under the sill and fading toward the floor (the lived-in Tokyo front, kept subtle).
  let stX = smoothstep(insetX - w, insetX + 0.06, f.x) * (1.0 - smoothstep(1.0 - insetX - 0.06, 1.0 - insetX + w, f.x));
  let stH = step(0.55, fract(sin(dot(cell, vec2<f32>(3.1, 17.7))) * 9137.1));
  let streak = stX * stH * smoothstep(0.0, max(ins.y, 0.05), f.y) * (1.0 - step(ins.y, f.y));
  let streaky = select(0.0, 1.0, (b > 0.5 && b < 1.5) || (b > 6.5 && b < 7.5));
  shade = shade * (1.0 - 0.07 * streak * streaky);
  // FLOOR BANDS (B4 / D2): a slab-edge band along the bottom of every upper storey - the horizontal rhythm of a
  // real block, and the far-distance stand-in for the geometric floor-band ledges (which cull with the DETAIL
  // tier). Darker spandrel on tile / brick / render, a paler slab edge on concrete and metal panel. Not on the
  // ground row (the plinth owns it) and not on siding.
  let bandH = min(0.075, ins.y * 0.6);
  let fBand = (1.0 - smoothstep(bandH - w, bandH + w, f.y)) * step(1.0, p.y) * select(1.0, 0.0, b > 4.5 && b < 5.5);
  let bandK = select(0.88, 1.07, (b > 0.5 && b < 1.5) || (b > 7.5 && b < 8.5));
  shade = mix(shade, shade * bandK, fBand * select(1.0, 0.0, !masonry));
  // STONE PLINTH: a darker base course on the GROUND storey only (row 0 - world-gen restarts v at the section's
  // storey index, so an upper / setback section never gets one; it was landing over every shop). Sash facades
  // keep it below the ground-floor sill only.
  let row0 = 1.0 - step(1.0, p.y);
  let plinthFull = 1.0 - smoothstep(0.85, 1.0, p.y);
  let plinthSill = row0 * (1.0 - smoothstep(ins.y * 0.55 - w, ins.y * 0.55 + w, f.y));
  let plinth = select(select(plinthFull, plinthSill, sash), 0.0, !masonry);
  shade = mix(shade, min(shade, 1.0) * 0.8, plinth * 0.9);
  // WINDOW FRAME: a light SILL below + HEADER above + thin JAMBS at the sides, hugging each opening (masonry only;
  // softer on sash facades, whose frames are thin aluminium drawn on the glass in windowShade).
  let onBot  = inX * (1.0 - smoothstep(0.0, 0.055, abs(f.y - ins.y)));
  let onTop  = inX * (1.0 - smoothstep(0.0, 0.045, abs(f.y - (1.0 - ins.z))));
  let onSide = inY * (1.0 - smoothstep(0.0, 0.03, min(abs(f.x - insetX), abs(f.x - (1.0 - insetX)))));
  let frame  = clamp(max(max(onBot, onTop * 0.7), onSide * 0.55), 0.0, 1.0) * (1.0 - inX * inY);
  shade = mix(shade, 1.24, frame * select(0.85, 0.35, sash) * (1.0 - plinth));
  // CURTAIN / RIBBON / SHOP override the between-glass shade: curtain = clean metal MULLION grid; ribbon = solid
  // SPANDREL bands in the wall colour; shop = the bay frame is real geometry, so no painted wall at all.
  if (!masonry) { shade = select(select(0.58, 1.0, b > 2.5), 1.0, isShop); }
  // .w = the pixel footprint in CELLS (fwidth of the cell coords): the FS relief + windowShade fade their
  // sub-pixel grain with it (no fwidth needed down there - it runs in non-uniform control flow).
  return vec4<f32>(inX * inY, lit, shade, w);
}

// Structured MASONRY HEIGHT for the wall BETWEEN the windows (facade relief normal). Returns 0..1 where the brick
// faces / panel faces / tiles / siding boards stand PROUD and the joints RECESS. NO fwidth (fixed joint widths) -
// the FS samples this at a fine FIXED eps, so it stays uniform-safe. Facade code as windowsPattern (+10 sash
// flag decoded); curtain / ribbon / shop / plaster are flat. The cell math MUST MATCH windowsPattern's albedo
// joints exactly (same counts, same bond offset) so every groove lands on a painted joint.
fn wallMasonryH(uv: vec2<f32>, params: vec4<f32>) -> f32 {
  let freq = max(params.x, 0.001);
  let pw = uv * freq;
  let b = winBase(params.y);
  if (b < 0.5) {
    // BRICK: running-bond relief (bc = (p.x*9, p.y*26), half-brick row offset fract(brow*0.5), p = uv*freq)
    let bc = vec2<f32>(pw.x * 9.0, pw.y * 26.0);
    let brow = floor(bc.y);
    let bx = bc.x + fract(brow * 0.5);
    let bf = vec2<f32>(fract(bx), fract(bc.y));
    let hx = smoothstep(0.0, 0.07, bf.x) * (1.0 - smoothstep(0.93, 1.0, bf.x));   // head joint (vertical)
    let hy = smoothstep(0.0, 0.12, bf.y) * (1.0 - smoothstep(0.88, 1.0, bf.y));   // bed joint (horizontal)
    return min(hx, hy);
  }
  if (b < 1.5) {
    // Concrete / precast panels (two bays x one storey) - the panel FACE proud, the seams recessed.
    let cf = fract(vec2<f32>(pw.x * 0.5, pw.y));
    let seam = min(smoothstep(0.0, 0.014, cf.x) * (1.0 - smoothstep(0.986, 1.0, cf.x)),
                   smoothstep(0.0, 0.018, cf.y) * (1.0 - smoothstep(0.982, 1.0, cf.y)));
    return seam;
  }
  if (b > 3.5 && b < 4.5) {
    // TILE: grout lines recessed (matches the 22 x 30 albedo tiles)
    let tf = fract(pw * vec2<f32>(22.0, 30.0));
    return min(smoothstep(0.0, 0.08, tf.x) * (1.0 - smoothstep(0.92, 1.0, tf.x)),
               smoothstep(0.0, 0.08, tf.y) * (1.0 - smoothstep(0.92, 1.0, tf.y)));
  }
  if (b > 4.5 && b < 5.5) {
    // SIDING: each lap board a ramp (thin at its top edge, thick at the drip edge) -> a stepped shadow per board
    return smoothstep(0.0, 0.9, fract(pw.y * 12.0));
  }
  if (b > 7.5 && b < 8.5) {
    // METAL PANEL: the open joints between the composite panels recess (matches the 2 x 2 albedo panels)
    let pf = fract(pw * 2.0);
    return min(smoothstep(0.0, 0.03, pf.x) * (1.0 - smoothstep(0.97, 1.0, pf.x)),
               smoothstep(0.0, 0.035, pf.y) * (1.0 - smoothstep(0.965, 1.0, pf.y)));
  }
  return 0.0;
}

// ── INTERIOR MAPPING ────────────────────────────────────────────────────────────
// Raycast a fake ROOM behind each window cell (the Spider-Man / Cities: Skylines trick): the view ray enters at
// the glass plane and hits the back wall / floor / ceiling / side walls of a virtual box, giving true PARALLAX
// depth per window for zero geometry. Hashed per room: depth, warm-home vs cool-office light, a furniture band
// and wall hangings on the back wall. No fwidth inside, so these are safe in branches.
// The box is METRIC (polish round 7): it spans the whole window CELL (one storey tall, one bay wide; curtain /
// ribbon floors are open plan, 3 bays wide) and a hashed depth in STOREY heights, and the ray arrives expressed
// in the cell's own uv axes (windowShade derives them from uv derivatives), so the parallax runs the right way on
// every face and is exactly as strong as a real room behind real glass. Units: storey heights (cell height = 1);
// x along +u, y along +v (up), z along the outward normal (the room is z < 0).
// CPU mirror + world-space ground truth: src/renderer/3d/interior-mapping.test.ts (change both together).
struct RoomHit { p: vec3<f32>, face: f32, dist: f32 }

// face: 0 side wall, 1 ceiling, 2 floor, 3 back wall. p = the hit in BOX coords: x, y in -1..1 across the room
// (floor -1, ceiling +1), z in half-storey units (0 at the glass, -2 * depth at the back wall). dist in storeys.
fn roomTrace(ro: vec3<f32>, rd0: vec3<f32>, xLo: f32, xHi: f32, depth: f32) -> RoomHit {
  var rd = rd0;
  rd.z = min(rd.z, -0.08);                                       // guard grazing rays
  let sx = select(-1.0, 1.0, rd.x >= 0.0) * max(abs(rd.x), 1e-5);
  let sy = select(-1.0, 1.0, rd.y >= 0.0) * max(abs(rd.y), 1e-5);
  let tx = (select(xLo, xHi, sx > 0.0) - ro.x) / sx;
  let ty = (select(0.0, 1.0, sy > 0.0) - ro.y) / sy;
  let tz = -depth / rd.z;
  let t = max(min(tx, min(ty, tz)), 0.0);
  let h = ro + rd * t;
  var face = 0.0;
  if (tz <= min(tx, ty)) { face = 3.0; } else if (ty <= tx) { face = select(2.0, 1.0, sy > 0.0); }
  var o: RoomHit;
  o.p = vec3<f32>(2.0 * (h.x - xLo) / max(xHi - xLo, 1e-4) - 1.0, 2.0 * h.y - 1.0, 2.0 * h.z);
  o.face = face;
  o.dist = t;
  return o;
}

fn interiorRoom(win: vec2<f32>, ro: vec3<f32>, rd: vec3<f32>, xLo: f32, xHi: f32, seed: f32, time: f32) -> vec3<f32> {
  let h1 = fract(sin(seed * 12.9898) * 43758.5453);              // depth
  let h2 = fract(h1 * 91.17 + 0.37);                             // room TYPE (warm home vs cool office)
  let h3 = fract(h2 * 137.31 + 0.71);                            // dressing (blinds / curtains / TV)
  let office = h2 > 0.55;
  // room depth in STOREYS: homes ~3.4..5.3 m, offices ~4.3..7 m behind the glass (at a ~3.1 m storey)
  let depth = select(1.1 + h1 * 0.6, 1.4 + h1 * 0.9, office);

  // WINDOW DRESSING at the glass plane: 18% horizontal BLINDS (slat stripes), 16% side CURTAINS.
  let blinds = step(0.82, h3);
  let curtains = step(0.66, h3) * (1.0 - blinds);
  let blindMask = blinds * smoothstep(0.35, 0.65, fract(win.y * 7.0));
  let curtainMask = curtains * (1.0 - smoothstep(0.14, 0.30, min(win.x, 1.0 - win.x)));

  let r = roomTrace(ro, rd, xLo, xHi, depth);
  let hit = r.p;
  let tint = select(vec3<f32>(1.0, 0.80, 0.55), vec3<f32>(0.80, 0.88, 1.0), office);

  var c = tint * 0.48;                                           // side walls...
  if (office && r.face < 0.5) {
    // ...offices get SHELF rows on the side walls (horizontal darker bands with depth)
    c = c * mix(0.62, 1.0, smoothstep(0.1, 0.28, abs(fract(hit.y * 1.6) - 0.5)));
  }
  if (r.face > 2.5) {
    if (office) {
      // OFFICE back wall: a desk band (desk top ~0.75 m) + a row of small MONITOR glows standing on it
      let desk = smoothstep(-0.45, -0.6, hit.y);
      c = tint * mix(0.68, 0.30, desk);
      let mcol = fract(hit.x * 2.6 + seed);
      let mrow = smoothstep(-0.54, -0.48, hit.y) * (1.0 - smoothstep(-0.3, -0.24, hit.y));
      let monOn = step(0.5, fract(sin(floor(hit.x * 2.6 + seed) * 47.3) * 761.7));
      let mon = monOn * step(0.3, mcol) * (1.0 - step(0.7, mcol)) * mrow;
      c = mix(c, vec3<f32>(0.55, 0.85, 1.0) * 1.6, mon);
    } else {
      // HOME back wall: sofa band + hashed wall hangings; ~35% have a flickering TV
      let band = smoothstep(-0.38, -0.55, hit.y);
      let pic = fract(sin(dot(floor(hit.xy * 1.8 + vec2<f32>(seed)), vec2<f32>(31.7, 71.3))) * 4571.7);
      c = tint * mix(0.72, 0.28, band) * (0.8 + 0.35 * pic);
      let tvOn = step(0.65, fract(h3 * 51.7));
      let tv = tvOn * step(abs(hit.x + 0.25), 0.28) * step(abs(hit.y + 0.2), 0.15);
      let flick = 0.75 + 0.25 * sin(time * 9.0 + seed * 6.28) * sin(time * 23.0 + seed);
      c = mix(c, vec3<f32>(0.6, 0.7, 1.0) * (1.2 * flick), tv);
    }
  } else if (r.face > 0.5 && r.face < 1.5) {
    // CEILING: offices get repeating strip fixtures; homes one round fixture over the middle of the room
    var fix = max(0.0, 1.0 - length(vec2<f32>(hit.x, (hit.z + depth) * 0.6)) * 1.1);
    if (office) { fix = step(abs(fract(hit.z * 0.7) - 0.5), 0.1); }
    c = tint * (0.6 + 0.7 * fix);
  } else if (r.face > 1.5) {
    // FLOOR: warm wood in homes, grey carpet in offices
    c = select(tint * vec3<f32>(0.52, 0.38, 0.26), tint * 0.30, office);
  }
  var room = c / (1.0 + r.dist * 0.5);                           // deep rooms fall off
  room = mix(room, tint * 0.22, clamp(blindMask + curtainMask, 0.0, 1.0));   // dressing occludes the view
  return room;
}

// SHOP INTERIOR (facade code 6): the interior-mapped room behind a shop window - a deep lit sales floor: ceiling
// strip lights, shelf rows of small products on the back + side walls, a floor, and a poster / sale sticker stuck
// on the inside of the glass. visual-polish #3 (2026-10-03): the shelves were huge rainbow "book" blocks on pale
// shelves (the most saturated thing in every street shot). Now each shop takes one of four CONTROLLED palettes
// (warm kraft + wood, greige + teal, cream + brick, a dark boutique), products are a third of the size with a value
// jitter and only ~1 in 10 is the palette's accent colour, the light falls off from the ceiling, and past a few
// pixels per product (fp = the pixel footprint in bay cells, from windowsPattern) the shelves settle to their
// average colour instead of sparkling. No fwidth inside -> safe in branches.
fn shopInterior(win: vec2<f32>, ro: vec3<f32>, rd: vec3<f32>, xLo: f32, xHi: f32, seed: f32, fp: f32) -> vec3<f32> {
  let h1 = fract(sin(seed * 12.9898) * 43758.5453);
  let h2 = fract(h1 * 91.17 + 0.37);
  let h3 = fract(h2 * 137.31 + 0.71);
  let depth = 1.6 + h1 * 1.2;                                    // in bay-glass heights: a ~5..9 m sales floor
  let r = roomTrace(ro, rd, xLo, xHi, depth);
  let hit = r.p;
  // The shop's palette (h2): shelf / wall, two product bases, one accent.
  var shelf = vec3<f32>(0.56, 0.46, 0.36); var pa = vec3<f32>(0.70, 0.58, 0.42); var pb = vec3<f32>(0.46, 0.34, 0.26); var acc = vec3<f32>(0.78, 0.22, 0.16);
  if (h2 > 0.25 && h2 <= 0.5) { shelf = vec3<f32>(0.68, 0.66, 0.62); pa = vec3<f32>(0.72, 0.68, 0.58); pb = vec3<f32>(0.42, 0.47, 0.49); acc = vec3<f32>(0.16, 0.50, 0.54); }
  else if (h2 > 0.5 && h2 <= 0.78) { shelf = vec3<f32>(0.70, 0.64, 0.55); pa = vec3<f32>(0.62, 0.36, 0.28); pb = vec3<f32>(0.80, 0.74, 0.60); acc = vec3<f32>(0.88, 0.66, 0.18); }
  else if (h2 > 0.78) { shelf = vec3<f32>(0.30, 0.27, 0.25); pa = vec3<f32>(0.52, 0.44, 0.36); pb = vec3<f32>(0.26, 0.23, 0.25); acc = vec3<f32>(0.66, 0.16, 0.28); }
  let lightV = mix(0.68, 1.0, clamp((hit.y + 1.0) * 0.5, 0.0, 1.0));   // brighter near the ceiling lights
  var c = shelf;
  let backHit = r.face > 2.5;
  if (r.face < 0.5 || backHit) {
    // SHELVES: ~5 rows up the wall; each a run of small product blocks of varied height
    let sy = (hit.y + 1.0) * 2.4;
    let sf = fract(sy);
    let lane = select(hit.z * 1.3, hit.x, backHit);
    let prod = fract(sin((floor(lane * 15.0) + floor(sy) * 17.0 + seed) * 78.233) * 43758.5453);
    var prodCol = mix(pa, pb, fract(prod * 7.31)) * (0.78 + 0.34 * fract(prod * 13.7));
    prodCol = select(prodCol, acc, fract(prod * 29.7) > 0.86);
    let top = 0.42 + 0.3 * fract(prod * 5.13);
    let onShelf = step(0.16, sf) * (1.0 - step(top, sf)) * step(0.22, prod);
    let avg = mix(shelf, (pa + pb) * 0.45, 0.4);                 // what a shelf reads as from a distance
    c = mix(shelf * 0.82, prodCol, onShelf);
    c = mix(c, shelf * 0.45, 1.0 - step(0.1, sf));              // the shelf edge shadow line
    c = mix(c, avg * 0.85, smoothstep(0.012, 0.05, fp));        // sub-pixel products -> their average (no sparkle)
    c = c * lightV;
  } else if (r.face < 1.5) {
    // CEILING: warm white strip lights
    let strip = step(abs(fract(hit.z * 0.9 + h2) - 0.5), 0.09);
    c = vec3<f32>(1.0, 0.95, 0.86) * (0.62 + 0.7 * strip);
  } else {
    c = mix(shelf, vec3<f32>(0.60, 0.57, 0.52), 0.6) * 0.8;      // floor
  }
  var room = c / (1.0 + r.dist * 0.3);                           // a lit shop falls off gently toward the back
  // POSTERS / sale stickers on the inside of the glass (about 60% of bays): off-white or the shop's accent
  let px = 0.2 + 0.6 * h3;
  let poster = step(abs(win.x - px), 0.14) * step(abs(win.y - 0.64), 0.2) * step(0.4, h2);
  let pcol = select(vec3<f32>(0.90, 0.88, 0.82), acc, fract(h3 * 17.3) > 0.5);
  let band = step(abs(win.y - 0.93), 0.05) * step(0.7, h1);      // a sale banner along the top of the glass
  room = mix(room, pcol, max(poster, band));
  return room;
}

// World-space surface axes per uv unit (dP/du, dP/dv) from screen-space derivatives - the same cotangent-frame
// solve as gr_uvMetres, but keeping the DIRECTIONS - plus a NOISE estimate: the relative f32 error of those
// derivatives (one ulp of the uv / position varyings over their per-pixel change, x4 for interpolation). Facade
// u runs into the thousands (per-building 128-cell bands), so up close the derivative LENGTHS are pure noise.
// Zero axes when the uv is degenerate (callers fall back). dpdx/dpdy need UNIFORM control flow: call at fragment
// top level only (PATTERN_BLOCK_FULL does).
struct UvAxes { u: vec3<f32>, v: vec3<f32>, noise: f32 }
fn uvWorldAxes(uv: vec2<f32>, worldPos: vec3<f32>) -> UvAxes {
  let dpx = dpdx(worldPos);
  let dpy = dpdy(worldPos);
  let dux = dpdx(uv);
  let duy = dpdy(uv);
  var o: UvAxes;
  o.u = vec3<f32>(0.0);
  o.v = vec3<f32>(0.0);
  o.noise = 1.0;
  let det = dux.x * duy.y - dux.y * duy.x;
  if (abs(det) < 1e-16) { return o; }
  let inv = 1.0 / det;
  o.u = (dpx * duy.y - dpy * dux.y) * inv;
  o.v = (dpy * dux.x - dpx * duy.x) * inv;
  let eps = 4.8e-7;                                              // 4 ulp at 1.0
  let stepU = max(length(vec2<f32>(dux.x, duy.x)), 1e-30);
  let stepV = max(length(vec2<f32>(dux.y, duy.y)), 1e-30);
  let stepP = max(min(length(dpx), length(dpy)), 1e-30);
  let pMax = max(max(abs(worldPos.x), abs(worldPos.y)), abs(worldPos.z));
  o.noise = eps * max(max(abs(uv.x) / stepU, abs(uv.y) / stepV), pMax / stepP);
  return o;
}

struct WinShade { base: vec3<f32>, emk: vec3<f32> }

// Window-cell SURFACE: wall shade outside the opening; inside it, the interior-mapped room seen through the
// glass - faint behind dark day glass, GLOWING per-texel when the cell is lit (the glow carries the room's
// parallax). The LIT COLOUR follows the room type: warm homes (patCol), cool fluorescent offices, the blue of a
// TV-only room; shops are bright cool white. Sash facades draw a thin aluminium frame + centre meeting rail.
// uvAx = uvWorldAxes(uv, worldPos) (world vectors per uv unit along u and v), computed in uniform control flow.
fn windowShade(uv: vec2<f32>, params: vec4<f32>, winWL: vec4<f32>, worldPos: vec3<f32>, N0: vec3<f32>, uvAx: UvAxes,
               camPos: vec3<f32>, diffuse: vec3<f32>, patCol: vec3<f32>, emisIn: vec3<f32>, time: f32, fast: bool, glowIn: f32) -> WinShade {
  let freq = max(params.x, 0.001);
  let p = uv * freq;
  let cell = floor(p);
  let f = fract(p);
  let b = winBase(params.y);
  let sash = params.y > 9.5;
  let isShop = b > 5.5 && b < 6.5;
  let isCurtain = b > 1.5 && b < 2.5;
  let openPlan = b > 1.5 && b < 3.5;                             // curtain + ribbon: continuous glazing, open floors
  let clean = !winIsMasonry(b);                                  // curtain / ribbon / shop: modern glazed skin
  // WALL GRAIN: a world-stable micro value noise over the masonry (NOT the glass). Its 3 mm cells are sub-pixel
  // past a couple of metres, where they only shimmer (the "noise at mid distance"): faded out by the pixel
  // footprint (winWL.w, in cells), and gentler (+-4 %) where it does show.
  let grainFade = 1.0 - smoothstep(0.0015, 0.006, winWL.w);
  let grain = 1.0 + 0.08 * grainFade * (fract(sin(dot(floor(uv * 300.0), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5);
  let g = select(grain, 1.0, clean);
  let wallBase = select(diffuse, vec3<f32>(0.50, 0.52, 0.56), isCurtain);
  let wallCol = wallBase * winWL.z * g;
  // P8 FAST PATH: a WALL pixel (outside every opening, winWL.x exactly 0) ends as mix(wall, glass, 0) = the wall, so
  // the room trace, reveal and glass below cannot change it - return the wall now (bit-identical; no derivatives
  // below, so the branch is safe). Roughly half of every facade, and from the air most of the city's pixels.
  if (fast && winWL.x <= 0.0) {
    var ow: WinShade;
    ow.base = wallCol;
    ow.emk = emisIn * winWL.z;
    return ow;
  }
  let ins = winInsets(params);
  let winUV = clamp(vec2<f32>((f.x - ins.x) / max(1.0 - 2.0 * ins.x, 1e-3), (f.y - ins.y) / max(1.0 - ins.y - ins.z, 1e-3)), vec2<f32>(0.0), vec2<f32>(1.0));
  let N = normalize(N0);
  let Vv = normalize(camPos - worldPos);
  let Nf = select(N, -N, dot(Vv, N) < 0.0);                      // the room is always BEHIND the glass
  // CELL FRAME = the uv axes themselves, so the box's +x is the direction u grows and +y the direction v grows on
  // EVERY face, whatever its winding / orientation / uv layout. (The old frame T = cross(up, N) pointed AGAINST u
  // on every wallsWin face, which MIRRORED the horizontal parallax - the room slid the wrong way.) Degenerate uv
  // falls back to the wallsWin convention: u along cross(N, up), v up, one uv unit = one world unit.
  var Tu = uvAx.u;
  var Tv = uvAx.v;
  let T0 = cross(N, vec3<f32>(0.0, 1.0, 0.0));                   // the wallsWin u convention (horizontal, in-plane)
  let Ta = select(vec3<f32>(1.0, 0.0, 0.0), T0 / max(length(T0), 1e-6), dot(T0, T0) > 1e-6);
  let Ba = cross(Ta, N);
  if (dot(Tu, Tu) < 1e-24 || dot(Tv, Tv) < 1e-24) { Tu = Ta; Tv = Ba; }
  // ASPECT = cell width in storeys (the box's x extent). Measured from the derivative lengths where they are
  // trustworthy; where they are f32 noise (close up on a big-u facade) it eases to a nominal bay (2.6 m / 3.1 m) -
  // a per-pixel noisy aspect made every side wall a speckled mess. Clamped to plausible cells.
  let aspMeas = clamp(length(Tu) / max(length(Tv), 1e-12), 0.2, 5.0);
  let aspect = mix(aspMeas, 0.85, smoothstep(0.004, 0.02, uvAx.noise));
  // DIRECTIONS: uv derivatives are noisy up close (f32 uv / position varyings - wall u runs into the thousands), so
  // an axis within ~25 deg of the analytic facade frame (horizontal Ta / in-plane Ba) SNAPS to it, keeping only the
  // derivative's SIGN - which is what fixes the mirroring. Genuinely rotated / sheared uv keeps the raw axis.
  var Uh = normalize(Tu);
  var Vh = normalize(Tv);
  let cu = dot(Uh, Ta);
  let cv = dot(Vh, Ba);
  // Past ~30% derivative noise (a camera almost touching the glass) even the SIGN is unreliable: use the wallsWin
  // convention outright (u along Ta, v up) rather than a per-pixel coin flip.
  let dirOk = uvAx.noise < 0.3;
  if (abs(cu) > 0.9 || !dirOk) { Uh = Ta * select(1.0, sign(cu), dirOk); }
  if (abs(cv) > 0.9 || !dirOk) { Vh = Ba * select(1.0, sign(cv), dirOk); }
  // The view ray INTO the room in the cell frame, METRIC (every axis in the same world unit, so the box has the real
  // window's proportions; the storey scale cancels in the normalize). In-plane part solved on the Gram matrix of
  // the unit axes, so a sheared uv is exact too.
  let r = -Vv;
  let gb = dot(Uh, Vh);
  let ru = dot(r, Uh);
  let rv = dot(r, Vh);
  let gdet = max(1.0 - gb * gb, 1e-6);
  let rd = normalize(vec3<f32>((ru - gb * rv) / gdet, (rv - gb * ru) / gdet, dot(r, Nf)));
  let ro = vec3<f32>(f.x * aspect, f.y, 0.0);
  let xLo = select(0.0, -aspect, openPlan);
  let xHi = select(aspect, 2.0 * aspect, openPlan);
  let seed = dot(cell, vec2<f32>(7.13, 3.71)) + freq;
  // RECESSED OPENING (persona polish D2): masonry windows sit in a REVEAL (a hole ~15 cm deep; aluminium sash
  // ~10 cm; flush curtain / ribbon / shop glazing none). windowReveal traces the same view ray from the wall-plane
  // entry point: rays that leave the opening before reaching the glass hit a jamb / the head soffit / the sill
  // reveal (wall material, shaded); the rest land on the glass at winG, where the sash bars, the frame and the room
  // dressing are drawn - so they slide behind the reveal with true parallax. The ROOM trace below is unchanged
  // (same ro / rd / box - the reveal only occludes its edges).
  let revDepth = select(select(0.05, 0.034, sash), 0.0, clean);
  let rev = windowReveal(ro, rd, ins.x * aspect, (1.0 - ins.x) * aspect, ins.y, 1.0 - ins.z, revDepth);
  let onReveal = select(0.0, 1.0, rev.x > 0.5);
  let winG = select(winUV, clamp(rev.yz, vec2<f32>(0.0), vec2<f32>(1.0)), revDepth > 0.0);
  var room: vec3<f32>;
  if (isShop) { room = shopInterior(winG, ro, rd, xLo, xHi, seed, winWL.w); } else { room = interiorRoom(winG, ro, rd, xLo, xHi, seed, time); }
  // ROOM TYPE -> lit colour (the same hashes interiorRoom uses, so a cool office interior glows cool)
  let h1 = fract(sin(seed * 12.9898) * 43758.5453);
  let h2 = fract(h1 * 91.17 + 0.37);
  let h3 = fract(h2 * 137.31 + 0.71);
  let office = h2 > 0.55;
  let tvOnly = !office && fract(h3 * 51.7) > 0.88;               // lights off, TV on: a blue flicker
  let flick = 0.8 + 0.2 * sin(time * 7.0 + seed * 6.28) * sin(time * 17.0 + seed);
  var litTint = patCol * mix(0.92, 1.08, h1);                    // warm home (the layer's lit colour)
  if (office || isCurtain) { litTint = vec3<f32>(0.80, 0.91, 1.0); }
  if (tvOnly && !isCurtain) { litTint = vec3<f32>(0.32, 0.46, 1.0) * 0.7 * flick; }
  if (isShop) { litTint = vec3<f32>(1.0, 0.9, 0.74) * 1.05; }      // visual-polish #3: warm shop light (was a cool white -> lavender)
  let glassDark = select(vec3<f32>(0.09, 0.10, 0.13), vec3<f32>(0.20, 0.27, 0.36), clean);
  // SKY REFLECTION (D2): the glass mirrors a soft sky gradient (street below the horizon) with a Fresnel lift -
  // stronger at grazing angles, faint head-on - plus a per-pane value shift, so a facade of windows reads as glass
  // catching the sky instead of flat dark rectangles. It is ALBEDO, so night dims it with everything else.
  let refl = reflect(-Vv, Nf);
  let skyRefl = select(vec3<f32>(0.20, 0.20, 0.22), mix(vec3<f32>(0.50, 0.55, 0.60), vec3<f32>(0.36, 0.45, 0.58), clamp(refl.y * 1.6, 0.0, 1.0)), refl.y > -0.05);
  let cosV = clamp(dot(Vv, Nf), 0.0, 1.0);
  let fres = (0.10 + 0.45 * pow(1.0 - cosV, 3.0)) * (0.75 + 0.5 * h3);
  let glass = mix(glassDark, skyRefl, fres * select(0.8, 0.45, clean));
  // DAY interior: desaturate the room so it reads as dim glass, not a glowing yellow square. Shops show their
  // interior more (a bright shop reads through the glass even by day).
  let roomDay = mix(room, vec3<f32>(dot(room, vec3<f32>(0.34, 0.5, 0.16))), select(0.5, 0.1, isShop));
  // visual-polish #3: shops 0.55 by day (was 0.6 with the rainbow shelves; 0.45 read as a flat grey void after the retone)
  let unlitC = mix(glass, roomDay, select(0.32, 0.55, isShop));
  let litC = mix(room, litTint, 0.2) * 1.1;
  var o: WinShade;
  // (WALL GRAIN / wallCol: computed at the top, before the P8 wall early-out)
  var glassC = mix(unlitC, litC, winWL.y);
  let roomLum = dot(room, vec3<f32>(0.35, 0.5, 0.15));
  // Shops glow with the ROOM itself (shelves / products / strip lights through the glass) at a moderate strength -
  // a flat ~1.2x white made every lit shopfront a blown-out white slab at night (bloom clipped it).
  var glow = select(litTint * (0.5 + roomLum * 0.85), mix(room, litTint, 0.15) * 0.62, isShop);
  // SASH: a thin aluminium frame round the opening + the centre MEETING RAIL where the two sashes overlap. Masonry
  // (non-sash) windows get a slim dark frame at the glass line. Both at the GLASS plane (winG), behind the reveal.
  let fe = min(min(winG.x, 1.0 - winG.x), min(winG.y, 1.0 - winG.y));
  let sashBar = select(0.0, max(1.0 - step(0.035, fe), 1.0 - step(0.018, abs(winG.x - 0.5))), sash);
  let mFrame = select(0.0, 1.0 - step(0.028, fe), !sash && !clean);
  glassC = mix(glassC, vec3<f32>(0.47, 0.49, 0.52), sashBar);
  glassC = mix(glassC, vec3<f32>(0.24, 0.25, 0.27), mFrame);
  // visual-polish #8: the city look's lit-window glow multiplier (patternColor.a; 0 = unset = 1x, the built glow)
  let glowK = select(glowIn, 1.0, glowIn <= 0.0);
  glow = glow * (1.0 - max(sashBar, mFrame)) * glowK;
  // The REVEAL faces: wall material, darker the more they face away from the sky - the head soffit (faces down)
  // darkest, the jambs mid, the sill reveal (faces up) lightest. A lit room spills a little light onto them.
  let revK = select(select(0.97, 0.56, rev.x > 1.5 && rev.x < 2.5), 0.76, rev.x < 1.5);
  glassC = mix(glassC, wallBase * revK * g, onReveal);
  glow = mix(glow, glow * 0.22, onReveal);
  o.base = mix(wallCol, glassC, winWL.x);
  // LIT glass glows at a fixed strength (NOT scaled by the night-dimmed wall emissive, which made lit windows
  // unreadably dim). Day is unchanged: the lit fraction is 0 by day, so no cell takes this branch.
  // visual-polish #3: a shop is lit inside by DAY too - a soft self-glow of the room (behind the glass Fresnel) keeps
  // the retoned shelves from reading as a dark grey void in shade / under awnings. Night (winWL.y = 1) is unchanged.
  let shopDayGlow = select(vec3<f32>(0.0), mix(room, litTint, 0.25) * 0.3 * (1.0 - fres) * (1.0 - onReveal), isShop);
  o.emk = mix(emisIn * winWL.z, mix(emisIn * 0.35 + shopDayGlow, glow, winWL.y), winWL.x);
  return o;
}

// WINDOW REVEAL (persona polish D2): the opening is a real HOLE, depth storeys deep, in front of the glass. From the
// view ray's wall-plane entry point ro (the room trace's cell coords: x along +u, y up, both in storeys; z along the
// outward normal, the glass at z = -depth), find whether the ray leaves the opening's x / y span before it reaches
// the glass. Returns (face, gu, gv, 0): face 0 = it reaches the GLASS at (gu, gv) (opening-normalised 0..1),
// 1 = a side JAMB, 2 = the HEAD soffit (a ray climbing into the hole), 3 = the SILL reveal (a ray dropping into it).
// depth 0 = flush (always face 0 at the entry point). No derivatives inside - safe in branches.
// CPU mirror + orientation checks: src/renderer/3d/interior-mapping.test.ts (windowReveal) - change both together.
fn windowReveal(ro: vec3<f32>, rd: vec3<f32>, x0: f32, x1: f32, y0: f32, y1: f32, depth: f32) -> vec4<f32> {
  let rz = min(rd.z, -0.08);                                     // the same grazing guard as roomTrace
  let tg = depth / -rz;                                          // ray length to the glass plane
  let tx = select(select(1e9, (x1 - ro.x) / rd.x, rd.x > 1e-6), (x0 - ro.x) / rd.x, rd.x < -1e-6);
  let ty = select(select(1e9, (y1 - ro.y) / rd.y, rd.y > 1e-6), (y0 - ro.y) / rd.y, rd.y < -1e-6);
  var face = 0.0;
  if (min(tx, ty) < tg) { face = select(1.0, select(3.0, 2.0, rd.y > 0.0), ty < tx); }
  let gu = (ro.x + rd.x * tg - x0) / max(x1 - x0, 1e-4);
  let gv = (ro.y + rd.y * tg - y0) / max(y1 - y0, 1e-4);
  return vec4<f32>(face, gu, gv, 0.0);
}

// ── PAPERBOARD GRAIN (packaging boardShade) — fine paper TOOTH (the original two-scale value noise
//    at a raised frequency so it reads as fine grain rather than a coarse grid) plus smooth
//    directional machine-direction fibre STREAKS. Returns a multiplicative shade around 1.0;
//    amp = patternColor.a (white 0.06, kraft 0.16). ──
fn pg_hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}
fn pg_vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);                    // smoothstep interpolation → organic, NO grid
  let a = pg_hash21(i + vec2<f32>(0.0, 0.0));
  let b = pg_hash21(i + vec2<f32>(1.0, 0.0));
  let c = pg_hash21(i + vec2<f32>(0.0, 1.0));
  let d = pg_hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn paperGrain(uv: vec2<f32>, amp: f32) -> f32 {
  // Fine paper TOOTH — the original two-scale value noise, frequency RAISED for the box net so it
  // reads as fine grain, not a coarse grid. No flecks/specks (they read as square dots on the box).
  let f1 = fract(sin(dot(floor(vec2<f32>(uv.x * 780.0, uv.y * 150.0)), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let f2 = fract(sin(dot(floor(vec2<f32>(uv.x * 165.0, uv.y * 700.0)), vec2<f32>(39.3468, 11.135)))  * 24634.6345);
  let tooth = (f1 - 0.5) + (f2 - 0.5) * 0.6;
  // Directional machine-direction fibre streaks (smooth, anisotropic — fibres run lengthwise).
  let streak = (pg_vnoise(vec2<f32>(uv.x * 130.0, uv.y * 9.0)) - 0.5) * 0.5;
  return 1.0 + (tooth + streak) * amp;
}

// == PROCEDURAL GROUND (groundShade, bit 18) — P1 ASHLAR LIMESTONE ==============================
// A shader-generated stone-paver floor. Reuses pg_hash21 / pg_vnoise above. NO textures. Returns
// per-fragment albedo + a height field (for the relief normal) + a roughness. Kept cheap: no Voronoi,
// just a running-bond rectangular tiler + a couple of value-noise octaves.
struct GroundOut {
  rgb: vec3<f32>,
  height: f32,
  rough: f32,
  grout: f32,
};
// Compact RGB<->HSV (IQ) so per-tile jitter can nudge hue/sat/value, not just brightness.
fn gr_rgb2hsv(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4<f32>(c.b, c.g, K.w, K.z), vec4<f32>(c.g, c.b, K.x, K.y), step(c.b, c.g));
  let q = mix(vec4<f32>(p.x, p.y, p.w, c.r), vec4<f32>(c.r, p.y, p.z, p.x), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1e-10;
  return vec3<f32>(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn gr_hsv2rgb(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3<f32>(c.x, c.x, c.x) + K.xyz) * 6.0 - vec3<f32>(K.w, K.w, K.w));
  return c.z * mix(vec3<f32>(K.x, K.x, K.x), clamp(p - vec3<f32>(K.x, K.x, K.x), vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}
// ★ METRIC SPACE — world METRES per UV unit, along u and v, recovered from screen-space derivatives
// (the standard cotangent-frame solve). Every ground tiler works in metres rather than UV because of two
// bugs that share this root cause:
//   (a) ANISOTROPIC GROUT — an edge distance in uv-u and one in uv-v were compared against a single grout
//       width, so on any mesh whose uv->world scale differs per axis (a stretched cube, a non-square
//       plane) the row seams rendered thicker than the column seams.
//   (b) ARBITRARY TILE SIZE — mm->uv used a caller-declared extentMeters that defaulted to 20, so
//       applying the material to a mesh that never declares its size produced whatever density a
//       fictional 20 m plane implied, then stretched it by the mesh's scale.
// Deriving the scale here fixes both AND removes the need for the caller to declare anything: a 600 mm
// paver is 600 mm on a plane, on a cube face, at any non-uniform scale. tile/grout params are METRES.
// Degenerate uv (det ~ 0, e.g. a fully collapsed uv triangle) falls back to 1 m per uv unit.
// ⚠ dpdx/dpdy require UNIFORM control flow — call this at fragment top level, never inside the
// groundShade branch (same rule the fwidth-using patternMask calls already follow).
fn gr_uvMetres(uv: vec2<f32>, worldPos: vec3<f32>) -> vec2<f32> {
  let dpx = dpdx(worldPos);
  let dpy = dpdy(worldPos);
  let dux = dpdx(uv);
  let duy = dpdy(uv);
  let det = dux.x * duy.y - dux.y * duy.x;
  if (abs(det) < 1e-12) { return vec2<f32>(1.0, 1.0); }
  let inv = 1.0 / det;
  let dPdu = (dpx * duy.y - dpy * dux.y) * inv;
  let dPdv = (dpy * dux.x - dpx * duy.x) * inv;
  return vec2<f32>(clamp(length(dPdu), 1e-3, 1e5), clamp(length(dPdv), 1e-3, 1e5));
}
// The ASHLAR tiler: which paver owns this point, and the distance to its nearest border — all in METRES
// (p = uv * gr_uvMetres). Returns (colId, rowId, edgeDistMetres). Rows alternate a half-tile offset
// (running bond), so row N+1's vertical seams land at the MIDPOINT of row N's pavers — that mid-tile
// line is the bond, not an artifact.
fn groundCell(p: vec2<f32>, tileW: f32, tileH: f32) -> vec3<f32> {
  let tw = max(tileW, 1e-4);
  let th = max(tileH, 1e-4);
  let row = floor(p.y / th);
  let odd = row - 2.0 * floor(row * 0.5);          // 0 or 1
  let u = p.x + odd * tw * 0.5;                     // running-bond half-offset on odd rows
  let col = floor(u / tw);
  let lx = fract(u / tw);
  let ly = fract(p.y / th);
  let edgeU = min(lx, 1.0 - lx) * tw;              // metres to the L/R border
  let edgeV = min(ly, 1.0 - ly) * th;             // metres to the T/B border — same units as edgeU now
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
// Cheap height-only field from a cell id + edge distance (no colour math) so the ±eps relief samples
// stay light. Shared by ALL tilers (ashlar/radial/border) via groundHeightM.
fn gr_cellHeight(cellId: vec2<f32>, edge: f32, groutW: f32) -> f32 {
  let groutMask = 1.0 - smoothstep(groutW * 0.8, groutW * 1.2, edge);
  let wear = (1.0 - groutMask) * (1.0 - smoothstep(groutW, groutW * 3.5, edge));
  var h = (pg_hash21(cellId + vec2<f32>(5.7, 2.3)) - 0.5) * 0.5;   // per-tile height ~ +/- 3mm-ish
  return h - groutMask * 1.0 + wear * 0.3;                         // grout recess + rounded edge bevel
}
// Shade ONE stone cell — per-tile jitter + macro cloud + grain + pits + grout + edge-wear + height +
// roughness. The P1 machinery, factored out so the radial + border tilers reuse it verbatim (only the
// cell-id / edge-distance differs — §3). cellId identifies the stone; edge = uv distance to its border.
fn gr_shadeCell(p: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32, jitter: f32,
                cellId: vec2<f32>, edge: f32) -> GroundOut {
  // GROUT + EDGE WEAR masks — computed FIRST so the pit term below can be gated by them (a pit that
  // straddles a seam reads as a rendering error, not as stone).
  let groutMask = 1.0 - smoothstep(groutW * 0.8, groutW * 1.2, edge);
  let wear = (1.0 - groutMask) * (1.0 - smoothstep(groutW, groutW * 3.5, edge));
  // PER-TILE jitter — brightness +/-8%, hue +/-2deg, sat +/-5%; neighbours never identical.
  let h1 = pg_hash21(cellId + vec2<f32>(0.13, 0.71));
  let h2 = pg_hash21(cellId * 1.7 + vec2<f32>(4.2, 1.1));
  let h3 = pg_hash21(cellId * 2.3 + vec2<f32>(9.1, 3.3));
  var hsv = gr_rgb2hsv(base);
  hsv.x = fract(hsv.x + (h2 - 0.5) * (2.0 / 360.0) * 2.0 * jitter);
  hsv.y = clamp(hsv.y * (1.0 + (h3 - 0.5) * 0.10 * jitter), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + (h1 - 0.5) * 0.16 * jitter), 0.0, 1.0);
  var col = gr_hsv2rgb(hsv);
  // MACRO cloud — very-low-freq drift kills tiled-floor uniformity (some areas yellower/darker).
  // Frequencies are now CYCLES PER METRE, so feature size is physical and identical on every mesh.
  let cloud = pg_vnoise(p * 0.15) - 0.5;
  col = col * (1.0 + cloud * 0.10);
  // MICRO grain.
  let grain = pg_vnoise(p * 11.0) - 0.5;
  col = col * (1.0 + grain * 0.05);
  // PITS — sparse shallow chips in the stone. Previously floor(uv * 160) + a hard step(), which darkened
  // a WHOLE grid cell to 55%: on a 20 m plane that is a 12 cm axis-aligned black SQUARE that also ran
  // straight through the grout. Now 2.5 cm cells with a round soft-edged falloff, and multiplied by
  // (1 - groutMask) so pitting stops at the seam.
  let pc = p * 40.0;                                     // 2.5 cm cells
  let ph = pg_hash21(floor(pc));
  let pd = 1.0 - smoothstep(0.10, 0.34, length(fract(pc) - vec2<f32>(0.5)));
  let pitAmt = step(0.985, ph) * pd * (1.0 - groutMask);
  col = col * mix(1.0, 0.72, pitAmt);
  col = mix(col, col * 1.12, wear * 0.6);          // polished edge is brighter
  col = mix(col, grout, groutMask);                // recessed seam colour
  // HEIGHT (per-tile + grout recess + edge bevel) and ROUGHNESS.
  var h = (pg_hash21(cellId + vec2<f32>(5.7, 2.3)) - 0.5) * 0.5;
  h = h - groutMask * 1.0 + wear * 0.3;
  var rough = 0.55 + (pg_hash21(cellId + vec2<f32>(2.1, 8.4)) - 0.5) * 0.10;  // 0.45..0.65 per tile
  rough = rough + groutMask * 0.25 - wear * 0.15;                             // +grout, -worn edge
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = groutMask;
  return o;
}
// ASHLAR (mode 0): running-bond rectangular pavers — the P1 courtyard field. Thin wrapper over gr_shadeCell.
// p = metric surface coords (metres); tileW/tileH/groutW are metres too.
fn groundAshlar(p: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                tileW: f32, tileH: f32, jitter: f32) -> GroundOut {
  let c = groundCell(p, tileW, tileH);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}

// == PROCEDURAL GROUND P2 — WEATHERING MASKS + PROFILES (procedural-ground.md §5) ================
// Usage-biased aging layered OVER the P1 ashlar output — the #1 walked-on realism cue. Four cheap
// per-fragment masks from uv (reuse pg_vnoise / pg_hash21, capped octaves). Each is a small fn so the
// P5 scatter pass can mirror the CPU formula later (CPU-side equivalent = future work). One PROFILE
// knob scales all four contributions → five looks.
fn gr_fbm2(p: vec2<f32>) -> f32 {
  // 2-octave value noise — organic low-freq usage field. Cheap.
  return pg_vnoise(p) * 0.65 + pg_vnoise(p * 2.3 + vec2<f32>(7.1, 3.7)) * 0.35;
}
// edgeMask: 1 at the region/UV border, 0 interior; .y = CORNER extreme (near TWO borders at once).
// CPU-side equivalent (future): signed distance to the zone polygon border.
fn gr_edgeMask(uv: vec2<f32>) -> vec2<f32> {
  let dx = min(uv.x, 1.0 - uv.x);
  let dy = min(uv.y, 1.0 - uv.y);
  let band = 0.16;
  let edge = 1.0 - smoothstep(0.0, band, min(dx, dy));
  let ex = 1.0 - smoothstep(0.0, band, dx);
  let ey = 1.0 - smoothstep(0.0, band, dy);
  return vec2<f32>(clamp(edge, 0.0, 1.0), clamp(ex * ey, 0.0, 1.0));
}
// wearMask: the walked-on field — low-freq usage noise OR an explicit wear PATH (center pc + radius pr;
// pr 0 = noise only). CPU-side equivalent (future): distance to the world graph's path splines (§5).
fn gr_wearMask(uv: vec2<f32>, pc: vec2<f32>, pr: f32) -> f32 {
  let noiseWear = smoothstep(0.52, 0.9, gr_fbm2(uv * 2.2 + vec2<f32>(1.3, 4.8)));
  var pathWear = 0.0;
  if (pr > 1e-4) {
    pathWear = 1.0 - smoothstep(pr * 0.5, pr, distance(uv, pc));   // bright smooth worn track
  }
  return clamp(max(noiseWear * 0.7, pathWear), 0.0, 1.0);
}
// moistureMask: edge + low-freq noise, lifted into the grout seams → moss tint.
fn gr_moistMask(uv: vec2<f32>, edge: f32, groutMask: f32) -> f32 {
  let n = gr_fbm2(uv * 1.6 + vec2<f32>(9.2, 2.1));
  let m = clamp(edge * 0.6 + smoothstep(0.55, 0.95, n) * 0.7, 0.0, 1.0);
  return clamp(m * (0.4 + 0.6 * groutMask), 0.0, 1.0);
}
// dirtMask: accumulation at edges/corners + noise → darker + rougher.
fn gr_dirtMask(uv: vec2<f32>, edge: f32, corner: f32) -> f32 {
  let n = gr_fbm2(uv * 3.1 + vec2<f32>(4.4, 8.9));
  return clamp(edge * 0.5 + corner * 0.5 + smoothstep(0.6, 0.95, n) * 0.5, 0.0, 1.0);
}
// PROFILE weights (edgeW, wearW, mossW, dirtW): new / worn / ancient / mossy / dirty. One knob, five looks.
fn gr_profile(idx: f32) -> vec4<f32> {
  let i = i32(idx + 0.5);
  if (i <= 0) { return vec4<f32>(0.06, 0.06, 0.0, 0.04); }    // new — nearly off
  if (i == 2) { return vec4<f32>(1.3, 0.8, 0.9, 0.9); }       // ancient — heavy edge-round + moss + dirt
  if (i == 3) { return vec4<f32>(0.7, 0.5, 1.7, 0.4); }       // mossy — moss dominant
  if (i == 4) { return vec4<f32>(0.9, 0.5, 0.2, 1.6); }       // dirty — dirt dominant
  return vec4<f32>(0.7, 1.0, 0.5, 0.6);                       // worn (default)
}
// Layer the four masks over a P1 GroundOut: wear brightens + polishes + rounds; dirt/edge darken +
// roughen; moss tints seams/edges; corners chip (deeper bevel + darker). Subtle — ages, not repaints.
// mc = the MASK coordinate. For a standalone plane that is the uv (a 0..1 region) and edgeAmt is 1. For
// CITY ground — where uv is a world parameterisation (worldXZ * 0.5) so adjacent meshes tile continuously —
// it is a world-scaled coordinate and edgeAmt is 0: gr_edgeMask would otherwise see a border distance far
// outside 0..1, saturate to 1 across the ENTIRE city, and darken + corner-chip every road and pavement.
fn groundWeather(g: GroundOut, mc: vec2<f32>, edgeAmt: f32, profile: f32, pc: vec2<f32>, pr: f32) -> GroundOut {
  let w = gr_profile(profile);
  let ec = gr_edgeMask(mc) * edgeAmt;
  let edge = ec.x;
  let corner = ec.y;
  let wear = gr_wearMask(mc, pc, pr) * w.y;
  let dirt = gr_dirtMask(mc, edge, corner) * w.w;
  let moss = gr_moistMask(mc, edge, g.grout) * w.z;
  let edgeD = edge * w.x;
  let inv = 1.0 - wear;                              // high wear washes out dirt/moss/edge
  var col = g.rgb;
  var rough = g.rough;
  var h = g.height;
  // WEAR — brighter, smoother (-rough), edges flatter/rounded (raise height in the relief).
  col = mix(col, col * 1.14, wear);
  rough = rough - wear * 0.28;
  h = h + wear * 0.22;
  // DIRT — darken + roughen (warm grime), biased to edges/corners.
  col = mix(col, col * vec3<f32>(0.80, 0.76, 0.70), dirt * inv);
  rough = rough + dirt * 0.22;
  // EDGE — darker at region borders.
  col = mix(col, col * 0.78, edgeD * inv);
  // MOSS — green tint in seams + at edges, slightly darker + rougher.
  col = mix(col, vec3<f32>(0.30, 0.42, 0.22), moss * 0.55 * inv);
  rough = rough + moss * 0.15;
  // CORNER CHIP — deeper bevel + darker (edge-wear extreme).
  let chip = corner * w.x;
  h = h - chip * 0.6;
  col = mix(col, col * 0.7, chip * 0.5 * inv);
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = g.grout;
  return o;
}

// == PROCEDURAL GROUND P3 — RADIAL MEDALLION + BORDER STRIP TILERS (procedural-ground.md §3) =====
// Two more cell-id / edge-distance functions; they feed the SAME gr_shadeCell + gr_cellHeight + P2
// weathering as ashlar (only the cell layout differs). radialMedallion = POLAR tiling (rings x wedges),
// the courtyard centrepiece; borderStrip = long linear pavers, the plaza frame band.
// RADIAL (mode 1): centred on the disc mesh's uv centre, expressed in METRES (centre = uvM * 0.5, i.e.
// half the mesh's world extent). ringSpacing is metres. Returns (ring, wedge, edgeDistMetres).
fn groundCellRadial(p: vec2<f32>, centre: vec2<f32>, ringSpacing: f32, wedges: f32) -> vec3<f32> {
  let d = p - centre;
  let r = length(d);
  let TAU = 6.28318530718;
  var theta = atan2(d.y, d.x);
  theta = theta - TAU * floor(theta / TAU);        // 0..TAU
  let rs = max(ringSpacing, 1e-4);
  let wn = max(wedges, 1.0);
  let ring = floor(r / rs);
  let wf = theta / TAU * wn;                        // 0..wedges
  let wedge = floor(wf);
  let lr = fract(r / rs);
  let edgeR = min(lr, 1.0 - lr) * rs;              // metres to the nearest ring border
  let lw = fract(wf);
  let arc = (TAU / wn) * max(r, 1e-4);            // wedge arc LENGTH in metres at this radius
  let edgeW = min(lw, 1.0 - lw) * arc;            // metres to the nearest wedge border
  return vec3<f32>(ring, wedge, min(edgeR, edgeW));
}
// BORDER (mode 2): long linear stones tiled along the strip length (metres), with rowCount rows spread
// across the strip's WIDTH. Row height stays a fraction of the band (uvM.y / rowCount) rather than an
// absolute metre value, because the caller sizes the band relative to the plaza, not in stone units.
fn groundCellBorder(p: vec2<f32>, uvM: vec2<f32>, stoneLen: f32, rowCount: f32) -> vec3<f32> {
  let sl = max(stoneLen, 1e-4);
  let sw = max(uvM.y / max(rowCount, 1.0), 1e-4);   // row height in metres
  let col = floor(p.x / sl);
  let row = floor(p.y / sw);
  let lx = fract(p.x / sl);
  let ly = fract(p.y / sw);
  let edgeU = min(lx, 1.0 - lx) * sl;
  let edgeV = min(ly, 1.0 - ly) * sw;
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
fn groundRadial(p: vec2<f32>, centre: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                ringSpacing: f32, wedges: f32, jitter: f32) -> GroundOut {
  let c = groundCellRadial(p, centre, ringSpacing, wedges);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}
fn groundBorder(p: vec2<f32>, uvM: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                stoneLen: f32, rowCount: f32, jitter: f32) -> GroundOut {
  let c = groundCellBorder(p, uvM, stoneLen, rowCount);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}

// == PROCEDURAL GROUND P4 — GRASS SURFACE + DIRT-PATH BLEND (procedural-ground.md §8-§9) =========
// Tiler NONE: pure layered noise (no pavers/grout). base = green tint, dirt = the bare-path colour the
// lawn blends toward where the P2 wear mask (wpc + wpr = the wear PATH, §5/§9) is high. High roughness,
// very subtle height (no hard tile edges).
// p = metric coords (metres) for the physical noise; mc is the MASK coordinate the wear/moisture masks
// are defined in (position within the zone / across the world, not physical size).
fn groundGrass(p: vec2<f32>, mc: vec2<f32>, base: vec3<f32>, dirt: vec3<f32>, jitter: f32,
               wpc: vec2<f32>, wpr: f32) -> GroundOut {
  // ★ TURF IS THREE SCALES. A lawn reads as (a) broad mow/health drift over metres, (b) hand-sized
  // CLUMPS each with its own green, and (c) blade-scale striation *inside* a clump running whichever way
  // that clump happens to lie. The first version had only (a) plus one globally-aligned anisotropic
  // streak, which smears into wet mud at any zoom, and dry flecks drawn by a hard step() on
  // floor(p * 4.5) — 22 cm axis-aligned tan SQUARES, the same defect as the old ashlar pits.
  var col = base;
  // (a) BROAD drift — health/mow patches, several metres across.
  // NB: macro is a RESERVED keyword in WGSL — never name an identifier that (it fails at
  // CreateShaderModule at runtime, NOT at build time). Hence macroBlob.
  let macroBlob = gr_fbm2(p * 0.2);
  col = mix(col, col * vec3<f32>(1.10, 1.04, 0.74), smoothstep(0.62, 0.96, macroBlob) * 0.26 * jitter); // dry/yellow patch
  col = col * (1.0 + (macroBlob - 0.5) * 0.13);
  // (b) CLUMPS — smooth noise, NOT a hash grid (a floor() grid is exactly what drew squares). Vary hue,
  // saturation and value separately: same-value/different-hue is what real turf does.
  let clump = gr_fbm2(p * 2.6 + vec2<f32>(11.3, 4.9));
  let clumpB = pg_vnoise(p * 5.1 + vec2<f32>(2.2, 7.7));
  var hsv = gr_rgb2hsv(col);
  hsv.x = fract(hsv.x + (clump - 0.5) * 0.030 * jitter);
  hsv.y = clamp(hsv.y * (1.0 + (clumpB - 0.5) * 0.22 * jitter), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + (clump - 0.5) * 0.28 * jitter), 0.0, 1.0);
  col = gr_hsv2rgb(hsv);
  // (c) BLADE striation — fine, and ROTATED PER CLUMP so the surface never reads as combed one way.
  let ang = clump * 6.28318530718;
  let ca = cos(ang);
  let sa = sin(ang);
  let pr = vec2<f32>(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  let blade = pg_vnoise(vec2<f32>(pr.x * 26.0, pr.y * 150.0));   // ~4 cm across the blades, ~7 mm along
  col = col * (1.0 + (blade - 0.5) * 0.17);
  // (d) SPARSE dead/dry flecks — small, round and soft-edged (see the note above).
  let fc = p * 26.0;                                             // ~4 cm cells
  let fh = pg_hash21(floor(fc));
  let fd = 1.0 - smoothstep(0.06, 0.30, length(fract(fc) - vec2<f32>(0.5)));
  col = mix(col, vec3<f32>(0.55, 0.50, 0.30), step(0.972, fh) * fd * 0.55);
  // MOISTURE / moss tint (reuse the P2 mask; damp areas darker + greener).
  let moist = gr_moistMask(mc, 0.0, 0.0);
  col = mix(col, col * vec3<f32>(0.80, 0.95, 0.72), moist * 0.40);
  var h = (pg_vnoise(p * 2.5) - 0.5) * 0.15;       // soft, no tile edges
  var rough = 0.90;
  // DIRT-PATH BLEND (§9): grass 100->0% across the wear band, exposing bare dirt where worn.
  let wear = gr_wearMask(mc, wpc, wpr);
  let bare = smoothstep(0.25, 0.85, wear);
  var dcol = dirt * (1.0 + (pg_vnoise(p * 6.0) - 0.5) * 0.16);
  let pit = pg_hash21(floor(p * 3.5));
  dcol = dcol * mix(1.0, 0.80, step(0.90, pit));   // scattered dark specks in the dirt
  col = mix(col, dcol, bare);
  rough = mix(rough, 1.0, bare);
  h = mix(h, h * 0.4 - 0.08, bare);                // path a touch lower + flatter
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = 0.0;
  return o;
}

// == NEON / SCREEN SIGN (neonShade, bit 22) ======================================================
// The holoboards and neon panels used the waves pattern motif — a colour band scrolled across the
// ALBEDO — and leaned on a high emissive to be seen at all. Same failure as the old water: it is a
// painted animation. A sign reads as EMITTING when it has structure that light does not explain:
//   1. SCANLINES across the panel, drifting slowly (a screen is scanned, not lit evenly);
//   2. per-sign FLICKER on its own hashed phase, with an occasional deeper dropout — a tube warming up
//      or failing is the single most recognisable neon cue, and it must differ per sign or the whole
//      street pulses in unison;
//   3. an EDGE FALLOFF so the panel is brightest at its centre, which is what a diffuser actually does;
//   4. a BLOOM-ish rim that lifts the accent colour where the panel meets its border.
// Slots: patternColor = (glow.rgb, packed accent rgb), patternParams = (scanDensity, flicker, scroll, phase).
fn neonSign(uv: vec2<f32>, glow: vec3<f32>, accent: vec3<f32>, scanDensity: f32,
            flicker: f32, scroll: f32, phase: f32, time: f32) -> vec3<f32> {
  let t = time;
  // SCANLINES — a sharp-ish band, drifting. pow() keeps the dark gaps thin so it reads as a screen
  // rather than as stripes.
  let scan = pow(0.5 + 0.5 * sin((uv.y * max(scanDensity, 1.0) + t * scroll) * 6.2831853), 1.6);
  // FLICKER — two incommensurate rates so it never looks like a clean sine, plus a rare deep dropout.
  let f1 = sin(t * 11.3 + phase * 6.28);
  let f2 = sin(t * 27.7 + phase * 12.9);
  let dropout = step(0.986, fract(sin(floor(t * 7.0 + phase * 31.0) * 12.9898) * 43758.5453));
  let flick = 1.0 - flicker * (0.5 + 0.25 * f1 + 0.25 * f2) * 0.5 - dropout * 0.55;
  // EDGE FALLOFF — brightest in the middle, like a lit diffuser panel.
  let e = uv * 2.0 - vec2<f32>(1.0);
  let vign = clamp(1.0 - dot(e, e) * 0.35, 0.35, 1.0);
  // ACCENT RIM where the panel meets its border.
  let rim = smoothstep(0.72, 1.0, max(abs(e.x), abs(e.y)));
  let body = glow * (0.55 + 0.45 * scan) * vign;
  return (body + accent * rim * 0.8) * max(flick, 0.0);
}

// == PAINTED METAL (metalShade, bit 23) ==========================================================
// The city's largest remaining flat-colour mass: rooftop plant and vents, every railing, every pole,
// signal housings, guardrails — ~70 000 triangles of one grey. Metal is not a colour, it is a RESPONSE:
// it streaks where rain runs down it, collects grime on its upward faces, and its paint rubs bright at
// the edges. None of that comes from a diffuse tint, which is why these read as plastic.
//
// Four cues, all cheap and all driven by WORLD position so neighbouring objects never match:
//   1. per-object TONE, so a row of poles is not one colour;
//   2. RAIN STREAKS — noise stretched hard along Y, gated to near-vertical faces (a flat top has no runs);
//   3. GRIME on upward faces, which is what makes rooftop plant look like rooftop plant;
//   4. a micro roughness break-up so the specular is not a single uniform sheen.
// Slots: patternColor = (tint.rgb, packed streak/grime colour), patternParams = (roughness, streak, grime, scale).
// WARNING: scale is CYCLES PER WORLD UNIT — the city is a diorama (1 unit = 15 m), set it per world.

struct MetalOut { rgb: vec3<f32>, rough: f32 }

fn metalSurface(worldPos: vec3<f32>, N: vec3<f32>, tint: vec3<f32>, streakCol: vec3<f32>,
                rough0: f32, streakAmt: f32, grimeAmt: f32, scale: f32) -> MetalOut {
  let p = worldPos * max(scale, 1e-4);
  // 1 · PER-OBJECT TONE — a coarse cell hash, so each pole/unit sits at its own value.
  let tone = 0.90 + 0.20 * pg_hash21(floor(p.xz * 0.9 + vec2<f32>(p.y * 0.4)));
  var col = tint * tone;
  // 2 · RAIN STREAKS — stretched ~14x along Y and only where the surface is near-vertical.
  let vertical = clamp(1.0 - abs(N.y), 0.0, 1.0);
  let st = pg_vnoise(vec2<f32>(p.x * 5.0 + p.z * 4.0, p.y * 0.35));
  let streak = smoothstep(0.52, 0.95, st) * vertical * streakAmt;
  col = mix(col, streakCol, streak * 0.5);
  // 3 · GRIME on upward faces — rooftop equipment is filthy on top and comparatively clean on its sides.
  let upFace = clamp(N.y, 0.0, 1.0);
  let grime = pg_vnoise(p.xz * 2.2) * upFace * grimeAmt;
  col = mix(col, streakCol * 0.75, grime * 0.4);
  // 4 · MICRO break-up — keeps the specular from reading as one flat sheen across a whole railing.
  // Two ORTHOGONAL 2D samples, not one: pg_vnoise is vec2-only, and sampling p.xz alone is constant
  // along Y, which is exactly the axis a lamp post or a downpipe runs along — it would have striped.
  let micro = pg_vnoise(p.xz * 22.0) * 0.5 + pg_vnoise(vec2<f32>(p.y, p.x + p.z) * 22.0) * 0.5;
  col = col * (1.0 + (micro - 0.5) * 0.10);
  var o: MetalOut;
  o.rgb = col;
  // Wet streaks are SMOOTHER (darker + shinier); grime is rougher.
  o.rough = clamp(rough0 - streak * 0.18 + grime * 0.22 + (micro - 0.5) * 0.10, 0.05, 1.0);
  return o;
}

// == WATER (waterShade, bit 21) ==================================================================
// Replaces the old "waves" pattern motif, which was an ANIMATED ALBEDO BAND — scrolling stripes painted
// on a flat surface. It could not shimmer, because nothing about it touched the surface NORMAL, and light
// is what makes water read as water. This builds a real ripple normal and lights it:
//
//   1. a sum of directional sine waves (each octave rotated, higher frequency, lower amplitude) whose
//      analytic derivative IS the surface gradient — no texture, no normal map, exact normals;
//   2. a second much finer octave set for the micro-chop that produces the glitter;
//   3. FRESNEL — grazing angles reflect, steep angles show the water body colour;
//   4. a tight specular lobe off the ripple normal, which is the sun scintillation;
//   5. the reflection tint comes from the SCENE FOG colour, so the water follows the sky through the
//      day/night cycle without carrying its own sky parameter.
//
// Slots (repurposed pattern instance slots, exclusive with pattern/board/ground/foliage on a mesh):
//   patternColor  = (deep.rgb, packed shallow rgb)
//   patternParams = (waveScale, waveSpeed, choppiness, glitter)
// ⚠ waveScale is CYCLES PER WORLD UNIT, so it must be set for the world's scale — the city is a diorama
// at 1 unit = 15 m, so a ~1.5 m swell is ~10 cycles/unit there and ~0.7 on a 1:1 pond.

struct WaterWave { h: f32, dx: f32, dz: f32 }

// Four rotated octaves. Returns the height and its exact x/z derivatives (the gradient = the normal).
fn wt_waves(p: vec2<f32>, t: f32) -> WaterWave {
  var h = 0.0;
  var dx = 0.0;
  var dz = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var spd = 1.0;
  var dir = vec2<f32>(0.862, 0.507);
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let ph = dot(p, dir) * freq + t * spd;
    h = h + sin(ph) * amp;
    let c = cos(ph) * amp * freq;
    dx = dx + c * dir.x;
    dz = dz + c * dir.y;
    amp = amp * 0.52;
    freq = freq * 1.93;
    spd = spd * 1.31;
    // Rotate each octave ~49 degrees so the sum never lines up into visible parallel banding.
    dir = vec2<f32>(dir.x * 0.656 - dir.y * 0.755, dir.x * 0.755 + dir.y * 0.656);
  }
  var o: WaterWave;
  o.h = h; o.dx = dx; o.dz = dz;
  return o;
}

struct WaterOut { rgb: vec3<f32>, N: vec3<f32>, rough: f32, glint: f32 }

fn waterSurface(worldPos: vec3<f32>, N0: vec3<f32>, V: vec3<f32>, L: vec3<f32>, sky: vec3<f32>,
                deep: vec3<f32>, shallow: vec3<f32>, waveScale: f32, waveSpeed: f32,
                choppy: f32, glitter: f32, time: f32) -> WaterOut {
  let p = worldPos.xz * max(waveScale, 1e-4);
  let t = time * waveSpeed;
  let big = wt_waves(p, t);
  // MICRO CHOP — the fine detail that makes the specular scintillate rather than slide.
  let fine = wt_waves(p * 5.7 + vec2<f32>(13.1, 7.9), t * 2.1);
  let gx = (big.dx + fine.dx * 0.42) * choppy;
  let gz = (big.dz + fine.dz * 0.42) * choppy;
  // Gradient -> normal. Blended toward the surface's own normal so a tilted water plane still reads right.
  var N = normalize(vec3<f32>(-gx, 1.0, -gz));
  N = normalize(N * 0.82 + N0 * 0.18);

  // CREST vs TROUGH: crests catch more light and read shallower. Cheap stand-in for real depth (there is
  // no depth buffer read here) and it keeps the body from being one flat colour.
  let crest = clamp(big.h * 0.35 + 0.5, 0.0, 1.0);
  var col = mix(deep, shallow, crest * 0.45);

  // FRESNEL — the single biggest cue. Nearly all reflection at grazing angles, body colour looking down.
  let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.72);

  // SUN GLITTER — a very tight lobe off the perturbed normal. The fine octave above is what makes this
  // break into moving sparkles instead of one smeared highlight.
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 260.0);
  let sparkle = pow(max(dot(N, H), 0.0), 900.0) * 1.6;
  var o: WaterOut;
  o.rgb = col;
  o.N = N;
  o.rough = clamp(0.10 + (1.0 - crest) * 0.06, 0.02, 1.0);
  o.glint = (spec + sparkle) * max(glitter, 0.0);
  return o;
}

// == PROCEDURAL GROUND P6 — MATERIAL LIBRARY (procedural-ground.md §11) ==========================
// Five more surfaces on the SAME groundShade path — no new pipeline, no new instance slots, just more
// groundMode branches. Two families:
//   TILED   (reuse gr_shadeCell verbatim — only the cell layout differs): cobble, plank, concrete.
//   ORGANIC (their own shading, no cells): asphalt, dirt.
// The stone LOOKS (brick / granite / slate / sandstone) are NOT modes — they are CPU-side presets over
// the ashlar tiler, because a brick and a limestone paver differ in size, colour and jitter, not in
// geometry. See GROUND_SURFACES in shape-manager.

// VORONOI — irregular cells over a jittered grid. Returns (cellIdX, cellIdY, edgeDist) where edgeDist
// is the F2-F1 border distance the grout mask needs. 3x3 neighbourhood is enough for jitter <= 1.
fn gr_worley(p: vec2<f32>) -> vec3<f32> {
  let g = floor(p);
  let f = p - g;
  var best = 1e9;
  var second = 1e9;
  var bid = vec2<f32>(0.0, 0.0);
  for (var j: i32 = -1; j <= 1; j = j + 1) {
    for (var i: i32 = -1; i <= 1; i = i + 1) {
      let o = vec2<f32>(f32(i), f32(j));
      let id = g + o;
      let jit = vec2<f32>(pg_hash21(id), pg_hash21(id + vec2<f32>(7.3, 1.9)));
      let d = length(o + jit - f);
      if (d < best) { second = best; best = d; bid = id; }
      else if (d < second) { second = d; }
    }
  }
  return vec3<f32>(bid.x, bid.y, (second - best) * 0.5);
}
// COBBLE (mode 7): irregular set stones. Pure layout change — the shading is gr_shadeCell, same as ashlar.
fn groundCellCobble(p: vec2<f32>, cellSize: f32) -> vec3<f32> {
  let cs = max(cellSize, 1e-4);
  let w = gr_worley(p / cs);
  return vec3<f32>(w.x, w.y, w.z * cs);              // edge distance back into metres
}
// PLANK (mode 8): boards running along +x, with each ROW's joints staggered so ends never line up.
fn groundCellPlank(p: vec2<f32>, boardLen: f32, boardW: f32) -> vec3<f32> {
  let bl = max(boardLen, 1e-4);
  let bw = max(boardW, 1e-4);
  let row = floor(p.y / bw);
  let stagger = pg_hash21(vec2<f32>(row, 3.1)) * bl;  // per-row offset — the whole point of a plank floor
  let u = p.x + stagger;
  let col = floor(u / bl);
  let lx = fract(u / bl);
  let ly = fract(p.y / bw);
  let edgeU = min(lx, 1.0 - lx) * bl;
  let edgeV = min(ly, 1.0 - ly) * bw;
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
// GRID (mode 5, concrete): plain stack-bond slabs — NO running-bond offset. Poured concrete is cut on a
// square grid; offsetting alternate rows is the single fastest way to make it read as masonry instead.
fn groundCellGrid(p: vec2<f32>, slabW: f32, slabH: f32) -> vec3<f32> {
  let sw = max(slabW, 1e-4);
  let sh = max(slabH, 1e-4);
  let col = floor(p.x / sw);
  let row = floor(p.y / sh);
  let lx = fract(p.x / sw);
  let ly = fract(p.y / sh);
  return vec3<f32>(col, row, min(min(lx, 1.0 - lx) * sw, min(ly, 1.0 - ly) * sh));
}
// WOOD grain over a plank cell — rings stretched hard along the board, plus a per-board tone.
fn groundPlank(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, gapW: f32,
               boardLen: f32, boardW: f32, jitter: f32) -> GroundOut {
  let c = groundCellPlank(p, boardLen, boardW);
  var g = gr_shadeCell(p, base, seam, gapW, jitter * 0.8, vec2<f32>(c.x, c.y), c.z);
  // GRAIN — anisotropic rings. abs(fract*2-1) turns smooth noise into ring LINES, which is what makes
  // wood read as wood rather than as stretched marble.
  let bh = pg_hash21(vec2<f32>(c.x, c.y) + vec2<f32>(1.7, 6.2));
  let gr = pg_vnoise(vec2<f32>(p.x * 1.6 + bh * 40.0, p.y * 34.0));
  let rings = abs(fract(gr * 5.0) * 2.0 - 1.0);
  g.rgb = g.rgb * (1.0 - (1.0 - rings) * 0.20 * jitter);
  g.rgb = g.rgb * (1.0 + (bh - 0.5) * 0.14 * jitter);      // board-to-board tone
  g.rough = clamp(g.rough * 0.85 + (1.0 - rings) * 0.06, 0.04, 1.0);
  return g;
}
// CONCRETE (mode 5): near-uniform slabs — pores, faint trowel mottling, darker expansion joints. The
// restraint IS the material; per-slab hue jitter would read as stone.
fn groundConcrete(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, jointW: f32,
                  slabW: f32, slabH: f32, jitter: f32) -> GroundOut {
  let c = groundCellGrid(p, slabW, slabH);
  var col = base;
  let slabTone = pg_hash21(vec2<f32>(c.x, c.y) + vec2<f32>(2.9, 5.4));
  col = col * (1.0 + (slabTone - 0.5) * 0.07 * jitter);    // pours never match exactly
  col = col * (1.0 + (gr_fbm2(p * 0.9) - 0.5) * 0.10);     // trowel mottling
  col = col * (1.0 + (pg_vnoise(p * 34.0) - 0.5) * 0.06);  // fine surface tooth
  // POROSITY — sparse tiny dark air pockets.
  let pc = p * 55.0;
  let phh = pg_hash21(floor(pc));
  let pdd = 1.0 - smoothstep(0.10, 0.34, length(fract(pc) - vec2<f32>(0.5)));
  col = col * mix(1.0, 0.80, step(0.980, phh) * pdd);
  let jointMask = 1.0 - smoothstep(jointW * 0.7, jointW * 1.3, c.z);
  col = mix(col, seam, jointMask * 0.9);
  var o: GroundOut;
  o.rgb = col;
  o.height = -jointMask * 0.8 + (pg_vnoise(p * 34.0) - 0.5) * 0.06;
  o.rough = clamp(0.80 + (slabTone - 0.5) * 0.08, 0.04, 1.0);
  o.grout = jointMask;
  return o;
}
// ASPHALT (mode 4): loose AGGREGATE, not a tiled surface. Dense stone speckle at two scales, a few
// bright chips, low-freq patch/repair drift, and a thin crack network from ridged noise.
// clean = the tile slot p0 (unused by asphalt, 0 by default): 0 = full cracks, 1 = fresh crack-free road.
// extra = the tile slot p1 (0 by default = the original look, bit for bit): the persona-polish B1 street
// asphalt, i.e. very broad tonal drift plus sparse rectangular REPAIR PATCHES with a thin sealant seam.
// REPAIR PATCH field for asphalt: one candidate per 5 m cell, about 1 cell in 3 patched, a 0.9 to 3.3 m box kept
// inside its cell (so no neighbour search). Returns (inside 0..1, sealant seam 0..1, tone hash 0..1).
fn gr_asphaltPatch(p: vec2<f32>) -> vec3<f32> {
  let cs = 5.0;
  let cell = floor(p / cs);
  let h0 = pg_hash21(cell + vec2<f32>(3.7, 8.1));
  let h1 = pg_hash21(cell + vec2<f32>(11.3, 2.9));
  let h2 = pg_hash21(cell + vec2<f32>(5.9, 14.2));
  let h3 = pg_hash21(cell + vec2<f32>(17.1, 6.6));
  let h4 = pg_hash21(cell + vec2<f32>(1.3, 19.7));
  let sz = vec2<f32>(1.2 + h1 * 2.1, 0.9 + h2 * 1.6);
  let ctr = (cell + vec2<f32>(0.5)) * cs + (vec2<f32>(h3, h4) - vec2<f32>(0.5)) * (vec2<f32>(cs) - sz);
  let d = abs(p - ctr) - sz * 0.5;
  let sd = max(d.x, d.y);                                     // box distance: negative inside
  let on = step(h0, 0.33);
  let inside = (1.0 - smoothstep(-0.01, 0.01, sd)) * on;
  let seam = (1.0 - smoothstep(0.0, 0.03, abs(sd))) * on;
  return vec3<f32>(inside, seam, pg_hash21(cell + vec2<f32>(7.7, 3.3)));
}
fn groundAsphalt(p: vec2<f32>, base: vec3<f32>, jitter: f32, clean: f32, extra: f32) -> GroundOut {
  var col = base;
  col = col * (1.0 + (gr_fbm2(p * 0.35) - 0.5) * 0.22 * jitter);      // age / patch repairs
  // B1 extras (all scaled by ex, so ex = 0 leaves col untouched). Broad drift first: whole stretches of road
  // a shade lighter or darker, far larger than the 3 m age mottle above.
  let ex = clamp(extra, 0.0, 1.0);
  col = col * (1.0 + (gr_fbm2(p * 0.06 + vec2<f32>(2.3, 7.7)) - 0.5) * 0.14 * ex);
  let pt = gr_asphaltPatch(p);
  col = mix(col, col * mix(0.82, 1.09, step(0.65, pt.z)), pt.x * ex); // fresher (darker) or, 1 in 3, sun-bleached
  col = mix(col, col * 0.66, pt.y * 0.8 * ex);                         // tar sealant around the patch
  let a1 = pg_vnoise(p * 60.0);
  let a2 = pg_vnoise(p * 150.0 + vec2<f32>(5.1, 2.3));
  let agg = a1 * 0.6 + a2 * 0.4;
  col = col * (1.0 + (agg - 0.5) * 0.42 * jitter);
  // BRIGHT CHIPS — pale aggregate catching the light.
  let cc = p * 85.0;
  let chh = pg_hash21(floor(cc));
  let cdd = 1.0 - smoothstep(0.10, 0.32, length(fract(cc) - vec2<f32>(0.5)));
  col = mix(col, col * 2.1, step(0.978, chh) * cdd * 0.75 * min(jitter, 1.0));
  // CRACKS — ridged noise: |n - 0.5| is near zero along a whole contour, i.e. a LINE network.
  let cr = abs(gr_fbm2(p * 1.6 + vec2<f32>(9.9, 1.7)) - 0.5) * 2.0;
  let crack = (1.0 - smoothstep(0.0, 0.055, cr)) * (1.0 - clamp(clean, 0.0, 1.0));
  col = col * mix(1.0, 0.42, crack * 0.85);
  var o: GroundOut;
  o.rgb = col;
  o.height = (agg - 0.5) * 0.10 - crack * 0.55 - pt.y * 0.25 * ex;
  o.rough = clamp(0.84 + (agg - 0.5) * 0.12, 0.04, 1.0);
  o.grout = crack;
  return o;
}
// DIRT (mode 6): clumped earth — soft lumps, embedded grit, and dry cracks that only show on the
// high/raised clumps (mud does not craze evenly, which is what makes flat noise read as fabric).
fn groundDirt(p: vec2<f32>, base: vec3<f32>, jitter: f32) -> GroundOut {
  var col = base;
  let broad = gr_fbm2(p * 0.5);
  col = col * (1.0 + (broad - 0.5) * 0.30 * jitter);
  let lump = gr_fbm2(p * 3.4 + vec2<f32>(3.3, 8.8));
  col = col * (1.0 + (lump - 0.5) * 0.26 * jitter);
  col = col * (1.0 + (pg_vnoise(p * 44.0) - 0.5) * 0.12);             // grit
  // SMALL STONES — pale, sparse, soft.
  let sc = p * 30.0;
  let shh = pg_hash21(floor(sc));
  let sdd = 1.0 - smoothstep(0.08, 0.30, length(fract(sc) - vec2<f32>(0.5)));
  col = mix(col, col * 1.55, step(0.972, shh) * sdd * 0.85);
  // CRAZING — gated by the lump field so cracks sit on the dried crests only.
  let cr = abs(gr_fbm2(p * 5.5 + vec2<f32>(1.1, 4.2)) - 0.5) * 2.0;
  let crack = (1.0 - smoothstep(0.0, 0.07, cr)) * smoothstep(0.45, 0.75, lump);
  col = col * mix(1.0, 0.62, crack * 0.7);
  var o: GroundOut;
  o.rgb = col;
  o.height = (lump - 0.5) * 0.5 + (broad - 0.5) * 0.3 - crack * 0.35;
  o.rough = 0.95;
  o.grout = 0.0;
  return o;
}

// ROAD PAINT (mode 20, persona-polish B2): a matte marking laid over asphalt. roadpaint.ts lays the uv in each
// stripe's OWN frame: u runs along the stripe, and the RAW v packs the stripe width with the across position, so no
// mesh split is needed: v = widthCm + 0.1 + across (across in uv units, always under 0.9). gr_paintLocal decodes it
// from the RAW uv (p / uvM), never from the metric p, whose per-mesh scale is an estimate: a few percent off on a
// warped or draped road, which would scramble a packed metric offset. p0 = wear amount; 0 = the base colour exactly
// (flat paint). seam = the asphalt tone that shows through where the paint has worn thin.
// Returns (along m, across m, metres to the NEAREST long edge).
fn gr_paintLocal(p: vec2<f32>, uvM: vec2<f32>) -> vec3<f32> {
  let v = p.y / max(uvM.y, 1e-6);
  let cls = floor(v);
  let across = (v - cls - 0.1) * uvM.y;
  return vec3<f32>(p.x, across, max(min(across, cls * 0.01 - across), 0.0));
}
// Returns (show, thin): show = aggregate peaks poking through, thin = how worn the paint is here.
fn gr_paintWear(p: vec2<f32>, uvM: vec2<f32>, wear: f32) -> vec2<f32> {
  let w = clamp(wear, 0.0, 1.0);
  let lc = gr_paintLocal(p, uvM);
  let q = lc.xy;
  let rag = gr_fbm2(vec2<f32>(q.x * 2.6, q.y * 0.5 + 3.1));
  let band = 0.006 + rag * 0.028;                                   // worn edge band 0.6 to 3 cm, ragged along it
  let edge = 1.0 - smoothstep(0.0, band, lc.z);
  let blot = smoothstep(0.64, 0.88, gr_fbm2(q * vec2<f32>(0.8, 2.2) + vec2<f32>(4.1, 7.3)));   // tyre scuffs
  let thin = clamp(edge * 0.8 + blot * 0.35, 0.0, 1.0) * w;
  let agg = pg_vnoise(q * 60.0) * 0.6 + pg_vnoise(q * 150.0 + vec2<f32>(5.1, 2.3)) * 0.4;
  let show = smoothstep(0.80 - thin * 0.6, 0.94 - thin * 0.6, agg) * thin;
  return vec2<f32>(show, thin);
}
fn groundPaint(p: vec2<f32>, uvM: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, wear: f32) -> GroundOut {
  let pw = gr_paintWear(p, uvM, wear);
  let w = clamp(wear, 0.0, 1.0);
  var col = base * (1.0 + (pg_vnoise(gr_paintLocal(p, uvM).xy * 18.0) - 0.5) * 0.05 * w);   // bead / roller tooth
  col = mix(col, col * 0.92, pw.y * 0.3);                              // thin paint greys slightly
  col = mix(col, seam, pw.x * 0.85);                                   // asphalt showing through
  var o: GroundOut;
  o.rgb = col;
  o.height = -pw.x * 0.3;
  o.rough = 1.0;                                                       // matte: never a sky mirror
  o.grout = 0.0;
  return o;
}

// PAVER TILES (mode 21, persona-polish B3): square stack-bond pavement tiles. A clear per-tile VALUE step (what
// makes a tiled pavement read as tiles from a distance), a faint warm/cool drift per tile, a very soft broad
// mottle, and a THIN SOFT joint that fades into the tile instead of a hard dark line. p0/p1 = tile size (m),
// groutW = joint width (m), jitter = per-tile variation, seam = joint colour.
fn gr_tileJoint(edge: f32, jointW: f32) -> vec2<f32> {
  let joint = 1.0 - smoothstep(jointW * 0.35, jointW * 1.6, edge);
  let bevel = 1.0 - smoothstep(jointW, jointW + 0.015, edge);         // arris: the last 1.5 cm rolls off
  return vec2<f32>(joint, bevel);
}
fn groundTiles(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, jointW: f32,
               tileW: f32, tileH: f32, jitter: f32) -> GroundOut {
  let c = groundCellGrid(p, tileW, tileH);
  let id = vec2<f32>(c.x, c.y);
  let hv = pg_hash21(id + vec2<f32>(4.4, 9.2));
  let hh = pg_hash21(id * 1.9 + vec2<f32>(2.2, 0.7));
  var col = base * (1.0 + (hv - 0.5) * 0.10 * jitter);
  col = col * (vec3<f32>(1.0) + vec3<f32>(1.0, 0.0, -1.0) * (hh - 0.5) * 0.03 * jitter);
  col = col * (1.0 + (gr_fbm2(p * 0.4) - 0.5) * 0.06);
  col = col * (1.0 + (pg_vnoise(p * 30.0) - 0.5) * 0.04);
  let jb = gr_tileJoint(c.z, jointW);
  col = col * (1.0 - jb.y * 0.05);
  col = mix(col, seam, jb.x * 0.55);
  var o: GroundOut;
  o.rgb = col;
  o.height = -jb.x * 0.45 - jb.y * 0.1;
  o.rough = clamp(0.82 + (hv - 0.5) * 0.06, 0.04, 1.0);
  o.grout = jb.x * 0.5;
  return o;
}

// SHINGLE (mode 9): overlapping scalloped roof/wall shingles. Rows stack along p.y (rowH = p1), shingles
// repeat along p.x (shingleW = p0), each row offset half a shingle (running bond). The exposed lower edge is
// rounded (wider gap toward the shingle sides), and a soft shadow under the overlapping row above sells the
// layering. In UV-metric space, so on a cone roof the narrowing UVs make the courses converge toward the apex.
fn groundShingle(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, shingleW: f32, rowH: f32, jitter: f32) -> GroundOut {
  let sw = max(shingleW, 1e-4);
  let rh = max(rowH, 1e-4);
  let rowf = p.y / rh;
  let row = floor(rowf);
  let vy = fract(rowf);                          // 0 bottom .. 1 top of this course
  let offset = fract(row * 0.5);                 // 0 or 0.5 — running bond
  let sxf = p.x / sw + offset;
  let col = floor(sxf);
  let ux = fract(sxf);                           // 0..1 across the shingle
  let rnd = pg_hash21(vec2<f32>(col, row));
  let groutFrac = clamp(groutW / rh, 0.02, 0.45);
  let roundc = 0.5 - abs(ux - 0.5);              // 0 at edges, 0.5 at centre
  let bottomGap = groutFrac * (0.35 + 3.0 * (0.5 - roundc));   // wider gap at the sides -> rounded lower edge
  let hgap = 1.0 - smoothstep(0.0, bottomGap + 0.02, vy);      // dark band along the bottom (overlap shadow)
  let vgap = min(ux, 1.0 - ux) * sw;
  let vseam = 1.0 - smoothstep(0.0, groutW, vgap);
  let seamMask = max(hgap, vseam);
  var c3 = base * (0.82 + 0.18 * rnd);           // per-shingle tint variation
  c3 = c3 * (1.0 + (gr_fbm2(p * 8.0) - 0.5) * 0.12 * jitter);
  let overlap = smoothstep(0.55, 1.0, vy);       // top of the course sits under the next row -> shade
  c3 = c3 * (1.0 - overlap * 0.35);
  let lip = (1.0 - smoothstep(bottomGap, bottomGap + 0.12, vy)) * (1.0 - hgap);   // lit lower lip
  c3 = c3 * (1.0 + lip * 0.16);
  c3 = mix(c3, seam, seamMask * 0.85);
  var o: GroundOut;
  o.rgb = c3;
  o.height = (1.0 - seamMask) * (0.35 + (1.0 - vy) * 0.65) * 0.6 - seamMask * 0.4;
  o.rough = 0.62;
  o.grout = seamMask;
  return o;
}

// HALF-TIMBER (mode 10): a plaster panel (base = plaster tint) framed by a TIMBER lattice (seam = beam
// brown). Each panel gets four framing beams (vertical posts + horizontal rails, shared on panel borders)
// plus one diagonal brace whose direction ALTERNATES per panel (a zig-zag, so the frame reads as real
// carpentry, not a mechanical grid). p0 = panel width, p1 = panel height, groutW = full beam width.
fn groundHalfTimber(p: vec2<f32>, plaster: vec3<f32>, beam: vec3<f32>, beamW: f32, panelW: f32, panelH: f32, jitter: f32) -> GroundOut {
  let pw = max(panelW, 1e-4);
  let ph = max(panelH, 1e-4);
  let ux = fract(p.x / pw);
  let uy = fract(p.y / ph);
  let dx = min(ux, 1.0 - ux) * pw;               // metres to the nearest vertical border (post)
  let dy = min(uy, 1.0 - uy) * ph;               // metres to the nearest horizontal border (rail)
  let hw = beamW * 0.5;
  let post = 1.0 - smoothstep(hw, hw + 0.012, dx);
  let rail = 1.0 - smoothstep(hw, hw + 0.012, dy);
  let panelCol = floor(p.x / pw);
  let panelRow = floor(p.y / ph);
  let flipS = step(0.25, fract((panelCol + panelRow) * 0.5));   // 0 or 1 — alternate the brace direction
  let diagCoord = mix(ux - uy, ux + uy - 1.0, flipS);          // main diagonal / anti-diagonal
  let dd = abs(diagCoord) * min(pw, ph) * 0.70710678;
  let brace = 1.0 - smoothstep(hw, hw + 0.012, dd);
  let beamMask = max(max(post, rail), brace);
  var col = plaster * (1.0 + (gr_fbm2(p * 3.0) - 0.5) * 0.10 * jitter);   // plaster: soft off-white
  col = col * (1.0 + (pg_vnoise(p * 55.0) - 0.5) * 0.06);                 // fine plaster grain
  let woodGrain = gr_fbm2(vec2<f32>(p.x * 1.5, p.y * 14.0));              // grain runs ALONG the beam
  let wood = beam * (0.82 + 0.30 * woodGrain);
  col = mix(col, wood, beamMask);
  var o: GroundOut;
  o.rgb = col;
  o.height = beamMask * 0.6 - (1.0 - beamMask) * 0.08;   // beams proud of the recessed plaster
  o.rough = mix(0.90, 0.62, beamMask);                   // plaster matte, timber a touch smoother
  o.grout = 0.0;
  return o;
}

// RADIAL SHINGLE (mode 11): the polar cousin of mode 9 — concentric COURSES (rings along radius, ringH = p1)
// of SCALLOPS (repeating around the angle) that converge to the centre, for domes / turret caps / rosette
// roofs. The scallop count scales with each ring's circumference so a scallop stays ~scallopW (p0) wide at
// any radius; each course is offset half a scallop (running bond), the exposed lower edge (facing the eave,
// larger r) is rounded, and the course above casts an overlap shadow. Centre = uvM*0.5 (like the medallion),
// so it needs a disc-like / planar UV (a turret cap or flat rosette), not a lat-long sphere UV.
fn groundRadialShingle(p: vec2<f32>, centre: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, scallopW: f32, ringH: f32, jitter: f32) -> GroundOut {
  let d = p - centre;
  let r = length(d);
  let TAU = 6.28318530718;
  var theta = atan2(d.y, d.x);
  theta = theta - TAU * floor(theta / TAU);        // 0..TAU
  let rh = max(ringH, 1e-4);
  let sw = max(scallopW, 1e-4);
  let ringf = r / rh;
  let ring = floor(ringf);
  let vy = 1.0 - fract(ringf);                      // 0 at the OUTER (eave, exposed) edge, 1 at the inner (covered) edge
  let rMid = (ring + 0.5) * rh;
  let scallops = max(floor(TAU * max(rMid, rh) / sw + 0.5), 6.0);   // integer count → tiles the full ring cleanly
  let offset = fract(ring * 0.5);                   // running bond between courses
  let af = theta / TAU * scallops + offset;
  let col = floor(af);
  let ux = fract(af);                               // 0..1 across the scallop
  let rnd = pg_hash21(vec2<f32>(col, ring));
  let groutFrac = clamp(groutW / rh, 0.02, 0.45);
  let roundc = 0.5 - abs(ux - 0.5);
  let bottomGap = groutFrac * (0.35 + 3.0 * (0.5 - roundc));        // wider gap at the sides -> rounded lower edge
  let hgap = 1.0 - smoothstep(0.0, bottomGap + 0.02, vy);          // overlap shadow under the course above
  let arc = (TAU / scallops) * max(r, 1e-4);        // scallop arc width in metres at this radius
  let vgap = min(ux, 1.0 - ux) * arc;
  let vseam = 1.0 - smoothstep(0.0, groutW, vgap);
  let seamMask = max(hgap, vseam);
  var c3 = base * (0.82 + 0.18 * rnd);
  c3 = c3 * (1.0 + (gr_fbm2(p * 8.0) - 0.5) * 0.12 * jitter);
  let overlap = smoothstep(0.55, 1.0, vy);
  c3 = c3 * (1.0 - overlap * 0.35);
  let lip = (1.0 - smoothstep(bottomGap, bottomGap + 0.12, vy)) * (1.0 - hgap);
  c3 = c3 * (1.0 + lip * 0.16);
  c3 = mix(c3, seam, seamMask * 0.85);
  var o: GroundOut;
  o.rgb = c3;
  o.height = (1.0 - seamMask) * (0.35 + (1.0 - vy) * 0.65) * 0.6 - seamMask * 0.4;
  o.rough = 0.62;
  o.grout = seamMask;
  return o;
}

// THATCH (mode 12): layered straw roof — horizontal COURSES (courseH = p1) of fine vertical STRAWS
// (strawW = p0). Each course has a ragged, shadowed lower fringe (the exposed straw ends); straws carry
// per-strand tint + shading streaks; matte + fluffy height relief. UV-space (rows along p.y).
fn groundThatch(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, strawW: f32, courseH: f32, jitter: f32) -> GroundOut {
  let ch = max(courseH, 1e-4);
  let sw = max(strawW, 1e-4);
  let vy = fract(p.y / ch);                                       // 0 exposed bottom .. 1 tucked top
  let row = floor(p.y / ch);
  let sx = p.x / sw + gr_fbm2(vec2<f32>(p.y * 0.6, row)) * 0.4;   // straws wander a little
  let strawTint = 0.72 + 0.50 * pg_hash21(vec2<f32>(floor(sx), row));
  let streak = 0.85 + 0.30 * gr_fbm2(vec2<f32>(p.x * (3.0 / sw), p.y * 1.5));
  let fringe = gr_fbm2(vec2<f32>(p.x * 9.0, row)) - 0.5;          // ragged lower-edge wobble
  let raggedGap = clamp(groutW / ch, 0.02, 0.30) * (0.6 + fringe * 1.5);
  let hgap = 1.0 - smoothstep(0.0, raggedGap + 0.04, vy);         // fringe + shadow at the course bottom
  let overlap = smoothstep(0.6, 1.0, vy);
  var c3 = base * strawTint * streak;
  c3 = c3 * (1.0 + (gr_fbm2(p * 22.0) - 0.5) * 0.15 * jitter);
  c3 = c3 * (1.0 - overlap * 0.28);
  c3 = mix(c3, seam, hgap * 0.55);
  var o: GroundOut;
  o.rgb = c3;
  o.height = (1.0 - vy) * 0.35 - hgap * 0.30 + (streak - 0.85) * 0.6;
  o.rough = 0.92;
  o.grout = hgap * 0.4;
  return o;
}

// CLAY BARREL TILES (mode 13): rows of half-cylinder tiles (barrelW = p0) running down the slope, each course
// (courseH = p1) overlapping the one below. A rounded cross-section (bright ridge, shaded sides), a shadowed
// valley between barrels, terracotta per-tile tint, glazed (lowish roughness). UV-space.
fn groundClayTile(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, tileW: f32, courseH: f32, jitter: f32) -> GroundOut {
  let tw = max(tileW, 1e-4);
  let ch = max(courseH, 1e-4);
  let ux = fract(p.x / tw);
  let colId = floor(p.x / tw);
  let vy = fract(p.y / ch);
  let row = floor(p.y / ch);
  let x = 2.0 * ux - 1.0;
  let dome = sqrt(max(1.0 - x * x, 0.0));                         // rounded barrel cross-section
  let valley = 1.0 - smoothstep(0.0, groutW / tw, min(ux, 1.0 - ux));
  let tint = 0.82 + 0.30 * pg_hash21(vec2<f32>(colId, row));
  var c3 = base * tint * (0.72 + 0.28 * dome);
  c3 = c3 * (1.0 + smoothstep(0.6, 1.0, dome) * 0.22);            // lit ridge
  c3 = c3 * (1.0 + (gr_fbm2(p * 10.0) - 0.5) * 0.10 * jitter);
  let overlap = smoothstep(0.72, 1.0, vy);
  c3 = c3 * (1.0 - overlap * 0.30);
  c3 = mix(c3, seam, valley * 0.7);
  var o: GroundOut;
  o.rgb = c3;
  o.height = dome * 0.6 - valley * 0.5 - overlap * 0.2;
  o.rough = 0.50;
  o.grout = valley;
  return o;
}

// BARK (mode 14): tree trunk / fence post — vertical fibres (ridgeW = p0) with deep vertical cracks and
// height relief. Organic-looking but scaled by p0 so it tiles in metres. seam tints the crack bottoms.
fn groundBark(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, ridgeW: f32, jitter: f32) -> GroundOut {
  let rw = max(ridgeW, 1e-4);
  let fib = gr_fbm2(vec2<f32>(p.x / rw, p.y * 0.18 / rw));        // vertical fibres (stretched along y)
  let ridge = abs(gr_fbm2(vec2<f32>(p.x * 0.5 / rw, p.y * 0.1 / rw)) - 0.5) * 2.0;
  let crack = 1.0 - smoothstep(0.0, 0.14, ridge);                // deep vertical cracks
  var c3 = base * (0.68 + 0.55 * fib);
  c3 = c3 * (1.0 - crack * 0.5);
  c3 = mix(c3, seam, crack * 0.4);
  c3 = c3 * (1.0 + (gr_fbm2(p * 32.0) - 0.5) * 0.12 * jitter);
  var o: GroundOut;
  o.rgb = c3;
  o.height = (fib - 0.5) * 0.4 + ridge * 0.4 - crack * 0.6;
  o.rough = 0.90;
  o.grout = crack * 0.4;
  return o;
}

// CORRUGATED METAL (mode 15): sinusoidal corrugations (pitch = p0) with panel seams every panelH (= p1),
// brushed streaks, low roughness (reads metallic). Tint grey for steel, or copper/verdigris via the recipe.
fn groundMetal(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, pitch: f32, panelH: f32, jitter: f32) -> GroundOut {
  let pt = max(pitch, 1e-4);
  let ph = max(panelH, 1e-4);
  let wave = sin(fract(p.x / pt) * 6.28318530718);
  let lit = 0.62 + 0.38 * (wave * 0.5 + 0.5);                    // troughs dark, crests bright
  let seamV = 1.0 - smoothstep(0.0, groutW, min(fract(p.y / ph), 1.0 - fract(p.y / ph)) * ph);
  var c3 = base * lit;
  c3 = c3 * (1.0 + (gr_fbm2(vec2<f32>(p.x * 40.0, p.y * 3.0)) - 0.5) * 0.06 * jitter);   // brushed streaks
  c3 = mix(c3, seam, seamV * 0.5);
  var o: GroundOut;
  o.rgb = c3;
  o.height = wave * 0.5 - seamV * 0.3;
  o.rough = 0.35;
  o.grout = seamV;
  return o;
}

// One layer of jittered leaf dabs — returns (leafMask, tint) for compositing two offset layers into a hedge.
fn gr_leafLayer(p: vec2<f32>, ls: f32, off: vec2<f32>) -> vec2<f32> {
  let cell = floor(p / ls + off);
  let lp = fract(p / ls + off) - vec2<f32>(0.5, 0.5);
  let jit = (vec2<f32>(pg_hash21(cell), pg_hash21(cell + vec2<f32>(3.1, 1.7))) - vec2<f32>(0.5, 0.5)) * 0.5;
  let d = length(lp - jit);
  let leaf = 1.0 - smoothstep(0.18, 0.5, d);
  let tint = 0.7 + 0.6 * pg_hash21(cell + vec2<f32>(7.7, 2.3));
  return vec2<f32>(leaf, tint);
}
// LEAVES / HEDGE (mode 16): a mass of clustered leaf dabs (leafSize = p0) in two offset layers for overlap,
// green per-leaf tint variation, soft height. For bushes / canopy / hedges. Organic — no grout.
fn groundLeaves(p: vec2<f32>, base: vec3<f32>, leafSize: f32, jitter: f32) -> GroundOut {
  let ls = max(leafSize, 1e-4);
  let a = gr_leafLayer(p, ls, vec2<f32>(0.0, 0.0));
  let b = gr_leafLayer(p, ls, vec2<f32>(0.37, 0.61));
  var c3 = base;
  c3 = mix(c3, base * a.y, a.x * 0.6);
  c3 = mix(c3, base * b.y, b.x * 0.6);
  c3 = c3 * (1.0 + (gr_fbm2(p * 16.0) - 0.5) * 0.15 * jitter);
  var o: GroundOut;
  o.rgb = c3;
  o.height = max(a.x * (0.4 + 0.4 * a.y), b.x * (0.4 + 0.4 * b.y)) * 0.6 - 0.1;
  o.rough = 0.85;
  o.grout = 0.0;
  return o;
}

// FABRIC / CANVAS (mode 17): a plain over-under WEAVE (thread spacing = p0) with rounded warp/weft threads
// plus soft large FOLDS. For awnings / sails / tents / banners. Organic — no grout.
fn groundFabric(p: vec2<f32>, base: vec3<f32>, threadW: f32, jitter: f32) -> GroundOut {
  let tw = max(threadW, 1e-4);
  let warpOn = step(0.5, fract((floor(p.x / tw) + floor(p.y / tw)) * 0.5) + 0.25);   // plain-weave alternation
  let bump = mix(sin(fract(p.y / tw) * 3.14159265), sin(fract(p.x / tw) * 3.14159265), warpOn);
  let fold = gr_fbm2(p * 0.8);
  var c3 = base * (0.80 + 0.25 * bump) * (0.90 + 0.20 * fold);
  c3 = c3 * (1.0 + (gr_fbm2(p * 26.0) - 0.5) * 0.08 * jitter);
  var o: GroundOut;
  o.rgb = c3;
  o.height = bump * 0.2 + (fold - 0.5) * 0.3;
  o.rough = 0.90;
  o.grout = 0.0;
  return o;
}

// WICKER / BASKET (mode 18): a chunky over-under WEAVE — a checker of rounded strand ridges (strandW = p0),
// alternating which strand sits on top, with dark gaps between and a warm tint. For baskets / wicker furniture.
fn groundWicker(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, strandW: f32, jitter: f32) -> GroundOut {
  let sw = max(strandW, 1e-4);
  let cx = floor(p.x / sw); let cy = floor(p.y / sw);
  let u = fract(p.x / sw) - 0.5; let v = fract(p.y / sw) - 0.5;
  let hOnTop = step(0.5, fract((cx + cy) * 0.5) + 0.25);          // checker: which strand is over
  let topBump = mix(cos(u * 3.14159265), cos(v * 3.14159265), hOnTop);   // rounded on-top strand ridge
  let tint = 0.85 + 0.30 * pg_hash21(vec2<f32>(cx, cy));
  var c3 = base * tint * (0.68 + 0.44 * topBump);
  c3 = c3 * (1.0 + (gr_fbm2(p * 18.0) - 0.5) * 0.10 * jitter);
  c3 = mix(seam, c3, smoothstep(0.0, 0.35, topBump));            // dark gaps between strands
  var o: GroundOut;
  o.rgb = c3;
  o.height = topBump * 0.6 - (1.0 - smoothstep(0.0, 0.20, topBump)) * 0.3;
  o.rough = 0.85;
  o.grout = 1.0 - smoothstep(0.0, 0.35, topBump);
  return o;
}

// ROPE / CORD (mode 19): twisted strands — diagonal helical ridges (strand pitch = p0) with dark grooves and
// fibre grain. For rope, cord, cable, coiled handles.
fn groundRope(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, groutW: f32, ropeW: f32, jitter: f32) -> GroundOut {
  let rw = max(ropeW, 1e-4);
  let phase = p.x / rw * 3.0 - p.y / rw * 1.5;                    // 3 strands twisting along the length
  let ridge = sin(fract(phase) * 3.14159265);                    // rounded strand ridge (0 in the groove)
  let tint = 0.88 + 0.24 * (gr_fbm2(vec2<f32>(floor(phase), p.y * 0.3)) - 0.5);
  var c3 = base * tint * (0.62 + 0.50 * ridge);
  c3 = mix(seam, c3, smoothstep(0.0, 0.30, ridge));              // dark grooves between strands
  c3 = c3 * (1.0 + (gr_fbm2(p * 40.0) - 0.5) * 0.10 * jitter);   // fibre grain
  var o: GroundOut;
  o.rgb = c3;
  o.height = ridge * 0.6 - (1.0 - smoothstep(0.0, 0.25, ridge)) * 0.35;
  o.rough = 0.88;
  o.grout = 1.0 - smoothstep(0.0, 0.30, ridge);
  return o;
}

// SURFACE DISPATCH — pick the tiler by groundMode; P2 weathering (groundWeather) then applies over ALL
// modes uniformly in the fragment shader (weathering is surface-agnostic — not duplicated per mode).
// seam = grout rgb (tilers) OR dirt tint (grass); p0/p1 = tileW/tileH · ringSpacing/wedges · stoneLen/rowW.
// uvM = world metres per uv unit (gr_uvMetres); p = uv * uvM is the metric surface coordinate every
// tiler tiles in, so paver size and grout width are physical and axis-independent.
// mc = the MASK coordinate (see groundWeather) — grass runs the wear/moisture masks itself for its
// dirt-path blend, so it needs the same coordinate the weathering pass uses, not the raw uv.
fn groundSurface(uv: vec2<f32>, uvM: vec2<f32>, mc: vec2<f32>, mode: f32, base: vec3<f32>, seam: vec3<f32>, groutW: f32,
                 p0: f32, p1: f32, jitter: f32, wpc: vec2<f32>, wpr: f32) -> GroundOut {
  let mi = i32(mode + 0.5);
  let p = uv * uvM;
  if (mi == 1) { return groundRadial(p, uvM * 0.5, base, seam, groutW, p0, p1, jitter); }
  if (mi == 2) { return groundBorder(p, uvM, base, seam, groutW, p0, p1, jitter); }
  if (mi == 3) { return groundGrass(p, mc, base, seam, jitter, wpc, wpr); }
  if (mi == 4) { return groundAsphalt(p, base, jitter, p0, p1); }
  if (mi == 5) { return groundConcrete(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 6) { return groundDirt(p, base, jitter); }
  if (mi == 7) {
    let c = groundCellCobble(p, p0);
    return gr_shadeCell(p, base, seam, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
  }
  if (mi == 8) { return groundPlank(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 9) { return groundShingle(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 10) { return groundHalfTimber(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 11) { return groundRadialShingle(p, uvM * 0.5, base, seam, groutW, p0, p1, jitter); }
  if (mi == 12) { return groundThatch(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 13) { return groundClayTile(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 14) { return groundBark(p, base, seam, groutW, p0, jitter); }
  if (mi == 15) { return groundMetal(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 16) { return groundLeaves(p, base, p0, jitter); }
  if (mi == 17) { return groundFabric(p, base, p0, jitter); }
  if (mi == 18) { return groundWicker(p, base, seam, groutW, p0, jitter); }
  if (mi == 19) { return groundRope(p, base, seam, groutW, p0, jitter); }
  if (mi == 20) { return groundPaint(p, uvM, base, seam, p0); }
  if (mi == 21) { return groundTiles(p, base, seam, groutW, p0, p1, jitter); }
  return groundAshlar(p, base, seam, groutW, p0, p1, jitter);
}
// Mode-aware height field for the ±eps relief normal (matches whichever tiler groundSurface used).
// Takes the METRIC coordinate directly so the caller can offset by an epsilon in metres.
fn groundHeightM(p: vec2<f32>, uvM: vec2<f32>, mode: f32, groutW: f32, p0: f32, p1: f32) -> f32 {
  let mi = i32(mode + 0.5);
  // Non-tiled surfaces: cheap height-only mirrors of their shading fields (must track them, or the
  // relief lights a groove that the albedo does not draw).
  if (mi == 3) { return (pg_vnoise(p * 2.5) - 0.5) * 0.15; }   // grass: soft noise, no tile edges
  if (mi == 4) {
    let agg = pg_vnoise(p * 60.0) * 0.6 + pg_vnoise(p * 150.0 + vec2<f32>(5.1, 2.3)) * 0.4;
    let cr = abs(gr_fbm2(p * 1.6 + vec2<f32>(9.9, 1.7)) - 0.5) * 2.0;
    return (agg - 0.5) * 0.10 - (1.0 - smoothstep(0.0, 0.055, cr)) * 0.55 * (1.0 - clamp(p0, 0.0, 1.0))
         - gr_asphaltPatch(p).y * 0.25 * clamp(p1, 0.0, 1.0);
  }
  if (mi == 20) { return -gr_paintWear(p, uvM, p0).x * 0.3; }                 // road paint: worn-through aggregate
  if (mi == 21) {                                                        // paver tiles: soft joint + arris
    let jb = gr_tileJoint(groundCellGrid(p, p0, p1).z, groutW);
    return -jb.x * 0.45 - jb.y * 0.1;
  }
  if (mi == 6) {
    let broad = gr_fbm2(p * 0.5);
    let lump = gr_fbm2(p * 3.4 + vec2<f32>(3.3, 8.8));
    let cr = abs(gr_fbm2(p * 5.5 + vec2<f32>(1.1, 4.2)) - 0.5) * 2.0;
    let crack = (1.0 - smoothstep(0.0, 0.07, cr)) * smoothstep(0.45, 0.75, lump);
    return (lump - 0.5) * 0.5 + (broad - 0.5) * 0.3 - crack * 0.35;
  }
  var c: vec3<f32>;
  if (mi == 1) { c = groundCellRadial(p, uvM * 0.5, p0, p1); }
  else if (mi == 2) { c = groundCellBorder(p, uvM, p0, p1); }
  else if (mi == 5) { c = groundCellGrid(p, p0, p1); }
  else if (mi == 7) { c = groundCellCobble(p, p0); }
  else if (mi == 8) { c = groundCellPlank(p, p0, p1); }
  else if (mi == 9) {
    let sw = max(p0, 1e-4); let rh = max(p1, 1e-4);
    let row = floor(p.y / rh); let vy = fract(p.y / rh);
    let ux = fract(p.x / sw + fract(row * 0.5));
    let groutFrac = clamp(groutW / rh, 0.02, 0.45);
    let bottomGap = groutFrac * (0.35 + 3.0 * abs(ux - 0.5));
    let hgap = 1.0 - smoothstep(0.0, bottomGap + 0.02, vy);
    let vseam = 1.0 - smoothstep(0.0, groutW, min(ux, 1.0 - ux) * sw);
    let seamMask = max(hgap, vseam);
    return (1.0 - seamMask) * (0.35 + (1.0 - vy) * 0.65) * 0.6 - seamMask * 0.4;
  }
  else if (mi == 10) {
    let pw = max(p0, 1e-4); let ph = max(p1, 1e-4);
    let ux = fract(p.x / pw); let uy = fract(p.y / ph);
    let hw = groutW * 0.5;
    let post = 1.0 - smoothstep(hw, hw + 0.012, min(ux, 1.0 - ux) * pw);
    let rail = 1.0 - smoothstep(hw, hw + 0.012, min(uy, 1.0 - uy) * ph);
    let flipS = step(0.25, fract((floor(p.x / pw) + floor(p.y / ph)) * 0.5));
    let dd = abs(mix(ux - uy, ux + uy - 1.0, flipS)) * min(pw, ph) * 0.70710678;
    let brace = 1.0 - smoothstep(hw, hw + 0.012, dd);
    let beamMask = max(max(post, rail), brace);
    return beamMask * 0.6 - (1.0 - beamMask) * 0.08;
  }
  else if (mi == 11) {
    let centre = uvM * 0.5;
    let dd = p - centre; let r = length(dd);
    let TAU = 6.28318530718;
    var theta = atan2(dd.y, dd.x); theta = theta - TAU * floor(theta / TAU);
    let rh = max(p1, 1e-4); let sw = max(p0, 1e-4);
    let ring = floor(r / rh); let vy = 1.0 - fract(r / rh);
    let scallops = max(floor(TAU * max((ring + 0.5) * rh, rh) / sw + 0.5), 6.0);
    let ux = fract(theta / TAU * scallops + fract(ring * 0.5));
    let groutFrac = clamp(groutW / rh, 0.02, 0.45);
    let bottomGap = groutFrac * (0.35 + 3.0 * abs(ux - 0.5));
    let hgap = 1.0 - smoothstep(0.0, bottomGap + 0.02, vy);
    let arc = (TAU / scallops) * max(r, 1e-4);
    let vseam = 1.0 - smoothstep(0.0, groutW, min(ux, 1.0 - ux) * arc);
    let seamMask = max(hgap, vseam);
    return (1.0 - seamMask) * (0.35 + (1.0 - vy) * 0.65) * 0.6 - seamMask * 0.4;
  }
  else if (mi == 12) {                                            // thatch
    let ch = max(p1, 1e-4);
    let vy = fract(p.y / ch);
    let fringe = gr_fbm2(vec2<f32>(p.x * 9.0, floor(p.y / ch))) - 0.5;
    let raggedGap = clamp(groutW / ch, 0.02, 0.30) * (0.6 + fringe * 1.5);
    let hgap = 1.0 - smoothstep(0.0, raggedGap + 0.04, vy);
    let streak = 0.85 + 0.30 * gr_fbm2(vec2<f32>(p.x * (3.0 / max(p0, 1e-4)), p.y * 1.5));
    return (1.0 - vy) * 0.35 - hgap * 0.30 + (streak - 0.85) * 0.6;
  }
  else if (mi == 13) {                                            // clay barrels
    let tw = max(p0, 1e-4); let ch = max(p1, 1e-4);
    let ux = fract(p.x / tw); let x = 2.0 * ux - 1.0;
    let dome = sqrt(max(1.0 - x * x, 0.0));
    let valley = 1.0 - smoothstep(0.0, groutW / tw, min(ux, 1.0 - ux));
    let overlap = smoothstep(0.72, 1.0, fract(p.y / ch));
    return dome * 0.6 - valley * 0.5 - overlap * 0.2;
  }
  else if (mi == 14) {                                            // bark
    let rw = max(p0, 1e-4);
    let fib = gr_fbm2(vec2<f32>(p.x / rw, p.y * 0.18 / rw));
    let ridge = abs(gr_fbm2(vec2<f32>(p.x * 0.5 / rw, p.y * 0.1 / rw)) - 0.5) * 2.0;
    let crack = 1.0 - smoothstep(0.0, 0.14, ridge);
    return (fib - 0.5) * 0.4 + ridge * 0.4 - crack * 0.6;
  }
  else if (mi == 15) {                                            // corrugated metal
    let pt = max(p0, 1e-4); let ph = max(p1, 1e-4);
    let wave = sin(fract(p.x / pt) * 6.28318530718);
    let seamV = 1.0 - smoothstep(0.0, groutW, min(fract(p.y / ph), 1.0 - fract(p.y / ph)) * ph);
    return wave * 0.5 - seamV * 0.3;
  }
  else if (mi == 16) {                                            // leaves / hedge
    let ls = max(p0, 1e-4);
    let a = gr_leafLayer(p, ls, vec2<f32>(0.0, 0.0));
    let b = gr_leafLayer(p, ls, vec2<f32>(0.37, 0.61));
    return max(a.x * (0.4 + 0.4 * a.y), b.x * (0.4 + 0.4 * b.y)) * 0.6 - 0.1;
  }
  else if (mi == 17) {                                            // fabric / canvas
    let tw = max(p0, 1e-4);
    let warpOn = step(0.5, fract((floor(p.x / tw) + floor(p.y / tw)) * 0.5) + 0.25);
    let bump = mix(sin(fract(p.y / tw) * 3.14159265), sin(fract(p.x / tw) * 3.14159265), warpOn);
    let fold = gr_fbm2(p * 0.8);
    return bump * 0.2 + (fold - 0.5) * 0.3;
  }
  else if (mi == 18) {                                            // wicker / basket
    let sw = max(p0, 1e-4);
    let u = fract(p.x / sw) - 0.5; let v = fract(p.y / sw) - 0.5;
    let hOnTop = step(0.5, fract((floor(p.x / sw) + floor(p.y / sw)) * 0.5) + 0.25);
    let topBump = mix(cos(u * 3.14159265), cos(v * 3.14159265), hOnTop);
    return topBump * 0.6 - (1.0 - smoothstep(0.0, 0.20, topBump)) * 0.3;
  }
  else if (mi == 19) {                                            // rope / cord
    let rw = max(p0, 1e-4);
    let ridge = sin(fract(p.x / rw * 3.0 - p.y / rw * 1.5) * 3.14159265);
    return ridge * 0.6 - (1.0 - smoothstep(0.0, 0.25, ridge)) * 0.35;
  }
  else { c = groundCell(p, p0, p1); }
  return gr_cellHeight(vec2<f32>(c.x, c.y), c.z, groutW);
}

// == FOLIAGE SHADE (foliageShade, bit 20) — foliage-quality.md S2 =================================
// The FRAGMENT half of the shared foliage layer: leaf TRANSLUCENCY (the anime backlit cue), a base AO
// and a ground-colour bleed at the plant's base. Instance slots are repurposed exactly like board/ground
// shading: patternColor = (translucency, groundBlend, baseAO, packedGroundTint) and
// patternParams = (windHeight, windStiffness, windAmount, packedTranslucencyColor).
// The two colours are packed 8:8:8 into one float each (packRGB8 in material-3d.ts) because the six
// scalars + two colours do not fit in the eight repurposed floats otherwise.
fn fq_unpackRGB(v: f32) -> vec3<f32> {
  let p = u32(max(v, 0.0));
  return vec3<f32>(f32((p >> 16u) & 255u), f32((p >> 8u) & 255u), f32(p & 255u)) * (1.0 / 255.0);
}
// TRANSMISSION — light that passes THROUGH a thin leaf. Two lobes: a back-lambert (max(0, dot(-N, L)))
// which lights leaves whose BACK faces the sun, plus a view-dependent WRAP (pow(max(0, dot(V, -L)), k))
// so the glow peaks when you look toward the sun through the canopy. Tinted by translucencyColor and
// scaled by translucency; the caller ADDS it on top of the lit result, so it COMPOSES with the rim
// (bit 8) rather than fighting it. Thin cards/blades set it high, trunks/vessels set it 0.
fn foliageTransmission(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, tint: vec3<f32>, amount: f32,
                       lightCol: vec3<f32>, lightInt: f32) -> vec3<f32> {
  if (amount <= 0.0) { return vec3<f32>(0.0); }
  let back = max(dot(-N, L), 0.0);                       // light coming through from behind the leaf
  let wrap = pow(max(dot(V, -L), 0.0), 3.0);             // view-aligned backlight bloom
  return tint * ((back * 0.7 + wrap * 0.5) * amount) * lightCol * max(lightInt, 0.0);
}
// BASE AO + GROUND BLEND — the lowest ~15% of the plant (by the SAME normalized local Y the wind grading
// uses) darkens and picks up the ground colour, so blades/cards read as GROWING FROM the ground instead
// of stuck into it. localY01 = clamp(localY / windHeight, 0, 1) interpolated from the vertex stage.
fn foliageBase(albedo: vec3<f32>, localY01: f32, aoAmount: f32, blend: f32, groundTint: vec3<f32>) -> vec3<f32> {
  let ramp = 1.0 - smoothstep(0.0, 0.15, clamp(localY01, 0.0, 1.0));
  var c = albedo * (1.0 - clamp(aoAmount, 0.0, 1.0) * ramp);
  c = mix(c, groundTint, clamp(blend, 0.0, 1.0) * ramp);
  return c;
}
`;

// ── FOLIAGE WIND (windSway, bit 19) — foliage-quality.md S1, the VERTEX half ──────────────────────
// Included by EVERY vertex shader foliage renders through (mesh3d, vertex-color, and the shadow DEPTH
// pass — a swaying plant whose shadow is static looks broken). Displacement is computed in LOCAL space
// and added BEFORE the model transform, so each instanced copy bends about its own base.
/** Fog-horizon fade band helpers (fhCoverage / fhDitherKeep / fhFades), spliced into every pass that dissolves the
 *  faders: the mesh fragment shaders, the shadow depth pass and the outline depth pre-pass. */
export const FOG_FADE_WGSL = /* wgsl */ `
// FOG HORIZON FADE BAND (docs/specs/fog-horizon.md P2; shared by the colour, shadow-depth and outline passes).
// coverage = smoothstep(edge, edge - band, dist), written out because WGSL smoothstep wants low < high:
// 1 inside the clear zone, 0 at the fog edge. A screen-door dither keeps a pixel while coverage beats its
// 4x4 Bayer threshold; coarse = the same pattern in 2x2-pixel cells (an 8x8-pixel tile). Opaque, no sorting.
const fhBayer = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
fn fhCoverage(dist: f32, edge: f32, band: f32) -> f32 {
  let t = clamp((edge - dist) / max(band, 1e-6), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn fhDitherKeep(cov: f32, fragXY: vec2<f32>, coarse: bool) -> bool {
  var p = vec2<u32>(max(fragXY, vec2<f32>(0.0)));
  if (coarse) { p = p / 2u; }
  return cov > (f32(fhBayer[(p.y % 4u) * 4u + (p.x % 4u)]) + 0.5) / 16.0;
}
// TEMPORAL AA (temporal-aa.ts): the colour passes shift the dither pattern by a whole-pixel offset every frame
// (scene.cascadeParams.w = 0..15, 0 = off), so the resolve averages the screen door into a smooth fade. coarse cells
// shift by whole cells.
fn fhTaaShift(v: f32, coarse: bool) -> vec2<f32> {
  let k = u32(max(v, 0.0));
  return vec2<f32>(f32(k % 4u), f32((k / 4u) % 4u)) * select(1.0, 2.0, coarse);
}
// Whether a mesh fades: flags2 bit 0 (distanceFade) always, bit 1 (distanceFadeAttach) unless the scene keeps
// attachments (scene flag bit 3). fhFlags = u32(scene.toonParams.w).
fn fhFades(flags2: u32, fhFlags: u32) -> bool {
  return (flags2 & 1u) != 0u || ((flags2 & 2u) != 0u && (fhFlags & 8u) == 0u);
}
// Whether a mesh ignores the fog (Material3D.noFog): flags2 bit 2 always, bit 3 only while Hard edge is on (scene
// flag bit 4). Such a mesh takes no fog, no height fog / aerial haze, no silhouette fast path, no outline cut.
fn fhNoFog(flags2: u32, fhFlags: u32) -> bool {
  return (flags2 & 4u) != 0u || ((flags2 & 8u) != 0u && (fhFlags & 16u) != 0u);
}
`;

export const FOLIAGE_WIND_WGSL = /* wgsl */ `
fn fq_hash12(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
// windHeight/stiffness/amount come from the instance's repurposed patternParams.xyz;
// dirRad/strength/speed are SCENE-level (the free lightCounts.yzw slots); time = scene seconds.
fn foliageWindOffset(localPos: vec3<f32>, originWorld: vec3<f32>, windHeight: f32, stiffness: f32,
                     amount: f32, dirRad: f32, strength: f32, speed: f32, time: f32) -> vec3<f32> {
  if (amount <= 0.0 || strength <= 0.0) { return vec3<f32>(0.0); }
  // HEIGHT GRADING: the base stays planted (grade 0 at localY 0), the tip travels. stiffness is the
  // exponent — grass floppy ~1.2, hedge stiff ~3.
  let grade = pow(clamp(localPos.y / max(windHeight, 1e-3), 0.0, 1.0), max(stiffness, 0.05));
  if (grade <= 0.0) { return vec3<f32>(0.0); }
  let dir = vec2<f32>(cos(dirRad), sin(dirRad));
  // PER-INSTANCE PHASE hashed from the instance's WORLD TRANSLATION — a meadow never pulses in unison,
  // and no extra per-instance data is needed (the model matrix already differs per copy).
  let phase = fq_hash12(floor(originWorld.xz * 7.31)) * 6.2831853;
  let t = time * max(speed, 0.0);
  // TRAVELLING GUSTS: a low-frequency wave moving ACROSS the world along the wind direction, so the wind
  // visibly sweeps through a field instead of shimmering in place.
  let gust = 0.55 + 0.45 * sin(dot(originWorld.xz, dir) * 0.35 - t * 0.6);
  // TWO BANDS: a slow sway (the trunk-scale bend) + a faster ripple (the leaf/blade chatter).
  let sway   = sin(t * 1.10 + phase) * 0.75 + sin(t * 0.37 + phase * 1.7) * 0.25;
  let ripple = sin(t * 4.30 + phase * 2.3 + localPos.y * 3.1) * 0.28;
  let mag = strength * amount * grade * gust;
  let side = vec2<f32>(-dir.y, dir.x);
  let off = dir * (mag * (sway + ripple)) + side * (mag * ripple * 0.6);
  // A small downward pull keeps the tip on an arc instead of stretching the plant taller as it leans.
  return vec3<f32>(off.x, -abs(mag * sway) * 0.12 * grade, off.y);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_VERTEX_SHADER = /* wgsl */ `
${FOLIAGE_WIND_WGSL}
${CROWD_PALETTE_WGSL}

// ── Per-mesh instance data (storage buffer) ─────────────────────

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,    // 64 bytes
  normalMatrix:   mat4x4<f32>,    // 64 bytes  (inverse-transpose of model for normals)
  diffuseColor:   vec4<f32>,      // 16 bytes  (r,g,b,a)
  specularColor:  vec4<f32>,      // 16 bytes  (r,g,b, shininess in .a)
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  // flags: bit0 = hasTexture, bit1 = hasNormalMap, bits2-4 = renderStyle (material-3d.ts encodeMaterialFlags)
  textureIndex:   u32,            //  4 bytes  layer index into diffuse texture_2d_array
  normalMapIndex: u32,            //  4 bytes  layer index into normal map texture_2d_array
  roughness:      f32,            //  4 bytes  PBR roughness (0 = mirror, 1 = rough)
  metalness:      f32,            //  4 bytes  PBR metalness (0 = dielectric, 1 = metal)
  patternColor:   vec4<f32>,      // 16 bytes  procedural pattern SECONDARY colour (primary = diffuseColor)
  patternParams:  vec4<f32>,      // 16 bytes  freq, angle, scale, spacing
  uvTransform:    vec4<f32>,      // 16 bytes  diffuse/normal sample UV = uv * .xy + .zw (tiling + offset); default (1,1,0,0)
                                  //  total 240 bytes
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

// ── Scene-wide uniforms ─────────────────────────────────────────

struct SceneUniforms {
  viewProjection: mat4x4<f32>,    // 64 bytes  (floats  0-15)
  cameraPosition: vec4<f32>,      // 16 bytes  (floats 16-19, .xyz = position)
  ambientColor: vec4<f32>,        // 16 bytes  (floats 20-23, .rgb = color, .a = intensity)
  lightDirection: vec4<f32>,      // 16 bytes  (floats 24-27, .xyz = dir, .w = intensity)
  lightColor: vec4<f32>,          // 16 bytes  (floats 28-31, .rgb = color)
  ps1Config: vec4<f32>,           // 16 bytes  (floats 32-35, .x=jitter .y=snapGrid .z=affine .w=colorDepth)
  resolution:       vec4<f32>,    // 16 bytes  (floats 36-39, .xy = render target pixels)
  lightSpaceMatrix: mat4x4<f32>,  // 64 bytes  (floats 40-55)
  shadowParams:     vec4<f32>,    // 16 bytes  (floats 56-59)
  fogColor:         vec4<f32>,    // 16 bytes  (floats 60-63, .rgb = fog color)
  fogParams:        vec4<f32>,    // 16 bytes  (floats 64-67, .x=near .y=far .z=density .w=mode)
  ps1Config2:       vec4<f32>,    // 16 bytes  (floats 68-71, .x=ditherStrength .y=uvQuantizeSteps .z=time .w=glass)
  lightCounts:      vec4<f32>,    // 16 bytes  (floats 72-75, .x = point-light count,
                                  //            .y = WIND direction (radians, xz) .z = wind strength .w = wind speed)
  pointLights:      array<vec4<f32>, 32>,   // 16 lights x 2 vec4s: (pos.xyz, radius) + (color.rgb, intensity)
  skinRampParams:   vec4<f32>,              // skin toon-ramp: .x=bands .y=softness .z=shadowFloor .w=tint rgb packed 8:8:8
  styleParams:      vec4<f32>,              // render-style knobs: .x = Sketch paper amount (0 colour .. 1 paper)
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// ── Vertex I/O ──────────────────────────────────────────────────

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,  // .xyz = tangent dir, .w = handedness
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:     vec4<f32>,  // Gouraud-lit color (used when no normal map)
  @location(1) uv:        vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:      vec3<f32>,  // for per-pixel lighting
  @location(4) worldNormal:   vec3<f32>,  // TBN: N
  @location(5) worldTangent:  vec3<f32>,  // TBN: T
  @location(6) worldBitangent:vec3<f32>,  // TBN: B
  // Same UV but interpolated WITHOUT perspective correction (PS1 affine warp).
  // The fragment blends this with the perspective uv by affineStrength.
  @location(7) @interpolate(linear) uvAffine: vec2<f32>,
  // Normalized LOCAL height (localY / windHeight, 0..1) — the foliage base-AO / ground-blend ramp (bit 20).
  // Same denominator as the wind grading, so the two agree. Meaningless (and unread) off foliage materials.
  @location(8) foliageY: f32,
};

// ── Helpers ─────────────────────────────────────────────────────

fn snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  let screenX = pos.x / w;
  let screenY = pos.y / w;
  let grid = gridSize;
  snapped.x = round(screenX * grid) / grid * w;
  snapped.y = round(screenY * grid) / grid * w;
  return snapped;
}

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let levels = depth;
  return floor(c * levels + 0.5) / levels;
}

// SKIN TOON-RAMP (bit 29). Band the (already soft-lit) NdotL + warm-tint the shadow. Returns .rgb = shadow-tint
// multiplier, .a = ramped NdotL; a no-op (white, unchanged) when the flag is off. MUST stay identical to the copy
// in skinning-shaders.ts (VS-only, so the branch is fine).
fn skinRamp(ndl: f32, flags: u32, p: vec4<f32>) -> vec4<f32> {
  if ((flags & 536870912u) == 0u) { return vec4<f32>(1.0, 1.0, 1.0, ndl); }
  let bands = max(p.x, 1.0);
  let soft  = max(p.y, 0.001);
  let stepped = floor(ndl * bands) / bands;
  let edge    = fract(ndl * bands);
  let s       = smoothstep(0.5 - soft, 0.5 + soft, edge);
  let v       = clamp(mix(stepped, stepped + 1.0 / bands, s), 0.0, 1.0);
  let ramped  = p.z + (1.0 - p.z) * v;
  let tr = floor(p.w / 65536.0);
  let tg = floor((p.w - tr * 65536.0) / 256.0);
  let tb = p.w - tr * 65536.0 - tg * 256.0;
  let tint = mix(vec3<f32>(tr, tg, tb) / 255.0, vec3<f32>(1.0), ramped);
  return vec4<f32>(tint, ramped);
}

// ── Main vertex shader ──────────────────────────────────────────

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  // ── FOLIAGE WIND (windSway, bit 19) — height-graded sway in LOCAL space, BEFORE the model transform,
  //    so each instanced copy bends about its own base. Phase is hashed from the model matrix's world
  //    translation (per-instance, no extra data). See foliageWindOffset / foliage-quality.md S1.
  var localPos = in.position;
  let vFlags = inst.flags;
  if ((vFlags & 524288u) != 0u) {
    let originW = vec3<f32>(inst.modelMatrix[3].x, inst.modelMatrix[3].y, inst.modelMatrix[3].z);
    localPos = localPos + foliageWindOffset(in.position, originW,
      inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }

  let worldPos4   = inst.modelMatrix * vec4<f32>(localPos, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  // Clip-space position
  var clipPos = scene.viewProjection * worldPos4;

  // PS1 vertex jitter
  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // ── Gouraud lighting (always computed; used when hasNormalMap = 0) ──

  // CROWD PALETTE (flags2 bit 4, performance-plan P12): the per-vertex palette code tints diffuse + emissive.
  let crowdK = crowdTint(u32(inst.normalMatrix[3].x), in.uv, inst.patternColor.xyz);
  let vDiffuse = inst.diffuseColor.rgb * crowdK;
  var lit = vDiffuse * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  // SOFT LIGHTING (bit 28): wrap diffuse toward half-Lambert by scene.lightColor.w (no-op when the flag/strength is 0).
  let softS = select(0.0, scene.lightColor.w, (inst.flags & 268435456u) != 0u);
  let rawNdL = dot(worldNormal, L);
  let softNdL = mix(max(rawNdL, 0.0), rawNdL * 0.5 + 0.5, softS);
  // SKIN TOON-RAMP (bit 29): band the diffuse + warm the shadow (no-op when the flag is off). Applied AFTER soft.
  let ramp = skinRamp(softNdL, inst.flags, scene.skinRampParams);
  lit += vDiffuse * ramp.rgb * scene.lightColor.rgb * scene.lightDirection.w * ramp.a;
  // Orthographic view = PARALLEL rays: use the constant camera forward (not a finite eye) so specular/fresnel/rim
  // don't wander as the ortho view pans/zooms. cameraPosition.w = 1 in ortho; forward = the depth-increasing
  // direction = row 2 of viewProjection (V points surface -> eye, i.e. -forward). select(persp, ortho, isOrtho).
  let V = select(normalize(scene.cameraPosition.xyz - worldPos4.xyz), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissive * crowdK;
  let colorDepth = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (inst.flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  // ── TBN for normal mapping ──────────────────────────────────
  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  // Gram-Schmidt re-orthogonalize
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos       = clipPos;
  out.color         = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv            = in.uv;
  out.uvAffine      = in.uv;   // perspective-free copy for PS1 affine warp
  out.instanceIdx   = idx;
  out.worldPos      = worldPos4.xyz;
  out.worldNormal   = worldNormal;
  out.worldTangent  = T;
  out.worldBitangent = B;
  out.foliageY      = clamp(in.position.y / max(inst.patternParams.x, 1e-3), 0.0, 1.0);
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  FRAGMENT SHADER — textured (with optional normal map + render styles)
// ═══════════════════════════════════════════════════════════════════

const MESH3D_FS_TEXTURED_TEMPLATE = /* wgsl */ `

${STYLE_WGSL_FUNCTIONS}
${PBR_IBL_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,  // .x=ditherStrength .y=uvQuantizeSteps
  lightCounts:      vec4<f32>,  // .x = point-light count
  pointLights:      array<vec4<f32>, 32>,
  skinRampParams:   vec4<f32>,  // (declared so styleParams lands at its buffer offset, floats 208-211)
  styleParams:      vec4<f32>,  // .x = Sketch paper amount, .y = toon shadow tint (rgb8), .z = toon saturation
  toonParams:       vec4<f32>,  // toon shadows: .x bands .y softness .z shadow value
  rimParams:        vec4<f32>,  // rim light: .x strength (0 = original rim) .y width .z hardness .w colour (rgb8)
  heightFog:        vec4<f32>,  // height fog (city-quality P9): .x density (0 = off) .y base height .z falloff per unit .w distance reach
  cascadeMatrices:  array<mat4x4<f32>, 2>,  // persona-polish A2: the near shadow cascades (nearest first)
  cascadeParams:    vec4<f32>,  // .x cascade count (0 = off) .y cascade map size .z blend band (fraction of the box)
  cascadeBias:      vec4<f32>,  // .x / .y depth bias of cascade 0 / 1
  aerialParams:     vec4<f32>,  // persona-polish A5 aerial haze: .x strength (0 = off) .y 1/reach .z contrast share .w tint share
  fogEye:           vec4<f32>,  // fog-horizon: .xyz the point fog is measured from (perspective = cameraPosition) .w fade band width
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// SSAO ambient-occlusion buffer (docs/specs/ssao.md). Screen-space, sampled at this pixel and multiplied into the
// AMBIENT term ONLY (direct sun is already shadow-mapped). 1×1 white is bound when SSAO is off → exact no-op.
@group(0) @binding(3) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(4) var ssaoSampler: sampler;

// (bindings 5/6 sceneColorTexture/sceneColorSampler — for GLASS REFRACTION + SSR — are declared in PBR_IBL_WGSL above)

@group(1) @binding(0) var diffuseTexture:   texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler:   sampler;
@group(1) @binding(2) var normalMapTexture: texture_2d_array<f32>;
@group(1) @binding(3) var normalMapSampler: sampler;
// GARP dedicated pool atlas (docs/specs/city-props-garp.md). A GARP_TEX-flagged mesh reads its skin here at
// the SAME per-instance textureIndex, instead of the diffuse atlas. Sampled unconditionally + select()ed below
// so textureSample stays in uniform control flow (a per-instance branch condition would fail WGSL uniformity).
@group(1) @binding(4) var garpTexture: texture_2d_array<f32>;

//__SHADOW_BINDINGS__
${FOG_FADE_WGSL}
${CROWD_PALETTE_WGSL}

const bayer4 = array<f32, 16>(
   0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
   3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0,
);

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

fn quantizeColorDithered(c: vec3<f32>, depth: f32, fragPos: vec4<f32>) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let px = vec2<u32>(fragPos.xy) % 4u;
  let threshold = bayer4[px.y * 4u + px.x] * scene.ps1Config2.x;
  return floor(c * depth + threshold) / depth;
}

@fragment
fn fs_main(
  @builtin(position)              fragPos:      vec4<f32>,
  @builtin(front_facing)          frontFacing:  bool,
  @location(0)                    gouraudColor: vec4<f32>,
  @location(1)                    uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx:  u32,
  @location(3)                    worldPos:     vec3<f32>,
  @location(4)                    worldNormal:  vec3<f32>,
  @location(5)                    worldTangent: vec3<f32>,
  @location(6)                    worldBitangent: vec3<f32>,
  @location(7) @interpolate(linear) uvAffine:   vec2<f32>,
  @location(8)                    foliageY:     f32,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = inst.flags;
  let hasTexture   = (flags & 1u) != 0u;
  let hasNormalMap = (flags & 2u) != 0u;
  let renderStyle  = (flags >> 2u) & 7u;
  let alphaCutout  = (flags & 32u) != 0u;
  let hairSheen    = (flags & 64u) != 0u;
  let rimEnabled   = (flags & 128u) != 0u;
  let toonOn       = (flags & 1073741824u) != 0u;   // bit 30 — toon shadows (Cel styles)
  let skinToonOn   = (flags & 536870912u) != 0u;    // bit 29 — skin ramp → per-pixel in Cel styles
  let patMode      = (flags >> 9u) & 7u;
  let texOverBase  = (flags & 32768u) != 0u;
  let garpTex      = (flags & 16777216u) != 0u;   // bit 24: sample the dedicated GARP pool atlas, not diffuse
  // FOG HORIZON fast path (fog-horizon.ts; scene.toonParams.w bit 0, set only with Hard edge on and a linear fog, so
  // aerial haze and height fog are off): a pixel at or past the fog edge ends exactly as the fog colour, so it skips
  // the window interiors (pattern block) and returns right after the texture samples and the alpha cutout, before
  // lighting, shadows, ground shading and IBL. Unlit UI cards (style 6) take no fog, so never this path.
  let fhFlags = u32(scene.toonParams.w);
  let fhNoFogM = fhNoFog(u32(inst.normalMatrix[3].x), fhFlags);   // Material3D.noFog (flags2 bits 2 / 3)
  let fhSkip = (fhFlags & 1u) != 0u && u32(scene.fogParams.w) == 1u && renderStyle != 6u && !fhNoFogM
    && length(scene.fogEye.xyz - worldPos) >= scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);

  // RENDER DEBUG (render-debug.ts; ibl.dbgShade, 0 = off: the normal path below runs unchanged). A uniform value, so
  // these early returns keep the control flow uniform for the samples and derivatives below.
  // Modes 4-6 localise the RENDER-1 rainbow (constant colour = mode 2 still shows it, magenta = mode 3 does not):
  // 4 = the flat instance index as a colour (red = past the end of u_instances), 5 = instance 0's colour (constant
  // index: is the storage read itself bad?), 6 = the vertex-stage colour (smooth varyings, no fragment-side read).
  // RENDER DEBUG safeLightingMath (ibl.dbgFlags value 4; rdSafeMath is declared with rdPow / rdNormalize in
  // STYLE_WGSL_FUNCTIONS). Read only through select(), so off keeps every result exactly as before.
  rdSafeMath = (u32(ibl.dbgFlags) & 4u) != 0u;
  if (ibl.dbgShade > 1.5) {
    let dbgM = u32(ibl.dbgShade + 0.5);
    if (dbgM == 3u) { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }
    if (dbgM == 4u) {
      // Branch-free on the (varying) index so the samples / derivatives below stay in uniform control flow.
      let dbgH = (instanceIdx + 1u) * 2654435761u;
      let dbgC = vec3<f32>(f32((dbgH >> 8u) & 255u), f32((dbgH >> 16u) & 255u), f32((dbgH >> 24u) & 255u)) / 255.0;
      return vec4<f32>(select(dbgC, vec3<f32>(1.0, 0.0, 0.0), instanceIdx >= arrayLength(&u_instances)), 1.0);
    }
    if (dbgM == 5u) { return vec4<f32>(u_instances[0].diffuseColor.rgb, 1.0); }
    if (dbgM == 6u) { return vec4<f32>(gouraudColor.rgb, 1.0); }
    // 10 = the instance's material flag bits as a colour: GREEN = rim (bit 7) on a dark-blue base. A plain cube is all
    // dark blue; green only at some pixels = a per-pixel flags read going wrong.
    if (dbgM == 10u) {
      return vec4<f32>(0.0, select(0.0, 1.0, (inst.flags & 128u) != 0u), 0.3, 1.0);
    }
    // 7 / 8 = solid grey / white (does the rainbow depend on the colour value?); 9 = the raw interpolated world normal
    // (one flat colour per cube face when healthy; through dbgFinal, so with dbgNanCheck on a NaN normal is green).
    if (dbgM == 7u) { return vec4<f32>(0.5, 0.5, 0.5, 1.0); }
    if (dbgM == 8u) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
    if (dbgM == 9u) { return dbgFinal(vec4<f32>(worldNormal * 0.5 + 0.5, 1.0), 0u); }
    return vec4<f32>(inst.diffuseColor.rgb, 1.0);
  }

  //__PATTERN_BLOCK__

  let L = normalize(-scene.lightDirection.xyz);
  // Orthographic view = PARALLEL rays: constant camera forward instead of a finite eye (see the worldPos4 site).
  let V = select(rdNormalize(scene.cameraPosition.xyz - worldPos), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);

  // PS1 affine texture mapping — blend perspective-correct uv toward the
  // non-perspective (linear) uvAffine by affineStrength, so textures warp on
  // angled/large polys the way PS1 hardware did.
  var sampUv = mix(uv, uvAffine, clamp(scene.ps1Config.z, 0.0, 1.0));
  // Texture tiling + offset: repeat/pan the sampled image (wrap sampler). Default (1,1,0,0) = no-op. Applies to
  // the diffuse/normal/GARP samples only (procedural pattern/ground use raw uv, unaffected).
  sampUv = sampUv * inst.uvTransform.xy + inst.uvTransform.zw;
  // UV quantization — snap UVs to a texel grid before sampling (PS1 texel crawl).
  let uvQSteps = scene.ps1Config2.y;
  if (uvQSteps > 0.5) {
    sampUv = floor(sampUv * uvQSteps) / uvQSteps;
  }

  // Sample textures unconditionally — textureSample requires uniform control flow.
  // GARP: also sample the pool atlas unconditionally, then select() by the per-instance flag (no branch around
  // the sample → uniformity holds). Non-GARP fragments pay one extra fetch into the 1×1/small GARP atlas
  // (cache-hot); it's discarded by the select. Reuses diffuseSampler (same filtering + format).
  // World-space TRIPLANAR (bit 27): sample the diffuse on the 3 axis-aligned world planes and blend by the
  // geometric normal, so texel density is constant however the mesh is scaled (no UV squash on a stretched cube).
  // uvTransform.x = tiles per world unit (frequency), .zw = world offset. Sampled UNCONDITIONALLY (WGSL uniformity)
  // then select()ed by the flag. v1: diffuse only — the GARP atlas + normal map keep UV sampling.
  let triplanar = (flags & 134217728u) != 0u;
  let tpFreq    = inst.uvTransform.x;
  let tpOff     = inst.uvTransform.zw;
  // RENDER DEBUG clampTexLayers (ibl.dbgFlags bit 0): clamp the layer indices to the bound arrays. Off, select() keeps
  // the instance values unchanged.
  let dbgClampL = (u32(ibl.dbgFlags) & 1u) != 0u;
  let texLayer  = select(i32(inst.textureIndex), min(i32(inst.textureIndex), i32(textureNumLayers(diffuseTexture)) - 1), dbgClampL);
  let garpLayer = select(i32(inst.textureIndex), min(i32(inst.textureIndex), i32(textureNumLayers(garpTexture)) - 1), dbgClampL);
  let nrmLayer  = select(i32(inst.normalMapIndex), min(i32(inst.normalMapIndex), i32(textureNumLayers(normalMapTexture)) - 1), dbgClampL);
  let tpDx = textureSample(diffuseTexture, diffuseSampler, worldPos.zy * tpFreq + tpOff, texLayer);
  let tpDy = textureSample(diffuseTexture, diffuseSampler, worldPos.xz * tpFreq + tpOff, texLayer);
  let tpDz = textureSample(diffuseTexture, diffuseSampler, worldPos.xy * tpFreq + tpOff, texLayer);
  var tpB  = abs(normalize(worldNormal));
  tpB = tpB / (tpB.x + tpB.y + tpB.z + 1e-5);
  let triDiff      = tpDx * tpB.x + tpDy * tpB.y + tpDz * tpB.z;
  let uvDiff       = textureSample(diffuseTexture,   diffuseSampler,   sampUv, texLayer);
  let diffSample   = select(uvDiff, triDiff, triplanar);
  let garpSample   = textureSample(garpTexture,      diffuseSampler,   sampUv, garpLayer);
  let texSample    = select(diffSample, garpSample, garpTex);
  let normalSample = textureSample(normalMapTexture, normalMapSampler, sampUv, nrmLayer);

  // Alpha-test cutout (alpha-card hair): drop transparent strand texels. Order-independent (no blending).
  // Samples above are unconditional → uniform; the discard after them is fine.
  if (alphaCutout && texSample.a < 0.5) { discard; }

  // FOG HORIZON FADE BAND (P2; scene flag bit 1, flags2 in normalMatrix column 3 .x): a fading family dissolves over
  // the band before the fog edge with a screen-door dither (here, after the samples, like every discard in this FS).
  if ((fhFlags & 2u) != 0u && fhFades(u32(inst.normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    if (!fhDitherKeep(fhCoverage(length(scene.fogEye.xyz - worldPos), fhEdge, scene.fogEye.w), fragPos.xy + fhTaaShift(scene.cascadeParams.w, (fhFlags & 4u) != 0u), (fhFlags & 4u) != 0u)) { discard; }
  }
  // HLOD CROSS-FADE (performance-plan P17; flags2 bit 5): a streamed HLOD tile dissolving in / out over its tier
  // swap; the coverage rides in normalMatrix column 3 .y (multiplied by 0 in every normal transform).
  if ((u32(inst.normalMatrix[3].x) & 32u) != 0u && !fhDitherKeep(inst.normalMatrix[3].y, fragPos.xy + fhTaaShift(scene.cascadeParams.w, false), false)) { discard; }

  // FOG HORIZON fast path (see fhSkip): after every implicit-derivative sample and the alpha cutout, so the cut-outs
  // keep their holes and nothing below runs in non-uniform control flow that needs derivatives. Same alpha, the same
  // alpha discard and the same PS1 quantization as the slow path's tail; the colour is the fog colour the slow path's
  // mix(colour, fog, 1.0) ends at.
  if (fhSkip) {
    var fhA = inst.diffuseColor.a;
    if (hasTexture && !texOverBase && renderStyle != 7u) { fhA = fhA * texSample.a; }
    if (fhA < 0.01) { discard; }
    var fhC = scene.fogColor.rgb;
    let fhCd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);
    if (fhCd > 0.0) {
      if (scene.ps1Config2.x > 0.0) { fhC = quantizeColorDithered(fhC, fhCd, fragPos); } else { fhC = quantizeColor(fhC, fhCd); }
    }
    return vec4<f32>(fhC, fhA);
  }

  // RENDER DEBUG unlit (ibl.dbgShade 1): base colour x texture, no lighting / shadows / IBL / fog.
  if (ibl.dbgShade > 0.5) {
    var dbgC = vec4<f32>(patBase, inst.diffuseColor.a);
    if (hasTexture) { dbgC = dbgC * texSample; }
    if (dbgC.a < 0.01) { discard; }
    return dbgC;
  }

  // Resolve surface normal
  var N = rdNormalize(worldNormal);
  if (hasNormalMap) {
    let mapN = normalSample.xyz * 2.0 - 1.0;
    N = rdNormalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
  }

  // PATTERN RELIEF + GRAIN (modes 1-6): a micro normal perturbation from the procedural mask gradient so seams
  // groove, tiles step, and WINDOW REVEALS catch raking light (openings read recessed, sills/frames bevel) instead
  // of flat paint, plus a subtle world-stable value grain on the tiled modes. Reuses the 3x patternMask samples.
  if (patMode >= 1u && patMode <= 6u) {
    var Tb = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tbl = length(Tb);
    let flat_ = tbl <= 1e-3;
    Tb = select(Tb / max(tbl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), flat_);
    let Bb = select(cross(N, Tb), vec3<f32>(0.0, 0.0, 1.0), flat_);
    // windows (mode 6): a SOFTER groove — interior mapping already conveys the depth; this just bevels the reveal.
    let reliefK = select(1.3, 0.85, patMode == 6u);
    N = normalize(N + (Tb * (patMask - patMaskR) + Bb * (patMask - patMaskU)) * reliefK);
    if (patMode <= 5u) {
      // (B4: the 260-per-uv grain cells go sub-pixel fast - winWL.w is the pixel footprint in THIS pattern's cells, so
      // w * 260 / freq = grain cells per pixel; fade it out past ~1 so roofs / trim stop shimmering at mid distance.)
      let grainK = 1.0 - smoothstep(0.6, 2.0, winWL.w * 260.0 / max(inst.patternParams.x, 0.001));
      patBase = patBase * (1.0 + grainK * 0.10 * (fract(sin(dot(floor(uv * 260.0), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5));
    }
  }
  if (patMode == 6u) {
    // FACADE ROUGHNESS: a gentle stucco-facet normal dither on the masonry between the windows (not the
    // glass) — walls catch the light unevenly instead of reading as flat paint. World-stable hash cells.
    var Tw2 = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let twl = length(Tw2);
    if (twl > 1e-3) {
      Tw2 = Tw2 / twl;
      let Bw2 = cross(N, Tw2);
      let gc = floor(uv * 140.0);
      let g1 = fract(sin(dot(gc, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
      let g2 = fract(sin(dot(gc, vec2<f32>(39.3468, 11.135))) * 24634.6345) - 0.5;
      // (B4: the 7 mm facets are sub-pixel past a few metres, where they only sparkle - faded by the cell footprint.)
      N = normalize(N + (Tw2 * g1 + Bw2 * g2) * 0.16 * (1.0 - winWL.x) * (1.0 - smoothstep(0.0015, 0.005, winWL.w)));
      // STRUCTURED MASONRY RELIEF: brick courses / concrete panel seams GROOVE so the wall reads as 3-D material,
      // not painted brick. Sampled at a fine FIXED eps (brick-scale; no fwidth → uniform-safe) — the window-cell
      // relief eps above is far too coarse to resolve courses. On the masonry only (1 - winWL.x = not the glass).
      let mEps = 0.014 / max(inst.patternParams.x, 0.001);
      // CENTERED difference (both sides of uv). A forward difference (uv+eps only) biases the relief HALF A STEP in
      // the +eps direction — up the wall for the y term — so the grooves read as sitting ABOVE the painted mortar
      // (user spotted this). Centering removes the bias so the relief lands ON the courses. 2x magnitude → half k.
      let mhL = wallMasonryH(uv - vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhR = wallMasonryH(uv + vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhD = wallMasonryH(uv - vec2<f32>(0.0, mEps), inst.patternParams);
      let mhU = wallMasonryH(uv + vec2<f32>(0.0, mEps), inst.patternParams);
      // (B4: joint relief fades once a joint is sub-pixel - past that it only aliases into a moire grid.)
      N = normalize(N + (Tw2 * (mhL - mhR) + Bw2 * (mhD - mhU)) * (0.42 * (1.0 - winWL.x) * (1.0 - smoothstep(0.01, 0.04, winWL.w))));
    }
  }

  // BOARD GRAIN (boardShade, bit 16 — packaging paperboard): a faint two-scale paper-fiber value
  // grain on the BASE colour, applied BEFORE the texOverBase artwork composite so painted strokes
  // stay clean on top (the grain is the board, not the ink). Instance slots are repurposed here
  // (packaging panels never use patterns): patternColor = (rimU, rimV, rimStrength, grainAmp),
  // patternParams = this panel's UV rect in the dieline texture.
  let boardShade = (flags & 65536u) != 0u;
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
  }

  // DECAL-OVER-BASE (texOverBase, bit 15): composite the diffuse texture OVER the base albedo by its
  // alpha BEFORE lighting — albedo = mix(base, tex.rgb, tex.a) — so a transparent texel shows the base
  // material and painted strokes are lit like paint ON the surface (the packaging dieline-over-kraft
  // blend). The post-lighting multiply below is skipped for this mode, and texture alpha never thins
  // the surface (an empty transparent layer renders the plain base material, not black).
  if (hasTexture && texOverBase) {
    patBase = mix(patBase, texSample.rgb, texSample.a);
  }

  // BOARD EDGE RIM (same bit 16): darken toward the panel's UV-rect borders so panels read as THICK
  // board, not paper. Applied AFTER the artwork composite (a real board edge shades the ink too).
  // Edge distance is normalized per axis by patternColor.rg = rim width in dieline-UV units (~1.6 mm).
  if (boardShade) {
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }

  // PROCEDURAL GROUND (groundShade, bit 18): a standalone surface (ashlar/radialMedallion/borderStrip/grass).
  // Exclusive with pattern/board/texOverBase (a mesh is a ground tile OR a panel). Slots repurposed:
  // patternColor = (seamR, seamG, seamB, groutWidthUv) — seam = grout (tilers) OR dirt tint (grass);
  // patternParams = (p0, p1, jitter, groundMode) — p0/p1 = tileW/H · ring/wedge · stoneLen/rowW.
  let groundShade = (flags & 262144u) != 0u;
  if (groundShade) {
    let gSeam = inst.patternColor.rgb;
    let gGroutW = inst.patternColor.a;
    let gP0 = inst.patternParams.x;
    let gP1 = inst.patternParams.y;
    let gJit = inst.patternParams.z;
    // groundMode packs METRES PER WORLD UNIT: mode + 100 * round(scale * 10). 0 = a standalone mesh
    // authored 1 unit = 1 m whose uv is a 0..1 region. Non-zero = part of a scaled WORLD (the city is a
    // diorama at 1 unit = 15 m), which means two things at once:
    //   · gr_uvMetres yields world UNITS per uv, so the metric coordinate must be multiplied by the scale
    //     or every tile size and noise frequency is off by exactly that factor;
    //   · the uv is a world parameterisation (city ground = worldXZ * 0.5, so neighbouring road/pavement
    //     meshes tile continuously), so the P2 masks need a world-scaled coordinate and must drop the
    //     edge/corner term — gr_edgeMask would otherwise saturate to 1 across the whole city.
    // See Material3D.groundWorldScale.
    let gScale10 = floor(inst.patternParams.w / 100.0);
    let gMode = inst.patternParams.w - gScale10 * 100.0;
    let gIsWorld = gScale10 > 0.0;
    let gUnitM = select(1.0, gScale10 * 0.1, gIsWorld);   // metres per world unit
    let gMaskC = select(uv, uv * 0.02, gIsWorld);         // world mode: ~1 mask cycle per 45 m
    let gEdgeAmt = select(1.0, 0.0, gIsWorld);            // a continuous ground has no region border
    // ★ The per-mesh scale computed on the CPU (renderer _writeGroundUvScale; uvTransform.z = the marker) replaces
    //   the per-pixel derivative estimate, whose f32 rounding noise speckled + shimmered the grout (2026-09-29).
    //   Untextured ground only (nothing else reads its uvTransform); anything else keeps the estimate.
    let gUvMw = select(gUvM, inst.uvTransform.xy, inst.uvTransform.z < -12000.0);
    let gUvMs = gUvMw * gUnitM;                           // METRES per uv unit (uvM alone is world units)
    // P2 WEATHERING — specularColor repurposed: .r = profile (0-4), .gba = wear center uv + radius.
    let gPc = vec2<f32>(inst.specularColor.g, inst.specularColor.b);
    let gPr = inst.specularColor.a;
    let g0 = groundSurface(uv, gUvMs, gMaskC, gMode, inst.diffuseColor.rgb, gSeam, gGroutW, gP0, gP1, gJit, gPc, gPr);
    let gW = groundWeather(g0, gMaskC, gEdgeAmt, inst.specularColor.r, gPc, gPr);
    // PBR DEEPENING (shared path): micro-AO darkens crevices/grout for depth, and grooves read a touch
    // rougher (they catch dirt). gW.grout ≈ 0 on the ORGANIC surfaces (grass/dirt/asphalt) so those are
    // untouched; the tiled/relief surfaces gain contact shadow. Complements the macro SSAO pass (this is
    // per-fragment MATERIAL occlusion from the pattern, not geometry).
    patBase = gW.rgb * (1.0 - gW.grout * 0.22);
    roughOverride = clamp(gW.rough + gW.grout * 0.12, 0.04, 1.0);
    // WET SHEEN (visual-polish #5): a material roughness under 0.3 (only the city's wet-sheen look sets one on its
    // rain-slick roads; ground materials default to 0.5) glosses the procedural surface down to it, with ~4 m
    // PUDDLES near mirror-smooth and the asphalt a little darker, so SSR + lamp light streak. Others keep their own.
    if (inst.roughness < 0.3) {
      let wetK = clamp((0.3 - inst.roughness) / 0.26, 0.0, 1.0);
      let pud = smoothstep(0.52, 0.72, pg_vnoise(worldPos.xz * gUnitM * 0.25));
      roughOverride = min(roughOverride, mix(max(inst.roughness, 0.04) * 1.5, 0.04, pud) + gW.grout * 0.12);
      patBase = patBase * (1.0 - 0.18 * wetK);
    }
    // HEIGHT -> NORMAL relief. ★ The epsilon must resolve the GROUT GROOVE, not the tile. It used to be a
    // fraction of the tile size (0.15 * 0.6 m = 9 cm, against a 1.5 cm seam), and the difference was
    // ONE-SIDED — so the shading responded both where this fragment sat in the groove AND where the
    // fragment 9 cm away did, drawing a SECOND ghost seam a fixed distance from every real one. That is
    // the "duplicate grout line", and it showed on all three tilers (including borderStrip, which has no
    // running bond) precisely because it comes from the relief, not from the tiling.
    // Now: CENTRAL differences at ~one grout width. Symmetric (no shift) and landing on the actual groove,
    // so the seam still reads recessed and bevelled — just once.
    let gP = uv * gUvMs;
    let gE = max(gGroutW * 0.9, 0.002);
    // P8 GROUND RELIEF LOD (scene.cascadeBias.w = Renderer3D.groundReliefLod; off by default): the relief normal comes
    // from heights a grout width apart, so once a pixel spans many grout widths it is per-pixel noise. It fades out
    // between a 4 and an 8 cm pixel footprint, and the four height samples are skipped where it is gone.
    let gFootM = max(gUvFw.x * gUvMs.x, gUvFw.y * gUvMs.y);
    let gReliefK = select(1.0, 1.0 - smoothstep(0.04, 0.08, gFootM), scene.cascadeBias.w > 0.5);
    if (gReliefK > 0.0) {
      let hL = groundHeightM(gP - vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hR = groundHeightM(gP + vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hD = groundHeightM(gP - vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      let hU = groundHeightM(gP + vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      var Tg = cross(vec3<f32>(0.0, 1.0, 0.0), N);
      let tgl = length(Tg);
      let gflat = tgl <= 1e-3;
      Tg = select(Tg / max(tgl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), gflat);
      let Bg = select(cross(N, Tg), vec3<f32>(0.0, 0.0, 1.0), gflat);
      N = normalize(N + (Tg * (hL - hR) + Bg * (hD - hU)) * (0.45 * gReliefK));   // deepened relief (was 0.3 — stronger surface normal)
    }
  }

  // PAINTED METAL (metalShade, bit 23) — albedo + roughness; lighting does the rest.
  let metalShade = (flags & 8388608u) != 0u;
  if (metalShade) {
    let mS = metalSurface(worldPos, N, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w);
    patBase = mS.rgb;
    roughOverride = mS.rough;
  }

  // NEON / SCREEN (neonShade, bit 22) — emissive-only: it replaces the emissive term, not the albedo.
  let neonShade = (flags & 4194304u) != 0u;
  if (neonShade) {
    emissiveRGB = neonSign(uv, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                           inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                           inst.patternParams.w, scene.ps1Config2.z);
    patBase = inst.diffuseColor.rgb * 0.35;   // the unlit panel body behind the glow
  }

  // WATER (waterShade, bit 21). Exclusive with pattern/board/ground/foliage — a mesh is one of them.
  // Slots: patternColor = (deep.rgb, packed shallow), patternParams = (waveScale, waveSpeed, choppy, glitter).
  // The reflection tint is the scene FOG colour, so water tracks the sky through the day/night cycle.
  let waterShade = (flags & 2097152u) != 0u;
  var waterGlint = 0.0;
  if (waterShade) {
    let wS = waterSurface(worldPos, N, V, L, scene.fogColor.rgb,
                          inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w, scene.ps1Config2.z);
    patBase = wS.rgb;
    roughOverride = wS.rough;
    N = wS.N;
    waterGlint = wS.glint;
  }

  // FOLIAGE SHADE (foliageShade, bit 20 — foliage-quality S2): base AO + ground-colour bleed on the
  // ALBEDO (so they are lit, not pasted on), and the leaf TRANSMISSION which is added AFTER lighting so it
  // composes with the rim. Slots: patternColor = (translucency, groundBlend, baseAO, packedGroundTint),
  // patternParams = (windHeight, windStiffness, windAmount, packedTranslucencyColor).
  let foliageShade = (flags & 1048576u) != 0u;
  var fqTrans = vec3<f32>(0.0);
  if (foliageShade) {
    patBase = foliageBase(patBase, foliageY, inst.patternColor.b, inst.patternColor.g, fq_unpackRGB(inst.patternColor.a));
    fqTrans = foliageTransmission(N, L, V, fq_unpackRGB(inst.patternParams.w), inst.patternColor.r,
                                  scene.lightColor.rgb, scene.lightDirection.w);
  }

  var lit: vec3<f32>;
  // Procedural GROUND meshes (bit 18) repurpose specularColor for their weathering data (r = profile, g/b/a =
  // wear path), so it is NOT a colour: the default worn profile packs (1, 0, 0) and Cel / Cel-HD / toon lit the
  // whole ground with a RED highlight. Ground is matte dielectric here, so the stylised paths get no specular.
  let styleSpec = select(inst.specularColor, vec4<f32>(0.0, 0.0, 0.0, 1.0), groundShade);

  // Toon shadows (film-look-and-toon-shadows.md §B): a Cel / Cel-HD material with bit 30 (or the skin ramp, bit 29)
  // gets the banded COLOURED shadow. Skin uses the skin ramp's bands / softness / floor / tint; everything else the
  // scene toon look. Neither flag → the original cel paths below, unchanged.
  let toonSkin  = skinToonOn;
  let toonP     = select(scene.toonParams.xyz, scene.skinRampParams.xyz, toonSkin);
  let toonTint  = select(scene.styleParams.y, scene.skinRampParams.w, toonSkin);
  let toonSat   = select(scene.styleParams.z, 0.0, toonSkin);
  if ((renderStyle == 1u || renderStyle == 5u) && (toonOn || skinToonOn)) {
    lit = toon_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
      toonP, toonTint, toonSat, renderStyle == 5u,
    );
  } else if (renderStyle == 1u) {
    lit = cel_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 2u) {
    lit = sketch_lighting(
      patBase, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
      scene.styleParams.x,
    );
  } else if (renderStyle == 3u) {
    lit = ink_lighting(
      patBase, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 4u) {
    // ── Gouraud — per-vertex lighting (computed in VS), no per-pixel PBR ──
    lit = gouraudColor.rgb;
  } else if (renderStyle == 5u) {
    // ── Cel-HD — cel's flat stepped diffuse + a smooth glossy specular ──
    lit = cel_hd_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 6u) {
    // ── Unlit — output the albedo directly, UNAFFECTED by scene lighting (UI cards / labels / overlays) ──
    lit = patBase;
  } else if (renderStyle == 7u) {
    // ── CD / iridescent disc — Zucconi diffraction rainbow; label (patBase, if textured) on the FRONT face only.
    // Front = the +Z ring in the DISC'S OWN space: compare the fragment normal against the instance's LOCAL z
    // axis (normalMatrix column 2). The old worldNormal.z test broke as soon as the disc/kit was rotated — the
    // label leaked onto the back (or vanished) because "front" silently meant WORLD +Z, not the disc's front.
    let discAxis = vec3<f32>(inst.normalMatrix[2].x, inst.normalMatrix[2].y, inst.normalMatrix[2].z);
    // ROOT CAUSE of the label-on-both-sides bug (diagnosed via the red/blue gate tint): the gate below was
    // always correct, but this engine applies diffuse textures as a LATE whole-mesh multiply on finalColor -
    // which painted the label onto BOTH faces downstream of any decision made here. For the CD style the
    // label must instead enter through cd_lighting's FRONT-GATED composite (texSample, alpha-weighted over
    // the disc base), and the late multiply below EXCLUDES style 7.
    let cdLabel = select(patBase, mix(patBase, texSample.rgb, texSample.a), (flags & 1u) != 0u);
    lit = cd_lighting(N, L, V, uv, cdLabel, (flags & 1u) != 0u, dot(worldNormal, discAxis) > 0.0 && frontFacing);
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(roughOverride, 0.04);
    let metalness = inst.metalness;
    let albedo    = patBase;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = rdNormalize(L + V);
    let NdotL = rdDot01(N, L);
    let NdotV = rdDot01(N, V);
    let NdotH = rdDot01(N, H);
    let HdotV = rdDot01(H, V);

    let D  = D_GGX(NdotH, roughness);
    let G  = G_Smith(NdotV, NdotL, roughness);
    let F  = F_Schlick(HdotV, F0);
    let kD = (1.0 - F) * (1.0 - metalness);
    let specularBRDF = D * G * F / max(4.0 * NdotV * NdotL, 0.0001);
    let directLight  = (kD * albedo / PBR_PI + specularBRDF)
                     * scene.lightColor.rgb * scene.lightDirection.w * NdotL;

    let iblOn = ibl.iblEnabled > 0.5;
    let ambFlat = scene.ambientColor.rgb * scene.ambientColor.a;
    var ambient: vec3<f32>;
    if (iblOn) {
      ambient = evalSHIrradiance(N) * albedo * (1.0 - metalness) * ibl.iblIntensity;
    } else {
      ambient = ambFlat * albedo * (1.0 - metalness);
    }
    // Environment specular: metals reflect the surroundings (chrome/gold) instead of going black; this is the
    // per-material light response that makes a metal chain read as metal. It does a reflect() plus (with IBL on) a
    // 9-term SH eval — wasted ALU on matte dielectrics, whose Fresnel-weighted contribution is negligible. Gate on
    // metalness. envSpecular uses only textureSampleLevel (explicit LOD) / no fwidth, so this non-uniform branch is
    // uniformity-safe even with the prefiltered-cube + BRDF-LUT samples.
    // Enter env specular for METALS, or — when SSR is on — for smooth DIELECTRICS too: wet floors / polished stone /
    // still water reflect via Fresnel even at metalness 0 (F0=0.04, weighted weak head-on, strong at grazing by the
    // BRDF LUT). Matte-flagged meshes (bit 25) always skip.
    if ((metalness > 0.05 || (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) || (flags & 67108864u) != 0u) && (flags & 33554432u) == 0u) {
      ambient = ambient + envSpecular(N, V, F0, roughness, NdotV, iblOn, ibl.iblSpecularIntensity, ambFlat, L, scene.lightColor.rgb, scene.lightDirection.w, worldPos, scene.viewProjection, (flags & 67108864u) != 0u);
    }

    // colorDepth is applied to the FINAL color (after texture) below, not here.
    // SSAO: multiply AMBIENT only (not directLight — the sun is shadow-mapped). textureSampleLevel (explicit LOD)
    // is legal in non-uniform control flow. 1×1 white when SSAO off → ×1 no-op.
    let ssaoAO = textureSampleLevel(ssaoTexture, ssaoSampler, fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0)), 0.0).r;
    lit = directLight + ambient * ssaoAO + emissiveRGB;
  }

  // Anisotropic hair sheen (Kajiya-Kay): a highlight band ALONG the strands. The strand tangent is the mesh
  // tangent (= the hair generator's stored flow direction — meridian on the cap → the crown highlight ring,
  // spine along the tails; transformed by the skin so it tracks the posed head). Intensity = specularColor.rgb,
  // tightness = specularColor.a; only on the lit side.
  // HAIR HIGHLIGHT BAND (flags2 bit 7, Material3D.hairBand; Cel / Cel-HD only): the sheen becomes ONE crisp flat
  // band (the anime angel ring) instead of a soft gloss. Applied AFTER the texture multiply below (a lit cel hair is
  // already at 1.0 before it, so an added sheen clamps away), as a lift of the hair's own colour.
  var hairBandK = 0.0;
  let hairBandOn = hairSheen && (u32(inst.normalMatrix[3].x) & 128u) != 0u && (renderStyle == 1u || renderStyle == 5u);
  if (hairSheen) {
    let tl = length(worldTangent);
    let strandT = worldTangent / max(tl, 1e-4);
    let Hs   = rdNormalize(L + V);
    let tDotH = dot(strandT, Hs);
    let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
    let sheenAmt = pow(sinTH, max(1.0, inst.specularColor.a)) * max(dot(N, L), 0.0);
    if (hairBandOn) { hairBandK = smoothstep(0.55, 0.62, sheenAmt) * clamp(inst.specularColor.r * 2.0, 0.0, 1.0); }
    else { lit = lit + inst.specularColor.rgb * sheenAmt * scene.lightColor.rgb * scene.lightDirection.w; }
  }

  // Rim light (silhouette back-light glow) — render-style-independent modifier; Fresnel edge tinted by the
  // scene light, stronger where the key light doesn't hit (backlit). Layers on top of any style.
  if (rimEnabled) {
    if (scene.rimParams.x > 0.0) {
      // Parameterised rim (setRimLight3D): width / hardness / colour — a crisp toon edge light.
      lit = lit + rim_param(N, V, L, scene.rimParams);
    } else {
      let rimF = rdPow(1.0 - max(dot(N, V), 0.0), 3.0);
      let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
      lit = lit + rimF * backlit * 0.42 * scene.lightColor.rgb;
    }
  }

  // LEAF TRANSMISSION (bit 20) — added ON TOP of the lit result, right after the rim so the two COMPOSE
  // (rim = silhouette Fresnel, transmission = light through the blade). This is the backlit-grass glow.
  // ★ HEADROOM-GATED: a SHADOWED backlit leaf (lit low → headroom high) still glows, but a leaf that is
  // already brightly lit (headroom near 0) can't be pushed past white. Without this the sun-facing canopy
  // blew out to white — the transmission + rim were pure additive light with no ceiling.
  lit = lit + fqTrans * clamp(1.0 - max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
  // WATER glitter is added AFTER lighting: it is a specular scintillation off the ripple normal,
  // not an albedo term, so it must not be multiplied by the diffuse response.
  lit = lit + scene.lightColor.rgb * waterGlint;

  // POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff -- moving cars,
  // walkers and walls entering a lamp's radius pick up its warm pool. PBR / cel / cel-HD paths only.
  // (2026-09-29, city-quality L2/L9/L10) Collected into plPost and added AFTER the sun shadow (just below the
  // SHADOW_APPLY marker) - moon/sun shadows used to multiply lamp pools down to the shadow floor. Ink (3) now gets
  // lamps too. A small highlight weighted by (1 - roughness) squared makes wet (low-roughness) roads streak;
  // dry roads (roughness 1) are unchanged.
  var plPost = vec3<f32>(0.0);
  if (renderStyle == 0u || renderStyle == 1u || renderStyle == 3u || renderStyle == 5u) {
    var plAdd = vec3<f32>(0.0);
    var plSpec = vec3<f32>(0.0);
    let plGloss = (1.0 - clamp(inst.roughness, 0.0, 1.0)) * (1.0 - clamp(inst.roughness, 0.0, 1.0));
    let plN = min(i32(scene.lightCounts.x), 16);
    for (var pi = 0; pi < plN; pi++) {
      let lp = scene.pointLights[pi * 2];
      let lc = scene.pointLights[pi * 2 + 1];
      let dv = lp.xyz - worldPos;
      let d = length(dv);
      let att = clamp(1.0 - d / max(lp.w, 1e-3), 0.0, 1.0);
      let ndl = max(dot(N, dv / max(d, 1e-4)), 0.0);
      plAdd = plAdd + lc.rgb * (lc.a * att * att * (0.3 + 0.7 * ndl));
      let plH = rdNormalize(dv / max(d, 1e-4) + V);
      plSpec = plSpec + lc.rgb * (lc.a * att * pow(max(dot(N, plH), 0.0), 48.0) * plGloss * 1.6);
    }
    plPost = patBase * plAdd + plSpec;
  }
  //__SHADOW_APPLY__
  lit = lit + plPost;   // lamp light is never sun/moon-shadowed (see the point-light block)

  // RENDER DEBUG dbgNanCheck (ibl.dbgFlags value 2): also test the UNCLAMPED lit colour - clamp() of a NaN is
  // indeterminate (0, 1 or NaN depending on the GPU), so the final colour alone can hide it. Uniform branch.
  var rdPre = 0u;
  if ((u32(ibl.dbgFlags) & 2u) != 0u) { rdPre = rdState(vec4<f32>(lit, 1.0)); }
  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);

  if (hasTexture && !texOverBase && renderStyle != 7u) {   // texOverBase already composited pre-lighting; cd (7)
    // composites its label INSIDE cd_lighting behind the front gate - the whole-mesh multiply here painted the
    // label on BOTH faces of the disc (the label-on-both-sides bug).
    if (renderStyle == 2u) {
      finalColor = vec4<f32>(mix(finalColor.rgb, finalColor.rgb * texSample.rgb, 0.5), finalColor.a * texSample.a);
    } else {
      finalColor = vec4<f32>(finalColor.rgb * texSample.rgb, finalColor.a * texSample.a);
    }
  }
  if (hairBandK > 0.0) { finalColor = vec4<f32>(mix(finalColor.rgb, min(finalColor.rgb * 1.55 + vec3<f32>(0.10), vec3<f32>(1.0)), hairBandK), finalColor.a); }
  // CLOTH LINING (flags2 bit 8, Material3D.clothLining): the inside of a garment (its back face) reads as the fabric in
  // shadow - capped at the albedo (no rim / specular white) and darkened - instead of the outer face's lighting.
  if ((u32(inst.normalMatrix[3].x) & 256u) != 0u && !frontFacing) {
    let lnAlb = inst.diffuseColor.rgb * select(vec3<f32>(1.0), texSample.rgb, hasTexture);
    finalColor = vec4<f32>(min(finalColor.rgb, lnAlb) * 0.32, finalColor.a);
  }

  if (finalColor.a < 0.01) { discard; }
  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u && renderStyle != 6u && !fhNoFogM) {   // unlit (UI cards) and no-fog meshes ignore atmospheric fog
    let fogDist = length(scene.fogEye.xyz - worldPos);   // fog-horizon: the fog eye (perspective = the camera, bit-identical)
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    // HEIGHT FOG (city-quality P9): a ground-hugging layer that thickens toward heightFog.y and with distance, so
    // street canyons and low ground haze while rooftops stay crisp. density 0 = off (the original fog).
    if (scene.heightFog.x > 0.0) {
      let hfH = exp(-max(worldPos.y - scene.heightFog.y, 0.0) * max(scene.heightFog.z, 1e-4));
      let hfD = 1.0 - exp(-fogDist * max(scene.heightFog.w, 1e-4));
      fogFactor = max(fogFactor, clamp(scene.heightFog.x * hfH * hfD, 0.0, 1.0));
    }
    // AERIAL PERSPECTIVE (persona-polish A5): from the first metres out, contrast fades toward the haze and the colour
    // leans to the horizon (fog) colour, so far facades sit back instead of being as punchy as near ones. It starts at
    // zero distance (unlike the linear fog, which only begins hundreds of metres out). strength 0 = off (original).
    if (scene.aerialParams.x > 0.0) {
      let ah = scene.aerialParams.x * (1.0 - exp(-fogDist * scene.aerialParams.y));
      let lw = vec3<f32>(0.2126, 0.7152, 0.0722);
      let midL = 0.5 * (dot(finalColor.rgb, lw) + dot(scene.fogColor.rgb, lw));
      let flatC = mix(finalColor.rgb, vec3<f32>(midL), ah * scene.aerialParams.z);
      finalColor = vec4<f32>(mix(flatC, scene.fogColor.rgb, ah * scene.aerialParams.w), finalColor.a);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }

  // PS1 color-depth quantization — applied to the FINAL color (after texture + fog)
  // so it bands the actual output, including textured and non-PBR surfaces (the
  // old version quantized only the PBR lighting pre-texture, so it was invisible
  // on textured meshes).
  let cd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (cd > 0.0 && renderStyle != 6u) {   // unlit (UI cards) keep crisp full-range colour
    if (scene.ps1Config2.x > 0.0) {
      finalColor = vec4<f32>(quantizeColorDithered(finalColor.rgb, cd, fragPos), finalColor.a);
    } else {
      finalColor = vec4<f32>(quantizeColor(finalColor.rgb, cd), finalColor.a);
    }
  }
  return dbgFinal(finalColor, rdPre);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER — vertex color (slot 1 float32x4 per-vertex color)
// ═══════════════════════════════════════════════════════════════════

/**
 * Vertex shader variant for EditMesh vertex-painted geometry.
 * Identical to MESH3D_VERTEX_SHADER except it reads a per-vertex RGBA color
 * from @location(4) (a second vertex buffer slot, stride 16) and uses it
 * in place of inst.diffuseColor.rgb for Gouraud lighting.
 * Fragment shader: reuse MESH3D_FRAGMENT_SHADER_UNTEXTURED unchanged.
 */
export const MESH3D_VERTEX_SHADER_VERTEX_COLOR = /* wgsl */ `
${FOLIAGE_WIND_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

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
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position:    vec3<f32>,
  @location(1) normal:      vec3<f32>,
  @location(2) uv:          vec2<f32>,
  @location(3) tangent:     vec4<f32>,
  @location(4) vertexColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:      vec4<f32>,
  @location(1) uv:         vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:       vec3<f32>,
  @location(4) worldNormal:    vec3<f32>,
  @location(5) worldTangent:   vec3<f32>,
  @location(6) worldBitangent: vec3<f32>,
  // location 7 is reserved (uvAffine in the main VS); 8 = the foliage local-height ramp, which the SHARED
  // untextured fragment shader reads — both vertex shaders that pair with it must output it at 8.
  @location(8) foliageY:       f32,
};

fn vc_snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  snapped.x = round(pos.x / w * gridSize) / gridSize * w;
  snapped.y = round(pos.y / w * gridSize) / gridSize * w;
  return snapped;
}

fn vc_quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  // FOLIAGE WIND (bit 19) — same local-space, height-graded displacement as the main VS.
  var localPos = in.position;
  let vFlags = inst.flags;
  if ((vFlags & 524288u) != 0u) {
    let originW = vec3<f32>(inst.modelMatrix[3].x, inst.modelMatrix[3].y, inst.modelMatrix[3].z);
    localPos = localPos + foliageWindOffset(in.position, originW,
      inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }

  let worldPos4   = inst.modelMatrix * vec4<f32>(localPos, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = vc_snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting — use per-vertex color instead of instance diffuse color
  let vcol = in.vertexColor;
  var lit = vcol.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += vcol.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  // Orthographic view = PARALLEL rays: use the constant camera forward (not a finite eye) so specular/fresnel/rim
  // don't wander as the ortho view pans/zooms. cameraPosition.w = 1 in ortho; forward = the depth-increasing
  // direction = row 2 of viewProjection (V points surface -> eye, i.e. -forward). select(persp, ortho, isOrtho).
  let V = select(normalize(scene.cameraPosition.xyz - worldPos4.xyz), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissive;
  let colorDepth = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (inst.flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (colorDepth > 0.0) { lit = vc_quantizeColor(lit, colorDepth); }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), vcol.a);
  out.uv             = in.uv;
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  out.foliageY       = clamp(in.position.y / max(inst.patternParams.x, 1e-3), 0.0, 1.0);
  return out;
}
`;

// == LEAF CARDS (leafCard, bit 13) =================================================================
// Shared by the untextured colour FS AND the shadow depth pass (so a card's shadow is its leaves, not a square).
// Two silhouettes over one flag: the card's UV RANGE picks which (every material flag bit is taken, and a leaf
// layer's instance slots all belong to wind + foliageShade):
//   u in [0, 1]  → leafCluster: a small SPRIG of ~5 leaves (branch.ts emitSprigCrown, ground-scatter cards),
//   u in [2, 3]  → leafClump:   a dense leaf-CLUSTER rosette (~15 leaves round a solid core) — branch.ts
//                  emitClumpCrown writes CLUMP_CARD_U0 = 2 (polish-round-3 T4).
/** Leaves of the CLUMP rosette: [azimuth deg, distance from the card centre, lobe scale] — outer ring then an
 *  inner ring offset between them. Tuned on a CPU mirror to ~50% card coverage with a leafy, notched edge. */
const CLUMP_LEAVES: [number, number, number][] = [
  [4, 0.26, 0.21], [41, 0.25, 0.2], [75, 0.27, 0.22], [111, 0.25, 0.19], [145, 0.26, 0.21],
  [183, 0.25, 0.2], [219, 0.27, 0.22], [254, 0.24, 0.19], [290, 0.26, 0.21], [326, 0.25, 0.2],
  [22, 0.2, 0.16], [95, 0.19, 0.15], [165, 0.2, 0.16], [237, 0.19, 0.15], [308, 0.2, 0.16],
];
const f4 = (v: number): string => v.toFixed(4);
const CLUMP_LOBES_WGSL = CLUMP_LEAVES.map(([deg, dist, sc]) => {
  const phi = deg * Math.PI / 180;
  // leafLobe's length axis points along (sin ang, cos ang) → ang = pi/2 - phi aims the leaf radially outward.
  return `  m = max(m, leafLobe(uv, vec2<f32>(${f4(0.5 + dist * Math.cos(phi))}, ${f4(0.5 + dist * Math.sin(phi))}), ${f4(Math.PI / 2 - phi)}, ${f4(sc)}));`;
}).join(String.fromCharCode(10));

export const LEAF_CARD_WGSL = /* wgsl */`
// One pointed-almond leaf at centre c, rotated ang, scaled sc, over the card UV. Coverage 0..1 (no fwidth → the
// discard it feeds is safe in non-uniform flow).
fn leafLobe(uv: vec2<f32>, c: vec2<f32>, ang: f32, sc: f32) -> f32 {
  let d = (uv - c) / sc;
  let ca = cos(ang); let sa = sin(ang);
  let q = vec2<f32>(d.x * ca - d.y * sa, d.x * sa + d.y * ca);      // leaf-local; q.y = length axis in [-1,1]
  let ly = clamp(q.y * 0.5 + 0.5, 0.0, 1.0);                        // 0 base .. 1 tip
  let hw = 0.5 * pow(sin(ly * 3.14159), 0.6);
  let body = smoothstep(-0.06, 0.06, hw - abs(q.x));
  let ends = step(-1.0, q.y) * step(q.y, 1.0);
  return body * ends;
}
// LEAF-CLUSTER silhouette: a small SPRIG of ~5 leaves over the 0..1 card UV — one card = a clump of leaves (the
// technique real foliage layers through a volume), not a single leaf. Returns coverage 0..1.
fn leafCluster(uv: vec2<f32>) -> f32 {
  var m = leafLobe(uv, vec2<f32>(0.50, 0.54), 0.00, 0.44);
  m = max(m, leafLobe(uv, vec2<f32>(0.33, 0.42), 0.85, 0.34));
  m = max(m, leafLobe(uv, vec2<f32>(0.67, 0.44), -0.85, 0.34));
  m = max(m, leafLobe(uv, vec2<f32>(0.42, 0.67), 0.55, 0.30));
  m = max(m, leafLobe(uv, vec2<f32>(0.60, 0.65), -0.55, 0.30));
  return m;
}
// LEAF-CLUMP silhouette: a dense ROSETTE — a solid core with ~15 leaves round it, so a clump of a dozen of these
// cards reads as one soft leafy mass. Early-outs keep the common (core / outside) pixels cheap.
fn leafClump(uv: vec2<f32>) -> f32 {
  let r = length(uv - vec2<f32>(0.5, 0.5));
  if (r > 0.48) { return 0.0; }
  if (r < 0.24) { return 1.0; }
  var m = 1.0 - smoothstep(0.25, 0.28, r);
${CLUMP_LOBES_WGSL}
  return m;
}
// Coverage for a leafCard: u >= 1.5 is a CLUMP card (u in [2, 3]), otherwise the sprig.
fn leafCardCoverage(uv: vec2<f32>) -> f32 {
  if (uv.x > 1.5) { return leafClump(vec2<f32>(uv.x - 2.0, uv.y)); }
  return leafCluster(uv);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  UNTEXTURED FRAGMENT SHADER — Gouraud/style, no texture group needed
// ═══════════════════════════════════════════════════════════════════

const MESH3D_FS_UNTEXTURED_TEMPLATE = /* wgsl */`

${STYLE_WGSL_FUNCTIONS}
${PBR_IBL_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,  // .x=ditherStrength .y=uvQuantizeSteps
  lightCounts:      vec4<f32>,  // .x = point-light count
  pointLights:      array<vec4<f32>, 32>,
  skinRampParams:   vec4<f32>,  // (declared so styleParams lands at its buffer offset, floats 208-211)
  styleParams:      vec4<f32>,  // .x = Sketch paper amount, .y = toon shadow tint (rgb8), .z = toon saturation
  toonParams:       vec4<f32>,  // toon shadows: .x bands .y softness .z shadow value
  rimParams:        vec4<f32>,  // rim light: .x strength (0 = original rim) .y width .z hardness .w colour (rgb8)
  heightFog:        vec4<f32>,  // height fog (city-quality P9): .x density (0 = off) .y base height .z falloff per unit .w distance reach
  cascadeMatrices:  array<mat4x4<f32>, 2>,  // persona-polish A2: the near shadow cascades (nearest first)
  cascadeParams:    vec4<f32>,  // .x cascade count (0 = off) .y cascade map size .z blend band (fraction of the box)
  cascadeBias:      vec4<f32>,  // .x / .y depth bias of cascade 0 / 1
  aerialParams:     vec4<f32>,  // persona-polish A5 aerial haze: .x strength (0 = off) .y 1/reach .z contrast share .w tint share
  fogEye:           vec4<f32>,  // fog-horizon: .xyz the point fog is measured from (perspective = cameraPosition) .w fade band width
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// SSAO ambient-occlusion buffer (docs/specs/ssao.md) — multiplied into the AMBIENT term only. 1×1 white when off.
@group(0) @binding(3) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(4) var ssaoSampler: sampler;

// (bindings 5/6 sceneColorTexture/sceneColorSampler — for GLASS REFRACTION + SSR — are declared in PBR_IBL_WGSL above)

//__SHADOW_BINDINGS__
${FOG_FADE_WGSL}
${CROWD_PALETTE_WGSL}

const bayer4Untex = array<f32, 16>(
   0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
   3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0,
);

fn quantizeColorUntex(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

fn quantizeColorUntexDithered(c: vec3<f32>, depth: f32, fragPos: vec4<f32>) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let px = vec2<u32>(fragPos.xy) % 4u;
  let threshold = bayer4Untex[px.y * 4u + px.x] * scene.ps1Config2.x;
  return floor(c * depth + threshold) / depth;
}

${LEAF_CARD_WGSL}

@fragment
fn fs_main(
  @builtin(position)              fragPos:      vec4<f32>,
  @builtin(front_facing)          frontFacing:  bool,
  @location(0)                    gouraudColor: vec4<f32>,
  @location(1)                    uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx:  u32,
  @location(3)                    worldPos:     vec3<f32>,
  @location(4)                    worldNormal:  vec3<f32>,
  @location(8)                    foliageY:     f32,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = inst.flags;
  let renderStyle = (flags >> 2u) & 7u;
  let rimEnabled  = (flags & 128u) != 0u;
  let toonOn      = (flags & 1073741824u) != 0u;   // bit 30 — toon shadows (Cel styles)
  let skinToonOn  = (flags & 536870912u) != 0u;    // bit 29 — skin ramp → per-pixel in Cel styles
  let leafCard    = (flags & 8192u) != 0u;
  let glassEnhance = (flags & 16384u) != 0u;
  let patMode     = (flags >> 9u) & 7u;
  let boardShade  = (flags & 65536u) != 0u;
  let radialFade  = (flags & 131072u) != 0u;
  // FOG HORIZON fast path (see the textured FS): this FS fogs every render style, so no style test here.
  let fhFlags = u32(scene.toonParams.w);
  let fhNoFogM = fhNoFog(u32(inst.normalMatrix[3].x), fhFlags);   // Material3D.noFog (flags2 bits 2 / 3)
  let fhSkip = (fhFlags & 1u) != 0u && u32(scene.fogParams.w) == 1u && !fhNoFogM
    && length(scene.fogEye.xyz - worldPos) >= scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);

  // RENDER DEBUG (render-debug.ts; ibl.dbgShade, 0 = off: the normal path below runs unchanged). A uniform value, so
  // these early returns keep the control flow uniform for the samples and derivatives below.
  // Modes 4-6 localise the RENDER-1 rainbow (constant colour = mode 2 still shows it, magenta = mode 3 does not):
  // 4 = the flat instance index as a colour (red = past the end of u_instances), 5 = instance 0's colour (constant
  // index: is the storage read itself bad?), 6 = the vertex-stage colour (smooth varyings, no fragment-side read).
  // RENDER DEBUG safeLightingMath (ibl.dbgFlags value 4; rdSafeMath is declared with rdPow / rdNormalize in
  // STYLE_WGSL_FUNCTIONS). Read only through select(), so off keeps every result exactly as before.
  rdSafeMath = (u32(ibl.dbgFlags) & 4u) != 0u;
  if (ibl.dbgShade > 1.5) {
    let dbgM = u32(ibl.dbgShade + 0.5);
    if (dbgM == 3u) { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }
    if (dbgM == 4u) {
      // Branch-free on the (varying) index so the samples / derivatives below stay in uniform control flow.
      let dbgH = (instanceIdx + 1u) * 2654435761u;
      let dbgC = vec3<f32>(f32((dbgH >> 8u) & 255u), f32((dbgH >> 16u) & 255u), f32((dbgH >> 24u) & 255u)) / 255.0;
      return vec4<f32>(select(dbgC, vec3<f32>(1.0, 0.0, 0.0), instanceIdx >= arrayLength(&u_instances)), 1.0);
    }
    if (dbgM == 5u) { return vec4<f32>(u_instances[0].diffuseColor.rgb, 1.0); }
    if (dbgM == 6u) { return vec4<f32>(gouraudColor.rgb, 1.0); }
    // 10 = the instance's material flag bits as a colour: GREEN = rim (bit 7) on a dark-blue base. A plain cube is all
    // dark blue; green only at some pixels = a per-pixel flags read going wrong.
    if (dbgM == 10u) {
      return vec4<f32>(0.0, select(0.0, 1.0, (inst.flags & 128u) != 0u), 0.3, 1.0);
    }
    // 7 / 8 = solid grey / white (does the rainbow depend on the colour value?); 9 = the raw interpolated world normal
    // (one flat colour per cube face when healthy; through dbgFinal, so with dbgNanCheck on a NaN normal is green).
    if (dbgM == 7u) { return vec4<f32>(0.5, 0.5, 0.5, 1.0); }
    if (dbgM == 8u) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
    if (dbgM == 9u) { return dbgFinal(vec4<f32>(worldNormal * 0.5 + 0.5, 1.0), 0u); }
    return vec4<f32>(inst.diffuseColor.rgb, 1.0);
  }

  //__PATTERN_BLOCK__

  // BOARD SHADING (bit 16, packaging paperboard — untextured panels, e.g. a box before its dieline
  // links): paper-fiber grain + panel-border rim darkening. Slots as in the textured FS:
  // patternColor = (rimU, rimV, rimStrength, grainAmp), patternParams = the panel's dieline-UV rect.
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }

  // LEAF CARD: cut the quad to a leaf silhouette (alpha-test, order-independent) + a midrib/edge shade. Placed AFTER
  // the fwidth pattern helpers above (they ran uniformly) so the discard doesn't make a later derivative non-uniform.
  if (leafCard) {
    let leaf = leafCardCoverage(uv);
    if (leaf < 0.5) { discard; }
    if (uv.x > 1.5) {
      // CLUMP card: the spherised normals carry the light/dark, so the per-card shade stays QUIET (a per-card
      // gradient here is exactly the noise the clump crown exists to remove) — just a hint of leaf edges.
      patBase = patBase * (0.93 + 0.07 * smoothstep(0.5, 0.95, leaf));
    } else {
      // SPRIG card: darker toward the base (uv.y low) + a touch darker at leaf edges → leafy depth (Ghibli-ish
      // when combined with the cel style + rim). Random card orientation makes the uv.y gradient read as variation.
      patBase = patBase * (0.72 + 0.4 * uv.y) * (0.86 + 0.14 * smoothstep(0.5, 0.95, leaf));
    }
  }
  // RADIAL FADE early out (visual-polish #5 perf): past the unit circle the fade below is exactly 0 and the tail
  // discards the fragment anyway, so skip the lighting for the corners of the spill / pool / blob quads.
  if (radialFade && length(uv - vec2<f32>(0.5, 0.5)) >= 0.5) { discard; }

  // FOG HORIZON FADE BAND (P2; see the textured FS).
  if ((fhFlags & 2u) != 0u && fhFades(u32(inst.normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    if (!fhDitherKeep(fhCoverage(length(scene.fogEye.xyz - worldPos), fhEdge, scene.fogEye.w), fragPos.xy + fhTaaShift(scene.cascadeParams.w, (fhFlags & 4u) != 0u), (fhFlags & 4u) != 0u)) { discard; }
  }
  // HLOD CROSS-FADE (performance-plan P17; flags2 bit 5): a streamed HLOD tile dissolving in / out over its tier
  // swap; the coverage rides in normalMatrix column 3 .y (multiplied by 0 in every normal transform).
  if ((u32(inst.normalMatrix[3].x) & 32u) != 0u && !fhDitherKeep(inst.normalMatrix[3].y, fragPos.xy + fhTaaShift(scene.cascadeParams.w, false), false)) { discard; }

  // FOG HORIZON fast path (see fhSkip): after the leaf-card cut so leaves keep their holes. Same alpha (radial fade),
  // the same alpha discard as the tail below; colour = the fog colour the tail's mix(colour, fog, 1.0) ends at.
  if (fhSkip) {
    var fhA = inst.diffuseColor.a;
    if (radialFade) {
      let fhRd = length(uv - vec2<f32>(0.5, 0.5)) * 2.0;
      let fhFade = 1.0 - smoothstep(0.2, 1.0, fhRd);
      fhA = fhA * fhFade * fhFade;
    }
    if (fhA < 0.01) { discard; }
    return vec4<f32>(scene.fogColor.rgb, fhA);
  }

  // RENDER DEBUG unlit (ibl.dbgShade 1): the base colour, no lighting / shadows / IBL / fog.
  if (ibl.dbgShade > 0.5) {
    if (inst.diffuseColor.a < 0.01) { discard; }
    return vec4<f32>(patBase, inst.diffuseColor.a);
  }

  let L = normalize(-scene.lightDirection.xyz);
  // Orthographic view = PARALLEL rays: constant camera forward instead of a finite eye (see the worldPos4 site).
  let V = select(rdNormalize(scene.cameraPosition.xyz - worldPos), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
  var N = rdNormalize(worldNormal);

  // PATTERN RELIEF + GRAIN (modes 1-6, incl. window-reveal groove) — see the main FS for the rationale.
  if (patMode >= 1u && patMode <= 6u) {
    var Tb = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tbl = length(Tb);
    let flat_ = tbl <= 1e-3;
    Tb = select(Tb / max(tbl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), flat_);
    let Bb = select(cross(N, Tb), vec3<f32>(0.0, 0.0, 1.0), flat_);
    let reliefK = select(1.3, 0.85, patMode == 6u);
    N = normalize(N + (Tb * (patMask - patMaskR) + Bb * (patMask - patMaskU)) * reliefK);
    if (patMode <= 5u) {
      // (B4: the 260-per-uv grain cells go sub-pixel fast - winWL.w is the pixel footprint in THIS pattern's cells, so
      // w * 260 / freq = grain cells per pixel; fade it out past ~1 so roofs / trim stop shimmering at mid distance.)
      let grainK = 1.0 - smoothstep(0.6, 2.0, winWL.w * 260.0 / max(inst.patternParams.x, 0.001));
      patBase = patBase * (1.0 + grainK * 0.10 * (fract(sin(dot(floor(uv * 260.0), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5));
    }
  }
  if (patMode == 6u) {
    // FACADE ROUGHNESS: a gentle stucco-facet normal dither on the masonry between the windows (not the
    // glass) — walls catch the light unevenly instead of reading as flat paint. World-stable hash cells.
    var Tw2 = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let twl = length(Tw2);
    if (twl > 1e-3) {
      Tw2 = Tw2 / twl;
      let Bw2 = cross(N, Tw2);
      let gc = floor(uv * 140.0);
      let g1 = fract(sin(dot(gc, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
      let g2 = fract(sin(dot(gc, vec2<f32>(39.3468, 11.135))) * 24634.6345) - 0.5;
      // (B4: the 7 mm facets are sub-pixel past a few metres, where they only sparkle - faded by the cell footprint.)
      N = normalize(N + (Tw2 * g1 + Bw2 * g2) * 0.16 * (1.0 - winWL.x) * (1.0 - smoothstep(0.0015, 0.005, winWL.w)));
      // STRUCTURED MASONRY RELIEF: brick courses / concrete panel seams GROOVE so the wall reads as 3-D material,
      // not painted brick. Sampled at a fine FIXED eps (brick-scale; no fwidth → uniform-safe) — the window-cell
      // relief eps above is far too coarse to resolve courses. On the masonry only (1 - winWL.x = not the glass).
      let mEps = 0.014 / max(inst.patternParams.x, 0.001);
      // CENTERED difference (both sides of uv). A forward difference (uv+eps only) biases the relief HALF A STEP in
      // the +eps direction — up the wall for the y term — so the grooves read as sitting ABOVE the painted mortar
      // (user spotted this). Centering removes the bias so the relief lands ON the courses. 2x magnitude → half k.
      let mhL = wallMasonryH(uv - vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhR = wallMasonryH(uv + vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhD = wallMasonryH(uv - vec2<f32>(0.0, mEps), inst.patternParams);
      let mhU = wallMasonryH(uv + vec2<f32>(0.0, mEps), inst.patternParams);
      // (B4: joint relief fades once a joint is sub-pixel - past that it only aliases into a moire grid.)
      N = normalize(N + (Tw2 * (mhL - mhR) + Bw2 * (mhD - mhU)) * (0.42 * (1.0 - winWL.x) * (1.0 - smoothstep(0.01, 0.04, winWL.w))));
    }
  }

  // PROCEDURAL GROUND (groundShade, bit 18 — ashlar/radial/border/grass) — see the textured FS for the rationale.
  // Slots: patternColor = (seamRGB, groutWidthUv), patternParams = (p0, p1, jitter, groundMode).
  let groundShade = (flags & 262144u) != 0u;
  if (groundShade) {
    let gSeam = inst.patternColor.rgb;
    let gGroutW = inst.patternColor.a;
    let gP0 = inst.patternParams.x;
    let gP1 = inst.patternParams.y;
    let gJit = inst.patternParams.z;
    // groundMode packs METRES PER WORLD UNIT: mode + 100 * round(scale * 10). 0 = a standalone mesh
    // authored 1 unit = 1 m whose uv is a 0..1 region. Non-zero = part of a scaled WORLD (the city is a
    // diorama at 1 unit = 15 m), which means two things at once:
    //   · gr_uvMetres yields world UNITS per uv, so the metric coordinate must be multiplied by the scale
    //     or every tile size and noise frequency is off by exactly that factor;
    //   · the uv is a world parameterisation (city ground = worldXZ * 0.5, so neighbouring road/pavement
    //     meshes tile continuously), so the P2 masks need a world-scaled coordinate and must drop the
    //     edge/corner term — gr_edgeMask would otherwise saturate to 1 across the whole city.
    // See Material3D.groundWorldScale.
    let gScale10 = floor(inst.patternParams.w / 100.0);
    let gMode = inst.patternParams.w - gScale10 * 100.0;
    let gIsWorld = gScale10 > 0.0;
    let gUnitM = select(1.0, gScale10 * 0.1, gIsWorld);   // metres per world unit
    let gMaskC = select(uv, uv * 0.02, gIsWorld);         // world mode: ~1 mask cycle per 45 m
    let gEdgeAmt = select(1.0, 0.0, gIsWorld);            // a continuous ground has no region border
    // ★ The per-mesh scale computed on the CPU (renderer _writeGroundUvScale; uvTransform.z = the marker) replaces
    //   the per-pixel derivative estimate, whose f32 rounding noise speckled + shimmered the grout (2026-09-29).
    //   Untextured ground only (nothing else reads its uvTransform); anything else keeps the estimate.
    let gUvMw = select(gUvM, inst.uvTransform.xy, inst.uvTransform.z < -12000.0);
    let gUvMs = gUvMw * gUnitM;                           // METRES per uv unit (uvM alone is world units)
    let gPc = vec2<f32>(inst.specularColor.g, inst.specularColor.b);
    let gPr = inst.specularColor.a;
    let g0 = groundSurface(uv, gUvMs, gMaskC, gMode, inst.diffuseColor.rgb, gSeam, gGroutW, gP0, gP1, gJit, gPc, gPr);
    // P2 WEATHERING — specularColor repurposed: .r = profile (0-4), .gba = wear center uv + radius.
    let gW = groundWeather(g0, gMaskC, gEdgeAmt, inst.specularColor.r, gPc, gPr);
    // PBR DEEPENING (shared path): micro-AO darkens crevices/grout for depth, and grooves read a touch
    // rougher (they catch dirt). gW.grout ≈ 0 on the ORGANIC surfaces (grass/dirt/asphalt) so those are
    // untouched; the tiled/relief surfaces gain contact shadow. Complements the macro SSAO pass (this is
    // per-fragment MATERIAL occlusion from the pattern, not geometry).
    patBase = gW.rgb * (1.0 - gW.grout * 0.22);
    roughOverride = clamp(gW.rough + gW.grout * 0.12, 0.04, 1.0);
    // WET SHEEN (visual-polish #5): a material roughness under 0.3 (only the city's wet-sheen look sets one on its
    // rain-slick roads; ground materials default to 0.5) glosses the procedural surface down to it, with ~4 m
    // PUDDLES near mirror-smooth and the asphalt a little darker, so SSR + lamp light streak. Others keep their own.
    if (inst.roughness < 0.3) {
      let wetK = clamp((0.3 - inst.roughness) / 0.26, 0.0, 1.0);
      let pud = smoothstep(0.52, 0.72, pg_vnoise(worldPos.xz * gUnitM * 0.25));
      roughOverride = min(roughOverride, mix(max(inst.roughness, 0.04) * 1.5, 0.04, pud) + gW.grout * 0.12);
      patBase = patBase * (1.0 - 0.18 * wetK);
    }
    // Relief: CENTRAL differences at ~one grout width — see the textured shader for why a tile-sized
    // one-sided epsilon drew a ghost seam beside every real one.
    let gP = uv * gUvMs;
    let gE = max(gGroutW * 0.9, 0.002);
    // P8 GROUND RELIEF LOD (scene.cascadeBias.w = Renderer3D.groundReliefLod; off by default): the relief normal comes
    // from heights a grout width apart, so once a pixel spans many grout widths it is per-pixel noise. It fades out
    // between a 4 and an 8 cm pixel footprint, and the four height samples are skipped where it is gone.
    let gFootM = max(gUvFw.x * gUvMs.x, gUvFw.y * gUvMs.y);
    let gReliefK = select(1.0, 1.0 - smoothstep(0.04, 0.08, gFootM), scene.cascadeBias.w > 0.5);
    if (gReliefK > 0.0) {
      let hL = groundHeightM(gP - vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hR = groundHeightM(gP + vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hD = groundHeightM(gP - vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      let hU = groundHeightM(gP + vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      var Tg = cross(vec3<f32>(0.0, 1.0, 0.0), N);
      let tgl = length(Tg);
      let gflat = tgl <= 1e-3;
      Tg = select(Tg / max(tgl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), gflat);
      let Bg = select(cross(N, Tg), vec3<f32>(0.0, 0.0, 1.0), gflat);
      N = normalize(N + (Tg * (hL - hR) + Bg * (hD - hU)) * (0.45 * gReliefK));   // deepened relief (was 0.3 — stronger surface normal)
    }
  }

  // PAINTED METAL (metalShade, bit 23) — albedo + roughness; lighting does the rest.
  let metalShade = (flags & 8388608u) != 0u;
  if (metalShade) {
    let mS = metalSurface(worldPos, N, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w);
    patBase = mS.rgb;
    roughOverride = mS.rough;
  }

  // NEON / SCREEN (neonShade, bit 22) — emissive-only: it replaces the emissive term, not the albedo.
  let neonShade = (flags & 4194304u) != 0u;
  if (neonShade) {
    emissiveRGB = neonSign(uv, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                           inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                           inst.patternParams.w, scene.ps1Config2.z);
    patBase = inst.diffuseColor.rgb * 0.35;   // the unlit panel body behind the glow
  }

  // WATER (waterShade, bit 21). Exclusive with pattern/board/ground/foliage — a mesh is one of them.
  // Slots: patternColor = (deep.rgb, packed shallow), patternParams = (waveScale, waveSpeed, choppy, glitter).
  // The reflection tint is the scene FOG colour, so water tracks the sky through the day/night cycle.
  let waterShade = (flags & 2097152u) != 0u;
  var waterGlint = 0.0;
  if (waterShade) {
    let wS = waterSurface(worldPos, N, V, L, scene.fogColor.rgb,
                          inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w, scene.ps1Config2.z);
    patBase = wS.rgb;
    roughOverride = wS.rough;
    N = wS.N;
    waterGlint = wS.glint;
  }

  // FOLIAGE SHADE (foliageShade, bit 20 — foliage-quality S2): base AO + ground-colour bleed on the albedo;
  // the leaf TRANSMISSION is added after lighting (below) so it composes with the rim. See the textured FS.
  let foliageShade = (flags & 1048576u) != 0u;
  var fqTrans = vec3<f32>(0.0);
  if (foliageShade) {
    patBase = foliageBase(patBase, foliageY, inst.patternColor.b, inst.patternColor.g, fq_unpackRGB(inst.patternColor.a));
    fqTrans = foliageTransmission(N, L, V, fq_unpackRGB(inst.patternParams.w), inst.patternColor.r,
                                  scene.lightColor.rgb, scene.lightDirection.w);
  }

  var lit: vec3<f32>;
  // Procedural GROUND meshes (bit 18) repurpose specularColor for their weathering data (r = profile, g/b/a =
  // wear path), so it is NOT a colour: the default worn profile packs (1, 0, 0) and Cel / Cel-HD / toon lit the
  // whole ground with a RED highlight. Ground is matte dielectric here, so the stylised paths get no specular.
  let styleSpec = select(inst.specularColor, vec4<f32>(0.0, 0.0, 0.0, 1.0), groundShade);
  // Toon shadows (film-look-and-toon-shadows.md §B): a Cel / Cel-HD material with bit 30 (or the skin ramp, bit 29)
  // gets the banded COLOURED shadow. Skin uses the skin ramp's bands / softness / floor / tint; everything else the
  // scene toon look. Neither flag → the original cel paths below, unchanged.
  let toonSkin  = skinToonOn;
  let toonP     = select(scene.toonParams.xyz, scene.skinRampParams.xyz, toonSkin);
  let toonTint  = select(scene.styleParams.y, scene.skinRampParams.w, toonSkin);
  let toonSat   = select(scene.styleParams.z, 0.0, toonSkin);
  if ((renderStyle == 1u || renderStyle == 5u) && (toonOn || skinToonOn)) {
    lit = toon_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
      toonP, toonTint, toonSat, renderStyle == 5u,
    );
  } else if (renderStyle == 1u) {
    lit = cel_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 2u) {
    lit = sketch_lighting(
      patBase, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
      scene.styleParams.x,
    );
  } else if (renderStyle == 3u) {
    lit = ink_lighting(
      patBase, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 4u) {
    // ── Gouraud — per-vertex lighting (computed in VS), no per-pixel PBR ──
    lit = gouraudColor.rgb;
  } else if (renderStyle == 5u) {
    // ── Cel-HD — cel's flat stepped diffuse + a smooth glossy specular ──
    lit = cel_hd_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 6u) {
    // ── Unlit — output the albedo directly, UNAFFECTED by scene lighting (UI cards / labels / overlays) ──
    lit = patBase;
  } else if (renderStyle == 7u) {
    // ── CD / iridescent disc — Zucconi diffraction rainbow; label (patBase, if textured) on the FRONT face only.
    // Front = the +Z ring in the DISC'S OWN space: compare the fragment normal against the instance's LOCAL z
    // axis (normalMatrix column 2). The old worldNormal.z test broke as soon as the disc/kit was rotated — the
    // label leaked onto the back (or vanished) because "front" silently meant WORLD +Z, not the disc's front.
    let discAxis = vec3<f32>(inst.normalMatrix[2].x, inst.normalMatrix[2].y, inst.normalMatrix[2].z);
    // Untextured template: no texSample here - the label flag (bit 0) is never set without a texture, so
    // patBase is the (label-less) input. The front gate matches the textured template.
    lit = cd_lighting(N, L, V, uv, patBase, (flags & 1u) != 0u, dot(worldNormal, discAxis) > 0.0 && frontFacing);
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(roughOverride, 0.04);
    let metalness = inst.metalness;
    let albedo    = patBase;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = rdNormalize(L + V);
    let NdotL = rdDot01(N, L);
    let NdotV = rdDot01(N, V);
    let NdotH = rdDot01(N, H);
    let HdotV = rdDot01(H, V);

    let D  = D_GGX(NdotH, roughness);
    let G  = G_Smith(NdotV, NdotL, roughness);
    let F  = F_Schlick(HdotV, F0);
    let kD = (1.0 - F) * (1.0 - metalness);
    let specularBRDF = D * G * F / max(4.0 * NdotV * NdotL, 0.0001);
    let directLight  = (kD * albedo / PBR_PI + specularBRDF)
                     * scene.lightColor.rgb * scene.lightDirection.w * NdotL;

    let iblOn = ibl.iblEnabled > 0.5;
    let ambFlat = scene.ambientColor.rgb * scene.ambientColor.a;
    var ambient: vec3<f32>;
    if (iblOn) {
      ambient = evalSHIrradiance(N) * albedo * (1.0 - metalness) * ibl.iblIntensity;
    } else {
      ambient = ambFlat * albedo * (1.0 - metalness);
    }
    // Environment specular: metals reflect the surroundings (chrome/gold) instead of going black; this is the
    // per-material light response that makes a metal chain read as metal. It does a reflect() plus (with IBL on) a
    // 9-term SH eval — wasted ALU on matte dielectrics, whose Fresnel-weighted contribution is negligible. Gate on
    // metalness. envSpecular uses only textureSampleLevel (explicit LOD) / no fwidth, so this non-uniform branch is
    // uniformity-safe even with the prefiltered-cube + BRDF-LUT samples.
    // Enter env specular for METALS, or — when SSR is on — for smooth DIELECTRICS too: wet floors / polished stone /
    // still water reflect via Fresnel even at metalness 0 (F0=0.04, weighted weak head-on, strong at grazing by the
    // BRDF LUT). Matte-flagged meshes (bit 25) always skip.
    if ((metalness > 0.05 || (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) || (flags & 67108864u) != 0u) && (flags & 33554432u) == 0u) {
      ambient = ambient + envSpecular(N, V, F0, roughness, NdotV, iblOn, ibl.iblSpecularIntensity, ambFlat, L, scene.lightColor.rgb, scene.lightDirection.w, worldPos, scene.viewProjection, (flags & 67108864u) != 0u);
    }

    // SSAO: multiply AMBIENT only (see textured FS). 1×1 white when SSAO off → ×1 no-op.
    let ssaoAO = textureSampleLevel(ssaoTexture, ssaoSampler, fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0)), 0.0).r;
    var total = directLight + ambient * ssaoAO + emissiveRGB;
    let cd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
    if (cd > 0.0) {
      if (scene.ps1Config2.x > 0.0) {
        total = quantizeColorUntexDithered(total, cd, fragPos);
      } else {
        total = quantizeColorUntex(total, cd);
      }
    }
    lit = total;
  }

  // Rim light (silhouette back-light glow) — render-style-independent modifier; Fresnel edge tinted by the
  // scene light, stronger where the key light doesn't hit (backlit). Layers on top of any style.
  if (rimEnabled) {
    if (scene.rimParams.x > 0.0) {
      // Parameterised rim (setRimLight3D): width / hardness / colour — a crisp toon edge light.
      lit = lit + rim_param(N, V, L, scene.rimParams);
    } else {
      let rimF = rdPow(1.0 - max(dot(N, V), 0.0), 3.0);
      let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
      lit = lit + rimF * backlit * 0.42 * scene.lightColor.rgb;
    }
  }

  // LEAF TRANSMISSION (bit 20) — added right after the rim so the two COMPOSE (backlit grass glow).
  // ★ HEADROOM-GATED: a SHADOWED backlit leaf (lit low → headroom high) still glows, but a leaf that is
  // already brightly lit (headroom near 0) can't be pushed past white. Without this the sun-facing canopy
  // blew out to white — the transmission + rim were pure additive light with no ceiling.
  lit = lit + fqTrans * clamp(1.0 - max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
  // WATER glitter is added AFTER lighting: it is a specular scintillation off the ripple normal,
  // not an albedo term, so it must not be multiplied by the diffuse response.
  lit = lit + scene.lightColor.rgb * waterGlint;

  // POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff — moving cars,
  // walkers and walls entering a lamp's radius pick up its warm pool. PBR / cel / cel-HD paths only.
  // (2026-09-29, city-quality L2/L9/L10) Collected into plPost and added AFTER the sun shadow (just below the
  // SHADOW_APPLY marker) - moon/sun shadows used to multiply lamp pools down to the shadow floor. Ink (3) now gets
  // lamps too. A small highlight weighted by (1 - roughness) squared makes wet (low-roughness) roads streak;
  // dry roads (roughness 1) are unchanged.
  var plPost = vec3<f32>(0.0);
  if (renderStyle == 0u || renderStyle == 1u || renderStyle == 3u || renderStyle == 5u) {
    var plAdd = vec3<f32>(0.0);
    var plSpec = vec3<f32>(0.0);
    let plGloss = (1.0 - clamp(inst.roughness, 0.0, 1.0)) * (1.0 - clamp(inst.roughness, 0.0, 1.0));
    let plN = min(i32(scene.lightCounts.x), 16);
    for (var pi = 0; pi < plN; pi++) {
      let lp = scene.pointLights[pi * 2];
      let lc = scene.pointLights[pi * 2 + 1];
      let dv = lp.xyz - worldPos;
      let d = length(dv);
      let att = clamp(1.0 - d / max(lp.w, 1e-3), 0.0, 1.0);
      let ndl = max(dot(N, dv / max(d, 1e-4)), 0.0);
      plAdd = plAdd + lc.rgb * (lc.a * att * att * (0.3 + 0.7 * ndl));
      let plH = rdNormalize(dv / max(d, 1e-4) + V);
      plSpec = plSpec + lc.rgb * (lc.a * att * pow(max(dot(N, plH), 0.0), 48.0) * plGloss * 1.6);
    }
    plPost = patBase * plAdd + plSpec;
  }

  // SCREEN-SPACE REFRACTION (glassEnhance + resolution.w gate): sample the PREVIOUS frame's final image at this pixel,
  // offset by the surface normal, so the case contents show THROUGH the clear plastic — slightly distorted at curved
  // edges, straight-through on the flat face. This is what turns the lid from a frosted panel into clear glass. The
  // resolution.w gate is OFF by default and turned on ONLY by the CD kit, so city glazing (which also sets
  // glassEnhance) is unaffected. The 1x1 default scene-color texture is bound for every non-glass draw.
  if (glassEnhance && scene.resolution.w > 0.5) {
    let refrScreenUV = fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0));
    // World-normal xy as a cheap view-space tilt — ~0 on a face pointing at the camera (no distortion), growing
    // toward glancing/curved areas. Small strength keeps it a subtle bend, not a smear.
    let refrUV = clamp(refrScreenUV + N.xy * vec2<f32>(0.045, -0.045), vec2<f32>(0.0), vec2<f32>(1.0));
    let refracted = textureSampleLevel(sceneColorTexture, sceneColorSampler, refrUV, 0.0).rgb;
    // Show mostly the (distorted) contents, faintly tinted by the plastic's own shaded colour.
    lit = mix(refracted, lit, 0.15);
  }

  // ENHANCED-VISUALS · STYLIZED GLASS: a fresnel sky-reflection on glass surfaces (curtain walls / storefronts), so
  // towers catch the sky and read as glass instead of flat blue paint. Gated by the global glass toggle
  // (ps1Config2.w) so it falls back to the plain look for performance. Style-independent (sits on top of lit).
  let winGlass = patMode == 6u && winWL.x > 0.5;   // a WINDOW opening is glass too → let it catch the sky (fixes "windows look flat")
  if ((glassEnhance || winGlass) && scene.ps1Config2.w > 0.5) {
    let R = reflect(-V, N);
    // ★ Reflect the SCENE's sky, not a hardcoded daytime blue. The fog colour is keyed to the time of day
    // by the day/night cycle and the cinematic grade, so glass now goes warm at dusk and dark at night
    // instead of staying noon-blue at midnight. (Same source the water reflection uses.)
    let skyC = scene.fogColor.rgb;
    // HORIZON SPLIT — glass reflects bright sky ABOVE the horizon and the darker ground BELOW it. Blending
    // two blues across the whole hemisphere (what this did) loses the horizon line that makes a tall
    // facade read as reflective rather than painted.
    let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    let ground = skyC * 0.42;
    let sky = mix(ground, skyC * 1.12, smoothstep(0.42, 0.62, up)) * (0.55 + 0.9 * scene.lightColor.rgb);
    // Reflectivity vs view angle. A higher BASE (0.30) means panes catch the sky even head-on (not only at
    // grazing angles), and the softer exponent (2.0 vs 4.0) widens the falloff so mid-angle facades read as
    // glass too — fixes "window effects only show up at very low viewing angles".
    let fres = 0.30 + 0.70 * rdPow(1.0 - max(dot(N, V), 0.0), 2.0);
    // PER-PANE VARIATION — real glazing is never perfectly coplanar, so neighbouring panes catch the sky
    // at slightly different angles. Without it a curtain wall reads as one printed gradient.
    let pane = 0.92 + 0.16 * pg_hash21(floor(worldPos.xz * 6.3 + vec2<f32>(worldPos.y * 4.1)));
    // SUN GLINT — the sharp mirror of the sun off a pane. The single most recognisable glass cue, and the
    // reason a glazed facade flashes as the camera orbits.
    let glint = pow(max(dot(R, L), 0.0), 320.0) * 1.4;
    lit = mix(lit, sky * pane, fres * select(0.6, 0.45, winGlass));
    lit = lit + scene.lightColor.rgb * glint * fres;
  }
  //__SHADOW_APPLY__
  lit = lit + plPost;   // lamp light is never sun/moon-shadowed (see the point-light block)

  // RENDER DEBUG dbgNanCheck (ibl.dbgFlags value 2): also test the UNCLAMPED lit colour - clamp() of a NaN is
  // indeterminate (0, 1 or NaN depending on the GPU), so the final colour alone can hide it. Uniform branch.
  var rdPre = 0u;
  if ((u32(ibl.dbgFlags) & 2u) != 0u) { rdPre = rdState(vec4<f32>(lit, 1.0)); }
  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  // RADIAL FADE (bit 17): soft circular alpha falloff from the UV centre — the packaging stage
  // CONTACT-SHADOW blob (a dark ground quad grounding the box; edges dissolve to nothing).
  if (radialFade) {
    let rd = length(uv - vec2<f32>(0.5, 0.5)) * 2.0;
    let fade = 1.0 - smoothstep(0.2, 1.0, rd);
    finalColor = vec4<f32>(finalColor.rgb, finalColor.a * fade * fade);
  }
  // CLOTH LINING (flags2 bit 8; see the textured FS): the inside of a garment reads as the fabric in shadow.
  if ((u32(inst.normalMatrix[3].x) & 256u) != 0u && !frontFacing) {
    finalColor = vec4<f32>(min(finalColor.rgb, inst.diffuseColor.rgb) * 0.32, finalColor.a);
  }
  if (finalColor.a < 0.01) { discard; }
  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u && !fhNoFogM) {   // no-fog meshes (Material3D.noFog) ignore atmospheric fog
    let fogDist = length(scene.fogEye.xyz - worldPos);   // fog-horizon: the fog eye (perspective = the camera, bit-identical)
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    // ENHANCED-VISUALS · AERIAL PERSPECTIVE: distant geometry DESATURATES with distance before fading to the (pale-
    // blue) fog colour → the vast atmospheric-depth look. Strength = fogColor.w (0 = plain fog). Fog must be on.
    let aerial = scene.fogColor.w;
    if (aerial > 0.0) {
      let lum = dot(finalColor.rgb, vec3<f32>(0.299, 0.587, 0.114));
      finalColor = vec4<f32>(mix(finalColor.rgb, vec3<f32>(lum), fogFactor * aerial * 0.75), finalColor.a);
    }
    // HEIGHT FOG (city-quality P9): a ground-hugging layer that thickens toward heightFog.y and with distance, so
    // street canyons and low ground haze while rooftops stay crisp. density 0 = off (the original fog).
    if (scene.heightFog.x > 0.0) {
      let hfH = exp(-max(worldPos.y - scene.heightFog.y, 0.0) * max(scene.heightFog.z, 1e-4));
      let hfD = 1.0 - exp(-fogDist * max(scene.heightFog.w, 1e-4));
      fogFactor = max(fogFactor, clamp(scene.heightFog.x * hfH * hfD, 0.0, 1.0));
    }
    // AERIAL PERSPECTIVE (persona-polish A5): from the first metres out, contrast fades toward the haze and the colour
    // leans to the horizon (fog) colour, so far facades sit back instead of being as punchy as near ones. It starts at
    // zero distance (unlike the linear fog, which only begins hundreds of metres out). strength 0 = off (original).
    if (scene.aerialParams.x > 0.0) {
      let ah = scene.aerialParams.x * (1.0 - exp(-fogDist * scene.aerialParams.y));
      let lw = vec3<f32>(0.2126, 0.7152, 0.0722);
      let midL = 0.5 * (dot(finalColor.rgb, lw) + dot(scene.fogColor.rgb, lw));
      let flatC = mix(finalColor.rgb, vec3<f32>(midL), ah * scene.aerialParams.z);
      finalColor = vec4<f32>(mix(flatC, scene.fogColor.rgb, ah * scene.aerialParams.w), finalColor.a);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }
  return dbgFinal(finalColor, rdPre);
}
`;


// ═══════════════════════════════════════════════════════════════════
//  SHADOW-RECEIVING VARIANTS of the modern fragment shaders
// ═══════════════════════════════════════════════════════════════════
// Built by marker substitution so the FULL modern feature set (patterns, interiors, relief, point lights,
// PBR/styles) RECEIVES shadows — the legacy gouraud shadow FS predates all of it. lightSpacePos is computed
// in-fragment from worldPos (no VS change). shadowParams.w = PCF penumbra width multiplier (soft shadows).
// The emissive part is restored un-shadowed (neon must not dim inside a building's shadow).

const SHADOW_SAMPLE_WGSL = (group: number): string => /* wgsl */ `
@group(${group}) @binding(0) var shadowMap:     texture_depth_2d;
@group(${group}) @binding(1) var shadowSampler: sampler_comparison;
@group(${group}) @binding(2) var shadowCascades: texture_depth_2d_array;
@group(${group}) @binding(3) var shadowMinMax: texture_2d<f32>;
@group(${group}) @binding(4) var cascadeMinMax: texture_2d_array<f32>;
@group(${group}) @binding(5) var<uniform> shadowMM: vec4<f32>;

// P6 (performance-plan.md) EXACT PCF shortcut. A min/max texel holds the lowest and highest stored depth over an
// 8x8 tile of the map and its 8 neighbours, so it covers every texel any tap of a kernel centred in that tile reads
// (radius * soft + 2.5 texels, checked below). The sampler compares with less: a reference below the min passes
// every tap (the PCF average is exactly 1), at or above the max fails every tap (exactly 0). Returns -1 when the
// full PCF must run (an edge, a reference outside 0..1, or the shortcut is off for that map).
fn shadowShortcut(mm: vec2<f32>, depth: f32) -> f32 {
  if (depth < 0.0 || depth > 1.0) { return -1.0; }
  if (depth < mm.x) { return 1.0; }
  if (depth >= mm.y) { return 0.0; }
  return -1.0;
}

fn shadowTileOf(uv: vec2<f32>, mapSize: f32, mmDim: vec2<u32>) -> vec2<i32> {
  let ms = i32(mapSize);
  let c = clamp(vec2<i32>(floor(uv * mapSize)), vec2<i32>(0, 0), vec2<i32>(ms - 1, ms - 1));
  return min(c / i32(shadowMM.z), vec2<i32>(mmDim) - vec2<i32>(1, 1));
}

fn sampleShadow(lightSpacePos: vec4<f32>) -> f32 {
  let ndc = lightSpacePos.xyz / lightSpacePos.w;
  let suv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let inRange   = suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0;
  let clampedUV = clamp(suv, vec2<f32>(0.0), vec2<f32>(1.0));
  let depth = ndc.z - scene.shadowParams.y;
  let mapSize = max(scene.shadowParams.z, 1.0);
  let soft = select(1.0, scene.shadowParams.w, scene.shadowParams.w > 0.01);   // penumbra width multiplier
  let texel = soft / mapSize;
  // PCF QUALITY TIER (shadowParams.x): 0 = default radius 2 (5x5 = 25 taps, unchanged look), 1 = fast 3x3
  // (9 taps, ~2.7x fewer compares per lit fragment - a big win on city-scale fill). Set via setShadowQuality.
  let r = select(2, i32(scene.shadowParams.x), scene.shadowParams.x > 0.5);
  if (shadowMM.x > 0.5 && f32(r) * soft + 2.5 <= shadowMM.z) {
    let q = shadowShortcut(textureLoad(shadowMinMax, shadowTileOf(clampedUV, mapSize, textureDimensions(shadowMinMax)), 0).xy, depth);
    if (q >= 0.0) { return select(1.0, q, inRange); }
  }
  var shadow = 0.0;
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      shadow += textureSampleCompareLevel(shadowMap, shadowSampler, clampedUV + vec2<f32>(f32(dx), f32(dy)) * texel, depth);
    }
  }
  let taps = f32((2 * r + 1) * (2 * r + 1));
  return select(1.0, shadow / taps, inRange);
}

// CASCADED SHADOWS (persona-polish A2). Up to two NEAR cascades (texel-snapped boxes around the camera, in a depth
// array) refine the original map, which stays the far cascade. Per pixel the nearest cascade that contains it wins;
// inside the outer blend band of its box it fades into the next one, so there is no visible seam. cascadeParams.x = 0
// means no cascades: exactly the original single-map result. All taps are CompareLevel (valid in non-uniform flow).
// Returns (shadow, 1) when the point is inside cascade i, (1, 0) when it is not.
fn sampleCascade(i: i32, worldPos: vec3<f32>) -> vec2<f32> {
  let lp = scene.cascadeMatrices[i] * vec4<f32>(worldPos, 1.0);
  let ndc = lp.xyz / lp.w;
  let edge = max(abs(ndc.x), abs(ndc.y));
  if (edge >= 1.0 || ndc.z < 0.0 || ndc.z > 1.0) { return vec2<f32>(1.0, 0.0); }
  let suv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let depth = ndc.z - select(scene.cascadeBias.x, scene.cascadeBias.y, i == 1);
  let soft = select(1.0, scene.shadowParams.w, scene.shadowParams.w > 0.01);
  let texel = soft / max(scene.cascadeParams.y, 1.0);
  let r = select(2, i32(scene.shadowParams.x), scene.shadowParams.x > 0.5);
  if (shadowMM.y > 0.5 && f32(r) * soft + 2.5 <= shadowMM.z) {
    let cms = max(scene.cascadeParams.y, 1.0);
    let q = shadowShortcut(textureLoad(cascadeMinMax, shadowTileOf(clamp(suv, vec2<f32>(0.0), vec2<f32>(1.0)), cms, textureDimensions(cascadeMinMax)), i, 0).xy, depth);
    if (q >= 0.0) { return vec2<f32>(q, 1.0); }
  }
  var sh = 0.0;
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      sh += textureSampleCompareLevel(shadowCascades, shadowSampler, suv + vec2<f32>(f32(dx), f32(dy)) * texel, i, depth);
    }
  }
  return vec2<f32>(sh / f32((2 * r + 1) * (2 * r + 1)), 1.0);
}

fn cascadeEdge(i: i32, worldPos: vec3<f32>) -> f32 {
  let lp = scene.cascadeMatrices[i] * vec4<f32>(worldPos, 1.0);
  return max(abs(lp.x / lp.w), abs(lp.y / lp.w));
}

fn sampleShadowCascaded(worldPos: vec3<f32>) -> f32 {
  let n = i32(scene.cascadeParams.x + 0.5);
  if (n <= 0) { return sampleShadow(scene.lightSpaceMatrix * vec4<f32>(worldPos, 1.0)); }
  let band = clamp(scene.cascadeParams.z, 0.0, 0.5);
  for (var i = 0; i < n; i++) {
    let c = sampleCascade(i, worldPos);
    if (c.y > 0.5) {
      // (safeLightingMath: a zero blend band is smoothstep(1, 1, x), undefined; widen it to 1e-4.)
      let t = smoothstep(1.0 - select(band, max(band, 1e-4), rdSafeMath), 1.0, cascadeEdge(i, worldPos));
      if (t <= 0.0) { return c.x; }
      var nxt = vec2<f32>(1.0, 0.0);
      if (i + 1 < n) { nxt = sampleCascade(i + 1, worldPos); }
      let nv = select(sampleShadow(scene.lightSpaceMatrix * vec4<f32>(worldPos, 1.0)), nxt.x, nxt.y > 0.5);
      return mix(c.x, nv, t);
    }
  }
  return sampleShadow(scene.lightSpaceMatrix * vec4<f32>(worldPos, 1.0));
}
`;

const SHADOW_APPLY_WGSL = /* wgsl */ `
  // RECEIVE the sun shadow (PCF above). Emissive light is restored un-shadowed.
  // The in-shadow light floor is scene.resolution.z (shadow darkness): 0.42 default, lower = darker (host-tunable).
  let shadowFactor = sampleShadowCascaded(worldPos);   // near cascades (persona-polish A2) + the original map
  // COLOURED SHADOW (city-quality L3): styleParams.w packs an rgb8 tint; normalised to unit luminance so it shifts the
  // HUE of the shadow (blue day, violet dusk, indigo night) without changing its darkness. 0 = neutral (original).
  let shTintRaw = toon_unpack_rgb8(scene.styleParams.w);
  let shTint = select(vec3<f32>(1.0), shTintRaw / max(dot(shTintRaw, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-3), scene.styleParams.w > 0.5);
  // RENDER DEBUG (ibl.dbgFlags, uniform): 8 = skip the shadow receive (shadowMul 1); 16 = show shadowFactor as grey
  // (red where it is above 1, blue where below 0, green where NaN / Inf - none of which a healthy map produces).
  let rdSh = u32(ibl.dbgFlags);
  let shadowMul = select(mix(vec3<f32>(scene.resolution.z) * shTint, vec3<f32>(1.0), shadowFactor), vec3<f32>(1.0), (rdSh & 8u) != 0u);
  lit = lit * shadowMul + emissiveRGB * (vec3<f32>(1.0) - shadowMul);
  if ((rdSh & 16u) != 0u) {
    let rdSfBad = (bitcast<u32>(shadowFactor) & 0x7f800000u) == 0x7f800000u;
    var rdSf = vec3<f32>(clamp(shadowFactor, 0.0, 1.0));
    rdSf = select(rdSf, vec3<f32>(1.0, 0.0, 0.0), shadowFactor > 1.0001);
    rdSf = select(rdSf, vec3<f32>(0.0, 0.0, 1.0), shadowFactor < -0.0001);
    lit = select(rdSf, vec3<f32>(0.0, 1.0, 0.0), rdSfBad);
  }
`;

// Marker substitution that ASSERTS the marker was present. String.replace silently no-ops if the marker text
// ever drifts (rename/typo) — the shader would then compile with the literal comment still in it and shadows would
// vanish with no error. Fail LOUD at module-eval instead.
function replaceMarker(src: string, marker: string, repl: string): string {
    if (!src.includes(marker)) {
        throw new Error(`mesh3d-shaders: shader marker not found (drifted?): ${marker}`);
    }
    return src.replace(marker, repl);
}

// ═══════════════════════════════════════════════════════════════════
//  PATTERN specialization — §3.1 uber-shader "plain" variant
// ═══════════════════════════════════════════════════════════════════
// The procedural pattern block runs patternMask ×3 + windowsPattern + gr_uvMetres UNCONDITIONALLY on EVERY fragment
// (fwidth/dpdx demand uniform control flow → can't sit behind a per-instance `if`). Most meshes (characters, cars,
// plain walls) use NO pattern/window/ground, so that ALU is pure waste for them. It can't be runtime-branched, so
// we compile a PLAIN variant with the block replaced by cheap defaults, and route non-pattern meshes to it (see
// Renderer3D usesPatterns). The FULL block is code-identical to the original; the PLAIN defaults are IDENTICAL to
// the full shader's patMode==0 / no-shade-bit path (patMask 0 → patBase = diffuse), so a plain mesh renders the same.

const PATTERN_BLOCK_FULL = /* wgsl */ `
  // Procedural pattern -> the base albedo (primary = diffuse, secondary = patternColor). AA'd in-shader.
  // ALL fwidth-using helpers (patternMask x3 for the relief gradient, windowsPattern, gr_uvMetres) run
  // UNCONDITIONALLY so fwidth stays in uniform control flow; their results are gated afterwards.
  let patMask = patternMask(uv, patMode, inst.patternParams, scene.ps1Config2.z);
  // Relief step in pattern CELLS. DOTS (mode 2) use a fine step: at 0.35 cell the shifted mask of a small stud
  // never overlaps the stud itself, so every dot grew an offset ghost twin (tactile paving, city-quality S3).
  let pEpsK = select(f32(0.35), f32(0.06), patMode == 2u);
  let pEps = pEpsK / max(inst.patternParams.x, 0.001);
  let patMaskR = patternMask(uv + vec2<f32>(pEps, 0.0), patMode, inst.patternParams, scene.ps1Config2.z);
  let patMaskU = patternMask(uv + vec2<f32>(0.0, pEps), patMode, inst.patternParams, scene.ps1Config2.z);
  // P8 shader fast paths (Renderer3D.shaderFastPaths -> scene.cascadeBias.z): bit-identical shortcuts in the facade
  // pattern (windowsPattern / windowShade) and the procedural ground; 0 = the original code paths (A/B).
  let p8Fast = scene.cascadeBias.z > 0.5;
  let gUvFw = fwidth(uv);                                        // P8 ground relief LOD footprint (uniform flow)
  let winWL = windowsPattern(uv, inst.patternParams, scene.ps1Config2.z, patMode == 6u, p8Fast);
  let gUvM = gr_uvMetres(uv, worldPos);
  let winAx = uvWorldAxes(uv, worldPos);                         // interior-mapping cell frame (uniform flow)
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
  var emissiveRGB = inst.emissive;
  // CROWD PALETTE (flags2 bit 4, performance-plan P12): the per-vertex palette code tints the base + emissive.
  let crowdK = crowdTint(u32(inst.normalMatrix[3].x), uv, inst.patternColor.xyz);
  patBase = patBase * crowdK;
  emissiveRGB = emissiveRGB * crowdK;
  var roughOverride = inst.roughness;
  if (patMode == 6u && !fhSkip) {   // fog horizon: a fogged pixel needs no window interior
    let ws = windowShade(uv, inst.patternParams, winWL, worldPos, worldNormal, winAx, scene.cameraPosition.xyz,
                         inst.diffuseColor.rgb, inst.patternColor.rgb, inst.emissive, scene.ps1Config2.z, p8Fast, inst.patternColor.a);
    patBase = ws.base;
    emissiveRGB = ws.emk;
  } else if (patMode == 7u) {
    if (inst.patternParams.z > 1.5) {
      // visual-polish #6: an AD SCREEN (designed loop, see adScreen) - the colour IS the light; the layer's glow factor
      // (emissive / diffuse, set by the day-night glow walk) scales it.
      let adAsp = select(1.6, clamp(length(winAx.u) / max(length(winAx.v), 1e-12), 0.3, 6.0), dot(winAx.v, winAx.v) > 1e-24);
      let adC = adScreen(uv, gUvFw, adAsp, scene.ps1Config2.z);
      patBase = adC;
      let adE = inst.emissive / max(inst.diffuseColor.rgb, vec3<f32>(0.05));
      emissiveRGB = adC * max(adE.x, max(adE.y, adE.z)) * 0.9;
    } else {
      emissiveRGB = emissiveRGB * (0.3 + 1.5 * patMask);
    }
  }`;

const PATTERN_BLOCK_PLAIN = /* wgsl */ `
  // PLAIN variant: this mesh has no pattern/window/ground, so SKIP the fwidth-forced patternMask x3 /
  // windowsPattern / gr_uvMetres calls. Defaults equal the full shader's patMode==0 path -> identical output.
  let patMask = 0.0;
  let patMaskR = 0.0;
  let patMaskU = 0.0;
  let winWL = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  let gUvM = vec2<f32>(0.0, 0.0);
  let p8Fast = scene.cascadeBias.z > 0.5;
  let gUvFw = vec2<f32>(0.0, 0.0);
  var patBase = inst.diffuseColor.rgb;
  var emissiveRGB = inst.emissive;
  // CROWD PALETTE (flags2 bit 4, performance-plan P12): the per-vertex palette code tints the base + emissive.
  let crowdK = crowdTint(u32(inst.normalMatrix[3].x), uv, inst.patternColor.xyz);
  patBase = patBase * crowdK;
  emissiveRGB = emissiveRGB * crowdK;
  var roughOverride = inst.roughness;`;

// Base (no-shadow) fragment shaders: FULL keeps the pattern block; PLAIN strips it.
export const MESH3D_FRAGMENT_SHADER               = replaceMarker(MESH3D_FS_TEXTURED_TEMPLATE,   '//__PATTERN_BLOCK__', PATTERN_BLOCK_FULL);
export const MESH3D_FRAGMENT_SHADER_PLAIN         = replaceMarker(MESH3D_FS_TEXTURED_TEMPLATE,   '//__PATTERN_BLOCK__', PATTERN_BLOCK_PLAIN);
export const MESH3D_FRAGMENT_SHADER_UNTEXTURED       = replaceMarker(MESH3D_FS_UNTEXTURED_TEMPLATE, '//__PATTERN_BLOCK__', PATTERN_BLOCK_FULL);
export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN = replaceMarker(MESH3D_FS_UNTEXTURED_TEMPLATE, '//__PATTERN_BLOCK__', PATTERN_BLOCK_PLAIN);

// Shadow-receiving variants of each (full + plain).
const withShadow = (fs: string, group: number): string =>
    replaceMarker(replaceMarker(fs, '//__SHADOW_BINDINGS__', SHADOW_SAMPLE_WGSL(group)), '//__SHADOW_APPLY__', SHADOW_APPLY_WGSL);
export const MESH3D_FRAGMENT_SHADER_SHADOW_MODERN                 = withShadow(MESH3D_FRAGMENT_SHADER, 2);
export const MESH3D_FRAGMENT_SHADER_PLAIN_SHADOW_MODERN           = withShadow(MESH3D_FRAGMENT_SHADER_PLAIN, 2);
export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN       = withShadow(MESH3D_FRAGMENT_SHADER_UNTEXTURED, 1);
export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN_SHADOW_MODERN = withShadow(MESH3D_FRAGMENT_SHADER_UNTEXTURED_PLAIN, 1);


// ===================================================================
//  DEFERRED SSR RESOLVE (Stage 3b): trace once per half-res texel
// ===================================================================
// Fullscreen pass over the prepass G-buffer: for each on-object, SSR-eligible texel, reconstruct the reflection
// ray from the stored world position + normal and run the SAME traceSSR as the inline path (PBR_IBL_WGSL is
// spliced verbatim, so the CPU reference in ssr-trace.ts keeps covering this pass). Output = colour + fade into
// the half-res reflection texture, which the mesh FS samples (binding 13). Uses the mesh group-0 layout: the
// resolve bind group binds world-pos/back/normal REAL and the reflection texture as a dummy (it is the target).
export const SSR_RESOLVE_SHADER = /* wgsl */`
// Leading prefix of the scene uniform buffer (the bound buffer is larger, which WGSL permits).
struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
};
@group(0) @binding(1) var<uniform> scene: SceneUniforms;

${PBR_IBL_WGSL}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let px = vec2<i32>(fragCoord.xy);
  let sw = textureLoad(ssrWorldPosTex, px, 0);
  if (sw.w <= 0.5) { return vec4<f32>(0.0); }                    // background
  let nm = textureLoad(ssrNormalTex, px, 0);
  if (nm.w < -0.5) { return vec4<f32>(0.0); }                    // matte override (noEnvReflection)
  let metal = nm.w >= 2.0;
  let rough = nm.w - select(0.0, 2.0, metal);
  if (rough >= ibl.ssrMaxRoughness) { return vec4<f32>(0.0); }   // rougher surfaces skip SSR (mesh FS gate)
  let N = normalize(nm.xyz);
  // Same view-vector convention as the mesh shaders: perspective = eye - P; ortho = constant forward.
  let V = select(normalize(scene.cameraPosition.xyz - sw.xyz), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
  let R = reflect(-V, N);
  return traceSSR(sw.xyz, N, R, scene.viewProjection);
}
`;


// ===================================================================
//  DEFERRED SSR POST (Stage 3b Phase B): heal + true edge feather
// ===================================================================
// Two tiny fullscreen passes over the half-res reflection buffer, ping-ponged (heal: A -> B, feather: B -> A):
//   fs_heal    - fills texels with no/weak result whose neighbourhood has a MAJORITY of resolved texels
//                (heals isolated holes + serration notches without inflating silhouettes), reading binding 13.
//   fs_feather - premultiplied tent blur, radius = ssrEdgeFeather half-res texels: alpha ramps smoothly ACROSS
//                the reflection's perimeter (the outward additive fade-out a per-ray trace cannot produce).
//                Radius 0 degenerates to a copy (the pass still runs to return the result to texture A).
// Uses the mesh group-0 layout; the input is whatever is bound at binding 13 in the pass's bind group.
export const SSR_POST_SHADER = /* wgsl */`
${PBR_IBL_WGSL}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  return out;
}

@fragment
fn fs_heal(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(ssrReflectionTex));
  let px = vec2<i32>(fragCoord.xy);
  let c = textureLoad(ssrReflectionTex, px, 0);
  // Neighbourhood: the 8-ring at +/-1 plus 4 axis taps at +/-2 - the wider taps let the lift see across
  // seams up to ~2 texels wide (a 1-ring lift left wider internal seams dark, user-reported twice).
  var ring1Count = 0.0;                             // resolved +/-1 neighbours (the hole-fill majority gate)
  var acc = vec4<f32>(0.0);                         // premultiplied resolved accumulation (all 12 taps)
  var count = 0.0;
  var strong = 0.0;                                 // taps noticeably MORE confident than this texel
  for (var ti = 0; ti < 12; ti = ti + 1) {
    var d = vec2<i32>(0);
    if (ti == 0) { d = vec2<i32>(1, 0); }    if (ti == 1) { d = vec2<i32>(-1, 0); }
    if (ti == 2) { d = vec2<i32>(0, 1); }    if (ti == 3) { d = vec2<i32>(0, -1); }
    if (ti == 4) { d = vec2<i32>(1, 1); }    if (ti == 5) { d = vec2<i32>(-1, 1); }
    if (ti == 6) { d = vec2<i32>(1, -1); }   if (ti == 7) { d = vec2<i32>(-1, -1); }
    if (ti == 8) { d = vec2<i32>(2, 0); }    if (ti == 9) { d = vec2<i32>(-2, 0); }
    if (ti == 10) { d = vec2<i32>(0, 2); }   if (ti == 11) { d = vec2<i32>(0, -2); }
    let np = clamp(px + d, vec2<i32>(0), dims - vec2<i32>(1));
    let n = textureLoad(ssrReflectionTex, np, 0);
    if (n.a > 0.05) {
      acc = acc + vec4<f32>(n.rgb * n.a, n.a);
      count = count + 1.0;
      if (ti < 8) { ring1Count = ring1Count + 1.0; }
    }
    if (n.a > c.a + 0.12) { strong = strong + 1.0; }
  }
  // HOLE fill - MAJORITY gate on the +/-1 ring: an interior hole / serration notch has most neighbours
  // resolved; a texel outside the silhouette does not, so healing cannot inflate the reflection's outline.
  if (c.a <= 0.05) {
    if (ring1Count >= 5.0) {
      return vec4<f32>(acc.rgb / max(acc.a, 1e-4), acc.a / count);
    }
    return c;
  }
  // INTERIOR CONFIDENCE-DIP lift: partial-alpha seams along INTERNAL face boundaries (marginal-exit texels)
  // are INSIDE the silhouette - even at feather 0 they composite darker (more mirror base shows through), and
  // the feather smears them into dark bands. When a 2/3 majority of taps is noticeably stronger (+0.12 - the
  // old +0.25 bar let shallow seams slide under it), lift this texel's alpha to the neighbourhood level; its
  // own colour is kept (only confidence was low). The interior becomes uniform, so the feather has nothing to
  // do there and ONLY the true outline ramps. Outline texels never qualify - their outside taps are empty.
  if (strong >= 8.0) {
    return vec4<f32>(c.rgb, max(c.a, acc.a / count));
  }
  return c;
}

@fragment
fn fs_feather(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(ssrReflectionTex));
  let px = vec2<i32>(fragCoord.xy);
  let c = textureLoad(ssrReflectionTex, px, 0);
  let r = ibl.ssrEdgeFeather;
  if (r < 0.01) { return c; }                       // radius 0 = plain copy back to texture A
  // Premultiplied 3x3 tent at +/- r texels (center weight 2): alpha ramps across the perimeter over ~r texels;
  // premultiplication keeps colours from dragging in the empty background (no dark fringes).
  var acc = vec4<f32>(c.rgb * c.a, c.a) * 2.0;
  var wsum = 2.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let off = vec2<f32>(f32(dx), f32(dy)) * r;
      let np = clamp(px + vec2<i32>(off), vec2<i32>(0), dims - vec2<i32>(1));
      let n = textureLoad(ssrReflectionTex, np, 0);
      let w = select(1.0, 0.7071, dx != 0 && dy != 0);   // tent-ish: diagonals lighter
      acc = acc + vec4<f32>(n.rgb * n.a, n.a) * w;
      wsum = wsum + w;
    }
  }
  let a = acc.a / wsum;
  return vec4<f32>(acc.rgb / max(acc.a, 1e-4), a);
}
`;
