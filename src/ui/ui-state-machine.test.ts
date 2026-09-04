import { describe, it, expect } from 'vitest';
import { UIStateMachineRuntime } from './ui-state-machine';
import type { UIStateMachine, UIEffect } from './ui-types';

/** A small menu machine: title → game / settings, a coin-gated shop, a global Escape→pause, onEnter side effects. */
function menu(): UIStateMachine {
  return {
    id: 'm', initialStateId: 'title',
    variables: [
      { id: 'coins', name: 'Coins', type: 'number', defaultValue: 0 },
      { id: 'hasVisitedSettings', name: 'Visited', type: 'boolean', defaultValue: false },
    ],
    states: [
      { id: 'title', name: 'Title', layerVisibility: { menu: true, hud: false } },
      { id: 'game', name: 'Game', layerVisibility: { menu: false, hud: true }, onEnter: [{ type: 'emitEvent', eventName: 'gameStarted' }] },
      { id: 'settings', name: 'Settings', onEnter: [{ type: 'setVariable', variableId: 'hasVisitedSettings', value: true }] },
      { id: 'pause', name: 'Pause', frozen: true, worldBlur: 8 },
      { id: 'shop', name: 'Shop' },
    ],
    transitions: [
      { id: 't1', fromState: 'title', toState: 'game', trigger: { type: 'click', targetId: 'btnStart' } },
      { id: 't2', fromState: 'title', toState: 'settings', trigger: { type: 'click', targetId: 'btnSettings' } },
      { id: 't3', fromState: 'game', toState: 'shop', trigger: { type: 'click', targetId: 'btnShop' }, conditions: [{ type: 'variable', variableId: 'coins', op: '>=', value: 10 }] },
      { id: 't4', fromState: 'shop', toState: 'game', trigger: { type: 'variable', variableId: 'coins', op: '==', value: 0 } },
    ],
    globalTransitions: [
      { id: 'g1', fromState: '*', toState: 'pause', trigger: { type: 'keyDown', key: 'Escape' } },
    ],
  };
}

const has = (fx: UIEffect[], pred: (e: UIEffect) => boolean): boolean => fx.some(pred);

describe('UIStateMachineRuntime — start + navigation', () => {
  it('start() enters the initial state and emits its visibility + unfrozen world', () => {
    const r = new UIStateMachineRuntime(menu());
    const fx = r.start();
    expect(r.currentStateId).toBe('title');
    expect(fx).toContainEqual({ kind: 'stateChange', from: null, to: 'title' });
    expect(fx).toContainEqual({ kind: 'setLayerVisible', layerId: 'menu', visible: true });
    expect(fx).toContainEqual({ kind: 'setLayerVisible', layerId: 'hud', visible: false });
    expect(fx).toContainEqual({ kind: 'freezeWorld', frozen: false });
  });

  it('a click transition moves state and runs the target state onEnter', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start();
    const fx = r.clickShape('btnStart');
    expect(r.currentStateId).toBe('game');
    expect(fx).toContainEqual({ kind: 'stateChange', from: 'title', to: 'game' });
    expect(has(fx, (e) => e.kind === 'emitEvent' && e.eventName === 'gameStarted')).toBe(true);
    expect(fx).toContainEqual({ kind: 'setLayerVisible', layerId: 'hud', visible: true });
  });

  it('an unmatched trigger is a no-op', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start();
    expect(r.dispatch({ type: 'click', targetId: 'nope' })).toEqual([]);
    expect(r.currentStateId).toBe('title');
  });
});

