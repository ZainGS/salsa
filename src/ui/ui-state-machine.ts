/**
 * src/ui/ui-state-machine.ts
 *
 * The PURE runtime for the UI System (docs/specs/ui-system.md). It holds the current state, variable values and the
 * navigation history, and turns incoming triggers (a click on a shape, a key press, a variable reaching a value)
 * into an ORDERED list of UIEffect for the host to perform. It never touches layers, the renderer, the DOM or the
 * clock — so the whole menu/HUD state machine is deterministic and unit-testable without a GPU (same pure-logic +
 * host-adapter split as the packaging / CD-kit engines). The ShapeManager adapter (a later phase) feeds it input
 * and applies the effects.
 */

import type {
  UIStateMachine, StateTransition, SceneState, Action, Condition, InteractionTrigger,
  TransitionAnimation, UIEffect, UIValue,
} from './ui-types';

/** Recursion cap for cascading transitions (goToState-in-onEnter, variable-watch chains, stateEnter chains) so a
 *  circular authoring mistake can never hang the host — it just stops emitting after this many nested hops. */
const MAX_CASCADE_DEPTH = 24;

export interface UIRuntimeOptions {
  /** Host resolver for the `formValid` condition (a later phase supplies real form state); defaults to always-valid. */
  formValid?: (formId: string) => boolean;
}

export class UIStateMachineRuntime {
  private readonly _machine: UIStateMachine;
  private _current: string | null = null;              // null until start()
  private readonly _variables: Record<string, UIValue> = {};
  private readonly _history: string[] = [];            // back-stack of states (goBack pops it)
  private readonly _visited = new Set<string>();       // every state ever entered (stateHistory condition)
  private readonly _formValid?: (formId: string) => boolean;
  private _stateElapsedMs = 0;                          // time in the current state (drives `timer` triggers)
  private _firedTimers = new Set<string>();            // timer transition ids already fired this state visit

  constructor(machine: UIStateMachine, opts?: UIRuntimeOptions) {
    this._machine = machine;
    for (const v of machine.variables) this._variables[v.id] = v.defaultValue;
    this._formValid = opts?.formValid;
  }

  // ── Public surface ──────────────────────────────────────────────────────────────────────────────────────
  /** Enter the initial state. Call once before dispatching; returns the enter effects (visibility, onEnter, …). */
  start(): UIEffect[] { return this._enterState(this._machine.initialStateId, { pushHistory: false }, 0); }

  /** Feed one trigger; returns the ordered effects of the first matching transition (empty if none matched). */
  dispatch(trigger: InteractionTrigger): UIEffect[] {
    const t = this._find((def) => this._triggerMatches(def.trigger, trigger));
    return t ? this._exec(t, 0) : [];
  }

  /** Convenience dispatchers the host uses from pointer/keyboard handlers. */
  clickShape(shapeId: string): UIEffect[]     { return this.dispatch({ type: 'click', targetId: shapeId }); }
  hoverShape(shapeId: string): UIEffect[]      { return this.dispatch({ type: 'hover', targetId: shapeId }); }
  hoverEndShape(shapeId: string): UIEffect[]   { return this.dispatch({ type: 'hoverEnd', targetId: shapeId }); }
  pointerDownShape(shapeId: string): UIEffect[]{ return this.dispatch({ type: 'pointerDown', targetId: shapeId }); }
  pointerUpShape(shapeId: string): UIEffect[]  { return this.dispatch({ type: 'pointerUp', targetId: shapeId }); }
  keyDown(key: string): UIEffect[]             { return this.dispatch({ type: 'keyDown', key }); }
  keyUp(key: string): UIEffect[]               { return this.dispatch({ type: 'keyUp', key }); }
  formSubmit(formId: string): UIEffect[]       { return this.dispatch({ type: 'formSubmit', formId }); }
  enterVolume(volumeId: string): UIEffect[]    { return this.dispatch({ type: 'enterVolume', volumeId }); }
  exitVolume(volumeId: string): UIEffect[]     { return this.dispatch({ type: 'exitVolume', volumeId }); }
  interact(targetId: string): UIEffect[]       { return this.dispatch({ type: 'interact', targetId }); }

