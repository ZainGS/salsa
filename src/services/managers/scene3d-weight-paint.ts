/**
 * Scene3DWeightPaint — the skin-weight painting mode, extracted from Scene3DManager as the first separable peel
 * off the armature "tangle" (docs/specs/armature-tangle-extraction-map.md).
 *
 * Owns weight-paint state + its own canvas-listener closure: enter/exit the mode (swapping the mesh's vertex
 * colours for a per-joint weight heatmap and back), the brush config + preview circle, the pointer-driven paint
 * stroke (pick → nearby verts → dab → renormalize → refresh heatmap), and the joint-weight math. It has its own
 * `_setupWeightPaintListeners` closure — independent of the two gizmo/bone-overlay mega-closures — which is what
 * makes it separable ahead of the rest of the tangle.
 *
 * GPU/canvas/picker-coupled, so browser-verified rather than unit-tested. The one outward coupling is that the
 * bone-overlay closure (still on the manager) gates behaviour on "not painting" — it now calls `isActive()`.
 * Dependencies beyond ctx are a narrow host: resolve a skinned mesh, the orbit controller (disabled while
 * painting), the camera, and the shared pick/near-verts utilities that stay on the manager. Scene3DManager keeps
 * thin delegating methods so the public API and every caller are unchanged.
 */

