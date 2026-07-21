/**
 * src/packaging/box-hierarchy.test.ts — the CORRECTNESS GATE for the rigid-panel fold.
 *
 * Proves the node HIERARCHY (pivot transforms only, geometry built once) is geometrically
 * IDENTICAL to the unit-verified vertex-baking compiler (compileFoldMesh). For an 80×60×40
 * simpleBox at fold 0 / 0.5 / 1, each panel's 4 world-space corners composed through the
 * hierarchy must match compileFoldMesh's output vertices within 1e-4. Plus: flat at fold 0,
 * closed W×H×D box at fold 1.
 */

import { describe, it, expect } from 'vitest';
import { simpleBox } from './templates/simple-box';
import { compileFoldMesh } from './fold-mesh';
import { computeFoldWorldCorners } from './box-hierarchy';

const W = 80, H = 60, D = 40;
const EPS = 1e-4;

const data = simpleBox({ width: W, height: H, depth: D }).foldMeshData;

/** compileFoldMesh verts → per-panel 4 corner positions (template order, 4 verts per panel). */
function compilePanelCorners(amt: number): [number, number, number][][] {
  const verts = compileFoldMesh(data, amt).vertices;
  const panels: [number, number, number][][] = [];
  for (let p = 0; p < data.panels.length; p++) {
    const pos: [number, number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const v = (p * 4 + k) * 8;
      pos.push([verts[v], verts[v + 1], verts[v + 2]]);
    }
    panels.push(pos);
  }
  return panels;
}

describe('box-hierarchy vs compileFoldMesh (simpleBox 80×60×40)', () => {
  it.each([0, 0.5, 1])('foldAmount %s: hierarchy corners == compileFoldMesh vertices', (amt) => {
    const hier = computeFoldWorldCorners(data.panels, amt);
    const baked = compilePanelCorners(amt);
    expect(hier.length).toBe(baked.length);
    for (let p = 0; p < baked.length; p++) {
      for (let k = 0; k < 4; k++) {
        for (let c = 0; c < 3; c++) {
          expect(hier[p][k][c]).toBeCloseTo(baked[p][k][c], 4);
        }
      }
    }
  });

  it('foldAmount 0: the net is flat in the XZ plane (y ≈ 0)', () => {
    for (const panel of computeFoldWorldCorners(data.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
  });

  it('foldAmount 1: panels close into a W×H×D box centred on x/z', () => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const panel of computeFoldWorldCorners(data.panels, 1)) {
      for (const corner of panel) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], corner[k]); max[k] = Math.max(max[k], corner[k]); }
      }
    }
    expect(max[0] - min[0]).toBeCloseTo(W, 3);
    expect(max[1] - min[1]).toBeCloseTo(H, 3);
    expect(max[2] - min[2]).toBeCloseTo(D, 3);
    expect(min[0]).toBeCloseTo(-W / 2, 3); expect(max[0]).toBeCloseTo(W / 2, 3);
    expect(min[1]).toBeCloseTo(0, 3);      expect(max[1]).toBeCloseTo(H, 3);
    expect(min[2]).toBeCloseTo(-D / 2, 3); expect(max[2]).toBeCloseTo(D / 2, 3);
  });
});
