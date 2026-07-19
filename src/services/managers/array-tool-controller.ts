/**
 * ArrayToolController — hover-handles + ghost-preview interaction for the Array Tool (Phase 4).
 *
 * Lifecycle:
 *   1. Created by Scene3DManager.enableArrayTool(mode)
 *   2. Receives pointer events from the canvas
 *   3. Hover mesh → face handles appear
 *   4. Hover handle → ghost copies fade in, scroll adjusts count
 *   5. Click → commits ArrayGroup3D via callbacks
 *   6. Destroyed by Scene3DManager.disableArrayTool()
 */

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { GizmoRenderer, FaceHandle, FaceHandleData } from '../../renderer/3d/gizmo-renderer';
import { GhostPreviewData, GhostInstance } from '../../renderer/3d/ghost-preview-renderer';
import { Renderer3D } from '../../renderer/3d/renderer-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';

export type ArrayToolMode = 'line' | 'grid' | 'radial';

export interface ArrayToolContext {
  getAllMeshes(): Mesh3D[];
  getCamera(): Camera3D;
  getCanvasSize(): { width: number; height: number };
  /** Returns the ID of the currently selected Mesh3D, or null if nothing / a group is selected. */
  getSelectedMeshId(): string | null;
  /**
   * Returns all Mesh3D siblings in the same MeshGroup3D as the given mesh (including itself).
   * Returns [mesh] when the mesh is not inside a group.
   */
  getGroupSiblings(meshId: string): Mesh3D[];
  /** Current gizmo orientation — determines whether handles align to world or local axes. */
  getOrientationMode(): 'world' | 'local';
  /** Returns handle IDs that already have an ArrayGroup3D for this source (should be hidden). */
  getOccupiedHandleIds(sourceId: string): Set<string>;
  createLinearArray3D(sourceId: string, count: number, spacing: [number, number, number]): void;
  createGridArray3D(
    sourceId: string,
    countX: number, spacingX: [number, number, number],
    countY: number, spacingY: [number, number, number],
    diagonalOnly?: boolean,
  ): void;
  createRadialArray3D(
    sourceId: string,
    count: number,
    radius: number,
    axis: 'x' | 'y' | 'z',
    arcDeg: number,
  ): void;
  scheduleRender(): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FACE_OFFSET  = 1.3;   // how far beyond AABB face the handle sits
const SPACING_GAP  = 1.1;   // AABB-size multiplier for copy spacing
const GHOST_ALPHA  = 0.30;  // final alpha for ghost copies
const GHOST_FADE_MS = 300;  // fade-in duration

// Cardinal handle descriptors: direction vectors (unit, one axis is ±1)
const CARDINAL: ReadonlyArray<{ id: string; dx: number; dy: number; dz: number }> = [
  { id: 'px', dx:  1, dy: 0, dz:  0 },
  { id: 'nx', dx: -1, dy: 0, dz:  0 },
  { id: 'py', dx:  0, dy: 1, dz:  0 },
  { id: 'ny', dx:  0, dy:-1, dz:  0 },
  { id: 'pz', dx:  0, dy: 0, dz:  1 },
  { id: 'nz', dx:  0, dy: 0, dz: -1 },
];

// Diagonal handle descriptors: XZ-plane corners (grid mode only)
const DIAGONAL: ReadonlyArray<{ id: string; sx: number; sz: number }> = [
  { id: 'pxpz', sx:  1, sz:  1 },
  { id: 'nxpz', sx: -1, sz:  1 },
  { id: 'pxnz', sx:  1, sz: -1 },
  { id: 'nxnz', sx: -1, sz: -1 },
];

// ── ArrayToolController ───────────────────────────────────────────────────────

export class ArrayToolController {
  private _mode:  ArrayToolMode;
  private _count: number;
  private _radialAxis:   'x' | 'y' | 'z' = 'y';
  /** null = auto-compute from mesh AABB each frame. */
  private _radialRadius: number | null = null;
  private _radialArc:    number = 360;

  private readonly _canvas:        HTMLCanvasElement;
  private readonly _renderer:      Renderer3D;
  private readonly _gizmoRenderer: GizmoRenderer;
  private readonly _picker:        MeshPicker;
  private readonly _ctx:           ArrayToolContext;

  // _lockedMeshId: persists after mouse leaves the mesh surface so handles stay clickable.
  // Cleared only when entering a different mesh, committing, or the canvas is left.
  private _lockedMeshId:       string | null = null;
  private _hoveredHandleId:    string | null = null;
  // All Mesh3D children of the locked mesh's MeshGroup3D parent (or just [locked] if no group).
  private _lockedGroupSiblings: Mesh3D[] = [];

