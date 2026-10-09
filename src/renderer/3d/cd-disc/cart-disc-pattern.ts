/**
 * src/renderer/3d/cd-disc/cart-disc-pattern.ts
 *
 * The DEFAULT FrogCart disc print (a cart with no disc image): a procedurally generated, SEEDED wavy pattern drawn by
 * the Shell's CD shader. One seed picks a colour pair from a short curated soft-retro palette (sage / cream first),
 * the cell count, the warp
 * amplitude + frequency, the rotation and a warp phase: every cart looks different, but they belong together.
 * Only the WAVY CHECKER is drawn (2026-10-09: the user didn't like the stripes / dots families — the shader keeps
 * them, CART_DISC_FAMILIES still parses stored refs, but every seed and every pinned family resolves to the checker).
 *
 * The warp + checker field are the edit modes' "Wavy" / "Clover Picnic" focus-background maths (WAVY_PATTERN_WGSL),
 * not a second copy. Seed source: manifest.cdPattern in the .frogcart (written by the export dialog; ↻ re-rolls it);
 * a cart without one uses cartDiscSeedFromId(its id). Pure + deterministic (unit-tested).
 */

import { WAVY_PATTERN_WGSL } from '../shaders/wavy-pattern-wgsl';

export type CartDiscFamily = 'checker' | 'stripes' | 'dots';
export const CART_DISC_FAMILIES: readonly CartDiscFamily[] = ['checker', 'stripes', 'dots'];

/** What a cart stores (manifest.cdPattern / ShellSlot.cdPattern): the seed, and optionally a pinned family. */
export interface CartDiscPatternRef { seed: number; family?: CartDiscFamily }

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** The curated colour pairs (ink, paper), soft retro. Sage / cream first (the reference look). */
export const CART_DISC_PALETTES: readonly { name: string; ink: string; paper: string }[] = [
  { name: 'Sage',       ink: '#8ba36c', paper: '#fdebd3' },
  { name: 'Dusty Blue', ink: '#7f9fbf', paper: '#f8ecd6' },
  { name: 'Terracotta', ink: '#c97b5d', paper: '#fbe8cf' },
  { name: 'Mustard',    ink: '#d4a443', paper: '#fdf1dc' },
  { name: 'Lilac',      ink: '#a593c2', paper: '#faeee0' },
  { name: 'Teal',       ink: '#5e9c97', paper: '#f6ead3' },
  { name: 'Rose',       ink: '#d68e8e', paper: '#fdeee2' },
  { name: 'Olive',      ink: '#999a55', paper: '#f7eedb' },
];

/** The resolved shader parameters of one seeded pattern. */
export interface CartDiscPattern {
  seed: number;
  family: CartDiscFamily;
  palette: number;
  /** Ink (first-colour cells) and paper colours, linear-ish sRGB 0..1 as stored (the Shell writes them straight). */
  ink: RGB;
  paper: RGB;
  /** Cells across the disc diameter. */
  cells: number;
  /** Warp amplitude (first layer; the second is half) and frequency (warp periods per disc unit). */
  amp: number;
  freq: number;
  /** Pattern rotation (radians) and warp phase (x, y). */
  rot: number;
  phase: [number, number];
  /** Dot radius (cell units) for the dots family. */
  dotR: number;
}

/** mulberry32: a tiny, well-mixed 32-bit PRNG (the same seed → the same sequence on every machine). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** murmur3's 32-bit finaliser: spreads nearby seeds over the whole range. */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A stable 32-bit seed for a cart id (FNV-1a) — the pattern of a cart that never stored one. */
export function cartDiscSeedFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** A fresh random seed (the export dialog's ↻ shuffle). */
export function randomCartDiscSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * 4294967296) >>> 0;
}

