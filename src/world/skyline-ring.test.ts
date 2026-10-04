import { describe, it, expect } from 'vitest';
import { ringTiles, ringBoxesOf, buildSkylineRing, RING_WALL_BUCKETS } from './skyline-ring';
import { buildRingGroups } from '../services/workers/world-jobs';

// performance-plan P19 — the skyline impostor ring: the band's tiles, world-anchored boxes, ≤ 4 draws, outside the skyline.

describe('P19 skyline ring', () => {
    it('the band is the Chebyshev annulus inner+1 .. inner+depth around the centre, nearest ring first', () => {
        const t = ringTiles([3, -2], 2, 2);
        expect(t.length).toBe(9 * 9 - 5 * 5);
        const cheb = (a: [number, number]) => Math.max(Math.abs(a[0] - 3), Math.abs(a[1] + 2));
        expect(t.every(x => cheb(x) >= 3 && cheb(x) <= 4)).toBe(true);
        for (let i = 1; i < t.length; i++) expect(cheb(t[i])).toBeGreaterThanOrEqual(cheb(t[i - 1]));
        expect(new Set(t.map(x => x.join())).size).toBe(t.length);
    });

    it('world-anchored: a tile builds the same boxes wherever the centre is; boxes stay inside their tile', () => {
        const a = ringBoxesOf(7, 10, 12, -3), b = ringBoxesOf(7, 10, 12, -3);
        expect(a).toEqual(b);
        expect(ringBoxesOf(8, 10, 12, -3)).not.toEqual(a);   // the seed matters
        for (const x of a) {
            expect(Math.abs(x.x / 20 - 12)).toBeLessThan(0.5);
            expect(Math.abs(x.z / 20 + 3)).toBeLessThan(0.5);
            expect(x.h).toBeGreaterThan(0);
            expect(x.colour).toBeGreaterThanOrEqual(0); expect(x.colour).toBeLessThan(RING_WALL_BUCKETS);
        }
    });

    it('moving the centre a tile keeps every shared band tile identical (only the edges change)', () => {
        const o = { seed: 3, radius: 10, inner: 4, depth: 2 };
        const at = (c: [number, number]) => new Map(ringTiles(c, o.inner, o.depth).map(t => [t.join(), JSON.stringify(ringBoxesOf(o.seed, o.radius, t[0], t[1]))]));
        const A = at([0, 0]), B = at([1, 0]);
        let shared = 0;
        for (const [k, v] of A) if (B.has(k)) { shared++; expect(B.get(k)).toBe(v); }
        expect(shared).toBeGreaterThan(A.size / 2);
    });

    it('≤ 4 layers (3 wall buckets + roofs), world space past the skyline, named like the HLOD far level', () => {
        const L = buildSkylineRing({ seed: 3, radius: 10, centre: [5, 0], inner: 3, depth: 2, groundY: 0.5 });
        expect(L.length).toBeLessThanOrEqual(RING_WALL_BUCKETS + 1);
        expect(L.every(l => /^world:(bldg|roofs)-hlod-ring/.test(l.name) && l.drape === 'baked')).toBe(true);
        expect(L.some(l => l.pattern?.mode === 'windows')).toBe(true);
        for (const l of L) {
            const v = l.geometry.vertices;
            for (let i = 0; i < v.length; i += 12) {
                const tx = v[i] / 20 - 5, tz = v[i + 2] / 20;
                expect(Math.max(Math.abs(tx), Math.abs(tz))).toBeGreaterThan(3.5 - 0.15);   // past the skyline square (a box may lean over its tile edge a little)
                expect(v[i + 1]).toBeGreaterThan(0.3);
            }
        }
        // the worker job wraps it in one group, on the world's height field
        const g = buildRingGroups({ params: { seed: 3, radius: 10, groundY: 0.5 } as never, centre: [5, 0], inner: 3, depth: 2 });
        expect(g.length).toBe(1);
        expect(g[0].name).toBe('World Skyline Ring');
    });
});
