/**
 * src/packaging/cd/cd-kit-assembly.ts
 *
 * The CD-kit "Complete view" assembly — a PURE mapping from one scrub value t∈[0,1] to every piece's local
 * transform, so the Complete component of the CD designer plays: closed case → lid opens → pieces fan out
 * (exploded view). Two overlapping phases: the LID rotates open over t∈[0,0.6], then pieces SEPARATE over
 * t∈[0.4,1]. Like a real jewel case, the FRONT INSERT + BOOKLET are held in the lid by the retainer tabs, so
 * they OPEN WITH THE FRONT COVER (same hinge) — lifting away to reveal the DISC on the tray. The disc + tray
 * card + tray back stay put and fan along z. Deterministic + unit-testable; the browser layer just applies
 * these transforms to the kit's piece nodes each scrub frame (mm units — the kit applies mm→world scale).
 */

/** CD jewel-case outer metrics (mm): 142 WIDE × 125 tall × 10 — a real case is wider than tall (the 150 mm tray
 *  card's flaps wrap the left/right edges, so the WIDE dimension is the 142 one). The 120 mm booklet/insert/disc
 *  sit inside; the 150 mm tray card's 4 mm spine flaps fold over the sides. */
export const CD_CASE = { width: 142, height: 125, thickness: 10 } as const;

export type CDPiece = 'lid' | 'trayBack' | 'disc' | 'frontInsert' | 'booklet' | 'trayCard';

/** Every kit piece (build/visibility order). */
export const CD_ALL_PIECES: CDPiece[] = ['trayBack', 'trayCard', 'disc', 'booklet', 'frontInsert', 'lid'];

/** The CD-designer component dropdown: "Complete" (the whole assembly, scrub opens/explodes) + one option per
 *  editable printed piece. The case shells (lid/tray) aren't editable components — they're the plastic. */
export type CDComponent = 'complete' | 'frontInsert' | 'trayCard' | 'disc' | 'booklet';
export const CD_EDITABLE_COMPONENTS: CDComponent[] = ['frontInsert', 'trayCard', 'disc', 'booklet'];

export interface CDComponentView {
  /** Which pieces render for this component. */
  visiblePieces: CDPiece[];
  /** The single piece to frame flat-on for editing (null in Complete). */
  focusPiece: CDPiece | null;
  /** Whether the open/explode scrub applies (only in Complete). */
  scrubEnabled: boolean;
}

/** Pure mapping: active component → what shows, what's focused, whether the scrub is live. */
export function cdComponentView(component: CDComponent): CDComponentView {
  if (component === 'complete') return { visiblePieces: CD_ALL_PIECES, focusPiece: null, scrubEnabled: true };
  return { visiblePieces: [component], focusPiece: component, scrubEnabled: false };
}
export interface PieceXform {
  /** Local position [x,y,z] in mm. */
  pos: [number, number, number];
  /** Local euler rotation [rx,ry,rz] in radians (YXZ, matching the engine). */
  rot: [number, number, number];
}
export type CDKitPose = Record<CDPiece, PieceXform>;

export interface CDCaseDims { width: number; height: number; thickness: number; }

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Fully-open lid angle (a jewel case opens a bit past 90°). */
export const CD_LID_OPEN_RAD = (110 * Math.PI) / 180;

/** Piece widths (mm) — the real print sizes (front insert / booklet = 120 square; disc = 120 Ø; tray card = 150
 *  flat). The front insert, booklet AND disc are all RIGHT-aligned to the case's right inner edge (so the disc
 *  sits UNDER the booklet — real cases put the disc bed right-of-the-spine, not centred), leaving the left spine
 *  buffer. Tray card + case shells stay centred. */
export const CD_PIECE_WIDTH: Record<CDPiece, number> = {
  lid: CD_CASE.width, trayBack: CD_CASE.width, disc: 120, frontInsert: 120, booklet: 120, trayCard: 150,
};

/** Closed stacking order along z (front + → back −). The TRAY BACK is the anchor at z=0 and never moves. */
const CLOSED_Z: Record<CDPiece, number> = {
  lid: 2.5, frontInsert: 2, booklet: 1.5, disc: 1, trayBack: 0, trayCard: -1,
};

/** How far (mm) one CLOSED_Z unit fans out at full explode. */
const EXPLODE_STEP = 14;

