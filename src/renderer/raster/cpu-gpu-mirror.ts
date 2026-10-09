/**
 * TEST HELPER — a CPU mirror of the slice of WebGPU the raster brush / undo code uses (no GPU in vitest).
 *
 * Textures and buffers are byte arrays; copies, writeBuffer/writeTexture, mapAsync and loadOp:'clear' render
 * passes really move bytes; compute dispatches run CPU ports of the brush shaders (stamp, wet-stroke composite,
 * bleed, end-of-stroke wet edges, the stroke-texture strip) and of the layer compositor's shaders (blend step, base
 * opacity, paper grain — the full-canvas ones and their BRUSH-5 region variants) chosen by their WGSL source.
 * Commands execute at submit, in order, like a real queue; writeBuffer / writeTexture execute immediately (queue
 * order). Used by brush-stamp-bounded.test.ts, brush-stroke-end-effects.test.ts, raster-snapshot-patch.test.ts and
 * raster-compositor-dirty.test.ts to check that the bounded / batched / incremental paths are pixel-identical to the
 * full-canvas ones and that undo round-trips.
 */

export interface CpuTexture {
  width: number; height: number; format: string; bpp: number;
  data: Uint8Array;
  createView(): { texture: CpuTexture };
  destroy(): void;
  destroyed: boolean;
}

