import { describe, it, expect } from 'vitest';
import { UIManager, worldDimFactor } from './ui-manager';
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
    const ov = ui.getActiveOverlay();
    expect(ov!.color).toEqual([0, 0, 0, 0.6]);
    expect(ov!.blur).toBeGreaterThan(0);          // modal state => true world blur requested
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
    expect(a0!.color[3]).toBeCloseTo(1, 1);      // fully covered at the start
    ui.tick(100);
    expect(ui.getActiveOverlay()!.color[3]).toBeCloseTo(0.5, 1);   // half faded (linear)
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

  it('directional + iris transitions map to scrim masks (mode/dir/eased progress)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    ui.setStateMachine(id, machine());
    ui.setInteractive(true);
    ui.goToState(id, 'game', { type: 'slideLeft', duration: 200 });
    let ov = ui.getActiveOverlay()!;
    expect(ov.mode).toBe(1);
    expect(ov.dir).toEqual([-1, 0]);
    expect(ov.color[3]).toBe(1);                  // curtain is opaque; the MASK does the revealing
    ui.tick(100);
    ov = ui.getActiveOverlay()!;
    expect(ov.progress).toBeCloseTo(0.5, 1);      // linear easing halfway
    ui.goToState(id, 'title', { type: 'wipe', duration: 100 });
    ov = ui.getActiveOverlay()!;
    expect(ov.mode).toBe(1);
    expect(ov.soft).toBeLessThan(0.1);            // hard edge
    expect(ov.color.slice(0, 3)).toEqual([1, 1, 1]);
    ui.goToState(id, 'game', { type: 'zoom', duration: 100 });
    expect(ui.getActiveOverlay()!.mode).toBe(2);  // iris
  });

  it('freezeWorld / setWorldSpeed / setCamera drive the world hook (and still reach the effectHook)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const calls: string[] = [];
    const hooked: string[] = [];
    ui.setWorldControlHook({
      setFrozen: (f) => calls.push(`frozen:${f}`),
      setSpeed: (v) => calls.push(`speed:${v}`),
      setCamera: (p) => calls.push(`cam:${p?.join(',')}`),
    });
    ui.setEffectHook((e) => hooked.push(e.kind));
    const m = machine();
    m.states[1].onEnter = [
      { type: 'freezeWorld', frozen: true },
      { type: 'setWorldSpeed', speed: 0.5 },
      { type: 'setCamera', position: [1, 2, 3] },
    ];
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    ui.goToState(id, 'game');
    // Every state change auto-emits freezeWorld(state.frozen) before onEnter runs, so earlier
    // frozen:false entries from entering title/game precede the explicit onEnter trio.
    expect(calls.slice(-3)).toEqual(['frozen:true', 'speed:0.5', 'cam:1,2,3']);
    expect(hooked).toContain('freezeWorld');      // observers still see the applied effects
  });

  it('playAnimation / pauseAnimation / stopAnimation / seekAnimation drive the world hook', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const calls: string[] = [];
    ui.setWorldControlHook({
      playAnimation: (t, c, l) => calls.push(`play:${t}:${c}:${l}`),
      pauseAnimation: (t) => calls.push(`pause:${t}`),
      stopAnimation: (t) => calls.push(`stop:${t}`),
      seekAnimation: (t, f) => calls.push(`seek:${t}:${f}`),
    });
    const m = machine();
    m.states[1].onEnter = [
      { type: 'playAnimation', targetId: 'skel1', clipId: 'wave', loop: false },
      { type: 'pauseAnimation', targetId: 'skel1' },
      { type: 'seekAnimation', targetId: 'skel1', frame: 12 },
      { type: 'stopAnimation', targetId: 'skel1' },
    ];
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    ui.goToState(id, 'game');
    expect(calls).toEqual(['play:skel1:wave:false', 'pause:skel1', 'seek:skel1:12', 'stop:skel1']);
  });

  it('a modal state requests blur; leaving it CLEARS the blur (per-state reset)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const m = machine();
    m.states[1].worldBlur = 0.8;                  // 'game' is modal with strong blur
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    ui.goToState(id, 'game');
    expect(ui.getActiveOverlay()!.blur).toBeCloseTo(0.8, 5);
    ui.goToState(id, 'title');                    // non-modal → overlay gone, blur reset (not sticky)
    expect(ui.getActiveOverlay()).toBeNull();
  });

  it('Dim world strength (audit 2026-10-09): 0..1 changes the look across the range; >= 0.5 is the full dim colour', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const m = machine();
    ui.setStateMachine(id, m);
    ui.updateUILayer(id, { backgroundOverlay: { color: [0, 0, 0, 0.6] } });
    ui.setInteractive(true);
    const at = (v: number) => {
      m.states[1].worldBlur = v;
      ui.goToState(id, 'title');
      ui.goToState(id, 'game');
      const ov = ui.getActiveOverlay()!;
      return { alpha: ov.color[3], blur: ov.blur };
    };
    const a = at(0.1), b = at(0.3), c = at(0.5), d = at(1), old = at(8);
    expect(a.alpha).toBeCloseTo(0.12, 5);
    expect(b.alpha).toBeCloseTo(0.36, 5);
    expect(c.alpha).toBeCloseTo(0.6, 5);
    expect(d.alpha).toBeCloseTo(0.6, 5);
    expect([a.blur, b.blur, c.blur, d.blur]).toEqual([0.1, 0.3, 0.5, 1].map(v => expect.closeTo(v, 5)));
    expect(old).toEqual(d);                        // an old save's 1..20 = full strength, as before
    expect(worldDimFactor(0)).toBe(0);
    expect(worldDimFactor(0.25)).toBe(0.5);
  });
});

