/**
 * src/packaging/templates/tuck-end.ts — the RETAIL DEFAULT folding carton (RTE / STE).
 *
 * Composition: 4 walls in a row + glue tab (M2) + a tuck-flap assembly (M1) closing EACH end.
 * `params.tuckStyle` picks the variant — 'reverse' (RTE, default: the tucks open from OPPOSITE
 * faces) or 'straight' (STE: both tucks on the same face). Same box, different bottom-closure
 * parent → a tuckStyle change is a TOPOLOGY change (packaging-manager rebuilds, never fast-paths).
 *
 *   net layout (flat strip, x→right, z→down the net; walls z ∈ [−H/2, H/2]):
 *
 *              ┌ tongue ┐
 *              ├ topTuck┤  ┌dustA┐                ┌dustB┐
 *      ┌ front ┐┌ right ┐┌── back ──┐┌ left ┐┌glueTab┐          ← the wall strip
 *              └ botTuck┘  └dustA┘                └dustB┘          (RTE: botTuck under BACK)
 *              └ tongue ┘
 *
 * Folded (fold=1): front is the root plane (y=0), the strip wraps into a tube — the closed box
 * spans x ∈ [−W/2, W/2] × y ∈ [0, D] × z ∈ [−H/2, H/2]. Fold SEQUENCE (phase windows): walls
 * (+glue tab) → dust flaps → closures → tongues LAST, so a tongue slides over the closed dust
 * flaps instead of clipping through them.
 */

import type { DielineParams, DielineResult, FoldMeshData } from '../types';
import { type NetBuild, addPanel, addTuckFlap, addGlueTab, buildNetGuides, bleedGuide, TUCK_SEQUENCE } from '../mechanisms';

type P2 = [number, number];

export function tuckEnd(params: DielineParams): DielineResult {
  const W = Math.max(1, params.width);
  const H = Math.max(1, params.height);
  const D = Math.max(1, params.depth);
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;
  const tuckStyle = params.tuckStyle ?? 'reverse';

  const tongueDepth = Math.min(0.75 * D, 18);
  const glueW = Math.max(4, Math.min(12, 0.8 * H));

  // Wall strip x-coordinates: front | right | back | left | glue tab.
  const xF0 = -W / 2, xF1 = W / 2;            // front
  const xR1 = xF1 + D;                        // right side
  const xB1 = xR1 + W;                        // back
  const xL1 = xB1 + D;                        // left side (glue tab beyond)

  // Net bounds (mm): both closures + tongues extend the z range symmetrically.
  const minX = xF0, maxX = xL1 + glueW;
  const minZ = -H / 2 - D - tongueDepth, maxZ = H / 2 + D + tongueDepth;
  const netW = maxX - minX, netH = maxZ - minZ;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const net: NetBuild = {
    panels: [], guides: [], panelLabels: {}, slits: [],
    uv: (x, z) => [(x - minX) / netW, (z - minZ) / netH],
    px: (x, z) => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight],
  };

  const zT = -H / 2, zB = H / 2;   // wall top / bottom edges
  const rect = (x0: number, x1: number): P2[] => [[x0, zT], [x1, zT], [x1, zB], [x0, zB]];
  const wallsWin = TUCK_SEQUENCE.walls;

  // ── the wall strip (root = front) + glue tab (M2) ──
  const front = addPanel(net, 'front', 'Front', rect(xF0, xF1), -1, null);
  const right = addPanel(net, 'right', 'Right', rect(xF1, xR1), front, [[xF1, zT], [xF1, zB]], wallsWin);
  const back = addPanel(net, 'back', 'Back', rect(xR1, xB1), right, [[xR1, zT], [xR1, zB]], wallsWin);
  const left = addPanel(net, 'left', 'Left', rect(xB1, xL1), back, [[xB1, zT], [xB1, zB]], wallsWin);
  addGlueTab(net, {
    edge: { parentPanelIndex: left, a: [xL1, zT], b: [xL1, zB], out: [1, 0] },
    width: glueW, foldWindow: wallsWin,
  });

  // ── top closure (M1) — always off the FRONT ──
  addTuckFlap(net, {
    idPrefix: 'top', labelPrefix: 'Top',
    closure: { parentPanelIndex: front, a: [xF0, zT], b: [xF1, zT], out: [0, -1] },
    dust: [
      { parentPanelIndex: right, a: [xF1, zT], b: [xR1, zT], out: [0, -1] },
      { parentPanelIndex: left, a: [xB1, zT], b: [xL1, zT], out: [0, -1] },
    ],
    closureDepth: D, tongueDepth,
  });

  // ── bottom closure (M1) — RTE: off the BACK (opposite face); STE: off the FRONT (same face) ──
  const botParent = tuckStyle === 'reverse' ? back : front;
  const botEdge: [P2, P2] = tuckStyle === 'reverse'
    ? [[xR1, zB], [xB1, zB]]
    : [[xF0, zB], [xF1, zB]];
  addTuckFlap(net, {
    idPrefix: 'bot', labelPrefix: 'Bottom',
    closure: { parentPanelIndex: botParent, a: botEdge[0], b: botEdge[1], out: [0, 1] },
    dust: [
      { parentPanelIndex: right, a: [xF1, zB], b: [xR1, zB], out: [0, 1] },
      { parentPanelIndex: left, a: [xB1, zB], b: [xL1, zB], out: [0, 1] },
    ],
    closureDepth: D, tongueDepth,
  });

  const foldMeshData: FoldMeshData = { panels: net.panels, dielineWidth: netW, dielineHeight: netH };
  const guides = buildNetGuides(net);
  guides.push(bleedGuide(canvasWidth, canvasHeight, bleed / 25.4 * dpi));

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: net.panelLabels };
}
