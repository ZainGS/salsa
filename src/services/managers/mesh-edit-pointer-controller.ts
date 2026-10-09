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
import { EditMesh, MirrorModifier, type KnifePoint, type MirrorPlane } from '../../scene-graph/shapes/edit-mesh';
import { forEachPointImage, forEachSegmentImage, forEachPolygonImage, toRealSide, imageAffine } from '../../scene-graph/shapes/edit-mesh-mirror';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { claimPointerEvent, isPointerEventClaimed } from '../../renderer/util/pointer-claims';
import { EditFacePicker, pickFaceFullScene, type FacePickMirror } from './mesh-edit-face-pick';
import { MeshBevelTool } from './mesh-bevel-tool';
import { MeshElementTransform, gizmoModeToTransform, type ElementTransformMode, type ElementTransformRouter } from './mesh-element-transform';
import { GizmoRenderer, hitTestGizmoAt, type GizmoAxis, type GizmoMode } from '../../renderer/3d/gizmo-renderer';
import type { MeshEditGizmoDraw } from '../../renderer/3d/mesh-edit-overlay-renderer';

export type MeshEditSelectionMode = 'vertex' | 'face' | 'edge';

/** The Edit Mesh tool strip (UI review 2026-10-07 §4): one active tool. select = taps select, no gizmo; move / rotate /
 *  scale = the selection gizmo in that mode; loopcut = tap / hover an edge to preview, tap / click to cut; knife = taps
 *  on the surface add cut points (applyMeshEditKnife3D cuts); extrude / inset / bevel = the host runs the op (selection
 *  works as in select). */
export type MeshEditTool = 'select' | 'move' | 'rotate' | 'scale' | 'extrude' | 'inset' | 'loopcut' | 'knife' | 'bevel';
export const MESH_EDIT_TOOLS: readonly MeshEditTool[] = ['select', 'move', 'rotate', 'scale', 'extrude', 'inset', 'loopcut', 'knife', 'bevel'];

/** What {@link MeshEditPointerController.pickElementAt} found under a point. */
export interface MeshEditElementHit { kind: MeshEditSelectionMode; index: number; selected: boolean }

/** A knife tap within this many canvas px (× the touch scale) of a vertex / edge of the hit face snaps onto it. */
const KNIFE_SNAP_PX = 12;
/** A MOUSE press on the selection that moved further than this (CSS px) is a drag (it moves the selection). */
const MOUSE_DRAG_SLOP_PX = 4;

/** Radius (canvas device pixels) within which a vertex/edge midpoint counts as "hit". */
const VERTEX_PICK_RADIUS_PX = 14;
const EDGE_PICK_RADIUS_PX   = 10;
/** TOUCH-8: vertex / edge pick radius multiplier under a finger. */
const TOUCH_PICK_SCALE = 2;

