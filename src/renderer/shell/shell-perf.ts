/**
 * shell-perf.ts — dev-only instrumentation for the Shell (docs/ui/shell-ui.md "Performance HUD + debug toggles").
 *
 *  - Debug flags: `?shellperf` (HUD + long-task log) and `?shellskip=specks,panel,grain,…` (skip a layer / a bake for
 *    an on-device A/B), also settable live through `window.salsaShellDebug` or the HUD's buttons.
 *  - ShellFrameStats: rAF interval avg / p95 / max, frames over 20 ms, render() CPU ms, the detected refresh rate.
 *  - shellMark(): User Timing marks (`shell:tap` → `shell:mode-flip` → `shell:grid-first-frame` → `shell:thumbs-ready`).
 *  - A long-task PerformanceObserver logger.
 *
 * Nothing here draws into the Shell canvas: with every flag at its default the rendered frame is unchanged.
 */

/** What the Shell draws / runs. Every layer defaults to ON; the dev flags default to OFF. */
export interface ShellDebugFlags {
  /** Show the perf HUD (`?shellperf`). */
  hud: boolean;
  /** Log long tasks (> 50 ms) to the console (`?shellperf` or `?shelllongtasks`). */
  longTasks: boolean;
  /** Polygon-theme falling specks in the background shader. */
  specks: boolean;
  /** The bottom panel card (riso circles + placeholder patterns). */
  panel: boolean;
  /** The full-screen paper grain multiply. */
  grain: boolean;
  /** The 3D wireframe terrain (3D themes) behind the logo. */
  wireGrid: boolean;
  /** The riso sticker (blob + squiggles) behind the logo (2D themes). */
  backdrop: boolean;
  /** The hero viewer mesh (logo / hovered icon / cartridge). */
  hero: boolean;
  /** The per-tile 3D batch (icon cutouts, CDs, coins). */
  tiles: boolean;
  /** The editor pipeline warm-up the host starts from the Shell (`bootAndWarm`). Read by the host. */
  warmup: boolean;
  /** Draw the panel from its baked texture (off = run the panel shader every frame, the pre-bake path). */
  panelBake: boolean;
  /** Draw the grain from its baked texture (off = run the grain shader every frame, the pre-bake path). */
  grainBake: boolean;
}

export const SHELL_DEBUG_DEFAULTS: Readonly<ShellDebugFlags> = Object.freeze({
  hud: false, longTasks: false,
  specks: true, panel: true, grain: true, wireGrid: true, backdrop: true, hero: true, tiles: true, warmup: true,
  panelBake: true, grainBake: true,
});

/** `?shellskip=` names (lower-case) → the flag they turn off. */
const SKIP_NAMES: Record<string, keyof ShellDebugFlags> = {
  specks: 'specks', panel: 'panel', grain: 'grain', grid: 'wireGrid', wiregrid: 'wireGrid', backdrop: 'backdrop',
  hero: 'hero', tiles: 'tiles', tilebatch: 'tiles', warmup: 'warmup', panelbake: 'panelBake', grainbake: 'grainBake',
};

/** The layer / bake toggles the HUD shows as buttons, in order. */
export const SHELL_DEBUG_TOGGLES: readonly (keyof ShellDebugFlags)[] =
  ['specks', 'panel', 'grain', 'wireGrid', 'backdrop', 'hero', 'tiles', 'panelBake', 'grainBake'];

/**
 * Parse the debug flags from a query string (`location.search`, or the same syntax stored under
 * localStorage 'salsa.shellperf'): `shellperf` (HUD + long tasks), `shelllongtasks`, `shellskip=a,b,c`.
 * Unknown names are ignored. Pure.
 */
export function parseShellDebug(search: string | null | undefined, base: Readonly<ShellDebugFlags> = SHELL_DEBUG_DEFAULTS): ShellDebugFlags {
  const f: ShellDebugFlags = { ...base };
  if (!search) return f;
  let p: URLSearchParams;
  try { p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search); } catch { return f; }
  const on = (k: string) => p.has(k) && p.get(k) !== '0' && p.get(k) !== 'false';
  if (on('shellperf')) { f.hud = true; f.longTasks = true; }
  if (on('shelllongtasks')) f.longTasks = true;
  for (const raw of (p.get('shellskip') ?? '').split(',')) {
    const key = SKIP_NAMES[raw.trim().toLowerCase()];
    if (key) f[key] = false;
  }
  return f;
}

let _flags: ShellDebugFlags | null = null;
/**
 * The live debug flags (one mutable object per page, also published as `window.salsaShellDebug` so a remote
 * devtools session can flip a field). Resolved once from the URL the page was LOADED with (the Angular router drops
 * query params on later navigations) plus localStorage 'salsa.shellperf'.
 */
