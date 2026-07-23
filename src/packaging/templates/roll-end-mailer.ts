/**
 * src/packaging/templates/roll-end-mailer.ts — the ROLL-END MAILER (FEFCO 0427-style), M4 (+M1 lip).
 *
 * THE e-commerce/subscription box: a tray whose side walls are DOUBLE-WALLED (outer wall + a ply
 * that ROLLS over the rim and hangs back down inside — `addRollWall`, chained rigid pivots with a
 * 180° relative roll), a front wall with optional corner LOCKING tabs, and a hinged LID off the
 * back wall (lid top + front lip that tucks down over the front — shoulder slits on the lid edge,
 * the M1 friction-lock pattern). Dust WEBS are deliberately OMITTED: a web folds along a diagonal
 * (non-rigid), and faking it with a rigid pivot reads wrong — see packaging-templates.md §1 M4.
 *
 *   net layout (flat, x→right, z→down; base z ∈ [−H/2, H/2]):
 *
 *                  ┌ lid lip ┐
 *                  ├── lid ──┤                       ← the lid strip (top of the net)
 *                  ├─ back ──┤
 *      ┌roll┐┌wall┐│  base   │┌wall┐┌roll┐           ← tray strip (rolls outboard of the walls)
 *                  ├─ front ─┤
 *                  tab┘    └tab                      ← corner lock tabs (lockTabs, default on)
 *
 * Folded (fold=1): base is the root plane (y=0); the closed mailer spans x ∈ [−W/2, W/2] ×
 * y ∈ [0, D] × z ∈ [−H/2, H/2]. The roll plies end COPLANAR against their outer walls, the lip
 * coplanar against the front — zero-thickness board plies lying on each other. Fold SEQUENCE
 * (ROLL_SEQUENCE): outer walls → rolls → front + locks → lid → lip LAST.
 *
 * Params beyond W×H×D: `lockTabs` (default true; toggling = TOPOLOGY change → rebuild) and
 * `restOpenAmount` (0..0.95, default 0): scales the LID's target angle so at fold 1 the lid can
 * rest ajar — the classic mailer presentation. Dims-only (in-place fast path).
 * Net UVs are authored panel-per-panel; the LID outer face is the print hero (top of the canvas).
 */

import type { DielineParams, DielineResult, FoldMeshData } from '../types';
import { type NetBuild, addPanel, addRollWall, buildNetGuides, bleedGuide, ROLL_SEQUENCE } from '../mechanisms';

type P2 = [number, number];

