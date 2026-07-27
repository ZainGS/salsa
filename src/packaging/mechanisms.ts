/**
 * src/packaging/mechanisms.ts — reusable STRUCTURAL MECHANISMS (packaging-templates.md §1).
 *
 * The prime directive is *mechanisms, not SKUs*: a "box type" is a template file that COMPOSES
 * these helpers over a dieline layout — nothing here is hard-coded to one box. Shipped here:
 *
 *   M1 `addTuckFlap`  — tuck closure: closure panel + tongue (chamfered corners) hinged off it +
 *                       2 dust flaps off the side walls, with fold-sequence windows (dust flaps
 *                       close before the tongue) and 'slit' guides at the tongue-shoulder locks.
 *   M2 `addGlueTab`   — the seam tab off the last wall: folds with its wall, EXCLUDED from the
 *                       artwork net (UV-mapped to a thin margin strip), marked with a labeled
 *                       'panel' guide so hosts can render "Glue Tab — no artwork".
 *
 * Plus the shared net-building kit templates use to stay tiny: `NetBuild` (the accumulator),
 * `addPanel`, `foldUpAngle` (the fold-direction convention shared with simple-box), and
 * `buildNetGuides` (panel outlines + creases + the CUT set derived by subtracting hinge/slit
 * intervals from panel edges — so tongue chamfers, dust-flap tapers and tab tapers are always cut
 * correctly without a hand-walked perimeter per template).
 */

import type { DielineGuide, FoldPanel } from './types';

type P2 = [number, number];

/** Accumulator a template threads through the mechanism helpers. `parentPanelIndex` values are
 *  REAL indices into `panels` — helpers push and return the indices they created, so composition
 *  never needs index bookkeeping. */
export interface NetBuild {
  panels: FoldPanel[];
  /** Mechanism-emitted guides (slits, glue-tab marker). Template merges with buildNetGuides output. */
  guides: DielineGuide[];
  panelLabels: Record<string, string>;
  /** Registered slit segments (net mm) — typed 'slit' and SUBTRACTED from the cut set. */
  slits: [P2, P2][];
  /** Flat net mm → dieline UV [0,1]. */
  uv(x: number, z: number): P2;
  /** Flat net mm → dieline canvas px. */
  px(x: number, z: number): P2;
}

/** Fully-folded angle (±90°) that folds a panel UP out of its parent's plane — the ONE fold-
 *  direction convention every template shares (same math as simple-box). Derived from the hinge
 *  direction × the outward direction, so all panels of a net fold toward the same (interior) side. */
export function foldUpAngle(hinge: [P2, P2], corners: P2[]): number {
  const a = hinge[0], b = hinge[1];
  const dx = b[0] - a[0], dz = b[1] - a[1];                 // hinge direction (x,z)
  const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let cx = 0, cz = 0;
  for (const c of corners) { cx += c[0]; cz += c[1]; }
  const ox = cx / corners.length - mid[0], oz = cz / corners.length - mid[1]; // toward the panel
  // (d × o).y for d=(dx,0,dz), o=(ox,0,oz)  →  dz·ox − dx·oz. >0 ⇒ +90 folds up, else −90.
  return (dz * ox - dx * oz) >= 0 ? 90 : -90;
}

/** Push one panel (UVs authored from the net mapping, fold direction from foldUpAngle). Returns
 *  its index for use as a parentPanelIndex. */
export function addPanel(
  net: NetBuild, id: string, label: string, corners: P2[],
  parentPanelIndex: number, hinge: [P2, P2] | null, foldWindow?: [number, number],
): number {
  net.panels.push({
    id, name: label, corners,
    uvs: corners.map(c => net.uv(c[0], c[1])),
    parentPanelIndex, hinge,
    targetAngle: hinge ? foldUpAngle(hinge, corners) : 0,
    ...(foldWindow ? { foldWindow } : {}),
  });
  net.panelLabels[id] = label;
  return net.panels.length - 1;
}

// ── vector helpers (net mm) ───────────────────────────────────────────────
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];
const norm = (a: P2): P2 => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

