/**
 * MeshEditPointerController — canvas pointer handling for mesh edit mode.
 *
 * Owns all pointer events on the WebGPU canvas while a mesh is in edit mode.
 * Provides click-to-select and drag-to-move for vertex/face/edge modes without
 * any Frogmarks code — same pattern as TransformController3D for gizmo interaction.
 *
 * Usage:
 *   sm.attachMeshEditPointerHandlers(canvas, meshId, () => panel.refresh());
 *   sm.setMeshEditSelectionMode('face');
 *   // ... user edits ...
 *   sm.detachMeshEditPointerHandlers();
 */

import { mat4, vec4 } from 'gl-matrix';
import type { Scene3DManager } from './scene3d-manager';
import type { MeshEditManager } from './mesh-edit-manager';
import type { Command3D } from './undo-manager-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';

export type MeshEditSelectionMode = 'vertex' | 'face' | 'edge';

/** Radius (canvas device pixels) within which a vertex/edge midpoint counts as "hit". */
const VERTEX_PICK_RADIUS_PX = 14;
const EDGE_PICK_RADIUS_PX   = 10;

export class MeshEditPointerController {
  private _scene3d: Scene3DManager;
  private _meshEdit: MeshEditManager;
  private _pushCmd: (cmd: Command3D) => void;

  private _canvas: HTMLCanvasElement | null = null;
  private _meshId: string | null = null;
  private _mode: MeshEditSelectionMode = 'face';
  private _onSelectionChange: (() => void) | null = null;

  // Vertex drag state
  private _dragging = false;
  private _dragVertexIdx = -1;
  private _dragDepth = 0;
  private _dragStartCanvasX = 0;
  private _dragStartCanvasY = 0;
  private _dragStartObjPos: { x: number; y: number; z: number } | null = null;
  private _dragSnapshot: object | null = null;

  private readonly _onDown = (e: PointerEvent) => this._handleDown(e);
  private readonly _onMove = (e: PointerEvent) => this._handleMove(e);
  private readonly _onUp   = (e: PointerEvent) => this._handleUp(e);

  private _scheduleRenderFn: () => void;

  constructor(
    scene3d: Scene3DManager,
    meshEdit: MeshEditManager,
    pushCmd: (cmd: Command3D) => void,
    scheduleRender: () => void,
  ) {
    this._scene3d = scene3d;
    this._meshEdit = meshEdit;
    this._pushCmd = pushCmd;
    this._scheduleRenderFn = scheduleRender;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement, meshId: string, onSelectionChange?: () => void): void {
    this.detach();
    this._canvas = canvas;
    this._meshId = meshId;
    this._onSelectionChange = onSelectionChange ?? null;
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup',   this._onUp);
    canvas.style.cursor = 'crosshair';
  }

  detach(): void {
    if (!this._canvas) return;
    this._canvas.removeEventListener('pointerdown', this._onDown);
    this._canvas.removeEventListener('pointermove', this._onMove);
    this._canvas.removeEventListener('pointerup',   this._onUp);
    this._canvas.style.cursor = 'default';
    this._canvas = null;
    this._meshId = null;
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
  }

