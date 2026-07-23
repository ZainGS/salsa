/**
 * TransformController3D — Handles 3D mesh picking, selection, and gizmo dragging.
 *
 * Attach to a canvas element to get:
 *  - Click-to-select: picks the front-most mesh under the mouse
 *  - Gizmo drag: moves/rotates/scales selected meshes along the hovered axis/plane
 *  - Hover highlight: updates the gizmo's hovered axis for visual feedback
 *  - Orbit coordination: disables the orbit controller while a gizmo drag is active
 *
 * Usage:
 *   const tc = new TransformController3D(callbacks);
 *   tc.attach(canvas, orbitController);
 *   // ... later
 *   tc.detach();
 */

import { mat4, vec3, vec4, quat } from 'gl-matrix';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { GizmoRenderer, GizmoAxis, GizmoMode, ArrayGizmoData, ArrayHandleHit } from '../../renderer/3d/gizmo-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { OrbitController } from '../../renderer/3d/orbit-controller';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

// ── Types ─────────────────────────────────────────────────────────

/** Controls what Ctrl+drag snaps to during a move operation. */
export type SnapMode = 'none' | 'grid' | 'vertex';

/**
 * Vertex-snap visualization (the double-circle UX). World-space positions so the host projects them
 * itself (like the existing snap dot). Draw two circles at `centerWorld` (radii innerPx/outerPx) and
 * a square at each candidate — `active` is the one that will snap (front-most); fade the rest by `depthT`.
 */
export interface SnapVizData {
  centerWorld: [number, number, number];
  innerPx: number;
  outerPx: number;
  candidates: { world: [number, number, number]; depthT: number; active: boolean }[];
}

type TransformSnapshot = {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
};

export interface TransformControllerCallbacks {
  getMeshes(): Mesh3D[];
  getCamera(): Camera3D;
  getCanvasSize(): { width: number; height: number };
  getSelectedIds(): Set<string>;
  setSelectedIds(ids: Set<string>): void;
  scheduleRender(): void;
  getOrbitController?(): OrbitController | undefined;
  /** Called after a gizmo drag completes with before/after snapshots for undo. */
  onTransformComplete?(
    before: Map<string, TransformSnapshot>,
    after: Map<string, TransformSnapshot>,
  ): void;
  /** Called when a gizmo drag begins (for visual feedback). */
  onGizmoDragStart?(axis: GizmoAxis): void;
  /** Called when a gizmo drag ends. */
  onGizmoDragEnd?(): void;
  /** Called after a drag completes with the IDs of all moved meshes, so callers can
   *  invalidate any per-mesh cached state that depends on position (e.g. FLA rest poses). */
  onTransformDone?(meshIds: string[]): void;
  /**
   * Return true while a mesh is in edit mode (vertex/face/edge editing).
   * When true, click-to-select is suppressed so the MeshEditPointerController
   * can handle picks without the object-selection path overriding it.
   */
  isInMeshEditMode?(): boolean;
  /**
   * Return true while the bone overlay is active (Armature panel is open with a
   * skeleton selected). When true, mesh click-to-select and gizmo axis hover are
   * both suppressed — viewport clicks belong to the bone interaction handlers.
   */
  isBoneOverlayActive?(): boolean;
  /**
   * Return true if click-to-select must IGNORE a pick landing on this mesh (the event still
   * propagates — e.g. to an armed surface-paint handler). Package-Creator mode suppresses its
   * target package's panels here so a paint stroke never selects the box as a unit. Unlike
   * isInMeshEditMode this is PER-MESH: clicks on other meshes / empty space behave normally.
   */
  isPickSuppressed?(meshId: string): boolean;
  /** Return the current ArrayGizmoData if an array group is selected, else null. */
  getArrayGizmoData?(): ArrayGizmoData | null;
  /** Called on every pointermove while dragging the X spacing handle (linear + grid). */
  onArraySpacingDrag?(groupId: string, newSpacing: [number, number, number]): void;
  /** Called on pointerup after an X spacing drag — push undo here. */
  onArraySpacingCommit?(groupId: string, oldSpacing: [number, number, number], newSpacing: [number, number, number]): void;
  /** Called on every pointermove while dragging the Y spacing handle (grid only). */
  onArraySpacingYDrag?(groupId: string, newSpacing: [number, number, number]): void;
  /** Called on pointerup after a Y spacing drag — push undo here. */
  onArraySpacingYCommit?(groupId: string, oldSpacing: [number, number, number], newSpacing: [number, number, number]): void;
  /** Called on every pointermove while dragging the radial radius handle. */
  onArrayRadiusDrag?(groupId: string, newRadius: number): void;
  /** Called on pointerup after a radial radius drag — push undo here. */
  onArrayRadiusCommit?(groupId: string, oldRadius: number, newRadius: number): void;
  /** Called when array handle hover state changes. */
  onArrayHandleHoverChange?(hovered: ArrayHandleHit): void;
  /**
   * Called when regular mesh picking finds no hit. Return a node ID to select it
   * (e.g. a GPU-instanced array group hit via ray-AABB), or null to deselect.
   */
  pickAdditional?(x: number, y: number, w: number, h: number): string | null;
}

// ── Corner drag data ────────────────────────────────────────────────

interface CornerDragData {
  /** World position of the opposite (anchor) corner — held fixed during drag */
  anchorWorld: vec3;
  /** Geometry-space position of the anchor corner */
  anchorGeom: [number, number, number];
  /** Geometry-space position of the dragged corner */
  draggedGeom: [number, number, number];
  /** World position of the dragged corner at drag start (defines the drag plane) */
  dragPlaneOrigin: vec3;
  /** Unit world-space local axes captured at drag start (rotation unchanged during drag) */
  r0: vec3; r1: vec3; r2: vec3;
}

// ── Drag state ─────────────────────────────────────────────────────

interface DragState {
  axis: GizmoAxis;
  mode: GizmoMode;
  /** Canvas X at drag start */
  startX: number;
  /** Canvas Y at drag start */
  startY: number;
  /** World-space gizmo center at drag start */
  gizmoCenter: vec3;
  /** Per-mesh snapshot of transforms at drag start */
  initialTransforms: Map<string, {
    x: number; y: number; z: number;
    rx: number; ry: number; rz: number;
    sx: number; sy: number; sz: number;
  }>;
  /**
   * The world-space "drag plane" hit point at drag start.
   * Used to compute deltas for move operations.
   */
  planePt: vec3 | null;
  /** Per-mesh local rotation axis in world space at drag start (rotate mode only) */
  localAxes?: Map<string, vec3>;
  /** Per-mesh initial quaternion from Euler Y→X→Z at drag start (rotate mode only) */
  initialQuats?: Map<string, quat>;
  /** Corner index (0-7) if this is a corner scale drag; undefined for gizmo axis drags */
  cornerIndex?: number;
  /** Per-mesh corner drag data (only set when cornerIndex is defined) */
  cornerData?: Map<string, CornerDragData>;
  /** Local-space axis directions captured at drag start; only set in local orientation mode. */
  localBasis?: { x: vec3; y: vec3; z: vec3 };
}

// ── Shortcut state ─────────────────────────────────────────────────

interface ShortcutState {
  mode: 'grab' | 'rotate' | 'scale';
  axis: 'x' | 'y' | 'z' | null;
  numericChars: string;
  snapshot: Map<string, TransformSnapshot>;
}

// ── Screen-space projection helper ────────────────────────────────

function worldToScreen(
  pt: vec3,
  vp: mat4,
  w: number,
  h: number,
): [number, number] | null {
  const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(pt[0], pt[1], pt[2], 1), vp);
  if (Math.abs(clip[3]) < 1e-6) return null;
  const nx = clip[0] / clip[3];
  const ny = clip[1] / clip[3];
  // NDC (-1,-1) = bottom-left; screen (0,0) = top-left
  return [(nx + 1) * 0.5 * w, (1 - ny) * 0.5 * h];
}