export function getShellDebug(): ShellDebugFlags {
  if (_flags) return _flags;
  let f: ShellDebugFlags = { ...SHELL_DEBUG_DEFAULTS };
  const g = globalThis as { location?: { search?: string }; localStorage?: { getItem(k: string): string | null }; salsaShellDebug?: Partial<ShellDebugFlags> };
  try { f = parseShellDebug(g.localStorage?.getItem('salsa.shellperf'), f); } catch { /* storage blocked */ }
  try { f = parseShellDebug(g.location?.search, f); } catch { /* no location */ }
  try {
    if (g.salsaShellDebug && typeof g.salsaShellDebug === 'object') Object.assign(f, g.salsaShellDebug);   // set before load
    g.salsaShellDebug = f;
  } catch { /* frozen global */ }
  _flags = f;
  return f;
}
/** Tests only: forget the resolved flags. */
export function _resetShellDebugForTests(): void { _flags = null; }

// ── User Timing ───────────────────────────────────────────────────────────

/** A User Timing mark (cheap; a handful per interaction). Never throws. */
export function shellMark(name: string): void {
  try { (globalThis as { performance?: Performance }).performance?.mark?.(name); } catch { /* not supported */ }
}

/** ms between the LATEST marks named `from` and `to` (to after from), else null. */
export function shellMarkDelta(from: string, to: string): number | null {
  try {
    const perf = (globalThis as { performance?: Performance }).performance;
    const a = perf?.getEntriesByName?.(from, 'mark'), b = perf?.getEntriesByName?.(to, 'mark');
    if (!a?.length || !b?.length) return null;
    const d = b[b.length - 1].startTime - a[a.length - 1].startTime;
    return d >= 0 ? d : null;
  } catch { return null; }
}

// ── Frame statistics ──────────────────────────────────────────────────────

/** Common display refresh rates; the detected rate snaps to the nearest. */
const REFRESH_RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

/** Snap a frame interval (ms) to the nearest common refresh rate (Hz). 0 for no data. */
export function snapRefreshRate(intervalMs: number): number {
  if (!(intervalMs > 0)) return 0;
  const hz = 1000 / intervalMs;
  let best = REFRESH_RATES[0];
  for (const r of REFRESH_RATES) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
  return best;
}

export interface ShellFrameSummary {
  /** Samples in the window. */
  frames: number;
  avgMs: number; p95Ms: number; maxMs: number;
  /** Frames in the window whose interval exceeded 20 ms. */
  over20: number;
  /** render() CPU time over the window. */
  cpuAvgMs: number; cpuMaxMs: number;
  /** Latest GPU time (ms), or -1 when not measured. */
  gpuMs: number;
  gpuSource: 'timestamp' | 'estimate' | 'none';
  /** Detected display refresh rate (Hz), from the FASTEST sustained interval seen (0 until known). */
  refreshHz: number;
}

/** A sliding window of rAF intervals + render CPU times. Allocation-free per frame. */
export class ShellFrameStats {
  private readonly _dt: Float32Array;
  private readonly _cpu: Float32Array;
  private readonly _sort: Float32Array;
  private _n = 0;
  private _i = 0;
  private _last = 0;
  private _hasLast = false;
  private _minMedian = 0;
  private _gpuMs = -1;
  private _gpuSource: ShellFrameSummary['gpuSource'] = 'none';

  constructor(readonly window = 120) {
    this._dt = new Float32Array(window);
    this._cpu = new Float32Array(window);
    this._sort = new Float32Array(window);
  }

  /** Call once per rAF tick with the tick timestamp (ms) and the frame's render() CPU ms. */
  frame(nowMs: number, cpuMs: number): void {
    if (this._hasLast) {
      const dt = nowMs - this._last;
      if (dt > 0 && dt < 2000) {   // a tab switch / breakpoint is not a frame
        this._dt[this._i] = dt; this._cpu[this._i] = cpuMs;
        this._i = (this._i + 1) % this.window;
        if (this._n < this.window) this._n++;
      }
    }
    this._last = nowMs;
    this._hasLast = true;
  }

  gpu(ms: number, source: 'timestamp' | 'estimate'): void { this._gpuMs = ms; this._gpuSource = source; }

  reset(): void { this._n = 0; this._i = 0; this._last = 0; this._hasLast = false; }

  summary(): ShellFrameSummary {
    const n = this._n;
    if (n === 0) return { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0, over20: 0, cpuAvgMs: 0, cpuMaxMs: 0, gpuMs: this._gpuMs, gpuSource: this._gpuSource, refreshHz: snapRefreshRate(this._minMedian) };
    let sum = 0, max = 0, over = 0, cs = 0, cmax = 0;
    const s = this._sort;
    for (let k = 0; k < n; k++) {
      const d = this._dt[k], c = this._cpu[k];
      s[k] = d; sum += d; if (d > max) max = d; if (d > 20) over++;
      cs += c; if (c > cmax) cmax = c;
    }
    const sorted = s.subarray(0, n).sort();
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    // Refresh rate: the display can't present faster than its refresh, so the smallest window MEDIAN seen is the
    // refresh interval (a janky window only raises the median). Needs a reasonably full window.
    if (n >= Math.min(30, this.window)) {
      const med = sorted[n >> 1];
      if (this._minMedian === 0 || med < this._minMedian) this._minMedian = med;
    }
    return { frames: n, avgMs: sum / n, p95Ms: p95, maxMs: max, over20: over, cpuAvgMs: cs / n, cpuMaxMs: cmax, gpuMs: this._gpuMs, gpuSource: this._gpuSource, refreshHz: snapRefreshRate(this._minMedian) };
  }
}

