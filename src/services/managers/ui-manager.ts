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
  TransitionAnimation, InteractionTrigger, UIOverlayState, HtmlFormElement,
} from '../../ui/ui-types';
import { UIKitRuntime, kitMenuTakesKeys, type KitLayerView } from '../../ui/kit/kit-runtime';
import { UIKitRenderer } from '../../ui/kit/kit-renderer';
import { isKitTransition, UI_KIT_CLIPS, type UIKitWidget, type UIKitClip, type UIKitKind, type UIKitTransitionType } from '../../ui/kit/kit-types';
import { kitDefaults, kitStr } from '../../ui/kit/kit-schema';
import { menuItems, menuItemId } from '../../ui/kit/kit-layout';
import { kitPreset, personaHudDemo, personaPauseDemo, type KitWidgetDraft, type KitDemo } from '../../ui/kit/kit-presets';
import type { KitTextProvider } from '../../ui/kit/kit-prims';

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

/** World-control surface the host wires so state effects can actually pause/steer the world (Phase 3).
 *  Every call is optional — unwired controls silently no-op (and still reach the effectHook for observers). */
export interface UIWorldControlHook {
  /** freezeWorld: pause/resume world time + animation (UI time keeps running). */
  setFrozen?(frozen: boolean): void;
  /** setWorldSpeed: scale world time (1 = normal, 0 = frozen, 0.5 = slow-mo). */
  setSpeed?(speed: number): void;
  /** setCamera: move the 3D camera (instant, or tweened over durationMs by the host). */
  setCamera?(position?: [number, number, number], target?: [number, number, number], durationMs?: number): void;
  /** playAnimation: play a skeleton clip on a target (a Skeleton3D node id, or a SkinnedMesh3D whose skeleton
   *  is resolved). clipId matches SkeletonAnimClip.id or .name; omitted = the target's first clip. */
  playAnimation?(targetId: string, clipId?: string, loop?: boolean, blendFrames?: number): void;
  /** stopAnimation: stop + rewind the target's UI-driven clip player. */
  stopAnimation?(targetId: string): void;
  /** pauseAnimation: pause the target's UI-driven clip player in place. */
  pauseAnimation?(targetId: string): void;
  /** seekAnimation: jump the target's UI-driven clip player to a frame (starts one paused if none). */
  seekAnimation?(targetId: string, frame: number): void;
}

/** Playback surface for the sound actions (playSound / stopSound / setVolume). Supplied by ShapeManager
 *  (UISoundPlayer over HTMLAudioElements); tests use a fake. Unwired = actions no-op (still reach effectHook). */
export interface UISoundAdapter {
  play(assetId: string, volume?: number, loop?: boolean): void;
  stop(assetId: string): void;
  setVolume(assetId: string, volume: number): void;
  /** Silence everything — called when interactivity turns off. */
  stopAll?(): void;
}

/** DOM surface for HTML form elements (Phase 4). The manager owns WHICH elements are mounted (state-filtered)
 *  and all form semantics (validity, submit values, variable bindings); the adapter just renders native inputs
 *  over the canvas and reports typing. Supplied by ShapeManager (UIFormOverlay); tests use a fake. */
export interface UIFormAdapter {
  /** Replace the mounted element set (already filtered to the current states; [] = unmount everything). */
  sync(elements: HtmlFormElement[]): void;
  /** Current value of a mounted element (checkbox → boolean). Null when not mounted. */
  getValue(elementId: string): string | boolean | null;
  /** Programmatic write (variable → input direction of a binding). */
  setValue(elementId: string, value: string | boolean): void;
  focus(elementId: string): void;
}

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

