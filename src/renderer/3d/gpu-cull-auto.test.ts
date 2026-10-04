/**
 * GPU CULLING MODE, the 'auto' controller (gpu-cull-auto.ts): the CPU-bound / GPU-bound decision with hysteresis and
 * a minimum dwell, the timer fallbacks, the learned per-path ratios, and the per-machine preference. The clock is
 * simulated (no wall-clock assertions): each test feeds samples at synthetic times and calls decide(now).
 */
import { describe, it, expect } from 'vitest';
import { GpuCullAuto, GPU_CULL_AUTO_DEFAULTS, GPU_CULL_PREF_KEY, loadGpuCullingMode, saveGpuCullingMode, sanitizeGpuCullingMode, type GpuCullPath } from './gpu-cull-auto';

/** A synthetic scene: the true per-path costs (ms) as a function of time; the controller sees noisy samples of the
 *  path it picked. One frame per `dt` ms; the GPU sample of a frame arrives two frames late (as the timer's). */
function simulate(auto: GpuCullAuto, cost: (t: number, path: GpuCullPath) => { cpu: number; gpu: number }, ms: number, dt = 16.7, seed = 1, timer: 'timestamp' | 'estimate' | 'none' = 'timestamp') {
  let s = seed >>> 0;
  const noise = () => { s = (s * 1664525 + 1013904223) >>> 0; return 1 + ((s / 4294967296) - 0.5) * 0.1; };   // +-5 %
  const pending: { at: number; ms: number; path: GpuCullPath }[] = [];
  const paths: GpuCullPath[] = [];
  for (let t = 0; t < ms; t += dt) {
    const p = auto.decide(t, timer);
    paths.push(p);
    const c = cost(t, p);
    auto.sampleCpu(c.cpu * noise(), p, t + c.cpu);
    pending.push({ at: t + 2 * dt, ms: c.gpu * noise(), path: p });
    while (pending.length && pending[0].at <= t) { const g = pending.shift()!; auto.sampleGpu(g.ms, auto.path, g.at); }   // tagged with the path active on arrival
  }
  return paths;
}
const B = GPU_CULL_AUTO_DEFAULTS.budgetMs;
/** The measured trade (performance-plan §P15): the GPU path cuts the CPU ms and adds GPU ms. */
const trade = (cpuCpuPath: number, gpuCpuPath: number, dCpu = 0.7, dGpu = 1.25) => (_t: number, p: GpuCullPath) =>
  p === 'gpu' ? { cpu: cpuCpuPath * dCpu, gpu: gpuCpuPath * dGpu } : { cpu: cpuCpuPath, gpu: gpuCpuPath };

