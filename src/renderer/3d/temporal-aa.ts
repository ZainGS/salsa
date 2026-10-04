/**
 * TEMPORAL ANTI-ALIASING + TEMPORAL UPSCALING (engine-roadmap step 6; performance-plan.md §P18; docs/ui/performance.md
 * §Temporal anti-aliasing and upscaling).
 *
 * Modes (`sm.setTemporalAA3D({ mode, scale, sharpen })`, a per-machine viewport preference like resolution scaling):
 *  - 'off'  (default): nothing changes (FXAA / the resolution-scaling upscale as before).
 *  - 'taa'  : native-resolution TAA instead of FXAA. The 3D scene renders through the lo-res target at full size.
 *  - 'taau' : temporal upscaling. The 3D scene renders at `scale` (default 0.65) of the canvas, or at the resolution
 *             scaler's scale when that is on (Fixed / Auto choose it), and the resolve reconstructs a full-size image.
 *
 * How a frame works (Renderer3D drives it; the host only adds two calls in the lo-res branch):
 *  1. JITTER: the camera projection gets a sub-pixel Halton(2, 3) offset while the 3D scene records (the scene uniform,
 *     so the GPU-driven path, the prepasses, SSAO / SSR, particles and grease pencil all see it). It is cleared before
 *     the overlay pass, so gizmos, grids and the 2D UI stay unjittered and crisp at full size.
 *  2. VELOCITY: a small pass over the movers (meshes whose matrix changed this frame: traffic, trains, the Play
 *     character's rigid parts) and the skinned meshes (previous skin matrices) writes screen-space motion into an
 *     rg16float target, depth-tested against the scene depth (read-only). Everything else gets camera reprojection
 *     from the depth buffer in the resolve. (Wind sway and the PS1 wobble are not tracked: sway is sub-pixel per frame
 *     and the neighbourhood clamp absorbs it; the PS1 looks force TAA off.)
 *  3. RESOLVE (full size): reconstruct the current frame from the 3x3 lo-res neighbourhood at the jittered sample
 *     positions, reproject the history (Catmull-Rom), reject disocclusions with a stored closest-depth history, clip
 *     the history to the YCoCg variance box (tighter for fast movers), and blend luminance-weighted.
 *  4. BLIT: the history is drawn into the main pass with a clamped sharpen (premultiplied alpha, so the 2D layers
 *     under the 3D scene still show through). The lo-res depth is still upsampled for the overlays.
 *
 * The dither fades (fog horizon band, HLOD cross-fade) shift their Bayer pattern every frame while TAA runs (scene
 * float 259), so the resolve averages them into smooth fades.
 *
 * Pure helpers (settings, Halton, matrix maths, uniform packing) are unit-tested in temporal-aa.test.ts.
 */
import { PipelineSet, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
import { PP_FULLSCREEN_VS } from './shaders/post-process-shaders';
import { SKIN_BLEND_WGSL } from './dual-quat-skin';

export type TemporalAAMode = 'off' | 'taa' | 'taau';

export interface TemporalAASettings {
  /** 'off' (default) | 'taa' (native resolution, replaces FXAA) | 'taau' (render at `scale`, reconstruct full size). */
  mode: TemporalAAMode;
  /** TAAU internal scale (0.5..1, default 0.65). Ignored while resolution scaling (Fixed / Auto) picks the scale. */
  scale: number;
  /** Output sharpening 0..1 (default 0.3; clamped to the local min / max, so it never rings). */
  sharpen: number;
  /** The retro / pixel looks (PS1 lo-res, vertex snap, ordered dither) force TAA off (default true). */
  retroOff: boolean;
  /** Ink-outline looks (the outline pass on) force TAA off (default false: the ink resolves cleanly). */
  inkOff: boolean;
}

export const DEFAULT_TEMPORAL_AA: Readonly<TemporalAASettings> = Object.freeze({
  mode: 'off', scale: 0.65, sharpen: 0.3, retroOff: true, inkOff: false,
});

/** Why TAA did or did not run on the last 3D frame. */
export type TemporalAAReason = 'off' | 'ok' | 'retro' | 'ink' | 'capture' | 'compiling';

/** What getTemporalAA3D reports. */
export interface TemporalAAState extends TemporalAASettings {
  /** TAA ran on the last 3D frame. */
  active: boolean;
  reason: TemporalAAReason;
  /** The scale the 3D scene rendered at on the last TAA frame (1 = native). */
  renderScale: number;
  /** Jitter sequence length (16 for TAA, 32 for TAAU). */
  samples: number;
  /** Movers / skinned parts in the last velocity pass. */
  velocityDraws: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);

/** Merge a patch onto `base`, clamping every field. Unknown / bad values keep the base value. */
export function sanitizeTemporalAA(patch: Partial<TemporalAASettings> | null | undefined,
    base: TemporalAASettings = DEFAULT_TEMPORAL_AA): TemporalAASettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<TemporalAASettings>;
  const mode: TemporalAAMode = p.mode === 'off' || p.mode === 'taa' || p.mode === 'taau' ? p.mode : base.mode;
  return {
    mode,
    scale: clamp(num(p.scale, base.scale), 0.5, 1),
    sharpen: clamp(num(p.sharpen, base.sharpen), 0, 1),
    retroOff: typeof p.retroOff === 'boolean' ? p.retroOff : base.retroOff,
    inkOff: typeof p.inkOff === 'boolean' ? p.inkOff : base.inkOff,
  };
}

