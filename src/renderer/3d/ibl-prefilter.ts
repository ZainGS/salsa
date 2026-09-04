/**
 * Split-sum IBL precompute — the pure math behind P1b's prefiltered specular (docs/specs/environment-and-reflections.md).
 *
 * The split-sum approximation (Karis 2013) factors the specular IBL integral into two parts that are precomputed:
 *   1. A PREFILTERED environment (this file's `prefilterColor`): the environment convolved with the GGX lobe for a set
 *      of roughness levels → the mip-chain a mesh samples along its reflection vector R. Low roughness = sharp mirror,
 *      high roughness = blurred. This REPLACES the current soft SH-probe specular with crisp, roughness-aware reflections.
 *   2. A BRDF integration LUT (`integrateBRDF` / `generateBRDFLUT`): the environment-independent (scale, bias) on F0,
 *      indexed by (NdotV, roughness). Combine as `specular = prefiltered × (F0 × A + B)`.
 *
 * These functions are storage-agnostic (they take/return colours + directions), match the sky convention used
 * everywhere else (Y-up, LINEAR colour), and are validated against `evaluateSkyColor`. The GPU pass in P1b mirrors this
 * math in WGSL — render the sky to a cubemap, prefilter each mip with `prefilterColor`, bake the LUT once with
 * `generateBRDFLUT`, then `envSpecular` samples `prefilteredCube(R, roughness) × (F0·A + B)`.
 */

const PI = Math.PI;

