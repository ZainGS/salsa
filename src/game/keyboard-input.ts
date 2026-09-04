/**
 * KeyboardInput — maps held keys → CharacterInput for Play mode (docs/specs/free-camera-and-scene-targets.md, L3).
 *
 * WASD / arrows move, Q/E (or ←/→) turn, Space jumps. `attach`/`detach` wire real DOM listeners; `press`/`release`
 * drive it from tests. So the host can enter Play with `{ keyboard: true }` and immediately walk the scene with no
 * per-key wiring; a host that wants its own mapping (gamepad, on-screen pad) passes `{ keyboard: false }` and feeds
 * `setPlayInput3D` instead.
 */

import type { CharacterInput } from './character-controller';

const CAPTURED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyF', 'Space', 'ShiftLeft', 'ShiftRight']);

export class KeyboardInput {
  private held = new Set<string>();
  private _target: EventTarget | null = null;
  /** Fired whenever the held-keys set changes (a key goes down or up) — the fly camera uses it to start/stop
   *  its update loop only while keys are held (no idle loop in the editor). */
  public onChange: (() => void) | null = null;

  private readonly _down = (e: Event): void => {
    const code = (e as KeyboardEvent).code;
    if (CAPTURED.has(code)) {
      if (code !== 'ShiftLeft' && code !== 'ShiftRight') (e as KeyboardEvent).preventDefault?.();   // don't swallow Shift for the host
      if (!this.held.has(code)) { this.held.add(code); this.onChange?.(); }
    }
  };
  private readonly _up = (e: Event): void => { if (this.held.delete((e as KeyboardEvent).code)) this.onChange?.(); };
  private readonly _blur = (): void => { if (this.held.size) { this.held.clear(); this.onChange?.(); } };   // dropped focus → release everything

  /** Attach to a DOM target (default `window`). Guarded so it's a no-op in a headless env. */
  attach(target?: EventTarget): void {
    this.detach();
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t || !t.addEventListener) return;
    this._target = t;
    t.addEventListener('keydown', this._down);
    t.addEventListener('keyup', this._up);
    t.addEventListener('blur', this._blur);
  }
  detach(): void {
    const t = this._target;
    if (t?.removeEventListener) {
      t.removeEventListener('keydown', this._down);
      t.removeEventListener('keyup', this._up);
      t.removeEventListener('blur', this._blur);
    }
    this._target = null;
    this.held.clear();
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
  press(code: string): void { this.held.add(code); }
  release(code: string): void { this.held.delete(code); }
  clear(): void { this.held.clear(); }
}