export interface CpuBuffer {
  size: number; data: Uint8Array;
  mapAsync(): Promise<void>;
  getMappedRange(off?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

type Cmd = () => void;

/** The params the stamp shader decodes from its uniforms (also used by the reference implementation). */
export interface StampKernelParams {
  minX: number; minY: number; radius: number; mode: number; rotation: number; cx: number; cy: number; flags: number;
  color: [number, number, number, number];
  aspect: [number, number];
  /** Per-dab deposit (aspect.z in the shader; default 1 = the max-of-dabs wet stroke). */
  flow?: number;
  /** The preset's own texture (binding 13 / 14): scale, strength, mode (0 multiply, 1 subtract), origin. */
  brushTex?: { tex: CpuTexture; scale: number; strength: number; mode: number; origin: [number, number] } | null;
}

const f32 = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
const u32 = (b: Uint8Array) => new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);

export function load(t: CpuTexture, x: number, y: number): [number, number, number, number] {
  x = Math.max(0, Math.min(t.width - 1, x)); y = Math.max(0, Math.min(t.height - 1, y));
  const o = (y * t.width + x) * 4;
  const d = t.data;
  return [d[o] / 255, d[o + 1] / 255, d[o + 2] / 255, d[o + 3] / 255];
}
export function store(t: CpuTexture, x: number, y: number, v: readonly number[]): void {
  if (x < 0 || y < 0 || x >= t.width || y >= t.height) return;   // OOB textureStore: dropped
  const o = (y * t.width + x) * 4;
  for (let i = 0; i < 4; i++) t.data[o + i] = Math.round(Math.max(0, Math.min(1, v[i])) * 255);
}
function sampleR8(t: CpuTexture, u: number, v: number): number {
  // bilinear, clamp-to-edge
  const x = u * t.width - 0.5, y = v * t.height - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (xx: number, yy: number) => {
    xx = Math.max(0, Math.min(t.width - 1, xx)); yy = Math.max(0, Math.min(t.height - 1, yy));
    return t.data[yy * t.width + xx] / 255;
  };
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}

/** CPU port of the stamp shader's per-texel body (grain / dual / selection disabled — strength 0 / dummy mask;
 *  the brush texture, flow build-up and every mode but Screen / Overlay ported). */
export function stampKernel(
  src: CpuTexture, dst: CpuTexture, tip: CpuTexture, p: StampKernelParams, threadsX: number, threadsY: number,
): void {
  const lockTrans = (p.flags & 1) !== 0, wet = (p.flags & 2) !== 0;
  const r = p.radius;
  for (let ly = 0; ly < threadsY; ly++) {
    for (let lx = 0; lx < threadsX; lx++) {
      const ix = p.minX + lx, iy = p.minY + ly;
      const px = ix + 0.5, py = iy + 0.5;
      const dx = (px - p.cx) * p.aspect[0], dy = (py - p.cy) * p.aspect[1];
      const c = Math.cos(p.rotation), s = Math.sin(p.rotation);
      const rdx = dx * c - dy * s, rdy = dx * s + dy * c;
      const d = Math.sqrt(rdx * rdx + rdy * rdy);
      if (d > r) continue;
      const rawTip = sampleR8(tip, (rdx / r) * 0.5 + 0.5, (rdy / r) * 0.5 + 0.5);
      if (rawTip <= 0.001) continue;
      let tipA = rawTip;
      const bt = p.brushTex;
      if (bt && bt.strength > 0.001) {
        const s = Math.max(bt.scale, 0.01);
        const tv = sampleR8Repeat(bt.tex, (ix - bt.origin[0]) / (bt.tex.width * s), (iy - bt.origin[1]) / (bt.tex.height * s));
        tipA = bt.mode > 0.5 ? Math.max(0, tipA - (1 - tv) * bt.strength) : tipA * (1 + (tv - 1) * bt.strength);
      }
      const flow = p.flow ?? 1;
      const coverage = p.color[3] * tipA;
      const brushA = coverage * flow;
      const ex = load(src, ix, iy);
      let out: number[] = ex;
      if (p.mode === 0) {
        if (wet) {
          let newA = ex[3];
          let rgb = [p.color[0], p.color[1], p.color[2]];
          if (coverage > ex[3]) {
            newA = ex[3] * (1 - flow) + coverage * flow;
            if (ex[3] > 0.001) {
              const t = (newA - ex[3]) / Math.max(newA, 0.001);
              rgb = [0, 1, 2].map(i => ex[i] + (p.color[i] - ex[i]) * t);
            }
          } else if (ex[3] > 0.001) rgb = [ex[0], ex[1], ex[2]];
          out = [...rgb, newA];
        } else {
          const outA = brushA + ex[3] * (1 - brushA);
          out = outA <= 0 ? [0, 0, 0, 0]
            : [...[0, 1, 2].map(i => (p.color[i] * brushA + ex[i] * ex[3] * (1 - brushA)) / outA), outA];
        }
      } else if (p.mode === 1 || p.mode === 2 || p.mode === 3) {
        // 1 fade, 2 clear (any coverage clears), 3 hard edge (the bare tip's silhouette at opacity x flow)
        const smooth = (e0: number, e1: number, x: number) => { const t = clampN((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
        const k = p.mode === 1 ? brushA : p.mode === 2 ? Math.ceil(brushA) : p.color[3] * flow * smooth(0.2, 0.5, rawTip);
        const newA = ex[3] * (1 - k);
        const gone = p.mode === 3 ? [0, 0, 0] : [1, 1, 1];
        const rgb = p.mode !== 1 && newA <= 0 ? gone : ex[3] > 0 ? [0, 1, 2].map(i => ex[i] * (newA / ex[3])) : p.mode === 1 ? [1, 1, 1] : [ex[0], ex[1], ex[2]];
        out = [...rgb, newA];
      } else if (p.mode === 4) {
        const rgb = [0, 1, 2].map(i => ex[i] + (ex[i] * p.color[i] - ex[i]) * brushA);
        out = [...rgb, ex[3] + brushA * (1 - ex[3])];
      }
      if (lockTrans) out = [out[0], out[1], out[2], Math.min(out[3], ex[3])];
      store(dst, ix, iy, out);
    }
  }
}

/** CPU port of the wet-stroke composite over [x0,x0+w)×[y0,y0+h). `lockAlpha` = the lock-transparency branch. */
export function compositeKernel(base: CpuTexture, accum: CpuTexture, out: CpuTexture, x0: number, y0: number, w: number, h: number, lockAlpha = false): void {
  for (let y = y0; y < y0 + h && y < out.height; y++) {
    for (let x = x0; x < x0 + w && x < out.width; x++) {
      const b = load(base, x, y), s = load(accum, x, y);
      if (lockAlpha) {
        store(out, x, y, s[3] <= 0.001 || b[3] <= 0 ? b : [0, 1, 2].map(i => b[i] + (s[i] - b[i]) * s[3]).concat(b[3]));
        continue;
      }
      if (s[3] <= 0.001) { store(out, x, y, b); continue; }
      const outA = s[3] + b[3] * (1 - s[3]);
      const rgb = outA > 0.001 ? [0, 1, 2].map(i => (s[i] * s[3] + b[i] * b[3] * (1 - s[3])) / outA) : [0, 0, 0];
      store(out, x, y, [...rgb, outA]);
    }
  }
}

/** CPU port of the bleed pass (full texture). */
export function bleedKernel(src: CpuTexture, dst: CpuTexture, radiusF: number, strength: number): void {
  const radius = Math.trunc(radiusF);
  const tmp = new Uint8Array(dst.data.length);
  const outT = { ...dst, data: tmp } as CpuTexture;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const c = load(src, x, y);
      if (c[3] <= 0.001 && strength < 0.99) { store(outT, x, y, c); continue; }
      const acc = [0, 0, 0, 0]; let n = 0;
      for (let d = -radius; d <= radius; d++) {
        const s1 = load(src, x + d, y), s2 = load(src, x, y + d);
        for (let i = 0; i < 4; i++) acc[i] += s1[i] + s2[i];
        n += 2;
      }
      for (let i = 0; i < 4; i++) acc[i] += c[i];
      n += 1;
      store(outT, x, y, c.map((v, i) => v + (acc[i] / n - v) * strength));
    }
  }
  dst.data.set(tmp);
}

/** CPU port of the end-of-stroke wet-edges pass (full texture): darkens + pools pigment at the alpha boundary. */
export function wetEdgesKernel(src: CpuTexture, dst: CpuTexture, edgeDarkness: number, edgeWidthF: number, strength: number): void {
  const ew = Math.trunc(edgeWidthF);
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      const c = load(src, x, y);
      if (c[3] <= 0.001) { store(dst, x, y, c); continue; }
      let minA = c[3];
      for (let dy = -ew; dy <= ew; dy++) for (let dx = -ew; dx <= ew; dx++) {
        if (dx === 0 && dy === 0) continue;
        minA = Math.min(minA, load(src, x + dx, y + dy)[3]);   // load clamps to the edge, like the shader
      }
      const edge = c[3] * (1 - minA);
      const k = 1 - edge * edgeDarkness * strength;
      const boosted = Math.min(1, c[3] + edge * strength * 0.3);
      const target = [c[0] * k, c[1] * k, c[2] * k, boosted];
      store(dst, x, y, c.map((v, i) => v + (target[i] - v) * strength));
    }
  }
}

/** Segment layout of the stroke-texture shader: [x0, y0, hw0, x1, y1, hw1, vStart, vEnd] per segment. */
function projectSeg(seg: Float32Array, i: number, px: number, py: number): [number, number, number, number] {
  const b = i * 8;
  const ax = seg[b], ay = seg[b + 1], hw0 = seg[b + 2], bx = seg[b + 3], by = seg[b + 4], hw1 = seg[b + 5];
  const vs = seg[b + 6], ve = seg[b + 7];
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq < 0.001) return [0, Math.hypot(px - ax, py - ay), hw0, vs];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx, cy = ay + t * dy;
  return [t, Math.hypot(px - cx, py - cy), hw0 + (hw1 - hw0) * t, vs + (ve - vs) * t];
}