/** The HUD's text lines for a summary (pure; also used by the tests). */
export function formatShellHud(s: ShellFrameSummary, backingW: number, backingH: number, cssW: number, extra: readonly string[] = []): string[] {
  const f1 = (v: number) => v.toFixed(1);
  const fps = s.avgMs > 0 ? Math.round(1000 / s.avgMs) : 0;
  const dpr = cssW > 0 ? (backingW / cssW).toFixed(2) : '?';
  const gpu = s.gpuMs < 0 ? 'n/a' : `${f1(s.gpuMs)} ms${s.gpuSource === 'estimate' ? ' (est)' : ''}`;
  return [
    `rAF ${f1(s.avgMs)} avg  ${f1(s.p95Ms)} p95  ${f1(s.maxMs)} max ms  (${fps} fps)`,
    `>20ms ${s.over20}/${s.frames}   refresh ${s.refreshHz || '?'} Hz`,
    `render CPU ${f1(s.cpuAvgMs)} avg  ${f1(s.cpuMaxMs)} max ms   GPU ${gpu}`,
    `backing ${backingW}x${backingH}  (x${dpr})`,
    ...extra,
  ];
}

// ── Long tasks ────────────────────────────────────────────────────────────

let _longTaskObs: { disconnect(): void } | null = null;
let _longTaskCount = 0;
let _longTaskLast = 0;
/** Start logging long tasks (> 50 ms main-thread blocks). Idempotent; a no-op where the entry type is unsupported. */
export function startShellLongTaskLog(): void {
  if (_longTaskObs) return;
  try {
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (!PO || !(PO.supportedEntryTypes ?? []).includes('longtask')) return;
    const obs = new PO((list) => {
      for (const e of list.getEntries()) {
        _longTaskCount++; _longTaskLast = e.duration;
        console.warn(`[Shell][longtask] ${e.duration.toFixed(0)} ms at ${e.startTime.toFixed(0)} ms`);
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    _longTaskObs = obs;
  } catch { /* unsupported */ }
}
export function shellLongTaskCount(): number { return _longTaskCount; }
export function shellLongTaskLastMs(): number { return _longTaskLast; }

// ── HUD (DOM overlay) ─────────────────────────────────────────────────────

/** The on-screen HUD: text lines + one button per layer toggle. DOM only; created when `flags.hud`. */
export class ShellPerfHud {
  private el: HTMLElement | null = null;
  private text: HTMLElement | null = null;
  private buttons = new Map<keyof ShellDebugFlags, HTMLButtonElement>();
  private lastPaint = 0;

  constructor(private readonly flags: ShellDebugFlags, private readonly onToggle: () => void) {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('data-shell-perf-hud', '');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:min(94vw,420px);padding:6px 8px;'
      + 'background:rgba(0,0,0,0.78);color:#9f9;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;'
      + 'border:1px solid #3a3;border-radius:4px;white-space:pre-wrap;touch-action:manipulation;user-select:none;';
    const text = document.createElement('div');
    el.appendChild(text);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;';
    for (const key of SHELL_DEBUG_TOGGLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = 'font:inherit;min-height:28px;padding:2px 7px;border:1px solid #3a3;border-radius:3px;cursor:pointer;';
      b.onclick = (e) => { e.stopPropagation(); this.flags[key] = !this.flags[key]; this.paintButtons(); this.onToggle(); };
      this.buttons.set(key, b);
      row.appendChild(b);
    }
    el.appendChild(row);
    document.body.appendChild(el);
    this.el = el; this.text = text;
    this.paintButtons();
  }

  private paintButtons(): void {
    for (const [key, b] of this.buttons) {
      const on = this.flags[key];
      b.textContent = `${key}${on ? '' : ' OFF'}`;
      b.style.background = on ? '#143' : '#511';
      b.style.color = on ? '#9f9' : '#fbb';
    }
  }

  /** Repaint the text at most ~4×/s. */
  update(nowMs: number, lines: () => string[]): void {
    if (!this.text || nowMs - this.lastPaint < 250) return;
    this.lastPaint = nowMs;
    this.text.textContent = lines().join('\n');
  }

  destroy(): void { this.el?.remove(); this.el = null; this.text = null; this.buttons.clear(); }
}
