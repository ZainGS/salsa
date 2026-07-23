/**
 * rigid-two-piece.test.ts — the CORRECTNESS GATE for the rigidTwoPiece template (M5).
 *
 * Closed-form + REAL-node checks (the Round-A pattern), plus the two NEW mechanisms:
 *  - TWO hinge hierarchies (two root panels) under one package; lid dims DERIVED from the base
 *    (+2×boardThickness clearance per axis — the 'derived panels' contract),
 *  - the LID TRANSLATE: `foldTranslate` segments on the lid root — stationary until 0.6, then
 *    lift → carry → seat; at fold 1 the lid is SEATED with the clearance gap EXACTLY
 *    boardThickness on every side and the lid top at y = D + boardThickness,
 *  - both trays fold their walls inside [0, 0.6]; `lidDepth` (shallow cap vs full telescope),
 *  - NO proper interpenetration at t = 0.25/0.5/0.75/1,
 *  - hierarchy == compileFoldMesh at sampled folds (the translate identity across ALL THREE
 *    implementations: setBoxFold / computeFoldWorldCorners / compileFoldMesh),
 *  - dieline: TWO nets on one canvas, non-overlapping with the gutter; UV == outline px,
 *  - real nodes: world corners (including mid-flight translate poses), hinge coincidence,
 *    in-place re-dimension on a lidDepth/boardThickness change.
 */

import { describe, it, expect } from 'vitest';
import { rigidTwoPiece, TELESCOPE_SEQUENCE, TWO_PIECE_GUTTER } from './rigid-two-piece';
import { compileFoldMesh } from '../fold-mesh';
import { computeFoldWorldCorners, buildBoxNodes, setBoxFold, updateBoxDimensions } from '../box-hierarchy';
import { makeRealNodeHost, realWorldCorners, expectHingeCoincidence, expectNoInterpenetration } from '../test-utils';
import type { FoldPanel } from '../types';

const W = 80, H = 60, D = 40, BT = 2;
const EPS = 1e-4;
const TOL = 1e-3;

const full = rigidTwoPiece({ width: W, height: H, depth: D });                       // full telescope, bt 2
const shallow = rigidTwoPiece({ width: W, height: H, depth: D, lidDepth: 15, boardThickness: 3 });

const idx = (panels: FoldPanel[], id: string): number => panels.findIndex(p => p.id === id);
const BASE_IDS = ['base', 'back', 'front', 'left', 'right'];
const LID_IDS = ['lid', 'lidBack', 'lidFront', 'lidLeft', 'lidRight'];

