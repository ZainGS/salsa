import { describe, it, expect } from 'vitest';
import { smoothNormalsForOutline } from './outline-geometry';

/** Build a minimal 2-vertex buffer at the same position but with two different (split) normals. */
function twoSplit(): Float32Array {
  const v = new Float32Array(2 * 12);
  // vertex 0 — position (1,1,1), normal +X
  v[0] = 1; v[1] = 1; v[2] = 1; v[3] = 1; v[4] = 0; v[5] = 0;
  // vertex 1 — SAME position, normal +Y
  v[12] = 1; v[13] = 1; v[14] = 1; v[15] = 0; v[16] = 1; v[17] = 0;
  return v;
}

describe('smoothNormalsForOutline', () => {
  it('welds split normals at a shared position to one averaged, normalized normal', () => {
    const out = smoothNormalsForOutline(twoSplit());
    // Both vertices now carry the same normal = normalize(+X + +Y) = (0.707, 0.707, 0)
    const inv = 1 / Math.SQRT2;
    for (const base of [0, 12]) {
      expect(out[base + 3]).toBeCloseTo(inv, 5);
      expect(out[base + 4]).toBeCloseTo(inv, 5);
      expect(out[base + 5]).toBeCloseTo(0, 5);
    }
  });

  it('leaves positions / uv / tangent untouched', () => {
    const src = twoSplit();
    src[6] = 0.25; src[7] = 0.75;             // uv on v0
    src[8] = 1; src[9] = 0; src[10] = 0; src[11] = 1;  // tangent on v0
    const out = smoothNormalsForOutline(src);
    expect(out[0]).toBe(1); expect(out[1]).toBe(1); expect(out[2]).toBe(1);  // position
    expect(out[6]).toBe(0.25); expect(out[7]).toBe(0.75);                    // uv
    expect(out[8]).toBe(1); expect(out[11]).toBe(1);                         // tangent
  });

  it('a cube corner gets a diagonal normal (three faces averaged)', () => {
    // Three vertices at the same corner, normals +X, +Y, +Z → smoothed = normalize(1,1,1).
    const v = new Float32Array(3 * 12);
    for (let i = 0; i < 3; i++) { v[i * 12] = 1; v[i * 12 + 1] = 1; v[i * 12 + 2] = 1; }
    v[3] = 1; v[16] = 1; v[29] = 1;   // normals +X, +Y, +Z on the three verts
    const out = smoothNormalsForOutline(v);
    const inv = 1 / Math.sqrt(3);
    expect(out[3]).toBeCloseTo(inv, 5);
    expect(out[4]).toBeCloseTo(inv, 5);
    expect(out[5]).toBeCloseTo(inv, 5);
  });

  it('does not crash on an empty buffer', () => {
    expect(smoothNormalsForOutline(new Float32Array(0)).length).toBe(0);
  });
});
