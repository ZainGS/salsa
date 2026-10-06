/**
 * End-of-stroke effects reach the canvas (mobile-parity.md §3, 2026-10-06). The end bleed, the wet edges and the
 * stroke-texture strip rewrite the stroke accum AFTER the last dab composite; before this fix nothing composited
 * the accum into the layer afterwards, so the three effects never showed. endStroke now flattens it with ONE
 * composite bounded to the stroke's union area. These tests run the REAL pipeline / engine on the CPU mirror
 * (cpu-gpu-mirror.ts) and check:
 *  - the final layer holds the effect, byte-identical to "old dab path + one FULL-canvas composite after it";
 *  - a brush without end effects is untouched by endStroke (no write, no composite — today's bytes);
 *  - the undo patch covers the effect area (a bleed halo past the dabs) and undo/redo round-trip.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createCpuDevice, installGpuGlobals, stampKernel, compositeKernel, bleedKernel, wetEdgesKernel, CpuTexture,
} from '../cpu-gpu-mirror';
import type { StampParams, BrushStampPipeline as BSP } from './brush-stamp-pipeline';
import type { BrushPreset } from './brush-preset';

beforeAll(() => installGpuGlobals());

const W = 83, H = 57;
const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeTip(mkTex: (w: number, h: number, f: string) => CpuTexture): CpuTexture {
  const n = 32, t = mkTex(n, n, 'r8unorm');
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
    t.data[y * n + x] = Math.round(Math.max(0, Math.min(1, (1 - Math.hypot(dx, dy)) * 1.6)) * 255);
  }
  return t;
}

/** Random canvas, but the right third left transparent so a bleed halo there is unmistakable. */
function fillCanvas(t: CpuTexture, seed: number) {
  const r = rng(seed);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const i = (y * t.width + x) * 4, k = r();
    if (x > t.width * 0.66 || k < 0.3) continue;
    t.data[i] = Math.floor(r() * 256); t.data[i + 1] = Math.floor(r() * 256); t.data[i + 2] = Math.floor(r() * 256);
    t.data[i + 3] = k < 0.6 ? 255 : Math.floor(r() * 256);
  }
}

type Dab = Omit<StampParams, 'tipTexture'>;

/** A wandering stroke kept clear of the borders (so a halo past the dabs stays on the canvas). */
function makeDabs(seed: number, n: number): Dab[] {
  const r = rng(seed);
  const dabs: Dab[] = [];
  let x = 20, y = 18;
  for (let i = 0; i < n; i++) {
    x = Math.min(W - 16, x + r() * 2.2); y = Math.max(12, Math.min(H - 12, y + (r() - 0.5) * 4));
    dabs.push({ cx: x, cy: y, radius: 2 + r() * 4, color: [r(), r(), r(), 0.3 + r() * 0.7], rotation: r() * Math.PI, mode: 0, aspect: [1, 1] });
  }
  return dabs;
}

type Effects = { wetEdges?: { edgeDarkness: number; edgeWidth: number; strength: number }; bleed?: { radius: number; strength: number } };

/** Reference: the old full-canvas dab path, then the end effects on the accum, then ONE FULL-canvas composite. */
function reference(canvas: CpuTexture, tip: CpuTexture, dabs: Dab[], mkTex: (w: number, h: number, f: string) => CpuTexture, fx: Effects) {
  const base = mkTex(W, H, 'rgba8unorm'); base.data.set(canvas.data);
  const accum = mkTex(W, H, 'rgba8unorm');
  const ping = mkTex(W, H, 'rgba8unorm');
  for (const d of dabs) {
    const minX = Math.max(0, Math.floor(d.cx - d.radius)), minY = Math.max(0, Math.floor(d.cy - d.radius));
    const bw = Math.min(W - 1, Math.ceil(d.cx + d.radius)) - minX + 1, bh = Math.min(H - 1, Math.ceil(d.cy + d.radius)) - minY + 1;
    ping.data.set(accum.data);
    stampKernel(ping, accum, tip, {
      minX, minY, radius: d.radius, mode: 0, rotation: d.rotation, cx: d.cx, cy: d.cy, flags: 2, color: d.color, aspect: d.aspect,
    }, Math.ceil(bw / 8) * 8, Math.ceil(bh / 8) * 8);
    compositeKernel(base, accum, canvas, 0, 0, W, H);
  }
  if (fx.bleed) {
    const r = Math.max(1, Math.round(fx.bleed.radius)), s = Math.max(0, Math.min(1, fx.bleed.strength));
    bleedKernel(accum, ping, r, s);
    bleedKernel(ping, accum, r, s);
  }
  if (fx.wetEdges) {
    ping.data.set(accum.data);
    wetEdgesKernel(ping, accum, fx.wetEdges.edgeDarkness, fx.wetEdges.edgeWidth, fx.wetEdges.strength);
  }
  if (fx.bleed || fx.wetEdges) compositeKernel(base, accum, canvas, 0, 0, W, H);
}

