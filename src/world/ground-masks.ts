// ── Procedural Ground — CPU-side weathering MASKS (procedural-ground.md §1 "one mask, two consumers") ──
//
// These are a faithful TypeScript MIRROR of the P2 weathering-mask WGSL in
//   src/renderer/3d/shaders/mesh3d-shaders.ts   (functions pg_hash21 / pg_vnoise ~line 401,
//   gr_fbm2 ~523, gr_edgeMask ~529, gr_wearMask ~540, gr_moistMask ~549, gr_dirtMask ~555).
//
// The MATERIAL consumes those masks per-fragment in the shader; the SCATTER pass (P5) consumes the SAME
// formulas here on the CPU to drive instance DENSITY — so a worn track that the shader draws brighter/
// smoother ALSO has fewer flowers, from ONE source of truth. If you touch the WGSL constants (the hash
// magic numbers, the fbm octave weights 0.65/0.35, the wear thresholds 0.52/0.9, the edge band 0.16),
// mirror the change HERE too or the two halves will drift and the world stops reading coherent.
//
// NOTE ON EXACTNESS: the GPU runs fp32 + hardware sin; JS runs fp64. The two won't be BIT-identical, but
// the FORMULAS + CONSTANTS match, so the fields agree to well within a pebble's width — which is all the
// shared-mask coherence needs. All masks return values in [0, 1].

/** WGSL `pg_hash21` — a 2D value hash in [0,1). fract(sin(dot(p,(12.9898,78.233)))*43758.5453). */
export function pgHash21(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** WGSL `pg_vnoise` — smoothstep-interpolated value noise over the integer hash grid, in [0,1]. */
export function pgVnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = pgHash21(ix, iy);
  const b = pgHash21(ix + 1, iy);
  const c = pgHash21(ix, iy + 1);
  const d = pgHash21(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}

/** WGSL `gr_fbm2` — 2-octave value noise (0.65 / 0.35), the organic low-freq usage field. */
export function fbm2(x: number, y: number): number {
  return pgVnoise(x, y) * 0.65 + pgVnoise(x * 2.3 + 7.1, y * 2.3 + 3.7) * 0.35;
}

/** GLSL-style smoothstep. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1e-12)));
  return t * t * (3 - 2 * t);
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** WGSL `gr_edgeMask` — `.edge` = 1 at the uv border → 0 interior; `.corner` = extreme near TWO borders. */
export function edgeMask(u: number, v: number): { edge: number; corner: number } {
  const dx = Math.min(u, 1 - u);
  const dy = Math.min(v, 1 - v);
  const band = 0.16;
  const edge = 1 - smoothstep(0, band, Math.min(dx, dy));
  const ex = 1 - smoothstep(0, band, dx);
  const ey = 1 - smoothstep(0, band, dy);
  return { edge: clamp01(edge), corner: clamp01(ex * ey) };
}

/** WGSL `gr_wearMask` — the walked-on field: low-freq usage noise OR an explicit wear PATH (center pc +
 *  radius pr in uv; pr 0 = noise only). High = worn/trodden → the material polishes it AND scatter thins. */
export function wearMask(u: number, v: number, path?: readonly [number, number, number] | null): number {
  const noiseWear = smoothstep(0.52, 0.9, fbm2(u * 2.2 + 1.3, v * 2.2 + 4.8));
  let pathWear = 0;
  if (path && path[2] > 1e-4) {
    const d = Math.hypot(u - path[0], v - path[1]);
    pathWear = 1 - smoothstep(path[2] * 0.5, path[2], d);
  }
  return clamp01(Math.max(noiseWear * 0.7, pathWear));
}

/** WGSL `gr_moistMask` — edge + low-freq noise, lifted in grout seams → moss / more grass+bush. */
export function moistMask(u: number, v: number, edge: number, groutMask = 1): number {
  const n = fbm2(u * 1.6 + 9.2, v * 1.6 + 2.1);
  const m = clamp01(edge * 0.6 + smoothstep(0.55, 0.95, n) * 0.7);
  return clamp01(m * (0.4 + 0.6 * groutMask));
}

/** WGSL `gr_dirtMask` — accumulation at edges/corners + noise → darker/rougher; suppresses vegetation. */
export function dirtMask(u: number, v: number, edge: number, corner: number): number {
  const n = fbm2(u * 3.1 + 4.4, v * 3.1 + 8.9);
  return clamp01(edge * 0.5 + corner * 0.5 + smoothstep(0.6, 0.95, n) * 0.5);
}
