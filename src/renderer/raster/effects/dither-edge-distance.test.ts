/**
 * Content-edge DISTANCE for the dither edge effects (2026-10-09): a jump flood (JFA) replaced the 25-tap coverage
 * estimate, so any edge width ramps smoothly. Covers the step schedule / reach, the flood vs a brute-force distance
 * transform on random masks, the engine's GPU path (run on the CPU mirror: cpu-gpu-mirror.ts ports the flood and the
 * Bayer dither shader) vs a brute-force reference, smoothness at wide bands, tiling, the pooled scratch and the skips.
 * The WGSL itself is checked against these CPU ports on real D3D12 through the Dawn-node harness.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createCpuDevice, installGpuGlobals, edgeSeedsCpu, edgeRamp, JFA_NONE, type CpuTexture } from '../cpu-gpu-mirror';
import {
  DitherEngine, defaultDitherConfig, ditherEdgeJfaSteps, ditherEdgeJfaCone, ditherEdgeWidth, DITHER_EDGE_WIDTH_MAX,
  type DitherConfig,
} from './dither-engine';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.useRealTimers(); });

const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A presence mask (1 = painted) → an rgba8 texture (alpha 255 / 0; painted texels get a soft alpha >= 2/255 too). */
function texOf(gpu: ReturnType<typeof createCpuDevice>, mask: Uint8Array, W: number, H: number, rnd = rng(1)): CpuTexture {
  const t = gpu.mkTex(W, H, 'rgba8unorm');
  for (let i = 0; i < W * H; i++) {
    t.data[i * 4] = 0; t.data[i * 4 + 1] = 0; t.data[i * 4 + 2] = 0;
    t.data[i * 4 + 3] = mask[i] ? (rnd() < 0.2 ? 2 + Math.floor(rnd() * 200) : 255) : (rnd() < 0.3 ? 1 : 0);   // alpha 1 = below the 0.004 cutoff
  }
  return t;
}

/** Random masks: blobs, holes, thin lines (1-2 px), specks, paint touching the border. */
function randomMask(W: number, H: number, rnd: () => number): Uint8Array {
  const m = new Uint8Array(W * H);
  const disc = (cx: number, cy: number, r: number, v: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * W + x] = v;
  };
  for (let k = 0; k < 5; k++) disc(rnd() * W, rnd() * H, 4 + rnd() * W * 0.35, 1);
  disc(0, rnd() * H, 10 + rnd() * 15, 1);                                  // touching the left border
  for (let k = 0; k < 4; k++) disc(rnd() * W, rnd() * H, 1 + rnd() * 6, 0);   // holes
  for (let k = 0; k < 3; k++) {                                            // thin lines: painted, then unpainted
    const v = k % 2 === 0 ? 1 : 0, y0 = rnd() * H, x0 = rnd() * W, ang = rnd() * Math.PI, th = 0.5 + rnd();
    for (let s = -W; s < W; s += 0.5) disc(x0 + Math.cos(ang) * s, y0 + Math.sin(ang) * s, th, v);
  }
  for (let i = 0; i < W * H; i++) if (rnd() < 0.004) m[i] ^= 1;          // specks
  return m;
}

/** Brute-force distance (texel centres) from every texel to the nearest UNPAINTED texel (0 on one, Infinity: none). */
function bruteDistance(mask: Uint8Array, W: number, H: number): Float64Array {
  const seeds: number[] = [];
  for (let i = 0; i < W * H; i++) if (!mask[i]) seeds.push(i % W, Math.floor(i / W));
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let best = Infinity;
    for (let k = 0; k < seeds.length; k += 2) { const d = (seeds[k] - x) ** 2 + (seeds[k + 1] - y) ** 2; if (d < best) best = d; }
    out[y * W + x] = Math.sqrt(best);
  }
  return out;
}

const seedDist = (v: number, x: number, y: number) => (v === JFA_NONE ? Infinity : Math.hypot((v & 0xFFFF) - x, (v >>> 16) - y));

function cfgOf(patch: Partial<DitherConfig>): DitherConfig {
  return { ...defaultDitherConfig(), enabled: true, algorithm: 'bayer', ...patch };
}

/** A config whose output RED byte = round(255 · edge factor) on painted texels: black art, white FG = BG duotone,
 *  fade 1 → result = mix(black, white, e). */
