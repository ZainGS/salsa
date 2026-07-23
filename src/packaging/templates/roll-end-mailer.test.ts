/**
 * roll-end-mailer.test.ts — the CORRECTNESS GATE for the rollEndMailer template (M4 + M1 lip).
 *
 * Closed-form (computeFoldWorldCorners) + REAL-node runtime checks (the Round-A pattern):
 *  - fold 0 = flat net; fold 1 = an exact W×D×H shell from base/back/front/side walls + lid,
 *  - the ROLL: side inner plies end COPLANAR against their outer walls (|x| = W/2),
 *  - the lip ends coplanar against the front (z = H/2); lock tabs end in the side planes,
 *  - `lockTabs` topology (11 vs 9 panels); `restOpenAmount` leaves the lid ajar at fold 1,
 *  - fold SEQUENCE: tray (outers → rolls) → front + locks → lid → lip LAST,
 *  - NO proper interpenetration (board-zero tolerance) at t = 0.25/0.5/0.75/1,
 *  - hierarchy == compileFoldMesh at sampled folds,
 *  - dieline↔mesh sync (UV == outline px, cut extents == canvas, lip shoulder slits),
 *  - real nodes: world corners match the oracle, hinge coincidence, in-place re-dimension.
 */

import { describe, it, expect } from 'vitest';
import { rollEndMailer } from './roll-end-mailer';
import { compileFoldMesh } from '../fold-mesh';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold, updateBoxDimensions } from '../box-hierarchy';
import { ROLL_SEQUENCE } from '../mechanisms';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence, expectNoInterpenetration } from '../test-utils';
import type { FoldPanel } from '../types';

const W = 80, H = 60, D = 40;
const EPS = 1e-4;
const SHELL_TOL = 1e-3;

const std = rollEndMailer({ width: W, height: H, depth: D });                    // lockTabs default true
const noLocks = rollEndMailer({ width: W, height: H, depth: D, lockTabs: false });

const idx = (panels: FoldPanel[], id: string): number => panels.findIndex(p => p.id === id);

describe('rollEndMailer net structure', () => {
  it('11 panels with lock tabs (default), 9 without — labels complete', () => {
    expect(std.foldMeshData.panels.map(p => p.id)).toEqual([
      'base', 'back', 'lid', 'lidLip', 'front', 'lockA', 'lockB',
      'leftWall', 'leftRoll', 'rightWall', 'rightRoll']);
    expect(noLocks.foldMeshData.panels.map(p => p.id)).toEqual([
      'base', 'back', 'lid', 'lidLip', 'front',
      'leftWall', 'leftRoll', 'rightWall', 'rightRoll']);
    for (const r of [std, noLocks]) {
      for (const p of r.foldMeshData.panels) expect(r.panelLabels[p.id]).toBeTruthy();
    }
  });

  it('the ROLL: inner plies target ±180° (2 chained hinges: 90° wall + 180°-relative roll)', () => {
    const p = std.foldMeshData.panels;
    for (const id of ['leftRoll', 'rightRoll']) expect(Math.abs(p[idx(p, id)].targetAngle)).toBe(180);
    for (const id of ['leftWall', 'rightWall', 'back', 'front']) expect(Math.abs(p[idx(p, id)].targetAngle)).toBe(90);
  });

  it('fold windows follow ROLL_SEQUENCE: outers → rolls → front + locks → lid → lip', () => {
    const p = std.foldMeshData.panels;
    for (const id of ['back', 'leftWall', 'rightWall']) expect(p[idx(p, id)].foldWindow).toEqual(ROLL_SEQUENCE.outer);
    for (const id of ['leftRoll', 'rightRoll']) expect(p[idx(p, id)].foldWindow).toEqual(ROLL_SEQUENCE.roll);
    expect(p[idx(p, 'front')].foldWindow).toEqual(ROLL_SEQUENCE.front);
    for (const id of ['lockA', 'lockB']) expect(p[idx(p, id)].foldWindow).toEqual(ROLL_SEQUENCE.lock);
    expect(p[idx(p, 'lid')].foldWindow).toEqual(ROLL_SEQUENCE.lid);
    expect(p[idx(p, 'lidLip')].foldWindow).toEqual(ROLL_SEQUENCE.lip);
  });

  it('guides: slit (lip shoulders ×2) + cut/fold/panel/bleed present', () => {
    const types = new Set(std.guides.map(g => g.type));
    for (const t of ['cut', 'fold', 'panel', 'bleed', 'slit']) expect(types.has(t as never)).toBe(true);
    const slitSegs = std.guides.filter(g => g.type === 'slit').flatMap(g => g.segments);
    expect(slitSegs.length).toBe(2);
  });
});

