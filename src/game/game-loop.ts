/**
 * GameLoop — a fixed-timestep runtime loop for Play mode (docs/specs/free-camera-and-scene-targets.md, L3).
 *
 * Play mode (scene target) runs a deterministic simulation: input → character controller → (later) physics →
 * camera. This is the clock. Fixed-timestep with an accumulator so the sim is stable and frame-rate independent
 * (the classic "fix your timestep" pattern); a render tick fires once per animation frame with the interpolation
 * alpha. The scheduler + clock are INJECTABLE so the loop is unit-testable without a browser (default =
 * requestAnimationFrame + performance.now).
 */

export type FixedTick = (dt: number) => void;              // dt = fixed step in seconds
export type RenderTick = (alpha: number) => void;          // alpha ∈ [0,1) = interpolation between sim steps

export interface GameLoopOptions {
  /** Fixed simulation step in seconds (default 1/60). */
  step?: number;
  /** Max sim steps per frame — the "spiral of death" guard for a slow/backgrounded tab (default 5). */
  maxStepsPerFrame?: number;
  /** Injectables (tests pass fakes). now() → ms; schedule(cb) → a handle; cancel(handle). */
  now?: () => number;
  schedule?: (cb: () => void) => number;
  cancel?: (handle: number) => void;
}

export class GameLoop {
  private readonly step: number;
  private readonly maxSteps: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => number;
  private readonly cancel: (handle: number) => void;

  private _running = false;
  private _handle: number | null = null;
  private _last = 0;
  private _accumulator = 0;
  private _fixed: FixedTick = () => {};
  private _render: RenderTick = () => {};

  constructor(opts: GameLoopOptions = {}) {
    this.step = Math.max(1e-4, opts.step ?? 1 / 60);
    this.maxSteps = Math.max(1, opts.maxStepsPerFrame ?? 5);
    // Guard the browser globals so this constructs in a headless/test env even if no injectables are passed.
    const raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : ((cb: () => void) => setTimeout(cb, 16) as unknown as number);
    const caf = (typeof cancelAnimationFrame !== 'undefined') ? cancelAnimationFrame : ((h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
    const perfNow = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    this.now = opts.now ?? perfNow;
    this.schedule = opts.schedule ?? ((cb) => raf(cb) as unknown as number);
    this.cancel = opts.cancel ?? ((h) => caf(h as unknown as number));
  }

  get isRunning(): boolean { return this._running; }

  /** Start the loop. `fixed(dt)` runs 0..maxSteps times/frame at the fixed step; `render(alpha)` once/frame. */
  start(fixed: FixedTick, render: RenderTick = () => {}): void {
    if (this._running) return;
    this._fixed = fixed;
    this._render = render;
    this._running = true;
    this._last = this.now();
    this._accumulator = 0;
    this._handle = this.schedule(this._frame);
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._handle !== null) { this.cancel(this._handle); this._handle = null; }
  }

  /** One animation frame: drain the accumulator in fixed steps, then a single render tick. Arrow-bound so it can
   *  be passed straight to the scheduler. */
  private _frame = (): void => {
    if (!this._running) return;
    const t = this.now();
    let frameTime = (t - this._last) / 1000;   // seconds
    this._last = t;
    if (frameTime > 0.25) frameTime = 0.25;    // clamp a huge hitch (tab was backgrounded) before it enters the sim
    this._accumulator += frameTime;

    let steps = 0;
    while (this._accumulator >= this.step && steps < this.maxSteps) {
      this._fixed(this.step);
      this._accumulator -= this.step;
      steps++;
    }
    if (steps >= this.maxSteps) this._accumulator = 0;   // fell behind — drop the backlog (no spiral of death)

    this._render(this._accumulator / this.step);          // alpha for interpolation
    if (this._running) this._handle = this.schedule(this._frame);
  };

  /** TEST HOOK: advance the loop by one frame synchronously (bypasses the scheduler). */
  tickForTest(): void { this._frame(); }
}