function revealCfg(edgeWidth: number, patch: Partial<DitherConfig> = {}): DitherConfig {
  return cfgOf({ colorMode: 'duotone', foregroundColor: [1, 1, 1, 1], backgroundColor: [1, 1, 1, 1], edgeWidth, edgeFade: 1, ...patch });
}

describe('Edge distance: width sanitising, flood schedule and reach', () => {
  it('width: NaN / negative / missing → 0; capped at DITHER_EDGE_WIDTH_MAX (>= 2048)', () => {
    expect(DITHER_EDGE_WIDTH_MAX).toBeGreaterThanOrEqual(2048);
    expect(ditherEdgeWidth({ edgeWidth: NaN })).toBe(0);
    expect(ditherEdgeWidth({ edgeWidth: -5 })).toBe(0);
    expect(ditherEdgeWidth({} as DitherConfig)).toBe(0);
    expect(ditherEdgeWidth({ edgeWidth: 37.5 })).toBe(37.5);
    expect(ditherEdgeWidth({ edgeWidth: 1e9 })).toBe(DITHER_EDGE_WIDTH_MAX);
    expect(ditherEdgeWidth({ edgeWidth: Infinity })).toBe(DITHER_EDGE_WIDTH_MAX);
    // the reach / flood follow the sanitised width: NaN = off
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: NaN, edgeFade: 1 }), 512)).toBe(0);
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: -3, edgeFade: 1 }), 512)).toBe(0);
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 1e9, edgeFade: 1 }), 512)).toBe(ditherEdgeJfaCone(DITHER_EDGE_WIDTH_MAX));
  });

  it('steps: a ceil-halving run reaching M = ceil(width + 0.5) with the smallest first step, then the 2, 1 refinement', () => {
    for (const w of [0.5, 1, 2, 2.5, 3, 4, 7.3, 8, 16, 31, 64, 100, 200, 512, 1000, 2048, 4096]) {
      const steps = ditherEdgeJfaSteps(w);
      const m = Math.ceil(w + 0.5);
      const base = m >= 3 ? steps.slice(0, -2) : steps.slice();
      if (m >= 3) expect(steps.slice(-2)).toEqual([2, 1]);
      for (let i = 1; i < base.length; i++) expect(base[i]).toBe(Math.ceil(base[i - 1] / 2));
      expect(base[base.length - 1]).toBe(1);
      const sum = base.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(m);
      // the first step is the smallest that reaches M
      if (base[0] > 1) {
        let s = base[0] - 1, t = 0;
        for (;; s = Math.ceil(s / 2)) { t += s; if (s === 1) break; }
        expect(t).toBeLessThan(m);
      }
      expect(steps.length).toBeLessThanOrEqual(Math.ceil(Math.log2(m + 1)) + 3);   // log2 passes
      expect(ditherEdgeJfaCone(w)).toBe(steps.reduce((a, b) => a + b, 0));
      expect(ditherEdgeJfaCone(w)).toBeLessThanOrEqual(m + 2 * Math.ceil(Math.log2(m + 1)) + 3);   // ≈ width, not 2×
    }
    expect(ditherEdgeJfaSteps(NaN)).toEqual([1]);   // never loops on a bad width
    expect(ditherEdgeJfaSteps(-4)).toEqual([1]);
    expect(ditherEdgeJfaSteps(1e12)).toEqual(ditherEdgeJfaSteps(DITHER_EDGE_WIDTH_MAX));
  });

  it('reach = flood cone (+ the density cell-centre term); 0 when nothing reads the distance', () => {
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20, edgeFade: 1 }), 512)).toBe(ditherEdgeJfaCone(20));
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20, edgeFade: 1, edgeMode: 'both' }), 512)).toBe(ditherEdgeJfaCone(20));
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20, edgeFade: 1, edgeMode: 'canvas' }), 512)).toBe(0);
    expect(DitherEngine.rectReach(cfgOf({ edgeWidth: 20 }), 512)).toBe(0);
    const d = DitherEngine.rectReach(cfgOf({ bayerLevel: 2, edgeWidth: 20, edgeDensity: 0.5 }), 512);
    expect(d).toBeGreaterThanOrEqual(ditherEdgeJfaCone(20) + 4 + 1);   // + about half an 8-px tile
  });
});

