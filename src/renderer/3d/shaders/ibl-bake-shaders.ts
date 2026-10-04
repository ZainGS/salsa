/**
 * GPU sky-lighting bake (performance-plan P4.1). WGSL mirrors of the CPU REFERENCE math, kept bit-for-bit in
 * structure so the two agree to ~1 LSB after the 8-bit encode:
 *   - skyColor            = procedural-sky.ts evaluateSkyColor
 *   - csSH9 (1 workgroup) = renderer-3d _computeSHCoeffs over bakeSkyEquirect (same 8-bit sRGB round-trip, same
 *                           Ramamoorthi-Hanrahan cosine-lobe K factors, same 4pi/totalW normalisation), reduced in
 *                           workgroup memory; output = 9 vec4 laid out exactly like IBL uniform floats 0-35
 *   - csPrefilter         = ibl-specular-bake.ts bakePrefilteredCube (+ ibl-prefilter.ts prefilterColor /
 *                           importanceSampleGGX / hammersley / cubeFaceTexelDir), one invocation per texel per
 *                           face per mip, written as packed sRGB RGBA8 into 256-byte-aligned rows for
 *                           copyBufferToTexture
 *   - csBrdfLut           = ibl-prefilter.ts generateBRDFLUT (bakeBRDFLUTBytes packing)
 * No backticks in comments (this is a template string).
 */