  /** Go to a named state directly (pushes history). */
  goTo(stateId: string, animation?: TransitionAnimation): UIEffect[] {
    return this._enterState(stateId, { animation, pushHistory: true }, 0);
  }
  /** Pop the back-stack (or the initial state if empty). */
  goBack(): UIEffect[] { return this._goBack(0); }

  /** Set a declared variable; returns variableChange + any variable-watch transition that fired. No-op if unknown. */
  setVariableValue(id: string, value: UIValue): UIEffect[] { return this._applyVariable(id, () => value, 0); }

  /** Advance the clock by `dtMs`; fires any `timer` transition of the current state whose delay has elapsed (once
   *  per state visit). The host calls this each frame while the machine is live. */
  tick(dtMs: number): UIEffect[] {
    if (this._current == null || dtMs <= 0) return [];
    this._stateElapsedMs += dtMs;
    for (const t of this._candidates()) {
      if (t.trigger.type !== 'timer' || this._firedTimers.has(t.id)) continue;
      if (this._stateElapsedMs >= t.trigger.delay && this._conditionsPass(t.conditions)) {
        this._firedTimers.add(t.id);
        return this._exec(t, 0);   // fires once; _exec enters a new state (which resets the timer bookkeeping)
      }
    }
    return [];
  }

  get currentStateId(): string | null { return this._current; }
  getVariable(id: string): UIValue | undefined { return this._variables[id]; }
  getVariables(): Record<string, UIValue> { return { ...this._variables }; }
  get history(): string[] { return [...this._history]; }
  hasVisited(stateId: string): boolean { return this._visited.has(stateId); }

  // ── Transition selection ────────────────────────────────────────────────────────────────────────────────
  /** Candidate transitions for the current state: state-scoped (fromState === current OR '*') then globals. */
  private _candidates(): StateTransition[] {
    const out: StateTransition[] = [];
    const scoped = (t: StateTransition): boolean => t.fromState === this._current || t.fromState === '*';
    for (const t of this._machine.transitions) if (scoped(t)) out.push(t);
    if (this._machine.globalTransitions) for (const t of this._machine.globalTransitions) if (scoped(t)) out.push(t);
    return out;
  }

  /** First candidate whose trigger matches `match` AND whose conditions all pass. */
  private _find(match: (t: StateTransition) => boolean): StateTransition | null {
    for (const t of this._candidates()) if (match(t) && this._conditionsPass(t.conditions)) return t;
    return null;
  }

  /** Does a transition's declared trigger match an incoming one? (same type + same key fields). */
  private _triggerMatches(def: InteractionTrigger, got: InteractionTrigger): boolean {
    if (def.type !== got.type) return false;
    switch (got.type) {
      case 'click': case 'hover': case 'hoverEnd': case 'pointerDown': case 'pointerUp': case 'interact':
        return (def as Extract<InteractionTrigger, { targetId: string }>).targetId === got.targetId;
      case 'keyDown': case 'keyUp':
        return (def as Extract<InteractionTrigger, { key: string }>).key === got.key;
      case 'formSubmit':
        return (def as Extract<InteractionTrigger, { type: 'formSubmit' }>).formId === got.formId;
      case 'stateEnter': case 'stateExit':
        return (def as Extract<InteractionTrigger, { stateId: string }>).stateId === got.stateId;
      case 'enterVolume': case 'exitVolume':
        return (def as Extract<InteractionTrigger, { volumeId: string }>).volumeId === got.volumeId;
      case 'timer':
        return (def as Extract<InteractionTrigger, { type: 'timer' }>).delay === got.delay;
      case 'gamepadButton':
        return (def as Extract<InteractionTrigger, { type: 'gamepadButton' }>).button === got.button;
      case 'gamepadAxis': {
        const d = def as Extract<InteractionTrigger, { type: 'gamepadAxis' }>;
        return d.axis === got.axis && d.direction === got.direction;
      }
      case 'variable': {
        const d = def as Extract<InteractionTrigger, { type: 'variable' }>;
        return d.variableId === got.variableId && d.op === got.op && d.value === got.value;
      }
    }
  }