describe('Edge distance: the flood vs a brute-force distance transform', () => {
  it('random masks (blobs, holes, thin lines, specks, paint on the border): exact in the band at every width', () => {
    const W = 90, H = 70;
    let band = 0, wrong = 0, worst = 0;
    for (let t = 0; t < 8; t++) {
      const rnd = rng(1000 + t);
      const mask = randomMask(W, H, rnd);
      const gpu = createCpuDevice();
      const tex = texOf(gpu, mask, W, H, rnd);
      const bf = bruteDistance(mask, W, H);
      for (const w of [1, 3, 6, 17, 40]) {
        const seeds = edgeSeedsCpu(tex, { x0: 0, y0: 0, x1: W, y1: H }, ditherEdgeJfaSteps(w));
        for (let i = 0; i < W * H; i++) {
          const x = i % W, y = Math.floor(i / W);
          const d = seedDist(seeds[i], x, y);
          expect(d).toBeGreaterThanOrEqual(bf[i] - 1e-9);   // a found seed is always a real one
          if (!(bf[i] < w + 0.5)) continue;                  // past the band every distance gives factor 1
          band++;
          if (Math.abs(d - bf[i]) > 1e-9) { wrong++; worst = Math.max(worst, d - bf[i]); }
        }
      }
    }
    expect(band).toBeGreaterThan(50000);
    expect(wrong / band).toBeLessThan(1e-4);   // JFA+2: no misses on these masks; allow a stray one
    expect(worst).toBeLessThan(0.25);
  });

  it('empty layer: every texel is its own seed; full layer: no seed (the texture border is NOT an edge)', () => {
    const W = 33, H = 21, gpu = createCpuDevice();
    const empty = texOf(gpu, new Uint8Array(W * H), W, H);
    const full = texOf(gpu, new Uint8Array(W * H).fill(1), W, H);
    const se = edgeSeedsCpu(empty, { x0: 0, y0: 0, x1: W, y1: H }, ditherEdgeJfaSteps(12));
    for (let i = 0; i < W * H; i++) expect(se[i]).toBe(((i % W) | (Math.floor(i / W) << 16)) >>> 0);
    const sf = edgeSeedsCpu(full, { x0: 0, y0: 0, x1: W, y1: H }, ditherEdgeJfaSteps(12));
    expect(sf.every(v => v === JFA_NONE)).toBe(true);
    // a sub-domain sees the same thing (domain-relative seeds)
    const sd = edgeSeedsCpu(empty, { x0: 5, y0: 3, x1: 20, y1: 10 }, ditherEdgeJfaSteps(4));
    expect(sd[0]).toBe(0);
    expect(sd[15 * 2 + 4]).toBe((4 | (2 << 16)) >>> 0);
  });
});

describe('Edge distance: the engine (GPU path on the CPU mirror) vs a brute-force reference', () => {
  it('the dithered edge factor equals the brute-force distance ramp, whole texture and any region', () => {
    const W = 80, H = 60;
    for (const w of [2, 7, 25, 90]) {
      const rnd = rng(77 + w);
      const mask = randomMask(W, H, rnd);
      const gpu = createCpuDevice();
      const src = gpu.mkTex(W, H, 'rgba8unorm');
      for (let i = 0; i < W * H; i++) src.data[i * 4 + 3] = mask[i] ? 255 : 0;   // black art
      const bf = bruteDistance(mask, W, H);
      const eng = new DitherEngine(gpu.device);
      const out = gpu.mkTex(W, H, 'rgba8unorm');
      expect(eng.applyRegion(asGpu(src), asGpu(out), revealCfg(w), null)).toBe(true);
      let off = 0;
      for (let i = 0; i < W * H; i++) {
        if (!mask[i]) continue;
        const want = Math.round(255 * edgeRamp(bf[i], w));
        if (Math.abs(out.data[i * 4] - want) > 1) off++;
      }
      expect(off, `width ${w}`).toBe(0);
      // a region pass writes exactly the whole pass's texels
      const part = gpu.mkTex(W, H, 'rgba8unorm');
      part.data.set(out.data);
      for (let k = 0; k < 6; k++) {
        const x0 = Math.floor(rnd() * W), y0 = Math.floor(rnd() * H);
        const reg = { x0, y0, x1: Math.min(W, x0 + 1 + Math.floor(rnd() * 30)), y1: Math.min(H, y0 + 1 + Math.floor(rnd() * 30)) };
        for (let y = reg.y0; y < reg.y1; y++) part.data.fill(7, (y * W + reg.x0) * 4, (y * W + reg.x1) * 4);
        eng.applyRegion(asGpu(src), asGpu(part), revealCfg(w), reg);
        expect(Buffer.from(part.data).equals(Buffer.from(out.data)), `width ${w} region ${JSON.stringify(reg)}`).toBe(true);
      }
    }
  });

  it('a fully painted layer has no content edge: the effects leave it as a plain dither (border is not an edge)', () => {
    const W = 40, H = 30, gpu = createCpuDevice();
    const tex = texOf(gpu, new Uint8Array(W * H).fill(1), W, H);
    for (let i = 0; i < W * H; i++) { tex.data[i * 4] = (i * 37) & 255; tex.data[i * 4 + 1] = (i * 11) & 255; tex.data[i * 4 + 3] = 255; }
    const run = (cfg: DitherConfig) => { const o = gpu.mkTex(W, H, 'rgba8unorm'); new DitherEngine(gpu.device).applyRegion(asGpu(tex), asGpu(o), cfg, null); return o.data; };
    const plain = run(cfgOf({ bayerLevel: 2 }));
    const edged = run(cfgOf({ bayerLevel: 2, edgeWidth: 12, edgeFade: 1, edgeShrink: 0.8, edgeDensity: 1 }));
    expect(Buffer.from(edged).equals(Buffer.from(plain))).toBe(true);
  });
});