/**
 * The DEFAULT tuck-end fold CHOREOGRAPHY (phase windows over the global fold amount).
 *
 * SMALL-FIRST PRINCIPLE (BUG 4): small flaps must visibly finish BEFORE the large panels sweep
 * over them — the physical closing order, and the fix for "small tabs fold last, should fold small
 * parts first". The windows are now NON-OVERLAPPING between stages so the read is crisp:
 *
 *   1. walls   [0.00, 0.36]  the four side walls wrap up into the tube (the glue tab folds with them)
 *   2. dust    [0.36, 0.52]  the two SMALL dust flaps tuck fully IN — done before the lid moves
 *   3. tongue  [0.52, 0.72]  the tongue PRE-CURLS relative to its (still-raised) lid panel FIRST —
 *                            the way you crease the tuck before swinging the flap down
 *   4. closure [0.72, 1.00]  the LARGE lid panel folds down LAST, carrying the already-creased tongue
 *                            into the slot
 *
 * The tongue folds BEFORE the closure (user preference + how these boxes actually close by hand):
 * because the tongue's fold is RELATIVE to its parent lid, pre-creasing it while the lid is still up
 * and then rotating the lid down lands it tucked-in at fold 1 (the final pose is order-independent —
 * only the animation reads differently). Interpenetration stays clean at the sampled fold amounts.
 */
export const TUCK_SEQUENCE = {
  walls: [0, 0.36] as [number, number],
  dust: [0.36, 0.52] as [number, number],
  tongue: [0.52, 0.72] as [number, number],
  closure: [0.72, 1] as [number, number],
};

/** One hinged edge on an existing panel: a→b in net mm; the new panel extends toward `out`. */
export interface MechanismEdge { parentPanelIndex: number; a: P2; b: P2; out: P2; }

/** M1 parameters. Defaults produce a standard retail tuck (tongue ≈ ¾ of the closure depth,
 *  capped; 3 mm shoulders; trapezoidal dust flaps). */
export interface TuckFlapSpec {
  /** Prefix for panel ids ('top' → 'topClose'/'topTongue'/'topDust0'/'topDust1'). */
  idPrefix: string;
  /** Prefix for display labels ('Top' → 'Top Tuck', 'Top Tongue', …). */
  labelPrefix: string;
  /** The closure hinge on the closure WALL's edge. */
  closure: MechanismEdge;
  /** The two dust-flap hinges on the SIDE walls (same end of the box). */
  dust: [MechanismEdge, MechanismEdge];
  /** How far the closure spans — the box dimension it must cover to close the opening. */
  closureDepth: number;
  /** Tongue (tuck) depth. Default min(0.75·closureDepth, 18) mm. */
  tongueDepth?: number;
  /** Tongue shoulder inset each side (the friction-lock step). Default 3 mm (clamped). */
  shoulder?: number;
  /** Tongue corner chamfer (the rounded-corner cut). Default 0.45·tongueDepth (clamped). */
  chamfer?: number;
  /** Dust flap depth. Default min(0.85·closureDepth, 0.45·closure hinge length). */
  dustDepth?: number;
  /** Dust flap trapezoid end-taper. Default 0.4·dustDepth. */
  dustTaper?: number;
  /** Fold-sequence windows; default {@link TUCK_SEQUENCE}. */
  windows?: { dust: [number, number]; closure: [number, number]; tongue: [number, number] };
}

/**
 * M1 — TUCK FLAP: closure panel + chamfered tongue + 2 dust flaps, staged fold windows, and
 * 'slit' guides at the tongue-shoulder locks (the short cuts the shoulders friction-lock into,
 * lying on the closure's far edge either side of the tongue crease).
 */
