/**
 * DitherEngine — GPU compute + WASM post-process that applies dithering effects
 * to a raster texture. Supports ordered dithering (Bayer, halftone, blue noise)
 * via GPU compute shaders and error diffusion (Floyd-Steinberg, Atkinson, etc.)
 * via Rust/WASM. Designed as a non-destructive effect in the compositor pipeline.
 *
 * Architecture:
 *   Ordered dithering: reads the input texture, applies a chosen threshold map
 *   per-pixel, writes result. Fully GPU-parallelized — no pixel dependencies.
 *
 *   Error diffusion: reads GPU texture → CPU buffer → calls Rust/WASM function
 *   (sequential scanline processing) → writes result back to GPU texture.
 *   Async operation — requires `await applyAsync()` instead of `apply()`.
 *
 * Supported algorithms:
 *   GPU (ordered):  Bayer, Halftone (14 screen shapes, see HALFTONE_SHAPES), Blue Noise, Noise
 *   WASM (diffusion): Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Sierra, Sierra Lite
 */

import { applyErrorDiffusion, isWasmReady, type ErrorDiffusionAlgorithm } from '../../../wasm/wasm-bindings';

// ─── Types ──────────────────────────────────────────────────────

/** Dithering algorithm — ordered (GPU) or error diffusion (WASM). */
// Shared WGSL: duotone / invert / strength color mapping — was copy-pasted into all 4 dither shaders
// (audit B4). Every dither shader binds the same params layout (params[4]=mode/invert/tintOp,
// params[5]=fg, params[6]=bg), so the helper interpolates verbatim.
const WGSL_APPLY_COLOR_MAPPING = /* wgsl */ `
      // strength = the dither Strength; fade = the edge-fade multiplier (edgeState x, 1 = none); duoSmooth = the
      // duotone level before quantizing (the flat tone the dot pattern averages to; unused in quantize mode).
      fn applyColorMapping(original: vec3<f32>, dithered: vec3<f32>, srcAlpha: f32, strength: f32, fade: f32, duoSmooth: f32) -> vec4<f32> {
        let colorMode = params[4].x;
        let invertP = params[4].y > 0.5;
        let tintOp = params[4].z;
        let fg = params[5];
        let bg = params[6];
        let k = strength * fade;
        var result = mix(original, dithered, k);
        var outA = srcAlpha;
        if (colorMode > 0.5) {
          // Duotone (2026-10-09: Strength and Tint are distinct). The dithered value encodes the spatial pattern
          // (0 or 1 at 1-bit; duotoneBias already sets the coverage). Strength = how much of the PATTERN shows:
          // 0 = the flat two-colour tone at that coverage, 1 = crisp dots. Tint = how strongly the two colours
          // replace the original artwork. The edge fade dissolves back to the original, as in quantize mode.
          let t = mix(duoSmooth, dot(dithered, vec3<f32>(0.299, 0.587, 0.114)), strength);
          let duotone = mix(bg.rgb, fg.rgb, t);
          let duotoneA = mix(bg.a, fg.a, t);
          let kt = tintOp * fade;
          result = mix(original, duotone, kt);
          outA = mix(srcAlpha, duotoneA, kt);
        } else if (invertP) {
          let inverted = vec3<f32>(1.0) - dithered;
          result = mix(original, inverted, k);
        }
        return vec4<f32>(result, outA);
      }
`;

// Shared WGSL: edge/boundary effects (2026-09-15; content distance = jump flood since 2026-10-09). `edgeFactor`
// turns the distance to the layer's CONTENT edge (alpha boundary) into a 0→1 factor over `radius` px. The distance
// comes from a jump-flood pass the engine runs before the dither dispatch (WGSL_JFA_* below, recordEdgeFlood): it
// leaves, per texel of the distance DOMAIN, the nearest unpainted texel. Every dither shader binds srcTex at
// @binding(0), the seeds at @binding(7) and the same params layout (params[7] = edgeWidth / edgeFade / edgeShrink /
// edgeDensity, params[9] = the domain), so the helpers interpolate verbatim — same pattern as
// WGSL_APPLY_COLOR_MAPPING above.
const WGSL_EDGE_HELPERS = /* wgsl */ `
      // Nearest unpainted texel per domain texel (x | y << 16, domain-relative; 0xFFFFFFFF = none in reach).
      @group(0) @binding(7) var edgeSeeds: texture_2d<u32>;

      // Per-cell hash for density dropout (PCG-style; named edge* to avoid colliding with the
      // noise shader's own rand helpers).
      fn edgeHashU(input: u32) -> u32 {
        var state = input * 747796405u + 2891336453u;
        let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
        return (word >> 22u) ^ word;
      }
      fn edgeCellRand(cell: vec2<i32>, seed: u32) -> f32 {
        let h = edgeHashU(u32(cell.x + 32768) + edgeHashU(u32(cell.y + 32768) + edgeHashU(seed)));
        return f32(h) / 4294967295.0;
      }

      // 0 at the content (alpha) boundary -> 1 at >= radius px inside. "Unpainted" = alpha < 0.004 (the same
      // cutoff the dither early-out uses): alpha PRESENCE, not value - a half-opacity wash reads as solid interior.
      // The texture border is NOT a boundary. Distance is measured from the boundary BETWEEN texels (centre
      // distance - 0.5); the ramp 1 - (1 - t)^1.5 (t = distance / radius) is the old 25-tap coverage profile at a
      // straight edge, without its steps. params[9] = the seeds domain [x0, y0, x1, y1] in texels (max-exclusive).
      fn edgeFactor(coords: vec2<i32>, radius: f32) -> f32 {
        let o = vec2<i32>(params[9].xy);
        let l = clamp(coords - o, vec2<i32>(0), vec2<i32>(params[9].zw) - o - vec2<i32>(1));
        let v = textureLoad(edgeSeeds, l, 0).x;
        if (v == 0xFFFFFFFFu) { return 1.0; }
        let dv = vec2<f32>(vec2<i32>(i32(v & 0xFFFFu), i32(v >> 16u)) - l);
        let t = clamp((sqrt(dot(dv, dv)) - 0.5) / radius, 0.0, 1.0);
        let u = 1.0 - t;
        return 1.0 - u * sqrt(u);
      }

      // 0 at the CANVAS border → 1 at >= radius px inside it. Pure arithmetic — no taps.
      fn edgeFactorCanvas(coords: vec2<i32>, radius: f32) -> f32 {
        let dim = vec2<i32>(textureDimensions(srcTex));
        let dist = f32(min(min(coords.x, coords.y), min(dim.x - 1 - coords.x, dim.y - 1 - coords.y)));
        return clamp(dist / radius, 0.0, 1.0);
      }

      // Mode-dispatched edge factor. params[3].x = mode (0 content, 1 canvas, 2 both).
      fn edgeRaw(coords: vec2<i32>, radius: f32) -> f32 {
        let mode = params[3].x;
        if (mode < 0.5) {          // content: the painted alpha boundary (nearest no-paint gap)
          return edgeFactor(coords, radius);
        } else if (mode < 1.5) {   // canvas: the texture border only (no distance read; the engine runs no jump flood)
          return edgeFactorCanvas(coords, radius);
        }
        return min(edgeFactor(coords, radius), edgeFactorCanvas(coords, radius));   // nearest wins
      }

      // Edge factor at an arbitrary point (a pattern CELL CENTRE, possibly out of bounds) — used by
      // the density dropout so a whole dot lives or dies from ONE evaluation (no half-cut dots).
      fn edgeAt(coords: vec2<i32>, radius: f32) -> f32 {
        let dim = vec2<i32>(textureDimensions(srcTex));
        return edgeRaw(clamp(coords, vec2<i32>(0), dim - vec2<i32>(1)), radius);
      }

      // Shared per-pixel edge state: x = strength multiplier (fade), y = shrink NEARNESS
      // (0 deep inside → |shrink| at the boundary), z = the raw edge factor.
      // params[7] = (width, fade, shrink SIGNED -1..1, density).
      fn edgeState(coords: vec2<i32>) -> vec3<f32> {
        let ep = params[7];
        if (ep.x < 0.5 || (ep.y + abs(ep.z) + ep.w) < 0.001) { return vec3<f32>(1.0, 0.0, 1.0); }
        let e = edgeRaw(coords, ep.x);
        return vec3<f32>(mix(1.0, e, ep.y), (1.0 - e) * abs(ep.z), e);
      }

      // Shrink landing point (rev 4, 2026-09-16 — direction-aware): POSITIVE shrink always
      // removes the DOT phase — duotoneBias > 0.5 means the round dots are the BG phase, so the
      // bias must ramp toward 1 (all FG) for them to shrink; <= 0.5 ramps toward 0 as before.
      // NEGATIVE shrink targets the opposite extreme: dots GROW into a solid rim (the outline
      // effect). Bias exactly 0.5 keeps the classic toward-0 behavior.
      fn shrinkTargetBias(duotoneBias: f32) -> f32 {
        let tS = select(0.0, 1.0, duotoneBias > 0.5);
        return select(tS, 1.0 - tS, params[7].z < 0.0);
      }
      // Quantize-mode landing value: positive → paper-white, negative → ink-black.
      fn shrinkTargetValue() -> f32 {
        return select(1.0, 0.0, params[7].z < 0.0);
      }
`;

// Shared WGSL: the dispatch REGION (2026-10-08, per-layer dither cache). params[8] = [x0, y0, x1, y1] in texels,
// max-exclusive; a dispatch covers only the region and `gid` below is the ABSOLUTE texel, so every pattern / edge /
// cell computation is the same as in a whole-texture dispatch (the region of a full pass is [0, 0, w, h]).
const WGSL_REGION_HEAD = /* wgsl */ `let gid = vec3<u32>(gidIn.x + u32(params[8].x), gidIn.y + u32(params[8].y), 0u);
        if (gid.x >= u32(params[8].z) || gid.y >= u32(params[8].w)) { return; }
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }`;

