/**
 * src/packaging/cd/cd-kit.ts
 *
 * The CD-KIT builder — assembles the jewel-case "Complete" view: a root group holding six pieces (clear
 * LID + dark TRAY shells, the DISC, and the FRONT-INSERT / TRAY-CARD / BOOKLET art planes), positioned by
 * the pure cdKitAssembly() scrub so one slider plays closed → lid-open → exploded. Decoupled from the engine
 * via CDKitHost (the ShapeManager supplies the adapter), exactly like PackagingManager/PackagingHost, so the
 * geometry + layout logic is unit-testable without a GPU.
 *
 * All geometry + positions are in MILLIMETRES; the host scales the root group by MM_TO_WORLD.
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { type MeshGeometry as _MeshGeom, generateSprite } from '../../renderer/3d/mesh-generators';
import { generateCDDisc, CD_DISC } from './cd-disc-geometry';
import { generateCaseShell, CD_CASE_SHELL } from './cd-case-geometry';
import { cdTrayCard } from '../templates/cd-tray-card';
import { compileFoldMesh } from '../fold-mesh';

/**
 * The tray card as a foldable mesh: compile its 3-panel net (back + 2 spine flaps) at `fold` (0 flat → 1 flaps
 * folded 90°), then rotate the horizontal net upright (+90° about X) into the kit's XY orientation. One mesh with
 * the template's continuous UVs, so uploaded art maps across the fold. Re-compiled whenever the fold changes.
 */
export function compileTrayCardFold(fold: number): _MeshGeom {
  const data = cdTrayCard({ width: 0, height: 0, depth: 0 }).foldMeshData;
  const g = compileFoldMesh(data, Math.max(0, Math.min(1, fold)));
  const stride = g.format === '12float' ? 12 : 8;   // compileFoldMesh emits 8float (pos+normal+uv)
  const v = g.vertices;
  for (let i = 0; i < v.length; i += stride) {
    const y = v[i + 1], z = v[i + 2];               // pos: (x,y,z) → (x,-z,y)  [+90° about X, upright + right-side-up]
    v[i + 1] = -z; v[i + 2] = y;
    const ny = v[i + 4], nz = v[i + 5];
    v[i + 4] = -nz; v[i + 5] = ny;
  }
  return g;
}
import { CD_TRAY_CARD } from '../templates/cd-tray-card';
import { CD_FRONT_INSERT } from '../templates/cd-front-insert';
import { cdKitAssembly, cdDiscOffsetX, CD_CASE, CD_ALL_PIECES, type CDPiece, type CDCaseDims } from './cd-kit-assembly';

/** mm → world scale (shared with the packaging fold engine). */
export const CD_MM_TO_WORLD = 0.02;

/** Loose material shape — the adapter maps this onto the engine's Material3D. */
export interface CDPieceMaterial {
  diffuse: { r: number; g: number; b: number; a: number };
  opacity?: number;
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  unlit?: boolean;
  /** Disc only: the iridescent-CD render style (Zucconi rainbow; label on the front face). */
  cd?: boolean;
  /** Fresnel rim/edge glow — what makes clear plastic read as clear plastic (bright edges, invisible faces). */
  rimEnabled?: boolean;
  /** Screen-space refraction — the case contents show THROUGH the clear plastic (turns the lid clear, not frosted). */
  glassEnhance?: boolean;
}

/** The primitives the builder needs from the host. */
export interface CDKitHost {
  /** Create the kit root container; the host applies CD_MM_TO_WORLD scale so children in mm render true-size. */
  createRoot(name: string): string;
  /** Create a mesh from geometry under a parent; returns the node id. */
  createMesh(geometry: MeshGeometry, material: CDPieceMaterial, name: string, parentId: string): string;
  /** Set a node's LOCAL transform — position in mm, rotation as YXZ euler radians. */
  setTransform(nodeId: string, posMm: [number, number, number], rotRad: [number, number, number]): void;
  /** Upload an image onto a piece's diffuse (the art-mapping path). */
  setTexture(nodeId: string, source: unknown): Promise<boolean>;
  /** Re-apply a material to a piece (the clear/black tray toggle). */
  setMaterial(nodeId: string, material: CDPieceMaterial): void;
  /** Swap a piece's geometry in place (the tray-card fold re-mesh). */
  setGeometry(nodeId: string, geometry: _MeshGeom): void;
  /** Remove a node (+ its subtree). */
  removeNode(nodeId: string): void;
}