describe('Edge distance: smooth at wide bands', () => {
  it('width 200 / 640: the factor into a large blob rises monotonically, every step <= 1.5 / width, no plateau before 1', () => {
    for (const w of [200, 640]) {
      // a big disc (radius width + 40), the 9 rows through its centre: a curved rim, the factor along each row from
      // the rim to the centre
      const R = w + 40, W = 2 * R + 20, H = 9, cx = W / 2, cy = 4, gpu = createCpuDevice();
      const mask = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = Math.hypot(x - cx, y - cy) <= R ? 1 : 0;
      const tex = texOf(gpu, mask, W, H);
      const seeds = edgeSeedsCpu(tex, { x0: 0, y0: 0, x1: W, y1: H }, ditherEdgeJfaSteps(w));
      for (const y of [0, 4, 8]) {
        let prev = -1, reached = false;
        for (let x = mask.indexOf(1, y * W) - y * W; x < cx; x++) {   // from the rim (the first painted texel) inward
          const e = edgeRamp(seedDist(seeds[y * W + x], x, y), w);
          if (prev >= 0) {
            expect(e).toBeGreaterThanOrEqual(prev);
            expect(e - prev).toBeLessThanOrEqual(1.5 / w + 1e-9);
            if (prev < 1) expect(e, `w ${w} x ${x}`).toBeGreaterThan(prev);   // no plateau before the band ends
          }
          if (e === 1) reached = true;
          prev = e;
        }
        expect(reached).toBe(true);
      }
    }
    // the old 25 taps had at most 25 levels across the band; the distance ramp has one per texel
    const levels = new Set<number>();
    for (let d = 1; d <= 201; d++) levels.add(edgeRamp(d, 200));
    expect(levels.size).toBeGreaterThan(195);
  });

  it('small widths keep the old straight-edge profile (within the old taps’ steps)', () => {
    // the old estimate at a straight edge, x texels inside: 25 alpha-presence taps on 3 rings
    const oldE = (x: number, radius: number) => {
      let cov = 1, count = 1;
      for (let ring = 0; ring < 3; ring++) {
        const r = radius * ((ring + 1) / 3);
        for (let k = 0; k < 8; k++) {
          const ox = Math.cos(Math.fround((k + ring * 0.5) * 0.7853981634)) * r;
          cov += x + Math.trunc(ox + Math.sign(ox) * 0.5) >= 0 ? 1 : 0;
          count++;
        }
      }
      return Math.max(0, Math.min(1, (cov / count - 0.5) * 2));
    };
    for (const w of [3, 6, 12, 48]) {
      for (let x = 0; x <= w + 1; x++) expect(Math.abs(edgeRamp(x + 1, w) - oldE(x, w)), `w ${w} x ${x}`).toBeLessThan(0.21);
    }
  });
});

