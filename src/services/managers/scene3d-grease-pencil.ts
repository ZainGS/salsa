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
import type { GpLayer3D, GpStroke3D } from '../../types/grease-pencil-3d';
import type { GpPlacedEvent } from './gp-surface-placer';

type RGBA = { r: number; g: number; b: number; a: number };

/** The style a new stroke (or a Surface stroke's next piece) is begun with. */
export interface GpStrokeStyle { color: RGBA; baseWidth: number; fillColor?: RGBA; parentJoint?: string; closed?: boolean }

export class Scene3DGreasePencil {
  private _objects = new Map<string, GpObject3D>();
  private _activeStroke: { gpId: string; layerId: string; strokeId: string; frame?: number } | null = null;

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

  /** Remove a GpObject3D from the scene. Returns the detached node (undo re-attaches it with {@link reattachObject}). */
  removeObject(gpId: string): GpObject3D | null {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return null;
    gpObj.parent?.removeChild(gpObj);
    this._objects.delete(gpId);
    if (this._activeStroke?.gpId === gpId) this._activeStroke = null;
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();
    return gpObj;
  }

  /** Put a node {@link removeObject} detached back into the scene (undo of a delete). */
  reattachObject(gpObj: GpObject3D): void {
    if (this._objects.has(gpObj.id)) return;
    this.ctx.sceneGraph.root.addChild(gpObj);
    this._objects.set(gpObj.id, gpObj);
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
    this._changed();
    return layerId;
  }

  /** Remove a layer from a GpObject3D. Returns the removed layer + its index (undo puts it back with
   *  {@link restoreLayer}), or null. */
  removeLayer(gpId: string, layerId: string): { layer: GpLayer3D; index: number } | null {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return null;
    const index = gpObj.layers.findIndex(l => l.id === layerId);
    if (index < 0) return null;
    const layer = gpObj.layers[index];
    if (this._activeStroke?.gpId === gpId && this._activeStroke.layerId === layerId) this._activeStroke = null;
    gpObj.removeLayer(layerId);
    this._changed();
    return { layer, index };
  }

  /** Undo of {@link removeLayer}. */
  restoreLayer(gpId: string, layer: GpLayer3D, index: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.insertLayer(layer, index);
    this._changed();
  }

  /**
   * Begin a new stroke on a layer. Returns the strokeId. Call addPoint() repeatedly, then endStroke().
   * If a stroke is already open it is finalized first. With `frame`, the stroke goes into that frame's keyframe when
   * the layer has one there (what the viewport shows at that frame), else into the base strokes.
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

    const frame = options?.frame;
    const strokeId = gpObj.addStroke(layerId, {
      points: [],
      color: { ...color },
      baseWidth,
      fillColor: options?.fillColor ? { ...options.fillColor } : undefined,
      parentJoint: options?.parentJoint,
      closed: options?.closed ?? false,
    }, frame);
    if (!strokeId) return '';

    this._activeStroke = { gpId, layerId, strokeId, frame };
    return strokeId;
  }

  /** Whether a stroke is open (between beginStroke and endStroke / cancelStroke). */
  get hasActiveStroke(): boolean { return this._activeStroke !== null; }

  /** The open stroke (null when none), as it lives in its layer. */
  private _openStroke(): GpStroke3D | null {
    const a = this._activeStroke;
    if (!a) return null;
    const list = this._objects.get(a.gpId)?.strokeList(a.layerId, a.frame);
    return list?.find(s => s.id === a.strokeId) ?? null;
  }

  /** Add a point to the currently active stroke. A sample at the previous point's position (a pen reporting the
   *  same spot twice) is skipped: it adds no shape, only a zero-length segment. */
  addPoint(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
    const stroke = this._openStroke();
    if (!stroke) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const last = stroke.points[stroke.points.length - 1];
    if (last && (last.x - x) ** 2 + (last.y - y) ** 2 + (last.z - z) ** 2 < 1e-14) {
      last.pressure = Math.max(last.pressure, pressure);
      return;
    }
    stroke.points.push({ x, y, z, pressure, opacity });
    this.ctx.scheduleRender();
  }

  /** Finalize the active stroke. Strokes with < 2 points are discarded. Returns whether a stroke was KEPT (a kept
   *  stroke is a document change: the host hears it through onSceneGraphChanged and autosaves). */
  endStroke(): boolean {
    const a = this._activeStroke;
    if (!a) return false;
    const stroke = this._openStroke();
    this._activeStroke = null;
    const gpObj = this._objects.get(a.gpId);
    if (!gpObj || !stroke) return false;
    if (stroke.points.length < 2) {
      gpObj.removeStroke(a.layerId, a.strokeId, a.frame);
      this.ctx.scheduleRender();
      return false;
    }
    this._changed();
    return true;
  }

