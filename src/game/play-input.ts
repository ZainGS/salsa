/**
 * play-input.ts: merge the HOST-fed Play intent (setPlayInput3D: an on-screen virtual joystick, Jump / Use buttons)
 * with the built-in keyboard reading, the same way the gamepad is merged (TOUCH-4, docs/ui/touch-controls.md).
 *
 * Before this, the Play tick read `keyboard ? keyboard.readTick() : host` — so with the built-in keyboard attached
 * (the default, and always on a tablet with a keyboard cover) a host joystick was silently ignored.
 *
 * Axes add and clamp to [-1, 1]; buttons OR. Look deltas (lookYaw / lookPitch) are NOT merged here: the Play loop
 * consumes them once per render frame, separately.
 */
import type { CharacterInput } from './character-controller';

const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);
const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `base` (keyboard) + `host` (setPlayInput3D) → a new input. Neither argument is modified. */
export function mergeHostPlayInput(base: CharacterInput, host: Partial<CharacterInput>): CharacterInput {
  const out: CharacterInput = { ...base };
  out.forward = clamp1(num(base.forward) + num(host.forward));
  out.right = clamp1(num(base.right) + num(host.right));
  out.look = clamp1(num(base.look) + num(host.look));
  out.jump = !!base.jump || !!host.jump;
  const interact = !!base.interact || !!host.interact;
  if (interact || base.interact !== undefined || host.interact !== undefined) out.interact = interact;
  return out;
}