describe('GPU culling auto mode', () => {
  it('CPU-bound (a window-sized tiled walk): stays on the GPU path', () => {
    const a = new GpuCullAuto();
    const paths = simulate(a, trade(18, 8), 10000);
    expect(paths.every((p) => p === 'gpu')).toBe(true);
    expect(a.switches).toBe(0);
    expect(['cpu-bound', 'headroom']).toContain(a.reason);
  });

  it('GPU-bound (full screen, tiled): moves to the CPU path once and stays there', () => {
    const a = new GpuCullAuto();
    const paths = simulate(a, trade(12, 24), 15000);
    expect(a.switches).toBe(1);
    expect(a.path).toBe('cpu');
    expect(a.reason).toBe('gpu-bound');
    const st = a.state(15000);
    expect(st.lastSwitch!.reason).toBe('gpu-bound');
    expect(st.lastSwitch!.gpuMs).toBeGreaterThan(B * GPU_CULL_AUTO_DEFAULTS.gpuHigh);
    expect(st.lastSwitch!.predGpuMs).toBeLessThan(st.lastSwitch!.gpuMs);
    // the switch waited for a full window of samples, not the first frame
    expect(paths.indexOf('cpu')).toBeGreaterThanOrEqual(GPU_CULL_AUTO_DEFAULTS.minSamples);
  });

  it('learns the ratios across a switch (towards the measured trade)', () => {
    const a = new GpuCullAuto();
    simulate(a, trade(12, 24, 0.6, 1.4), 15000);
    const st = a.state(15000);
    expect(st.ratioGpu).toBeGreaterThan(1.2);   // prior 1.15, measured 1.4
    expect(st.ratioCpu).toBeLessThan(0.7);      // prior 0.7, measured 0.6
  });

  it('hysteresis: a frame near the threshold does not flap (at most one switch in 30 s)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = new GpuCullAuto();
      // GPU path: GPU at ~15.3 ms (just over 0.9 x budget), CPU path: GPU 13.5 ms, CPU 12 ms
      simulate(a, (_t, p) => (p === 'gpu' ? { cpu: 9, gpu: 15.3 } : { cpu: 12.5, gpu: 13.4 }), 30000, 16.7, seed);
      expect(a.switches, 'seed ' + seed).toBeLessThanOrEqual(1);
    }
  });

  it('dwell: the way back waits at least dwellMs, even when the view changes at once', () => {
    const a = new GpuCullAuto();
    let tSwitch = -1;
    const paths: { t: number; p: GpuCullPath }[] = [];
    // GPU-bound until 3 s, then a light, CPU-bound view
    const cost = (t: number, p: GpuCullPath) => (t < 3000 ? trade(12, 24)(t, p) : trade(18, 6)(t, p));
    let s = 7;
    const noise = () => { s = (s * 1664525 + 1013904223) >>> 0; return 1 + ((s / 4294967296) - 0.5) * 0.1; };
    for (let t = 0; t < 12000; t += 16.7) {
      const p = a.decide(t, 'timestamp');
      if (p === 'cpu' && tSwitch < 0) tSwitch = t;
      paths.push({ t, p });
      const c = cost(t, p);
      a.sampleCpu(c.cpu * noise(), p, t); a.sampleGpu(c.gpu * noise(), p, t);
    }
    expect(tSwitch).toBeGreaterThan(0);
    const back = paths.find((x) => x.t > tSwitch && x.p === 'gpu');
    expect(back).toBeDefined();
    expect(back!.t - tSwitch).toBeGreaterThanOrEqual(GPU_CULL_AUTO_DEFAULTS.dwellMs);
    expect(['cpu-bound', 'headroom']).toContain(a.state(12000).lastSwitch!.reason);
    expect(a.path).toBe('gpu');
  });

  it('a switch that made the frame slower doubles the dwell', () => {
    const a = new GpuCullAuto();
    // the CPU path turns out WORSE than predicted (the GPU barely improves, the CPU explodes)
    simulate(a, (_t, p) => (p === 'gpu' ? { cpu: 8, gpu: 17 } : { cpu: 24, gpu: 16.5 }), 20000);
    expect(a.state(20000).dwellMs).toBeGreaterThan(GPU_CULL_AUTO_DEFAULTS.dwellMs);
    expect(a.switches).toBeLessThanOrEqual(4);   // back to the GPU path, then it holds
    expect(a.path).toBe('gpu');
  });

  it('a regretted switch goes straight back (before the dwell) and then holds', () => {
    const a = new GpuCullAuto();
    const paths = simulate(a, (_t, p) => (p === 'gpu' ? { cpu: 8, gpu: 17 } : { cpu: 24, gpu: 16.5 }), 30000);
    const first = paths.indexOf('cpu'), back = paths.indexOf('gpu', first);
    expect(first).toBeGreaterThan(0);
    expect((back - first) * 16.7).toBeLessThan(GPU_CULL_AUTO_DEFAULTS.dwellMs);   // not held on the worse path for a dwell
    expect(a.path).toBe('gpu');
    expect(a.switches).toBeLessThanOrEqual(4);
  });

  it('GPU load from other applications (spiky GPU ms on the GPU path) does not make it flap', () => {
    for (const seed of [1, 2, 3]) {
      const a = new GpuCullAuto();
      let s = seed * 977;
      const spike = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) < 0.3 ? 2.2 : 1; };
      // quiet: GPU path 13 ms GPU / 12 ms CPU, CPU path 11.5 / 24 (CPU-bound): 30 % of the GPU path's frames double
      simulate(a, (_t, p) => (p === 'gpu' ? { cpu: 12, gpu: 13 * spike() } : { cpu: 24, gpu: 11.5 }), 30000, 16.7, seed);
      expect(a.switches, 'seed ' + seed).toBeLessThanOrEqual(2);
      expect(a.path, 'seed ' + seed).toBe('gpu');
    }
  });

  it('no GPU timestamps: the estimate cannot tell, so the GPU path; a stopped timer holds the path', () => {
    const a = new GpuCullAuto();
    simulate(a, trade(12, 24), 6000);
    expect(a.path).toBe('cpu');
    a.decide(6100, 'none');
    expect(a.path).toBe('cpu');      // a snapshot capture stopped the timer: hold
    a.decide(6200, 'estimate');
    expect(a.path).toBe('gpu');      // no timestamp-query: the GPU path
    expect(a.reason).toBe('no-timer');
    const b = new GpuCullAuto();
    expect(simulate(b, trade(12, 24), 6000, 16.7, 1, 'estimate').every((p) => p === 'gpu')).toBe(true);
  });

  it('reset forgets the samples and returns to the GPU path; the ratios stay', () => {
    const a = new GpuCullAuto();
    simulate(a, trade(12, 24, 0.6, 1.4), 15000);
    const r = a.state(15000).ratioGpu;
    a.reset();
    expect(a.path).toBe('gpu'); expect(a.reason).toBe('measuring');
    expect(a.state(15000).ratioGpu).toBe(r);
    expect(a.decide(15020, 'timestamp')).toBe('gpu');   // no samples yet: holds
  });
});

describe('GPU culling mode preference', () => {
  const store = () => { const m = new Map<string, string>(); return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } }; };
  it('round-trips; anything unknown reads as auto', () => {
    const { m, s } = store();
    expect(loadGpuCullingMode(s)).toBe('auto');
    saveGpuCullingMode('off', s);
    expect(m.get(GPU_CULL_PREF_KEY)).toBe('off');
    expect(loadGpuCullingMode(s)).toBe('off');
    m.set(GPU_CULL_PREF_KEY, 'sometimes');
    expect(loadGpuCullingMode(s)).toBe('auto');
    expect(sanitizeGpuCullingMode('on')).toBe('on');
    expect(sanitizeGpuCullingMode(undefined)).toBe('auto');
  });
  it('blocked storage: no throw, auto', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadGpuCullingMode(bad)).toBe('auto');
    expect(() => saveGpuCullingMode('on', bad)).not.toThrow();
    expect(loadGpuCullingMode(null)).toBe('auto');
  });
});