/** Low-discrepancy Hammersley point i of n in [0,1)². The van der Corput radical-inverse gives the second coordinate. */
export function hammersley(i: number, n: number): [number, number] {
  // Radical inverse (base 2) via bit reversal.
  let bits = i >>> 0;
  bits = (bits << 16) | (bits >>> 16);
  bits = ((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1);
  bits = ((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2);
  bits = ((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4);
  bits = ((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8);
  const rdi = (bits >>> 0) * 2.3283064365386963e-10;   // / 2^32
  return [i / n, rdi];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Build an orthonormal tangent basis around a unit normal N (for hemisphere sampling). */
function tangentBasis(N: [number, number, number]): [[number, number, number], [number, number, number]] {
  const up: [number, number, number] = Math.abs(N[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
  const t = normalize([up[1] * N[2] - up[2] * N[1], up[2] * N[0] - up[0] * N[2], up[0] * N[1] - up[1] * N[0]]);
  const b: [number, number, number] = [N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]];
  return [t, b];
}

/**
 * GGX importance-sampled half-vector for sample `xi` at a given `roughness`, oriented around normal `N`. At
 * roughness→0 this collapses to N (a perfect mirror); at roughness→1 it spreads over the hemisphere.
 */
export function importanceSampleGGX(
  xi: readonly [number, number],
  roughness: number,
  N: [number, number, number],
): [number, number, number] {
  const a = roughness * roughness;
  const phi = 2 * PI * xi[0];
  const cosT = Math.sqrt((1 - xi[1]) / (1 + (a * a - 1) * xi[1]));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  // Tangent-space half-vector, then to world.
  const hx = Math.cos(phi) * sinT, hy = Math.sin(phi) * sinT, hz = cosT;
  const Nn = normalize(N);
  const [t, b] = tangentBasis(Nn);
  return normalize([
    t[0] * hx + b[0] * hy + Nn[0] * hz,
    t[1] * hx + b[1] * hy + Nn[1] * hz,
    t[2] * hx + b[2] * hy + Nn[2] * hz,
  ]);
}

const reflect = (v: [number, number, number], n: [number, number, number]): [number, number, number] => {
  const d = 2 * dot(v, n);
  return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
};

/**
 * Prefilter the environment for reflection direction `R` at `roughness`, by GGX-importance-sampling `envSample`
 * (a direction→LINEAR-colour function, e.g. `d => evaluateSkyColor(d, sky, sunDir)`). Assumes N = V = R (the standard
 * split-sum simplification), NdotL-weighted. At roughness 0 it returns ~`envSample(R)` (a mirror); higher roughness
 * blurs toward the hemisphere average.
 */
export function prefilterColor(
  envSample: (dir: [number, number, number]) => [number, number, number],
  R: [number, number, number],
  roughness: number,
  numSamples = 64,
): [number, number, number] {
  const N = normalize(R);
  const V = N;                       // N = V = R
  if (roughness <= 1e-4) return envSample(N);   // perfect mirror — skip the (degenerate) integral
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let i = 0; i < numSamples; i++) {
    const xi = hammersley(i, numSamples);
    const H = importanceSampleGGX(xi, roughness, N);
    const L = normalize(reflect([-V[0], -V[1], -V[2]], H));   // reflect V around H
    const NdotL = dot(N, L);
    if (NdotL <= 0) continue;
    const c = envSample(L);
    r += c[0] * NdotL; g += c[1] * NdotL; b += c[2] * NdotL;
    wsum += NdotL;
  }
  if (wsum <= 0) return envSample(N);
  return [r / wsum, g / wsum, b / wsum];
}

/** Smith GGX geometry term for IBL (k = a²/2). */
function geometrySmithIBL(NdotV: number, NdotL: number, roughness: number): number {
  const k = (roughness * roughness) / 2;
  const gv = NdotV / (NdotV * (1 - k) + k);
  const gl = NdotL / (NdotL * (1 - k) + k);
  return gv * gl;
}

/**
 * Integrate the environment-BRDF (the second split-sum term) for a given `NdotV` and `roughness`, returning the
 * (scale, bias) applied to F0: `F0 × scale + bias`. This is one texel of the BRDF LUT; it depends only on the BRDF,
 * not the environment. scale→1, bias→0 as roughness→0 at normal incidence.
 */
export function integrateBRDF(NdotV: number, roughness: number, numSamples = 256): [number, number] {
  const nv = Math.min(Math.max(NdotV, 1e-4), 1);
  const V: [number, number, number] = [Math.sqrt(1 - nv * nv), 0, nv];   // in tangent space, N = +Z
  const N: [number, number, number] = [0, 0, 1];
  let A = 0, B = 0;
  for (let i = 0; i < numSamples; i++) {
    const xi = hammersley(i, numSamples);
    const H = importanceSampleGGX(xi, roughness, N);
    const L = reflect([-V[0], -V[1], -V[2]], H);
    const NdotL = Math.max(L[2], 0);
    const NdotH = Math.max(H[2], 0);
    const VdotH = Math.max(dot(V, H), 0);
    if (NdotL > 0) {
      const G = geometrySmithIBL(nv, NdotL, roughness);
      const gVis = (G * VdotH) / (NdotH * nv);
      const Fc = Math.pow(1 - VdotH, 5);
      A += (1 - Fc) * gVis;
      B += Fc * gVis;
    }
  }
  return [A / numSamples, B / numSamples];
}

/**
 * Bake the full BRDF integration LUT: a `size × size` grid of (scale, bias), X = NdotV (0→1), Y = roughness (0→1).
 * Returns a flat Float32Array of length `size*size*2` (row-major, 2 channels). Baked once, reused every frame.
 */
export function generateBRDFLUT(size = 128, numSamples = 256): Float32Array {
  const out = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    const roughness = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const NdotV = (x + 0.5) / size;
      const [A, B] = integrateBRDF(NdotV, roughness, numSamples);
      const idx = (y * size + x) * 2;
      out[idx] = A; out[idx + 1] = B;
    }
  }
  return out;
}

/** Cube face indices in the conventional WebGPU/GL order (+X, -X, +Y, -Y, +Z, -Z). */
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * World-space direction for texel (u,v) ∈ [0,1]² on cube `face` (Y-up, matching the sky convention). This is the
 * mapping the GPU sky→cubemap render + prefilter use per face; provided here so the CPU reference and the WGSL agree.
 */
export function cubeFaceTexelDir(face: CubeFace, u: number, v: number): [number, number, number] {
  const a = 2 * u - 1;   // [-1,1]
  const b = 2 * v - 1;
  let d: [number, number, number];
  switch (face) {
    case 0: d = [1, -b, -a]; break;   // +X
    case 1: d = [-1, -b, a]; break;   // -X
    case 2: d = [a, 1, b]; break;     // +Y
    case 3: d = [a, -1, -b]; break;   // -Y
    case 4: d = [a, -b, 1]; break;    // +Z
    default: d = [-a, -b, -1]; break; // -Z
  }
  return normalize(d);
}
