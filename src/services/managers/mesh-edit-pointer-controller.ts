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
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { isPointerEventClaimed } from '../../renderer/util/pointer-claims';

export type MeshEditSelectionMode = 'vertex' | 'face' | 'edge';

/** Radius (canvas device pixels) within which a vertex/edge midpoint counts as "hit". */
const VERTEX_PICK_RADIUS_PX = 14;
const EDGE_PICK_RADIUS_PX   = 10;
/** TOUCH-8: vertex / edge pick radius multiplier under a finger. */
const TOUCH_PICK_SCALE = 2;

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
  /** All vertex positions at drag start — lets the drag re-apply as an absolute move from the
   *  start each frame (no float drift) while routing through moveVertex for proportional falloff. */
  private _dragStartVerts: { x: number; y: number; z: number }[] | null = null;

  private readonly _onDown = (e: PointerEvent) => this._handleDown(e);
  private readonly _onMove = (e: PointerEvent) => this._handleMove(e);
  private readonly _onUp   = (e: PointerEvent) => this._handleUp(e);
  private readonly _onCancel = (e: PointerEvent) => this._handleCancel(e);
  /** TOUCH-5: touch pointers down; only the first drives a pick / vertex drag, a 2nd one cancels the drag. */
  private _touchIds = new Set<number>();
  private _dragPointerId: number | null = null;
  /** Pick radius multiplier for the current press (TOUCH_PICK_SCALE for a finger, 1 for the mouse). */
  private _pickScale = 1;

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
    addZonelessListener(canvas, 'pointerdown', this._onDown);
    addZonelessListener(canvas, 'pointermove', this._onMove);
    addZonelessListener(canvas, 'pointerup',   this._onUp);
    addZonelessListener(canvas, 'pointercancel', this._onCancel);
    canvas.style.cursor = 'crosshair';
  }

  detach(): void {
    if (!this._canvas) return;
    removeZonelessListener(this._canvas, 'pointerdown', this._onDown);
    removeZonelessListener(this._canvas, 'pointermove', this._onMove);
    removeZonelessListener(this._canvas, 'pointerup',   this._onUp);
    removeZonelessListener(this._canvas, 'pointercancel', this._onCancel);
    this._touchIds.clear();
    this._dragPointerId = null;
    this._canvas.style.cursor = 'default';
    this._canvas = null;
    this._meshId = null;
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    this._dragStartVerts = null;
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
    if (e.pointerType === 'touch') {
      this._touchIds.add(e.pointerId ?? 0);
      // A 2nd finger is a camera gesture: cancel (restore) the vertex drag the first finger started; never pick.
      if (this._touchIds.size > 1) { this._cancelDrag(); return; }
      // 7.3b P1: a finger UV paint took (not stopped, so the orbit controller can pinch) is a brush stroke — no pick.
      if (isPointerEventClaimed(e)) return;
    }
    this._pickScale = e.pointerType === 'touch' ? TOUCH_PICK_SCALE : 1;

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

        // Begin drag — but NOT on a skinned body. Recompiling its geometry from the EditMesh
        // (what a move would do) emits flat-shaded, grey, differently-wound geometry that renders
        // the rigged body faceted, grey, and back-culled; makeEditable() keeps the original
        // skinned geometry for exactly this reason. Selection/UV/painting still work — only
        // free-form vertex sculpting is suppressed here.
        const mesh = this._getMesh();
        if (mesh?.editMesh && !(mesh instanceof SkinnedMesh3D)) {
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
          this._dragStartVerts = mesh.editMesh.vertices.map(vt => ({ x: vt.x, y: vt.y, z: vt.z }));
          this._canvas.setPointerCapture(e.pointerId);
          this._dragPointerId = e.pointerId ?? null;
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
    // Only the pointer that started a vertex drag moves it (a 2nd finger must not yank the vertex).
    if (this._dragging && this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
    this._pickScale = e.pointerType === 'touch' ? TOUCH_PICK_SCALE : 1;
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

      // Re-apply as an absolute move from the drag start: restore every vertex to its start
      // position, then move once through moveVertex. This keeps the no-drift property of an
      // absolute set AND lets proportional (soft) editing spread the delta to neighbours within
      // the falloff radius (moveVertex handles the falloff; a raw v.x = start + delta did not).
      const startVerts = this._dragStartVerts;
      const verts = mesh.editMesh.vertices;
      if (startVerts) {
        for (let i = 0; i < verts.length && i < startVerts.length; i++) {
          verts[i].x = startVerts[i].x;
          verts[i].y = startVerts[i].y;
          verts[i].z = startVerts[i].z;
        }
      }
      mesh.editMesh.moveVertex(this._dragVertexIdx, delta.x, delta.y, delta.z);
      mesh.syncFromEditMesh();
      this._scheduleRender();

    } else if (this._mode === 'vertex') {
      // Hover highlight: change cursor when near a vertex
      const vi = this._pickVertex(px, py);
      this._canvas.style.cursor = vi >= 0 ? 'grab' : 'crosshair';
    }
  }

  private _handleUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if (this._dragging && this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
    this._dragPointerId = null;
    if (this._dragging && this._dragVertexIdx >= 0 && this._meshId && this._dragSnapshot) {
      const mesh = this._getMesh();
      if (mesh?.editMesh) {
        const before = this._dragSnapshot;
        // Snapshot the WHOLE mesh, not just the dragged vertex: with proportional editing the
        // drag also moved neighbours, so a redo that restored only one vertex would leave the
        // rest at their pre-drag positions.
        const after = mesh.editMesh.toJSON();
        // Push ONE undo command for the whole drag gesture
        this._pushCmd({
          description: 'Move vertex',
          undo: () => {
            mesh.editMesh = EditMesh.fromJSON(before);
            mesh.syncFromEditMesh();
          },
          redo: () => {
            mesh.editMesh = EditMesh.fromJSON(after);
            mesh.syncFromEditMesh();
          },
        });
      }
    }

    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    this._dragStartVerts = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  private _handleCancel(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if (this._dragPointerId === null || e.pointerId === undefined || e.pointerId === this._dragPointerId) this._cancelDrag();
  }

  /** Abort an in-flight vertex drag: every vertex back to its drag-start position, no undo entry. */
  private _cancelDrag(): void {
    if (this._dragging && this._dragStartVerts) {
      const mesh = this._getMesh();
      if (mesh?.editMesh) {
        const verts = mesh.editMesh.vertices, start = this._dragStartVerts;
        for (let i = 0; i < verts.length && i < start.length; i++) { verts[i].x = start[i].x; verts[i].y = start[i].y; verts[i].z = start[i].z; }
        mesh.syncFromEditMesh();
        this._scheduleRender();
      }
    }
    if (this._canvas && this._dragPointerId !== null) { try { this._canvas.releasePointerCapture(this._dragPointerId); } catch { /* gone */ } }
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    this._dragStartVerts = null;
    this._dragPointerId = null;
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

    let best = -1, bestDist = VERTEX_PICK_RADIUS_PX * this._pickScale;
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

    let best = -1, bestDist = EDGE_PICK_RADIUS_PX * this._pickScale;
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