describe('UIStateMachineRuntime — conditions + variables', () => {
  it('a condition gates a transition until the variable satisfies it', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start(); r.clickShape('btnStart');   // → game, coins 0
    expect(r.clickShape('btnShop')).toEqual([]);   // coins >= 10 fails
    expect(r.currentStateId).toBe('game');
    r.setVariableValue('coins', 10);
    r.clickShape('btnShop');
    expect(r.currentStateId).toBe('shop');
  });

  it('setting a variable fires its variable-watch transition (auto-return when broke)', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start(); r.clickShape('btnStart'); r.setVariableValue('coins', 10); r.clickShape('btnShop');
    expect(r.currentStateId).toBe('shop');
    const fx = r.setVariableValue('coins', 0);   // shop: coins == 0 → game
    expect(has(fx, (e) => e.kind === 'variableChange' && e.variableId === 'coins' && e.newValue === 0)).toBe(true);
    expect(has(fx, (e) => e.kind === 'stateChange' && e.to === 'game')).toBe(true);
    expect(r.currentStateId).toBe('game');
  });

  it('addVariable / toggleVariable mutate declared variables; unknown vars are ignored', () => {
    const m: UIStateMachine = {
      id: 'mv', initialStateId: 'a', variables: [
        { id: 'n', name: 'n', type: 'number', defaultValue: 5 },
        { id: 'b', name: 'b', type: 'boolean', defaultValue: false },
      ],
      states: [{ id: 'a', name: 'A' }],
      transitions: [
        { id: 'inc', fromState: 'a', toState: 'a', trigger: { type: 'click', targetId: 'plus' }, actions: [{ type: 'addVariable', variableId: 'n', amount: 3 }] },
        { id: 'tog', fromState: 'a', toState: 'a', trigger: { type: 'click', targetId: 't' }, actions: [{ type: 'toggleVariable', variableId: 'b' }] },
        { id: 'bad', fromState: 'a', toState: 'a', trigger: { type: 'click', targetId: 'x' }, actions: [{ type: 'setVariable', variableId: 'ghost', value: 1 }] },
      ],
    };
    const r = new UIStateMachineRuntime(m);
    r.start();
    r.clickShape('plus'); expect(r.getVariable('n')).toBe(8);
    r.clickShape('t');    expect(r.getVariable('b')).toBe(true);
    r.clickShape('t');    expect(r.getVariable('b')).toBe(false);
    expect(r.clickShape('x').some((e) => e.kind === 'variableChange')).toBe(false);   // ghost ignored
  });
});

describe('UIStateMachineRuntime — global transitions, history, freeze', () => {
  it('a global transition fires from any state', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start();
    let fx = r.keyDown('Escape');
    expect(r.currentStateId).toBe('pause');
    expect(fx).toContainEqual({ kind: 'freezeWorld', frozen: true });
    expect(fx).toContainEqual({ kind: 'setWorldBlur', amount: 8 });
    r.goTo('game');
    fx = r.keyDown('Escape');
    expect(r.currentStateId).toBe('pause');
  });

  it('goBack pops the navigation stack', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start(); r.clickShape('btnSettings');   // title → settings (pushes title)
    expect(r.currentStateId).toBe('settings');
    expect(r.getVariable('hasVisitedSettings')).toBe(true);   // settings onEnter
    r.goBack();
    expect(r.currentStateId).toBe('title');
  });

  it('tracks visited states for the stateHistory condition', () => {
    const r = new UIStateMachineRuntime(menu());
    r.start();
    expect(r.hasVisited('title')).toBe(true);
    expect(r.hasVisited('game')).toBe(false);
    r.clickShape('btnStart');
    expect(r.hasVisited('game')).toBe(true);
  });
});

describe('UIStateMachineRuntime — action → effect mapping', () => {
  it('maps show/hide/toggle + openUrl + emitEvent actions to effects, in order before the state change', () => {
    const m: UIStateMachine = {
      id: 'm2', initialStateId: 'a', variables: [],
      states: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      transitions: [{
        id: 'x', fromState: 'a', toState: 'b', trigger: { type: 'click', targetId: 'go' },
        actions: [
          { type: 'showLayer', layerId: 'L1' }, { type: 'hideLayer', layerId: 'L2' }, { type: 'toggleLayer', layerId: 'L3' },
          { type: 'showShape', shapeId: 'S1' }, { type: 'toggleShape', shapeId: 'S2' },
          { type: 'openUrl', url: 'https://example.com' }, { type: 'emitEvent', eventName: 'clicked', payload: { a: 1 } },
        ],
      }],
    };
    const r = new UIStateMachineRuntime(m);
    r.start();
    const fx = r.clickShape('go');
    expect(fx).toContainEqual({ kind: 'setLayerVisible', layerId: 'L1', visible: true });
    expect(fx).toContainEqual({ kind: 'setLayerVisible', layerId: 'L2', visible: false });
    expect(fx).toContainEqual({ kind: 'toggleLayerVisible', layerId: 'L3' });
    expect(fx).toContainEqual({ kind: 'setShapeVisible', shapeId: 'S1', visible: true });
    expect(fx).toContainEqual({ kind: 'toggleShapeVisible', shapeId: 'S2' });
    expect(fx).toContainEqual({ kind: 'openUrl', url: 'https://example.com', target: '_blank' });
    expect(has(fx, (e) => e.kind === 'emitEvent' && e.eventName === 'clicked')).toBe(true);
    // actions run before the state change
    const urlIdx = fx.findIndex((e) => e.kind === 'openUrl');
    const chgIdx = fx.findIndex((e) => e.kind === 'stateChange');
    expect(urlIdx).toBeLessThan(chgIdx);
  });
});