/** Optional host hooks (all have safe defaults). */
export interface MeshEditPointerOptions {
  /** The additive-select latch (sm.setAdditiveSelect3D): a press adds to the selection like Shift. */
  isAdditive?: () => boolean;
  /** The snap latch (sm.setSnapToggle3D): element transforms snap like Ctrl is held. */
  isSnapLatched?: () => boolean;
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
  /** A drag frame ran (moveVertex) since the vertex drag began — even a zero-delta one recomputes custom normals. */
  private _dragApplied = false;
  /** The mesh had custom split normals at the drag start (a move clears them around it; a cancel restores the snapshot). */
  private _dragHadCustomNormals = false;
  /** All vertex positions at drag start — lets the drag re-apply as an absolute move from the
   *  start each frame (no float drift) while routing through moveVertex for proportional falloff. */
  private _dragStartVerts: { x: number; y: number; z: number }[] | null = null;
  /** The vertex drag started on a mirror's COPY side: that image's affine map (real → image, imageAffine) — the drag
   *  moves the real vertex so its image follows the pointer. Null = the real vertex. */
  private _dragImage: Float64Array | null = null;
  /** The selection before a FINGER drag selected its vertex (a cancel puts it back); undefined = not taken. */
  private _dragSelSnap: SelSnap | undefined = undefined;
  /** The canvas rect, read once per press / drag instead of per pointer move. */
  private _rect: Rect | null = null;
  /** Latest drag position (canvas px), applied once per frame (see _syncDragGeometry). */
  private _dragAt: { x: number; y: number } | null = null;
  /** 7.3d: this drag patched the compiled geometry in place since its last full recompile (release recompiles). */
  private _dragPatched = false;
  /** 7.3d perf counters: full recompiles (syncFromEditMesh) vs in-place patches during vertex drags, and what the
   *  patches re-sent (vertex spans / vertices / bytes at the 48-byte pool stride; gpuDirty = a patch the renderer
   *  could not take, so the pool re-uploads the mesh). */
  readonly dragStats = { fullSyncs: 0, patches: 0, spans: 0, indexSpans: 0, uploadVerts: 0, uploadBytes: 0, gpuDirty: 0 };
  /** 7.3d: face picks against the edit mesh only (own BVH + face-centre grid). */
  private readonly _facePicker = new EditFacePicker();
  /** The face picker's counters (tests / perf report). */
  get facePickStats(): EditFacePicker['stats'] { return this._facePicker.stats; }
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
  /** A finger / PEN press waiting to become a tap (on release) or a drag (on movement). `drag` = the press was on the
   *  selection (it moves it) or, with drag-moves-selection off, on a vertex in vertex mode (the old single-vertex drag):
   *  the press is claimed. Otherwise a drag is the camera's (the orbit controller orbits it — round-3 feedback). */
  private _pending: { id: number; clientX: number; clientY: number; additive: boolean; drag: 'selection' | 'vertex' | null; img: number; pen: boolean } | null = null;

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
    this.bevel = new MeshBevelTool({
      getMesh: (id) => this._scene3d.getMesh(id),
      meshEdit,
      pushCmd,
      scheduleRender,
      onChange: () => { this._syncBevelWheel(); this._onSelectionChange?.(); },
      onBegin: () => { if (this.transform?.active) this._endElementTransform(false); },
    });
    this.transform = new MeshElementTransform({
      getMesh: (id) => this._scene3d.getMesh(id),
      getCamera: () => this._scene3d.getCamera?.() ?? null,
      meshEdit,
      pushCmd,
      scheduleRender,
      getOrientation: () => this._scene3d.getGizmoOrientation?.() ?? 'world',
      isSnapLatched: () => { try { return !!this._opts.isSnapLatched?.(); } catch { return false; } },
      syncGeometry: (mesh) => this._syncDragGeometry(mesh),
      finishGeometry: (mesh) => {
        if (!this._dragPatched) return;
        this._dragPatched = false;
        mesh.syncFromEditMesh();
        this.dragStats.fullSyncs++;
      },
      recompile: (mesh) => { this._dragPatched = false; mesh.syncFromEditMesh(); this.dragStats.fullSyncs++; },
      onChange: () => this._onSelectionChange?.(),
    });
  }

  /** The interactive Chamfer / Bevel (mesh-bevel-tool.ts). While it is active this controller routes the canvas
   *  pointer to it: the pick phase picks a vertex / edge, the adjust phase turns a drag into the amount. */
  readonly bevel: MeshBevelTool;

  /** Edit Mesh element transforms (mesh-element-transform.ts, docs/specs/edit-mesh-topology.md §11): G / R / S on the
   *  selected vertices / edges / faces (mouse-follow; finger / pen drags) and the gizmo on the selection's centroid.
   *  While a session runs this controller routes the canvas pointer to it. */
  readonly transform: MeshElementTransform;

  /** The selection gizmo's mode in Edit Mesh (null = no gizmo). Follows the scene's gizmo mode while in Edit Mesh
   *  (ElementTransformRouter.setGizmoMode); 'move' by default so the gizmo is there on entering. */
  gizmoMode: GizmoMode = 'move';

  /** UI review §4 (tablet-first): a one-finger / mouse drag that STARTS on an already-selected vertex / edge / face
   *  moves the whole selection on the view plane (an element grab, source 'drag': live, one undo step on release, a
   *  2nd finger / right click / Esc / pointercancel cancels). A drag that starts elsewhere keeps the old behaviour. */
  dragMovesSelection = true;
  /** Drag Lock (host toggle, setMeshEditDragLock3D): NO press-drag moves geometry — neither the selection nor, in
   *  vertex mode, the single vertex under the pointer. A press then only selects (on press for the mouse, on release
   *  for a finger / pen), a finger / pen drag stays the camera's. The gizmo / mirror-plane handles still work. */
  dragLock = false;
  /** LIVE OP PREVIEW (setMeshEditOpPreview3D): the host shows the last face op (extrude / inset / subdivide) as a
   *  preview. A face-mode tap then RE-TARGETS it: the preview is reverted first so the tap is resolved against the mesh
   *  before the op, the selection changes as usual, and the op re-runs on the new face selection with the same params
   *  (still one undo step). Drags of the selection orbit instead of moving it, and the selection gizmo hides. */
  opPreview = false;
  /** A MOUSE press on a selected element, waiting to become a drag (moves the selection when `drag`; otherwise the old
   *  press behaviour — a single-vertex drag in vertex mode) or a click (selects; an additive click toggles it off). */
  private _selPress: { id: number; clientX: number; clientY: number; px: number; py: number; additive: boolean; img: number; drag: boolean } | null = null;
  /** The active tool of the tool strip (setMeshEditActiveTool3D). 'move' = the historic default (gizmo 'move'). */
  private _tool: MeshEditTool = 'move';
  /** Loop Cut tool: cuts and their position for the next cut (the pill / adjust-last-op change them). */
  loopCutCount = 1;
  loopCutPosition = 0.5;
  /** Loop Cut tool: the edge whose loop is previewed (mouse hover / a press on a face or edge), the cut position along
   *  it (0–1 from the half-edge's start; from the pointer) and the mirror image it was found on. */
  private _loopHover: { he: number; em: EditMesh; pos: number; img: number } | null = null;
  /** Loop Cut tool: the press that cuts on release (it keeps the ring it started on; sliding moves the position). */
  private _loopPress: { id: number; touch: boolean } | null = null;
  private _loopAt: { x: number; y: number } | null = null;
  private _loopFrame = 0;
  /** Knife tool: the tapped surface points (object space) on this EditMesh. */
  private _knife: { meshId: string; em: EditMesh; points: KnifePoint[] } | null = null;

  /** The active Edit Mesh tool. */
  get tool(): MeshEditTool { return this._tool; }

  // ── One-shot face pick (Mirror "Use Face": tap the button, then tap a face) ──
  /** The armed pick's callback (null = not armed). */
  private _facePick: ((faceIndex: number | null) => void) | null = null;
  /** The press that may become the pick's tap (released within the slop; a drag is the camera's). */
  private _facePickPress: { id: number; clientX: number; clientY: number; touch: boolean; pen: boolean } | null = null;

  /**
   * Arm a ONE-SHOT face pick: the next TAP (mouse click, finger / pen tap) on a face of the edited mesh is consumed —
   * the selection doesn't change — and `onPick(faceIndex)` runs (a tap on the mirror's copy side gives the real
   * partner, as every pick). While armed, presses are never claimed: drags orbit, two fingers pan / zoom; a tap on no
   * face does nothing (still armed). It disarms itself on the pick, and on cancelFacePick / a mode switch away from
   * Face / another tool / detach — those call `onPick(null)`. A running element transform, Chamfer or plane drag is
   * cancelled. Arming again replaces the previous pick (its callback gets null). False when not attached.
   */
  armFacePick(onPick: (faceIndex: number | null) => void): boolean {
    if (!this._canvas || !this._meshId || typeof onPick !== 'function') return false;
    if (this._planeDrag) this.cancelMirrorPlaneDrag();
    if (this.bevel.active) this.bevel.cancel();
    if (this.transform.active) this._endElementTransform(false);
    if (this._dragging) this._cancelDrag();
    this._pending = null; this._selPress = null; this._loopPress = null;
    const prev = this._facePick;
    this._facePick = onPick;
    this._facePickPress = null;
    if (prev) { try { prev(null); } catch (err) { console.warn('[MeshEdit] face pick', err); } }
    return true;
  }

  /** Disarm the face pick (its callback gets null). False when none was armed. */
  cancelFacePick(): boolean {
    const cb = this._facePick;
    if (!cb) return false;
    this._facePick = null;
    this._facePickPress = null;
    try { cb(null); } catch (err) { console.warn('[MeshEdit] face pick', err); }
    return true;
  }

  /** A one-shot face pick is armed (armFacePick). */
  get facePickArmed(): boolean { return this._facePick !== null; }

  /** While a face pick is armed: remember the press (unclaimed — the camera may take it as a drag). */
  private _facePickDown(e: PointerEvent): void {
    const touch = e.pointerType === 'touch';
    if (touch) {
      const id = e.pointerId ?? 0;
      if (e.isPrimary && !this._facePickPress) this._touchIds.clear();
      this._touchIds.add(id);
      if (this._touchIds.size > 1) { this._facePickPress = null; return; }   // a 2nd finger: a camera gesture
    }
    if (e.button !== 0 || e.isPrimary === false) return;
    this._facePickPress = { id: e.pointerId ?? 0, clientX: e.clientX, clientY: e.clientY, touch, pen: e.pointerType === 'pen' };
  }

  /** While a face pick is armed: a press that moved past the slop is a camera drag, not the pick's tap. */
  private _facePickMove(e: PointerEvent): void {
    const p = this._facePickPress;
    if (!p || (e.pointerId ?? 0) !== p.id) return;
    const slop = p.touch || p.pen ? MeshEditPointerController.TAP_SLOP_PX : MOUSE_DRAG_SLOP_PX;
    if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) > slop) this._facePickPress = null;
  }

  /** While a face pick is armed: the tap's release picks the face under it (no face: still armed). */
  private _facePickUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    const p = this._facePickPress;
    if (!p || (e.pointerId ?? 0) !== p.id) return;
    this._facePickPress = null;
    if (!this._canvas || !this._meshId) return;
    this._rect = this._canvas.getBoundingClientRect();
    this._pickScale = p.touch ? TOUCH_PICK_SCALE : 1;
    const at = this._toCanvasPx(e.clientX, e.clientY);
    const fi = this._pickFace(at.x, at.y);
    this._pickScale = 1;
    this._rect = null;
    if (fi < 0) return;
    const cb = this._facePick;
    this._facePick = null;
    try { cb?.(fi); } catch (err) { console.warn('[MeshEdit] face pick', err); }
  }

  /**
   * Switch the tool strip's tool. move / rotate / scale show the selection gizmo in that mode; every other tool hides it.
   * Leaving the Knife drops its points; leaving Loop Cut drops the preview; a running element transform is cancelled.
   * Selecting extrude / inset / bevel changes nothing else (the host runs those ops). False for an unknown tool.
   */
  setTool(tool: MeshEditTool): boolean {
    if (!MESH_EDIT_TOOLS.includes(tool)) return false;
    if (tool !== this._tool) this.cancelFacePick();   // picking another tool ends a one-shot face pick
    if (this.transform.active) this._endElementTransform(false);
    if (tool !== 'knife') this._knife = null;
    if (tool !== 'loopcut') { this._loopHover = null; this._loopPress = null; }
    this._tool = tool;
    this.gizmoMode = tool === 'move' || tool === 'rotate' || tool === 'scale' ? tool : null;
    this._gizmoHover = null;
    this._scheduleRender();
    return true;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement, meshId: string, onSelectionChange?: () => void): void {
    this.detach();
    this._canvas = canvas;
    this._meshId = meshId;
    this._onSelectionChange = onSelectionChange ?? null;
    // (registered first: in the browser a target's capture listeners run first anyway; a plain EventTarget keeps order)
    addZonelessListener(canvas, 'pointerdown', this._onDownCapture, { capture: true });
    addZonelessListener(canvas, 'contextmenu', this._onContextMenu);
    addZonelessListener(canvas, 'pointerleave', this._onLeave);
    addZonelessListener(canvas, 'pointerdown', this._onDown);
    addZonelessListener(canvas, 'pointermove', this._onMove);
    addZonelessListener(canvas, 'pointerup',   this._onUp);
    addZonelessListener(canvas, 'pointercancel', this._onCancel);
    addZonelessListener(canvas, 'lostpointercapture', this._onLost);
    canvas.style.cursor = 'crosshair';
  }

  detach(): void {
    if (!this._canvas) return;
    this.cancelFacePick();
    if (this._planeDrag) this.cancelMirrorPlaneDrag();
    if (this.bevel.active) this.bevel.cancel();
    if (this.transform.active) this._endElementTransform(false);
    this._finishPatchedDrag();
    removeZonelessListener(this._canvas, 'pointerdown', this._onDownCapture, { capture: true });
    removeZonelessListener(this._canvas, 'contextmenu', this._onContextMenu);
    removeZonelessListener(this._canvas, 'pointerleave', this._onLeave);
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
    this._dragPatched = false;
    this._rect = null;
    this._facePicker.clear();
    this._xfPointer = null;
    this._lastMouse = null;
    this._gizmoHover = null;
    this._selPress = null;
    this._loopPress = null;
    this._loopHover = null;
    this._knife = null;
    this._planeHover = null;
    this.opPreview = false;
  }

  setMode(mode: MeshEditSelectionMode): void {
    if (mode !== 'face') this.cancelFacePick();   // Vertex / Edge ends a one-shot face pick
    if (this.bevel.active && mode !== this._mode) this.bevel.cancel();
    if (this.transform.active && mode !== this._mode) this._endElementTransform(false);
    this._mode = mode;
    this._dragging = false;
    this._dragVertexIdx = -1;
    this._pending = null;
    this._selPress = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  get mode(): MeshEditSelectionMode { return this._mode; }
  get isAttached(): boolean { return this._canvas !== null; }
  /** True while a vertex drag (or a finger press that may become one) owns a pointer. */
  get isBusy(): boolean {
    return this._dragging || this._pending !== null || this._bevelPointer !== null || this._xfPointer !== null
      || this._selPress !== null || this._loopPress !== null || this._planeDrag !== null;
  }

  // ── Pointer handlers ────────────────────────────────────────────────────────

  private _handleDown(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    if (this._facePick) { this._facePickDown(e); return; }   // a one-shot face pick takes the tap (never the drag)
    if (this._planeDrag) { this._planeDragDown(e); return; }
    // Only handle primary button
    if (e.button !== 0) return;
    if (this._scene3d.isEditPanTool3D?.()) return;   // the host's Pan tool: the drag pans the camera
    if (this.transform.active) { this._xfDown(e); return; }
    if (this.bevel.active) { this._bevelDown(e); claimPointerEvent(e); return; }   // (the Chamfer owns the pointer)
    const additive = !!e.shiftKey || this._isAdditive();
    if (e.pointerType === 'touch') {
      const id = e.pointerId ?? 0;
      // The primary finger starts a new contact sequence: ids still tracked are stale (a missed up).
      if (e.isPrimary && !this._dragging && !this._pending) this._touchIds.clear();
      this._touchIds.add(id);
      // A 2nd finger is a camera gesture: drop the press, cancel (restore) a vertex drag; never pick.
      if (this._touchIds.size > 1) { this._pending = null; this._loopDrop(); this._cancelDrag(); return; }
      // 7.3b P1: a finger UV paint took (not stopped, so the orbit controller can pinch) is a brush stroke — no pick.
      if (isPointerEventClaimed(e)) return;
      if (e.isPrimary === false) return;
      // A finger on a handle of the selection gizmo drags it at once (fatter hit, as the object gizmo).
      if (!this._scene3d.getTouchNavigate3D?.() && (this._planeDown(e, TOUCH_PICK_SCALE) || this._gizmoDown(e, TOUCH_PICK_SCALE))) return;
      // Loop Cut: a finger on a face (or an edge) previews the loop through the face's edge nearest it at once; sliding
      // moves the cut along that edge, the lift cuts. Off the mesh the press is left to the camera.
      if (this._tool === 'loopcut' && !this._scene3d.getTouchNavigate3D?.()) {
        this._rect = this._canvas.getBoundingClientRect();
        this._pickScale = TOUCH_PICK_SCALE;
        const at = this._toCanvasPx(e.clientX, e.clientY);
        this._loopPress = null;
        this._loopPreviewAt(at.x, at.y);
        if (!this._loopHover) return;
        this._loopPress = { id, touch: true };
        claimPointerEvent(e);
        return;
      }
      // TOUCH-6: nothing on the press — a tap selects on release; a drag from the selection moves it, any other drag
      // is the camera's.
      this._pickScale = TOUCH_PICK_SCALE;
      this._pendingPress(e, additive, false);
      return;
    }
    if (e.pointerType === 'pen') {
      // A pen (round-3 feedback: a pen with no side button must navigate): the gizmo / plane handles and Loop Cut act on
      // the press as for the mouse; anything else waits — a drag from the selection moves it, a tap selects (or adds a
      // knife point) on release, any other drag orbits the camera.
      this._pickScale = 1;
      this._rect = this._canvas.getBoundingClientRect();
      if (this._planeDown(e, 1) || this._gizmoDown(e, 1)) return;
      const at = this._toCanvasPx(e.clientX, e.clientY);
      if (this._tool === 'loopcut') {
        this._loopPress = null;
        this._loopPreviewAt(at.x, at.y);
        if (!this._loopHover) return;   // off the mesh: the pen drag is the camera's
        this._loopPress = { id: e.pointerId ?? 0, touch: false };
        claimPointerEvent(e);
        try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        return;
      }
      this._pendingPress(e, additive, true);
      return;
    }
    this._pickScale = 1;
    this._rect = this._canvas.getBoundingClientRect();
    // The mirror plane's rotation rings / the selection gizmo's handles win over the vertex / edge / face under them.
    if (this._planeDown(e, 1) || this._gizmoDown(e, 1)) return;
    const { x: px, y: py } = this._toCanvasPx(e.clientX, e.clientY);

    if (this._tool === 'knife') { this.knifeAddAt(px, py); return; }
    if (this._tool === 'loopcut') {
      this._loopPress = null;
      this._loopPreviewAt(px, py);
      if (!this._loopHover) return;
      this._loopPress = { id: e.pointerId ?? 0, touch: false };
      try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return;
    }
    // A press ON the selection waits: a drag moves the selection, a click selects as usual (on release). An ADDITIVE
    // press on it waits too (even without drag-moves-selection): the click toggles the element off, a drag never does.
    const dragSel = this.dragMovesSelection && !this.dragLock && !this.opPreview && this._canDragVertex();
    if ((dragSel || additive) && this._hasSelection() && this._isSelectedAt(px, py)) {
      this._selPress = { id: e.pointerId ?? 0, clientX: e.clientX, clientY: e.clientY, px, py, additive, img: this._lastPickImg, drag: dragSel };
      try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return;
    }

    if (this._mode === 'vertex') {
      const vi = this._pickVertex(px, py);
      if (vi >= 0) {
        this._meshEdit.selectVertex(this._meshId, vi, additive);
        this._onSelectionChange?.();
        if (!this.dragLock) this._beginVertexDrag(vi, px, py, e.pointerId);
        this._scheduleRender();
      }
    } else {
      this._selectAt(px, py, additive);
    }
  }

  /** A finger / pen press that waits (TOUCH-6): it moves the selection when it starts on it (claimed — the camera
   *  leaves it alone), else a tap selects on release and a drag is the camera's. With drag-moves-selection off, a press
   *  on a vertex in vertex mode keeps the old single-vertex drag (claimed). */
  private _pendingPress(e: PointerEvent, additive: boolean, pen: boolean): void {
    if (!this._canvas) return;
    this._rect = this._canvas.getBoundingClientRect();
    const at = this._toCanvasPx(e.clientX, e.clientY);
    let drag: 'selection' | 'vertex' | null = null;
    if (this._tool !== 'knife' && !this.opPreview && !this.dragLock && this._canDragVertex()) {
      if (this.dragMovesSelection) { if (this._hasSelection() && this._isSelectedAt(at.x, at.y)) drag = 'selection'; }
      else if (this._mode === 'vertex' && this._pickVertex(at.x, at.y) >= 0) drag = 'vertex';
    }
    if (drag) claimPointerEvent(e);
    this._pending = { id: e.pointerId ?? 0, clientX: e.clientX, clientY: e.clientY, additive, drag, img: this._lastPickImg, pen };
    if (pen && drag) { try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } }
  }

  private _handleMove(e: PointerEvent): void {
    if (!this._canvas || !this._meshId) return;
    if (e.pointerType === 'mouse') this._lastMouse = { clientX: e.clientX, clientY: e.clientY };
    if (this._facePick) { this._facePickMove(e); return; }
    if (this._planeDrag) { this._planeDragMove(e); return; }
    if (this.transform.active) { this._xfMove(e); return; }
    if (this.bevel.active) { this._bevelMove(e); return; }
    const touch = e.pointerType === 'touch';
    // A mouse press on the selection that moved past the slop: the selection follows it (from the PRESS point).
    const sp = this._selPress;
    if (sp && (e.pointerId ?? 0) === sp.id) {
      if (Math.hypot(e.clientX - sp.clientX, e.clientY - sp.clientY) <= MOUSE_DRAG_SLOP_PX) return;
      this._selPress = null;
      if (sp.drag) {
        if (!this._beginSelectionDrag(sp.id, sp.px, sp.py, e, sp.img) && this._canvas) {
          try { this._canvas.releasePointerCapture(sp.id); } catch { /* gone */ }
        }
        return;
      }
      // (an additive press without drag-moves-selection) the old press: a vertex-mode drag picks the vertex up from
      // the PRESS point — already selected, so the selection is unchanged — else nothing
      const vi = this._mode === 'vertex' && !this.dragLock && this._canDragVertex() ? this._pickVertex(sp.px, sp.py) : -1;
      if (vi < 0) {
        if (this._canvas) { try { this._canvas.releasePointerCapture(sp.id); } catch { /* gone */ } }
        return;
      }
      this._beginVertexDrag(vi, sp.px, sp.py, sp.id);
      this._dragAt = this._toCanvasPx(e.clientX, e.clientY);
      this._scheduleDragFrame();
      return;
    }
    // Loop Cut: a held press (finger or mouse) previews the loop under the pointer (once per frame).
    if (this._loopPress && (e.pointerId ?? 0) === this._loopPress.id) { this._scheduleLoopPreview(e.clientX, e.clientY); return; }
    // A finger press that moved past the slop: from the SELECTION it moves the selection; in vertex mode a drag from a
    // vertex picks it up (from the PRESS point, so it follows the finger exactly); otherwise it isn't a tap any more and
    // does nothing.
    const p = this._pending;
    if (p && (touch || p.pen) && (e.pointerId ?? 0) === p.id) {
      if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) <= MeshEditPointerController.TAP_SLOP_PX) return;
      this._pending = null;
      if (this._touchIds.size > 1 || this._scene3d.getTouchNavigate3D?.() || this._tool === 'knife') return;
      if (!p.drag) return;   // a drag off the selection: the camera orbits it (the press was not claimed)
      this._pickScale = p.pen ? 1 : TOUCH_PICK_SCALE;
      const at = this._toCanvasPx(p.clientX, p.clientY);
      if (p.drag === 'selection') {
        this._beginSelectionDrag(p.id, at.x, at.y, e, p.img);
        return;
      }
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
    if (!touch && this._tool === 'loopcut') { this._scheduleLoopPreview(e.clientX, e.clientY); return; }   // mouse hover previews the loop
    if (touch || (this._mode !== 'vertex' && this.gizmoMode === null && !this._planeTarget())) return;   // a finger has no hover
    // Mouse hover: the selection gizmo's handle under the pointer lights up; in vertex mode the cursor shows "grab"
    // over a vertex — resolved once per frame (a pick is O(V)).
    this._hoverAt = { x: e.clientX, y: e.clientY };
    if (this._hoverFrame) return;
    let ran = false;
    const id = this._frame(() => {
      ran = true;
      this._hoverFrame = 0;
      const at = this._hoverAt;
      this._hoverAt = null;
      if (!at || !this._canvas || this._dragging || this.transform.active || this.bevel.active) return;
      this._pickScale = 1;
      this._rect = null;   // a hover reads the rect fresh (the canvas may have moved since the last press)
      const c = this._toCanvasPx(at.x, at.y);
      const pt = this._planeTarget();
      const g = pt ? { center: pt.centerW, rotation: pt.rotation, mode: 'rotate' as const } : this._gizmoTarget();
      const cam = this._scene3d.getCamera?.();
      const axis = g && cam ? this._gizmoHit(c.x, c.y, g, cam, 1) : null;
      if (pt) { if (axis !== this._planeHover) { this._planeHover = axis; this._scheduleRender(); } }
      else if (axis !== this._gizmoHover) { this._gizmoHover = axis; this._scheduleRender(); }
      if (axis) { this._canvas.style.cursor = 'grab'; return; }
      if (this._mode !== 'vertex') { this._canvas.style.cursor = 'crosshair'; return; }
      this._canvas.style.cursor = this._pickVertex(c.x, c.y) >= 0 ? 'grab' : 'crosshair';
    });
    if (!ran) this._hoverFrame = id;
  }

  private _handleUp(e: PointerEvent): void {
    if (this._facePick) { this._facePickUp(e); return; }
    if (this._planeDrag) { this._planeDragUp(e); return; }
    if (this.transform.active || this._xfPointer !== null) { this._xfUp(e); return; }
    if (this.bevel.active || this._bevelPointer !== null || this._bevelPending) { this._bevelUp(e); return; }
    const touch = e.pointerType === 'touch';
    if (touch) this._touchIds.delete(e.pointerId ?? 0);
    const sp = this._selPress;
    if (sp && (e.pointerId ?? 0) === sp.id) {
      // A CLICK on the selection (no drag): the usual select at the press point — an additive one (Shift / the latch)
      // toggles the element off.
      this._selPress = null;
      if (this._canvas) { try { this._canvas.releasePointerCapture(sp.id); } catch { /* gone */ } }
      if (this._canvas && this._meshId) {
        this._pickScale = 1;
        this._selectAt(sp.px, sp.py, sp.additive, true);
      }
      this._rect = null;
      return;
    }
    const lp = this._loopPress;
    if (lp && (e.pointerId ?? 0) === lp.id) {
      // Loop Cut: the release cuts the previewed loop (the ring the press started on, at the release point's position).
      if (this._loopFrame) { this._cancelFrame(this._loopFrame); this._loopFrame = 0; }
      this._loopAt = null;
      if (this._canvas && !lp.touch) { try { this._canvas.releasePointerCapture(lp.id); } catch { /* gone */ } }
      if (this._canvas) {
        this._pickScale = lp.touch ? TOUCH_PICK_SCALE : 1;
        const at = this._toCanvasPx(e.clientX, e.clientY);
        this._loopPreviewAt(at.x, at.y);   // (still held: slides along the press's edge)
      }
      this._loopPress = null;
      if (this._canvas) {
        const h = this._loopHover;
        if (h && h.em === this._getMesh()?.editMesh) this._loopCut(h.he, h.pos);
        if (lp.touch) this._loopHover = null;   // (a finger has no hover; the mouse keeps previewing)
      }
      this._rect = null;
      return;
    }
    const p = this._pending;
    if (p && (touch || p.pen) && (e.pointerId ?? 0) === p.id) {
      // A TAP: select at the release point (vertex mode selects only — a drag needs movement; an additive tap on a
      // selected element toggles it off); the Knife adds a point.
      this._pending = null;
      if (p.pen && this._canvas) { try { this._canvas.releasePointerCapture(p.id); } catch { /* not captured */ } }
      if (this._canvas && this._meshId) {
        this._pickScale = p.pen ? 1 : TOUCH_PICK_SCALE;
        const at = this._toCanvasPx(e.clientX, e.clientY);
        if (this._tool === 'knife') this.knifeAddAt(at.x, at.y);
        else this._selectAt(at.x, at.y, p.additive, true);
      }
      this._rect = null;
      return;
    }
    if (this._dragging && this._dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== this._dragPointerId) return;
    this._dragPointerId = null;
    if (this._dragging) this._flushDragFrame();
    this._finishPatchedDrag();   // 7.3d: one full recompile at the end of an in-place-patched drag
    if (this._dragging && this._dragVertexIdx >= 0 && this._meshId && this._dragSnapshot) {
      const mesh = this._getMesh();
      if (mesh?.editMesh && !this._dragMovedAny(mesh.editMesh)) {
        // A press released without moving anything (a click that selected the vertex): no (empty) undo step. A zero-delta
        // drag frame may still have recomputed custom normals: put them back exactly.
        if (this._dragApplied && this._dragHadCustomNormals) {
          mesh.editMesh = EditMesh.fromJSON(this._dragSnapshot);
          mesh.syncFromEditMesh();
          this.dragStats.fullSyncs++;
        }
      } else if (mesh?.editMesh) {
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
    if (this._facePick) {
      if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
      if (this._facePickPress && (e.pointerId ?? 0) === this._facePickPress.id) this._facePickPress = null;
      return;
    }
    if (this._planeDrag) {
      if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
      if (e.pointerId === undefined || e.pointerId === this._planeDrag.pointer) this.cancelMirrorPlaneDrag();
      return;
    }
    if (this.transform.active || this._xfPointer !== null) {
      if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
      if (this._xfPointer !== null && (e.pointerId === undefined || e.pointerId === this._xfPointer)) this._xfAbortPointer();
      return;
    }
    if (this.bevel.active || this._bevelPointer !== null || this._bevelPending) {
      if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
      if (this._bevelPending && (e.pointerId ?? 0) === this._bevelPending.id) this._bevelPending = null;
      if (this._bevelPointer !== null && (e.pointerId === undefined || e.pointerId === this._bevelPointer)) { this._bevelPointer = null; this.bevel.dragAbort(); }
      return;
    }
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if (this._selPress && (e.pointerId ?? 0) === this._selPress.id) { this._selPress = null; return; }
    if (this._loopPress && (e.pointerId ?? 0) === this._loopPress.id) { this._loopDrop(); return; }
    if (this._pending && (e.pointerId ?? 0) === this._pending.id) { this._pending = null; return; }
    if (this._dragPointerId === null || e.pointerId === undefined || e.pointerId === this._dragPointerId) this._cancelDrag();
  }

  /** The drag's pointer lost capture without an up (the browser / another handler took it): end the drag normally
   *  (after a normal up it is already over — no-op). */
  private _handleLostCapture(e: PointerEvent): void {
    if (this._planeDrag && e.pointerId === this._planeDrag.pointer) { this._planeDragUp(e); return; }
    if (this._xfPointer !== null && e.pointerId === this._xfPointer) { this._xfUp(e); return; }
    if (!this._dragging || this._dragPointerId === null || e.pointerId !== this._dragPointerId) return;
    this._handleUp(e);
  }

  // ── Element transforms (G / R / S + the selection gizmo) ────────────────────

  /** The pointer driving the element transform: a finger / pen drag of the modal, or a gizmo-handle drag. */
  private _xfPointer: number | null = null;
  /** Latest pointer position for the transform (client px + Ctrl), applied once per frame. */
  private _xfAt: { clientX: number; clientY: number; ctrl: boolean } | null = null;
  private _xfFrame = 0;
  /** Where the mouse last was over the canvas (client px) — the mouse-follow start when G is pressed; null after it
   *  left the canvas (the next move into it starts the follow, no jump). */
  private _lastMouse: { clientX: number; clientY: number } | null = null;
  /** A right-click cancel: swallow the context menu that follows it. */
  private _suppressMenuUntil = 0;
  /** The selection-gizmo handle under the mouse (hover highlight). */
  private _gizmoHover: GizmoAxis = null;

  private readonly _onDownCapture = (e: PointerEvent) => this._handleDownCapture(e);
  private readonly _onContextMenu = (e: Event) => {
    if ((this.transform.active && this.transform.source === 'modal') || Date.now() < this._suppressMenuUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  private readonly _onLeave = (e: PointerEvent) => { if (e.pointerType === 'mouse') this._lastMouse = null; };

  /**
   * Start G / R / S on the selected elements of the mesh in Edit Mesh (the router's begin). With the mouse over the
   * canvas the transform follows it from where it is now; otherwise from the next move / finger drag. False when nothing
   * is selected, the Chamfer runs, a vertex / gizmo drag is in progress, or the mesh can't be sculpted (skinned).
   */
  beginElementTransform(mode: ElementTransformMode): boolean {
    const id = this._meshEdit.activeMeshId ?? this._meshId;
    if (!id || this.bevel.active || this._dragging) return false;
    if (this.transform.active && this.transform.source === 'gizmo') return false;
    if (this.transform.active) this._endElementTransform(false);
    if (!this.transform.begin(id, mode, { source: 'modal' })) return false;
    this._gizmoHover = null;
    if (this._canvas && this._meshId === id && this._lastMouse) {
      this._rect = this._canvas.getBoundingClientRect();
      const at = this._toCanvasPx(this._lastMouse.clientX, this._lastMouse.clientY);
      this.transform.pointerStart(at.x, at.y, this._canvas.width, this._canvas.height);
    }
    return true;
  }

  /** Apply (true) or cancel the running element transform; the pointer it held is released. */
  private _endElementTransform(apply: boolean): void {
    if (apply) this._flushXfFrame();
    else this._dropXfFrame();
    this._xfReleasePointer();
    if (apply) this.transform.commit(); else this.transform.cancel();
    this._rect = null;
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
  }

  /** Capture-phase press while a MODAL transform runs (mouse): left = Apply, right = Cancel — before the orbit
   *  controller (a right-drag pans) or a selection pick sees it. Fingers / pen fall through to {@link _xfDown}. */
  private _handleDownCapture(e: PointerEvent): void {
    if (!this._canvas || !this.transform.active) return;
    if (this.transform.source === 'drag') {
      // a right click while dragging the selection cancels it (and its context menu is swallowed)
      if (e.pointerType !== 'mouse' || e.button !== 2) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this._suppressMenuUntil = Date.now() + 1500;
      this._endElementTransform(false);
      return;
    }
    if (this.transform.source !== 'modal') return;
    if (e.pointerType !== 'mouse' || (e.button !== 0 && e.button !== 2)) return;   // middle: the camera
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.button === 2) this._suppressMenuUntil = Date.now() + 1500;
    else if (this._lastMouse === null) this._lastMouse = { clientX: e.clientX, clientY: e.clientY };
    if (e.button === 0) this._xfAt = this._xfAt ?? { clientX: e.clientX, clientY: e.clientY, ctrl: !!(e.ctrlKey || e.metaKey) };
    this._endElementTransform(e.button === 0);
  }

  /** A press (bubble phase) while a transform runs: a finger / pen starts a drag of the modal (each drag continues the
   *  last); a 2nd finger is a camera gesture — it drops the current drag (a gizmo drag is cancelled). */
  private _xfDown(e: PointerEvent): void {
    if (!this._canvas) return;
    if (e.pointerType === 'touch') {
      const id = e.pointerId ?? 0;
      if (e.isPrimary && this._xfPointer === null) this._touchIds.clear();
      this._touchIds.add(id);
      if (this._touchIds.size > 1) { this._xfAbortPointer(); return; }
    }
    if (this.transform.source !== 'modal' || e.pointerType === 'mouse') return;
    if (isPointerEventClaimed(e) || e.isPrimary === false || this._scene3d.getTouchNavigate3D?.()) return;
    claimPointerEvent(e);   // the modal's drag, not the camera's
    if (this.transform.dragging) this.transform.pointerEnd();
    this._rect = this._canvas.getBoundingClientRect();
    const at = this._toCanvasPx(e.clientX, e.clientY);
    try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this._xfPointer = e.pointerId ?? 0;
    this.transform.pointerStart(at.x, at.y, this._canvas.width, this._canvas.height);
  }

  private _xfMove(e: PointerEvent): void {
    if (this._xfPointer !== null) {
      if ((e.pointerId ?? 0) !== this._xfPointer) return;
    } else if (!(e.pointerType === 'mouse' && this.transform.source === 'modal')) {
      return;   // the modal follows the mouse; a finger / pen needs a press first
    }
    this._xfAt = { clientX: e.clientX, clientY: e.clientY, ctrl: !!(e.ctrlKey || e.metaKey) };
    if (this._xfFrame) return;
    let ran = false;
    const id = this._frame(() => { ran = true; this._xfFrame = 0; this._applyXfMove(); });
    if (!ran) this._xfFrame = id;
  }

  private _applyXfMove(): void {
    const at = this._xfAt;
    this._xfAt = null;
    if (!at || !this._canvas || !this.transform.active) return;
    if (!this._rect) this._rect = this._canvas.getBoundingClientRect();
    const c = this._toCanvasPx(at.clientX, at.clientY);
    this.transform.pointerMove(c.x, c.y, this._canvas.width, this._canvas.height, at.ctrl);
  }

  private _flushXfFrame(): void {
    if (this._xfFrame) { this._cancelFrame(this._xfFrame); this._xfFrame = 0; }
    if (this._xfAt) this._applyXfMove();
  }

  private _dropXfFrame(): void {
    if (this._xfFrame) { this._cancelFrame(this._xfFrame); this._xfFrame = 0; }
    this._xfAt = null;
  }

  private _xfUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if (this._xfPointer === null || (e.pointerId ?? 0) !== this._xfPointer) return;
    // a gizmo drag / a drag of the selection applies on release
    if (this.transform.source === 'gizmo' || this.transform.source === 'drag') { this._endElementTransform(true); return; }
    this._flushXfFrame();
    this._xfReleasePointer();
    this.transform.pointerEnd();
  }

  /** A 2nd finger / pointercancel: a modal drag's movement is dropped (the earlier drags stay); a gizmo drag is cancelled. */
  private _xfAbortPointer(): void {
    if (this.transform.active && (this.transform.source === 'gizmo' || this.transform.source === 'drag')) { this._endElementTransform(false); return; }
    this._dropXfFrame();
    this._xfReleasePointer();
    this.transform.pointerAbort();
  }

  private _xfReleasePointer(): void {
    if (this._xfPointer !== null && this._canvas) { try { this._canvas.releasePointerCapture(this._xfPointer); } catch { /* gone */ } }
    this._xfPointer = null;
  }

  /** The selection gizmo, when it shows: a gizmo mode, something selected, no Chamfer / modal transform, a sculptable
   *  mesh. `center` = the selection's centroid now (it moves with a grab), `rotation` = the local orientation's. */
  private _gizmoTarget(): { center: [number, number, number]; rotation: Float32Array | null; mode: 'move' | 'rotate' | 'scale' } | null {
    const mode = this.gizmoMode;
    if (!this._canvas || !this._meshId || mode === null || this.bevel.active || this.opPreview) return null;
    if (this._planeTarget()) return null;   // one handle at a time: the mirror plane's rings replace the selection gizmo
    if (this.transform.active && this.transform.source === 'modal') return null;
    const mesh = this._getMesh();
    const em = mesh?.editMesh;
    if (!mesh || !em || mesh instanceof SkinnedMesh3D) return null;
    const sel = this._meshEdit.selectedVertexIndices(this._meshId);
    if (sel.length === 0) return null;
    let x = 0, y = 0, z = 0;
    for (const i of sel) { const v = em.vertices[i]; x += v.x; y += v.y; z += v.z; }
    const w = this._objToWorld(x / sel.length, y / sel.length, z / sel.length, mesh);
    const local = (this._scene3d.getGizmoOrientation?.() ?? 'world') === 'local';
    return {
      center: [w.x, w.y, w.z],
      rotation: local ? GizmoRenderer.rotationOf(mesh.localMatrix as unknown as ArrayLike<number>) as unknown as Float32Array : null,
      mode,
    };
  }

  /** The gizmo handle under canvas px (x, y), or null. */
  private _gizmoHit(x: number, y: number, g: { center: [number, number, number]; rotation: Float32Array | null; mode: 'move' | 'rotate' | 'scale' },
    cam: NonNullable<ReturnType<Scene3DManager['getCamera']>>, hitScale: number): GizmoAxis {
    if (!this._canvas) return null;
    const ray = screenRay(cam.getViewProjectionMatrix() as unknown as mat4, x, y, this._canvas.width, this._canvas.height);
    if (!ray) return null;
    return hitTestGizmoAt(ray.origin, ray.dir, g.center, g.rotation as unknown as mat4 | null, cam, g.mode, hitScale);
  }

  /** A press on a selection-gizmo handle starts a gizmo drag of the selected elements (released = applied). */
  private _gizmoDown(e: PointerEvent, hitScale: number): boolean {
    if (!this._canvas || !this._meshId) return false;
    const g = this._gizmoTarget();
    const cam = this._scene3d.getCamera?.();
    if (!g || !cam) return false;
    this._rect = this._canvas.getBoundingClientRect();
    const at = this._toCanvasPx(e.clientX, e.clientY);
    const axis = this._gizmoHit(at.x, at.y, g, cam, hitScale);
    const mode = gizmoModeToTransform(g.mode);
    if (!axis || !mode) return false;
    if (!this.transform.begin(this._meshId, mode, { source: 'gizmo', axis })) return false;
    claimPointerEvent(e);
    try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this._xfPointer = e.pointerId ?? 0;
    this._gizmoHover = null;
    this.transform.pointerStart(at.x, at.y, this._canvas.width, this._canvas.height);
    e.stopPropagation();
    this._canvas.style.cursor = 'grabbing';
    this._scheduleRender();
    return true;
  }

  /** A drag that started on the selection: an element GRAB (source 'drag') from the press point (canvas px), the
   *  pointer's current position applied at once. False when nothing could start (nothing selected, a skinned body). */
  private _beginSelectionDrag(pointerId: number, px: number, py: number, now: PointerEvent, img = 0): boolean {
    if (!this._canvas || !this._meshId || this.bevel.active) return false;
    // a drag that started on a mirror's COPY side moves the real elements so the copy follows the pointer
    const planes = img ? this._mirrorPlanes() : [];
    const image = img && planes.length ? imageAffine(planes, img) : null;
    if (!this.transform.begin(this._meshId, 'grab', { source: 'drag', image })) return false;
    try { this._canvas.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    this._xfPointer = pointerId;
    this._gizmoHover = null;
    this.transform.pointerStart(px, py, this._canvas.width, this._canvas.height);
    this._xfAt = { clientX: now.clientX, clientY: now.clientY, ctrl: !!(now.ctrlKey || now.metaKey) };
    this._applyXfMove();
    this._canvas.style.cursor = 'grabbing';
    this._onSelectionChange?.();
    return true;
  }

  /** The selection gizmo for the edit overlay (MeshEditDrawData.gizmo), or null when it is hidden. */
  gizmoDrawData(): MeshEditGizmoDraw | null {
    const pt = this._planeTarget();
    if (pt) {
      const dragging = this._planeDrag ? this._planeDrag.axis : null;
      return { center: pt.centerW, rotation: pt.rotation, mode: 'rotate', hovered: dragging ? null : this._planeHover, dragging };
    }
    const g = this._gizmoTarget();
    if (!g) return null;
    const dragging = this.transform.active && this.transform.source === 'gizmo' ? this.transform.axis : null;
    return { center: g.center, rotation: g.rotation, mode: g.mode, hovered: dragging ? null : this._gizmoHover, dragging };
  }

  /** scene3d's G / R / S family, routed here while a mesh is in Edit Mesh (Scene3DManager.setElementTransformRouter). */
  elementTransformRouter(): ElementTransformRouter {
    return {
      handles: () => this._meshEdit.isEditing && !!this._meshEdit.activeMeshId,
      isActive: () => this.transform.active,
      isModal: () => this.transform.active && this.transform.source === 'modal',
      acceptsAxis: () => this.transform.active && (this.transform.source === 'modal' || this.transform.source === 'drag'),
      mode: () => this.transform.mode,
      axis: () => this.transform.shortcutAxis,
      numeric: () => this.transform.numeric,
      begin: (mode) => { this.beginElementTransform(mode); },
      constrainAxis: (axis) => this.transform.setAxis(axis),
      appendNumeric: (ch) => this.transform.appendNumeric(ch),
      commit: () => { if (this.transform.active) this._endElementTransform(true); },
      cancel: () => { if (this._planeDrag) this.cancelMirrorPlaneDrag(); if (this.transform.active) this._endElementTransform(false); },
      setGizmoMode: (mode) => {
        // the tool strip follows: a gizmo mode IS the move / rotate / scale tool
        if (mode === 'move' || mode === 'rotate' || mode === 'scale') { if (this._tool !== mode) this.setTool(mode); }
        else if (this._tool === 'move' || this._tool === 'rotate' || this._tool === 'scale') this._tool = 'select';
        this.gizmoMode = mode; this._gizmoHover = null; this._scheduleRender();
      },
      dragInfo: () => {
        const s = this.transform.state();
        if (!s || s.source !== 'gizmo') return null;
        const axis = s.axis;
        return {
          isDragging: true, mode: s.mode === 'grab' ? 'move' : s.mode, axis,
          angleDeg: s.mode === 'rotate' ? s.angleDeg : null, gizmoCenterWorld: s.pivot,
        };
      },
    };
  }

  // ── Chamfer / Bevel tool routing ────────────────────────────────────────────

  /** The pointer whose drag sets the bevel amount (null = none). */
  private _bevelPointer: number | null = null;
  /** A finger press in the bevel tool waiting to become a tap (pick) or a drag (amount). */
  private _bevelPending: { id: number; clientX: number; clientY: number } | null = null;
  private _bevelAt: { x: number; y: number; ctrl: boolean } | null = null;
  private _bevelFrame = 0;

  private _bevelDown(e: PointerEvent): void {
    if (!this._canvas) return;
    if (e.pointerType === 'touch') {
      const id = e.pointerId ?? 0;
      if (e.isPrimary && this._bevelPointer === null && !this._bevelPending) this._touchIds.clear();
      this._touchIds.add(id);
      // a 2nd finger is a camera gesture: drop the press, put the amount back where the drag started
      if (this._touchIds.size > 1) { this._bevelPending = null; if (this._bevelPointer !== null) { this._bevelPointer = null; this.bevel.dragAbort(); } return; }
      if (isPointerEventClaimed(e) || e.isPrimary === false) return;
      this._bevelPending = { id, clientX: e.clientX, clientY: e.clientY };
      this._rect = this._canvas.getBoundingClientRect();
      return;
    }
    // mouse / pen: a press picks (pick phase) and drags the amount at once
    this._pickScale = 1;
    this._rect = this._canvas.getBoundingClientRect();
    const at = this._toCanvasPx(e.clientX, e.clientY);
    if (this.bevel.phase === 'pick' && !this._bevelPick(at.x, at.y)) return;
    this._bevelStartDrag(at.x, at.y, e.pointerId);
  }

  private _bevelMove(e: PointerEvent): void {
    const p = this._bevelPending;
    if (p && e.pointerType === 'touch' && (e.pointerId ?? 0) === p.id) {
      if (Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) <= MeshEditPointerController.TAP_SLOP_PX) return;
      this._bevelPending = null;
      // a finger drag sets the amount (adjust phase; not while the host latched one-finger navigation)
      if (this.bevel.phase !== 'adjust' || this._touchIds.size > 1 || this._scene3d.getTouchNavigate3D?.()) return;
      this._pickScale = TOUCH_PICK_SCALE;
      const at = this._toCanvasPx(p.clientX, p.clientY);
      if (!this._bevelStartDrag(at.x, at.y, p.id)) return;
      // fall through: apply the current position
    }
    if (this._bevelPointer === null || (e.pointerId !== undefined && e.pointerId !== this._bevelPointer)) return;
    const c = this._toCanvasPx(e.clientX, e.clientY);
    this._bevelAt = { x: c.x, y: c.y, ctrl: !!(e.ctrlKey || e.metaKey) };
    if (this._bevelFrame) return;
    let ran = false;
    const id = this._frame(() => { ran = true; this._bevelFrame = 0; this._applyBevelDrag(); });
    if (!ran) this._bevelFrame = id;
  }

  private _bevelUp(e: PointerEvent): void {
    const touch = e.pointerType === 'touch';
    if (touch) this._touchIds.delete(e.pointerId ?? 0);
    const p = this._bevelPending;
    if (p && touch && (e.pointerId ?? 0) === p.id) {
      // a TAP: in the pick phase it picks the corner / edge under the finger
      this._bevelPending = null;
      if (this._canvas && this.bevel.phase === 'pick') {
        this._pickScale = TOUCH_PICK_SCALE;
        const at = this._toCanvasPx(e.clientX, e.clientY);
        this._bevelPick(at.x, at.y);
      }
      this._rect = null;
      return;
    }
    if (this._bevelPointer === null || (e.pointerId !== undefined && e.pointerId !== this._bevelPointer)) return;
    if (this._bevelFrame) { this._cancelFrame(this._bevelFrame); this._bevelFrame = 0; }
    this._applyBevelDrag();
    if (this._canvas) { try { this._canvas.releasePointerCapture(this._bevelPointer); } catch { /* gone */ } }
    this._bevelPointer = null;
    this.bevel.dragEnd();
    this._rect = null;
  }

  /** Pick phase: the vertex under (x, y), else the edge — start the bevel on it. */
  private _bevelPick(px: number, py: number): boolean {
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return false;
    const vi = this._pickVertex(px, py);
    if (vi >= 0 && this.bevel.pick({ vertex: vi })) return true;
    const hi = this._pickEdge(px, py);
    const ends = hi >= 0 ? mesh.editMesh.getHalfEdgeVertices(hi) : null;
    return !!ends && this.bevel.pick({ edge: ends });
  }

  private _bevelStartDrag(px: number, py: number, pointerId: number): boolean {
    const mesh = this._getMesh();
    if (!this._canvas || !mesh) return false;
    if (!this.bevel.dragStart(px, py, this._projector(mesh, this._canvas.width, this._canvas.height))) return false;
    try { this._canvas.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    this._bevelPointer = pointerId ?? 0;
    return true;
  }

  private _applyBevelDrag(): void {
    const at = this._bevelAt;
    this._bevelAt = null;
    if (!at || this._bevelPointer === null) return;
    this.bevel.dragMove(at.x, at.y, at.ctrl);
    this._scheduleRender();
  }

  /** Mouse wheel while the tool is active: segments ± 1 (instead of the Edit Mesh zoom). Window capture phase, so it
   *  runs before the canvas zoom interceptor. */
  private _bevelWheelOn = false;
  private readonly _onBevelWheel = (e: WheelEvent): void => {
    if (!this.bevel.active || e.target !== this._canvas || Math.abs(e.deltaY) < 0.5) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const s = this.bevel.state();
    if (s) this.bevel.setSegments(s.segments + (e.deltaY < 0 ? 1 : -1));
    this._scheduleRender();
  };
  private _syncBevelWheel(): void {
    const w = typeof window !== 'undefined' ? window : null;
    if (!w) return;
    const want = this.bevel.active && !!this._canvas;
    if (want === this._bevelWheelOn) return;
    this._bevelWheelOn = want;
    if (want) w.addEventListener('wheel', this._onBevelWheel, { capture: true, passive: false });
    else w.removeEventListener('wheel', this._onBevelWheel, { capture: true });
  }

  // ── Mirror plane handle (sm.setMirrorPlaneHandle3D) ─────────────────────────

  /** Which mirror's plane is shown with its rotation handle (null = none). One at a time. */
  private _planeHandle: { meshId: string; modIndex: number } | null = null;
  /** A drag of one of the plane's rotation rings: live preview, one undo step on release, a 2nd finger / Esc /
   *  pointercancel puts the plane back. */
  private _planeDrag: {
    pointer: number; axis: 'x' | 'y' | 'z'; meshId: string; modIndex: number;
    startNormal: [number, number, number]; rx: number; ry: number; cx: number; cy: number; touch: boolean;
  } | null = null;
  private _planeHover: GizmoAxis = null;
  private _planeFrame = 0;
  private _planeMoved = false;
  /** The image (bitmask of mirror reflections, edit-mesh-mirror.ts) the last vertex / edge / face pick hit through:
   *  0 = the real side. A drag from a copy-side pick moves the real element so the copy follows the pointer. */
  private _lastPickImg = 0;

  /**
   * Show mirror modifier `modIndex`'s plane on the canvas (a translucent quad sized to the mesh + its outline) with a
   * rotation handle (the rotate-gizmo rings at the plane's point, object axes): dragging a ring turns the plane about
   * its point. Null hides it. Only while the mesh is in Edit Mesh (the handle hides itself otherwise).
   */
  setMirrorPlaneHandle(meshId: string | null, modIndex: number | null): void {
    if (this._planeDrag) this.cancelMirrorPlaneDrag();
    this._planeHandle = meshId !== null && modIndex !== null && modIndex >= 0 ? { meshId, modIndex } : null;
    this._planeHover = null;
    this._scheduleRender();
  }

  /** The shown plane handle (null = none). */
  get mirrorPlaneHandle(): { meshId: string; modIndex: number } | null { return this._planeHandle ? { ...this._planeHandle } : null; }

  /** The shown handle's mesh / mirror / plane (object space) and the gizmo placement (world point, object rotation). */
  private _planeTarget(): { mesh: Mesh3D; mod: MirrorModifier; point: [number, number, number]; normal: [number, number, number]; centerW: [number, number, number]; rotation: Float32Array } | null {
    const h = this._planeHandle;
    if (!h || !this._meshEdit.isEditing || this._meshEdit.activeMeshId !== h.meshId) return null;
    const mesh = this._scene3d.getMesh(h.meshId);
    const mod = mesh?.editMesh?.modifiers[h.modIndex];
    if (!mesh || !(mod instanceof MirrorModifier)) return null;
    const pl = mod.getPlane();
    const w = this._objToWorld(pl.point[0], pl.point[1], pl.point[2], mesh);
    return {
      mesh, mod, point: pl.point, normal: pl.normal, centerW: [w.x, w.y, w.z],
      rotation: GizmoRenderer.rotationOf(mesh.localMatrix as unknown as ArrayLike<number>) as unknown as Float32Array,
    };
  }

  /** The plane quad for the edit overlay: 4 world-space corners (xyz × 4, in order around the quad), centred on the
   *  mesh's bounds centre projected onto the plane, sized to the mesh. Null when no handle shows. */
  mirrorPlaneQuad(): Float32Array | null {
    const t = this._planeTarget();
    const em = t?.mesh.editMesh;
    if (!t || !em) return null;
    const n = t.normal, p = t.point;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const v of em.vertices) {
      if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
      if (v.y < y0) y0 = v.y; if (v.y > y1) y1 = v.y;
      if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
    }
    if (!(x1 >= x0)) { x0 = y0 = z0 = -0.5; x1 = y1 = z1 = 0.5; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const half = Math.max(0.05, Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.6);
    const d = (cx - p[0]) * n[0] + (cy - p[1]) * n[1] + (cz - p[2]) * n[2];
    const qx = cx - d * n[0], qy = cy - d * n[1], qz = cz - d * n[2];
    // in-plane basis: u = n × (the axis least aligned with n), v = n × u
    const a: [number, number, number] = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = n[1] * a[2] - n[2] * a[1], uy = n[2] * a[0] - n[0] * a[2], uz = n[0] * a[1] - n[1] * a[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
    const out = new Float32Array(12);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    corners.forEach(([su, sv], k) => {
      const w = this._objToWorld(qx + (ux * su + vx * sv) * half, qy + (uy * su + vy * sv) * half, qz + (uz * su + vz * sv) * half, t.mesh);
      out[k * 3] = w.x; out[k * 3 + 1] = w.y; out[k * 3 + 2] = w.z;
    });
    return out;
  }

  /** A press on one of the plane handle's rings starts a rotation drag of the plane. */
  private _planeDown(e: PointerEvent, hitScale: number): boolean {
    if (!this._canvas || !this._meshId) return false;
    const t = this._planeTarget();
    const cam = this._scene3d.getCamera?.();
    if (!t || !cam || this._meshId !== this._planeHandle!.meshId) return false;
    this._rect = this._canvas.getBoundingClientRect();
    const at = this._toCanvasPx(e.clientX, e.clientY);
    const axis = this._gizmoHit(at.x, at.y, { center: t.centerW, rotation: t.rotation, mode: 'rotate' }, cam, hitScale);
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') return false;
    claimPointerEvent(e);
    try { this._canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this._planeDrag = {
      pointer: e.pointerId ?? 0, axis, meshId: this._planeHandle!.meshId, modIndex: this._planeHandle!.modIndex,
      startNormal: [t.normal[0], t.normal[1], t.normal[2]], rx: at.x, ry: at.y, cx: at.x, cy: at.y, touch: e.pointerType === 'touch',
    };
    this._planeMoved = false;
    this._planeHover = null;
    e.stopPropagation();
    this._canvas.style.cursor = 'grabbing';
    this._scheduleRender();
    return true;
  }

  /** Another press while the plane drags: a 2nd finger is a camera gesture — the drag is cancelled. */
  private _planeDragDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    const id = e.pointerId ?? 0;
    this._touchIds.add(id);
    if (id !== this._planeDrag!.pointer) this.cancelMirrorPlaneDrag();
  }

  private _planeDragMove(e: PointerEvent): void {
    const d = this._planeDrag!;
    if ((e.pointerId ?? 0) !== d.pointer) return;
    const at = this._toCanvasPx(e.clientX, e.clientY);
    d.cx = at.x; d.cy = at.y;
    if (this._planeFrame) return;
    let ran = false;
    const id = this._frame(() => { ran = true; this._planeFrame = 0; this._applyPlaneDrag(false); });
    if (!ran) this._planeFrame = id;
  }

  private _planeDragUp(e: PointerEvent): void {
    const d = this._planeDrag!;
    if (e.pointerType === 'touch') this._touchIds.delete(e.pointerId ?? 0);
    if ((e.pointerId ?? 0) !== d.pointer) return;
    if (this._planeFrame) { this._cancelFrame(this._planeFrame); this._planeFrame = 0; }
    const at = this._toCanvasPx(e.clientX, e.clientY);
    d.cx = at.x; d.cy = at.y;
    this._applyPlaneDrag(true);
    this._endPlaneDrag();
  }

  /** Cancel a plane rotation drag: the plane goes back exactly, no undo step. False when none runs. */
  cancelMirrorPlaneDrag(): boolean {
    if (!this._planeDrag) return false;
    if (this._planeFrame) { this._cancelFrame(this._planeFrame); this._planeFrame = 0; }
    if (this._planeMoved) this._meshEdit.cancelMirrorPlanePreview();
    this._endPlaneDrag();
    return true;
  }

  private _endPlaneDrag(): void {
    const d = this._planeDrag;
    this._planeDrag = null;
    this._planeMoved = false;
    if (d && this._canvas) { try { this._canvas.releasePointerCapture(d.pointer); } catch { /* gone */ } }
    if (this._canvas) this._canvas.style.cursor = 'crosshair';
    this._rect = null;
    this._scheduleRender();
    this._onSelectionChange?.();
  }

  /** The plane's normal for the drag so far: the start normal turned about the ring's object axis by the screen
   *  sweep (the gizmo rule: a ring facing the camera follows the pointer's angle around the pivot; edge-on, the drag
   *  distance). commit = the release: one undo step (none when it did not move). */
  private _applyPlaneDrag(commit: boolean): void {
    const d = this._planeDrag;
    const mesh = d ? this._scene3d.getMesh(d.meshId) : null;
    const cam = this._scene3d.getCamera?.();
    if (!d || !mesh?.editMesh || !this._canvas) return;
    const mod = mesh.editMesh.modifiers[d.modIndex];
    if (!(mod instanceof MirrorModifier)) return;
    const pl = mod.getPlane();
    let angle = 0;
    const ai = d.axis === 'x' ? 0 : d.axis === 'y' ? 1 : 2;
    if (cam && (d.cx !== d.rx || d.cy !== d.ry)) {
      const m = mesh.localMatrix as unknown as ArrayLike<number>;
      let axW: [number, number, number] = [m[ai * 4], m[ai * 4 + 1], m[ai * 4 + 2]];
      const al = Math.hypot(axW[0], axW[1], axW[2]) || 1;
      axW = [axW[0] / al, axW[1] / al, axW[2] / al];
      const cW = this._objToWorld(pl.point[0], pl.point[1], pl.point[2], mesh);
      const from = cam.mode === 'orthographic' ? cam.target : [cW.x, cW.y, cW.z];
      let tx = cam.position[0] - from[0], ty = cam.position[1] - from[1], tz = cam.position[2] - from[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const faceDot = axW[0] * tx + axW[1] * ty + axW[2] * tz;
      const c = this._projector(mesh, this._canvas.width, this._canvas.height)(pl.point[0], pl.point[1], pl.point[2]);
      if (Math.abs(faceDot) > 0.5 && c) {
        let sweep = Math.atan2(d.cy - c.y, d.cx - c.x) - Math.atan2(d.ry - c.y, d.rx - c.x);
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        angle = -Math.sign(faceDot) * sweep;
      } else {
        angle = ((d.cx - d.rx) + (d.cy - d.ry)) / 300 * Math.PI * 2;
      }
    }
    // Rodrigues: the start normal about object axis e_ai
    const n = d.startNormal, k: [number, number, number] = [ai === 0 ? 1 : 0, ai === 1 ? 1 : 0, ai === 2 ? 1 : 0];
    const cs = Math.cos(angle), sn = Math.sin(angle);
    const kxn = [k[1] * n[2] - k[2] * n[1], k[2] * n[0] - k[0] * n[2], k[0] * n[1] - k[1] * n[0]];
    const kd = k[0] * n[0] + k[1] * n[1] + k[2] * n[2];
    const normal: [number, number, number] = [0, 1, 2].map(i => n[i] * cs + kxn[i] * sn + k[i] * kd * (1 - cs)) as [number, number, number];
    if (!commit) {
      if (angle === 0 && !this._planeMoved) return;
      this._planeMoved = true;
      this._meshEdit.setMirrorPlane(d.meshId, d.modIndex, { normal }, { commit: false });
    } else if (this._planeMoved || angle !== 0) {
      this._meshEdit.setMirrorPlane(d.meshId, d.modIndex, { normal }, { commit: true });
    }
    this._scheduleRender();
  }

  // ── Picking API (sm.pickMeshEditElementAt3D) ────────────────────────────────

  /**
   * The vertex / edge / face (by the current selection mode) under client (CSS) point (clientX, clientY), whether it is
   * selected, or null (nothing within reach / not attached). Edges are half-edge indices (what selectEdge3D /
   * loopCut3D / setSharpEdges3D take). `touch` = the finger's ×2 vertex / edge radius.
   */
  pickElementAt(clientX: number, clientY: number, touch = false): MeshEditElementHit | null {
    if (!this._canvas || !this._meshId) return null;
    this._rect = null;
    this._pickScale = touch ? TOUCH_PICK_SCALE : 1;
    const at = this._toCanvasPx(clientX, clientY);
    const hit = this._elementAt(at.x, at.y);
    this._pickScale = 1;
    return hit ? { ...hit, selected: this._isSelected(hit.kind, hit.index) } : null;
  }

  /** The element (current mode) under canvas px. */
  private _elementAt(px: number, py: number): { kind: MeshEditSelectionMode; index: number } | null {
    const kind = this._mode;
    const index = kind === 'vertex' ? this._pickVertex(px, py) : kind === 'edge' ? this._pickEdge(px, py) : this._pickFace(px, py);
    return index >= 0 ? { kind, index } : null;
  }

  /** A vertex is selected when it is in the selection's vertex set; an edge when it (or its twin) is in the EDGE
   *  selection — never because both its ends are selected (Blender's edge mode: two selected edges A–B and C–D don't
   *  make B–C selected, so a tap on B–C adds it); a face when it is selected. */
  private _isSelected(kind: MeshEditSelectionMode, index: number): boolean {
    if (!this._meshId) return false;
    const sel = this._meshEdit.getSelection(this._meshId);
    const em = this._getMesh()?.editMesh;
    if (!sel || !em) return false;
    if (kind === 'vertex') return this._meshEdit.selectedVertexIndices(this._meshId).includes(index);
    if (kind === 'face') return sel.faces.has(index);
    const he = em.halfEdges[index];
    if (!he) return false;
    return sel.edges.has(index) || (he.twin >= 0 && sel.edges.has(he.twin));
  }

  /** Anything is selected on the edited mesh (skips the extra pick on a press when nothing is). */
  private _hasSelection(): boolean {
    const sel = this._meshId ? this._meshEdit.getSelection(this._meshId) : null;
    return !!sel && (sel.vertices.size > 0 || sel.edges.size > 0 || sel.faces.size > 0);
  }

  /** The element under canvas px is part of the selection (a drag from it moves the selection). */
  private _isSelectedAt(px: number, py: number): boolean {
    const hit = this._elementAt(px, py);
    return !!hit && this._isSelected(hit.kind, hit.index);
  }

  // ── Loop Cut tool ───────────────────────────────────────────────────────────

  private _scheduleLoopPreview(clientX: number, clientY: number): void {
    this._loopAt = { x: clientX, y: clientY };
    if (this._loopFrame) return;
    let ran = false;
    const id = this._frame(() => {
      ran = true;
      this._loopFrame = 0;
      const at = this._loopAt;
      this._loopAt = null;
      if (!at || !this._canvas || this._tool !== 'loopcut') return;
      if (!this._loopPress) this._rect = null;   // a hover reads the rect fresh
      this._pickScale = this._loopPress?.touch ? TOUCH_PICK_SCALE : 1;
      const c = this._toCanvasPx(at.x, at.y);
      this._loopPreviewAt(c.x, c.y);
    });
    if (!ran) this._loopFrame = id;
  }

  /**
   * Preview the loop under canvas px. A held press keeps the ring it started on and only SLIDES: the cut position is
   * the pointer's projection onto that edge. Otherwise (a hover / the press itself) the face under the pointer picks its
   * edge nearest the pointer (one that has a quad ring), the position again from the projection; off the faces, an edge
   * within the pick radius. Nothing there → no preview.
   */
  private _loopPreviewAt(px: number, py: number): void {
    const mesh = this._getMesh();
    const em = mesh?.editMesh ?? null;
    const prev = this._loopHover;
    let next: { he: number; em: EditMesh; pos: number; img: number } | null = null;
    if (mesh && em && this._loopPress && prev && prev.em === em) {
      const pos = this._loopEdgeParam(mesh, em, prev.he, prev.img, px, py);
      next = { ...prev, pos: pos ?? prev.pos };
    } else if (mesh && em) {
      next = this._loopEdgeAt(mesh, em, px, py);
    }
    if (prev?.he === next?.he && prev?.em === next?.em && prev?.pos === next?.pos) return;
    this._loopHover = next;
    this._scheduleRender();
  }

  /** The Loop Cut edge for canvas px: the face under it → its ring edge nearest px; else an edge in reach. */
  private _loopEdgeAt(mesh: Mesh3D, em: EditMesh, px: number, py: number): { he: number; em: EditMesh; pos: number; img: number } | null {
    const fi = this._pickFace(px, py);
    if (fi >= 0 && fi < em.faces.length) {
      const img = this._lastPickImg;
      const H = em.halfEdges;
      const start = em.faces[fi].halfEdge;
      const cands: Array<{ he: number; d: number; t: number }> = [];
      let he = start;
      for (let guard = 0; guard < 1024 && he >= 0; guard++) {
        const m = this._edgeScreenMeasure(mesh, em, he, img, px, py);
        if (m) cands.push({ he, d: m.d, t: m.t });
        he = H[he].next;
        if (he === start) break;
      }
      cands.sort((a, b) => a.d - b.d);
      for (const c of cands) if (em.loopRing(c.he).length > 0) return { he: c.he, em, pos: c.t, img };
      return null;
    }
    const hi = this._pickEdge(px, py);
    if (hi < 0 || em.loopRing(hi).length === 0) return null;
    const img = this._lastPickImg;
    return { he: hi, em, pos: this._loopEdgeParam(mesh, em, hi, img, px, py) ?? 0.5, img };
  }

  /** Canvas px → the fraction along half-edge `he` (from its start vertex; on mirror image `img`), clamped 0–1. */
  private _loopEdgeParam(mesh: Mesh3D, em: EditMesh, he: number, img: number, px: number, py: number): number | null {
    return this._edgeScreenMeasure(mesh, em, he, img, px, py)?.t ?? null;
  }

  /** Half-edge `he` on screen (mirror image `img`): the distance from canvas px to it and px's fraction along it. */
  private _edgeScreenMeasure(mesh: Mesh3D, em: EditMesh, he: number, img: number, px: number, py: number): { d: number; t: number } | null {
    if (!this._canvas) return null;
    const ends = em.getHalfEdgeVertices(he);
    if (!ends) return null;
    const planes = img ? this._mirrorPlanes() : [];
    const A = img && planes.length ? imageAffine(planes, img) : null;
    const project = this._projector(mesh, this._canvas.width, this._canvas.height);
    // clip w of a point (perspective: the screen fraction is turned into the fraction along the 3D edge)
    const vp = this._scene3d.getCamera?.()?.getViewProjectionMatrix?.() as Float32Array | undefined;
    const mvp = vp ? mat4.multiply(mat4.create(), vp as unknown as mat4, mesh.localMatrix as unknown as mat4) : null;
    const at = (vi: number): { x: number; y: number; w: number } | null => {
      const v = em.vertices[vi];
      const x = A ? A[0] * v.x + A[3] * v.y + A[6] * v.z + A[9] : v.x;
      const y = A ? A[1] * v.x + A[4] * v.y + A[7] * v.z + A[10] : v.y;
      const z = A ? A[2] * v.x + A[5] * v.y + A[8] * v.z + A[11] : v.z;
      const s = project(x, y, z);
      return s ? { x: s.x, y: s.y, w: mvp ? mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] : 1 } : null;
    };
    const a = at(ends[0]), b = at(ends[1]);
    if (!a || !b) return null;
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    const u = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / L2)) : 0.5;
    const d = Math.hypot(a.x + ex * u - px, a.y + ey * u - py);
    const den = (1 - u) / a.w + u / b.w;
    const t = a.w > 0 && b.w > 0 && den > 0 ? (u / b.w) / den : u;
    return { d, t: Math.max(0, Math.min(1, t)) };
  }

  /** A second finger / pointercancel / Esc during a Loop Cut press: nothing is cut. */
  private _loopDrop(): void {
    if (!this._loopPress) return;
    if (this._canvas && !this._loopPress.touch) { try { this._canvas.releasePointerCapture(this._loopPress.id); } catch { /* gone */ } }
    this._loopPress = null;
    this._loopHover = null;
    this._scheduleRender();
  }

  /** Esc while a Loop Cut press is held: drop it (nothing cut). False when there is none. */
  cancelLoopCutPress(): boolean {
    if (!this._loopPress) return false;
    this._loopDrop();
    return true;
  }

  /** Cut the loop through half-edge `he` with the tool's count at `position` (one undo step; the last op). */
  private _loopCut(he: number, position = this.loopCutPosition): boolean {
    if (!this._meshId || !this._canDragVertex()) return false;
    const ok = this._meshEdit.loopCuts(this._meshId, he, this.loopCutCount, position);
    this._loopHover = null;
    if (ok) { this._onSelectionChange?.(); this._scheduleRender(); }
    return ok;
  }

  // ── Knife tool ──────────────────────────────────────────────────────────────

  /** Knife points placed so far (0 when the knife has none / the mesh changed under them). */
  get knifePointCount(): number {
    const k = this._knife;
    if (!k) return 0;
    if (this._getMesh()?.editMesh !== k.em || this._meshId !== k.meshId) { this._knife = null; return 0; }
    return k.points.length;
  }

  /** Knife: add the surface point under canvas px (snapped onto a vertex / edge of the hit face within
   *  {@link KNIFE_SNAP_PX}). False when the ray misses the mesh. */
  knifeAddAt(px: number, py: number): boolean {
    const mesh = this._getMesh();
    const em = mesh?.editMesh;
    if (!mesh || !em || !this._canvas || !this._meshId || mesh instanceof SkinnedMesh3D) return false;
    if (this._knife && (this._knife.em !== em || this._knife.meshId !== this._meshId)) this._knife = null;
    const hit = this._raycastFace(mesh, px, py);
    if (!hit) return false;
    let p = hit.point;
    // snap onto a vertex / edge of the hit face (screen space)
    const project = this._projector(mesh, this._canvas.width, this._canvas.height);
    const fv = em.getFaceVertices(hit.face);
    const scr = fv.map(v => { const s = project(em.vertices[v].x, em.vertices[v].y, em.vertices[v].z); return s ? { x: s.x, y: s.y } : null; });
    const r = KNIFE_SNAP_PX * this._pickScale;
    let best = r, snapped: [number, number, number] | null = null;
    fv.forEach((v, k) => {
      const s = scr[k];
      if (!s) return;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d <= best) { best = d; const q = em.vertices[v]; snapped = [q.x, q.y, q.z]; }
    });
    if (!snapped) {
      best = r;
      for (let k = 0; k < fv.length; k++) {
        const a = scr[k], b = scr[(k + 1) % fv.length];
        if (!a || !b) continue;
        const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
        if (L2 <= 0) continue;
        const t = Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / L2));
        const d = Math.hypot(a.x + ex * t - px, a.y + ey * t - py);
        if (d <= best) {
          best = d;
          const A = em.vertices[fv[k]], B = em.vertices[fv[(k + 1) % fv.length]];
          snapped = [A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, A.z + (B.z - A.z) * t];
        }
      }
    }
    if (snapped) p = snapped;
    (this._knife ??= { meshId: this._meshId, em, points: [] }).points.push({ face: hit.face, x: p[0], y: p[1], z: p[2] });
    this._scheduleRender();
    this._onSelectionChange?.();
    return true;
  }

  /** Knife: cut along the placed points (≥ 2) — one undo step. Returns the number of faces split (0 = nothing cut).
   *  The points are dropped either way. */
  knifeApply(): number {
    const k = this._knife;
    this._knife = null;
    this._scheduleRender();
    const mesh = this._getMesh();
    if (!k || k.points.length < 2 || !mesh || mesh.editMesh !== k.em || this._meshId !== k.meshId) return 0;
    // the cutting planes contain the current view (eye / view direction), in object space
    const cam = this._scene3d.getCamera?.() ?? null;
    let eye: [number, number, number] | null = null, viewDir: [number, number, number] | null = null;
    const inv = mat4.invert(mat4.create(), mesh.localMatrix as unknown as mat4);
    if (cam && inv) {
      if (cam.mode === 'orthographic') {
        const d = vec4.transformMat4(vec4.create(), vec4.fromValues(cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2], 0), inv);
        viewDir = [d[0], d[1], d[2]];
      } else {
        const e = vec4.transformMat4(vec4.create(), vec4.fromValues(cam.position[0], cam.position[1], cam.position[2], 1), inv);
        eye = [e[0] / e[3], e[1] / e[3], e[2] / e[3]];
      }
    }
    const n = this._meshEdit.knifePath(k.meshId, k.points, { eye, viewDir });
    if (n > 0) this._onSelectionChange?.();
    return n;
  }

  /** Knife: drop the placed points (nothing cut). */
  knifeCancel(): void {
    if (!this._knife) return;
    this._knife = null;
    this._scheduleRender();
    this._onSelectionChange?.();
  }

  /** The nearest edit-mesh face under canvas px and the object-space hit point (planar faces; null = a miss). */
  private _raycastFace(mesh: Mesh3D, px: number, py: number): { face: number; point: [number, number, number] } | null {
    const em = mesh.editMesh, cam = this._scene3d.getCamera?.();
    if (!em || !cam || !this._canvas) return null;
    const ray = screenRay(cam.getViewProjectionMatrix() as unknown as mat4, px, py, this._canvas.width, this._canvas.height);
    const inv = mat4.invert(mat4.create(), mesh.localMatrix as unknown as mat4);
    if (!ray || !inv) return null;
    const o4 = vec4.transformMat4(vec4.create(), vec4.fromValues(ray.origin[0], ray.origin[1], ray.origin[2], 1), inv);
    const d4 = vec4.transformMat4(vec4.create(), vec4.fromValues(ray.dir[0], ray.dir[1], ray.dir[2], 0), inv);
    const o = [o4[0] / o4[3], o4[1] / o4[3], o4[2] / o4[3]], d = [d4[0], d4[1], d4[2]];
    let best: { face: number; point: [number, number, number]; t: number } | null = null;
    for (let fi = 0; fi < em.faces.length; fi++) {
      const fv = em.getFaceVertices(fi);
      if (fv.length < 3) continue;
      const P = fv.map(v => em.vertices[v]);
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < P.length; k++) {
        const a = P[k], b = P[(k + 1) % P.length];
        nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
      }
      const denom = nx * d[0] + ny * d[1] + nz * d[2];
      if (Math.abs(denom) < 1e-18) continue;
      const t = (nx * (P[0].x - o[0]) + ny * (P[0].y - o[1]) + nz * (P[0].z - o[2])) / denom;
      if (!(t > 0) || (best && t >= best.t)) continue;
      const hx = o[0] + d[0] * t, hy = o[1] + d[1] * t, hz = o[2] + d[2] * t;
      // point in polygon, in the plane of the two axes the normal is least aligned with
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const U = (p: { x: number; y: number; z: number }) => (ax >= ay && ax >= az ? p.y : p.x);
      const V = (p: { x: number; y: number; z: number }) => (az >= ax && az >= ay ? p.y : p.z);
      const hu = U({ x: hx, y: hy, z: hz }), hv = V({ x: hx, y: hy, z: hz });
      let inside = false;
      for (let k = 0, j = P.length - 1; k < P.length; j = k++) {
        const uk = U(P[k]), vk = V(P[k]), uj = U(P[j]), vj = V(P[j]);
        if ((vk > hv) !== (vj > hv) && hu < ((uj - uk) * (hv - vk)) / (vj - vk) + uk) inside = !inside;
      }
      if (inside) best = { face: fi, point: [hx, hy, hz], t };
    }
    return best ? { face: best.face, point: best.point } : null;
  }

  // ── Overlay lines: Chamfer guides + Knife path + Loop Cut preview ───────────

  /** Every tool line for the edit overlay (MeshEditDrawData.guides): world-space xyz pairs, or null. */
  guideLines(): Float32Array | null {
    const parts: ArrayLike<number>[] = [];
    const bev = this.bevel.guideLines();
    if (bev) parts.push(bev);
    const mesh = this._getMesh();
    const m = mesh?.localMatrix as unknown as ArrayLike<number> | undefined;
    const toW = (x: number, y: number, z: number, out: number[]): void => {
      out.push(m![0] * x + m![4] * y + m![8] * z + m![12], m![1] * x + m![5] * y + m![9] * z + m![13], m![2] * x + m![6] * y + m![10] * z + m![14]);
    };
    if (mesh && m && this._tool === 'knife' && this.knifePointCount > 0) {
      const pts = this._knife!.points, out: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) { toW(pts[i].x, pts[i].y, pts[i].z, out); toW(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z, out); }
      // a small cross on every point (screen-constant size)
      const cam = this._scene3d.getCamera?.();
      for (const p of pts) {
        const w: number[] = []; toW(p.x, p.y, p.z, w);
        const s = cam ? GizmoRenderer.computeGizmoScale(cam, w as unknown as [number, number, number]) * 0.06 : 0.02;
        for (const ax of [[s, 0, 0], [0, s, 0], [0, 0, s]]) out.push(w[0] - ax[0], w[1] - ax[1], w[2] - ax[2], w[0] + ax[0], w[1] + ax[1], w[2] + ax[2]);
      }
      if (out.length) parts.push(out);
    }
    const h = this._loopHover;
    if (mesh && m && this._tool === 'loopcut' && h && h.em === mesh.editMesh) {
      const seg = h.em.loopCutPreview(h.he, this.loopCutCount, h.pos), out: number[] = [];
      for (let i = 0; i + 2 < seg.length; i += 3) toW(seg[i], seg[i + 1], seg[i + 2], out);
      if (out.length) parts.push(out);
    }
    if (parts.length === 0) return null;
    if (parts.length === 1 && parts[0] instanceof Float32Array) return parts[0];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const res = new Float32Array(total);
    let o = 0;
    for (const p of parts) { res.set(p, o); o += p.length; }
    return res;
  }

  // ── Selection + drag ────────────────────────────────────────────────────────

  /** Select the vertex / face / edge at canvas px (x, y) (mouse press, or a finger tap). `toggle` (a RELEASE without a
   *  drag): an additive pick of an already-selected element removes it instead. A pick on a mirror's copy side is
   *  already its real partner (the pickers map it). */
  private _selectAt(px: number, py: number, additive: boolean, toggle = false): void {
    const meshId = this._meshId;
    if (!meshId) return;
    const off = additive && toggle;
    let hit = false;
    // Live op preview: resolve the tap against the mesh BEFORE the op, then re-run the op on the new selection
    if (this.opPreview && this._mode === 'face' && this._meshEdit.revertLastFaceOpForRetarget(meshId)) {
      const fi = this._pickFace(px, py);
      if (fi >= 0 && !(off && this._meshEdit.deselectFace(meshId, fi))) this._meshEdit.selectFace(meshId, fi, additive);
      this._meshEdit.rerunLastOpOnSelection(meshId);
      this._onSelectionChange?.();
      this._scheduleRender();
      return;
    }
    if (this._mode === 'face') {
      const fi = this._pickFace(px, py);
      if (fi >= 0) { hit = true; if (!(off && this._meshEdit.deselectFace(meshId, fi))) this._meshEdit.selectFace(meshId, fi, additive); }
    } else if (this._mode === 'vertex') {
      const vi = this._pickVertex(px, py);
      if (vi >= 0) { hit = true; if (!(off && this._meshEdit.deselectVertex(meshId, vi))) this._meshEdit.selectVertex(meshId, vi, additive); }
    } else if (this._mode === 'edge') {
      const hi = this._pickEdge(px, py);
      if (hi >= 0) { hit = true; if (!(off && this._meshEdit.deselectEdge(meshId, hi))) this._meshEdit.selectEdge(meshId, hi, additive); }
    }
    if (hit) {
      this._onSelectionChange?.();
      this._scheduleRender();
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
    // picked on a mirror's copy side (the last pick): the drag runs at the IMAGE's depth, through its reflection
    const planes = this._lastPickImg ? this._mirrorPlanes() : [];
    const A = this._lastPickImg && planes.length ? imageAffine(planes, this._lastPickImg) : null;
    this._dragImage = A;
    const ix = A ? A[0] * v.x + A[3] * v.y + A[6] * v.z + A[9] : v.x;
    const iy = A ? A[1] * v.x + A[4] * v.y + A[7] * v.z + A[10] : v.y;
    const iz = A ? A[2] * v.x + A[5] * v.y + A[8] * v.z + A[11] : v.z;
    const w = this._objToWorld(ix, iy, iz, mesh);
    const s = this._scene3d.projectWorldToScreen3D(w.x, w.y, w.z, this._canvas.width, this._canvas.height);
    this._dragging = true;
    this._dragVertexIdx = vi;
    this._dragStartCanvasX = px;
    this._dragStartCanvasY = py;
    this._dragDepth = s?.depth ?? 0.5;
    this._dragSnapshot = mesh.editMesh.toJSON();
    this._dragHadCustomNormals = typeof mesh.editMesh.hasCustomNormals === 'function' && mesh.editMesh.hasCustomNormals();
    this._dragStartObjPos = { x: v.x, y: v.y, z: v.z };
    this._dragStartVerts = mesh.editMesh.vertices.map(vt => ({ x: vt.x, y: vt.y, z: vt.z }));
    this._dragApplied = false;
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
    let delta = this._worldDeltaToObj(wNow.x - wStart.x, wNow.y - wStart.y, wNow.z - wStart.z, mesh);
    const A = this._dragImage;
    if (A) {
      // through the mirror's copy: image → real = Lᵀ (reflections are orthogonal)
      const { x, y, z } = delta;
      delta = { x: A[0] * x + A[1] * y + A[2] * z, y: A[3] * x + A[4] * y + A[5] * z, z: A[6] * x + A[7] * y + A[8] * z };
    }

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
    this._dragApplied = true;
    this._syncDragGeometry(mesh);
    this._scheduleRender();
  }

  /** True when the vertex drag moved any vertex off its drag-start position (else its release pushes no undo step). */
  private _dragMovedAny(em: EditMesh): boolean {
    const start = this._dragStartVerts;
    if (!start || start.length !== em.vertices.length) return true;
    const v = em.vertices;
    for (let i = 0; i < v.length; i++) if (v[i].x !== start[i].x || v[i].y !== start[i].y || v[i].z !== start[i].z) return true;
    return false;
  }

  /** mobile-parity 7.3d: bring the GPU mesh in line with a drag frame. Topology is unchanged mid-drag, so the moved
   *  vertices' triangles are rewritten in place (Mesh3D.patchFromEditMesh: positions + flat normals / tangents, the
   *  same bits a recompile writes) and only those vertex spans are re-sent (writeBuffer into the mesh's pool range).
   *  Falls back to the full recompile (syncFromEditMesh) whenever the patch does not apply; a span the renderer cannot
   *  take (mesh not resident yet / shared pool geometry) marks gpuDirty, which re-uploads from the patched CPU copy. */
  private _syncDragGeometry(mesh: Mesh3D): void {
    const spans = typeof mesh.patchFromEditMesh === 'function' ? mesh.patchFromEditMesh() : null;
    if (!spans) { mesh.syncFromEditMesh(); this.dragStats.fullSyncs++; this._dragPatched = false; return; }
    this.dragStats.patches++;
    if (spans.length === 0) return;
    this._dragPatched = true;
    // (only a mesh with its OWN pool geometry is patched in the pool — a shared key would rewrite other meshes too)
    let ok = mesh.geometryKey === `custom:${mesh.id}` && typeof this._scene3d.patchMeshVertices3D === 'function';
    for (let i = 0; ok && i < spans.length; i += 2) {
      if (!this._scene3d.patchMeshVertices3D(mesh, spans[i], spans[i + 1])) { ok = false; break; }
      this.dragStats.spans++;
      this.dragStats.uploadVerts += spans[i + 1];
      this.dragStats.uploadBytes += spans[i + 1] * 48;
    }
    // A quad whose diagonal flipped this frame (concave drag) rewrote its index range in place: re-send it too.
    const idx = mesh.editMesh?.lastPatchIndexSpans ?? [];
    for (let i = 0; ok && i < idx.length; i += 2) {
      if (typeof this._scene3d.patchMeshIndices3D !== 'function' || !this._scene3d.patchMeshIndices3D(mesh, idx[i], idx[i + 1])) { ok = false; break; }
      this.dragStats.indexSpans++;
      this.dragStats.uploadBytes += idx[i + 1] * 4;
    }
    if (ok) this._scene3d.noteMeshVerticesMoved3D?.(mesh);
    else { mesh.gpuDirty = true; this.dragStats.gpuDirty++; }
  }

  /** End of a drag that patched the geometry in place: one full recompile, so everything keyed on a geometry change
   *  (the scene picker's BVH, bounds, autosave dirtiness, …) sees the final shape exactly as before 7.3d. */
  private _finishPatchedDrag(): void {
    if (!this._dragPatched) return;
    this._dragPatched = false;
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return;
    mesh.syncFromEditMesh();
    this.dragStats.fullSyncs++;
  }

  /** Abort an in-flight vertex drag: every vertex back to its drag-start position, and (for a finger drag) the
   *  selection as it was before the press. No undo entry. */
  private _cancelDrag(): void {
    if (this._dragFrame) { this._cancelFrame(this._dragFrame); this._dragFrame = 0; }
    this._dragAt = null;
    if (this._dragging && this._dragStartVerts) {
      const mesh = this._getMesh();
      if (mesh?.editMesh) {
        if (this._dragHadCustomNormals && this._dragSnapshot) {
          // the drag recomputed (cleared) custom normals around the moved vertices: the snapshot puts them back exactly
          mesh.editMesh = EditMesh.fromJSON(this._dragSnapshot);
        } else {
          const verts = mesh.editMesh.vertices, start = this._dragStartVerts;
          for (let i = 0; i < verts.length && i < start.length; i++) { verts[i].x = start[i].x; verts[i].y = start[i].y; verts[i].z = start[i].z; }
        }
        mesh.syncFromEditMesh();
        this.dragStats.fullSyncs++;
      }
      this._dragPatched = false;
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
    if (this._bevelFrame) { this._cancelFrame(this._bevelFrame); this._bevelFrame = 0; }
    this._bevelAt = null;
    this._bevelPointer = null;
    this._bevelPending = null;
    if (this._hoverFrame) { this._cancelFrame(this._hoverFrame); this._hoverFrame = 0; }
    if (this._loopFrame) { this._cancelFrame(this._loopFrame); this._loopFrame = 0; }
    this._loopAt = null;
    this._dropXfFrame();
    this._dragAt = null;
    this._hoverAt = null;
  }

  private _isAdditive(): boolean {
    try { return !!this._opts.isAdditive?.(); } catch { return false; }
  }

  // ── Picking ─────────────────────────────────────────────────────────────────

  /** The face under canvas px: the ray is cast at the EDIT MESH only (own BVH), then the face whose world-space centre
   *  is nearest the hit (a grid, not a scan of every face) — see mesh-edit-face-pick.ts. Without a camera / geometry
   *  (test doubles) the pre-7.3d full-scene pick + scan runs instead. */
  private _pickFace(px: number, py: number): number {
    if (!this._canvas || !this._meshId) return -1;
    const mesh = this._getMesh();
    const camera = this._scene3d.getCamera?.();
    this._lastPickImg = 0;
    const mirror = mesh?.editMesh ? this._facePickMirror(mesh) : null;
    if (mesh?.editMesh && camera && mesh.geometry) {
      return this._facePicker.pick(mesh, camera, px, py, this._canvas.width, this._canvas.height, mirror);
    }
    return pickFaceFullScene(this._scene3d, this._meshId, mesh, px, py, this._canvas.width, this._canvas.height, mirror);
  }

  /** Mirror support for a face pick: a hit on the copy side maps to the partner face (reflected back to the real side
   *  — the last pick's image is remembered), and faces entirely on the discarded side can't be picked. Null = no plane
   *  mirror. */
  private _facePickMirror(mesh: Mesh3D): FacePickMirror | null {
    const em = mesh.editMesh!;
    const planes = mirrorPlanesOf(em);
    if (planes.length === 0) return null;
    const m = mesh.localMatrix as unknown as ArrayLike<number>;
    const inv = mat4.invert(mat4.create(), mesh.localMatrix as unknown as mat4);
    if (!inv) return null;
    const skip = new Uint8Array(em.faces.length);
    const pts: number[] = [];
    for (let fi = 0; fi < em.faces.length; fi++) {
      pts.length = 0;
      for (const vi of em.getFaceVertices(fi)) { const v = em.vertices[vi]; pts.push(v.x, v.y, v.z); }
      let any = false;
      if (pts.length >= 9) forEachPolygonImage(planes, pts, () => { any = true; });
      if (!any) skip[fi] = 1;
    }
    const mapHit = (hx: number, hy: number, hz: number): [number, number, number] => {
      const ox = inv[0] * hx + inv[4] * hy + inv[8] * hz + inv[12];
      const oy = inv[1] * hx + inv[5] * hy + inv[9] * hz + inv[13];
      const oz = inv[2] * hx + inv[6] * hy + inv[10] * hz + inv[14];
      const r = toRealSide(planes, ox, oy, oz);
      this._lastPickImg = r.img;
      return [
        m[0] * r.x + m[4] * r.y + m[8] * r.z + m[12],
        m[1] * r.x + m[5] * r.y + m[9] * r.z + m[13],
        m[2] * r.x + m[6] * r.y + m[10] * r.z + m[14],
      ];
    };
    return { mapHit, skip };
  }

  /** The edited mesh's plane mirrors (stack order; none = no bisect / face mirror). */
  private _mirrorPlanes(): MirrorPlane[] {
    return mirrorPlanesOf(this._getMesh()?.editMesh);
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

    let best = -1, bestDist = VERTEX_PICK_RADIUS_PX * this._pickScale, bestImg = 0;
    const planes = mirrorPlanesOf(mesh.editMesh);
    if (planes.length > 0) {
      // a plane mirror: every vertex at its real place (if kept) and its reflections — a copy picks its partner
      for (let vi = 0; vi < verts.length; vi++) {
        const v = verts[vi];
        forEachPointImage(planes, v.x, v.y, v.z, (x, y, z, img) => {
          const s = project(x, y, z);
          if (!s) return;
          const d = Math.sqrt((s.x - px) ** 2 + (s.y - py) ** 2);
          if (d < bestDist) { bestDist = d; best = vi; bestImg = img; }
        });
      }
      this._lastPickImg = best >= 0 ? bestImg : 0;
      return best;
    }
    for (let vi = 0; vi < verts.length; vi++) {
      const v = verts[vi];
      const s = project(v.x, v.y, v.z);
      if (!s) continue;
      const d = Math.sqrt((s.x - px) ** 2 + (s.y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = vi; }
    }
    this._lastPickImg = 0;
    return best;
  }

  /**
   * The edge under canvas px (a half-edge index, one per edge): the nearest projected SEGMENT (clamped point-to-segment
   * distance, so a tap anywhere along the edge reaches it — it used to measure to the midpoint only) within the pick
   * radius. An edge with a face toward the camera wins over one whose every face looks away (the far side of a closed
   * mesh); such a hidden edge is picked only when no facing edge is in reach AND the surface under the pointer isn't in
   * front of it (an open sheet seen from the back keeps its edges). A plane mirror's copies count too — a copy picks its
   * real partner (the image is remembered, as for vertices / faces).
   */
  private _pickEdge(px: number, py: number): number {
    if (!this._canvas) return -1;
    const mesh = this._getMesh();
    if (!mesh?.editMesh) return -1;
    const em = mesh.editMesh;
    const project = this._projector(mesh, this._canvas.width, this._canvas.height);
    const view = this._objectView(mesh);
    const R = EDGE_PICK_RADIUS_PX * this._pickScale;

    let best = -1, bestDist = R, bestImg = 0;
    let back: { hi: number; img: number; d: number; q: [number, number, number] } | null = null;
    const planes = mirrorPlanesOf(em);
    const consider = (hi: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, img: number): void => {
      const sa = project(ax, ay, az);
      if (!sa) return;
      const x0 = sa.x, y0 = sa.y;   // (copied first: the projector reuses its result object)
      const sb = project(bx, by, bz);
      if (!sb) return;
      const ex = sb.x - x0, ey = sb.y - y0, L2 = ex * ex + ey * ey;
      const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - x0) * ex + (py - y0) * ey) / L2)) : 0.5;
      const d = Math.hypot(x0 + ex * t - px, y0 + ey * t - py);
      if (d >= R) return;
      if (this._edgeFacesCamera(em, hi, img, planes, view)) {
        if (d < bestDist) { bestDist = d; best = hi; bestImg = img; }
      } else if (!back || d < back.d) {
        back = { hi, img, d, q: [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t] };
      }
    };
    for (let hi = 0; hi < em.halfEdges.length; hi++) {
      const he = em.halfEdges[hi];
      // Skip one half of each pair (avoid duplicate checks)
      if (he.twin >= 0 && he.twin < hi) continue;
      const vTo   = em.vertices[he.vertex];
      const vFrom = em.vertices[em.halfEdges[he.prev].vertex];
      if (planes.length > 0) {
        // a plane mirror: the edge's real (clipped) part and its reflections — a copy picks its partner
        forEachSegmentImage(planes, vFrom.x, vFrom.y, vFrom.z, vTo.x, vTo.y, vTo.z, (ax, ay, az, bx, by, bz, img) => consider(hi, ax, ay, az, bx, by, bz, img));
        continue;
      }
      consider(hi, vFrom.x, vFrom.y, vFrom.z, vTo.x, vTo.y, vTo.z, 0);
    }
    const b = back as { hi: number; img: number; d: number; q: [number, number, number] } | null;
    if (best < 0 && b && !this._occludedEdgePoint(mesh, em, b.hi, b.q, px, py, view)) { best = b.hi; bestImg = b.img; }
    this._lastPickImg = best >= 0 ? bestImg : 0;
    return best;
  }

  /** The camera in the mesh's object space: the eye, the view direction (eye → target, unit) and ortho / perspective.
   *  Null without a camera (test doubles): every edge then counts as facing. */
  private _objectView(mesh: Mesh3D): { eye: [number, number, number]; dir: [number, number, number]; ortho: boolean } | null {
    const cam = this._scene3d.getCamera?.();
    if (!cam?.position || !cam.target) return null;
    const inv = mat4.invert(mat4.create(), mesh.localMatrix as unknown as mat4);
    if (!inv) return null;
    const p = cam.position, t = cam.target;
    const e = vec4.transformMat4(vec4.create(), vec4.fromValues(p[0], p[1], p[2], 1), inv);
    const d = vec4.transformMat4(vec4.create(), vec4.fromValues(t[0] - p[0], t[1] - p[1], t[2] - p[2], 0), inv);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0) || Math.abs(e[3]) < 1e-12) return null;
    return { eye: [e[0] / e[3], e[1] / e[3], e[2] / e[3]], dir: [d[0] / len, d[1] / len, d[2] / len], ortho: cam.mode === 'orthographic' };
  }

  /** Edge `hi` (on mirror image `img`) has an adjacent face turned toward the camera — or no face at all (a wire edge),
   *  or no camera to tell. */
  private _edgeFacesCamera(em: EditMesh, hi: number, img: number, planes: MirrorPlane[], view: ReturnType<MeshEditPointerController['_objectView']>): boolean {
    if (!view) return true;
    const H = em.halfEdges, he = H[hi];
    const faces = [he.face, he.twin >= 0 ? H[he.twin].face : -1].filter(f => f >= 0 && f < em.faces.length);
    if (faces.length === 0) return true;
    const A = img && planes.length ? imageAffine(planes, img) : null;
    for (const f of faces) {
      let [nx, ny, nz] = em.getFaceNormal(f);
      let [cx, cy, cz] = em.getFaceCenter(f);
      if (A) {
        // the copy's face: reflected centre + normal (the copy is drawn with its winding flipped back outward)
        const n0 = nx, n1 = ny, n2 = nz, c0 = cx, c1 = cy, c2 = cz;
        nx = A[0] * n0 + A[3] * n1 + A[6] * n2; ny = A[1] * n0 + A[4] * n1 + A[7] * n2; nz = A[2] * n0 + A[5] * n1 + A[8] * n2;
        cx = A[0] * c0 + A[3] * c1 + A[6] * c2 + A[9]; cy = A[1] * c0 + A[4] * c1 + A[7] * c2 + A[10]; cz = A[2] * c0 + A[5] * c1 + A[8] * c2 + A[11];
      }
      const vx = view.ortho ? view.dir[0] : cx - view.eye[0];
      const vy = view.ortho ? view.dir[1] : cy - view.eye[1];
      const vz = view.ortho ? view.dir[2] : cz - view.eye[2];
      if (nx * vx + ny * vy + nz * vz < 0) return true;
    }
    return false;
  }

  /** The surface under canvas px lies in front of object-space point `q` on edge `hi` (a face that isn't one of the
   *  edge's own is hit nearer the camera): the hidden edge is behind the mesh there. */
  private _occludedEdgePoint(mesh: Mesh3D, em: EditMesh, hi: number, q: [number, number, number], px: number, py: number,
    view: ReturnType<MeshEditPointerController['_objectView']>): boolean {
    if (!view) return false;
    const hit = this._raycastFace(mesh, px, py);
    if (!hit) return false;
    const H = em.halfEdges, he = H[hi];
    if (hit.face === he.face || (he.twin >= 0 && hit.face === H[he.twin].face)) return false;
    const depth = (p: ArrayLike<number>): number => (p[0] - view.eye[0]) * view.dir[0] + (p[1] - view.eye[1]) * view.dir[1] + (p[2] - view.eye[2]) * view.dir[2];
    const dq = depth(q);
    return depth(hit.point) < dq - (1e-4 + 1e-3 * Math.abs(dq));
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

/** The edit mesh's plane mirrors ([] for none / a test double without the method). */
function mirrorPlanesOf(em: EditMesh | null | undefined): MirrorPlane[] {
  return em && typeof em.mirrorPlanes === 'function' ? em.mirrorPlanes() : [];
}

/** The world ray through canvas px (x, y) of a w × h canvas (near-plane origin, unit direction), or null. */
function screenRay(vp: mat4, x: number, y: number, w: number, h: number): { origin: [number, number, number]; dir: [number, number, number] } | null {
  const inv = mat4.invert(mat4.create(), vp);
  if (!inv) return null;
  const nx = (2 * x) / w - 1, ny = 1 - (2 * y) / h;
  const at = (z: number): [number, number, number] | null => {
    const p = vec4.transformMat4(vec4.create(), vec4.fromValues(nx, ny, z, 1), inv);
    return Math.abs(p[3]) < 1e-12 ? null : [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
  };
  const o = at(0), f = at(1);
  if (!o || !f) return null;
  const dx = f[0] - o[0], dy = f[1] - o[1], dz = f[2] - o[2], len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) return null;
  return { origin: o, dir: [dx / len, dy / len, dz / len] };
}
