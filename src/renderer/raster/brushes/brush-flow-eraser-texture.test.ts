/**
 * Brush Options audit 2026-10-09 (docs/reviews/ui-dead-controls-2026-10-09.md §1 Brush Options), engine side:
 *  - Flow is no longer Opacity: Opacity = the stroke's ceiling, Flow = how much each dab deposits, so overlapping
 *    dabs build up toward the ceiling. Flow 1 is byte-identical to the old max-of-dabs stroke.
 *  - The eraser TOOL's Hard edge is hard (it was a cubic radial falloff — softer than Soft); Soft is soft.
 *  - The preset's own Texture (BrushPreset.texture) modulates the dabs (it was never read): built-in patterns or an
 *    image, multiply / subtract, canvas- or stroke-anchored.
 *  - A stroke-texture strip takes the brush Opacity; its per-dab bleed runs once at the end.
 * Real RasterPaintEngine / BrushStampPipeline on the CPU mirror (cpu-gpu-mirror.ts).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createCpuDevice, installGpuGlobals, stampKernel, CpuTexture, StampKernelParams } from '../cpu-gpu-mirror';
import type { BrushPreset } from './brush-preset';
import type { PointerInput } from './brush-engine';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function basePreset(id: string, patch: Partial<BrushPreset> = {}): Promise<BrushPreset> {
  const { createDefaultPresets } = await import('../core/raster-paint-engine');
  const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
  return { ...JSON.parse(JSON.stringify(soft)), id, ...patch } as BrushPreset;
}

const CONST = [{ x: 0, y: 1 }, { x: 1, y: 1 }];

/** One stroke through a real RasterPaintEngine on a W×H canvas (filled by `fill`, transparent by default). */
async function engineStroke(preset: BrushPreset, points: PointerInput[], opts: {
  W?: number; H?: number; erase?: number; fill?: (t: CpuTexture) => void;
} = {}) {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);   // no jitter / scatter noise
  const W = opts.W ?? 160, H = opts.H ?? 100;
  const { RasterPaintEngine } = await import('../core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(W, H, 'rgba8unorm');
  opts.fill?.(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  engine.registerPreset(preset);
  expect(engine.setActivePreset(preset.id)).toBe(true);
  if (opts.erase !== undefined) engine.setEraseMode(opts.erase);
  engine.setBrushColor(0.9, 0.2, 0.1, 1);
  engine.setActiveTexture(asGpu(tex));
  await engine.initializeSnapshots();
  const before = tex.data.slice();
  engine.beginStroke(points[0]);
  if (points.length > 2) engine.addStrokePoints(points.slice(1, -1));
  await engine.endStroke(points[points.length - 1]);
  const pipe = (engine.brushEngine as unknown as { stampPipeline: { strokeAccumTex: CpuTexture } }).stampPipeline;
  return { tex, before, after: tex.data.slice(), accum: pipe.strokeAccumTex, W, H };
}

const alphaAt = (t: { after: Uint8Array; W: number }, x: number, y: number) => t.after[(y * t.W + x) * 4 + 3];
const at = (x: number, y: number, i: number): PointerInput => ({ x, y, pressure: 1, timestamp: 1000 + i * 16, tiltX: 0, tiltY: 0 });

/** A stroke scrubbing back and forth over the same 40 px `passes` times. */
function scrub(passes: number, y = 50): PointerInput[] {
  const pts: PointerInput[] = [];
  let i = 0;
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k <= 20; k++) pts.push(at(60 + (p % 2 === 0 ? k : 20 - k) * 2, y, i++));
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Flow builds up toward the Opacity ceiling', () => {
  it('flow 1: the wet stamp is byte-identical to the old max-of-dabs kernel', () => {
    const gpu = createCpuDevice();
    const W = 61, H = 47;
    const tip = gpu.mkTex(32, 32, 'r8unorm');
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const d = Math.hypot((x + 0.5) / 16 - 1, (y + 0.5) / 16 - 1);
      tip.data[y * 32 + x] = Math.round(Math.max(0, Math.min(1, (1 - d) * 1.6)) * 255);
    }
    const r = rng(11);
    const a = gpu.mkTex(W, H, 'rgba8unorm'), b = gpu.mkTex(W, H, 'rgba8unorm');
    for (let i = 0; i < a.data.length; i++) a.data[i] = b.data[i] = r() < 0.4 ? 0 : Math.floor(r() * 256);
    for (let n = 0; n < 60; n++) {
      const p: StampKernelParams = {
        minX: 0, minY: 0, radius: 2 + r() * 9, mode: 0, rotation: r() * 3, cx: r() * W, cy: r() * H, flags: 2,
        color: [r(), r(), r(), 0.1 + r() * 0.9], aspect: [1, 1], flow: 1,
      };
      p.minX = Math.max(0, Math.floor(p.cx - p.radius)); p.minY = Math.max(0, Math.floor(p.cy - p.radius));
      const sa = gpu.mkTex(W, H, 'rgba8unorm'); sa.data.set(a.data);
      stampKernel(sa, a, tip, p, 32, 32);
      const sb = gpu.mkTex(W, H, 'rgba8unorm'); sb.data.set(b.data);
      oldWetKernel(sb, b, tip, p, 32, 32);
    }
    expect(same(a.data, b.data)).toBe(true);
  });

  it('flow < 1: one dab deposits opacity × flow, overlapping dabs build up, and the ceiling is never passed', async () => {
    const preset = await basePreset('t_flow', {
      tip: { type: 'parametric', hardness: 1, roundness: 1, angle: 0 },
      blending: { mode: 'normal', opacity: 0.6, flow: 0.25 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
      stabilization: { method: 'none', level: 0 },
      minSize: 16, maxSize: 16, spacing: 0.1,
    });
    const one = await engineStroke(preset, [at(80, 50, 0), at(80, 50, 1)]);   // a single dab
    expect(Math.abs(alphaAt(one, 80, 50) - 0.6 * 0.25 * 255)).toBeLessThanOrEqual(2);

    const pass1 = await engineStroke(preset, scrub(1));
    const pass6 = await engineStroke(preset, scrub(6));
    const a1 = alphaAt(pass1, 80, 50), a6 = alphaAt(pass6, 80, 50);
    expect(a1).toBeGreaterThan(0.6 * 0.25 * 255 + 10);   // the dabs of ONE pass already overlap and build up
    expect(a6).toBeGreaterThan(a1);                       // scrubbing builds more ...
    expect(a6).toBeGreaterThanOrEqual(0.55 * 255);        // ... up to the ceiling ...
    let max = 0;
    for (let i = 3; i < pass6.after.length; i += 4) max = Math.max(max, pass6.after[i]);
    expect(max).toBeLessThanOrEqual(Math.round(0.6 * 255) + 1);   // ... and never past it
  });

  it('flow 1: the stroke is the max of its dabs (no build-up), as before', async () => {
    const preset = await basePreset('t_flow1', {
      tip: { type: 'parametric', hardness: 1, roundness: 1, angle: 0 },
      blending: { mode: 'normal', opacity: 0.6, flow: 1 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
      stabilization: { method: 'none', level: 0 },
      minSize: 16, maxSize: 16, spacing: 0.1,
    });
    const pass1 = await engineStroke(preset, scrub(1));
    const pass6 = await engineStroke(preset, scrub(6));
    expect(Math.abs(alphaAt(pass1, 80, 50) - 0.6 * 255)).toBeLessThanOrEqual(1);
    expect(alphaAt(pass6, 80, 50)).toBe(alphaAt(pass1, 80, 50));
  });

  it('Flow Pressure is a deposit too (builds up), Opacity Pressure is the ceiling', async () => {
    const lin = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const mk = (id: string, opacityPressureCurve: typeof lin, flowPressureCurve: typeof lin) => basePreset(id, {
      tip: { type: 'parametric', hardness: 1, roundness: 1, angle: 0 },
      blending: { mode: 'normal', opacity: 1, flow: 1 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve, flowPressureCurve },
      stabilization: { method: 'none', level: 0 },
      minSize: 16, maxSize: 16, spacing: 0.1,
    });
    const half = (pts: PointerInput[]) => pts.map(p => ({ ...p, pressure: 0.4 }));
    const byFlow = await engineStroke(await mk('t_fp', CONST, lin), half(scrub(6)));
    const byOpacity = await engineStroke(await mk('t_op', lin, CONST), half(scrub(6)));
    expect(alphaAt(byOpacity, 80, 50)).toBeLessThanOrEqual(Math.round(0.4 * 255) + 1);   // capped at the pressure
    expect(alphaAt(byFlow, 80, 50)).toBeGreaterThan(0.9 * 255);                         // built up past it
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('eraser tool: Hard is hard-edged, Soft is soft', () => {
  const opaque = (t: CpuTexture) => { for (let i = 0; i < t.data.length; i += 4) { t.data[i] = 30; t.data[i + 1] = 90; t.data[i + 2] = 200; t.data[i + 3] = 255; } };

  async function erase(mode: number, hardness: number) {
    const preset = await basePreset(`t_erase_${hardness}`, {
      tip: { type: 'parametric', hardness, roundness: 1, angle: 0 },
      blending: { mode: 'normal', opacity: 1, flow: 1 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
      stabilization: { method: 'none', level: 0 },
      minSize: 40, maxSize: 40,
    });
    return engineStroke(preset, [at(80, 50, 0), at(80, 50, 1)], { erase: mode, fill: opaque });
  }
  /** Texels partly erased (the soft rim) and fully erased. */
  function profile(t: Awaited<ReturnType<typeof erase>>) {
    let partial = 0, gone = 0;
    for (let i = 3; i < t.after.length; i += 4) {
      const a = t.after[i];
      if (a <= 5) gone++; else if (a < 250) partial++;
    }
    return { partial, gone };
  }

  for (const hardness of [0, 0.3, 1]) {
    it(`tip hardness ${hardness}: Hard has a crisp rim and erases more fully than Soft`, async () => {
      const hard = profile(await erase(3, hardness));
      const soft = profile(await erase(1, hardness));
      const area = Math.PI * 20 * 20;
      expect(hard.gone).toBeGreaterThan(0.85 * area);         // the whole tip, at full strength
      expect(hard.partial).toBeLessThan(0.15 * area);         // only an anti-aliased rim
      expect(soft.partial).toBeGreaterThan(hard.partial * 3); // Soft: a wide falloff ...
      expect(soft.gone).toBeLessThan(hard.gone);              // ... even with a hard brush tip
    });
  }

  it('Hard keeps the tip shape (an elliptical tip erases an ellipse) and the Opacity', async () => {
    const preset = await basePreset('t_erase_ellipse', {
      tip: { type: 'parametric', hardness: 0.2, roundness: 0.4, angle: 0 },
      blending: { mode: 'normal', opacity: 0.5, flow: 1 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
      stabilization: { method: 'none', level: 0 },
      minSize: 40, maxSize: 40,
    });
    const r = await engineStroke(preset, [at(80, 50, 0), at(80, 50, 1)], { erase: 3, fill: opaque });
    expect(Math.abs(alphaAt(r, 80, 50) - 128)).toBeLessThanOrEqual(2);   // half-strength erase at the centre
    expect(alphaAt(r, 80 + 16, 50)).toBeLessThan(140);                  // long axis: erased
    expect(alphaAt(r, 80, 50 + 16)).toBe(255);                           // short axis: untouched
  });

  it('an Eraser-CATEGORY preset (no tool override) erases with its own tip, as saved', async () => {
    const { eraserTip, SOFT_ERASER_HARDNESS } = await import('./brush-engine');
    const tip = { type: 'parametric' as const, hardness: 1, roundness: 1, angle: 0 };
    expect(eraserTip(tip, 1)).toEqual({ ...tip, hardness: SOFT_ERASER_HARDNESS });
    expect(eraserTip({ ...tip, hardness: 0.1 }, 1)).toEqual({ ...tip, hardness: 0.1 });   // already softer: kept
    expect(eraserTip({ ...tip, hardness: 0.1 }, 3)).toEqual(tip);
    expect(eraserTip(tip, 2)).toBe(tip);
    const preset = await basePreset('t_cat_eraser', {
      category: 'Eraser',
      tip: { type: 'parametric', hardness: 1, roundness: 1, angle: 0 },
      blending: { mode: 'normal', opacity: 1, flow: 1 },
      dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
      stabilization: { method: 'none', level: 0 },
      minSize: 40, maxSize: 40,
    });
    const r = await engineStroke(preset, [at(80, 50, 0), at(80, 50, 1)], { fill: opaque });
    const p = profile(r);
    expect(p.gone).toBeGreaterThan(0.85 * Math.PI * 400);   // the saved hard eraser stays hard
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the brush\'s own Texture modulates the dabs', () => {
  const flat = (texture: BrushPreset['texture'], id = 't_tex') => basePreset(id, {
    tip: { type: 'parametric', hardness: 1, roundness: 1, angle: 0 },
    blending: { mode: 'normal', opacity: 1, flow: 1 },
    dynamics: { sizePressureCurve: CONST, opacityPressureCurve: CONST, flowPressureCurve: CONST },
    stabilization: { method: 'none', level: 0 },
    minSize: 50, maxSize: 50, spacing: 0.1,
    texture,
  });
  const line = (y = 50, x0 = 30) => Array.from({ length: 30 }, (_, i) => at(x0 + i * 3, y, i));
  /** Distinct alpha values inside the solid core of the stroke. */
  function alphaLevels(t: Awaited<ReturnType<typeof engineStroke>>) {
    const seen = new Set<number>();
    for (let y = 40; y < 60; y++) for (let x = 60; x < 100; x++) seen.add(alphaAt(t, x, y));
    return seen.size;
  }

  it('off / strength 0: a flat stroke; on: the pattern shows; multiply ≠ subtract', async () => {
    const none = await engineStroke(await flat(undefined), line());
    const zero = await engineStroke(await flat({ imageData: '', grain: 'rough', scale: 1, strength: 0, mode: 'multiply', fixedToCanvas: true }), line());
    const mul = await engineStroke(await flat({ imageData: '', grain: 'rough', scale: 1, strength: 1, mode: 'multiply', fixedToCanvas: true }), line());
    const sub = await engineStroke(await flat({ imageData: '', grain: 'rough', scale: 1, strength: 1, mode: 'subtract', fixedToCanvas: true }), line());
    expect(alphaLevels(none)).toBe(1);
    expect(same(zero.after, none.after)).toBe(true);
    expect(alphaLevels(mul)).toBeGreaterThan(20);
    expect(same(mul.after, sub.after)).toBe(false);
  });

  it('canvas-anchored: two strokes share the pattern; stroke-anchored: it moves with the stroke start', async () => {
    const tex = (fixedToCanvas: boolean) => ({ imageData: '', grain: 'newsprint' as const, scale: 1, strength: 1, mode: 'multiply' as const, fixedToCanvas });
    const sample = (t: Awaited<ReturnType<typeof engineStroke>>, dx: number) => {
      const out: number[] = [];
      for (let x = 65; x < 95; x++) out.push(alphaAt(t, x + dx, 50));
      return out.join(',');
    };
    // a second stroke starting 7 px further right
    const fixedA = await engineStroke(await flat(tex(true)), line(50, 30));
    const fixedB = await engineStroke(await flat(tex(true)), line(50, 37));
    expect(sample(fixedB, 0)).toBe(sample(fixedA, 0));   // same canvas texels → same grain
    const movA = await engineStroke(await flat(tex(false)), line(50, 30));
    const movB = await engineStroke(await flat(tex(false)), line(50, 37));
    expect(sample(movB, 7)).toBe(sample(movA, 0));       // the pattern travelled with the stroke
    expect(sample(movB, 0)).not.toBe(sample(movA, 0));
  });

  it('texture settings that change between dabs reach the next dab (unchanged uniforms are not re-staged)', async () => {
    const { BrushStampPipeline } = await import('./brush-stamp-pipeline');
    const run = (dabs: Array<{ cx: number; strength: number; mode: number }>, batched: boolean) => {
      const gpu = createCpuDevice();
      const pipe = new BrushStampPipeline(gpu.device);
      const tip = gpu.mkTex(8, 8, 'r8unorm'); tip.data.fill(255);
      const grain = gpu.mkTex(8, 8, 'r8unorm');
      for (let i = 0; i < 64; i++) grain.data[i] = (i * 53) % 256;
      const canvas = gpu.mkTex(120, 40, 'rgba8unorm');
      pipe.beginStroke(asGpu(canvas));
      if (batched) pipe.beginBatch();
      for (const d of dabs) {
        pipe.stampWithPingPong(asGpu(canvas), {
          cx: d.cx, cy: 20, radius: 9, color: [1, 0, 0, 1], rotation: 0, mode: 0, aspect: [1, 1], tipTexture: asGpu(tip),
          brushTexture: asGpu(grain), brushTextureScale: 1, brushTextureStrength: d.strength, brushTextureMode: d.mode,
          brushTextureOrigin: [0, 0],
        });
      }
      if (batched) pipe.endBatch();
      pipe.endStroke();
      return canvas.data;
    };
    const seq = [{ cx: 15, strength: 1, mode: 0 }, { cx: 45, strength: 0, mode: 0 }, { cx: 75, strength: 1, mode: 1 }, { cx: 105, strength: 1, mode: 1 }];
    const alone = seq.map(d => run([d], false));
    for (const batched of [true, false]) {
      const all = run(seq, batched);
      seq.forEach((d, k) => {
        for (let x = d.cx - 12; x < d.cx + 12; x++) for (let y = 0; y < 40; y++) {
          const o = (y * 120 + x) * 4;
          expect(all[o + 3]).toBe(alone[k][o + 3]);
        }
      });
    }
  });

  it('an uploaded image is used when present (data URL accepted); the built-in pattern otherwise', async () => {
    const { base64Payload, textureDataKey } = await import('./brush-tip');
    expect(base64Payload('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(base64Payload('QUJD')).toBe('QUJD');
    // PNG data URLs all start the same: the cache key must still tell them apart
    const a = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA' + 'x'.repeat(5000) + 'A';
    const b = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA' + 'x'.repeat(5000) + 'B';
    expect(textureDataKey('tex', a)).not.toBe(textureDataKey('tex', b));
    expect(textureDataKey('tex', a)).toBe(textureDataKey('tex', a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('stroke texture strip', () => {
  const strip = (opacity: number, bleed?: BrushPreset['bleed']) => basePreset(`t_strip_${opacity}`, {
    blending: { mode: 'normal', opacity, flow: 1 },
    strokeTexture: { enabled: true, textureData: '', textureSize: 64, texelsPerUnit: 0.05, edgeSoftness: 0 },
    bleed,
  });
  const line = () => Array.from({ length: 12 }, (_, i) => at(30 + i * 8, 50, i));

  it('takes the brush Opacity as its coverage', async () => {
    const full = await engineStroke(await strip(1), line());
    const half = await engineStroke(await strip(0.5), line());
    expect(alphaAt(full, 70, 50)).toBe(255);
    expect(Math.abs(alphaAt(half, 70, 50) - 128)).toBeLessThanOrEqual(1);
  });

  it('a per-dab bleed bleeds the strip once at the end (it used to vanish with the dab preview)', async () => {
    const plain = await engineStroke(await strip(1), line());
    const perDab = await engineStroke(await strip(1, { enabled: true, perDab: true, radius: 3, strength: 1 }), line());
    const atEnd = await engineStroke(await strip(1, { enabled: true, perDab: false, radius: 3, strength: 1 }), line());
    expect(same(perDab.after, plain.after)).toBe(false);
    expect(same(perDab.after, atEnd.after)).toBe(true);
  });
});

// ── The OLD wet-stroke stamp (max-of-dabs, before 2026-10-09) — the flow-1 identity reference ──
function oldWetKernel(src: CpuTexture, dst: CpuTexture, tip: CpuTexture, p: StampKernelParams, tx: number, ty: number) {
  const ld = (t: CpuTexture, x: number, y: number) => { const o = (y * t.width + x) * 4; return [0, 1, 2, 3].map(i => t.data[o + i] / 255); };
  const sample = (u: number, v: number) => {
    const x = u * tip.width - 0.5, y = v * tip.height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (xx: number, yy: number) => tip.data[Math.max(0, Math.min(tip.height - 1, yy)) * tip.width + Math.max(0, Math.min(tip.width - 1, xx))] / 255;
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let ly = 0; ly < ty; ly++) for (let lx = 0; lx < tx; lx++) {
    const ix = p.minX + lx, iy = p.minY + ly;
    if (ix >= dst.width || iy >= dst.height) continue;
    const dx = (ix + 0.5 - p.cx) * p.aspect[0], dy = (iy + 0.5 - p.cy) * p.aspect[1];
    const c = Math.cos(p.rotation), s = Math.sin(p.rotation);
    const rdx = dx * c - dy * s, rdy = dx * s + dy * c;
    if (Math.sqrt(rdx * rdx + rdy * rdy) > p.radius) continue;
    const tipA = sample((rdx / p.radius) * 0.5 + 0.5, (rdy / p.radius) * 0.5 + 0.5);
    if (tipA <= 0.001) continue;
    const brushA = p.color[3] * tipA;
    const ex = ld(src, ix, iy);
    const newA = Math.max(ex[3], brushA);
    let rgb = [p.color[0], p.color[1], p.color[2]];
    if (ex[3] > 0.001 && ex[3] >= brushA) rgb = [ex[0], ex[1], ex[2]];
    else if (ex[3] > 0.001) {
      const t = (brushA - ex[3]) / Math.max(brushA, 0.001);
      rgb = [0, 1, 2].map(i => ex[i] + (p.color[i] - ex[i]) * t);
    }
    const out = [...rgb, newA], o = (iy * dst.width + ix) * 4;
    for (let i = 0; i < 4; i++) dst.data[o + i] = Math.round(Math.max(0, Math.min(1, out[i])) * 255);
  }
}
