/**
 * Scene3DSurfacePaint — the "paint directly on a mesh in the 3D viewport" input subsystem, extracted from
 * Scene3DManager.
 *
 * A left-drag on the target mesh raycasts to a UV [0,1] coordinate (barycentric-interpolating the hit triangle's
 * vertex UVs) and forwards it to the host's stroke handlers — the UVPaintController's begin/move/end API — so a
 * stroke on the 3D view paints the same texture as the UV pane. Alt-drag (orbit) and middle/right (pan) pass
 * through untouched; a stroke that starts off-mesh is let through to selection/orbit. Touch: fingers are never
 * consumed (the orbit controller pinches / two-finger orbits) and a second finger takes the stroke back — see
 * {@link SurfacePaintGesture} (mobile-parity 7.3b P1).
 *
 * State is just the active handlers + the pointer state machine + a listener-cleanup thunk — no scene mutation, no undo.
 * Dependencies beyond the shared ctx (canvas) are a narrow host: resolve a mesh by id, the shared picker, and the
 * current camera. Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { MeshPicker } from '../../renderer/3d/mesh-picker';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { claimPointerEvent } from '../../renderer/util/pointer-claims';
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

/** A stroke's start info: the PointerEvent's pointerType (a finger gets the brush's touch smoothing cap — S1) and
 *  its timeStamp (S8). */
export interface SurfaceStrokeInfo { pointerType?: string; timestamp?: number }

/** The UVPaintController stroke API a surface-paint session drives. `sizeScale` (local UV density ÷ mesh
 *  average) keeps a stroke a constant PHYSICAL size on the mesh despite unwrap stretch. `timestamp` = the
 *  sample's PointerEvent.timeStamp. */
export interface SurfacePaintHandlers {
  begin(u: number, v: number, pressure: number, sizeScale?: number, info?: SurfaceStrokeInfo): void;
  move(u: number, v: number, pressure: number, sizeScale?: number, timestamp?: number): void;
  end(timestamp?: number): void;
  /** Abandon the stroke and put its paint back (P1: a second finger turned it into a pinch). Absent → end(). */
  cancel?(): void;
  hover?(uv: [number, number] | null): void;
  /** Whether hover() has anyone to show the link cursor to right now (the UV pane is attached). False → the
   *  per-move hover raycast is skipped (P2). Absent = always wanted. */
  wantsHover?(): boolean;
}

/** A UV hit of the surface raycast (sizeScale only for the single-mesh path). */
export type SurfaceUVHit = { u: number; v: number; sizeScale?: number };
type ClientRect = { left: number; top: number; width: number; height: number };

/** What {@link SurfacePaintGesture} needs from its canvas (DOM-free, so the state machine is unit tested). */
export interface SurfaceGestureIO {
  /** The canvas client rect (read once per gesture, P2). */
  measure(): ClientRect;
  /** Raycast a client point to the mesh UV, or null on a miss. */
  uvAt(clientX: number, clientY: number, rect: ClientRect): SurfaceUVHit | null;
  capture(pointerId: number): void;
  release(pointerId: number): void;
  /** requestAnimationFrame / cancelAnimationFrame (the touch first-dab delay). */
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}

/** The PointerEvent fields the gesture reads (a real PointerEvent satisfies it). */
type GesturePointer = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary' | 'button' | 'buttons' | 'altKey'
  | 'clientX' | 'clientY' | 'pressure' | 'timeStamp' | 'stopImmediatePropagation' | 'preventDefault'>
  & { getCoalescedEvents?: () => GesturePointer[] };