describe('UIManager — HTML forms (Phase 4)', () => {
  function fakeFormAdapter() {
    const mounted = new Map<string, import('../../ui/ui-types').HtmlFormElement>();
    const values = new Map<string, string | boolean>();
    const focused: string[] = [];
    return {
      adapter: {
        sync(els: import('../../ui/ui-types').HtmlFormElement[]) { mounted.clear(); for (const e of els) mounted.set(e.id, e); },
        getValue(id: string) { return mounted.has(id) ? (values.get(id) ?? '') : null; },
        setValue(id: string, v: string | boolean) { values.set(id, v); },
        focus(id: string) { focused.push(id); },
      },
      mounted, values, focused,
    };
  }
  const bounds = { x: 0, y: 0, width: 100, height: 20 };
  function formMachine(): UIStateMachine {
    return {
      id: 'fm', initialStateId: 'title',
      variables: [{ id: 'playerName', name: 'Player', type: 'string', defaultValue: '' }],
      states: [{ id: 'title', name: 'Title' }, { id: 'game', name: 'Game' }],
      htmlForms: [
        { id: 'name', type: 'text', formId: 'login', canvasBounds: bounds, required: true,
          variableBinding: 'playerName', visibleInStates: ['title'] },
        { id: 'notes', type: 'textarea', canvasBounds: bounds },   // untagged + stateless → every form, every state
      ],
      transitions: [{
        id: 't1', fromState: 'title', toState: 'game',
        trigger: { type: 'formSubmit', formId: 'login' },
        conditions: [{ type: 'formValid', formId: 'login' }],
      }],
    };
  }

  it('mounts elements per state + interactivity (visibleInStates filter)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const f = fakeFormAdapter();
    ui.setFormAdapter(f.adapter);
    ui.setStateMachine(id, formMachine());
    expect(f.mounted.size).toBe(0);               // not interactive yet
    ui.setInteractive(true);
    expect([...f.mounted.keys()].sort()).toEqual(['name', 'notes']);
    ui.goToState(id, 'game');
    expect([...f.mounted.keys()]).toEqual(['notes']);   // 'name' is title-only
    ui.setInteractive(false);
    expect(f.mounted.size).toBe(0);
  });

  it('formValid gates the formSubmit transition; submit gathers values into the UIEvent', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const f = fakeFormAdapter();
    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    ui.setFormAdapter(f.adapter);
    ui.setStateMachine(id, formMachine());
    ui.setInteractive(true);
    ui.submitForm('login');                        // required 'name' is empty → blocked
    expect(ui.getCurrentState(id)).toBe('title');
    f.values.set('name', 'zain');
    ui.submitForm('login');
    expect(ui.getCurrentState(id)).toBe('game');
    const sub = events.filter((e) => e.type === 'formSubmit');
    expect(sub).toHaveLength(2);                   // the event fires either way; the CONDITION gates the transition
    expect((sub[1] as Extract<UIEvent, { type: 'formSubmit' }>).values).toEqual({ name: 'zain', notes: '' });
  });

  it('typing drives variableBinding; a variableChange writes back into bound inputs; clearForm resets both', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const f = fakeFormAdapter();
    ui.setFormAdapter(f.adapter);
    ui.setStateMachine(id, formMachine());
    ui.setInteractive(true);
    ui.handleFormInput('name', 'zain');            // element → variable
    expect(ui.getUIVariable(id, 'playerName')).toBe('zain');
    expect(f.values.get('name')).toBe('zain');     // …and the variableChange echoes back into the input
    ui.setUIVariable(id, 'playerName', 'frog');    // variable → element
    expect(f.values.get('name')).toBe('frog');
    ui.clearForm('login');
    expect(f.values.get('name')).toBe('');
    expect(ui.getUIVariable(id, 'playerName')).toBe('');
  });

  it('submitForm / clearForm / focusFormField ACTIONS work from a state machine', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const f = fakeFormAdapter();
    ui.setFormAdapter(f.adapter);
    const m = formMachine();
    m.states[1].onEnter = [{ type: 'focusFormField', elementId: 'notes' }];
    m.transitions.push({
      id: 't2', fromState: 'title', toState: 'title',
      trigger: { type: 'click', targetId: 'btnStart' },
      actions: [{ type: 'submitForm', formId: 'login' }],
    });
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    f.values.set('name', 'ok');
    ui.clickShape('btnStart', id);                 // click → submitForm action → formSubmit trigger → game
    expect(ui.getCurrentState(id)).toBe('game');
    expect(f.focused).toEqual(['notes']);          // game onEnter focused the notes field
  });
});

