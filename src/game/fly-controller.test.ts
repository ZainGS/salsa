import { describe, it, expect } from 'vitest';
import { flyMove } from './fly-controller';
import type { Vec3 } from './character-controller';

describe('flyMove (editor fly camera)', () => {
    const NONE = { forward: 0, right: 0, up: 0 };

    it('flies FORWARD along the look direction, preserving the look vector', () => {
        const pos: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 1];   // looking +Z
        const r = flyMove(pos, tgt, { ...NONE, forward: 1 }, 2, 0.5);   // 2 u/s × 0.5s = 1 unit
        expect(r.pos[2]).toBeCloseTo(1, 5);
        expect(r.tgt[2]).toBeCloseTo(2, 5);
        // look direction unchanged (both moved by the same vector)
        expect([r.tgt[0] - r.pos[0], r.tgt[1] - r.pos[1], r.tgt[2] - r.pos[2]]).toEqual([0, 0, 1]);
    });

    it('strafes horizontally (right is pitch-independent)', () => {
        const pos: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 1];   // +Z → right = -X
        const r = flyMove(pos, tgt, { ...NONE, right: 1 }, 1, 1);
        expect(r.pos[0]).toBeCloseTo(-1, 5);
        expect(r.pos[1]).toBeCloseTo(0, 5);
        expect(r.pos[2]).toBeCloseTo(0, 5);
    });

    it('up moves along world +Y regardless of where you look', () => {
        const pos: Vec3 = [0, 0, 0], tgt: Vec3 = [0, -1, 0];   // looking straight down
        const r = flyMove(pos, tgt, { ...NONE, up: 1 }, 3, 1);
        expect(r.pos[1]).toBeCloseTo(3, 5);
    });

    it('forward follows PITCH (flying while looking down descends)', () => {
        const pos: Vec3 = [0, 5, 0], tgt: Vec3 = [0, 4, 1];   // looking down-forward (45°-ish)
        const r = flyMove(pos, tgt, { ...NONE, forward: 1 }, Math.SQRT2, 1);
        expect(r.pos[1]).toBeLessThan(5);   // descended
        expect(r.pos[2]).toBeGreaterThan(0);   // advanced
    });

    it('a degenerate zero-length look vector does not NaN', () => {
        const r = flyMove([1, 1, 1], [1, 1, 1], { ...NONE, forward: 1 }, 1, 1);
        for (const v of [...r.pos, ...r.tgt]) expect(Number.isFinite(v)).toBe(true);
    });
});
