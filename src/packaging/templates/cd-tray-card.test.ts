/**
 * cd-tray-card.test.ts — the CD rear tray card (inlay): 3 panels (back + 2 spines), fixed 150×118 mm at
 * 300 DPI, spines fold forward 90° to seat in the case, real-node fold parity, complete guides.
 */

import { describe, it, expect } from 'vitest';
import { cdTrayCard, CD_TRAY_CARD } from './cd-tray-card';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold } from '../box-hierarchy';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence } from '../test-utils';

const r = cdTrayCard({ width: 0, height: 0, depth: 0 });   // dims are FIXED; params.width/height/depth ignored
const EPS = 1e-4;

describe('cd tray card template', () => {
  it('3 panels: back + 2 spines, with labels', () => {
    expect(r.foldMeshData.panels.map(p => p.id)).toEqual(['back', 'spineL', 'spineR']);
    for (const p of r.foldMeshData.panels) expect(r.panelLabels[p.id]).toBeTruthy();
  });

  it('canvas is exactly 150×118 mm at 300 DPI (print-correct), regardless of params', () => {
    expect(r.canvasWidth).toBe(Math.round(CD_TRAY_CARD.totalW / 25.4 * 300));    // 1772
    expect(r.canvasHeight).toBe(Math.round(CD_TRAY_CARD.height / 25.4 * 300));   // 1394
    // a different dpi rescales; the physical size is unchanged
    const hi = cdTrayCard({ width: 0, height: 0, depth: 0, dpi: 600 });
    expect(hi.canvasWidth).toBe(Math.round(CD_TRAY_CARD.totalW / 25.4 * 600));
  });

  it('fold 0: flat sheet; fold 1: back stays flat, both spines fold up 90° (extent = back × spine × height)', () => {
    for (const panel of computeFoldWorldCorners(r.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
    const corners = computeFoldWorldCorners(r.foldMeshData.panels, 1);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const panel of corners) {
      for (const c of panel) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
    }
    const backW = CD_TRAY_CARD.totalW - 2 * CD_TRAY_CARD.spineW;   // 138
    expect(max[0] - min[0]).toBeCloseTo(backW, 3);                 // spines rotated out of X
    expect(max[1] - min[1]).toBeCloseTo(CD_TRAY_CARD.spineW, 3);   // spine height above the plane
    expect(max[2] - min[2]).toBeCloseTo(CD_TRAY_CARD.height, 3);   // full card height
    // The back panel itself is untouched — every one of its corners stays at y≈0.
    for (const [, y] of corners[0]) expect(Math.abs(y)).toBeLessThan(EPS);
  });

  it('non-spine UVs map 1:1 to the net; guides = full-net cut, 2 spine creases, bleed', () => {
    const outline = r.guides.find(g => g.type === 'panel')!;
    let seg = 0;
    for (const p of r.foldMeshData.panels) {
      for (let k = 0; k < p.corners.length; k++) {
        const [pxX, pxY] = outline.segments[seg++][0];
        expect(p.uvs[k][0] * r.canvasWidth).toBeCloseTo(pxX, 6);
        expect(p.uvs[k][1] * r.canvasHeight).toBeCloseTo(pxY, 6);
      }
    }
    const cut = r.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(r.canvasWidth - 1.5);
    expect(r.guides.find(g => g.type === 'fold')!.segments.length).toBe(2);   // the two spine hinges
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
