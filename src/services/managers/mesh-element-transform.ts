/**
 * MeshElementTransform — Edit Mesh ELEMENT transforms (docs/specs/edit-mesh-topology.md §11): Grab / Rotate / Scale of
 * the selected vertices / edges / faces (their VERTEX SET, MeshEditManager.selectedVertexIndices — on the welded
 * topology a face's neighbours share those vertices, so they follow), not of the whole object.
 *
 * Two sources drive one session:
 *  - 'modal' — G / R / S (sm.beginTransform3D in Edit Mesh, or the touch pill's Grab / Rotate / Scale): the pointer
 *    FOLLOWS (mouse: no button needed; finger / pen: one-finger drags, each continuing from the last), X / Y / Z
 *    constrain to an axis of the current orientation (world / local — the gizmo's setting), digits type an exact amount
 *    (with an axis, as for objects), Apply (left click / Enter / the pill) or Cancel (right click / Esc / the pill).
 *  - 'gizmo' — a drag on a handle of the transform gizmo drawn at the selection's centroid (the pointer controller's
 *    hit-test): the same handle semantics as the object gizmo; the release applies.
 *
 * Pivot = the selection's centroid (median point — Blender's default), fixed for the session. Grab = the pointer's
 * movement on a plane through the pivot (camera-facing; with an axis: the plane holding the axis that faces the camera,
 * then projected on the axis; a gizmo plane handle: that plane), so the grabbed point stays under the pointer. Rotate =
 * the pointer's screen angle around the pivot (no axis: the view axis). Scale = the ratio of the pointer's screen
 * distances from the pivot (no axis: uniform; an axis: along it). Snap (Ctrl, or the host's snap latch) rounds to
 * {@link snapMove} / {@link snapAngle} / {@link snapScale}. Proportional editing (when on) moves every vertex within the
 * radius of the nearest selected vertex by the falloff weight (EditMesh.proportionalWeights — the vertex drag's curve).
 *
 * Every frame rewrites the affected vertices from their begin positions (no drift) and patches the compiled geometry
 * in place (the host's fast path — no full compile per frame); Apply runs one full compile and pushes ONE undo step;
 * Cancel puts every vertex (and any custom normal the move cleared) back exactly.
 */

import { mat3, quat, vec3, mat4 } from 'gl-matrix';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { EditMesh, type EditHalfEdge } from '../../scene-graph/shapes/edit-mesh';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import { GizmoRenderer, type GizmoAxis, type GizmoMode } from '../../renderer/3d/gizmo-renderer';
import type { MeshEditManager } from './mesh-edit-manager';
import type { Command3D } from './undo-manager-3d';

export type ElementTransformMode = 'grab' | 'rotate' | 'scale';
export type ElementTransformSource = 'modal' | 'gizmo';
type Axis1 = 'x' | 'y' | 'z';

/** The session as the host shows it (HUD readout, touch pill, tests). */
export interface ElementTransformState {
  mode: ElementTransformMode;
  source: ElementTransformSource;
  /** The constraint: an axis, a gizmo plane handle ('xy' …), or null (free / view axis / uniform). */
  axis: GizmoAxis;
  /** The typed amount (digits), '' when none. */
  numeric: string;
  /** A pointer is driving it right now. */
  dragging: boolean;
  /** The pivot (the selection's centroid at the start), world space. */
  pivot: [number, number, number];
  /** Grab: the world-space move. */
  delta: [number, number, number];
  /** Rotate: the angle (degrees). */
  angleDeg: number;
  /** Scale: the factor. */
  factor: number;
  /** Selected vertices / vertices that move (with proportional editing, more than the selection). */
  vertices: number;
  affected: number;
  orientation: 'world' | 'local';
}