/** CPU port of the stroke-texture strip shader (StrokeTextureRenderer; full-texture dispatch). The strip texture
 *  is sampled clamp-U / repeat-V like its sampler. */
export function strokeStripKernel(out: CpuTexture, tex: CpuTexture, p: Float32Array, seg: Float32Array): void {
  const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const n = Math.trunc(p[6]), soft = p[5];
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const px = x + 0.5, py = y + 0.5;
      let best = 1e10, bu = 0.5, bv = 0, inside = false;
      for (let s = 0; s < n; s++) {
        const [, d, hw, v] = projectSeg(seg, s, px, py);
        if (d < best) {
          best = d;
          if (hw > 0.001) {
            const b = s * 8, sdx = seg[b + 3] - seg[b], sdy = seg[b + 4] - seg[b + 1];
            const side = ((px - seg[b]) * sdy - (py - seg[b + 1]) * sdx) < 0 ? -1 : 1;
            bu = Math.max(0, Math.min(1, 0.5 + side * (d / hw) * 0.5));
          } else bu = 0.5;
          bv = v; inside = d <= hw;
        }
      }
      if (!inside) continue;
      let edgeA = 1;
      if (soft > 0.001 && best > 0) {
        let chw = 1, minD = 1e10;
        for (let s = 0; s < n; s++) { const pr = projectSeg(seg, s, px, py); if (pr[1] < minD) { minD = pr[1]; chw = pr[2]; } }
        const e0 = chw * (1 - soft);
        if (best > e0) edgeA = 1 - smooth(e0, chw, best);
      }
      const vv = bv - Math.floor(bv);   // repeat in V
      const tv = sampleR8(tex, bu, vv);
      const a = p[3] * tv * edgeA;
      if (a <= 0.001) continue;
      store(out, x, y, [p[0], p[1], p[2], a]);
    }
  }
}

// ── Layer compositor (RasterCompositor) ──────────────────────────────────────────────────────────────────────

type V3 = [number, number, number];
const ch = (f: (d: number, s: number) => number) => (d: V3, s: V3): V3 => [f(d[0], s[0]), f(d[1], s[1]), f(d[2], s[2])];
const overlayCh = (d: number, s: number) => (d < 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s));
/** The compositor's 12 layer blend modes (LayerBlendMode order), per channel, straight alpha. */
const LAYER_BLENDS: Array<(d: V3, s: V3) => V3> = [
  ch((_d, s) => s),                                   // Normal
  ch((d, s) => d * s),                                // Multiply
  ch((d, s) => 1 - (1 - d) * (1 - s)),                // Screen
  ch(overlayCh),                                      // Overlay
  ch((d, s) => {                                      // SoftLight (W3C)
    const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
    return s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (g - d);
  }),
  ch((d, s) => overlayCh(s, d)),                      // HardLight = overlay with swapped args
  ch((d, s) => (d <= 0 ? 0 : Math.min(1, d / Math.max(1 - s, 0.001)))),          // ColorDodge
  ch((d, s) => (d >= 1 ? 1 : 1 - Math.min(1, (1 - d) / Math.max(s, 0.001)))),    // ColorBurn
  ch((d, s) => Math.min(d, s)),                       // Darken
  ch((d, s) => Math.max(d, s)),                       // Lighten
  ch((d, s) => Math.min(d + s, 1)),                   // Add
  ch((d, s) => Math.abs(d - s)),                      // Difference
];

/** The texels a compositor dispatch of `tx×ty` threads visits: the whole-texture shaders start at (0,0); the region
 *  variants start at (x0,y0) and stop at (x1,y1). Both drop texels outside `out`. */
function forCompositorTexels(out: CpuTexture, tx: number, ty: number, region: ArrayLike<number> | null, f: (x: number, y: number) => void): void {
  const x0 = region ? Math.trunc(region[0]) : 0, y0 = region ? Math.trunc(region[1]) : 0;
  const x1 = Math.min(out.width, region ? Math.trunc(region[2]) : out.width);
  const y1 = Math.min(out.height, region ? Math.trunc(region[3]) : out.height);
  for (let y = y0; y < Math.min(y1, y0 + ty); y++) for (let x = x0; x < Math.min(x1, x0 + tx); x++) f(x, y);
}