/**
 * P1 (mobile-parity 7.3b) — the surface-paint pointer state machine, shared by the single- and multi-mesh paths.
 *
 *  - MOUSE / PEN: unchanged — a left press on the mesh starts the stroke at once and is consumed
 *    (stopImmediatePropagation), so orbit / select never see it.
 *  - TOUCH: never consumed — the OrbitController must see every finger to pinch / two-finger orbit (in its
 *    altOrbitOnly scheme one finger is a no-op for the camera). The stroke's first dab waits ~1 frame or
 *    {@link TOUCH_START_PX} of movement, so a second finger landing right away makes a gesture with no paint at all.
 *  - A SECOND TOUCH ends the stroke and puts its paint back (handlers.cancel), then nothing is consumed or painted
 *    until every finger has lifted ('blocked'). `!isPrimary` pointers never start a stroke; one pointer owns a stroke.
 *  - pointercancel / lostpointercapture / a move with no button held end the stroke — it can never stay stuck.
 *  - Hover (no stroke) raycasts only when a consumer wants it (the UV pane's link cursor), never for a finger and
 *    never while two fingers are down (P2). Coalesced samples are raycast too, at most {@link MAX_SAMPLES} per event.
 */
export class SurfacePaintGesture {
  /** Finger movement (CSS px) that starts a touch stroke before its first frame. */
  static readonly TOUCH_START_PX = 8;
  /** Coalesced samples raycast per pointermove (evenly picked, the last always kept): each is a CPU raycast. */
  static readonly MAX_SAMPLES = 4;

  private mode: 'idle' | 'pending' | 'drawing' | 'blocked' = 'idle';
  private readonly touches = new Set<number>();
  private strokeId: number | null = null;
  private rect: ClientRect | null = null;
  private frame = 0;
  /** The touch stroke waiting for its first dab: the press + any samples since. */
  private pend: { x: number; y: number; pointerType: string; t: number; pressure: number; hit: SurfaceUVHit;
                  queued: Array<{ hit: SurfaceUVHit; pressure: number; t: number }> } | null = null;

  constructor(private readonly io: SurfaceGestureIO, private readonly handlers: () => SurfacePaintHandlers | undefined) {}

  /** Diagnostics / tests. */
  get state(): 'idle' | 'pending' | 'drawing' | 'blocked' { return this.mode; }
  get touchCount(): number { return this.touches.size; }

  down(e: GesturePointer): void {
    const touch = e.pointerType === 'touch';
    if (touch) {
      // The primary finger starts a new contact sequence: any ids still tracked are stale (a missed up).
      if (e.isPrimary && (this.mode === 'idle' || this.mode === 'blocked')) { this.touches.clear(); this.mode = 'idle'; }
      this.touches.add(e.pointerId);
      if (this.touches.size >= 2) { this.abortForGesture(); return; }   // pinch / orbit — never consumed
    }
    if (this.mode !== 'idle') return;          // blocked (fingers still down) or a stroke already owns a pointer
    if (e.isPrimary === false) return;
    const h = this.handlers();
    if (e.button !== 0 || e.altKey || !h) return;   // alt = orbit
    const rect = this.io.measure();
    const hit = this.io.uvAt(e.clientX, e.clientY, rect);
    if (!hit) return;                          // missed the mesh → let it through (orbit / select / pan)
    this.rect = rect;
    this.strokeId = e.pointerId;
    e.preventDefault();
    this.io.capture(e.pointerId);
    const pressure = e.pressure || 1;
    if (touch) {
      claimPointerEvent(e);   // not stopped (the orbit controller must see the finger), but no other TOOL acts on it
      this.mode = 'pending';
      this.pend = { x: e.clientX, y: e.clientY, pointerType: e.pointerType, t: e.timeStamp, pressure, hit, queued: [] };
      this.frame = this.io.requestFrame(() => { this.frame = 0; this.commitPending(); });
      return;
    }
    e.stopImmediatePropagation();
    this.mode = 'drawing';
    h.begin(hit.u, hit.v, pressure, hit.sizeScale, { pointerType: e.pointerType, timestamp: e.timeStamp });
  }

