/**
 * src/packaging/templates/cd-front-insert.ts
 *
 * The CD jewel-case FRONT INSERT — the front cover art, the piece visible through the clear lid. The
 * simplest single-leaf insert: one flat 120 × 120 mm panel (no fold). Its reverse prints the inside-front.
 * (A multi-page booklet is a separate piece — see cd-booklet.ts.) Dimensions are FIXED for print
 * correctness; params only tune bleed / dpi.
 */

import type { DielineParams, DielineResult, FoldPanel, FoldMeshData, DielineGuide } from '../types';

type P2 = [number, number];

/** Standard CD front-insert metrics (mm) — a square leaf. */
export const CD_FRONT_INSERT = { size: 120 } as const;

export function cdFrontInsert(params: DielineParams): DielineResult {
  const S = CD_FRONT_INSERT.size;
  const half = S / 2;
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;

  const minX = -half, maxX = half, minZ = -half, maxZ = half;
  const netW = S, netH = S;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const uv = (x: number, z: number): P2 => [(x - minX) / netW, (z - minZ) / netH];
  const px = (x: number, z: number): P2 => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight];

  // One flat panel, the root — no hinge, no fold.
  const corners: P2[] = [[-half, -half], [half, -half], [half, half], [-half, half]];
  const front: FoldPanel = {
    id: 'front', name: 'Front', corners,
    uvs: corners.map(c => uv(c[0], c[1])),
    parentPanelIndex: -1, hinge: null, targetAngle: 0,
  };

  const foldMeshData: FoldMeshData = { panels: [front], dielineWidth: netW, dielineHeight: netH };

  const guides: DielineGuide[] = [];
  const rect = (pts: P2[]): [P2, P2][] => pts.map((a, i) => [px(a[0], a[1]), px(pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1])] as [P2, P2]);
  guides.push({ type: 'panel', segments: rect(corners), color: '#c8c8c8' });
  guides.push({ type: 'cut', segments: rect([[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]), color: '#222222' });
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

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: { front: 'Front' } };
}