export interface ElementTransformHost {
  getMesh(meshId: string): Mesh3D | null;
  getCamera(): Camera3D | null;
  meshEdit: MeshEditManager;
  pushCmd(cmd: Command3D): void;
  scheduleRender(): void;
  /** The transform orientation (the gizmo's world / local setting). Default world. */
  getOrientation?(): 'world' | 'local';
  /** The host's snap latch (touch: sm.setSnapToggle3D) — snapping as if Ctrl were held. */
  isSnapLatched?(): boolean;
  /** A frame moved vertices: bring the GPU mesh in line (in-place patch; a full compile when that can't apply). */
  syncGeometry(mesh: Mesh3D): void;
  /** Apply: one full compile if the session patched in place. */
  finishGeometry(mesh: Mesh3D): void;
  /** Cancel: a full compile of the restored mesh (drops any in-place patch state). */
  recompile(mesh: Mesh3D): void;
  /** The state changed (begin / axis / amount / apply / cancel) — the host's panel / HUD re-read it. */
  onChange?(): void;
}

const AXES: readonly Axis1[] = ['x', 'y', 'z'];

export class MeshElementTransform {
  /** Ctrl / latch snap steps: grab (world units along each axis), rotate (radians), scale (factor). */
  snapMove = 0.1;
  snapAngle = Math.PI / 12;
  snapScale = 0.1;
  /** Modal scale: below this screen distance (px) from the pivot the start point can't define a ratio — the change of
   *  distance (per 100 px) is used instead. */
  static readonly SCALE_MIN_REF_PX = 8;

