/**
 * src/packaging/templates/sleeve.ts — the open-ended SLEEVE (band).
 *
 * Composition proof for the mechanism kit: 4 panels + glue tab (M2 only), folding into a
 * rectangular tube with no top/bottom. Params reuse the standard box dims — `width` = the girth
 * face width (x), `depth` = the face depth (the tube's y when folded), `height` = the sleeve
 * width along the tube (z). Folded (fold=1) the tube spans x ∈ [−W/2, W/2] × y ∈ [0, D] ×
 * z ∈ [−H/2, H/2], open at both z ends. Thumb notch (M7) deferred.
 */

import type { DielineParams, DielineResult, FoldMeshData } from '../types';
import { type NetBuild, addPanel, addGlueTab, buildNetGuides, bleedGuide } from '../mechanisms';

type P2 = [number, number];

export function sleeve(params: DielineParams): DielineResult {
  const W = Math.max(1, params.width);
  const H = Math.max(1, params.height);
  const D = Math.max(1, params.depth);
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;

  const glueW = Math.max(4, Math.min(12, 0.8 * H));

  const xF0 = -W / 2, xF1 = W / 2;
  const xR1 = xF1 + D;
  const xB1 = xR1 + W;
  const xL1 = xB1 + D;

  const minX = xF0, maxX = xL1 + glueW;
  const minZ = -H / 2, maxZ = H / 2;
  const netW = maxX - minX, netH = maxZ - minZ;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const net: NetBuild = {
    panels: [], guides: [], panelLabels: {}, slits: [],
    uv: (x, z) => [(x - minX) / netW, (z - minZ) / netH],
    px: (x, z) => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight],
  };

  const zT = -H / 2, zB = H / 2;
  const rect = (x0: number, x1: number): P2[] => [[x0, zT], [x1, zT], [x1, zB], [x0, zB]];

  const front = addPanel(net, 'front', 'Front', rect(xF0, xF1), -1, null);
  const right = addPanel(net, 'right', 'Right', rect(xF1, xR1), front, [[xF1, zT], [xF1, zB]]);
  const back = addPanel(net, 'back', 'Back', rect(xR1, xB1), right, [[xR1, zT], [xR1, zB]]);
  const left = addPanel(net, 'left', 'Left', rect(xB1, xL1), back, [[xB1, zT], [xB1, zB]]);
  addGlueTab(net, { edge: { parentPanelIndex: left, a: [xL1, zT], b: [xL1, zB], out: [1, 0] }, width: glueW });

  const foldMeshData: FoldMeshData = { panels: net.panels, dielineWidth: netW, dielineHeight: netH };
  const guides = buildNetGuides(net);
  guides.push(bleedGuide(canvasWidth, canvasHeight, bleed / 25.4 * dpi));

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: net.panelLabels };
}
