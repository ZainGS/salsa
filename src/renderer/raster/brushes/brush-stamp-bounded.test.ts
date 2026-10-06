/**
 * BRUSH-1 / 1b (docs/specs/mobile-parity.md §3): the per-dab ping copy and the wet-stroke composite are bounded to
 * the dab's dispatch footprint, and dabs inside a batch share ONE submit and ONE composite. These tests run the
 * REAL BrushStampPipeline on the CPU mirror device (cpu-gpu-mirror.ts) and compare every output byte against a
 * reference of the OLD algorithm (full-canvas copy + full-canvas composite + one submit per dab) built from the
 * same CPU shader ports.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createCpuDevice, installGpuGlobals, stampKernel, compositeKernel, bleedKernel, CpuTexture,
} from '../cpu-gpu-mirror';
import type { StampParams } from './brush-stamp-pipeline';

beforeAll(() => installGpuGlobals());

const W = 97, H = 61;   // odd sizes: footprints get clipped at the right / bottom edges

/** Deterministic PRNG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeTip(mkTex: (w: number, h: number, f: string) => CpuTexture): CpuTexture {
  const n = 32, t = mkTex(n, n, 'r8unorm');
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
    const d = Math.sqrt(dx * dx + dy * dy);
    t.data[y * n + x] = Math.round(Math.max(0, Math.min(1, (1 - d) * 1.6)) * 255);
  }
  return t;
}

function fillCanvas(t: CpuTexture, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < t.data.length; i += 4) {
    // a mix of opaque, translucent and empty texels
    const k = r();
    if (k < 0.3) continue;
    t.data[i] = Math.floor(r() * 256); t.data[i + 1] = Math.floor(r() * 256); t.data[i + 2] = Math.floor(r() * 256);
    t.data[i + 3] = k < 0.6 ? 255 : Math.floor(r() * 256);
  }
}

type Dab = Omit<StampParams, 'tipTexture'>;

function makeDabs(seed: number, n: number, mode: number, aspect: [number, number] = [1, 1]): Dab[] {
  const r = rng(seed);
  const dabs: Dab[] = [];
  let x = r() * W, y = r() * H;
  for (let i = 0; i < n; i++) {
    x += (r() - 0.5) * 9; y += (r() - 0.5) * 9;
    // occasionally right at / past an edge
    if (i % 17 === 5) x = W - 1 - r() * 2;
    if (i % 23 === 7) y = -1.5;
    dabs.push({
      cx: x, cy: y, radius: 1 + r() * 9,
      color: [r(), r(), r(), 0.2 + r() * 0.8],
      rotation: r() * Math.PI, mode, aspect,
    });
  }
  return dabs;
}

/** The OLD algorithm (pre-BRUSH-1): full ping copy, stamp, [bleed], full composite — per dab. */
function referenceStroke(
  canvas: CpuTexture, tip: CpuTexture, dabs: Dab[], mkTex: (w: number, h: number, f: string) => CpuTexture,
  opts: { strokeActive: boolean; bleed?: { radius: number; strength: number } },
) {
  const base = mkTex(W, H, 'rgba8unorm'); base.data.set(canvas.data);
  const accum = mkTex(W, H, 'rgba8unorm');
  const ping = mkTex(W, H, 'rgba8unorm');
  for (const d of dabs) {
    const minX = Math.max(0, Math.floor(d.cx - d.radius)), minY = Math.max(0, Math.floor(d.cy - d.radius));
    const maxX = Math.min(W - 1, Math.ceil(d.cx + d.radius)), maxY = Math.min(H - 1, Math.ceil(d.cy + d.radius));
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const ok = bw > 0 && bh > 0;
    const wet = opts.strokeActive && d.mode === 0;
    const kp = (flags: number) => ({
      minX, minY, radius: d.radius, mode: d.mode, rotation: d.rotation, cx: d.cx, cy: d.cy, flags,
      color: d.color, aspect: d.aspect,
    });
    if (wet) {
      ping.data.set(accum.data);
      if (ok) stampKernel(ping, accum, tip, kp(2), Math.ceil(bw / 8) * 8, Math.ceil(bh / 8) * 8);
      if (opts.bleed) {
        bleedKernel(accum, ping, opts.bleed.radius, opts.bleed.strength);
        bleedKernel(ping, accum, opts.bleed.radius, opts.bleed.strength);
      }
      compositeKernel(base, accum, canvas, 0, 0, W, H);
    } else {
      ping.data.set(canvas.data);
      if (ok) stampKernel(ping, canvas, tip, kp(0), Math.ceil(bw / 8) * 8, Math.ceil(bh / 8) * 8);
    }
  }
}

async function setup(seed: number) {
  const { BrushStampPipeline } = await import('./brush-stamp-pipeline');
  const gpu = createCpuDevice();
  const pipe = new BrushStampPipeline(gpu.device);
  const tip = makeTip(gpu.mkTex);
  const canvas = gpu.mkTex(W, H, 'rgba8unorm');
  fillCanvas(canvas, seed);
  const refCanvas = gpu.mkTex(W, H, 'rgba8unorm');
  refCanvas.data.set(canvas.data);
  return { gpu, pipe, tip, canvas, refCanvas };
}

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;