  // Last-seen values for checkState() diffing
  private _lastSeenMeshId:        string | null         = null;
  private _lastSeenOrientation:   'world' | 'local'     = 'world';

  // Ghost fade-in
  private _fadeStart = 0;
  private _rafId: number | null = null;

  // Event cleanup
  private _cleanup: (() => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    renderer: Renderer3D,
    gizmoRenderer: GizmoRenderer,
    picker: MeshPicker,
    ctx: ArrayToolContext,
    mode: ArrayToolMode = 'line',
    count = 3,
  ) {
    this._canvas        = canvas;
    this._renderer      = renderer;
    this._gizmoRenderer = gizmoRenderer;
    this._picker        = picker;
    this._ctx           = ctx;
    this._mode          = mode;
    this._count         = count;
    this._attachEvents();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called every pre-render frame. Diffs selection + orientation against last seen values
   * and rebuilds handles only when something changed. Must NOT call scheduleRender().
   */
  checkState(): boolean {
    const meshId      = this._ctx.getSelectedMeshId();
    const orientation = this._ctx.getOrientationMode();

    const meshChanged        = meshId      !== this._lastSeenMeshId;
    const orientationChanged = orientation !== this._lastSeenOrientation;
    if (!meshChanged && !orientationChanged) return false;

    this._lastSeenMeshId        = meshId;
    this._lastSeenOrientation   = orientation;

    if (meshChanged) {
      this._clearAll();
      this._lockedMeshId = meshId;
      this._lockedGroupSiblings = meshId ? this._ctx.getGroupSiblings(meshId) : [];
      if (meshId) {
        const mesh = this._ctx.getAllMeshes().find(m => m.id === meshId);
        if (mesh) this._onMeshEnter(mesh);
      }
    } else if (this._lockedMeshId) {
      // Only orientation changed — rebuild handles and, for radial, re-upload ghost
      // (ring plane is orientation-dependent: world axis vs source local axis)
      const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
      if (mesh) {
        this._renderer.setFaceHandleData(this._buildFaceHandleData(mesh, this._hoveredHandleId));
        if (this._mode === 'radial') this._uploadGhost(mesh, null);
      }
    }

    return false; // never request an extra frame
  }

  setMode(mode: ArrayToolMode): void {
    this._mode = mode;
    this._clearAll();
    this._lockedGroupSiblings = this._lockedMeshId ? this._ctx.getGroupSiblings(this._lockedMeshId) : [];
    const meshes = this._ctx.getAllMeshes();
    const mesh = meshes.find(m => m.id === this._lockedMeshId);
    if (mesh) this._onMeshEnter(mesh);
  }

  setCount(count: number): void {
    this._count = Math.max(1, Math.min(32, count));
    const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
    if (mesh) this._uploadGhost(mesh, this._hoveredHandleId);
    this._ctx.scheduleRender();
  }

  getCount(): number { return this._count; }

  setRadialAxis(axis: 'x' | 'y' | 'z'): void {
    this._radialAxis = axis;
    const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
    if (mesh) this._uploadGhost(mesh, this._hoveredHandleId);
    this._ctx.scheduleRender();
  }

  getRadialAxis(): 'x' | 'y' | 'z' { return this._radialAxis; }

  /** Set pre-commit ring radius. Pass null to restore auto-sizing from mesh AABB. */
  setRadialRadius(r: number | null): void {
    this._radialRadius = r === null ? null : Math.max(0.1, r);
    const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
    if (mesh) this._uploadGhost(mesh, this._hoveredHandleId);
    this._ctx.scheduleRender();
  }

  getRadialRadius(): number | null { return this._radialRadius; }

  setRadialArc(deg: number): void {
    this._radialArc = Math.min(360, Math.max(1, deg));
    const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
    if (mesh) this._uploadGhost(mesh, this._hoveredHandleId);
    this._ctx.scheduleRender();
  }

  getRadialArc(): number { return this._radialArc; }

  destroy(): void {
    this._cancelRaf();
    this._cleanup?.();
    this._renderer.setFaceHandleData(null);
    this._renderer.setGhostPreviewData(null);
  }

  // ── Event wiring ────────────────────────────────────────────────────────────

  private _attachEvents(): void {
    const onMove  = (e: MouseEvent)  => this._onMouseMove(e);
    const onLeave = ()               => this._onMouseLeave();
    const onDown  = (e: MouseEvent)  => this._onMouseDown(e);
    const onWheel = (e: WheelEvent)  => this._onWheel(e);

    addZonelessListener(this._canvas, 'mousemove',  onMove);
    addZonelessListener(this._canvas, 'mouseleave', onLeave);
    addZonelessListener(this._canvas, 'mousedown',  onDown);
    addZonelessListener(this._canvas, 'wheel',      onWheel, { passive: false });

    this._cleanup = () => {
      removeZonelessListener(this._canvas, 'mousemove',  onMove);
      removeZonelessListener(this._canvas, 'mouseleave', onLeave);
      removeZonelessListener(this._canvas, 'mousedown',  onDown);
      removeZonelessListener(this._canvas, 'wheel',      onWheel);
    };
  }

  private _onMouseMove(e: MouseEvent): void {
    const el = this._canvas;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (el.width  / rect.width);
    const py = (e.clientY - rect.top)  * (el.height / rect.height);

    const camera = this._ctx.getCamera();
    const { width, height } = this._ctx.getCanvasSize();
    const meshes = this._ctx.getAllMeshes();

    // ── Selection-driven lock ──────────────────────────────────────
    // The locked mesh always tracks the current selection.
    // Hovering other meshes never steals the lock.
    const selectedId = this._ctx.getSelectedMeshId();
    if (selectedId !== this._lockedMeshId) {
      this._clearAll();
      this._lockedMeshId = selectedId;
      this._lockedGroupSiblings = selectedId ? this._ctx.getGroupSiblings(selectedId) : [];
      if (selectedId) {
        const mesh = meshes.find(m => m.id === selectedId);
        if (mesh) this._onMeshEnter(mesh);
      }
      this._ctx.scheduleRender();
    }

    // ── Handle hover (line + grid modes only) ──────────────────────
    if (this._lockedMeshId && this._mode !== 'radial') {
      const mesh = meshes.find(m => m.id === this._lockedMeshId);
      if (mesh) {
        const { origin, dir } = this._picker.castRay(px, py, width, height, camera);
        const fhData = this._buildFaceHandleData(mesh, this._hoveredHandleId);
        const hitId = this._gizmoRenderer.hitTestFaceHandle(
          origin as [number, number, number],
          dir    as [number, number, number],
          fhData, camera,
        );

        if (hitId !== this._hoveredHandleId) {
          this._hoveredHandleId = hitId;
          this._renderer.setFaceHandleData(this._buildFaceHandleData(mesh, hitId));

          if (hitId) {
            this._startFade();
            this._uploadGhost(mesh, hitId);
          } else {
            this._cancelRaf();
            this._renderer.setGhostPreviewData(null);
          }
          this._ctx.scheduleRender();
        }
      }
    }
  }

  private _onMouseLeave(): void {
    // Mouse left the canvas — clear handle highlight.
    // For radial mode the ghost is persistent (not handle-hover-dependent) so it stays
    // visible while the user tweaks controls in the UI panel.
    this._hoveredHandleId = null;
    if (this._mode !== 'radial') {
      this._cancelRaf();
      this._renderer.setGhostPreviewData(null);
    }
    if (this._lockedMeshId && this._mode !== 'radial') {
      const mesh = this._ctx.getAllMeshes().find(m => m.id === this._lockedMeshId);
      if (mesh) this._renderer.setFaceHandleData(this._buildFaceHandleData(mesh, null));
    }
    this._ctx.scheduleRender();
  }

  private _onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (!this._lockedMeshId) return;

    if (this._mode === 'radial') {
      this._commit(this._lockedMeshId, null);
    } else if (this._hoveredHandleId) {
      this._commit(this._lockedMeshId, this._hoveredHandleId);
    }
  }

