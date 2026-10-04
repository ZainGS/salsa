import { describe, it, expect } from 'vitest';
import { PrimList, PRIM_FLOATS, PK_GLYPH, type KitTextProvider, type KitTextSpec } from './kit-prims';
import { KIT_SCHEMA, kitDefaults, kitColor, KIT_PALETTE, kitProp } from './kit-schema';
import { layoutWidget, layoutTransition, designScale, anchorPoint, menuItemId, KIT_TRANSITION_COVER, type KitLayoutCtx } from './kit-layout';
import { introXf, clipXf, springSnap, KIT_XF_IDENTITY } from './kit-anim';
import { UIKitRuntime, pointInConvex, type KitLayerView } from './kit-runtime';
import { UI_KIT_PRESETS, personaHudDemo, personaPauseDemo } from './kit-presets';
import { UI_KIT_WGSL } from './kit-renderer';
import type { UIKitWidget, UIKitKind } from './kit-types';
import { UI_KIT_TRANSITIONS } from './kit-types';
import { UIManager } from '../../services/managers/ui-manager';
import type { ManagerContext } from '../../services/managers/manager-context';
import type { UIEvent } from '../ui-types';

/** Headless text provider: 0.55 em per char, every request gets a fake atlas entry sized to the text. */
function fakeText(): KitTextProvider & { calls: KitTextSpec[] } {
  const calls: KitTextSpec[] = [];
  return {
    calls,
    measure: (t, _f, px) => t.length * 0.55 * px,
    get: (s) => { calls.push(s); return { u0: 0, v0: 0, u1: 0.1, v1: 0.05, w: Math.ceil(s.text.length * 0.55 * s.px + 2 * (s.outline ?? 0) + 8), h: Math.ceil(s.px * 1.3) }; },
  };
}
const mkCtx = (list = new PrimList(), text = fakeText(), now = 0, interactive = false): KitLayoutCtx =>
  ({ list, text, now, interactive, ks: 1, pal: { ...KIT_PALETTE }, vars: () => undefined, hits: [], z: 0 });
const widget = (kind: UIKitKind, extra: Partial<UIKitWidget> = {}): UIKitWidget => ({ id: `w-${kind}`, kind, anchor: 'c', x: 0, y: 0, props: kitDefaults(kind), ...extra });
const allFinite = (l: PrimList) => { for (let i = 0; i < l.count * PRIM_FLOATS; i++) if (!Number.isFinite(l.data[i])) return false; return true; };

function mockCtx() {
  const ctx = {
    sceneGraph: { findNodeById: () => null },
    rasterLayerManager: { getLayers: () => [], setVisibility: () => true },
    webgpuRenderer: { setVectorLayerVisible: () => {} },
    scheduleRender: () => {},
  } as unknown as ManagerContext;
  return ctx;
}

describe('UI kit — schema + colours', () => {
  it('every kind has defaults; tokens + hex resolve', () => {
    for (const k of Object.keys(KIT_SCHEMA) as UIKitKind[]) {
      const d = kitDefaults(k);
      expect(Object.keys(d).length).toBeGreaterThan(0);
      for (const p of KIT_SCHEMA[k]) expect(d[p.key]).toBe(p.def);
    }
    expect(kitColor('primary', KIT_PALETTE)).toEqual(kitColor(KIT_PALETTE.primary, KIT_PALETTE));
    expect(kitColor('#ff000080', KIT_PALETTE)[3]).toBeCloseTo(128 / 255, 3);
    expect(kitColor('#0f0', KIT_PALETTE)).toEqual([0, 1, 0, 1]);
    // missing prop falls back to the schema default
    expect(kitProp(widget('panel', { props: {} }), 'w')).toBe(520);
  });
});

