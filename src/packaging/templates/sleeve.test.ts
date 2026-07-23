/**
 * sleeve.test.ts — correctness gate for the open-ended sleeve (M2-only composition proof):
 * 5 panels (4 walls + glue tab), folds into an open W×D×H tube, real-node parity, glue-tab
 * UV exclusion, complete guides.
 */

import { describe, it, expect } from 'vitest';
import { sleeve } from './sleeve';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold } from '../box-hierarchy';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence, expectNoInterpenetration } from '../test-utils';

const W = 90, H = 50, D = 30;
const r = sleeve({ width: W, height: H, depth: D });
const EPS = 1e-4;

describe('sleeve template', () => {
  it('5 panels: 4 walls + glue tab, with labels', () => {
    expect(r.foldMeshData.panels.map(p => p.id)).toEqual(['front', 'right', 'back', 'left', 'glueTab']);
    for (const p of r.foldMeshData.panels) expect(r.panelLabels[p.id]).toBeTruthy();
  });

  it('fold 0: flat; fold 1: an open rectangular W×D×H tube (nothing covers the z ends)', () => {
    for (const panel of computeFoldWorldCorners(r.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
    const corners = computeFoldWorldCorners(r.foldMeshData.panels, 1);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const panel of corners) {
      for (const c of panel) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
    }
    expect(max[0] - min[0]).toBeCloseTo(W, 3);
    expect(max[1] - min[1]).toBeCloseTo(D, 3);
    expect(max[2] - min[2]).toBeCloseTo(H, 3);
    // OPEN ends: every panel is a wall parallel to z — each panel spans the FULL z range (no end caps).
    for (const panel of corners) {
      const zs = panel.map(c => c[2]);
      expect(Math.min(...zs)).toBeCloseTo(-H / 2, 3);
      expect(Math.max(...zs)).toBeCloseTo(H / 2, 3);
    }
    // The glue tab lands coplanar with the FRONT wall (y ≈ 0), inside the tube footprint.
    for (const c of corners[4]) {
      expect(Math.abs(c[1])).toBeLessThan(1e-3);
      expect(c[0]).toBeGreaterThan(-W / 2 - 1e-3);
      expect(c[0]).toBeLessThan(W / 2 + 1e-3);
    }
    expectNoInterpenetration(corners, r.foldMeshData.panels, 'sleeve fold 1');
  });

  it('glue tab UVs live in the margin strip; other panels map 1:1 to the net', () => {
    const outline = r.guides.find(g => g.type === 'panel' && !g.label)!;
    let seg = 0;
    for (const p of r.foldMeshData.panels) {
      for (let k = 0; k < p.corners.length; k++) {
        const [pxX, pxY] = outline.segments[seg++][0];
        if (p.id === 'glueTab') {
          expect(p.uvs[k][0]).toBeGreaterThan(0.98);
        } else {
          expect(p.uvs[k][0] * r.canvasWidth).toBeCloseTo(pxX, 6);
          expect(p.uvs[k][1] * r.canvasHeight).toBeCloseTo(pxY, 6);
        }
      }
    }
  });

  it('guides: cut spans the full net, creases = the 4 hinges, glue-tab marker labeled, bleed present', () => {
    const cut = r.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(r.canvasWidth - 1.5);
    expect(r.guides.find(g => g.type === 'fold')!.segments.length).toBe(4);
    expect(r.guides.some(g => g.type === 'panel' && g.label === 'Glue Tab')).toBe(true);
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