  private _onWheel(e: WheelEvent): void {
    if (!this._lockedMeshId) return;
    e.preventDefault();
    this.setCount(this._count + (e.deltaY < 0 ? 1 : -1));
    this._ctx.scheduleRender();
  }

  // ── Mesh enter logic ────────────────────────────────────────────────────────

  private _onMeshEnter(mesh: Mesh3D): void {
    if (this._mode === 'radial') {
      // Radial: no face arrows — immediately show orbital ring ghost
      this._startFade();
      this._uploadGhost(mesh, null);
    } else {
      // Line / Grid: show face handle arrows, wait for handle hover
      this._renderer.setFaceHandleData(this._buildFaceHandleData(mesh, null));
    }
  }

  // ── Face handle computation ─────────────────────────────────────────────────

  private _buildFaceHandleData(mesh: Mesh3D, hoveredId: string | null): FaceHandleData {
    const handles: FaceHandle[] = [];
    const isGroup = this._lockedGroupSiblings.length > 1;
    const local = !isGroup && this._ctx.getOrientationMode() === 'local';
    const occupied = this._ctx.getOccupiedHandleIds(mesh.id);

    if (local) {
      const obb = this._getMeshOBBData(mesh);
      if (!obb) return { handles, hoveredId, center: [mesh.x, mesh.y, (mesh as any).z ?? 0] };
      const { cx, cy, cz, hx, hy, hz, axisX, axisY, axisZ } = obb;

      const axisBySign: ReadonlyArray<{ id: string; axis: [number,number,number]; h: number; sign: number }> = [
        { id: 'px', axis: axisX, h: hx, sign:  1 },
        { id: 'nx', axis: axisX, h: hx, sign: -1 },
        { id: 'py', axis: axisY, h: hy, sign:  1 },
        { id: 'ny', axis: axisY, h: hy, sign: -1 },
        { id: 'pz', axis: axisZ, h: hz, sign:  1 },
        { id: 'nz', axis: axisZ, h: hz, sign: -1 },
      ];
      for (const { id, axis, h, sign } of axisBySign) {
        if (occupied.has(id)) continue;
        const d = sign * FACE_OFFSET;
        handles.push({
          id,
          pos: [cx + axis[0]*h*d, cy + axis[1]*h*d, cz + axis[2]*h*d],
          dir: [axis[0]*sign, axis[1]*sign, axis[2]*sign],
          tier: 'primary',
        });
      }

      if (this._mode === 'grid') {
        for (const { id, sx, sz } of DIAGONAL) {
          if (occupied.has(id)) continue;
          const dx = axisX[0]*sx*hx*FACE_OFFSET + axisZ[0]*sz*hz*FACE_OFFSET;
          const dy = axisX[1]*sx*hx*FACE_OFFSET + axisZ[1]*sz*hz*FACE_OFFSET;
          const dz = axisX[2]*sx*hx*FACE_OFFSET + axisZ[2]*sz*hz*FACE_OFFSET;
          const dirX = axisX[0]*sx + axisZ[0]*sz;
          const dirY = axisX[1]*sx + axisZ[1]*sz;
          const dirZ = axisX[2]*sx + axisZ[2]*sz;
          const len = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ) || 1;
          handles.push({
            id,
            pos: [cx + dx, cy + dy, cz + dz],
            dir: [dirX/len, dirY/len, dirZ/len],
            tier: 'secondary',
          });
        }
      }

      return { handles, hoveredId, center: [cx, cy, cz] };
    } else {
      const { cx, cy, cz, hx, hy, hz } = isGroup
        ? this._getGroupAABB(this._lockedGroupSiblings)
        : this._getMeshAABB(mesh);

      for (const { id, dx, dy, dz } of CARDINAL) {
        if (occupied.has(id)) continue;
        handles.push({
          id,
          pos: [
            cx + dx * hx * FACE_OFFSET,
            cy + dy * hy * FACE_OFFSET,
            cz + dz * hz * FACE_OFFSET,
          ],
          dir: [dx, dy, dz],
          tier: 'primary',
        });
      }

      if (this._mode === 'grid') {
        for (const { id, sx, sz } of DIAGONAL) {
          if (occupied.has(id)) continue;
          handles.push({
            id,
            pos: [cx + sx * hx * FACE_OFFSET, cy, cz + sz * hz * FACE_OFFSET],
            dir: [sx * 0.7071, 0, sz * 0.7071],
            tier: 'secondary',
          });
        }
      }

      return { handles, hoveredId, center: [cx, cy, cz] };
    }
  }