describe('UI kit — layout', () => {
  it('every kind lays out into finite prims at several canvas sizes (text through the provider)', () => {
    for (const k of Object.keys(KIT_SCHEMA) as UIKitKind[]) {
      for (const [W, H] of [[1920, 1080], [1280, 720], [3840, 2160], [900, 1600]]) {
        const L = mkCtx();
        layoutWidget(L, widget(k), W, H, { ...KIT_XF_IDENTITY }, true);
        expect(L.list.count, `${k} @${W}x${H}`).toBeGreaterThan(0);
        expect(allFinite(L.list), k).toBe(true);
      }
    }
  });

  it('places by anchor + offset in design px scaled to the canvas', () => {
    expect(designScale(1920, 1080)).toBe(1);
    expect(designScale(3840, 2160)).toBe(2);
    expect(anchorPoint('br', 100, 50)).toEqual([100, 50]);
    const L = mkCtx();
    layoutWidget(L, widget('panel', { anchor: 'tr', x: -300, y: 200, props: { ...kitDefaults('panel'), drop: false } }), 3840, 2160, { ...KIT_XF_IDENTITY }, false);
    // the single panel prim's centre: (W - 300*2, 200*2)
    expect(L.list.data[0]).toBeCloseTo(3840 - 600, 3);
    expect(L.list.data[1]).toBeCloseTo(400, 3);
  });

  it('text rasterises at the STATIC device size — an animation scale never asks for a new raster size', () => {
    const t1 = fakeText(), t2 = fakeText();
    layoutWidget(mkCtx(new PrimList(), t1), widget('heading'), 1920, 1080, { ...KIT_XF_IDENTITY }, false);
    layoutWidget(mkCtx(new PrimList(), t2), widget('heading'), 1920, 1080, { ...KIT_XF_IDENTITY, scale: 1.7 }, false);
    expect(t2.calls.map((c) => c.px)).toEqual(t1.calls.map((c) => c.px));
    // and it doubles on a 4K canvas
    const t3 = fakeText();
    layoutWidget(mkCtx(new PrimList(), t3), widget('heading'), 3840, 2160, { ...KIT_XF_IDENTITY }, false);
    expect(t3.calls[0].px).toBe(t1.calls[0].px * 2);
  });

  it('ransom letters are one tile + one glyph per letter, deterministic per seed', () => {
    const a = mkCtx(), b = mkCtx();
    const w = widget('ransom', { props: { ...kitDefaults('ransom'), text: 'ABC D' } });
    layoutWidget(a, w, 1920, 1080, { ...KIT_XF_IDENTITY }, false);
    layoutWidget(b, w, 1920, 1080, { ...KIT_XF_IDENTITY }, false);
    expect(Array.from(a.list.data.slice(0, a.list.count * PRIM_FLOATS))).toEqual(Array.from(b.list.data.slice(0, b.list.count * PRIM_FLOATS)));
    let glyphs = 0;
    for (let i = 0; i < a.list.count; i++) if (a.list.data[i * PRIM_FLOATS + 5] === PK_GLYPH) glyphs++;
    expect(glyphs).toBe(4);
  });

  it('menu registers one pointer target per item with stable ids', () => {
    const L = mkCtx();
    const w = widget('menu', { id: 'm1' });
    layoutWidget(L, w, 1920, 1080, { ...KIT_XF_IDENTITY }, false);
    expect(L.hits.map((h) => h.id)).toEqual(['m1#resume', 'm1#party', 'm1#items', 'm1#system', 'm1#quit']);
    expect(menuItemId(w, 4)).toBe('m1#quit');
    const c = L.hits[0].poly.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    expect(pointInConvex(L.hits[0].poly, c[0], c[1])).toBe(true);
    expect(pointInConvex(L.hits[0].poly, -50, -50)).toBe(false);
  });

  it('every transition draws across its progress; covering transitions cover the centre at their cover point', () => {
    for (const t of UI_KIT_TRANSITIONS) {
      for (const p of [0.05, 0.3, 0.5, 0.7, 0.95]) {
        const l = new PrimList();
        layoutTransition(l, t, p, 1920, 1080, KIT_PALETTE, 3);
        expect(allFinite(l), `${t}@${p}`).toBe(true);
      }
      const l = new PrimList();
      layoutTransition(l, t, Math.max(0.1, KIT_TRANSITION_COVER[t]), 1920, 1080, KIT_PALETTE, 3);
      expect(l.count, t).toBeGreaterThan(0);
    }
  });
});

describe('UI kit — animation curves', () => {
  it('intros start displaced / hidden and end at identity', () => {
    const s0 = introXf({ type: 'slide', dir: 'left' }, 0), s1 = introXf({ type: 'slide', dir: 'left' }, 5000);
    expect(s0.dx).toBeLessThan(-500);
    expect(s1).toEqual({ dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1 });
    expect(introXf({ type: 'pop', delayMs: 100 }, 50).alpha).toBe(0);
    expect(introXf({ type: 'punch' }, 30).scale).toBeGreaterThan(1.3);
    // the slide overshoots past its rest (the Persona "snap")
    let over = false;
    for (let t = 0; t < 420; t += 10) if (introXf({ type: 'slide', dir: 'left' }, t).dx > 1) over = true;
    expect(over).toBe(true);
    expect(springSnap(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => springSnap(i / 50)))).toBeGreaterThan(1);
    expect(clipXf('shake', 9999)).toEqual({ ...KIT_XF_IDENTITY });
  });
});

