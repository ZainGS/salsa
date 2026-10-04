/**
 * KeyboardInput — maps held keys → CharacterInput for Play mode (docs/specs/free-camera-and-scene-targets.md, L3).
 *
 * WASD / arrows move, Q/E (or ←/→) turn, Space jumps, Shift (a press, via takePress) toggles walk/run in Play. With
 * `{ sneakKeys: true }` (Play, Round 8) Ctrl (held) and C (a press) are captured too, for the sneak. `attach`/`detach` wire real DOM listeners; `press`/`release`
 * drive it from tests. So the host can enter Play with `{ keyboard: true }` and immediately walk the scene with no
 * per-key wiring; a host that wants its own mapping (gamepad, on-screen pad) passes `{ keyboard: false }` and feeds
 * `setPlayInput3D` instead.
 */

import type { CharacterInput } from './character-controller';

const CAPTURED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyF', 'Space', 'ShiftLeft', 'ShiftRight']);
/** Round 8 (Play only): the sneak keys — Ctrl held, C toggled. */
const SNEAK_CODES = new Set(['ControlLeft', 'ControlRight', 'KeyC']);
/** Keys that still count as MOVEMENT while Ctrl is held (a sneak-walk) — every other Ctrl+key is left to the host. */
const CTRL_MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);

/** True when a key event targets something the user types into (inputs, textareas, selects, contenteditable). */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof (el as { tagName?: unknown }).tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return !!el.isContentEditable;
}

export interface KeyboardInputOptions {
  /** Capture Ctrl (hold) and C (press) for the Play sneak, and keep W/A/S/D / arrows / Space working while Ctrl is held
   *  (a sneak-walk). Off (the editor fly camera): every Ctrl / Alt / Cmd combination is ignored, as before. */
  sneakKeys?: boolean;
}

export class KeyboardInput {
  private held = new Set<string>();
  private readonly _sneakKeys: boolean;
  constructor(opts: KeyboardInputOptions = {}) { this._sneakKeys = !!opts.sneakKeys; }
  /** Key-down EDGES since the last takePress() per code — so a quick tap between two fixed ticks is never missed
   *  (Shift's walk/run toggle). Auto-repeat keydowns don't count (the key is already held). */
  private presses = new Map<string, number>();
  private _target: EventTarget | null = null;
  /** Fired whenever the held-keys set changes (a key goes down or up) — the fly camera uses it to start/stop
   *  its update loop only while keys are held (no idle loop in the editor). */
  public onChange: (() => void) | null = null;

  /** Timestamp (ms) of the last keydown of ANY key — incl. OS auto-repeats, which keep firing while a key is
   *  physically held. The fly camera uses it as a stuck-key watchdog (see {@link releaseIfStale}). */
  private _lastKeyMs = 0;

  private readonly _down = (e: Event): void => {
    const ke = e as KeyboardEvent;
    this._lastKeyMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Never capture while the user is TYPING in a field (the host UI), or for Ctrl/Alt/Cmd shortcuts — capturing
    // there both broke typing (preventDefault ate the letters) and could leave a key "held" when focus / a dialog
    // swallowed its keyup → the editor fly camera flew forward forever.
    if (isEditableTarget(ke.target)) return;
    const code = ke.code;
    if (this._sneakKeys && (code === 'ControlLeft' || code === 'ControlRight')) {
      // The Ctrl key ITSELF (its own keydown reports ctrlKey) = sneak. Alt / Cmd chords still belong to the host.
      if (ke.metaKey || ke.altKey) return;
    } else if (ke.ctrlKey || ke.metaKey || ke.altKey) {
      // Sneak-walk: while Ctrl is held for the sneak, the movement keys still move (and their browser shortcut —
      // Ctrl+S save, Ctrl+D bookmark, Ctrl+A select-all — is suppressed). Any other chord (Ctrl+Z, Ctrl+C, Cmd+…) is
      // left alone and never becomes movement. NOTE: Ctrl+W is reserved by the browser outside fullscreen + keyboard lock.
      if (!(this._sneakKeys && ke.ctrlKey && !ke.metaKey && !ke.altKey && CTRL_MOVE_CODES.has(code))) return;
    }
    if (CAPTURED.has(code) || (this._sneakKeys && SNEAK_CODES.has(code))) {
      if (code !== 'ShiftLeft' && code !== 'ShiftRight' && code !== 'ControlLeft' && code !== 'ControlRight') (e as KeyboardEvent).preventDefault?.();   // don't swallow the modifiers for the host
      if (!this.held.has(code)) { this.held.add(code); this.presses.set(code, (this.presses.get(code) ?? 0) + 1); this.onChange?.(); }
    }
  };
  private readonly _up = (e: Event): void => { if (this.held.delete((e as KeyboardEvent).code)) this.onChange?.(); };
  private readonly _blur = (): void => { if (this.held.size) { this.held.clear(); this.onChange?.(); } };   // dropped focus → release everything
  private readonly _vis = (): void => { if (typeof document !== 'undefined' && document.hidden) this._blur(); };   // tab hidden → release

