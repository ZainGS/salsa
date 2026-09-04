import { describe, it, expect } from 'vitest';
import { MouseLook } from './mouse-look';

describe('MouseLook', () => {
    it('accumulates fed movement into yaw/pitch deltas', () => {
        const m = new MouseLook({ sensitivity: 0.01 });
        m.feed(10, 0);
        m.feed(5, 0);
        const d = m.consume();
        expect(d.yaw).toBeCloseTo(0.15, 6);   // (10+5)·0.01
        expect(d.pitch).toBeCloseTo(0, 6);
    });

    it('looks down on downward movement by default (movementY inverted)', () => {
        const m = new MouseLook({ sensitivity: 0.01 });
        m.feed(0, 20);                         // pointer moved down
        expect(m.consume().pitch).toBeCloseTo(-0.2, 6);   // negative pitch = look down
    });

    it('respects invertY', () => {
        const m = new MouseLook({ sensitivity: 0.01, invertY: true });
        m.feed(0, 20);
        expect(m.consume().pitch).toBeCloseTo(0.2, 6);
    });

    it('consume() zeroes the accumulator', () => {
        const m = new MouseLook();
        m.feed(3, 3);
        m.consume();
        const d = m.consume();
        expect(d.yaw).toBe(0);
        expect(d.pitch).toBe(0);
    });
});