  move(e: GesturePointer): void {
    const touch = e.pointerType === 'touch';
    if (this.mode === 'blocked' || this.touches.size >= 2) return;   // a gesture: no paint, no hover raycasts
    const h = this.handlers();
    if (!h) return;
    if ((this.mode === 'drawing' || this.mode === 'pending') && e.pointerId === this.strokeId) {
      if (!touch) e.stopImmediatePropagation();   // a finger's moves still reach the orbit controller (its tracking)
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) { this.up(e); return; }   // the up was missed
      const rect = this.rect ?? this.io.measure();
      let last: SurfaceUVHit | null = null;
      for (const s of this.samplesOf(e)) {
        const hit = this.io.uvAt(s.clientX, s.clientY, rect);
        last = hit;
        if (!hit) continue;                      // off-mesh → skip, keep the stroke alive
        const pressure = s.pressure || 1;
        if (this.mode === 'pending') this.pend!.queued.push({ hit, pressure, t: s.timeStamp });
        else h.move(hit.u, hit.v, pressure, hit.sizeScale, s.timeStamp);
      }
      if (this.mode === 'pending') {
        const p = this.pend!;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= SurfacePaintGesture.TOUCH_START_PX) this.commitPending();
        return;
      }
      if (h.hover && (!h.wantsHover || h.wantsHover())) h.hover(last ? [last.u, last.v] : null);
      return;
    }
    if (this.mode !== 'idle' || touch) return;   // another pointer during a stroke; a finger has no hover
    // Hover → the link cursor ring on the UV pane — only when someone shows it (P2: no raycast otherwise).
    if (!h.hover || (h.wantsHover && !h.wantsHover())) return;
    const hit = this.io.uvAt(e.clientX, e.clientY, this.io.measure());
    h.hover(hit ? [hit.u, hit.v] : null);
  }

  up(e: GesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (e.pointerId !== this.strokeId) return;
    if (this.mode === 'pending') this.commitPending();   // a quick tap still paints its dab
    if (this.mode !== 'drawing') return;
    this.finish();
    this.handlers()?.end(e.timeStamp);
  }

  /** pointercancel: the pointer is gone. A live stroke ends (it never stays stuck); a pending one paints nothing. */
  cancel(e: GesturePointer): void {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.mode === 'blocked') { if (this.touches.size === 0) this.mode = 'idle'; return; }
    if (e.pointerId !== this.strokeId) return;
    this.endForLostPointer(e.timeStamp);
  }

  /** lostpointercapture: the stroke's pointer no longer reports to the canvas — end the stroke (after a normal up
   *  it is already over: no-op). Touch tracking is left alone (the finger may still be down). */
  lostCapture(e: GesturePointer): void {
    if (e.pointerId !== this.strokeId || (this.mode !== 'drawing' && this.mode !== 'pending')) return;
    this.endForLostPointer(e.timeStamp);
  }

  /** Session exit: a live stroke ends normally, a pending one is dropped, everything resets. */
  reset(): void {
    if (this.mode === 'drawing') { this.finish(); this.handlers()?.end(); }
    else this.dropPending();
    this.mode = 'idle';
    this.touches.clear();
    this.strokeId = null;
    this.rect = null;
  }

  private endForLostPointer(t: number): void {
    if (this.mode === 'pending') { this.dropPending(); this.finish(); return; }
    if (this.mode !== 'drawing') return;
    this.finish();
    this.handlers()?.end(t);
  }

  /** The touch stroke's first dab: begin at the press, then the samples that arrived since. */
  private commitPending(): void {
    if (this.mode !== 'pending' || !this.pend) return;
    if (this.frame) { this.io.cancelFrame(this.frame); this.frame = 0; }
    const p = this.pend;
    this.pend = null;
    const h = this.handlers();
    if (!h) { this.finish(); return; }
    this.mode = 'drawing';
    h.begin(p.hit.u, p.hit.v, p.pressure, p.hit.sizeScale, { pointerType: p.pointerType, timestamp: p.t });
    for (const q of p.queued) h.move(q.hit.u, q.hit.v, q.pressure, q.hit.sizeScale, q.t);
  }

  /** A second finger: the stroke becomes a gesture — its paint is put back, nothing is painted until all lift. */
  private abortForGesture(): void {
    const h = this.handlers();
    if (this.mode === 'pending') { this.dropPending(); this.release(); }
    else if (this.mode === 'drawing') {
      this.release();
      if (h?.cancel) h.cancel(); else h?.end();
    }
    this.mode = 'blocked';
    this.strokeId = null;
    this.rect = null;
    h?.hover?.(null);
  }

  private dropPending(): void {
    if (this.frame) { this.io.cancelFrame(this.frame); this.frame = 0; }
    this.pend = null;
  }

  private finish(): void {
    this.release();
    this.mode = 'idle';
    this.rect = null;
  }

  private release(): void {
    if (this.strokeId !== null) this.io.release(this.strokeId);
    this.strokeId = null;
  }

  /** The event's coalesced samples (S2), at most MAX_SAMPLES of them — evenly picked, the newest always kept. */
  private samplesOf(e: GesturePointer): GesturePointer[] {
    let list: GesturePointer[] | null = null;
    try { list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null; } catch { list = null; }
    if (!list || list.length === 0) return [e];
    const n = list.length, max = SurfacePaintGesture.MAX_SAMPLES;
    if (n <= max) return list;
    const out: GesturePointer[] = [];
    for (let k = 1; k <= max; k++) out.push(list[Math.round((k * n) / max) - 1]);
    return out;
  }
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
  /** The live pointer state machine (P1) — null outside a session. */
  private _gesture: SurfacePaintGesture | null = null;

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

    this._bind(canvas, (clientX, clientY, rect) => {
      const mesh = this.host.getMesh(meshId);
      if (!mesh) return null;
      const px = (clientX - rect.left) * (canvas.width / rect.width);
      const py = (clientY - rect.top) * (canvas.height / rect.height);
      return this._screenToMeshUV(px, py, canvas.width, canvas.height, mesh);
    });
  }

  /** Wire the canvas pointer events to a {@link SurfacePaintGesture} (P1) that raycasts with `uvAt`. Shared by the
   *  single- and multi-mesh paths. */
  private _bind(canvas: HTMLCanvasElement, uvAt: SurfaceGestureIO['uvAt']): void {
    const raf = typeof requestAnimationFrame === 'function';
    const gesture = new SurfacePaintGesture({
      measure: () => canvas.getBoundingClientRect(),
      uvAt,
      capture: (id) => { try { canvas.setPointerCapture(id); } catch { /* pointer already gone */ } },
      release: (id) => { try { if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); } catch { /* gone */ } },
      requestFrame: (cb) => (raf ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
      cancelFrame: (id) => { if (raf) cancelAnimationFrame(id); else clearTimeout(id); },
    }, () => this._handlers);
    this._gesture = gesture;

    const onDown = (e: PointerEvent) => gesture.down(e);
    const onMove = (e: PointerEvent) => gesture.move(e);
    const onUp = (e: PointerEvent) => gesture.up(e);
    const onCancel = (e: PointerEvent) => gesture.cancel(e);
    const onLost = (e: PointerEvent) => gesture.lostCapture(e);
    const onLeave = () => this._handlers?.hover?.(null);

    addZonelessListener(canvas, 'pointerdown',   onDown,   { capture: true });
    addZonelessListener(canvas, 'pointermove',   onMove,   { capture: true });
    addZonelessListener(canvas, 'pointerup',     onUp,     { capture: true });
    addZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
    addZonelessListener(canvas, 'lostpointercapture', onLost, { capture: true });
    addZonelessListener(canvas, 'pointerleave', onLeave);
    this._cleanup = () => {
      removeZonelessListener(canvas, 'pointerdown',   onDown,   { capture: true });
      removeZonelessListener(canvas, 'pointermove',   onMove,   { capture: true });
      removeZonelessListener(canvas, 'pointerup',     onUp,     { capture: true });
      removeZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
      removeZonelessListener(canvas, 'lostpointercapture', onLost, { capture: true });
      removeZonelessListener(canvas, 'pointerleave', onLeave);
    };
  }

  /** Exit 3D surface-paint input. */
  exit(): void {
    this._gesture?.reset();   // a live stroke ends normally; a pending touch stroke is dropped
    this._gesture = null;
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

    this._bind(canvas, (clientX, clientY, rect) => {
      const meshes = meshIds.map(id => this.host.getMesh(id)).filter((m): m is Mesh3D => !!m);
      if (!meshes.length) return null;
      const px = (clientX - rect.left) * (canvas.width / rect.width);
      const py = (clientY - rect.top) * (canvas.height / rect.height);
      return this._screenToMeshesUV(px, py, canvas.width, canvas.height, meshes);
    });
  }
}