// ── Euler / quaternion helpers (Y→X→Z intrinsic = matrix Ry*Rx*Rz) ──

function eulerYXZtoQuat(ry: number, rx: number, rz: number): quat {
  const qY = quat.setAxisAngle(quat.create(), [0, 1, 0], ry);
  const qX = quat.setAxisAngle(quat.create(), [1, 0, 0], rx);
  const qZ = quat.setAxisAngle(quat.create(), [0, 0, 1], rz);
  const q  = quat.multiply(quat.create(), qY, qX);
  return quat.multiply(q, q, qZ);
}

function quatToEulerYXZ(q: quat): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  // Rotation matrix entries needed for Ry*Rx*Rz decomposition:
  //   rx = asin(-R[1][2]),  ry = atan2(R[0][2], R[2][2]),  rz = atan2(R[1][0], R[1][1])
  const r12 = 2 * (qy * qz - qw * qx);
  const r02 = 2 * (qx * qz + qw * qy);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  const r10 = 2 * (qx * qy + qw * qz);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const rx  = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const ry  = Math.atan2(r02, r22);
  const rz  = Math.atan2(r10, r11);
  return [rx, ry, rz];
}

// ── TransformController3D ──────────────────────────────────────────

export class TransformController3D {
  private cb: TransformControllerCallbacks;
  private picker = new MeshPicker();
  private gizmoRenderer: GizmoRenderer;

  private _mode: GizmoMode = 'move';
  private _hoveredAxis: GizmoAxis = null;
  private _hoveredCorner: number | null = null;
  private _drag: DragState | null = null;
  private _currentDragAngle = 0;
  private _shortcut: ShortcutState | null = null;
  private _snapMode: SnapMode = 'grid';
  private _snapTarget: vec3 | null = null;
  private _snapViz: SnapVizData | null = null;

  // Array handle drag state
  private _arrayDrag: {
    groupId: string;
    handleAxis: 'x' | 'y' | 'radius';
    axisDir: [number, number, number];
    sourcePos: [number, number, number];
    countX: number;
    initialSpacing: [number, number, number];
    startPlanePt: vec3;
    // Radial-specific
    initialRadius?: number;
    radialCenter?: [number, number, number];
    radialAxis?: 'x' | 'y' | 'z';
    /** Ring plane normal in world space — set from gizmo data; used for drag plane projection. */
    radialNormal?: [number, number, number];
  } | null = null;
  private _hoveredArrayHandle: ArrayHandleHit = null;

  /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
  snapGridSize = 1.0;
  /** Angle increment for Ctrl+drag rotation snapping (radians). Default 15°. */
  snapAngle = Math.PI / 12;
  /** Scale increment for Ctrl+drag scale snapping. Default 0.25. */
  snapScaleStep = 0.25;
  /** Vertex-snap INNER radius (px) — the snap threshold and the inner circle. Default 20. */
  snapVertexRadiusPx = 20;
  /** Vertex-snap OUTER radius (px) — candidate vertices inside it preview as squares. Default 50. */
  snapCandidateRadiusPx = 50;

  private _ctrlHeld  = false;
  private _shiftHeld = false;
  private _orientationMode: 'world' | 'local' = 'world';

  // Bound handlers (stored so they can be removed later)
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp:   (e: PointerEvent) => void;

  private _canvas: HTMLCanvasElement | null = null;

  constructor(callbacks: TransformControllerCallbacks, gizmoRenderer: GizmoRenderer) {
    this.cb = callbacks;
    this.gizmoRenderer = gizmoRenderer;

    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp   = this.handlePointerUp.bind(this);
  }

  get mode(): GizmoMode { return this._mode; }
  set mode(m: GizmoMode) {
    this._mode = m;
    if (m !== 'scale') this._hoveredCorner = null;
    this.cb.scheduleRender();
  }

  get hoveredAxis(): GizmoAxis { return this._hoveredAxis; }
  get hoveredCorner(): number | null { return this._hoveredCorner; }
  /** True when Ctrl is held and snapping is active. Frogmarks can display a visual indicator. */
  get snapActive(): boolean { return this._ctrlHeld; }

  /** Non-null while a rotation drag is active; gives the accumulated angle in degrees. */
  get dragAngleDeg(): number | null {
    return this._drag?.mode === 'rotate' ? this._currentDragAngle * (180 / Math.PI) : null;
  }

  /** World-space center of the active drag gizmo, or null. */
  get dragGizmoCenter(): [number, number, number] | null {
    if (!this._drag) return null;
    const c = this._drag.gizmoCenter;
    return [c[0], c[1], c[2]];
  }

  get isDragging(): boolean { return this._drag !== null; }

  get orientationMode(): 'world' | 'local' { return this._orientationMode; }
  set orientationMode(m: 'world' | 'local') {
    this._orientationMode = m;
    this.gizmoRenderer.orientationMode = m;
    this.cb.scheduleRender();
  }

  get snapMode(): SnapMode { return this._snapMode; }
  set snapMode(m: SnapMode) { this._snapMode = m; }

  /** World-space position of the active vertex snap target, or null when not snapping. */
  get snapTarget(): [number, number, number] | null {
    if (!this._snapTarget) return null;
    return [this._snapTarget[0], this._snapTarget[1], this._snapTarget[2]];
  }

  /** Vertex-snap visualization (double-circle UX): center + candidate squares. Null when not vertex-snapping. */
  get snapViz(): SnapVizData | null { return this._snapViz; }

