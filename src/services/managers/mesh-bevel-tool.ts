/**
 * MeshBevelTool — the interactive Chamfer / Bevel of Edit Mesh (docs/specs/edit-mesh-topology.md §8,
 * docs/ui/touch-controls.md "Chamfer pill").
 *
 * Two entry orders:
 *  (a) vertices / edges selected, then Chamfer → the tool starts on the selection (vertex mode = vertex chamfer, edge
 *      mode = edge bevel);
 *  (b) Chamfer with nothing selected → PICK phase ("Tap a corner or edge to chamfer"): the next tap / click on a
 *      vertex or edge starts it.
 * Then the ADJUST phase: a drag sets the amount — it does not have to follow the guide (fingers): the pointer movement
 * since the press, projected onto the guide's screen direction (or, when the guide points at the camera, the change
 * of the distance from the target on screen), converted to object units. The amount is a distance along the edges,
 * clamped (EditMesh.bevelLimit), optionally snapped to `snapStep` (the Snap toggle, or Ctrl held while dragging).
 * Segments (1 = flat, > 1 = rounded) come from the pill's − / +, the mouse wheel or + / −.
 *
 * Preview: every change rebuilds the bevel on a COPY of the mesh as it was when the tool started; the original
 * EditMesh object is kept untouched, so Cancel puts it back exactly (same object, same compile). Apply pushes ONE
 * undo step (before / after snapshots).
 *
 * The pointer controller owns the canvas events and calls pick / dragStart / dragMove / dragEnd; the guides (a dashed
 * line along each target's inward bisector) are drawn by the edit overlay from {@link guideLines}.
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { EditMesh, type BevelSpec, type BevelGuide } from '../../scene-graph/shapes/edit-mesh';
import type { MeshEditManager } from './mesh-edit-manager';
import type { Command3D } from './undo-manager-3d';

export type BevelKind = 'vertex' | 'edge';

/** The tool as the host shows it (HUD readout, touch pill, panel). */
export interface BevelToolState {
  phase: 'pick' | 'adjust';
  /** What is being beveled (null in the pick phase). */
  kind: BevelKind | null;
  /** The amount (object units, distance along the edges). */
  amount: number;
  /** The clamp limit for the current targets (0 in the pick phase). */
  maxAmount: number;
  segments: number;
  snap: boolean;
  snapStep: number;
  /** Number of vertices / edges being beveled. */
  targets: number;
  /** What the tool waits for, for a hint line. */
  hint: string;
  /** A drag is setting the amount right now. */
  dragging: boolean;
}

export interface BevelToolHost {
  getMesh(meshId: string): Mesh3D | null;
  meshEdit: MeshEditManager;
  pushCmd(cmd: Command3D): void;
  scheduleRender(): void;
  /** The state changed (the host's panel / HUD / pill re-read it). */
  onChange?(): void;
  /** The tool is about to start (the host ends an element transform first). */
  onBegin?(): void;
}

/** Object-space point → canvas px (null = behind the camera). */
export type ObjProjector = (ox: number, oy: number, oz: number) => { x: number; y: number } | null;

export const BEVEL_PICK_HINT = 'Tap a corner or edge to chamfer';
export const BEVEL_MAX_SEGMENTS = 32;

export class MeshBevelTool {
  private _meshId: string | null = null;
  private _phase: 'pick' | 'adjust' = 'pick';
  private _kind: BevelKind | null = null;
  private _vertices: number[] = [];
  private _edges: Array<[number, number]> = [];
  private _amount = 0;
  private _limit = 0;
  private _segments = 1;
  private _snap = false;
  snapStep = 0.05;
  /** The mesh's EditMesh when the tool started (untouched: Cancel restores this object). */
  private _orig: EditMesh | null = null;
  private _before: object | null = null;
  private _selSnap: ReturnType<MeshEditManager['snapshotSelection']> = null;
  private _guides: BevelGuide[] = [];
  // drag mapping
  private _drag: { sx: number; sy: number; startAmount: number; mode: 'axis' | 'radial'; dx: number; dy: number;
    ox: number; oy: number; pxPerUnit: number; r0: number; along: number } | null = null;

