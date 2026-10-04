/**
 * SKY DOME (visual-polish #9) — the CPU half of the stylised sky backdrop: the painted-cloud LAYOUT the shader reads,
 * the uniform packing, and a CPU reference of the gradient / glow / sun / moon terms (unit-tested; the WGSL in
 * sky-dome-pass.ts mirrors it).
 *
 * The dome is drawn by the focus-background pass (ArmatureBgPass mode 'sky') as a full-screen VIEW-DIRECTION sky, so
 * it sits at infinity: it can never be cut by the far plane, never needs sorting against cloud cards, and looks the
 * same in a single city, a tiled world, under HLOD or under the fog horizon (the backdrop is never fogged).
 *
 * CLOUDS are anime cumulus SILHOUETTES in a sky chart (x = azimuth × cos(base elevation), y = elevation, radians):
 * each cloud is a smooth union of 5 round lobes clipped by a flat base, toon-shaded per lobe (a lit cap toward the
 * light, a shaded underside, a thin bright rim). Two layers: low horizon BANKS (12 sectors, base ~1-2.5 deg) and a
 * higher layer of fair-weather cumulus (10 sectors, base ~13-36 deg) — the part a street-level view actually sees.
 * Each sector holds at most one cloud and a cloud stays within 0.68 of a sector width of its centre, so the shader
 * only tests the pixel's own sector and its nearer neighbour (12 lobe tests per layer, no loops over every cloud).
 */

import type { SkyDomeParams } from '../../types/armature-3d';

export type { SkyDomeParams };
type C3 = [number, number, number];

const TAU = Math.PI * 2;
/** Low horizon banks / high cumulus sector counts (the WGSL hard-codes the same numbers). */
export const SKY_CLOUD_SECTORS_LOW = 12;
export const SKY_CLOUD_SECTORS_HIGH = 14;
export const SKY_CLOUD_SECTORS = SKY_CLOUD_SECTORS_LOW + SKY_CLOUD_SECTORS_HIGH;
/** vec4 slots per cloud: a header (centre azimuth, base elevation, opacity, cos(base)) + 7 lobes (x, y, r, 0): five
 *  along the base and two smaller crown lumps riding on top. */
export const SKY_CLOUD_LOBES = 7;
/** Smooth-union width as a fraction of a lobe radius (small = crisp cusps between the puffs, the painted look). */
export const SKY_CLOUD_SMOOTH = 0.14;
export const SKY_CLOUD_VEC4_PER = 1 + SKY_CLOUD_LOBES;
/** Fraction of a sector width a cloud may reach from its centre (keeps the two-sector lookup exact). */
export const SKY_CLOUD_MAX_REACH = 0.68;

