/**
 * UVEditManager — UV editing operations with undo/redo.
 *
 * Covers Phase 4: 2D UV transforms (move/scale/rotate/mirror),
 * weld, split-to-seam, and pin operations.
 *
 * All mutating ops snapshot UV and seam state before/after and push
 * a command onto the 3D undo stack. Pin ops are session-only (no undo).
 *
 * UV coordinates live per FACE CORNER (`EditMesh.cornerUV(hi)`: the half-edge's own `uv`, else its vertex's —
 * docs/specs/edit-mesh-topology.md). Operations work on whichever corners the session selection implies:
 *   vertex mode  → every corner of the selected vertices
 *   face mode    → the corners of the selected faces
 *   edge mode    → the selected half-edge's two corners (in its face)
 * plus, "sticky" (Blender's shared-location default), every other corner of the same vertex that shows the same
 * UV — so a UV island moves as one piece while a seam (a vertex whose corners differ) stays cut. On a mesh with
 * per-vertex UVs only that is exactly the old per-vertex behaviour.
 */

import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import type { UVEditorSession } from './uv-canvas-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';

// ── Snapshot types ────────────────────────────────────────────────────────────

/** UV snapshot: per-vertex fallback UVs + per-corner (half-edge) UVs, undefined = none. */
type UVSnapshot  = { v: Array<[number, number] | undefined>; h: Array<[number, number] | undefined> };
/** Seam snapshot: half-edge index → isSeam value. */
type SeamSnapshot = boolean[];

// ── Manager ───────────────────────────────────────────────────────────────────

export class UVEditManager {
  constructor(
    private readonly ctx:         ManagerContext,
    private readonly pushCommand: (cmd: Command3D) => void,
    private readonly getSession:  (meshId: string) => UVEditorSession | null,
  ) {}

  // ── Transform — UV coordinate changes ────────────────────────────────────

  /** Translate selected UVs by (du, dv) in UV space. Undoable. */
  moveSelected(meshId: string, du: number, dv: number): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const corners = _selectedCorners(session, em);
    if (corners.length === 0) return false;

    const before = _snapUVs(em);
    _mapCorners(em, corners, (u, v) => [u + du, v + dv]);
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Move UVs',
      undo: () => { _restoreUVs(em, before);  mesh.syncFromEditMesh(); },
      redo: () => { _restoreUVs(em, after);   mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Scale selected UVs around the selection bounding-box centre. Undoable. */
  scaleSelected(meshId: string, su: number, sv: number): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const corners = _selectedCorners(session, em);
    if (corners.length === 0) return false;

    const [cu, cv] = _bboxCenter(corners, em);
    const before = _snapUVs(em);
    _mapCorners(em, corners, (u, v) => [cu + (u - cu) * su, cv + (v - cv) * sv]);
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Scale UVs',
      undo: () => { _restoreUVs(em, before);  mesh.syncFromEditMesh(); },
      redo: () => { _restoreUVs(em, after);   mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Rotate selected UVs around the selection bounding-box centre. Undoable. */
  rotateSelected(meshId: string, angleRad: number): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const corners = _selectedCorners(session, em);
    if (corners.length === 0) return false;

    const [cu, cv] = _bboxCenter(corners, em);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const before = _snapUVs(em);
    _mapCorners(em, corners, (u, v) => {
      const du = u - cu, dv = v - cv;
      return [cu + du * cos - dv * sin, cv + du * sin + dv * cos];
    });
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Rotate UVs',
      undo: () => { _restoreUVs(em, before);  mesh.syncFromEditMesh(); },
      redo: () => { _restoreUVs(em, after);   mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /**
   * Mirror selected UVs around the selection centre on the given axis.
   * `axis: 'u'` flips horizontally; `axis: 'v'` flips vertically. Undoable.
   */
  mirrorSelected(meshId: string, axis: 'u' | 'v'): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const corners = _selectedCorners(session, em);
    if (corners.length === 0) return false;

    const [cu, cv] = _bboxCenter(corners, em);
    const before = _snapUVs(em);
    _mapCorners(em, corners, (u, v) => (axis === 'u' ? [2 * cu - u, v] : [u, 2 * cv - v]));
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: `Mirror UVs (${axis})`,
      undo: () => { _restoreUVs(em, before);  mesh.syncFromEditMesh(); },
      redo: () => { _restoreUVs(em, after);   mesh.syncFromEditMesh(); },
    });
    return true;
  }

