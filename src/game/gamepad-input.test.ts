import { describe, it, expect } from 'vitest';
import { GamepadInput, radialDeadzone, GAMEPAD_BUTTON, type GamepadLike } from './gamepad-input';

function pad(axes: number[], pressed: number[] = []): GamepadLike {
    const buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) }));
    return { axes, buttons, connected: true };
}

describe('GamepadInput (R6.2)', () => {
    it('radial dead zone: inside → 0; edge → 0; full tilt → 1; keeps the direction', () => {
        expect(radialDeadzone(0.1, 0.05, 0.15)).toEqual([0, 0]);
        const [x, y] = radialDeadzone(0.7071, 0.7071, 0.15);
        expect(Math.hypot(x, y)).toBeCloseTo(1, 3);
        expect(x).toBeCloseTo(y, 9);
        const [hx] = radialDeadzone(0.575, 0, 0.15);
        expect(hx).toBeCloseTo(0.5, 3);
    });

    it('left stick → forward/right (stick up = forward), right stick → look (stick up = look up)', () => {
        let state = pad([0.5, -1, 1, -1]);
        const g = new GamepadInput(() => [state]);
        const r = g.poll();
        expect(r.active).toBe(true);
        expect(r.forward).toBeGreaterThan(0.8);
        expect(r.right).toBeGreaterThan(0.2);
        expect(Math.hypot(r.forward, r.right)).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.lookX).toBeGreaterThan(0);
        expect(r.lookY).toBeGreaterThan(0);
        state = pad([0, 0, 0, 0]);
        const z = g.poll();
        expect(z.forward).toBe(0); expect(z.lookX).toBe(0);
    });

    it('A = jump (held), X = interact, L3 / Y toggle walk-run on the PRESS edge only', () => {
        let state = pad([0, 0, 0, 0], [GAMEPAD_BUTTON.A, GAMEPAD_BUTTON.L3]);
        const g = new GamepadInput(() => [state]);
        const a = g.poll();
        expect(a.jump).toBe(true);
        expect(a.runToggle).toBe(1);
        expect(g.poll().runToggle).toBe(0);               // still held: no repeat
        state = pad([0, 0, 0, 0], []);
        g.poll();
        state = pad([0, 0, 0, 0], [GAMEPAD_BUTTON.Y, GAMEPAD_BUTTON.X]);
        const b = g.poll();
        expect(b.runToggle).toBe(1);
        expect(b.interact).toBe(true);
    });

    it('no pad → inactive, all zero', () => {
        const g = new GamepadInput(() => [null, null]);
        const r = g.poll();
        expect(r.active).toBe(false);
        expect(r.forward).toBe(0);
    });
});