// Frame Link displacement (the compositor's computeDisplacement / computeDisplacementAt, u32 maths wrapped like WGSL;
// pcgHash is the shared port further down)
const hash2Dfloat = (x: number, y: number): number => Math.fround(Math.fround(pcgHash((x + pcgHash(y)) >>> 0)) / 4294967295);
const fract = (v: number) => v - Math.floor(v);
const lerpD = (a: number, b: number, t: number) => a * (1 - t) + b * t;
function gradientNoise(px: number, py: number): number {
  const ix = Math.floor(px) | 0, iy = Math.floor(py) | 0;
  const fx = fract(px), fy = fract(py);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2Dfloat(ix >>> 0, iy >>> 0), b = hash2Dfloat((ix + 1) >>> 0, iy >>> 0);
  const c = hash2Dfloat(ix >>> 0, (iy + 1) >>> 0), d = hash2Dfloat((ix + 1) >>> 0, (iy + 1) >>> 0);
  return lerpD(lerpD(a, b, ux), lerpD(c, d, ux), uy) * 2 - 1;
}
/** WGSL u32(f32): truncation, saturated to [0, 2^32 - 1]. */
const f32ToU32 = (v: number) => (v <= 0 || v !== v ? 0 : v >= 4294967295 ? 4294967295 : Math.trunc(v));
function displacementAt(p: Float32Array, px: number, py: number, frame: number): [number, number] {
  const type = Math.trunc(p[4]), amplitude = p[5], freq = p[6], speed = p[7], dir = p[8], phase = p[9];
  const flags = f32ToU32(p[11]), texW = p[18], texH = p[19];
  if (type === 0 || amplitude < 0.001) return [0, 0];
  const doX = (flags & 1) !== 0, doY = (flags & 2) !== 0;
  const nx = px / texW, ny = py / texH;
  const cs = Math.cos(dir), sn = Math.sin(dir);
  let dx = 0, dy = 0;
  if (type === 1) {
    const wave = Math.sin((nx * -sn + ny * cs) * freq * 6.283185 + frame * speed + phase);
    const ax = doX ? wave * amplitude : 0, ay = doY ? wave * amplitude : 0;
    dx = ax * cs - ay * sn; dy = ax * sn + ay * cs;
  } else if (type === 2) {
    const fIdx = (f32ToU32(frame) + f32ToU32(p[17])) >>> 0;
    dx = doX ? (hash2Dfloat(fIdx, 0) * 2 - 1) * amplitude : 0;
    dy = doY ? (hash2Dfloat(fIdx, 1) * 2 - 1) * amplitude : 0;
  } else if (type === 3) {
    const cx = p[12], cy = p[13];
    const dist = Math.hypot(nx - cx, ny - cy);
    const wave = Math.sin(dist * freq * 6.283185 - frame * speed + phase);
    const rx = nx - cx + 0.0001, ry = ny - cy + 0.0001, rl = Math.hypot(rx, ry) || 1;
    dx = doX ? (rx / rl) * wave * amplitude : 0; dy = doY ? (ry / rl) * wave * amplitude : 0;
  } else if (type === 4) {
    const nX = gradientNoise(nx * freq + frame * speed, ny * freq + phase);
    const nY = gradientNoise(nx * freq + phase + 100, ny * freq + frame * speed + 100);
    dx = doX ? nX * amplitude : 0; dy = doY ? nY * amplitude : 0;
  } else if (type === 5) {
    const octaves = Math.trunc(p[14]), lac = p[15], pers = p[16];
    let tFreq = freq, tAmp = 1, sx = 0, sy = 0, maxAmp = 0;
    for (let oi = 0; oi < 4 && oi < octaves; oi++) {
      sx += gradientNoise(nx * tFreq + frame * speed, ny * tFreq + phase) * tAmp;
      sy += gradientNoise(nx * tFreq + phase + 50, ny * tFreq + frame * speed + 50) * tAmp;
      maxAmp += tAmp; tFreq *= lac; tAmp *= pers;
    }
    dx = doX ? (sx / Math.max(maxAmp, 0.001)) * amplitude : 0; dy = doY ? (sy / Math.max(maxAmp, 0.001)) * amplitude : 0;
  }
  return [dx, dy];
}
/** CPU port of the compositor's computeDisplacement: params[0].w = the Loop to Fit cross-fade length (0 = off). */
export function frameLinkDisplacement(p: Float32Array, px: number, py: number): [number, number] {
  const frame = p[10], loopLen = p[3];
  const d = displacementAt(p, px, py, frame);
  if (loopLen < 0.5) return d;
  const e = displacementAt(p, px, py, frame - loopLen), t = frame / loopLen;
  return [lerpD(d[0], e[0], t), lerpD(d[1], e[1], t)];
}
/** WGSL round(): half to even. */
const roundEven = (v: number) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

/** CPU port of the compositor's blend step, Frame Link displacement included. */
export function layerBlendKernel(
  accum: CpuTexture, layer: CpuTexture, out: CpuTexture, params: Float32Array, tx: number, ty: number, region: ArrayLike<number> | null,
): void {
  const mode = Math.trunc(params[0]), opacity = params[1], clipped = params[2] > 0.5;
  const blend = LAYER_BLENDS[mode] ?? LAYER_BLENDS[0];
  const displaced = params[4] !== 0 && params[5] >= 0.001;
  forCompositorTexels(out, tx, ty, region, (x, y) => {
    let sx = x, sy = y;
    if (displaced) {
      const d = frameLinkDisplacement(params, x, y);
      sx = Math.max(0, Math.min(out.width - 1, x + roundEven(d[0])));
      sy = Math.max(0, Math.min(out.height - 1, y + roundEven(d[1])));
    }
    const dst = load(accum, x, y), src = load(layer, sx, sy);
    let srcA = src[3] * opacity;
    if (clipped) srcA *= dst[3];
    if (srcA <= 0.001) { store(out, x, y, dst); return; }
    const b = blend([dst[0], dst[1], dst[2]], [src[0], src[1], src[2]]);
    const outA = srcA + dst[3] * (1 - srcA);
    const rgb = outA > 0.001 ? [0, 1, 2].map(i => (b[i] * srcA + dst[i] * dst[3] * (1 - srcA)) / outA) : [0, 0, 0];
    store(out, x, y, [...rgb, outA]);
  });
}

/** CPU port of the base-layer opacity pass. */
export function baseOpacityKernel(src: CpuTexture, out: CpuTexture, opacity: number, tx: number, ty: number, region: ArrayLike<number> | null): void {
  forCompositorTexels(out, tx, ty, region, (x, y) => {
    const c = load(src, x, y);
    store(out, x, y, [c[0], c[1], c[2], c[3] * opacity]);
  });
}

