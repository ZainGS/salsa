/**
 * GamepadInput — built-in controller support for Play mode (R6.2): LEFT stick moves (camera-relative, analog speed),
 * RIGHT stick orbits the camera, A jumps, X uses (interact), L3 (left-stick click) or Y toggles walk/run, B toggles
 * sneak (Round 8). Standard
 * Gamepad API mapping (https://w3c.github.io/gamepad/#remapping). The source is injectable so it's testable headless.
 *
 * Sticks use a RADIAL dead zone (a diagonal isn't clipped like per-axis dead zones do) rescaled so the output starts
 * at 0 at the dead-zone edge and reaches 1 at full tilt; the look stick also gets a response curve (exponent) so fine
 * aim is easy and full tilt still turns fast.
 */

export interface GamepadLike { buttons: ReadonlyArray<{ pressed: boolean; value?: number }>; axes: ReadonlyArray<number>; connected?: boolean; mapping?: string; }
export type GamepadSource = () => ReadonlyArray<GamepadLike | null>;

export interface GamepadReading {
  /** Left stick: + forward (stick up), + right (stick right). Length ≤ 1. */
  forward: number;
  right: number;
  /** Right stick after dead zone + curve: + right, + up (stick pushed up). */
  lookX: number;
  lookY: number;
  jump: boolean;
  interact: boolean;
  /** Walk/run toggle presses since the last poll (edge-detected). */
  runToggle: number;
  /** Sneak toggle presses (B) since the last poll (edge-detected). */
  sneakToggle: number;
  /** True when a pad is connected. */
  active: boolean;
}

export const GAMEPAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, L3: 10, R3: 11 } as const;

/** Radial dead zone: |v| < dz → 0; else rescale (|v| − dz)/(1 − dz), clamped to 1, keeping the direction. */
export function radialDeadzone(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= dz || m < 1e-9) return [0, 0];
  const k = Math.min(1, (m - dz) / Math.max(1e-6, 1 - dz)) / m;
  return [x * k, y * k];
}

export class GamepadInput {
  deadzone = 0.15;
  lookDeadzone = 0.12;
  /** Look response curve exponent (1 = linear). */
  lookExponent = 1.6;
  /** Invert the right stick's vertical look. */
  invertY = false;
  private _source: GamepadSource | null;
  private _prev: boolean[] = [];

  constructor(source?: GamepadSource | null) {
    this._source = source ?? ((typeof navigator !== 'undefined' && navigator.getGamepads) ? () => navigator.getGamepads() : null);
  }

  /** Poll the first connected pad. */
  poll(): GamepadReading {
    const out: GamepadReading = { forward: 0, right: 0, lookX: 0, lookY: 0, jump: false, interact: false, runToggle: 0, sneakToggle: 0, active: false };
    let pads: ReadonlyArray<GamepadLike | null> = [];
    try { pads = this._source?.() ?? []; } catch { pads = []; }
    const pad = pads.find((p) => !!p && p.connected !== false) ?? null;
    if (!pad) { this._prev = []; return out; }
    out.active = true;
    const ax = (i: number) => { const v = pad.axes[i]; return Number.isFinite(v) ? v : 0; };
    const [lx, ly] = radialDeadzone(ax(0), ax(1), this.deadzone);
    out.right = lx; out.forward = 0 - ly;                 // stick up = negative axis 1 = forward
    const [rx, ry] = radialDeadzone(ax(2), ax(3), this.lookDeadzone);
    const m = Math.hypot(rx, ry);
    const curve = m > 1e-9 ? Math.pow(m, this.lookExponent) / m : 0;
    out.lookX = rx * curve;
    out.lookY = (this.invertY ? ry : 0 - ry) * curve + 0;     // stick up = look up
    const btn = (i: number) => !!pad.buttons[i]?.pressed;
    out.jump = btn(GAMEPAD_BUTTON.A);
    out.interact = btn(GAMEPAD_BUTTON.X);
    for (const i of [GAMEPAD_BUTTON.L3, GAMEPAD_BUTTON.Y]) {
      const p = btn(i);
      if (p && !this._prev[i]) out.runToggle++;
      this._prev[i] = p;
    }
    { const i = GAMEPAD_BUTTON.B, p = btn(i); if (p && !this._prev[i]) out.sneakToggle++; this._prev[i] = p; }
    return out;
  }
}
