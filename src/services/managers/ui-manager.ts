/**
 * src/services/managers/ui-manager.ts
 *
 * Host adapter for the UI System (docs/specs/ui-system.md) — Phase 1 (core interaction). Owns the scene's UI layers,
 * each driving a pure UIStateMachineRuntime, and APPLIES the effects the runtime emits: toggling real layer/shape
 * visibility, opening URLs, and surfacing high-level UIEvents (state changes, variable changes, custom emitEvent) to
 * the host via `onUIEvent`. The state-machine logic itself is pure + unit-tested in src/ui/; this class is the thin
 * glue to the scene graph + renderer (the same delegate-manager pattern as the other managers).
 *
 * NOT in this phase (documented seams): world-control effects (freezeWorld / camera / animation / sound) are routed
 * to an optional `effectHook` instead of applied; pointer hit-testing + the on-canvas render pass + document
 * persistence are later phases. A UI layer here is a logical BEHAVIOR container — the author draws buttons in an
 * ordinary vector layer and this wires their interactivity — so no new render pass is required yet.
 */

import type { ManagerContext } from './manager-context';
import { EventEmitter } from '../../renderer/util/event-emitter';
import { UIStateMachineRuntime } from '../../ui/ui-state-machine';
import type {
  UILayerData, UIStateMachine, UIEffect, UIEvent, UIValue, ShapeInteractionProps,
  TransitionAnimation, InteractionTrigger,
} from '../../ui/ui-types';

function uid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `ui-${Math.random().toString(36).slice(2)}`;
}

/** A UI variable is "falsy" (auto-disable a shape) when unset/false/0/empty. */
function truthy(v: UIValue | undefined): boolean { return v !== undefined && v !== null && v !== false && v !== 0 && v !== ''; }

/** Ease a 0..1 progress. */
function ease(kind: string | undefined, t: number): number {
  switch (kind) {
    case 'easeIn':    return t * t;
    case 'easeOut':   return t * (2 - t);
    case 'easeInOut': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    default:          return t;   // linear / spring (approx)
  }
}

interface UILayerRec { data: UILayerData; runtime: UIStateMachineRuntime | null; }

/** Host adapter that lets ephemera placements (which are NOT scene-graph nodes) act as interactive UI shapes.
 *  A placement's own id is the shapeId. Supplied by ShapeManager (bridges EphemeraOverlay + EphemeraService). */
export interface UIEphemeraAdapter {
  /** Top placement id under a WORLD point (rotation-aware), or null. */
  pickAt(worldX: number, worldY: number): string | null;
  /** Is this id an ephemera placement (vs a scene-graph node)? */
  has(id: string): boolean;
  setVisible(id: string, visible: boolean): void;
  isVisible(id: string): boolean;
}

export class UIManager {
  private readonly ctx: ManagerContext;
  private readonly _layers = new Map<string, UILayerRec>();
  private _activeLayerId: string | null = null;
  private readonly _events = new EventEmitter<UIEvent>();
  /** Optional host hook for effects Phase 1 does not apply itself (freezeWorld / setCamera / playAnimation / …). */
  private _effectHook: ((effect: UIEffect) => void) | null = null;
  /** Live interactivity (preview mode). OFF by default → the pointer hooks no-op so editing is never intercepted. */
  private _interactive = false;
  private _hoverShapeId: string | null = null;
  /** 3D-mesh pick provider (canvas px → picked mesh node id) — lets a 3D mesh be an interactive UI target. */
  private _meshPick: ((canvasX: number, canvasY: number) => string | null) | null = null;
  /** Ephemera adapter — lets ephemera placements be interactive UI targets (they're not scene-graph nodes). */
  private _ephemera: UIEphemeraAdapter | null = null;
  /** In-flight state-transition animation (drives the fullscreen fade over the scrim). */
  private _transition: { color: [number, number, number]; durationMs: number; elapsedMs: number; easing?: string } | null = null;