  // ── Ghost instance computation ──────────────────────────────────────────────

  private _uploadGhost(mesh: Mesh3D, handleId: string | null): void {
    const isGroup = this._lockedGroupSiblings.length > 1;
    let vertices: Float32Array;
    let indices: Uint32Array;

    if (isGroup) {
      const { cx, cy, cz } = this._getGroupAABB(this._lockedGroupSiblings);
      const merged = this._mergeGroupGeometry(this._lockedGroupSiblings, cx, cy, cz);
      if (!merged) return;
      vertices = merged.vertices;
      indices  = merged.indices;
    } else {
      const geom = mesh.geometry;
      if (!geom || geom.vertices.length === 0) return;
      vertices = geom.vertices;
      indices  = geom.indices;
    }

    const instances = this._computeGhostInstances(mesh, handleId);
    if (instances.length === 0) {
      this._renderer.setGhostPreviewData(null);
      return;
    }

    const elapsed = performance.now() - this._fadeStart;
    const alpha = Math.min(1, elapsed / GHOST_FADE_MS) * GHOST_ALPHA;

    this._renderer.setGhostPreviewData({ vertices, indices, instances, alpha });
  }

  private _computeGhostInstances(mesh: Mesh3D, handleId: string | null): GhostInstance[] {
    const isGroup = this._lockedGroupSiblings.length > 1;
    const local = !isGroup && this._ctx.getOrientationMode() === 'local';

    // Resolve center + half-extents + axes (world mode uses AABB; local uses OBB)
    let bx: number, by: number, bz: number;
    let hx: number, hy: number, hz: number;
    let axisX: [number,number,number] = [1,0,0];
    let axisY: [number,number,number] = [0,1,0];
    let axisZ: [number,number,number] = [0,0,1];

    if (isGroup) {
      ({ cx: bx, cy: by, cz: bz, hx, hy, hz } = this._getGroupAABB(this._lockedGroupSiblings));
    } else if (local) {
      const obb = this._getMeshOBBData(mesh);
      if (!obb) return [];
      // Use mesh origin for base position — matches srcMat[12/13/14] in the renderer.
      // AABB/OBB center only used for half-extents and axes.
      ({ hx, hy, hz, axisX, axisY, axisZ } = obb);
      bx = mesh.x; by = mesh.y; bz = (mesh as any).z ?? 0;
    } else {
      ({ hx, hy, hz } = this._getMeshAABB(mesh));
      bx = mesh.x; by = mesh.y; bz = (mesh as any).z ?? 0;
    }

    // Source transform — ghosts inherit rotation + scale
    const baseRx = mesh.rotationX ?? 0;
    const baseRy = mesh.rotationY ?? 0;
    const baseRz = (mesh as any).rotation ?? 0;
    const scX = (mesh as any).scaleX ?? 1;
    const scY = (mesh as any).scaleY ?? 1;
    const scZ = (mesh as any).scaleZ ?? 1;

    const mkGhost = (ox: number, oy: number, oz: number): GhostInstance => ({
      x: bx + ox, y: by + oy, z: bz + oz,
      rx: isGroup ? 0 : baseRx,
      ry: isGroup ? 0 : baseRy,
      rz: isGroup ? 0 : baseRz,
      sx: isGroup ? 1 : scX,
      sy: isGroup ? 1 : scY,
      sz: isGroup ? 1 : scZ,
    });

    const instances: GhostInstance[] = [];
    const n = this._count;

    // ── Radial ──────────────────────────────────────────────────────────
    if (this._mode === 'radial') {
      const halfDiag = Math.sqrt(hx * hx + hy * hy + hz * hz) * 2;
      const autoRadius = Math.max(halfDiag * 1.5, hx * 2, hz * 2);
      const radius = this._radialRadius ?? autoRadius;
      const arcRad = this._radialArc * Math.PI / 180;
      const step = n > 0 ? arcRad / n : 0;
      // Choose the two axes that span the ring plane based on _radialAxis.
      // axis='y' → ring in XZ plane (sin→X, cos→Z)
      // axis='x' → ring in YZ plane (sin→Y, cos→Z)
      // axis='z' → ring in XY plane (cos→X, sin→Y)
      let ta: [number,number,number], tb: [number,number,number];
      if (this._radialAxis === 'x')      { ta = axisY; tb = axisZ; }
      else if (this._radialAxis === 'z') { ta = axisX; tb = axisY; }
      else                               { ta = axisX; tb = axisZ; }
      for (let i = 0; i < n; i++) {
        const a = i * step;
        const s = Math.sin(a), c = Math.cos(a);
        const [pa, pb] = this._radialAxis === 'z' ? [c, s] : [s, c];
        instances.push(mkGhost(
          ta[0]*radius*pa + tb[0]*radius*pb,
          ta[1]*radius*pa + tb[1]*radius*pb,
          ta[2]*radius*pa + tb[2]*radius*pb,
        ));
      }
      return instances;
    }

    if (!handleId) return instances;

    // ── Resolve the step vector for this handle ──────────────────────
    // Maps handle ID → (axis direction, half-extent) using the resolved axes.
    const getCardinalStep = (id: string): [number,number,number] | null => {
      switch (id) {
        case 'px': return [axisX[0]*(hx*2)*SPACING_GAP, axisX[1]*(hx*2)*SPACING_GAP, axisX[2]*(hx*2)*SPACING_GAP];
        case 'nx': return [-axisX[0]*(hx*2)*SPACING_GAP, -axisX[1]*(hx*2)*SPACING_GAP, -axisX[2]*(hx*2)*SPACING_GAP];
        case 'py': return [axisY[0]*(hy*2)*SPACING_GAP, axisY[1]*(hy*2)*SPACING_GAP, axisY[2]*(hy*2)*SPACING_GAP];
        case 'ny': return [-axisY[0]*(hy*2)*SPACING_GAP, -axisY[1]*(hy*2)*SPACING_GAP, -axisY[2]*(hy*2)*SPACING_GAP];
        case 'pz': return [axisZ[0]*(hz*2)*SPACING_GAP, axisZ[1]*(hz*2)*SPACING_GAP, axisZ[2]*(hz*2)*SPACING_GAP];
        case 'nz': return [-axisZ[0]*(hz*2)*SPACING_GAP, -axisZ[1]*(hz*2)*SPACING_GAP, -axisZ[2]*(hz*2)*SPACING_GAP];
        default:   return null;
      }
    };

    // ── Line (and cardinal handles in grid mode) ─────────────────────
    if (this._mode === 'line' || !DIAGONAL.some(d => d.id === handleId)) {
      const step = getCardinalStep(handleId);
      if (!step) return instances;
      for (let i = 1; i <= n; i++) {
        instances.push(mkGhost(i*step[0], i*step[1], i*step[2]));
      }
      return instances;
    }

    // ── Grid (diagonal handle) ───────────────────────────────────────
    const diag = DIAGONAL.find(d => d.id === handleId);
    if (!diag) return instances;

    // Step along localX and localZ (or worldX and worldZ in world mode)
    const stepA: [number,number,number] = [axisX[0]*(hx*2)*SPACING_GAP*diag.sx, axisX[1]*(hx*2)*SPACING_GAP*diag.sx, axisX[2]*(hx*2)*SPACING_GAP*diag.sx];
    const stepB: [number,number,number] = [axisZ[0]*(hz*2)*SPACING_GAP*diag.sz, axisZ[1]*(hz*2)*SPACING_GAP*diag.sz, axisZ[2]*(hz*2)*SPACING_GAP*diag.sz];
    for (let ix = 1; ix <= n; ix++) {
      for (let iz = 1; iz <= n; iz++) {
        instances.push(mkGhost(
          ix*stepA[0] + iz*stepB[0],
          ix*stepA[1] + iz*stepB[1],
          ix*stepA[2] + iz*stepB[2],
        ));
      }
    }
    return instances;
  }