describe('UI kit — runtime', () => {
  const view = (kit: UIKitWidget[], currentState: string | null, extra: Partial<KitLayerView> = {}): KitLayerView =>
    ({ id: 'L', visible: true, kit, currentState, interactive: () => false, vars: () => undefined, ...extra });

  it('shows widgets per state, honours visibility overrides, and plays the intro on becoming visible', () => {
    const rt = new UIKitRuntime();
    rt.setClock(0);
    const a = widget('panel', { id: 'a', visibleInStates: ['hud'], intro: { type: 'pop' } });
    const b = widget('panel', { id: 'b', visibleInStates: ['pause'] });
    expect(rt.build([view([a, b], 'hud')], 1920, 1080, fakeText(), false)).toBe(true);   // a's pop is animating
    expect(rt.list.count).toBe(0);                                                         // pop starts at scale/alpha 0
    rt.setClock(2000);
    expect(rt.build([view([a, b], 'hud')], 1920, 1080, fakeText(), false)).toBe(false);
    expect(rt.list.count).toBe(2);                                                         // a: drop + panel; b hidden
    rt.setVisibleOverride('a', false);
    rt.build([view([a, b], 'hud')], 1920, 1080, fakeText(), false);
    expect(rt.list.count).toBe(0);
  });

  it('a covering transition keeps the OLD state on screen until its cover point', () => {
    const rt = new UIKitRuntime();
    rt.setClock(1000);
    const a = widget('panel', { id: 'a', visibleInStates: ['hud'] });
    const b = widget('panel', { id: 'b', visibleInStates: ['pause'], props: { ...kitDefaults('panel'), w: 99, drop: false } });
    rt.startTransition('slash', 1000, 'hud', 'pause');
    rt.setClock(1200);   // p = 0.2 < cover 0.5 → still 'hud'
    rt.build([view([a, b], 'pause')], 1920, 1080, fakeText(), true);
    expect(Array.from(rt.list.data.slice(0, rt.list.count * PRIM_FLOATS)).some((v, i) => i % PRIM_FLOATS === 2 && Math.abs(v - 99 / 2) < 3)).toBe(false);
    rt.setClock(1700);   // past the cover point → 'pause'
    rt.build([view([a, b], 'pause')], 1920, 1080, fakeText(), true);
    expect(rt.transitionProgress()).toBeCloseTo(0.7, 5);
    rt.setClock(2500);
    rt.build([view([a, b], 'pause')], 1920, 1080, fakeText(), true);
    expect(rt.transition).toBeNull();
  });
});

