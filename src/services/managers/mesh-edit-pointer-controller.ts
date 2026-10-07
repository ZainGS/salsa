/**
 * MeshEditPointerController — canvas pointer handling for mesh edit mode.
 *
 * Owns all pointer events on the WebGPU canvas while a mesh is in edit mode.
 * Provides click-to-select and drag-to-move for vertex/face/edge modes without
 * any Frogmarks code — same pattern as TransformController3D for gizmo interaction.
 *
 * Touch (TOUCH-5 / TOUCH-6 / TOUCH-10, docs/ui/touch-controls.md §3): a finger never acts on the press. A TAP (release
 * within {@link MeshEditPointerController.TAP_SLOP_PX}) selects at the release point; in vertex mode a finger that
 * DRAGS from a vertex selects it and moves it (from the press point). A second finger (pinch / two-finger orbit)
 * drops the press, or CANCELS the drag: every vertex and the selection go back exactly, no undo entry.
 * `pointercancel` does the same. Additive select = Shift, or the host's latch (sm.setAdditiveSelect3D).
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

/** Optional host hooks (all have safe defaults). */
export interface MeshEditPointerOptions {
  /** The additive-select latch (sm.setAdditiveSelect3D): a press adds to the selection like Shift. */
  isAdditive?: () => boolean;
  /** Frame scheduling for the coalesced drag / hover work (tests inject; default requestAnimationFrame, or run
   *  synchronously where there is none). */
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

type Rect = { left: number; top: number; width: number; height: number };
type SelSnap = ReturnType<MeshEditManager['snapshotSelection']>;

export class MeshEditPointerController {
  /** A finger that moved further than this (CSS px) is a drag, not a tap. */
  static readonly TAP_SLOP_PX = 8;

  private _scene3d: Scene3DManager;
  private _meshEdit: MeshEditManager;
  private _pushCmd: (cmd: Command3D) => void;
  private readonly _opts: MeshEditPointerOptions;

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
  /** The selection before a FINGER drag selected its vertex (a cancel puts it back); undefined = not taken. */
  private _dragSelSnap: SelSnap | undefined = undefined;
  /** The canvas rect, read once per press / drag instead of per pointer move. */
  private _rect: Rect | null = null;
  /** Latest drag position (canvas px), applied once per frame: a drag move recompiles the mesh (syncFromEditMesh). */
  private _dragAt: { x: number; y: number } | null = null;
  private _dragFrame = 0;
  /** Latest mouse hover position (vertex-mode cursor), resolved once per frame. */
  private _hoverAt: { x: number; y: number } | null = null;
  private _hoverFrame = 0;

  private readonly _onDown = (e: PointerEvent) => this._handleDown(e);
  private readonly _onMove = (e: PointerEvent) => this._handleMove(e);
  private readonly _onUp   = (e: PointerEvent) => this._handleUp(e);
  private readonly _onCancel = (e: PointerEvent) => this._handleCancel(e);
  private readonly _onLost = (e: PointerEvent) => this._handleLostCapture(e);
  /** TOUCH-5: touch pointers down; only the first drives a pick / vertex drag, a 2nd one cancels the drag. */
  private _touchIds = new Set<number>();
  private _dragPointerId: number | null = null;
  /** Pick radius multiplier for the current press (TOUCH_PICK_SCALE for a finger, 1 for the mouse). */
  private _pickScale = 1;
  /** A finger press waiting to become a tap (on release) or a vertex drag (on movement). */
  private _pending: { id: number; clientX: number; clientY: number; additive: boolean } | null = null;

  private _scheduleRenderFn: () => void;

  constructor(
    scene3d: Scene3DManager,
    meshEdit: MeshEditManager,
    pushCmd: (cmd: Command3D) => void,
    scheduleRender: () => void,
    opts: MeshEditPointerOptions = {},
  ) {
    this._scene3d = scene3d;
    this._meshEdit = meshEdit;
    this._pushCmd = pushCmd;
    this._scheduleRenderFn = scheduleRender;
    this._opts = opts;
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
    addZonelessListener(canvas, 'lostpointercapture', this._onLost);
    canvas.style.cursor = 'crosshair';
  }