export const IBL_BAKE_SHADER = /* wgsl */ `
struct BakeParams {
  zenith: vec4f,     // rgb, w = gradientBias
  horizon: vec4f,    // rgb, w = intensity
  ground: vec4f,     // rgb, w = sunHalo
  sunColor: vec4f,   // rgb, w = sunSizeDeg
  sunDir: vec4f,     // xyz toward the sun (unnormalised ok)
  cfg: vec4f,        // x = cube base size, y = mip count, z = GGX samples, w = row stride (texels)
  eq: vec4f,         // x = equirect width, y = equirect height, z = BRDF LUT size, w = BRDF samples
};

@group(0) @binding(0) var<uniform> P: BakeParams;

const PI_F: f32 = 3.14159265358979;

fn skyColor(dirIn: vec3f) -> vec3f {
  let len = max(length(dirIn), 1e-20);
  let d = dirIn / len;
  let dy = clamp(d.y, -1.0, 1.0);
  let bias = P.zenith.w;
  var c: vec3f;
  if (dy >= 0.0) {
    let t = pow(max(dy, 1e-12), bias);
    c = mix(P.horizon.rgb, P.zenith.rgb, t);
  } else {
    let t = pow(max(-dy, 1e-12), bias);
    c = mix(P.horizon.rgb, P.ground.rgb, t);
  }
  let sunLen = max(length(P.sunDir.xyz), 1e-20);
  let sd = (d.x * P.sunDir.x + dy * P.sunDir.y + d.z * P.sunDir.z) / sunLen;
  let sizeDeg = P.sunColor.w;
  let cosDisk = cos(sizeDeg * PI_F / 180.0);
  let cosInner = cos(sizeDeg * 0.55 * PI_F / 180.0);
  var disk = 0.0;
  if (sd >= cosInner) { disk = 1.0; } else if (sd > cosDisk) { disk = (sd - cosDisk) / (cosInner - cosDisk); }
  let cosHalo = cos(sizeDeg * 8.0 * PI_F / 180.0);
  var haloT = 0.0;
  if (sd > cosHalo) { haloT = clamp((sd - cosHalo) / (1.0 - cosHalo), 0.0, 1.0); }
  let h2 = haloT * haloT;
  let halo = h2 * h2 * P.ground.w;
  let sun = disk * 6.0 + halo;
  return (c + P.sunColor.rgb * sun) * P.horizon.w;
}

// 8-bit sRGB round-trip, exactly what bakeSkyEquirect encodes and _computeSHCoeffs decodes.
fn quantizeSrgb(c: vec3f) -> vec3f {
  let enc = clamp(pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), vec3f(0.0), vec3f(1.0));
  let q = floor(enc * 255.0 + vec3f(0.5)) / 255.0;
  return pow(q, vec3f(2.2));
}

// ---- SH9 projection: ONE workgroup of 256 sums the equirect then tree-reduces each coefficient. ----
@group(0) @binding(1) var<storage, read_write> shOut: array<vec4f, 9>;
var<workgroup> red: array<vec4f, 256>;
var<workgroup> sums: array<vec4f, 9>;

@compute @workgroup_size(256)
fn csSH9(@builtin(local_invocation_index) lid: u32) {
  let W = u32(P.eq.x);
  let H = u32(P.eq.y);
  var acc: array<vec3f, 9>;
  for (var k0 = 0u; k0 < 9u; k0++) { acc[k0] = vec3f(0.0); }
  var wsum = 0.0;
  let total = W * H;
  for (var i = lid; i < total; i += 256u) {
    let py = i / W;
    let px = i - py * W;
    let theta = PI_F * (f32(py) + 0.5) / f32(H);
    let sinT = sin(theta);
    let cosT = cos(theta);
    let dw = sinT * (PI_F / f32(H)) * (2.0 * PI_F / f32(W));
    let phi = 2.0 * PI_F * (f32(px) + 0.5) / f32(W);
    let nx = sinT * sin(phi);
    let ny = cosT;
    let nz = sinT * cos(phi);
    let col = quantizeSrgb(skyColor(vec3f(nx, ny, nz)));
    let K0 = 0.886227;
    let K1 = 1.023327;
    let K2 = 0.858086;
    let K3 = 0.743125;
    let K4 = 0.429043;
    var b: array<f32, 9>;
    b[0] = K0;
    b[1] = K1 * ny;
    b[2] = K1 * nz;
    b[3] = K1 * nx;
    b[4] = K2 * nx * ny;
    b[5] = K2 * ny * nz;
    b[6] = K3 * (3.0 * nz * nz - 1.0);
    b[7] = K2 * nx * nz;
    b[8] = K4 * (nx * nx - ny * ny);
    wsum += dw;
    for (var k1 = 0u; k1 < 9u; k1++) { acc[k1] += col * (b[k1] * dw); }
  }
  for (var k = 0u; k < 9u; k++) {
    red[lid] = vec4f(acc[k], wsum);
    workgroupBarrier();
    for (var s = 128u; s > 0u; s = s >> 1u) {
      if (lid < s) { red[lid] = red[lid] + red[lid + s]; }
      workgroupBarrier();
    }
    if (lid == 0u) { sums[k] = red[0]; }
    workgroupBarrier();
  }
  if (lid < 9u) {
    let norm = (4.0 * PI_F) / max(sums[0].w, 1e-20);
    shOut[lid] = vec4f(sums[lid].xyz * norm, 0.0);
  }
}

// ---- Prefiltered specular cube ----
@group(0) @binding(2) var<storage, read_write> cubeOut: array<u32>;

fn hammersley(i: u32, n: u32) -> vec2f {
  return vec2f(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}

fn importanceSampleGGX(xi: vec2f, roughness: f32, Nn: vec3f) -> vec3f {
  let a = roughness * roughness;
  let phi = 2.0 * PI_F * xi.x;
  let cosT = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let hx = cos(phi) * sinT;
  let hy = sin(phi) * sinT;
  let hz = cosT;
  var up = vec3f(1.0, 0.0, 0.0);
  if (abs(Nn.z) < 0.999) { up = vec3f(0.0, 0.0, 1.0); }
  let t = normalize(cross(up, Nn));
  let bt = cross(Nn, t);
  return normalize(t * hx + bt * hy + Nn * hz);
}

fn prefilterColor(R: vec3f, roughness: f32, numSamples: u32) -> vec3f {
  let N = normalize(R);
  let V = N;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0u; i < numSamples; i++) {
    let H = importanceSampleGGX(hammersley(i, numSamples), roughness, N);
    let L = normalize(reflect(-V, H));
    let NdotL = dot(N, L);
    if (NdotL > 0.0) {
      acc += skyColor(L) * NdotL;
      wsum += NdotL;
    }
  }
  if (wsum <= 0.0) { return skyColor(N); }
  return acc / wsum;
}

fn cubeFaceTexelDir(face: u32, u: f32, v: f32) -> vec3f {
  let a = 2.0 * u - 1.0;
  let b = 2.0 * v - 1.0;
  var d: vec3f;
  switch (face) {
    case 0u: { d = vec3f(1.0, -b, -a); }
    case 1u: { d = vec3f(-1.0, -b, a); }
    case 2u: { d = vec3f(a, 1.0, b); }
    case 3u: { d = vec3f(a, -1.0, -b); }
    case 4u: { d = vec3f(a, -b, 1.0); }
    default: { d = vec3f(-a, -b, -1.0); }
  }
  return normalize(d);
}

fn encodeSrgb8(c: vec3f) -> u32 {
  let e = clamp(pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), vec3f(0.0), vec3f(1.0));
  return pack4x8unorm(vec4f(e, 1.0));
}

// gid.z = mip * 6 + face. Each (mip, face) owns a slab of rowStride * baseSize texels.
@compute @workgroup_size(8, 8, 1)
fn csPrefilter(@builtin(global_invocation_id) gid: vec3u) {
  let base = u32(P.cfg.x);
  let mips = u32(P.cfg.y);
  let samples = u32(P.cfg.z);
  let rowStride = u32(P.cfg.w);
  let mip = gid.z / 6u;
  let face = gid.z - mip * 6u;
  if (mip >= mips) { return; }
  let size = max(1u, base >> mip);
  if (gid.x >= size || gid.y >= size) { return; }
  var roughness = 0.0;
  if (mips > 1u) { roughness = f32(mip) / f32(mips - 1u); }
  let dir = cubeFaceTexelDir(face, (f32(gid.x) + 0.5) / f32(size), (f32(gid.y) + 0.5) / f32(size));
  var c: vec3f;
  if (roughness <= 1e-4) { c = skyColor(dir); } else { c = prefilterColor(dir, roughness, samples); }
  let slab = gid.z * rowStride * base;
  cubeOut[slab + gid.y * rowStride + gid.x] = encodeSrgb8(c);
}

// ---- BRDF split-sum LUT (environment-independent; baked once) ----
@group(0) @binding(3) var<storage, read_write> lutOut: array<u32>;

fn geometrySmithIBL(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let k = (roughness * roughness) / 2.0;
  let gv = NdotV / (NdotV * (1.0 - k) + k);
  let gl = NdotL / (NdotL * (1.0 - k) + k);
  return gv * gl;
}

@compute @workgroup_size(8, 8, 1)
fn csBrdfLut(@builtin(global_invocation_id) gid: vec3u) {
  let size = u32(P.eq.z);
  let n = u32(P.eq.w);
  if (gid.x >= size || gid.y >= size) { return; }
  let roughness = (f32(gid.y) + 0.5) / f32(size);
  let nv = clamp((f32(gid.x) + 0.5) / f32(size), 1e-4, 1.0);
  let V = vec3f(sqrt(1.0 - nv * nv), 0.0, nv);
  let N = vec3f(0.0, 0.0, 1.0);
  var A = 0.0;
  var B = 0.0;
  for (var i = 0u; i < n; i++) {
    let Hs = importanceSampleGGX(hammersley(i, n), roughness, N);
    let L = reflect(-V, Hs);
    let NdotL = max(L.z, 0.0);
    let NdotH = max(Hs.z, 0.0);
    let VdotH = max(dot(V, Hs), 0.0);
    if (NdotL > 0.0) {
      let G = geometrySmithIBL(nv, NdotL, roughness);
      let gVis = (G * VdotH) / (NdotH * nv);
      let Fc = pow(1.0 - VdotH, 5.0);
      A += (1.0 - Fc) * gVis;
      B += Fc * gVis;
    }
  }
  lutOut[gid.y * size + gid.x] = pack4x8unorm(vec4f(A / f32(n), B / f32(n), 0.0, 1.0));
}
`;
