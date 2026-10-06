/**
 * TEST HELPER — a CPU mirror of the slice of WebGPU the raster brush / undo code uses (no GPU in vitest).
 *
 * Textures and buffers are byte arrays; copies, writeBuffer/writeTexture, mapAsync and loadOp:'clear' render
 * passes really move bytes; compute dispatches run CPU ports of the brush shaders (stamp, wet-stroke composite,
 * bleed, end-of-stroke wet edges, the stroke-texture strip) chosen by their WGSL source. Commands execute at
 * submit, in order, like a real queue; writeBuffer / writeTexture execute immediately (queue order). Used by
 * brush-stamp-bounded.test.ts, brush-stroke-end-effects.test.ts and raster-snapshot-patch.test.ts to check that
 * the bounded / batched paths are pixel-identical to the full-canvas ones and that undo round-trips.
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

/** CPU port of the stamp shader's per-texel body (grain / dual / selection disabled — strength 0 / dummy mask). */
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
      const tipA = sampleR8(tip, (rdx / r) * 0.5 + 0.5, (rdy / r) * 0.5 + 0.5);
      if (tipA <= 0.001) continue;
      const brushA = p.color[3] * tipA;
      const ex = load(src, ix, iy);
      let out: number[] = ex;
      if (p.mode === 0) {
        if (wet) {
          const newA = Math.max(ex[3], brushA);
          let rgb = [p.color[0], p.color[1], p.color[2]];
          if (ex[3] > 0.001 && ex[3] >= brushA) rgb = [ex[0], ex[1], ex[2]];
          else if (ex[3] > 0.001) {
            const t = (brushA - ex[3]) / Math.max(brushA, 0.001);
            rgb = [0, 1, 2].map(i => ex[i] + (p.color[i] - ex[i]) * t);
          }
          out = [...rgb, newA];
        } else {
          const outA = brushA + ex[3] * (1 - brushA);
          out = outA <= 0 ? [0, 0, 0, 0]
            : [...[0, 1, 2].map(i => (p.color[i] * brushA + ex[i] * ex[3] * (1 - brushA)) / outA), outA];
        }
      } else if (p.mode === 1) {
        const newA = ex[3] * (1 - brushA);
        const rgb = ex[3] > 0 ? [0, 1, 2].map(i => ex[i] * (newA / ex[3])) : [1, 1, 1];
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

/** CPU port of the wet-stroke composite over [x0,x0+w)×[y0,y0+h). */
export function compositeKernel(base: CpuTexture, accum: CpuTexture, out: CpuTexture, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h && y < out.height; y++) {
    for (let x = x0; x < x0 + w && x < out.width; x++) {
      const b = load(base, x, y), s = load(accum, x, y);
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
    const buf = (i: number) => (res(i).buffer as CpuBuffer).data;
    const tx = gx * 8, ty = gy * 8;
    counters.dispatchThreads += tx * ty;
    const code = pipeline.code;
    if (code.includes('projectOntoSegment')) {   // stroke-texture strip (StrokeTextureRenderer)
      strokeStripKernel(tex(0), tex(1), f32(buf(3)), f32(buf(4)));
    } else if (code.includes('edgeDarkness')) {   // end-of-stroke wet edges
      const p = f32(buf(2));
      wetEdgesKernel(tex(0), tex(1), p[0], p[1], p[2]);
    } else if (code.includes('tipSamp')) {
      const p = f32(buf(3)), c = f32(buf(4)), a = f32(buf(5));
      stampKernel(tex(0), tex(1), tex(6), {
        minX: p[0], minY: p[1], radius: p[2], mode: p[3], rotation: p[4], cx: p[5], cy: p[6], flags: p[7],
        color: [c[0], c[1], c[2], c[3]], aspect: [a[0], a[1]],
      }, tx, ty);
    } else if (code.includes('strength < 0.99')) {   // bleed (checked before composite: its comments mention accumTex)
      const p = f32(buf(2));
      bleedKernel(tex(0), tex(1), p[0], p[1]);
    } else if (code.includes('var accumTex')) {
      const out = tex(2);
      const r = res(3) ? u32(buf(3)) : null;
      if (r) compositeKernel(tex(0), tex(1), out, r[0], r[1], Math.min(r[2], tx), Math.min(r[3], ty));
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