describe('rollEndMailer fold geometry (closed form)', () => {
  it('fold 0: the whole net is flat (y ≈ 0)', () => {
    for (const panel of computeFoldWorldCorners(std.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
  });

  for (const [name, r] of [['lockTabs', std], ['no lockTabs', noLocks]] as const) {
    it(`${name}: fold 1 closes into a W×D×H shell; EVERY panel ends inside it (plies coplanar-allowed)`, () => {
      const panels = r.foldMeshData.panels;
      const corners = computeFoldWorldCorners(panels, 1);
      // The shell from base + back + front + side outer walls + lid.
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const id of ['base', 'back', 'front', 'leftWall', 'rightWall', 'lid']) {
        for (const c of corners[idx(panels, id)]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
      }
      expect(max[0] - min[0]).toBeCloseTo(W, 3);
      expect(max[1] - min[1]).toBeCloseTo(D, 3);
      expect(max[2] - min[2]).toBeCloseTo(H, 3);
      expect(min[0]).toBeCloseTo(-W / 2, 3); expect(min[1]).toBeCloseTo(0, 3); expect(min[2]).toBeCloseTo(-H / 2, 3);
      // EVERY panel (rolls, lip, locks) ends INSIDE the shell (coplanar plies on the boundary OK).
      corners.forEach((panel, i) => {
        for (const c of panel) {
          expect(c[0], `panel ${panels[i].id} x`).toBeGreaterThan(-W / 2 - SHELL_TOL);
          expect(c[0]).toBeLessThan(W / 2 + SHELL_TOL);
          expect(c[1], `panel ${panels[i].id} y`).toBeGreaterThan(-SHELL_TOL);
          expect(c[1]).toBeLessThan(D + SHELL_TOL);
          expect(c[2], `panel ${panels[i].id} z`).toBeGreaterThan(-H / 2 - SHELL_TOL);
          expect(c[2]).toBeLessThan(H / 2 + SHELL_TOL);
        }
      });
    });
  }

  it('the ROLL at fold 1: inner plies hang back down COPLANAR against their outer walls', () => {
    const panels = std.foldMeshData.panels;
    const corners = computeFoldWorldCorners(panels, 1);
    for (const [id, wallX] of [['leftRoll', -W / 2], ['rightRoll', W / 2]] as const) {
      for (const c of corners[idx(panels, id)]) {
        expect(Math.abs(c[0] - wallX), `${id} coplanar with its outer wall`).toBeLessThan(SHELL_TOL);
        expect(c[1]).toBeGreaterThan(-SHELL_TOL);        // inside, hanging down from the rim
        expect(c[1]).toBeLessThan(D + SHELL_TOL);
      }
    }
  });

  it('lid + lip at fold 1: lid covers the top (y = D), lip coplanar against the front (z = H/2)', () => {
    const panels = std.foldMeshData.panels;
    const corners = computeFoldWorldCorners(panels, 1);
    for (const c of corners[idx(panels, 'lid')]) expect(Math.abs(c[1] - D)).toBeLessThan(SHELL_TOL);
    for (const c of corners[idx(panels, 'lidLip')]) expect(Math.abs(c[2] - H / 2)).toBeLessThan(SHELL_TOL);
    // Lock tabs end in the side wall planes (|x| = W/2).
    for (const id of ['lockA', 'lockB']) {
      for (const c of corners[idx(panels, id)]) expect(Math.abs(Math.abs(c[0]) - W / 2), `${id}`).toBeLessThan(SHELL_TOL);
    }
  });

  it('restOpenAmount leaves the lid ajar at fold 1 (default 0 = fully closed)', () => {
    const ajar = rollEndMailer({ width: W, height: H, depth: D, restOpenAmount: 0.3 });
    const panels = ajar.foldMeshData.panels;
    const corners = computeFoldWorldCorners(panels, 1);
    // The lid's free (far) edge rises above the shell instead of lying flat at y = D.
    const lidY = corners[idx(panels, 'lid')].map(c => c[1]);
    expect(Math.max(...lidY)).toBeGreaterThan(D + 5);
    // Same topology as the closed variant → the in-place fast path applies (ids + parents equal).
    expect(panels.map(p => p.id)).toEqual(std.foldMeshData.panels.map(p => p.id));
    expect(panels.map(p => p.parentPanelIndex)).toEqual(std.foldMeshData.panels.map(p => p.parentPanelIndex));
  });

  it('fold SEQUENCE: tray done by the roll window end; front flat until its window; lid rides the back plane until 0.72', () => {
    const panels = std.foldMeshData.panels;
    const atEnd = computeFoldWorldCorners(panels, 1);
    const atTrayEnd = computeFoldWorldCorners(panels, ROLL_SEQUENCE.roll[1]);
    for (const id of ['back', 'leftWall', 'rightWall', 'leftRoll', 'rightRoll']) {
      const i = idx(panels, id);
      atTrayEnd[i].forEach((c, k) => {
        for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - atEnd[i][k][d]), `${id} final by tray end`).toBeLessThan(EPS);
      });
    }
    // Front (and its locks) still flat in the base plane when its window opens.
    const atFrontStart = computeFoldWorldCorners(panels, ROLL_SEQUENCE.front[0]);
    for (const id of ['front', 'lockA', 'lockB']) {
      for (const c of atFrontStart[idx(panels, id)]) expect(Math.abs(c[1]), `${id} flat at front-window start`).toBeLessThan(EPS);
    }
    // Lid (and lip) still in the back wall's plane (z = −H/2) when the lid window opens.
    const atLidStart = computeFoldWorldCorners(panels, ROLL_SEQUENCE.lid[0]);
    for (const id of ['lid', 'lidLip']) {
      for (const c of atLidStart[idx(panels, id)]) expect(Math.abs(c[2] + H / 2), `${id} on the back plane at lid-window start`).toBeLessThan(EPS);
    }
  });

  for (const [name, r] of [['lockTabs', std], ['no lockTabs', noLocks]] as const) {
    it(`${name}: NO panel interpenetration beyond board-zero tolerance at t = 0.25/0.5/0.75/1`, () => {
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const corners = computeFoldWorldCorners(r.foldMeshData.panels, t);
        expectNoInterpenetration(corners, r.foldMeshData.panels, `${name} t=${t}`);
      }
    });
  }

  it('hierarchy == compileFoldMesh at sampled folds', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const oracle = computeFoldWorldCorners(std.foldMeshData.panels, t);
      const verts = compileFoldMesh(std.foldMeshData, t).vertices;
      let v = 0;
      std.foldMeshData.panels.forEach((p, pi) => {
        for (let k = 0; k < p.corners.length; k++) {
          for (let c = 0; c < 3; c++) expect(verts[v * 8 + c]).toBeCloseTo(oracle[pi][k][c], 4);
          v++;
        }
      });
    }
  });
});

