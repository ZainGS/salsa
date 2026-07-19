/**
 * src/packaging/templates/simple-box.ts
 *
 * The first dieline template: a basic closed box from a cruciform net —
 * base (root) + 4 walls folding up + a lid folding over the back wall. Parameterised
 * by W×H×D, exactly like body-generator(params). This is the "one box style folding
 * end-to-end" v1 target; tuck-end / mailer / sleeve come later (spec Phase 8).
 *
 *   net layout (flat, centred on the base, x→right, z→down-the-net):
 *
 *                 ┌────── lid ──────┐        (folds over the back wall)
 *                 ├──── back wall ──┤
 *        ┌ left ┐ ┌──── base ───────┐ ┌ right ┐
 *                 ├──── front wall ─┤
 */

import type { DielineParams, DielineResult, FoldPanel, FoldMeshData, DielineGuide } from '../types';

type P2 = [number, number];

/** Fully-folded angle (±90°) that folds this panel UP out of its parent's plane.
 *  Derived from the hinge direction × the outward direction so it's always correct. */
function foldUpAngle(hinge: [P2, P2], corners: P2[]): number {
  const a = hinge[0], b = hinge[1];
  const dx = b[0] - a[0], dz = b[1] - a[1];                 // hinge direction (x,z)
  const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let cx = 0, cz = 0;
  for (const c of corners) { cx += c[0]; cz += c[1]; }
  const ox = cx / corners.length - mid[0], oz = cz / corners.length - mid[1]; // toward the panel
  // (d × o).y for d=(dx,0,dz), o=(ox,0,oz)  →  dz·ox − dx·oz. >0 ⇒ +90 folds up, else −90.
  return (dz * ox - dx * oz) >= 0 ? 90 : -90;
}

export function simpleBox(params: DielineParams): DielineResult {
  const W = Math.max(1, params.width);
  const H = Math.max(1, params.height);
  const D = Math.max(1, params.depth);
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;

  // Net bounds (mm), centred on the base centre.
  const minX = -W / 2 - H, maxX = W / 2 + H;
  const minZ = -D / 2 - H - D, maxZ = D / 2 + H;
  const netW = maxX - minX;   // W + 2H
  const netH = maxZ - minZ;   // 2D + 2H
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const uv = (x: number, z: number): P2 => [(x - minX) / netW, (z - minZ) / netH];
  const px = (x: number, z: number): P2 => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight];

  const panel = (
    id: string, name: string, corners: P2[],
    parentPanelIndex: number, hinge: [P2, P2] | null,
  ): FoldPanel => ({
    id, name, corners,
    uvs: corners.map(c => uv(c[0], c[1])),
    parentPanelIndex, hinge,
    targetAngle: hinge ? foldUpAngle(hinge, corners) : 0,
  });

  // Panel rectangles (CCW). Indices: base 0, front 1, back 2, left 3, right 4, lid 5.
  const base = panel('base', 'Base',
    [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]], -1, null);

  const front = panel('front', 'Front',
    [[-W / 2, D / 2], [W / 2, D / 2], [W / 2, D / 2 + H], [-W / 2, D / 2 + H]],
    0, [[-W / 2, D / 2], [W / 2, D / 2]]);

  const back = panel('back', 'Back',
    [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, -D / 2 - H], [-W / 2, -D / 2 - H]],
    0, [[-W / 2, -D / 2], [W / 2, -D / 2]]);

  const left = panel('left', 'Left',
    [[-W / 2, -D / 2], [-W / 2, D / 2], [-W / 2 - H, D / 2], [-W / 2 - H, -D / 2]],
    0, [[-W / 2, -D / 2], [-W / 2, D / 2]]);

  const right = panel('right', 'Right',
    [[W / 2, -D / 2], [W / 2, D / 2], [W / 2 + H, D / 2], [W / 2 + H, -D / 2]],
    0, [[W / 2, -D / 2], [W / 2, D / 2]]);

  // Lid hangs off the BACK wall's far edge and folds over to close the box.
  const lid = panel('lid', 'Lid',
    [[-W / 2, -D / 2 - H], [W / 2, -D / 2 - H], [W / 2, -D / 2 - H - D], [-W / 2, -D / 2 - H - D]],
    2, [[-W / 2, -D / 2 - H], [W / 2, -D / 2 - H]]);

  const panels = [base, front, back, left, right, lid];
  const foldMeshData: FoldMeshData = { panels, dielineWidth: netW, dielineHeight: netH };

  // Guides: fold lines (the hinges) + a bleed rect. (Cut lines = panel perimeters; deferred.)
  const guides: DielineGuide[] = [];
  const foldSegs: [P2, P2][] = panels
    .filter(p => p.hinge)
    .map(p => [px(p.hinge![0][0], p.hinge![0][1]), px(p.hinge![1][0], p.hinge![1][1])]);
  guides.push({ type: 'fold', segments: foldSegs, color: '#00aaff' });
  const bpx = bleed / 25.4 * dpi;
  guides.push({
    type: 'bleed',
    segments: [
      [[bpx, bpx], [canvasWidth - bpx, bpx]],
      [[canvasWidth - bpx, bpx], [canvasWidth - bpx, canvasHeight - bpx]],
      [[canvasWidth - bpx, canvasHeight - bpx], [bpx, canvasHeight - bpx]],
      [[bpx, canvasHeight - bpx], [bpx, bpx]],
    ],
    color: '#ff3399',
  });

  return {
    foldMeshData,
    canvasWidth,
    canvasHeight,
    guides,
    panelLabels: { base: 'Base', front: 'Front', back: 'Back', left: 'Left', right: 'Right', lid: 'Lid' },
  };
}