// Content-edge DISTANCE (2026-10-09): a jump flood (JFA) over a DOMAIN rect of the source. Seeds = the unpainted
// texels (alpha < 0.004); after the passes every domain texel holds its nearest seed as x | y << 16, relative to the
// domain origin (0xFFFFFFFF = none found). Two r32uint scratch textures ping-pong; params are one 16-byte slot per
// pass in jfaParamsBuf (bound at a 256-byte offset). The step schedule is a pure function of the edge width
// (ditherEdgeJfaSteps), never of the domain - see DitherEngine.rectReach for why that makes a region pass exact.
const WGSL_JFA_INIT = /* wgsl */ `
      // JFA-INIT: every UNPAINTED domain texel is its own seed.
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var seedsOut: texture_storage_2d<r32uint, write>;
      @group(0) @binding(2) var<uniform> jp: vec4<i32>;   // domain origin (x, y) in source texels, domain size (w, h)
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let l = vec2<i32>(gid.xy);
        if (l.x >= jp.z || l.y >= jp.w) { return; }
        let painted = textureLoad(srcTex, l + jp.xy, 0).a >= 0.004;
        let v = select(u32(l.x) | (u32(l.y) << 16u), 0xFFFFFFFFu, painted);
        textureStore(seedsOut, l, vec4<u32>(v, 0u, 0u, 0u));
      }
`;
const WGSL_JFA_STEP = /* wgsl */ `
      // JFA-STEP: keep the nearest of the 3x3 candidates one step apart (ties: the first in dy, dx order).
      // Reads outside the domain are skipped (outside the texture there is no seed: its border is not an edge).
      @group(0) @binding(0) var seedsIn: texture_2d<u32>;
      @group(0) @binding(1) var seedsOut: texture_storage_2d<r32uint, write>;
      @group(0) @binding(2) var<uniform> jp: vec4<i32>;   // domain size (w, h), step, unused
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let p = vec2<i32>(gid.xy);
        if (p.x >= jp.x || p.y >= jp.y) { return; }
        var best = 0xFFFFFFFFu;
        var bestD = 0xFFFFFFFFu;
        for (var dy = -1; dy <= 1; dy = dy + 1) {
          for (var dx = -1; dx <= 1; dx = dx + 1) {
            let q = p + vec2<i32>(dx, dy) * jp.z;
            if (q.x < 0 || q.y < 0 || q.x >= jp.x || q.y >= jp.y) { continue; }
            let v = textureLoad(seedsIn, q, 0).x;
            if (v == 0xFFFFFFFFu) { continue; }
            let d = vec2<u32>(vec2<i32>(abs(i32(v & 0xFFFFu) - p.x), abs(i32(v >> 16u) - p.y)));
            let dd = d.x * d.x + d.y * d.y;
            if (dd < bestD) { bestD = dd; best = v; }
          }
        }
        textureStore(seedsOut, p, vec4<u32>(best, 0u, 0u, 0u));
      }
`;

/** Widest edge band (px) the engine honours: wider values clamp to it (a band past the texture diagonal is moot). */
export const DITHER_EDGE_WIDTH_MAX = 4096;

/** Params slots of one flood (init + steps; the widest band needs 1 + 15). */
const JFA_MAX_PASSES = 20;
/** A pooled flood scratch unused this long (ms) is freed. */
const JFA_IDLE_MS = 2000;
/** Seeds are packed as x | y << 16: a flood domain is at most this many texels on a side. */
const JFA_MAX_DOMAIN = 0xFFFF;

const finiteOr0 = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The edge width a config renders with: NaN / negative / missing → 0 (off), capped at DITHER_EDGE_WIDTH_MAX. */
export function ditherEdgeWidth(cfg: Pick<DitherConfig, 'edgeWidth'> | null | undefined): number {
  const w = cfg?.edgeWidth;
  if (typeof w !== 'number' || !(w > 0)) return 0;   // (NaN fails the comparison)
  return Math.min(w, DITHER_EDGE_WIDTH_MAX);
}

const jfaStepMemo = new Map<number, readonly number[]>();

/**
 * The jump-flood step schedule for an edge band of `width` px (a pure function of the width). Only seeds nearer than
 * width + 0.5 texel centres change the edge factor, so the flood must reach M = ceil(width + 0.5): the smallest first
 * step whose ceil-halving run (s, ceil(s / 2), ..., 1) sums to >= M, then two refinement passes (2, 1 — "JFA+2"),
 * which brings the flood's few sub-texel misses to ~0 (measured vs a brute-force distance transform).
 */
export function ditherEdgeJfaSteps(width: number): readonly number[] {
  const m = Math.max(1, Math.ceil(Math.min(width > 0 ? width : 0, DITHER_EDGE_WIDTH_MAX) + 0.5));   // (NaN → 0)
  const hit = jfaStepMemo.get(m);
  if (hit) return hit;
  const run = (s0: number) => { const r: number[] = []; for (let s = s0; ; s = Math.ceil(s / 2)) { r.push(s); if (s === 1) break; } return r; };
  const sum = (r: number[]) => r.reduce((a, b) => a + b, 0);
  let s0 = Math.max(1, Math.floor(m / 2) - 2 * Math.ceil(Math.log2(m + 1)));   // (below the minimum: the run sums < 2 s0 + 2 log2 s0)
  while (sum(run(s0)) < m) s0++;
  const steps = run(s0);
  if (m >= 3) steps.push(2, 1);
  const out = Object.freeze(steps);
  jfaStepMemo.set(m, out);
  return out;
}

/** How far (texels, Chebyshev) the jump flood of `width` can carry a seed: the sum of its steps. */
export function ditherEdgeJfaCone(width: number): number {
  let c = 0;
  for (const s of ditherEdgeJfaSteps(width)) c += s;
  return c;
}

/** Texels, max-exclusive. */
export interface DitherTexelRect { x0: number; y0: number; x1: number; y1: number }

export type DitherAlgorithm =
  // GPU compute (ordered, real-time)
  | 'bayer'
  | HalftoneAlgorithm   // 'halftone_dot' | 'halftone_line' | ... one value per HALFTONE_SHAPES entry
  | 'blue_noise'
  | 'noise'
  // Rust/WASM (error diffusion, async)
  | 'floyd_steinberg'
  | 'atkinson'
  | 'jarvis_judice_ninke'
  | 'stucki'
  | 'sierra'
  | 'sierra_lite';

/** Halftone screen shapes, in SHADER INDEX order (params[0].y) — append only: the index is the
 *  shader's switch case, and dot / line / diamond (0..2) are the original three that saved documents
 *  use. rings / spiral are GLOBAL patterns (centred on the texture), the rest are per-cell. */
export const HALFTONE_SHAPES = [
  'dot', 'line', 'diamond',
  'square', 'cross', 'ellipse', 'wavy', 'crosshatch', 'rings', 'spiral', 'hexagon', 'star', 'heart', 'triangle',
] as const;

/** Shape of a halftone screen cell. */
export type HalftoneShape = typeof HALFTONE_SHAPES[number];

/** The dither algorithm value for each halftone shape ('halftone_' + shape — the stored form). */
export type HalftoneAlgorithm = `halftone_${HalftoneShape}`;

/** True for every 'halftone_*' algorithm (including a shape this build does not know — it renders as Dot). */
export function isHalftoneAlgorithm(algorithm: string): algorithm is HalftoneAlgorithm {
  return typeof algorithm === 'string' && algorithm.startsWith('halftone_');
}

/** The shader shape index of a halftone algorithm: dot 0, line 1, diamond 2, then HALFTONE_SHAPES order.
 *  An unknown 'halftone_*' value (a newer document) falls back to 0 (Dot); a non-halftone algorithm is -1. */
export function halftoneShapeIndex(algorithm: string): number {
  if (!isHalftoneAlgorithm(algorithm)) return -1;
  const i = (HALFTONE_SHAPES as readonly string[]).indexOf(algorithm.slice('halftone_'.length));
  return i < 0 ? 0 : i;
}

/** Every dither algorithm this engine supports, in UI order (GPU ordered first, then WASM error diffusion).
 *  Hosts can feature-detect a halftone shape by looking its algorithm value up here. */
export const DITHER_ALGORITHMS: readonly DitherAlgorithm[] = [
  'bayer', ...HALFTONE_SHAPES.map((s): HalftoneAlgorithm => `halftone_${s}`), 'blue_noise', 'noise',
  'floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite',
];

/** How the dither pattern maps to colors. */
export type DitherColorMode =
  | 'quantize'   // Classic: quantize the existing pixel colors to N levels (default)
  | 'duotone';   // Map to explicit foreground/background colors

/** Full dither configuration. */
export interface DitherConfig {
  enabled: boolean;
  algorithm: DitherAlgorithm;

  /** Number of output colors per channel (2 = 1-bit, 4 = 2-bit, 256 = no-op). Default: 2. */
  colorLevels: number;

  /** Bayer matrix level (0 = 2×2, 1 = 4×4, 2 = 8×8, 3 = 16×16, 4 = 32×32). Default: 2. */
  bayerLevel: number;

  /** Halftone screen angle in degrees. Default: 45. */
  halftoneAngle: number;

  /** Halftone screen frequency (cells per texture width). Default: 40. */
  halftoneFrequency: number;

  /** Strength: how strongly the dither PATTERN applies. Quantize mode (and error diffusion): a blend of the original
   *  (0) and the dithered result (1). Duotone: the flat two-colour tone the pattern averages to (0) → the crisp dot
   *  pattern (1) — how much the colours replace the artwork is `tintOpacity`. Default: 1.0. */
  strength: number;

  /** Pattern scale multiplier (1 = 1:1, 2 = 2× larger pattern). Default: 1.0. */
  patternScale: number;

  /** Apply per-channel (color dithering) vs. luminance-only (mono dithering). Default: false (mono). */
  perChannel: boolean;

  // ── Color Controls ──

  /** Color mapping mode. 'quantize' = reduce existing colors, 'duotone' = map to two explicit colors. Default: 'quantize'. */
  colorMode: DitherColorMode;

  /** Foreground (lit/bright area) color in RGBA 0-1. Used in 'duotone' mode. Default: black [0,0,0,1]. */
  foregroundColor: [number, number, number, number];

  /** Background (dark/shadow area) color in RGBA 0-1. Used in 'duotone' mode. Default: white [1,1,1,1]. */
  backgroundColor: [number, number, number, number];

  /** Swap foreground/background mapping (invert which areas get which color). Default: false.
   *  In quantize mode this inverts the dithered output. In duotone mode, prefer `duotoneBias` instead. */
  invertPattern: boolean;

  /** Duotone Tint: how strongly the two duotone colors replace the original artwork (0 = original, 1 = full
   *  duotone), independent of `strength` since 2026-10-09 (it was strength × tint). Default: 1.0. */
  tintOpacity: number;

  /** Duotone coverage bias (0–1). Controls the balance between FG and BG dot coverage.
   *  0.0 = all BG (no dots), 0.5 = balanced 50/50, 1.0 = all FG (solid).
   *  Moving from 0.5 toward 0 or 1 has the same effect as the old invert toggle
   *  but with continuous control over dot density. Default: 0.5. */
  duotoneBias: number;

