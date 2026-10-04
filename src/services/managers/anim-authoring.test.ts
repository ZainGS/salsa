import { describe, it, expect } from 'vitest';
import { bake, evalMove, lag, type Q } from './anim-authoring';

const qz = (d: number): Q => { const h = (d * Math.PI) / 360; return [0, 0, Math.sin(h), Math.cos(h)]; };
const deg = (q: Q) => (2 * Math.atan2(q[2], q[3]) * 180) / Math.PI;

describe('anim-authoring', () => {
  it('eases: inOut is slow at the ends, linear is not', () => {
    const lin = [{ f: 0, q: qz(0) }, { f: 10, q: qz(90), ease: 'linear' as const }];
    const smooth = [{ f: 0, q: qz(0) }, { f: 10, q: qz(90), ease: 'inOut' as const }];
    expect(deg(evalMove(lin, 1))).toBeCloseTo(9, 3);
    expect(deg(evalMove(smooth, 1))).toBeLessThan(2);          // slow-in
    expect(deg(evalMove(smooth, 5))).toBeCloseTo(45, 3);        // symmetric
  });

  it('outBack overshoots the target and settles on it', () => {
    const k = [{ f: 0, q: qz(0) }, { f: 20, q: qz(60), ease: 'outBack' as const }];
    const peak = Math.max(...Array.from({ length: 21 }, (_, f) => deg(evalMove(k, f))));
    expect(peak).toBeGreaterThan(62);
    expect(deg(evalMove(k, 20))).toBeCloseTo(60, 4);
  });

  it('bake: keeps the authored keys, fills every step, first/last exact (so loops stay seamless)', () => {
    const keys = [{ f: 0, q: qz(0) }, { f: 7, q: qz(30) }, { f: 20, q: qz(0) }];
    const b = bake(keys, 20, 2);
    expect(b.map((k) => k.f)).toEqual([0, 2, 4, 6, 7, 8, 10, 12, 14, 16, 18, 20]);
    expect(b[0].q).toEqual(keys[0].q);
    expect(b[b.length - 1].q).toEqual(keys[2].q);
  });

  it('lag shifts interior keys only (never past the last key)', () => {
    const keys = [{ f: 0, q: qz(0) }, { f: 10, q: qz(30) }, { f: 12, q: qz(0) }];
    expect(lag(keys, 5).map((k) => k.f)).toEqual([0, 11, 12]);
  });
});