  private _meshId: string | null = null;
  private _mode: ElementTransformMode = 'grab';
  private _source: ElementTransformSource = 'modal';
  private _axis: GizmoAxis = null;
  private _numeric = '';
  private _orientation: 'world' | 'local' = 'world';
  /** The EditMesh being transformed (a different object = the topology changed under the session → it ends). */
  private _em: EditMesh | null = null;
  /** Every vertex position at the start (xyz), and the weights (1 = selected, falloff = proportional, 0 = still). */
  private _start = new Float64Array(0);
  private _weights: Float32Array = new Float32Array(0);
  private _affected = new Int32Array(0);
  private _selected = new Int32Array(0);
  private readonly _pivotObj = V3();
  private readonly _pivotW = V3();
  private readonly _M3 = M3();
  private readonly _Minv3 = M3();
  private readonly _M4 = M4();
  private _basis: [vec3, vec3, vec3] = [V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1)];
  private _before: object | null = null;
  /** Every corner's custom normal at the start (a move clears those around it; Cancel puts them back in place). Null =
   *  the mesh had none. */
  private _normals: Array<EditHalfEdge['normal']> | null = null;
  private _normalsCleared = false;
  /** Some frame moved a vertex (the compiled geometry no longer matches the start → cancel recompiles). */
  private _touched = false;
  // pointer
  private _seg: { rx: number; ry: number; cx: number; cy: number } | null = null;
  /** Finished drags (touch / pen): grab = world move (unconstrained part re-projected on a later axis), rotate = screen
   *  angle (radians), scale = ratio. */
  private readonly _accMove = V3();
  private _accAngle = 0;
  private _accRatio = 1;
  private _ctrl = false;
  private _w = 1;
  private _h = 1;
  // the current result
  private readonly _delta = V3();
  private _angle = 0;
  private _factor = 1;

  constructor(private readonly host: ElementTransformHost) {}

  get active(): boolean { return this._meshId !== null; }
  get meshId(): string | null { return this._meshId; }
  get mode(): ElementTransformMode | null { return this.active ? this._mode : null; }
  get source(): ElementTransformSource | null { return this.active ? this._source : null; }
  get axis(): GizmoAxis { return this.active ? this._axis : null; }
  /** The single-axis constraint (the keyboard shortcut's X / Y / Z), null otherwise. */
  get shortcutAxis(): Axis1 | null { return this._axis === 'x' || this._axis === 'y' || this._axis === 'z' ? this._axis : null; }
  get numeric(): string { return this.active ? this._numeric : ''; }
  get dragging(): boolean { return this._seg !== null; }

  state(): ElementTransformState | null {
    if (!this.active) return null;
    return {
      mode: this._mode, source: this._source, axis: this._axis, numeric: this._numeric, dragging: this._seg !== null,
      pivot: [this._pivotW[0], this._pivotW[1], this._pivotW[2]],
      delta: [this._delta[0], this._delta[1], this._delta[2]],
      angleDeg: this._angle * (180 / Math.PI), factor: this._factor,
      vertices: this._selected.length, affected: this._affected.length, orientation: this._orientation,
    };
  }

  /** The pivot (world) — where the gizmo sits while it is dragged. */
  pivotWorld(): [number, number, number] { return [this._pivotW[0], this._pivotW[1], this._pivotW[2]]; }

  /**
   * Start a transform of `meshId`'s selected elements. False (nothing started) when the mesh has no EditMesh, is a
   * skinned body (its vertices can't be sculpted), nothing is selected, or its matrix can't be inverted. A running
   * session is cancelled first. `axis` = the gizmo handle (gizmo source) or an initial constraint.
   */
  begin(meshId: string, mode: ElementTransformMode, opts: { source?: ElementTransformSource; axis?: GizmoAxis } = {}): boolean {
    if (this.active) this.cancel();
    const mesh = this.host.getMesh(meshId);
    const em = mesh?.editMesh;
    if (!mesh || !em || mesh instanceof SkinnedMesh3D) return false;
    const sel = this.host.meshEdit.selectedVertexIndices(meshId);
    if (sel.length === 0) return false;
    const M = mesh.localMatrix as unknown as mat4;
    mat4.copy(this._M4, M);
    mat3.fromMat4(this._M3, M);
    if (!mat3.invert(this._Minv3, this._M3)) return false;

    const V = em.vertices;
    this._start = new Float64Array(V.length * 3);
    for (let i = 0; i < V.length; i++) { this._start[i * 3] = V[i].x; this._start[i * 3 + 1] = V[i].y; this._start[i * 3 + 2] = V[i].z; }
    this._weights = em.proportionalWeights(sel);
    const aff: number[] = [];
    for (let i = 0; i < V.length; i++) if (this._weights[i] > 0) aff.push(i);
    this._affected = Int32Array.from(aff);
    this._selected = Int32Array.from(sel);
    let px = 0, py = 0, pz = 0;
    for (const s of sel) { px += V[s].x; py += V[s].y; pz += V[s].z; }
    vec3.set(this._pivotObj, px / sel.length, py / sel.length, pz / sel.length);
    vec3.transformMat4(this._pivotW, this._pivotObj, this._M4);
    this._orientation = this.host.getOrientation?.() ?? 'world';
    if (this._orientation === 'local') {
      const m = this._M4;
      this._basis = [0, 4, 8].map(o => vec3.normalize(V3(), V3(m[o], m[o + 1], m[o + 2]))) as [vec3, vec3, vec3];
    } else {
      this._basis = [V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1)];
    }

    this._meshId = meshId;
    this._em = em;
    this._mode = mode;
    this._source = opts.source ?? 'modal';
    this._axis = opts.axis ?? null;
    this._numeric = '';
    this._before = em.toJSON();
    this._normals = typeof em.hasCustomNormals === 'function' && em.hasCustomNormals() ? em.halfEdges.map(h => h.normal) : null;
    this._normalsCleared = false;
    this._touched = false;
    this._seg = null;
    vec3.zero(this._accMove); this._accAngle = 0; this._accRatio = 1;
    vec3.zero(this._delta); this._angle = 0; this._factor = 1;
    this._changed();
    this.host.scheduleRender();
    return true;
  }

  /** Constrain to a world / local axis (the orientation at the start) — X / Y / Z. Clears a typed amount. */
  setAxis(axis: Axis1 | null): void {
    if (!this.active) return;
    this._axis = axis;
    this._numeric = '';
    this._evaluate();
    this._changed();
  }

  /** One typed character of the amount (digits, '.', a leading '-'). Needs an axis, as the object transform does. */
  appendNumeric(char: string): void {
    if (!this.active || !this.shortcutAxis) return;
    if (char !== '-' && char !== '.' && (char < '0' || char > '9')) return;
    if (char === '-' && this._numeric.length > 0) return;
    if (char === '.' && this._numeric.includes('.')) return;
    this._numeric += char;
    this._evaluate();
    this._changed();
  }

  // ── Pointer (canvas device px) ────────────────────────────────────────────

  /** A drag starts at (x, y): the mouse position when G was pressed, a finger press, or a gizmo handle press. */
  pointerStart(x: number, y: number, w: number, h: number): void {
    if (!this.active) return;
    this._w = w || 1; this._h = h || 1;
    this._seg = { rx: x, ry: y, cx: x, cy: y };
    this._changed();
  }

  /** The pointer moved: the transform follows (relative to the drag start, on top of finished drags). The first move
   *  of a session without a start point becomes the start point. `ctrl` = snap (inverted by nothing; the latch adds). */
  pointerMove(x: number, y: number, w: number, h: number, ctrl = false): void {
    if (!this.active) return;
    if (!this._seg) { this.pointerStart(x, y, w, h); return; }
    this._w = w || 1; this._h = h || 1;
    this._seg.cx = x; this._seg.cy = y;
    this._ctrl = ctrl;
    this._evaluate();
  }

  /** The drag ended without applying (a finger lifted while G runs): its movement is kept, the next drag continues. */
  pointerEnd(): void {
    const s = this._seg;
    if (!s || !this.active) return;
    // fold this drag into the totals (with the constraint it ran under)
    const cam = this.host.getCamera();
    if (cam) {
      const seg = this._segMove(cam, s);
      vec3.add(this._accMove, this._constrain(this._accMove), seg);
      this._accAngle += this._segAngle(cam, s);
      this._accRatio *= this._segRatio(cam, s);
    }
    this._seg = null;
    this._evaluate();
    this._changed();
  }

  /** A 2nd finger / pointercancel: this drag's movement is dropped (back to the finished drags). */
  pointerAbort(): void {
    if (!this._seg || !this.active) return;
    this._seg = null;
    this._evaluate();
    this._changed();
  }

  // ── Apply / Cancel ────────────────────────────────────────────────────────

  /** Apply: one full compile, ONE undo step. A transform that moved nothing is a cancel. Returns whether it changed. */
  commit(): boolean {
    if (!this.active) return false;
    const mesh = this.host.getMesh(this._meshId!);
    const em = mesh?.editMesh;
    if (!mesh || !em || em !== this._em) { this._end(); return false; }
    if (!this._anyMoved(em)) { this.cancel(); return false; }
    this.host.finishGeometry(mesh);
    const before = this._before!, after = em.toJSON();
    const description = this._mode === 'grab' ? 'Move elements' : this._mode === 'rotate' ? 'Rotate elements' : 'Scale elements';
    this.host.pushCmd({
      description,
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    this._end();
    return true;
  }

  /** Cancel: every vertex back where it was (and any custom normal the move recomputed), the geometry recompiled. */
  cancel(): void {
    if (!this.active) return;
    const mesh = this.host.getMesh(this._meshId!);
    const em = mesh?.editMesh;
    if (mesh && em && em === this._em && this._touched) {
      this._restoreStart(em);
      // the move recomputed the custom normals around it: the same normal objects go back on the same corners
      const N = this._normals;
      if (N && this._normalsCleared && N.length === em.halfEdges.length) em.halfEdges.forEach((h, i) => { h.normal = N[i]; });
      this.host.recompile(mesh);
    }
    this._end();
  }

  private _end(): void {
    this._meshId = null; this._em = null; this._before = null; this._seg = null; this._normals = null;
    this._start = new Float64Array(0); this._weights = new Float32Array(0);
    this._affected = new Int32Array(0); this._selected = new Int32Array(0);
    this._numeric = ''; this._axis = null;
    this.host.scheduleRender();
    this._changed();
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  /** Recompute the transform from the pointer / typed amount and write the vertices. */
  private _evaluate(): void {
    if (!this.active) return;
    const mesh = this.host.getMesh(this._meshId!);
    const em = mesh?.editMesh;
    if (!mesh || !em || em !== this._em) { this._end(); return; }   // the topology changed (undo / an op): drop it
    const cam = this.host.getCamera();
    const ax = this.shortcutAxis;
    const typed = ax && this._numeric !== '' && this._numeric !== '-' && this._numeric !== '.' ? parseFloat(this._numeric) : NaN;
    const snap = this._ctrl || !!this.host.isSnapLatched?.();
    vec3.zero(this._delta); this._angle = 0; this._factor = 1;
    let rotAxis: vec3 | null = null;
    let scaleAxis: vec3 | null = null;

    if (Number.isFinite(typed) && ax) {
      const a = this._basis[AXES.indexOf(ax)];
      if (this._mode === 'grab') vec3.scale(this._delta, a, typed);
      else if (this._mode === 'rotate') { this._angle = typed * (Math.PI / 180); rotAxis = a; }
      else { this._factor = typed; scaleAxis = a; }
    } else if (this._mode === 'grab') {
      vec3.copy(this._delta, this._constrain(this._accMove));
      if (cam && this._seg) vec3.add(this._delta, this._delta, this._segMove(cam, this._seg));
      if (snap) this._snapMove(this._delta);
    } else if (this._mode === 'rotate') {
      let screen = this._accAngle;
      if (cam && this._seg) screen += this._segAngle(cam, this._seg);
      rotAxis = ax ? this._basis[AXES.indexOf(ax)] : cam ? this._toCam(cam) : V3(0, 0, 1);
      this._angle = this._source === 'gizmo' ? screen : this._signedAngle(cam, rotAxis, screen);
      if (snap && this.snapAngle > 0) this._angle = Math.round(this._angle / this.snapAngle) * this.snapAngle;
    } else {
      let f = this._accRatio;
      if (cam && this._seg) f *= this._segRatio(cam, this._seg);
      if (snap && this.snapScale > 0) f = Math.max(this.snapScale, Math.round(f / this.snapScale) * this.snapScale);
      this._factor = f;
      scaleAxis = ax ? this._basis[AXES.indexOf(ax)] : null;
    }
    this._apply(mesh, em, rotAxis, scaleAxis);
  }

  /** Write the vertices for the current delta / angle / factor (from the start positions — no drift). */
  private _apply(mesh: Mesh3D, em: EditMesh, rotAxis: vec3 | null, scaleAxis: vec3 | null): void {
    const V = em.vertices, S = this._start, W = this._weights, aff = this._affected;
    const identity = this._mode === 'grab' ? (this._delta[0] === 0 && this._delta[1] === 0 && this._delta[2] === 0)
      : this._mode === 'rotate' ? this._angle === 0 || !rotAxis
      : this._factor === 1;
    if (identity) {
      if (!this._touched) return;
      this._restoreStart(em);
    } else {
      if (!this._normalsCleared) { em.clearCustomNormalsAround(aff); this._normalsCleared = true; }
      this._touched = true;
      if (this._mode === 'grab') {
        const d = vec3.transformMat3(V3(), this._delta, this._Minv3);   // world move → object move
        for (const i of aff) {
          const w = W[i], o = i * 3;
          V[i].x = S[o] + d[0] * w; V[i].y = S[o + 1] + d[1] * w; V[i].z = S[o + 2] + d[2] * w;
        }
      } else {
        const L1 = this._objectLinear(1, rotAxis, scaleAxis);
        const P = this._pivotObj;
        const Lw = M3();
        for (const i of aff) {
          const w = W[i], o = i * 3;
          const L = w === 1 ? L1 : this._objectLinear(w, rotAxis, scaleAxis, Lw);
          const x = S[o] - P[0], y = S[o + 1] - P[1], z = S[o + 2] - P[2];
          V[i].x = P[0] + L[0] * x + L[3] * y + L[6] * z;
          V[i].y = P[1] + L[1] * x + L[4] * y + L[7] * z;
          V[i].z = P[2] + L[2] * x + L[5] * y + L[8] * z;
        }
      }
    }
    this.host.syncGeometry(mesh);
    this.host.scheduleRender();
  }

  /** The object-space linear map of the world rotation / scale at weight w: M⁻¹ · A(w) · M (3x3). */
  private _objectLinear(w: number, rotAxis: vec3 | null, scaleAxis: vec3 | null, out = M3()): mat3 {
    const A = M3();
    if (this._mode === 'rotate') {
      const q = quat.setAxisAngle(Q(), rotAxis!, this._angle * w);
      mat3.fromQuat(A, q);
    } else {
      const s = 1 + (this._factor - 1) * w;
      if (!scaleAxis) { A[0] = s; A[4] = s; A[8] = s; }
      else {
        const a = scaleAxis, k = s - 1;
        // I + (s − 1) a aᵀ (column-major; symmetric)
        A[0] = 1 + k * a[0] * a[0]; A[1] = k * a[0] * a[1]; A[2] = k * a[0] * a[2];
        A[3] = k * a[1] * a[0]; A[4] = 1 + k * a[1] * a[1]; A[5] = k * a[1] * a[2];
        A[6] = k * a[2] * a[0]; A[7] = k * a[2] * a[1]; A[8] = 1 + k * a[2] * a[2];
      }
    }
    mat3.multiply(out, A, this._M3);
    return mat3.multiply(out, this._Minv3, out);
  }

  private _restoreStart(em: EditMesh): void {
    const V = em.vertices, S = this._start;
    for (const i of this._affected) { const o = i * 3; V[i].x = S[o]; V[i].y = S[o + 1]; V[i].z = S[o + 2]; }
  }

  private _anyMoved(em: EditMesh): boolean {
    const V = em.vertices, S = this._start;
    for (const i of this._affected) { const o = i * 3; if (V[i].x !== S[o] || V[i].y !== S[o + 1] || V[i].z !== S[o + 2]) return true; }
    return false;
  }

  // ── Pointer → amounts ─────────────────────────────────────────────────────

  /** World move of one drag: the pointer on the constraint plane through the pivot (the grabbed point stays under it). */
  private _segMove(cam: Camera3D, s: { rx: number; ry: number; cx: number; cy: number }): vec3 {
    const out = V3();
    if (s.rx === s.cx && s.ry === s.cy) return out;
    const toCam = this._toCam(cam);
    const ax = this._axis;
    let n: vec3;
    let along: vec3 | null = null;
    if (ax === 'xy' || ax === 'xz' || ax === 'yz') {
      n = V3c(this._basis[ax === 'xy' ? 2 : ax === 'xz' ? 1 : 0]);
    } else if (ax === 'x' || ax === 'y' || ax === 'z') {
      along = this._basis[AXES.indexOf(ax)];
      n = vec3.cross(V3(), along, vec3.cross(V3(), along, toCam));
      if (vec3.length(n) < 1e-6) n = V3c(this._basis[(AXES.indexOf(ax) + 1) % 3]);
      vec3.normalize(n, n);
    } else {
      n = toCam;
    }
    const inv = mat4.invert(M4(), cam.getViewProjectionMatrix() as unknown as mat4);
    if (!inv) return out;
    const p0 = this._rayPlane(inv, s.rx, s.ry, n), p1 = this._rayPlane(inv, s.cx, s.cy, n);
    if (!p0 || !p1) return out;
    vec3.subtract(out, p1, p0);
    if (along) vec3.scale(out, along, vec3.dot(out, along));
    return out;
  }

  /** Screen angle (radians, y-down screen space) the pointer swept around the pivot in one drag. Gizmo drags use the
   *  object gizmo's rule (the ring facing the camera: the swept angle; edge-on: the drag distance). */
  private _segAngle(cam: Camera3D, s: { rx: number; ry: number; cx: number; cy: number }): number {
    const c = this._project(cam, this._pivotW);
    if (this._source === 'gizmo') {
      const ax = this.shortcutAxis ?? 'z';
      const a = this._basis[AXES.indexOf(ax)];
      const faceDot = vec3.dot(a, this._toCam(cam));
      if (Math.abs(faceDot) > 0.5 && c) return -Math.sign(faceDot) * wrapAngle(Math.atan2(s.cy - c[1], s.cx - c[0]) - Math.atan2(s.ry - c[1], s.rx - c[0]));
      return ((s.cx - s.rx) + (s.cy - s.ry)) / 300 * Math.PI * 2;
    }
    if (!c) return 0;
    return wrapAngle(Math.atan2(s.cy - c[1], s.cx - c[0]) - Math.atan2(s.ry - c[1], s.rx - c[0]));
  }

  /** Modal rotate: the screen sweep → a right-handed angle about `axis` (the selection turns with the pointer). */
  private _signedAngle(cam: Camera3D | null, axis: vec3, screen: number): number {
    const facing = cam ? vec3.dot(axis, this._toCam(cam)) : 1;
    return -(facing >= 0 ? 1 : -1) * screen;
  }

  /** Scale factor of one drag. Modal: the pointer's screen distance from the pivot over the start's; gizmo: the object
   *  gizmo's rule (1 + the drag along the handle's screen direction / 200 px). */
  private _segRatio(cam: Camera3D, s: { rx: number; ry: number; cx: number; cy: number }): number {
    const c = this._project(cam, this._pivotW);
    if (!c) return 1;
    if (this._source === 'gizmo') {
      const dx = s.cx - s.rx, dy = s.cy - s.ry;
      let eff = dx;
      const ax = this.shortcutAxis;
      if (ax) {
        const tip = vec3.scaleAndAdd(V3(), this._pivotW, this._basis[AXES.indexOf(ax)], this._gizmoScale(cam));
        const t = this._project(cam, tip);
        if (t) {
          const sx = t[0] - c[0], sy = t[1] - c[1], len = Math.hypot(sx, sy);
          if (len > 1) eff = (dx * sx + dy * sy) / len;
        }
      }
      return Math.max(0.01, 1 + eff / 200);
    }
    const r0 = Math.hypot(s.rx - c[0], s.ry - c[1]), r1 = Math.hypot(s.cx - c[0], s.cy - c[1]);
    if (r0 < MeshElementTransform.SCALE_MIN_REF_PX) return Math.max(0.01, 1 + (r1 - r0) / 100);
    return r1 / r0;
  }

  /** The unconstrained part of a move with the current constraint applied (an axis: its component; a plane: in it). */
  private _constrain(v: vec3): vec3 {
    const ax = this._axis;
    if (ax === 'x' || ax === 'y' || ax === 'z') {
      const a = this._basis[AXES.indexOf(ax)];
      return vec3.scale(V3(), a, vec3.dot(v, a));
    }
    if (ax === 'xy' || ax === 'xz' || ax === 'yz') {
      const n = this._basis[ax === 'xy' ? 2 : ax === 'xz' ? 1 : 0];
      return vec3.scaleAndAdd(V3(), v, n, -vec3.dot(v, n));
    }
    return V3c(v);
  }

  /** Snap a move: each component along the orientation's axes to {@link snapMove}. */
  private _snapMove(d: vec3): void {
    if (!(this.snapMove > 0)) return;
    const out = V3();
    for (const b of this._basis) {
      const t = Math.round(vec3.dot(d, b) / this.snapMove) * this.snapMove;
      vec3.scaleAndAdd(out, out, b, t);
    }
    vec3.copy(d, out);
  }

  /** Unit vector from the pivot toward the camera (orthographic: the view direction). */
  private _toCam(cam: Camera3D): vec3 {
    const from = cam.mode === 'orthographic' ? cam.target : this._pivotW;
    const v = vec3.subtract(V3(), cam.position, from);
    if (vec3.length(v) < 1e-12) return V3(0, 0, 1);
    return vec3.normalize(v, v);
  }

  private _gizmoScale(cam: Camera3D): number {
    return GizmoRenderer.computeGizmoScale(cam, this._pivotW);
  }

  private _project(cam: Camera3D, p: ArrayLike<number>): [number, number] | null {
    const m = cam.getViewProjectionMatrix() as unknown as Float32Array;
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cw <= 1e-9) return null;
    return [
      ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / cw + 1) * 0.5 * this._w,
      (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / cw) * 0.5 * this._h,
    ];
  }

  /** The screen point's ray against the plane through the pivot with normal n (null = parallel / behind). */
  private _rayPlane(invVP: mat4, x: number, y: number, n: vec3): vec3 | null {
    const nx = (2 * x) / this._w - 1, ny = 1 - (2 * y) / this._h;
    const unproject = (z: number): vec3 => {
      const m = invVP;
      const X = m[0] * nx + m[4] * ny + m[8] * z + m[12];
      const Y = m[1] * nx + m[5] * ny + m[9] * z + m[13];
      const Z = m[2] * nx + m[6] * ny + m[10] * z + m[14];
      const Wc = m[3] * nx + m[7] * ny + m[11] * z + m[15];
      return V3(X / Wc, Y / Wc, Z / Wc);
    };
    const o = unproject(0), f = unproject(1);
    const dir = vec3.normalize(V3(), vec3.subtract(V3(), f, o));
    const denom = vec3.dot(n, dir);
    if (Math.abs(denom) < 1e-9) return null;
    const t = vec3.dot(n, vec3.subtract(V3(), this._pivotW, o)) / denom;
    if (!Number.isFinite(t)) return null;
    return vec3.scaleAndAdd(V3(), o, dir, t);
  }

  private _changed(): void { try { this.host.onChange?.(); } catch { /* host callback */ } }
}