export function rollEndMailer(params: DielineParams): DielineResult {
  const W = Math.max(1, params.width);
  const H = Math.max(1, params.height);
  const D = Math.max(1, params.depth);
  const dpi = params.dpi ?? 300;
  const bleed = params.bleed ?? 3;
  const lockTabs = params.lockTabs ?? true;
  const restOpen = Math.max(0, Math.min(0.95, params.restOpenAmount ?? 0));

  const rollD = 0.95 * D;                              // rolled inner ply depth
  const lipD = Math.min(0.8 * D, 22);                  // lid front lip depth (≤ D — stays inside the shell)
  const s = Math.min(3, W * 0.2);                      // lip shoulder inset (the friction-lock step)
  const c = Math.min(0.45 * lipD, lipD * 0.6, (W - 2 * s) * 0.25);   // lip corner chamfer
  const tabD = Math.min(0.6 * D, 15);                  // lock tab depth
  const tabTaper = Math.min(3, D * 0.3);

  // Net bounds (mm).
  const minX = -W / 2 - D - rollD, maxX = W / 2 + D + rollD;
  const zBk = -H / 2 - D;                              // back wall far edge (lid hinge)
  const zLid = zBk - H;                                // lid far edge (lip hinge)
  const minZ = zLid - lipD, maxZ = H / 2 + D;
  const netW = maxX - minX, netH = maxZ - minZ;
  const canvasWidth = Math.round(netW / 25.4 * dpi);
  const canvasHeight = Math.round(netH / 25.4 * dpi);

  const net: NetBuild = {
    panels: [], guides: [], panelLabels: {}, slits: [],
    uv: (x, z) => [(x - minX) / netW, (z - minZ) / netH],
    px: (x, z) => [(x - minX) / netW * canvasWidth, (z - minZ) / netH * canvasHeight],
  };

  // ── base (root) + back wall + lid chain ──
  const base = addPanel(net, 'base', 'Base',
    [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]], -1, null);
  const back = addPanel(net, 'back', 'Back',
    [[-W / 2, zBk], [W / 2, zBk], [W / 2, -H / 2], [-W / 2, -H / 2]],
    base, [[-W / 2, -H / 2], [W / 2, -H / 2]], ROLL_SEQUENCE.outer);
  const lid = addPanel(net, 'lid', 'Lid',
    [[-W / 2, zLid], [W / 2, zLid], [W / 2, zBk], [-W / 2, zBk]],
    back, [[-W / 2, zBk], [W / 2, zBk]], ROLL_SEQUENCE.lid);
  // REST-OPEN presentation: scale the lid's fully-folded angle so fold 1 leaves it ajar.
  net.panels[lid].targetAngle *= (1 - restOpen);

  // Lid front LIP: chamfered tongue hinged on the lid's far edge (shoulders inset by `s`), tucking
  // down over the front wall. Shoulder SLITS on the lid edge either side of the lip crease — the
  // M1 friction-lock pattern (registered so buildNetGuides types them 'slit', not 'cut').
  const P0: P2 = [-W / 2 + s, zLid], P1: P2 = [W / 2 - s, zLid];
  addPanel(net, 'lidLip', 'Lid Lip', [
    P0, P1,
    [P1[0], zLid - (lipD - c)],
    [P1[0] - c, zLid - lipD],
    [P0[0] + c, zLid - lipD],
    [P0[0], zLid - (lipD - c)],
  ], lid, [P0, P1], ROLL_SEQUENCE.lip);
  const LA: P2 = [-W / 2, zLid], LB: P2 = [W / 2, zLid];
  net.slits.push([LA, P0], [P1, LB]);
  net.guides.push({
    type: 'slit', color: '#ff8800',
    segments: [
      [net.px(LA[0], LA[1]), net.px(P0[0], P0[1])],
      [net.px(P1[0], P1[1]), net.px(LB[0], LB[1])],
    ],
  });

  // ── front wall (+ corner locking tabs) ──
  const front = addPanel(net, 'front', 'Front',
    [[-W / 2, H / 2], [W / 2, H / 2], [W / 2, H / 2 + D], [-W / 2, H / 2 + D]],
    base, [[-W / 2, H / 2], [W / 2, H / 2]], ROLL_SEQUENCE.front);
  if (lockTabs) {
    // Tapered tabs on the front wall's side edges: they fold back along the side walls (ending
    // coplanar with the outer wall / roll plies — the lock plane) as the front rises.
    const tab = (id: string, label: string, sign: 1 | -1): void => {
      const x = sign * W / 2;
      const a: P2 = [x, H / 2], b: P2 = [x, H / 2 + D];
      addPanel(net, id, label, [
        a, b,
        [x + sign * tabD, H / 2 + D - tabTaper],
        [x + sign * tabD, H / 2 + tabTaper],
      ], front, [a, b], ROLL_SEQUENCE.lock);
    };
    tab('lockA', 'Lock A', -1);
    tab('lockB', 'Lock B', 1);
  }

  // ── double-walled sides (M4: outer wall + rolled inner ply) ──
  addRollWall(net, {
    idPrefix: 'left', labelPrefix: 'Left',
    edge: { parentPanelIndex: base, a: [-W / 2, -H / 2], b: [-W / 2, H / 2], out: [-1, 0] },
    depth: D, rollDepth: rollD,
  });
  addRollWall(net, {
    idPrefix: 'right', labelPrefix: 'Right',
    edge: { parentPanelIndex: base, a: [W / 2, -H / 2], b: [W / 2, H / 2], out: [1, 0] },
    depth: D, rollDepth: rollD,
  });

  const foldMeshData: FoldMeshData = { panels: net.panels, dielineWidth: netW, dielineHeight: netH };
  const guides = buildNetGuides(net);
  guides.push(bleedGuide(canvasWidth, canvasHeight, bleed / 25.4 * dpi));

  return { foldMeshData, canvasWidth, canvasHeight, guides, panelLabels: net.panelLabels };
}
