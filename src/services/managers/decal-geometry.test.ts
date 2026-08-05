/**
 * src/services/managers/decal-geometry.test.ts — the decal orientation maths (Mode A floating quad).
 *
 * The whole point of decalOrientation is that a quad facing local +Z ends up lying flat on a surface with
 * its face along the surface normal. That's a YXZ-Euler extraction and is very easy to get subtly wrong, so
 * these tests RECONSTRUCT the engine's rotation matrix (Ry·Rx·Rz, per base/shape.ts) from the returned
 * angles and verify the quad's local axes map where they should — for a spread of normals, including the
 * near-vertical gimbal case.
 */

import { describe, it, expect } from 'vitest';
import { decalOrientation, decalPlacement, decalQuadGeometry, type V3 } from './decal-geometry';

// ── A tiny 3x3 rotation reconstructor matching base/shape.ts: R = Ry(ry)·Rx(rx)·Rz(rz) ──
type M3 = number[][];
const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
const Rx = (a: number): M3 => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Ry = (b: number): M3 => [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
const Rz = (c: number): M3 => [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
const apply = (m: M3, v: V3): V3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const rotFor = (n: V3, roll = 0): M3 => {
  const { rx, ry, rz } = decalOrientation(n, roll);
  return mul(mul(Ry(ry), Rx(rx)), Rz(rz));   // Ry·Rx·Rz — the engine's order
};
const nrm = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const closeV = (a: V3, b: V3, tol = 1e-6): void => { for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 5); void tol; };

describe('decalOrientation maps the quad face (+Z) onto the surface normal', () => {
  const normals: [string, V3][] = [
    ['+Z (identity)', [0, 0, 1]],
    ['+X wall', [1, 0, 0]],
    ['−X wall', [-1, 0, 0]],
    ['−Z wall', [0, 0, -1]],
    ['+Y floor', [0, 1, 0]],
    ['−Y ceiling', [0, -1, 0]],
    ['diagonal', [0.6, 0.3, -0.74]],
    ['steep', [0.1, 0.98, 0.17]],
  ];
  for (const [name, n] of normals) {
    it(`${name}: local +Z → normal`, () => {
      const N = nrm(n);
      const face = apply(rotFor(N), [0, 0, 1]);   // where the quad's facing axis ends up
      closeV(face, N);
    });
  }

  it('the local +Y stays UP-on-the-plane (perpendicular to the normal, positive-ish world Y) for walls', () => {
    for (const n of [[1, 0, 0], [0, 0, -1], [0.5, 0, 0.87]] as V3[]) {
      const N = nrm(n);
      const up = apply(rotFor(N), [0, 1, 0]);
      expect(Math.abs(up[0] * N[0] + up[1] * N[1] + up[2] * N[2]), 'up not in the plane').toBeLessThan(1e-6);
      expect(up[1], 'poster is upside down on a wall').toBeGreaterThan(0.5);
    }
  });

  it('the in-plane rotation spins the quad about the normal without tilting its face', () => {
    const N = nrm([1, 0.2, 0.3] as V3);
    for (const roll of [0.4, 1.2, -0.9, Math.PI]) {
      const face = apply(rotFor(N, roll), [0, 0, 1]);
      closeV(face, N);                              // face still on the normal, whatever the roll
    }
    // A non-zero roll actually moves the up axis (it isn't a no-op).
    const up0 = apply(rotFor(N, 0), [0, 1, 0]);
    const up1 = apply(rotFor(N, 1.0), [0, 1, 0]);
    expect(Math.hypot(up0[0] - up1[0], up0[1] - up1[1], up0[2] - up1[2])).toBeGreaterThan(0.1);
  });
});

describe('decalPlacement', () => {
  it('lifts the decal off the surface along the normal and scales by size + aspect', () => {
    const p = decalPlacement([1, 2, 3], [0, 0, 1], 0.8, 2);
    expect(p.position[2]).toBeGreaterThan(3);          // pushed out along +Z
    expect(p.position[2] - 3).toBeLessThan(0.05);      // only a hair
    expect(p.scaleX).toBeCloseTo(0.8, 6);              // width = size
    expect(p.scaleY).toBeCloseTo(0.4, 6);              // height = size / aspect
  });
});

describe('decalQuadGeometry', () => {
  it('is a unit quad (2 tris) facing +Z with 0..1 UVs', () => {
    const g = decalQuadGeometry();
    expect(g.format).toBe('8float');
    expect(g.indices.length).toBe(6);
    expect(g.vertices.length).toBe(4 * 8);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(g.vertices[i * 8])).toBeCloseTo(0.5, 6);       // |x| = 0.5
      expect(g.vertices[i * 8 + 5]).toBe(1);                          // normal.z = 1
    }
  });
});