  detach(): void {
    if (!this._canvas) return;
    removeZonelessListener(this._canvas, 'pointerdown', this._onDown);
    removeZonelessListener(this._canvas, 'pointermove', this._onMove);
    removeZonelessListener(this._canvas, 'pointerup',   this._onUp);
    removeZonelessListener(this._canvas, 'pointercancel', this._onCancel);
    removeZonelessListener(this._canvas, 'lostpointercapture', this._onLost);
    this._cancelFrames();
    this._touchIds.clear();
    this._dragPointerId = null;
    this._pending = null;
    this._canvas.style.cursor = 'default';
    this._canvas = null;
    this._meshId = null;
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    this._dragStartVerts = null;
    this._dragSelSnap = undefined;
    this._rect = null;
  }

  setMode(mode: MeshEditSelectionMode): void {
    this._mode = mode;
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._pending = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  get mode(): MeshEditSelectionMode { return this._mode; }
  get isAttached(): boolean { return this._canvas !== null; }
  /** True while a vertex drag (or a finger press that may become one) owns a pointer. */
  get isBusy(): boolean { return this._dragging || this._pending !== null; }

  // ── Pointer handlers ────────────────────────────────────────────────────────

  private _handleDown(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    // Only handle primary button
    if (e.button !== 0) return;
    const additive = !!e.shiftKey || this._isAdditive();
    if (e.pointerType === 'touch') {
      const id = e.pointerId ?? 0;
      // The primary finger starts a new contact sequence: ids still tracked are stale (a missed up).
      if (e.isPrimary && !this._dragging && !this._pending) this._touchIds.clear();
      this._touchIds.add(id);
      // A 2nd finger is a camera gesture: drop the press, cancel (restore) a vertex drag; never pick.
      if (this._touchIds.size > 1) { this._pending = null; this._cancelDrag(); return; }
      // 7.3b P1: a finger UV paint took (not stopped, so the orbit controller can pinch) is a brush stroke — no pick.
      if (isPointerEventClaimed(e)) return;
      if (e.isPrimary === false) return;
      // TOUCH-6: nothing on the press — a tap selects on release, a drag from a vertex moves it.
      this._pending = { id, clientX: e.clientX, clientY: e.clientY, additive };
      this._rect = this._canvas.getBoundingClientRect();
      return;
    }
    this._pickScale = 1;
    this._rect = this._canvas.getBoundingClientRect();
    const { x: px, y: py } = this._toCanvasPx(e.clientX, e.clientY);

    if (this._mode === 'vertex') {
      const vi = this._pickVertex(px, py);
      if (vi >= 0) {
        this._meshEdit.selectVertex(this._meshId, vi, additive);
        this._onSelectionChange?.();
        this._beginVertexDrag(vi, px, py, e.pointerId);
        this._scheduleRender();
      }
    } else {
      this._selectAt(px, py, additive);
    }
  }

  private _handleMove(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    const touch = e.pointerType === 'touch';
    // A finger press that moved past the slop: in vertex mode a drag from a vertex picks it up (from the PRESS point,
    // so it follows the finger exactly); otherwise it isn't a tap any more and does nothing.
    const p = this._pending;
    if (p && touch && (e.pointerId ?? 0) === p.id) {
      if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) <= MeshEditPointerController.TAP_SLOP_PX) return;
      this._pending = null;
      if (this._mode !== 'vertex' || this._touchIds.size > 1 || this._scene3d.getTouchNavigate3D?.()) return;
      this._pickScale = TOUCH_PICK_SCALE;
      const at = this._toCanvasPx(p.clientX, p.clientY);
      const vi = this._pickVertex(at.x, at.y);
      if (vi < 0 || !this._canDragVertex()) return;
      this._dragSelSnap = this._meshEdit.snapshotSelection(this._meshId);
      this._meshEdit.selectVertex(this._meshId, vi, p.additive);
      this._onSelectionChange?.();
      this._beginVertexDrag(vi, at.x, at.y, p.id);
      // fall through: apply the current position
    }
    // Only the pointer that started a vertex drag moves it (a 2nd finger must not yank the vertex).
    if (this._dragging) {
      if (this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
      if (this._mode !== 'vertex' || this._dragVertexIdx < 0) return;
      this._dragAt = this._toCanvasPx(e.clientX, e.clientY);
      this._scheduleDragFrame();
      return;
    }
    if (touch || this._mode !== 'vertex') return;   // a finger has no hover
    // Mouse hover in vertex mode: the cursor shows "grab" over a vertex — resolved once per frame (a pick is O(V)).
    this._hoverAt = { x: e.clientX, y: e.clientY };
    if (this._hoverFrame) return;
    this._hoverFrame = this._frame(() => {
      this._hoverFrame = 0;
      const at = this._hoverAt;
      this._hoverAt = null;
      if (!at || !this._canvas || this._dragging || this._mode !== 'vertex') return;
      this._pickScale = 1;
      this._rect = null;   // a hover reads the rect fresh (the canvas may have moved since the last press)
      const c = this._toCanvasPx(at.x, at.y);
      this._canvas.style.cursor = this._pickVertex(c.x, c.y) >= 0 ? 'grab' : 'crosshair';
    });
  }

