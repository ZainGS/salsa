/**
 * cd-booklet.test.ts — the CD booklet outer sheet: 2 leaves (back + front cover), fixed 240×120 mm flat
 * at 300 DPI, folding on the centre spine, real-node fold parity, complete guides.
 */

import { describe, it, expect } from 'vitest';
import { cdBooklet, CD_BOOKLET } from './cd-booklet';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold } from '../box-hierarchy';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence } from '../test-utils';

const r = cdBooklet({ width: 0, height: 0, depth: 0 });
const EPS = 1e-4;

describe('cd booklet template', () => {
  it('2 leaves: back + front cover, with labels', () => {
    expect(r.foldMeshData.panels.map(p => p.id)).toEqual(['back', 'front']);
    expect(r.panelLabels.back).toBeTruthy();
    expect(r.panelLabels.front).toBeTruthy();
  });

  it('flat sheet is 240×120 mm at 300 DPI (two 120 leaves)', () => {
    expect(r.canvasWidth).toBe(Math.round(2 * CD_BOOKLET.leaf / 25.4 * 300));   // 2835
    expect(r.canvasHeight).toBe(Math.round(CD_BOOKLET.leaf / 25.4 * 300));      // 1417
  });

  it('fold 0: flat 240-wide spread; fold 1: front leaf folds up on the spine (back stays flat)', () => {
    for (const panel of computeFoldWorldCorners(r.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
    const flatW = computeFoldWorldCorners(r.foldMeshData.panels, 0)
      .flat().reduce((m, c) => Math.max(m, c[0]), -Infinity) -
      computeFoldWorldCorners(r.foldMeshData.panels, 0).flat().reduce((m, c) => Math.min(m, c[0]), Infinity);
    expect(flatW).toBeCloseTo(2 * CD_BOOKLET.leaf, 3);

    const corners = computeFoldWorldCorners(r.foldMeshData.panels, 1);
    for (const [, y] of corners[0]) expect(Math.abs(y)).toBeLessThan(EPS);   // back cover stays flat
    // Front leaf lifted out of the plane — some corner rises to the leaf width.
    const maxY = Math.max(...corners[1].map(c => c[1]));
    expect(maxY).toBeCloseTo(CD_BOOKLET.leaf, 2);
  });

  it('guides: full-net cut, one spine crease, bleed', () => {
    const cut = r.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(r.canvasWidth - 1.5);
    expect(r.guides.find(g => g.type === 'fold')!.segments.length).toBe(1);   // the spine only
    expect(r.guides.some(g => g.type === 'bleed')).toBe(true);
  });

  it('real nodes: corners match the oracle + hinge coincidence at fold 0 / 0.5 / 1', () => {
    const UNIT = 0.02;
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(r.foldMeshData.panels, host, { scale: UNIT });
    for (const amt of [0, 0.5, 1]) {
      setBoxFold(box, amt, host);
      const expected = computeFoldWorldCorners(r.foldMeshData.panels, amt);
      box.panels.forEach((p, i) => {
        realWorldCorners(meshes.get(p.meshId)!).forEach((c, k) => {
          for (let d = 0; d < 3; d++) {
            expect(Math.abs(c[d] - expected[i][k][d] * UNIT), `panel ${i} corner ${k} axis ${d} fold ${amt}`).toBeLessThan(1e-4);
          }
        });
      });
      expectHingeCoincidence(r.foldMeshData.panels, box, meshes, UNIT, `fold ${amt}`);
    }
  });
});