  // ── Commit ──────────────────────────────────────────────────────────────────

  private _commit(meshId: string, handleId: string | null): void {
    const meshes = this._ctx.getAllMeshes();
    const mesh = meshes.find(m => m.id === meshId);
    if (!mesh) return;

    const isGroup = this._lockedGroupSiblings.length > 1;
    const sourceIds = isGroup ? this._lockedGroupSiblings.map(s => s.id) : [meshId];
    const isLocal = !isGroup && this._ctx.getOrientationMode() === 'local';
    const n = this._count;

    // Resolve axes + half-extents from the group (combined AABB) or the single mesh.
    let hx: number, hy: number, hz: number;
    let axisX: [number,number,number] = [1,0,0];
    let axisZ: [number,number,number] = [0,0,1];

    if (isGroup) {
      ({ hx, hy, hz } = this._getGroupAABB(this._lockedGroupSiblings));
    } else if (isLocal) {
      const obb = this._getMeshOBBData(mesh);
      if (!obb) return;
      ({ hx, hy, hz, axisX, axisZ } = obb);
    } else {
      ({ hx, hy, hz } = this._getMeshAABB(mesh));
    }

    const scaleVec = (axis: [number,number,number], mag: number): [number,number,number] =>
      [axis[0]*mag, axis[1]*mag, axis[2]*mag];

    if (this._mode === 'radial') {
      const halfDiag = Math.sqrt(hx * hx + hy * hy + hz * hz) * 2;
      const autoRadius = Math.max(halfDiag * 1.5, hx * 2, hz * 2);
      const radius = this._radialRadius ?? autoRadius;
      for (const srcId of sourceIds) {
        this._ctx.createRadialArray3D(srcId, n, radius, this._radialAxis, this._radialArc);
      }
    } else if (handleId) {
      const isDiagonal = DIAGONAL.some(d => d.id === handleId);

      if (this._mode === 'grid' && isDiagonal) {
        const diag = DIAGONAL.find(d => d.id === handleId)!;
        const spacingX = scaleVec(axisX, diag.sx * (hx * 2) * SPACING_GAP);
        const spacingZ = scaleVec(axisZ, diag.sz * (hz * 2) * SPACING_GAP);
        for (const srcId of sourceIds) {
          this._ctx.createGridArray3D(srcId, n, spacingX, n, spacingZ, true);
        }
      } else {
        // Cardinal handle — find the matching axis
        const card = CARDINAL.find(c => c.id === handleId);
        if (!card) return;

        let spacing: [number, number, number];
        if (isLocal) {
          const obb = this._getMeshOBBData(mesh)!;
          const axisMap: Record<string, [[number,number,number], number]> = {
            px: [obb.axisX,  obb.hx], nx: [obb.axisX, -obb.hx],
            py: [obb.axisY,  obb.hy], ny: [obb.axisY, -obb.hy],
            pz: [obb.axisZ,  obb.hz], nz: [obb.axisZ, -obb.hz],
          };
          const [axis, mag] = axisMap[handleId] ?? [[1,0,0], hx];
          spacing = scaleVec(axis, Math.abs(mag) * 2 * SPACING_GAP);
          // Apply sign: for 'nx'/'ny'/'nz' the mag is negative, so scale negates it
          if (mag < 0) spacing = [-spacing[0], -spacing[1], -spacing[2]];
        } else {
          spacing = [
            card.dx * (hx * 2) * SPACING_GAP,
            card.dy * (hy * 2) * SPACING_GAP,
            card.dz * (hz * 2) * SPACING_GAP,
          ];
        }
        for (const srcId of sourceIds) {
          this._ctx.createLinearArray3D(srcId, n, spacing);
        }
      }
    }

    // Source stays selected after commit so the user can create more arrays
    // in other directions. Reset _lastSeenMeshId so checkState() rebuilds
    // handles (with the just-committed direction now filtered as occupied).
    this._clearAll();
    this._lockedMeshId = null;
    this._lockedGroupSiblings = [];
    this._lastSeenMeshId = null;
  }