describe('rigidTwoPiece net structure (two hierarchies, derived lid)', () => {
  it('10 panels: base tray + lid tray, TWO roots, labels with the Lid prefix', () => {
    const p = full.foldMeshData.panels;
    expect(p.map(q => q.id)).toEqual([...BASE_IDS, ...LID_IDS]);
    expect(p[idx(p, 'base')].parentPanelIndex).toBe(-1);
    expect(p[idx(p, 'lid')].parentPanelIndex).toBe(-1);                              // second root
    expect(full.panelLabels['lid']).toBe('Lid');
    for (const id of ['lidFront', 'lidBack', 'lidLeft', 'lidRight']) {
      expect(full.panelLabels[id].startsWith('Lid ')).toBe(true);
    }
  });

  it('DERIVED lid dims: footprint = base outer + 2×boardThickness; lidDepth defaults to full telescope', () => {
    const p = full.foldMeshData.panels;
    const lid = p[idx(p, 'lid')];
    const xs = lid.corners.map(c => c[0]), zs = lid.corners.map(c => c[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(W + 2 * BT, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(H + 2 * BT, 6);
    // Wall depths: base walls D, lid walls D (full telescope default) / 15 (shallow).
    const wallDepth = (r: typeof full, id: string): number => {
      const w = r.foldMeshData.panels[idx(r.foldMeshData.panels, id)];
      const zz = w.corners.map(c => c[1]);
      return Math.max(...zz) - Math.min(...zz);
    };
    expect(wallDepth(full, 'front')).toBeCloseTo(D, 6);
    expect(wallDepth(full, 'lidFront')).toBeCloseTo(D, 6);
    expect(wallDepth(shallow, 'lidFront')).toBeCloseTo(15, 6);
  });

  it('the lid ROOT carries the foldTranslate segments (lift → carry → seat), all from 0 (flat-net invariant)', () => {
    const p = full.foldMeshData.panels;
    const segs = p[idx(p, 'lid')].foldTranslate!;
    expect(segs.length).toBe(3);
    for (const s of segs) expect(s.from).toBe(0);
    expect(segs[0].window).toEqual(TELESCOPE_SEQUENCE.lift);
    expect(segs[1].window).toEqual(TELESCOPE_SEQUENCE.carry);
    expect(segs[2].window).toEqual(TELESCOPE_SEQUENCE.seat);
    // No other panel translates; every wall folds inside the tray window.
    for (const q of p) {
      if (q.id !== 'lid') expect(q.foldTranslate).toBeUndefined();
      if (q.parentPanelIndex >= 0) expect(q.foldWindow).toEqual(TELESCOPE_SEQUENCE.tray);
    }
  });

  it('rigid-style net: corner cuts, NO glue tabs (wrapped, not glued) — no excluded-UV panels', () => {
    expect(full.foldMeshData.panels.some(p => p.id.toLowerCase().includes('glue'))).toBe(false);
    expect(full.guides.some(g => g.label === 'Glue Tab')).toBe(false);
  });
});

describe('rigidTwoPiece fold geometry (closed form)', () => {
  it('fold 0: BOTH nets flat (y ≈ 0) — the translate contributes nothing (from = 0)', () => {
    for (const panel of computeFoldWorldCorners(full.foldMeshData.panels, 0)) {
      for (const [, y] of panel) expect(Math.abs(y)).toBeLessThan(EPS);
    }
  });

  it('both trays fold their walls in [0, 0.6]; the lid root is STATIONARY until 0.6', () => {
    const panels = full.foldMeshData.panels;
    const atTrayEnd = computeFoldWorldCorners(panels, TELESCOPE_SEQUENCE.tray[1]);
    const atFlat = computeFoldWorldCorners(panels, 0);
    // Walls at their final RELATIVE pose by 0.6: base walls equal their t=1 pose (the base never
    // moves); the lid root's corners are still exactly at their flat-net position.
    const atEnd = computeFoldWorldCorners(panels, 1);
    for (const id of ['front', 'back', 'left', 'right']) {
      const i = idx(panels, id);
      atTrayEnd[i].forEach((c, k) => {
        for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - atEnd[i][k][d]), `${id} final by 0.6`).toBeLessThan(EPS);
      });
    }
    const li = idx(panels, 'lid');
    atTrayEnd[li].forEach((c, k) => {
      for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - atFlat[li][k][d]), 'lid stationary until 0.6').toBeLessThan(EPS);
    });
    // Lid walls folded DOWN by 0.6 (an opening-down cap: wall corners at or below the lid plane).
    for (const id of ['lidFront', 'lidBack', 'lidLeft', 'lidRight']) {
      for (const c of atTrayEnd[idx(panels, id)]) expect(c[1]).toBeLessThan(EPS);
    }
  });

  for (const [name, r, bt, ld] of [['full telescope', full, BT, D], ['shallow cap', shallow, 3, 15]] as const) {
    it(`${name}: fold 1 SEATS the lid — top at y = D + bt, walls exactly bt outside the base walls`, () => {
      const panels = r.foldMeshData.panels;
      const corners = computeFoldWorldCorners(panels, 1);
      // Base tray: the exact W×D×H open box.
      for (const c of corners[idx(panels, 'base')]) expect(Math.abs(c[1])).toBeLessThan(TOL);
      for (const c of corners[idx(panels, 'front')]) expect(Math.abs(c[2] - H / 2)).toBeLessThan(TOL);
      for (const c of corners[idx(panels, 'left')]) expect(Math.abs(c[0] + W / 2)).toBeLessThan(TOL);
      // Lid top seated at exactly y = D + bt, centred over the base.
      for (const c of corners[idx(panels, 'lid')]) {
        expect(Math.abs(c[1] - (D + bt)), 'lid top height').toBeLessThan(TOL);
        expect(Math.abs(c[0])).toBeLessThan(W / 2 + bt + TOL);
        expect(Math.abs(c[2])).toBeLessThan(H / 2 + bt + TOL);
      }
      // THE DERIVED CLEARANCE: each lid wall plane sits EXACTLY boardThickness outside its base wall.
      for (const [id, axis, wall] of [['lidLeft', 0, -(W / 2 + bt)], ['lidRight', 0, W / 2 + bt],
        ['lidBack', 2, -(H / 2 + bt)], ['lidFront', 2, H / 2 + bt]] as const) {
        for (const c of corners[idx(panels, id)]) {
          expect(Math.abs(c[axis] - wall), `${id} clearance = boardThickness`).toBeLessThan(TOL);
          // Wall depth: hangs from the seated top down by lidDepth.
          expect(c[1]).toBeGreaterThan(D + bt - ld - TOL);
          expect(c[1]).toBeLessThan(D + bt + TOL);
        }
      }
    });
  }

  for (const [name, r] of [['full telescope', full], ['shallow cap', shallow]] as const) {
    it(`${name}: NO panel interpenetration beyond board-zero tolerance at t = 0.25/0.5/0.75/1`, () => {
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const corners = computeFoldWorldCorners(r.foldMeshData.panels, t);
        expectNoInterpenetration(corners, r.foldMeshData.panels, `${name} t=${t}`);
      }
    });
  }

  it('mid-flight: the lid CLEARS the base walls during the carry (no sweep-through path)', () => {
    const panels = full.foldMeshData.panels;
    // Sample the whole carry window densely: every lid-wall corner stays above the base wall tops.
    for (let t = TELESCOPE_SEQUENCE.carry[0]; t <= TELESCOPE_SEQUENCE.carry[1] + 1e-9; t += 0.02) {
      const corners = computeFoldWorldCorners(panels, Math.min(t, 1));
      for (const id of ['lidFront', 'lidBack', 'lidLeft', 'lidRight']) {
        for (const c of corners[idx(panels, id)]) {
          expect(c[1], `${id} above the tray during carry (t=${t.toFixed(2)})`).toBeGreaterThan(D - EPS);
        }
      }
    }
  });

  it('hierarchy == compileFoldMesh at sampled folds (the TRANSLATE identity)', () => {
    for (const t of [0, 0.25, 0.5, 0.7, 0.85, 0.95, 1]) {
      const oracle = computeFoldWorldCorners(full.foldMeshData.panels, t);
      const verts = compileFoldMesh(full.foldMeshData, t).vertices;
      let v = 0;
      full.foldMeshData.panels.forEach((p, pi) => {
        for (let k = 0; k < p.corners.length; k++) {
          for (let c = 0; c < 3; c++) expect(verts[v * 8 + c]).toBeCloseTo(oracle[pi][k][c], 4);
          v++;
        }
      });
    }
  });
});