  // ── Edge/Boundary Effects (2026-09-15) ──
  // The "edge" is the CONTENT boundary — where the layer's painted alpha ends (a stroke's outline,
  // a filled shape's rim). The distance to it (a jump-flood distance transform since 2026-10-09 — was
  // a 25-tap coverage estimate) gives a smooth 0→1 factor over `edgeWidth` px; the three amounts below
  // shape how the pattern behaves inside that band.
  // Ordered (GPU) algorithms only — error-diffusion (WASM) ignores these.

  /** Width in texels (layer px) of the edge band the effects ramp across, 0..DITHER_EDGE_WIDTH_MAX (4096; wider
   *  clamps; NaN / negative = 0). 0 = edge effects off. Any width is smooth (exact distance, no taps); a wide band in
   *  'content' mode costs a log2(width)-pass flood over the changed region grown by about the width. Default: 0. */
  edgeWidth: number;

  /** 0–1: fade the dither back to the original toward the edge (pattern dissolves out). Default: 0. */
  edgeFade: number;

  /** -1..1: pattern DOT SIZE ramp toward the edge. Positive = dots shrink until they vanish at
   *  the boundary — direction-aware, so it shrinks whichever color currently forms the dots
   *  (duotoneBias > 0.5 = BG-phase dots ramp toward all-FG; otherwise toward all-BG as classic).
   *  NEGATIVE = dots GROW into a solid rim (the outline effect). Quantize mode: positive pulls
   *  toward paper-white, negative toward ink-black. Default: 0. */
  edgeShrink: number;

  /** 0–1: decrease pattern density toward the edge — whole cells/dots drop out stochastically.
   *  A dropped cell is ERASED (fully transparent), independent of the FG/BG colors — the layer
   *  dissolves to nothing in halftone-cell chunks. Neither the original artwork (that's
   *  `edgeFade`) nor the paper color (that's `edgeShrink`) shows in a dropped cell, and swapping
   *  FG/BG never turns dropped cells solid. All-or-nothing per cell. For noise/blue-noise this
   *  folds into coverage (no discrete cells). Default: 0. */
  edgeDensity: number;

  /** Integer seed for the density dropout arrangement — re-roll to get a different set of dropped
   *  dots (deterministic per seed: a static illustration never shimmers). Default: 0. */
  edgeSeed: number;

  /** Which boundary the effects ramp toward. 'content' (default) = the painted alpha boundary —
   *  stroke outlines, blob rims, erased holes (the nearest no-paint gap). 'canvas' = the texture's
   *  own border (analytic distance, cheapest). 'both' = nearest of the two. */
  edgeMode: 'content' | 'canvas' | 'both';
}

/**
 * Does this config change any pixel? Enabled, and a visible Strength — or, in Duotone mode for the ordered (GPU)
 * algorithms, a visible Tint (Strength 0 there is the flat two-colour tone, still tinted). Error diffusion ignores
 * the color mode (WASM dithers the raw colors), so for it only Strength counts. The single gate every dither path
 * (layer cache, compositor, bake) uses.
 */
export function ditherConfigActive(cfg: DitherConfig | null | undefined): cfg is DitherConfig {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.strength > 0.001) return true;
  return cfg.colorMode === 'duotone' && (cfg.tintOpacity ?? 1) > 0.001 && !DitherEngine.isErrorDiffusion(cfg.algorithm);
}

/**
 * Error-diffusion Strength: blend the WASM result `out` back toward the original `orig` in place (RGBA8, the same
 * length): out = orig + (out − orig) × strength, rounded. Strength ≥ 1 leaves `out` as it is.
 */
export function blendDitherStrength(out: Uint8Array, orig: Uint8Array, strength: number): void {
  const s = Math.max(0, Math.min(1, strength));
  if (s >= 1) return;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(orig[i] + (out[i] - orig[i]) * s);
}

/** Default config for a newly created dither effect. */
export function defaultDitherConfig(): DitherConfig {
  return {
    enabled: false,
    algorithm: 'bayer',
    colorLevels: 2,
    bayerLevel: 2,
    halftoneAngle: 45,
    halftoneFrequency: 40,
    strength: 1.0,
    patternScale: 1.0,
    perChannel: false,
    colorMode: 'quantize',
    foregroundColor: [0, 0, 0, 1],
    backgroundColor: [1, 1, 1, 1],
    invertPattern: false,
    tintOpacity: 1.0,
    duotoneBias: 0.5,
    edgeWidth: 0,
    edgeFade: 0,
    edgeShrink: 0,
    edgeDensity: 0,
    edgeSeed: 0,
    edgeMode: 'content',
  };
}

// ─── Engine ─────────────────────────────────────────────────────

export class DitherEngine {
  private device: GPUDevice;

  // Bayer pipeline
  private bayerPipeline: GPUComputePipeline | null = null;
  private bayerBGL: GPUBindGroupLayout | null = null;

  // Halftone pipeline
  private halftonePipeline: GPUComputePipeline | null = null;
  private halftoneBGL: GPUBindGroupLayout | null = null;

  // Noise pipeline
  private noisePipeline: GPUComputePipeline | null = null;
  private noiseBGL: GPUBindGroupLayout | null = null;

  // Blue noise pipeline + pre-baked threshold texture
  private blueNoisePipeline: GPUComputePipeline | null = null;
  private blueNoiseBGL: GPUBindGroupLayout | null = null;
  private blueNoiseTexture: GPUTexture | null = null;
  private blueNoiseSampler: GPUSampler | null = null;

  // Shared ping texture for read-back
  private pingTex: GPUTexture | null = null;
  private pingW = 0;
  private pingH = 0;

  // Shared params buffer (40 floats = 160 bytes: algorithm params[0..3], color + edge controls params[4..7],
  // dispatch region params[8], content-edge seeds domain params[9])
  private paramsBuf: GPUBuffer;
  private regionData = new Float32Array(8);

  // Content-edge jump flood (2026-10-09): pipelines, the per-pass params slots, two POOLED r32uint scratch textures
  // (grown to the largest domain seen, freed after JFA_IDLE_MS without use — never per layer) and a 1x1 "no seed"
  // stand-in bound when a dispatch needs no distance.
  private jfaInitPipeline: GPUComputePipeline | null = null;
  private jfaInitBGL: GPUBindGroupLayout | null = null;
  private jfaStepPipeline: GPUComputePipeline | null = null;
  private jfaStepBGL: GPUBindGroupLayout | null = null;
  private jfaParamsBuf: GPUBuffer | null = null;
  private jfaParamData = new Int32Array(JFA_MAX_PASSES * 64);
  private jfaTex: [GPUTexture, GPUTexture] | null = null;
  private jfaViews: [GPUTextureView, GPUTextureView] | null = null;
  private jfaStepBGs: GPUBindGroup[] = [];
  private jfaCapW = 0;
  private jfaCapH = 0;
  private jfaLastUse = 0;
  private jfaTimer: ReturnType<typeof setTimeout> | null = null;
  private noSeedsTex: GPUTexture | null = null;
  private noSeedsView: GPUTextureView | null = null;
  /** The seeds view the next dither bind group uses (set by record()). */
  private curSeedsView: GPUTextureView | null = null;

  /** Most texels a pooled scratch domain may cover before applyRegion() splits a big region into tiles (2 × 4 bytes
   *  per texel: the default 2048² = 32 MB). Tiling is skipped when the edge reach makes tiles inefficient (then one
   *  domain = the region grown by the reach, clipped to the texture). */
  public jfaScratchBudgetTexels = 2048 * 2048;
  /** Smallest useful tile side (texels): when the reach leaves less than this inside the budget, no tiling. */
  public jfaMinTileSide = 512;

  /** Work counters (diagnostics / tests): compute dispatches and the texels they cover, texture copies (the
   *  in-place apply() reads through a ping copy), error-diffusion passes (GPU→CPU→WASM), and the content-edge jump
   *  flood (floods = domains, jfaDispatches / jfaTexels = its passes, scratch allocations). */
  public readonly stats = {
    dispatches: 0, dispatchTexels: 0, copies: 0, copyTexels: 0, errorDiffusionPasses: 0,
    floods: 0, jfaDispatches: 0, jfaTexels: 0, jfaScratchAllocs: 0,
  };

  // PERF (audit 5.6): persistent MAP_READ readback buffer for the error-diffusion
  // path — recreated only when the required size changes instead of allocated and
  // destroyed on every composite. The busy flag guards against overlapping
  // applyAsync calls (a buffer cannot be mapped twice concurrently); if that
  // ever happens we fall back to a throwaway buffer for the overlapping call.
  private _readBuf: GPUBuffer | null = null;
  private _readBufSize = 0;
  private _readBufBusy = false;

