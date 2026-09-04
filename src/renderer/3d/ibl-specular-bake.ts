import { type ProceduralSkyParams, evaluateSkyColor } from './procedural-sky';
import { prefilterColor, generateBRDFLUT, cubeFaceTexelDir, type CubeFace } from './ibl-prefilter';

/**
 * CPU bake of the split-sum specular IBL resources (docs/specs/environment-and-reflections.md, P1b) from a procedural
 * sky. We bake on the CPU (reusing the TESTED `prefilterColor`/`generateBRDFLUT`/`cubeFaceTexelDir`) rather than with
 * GPU render/compute passes — the environment is event-driven (re-baked only when the sky changes), and CPU baking
 * avoids the render-to-cubemap framebuffer plumbing entirely. The renderer just `writeTexture`s these bytes.
 *
 * Output is sRGB-encoded RGBA8 (the mesh shader samples with an sRGB-view cube so the GPU linearizes on read),
 * matching how the SH diffuse bake already treats the sky as sRGB LDR.
 *
 * Mip chain = roughness levels: mip 0 = roughness 0 (a sharp mirror — a direct sky sample), each higher mip a rougher
 * (blurrier) convolution, so a mesh samples `mip = roughness × (mipCount-1)` along its reflection vector.
 */

/** One baked cube face at one mip (roughness) level. `data` is sRGB RGBA8, row-major, `size×size`. */
export interface BakedCubeFaceMip {
  face: CubeFace;
  mip: number;
  size: number;
  data: Uint8ClampedArray;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const toSrgbByte = (linear: number): number => Math.round(clamp01(Math.pow(clamp01(linear), 1 / 2.2)) * 255);

/**
 * Bake the full prefiltered specular cube: for every face and every mip, convolve the sky with the GGX lobe at that
 * mip's roughness. `baseSize` is the mip-0 face resolution; `mipCount` roughness levels down to 1×1. `samples` is the
 * GGX sample count for the rough mips (mip 0 is a free direct sample). Returns faces×mips baked images.
 */
export function bakePrefilteredCube(
  sky: ProceduralSkyParams,
  sunDir: [number, number, number],
  baseSize = 32,
  mipCount = 5,
  samples = 48,
): BakedCubeFaceMip[] {
  const out: BakedCubeFaceMip[] = [];
  const sample = (d: [number, number, number]): [number, number, number] => evaluateSkyColor(d, sky, sunDir);
  for (let mip = 0; mip < mipCount; mip++) {
    const size = Math.max(1, baseSize >> mip);
    const roughness = mipCount > 1 ? mip / (mipCount - 1) : 0;
    for (let face = 0 as CubeFace; face < 6; face = (face + 1) as CubeFace) {
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dir = cubeFaceTexelDir(face, (x + 0.5) / size, (y + 0.5) / size);
          const c = roughness <= 1e-4 ? sample(dir) : prefilterColor(sample, dir, roughness, samples);
          const pi = (y * size + x) * 4;
          data[pi] = toSrgbByte(c[0]); data[pi + 1] = toSrgbByte(c[1]); data[pi + 2] = toSrgbByte(c[2]); data[pi + 3] = 255;
        }
      }
      out.push({ face, mip, size, data });
    }
  }
  return out;
}

/**
 * Bake the BRDF integration LUT as RGBA8 bytes (R = scale, G = bias, indexed X=NdotV, Y=roughness). The LUT is
 * environment-independent, so it's baked ONCE (not per sky change). `size×size`, row-major RGBA.
 */
export function bakeBRDFLUTBytes(size = 128, samples = 256): Uint8ClampedArray {
  const lut = generateBRDFLUT(size, samples);   // Float32 [scale, bias] pairs, already in [0,1]
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(clamp01(lut[i * 2]) * 255);
    data[i * 4 + 1] = Math.round(clamp01(lut[i * 2 + 1]) * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Number of mip levels a `baseSize` cube produces down to 1×1 (for allocating the GPU texture). */
export function cubeMipCount(baseSize: number): number {
  return Math.floor(Math.log2(Math.max(1, baseSize))) + 1;
}