  /** Run a matched transition: its `actions` (may navigate / set variables) then enter its `toState`. */
  private _exec(t: StateTransition, depth: number): UIEffect[] {
    if (depth > MAX_CASCADE_DEPTH) return [];
    const effects = this._runActions(t.actions ?? [], depth);
    effects.push(...this._enterState(t.toState, { animation: t.animation, pushHistory: true }, depth));
    return effects;
  }

  // ── State entry / exit ──────────────────────────────────────────────────────────────────────────────────
  private _enterState(toStateId: string, opts: { animation?: TransitionAnimation; pushHistory: boolean }, depth: number): UIEffect[] {
    if (depth > MAX_CASCADE_DEPTH) return [];
    const effects: UIEffect[] = [];
    const from = this._current;
    const fromState = from != null ? this._stateById(from) : null;

    if (fromState?.onExit?.length) effects.push(...this._runActions(fromState.onExit, depth + 1));

    if (opts.pushHistory && from != null) this._history.push(from);
    this._current = toStateId;
    this._visited.add(toStateId);
    this._stateElapsedMs = 0;          // restart the per-state timer clock
    this._firedTimers.clear();

    if (opts.animation && opts.animation.type !== 'none') effects.push({ kind: 'transition', animation: opts.animation, from, to: toStateId });
    effects.push({ kind: 'stateChange', from, to: toStateId });

    const toState = this._stateById(toStateId);
    if (toState) {
      if (toState.layerVisibility) for (const [layerId, visible] of Object.entries(toState.layerVisibility)) effects.push({ kind: 'setLayerVisible', layerId, visible });
      if (toState.shapeVisibility) for (const [shapeId, visible] of Object.entries(toState.shapeVisibility)) effects.push({ kind: 'setShapeVisible', shapeId, visible });
      effects.push({ kind: 'freezeWorld', frozen: !!toState.frozen });
      if (toState.worldBlur != null) effects.push({ kind: 'setWorldBlur', amount: toState.worldBlur });
      if (toState.onEnter?.length) effects.push(...this._runActions(toState.onEnter, depth + 1));
    }
    // stateEnter triggers (auto-advance on entering a state) — bounded by the cascade guard.
    const enterT = this._find((def) => def.trigger.type === 'stateEnter' && def.trigger.stateId === toStateId);
    if (enterT) effects.push(...this._exec(enterT, depth + 1));
    return effects;
  }

  private _goBack(depth: number): UIEffect[] {
    const target = this._history.pop() ?? this._machine.initialStateId;
    return this._enterState(target, { pushHistory: false }, depth);
  }