export function addTuckFlap(net: NetBuild, spec: TuckFlapSpec): { closureIndex: number; tongueIndex: number; dustIndices: [number, number] } {
  const d = spec.closureDepth;
  const t = spec.tongueDepth ?? Math.min(0.75 * d, 18);
  const win = spec.windows ?? TUCK_SEQUENCE;
  const { a, b, out } = spec.closure;
  const u = norm(sub(b, a));
  const o = norm(out);
  const hingeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const s = Math.min(spec.shoulder ?? 3, hingeLen * 0.2);
  const c = Math.min(spec.chamfer ?? 0.45 * t, t * 0.6, (hingeLen - 2 * s) * 0.25);

  // Closure: the full-width lid panel spanning the box opening.
  const A2 = add(a, mul(o, d)), B2 = add(b, mul(o, d));
  const closureIndex = addPanel(
    net, `${spec.idPrefix}Close`, `${spec.labelPrefix} Tuck`,
    [a, b, B2, A2], spec.closure.parentPanelIndex, [a, b], win.closure);

  // Tongue: hinged on the closure's FAR edge, inset by the shoulders, chamfered at the tip.
  const P0 = add(A2, mul(u, s)), P1 = sub(B2, mul(u, s));
  const tongueCorners: P2[] = [
    P0, P1,
    add(P1, mul(o, t - c)),
    add(sub(P1, mul(u, c)), mul(o, t)),
    add(add(P0, mul(u, c)), mul(o, t)),
    add(P0, mul(o, t - c)),
  ];
  const tongueIndex = addPanel(
    net, `${spec.idPrefix}Tongue`, `${spec.labelPrefix} Tongue`,
    tongueCorners, closureIndex, [P0, P1], win.tongue);

  // Friction-lock SLITS: the shoulder segments of the closure's far edge (either side of the
  // tongue crease). Registered so buildNetGuides types them 'slit' instead of 'cut'.
  net.slits.push([A2, P0], [P1, B2]);
  net.guides.push({
    type: 'slit', color: '#ff8800',
    segments: [
      [net.px(A2[0], A2[1]), net.px(P0[0], P0[1])],
      [net.px(P1[0], P1[1]), net.px(B2[0], B2[1])],
    ],
  });

  // Dust flaps: trapezoids off the side walls, folding in BEFORE the closure/tongue.
  const dustIndices: [number, number] = [0, 0];
  spec.dust.forEach((edge, k) => {
    const du = norm(sub(edge.b, edge.a));
    const dOut = norm(edge.out);
    const dustHingeLen = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
    const dd = spec.dustDepth ?? Math.min(0.85 * d, 0.45 * hingeLen);
    const taper = Math.min(spec.dustTaper ?? 0.4 * dd, dustHingeLen * 0.4);
    const corners: P2[] = [
      edge.a, edge.b,
      add(sub(edge.b, mul(du, taper)), mul(dOut, dd)),
      add(add(edge.a, mul(du, taper)), mul(dOut, dd)),
    ];
    dustIndices[k] = addPanel(
      net, `${spec.idPrefix}Dust${k}`, `${spec.labelPrefix} Dust ${k === 0 ? 'A' : 'B'}`,
      corners, edge.parentPanelIndex, [edge.a, edge.b], win.dust);
  });

  return { closureIndex, tongueIndex, dustIndices };
}

/**
 * The DEFAULT roll-end-mailer fold sequence (M4): outer walls (back + side outers) wrap first,
 * the side plies ROLL over the top rims, the front wall rises with its corner locks, and the
 * lid (top → front lip) closes LAST — so the classic "lid comes down over the finished tray"
 * presentation falls out of the one fold scalar.
 *
 * SMALL-FIRST (BUG 4): this already stages small-before-large — the small corner LOCK tabs fold
 * with the front wall (lock [0.5, 0.68]) and finish BEFORE the LARGE lid comes down (lid [0.72,
 * 0.9]); only the small front LIP tucks at the very end (lip [0.86, 1]), which — like the tuck-end
 * tongue — is the physical tuck and MUST be last. No small flap folds after a large panel wrongly.
 */
export const ROLL_SEQUENCE = {
  outer: [0, 0.3] as [number, number],
  roll: [0.28, 0.5] as [number, number],
  front: [0.5, 0.7] as [number, number],
  lock: [0.5, 0.68] as [number, number],
  lid: [0.72, 0.9] as [number, number],
  lip: [0.86, 1] as [number, number],
};

/** M4 parameters (one side of the tray). */
export interface RollWallSpec {
  /** Prefix for panel ids ('left' → 'leftWall'/'leftRoll'). */
  idPrefix: string;
  /** Prefix for display labels ('Left' → 'Left Wall', 'Left Roll'). */
  labelPrefix: string;
  /** The wall hinge on the BASE panel's edge. */
  edge: MechanismEdge;
  /** Outer wall height (the box depth the wall stands up). */
  depth: number;
  /** Rolled inner ply depth (how far it hangs back down inside). Default 0.95·depth. */
  rollDepth?: number;
  /** Fold-sequence windows; default {@link ROLL_SEQUENCE} outer/roll. */
  windows?: { outer: [number, number]; roll: [number, number] };
}

/**
 * M4 — ROLL-END DOUBLE WALL: the side wall of a roll-end mailer/tray as CHAINED RIGID PIVOTS.
 * The outer wall folds 90° up off the base; the inner ply hinges on the outer wall's top edge
 * and folds a further 180° RELATIVE (the 'roll'), so at fold 1 it hangs back down COPLANAR
 * against the outer wall's inner face — zero-thickness board plies lying on each other, exactly
 * what the interpenetration oracle admits. Sequenced: outer first, then the roll. (Triangular
 * dust WEBS fold diagonally — a non-rigid fold — so M4 deliberately omits them rather than fake
 * bendy geometry; see packaging-templates.md §1 M4.)
 */
