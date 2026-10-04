/**
 * Procedural sky model — the analytic dome that IS the environment (it lights surfaces AND is what they reflect).
 * See docs/specs/environment-and-reflections.md (P1). This is the CPU reference: a pure, testable evaluation of the
 * sky colour for any view direction, plus an equirectangular BAKE that feeds the existing SH-IBL path
 * (renderer-3d.setEnvironmentMap3D → _computeSHCoeffs) so ambient lighting becomes SKY-DRIVEN and coherent — with no
 * new shader. The eventual GPU sky pass + prefiltered-specular cubemap (P1c) mirror THIS same math in WGSL.
 *
 * Convention matches _computeSHCoeffs exactly: Y-up, direction from (theta,phi) where theta measures DOWN from +Y
 * (0 = zenith, π = nadir) and phi = atan2(x, z). Colours here are LINEAR; the bake encodes to sRGB bytes because the
 * SH integrator decodes with `(v/255)**2.2`.
 */

/** Stylized/analytic sky parameters (a "preset"). All colours LINEAR 0..1. `model` picks the eval strategy. */
export interface ProceduralSkyParams {
  /** 'gradient' = stylized 3-stop dome (today's look, art-directable). 'physical' = P1c atmospheric scattering (falls
   *  back to the gradient eval until that lands, so the field is forward-declared but behaves as gradient for now). */
  model: 'gradient' | 'physical';
  /** Colour looking straight up. */
  zenith: [number, number, number];
  /** Colour at the horizon band. */
  horizon: [number, number, number];
  /** Colour looking straight down (the ground/backdrop hemisphere). */
  ground: [number, number, number];
  /** Sun disk + halo tint (usually warm/bright). */
  sunColor: [number, number, number];
  /** Angular RADIUS of the bright sun disk, degrees. */
  sunSizeDeg: number;
  /** Strength of the soft glow around the sun (0 = none). */
  sunHalo: number;
  /** Horizon→zenith curve. >1 keeps the sky saturated higher up; <1 spreads the horizon colour. */
  gradientBias: number;
  /** Overall sky brightness multiplier (scales what the bake feeds into ambient). */
  intensity: number;
}

/** A neutral daytime preset — a sensible default that approximates today's stylized daylight look. */
export const DEFAULT_SKY: ProceduralSkyParams = {
  model: 'gradient',
  zenith:   [0.16, 0.34, 0.72],
  horizon:  [0.68, 0.76, 0.86],
  ground:   [0.18, 0.18, 0.20],
  sunColor: [1.0, 0.94, 0.82],
  sunSizeDeg: 3.0,
  sunHalo: 0.35,
  gradientBias: 0.55,
  intensity: 1.0,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Fill a possibly-partial sky blob with DEFAULT_SKY, deep-copying arrays so callers never alias the default. */
export function normalizeSkyParams(raw?: Partial<ProceduralSkyParams> | null): ProceduralSkyParams {
  const d = DEFAULT_SKY;
  return {
    model: raw?.model ?? d.model,
    zenith:   raw?.zenith   ? [...raw.zenith]   as [number, number, number] : [...d.zenith]   as [number, number, number],
    horizon:  raw?.horizon  ? [...raw.horizon]  as [number, number, number] : [...d.horizon]  as [number, number, number],
    ground:   raw?.ground   ? [...raw.ground]   as [number, number, number] : [...d.ground]   as [number, number, number],
    sunColor: raw?.sunColor ? [...raw.sunColor] as [number, number, number] : [...d.sunColor] as [number, number, number],
    sunSizeDeg:   raw?.sunSizeDeg   ?? d.sunSizeDeg,
    sunHalo:      raw?.sunHalo      ?? d.sunHalo,
    gradientBias: raw?.gradientBias ?? d.gradientBias,
    intensity:    raw?.intensity    ?? d.intensity,
  };
}

/**
 * Evaluate the sky colour (LINEAR RGB) for a view direction. `sunDir` points TOWARD the sun (i.e. the NEGATED
 * directional-light travel direction). Direction need not be normalized. The disk can exceed 1 (HDR-ish) toward the sun.
 */
export function evaluateSkyColor(
  dir: readonly [number, number, number],
  sky: ProceduralSkyParams,
  sunDir: readonly [number, number, number],
): [number, number, number] {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const dy = Math.max(-1, Math.min(1, dir[1] / len));
  const dx = dir[0] / len, dz = dir[2] / len;

  // Vertical gradient: horizon → zenith above, horizon → ground below.
  let r: number, g: number, b: number;
  if (dy >= 0) {
    const t = Math.pow(dy, sky.gradientBias);
    r = lerp(sky.horizon[0], sky.zenith[0], t);
    g = lerp(sky.horizon[1], sky.zenith[1], t);
    b = lerp(sky.horizon[2], sky.zenith[2], t);
  } else {
    const t = Math.pow(-dy, sky.gradientBias);
    r = lerp(sky.horizon[0], sky.ground[0], t);
    g = lerp(sky.horizon[1], sky.ground[1], t);
    b = lerp(sky.horizon[2], sky.ground[2], t);
  }

  // Sun: a bright disk plus a soft halo, both along `sunDir`.
  const sunLen = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
  const sd = (dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2]) / sunLen;   // cos(angle to sun)
  const cosDisk = Math.cos((sky.sunSizeDeg * Math.PI) / 180);
  const cosInner = Math.cos((sky.sunSizeDeg * 0.55 * Math.PI) / 180);
  const disk = sd <= cosDisk ? 0 : sd >= cosInner ? 1 : (sd - cosDisk) / (cosInner - cosDisk);
  const cosHalo = Math.cos((sky.sunSizeDeg * 8 * Math.PI) / 180);
  const haloT = sd <= cosHalo ? 0 : clamp01((sd - cosHalo) / (1 - cosHalo));
  const halo = Math.pow(haloT, 4) * sky.sunHalo;
  const sun = disk * 6 + halo;                 // disk is punchy; halo is a gentle bloom
  r += sky.sunColor[0] * sun;
  g += sky.sunColor[1] * sun;
  b += sky.sunColor[2] * sun;

  return [r * sky.intensity, g * sky.intensity, b * sky.intensity];
}

