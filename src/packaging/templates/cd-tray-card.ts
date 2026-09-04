/**
 * src/packaging/templates/cd-tray-card.ts
 *
 * The CD jewel-case REAR TRAY CARD (inlay / "J-card") — the back artwork. Standard size 150 × 118 mm:
 * a central BACK panel (138 mm) plus two 6 mm SPINE flaps that fold forward 90° so the title reads on
 * the shelf edge. Unlike the fold-box templates this doesn't "close into a box" — folding the two spines
 * to 90° IS the assembled tray card, so fold 0 = flat printed sheet, fold 1 = seated in the case.
 *
 *   net (flat, x→right, z→height):   ┌ spine ┐┌──── back ────┐┌ spine ┐
 *                                    │   L   ││              ││   R   │
 *                                    └───────┘└──────────────┘└───────┘
 *
 * Dimensions are FIXED (print correctness is the point) — params only tune bleed/dpi.
 */

import type { DielineParams, DielineResult, FoldPanel, FoldMeshData, DielineGuide } from '../types';
import { foldUpAngle } from '../mechanisms';

type P2 = [number, number];

/** Standard CD rear tray-card metrics (mm). */
export const CD_TRAY_CARD = { totalW: 150, height: 118, spineW: 6 } as const;

export function cdTrayCard(params: DielineParams): DielineResult {
  const H = CD_TRAY_CARD.height;
  const spineW = CD_TRAY_CARD.spineW;
  const backW = CD_TRAY_CARD.totalW - 2 * spineW;   // 138
  const halfBack = backW / 2;
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;

  // Net bounds (mm), centred on the back panel.
  const minX = -halfBack - spineW, maxX = halfBack + spineW;   // ±75 → 150 wide
  const minZ = -H / 2, maxZ = H / 2;                            // 118 tall
  const netW = maxX - minX;
  const netH = maxZ - minZ;
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

  // Back panel is the root (stays flat); spines hinge on its left/right edges and fold forward.
  const back = panel('back', 'Back',
    [[-halfBack, -H / 2], [halfBack, -H / 2], [halfBack, H / 2], [-halfBack, H / 2]], -1, null);

  const spineL = panel('spineL', 'Spine L',
    [[-halfBack, -H / 2], [-halfBack, H / 2], [-halfBack - spineW, H / 2], [-halfBack - spineW, -H / 2]],
    0, [[-halfBack, -H / 2], [-halfBack, H / 2]]);

  const spineR = panel('spineR', 'Spine R',
    [[halfBack, -H / 2], [halfBack, H / 2], [halfBack + spineW, H / 2], [halfBack + spineW, -H / 2]],
    0, [[halfBack, -H / 2], [halfBack, H / 2]]);

  const panels = [back, spineL, spineR];
  const foldMeshData: FoldMeshData = { panels, dielineWidth: netW, dielineHeight: netH };

  const guides: DielineGuide[] = [];

  // Panel outlines (subtle).
  const panelSegs: [P2, P2][] = [];
  for (const p of panels) {
    for (let i = 0; i < p.corners.length; i++) {
      const a = p.corners[i], b = p.corners[(i + 1) % p.corners.length];
      panelSegs.push([px(a[0], a[1]), px(b[0], b[1])]);
    }
  }
  guides.push({ type: 'panel', segments: panelSegs, color: '#c8c8c8' });

  // Cut = the outer rectangle of the whole 150×118 net.
  const cut: P2[] = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
  guides.push({
    type: 'cut',
    segments: cut.map((a, i) => [px(a[0], a[1]), px(cut[(i + 1) % cut.length][0], cut[(i + 1) % cut.length][1])] as [P2, P2]),
    color: '#222222',
  });

  // Fold = the two spine hinges.
  guides.push({
    type: 'fold',
    segments: panels.filter(p => p.hinge).map(p => [px(p.hinge![0][0], p.hinge![0][1]), px(p.hinge![1][0], p.hinge![1][1])] as [P2, P2]),
    color: '#00aaff',
  });

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
    panelLabels: { back: 'Back', spineL: 'Spine L', spineR: 'Spine R' },
  };
}
