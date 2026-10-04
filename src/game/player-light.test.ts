import { describe, it, expect } from 'vitest';
import { placePlayerLight } from './player-light';

// visual-polish #7c: the Play player light — a small key light on the camera side of the player.

describe('placePlayerLight', () => {
    const cfg = { strength: 1, color: [1, 0.93, 0.86] as [number, number, number] };
    it('off for no strength / no body height', () => {
        expect(placePlayerLight([0, 0, 0], [0, 1, 3], 1.6, { ...cfg, strength: 0 })).toBeNull();
        expect(placePlayerLight([0, 0, 0], [0, 1, 3], 0, cfg)).toBeNull();
        expect(placePlayerLight([0, 0, 0], [0, 1, 3], NaN, cfg)).toBeNull();
    });
    it('sits between the player and the camera, about head height, a little to the side', () => {
        const H = 1.6, pl = placePlayerLight([10, 2, 5], [10, 3.5, 8], H, cfg)!;   // camera straight behind on +Z
        expect(pl.pos[2]).toBeGreaterThan(5);            // camera side
        expect(pl.pos[2] - 5).toBeLessThan(H);
        expect(pl.pos[1]).toBeGreaterThan(2 + H * 0.7);   // above the chest
        expect(pl.pos[1]).toBeLessThan(2 + H * 1.1);
        expect(Math.abs(pl.pos[0] - 10)).toBeGreaterThan(0.1);   // off-axis key
        expect(pl.color).toEqual(cfg.color);
    });
    it('reach scales with the body (a 1 m/unit scene and a 15 m/unit city behave alike) and barely touches the feet', () => {
        for (const H of [1.6, 1.6 / 15]) {
            const pl = placePlayerLight([0, 0, 0], [0, H, 2 * H], H, cfg)!;
            expect(pl.radius / H).toBeCloseTo(1.5);
            const d = Math.hypot(pl.pos[0], pl.pos[1], pl.pos[2]);   // to the feet
            const att = Math.max(0, 1 - d / pl.radius) ** 2;
            expect(att).toBeLessThan(0.1);
        }
    });
    it('strength scales the intensity (clamped at 2)', () => {
        const a = placePlayerLight([0, 0, 0], [0, 1, 3], 1.6, cfg)!, b = placePlayerLight([0, 0, 0], [0, 1, 3], 1.6, { ...cfg, strength: 5 })!;
        expect(b.intensity).toBeCloseTo(a.intensity * 2);
    });
    it('camera directly above the feet still gives a finite light', () => {
        const pl = placePlayerLight([0, 0, 0], [0, 5, 0], 1.6, cfg)!;
        for (const v of pl.pos) expect(Number.isFinite(v)).toBe(true);
    });
});
