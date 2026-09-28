import { describe, it, expect, vi } from 'vitest';
import { ScriptCompiler } from './script-compiler';
import type { ScriptContext } from './script-types';

/** A minimal ScriptContext stub — only the members the test scripts actually touch. */
function fakeCtx(over: Partial<ScriptContext> = {}): ScriptContext {
  return {
    id: 'n1', playerId: null,
    pos: () => [0, 0, 0], setPos: vi.fn(), move: vi.fn(), moveLocal: vi.fn(),
    rotateY: vi.fn(), setYaw: vi.fn(), lookAt: vi.fn(),
    play: vi.fn(), stop: vi.fn(),
    find: () => null, posOf: () => null, distanceTo: () => null, raycast: () => null,
    spawn: () => null, destroy: vi.fn(),
    getVar: () => null, setVar: vi.fn(),
    input: { forward: 0, right: 0, jump: false, lookYaw: 0, lookPitch: 0, interact: false },
    emit: vi.fn(),
    time: 0, dt: 0,
    ...over,
  };
}

describe('ScriptCompiler — TS→hooks, per-instance state, caching, error capture', () => {
  it('strips TS types and collects exported hooks', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`
      export function onStart(ctx: ScriptContext): void { ctx.setVar('started', true); }
      export function onTick(ctx: ScriptContext, dt: number): void { ctx.setVar('t', dt); }
    `);
    expect(r.ok).toBe(true);
    expect(typeof r.script?.onStart).toBe('function');
    expect(typeof r.script?.onTick).toBe('function');
    expect(r.script?.onTrigger).toBeUndefined();

    const setVar = vi.fn();
    const ctx = fakeCtx({ setVar });
    r.script!.onStart!.call({}, ctx);
    r.script!.onTick!.call({}, ctx, 0.5);
    expect(setVar).toHaveBeenCalledWith('started', true);
    expect(setVar).toHaveBeenCalledWith('t', 0.5);
  });

  it('also collects bare (non-export) function declarations', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`function onTick(ctx, dt) { ctx.setVar('ran', true); }`);
    expect(r.ok).toBe(true);
    expect(typeof r.script?.onTick).toBe('function');
  });

  it('gives each instance its own `this` state via .call(stateBag, …)', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`
      export function onStart(ctx) { this.n = 0; }
      export function onTick(ctx, dt) { this.n += dt; ctx.setVar('n', this.n); }
    `);
    const a: any = {}, b: any = {};
    const setVar = vi.fn();
    const ctx = fakeCtx({ setVar });
    r.script!.onStart!.call(a, ctx); r.script!.onStart!.call(b, ctx);
    r.script!.onTick!.call(a, ctx, 1); r.script!.onTick!.call(a, ctx, 1);   // a.n = 2
    r.script!.onTick!.call(b, ctx, 1);                                       // b.n = 1
    expect(a.n).toBe(2);
    expect(b.n).toBe(1);
  });

  it('caches by source (same text → same result object)', () => {
    const c = new ScriptCompiler();
    const src = `export function onTick(ctx){}`;
    const r1 = c.compile(src);
    const r2 = c.compile(src);
    expect(r1).toBe(r2);
    c.clearCache();
    expect(c.compile(src)).not.toBe(r1);
  });

  it('captures a transpile/syntax error (with a line number) instead of throwing', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`export function onTick(ctx) { this.x = ; }`);   // syntax error
    expect(r.ok).toBe(false);
    expect(r.script).toBeUndefined();
    expect(r.error?.message).toBeTruthy();
  });

  it('captures a top-level (module-evaluation) throw', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`throw new Error('boom at load'); export function onTick(ctx){}`);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('boom at load');
  });

  it('forbids a USED import (eager require throws at load → captured); an unused import is harmlessly stripped', () => {
    const c = new ScriptCompiler();
    const used = c.compile(`import { thing } from 'somewhere'; export function onTick(ctx){ thing(); }`);
    expect(used.ok).toBe(false);
    expect(used.error?.message).toContain('imports are not allowed');
    // sucrase drops a dead import entirely (no require emitted) → compiles fine
    const unused = c.compile(`import { thing } from 'somewhere'; export function onTick(ctx){}`);
    expect(unused.ok).toBe(true);
  });

  it('an empty / hookless script compiles ok with no hooks', () => {
    const c = new ScriptCompiler();
    const r = c.compile(`const x = 1 + 1;`);
    expect(r.ok).toBe(true);
    expect(r.script).toEqual({});
  });
});
