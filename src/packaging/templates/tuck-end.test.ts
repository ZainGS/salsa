/**
 * tuck-end.test.ts — the CORRECTNESS GATE for the tuckEnd template (RTE/STE, M1×2 + M2).
 *
 * Closed-form (computeFoldWorldCorners — the proven oracle, now windowed) + REAL-node runtime
 * checks (the box-hierarchy.nodes.test.ts pattern):
 *  - fold 0 = flat net; fold 1 = an exact W×D×H shell (x=W, y=D, z=H) from the WALLS,
 *  - every flap (tongues, dust flaps, closures, glue tab) ends INSIDE the shell at fold 1,
 *  - tuckStyle semantics: RTE tongues land on OPPOSITE faces, STE on the SAME face,
 *  - fold SEQUENCE: walls done by their window's end, tongues stay coplanar with their closure
 *    until the tongue window opens (they tuck LAST),
 *  - NO proper panel interpenetration (beyond board-zero tolerance) at t = 0.25/0.5/0.75/1,
 *  - hierarchy == compileFoldMesh at sampled folds (the windowed identity),
 *  - real nodes: world corners match the oracle, hinge coincidence, in-place re-dimension.
 */

import { describe, it, expect } from 'vitest';
import { tuckEnd } from './tuck-end';
import { compileFoldMesh } from '../fold-mesh';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold, updateBoxDimensions } from '../box-hierarchy';
import { TUCK_SEQUENCE } from '../mechanisms';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence, expectNoInterpenetration } from '../test-utils';
import type { FoldPanel } from '../types';

const W = 80, H = 60, D = 40;
const EPS = 1e-4;
const SHELL_TOL = 1e-3;

const rte = tuckEnd({ width: W, height: H, depth: D });                          // default 'reverse'
const ste = tuckEnd({ width: W, height: H, depth: D, tuckStyle: 'straight' });

const idx = (panels: FoldPanel[], id: string): number => panels.findIndex(p => p.id === id);

describe('tuckEnd net structure', () => {
  it('13 panels: 4 walls + glue tab + 2×(closure + tongue + 2 dust flaps), labels complete', () => {
    for (const r of [rte, ste]) {
      const ids = r.foldMeshData.panels.map(p => p.id);
      expect(ids).toEqual(['front', 'right', 'back', 'left', 'glueTab',
        'topClose', 'topTongue', 'topDust0', 'topDust1',
        'botClose', 'botTongue', 'botDust0', 'botDust1']);
      for (const id of ids) expect(r.panelLabels[id]).toBeTruthy();
    }
  });

  it('RTE: bottom closure hangs off the BACK; STE: off the FRONT (opposite vs same face)', () => {
    expect(rte.foldMeshData.panels[idx(rte.foldMeshData.panels, 'botClose')].parentPanelIndex)
      .toBe(idx(rte.foldMeshData.panels, 'back'));
    expect(ste.foldMeshData.panels[idx(ste.foldMeshData.panels, 'botClose')].parentPanelIndex)
      .toBe(idx(ste.foldMeshData.panels, 'front'));
  });

  it('guides carry the new line roles: slit segments present, plus cut/fold/panel/bleed', () => {
    const types = new Set(rte.guides.map(g => g.type));
    for (const t of ['cut', 'fold', 'panel', 'bleed', 'slit']) expect(types.has(t as never)).toBe(true);
    // 2 tuck assemblies × 2 shoulder slits.
    const slitSegs = rte.guides.filter(g => g.type === 'slit').flatMap(g => g.segments);
    expect(slitSegs.length).toBe(4);
    // The glue tab is marked with a LABELED panel guide.
    expect(rte.guides.some(g => g.type === 'panel' && g.label === 'Glue Tab')).toBe(true);
  });

  it('walls + glue tab share the wall window; dust/closure/tongue follow the tuck sequence', () => {
    const p = rte.foldMeshData.panels;
    for (const id of ['right', 'back', 'left', 'glueTab']) expect(p[idx(p, id)].foldWindow).toEqual(TUCK_SEQUENCE.walls);
    for (const id of ['topDust0', 'topDust1', 'botDust0', 'botDust1']) expect(p[idx(p, id)].foldWindow).toEqual(TUCK_SEQUENCE.dust);
    for (const id of ['topClose', 'botClose']) expect(p[idx(p, id)].foldWindow).toEqual(TUCK_SEQUENCE.closure);
    for (const id of ['topTongue', 'botTongue']) expect(p[idx(p, id)].foldWindow).toEqual(TUCK_SEQUENCE.tongue);
  });
});