  constructor(private readonly host: BevelToolHost) {}

  get active(): boolean { return this._meshId !== null; }
  get meshId(): string | null { return this._meshId; }
  get phase(): 'pick' | 'adjust' { return this._phase; }
  get dragging(): boolean { return this._drag !== null; }

  state(): BevelToolState | null {
    if (!this.active) return null;
    const n = this._kind === 'vertex' ? this._vertices.length : this._kind === 'edge' ? this._edges.length : 0;
    return {
      phase: this._phase, kind: this._kind, amount: this._amount, maxAmount: this._limit, segments: this._segments,
      snap: this._snap, snapStep: this.snapStep, targets: n, dragging: this._drag !== null,
      hint: this._phase === 'pick' ? BEVEL_PICK_HINT : 'Drag to set the amount',
    };
  }

  /**
   * Start the tool on `meshId` (in Edit Mesh). With vertices (vertex mode) / edges (edge mode) selected it starts on
   * them (adjust phase, amount 0); otherwise it waits for a pick. `kind` forces which selection to use. Returns false
   * when the mesh is not editable.
   */
  begin(meshId: string, opts: { segments?: number; kind?: BevelKind; snap?: boolean } = {}): boolean {
    if (this.active) this.cancel();
    try { this.host.onBegin?.(); } catch { /* host callback */ }
    const mesh = this.host.getMesh(meshId);
    if (!mesh?.editMesh) return false;
    this._meshId = meshId;
    this._orig = mesh.editMesh;
    this._before = mesh.editMesh.toJSON();
    this._segments = clampSegments(opts.segments ?? this._segments);
    this._snap = opts.snap ?? this._snap;
    this._amount = 0;
    this._selSnap = this.host.meshEdit.snapshotSelection(meshId);
    const sel = this.host.meshEdit.getSelection(meshId);
    const em = this._orig;
    const edges: Array<[number, number]> = [];
    for (const h of sel?.edges ?? []) { const e = em.getHalfEdgeVertices(h); if (e && em.halfEdges[h].twin >= 0) edges.push(e); }
    const verts = [...(sel?.vertices ?? [])].filter(v => v >= 0 && v < em.vertices.length);
    const kind = opts.kind ?? (edges.length && !verts.length ? 'edge' : verts.length ? 'vertex' : edges.length ? 'edge' : null);
    this._phase = 'pick';
    this._kind = null;
    if (kind === 'vertex' && verts.length) this._setTargets('vertex', verts, []);
    else if (kind === 'edge' && edges.length) this._setTargets('edge', [], edges);
    // the selection's indices stop meaning anything once the preview re-cuts the mesh (Cancel restores it)
    this.host.meshEdit.restoreSelection(meshId, null);
    this._changed();
    return true;
  }

  /** Pick phase: start on this vertex / edge (a tap / click on it). */
  pick(target: { vertex: number } | { edge: [number, number] }): boolean {
    if (!this.active || !this._orig) return false;
    if ('vertex' in target) this._setTargets('vertex', [target.vertex], []);
    else this._setTargets('edge', [], [target.edge]);
    this._changed();
    return this._phase === 'adjust';
  }

  private _setTargets(kind: BevelKind, vertices: number[], edges: Array<[number, number]>): void {
    const em = this._orig!;
    const spec = kind === 'vertex' ? { vertices } : { edges };
    const limit = em.bevelLimit(spec);
    if (!(limit > 0)) return;   // nothing bevelable there (an isolated / boundary edge): stay in pick
    this._kind = kind; this._vertices = vertices; this._edges = edges;
    this._limit = limit;
    this._guides = em.bevelGuides(spec);
    this._phase = 'adjust';
    this._amount = Math.min(this._amount, limit);
    this._preview();
  }