  setMode(mode: MeshEditSelectionMode): void {
    this._mode = mode;
    this._dragging = false;
    this._dragVertexIdx = -1;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  get mode(): MeshEditSelectionMode { return this._mode; }
  get isAttached(): boolean { return this._canvas !== null; }

  // ── Pointer handlers ────────────────────────────────────────────────────────

  private _handleDown(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    // Only handle primary button
    if (e.button !== 0) return;

    const { x: px, y: py } = this._toCanvasPx(e);

    if (this._mode === 'face') {
      const fi = this._pickFace(px, py);
      if (fi >= 0) {
        this._meshEdit.selectFace(this._meshId, fi, e.shiftKey);
        this._onSelectionChange?.();
        this._scheduleRender();
      }

    } else if (this._mode === 'vertex') {
      const vi = this._pickVertex(px, py);
      if (vi >= 0) {
        this._meshEdit.selectVertex(this._meshId, vi, e.shiftKey);
        this._onSelectionChange?.();

        // Begin drag
        const mesh = this._getMesh();
        if (mesh?.editMesh) {
          const v = mesh.editMesh.vertices[vi];
          const w = this._objToWorld(v.x, v.y, v.z, mesh);
          const s = this._scene3d.projectWorldToScreen3D(w.x, w.y, w.z, this._canvas.width, this._canvas.height);
          this._dragging = true;
          this._dragVertexIdx = vi;
          this._dragStartCanvasX = px;
          this._dragStartCanvasY = py;
          this._dragDepth = s?.depth ?? 0.5;
          this._dragSnapshot = mesh.editMesh.toJSON();
          this._dragStartObjPos = { x: v.x, y: v.y, z: v.z };
          this._canvas.setPointerCapture(e.pointerId);
          this._canvas.style.cursor = 'grabbing';
        }
        this._scheduleRender();
      }

    } else if (this._mode === 'edge') {
      const hi = this._pickEdge(px, py);
      if (hi >= 0) {
        this._meshEdit.selectEdge(this._meshId, hi, e.shiftKey);
        this._onSelectionChange?.();
        this._scheduleRender();
      }
    }
  }

  private _handleMove(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    const { x: px, y: py } = this._toCanvasPx(e);

    if (this._mode === 'vertex' && this._dragging && this._dragVertexIdx >= 0) {
      const mesh = this._getMesh();
      if (!mesh?.editMesh || !this._dragStartObjPos) return;

      // Unproject current and drag-start canvas positions at captured depth
      const wNow   = this._scene3d.unprojectScreenToWorld3D(px, py, this._dragDepth, this._canvas.width, this._canvas.height);
      const wStart = this._scene3d.unprojectScreenToWorld3D(this._dragStartCanvasX, this._dragStartCanvasY, this._dragDepth, this._canvas.width, this._canvas.height);

      // Convert world-space delta to object-space delta via model matrix inverse
      const delta = this._worldDeltaToObj(
        wNow.x - wStart.x,
        wNow.y - wStart.y,
        wNow.z - wStart.z,
        mesh,
      );

      // Set absolute position (avoids floating-point drift from incremental deltas)
      const v = mesh.editMesh.vertices[this._dragVertexIdx];
      v.x = this._dragStartObjPos.x + delta.x;
      v.y = this._dragStartObjPos.y + delta.y;
      v.z = this._dragStartObjPos.z + delta.z;
      mesh.syncFromEditMesh();
      this._scheduleRender();

    } else if (this._mode === 'vertex') {
      // Hover highlight: change cursor when near a vertex
      const vi = this._pickVertex(px, py);
      this._canvas.style.cursor = vi >= 0 ? 'grab' : 'crosshair';
    }
  }

  private _handleUp(e: PointerEvent): void {
    if (this._dragging && this._dragVertexIdx >= 0 && this._meshId && this._dragSnapshot) {
      const mesh = this._getMesh();
      if (mesh?.editMesh) {
        const snapshot = this._dragSnapshot;
        const vIdx = this._dragVertexIdx;
        const { x, y, z } = mesh.editMesh.vertices[vIdx];
        // Push ONE undo command for the whole drag gesture
        this._pushCmd({
          description: 'Move vertex',
          undo: () => {
            mesh.editMesh = EditMesh.fromJSON(snapshot);
            mesh.syncFromEditMesh();
          },
          redo: () => {
            if (!mesh.editMesh) return;
            const v = mesh.editMesh.vertices[vIdx];
            v.x = x; v.y = y; v.z = z;
            mesh.syncFromEditMesh();
          },
        });
      }
    }

    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  // ── Picking ─────────────────────────────────────────────────────────────────

  private _pickFace(px: number, py: number): number {
    if (!this._canvas || !this._meshId) return -1;
    const hit = this._scene3d.pick3D(px, py, this._canvas.width, this._canvas.height);
    if (!hit || hit.meshId !== this._meshId) return -1;

    const mesh = this._getMesh();
    if (!mesh?.editMesh) return -1;

    // Find the EditMesh face whose world-space center is closest to the hit point
    const [hx, hy, hz] = hit.hitPoint;
    let bestFace = -1, bestDist = Infinity;
    for (let fi = 0; fi < mesh.editMesh.faces.length; fi++) {
      const [cx, cy, cz] = mesh.editMesh.getFaceCenter(fi);
      const w = this._objToWorld(cx, cy, cz, mesh);
      const d = Math.sqrt((w.x - hx) ** 2 + (w.y - hy) ** 2 + (w.z - hz) ** 2);
      if (d < bestDist) { bestDist = d; bestFace = fi; }
    }
    return bestFace;
  }

  private _pickVertex(px: number, py: number): number {
    if (!this._canvas) return -1;
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return -1;
    const { width: cw, height: ch } = this._canvas;

    let best = -1, bestDist = VERTEX_PICK_RADIUS_PX;
    for (let vi = 0; vi < mesh.editMesh.vertices.length; vi++) {
      const v = mesh.editMesh.vertices[vi];
      const w = this._objToWorld(v.x, v.y, v.z, mesh);
      const s = this._scene3d.projectWorldToScreen3D(w.x, w.y, w.z, cw, ch);
      if (!s) continue;
      const d = Math.sqrt((s.x - px) ** 2 + (s.y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = vi; }
    }
    return best;
  }

  private _pickEdge(px: number, py: number): number {
    if (!this._canvas) return -1;
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return -1;
    const em = mesh.editMesh;
    const { width: cw, height: ch } = this._canvas;

    let best = -1, bestDist = EDGE_PICK_RADIUS_PX;
    for (let hi = 0; hi < em.halfEdges.length; hi++) {
      const he = em.halfEdges[hi];
      // Skip one half of each pair (avoid duplicate checks)
      if (he.twin >= 0 && he.twin < hi) continue;
      const vTo   = em.vertices[he.vertex];
      const vFrom = em.vertices[em.halfEdges[he.prev].vertex];
      const mx = (vTo.x + vFrom.x) / 2;
      const my = (vTo.y + vFrom.y) / 2;
      const mz = (vTo.z + vFrom.z) / 2;
      const w = this._objToWorld(mx, my, mz, mesh);
      const s = this._scene3d.projectWorldToScreen3D(w.x, w.y, w.z, cw, ch);
      if (!s) continue;
      const d = Math.sqrt((s.x - px) ** 2 + (s.y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = hi; }
    }
    return best;
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  /** Convert a PointerEvent (CSS client coords) to canvas device pixels. */
  private _toCanvasPx(e: PointerEvent): { x: number; y: number } {
    if (!this._canvas) return { x: 0, y: 0 };
    const rect = this._canvas.getBoundingClientRect();
    const dpr = this._canvas.width / (rect.width || 1);
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top)  * dpr,
    };
  }

  /** Transform an object-space point to world space using the mesh's combined matrix. */
  private _objToWorld(ox: number, oy: number, oz: number, mesh: Mesh3D): { x: number; y: number; z: number } {
    const m = mesh.localMatrix;
    return {
      x: m[0] * ox + m[4] * oy + m[8]  * oz + m[12],
      y: m[1] * ox + m[5] * oy + m[9]  * oz + m[13],
      z: m[2] * ox + m[6] * oy + m[10] * oz + m[14],
    };
  }

  /** Transform a world-space delta vector to object space (inverse of model matrix, w=0). */
  private _worldDeltaToObj(dwx: number, dwy: number, dwz: number, mesh: Mesh3D): { x: number; y: number; z: number } {
    const inv = mat4.invert(mat4.create(), mesh.localMatrix as unknown as mat4);
    if (!inv) return { x: dwx, y: dwy, z: dwz };
    const dir = vec4.fromValues(dwx, dwy, dwz, 0); // w=0 = direction (no translation)
    vec4.transformMat4(dir, dir, inv);
    return { x: dir[0], y: dir[1], z: dir[2] };
  }

  private _getMesh(): Mesh3D | null {
    if (!this._meshId) return null;
    return this._scene3d.getMesh(this._meshId);
  }

  private _scheduleRender(): void {
    this._scheduleRenderFn();
  }
}
