import { describe, it, expect } from 'vitest';
import { rankBodyInfluences } from './clothing-generator';

/** The garment weight-transfer scan exactly as it was BEFORE audit C1 Phase 2 (top-2, strict >, slot order). */
function oldTopTwo(ji: ArrayLike<number>, jw: ArrayLike<number>, b: number) {
  let i0 = 0, w0 = -1, i1 = 0, w1 = -1;
  for (let k = 0; k < 4; k++) {
    const w = jw[b * 4 + k], jx = ji[b * 4 + k];
    if (w > w0) { i1 = i0; w1 = w0; i0 = jx; w0 = w; }
    else if (w > w1) { i1 = jx; w1 = w; }
  }
  return { i0, w0, i1, w1 };
}

// Deterministic PRNG so the property test is reproducible.
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

describe('garment weight transfer keeps up to 4 body influences (audit 2026-09-28 C1 Phase 2)', () => {
  it('a classic (2-influence) body vert gives EXACTLY the old top-2 result, and no 4-influence override', () => {
    const r = rng(7);
    for (let t = 0; t < 5000; t++) {
      const ji = [Math.floor(r() * 20), Math.floor(r() * 20), 0, 0];
      const a = r() < 0.2 ? 1 : r();                                 // include pure single-bone verts
      const jw = [a, 1 - a, 0, 0];
      if (r() < 0.1) { jw[0] = 0.5; jw[1] = 0.5; }                  // ties
      const got = rankBodyInfluences(ji, jw, 0);
      const old = oldTopTwo(ji, jw, 0);
      expect({ i0: got.i0, w0: got.w0, i1: got.i1, w1: got.w1 }).toEqual(old);
      expect(got.all4).toBeNull();
    }
  });

  it('a seam-blended (3-4 influence) body vert passes all of them through, normalized', () => {
    const got = rankBodyInfluences([3, 7, 6, 2], [0.2, 0.5, 0.25, 0.05], 0);
    expect(got.i0).toBe(7);
    expect(got.i1).toBe(6);
    expect(got.all4).not.toBeNull();
    const [j0, j1, j2, j3, w0, w1, w2, w3] = got.all4!;
    expect([j0, j1, j2, j3]).toEqual([7, 6, 3, 2]);                 // ranked by weight
    expect(w0 + w1 + w2 + w3).toBeCloseTo(1, 6);
    expect(w0).toBeCloseTo(0.5, 6);
  });

  it('reads the right vertex from a packed array', () => {
    const ji = [0, 0, 0, 0, 5, 4, 3, 0], jw = [1, 0, 0, 0, 0.6, 0.3, 0.1, 0];
    expect(rankBodyInfluences(ji, jw, 0).all4).toBeNull();
    expect(rankBodyInfluences(ji, jw, 1).all4!.slice(0, 3)).toEqual([5, 4, 3]);
  });
});
