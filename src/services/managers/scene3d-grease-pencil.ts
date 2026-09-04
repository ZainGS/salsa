/**
 * Scene3DGreasePencil — the Grease-Pencil DATA MODEL subsystem, extracted from Scene3DManager.
 *
 * §5.1 extraction (docs/specs/god-objects-and-perf.md, Part A). Grease Pencil is ~1050 lines in the manager, but
 * it cleanly splits in two: the object/layer/stroke/keyframe DATA MODEL (this file — id-keyed, `ctx`-only, no
 * gizmo/pick/canvas coupling) and the interactive DRAW-MODE controller (which legitimately couples to the gizmo,
 * pointer listeners, and face raycasting — it stays in Scene3DManager and drives this subsystem through its public
 * API). Extracting the state-owning half isolates `_gpObjects` / the active-stroke cursor into a testable unit
 * without dragging the interactive tangle along; the draw-mode controller is a later, separate move.
 *
 * Owns the GpObject3D map and the "currently open stroke" cursor. GpObject3D nodes live in the scene graph so the
 * renderer's GP pass finds them.
 */

import type { ManagerContext } from './manager-context';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';

type RGBA = { r: number; g: number; b: number; a: number };

export class Scene3DGreasePencil {
  private _objects = new Map<string, GpObject3D>();
  private _activeStroke: { gpId: string; layerId: string; strokeId: string } | null = null;

  constructor(private readonly ctx: ManagerContext) {}

  /** Create a new GpObject3D in the scene and return its ID. */
  createObject(name = 'GP Object', skeletonId?: string): string {
    const gpObj = new GpObject3D(this.ctx.interactionService);
    gpObj.name = name;
    gpObj.skeletonId = skeletonId;
    gpObj.addLayer('Layer 1');
    this.ctx.sceneGraph.root.addChild(gpObj);
    this._objects.set(gpObj.id, gpObj);
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();
    return gpObj.id;
  }

