/**
 * cd-front-insert.test.ts — the single-leaf CD front insert: 1 flat panel, fixed 120×120 mm at 300 DPI,
 * no fold, real-node parity, complete guides.
 */

import { describe, it, expect } from 'vitest';
import { cdFrontInsert, CD_FRONT_INSERT } from './cd-front-insert';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold } from '../box-hierarchy';
import { makeRealNodeHost, realWorldCorners } from '../test-utils';

const r = cdFrontInsert({ width: 0, height: 0, depth: 0 });
const EPS = 1e-4;

describe('cd front insert template', () => {
  it('a single flat panel with a label', () => {
    expect(r.foldMeshData.panels.map(p => p.id)).toEqual(['front']);
    expect(r.foldMeshData.panels[0].hinge).toBeNull();
    expect(r.panelLabels.front).toBeTruthy();
  });

  it('canvas is a 120×120 mm square at 300 DPI (print-correct)', () => {
    const px = Math.round(CD_FRONT_INSERT.size / 25.4 * 300);   // 1417
    expect(r.canvasWidth).toBe(px);
    expect(r.canvasHeight).toBe(px);
  });

  it('the panel is flat at every fold amount (nothing to fold) and stays 120×120 in the plane', () => {
    for (const amt of [0, 0.5, 1]) {
      const corners = computeFoldWorldCorners(r.foldMeshData.panels, amt);
      for (const [, y] of corners[0]) expect(Math.abs(y)).toBeLessThan(EPS);
      const xs = corners[0].map(c => c[0]), zs = corners[0].map(c => c[2]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(CD_FRONT_INSERT.size, 3);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(CD_FRONT_INSERT.size, 3);
    }
  });

  it('guides: full-net cut, no fold creases (single panel), bleed present', () => {
    const cut = r.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(r.canvasWidth - 1.5);
    expect(r.guides.some(g => g.type === 'fold')).toBe(false);
    expect(r.guides.some(g => g.type === 'bleed')).toBe(true);
  });

  it('real nodes: the single panel matches the oracle', () => {
    const UNIT = 0.02;
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(r.foldMeshData.panels, host, { scale: UNIT });
    setBoxFold(box, 0, host);
    const expected = computeFoldWorldCorners(r.foldMeshData.panels, 0);
    realWorldCorners(meshes.get(box.panels[0].meshId)!).forEach((c, k) => {
      for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - expected[0][k][d] * UNIT)).toBeLessThan(1e-4);
    });
  });
});