/** A modal state's dim opacity factor for its worldBlur strength s (0..1): 0 → 1 over s 0..0.5, full above. */
export function worldDimFactor(s: number): number {
  return Math.max(0, Math.min(1, s * 2));
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
  /** In-flight state-transition animation (drives the fullscreen fade/slide/wipe/iris over the scrim). */
  private _transition: { anim: TransitionAnimation; elapsedMs: number } | null = null;
  /** Dynamic world-blur override (the setWorldBlur effect) — max()ed with the modal state's worldBlur. */
  private _dynamicBlur = 0;
  /** World-control hook (freeze / speed / camera) — wired by the host (ShapeManager). */
  private _world: UIWorldControlHook | null = null;
  /** HTML-form DOM adapter (Phase 4) — wired by the host; null = forms silently unmounted. */
  private _forms: UIFormAdapter | null = null;
  /** Storage for `SceneVariable.persistent` values (progress/settings). undefined = resolve to localStorage lazily. */
  private _varStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null | undefined;
  /** Sound playback surface — wired by the host; null = sound actions no-op. */
  private _sound: UISoundAdapter | null = null;

  constructor(ctx: ManagerContext) { this.ctx = ctx; }

  // ── Events + hooks ──────────────────────────────────────────────────────────────────────────────────────
  /** Subscribe to UI events (state changes, variable changes, custom emitEvent). Returns an unsubscribe fn. */
  onUIEvent(cb: (e: UIEvent) => void): () => void {
    const sub = this._events.subscribe(cb);
    return () => sub.unsubscribe();
  }
  /** Surface a custom event to onUIEvent subscribers — the target of a Script Behavior's `ctx.emit(name)`. */
  emitCustom(eventName: string, payload?: Record<string, unknown>): void {
    this._events.emit({ type: 'custom', eventName, payload });
  }
  /** Wire world-control effects — receives every effect this class doesn't apply itself (and, for observability,
   *  the world-control effects it now DOES apply via the world hook). */
  setEffectHook(hook: ((effect: UIEffect) => void) | null): void { this._effectHook = hook; }
  /** Wire the world-control surface (freeze / speed / camera) so state effects actually drive the world. */
  setWorldControlHook(hook: UIWorldControlHook | null): void { this._world = hook; }
  /** Wire the HTML-form DOM surface (Phase 4) and mount whatever the current states call for. */
  setFormAdapter(adapter: UIFormAdapter | null): void { this._forms = adapter; this._syncForms(); }
  /** Wire the sound playback surface so playSound/stopSound/setVolume actions actually make noise. */
  setSoundAdapter(adapter: UISoundAdapter | null): void { this._sound = adapter; }
  /** Override where `SceneVariable.persistent` values live (defaults to localStorage; tests inject a fake). */
  setVariableStorage(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null): void {
    this._varStorage = storage;
  }
  private get varStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
    if (this._varStorage === undefined) this._varStorage = typeof localStorage !== 'undefined' ? localStorage : null;
    return this._varStorage;
  }

  /** Save a persistent variable's new value under its machine id (keyed `salsa-ui-vars:<machineId>`). */
  private _persistVariable(variableId: string, value: UIValue): void {
    const store = this.varStorage;
    if (!store) return;
    for (const rec of this._layers.values()) {
      if (!rec.data.stateMachine.variables.find((v) => v.id === variableId)?.persistent) continue;
      const key = `salsa-ui-vars:${rec.data.stateMachine.id}`;
      let bag: Record<string, UIValue> = {};
      try { bag = JSON.parse(store.getItem(key) ?? '{}') as Record<string, UIValue>; } catch { bag = {}; }
      bag[variableId] = value;
      try { store.setItem(key, JSON.stringify(bag)); } catch { /* quota / private mode — non-fatal */ }
    }
  }
  /** Seed a fresh runtime's persistent variables from storage (silently — no watch transitions on load). */
  private _seedPersistedVariables(rec: UILayerRec): void {
    const store = this.varStorage;
    if (!store || !rec.runtime) return;
    try {
      const bag = JSON.parse(store.getItem(`salsa-ui-vars:${rec.data.stateMachine.id}`) ?? '{}') as Record<string, UIValue>;
      for (const v of rec.data.stateMachine.variables) {
        if (v.persistent && bag[v.id] !== undefined) rec.runtime.seedVariable(v.id, bag[v.id]);
      }
    } catch { /* corrupt bag → defaults */ }
  }

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
    if (ok) this._syncForms();
    return ok;
  }

  // ── State machine ───────────────────────────────────────────────────────────────────────────────────────
  /** Install a state machine and enter its initial state (applies the initial visibility + onEnter effects). */
  setStateMachine(layerId: string, machine: UIStateMachine): void {
    const rec = this._layers.get(layerId);
    if (!rec) return;
    rec.data.stateMachine = machine;
    rec.runtime = new UIStateMachineRuntime(machine, { formValid: (fid) => this.isFormValid(fid) });
    this._seedPersistedVariables(rec);   // restore persistent variables BEFORE entering the initial state
    if (machine.initialStateId) this._apply(rec.runtime.start());
    this._syncForms();
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
    // pressAnimationClipId: one-shot clip on the shape itself (a skinned 3D button squishes when pressed).
    const press = this._layers.get(layerId)?.data.shapeInteractions[shapeId]?.pressAnimationClipId;
    if (press) this._world?.playAnimation?.(shapeId, press, false);
    this.dispatchTrigger(layerId, { type: 'click', targetId: shapeId });
  }
  hoverShape(shapeId: string, entering: boolean, layerId = this._activeLayerId): void {
    if (!layerId) return;
    this._events.emit({ type: entering ? 'shapeHover' : 'shapeHoverEnd', shapeId });
    // hoverAnimationClipId: loops on the shape while hovered, stops on leave (skinned 3D targets).
    const hover = this._layers.get(layerId)?.data.shapeInteractions[shapeId]?.hoverAnimationClipId;
    if (hover) { if (entering) this._world?.playAnimation?.(shapeId, hover, true); else this._world?.stopAnimation?.(shapeId); }
    this.dispatchTrigger(layerId, { type: entering ? 'hover' : 'hoverEnd', targetId: shapeId });
  }
  keyDown(key: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'keyDown', key }); }
  /** A Play-mode trigger volume was entered/exited — run its transition on the active UI layer (no-op if none). */
  volumeEnter(volumeId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'enterVolume', volumeId }); }
  volumeExit(volumeId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'exitVolume', volumeId }); }
  /** The player used a nearby interactable — run its transition on the active UI layer (no-op if none). */
  interact(targetId: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'interact', targetId }); }
  /** A non-looping clip finished on `targetId` — fire the `animationFinished` transition (one-shot chaining). */
  animationFinished(targetId: string, clipId?: string, layerId = this._activeLayerId): void { if (layerId) this.dispatchTrigger(layerId, { type: 'animationFinished', targetId, clipId }); }

  /** Advance every live layer's clock so `timer` transitions fire, and step the state-transition fade. The host
   *  calls this each frame while in interactive preview. No-op off-preview. */
  tick(dtMs: number): void {
    if (!this._interactive) return;
    this._pollGamepads();
    for (const rec of this._layers.values()) if (rec.runtime) this._apply(rec.runtime.tick(dtMs));
    if (this._transition) {
      this._transition.elapsedMs += dtMs;
      if (this._transition.elapsedMs >= this._transition.anim.duration) this._transition = null;
      this.ctx.scheduleRender();   // keep repainting through the transition
    }
  }

  // ── Gamepad (edge-detected polling inside tick) ─────────────────────────────────────────────────────────
  /** Gamepad snapshot source — defaults to navigator.getGamepads(); injectable for tests. */
  private _gamepadSource: (() => ReadonlyArray<{ buttons: ReadonlyArray<{ pressed: boolean }>; axes: ReadonlyArray<number> } | null>) | null = null;
  private _padPrev: { buttons: boolean[]; axes: number[] }[] = [];
  setGamepadSource(fn: (() => ReadonlyArray<{ buttons: ReadonlyArray<{ pressed: boolean }>; axes: ReadonlyArray<number> } | null>) | null): void {
    this._gamepadSource = fn;
    this._padPrev = [];
  }

  /** Fire gamepadButton on press edges and gamepadAxis on ±0.5 threshold crossings (standard mapping indices). */
  private _pollGamepads(): void {
    const src = this._gamepadSource
      ?? (typeof navigator !== 'undefined' && navigator.getGamepads ? () => navigator.getGamepads() : null);
    if (!src || !this._activeLayerId) return;
    const pads = src();
    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];
      if (!pad) continue;
      const prev = (this._padPrev[p] ??= { buttons: [], axes: [] });
      for (let i = 0; i < pad.buttons.length; i++) {
        const pressed = pad.buttons[i].pressed;
        if (pressed && !(prev.buttons[i] ?? false)) {
          // standard mapping: d-pad up/down (12/13) move a shown kit menu, A (0) confirms it
          if (i === 12 || i === 13) this.kitMenuMove(i === 12 ? -1 : 1);
          else if (i === 0) this.kitMenuActivate();
          this.dispatchTrigger(this._activeLayerId, { type: 'gamepadButton', button: i });
        }
        prev.buttons[i] = pressed;
      }
      const TH = 0.5;
      for (let i = 0; i < pad.axes.length; i++) {
        const v = pad.axes[i], was = prev.axes[i] ?? 0;
        if (v >= TH && was < TH) this.dispatchTrigger(this._activeLayerId, { type: 'gamepadAxis', axis: i, direction: 'positive' });
        if (v <= -TH && was > -TH) this.dispatchTrigger(this._activeLayerId, { type: 'gamepadAxis', axis: i, direction: 'negative' });
        prev.axes[i] = v;
      }
    }
  }

  /** Begin a fullscreen state-transition (interactive only). fade dissolves; slideL/R/U/D sweep a soft curtain;
   *  wipe sweeps a hard edge; zoom/zoomOut iris in/out — the scrim shader draws the mask (Phase 3). */
  private _startTransition(anim: TransitionAnimation): void {
    if (!this._interactive || anim.type === 'none' || anim.duration <= 0) { this._transition = null; return; }
    this._transition = { anim, elapsedMs: 0 };
    this.ctx.scheduleRender();
  }

  /** Map the in-flight transition to the scrim overlay (mask mode / direction / eased progress). */
  private _transitionOverlay(): UIOverlayState | null {
    if (!this._transition) return null;
    const { anim, elapsedMs } = this._transition;
    const et = ease(anim.easing, Math.min(1, elapsedMs / Math.max(1, anim.duration)));
    const masked = (mode: 1 | 2 | 3, dir: [number, number], soft: number, color: [number, number, number]): UIOverlayState =>
      ({ color: [color[0], color[1], color[2], 1], mode, dir, progress: et, soft, blur: 0 });
    switch (anim.type) {
      case 'slideLeft':  return masked(1, [-1, 0], 0.30, [0, 0, 0]);
      case 'slideRight': return masked(1, [1, 0],  0.30, [0, 0, 0]);
      case 'slideUp':    return masked(1, [0, -1], 0.30, [0, 0, 0]);   // uv y is DOWN → reveal starts at the bottom
      case 'slideDown':  return masked(1, [0, 1],  0.30, [0, 0, 0]);
      case 'wipe':       return masked(1, [1, 0],  0.03, [1, 1, 1]);   // hard white edge
      case 'zoom':       return masked(2, [0, 0],  0.10, [0, 0, 0]);   // iris opens centre-out
      case 'zoomOut':    return masked(3, [0, 0],  0.10, [0, 0, 0]);   // iris closes edge-in (reveals at edges)
      default: {          // fade / custom → full-screen dissolve
        const a = 1 - et;
        return a > 0.001 ? { color: [0, 0, 0, a], mode: 0, dir: [0, 0], progress: 0, soft: 0, blur: 0 } : null;
      }
    }
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
    // A shown kit menu takes the arrow keys (+ W/S) and Enter/Space (when no authored focus ring is active).
    if (this._kitActiveMenu()) {
      const up = key === 'ArrowUp' || key === 'w' || key === 'W', down = key === 'ArrowDown' || key === 's' || key === 'S';
      if (up || down) { this.kitMenuMove(up ? -1 : 1); this.keyDown(key); return true; }
      if ((key === 'Enter' || key === ' ' || key === 'Spacebar') && !this._focusedShapeId) { this.kitMenuActivate(); return true; }
    }
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
      this._sound?.stopAll?.();   // leaving preview: silence UI-driven audio
    }
    this._syncForms();   // mount form elements entering preview, unmount them all when leaving
  }
  get interactive(): boolean { return this._interactive; }
  /** Provide a 3D-mesh ray-pick (canvas px → mesh node id) so a 3D mesh can be an interactive UI target. */
  setMeshPicker(fn: ((canvasX: number, canvasY: number) => string | null) | null): void { this._meshPick = fn; }
  /** Provide the ephemera adapter so ephemera placements can be interactive UI targets. */
  setEphemeraAdapter(adapter: UIEphemeraAdapter | null): void { this._ephemera = adapter; }

  // ── HTML forms (Phase 4) ────────────────────────────────────────────────────────────────────────────────
  // The manager owns which elements are mounted + all form semantics; the adapter is just the DOM surface.
  // A form is a GROUP of elements: el.formId tags membership; an untagged element belongs to EVERY form.

  /** Elements that should be mounted now: interactive + layer visible + visible in the layer's CURRENT state. */
  private _mountedFormElements(): { el: HtmlFormElement; layerId: string }[] {
    if (!this._interactive) return [];
    const out: { el: HtmlFormElement; layerId: string }[] = [];
    for (const rec of this._layers.values()) {
      if (!rec.data.visible || !rec.runtime) continue;
      const cur = rec.runtime.currentStateId;
      for (const el of rec.data.stateMachine.htmlForms ?? []) {
        if (!el.visibleInStates || (cur != null && el.visibleInStates.includes(cur))) out.push({ el, layerId: rec.data.id });
      }
    }
    return out;
  }
  private _syncForms(): void { this._forms?.sync(this._mountedFormElements().map((m) => m.el)); }
  private _formMembers(formId: string): { el: HtmlFormElement; layerId: string }[] {
    return this._mountedFormElements().filter(({ el }) => el.formId == null || el.formId === formId);
  }

  /** The `formValid` condition: every mounted REQUIRED member has a non-empty value (checkbox → checked). */
  isFormValid(formId: string): boolean {
    if (!this._forms) return true;   // no DOM surface (headless) → don't block transitions
    return this._formMembers(formId).every(({ el }) => {
      if (!el.required) return true;
      const v = this._forms!.getValue(el.id);
      return el.type === 'checkbox' ? v === true : typeof v === 'string' && v.trim().length > 0;
    });
  }

  /** Re-entrancy guard: a formSubmit transition whose actions submit again must not recurse forever. */
  private _submitDepth = 0;

  /** Submit a form: gather its values, surface the formSubmit UIEvent, and fire the formSubmit trigger on the
   *  layer(s) owning its elements (a `submitForm` action calls this; so does Enter in a text field). */
  submitForm(formId: string): void {
    if (!this._interactive || this._submitDepth >= 4) return;
    this._submitDepth++;
    try { this._submitForm(formId); } finally { this._submitDepth--; }
  }
  private _submitForm(formId: string): void {
    const members = this._formMembers(formId);
    const values: Record<string, string | boolean> = {};
    for (const { el } of members) { const v = this._forms?.getValue(el.id); if (v != null) values[el.id] = v; }
    this._events.emit({ type: 'formSubmit', formId, values });
    const layerIds = new Set(members.map((m) => m.layerId));
    if (!layerIds.size && this._activeLayerId) layerIds.add(this._activeLayerId);   // formId with no elements: still a trigger
    for (const lid of layerIds) this.dispatchTrigger(lid, { type: 'formSubmit', formId });
  }

  /** The overlay reports typing here — the element→variable half of a two-way `variableBinding`. */
  handleFormInput(elementId: string, value: string | boolean): void {
    for (const rec of this._layers.values()) {
      const el = (rec.data.stateMachine.htmlForms ?? []).find((f) => f.id === elementId);
      if (el?.variableBinding && rec.runtime) this._apply(rec.runtime.setVariableValue(el.variableBinding, value));
    }
  }

  /** Clear a form's mounted fields and reset their bound variables (the `clearForm` action). */
  clearForm(formId: string): void {
    for (const { el, layerId } of this._formMembers(formId)) {
      const cleared = el.type === 'checkbox' || el.type === 'radio' ? false : '';
      this._forms?.setValue(el.id, cleared);
      const rec = this._layers.get(layerId);
      if (el.variableBinding && rec?.runtime) this._apply(rec.runtime.setVariableValue(el.variableBinding, cleared));
    }
  }

  /** Current value of a mounted form element (reads the DOM through the adapter). */
  getFormValue(elementId: string): string | boolean | null { return this._forms?.getValue(elementId) ?? null; }

  /** Author API: add a form element to a layer's machine (mounts immediately if its state is current). */
  addHtmlFormElement(element: HtmlFormElement, layerId = this._activeLayerId): void {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec) return;
    const forms = (rec.data.stateMachine.htmlForms ??= []);
    const i = forms.findIndex((f) => f.id === element.id);
    if (i >= 0) forms[i] = element; else forms.push(element);
    this._syncForms();
  }
  /** Author API: remove a form element by id. */
  removeHtmlFormElement(elementId: string, layerId = this._activeLayerId): void {
    const rec = layerId ? this._layers.get(layerId) : null;
    if (!rec?.data.stateMachine.htmlForms) return;
    rec.data.stateMachine.htmlForms = rec.data.stateMachine.htmlForms.filter((f) => f.id !== elementId);
    this._syncForms();
  }

  /** The variable→element half of a binding: a variableChange writes back into any input bound to it. */
  private _syncBoundInputs(variableId: string, value: UIValue): void {
    if (!this._forms) return;
    for (const { el } of this._mountedFormElements()) {
      if (el.variableBinding === variableId) this._forms.setValue(el.id, typeof value === 'boolean' ? value : String(value));
    }
  }

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
    // Kit widgets (screen overlay, topmost) first, then ephemera, then 2D shapes, then a 3D-mesh pick.
    const kh = this._kitHit(canvasX, canvasY);
    if (kh) { const mi = this._kitMenuItem(kh); if (mi && this.kit.menuState(mi.w).sel !== mi.index) this._kitMenuSelect(mi.w, mi.index); }
    let hit = kh ?? this.hitTestEphemera(worldX, worldY, layerId) ?? this.hitTest(worldX, worldY, layerId);
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
    const kh = this._kitHit(canvasX, canvasY);
    if (kh) {
      const mi = this._kitMenuItem(kh);
      if (mi) { this._kitMenuSelect(mi.w, mi.index); this.kit.play(mi.w.id, 'pulse'); }
      this.clickShape(kh, this.findKitWidget(mi ? mi.w.id : kh)?.layerId ?? layerId);
      return true;
    }
    let hit = this.hitTestEphemera(worldX, worldY, layerId) ?? this.hitTest(worldX, worldY, layerId);
    if (!hit && canvasX != null && canvasY != null) hit = this.hitTestMesh(canvasX, canvasY, layerId);
    if (hit) { this.clickShape(hit, layerId); return true; }
    return !rec.data.passThroughPointer;   // a modal (non-pass-through) layer swallows misses too
  }

  // ── Render state (consumed by the renderer's dim/scrim pass) ────────────────────────────────────────────
  /** The world-dim overlay to draw right now: the first visible+live layer whose CURRENT state is modal
   *  (worldBlur > 0), using that layer's backgroundOverlay colour (else a default black scrim). Null = no dim.
   *  Only while interactive, so editing is never dimmed. The renderer pulls this each frame. */
  getActiveOverlay(): UIOverlayState | null {
    if (!this._interactive) return null;
    // A state transition covers the screen while it plays (masked reveal / fade of the NEW state).
    const trans = this._transitionOverlay();
    if (trans) return trans;
    // Modal states: dim (backgroundOverlay colour) + TRUE world blur at the state's worldBlur strength.
    for (const rec of this._layers.values()) {
      if (!rec.data.visible || !rec.runtime) continue;
      const cur = rec.runtime.currentStateId;
      const st = cur ? rec.data.stateMachine.states.find((s) => s.id === cur) : null;
      if (!st || !st.worldBlur || st.worldBlur <= 0) continue;   // only MODAL states (worldBlur) dim the world
      const c = rec.data.backgroundOverlay?.color ?? [0, 0, 0, 0.55];
      const s = Math.min(st.worldBlur, 1);
      // The dim fades in over the first half of the strength (full colour from 0.5 — every value the old 0–20 slider
      // could save, and the kit's 0.55, look as before); the blur grows over the whole 0–1 range.
      return { color: [c[0], c[1], c[2], c[3] * worldDimFactor(s)], mode: 0, dir: [0, 0], progress: 0, soft: 0,
               blur: Math.max(s, this._dynamicBlur) };
    }
    // Dynamic setWorldBlur effect without a modal state: blur-only overlay (no dim).
    if (this._dynamicBlur > 0.001) {
      return { color: [0, 0, 0, 0], mode: 0, dir: [0, 0], progress: 0, soft: 0, blur: Math.min(this._dynamicBlur, 1) };
    }
    return null;
  }

  // ── Persistence (ready to wire into the document payload in a later phase) ───────────────────────────────
  serialize(): UILayerData[] { return this.listUILayers(); }
  restore(datas: UILayerData[]): void {
    this._layers.clear();
    this._activeLayerId = null;
    this.kit.clearVisibleOverrides();   // runtime-only kit state never crosses documents
    for (const data of datas) {
      const runtime = data.stateMachine.initialStateId
        ? new UIStateMachineRuntime(data.stateMachine, { formValid: (fid) => this.isFormValid(fid) })
        : null;
      this._layers.set(data.id, { data, runtime });
      this._seedPersistedVariables(this._layers.get(data.id)!);
      runtime?.start();   // re-enter the initial state (visibility is re-applied by the host after restore)
      this._activeLayerId ??= data.id;
    }
  }

  // ── Effect application ──────────────────────────────────────────────────────────────────────────────────
  private _apply(effects: UIEffect[]): void {
    if (!effects.length) return;
    for (const e of effects) {
      switch (e.kind) {
        case 'stateChange':
          this._dynamicBlur = 0;   // per-state blur: the runtime re-emits setWorldBlur right after when the NEW state is modal
          this._events.emit({ type: 'stateChange', fromState: e.from, toState: e.to });
          this._syncForms();       // mount/unmount form elements whose visibleInStates includes the new state
          break;
        case 'variableChange':
          this._events.emit({ type: 'variableChange', variableId: e.variableId, oldValue: e.oldValue, newValue: e.newValue });
          this._syncBoundInputs(e.variableId, e.newValue);   // variable → bound input (two-way binding)
          this._persistVariable(e.variableId, e.newValue);   // persistent variables survive reloads
          break;
        case 'emitEvent':      this._events.emit({ type: 'custom', eventName: e.eventName, payload: e.payload }); break;
        case 'setLayerVisible':    this._setLayerVisible(e.layerId, e.visible); break;
        case 'toggleLayerVisible': this._setLayerVisible(e.layerId, !this._layerVisible(e.layerId)); break;
        case 'setShapeVisible':    this._setShapeVisible(e.shapeId, e.visible); break;
        case 'toggleShapeVisible': this._setShapeVisible(e.shapeId, !this._shapeVisible(e.shapeId)); break;
        case 'openUrl':            if (typeof window !== 'undefined') window.open(e.url, e.target); break;
        case 'transition':
          if (isKitTransition(e.animation.type)) {   // UI-kit transition: drawn by the kit over everything
            if (this._interactive) this.kit.startTransition(e.animation.type, e.animation.duration, e.from, e.to);
            this._transition = null;
          } else this._startTransition(e.animation);   // masked reveal over the scrim
          break;
        // World-control effects (Phase 3): applied through the host-wired world hook; ALSO forwarded to the
        // effectHook so observers (analytics, the Player postMessage bridge) still see them.
        case 'freezeWorld':        this._world?.setFrozen?.(e.frozen); this._effectHook?.(e); break;
        case 'setWorldSpeed':      this._world?.setSpeed?.(e.speed); this._effectHook?.(e); break;
        case 'setWorldBlur':       this._dynamicBlur = Math.max(0, Math.min(1, e.amount)); this._effectHook?.(e); break;
        case 'setCamera':          this._world?.setCamera?.(e.position, e.target, e.duration); this._effectHook?.(e); break;
        case 'playAnimation':
          if (this.findKitWidget(e.targetId)) this.kit.play(e.targetId, kitClipName(e.clipId));   // kit widget clip
          else this._world?.playAnimation?.(e.targetId, e.clipId, e.loop, e.blendFrames);
          this._effectHook?.(e); break;
        case 'stopAnimation':
          if (this.findKitWidget(e.targetId)) this.kit.stop(e.targetId); else this._world?.stopAnimation?.(e.targetId);
          this._effectHook?.(e); break;
        case 'pauseAnimation':     this._world?.pauseAnimation?.(e.targetId); this._effectHook?.(e); break;
        case 'seekAnimation':      this._world?.seekAnimation?.(e.targetId, e.frame); this._effectHook?.(e); break;
        // Form effects (Phase 4): applied via the form adapter.
        case 'clearForm':          this.clearForm(e.formId); this._effectHook?.(e); break;
        case 'focusFormField':     this._forms?.focus(e.elementId); this._effectHook?.(e); break;
        case 'submitForm':         this.submitForm(e.formId); this._effectHook?.(e); break;
        // Sound effects: applied via the sound adapter (assetIds the host registered).
        case 'playSound':          this._sound?.play(e.assetId, e.volume, e.loop); this._effectHook?.(e); break;
        case 'stopSound':          this._sound?.stop(e.assetId); this._effectHook?.(e); break;
        case 'setVolume':          this._sound?.setVolume(e.assetId, e.volume); this._effectHook?.(e); break;
        default:                   this._effectHook?.(e); break;   // anything future stays observable
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
    if (this.findKitWidget(shapeId)) { this.kit.setVisibleOverride(shapeId, visible); return; }
    const node = this.ctx.sceneGraph.findNodeById(shapeId);
    if (node) node.visible = visible;
  }
  private _shapeVisible(shapeId: string): boolean {
    if (this._ephemera?.has(shapeId)) return this._ephemera.isVisible(shapeId);
    const kw = this.findKitWidget(shapeId);
    if (kw) return this.kit.visibleOverride(shapeId) ?? (kw.widget.visible !== false);
    return this.ctx.sceneGraph.findNodeById(shapeId)?.visible ?? true;
  }

  // ── UI KIT (docs/ui/persona-ui-kit.md) ─────────────────────────────────────────────────────────────────────
  // Screen-space widgets stored on each layer (`data.kit`), laid out by src/ui/kit and drawn by one instanced SDF
  // shader on the final swapchain image (post-process immune, full resolution). A widget id behaves like a shape id:
  // state shapeVisibility, show/hide/toggle actions, ShapeInteractionProps (click/hover triggers) and playAnimation.

  /** Kit runtime (visibility, intros, menus, transitions, last frame's pointer targets). */
  readonly kit = new UIKitRuntime();
  private _kitRenderer: UIKitRenderer | null = null;
  private _kitHoverItem: string | null = null;

  /** Find a kit widget (and its layer) by id. */
  findKitWidget(id: string): { layerId: string; widget: UIKitWidget } | null {
    if (!id) return null;
    for (const rec of this._layers.values()) {
      const w = rec.data.kit?.find((k) => k.id === id);
      if (w) return { layerId: rec.data.id, widget: w };
    }
    return null;
  }
  /** Widgets on a layer (the live array — treat as read-only; edit through updateKitWidget). */
  listKitWidgets(layerId = this._activeLayerId): UIKitWidget[] {
    const rec = layerId ? this._layers.get(layerId) : null;
    return rec?.data.kit ?? [];
  }
  /** Add a widget (a kind with schema defaults, or a full draft). Defaults to the active UI layer, creating one
   *  ("UI Kit") when there is none. Returns the new widget. */
  addKitWidget(draft: UIKitKind | KitWidgetDraft, layerId = this._activeLayerId): UIKitWidget {
    const lid = layerId && this._layers.has(layerId) ? layerId : this.createUILayer('UI Kit');
    const rec = this._layers.get(lid)!;
    const d: KitWidgetDraft = typeof draft === 'string' ? { kind: draft, anchor: 'c', x: 0, y: 0, props: kitDefaults(draft) } : draft;
    const w: UIKitWidget = { ...structuredCloneSafe(d), id: `kit-${uid().slice(0, 8)}` };
    (rec.data.kit ??= []).push(w);
    this.ctx.scheduleRender();
    return w;
  }
  /** Merge a patch into a widget (`props` merges key by key). Returns false when the id is unknown. */
  updateKitWidget(id: string, patch: Partial<Omit<UIKitWidget, 'id' | 'props'>> & { props?: Record<string, number | string | boolean> }): boolean {
    const f = this.findKitWidget(id);
    if (!f) return false;
    const { props, ...rest } = patch;
    Object.assign(f.widget, rest);
    if (props) f.widget.props = { ...f.widget.props, ...props };
    this.ctx.scheduleRender();
    return true;
  }
  removeKitWidget(id: string): boolean {
    for (const rec of this._layers.values()) {
      const i = rec.data.kit?.findIndex((k) => k.id === id) ?? -1;
      if (i >= 0) {
        rec.data.kit!.splice(i, 1);
        if (rec.data.shapeInteractions[id]) delete rec.data.shapeInteractions[id];
        this.kit.forget(id);
        this.ctx.scheduleRender();
        return true;
      }
    }
    return false;
  }
  /** Insert a single-piece preset (UI_KIT_PRESETS id). Returns the widget, or null for an unknown preset. */
  insertKitPreset(presetId: string, layerId = this._activeLayerId): UIKitWidget | null {
    const p = kitPreset(presetId);
    return p ? this.addKitWidget(p.make(), layerId) : null;
  }

  /** Insert a demo: 'hud' → a new "Persona HUD" layer (HUD + splash states); 'pause' → the pause menu, merged into
   *  the active layer when it is a HUD demo layer (Escape opens it from 'hud'), else a new "Pause Menu" layer.
   *  Commits the merged state machine (re-enters its initial state — insert while NOT previewing). */
  insertKitDemo(kind: 'hud' | 'pause'): { layerId: string; widgetIds: string[] } {
    let layerId: string;
    let demo: KitDemo;
    if (kind === 'hud') {
      demo = personaHudDemo();
      layerId = this.createUILayer(demo.name);
    } else {
      const act = this._activeLayerId ? this._layers.get(this._activeLayerId) : null;
      const hasHud = !!act?.data.stateMachine.states.some((s) => s.id === 'hud');
      demo = personaPauseDemo(hasHud ? 'hud' : 'play');
      layerId = hasHud && act ? act.data.id : this.createUILayer(demo.name);
    }
    const rec = this._layers.get(layerId)!;
    const widgetIds: string[] = [];
    let menuId = '';
    for (const d of demo.widgets) {
      const w = this.addKitWidget(d, layerId);
      widgetIds.push(w.id);
      if (w.kind === 'menu' && !menuId) menuId = w.id;
    }
    const m = structuredCloneSafe(rec.data.stateMachine);
    for (const s of demo.states) if (!m.states.some((x) => x.id === s.id)) m.states.push(s);
    for (const v of demo.variables) if (!m.variables.some((x) => x.id === v.id)) m.variables.push(v);
    for (const t of demo.transitions) {
      const tt = structuredCloneSafe(t);
      if ('targetId' in tt.trigger && tt.trigger.targetId.startsWith('@menu')) tt.trigger.targetId = menuId + tt.trigger.targetId.slice(5);
      m.transitions = m.transitions.filter((x) => x.id !== tt.id);
      m.transitions.push(tt);
    }
    if (!m.initialStateId) m.initialStateId = demo.initialStateId;
    if (demo.states.some((s) => s.worldBlur)) rec.data.backgroundOverlay ??= { color: [0.06, 0.0, 0.02, 0.38] };
    this.setStateMachine(layerId, m);
    this._activeLayerId = layerId;
    return { layerId, widgetIds };
  }

  /** Play a kit transition right now (authoring preview — works outside interactive mode too). */
  previewKitTransition(type: UIKitTransitionType, durationMs?: number): void {
    this.kit.startTransition(type, durationMs ?? 0, null, '');
    if (type === 'panelSlide' || type === 'zoomPunch') this.kit.replayEntrances();
    this.ctx.scheduleRender();
  }
  /** Play a clip on a kit widget (also reachable from a playAnimation action whose targetId is the widget id). */
  playKitClip(id: string, clip: UIKitClip = 'intro'): void { this.kit.play(id, clip); this.ctx.scheduleRender(); }

  /** Layer views for a kit build. */
  private _kitViews(): KitLayerView[] {
    const out: KitLayerView[] = [];
    for (const rec of this._layers.values()) {
      if (!rec.data.kit?.length) continue;
      out.push({
        id: rec.data.id, visible: rec.data.visible, kit: rec.data.kit,
        currentState: rec.runtime?.currentStateId ?? null,
        interactive: (id) => !!rec.data.shapeInteractions[id],
        vars: (id) => rec.runtime?.getVariable(id),
      });
    }
    return out;
  }
  /** Is there anything for the kit to draw (widgets or a transition)? */
  get hasKitContent(): boolean {
    if (this.kit.transition) return true;
    for (const rec of this._layers.values()) if (rec.data.kit?.length) return true;
    return false;
  }
  /** Lay the kit out for a W x H (device px) frame. Returns true while anything animates. */
  buildKitFrame(W: number, H: number, text: KitTextProvider, cssToDevice = 1): boolean {
    this.kit.cssToDevice = cssToDevice;
    return this.kit.build(this._kitViews(), W, H, text, this._interactive);
  }
  /** Wire the kit's GPU overlay into the renderer (post-process immune, full resolution). */
  attachKitOverlay(renderer: { setUIKitOverlayDrawer?: (fn: ((device: GPUDevice, encoder: GPUCommandEncoder, view: GPUTextureView, w: number, h: number, format: GPUTextureFormat, cssToDevice: number, generation: number) => boolean) | null) => void }): void {
    renderer.setUIKitOverlayDrawer?.((device, encoder, view, w, h, format, cssToDevice, generation) => {
      if (!this.hasKitContent) return false;
      const r = (this._kitRenderer ??= new UIKitRenderer());
      r.prepare(device, format, generation);
      const more = this.buildKitFrame(w, h, r.atlas, cssToDevice);
      r.draw(encoder, view, w, h, this.kit.list, this.kit.now());
      return more;
    });
  }

  /** The topmost visible keyboard-driven menu on the active layer (arrow keys / d-pad / Enter go to it). */
  private _kitActiveMenu(): UIKitWidget | null {
    const rec = this._activeLayerId ? this._layers.get(this._activeLayerId) : null;
    if (!rec?.data.kit?.length || !rec.data.visible) return null;
    const view = this._kitViews().find((v) => v.id === rec.data.id);
    if (!view) return null;
    let best: UIKitWidget | null = null;
    for (const w of rec.data.kit) {
      if (!kitMenuTakesKeys(w) || !this.kit.isShown(view, w, view.currentState)) continue;
      if (!best || (w.z ?? 0) >= (best.z ?? 0)) best = w;
    }
    return best;
  }
  /** Move a menu's selection by delta (wraps); writes its selectedVar binding. Returns the new index. */
  kitMenuMove(delta: number, menuId?: string): number | null {
    const w = menuId ? this.findKitWidget(menuId)?.widget ?? null : this._kitActiveMenu();
    if (!w) return null;
    const vars = (id: string) => this._layers.get(this.findKitWidget(w.id)!.layerId)?.runtime?.getVariable(id);
    const cur = this.kit.menuState(w, vars).sel;
    return this._kitMenuSelect(w, cur + delta);
  }
  private _kitMenuSelect(w: UIKitWidget, index: number): number {
    const i = this.kit.setMenuSelection(w, index);
    const vid = kitStr(w, 'selectedVar');
    const lid = this.findKitWidget(w.id)?.layerId;
    if (vid && lid && this._layers.get(lid)?.runtime?.getVariable(vid) !== undefined) this.setUIVariable(lid, vid, i);
    this.ctx.scheduleRender();
    return i;
  }
  /** Activate (click) the selected item of the active / given menu. */
  kitMenuActivate(menuId?: string): boolean {
    const w = menuId ? this.findKitWidget(menuId)?.widget ?? null : this._kitActiveMenu();
    if (!w) return false;
    const lid = this.findKitWidget(w.id)!.layerId;
    const sel = this.kit.menuState(w, (id) => this._layers.get(lid)?.runtime?.getVariable(id)).sel;
    if (sel < 0 || sel >= menuItems(w).length) return false;
    this.kit.play(w.id, 'pulse');
    this.clickShape(menuItemId(w, sel), lid);
    return true;
  }
  /** Kit pointer target under a CSS-px canvas point: a menu item id, or a widget with interaction props. */
  private _kitHit(canvasX?: number, canvasY?: number): string | null {
    if (canvasX == null || canvasY == null) return null;
    return this.kit.hitTest(canvasX, canvasY)?.id ?? null;
  }
  /** Is `id` a menu item id ("<menuWidgetId>#<slug>")? → the menu + item index. */
  private _kitMenuItem(id: string): { w: UIKitWidget; index: number } | null {
    const hash = id.indexOf('#');
    if (hash < 0) return null;
    const w = this.findKitWidget(id.slice(0, hash))?.widget;
    if (!w || w.kind !== 'menu') return null;
    const n = menuItems(w).length;
    for (let i = 0; i < n; i++) if (menuItemId(w, i) === id) return { w, index: i };
    return null;
  }
}

function structuredCloneSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
/** A playAnimation clipId → a kit clip ('intro' when omitted / unknown). */
function kitClipName(clipId?: string): UIKitClip { return (UI_KIT_CLIPS as readonly string[]).includes(clipId ?? '') ? clipId as UIKitClip : 'intro'; }
