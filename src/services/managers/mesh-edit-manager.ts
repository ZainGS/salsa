/**
 * MeshEditManager — EditMesh authoring: selection state, destructive operations, modifier stack.
 *
 * All topology-changing operations (extrude, inset, delete, weld, applyModifier) are
 * pushed onto the UndoManager3D as snapshot-based commands. Snapshot approach:
 * serialize the EditMesh to JSON before the op, restore it on undo, re-apply on redo.
 * Simple and correct; mesh sizes are small enough (hundreds of polys) that JSON round-trips
 * are fast.
 *
 * `makeEditable()` replaces the mesh's compiled geometry with an EditMesh built from the
 * same primitive type, then calls syncFromEditMesh() to push the compiled result back.
 *
 * Phase 2: makeEditable, vertex drag, extrude, inset, delete, weld, vertex colors,
 * MirrorModifier, SubdivisionModifier, selection queries.
 *
 * Phase 3: loop cut, edge dissolve, bevel — shipped. Knife + auto-UV remaining.
 */

import type { ManagerContext } from './manager-context';
import type { Command3D } from './undo-manager-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh, MirrorModifier, SubdivisionModifier } from '../../scene-graph/shapes/edit-mesh';

export interface EditSelection {
  meshId: string;
  vertices: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

export class MeshEditManager {
  private ctx: ManagerContext;
  private pushCommand: (cmd: Command3D) => void;

  private _editMeshId: string | null = null;
  private _selection: EditSelection | null = null;

  constructor(ctx: ManagerContext, pushCommand: (cmd: Command3D) => void) {
    this.ctx = ctx;
    this.pushCommand = pushCommand;
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
    this._editMeshId = null;
    this._selection = null;
  }

  /**
   * Convert the mesh's current primitive to an EditMesh. The EditMesh is built
   * to match the geometry as closely as possible using the primitive type.
   * After this call, mesh.editMesh is set and mesh.syncFromEditMesh() is called
   * so the GPU geometry remains unchanged.
   *
   * Returns false if the mesh is not found or is already editable.
   */
  makeEditable(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh) return false;
    if (mesh.editMesh) return true;  // already editable

    const prim = mesh.meshPrimitive;
    const cfg = (mesh as any)._meshConfig ?? {};

    let em: EditMesh;
    if (prim === 'box') {
      em = EditMesh.fromBox(cfg.width ?? 1, cfg.height ?? 1, cfg.depth ?? 1);
    } else if (prim === 'sphere') {
      em = EditMesh.fromSphere(cfg.radius ?? 0.5, cfg.widthSegments ?? 8);
    } else if (prim === 'cylinder') {
      em = EditMesh.fromCylinder(cfg.radius ?? 0.5, cfg.height ?? 1, cfg.radialSegments ?? 8);
    } else {
      // For custom/imported meshes: build a rough EditMesh from the triangles
      em = this._editMeshFromGeometry(mesh);
    }

    mesh.editMesh = em;
    mesh.syncFromEditMesh();
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
   * Run the smart-project (box-mapping) auto UV unwrap on the mesh.
   * Fills `vertex.uv` for every vertex. Undoable.
   */
  autoUnwrap(meshId: string): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;

    const before = mesh.editMesh.toJSON();
    mesh.editMesh.autoUnwrap();
    mesh.syncFromEditMesh();

    this.pushCommand({
      description: 'Auto UV unwrap',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh!.autoUnwrap(); mesh.syncFromEditMesh(); },
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

  /** Delete a set of faces. */
  deleteFaces(meshId: string, fIdxSet: Set<number> | null): boolean {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return false;
    const set = fIdxSet ?? this._selection?.faces ?? new Set<number>();
    if (set.size === 0) return false;
    const before = mesh.editMesh.toJSON();
    mesh.editMesh.deleteFaces(set);
    mesh.syncFromEditMesh();
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

  /** Weld all vertices within `threshold` distance. Returns the number removed. */
  mergeByDistance(meshId: string, threshold: number): number {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return 0;
    const before = mesh.editMesh.toJSON();
    const removed = mesh.editMesh.mergeByDistance(threshold);
    mesh.syncFromEditMesh();
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
    const allFaceLists = em['_getAllFaceLists']() as number[][];

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

    // Build remapped face lists
    const newFaceLists: number[][] = [];
    for (const fi of set) {
      if (fi >= 0 && fi < allFaceLists.length) {
        newFaceLists.push(allFaceLists[fi].map(vi => oldToNew.get(vi)!));
      }
    }

    // Create new EditMesh
    const newEm = new EditMesh();
    newEm.vertices = newVerts;
    newEm['_buildTopology'](newFaceLists);

    // Create new Mesh3D at source's position
    const newMesh = new Mesh3D(this.ctx.interactionService, mesh.x, mesh.y, mesh.z, { primitive: 'custom', geometry: newEm.compile() });
    newMesh.editMesh = newEm;
    newMesh.syncFromEditMesh();

    const sourceBefore = em.toJSON();
    em.deleteFaces(set);
    mesh.syncFromEditMesh();

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

  addMirrorModifier(meshId: string, axis: 'x' | 'y' | 'z' = 'x', clipping = true): number {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return -1;
    const mod = new MirrorModifier(axis, clipping);
    mesh.editMesh.modifiers.push(mod);
    mesh.syncFromEditMesh();
    return mesh.editMesh.modifiers.length - 1;
  }

  addSubdivisionModifier(meshId: string, iterations = 1): number {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return -1;
    const mod = new SubdivisionModifier(iterations);
    mesh.editMesh.modifiers.push(mod);
    mesh.syncFromEditMesh();
    return mesh.editMesh.modifiers.length - 1;
  }

  setModifierEnabled(meshId: string, index: number, enabled: boolean): void {
    const mesh = this._getMesh(meshId);
    const mod = mesh?.editMesh?.modifiers[index];
    if (!mod) return;
    mod.enabled = enabled;
    mesh!.syncFromEditMesh();
  }

  removeModifier(meshId: string, index: number): void {
    const mesh = this._getMesh(meshId);
    if (!mesh?.editMesh) return;
    mesh.editMesh.modifiers.splice(index, 1);
    mesh.syncFromEditMesh();
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
   * Build a rough EditMesh from a Mesh3D's existing geometry (for custom/imported meshes).
   * Reads the flat vertex buffer and produces one EditMesh triangle per GPU triangle.
   * No topology welding — vertices shared in the GPU buffer are not shared in the EditMesh.
   * Suitable for inspection/painting; heavy topology editing on unoptimized meshes will be slow.
   */
  private _editMeshFromGeometry(mesh: Mesh3D): EditMesh {
    const em = new EditMesh();
    const geom = mesh.geometry;
    if (!geom) return EditMesh.fromBox(1, 1, 1);

    const stride = 12;  // FLOATS_PER_VERT = 12
    const verts = geom.vertices;
    const idxs = geom.indices;

    const nVerts = verts.length / stride;
    for (let i = 0; i < nVerts; i++) {
      const o = i * stride;
      em.vertices.push({ x: verts[o], y: verts[o + 1], z: verts[o + 2], color: [0.8, 0.8, 0.8, 1], halfEdge: -1 });
    }

    const faceLists: number[][] = [];
    for (let i = 0; i < idxs.length; i += 3) {
      faceLists.push([idxs[i], idxs[i + 1], idxs[i + 2]]);
    }
    em._buildTopology(faceLists);
    return em;
  }
}