describe('UIStateMachineRuntime — cascades are bounded', () => {
  it('stateEnter triggers auto-advance but a circular loop cannot hang', () => {
    const loop: UIStateMachine = {
      id: 'loop', initialStateId: 'a', variables: [],
      states: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      transitions: [
        { id: 'ab', fromState: 'a', toState: 'b', trigger: { type: 'stateEnter', stateId: 'a' } },
        { id: 'ba', fromState: 'b', toState: 'a', trigger: { type: 'stateEnter', stateId: 'b' } },
      ],
    };
    const r = new UIStateMachineRuntime(loop);
    const fx = r.start();   // a → b → a → … stops at the cascade guard, does not hang
    expect(fx.length).toBeGreaterThan(0);
    expect(['a', 'b']).toContain(r.currentStateId);
  });

  it('a timer transition fires once after its delay elapses in the state', () => {
    const m: UIStateMachine = {
      id: 'tm', initialStateId: 'splash', variables: [],
      states: [{ id: 'splash', name: 'Splash' }, { id: 'title', name: 'Title' }],
      transitions: [{ id: 'auto', fromState: 'splash', toState: 'title', trigger: { type: 'timer', delay: 1000 } }],
    };
    const r = new UIStateMachineRuntime(m);
    r.start();
    expect(r.tick(400)).toEqual([]);           // not yet
    expect(r.currentStateId).toBe('splash');
    const fx = r.tick(700);                     // 1100 ≥ 1000 → fires
    expect(r.currentStateId).toBe('title');
    expect(has(fx, (e) => e.kind === 'stateChange' && e.to === 'title')).toBe(true);
    expect(r.tick(5000)).toEqual([]);           // does not re-fire (already in 'title')
  });

  it('formValid condition uses the injected resolver', () => {
    const m: UIStateMachine = {
      id: 'f', initialStateId: 'a', variables: [],
      states: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      transitions: [{ id: 'sub', fromState: 'a', toState: 'b', trigger: { type: 'formSubmit', formId: 'login' }, conditions: [{ type: 'formValid', formId: 'login' }] }],
    };
    let valid = false;
    const r = new UIStateMachineRuntime(m, { formValid: () => valid });
    r.start();
    expect(r.formSubmit('login')).toEqual([]);   // invalid form blocks
    valid = true;
    r.formSubmit('login');
    expect(r.currentStateId).toBe('b');
  });
});

describe('UIStateMachineRuntime — spatial gameplay triggers (Play-mode volumes)', () => {
  // A door zone: walk in → open the "at door" HUD + count the visit; walk out → back to roaming.
  const game: UIStateMachine = {
    id: 'g', initialStateId: 'roam', variables: [{ id: 'doorVisits', name: 'Door visits', type: 'number', defaultValue: 0 }],
    states: [
      { id: 'roam', name: 'Roaming' },
      { id: 'atDoor', name: 'At door', onEnter: [{ type: 'addVariable', variableId: 'doorVisits', amount: 1 }] },
    ],
    transitions: [
      { id: 'in', fromState: 'roam', toState: 'atDoor', trigger: { type: 'enterVolume', volumeId: 'door1' } },
      { id: 'out', fromState: 'atDoor', toState: 'roam', trigger: { type: 'exitVolume', volumeId: 'door1' } },
    ],
  };

  it('enterVolume / exitVolume drive transitions and match by volumeId', () => {
    const r = new UIStateMachineRuntime(game);
    r.start();
    expect(r.dispatch({ type: 'enterVolume', volumeId: 'other' })).toEqual([]);   // different volume → no-op
    expect(r.currentStateId).toBe('roam');
    const fx = r.enterVolume('door1');
    expect(r.currentStateId).toBe('atDoor');
    expect(has(fx, (e) => e.kind === 'stateChange' && e.to === 'atDoor')).toBe(true);
    expect(r.getVariable('doorVisits')).toBe(1);
    r.exitVolume('door1');
    expect(r.currentStateId).toBe('roam');
    r.enterVolume('door1');
    expect(r.getVariable('doorVisits')).toBe(2);   // re-entry counts again
  });

  it('interact fires the transition for the matching target id', () => {
    const m: UIStateMachine = {
      id: 'i', initialStateId: 'world', variables: [],
      states: [{ id: 'world', name: 'World' }, { id: 'chestOpen', name: 'Chest open' }],
      transitions: [{ id: 'open', fromState: 'world', toState: 'chestOpen', trigger: { type: 'interact', targetId: 'chest' } }],
    };
    const r = new UIStateMachineRuntime(m);
    r.start();
    expect(r.interact('sign')).toEqual([]);        // wrong target → no-op
    expect(r.currentStateId).toBe('world');
    r.interact('chest');
    expect(r.currentStateId).toBe('chestOpen');
  });
});