describe('rigidTwoPiece dieline ↔ mesh consistency (two nets, one canvas)', () => {
  it('every panel UV is the net mapping (uv·canvas == outline px corners) across BOTH nets', () => {
    const outline = full.guides.find(g => g.type === 'panel' && !g.label)!;
    let seg = 0;
    for (const p of full.foldMeshData.panels) {
      for (let k = 0; k < p.corners.length; k++) {
        const [pxX, pxY] = outline.segments[seg++][0];
        expect(p.uvs[k][0] * full.canvasWidth).toBeCloseTo(pxX, 6);
        expect(p.uvs[k][1] * full.canvasHeight).toBeCloseTo(pxY, 6);
      }
    }
  });

  it('the TWO nets are side by side, non-overlapping, separated by the gutter', () => {
    const panels = full.foldMeshData.panels;
    const netMaxX = (ids: readonly string[]): number =>
      Math.max(...ids.flatMap(id => panels[idx(panels, id)].corners.map(c => c[0])));
    const netMinX = (ids: readonly string[]): number =>
      Math.min(...ids.flatMap(id => panels[idx(panels, id)].corners.map(c => c[0])));
    const baseMax = netMaxX(BASE_IDS), lidMin = netMinX(LID_IDS);
    expect(lidMin - baseMax).toBeCloseTo(TWO_PIECE_GUTTER, 6);
    expect(lidMin).toBeGreaterThan(baseMax);
  });

  it('the cut set spans the full canvas (both nets reach the extents)', () => {
    const cut = full.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(s => [s[0][0], s[1][0]]);
    const ys = cut.segments.flatMap(s => [s[0][1], s[1][1]]);
    expect(Math.min(...xs)).toBeLessThan(1.5);
    expect(Math.max(...xs)).toBeGreaterThan(full.canvasWidth - 1.5);
    expect(Math.min(...ys)).toBeLessThan(1.5);
    expect(Math.max(...ys)).toBeGreaterThan(full.canvasHeight - 1.5);
  });
});