  constructor(ctx: ManagerContext) { this.ctx = ctx; }

  // ── Events + hooks ──────────────────────────────────────────────────────────────────────────────────────
  /** Subscribe to UI events (state changes, variable changes, custom emitEvent). Returns an unsubscribe fn. */
  onUIEvent(cb: (e: UIEvent) => void): () => void {
    const sub = this._events.subscribe(cb);
    return () => sub.unsubscribe();
  }
  /** Wire world-control effects (a later phase) — receives every effect this class doesn't apply itself. */
  setEffectHook(hook: ((effect: UIEffect) => void) | null): void { this._effectHook = hook; }

  // ── Layer lifecycle ─────────────────────────────────────────────────────────────────────────────────────
  /** Create a UI layer (a behavior container that composites on top). Returns its id + makes it the active layer. */
  createUILayer(name = 'UI Layer'): string {
    const id = uid();
    const data: UILayerData = {
      id, name, type: 'ui-layer', visible: true, passThroughPointer: true,
      shapeInteractions: {},
      stateMachine: { id: uid(), initialStateId: '', states: [], transitions: [], variables: [] },
    };
    this._layers.set(id, { data, runtime: null });
    this._activeLayerId = id;
    return id;
  }

  getUILayer(layerId: string): UILayerData | null { return this._layers.get(layerId)?.data ?? null; }
  listUILayers(): UILayerData[] { return [...this._layers.values()].map((r) => r.data); }
  get activeUILayerId(): string | null { return this._activeLayerId; }
  setActiveUILayer(layerId: string): void { if (this._layers.has(layerId)) this._activeLayerId = layerId; }

  /** Update top-level UI layer props (name, passThroughPointer, backgroundOverlay, visible). */
  updateUILayer(layerId: string, updates: Partial<Pick<UILayerData, 'name' | 'passThroughPointer' | 'backgroundOverlay' | 'visible'>>): void {
    const rec = this._layers.get(layerId);
    if (rec) Object.assign(rec.data, updates);
  }

  deleteUILayer(layerId: string): boolean {
    const ok = this._layers.delete(layerId);
    if (ok && this._activeLayerId === layerId) this._activeLayerId = this._layers.keys().next().value ?? null;
    return ok;
  }

  // ── State machine ───────────────────────────────────────────────────────────────────────────────────────
  /** Install a state machine and enter its initial state (applies the initial visibility + onEnter effects). */
  setStateMachine(layerId: string, machine: UIStateMachine): void {
    const rec = this._layers.get(layerId);
    if (!rec) return;
    rec.data.stateMachine = machine;
    rec.runtime = new UIStateMachineRuntime(machine);
    if (machine.initialStateId) this._apply(rec.runtime.start());
  }

  getStateMachine(layerId: string): UIStateMachine | null { return this._layers.get(layerId)?.data.stateMachine ?? null; }

  /** Move a layer to a named state (applies its effects). */
  goToState(layerId: string, stateId: string, animation?: TransitionAnimation): void {
    const rec = this._layers.get(layerId);
    if (rec?.runtime) this._apply(rec.runtime.goTo(stateId, animation));
  }
  getCurrentState(layerId: string): string | null { return this._layers.get(layerId)?.runtime?.currentStateId ?? null; }
  getStateHistory(layerId: string): string[] { return this._layers.get(layerId)?.runtime?.history ?? []; }

  // ── Variables ───────────────────────────────────────────────────────────────────────────────────────────
  getUIVariable(layerId: string, variableId: string): UIValue | null { return this._layers.get(layerId)?.runtime?.getVariable(variableId) ?? null; }
  setUIVariable(layerId: string, variableId: string, value: UIValue): void {
    const rec = this._layers.get(layerId);
    if (rec?.runtime) this._apply(rec.runtime.setVariableValue(variableId, value));
  }