  /** Set the amount (object units; clamped to the limit; snapped when Snap is on). */
  setAmount(amount: number): void {
    if (!this.active || this._phase !== 'adjust' || !Number.isFinite(amount)) return;
    this._amount = this._quantise(amount, this._snap);
    this._preview();
    this._changed();
  }

  setSegments(segments: number): void {
    if (!this.active) return;
    const s = clampSegments(segments);
    if (s === this._segments) return;
    this._segments = s;
    if (this._phase === 'adjust') this._preview();
    this._changed();
  }

  setSnap(on: boolean, step?: number): void {
    if (!this.active) return;
    this._snap = on;
    if (step !== undefined && step > 0) this.snapStep = step;
    if (this._phase === 'adjust' && on) { this._amount = this._quantise(this._amount, true); this._preview(); }
    this._changed();
  }

  // ── Drag (the pointer controller's canvas px) ─────────────────────────────

  /** A press in the adjust phase: the drag maps the pointer movement from here onto the first target's guide. */
  dragStart(px: number, py: number, project: ObjProjector): boolean {
    if (!this.active || this._phase !== 'adjust' || this._guides.length === 0) return false;
    const g = this._guides[0];
    const [ox, oy, oz] = g.origin, [dx, dy, dz] = g.dir;
    const ref = Math.max(this._limit, 1e-3);
    const s0 = project(ox, oy, oz);
    if (!s0) return false;
    const x0 = s0.x, y0 = s0.y;   // (copied first: the projector may reuse its result object)
    const s1 = project(ox + dx * ref, oy + dy * ref, oz + dz * ref);
    if (!s1) return false;
    const ax = s1.x - x0, ay = s1.y - y0, axLen = Math.hypot(ax, ay);
    // the on-screen length of one object unit across the view, for the radial fallback
    let radial = axLen / ref;
    for (const [qx, qy, qz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const s2 = project(ox + qx * ref, oy + qy * ref, oz + qz * ref);
      if (s2) radial = Math.max(radial, Math.hypot(s2.x - x0, s2.y - y0) / ref);
    }
    const axis = axLen / ref >= 0.3 * radial && axLen > 1e-6;
    this._drag = {
      sx: px, sy: py, startAmount: this._amount, mode: axis ? 'axis' : 'radial',
      dx: axis ? ax / axLen : 0, dy: axis ? ay / axLen : 0, ox: x0, oy: y0,
      pxPerUnit: axis ? axLen / ref : Math.max(radial, 1e-6), r0: Math.hypot(px - x0, py - y0), along: g.along,
    };
    this._changed();
    return true;
  }

  /** The drag moved: amount = start + the movement along the guide (object units) / how far the cut moves per unit. */
  dragMove(px: number, py: number, ctrl = false): void {
    const d = this._drag;
    if (!d) return;
    const moved = d.mode === 'axis'
      ? ((px - d.sx) * d.dx + (py - d.sy) * d.dy) / d.pxPerUnit
      : (Math.hypot(px - d.ox, py - d.oy) - d.r0) / d.pxPerUnit;
    this._amount = this._quantise(d.startAmount + moved / d.along, this._snap !== ctrl);
    this._preview();
    this._changed();
  }

  dragEnd(): void {
    if (!this._drag) return;
    this._drag = null;
    this._changed();
  }

  /** A second finger / pointercancel: the drag is dropped and the amount goes back to where it started. */
  dragAbort(): void {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    this._amount = d.startAmount;
    this._preview();
    this._changed();
  }

  // ── Apply / Cancel ────────────────────────────────────────────────────────

  /** Apply: ONE undo step. An amount of 0 (or the pick phase) is a cancel. Returns whether the mesh changed. */
  commit(): boolean {
    if (!this.active) return false;
    const mesh = this.host.getMesh(this._meshId!);
    if (this._phase !== 'adjust' || !(this._amount > 0) || !mesh?.editMesh || mesh.editMesh === this._orig) { this.cancel(); return false; }
    const before = this._before!, after = mesh.editMesh.toJSON();
    const meshId = this._meshId!;
    this.host.pushCmd({
      description: this._kind === 'vertex' ? 'Chamfer vertex' : 'Bevel edge',
      undo: () => { mesh.editMesh = EditMesh.fromJSON(before); mesh.syncFromEditMesh(); },
      redo: () => { mesh.editMesh = EditMesh.fromJSON(after); mesh.syncFromEditMesh(); },
    });
    this.host.meshEdit.restoreSelection(meshId, null);
    this._end();
    return true;
  }

  /** Cancel: the mesh exactly as it was (the same EditMesh object), the selection back. */
  cancel(): void {
    if (!this.active) return;
    const mesh = this.host.getMesh(this._meshId!);
    if (mesh && this._orig && mesh.editMesh !== this._orig) { mesh.editMesh = this._orig; mesh.syncFromEditMesh(); }
    this.host.meshEdit.restoreSelection(this._meshId!, this._selSnap);
    this._end();
  }

  private _end(): void {
    this._meshId = null; this._orig = null; this._before = null; this._selSnap = null;
    this._phase = 'pick'; this._kind = null; this._vertices = []; this._edges = []; this._guides = [];
    this._amount = 0; this._limit = 0; this._drag = null;
    this.host.scheduleRender();
    this._changed();
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  /**
   * World-space dashed guide lines (xyz pairs, a line list): through each target along its inward bisector, a little
   * outside the mesh to past the clamp limit. Null when there is nothing to draw.
   */
  guideLines(): Float32Array | null {
    if (!this.active || this._phase !== 'adjust' || this._guides.length === 0) return null;
    const mesh = this.host.getMesh(this._meshId!);
    if (!mesh) return null;
    const m = mesh.localMatrix as unknown as ArrayLike<number>;
    const DASHES = 14;
    const out = new Float32Array(this._guides.length * DASHES * 6);
    let o = 0;
    for (const g of this._guides) {
      const len = Math.max(this._limit * g.along * 1.25, 1e-3), back = len * 0.2;
      for (let i = 0; i < DASHES; i++) {
        const t0 = -back + ((len + back) * (2 * i)) / (2 * DASHES), t1 = -back + ((len + back) * (2 * i + 1)) / (2 * DASHES);
        for (const t of [t0, t1]) {
          const x = g.origin[0] + g.dir[0] * t, y = g.origin[1] + g.dir[1] * t, z = g.origin[2] + g.dir[2] * t;
          out[o++] = m[0] * x + m[4] * y + m[8] * z + m[12];
          out[o++] = m[1] * x + m[5] * y + m[9] * z + m[13];
          out[o++] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
      }
    }
    return out;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _quantise(a: number, snap: boolean): number {
    let v = Math.max(0, Math.min(this._limit, a));
    if (snap && this.snapStep > 0) v = Math.min(this._limit, Math.round(v / this.snapStep) * this.snapStep);
    return v;
  }

  private _spec(): BevelSpec {
    return this._kind === 'vertex'
      ? { vertices: this._vertices, amount: this._amount, segments: this._segments }
      : { edges: this._edges, amount: this._amount, segments: this._segments };
  }

  /** Show the bevel at the current settings on a copy of the original (the original stays untouched). */
  private _preview(): void {
    const mesh = this._meshId ? this.host.getMesh(this._meshId) : null;
    if (!mesh || !this._orig || !this._before) return;
    if (this._phase !== 'adjust' || !(this._amount > 0)) {
      if (mesh.editMesh !== this._orig) { mesh.editMesh = this._orig; mesh.syncFromEditMesh(); }
    } else {
      const em = EditMesh.fromJSON(this._before);
      if (em.bevel(this._spec())) { mesh.editMesh = em; mesh.syncFromEditMesh(); }
    }
    this.host.scheduleRender();
  }

  private _changed(): void { try { this.host.onChange?.(); } catch { /* host callback */ } }
}

function clampSegments(n: number): number {
  return Math.max(1, Math.min(BEVEL_MAX_SEGMENTS, Math.round(Number.isFinite(n) ? n : 1)));
}
