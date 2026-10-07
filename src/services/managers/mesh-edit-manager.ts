/**
 * MeshEditManager — EditMesh authoring: selection state, destructive operations, modifier stack.
 *
 * All topology-changing operations (extrude, inset, delete, weld, applyModifier) are
 * pushed onto the UndoManager3D as snapshot-based commands. Snapshot approach:
 * serialize the EditMesh to JSON before the op, restore it on undo, re-apply on redo.
 * Simple and correct; mesh sizes are small enough (hundreds of polys) that JSON round-trips
 * are fast.
 *
 * `makeEditable()` builds the EditMesh from the geometry the mesh renders (welded topology + quads,
 * EditMesh.fromGeometry), then calls syncFromEditMesh() to push the compiled result back.
 *
 * Phase 2: makeEditable, vertex drag, extrude, inset, delete, weld, vertex colors,
 * MirrorModifier, SubdivisionModifier, selection queries.
 *
 * Phase 3: loop cut, edge dissolve, bevel — shipped. Knife + auto-UV remaining.
 */

import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { EditMesh, MirrorModifier, SubdivisionModifier, DisplaceModifier, remapFace, type FaceList, type BevelSpec, type KnifePoint, type KnifeOptions } from '../../scene-graph/shapes/edit-mesh';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

export interface EditSelection {
  meshId: string;
  vertices: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

/** The parametric ops "adjust last operation" can re-run (getMeshEditLastOp3D / redoMeshEditLastOp3D). */
export type MeshEditLastOpName = 'extrudeRegion' | 'insetRegion' | 'bevel' | 'loopCut' | 'subdivide';

/** The last parametric op as the host shows it (the operation pill / Blender's F9 panel). */
export interface MeshEditLastOp {
  op: MeshEditLastOpName;
  params: Record<string, number | boolean | string>;
}

/** Hooks into the 3D undo stack ("adjust last operation" replaces the op's own step). */
export interface MeshEditUndoHooks {
  /** The step undo3D would revert next. */
  peek(): Command3D | null;
  /** Drop that step without running its undo. */
  discardTop(): boolean;
}

/** What a re-run needs: the mesh before the op, the selection before it, the op's target, and the step it pushed. */
interface LastOpRecord extends MeshEditLastOp {
  meshId: string;
  before: object;
  sel: { vertices: number[]; edges: number[]; faces: number[] } | null;
  /** The op's target in the BEFORE mesh: faces / a half-edge / a bevel spec (without amount / segments). */
  target: { faces?: number[]; halfEdge?: number; vertices?: number[]; edges?: Array<[number, number]> };
  /** The step the op pushed (null = the last re-run changed nothing: no step, the mesh is `before`). */
  cmd: Command3D | null;
  /** The step below it (what must be on top while `cmd` is null). */
  below: Command3D | null;
  /** The EditMesh the op left (another object / attribute version = something else edited the mesh since). */
  em: EditMesh;
  attr: number;
}

export class MeshEditManager {
  private ctx: ManagerContext;
  private pushCommand: (cmd: Command3D) => void;
  private readonly _undo: MeshEditUndoHooks | null;

  private _editMeshId: string | null = null;
  private _selection: EditSelection | null = null;
  /** The last command this manager pushed (an op's own step). */
  private _lastPushed: Command3D | null = null;
  /** The EditMesh JSON _topologyEdit took before its op (reused by the last-op record). */
  private _lastBefore: object | null = null;
  private _lastOp: LastOpRecord | null = null;

  constructor(ctx: ManagerContext, pushCommand: (cmd: Command3D) => void, undo?: MeshEditUndoHooks) {
    this.ctx = ctx;
    this.pushCommand = (cmd) => { this._lastPushed = cmd; pushCommand(cmd); };
    this._undo = undo ?? null;
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────

  get activeMeshId(): string | null { return this._editMeshId; }
  get isEditing(): boolean { return this._editMeshId !== null; }

  /**
   * Enter edit mode for mesh `meshId`. If the mesh has no EditMesh yet, calls
   * makeEditable() first to build one from the current primitive/geometry.
   * Returns false if the mesh is not found.
   */
  enterEditMode(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh) return false;
    if (!mesh.editMesh) {
      if (!this.makeEditable(meshId)) return false;
    }
    this._editMeshId = meshId;
    this._selection = { meshId, vertices: new Set(), edges: new Set(), faces: new Set() };
    return true;
  }

  exitEditMode(): void {
    this._lastOp = null;
    this._editMeshId = null;
    this._selection = null;
  }

  /**
   * Build the mesh's EditMesh from the geometry it renders (docs/specs/edit-mesh-topology.md §2): coincident vertices
   * WELDED (a cube = 8 vertices, so dragging a corner moves all 3 faces), triangle pairs merged into quads (a cube = 6
   * quads), per-corner UVs + smooth / sharp shading kept — EditMesh.fromGeometry. Primitives, imports and reloaded
   * triangle-soup saves all take this path, so the EditMesh always matches what is on screen (the old fromSphere /
   * fromCylinder rebuilt the primitive at a different resolution and without its UVs). A skinned body stays 1:1 with
   * its geometry (its rest weights / weight paint index the geometry's vertices). After this call mesh.editMesh is set
   * and mesh.syncFromEditMesh() is called — an unedited mesh compiles back to the same render geometry.
   *
   * Returns false if the mesh is not found or is already editable.
   */
  makeEditable(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh) return false;
    if (mesh.editMesh) return true;  // already editable