describe('tuckEnd fold geometry (closed form)', () => {
  it('fold 0: the whole net is flat (y ≈ 0)', () => {
    for (const panel of computeFoldWorldCorners(rte.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
  });

  for (const [name, r] of [['reverse', rte], ['straight', ste]] as const) {
    it(`${name}: fold 1 closes into an exact W×D×H shell and EVERY flap ends inside it`, () => {
      const corners = computeFoldWorldCorners(r.foldMeshData.panels, 1);
      // The shell from the 4 walls alone.
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const wi of [0, 1, 2, 3]) {
        for (const c of corners[wi]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
      }
      expect(max[0] - min[0]).toBeCloseTo(W, 3);
      expect(max[1] - min[1]).toBeCloseTo(D, 3);
      expect(max[2] - min[2]).toBeCloseTo(H, 3);
      expect(min[0]).toBeCloseTo(-W / 2, 3); expect(min[1]).toBeCloseTo(0, 3); expect(min[2]).toBeCloseTo(-H / 2, 3);
      // ALL 13 panels (closures, tongues, dust flaps, glue tab) end INSIDE the shell (tolerance).
      corners.forEach((panel, i) => {
        for (const c of panel) {
          expect(c[0]).toBeGreaterThan(-W / 2 - SHELL_TOL); expect(c[0]).toBeLessThan(W / 2 + SHELL_TOL);
          expect(c[1]).toBeGreaterThan(-SHELL_TOL); expect(c[1]).toBeLessThan(D + SHELL_TOL);
          expect(c[2], `panel ${r.foldMeshData.panels[i].id} z`).toBeGreaterThan(-H / 2 - SHELL_TOL);
          expect(c[2]).toBeLessThan(H / 2 + SHELL_TOL);
        }
      });
    });
  }

  it('tuckStyle semantics at fold 1: RTE tongues on OPPOSITE faces, STE on the SAME face', () => {
    const cr = computeFoldWorldCorners(rte.foldMeshData.panels, 1);
    const cs = computeFoldWorldCorners(ste.foldMeshData.panels, 1);
    const p = rte.foldMeshData.panels;
    const yOf = (corners: [number, number, number][][], id: string): number[] =>
      corners[idx(p, id)].map(c => c[1]);
    // RTE: top tongue hugs the BACK face (y=D), bottom tongue hugs the FRONT face (y=0).
    for (const y of yOf(cr, 'topTongue')) expect(Math.abs(y - D)).toBeLessThan(SHELL_TOL);
    for (const y of yOf(cr, 'botTongue')) expect(Math.abs(y)).toBeLessThan(SHELL_TOL);
    // STE: BOTH tongues hug the back face (y=D).
    for (const y of yOf(cs, 'topTongue')) expect(Math.abs(y - D)).toBeLessThan(SHELL_TOL);
    for (const y of yOf(cs, 'botTongue')) expect(Math.abs(y - D)).toBeLessThan(SHELL_TOL);
  });

  it('fold SEQUENCE: walls final by their window end; tongues coplanar with their closure until 0.8', () => {
    const panels = rte.foldMeshData.panels;
    const atEnd = computeFoldWorldCorners(panels, 1);
    const atWallsEnd = computeFoldWorldCorners(panels, TUCK_SEQUENCE.walls[1]);
    for (const wi of [1, 2, 3, 4]) {   // right/back/left/glueTab already at their final pose
      atWallsEnd[wi].forEach((c, k) => {
        for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - atEnd[wi][k][d])).toBeLessThan(EPS);
      });
    }
    // Until the tongue window opens the tongue has NOT rotated relative to its closure: the
    // closure plane's normal dotted with every tongue-corner offset stays ~0 (coplanar).
    for (const t of [0.25, 0.5, 0.7, TUCK_SEQUENCE.tongue[0]]) {
      const corners = computeFoldWorldCorners(panels, t);
      for (const [closeId, tongueId] of [['topClose', 'topTongue'], ['botClose', 'botTongue']] as const) {
        const cc = corners[idx(panels, closeId)];
        const tc = corners[idx(panels, tongueId)];
        const e1 = [cc[1][0] - cc[0][0], cc[1][1] - cc[0][1], cc[1][2] - cc[0][2]];
        const e2 = [cc[3][0] - cc[0][0], cc[3][1] - cc[0][1], cc[3][2] - cc[0][2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(n[0], n[1], n[2]);
        for (const c of tc) {
          const dist = ((c[0] - cc[0][0]) * n[0] + (c[1] - cc[0][1]) * n[1] + (c[2] - cc[0][2]) * n[2]) / nl;
          expect(Math.abs(dist), `tongue ${tongueId} off its closure plane at t=${t}`).toBeLessThan(EPS);
        }
      }
    }
  });

  for (const [name, r] of [['reverse', rte], ['straight', ste]] as const) {
    it(`${name}: NO panel interpenetration beyond board-zero tolerance at t = 0.25/0.5/0.75/1`, () => {
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const corners = computeFoldWorldCorners(r.foldMeshData.panels, t);
        expectNoInterpenetration(corners, r.foldMeshData.panels, `${name} t=${t}`);
      }
    });
  }

  it('hierarchy == compileFoldMesh at sampled folds (the windowed identity)', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const oracle = computeFoldWorldCorners(rte.foldMeshData.panels, t);
      const verts = compileFoldMesh(rte.foldMeshData, t).vertices;
      let v = 0;
      rte.foldMeshData.panels.forEach((p, pi) => {
        for (let k = 0; k < p.corners.length; k++) {
          for (let c = 0; c < 3; c++) expect(verts[v * 8 + c]).toBeCloseTo(oracle[pi][k][c], 4);
          v++;
        }
      });
    }
  });
});

