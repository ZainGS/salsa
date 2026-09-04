import { describe, it, expect } from 'vitest';
import { scanlineFill } from './scanline-fill';

/** Build a w×h mask from an ASCII grid ('#' = fillable/1, '.' = wall/0). */
function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
    const h = rows.length, w = rows[0].length;
    const m = new Uint8Array(w * h);
    rows.forEach((r, y) => { for (let x = 0; x < w; x++) m[y * w + x] = r[x] === '#' ? 1 : 0; });
    return { m, w, h };
}

describe('scanlineFill', () => {
    it('fills a contiguous region and stops at walls', () => {
        const { m, w, h } = mask([
            '###.#',
            '###.#',
            '....#',
        ]);
        const out = scanlineFill(m, w, h, 0, 0);
        // The 3×2 block top-left is reachable; the right column is walled off.
        expect(out[0]).toBe(1);
        expect(out[2]).toBe(1);          // (2,0)
        expect(out[w + 2]).toBe(1);      // (2,1)
        expect(out[4]).toBe(0);          // (4,0) — separated by the '.' column
    });

    it('returns all-zero when the seed cell is a wall', () => {
        const { m, w, h } = mask(['#.#']);
        const out = scanlineFill(m, w, h, 1, 0);   // seed on the '.'
        expect([...out]).toEqual([0, 0, 0]);
    });

    it('fills a fully-open canvas from any seed', () => {
        const { m, w, h } = mask(['###', '###']);
        const out = scanlineFill(m, w, h, 2, 1);
        expect(out.every(v => v === 1)).toBe(true);
    });

    it('does not leak diagonally (4-connectivity only)', () => {
        const { m, w, h } = mask([
            '#.',
            '.#',
        ]);
        const out = scanlineFill(m, w, h, 0, 0);
        expect(out[0]).toBe(1);          // seed
        expect(out[w + 1]).toBe(0);      // diagonal neighbour is NOT reached
    });
});