  // ── Ghost fade-in animation ──────────────────────────────────────────────────

  private _startFade(): void {
    this._fadeStart = performance.now();
    this._cancelRaf();

    const tick = () => {
      const meshes = this._ctx.getAllMeshes();
      const mesh = meshes.find(m => m.id === this._lockedMeshId);
      if (!mesh) return;

      this._uploadGhost(mesh, this._hoveredHandleId);
      this._ctx.scheduleRender();

      const elapsed = performance.now() - this._fadeStart;
      if (elapsed < GHOST_FADE_MS) {
        this._rafId = requestAnimationFrame(tick);
      }
    };

    this._rafId = requestAnimationFrame(tick);
  }

  private _cancelRaf(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private _getGroupAABB(meshes: Mesh3D[]): {
    cx: number; cy: number; cz: number;
    hx: number; hy: number; hz: number;
  } {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const m of meshes) {
      const corners = m.obbCorners;
      if (corners) {
        for (const [wx, wy, wz] of corners) {
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
          if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        }
      } else {
        const mz = (m as any).z ?? 0;
        if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x;
        if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y;
        if (mz < minZ) minZ = mz; if (mz > maxZ) maxZ = mz;
      }
    }
    if (minX === Infinity) return { cx: 0, cy: 0, cz: 0, hx: 1, hy: 1, hz: 1 };
    return {
      cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, cz: (minZ + maxZ) * 0.5,
      hx: (maxX - minX) * 0.5, hy: (maxY - minY) * 0.5, hz: (maxZ - minZ) * 0.5,
    };
  }