  // ── Canvas attachment ──────────────────────────────────────────

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this._canvas = canvas;
    // Use capture phase so we run before the orbit controller's bubble handlers. Zoneless so the gizmo's
    // per-pointermove hover hit-test doesn't wake Angular CD on every move (see zoneless-listeners).
    addZonelessListener(canvas, 'pointerdown', this._onPointerDown, { capture: true });
    addZonelessListener(canvas, 'pointermove', this._onPointerMove, { capture: true });
    addZonelessListener(canvas, 'pointerup',   this._onPointerUp,   { capture: true });
  }

  detach(): void {
    if (!this._canvas) return;
    removeZonelessListener(this._canvas, 'pointerdown', this._onPointerDown, { capture: true });
    removeZonelessListener(this._canvas, 'pointermove', this._onPointerMove, { capture: true });
    removeZonelessListener(this._canvas, 'pointerup',   this._onPointerUp,   { capture: true });
    this._canvas = null;
    this._drag = null;
  }

  // ── Event handlers ─────────────────────────────────────────────

  private handlePointerDown(e: PointerEvent): void {
    if (!this._canvas || e.button !== 0) return;
    this._ctrlHeld  = e.ctrlKey;
    this._shiftHeld = e.shiftKey;
    const { x, y } = this.canvasPos(e);
    const { width, height } = this.cb.getCanvasSize();
    const camera = this.cb.getCamera();
    const meshes = this.cb.getMeshes();
    const selectedIds = this.cb.getSelectedIds();

    // In edit mode the MeshEditPointerController owns all clicks — skip gizmo and selection
    if (this.cb.isInMeshEditMode?.()) return;
    // In bone overlay mode the bone interaction handler owns all clicks
    if (this.cb.isBoneOverlayActive?.()) return;

    const { origin: rO, dir: rD } = this.picker.castRay(x, y, width, height, camera);

    // Check array handle hit before all other gizmo logic
    const arrayData = this.cb.getArrayGizmoData?.();
    if (arrayData) {
      const hit = this.gizmoRenderer.hitTestArrayHandle(rO, rD, arrayData, camera);
      if (hit !== null) {
        e.stopPropagation();
        e.preventDefault();
        this._canvas?.setPointerCapture(e.pointerId);
        const orb = this.cb.getOrbitController?.();
        if (orb) orb.enabled = false;

        // Choose handle position and axis based on which handle was hit
        let handlePos: [number, number, number];
        let axisDir: [number, number, number];
        let initialSpacing: [number, number, number];
        let countX: number;

        if (hit === 'y' && arrayData.handlePosY && arrayData.axisDirY && arrayData.currentSpacingY && arrayData.countY !== undefined) {
          handlePos     = arrayData.handlePosY;
          axisDir       = arrayData.axisDirY;
          initialSpacing = [...arrayData.currentSpacingY] as [number, number, number];
          countX        = arrayData.countY;
        } else {
          handlePos     = arrayData.handlePos;
          axisDir       = arrayData.axisDir;
          initialSpacing = [...arrayData.currentSpacing] as [number, number, number];
          countX        = arrayData.countX;
        }

        // Compute start plane through handle, with normal perpendicular to axisDir facing camera
        const handleVec = vec3.fromValues(...handlePos);
        const axisVec   = vec3.fromValues(...axisDir);
        const camDir    = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, handleVec));
        let normal = vec3.cross(vec3.create(), axisVec, vec3.cross(vec3.create(), axisVec, camDir));
        if (vec3.length(normal) < 1e-6) {
          const fallback = Math.abs(axisVec[0]) < 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
          normal = vec3.cross(vec3.create(), axisVec, fallback);
        }
        vec3.normalize(normal, normal);

        const denom = vec3.dot(normal, rD);
        let startPlanePt = handleVec;
        if (Math.abs(denom) > 1e-7) {
          const diff = vec3.subtract(vec3.create(), handleVec, rO);
          const t = vec3.dot(normal, diff) / denom;
          if (t > 0) startPlanePt = vec3.scaleAndAdd(vec3.create(), rO, rD, t);
        }

        this._arrayDrag = {
          groupId:        arrayData.groupId,
          handleAxis:     hit,
          axisDir,
          sourcePos:      arrayData.sourcePos,
          countX,
          initialSpacing,
          startPlanePt,
          initialRadius:  arrayData.currentRadius,
          radialCenter:   arrayData.radialCenter,
          radialAxis:     arrayData.radialAxis,
          radialNormal:   arrayData.radialNormal,
        };
        return;
      }
      // Handle not hit — fall through to normal mesh picking (allows clicking away to deselect)
    }

    const selectedMeshes = meshes.filter(m => selectedIds.has(m.id));

    // Check OBB corner handles first (scale mode only)
    if (this._mode === 'scale' && selectedMeshes.length > 0) {
      const cornerIdx = this.gizmoRenderer.hitTestCorner(rO, rD, selectedMeshes, camera);
      if (cornerIdx !== null) {
        e.stopPropagation();
        e.preventDefault();
        this._canvas?.setPointerCapture(e.pointerId);
        const orb = this.cb.getOrbitController?.();
        if (orb) orb.enabled = false;

        const gizmoCenter = this.gizmoRenderer.computeCenter(selectedMeshes);
        const initialTransforms = new Map<string, any>();
        const cornerData = new Map<string, CornerDragData>();

        for (const m of selectedMeshes) {
          initialTransforms.set(m.id, {
            x: m.x, y: m.y, z: m.z,
            rx: m.rotationX, ry: m.rotationY, rz: m.rotation,
            sx: m.scaleX, sy: m.scaleY, sz: m.scaleZ,
          });
          const corners      = m.obbCorners;
          const localCorners = m.obbLocalCorners;
          if (!corners || !localCorners) continue;

          // Extract unit local axes from the rotation part of localMatrix (column-major)
          const mm = m.localMatrix as unknown as Float32Array;
          const r0 = vec3.normalize(vec3.create(), vec3.fromValues(mm[0], mm[1], mm[2]));
          const r1 = vec3.normalize(vec3.create(), vec3.fromValues(mm[4], mm[5], mm[6]));
          const r2 = vec3.normalize(vec3.create(), vec3.fromValues(mm[8], mm[9], mm[10]));

          const anchorIdx = cornerIdx ^ 7;
          cornerData.set(m.id, {
            anchorWorld:     vec3.fromValues(...corners[anchorIdx]),
            anchorGeom:      localCorners[anchorIdx],
            draggedGeom:     localCorners[cornerIdx],
            dragPlaneOrigin: vec3.fromValues(...corners[cornerIdx]),
            r0, r1, r2,
          });
        }

        this._drag = {
          axis: null,
          mode: 'scale',
          startX: x, startY: y,
          gizmoCenter,
          initialTransforms,
          planePt: null,
          cornerIndex: cornerIdx,
          cornerData,
        };
        this.cb.onGizmoDragStart?.(null);
        return;
      }
    }

    // Check gizmo hit (only if something is selected, a mode is active, and no array gizmo)
    const gizmoAxis = (this._mode !== null && selectedMeshes.length > 0 && !this.cb.getArrayGizmoData?.())
      ? this.gizmoRenderer.hitTest(rO, rD, selectedMeshes, camera, this._mode)
      : null;

    if (gizmoAxis !== null) {
      // Start a gizmo drag — disable orbit so it doesn't interfere
      e.stopPropagation();
      e.preventDefault();
      this._canvas?.setPointerCapture(e.pointerId);
      const orb = this.cb.getOrbitController?.();
      if (orb) orb.enabled = false;

      const gizmoCenter = this.gizmoRenderer.computeCenter(selectedMeshes);
      const initialTransforms = new Map<string, any>();
      for (const m of selectedMeshes) {
        initialTransforms.set(m.id, {
          x: m.x, y: m.y, z: m.z,
          rx: m.rotationX, ry: m.rotationY, rz: m.rotation,
          sx: m.scaleX, sy: m.scaleY, sz: m.scaleZ,
        });
      }

      // Compute local basis from first mesh when in local orientation mode
      let localBasis: { x: vec3; y: vec3; z: vec3 } | undefined;
      if (this._orientationMode === 'local' && selectedMeshes.length > 0) {
        const mm = selectedMeshes[0].localMatrix as unknown as Float32Array;
        const c0l = Math.hypot(mm[0], mm[1], mm[2]) || 1;
        const c1l = Math.hypot(mm[4], mm[5], mm[6]) || 1;
        const c2l = Math.hypot(mm[8], mm[9], mm[10]) || 1;
        localBasis = {
          x: vec3.fromValues(mm[0]/c0l, mm[1]/c0l, mm[2]/c0l),
          y: vec3.fromValues(mm[4]/c1l, mm[5]/c1l, mm[6]/c1l),
          z: vec3.fromValues(mm[8]/c2l, mm[9]/c2l, mm[10]/c2l),
        };
      }

      const planePt = this.rayPlanePt(rO, rD, gizmoCenter, gizmoAxis, camera, localBasis);
      this._currentDragAngle = 0;

      // Capture local axes and initial quaternions for correct local-space rotation
      let localAxes: Map<string, vec3> | undefined;
      let initialQuats: Map<string, quat> | undefined;
      if (this._mode === 'rotate') {
        localAxes  = new Map();
        initialQuats = new Map();
        const worldAxis: vec3 =
          gizmoAxis === 'x' ? vec3.fromValues(1, 0, 0) :
          gizmoAxis === 'y' ? vec3.fromValues(0, 1, 0) :
                              vec3.fromValues(0, 0, 1);
        for (const m of selectedMeshes) {
          // In local mode rotate around each mesh's own local axis
          let rotAxis = worldAxis;
          if (localBasis) {
            const mm = m.localMatrix as unknown as Float32Array;
            const c0l = Math.hypot(mm[0], mm[1], mm[2]) || 1;
            const c1l = Math.hypot(mm[4], mm[5], mm[6]) || 1;
            const c2l = Math.hypot(mm[8], mm[9], mm[10]) || 1;
            rotAxis =
              gizmoAxis === 'x' ? vec3.fromValues(mm[0]/c0l, mm[1]/c0l, mm[2]/c0l) :
              gizmoAxis === 'y' ? vec3.fromValues(mm[4]/c1l, mm[5]/c1l, mm[6]/c1l) :
                                  vec3.fromValues(mm[8]/c2l, mm[9]/c2l, mm[10]/c2l);
          }
          localAxes.set(m.id, rotAxis);
          const init = initialTransforms.get(m.id)!;
          initialQuats.set(m.id, eulerYXZtoQuat(init.ry, init.rx, init.rz));
        }
      }

      this._drag = {
        axis: gizmoAxis,
        mode: this._mode,
        startX: x,
        startY: y,
        gizmoCenter,
        initialTransforms,
        planePt,
        localAxes,
        initialQuats,
        localBasis,
      };
      this.cb.onGizmoDragStart?.(gizmoAxis);
      return;
    }

    // No gizmo hit → pick mesh for selection
    const hit = this.picker.pickMesh(x, y, width, height, camera, meshes);
    // Pick-suppressed mesh (Package-Creator paint target): ignore the click entirely — no select,
    // no deselect — and DON'T stop propagation, so the armed surface-paint pointerdown (registered
    // after this capture handler) still receives it and begins the stroke.
    if (hit && this.cb.isPickSuppressed?.(hit.mesh.id)) return;
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(selectedIds);
        if (next.has(hit.mesh.id)) next.delete(hit.mesh.id);
        else next.add(hit.mesh.id);
        this.cb.setSelectedIds(next);
      } else {
        this.cb.setSelectedIds(new Set([hit.mesh.id]));
      }
    } else if (!e.shiftKey) {
      // Try additional picking (e.g. GPU-instanced array instances invisible to MeshPicker)
      const additionalId = this.cb.pickAdditional?.(x, y, width, height) ?? null;
      if (additionalId) {
        this.cb.setSelectedIds(new Set([additionalId]));
      } else {
        this.cb.setSelectedIds(new Set());
      }
    }
    this.cb.scheduleRender();
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this._canvas) return;
    this._ctrlHeld  = e.ctrlKey;
    this._shiftHeld = e.shiftKey;
    const { x, y } = this.canvasPos(e);
    const { width, height } = this.cb.getCanvasSize();
    const camera = this.cb.getCamera();

    if (this._arrayDrag) {
      e.stopPropagation();
      if (this._arrayDrag.handleAxis === 'y') {
        this._applyArrayGridYDrag(x, y, camera, width, height);
      } else if (this._arrayDrag.handleAxis === 'radius') {
        this._applyArrayRadiusDrag(x, y, camera, width, height);
      } else {
        this._applyArrayDrag(x, y, camera, width, height);
      }
      this.cb.scheduleRender();
      return;
    }

    if (this._drag) {
      e.stopPropagation();
      this.applyDrag(x, y, camera, width, height);
      this.cb.scheduleRender();
      return;
    }

    // Array handle hover (when array gizmo is active, no normal gizmo hover)
    const arrayDataForHover = this.cb.getArrayGizmoData?.();
    if (arrayDataForHover) {
      const { origin: rO, dir: rD } = this.picker.castRay(x, y, width, height, camera);
      const hovered = this.gizmoRenderer.hitTestArrayHandle(rO, rD, arrayDataForHover, camera);
      if (hovered !== this._hoveredArrayHandle) {
        this._hoveredArrayHandle = hovered;
        this.cb.onArrayHandleHoverChange?.(hovered);
        this.cb.scheduleRender();
      }
      return;
    }

    // Update hover state for visual feedback (skip when no mode active, in edit mode, or bone overlay active).
    // FAST-OUT when nothing is selected (e.g. City mode) BEFORE walking/filtering the whole mesh list — else
    // every pointer-move filtered ~700 meshes + allocated an array for a gizmo hover that can't exist.
    const selectedIds = this.cb.getSelectedIds();
    const gizmoPossible = selectedIds.size > 0 && this._mode !== null
      && !this.cb.isInMeshEditMode?.() && !this.cb.isBoneOverlayActive?.();
    if (!gizmoPossible) {
      if (this._hoveredAxis !== null) { this._hoveredAxis = null; this.cb.scheduleRender(); }
      if (this._hoveredCorner !== null) { this._hoveredCorner = null; this.cb.scheduleRender(); }
      return;
    }
    const meshes = this.cb.getMeshes();
    const selectedMeshes = meshes.filter(m => selectedIds.has(m.id));
    if (selectedMeshes.length > 0) {
      const { origin: rO, dir: rD } = this.picker.castRay(x, y, width, height, camera);
      const axis = this.gizmoRenderer.hitTest(rO, rD, selectedMeshes, camera, this._mode);
      if (axis !== this._hoveredAxis) {
        this._hoveredAxis = axis;
        this.cb.scheduleRender();
      }
      if (this._mode === 'scale') {
        const corner = this.gizmoRenderer.hitTestCorner(rO, rD, selectedMeshes, camera);
        if (corner !== this._hoveredCorner) {
          this._hoveredCorner = corner;
          this.cb.scheduleRender();
        }
      } else if (this._hoveredCorner !== null) {
        this._hoveredCorner = null;
        this.cb.scheduleRender();
      }
    } else {
      if (this._hoveredAxis !== null) { this._hoveredAxis = null; this.cb.scheduleRender(); }
      if (this._hoveredCorner !== null) { this._hoveredCorner = null; this.cb.scheduleRender(); }
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this._canvas) return;
    this._ctrlHeld  = false;
    this._shiftHeld = false;

    if (this._arrayDrag) {
      e.stopPropagation();
      const drag = this._arrayDrag;
      this._arrayDrag = null;
      const orb = this.cb.getOrbitController?.();
      if (orb) orb.enabled = true;
      this._canvas.releasePointerCapture(e.pointerId);
      const currentData = this.cb.getArrayGizmoData?.();

      if (drag.handleAxis === 'y') {
        const newSpacingY = currentData?.currentSpacingY ?? drag.initialSpacing;
        this.cb.onArraySpacingYCommit?.(drag.groupId, drag.initialSpacing, newSpacingY);
      } else if (drag.handleAxis === 'radius') {
        const newRadius = currentData?.currentRadius ?? drag.initialRadius ?? 1;
        this.cb.onArrayRadiusCommit?.(drag.groupId, drag.initialRadius ?? 1, newRadius);
      } else {
        const newSpacing = currentData?.currentSpacing ?? drag.initialSpacing;
        this.cb.onArraySpacingCommit?.(drag.groupId, drag.initialSpacing, newSpacing);
      }
      this.cb.scheduleRender();
      return;
    }

    if (this._drag) {
      e.stopPropagation();
      const dragSnapshot = this._drag;
      this._drag = null;
      this._snapTarget = null;
      this._snapViz = null;
      this.cb.onGizmoDragEnd?.();
      const orb = this.cb.getOrbitController?.();
      if (orb) orb.enabled = true;
      this._canvas.releasePointerCapture(e.pointerId);
      this.cb.scheduleRender();

      if (this.cb.onTransformComplete && dragSnapshot.initialTransforms.size > 0) {
        const after = new Map<string, TransformSnapshot>();
        for (const mesh of this.cb.getMeshes()) {
          if (!dragSnapshot.initialTransforms.has(mesh.id)) continue;
          after.set(mesh.id, {
            x: mesh.x, y: mesh.y, z: mesh.z,
            rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
            sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
          });
        }
        this.cb.onTransformComplete(dragSnapshot.initialTransforms, after);
      }
      this.cb.onTransformDone?.([...dragSnapshot.initialTransforms.keys()]);
    }
  }

  // ── Shortcut state machine (public API for Frogmarks) ─────────

  get isShortcutActive(): boolean { return this._shortcut !== null; }
  get shortcutMode(): 'grab' | 'rotate' | 'scale' | null { return this._shortcut?.mode ?? null; }
  get shortcutAxis(): 'x' | 'y' | 'z' | null { return this._shortcut?.axis ?? null; }
  /** Current numeric input buffer, e.g. "-4.5". Empty string when no input yet. */
  get shortcutNumericDisplay(): string { return this._shortcut?.numericChars ?? ''; }

  /**
   * Begin a keyboard-driven transform on the currently selected meshes.
   * Snapshots the pre-transform state immediately so cancelTransform3D can restore it.
   * No-ops when a gizmo drag is in-flight or nothing is selected.
   */
  beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void {
    if (this._drag) return;
    if (this._shortcut) this._restoreShortcutSnapshot();
    const meshes = this.cb.getMeshes();
    const selectedIds = this.cb.getSelectedIds();
    const snapshot = new Map<string, TransformSnapshot>();
    for (const mesh of meshes) {
      if (!selectedIds.has(mesh.id)) continue;
      snapshot.set(mesh.id, {
        x: mesh.x, y: mesh.y, z: mesh.z,
        rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
        sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
      });
    }
    if (snapshot.size === 0) return;
    this._mode = mode === 'grab' ? 'move' : mode === 'rotate' ? 'rotate' : 'scale';
    this._shortcut = { mode, axis: null, numericChars: '', snapshot };
    this.cb.scheduleRender();
  }

  /** Lock the active shortcut to a world axis and clear any pending numeric input. */
  constrainAxis3D(axis: 'x' | 'y' | 'z'): void {
    if (!this._shortcut) return;
    this._shortcut.axis = axis;
    this._shortcut.numericChars = '';
    this._applyShortcutPreview();
    this.cb.scheduleRender();
  }

  /**
   * Append one character to the numeric input buffer.
   * Axis must be set first — unconstrained numeric input is a no-op.
   * Accepts digits, '.', and '-' (minus only as the first character).
   */
  appendNumericInput(char: string): void {
    if (!this._shortcut || !this._shortcut.axis) return;
    if (char !== '-' && char !== '.' && (char < '0' || char > '9')) return;
    if (char === '-' && this._shortcut.numericChars.length > 0) return;
    if (char === '.' && this._shortcut.numericChars.includes('.')) return;
    this._shortcut.numericChars += char;
    this._applyShortcutPreview();
    this.cb.scheduleRender();
  }

  /**
   * Commit the shortcut transform: fires onTransformComplete + onTransformDone for undo.
   * No-ops when no shortcut is active.
   */
  commitTransform3D(): void {
    if (!this._shortcut) return;
    const { snapshot } = this._shortcut;
    this._shortcut = null;
    if (this.cb.onTransformComplete) {
      const after = new Map<string, TransformSnapshot>();
      for (const mesh of this.cb.getMeshes()) {
        if (!snapshot.has(mesh.id)) continue;
        after.set(mesh.id, {
          x: mesh.x, y: mesh.y, z: mesh.z,
          rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
          sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
        });
      }
      this.cb.onTransformComplete(snapshot, after);
    }
    this.cb.onTransformDone?.([...snapshot.keys()]);
    this.cb.scheduleRender();
  }

  /**
   * Cancel the active shortcut (restoring from snapshot) or cancel a gizmo drag
   * that is currently in-flight. Safe to call when neither is active.
   */
  cancelTransform3D(): void {
    if (this._shortcut) {
      this._restoreShortcutSnapshot();
      this._shortcut = null;
      this.cb.scheduleRender();
      return;
    }
    if (this._drag) {
      const meshes = this.cb.getMeshes();
      for (const mesh of meshes) {
        const init = this._drag.initialTransforms.get(mesh.id);
        if (!init) continue;
        mesh.x = init.x; mesh.y = init.y; mesh.z = init.z;
        mesh.rotationX = init.rx; mesh.rotationY = init.ry; mesh.rotation = init.rz;
        mesh.scaleX = init.sx; mesh.scaleY = init.sy; mesh.scaleZ = init.sz;
      }
      this._drag = null;
      const orb = this.cb.getOrbitController?.();
      if (orb) orb.enabled = true;
      this.cb.onGizmoDragEnd?.();
      this.cb.scheduleRender();
    }
  }

  // ── Drag application ───────────────────────────────────────────

  private applyDrag(mouseX: number, mouseY: number, camera: Camera3D, w: number, h: number): void {
    if (!this._drag) return;
    const { axis, mode, gizmoCenter, initialTransforms, planePt } = this._drag;
    const meshes = this.cb.getMeshes();
    const { origin: rO, dir: rD } = this.picker.castRay(mouseX, mouseY, w, h, camera);

    if (this._drag.cornerIndex !== undefined) {
      this.applyScaleCorner(rO, rD, camera);
    } else if (mode === 'move') {
      this.applyMove(rO, rD, axis!, gizmoCenter, initialTransforms, planePt, meshes, camera, w, h);
    } else if (mode === 'rotate') {
      this.applyRotate(mouseX, mouseY, axis!, gizmoCenter, initialTransforms, meshes, camera, w, h);
    } else {
      this.applyScale(mouseX, mouseY, axis!, gizmoCenter, initialTransforms, meshes, camera, w, h);
    }
  }

  private applyScaleCorner(rO: vec3, rD: vec3, camera: Camera3D): void {
    if (!this._drag?.cornerData) return;
    const meshes = this.cb.getMeshes();

    for (const mesh of meshes) {
      const cd = this._drag.cornerData.get(mesh.id);
      if (!cd) continue;

      // Project ray onto a camera-facing plane through the initial dragged corner position
      const camDir = vec3.normalize(
        vec3.create(),
        vec3.subtract(vec3.create(), camera.position, cd.dragPlaneOrigin),
      );
      const denom = vec3.dot(camDir, rD);
      if (Math.abs(denom) < 1e-7) continue;
      const diff = vec3.subtract(vec3.create(), cd.dragPlaneOrigin, rO);
      const t    = vec3.dot(camDir, diff) / denom;
      if (t < 0) continue;
      const newDraggedWorld = vec3.scaleAndAdd(vec3.create(), rO, rD, t);

      // World-space displacement from anchor to new dragged corner position
      const delta = vec3.subtract(vec3.create(), newDraggedWorld, cd.anchorWorld);

      // Geometry-space extents from anchor to dragged corner along each local axis
      const dxG = cd.draggedGeom[0] - cd.anchorGeom[0];
      const dyG = cd.draggedGeom[1] - cd.anchorGeom[1];
      const dzG = cd.draggedGeom[2] - cd.anchorGeom[2];
      if (Math.abs(dxG) < 1e-8 || Math.abs(dyG) < 1e-8 || Math.abs(dzG) < 1e-8) continue;

      // Solve for new scales: sx' * dxG * r0 + sy' * dyG * r1 + sz' * dzG * r2 = delta
      // Since r0/r1/r2 are orthonormal, dot each side with ri
      let sx = vec3.dot(cd.r0, delta) / dxG;
      let sy = vec3.dot(cd.r1, delta) / dyG;
      let sz = vec3.dot(cd.r2, delta) / dzG;
      if (Math.abs(sx) < 0.001 || Math.abs(sy) < 0.001 || Math.abs(sz) < 0.001) continue;

      if (this._shiftHeld) {
        // Uniform corner scale: use the average of the three per-axis factors
        const u = (sx + sy + sz) / 3;
        sx = u; sy = u; sz = u;
      }

      if (this._ctrlHeld) {
        const snapScale = (v: number) => {
          const s = Math.round(Math.abs(v) / this.snapScaleStep) * this.snapScaleStep;
          return Math.max(this.snapScaleStep, s) * (v < 0 ? -1 : 1);
        };
        sx = snapScale(sx); sy = snapScale(sy); sz = snapScale(sz);
      }

      // New translation so the anchor corner stays at anchorWorld
      const tx = cd.anchorWorld[0]
        - sx * cd.anchorGeom[0] * cd.r0[0]
        - sy * cd.anchorGeom[1] * cd.r1[0]
        - sz * cd.anchorGeom[2] * cd.r2[0];
      const ty = cd.anchorWorld[1]
        - sx * cd.anchorGeom[0] * cd.r0[1]
        - sy * cd.anchorGeom[1] * cd.r1[1]
        - sz * cd.anchorGeom[2] * cd.r2[1];
      const tz = cd.anchorWorld[2]
        - sx * cd.anchorGeom[0] * cd.r0[2]
        - sy * cd.anchorGeom[1] * cd.r1[2]
        - sz * cd.anchorGeom[2] * cd.r2[2];

      mesh.scaleX = sx;
      mesh.scaleY = sy;
      mesh.scaleZ = sz;
      mesh.x = tx;
      mesh.y = ty;
      mesh.z = tz;
    }
  }

  private applyMove(
    rO: vec3, rD: vec3,
    axis: GizmoAxis,
    gizmoCenter: vec3,
    initialTransforms: Map<string, any>,
    planePt: vec3 | null,
    meshes: Mesh3D[],
    camera: Camera3D,
    w: number,
    h: number,
  ): void {
    if (!planePt) return;

    const lb = this._drag?.localBasis;
    // Find current plane hit (uses same plane definition as drag start)
    const curPt = this.rayPlanePt(rO, rD, gizmoCenter, axis!, this.cb.getCamera(), lb);
    if (!curPt) return;

    let delta = vec3.subtract(vec3.create(), curPt, planePt);

    // Constrain to axis/plane
    if (lb) {
      // Local mode: project onto local axis or remove local normal component
      if (axis === 'x') {
        const p = vec3.dot(delta, lb.x);
        delta = vec3.scale(vec3.create(), lb.x, p);
      } else if (axis === 'y') {
        const p = vec3.dot(delta, lb.y);
        delta = vec3.scale(vec3.create(), lb.y, p);
      } else if (axis === 'z') {
        const p = vec3.dot(delta, lb.z);
        delta = vec3.scale(vec3.create(), lb.z, p);
      } else if (axis === 'xy') {
        const p = vec3.dot(delta, lb.z);
        vec3.subtract(delta, delta, vec3.scale(vec3.create(), lb.z, p));
      } else if (axis === 'xz') {
        const p = vec3.dot(delta, lb.y);
        vec3.subtract(delta, delta, vec3.scale(vec3.create(), lb.y, p));
      } else if (axis === 'yz') {
        const p = vec3.dot(delta, lb.x);
        vec3.subtract(delta, delta, vec3.scale(vec3.create(), lb.x, p));
      }
    } else {
      // World mode
      if (axis === 'x')  { delta[1] = 0; delta[2] = 0; }
      else if (axis === 'y') { delta[0] = 0; delta[2] = 0; }
      else if (axis === 'z') { delta[0] = 0; delta[1] = 0; }
      else if (axis === 'xy') { delta[2] = 0; }
      else if (axis === 'xz') { delta[1] = 0; }
      else if (axis === 'yz') { delta[0] = 0; }
    }

    // ── Snap handling ─────────────────────────────────────────────
    this._snapViz = null;  // recomputed below only in vertex-snap mode
    if (this._ctrlHeld) {
      if (this._snapMode === 'vertex') {
        // Compute proposed centroid after delta
        let icx = 0, icy = 0, icz = 0, count = 0;
        for (const [, init] of initialTransforms) { icx += init.x; icy += init.y; icz += init.z; count++; }
        if (count > 0) {
          icx /= count; icy /= count; icz /= count;
          const proposed = vec3.fromValues(icx + delta[0], icy + delta[1], icz + delta[2]);
          const excludeIds = new Set(initialTransforms.keys());
          const { target, viz } = this._findSnapVerts(proposed, excludeIds, camera, w, h);
          this._snapViz = viz;  // candidate squares shown even when no target is locked yet
          if (target) {
            this._snapTarget = target;
            const sdx = target[0] - icx, sdy = target[1] - icy, sdz = target[2] - icz;
            for (const mesh of meshes) {
              const init = initialTransforms.get(mesh.id);
              if (!init) continue;
              mesh.x = init.x + sdx;
              mesh.y = init.y + sdy;
              mesh.z = init.z + sdz;
            }
            return;
          }
          this._snapTarget = null;
          // fall through to unconstrained
        }
      } else if (this._snapMode === 'grid') {
        this._snapTarget = null;
        const snapPos = (v: number) => Math.round(v / this.snapGridSize) * this.snapGridSize;
        for (const mesh of meshes) {
          const init = initialTransforms.get(mesh.id);
          if (!init) continue;
          mesh.x = delta[0] !== 0 ? snapPos(init.x + delta[0]) : init.x;
          mesh.y = delta[1] !== 0 ? snapPos(init.y + delta[1]) : init.y;
          mesh.z = delta[2] !== 0 ? snapPos(init.z + delta[2]) : init.z;
        }
        return;
      } else {
        this._snapTarget = null; // 'none' mode — fall through
      }
    } else {
      this._snapTarget = null;
    }

    // Unconstrained move
    for (const mesh of meshes) {
      const init = initialTransforms.get(mesh.id);
      if (!init) continue;
      mesh.x = init.x + delta[0];
      mesh.y = init.y + delta[1];
      mesh.z = init.z + delta[2];
    }
  }

  private applyRotate(
    mouseX: number, mouseY: number,
    axis: GizmoAxis,
    gizmoCenter: vec3,
    initialTransforms: Map<string, any>,
    meshes: Mesh3D[],
    camera: Camera3D,
    w: number, h: number,
  ): void {
    if (!this._drag) return;

    const dx = mouseX - this._drag.startX;
    const dy = mouseY - this._drag.startY;
    let angle = (dx + dy) / 300 * Math.PI * 2;

    // If the ring's axis is roughly face-on to the camera, use screen-space angular delta
    // so dragging tangent to the ring always produces the correct rotation regardless of
    // where on the ring was grabbed. This is necessary for world Z in the default view,
    // but also for any local axis that happens to face the camera.
    const dragAxisWorld: vec3 =
      this._drag.localAxes?.get(meshes[0]?.id ?? '') ??
      (axis === 'x' ? vec3.fromValues(1, 0, 0) :
       axis === 'y' ? vec3.fromValues(0, 1, 0) :
                      vec3.fromValues(0, 0, 1));
    const camDir = vec3.normalize(
      vec3.create(),
      vec3.subtract(vec3.create(), camera.position, gizmoCenter),
    );
    const faceDot = vec3.dot(dragAxisWorld, camDir);
    if (Math.abs(faceDot) > 0.5) {
      const vp    = camera.getViewProjectionMatrix();
      const cScr  = worldToScreen(gizmoCenter, vp, w, h);
      if (cScr) {
        const startAng = Math.atan2(this._drag.startY - cScr[1], this._drag.startX - cScr[0]);
        const curAng   = Math.atan2(mouseY - cScr[1], mouseX - cScr[0]);
        let delta = curAng - startAng;
        while (delta >  Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        // Negate delta; also negate sign when axis faces away from camera so
        // screen-CCW always matches right-hand positive rotation around the axis.
        angle = -Math.sign(faceDot) * delta;
      }
    }

    if (this._ctrlHeld) {
      angle = Math.round(angle / this.snapAngle) * this.snapAngle;
    }

    this._currentDragAngle = angle;

    const { localAxes, initialQuats } = this._drag;

    for (const mesh of meshes) {
      const init = initialTransforms.get(mesh.id);
      if (!init) continue;

      const localAxis = localAxes?.get(mesh.id);
      const q0        = initialQuats?.get(mesh.id);

      if (localAxis && q0) {
        // Rotate around the mesh's local axis direction (world-space, captured at drag start)
        const qDelta = quat.setAxisAngle(quat.create(), localAxis, angle);
        const qNew   = quat.normalize(quat.create(), quat.multiply(quat.create(), qDelta, q0));
        const [rx, ry, rz] = quatToEulerYXZ(qNew);
        mesh.rotationX = rx;
        mesh.rotationY = ry;
        mesh.rotation  = rz;
      } else {
        if (axis === 'x')      mesh.rotationX = init.rx + angle;
        else if (axis === 'y') mesh.rotationY = init.ry + angle;
        else if (axis === 'z') mesh.rotation  = init.rz + angle;
      }
    }
  }

  private applyScale(
    mouseX: number, mouseY: number,
    axis: GizmoAxis,
    gizmoCenter: vec3,
    initialTransforms: Map<string, any>,
    meshes: Mesh3D[],
    camera: Camera3D,
    w: number, h: number,
  ): void {
    if (!this._drag) return;

    const dx = mouseX - this._drag.startX;
    const dy = mouseY - this._drag.startY;

    // Project the handle's axis to screen space so dragging toward
    // the tip always scales up, regardless of camera angle or mesh rotation.
    const lb = this._drag?.localBasis;
    let effectiveDrag = dx;
    if (axis === 'x' || axis === 'y' || axis === 'z') {
      const worldDir = lb
        ? axis === 'x' ? lb.x : axis === 'y' ? lb.y : lb.z
        : axis === 'x' ? vec3.fromValues(1, 0, 0)
        : axis === 'y' ? vec3.fromValues(0, 1, 0)
        :                vec3.fromValues(0, 0, 1);
      const gizmoScale = GizmoRenderer.computeGizmoScale(camera, gizmoCenter);
      const tipWorld   = vec3.scaleAndAdd(vec3.create(), gizmoCenter, worldDir, gizmoScale);
      const vp         = camera.getViewProjectionMatrix();
      const cScr       = worldToScreen(gizmoCenter, vp, w, h);
      const tScr       = worldToScreen(tipWorld,    vp, w, h);
      if (cScr && tScr) {
        const sx  = tScr[0] - cScr[0];
        const sy  = tScr[1] - cScr[1];
        const len = Math.sqrt(sx * sx + sy * sy);
        if (len > 1) effectiveDrag = (dx * sx + dy * sy) / len;
      }
    }

    let factor = Math.max(0.01, 1 + effectiveDrag / 200);
    if (this._ctrlHeld) {
      factor = Math.max(this.snapScaleStep, Math.round(factor / this.snapScaleStep) * this.snapScaleStep);
    }

    for (const mesh of meshes) {
      const init = initialTransforms.get(mesh.id);
      if (!init) continue;
      // Shift: override single-axis handle to scale all three axes uniformly
      if (this._shiftHeld || axis !== 'x' && axis !== 'y' && axis !== 'z') {
        mesh.scaleX = init.sx * factor;
        mesh.scaleY = init.sy * factor;
        mesh.scaleZ = init.sz * factor;
      } else if (axis === 'x') mesh.scaleX = init.sx * factor;
      else if (axis === 'y')   mesh.scaleY = init.sy * factor;
      else                     mesh.scaleZ = init.sz * factor;
    }
  }

  // ── Plane intersection helper ──────────────────────────────────

  /**
   * Find the world-space point where the ray hits the drag plane.
   * In local mode pass `localBasis` so the plane is oriented with the mesh.
   */
  private rayPlanePt(
    rO: vec3,
    rD: vec3,
    gizmoCenter: vec3,
    axis: GizmoAxis,
    camera: Camera3D,
    localBasis?: { x: vec3; y: vec3; z: vec3 },
  ): vec3 | null {
    let normal: vec3;

    if (axis === 'xy') {
      normal = vec3.clone(localBasis?.z ?? vec3.fromValues(0, 0, 1));
    } else if (axis === 'xz') {
      normal = vec3.clone(localBasis?.y ?? vec3.fromValues(0, 1, 0));
    } else if (axis === 'yz') {
      normal = vec3.clone(localBasis?.x ?? vec3.fromValues(1, 0, 0));
    } else if (axis === 'x') {
      const axisDir = localBasis?.x ?? vec3.fromValues(1, 0, 0);
      const camDir  = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, gizmoCenter));
      normal = vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir));
      if (vec3.length(normal) < 1e-6) normal = vec3.clone(localBasis?.y ?? vec3.fromValues(0, 1, 0));
      vec3.normalize(normal, normal);
    } else if (axis === 'y') {
      const axisDir = localBasis?.y ?? vec3.fromValues(0, 1, 0);
      const camDir  = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, gizmoCenter));
      normal = vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir));
      if (vec3.length(normal) < 1e-6) normal = vec3.clone(localBasis?.x ?? vec3.fromValues(1, 0, 0));
      vec3.normalize(normal, normal);
    } else { // z
      const axisDir = localBasis?.z ?? vec3.fromValues(0, 0, 1);
      const camDir  = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, gizmoCenter));
      normal = vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir));
      if (vec3.length(normal) < 1e-6) normal = vec3.clone(localBasis?.y ?? vec3.fromValues(0, 1, 0));
      vec3.normalize(normal, normal);
    }

    // Plane: dot(normal, P - gizmoCenter) = 0
    const denom = vec3.dot(normal, rD);
    if (Math.abs(denom) < 1e-7) return null;

    const diff = vec3.subtract(vec3.create(), gizmoCenter, rO);
    const t = vec3.dot(normal, diff) / denom;
    if (t < 0) return null;

    return vec3.scaleAndAdd(vec3.create(), rO, rD, t);
  }

  private _applyArrayDrag(mouseX: number, mouseY: number, camera: Camera3D, w: number, h: number): void {
    if (!this._arrayDrag) return;
    const { axisDir, sourcePos, countX, startPlanePt } = this._arrayDrag;

    const { origin: rO, dir: rD } = this.picker.castRay(mouseX, mouseY, w, h, camera);

    // Plane through startPlanePt with normal = perp to axisDir facing camera
    const axisVec  = vec3.fromValues(...axisDir);
    const camDir   = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, startPlanePt));
    let normal = vec3.cross(vec3.create(), axisVec, vec3.cross(vec3.create(), axisVec, camDir));
    if (vec3.length(normal) < 1e-6) {
      const fallback = Math.abs(axisVec[0]) < 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
      normal = vec3.cross(vec3.create(), axisVec, fallback);
    }
    vec3.normalize(normal, normal);

    const denom = vec3.dot(normal, rD);
    if (Math.abs(denom) < 1e-7) return;
    const diff = vec3.subtract(vec3.create(), startPlanePt, rO);
    const t = vec3.dot(normal, diff) / denom;
    if (t < 0) return;

    const curPlanePt = vec3.scaleAndAdd(vec3.create(), rO, rD, t);

    // Project displacement from sourcePos onto axisDir; divide by countX for per-step spacing
    const disp     = vec3.subtract(vec3.create(), curPlanePt, vec3.fromValues(...sourcePos));
    const projDist = vec3.dot(disp, axisVec);
    const newMag   = Math.max(0.05, projDist / Math.max(1, countX));

    const newSpacing: [number, number, number] = [
      axisDir[0] * newMag,
      axisDir[1] * newMag,
      axisDir[2] * newMag,
    ];

    this.cb.onArraySpacingDrag?.(this._arrayDrag.groupId, newSpacing);
  }

  private _applyArrayGridYDrag(mouseX: number, mouseY: number, camera: Camera3D, w: number, h: number): void {
    if (!this._arrayDrag) return;
    const { axisDir, sourcePos, countX: countY, startPlanePt } = this._arrayDrag;

    const { origin: rO, dir: rD } = this.picker.castRay(mouseX, mouseY, w, h, camera);

    const axisVec  = vec3.fromValues(...axisDir);
    const camDir   = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position, startPlanePt));
    let normal = vec3.cross(vec3.create(), axisVec, vec3.cross(vec3.create(), axisVec, camDir));
    if (vec3.length(normal) < 1e-6) {
      const fallback = Math.abs(axisVec[0]) < 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
      normal = vec3.cross(vec3.create(), axisVec, fallback);
    }
    vec3.normalize(normal, normal);

    const denom = vec3.dot(normal, rD);
    if (Math.abs(denom) < 1e-7) return;
    const diff = vec3.subtract(vec3.create(), startPlanePt, rO);
    const t = vec3.dot(normal, diff) / denom;
    if (t < 0) return;

    const curPlanePt = vec3.scaleAndAdd(vec3.create(), rO, rD, t);
    const disp       = vec3.subtract(vec3.create(), curPlanePt, vec3.fromValues(...sourcePos));
    const projDist   = vec3.dot(disp, axisVec);
    const newMag     = Math.max(0.05, projDist / Math.max(1, countY));

    const newSpacingY: [number, number, number] = [axisDir[0] * newMag, axisDir[1] * newMag, axisDir[2] * newMag];
    this.cb.onArraySpacingYDrag?.(this._arrayDrag.groupId, newSpacingY);
  }

  private _applyArrayRadiusDrag(mouseX: number, mouseY: number, camera: Camera3D, w: number, h: number): void {
    if (!this._arrayDrag || !this._arrayDrag.radialCenter) return;
    const { radialCenter, radialAxis, radialNormal, startPlanePt } = this._arrayDrag;

    const { origin: rO, dir: rD } = this.picker.castRay(mouseX, mouseY, w, h, camera);

    // Project onto the ring plane: use local normal when available (local orientation mode),
    // otherwise derive from the world axis string.
    const axisNormal: vec3 = radialNormal
      ? vec3.fromValues(...radialNormal)
      : (radialAxis === 'y' ? vec3.fromValues(0, 1, 0) :
         radialAxis === 'x' ? vec3.fromValues(1, 0, 0) :
                              vec3.fromValues(0, 0, 1));

    const denom = vec3.dot(axisNormal, rD);
    if (Math.abs(denom) < 1e-7) return;
    const diff = vec3.subtract(vec3.create(), startPlanePt, rO);
    const t = vec3.dot(axisNormal, diff) / denom;
    if (t < 0) return;

    const hitPt   = vec3.scaleAndAdd(vec3.create(), rO, rD, t);
    const cVec    = vec3.fromValues(...radialCenter);
    const newRadius = Math.max(0.1, vec3.distance(hitPt, cVec));
    this.cb.onArrayRadiusDrag?.(this._arrayDrag.groupId, newRadius);
  }

  // ── Snap helpers ───────────────────────────────────────────────

  /**
   * Scan non-excluded meshes near `proposedPos` (screen space) for vertex snapping.
   *  - `target` = the vertex that will snap: the FRONT-MOST (nearest the camera) among those within
   *    the inner radius, so an occluded/back vertex never beats a visible one under the cursor.
   *  - `viz`    = the double-circle data: every vertex within the OUTER radius is a candidate square
   *    (capped to the nearest ~40 on screen), with the snap target flagged `active`.
   */
  private _findSnapVerts(
    proposedPos: vec3,
    excludeIds: Set<string>,
    camera: Camera3D,
    w: number,
    h: number,
  ): { target: vec3 | null; viz: SnapVizData | null } {
    const innerPx = this.snapVertexRadiusPx;
    const outerPx = Math.max(this.snapCandidateRadiusPx, innerPx);
    const vp = camera.getViewProjectionMatrix();
    const propScr = worldToScreen(proposedPos, vp, w, h);
    if (!propScr) return { target: null, viz: null };
    const centerWorld: [number, number, number] = [proposedPos[0], proposedPos[1], proposedPos[2]];

    const cam = camera.position;
    const outerSq = outerPx * outerPx, innerSq = innerPx * innerPx;
    type Cand = { world: vec3; camDist: number; screenSq: number; inner: boolean };
    const cands: Cand[] = [];

    for (const mesh of this.cb.getMeshes()) {
      if (excludeIds.has(mesh.id)) continue;
      const verts = mesh.geometry.vertices;
      const mm = mesh.localMatrix as unknown as Float32Array;
      for (let i = 0; i < verts.length; i += FLOATS_PER_VERT) {
        const lx = verts[i], ly = verts[i + 1], lz = verts[i + 2];
        const wx = mm[0]*lx + mm[4]*ly + mm[8]*lz  + mm[12];
        const wy = mm[1]*lx + mm[5]*ly + mm[9]*lz  + mm[13];
        const wz = mm[2]*lx + mm[6]*ly + mm[10]*lz + mm[14];
        const pt = vec3.fromValues(wx, wy, wz);
        const scr = worldToScreen(pt, vp, w, h);
        if (!scr) continue;
        const dx = scr[0] - propScr[0], dy = scr[1] - propScr[1];
        const screenSq = dx*dx + dy*dy;
        if (screenSq > outerSq) continue;
        const cdx = wx - cam[0], cdy = wy - cam[1], cdz = wz - cam[2];
        cands.push({ world: pt, camDist: Math.sqrt(cdx*cdx + cdy*cdy + cdz*cdz), screenSq, inner: screenSq <= innerSq });
      }
    }

    // Snap target = front-most (nearest the camera) among the inner-radius candidates.
    let target: Cand | null = null;
    for (const c of cands) {
      if (c.inner && (!target || c.camDist < target.camDist)) target = c;
    }

    // Candidate squares: nearest-on-screen first, capped so a dense mesh doesn't flood the view.
    cands.sort((a, b) => a.screenSq - b.screenSq);
    const shown = cands.slice(0, 40);
    let minD = Infinity, maxD = -Infinity;
    for (const c of shown) { if (c.camDist < minD) minD = c.camDist; if (c.camDist > maxD) maxD = c.camDist; }
    const span = Math.max(1e-6, maxD - minD);
    const candidates = shown.map(c => ({
      world: [c.world[0], c.world[1], c.world[2]] as [number, number, number],
      depthT: (c.camDist - minD) / span,   // 0 = nearest the camera, 1 = farthest
      active: c === target,
    }));

    return { target: target ? target.world : null, viz: { centerWorld, innerPx, outerPx, candidates } };
  }

  // ── Shortcut helpers ───────────────────────────────────────────

  private _restoreShortcutSnapshot(): void {
    if (!this._shortcut) return;
    for (const mesh of this.cb.getMeshes()) {
      const snap = this._shortcut.snapshot.get(mesh.id);
      if (!snap) continue;
      mesh.x = snap.x; mesh.y = snap.y; mesh.z = snap.z;
      mesh.rotationX = snap.rx; mesh.rotationY = snap.ry; mesh.rotation = snap.rz;
      mesh.scaleX = snap.sx; mesh.scaleY = snap.sy; mesh.scaleZ = snap.sz;
    }
  }

  private _applyShortcutPreview(): void {
    if (!this._shortcut) return;
    this._restoreShortcutSnapshot();
    const { mode, axis, numericChars, snapshot } = this._shortcut;
    if (!axis || numericChars === '' || numericChars === '-' || numericChars === '.') return;
    const value = parseFloat(numericChars);
    if (isNaN(value)) return;
    for (const mesh of this.cb.getMeshes()) {
      if (!snapshot.has(mesh.id)) continue;
      if (mode === 'grab') {
        if (axis === 'x')      mesh.x += value;
        else if (axis === 'y') mesh.y += value;
        else                   mesh.z += value;
      } else if (mode === 'rotate') {
        const rad = value * (Math.PI / 180);
        if (axis === 'x')      mesh.rotationX += rad;
        else if (axis === 'y') mesh.rotationY += rad;
        else                   mesh.rotation  += rad;
      } else {
        if (axis === 'x')      mesh.scaleX *= value;
        else if (axis === 'y') mesh.scaleY *= value;
        else                   mesh.scaleZ *= value;
      }
    }
  }

  // ── Utility ────────────────────────────────────────────────────

  private canvasPos(e: PointerEvent): { x: number; y: number } {
    const rect = this._canvas!.getBoundingClientRect();
    const scaleX = this._canvas!.width  / rect.width;
    const scaleY = this._canvas!.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }
}
