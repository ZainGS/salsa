/**
 * GPU CULLING MODE (performance-plan.md §P15, docs/ui/performance.md §GPU-driven rendering): 'on' / 'off' / 'auto'.
 *
 * The GPU-driven path (gpu-scene.ts) takes 25-45 % off the renderer's main-thread time but costs some GPU time in big
 * tiled worlds on D3D12 (every record is an indirect draw, culled ones included: about +1-2 ms of frame GPU time in
 * the tiled city since the 2026-10-03 fixes, more while other applications load the GPU). Which path is faster depends on
 * which side of the frame is the bottleneck, and that changes with the view: a window-sized frame or Play is usually
 * CPU-bound (the GPU path wins), a full-screen tiled frame GPU-bound (the CPU path wins).
 *
 * 'auto' decides from measured costs, every frame:
 *  - inputs: the renderer's main-thread ms per frame (WebGPURenderer.render) and the GPU frame ms from timestamp
 *    queries (GpuFrameTimer), each tagged with the path that was active; medians over a short window that starts
 *    `settleMs` after the last switch (the GPU samples arrive 1-2 frames late, and the first frames after a switch
 *    are transitional);
 *  - the other path's cost is PREDICTED from the current one with per-path ratios (CPU ms on the GPU path / on the
 *    CPU path, and the same for GPU ms), learned at each switch by comparing the windows before and after it;
 *  - on the GPU path it switches to the CPU path when the frame is GPU-bound (GPU ms over `gpuHigh` x the budget and
 *    over the CPU ms) and the CPU path is predicted at least `gain` faster;
 *  - on the CPU path it switches back when the frame is CPU-bound and the GPU path is predicted `gain` faster, or
 *    when the GPU path is predicted comfortably under the budget (`headroom`: the GPU path is the default because it
 *    frees the main thread for everything else);
 *  - a switch is never sooner than `dwellMs` after the last one, except that a switch that made the frame slower goes
 *    straight back once (a regret return) and doubles the dwell (up to `maxDwellMs`); a quiet period brings it back.
 *  - without GPU timestamps (the 'estimate' timer cannot tell a CPU-bound frame from a GPU-bound one) it stays on
 *    the GPU path.
 * Pure (no GPU, no clock): the renderer feeds samples and calls decide(now). Unit-tested in gpu-cull-auto.test.ts.
 *
 * The mode is a per-machine viewport preference (localStorage, like resolution scaling), never document data.
 */

export type GpuCullingMode = 'auto' | 'on' | 'off';
export type GpuCullPath = 'gpu' | 'cpu';
/** Why the active path is active: the mode forces it, the frame's bottleneck, or a fallback. */
export type GpuCullReason = 'mode-on' | 'mode-off' | 'measuring' | 'cpu-bound' | 'gpu-bound' | 'headroom' | 'dwell' | 'no-timer' | 'unavailable';

export const GPU_CULL_REASON_TEXT: Record<GpuCullReason, string> = {
  'mode-on': 'set to On', 'mode-off': 'set to Off', measuring: 'measuring', 'cpu-bound': 'CPU-bound', 'gpu-bound': 'GPU-bound',
  headroom: 'headroom', dwell: 'holding', 'no-timer': 'no GPU timer', unavailable: 'GPU path unavailable',
};

export interface GpuCullAutoParams {
  /** The frame budget (ms): 16.7 = 60 fps. */
  budgetMs: number;
  /** Median window (ms) and the samples it needs (CPU; GPU needs half). */
  windowMs: number;
  minSamples: number;
  /** Samples this soon after a switch are ignored (transition frames, late GPU samples of the old path). */
  settleMs: number;
  /** Minimum time between switches, and its cap after regretted switches. */
  dwellMs: number;
  maxDwellMs: number;
  /** GPU-bound on the GPU path: GPU ms over gpuHigh x budget (and over the CPU ms). */
  gpuHigh: number;
  /** CPU-bound on the CPU path: CPU ms over cpuHigh x budget (and over the GPU ms). */
  cpuHigh: number;
  /** Back to the GPU path when it is predicted under headroom x budget. Must be below gpuHigh (the hysteresis band). */
  headroom: number;
  /** A switch for speed needs the other path predicted at least this much faster (fraction). */
  gain: number;
  /** ... and leaving the GPU path needs this much (the CPU path also pays the warm GPU scene's upkeep and a shadow
   *  re-render per switch, and GPU ms are the noisy input: other applications' GPU load inflates them). */
  leaveGain: number;
  /** Learning: the weight of a new before / after ratio, and the ratio clamps. */
  learnRate: number;
  ratioCpuRange: [number, number];
  ratioGpuRange: [number, number];
}