  // Frame counter for noise animation
  private frameCounter = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramsBuf = device.createBuffer({
      size: 160,  // 40 × f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Does this config's edge effect read the CONTENT distance (the jump flood)? Edge band on (width >= 0.5), any
   *  amount set, and the 'content' or 'both' mode. A superset of the shaders' own early-outs (any amount, not the
   *  shaders' >= 0.001 sum), so the flood never misses a dispatch that reads it. */
  public static usesContentDistance(cfg: DitherConfig): boolean {
    if (ditherEdgeWidth(cfg) < 0.5 || cfg.edgeMode === 'canvas') return false;
    const amt = Math.abs(finiteOr0(cfg.edgeFade)) + Math.abs(finiteOr0(cfg.edgeShrink)) + Math.abs(finiteOr0(cfg.edgeDensity));
    return amt > 0;
  }

  /** How far (texels) the density dropout's ONE edge evaluation per pattern cell (at the cell centre) can sit from
   *  a pixel of that cell: about 0.71 cell, generously rounded. 0 without density or for cell-less patterns. */
  private static cellReach(cfg: DitherConfig, texW: number): number {
    if (!(finiteOr0(cfg.edgeDensity) > 0.001)) return 0;
    const ps = Math.max(cfg.patternScale || 1, 1e-3);
    let cellPx = 0;
    if (cfg.algorithm === 'bayer') cellPx = (1 << ((cfg.bayerLevel | 0) + 1)) * ps + ps;
    else if (isHalftoneAlgorithm(cfg.algorithm)) cellPx = (texW / Math.max(cfg.halftoneFrequency || 1, 1e-3)) * ps;
    // (noise / blue noise: density folds into coverage — no cells)
    return cellPx > 0 ? Math.ceil(cellPx * 1.5) + 2 : 0;
  }

  /** Is this config an active ORDERED (GPU) dither — the kind apply() / applyRegion() run? */
  public static isActiveOrdered(config: DitherConfig | undefined | null): boolean {
    return ditherConfigActive(config) && !DitherEngine.isErrorDiffusion(config.algorithm);
  }

  /**
   * How far (texels, per axis) a change to the SOURCE can move the ordered-dither OUTPUT. A pixel's output reads only
   * its own source texel, except with content edge effects on (usesContentDistance):
   *  - its edge factor comes from the jump flood. A flood pass at p reads p ± step, so the flood's result at p is a
   *    function of the alpha PRESENCE within the CONE of p: Chebyshev radius ditherEdgeJfaCone(width) = the sum of the
   *    steps (≈ width + log2(width) + 3 — more than the width itself: a far seed can still re-route the flood). The
   *    schedule depends on the width only and the flood skips reads outside its domain, so a flood over ANY domain
   *    that contains p's cone gives p exactly the whole-texture flood's seed — that is what makes a region pass equal
   *    to a full pass (applyRegion floods the region grown by this reach);
   *  - the density dropout evaluates the factor once at the pattern CELL CENTRE (Bayer tile / halftone cell), up to
   *    about 0.71 cell away (cellReach, generously rounded) — whose cone counts too.
   * So reach = cone + cell term, and re-dithering a dirty source rect grown by it gives exactly the full re-dither.
   * 0 when nothing reads the distance (width 0, all amounts 0, or the canvas-only mode, which is pure arithmetic).
   */
  public static rectReach(cfg: DitherConfig, texW: number): number {
    if (!DitherEngine.usesContentDistance(cfg)) return 0;
    return ditherEdgeJfaCone(ditherEdgeWidth(cfg)) + DitherEngine.cellReach(cfg, texW);
  }

  /** Numeric edge-mode for the shaders (params[3].x): 0 content, 1 canvas, 2 both.
   *  Defensive default 'content' — configs saved before 2026-09-15 lack the field. */
  private static edgeModeIndex(cfg: DitherConfig): number {
    return cfg.edgeMode === 'canvas' ? 1 : cfg.edgeMode === 'both' ? 2 : 0;
  }

  /**
   * Check if an algorithm requires WASM error diffusion (async) vs GPU compute (sync).
   */
  public static isErrorDiffusion(algorithm: DitherAlgorithm): boolean {
    return (
      algorithm === 'floyd_steinberg' ||
      algorithm === 'atkinson' ||
      algorithm === 'jarvis_judice_ninke' ||
      algorithm === 'stucki' ||
      algorithm === 'sierra' ||
      algorithm === 'sierra_lite'
    );
  }

  /**
   * Apply dithering to a texture in-place (synchronous — GPU ordered dithering only).
   * For error diffusion algorithms, this is a no-op. Use `applyAsync()` instead.
   * In-place costs a full ping copy; to dither one texture INTO another (no copy, optionally
   * one region) use `applyRegion()` — the per-layer dither cache does.
   *
   * PERF (audit 5.7): when `sharedEncoder` is provided, the input copy and the
   * compute dispatch are recorded into it and NO submit happens here — the
   * caller owns the submit. Without it, both commands still share one
   * internally-owned encoder/submit (was 2 standalone submits per call).
   * Note: the uniform writeBuffer calls below are queue-ordered ahead of any
   * later submit, so deferring the submit is safe — but because paramsBuf (and
   * the content-edge flood's params slots / pooled scratch) are shared, callers
   * must submit the encoder before the next apply() / applyRegion() call. The
   * content-edge flood here covers the whole texture in one domain (no tiling:
   * one shared encoder) — 8 bytes of transient scratch per texel.
   */
  public apply(texture: GPUTexture, config: DitherConfig, sharedEncoder?: GPUCommandEncoder): void {
    if (!ditherConfigActive(config)) return;
    // Error diffusion requires async — skip silently in sync path
    if (DitherEngine.isErrorDiffusion(config.algorithm)) return;

    const w = texture.width;
    const h = texture.height;
    if (w === 0 || h === 0) return;

    // Ensure ping texture
    this.ensurePing(w, h);

    const enc = sharedEncoder ?? this.device.createCommandEncoder();

    // Copy input → ping (for reading)
    enc.copyTextureToTexture({ texture }, { texture: this.pingTex! }, { width: w, height: h });
    this.stats.copies++; this.stats.copyTexels += w * h;

    this.record(this.pingTex!, texture, config, { x0: 0, y0: 0, x1: w, y1: h }, this.frameCounter, enc);

    if (!sharedEncoder) this.device.queue.submit([enc.finish()]);

    this.frameCounter++;
  }

  /**
   * Ordered dither of `src` into a SEPARATE texture `out` of the same size, over `region` only (texels,
   * max-exclusive; null / omitted = the whole texture). No copy: the shader reads `src` directly, so `src` is never
   * modified (a raster layer can be its own source). Every texel the region covers gets exactly what a whole-texture
   * pass writes there (the shaders work in absolute texel coordinates); texels outside it are left untouched — the
   * per-layer dither cache re-dithers a stroke's dirty rect grown by rectReach() this way. `noiseSeed`: the 'noise'
   * pattern's seed (fixed per cache, so a re-dithered rect matches the rest). One submit of its own (the shared
   * params buffer is rewritten per call). Returns false when nothing was dispatched (inactive / error-diffusion
   * config, size mismatch, empty region).
   */
  public applyRegion(
    src: GPUTexture, out: GPUTexture, config: DitherConfig, region?: DitherTexelRect | null, noiseSeed = 0,
  ): boolean {
    if (!DitherEngine.isActiveOrdered(config)) return false;
    const w = out.width, h = out.height;
    if (w === 0 || h === 0 || src.width !== w || src.height !== h || src === out) return false;
    const r = region
      ? { x0: Math.max(0, Math.floor(region.x0)), y0: Math.max(0, Math.floor(region.y0)), x1: Math.min(w, Math.ceil(region.x1)), y1: Math.min(h, Math.ceil(region.y1)) }
      : { x0: 0, y0: 0, x1: w, y1: h };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return false;
    for (const t of this.planTiles(config, r, w, h)) {
      // one submit per tile: the shared params buffer / flood slots are rewritten per tile (queue-ordered)
      const enc = this.device.createCommandEncoder();
      this.record(src, out, config, t, noiseSeed, enc);
      this.device.queue.submit([enc.finish()]);
    }
    return true;
  }

  /** The tiles applyRegion() dispatches `r` in: one, unless a content-edge flood domain (the region grown by the
   *  reach) would exceed jfaScratchBudgetTexels, tiles of a useful size (>= jfaMinTileSide) fit it and their overlapping
   *  floods cost at most 1.5x the one-domain flood. Tiles give
   *  exactly the same texels (each tile's flood domain contains every cone it reads — rectReach). */
  private planTiles(cfg: DitherConfig, r: DitherTexelRect, w: number, h: number): DitherTexelRect[] {
    if (!DitherEngine.usesContentDistance(cfg)) return [r];
    const reach = DitherEngine.rectReach(cfg, w);
    const dw = Math.min(w, r.x1 + reach) - Math.max(0, r.x0 - reach), dh = Math.min(h, r.y1 + reach) - Math.max(0, r.y0 - reach);
    const budget = this.jfaScratchBudgetTexels;
    if (dw * dh <= budget) return [r];
    const side = Math.floor(Math.sqrt(budget)) - 2 * reach;
    if (side < Math.max(1, this.jfaMinTileSide)) return [r];
    // even splits (no sliver tiles), each at most `side` square
    const nx = Math.ceil((r.x1 - r.x0) / side), ny = Math.ceil((r.y1 - r.y0) / side);
    const tiles: DitherTexelRect[] = [];
    let work = 0;
    for (let j = 0; j < ny; j++) {
      const y0 = r.y0 + Math.floor(((r.y1 - r.y0) * j) / ny), y1 = r.y0 + Math.floor(((r.y1 - r.y0) * (j + 1)) / ny);
      for (let i = 0; i < nx; i++) {
        const x0 = r.x0 + Math.floor(((r.x1 - r.x0) * i) / nx), x1 = r.x0 + Math.floor(((r.x1 - r.x0) * (i + 1)) / nx);
        tiles.push({ x0, y0, x1, y1 });
        work += (Math.min(w, x1 + reach) - Math.max(0, x0 - reach)) * (Math.min(h, y1 + reach) - Math.max(0, y0 - reach));
      }
    }
    // the tiles' flood domains overlap by 2 × reach: not worth it past 1.5× the one-domain flood (then: one domain)
    return work <= 1.5 * dw * dh ? tiles : [r];
  }

  /** Record one ordered-dither dispatch: `src` → `out` over region `r` (clipped, non-empty) — preceded, when the
   *  config reads the content distance, by the jump flood over the region grown by rectReach (clipped). */
  private record(src: GPUTexture, out: GPUTexture, config: DitherConfig, r: DitherTexelRect, noiseSeed: number, enc: GPUCommandEncoder): void {
    const w = out.width, h = out.height;
    const rd = this.regionData;
    rd[0] = r.x0; rd[1] = r.y0; rd[2] = r.x1; rd[3] = r.y1;
    if (DitherEngine.usesContentDistance(config)) {
      const reach = DitherEngine.rectReach(config, w);
      const dom = {
        x0: Math.max(0, r.x0 - reach), y0: Math.max(0, r.y0 - reach),
        x1: Math.min(w, r.x1 + reach), y1: Math.min(h, r.y1 + reach),
      };
      this.curSeedsView = this.recordEdgeFlood(src, dom, ditherEdgeJfaSteps(ditherEdgeWidth(config)), enc);
      rd[4] = dom.x0; rd[5] = dom.y0; rd[6] = dom.x1; rd[7] = dom.y1;
    } else {
      this.curSeedsView = this.noSeeds();
      rd[4] = 0; rd[5] = 0; rd[6] = 1; rd[7] = 1;
    }
    this.device.queue.writeBuffer(this.paramsBuf, 128, rd);   // params[8]: the region, params[9]: the seeds domain
    switch (config.algorithm) {
      case 'bayer':
        this.applyBayer(src, out, w, h, config, enc, r);
        break;
      case 'blue_noise':
        this.applyBlueNoise(src, out, w, h, config, enc, r);
        break;
      case 'noise':
        this.applyNoise(src, out, w, h, config, enc, r, noiseSeed);
        break;
      default:
        // Every 'halftone_*' shape (an unknown one from a newer document renders as Dot).
        if (isHalftoneAlgorithm(config.algorithm)) this.applyHalftone(src, out, w, h, config, enc, r);
        break;
    }
  }

  /**
   * Apply dithering to a texture in-place (async — supports all algorithms).
   * For GPU ordered algorithms, delegates to `apply()` (fast, sync).
   * For error diffusion, reads the texture to CPU, runs WASM, writes back.
   */
  public async applyAsync(texture: GPUTexture, config: DitherConfig): Promise<void> {
    if (!ditherConfigActive(config)) return;

    if (!DitherEngine.isErrorDiffusion(config.algorithm)) {
      // Ordered dithering — GPU sync path
      this.apply(texture, config);
      return;
    }

    const pixels = await this.errorDiffuse(texture, config);
    if (!pixels) return;

    // Write pixels back to GPU texture
    this.device.queue.writeTexture(
      { texture },
      pixels,
      { bytesPerRow: texture.width * 4 },
      { width: texture.width, height: texture.height },
    );
  }

  /**
   * Error diffusion of `src`'s CURRENT pixels (as of the queue position of this call): GPU → CPU read-back, the
   * WASM pass, and the result as tightly packed RGBA8 rows — nothing is written to the GPU (the caller decides where
   * it goes, or drops it when it is stale). Null when the config is not an active error-diffusion one, the WASM
   * module is not ready, or the texture is empty.
   */
  public async errorDiffuse(src: GPUTexture, config: DitherConfig): Promise<Uint8Array | null> {
    if (!config.enabled || config.strength <= 0.001 || !DitherEngine.isErrorDiffusion(config.algorithm)) return null;
    if (!isWasmReady()) {
      console.warn('[DitherEngine] WASM not initialized — skipping error diffusion');
      return null;
    }

    const w = src.width;
    const h = src.height;
    if (w === 0 || h === 0) return null;

    // 1. Read GPU texture → CPU buffer
    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const totalBytes = paddedRow * h;

    // PERF (audit 5.6): reuse the persistent MAP_READ buffer across frames;
    // recreate only when the required size changes. Fall back to a throwaway
    // buffer if a previous applyAsync is still mid-map (overlapping calls).
    let readBuf: GPUBuffer;
    let ownsReadBuf = false;
    if (!this._readBufBusy) {
      if (!this._readBuf || this._readBufSize !== totalBytes) {
        this._readBuf?.destroy();
        this._readBuf = this.device.createBuffer({
          size: totalBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this._readBufSize = totalBytes;
      }
      readBuf = this._readBuf;
      this._readBufBusy = true;
    } else {
      readBuf = this.device.createBuffer({
        size: totalBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      ownsReadBuf = true;
    }

    this.stats.errorDiffusionPasses++;
    const pixels = new Uint8Array(unpaddedRow * h);
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: src },
        { buffer: readBuf, bytesPerRow: paddedRow },
        { width: w, height: h },
      );
      this.device.queue.submit([enc.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readBuf.getMappedRange());

      // Tightly pack rows (remove GPU row padding)
      for (let row = 0; row < h; row++) {
        pixels.set(
          mapped.subarray(row * paddedRow, row * paddedRow + unpaddedRow),
          row * unpaddedRow,
        );
      }
      readBuf.unmap();
    } finally {
      // Release/clean up even if mapAsync rejects (e.g. device loss)
      if (ownsReadBuf) readBuf.destroy();
      else this._readBufBusy = false;
    }

    // 2. Run WASM error diffusion in-place (on a copy's worth of originals kept for Strength < 1)
    const orig = config.strength < 0.999 ? pixels.slice() : null;
    applyErrorDiffusion(
      config.algorithm as ErrorDiffusionAlgorithm,
      pixels,
      w,
      h,
      config.colorLevels,
    );

    // 3. Strength: blend the result back toward the original (every caller — the layer dither cache, its Bake and
    //    the global dither — writes these pixels out as they are). Strength 1: the WASM output is final.
    //    (Duotone / Scale / Invert / edge effects do not apply to error diffusion: the WASM pass dithers the raw
    //     colors; the host panels hide those controls for these algorithms.)
    if (orig) blendDitherStrength(pixels, orig, config.strength);
    return pixels;
  }

  /**
   * Write the color-control uniform slots (params[4..7]) that all shaders share.
   * Must be called after the algorithm-specific params are written into slots 0..3.
   */
  private writeColorUniforms(cfg: DitherConfig): void {
    const data = new Float32Array(16); // params[4..7] = 16 floats
    data[0]  = cfg.colorMode === 'duotone' ? 1.0 : 0.0;
    data[1]  = cfg.invertPattern ? 1.0 : 0.0;
    data[2]  = cfg.tintOpacity;
    data[3]  = cfg.duotoneBias ?? 0.5;
    data[4]  = cfg.foregroundColor[0];
    data[5]  = cfg.foregroundColor[1];
    data[6]  = cfg.foregroundColor[2];
    data[7]  = cfg.foregroundColor[3];
    data[8]  = cfg.backgroundColor[0];
    data[9]  = cfg.backgroundColor[1];
    data[10] = cfg.backgroundColor[2];
    data[11] = cfg.backgroundColor[3];
    // 12..15 = params[7]: edge effects (configs saved before 2026-09-15 lack them; NaN / negative width = off,
    // wider than DITHER_EDGE_WIDTH_MAX clamps — the same sanitised width the flood schedule and rectReach use)
    data[12] = ditherEdgeWidth(cfg);
    data[13] = finiteOr0(cfg.edgeFade);
    data[14] = finiteOr0(cfg.edgeShrink);
    data[15] = finiteOr0(cfg.edgeDensity);
    this.device.queue.writeBuffer(this.paramsBuf, 64, data); // offset 64 = after first 16 floats
  }

  // ─── Content-edge jump flood ────────────────────────────────────

  /**
   * Record the jump flood over `dom` (texels of `src`, clipped, non-empty) into `enc`: the init pass, then one pass per
   * step of `steps`. Returns the view holding the result (seeds relative to dom's origin). Uses the pooled scratch.
   */
  private recordEdgeFlood(src: GPUTexture, dom: DitherTexelRect, steps: readonly number[], enc: GPUCommandEncoder): GPUTextureView {
    const dw = dom.x1 - dom.x0, dh = dom.y1 - dom.y0;
    if (dw <= 0 || dh <= 0 || dw > JFA_MAX_DOMAIN || dh > JFA_MAX_DOMAIN || steps.length + 1 > JFA_MAX_PASSES) return this.noSeeds();
    this.ensureJfaPipelines();
    this.ensureJfaScratch(dw, dh);
    const views = this.jfaViews!;
    const pd = this.jfaParamData;
    pd.fill(0);
    pd[0] = dom.x0; pd[1] = dom.y0; pd[2] = dw; pd[3] = dh;
    for (let i = 0; i < steps.length; i++) {
      const o = (i + 1) * 64;
      pd[o] = dw; pd[o + 1] = dh; pd[o + 2] = steps[i];
    }
    this.device.queue.writeBuffer(this.jfaParamsBuf!, 0, pd, 0, (steps.length + 1) * 64);
    const gx = Math.ceil(dw / 8), gy = Math.ceil(dh / 8);
    // ONE compute pass for the whole flood (each dispatch is its own usage scope, so the ping-pong between dispatches
    // is legal and synchronised) — the per-pass fixed cost dominated small floods
    const pass = enc.beginComputePass();
    pass.setPipeline(this.jfaInitPipeline!);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.jfaInitBGL!,
      entries: [{ binding: 0, resource: src.createView() }, { binding: 1, resource: views[0] }, { binding: 2, resource: this.jfaSlot(0) }],
    }));
    pass.dispatchWorkgroups(gx, gy);
    pass.setPipeline(this.jfaStepPipeline!);
    for (let i = 0; i < steps.length; i++) {
      pass.setBindGroup(0, this.jfaStepBindGroup(i));   // step i reads views[i % 2], writes the other
      pass.dispatchWorkgroups(gx, gy);
    }
    pass.end();
    const cur = steps.length % 2;
    this.stats.floods++;
    this.stats.jfaDispatches += steps.length + 1;
    this.stats.jfaTexels += (steps.length + 1) * dw * dh;
    this.touchJfaScratch();
    return views[cur];
  }

  private jfaSlot(i: number): GPUBufferBinding {
    return { buffer: this.jfaParamsBuf!, offset: i * 256, size: 16 };
  }

  /** Flood step i's bind group (cached per scratch allocation: its views and params slot never change). */
  private jfaStepBindGroup(i: number): GPUBindGroup {
    let bg = this.jfaStepBGs[i];
    if (!bg) {
      const v = this.jfaViews!, c = i % 2;
      bg = this.device.createBindGroup({
        layout: this.jfaStepBGL!,
        entries: [{ binding: 0, resource: v[c] }, { binding: 1, resource: v[1 - c] }, { binding: 2, resource: this.jfaSlot(i + 1) }],
      });
      this.jfaStepBGs[i] = bg;
    }
    return bg;
  }

  private ensureJfaPipelines(): void {
    if (this.jfaInitPipeline) return;
    const mk = (code: string, inEntry: GPUBindGroupLayoutEntry) => {
      const bgl = this.device.createBindGroupLayout({
        entries: [
          inEntry,
          { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32uint' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      const pipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
      return { bgl, pipeline };
    };
    const init = mk(WGSL_JFA_INIT, { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } });
    const step = mk(WGSL_JFA_STEP, { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } });
    this.jfaInitBGL = init.bgl; this.jfaInitPipeline = init.pipeline;
    this.jfaStepBGL = step.bgl; this.jfaStepPipeline = step.pipeline;
    this.jfaParamsBuf = this.device.createBuffer({ size: JFA_MAX_PASSES * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The pooled scratch pair, at least dw × dh. Grown in 64-texel steps to the largest domain seen (both axes) —
   *  unless that would exceed the budget while the domain itself fits it (then sized to the domain). */
  private ensureJfaScratch(dw: number, dh: number): void {
    if (this.jfaTex && dw <= this.jfaCapW && dh <= this.jfaCapH) return;
    const up = (v: number) => Math.ceil(v / 64) * 64;
    let cw = up(Math.max(dw, this.jfaCapW)), ch = up(Math.max(dh, this.jfaCapH));
    if (cw * ch > this.jfaScratchBudgetTexels && dw * dh <= this.jfaScratchBudgetTexels) { cw = up(dw); ch = up(dh); }
    this.releaseJfaScratch();
    const mk = () => this.device.createTexture({
      size: [cw, ch], format: 'r32uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const a = mk(), b = mk();
    this.jfaTex = [a, b];
    this.jfaViews = [a.createView(), b.createView()];
    this.jfaCapW = cw; this.jfaCapH = ch;
    this.stats.jfaScratchAllocs++;
  }

  /** Bytes the pooled flood scratch holds now (diagnostics / tests). */
  public get jfaScratchBytes(): number { return this.jfaTex ? this.jfaCapW * this.jfaCapH * 8 : 0; }

  private touchJfaScratch(): void {
    this.jfaLastUse = Date.now();
    if (this.jfaTimer !== null) return;
    const check = () => {
      this.jfaTimer = null;
      if (!this.jfaTex) return;
      const idle = Date.now() - this.jfaLastUse;
      if (idle >= JFA_IDLE_MS) { this.releaseJfaScratch(); return; }
      this.jfaTimer = setTimeout(check, JFA_IDLE_MS - idle);
      (this.jfaTimer as { unref?: () => void }).unref?.();
    };
    this.jfaTimer = setTimeout(check, JFA_IDLE_MS);
    (this.jfaTimer as { unref?: () => void }).unref?.();
  }

  /** Free the pooled flood scratch (deferred past the submitted work that may still read it). */
  public releaseJfaScratch(): void {
    if (!this.jfaTex) return;
    const [a, b] = this.jfaTex;
    this.jfaTex = null; this.jfaViews = null; this.jfaCapW = 0; this.jfaCapH = 0; this.jfaStepBGs = [];
    const done = () => { a.destroy(); b.destroy(); };
    try { this.device.queue.onSubmittedWorkDone().then(done, () => { /* device lost */ }); } catch { done(); }
  }

  /** The 1×1 "no seed in reach" stand-in (edge factor 1) bound when a dispatch reads no distance. */
  private noSeeds(): GPUTextureView {
    if (this.noSeedsView) return this.noSeedsView;
    this.noSeedsTex = this.device.createTexture({
      size: [1, 1], format: 'r32uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: this.noSeedsTex }, new Uint32Array([0xFFFFFFFF]), { bytesPerRow: 4 }, [1, 1]);
    this.noSeedsView = this.noSeedsTex.createView();
    return this.noSeedsView;
  }

  public destroy(): void {
    this.paramsBuf.destroy();
    this.pingTex?.destroy();
    this.blueNoiseTexture?.destroy();
    this._readBuf?.destroy();
    this.pingTex = null;
    this.blueNoiseTexture = null;
    this._readBuf = null;
    this._readBufSize = 0;
    if (this.jfaTimer !== null) { clearTimeout(this.jfaTimer); this.jfaTimer = null; }
    this.releaseJfaScratch();
    this.jfaParamsBuf?.destroy();
    this.jfaParamsBuf = null;
    this.noSeedsTex?.destroy();
    this.noSeedsTex = null;
    this.noSeedsView = null;
    this.curSeedsView = null;
  }

  // ─── Bayer Ordered Dithering ────────────────────────────────────

  private applyBayer(srcTex: GPUTexture, outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder, r: DitherTexelRect): void {
    this.ensureBayerPipeline();

    // params: [colorLevels, bayerLevel, strength, patternScale, perChannel, 0, 0, 0]
    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.bayerLevel;
    params[2] = cfg.strength;
    params[3] = cfg.patternScale;
    params[4] = cfg.perChannel ? 1.0 : 0.0;
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.bayerBGL!,
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 7, resource: this.curSeedsView! },
      ],
    });

    this.dispatch(this.bayerPipeline!, bg, r, enc);
  }

  private ensureBayerPipeline(): void {
    if (this.bayerPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 10>;

      // Bayer matrix computation (procedural, no lookup texture needed)
      // Computes the Bayer threshold for a given (x, y) at a given matrix level.
      fn bayerThreshold(x: u32, y: u32, level: u32) -> f32 {
        // Matrix size = 2^(level+1)
        let size = 1u << (level + 1u);
        var xm = x % size;
        var ym = y % size;
        var value = 0u;
        var s = size >> 1u;
        for (var i = 0u; i < level + 1u; i = i + 1u) {
          let bx = select(0u, 1u, xm >= s);
          let by = select(0u, 1u, ym >= s);
          // 2×2 base pattern index: [0,2; 3,1]
          let idx = (bx ^ by) | (by << 1u);
          // Map to Bayer order: 0→0, 1→2, 2→3, 3→1
          var mapped: u32;
          switch idx {
            case 0u: { mapped = 0u; }
            case 1u: { mapped = 2u; }
            case 2u: { mapped = 3u; }
            default:  { mapped = 1u; }
          }
          value = value * 4u + mapped;
          xm = xm % s;
          ym = ym % s;
          s = s >> 1u;
        }
        let total = size * size;
        return (f32(value) + 0.5) / f32(total);
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gidIn: vec3<u32>) {
        let dim = textureDimensions(output);
        ${WGSL_REGION_HEAD}
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let bayerLevel = u32(params[0].y);
        let strength = params[0].z;
        let patternScale = params[0].w;
        let perChannel = params[1].x > 0.5;

        let sx = u32(f32(gid.x) / patternScale);
        let sy = u32(f32(gid.y) / patternScale);

        let threshold = bayerThreshold(sx, sy, bayerLevel);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // Edge effects: es.x = fade strength multiplier, es.y = coverage shrink, es.z = edge factor.
        let es = edgeState(coords);
        // Density: drop whole Bayer TILES near the edge. ALL-OR-NOTHING per tile (edge factor
        // evaluated once at the tile centre), and a dropped tile renders the PAPER state (BG in
        // duotone / white in quantize) — the dot is REMOVED, leaving the pattern sparser. (Rev 2,
        // 2026-09-15: the first cut zeroed strength, which revealed the ORIGINAL artwork — that is
        // edgeFade's job, not density's.) params[3].y = the dropout seed.
        var cellDropped = false;
        let edgeDensity = params[7].w;
        if (edgeDensity > 0.001 && params[7].x >= 0.5) {   // edgeWidth 0 = edge effects off: no edgeAt taps
          let cellSize = i32(1u << (bayerLevel + 1u));
          let cell = vec2<i32>(i32(sx) / cellSize, i32(sy) / cellSize);
          let centerPx = (vec2<f32>(cell) + 0.5) * f32(cellSize) * patternScale;
          let eCell = edgeAt(vec2<i32>(centerPx), params[7].x);
          if (edgeCellRand(cell, u32(params[3].y)) > 1.0 - edgeDensity * (1.0 - eCell)) { cellDropped = true; }
        }

        // A density-dropped tile is ERASED — fully transparent, independent of the FG/BG colors.
        // (Rev 3, 2026-09-15: rev 2 forced the BG state, which turned SOLID after a color swap —
        // "removing a dot" must dissolve to nothing, whichever color plays paper.)
        if (cellDropped) {
          textureStore(output, coords, vec4<f32>(0.0));
          return;
        }

        // In duotone mode, use the configurable bias (params[4].w) so the
        // pattern is purely spatial — independent of the brush/stroke color.
        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        var duoSmooth = 0.0;   // the duotone level before quantizing: the flat tone its pattern averages to
        if (isDuotone) {
          // Shrink: ramp the bias toward the direction-aware landing extreme near the edge —
          // positive shrink makes the dots (whichever phase they are) shrink away.
          duoSmooth = mix(duotoneBias, shrinkTargetBias(duotoneBias), es.y);
          let ditheredLum = quantize(duoSmooth + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          // Shrink (quantize mode): pull values toward paper-white (or ink-black when negative).
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, es.y) + bias, colorLevels),
            quantize(mix(src.g, tq, es.y) + bias, colorLevels),
            quantize(mix(src.b, tq, es.y) + bias, colorLevels),
          );
        } else {
          // Mono: quantize luminance and output as grayscale.
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), es.y);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength, es.x, duoSmooth);
        textureStore(output, coords, col);
      }
    `;

    this.bayerBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },   // content-edge seeds
      ],
    });

    this.bayerPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bayerBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── Halftone Dithering ─────────────────────────────────────────

  private applyHalftone(srcTex: GPUTexture, outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder, r: DitherTexelRect): void {
    this.ensureHalftonePipeline();

    const shapeIdx = Math.max(0, halftoneShapeIndex(cfg.algorithm));
    const angleRad = (cfg.halftoneAngle * Math.PI) / 180;

    // params: [colorLevels, halftoneShape, strength, patternScale,
    //          angleRad, frequency, perChannel, 0,
    //          texW, texH, 0, 0]
    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = shapeIdx;
    params[2] = cfg.strength;
    params[3] = cfg.patternScale;
    params[4] = angleRad;
    params[5] = cfg.halftoneFrequency;
    params[6] = cfg.perChannel ? 1.0 : 0.0;
    params[8] = w;
    params[9] = h;
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.halftoneBGL!,
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 7, resource: this.curSeedsView! },
      ],
    });

    this.dispatch(this.halftonePipeline!, bg, r, enc);
  }

  private ensureHalftonePipeline(): void {
    if (this.halftonePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 10>;

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
      const HT_TAU: f32 = 6.28318531;
      const HT_SQRT3: f32 = 1.7320508;

      // Pixel coords to the ROTATED screen space (one unit = one cell). ONE scale for both axes: pixels are square,
      // so square cells (round dots) need the same scale on x and y - the old "aspect" factor (texW / texH) on y
      // stretched every cell on a non-square texture (oval dots on a portrait / landscape page).
      fn halftoneRot(px: f32, py: f32, angle: f32, freq: f32, texW: f32) -> vec2<f32> {
        let scale = freq / texW;
        let nx = px * scale;
        let ny = py * scale;
        let cs = cos(angle);
        let sn = sin(angle);
        return vec2<f32>(nx * cs - ny * sn, nx * sn + ny * cs);
      }

      // Honeycomb: offset from the NEAREST hexagon centre (centres at (i, j*sqrt3) and (i + 0.5, (j + 0.5)*sqrt3),
      // neighbours one unit apart). Two offset rectangular grids, keep the closer centre.
      fn htHexOffset(p: vec2<f32>) -> vec2<f32> {
        let r = vec2<f32>(1.0, HT_SQRT3);
        let h = r * 0.5;
        let a = p - r * floor(p / r) - h;
        let q = p - h;
        let b = q - r * floor(q / r) - h;
        return select(b, a, dot(a, a) < dot(b, b));
      }

      // Shape GAUGES: the scale at which p sits on the shape outline (0 at the shape origin, 1 on the unit outline).
      // Level sets are scaled copies of the shape, so the ink grows as the same shape. p.y points UP.
      // 5-point star, tip radius 1, inner radius 0.5: |p| over the outline radius in that direction.
      fn htStarGauge(p: vec2<f32>) -> f32 {
        let a0 = atan2(p.x, p.y);                                        // 0 = straight up (a tip)
        let a = abs(a0 - (HT_TAU / 5.0) * round(a0 / (HT_TAU / 5.0)));   // 0..36 degrees from the nearest tip
        let rs = 0.5 * 0.58778525;                                       // inner radius * sin 36
        let rc = 0.5 * 0.80901699 - 1.0;                                 // inner radius * cos 36 - tip radius
        return length(p) * (cos(a) * rs - sin(a) * rc) / rs;
      }
      // Disc of radius |c| centred at c (the origin is on its rim): p is inside k*disc for k >= |p|^2 / (2 p.c).
      fn htDiscGauge(p: vec2<f32>, c: vec2<f32>) -> f32 {
        let pc = dot(p, c);
        return select(1.0e4, dot(p, p) / max(2.0 * pc, 1.0e-6), pc > 1.0e-6);
      }
      // Classic heart: a 45-degree square of side 1 plus two discs on its upper edges (union = min of gauges).
      fn htHeartGauge(p: vec2<f32>) -> f32 {
        let gSq = (abs(p.x) + abs(p.y)) / 0.70710678;
        let c = vec2<f32>(0.35355339, 0.35355339);
        return min(gSq, min(htDiscGauge(p, c), htDiscGauge(p, vec2<f32>(-c.x, c.y))));
      }
      // Upward equilateral triangle, inradius 1, centroid at the origin.
      fn htTriangleGauge(p: vec2<f32>) -> f32 {
        return max(-p.y, max(0.8660254 * p.x + 0.5 * p.y, -0.8660254 * p.x + 0.5 * p.y));
      }
      // Figurative shapes do not tile, so the last tones fill in with a square growing from the cell centre
      // (starts at 0.6, reaches the cell edge at 1) - the cell still goes solid smoothly instead of all at once.
      fn htFillTail(t: f32, cx: f32, cy: f32) -> f32 {
        return min(t, 0.6 + 0.4 * max(abs(cx), abs(cy)) * 2.0);
      }

      // Generate a halftone threshold for a rotated cell grid.
      // Returns 0..1 threshold value. ctr = the texture centre in pre-patternScale pixels (the rings / spiral origin).
      fn halftoneThreshold(px: f32, py: f32, angle: f32, freq: f32, shape: i32, texW: f32, texH: f32, ctr: vec2<f32>) -> f32 {
        let r = halftoneRot(px, py, angle, freq, texW);
        let rx = r.x;
        let ry = r.y;

        // Position within cell (fractional part), centered at 0
        let cx = fract(rx) - 0.5;
        let cy = fract(ry) - 0.5;

        var threshold: f32;
        switch shape {
          // Dot (radial)
          case 0: {
            let dist = sqrt(cx * cx + cy * cy) * 1.4142; // normalize √2 → max ~1
            threshold = dist;
          }
          // Line (horizontal bands in rotated space)
          case 1: {
            threshold = abs(cy) * 2.0;
          }
          // Square (Chebyshev)
          case 3: {
            threshold = max(abs(cx), abs(cy)) * 2.0;
          }
          // Cross: a plus whose arms reach the cell edges at 0.5, then thicken into a grid
          case 4: {
            let ax = abs(cx);
            let ay = abs(cy);
            threshold = max(min(ax, ay) * 2.0, max(ax, ay));
          }
          // Ellipse (chain dot): y weighted 1.5x, so dots touch along x first and join into chains in the midtones
          case 5: {
            threshold = length(vec2<f32>(cx, cy * 1.5)) / 0.9013878;
          }
          // Wavy lines: the line screen with a sine offset along the line (period 3 cells, amplitude 0.3 cell)
          case 6: {
            let wy = ry + 0.3 * sin(rx * (HT_TAU / 3.0));
            threshold = abs(fract(wy) - 0.5) * 2.0;
          }
          // Crosshatch: one line direction for the light tones, the perpendicular set joins from 0.45 on
          case 7: {
            threshold = min(abs(cy) * 2.0, 0.45 + 0.55 * abs(cx) * 2.0);
          }
          // Concentric rings (GLOBAL): distance from the texture centre, one ring per cell width
          case 8: {
            let d = length(vec2<f32>(px, py) - ctr) * (freq / texW);
            threshold = abs(fract(d) - 0.5) * 2.0;
          }
          // Spiral (GLOBAL): one Archimedean arm around the texture centre, arm spacing one cell width,
          // the screen angle rotates it
          case 9: {
            let v = vec2<f32>(px, py) - ctr;
            let d = length(v) * (freq / texW);
            let a = atan2(v.y, v.x) - angle;
            threshold = abs(fract(d - a / HT_TAU) - 0.5) * 2.0;
          }
          // Hexagon: honeycomb cells, hex distance to the nearest centre (1 on the shared edges)
          case 10: {
            let o = abs(htHexOffset(r));
            threshold = max(o.x, dot(o, vec2<f32>(0.5, 0.8660254))) * 2.0;
          }
          // Star: 5 points, tips touch the cell edge at 0.625
          case 11: {
            threshold = htFillTail(htStarGauge(vec2<f32>(cx, -cy)) * 1.25, cx, cy);
          }
          // Heart: full cell width at about 0.85 (origin a little below the cell centre so the heart sits centred)
          case 12: {
            threshold = htFillTail(htHeartGauge(vec2<f32>(cx, -cy) * 1.45 + vec2<f32>(0.0, 0.0732)), cx, cy);
          }
          // Triangle: full cell width at about 0.85 (centroid 0.12 below the cell centre)
          case 13: {
            threshold = htFillTail(htTriangleGauge(vec2<f32>(cx, 0.12 - cy)) / 0.34, cx, cy);
          }
          // Diamond (2, and the fallback)
          default: {
            threshold = (abs(cx) + abs(cy));
          }
        }

        return clamp(threshold, 0.0, 1.0);
      }

      // The screen-cell INDEX a pixel falls in (same rotate math as halftoneThreshold) - the unit
      // the edge-density dropout removes, so dots vanish as whole dots. Hexagon uses its honeycomb
      // cell (id = centre * (2, 2 / sqrt3)); every other shape, the global rings / spiral included,
      // drops square cells of the rotated grid (as the line screen does: whole line segments).
      fn halftoneCell(px: f32, py: f32, angle: f32, freq: f32, texW: f32, texH: f32, shape: i32) -> vec2<i32> {
        let r = halftoneRot(px, py, angle, freq, texW);
        if (shape == 10) {
          let c = r - htHexOffset(r);
          return vec2<i32>(i32(round(c.x * 2.0)), i32(round(c.y * (2.0 / HT_SQRT3))));
        }
        return vec2<i32>(i32(floor(r.x)), i32(floor(r.y)));
      }

      // Inverse of halftoneCell: the cell CENTRE back in pre-patternScale pixel coords - the one
      // point the density dropout evaluates the edge factor at (all-or-nothing per dot).
      fn halftoneCellCenterPx(cell: vec2<i32>, angle: f32, freq: f32, texW: f32, texH: f32, shape: i32) -> vec2<f32> {
        var c = vec2<f32>(f32(cell.x) + 0.5, f32(cell.y) + 0.5);
        if (shape == 10) { c = vec2<f32>(f32(cell.x) * 0.5, f32(cell.y) * (HT_SQRT3 * 0.5)); }
        let cs = cos(angle);
        let sn = sin(angle);
        let nx = c.x * cs + c.y * sn;      // inverse rotation = transpose
        let ny = -c.x * sn + c.y * cs;
        let scale = freq / texW;
        return vec2<f32>(nx / scale, ny / scale);   // same scale on both axes (square cells)
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gidIn: vec3<u32>) {
        let dim = textureDimensions(output);
        ${WGSL_REGION_HEAD}
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let shape = i32(params[0].y);
        let strength = params[0].z;
        let patternScale = params[0].w;
        let angle = params[1].x;
        let freq = params[1].y;
        let perChannel = params[1].z > 0.5;
        let texW = params[2].x;
        let texH = params[2].y;

        let px = f32(gid.x) / patternScale;
        let py = f32(gid.y) / patternScale;

        let ctr = vec2<f32>(texW, texH) * (0.5 / patternScale);   // texture centre, pre-patternScale (rings / spiral)
        let threshold = halftoneThreshold(px, py, angle, freq, shape, texW, texH, ctr);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // Edge effects: es.x = fade strength multiplier, es.y = coverage shrink, es.z = edge factor.
        let es = edgeState(coords);
        // Density: drop whole screen CELLS near the edge — ALL-OR-NOTHING per dot (edge factor
        // evaluated once at the cell centre), and a dropped cell renders the PAPER state so the
        // pattern gets SPARSER (rev 2, 2026-09-15 — strength-0 dropout wrongly revealed the
        // original artwork; that's edgeFade's job). params[3].y = the dropout seed.
        var cellDropped = false;
        let edgeDensity = params[7].w;
        if (edgeDensity > 0.001 && params[7].x >= 0.5) {   // edgeWidth 0 = edge effects off: no edgeAt taps
          let cell = halftoneCell(px, py, angle, freq, texW, texH, shape);
          let centerPx = halftoneCellCenterPx(cell, angle, freq, texW, texH, shape) * patternScale;
          let eCell = edgeAt(vec2<i32>(centerPx), params[7].x);
          if (edgeCellRand(cell, u32(params[3].y)) > 1.0 - edgeDensity * (1.0 - eCell)) { cellDropped = true; }
        }

        // A density-dropped cell is ERASED — fully transparent, independent of the FG/BG colors
        // (rev 3, 2026-09-15 — the rev-2 force-to-BG turned solid after a Swap).
        if (cellDropped) {
          textureStore(output, coords, vec4<f32>(0.0));
          return;
        }

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        var duoSmooth = 0.0;   // the duotone level before quantizing: the flat tone its pattern averages to
        if (isDuotone) {
          // Shrink: ramp the bias toward the direction-aware landing extreme — positive shrink
          // always makes the DOTS smaller until they vanish (rev 4: with bias > 0.5 the dots are
          // the BG phase, so the ramp goes toward all-FG; the old toward-0 rule GREW them).
          duoSmooth = mix(duotoneBias, shrinkTargetBias(duotoneBias), es.y);
          let ditheredLum = quantize(duoSmooth + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, es.y) + bias, colorLevels),
            quantize(mix(src.g, tq, es.y) + bias, colorLevels),
            quantize(mix(src.b, tq, es.y) + bias, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), es.y);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength, es.x, duoSmooth);
        textureStore(output, coords, col);
      }
    `;

    this.halftoneBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },   // content-edge seeds
      ],
    });

