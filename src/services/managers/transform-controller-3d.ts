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
import { Camera3D } from '../../renderer/3d/camera-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { GizmoRenderer, GizmoAxis, GizmoMode } from '../../renderer/3d/gizmo-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { OrbitController } from '../../renderer/3d/orbit-controller';

// ── Callbacks interface ────────────────────────────────────────────

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

  /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
  snapGridSize = 1.0;
  /** Angle increment for Ctrl+drag rotation snapping (radians). Default 15°. */
  snapAngle = Math.PI / 12;
  /** Scale increment for Ctrl+drag scale snapping. Default 0.25. */
  snapScaleStep = 0.25;

  private _ctrlHeld  = false;
  private _shiftHeld = false;
  private _orientationMode: 'world' | 'local' = 'world';

  // Bound handlers (stored so they can be removed later)
  private _onPointerDown: (e: PointerEvent) => void;
  private _onPointerMove: (e: PointerEvent) => void;
  private _onPointerUp:   (e: PointerEvent) => void;
  private _onKeyDown:     (e: KeyboardEvent) => void;

  private _canvas: HTMLCanvasElement | null = null;

  constructor(callbacks: TransformControllerCallbacks, gizmoRenderer: GizmoRenderer) {
    this.cb = callbacks;
    this.gizmoRenderer = gizmoRenderer;

    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp   = this.handlePointerUp.bind(this);
    this._onKeyDown     = this.handleKeyDown.bind(this);
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

  // ── Canvas attachment ──────────────────────────────────────────

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this._canvas = canvas;
    // Use capture phase so we run before the orbit controller's bubble handlers
    canvas.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    canvas.addEventListener('pointermove', this._onPointerMove, { capture: true });
    canvas.addEventListener('pointerup',   this._onPointerUp,   { capture: true });
    window.addEventListener('keydown',     this._onKeyDown);
  }

  detach(): void {
    if (!this._canvas) return;
    this._canvas.removeEventListener('pointerdown', this._onPointerDown, { capture: true } as any);
    this._canvas.removeEventListener('pointermove', this._onPointerMove, { capture: true } as any);
    this._canvas.removeEventListener('pointerup',   this._onPointerUp,   { capture: true } as any);
    window.removeEventListener('keydown', this._onKeyDown);
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

    const { origin: rO, dir: rD } = this.picker.castRay(x, y, width, height, camera);

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

    // Check gizmo hit (only if something is selected)
    const gizmoAxis = selectedMeshes.length > 0
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

    // No gizmo hit → pick mesh for selection (skip in mesh edit mode)
    if (this.cb.isInMeshEditMode?.()) return;
    const hit = this.picker.pickMesh(x, y, width, height, camera, meshes);
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
      this.cb.setSelectedIds(new Set());
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

    if (this._drag) {
      e.stopPropagation();
      this.applyDrag(x, y, camera, width, height);
      this.cb.scheduleRender();
      return;
    }

    // Update hover state for visual feedback
    const meshes = this.cb.getMeshes();
    const selectedMeshes = meshes.filter(m => this.cb.getSelectedIds().has(m.id));
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
    if (this._drag) {
      e.stopPropagation();
      const dragSnapshot = this._drag;
      this._drag = null;
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

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'g' || e.key === 'G') { this.mode = 'move'; }
    else if (e.key === 'r' || e.key === 'R') { this.mode = 'rotate'; }
    else if (e.key === 's' || e.key === 'S') { this.mode = 'scale'; }
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
      this.applyMove(rO, rD, axis!, gizmoCenter, initialTransforms, planePt, meshes);
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

    for (const mesh of meshes) {
      const init = initialTransforms.get(mesh.id);
      if (!init) continue;
      if (this._ctrlHeld) {
        // Snap absolute position only on axes that are being moved (delta !== 0 for those axes)
        const snapPos = (v: number) => Math.round(v / this.snapGridSize) * this.snapGridSize;
        mesh.x = delta[0] !== 0 ? snapPos(init.x + delta[0]) : init.x;
        mesh.y = delta[1] !== 0 ? snapPos(init.y + delta[1]) : init.y;
        mesh.z = delta[2] !== 0 ? snapPos(init.z + delta[2]) : init.z;
      } else {
        mesh.x = init.x + delta[0];
        mesh.y = init.y + delta[1];
        mesh.z = init.z + delta[2];
      }
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