export interface CDKitState {
  rootId: string;
  pieces: Record<CDPiece, string>;
  dims: CDCaseDims;
  /** Current scrub 0..1. */
  scrub: number;
  /** All-clear case (clear tray) vs the classic black tray. */
  clearTray: boolean;
  /** Tray-card fold 0 (flat) → 1 (spine flaps folded 90°). */
  trayCardFold: number;
}

// Clear plastic — screen-space REFRACTION so the case contents show through (clear, not frosted), a Fresnel RIM so
// edges glow, and enough base opacity that the FLAT panel still reads as a surface from behind (at 0.34 the far side
// of the open lid vanished). doubleSided so both faces of the shell draw.
const GLASS: CDPieceMaterial = { diffuse: { r: 0.82, g: 0.88, b: 0.94, a: 1 }, opacity: 0.44, roughness: 0.06, metalness: 0, doubleSided: true, rimEnabled: true, glassEnhance: true };
const TRAY: CDPieceMaterial = { diffuse: { r: 0.06, g: 0.06, b: 0.07, a: 1 }, roughness: 0.5, metalness: 0, doubleSided: true };
/** Blank art surfaces (front insert / tray card / booklet): unlit so uploaded art shows true colour. */
const ART: CDPieceMaterial = { diffuse: { r: 0.85, g: 0.85, b: 0.86, a: 1 }, unlit: true, doubleSided: true };
/** The disc: iridescent CD render style (rainbow + silver); an uploaded label shows on the front face only. */
const DISC: CDPieceMaterial = { diffuse: { r: 0.8, g: 0.8, b: 0.82, a: 1 }, cd: true, doubleSided: true };


/** Build the geometry for one piece (mm). */
function pieceGeometry(piece: CDPiece, dims: CDCaseDims): MeshGeometry {
  switch (piece) {
    // Case shells are shallow open TRAYS (hollow inset), opening toward each other. The LID (clear, front) opens
    // back toward the contents and carries the 4 booklet-retainer tabs; the TRAY (black, back) opens forward.
    case 'lid':       return generateCaseShell(dims.width, dims.height, CD_CASE_SHELL.depth, 1, true, false, false);
    case 'trayBack':  return generateCaseShell(dims.width, dims.height, CD_CASE_SHELL.depth, -1, false, true, true, cdDiscOffsetX(dims));   // + hub/disc-bed (offset under the disc), ribbed spine
    case 'disc':      return generateCDDisc(CD_DISC.outerR, CD_DISC.innerR, 72);
    // Printed pieces use the SPRITE quad (XY plane, +Z normal, V pre-flipped so uploaded art is upright) so they
    // stand upright facing the camera — matching the disc + case, not lying flat like generatePlane's XZ quad.
    case 'frontInsert':
    case 'booklet':   return generateSprite(CD_FRONT_INSERT.size, CD_FRONT_INSERT.size);   // 120² print size
    case 'trayCard':  return compileTrayCardFold(0);   // foldable (back + 2 spine flaps); re-meshed on fold change
  }
}

function pieceMaterial(piece: CDPiece, clearTray: boolean): CDPieceMaterial {
  if (piece === 'lid') return GLASS;
  if (piece === 'trayBack') return clearTray ? GLASS : TRAY;   // all-clear vs the classic black tray
  if (piece === 'disc') return DISC;
  return ART;
}
/** The material for a piece — exported so a runtime style toggle can re-apply it. */
export function cdPieceMaterial(piece: CDPiece, clearTray: boolean): CDPieceMaterial { return pieceMaterial(piece, clearTray); }