  /** Attach to a DOM target (default `window`). Guarded so it's a no-op in a headless env. */
  attach(target?: EventTarget): void {
    this.detach();
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t || !t.addEventListener) return;
    this._target = t;
    t.addEventListener('keydown', this._down);
    t.addEventListener('keyup', this._up);
    t.addEventListener('blur', this._blur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._vis);
  }
  detach(): void {
    const t = this._target;
    if (t?.removeEventListener) {
      t.removeEventListener('keydown', this._down);
      t.removeEventListener('keyup', this._up);
      t.removeEventListener('blur', this._blur);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._vis);
    this._target = null;
    this.held.clear();
    this.presses.clear();
  }

  /** Consume the key-down edges of any of `codes` since the last call: returns how many presses happened (0 = none). */
  takePress(...codes: string[]): number {
    let n = 0;
    for (const c of codes) { n += this.presses.get(c) ?? 0; this.presses.delete(c); }
    return n;
  }

  /** The current intent from held keys. */
  read(): CharacterInput {
    const k = this.held;
    return {
      forward: (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0),
      right:   (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      look:    (k.has('KeyE') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyQ') || k.has('ArrowLeft') ? 1 : 0),
      jump:    k.has('Space'),
      interact: k.has('KeyF'),
    };
  }

  /** read() for ONE fixed sim tick (the Play loop): a Space TAP whose keydown and keyup both arrived since the last tick
   *  is not held at the tick, so read() alone dropped the jump (visual-polish item 13: 3 of 4 instant taps never
   *  jumped). Its key-down edge is consumed here and counts as a jump press for this tick (a tap = a short hop). */
  readTick(): CharacterInput {
    const r = this.read();
    if (this.takePress('Space') > 0) r.jump = true;
    return r;
  }

  /** STUCK-KEY WATCHDOG: a physically held key keeps generating auto-repeat keydowns, so if NO keydown of any
   *  key arrived for `maxQuietMs` while keys are "held", their keyup was lost (focus change, a dialog, a swallowed
   *  event) — release them. Returns true if it released. (Holding W, tapping D, releasing D while still on W stops
   *  W's repeat on some OSes → W is released after the timeout; re-press W. A fair trade vs. flying forever.) */
  releaseIfStale(nowMs: number, maxQuietMs = 2000): boolean {
    if (!this.held.size || nowMs - this._lastKeyMs <= maxQuietMs) return false;
    this.held.clear();
    this.onChange?.();
    return true;
  }

  /** Ctrl held (either side) — the Play sneak (needs `sneakKeys`). */
  ctrlHeld(): boolean { return this.held.has('ControlLeft') || this.held.has('ControlRight'); }

  /** Whether a specific key is currently held (e.g. Shift for a fly-speed boost). */
  isHeld(code: string): boolean { return this.held.has(code); }

  /** Fly-camera reading: forward/right/up ∈ [-1,1] (W/S · A-D · E-Space / Q). No jump/turn (the editor aims by orbit-drag). */
  readFly(): { forward: number; right: number; up: number } {
    const k = this.held;
    return {
      forward: (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0),
      right:   (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      up:      (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
    };
  }
  /** True while any movement key is held — the fly loop runs only then. */
  anyMoveHeld(): boolean {
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'Space']) if (this.held.has(c)) return true;
    return false;
  }

  // ── test hooks ──
  press(code: string, nowMs?: number): void { if (!this.held.has(code)) this.presses.set(code, (this.presses.get(code) ?? 0) + 1); this.held.add(code); if (nowMs !== undefined) this._lastKeyMs = nowMs; }
  release(code: string): void { this.held.delete(code); }
  clear(): void { this.held.clear(); this.presses.clear(); }
}