  /** Remove a GpObject3D from the scene. */
  removeObject(gpId: string): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.parent?.removeChild(gpObj);
    this._objects.delete(gpId);
    if (this._activeStroke?.gpId === gpId) this._activeStroke = null;
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();
  }

  get(gpId: string): GpObject3D | null {
    return this._objects.get(gpId) ?? null;
  }

  getAll(): GpObject3D[] {
    return [...this._objects.values()];
  }

  has(gpId: string): boolean {
    return this._objects.has(gpId);
  }

  /** Add a layer to a GpObject3D. Returns the new layer ID (or '' if the object is unknown). */
  addLayer(gpId: string, name = 'Layer'): string {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return '';
    const layerId = gpObj.addLayer(name);
    this.ctx.scheduleRender();
    return layerId;
  }

  /** Remove a layer from a GpObject3D. */
  removeLayer(gpId: string, layerId: string): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.removeLayer(layerId);
    this.ctx.scheduleRender();
  }

  /**
   * Begin a new stroke on a layer. Returns the strokeId. Call addPoint() repeatedly, then endStroke().
   * If a stroke is already open it is finalized first.
   */
  beginStroke(
    gpId: string,
    layerId: string,
    color: RGBA,
    baseWidth: number,
    options?: { fillColor?: RGBA; parentJoint?: string; closed?: boolean; frame?: number },
  ): string {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return '';

    if (this._activeStroke) this.endStroke();

    const strokeId = gpObj.addStroke(layerId, {
      points: [],
      color,
      baseWidth,
      fillColor: options?.fillColor,
      parentJoint: options?.parentJoint,
      closed: options?.closed ?? false,
    });

    // For keyframe strokes, snapshot the keyframe.
    if (options?.frame !== undefined) gpObj.setKeyframe(layerId, options.frame);

    this._activeStroke = { gpId, layerId, strokeId };
    return strokeId;
  }

  /** Add a point to the currently active stroke. */
  addPoint(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
    if (!this._activeStroke) return;
    const { gpId, layerId, strokeId } = this._activeStroke;
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    const layer = gpObj.getLayer(layerId);
    if (!layer) return;
    const stroke = layer.strokes.find(s => s.id === strokeId);
    if (!stroke) return;
    stroke.points.push({ x, y, z, pressure, opacity });
    this.ctx.scheduleRender();
  }

  /** Finalize the active stroke. Strokes with < 2 points are discarded. */
  endStroke(): void {
    if (!this._activeStroke) return;
    const { gpId, layerId, strokeId } = this._activeStroke;
    this._activeStroke = null;
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    const layer = gpObj.getLayer(layerId);
    if (!layer) return;
    const stroke = layer.strokes.find(s => s.id === strokeId);
    if (stroke && stroke.points.length < 2) gpObj.removeStroke(layerId, strokeId);
    this.ctx.scheduleRender();
  }

  /** Erase strokes within `radius` world units of `worldPos` on a layer (or a keyframe if `frame` is given). */
  eraseStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.eraseStrokes(layerId, worldPos, radius, frame);
    this.ctx.scheduleRender();
  }

  /** Snapshot the current base strokes of a layer as a keyframe. */
  setKeyframe(gpId: string, layerId: string, frame: number): void {
    this._objects.get(gpId)?.setKeyframe(layerId, frame);
  }

  /** Remove the keyframe snapshot at frame N for a layer. */
  clearKeyframe(gpId: string, layerId: string, frame: number): void {
    this._objects.get(gpId)?.clearKeyframe(layerId, frame);
  }

  /** Set draw order for a GP object within the GP pass. 0 = default; negative = background. */
  setRenderOrder(gpId: string, order: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.renderOrder = order;
    this.ctx.scheduleRender();
  }

  /** List all GP objects as plain descriptors (safe to pass to the host UI). */
  getAllDescriptors(): { id: string; name: string; skeletonId?: string }[] {
    return [...this._objects.values()].map(g => ({
      id: g.id,
      name: g.name,
      ...(g.skeletonId ? { skeletonId: g.skeletonId } : {}),
    }));
  }

  /** List all layers for a GP object. */
  getLayers(gpId: string): { id: string; name: string; visible: boolean; opacity: number }[] {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return [];
    return gpObj.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity }));
  }

  setLayerVisible(gpId: string, layerId: string, visible: boolean): void {
    const layer = this._objects.get(gpId)?.getLayer(layerId);
    if (!layer) return;
    layer.visible = visible;
    this.ctx.scheduleRender();
  }

  setLayerOpacity(gpId: string, layerId: string, opacity: number): void {
    const layer = this._objects.get(gpId)?.getLayer(layerId);
    if (!layer) return;
    layer.opacity = Math.max(0, Math.min(1, opacity));
    this.ctx.scheduleRender();
  }

  renameObject(gpId: string, name: string): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.name = name;
    this.ctx.emitSceneGraphChanged();
  }

  renameLayer(gpId: string, layerId: string, name: string): void {
    const layer = this._objects.get(gpId)?.getLayer(layerId);
    if (!layer) return;
    layer.name = name;
    this.ctx.emitSceneGraphChanged();
  }

  // ── Serialization ────────────────────────────────────────────────────────

  toStates(): any[] {
    return [...this._objects.values()].map(g => g.toJSON());
  }

  restoreStates(states: any[]): void {
    this._objects.clear();
    // Remove any existing GpObject3D nodes from the scene graph.
    const existing: GpObject3D[] = [];
    this.ctx.sceneGraph.root.forEachDeep(n => { if (n instanceof GpObject3D) existing.push(n); });
    for (const n of existing) n.parent?.removeChild(n);

    for (const s of states) {
      const gpObj = GpObject3D.fromJSON(s, this.ctx.interactionService);
      this.ctx.sceneGraph.root.addChild(gpObj);
      this._objects.set(gpObj.id, gpObj);
    }
  }

  /** Drop all references (used on manager teardown). Does NOT detach nodes — scene-graph disposal owns that. */
  dispose(): void {
    this._objects.clear();
    this._activeStroke = null;
  }
}