import type { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { OrbitController } from '../../renderer/3d/orbit-controller';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import { mat4, vec4 } from 'gl-matrix';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import type { ManagerContext } from './manager-context';

/** A raycast hit from the manager's shared picker. */
export interface WeightPaintPickHit {
  meshId: string;
  hitPoint: [number, number, number];
}

/** Narrow host surface — everything Scene3DWeightPaint needs from the parent manager beyond the shared ctx. */
export interface Scene3DWeightPaintHost {
  getSkinnedMesh(id: string): SkinnedMesh3D | null;
  getOrbitController(): OrbitController | null;
  getCamera(): Camera3D;
  pickFromClient3D(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): WeightPaintPickHit | null;
  getVerticesNearPoint3D(meshId: string, wx: number, wy: number, wz: number, radius: number): number[];
}

export class Scene3DWeightPaint {
  private _meshId: string | null = null;
  private _jointIndex: number | null = null;
  private _savedColors: Float32Array | null = null;
  private _listenerCleanup?: () => void;
  private _brushRadius = 0.3;
  private _brushStrength = 0.2;
  private _targetWeight = 1.0;
  private _pointerDown = false;
  private _brushCircle: HTMLDivElement | null = null;
  private _brushCenter: [number, number, number] | null = null;

  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DWeightPaintHost,
  ) {}

  private get _renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }

  /** Whether weight paint mode is currently active. (The bone-overlay closure gates "not painting" on this.) */
  isActive(): boolean { return this._meshId !== null; }

  enterWeightPaintMode3D(meshId: string, _skeletonId: string, jointIndex: number): boolean {
    const mesh = this.host.getSkinnedMesh(meshId);
    if (!mesh) return false;
    this._meshId = meshId;
    this._jointIndex = jointIndex;
    this._savedColors = mesh.vertexColors ? new Float32Array(mesh.vertexColors) : null;
    this._applyWeightHeatmap(meshId, jointIndex);
    this._renderer3D.setWeightPaintActive(true);
    this._renderer3D.setWeightPaintMesh(mesh);
    this._renderer3D.setWeightPaintBrushRadius(this._brushRadius);
    this._renderer3D.setWeightPaintBrushCenter(null);
    const orbit = this.host.getOrbitController();
    if (orbit) orbit.enabled = false;
    this._setupWeightPaintListeners();
    return true;
  }

  /** Switch the active weight-paint joint without re-entering the mode. Refreshes the heatmap for the new joint. */
  setWeightPaintJoint3D(jointIndex: number): void {
    if (!this._meshId) return;
    this._jointIndex = jointIndex;
    this._applyWeightHeatmap(this._meshId, jointIndex);
  }

  private _applyWeightHeatmap(meshId: string, jointIndex: number): void {
    const mesh = this.host.getSkinnedMesh(meshId);
    if (!mesh) return;
    const vertCount = mesh.geometry.vertices.length / 12; // 12 floats per vertex
    if (!mesh.vertexColors || mesh.vertexColors.length !== vertCount * 4) {
      mesh.vertexColors = new Float32Array(vertCount * 4);
    }
    for (let vi = 0; vi < vertCount; vi++) {
      let w = 0;
      for (let k = 0; k < 4; k++) {
        if (mesh.jointIndices[vi * 4 + k] === jointIndex) {
          w = mesh.jointWeights[vi * 4 + k];
          break;
        }
      }
      // Heat color: 0→blue, 0.5→green, 1→red
      let r: number, g: number, b: number;
      if (w < 0.5) { r = 0; g = w * 2; b = 1 - w * 2; }
      else { r = (w - 0.5) * 2; g = 1 - (w - 0.5) * 2; b = 0; }
      mesh.vertexColors[vi * 4 + 0] = r;
      mesh.vertexColors[vi * 4 + 1] = g;
      mesh.vertexColors[vi * 4 + 2] = b;
      mesh.vertexColors[vi * 4 + 3] = 1;
    }
    this.ctx.scheduleRender();
  }

  /** Paint weights on a set of vertices. Normalizes all weights after each stroke. */
  paintWeightDab3D(meshId: string, jointIndex: number, vertexIndices: number[], targetWeight: number, brushStrength: number): void {
    const mesh = this.host.getSkinnedMesh(meshId);
    if (!mesh) return;
    for (const vi of vertexIndices) {
      const base = vi * 4;
      // Find slot for this joint, or the slot with the smallest weight
      let slot = -1;
      let minW = Infinity;
      let minSlot = 0;
      for (let k = 0; k < 4; k++) {
        if (mesh.jointIndices[base + k] === jointIndex) { slot = k; break; }
        if (mesh.jointWeights[base + k] < minW) { minW = mesh.jointWeights[base + k]; minSlot = k; }
      }
      if (slot < 0) { slot = minSlot; mesh.jointIndices[base + slot] = jointIndex; }
      const cur = mesh.jointWeights[base + slot];
      mesh.jointWeights[base + slot] = cur + (targetWeight - cur) * brushStrength;
    }
    this.normalizeWeights3D(meshId);
    if (this._jointIndex !== null) this._applyWeightHeatmap(meshId, this._jointIndex);
  }

  /** Normalize all vertex weights so each vertex's 4 weights sum to 1.0. */
  normalizeWeights3D(meshId: string): void {
    const mesh = this.host.getSkinnedMesh(meshId);
    if (!mesh) return;
    const vc = mesh.jointWeights.length / 4;
    for (let vi = 0; vi < vc; vi++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += mesh.jointWeights[vi * 4 + k];
      if (sum > 0) for (let k = 0; k < 4; k++) mesh.jointWeights[vi * 4 + k] /= sum;
    }
    mesh.skinDirty = true;
  }

  /** Exit weight-paint mode: restore saved vertex colors. */
  exitWeightPaintMode3D(): void {
    if (!this._meshId) return;
    const mesh = this.host.getSkinnedMesh(this._meshId);
    if (mesh) {
      if (mesh.editMesh) {
        const saved = this._savedColors;
        if (saved) {
          for (let vi = 0; vi < mesh.editMesh.vertices.length; vi++) {
            mesh.editMesh.vertices[vi].color = [saved[vi*4], saved[vi*4+1], saved[vi*4+2], saved[vi*4+3]];
          }
        } else {
          for (const v of mesh.editMesh.vertices) v.color = [0.8, 0.8, 0.8, 1];
        }
        mesh.syncFromEditMesh();
      } else {
        // GLB mesh — restore vertexColors directly; null = revert to material color
        mesh.vertexColors = this._savedColors
          ? new Float32Array(this._savedColors)
          : null;
      }
    }
    this._meshId = null;
    this._jointIndex = null;
    this._savedColors = null;
    this._listenerCleanup?.();
    this._listenerCleanup = undefined;
    this._pointerDown = false;
    this._brushCenter = null;
    this._renderer3D.setWeightPaintActive(false);
    this._renderer3D.setWeightPaintMesh(null);
    this._renderer3D.setWeightPaintBrushCenter(null);
    const orbit = this.host.getOrbitController();
    if (orbit) orbit.enabled = true;
    this.ctx.scheduleRender();
  }

  /** Configure the weight paint brush. Call whenever the UI sliders change. */
  setWeightPaintBrush(radius: number, strength: number, targetWeight: number): void {
    this._brushRadius  = radius;
    this._brushStrength = strength;
    this._targetWeight  = targetWeight;
    this._renderer3D.setWeightPaintBrushRadius(radius);
  }

  private _setupWeightPaintListeners(): void {
    this._listenerCleanup?.();
    const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
    if (!canvas) return;

    // Brush preview circle element
    const circle = document.createElement('div');
    circle.style.cssText = 'position:fixed;border:2px solid rgba(255,255,255,0.85);border-radius:50%;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(0,0,0,0.45);transform:translate(-50%,-50%);z-index:9999;';
    document.body.appendChild(circle);
    this._brushCircle = circle;
    canvas.style.cursor = 'none';

    const updateCircle = (e: PointerEvent) => {
      if (!this._meshId) { circle.style.display = 'none'; return; }
      const rect = canvas.getBoundingClientRect();
      const hit = this.host.pickFromClient3D(e.clientX, e.clientY, rect);
      if (!hit || hit.meshId !== this._meshId) {
        circle.style.display = 'none';
        this._brushCenter = null;
        this._renderer3D.setWeightPaintBrushCenter(null);
        this.ctx.scheduleRender();
        return;
      }
      this._brushCenter = hit.hitPoint as [number, number, number];
      this._renderer3D.setWeightPaintBrushCenter(this._brushCenter);
      this.ctx.scheduleRender();

      const cam = this.host.getCamera();
      const vp = mat4.multiply(mat4.create(),
        cam.getProjectionMatrix() as unknown as mat4,
        cam.getViewMatrix() as unknown as mat4);
      const [hx, hy, hz] = hit.hitPoint;
      const clipC = vec4.transformMat4(vec4.create(), vec4.fromValues(hx, hy, hz, 1), vp);
      const clipR = vec4.transformMat4(vec4.create(), vec4.fromValues(hx + this._brushRadius, hy, hz, 1), vp);
      if (Math.abs(clipC[3]) < 1e-6) { circle.style.display = 'none'; return; }
      const cSx = (clipC[0] / clipC[3] + 1) * 0.5 * canvas.width;
      const cSy = (1 - clipC[1] / clipC[3]) * 0.5 * canvas.height;
      const rSx = Math.abs(clipR[3]) < 1e-6 ? cSx + 1 : (clipR[0] / clipR[3] + 1) * 0.5 * canvas.width;
      const rSy = Math.abs(clipR[3]) < 1e-6 ? cSy : (1 - clipR[1] / clipR[3]) * 0.5 * canvas.height;
      const cssScale = rect.width / canvas.width;
      const radiusPx = Math.max(4, Math.sqrt((rSx - cSx) ** 2 + (rSy - cSy) ** 2) * cssScale);
      const diam = radiusPx * 2;

      circle.style.display = 'block';
      circle.style.left = e.clientX + 'px';
      circle.style.top = e.clientY + 'px';
      circle.style.width = diam + 'px';
      circle.style.height = diam + 'px';
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !this._meshId) return;
      this._pointerDown = true;
      this._doPaintStroke(e);
      e.stopPropagation();
    };
    const onPointerMove = (e: PointerEvent) => {
      updateCircle(e);
      if (!this._pointerDown || !this._meshId) return;
      this._doPaintStroke(e);
      e.stopPropagation();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      this._pointerDown = false;
    };
    const onPointerLeave = () => {
      circle.style.display = 'none';
      this._brushCenter = null;
      this._renderer3D.setWeightPaintBrushCenter(null);
      this.ctx.scheduleRender();
    };

    addZonelessListener(canvas, 'pointerdown', onPointerDown);
    addZonelessListener(canvas, 'pointermove', onPointerMove);
    addZonelessListener(canvas, 'pointerleave', onPointerLeave);
    addZonelessListener(window, 'pointerup', onPointerUp);

    this._listenerCleanup = () => {
      removeZonelessListener(canvas, 'pointerdown', onPointerDown);
      removeZonelessListener(canvas, 'pointermove', onPointerMove);
      removeZonelessListener(canvas, 'pointerleave', onPointerLeave);
      removeZonelessListener(window, 'pointerup', onPointerUp);
      circle.remove();
      this._brushCircle = null;
      canvas.style.cursor = '';
    };
  }

  private _doPaintStroke(e: PointerEvent): void {
    const meshId = this._meshId;
    const jointIndex = this._jointIndex;
    if (meshId === null || jointIndex === null) return;
    const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = this.host.pickFromClient3D(e.clientX, e.clientY, rect);
    if (!hit || hit.meshId !== meshId) return;
    const [hx, hy, hz] = hit.hitPoint;
    const verts = this.host.getVerticesNearPoint3D(meshId, hx, hy, hz, this._brushRadius);
    if (verts.length === 0) return;
    this.paintWeightDab3D(meshId, jointIndex, verts, this._targetWeight, this._brushStrength);
  }
}