/** Case wall thickness (mm) — matches CD_CASE_SHELL.wall; the inner edge is this far inside the outer. */
const CD_CASE_WALL = 2;

/** The x-offset (mm) of the disc centre from the case centre — the disc (+ its tray hub/bed) is right-aligned to
 *  the inner edge, so the tray geometry offsets the hub/bed by this to sit under the disc. */
export function cdDiscOffsetX(dims: CDCaseDims): number { return dims.width / 2 - CD_CASE_WALL - CD_PIECE_WIDTH.disc / 2; }

export function cdKitAssembly(dims: CDCaseDims, t: number): CDKitPose {
  const tc = clamp01(t);
  const open = smoothstep(0, 0.6, tc);     // lid-rotation phase
  const spread = smoothstep(0.4, 1, tc);   // piece-separation phase
  const xspine = -dims.width / 2;          // the left edge / spine — the fixed hinge line
  const theta = open * CD_LID_OPEN_RAD;
  const quarter = dims.thickness / 4;
  const innerRight = dims.width / 2 - CD_CASE_WALL;

  // The lid hinges on the left spine edge and opens FORWARD (toward +z / the viewer) about the fixed vertical
  // spine axis — only the rotation opens it, the hinge never translates. Centre = hinge + Ry(−θ)·[halfW,0,0].
  const lidHalf = CD_PIECE_WIDTH.lid / 2;
  const lidHingeZ = CLOSED_Z.lid * quarter;   // the lid plane's z when closed — the hinge sits on it

  // Rotate a CLOSED point (px0, pz0) rigidly with the lid about the spine hinge at (xspine, lidHingeZ): its +X
  // offset swings toward +z as the lid opens (this reproduces the lid centre below). Returns the opened [x, z].
  const lidRot = (px0: number, pz0: number): [number, number] => {
    const dx = px0 - xspine, dz = pz0 - lidHingeZ;
    return [xspine + dx * Math.cos(theta) - dz * Math.sin(theta), lidHingeZ + dx * Math.sin(theta) + dz * Math.cos(theta)];
  };

  const [lidX, lidZ] = lidRot(xspine + lidHalf, lidHingeZ);
  const lid: PieceXform = { pos: [lidX, 0, lidZ], rot: [0, -theta, 0] };

  // FRONT INSERT + BOOKLET are held in the LID by the retainer tabs, so they OPEN WITH THE FRONT COVER — same
  // hinge, same rotation — lifting away to reveal the disc. Right-aligned in X (closed look unchanged), nested
  // just inside the lid, separating a little further along the cover's inner face as the explode scrub runs.
  const xLidPiece = innerRight - CD_PIECE_WIDTH.frontInsert / 2;   // insert + booklet share the 120 width
  const LID_FAN = EXPLODE_STEP * 0.4;
  const lidAttached = (piece: CDPiece, rank: number): PieceXform => {
    const pz0 = CLOSED_Z[piece] * quarter - spread * LID_FAN * rank;   // push off the cover's inner face on explode
    const [px, pz] = lidRot(xLidPiece, pz0);
    return { pos: [px, 0, pz], rot: [0, -theta, 0] };
  };

  // TRAY PIECES stay in the tray (no rotation): the DISC on its right-aligned hub (revealed when the cover opens),
  // the TRAY CARD centred in the back, the TRAY BACK the fixed z=0 anchor. They fan along z as the case explodes.
  const xTray = (piece: CDPiece): number => piece === 'disc' ? innerRight - CD_PIECE_WIDTH.disc / 2 : 0;
  const zTray = (piece: CDPiece): number => CLOSED_Z[piece] * quarter + spread * CLOSED_Z[piece] * EXPLODE_STEP;
  const trayFlat = (piece: CDPiece): PieceXform => ({ pos: [xTray(piece), 0, zTray(piece)], rot: [0, 0, 0] });

  return {
    lid,
    trayBack: trayFlat('trayBack'),   // z = 0, the fixed anchor
    disc: trayFlat('disc'),           // right-aligned on the tray hub — revealed when the cover swings open
    frontInsert: lidAttached('frontInsert', 1),
    booklet: lidAttached('booklet', 2),
    trayCard: trayFlat('trayCard'),
  };
}
