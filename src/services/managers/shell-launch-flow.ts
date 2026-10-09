/**
 * The Shell's cart LAUNCH orchestration (docs/specs/frogcart-cd-art-and-launch.md, Part A): one tap → the launch
 * animation starts at once while the cart's bytes are read (OPFS) and probed; the promise resolves with the cart when
 * the screen has gone black, so the host can hand it to the Player.
 *
 *   start(slotId)  presenter.beginLaunch → loadCart → probeFrogcart → presenter.markLaunchReady → … onBlack → resolve
 *   error          (not found / not a cart / too new / timeout) → reject at once (the host toasts), presenter.cancelLaunch
 *                  plays the spin-down meanwhile
 *   skip()         a tap during the launch: the fade starts as soon as the cart is ready
 *   cancel()       Esc: reject 'cancelled' (no toast), spin-down
 *   destroy()      the scene is being unmounted: reject 'unmounted' (no animation — the presenter goes away)
 *
 * The presenter (ShellLaunchPresenter) is whatever draws the launch — the Shell renderer (the tapped disc posed in a
 * grown viewport, the dim under it, the final fade). It reports black through onBlack; a fallback timer computed from the same pure timeline
 * (shell-launch.ts) resolves the launch anyway if a presenter never does (a stopped rAF loop, a background tab).
 *
 * No DOM / GPU here: unit-tested with fake timers (shell-launch-flow.test.ts).
 */

import {
  LAUNCH, launchBlackAtMs, type LaunchPose, type ShellLaunchPresenter,
} from '../../renderer/shell/shell-launch';
import { probeFrogcart, type FrogcartProbe } from './shell-import';

export type { ShellLaunchPresenter, ShellLaunchBeginOptions } from '../../renderer/shell/shell-launch';

/** Why a launch did not reach the Player. The host maps these to its toasts (Frogmarks cartLaunchMessage). */
export type ShellLaunchErrorCode =
  | 'busy'            // another launch is running
  | 'not-found'       // no such cart slot
  | 'not-installed'   // a remote cart with no cached copy / a system tile
  | 'read-failed'     // the cart file is missing or could not be read
  | 'invalid-cart'    // not a .frogcart (no manifest / scene, unreadable manifest)
  | 'too-new'         // made by a newer Frogmarks
  | 'timeout'         // reading + checking it took longer than LAUNCH.timeoutMs
  | 'cancelled'       // Esc / cancelLaunch()
  | 'unmounted';      // the Shell scene was torn down mid-launch

export class ShellLaunchError extends Error {
  constructor(readonly code: ShellLaunchErrorCode, message?: string) {
    super(message ?? `Cart launch failed: ${code}`);
    this.name = 'ShellLaunchError';
  }
}

/** A launch that reached black: the cart for the Player. */
export interface ShellLaunchResult {
  slotId: string;
  /** The .frogcart bytes as a Blob (type application/zip). */
  cart: Blob;
  /** From the cart's manifest ('' when absent). */
  title: string;
  author: string;
}