// Tuned 2026-10-03 (performance-plan §P15 "Auto mode, live"): a 1 s window, a 3 s dwell, a 10 % bar to leave the
// GPU path, slower learning with tighter clamps, and a regretted switch goes straight back. The first version
// (0.6 s window, 1.5 s dwell, 8 %, 50 % learning) flapped 3-4 times per 16 s segment in a GPU-contended full-screen
// tiled walk and ran slower than either forced path there.
export const GPU_CULL_AUTO_DEFAULTS: GpuCullAutoParams = {
  budgetMs: 1000 / 60, windowMs: 1000, minSamples: 12, settleMs: 300, dwellMs: 3000, maxDwellMs: 24000,
  gpuHigh: 0.9, cpuHigh: 0.85, headroom: 0.75, gain: 0.08, leaveGain: 0.1,
  learnRate: 0.3, ratioCpuRange: [0.3, 1.2], ratioGpuRange: [0.85, 2],
};

/** What a decision saw (the last switch, or the last evaluation). */
export interface GpuCullDecisionInputs {
  /** performance.now() of the evaluation. */
  at: number;
  path: GpuCullPath;
  reason: GpuCullReason;
  /** Medians of the active path over the window. */
  cpuMs: number;
  gpuMs: number;
  /** The other path's predicted CPU / GPU ms. */
  predCpuMs: number;
  predGpuMs: number;
  budgetMs: number;
  samples: number;
}

export interface GpuCullAutoState {
  path: GpuCullPath;
  reason: GpuCullReason;
  switches: number;
  /** ms since the last switch (Infinity before the first). */
  sinceSwitchMs: number;
  dwellMs: number;
  /** Learned ratios: GPU path / CPU path, for main-thread ms and GPU ms. */
  ratioCpu: number;
  ratioGpu: number;
  /** The last switch's inputs, and the last evaluation's. */
  lastSwitch: GpuCullDecisionInputs | null;
  last: GpuCullDecisionInputs | null;
}

const RING = 256;

/** A ring of (time, value, path) samples. */
class SampleRing {
  readonly t = new Float64Array(RING);
  readonly v = new Float64Array(RING);
  readonly p = new Uint8Array(RING);
  n = 0;
  head = 0;
  push(t: number, v: number, path: GpuCullPath): void {
    this.t[this.head] = t; this.v[this.head] = v; this.p[this.head] = path === 'gpu' ? 1 : 0;
    this.head = (this.head + 1) % RING; if (this.n < RING) this.n++;
  }
  /** The median of the samples of `path` at or after `t0` (NaN when fewer than `min`), and their count. */
  median(t0: number, path: GpuCullPath, min: number, scratch: number[]): { m: number; k: number } {
    scratch.length = 0;
    const want = path === 'gpu' ? 1 : 0;
    for (let i = 0; i < this.n; i++) { const j = (this.head - 1 - i + RING) % RING; if (this.t[j] < t0) break; if (this.p[j] === want) scratch.push(this.v[j]); }
    const k = scratch.length;
    if (k < Math.max(1, min)) return { m: NaN, k };
    scratch.sort((a, b) => a - b);
    return { m: k & 1 ? scratch[k >> 1] : (scratch[(k >> 1) - 1] + scratch[k >> 1]) / 2, k };
  }
  clear(): void { this.n = 0; this.head = 0; }
}

export class GpuCullAuto {
  readonly params: GpuCullAutoParams;
  private _path: GpuCullPath = 'gpu';
  private _reason: GpuCullReason = 'measuring';
  private _switches = 0;
  private _lastSwitchAt = -Infinity;
  private _dwell: number;
  private _ratioCpu = 0.7;
  private _ratioGpu = 1.15;
  private readonly _cpu = new SampleRing();
  private readonly _gpu = new SampleRing();
  private readonly _scratch: number[] = [];
  /** The window before the last switch: learned against once the new path's window is full. */
  private _pre: { cpu: number; gpu: number; from: GpuCullPath } | null = null;
  /** The last switch was a regret return (it never triggers another immediate return: no ping-pong on noise). */
  private _regretBack = false;
  private _lastSwitch: GpuCullDecisionInputs | null = null;
  private _last: GpuCullDecisionInputs | null = null;