  // ── Action execution ────────────────────────────────────────────────────────────────────────────────────
  private _runActions(actions: Action[], depth: number): UIEffect[] {
    const effects: UIEffect[] = [];
    for (const a of actions) {
      switch (a.type) {
        case 'goToState':      effects.push(...this._enterState(a.stateId, { animation: a.animation, pushHistory: true }, depth + 1)); break;
        case 'goBack':         effects.push(...this._goBack(depth + 1)); break;
        case 'openUrl':        effects.push({ kind: 'openUrl', url: a.url, target: a.target ?? '_blank' }); break;
        case 'showLayer':      effects.push({ kind: 'setLayerVisible', layerId: a.layerId, visible: true }); break;
        case 'hideLayer':      effects.push({ kind: 'setLayerVisible', layerId: a.layerId, visible: false }); break;
        case 'toggleLayer':    effects.push({ kind: 'toggleLayerVisible', layerId: a.layerId }); break;
        case 'showShape':      effects.push({ kind: 'setShapeVisible', shapeId: a.shapeId, visible: true }); break;
        case 'hideShape':      effects.push({ kind: 'setShapeVisible', shapeId: a.shapeId, visible: false }); break;
        case 'toggleShape':    effects.push({ kind: 'toggleShapeVisible', shapeId: a.shapeId }); break;
        case 'setVariable':    effects.push(...this._applyVariable(a.variableId, () => a.value, depth + 1)); break;
        case 'addVariable':    effects.push(...this._applyVariable(a.variableId, (old) => Number(old) + a.amount, depth + 1)); break;
        case 'toggleVariable': effects.push(...this._applyVariable(a.variableId, (old) => !old, depth + 1)); break;
        case 'freezeWorld':    effects.push({ kind: 'freezeWorld', frozen: a.frozen }); break;
        case 'setWorldSpeed':  effects.push({ kind: 'setWorldSpeed', speed: a.speed }); break;
        case 'setCamera':      effects.push({ kind: 'setCamera', position: a.position, target: a.target, duration: a.duration }); break;
        case 'playAnimation':  effects.push({ kind: 'playAnimation', targetId: a.targetId, clipId: a.clipId, loop: a.loop }); break;
        case 'stopAnimation':  effects.push({ kind: 'stopAnimation', targetId: a.targetId }); break;
        case 'pauseAnimation': effects.push({ kind: 'pauseAnimation', targetId: a.targetId }); break;
        case 'seekAnimation':  effects.push({ kind: 'seekAnimation', targetId: a.targetId, frame: a.frame }); break;
        case 'playSound':      effects.push({ kind: 'playSound', assetId: a.assetId, volume: a.volume, loop: a.loop }); break;
        case 'stopSound':      effects.push({ kind: 'stopSound', assetId: a.assetId }); break;
        case 'setVolume':      effects.push({ kind: 'setVolume', assetId: a.assetId, volume: a.volume }); break;
        case 'clearForm':      effects.push({ kind: 'clearForm', formId: a.formId }); break;
        case 'focusFormField': effects.push({ kind: 'focusFormField', elementId: a.elementId }); break;
        case 'emitEvent':      effects.push({ kind: 'emitEvent', eventName: a.eventName, payload: a.payload }); break;
        default: { const _exhaustive: never = a; void _exhaustive; }
      }
    }
    return effects;
  }

  /** Mutate a declared variable, emit a variableChange, and fire any variable-watch transition it satisfies. */
  private _applyVariable(id: string, compute: (old: UIValue) => UIValue, depth: number): UIEffect[] {
    if (!(id in this._variables)) return [];   // undeclared variable → ignore (authoring guard)
    const oldValue = this._variables[id];
    const newValue = compute(oldValue);
    if (newValue === oldValue) return [];
    this._variables[id] = newValue;
    const effects: UIEffect[] = [{ kind: 'variableChange', variableId: id, oldValue, newValue }];
    if (depth <= MAX_CASCADE_DEPTH) {
      const t = this._find((def) => def.trigger.type === 'variable'
        && def.trigger.variableId === id
        && this._compare(newValue, def.trigger.op, def.trigger.value));
      if (t) effects.push(...this._exec(t, depth + 1));
    }
    return effects;
  }

  // ── Conditions ──────────────────────────────────────────────────────────────────────────────────────────
  private _conditionsPass(conditions?: Condition[]): boolean {
    if (!conditions?.length) return true;
    return conditions.every((c) => this._evalCondition(c));
  }
  private _evalCondition(cond: Condition): boolean {
    switch (cond.type) {
      case 'variable':     return this._compare(this._variables[cond.variableId], cond.op, cond.value);
      case 'stateHistory': return this._visited.has(cond.stateId) === cond.visited;
      case 'formValid':    return this._formValid ? this._formValid(cond.formId) : true;
      case 'not':          return !this._evalCondition(cond.condition);
    }
  }
  private _compare(a: UIValue | undefined, op: string, b: UIValue): boolean {
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return Number(a) >  Number(b);
      case '<':  return Number(a) <  Number(b);
      case '>=': return Number(a) >= Number(b);
      case '<=': return Number(a) <= Number(b);
      default:   return false;
    }
  }

  private _stateById(id: string): SceneState | undefined { return this._machine.states.find((s) => s.id === id); }
}