/**
 * Cosine-weighted IRRADIANCE the baked sky delivers to a surface with normal `n` — the value the SH-IBL diffuse path
 * (`evalSHIrradiance`) approximates, in the SAME units: for a uniform sky of radiance 1 it returns PI, and the mesh
 * shader multiplies it straight onto albedo (no 1/PI). Colours are clamped to 0..1 like the sRGB bake. Hosts use it
 * to NORMALISE a bake's `intensity` against a flat ambient they already tuned (world-manager's city sky lighting).
 */
export function skyIrradiance(
  sky: ProceduralSkyParams,
  sunDir: readonly [number, number, number],
  n: readonly [number, number, number],
  width = 32,
  height = 16,
): [number, number, number] {
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx0 = n[0] / nl, ny0 = n[1] / nl, nz0 = n[2] / nl;
  const out: [number, number, number] = [0, 0, 0];
  for (let py = 0; py < height; py++) {
    const theta = Math.PI * (py + 0.5) / height;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    const dw = sinT * (Math.PI / height) * (2 * Math.PI / width);
    for (let px = 0; px < width; px++) {
      const phi = 2 * Math.PI * (px + 0.5) / width;
      const dx = sinT * Math.sin(phi), dy = cosT, dz = sinT * Math.cos(phi);
      const cosN = dx * nx0 + dy * ny0 + dz * nz0;
      if (cosN <= 0) continue;
      const c = evaluateSkyColor([dx, dy, dz], sky, sunDir);
      const w = cosN * dw;
      out[0] += clamp01(c[0]) * w; out[1] += clamp01(c[1]) * w; out[2] += clamp01(c[2]) * w;
    }
  }
  return out;
}

const lum = (c: readonly [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The bake `intensity` at which sky IBL delivers the SAME fill energy as a flat ambient of `ambient` (colour ×
 * intensity, i.e. what the shader's no-IBL path multiplies onto albedo). Energy is matched on the mean luminance of
 * an UP-facing and the (azimuth-averaged) SIDE-facing irradiance, so the sky REDISTRIBUTES the tuned fill — tops a
 * little brighter, walls a little dimmer, both sky-tinted — instead of ADDING PI-times more (the raw SH irradiance
 * is PI x radiance and the shader applies it without 1/PI, so an un-normalised bake of a pale day sky at
 * intensity ~1 lit matte surfaces ~3x brighter than the flat ambient: the white-out city bug).
 */
export function ambientMatchedSkyIntensity(
  sky: ProceduralSkyParams,
  sunDir: readonly [number, number, number],
  ambient: readonly [number, number, number],
  opts: { gain?: number; maxUp?: number } = {},
): number {
  const up = lum(skyIrradiance(sky, sunDir, [0, 1, 0]));
  let side = 0;
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) side += lum(skyIrradiance(sky, sunDir, d)) * 0.25;
  const e = 0.5 * (up + side);
  const target = lum(ambient);
  if (!(e > 1e-5) || !(target >= 0)) return 0;
  // gain: how much brighter than the flat fill the sky may light (1 = same energy). maxUp: a CEILING on the up-facing
  // fill luminance, so a bright sky can never push pale ground past the tone range (bloom then clips it white).
  let k = (target / e) * Math.max(0, opts.gain ?? 1);
  if (opts.maxUp != null && up * k > opts.maxUp) k = Math.max(0, opts.maxUp) / up;
  return k;
}

/** Structural RGBA image (compatible with the fields `_computeSHCoeffs` reads off an `ImageData`). */
export interface EquirectPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Bake the procedural sky into an equirectangular sRGB image, matching `_computeSHCoeffs`'s pixel→direction mapping
 * (row → theta down from +Y, col → phi). The result feeds `setEnvironmentMap3D` to produce sky-driven SH ambient.
 * Low res is plenty — SH captures only the first 9 low-frequency bands.
 */
export function bakeSkyEquirect(
  sky: ProceduralSkyParams,
  sunDir: readonly [number, number, number],
  width = 64,
  height = 32,
): EquirectPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  const invGamma = 1 / 2.2;
  for (let py = 0; py < height; py++) {
    const theta = Math.PI * (py + 0.5) / height;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let px = 0; px < width; px++) {
      const phi = 2 * Math.PI * (px + 0.5) / width;
      const nx = sinT * Math.sin(phi);
      const ny = cosT;
      const nz = sinT * Math.cos(phi);
      const c = evaluateSkyColor([nx, ny, nz], sky, sunDir);
      const pi = (py * width + px) * 4;
      data[pi]     = Math.round(clamp01(Math.pow(clamp01(c[0]), invGamma)) * 255);
      data[pi + 1] = Math.round(clamp01(Math.pow(clamp01(c[1]), invGamma)) * 255);
      data[pi + 2] = Math.round(clamp01(Math.pow(clamp01(c[2]), invGamma)) * 255);
      data[pi + 3] = 255;
    }
  }
  return { width, height, data };
}