describe('Edge distance: cost and memory', () => {
  it('no flood when nothing reads the distance (width 0, all amounts 0, canvas mode)', () => {
    const W = 48, H = 32, gpu = createCpuDevice();
    const tex = texOf(gpu, randomMask(W, H, rng(3)), W, H);
    const eng = new DitherEngine(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    for (const c of [{}, { edgeWidth: 30 }, { edgeWidth: 0, edgeFade: 1 }, { edgeWidth: 30, edgeFade: 1, edgeDensity: 1, edgeMode: 'canvas' as const }]) {
      eng.applyRegion(asGpu(tex), asGpu(out), cfgOf(c), null);
    }
    expect(eng.stats.floods).toBe(0);
    expect(eng.jfaScratchBytes).toBe(0);
    eng.applyRegion(asGpu(tex), asGpu(out), cfgOf({ edgeWidth: 5, edgeShrink: 0.5, edgeMode: 'both' }), null);
    expect(eng.stats.floods).toBe(1);
  });

  it('a stroke-sized region floods only its region + reach (pooled scratch, not the layer size); idle → freed', () => {
    vi.useFakeTimers();
    const W = 1024, H = 768, gpu = createCpuDevice();
    const mask = new Uint8Array(W * H);
    for (let y = 100; y < 600; y++) for (let x = 100; x < 900; x++) mask[y * W + x] = 1;
    const tex = texOf(gpu, mask, W, H);
    const eng = new DitherEngine(gpu.device);
    const out = gpu.mkTex(W, H, 'rgba8unorm');
    const cfg = cfgOf({ edgeWidth: 8, edgeFade: 0.7 });
    const reach = DitherEngine.rectReach(cfg, W);
    eng.applyRegion(asGpu(tex), asGpu(out), cfg, { x0: 300, y0: 300, x1: 330, y1: 330 });
    const dom = 30 + 2 * reach;   // the dispatched rect grown by the reach (the cache grows a dab rect once more first)
    expect(eng.stats.jfaTexels).toBe(dom * dom * (ditherEdgeJfaSteps(8).length + 1));
    expect(eng.jfaScratchBytes).toBe(Math.ceil(dom / 64) * 64 * Math.ceil(dom / 64) * 64 * 8);
    expect(eng.jfaScratchBytes).toBeLessThan(W * H * 8 / 20);
    for (let i = 0; i < 5; i++) eng.applyRegion(asGpu(tex), asGpu(out), cfg, { x0: 310 + i, y0: 300, x1: 340 + i, y1: 335 });
    expect(eng.stats.jfaScratchAllocs).toBe(1);   // reused across stroke frames
    vi.advanceTimersByTime(1500);
    expect(eng.jfaScratchBytes).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    expect(eng.jfaScratchBytes).toBe(0);           // freed after 2 s idle
  });

  it('a big region past the scratch budget is flooded in tiles — the same texels as one domain; no tiling when the overlap would cost > 1.5x', () => {
    const W = 300, H = 220;
    const cases = [[3, { edgeFade: 1 }, 120], [9, { edgeShrink: -0.6, edgeDensity: 0.7, bayerLevel: 1 }, 200]] as const;
    for (const [w, patch, side] of cases) {
      const gpu = createCpuDevice();
      const tex = texOf(gpu, randomMask(W, H, rng(9 + w)), W, H);
      const cfg = cfgOf({ edgeWidth: w, ...patch });
      const one = gpu.mkTex(W, H, 'rgba8unorm'), tiled = gpu.mkTex(W, H, 'rgba8unorm');
      new DitherEngine(gpu.device).applyRegion(asGpu(tex), asGpu(one), cfg, null);
      const eng = new DitherEngine(gpu.device);
      eng.jfaScratchBudgetTexels = side * side;
      eng.jfaMinTileSide = 8;
      eng.applyRegion(asGpu(tex), asGpu(tiled), cfg, null);
      expect(eng.stats.floods).toBeGreaterThanOrEqual(4);
      expect(eng.jfaScratchBytes).toBeLessThanOrEqual(Math.ceil(side / 64) * 64 * Math.ceil(side / 64) * 64 * 8);
      expect(Buffer.from(tiled.data).equals(Buffer.from(one.data))).toBe(true);
      // the same budget with a reach so wide that tiles would mostly overlap: one domain
      const wide = new DitherEngine(gpu.device);
      wide.jfaScratchBudgetTexels = side * side;
      wide.jfaMinTileSide = 8;
      wide.applyRegion(asGpu(tex), asGpu(tiled), cfgOf({ ...cfg, edgeWidth: side / 2 - 12 }), null);
      expect(wide.stats.floods).toBe(1);
    }
  });
});