describe('UI kit — UIManager integration', () => {
  it('HUD + pause demos merge into one layer with kit transitions, menu ids patched in', () => {
    const ui = new UIManager(mockCtx());
    const hud = ui.insertKitDemo('hud');
    const pause = ui.insertKitDemo('pause');
    expect(pause.layerId).toBe(hud.layerId);
    const m = ui.getStateMachine(hud.layerId)!;
    expect(m.states.map((s) => s.id).sort()).toEqual(['hud', 'pause', 'splash']);
    expect(m.initialStateId).toBe('hud');
    const menu = ui.listKitWidgets(hud.layerId).find((w) => w.kind === 'menu')!;
    expect(m.transitions.find((t) => t.id === 'kit-resume')!.trigger).toEqual({ type: 'click', targetId: `${menu.id}#resume` });
    expect(ui.listKitWidgets(hud.layerId).length).toBe(personaHudDemo().widgets.length + personaPauseDemo('hud').widgets.length);
  });

  it('Escape opens the pause menu with a kit transition (no scrim fade); arrows move the menu + its variable; Enter clicks the item', () => {
    const ui = new UIManager(mockCtx());
    const { layerId } = ui.insertKitDemo('hud');
    ui.insertKitDemo('pause');
    ui.setInteractive(true);
    ui.handleKey('Escape');
    expect(ui.getCurrentState(layerId)).toBe('pause');
    expect(ui.kit.transition?.type).toBe('stripeBurst');
    expect(ui.getActiveOverlay()?.mode).toBe(0);           // the pause dim, not a scrim transition mask
    expect(ui.handleKey('ArrowDown')).toBe(true);
    expect(ui.getUIVariable(layerId, 'pauseSel')).toBe(1);
    ui.handleKey('ArrowUp'); ui.handleKey('ArrowUp');       // wraps to the last item
    expect(ui.getUIVariable(layerId, 'pauseSel')).toBe(4);
    ui.handleKey('ArrowDown');                              // back to RESUME
    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    expect(ui.handleKey('Enter')).toBe(true);
    expect(events.some((e) => e.type === 'shapeClick' && e.shapeId.endsWith('#resume'))).toBe(true);
    expect(ui.getCurrentState(layerId)).toBe('hud');
    expect(ui.kit.transition?.type).toBe('slash');
  });

  it('pointer: a click on a built menu item selects + clicks it', () => {
    const ui = new UIManager(mockCtx());
    const { layerId } = ui.insertKitDemo('pause');   // standalone: 'play' + 'pause'
    ui.setInteractive(true);
    ui.goToState(layerId, 'pause');
    ui.kit.setClock(1e7);
    ui.buildKitFrame(1920, 1080, fakeText(), 1);     // widgets become visible → intros start
    ui.kit.setClock(1e7 + 5000);                     // past every intro
    ui.buildKitFrame(1920, 1080, fakeText(), 1);
    const quit = ui.kit.hits.find((h) => h.id.endsWith('#quit'))!;
    const cx = quit.poly.reduce((a, p) => a + p[0] / 4, 0), cy = quit.poly.reduce((a, p) => a + p[1] / 4, 0);
    const events: UIEvent[] = [];
    ui.onUIEvent((e) => events.push(e));
    expect(ui.pointerMove(0, 0, cx, cy)).toBe('pointer');
    expect(ui.getUIVariable(layerId, 'pauseSel')).toBe(4);
    expect(ui.pointerDown(0, 0, cx, cy)).toBe(true);
    expect(events.some((e) => e.type === 'custom' && e.eventName === 'quit')).toBe(true);
  });

  it('playAnimation / hideShape actions on a widget id drive the kit, not the world hook', () => {
    const ui = new UIManager(mockCtx());
    const lid = ui.createUILayer('L');
    const w = ui.addKitWidget('splash', lid);
    const world: string[] = [];
    ui.setWorldControlHook({ playAnimation: (id) => world.push(id) });
    ui.setStateMachine(lid, { id: 'm', initialStateId: 's', variables: [], transitions: [
      { id: 't', fromState: 's', toState: 's', trigger: { type: 'keyDown', key: 'x' }, actions: [{ type: 'playAnimation', targetId: w.id, clipId: 'shake' }, { type: 'hideShape', shapeId: w.id }] },
    ], states: [{ id: 's', name: 'S' }] });
    ui.setInteractive(true);
    ui.handleKey('x');
    expect(world).toEqual([]);
    expect(ui.kit.visibleOverride(w.id)).toBe(false);
  });

  it('persistence: kit widgets round-trip through serialize/restore; old documents stay kit-free', () => {
    const ui = new UIManager(mockCtx());
    const { layerId } = ui.insertKitDemo('hud');
    ui.updateKitWidget(ui.listKitWidgets(layerId)[0].id, { x: 12, props: { title: 'SHIBUYA-ISH' } });
    const json = JSON.stringify(ui.serialize());
    const ui2 = new UIManager(mockCtx());
    ui2.restore(JSON.parse(json));
    expect(JSON.stringify(ui2.serialize())).toBe(json);
    expect(ui2.listKitWidgets(layerId)[0].props.title).toBe('SHIBUYA-ISH');
    // a pre-kit document: no `kit` key in, none out
    const old = new UIManager(mockCtx());
    const lid = old.createUILayer('Menu');
    old.setStateMachine(lid, { id: 'm', initialStateId: 'a', states: [{ id: 'a', name: 'A' }], transitions: [], variables: [] });
    const oldJson = JSON.stringify(old.serialize());
    const ui3 = new UIManager(mockCtx());
    ui3.restore(JSON.parse(oldJson));
    expect(JSON.stringify(ui3.serialize())).toBe(oldJson);
    expect(oldJson.includes('"kit"')).toBe(false);
    expect(ui3.hasKitContent).toBe(false);
  });

  it('every preset inserts', () => {
    const ui = new UIManager(mockCtx());
    for (const p of UI_KIT_PRESETS) expect(ui.insertKitPreset(p.id)?.kind).toBe(p.kind);
    expect(ui.listUILayers().length).toBe(1);   // the auto-created "UI Kit" layer
  });
});

describe('UI kit — WGSL hygiene', () => {
  it('no backticks, no same-scope redeclarations in the kit shader', () => {
    expect(UI_KIT_WGSL.includes('`')).toBe(false);
    const code = UI_KIT_WGSL.replace(/\/\/.*$/gm, '').replace(/for\s*\(\s*var\s+\w+/g, 'for (');   // loop vars scope to their loop
    // per brace scope: collect let/var names; a name twice in one scope is a WGSL error
    const stack: Set<string>[] = [new Set()];
    const bad: string[] = [];
    const re = /[{}]|\b(?:let|var)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      if (m[0] === '{') stack.push(new Set());
      else if (m[0] === '}') stack.pop();
      else { const s = stack[stack.length - 1]; if (s.has(m[1])) bad.push(m[1]); s.add(m[1]); }
    }
    expect(bad).toEqual([]);
  });
});
