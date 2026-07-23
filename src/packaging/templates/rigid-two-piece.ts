/**
 * src/packaging/templates/rigid-two-piece.ts — the TWO-PIECE RIGID (set-up) BOX, M5.
 *
 * TWO hinge hierarchies under ONE package root: a BASE tray (4 walls up off a base panel) and a
 * LID tray whose dimensions are DERIVED from the base — the 'derived panels' contract
 * (packaging-templates.md §2): lid inner footprint = base outer + 2×`boardThickness` clearance
 * per axis, lid wall depth = `lidDepth` (default full telescope = the base wall height). The lid
 * tray's walls fold DOWN (an opening-down cap), and at [0.6, 1] the whole lid subgroup
 * TRANSLATES onto the base — `FoldPanel.foldTranslate` segments on the lid's ROOT panel, driven
 * by the SAME windowedProgress scalar as every hinge (translation, not rotation): lift → carry
 * over → drop on, so the lid never sweeps through the base tray. At fold 1 the lid is SEATED:
 * its top at y = D + boardThickness and each lid wall exactly `boardThickness` outside the
 * matching base wall (the derived clearance gap).
 *
 *   dieline: TWO nets side by side on one canvas with a gutter (both trays paint from the one
 *   layer stack / shared UV space):
 *
 *      ┌wall┐            ┌lid wall┐
 *  ┌wall base wall┐  gap ┌wall LID wall┐      ← corner-cut rigid nets: 4 loose walls per tray,
 *      └wall┘            └lid wall┘             NO glue tabs — rigid board boxes are die-cut,
 *                                               corner-cut and WRAPPED, not glued at a seam.
 *
 * Fold: both trays fold their walls in [0, 0.6]; the lid translate runs [0.6, 1]
 * (lift [0.6,0.78] → carry [0.78,0.9] → seat [0.9,1]).
 */

import type { DielineParams, DielineResult, FoldMeshData, FoldTranslateSeg } from '../types';
import { type NetBuild, addPanel, buildNetGuides, bleedGuide } from '../mechanisms';

type P2 = [number, number];

/** Both trays' walls fold inside [0, 0.6]; the lid TRANSLATE owns [0.6, 1]. */
export const TELESCOPE_SEQUENCE = {
  tray: [0, 0.6] as [number, number],
  lift: [0.6, 0.78] as [number, number],
  carry: [0.78, 0.9] as [number, number],
  seat: [0.9, 1] as [number, number],
};

/** Gutter between the base net and the lid net on the shared canvas (mm). */
export const TWO_PIECE_GUTTER = 10;

export function rigidTwoPiece(params: DielineParams): DielineResult {
  const W = Math.max(1, params.width);
  const H = Math.max(1, params.height);
  const D = Math.max(1, params.depth);
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;
  const bt = Math.max(0.5, params.boardThickness ?? 2);            // rigid board caliper
  // DERIVED lid dims: outer footprint = base outer + 2×board clearance; wall depth = lidDepth
  // (default FULL telescope = base wall height), clamped so the seated walls never pass the floor.
  const lidW = W + 2 * bt, lidH = H + 2 * bt;
  const ld = Math.max(3, Math.min(params.lidDepth ?? D, D + bt));

  const seq = TELESCOPE_SEQUENCE;
  const gutter = TWO_PIECE_GUTTER;

  // ── net layout: base net around the origin, lid net to the right past the gutter ──
  const baseMaxX = W / 2 + D;
  const lidCx = baseMaxX + gutter + ld + lidW / 2;                 // lid net centre x
  const minX = -W / 2 - D, maxX = lidCx + lidW / 2 + ld;
  const minZ = Math.min(-H / 2 - D, -lidH / 2 - ld);
  const maxZ = Math.max(H / 2 + D, lidH / 2 + ld);
  const netW = maxX - minX, netH = maxZ - minZ;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const net: NetBuild = {
    panels: [], guides: [], panelLabels: {}, slits: [],
    uv: (x, z) => [(x - minX) / netW, (z - minZ) / netH],
    px: (x, z) => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight],
  };

  // One corner-cut tray: root panel + 4 loose walls (the corner cuts fall out of the net — the
  // walls simply don't meet at the corners; buildNetGuides derives the cut set). `sign` +1 folds
  // the walls UP (base tray), −1 folds them DOWN (the lid cap).
  const tray = (
    idPrefix: string, labelPrefix: string, cx: number, w: number, h: number, depth: number, sign: 1 | -1,
  ): number => {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = -h / 2, z1 = h / 2;
    const rootId = idPrefix === '' ? 'base' : idPrefix;
    const rootLabel = labelPrefix === '' ? 'Base' : labelPrefix;
    const root = addPanel(net, rootId, rootLabel, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], -1, null);
    const wall = (id: string, label: string, corners: P2[], hinge: [P2, P2]): void => {
      const i = addPanel(net, `${idPrefix}${idPrefix ? id[0].toUpperCase() + id.slice(1) : id}`,
        `${labelPrefix}${labelPrefix ? ' ' : ''}${label}`, corners, root, hinge, seq.tray);
      if (sign < 0) net.panels[i].targetAngle *= -1;               // lid walls fold DOWN (opening-down cap)
    };
    wall('back', 'Back', [[x0, z0 - depth], [x1, z0 - depth], [x1, z0], [x0, z0]], [[x0, z0], [x1, z0]]);
    wall('front', 'Front', [[x0, z1], [x1, z1], [x1, z1 + depth], [x0, z1 + depth]], [[x0, z1], [x1, z1]]);
    wall('left', 'Left', [[x0 - depth, z0], [x0, z0], [x0, z1], [x0 - depth, z1]], [[x0, z0], [x0, z1]]);
    wall('right', 'Right', [[x1, z0], [x1 + depth, z0], [x1 + depth, z1], [x1, z1]], [[x1, z0], [x1, z1]]);
    return root;
  };

  tray('', '', 0, W, H, D, 1);                                     // the BASE tray (root at the origin)
  const lidRoot = tray('lid', 'Lid', lidCx, lidW, lidH, ld, -1);   // the LID cap (derived dims)

  // ── the TELESCOPE move: translate the lid subgroup onto the base over [0.6, 1] ──
  // Three chained straight-line segments (all `from: 0` — fold 0 stays the exact flat net):
  // lift clears the seated height by more than the lid wall depth, so the carry-over never sweeps
  // the hanging lid walls through the base tray; seat drops it onto the derived clearance.
  const seatY = D + bt;                                            // seated lid-top height (gap = bt over the walls)
  const lift = ld + Math.max(6, 0.15 * D);
  const segs: FoldTranslateSeg[] = [
    { axis: [0, 1, 0], from: 0, to: seatY + lift, window: seq.lift },
    { axis: [1, 0, 0], from: 0, to: -lidCx, window: seq.carry },
    { axis: [0, 1, 0], from: 0, to: -lift, window: seq.seat },
  ];
  net.panels[lidRoot].foldTranslate = segs;

  const foldMeshData: FoldMeshData = { panels: net.panels, dielineWidth: netW, dielineHeight: netH };
  const guides = buildNetGuides(net);
  guides.push(bleedGuide(canvasWidth, canvasHeight, bleed / 25.4 * dpi));

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: net.panelLabels };
}