  // ── Weld / split ──────────────────────────────────────────────────────────

  /**
   * Weld selected UV vertices that are within `threshold` UV units of each other.
   * Snaps both vertices to the midpoint and clears seam flags on interior edges
   * between welded vertex pairs. Undoable.
   */
  weldSelected(meshId: string, threshold = 0.001): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const corners = _selectedCorners(session, em);
    if (corners.length === 0) return false;

    const uvBefore   = _snapUVs(em);
    const seamBefore = _snapSeams(em);

    const thresh2 = threshold * threshold;
    const cur = corners.map(hi => em.cornerUV(hi));
    for (let i = 0; i < corners.length; i++) {
      const uvI = cur[i];
      if (!uvI) continue;
      for (let j = i + 1; j < corners.length; j++) {
        const uvJ = cur[j];
        if (!uvJ) continue;
        const du = uvI[0] - uvJ[0], dv = uvI[1] - uvJ[1];
        if (du * du + dv * dv <= thresh2) {
          const mid: [number, number] = [(uvI[0] + uvJ[0]) * 0.5, (uvI[1] + uvJ[1]) * 0.5];
          cur[i] = mid; cur[j] = [mid[0], mid[1]];
          const vi = em.halfEdges[corners[i]].vertex, vj = em.halfEdges[corners[j]].vertex;
          if (vi !== vj) _clearEdgeBetween(em, vi, vj);
        }
      }
    }
    corners.forEach((hi, i) => { const uv = cur[i]; if (uv) em.setCornerUV(hi, uv); });

    const uvAfter   = _snapUVs(em);
    const seamAfter = _snapSeams(em);
    mesh.syncFromEditMesh();
    session.invalidateIslands();