/** True for a valid stored pattern ref (manifest / registry data is untrusted). */
export function isCartDiscPatternRef(v: unknown): v is CartDiscPatternRef {
  if (!v || typeof v !== 'object') return false;
  const o = v as { seed?: unknown; family?: unknown };
  return typeof o.seed === 'number' && Number.isFinite(o.seed)
    && (o.family === undefined || (CART_DISC_FAMILIES as readonly unknown[]).includes(o.family));
}

/** A clean stored ref (seed as uint32; family only when valid). Null for anything else. */
export function normalizeCartDiscPatternRef(v: unknown): CartDiscPatternRef | null {
  if (!isCartDiscPatternRef(v)) return null;
  const ref: CartDiscPatternRef = { seed: Math.floor(v.seed) >>> 0 };
  if (v.family) ref.family = v.family;
  return ref;
}

/** Resolve a seed (+ an optional pinned family) to the pattern's parameters. Deterministic. */
export function cartDiscPattern(seed: number, family?: CartDiscFamily): CartDiscPattern {
  const r = prng(mix32(seed));   // mixed first: neighbouring seeds (1, 2, 3 …) must not start alike
  const palette = Math.floor(r() * CART_DISC_PALETTES.length) % CART_DISC_PALETTES.length;
  r();                                                             // (was the family roll — kept so a seed's other params stay put)
  void family;                                                     // a pinned stripes / dots family draws the checker too
  const fam: CartDiscFamily = 'checker';
  const p = CART_DISC_PALETTES[palette];
  const cells = 6 + Math.floor(r() * 4);                           // 6..9
  const amp = 0.12 + r() * 0.16;                                   // 0.12..0.28 warp amplitude (smooth, never swirly)
  const freq = 0.85 + r() * 0.75;                                  // 0.85..1.6 warp periods / unit
  const rot = (r() - 0.5) * (Math.PI / 2);                         // -45..45 degrees
  const phase: [number, number] = [r() * 6.2832, r() * 6.2832];
  const dotR = 0.30 + r() * 0.06;
  return { seed: seed >>> 0, family: fam, palette, ink: hex(p.ink), paper: hex(p.paper), cells, amp, freq, rot, phase, dotR };
}

const _memo = new Map<string, CartDiscPattern>();
/** cartDiscPattern, memoised (the Shell resolves a pattern per tile per frame). */
export function cartDiscPatternCached(ref: CartDiscPatternRef): CartDiscPattern {
  const key = `${ref.seed >>> 0}|${ref.family ?? ''}`;
  let p = _memo.get(key);
  if (!p) {
    p = cartDiscPattern(ref.seed, ref.family);
    if (_memo.size > 256) _memo.clear();
    _memo.set(key, p);
  }
  return p;
}

/** The family's shader code (patA.w). */
export function cartDiscFamilyCode(f: CartDiscFamily): number { return f === 'checker' ? 0 : f === 'stripes' ? 1 : 2; }

/**
 * Pattern uniforms in the Shell CD layout, written into `out` at float offset `o`:
 *   patA (o)      = ink.rgb, family code
 *   patB (o + 4)  = paper.rgb, cells
 *   face (o + 8)  = amp, freq, rot, (mode: left to the caller)
 *   patC (o + 16) = phase.x, phase.y, dotR, 0     (after the uvRect slot at o + 12)
 */
export function writeCartDiscPatternUniforms(out: Float32Array, o: number, p: CartDiscPattern): void {
  out[o] = p.ink[0]; out[o + 1] = p.ink[1]; out[o + 2] = p.ink[2]; out[o + 3] = cartDiscFamilyCode(p.family);
  out[o + 4] = p.paper[0]; out[o + 5] = p.paper[1]; out[o + 6] = p.paper[2]; out[o + 7] = p.cells;
  out[o + 8] = p.amp; out[o + 9] = p.freq; out[o + 10] = p.rot;
  out[o + 16] = p.phase[0]; out[o + 17] = p.phase[1]; out[o + 18] = p.dotR; out[o + 19] = 0;
}