/** Deterministic 0..1 hash (integer mix — identical across runs, no Math.random). */
function h01(seed: number, a: number, b: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(a + 1, 0x85ebca77) ^ Math.imul(b + 7, 0xc2b2ae3d)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0; x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * The painted-cloud layout for `seed` at `coverage` 0..1: SKY_CLOUD_SECTORS × SKY_CLOUD_VEC4_PER vec4s (flat
 * Float32Array, low sectors first). An absent cloud has opacity 0. Coverage 0 = an empty sky.
 */
export function buildSkyDomeClouds(seed: number, coverage: number): Float32Array {
  const out = new Float32Array(SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER * 4);
  const cov = Math.max(0, Math.min(1, coverage));
  for (let s = 0; s < SKY_CLOUD_SECTORS; s++) {
    const low = s < SKY_CLOUD_SECTORS_LOW;
    const n = low ? SKY_CLOUD_SECTORS_LOW : SKY_CLOUD_SECTORS_HIGH;
    const i = low ? s : s - SKY_CLOUD_SECTORS_LOW;
    const H = (k: number): number => h01(seed, s, k);
    const sectorW = TAU / n;
    // presence: banks ring most of the horizon even at low cover; the high layer follows the slider more closely
    const p = low ? 0.45 + 0.5 * cov : 0.25 + 0.6 * cov;
    const present = cov > 0 && H(0) < p;
    const base = low ? 0.014 + H(2) * 0.028 : 0.23 + H(2) * 0.4;
    const cosB = Math.cos(base);
    const centre = (i + 0.5 + (H(1) - 0.5) * 0.4) * sectorW;
    const o = s * SKY_CLOUD_VEC4_PER * 4;
    out[o] = centre; out[o + 1] = base; out[o + 2] = present ? 0.82 + 0.18 * H(3) : 0; out[o + 3] = cosB;
    if (!present) continue;
    // half-extent along the chart x (flattened radians): banks wide and towering in the middle, high clouds smaller
    const maxReach = SKY_CLOUD_MAX_REACH * sectorW * cosB;
    const W = maxReach * (low ? 0.45 + 0.4 * H(4) : 0.4 + 0.45 * H(4));
    const tall = low ? 0.75 + 0.6 * H(5) : 0.6 + 0.4 * H(5);
    let reach = 0;
    const lobes: number[][] = [];
    const BASE = 5;
    for (let k = 0; k < BASE; k++) {
      const u = (k / (BASE - 1) - 0.5) * 2;                // -1..1 along the cloud
      const crown = 1 - Math.abs(u) * 0.6;                 // taller in the middle
      const r = W * (low ? 0.24 : 0.23) * (0.6 + 0.5 * crown) * (0.75 + 0.5 * H(10 + k)) * (k === 2 ? tall * 1.1 : Math.sqrt(tall));
      const x = u * W * 0.64 + (H(20 + k) - 0.5) * W * 0.14;
      // just above the base: the flat clip cuts each puff near its widest chord, so neighbours always meet at the base
      const y = r * (low ? 0.2 + 0.25 * H(30 + k) : 0.12 + 0.25 * H(30 + k));
      lobes.push([x, y, r]);
    }
    // two crown lumps on the shoulders of the middle puff: the bumpy cauliflower top of a cumulus
    for (const side of [-1, 1]) {
      const m = lobes[2], nb = lobes[2 + side];
      const r = (m[2] * 0.5 + nb[2] * 0.25) * (0.75 + 0.35 * H(40 + side));
      const x = (m[0] + nb[0]) * 0.5 + side * r * 0.15;
      const y = Math.max(m[1], nb[1]) + Math.max(m[2], nb[2]) * (0.45 + 0.3 * H(42 + side)) - r * 0.3;
      lobes.push([x, y, r]);
    }
    for (const l of lobes) reach = Math.max(reach, Math.abs(l[0]) + l[2]);
    const k = reach > maxReach ? maxReach / reach : 1;   // never reach past the neighbour sector
    for (let l = 0; l < SKY_CLOUD_LOBES; l++) {
      const q = o + (1 + l) * 4;
      out[q] = lobes[l][0] * k; out[q + 1] = lobes[l][1] * k; out[q + 2] = lobes[l][2] * k; out[q + 3] = 0;
    }
  }
  return out;
}

const wrapPi = (a: number): number => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const smin = (a: number, b: number, k: number): number => { const h = Math.max(k - Math.abs(a - b), 0) / Math.max(k, 1e-6); return Math.min(a, b) - h * h * k * 0.25; };

/** CPU mirror of the shader's cloud SDF at (azimuth, elevation) in radians (azimuth = atan2(z, x)): the signed
 *  angular distance to the nearest cloud silhouette (< 0 inside) over the two layers. For tests / tooling. */
export function skyDomeCloudDistance(layout: Float32Array, az: number, el: number): number {
  let best = 1e9;
  for (const [off, n] of [[0, SKY_CLOUD_SECTORS_LOW], [SKY_CLOUD_SECTORS_LOW, SKY_CLOUD_SECTORS_HIGH]] as const) {
    const a = ((az % TAU) + TAU) % TAU;
    const sf = a / TAU * n, i0 = Math.floor(sf) % n, f = sf - Math.floor(sf);
    const i1 = f > 0.5 ? (i0 + 1) % n : (i0 + n - 1) % n;
    for (const i of [i0, i1]) {
      const o = (off + i) * SKY_CLOUD_VEC4_PER * 4;
      if (layout[o + 2] <= 0) continue;
      const x = wrapPi(a - layout[o]) * layout[o + 3], y = el - layout[o + 1];
      let d = 1e9;
      for (let l = 0; l < SKY_CLOUD_LOBES; l++) {
        const q = o + (1 + l) * 4, r = layout[q + 2];
        d = smin(d, Math.hypot(x - layout[q], y - layout[q + 1]) - r, r * SKY_CLOUD_SMOOTH);
      }
      best = Math.min(best, Math.max(d, -y));
    }
  }
  return best;
}

/** The CPU reference of the dome's sky colour (gradient + horizon glow + sun + moon; no stars / clouds) for a view
 *  direction. Mirrors skyColor() in the WGSL. */
export function evaluateSkyDome(dir: readonly [number, number, number], p: SkyDomeParams): C3 {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const dx = dir[0] / len, dy = dir[1] / len, dz = dir[2] / len;
  const el = Math.asin(Math.max(-1, Math.min(1, dy)));
  const c: C3 = [0, 0, 0];
  if (dy >= 0) {
    const t = 1 - Math.pow(1 - dy, p.gradientBias);
    for (let i = 0; i < 3; i++) c[i] = p.horizon[i] + (p.zenith[i] - p.horizon[i]) * t;
  } else {
    const x = Math.min(1, -el / 0.2), t = x * x * (3 - 2 * x);   // smoothstep: a soft haze under the horizon
    for (let i = 0; i < 3; i++) c[i] = p.horizon[i] + (p.ground[i] - p.horizon[i]) * t;
  }
  const g = p.glowAmount * 0.42 * Math.exp(-Math.abs(el) / Math.max(1e-3, p.glowHeight));
  for (let i = 0; i < 3; i++) c[i] += p.glowColor[i] * g;
  // sun: crisp disc + halo, and a wide warm band along the horizon on the sun side
  const sd = dx * p.sunDir[0] + dy * p.sunDir[1] + dz * p.sunDir[2];
  const sAng = Math.acos(Math.max(-1, Math.min(1, sd)));
  const sunH = Math.hypot(p.sunDir[0], p.sunDir[2]) || 1, dirH = Math.hypot(dx, dz) || 1;
  const side = Math.max(0, (dx * p.sunDir[0] + dz * p.sunDir[2]) / (sunH * dirH));
  const band = p.sunHalo * 0.22 * side * side * side * Math.exp(-Math.max(el, 0) / 0.18);
  const disc = el > -0.01 && sAng < 0.03 ? p.sunDisc * 1.6 : 0;
  const halo = p.sunHalo * (0.55 * Math.exp(-sAng / 0.08) + 0.2 * Math.exp(-sAng / 0.35));
  for (let i = 0; i < 3; i++) c[i] += p.sunColor[i] * (band + disc + halo);
  // moon: a soft halo, then the lit disc over it (its face is 1.15 x the moon colour at the centre)
  if (p.moon > 0) {
    const md = dx * p.moonDir[0] + dy * p.moonDir[1] + dz * p.moonDir[2];
    const mAng = Math.acos(Math.max(-1, Math.min(1, md)));
    const mHalo = p.moonHalo * (0.45 * Math.exp(-Math.max(0, mAng - p.moonSize) / (p.moonSize * 2)) + 0.15 * Math.exp(-mAng / 0.3));
    for (let i = 0; i < 3; i++) c[i] += p.moonColor[i] * mHalo * p.moon;
    if (mAng < p.moonSize) for (let i = 0; i < 3; i++) c[i] += (p.moonColor[i] * 1.15 - c[i]) * p.moon;
  }
  return c;
}

/** Uniform layout (vec4 slots) — keep in step with SkyU in sky-dome-pass.ts. */
export const SKY_DOME_HEADER_VEC4 = 17;
export const SKY_DOME_UNIFORM_FLOATS = (SKY_DOME_HEADER_VEC4 + SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER) * 4;

/** The camera basis the dome needs (right / up / forward unit vectors + tan of the half FOVs). */
export interface SkyDomeView {
  right: C3; up: C3; fwd: C3; tanX: number; tanY: number;
}

/** A camera basis from eye / target / up + the vertical FOV (radians) and aspect. Orthographic cameras pass a
 *  nominal FOV (parallel rays would paint one flat colour). */
export function skyDomeView(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>, fovY: number, aspect: number): SkyDomeView {
  let f: C3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1; f = [f[0] / fl, f[1] / fl, f[2] / fl];
  let r: C3 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  let rl = Math.hypot(r[0], r[1], r[2]);
  if (rl < 1e-6) { r = [1, 0, 0]; rl = 1; }   // looking straight up / down: any right vector
  r = [r[0] / rl, r[1] / rl, r[2] / rl];
  const u: C3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const tanY = Math.tan(Math.max(0.05, Math.min(3.0, fovY)) * 0.5);
  return { right: r, up: u, fwd: f, tanX: tanY * Math.max(0.1, aspect), tanY };
}

/** Pack the per-frame header (slots 0..16) of the dome uniforms into `out` (length ≥ SKY_DOME_HEADER_VEC4 × 4). */
export function packSkyDomeHeader(out: Float32Array, p: SkyDomeParams, v: SkyDomeView, width: number, height: number, time: number): void {
  const put = (slot: number, a: number, b: number, c: number, d: number): void => { const o = slot * 4; out[o] = a; out[o + 1] = b; out[o + 2] = c; out[o + 3] = d; };
  const c3 = (slot: number, c: readonly number[], w: number): void => put(slot, c[0], c[1], c[2], w);
  c3(0, v.right, v.tanX);
  c3(1, v.up, v.tanY);
  c3(2, v.fwd, time);
  put(3, width, height, 2 * v.tanY / Math.max(1, height), p.gradientBias);
  c3(4, p.zenith, p.stars);
  c3(5, p.horizon, p.glowAmount);
  c3(6, p.ground, p.glowHeight);
  c3(7, p.glowColor, p.clouds);
  c3(8, p.sunDir, p.sunDisc);
  c3(9, p.sunColor, p.sunHalo);
  c3(10, p.moonDir, p.moon);
  c3(11, p.moonColor, p.moonSize);
  c3(12, p.cloudLit, p.moonHalo);
  c3(13, p.cloudShade, p.cloudRimAmount);
  c3(14, p.cloudRim, p.cloudDrift);
  c3(15, p.cloudLightDir, 0);
  c3(16, p.cloudGlow, 0);
}