export interface ShellLaunchStartOptions {
  reducedMotion?: boolean;
  fadeColor?: string;
  timeoutMs?: number;
  /** Passed through to the presenter: every frame's pose (the manager fades its HTML chrome by chromeOpacity). */
  onFrame?: (pose: LaunchPose) => void;
  /** Passed through to the presenter: a cancelled / failed launch has settled back to the idle Shell. */
  onSettled?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface ShellLaunchFlowDeps {
  /** The presenter to draw with, read at each start (null = no scene mounted: no animation, resolve when ready). */
  presenter: () => ShellLaunchPresenter | null;
  /** Read the cart's bytes; null = not there. May throw (read-failed). */
  loadCart: (slotId: string) => Promise<ArrayBuffer | Uint8Array | Blob | null>;
  /** Reject before loading (e.g. the slot doesn't exist / isn't installed). */
  precheck?: (slotId: string) => ShellLaunchErrorCode | null;
  probe?: (bytes: Uint8Array) => FrogcartProbe;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/** Map a failed probe to the launch error the host shows. */
export function launchErrorForProbe(p: Extract<FrogcartProbe, { ok: false }>): ShellLaunchErrorCode {
  return p.reason === 'too-new' ? 'too-new' : 'invalid-cart';
}

/** Slack past the computed black moment before the fallback timer resolves a launch the presenter never reported. */
export const LAUNCH_BLACK_SLACK_MS = 300;

interface Running {
  slotId: string;
  startMs: number;
  reducedMotion: boolean;
  readyAtMs: number | null;
  skippedAtMs: number | null;
  result: ShellLaunchResult | null;
  presenter: ShellLaunchPresenter | null;
  resolve: (r: ShellLaunchResult) => void;
  reject: (e: ShellLaunchError) => void;
  timeout: Timer | null;
  fallback: Timer | null;
}

export class ShellLaunchFlow {
  private run: Running | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private readonly deps: ShellLaunchFlowDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** A launch promise is pending (from start until it resolves / rejects). */
  get busy(): boolean { return this.run !== null; }
  /** The slot being launched (null when idle). */
  get slotId(): string | null { return this.run?.slotId ?? null; }

  start(slotId: string, opts: ShellLaunchStartOptions = {}): Promise<ShellLaunchResult> {
    if (this.run) return Promise.reject(new ShellLaunchError('busy', 'A cart is already launching.'));
    const pre = this.deps.precheck?.(slotId) ?? null;
    if (pre) return Promise.reject(new ShellLaunchError(pre));
    const startMs = this.now();
    const reducedMotion = !!opts.reducedMotion;
    let resolve!: (r: ShellLaunchResult) => void, reject!: (e: ShellLaunchError) => void;
    const promise = new Promise<ShellLaunchResult>((res, rej) => { resolve = res; reject = rej; });
    const run: Running = {
      slotId, startMs, reducedMotion, readyAtMs: null, skippedAtMs: null, result: null,
      presenter: this.deps.presenter(), resolve, reject, timeout: null, fallback: null,
    };
    this.run = run;
    run.timeout = this.setTimer(() => this.fail(run, 'timeout'), Math.max(0, opts.timeoutMs ?? LAUNCH.timeoutMs));
    try {
      run.presenter?.beginLaunch({
        slotId, startMs, reducedMotion,
        fadeColor: opts.fadeColor ?? LAUNCH.fadeColor,
        onBlack: () => this.onBlack(run),
        onSettled: () => opts.onSettled?.(),
        onFrame: opts.onFrame,
      });
    } catch (e) {
      console.warn('[Shell] launch animation failed to start:', e);
      run.presenter = null;   // no animation: the launch still resolves once the cart is ready
    }
    void this.load(run);
    return promise;
  }

  /** A tap during the launch. False when there is no launch, or the tap is the launching tap's double-click twin. */
  skip(): boolean {
    const run = this.run;
    if (!run) return false;
    const now = this.now();
    if (now - run.startMs < LAUNCH.skipGuardMs) return false;
    if (run.skippedAtMs === null) {
      run.skippedAtMs = now - run.startMs;
      run.presenter?.skipLaunch(now);
      this.armFallback(run);
    }
    return true;
  }

  /** Esc / the host: stop the launch (rejects 'cancelled'). False when nothing was launching. */
  cancel(): boolean {
    const run = this.run;
    if (!run) return false;
    this.fail(run, 'cancelled');
    return true;
  }

  /** The scene is going away: reject a pending launch with 'unmounted' (no spin-down — nothing is drawn any more). */
  destroy(): void {
    const run = this.run;
    if (run) this.fail(run, 'unmounted', false);
  }

  private async load(run: Running): Promise<void> {
    let bytes: Uint8Array;
    try {
      const raw = await this.deps.loadCart(run.slotId);
      if (this.run !== run) return;
      if (!raw) { this.fail(run, 'read-failed'); return; }
      bytes = raw instanceof Uint8Array ? raw
        : raw instanceof ArrayBuffer ? new Uint8Array(raw)
          : new Uint8Array(await (raw as Blob).arrayBuffer());
      if (this.run !== run) return;
    } catch (e) {
      if (this.run === run) { console.warn('[Shell] reading the cart failed:', e); this.fail(run, 'read-failed'); }
      return;
    }
    const probe = (this.deps.probe ?? probeFrogcart)(bytes);
    if (!probe.ok) { this.fail(run, launchErrorForProbe(probe)); return; }
    run.result = {
      slotId: run.slotId,
      cart: new Blob([bytes as unknown as BlobPart], { type: 'application/zip' }),
      title: probe.title,
      author: probe.author,
    };
    if (run.timeout) { this.clearTimer(run.timeout); run.timeout = null; }
    const now = this.now();
    run.readyAtMs = now - run.startMs;
    if (!run.presenter) { this.finish(run); return; }
    run.presenter.markLaunchReady(now);
    this.armFallback(run);
  }

  /** Resolve at the computed black moment (+ slack) in case the presenter never reports it. */
  private armFallback(run: Running): void {
    if (run.readyAtMs === null) return;
    if (run.fallback) this.clearTimer(run.fallback);
    const blackAt = launchBlackAtMs({ yaw0: 0, readyAtMs: run.readyAtMs, skippedAtMs: run.skippedAtMs, reducedMotion: run.reducedMotion }) ?? 0;
    const wait = Math.max(0, run.startMs + blackAt + LAUNCH_BLACK_SLACK_MS - this.now());
    run.fallback = this.setTimer(() => { if (this.run === run && run.result) this.finish(run); }, wait);
  }

  private onBlack(run: Running): void {
    if (this.run === run && run.result) this.finish(run);
  }

  private clearTimers(run: Running): void {
    if (run.timeout) { this.clearTimer(run.timeout); run.timeout = null; }
    if (run.fallback) { this.clearTimer(run.fallback); run.fallback = null; }
  }

  private finish(run: Running): void {
    if (this.run !== run || !run.result) return;
    this.clearTimers(run);
    this.run = null;
    run.resolve(run.result);
  }

  private fail(run: Running, code: ShellLaunchErrorCode, animate = true): void {
    if (this.run !== run) return;
    this.clearTimers(run);
    this.run = null;
    if (animate) {
      try { run.presenter?.cancelLaunch(this.now()); } catch (e) { console.warn('[Shell] launch spin-down failed:', e); }
    }
    run.reject(new ShellLaunchError(code));
  }
}
