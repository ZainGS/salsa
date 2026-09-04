/**
 * src/packaging/templates/cd-booklet.ts
 *
 * The CD jewel-case BOOKLET (the folded insert / liner notes). MVP = the outer sheet of a 4-page booklet:
 * two 120 × 120 mm leaves on one 240 × 120 flat sheet, folding along the centre spine like a card. Left
 * leaf = back cover (root, stays flat); right leaf = front cover, hinged on the spine so the scrub opens/
 * closes the book (fold 0 = flat spread, fold 1 = the leaves folded to a right angle — a standing book).
 * A full N-page saddle-stitch booklet (multiples of 4) is a later phase. Dimensions FIXED; params tune
 * bleed / dpi.
 *
 *   flat sheet (x→right, z→height):   ┌──── back ────┐┌──── front ───┐
 *                                     │   (left)     ││   (right)    │
 *                                     └──────────────┘└──────────────┘
 *                                                    ↑ spine fold
 */

import type { DielineParams, DielineResult, FoldPanel, FoldMeshData, DielineGuide } from '../types';
import { foldUpAngle } from '../mechanisms';

type P2 = [number, number];

/** Standard CD booklet metrics (mm): two square leaves. */
export const CD_BOOKLET = { leaf: 120 } as const;

export function cdBooklet(params: DielineParams): DielineResult {
  const S = CD_BOOKLET.leaf;
  const halfH = S / 2;
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;

  // Flat: back leaf x∈[-S,0], front leaf x∈[0,S]; height z∈[-S/2,S/2]. Spine at x=0.
  const minX = -S, maxX = S, minZ = -halfH, maxZ = halfH;
  const netW = 2 * S, netH = S;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const uv = (x: number, z: number): P2 => [(x - minX) / netW, (z - minZ) / netH];
  const px = (x: number, z: number): P2 => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight];

  const panel = (id: string, name: string, corners: P2[], parentPanelIndex: number, hinge: [P2, P2] | null): FoldPanel => ({
    id, name, corners,
    uvs: corners.map(c => uv(c[0], c[1])),
    parentPanelIndex, hinge,
    targetAngle: hinge ? foldUpAngle(hinge, corners) : 0,
  });

  const back = panel('back', 'Back Cover',
    [[-S, -halfH], [0, -halfH], [0, halfH], [-S, halfH]], -1, null);
  const front = panel('front', 'Front Cover',
    [[0, -halfH], [0, halfH], [S, halfH], [S, -halfH]], 0, [[0, -halfH], [0, halfH]]);

  const panels = [back, front];
  const foldMeshData: FoldMeshData = { panels, dielineWidth: netW, dielineHeight: netH };

  const guides: DielineGuide[] = [];
  const panelSegs: [P2, P2][] = [];
  for (const p of panels) for (let i = 0; i < p.corners.length; i++) {
    const a = p.corners[i], b = p.corners[(i + 1) % p.corners.length];
    panelSegs.push([px(a[0], a[1]), px(b[0], b[1])]);
  }
  guides.push({ type: 'panel', segments: panelSegs, color: '#c8c8c8' });
  const cut: P2[] = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
  guides.push({ type: 'cut', segments: cut.map((a, i) => [px(a[0], a[1]), px(cut[(i + 1) % cut.length][0], cut[(i + 1) % cut.length][1])] as [P2, P2]), color: '#222222' });
  guides.push({ type: 'fold', segments: [[px(0, -halfH), px(0, halfH)]], color: '#00aaff' });   // the spine
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

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: { back: 'Back Cover', front: 'Front Cover' } };
}