  constructor(params: Partial<GpuCullAutoParams> = {}) {
    this.params = { ...GPU_CULL_AUTO_DEFAULTS, ...params };
    this._dwell = this.params.dwellMs;
  }

  get path(): GpuCullPath { return this._path; }
  get reason(): GpuCullReason { return this._reason; }
  get switches(): number { return this._switches; }

  /** The renderer's main-thread ms of a frame drawn on `path`. */
  sampleCpu(ms: number, path: GpuCullPath, now: number): void { if (ms >= 0 && ms < 1000) this._cpu.push(now, ms, path); }
  /** A GPU frame time (timestamps) measured while `path` was active (it arrives 1-2 frames late: settleMs covers it). */
  sampleGpu(ms: number, path: GpuCullPath, now: number): void { if (ms > 0 && ms < 1000) this._gpu.push(now, ms, path); }

  /** Forget the samples and go back to the GPU path (a mode change, a new document). The learned ratios stay. */
  reset(): void {
    this._cpu.clear(); this._gpu.clear(); this._pre = null; this._regretBack = false;
    this._path = 'gpu'; this._reason = 'measuring'; this._lastSwitchAt = -Infinity; this._dwell = this.params.dwellMs;
  }

  /**
   * The path for the frame about to be drawn. `timer` = what the GPU frame timer can measure: 'timestamp' (exact),
   * 'estimate' (CPU start to GPU done: cannot tell CPU- from GPU-bound: the GPU path) or 'none' (not running: hold).
   */
  decide(now: number, timer: 'timestamp' | 'estimate' | 'none'): GpuCullPath {
    const P = this.params;
    // the timer is off (starting up, a snapshot capture): hold the path; no samples arrive, so the window refills
    if (timer === 'none') return this._path;
    if (timer !== 'timestamp') {
      if (this._path !== 'gpu') this._switch('gpu', 'no-timer', now, NaN, NaN, NaN, NaN, 0);
      this._reason = 'no-timer';
      return this._path;
    }
    const since = now - this._lastSwitchAt;
    if (since < P.settleMs) return this._path;
    const t0 = Math.max(this._lastSwitchAt + P.settleMs, now - P.windowMs);
    const c = this._cpu.median(t0, this._path, P.minSamples, this._scratch);
    const g = this._gpu.median(t0, this._path, Math.ceil(P.minSamples / 2), this._scratch);
    if (!(c.m >= 0) || !(g.m > 0)) { if (this._switches === 0 && this._last === null) this._reason = 'measuring'; return this._path; }
    const cpu = c.m, gpu = g.m, cost = Math.max(cpu, gpu), B = P.budgetMs;
    // learn the ratios from the first full window after a switch
    if (this._pre) {
      const pre = this._pre; this._pre = null;
      const onGpu = this._path === 'gpu';
      const rc = onGpu ? cpu / pre.cpu : pre.cpu / cpu, rg = onGpu ? gpu / pre.gpu : pre.gpu / gpu, L = P.learnRate;
      if (Number.isFinite(rc) && rc > 0) this._ratioCpu = clamp(this._ratioCpu * (1 - L) + rc * L, P.ratioCpuRange[0], P.ratioCpuRange[1]);
      if (Number.isFinite(rg) && rg > 0) this._ratioGpu = clamp(this._ratioGpu * (1 - L) + rg * L, P.ratioGpuRange[0], P.ratioGpuRange[1]);
      // a switch for speed that made the frame slower: go straight back (not after a regret return itself) and wait
      // longer before the next speed switch
      const preCost = Math.max(pre.cpu, pre.gpu);
      if (this._lastSwitch && this._lastSwitch.reason !== 'no-timer' && this._lastSwitch.reason !== 'headroom' && cost > preCost * (1 + P.gain)) {
        this._dwell = Math.min(P.maxDwellMs, this._dwell * 2);
        if (!this._regretBack) {
          const back = pre.from;
          this._switch(back, back === 'gpu' ? 'cpu-bound' : 'gpu-bound', now, cpu, gpu, pre.cpu, pre.gpu, c.k);
          this._pre = null; this._regretBack = true;
          return this._path;
        }
      }
    }
    if (since > 4 * P.maxDwellMs) this._dwell = P.dwellMs;
    const onGpu = this._path === 'gpu';
    const oCpu = onGpu ? cpu / this._ratioCpu : cpu * this._ratioCpu;
    const oGpu = onGpu ? gpu / this._ratioGpu : gpu * this._ratioGpu;
    const oCost = Math.max(oCpu, oGpu);
    const faster = oCost < cost * (1 - (onGpu ? P.leaveGain : P.gain));
    let want: GpuCullPath = this._path, reason: GpuCullReason;
    if (onGpu) {
      const gpuBound = gpu >= B * P.gpuHigh && gpu >= cpu;
      if (gpuBound && faster) { want = 'cpu'; reason = 'gpu-bound'; }
      else reason = cost < B * P.headroom ? 'headroom' : cpu >= gpu ? 'cpu-bound' : 'gpu-bound';
    } else {
      const cpuBound = cpu >= B * P.cpuHigh && cpu >= gpu;
      if (cpuBound && faster) { want = 'gpu'; reason = 'cpu-bound'; }
      else if (oCost <= B * P.headroom && oGpu <= B * P.headroom) { want = 'gpu'; reason = 'headroom'; }
      else reason = gpu >= cpu ? 'gpu-bound' : 'cpu-bound';
    }
    const inputs: GpuCullDecisionInputs = { at: now, path: want, reason, cpuMs: cpu, gpuMs: gpu, predCpuMs: oCpu, predGpuMs: oGpu, budgetMs: B, samples: c.k };
    if (want !== this._path) {
      if (since < this._dwell) { inputs.path = this._path; inputs.reason = 'dwell'; this._last = inputs; this._reason = 'dwell'; return this._path; }
      this._switch(want, reason, now, cpu, gpu, oCpu, oGpu, c.k);
      return this._path;
    }
    this._reason = reason; this._last = inputs;
    return this._path;
  }

