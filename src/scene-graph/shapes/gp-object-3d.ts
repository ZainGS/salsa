/**
 * GpObject3D — Grease Pencil scene-graph node.
 *
 * Owns a list of GpLayer3D, each containing GpStroke3D arrays. The renderer
 * reads the active strokes each frame and expands them to screen-space quad
 * strips. Strokes with a parentJoint are transformed by the joint's world
 * matrix in the vertex shader (zero CPU overhead).
 *
 * Keyframe animation: GpLayer3D.keyframes maps frame numbers to stroke arrays.
 * At render time the renderer calls getActiveStrokes(frame) per layer.
 */

import { Shape } from './base/shape';
import type { InteractionService } from '../../services/interaction-service';
import type { GpStroke3D, GpLayer3D, GpObject3DData } from '../../types/grease-pencil-3d';
import type { Vec2 } from '../../types/interaction';

const _uid = () => crypto.randomUUID();

type GpPointT = GpStroke3D['points'][number];

/**
 * The parts of a stroke left after removing everything within `radius` of a ray (origin + unit dir, in front of the
 * origin): null when the eraser does not touch the stroke, else the kept runs of points (each >= 2 points, may be
 * none). Each segment's inside interval solves |(P(t) - O) x d|^2 <= r^2 (a quadratic in t); cut points interpolate
 * position, pressure and opacity.
 */
export function cutStrokeByRay(stroke: GpStroke3D, origin: [number, number, number], dir: [number, number, number], radius: number): GpPointT[][] | null {
  const src = stroke.points;
  const n = src.length;
  if (n === 0) return null;
  const closed = stroke.closed && n >= 3;
  const segCount = closed ? n : n - 1;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const r2 = radius * radius;
  const inside = (p: GpPointT): boolean => {
    const vx = p.x - ox, vy = p.y - oy, vz = p.z - oz;
    const t = vx * dx + vy * dy + vz * dz;
    return t >= 0 && vx * vx + vy * vy + vz * vz - t * t <= r2;
  };
  const lerp = (a: GpPointT, b: GpPointT, t: number): GpPointT => ({
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t, opacity: a.opacity + (b.opacity - a.opacity) * t,
  });
  /** The [t0, t1] part of segment a→b inside the cylinder (clipped to [0, 1]), or null. */
  const clip = (a: GpPointT, b: GpPointT): [number, number] | null => {
    // w(t) = (a - O) + t (b - a); dist^2(t) = |w|^2 - (w.d)^2 = A t^2 + B t + C
    const wx = a.x - ox, wy = a.y - oy, wz = a.z - oz;
    const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
    const wd = wx * dx + wy * dy + wz * dz, ed = ex * dx + ey * dy + ez * dz;
    const A = ex * ex + ey * ey + ez * ez - ed * ed;
    const B = 2 * (wx * ex + wy * ey + wz * ez - wd * ed);
    const C = wx * wx + wy * wy + wz * wz - wd * wd - r2;
    let t0: number, t1: number;
    if (A < 1e-14) {                                   // parallel to the ray: all in or all out
      if (C > 0) return null;
      t0 = 0; t1 = 1;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      t0 = (-B - sq) / (2 * A); t1 = (-B + sq) / (2 * A);
    }
    t0 = Math.max(0, t0); t1 = Math.min(1, t1);
    if (t0 > t1) return null;
    const tm = (t0 + t1) * 0.5;                         // behind the camera: not under the eraser
    if (wd + tm * ed < 0) return null;
    return [t0, t1];
  };

  const runs: GpPointT[][] = [];
  let run: GpPointT[] | null = inside(src[0]) ? null : [{ ...src[0] }];
  let touched = run === null;
  for (let i = 0; i < segCount; i++) {
    const a = src[i], b = src[(i + 1) % n];
    const iv = clip(a, b);
    if (!iv) {
      if (run) run.push({ ...b });
      else run = [{ ...b }];                           // only after an end-point-only cut (a inside, b not, no interval)
      continue;
    }
    touched = true;
    const [t0, t1] = iv;
    if (run) {
      if (t0 > 0) run.push(lerp(a, b, t0));
      runs.push(run);
      run = null;
    }
    if (t1 < 1) run = [lerp(a, b, t1), { ...b }];
  }
  if (!touched) return null;
  if (run) runs.push(run);
  // A cut closed loop: the last run ends back on point 0, where the first run began — join them into one piece.
  if (closed && runs.length >= 2 && !inside(src[0])) {
    const first = runs[0], last = runs[runs.length - 1];
    const l = last[last.length - 1], f = first[0];
    if (l.x === f.x && l.y === f.y && l.z === f.z) {
      runs[0] = last.slice(0, -1).concat(first);
      runs.pop();
    }
  }
  return runs.filter(pts => {
    if (pts.length < 2) return false;
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k], q = pts[0];
      if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2 > 1e-14) return true;
    }
    return false;
  });
}