async function stroke(seed: number, fx: Effects, batched = true) {
  const { BrushStampPipeline } = await import('./brush-stamp-pipeline');
  const gpu = createCpuDevice();
  const pipe = new BrushStampPipeline(gpu.device);
  const tip = makeTip(gpu.mkTex);
  const canvas = gpu.mkTex(W, H, 'rgba8unorm');
  fillCanvas(canvas, seed);
  const start = canvas.data.slice();
  const dabs = makeDabs(seed * 7 + 1, 40);
  pipe.beginStroke(asGpu(canvas));
  if (batched) pipe.beginBatch();
  for (const d of dabs) pipe.stampWithPingPong(asGpu(canvas), { ...d, tipTexture: asGpu(tip) });
  if (batched) pipe.endBatch();
  const beforeEnd = canvas.data.slice();
  const statsBefore = { ...pipe.stats };
  pipe.endStroke(fx.wetEdges, fx.bleed);
  const ref = gpu.mkTex(W, H, 'rgba8unorm'); ref.data.set(start);
  reference(ref, tip, dabs, gpu.mkTex, fx);
  return { gpu, pipe, canvas, start, beforeEnd, statsBefore, ref, dabs };
}

/** Bounding box of every texel where a and b differ (null = identical). */
function diffBox(a: Uint8Array, b: Uint8Array, w: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
    const p = i >> 2, x = p % w, y = (p / w) | 0;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
const inside = (inner: { x0: number; y0: number; x1: number; y1: number }, outer: { x0: number; y0: number; x1: number; y1: number }) =>
  inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;

const WET = { edgeDarkness: 0.5, edgeWidth: 3, strength: 0.65 };

describe('end-of-stroke effects are composited onto the layer (pipeline)', () => {
  const cases: Array<[string, Effects]> = [
    ['wet edges', { wetEdges: WET }],
    ['end bleed (full strength, spreads past the dabs)', { bleed: { radius: 3, strength: 1 } }],
    ['end bleed (partial strength)', { bleed: { radius: 2, strength: 0.5 } }],
    ['bleed + wet edges', { bleed: { radius: 2, strength: 1 }, wetEdges: { edgeDarkness: 0.3, edgeWidth: 2, strength: 0.4 } }],
  ];
  for (const [name, fx] of cases) {
    it(`${name}: visible, and byte-identical to a full-canvas composite after the effect`, async () => {
      const { canvas, beforeEnd, ref, statsBefore, pipe } = await stroke(name.length, fx);
      expect(same(canvas.data, beforeEnd)).toBe(false);          // endStroke changed the layer: the effect shows
      expect(same(canvas.data, ref.data)).toBe(true);            // ... exactly as one full composite would
      const composited = pipe.stats.compositedTexels - statsBefore.compositedTexels;
      expect(composited).toBeGreaterThan(0);
      expect(composited).toBeLessThan(W * H);                    // bounded to the stroke's union area
    });
  }

  it('no end effects: endStroke writes nothing and composites nothing (byte-identical to before the fix)', async () => {
    for (const batched of [true, false]) {
      const { canvas, beforeEnd, ref, statsBefore, pipe } = await stroke(3, {}, batched);
      expect(same(canvas.data, beforeEnd)).toBe(true);
      expect(same(canvas.data, ref.data)).toBe(true);
      expect(pipe.stats.compositedTexels).toBe(statsBefore.compositedTexels);
      expect(pipe.stats.submits).toBe(statsBefore.submits);
    }
  });

  it('an erase-only stroke with end effects skips them (the erase is not overwritten by the base)', async () => {
    const { BrushStampPipeline } = await import('./brush-stamp-pipeline');
    const gpu = createCpuDevice();
    const pipe = new BrushStampPipeline(gpu.device);
    const tip = makeTip(gpu.mkTex);
    const canvas = gpu.mkTex(W, H, 'rgba8unorm');
    fillCanvas(canvas, 5);
    pipe.beginStroke(asGpu(canvas));
    for (const d of makeDabs(51, 30)) pipe.stampWithPingPong(asGpu(canvas), { ...d, mode: 1, tipTexture: asGpu(tip) });
    const erased = canvas.data.slice();
    const st = { ...pipe.stats };
    pipe.endStroke(WET, { radius: 2, strength: 1 });
    expect(same(canvas.data, erased)).toBe(true);
    expect(pipe.stats.compositedTexels).toBe(st.compositedTexels);
  });

  it('the undo rect includes the bleed halo past the dabs; undo/redo restore exactly', async () => {
    const { RasterSnapshotManager } = await import('../core/raster-snapshot-manager');
    const fx = { bleed: { radius: 4, strength: 1 }, wetEdges: WET };
    // the dab-only stroke's rect, for comparison
    const plain = await stroke(9, {});
    const plainRect = plain.pipe.takeStrokeTouchedRect()!;

    const { gpu, pipe, canvas, start } = await stroke(9, fx);
    const rect = pipe.takeStrokeTouchedRect()!;
    const changed = diffBox(start, canvas.data, W)!;
    expect(inside(changed, rect)).toBe(true);                    // every changed texel is in the patch
    expect(inside(plainRect, rect)).toBe(true);
    expect(rect.x1 - rect.x0 > plainRect.x1 - plainRect.x0 || rect.y1 - rect.y0 > plainRect.y1 - plainRect.y0).toBe(true);
    const plainChanged = diffBox(plain.start, plain.canvas.data, W)!;
    expect(inside(changed, plainChanged)).toBe(false);           // the halo really reaches past the dabs

    const after = canvas.data.slice();
    const mgr = new RasterSnapshotManager(gpu.device);
    const startTex = gpu.mkTex(W, H, 'rgba8unorm'); startTex.data.set(start);
    await mgr.initialize(asGpu(startTex));                       // the stack's base = the pre-stroke layer
    const p = (await pipe.readStrokeRect(asGpu(canvas), rect))!;
    await mgr.pushPatch(asGpu(canvas), { w: W, h: H, x: p.x, y: p.y, rw: p.w, rh: p.h, before: p.before, after: p.after });
    expect(await mgr.undo(asGpu(canvas))).toBe(true);
    expect(same(canvas.data, start)).toBe(true);
    expect(await mgr.redo(asGpu(canvas))).toBe(true);
    expect(same(canvas.data, after)).toBe(true);
  });
});

// ── Engine level: the real presets through RasterPaintEngine ──

const EW = 360, EH = 240;   // the watercolor tip is ~130 px across: room for a bounded composite

async function engineStroke(presetId: string, opts: { preset?: BrushPreset; erase?: number } = {}) {
  const { RasterPaintEngine } = await import('../core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(EW, EH, 'rgba8unorm');
  fillCanvasEngine(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  if (opts.preset) engine.registerPreset(opts.preset);
  expect(engine.setActivePreset(presetId)).toBe(true);
  if (opts.erase !== undefined) engine.setEraseMode(opts.erase);
  engine.setBrushColor(0.85, 0.3, 0.1, 1);
  engine.setActiveTexture(asGpu(tex));
  await engine.initializeSnapshots();
  const s0 = tex.data.slice();

  // watch the end-of-stroke step: the canvas + composite counter on entry to the pipeline's endStroke
  const pipe = (engine.brushEngine as unknown as { stampPipeline: BSP }).stampPipeline;
  const real = pipe.endStroke.bind(pipe);
  let atEnd: { data: Uint8Array; composited: number } | null = null;
  pipe.endStroke = (we, bl) => {
    atEnd = { data: tex.data.slice(), composited: pipe.stats.compositedTexels };
    real(we, bl);
  };

  const pt = (i: number) => ({ x: 110 + i * 9, y: 110 + Math.sin(i / 2) * 18, pressure: 0.7, timestamp: 1000 + i * 16 });
  engine.beginStroke(pt(0));
  for (let f = 0; f < 4; f++) engine.addStrokePoints([1, 2, 3].map(k => pt(f * 3 + k)));
  const patch = await engine.endStroke(pt(13));
  const accum = (pipe as unknown as { strokeAccumTex: CpuTexture }).strokeAccumTex;
  const base = (pipe as unknown as { strokeBaseTex: CpuTexture }).strokeBaseTex;
  return { gpu, engine, tex, s0, s1: tex.data.slice(), patch, atEnd: atEnd!, pipe, accum, base };
}

function fillCanvasEngine(t: CpuTexture) {
  const r = rng(77);
  for (let i = 0; i < t.data.length; i += 4) {
    if (r() < 0.5) continue;
    t.data[i] = 40; t.data[i + 1] = 160; t.data[i + 2] = 200; t.data[i + 3] = Math.floor(80 + r() * 175);
  }
}

/** The whole-canvas composite of the stroke's base + (post-effect) accum — what the layer must equal. */
function fullComposite(gpu: ReturnType<typeof createCpuDevice>, base: CpuTexture, accum: CpuTexture): Uint8Array {
  const out = gpu.mkTex(EW, EH, 'rgba8unorm');
  compositeKernel(base, accum, out, 0, 0, EW, EH);
  return out.data;
}

async function checkUndo(r: Awaited<ReturnType<typeof engineStroke>>) {
  expect(r.patch).not.toBeNull();
  const changed = diffBox(r.s0, r.s1, EW)!;
  const p = r.patch!;
  expect(inside(changed, { x0: p.x, y0: p.y, x1: p.x + p.rw, y1: p.y + p.rh })).toBe(true);
  expect(await r.engine.undo()).toBe(true);
  expect(same(r.tex.data, r.s0)).toBe(true);
  expect(await r.engine.redo()).toBe(true);
  expect(same(r.tex.data, r.s1)).toBe(true);
}

describe('end-of-stroke effects through RasterPaintEngine (real presets)', () => {
  // (Concept Shader's dabs are ~1–2/255 alpha, so its wet edges round away in 8 bits — only checked for exactness.)
  for (const [id, visible] of [['default_watercolor_wash', true], ['default_concept_shader', false]] as const) {
    it(`${id} (wet edges): the committed layer holds the effect; undo/redo round-trip`, async () => {
      const r = await engineStroke(id);
      if (visible) expect(same(r.s1, r.atEnd.data)).toBe(false);       // endStroke put the wet edges on the layer
      expect(same(r.s1, fullComposite(r.gpu, r.base, r.accum))).toBe(true);   // bounded == full composite
      expect(r.pipe.stats.compositedTexels - r.atEnd.composited).toBeLessThan(EW * EH);
      await checkUndo(r);
    });
  }

  it('an end-bleed preset (custom) puts the bleed on the layer', async () => {
    const { createDefaultPresets } = await import('../core/raster-paint-engine');
    const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
    const preset: BrushPreset = { ...soft, id: 'test_bleed', bleed: { enabled: true, radius: 3, strength: 1, perDab: false } };
    const r = await engineStroke('test_bleed', { preset });
    expect(same(r.s1, r.atEnd.data)).toBe(false);
    expect(same(r.s1, fullComposite(r.gpu, r.base, r.accum))).toBe(true);
    await checkUndo(r);
  });

  it('a stroke-texture preset (custom) replaces the dab preview with the strip on the layer', async () => {
    const { createDefaultPresets } = await import('../core/raster-paint-engine');
    const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
    const preset: BrushPreset = {
      ...soft, id: 'test_strip',
      strokeTexture: { enabled: true, textureData: '', textureSize: 64, texelsPerUnit: 0.05, edgeSoftness: 0.4 },
    };
    const r = await engineStroke('test_strip', { preset });
    expect(same(r.s1, r.atEnd.data)).toBe(false);
    expect(same(r.s1, fullComposite(r.gpu, r.base, r.accum))).toBe(true);
    // every strip texel is inside the undo patch (strokeStripBounds covers the strip)
    const p = r.patch!;
    for (let i = 0; i < r.accum.data.length; i += 4) {
      if (r.accum.data[i + 3] === 0) continue;
      const x = (i >> 2) % EW, y = ((i >> 2) / EW) | 0;
      expect(x >= p.x && x < p.x + p.rw && y >= p.y && y < p.y + p.rh).toBe(true);
    }
    await checkUndo(r);
  });

  it('presets without end effects: endStroke leaves the layer byte-identical and composites nothing', async () => {
    const { createDefaultPresets } = await import('../core/raster-paint-engine');
    const plain = createDefaultPresets().filter(p => !p.wetEdges?.enabled && !p.bleed?.enabled && !p.strokeTexture?.enabled);
    expect(plain.length).toBeGreaterThan(5);
    for (const preset of plain) {
      const r = await engineStroke(preset.id);
      expect(same(r.s1, r.atEnd.data)).toBe(true);
      expect(r.pipe.stats.compositedTexels).toBe(r.atEnd.composited);
    }
  });

  it('a wet-edges preset used as an eraser leaves the erase alone', async () => {
    const r = await engineStroke('default_watercolor_wash', { erase: 1 });
    expect(same(r.s1, r.s0)).toBe(false);                              // it erased
    expect(same(r.s1, r.atEnd.data)).toBe(true);                       // ... and endStroke didn't undo that
    await checkUndo(r);
  });
});