/**
 * CPU reference of the pattern (ink coverage 0..1 at disc-plane point x, y in -1..1, y up) — mirrors the WGSL
 * cart_disc_pattern below (minus the derivative-based anti-aliasing), for tests and CPU previews.
 */
export function cartDiscPatternInk(p: CartDiscPattern, x: number, y: number, blur = 0.06): number {
  const cr = Math.cos(p.rot), sr = Math.sin(p.rot);
  const qx = x * cr - y * sr, qy = x * sr + y * cr;
  const f = Math.max(p.freq, 0.01);
  const sx = qx * f + p.phase[0], sy = qy * f + p.phase[1];
  const a1 = p.amp, a2 = p.amp * 0.5;
  const w1x = Math.sin(sy * 2.1 + Math.sin(sx * 1.4) * 1.1), w1y = Math.sin(sx * 2.6 + Math.sin(sy * 1.8) * 0.9);
  const p1x = sx + w1x * a1, p1y = sy + w1y * a1;
  const p2x = p1x + Math.sin(p1y * 3.5) * a2, p2y = p1y + Math.sin(p1x * 3.1) * a2;
  const cx = (qx + (p2x - sx) / f) * p.cells * 0.5, cy = (qy + (p2y - sy) / f) * p.cells * 0.5;
  const ss = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  if (p.family === 'checker') return ss(-blur, blur, Math.sin(cx * Math.PI) * Math.sin(cy * Math.PI));
  if (p.family === 'stripes') return ss(-blur * 2, blur * 2, Math.sin(cx * Math.PI));
  const row = Math.floor(cy);
  const ox = cx + 0.5 * (row - 2 * Math.floor(row * 0.5));
  const gx = ox - Math.floor(ox) - 0.5, gy = cy - Math.floor(cy) - 0.5;
  return 1 - ss(p.dotR - blur * 0.5, p.dotR + blur * 0.5, Math.hypot(gx, gy));
}

/**
 * WGSL: the seeded pattern colour at disc-plane point lxy (-1..1, y up). patA / patB / face / patC as packed by
 * writeCartDiscPatternUniforms. Call it in UNIFORM control flow (it takes derivatives for the anti-aliasing).
 */
export const CART_DISC_PATTERN_WGSL = /* wgsl */ `
${WAVY_PATTERN_WGSL}
fn cart_disc_pattern(lxy: vec2<f32>, patA: vec4<f32>, patB: vec4<f32>, face: vec4<f32>, patC: vec4<f32>) -> vec3<f32> {
    let cr = cos(face.z);
    let sr = sin(face.z);
    let q = vec2<f32>(lxy.x * cr - lxy.y * sr, lxy.x * sr + lxy.y * cr);
    let fq = max(face.y, 0.01);
    let s = q * fq + patC.xy;
    let d = (wavy_warp(s, 0.0, face.x, face.x * 0.5) - s) / fq;   // the warp displacement, in disc units
    let c = (q + d) * patB.w * 0.5;                                 // cell coordinates: patB.w cells across the disc
    // Anti-aliasing: about one pixel of soft step, in the field's own units (sin of a cell coordinate).
    let px = length(fwidth(c));
    let blur = clamp(px * 2.4, 0.04, 0.9);
    let kc = wavy_checker(c, blur);
    let ks = smoothstep(-blur * 2.0, blur * 2.0, sin(c.x * 3.14159265));
    let row = floor(c.y);
    let ox = c.x + 0.5 * (row - 2.0 * floor(row * 0.5));          // every other row of dots offset by half a cell
    let g = vec2<f32>(fract(ox), fract(c.y)) - vec2<f32>(0.5);
    let kd = 1.0 - smoothstep(patC.z - blur * 0.5, patC.z + blur * 0.5, length(g));
    let k = select(select(kd, ks, patA.w < 1.5), kc, patA.w < 0.5);
    return mix(patB.rgb, patA.rgb, k);
}
`;