/** The internal render scale for a TAA frame. `userScale` = the resolution scaler's scale (1 when off),
 *  `dynScale` = the camera-motion drop, `scalerActive` = resolution scaling is Fixed / Auto (it picks the TAAU scale). */
export function temporalRenderScale(s: TemporalAASettings, userScale: number, dynScale: number, scalerActive: boolean): number {
  const u = clamp(num(userScale, 1), 0.25, 1), d = clamp(num(dynScale, 1), 0.25, 1);
  if (s.mode === 'taau') return Math.min(scalerActive ? u : s.scale, d);
  return Math.min(u, d);
}

/** Jitter sequence length per mode. */
export function temporalSamples(mode: TemporalAAMode): number { return mode === 'taau' ? 32 : 16; }

/** The radical inverse of `index` in `base` (Halton sequence; index >= 1 gives values in (0, 1)). */
export function halton(index: number, base: number): number {
  let f = 1, r = 0, i = Math.max(0, Math.floor(index));
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/** Frame `frame`'s sub-pixel jitter in render-target pixels, each in [-0.5, 0.5): Halton(2, 3) over `n` samples. */
export function temporalJitter(frame: number, n: number, out: [number, number] = [0, 0]): [number, number] {
  const k = (((Math.floor(frame) % n) + n) % n) + 1;
  out[0] = halton(k, 2) - 0.5; out[1] = halton(k, 3) - 0.5;
  return out;
}

/** The dither-shift index (scene float 259) for frame `frame`: the inverse-Bayer order, so any 4 consecutive frames
 *  cover the 4x4 thresholds evenly and 16 frames visit every pixel offset once (the fade then averages exactly). */
export const DITHER_SHIFT_ORDER: readonly number[] = [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12];
export function temporalDitherShift(frame: number): number { return DITHER_SHIFT_ORDER[((Math.floor(frame) % 16) + 16) % 16]; }

/** Pixel jitter -> the NDC offset the camera applies (NDC y points up, pixel y down). */
export function jitterToNdc(jx: number, jy: number, w: number, h: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = (2 * jx) / Math.max(1, w); out[1] = (-2 * jy) / Math.max(1, h);
  return out;
}

/** Undo Camera3D's jitter on a view-projection (the jitter is T(jx, jy) * P, so the inverse is exact). */
export function unjitterViewProj(out: Float32Array, vp: ArrayLike<number>, jxNdc: number, jyNdc: number): Float32Array {
  for (let c = 0; c < 4; c++) {
    const w = vp[c * 4 + 3];
    out[c * 4] = vp[c * 4] - jxNdc * w; out[c * 4 + 1] = vp[c * 4 + 1] - jyNdc * w;
    out[c * 4 + 2] = vp[c * 4 + 2]; out[c * 4 + 3] = w;
  }
  return out;
}

/** 4x4 inverse (column-major). Returns false when singular (out untouched). */
export function invert4(out: Float32Array, m: ArrayLike<number>): boolean {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !isFinite(det)) return false;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

/** A camera cut: the view moved so much that the history is useless (a teleport, a mode switch). Compares where the
 *  centre and two corners of the screen at mid depth land between the two view-projections. */
export function isCameraCut(prevVP: ArrayLike<number>, curInvVP: ArrayLike<number>, thresholdNdc = 1.0): boolean {
  const pts = [[0, 0], [-0.8, -0.8], [0.8, 0.8]];
  for (const [x, y] of pts) {
    const z = 0.98;   // deep into the view (perspective depth is hyperbolic: 0.5 sits right at the near plane)
    const wx = curInvVP[0] * x + curInvVP[4] * y + curInvVP[8] * z + curInvVP[12];
    const wy = curInvVP[1] * x + curInvVP[5] * y + curInvVP[9] * z + curInvVP[13];
    const wz = curInvVP[2] * x + curInvVP[6] * y + curInvVP[10] * z + curInvVP[14];
    const ww = curInvVP[3] * x + curInvVP[7] * y + curInvVP[11] * z + curInvVP[15];
    if (!(Math.abs(ww) > 1e-12)) return true;
    const px = wx / ww, py = wy / ww, pz = wz / ww;
    const cx = prevVP[0] * px + prevVP[4] * py + prevVP[8] * pz + prevVP[12];
    const cy = prevVP[1] * px + prevVP[5] * py + prevVP[9] * pz + prevVP[13];
    const cw = prevVP[3] * px + prevVP[7] * py + prevVP[11] * pz + prevVP[15];
    if (!(cw > 1e-9)) return true;
    if (Math.hypot(cx / cw - x, cy / cw - y) > thresholdNdc) return true;
  }
  return false;
}

/** Inputs of the resolve uniform (see packTaaParams). */
export interface TaaResolveInputs {
  invVP: ArrayLike<number>; prevVP: ArrayLike<number>; curVP: ArrayLike<number>;
  loW: number; loH: number; outW: number; outH: number;
  jitterX: number; jitterY: number;   // render-target pixels
  depthMin: number;                   // the scene depth range minimum (ortho depth remap), 0 = plain [0, 1]
  ortho: boolean;
  historyValid: boolean;
  /** Base weight of the new frame (0.1 TAA / 0.08 TAAU). */
  blend: number;
  /** Extra new-frame weight at high motion. */
  motionBlend: number;
  /** Variance-clip box size in standard deviations. */
  gamma: number;
  /** Disocclusion: relative depth tolerance. */
  depthTol: number;
  /** Debug view (0 = off): 1 this frame only, 2 rejected pixels, 3 object velocity. */
  debug?: number;
}

/** Pack the resolve uniform (64 floats = 256 bytes). Layout = TAA_RESOLVE_FS `TaaParams`. Pure (tested). */
export function packTaaParams(out: Float32Array, p: TaaResolveInputs): Float32Array {
  for (let i = 0; i < 16; i++) { out[i] = p.invVP[i]; out[16 + i] = p.prevVP[i]; out[32 + i] = p.curVP[i]; }
  out[48] = p.loW; out[49] = p.loH; out[50] = p.outW; out[51] = p.outH;
  out[52] = p.jitterX; out[53] = p.jitterY; out[54] = p.depthMin; out[55] = p.ortho ? 1 : 0;
  out[56] = p.historyValid ? 1 : 0; out[57] = p.blend; out[58] = p.motionBlend; out[59] = p.gamma;
  out[60] = p.depthTol; out[61] = p.loW / Math.max(1, p.outW); out[62] = p.debug ?? 0; out[63] = 0;
  return out;
}

/** The velocity target's clear value: "no object velocity here, reproject with the camera". */
export const TAA_NO_VELOCITY = 20000;

// ── WGSL ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// RESOLVE (full size). Reconstruct the jittered lo-res frame at this output pixel, reproject the history, clip it to
// the neighbourhood and blend. Writes premultiplied colour (target 0, rgba16float) and the closest view depth of the
// nearest sample (target 1, r32float) for the next frame's disocclusion test.
export const TAA_RESOLVE_FS = /* wgsl */`
struct TaaParams {
  invVP:  mat4x4f,
  prevVP: mat4x4f,
  curVP:  mat4x4f,
  a: vec4f,
  b: vec4f,
  c: vec4f,
  d: vec4f,
};
@group(0) @binding(0) var curTex:    texture_2d<f32>;
@group(0) @binding(1) var curDepth:  texture_depth_2d;
@group(0) @binding(2) var velTex:    texture_2d<f32>;
@group(0) @binding(3) var histTex:   texture_2d<f32>;
@group(0) @binding(4) var histDepth: texture_2d<f32>;
@group(0) @binding(5) var linSamp:   sampler;
@group(0) @binding(6) var<uniform> P: TaaParams;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};
struct TaaOut {
  @location(0) color: vec4f,
  @location(1) depth: vec4f,
};

fn taaYCoCg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn taaRgb(c: vec3f) -> vec3f {
  let t = c.x - c.z;
  return vec3f(t + c.y, c.x + c.z, t - c.y);
}
// View-linear depth: perspective = clip w, ortho = clip z (both grow away from the eye).
fn taaLinear(clip: vec4f) -> f32 {
  return select(clip.w, clip.z, P.b.w > 0.5);
}
// History colour at uv: Catmull-Rom from 5 bilinear taps (the LOFI_SHARP_FS form), clamped to non-negative.
fn taaHistory(uv: vec2f) -> vec4f {
  let size = P.a.zw;
  let inv = 1.0 / size;
  let sp = uv * size;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (tp1 - 1.0) * inv;
  let t3 = (tp1 + 2.0) * inv;
  let t12 = (tp1 + w2 / w12) * inv;
  var c = textureSampleLevel(histTex, linSamp, vec2f(t12.x, t0.y), 0.0) * (w12.x * w0.y);
  c += textureSampleLevel(histTex, linSamp, vec2f(t0.x, t12.y), 0.0) * (w0.x * w12.y);
  c += textureSampleLevel(histTex, linSamp, t12, 0.0) * (w12.x * w12.y);
  c += textureSampleLevel(histTex, linSamp, vec2f(t3.x, t12.y), 0.0) * (w3.x * w12.y);
  c += textureSampleLevel(histTex, linSamp, vec2f(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(c / wsum, vec4f(0.0));
}
// Clip h toward the centre of the box [lo, hi] (the Playdead clip: keeps the hue, unlike a per-channel clamp).
fn taaClip(h: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
  let ctr = 0.5 * (lo + hi);
  let ext = 0.5 * (hi - lo) + vec3f(1e-5);
  let v = h - ctr;
  let u = abs(v / ext);
  let m = max(u.x, max(u.y, u.z));
  return select(h, ctr + v / m, m > 1.0);
}

@fragment fn fs_main(in: VsOut) -> TaaOut {
  let loSize = P.a.xy;
  let outSize = P.a.zw;
  let uv = in.pos.xy / outSize;
  let x = uv * loSize;          // this output pixel in lo-res pixel units (unjittered)
  let j = P.b.xy;               // lo-res texel i holds the scene at i + 0.5 - j
  let outPerLo = 1.0 / max(P.d.y, 1e-3);
  let maxI = vec2i(loSize) - vec2i(1);
  let i0 = vec2i(floor(x + j));

  var sumC = vec4f(0.0);
  var sumW = 0.0;
  var wMax = 0.0;
  var sumT = vec4f(0.0);
  var sumTW = 0.0;
  var m1 = vec4f(0.0);
  var m2 = vec4f(0.0);
  var bestD = 2.0;
  var bestI = clamp(i0, vec2i(0), maxI);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let ii = clamp(i0 + vec2i(dx, dy), vec2i(0), maxI);
      let s = textureLoad(curTex, ii, 0);
      let c = vec4f(s.rgb * s.a, s.a);
      let off = (vec2f(ii) + 0.5 - j) - x;
      let dOut = off * outPerLo;
      let w = exp(-2.29 * dot(dOut, dOut));
      let tw = max(0.0, 1.0 - abs(off.x)) * max(0.0, 1.0 - abs(off.y));
      sumC += c * w;
      sumW += w;
      wMax = max(wMax, w);
      sumT += c * tw;
      sumTW += tw;
      let yc = vec4f(taaYCoCg(c.rgb), c.a);
      m1 += yc;
      m2 += yc * yc;
      let dz = textureLoad(curDepth, ii, 0);
      if (dz < bestD) { bestD = dz; bestI = ii; }
    }
  }
  let spatial = sumT / max(sumTW, 1e-5);
  let cur = select(spatial, sumC / max(sumW, 1e-6), sumW > 1e-4);
  let mu = m1 / 9.0;
  let sigma = sqrt(abs(m2 / 9.0 - mu * mu));

  // World point of the closest sample, seen from this pixel (dilated depth: edges reproject with the foreground).
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let zn = (min(bestD, 1.0) - P.b.z) / max(1.0 - P.b.z, 1e-6);
  var wp = P.invVP * vec4f(ndc, zn, 1.0);
  wp = wp / wp.w;
  let pc = P.prevVP * wp;
  // The stored history depth is the NEAREST sample (not dilated): the one-sided test below then never fires on the
  // jitter-dependent 3x3 set at silhouettes, only where the nearest surface really was closer last frame.
  let nearD = textureLoad(curDepth, clamp(i0, vec2i(0), maxI), 0);
  var wn = P.invVP * vec4f(ndc, (min(nearD, 1.0) - P.b.z) / max(1.0 - P.b.z, 1e-6), 1.0);
  wn = wn / wn.w;
  let curLin = taaLinear(P.curVP * wn);

  let vel = textureLoad(velTex, bestI, 0).xy;
  let objVel = vel.x < 1000.0;
  let pn = pc.xy / max(abs(pc.w), 1e-9) * sign(pc.w);
  let camUV = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
  let prevUV = select(camUV, uv - vel, objVel);
  let behind = !objVel && P.b.w < 0.5 && pc.w <= 1e-6;
  let velPx = length((uv - prevUV) * outSize);

  var valid = P.c.x > 0.5 && !behind && all(prevUV >= vec2f(0.0)) && all(prevUV <= vec2f(1.0));
  // Disocclusion: the history held something CLOSER than this surface's expected previous depth (it was hidden).
  // expect comes from the dilated (closest) sample, the history from its nearest sample, so a silhouette compares
  // foreground with foreground or background with something no closer.
  let hd = textureLoad(histDepth, clamp(vec2i(prevUV * outSize), vec2i(0), vec2i(outSize) - vec2i(1)), 0).x;
  let expect = taaLinear(pc);
  let occluded = !objVel && hd < expect * (1.0 - P.d.x) - 1e-4;
  let hist = taaHistory(prevUV);

  var outC = spatial;
  if (valid && !occluded) {
    var hy = vec4f(taaYCoCg(hist.rgb), hist.a);
    let cy = vec4f(taaYCoCg(cur.rgb), cur.a);
    let moving = clamp(velPx / 8.0, 0.0, 1.0);
    let gamma = mix(P.c.w, 0.75, moving) * select(1.0, 0.8, objVel);
    let lo = min(mu - gamma * sigma, cy);
    let hi = max(mu + gamma * sigma, cy);
    hy = vec4f(taaClip(hy.xyz, lo.xyz, hi.xyz), clamp(hy.w, lo.w, hi.w));
    // New-frame weight: the base rate, more while moving (less resampling blur), less when no lo-res sample sits
    // near this output pixel (TAAU: those pixels mostly keep the history).
    let alpha = clamp((P.c.y + P.c.z * clamp(velPx / 16.0, 0.0, 1.0)) * mix(0.3, 1.0, wMax), 0.02, 1.0);
    let wc = alpha / (1.0 + cy.x);
    let wh = (1.0 - alpha) / (1.0 + hy.x);
    let bl = (cy * wc + hy * wh) / max(wc + wh, 1e-6);
    outC = vec4f(taaRgb(bl.xyz), bl.w);
  }
  // Debug views (TemporalAAPass.debug, P.d.z): 1 = this frame only (no history), 2 = rejected pixels red
  // (disocclusion) / blue (off-screen or invalid), 3 = object velocity green.
  let dbg = u32(P.d.z + 0.5);
  if (dbg == 1u) { outC = cur; }
  if (dbg == 2u) { if (occluded) { outC = vec4f(1.0, 0.0, 0.0, 1.0); } else if (!valid) { outC = vec4f(0.0, 0.0, 1.0, 1.0); } }
  if (dbg == 4u && textureLoad(velTex, clamp(i0, vec2i(0), maxI), 0).x < 1000.0) { outC = vec4f(1.0, 0.0, 1.0, 1.0); }
  if (dbg == 3u && objVel) { outC = vec4f(0.0, clamp(velPx / 8.0, 0.2, 1.0), 0.0, 1.0); }
  var o: TaaOut;
  o.color = max(outC, vec4f(0.0));
  o.depth = vec4f(curLin, 0.0, 0.0, 1.0);
  return o;
}
`;

// BLIT into the main pass: the resolved history (premultiplied) with a clamped 4-neighbour sharpen.
export const TAA_BLIT_FS = /* wgsl */`
@group(0) @binding(0) var histTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> S: vec4f;   // .x = sharpen amount (0..1)

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let m = vec2i(textureDimensions(histTex)) - vec2i(1);
  let c = textureLoad(histTex, clamp(p, vec2i(0), m), 0);
  let n = textureLoad(histTex, clamp(p + vec2i(0, -1), vec2i(0), m), 0);
  let s = textureLoad(histTex, clamp(p + vec2i(0, 1), vec2i(0), m), 0);
  let e = textureLoad(histTex, clamp(p + vec2i(1, 0), vec2i(0), m), 0);
  let w = textureLoad(histTex, clamp(p + vec2i(-1, 0), vec2i(0), m), 0);
  let lo = min(c, min(min(n, s), min(e, w)));
  let hi = max(c, max(max(n, s), max(e, w)));
  let avg = (n + s + e + w) * 0.25;
  let sharp = clamp(c + (c - avg) * S.x, lo, hi);
  return vec4f(sharp.rgb, c.a);
}
`;

// VELOCITY: screen-space motion (current - previous, in uv units, unjittered) of the movers and skinned meshes.
// Rasterised with the JITTERED view-projection so the depth test against the scene depth matches the main pass.
const TAA_VEL_COMMON = /* wgsl */`
struct VelU {
  jitVP:  mat4x4f,
  curVP:  mat4x4f,
  prevVP: mat4x4f,
};
struct VelDraw {
  cur:  mat4x4f,
  prev: mat4x4f,
};
@group(0) @binding(0) var<storage, read> draws: array<VelDraw>;
@group(0) @binding(1) var<uniform> U: VelU;

struct VelOut {
  @builtin(position) pos: vec4f,
  @location(0) cur:  vec4f,
  @location(1) prev: vec4f,
};
fn velOut(w: vec4f, pw: vec4f) -> VelOut {
  var o: VelOut;
  o.pos = U.jitVP * w;
  o.cur = U.curVP * w;
  o.prev = U.prevVP * pw;
  return o;
}
@fragment fn fs_vel(in: VelOut) -> @location(0) vec4f {
  let c = in.cur.xy / in.cur.w;
  let p = in.prev.xy / in.prev.w;
  return vec4f((c - p) * vec2f(0.5, -0.5), 0.0, 1.0);
}
`;

export const TAA_VELOCITY_RIGID_WGSL = /* wgsl */`
${TAA_VEL_COMMON}
@vertex fn vs_rigid(@location(0) p: vec3f, @builtin(instance_index) k: u32) -> VelOut {
  let d = draws[k];
  return velOut(d.cur * vec4f(p, 1.0), d.prev * vec4f(p, 1.0));
}
`;

const PREV_SKIN_BLEND_WGSL = SKIN_BLEND_WGSL
  .replace(/skinMatrixFor/g, 'prevSkinMatrixFor').replace(/skinQuatMul/g, 'prevSkinQuatMul').replace(/skinMatrices\[/g, 'prevSkinMatrices[');

export const TAA_VELOCITY_SKINNED_WGSL = /* wgsl */`
${TAA_VEL_COMMON}
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> prevSkinMatrices: array<mat4x4f>;
${SKIN_BLEND_WGSL}
${PREV_SKIN_BLEND_WGSL}
@vertex fn vs_skinned(@location(0) p: vec3f, @location(4) joints: vec4<u32>, @location(5) weights: vec4f,
                      @builtin(instance_index) k: u32) -> VelOut {
  let d = draws[k];
  let sk = skinMatrixFor(joints, weights);
  let psk = prevSkinMatrixFor(joints, weights);
  return velOut(d.cur * (sk * vec4f(p, 1.0)), d.prev * (psk * vec4f(p, 1.0)));
}
`;

// ── The pass ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One rigid velocity draw: the shared-pool (or override) buffers and the index range, plus both model matrices. */
export interface TaaRigidDraw {
  vb: GPUBuffer; ib: GPUBuffer; indexCount: number; firstIndex: number; baseVertex: number;
  cur: ArrayLike<number>; prev: ArrayLike<number>;
}
/** One skinned velocity draw (its own VB / IB, one skeleton's current + previous skin buffers). */
export interface TaaSkinnedDraw {
  vb: GPUBuffer; ib: GPUBuffer; indexCount: number; skin: GPUBindGroup;
  cur: ArrayLike<number>; prev: ArrayLike<number>;
}

interface SkinPrev { buf: GPUBuffer; cpu: Float32Array; prevIsCur: boolean; cur: GPUBuffer; bg: GPUBindGroup; frame: number }

export class TemporalAAPass {
  /** Console debug view of the resolve (0 = off; see TAA_RESOLVE_FS): 1 this frame only, 2 rejected, 3 velocity. */
  static debug = 0;
  private readonly _pipes: PipelineSet;
  private readonly _velPipes: PipelineSet;
  private readonly _resolve: PipelineHandle<GPURenderPipeline>;
  private readonly _blit: PipelineHandle<GPURenderPipeline>;
  private readonly _velRigid: PipelineHandle<GPURenderPipeline>;
  private readonly _velSkinned: PipelineHandle<GPURenderPipeline>;
  private readonly _resolveBGL: GPUBindGroupLayout;
  private readonly _blitBGL: GPUBindGroupLayout;
  private readonly _velBGL: GPUBindGroupLayout;
  private readonly _skinBGL: GPUBindGroupLayout;
  private readonly _sampler: GPUSampler;
  private readonly _params: GPUBuffer;
  private readonly _paramData = new Float32Array(64);
  private readonly _sharpBuf: GPUBuffer;
  private readonly _sharpData = new Float32Array(4);
  private readonly _velU: GPUBuffer;
  private readonly _velUData = new Float32Array(48);
  private _drawBuf: GPUBuffer | null = null;
  private _drawData = new Float32Array(0);

  // History (ping-pong): colour rgba16float + closest-depth r32float, full size.
  private _histC: GPUTexture[] = [];
  private _histD: GPUTexture[] = [];
  private _histIdx = 0;
  private _outW = 0;
  private _outH = 0;
  private _historyValid = false;
  private _resolvedThisFrame = false;
  // Velocity target (lo-res rg16float).
  private _velTex: GPUTexture | null = null;
  private _velW = 0;
  private _velH = 0;
  private readonly _skinPrev = new Map<string, SkinPrev>();
  private _frame = 0;
  private _blitBG: GPUBindGroup | null = null;
  private _blitBGSrc: GPUTexture | null = null;

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat,
              meshStride: number, skinnedStride: number) {
    this._pipes = new PipelineSet(device, PIPELINE_PRIORITY.DOCUMENT);
    this._velPipes = new PipelineSet(device, PIPELINE_PRIORITY.DOCUMENT);
    const vs = device.createShaderModule({ code: PP_FULLSCREEN_VS, label: 'TaaVS' });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    this._resolveBGL = device.createBindGroupLayout({
      label: 'TaaResolveBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const resolveFs = device.createShaderModule({ code: TAA_RESOLVE_FS, label: 'TaaResolveFS' });
    this._resolve = this._pipes.render({
      label: 'TaaResolve',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._resolveBGL] }),
      vertex: { module: vs, entryPoint: 'vs_main' },
      fragment: { module: resolveFs, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    }, 'TaaResolve');

    this._blitBGL = device.createBindGroupLayout({
      label: 'TaaBlitBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const blitFs = device.createShaderModule({ code: TAA_BLIT_FS, label: 'TaaBlitFS' });
    this._blit = this._pipes.render({
      label: 'TaaBlit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._blitBGL] }),
      vertex: { module: vs, entryPoint: 'vs_main' },
      fragment: {
        module: blitFs, entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {   // premultiplied (the resolve works on premultiplied colour so the 3D edges over 2D stay clean)
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      // The main pass carries the depth24plus-stencil8 attachment (see LoFiPass's blit).
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
      primitive: { topology: 'triangle-list' },
    }, 'TaaBlit');

    this._velBGL = device.createBindGroupLayout({
      label: 'TaaVelBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this._skinBGL = device.createBindGroupLayout({
      label: 'TaaVelSkinBGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    // Depth-tested (less-equal, pulled slightly forward) against the scene depth, read-only: a mover writes its
    // motion only where it is the visible surface.
    const velDepth: GPUDepthStencilState = { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'less-equal', depthBias: -8, depthBiasSlopeScale: -1 };
    const rigidMod = device.createShaderModule({ code: TAA_VELOCITY_RIGID_WGSL, label: 'TaaVelRigid' });
    this._velRigid = this._velPipes.render({
      label: 'TaaVelRigid',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._velBGL] }),
      vertex: { module: rigidMod, entryPoint: 'vs_rigid', buffers: [{ arrayStride: meshStride, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: rigidMod, entryPoint: 'fs_vel', targets: [{ format: 'rg16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: velDepth,
    }, 'TaaVelRigid');
    const skinMod = device.createShaderModule({ code: TAA_VELOCITY_SKINNED_WGSL, label: 'TaaVelSkinned' });
    this._velSkinned = this._velPipes.render({
      label: 'TaaVelSkinned',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this._velBGL, this._skinBGL] }),
      vertex: {
        module: skinMod, entryPoint: 'vs_skinned',
        buffers: [{ arrayStride: skinnedStride, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 4, offset: 48, format: 'uint8x4' },
          { shaderLocation: 5, offset: 52, format: 'float32x4' },
        ] }],
      },
      fragment: { module: skinMod, entryPoint: 'fs_vel', targets: [{ format: 'rg16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: velDepth,
    }, 'TaaVelSkinned');

    this._params = device.createBuffer({ label: 'TaaParams', size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._sharpBuf = device.createBuffer({ label: 'TaaSharpen', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._velU = device.createBuffer({ label: 'TaaVelU', size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Resolve + blit compiled (the velocity pipelines are optional: camera-only reprojection until they land). */
  ready(): boolean { return this._pipes.ready(); }
  get historyValid(): boolean { return this._historyValid; }
  get resolvedThisFrame(): boolean { return this._resolvedThisFrame; }
  /** Drop the history (camera cut, resize, mode switch, device recovery): the next frame starts from the spatial pass. */
  resetHistory(): void { this._historyValid = false; }
  /** Start a frame (before the 3D scene records). */
  beginFrame(): void { this._resolvedThisFrame = false; this._frame++; }

  private _ensureHistory(w: number, h: number): void {
    if (this._outW === w && this._outH === h && this._histC.length === 2) return;
    for (const t of this._histC) t.destroy();
    for (const t of this._histD) t.destroy();
    this._histC = []; this._histD = [];
    for (let i = 0; i < 2; i++) {
      this._histC.push(this.device.createTexture({ label: 'TaaHistory' + i, size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
      this._histD.push(this.device.createTexture({ label: 'TaaHistoryDepth' + i, size: [w, h], format: 'r32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    }
    this._outW = w; this._outH = h;
    this._historyValid = false;
    this._blitBG = null; this._blitBGSrc = null;
  }

  private _ensureVelocity(w: number, h: number): void {
    if (this._velTex && this._velW === w && this._velH === h) return;
    this._velTex?.destroy();
    this._velTex = this.device.createTexture({ label: 'TaaVelocity', size: [w, h], format: 'rg16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this._velW = w; this._velH = h;
  }

  /** The bind group of a skeleton's current + previous skin buffers. `curData` = the bytes uploaded to `cur` this
   *  frame (or the unchanged last upload): the previous buffer holds the last frame's, so a still pose has no motion. */
  skinBindGroup(skelId: string, cur: GPUBuffer, curData: Float32Array): GPUBindGroup {
    let e = this._skinPrev.get(skelId);
    if (!e || e.cur !== cur || e.cpu.length !== curData.length) {
      e?.buf.destroy();
      const buf = this.device.createBuffer({ label: 'TaaPrevSkin', size: Math.max(64, curData.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, curData);
      const bg = this.device.createBindGroup({ layout: this._skinBGL, entries: [{ binding: 0, resource: { buffer: cur } }, { binding: 1, resource: { buffer: buf } }] });
      e = { buf, cpu: curData.slice(), prevIsCur: true, cur, bg, frame: this._frame };
      this._skinPrev.set(skelId, e);
      return e.bg;
    }
    if (e.frame === this._frame) return e.bg;   // a second part of the same skeleton this frame
    e.frame = this._frame;
    let same = true;
    const a = e.cpu;
    for (let i = 0; i < a.length; i++) if (a[i] !== curData[i]) { same = false; break; }
    if (!same) {
      this.device.queue.writeBuffer(e.buf, 0, a);   // prev = what the GPU showed last frame
      a.set(curData);
      e.prevIsCur = false;
    } else if (!e.prevIsCur) {
      this.device.queue.writeBuffer(e.buf, 0, a);   // the pose stopped: prev catches up (no motion)
      e.prevIsCur = true;
    }
    return e.bg;
  }
  /** Forget skeletons not drawn for a while (their buffers were released by the renderer). */
  pruneSkins(): void {
    for (const [k, e] of this._skinPrev) if (this._frame - e.frame > 120) { e.buf.destroy(); this._skinPrev.delete(k); }
  }

  /**
   * Record the velocity pass: clear the lo-res velocity target to TAA_NO_VELOCITY and draw the movers / skinned parts
   * with depth less-equal against `depthView` (the lo-res scene depth, read-only). Returns the draws issued.
   */
  recordVelocity(enc: GPUCommandEncoder, depthView: GPUTextureView, w: number, h: number, depthMin: number,
      jitVP: ArrayLike<number>, curVP: ArrayLike<number>, prevVP: ArrayLike<number>,
      rigid: readonly TaaRigidDraw[], skinned: readonly TaaSkinnedDraw[]): number {
    this._ensureVelocity(w, h);
    const rp = this._velRigid.get(), sp = this._velSkinned.get();
    const nR = rp ? rigid.length : 0, nS = sp ? skinned.length : 0, n = nR + nS;
    const pass = enc.beginRenderPass({
      label: 'TaaVelocity',
      colorAttachments: [{ view: this._velTex!.createView(), clearValue: { r: TAA_NO_VELOCITY, g: TAA_NO_VELOCITY, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true, stencilReadOnly: true },
    });
    if (n > 0) {
      const need = n * 32;
      if (this._drawData.length < need) this._drawData = new Float32Array(Math.max(need, this._drawData.length * 2, 64 * 32));
      const dd = this._drawData;
      let k = 0;
      for (let i = 0; i < nR; i++, k++) { const d = rigid[i]; for (let q = 0; q < 16; q++) { dd[k * 32 + q] = d.cur[q]; dd[k * 32 + 16 + q] = d.prev[q]; } }
      for (let i = 0; i < nS; i++, k++) { const d = skinned[i]; for (let q = 0; q < 16; q++) { dd[k * 32 + q] = d.cur[q]; dd[k * 32 + 16 + q] = d.prev[q]; } }
      if (!this._drawBuf || this._drawBuf.size < need * 4) {
        this._drawBuf?.destroy();
        this._drawBuf = this.device.createBuffer({ label: 'TaaVelDraws', size: Math.max(need * 4, 128 * 64), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this._velBG = null;
      }
      this.device.queue.writeBuffer(this._drawBuf, 0, dd, 0, need);
      const u = this._velUData;
      for (let q = 0; q < 16; q++) { u[q] = jitVP[q]; u[16 + q] = curVP[q]; u[32 + q] = prevVP[q]; }
      this.device.queue.writeBuffer(this._velU, 0, u);
      this._velBG ??= this.device.createBindGroup({ layout: this._velBGL, entries: [{ binding: 0, resource: { buffer: this._drawBuf } }, { binding: 1, resource: { buffer: this._velU } }] });
      if (depthMin > 0) pass.setViewport(0, 0, w, h, depthMin, 1);
      pass.setBindGroup(0, this._velBG);
      if (nR > 0) {
        pass.setPipeline(rp!);
        let vb: GPUBuffer | null = null, ib: GPUBuffer | null = null;
        for (let i = 0; i < nR; i++) {
          const d = rigid[i];
          if (d.vb !== vb) { pass.setVertexBuffer(0, d.vb); vb = d.vb; }
          if (d.ib !== ib) { pass.setIndexBuffer(d.ib, 'uint32'); ib = d.ib; }
          pass.drawIndexed(d.indexCount, 1, d.firstIndex, d.baseVertex, i);
        }
      }
      if (nS > 0) {
        pass.setPipeline(sp!);
        let bg: GPUBindGroup | null = null;
        for (let i = 0; i < nS; i++) {
          const d = skinned[i];
          if (d.skin !== bg) { pass.setBindGroup(1, d.skin); bg = d.skin; }
          pass.setVertexBuffer(0, d.vb);
          pass.setIndexBuffer(d.ib, 'uint32');
          pass.drawIndexed(d.indexCount, 1, 0, 0, nR + i);
        }
      }
    }
    pass.end();
    return n;
  }
  private _velBG: GPUBindGroup | null = null;

  /** Record the resolve (full size) from the lo-res colour / depth and this frame's velocity target. False = skipped
   *  (pipelines compiling): the caller then blits the lo-res frame the old way. */
  recordResolve(enc: GPUCommandEncoder, curColor: GPUTexture, curDepth: GPUTexture, p: TaaResolveInputs): boolean {
    const pipe = this._resolve.get();
    if (!pipe || !this._velTex) return false;
    this._ensureHistory(p.outW, p.outH);
    const src = this._histIdx, dst = 1 - src;
    packTaaParams(this._paramData, { ...p, historyValid: p.historyValid && this._historyValid, debug: TemporalAAPass.debug });
    this.device.queue.writeBuffer(this._params, 0, this._paramData);
    const bg = this.device.createBindGroup({
      label: 'TaaResolveBG', layout: this._resolveBGL,
      entries: [
        { binding: 0, resource: curColor.createView() },
        { binding: 1, resource: curDepth.createView({ aspect: 'depth-only' }) },
        { binding: 2, resource: this._velTex.createView() },
        { binding: 3, resource: this._histC[src].createView() },
        { binding: 4, resource: this._histD[src].createView() },
        { binding: 5, resource: this._sampler },
        { binding: 6, resource: { buffer: this._params } },
      ],
    });
    const pass = enc.beginRenderPass({
      label: 'TaaResolve',
      colorAttachments: [
        { view: this._histC[dst].createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
        { view: this._histD[dst].createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    this._histIdx = dst;
    this._historyValid = true;
    this._resolvedThisFrame = true;
    return true;
  }

  /** Draw the resolved frame into the (full-size) main pass, sharpened. False when nothing was resolved this frame. */
  blit(pass: GPURenderPassEncoder, sharpen: number): boolean {
    const p = this._blit.get();
    if (!p || !this._resolvedThisFrame) return false;
    const tex = this._histC[this._histIdx];
    if (this._blitBGSrc !== tex) {
      this._blitBG = this.device.createBindGroup({ label: 'TaaBlitBG', layout: this._blitBGL, entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: this._sharpBuf } }] });
      this._blitBGSrc = tex;
    }
    if (this._sharpData[0] !== sharpen) { this._sharpData[0] = sharpen; this.device.queue.writeBuffer(this._sharpBuf, 0, this._sharpData); }
    pass.setPipeline(p);
    pass.setBindGroup(0, this._blitBG!);
    pass.draw(3);
    return true;
  }

  destroy(): void {
    for (const t of this._histC) t.destroy();
    for (const t of this._histD) t.destroy();
    this._histC = []; this._histD = [];
    this._velTex?.destroy(); this._velTex = null;
    this._drawBuf?.destroy(); this._drawBuf = null;
    for (const e of this._skinPrev.values()) e.buf.destroy();
    this._skinPrev.clear();
    this._params.destroy(); this._sharpBuf.destroy(); this._velU.destroy();
    this._historyValid = false; this._outW = this._outH = 0;
  }
}