  // ── Shape interactions ──────────────────────────────────────────────────────────────────────────────────
  /** Attach interaction props to a shape (shape may live in any layer). Defaults to the active UI layer. */
  setShapeInteraction(props: ShapeInteractionProps, layerId = this._activeLayerId): void {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (rec) rec.data.shapeInteractions[props.shapeId] = props;
  }
  clearShapeInteraction(shapeId: string, layerId = this._activeLayerId): void {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (rec) delete rec.data.shapeInteractions[shapeId];
  }
  getShapeInteraction(shapeId: string, layerId = this._activeLayerId): ShapeInteractionProps | null {
    const rec = layerId ? this._layers.get(layerId) : null;
    return rec?.data.shapeInteractions[shapeId] ?? null;
  }
  /** Ids of every shape wired for interaction on a layer (used by the pointer hit-test in a later phase). */
  interactiveShapeIds(layerId = this._activeLayerId): string[] {
    const rec = layerId ? this._layers.get(layerId) : null;
    return rec ? Object.keys(rec.data.shapeInteractions) : [];
  }

  // ── Input dispatch (called by the pointer/keyboard wiring in a later phase) ──────────────────────────────
  /** Feed a raw trigger to a layer's runtime and apply the effects. */
  dispatchTrigger(layerId: string, trigger: InteractionTrigger): void {
    const rec = this._layers.get(layerId);
    if (rec?.runtime) this._apply(rec.runtime.dispatch(trigger));
  }
  /** A shape was clicked — emit the shapeClick event + run its transition. Defaults to the active UI layer. */
  clickShape(shapeId: string, layerId = this._activeLayerId): void {
    if (!layerId) return;
    this._events.emit({ type: 'shapeClick', shapeId });
    this.dispatchTrigger(layerId, { type: 'click', targetId: shapeId });
  }
  hoverShape(shapeId: string, entering: boolean, layerId = this._activeLayerId): void {
    if (!layerId) return;
    this._events.emit({ type: entering ? 'shapeHover' : 'shapeHoverEnd', shapeId });
    this.dispatchTrigger(layerId, { type: entering ? 'hover' : 'hoverEnd', targetId: shapeId });
  }
  keyDown(key: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'keyDown', key }); }
  /** A Play-mode trigger volume was entered/exited — run its transition on the active UI layer (no-op if none). */
  volumeEnter(volumeId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'enterVolume', volumeId }); }
  volumeExit(volumeId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'exitVolume', volumeId }); }
  /** The player used a nearby interactable — run its transition on the active UI layer (no-op if none). */
  interact(targetId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'interact', targetId }); }

  /** Advance every live layer's clock so `timer` transitions fire, and step the state-transition fade. The host
   *  calls this each frame while in interactive preview. No-op off-preview. */
  tick(dtMs: number): void {
    if (!this._interactive) return;
    for (const rec of this._layers.values()) if (rec.runtime) this._apply(rec.runtime.tick(dtMs));
    if (this._transition) {
      this._transition.elapsedMs += dtMs;
      if (this._transition.elapsedMs >= this._transition.durationMs) this._transition = null;
      this.ctx.scheduleRender();   // keep repainting through the fade
    }
  }

  /** Begin a fullscreen fade for a state transition (interactive only). fade/slide/zoom/wipe all fade for now —
   *  directional wipes/slides need a dedicated shader (later); the timing + hand-off is identical. */
  private _startTransition(anim: TransitionAnimation): void {
    if (!this._interactive || anim.type === 'none' || anim.duration <= 0) { this._transition = null; return; }
    const color: [number, number, number] = anim.type === 'wipe' ? [1, 1, 1] : [0, 0, 0];
    this._transition = { color, durationMs: anim.duration, elapsedMs: 0, easing: anim.easing };
    this.ctx.scheduleRender();
  }

  // ── Focus / keyboard navigation (Tab cycles focusable shapes; Enter/Space activates the focused one) ────────
  private _focusedShapeId: string | null = null;

  private _focusOrder(layerId: string | null): string[] {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec) return [];
    return Object.values(rec.data.shapeInteractions)
      .filter((p) => p.focusable && !p.disabled)
      .sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0))
      .map((p) => p.shapeId);
  }
  private _cycleFocus(dir: 1 | -1, layerId: string | null): string | null {
    const order = this._focusOrder(layerId);
    if (!order.length) { this._focusedShapeId = null; this._applyFocusVisuals(layerId); return null; }
    const cur = this._focusedShapeId ? order.indexOf(this._focusedShapeId) : -1;
    this._focusedShapeId = order[(cur + dir + order.length) % order.length];
    this._applyFocusVisuals(layerId);
    return this._focusedShapeId;
  }
  /** Show the focused element's focus-ring shape (if any) and hide every other element's — the authored focus visual. */
  private _applyFocusVisuals(layerId: string | null): void {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec) return;
    for (const props of Object.values(rec.data.shapeInteractions)) {
      if (props.focusIndicatorShapeId) this._setShapeVisible(props.focusIndicatorShapeId, props.shapeId === this._focusedShapeId);
    }
    this.ctx.scheduleRender();
  }
  /** Move focus to the next / previous focusable shape (tabIndex order). Returns the newly focused shape id. */
  focusNext(layerId = this._activeLayerId): string | null { return this._cycleFocus(1, layerId); }
  focusPrev(layerId = this._activeLayerId): string | null { return this._cycleFocus(-1, layerId); }
  getFocusedShape(): string | null { return this._focusedShapeId; }
  /** Activate (click) the currently focused shape — Enter/Space. */
  activateFocused(layerId = this._activeLayerId): void { if (this._focusedShapeId) this.clickShape(this._focusedShapeId, layerId); }

  /** Handle a key press (from the renderer hook). Tab/Enter/Space drive focus; every key also fires a keyDown
   *  trigger. Returns true when consumed (the renderer preventDefaults + stops). No-op unless interactive. */
  handleKey(key: string, shift = false): boolean {
    if (!this._interactive) return false;
    if (key === 'Tab') { if (shift) this.focusPrev(); else this.focusNext(); return true; }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') { this.activateFocused(); return true; }
    this.keyDown(key);   // author-bound key transition (e.g. Escape → pause); does not consume other keys
    return false;
  }

  // ── Interactive preview + pointer hit-testing (the renderer hook calls pointerDown / pointerMove) ────────
  /** Enable/disable live interactivity. OFF by default so authoring/editing is never intercepted. */
  setInteractive(on: boolean): void {
    this._interactive = on;
    if (!on) {
      if (this._hoverShapeId) { const prev = this._hoverShapeId; this._hoverShapeId = null; this.hoverShape(prev, false); }
      if (this._focusedShapeId) { this._focusedShapeId = null; this._applyFocusVisuals(this._activeLayerId); }   // hide any focus ring
    }
  }
  get interactive(): boolean { return this._interactive; }
  /** Provide a 3D-mesh ray-pick (canvas px → mesh node id) so a 3D mesh can be an interactive UI target. */
  setMeshPicker(fn: ((canvasX: number, canvasY: number) => string | null) | null): void { this._meshPick = fn; }
  /** Provide the ephemera adapter so ephemera placements can be interactive UI targets. */
  setEphemeraAdapter(adapter: UIEphemeraAdapter | null): void { this._ephemera = adapter; }

  /** An ephemera placement under the WORLD point that is ALSO an interactive + enabled UI target, or null. */
  hitTestEphemera(worldX: number, worldY: number, layerId = this._activeLayerId): string | null {
    if (!this._ephemera) return null;
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec || !rec.data.visible) return null;
    const pid = this._ephemera.pickAt(worldX, worldY);
    if (!pid) return null;
    const props = rec.data.shapeInteractions[pid];
    if (!props || props.disabled) return null;
    if (props.disabledWhenVariable && !truthy(rec.runtime?.getVariable(props.disabledWhenVariable))) return null;
    return pid;
  }

  /** A 3D mesh under the canvas point that is ALSO an interactive + enabled UI target, or null. */
  hitTestMesh(canvasX: number, canvasY: number, layerId = this._activeLayerId): string | null {
    if (!this._meshPick) return null;
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec || !rec.data.visible) return null;
    const meshId = this._meshPick(canvasX, canvasY);
    if (!meshId) return null;
    const props = rec.data.shapeInteractions[meshId];
    if (!props || props.disabled) return null;
    if (props.disabledWhenVariable && !truthy(rec.runtime?.getVariable(props.disabledWhenVariable))) return null;
    return meshId;
  }

  /** Top-most interactive + visible + enabled shape under a WORLD point on a layer, or null. */
  hitTest(worldX: number, worldY: number, layerId = this._activeLayerId): string | null {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec || !rec.data.visible) return null;
    let bestId: string | null = null, bestZ = -Infinity;
    for (const [shapeId, props] of Object.entries(rec.data.shapeInteractions)) {
      if (props.disabled) continue;
      if (props.disabledWhenVariable && !truthy(rec.runtime?.getVariable(props.disabledWhenVariable))) continue;
      const node = this.ctx.sceneGraph.findNodeById(shapeId);
      if (!node || !node.visible || !node.isEffectivelyVisible() || !node.containsPoint(worldX, worldY)) continue;
      const z = node.zIndex ?? 0;
      if (z >= bestZ) { bestZ = z; bestId = shapeId; }   // highest z = top-most = wins
    }
    return bestId;
  }

  /** Pointer moved: update hover (fires hover/hoverEnd) and return the cursor to show, or null. Tries 2D shapes
   *  first, then (if canvas coords given) a 3D-mesh pick. */
  pointerMove(worldX: number, worldY: number, canvasX?: number, canvasY?: number, layerId = this._activeLayerId): string | null {
    if (!this._interactive) return null;
    // Ephemera (top overlay) first, then 2D shapes, then a 3D-mesh pick — matches the app's own pick order.
    let hit = this.hitTestEphemera(worldX, worldY, layerId) ?? this.hitTest(worldX, worldY, layerId);
    if (!hit && canvasX != null && canvasY != null) hit = this.hitTestMesh(canvasX, canvasY, layerId);
    if (hit !== this._hoverShapeId) {
      const prev = this._hoverShapeId;
      this._hoverShapeId = hit;
      if (prev) this.hoverShape(prev, false, layerId);
      if (hit) this.hoverShape(hit, true, layerId);
    }
    if (!hit) return null;
    return this.getShapeInteraction(hit, layerId)?.cursor ?? 'pointer';
  }

  /** Pointer pressed: dispatch a click if it hit a shape (2D shapes first, then a 3D-mesh pick). Returns true when
   *  the UI consumed it. */
  pointerDown(worldX: number, worldY: number, canvasX?: number, canvasY?: number, layerId = this._activeLayerId): boolean {
    if (!this._interactive) return false;
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec || !rec.data.visible) return false;
    let hit = this.hitTestEphemera(worldX, worldY, layerId) ?? this.hitTest(worldX, worldY, layerId);
    if (!hit && canvasX != null && canvasY != null) hit = this.hitTestMesh(canvasX, canvasY, layerId);
    if (hit) { this.clickShape(hit, layerId); return true; }
    return !rec.data.passThroughPointer;   // a modal (non-pass-through) layer swallows misses too
  }

  // ── Render state (consumed by the renderer's dim/scrim pass) ────────────────────────────────────────────
  /** The world-dim overlay to draw right now: the first visible+live layer whose CURRENT state is modal
   *  (worldBlur > 0), using that layer's backgroundOverlay colour (else a default black scrim). Null = no dim.
   *  Only while interactive, so editing is never dimmed. The renderer pulls this each frame. */
  getActiveOverlay(): [number, number, number, number] | null {
    if (!this._interactive) return null;
    // A state-transition fade covers the whole screen while it plays (fades the NEW state in from the fade colour).
    if (this._transition) {
      const t = Math.min(1, this._transition.elapsedMs / Math.max(1, this._transition.durationMs));
      const a = 1 - ease(this._transition.easing, t);
      if (a > 0.001) return [this._transition.color[0], this._transition.color[1], this._transition.color[2], a];
    }
    for (const rec of this._layers.values()) {
      if (!rec.data.visible || !rec.runtime) continue;
      const cur = rec.runtime.currentStateId;
      const st = cur ? rec.data.stateMachine.states.find((s) => s.id === cur) : null;
      if (!st || !st.worldBlur || st.worldBlur <= 0) continue;   // only MODAL states (worldBlur) dim the world
      const c = rec.data.backgroundOverlay?.color ?? [0, 0, 0, 0.55];
      return [c[0], c[1], c[2], c[3]];
    }
    return null;
  }

  // ── Persistence (ready to wire into the document payload in a later phase) ───────────────────────────────
  serialize(): UILayerData[] { return this.listUILayers(); }
  restore(datas: UILayerData[]): void {
    this._layers.clear();
    this._activeLayerId = null;
    for (const data of datas) {
      const runtime = data.stateMachine.initialStateId ? new UIStateMachineRuntime(data.stateMachine) : null;
      this._layers.set(data.id, { data, runtime });
      runtime?.start();   // re-enter the initial state (visibility is re-applied by the host after restore)
      this._activeLayerId ??= data.id;
    }
  }

  // ── Effect application ──────────────────────────────────────────────────────────────────────────────────
  private _apply(effects: UIEffect[]): void {
    if (!effects.length) return;
    for (const e of effects) {
      switch (e.kind) {
        case 'stateChange':    this._events.emit({ type: 'stateChange', fromState: e.from, toState: e.to }); break;
        case 'variableChange': this._events.emit({ type: 'variableChange', variableId: e.variableId, oldValue: e.oldValue, newValue: e.newValue }); break;
        case 'emitEvent':      this._events.emit({ type: 'custom', eventName: e.eventName, payload: e.payload }); break;
        case 'setLayerVisible':    this._setLayerVisible(e.layerId, e.visible); break;
        case 'toggleLayerVisible': this._setLayerVisible(e.layerId, !this._layerVisible(e.layerId)); break;
        case 'setShapeVisible':    this._setShapeVisible(e.shapeId, e.visible); break;
        case 'toggleShapeVisible': this._setShapeVisible(e.shapeId, !this._shapeVisible(e.shapeId)); break;
        case 'openUrl':            if (typeof window !== 'undefined') window.open(e.url, e.target); break;
        case 'transition':         this._startTransition(e.animation); break;   // fullscreen fade over the scrim
        default:                   this._effectHook?.(e); break;   // world-control effects — wired in a later phase
      }
    }
    this.ctx.scheduleRender();
  }

  private _setLayerVisible(layerId: string, visible: boolean): void {
    this.ctx.rasterLayerManager?.setVisibility(layerId, visible);
    const r = this.ctx.webgpuRenderer as { setVectorLayerVisible?: (id: string, v: boolean) => void };
    r.setVectorLayerVisible?.(layerId, visible);
  }
  private _layerVisible(layerId: string): boolean {
    return this.ctx.rasterLayerManager?.getLayers().find((l) => l.id === layerId)?.visible ?? true;
  }
  private _setShapeVisible(shapeId: string, visible: boolean): void {
    if (this._ephemera?.has(shapeId)) { this._ephemera.setVisible(shapeId, visible); return; }
    const node = this.ctx.sceneGraph.findNodeById(shapeId);
    if (node) node.visible = visible;
  }
  private _shapeVisible(shapeId: string): boolean {
    if (this._ephemera?.has(shapeId)) return this._ephemera.isVisible(shapeId);
    return this.ctx.sceneGraph.findNodeById(shapeId)?.visible ?? true;
  }
}