describe('tuckEnd dieline ↔ mesh consistency', () => {
  it('panel UVs are the net mapping (uv·canvas == px corners) — EXCEPT the glue tab (margin strip)', () => {
    for (const r of [rte, ste]) {
      // Reconstruct each panel's px corners from the 'panel' outline guide (pushed in panel order,
      // one segment per edge; segment start = the corner).
      const outline = r.guides.find(g => g.type === 'panel' && !g.label)!;
      let seg = 0;
      for (const p of r.foldMeshData.panels) {
        for (let k = 0; k < p.corners.length; k++) {
          const [pxX, pxY] = outline.segments[seg++][0];
          const [u, v] = p.uvs[k];
          if (p.id === 'glueTab') {
            expect(u).toBeGreaterThan(0.98);   // remapped into the right-edge margin strip
          } else {
            expect(u * r.canvasWidth).toBeCloseTo(pxX, 6);
            expect(v * r.canvasHeight).toBeCloseTo(pxY, 6);
          }
        }
      }
      // The glue tab strip still has real UV area (finite tangents).
      const tab = r.foldMeshData.panels[idx(r.foldMeshData.panels, 'glueTab')];
      const us = tab.uvs.map(q => q[0]);
      expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(1e-4);
    }
  });

  it('the cut set spans the full net extents (the perimeter reaches every canvas edge)', () => {
    const cut = rte.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    const ys = cut.segments.flatMap(s => [s[0][1], s[1][1]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(rte.canvasWidth - 1.5);
    expect(Math.min(...ys)).toBeLessThan(1.5);
    expect(Math.max(...ys)).toBeGreaterThan(rte.canvasHeight - 1.5);
  });
});

describe('tuckEnd through REAL scene-graph nodes', () => {
  const UNIT = 0.02;

  for (const amount of [0, 0.5, 1]) {
    it(`real-node world corners match the oracle at fold=${amount}`, () => {
      const { host, meshes } = makeRealNodeHost();
      const box = buildBoxNodes(rte.foldMeshData.panels, host, { scale: UNIT });
      setBoxFold(box, amount, host);
      const expected = computeFoldWorldCorners(rte.foldMeshData.panels, amount);
      box.panels.forEach((p, i) => {
        const actual = realWorldCorners(meshes.get(p.meshId)!);
        expect(actual.length).toBe(expected[i].length);
        actual.forEach((c, k) => {
          for (let d = 0; d < 3; d++) {
            expect(Math.abs(c[d] - expected[i][k][d] * UNIT),
              `panel ${i} (${rte.foldMeshData.panels[i].id}) corner ${k} axis ${d} (fold ${amount})`,
            ).toBeLessThan(1e-4);
          }
        });
      });
    });
  }

  it('hinge coincidence (no gaps) at fold 0 / 0.5 / 0.85 / 1', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(rte.foldMeshData.panels, host, { scale: UNIT });
    for (const amt of [0, 0.5, 0.85, 1]) {
      setBoxFold(box, amt, host);
      expectHingeCoincidence(rte.foldMeshData.panels, box, meshes, UNIT, `fold ${amt}`);
    }
  });

  it('IN-PLACE re-dimension (same style): corners track the new dims, no hinge gaps', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(rte.foldMeshData.panels, host, { scale: UNIT });
    setBoxFold(box, 0.6, host);
    const next = tuckEnd({ width: 110, height: 45, depth: 55 }).foldMeshData.panels;
    expect(updateBoxDimensions(box, next, host, { scale: UNIT })).toBe(true);
    for (const amt of [0.6, 1]) {
      setBoxFold(box, amt, host);
      const expected = computeFoldWorldCorners(next, amt);
      box.panels.forEach((p, i) => {
        realWorldCorners(meshes.get(p.meshId)!).forEach((c, k) => {
          for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - expected[i][k][d] * UNIT)).toBeLessThan(1e-4);
        });
      });
      expectHingeCoincidence(next, box, meshes, UNIT, `after resize, fold ${amt}`);
    }
  });
});
