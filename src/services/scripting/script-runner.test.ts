import { describe, it, expect, vi } from 'vitest';
import { ScriptRunner } from './script-runner';
import { ScriptCompiler } from './script-compiler';
import { ScriptBehaviorManager } from './script-behavior-manager';
import type { ScriptSceneAdapter, Vec3 } from './script-types';

/** Minimal mock scene: positions in a map, vars in a map, verbs recorded. */
function mockAdapter(initPos: Record<string, Vec3> = {}) {
  const pos = new Map<string, Vec3>(Object.entries(initPos));
  const vars = new Map<string, number | string | boolean>();
  const emit = vi.fn();
  const adapter: ScriptSceneAdapter = {
    playerId: () => 'player',
    getPos: (id) => pos.get(id) ?? null,
    setPos: (id, x, y, z) => { pos.set(id, [x, y, z]); },
    getYaw: () => 0, setYaw: () => {},
    play: vi.fn(), stop: vi.fn(),
    exists: (id) => pos.has(id),
    raycast: () => null,
    spawn: () => null, destroy: vi.fn(),
    getVar: (n) => vars.get(n) ?? null,
    setVar: (n, v) => { vars.set(n, v); },
    input: () => ({ forward: 0, right: 0, jump: false, lookYaw: 0, lookPitch: 0, interact: false }),
    emit,
    now: () => 0,
  };
  return { adapter, pos, vars, emit };
}

function setup(sources: Record<string, string>) {
  const compiler = new ScriptCompiler();
  const manager = new ScriptBehaviorManager();
  for (const [nodeId, src] of Object.entries(sources)) manager.set(nodeId, src);
  const m = mockAdapter(Object.fromEntries(Object.keys(sources).map((id) => [id, [0, 0, 0] as Vec3])));
  return { compiler, manager, ...m };
}

describe('ScriptRunner — lifecycle, per-instance state, routing, error isolation', () => {
  it('calls onStart on start() and onTick per tick, with the node bound as ctx.id', () => {
    const { compiler, manager, adapter, vars } = setup({
      n1: `export function onStart(ctx){ ctx.setVar('started:'+ctx.id, true); }
           export function onTick(ctx, dt){ ctx.move(0, 0, dt); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start();
    expect(vars.get('started:n1')).toBe(true);
    expect(r.running).toBe(true);
    r.tick(0.5); r.tick(0.5);
    // moved +1 in z over two ticks of 0.5
    expect(adapter.getPos('n1')![2]).toBeCloseTo(1);
  });

  it('a "patrol" script walks its node forward each tick', () => {
    const { compiler, manager, adapter } = setup({
      bot: `export function onStart(ctx){ this.speed = 2; }
            export function onTick(ctx, dt){ ctx.move(this.speed * dt, 0, 0); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start();
    for (let i = 0; i < 10; i++) r.tick(0.1);   // 10 * 0.1 * 2 = 2
    expect(adapter.getPos('bot')![0]).toBeCloseTo(2);
  });

  it('each node gets its own `this` state', () => {
    const src = `export function onStart(ctx){ this.n = 0; }
                 export function onTick(ctx, dt){ this.n += 1; ctx.setVar('count:'+ctx.id, this.n); }`;
    const { compiler, manager, adapter, vars } = setup({ a: src, b: src });
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start();
    r.tick(1); r.tick(1);
    r.fireInteract('a');   // unrelated hook; shouldn't touch counts
    expect(vars.get('count:a')).toBe(2);
    expect(vars.get('count:b')).toBe(2);
  });

  it('routes onTrigger / onInteract to the matching node only', () => {
    const { compiler, manager, adapter, vars } = setup({
      door: `export function onInteract(ctx){ ctx.setVar('opened', true); }
             export function onTrigger(ctx, e){ ctx.setVar('trig', e.type); }`,
      other: `export function onInteract(ctx){ ctx.setVar('otherUsed', true); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start();
    r.fireInteract('door');
    r.fireTrigger('door', { type: 'enter', id: 'door' });
    expect(vars.get('opened')).toBe(true);
    expect(vars.get('trig')).toBe('enter');
    expect(vars.get('otherUsed')).toBeUndefined();   // 'other' not interacted
  });

  it('isolates a throwing onTick — disables it after maxStrikes; others keep running', () => {
    const onError = vi.fn();
    const { compiler, manager, adapter, vars } = setup({
      bad: `export function onTick(ctx){ throw new Error('kaboom'); }`,
      good: `export function onTick(ctx){ ctx.setVar('goodRan', (ctx.getVar('goodRan')||0)+1); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter, { onError, maxStrikes: 3 });
    r.start();
    for (let i = 0; i < 5; i++) r.tick(0.016);
    // bad throws 3 times then disables (no more calls); good runs all 5 ticks
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0]).toBe('bad');
    expect(vars.get('goodRan')).toBe(5);
    expect(r.activeCount).toBe(1);   // only 'good' still live
  });

  it('surfaces a compile error via onError and skips that instance (others still run)', () => {
    const onError = vi.fn();
    const { compiler, manager, adapter, vars } = setup({
      broken: `export function onTick(ctx){ this.x = ; }`,   // syntax error
      ok: `export function onStart(ctx){ ctx.setVar('okStarted', true); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter, { onError });
    r.start();
    expect(onError).toHaveBeenCalledWith('broken', 'compile', expect.anything());
    expect(vars.get('okStarted')).toBe(true);
    expect(r.activeCount).toBe(1);
  });

  it('disabled behaviors (manager) are not instantiated', () => {
    const { compiler, manager, adapter, vars } = setup({
      on: `export function onStart(ctx){ ctx.setVar('onRan', true); }`,
      off: `export function onStart(ctx){ ctx.setVar('offRan', true); }`,
    });
    manager.setEnabled('off', false);
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start();
    expect(vars.get('onRan')).toBe(true);
    expect(vars.get('offRan')).toBeUndefined();
    expect(r.activeCount).toBe(1);
  });

  it('stop() ends the run and tick becomes a no-op', () => {
    const { compiler, manager, adapter, vars } = setup({
      n1: `export function onTick(ctx){ ctx.setVar('ticks', (ctx.getVar('ticks')||0)+1); }`,
    });
    const r = new ScriptRunner(compiler, manager, adapter);
    r.start(); r.tick(1); r.stop(); r.tick(1); r.tick(1);
    expect(vars.get('ticks')).toBe(1);
    expect(r.running).toBe(false);
  });
});