  /**
   * Feed Surface-placement events (gp-surface-placer.ts) into a layer: a point extends the open stroke, or — after a
   * break, or first — starts a new piece with `style`; a break ends the open piece (one under 2 points is dropped).
   */
  applyPlacedEvents(gpId: string, layerId: string, frame: number | undefined, style: GpStrokeStyle, events: readonly GpPlacedEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'break') { if (this._activeStroke) this.endStroke(); continue; }
      if (!this._activeStroke) {
        if (!this.beginStroke(gpId, layerId, style.color, style.baseWidth, {
          fillColor: style.fillColor, parentJoint: style.parentJoint, closed: style.closed, frame,
        })) return;
      }
      this.addPoint(ev.x, ev.y, ev.z, ev.pressure, 1);
    }
  }

  /** End a Surface-placement stroke: the open piece is finished, and when the stroke left the mesh and came back
   *  (several pieces) the pieces are open lines — closing / filling each piece on its own would join the wrong ends.
   *  `before` is the stroke list snapshot taken when the stroke began. */
  endSurfaceStroke(gpId: string, layerId: string, frame: number | undefined, before: readonly GpStroke3D[]): void {
    if (this._activeStroke) this.endStroke();
    const list = this.getStrokeList(gpId, layerId, frame);
    if (!list) return;
    const old = new Set(before);
    const pieces = list.filter(s => !old.has(s));
    if (pieces.length > 1) for (const s of pieces) s.closed = false;
  }

  /** Whether two stroke arrays hold the same strokes (by reference, in order) — a draw / erase gesture that left the
   *  list like this changed nothing (no undo step). */
  static sameStrokes(a: readonly GpStroke3D[], b: readonly GpStroke3D[]): boolean {
    return a.length === b.length && a.every((s, i) => s === b[i]);
  }

  /** Abandon the active stroke: it is removed as if never drawn (a second finger turned the stroke into a pinch). */
  cancelStroke(): void {
    const a = this._activeStroke;
    if (!a) return;
    this._activeStroke = null;
    this._objects.get(a.gpId)?.removeStroke(a.layerId, a.strokeId, a.frame);
    this.ctx.scheduleRender();
  }

  /** Erase strokes within `radius` world units of `worldPos` on a layer (or a keyframe if `frame` is given). Returns
   *  how many strokes were removed. */
  eraseStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): number {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return 0;
    const n = gpObj.eraseStrokes(layerId, worldPos, radius, frame);
    if (n > 0) this._changed();
    return n;
  }

  /** Erase the strokes passing within `radius` of the view ray (origin + unit dir) — see GpObject3D.eraseStrokesNearRay. */
  eraseStrokesNearRay(gpId: string, layerId: string, origin: [number, number, number], dir: [number, number, number], radius: number, frame?: number): number {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return 0;
    const n = gpObj.eraseStrokesNearRay(layerId, origin, dir, radius, frame);
    if (n > 0) this._changed();
    return n;
  }

  /** PARTIAL erase near the view ray: only the parts under the eraser go, cut strokes split into pieces — see
   *  GpObject3D.eraseStrokesNearRayPartial. Returns how many strokes were cut or removed. */
  eraseStrokesNearRayPartial(gpId: string, layerId: string, origin: [number, number, number], dir: [number, number, number], radius: number, frame?: number): number {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return 0;
    const n = gpObj.eraseStrokesNearRayPartial(layerId, origin, dir, radius, frame);
    if (n > 0) this._changed();
    return n;
  }

  /** The stroke array a draw / erase at `frame` edits (by reference — finished strokes are never mutated: a draw
   *  pushes and an erase replaces the array, so a copy of the array is a cheap undo snapshot). Null if unknown. */
  getStrokeList(gpId: string, layerId: string, frame?: number): GpStroke3D[] | null {
    return this._objects.get(gpId)?.strokeList(layerId, frame) ?? null;
  }

  /** Put a stroke array back (undo / redo of a draw or erase). */
  setStrokeList(gpId: string, layerId: string, frame: number | undefined, strokes: GpStroke3D[]): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.setStrokeList(layerId, frame, strokes);
    this._changed();
  }

  /** Snapshot the current base strokes of a layer as a keyframe. */
  setKeyframe(gpId: string, layerId: string, frame: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.setKeyframe(layerId, frame);
    this._changed();
  }

  /** Remove the keyframe snapshot at frame N for a layer. */
  clearKeyframe(gpId: string, layerId: string, frame: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.clearKeyframe(layerId, frame);
    this._changed();
  }

  /** Whether the layer has a keyframe at `frame`. */
  hasKeyframe(gpId: string, layerId: string, frame: number): boolean {
    return !!this._objects.get(gpId)?.getLayer(layerId)?.keyframes[frame];
  }

  /** Set draw order for a GP object within the GP pass. 0 = default; negative = background. */
  setRenderOrder(gpId: string, order: number): void {
    const gpObj = this._objects.get(gpId);
    if (!gpObj) return;
    gpObj.renderOrder = order;
    this._changed();
  }

  /** A saved-state change (strokes, layers, keyframes, order): redraw, and tell the host (onSceneGraphChanged — the
   *  editor's autosave tick; a GP edit used to only redraw, so a drawing was saved only if something else changed). */
  private _changed(): void {
    this.ctx.emitSceneGraphChanged();
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
    this._changed();
  }

  setLayerOpacity(gpId: string, layerId: string, opacity: number): void {
    const layer = this._objects.get(gpId)?.getLayer(layerId);
    if (!layer) return;
    const next = Math.max(0, Math.min(1, opacity));
    if (next === layer.opacity) return;
    layer.opacity = next;
    this._changed();
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