    this.halftonePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.halftoneBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── White Noise Dithering ──────────────────────────────────────

  private applyNoise(srcTex: GPUTexture, outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder, r: DitherTexelRect, seed: number): void {
    this.ensureNoisePipeline();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = seed; // seed (apply(): the frame counter; applyRegion(): the caller's fixed seed)
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.noiseBGL!,
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 7, resource: this.curSeedsView! },
      ],
    });

    this.dispatch(this.noisePipeline!, bg, r, enc);
  }

  private ensureNoisePipeline(): void {
    if (this.noisePipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 10>;

      // PCG hash for deterministic random from pixel coord + seed
      fn pcgHash(input: u32) -> u32 {
        var state = input * 747796405u + 2891336453u;
        let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
        return (word >> 22u) ^ word;
      }

      fn rand01(x: u32, y: u32, seed: u32) -> f32 {
        let h = pcgHash(x + pcgHash(y + pcgHash(seed)));
        return f32(h) / 4294967295.0;
      }

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gidIn: vec3<u32>) {
        let dim = textureDimensions(output);
        ${WGSL_REGION_HEAD}
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let strength = params[0].y;
        let perChannel = params[0].z > 0.5;
        let seed = u32(params[0].w);

        let threshold = rand01(gid.x, gid.y, seed);
        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // Edge effects. Stochastic pattern: "density" IS coverage here, so it folds into shrink.
        let es = edgeState(coords);
        // Stochastic pattern: density IS coverage, so its nearness folds into shrink's
        // (multiplicative survival — matches the old two-factor multiply for positive shrink).
        let nTot = 1.0 - (1.0 - es.y) * (1.0 - (1.0 - es.z) * params[7].w);

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        var duoSmooth = 0.0;   // the duotone level before quantizing: the flat tone its pattern averages to
        if (isDuotone) {
          duoSmooth = mix(duotoneBias, shrinkTargetBias(duotoneBias), nTot);
          let ditheredLum = quantize(duoSmooth + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, nTot) + bias, colorLevels),
            quantize(mix(src.g, tq, nTot) + (rand01(gid.x + 1000u, gid.y, seed) - 0.5) * spread, colorLevels),
            quantize(mix(src.b, tq, nTot) + (rand01(gid.x, gid.y + 1000u, seed) - 0.5) * spread, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), nTot);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength, es.x, duoSmooth);
        textureStore(output, coords, col);
      }
    `;

    this.noiseBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },   // content-edge seeds
      ],
    });

    this.noisePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.noiseBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  // ─── Blue Noise Dithering ───────────────────────────────────────

  private applyBlueNoise(srcTex: GPUTexture, outTex: GPUTexture, w: number, h: number, cfg: DitherConfig, enc: GPUCommandEncoder, r: DitherTexelRect): void {
    this.ensureBlueNoisePipeline();
    this.ensureBlueNoiseTexture();

    const params = new Float32Array(16);
    params[0] = cfg.colorLevels;
    params[1] = cfg.strength;
    params[2] = cfg.perChannel ? 1.0 : 0.0;
    params[3] = cfg.patternScale;
    params[12] = DitherEngine.edgeModeIndex(cfg);   // params[3].x: edge mode
    params[13] = Math.abs(Math.floor(cfg.edgeSeed ?? 0)) % 1e9;   // params[3].y: dropout seed
    this.device.queue.writeBuffer(this.paramsBuf, 0, params);
    this.writeColorUniforms(cfg);

    const bg = this.device.createBindGroup({
      layout: this.blueNoiseBGL!,
      entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: outTex.createView() },
        { binding: 2, resource: { buffer: this.paramsBuf } },
        { binding: 7, resource: this.curSeedsView! },
        { binding: 3, resource: this.blueNoiseTexture!.createView() },
        { binding: 4, resource: this.blueNoiseSampler! },
      ],
    });

    this.dispatch(this.blueNoisePipeline!, bg, r, enc);
  }

  private ensureBlueNoisePipeline(): void {
    if (this.blueNoisePipeline) return;

    this.blueNoiseSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var<uniform> params: array<vec4<f32>, 10>;
      @group(0) @binding(3) var bnTex: texture_2d<f32>;
      @group(0) @binding(4) var bnSamp: sampler;

      fn luminance(c: vec3<f32>) -> f32 {
        return dot(c, vec3<f32>(0.299, 0.587, 0.114));
      }

      fn quantize(val: f32, levels: f32) -> f32 {
        let step = 1.0 / (levels - 1.0);
        return round(val * (levels - 1.0)) * step;
      }

      ${WGSL_APPLY_COLOR_MAPPING}
      ${WGSL_EDGE_HELPERS}
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gidIn: vec3<u32>) {
        let dim = textureDimensions(output);
        ${WGSL_REGION_HEAD}
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);
        if (src.a < 0.004) {
          textureStore(output, coords, src);
          return;
        }
        let colorLevels = params[0].x;
        let strength = params[0].y;
        let perChannel = params[0].z > 0.5;
        let patternScale = params[0].w;

        let bnDim = textureDimensions(bnTex);
        let uv = vec2<f32>(f32(gid.x), f32(gid.y)) / (vec2<f32>(f32(bnDim.x), f32(bnDim.y)) * patternScale);
        let threshold = textureSampleLevel(bnTex, bnSamp, uv, 0.0).r;

        let spread = 1.0 / colorLevels;
        let bias = (threshold - 0.5) * spread;

        // Edge effects. Stochastic pattern: "density" IS coverage here, so it folds into shrink.
        let es = edgeState(coords);
        // Stochastic pattern: density IS coverage — folds into shrink's nearness.
        let nTot = 1.0 - (1.0 - es.y) * (1.0 - (1.0 - es.z) * params[7].w);

        let isDuotone = params[4].x > 0.5;
        let duotoneBias = params[4].w;
        var dithered: vec3<f32>;
        var duoSmooth = 0.0;   // the duotone level before quantizing: the flat tone its pattern averages to
        if (isDuotone) {
          duoSmooth = mix(duotoneBias, shrinkTargetBias(duotoneBias), nTot);
          let ditheredLum = quantize(duoSmooth + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        } else if (perChannel) {
          let tq = shrinkTargetValue();
          dithered = vec3<f32>(
            quantize(mix(src.r, tq, nTot) + bias, colorLevels),
            quantize(mix(src.g, tq, nTot) + bias, colorLevels),
            quantize(mix(src.b, tq, nTot) + bias, colorLevels),
          );
        } else {
          let lum = mix(luminance(src.rgb), shrinkTargetValue(), nTot);
          let ditheredLum = quantize(lum + bias, colorLevels);
          dithered = vec3<f32>(ditheredLum);
        }

        let col = applyColorMapping(src.rgb, dithered, src.a, strength, es.x, duoSmooth);
        textureStore(output, coords, col);
      }
    `;

    this.blueNoiseBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },   // content-edge seeds
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });

    this.blueNoisePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.blueNoiseBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  /**
   * Generate a 64×64 blue noise threshold texture on the CPU using
   * a void-and-cluster approximation, then upload to GPU.
   */
  private ensureBlueNoiseTexture(): void {
    if (this.blueNoiseTexture) return;

    const SIZE = 64;
    const total = SIZE * SIZE;

    // --- Void-and-cluster approximation ---
    // 1. Seed random initial pattern (10% white pixels)
    const pattern = new Uint8Array(total);
    const initialWhiteCount = Math.floor(total * 0.1);
    const indices = Array.from({ length: total }, (_, i) => i);
    // Fisher-Yates shuffle for random placement
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let i = 0; i < initialWhiteCount; i++) pattern[indices[i]] = 1;

    // 2. Gaussian energy function (toroidal wrapping)
    const sigma = 1.5;
    const kernelR = 4;
    const gauss = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));

    const computeEnergy = (buf: Uint8Array, x: number, y: number): number => {
      let e = 0;
      for (let dy = -kernelR; dy <= kernelR; dy++) {
        for (let dx = -kernelR; dx <= kernelR; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ((x + dx) % SIZE + SIZE) % SIZE;
          const ny = ((y + dy) % SIZE + SIZE) % SIZE;
          if (buf[ny * SIZE + nx]) e += gauss(dx, dy);
        }
      }
      return e;
    };

    // 3. Iterative swap: move tightest cluster pixel to largest void (30 iterations)
    for (let iter = 0; iter < 30; iter++) {
      let maxE = -1, maxIdx = 0;
      let minE = Infinity, minIdx = 0;

      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const idx = y * SIZE + x;
          const e = computeEnergy(pattern, x, y);
          if (pattern[idx] === 1 && e > maxE) { maxE = e; maxIdx = idx; }
          if (pattern[idx] === 0 && e < minE) { minE = e; minIdx = idx; }
        }
      }

      if (maxIdx === minIdx) break;
      pattern[maxIdx] = 0;
      pattern[minIdx] = 1;
    }

    // 4. Rank all pixels by energy to produce the threshold map
    const energies = new Float32Array(total);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        energies[y * SIZE + x] = computeEnergy(pattern, x, y) + (pattern[y * SIZE + x] ? 1000 : 0);
      }
    }

    // Sort indices by energy, assign rank as threshold
    const ranked = Array.from({ length: total }, (_, i) => i);
    ranked.sort((a, b) => energies[a] - energies[b]);
    const thresholds = new Float32Array(total);
    for (let r = 0; r < total; r++) {
      thresholds[ranked[r]] = (r + 0.5) / total;
    }

    // 5. Upload as r8unorm GPU texture
    const pixels = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      pixels[i] = Math.round(thresholds[i] * 255);
    }

    this.blueNoiseTexture = this.device.createTexture({
      size: [SIZE, SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.device.queue.writeTexture(
      { texture: this.blueNoiseTexture },
      pixels,
      { bytesPerRow: SIZE },
      { width: SIZE, height: SIZE },
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private ensurePing(w: number, h: number): void {
    if (this.pingTex && this.pingW === w && this.pingH === h) return;
    this.pingTex?.destroy();
    this.pingTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.pingW = w;
    this.pingH = h;
  }

  // PERF (audit 5.7): records into the encoder owned by apply() (or the
  // caller's shared encoder) instead of creating + submitting its own —
  // the copy and dispatch now ride a single submit.
  private dispatch(pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, r: DitherTexelRect, enc: GPUCommandEncoder): void {
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));   // params[8] offsets it to the region
    pass.end();
    this.stats.dispatches++; this.stats.dispatchTexels += rw * rh;
  }
}