export class GpObject3D extends Shape {
  /** All layers, bottom-to-top render order. */
  public layers: GpLayer3D[] = [];
  /** Optional: ID of the CharacterData this GP object belongs to. */
  public characterId?: string;
  /** ID of the Skeleton3D that drives parentJoint references, if any. */
  public skeletonId?: string;
  /** Draw order within the GP pass. 0 = default (after particles). Negative = background. */
  public renderOrder = 0;

  constructor(interactionService: InteractionService) {
    super({ r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, 0, interactionService);
    this.name = 'GP Object';
  }

  getType(): string { return 'GpObject3D'; }

  /**
   * Like Mesh3D: a GP object is a 3D entity with NO meaningful 2D bounding box — its strokes live in 3D
   * world space and its visibility is the 3D camera's job, not the 2D viewport AABB. Returning [] makes
   * getWorldAABB() null so the renderer's 2D viewport-cull ALWAYS keeps it in the render list. Without this
   * override the base Shape returned a degenerate 2D polygon at the origin, so the GP object was culled out
   * of the render list whenever the 2D viewport wasn't over (0,0) → draw3DGp never saw it → GP never drew.
   */
  getWorldSpaceBoundingBoxPolygon(): Vec2[] { return []; }

  // ── Layer management ──────────────────────────────────────────────────────

  /** Add a new layer and return its ID. */
  addLayer(name = 'Layer'): string {
    const id = _uid();
    this.layers.push({ id, name, strokes: [], visible: true, opacity: 1, keyframes: {} });
    return id;
  }

  /** Remove a layer by ID. Returns true if found and removed. */
  removeLayer(layerId: string): boolean {
    const idx = this.layers.findIndex(l => l.id === layerId);
    if (idx < 0) return false;
    this.layers.splice(idx, 1);
    return true;
  }

  getLayer(layerId: string): GpLayer3D | null {
    return this.layers.find(l => l.id === layerId) ?? null;
  }

  // ── Stroke management ─────────────────────────────────────────────────────

  /** Re-insert a layer object (undo of removeLayer) at `index` (clamped). */
  insertLayer(layer: GpLayer3D, index: number): void {
    if (this.layers.includes(layer)) return;
    this.layers.splice(Math.max(0, Math.min(index, this.layers.length)), 0, layer);
  }

  /**
   * Append a stroke to a layer's base strokes — or, with `frame`, to that frame's keyframe list when the layer HAS a
   * keyframe there (what the viewport shows at that frame; no keyframe → the base strokes, which it shows). Returns
   * strokeId ('' if the layer is unknown).
   */
  addStroke(layerId: string, stroke: Omit<GpStroke3D, 'id'>, frame?: number): string {
    const list = this.strokeList(layerId, frame);
    if (!list) return '';
    const id = _uid();
    list.push({ id, ...stroke });
    return id;
  }

  /** The stroke array a draw / erase at `frame` edits: that frame's keyframe when the layer has one, else the base
   *  strokes. Null for an unknown layer. */
  strokeList(layerId: string, frame?: number): GpStroke3D[] | null {
    const layer = this.getLayer(layerId);
    if (!layer) return null;
    if (frame !== undefined && layer.keyframes[frame]) return layer.keyframes[frame];
    return layer.strokes;
  }

  /** Replace the stroke array {@link strokeList} resolves to (undo / redo of a draw or erase). */
  setStrokeList(layerId: string, frame: number | undefined, strokes: GpStroke3D[]): void {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    if (frame !== undefined && layer.keyframes[frame]) layer.keyframes[frame] = strokes;
    else layer.strokes = strokes;
  }

  /** Remove a stroke from a layer's base strokes (or a keyframe list). */
  removeStroke(layerId: string, strokeId: string, frame?: number): boolean {
    const layer = this.getLayer(layerId);
    if (!layer) return false;
    if (frame !== undefined && layer.keyframes[frame]) {
      const arr = layer.keyframes[frame];
      const idx = arr.findIndex(s => s.id === strokeId);
      if (idx >= 0) { arr.splice(idx, 1); return true; }
    }
    const idx = layer.strokes.findIndex(s => s.id === strokeId);
    if (idx >= 0) { layer.strokes.splice(idx, 1); return true; }
    return false;
  }

  /**
   * Erase all strokes within `radius` world units of `worldPos` on a layer.
   * Simple sphere-vs-point test on each stroke's points. Returns how many strokes were removed.
   */
  eraseStrokes(layerId: string, worldPos: [number, number, number], radius: number, frame?: number): number {
    const [ex, ey, ez] = worldPos;
    const r2 = radius * radius;
    return this._eraseWhere(layerId, frame, (p) => (p.x-ex)**2 + (p.y-ey)**2 + (p.z-ez)**2 <= r2);
  }

  /**
   * Erase the strokes that pass within `radius` world units of a RAY (the cursor's view ray: origin + unit `dir`,
   * in front of the origin) — what the eraser circle covers on screen, at any depth. A sphere around the ray's hit on
   * the current drawing plane could not reach strokes drawn on another face's plane. Returns how many were removed.
   */
  eraseStrokesNearRay(layerId: string, origin: [number, number, number], dir: [number, number, number], radius: number, frame?: number): number {
    const [ox, oy, oz] = origin;
    const [dx, dy, dz] = dir;
    const r2 = radius * radius;
    return this._eraseWhere(layerId, frame, (p) => {
      const vx = p.x - ox, vy = p.y - oy, vz = p.z - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t < 0) return false;                                   // behind the camera
      return vx * vx + vy * vy + vz * vz - t * t <= r2;          // squared distance to the ray
    });
  }