    this.pushCommand({
      description: 'Weld UVs',
      undo: () => { _restoreUVs(em, uvBefore);   _restoreSeams(em, seamBefore); mesh.syncFromEditMesh(); session.invalidateIslands(); },
      redo: () => { _restoreUVs(em, uvAfter);    _restoreSeams(em, seamAfter);  mesh.syncFromEditMesh(); session.invalidateIslands(); },
    });
    return true;
  }

  /**
   * Mark all selected edges as UV seams, splitting the islands at those edges.
   * Only valid in edge selection mode. Undoable.
   */
  splitSelected(meshId: string): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    if (session.selection.mode !== 'edge') return false;

    const heIndices = [...session.selection.edges];
    if (heIndices.length === 0) return false;

    const before = _snapSeams(em);
    em.markSeams(heIndices);
    const after = _snapSeams(em);
    session.invalidateIslands();

    this.pushCommand({
      description: 'Split UV edges',
      undo: () => { _restoreSeams(em, before); session.invalidateIslands(); },
      redo: () => { _restoreSeams(em, after);  session.invalidateIslands(); },
    });
    return true;
  }

  // ── Unwrap / pack ─────────────────────────────────────────────────────────

  /**
   * Island-aware smart project: each island is projected independently using its
   * average face normal, then left in place (islands may overlap). Call
   * `packIslands` afterward to separate them. Undoable.
   */
  unwrapIslands(meshId: string): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const before = _snapUVs(em);
    em.unwrapIslands();
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();
    session.invalidateIslands();
    this.pushCommand({
      description: 'Unwrap Islands',
      undo: () => { _restoreUVs(em, before); mesh.syncFromEditMesh(); session.invalidateIslands(); },
      redo: () => { _restoreUVs(em, after);  mesh.syncFromEditMesh(); session.invalidateIslands(); },
    });
    return true;
  }

  /**
   * Project every vertex onto the plane perpendicular to `faceIndex`'s normal.
   * Equivalent to Blender's "Follow Active Quads" in flat-projection mode. Undoable.
   */
  followActiveFace(meshId: string, faceIndex: number): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    if (faceIndex < 0 || faceIndex >= em.faces.length) return false;
    const before = _snapUVs(em);
    em.unwrapFollowActive(faceIndex);
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();
    session.invalidateIslands();
    this.pushCommand({
      description: 'Follow Active Face UV',
      undo: () => { _restoreUVs(em, before); mesh.syncFromEditMesh(); session.invalidateIslands(); },
      redo: () => { _restoreUVs(em, after);  mesh.syncFromEditMesh(); session.invalidateIslands(); },
    });
    return true;
  }

  /**
   * Shelf-pack all UV islands into [0, 1] UV space with a uniform margin.
   * Does not change island shape, only position. Undoable.
   */
  packIslands(meshId: string, margin = 0.002): boolean {
    const { mesh, em, session } = this._get(meshId);
    if (!mesh || !em || !session) return false;
    const before = _snapUVs(em);
    em.packUVIslands(margin);
    const after = _snapUVs(em);
    mesh.syncFromEditMesh();
    session.invalidateIslands();
    this.pushCommand({
      description: 'Pack UV Islands',
      undo: () => { _restoreUVs(em, before); mesh.syncFromEditMesh(); session.invalidateIslands(); },
      redo: () => { _restoreUVs(em, after);  mesh.syncFromEditMesh(); session.invalidateIslands(); },
    });
    return true;
  }

  // ── Pin (session state only — no undo needed) ─────────────────────────────

  /** Pin selected vertices so subsequent unwrap operations leave them fixed. */
  pinSelected(meshId: string): void {
    const { em, session } = this._get(meshId);
    if (!em || !session) return;
    for (const hi of _selectedCorners(session, em)) session.pinnedVertices.add(em.halfEdges[hi].vertex);
  }

  /** Unpin selected vertices. */
  unpinSelected(meshId: string): void {
    const { em, session } = this._get(meshId);
    if (!em || !session) return;
    for (const hi of _selectedCorners(session, em)) session.pinnedVertices.delete(em.halfEdges[hi].vertex);
  }

  /** Remove all pins. */
  unpinAll(meshId: string): void {
    this.getSession(meshId)?.pinnedVertices.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _get(meshId: string): { mesh: Mesh3D | null; em: EditMesh | null; session: UVEditorSession | null } {
    const node = this.ctx.sceneGraph.findNodeById(meshId);
    const mesh = node instanceof Mesh3D ? node : null;
    const em = mesh?.editMesh ?? null;
    return { mesh, em, session: this.getSession(meshId) };
  }
}

// ── Module-private helpers ────────────────────────────────────────────────────

/** The face corners (half-edge indices) the current selection implies, plus the sticky ones: every other corner of
 *  the same vertex showing the same UV as a selected corner. */