/** The gizmo handle → the transform it drives (move → grab). */
export function gizmoModeToTransform(mode: GizmoMode): ElementTransformMode | null {
  return mode === 'move' ? 'grab' : mode === 'rotate' ? 'rotate' : mode === 'scale' ? 'scale' : null;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * What scene3d's G / R / S family (sm.beginTransform3D …) is routed through while a mesh is in Edit Mesh: the element
 * transforms instead of the object's. Implemented by the MeshEditPointerController.
 */
export interface ElementTransformRouter {
  /** A mesh is in Edit Mesh: G / R / S belong to its elements. */
  handles(): boolean;
  /** A session (modal or gizmo drag) runs. */
  isActive(): boolean;
  /** A MODAL session runs (the keyboard / pill transform — the HUD's "shortcut"). */
  isModal(): boolean;
  mode(): ElementTransformMode | null;
  axis(): Axis1 | null;
  numeric(): string;
  begin(mode: ElementTransformMode): void;
  constrainAxis(axis: Axis1): void;
  appendNumeric(char: string): void;
  commit(): void;
  cancel(): void;
  /** The scene's gizmo mode changed while in Edit Mesh: the selection gizmo follows it. */
  setGizmoMode(mode: GizmoMode): void;
  /** A gizmo rotate drag's angle readout (as getDragInfo), null when none. */
  dragInfo(): { isDragging: boolean; mode: GizmoMode; axis: GizmoAxis; angleDeg: number | null; gizmoCenterWorld: [number, number, number] | null } | null;
}

// Float64 storage for every vector / matrix of the tool (gl-matrix's default Float32Array would round the typed
// amounts and the object ↔ world maps to ~1e-7).
function V3(x = 0, y = 0, z = 0): vec3 { return Float64Array.of(x, y, z) as unknown as vec3; }
function V3c(v: ArrayLike<number>): vec3 { return V3(v[0], v[1], v[2]); }
function M3(): mat3 { const m = new Float64Array(9); m[0] = m[4] = m[8] = 1; return m as unknown as mat3; }
function M4(): mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m as unknown as mat4; }
function Q(): quat { const q = new Float64Array(4); q[3] = 1; return q as unknown as quat; }
