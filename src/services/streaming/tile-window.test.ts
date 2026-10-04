import { describe, it, expect } from 'vitest';
import { windowFocusPoint, windowFocusTile, windowTiles, outsideTier, WINDOW_MARGIN } from './tile-window';

// performance-plan P10.D — the active tile window of a streamed tiled world.

describe('windowTiles — the Tile radius setting IS the active window', () => {
    it('radius 0 / 1 / 2 → exactly 1 / 9 / 25 tiles, the focus tile first', () => {
        for (const [r, n] of [[0, 1], [1, 9], [2, 25]] as const) {
            const t = windowTiles(4, -3, r);
            expect(t.length).toBe(n);
            expect(t[0]).toEqual([4, -3]);
            expect(new Set(t.map(([x, z]) => `${x},${z}`)).size).toBe(n);
            for (const [x, z] of t) expect(Math.max(Math.abs(x - 4), Math.abs(z + 3))).toBeLessThanOrEqual(r);
        }
    });
    it('nearest-first (edge tiles before corners) and clamped to 0..3', () => {
        const t = windowTiles(0, 0, 1);
        const d2 = t.map(([x, z]) => x * x + z * z);
        expect([...d2].sort((a, b) => a - b)).toEqual(d2);
        expect(windowTiles(0, 0, 9).length).toBe(49);
        expect(windowTiles(0, 0, -2).length).toBe(1);
    });
});

describe('windowFocusPoint — the eye projected onto the ground, or the player in Play', () => {
    it('uses the camera EYE (not the orbit target / view centre), in city-local XZ', () => {
        // an oblique overview: the eye hangs over tile (-1, 2) while the camera looks at the origin
        expect(windowFocusPoint([-22, 34, 30], null, { x: 0, z: 0 })).toEqual([-22, 30]);
        expect(windowFocusPoint([-22, 34, 30], null, { x: 5, z: -10 })).toEqual([-27, 40]);   // placed city
    });
    it('Play: the player position wins over the camera', () => {
        expect(windowFocusPoint([100, 3, 100], [41, 0, -7], { x: 0, z: 0 })).toEqual([41, -7]);
    });
});

describe('windowFocusTile — hysteresis at tile borders', () => {
    const span = 20;
    it('snaps to the nearest tile with no previous focus', () => {
        expect(windowFocusTile(-22, 30, span, null)).toEqual([-1, 2]);
        expect(windowFocusTile(9.9, -9.9, span, null)).toEqual([0, -0]);
    });
    it('stays on the current tile until the point is ~12% of a tile into the next one', () => {
        let f: [number, number] = [0, 0];
        // walk +x across the border at 0.5 tiles (x = 10)
        for (const x of [9, 10, 11, 12]) { f = windowFocusTile(x, 0, span, f); expect(f).toEqual([0, 0]); }
        f = windowFocusTile(span * (0.5 + WINDOW_MARGIN) + 0.1, 0, span, f);
        expect(f).toEqual([1, 0]);
        // standing on the edge (jitter around x = 10) never flips back
        for (const x of [10.4, 9.6, 10.1, 8.0]) { f = windowFocusTile(x, 0, span, f); expect(f).toEqual([1, 0]); }
        // ... until it is ~12% into tile 0 again
        f = windowFocusTile(span * (0.5 - WINDOW_MARGIN) - 0.1, 0, span, f);
        expect(f).toEqual([0, 0]);
    });
    it('a degenerate span maps everything to the origin tile', () => {
        expect(windowFocusTile(123, 45, 0, null)).toEqual([0, 0]);
    });
});

describe('outsideTier — the Outside tiles setting', () => {
    it('none → nothing; flat → flat, massing once zoomed far out; massing → massing at every zoom', () => {
        expect(outsideTier('none', false)).toBeNull();
        expect(outsideTier('none', true)).toBeNull();
        expect(outsideTier('flat', false)).toBe('p');
        expect(outsideTier('flat', true)).toBe('m');
        expect(outsideTier('massing', false)).toBe('m');
    });
});
