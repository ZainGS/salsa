import { describe, it, expect } from 'vitest';
import { UIManager } from './ui-manager';
import type { ManagerContext } from './manager-context';
import type { UIStateMachine, UIEvent } from '../../ui/ui-types';

/** A scene-graph Node stub: an axis-aligned box with visibility + z, enough for hit-testing. */
function mkNode(x0: number, y0: number, x1: number, y1: number, z = 0) {
  return {
    visible: true, zIndex: z,
    containsPoint(x: number, y: number) { return x >= x0 && x <= x1 && y >= y0 && y <= y1; },
    isEffectivelyVisible() { return this.visible; },
  };
}

/** Minimal ManagerContext stub exposing only what UIManager touches (layer + shape visibility + scheduleRender). */
function mockCtx() {
  const layerVis = new Map<string, boolean>([['menu', true], ['hud', true]]);
  const nodes = new Map<string, ReturnType<typeof mkNode>>([
    ['btnStart', mkNode(0, 0, 10, 10, 1)],   // small button, on top (z 1)
    ['panel', mkNode(0, 0, 100, 100, 0)],    // big panel behind it (z 0)
    ['ringStart', mkNode(0, 0, 12, 12, 2)],  // focus rings (start hidden by the author)
    ['ringPanel', mkNode(0, 0, 102, 102, 2)],
  ]);
  nodes.get('ringStart')!.visible = false;
  nodes.get('ringPanel')!.visible = false;
  const calls = { render: 0, vector: [] as Array<[string, boolean]> };
  const ctx = {
    sceneGraph: { findNodeById: (id: string) => nodes.get(id) ?? null },
    rasterLayerManager: {
      getLayers: () => [...layerVis.entries()].map(([id, visible]) => ({ id, visible })),
      setVisibility: (id: string, v: boolean) => { layerVis.set(id, v); return true; },
    },
    webgpuRenderer: { setVectorLayerVisible: (id: string, v: boolean) => calls.vector.push([id, v]) },
    scheduleRender: () => { calls.render++; },
  } as unknown as ManagerContext;
  return { ctx, layerVis, nodes, calls };
}

function machine(): UIStateMachine {
  return {
    id: 'm', initialStateId: 'title',
    variables: [{ id: 'coins', name: 'Coins', type: 'number', defaultValue: 0 }],
    states: [
      { id: 'title', name: 'Title', layerVisibility: { menu: true, hud: false } },
      { id: 'game', name: 'Game', layerVisibility: { menu: false, hud: true }, onEnter: [{ type: 'emitEvent', eventName: 'gameStarted' }] },
    ],
    transitions: [
      { id: 't1', fromState: 'title', toState: 'game', trigger: { type: 'click', targetId: 'btnStart' }, actions: [{ type: 'hideShape', shapeId: 'panel' }] },
    ],
  };
}

describe('UIManager', () => {
  it('createUILayer makes an active layer; setStateMachine enters the initial state + applies its layer visibility', () => {
    const { ctx, layerVis } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer('Menu');
    expect(ui.activeUILayerId).toBe(id);

    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    ui.setStateMachine(id, machine());

    expect(ui.getCurrentState(id)).toBe('title');
    expect(layerVis.get('menu')).toBe(true);
    expect(layerVis.get('hud')).toBe(false);     // title sets hud → hidden
    expect(events.some((e) => e.type === 'stateChange' && e.toState === 'title')).toBe(true);
  });

  it('a click navigates, applies shape visibility, and emits shapeClick + custom events', () => {
    const { ctx, nodes } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());

    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    ui.clickShape('btnStart');   // defaults to the active layer

    expect(ui.getCurrentState(id)).toBe('game');
    expect(nodes.get('panel')!.visible).toBe(false);   // hideShape action applied to the real node
    expect(events.some((e) => e.type === 'shapeClick' && e.shapeId === 'btnStart')).toBe(true);
    expect(events.some((e) => e.type === 'custom' && e.eventName === 'gameStarted')).toBe(true);
    expect(events.some((e) => e.type === 'stateChange' && e.toState === 'game')).toBe(true);
  });

  it('reads/writes scene variables and navigates via goToState', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setUIVariable(id, 'coins', 5);
    expect(ui.getUIVariable(id, 'coins')).toBe(5);
    ui.goToState(id, 'game');
    expect(ui.getCurrentState(id)).toBe('game');
  });

  it('manages per-shape interaction props', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    ui.createUILayer();
    ui.setShapeInteraction({ shapeId: 'btnStart', cursor: 'pointer', focusable: true });
    expect(ui.getShapeInteraction('btnStart')?.cursor).toBe('pointer');
    expect(ui.interactiveShapeIds()).toContain('btnStart');
    ui.clearShapeInteraction('btnStart');
    expect(ui.getShapeInteraction('btnStart')).toBeNull();
  });

  it('onUIEvent unsubscribe stops delivery', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    const seen: UIEvent[] = [];
    const off = ui.onUIEvent((e) => seen.push(e));
    off();
    ui.goToState(id, 'game');
    expect(seen.length).toBe(0);
  });
});