const ALL_PIECES = CD_ALL_PIECES;

/** Build the six piece meshes under `rootId` (shared by create + restore). Piece NAMES are stable so persisted
 *  art (keyed containerId:childName) re-attaches after a rebuild. */
function buildCDKitPieces(host: CDKitHost, rootId: string, dims: CDCaseDims, clearTray: boolean): Record<CDPiece, string> {
  const pieces = {} as Record<CDPiece, string>;
  for (const piece of ALL_PIECES) {
    pieces[piece] = host.createMesh(pieceGeometry(piece, dims), pieceMaterial(piece, clearTray), pieceLabel(piece), rootId);
  }
  return pieces;
}

/** Build the kit (new root) and seat it closed (scrub 0). `clearTray` = all-clear case vs the black tray. */
export function createCDKit(host: CDKitHost, dims: CDCaseDims = { ...CD_CASE }, clearTray = false): CDKitState {
  const rootId = host.createRoot('CD Kit');
  const state: CDKitState = { rootId, pieces: buildCDKitPieces(host, rootId, dims, clearTray), dims, scrub: 0, clearTray, trayCardFold: 0 };
  setCDKitScrub(host, state, 0);
  return state;
}

/** Rebuild the pieces under an ALREADY-restored root (persistence path) + seat at the saved scrub. The root
 *  node (with its stable id + worldParams marker) survives the document save; only its regenerable pieces are
 *  rebuilt here, so persisted art re-attaches by (rootId, piece name). */
export function rebuildCDKitUnderRoot(host: CDKitHost, rootId: string, scrub: number, dims: CDCaseDims = { ...CD_CASE }, clearTray = false): CDKitState {
  const state: CDKitState = { rootId, pieces: buildCDKitPieces(host, rootId, dims, clearTray), dims, scrub: 0, clearTray, trayCardFold: 0 };
  setCDKitScrub(host, state, scrub);
  return state;
}

/** Set the tray-card fold (0 flat → 1 flaps folded 90°) — re-meshes the tray card in place. */
export function setCDTrayCardFold(host: CDKitHost, state: CDKitState, fold: number): void {
  state.trayCardFold = Math.max(0, Math.min(1, fold));
  host.setGeometry(state.pieces.trayCard, compileTrayCardFold(state.trayCardFold));
}

/** Toggle the case between the classic black tray and all-clear (re-materialises just the tray mesh). */
export function setCDTrayClear(host: CDKitHost, state: CDKitState, clear: boolean): void {
  state.clearTray = clear;
  host.setMaterial(state.pieces.trayBack, pieceMaterial('trayBack', clear));
}

/** Apply the assembly pose for scrub `t` to every piece. The tray card's spine flaps STRAIGHTEN as the case
 *  opens (fold = 1 − scrub): fully wrapped when closed, flat when open at 100%. */
export function setCDKitScrub(host: CDKitHost, state: CDKitState, t: number): void {
  const pose = cdKitAssembly(state.dims, t);
  for (const piece of ALL_PIECES) host.setTransform(state.pieces[piece], pose[piece].pos, pose[piece].rot);
  state.scrub = Math.max(0, Math.min(1, t));
  setCDTrayCardFold(host, state, 1 - state.scrub);
}

/** Upload art onto one piece (front insert / tray card / disc / booklet). */
export function setCDPieceArt(host: CDKitHost, state: CDKitState, piece: CDPiece, source: unknown): Promise<boolean> {
  return host.setTexture(state.pieces[piece], source);
}

export function removeCDKit(host: CDKitHost, state: CDKitState): void {
  host.removeNode(state.rootId);
}

function pieceLabel(piece: CDPiece): string {
  return { lid: 'Lid', trayBack: 'Tray', disc: 'Disc', frontInsert: 'Front Insert', booklet: 'Booklet', trayCard: 'Tray Card' }[piece];
}