function sampleR8Repeat(t: CpuTexture, u: number, v: number): number {
  // bilinear, repeat
  const x = u * t.width - 0.5, y = v * t.height - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const wrap = (n: number, m: number) => ((n % m) + m) % m;
  const g = (xx: number, yy: number) => t.data[wrap(yy, t.height) * t.width + wrap(xx, t.width)] / 255;
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}

/** CPU port of the paper-grain overlay (the grain is sampled at the absolute canvas texel). */
export function grainOverlayKernel(
  src: CpuTexture, grain: CpuTexture, out: CpuTexture, p: ArrayLike<number>, tx: number, ty: number, region: ArrayLike<number> | null,
): void {
  forCompositorTexels(out, tx, ty, region, (x, y) => {
    const c = load(src, x, y);
    const g = sampleR8Repeat(grain, x * p[0], y * p[1]);
    const m = 1 + (g - 1) * p[2];
    store(out, x, y, [...[0, 1, 2].map(i => c[i] * m * c[3] + m * (1 - c[3])), 1]);
  });
}

// ── Content-edge jump flood (dither-engine.ts WGSL_JFA_INIT / WGSL_JFA_STEP, 2026-10-09). Integer-only, so these
// ports ARE bit-exact with the GPU (checked on real D3D12 through the Dawn-node harness). Seeds: x | y << 16,
// relative to the flood domain; JFA_NONE = no seed. ──

export const JFA_NONE = 0xFFFFFFFF;

/** CPU port of JFA-INIT: jp = (domain x0, y0, w, h) in source texels; every UNPAINTED (alpha < 0.004) texel seeds. */
export function jfaInitKernel(src: CpuTexture, out: CpuTexture, jp: ArrayLike<number>, tx: number, ty: number): void {
  const o = u32(out.data);
  const W = Math.min(jp[2], tx), H = Math.min(jp[3], ty);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = src.data[((y + jp[1]) * src.width + x + jp[0]) * 4 + 3] / 255;
    o[y * out.width + x] = a >= 0.004 ? JFA_NONE : (x | (y << 16)) >>> 0;
  }
}

/** CPU port of JFA-STEP: jp = (domain w, h, step); the nearest of the 3x3 candidates `step` apart (first wins ties). */
export function jfaStepKernel(inT: CpuTexture, out: CpuTexture, jp: ArrayLike<number>, tx: number, ty: number): void {
  const I = u32(inT.data), O = u32(out.data);
  const DW = jp[0], DH = jp[1], s = jp[2];
  const W = Math.min(DW, tx), H = Math.min(DH, ty);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = JFA_NONE, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = x + dx * s, qy = y + dy * s;
      if (qx < 0 || qy < 0 || qx >= DW || qy >= DH) continue;
      const v = I[qy * inT.width + qx];
      if (v === JFA_NONE) continue;
      const ex = (v & 0xFFFF) - x, ey = (v >>> 16) - y, d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = v; }
    }
    O[y * out.width + x] = best;
  }
}

/** The whole flood on the CPU: the nearest-unpainted-texel seeds of `src` over `dom` (row stride = the domain width),
 *  with the engine's step schedule (ditherEdgeJfaSteps). */
export function edgeSeedsCpu(src: CpuTexture, dom: { x0: number; y0: number; x1: number; y1: number }, steps: readonly number[]): Uint32Array {
  const w = dom.x1 - dom.x0, h = dom.y1 - dom.y0;
  const mk = (): CpuTexture => {
    const t: CpuTexture = { width: w, height: h, format: 'r32uint', bpp: 4, data: new Uint8Array(w * h * 4), destroyed: false, createView: () => ({ texture: t }), destroy: () => { /* */ } };
    return t;
  };
  let a = mk(), b = mk();
  jfaInitKernel(src, a, [dom.x0, dom.y0, w, h], w, h);
  for (const s of steps) { jfaStepKernel(a, b, [w, h, s], w, h); [a, b] = [b, a]; }
  return u32(a.data).slice();
}

/** The content edge factor from a distance (texel centres) to the nearest unpainted texel: measured from the texel
 *  boundary (d - 0.5), ramp 1 - (1 - t)^1.5 over t = that / radius (WGSL edgeFactor). Infinity = no seed = 1. */
export function edgeRamp(dist: number, radius: number): number {
  const t = clampN((dist - 0.5) / radius, 0, 1);
  const u = 1 - t;
  return 1 - u * Math.sqrt(u);
}

// ── Bayer ordered dither (dither-engine.ts) — edge effects (fade / shrink / density dropout, all three edge modes;
// the content distance read from the flood seeds at binding 7, params[9] = their domain), duotone / quantize /
// per-channel, invert and the params[8] dispatch region. Doubles instead of f32 and JS rounding (WGSL round() is
// half-to-even): good for path-vs-path identity checks, not a bit-exact GPU reference. ──

