/**
 * Scene3DSurfacePaint — the "paint directly on a mesh in the 3D viewport" input subsystem, extracted from
 * Scene3DManager.
 *
 * A left-drag on the target mesh raycasts to a UV [0,1] coordinate (barycentric-interpolating the hit triangle's
 * vertex UVs) and forwards it to the host's stroke handlers — the UVPaintController's begin/move/end API — so a
 * stroke on the 3D view paints the same texture as the UV pane. Alt-drag (orbit) and middle/right (pan) pass
 * through untouched; a stroke that starts off-mesh is let through to selection/orbit.
 *
 * State is just the active handlers + the drawing flag + a listener-cleanup thunk — no scene mutation, no undo.
 * Dependencies beyond the shared ctx (canvas) are a narrow host: resolve a mesh by id, the shared picker, and the
 * current camera. Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { MeshPicker } from '../../renderer/3d/mesh-picker';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import type { ManagerContext } from './manager-context';

/** Triangle-area helpers for the world-space brush: 3D surface area and UV [0,1] area of a face. */
const SurfaceDensity = {
  triArea3(V: Float32Array, a: number, b: number, c: number, s: number): number {
    const e1x = V[b * s] - V[a * s], e1y = V[b * s + 1] - V[a * s + 1], e1z = V[b * s + 2] - V[a * s + 2];
    const e2x = V[c * s] - V[a * s], e2y = V[c * s + 1] - V[a * s + 1], e2z = V[c * s + 2] - V[a * s + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    return 0.5 * Math.hypot(nx, ny, nz);
  },
  triAreaUV(u0: number, v0: number, u1: number, v1: number, u2: number, v2: number): number {
    return 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
  },
};

/** The UVPaintController stroke API a surface-paint session drives. `sizeScale` (local UV density ÷ mesh
 *  average) keeps a stroke a constant PHYSICAL size on the mesh despite unwrap stretch. */
export interface SurfacePaintHandlers {
  begin(u: number, v: number, pressure: number, sizeScale?: number): void;
  move(u: number, v: number, pressure: number, sizeScale?: number): void;
  end(): void;
  hover?(uv: [number, number] | null): void;
}

/** Narrow host surface — everything Scene3DSurfacePaint needs from the parent manager beyond the shared ctx. */
export interface Scene3DSurfacePaintHost {
  getMesh(id: string): Mesh3D | null;
  getPicker(): MeshPicker;
  getCamera(): Camera3D;
}

export class Scene3DSurfacePaint {
  private _meshId: string | null = null;
  private _handlers?: SurfacePaintHandlers;
  private _cleanup?: () => void;
  private _drawing = false;

  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DSurfacePaintHost,
  ) {}

  /**
   * Map a 3D-canvas pixel to a UV [0,1] coordinate on `mesh` by raycasting and interpolating the hit triangle's
   * vertex UVs with the pick's barycentric weights. Returns null when the ray misses the mesh or it has no UVs.
   */
  private _screenToMeshUV(px: number, py: number, w: number, h: number, mesh: Mesh3D): { u: number; v: number; sizeScale: number } | null {
    const geom = mesh.geometry;
    if (!geom?.vertices || !geom.indices) return null;
    const camera = this.host.getCamera();
    const hit = this.host.getPicker().pickMesh(px, py, w, h, camera, [mesh]);
    if (!hit || hit.mesh.id !== mesh.id) return null;
    const stride = 12; // FLOATS_PER_VERT; UV at offset 6,7
    const V = geom.vertices;
    const tri3 = hit.triangleIndex * 3;
    const i0 = geom.indices[tri3 + 0], i1 = geom.indices[tri3 + 1], i2 = geom.indices[tri3 + 2];
    const u0 = V[i0 * stride + 6], v0 = V[i0 * stride + 7];
    const u1 = V[i1 * stride + 6], v1 = V[i1 * stride + 7];
    const u2 = V[i2 * stride + 6], v2 = V[i2 * stride + 7];
    const w0 = 1 - hit.baryU - hit.baryV; // weight of indices[tri3+0]
    // Local UV texel density of the hit triangle vs the mesh average → a brush-size scale that keeps the
    // stroke a CONSTANT physical size on the surface where the unwrap is stretched (cylinder caps, big part
    // in a small atlas cell). density = sqrt(uvArea / surfaceArea); scale = local ÷ average, clamped.
    const surfA = SurfaceDensity.triArea3(V, i0, i1, i2, stride);
    const uvA = SurfaceDensity.triAreaUV(u0, v0, u1, v1, u2, v2);
    const localDensity = surfA > 1e-12 ? Math.sqrt(uvA / surfA) : 0;
    const avg = this._avgDensity(mesh, geom);
    let sizeScale = avg > 1e-9 && localDensity > 0 ? localDensity / avg : 1;
    sizeScale = sizeScale < 0.25 ? 0.25 : sizeScale > 4 ? 4 : sizeScale;   // clamp so cap-pinch dabs don't vanish/explode
    return {
      u: w0 * u0 + hit.baryU * u1 + hit.baryV * u2,
      v: w0 * v0 + hit.baryU * v1 + hit.baryV * v2,
      sizeScale,
    };
  }

  /** mesh id → { geometry signature, area-weighted mean UV density } — the reference the per-dab scale is
   *  relative to. Recomputed only when the geometry changes (cheap signature on vert/index counts). */
  private _densityCache = new Map<string, { sig: string; avg: number }>();
  private _avgDensity(mesh: Mesh3D, geom: { vertices: Float32Array; indices: Uint32Array | Uint16Array }): number {
    const sig = geom.vertices.length + ':' + geom.indices.length;
    const cached = this._densityCache.get(mesh.id);
    if (cached && cached.sig === sig) return cached.avg;
    const stride = 12, V = geom.vertices, I = geom.indices;
    let sumUV = 0, sumSurf = 0;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      sumSurf += SurfaceDensity.triArea3(V, a, b, c, stride);
      sumUV += SurfaceDensity.triAreaUV(V[a * stride + 6], V[a * stride + 7], V[b * stride + 6], V[b * stride + 7], V[c * stride + 6], V[c * stride + 7]);
    }
    const avg = sumSurf > 1e-12 ? Math.sqrt(sumUV / sumSurf) : 1;
    this._densityCache.set(mesh.id, { sig, avg });
    return avg;
  }

  /** Public: map a 3D-canvas client point to a UV [0,1] on `meshId` (raycast + barycentric UV) — used by the
   *  decal STAMP tool (Mode B) to composite a decal image into the mesh's texture at the clicked surface point. */
  screenToMeshUV3D(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, meshId: string): { u: number; v: number } | null {
    const mesh = this.host.getMesh(meshId);
    const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
    if (!mesh || !canvas) return null;
    const px = (clientX - rect.left) * (canvas.width / rect.width);
    const py = (clientY - rect.top) * (canvas.height / rect.height);
    const r = this._screenToMeshUV(px, py, canvas.width, canvas.height, mesh);
    return r ? { u: r.u, v: r.v } : null;   // public contract is {u,v}; sizeScale is internal to live painting
  }

  /**
   * Enter 3D surface-paint input for `meshId`: left-drag on the mesh in the viewport raycasts to a UV coord and
   * calls `handlers` (the UVPaintController's stroke API). Alt-drag (orbit) and middle/right (pan) pass through.
   * The host (ShapeManager) calls this alongside the UV-pane paint controller so a stroke on either view paints
   * the same texture.
   */
  enter(meshId: string, handlers: SurfacePaintHandlers): void {
    this.exit();
    this._meshId = meshId;
    this._handlers = handlers;

    const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
    if (!canvas) return;

    const uvAt = (e: PointerEvent): { u: number; v: number; sizeScale: number } | null => {
      const mesh = this.host.getMesh(meshId);
      if (!mesh) return null;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const py = (e.clientY - rect.top) * (canvas.height / rect.height);
      return this._screenToMeshUV(px, py, canvas.width, canvas.height, mesh);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || !this._handlers) return; // alt = orbit
      const uv = uvAt(e);
      if (!uv) return; // missed the mesh → let it through (orbit / select / pan)
      e.stopImmediatePropagation();
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this._drawing = true;
      this._handlers.begin(uv.u, uv.v, e.pressure || 1, uv.sizeScale);
    };
    const onMove = (e: PointerEvent) => {
      const h = this._handlers;
      if (!h) return;
      const uv = uvAt(e);
      if (this._drawing) {
        e.stopImmediatePropagation();
        if (uv) h.move(uv.u, uv.v, e.pressure || 1, uv.sizeScale); // off-mesh → skip, keep stroke alive
      }
      // Always update the link cursor (ring on the UV pane), drawing or hovering.
      h.hover?.(uv ? [uv.u, uv.v] : null);
    };
    const onUp = (e: PointerEvent) => {
      if (!this._drawing) return;
      this._drawing = false;
      canvas.releasePointerCapture(e.pointerId);
      this._handlers?.end();
    };
    const onLeave = () => this._handlers?.hover?.(null);

    addZonelessListener(canvas, 'pointerdown',  onDown,  { capture: true });
    addZonelessListener(canvas, 'pointermove',  onMove,  { capture: true });
    addZonelessListener(canvas, 'pointerup',    onUp,    { capture: true });
    addZonelessListener(canvas, 'pointerleave', onLeave);
    this._cleanup = () => {
      removeZonelessListener(canvas, 'pointerdown',  onDown,  { capture: true } as any);
      removeZonelessListener(canvas, 'pointermove',  onMove,  { capture: true } as any);
      removeZonelessListener(canvas, 'pointerup',    onUp,    { capture: true } as any);
      removeZonelessListener(canvas, 'pointerleave', onLeave);
    };
  }

  /** Exit 3D surface-paint input. */
  exit(): void {
    if (this._drawing) { this._handlers?.end(); this._drawing = false; }
    this._cleanup?.();
    this._cleanup = undefined;
    this._handlers = undefined;
    this._meshId = null;
  }

  /** Raycast a screen point against SEVERAL meshes, returning the net UV of the closest hit (or null). Used by
   *  packaging surface-paint: the box is 6 panels sharing one dieline, so a stroke on any panel maps to that
   *  panel's UV region of the shared texture. */
  private _screenToMeshesUV(px: number, py: number, w: number, h: number, meshes: Mesh3D[]): { u: number; v: number } | null {
    if (!meshes.length) return null;
    const camera = this.host.getCamera();
    const hit = this.host.getPicker().pickMesh(px, py, w, h, camera, meshes);   // nearest hit across the set
    if (!hit) return null;
    const geom = hit.mesh.geometry;
    if (!geom?.vertices || !geom.indices) return null;
    const stride = 12; // FLOATS_PER_VERT; UV at offset 6,7
    const tri3 = hit.triangleIndex * 3;
    const i0 = geom.indices[tri3 + 0], i1 = geom.indices[tri3 + 1], i2 = geom.indices[tri3 + 2];
    const u0 = geom.vertices[i0 * stride + 6], v0 = geom.vertices[i0 * stride + 7];
    const u1 = geom.vertices[i1 * stride + 6], v1 = geom.vertices[i1 * stride + 7];
    const u2 = geom.vertices[i2 * stride + 6], v2 = geom.vertices[i2 * stride + 7];
    const w0 = 1 - hit.baryU - hit.baryV;
    return { u: w0 * u0 + hit.baryU * u1 + hit.baryV * u2, v: w0 * v0 + hit.baryU * v1 + hit.baryV * v2 };
  }

  /** Multi-mesh variant of {@link enter}: raycast a SET of meshes (the box's panels) and paint whichever is hit.
   *  The panel ids are resolved per-event so a hierarchy rebuild (setDimensions) is safe. */
  enterMulti(meshIds: string[], handlers: SurfacePaintHandlers): void {
    this.exit();
    this._meshId = meshIds[0] ?? null;
    this._handlers = handlers;

    const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
    if (!canvas) return;

    const uvAt = (e: PointerEvent): { u: number; v: number } | null => {
      const meshes = meshIds.map(id => this.host.getMesh(id)).filter((m): m is Mesh3D => !!m);
      if (!meshes.length) return null;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const py = (e.clientY - rect.top) * (canvas.height / rect.height);
      return this._screenToMeshesUV(px, py, canvas.width, canvas.height, meshes);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey || !this._handlers) return; // alt = orbit
      const uv = uvAt(e);
      if (!uv) return; // missed the box → let it through (orbit / select / pan)
      e.stopImmediatePropagation();
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this._drawing = true;
      this._handlers.begin(uv.u, uv.v, e.pressure || 1);
    };
    const onMove = (e: PointerEvent) => {
      const hnd = this._handlers;
      if (!hnd) return;
      const uv = uvAt(e);
      if (this._drawing) {
        e.stopImmediatePropagation();
        if (uv) hnd.move(uv.u, uv.v, e.pressure || 1);
      }
      hnd.hover?.(uv ? [uv.u, uv.v] : null);
    };
    const onUp = (e: PointerEvent) => {
      if (!this._drawing) return;
      this._drawing = false;
      canvas.releasePointerCapture(e.pointerId);
      this._handlers?.end();
    };
    const onLeave = () => this._handlers?.hover?.(null);

    addZonelessListener(canvas, 'pointerdown',  onDown,  { capture: true });
    addZonelessListener(canvas, 'pointermove',  onMove,  { capture: true });
    addZonelessListener(canvas, 'pointerup',    onUp,    { capture: true });
    addZonelessListener(canvas, 'pointerleave', onLeave);
    this._cleanup = () => {
      removeZonelessListener(canvas, 'pointerdown',  onDown,  { capture: true } as any);
      removeZonelessListener(canvas, 'pointermove',  onMove,  { capture: true } as any);
      removeZonelessListener(canvas, 'pointerup',    onUp,    { capture: true } as any);
      removeZonelessListener(canvas, 'pointerleave', onLeave);
    };
  }
}