export function addRollWall(net: NetBuild, spec: RollWallSpec): { wallIndex: number; rollIndex: number } {
  const { a, b, out } = spec.edge;
  const o = norm(out);
  const d = spec.depth;
  const rd = Math.min(spec.rollDepth ?? 0.95 * d, d);   // never deeper than the wall (would hit the base)
  const win = spec.windows ?? { outer: ROLL_SEQUENCE.outer, roll: ROLL_SEQUENCE.roll };

  // Outer wall: base edge → out by depth.
  const A2 = add(a, mul(o, d)), B2 = add(b, mul(o, d));
  const wallIndex = addPanel(
    net, `${spec.idPrefix}Wall`, `${spec.labelPrefix} Wall`,
    [a, b, B2, A2], spec.edge.parentPanelIndex, [a, b], win.outer);

  // Rolled inner ply: hinged on the outer wall's far edge, extending further out in the net.
  const A3 = add(A2, mul(o, rd)), B3 = add(B2, mul(o, rd));
  const rollIndex = addPanel(
    net, `${spec.idPrefix}Roll`, `${spec.labelPrefix} Roll`,
    [A2, B2, B3, A3], wallIndex, [A2, B2], win.roll);
  // The ROLL: double the ±90° fold-up angle → ±180° relative to the outer wall, so the ply
  // rolls over the rim and lies against the wall's inner face.
  net.panels[rollIndex].targetAngle *= 2;

  return { wallIndex, rollIndex };
}

/** M2 parameters. */
export interface GlueTabSpec {
  /** The seam edge on the LAST wall the tab hangs off. */
  edge: MechanismEdge;
  /** Tab depth (how far it extends past the seam). Default min(12, 0.8·hinge length) clamped ≥ 4. */
  width?: number;
  /** End taper (the classic angled tab ends). Default 3 mm (clamped). */
  taper?: number;
  /** Fold window — pass the template's WALL window so the tab folds with its wall. */
  foldWindow?: [number, number];
  id?: string;      // default 'glueTab'
  label?: string;   // default 'Glue Tab'
}

/**
 * M2 — GLUE TAB: the manufacturer's seam panel joining the last wall back to the first. Folds
 * with its wall (same phase window). EXCLUDED from the artwork net: its UVs are remapped to a
 * thin margin strip at the canvas' right edge (kept non-degenerate so tangent generation stays
 * finite), so no user artwork lands on the glued seam. Marked with a labeled 'panel' guide
 * (outline + diagonal) hosts can render as "glue area".
 */
export function addGlueTab(net: NetBuild, spec: GlueTabSpec): { tabIndex: number } {
  const { a, b, out } = spec.edge;
  const u = norm(sub(b, a));
  const o = norm(out);
  const hingeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const w = Math.max(4, spec.width ?? Math.min(12, 0.8 * hingeLen));
  const taper = Math.min(spec.taper ?? 3, hingeLen * 0.3);
  const corners: P2[] = [
    a, b,
    add(sub(b, mul(u, taper)), mul(o, w)),
    add(add(a, mul(u, taper)), mul(o, w)),
  ];
  const tabIndex = addPanel(net, spec.id ?? 'glueTab', spec.label ?? 'Glue Tab',
    corners, spec.edge.parentPanelIndex, [a, b], spec.foldWindow);

  // UV EXCLUSION: remap the tab's UVs into a narrow strip hugging the canvas' right edge (u in
  // [1−strip, 1], v preserved). Artwork painted on the net never reaches the seam, and the strip
  // has real area so computeTangents never divides by a zero UV determinant.
  const tab = net.panels[tabIndex];
  const STRIP = 0.01;
  const us = tab.uvs.map(q => q[0]);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const span = Math.max(u1 - u0, 1e-6);
  tab.uvs = tab.uvs.map(([uu, vv]) => [1 - STRIP + ((uu - u0) / span) * STRIP, vv] as P2);

  // Marker guide: tab outline + a diagonal, labeled so hosts can annotate the glue area.
  const pxc = corners.map(q => net.px(q[0], q[1]));
  net.guides.push({
    type: 'panel', color: '#b0a08a', label: spec.label ?? 'Glue Tab',
    segments: [
      [pxc[0], pxc[1]], [pxc[1], pxc[2]], [pxc[2], pxc[3]], [pxc[3], pxc[0]],
      [pxc[0], pxc[2]],   // diagonal — reads as "hatched / non-print"
    ],
  });
  return { tabIndex };
}

// ── Guide derivation ──────────────────────────────────────────────────────

const COLLINEAR_EPS = 0.02;   // mm — tolerance for "this hinge/slit lies on this edge"