describe('rigidTwoPiece through REAL scene-graph nodes', () => {
  const UNIT = 0.02;

  for (const amount of [0, 0.5, 0.75, 0.85, 1]) {
    it(`real-node world corners match the oracle at fold=${amount} (translate through real nodes)`, () => {
      const { host, meshes } = makeRealNodeHost();
      const box = buildBoxNodes(full.foldMeshData.panels, host, { scale: UNIT });
      setBoxFold(box, amount, host);
      const expected = computeFoldWorldCorners(full.foldMeshData.panels, amount);
      box.panels.forEach((p, i) => {
        const actual = realWorldCorners(meshes.get(p.meshId)!);
        expect(actual.length).toBe(expected[i].length);
        actual.forEach((c, k) => {
          for (let d = 0; d < 3; d++) {
            expect(Math.abs(c[d] - expected[i][k][d] * UNIT),
              `panel ${i} (${full.foldMeshData.panels[i].id}) corner ${k} axis ${d} (fold ${amount})`,
            ).toBeLessThan(1e-4);
          }
        });
      });
    });
  }

  it('hinge coincidence (no gaps) at fold 0 / 0.6 / 0.85 / 1 — including the translated lid subtree', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(full.foldMeshData.panels, host, { scale: UNIT });
    for (const amt of [0, 0.6, 0.85, 1]) {
      setBoxFold(box, amt, host);
      expectHingeCoincidence(full.foldMeshData.panels, box, meshes, UNIT, `fold ${amt}`);
    }
  });

  it('IN-PLACE re-dimension (lidDepth + boardThickness are dims-only): corners track, no hinge gaps', () => {
    const { host, meshes } = makeRealNodeHost();
    const box = buildBoxNodes(full.foldMeshData.panels, host, { scale: UNIT });
    setBoxFold(box, 0.7, host);
    const next = rigidTwoPiece({ width: 100, height: 50, depth: 35, lidDepth: 12, boardThickness: 3 }).foldMeshData.panels;
    expect(updateBoxDimensions(box, next, host, { scale: UNIT })).toBe(true);
    for (const amt of [0.7, 1]) {
      setBoxFold(box, amt, host);
      const expected = computeFoldWorldCorners(next, amt);
      box.panels.forEach((p, i) => {
        realWorldCorners(meshes.get(p.meshId)!).forEach((c, k) => {
          for (let d = 0; d < 3; d++) expect(Math.abs(c[d] - expected[i][k][d] * UNIT)).toBeLessThan(1e-4);
        });
      });
      expectHingeCoincidence(next, box, meshes, UNIT, `after resize, fold ${amt}`);
    }
    // Seated check on the resized box: lid top at (35 + 3) mm × UNIT.
    setBoxFold(box, 1, host);
    const lidMesh = meshes.get(box.panels[idx(next, 'lid')].meshId)!;
    for (const c of realWorldCorners(lidMesh)) expect(Math.abs(c[1] - (35 + 3) * UNIT)).toBeLessThan(1e-4);
  });
});