function _selectedCorners(session: UVEditorSession, em: EditMesh): number[] {
  const H = em.halfEdges;
  const base = new Set<number>();
  if (session.selection.mode === 'vertex') {
    const vs = session.selection.vertices;
    H.forEach((he, hi) => { if (he.face >= 0 && vs.has(he.vertex)) base.add(hi); });
    return [...base];
  }
  if (session.selection.mode === 'face') {
    for (const fi of session.selection.faces) {
      let hi = em.faces[fi]?.halfEdge ?? -1;
      const start = hi;
      let guard = 0;
      do {
        if (hi < 0) break;
        base.add(hi);
        hi = H[hi].next;
        if (++guard > 1000) break;
      } while (hi !== start);
    }
  } else {
    // edge mode: the half-edge's two corners (its destination = he, its origin = he.prev)
    for (const hi of session.selection.edges) {
      const he = H[hi];
      if (!he) continue;
      base.add(hi);
      base.add(he.prev);
    }
  }
  if (base.size === 0) return [];
  const byVert = new Map<number, number[]>();
  H.forEach((he, hi) => {
    if (he.face < 0) return;
    const l = byVert.get(he.vertex);
    if (l) l.push(hi); else byVert.set(he.vertex, [hi]);
  });
  const out = new Set(base);
  for (const hi of base) {
    const uv = em.cornerUV(hi);
    for (const c of byVert.get(H[hi].vertex) ?? []) if (!out.has(c) && _sameUV(uv, em.cornerUV(c))) out.add(c);
  }
  return [...out];
}

function _sameUV(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(a[0] - b[0]) <= 1e-6 && Math.abs(a[1] - b[1]) <= 1e-6;
}

/** Map the UV of every listed corner through `fn` (all read first, so corners sharing a vertex UV map once). */
function _mapCorners(em: EditMesh, corners: number[], fn: (u: number, v: number) => [number, number]): void {
  const cur = corners.map(hi => em.cornerUV(hi));
  corners.forEach((hi, i) => { const uv = cur[i]; if (uv) em.setCornerUV(hi, fn(uv[0], uv[1])); });
}

/** Bounding-box centre of the UV coordinates of the given corners. */
function _bboxCenter(corners: number[], em: EditMesh): [number, number] {
  let uMin = Infinity, vMin = Infinity, uMax = -Infinity, vMax = -Infinity;
  let any = false;
  for (const hi of corners) {
    const uv = em.cornerUV(hi);
    if (!uv) continue;
    any = true;
    if (uv[0] < uMin) uMin = uv[0];
    if (uv[1] < vMin) vMin = uv[1];
    if (uv[0] > uMax) uMax = uv[0];
    if (uv[1] > vMax) vMax = uv[1];
  }
  return any ? [(uMin + uMax) * 0.5, (vMin + vMax) * 0.5] : [0.5, 0.5];
}

/** Every UV the mesh holds: vertex fallbacks and corner UVs. */
function _snapUVs(em: EditMesh): UVSnapshot {
  return {
    v: em.vertices.map(v => (v.uv ? [v.uv[0], v.uv[1]] as [number, number] : undefined)),
    h: em.halfEdges.map(he => (he.uv ? [he.uv[0], he.uv[1]] as [number, number] : undefined)),
  };
}

function _restoreUVs(em: EditMesh, snap: UVSnapshot): void {
  for (let i = 0; i < em.vertices.length; i++) {
    const uv = snap.v[i];
    em.vertices[i].uv = uv ? [uv[0], uv[1]] : undefined;
  }
  for (let i = 0; i < em.halfEdges.length; i++) {
    const uv = snap.h[i];
    em.halfEdges[i].uv = uv ? [uv[0], uv[1]] : undefined;
  }
}

function _snapSeams(em: EditMesh): SeamSnapshot {
  return em.halfEdges.map(he => he.isSeam);
}

function _restoreSeams(em: EditMesh, snap: SeamSnapshot): void {
  for (let i = 0; i < snap.length; i++) {
    if (em.halfEdges[i]) em.halfEdges[i].isSeam = snap[i];
  }
}

/** Clear isSeam on any half-edge running between vertex `vi` and vertex `vj`. */
function _clearEdgeBetween(em: EditMesh, vi: number, vj: number): void {
  for (let hi = 0; hi < em.halfEdges.length; hi++) {
    const he = em.halfEdges[hi];
    const src = em.halfEdges[he.prev].vertex;
    if ((src === vi && he.vertex === vj) || (src === vj && he.vertex === vi)) {
      he.isSeam = false;
      if (he.twin >= 0) em.halfEdges[he.twin].isSeam = false;
    }
  }
}