describe('UIManager — Phase 7 tail (hover/press clips, gamepad, persistent vars, sound)', () => {
  it('hoverAnimationClipId loops on hover + stops on leave; pressAnimationClipId one-shots on click', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const calls: string[] = [];
    ui.setWorldControlHook({
      playAnimation: (t, c, l) => calls.push(`play:${t}:${c}:${l}`),
      stopAnimation: (t) => calls.push(`stop:${t}`),
    });
    ui.setStateMachine(id, machine());
    ui.setShapeInteraction({ shapeId: 'btnStart', hoverAnimationClipId: 'wiggle', pressAnimationClipId: 'squish' }, id);
    ui.setInteractive(true);
    ui.hoverShape('btnStart', true, id);
    ui.hoverShape('btnStart', false, id);
    ui.clickShape('btnStart', id);
    expect(calls).toEqual(['play:btnStart:wiggle:true', 'stop:btnStart', 'play:btnStart:squish:false']);
  });

  it('gamepad button presses + axis threshold crossings fire triggers (edge-detected, injectable source)', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const m = machine();
    m.transitions.push(
      { id: 'g1', fromState: 'title', toState: 'game', trigger: { type: 'gamepadButton', button: 0 } },
      { id: 'g2', fromState: 'game', toState: 'title', trigger: { type: 'gamepadAxis', axis: 1, direction: 'negative' } },
    );
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    const pad = { buttons: [{ pressed: false }], axes: [0, 0] };
    ui.setGamepadSource(() => [pad]);
    ui.tick(16);
    expect(ui.getCurrentState(id)).toBe('title');   // nothing pressed
    pad.buttons[0].pressed = true;
    ui.tick(16);
    expect(ui.getCurrentState(id)).toBe('game');    // press edge fired
    ui.tick(16);
    expect(ui.getCurrentState(id)).toBe('game');    // held ≠ re-fire
    pad.axes[1] = -0.9;
    ui.tick(16);
    expect(ui.getCurrentState(id)).toBe('title');   // negative crossing fired
  });

  it('persistent variables save on change and seed a fresh machine before start (silently)', () => {
    const bagStore = new Map<string, string>();
    const storage = { getItem: (k: string) => bagStore.get(k) ?? null, setItem: (k: string, v: string) => { bagStore.set(k, v); } };
    const mk = (): UIStateMachine => ({
      id: 'persist-m', initialStateId: 'title',
      variables: [
        { id: 'coins', name: 'Coins', type: 'number', defaultValue: 0, persistent: true },
        { id: 'temp', name: 'Temp', type: 'number', defaultValue: 0 },
      ],
      states: [{ id: 'title', name: 'Title' }],
      transitions: [],
    });
    const a = new UIManager(mockCtx().ctx);
    a.setVariableStorage(storage);
    const idA = a.createUILayer();
    a.setStateMachine(idA, mk());
    a.setUIVariable(idA, 'coins', 42);
    a.setUIVariable(idA, 'temp', 7);                        // NOT persistent → not saved
    expect(JSON.parse(bagStore.get('salsa-ui-vars:persist-m')!)).toEqual({ coins: 42 });
    // A fresh manager (a reload) restores coins over the default; temp stays default.
    const b = new UIManager(mockCtx().ctx);
    b.setVariableStorage(storage);
    const idB = b.createUILayer();
    b.setStateMachine(idB, mk());
    expect(b.getUIVariable(idB, 'coins')).toBe(42);
    expect(b.getUIVariable(idB, 'temp')).toBe(0);
  });

  it('playSound / stopSound / setVolume actions drive the sound adapter; interactive-off silences all', () => {
    const { ctx } = mockCtx();
    const ui = new UIManager(ctx);
    const id = ui.createUILayer();
    const calls: string[] = [];
    ui.setSoundAdapter({
      play: (a, v, l) => calls.push(`play:${a}:${v}:${l}`),
      stop: (a) => calls.push(`stop:${a}`),
      setVolume: (a, v) => calls.push(`vol:${a}:${v}`),
      stopAll: () => calls.push('stopAll'),
    });
    const m = machine();
    m.states[1].onEnter = [
      { type: 'playSound', assetId: 'bgm', volume: 0.5, loop: true },
      { type: 'setVolume', assetId: 'bgm', volume: 0.2 },
      { type: 'stopSound', assetId: 'bgm' },
    ];
    ui.setStateMachine(id, m);
    ui.setInteractive(true);
    ui.goToState(id, 'game');
    expect(calls).toEqual(['play:bgm:0.5:true', 'vol:bgm:0.2', 'stop:bgm']);
    ui.setInteractive(false);
    expect(calls.at(-1)).toBe('stopAll');
  });
});