  private _switch(to: GpuCullPath, reason: GpuCullReason, now: number, cpu: number, gpu: number, oCpu: number, oGpu: number, k: number): void {
    const inputs: GpuCullDecisionInputs = { at: now, path: to, reason, cpuMs: cpu, gpuMs: gpu, predCpuMs: oCpu, predGpuMs: oGpu, budgetMs: this.params.budgetMs, samples: k };
    this._pre = Number.isFinite(cpu) && Number.isFinite(gpu) ? { cpu, gpu, from: this._path } : null;
    this._path = to; this._reason = reason; this._lastSwitchAt = now; this._switches++; this._regretBack = false;
    this._lastSwitch = inputs; this._last = inputs;
  }

  state(now: number): GpuCullAutoState {
    return { path: this._path, reason: this._reason, switches: this._switches, sinceSwitchMs: now - this._lastSwitchAt, dwellMs: this._dwell,
      ratioCpu: this._ratioCpu, ratioGpu: this._ratioGpu, lastSwitch: this._lastSwitch, last: this._last };
  }
}

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

// ── Persistence: a per-machine viewport preference (like resolution scaling), never document data ──────────────

export const GPU_CULL_PREF_KEY = 'salsa.viewport.gpuCulling';

export function sanitizeGpuCullingMode(x: unknown): GpuCullingMode {
  return x === 'on' || x === 'off' || x === 'auto' ? x : 'auto';
}

type PrefStore = Pick<Storage, 'getItem' | 'setItem'>;
function defaultStore(): PrefStore | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** The stored mode ('auto' when nothing valid is stored or storage is blocked). */
export function loadGpuCullingMode(store: PrefStore | null = defaultStore()): GpuCullingMode {
  try { return sanitizeGpuCullingMode(store?.getItem(GPU_CULL_PREF_KEY)); } catch { return 'auto'; }
}

export function saveGpuCullingMode(mode: GpuCullingMode, store: PrefStore | null = defaultStore()): void {
  try { store?.setItem(GPU_CULL_PREF_KEY, sanitizeGpuCullingMode(mode)); } catch { /* storage blocked: this session only */ }
}