  private _handleUp(e: PointerEvent): void {
    const touch = e.pointerType === 'touch';
    if (touch) this._touchIds.delete(e.pointerId ?? 0);
    const p = this._pending;
    if (p && touch && (e.pointerId ?? 0) === p.id) {
      // A TAP: select at the release point (vertex mode selects only — a drag needs movement).
      this._pending = null;
      if (this._canvas && this._meshId) {
        this._pickScale = TOUCH_PICK_SCALE;
        const at = this._toCanvasPx(e.clientX, e.clientY);
        this._selectAt(at.x, at.y, p.additive);
      }
      this._rect = null;
      return;
    }
    if (this._dragging && this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
    this._dragPointerId = null;
    if (this._dragging) this._flushDragFrame();
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
    this._dragSelSnap = undefined;
    this._rect = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  private _handleCancel(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if (this._pending && (e.pointerId ?? 0) === this._pending.id) { this._pending = null; return; }
    if (this._dragPointerId === null || e.pointerId === undefined || e.pointerId === this._dragPointerId) this._cancelDrag();
  }

  /** The drag's pointer lost capture without an up (the browser / another handler took it): end the drag normally
   *  (after a normal up it is already over — no-op). */
  private _handleLostCapture(e: PointerEvent): void {
    if (!this._dragging || this._dragPointerId === null || e.pointerId !== this._dragPointerId) return;
    this._handleUp(e);
  }

  // ── Selection + drag ────────────────────────────────────────────────────────

  /** Select the vertex / face / edge at canvas px (x, y) (mouse press, or a finger tap). */
  private _selectAt(px: number, py: number, additive: boolean): void {
    if (!this._meshId) return;
    if (this._mode === 'face') {
      const fi = this._pickFace(px, py);
      if (fi >= 0) {
        this._meshEdit.selectFace(this._meshId, fi, additive);
        this._onSelectionChange?.();
        this._scheduleRender();
      }
    } else if (this._mode === 'vertex') {
      const vi = this._pickVertex(px, py);
      if (vi >= 0) {
        this._meshEdit.selectVertex(this._meshId, vi, additive);
        this._onSelectionChange?.();
        this._scheduleRender();
      }
    } else if (this._mode === 'edge') {
      const hi = this._pickEdge(px, py);
      if (hi >= 0) {
        this._meshEdit.selectEdge(this._meshId, hi, additive);
        this._onSelectionChange?.();
        this._scheduleRender();
      }
    }
  }

  /** Vertex sculpting is off on a skinned body: recompiling its geometry from the EditMesh (what a move would do)
   *  emits flat-shaded, grey, differently-wound geometry that renders the rigged body faceted, grey, and back-culled;
   *  makeEditable() keeps the original skinned geometry for exactly this reason. Selection/UV/painting still work. */
  private _canDragVertex(): boolean {
    const mesh = this._getMesh();
    return !!mesh?.editMesh && !(mesh instanceof SkinnedMesh3D);
  }

  /** Begin a vertex drag at canvas px (x, y) — not on a skinned body (see _canDragVertex). */
  private _beginVertexDrag(vi: number, px: number, py: number, pointerId: number): void {
    const mesh = this._getMesh();
    if (!this._canvas || !mesh?.editMesh || mesh instanceof SkinnedMesh3D) return;
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
    try { this._canvas.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    this._dragPointerId = pointerId ?? null;
    this._canvas.style.cursor = 'grabbing';
  }

  /** Apply the latest drag position (once per frame): every vertex back to its drag-start position, then ONE
   *  moveVertex, so the drag stays an absolute move from the start (no float drift) AND proportional (soft) editing
   *  spreads the delta to the neighbours within the falloff radius (moveVertex handles the falloff). */
  private _applyDrag(): void {
    const at = this._dragAt;
    this._dragAt = null;
    if (!at || !this._canvas || !this._dragging || this._dragVertexIdx < 0) return;
    const mesh = this._getMesh();
    if (!mesh?.editMesh || !this._dragStartObjPos) return;

    // Unproject current and drag-start canvas positions at captured depth
    const wNow   = this._scene3d.unprojectScreenToWorld3D(at.x, at.y, this._dragDepth, this._canvas.width, this._canvas.height);
    const wStart = this._scene3d.unprojectScreenToWorld3D(this._dragStartCanvasX, this._dragStartCanvasY, this._dragDepth, this._canvas.width, this._canvas.height);

    // Convert world-space delta to object-space delta via model matrix inverse
    const delta = this._worldDeltaToObj(wNow.x - wStart.x, wNow.y - wStart.y, wNow.z - wStart.z, mesh);

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
  }

  /** Abort an in-flight vertex drag: every vertex back to its drag-start position, and (for a finger drag) the
   *  selection as it was before the press. No undo entry. */
  private _cancelDrag(): void {
    if (this._dragFrame) { this._cancelFrame(this._dragFrame); this._dragFrame = 0; }
    this._dragAt = null;
    if (this._dragging && this._dragStartVerts) {
      const mesh = this._getMesh();
      if (mesh?.editMesh) {
        const verts = mesh.editMesh.vertices, start = this._dragStartVerts;
        for (let i = 0; i < verts.length && i < start.length; i++) { verts[i].x = start[i].x; verts[i].y = start[i].y; verts[i].z = start[i].z; }
        mesh.syncFromEditMesh();
      }
      if (this._dragSelSnap !== undefined && this._meshId) {
        this._meshEdit.restoreSelection(this._meshId, this._dragSelSnap);
        this._onSelectionChange?.();
      }
      this._scheduleRender();
    }
    if (this._canvas && this._dragPointerId !== null) { try { this._canvas.releasePointerCapture(this._dragPointerId); } catch { /* gone */ } }
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._dragSnapshot = null;
    this._dragStartObjPos = null;
    this._dragStartVerts = null;
    this._dragSelSnap = undefined;
    this._dragPointerId = null;
    this._rect = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  // ── Frame coalescing ────────────────────────────────────────────────────────

  private _frame(cb: () => void): number {
    if (this._opts.requestFrame) return this._opts.requestFrame(cb);
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    cb();
    return 0;
  }

  private _cancelFrame(id: number): void {
    if (this._opts.cancelFrame) this._opts.cancelFrame(id);
    else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  }

  private _scheduleDragFrame(): void {
    if (this._dragFrame) return;
    let ran = false;
    const id = this._frame(() => { ran = true; this._dragFrame = 0; this._applyDrag(); });
    if (!ran) this._dragFrame = id;
  }

  /** Apply a drag position still waiting for its frame (before the drag's undo snapshot). */
  private _flushDragFrame(): void {
    if (this._dragFrame) { this._cancelFrame(this._dragFrame); this._dragFrame = 0; }
    if (this._dragAt) this._applyDrag();
  }

  private _cancelFrames(): void {
    if (this._dragFrame) { this._cancelFrame(this._dragFrame); this._dragFrame = 0; }
    if (this._hoverFrame) { this._cancelFrame(this._hoverFrame); this._hoverFrame = 0; }
    this._dragAt = null;
    this._hoverAt = null;
  }

  private _isAdditive(): boolean {
    try { return !!this._opts.isAdditive?.(); } catch { return false; }
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

  /** Object-space point → canvas px (null = behind the camera), with the model-view-projection composed ONCE per
   *  pick (it projected through two allocating helpers per vertex). Falls back to the per-point helpers when the
   *  camera isn't reachable. */
  private _projector(mesh: Mesh3D, cw: number, ch: number): (ox: number, oy: number, oz: number) => { x: number; y: number } | null {
    const vp = this._scene3d.getCamera?.()?.getViewProjectionMatrix?.() as Float32Array | undefined;
    if (!vp) {
      return (ox, oy, oz) => {
        const w = this._objToWorld(ox, oy, oz, mesh);
        return this._scene3d.projectWorldToScreen3D(w.x, w.y, w.z, cw, ch);
      };
    }
    const m = mat4.multiply(mat4.create(), vp as unknown as mat4, mesh.localMatrix as unknown as mat4);
    const out = { x: 0, y: 0 };
    return (ox, oy, oz) => {
      const cw4 = m[3] * ox + m[7] * oy + m[11] * oz + m[15];
      if (cw4 <= 0) return null;   // behind the camera
      out.x = ((m[0] * ox + m[4] * oy + m[8]  * oz + m[12]) / cw4 + 1) * 0.5 * cw;
      out.y = (1 - (m[1] * ox + m[5] * oy + m[9] * oz + m[13]) / cw4) * 0.5 * ch;
      return out;
    };
  }

  private _pickVertex(px: number, py: number): number {
    if (!this._canvas) return -1;
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return -1;
    const project = this._projector(mesh, this._canvas.width, this._canvas.height);
    const verts = mesh.editMesh.vertices;

    let best = -1, bestDist = VERTEX_PICK_RADIUS_PX * this._pickScale;
    for (let vi = 0; vi < verts.length; vi++) {
      const v = verts[vi];
      const s = project(v.x, v.y, v.z);
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
    const project = this._projector(mesh, this._canvas.width, this._canvas.height);

    let best = -1, bestDist = EDGE_PICK_RADIUS_PX * this._pickScale;
    for (let hi = 0; hi < em.halfEdges.length; hi++) {
      const he = em.halfEdges[hi];
      // Skip one half of each pair (avoid duplicate checks)
      if (he.twin >= 0 && he.twin < hi) continue;
      const vTo   = em.vertices[he.vertex];
      const vFrom = em.vertices[em.halfEdges[he.prev].vertex];
      const s = project((vTo.x + vFrom.x) / 2, (vTo.y + vFrom.y) / 2, (vTo.z + vFrom.z) / 2);
      if (!s) continue;
      const d = Math.sqrt((s.x - px) ** 2 + (s.y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = hi; }
    }
    return best;
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  /** Client (CSS) coords → canvas device pixels, through the rect read at the press (or now). */
  private _toCanvasPx(clientX: number, clientY: number): { x: number; y: number } {
    if (!this._canvas) return { x: 0, y: 0 };
    const rect = this._rect ?? this._canvas.getBoundingClientRect();
    const dpr = this._canvas.width / (rect.width || 1);
    return {
      x: (clientX - rect.left) * dpr,
      y: (clientY - rect.top)  * dpr,
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