  private _getMeshAABB(mesh: Mesh3D): {
    cx: number; cy: number; cz: number;
    hx: number; hy: number; hz: number;
  } {
    const corners = mesh.obbCorners;
    let minX = mesh.x, maxX = mesh.x;
    let minY = mesh.y, maxY = mesh.y;
    let minZ = (mesh as any).z ?? 0;
    let maxZ = (mesh as any).z ?? 0;

    if (corners) {
      minX = Infinity; maxX = -Infinity;
      minY = Infinity; maxY = -Infinity;
      minZ = Infinity; maxZ = -Infinity;
      for (const [wx, wy, wz] of corners) {
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    }

    return {
      cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5, cz: (minZ + maxZ) * 0.5,
      hx: (maxX - minX) * 0.5, hy: (maxY - minY) * 0.5, hz: (maxZ - minZ) * 0.5,
    };
  }

  /**
   * Extract OBB center, per-axis half-extents, and world-space local axes from obbCorners.
   * Corners are bit-indexed (bit0=X, bit1=Y, bit2=Z; 0=min, 1=max in local space).
   */
  private _getMeshOBBData(mesh: Mesh3D): {
    cx: number; cy: number; cz: number;
    hx: number; hy: number; hz: number;
    axisX: [number,number,number];
    axisY: [number,number,number];
    axisZ: [number,number,number];
  } | null {
    const c = mesh.obbCorners;
    if (!c || c.length < 8) return null;

    // OBB center = midpoint of diagonal-opposite corners 0 and 7
    const cx = (c[0][0] + c[7][0]) * 0.5;
    const cy = (c[0][1] + c[7][1]) * 0.5;
    const cz = (c[0][2] + c[7][2]) * 0.5;

    // Local axes: corner[0]→corner[1] = 2*hx along localX, etc.
    const norm = (dx: number, dy: number, dz: number): [number,number,number] => {
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      return [dx/len, dy/len, dz/len];
    };

    const edgeX = [c[1][0]-c[0][0], c[1][1]-c[0][1], c[1][2]-c[0][2]];
    const edgeY = [c[2][0]-c[0][0], c[2][1]-c[0][1], c[2][2]-c[0][2]];
    const edgeZ = [c[4][0]-c[0][0], c[4][1]-c[0][1], c[4][2]-c[0][2]];

    const hx = Math.sqrt(edgeX[0]**2 + edgeX[1]**2 + edgeX[2]**2) * 0.5;
    const hy = Math.sqrt(edgeY[0]**2 + edgeY[1]**2 + edgeY[2]**2) * 0.5;
    const hz = Math.sqrt(edgeZ[0]**2 + edgeZ[1]**2 + edgeZ[2]**2) * 0.5;

    return {
      cx, cy, cz, hx, hy, hz,
      axisX: norm(edgeX[0], edgeX[1], edgeX[2]),
      axisY: norm(edgeY[0], edgeY[1], edgeY[2]),
      axisZ: norm(edgeZ[0], edgeZ[1], edgeZ[2]),
    };
  }

  /**
   * Merges all sibling mesh geometries into one combined buffer, with each
   * mesh's vertices pre-transformed to world space and shifted by -(cx, cy, cz)
   * so the group AABB center becomes the local origin. Used for ghost preview.
   */
  private _mergeGroupGeometry(
    siblings: Mesh3D[],
    cx: number, cy: number, cz: number,
  ): { vertices: Float32Array; indices: Uint32Array } | null {
    const STRIDE = 12; // pos(3) + normal(3) + uv(2) + tangent(4)
    let totalV = 0, totalI = 0;
    for (const m of siblings) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      totalV += g.vertices.length / STRIDE;
      totalI += g.indices.length;
    }
    if (totalV === 0) return null;

    const mergedV = new Float32Array(totalV * STRIDE);
    const mergedI = new Uint32Array(totalI);
    let vOff = 0, iOff = 0, baseV = 0;

    for (const m of siblings) {
      const g = m.geometry;
      if (!g || g.vertices.length === 0) continue;
      const nv = g.vertices.length / STRIDE;

      // Mesh world transform (same convention as ghost-preview-renderer: T*Ry*Rx*Rz*S)
      const tx = m.x, ty = m.y, tz = m.z;
      const ry = m.rotationY, rxa = m.rotationX;
      const rz = (m as any).rotation as number ?? 0;
      const sx = (m as any).scaleX as number ?? 1;
      const sy = (m as any).scaleY as number ?? 1;
      const sz = (m as any).scaleZ as number ?? 1;

      const cY = Math.cos(ry), sY = Math.sin(ry);
      const cX = Math.cos(rxa), sX = Math.sin(rxa);
      const cZ = Math.cos(rz), sZ = Math.sin(rz);

      // R = Ry * Rx * Rz (row-major)
      const r00 = cY*cZ + sY*sX*sZ,  r01 = -cY*sZ + sY*sX*cZ,  r02 = sY*cX;
      const r10 = cX*sZ,              r11 =  cX*cZ,              r12 = -sX;
      const r20 = -sY*cZ + cY*sX*sZ, r21 =  sY*sZ + cY*sX*cZ,  r22 = cY*cX;

      for (let i = 0; i < nv; i++) {
        const src = i * STRIDE;
        const dst = (vOff + i) * STRIDE;
        const lx = g.vertices[src]     * sx;
        const ly = g.vertices[src + 1] * sy;
        const lz = g.vertices[src + 2] * sz;
        mergedV[dst]     = r00*lx + r01*ly + r02*lz + tx - cx;
        mergedV[dst + 1] = r10*lx + r11*ly + r12*lz + ty - cy;
        mergedV[dst + 2] = r20*lx + r21*ly + r22*lz + tz - cz;
        for (let k = 3; k < STRIDE; k++) mergedV[dst + k] = g.vertices[src + k];
      }

      for (let i = 0; i < g.indices.length; i++) mergedI[iOff + i] = g.indices[i] + baseV;

      vOff += nv;
      iOff += g.indices.length;
      baseV += nv;
    }

    return { vertices: mergedV, indices: mergedI };
  }

  private _clearAll(): void {
    this._cancelRaf();
    this._hoveredHandleId = null;
    this._renderer.setFaceHandleData(null);
    this._renderer.setGhostPreviewData(null);
  }
}