  /**
   * PARTIAL erase: cut away only the parts of strokes within `radius` of the view ray (origin + unit `dir`) — every
   * segment is clipped against that cylinder, a cut point is interpolated where a segment enters / leaves it — and
   * SPLIT a stroke where it is cut: the remaining pieces become separate strokes (new ids) that keep the colour,
   * width, fill colour, bone and per-point pressure / opacity. A cut closed loop becomes open pieces (the run across
   * the old start point stays one piece). Pieces under 2 points (or of no length) are dropped; a stroke the eraser
   * does not touch is kept as is (same object). Returns how many strokes were changed (cut or removed).
   */
  eraseStrokesNearRayPartial(layerId: string, origin: [number, number, number], dir: [number, number, number], radius: number, frame?: number): number {
    const list = this.strokeList(layerId, frame);
    if (!list) return 0;
    let changed = 0;
    const next: GpStroke3D[] = [];
    for (const s of list) {
      const pieces = cutStrokeByRay(s, origin, dir, radius);
      if (pieces === null) { next.push(s); continue; }
      changed++;
      for (const pts of pieces) next.push({ ...s, id: _uid(), points: pts, closed: false });
    }
    if (changed > 0) this.setStrokeList(layerId, frame, next);
    return changed;
  }

  private _eraseWhere(layerId: string, frame: number | undefined, hit: (p: { x: number; y: number; z: number }) => boolean): number {
    const list = this.strokeList(layerId, frame);
    if (!list) return 0;
    const kept = list.filter(s => !s.points.some(hit));
    const removed = list.length - kept.length;
    if (removed > 0) this.setStrokeList(layerId, frame, kept);
    return removed;
  }