/** Sub-interval [t0,t1] of edge ea→eb covered by segment ha→hb, or null if not collinear/overlapping. */
function collinearInterval(ea: P2, eb: P2, ha: P2, hb: P2): [number, number] | null {
  const dx = eb[0] - ea[0], dz = eb[1] - ea[1];
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return null;
  const len = Math.sqrt(len2);
  const proj = (p: P2): { t: number; perp: number } => {
    const rx = p[0] - ea[0], rz = p[1] - ea[1];
    return { t: (rx * dx + rz * dz) / len2, perp: Math.abs(rx * dz - rz * dx) / len };
  };
  const pa = proj(ha), pb = proj(hb);
  if (pa.perp > COLLINEAR_EPS || pb.perp > COLLINEAR_EPS) return null;
  const t0 = Math.max(0, Math.min(pa.t, pb.t));
  const t1 = Math.min(1, Math.max(pa.t, pb.t));
  if (t1 - t0 <= COLLINEAR_EPS / len) return null;
  return [t0, t1];
}

/**
 * Derive the standard guide set for a composed net:
 *  - 'panel'  — every panel outline (subtle, under everything),
 *  - 'fold'   — every hinge (creases),
 *  - 'cut'    — every panel edge MINUS the intervals covered by hinges (own + children's) and
 *               registered slits. This yields the complete cut set — outer perimeter, tongue
 *               chamfers, flap tapers, and the shoulder steps — with no hand-walked loop per
 *               template. (Flap-adjacent cuts appear once per side; duplicates are benign for
 *               the overlay and are deduped by the export layer later.)
 * Mechanism guides already pushed into `net.guides` (slits, glue-tab marker) ride along after.
 */
export function buildNetGuides(net: NetBuild): DielineGuide[] {
  const guides: DielineGuide[] = [];
  const panelSegs: [P2, P2][] = [];
  const foldSegs: [P2, P2][] = [];
  const cutSegs: [P2, P2][] = [];

  // All hinge segments (any panel's own hinge subtracts from whichever edges it lies on).
  const hinges: [P2, P2][] = net.panels.filter(p => p.hinge).map(p => p.hinge!) as [P2, P2][];

  for (const p of net.panels) {
    const n = p.corners.length;
    for (let i = 0; i < n; i++) {
      const ea = p.corners[i], eb = p.corners[(i + 1) % n];
      panelSegs.push([net.px(ea[0], ea[1]), net.px(eb[0], eb[1])]);

      // Subtract hinge + slit intervals from this edge; the remainder is cut.
      const covered: [number, number][] = [];
      for (const [ha, hb] of hinges) {
        const iv = collinearInterval(ea, eb, ha, hb);
        if (iv) covered.push(iv);
      }
      for (const [sa, sb] of net.slits) {
        const iv = collinearInterval(ea, eb, sa, sb);
        if (iv) covered.push(iv);
      }
      covered.sort((x, y) => x[0] - y[0]);
      let cursor = 0;
      const emit = (t0: number, t1: number): void => {
        if (t1 - t0 < 1e-4) return;
        const q0: P2 = [ea[0] + (eb[0] - ea[0]) * t0, ea[1] + (eb[1] - ea[1]) * t0];
        const q1: P2 = [ea[0] + (eb[0] - ea[0]) * t1, ea[1] + (eb[1] - ea[1]) * t1];
        cutSegs.push([net.px(q0[0], q0[1]), net.px(q1[0], q1[1])]);
      };
      for (const [t0, t1] of covered) {
        emit(cursor, t0);
        cursor = Math.max(cursor, t1);
      }
      emit(cursor, 1);
    }
    if (p.hinge) {
      foldSegs.push([net.px(p.hinge[0][0], p.hinge[0][1]), net.px(p.hinge[1][0], p.hinge[1][1])]);
    }
  }

  guides.push({ type: 'panel', segments: panelSegs, color: '#c8c8c8' });
  guides.push({ type: 'cut', segments: cutSegs, color: '#222222' });
  guides.push({ type: 'fold', segments: foldSegs, color: '#00aaff' });
  guides.push(...net.guides);
  return guides;
}

/** The standard bleed rectangle guide (canvas px, inset by the bleed margin). */
export function bleedGuide(canvasWidth: number, canvasHeight: number, bleedPx: number): DielineGuide {
  const b = bleedPx;
  return {
    type: 'bleed',
    segments: [
      [[b, b], [canvasWidth - b, b]],
      [[canvasWidth - b, b], [canvasWidth - b, canvasHeight - b]],
      [[canvasWidth - b, canvasHeight - b], [b, canvasHeight - b]],
      [[b, canvasHeight - b], [b, b]],
    ],
    color: '#ff3399',
  };
}