describe('rollEndMailer dieline ↔ mesh consistency', () => {
  it('every panel UV is the net mapping (uv·canvas == outline px corners — no excluded panels)', () => {
    const outline = std.guides.find(g => g.type === 'panel' && !g.label)!;
    let seg = 0;
    for (const p of std.foldMeshData.panels) {
      for (let k = 0; k < p.corners.length; k++) {
        const [pxX, pxY] = outline.segments[seg++][0];
        expect(p.uvs[k][0] * std.canvasWidth).toBeCloseTo(pxX, 6);
        expect(p.uvs[k][1] * std.canvasHeight).toBeCloseTo(pxY, 6);
      }
    }
  });

  it('the cut set spans the full net extents (the perimeter reaches every canvas edge)', () => {
    const cut = std.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    const ys = cut.segments.flatMap(s => [s[0][1], s[1][1]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(std.canvasWidth - 1.5);
    expect(Math.min(...ys)).toBeLessThan(1.5);
    expect(Math.max(...ys)).toBeGreaterThan(std.canvasHeight - 1.5);
  });
});

describe('rollEndMailer through REAL scene-graph nodes', () => {
  const UNIT = 0.02;

  for (const amount of [0, 0.5, 1]) {
    it(`real-node world corners match the oracle at fold=${amount}`, () => {
      const { host, meshes } = makeRealNodeHost();
      const box = buildBoxNodes(std.foldMeshData.panels, host, { scale: UNIT });
      setBoxFold(box, amount, host);
      const expected = computeFoldWorldCorners(std.foldMeshData.panels, amount);
      box.panels.forEach((p, i) => {
        const actual = realWorldCorners(meshes.get(p.meshId)!);
        expect(actual.length).toBe(expected[i].length);
        actual.forEach((c, k) => {
          for (let d = 0; d < 3; d++) {
            expect(Math.abs(c[d] - expected[i][k][d] * UNIT),
              `panel ${i} (${std.foldMeshData.panels[i].id}) corner ${k} axis ${d} (fold ${amount})`,
            ).toBeLessThan(1e-4);
          }
        });
      });
    });
  }

  it('hinge coincidence (no gaps) at fold 0 / 0.4 / 0.8 / 1', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(std.foldMeshData.panels, host, { scale: UNIT });
    for (const amt of [0, 0.4, 0.8, 1]) {
      setBoxFold(box, amt, host);
      expectHingeCoincidence(std.foldMeshData.panels, box, meshes, UNIT, `fold ${amt}`);
    }
  });

  it('IN-PLACE re-dimension (same topology): corners track the new dims, no hinge gaps', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(std.foldMeshData.panels, host, { scale: UNIT });
    setBoxFold(box, 0.6, host);
    const next = rollEndMailer({ width: 110, height: 45, depth: 55, restOpenAmount: 0.2 }).foldMeshData.panels;
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
