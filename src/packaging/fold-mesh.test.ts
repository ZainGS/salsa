/**
 * src/packaging/fold-mesh.test.ts — headless verification of the fold-mesh compiler.
 *
 * Exercises compileFoldMesh at foldAmount 0 / 0.5 / 1 for an 80×60×40 simpleBox and
 * asserts: vertex/index counts, no NaNs, unit normals, flat-at-0, and — the real check —
 * that at fold=1 the six panels form a CLOSED box of exactly W×H×D with every face
 * normal pointing OUTWARD from the box centre and opposite faces antiparallel.
 */

import { describe, it, expect } from 'vitest';
import { simpleBox } from './templates/simple-box';
import { compileFoldMesh } from './fold-mesh';

const W = 80, H = 60, D = 40;
const EPS = 1e-4;

const data = simpleBox({ width: W, height: H, depth: D }).foldMeshData;

/** Unpack '8float' verts into per-panel {pos, nrm} (4 verts per panel, template order). */
function unpack(verts: Float32Array) {
  const panels: { pos: [number, number, number][]; nrm: [number, number, number][] }[] = [];
  for (let p = 0; p < data.panels.length; p++) {
    const pos: [number, number, number][] = [];
    const nrm: [number, number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const v = (p * 4 + k) * 8;
      pos.push([verts[v], verts[v + 1], verts[v + 2]]);
      nrm.push([verts[v + 3], verts[v + 4], verts[v + 5]]);
    }
    panels.push({ pos, nrm });
  }
  return panels;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const centroid = (pts: number[][]) =>
  pts.reduce((c, p) => [c[0] + p[0] / pts.length, c[1] + p[1] / pts.length, c[2] + p[2] / pts.length], [0, 0, 0]);

describe('compileFoldMesh (simpleBox 80×60×40)', () => {
  it.each([0, 0.5, 1])('foldAmount %s: counts, no NaNs, unit normals', (amt) => {
    const g = compileFoldMesh(data, amt);
    expect(g.format).toBe('8float');
    expect(g.vertices.length).toBe(6 * 4 * 8);   // 6 panels × 4 verts × 8 floats
    expect(g.indices.length).toBe(6 * 2 * 3);    // 6 panels × 2 tris
    for (const v of g.vertices) expect(Number.isNaN(v)).toBe(false);
    for (const p of unpack(g.vertices)) {
      for (const n of p.nrm) expect(Math.abs(len(n) - 1)).toBeLessThan(EPS);
    }
  });

  it('foldAmount 0: the net is flat in the XZ plane', () => {
    const g = compileFoldMesh(data, 0);
    for (let v = 0; v < g.vertices.length / 8; v++) {
      expect(Math.abs(g.vertices[v * 8 + 1])).toBeLessThan(EPS);   // y ≈ 0
    }
  });

  it('foldAmount 1: panels close into a W×H×D box', () => {
    const g = compileFoldMesh(data, 1);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < g.vertices.length / 8; v++) {
      for (let k = 0; k < 3; k++) {
        const c = g.vertices[v * 8 + k];
        min[k] = Math.min(min[k], c); max[k] = Math.max(max[k], c);
      }
    }
    // Base is the root at y=0; walls fold up → the box spans W×H×D centred on x/z.
    expect(max[0] - min[0]).toBeCloseTo(W, 3);
    expect(max[1] - min[1]).toBeCloseTo(H, 3);
    expect(max[2] - min[2]).toBeCloseTo(D, 3);
    expect(min[0]).toBeCloseTo(-W / 2, 3); expect(max[0]).toBeCloseTo(W / 2, 3);
    expect(min[1]).toBeCloseTo(0, 3);      expect(max[1]).toBeCloseTo(H, 3);
    expect(min[2]).toBeCloseTo(-D / 2, 3); expect(max[2]).toBeCloseTo(D / 2, 3);
  });

  it('foldAmount 1: every panel is planar + axis-aligned at its box face', () => {
    const panels = unpack(compileFoldMesh(data, 1).vertices);
    // Template order: base 0, front 1, back 2, left 3, right 4, lid 5.
    const face = (i: number, axis: number, value: number) => {
      for (const p of panels[i].pos) expect(p[axis]).toBeCloseTo(value, 3);
    };
    face(0, 1, 0);       // base   y = 0
    face(5, 1, H);       // lid    y = H
    face(1, 2, D / 2);   // front  z = +D/2
    face(2, 2, -D / 2);  // back   z = −D/2
    face(3, 0, -W / 2);  // left   x = −W/2
    face(4, 0, W / 2);   // right  x = +W/2
  });

  it('foldAmount 1: face normals point OUTWARD; opposite faces antiparallel', () => {
    const panels = unpack(compileFoldMesh(data, 1).vertices);
    const boxCentre = [0, H / 2, 0];
    for (const p of panels) {
      const c = centroid(p.pos);
      const out = [c[0] - boxCentre[0], c[1] - boxCentre[1], c[2] - boxCentre[2]];
      // outward-facing consistency: normal · (centroid − centre) > 0
      expect(dot(p.nrm[0], out)).toBeGreaterThan(0);
      // all 4 verts of a panel share one normal
      for (const n of p.nrm) expect(dot(n, p.nrm[0])).toBeCloseTo(1, 4);
    }
    const pairs: [number, number][] = [[0, 5], [1, 2], [3, 4]];   // base/lid, front/back, left/right
    for (const [a, b] of pairs) {
      expect(dot(panels[a].nrm[0], panels[b].nrm[0])).toBeCloseTo(-1, 4);
    }
  });

  it('winding matches the stored normal (triangle cross ≈ vertex normal)', () => {
    const g = compileFoldMesh(data, 1);
    for (let t = 0; t < g.indices.length; t += 3) {
      const p = (i: number): number[] => {
        const v = g.indices[t + i] * 8;
        return [g.vertices[v], g.vertices[v + 1], g.vertices[v + 2]];
      };
      const [a, b, c] = [p(0), p(1), p(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = len(cr);
      const n = [g.vertices[g.indices[t] * 8 + 3], g.vertices[g.indices[t] * 8 + 4], g.vertices[g.indices[t] * 8 + 5]];
      expect(dot([cr[0] / l, cr[1] / l, cr[2] / l], n)).toBeCloseTo(1, 4);
    }
  });
});
