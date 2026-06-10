/**
 * UVEditManager — UV editing operations with undo/redo.
 *
 * Covers Phase 4: 2D UV transforms (move/scale/rotate/mirror),
 * weld, split-to-seam, and pin operations.
 *
 * All mutating ops snapshot UV and seam state before/after and push
 * a command onto the 3D undo stack. Pin ops are session-only (no undo).
 *
 * UV coordinates live on `EditVertex.uv?: [number, number]` — one per vertex.
 * Operations work on whichever vertices the session selection implies:
 *   vertex mode  → selected vertex indices
 *   face mode    → all vertices of selected faces
 *   edge mode    → both endpoints of each selected half-edge
 */

import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import type { UVEditorSession } from './uv-canvas-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';

// ── Snapshot types ────────────────────────────────────────────────────────────

/** UV snapshot: index → [u, v] | undefined. Sparse — only stores assigned UVs. */
type UVSnapshot  = Map<number, [number, number]>;
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
    const verts = _selectedVerts(session, em);
    if (verts.size === 0) return false;

    const before = _snapUVs(em);
    for (const vi of verts) {
      const uv = em.vertices[vi].uv;
      if (uv) em.vertices[vi].uv = [uv[0] + du, uv[1] + dv];
    }
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
    const verts = _selectedVerts(session, em);
    if (verts.size === 0) return false;

    const [cu, cv] = _bboxCenter(verts, em);
    const before = _snapUVs(em);
    for (const vi of verts) {
      const uv = em.vertices[vi].uv;
      if (uv) em.vertices[vi].uv = [cu + (uv[0] - cu) * su, cv + (uv[1] - cv) * sv];
    }
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
    const verts = _selectedVerts(session, em);
    if (verts.size === 0) return false;

    const [cu, cv] = _bboxCenter(verts, em);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const before = _snapUVs(em);
    for (const vi of verts) {
      const uv = em.vertices[vi].uv;
      if (!uv) continue;
      const du = uv[0] - cu, dv = uv[1] - cv;
      em.vertices[vi].uv = [cu + du * cos - dv * sin, cv + du * sin + dv * cos];
    }
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
    const verts = _selectedVerts(session, em);
    if (verts.size === 0) return false;

    const [cu, cv] = _bboxCenter(verts, em);
    const before = _snapUVs(em);
    for (const vi of verts) {
      const uv = em.vertices[vi].uv;
      if (!uv) continue;
      em.vertices[vi].uv = axis === 'u'
        ? [2 * cu - uv[0], uv[1]]
        : [uv[0], 2 * cv - uv[1]];
    }
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
    const verts = _selectedVerts(session, em);
    if (verts.size === 0) return false;

    const uvBefore   = _snapUVs(em);
    const seamBefore = _snapSeams(em);

    const vertArr = [...verts];
    const thresh2 = threshold * threshold;
    for (let i = 0; i < vertArr.length; i++) {
      const vi = vertArr[i];
      const uvI = em.vertices[vi].uv;
      if (!uvI) continue;
      for (let j = i + 1; j < vertArr.length; j++) {
        const vj = vertArr[j];
        const uvJ = em.vertices[vj].uv;
        if (!uvJ) continue;
        const du = uvI[0] - uvJ[0], dv = uvI[1] - uvJ[1];
        if (du * du + dv * dv <= thresh2) {
          const mid: [number, number] = [(uvI[0] + uvJ[0]) * 0.5, (uvI[1] + uvJ[1]) * 0.5];
          em.vertices[vi].uv = mid;
          em.vertices[vj].uv = [...mid];
          _clearEdgeBetween(em, vi, vj);
        }
      }
    }

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
    for (const vi of _selectedVerts(session, em)) session.pinnedVertices.add(vi);
  }

  /** Unpin selected vertices. */
  unpinSelected(meshId: string): void {
    const { em, session } = this._get(meshId);
    if (!em || !session) return;
    for (const vi of _selectedVerts(session, em)) session.pinnedVertices.delete(vi);
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

/** Build the set of vertex indices implied by the current selection. */
function _selectedVerts(session: UVEditorSession, em: EditMesh): Set<number> {
  const result = new Set<number>();
  if (session.selection.mode === 'vertex') {
    for (const vi of session.selection.vertices) result.add(vi);
  } else if (session.selection.mode === 'face') {
    for (const fi of session.selection.faces) {
      let hi = em.faces[fi]?.halfEdge ?? -1;
      const start = hi;
      let guard = 0;
      do {
        if (hi < 0) break;
        result.add(em.halfEdges[hi].vertex);
        hi = em.halfEdges[hi].next;
        if (++guard > 64) break;
      } while (hi !== start);
    }
  } else {
    // edge mode: both endpoints of each selected half-edge
    for (const hi of session.selection.edges) {
      const he = em.halfEdges[hi];
      if (!he) continue;
      result.add(he.vertex);
      result.add(em.halfEdges[he.prev].vertex);
    }
  }
  return result;
}

/** Bounding-box centre of the UV coordinates of the given vertex set. */
function _bboxCenter(verts: Set<number>, em: EditMesh): [number, number] {
  let uMin = Infinity, vMin = Infinity, uMax = -Infinity, vMax = -Infinity;
  let any = false;
  for (const vi of verts) {
    const uv = em.vertices[vi].uv;
    if (!uv) continue;
    any = true;
    if (uv[0] < uMin) uMin = uv[0];
    if (uv[1] < vMin) vMin = uv[1];
    if (uv[0] > uMax) uMax = uv[0];
    if (uv[1] > vMax) vMax = uv[1];
  }
  return any ? [(uMin + uMax) * 0.5, (vMin + vMax) * 0.5] : [0.5, 0.5];
}

function _snapUVs(em: EditMesh): UVSnapshot {
  const snap: UVSnapshot = new Map();
  for (let i = 0; i < em.vertices.length; i++) {
    const uv = em.vertices[i].uv;
    if (uv) snap.set(i, [uv[0], uv[1]]);
  }
  return snap;
}

function _restoreUVs(em: EditMesh, snap: UVSnapshot): void {
  for (let i = 0; i < em.vertices.length; i++) {
    em.vertices[i].uv = snap.get(i);
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