function pcgHash(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
function edgeCellRand(cx: number, cy: number, seed: number): number {
  return pcgHash(((cx + 32768) >>> 0) + pcgHash((((cy + 32768) >>> 0) + pcgHash(seed >>> 0)) >>> 0) >>> 0) / 4294967295;
}
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mixN = (a: number, b: number, t: number) => a + (b - a) * t;

/** CPU port of the Bayer dither shader: `src` → `out`, params = the engine's 40-float uniform block, `seeds` = the
 *  content-edge flood result bound at binding 7 (null = none: every content factor is 1). */
export function ditherBayerKernel(src: CpuTexture, out: CpuTexture, p: Float32Array, tx: number, ty: number, seeds: CpuTexture | null = null): void {
  const W = out.width, H = out.height;
  const S = seeds ? u32(seeds.data) : null;
  const edgeFactor = (x: number, y: number, radius: number) => {
    const ox = Math.trunc(p[36]), oy = Math.trunc(p[37]);
    const lx = clampN(x - ox, 0, Math.trunc(p[38]) - ox - 1), ly = clampN(y - oy, 0, Math.trunc(p[39]) - oy - 1);
    const v = S && seeds ? S[ly * seeds.width + lx] : JFA_NONE;
    if (v === JFA_NONE) return 1;
    return edgeRamp(Math.hypot((v & 0xFFFF) - lx, (v >>> 16) - ly), radius);
  };
  const edgeCanvas = (x: number, y: number, radius: number) =>
    clampN(Math.min(Math.min(x, y), Math.min(src.width - 1 - x, src.height - 1 - y)) / radius, 0, 1);
  const edgeRaw = (x: number, y: number, radius: number) => {
    const mode = p[12];
    if (mode < 0.5) return edgeFactor(x, y, radius);
    if (mode < 1.5) return edgeCanvas(x, y, radius);
    return Math.min(edgeFactor(x, y, radius), edgeCanvas(x, y, radius));
  };
  const quantize = (v: number, levels: number) => Math.round(v * (levels - 1)) * (1 / (levels - 1));
  const lum = (c: readonly number[]) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  const bayer = (x: number, y: number, level: number) => {
    const size = 1 << (level + 1);
    let xm = x % size, ym = y % size, value = 0, s = size >> 1;
    for (let i = 0; i < level + 1; i++) {
      const bx = xm >= s ? 1 : 0, by = ym >= s ? 1 : 0;
      value = value * 4 + [0, 2, 3, 1][(bx ^ by) | (by << 1)];
      xm %= s; ym %= s; s >>= 1;
    }
    return (value + 0.5) / (size * size);
  };
  const rx0 = Math.trunc(p[32]), ry0 = Math.trunc(p[33]), rx1 = Math.trunc(p[34]), ry1 = Math.trunc(p[35]);
  for (let gy = 0; gy < ty; gy++) for (let gx = 0; gx < tx; gx++) {
    const x = gx + rx0, y = gy + ry0;
    if (x >= rx1 || y >= ry1 || x >= W || y >= H) continue;
    const c = load(src, x, y);
    if (c[3] < 0.004) { store(out, x, y, c); continue; }
    const levels = p[0], level = Math.trunc(p[1]), strength = p[2], ps = p[3], perChannel = p[4] > 0.5;
    const sx = Math.trunc(x / ps), sy = Math.trunc(y / ps);
    const bias = (bayer(sx, sy, level) - 0.5) * (1 / levels);
    // edgeState
    let es = [1, 0, 1];
    const ew = p[28], ef = p[29], esh = p[30], ed = p[31];
    if (!(ew < 0.5 || (ef + Math.abs(esh) + ed) < 0.001)) {
      const e = edgeRaw(x, y, ew);
      es = [mixN(1, e, ef), (1 - e) * Math.abs(esh), e];
    }
    const eff = strength * es[0];
    if (ed > 0.001 && ew >= 0.5) {
      const cell = 1 << (level + 1);
      const cx = Math.trunc(sx / cell), cy = Math.trunc(sy / cell);
      const ccx = Math.trunc((cx + 0.5) * cell * ps), ccy = Math.trunc((cy + 0.5) * cell * ps);
      const eCell = edgeRaw(clampN(ccx, 0, src.width - 1), clampN(ccy, 0, src.height - 1), ew);
      if (edgeCellRand(cx, cy, Math.trunc(p[13])) > 1 - ed * (1 - eCell)) { store(out, x, y, [0, 0, 0, 0]); continue; }
    }
    const tq = esh < 0 ? 0 : 1;
    let d: number[];
    let duoSmooth = 0;   // the duotone level before quantizing
    if (p[16] > 0.5) {
      const db = p[19], tS = db > 0.5 ? 1 : 0, tb = esh < 0 ? 1 - tS : tS;
      duoSmooth = mixN(db, tb, es[1]);
      const v = quantize(duoSmooth + bias, levels); d = [v, v, v];
    } else if (perChannel) {
      d = [0, 1, 2].map(i => quantize(mixN(c[i], tq, es[1]) + bias, levels));
    } else {
      const v = quantize(mixN(lum(c), tq, es[1]) + bias, levels); d = [v, v, v];
    }
    // applyColorMapping (duotone: Strength = pattern vs flat tone, Tint × edge fade = how much replaces the original)
    let res = [0, 1, 2].map(i => mixN(c[i], d[i], eff));
    let a = c[3];
    if (p[16] > 0.5) {
      const t = mixN(duoSmooth, lum(d), strength), k = es[0] * p[18];
      res = [0, 1, 2].map(i => mixN(c[i], mixN(p[24 + i], p[20 + i], t), k));
      a = mixN(c[3], mixN(p[27], p[23], t), k);
    } else if (p[17] > 0.5) {
      res = [0, 1, 2].map(i => mixN(c[i], 1 - d[i], eff));
    }
    store(out, x, y, [...res, a]);
  }
}

function copyTex(src: CpuTexture, so: { x?: number; y?: number } | undefined, dst: CpuTexture, dO: { x?: number; y?: number } | undefined, w: number, h: number) {
  const sx = so?.x ?? 0, sy = so?.y ?? 0, dx = dO?.x ?? 0, dy = dO?.y ?? 0;
  if (sx + w > src.width || sy + h > src.height || dx + w > dst.width || dy + h > dst.height) throw new Error('copy out of bounds');
  for (let r = 0; r < h; r++) {
    const a = ((sy + r) * src.width + sx) * src.bpp, b = ((dy + r) * dst.width + dx) * dst.bpp;
    dst.data.set(src.data.subarray(a, a + w * src.bpp), b);
  }
}

function extent(e: any): [number, number] {
  return Array.isArray(e) ? [e[0], e[1] ?? 1] : [e.width, e.height ?? 1];
}

export function createCpuDevice() {
  const counters = { submits: 0, dispatchThreads: 0, copyTexels: 0 };
  const mkTex = (w: number, h: number, format: string): CpuTexture => {
    const bpp = format === 'r8unorm' ? 1 : 4;
    const t: CpuTexture = {
      width: w, height: h, format, bpp, data: new Uint8Array(w * h * bpp), destroyed: false,
      createView: () => ({ texture: t }),
      destroy: () => { t.destroyed = true; },
    };
    return t;
  };
  const mkBuf = (size: number): CpuBuffer => {
    const data = new Uint8Array(size);
    return {
      size, data,
      mapAsync: () => Promise.resolve(),
      getMappedRange: (off = 0, n?: number) => data.buffer.slice(off, off + (n ?? size - off)) as ArrayBuffer,
      unmap: () => { /* */ },
      destroy: () => { /* */ },
    };
  };
  // getMappedRange must alias for mappedAtCreation writes; buffers made that way are zero-filled anyway.

  const runDispatch = (pipeline: { code: string }, bg: { entries: Array<{ binding: number; resource: any }> }, gx: number, gy: number) => {
    const res = (i: number) => bg.entries.find(e => e.binding === i)?.resource;
    const tex = (i: number) => (res(i).texture ?? res(i)) as CpuTexture;
    const buf = (i: number) => { const r = res(i); const d = (r.buffer as CpuBuffer).data; return r.offset ? d.subarray(r.offset) : d; };
    const tx = gx * 8, ty = gy * 8;
    counters.dispatchThreads += tx * ty;
    const code = pipeline.code;
    if (code.includes('JFA-INIT')) {   // content-edge flood, seeding pass (params slot: domain origin + size)
      jfaInitKernel(tex(0), tex(1), new Int32Array(buf(2).buffer, buf(2).byteOffset, 4), tx, ty);
    } else if (code.includes('JFA-STEP')) {   // content-edge flood, one step (params slot: domain size + step)
      jfaStepKernel(tex(0), tex(1), new Int32Array(buf(2).buffer, buf(2).byteOffset, 4), tx, ty);
    } else if (code.includes('bayerThreshold')) {   // Bayer ordered dither (src binding 0 → output binding 1, params[8] = region, seeds binding 7)
      ditherBayerKernel(tex(0), tex(1), f32(buf(2)), tx, ty, res(7) ? tex(7) : null);
    } else if (code.includes('blendSoftLight')) {   // layer compositor blend step (params[5] = region in the BRUSH-5 variant)
      const p = f32(buf(3));
      layerBlendKernel(tex(0), tex(1), tex(2), p, tx, ty, code.includes('params[5]') ? p.subarray(20, 24) : null);
    } else if (code.includes('regionOpacity')) {   // base opacity over a region
      const p = f32(buf(2));
      baseOpacityKernel(tex(0), tex(1), p[0], tx, ty, p.subarray(4, 8));
    } else if (code.includes('c.a * opacity')) {   // base opacity, whole texture
      baseOpacityKernel(tex(0), tex(1), f32(buf(2))[0], tx, ty, null);
    } else if (code.includes('regionGrain')) {   // paper grain over a region
      const p = f32(buf(3));
      grainOverlayKernel(tex(0), tex(1), tex(4), p, tx, ty, p.subarray(4, 8));
    } else if (code.includes('paperRGB')) {   // paper grain, whole texture
      grainOverlayKernel(tex(0), tex(1), tex(4), f32(buf(3)), tx, ty, null);
    } else if (code.includes('rectCopySrc')) {   // provisional take-back: src (0,0)..(w,h) → dst at the rect origin
      const src = tex(0), dst = tex(1), r = u32(buf(2));
      for (let y = 0; y < Math.min(r[3], ty); y++) for (let x = 0; x < Math.min(r[2], tx); x++) {
        store(dst, r[0] + x, r[1] + y, load(src, x, y));
      }
    } else if (code.includes('projectOntoSegment')) {   // stroke-texture strip (StrokeTextureRenderer)
      strokeStripKernel(tex(0), tex(1), f32(buf(3)), f32(buf(4)));
    } else if (code.includes('edgeDarkness')) {   // end-of-stroke wet edges
      const p = f32(buf(2));
      wetEdgesKernel(tex(0), tex(1), p[0], p[1], p[2]);
    } else if (code.includes('tipSamp')) {
      const p = f32(buf(3)), c = f32(buf(4)), a = f32(buf(5));
      const bt = res(14) ? f32(buf(14)) : null;
      stampKernel(tex(0), tex(1), tex(6), {
        minX: p[0], minY: p[1], radius: p[2], mode: p[3], rotation: p[4], cx: p[5], cy: p[6], flags: p[7],
        color: [c[0], c[1], c[2], c[3]], aspect: [a[0], a[1]], flow: a.length > 2 ? a[2] : 1,
        brushTex: bt && bt[1] > 0.001 ? { tex: tex(13), scale: bt[0], strength: bt[1], mode: bt[2], origin: [bt[4], bt[5]] } : null,
      }, tx, ty);
    } else if (code.includes('strength < 0.99')) {   // bleed (checked before composite: its comments mention accumTex)
      const p = f32(buf(2));
      bleedKernel(tex(0), tex(1), p[0], p[1]);
    } else if (code.includes('var accumTex')) {
      const out = tex(2);
      const r = res(3) ? u32(buf(3)) : null;
      if (r) compositeKernel(tex(0), tex(1), out, r[0], r[1], Math.min(r[2], tx), Math.min(r[3], ty), r.length > 4 && (r[4] & 1) !== 0);
      else compositeKernel(tex(0), tex(1), out, 0, 0, Math.min(out.width, tx), Math.min(out.height, ty));
    } else {
      throw new Error('cpu-gpu-mirror: unknown compute shader');
    }
  };

  const queue = {
    writeBuffer(b: CpuBuffer, off: number, src: ArrayBuffer | ArrayBufferView, srcOff = 0, size?: number) {
      const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      const elt = src instanceof ArrayBuffer ? 1 : ((src as any).BYTES_PER_ELEMENT ?? 1);
      const so = srcOff * elt, n = size !== undefined ? size * elt : bytes.byteLength - so;
      b.data.set(bytes.subarray(so, so + n), off);
    },
    writeTexture(dst: { texture: CpuTexture; origin?: { x?: number; y?: number } }, data: ArrayBuffer | ArrayBufferView, layout: { offset?: number; bytesPerRow: number }, size: any) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const [w, h] = extent(size); const t = dst.texture;
      const ox = dst.origin?.x ?? 0, oy = dst.origin?.y ?? 0;
      for (let r = 0; r < h; r++) {
        const s = (layout.offset ?? 0) + r * layout.bytesPerRow;
        t.data.set(bytes.subarray(s, s + w * t.bpp), ((oy + r) * t.width + ox) * t.bpp);
      }
    },
    submit(cbs: Array<{ cmds: Cmd[] }>) { counters.submits++; for (const cb of cbs) for (const c of cb.cmds) c(); },
    onSubmittedWorkDone: () => Promise.resolve(),
  };

  const device = {
    queue,
    pushErrorScope: () => { /* the mirror never raises GPU errors */ },
    popErrorScope: () => Promise.resolve(null),
    createTexture: (d: { size: any; format: string }) => { const [w, h] = extent(d.size); return mkTex(w, h, d.format); },
    createBuffer: (d: { size: number }) => mkBuf(d.size),
    createSampler: () => ({}),
    createShaderModule: (d: { code: string }) => ({ code: d.code }),
    createComputePipeline: (d: { compute: { module: { code: string } } }) => ({ code: d.compute.module.code }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: (d: { entries: any[] }) => ({ entries: d.entries }),
    createCommandEncoder: () => {
      const cmds: Cmd[] = [];
      return {
        copyTextureToTexture(s: any, d: any, size: any) {
          const [w, h] = extent(size);
          counters.copyTexels += w * h;
          cmds.push(() => copyTex(s.texture, s.origin, d.texture, d.origin, w, h));
        },
        copyBufferToBuffer(s: CpuBuffer, so: number, d: CpuBuffer, dof: number, n: number) {
          cmds.push(() => d.data.set(s.data.subarray(so, so + n), dof));
        },
        copyTextureToBuffer(s: any, d: { buffer: CpuBuffer; bytesPerRow: number }, size: any) {
          const [w, h] = extent(size);
          cmds.push(() => {
            const t = s.texture as CpuTexture, ox = s.origin?.x ?? 0, oy = s.origin?.y ?? 0;
            for (let r = 0; r < h; r++) {
              const a = ((oy + r) * t.width + ox) * t.bpp;
              d.buffer.data.set(t.data.subarray(a, a + w * t.bpp), r * d.bytesPerRow);
            }
          });
        },
        copyBufferToTexture(s: { buffer: CpuBuffer; bytesPerRow: number; offset?: number }, d: any, size: any) {
          const [w, h] = extent(size);
          cmds.push(() => queue.writeTexture(d, s.buffer.data, { offset: s.offset ?? 0, bytesPerRow: s.bytesPerRow }, [w, h]));
        },
        beginComputePass() {
          let pipe: any = null, bg: any = null;
          return {
            setPipeline(p: any) { pipe = p; },
            setBindGroup(_i: number, b: any) { bg = b; },
            dispatchWorkgroups(gx: number, gy = 1) { const P = pipe, B = bg; cmds.push(() => runDispatch(P, B, gx, gy)); },
            end() { /* */ },
          };
        },
        beginRenderPass(d: { colorAttachments: Array<{ view: { texture: CpuTexture }; loadOp: string; clearValue?: any }> }) {
          for (const a of d.colorAttachments) {
            if (a.loadOp === 'clear') {
              const cv = a.clearValue ?? { r: 0, g: 0, b: 0, a: 0 };
              cmds.push(() => {
                const t = a.view.texture;
                for (let i = 0; i < t.width * t.height; i++) {
                  t.data[i * 4] = Math.round(cv.r * 255); t.data[i * 4 + 1] = Math.round(cv.g * 255);
                  t.data[i * 4 + 2] = Math.round(cv.b * 255); t.data[i * 4 + 3] = Math.round(cv.a * 255);
                }
              });
            }
          }
          return { end() { /* */ } };
        },
        finish: () => ({ cmds }),
      };
    },
  };
  return { device: device as unknown as GPUDevice, counters, mkTex };
}

/** WebGPU enum globals for node (flag values only need to be numbers). */
export function installGpuGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
}