describe('UIManager — pointer hit-testing', () => {
  it('does nothing until interactivity is enabled', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart', cursor: 'pointer' });
    expect(ui.pointerDown(5, 5)).toBe(false);        // not interactive → no-op, does not consume
    expect(ui.getCurrentState(id)).toBe('title');
  });

  it('picks the top-most shape by z-order and a pointerDown clicks it', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'panel', cursor: 'default' });     // z 0
    ui.setShapeInteraction({ shapeId: 'btnStart', cursor: 'pointer' });  // z 1, over the panel
    ui.setInteractive(true);
    expect(ui.hitTest(5, 5)).toBe('btnStart');   // both cover (5,5); higher z wins
    expect(ui.pointerDown(5, 5)).toBe(true);     // consumed
    expect(ui.getCurrentState(id)).toBe('game'); // btnStart's transition fired
  });

  it('picks a 3D mesh as an interactive target when the 2D hit-test misses', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'mesh3dBtn', cursor: 'pointer' });   // a 3D mesh (no 2D node in the graph)
    ui.setMeshPicker((cx) => (cx === 42 ? 'mesh3dBtn' : null));            // mock ray-pick
    ui.setInteractive(true);
    expect(ui.hitTestMesh(42, 0)).toBe('mesh3dBtn');
    expect(ui.pointerDown(500, 500, 42, 0)).toBe(true);                    // 2D miss → 3D pick → consumed
    expect(ui.pointerMove(500, 500, 42, 0)).toBe('pointer');              // hover cursor from the 3D target
    ui.setShapeInteraction({ shapeId: 'mesh3dBtn', disabled: true });      // disabled → not a target
    expect(ui.hitTestMesh(42, 0)).toBeNull();
    ui.setShapeInteraction({ shapeId: 'mesh3dBtn' });
    ui.setMeshPicker(() => 'notAnInteractiveMesh');                        // picked a non-interactive mesh → null
    expect(ui.hitTestMesh(1, 1)).toBeNull();
  });

  it('an ephemera placement can be an interactive UI target (pick → click → visibility effect)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, {
      id: 'e', initialStateId: 'a', variables: [],
      states: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      transitions: [{ id: 't', fromState: 'a', toState: 'b', trigger: { type: 'click', targetId: 'eph1' }, actions: [{ type: 'hideShape', shapeId: 'eph1' }] }],
    });
    const vis = new Map<string, boolean>([['eph1', true]]);
    ui.setEphemeraAdapter({
      pickAt: (wx, wy) => (wx === 5 && wy === 5 ? 'eph1' : null),   // a placement lives at (5,5)
      has: (i) => vis.has(i),
      setVisible: (i, v) => vis.set(i, v),
      isVisible: (i) => vis.get(i) ?? true,
    });
    ui.setShapeInteraction({ shapeId: 'eph1', cursor: 'grab' });
    ui.setInteractive(true);
    expect(ui.hitTestEphemera(5, 5)).toBe('eph1');
    expect(ui.pointerMove(5, 5)).toBe('grab');       // hover cursor from the ephemera target
    expect(ui.pointerDown(5, 5)).toBe(true);         // ephemera pick → click → consumed
    expect(ui.getCurrentState(id)).toBe('b');        // its transition fired
    expect(vis.get('eph1')).toBe(false);             // hideShape applied THROUGH the ephemera adapter
    ui.setEphemeraAdapter({ pickAt: () => 'notWired', has: () => true, setVisible: () => {}, isVisible: () => true });
    expect(ui.hitTestEphemera(5, 5)).toBeNull();     // picked a placement that isn't an interactive shape → null
  });

  it('passThroughPointer lets misses fall through; a modal layer swallows them', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart' });
    ui.setInteractive(true);
    expect(ui.pointerDown(500, 500)).toBe(false);        // miss + pass-through (default) → not consumed
    ui.updateUILayer(id, { passThroughPointer: false });
    expect(ui.pointerDown(500, 500)).toBe(true);         // miss + modal → consumed
  });

  it('pointerMove returns the hover cursor and fires hover / hoverEnd', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart', cursor: 'grab' });
    ui.setInteractive(true);
    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    expect(ui.pointerMove(5, 5)).toBe('grab');
    expect(events.some((e) => e.type === 'shapeHover' && e.shapeId === 'btnStart')).toBe(true);
    expect(ui.pointerMove(500, 500)).toBeNull();   // moved off
    expect(events.some((e) => e.type === 'shapeHoverEnd' && e.shapeId === 'btnStart')).toBe(true);
  });

  it('tick advances timers only while interactive', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, {
      id: 'tm', initialStateId: 'splash', variables: [],
      states: [{ id: 'splash', name: 'S' }, { id: 'title', name: 'T' }],
      transitions: [{ id: 'auto', fromState: 'splash', toState: 'title', trigger: { type: 'timer', delay: 500 } }],
    });
    ui.tick(600);                               // not interactive → no-op
    expect(ui.getCurrentState(id)).toBe('splash');
    ui.setInteractive(true);
    ui.tick(600);
    expect(ui.getCurrentState(id)).toBe('title');
  });

  it('Tab cycles focusable shapes and Enter activates the focused one', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart', focusable: true, tabIndex: 0 });
    ui.setShapeInteraction({ shapeId: 'panel', focusable: true, tabIndex: 1 });
    ui.setInteractive(true);
    expect(ui.focusNext()).toBe('btnStart');
    expect(ui.focusNext()).toBe('panel');
    expect(ui.focusNext()).toBe('btnStart');   // wraps
    expect(ui.focusPrev()).toBe('panel');       // wraps back
    ui.focusNext();                             // → btnStart
    expect(ui.handleKey('Enter')).toBe(true);   // activate → click btnStart
    expect(ui.getCurrentState(id)).toBe('game');
  });

  it('shows the focused element focus ring and hides the others', () => {
    const { ctx, nodes } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart', focusable: true, tabIndex: 0, focusIndicatorShapeId: 'ringStart' });
    ui.setShapeInteraction({ shapeId: 'panel', focusable: true, tabIndex: 1, focusIndicatorShapeId: 'ringPanel' });
    ui.setInteractive(true);
    ui.focusNext();   // → btnStart
    expect(nodes.get('ringStart')!.visible).toBe(true);
    expect(nodes.get('ringPanel')!.visible).toBe(false);
    ui.focusNext();   // → panel
    expect(nodes.get('ringStart')!.visible).toBe(false);
    expect(nodes.get('ringPanel')!.visible).toBe(true);
    ui.setInteractive(false);   // leaving preview hides the ring
    expect(nodes.get('ringPanel')!.visible).toBe(false);
  });

  it('handleKey routes author-bound keys to the machine (Escape → global transition), no-op off-preview', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, {
      id: 'k', initialStateId: 'title', variables: [],
      states: [{ id: 'title', name: 'T' }, { id: 'pause', name: 'P' }],
      transitions: [],
      globalTransitions: [{ id: 'esc', fromState: '*', toState: 'pause', trigger: { type: 'keyDown', key: 'Escape' } }],
    });
    expect(ui.handleKey('Escape')).toBe(false);   // not interactive → ignored
    expect(ui.getCurrentState(id)).toBe('title');
    ui.setInteractive(true);
    ui.handleKey('Escape');
    expect(ui.getCurrentState(id)).toBe('pause');
  });

  it('getActiveOverlay dims only while interactive AND in a modal (worldBlur) state', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, {
      id: 'ov', initialStateId: 'title', variables: [],
      states: [{ id: 'title', name: 'T' }, { id: 'pause', name: 'P', worldBlur: 8 }],
      transitions: [],
      globalTransitions: [{ id: 'esc', fromState: '*', toState: 'pause', trigger: { type: 'keyDown', key: 'Escape' } }],
    });
    ui.updateUILayer(id, { backgroundOverlay: { color: [0, 0, 0, 0.6] } });
    expect(ui.getActiveOverlay()).toBeNull();          // not interactive
    ui.setInteractive(true);
    expect(ui.getActiveOverlay()).toBeNull();          // title is not modal
    ui.handleKey('Escape');                            // → pause (worldBlur > 0)
    expect(ui.getActiveOverlay()).toEqual([0, 0, 0, 0.6]);
  });

  it('a fade transition covers fullscreen then clears over its duration', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setInteractive(true);
    ui.goToState(id, 'game', { type: 'fade', duration: 200 });
    const a0 = ui.getActiveOverlay();
    expect(a0).not.toBeNull();
    expect(a0![3]).toBeCloseTo(1, 1);            // fully covered at the start
    ui.tick(100);
    expect(ui.getActiveOverlay()![3]).toBeCloseTo(0.5, 1);   // half faded (linear)
    ui.tick(150);                                 // past the duration
    expect(ui.getActiveOverlay()).toBeNull();
  });

  it('skips disabled shapes and disabledWhenVariable shapes until the variable is truthy', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setInteractive(true);
    ui.setShapeInteraction({ shapeId: 'btnStart', disabled: true });
    expect(ui.hitTest(5, 5)).toBeNull();
    ui.setShapeInteraction({ shapeId: 'btnStart', disabledWhenVariable: 'coins' });   // coins defaults 0 → disabled
    expect(ui.hitTest(5, 5)).toBeNull();
    ui.setUIVariable(id, 'coins', 5);
    expect(ui.hitTest(5, 5)).toBe('btnStart');
  });
});
