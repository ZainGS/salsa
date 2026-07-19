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

  /** Append a stroke to a layer's base strokes. Returns strokeId. */
  addStroke(layerId: string, stroke: Omit<GpStroke3D, 'id'>): string {
    const layer = this.getLayer(layerId);
    if (!layer) return '';
    const id = _uid();
    layer.strokes.push({ id, ...stroke });
    return id;
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
   * Simple sphere-vs-point test on each stroke's points.
   */
  eraseStrokes(layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    const [ex, ey, ez] = worldPos;
    const r2 = radius * radius;

    const filterFn = (s: GpStroke3D): boolean =>
      !s.points.some(p => (p.x-ex)**2 + (p.y-ey)**2 + (p.z-ez)**2 <= r2);

    if (frame !== undefined && layer.keyframes[frame]) {
      layer.keyframes[frame] = layer.keyframes[frame].filter(filterFn);
    } else {
      layer.strokes = layer.strokes.filter(filterFn);
    }
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