  // ── Keyframe animation ────────────────────────────────────────────────────

  /**
   * Snapshot the layer's current base strokes onto frame N.
   * Subsequent edits to base strokes don't affect the snapshot.
   */
  setKeyframe(layerId: string, frame: number): void {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    layer.keyframes[frame] = layer.strokes.map(s => ({
      ...s,
      points: s.points.map(p => ({ ...p })),
    }));
  }

  /** Remove the keyframe snapshot at frame N (falls back to base strokes). */
  clearKeyframe(layerId: string, frame: number): void {
    const layer = this.getLayer(layerId);
    if (layer) delete layer.keyframes[frame];
  }

  /**
   * Get the strokes that should render at `frame`.
   * If a keyframe exists at exactly `frame`, returns that list.
   * Otherwise returns the base strokes.
   */
  getActiveStrokes(layerId: string, frame: number): GpStroke3D[] {
    const layer = this.getLayer(layerId);
    if (!layer) return [];
    return layer.keyframes[frame] ?? layer.strokes;
  }

  /**
   * All strokes visible at `frame` across all visible layers, bottom-to-top.
   * Used by GpRenderer3D.
   */
  getActiveStrokesAllLayers(frame: number): { stroke: GpStroke3D; layerOpacity: number }[] {
    const result: { stroke: GpStroke3D; layerOpacity: number }[] = [];
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      for (const stroke of (layer.keyframes[frame] ?? layer.strokes)) {
        result.push({ stroke, layerOpacity: layer.opacity });
      }
    }
    return result;
  }

  // ── Scene-graph requirements ──────────────────────────────────────────────

  /** GpObject3D has no 2D geometry. */
  containsPoint(_x: number, _y: number): boolean { return false; }
  protected getScaleFactors(): [number, number] { return [1, 1]; }
  getGeometryVertices(): Float32Array | null { return null; }
  getGeometryIndices(): Uint16Array | null { return null; }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): any {
    return {
      ...super.toJSON(),
      type:        'GpObject3D',
      characterId: this.characterId,
      skeletonId:  this.skeletonId,
      renderOrder: this.renderOrder,
      layers:      this.layers.map(l => ({
        id:       l.id,
        name:     l.name,
        visible:  l.visible,
        opacity:  l.opacity,
        strokes:  l.strokes,
        keyframes: Object.fromEntries(
          Object.entries(l.keyframes).map(([k, v]) => [k, v]),
        ),
      })),
    };
  }

  static fromJSON(data: any, interactionService: InteractionService): GpObject3D {
    const obj = new GpObject3D(interactionService);
    obj.setId(data.id ?? _uid());
    obj.name        = data.name ?? 'GP Object';
    obj.characterId = data.characterId;
    obj.skeletonId  = data.skeletonId;
    obj.renderOrder = data.renderOrder ?? 0;
    obj.layers      = (data.layers ?? []).map((l: any): GpLayer3D => ({
      id:       l.id,
      name:     l.name ?? 'Layer',
      visible:  l.visible ?? true,
      opacity:  l.opacity ?? 1,
      strokes:  l.strokes ?? [],
      keyframes: Object.fromEntries(
        Object.entries(l.keyframes ?? {}).map(([k, v]) => [Number(k), v as GpStroke3D[]]),
      ),
    }));
    return obj;
  }

  /** Produce a plain GpObject3DData snapshot (no WebGPU references). */
  toData(): import('../../types/grease-pencil-3d').GpObject3DData {
    return {
      id:          this.id,
      name:        this.name,
      characterId: this.characterId,
      skeletonId:  this.skeletonId,
      layers:      this.layers.map(l => ({
        ...l,
        keyframes: { ...l.keyframes },
        strokes:   l.strokes.map(s => ({ ...s, points: [...s.points] })),
      })),
    };
  }
}