    const prim = mesh.meshPrimitive;
    const geom = mesh.geometry;
    let em: EditMesh;
    if (!geom || !geom.vertices || geom.vertices.length < FLOATS_PER_VERT * 3) {
      em = EditMesh.fromBox(1, 1, 1);
    } else if (mesh instanceof SkinnedMesh3D) {
      em = EditMesh.fromGeometry(geom, { weld: false });
    } else {
      // box / sphere / cylinder: the UV editor auto-unwraps them on first open (they had no UVs as EditMeshes
      // before), so their vertex-UV fallback stays empty — the corners still carry the generator UVs for rendering.
      const primitiveUVs = prim === 'box' || prim === 'sphere' || prim === 'cylinder';
      em = EditMesh.fromGeometry(geom, { vertexUVs: !primitiveUVs });
    }

    mesh.editMesh = em;
    if (mesh instanceof SkinnedMesh3D) {
      // Skinned bodies: build the EditMesh for UV editing/painting, but do NOT recompile the
      // rendered geometry. editMesh.compile() emits an un-indexed, FLAT-shaded, grey-vertex-colored
      // mesh whose winding differs from the original — swapping the body for it makes it render
      // faceted, grey, and (the skinned pipeline is cull-back) with its front faces culled
      // ("front half invisible, see the inside of the back"). Keep the original skinned geometry;
      // snapshot the rest weights so a later explicit UV-layout edit (which DOES sync) can re-map
      // them onto the recompiled geometry instead of collapsing faces to the origin.
      mesh.captureRestSkin();
    } else {
      mesh.syncFromEditMesh();
    }
    return true;
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  selectVertex(meshId: string, vIdx: number, addToSelection = false): void {
    const sel = this._ensureSelection(meshId);
    if (!addToSelection) sel.vertices.clear();
    sel.vertices.add(vIdx);
    sel.faces.clear();
  }

  selectFace(meshId: string, fIdx: number, addToSelection = false): void {
    const sel = this._ensureSelection(meshId);
    if (!addToSelection) sel.faces.clear();
    sel.faces.add(fIdx);
    sel.vertices.clear();
  }

  clearSelection(meshId: string): void {
    const sel = this._ensureSelection(meshId);
    sel.vertices.clear();
    sel.edges.clear();
    sel.faces.clear();
  }

  selectEdge(meshId: string, heIdx: number, addToSelection = false): void {
    const sel = this._ensureSelection(meshId);
    if (!addToSelection) {
      sel.vertices.clear();
      sel.faces.clear();
      sel.edges.clear();
    }
    sel.edges.add(heIdx);
  }

  getSelection(meshId: string): EditSelection | null {
    return this._selection?.meshId === meshId ? this._selection : null;
  }

  /** World-space AABB of the edited mesh's selected vertices / edges / faces ("Frame selected", TOUCH-10), or of the
   *  whole edit mesh when nothing is selected (or `wholeMesh`). Null when `meshId` isn't being edited or has no vertices. */
  selectionWorldBounds(meshId: string, wholeMesh = false): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
    const mesh = this._getMesh(meshId);
    const em = mesh?.editMesh;
    if (!mesh || !em || em.vertices.length === 0) return null;
    const idx = new Set<number>(wholeMesh ? [] : this.selectedVertexIndices(meshId));
    const m = mesh.localMatrix as unknown as Float32Array;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const add = (v: { x: number; y: number; z: number } | undefined) => {
      if (!v) return;
      const x = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
      const y = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
      const z = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    };
    if (idx.size > 0) for (const i of idx) add(em.vertices[i]);
    else for (const v of em.vertices) add(v);
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /** The VERTEX SET of the selection: the selected vertices, both ends of every selected edge and every vertex of
   *  every selected face (welded topology: a face's neighbours share these vertices). Ascending, no duplicates; [] when
   *  `meshId` isn't being edited or nothing is selected. What the element transforms (G / R / S, the gizmo) move. */
  selectedVertexIndices(meshId: string): number[] {
    const em = this._getMesh(meshId)?.editMesh;
    const sel = this.getSelection(meshId);
    if (!em || !sel) return [];
    const idx = new Set<number>();
    for (const v of sel.vertices) if (v >= 0 && v < em.vertices.length) idx.add(v);
    for (const h of sel.edges) {
      const he = em.halfEdges[h];
      if (!he) continue;
      idx.add(he.vertex);
      const prev = em.halfEdges[he.prev];
      if (prev) idx.add(prev.vertex);
    }
    for (const f of sel.faces) {
      const face = em.faces[f];
      if (!face) continue;
      let hi = face.halfEdge;
      for (let guard = 0; guard < 256; guard++) {
        const he = em.halfEdges[hi];
        if (!he) break;
        idx.add(he.vertex);
        hi = he.next;
        if (hi === face.halfEdge) break;
      }
    }
    return [...idx].sort((a, b) => a - b);
  }

  /** A copy of the selection (TOUCH-5: a finger press that turns into a pinch puts it back with restoreSelection). */
  snapshotSelection(meshId: string): { vertices: number[]; edges: number[]; faces: number[] } | null {
    const sel = this.getSelection(meshId);
    return sel ? { vertices: [...sel.vertices], edges: [...sel.edges], faces: [...sel.faces] } : null;
  }

