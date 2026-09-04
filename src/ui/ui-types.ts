/**
 * src/ui/ui-types.ts
 *
 * Data model for the Salsa UI System (docs/specs/ui-system.md) — a `ui-layer` that composites on top of the whole
 * scene and drives interactive menus/HUDs via a pure STATE MACHINE. These are plain data types (no engine, no GPU);
 * the runtime lives in ui-state-machine.ts and the host adapter (ShapeManager) applies the emitted effects.
 *
 * Design: the engine is PURE. It never touches layers, the renderer, the DOM or the clock directly — instead
 * `dispatch()` returns an ordered list of UIEffect the HOST performs (show a layer, open a URL, freeze the world,
 * emit an event…). This keeps the whole state machine deterministic + unit-testable without a GPU, exactly like the
 * packaging / CD-kit pure-logic + host-adapter split.
 */

/** A runtime variable value. */
export type UIValue = boolean | number | string;

/** Comparison operators shared by variable triggers + conditions. */
export type UICompareOp = '==' | '!=' | '>' | '<' | '>=' | '<=';

// ── Triggers ────────────────────────────────────────────────────────────────────────────────────────────────
/** Every way a transition can be triggered (spec §InteractionTrigger). */
export type InteractionTrigger =
  | { type: 'click';       targetId: string }
  | { type: 'hover';       targetId: string }
  | { type: 'hoverEnd';    targetId: string }
  | { type: 'pointerDown'; targetId: string }
  | { type: 'pointerUp';   targetId: string }
  | { type: 'keyDown';     key: string }
  | { type: 'keyUp';       key: string }
  | { type: 'timer';       delay: number }
  | { type: 'variable';    variableId: string; op: UICompareOp; value: UIValue }
  | { type: 'formSubmit';  formId: string }
  | { type: 'stateEnter';  stateId: string }
  | { type: 'stateExit';   stateId: string }
  | { type: 'gamepadButton'; button: number }
  | { type: 'gamepadAxis';   axis: number; direction: 'positive' | 'negative' }
  // Spatial gameplay triggers — fired from Play mode as the player's feet cross a trigger volume
  // (docs/specs/play-mode.md, game/trigger-volumes.ts). The `volumeId` matches the TriggerVolume's id.
  | { type: 'enterVolume';   volumeId: string }
  | { type: 'exitVolume';    volumeId: string }
  // The player pressed "use" on a nearby interactable (game/interaction.ts). `targetId` = the Interactable's id.
  | { type: 'interact';      targetId: string };

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Everything a transition (or a state's onEnter/onExit) can do (spec §Action). */
export type Action =
  | { type: 'goToState';      stateId: string; animation?: TransitionAnimation }
  | { type: 'goBack' }
  | { type: 'openUrl';        url: string; target?: '_blank' | '_self' | '_parent' }
  | { type: 'showLayer';      layerId: string }
  | { type: 'hideLayer';      layerId: string }
  | { type: 'showShape';      shapeId: string }
  | { type: 'hideShape';      shapeId: string }
  | { type: 'toggleLayer';    layerId: string }
  | { type: 'toggleShape';    shapeId: string }
  | { type: 'playAnimation';  targetId: string; clipId?: string; loop?: boolean }
  | { type: 'stopAnimation';  targetId: string }
  | { type: 'pauseAnimation'; targetId: string }
  | { type: 'seekAnimation';  targetId: string; frame: number }
  | { type: 'freezeWorld';    frozen: boolean }
  | { type: 'setWorldSpeed';  speed: number }
  | { type: 'setCamera';      position?: [number, number, number]; target?: [number, number, number]; duration?: number }
  | { type: 'setVariable';    variableId: string; value: UIValue }
  | { type: 'addVariable';    variableId: string; amount: number }
  | { type: 'toggleVariable'; variableId: string }
  | { type: 'playSound';      assetId: string; volume?: number; loop?: boolean }
  | { type: 'stopSound';      assetId: string }
  | { type: 'setVolume';      assetId: string; volume: number }
  | { type: 'clearForm';      formId: string }
  | { type: 'focusFormField'; elementId: string }
  | { type: 'emitEvent';      eventName: string; payload?: Record<string, unknown> };

// ── Conditions ──────────────────────────────────────────────────────────────────────────────────────────────
/** Guards on a transition — ALL must pass for it to fire (spec §Condition). */
export type Condition =
  | { type: 'variable';     variableId: string; op: UICompareOp; value: UIValue }
  | { type: 'stateHistory'; stateId: string; visited: boolean }
  | { type: 'formValid';    formId: string }
  | { type: 'not';          condition: Condition };

/** Visual effect played between two states (spec §TransitionAnimation). */
export interface TransitionAnimation {
  type: 'none' | 'fade' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'zoom' | 'zoomOut' | 'wipe' | 'custom';
  duration: number;
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';
  customClipId?: string;
}

// ── State machine ───────────────────────────────────────────────────────────────────────────────────────────
/** A named mode of the scene (spec §SceneState). */
export interface SceneState {
  id: string;
  name: string;
  /** Layer visibility overrides applied on enter. Omitted layers keep their current visibility. */
  layerVisibility?: Record<string, boolean>;
  /** Per-shape visibility overrides applied on enter. */
  shapeVisibility?: Record<string, boolean>;
  /** Pause all AnimationPlayer3D / NLA / cloth / particles while active (pause menus). */
  frozen?: boolean;
  /** GPU Gaussian blur (≈px) on the world beneath the UI while active. */
  worldBlur?: number;
  /** Actions run once when this state becomes active. */
  onEnter?: Action[];
  /** Actions run once when leaving this state (before the next state's onEnter). */
  onExit?: Action[];
}

/** A rule: when `trigger` fires (and `conditions` pass), run `actions` and move to `toState` (spec §StateTransition). */
export interface StateTransition {
  id: string;
  /** Source state id, or '*' = fires from ANY state (global shortcut). */
  fromState: string | '*';
  toState: string;
  trigger: InteractionTrigger;
  conditions?: Condition[];
  actions?: Action[];
  animation?: TransitionAnimation;
}

/** A runtime value that persists across transitions and drives conditional logic (spec §SceneVariable). */
export interface SceneVariable {
  id: string;
  name: string;
  type: 'boolean' | 'number' | 'string';
  defaultValue: UIValue;
  /** Persist to host storage keyed by scene id (progress/unlockables/settings). */
  persistent?: boolean;
}

/** Native HTML form control positioned over the canvas (spec §HtmlFormElement) — declared here; wired in a later phase. */
export interface HtmlFormElement {
  id: string;
  type: 'text' | 'password' | 'number' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox' | 'radio';
  canvasBounds: { x: number; y: number; width: number; height: number };
  placeholder?: string;
  label?: string;
  required?: boolean;
  options?: string[];
  variableBinding?: string;
  visibleInStates?: string[];
  style?: Record<string, string | number>;
}

/** The state machine that governs a UI layer's interactivity (spec §UIStateMachine). */
export interface UIStateMachine {
  id: string;
  /** State shown on load. */
  initialStateId: string;
  states: SceneState[];
  transitions: StateTransition[];
  variables: SceneVariable[];
  htmlForms?: HtmlFormElement[];
  /** Transitions active regardless of the current state (e.g. Escape → pause from anywhere). */
  globalTransitions?: StateTransition[];
}

/** Interaction props attached to ANY shape (in any layer) to make it respond to input (spec §ShapeInteractionProps). */
export interface ShapeInteractionProps {
  shapeId: string;
  cursor?: 'pointer' | 'default' | 'text' | 'grab' | 'crosshair' | 'none';
  hoverAnimationClipId?: string;
  pressAnimationClipId?: string;
  focusable?: boolean;
  tabIndex?: number;
  /** A shape the author designed as this element's FOCUS RING (glow/outline). The system shows it while this
   *  element is focused and hides it otherwise — so the focus visual is authored like any other shape. */
  focusIndicatorShapeId?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** When this SceneVariable is falsy, the shape is auto-disabled. */
  disabledWhenVariable?: string;
}

/** The UI layer (spec §UILayer) — a new layer type that composites LAST and owns the state machine. */
export interface UILayerData {
  id: string;
  name: string;
  type: 'ui-layer';
  visible: boolean;
  stateMachine: UIStateMachine;
  /** When true, pointer events that miss every interactive shape fall through to the layers below. */
  passThroughPointer: boolean;
  /** Optional dimming overlay drawn behind the UI shapes (modal look). */
  backgroundOverlay?: { color: [number, number, number, number] };
  /** Per-shape interaction props, keyed by shapeId (shapes may live in any layer). */
  shapeInteractions: Record<string, ShapeInteractionProps>;
}

// ── Effects (engine → host) ─────────────────────────────────────────────────────────────────────────────────
/**
 * The side effects the pure engine asks the host to perform. `dispatch()`/`start()` return these in order; the
 * ShapeManager adapter applies them (toggle a layer, open a URL, freeze the world…). Keeping them as data — not
 * direct calls — is what makes the whole state machine unit-testable without a renderer or DOM.
 */
export type UIEffect =
  | { kind: 'stateChange';        from: string | null; to: string }
  | { kind: 'transition';         animation: TransitionAnimation; from: string | null; to: string }
  | { kind: 'setLayerVisible';    layerId: string; visible: boolean }
  | { kind: 'toggleLayerVisible'; layerId: string }
  | { kind: 'setShapeVisible';    shapeId: string; visible: boolean }
  | { kind: 'toggleShapeVisible'; shapeId: string }
  | { kind: 'openUrl';            url: string; target: '_blank' | '_self' | '_parent' }
  | { kind: 'emitEvent';          eventName: string; payload?: Record<string, unknown> }
  | { kind: 'freezeWorld';        frozen: boolean }
  | { kind: 'setWorldSpeed';      speed: number }
  | { kind: 'setWorldBlur';       amount: number }
  | { kind: 'playAnimation';      targetId: string; clipId?: string; loop?: boolean }
  | { kind: 'stopAnimation';      targetId: string }
  | { kind: 'pauseAnimation';     targetId: string }
  | { kind: 'seekAnimation';      targetId: string; frame: number }
  | { kind: 'setCamera';          position?: [number, number, number]; target?: [number, number, number]; duration?: number }
  | { kind: 'playSound';          assetId: string; volume?: number; loop?: boolean }
  | { kind: 'stopSound';          assetId: string }
  | { kind: 'setVolume';          assetId: string; volume: number }
  | { kind: 'clearForm';          formId: string }
  | { kind: 'focusFormField';     elementId: string }
  | { kind: 'variableChange';     variableId: string; oldValue: UIValue; newValue: UIValue };

/** A high-level UI event surfaced to the host via `onUIEvent()` (spec §UIEvent). */
export type UIEvent =
  | { type: 'stateChange';    fromState: string | null; toState: string }
  | { type: 'shapeClick';     shapeId: string }
  | { type: 'shapeHover';     shapeId: string }
  | { type: 'shapeHoverEnd';  shapeId: string }
  | { type: 'variableChange'; variableId: string; oldValue: UIValue; newValue: UIValue }
  | { type: 'formSubmit';     formId: string; values: Record<string, string | boolean> }
  | { type: 'custom';         eventName: string; payload?: Record<string, unknown> };
