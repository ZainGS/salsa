/**
 * fold-sequencing.test.ts — the PER-PANEL PHASE WINDOW contract (packaging-templates.md §2
 * "contract additions"): setBoxFold / computeFoldWorldCorners / compileFoldMesh all map the
 * global fold amount → each panel's local progress through its `foldWindow`, and NO window is
 * bit-for-bit the pre-sequencing behaviour (simpleBox unchanged).
 */

import { describe, it, expect } from 'vitest';
import { windowedProgress, computeFoldWorldCorners, buildBoxNodes, setBoxFold } from './box-hierarchy';
import { compileFoldMesh } from './fold-mesh';
import { simpleBox } from './templates/simple-box';
import type { FoldPanel, FoldMeshData } from './types';

type P2 = [number, number];

/** Root square + one wall hinged on its far edge, with an optional fold window. */
function twoPanelNet(window?: [number, number]): FoldPanel[] {
  const rect = (x0: number, x1: number): P2[] => [[x0, -5], [x1, -5], [x1, 5], [x0, 5]];
  const uv = (c: P2): P2 => [(c[0] + 10) / 30, (c[1] + 5) / 10];
  const root: FoldPanel = {
    id: 'root', name: 'Root', corners: rect(-10, 10), uvs: rect(-10, 10).map(uv),
    parentPanelIndex: -1, hinge: null, targetAngle: 0,
  };
  const wall: FoldPanel = {
    id: 'wall', name: 'Wall', corners: rect(10, 20), uvs: rect(10, 20).map(uv),
    parentPanelIndex: 0, hinge: [[10, -5], [10, 5]], targetAngle: 90,
    ...(window ? { foldWindow: window } : {}),
  };
  return [root, wall];
}

describe('windowedProgress', () => {
  it('no window = identity (the pre-sequencing behaviour)', () => {
    for (const t of [0, 0.1, 0.37, 0.5, 0.99, 1]) expect(windowedProgress(t)).toBe(t);
  });

  it('maps the global amount into the [start,end] window, clamped 0..1', () => {
    const w: [number, number] = [0.4, 0.8];
    expect(windowedProgress(0, w)).toBe(0);
    expect(windowedProgress(0.4, w)).toBe(0);
    expect(windowedProgress(0.6, w)).toBeCloseTo(0.5, 12);
    expect(windowedProgress(0.8, w)).toBe(1);
    expect(windowedProgress(1, w)).toBe(1);
  });

  it('degenerate window (end ≤ start) is a step at end', () => {
    const w: [number, number] = [0.5, 0.5];
    expect(windowedProgress(0.49, w)).toBe(0);
    expect(windowedProgress(0.5, w)).toBe(1);
    expect(windowedProgress(1, w)).toBe(1);
  });
});

describe('windowed fold through the oracle + the reference compiler', () => {
  it('a [0.5,1]-windowed wall stays FLAT until t=0.5, then folds over the second half', () => {
    const panels = twoPanelNet([0.5, 1]);
    // t=0.5: still flat (all y ≈ 0).
    for (const c of computeFoldWorldCorners(panels, 0.5)[1]) expect(Math.abs(c[1])).toBeLessThan(1e-9);
    // t=0.75: half folded (45°) — the far edge is lifted to 10·sin45 with x at 10 + 10·cos45.
    const half = computeFoldWorldCorners(panels, 0.75)[1];
    const lifted = half.filter(c => Math.abs(c[0] - (10 + 10 * Math.SQRT1_2)) < 1e-6);
    expect(lifted.length).toBe(2);
    for (const c of lifted) expect(Math.abs(Math.abs(c[1]) - 10 * Math.SQRT1_2)).toBeLessThan(1e-6);
    // t=1: fully folded (90°) — far edge directly above/below the hinge.
    const full = computeFoldWorldCorners(panels, 1)[1];
    for (const c of full) {
      expect(Math.abs(c[0] - 10)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(c[1]) === 0 ? 0 : Math.abs(c[1]) - 10)).toBeLessThan(1e-6);
    }
  });

  it('compileFoldMesh applies the SAME windowing as computeFoldWorldCorners', () => {
    const panels = twoPanelNet([0.3, 0.6]);
    const data: FoldMeshData = { panels, dielineWidth: 30, dielineHeight: 10 };
    for (const t of [0, 0.3, 0.45, 0.6, 0.8, 1]) {
      const oracle = computeFoldWorldCorners(panels, t);
      const verts = compileFoldMesh(data, t).vertices;
      let v = 0;
      for (let p = 0; p < panels.length; p++) {
        for (let k = 0; k < panels[p].corners.length; k++) {
          for (let c = 0; c < 3; c++) {
            expect(verts[v * 8 + c]).toBeCloseTo(oracle[p][k][c], 6);
          }
          v++;
        }
      }
    }
  });

  it('setBoxFold drives the same windowed angles through a host', () => {
    const panels = twoPanelNet([0.5, 1]);
    const transforms = new Map<string, { rotX?: number }>();
    let n = 0;
    const host = {
      createGroup: () => `g${n++}`,
      createPanelMesh: () => `m${n++}`,
      setNodeTransform: (id: string, t: { rotX?: number }) => { transforms.set(id, t); },
      removeNode: () => {},
    };
    const box = buildBoxNodes(panels, host);
    const wallPivot = box.panels[1].pivotNodeId;
    setBoxFold(box, 0.5, host);
    expect(transforms.get(wallPivot)?.rotX ?? 0).toBeCloseTo(0, 12);          // window not started
    setBoxFold(box, 0.75, host);
    expect(transforms.get(wallPivot)?.rotX ?? 0).toBeCloseTo(Math.PI / 4, 12); // halfway through window
    setBoxFold(box, 1, host);
    expect(transforms.get(wallPivot)?.rotX ?? 0).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('no-window regression: simpleBox fold math is unchanged', () => {
  it('simpleBox emits NO foldWindow and its oracle output equals the unwindowed closed form', () => {
    const { foldMeshData } = simpleBox({ width: 80, height: 60, depth: 40 });
    for (const p of foldMeshData.panels) expect(p.foldWindow).toBeUndefined();
    // At fold 0.5 every wall must be at exactly 45° — the global amount applied DIRECTLY.
    const corners = computeFoldWorldCorners(foldMeshData.panels, 0.5);
    const front = corners[1];   // front wall: hinge at z=D/2, folds up
    const far = front.filter(c => Math.abs(c[1]) > 1e-9);
    expect(far.length).toBe(2);
    for (const c of far) expect(Math.abs(c[1] - 60 * Math.SQRT1_2)).toBeLessThan(1e-6);
  });
});