  /** Put back a {@link snapshotSelection} (null = no selection). Fresh Sets, never cleared in place: an undo command's
   *  redo may hold the old Set (see _clearSelectionGeometry). */
  restoreSelection(meshId: string, snap: { vertices: number[]; edges: number[]; faces: number[] } | null): void {
    const sel = this._ensureSelection(meshId);
    sel.vertices = new Set(snap?.vertices ?? []);
    sel.edges = new Set(snap?.edges ?? []);
    sel.faces = new Set(snap?.faces ?? []);
  }

  // ── Destructive operations ────────────────────────────────────────────────

  /** Move vertex by delta. Pushes to undo stack. */
  moveVertex(meshId: string, vIdx: number, dx: number, dy: number, dz: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const em = mesh.editMesh;

    const v = em.vertices[vIdx];
    if (!v) return false;

    const before = em.toJSON();
    em.moveVertex(vIdx, dx, dy, dz);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Move vertex',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.moveVertex(vIdx, dx, dy, dz); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /** Extrude face `fIdx` by `distance` along its normal. */
  extrudeFace(meshId: string, fIdx: number, distance: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const em = mesh.editMesh;

    const before = em.toJSON();
    em.extrudeFace(fIdx, distance);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Extrude face',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.extrudeFace(fIdx, distance); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /** Inset face `fIdx` by `amount` (0–1 ratio toward center). */
  insetFace(meshId: string, fIdx: number, amount: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const em = mesh.editMesh;

    const before = em.toJSON();
    em.insetFace(fIdx, amount);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Inset face',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.insetFace(fIdx, amount); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /** Delete face `fIdx`. */
  deleteFace(meshId: string, fIdx: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.deleteFace(fIdx);
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);

    this.pushCommand({
      description: 'Delete face',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.deleteFace(fIdx); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /** Weld vertex `v2` into `v1` (move v1 to midpoint, remove v2). */
  weldVertices(meshId: string, v1: number, v2: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.weldVertices(v1, v2);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Weld vertices',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.weldVertices(v1, v2); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /**
   * Insert a new edge loop through quad faces starting at `halfEdgeIdx`.
   * `t` controls the lerp position of the cut (default 0.5 = midpoint).
   */
  loopCut(meshId: string, halfEdgeIdx: number, t = 0.5): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.loopCut(halfEdgeIdx, t);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Loop cut',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.loopCut(halfEdgeIdx, t); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /**
   * Dissolve the shared edge between two adjacent faces, merging them into one polygon.
   * `halfEdgeIdx` must be an interior half-edge (twin >= 0).
   */
  dissolveEdge(meshId: string, halfEdgeIdx: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.dissolveEdge(halfEdgeIdx);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Dissolve edge',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.dissolveEdge(halfEdgeIdx); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /**
   * Bevel the edge at `halfEdgeIdx`, replacing it with a quad chamfer strip.
   * `amount` (0–1) controls how far each new vertex slides along its adjacent edge.
   */
  bevelEdge(meshId: string, halfEdgeIdx: number, amount: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.bevelEdge(halfEdgeIdx, amount);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Bevel edge',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.bevelEdge(halfEdgeIdx, amount); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  bevelVertex(meshId: string, vertexIdx: number, amount: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.bevelVertex(vertexIdx, amount);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Bevel vertex',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.bevelVertex(vertexIdx, amount); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /**
   * Bevel / chamfer (EditMesh.bevel — docs/specs/edit-mesh-topology.md §8): vertices (`spec.vertices`) or edges
   * (`spec.edges`, vertex pairs) by `spec.amount` (distance along the edges, clamped) with `spec.segments`. One undo
   * step; the selection is dropped (the indices change). Returns the amount used, or null when nothing was beveled.
   */
  bevel(meshId: string, spec: BevelSpec, _before?: object, _sel?: LastOpRecord['sel']): number | null {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return null;
    const sel = _sel !== undefined ? _sel : this.snapshotSelection(meshId);
    const before = _before ?? mesh.editMesh.toJSON();
    const r = mesh.editMesh.bevel(spec);
    if (!r) return null;
    mesh.syncFromEditMesh();
    const after = mesh.editMesh.toJSON();
    this._clearSelectionGeometry(meshId);
    this.pushCommand({
      description: spec.vertices?.length ? 'Chamfer vertex' : 'Bevel edge',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    this._lastBefore = before;
    this._recordOp(meshId, 'bevel', { amount: r.amount, segments: spec.segments ?? 1 },
      spec.vertices?.length ? { vertices: [...spec.vertices] } : { edges: (spec.edges ?? []).map(e => [e[0], e[1]] as [number, number]) }, sel);
    return r.amount;
  }

  /**
   * Apply a pre-computed knife cut to the EditMesh.
   * The `faceCuts` array is produced by ShapeManager.knifeCut3D after screen-space
   * projection. Snapshot undo/redo; redo restores the post-cut snapshot so face
   * indices don't need to be re-resolved.
   */
  knifeCut(
    meshId: string,
    faceCuts: Array<{
      faceIdx: number;
      cuts: Array<{ vA: number; vB: number; t: number; edgeIdx: number }>;
    }>,
  ): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.knifeCut(faceCuts);
    mesh.syncFromEditMesh();
    const after = mesh.editMesh.toJSON();

    this.pushCommand({
      description: 'Knife cut',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  /**
   * One-click auto UV unwrap that produces a **separated, packed** layout:
   *  1. seam by dihedral angle so hard edges become island boundaries (e.g. all
   *     6 faces of a cube split into their own islands),
   *  2. project each island onto its dominant-axis plane, and
   *  3. shelf-pack the islands into [0,1] so each face gets its own paintable
   *     region instead of every face overlapping on the same square.
   * Fills `vertex.uv` for every vertex. Undoable. (Smooth closed meshes with no
   * hard edges — e.g. a sphere — still need a manual seam to unwrap cleanly.)
   */
  autoUnwrap(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const run = (em: EditMesh) => {
      // Islands = existing UV cuts (corners whose UVs differ — an import's authored seams) + these seams.
      em.suggestSeams(45);   // hard edges (> 45°) → seams → separate islands
      em.splitSeams();       // every corner gets its own UV so islands CAN separate (topology stays welded)
      em.unwrapIslands();    // project each island independently
      em.packUVIslands();    // pack islands into [0,1] with no overlap
      // Flip V so the 2D UV layout matches the 3D viewport orientation — painting
      // the bottom of the mesh shows at the bottom of the UV pane (not the top).
      em.mapUVs((u, v) => [u, 1 - v]);
    };

    const before = mesh.editMesh.toJSON();
    run(mesh.editMesh);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Auto UV unwrap',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { run(mesh.editMesh!); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  // ── Seam operations ───────────────────────────────────────────────────────

  /**
   * Mark the given half-edges (and their twins) as UV seams.
   * Seams are UV cut lines that define island boundaries for unwrapping.
   * Does not change GPU geometry — only the overlay re-renders.
   */
  markSeam(meshId: string, halfEdgeIndices: number[]): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.markSeams(halfEdgeIndices);
    this.pushCommand({
      description: 'Mark seam',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); },
      redo: () => { mesh.editMesh!.markSeams(halfEdgeIndices); },
    });
    return true;
  }

  /** Remove seam from the given half-edges (and their twins). */
  clearSeam(meshId: string, halfEdgeIndices: number[]): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.clearSeams(halfEdgeIndices);
    this.pushCommand({
      description: 'Clear seam',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); },
      redo: () => { mesh.editMesh!.clearSeams(halfEdgeIndices); },
    });
    return true;
  }

  /** Remove all seam flags from the mesh. */
  clearAllSeams(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.clearAllSeams();
    this.pushCommand({
      description: 'Clear all seams',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); },
      redo: () => { mesh.editMesh!.clearAllSeams(); },
    });
    return true;
  }

  /**
   * Auto-suggest seams by marking edges where the dihedral angle exceeds `thresholdDeg`.
   * Sharp creases are good seam candidates — they hide cuts at natural silhouette breaks.
   */
  suggestSeams(meshId: string, thresholdDeg = 60): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.suggestSeams(thresholdDeg);
    this.pushCommand({
      description: 'Suggest seams',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); },
      redo: () => { mesh.editMesh!.suggestSeams(thresholdDeg); },
    });
    return true;
  }

  /**
   * Bridge two open edge loops with a ring of quads.
   * `loopA` / `loopB` are ordered vertex-index arrays of equal length (≥ 2).
   * Returns false if the mesh is not editable or the arrays are invalid.
   */
  bridgeEdgeLoops(meshId: string, loopA: number[], loopB: number[]): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    const ok = mesh.editMesh.bridgeEdgeLoops(loopA, loopB);
    if (!ok) return false;
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Bridge edge loops',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.bridgeEdgeLoops(loopA, loopB); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  // ── Multi-select operations ───────────────────────────────────────────────

  /** Extrude a set of faces along their normals. Interior shared edges produce no side quad. */
  extrudeFaces(meshId: string, fIdxSet: Set<number> | null, distance: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.extrudeFaces(set, distance);
    mesh.syncFromEditMesh();
    this.pushCommand({
      description: 'Extrude faces',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.extrudeFaces(set, distance); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Inset a set of faces toward their centroids. */
  insetFaces(meshId: string, fIdxSet: Set<number> | null, amount: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.insetFaces(set, amount);
    mesh.syncFromEditMesh();
    this.pushCommand({
      description: 'Inset faces',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.insetFaces(set, amount); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  // ── Region ops (UI review 2026-10-07): one undo step each, the selection as the default target ──

  /** One undoable topology edit: snapshot, run `op` (false = it changed nothing → no command), recompile, push. */
  private _topologyEdit(meshId: string, description: string, op: (mesh: Mesh3D) => boolean, beforeJSON?: object): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = beforeJSON ?? mesh.editMesh.toJSON();
    this._lastBefore = before;
    if (!op(mesh)) return false;   // the region ops bail out before touching the mesh
    mesh.syncFromEditMesh();
    const after = mesh.editMesh!.toJSON();
    this.pushCommand({
      description,
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** The face set an op targets: the given one, else the face selection. */
  private _facesOrSelection(fIdxSet: Iterable<number> | null): Set<number> {
    return new Set(fIdxSet ?? this._selection?.faces ?? []);
  }

  /** REGION extrude (EditMesh.extrudeRegion): connected selected faces move as one piece with one ring of walls. The
   *  extruded faces stay selected (they keep their indices), ready for the next extrude / G. */
  extrudeRegion(meshId: string, fIdxSet: Iterable<number> | null, distance: number, _before?: object): boolean {
    const set = this._facesOrSelection(fIdxSet);
    if (set.size === 0) return false;
    const sel = this.snapshotSelection(meshId);
    const ok = this._topologyEdit(meshId, set.size > 1 ? 'Extrude region' : 'Extrude face', m => m.editMesh!.extrudeRegion(set, distance).length > 0, _before);
    if (ok) {
      this._reselectFaces(meshId, set);
      this._recordOp(meshId, 'extrudeRegion', { distance }, { faces: [...set] }, sel);
    }
    return ok;
  }

  /** REGION inset (EditMesh.insetRegion): one border around each connected group. The inner faces stay selected.
   *  `depth` (Blender's Inset "Depth") then moves the inner faces along their normal. */
  insetRegion(meshId: string, fIdxSet: Iterable<number> | null, amount: number, depth = 0, _before?: object): boolean {
    const set = this._facesOrSelection(fIdxSet);
    if (set.size === 0) return false;
    const sel = this.snapshotSelection(meshId);
    const d = Number.isFinite(depth) ? depth : 0;
    const ok = this._topologyEdit(meshId, set.size > 1 ? 'Inset region' : 'Inset face', m => {
      const em = m.editMesh!;
      const inset = amount > 0 && em.insetRegion(set, amount).length > 0;
      const moved = d !== 0 && em.offsetRegion(set, d);
      return inset || moved;
    }, _before);
    if (ok) {
      this._reselectFaces(meshId, set);
      this._recordOp(meshId, 'insetRegion', { amount, depth: d }, { faces: [...set] }, sel);
    }
    return ok;
  }

  /** Subdivide every selected face at once (shared edge midpoints). The selection is cleared (faces renumbered).
   *  `levels` > 1 subdivides the new faces again (each level splits every face edge in two: 2^levels pieces per edge). */
  subdivideFaces(meshId: string, fIdxSet: Iterable<number> | null, levels = 1, _before?: object): boolean {
    const set = this._facesOrSelection(fIdxSet);
    if (set.size === 0) return false;
    const sel = this.snapshotSelection(meshId);
    const lv = Math.max(1, Math.min(4, Math.round(Number.isFinite(levels) ? levels : 1)));
    const ok = this._topologyEdit(meshId, 'Subdivide faces', m => {
      const em = m.editMesh!;
      const n0 = em.faces.length;
      let cur = [...set].filter(fi => fi >= 0 && fi < em.faces.length && em.faces[fi].vertexCount >= 3);
      for (let l = 0; l < lv && cur.length > 0; l++) {
        const made = cur.reduce((acc, fi) => acc + em.faces[fi].vertexCount, 0);
        em.subdivideFaces(cur);
        // subdivideFaces keeps the other faces first and appends the new quads
        cur = Array.from({ length: made }, (_, i) => em.faces.length - made + i);
      }
      return em.faces.length !== n0;
    }, _before);
    if (ok) {
      this._clearSelectionGeometry(meshId);
      this._recordOp(meshId, 'subdivide', { levels: lv }, { faces: [...set] }, sel);
    }
    return ok;
  }

  /**
   * LOOP CUT with `count` parallel cuts at `position` (0–1, 0.5 = evenly spaced) through the quad ring of half-edge
   * `halfEdgeIdx` (EditMesh.loopCuts). One undo step; the selection is cleared (vertices renumbered). Recorded as the
   * last op (adjust count / position afterwards).
   */
  loopCuts(meshId: string, halfEdgeIdx: number, count = 1, position = 0.5, _before?: object): boolean {
    const sel = this.snapshotSelection(meshId);
    const n = Math.max(1, Math.min(64, Math.round(Number.isFinite(count) ? count : 1)));
    const p = Math.max(0, Math.min(1, Number.isFinite(position) ? position : 0.5));
    const ok = this._topologyEdit(meshId, n > 1 ? `Loop cut (${n})` : 'Loop cut', m => m.editMesh!.loopCuts(halfEdgeIdx, n, p), _before);
    if (ok) {
      this._clearSelectionGeometry(meshId);
      this._recordOp(meshId, 'loopCut', { count: n, position: p }, { halfEdge: halfEdgeIdx }, sel);
    }
    return ok;
  }

  /**
   * KNIFE along tapped surface points (EditMesh.knifeCutPath — the Knife tool). One undo step; the selection is cleared.
   * Returns the number of faces split (0 = nothing cut, no step).
   */
  knifePath(meshId: string, points: KnifePoint[], opts: KnifeOptions = {}): number {
    let split = 0;
    const ok = this._topologyEdit(meshId, 'Knife', m => (split = m.editMesh!.knifeCutPath(points, opts)) > 0);
    if (ok) this._clearSelectionGeometry(meshId);
    return ok ? split : 0;
  }

  // ── Adjust last operation (Blender's F9) ──────────────────────────────────

  /** Record `op` (just applied; its step = the last one pushed) as the last parametric op. */
  private _recordOp(meshId: string, op: MeshEditLastOpName, params: LastOpRecord['params'], target: LastOpRecord['target'],
    sel: LastOpRecord['sel']): void {
    if (!this._lastBefore || !this._lastPushed) return;
    this.recordLastOp({ meshId, op, params, target, sel, before: this._lastBefore, cmd: this._lastPushed });
  }

  /**
   * Record a parametric op applied OUTSIDE this manager (the interactive Chamfer tool pushes its own step): `before` =
   * the EditMesh JSON before it, `cmd` = the step it pushed, `sel` = the selection before it.
   */
  recordLastOp(r: { meshId: string; op: MeshEditLastOpName; params: LastOpRecord['params']; target: LastOpRecord['target'];
    sel: LastOpRecord['sel']; before: object; cmd: Command3D }): void {
    const mesh = this._getMesh(r.meshId);
    if (!mesh?.editMesh) { this._lastOp = null; return; }
    this._lastOp = { ...r, params: { ...r.params }, below: null, em: mesh.editMesh, attr: mesh.editMesh.attrVersion };
  }

  /** The last parametric op while nothing else has edited since (else null — and forgotten). */
  getLastOp(): MeshEditLastOp | null {
    const r = this._validLastOp();
    return r ? { op: r.op, params: { ...r.params } } : null;
  }

  private _validLastOp(): LastOpRecord | null {
    const r = this._lastOp;
    if (!r) return null;
    const mesh = this._getMesh(r.meshId);
    const top = this._undo ? this._undo.peek() : r.cmd;
    const ok = !!mesh && mesh.editMesh === r.em && r.em.attrVersion === r.attr && this._editMeshId === r.meshId
      && (r.cmd ? top === r.cmd : top === r.below);
    if (!ok) this._lastOp = null;
    return ok ? r : null;
  }

  /** Forget the last op. */
  clearLastOp(): void { this._lastOp = null; }

  /**
   * Re-run the last parametric op with `params` merged over its current ones (unknown keys ignored), from the same mesh
   * + selection: its own undo step is DROPPED (not undone — the BEFORE mesh is put back directly) and the re-run pushes
   * one, so the stack stays ONE step net. A re-run that changes nothing (e.g. distance 0) leaves the mesh as before the
   * op with no step; a later call can still bring it back. False when there is no valid last op (another edit happened
   * since, undo / redo, Edit Mesh left). Cost per call: one EditMesh.fromJSON + the op + one compile (no undo replay).
   */
  redoLastOp(params: Record<string, number | boolean | string>): boolean {
    const r = this._validLastOp();
    if (!r) return false;
    const mesh = this._getMesh(r.meshId)!;
    if (r.cmd && !(this._undo?.discardTop() ?? false)) { this._lastOp = null; return false; }
    const below = this._undo?.peek() ?? null;
    const p: LastOpRecord['params'] = { ...r.params };
    for (const [k, v] of Object.entries(params ?? {})) {
      if (!(k in p)) continue;
      if (typeof p[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) p[k] = n; }
      else if (typeof p[k] === typeof v) p[k] = v;
    }
    mesh.editMesh = EditMesh.fromJSON(r.before);
    this.restoreSelection(r.meshId, r.sel);
    const num = (k: string, d: number): number => (typeof p[k] === 'number' ? p[k] as number : d);
    this._lastOp = null;
    let ok = false;
    switch (r.op) {
      case 'extrudeRegion': ok = this.extrudeRegion(r.meshId, r.target.faces ?? [], num('distance', 0), r.before); break;
      case 'insetRegion': ok = this.insetRegion(r.meshId, r.target.faces ?? [], num('amount', 0), num('depth', 0), r.before); break;
      case 'subdivide': ok = this.subdivideFaces(r.meshId, r.target.faces ?? [], num('levels', 1), r.before); break;
      case 'loopCut': ok = this.loopCuts(r.meshId, r.target.halfEdge ?? -1, num('count', 1), num('position', 0.5), r.before); break;
      case 'bevel': {
        const amount = num('amount', 0), segments = num('segments', 1);
        const spec: BevelSpec = r.target.vertices?.length
          ? { vertices: r.target.vertices, amount, segments } : { edges: r.target.edges ?? [], amount, segments };
        ok = amount > 0 && this.bevel(r.meshId, spec, r.before, r.sel) !== null;
        break;
      }
    }
    if (!ok) {
      // nothing changed: the mesh stays as before the op (no step); keep the record so the pill can scrub back
      mesh.syncFromEditMesh();
      this.restoreSelection(r.meshId, r.sel);
      this._lastOp = { ...r, params: p, cmd: null, below, em: mesh.editMesh!, attr: mesh.editMesh!.attrVersion };
    }
    return true;
  }

  /** Cap every hole (or, when vertices / edges on a hole are selected, just those holes) — one undo step. Returns the
   *  number of holes filled. */
  fillHoles(meshId: string, touching?: Iterable<number> | null): number {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return 0;
    let filter: Set<number> | null = touching ? new Set(touching) : null;
    if (!touching && this._selection?.meshId === meshId) {
      // The selection's vertices (+ the selected edges' ends) that lie on a hole pick which holes to fill.
      const H = mesh.editMesh.halfEdges, s = new Set(this._selection.vertices);
      for (const e of this._selection.edges) { const h = H[e]; if (h) { s.add(h.vertex); s.add(H[h.prev]?.vertex ?? -1); } }
      const onHole = new Set(mesh.editMesh.boundaryLoops().flat());
      const picked = [...s].filter(v => onHole.has(v));
      if (picked.length) filter = new Set(picked);
    }
    let count = 0;
    this._topologyEdit(meshId, 'Fill holes', m => (count = m.editMesh!.fillHoles(filter)) > 0);
    if (count > 0) this._clearSelectionGeometry(meshId);
    return count;
  }

  /** Bridge the two loops the given (else the selected) vertices form — order independent; for an edge selection
   *  its end vertices. The selection is cleared. */
  bridgeLoops(meshId: string, verts: Iterable<number> | null): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    let vs: Set<number>;
    if (verts) vs = new Set(verts);
    else {
      vs = new Set(this._selection?.meshId === meshId ? this._selection.vertices : []);
      if (vs.size === 0 && this._selection?.meshId === meshId) {
        const H = mesh.editMesh.halfEdges;
        for (const e of this._selection.edges) { const h = H[e]; if (h) { vs.add(h.vertex); vs.add(H[h.prev].vertex); } }
      }
    }
    const ok = this._topologyEdit(meshId, 'Bridge edge loops', m => !!m.editMesh!.bridgeVertexLoops(vs));
    if (ok) this._clearSelectionGeometry(meshId);
    return ok;
  }

  /** After an op that keeps face indices: select exactly `faces` (fresh Sets — see _clearSelectionGeometry). */
  private _reselectFaces(meshId: string, faces: Set<number>): void {
    if (this._selection?.meshId !== meshId) return;
    this._selection.vertices = new Set();
    this._selection.edges = new Set();
    this._selection.faces = new Set(faces);
  }

  /** Delete a set of faces. */
  deleteFaces(meshId: string, fIdxSet: Set<number> | null): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.deleteFaces(set);
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);
    this.pushCommand({
      description: 'Delete faces',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.deleteFaces(set); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Flip the normals of a set of faces by reversing winding. */
  flipFaces(meshId: string, fIdxSet: Set<number> | null): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.flipFaces(set);
    mesh.syncFromEditMesh();
    this.pushCommand({
      description: 'Flip normals',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.flipFaces(set); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Shade a set of faces smooth or flat (Blender's Shade Smooth / Flat). Omit the set → the face selection; an
   *  empty selection → every face. Undoable. */
  setFacesSmooth(meshId: string, fIdxSet: Set<number> | null, smooth: boolean): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    let set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) set = new Set(mesh.editMesh.faces.map((_, i) => i));
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.setFacesSmooth(set, smooth);
    mesh.syncFromEditMesh();
    const after = mesh.editMesh.toJSON();
    this.pushCommand({
      description: smooth ? 'Shade smooth' : 'Shade flat',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Mark / clear half-edges (and their twins) as sharp — smooth shading never blends across them. Undoable. */
  setSharpEdges(meshId: string, halfEdgeIndices: number[], sharp: boolean): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh || halfEdgeIndices.length === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.setSharpEdges(halfEdgeIndices, sharp);
    mesh.syncFromEditMesh();
    const after = mesh.editMesh.toJSON();
    this.pushCommand({
      description: sharp ? 'Mark sharp' : 'Clear sharp',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Weld all vertices within `threshold` distance. Returns the number removed. */
  mergeByDistance(meshId: string, threshold: number): number {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return 0;
    const before = mesh.editMesh.toJSON();
    const removed = mesh.editMesh.mergeByDistance(threshold);
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);
    this.pushCommand({
      description: `Merge by distance (removed ${removed})`,
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.mergeByDistance(threshold); mesh.syncFromEditMesh(); },
    });
    return removed;
  }

  /** Subdivide face `fIdx` into quads via center + edge-midpoint insertion. */
  subdivideFace(meshId: string, fIdx: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.subdivideFace(fIdx);
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);
    this.pushCommand({
      description: 'Subdivide face',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.subdivideFace(fIdx); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /** Cap an open boundary loop identified by `boundaryHalfEdgeIdx`. */
  fillHole(meshId: string, boundaryHalfEdgeIdx: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const before = mesh.editMesh.toJSON();
    const newFaceIdx = mesh.editMesh.fillHole(boundaryHalfEdgeIdx);
    if (newFaceIdx < 0) return false;
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);
    this.pushCommand({
      description: 'Fill hole',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.fillHole(boundaryHalfEdgeIdx); mesh.syncFromEditMesh(); },
    });
    return true;
  }

  /**
   * Extract the selected faces into a new sibling Mesh3D node.
   * Returns the new mesh's ID, or null on failure.
   */
  separateFaces(meshId: string, fIdxSet: Set<number> | null): string | null {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return null;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return null;

    const em = mesh.editMesh;
    const allFaceLists = em['_getAllFaceLists']() as FaceList[];

    // Gather unique vertex indices from selected faces
    const usedVerts = new Set<number>();
    for (const fi of set) {
      if (fi >= 0 && fi < allFaceLists.length) {
        for (const vi of allFaceLists[fi]) usedVerts.add(vi);
      }
    }

    // Build compact vertex map
    const oldToNew = new Map<number, number>();
    const newVerts: typeof em.vertices = [];
    for (const vi of usedVerts) {
      oldToNew.set(vi, newVerts.length);
      newVerts.push({ ...em.vertices[vi] });
    }

    // Build remapped face lists (corner UVs / colours / custom normals + shading travel with their faces)
    const newFaceLists: FaceList[] = [];
    for (const fi of set) {
      if (fi >= 0 && fi < allFaceLists.length) {
        const f = allFaceLists[fi];
        newFaceLists.push(remapFace(f, vi => oldToNew.get(vi)!));
      }
    }

    // Create new EditMesh
    const newEm = new EditMesh();
    newEm.vertices = newVerts;
    newEm._buildTopology(newFaceLists, { keepFlags: false });
    newEm._normalizeCustomNormals();

    // Create new Mesh3D at source's position
    const newMesh = new Mesh3D(this.ctx.interactionService, mesh.x, mesh.y, mesh.z, { primitive: 'custom', geometry: newEm.compile() });
    newMesh.editMesh = newEm;
    newMesh.syncFromEditMesh();

    const sourceBefore = em.toJSON();
    em.deleteFaces(set);
    mesh.syncFromEditMesh();
    this._clearSelectionGeometry(meshId);

    this.ctx.sceneGraph.root.addChild(newMesh);
    this.ctx.emitSceneGraphChanged();

    const newMeshId = newMesh.id;
    this.pushCommand({
      description: 'Separate faces',
      undo: () => {
        mesh.editMesh = EditMesh.fromJSON(sourceBefore);
        mesh.syncFromEditMesh();
        newMesh.parent?.removeChild(newMesh);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        mesh.editMesh!.deleteFaces(set);
        mesh.syncFromEditMesh();
        this.ctx.sceneGraph.root.addChild(newMesh);
        this.ctx.emitSceneGraphChanged();
      },
    });
    return newMeshId;
  }

  /** Configure proportional (soft) editing for vertex drag operations. */
  setProportionalEdit(meshId: string, enabled: boolean, radius?: number, falloff?: 'smooth' | 'linear' | 'sharp'): void {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return;
    mesh.editMesh.proportionalEditEnabled = enabled;
    if (radius !== undefined) mesh.editMesh.proportionalEditRadius = radius;
    if (falloff !== undefined) mesh.editMesh.proportionalEditFalloff = falloff;
  }

  // ── Vertex colors ─────────────────────────────────────────────────────────

  paintVertexColor(meshId: string, vIdx: number, r: number, g: number, b: number, a: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    mesh.editMesh.paintVertexColor(vIdx, r, g, b, a);
    mesh.syncFromEditMesh();
    return true;
  }

  paintFaceColor(meshId: string, fIdx: number, r: number, g: number, b: number, a: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.paintFaceColor(fIdx, r, g, b, a);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Paint face color',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.paintFaceColor(fIdx, r, g, b, a); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  // ── Modifier stack ────────────────────────────────────────────────────────

  /**
   * Apply a mutation to the modifier stack as ONE undoable command (snapshot before/after,
   * same pattern as applyModifier). Returns the mesh so callers can read the resulting stack.
   */
  private _mutateModifiers(meshId: string, description: string, mutate: (em: EditMesh) => void): Mesh3D | null {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return null;
    const before = mesh.editMesh.toJSON();
    mutate(mesh.editMesh);
    mesh.syncFromEditMesh();
    const after = mesh.editMesh.toJSON();
    this.pushCommand({
      description,
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    return mesh;
  }

  addMirrorModifier(meshId: string, axis: 'x' | 'y' | 'z' = 'x', clipping = true): number {
    const mesh = this._mutateModifiers(meshId, 'Add mirror modifier',
      em => em.modifiers.push(new MirrorModifier(axis, clipping)));
    return mesh?.editMesh ? mesh.editMesh.modifiers.length - 1 : -1;
  }

  addSubdivisionModifier(meshId: string, iterations = 1): number {
    const mesh = this._mutateModifiers(meshId, 'Add subdivision modifier',
      em => em.modifiers.push(new SubdivisionModifier(iterations)));
    return mesh?.editMesh ? mesh.editMesh.modifiers.length - 1 : -1;
  }

  addDisplaceModifier(meshId: string, params?: Partial<Pick<DisplaceModifier, 'strength' | 'frequency' | 'seed' | 'octaves' | 'direction'>>): number {
    const mesh = this._mutateModifiers(meshId, 'Add displace modifier',
      em => em.modifiers.push(new DisplaceModifier(params)));
    return mesh?.editMesh ? mesh.editMesh.modifiers.length - 1 : -1;
  }

  setModifierEnabled(meshId: string, index: number, enabled: boolean): void {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh?.modifiers[index]) return;
    this._mutateModifiers(meshId, enabled ? 'Enable modifier' : 'Disable modifier',
      em => { em.modifiers[index].enabled = enabled; });
  }

  removeModifier(meshId: string, index: number): void {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh?.modifiers[index]) return;
    this._mutateModifiers(meshId, 'Remove modifier',
      em => { em.modifiers.splice(index, 1); });
  }

  /** Bake modifier at `index` into the base mesh (destructive, undoable). */
  applyModifier(meshId: string, index: number): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.applyModifier(index);
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Apply modifier',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.applyModifier(index); mesh.syncFromEditMesh(); },
    });

    return true;
  }

  getModifiers(meshId: string): object[] {
    const mesh = this._getMesh(meshId);
    return mesh?.editMesh?.modifiers.map(m => m.toJSON()) ?? [];
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _getMesh(meshId: string): Mesh3D | null {
    const node = this.ctx.sceneGraph.findNodeById(meshId);
    return node instanceof Mesh3D ? node : null;
  }

  private _ensureSelection(meshId: string): EditSelection {
    if (!this._selection || this._selection.meshId !== meshId) {
      this._selection = { meshId, vertices: new Set(), edges: new Set(), faces: new Set() };
    }
    return this._selection;
  }

  /**
   * Drop the vertex/edge/face selection for `meshId` after a topology-changing op
   * (delete/merge/subdivide). Those ops renumber indices, so the retained selection
   * would otherwise point at DIFFERENT geometry and a follow-up op (which falls back to
   * `this._selection.faces`) would hit the wrong faces. Clearing is the safe behavior —
   * it matches Blender, where deleting/merging drops the stale selection.
   */
  private _clearSelectionGeometry(meshId: string): void {
    if (this._selection?.meshId !== meshId) return;
    // Reassign fresh Sets rather than .clear() — a command's redo() may have captured the
    // existing face Set (deleteFaces/flipFaces fall back to `this._selection.faces`), and
    // emptying that same object in place would make the redo replay with nothing selected.
    this._selection.vertices = new Set();
    this._selection.edges = new Set();
    this._selection.faces = new Set();
  }

}