describe('BRUSH-1 bounded dab copy + composite', () => {
  it('wet-stroke (normal paint) stroke is byte-identical to the full-canvas path, per-dab submits', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(1);
    const dabs = makeDabs(11, 60, 0);
    pipe.beginStroke(asGpu(canvas));
    for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    pipe.endStroke();
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
    // traffic: the old path copied + composited W*H texels per dab
    const full = W * H * dabs.length;
    expect(pipe.stats.copiedTexels).toBeLessThan(full / 4);
    expect(pipe.stats.compositedTexels).toBeLessThan(full / 4);
  });

  it('eraser + blend-mode (direct path) strokes are byte-identical', async () => {
    for (const mode of [1, 4]) {
      const { gpu, pipe, tip, canvas, refCanvas } = await setup(2 + mode);
      const dabs = makeDabs(20 + mode, 50, mode);
      pipe.beginStroke(asGpu(canvas));
      for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
      pipe.endStroke();
      referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
      expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
    }
  });

  it('no stroke lifecycle (legacy direct path) is byte-identical', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(7);
    const dabs = makeDabs(70, 40, 0);
    for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: false });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
  });

  it('aspect-corrected (stretched) dabs clip exactly like the old dispatch (threads past the radius box)', async () => {
    // aspect < 1 stretches the dab past its radius box: the rounded-up 8×8 workgroups then read/write texels
    // outside the box, so the footprint must be the whole dispatch, not just the box.
    for (const mode of [0, 1]) {
      const { gpu, pipe, tip, canvas, refCanvas } = await setup(8 + mode);
      const dabs = makeDabs(80 + mode, 40, mode, [0.45, 0.55]);
      pipe.beginStroke(asGpu(canvas));
      for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
      pipe.endStroke();
      referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
      expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
    }
  });

  it('per-dab bleed (full-accum change) still composites the whole canvas, identically', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(9);
    const dabs = makeDabs(90, 12, 0);
    const bleed = { radius: 2, strength: 0.5 };
    pipe.beginStroke(asGpu(canvas));
    for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) }, bleed);
    pipe.endStroke();
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true, bleed });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
  });
});

describe('BRUSH-1b batched dabs', () => {
  it('a batch is ONE submit + ONE union composite and stays byte-identical', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(3);
    const dabs = makeDabs(33, 90, 0);
    pipe.beginStroke(asGpu(canvas));
    const before = gpu.counters.submits;
    // three "frames" of 30 dabs each
    for (let f = 0; f < 3; f++) {
      pipe.beginBatch();
      for (const d of dabs.slice(f * 30, f * 30 + 30)) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
      pipe.endBatch();
    }
    expect(gpu.counters.submits - before).toBe(3);
    pipe.endStroke();
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
  });

  it('a mode switch inside a batch (paint → erase → paint) keeps the old per-dab semantics', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(4);
    const dabs = [...makeDabs(41, 15, 0), ...makeDabs(42, 10, 1), ...makeDabs(43, 15, 0)];
    pipe.beginStroke(asGpu(canvas));
    pipe.beginBatch();
    for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    pipe.endBatch();
    pipe.endStroke();
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
  });

  it('a batch larger than the uniform staging submits early and stays identical', async () => {
    const { gpu, pipe, tip, canvas, refCanvas } = await setup(5);
    const dabs = makeDabs(55, 600, 0).map(d => ({ ...d, radius: 1 + (d.radius % 2) }));
    pipe.beginStroke(asGpu(canvas));
    pipe.beginBatch();
    for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    pipe.endBatch();
    pipe.endStroke();
    referenceStroke(refCanvas, tip, dabs, gpu.mkTex, { strokeActive: true });
    expect(Buffer.from(canvas.data).equals(Buffer.from(refCanvas.data))).toBe(true);
  });

  it('the stroke-start accum clear is a loadOp:clear pass (accum starts transparent even after a stroke)', async () => {
    const { pipe, tip, canvas } = await setup(6);
    pipe.beginStroke(asGpu(canvas));
    for (const d of makeDabs(61, 20, 0)) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    pipe.endStroke();
    pipe.beginStroke(asGpu(canvas));
    const accum = pipe.getStrokeAccumTex() as unknown as CpuTexture;
    expect(accum.data.every(b => b === 0)).toBe(true);
    pipe.endStroke();
  });

  it('readStrokeRect returns the stroke-start BEFORE and current AFTER pixels of the touched rect', async () => {
    const { pipe, tip, canvas } = await setup(10);
    const start = canvas.data.slice();
    pipe.beginStroke(asGpu(canvas));
    for (const d of makeDabs(101, 30, 0)) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
    pipe.endStroke();
    const rect = pipe.takeStrokeTouchedRect()!;
    expect(rect).not.toBeNull();
    // nothing outside the touched rect changed
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) continue;
      const o = (y * W + x) * 4;
      for (let i = 0; i < 4; i++) if (canvas.data[o + i] !== start[o + i]) throw new Error(`changed outside rect at ${x},${y}`);
    }
    const p = await pipe.readStrokeRect(asGpu(canvas), rect)!;
    for (let r = 0; r < p.h; r++) {
      const o = ((p.y + r) * W + p.x) * 4;
      expect(Buffer.from(p.before.subarray(r * p.w * 4, (r + 1) * p.w * 4)).equals(Buffer.from(start.subarray(o, o + p.w * 4)))).toBe(true);
      expect(Buffer.from(p.after.subarray(r * p.w * 4, (r + 1) * p.w * 4)).equals(Buffer.from(canvas.data.subarray(o, o + p.w * 4)))).toBe(true);
    }
  });
});
